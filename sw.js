/* sw.js — Flushcard service worker
   - Pre-caches the app shell so it opens offline
   - Network-first for pages, cache-first for static assets
   - Never caches API calls or Supabase auth
   - Caches Google Fonts + CDN scripts for offline use */

const CACHE  = "flushcard-v6";
const EXT    = "flushcard-ext-v6";

const SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/cloud.js",
  "/supabase-config.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(p => c.add(p).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== EXT).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 1. Never touch API routes
  if (url.pathname.startsWith("/api/")) return;

  // 2. Cross-origin: cache fonts & CDN scripts, ignore everything else (Supabase)
  if (url.origin !== location.origin) {
    const isCacheable =
      url.host.endsWith("googleapis.com") ||
      url.host.endsWith("gstatic.com") ||
      url.host.endsWith("cloudflare.com") ||
      url.host.endsWith("jsdelivr.net");

    if (!isCacheable) return;   // let Supabase + anything else go straight to network

    e.respondWith((async () => {
      const c = await caches.open(EXT);
      const hit = await c.match(req);
      const network = fetch(req).then(res => {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || network;
    })());
    return;
  }

  // 3. Same-origin navigation: network first, cache fallback
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(CACHE);
        c.put("/index.html", res.clone());
        return res;
      } catch {
        const hit = await caches.match("/index.html");
        return hit || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
      }
    })());
    return;
  }

  // 4. Same-origin static: cache first, fall back to network
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
      }
      return res;
    } catch {
      return new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
    }
  })());
});
