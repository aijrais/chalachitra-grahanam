// Only the application shell and the two bundled samples belong in this cache.
const cacheName = 'chalachitra-studio-dev-1';
const files = ['./', './index.html', './app.js', './studio.css', './session.js', './detectors.js', './analysis.js',
  './pitch-worker.js', './football.js', './football-report.js', './football-scan.js', './youtube-player.js',
  './manifest.webmanifest', './icons.svg', './assets/barlow-regular.woff', './assets/barlow-semibold.woff',
  './assets/icon-192.png',
  './assets/icon-512.png', './assets/court.mp4', './assets/held-sa.wav'
];
const allowed = new Set(files.map(file => new URL(file, self.registration.scope).href));
self.addEventListener('install', event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(
  files))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys())
    if (key.startsWith('chalachitra-studio-') && key !== cacheName) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || !allowed.has(req.url) || req.headers.has('range')) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return (await cache.match(req.url)) || fetch(req);
  })());
});
