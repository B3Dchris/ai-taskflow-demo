/* JitsFlow service worker: keeps the app working offline at the gym. */
const CACHE = "jitsflow-e6368c0cda";
const CORE = ["/", "/app/", "/manifest.webmanifest", "/img/today.jpg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/favicon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("jitsflow-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Account data always comes live from the server, never from the offline cache.
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  // Pages: try the network first so updates arrive, fall back to the cached app offline.
  if (req.mode === "navigate") {
    // The app and the home page are kept under fixed keys; other pages (techniques…) under their own address.
    const page = url.pathname.startsWith("/app") ? "/app/" : url.pathname === "/" || url.pathname === "/index.html" ? "/" : url.pathname;
    e.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(page, copy)); } return res; })
        .catch(() => caches.match(page).then((hit) => hit || caches.match("/")))
    );
    return;
  }

  // Our own files and Google Fonts: serve from cache, refresh in the background.
  if (url.origin === location.origin || url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((hit) => {
          const net = fetch(req).then((res) => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
  }
  // Everything else (YouTube) goes straight to the network.
});
