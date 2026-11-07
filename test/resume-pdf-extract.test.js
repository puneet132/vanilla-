const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// Guards the production bug of Nov 2026: every PDF upload failed on Vercel
// because @napi-rs/canvas wasn't bundled, and the user only saw
// "could not read that file". This exercises the real extraction path.
const { extractText } = require("../api/profile-resume-parse.js");
const pdf = fs.readFileSync(path.join(__dirname, "fixtures", "sample-resume.pdf")).toString("base64");

test("extractText reads a real, text-based PDF resume", async () => {
  const text = await extractText(pdf, "Resume.PDF");
  assert.match(text, /Asha Verma/);
  assert.match(text, /Product Manager/);
  assert.match(text, /5,000\+ customers/);
  assert.match(text, /SQL, Figma, Jira/);
});

test("extractText can parse PDFs back to back (worker is reusable)", async () => {
  const a = await extractText(pdf, "a.pdf");
  const b = await extractText(pdf, "b.pdf");
  assert.strictEqual(a, b);
});

test("extractText rejects a corrupt PDF with an error, not a hang", async () => {
  await assert.rejects(() => extractText(Buffer.from("not a pdf").toString("base64"), "x.pdf"));
});

test("extractText explains legacy .doc and unknown types", async () => {
  await assert.rejects(() => extractText("", "old.doc"), e => /\.docx or PDF/.test(e.userMessage));
  await assert.rejects(() => extractText("", "photo.png"), e => /\.pdf or \.docx/.test(e.userMessage));
});
