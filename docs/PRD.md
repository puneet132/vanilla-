# Product Requirements Document — Vanilla

**Status:** Shipped (v1) · **Last updated:** 2026-08-15

## 1. One-line pitch

Screenshot a job posting, get a fit check, a JD-tailored ATS-safe résumé, and
a drafted email — reviewed before anything sends, logged automatically.

## 2. Target user

Just the author, in v1 — a candidate applying to multiple roles who already
has a strong master résumé but is tired of hand-tailoring it and losing track
of what was sent where. The design assumes one profile per account, not a
recruiter or agency workflow.

## 3. Core user flow

1. **Sign in with Google** (Firebase Auth) — no separate account system.
2. **Capture** — screenshot or paste a job posting into the app.
3. **Extract** — a vision-capable LLM call turns the screenshot into a
   structured job description (company, role, requirements, JD text).
4. **Verdict** — the extracted JD is compared against the user's stored
   profile (`resume` object: experience, education, skills, projects) to
   produce a fit verdict.
5. **Generate** — a tailored résumé and a drafted outreach email are produced
   from the JD + profile.
6. **Review** — nothing leaves the app automatically. The user reviews the
   résumé and email, can download the résumé as a real `.docx`, and sends the
   email themselves via `mailto:`.
7. **Log** — the application (company, role, date, résumé snapshot, email,
   status) is written to Firestore under the user's account and appears in
   the application list, synced across devices.
8. **Follow up** — from an existing logged application, generate a follow-up
   nudge email at any later point.

## 4. Features, in the order they shipped, and why

The commit history is the sequencing record; each step below shipped only
once the previous one was proven, which is why the product never had a phase
where a large chunk of code sat unused waiting on a dependency.

| Order | Feature | Why this, not later |
|---|---|---|
| 1 | Local-only PWA: capture → extract → generate → local `.docx`, IndexedDB log | Prove the core value (a good tailored résumé beats a generic one) before touching auth, sync, or billing at all. |
| 2 | Firebase Google Auth + Firestore sync | The single biggest gap once the core loop worked: a local-only log is worthless the moment you switch devices. |
| 3 | Multi-provider AI (Anthropic/OpenAI/Gemini), per-user encrypted key | BYOK removes the hardest unsolved business problem (who pays for inference, and how do you rate-limit strangers) by construction, instead of building usage metering that a single-user tool doesn't need yet. |
| 4 | Follow-up email drafting | Once applications were logged with real dates, "it's been a week, nudge them" became a one-field lookup instead of a new subsystem. |
| 5 | Security hardening pass (see FSD §5) | Doing this before, not after, opening the repo publicly and before a second user could ever be invited in. |
| 6 | Responsive shell (sidebar / bottom tabs) + visual identity redesign | Deferred deliberately — a tool used daily by its one user doesn't need to look finished before it needs to work. Polish came after the workflow was trusted. |
| 7 | Extraction to standalone repo | Once the feature had outgrown sharing a codebase with an unrelated product (see BRD §6). |
| 8 | Error-diagnosability pass: quota vs. rate-limit classification, auto-retry with countdown, raw provider error surfaced in the UI | Triggered by a real production failure (a dead/exhausted key produced an endless "try again" loop). Fixed the actual failure mode observed, not a hypothetical one. |

## 5. What was cut, and why

- **Gmail OAuth draft creation.** The original spec called for creating a real
  Gmail draft via API. Shipped instead with `mailto:` + a `.docx` download.
  Reasoning: OAuth scopes for Gmail draft-write are sensitive, add a consent
  flow and a token-refresh surface, and buy very little over a `mailto:` link
  for a single user who is going to read the email before sending it anyway.
  Kept as an explicit deferred item (README, "What's deferred") rather than
  silently dropped, so it's a clean follow-up, not a forgotten gap.
- **Any form of auto-send.** Every generated artifact — résumé, email, verdict
  — stops at a review screen. This was never on the table to cut further; it's
  the trust boundary that makes the rest of the automation acceptable to rely
  on.
- **Multi-tenant usage limits / billing.** Not cut so much as sidestepped —
  BYOK means there's no shared quota to protect, so a whole category of
  product work (plans, metering, abuse prevention) doesn't need to exist yet.
  It becomes required only if Vanilla ever gets a second real user who doesn't
  want to bring their own key.
- **Model/provider auto-selection.** The user explicitly picks a provider and
  model per capture rather than the app choosing for them. Simpler to reason
  about and to debug (see FSD §6) than an auto-routing layer with no data yet
  to route on.

## 6. Non-functional requirements

- **Trust:** a provider key must never round-trip to the browser once saved,
  and one account must never be able to read another account's data or key.
- **Diagnosability:** a failure must be debuggable from what's on screen,
  without needing access to server logs.
- **No paid infrastructure required to run it:** Firebase free tier + Vercel
  free tier + a free-tier Gemini key is a complete, zero-cost path to a
  working instance.
- **Installable:** works as a PWA (manifest + service worker), usable
  full-screen on a phone.

## 7. Deferred / explicit non-goals for v1

- Gmail API draft creation (see §5).
- Job sourcing/recommendation.
- Team or agency multi-seat use.
- Anything past "application logged" — interview prep, offer tracking, etc.
