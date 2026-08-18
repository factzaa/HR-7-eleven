// Service Worker — ระบบ HR 7-Eleven (PWA)
// กลยุทธ์: network-first สำหรับไฟล์ในโดเมนเดียวกัน (กันโค้ดค้าง cache)
//          + cache fallback เวลาออฟไลน์
// คำขอข้ามโดเมน (Supabase / CDN / fonts) ปล่อยให้วิ่งเน็ตตามปกติ

const CACHE = 'hr7-eleven-v5';       // ★ ขึ้นเวอร์ชัน = ล้าง cache เก่า (v5: แชทนิดาโฉมใหม่ + เสียงเรียลไทม์ Gemini Live)
const ASSETS = [
  './',
  './index.html',
  './employee/index.html',
  './hr/index.html',
  './mgr/index.html',
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

// ---------- Web Push (แจ้งเตือนฝั่ง HR แม้ปิดแอป) ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text ? e.data.text() : '' }; }
  const title = d.title || 'แจ้งเตือน HR · 7-Eleven';
  const opts = {
    body: d.body || '',
    icon: d.icon || './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: d.tag || 'hr-notify',          // tag เดียวกัน = รวมเป็นอันเดียว ไม่รก
    renotify: true,
    requireInteraction: !!d.requireInteraction,   // ฉุกเฉิน = ค้างจอจนกดปิด
    data: { url: d.url || './hr/' },
    vibrate: d.vibrate || [120, 60, 120]           // ฉุกเฉินส่ง pattern สั่นแรงกว่ามาได้
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './hr/';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/hr') && 'focus' in c) return c.focus();
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // ข้าม Supabase/CDN/fonts

  e.respondWith((async () => {
    try {
      // ★ บังคับ revalidate กับเซิร์ฟเวอร์ (ไม่ใช้ HTTP cache ของเบราว์เซอร์) — กันมือถือได้ไฟล์เก่าค้าง
      //   ถ้าไฟล์ไม่เปลี่ยน เซิร์ฟเวอร์ตอบ 304 (เบา) · ถ้าเปลี่ยนได้ไฟล์ใหม่ทันที
      let res;
      try { res = await fetch(new Request(req, { cache: 'no-cache' })); }
      catch (_e) { res = await fetch(req, { cache: 'no-cache' }); }
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    } catch (err) {
      const cached = await caches.match(req);
      return cached || caches.match('./index.html');
    }
  })());
});
