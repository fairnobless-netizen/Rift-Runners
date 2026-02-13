# PWA cache strategy

This project uses `vite-plugin-pwa` in **production builds only**.

## What is cached

### Precache (build-time)
Workbox precache includes generated frontend artifacts and static files matched by:

- `**/*.{js,css,html,ico,png,svg,webp,woff,woff2,ttf,eot,json,mp3,ogg,wav,glb,gltf}`
- `includeAssets: ['assets/sprites/*.svg']`

This covers UI bundles and game assets in `public/assets/...`.

### Runtime caching

1. `^/api/` → `NetworkFirst`
   - `cacheName: api-cache`
   - `networkTimeoutSeconds: 10`
   - `cacheableResponse.statuses: [0, 200]`
   - `expiration.maxEntries: 100`
   - `expiration.maxAgeSeconds: 300`

2. `^/assets/` → `CacheFirst`
   - `cacheName: assets-cache`
   - `cacheableResponse.statuses: [0, 200]`
   - `expiration.maxEntries: 500`
   - `expiration.maxAgeSeconds: 2592000` (30 days)

> Dynamic API data is intentionally **not** cached with `CacheFirst`.

## Registration behavior

Service Worker registration is enabled only when `import.meta.env.PROD` is true.
No SW registration happens in development.

## How to verify (production preview)

1. Build and preview:
   - `pnpm build`
   - `pnpm preview`
2. Open the app in browser DevTools:
   - Application → Service Workers: confirm active SW.
   - Application → Cache Storage: after navigation/API calls, check `assets-cache` and `api-cache`.
3. Trigger `/api/*` requests and verify they remain network-driven (NetworkFirst) and expire quickly.

## How to clear caches locally

In DevTools (Application tab):

- Service Workers → **Unregister**
- Storage → **Clear site data**
- Cache Storage → delete `assets-cache` and `api-cache`

## How SW updates are delivered

`registerType: 'autoUpdate'` is enabled.
On a new deployment, the updated SW is fetched and activated automatically; old cache entries are rotated according to Workbox expiration rules.

## npm/pnpm 403 fallback (no vendoring in main)

If registry access fails with HTTP 403 in local/corporate environments:

1. Set/verify registry:
   - `pnpm config set registry https://registry.npmjs.org/`
   - (or your allowed corporate mirror)
2. Retry from a network/VPN that has registry access at least once to warm local store.
3. Optionally prefetch on a machine with access and transfer the pnpm store:
   - `pnpm fetch`
   - copy the pnpm store to the restricted machine, then run install offline if supported by your setup.

Do **not** commit vendored `vite-plugin-pwa` (or `vendor/`) into main for this fallback.
Use a separate temporary branch/PR only if absolutely required and explicitly approved.
