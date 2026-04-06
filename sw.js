const CACHE_NAME = 'stock-dash-v1';
const PRECACHE = [
  '/stock-dashboard.html',
  '/chart-analysis.html',
  '/reports.html',
  '/report-gen.html',
  '/scoring.html',
  '/quant.html',
  '/deep-report.html',
  '/manifest.json',
];

// 설치: 핵심 파일 캐시
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// 활성화: 이전 캐시 정리
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 네트워크 우선, 실패 시 캐시 (API는 항상 네트워크)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API 요청은 캐시하지 않음
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // 성공 시 캐시 업데이트
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
