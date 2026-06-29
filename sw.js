// ── ALEEM AI Service Worker v2 ────────────────────────────────────
// Cache strategy:
//   HTML               → Network First, Cache fallback
//   Static assets      → Cache First
//   API / Auth / Cloud → Network Only (never cached)

const CACHE_VERSION = 'aleem-v2';
const CACHE_STATIC  = CACHE_VERSION + '-static';

// Assets to precache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Patterns that must NEVER be cached (API, auth, cloud services)
const NEVER_CACHE = [
  /\/\.netlify\/functions\//,
  /generativelanguage\.googleapis\.com/,
  /api\.groq\.com/,
  /firestore\.googleapis\.com/,
  /firebase\.googleapis\.com/,
  /identitytoolkit\.googleapis\.com/,
  /securetoken\.googleapis\.com/,
  /res\.cloudinary\.com/,
  /api\.cloudinary\.com/,
  /accounts\.google\.com/,
  /gstatic\.com\/firebasejs/,
];

// ── UPDATE: allow page to trigger immediate activation ────────────
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── INSTALL: precache shell assets ────────────────────────────────
// Note: intentionally NOT calling self.skipWaiting() here.
// The new SW waits in the 'installed' state until the page posts
// SKIP_WAITING, which triggers a controlled reload (see index.html).
// This prevents the new SW from activating mid-session.
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(function(cache) {
      return cache.addAll(PRECACHE_URLS);
    })
  );
});

// ── ACTIVATE: remove old caches ───────────────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys
          .filter(function(k) { return k !== CACHE_STATIC; })
          .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── FETCH: routing logic ───────────────────────────────────────────
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // 1. Never cache: API calls, auth, cloud services
  for (var i = 0; i < NEVER_CACHE.length; i++) {
    if (NEVER_CACHE[i].test(url)) {
      event.respondWith(fetch(event.request));
      return;
    }
  }

  // 2. Only handle GET
  if (event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  // 3. HTML → Network First with Cache fallback
  var acceptHeader = event.request.headers.get('Accept') || '';
  var isHTML = acceptHeader.includes('text/html') ||
               url.endsWith('/') || url.endsWith('.html');

  if (isHTML) {
    event.respondWith(
      fetch(event.request).then(function(res) {
        // Clone and cache fresh HTML
        var clone = res.clone();
        caches.open(CACHE_STATIC).then(function(cache) {
          cache.put(event.request, clone);
        });
        return res;
      }).catch(function() {
        return caches.match(event.request).then(function(cached) {
          return cached || caches.match('/index.html');
        });
      })
    );
    return;
  }

  // 4. Static assets → Cache First
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(res) {
        // Only cache valid same-origin or CORS responses for known static types
        if (res && res.status === 200 && isStaticAsset(url)) {
          var clone = res.clone();
          caches.open(CACHE_STATIC).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return res;
      });
    })
  );
});

// Only cache fonts, CSS, JS, images — not dynamic or opaque unknown responses
function isStaticAsset(url) {
  return /\.(js|css|png|jpg|jpeg|svg|ico|woff2?|ttf|otf|gif|webp)(\?|$)/.test(url);
}
