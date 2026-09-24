// Bumper CACHE_VERSION à chaque déploiement pour forcer la mise à jour du shell.
const CACHE_VERSION = 'chall-v22';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Les photos des fiches clients survivent aux mises à jour de l'appli.
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== 'chall-photos').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Les données passent toujours par le réseau : le repli hors ligne est géré
  // côté application (cache localStorage + file d'attente).
  if (url.pathname.startsWith('/api/')) return;

  // Navigation : réseau d'abord, cache en secours si le réseau est coupé.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Ressources statiques : réseau d'abord, cache en secours.
  // Le cache d'abord servait l'ancienne version après chaque déploiement, et
  // il fallait deux ouvertures pour voir une modification.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
