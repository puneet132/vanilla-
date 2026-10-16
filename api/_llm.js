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
  // Order is the free-tier fallback chain, cheapest and least-contended first.
  //
  // "gemini-flash-latest" is deliberately NOT here. It is an alias that always
  // resolves to Google's newest Flash model, which is by definition the most
  // in-demand thing on the platform — it returned 503 UNAVAILABLE ("this model
  // is currently experiencing high demand") over and over. Pinned older models
  // are mature, far less contended, and entirely good enough for this task.
  // gemini-2.5-flash-lite was removed on 8 Sep 2026: Google retired it and now
  // answers it with 404 "no longer available to new users. Please update your
  // code to use models/gemini-3.5-flash-lite". Nothing broke, because
  // callProviderWithFallback advances on model_unavailable — but it was the
  // FIRST entry, so every single request paid a wasted round-trip to a dead
  // model before doing any real work, and that latency pushes the serverless
  // function towards its time limit. A dead default is not a free default.
  // gemini-2.5-flash and gemini-2.5-pro go the same way on 20 Oct 2026, so they
  // were swapped for current 3.x models before they started 404ing.
  gemini: [
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite (most reliable free)" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" }
  ],
  // OpenRouter exists so one provider's capacity problem cannot take the whole
  // product down. Every model here is free (":free" suffix), vision-capable
  // (the screenshot step needs it), and supports tool calling — verified
  // against OpenRouter's public model API rather than assumed.
  openrouter: [
    { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (free)" },
    { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (free)" },
    { id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super VL (free)" }
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

// Each attempt gets an abort signal from callProviderWithFallback, so a slow
// model fails inside the function's 60s limit with a classifiable error instead
// of the platform killing the request and returning a bare 504 page.
async function timedFetch(providerName, url, init, signal) {
  try {
    return await fetch(url, signal ? { ...init, signal } : init);
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw providerError(providerName, 504, "timed out waiting for the model");
    }
    throw e;
  }
}

async function callAnthropic({ model, apiKey, system, text, image, tool, signal }) {
  const content = image
    ? [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }, { type: "text", text }]
    : text;
  const r = await timedFetch("Anthropic", "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      // Sonnet 5 and Opus 5 think by default. Thinking doesn't mix with a
      // forced tool_choice and its tokens count against max_tokens, so a full
      // resume could run out before the tool call. All three listed models
      // accept "disabled"; Opus 5.5 / Sonnet 5.5 do NOT (and reject forced
      // tool_choice too), so adding them needs a different request shape.
      model, max_tokens: 16000, system,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content }],
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
      tool_choice: { type: "tool", name: tool.name }
    })
  }, signal);
  if (!r.ok) throw providerError("Anthropic", r.status, await r.text());
  const data = await r.json();
  const toolUse = (data.content || []).find(b => b.type === "tool_use");
  if (!toolUse) throw new Error("Anthropic returned no structured result");
  return toolUse.input;
}

