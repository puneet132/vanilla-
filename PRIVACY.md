# Privacy Policy — Vanilla

> This policy was written by reading the application source and describing
> exactly what it does today. It is accurate to the code. It is **not legal
> advice and has not been reviewed by a lawyer** — if this app is ever listed
> publicly or offered beyond personal use, have someone qualified review it,
> particularly the sections on third-party recipients and recruiter data.

**Last updated:** 6 September 2026
**Contact:** puneetgupta132@gmail.com
**Data fiduciary / controller:** Puneet Gupta

## What this app is

Vanilla lets you photograph or upload a screenshot of a job posting. It reads
the posting, checks it against your saved profile, and drafts a tailored resume
and an application email for you to review and send yourself. If you ask it to,
it can save that email as a **draft** in your own Gmail account. The app never
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

**Screenshots and uploaded resume files**
A job-posting screenshot, or a `.pdf`/`.docx` resume you upload to populate your
profile, is held in memory for the duration of that request and sent to the AI
provider you selected. Neither is written to our database, and neither is
retained after the request completes. Only the extracted text result is saved.

## Gmail access — only if you ask for it

Saving a draft to Gmail requires a separate Google permission prompt, shown the
first time you press **Save to Gmail drafts** — never at sign-up. The permission
requested is `gmail.compose`, the narrowest scope for the job: it can create and
update drafts, and it **cannot send mail and cannot read your existing mail**.

When you use it, the drafted email and the attached resume are transmitted to
Google's Gmail API and stored as a draft in your own mailbox, where they are
governed by your own Google account's terms. The access token is held in memory
for that browser session only, is never written to storage, and is discarded
when you sign out. You can revoke this permission at any time in your Google
account settings, and doing so does not affect the rest of the app.

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
| The AI provider **you** choose (Anthropic, OpenAI, Google, or OpenRouter) | The screenshot or uploaded resume, and the profile content needed to draft your application | Generating the fit check, resume, and email |
| Google (Gmail API) | The drafted email and attached resume — **only** if you use "Save to Gmail drafts" | Creating a draft in your own mailbox |

If you select OpenRouter, it routes your request onward to the underlying model
provider it selects, under its own terms.

The AI provider is billed to **your own** API key. Each provider handles data
under its own terms, which you accept when you create that key. We do not sell
your data, and we do not share it for advertising.

## How long we keep it

Until you delete it. Applications can be deleted individually from the log.
Deleting your account (Profile → Delete account) permanently removes your
profile, every application and follow-up, and your encrypted provider keys.

Drafts already saved into your Gmail are in **your** mailbox, not ours — deleting
your Vanilla account does not remove them. Delete those from Gmail yourself.

## Your rights

- **Access** — everything held about you is visible in the app: your profile and your application log.
- **Correction** — edit your profile at any time.
- **Deletion** — Profile → *Delete my account and all my data*. This is immediate and cannot be undone.
- **Withdrawing consent** — remove your provider key, revoke Gmail access in your Google account, or delete your account.

For anything not covered by the in-app controls, contact puneetgupta132@gmail.com.

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

### Still outstanding

- [ ] Legal review — especially recruiter (third-party) data handling and the Gmail scope
- [ ] Confirm whether Vercel/Firebase server logs retain personal data, and for how long
- [ ] If the app is ever opened beyond personal use: link this from the sign-in screen and confirm Google's API Services User Data Policy obligations for the `gmail.compose` scope
