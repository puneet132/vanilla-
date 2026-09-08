// Invokes the job-generate handler end to end with its dependencies stubbed.
//
// This file exists because nothing did. On 6 Sep the handler shipped referencing
// a variable `mode` that was never declared — an edit added the declaration and
// the use, then failed partway and wrote only the use. `require()` loads such a
// file without complaint, because a ReferenceError happens at call time, not at
// load time. Every unit test still passed, the endpoint still answered 401 to an
// unauthenticated probe (the throw is after the auth check), and the capture flow
// was dead in production for three days: an unhandled throw before the try/catch
// means Vercel returns its own 500 with no JSON body, so even the error handling
// added for exactly this had nothing to report.
//
// The lesson is narrow and worth keeping: a handler that is never called is not
// covered, however green the suite looks.

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const DEPS = ["../api/_firebaseAdmin", "../api/_crypto", "../api/_llm", "../api/_resume", "../api/job-generate"];
const saved = new Map();

function stub(relPath, exports) {
  const full = require.resolve(relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

let lastCall;

function loadHandler({ providerResult, providerError } = {}) {
  for (const d of DEPS) {
    const full = require.resolve(d);
    if (!saved.has(full)) saved.set(full, require.cache[full]);
    delete require.cache[full];
  }

  stub("../api/_firebaseAdmin", {
    verifyIdToken: async () => ({ uid: "u1" }),
    firestore: () => ({
      collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ encryptedKey: "enc" }) }) }) })
    })
  });
  stub("../api/_crypto", { decrypt: () => "fake-key" });
  stub("../api/_resume", { completeResume: (r) => r || {}, resumeIsSubstantive: () => true, masterRoleToResumeRole: (x) => x });
  stub("../api/_llm", {
    PROVIDERS: ["gemini"],
    classifyProviderError: () => "provider_down",
    safeErrorDetail: (e) => String(e && e.message || ""),
    callProviderWithFallback: async (args) => {
      lastCall = args;
      if (providerError) throw providerError;
      return { result: providerResult, model: "gemini-3.5-flash-lite", fellBackFrom: null };
    }
  });

  return require("../api/job-generate");
}

function fakeRes() {
  const out = { code: null, body: null };
  return {
    out,
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return this; },
    send(b) { out.body = b; return this; },
    setHeader() {}
  };
}

const REQ = (body) => ({ method: "POST", body });
const BASE = { idToken: "t", jd: { role_title: "BA" }, profile: { identity: { name: "P" } }, provider: "gemini", model: "gemini-3.5-flash-lite" };

const APPLY_RESULT = { fit: { verdict: "strong", reason: "ok" }, email: { subject: "s", body: "b" } };
const RESUME_RESULT = { resume: { title_line: "BA", experience: [{ title: "x", company: "y", dates: "d", bullets: ["b"] }] } };

describe("job-generate handler", () => {
  beforeEach(() => { lastCall = null; });
  afterEach(() => {
    for (const [full, mod] of saved) {
      if (mod) require.cache[full] = mod; else delete require.cache[full];
    }
    saved.clear();
  });

  test("the default capture request returns fit + email, not a 500", async () => {
    const handler = loadHandler({ providerResult: APPLY_RESULT });
    const res = fakeRes();
    await handler(REQ({ ...BASE }), res);
    assert.strictEqual(res.out.code, 200, `expected 200, got ${res.out.code}: ${JSON.stringify(res.out.body)}`);
    assert.deepStrictEqual(res.out.body.fit, APPLY_RESULT.fit);
    assert.deepStrictEqual(res.out.body.email, APPLY_RESULT.email);
  });

  test("the default request does not ask the model for a resume", async () => {
    const handler = loadHandler({ providerResult: APPLY_RESULT });
    await handler(REQ({ ...BASE }), fakeRes());
    assert.ok(!("resume" in lastCall.tool.schema.properties), "apply mode must not request a resume");
    assert.match(lastCall.text, /fit assessment and email draft/i);
  });

  test("want:\"resume\" asks for the resume and returns it", async () => {
    const handler = loadHandler({ providerResult: RESUME_RESULT });
    const res = fakeRes();
    await handler(REQ({ ...BASE, want: "resume" }), res);
    assert.strictEqual(res.out.code, 200, `expected 200, got ${res.out.code}: ${JSON.stringify(res.out.body)}`);
    assert.ok(res.out.body.resume, "resume mode must return a resume");
    assert.ok("resume" in lastCall.tool.schema.properties);
  });

  test("an unknown want falls back to apply rather than failing", async () => {
    const handler = loadHandler({ providerResult: APPLY_RESULT });
    const res = fakeRes();
    await handler(REQ({ ...BASE, want: "something-else" }), res);
    assert.strictEqual(res.out.code, 200);
    assert.ok(res.out.body.email, "an old or odd client should still get a usable reply");
  });

  test("a provider failure is answered with JSON, never an unhandled throw", async () => {
    const boom = new Error("provider exploded");
    const handler = loadHandler({ providerError: boom });
    const res = fakeRes();
    await assert.doesNotReject(() => handler(REQ({ ...BASE }), res));
    assert.strictEqual(res.out.code, 502);
    assert.ok(res.out.body.error, "the client must get an error field, not an empty body");
  });

  test("GET is rejected without touching anything else", async () => {
    const handler = loadHandler({ providerResult: APPLY_RESULT });
    const res = fakeRes();
    await handler({ method: "GET", body: {} }, res);
    assert.strictEqual(res.out.code, 405);
  });

  test("a missing jd or profile is a 400, not a crash", async () => {
    const handler = loadHandler({ providerResult: APPLY_RESULT });
    const res = fakeRes();
    await handler(REQ({ idToken: "t", provider: "gemini", model: "m" }), res);
    assert.strictEqual(res.out.code, 400);
  });
});
