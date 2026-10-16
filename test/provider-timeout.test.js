// Pins two things the October review fixed: the Anthropic request turns
// thinking off (Sonnet 5 / Opus 5 think by default, which fights the forced
// tool call and eats max_tokens), and a hung provider fails as a classifiable
// timeout inside the function's time limit instead of hanging until the
// platform kills it.

const { test, afterEach } = require("node:test");
const assert = require("node:assert");

const { callProvider, callProviderWithFallback, classifyProviderError } = require("../api/_llm");

const TOOL = { name: "t", description: "d", schema: { type: "object", properties: {} } };
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

test("Anthropic request disables thinking and leaves room for a full resume", async () => {
  let body;
  global.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", input: { ok: true } }] }) };
  };
  await callProvider({ provider: "anthropic", model: "claude-sonnet-5", apiKey: "k", system: "s", text: "x", tool: TOOL });
  assert.deepStrictEqual(body.thinking, { type: "disabled" });
  assert.ok(body.max_tokens >= 16000);
});

test("an aborted provider call surfaces as provider_down, not a hang", async () => {
  global.fetch = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" })));
  });
  const signal = AbortSignal.timeout(20);
  await assert.rejects(
    callProvider({ provider: "openai", model: "gpt-5", apiKey: "k", system: "s", text: "x", tool: TOOL, signal }),
    (err) => err.status === 504 && classifyProviderError(err) === "provider_down"
  );
});

test("the fallback chain hands every attempt an abort signal", async () => {
  const signals = [];
  global.fetch = async (_url, init) => {
    signals.push(init.signal);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: "{}" } }] } }] }) };
  };
  await callProviderWithFallback({ provider: "openai", model: "gpt-5", apiKey: "k", system: "s", text: "x", tool: TOOL });
  assert.strictEqual(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
});
