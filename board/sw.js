/* clawgate board service worker: offline app shell + stale-while-revalidate assets. */
const CACHE = "clawgate-shell-v11";
const SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/assets/office.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function cachePut(request, response) {
  if (!response || response.status !== 200 || response.type === "opaque") return;
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never intercept API calls or the websocket upgrade path.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          cachePut("/", response);
          return response;
        })
        .catch(async () => (await caches.match("/")) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          cachePut(request, response);
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