async function callOpenAI({ model, apiKey, system, text, image, tool, signal }) {
  const userContent = image
    ? [{ type: "text", text }, { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } }]
    : text;
  const r = await timedFetch("OpenAI", "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: userContent }],
      tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
      tool_choice: { type: "function", function: { name: tool.name } }
    })
  }, signal);
  if (!r.ok) throw providerError("OpenAI", r.status, await r.text());
  const data = await r.json();
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error("OpenAI returned no structured result");
  try {
    return JSON.parse(call.function.arguments);
  } catch (e) {
    throw new Error("OpenAI returned malformed JSON");
  }
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
async function callGemini({ model, apiKey, system, text, image, tool, signal }) {
  const parts = image ? [{ text }, { inlineData: { mimeType: image.mediaType, data: image.data } }] : [{ text }];
  // The tool description carries intent the schema alone doesn't express, so
  // it moves into the system instruction now that there's no tool declaration.
  const systemText = tool && tool.description ? `${system}\n\n${tool.description}` : system;
  const r = await timedFetch("Gemini", `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
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
  }, signal);
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

// OpenRouter speaks the OpenAI wire format, so this mirrors callOpenAI. Tool
// calling is used rather than response_format because every free model on the
// list supports tools, while structured-output support varies model to model —
// tools are the only mechanism that works across all of them.
async function callOpenRouter({ model, apiKey, system, text, image, tool, signal }) {
  const userContent = image
    ? [{ type: "text", text }, { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } }]
    : text;
  const r = await timedFetch("OpenRouter", "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      // OpenRouter attributes traffic with these; they are not credentials.
      "HTTP-Referer": "https://vanilla-brown.vercel.app",
      "X-Title": "Vanilla"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: userContent }],
      tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
      tool_choice: { type: "function", function: { name: tool.name } }
    })
  }, signal);
  if (!r.ok) throw providerError("OpenRouter", r.status, await r.text());
  const data = await r.json();
  // OpenRouter surfaces upstream failures as a 200 with an error body.
  if (data.error) throw providerError("OpenRouter", data.error.code || 502, JSON.stringify(data.error));
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error("OpenRouter returned no structured result");
  try {
    return JSON.parse(call.function.arguments);
  } catch (e) {
    throw new Error("OpenRouter returned malformed JSON");
  }
}

// tool: { name, description, schema } — a plain JSON-schema object shared across
// every provider.
async function callProvider({ provider, model, apiKey, system, text, image, tool, signal }) {
  if (provider === "anthropic") return callAnthropic({ model, apiKey, system, text, image, tool, signal });
  if (provider === "openai") return callOpenAI({ model, apiKey, system, text, image, tool, signal });
  if (provider === "gemini") return callGemini({ model, apiKey, system, text, image, tool, signal });
  if (provider === "openrouter") return callOpenRouter({ model, apiKey, system, text, image, tool, signal });
  throw new Error(`unknown provider: ${provider}`);
}

// Capacity failures are model-specific, not account-specific: when Google says a
// model is "experiencing high demand", a different model on the same key
// usually answers fine. So on provider_down (and model_unavailable) walk the
// rest of that provider's list rather than surfacing a dead end.
//
// Only those two codes fall through. invalid_key and quota_exceeded are
// account-level — trying another model just repeats the same failure N times.
const PROVIDER_BUDGET_MS = 50000;
const MIN_ATTEMPT_MS = 8000;

async function callProviderWithFallback(args) {
  const chain = MODEL_REGISTRY[args.provider] || [];
  const start = chain.findIndex(m => m.id === args.model);
  // Try the requested model first, then everything after it in the chain.
  const order = [args.model, ...chain.slice(start + 1).map(m => m.id)]
    .filter((id, i, a) => id && a.indexOf(id) === i);

  // vercel.json caps functions at 60s. The whole chain shares one budget under
  // that, so a slow first model can't push the fallbacks past the platform kill.
  const deadline = Date.now() + PROVIDER_BUDGET_MS;
  let lastErr;
  for (const model of order) {
    const remaining = deadline - Date.now();
    if (lastErr && remaining < MIN_ATTEMPT_MS) break;
    try {
      const signal = AbortSignal.timeout(Math.max(remaining, MIN_ATTEMPT_MS));
      const result = await callProvider({ ...args, model, signal });
      return { result, model, fellBackFrom: model === args.model ? null : args.model };
    } catch (err) {
      lastErr = err;
      const code = classifyProviderError(err);
      if (code !== "provider_down" && code !== "model_unavailable") throw err;
    }
  }
  throw lastErr;
}

module.exports = {
  callProvider,
  callProviderWithFallback,
  classifyProviderError,
  safeErrorDetail,
  MODEL_REGISTRY,
  PROVIDERS: Object.keys(MODEL_REGISTRY)
};
