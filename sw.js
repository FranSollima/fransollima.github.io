// Service worker mínimo — no cachea nada, solo permite instalación como PWA.
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));
