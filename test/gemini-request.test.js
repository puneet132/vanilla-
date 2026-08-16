// Pins the shape of the Gemini request.
//
// This app originally called Gemini with forced function calling
// (tools + tool_config mode:"ANY"), which failed repeatedly in production with
// 5xx INTERNAL/UNAVAILABLE responses shown to users as "temporarily
// unavailable". It now uses JSON mode instead. These tests fail loudly if
// anything reintroduces the tool-calling path, the uppercased schema types, or
// a Pro-first model default.

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const { callProvider, MODEL_REGISTRY } = require("../api/_llm");

const TOOL = {
  name: "record_thing",
  description: "Record a structured thing.",
  schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      mode: { type: "string", enum: ["a", "b"] },
      items: { type: "array", items: { type: "string" } }
    },
    required: ["ok"]
  }
};

let captured;
const realFetch = global.fetch;

function stubGemini(payload, ok = true, status = 200) {
  global.fetch = async (url, init) => {
    captured = { url: String(url), init, body: JSON.parse(init.body) };
    return {
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    };
  };
}

const geminiJsonReply = obj => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }]
});

describe("Gemini request shape", () => {
  beforeEach(() => { captured = null; });
  afterEach(() => { global.fetch = realFetch; });

  test("uses JSON mode, not function calling", async () => {
    stubGemini(geminiJsonReply({ ok: true }));
    await callProvider({ provider: "gemini", model: "gemini-flash-latest", apiKey: "k", system: "sys", text: "hi", tool: TOOL });

    assert.strictEqual(captured.body.generationConfig.responseMimeType, "application/json");
    assert.ok(captured.body.generationConfig.responseSchema, "responseSchema must be sent");

    // The failure mode being guarded against.
    assert.strictEqual(captured.body.tools, undefined, "must not send tools");
    assert.strictEqual(captured.body.tool_config, undefined, "must not send tool_config");
  });

  test("leaves schema types lowercase rather than uppercasing them", async () => {
    stubGemini(geminiJsonReply({ ok: true }));
    await callProvider({ provider: "gemini", model: "gemini-flash-latest", apiKey: "k", system: "sys", text: "hi", tool: TOOL });

    const schema = captured.body.generationConfig.responseSchema;
    assert.strictEqual(schema.type, "object");
    assert.strictEqual(schema.properties.ok.type, "boolean");
    assert.strictEqual(schema.properties.items.items.type, "string");
    assert.deepStrictEqual(schema.properties.mode.enum, ["a", "b"]);
  });

  test("parses the JSON text part into an object", async () => {
    const expected = { ok: true, mode: "b", items: ["x", "y"] };
    stubGemini(geminiJsonReply(expected));
    const got = await callProvider({ provider: "gemini", model: "gemini-flash-latest", apiKey: "k", system: "s", text: "t", tool: TOOL });
    assert.deepStrictEqual(got, expected);
  });

  test("folds the tool description into the system instruction", async () => {
    stubGemini(geminiJsonReply({ ok: true }));
    await callProvider({ provider: "gemini", model: "gemini-flash-latest", apiKey: "k", system: "SYSTEM_TEXT", text: "t", tool: TOOL });
    const sys = captured.body.system_instruction.parts[0].text;
    assert.ok(sys.includes("SYSTEM_TEXT"));
    assert.ok(sys.includes(TOOL.description), "tool intent must survive the move off function calling");
  });

  test("sends an image as inlineData when one is supplied", async () => {
    stubGemini(geminiJsonReply({ ok: true }));
    await callProvider({
      provider: "gemini", model: "gemini-flash-latest", apiKey: "k", system: "s", text: "t", tool: TOOL,
      image: { mediaType: "image/jpeg", data: "BASE64" }
    });
    const parts = captured.body.contents[0].parts;
    const inline = parts.find(p => p.inlineData);
    assert.ok(inline, "image must be sent");
    assert.strictEqual(inline.inlineData.mimeType, "image/jpeg");
    assert.strictEqual(inline.inlineData.data, "BASE64");
  });

  test("surfaces a malformed JSON body as an error rather than returning junk", async () => {
    stubGemini({ candidates: [{ content: { parts: [{ text: "not json {{{" }] } }] });
    await assert.rejects(
      () => callProvider({ provider: "gemini", model: "gemini-flash-latest", apiKey: "k", system: "s", text: "t", tool: TOOL }),
      /malformed JSON/
    );
  });

  test("errors when Gemini returns no content part", async () => {
    stubGemini({ candidates: [] });
    await assert.rejects(
      () => callProvider({ provider: "gemini", model: "gemini-flash-latest", apiKey: "k", system: "s", text: "t", tool: TOOL }),
      /no structured result/
    );
  });
});

describe("Gemini model defaults", () => {
  test("defaults to a Flash model, since Pro is restricted on the free tier", () => {
    const first = MODEL_REGISTRY.gemini[0].id;
    assert.ok(/flash/i.test(first), `first Gemini model should be a Flash variant, got "${first}"`);
  });
});
