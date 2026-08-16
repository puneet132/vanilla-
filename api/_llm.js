// Normalizes structured-output (tool-use) calls across Anthropic, OpenAI, and Gemini
// behind one function, so the extract/generate/followup endpoints don't each duplicate
// three providers' worth of request/response shapes.
//
// Keep MODEL_REGISTRY in sync with app.js on the client — this list only drives
// server-side... nothing, actually; the client sends whatever model id it has, this
// registry exists so other server code (if any) can validate/label it.
const MODEL_REGISTRY = {
  anthropic: [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }
  ],
  openai: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-4o", label: "GPT-4o" }
  ],
  // Flash first, deliberately. The first entry is what a newly-saved key
  // defaults to, and Pro is heavily restricted (often unavailable) on Gemini's
  // free tier — defaulting to it made the app fail out of the box for exactly
  // the users the free tier is meant to serve.
  gemini: [
    { id: "gemini-flash-latest", label: "Gemini Flash (latest)" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }
  ]
};

// NOTE: Gemini's schema types are deliberately left lowercase and passed
// through unchanged. An earlier version recursively uppercased every `type`
// value for Gemini's legacy enum dialect; the JSON REST API accepts plain
// JSON-Schema types, and the uppercasing was one of the differences between
// this code and a known-working Gemini integration.

function providerError(providerName, status, bodyText) {
  const err = new Error(`${providerName} API error (${status}): ${bodyText}`);
  err.status = status;
  err.provider = providerName;
  err.bodyText = bodyText || "";
  return err;
}

// Google's Generative Language API (Gemini) doesn't follow conventional HTTP auth/error
// semantics — e.g. an invalid key comes back as HTTP 400 with a structured body like
// {"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}},
// not 401/403. Parse that shape when present so Gemini errors classify as accurately
// as OpenAI/Anthropic's, which use plain HTTP status codes.
function parseGoogleErrorBody(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const e = parsed && parsed.error;
    if (e && typeof e.status === "string") {
      const reason = (e.details || []).map(d => d.reason).filter(Boolean).join(",");
      return { googleStatus: e.status, reason, message: e.message || "" };
    }
  } catch (_) { /* not JSON, or not Google's error shape — fall through to HTTP status */ }
  return null;
}

// Maps a thrown provider error to a stable code the client-facing endpoints turn into
// a specific, actionable message — without ever leaking the raw provider response body
// (which can contain account/billing details) back to the browser.
//
// 429 is split into two distinct cases because they need opposite advice: a transient
// rate limit is worth retrying, but "insufficient_quota"/no-billing is permanent until
// the account's billing is fixed — telling a quota-exhausted user to "wait and retry"
// just makes the same failure loop forever, which is exactly what happened here.
function classifyProviderError(err) {
  const status = err && err.status;
  const bodyText = (err && err.bodyText) || "";
  const body = bodyText.toLowerCase();

  const google = parseGoogleErrorBody(bodyText);
  if (google) {
    if (google.reason === "API_KEY_INVALID" || google.googleStatus === "PERMISSION_DENIED" || google.googleStatus === "UNAUTHENTICATED") return "invalid_key";
    if (google.googleStatus === "NOT_FOUND") return "model_unavailable";
    if (google.googleStatus === "RESOURCE_EXHAUSTED") return google.message.toLowerCase().includes("quota") ? "quota_exceeded" : "rate_limited";
    if (google.googleStatus === "UNAVAILABLE" || google.googleStatus === "INTERNAL") return "provider_down";
  }

  if (status === 401 || status === 403) return "invalid_key";
  if (status === 404) return "model_unavailable";
  if (status === 429) {
    if (body.includes("insufficient_quota") || body.includes("quota") || body.includes("billing") || body.includes("exceeded your current")) {
      return "quota_exceeded";
    }
    return "rate_limited";
  }
  if (typeof status === "number" && status >= 500) return "provider_down";
  return "unknown";
}

// Provider error bodies for these three APIs never echo back the caller's own key, so a
// capped snippet is safe to return straight to the client — meaning a failure is
// diagnosable from what the user sees on screen, without needing server log access.
function safeErrorDetail(err) {
  const raw = (err && err.bodyText) || (err && err.message) || "";
  return raw.slice(0, 300);
}

async function callAnthropic({ model, apiKey, system, text, image, tool }) {
  const content = image
    ? [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }, { type: "text", text }]
    : text;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 4000, system,
      messages: [{ role: "user", content }],
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
      tool_choice: { type: "tool", name: tool.name }
    })
  });
  if (!r.ok) throw providerError("Anthropic", r.status, await r.text());
  const data = await r.json();
  const toolUse = (data.content || []).find(b => b.type === "tool_use");
  if (!toolUse) throw new Error("Anthropic returned no structured result");
  return toolUse.input;
}

async function callOpenAI({ model, apiKey, system, text, image, tool }) {
  const userContent = image
    ? [{ type: "text", text }, { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } }]
    : text;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: userContent }],
      tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
      tool_choice: { type: "function", function: { name: tool.name } }
    })
  });
  if (!r.ok) throw providerError("OpenAI", r.status, await r.text());
  const data = await r.json();
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error("OpenAI returned no structured result");
  return JSON.parse(call.function.arguments);
}

// Gemini uses JSON mode (responseMimeType + responseSchema) rather than the
// forced function calling used for Anthropic and OpenAI.
//
// The tool-calling path (tools + tool_config mode:"ANY") was what this app
// originally sent, and it failed repeatedly in production with 5xx
// INTERNAL/UNAVAILABLE responses that surfaced to users as "temporarily
// unavailable". Forced function calling is markedly more fragile on Gemini
// than JSON mode; a separate, known-working Gemini integration by the same
// author used JSON mode and had none of these failures. Same structured
// result, far more reliable path.
async function callGemini({ model, apiKey, system, text, image, tool }) {
  const parts = image ? [{ text }, { inlineData: { mimeType: image.mediaType, data: image.data } }] : [{ text }];
  // The tool description carries intent the schema alone doesn't express, so
  // it moves into the system instruction now that there's no tool declaration.
  const systemText = tool && tool.description ? `${system}\n\n${tool.description}` : system;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: tool.schema
      }
    })
  });
  if (!r.ok) throw providerError("Gemini", r.status, await r.text());
  const data = await r.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("Gemini returned no structured result");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("Gemini returned malformed JSON");
  }
}

// tool: { name, description, schema } — schema is a plain JSON-schema object shared
// across all three providers (converted to Gemini's uppercase-type dialect internally).
async function callProvider({ provider, model, apiKey, system, text, image, tool }) {
  if (provider === "anthropic") return callAnthropic({ model, apiKey, system, text, image, tool });
  if (provider === "openai") return callOpenAI({ model, apiKey, system, text, image, tool });
  if (provider === "gemini") return callGemini({ model, apiKey, system, text, image, tool });
  throw new Error(`unknown provider: ${provider}`);
}

module.exports = { callProvider, classifyProviderError, safeErrorDetail, MODEL_REGISTRY, PROVIDERS: Object.keys(MODEL_REGISTRY) };
