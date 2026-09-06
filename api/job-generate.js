// Text call — takes the extracted JD plus the user's profile/master-resume data.
// Runs against whichever provider/model the user picked, using their own stored key.
//
// Two modes, because tailoring a resume is now opt-in:
//   want:"apply"  (default) -> fit verdict + email draft. What every capture does.
//   want:"resume"           -> the tailored resume, only when the user asks for one.
//
// They are separate calls rather than one call whose extra field gets ignored:
// generating a full resume is the expensive part of this prompt, and most
// applications go out with the user's own master resume attached instead. Paying
// for a document nobody opens is real money on a metered key and real latency on
// a free one.
const { verifyIdToken, firestore } = require("./_firebaseAdmin");
const { decrypt } = require("./_crypto");
const { callProviderWithFallback, classifyProviderError, safeErrorDetail, PROVIDERS } = require("./_llm");
const { completeResume } = require("./_resume");

const ERROR_MESSAGES = {
  invalid_key: (p) => `Your ${p} key looks invalid, expired, or revoked — remove and re-add it in Profile → AI providers.`,
  model_unavailable: (p, m) => `"${m}" isn't available on your ${p} account yet — pick a different model in the dropdown and try again.`,
  quota_exceeded: (p) => `Your ${p} account has no usable quota or billing credits — this will keep failing no matter how many times you retry. Either add billing on ${p}'s platform, or switch to Gemini in Profile → AI providers (free, no billing required).`,
  rate_limited: (p) => `${p} rate-limited this request — wait a moment and try again.`,
  provider_down: (p, m) => `${p} is overloaded on their side right now and refused "${m}" — this is their capacity, not your key or your setup. It usually clears within a minute. If it keeps happening, pick a different model in the dropdown.`,
  unknown: () => "generation failed — the model or provider may be unavailable right now"
};

const FIT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["strong", "partial", "mismatch"] },
    reason: { type: "string" },
    gap_note: { type: "string" }
  },
  required: ["verdict", "reason"]
};

const RESUME_SCHEMA = {
        type: "object",
        properties: {
          title_line: { type: "string" },
          summary: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          bullet_sections: {
            type: "array",
            items: { type: "object", properties: { header: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["header", "bullets"] }
          },
          experience: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" }, company: { type: "string" }, location: { type: "string" }, dates: { type: "string" }, bullets: { type: "array", items: { type: "string" } } },
              required: ["title", "company", "dates", "bullets"]
            }
          },
          education: { type: "array", items: { type: "object", properties: { degree: { type: "string" }, school: { type: "string" }, dates: { type: "string" } }, required: ["degree", "school"] } },
          projects: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name", "description"] } },
          what_changed: { type: "array", items: { type: "string" } }
        },
  // Without these the model happily returns a title line, a summary and a
  // skills list and calls it a resume — which is what produced .docx
  // files that opened with no work history in them.
  required: ["title_line", "summary", "skills", "experience", "education"]
};

const EMAIL_SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" }, body: { type: "string" } },
  required: ["subject", "body"]
};

const APPLY_TOOL = {
  name: "record_application",
  description: "Record the fit assessment and email draft for this job application.",
  schema: {
    type: "object",
    properties: { fit: FIT_SCHEMA, email: EMAIL_SCHEMA },
    required: ["fit", "email"]
  }
};

const RESUME_TOOL = {
  name: "record_tailored_resume",
  description: "Record the tailored resume content for this job application.",
  schema: {
    type: "object",
    properties: { resume: RESUME_SCHEMA },
    required: ["resume"]
  }
};

const SYSTEM_BASE = `You are helping one real person apply to jobs. You will receive a structured job description (JD) and his profile/master-resume data (the only source of truth about his experience).

Non-negotiable rule: you may reorder, reframe, retitle, and rephrase — you may NEVER invent. Every claim in the tailored resume and email must trace back to something present in the profile data. If the JD wants a tool, certification, domain, or years of experience that isn't in the profile, leave it out of the resume entirely — do not imply it. If it's a real gap worth naming, put one honest line about it in fit.gap_note and let the email address it, don't hide it.`;

