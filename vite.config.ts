import { defineConfig, type Plugin } from 'vite';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const BASE = '/';

function offlineServiceWorker(): Plugin {
  let lazyAssets = new Set<string>();
  return {
    enforce: 'post',
    name: 'typebridge-offline',
    apply: 'build',
    generateBundle(options, bundle) {
      void options;
      const visit = (file: string, found: Set<string>, dynamic: boolean): void => {
        if (found.has(file)) return;
        found.add(file);
        const chunk = bundle[file];
        if (!chunk || chunk.type !== 'chunk') return;
        const metadata = chunk as typeof chunk & { viteMetadata?: { importedCss?: Set<string> } };
        for (const css of metadata.viteMetadata?.importedCss ?? []) found.add(css);
        for (const imported of chunk.imports) visit(imported, found, dynamic);
        if (dynamic) for (const imported of chunk.dynamicImports) visit(imported, found, true);
      };
      const shell = new Set<string>();
      const renderer = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        if (chunk.isEntry) visit(chunk.fileName, shell, false);
        if (chunk.facadeModuleId?.endsWith('/src/view/active-renderer.ts')) visit(chunk.fileName, renderer, true);
      }
      // Shared shell dependencies stay eager; renderer-only modules and CSS load on demand.
      lazyAssets = new Set([...renderer].filter(file => !shell.has(file)));
    },
    async closeBundle() {
      const root = 'dist';
      const assets: string[] = [];
      async function visit(dir: string): Promise<void> {
        for (const item of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, item.name);
          if (item.isDirectory()) await visit(full);
          else if (item.isFile() && !item.name.endsWith('.map') && item.name !== 'sw.js') {
            assets.push(BASE + relative(root, full).replaceAll('\\', '/'));
          }
        }
      }
      await visit(root);
      assets.sort();
      const hash = createHash('sha256');
      for (const path of assets) {
        hash.update(path);
        hash.update(await readFile(join(root, path.slice(BASE.length))));
      }
      const version = hash.digest('hex').slice(0, 16);
      const worker = `const CACHE = 'typebridge-${version}';
const ASSETS = ${JSON.stringify(assets.filter(path => !lazyAssets.has(path.slice(BASE.length))))};
const LAZY = new Set(${JSON.stringify([...lazyAssets].map(file => BASE + file))});
const HOME = ${JSON.stringify(BASE)};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
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
      // \`/\` is the multi-window host; editor windows and the comparison popup use editor.html.
      const path = url.pathname;
      if (path.endsWith('/editor.html') || path.endsWith('/editor')) {
        return (await cache.match(HOME + 'editor.html')) || Response.error();
      }
      if (path.endsWith('/read.html') || path.endsWith('/read')) {
        return (await cache.match(HOME + 'read.html')) || Response.error();
      }
      return (await cache.match(HOME + 'index.html')) || Response.error();
    }));
    return;
  }
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(url.href);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && LAZY.has(url.pathname)) {
      try { await cache.put(request, response.clone()); } catch { /* Rendering still works if the optional asset cache is full. */ }
    }
    return response;
  }));
});`;
      await writeFile(join(root, 'sw.js'), worker);
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [offlineServiceWorker()],
  build: {
    rollupOptions: {
      input: {
        // `/` is the multi-window host; each window (and the comparison popup) is editor.html.
        main: 'index.html',
        editor: 'editor.html',
        host: 'host.html',
        // Share links (#39): `/#doc=…` forwards here.
        read: 'read.html',
      },
    },
  },
});
