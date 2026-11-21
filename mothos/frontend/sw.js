const CACHE_NAME = 'mothos-static-v10';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/icons/mothos-icon.svg',
  '/icons/mothos-maskable.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/js/main.js',
  '/js/api.js',
  '/js/store.js',
  '/js/ui.js',
  '/js/utils.js',
  '/js/sparkline.js',
  '/js/widgets.js',
  '/js/apps/gpu.js',
  '/js/apps/monitor.js',
  '/js/apps/vm.js',
  '/js/apps/usb.js',
  '/js/apps/files.js',
  '/js/apps/updates.js',
  '/js/apps/terminal.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  // Never intercept WebSockets, CA cert download, or non-GET requests
  if (url.pathname.startsWith('/ws') || url.pathname === '/mothos-ca.crt' || request.method !== 'GET') {
    return;
  }

  // Network-first (no caching of sensitive API data) for /api/*
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ error: 'offline', message: 'Sem conexão com o host MothOS' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
    return;
  }

  // Network-first with safe cache/navigation fallback so respondWith never resolves undefined
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = (await caches.match('/index.html')) || (await caches.match('/'));
          if (shell) return shell;
        }
        return new Response('Offline — MothOS', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })()
  );
});
