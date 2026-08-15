# Functional Specification Document — Vanilla

**Status:** Shipped (v1) · **Last updated:** 2026-08-15

## 1. Architecture overview

Static PWA front end (no framework — vanilla HTML/CSS/JS) talking to a
handful of Vercel serverless functions, backed by Firebase (Auth + Firestore)
for identity and data, and a user-supplied key to Anthropic, OpenAI, or
Gemini for inference. Nothing runs on a persistent server; the whole stack is
functions-on-demand plus a managed document store.

```
Browser (index.html / style.css / app.js)
   │  Firebase Auth (Google sign-in), Firestore SDK (own docs only)
   ▼
Vercel serverless functions (api/*.js)
   │  Firebase Admin SDK (service account) — verifies ID token per request
   ▼
Firestore (users/{uid}, users/{uid}/applications/{appId}, serverOnly_providerKeys/{uid}_{provider})
   │
   ▼
Provider API (Anthropic / OpenAI / Gemini) — called server-side only,
using that user's decrypted key, never the client's
```

## 2. Data model (Firestore)

```
users/{uid}
  identity            { name, location, phone, email, linkedin }
  standingAnswers      { notice_period, current_ctc, expected_ctc,
                          location, open_to_relocation }
  resume               { experience_years, domains, headline_options,
                          experience[], education[], projects[], skills[] }
  preferredProvider, preferredModel
  createdAt, updatedAt

users/{uid}/applications/{appId}
  company, role, companyRole        (lowercased "company|role" dup-check key)
  recruiterEmail, dateApplied
  fitVerdict, status                 ("drafted" | "sent" | "skipped")
  resume { ...tailored snapshot... }
  email  { subject, body }
  followUps: [{ id, date, subject, body, status }]
  provider, model, createdAt

serverOnly_providerKeys/{uid}_{provider}
  uid, provider, encryptedKey { iv, ciphertext, tag }, model, addedAt
```

`resume` is stored twice by design: once as the user's evolving master profile
(`users/{uid}.resume`) and once as an immutable snapshot per application
(`users/{uid}/applications/{appId}.resume`) — editing the master profile later
must not retroactively change what was actually sent for a past application.

## 3. API surface (`api/*.js`)

