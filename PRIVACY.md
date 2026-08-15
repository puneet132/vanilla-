# Privacy Policy — Vanilla

> **DRAFT — NOT YET REVIEWED.** This was written by reading the application
> source and describing exactly what it does today. It is accurate to the code,
> but it is not legal advice and has not been reviewed by a lawyer. Before
> publishing this, or listing the app anywhere, fill in every `[…]` placeholder
> and have someone qualified review it — particularly the sections on
> third-party recipients and recruiter data.

**Last updated:** [DATE]
**Contact:** [YOUR CONTACT EMAIL]
**Data fiduciary / controller:** [YOUR NAME OR ENTITY]

## What this app is

Vanilla lets you photograph or upload a screenshot of a job posting. It reads
the posting, checks it against your saved profile, and drafts a tailored resume
and an application email for you to review and send yourself. The app never
sends an email on your behalf.

## What we collect

**From your Google account, when you sign in**
Your Google account identifier, email address, display name, and profile photo
URL. Sign-in is handled by Google Firebase Authentication; we never see or
store your Google password.

**What you enter into your profile**
Name, location, phone number, email address, LinkedIn URL, notice period,
current salary, expected salary, relocation preference, and your full resume
content (employment history, education, projects, skills).

**Generated as you use the app**
For each application: the company and role, the recruiter's email address taken
from the posting, the date, the fit assessment, the generated resume and email
text, any follow-up drafts, and which AI provider and model produced them.

**Your AI provider API key**
Stored encrypted (AES-256-GCM) on the server. It is never returned to your
browser after saving — you only ever see a masked preview.

**Screenshots**
Held in memory for the duration of the request and sent to the AI provider you
selected. They are not written to our database and not retained after the
request completes.

## About recruiter email addresses

When the app reads a job posting, it extracts the contact email address in that
posting. That address belongs to a third party who has not interacted with this
app. It is stored in your application log so you can follow up. It is used for
no other purpose, is never shared, and is deleted when you delete your account
or that application record.

## Who your data goes to

| Recipient | What they receive | Why |
|---|---|---|
| Google (Firebase) | Authentication details and all stored profile and application data | Sign-in and database hosting |
| Vercel | Requests to the app, standard server logs | Hosting |
| The AI provider **you** choose (Anthropic, OpenAI, or Google) | The screenshot and the profile content needed to draft your application | Generating the fit check, resume, and email |

The AI provider is billed to **your own** API key. Each provider handles data
under its own terms, which you accept when you create that key. We do not sell
your data, and we do not share it for advertising.

## How long we keep it

Until you delete it. Applications can be deleted individually from the log.
Deleting your account (Profile → Delete account) permanently removes your
profile, every application and follow-up, and your encrypted provider keys.

## Your rights

- **Access** — everything held about you is visible in the app: your profile and your application log.
- **Correction** — edit your profile at any time.
- **Deletion** — Profile → *Delete my account and all my data*. This is immediate and cannot be undone.
- **Withdrawing consent** — remove your provider key, or delete your account.

For anything not covered by the in-app controls, contact [YOUR CONTACT EMAIL].

## Security

Provider API keys are encrypted at rest with AES-256-GCM, bound to the owning
account, and stored in a collection that no browser can read — only the
server can decrypt them. Your profile and applications are readable only by
your own signed-in account, enforced by database security rules. All traffic
is over HTTPS.

No system is perfectly secure, and we can't guarantee absolute security.

## Children

This app is not intended for anyone under 18.

## Changes

If this policy changes materially, the updated version will be posted here with
a new "last updated" date.

---

### Open items before publishing

- [ ] Fill in controller name, contact email, and date
- [ ] Legal review — especially recruiter (third-party) data handling
- [ ] Decide the governing jurisdiction and name it
- [ ] Publish at a stable public URL and link it from the sign-in screen
- [ ] Confirm whether Vercel/Firebase server logs retain personal data, and for how long
