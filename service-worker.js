"use strict";

const CACHE_NAME = "java-vault-shell-v9";
const APP_SHELL = [
  "./java-vault.html",
  "./java-vault.css",
  "./java-vault.js",
  "./vault-storage.js",
  "./manifest.webmanifest",
  "./java-vault-icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("java-vault-shell-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("notificationclick", (event) => {
  const lessonId = event.notification.data && event.notification.data.lessonId;
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const appClient = clients.find((client) => {
        const clientUrl = new URL(client.url);
        return clientUrl.origin === self.location.origin && clientUrl.pathname.endsWith("/java-vault.html");
      });
      if (appClient) {
        appClient.postMessage({ type: "open-lesson", lessonId });
        return appClient.focus();
      }
      const target = new URL("./java-vault.html", self.location.href);
      if (lessonId) target.searchParams.set("lesson", lessonId);
      return self.clients.openWindow(target.href);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);
  if (request.method !== "GET" || requestUrl.origin !== self.location.origin) return;

  if (requestUrl.pathname.endsWith("/manifest.webmanifest")) {
    event.respondWith(
      fetch(request, { cache: "no-cache" })
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || Response.error())
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || caches.match("./java-vault.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }))
  );
});
