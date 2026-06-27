// Service Worker — ระบบ HR 7-Eleven (PWA)
// กลยุทธ์: network-first สำหรับไฟล์ในโดเมนเดียวกัน (กันโค้ดค้าง cache)
//          + cache fallback เวลาออฟไลน์
// คำขอข้ามโดเมน (Supabase / CDN / fonts) ปล่อยให้วิ่งเน็ตตามปกติ

const CACHE = 'hr7-eleven-v1';
const ASSETS = [
  './',
  './index.html',
  './employee/index.html',
  './hr/index.html',
  './shared/config.js',
  './shared/supabase.js',
  './shared/hr-api.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // ใช้ allSettled กันกรณีไฟล์ใดไฟล์หนึ่งหาย จะได้ไม่ล้มทั้งก้อน
    await Promise.allSettled(ASSETS.map((a) => c.add(a)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // ข้าม Supabase/CDN/fonts

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    } catch (err) {
      const cached = await caches.match(req);
      return cached || caches.match('./index.html');
    }
  })());
});
