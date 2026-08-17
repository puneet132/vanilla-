const test = require("node:test");
const assert = require("node:assert");

// mime.mjs is an ES module (the browser and Node both need to read it as one),
// so it's pulled in with a dynamic import from this CommonJS test file.
let mime;
test.before(async () => { mime = await import("../mime.mjs"); });

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function headerBlock(msg) { return msg.split("\r\n\r\n")[0]; }
function boundaryOf(msg) { return headerBlock(msg).match(/boundary="([^"]+)"/)[1]; }
function decodeB64(s) { return Buffer.from(s, "base64").toString("utf8"); }

test("encodeHeaderValue — subject lines are headers, and headers are ASCII", async (t) => {
  await t.test("a plain ASCII subject is left completely alone", () => {
    const s = "Application for Business Analyst - Puneet Gupta";
    assert.strictEqual(mime.encodeHeaderValue(s), s);
  });

  await t.test("an em dash is RFC 2047 encoded rather than sent raw", () => {
    // This is the realistic failure: the model loves em dashes, and a raw one
    // in a header renders as mojibake in Gmail.
    const out = mime.encodeHeaderValue("Application — Business Analyst");
    assert.match(out, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.strictEqual(decodeB64(out.slice(10, -2)), "Application — Business Analyst");
  });

  await t.test("non-Latin scripts survive intact", () => {
    const out = mime.encodeHeaderValue("आवेदन Business Analyst");
    assert.strictEqual(decodeB64(out.slice(10, -2)), "आवेदन Business Analyst");
  });

  await t.test("empty and missing values don't throw", () => {
    assert.strictEqual(mime.encodeHeaderValue(""), "");
    assert.strictEqual(mime.encodeHeaderValue(undefined), "");
  });
});

test("buildMimeMessage — body-only draft", async (t) => {
  const msg = mime.buildMimeMessage({
    to: "recruiter@example.com",
    subject: "Application for BA",
    body: "Hello — I'd like to apply.\r\nRegards,\r\nPuneet"
  });

  await t.test("addresses the recipient and declares UTF-8 base64", () => {
    assert.match(msg, /^To: recruiter@example\.com\r\n/);
    assert.match(msg, /Content-Type: text\/plain; charset="UTF-8"/);
    assert.match(msg, /Content-Transfer-Encoding: base64/);
  });

  await t.test("the body round-trips byte for byte, em dash included", () => {
    const encoded = msg.split("\r\n\r\n")[1];
    assert.strictEqual(decodeB64(encoded), "Hello — I'd like to apply.\r\nRegards,\r\nPuneet");
  });

  await t.test("no multipart machinery when there's nothing to attach", () => {
    assert.doesNotMatch(msg, /multipart\/mixed/);
  });
});

test("buildMimeMessage — draft with the tailored resume attached", async (t) => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f, 0x80]); // PKZip magic + edge bytes
  const msg = mime.buildMimeMessage({
    to: "recruiter@example.com",
    subject: "Application",
    body: "Please find my resume attached.",
    attachment: { filename: "Acme-resume.docx", mimeType: DOCX, bytes }
  });
  const boundary = boundaryOf(msg);

  await t.test("declares multipart/mixed with a boundary", () => {
    assert.match(headerBlock(msg), /Content-Type: multipart\/mixed; boundary="vanilla_/);
  });

  await t.test("has exactly two parts and a terminating boundary", () => {
    const opens = msg.split(`--${boundary}\r\n`).length - 1;
    assert.strictEqual(opens, 2, "expected a body part and an attachment part");
    assert.ok(msg.includes(`--${boundary}--`), "multipart message must be closed");
  });

  await t.test("the attachment is marked as a downloadable .docx", () => {
    assert.ok(msg.includes(`Content-Type: ${DOCX}; name="Acme-resume.docx"`));
    assert.ok(msg.includes('Content-Disposition: attachment; filename="Acme-resume.docx"'));
  });

  await t.test("attachment bytes survive base64 exactly — a corrupt .docx won't open", () => {
    const part = msg.split(`--${boundary}\r\n`)[2];
    const encoded = part.split("\r\n\r\n")[1].split("\r\n")[0];
    assert.deepStrictEqual(new Uint8Array(Buffer.from(encoded, "base64")), bytes);
  });

  await t.test("the boundary never collides with the content it delimits", () => {
    const body = msg.slice(headerBlock(msg).length);
    // Every occurrence of the boundary must be a real delimiter at line start.
    const stray = body.split(boundary).length - 1 - (body.split(`--${boundary}`).length - 1);
    assert.strictEqual(stray, 0);
  });
});

test("bytesToBase64 — chunking", async (t) => {
  await t.test("an attachment larger than one 32KB chunk still round-trips", () => {
    // A real .docx is comfortably past the 0x8000 chunk size, and the naive
    // String.fromCharCode(...bytes) this replaced throws on inputs this big.
    const big = new Uint8Array(150_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    const out = mime.bytesToBase64(big);
    assert.deepStrictEqual(new Uint8Array(Buffer.from(out, "base64")), big);
  });

  await t.test("an empty attachment produces an empty string, not a crash", () => {
    assert.strictEqual(mime.bytesToBase64(new Uint8Array(0)), "");
  });
});

test("toGmailRaw — what actually goes on the wire", async (t) => {
  const raw = mime.toGmailRaw(mime.buildMimeMessage({
    to: "a@b.com", subject: "Hi — there", body: "Body ✓"
  }));

  await t.test("is base64url: Gmail rejects +, / and padding", () => {
    assert.doesNotMatch(raw, /[+/=]/);
  });

  await t.test("decodes back to the exact message Gmail will store", () => {
    const back = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    assert.match(back, /^To: a@b\.com\r\n/);
    assert.match(back, /^Subject: =\?UTF-8\?B\?/m);
    assert.strictEqual(decodeB64(back.split("\r\n\r\n")[1]), "Body ✓");
  });
});
