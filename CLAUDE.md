# Vanilla — notes for Claude

Plain HTML/CSS/JS PWA (no build step) served statically by Vercel, with serverless
functions in `api/`. See `README.md` for the architecture and setup. Run `npm test`
before pushing.

## Visual effects (ThreeUI / Three.js)

The owner uses ThreeUI (threeui.com) prompts to add premium interactions. The full
guide is in `docs/threeui-guide.md`. When asked to add one:

**Need from the owner:** the component's ThreeUI prompt (threeui.com is not reachable
from cloud sessions, so it must be pasted), ideally a screenshot of the effect, and
which section it goes in. Ask if any of these is missing rather than guessing.

**Product rules**
- One "wow" moment only. Default home for it is the sign-in screen (`#screen-login`).
  Do not animate the working screens (capture, fit check, review & send, applications,
  profile) — users read verdicts and emails there.
- Calm, not flashy. Vanilla is a job-search tool; the look is warm parchment + ink.
- Brand colours (from `style.css` `:root`): ground `--paper #F3EEE3`, surface
  `--card #FFFCF6`, ink `--ink #221F1A`, accent `--accent #1F5D5B` (ink-teal), tint
  `--accent-tint #E4EFEE`. Never use the fit colours (green/amber/red) decoratively.
  Remove every demo colour from the ThreeUI source.
- Text, buttons and the age/consent checkboxes must stay readable and clickable on top.
- Modify only the target section. Keep copy, layout and other screens intact.

**Performance and accessibility**
- Load the effect lazily (dynamic `import()`), only while its screen is visible; stop
  the render loop and dispose the renderer when the screen changes.
- Pause when the tab is hidden (`visibilitychange`).
- `prefers-reduced-motion: reduce` → render one static frame or skip WebGL entirely.
- Mobile: fewer particles/segments, `renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))`.
- If WebGL is unavailable, fail silently and leave the plain screen.

**How Three.js is installed here — do not use a CDN**
- `vercel.json`'s CSP allows scripts only from `'self'` (plus Google auth). CDN imports
  (unpkg, jsdelivr, esm.sh, skypack) will be blocked in production.
- Three.js is vendored into `vendor/three/` from the pinned `three` devDependency.
  Import it normally: `import * as THREE from "three"`.
- Add-ons (`three/addons/...`) are vendored on demand:
  `npm run vendor:three -- controls/OrbitControls.js postprocessing/UnrealBloomPass.js`
  (paths after `three/addons/`). Commit the copied files in `vendor/three/addons/`.
- WebGPU/TSL (`three/webgpu`, `three/tsl`) is not vendored; port such effects to WebGL.
- The import map in `index.html` is inline and allow-listed in the CSP by sha256. If you
  edit it, update the hash in `vercel.json`; `test/importmap.test.js` checks this.
- Upgrading three: change the pinned version, `npm install`, re-run `vendor:three` with
  the same add-ons, run `npm test`.
- Effect code goes in its own module file at the root (e.g. `login-effect.mjs`) and needs
  a `Cache-Control: no-cache` entry in `vercel.json` like the other root modules.
- Never add inline `<script>` blocks (the CSP blocks them); put code in a module file.

**Verify before pushing:** `npm test`, then load the page in headless Chromium
(Playwright is preinstalled in cloud sessions) at desktop and phone widths with the
CSP header applied, and check there are no console errors and the text is readable.