const SYSTEM_RESUME = SYSTEM_BASE + `

You are producing ONLY the tailored resume. There is no email and no fit verdict in this response.

The resume you return is the whole document, not a set of edits to one. Reproduce EVERY role in the profile's work history — each with its title, company, location, dates, and at least two bullets drawn from that role's achievements. Never drop a job: an omitted role reads as an unexplained employment gap. De-emphasise a less relevant role by giving it fewer, shorter bullets, not by leaving it out. Carry education across in full. "Tailoring" means choosing which of his real achievements to lead with and how to word them against this JD — it never means returning a summary and a skills list on their own.`;

const SYSTEM_APPLY = SYSTEM_BASE + `

You are producing ONLY the fit assessment and the email. Do not write a resume — the user attaches his own.

Fit assessment must be a thoughtful judgment call, not a rubber stamp:
- "mismatch" for: a required degree/qualification the profile doesn't show, an experience band the profile is well above (not just meeting or slightly under), or a role explicitly targeting a different background than the profile's.
- "partial" for a real but small/explainable gap — still worth applying, name the gap honestly.
- "strong" when the profile's domain, experience band, and core skills line up with the JD.

When verdict is "mismatch", still write the email as best you can (the client decides whether to show it if the user overrides) but make fit.reason concrete and specific.

Email tone: concise, human, on-point — not stiff, not templated-sounding. One line on what role/company and current position framing, then 3-5 bullets each mapped to a specific JD requirement with real metrics from the profile, then an optional one-line honest gap acknowledgment if fit is partial, then any explicitly-requested fields (CTC/notice period/etc.) if the JD asked and answers were provided, then a closing line mentioning the attached resume. Sign off with the name from the profile's identity field. Subject line: "Application for [Role] – [Location]" unless the JD specifies its own format — honor that format exactly when given.`;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { idToken, jd, profile, provider, model } = req.body || {};
  let uid;
  try {
    uid = (await verifyIdToken(idToken)).uid;
  } catch (e) {
    return res.status(401).json({ error: "please sign in again" });
  }
  if (!jd || !profile) return res.status(400).json({ error: "missing jd or profile" });
  if (!PROVIDERS.includes(provider) || !model) return res.status(400).json({ error: "missing or unknown provider/model" });

  let apiKey;
  try {
    const doc = await firestore().collection("serverOnly_providerKeys").doc(`${uid}_${provider}`).get();
    if (!doc.exists) return res.status(400).json({ error: `no ${provider} key configured — add one in Settings` });
    apiKey = decrypt(doc.data().encryptedKey, `${uid}_${provider}`);
  } catch (e) {
    return res.status(500).json({ error: "could not load your provider key" });
  }

  const task = mode === "resume"
    ? "Produce the tailored resume."
    : "Produce the fit assessment and email draft.";
  const text = `JOB DESCRIPTION (extracted from a screenshot):\n${JSON.stringify(jd, null, 2)}\n\nPROFILE (the only source of truth — do not add facts beyond this):\n${JSON.stringify(profile, null, 2)}\n\n${task}`;

  try {
    const { result, model: usedModel, fellBackFrom } = await callProviderWithFallback({
      provider, model, apiKey,
      system: mode === "resume" ? SYSTEM_RESUME : SYSTEM_APPLY,
      text,
      tool: mode === "resume" ? RESUME_TOOL : APPLY_TOOL
    });
    // The schema demands a full resume, but a schema is a request, not a
    // guarantee. Backfill whatever the model still left out from the master
    // profile so a blank-looking .docx can't reach the user.
    const payload = mode === "resume"
      ? { resume: completeResume(result.resume, profile) }
      : { fit: result.fit, email: result.email };
    return res.status(200).json({ ...payload, _model: usedModel, _fellBackFrom: fellBackFrom });
  } catch (err) {
    console.error("job-generate failed:", err);
    const code = classifyProviderError(err);
    return res.status(502).json({ error: ERROR_MESSAGES[code](provider, model), code, detail: safeErrorDetail(err) });
  }
};
