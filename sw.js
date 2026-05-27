// Quick Admin - Service Worker (간단한 PWA 지원)
// 캐시 우선 전략 — index.html 만 캐시, 데이터 (Supabase) 는 항상 네트워크

const CACHE_NAME = 'quick-admin-v1';
const CORE_FILES = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Supabase / 외부 API 는 항상 네트워크 (캐시 안 함)
  if (url.host.includes('supabase.co') || url.host.includes('googleapis')) {
    return;
  }
  // 정적 파일만 캐시 전략
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) {
        // 백그라운드에서 업데이트
        fetch(e.request).then((resp) => {
          if (resp && resp.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, resp));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(e.request).then((resp) => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
        }
        return resp;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
