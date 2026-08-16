// Tests for callProviderWithFallback — the thing that keeps the app usable on
// free tiers. Gemini refuses busy models with 503 UNAVAILABLE; walking to the
// next model on the same key almost always succeeds, so a capacity failure
// should never reach the user as a dead end.
//
// Equally important is what must NOT fall back: an invalid key or an exhausted
// quota is account-level, and retrying it across four models just produces the
// same failure four times and burns the user's daily allowance.

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert");

const { callProviderWithFallback, MODEL_REGISTRY } = require("../api/_llm");

const TOOL = { name: "t", description: "d", schema: { type: "object", properties: { ok: { type: "boolean" } } } };
const realFetch = global.fetch;

// Drives Gemini responses per attempt. Each entry is either an HTTP status +
// body, or "ok" to return a valid JSON-mode payload.
function scriptGemini(steps) {
  const calls = [];
  let i = 0;
  global.fetch = async (url, init) => {
    const model = String(url).match(/models\/([^:]+):/)[1];
    calls.push(model);
    const step = steps[i++] ?? "ok";
    if (step === "ok") {
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), text: async () => "" };
    }
    return { ok: false, status: step.status, json: async () => step.body, text: async () => JSON.stringify(step.body) };
  };
  return calls;
}

const busy = { status: 503, body: { error: { status: "UNAVAILABLE", message: "This model is currently experiencing high demand." } } };
const badKey = { status: 400, body: { error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }], message: "API key not valid" } } };
const noQuota = { status: 429, body: { error: { message: "You exceeded your current quota" } } };

const run = (model) => callProviderWithFallback({
  provider: "gemini", model, apiKey: "k", system: "s", text: "t", tool: TOOL
});

describe("callProviderWithFallback", () => {
  afterEach(() => { global.fetch = realFetch; });

  test("returns the first model's result when it works, with no fallback flag", async () => {
    const calls = scriptGemini(["ok"]);
    const out = await run("gemini-2.5-flash-lite");
    assert.deepStrictEqual(out.result, { ok: true });
    assert.strictEqual(out.model, "gemini-2.5-flash-lite");
    assert.strictEqual(out.fellBackFrom, null);
    assert.strictEqual(calls.length, 1, "must not call extra models unnecessarily");
  });

  test("walks to the next model when the first is busy", async () => {
    const calls = scriptGemini([busy, "ok"]);
    const out = await run("gemini-2.5-flash-lite");
    assert.deepStrictEqual(out.result, { ok: true });
    assert.strictEqual(out.model, "gemini-2.5-flash");
    assert.strictEqual(out.fellBackFrom, "gemini-2.5-flash-lite", "client needs to know it switched");
    assert.deepStrictEqual(calls, ["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
  });

  test("keeps walking through several busy models", async () => {
    const calls = scriptGemini([busy, busy, "ok"]);
    const out = await run("gemini-2.5-flash-lite");
    assert.strictEqual(out.model, "gemini-3.5-flash-lite");
    assert.strictEqual(calls.length, 3);
  });

  test("gives up once the whole chain is busy, surfacing the last error", async () => {
    const calls = scriptGemini([busy, busy, busy, busy]);
    await assert.rejects(() => run("gemini-2.5-flash-lite"), /503/);
    assert.strictEqual(calls.length, MODEL_REGISTRY.gemini.length, "should try every remaining model exactly once");
  });

  test("does NOT fall back on an invalid key — that fails identically everywhere", async () => {
    const calls = scriptGemini([badKey, "ok"]);
    await assert.rejects(() => run("gemini-2.5-flash-lite"));
    assert.strictEqual(calls.length, 1, "must stop immediately on an account-level failure");
  });

  test("does NOT fall back on exhausted quota — retrying would burn the daily allowance", async () => {
    const calls = scriptGemini([noQuota, "ok"]);
    await assert.rejects(() => run("gemini-2.5-flash-lite"));
    assert.strictEqual(calls.length, 1);
  });

  test("starts from the user's chosen model, not the top of the chain", async () => {
    const calls = scriptGemini([busy, "ok"]);
    const out = await run("gemini-3.5-flash-lite");
    assert.deepStrictEqual(calls, ["gemini-3.5-flash-lite", "gemini-2.5-pro"]);
    assert.strictEqual(out.model, "gemini-2.5-pro");
  });

  test("still works for a model not present in the registry", async () => {
    scriptGemini(["ok"]);
    const out = await run("some-unlisted-model");
    assert.strictEqual(out.model, "some-unlisted-model");
  });
});

describe("provider registry", () => {
  test("exposes the two free-tier providers plus the two paid ones", () => {
    const p = Object.keys(MODEL_REGISTRY).sort();
    assert.deepStrictEqual(p, ["anthropic", "gemini", "openai", "openrouter"]);
  });

  test("every OpenRouter model is actually free", () => {
    for (const m of MODEL_REGISTRY.openrouter) {
      assert.ok(m.id.endsWith(":free"), `${m.id} must be a :free model — users are on a no-budget path`);
    }
  });

  test("Gemini no longer defaults to the always-busy -latest alias", () => {
    for (const m of MODEL_REGISTRY.gemini) {
      assert.ok(!m.id.includes("latest"), `${m.id} is an alias to the newest (most contended) model`);
    }
  });
});
