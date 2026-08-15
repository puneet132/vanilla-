// App-shell caching for offline/instant load.
//
// The previous version served EVERY same-origin GET cache-first from a cache
// whose name never changed. Once a device loaded the app it kept serving that
// first copy of index.html/app.js/style.css forever — new deploys could not
// reach an installed client at all. That is fatal for a PWA: there is no way
// to ship a fix to anyone who already installed it.
//
// Two rules now:
//   - Code (documents, JS, CSS) is NETWORK-FIRST. The network copy always wins
//     when reachable; the cache is only a fallback for being offline.
//   - Genuinely static assets (icons) stay CACHE-FIRST, since they don't change
//     without a filename change.
//
// CACHE_VERSION is part of the cache name, and activate() deletes every cache
// that isn't the current one. Bumping it guarantees a clean slate. Because
// vercel.json serves this file with `Cache-Control: no-cache`, the browser
// re-checks it on navigation, so a client stuck on the old worker self-heals
// within about two loads.
const CACHE_VERSION = "v2";
const CACHE = `vanilla-${CACHE_VERSION}`;

// Only immutable assets belong here. Deliberately NOT index.html/app.js/style.css.
const PRECACHE = [
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      // Individual failures must not abort the install, or one 404 leaves the
      // client on the previous worker indefinitely.
      .then(c => Promise.allSettled(PRECACHE.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStaticAsset(pathname) {
  return /\.(png|jpg|jpeg|svg|webp|ico|woff2?)$/i.test(pathname);
}

// Network-first: try the network, cache what we get, fall back to cache when
// offline. Navigations fall back to the cached shell so the app still opens.
async function networkFirst(request, isNavigation) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(request);
    if (hit) return hit;
    if (isNavigation) {
      const shell = await caches.match("./index.html");
      if (shell) return shell;
    }
    throw err;
  }
}

// Cache-first, refreshing in the background so a changed asset is picked up
// on the following load rather than never.
async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) {
    fetch(request)
      .then(res => { if (res && res.ok) return caches.open(CACHE).then(c => c.put(request, res)); })
      .catch(() => {});
    return hit;
  }
  const res = await fetch(request);
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener("fetch", e => {
  const request = e.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never touch API calls or anything cross-origin (fonts, Firebase, provider
  // endpoints) — those manage their own caching and must not be intercepted.
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  const isNavigation = request.mode === "navigate";

  if (isStaticAsset(url.pathname)) {
    e.respondWith(cacheFirst(request));
    return;
  }

  e.respondWith(networkFirst(request, isNavigation));
});
