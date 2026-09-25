/* Aufgaben – Service Worker.
   Hält die App-Dateien vor, damit sie sofort und auch ohne Netz startet.
   __VERSION__ ersetzt der Server durch eine Prüfsumme über alle App-Dateien:
   jede Änderung ergibt eine neue sw.js, und der Browser zieht die neue Fassung. */
'use strict';

const CACHE = 'aufgaben-__VERSION__';
const SHELL = ['./', 'app.js', 'app.css', 'icons/icon-192.png', 'icons/favicon-64.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  const path = url.pathname.slice(scope.pathname.length);
  // Daten, Manifest und Kurzbefehl-Symbole immer frisch vom Server.
  if (path.startsWith('api/') || path === 'manifest.webmanifest' || path.startsWith('icons/plus-')) return;

  if (req.mode === 'navigate') {
    // Jede Seite der App ist dieselbe index.html – auch ?neu, ?kat=… und Teilen.
    e.respondWith(caches.match('./').then((hit) => hit || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
