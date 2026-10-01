// Copies Three.js out of node_modules into vendor/three/ so the browser can load it.
//
// Why vendor instead of a CDN: vercel.json's Content-Security-Policy only allows
// scripts from 'self' (plus Google's auth hosts). A CDN <script> or import would be
// blocked in production. Vendored files are same-origin, work offline in the PWA,
// and can't change underneath us.
//
// Why not ship all of node_modules/three: examples/jsm alone is ~10 MB. Only the core
// is copied by default; add-ons are copied on request, along with every add-on file
// they import relatively (e.g. UnrealBloomPass pulls in Pass.js and two shaders).
//
//   npm run vendor:three                                   # core only
//   npm run vendor:three -- controls/OrbitControls.js      # core + an add-on
//
// Add-on paths are relative to node_modules/three/examples/jsm, which is exactly the
// part after "three/addons/" in an import, so `three/addons/x/Y.js` → `x/Y.js`.
// Pages import them the usual way thanks to the import map in index.html.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "node_modules", "three");
const outDir = join(root, "vendor", "three");

if (!existsSync(pkgDir)) {
  console.error("three is not installed. Run `npm install` first.");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

// three.module.js re-exports most of the library from ./three.core.js, so both are needed.
for (const f of ["three.module.js", "three.core.js"]) {
  copy(join(pkgDir, "build", f), join(outDir, f));
}

const addonsSrc = join(pkgDir, "examples", "jsm");
const addonsOut = join(outDir, "addons");
const relImport = /(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const unsupported = /from\s*['"](three\/(?:webgpu|tsl))['"]/;
const seen = new Set();

function vendorAddon(relPath) {
  if (seen.has(relPath)) return;
  const src = join(addonsSrc, relPath);
  if (!existsSync(src)) {
    console.error(`No such add-on: three/addons/${relPath}`);
    process.exit(1);
  }
  seen.add(relPath);
  const code = readFileSync(src, "utf8");
  const bad = code.match(unsupported);
  if (bad) {
    console.error(`three/addons/${relPath} needs '${bad[1]}' (WebGPU/TSL), which this site does not vendor. Use a WebGL version of the effect instead.`);
    process.exit(1);
  }
  copy(src, join(addonsOut, relPath));
  for (const [, spec] of code.matchAll(relImport)) {
    vendorAddon(relative(addonsSrc, resolve(dirname(src), spec)));
  }
}

for (const arg of process.argv.slice(2)) {
  vendorAddon(arg.replace(/^three\/addons\//, "").replace(/^\/+/, ""));
}

writeFileSync(join(outDir, "VERSION"), `${version}\n`);
console.log(`Vendored three ${version} → vendor/three/` +
  (seen.size ? ` (+${seen.size} add-on file${seen.size > 1 ? "s" : ""})` : ""));
