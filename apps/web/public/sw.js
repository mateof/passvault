/*
 * The service worker.
 *
 * One rule matters more than the rest and everything else follows from it: **nothing from the API
 * is ever cached**. This application exists so that a barcode reaches one person at one moment and
 * leaves as little behind as possible. A cache holding a `/api/v1/tickets/:id/barcode` response
 * would be a copy of a bearer token written to disk, surviving the tab, the sign-out and the
 * vault being locked — undoing the reason the code is not in the ticket list in the first place.
 * So `/api/` is network-only, always, and an offline device is told so rather than shown a
 * plausible answer from last week.
 *
 * What is cached is the shell: the HTML, the JavaScript, the stylesheet, the barcode
 * WebAssembly. Those are the same bytes for everybody, they carry nothing, and they are exactly
 * what a venue's network fails to deliver. A ticket already on screen stays on screen when the
 * signal goes; with this, the page also still *opens* — which is the difference between a queue
 * at a gate and standing aside to reload.
 *
 * Runtime caching rather than a precomputed manifest. Asset names are content-hashed by the
 * build, so a hand-written list would be wrong the moment anything changed, and a build step to
 * generate one is a dependency to carry for a file this size. The cost is that the very first
 * visit is not offline-ready. The benefit is that this file has no relationship with the build.
 */

const VERSION = 'v1'
const SHELL = `passvault-shell-${VERSION}`
const ASSETS = `passvault-assets-${VERSION}`

self.addEventListener('install', (event) => {
  // The shell, so the first navigation after a lost network has something to render.
  event.waitUntil(caches.open(SHELL).then((cache) => cache.add('/')))
  // No waiting: a new worker that sat idle until every tab closed would mean shipping a fix and
  // watching people run the old one for a week.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, ASSETS])
      for (const name of await caches.keys()) {
        if (name.startsWith('passvault-') && !keep.has(name)) {
          await caches.delete(name)
        }
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  // Someone else's origin, or a write. Neither is ours to hold on to.
  if (url.origin !== self.location.origin || request.method !== 'GET') {
    return
  }

  // The line this whole file is written around.
  if (url.pathname.startsWith('/api/')) {
    return
  }

  // A navigation: the shell, from the network when there is one and from the cache when there is
  // not. Network first, because a stale shell is how a deployed fix fails to arrive.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request)
          const cache = await caches.open(SHELL)
          await cache.put('/', fresh.clone())
          return fresh
        } catch {
          const cached = await caches.match('/', { cacheName: SHELL })
          if (cached) {
            return cached
          }
          throw new Error('offline and no shell cached')
        }
      })(),
    )
    return
  }

  // Build output: content-hashed, so a hit is never stale and the network round trip is pure
  // latency. Cache first, and fill the cache behind the answer.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request, { cacheName: ASSETS })
        if (cached) {
          return cached
        }
        const fresh = await fetch(request)
        if (fresh.ok) {
          const cache = await caches.open(ASSETS)
          await cache.put(request, fresh.clone())
        }
        return fresh
      })(),
    )
  }
})
