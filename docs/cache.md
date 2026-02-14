# PWA cache (vNext, release-safe)

This project enables `vite-plugin-pwa` **only for production builds**.
In dev (`pnpm dev`), Service Worker is not registered and does not interfere with local development.

## Runtime cache strategy

Configured in `vite.config.ts`:

1. `^/assets/.*` → `CacheFirst`
   - `cacheName: assets-cache`
   - `expiration.maxAgeSeconds: 2592000` (30 days)
   - `expiration.maxEntries: 200`

2. `^/api/.*` → `NetworkFirst`
   - `cacheName: api-cache`
   - `networkTimeoutSeconds: 5`
   - `expiration.maxAgeSeconds: 86400` (1 day)
   - `expiration.maxEntries: 50`

Workbox precache is generated automatically for build artifacts (including JS/CSS/HTML chunks).

## Minimal web app manifest

Manifest values used by PWA plugin:

- `name: Rift Runners`
- `short_name: RiftRunners`
- `start_url: .`
- `display: standalone`
- `background_color: #111827`
- `theme_color: #111827`
- `icons: []` (placeholder to avoid blocking release on binary icon assets)

## How to verify Service Worker is active

1. Build production:
   - `pnpm build`
2. Preview production build:
   - `pnpm preview`
3. Open app in Chrome and go to DevTools:
   - **Application → Service Workers**
   - Confirm SW is installed and activated.

## How to inspect caches

In DevTools:

- **Application → Cache Storage**
- Verify these entries appear after usage:
  - `assets-cache`
  - `api-cache`
  - `workbox-precache-*`

## Hard reset (clear SW + caches)

In DevTools (Application tab):

1. **Service Workers → Unregister**
2. **Storage → Clear site data**
3. Optionally remove remaining entries under **Cache Storage**

Then hard refresh page.

## Offline check scenario

1. Open app once while online (let UI/assets/API warm caches).
2. In DevTools → Network, enable **Offline**.
3. Reload page.
4. Confirm:
   - UI shell still loads.
   - `/assets/*` files are served from cache (no crash).
   - `/api/*` uses `NetworkFirst`: returns cached response when available, otherwise shows offline state gracefully (without app crash).
