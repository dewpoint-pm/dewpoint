/* ═══════════════════════════════════════════════════════════════
   sw.js  —  Dew Point POS Service Worker
   Estrategia: Cache-First para assets estáticos,
               Network-First para llamadas API/DB.
   Compatible con Android 4.4+ (Chrome 36+)
   ═══════════════════════════════════════════════════════════════ */

var CACHE_NAME = 'dewpoint-v2';
var STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/js/app.js',
  '/js/db.js',
  '/js/router.js',
  '/pages/login.html',
  '/pages/home.html',
  '/pages/venta.html',
  '/pages/perfumes.html',
  '/pages/clientes.html',
  '/pages/historial.html',
  '/pages/insumos.html',
  '/pages/costos.html',
  '/pages/config.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

/* ── Instalación: pre-cachear todos los assets ── */
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

/* ── Activación: limpiar caches viejos ── */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

/* ── Fetch: Cache-First para estáticos, Network-First para API ── */
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  /* Llamadas a la API / PostgreSQL → siempre red, sin caché */
  if (url.indexOf('/api/') !== -1 ||
      url.indexOf('neon.tech') !== -1 ||
      url.indexOf('supabase') !== -1) {
    e.respondWith(
      fetch(e.request).catch(function() {
        return new Response(
          JSON.stringify({ error: 'Sin conexión. Verifica tu internet.' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  /* Assets estáticos → Cache-First */
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(response) {
        if (!response || response.status !== 200) return response;
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(e.request, clone);
        });
        return response;
      }).catch(function() {
        /* Si no hay red y no está en caché → página offline */
        return caches.match('/index.html');
      });
    })
  );
});

/* ── Mensaje para forzar actualización desde la app ── */
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
