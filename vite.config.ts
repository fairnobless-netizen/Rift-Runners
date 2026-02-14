import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';

  return {
    plugins: [
      react(),
      ...(isProduction
        ? [
            VitePWA({
              registerType: 'autoUpdate',
              injectRegister: false,
              manifest: {
                name: 'Rift Runners',
                short_name: 'RiftRunners',
                start_url: '.',
                display: 'standalone',
                background_color: '#111827',
                theme_color: '#111827',
                icons: [],
              },
              workbox: {
                runtimeCaching: [
                  {
                    urlPattern: /^\/assets\/.*$/,
                    handler: 'CacheFirst',
                    options: {
                      cacheName: 'assets-cache',
                      cacheableResponse: {
                        statuses: [0, 200],
                      },
                      expiration: {
                        maxEntries: 200,
                        maxAgeSeconds: 60 * 60 * 24 * 30,
                      },
                    },
                  },
                  {
                    urlPattern: /^\/api\/.*$/,
                    handler: 'NetworkFirst',
                    options: {
                      cacheName: 'api-cache',
                      networkTimeoutSeconds: 5,
                      cacheableResponse: {
                        statuses: [0, 200],
                      },
                      expiration: {
                        maxEntries: 50,
                        maxAgeSeconds: 60 * 60 * 24,
                      },
                    },
                  },
                ],
              },
            }),
          ]
        : []),
    ],
  };
});
