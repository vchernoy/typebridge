/** Separate pre-merge POC artifact. Never loads production Vite/Pages configuration. */
import { build } from 'vite';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const outDir = resolve('dist-standalone');
const packages = new Set();
async function bundle(entry) {
  const result = await build({ configFile: false, publicDir: false, logLevel: 'warn', plugins: [{ name: 'standalone-license-inventory', generateBundle(_, output) {
    for (const chunk of Object.values(output)) if (chunk.type === 'chunk') for (const id of Object.keys(chunk.modules)) {
      const match = id.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/);
      if (match) packages.add(match[1]);
    }
  } }], build: { write: false, sourcemap: false, cssCodeSplit: false, assetsInlineLimit: Infinity,
    lib: { entry, name: 'StandaloneViewer', formats: ['iife'] }, minify: true,
    rolldownOptions: { output: { codeSplitting: false } },
  } });
  const output = (Array.isArray(result) ? result.flatMap(item => item.output) : result.output);
  // Rolldown may list the IIFE itself for an inlined dynamic import; reject actual
  // external targets and any remaining import() expression, not that self metadata.
  const chunks = output.filter(item => item.type === 'chunk');
  const assets = output.filter(item => item.type === 'asset');
  if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.some(file => file !== chunks[0].fileName) || /\bimport\s*\(/.test(chunks[0].code) || assets.some(item => !item.fileName.endsWith('.css'))) throw new Error('Standalone build emitted an external dependency: '+JSON.stringify(output.map(item=>({file:item.fileName,type:item.type,imports:item.imports,dynamic:item.dynamicImports}))));
  const css = assets.map(item => String(item.source)).join('\n');
  if (/url\(\s*["']?(?!data:|#)/i.test(css.replace(/url\(["']?data:[^)]+\)/gi, ''))) throw new Error('External CSS URL');
  return { js: chunks[0].code.replace(/<\/script/gi, '<\\/script'), css: css.replace(/<\/style/gi, '<\\/style') };
}
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
async function notices() {
  const texts = ['TypeBridge\n' + await readFile('LICENSE', 'utf8'), 'Fira Math 0.3.4\n' + await readFile('public/fonts/FiraMath-OFL.txt', 'utf8')];
  for (const name of [...packages].sort()) {
    const root = join('node_modules', name);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const files = (await readdir(root)).filter(file => /^(licen[cs]e|copying)([.-].*)?$/i.test(file));
    if (!files.length) {
      // remark-math6 omits the monorepo license from its npm tarball. Vendored
      // upstream notice: https://github.com/remarkjs/remark-math/blob/main/license
      if (name !== 'remark-math' || pkg.version !== '6.0.0') throw new Error('Missing bundled license: ' + name);
      texts.push(`${name}@${pkg.version}\n` + await readFile('scripts/standalone-licenses/remark-math-6.0.0.txt', 'utf8'));
      continue;
    }
    texts.push(`${name}@${pkg.version} (${pkg.license ?? 'see license'})\n` + (await Promise.all(files.map(file => readFile(join(root, file), 'utf8')))).join('\n'));
  }
  return escape(texts.join('\n\n----------------\n\n'));
}
const viewer = await bundle('src/standalone/viewer.ts');
const demo = await bundle('src/standalone/demo.ts');
const licenses = await notices();
const style = 'body{margin:1rem auto;max-width:72rem;padding:0 1rem;font:16px/1.5 system-ui;color:#202532;background:#fff}h1{overflow-wrap:anywhere}pre,textarea{white-space:pre-wrap;overflow-wrap:anywhere}textarea{box-sizing:border-box;width:100%;min-height:20rem}button,input,select{font:inherit}button{padding:.5rem 1rem}#document{padding:0}details{margin-block:1rem}#notices pre{font-size:12px}';
function html(js, css, body, title) {
  const hash = createHash('sha256').update(js).digest('base64');
  const csp = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${title}</title><style>${style}\n${css}</style></head><body>${body}<script>${js}</script></body></html>`;
}
const slot = '<script id="standalone-data" type="application/octet-stream">TYPEBRIDGE_STANDALONE_DATA_V1</script>';
const template = html(viewer.js, viewer.css, `<h1 id="title"></h1><button id="reset" hidden>Reset inputs</button><p id="status" role="status"></p><main id="document" class="active-reading"></main><details id="notices"><summary>Licenses and notices</summary><pre>${licenses}</pre></details>${slot}`, 'Standalone document template');
if (template.split(slot).length !== 2) throw new Error('Ambiguous data placeholder');
const demoHtml = html(demo.js, demo.css, `<h1>Standalone HTML export prototype</h1><p>Offline browser-only proof of concept; no TypeBridge storage or editor integration. Source defaults are exported, not saved reader inputs. Open the downloaded HTML locally.</p><p><label>Title <input id="title" value="Offline calculator" maxlength="150"></label> <label>Format <select id="format"><option value="markdown">Markdown</option><option value="plain">Plain text</option></select></label></p><label>Document source<textarea id="source"></textarea></label><p><button id="download">Download standalone HTML</button></p><p id="status" role="status"></p><script id="template" type="application/octet-stream">${Buffer.from(template).toString('base64')}</script>`, 'Standalone export prototype');
await mkdir(outDir, { recursive: true });
for (const [name, text] of [['viewer-template.html', template], ['export-demo.html', demoHtml], ['README.txt', 'Open export-demo.html locally. Paste a document and download document.html. The same prebuilt template serves multiple documents. No production Pages/editor integration. Inputs start at authored defaults; no reader sidecars, edit/history, images, networking or quiz attempts are exported. Assets and license notices are embedded. See docs/STANDALONE-EXPORT.md.']]) await writeFile(join(outDir, name), text);
await writeFile(join(outDir, 'README.md'), await readFile('docs/STANDALONE-EXPORT.md', 'utf8'));
process.stdout.write(JSON.stringify({ templateBytes: Buffer.byteLength(template), demoBytes: Buffer.byteLength(demoHtml), bundledPackages: packages.size }) + '\n');
