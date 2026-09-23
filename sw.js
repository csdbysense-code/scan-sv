// เก็บไฟล์ของแอปไว้ในเครื่อง → เปิดได้แม้ไม่มีอินเทอร์เน็ต
// ใช้ไฟล์ในเครื่องก่อน แล้วอัปเดตจากเซิร์ฟเวอร์เบื้องหลัง (เวอร์ชันใหม่จะมีผลเมื่อเปิดแอปครั้งถัดไป)

const CACHE = 'scansv-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/camera.js',
  './js/crop.js',
  './js/db.js',
  './js/detect.js',
  './js/icons.js',
  './js/pdf.js',
  './js/processing.js',
  './js/util.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

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
