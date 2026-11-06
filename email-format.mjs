// Restores paragraph structure to an email body that came back as one line.
//
// The model is asked for real line breaks, but structured-output (JSON tool)
// responses — especially from the free models — routinely flatten the body
// into a single string: greeting, bullets and sign-off all run together, and
// that's exactly what lands in the recruiter's Gmail draft. This only touches
// bodies with NO newlines at all; anything the model already laid out is
// returned untouched, so it can't damage a well-formed email.
//
// .mjs so the browser and the node test runner both load it as an ES module
// (same reason as mime.mjs).

const GREETING = /^((?:Hi|Hello|Hey|Dear)\b[^,\n]{0,60},)\s+/i;
const SIGNOFF = /\s+((?:Best|Kind|Warm|Warmest)\s+regards|Regards|Best wishes|Best|Thanks(?: and regards| & regards)?|Thank you|Sincerely|Cheers),\s*/;
const CLOSING_LEAD = /\s+(?=(?:Please find|Please see|I(?:'ve| have) attached|Attached is|My resume is attached|Looking forward|I look forward|I would (?:love|welcome)|I'd (?:love|welcome))\b)/;
// " - Launched", " • Built", " * Led" — a list marker with spaces around it,
// followed by the start of a sentence. Hyphenated words ("0-to-1",
// "post-launch") have no spaces, so they're never split.
const BULLET = /\s+(?:-|•|\*|–)\s+(?=[A-Z0-9₹$"'(])/;

export function formatEmailBody(body) {
  if (typeof body !== "string") return body;
  const text = body.trim();
  if (!text || /\n/.test(text)) return body;

  let greeting = "";
  let rest = text;
  const g = rest.match(GREETING);
  if (g) { greeting = g[1]; rest = rest.slice(g[0].length); }

  // Peel the sign-off ("Best regards, Puneet Gupta") off the end first.
  let signoff = "";
  const signMatch = [...rest.matchAll(new RegExp(SIGNOFF.source, "g"))].pop();
  if (signMatch && rest.length - signMatch.index < 120) {
    const name = rest.slice(signMatch.index + signMatch[0].length).trim();
    signoff = `${signMatch[1]},` + (name ? `\n${name}` : "");
    rest = rest.slice(0, signMatch.index);
  }

  const paragraphs = [];
  const parts = rest.split(BULLET);
  const intro = parts.shift().trim();
  if (intro) paragraphs.push(intro);

  if (parts.length) {
    // The last bullet usually runs straight into the next paragraph
    // ("…delivery. While my background is…"): keep its first sentence as the
    // bullet and push the remainder back out as prose.
    let tail = "";
    const last = parts[parts.length - 1];
    const cut = last.search(/[.!?]\s+(?=[A-Z])/);
    if (cut !== -1) {
      parts[parts.length - 1] = last.slice(0, cut + 1);
      tail = last.slice(cut + 1).trim();
    }
    paragraphs.push(parts.map(p => `- ${p.trim()}`).join("\n"));
    if (tail) paragraphs.push(tail);
  }

  // Split a trailing "Please find my resume attached…" into its own line.
  const out = [];
  for (const p of paragraphs) {
    if (p.startsWith("- ")) { out.push(p); continue; }
    const m = p.match(CLOSING_LEAD);
    if (m && m.index > 0) out.push(p.slice(0, m.index).trim(), p.slice(m.index).trim());
    else out.push(p);
  }

  return [greeting, ...out, signoff].filter(Boolean).join("\n\n");
}
