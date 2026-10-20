// QUICK ADMIN — network-first navigation so newly deployed admin controls appear.
// Never intercept remote APIs or cache sensitive responses.
const CACHE_NAME = 'quick-admin-v2-20261020';
const CORE = ['./', './index.html', './manifest.json'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if(u.origin !== self.location.origin) return;
  if(e.request.mode === 'navigate' || u.pathname.endsWith('/index.html')) {
    e.respondWith(fetch(e.request,{cache:'no-store'}).then(resp=>{
      if(resp.ok){const copy=resp.clone();caches.open(CACHE_NAME).then(c=>c.put('./index.html',copy)).catch(()=>{});}
      return resp;
    }).catch(()=>caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request)));
});
