import { defineConfig, type Plugin } from 'vite';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

function offlineServiceWorker(): Plugin {
  return {
    name: 'typebridge-offline',
    apply: 'build',
    async closeBundle() {
      const root = 'dist';
      const assets: string[] = [];
      async function visit(dir: string): Promise<void> {
        for (const item of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, item.name);
          if (item.isDirectory()) await visit(full);
          else if (item.isFile() && !item.name.endsWith('.map') && item.name !== 'sw.js') {
            assets.push('/typebridge/' + relative(root, full).replaceAll('\\', '/'));
          }
        }
      }
      await visit(root);
      assets.sort();
      const hash = createHash('sha256');
      for (const path of assets) {
        hash.update(path);
        hash.update(await readFile(join(root, path.slice('/typebridge/'.length))));
      }
      const version = hash.digest('hex').slice(0, 16);
      const worker = `const CACHE = 'typebridge-${version}';
const ASSETS = ${JSON.stringify(assets)};
const HOME = '/typebridge/';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('typebridge-') && key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  if (!url.pathname.startsWith(HOME)) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(HOME + 'index.html')) || Response.error();
    }));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});`;
      await writeFile(join(root, 'sw.js'), worker);
    },
  };
}

export default defineConfig({
  base: '/typebridge/',
  plugins: [offlineServiceWorker()],
});
