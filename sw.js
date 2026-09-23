// เก็บไฟล์ของแอปไว้ในเครื่อง → เปิดได้แม้ไม่มีอินเทอร์เน็ต
// ใช้ไฟล์ในเครื่องก่อน แล้วอัปเดตจากเซิร์ฟเวอร์เบื้องหลัง (เวอร์ชันใหม่จะมีผลเมื่อเปิดแอปครั้งถัดไป)

const CACHE = 'scansv-v4';
const FONT_CACHE = 'scansv-fonts';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './6thsense.css',
  './6thsense.js',
  './app.css',
  './app.js',
  './camera.js',
  './crop.js',
  './db.js',
  './detect.js',
  './icons.js',
  './pdf.js',
  './processing.js',
  './ui.js',
  './util.js',
  './favicon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // ฟอนต์ IBM Plex Sans Thai ของ Design System — เก็บไว้ใช้ตอนออฟไลน์
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(caches.open(FONT_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
      return response;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(request, { ignoreSearch: true });
    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => cached);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return network;
  }));
});
