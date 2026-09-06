const test = require("node:test");
const assert = require("node:assert");

let ge;
test.before(async () => { ge = await import("../gmail-error.mjs"); });

// The body Google actually returns when the Gmail API was never enabled on the
// project — the case the old single 403 message hid.
const SERVICE_DISABLED = JSON.stringify({
  error: {
    code: 403,
    message: "Gmail API has not been used in project 576540236184 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=576540236184 then retry.",
    status: "PERMISSION_DENIED",
    details: [{ reason: "SERVICE_DISABLED" }]
  }
});

const SCOPE_INSUFFICIENT = JSON.stringify({
  error: {
    code: 403,
    message: "Request had insufficient authentication scopes.",
    status: "PERMISSION_DENIED",
    errors: [{ reason: "insufficientPermissions", message: "Insufficient Permission" }]
  }
});

test("the two 403s that look identical get different answers", async (t) => {
  await t.test("a disabled Gmail API does not tell the user to click allow harder", () => {
    const msg = ge.gmailErrorMessage({ status: 403, detail: SERVICE_DISABLED });
    assert.match(msg, /switched on|enabl/i);
    assert.doesNotMatch(msg, /allow it when Google asks/i);
  });

  await t.test("a genuinely unscoped token still asks the user to grant access", () => {
    const msg = ge.gmailErrorMessage({ status: 403, detail: SCOPE_INSUFFICIENT });
    assert.match(msg, /allow it when Google asks/i);
  });

  await t.test("the disabled-API message points somewhere useful meanwhile", () => {
    const msg = ge.gmailErrorMessage({ status: 403, detail: SERVICE_DISABLED });
    assert.match(msg, /Mail App/i);
  });
});

test("parseGmailError — dig the reason out of whatever Google sent", async (t) => {
  await t.test("reads a reason from details[]", () => {
    assert.strictEqual(ge.parseGmailError(SERVICE_DISABLED).reason, "SERVICE_DISABLED");
  });

  await t.test("reads a reason from errors[]", () => {
    assert.strictEqual(ge.parseGmailError(SCOPE_INSUFFICIENT).reason, "insufficientPermissions");
  });

  await t.test("falls back to error.status when neither array is present", () => {
    const d = JSON.stringify({ error: { code: 403, message: "nope", status: "PERMISSION_DENIED" } });
    assert.strictEqual(ge.parseGmailError(d).reason, "PERMISSION_DENIED");
  });

  await t.test("an HTML error page does not become a wall of markup in a toast", () => {
    const html = "<html><head><title>Error 500</title></head><body>" + "x".repeat(4000) + "</body></html>";
    const out = ge.parseGmailError(html);
    assert.ok(out.message.length <= 200, "message was not capped");
  });

  await t.test("empty and non-string details are handled", () => {
    assert.deepStrictEqual(ge.parseGmailError(""), { reason: "", message: "" });
    assert.deepStrictEqual(ge.parseGmailError(null), { reason: "", message: "" });
    assert.deepStrictEqual(ge.parseGmailError(undefined), { reason: "", message: "" });
  });
});

test("everything else still says something true", async (t) => {
  await t.test("an expired token reads as expired, not as a permission problem", () => {
    assert.match(ge.gmailErrorMessage({ status: 401, detail: "" }), /expired/i);
  });

  await t.test("rate limiting says to wait", () => {
    assert.match(ge.gmailErrorMessage({ status: 429, detail: "" }), /rate-limit|moment/i);
  });

  await t.test("an unrecognised failure quotes Google rather than apologising vaguely", () => {
    const d = JSON.stringify({ error: { code: 400, message: "Invalid draft payload." } });
    assert.match(ge.gmailErrorMessage({ status: 400, detail: d }), /Invalid draft payload/);
  });

  await t.test("a totally empty error still produces a message", () => {
    assert.ok(ge.gmailErrorMessage({}).length > 0);
    assert.ok(ge.gmailErrorMessage(null).length > 0);
  });
});
