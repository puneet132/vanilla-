// RFC 2822 message construction for the Gmail drafts feature.
//
// Split out of app.js and kept dependency-free for one reason: this is encoding
// code, and encoding code fails silently. A wrong base64 boundary or an
// un-encoded header doesn't throw — it produces a draft with a mangled subject
// or a corrupt attachment, which the user only discovers after sending it to a
// recruiter. Isolated here, it runs under `npm test` in Node.
//
// .mjs so the browser and Node both read it as an ES module: the repo has no
// build step and package.json has no "type": "module", so a plain .js file
// would be CommonJS to Node and break the tests.

// btoa() operates on latin-1, so any non-ASCII character throws. Encode to
// UTF-8 bytes first, then chunk — spreading a large byte array into
// String.fromCharCode blows the argument limit on attachment-sized inputs.
export function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function utf8ToBase64(str) {
  return bytesToBase64(new TextEncoder().encode(str));
}

export function base64Url(b64) {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Subject lines are a header, and headers are ASCII. Anything else has to be
// RFC 2047 encoded or Gmail shows mojibake.
export function encodeHeaderValue(value) {
  return /^[\x20-\x7E]*$/.test(value || "") ? (value || "") : `=?UTF-8?B?${utf8ToBase64(value)}?=`;
}

// Both parts are base64 so a long body can't be mangled by line-length limits
// and an em dash can't corrupt the message.
export function buildMimeMessage({ to, subject, body, attachment }) {
  const headerSubject = encodeHeaderValue(subject || "");
  if (!attachment) {
    return [
      `To: ${to}`,
      `Subject: ${headerSubject}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      utf8ToBase64(body || "")
    ].join("\r\n");
  }

  const boundary = `vanilla_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return [
    `To: ${to}`,
    `Subject: ${headerSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    utf8ToBase64(body || ""),
    "",
    `--${boundary}`,
    `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    bytesToBase64(attachment.bytes),
    "",
    `--${boundary}--`,
    ""
  ].join("\r\n");
}

// What actually goes on the wire to Gmail: the whole message, base64url encoded.
export function toGmailRaw(message) {
  return base64Url(bytesToBase64(new TextEncoder().encode(message)));
}
