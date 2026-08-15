# Business Requirements Document — Vanilla

**Product:** Vanilla — the job application agent
**Author:** Puneet Gupta
**Status:** Shipped (v1)
**Last updated:** 2026-08-15

## 1. Background

Applying to jobs at volume is repetitive in a way that resists shortcuts: every
posting needs the résumé re-weighted toward its specific keywords, a cover note
that isn't generic, and a record of what was sent where so follow-ups don't get
missed or duplicated. Generic writing assistants can draft text, but they don't
hold a candidate's full work history as structured ground truth, don't track
applications over time, and don't produce a file an ATS will actually parse
correctly.

This document was originally scoped as a feature inside `caloriecalculator`
(a diet/workout coach PWA) and was later split into its own product,
**Vanilla**, once it became clear the two had no user or data overlap — see
§6.

## 2. Business objective

Give one user (the author, extensible to others) a tool that turns "I found a
job posting" into "a tailored, ATS-safe résumé and a drafted email are ready
for review" in under a minute, with every application logged automatically so
follow-ups are never dropped.

This is a personal-productivity tool first, not a commercial product — there
is no monetization objective. The business case is time saved per application
and applications not lost to disorganization.

## 3. Stakeholders

| Role | Who |
|---|---|
| Product owner / sole user (v1) | Puneet Gupta |
| Builder | Puneet Gupta, with Claude Code as implementation partner |

## 4. Scope

### In scope (v1)
- Turn a screenshot of a job posting into a structured job description.
- Produce a fit verdict against the user's stored profile.
- Generate a JD-tailored, ATS-safe résumé and a drafted outreach email.
- Human review before anything is sent or downloaded — no auto-send.
- Track every application (company, role, date, résumé snapshot, email,
  follow-ups, status) per account, synced across devices.
- Let the user bring their own AI provider key (Anthropic, OpenAI, or
  Gemini) rather than the product paying for inference on their behalf.

### Out of scope (v1)
- Auto-sending email on the user's behalf (Gmail OAuth draft creation is
  deferred — see PRD §7).
- Multi-tenant billing, subscriptions, or usage limits — BYOK sidesteps this
  entirely for now.
- Sourcing or recommending jobs to apply to. The user still finds the
  posting; Vanilla starts once they screenshot it.
- Interview scheduling, offer negotiation, or anything past "email sent."

## 5. Success criteria

- A full capture → verdict → résumé/email → save cycle completes without the
  user leaving the app.
- Zero applications lost to "I forgot I applied there" — the log is the
  single source of truth.
- No provider key or generated document is ever exposed to an account other
  than the one that owns it.
- The user actually keeps using it past the first week (the real test for a
  personal tool — most personal tools die at week one).

## 6. Origin and pivot decision

Vanilla shipped its first version (`37b69aa`) as a feature living inside the
`caloriecalculator` repository, sharing its PWA shell and IndexedDB pattern.
Once Google auth, Firestore sync, and multi-provider key management were
added, the feature had its own auth model, its own data model, and its own
visual identity — nothing about it depended on the calorie calculator's code
or users. Continuing to co-locate them would have coupled two unrelated
products' deploys, dependencies, and security surfaces for no benefit.
**Decision: extract to a standalone repository (`puneet132/vanilla-`)** and
remove the feature from the original repo entirely, rather than maintain it
as a second app inside someone else's codebase.

## 7. Constraints

- Single developer, built incrementally with an AI pair-programmer — features
  landed in the order that de-risked the riskiest unknown first (see PRD §6
  for sequencing rationale).
- No dedicated backend team or budget — the entire server side runs on
  Vercel serverless functions plus Firebase, both free-tier-friendly.
- No design team — visual identity ("dossier": parchment/ink palette,
  Fraunces + Work Sans, hand-drawn line icons) was a deliberate, scoped pass,
  not an ongoing investment.
