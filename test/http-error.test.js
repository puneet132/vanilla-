const test = require("node:test");
const assert = require("node:assert");

let he;
test.before(async () => { he = await import("../http-error.mjs"); });

test("a platform failure never degrades to four useless words", async (t) => {
  await t.test("a function timeout says it timed out and what to do", () => {
    const msg = he.apiErrorMessage(504, {});
    assert.match(msg, /too long|gave up/i);
    assert.doesNotMatch(msg, /^request failed$/i);
  });

  await t.test("an oversized body says so", () => {
    assert.match(he.apiErrorMessage(413, {}), /too large/i);
  });

  await t.test("an unrecognised status still carries the number", () => {
    assert.match(he.apiErrorMessage(418, {}), /418/);
  });

  await t.test("a non-JSON body is not mistaken for an app error", () => {
    // r.json() failed, so the caller passes {}
    const msg = he.apiErrorMessage(500, {});
    assert.match(msg, /500/);
    assert.ok(msg.length > 20, "message is too short to act on");
  });

  await t.test("no status is left describable as nothing", () => {
    assert.ok(he.apiErrorMessage(undefined, {}).length > 0);
    assert.ok(he.apiErrorMessage(null, null).length > 0);
  });
});

test("the app's own errors still win — they are more specific", async (t) => {
  await t.test("a handler's error message is used verbatim", () => {
    assert.strictEqual(
      he.apiErrorMessage(400, { error: "no gemini key configured — add one in Settings" }),
      "no gemini key configured — add one in Settings"
    );
  });

  await t.test("a provider detail is appended when present", () => {
    const msg = he.apiErrorMessage(502, { error: "generation failed", detail: "quota exhausted" });
    assert.strictEqual(msg, "generation failed (quota exhausted)");
  });

  await t.test("an app error on a 5xx is not overwritten by the generic text", () => {
    const msg = he.apiErrorMessage(502, { error: "Gemini is overloaded right now" });
    assert.strictEqual(msg, "Gemini is overloaded right now");
  });
});

test("describeHttpFailure — the raw mapping", async (t) => {
  await t.test("timeout statuses both map to the timeout message", () => {
    assert.strictEqual(he.describeHttpFailure(504), he.describeHttpFailure(408));
  });

  await t.test("a success status describes nothing", () => {
    assert.strictEqual(he.describeHttpFailure(200), null);
  });

  await t.test("rate limiting tells the user to wait", () => {
    assert.match(he.describeHttpFailure(429), /wait/i);
  });
});
