const VERSION = "v1";
const SHELL_CACHE = `3nding-shell-${VERSION}`;
const BOOK_CACHE = "3nding-books";

const SHELL_FILES = [
  "/",
  "/index.html",
  "/reader.html",
  "/manifest.json",
  "/styles/index.css",
  "/styles/reader.css",
  "/scripts/index.js",
  "/scripts/reader.js",
  "/scripts/jszip.js",
  "/scripts/auth.js",
  "/scripts/firebase-config.js",
  "/fonts/fraunces.woff2",
  "/fonts/worksans.woff2",
  "/fonts/spacemono.woff2",
  "/fonts/literata.woff2",
  "/apple-touch-icon.png",
  "/pages/about.html",
  "/pages/terms.html",
  "/pages/privacy.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("3nding-shell-") && k !== SHELL_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function store(cacheName, request, response) {
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  }
  return response;
}

async function handleNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    return (
      (await caches.match(request, { ignoreSearch: true })) ||
      (await caches.match("/index.html"))
    );
  }
}

async function networkFirst(request, cacheName) {
  try {
    return await store(cacheName, request, await fetch(request));
  } catch {
    const cached = await caches.match(request);
    return cached || Response.error();
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return store(cacheName, request, await fetch(request));
}

async function staleWhileRevalidate(event) {
  const { request } = event;
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then((res) => store(SHELL_CACHE, request, res))
    .catch(() => null);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return (await refresh) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
  } else if (url.pathname === "/books.json") {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  } else if (url.pathname.startsWith("/books/")) {
    event.respondWith(cacheFirst(request, BOOK_CACHE));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});
