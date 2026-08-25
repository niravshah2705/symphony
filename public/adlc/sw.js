const CACHE_NAME = 'adlc-landing-v2';
const ASSETS = [
  '/adlc/',
  '/adlc/index.html',
  '/adlc/styles.css',
  '/adlc/app.js',
  '/adlc/manifest.webmanifest',
  '/adlc/blog/',
  '/adlc/brief/',
  '/adlc/blog/governance/',
  '/adlc/blog/isolation/',
  '/adlc/blog/evidence/',
  '/adlc/blog/lifecycle/',
  '/adlc/blog/integration/',
  '/adlc/blog/getting-started/'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key !== CACHE_NAME)
      .map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/adlc/')) {
    return;
  }
  if (url.pathname === '/adlc/config.js') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
