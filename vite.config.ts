import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['assets/sprites/*.svg'],
      manifest: {
        name: 'Rift Runners',
        short_name: 'RiftRunners',
        start_url: '/',
        display: 'standalone',
        background_color: '#111827',
        theme_color: '#111827',
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2,ttf,eot,json,mp3,ogg,wav,glb,gltf}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.indexOf('/api/') === 0,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 10,
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 300,
              },
            },
          },
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.indexOf('/assets/') === 0,
            handler: 'CacheFirst',
            options: {
              cacheName: 'assets-cache',
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
            },
          },
        ],
      },
    }),
  ],
});
