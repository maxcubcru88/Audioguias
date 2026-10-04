/* Service worker: la app y el recorrido funcionan sin conexión una vez abiertos.
   Al publicar cambios: sube VERSION aquí y el ?v= de css/js en index.html y en FILES. */
const VERSION = 'v17';
const SHELL = 'shell-' + VERSION;
const MAP = 'map-v1';
const FONTS = 'fonts-v1';
const FILES = [
  './',
  'index.html',
  'css/app.css?v=17',
  'js/app.js?v=17',
  'data/catalogo.json',
  'data/paris/centro.json',
  'vendor/maplibre/maplibre-gl.css',
  'vendor/maplibre/maplibre-gl.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/ciudades/paris.svg',
  'icons/ciudades/londres.svg',
  'icons/ciudades/sevilla.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  // Mapa (OpenFreeMap): teselas, tipografías e iconos de la caché primero;
  // el estilo y el índice de teselas, de la red primero para recibir actualizaciones.
  if (url.startsWith('https://tiles.openfreemap.org/')) {
    const isData = /\.(pbf|png|json)(\?|$)/.test(url) && !/\/styles\/|\/planet(\?|$)/.test(url) || /\/fonts\//.test(url);
    e.respondWith(caches.open(MAP).then(async c => {
      if (isData) {
        const hit = await c.match(req);
        if (hit) return hit;
        try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }
        catch (err) { return new Response('', { status: 504 }); }
      }
      try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }
      catch (err) { return (await c.match(req)) || new Response('', { status: 504 }); }
    }));
    return;
  }

  if (url.startsWith('https://fonts.googleapis.com/') || url.startsWith('https://fonts.gstatic.com/')) {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); c.put(req, res.clone()); return res; }
      catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }

  if (new URL(url).origin === self.location.origin) {
    // Red primero (para recibir los cambios del guion), caché si no hay conexión.
    e.respondWith(
      fetch(req.url, { cache: 'no-cache' }).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
    );
  }
});
