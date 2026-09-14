/**
 * Service worker for the C-Dots landing page.
 *
 * It exists for one reason: this page ships about 3.3 MB of Korean webfonts
 * and a background image as separate files. Caching those makes a second
 * visit -- and every launch of the installed app -- open immediately instead
 * of re-fetching them, which matters on a phone and matters more on a free
 * host that spins down when idle.
 *
 * What it deliberately does NOT do:
 *
 *   - It never caches HTML. The pages sit behind a password gate, and a
 *     cached page would keep rendering after a session ends. Always network.
 *   - It never caches API responses. Signup counts and admin data must be
 *     live, and stale contact data is worse than none.
 *   - It never caches anything cross-origin, so a CDN outage cannot poison
 *     the cache with an error page.
 *
 * Scope is a safety net here rather than a rule to remember: registered from
 * /a/cdots/, this worker can only ever intercept requests under /a/cdots/.
 * The API lives at /api/v1/ and is structurally out of reach.
 */

// Bump to retire the previous cache. The activate handler deletes anything
// that is not this exact name, so a stale asset cannot outlive a deploy.
const CACHE = 'cdots-assets-v1';

/** Only these are worth storing, and only these are safe to store. */
const CACHEABLE = /\.(?:ttf|otf|woff2?|png|jpe?g|webp|avif|gif|svg|css)$/i;

self.addEventListener('install', (event) => {
  // Take over as soon as the new worker is ready rather than waiting for
  // every tab to close; there is no cross-version state to protect.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only plain GETs are cacheable; anything else is a state change.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Belt and braces: the scope already excludes these, but saying so here
  // means the intent survives someone later moving the worker.
  if (url.pathname.includes('/api/')) return;
  if (!CACHEABLE.test(url.pathname)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;

      const response = await fetch(request);
      // Only store a genuine success. An opaque or error response cached here
      // would be served back as though it were the real asset.
      if (response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
