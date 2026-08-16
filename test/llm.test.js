// Tests for api/_llm.js — provider error classification and schema translation.
//
// classifyProviderError is the code that decides what a user is told when a
// provider call fails, and whether the client silently retries. Getting
// quota_exceeded vs rate_limited backwards makes the app retry forever against
// an account that will never succeed, which is exactly the failure this
// project hit in production. It is pure, so it is cheap to pin down properly.

const { test, describe } = require("node:test");
const assert = require("node:assert");

const { classifyProviderError, safeErrorDetail, MODEL_REGISTRY, PROVIDERS } = require("../api/_llm");

// Mirrors what providerError() builds internally.
const err = (status, bodyText, message) => ({ status, bodyText: bodyText || "", message: message || "" });
const google = (status, reason, message) =>
  err(400, JSON.stringify({ error: { status, message: message || "", details: reason ? [{ reason }] : [] } }));

describe("classifyProviderError — Gemini's non-standard error bodies", () => {
  test("API_KEY_INVALID is a bad key, not a bad request", () => {
    assert.strictEqual(classifyProviderError(google("INVALID_ARGUMENT", "API_KEY_INVALID")), "invalid_key");
  });

  test("PERMISSION_DENIED and UNAUTHENTICATED are bad keys", () => {
    assert.strictEqual(classifyProviderError(google("PERMISSION_DENIED")), "invalid_key");
    assert.strictEqual(classifyProviderError(google("UNAUTHENTICATED")), "invalid_key");
  });

  test("NOT_FOUND means the model is unavailable", () => {
    assert.strictEqual(classifyProviderError(google("NOT_FOUND")), "model_unavailable");
  });

  // The distinction that matters: only one of these is worth retrying.
  test("RESOURCE_EXHAUSTED mentioning quota is permanent, not transient", () => {
    assert.strictEqual(
      classifyProviderError(google("RESOURCE_EXHAUSTED", null, "Quota exceeded for requests")),
      "quota_exceeded"
    );
  });

  test("RESOURCE_EXHAUSTED without quota wording is a transient rate limit", () => {
    assert.strictEqual(
      classifyProviderError(google("RESOURCE_EXHAUSTED", null, "Too many requests, slow down")),
      "rate_limited"
    );
  });

  test("UNAVAILABLE and INTERNAL are provider-side outages", () => {
    assert.strictEqual(classifyProviderError(google("UNAVAILABLE")), "provider_down");
    assert.strictEqual(classifyProviderError(google("INTERNAL")), "provider_down");
  });

  test("a non-JSON body falls through to the HTTP status", () => {
    assert.strictEqual(classifyProviderError(err(401, "<html>gateway error</html>")), "invalid_key");
  });
});

describe("classifyProviderError — conventional HTTP statuses", () => {
  test("401 and 403 are bad keys", () => {
    assert.strictEqual(classifyProviderError(err(401, "unauthorized")), "invalid_key");
    assert.strictEqual(classifyProviderError(err(403, "forbidden")), "invalid_key");
  });

  test("404 is an unavailable model", () => {
    assert.strictEqual(classifyProviderError(err(404, "model not found")), "model_unavailable");
  });

  test("429 with insufficient_quota is permanent until billing is fixed", () => {
    assert.strictEqual(
      classifyProviderError(err(429, '{"error":{"code":"insufficient_quota"}}')),
      "quota_exceeded"
    );
  });

  test("429 mentioning billing or an exceeded plan is also permanent", () => {
    assert.strictEqual(classifyProviderError(err(429, "check your billing details")), "quota_exceeded");
    assert.strictEqual(classifyProviderError(err(429, "You exceeded your current quota")), "quota_exceeded");
  });

  test("a plain 429 is a transient rate limit worth retrying", () => {
    assert.strictEqual(classifyProviderError(err(429, "Rate limit reached for requests")), "rate_limited");
  });

  test("5xx is a provider outage", () => {
    for (const s of [500, 502, 503, 529]) {
      assert.strictEqual(classifyProviderError(err(s, "server error")), "provider_down", `status ${s}`);
    }
  });

  test("anything unrecognised classifies as unknown rather than guessing", () => {
    assert.strictEqual(classifyProviderError(err(418, "teapot")), "unknown");
    assert.strictEqual(classifyProviderError({}), "unknown");
    assert.strictEqual(classifyProviderError(null), "unknown");
  });
});

describe("safeErrorDetail", () => {
  test("caps the returned snippet at 300 characters", () => {
    assert.strictEqual(safeErrorDetail(err(500, "x".repeat(5000))).length, 300);
  });

  test("prefers the provider body, falling back to the message", () => {
    assert.strictEqual(safeErrorDetail(err(500, "body text", "message text")), "body text");
    assert.strictEqual(safeErrorDetail({ message: "message only" }), "message only");
  });

  test("never throws on empty or missing input", () => {
    assert.strictEqual(safeErrorDetail(null), "");
    assert.strictEqual(safeErrorDetail({}), "");
  });
});

describe("MODEL_REGISTRY", () => {
  // The exact provider list is asserted in fallback.test.js; here we only care
  // that PROVIDERS and MODEL_REGISTRY never drift apart, since save-provider-key
  // validates against PROVIDERS while the callers index MODEL_REGISTRY.
  test("PROVIDERS matches the registry keys", () => {
    assert.deepStrictEqual(PROVIDERS.slice().sort(), Object.keys(MODEL_REGISTRY).sort());
  });

  test("every model has a non-empty id and label", () => {
    for (const provider of PROVIDERS) {
      assert.ok(MODEL_REGISTRY[provider].length > 0, `${provider} should list at least one model`);
      for (const m of MODEL_REGISTRY[provider]) {
        assert.ok(m.id && typeof m.id === "string", `${provider} model needs an id`);
        assert.ok(m.label && typeof m.label === "string", `${provider} model ${m.id} needs a label`);
      }
    }
  });

  test("model ids are unique within a provider", () => {
    for (const provider of PROVIDERS) {
      const ids = MODEL_REGISTRY[provider].map(m => m.id);
      assert.strictEqual(new Set(ids).size, ids.length, `${provider} has duplicate model ids`);
    }
  });
});