| Endpoint | Function |
|---|---|
| `save-provider-key.js` | Save / remove / check-status of a user's provider key. Validates the key against the live provider before encrypting and storing it. |
| `job-extract.js` | Vision call: job posting screenshot → structured JD JSON. |
| `job-generate.js` | JD + stored profile → fit verdict + tailored résumé + drafted email. |
| `job-followup.js` | Existing application → follow-up nudge email. |
| `job-resume-docx.js` | Tailored résumé JSON → deterministic ATS-safe `.docx` (via the `docx` package — not LLM-generated formatting, so output structure is guaranteed valid every time). |
| `_firebaseAdmin.js` | Shared: Admin SDK init + Firebase ID token verification (with revocation check). Every other endpoint calls this first. |
| `_crypto.js` | Shared: AES-256-GCM encrypt/decrypt for provider keys at rest, key material bound to the owning account via authenticated data (AAD), so a ciphertext can't be replayed under a different uid. |
| `_llm.js` | Shared: normalizes structured-output calls across Anthropic/OpenAI/Gemini into one interface; holds the curated per-provider model list (kept in sync with the client's copy in `app.js`). |

Every endpoint that touches a provider key or user data follows the same
order of operations: verify the caller's Firebase ID token server-side →
derive `uid` from the verified token (never trust a client-supplied uid) →
look up data scoped to that `uid` only.

## 4. Request flow: capture → logged application

1. Client sends the screenshot + verified ID token to `job-extract`.
2. `job-extract` verifies the token, looks up the caller's preferred
   provider/model and decrypts their key, calls the provider's vision
   endpoint, returns structured JD JSON. No data is persisted yet.
3. Client sends the JD JSON + verified token to `job-generate`.
4. `job-generate` re-verifies the token, loads `users/{uid}.resume`, calls the
   provider for a fit verdict + tailored résumé + email draft, returns all
   three to the client. Still nothing persisted — this is a preview.
5. User reviews on-screen. On explicit save, the client writes the
   application document (JD, verdict, résumé snapshot, email, status
   `"drafted"`) to `users/{uid}/applications/{appId}` directly via the
   Firestore client SDK (allowed by `firestore.rules` for the owning uid).
6. Duplicate check (`companyRole` key) runs client-side against the existing
   log and surfaces as a **non-blocking** banner — flagged, not prevented,
   because a legitimate second application to the same company/role (a
   different team, a later cycle) is a real case the app must not block.
7. `.docx` download goes through `job-resume-docx.js`; the email is sent by
   the user via a `mailto:` link, never by the server.

## 5. Security model

- **Provider keys never round-trip to the browser.** `save-provider-key.js`
  accepts a key once, validates it live against the provider, encrypts it
  (AES-256-GCM, server-only `ENCRYPTION_KEY`, AAD-bound to the owning
  account), and stores it in `serverOnly_providerKeys`, a collection
  `firestore.rules` denies to every client SDK call
  (`allow read, write: if false`). The only path in is the Admin SDK inside a
  Vercel function, authenticated with the service account. The client can
  only ask "is a key configured?" and gets a boolean plus a masked last-4.
- **Every key use is scoped to its owner** — verified server-side per
  request, not inferred from anything the client sends.
- **User data isolation** — `users/{uid}` and its `applications` subcollection
  are readable/writable only where `request.auth.uid == uid`, enforced by
  Firestore rules on every direct client read/write (most reads/writes of a
  user's own profile and application log go straight from client to
  Firestore, not through a function — the function layer exists specifically
  for the operations that need a provider key or must not trust the client).
- **A provider key only grants API usage**, billed to whoever added it —
  distinct from a ChatGPT Plus/Claude Pro/Gemini Advanced subscription, and
  scoped to that provider's API only.
- **Generic client-facing errors, detailed server logs** — upstream provider
  error bodies are logged server-side (Vercel function logs) but returned to
  the browser only as a capped, key-redacted snippet plus a classified reason
  code (see §6) — enough to self-diagnose, never enough to leak secrets.

## 6. Error handling and retry semantics

Provider failures are classified server-side into stable reason codes rather
than surfaced as one generic "something went wrong":

| Reason code | Meaning | Client behavior |
|---|---|---|
| `invalid_key` | 401/403, or Gemini's 400-with-structured-body equivalent (Gemini doesn't use HTTP status for this like the other two providers, so the classifier parses the response body shape instead) | Prompt to re-check/re-save the key. No retry. |
| `model_unavailable` | 404 | Prompt to pick a different model. No retry. |
| `rate_limited` | 429, transient wording | **Auto-retry once**, with a visible countdown, since this self-resolves. |
| `quota_exceeded` | 429, billing/insufficient-quota wording | No retry — permanent until the account's billing is fixed. Retrying a dead key forever was an actual production bug (see commit `de637c9`); the fix was distinguishing these two 429 cases rather than treating all 429s as transient. |
| `provider_down` | 5xx | No auto-retry; user can retry manually. |

Every error response includes a capped raw provider snippet (§5) so a failure
is diagnosable from the on-screen toast/status UI alone, without opening
Vercel logs.

## 7. Front-end structure

- `index.html` — all screen markup (single-page shell, sections toggled by
  JS, not a router).
- `style.css` — full visual system: "dossier" identity (warm parchment/ink
  palette, Fraunces for display type, Work Sans for body, hand-drawn line
  icons, no emoji used as UI iconography). Responsive: bottom tab bar on
  phone-width viewports, sidebar nav on tablet/desktop.
- `app.js` — auth state, capture flow, Firestore CRUD, provider/model
  selection, follow-up flow. No build step, no framework, no bundler.
- `manifest.json` / `sw.js` / `icons/` — PWA installability and offline app
  shell.

## 8. Deployment

Vercel project connected to the GitHub repo; every push to the deploy branch
redeploys automatically. Required environment variables:
`FIREBASE_SERVICE_ACCOUNT_JSON` (base64-encoded service account key),
`ENCRYPTION_KEY` (32-byte hex, generated once via `openssl rand -hex 32` —
losing it invalidates every stored provider key and every user has to
re-add theirs). No database migrations; Firestore is schemaless and the
security rules file is the only artifact that needs deploying alongside code.
