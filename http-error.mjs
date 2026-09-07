// What to say when the API replied but not with one of this app's own errors.
//
// Every handler in api/ returns { error: "..." } on failure, so a non-OK
// response carrying no error field did not come from this app's code at all —
// it came from the platform underneath it: a function that ran past its time
// limit, a body over the size cap, a function that crashed before it could
// reply. Those arrive as Vercel's own HTML error page, JSON.parse fails, and
// the client is left holding {}.
//
// That used to surface as the bare string "request failed", which names no
// cause, suggests no next step, and cannot be reported usefully — the user
// sees four words and the actual status code is discarded.
//
// .mjs so the browser and Node both read it as an ES module: the repo has no
// build step and package.json has no "type": "module", so a plain .js file
// would be CommonJS to Node and break the tests.

/**
 * A message for a failure the app's own handlers did not produce.
 * Returns null when the status carries no useful meaning on its own.
 */
export function describeHttpFailure(status) {
  // The vision and generation calls are the slow ones, and a provider having a
  // slow minute is the usual reason a function runs out of time.
  if (status === 504 || status === 408) {
    return "That took too long and the server gave up before the AI answered. Try again — if it keeps happening, pick a faster model in Profile → AI providers.";
  }
  if (status === 413) {
    return "That file was too large to send. Try a smaller or more tightly cropped screenshot.";
  }
  if (status === 429) {
    return "Too many requests in a short time. Wait a moment and try again.";
  }
  if (status === 502 || status === 503) {
    return "The server couldn't be reached just now. Try again in a moment.";
  }
  if (typeof status === "number" && status >= 500) {
    return `The server errored (HTTP ${status}) before it could reply. Try again — if it keeps happening, pick a different model.`;
  }
  if (typeof status === "number" && status >= 400) {
    return `The request was rejected (HTTP ${status}).`;
  }
  return null;
}

/**
 * The message to show for a failed API response.
 * `data` is the parsed JSON body, or {} when the body wasn't JSON at all.
 */
export function apiErrorMessage(status, data) {
  const d = data && typeof data === "object" ? data : {};
  if (d.error) return d.error + (d.detail ? ` (${d.detail})` : "");
  // No error field means the platform answered, not the app. Never let this
  // degrade to a bare "request failed" again — always name the status.
  return describeHttpFailure(status) || `The request failed (HTTP ${status}).`;
}
