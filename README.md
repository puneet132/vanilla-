# Vanilla

Sign in with Google, screenshot a job posting, get a fit check, a JD-tailored ATS-safe
resume, and a drafted email — reviewed before anything sends. Applications are tracked
per account (company, role, date applied, resume, email, follow-ups) and sync across
devices. Each user connects their own AI provider key (Anthropic / OpenAI / Gemini / OpenRouter) —
nothing is billed to anyone but the account that added the key.

```
index.html          screens markup
style.css            all styling
app.js                app logic: auth, capture flow, Firestore CRUD, providers, follow-ups
firebase-init.js      Firebase client config + the separate Gmail-scope provider
mime.mjs              builds the RFC-822 message the Gmail draft API expects
firestore.rules       security rules — deploy these in the Firebase console
manifest.json, sw.js, icons/   PWA install/offline shell
test/                 node --test suites (npm test) — not deployed
api/
  _firebaseAdmin.js     shared Admin SDK init + ID token verification
  _crypto.js              AES-256-GCM encrypt/decrypt for provider keys at rest
  _llm.js                  normalizes Anthropic/OpenAI/Gemini/OpenRouter structured-output
                             calls, plus model fallback and provider error classification
  _resume.js               shared resume-shape helpers used by the docx builder
  save-provider-key.js    save/remove/status for a user's encrypted provider key
  profile-resume-parse.js  uploaded .pdf/.docx → structured master-resume JSON
  job-extract.js          vision call → structured JD JSON
  job-generate.js         fit verdict + tailored resume + email draft
  job-followup.js         follow-up nudge email for an existing application
  job-resume-docx.js      deterministic ATS-safe .docx builder
  delete-account.js       erases profile, applications, and encrypted keys
```

## Setup — do this once

You'll create a free Firebase project (Google's own product — this is what makes
"Sign in with Google" nearly zero-config) and wire a few environment variables into
Vercel. None of this can be done on your behalf; it needs your Google account.

### 1. Create the Firebase project
1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → name it anything → you can skip Google Analytics.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable.** Pick a support email. Save.
3. **Build → Firestore Database → Create database → Production mode** → pick any region close to you.
4. **Firestore → Rules tab** → paste the contents of `firestore.rules` → **Publish**.

### 2. Get the web app config (safe to be public)
1. Project **⚙️ Settings → General → Your apps → Add app → Web** (the `</>` icon). Register it (no need for Firebase Hosting).
2. Copy the `firebaseConfig` object it shows you.
3. Paste those values into `firebase-init.js`, replacing the `REPLACE_WITH_...` placeholders.
4. **Authentication → Settings → Authorized domains** → add your Vercel production domain (e.g. `your-app.vercel.app`) — Google sign-in's popup will fail on a domain that isn't listed here.

### 3. Get the server-side service account (this one's a secret)
1. Project **⚙️ Settings → Service accounts → Generate new private key** → downloads a JSON file.
2. Base64-encode the whole file into one line:
   ```bash
   base64 -i path/to/serviceAccountKey.json | tr -d '\n'
   ```
3. In Vercel → your project → **Settings → Environment Variables**, add:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` = the base64 string from above
   - `ENCRYPTION_KEY` = output of `openssl rand -hex 32` (this encrypts everyone's provider keys at rest — keep it secret, losing it means saved keys can't be decrypted and everyone has to re-add theirs)
4. Redeploy so the new env vars take effect.

### 4. Try it
1. Open the deployed URL, **Sign in with Google**.
2. Go to **Profile → AI providers** → pick one and hit **Get a key →** (Gemini's free tier at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) is the easiest first key — no billing required).
3. Paste it, **Save key** — it's validated against the provider immediately, then encrypted and stored.
4. Back on Capture, screenshot a job posting.

## Deploy

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

Or connect this GitHub repo in the Vercel dashboard (**Add New → Project → Import Git
Repository**) — framework preset **Other**, leave build/output settings blank. Every
push then redeploys automatically.

## Security model

- **Provider keys never round-trip to the browser.** `save-provider-key.js` accepts a key once, validates it against the provider, encrypts it (AES-256-GCM, server-only `ENCRYPTION_KEY`, bound to the owning account via authenticated-data), and stores it in a Firestore collection (`serverOnly_providerKeys`) that `firestore.rules` denies to every client SDK call — `allow read, write: if false`. The only way in is the Admin SDK, which only runs inside Vercel's serverless functions, authenticated with the service account. The client can only ask "is a key configured?" and gets back a boolean plus a masked last-4 preview.
- **Every key use is scoped to its owner.** Each request that needs a provider key (`job-extract`, `job-generate`, `job-followup`, and the docx endpoint) verifies the caller's Firebase ID token server-side (`_firebaseAdmin.js`, with revocation checking) before touching Firestore, and looks the key up by that verified `uid` — there's no path for one account to use another's key.
- **Your data is yours.** `users/{uid}` and `users/{uid}/applications/*` are readable/writable only by `request.auth.uid == uid`, enforced by Firestore rules on every direct client read/write.
- **A provider key only grants API usage**, billed to whoever added it — it is not the same as a ChatGPT Plus/Claude Pro/Gemini Advanced subscription and can't touch anything outside that provider's API.
- Error responses returned to the browser are generic; the actual upstream error detail is only logged server-side (Vercel function logs), so provider error bodies never round-trip to the client.

## Handing off the finished application

Two routes, both ending in something you send yourself — nothing auto-sends, ever.

- **Save to Gmail drafts.** Creates a real Gmail draft with your resume attached.
  Asks for Google's `gmail.compose` scope the first time you use it — deliberately a
  second, separate consent prompt rather than an extra scope bolted onto sign-in, so
  signing in never implies mailbox access. That scope can create and update drafts; it
  cannot send mail and cannot read existing mail. The access token lives in memory for
  the session only and is dropped on sign-out.
- **Download + mailto.** Downloads the `.docx` and opens the draft in whatever mail
  client the OS has. No attachment — you attach the downloaded file yourself.

### Which resume gets attached

Your own master resume, by default — built into a `.docx` verbatim, nothing rewritten.

Tailoring is opt-in per application, behind a **Get Tailored Resume** button on the
review screen. It is a second provider call, made only when you press it: most
applications go out with your own resume, and generating a document nobody opens
costs real money on a metered key and real latency on a free one. Once generated you
can switch the attachment either way before sending.

`want:"apply"` (the default) returns the fit verdict and email; `want:"resume"` returns
the tailored resume. Two calls, two prompts — see `api/job-generate.js`.

## Testing

```bash
npm test    # node --test, no watch mode, no external services needed
```

Covers the encryption envelope, provider error classification and fallback, the Gemini
request shape, MIME assembly for Gmail drafts, resume completion, and that the generated
`.docx` is a real formatted document containing the actual work history.

## Editing the profile

Identity and standing answers have their own fields. The master resume (experience,
education, achievements, skills, projects) is the ground truth every tailored resume and
email is generated fresh from. Two ways to populate it:

- **Upload a `.pdf` or `.docx` resume.** Text is extracted server-side, then a model maps
  it into the structured shape under a strict extract-only-what-is-present rule — it never
  invents experience you didn't write.
- **Edit the JSON directly**, for corrections and fine-tuning.

"Reset to default" restores the seed data.

New accounts are walked through provider setup and profile entry by an onboarding flow,
rather than being dropped into a fit check they can't run yet.

## Model registry

`api/_llm.js` (server) and `app.js` (client) both hold a small curated list of
selectable models per provider — keep them in sync if you add/remove a model.
