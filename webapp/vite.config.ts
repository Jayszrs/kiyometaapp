import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { createHash } from 'node:crypto'

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'offline-app-shell',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).map(name => `/${name}`);
      const version = createHash('sha256').update(assets.join('|')).digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'offline-sw.js', source: `
const CACHE = 'kiyometa-shell-${version}';
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...ASSETS, '/']))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('kiyometa-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then(cache => cache.match('/'))));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname)).then(cached => cached || fetch(event.request)));
  }
});` });
    },
  }],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ocr': 'http://127.0.0.1:8787',
      '/log': 'http://127.0.0.1:8787',
    },
  },
})
