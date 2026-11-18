/*
 * DealMind service worker (docs/service-worker-strategy.md).
 *
 * What it caches, and nothing else:
 *   - immutable static assets: responses whose Cache-Control says "immutable"
 *     (Next.js hashed /_next/static files in production) and the app icons;
 *   - one offline page, /offline, fetched at install.
 * It NEVER stores pages or API responses: no HTML except /offline, no /api,
 * no RSC payloads, so no private data (searches, watchlists, prices,
 * notifications, account, admin) can be served from it, before or after sign-out.
 *
 * Navigations go to the network; only when the network fails is /offline shown.
 * Also handles web-push display and notification clicks (unchanged behaviour).
 */
const VERSION = "v1";
const STATIC_CACHE = `dm-static-${VERSION}`;
const OFFLINE_CACHE = `dm-offline-${VERSION}`;
const OFFLINE_URL = "/offline";
const ICONS = [
  "/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
];
const STATIC_MAX_ENTRIES = 300;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const offline = await caches.open(OFFLINE_CACHE);
      // `cache: "reload"` bypasses the HTTP cache so the page matches this deployment.
      await offline.add(new Request(OFFLINE_URL, { cache: "reload", credentials: "omit" }));
      const statics = await caches.open(STATIC_CACHE);
      await statics.addAll(ICONS);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, OFFLINE_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith("dm-") && !keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

const isStaticPath = (path) =>
  path.startsWith("/_next/static/") || path.startsWith("/icons/") || path === "/icon.svg";

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - STATIC_MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

async function staticFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  const cacheControl = response.headers.get("cache-control") || "";
  const cacheable =
    response.ok &&
    response.type === "basic" &&
    (cacheControl.includes("immutable") || ICONS.includes(new URL(request.url).pathname));
  if (cacheable) {
    await cache.put(request, response.clone());
    await trim(cache);
  }
  return response;
}

async function navigate(event) {
  try {
    const preload = await event.preloadResponse;
    return preload || (await fetch(event.request));
  } catch {
    const offline = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE });
    return (
      offline ||
      new Response("You are offline.", { status: 503, headers: { "content-type": "text/plain" } })
    );
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(event));
    return;
  }
  if (isStaticPath(url.pathname) && !url.search) {
    event.respondWith(staticFirst(request));
  }
  // Everything else (API, RSC payloads, images via /_next/image, manifest): network, never cached.
});

self.addEventListener("message", (event) => {
  // Sent on sign-out. Nothing private is cached, but drop anything not on the allow-list.
  if (event.data && event.data.type === "SIGNED_OUT") {
    event.waitUntil(
      (async () => {
        for (const name of await caches.keys()) {
          if (name !== STATIC_CACHE && name !== OFFLINE_CACHE) await caches.delete(name);
        }
      })(),
    );
  }
});

// ── Web push ────────────────────────────────────────────────────────────────

const safePath = (url) =>
  typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/notifications";

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "DealMind";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      data: { url: safePath(data.url) },
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    safePath(event.notification.data && event.notification.data.url),
    self.location.origin,
  );
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin === target.origin && "focus" in w) {
          await w.focus();
          if ("navigate" in w) await w.navigate(target.href);
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
