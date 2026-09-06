// Turns a failed Gmail draft call into something the user can act on.
//
// This exists because the previous message — "Gmail access wasn't granted,
// allow it when Google asks" — was shown for every 403, and a 403 arrives most
// often when the popup already succeeded. It sent people back to click harder
// at a consent screen that had worked, when the actual fault was a project
// setting only the owner can change. Google says which one it is in the error
// body; the old code captured that string and threw it away.
//
// .mjs so the browser and Node both read it as an ES module: the repo has no
// build step and package.json has no "type": "module", so a plain .js file
// would be CommonJS to Node and break the tests.

/** Pull Google's own reason + message out of an API error body. */
export function parseGmailError(detail) {
  if (typeof detail !== "string" || !detail.trim()) return { reason: "", message: "" };
  let body;
  try {
    body = JSON.parse(detail);
  } catch (e) {
    // Not JSON — an HTML error page or a proxy message. Keep it as the message
    // but don't let a wall of markup reach a toast.
    return { reason: "", message: detail.slice(0, 200).trim() };
  }
  const err = (body && body.error) || {};
  const first = Array.isArray(err.errors) && err.errors.length ? err.errors[0] : {};
  const details = Array.isArray(err.details) && err.details.length ? err.details[0] : {};
  return {
    reason: String(first.reason || details.reason || err.status || "").trim(),
    message: String(err.message || "").trim()
  };
}

/**
 * The message to show the user. Distinguishes the two failures that look
 * identical from the browser and have completely different fixes.
 */
export function gmailErrorMessage(err) {
  const status = err && err.status;
  const { reason, message } = parseGmailError(err && err.detail);

  // The project never had the Gmail API turned on. Nothing the user does in the
  // consent popup will change this — it's a console setting on the project.
  if (/SERVICE_DISABLED|accessNotConfigured/i.test(reason) || /has not been used in project|is disabled/i.test(message)) {
    return "Gmail isn't switched on for this app yet — the Gmail API needs enabling on the project. Use \"Open in Mail App\" for now.";
  }

  // A token that genuinely lacks the scope. This one IS fixed by re-consenting.
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficientScope/i.test(reason) ||
      /insufficient authentication scopes|insufficient permission/i.test(message)) {
    return "Gmail access wasn't granted — allow it when Google asks.";
  }

  if (status === 401) return "Gmail sign-in expired — try again.";
  if (status === 429) return "Google is rate-limiting drafts right now — try again in a moment.";

  // Anything else: Google's own words beat a generic apology.
  if (message) return `Gmail refused the draft: ${message}`;
  return "Couldn't save the draft to Gmail";
}
