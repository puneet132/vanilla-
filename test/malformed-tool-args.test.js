// Every provider path has to fail the same way when the model returns tool
// arguments that aren't valid JSON.
//
// Gemini already did — it wraps its parse and throws "Gemini returned malformed
// JSON". OpenAI and OpenRouter let a raw SyntaxError escape instead, and
// safeErrorDetail puts whatever it says in front of the user, so a bad model
// response surfaced as "generation failed … (Unexpected token } in JSON at
// position 42)".

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const { callProvider } = require("../api/_llm");

const TOOL = {
  name: "record_thing",
  description: "Record a structured thing.",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
};

const realFetch = global.fetch;

// Both speak the OpenAI wire format: the tool arguments arrive as a JSON string.
function stubToolArgs(argumentsString) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { tool_calls: [{ function: { name: "record_thing", arguments: argumentsString } }] } }]
    }),
    text: async () => ""
  });
}

describe("malformed tool arguments", () => {
  afterEach(() => { global.fetch = realFetch; });

  for (const [provider, label] of [["openai", "OpenAI"], ["openrouter", "OpenRouter"]]) {
    test(`${label} reports malformed JSON in its own words`, async () => {
      stubToolArgs('{"ok": true,,,}');
      await assert.rejects(
        () => callProvider({ provider, model: "x", apiKey: "k", system: "s", text: "t", tool: TOOL }),
        (err) => {
          assert.match(err.message, new RegExp(`${label} returned malformed JSON`));
          return true;
        }
      );
    });

    test(`${label} does not leak the raw parser error to the caller`, async () => {
      stubToolArgs("not json at all {{{");
      await assert.rejects(
        () => callProvider({ provider, model: "x", apiKey: "k", system: "s", text: "t", tool: TOOL }),
        (err) => {
          assert.doesNotMatch(err.message, /Unexpected token|position \d+|JSON\.parse/i,
            "a raw SyntaxError reached the caller, and safeErrorDetail shows that to the user");
          return true;
        }
      );
    });

    test(`${label} still returns well-formed arguments untouched`, async () => {
      stubToolArgs('{"ok": true}');
      const out = await callProvider({ provider, model: "x", apiKey: "k", system: "s", text: "t", tool: TOOL });
      assert.deepStrictEqual(out, { ok: true });
    });
  }

  test("a missing tool call is still its own distinct error", async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: {} }] }), text: async () => "" });
    await assert.rejects(
      () => callProvider({ provider: "openai", model: "x", apiKey: "k", system: "s", text: "t", tool: TOOL }),
      /no structured result/
    );
  });
});
