// Turns an uploaded .pdf or .docx resume into the structured profile the app
// generates from, so a user doesn't have to hand-write JSON to get started.
//
// Two stages, deliberately separated:
//   1. Deterministic text extraction (mammoth / pdf-parse). No model involved,
//      so a parsing failure is a parsing failure and not a hallucination.
//   2. One model call that only *restructures* that text.
//
// The non-invention rule matters more here than anywhere else in the app: this
// output becomes the ground truth every tailored resume and email is built
// from. A fabricated employer or invented metric here would silently propagate
// into every job application the user sends.
const { verifyIdToken, firestore } = require("./_firebaseAdmin");
const { decrypt } = require("./_crypto");
const { callProviderWithFallback, classifyProviderError, safeErrorDetail, PROVIDERS } = require("./_llm");

// Vercel caps request bodies around 4.5 MB and base64 inflates by ~33%, so
// reject early with a clear message rather than letting the platform truncate.
const MAX_BASE64_CHARS = 4_000_000;

const ERROR_MESSAGES = {
  invalid_key: (p) => `Your ${p} key looks invalid or expired — re-add it in Profile → AI providers.`,
  model_unavailable: (p, m) => `"${m}" isn't available on your ${p} account — pick another model.`,
  quota_exceeded: (p) => `Your ${p} account has no usable quota left — this will keep failing until that's resolved.`,
  rate_limited: (p) => `${p} rate-limited this request — wait a moment and try again.`,
  provider_down: (p) => `${p} is overloaded right now — try again shortly.`,
  unknown: () => "could not read that resume — try again, or paste the details manually"
};

const RESUME_TOOL = {
  name: "record_resume",
  description: "Record the contents of a resume, using only what is explicitly written in it.",
  schema: {
    type: "object",
    properties: {
      identity: {
        type: "object",
        properties: {
          name: { type: "string" },
          location: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          linkedin: { type: "string" }
        }
      },
      resume: {
        type: "object",
        properties: {
          experience_years: { type: "number", description: "total years of professional experience; 0 if not stated or inferable from dates" },
          domains: { type: "array", items: { type: "string" }, description: "industries/domains actually worked in" },
          headline_options: { type: "array", items: { type: "string" }, description: "job titles this person has actually held" },
          experience: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                company: { type: "string" },
                location: { type: "string" },
                dates: { type: "string" },
                achievements: { type: "array", items: { type: "string" } }
              },
              required: ["title", "company", "achievements"]
            }
          },
          education: {
            type: "array",
            items: {
              type: "object",
              properties: { degree: { type: "string" }, school: { type: "string" }, dates: { type: "string" } },
              required: ["degree", "school"]
            }
          },
          projects: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, description: { type: "string" } },
              required: ["name"]
            }
          },
          skills: { type: "array", items: { type: "string" } }
        },
        required: ["experience", "education", "skills"]
      }
    },
    required: ["identity", "resume"]
  }
};

const SYSTEM = [
  "You convert the raw text of a resume into structured data.",
  "",
  "Copy only what is explicitly written in the document. Never invent, embellish, infer, or round a number, date, employer, metric, or skill that is not literally present.",
  "If a field is not in the document, return an empty string or empty array for it — do not guess.",
  "Keep achievement bullets in the candidate's own wording; do not rewrite, summarise, or improve them.",
  "Only set experience_years when it is stated outright or unambiguously derivable from employment dates; otherwise return 0."
].join("\n");

async function extractText(base64, filename) {
  const buf = Buffer.from(base64, "base64");
  const name = String(filename || "").toLowerCase();

  if (name.endsWith(".docx")) {
    const mammoth = require("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }

  if (name.endsWith(".pdf")) {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const { text } = await parser.getText();
      // pdf-parse injects "-- 3 of 12 --" separators between pages; they are
      // noise to the model and can read as resume content.
      return String(text || "").replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, "");
    } finally {
      // Releases the worker; without this the function can hang until timeout.
      await parser.destroy().catch(() => {});
    }
  }

  if (name.endsWith(".doc")) {
    const err = new Error("legacy .doc is not supported");
    err.userMessage = "Old .doc files aren't supported — re-save it as .docx or PDF and upload again.";
    throw err;
  }

  const err = new Error("unsupported file type");
  err.userMessage = "Upload a .pdf or .docx file.";
  throw err;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { idToken, file, filename, provider, model } = req.body || {};

  let uid;
  try {
    uid = (await verifyIdToken(idToken)).uid;
  } catch (e) {
    return res.status(401).json({ error: "please sign in again" });
  }

  if (!file) return res.status(400).json({ error: "no file received" });
  if (file.length > MAX_BASE64_CHARS) {
    return res.status(413).json({ error: "That file is too large — please upload a resume under about 3 MB." });
  }
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: "unknown provider" });

  let text;
  try {
    text = await extractText(file, filename);
  } catch (e) {
    return res.status(400).json({ error: e.userMessage || "could not read that file" });
  }

  // A scanned/image-only PDF extracts to nothing. Say so plainly instead of
  // sending an empty document to the model and getting an empty profile back.
  if (!text || text.trim().length < 50) {
    return res.status(422).json({
      error: "No text could be read from that file. If it's a scanned image, export a text-based PDF from Word or Google Docs and try again."
    });
  }

  let apiKey;
  try {
    const doc = await firestore().collection("serverOnly_providerKeys").doc(`${uid}_${provider}`).get();
    if (!doc.exists) return res.status(400).json({ error: `no ${provider} key configured` });
    apiKey = decrypt(doc.data().encryptedKey, `${uid}_${provider}`);
  } catch (e) {
    return res.status(500).json({ error: "could not load your provider key" });
  }

  try {
    const { result } = await callProviderWithFallback({
      provider, model, apiKey,
      system: SYSTEM,
      // Truncated so an unusually long CV can't blow the context window.
      text: `Resume text:\n\n${text.slice(0, 40000)}`,
      tool: RESUME_TOOL
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error("profile-resume-parse failed:", err);
    const code = classifyProviderError(err);
    return res.status(502).json({ error: ERROR_MESSAGES[code](provider, model), code, detail: safeErrorDetail(err) });
  }
};
