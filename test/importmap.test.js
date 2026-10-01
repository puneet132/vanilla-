const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// The import map in index.html is an inline script. The CSP in vercel.json only lets
// it run because its exact sha256 is allow-listed. If the two drift apart, every
// `import ... from "three"` silently fails in production while working locally.

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));

const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
const csp = vercel.headers
  .flatMap((h) => h.headers)
  .find((h) => h.key === "Content-Security-Policy").value;

test("index.html has an import map", () => {
  assert.ok(mapMatch, "no <script type=\"importmap\"> found");
});

test("the import map's hash is allow-listed in the CSP script-src", () => {
  const hash = crypto.createHash("sha256").update(mapMatch[1], "utf8").digest("base64");
  const scriptSrc = csp.match(/script-src([^;]*)/)[1];
  assert.ok(
    scriptSrc.includes(`'sha256-${hash}'`),
    `CSP script-src is missing 'sha256-${hash}'. Update vercel.json after editing the import map.`,
  );
});

// Prefix entries ("three/addons/") are skipped: that folder only exists once an add-on is vendored.
test("every import map file target is vendored", () => {
  const { imports } = JSON.parse(mapMatch[1]);
  for (const [spec, target] of Object.entries(imports)) {
    if (target.endsWith("/")) continue;
    const p = path.join(root, target);
    assert.ok(fs.existsSync(p), `${spec} → ${target} does not exist. Run \`npm run vendor:three\`.`);
  }
});

test("vendored three matches the version pinned in package.json", () => {
  const pinned = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).devDependencies.three;
  const vendored = fs.readFileSync(path.join(root, "vendor", "three", "VERSION"), "utf8").trim();
  assert.strictEqual(vendored, pinned, "Re-run `npm run vendor:three` after changing the three version.");
});
