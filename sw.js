/* Offline shell + cache-first audio. Audio is cached on demand, never all at install time. */
const VERSION = 'phonics-pwa-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const AUDIO_CACHE = `${VERSION}-audio`;
const SHELL = [
  './', './index.html', './style.css', './script.js', './phonics-parser.js',
  './app-config.js', './pwa.js', './manifest.webmanifest',
  './vendor/splide/splide-core.min.css', './vendor/splide/splide.min.js',
  './data.json', './tts-routes.json', './audio-cache/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('phonics-pwa-') && ![SHELL_CACHE, AUDIO_CACHE].includes(key))
      .map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

async function trimAudioCache(cache) {
  const keys = await cache.keys();
  const limit = 256;
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map(key => cache.delete(key)));
}

async function cacheFirst(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimAudioCache(cache);
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && new URL(request.url).origin === self.location.origin) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error('offline');
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (/^(localhost|127\.0\.0\.1)$/i.test(url.hostname)) return;
  // API Render is cross-origin from GitHub Pages; service workers can still
  // apply network-first to it, while audio/static storage stays same-origin.
  if (url.pathname.includes('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if ((url.pathname.includes('/audio-cache/') || url.pathname.includes('/audio/')) && url.pathname.endsWith('.wav')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || networkFirst(request)));
});
