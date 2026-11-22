# Standalone interactive HTML (#386)

**In the editor:** Documents → **Export as interactive HTML** downloads one
self-contained `<title>.html` file. It opens from disk in any modern browser,
works offline, and keeps the document's controls, calculations and math live.
Readers start from the calc defaults: values entered in Preview are not included
(the maintainer-approved first policy; a snapshot option can follow later).

How it is published: `npm run build` first runs `scripts/build-standalone.mjs`,
then the normal Vite build emits its viewer template as `/standalone-template.html`
(about 0.8 MB). The offline service worker does **not** precache it; it is cached
on first use, like the renderer, so the first export needs a connection and later
exports work offline. Export fills the template's inert data slot in the browser
(`src/standalone/document.ts`); nothing is uploaded. If the template cannot be
loaded, or the response is not the viewer (for example a fallback page), the
editor says so, removes that response from the offline cache and downloads nothing;
a document over 2 MB gets its own message. During development, `npm run dev` serves
the template from `dist-standalone/` after `npm run build:standalone-viewer`, and
answers 404 with that instruction until then.

The rest of this page describes the original proof of concept, its build and
safety model, which the product route reuses unchanged.

## Try the PR artifact

1. Open the PR's **Standalone HTML prototype** Actions run. Require a successful
   `offline-artifact` job; a failed run may still upload diagnostic files.
2. Download `standalone-html-prototype`, extract it, and open
   `dist-standalone/export-demo.html` in your browser by double-click (`file://`).
3. Keep the supplied Markdown/calc/slider/math example, or paste another document.
   Choose a title and Markdown or Plain text, then **Download standalone HTML**.
4. Open the downloaded `document.html` locally. Disconnect networking: its controls
   and math must still update; **Reset inputs** restores the authored defaults.
5. Return to the same demo tab, change the text/format and download another file.
   The two files must show their own content; no Vite/CI rebuild occurs per document.

The artifact contains a template and an export harness. Each **downloaded document**
is exactly one self-contained HTML file; it does not need the harness/template to
remain alongside it. The template contains no recipient document at build time.
The demo's initial example is only a starting value in its editable textarea.

## Build and test separately

```sh
npm ci
npm run build:standalone-viewer
npm run test:standalone -- --workers=1
```

The separate PR/manual workflow uses the locked Playwright container for Chromium,
Firefox and WebKit. `workflow_dispatch` becomes discoverable after the workflow is
on the default branch; the initial branch is tested via `pull_request`. It has no
Pages/deployment/write permissions. The normal required quality/three-browser CI
is preserved in full, and no production checks are bypassed.

Local Linux browsers need their usual Playwright system dependencies. A missing
WebKit shared library is a launch limitation, not a passing offline test. Hosted
container results remain mandatory before accepting the POC. WebKit results do not
claim physical Safari/macOS/iOS or real-device verification.

## Architecture and safety

- Existing Vite library/IIFE mode, `cssCodeSplit:false`, inlined assets and
  `configFile:false`/`publicDir:false`. A separate Node build script writes only
  `dist-standalone`; it never loads production's offline-service-worker plugin.
- Build fails on external imports, residual `import()` expressions, unexpected
  asset files or external CSS URLs. Rolldown can label an already inlined dynamic
  import with the IIFE's own filename; this self metadata is allowed only with no
  actual import expression or separate target/chunk.
- The existing `renderDocument` supplies ActiveMD parser/calc/runtime, KaTeX,
  optional control styles and Fira Math. The resulting template embeds JS/CSS/font;
  default MathML output uses the embedded Fira MATH font, not KaTeX HTML font assets;
  there are no required workers, WASM, remote fonts or secondary files.
- Browser export UTF-8 encodes bounded JSON and places **base64 only** inside an
  inert data script. Source containing `</script>`, HTML, Unicode or replacement
  tokens never enters executable markup. On load, source passes through the normal
  sanitized Markdown renderer; plain text uses `textContent`. The title also uses
  `textContent`. Data size is capped at 2 MB UTF-8 and title at 150 characters.
- A hash-based executable-script CSP disables network connections, workers,
  objects, forms and external assets. CSS is inline (including runtime math styles),
  and fonts/images permit data URLs only. Source HTML is still sanitized; CSP is
  defence in depth, not permission to render author HTML or JavaScript.
- No editor, IndexedDB, local/session-storage, service worker, history, source
  ownership or application network path is imported. Ordinary external links are
  deliberate new-tab actions. Images keep ActiveMD's link-only default.
- License notices are embedded in every exported file. Build inventories bundled
  npm modules by their actual package roots, retaining nested installs and distinct
  versions; it does not substitute a top-level package with the same name. Notices
  include their license texts, TypeBridge MIT and Fira Math OFL.
  `remark-math@6.0.0` omits its monorepo license from the npm tarball: a matching
  upstream MIT notice (Junyoung Choi) is vendored under `scripts/standalone-licenses`.
  Missing notices for other packages or a changed fallback version fail the build.

## Evidence and limits

Initial local output: viewer template **764,360 bytes**, export harness
**1,022,524 bytes**, 89 bundled npm package notices. Rebuild output is measured by
`build:standalone-viewer`; the size is not a product download budget guarantee.

The offline tests download two distinct documents through the real browser Blob
flow, reopen those downloads via `file://`, exercise slider → value/math updates
and Reset, verify the embedded font face loads, and preserve exact hostile-looking
source/Unicode without script execution. They reject HTTP(S) request attempts,
storage writes/IndexedDB opens and uncaught page errors. Plain text is checked for
literal round-trip. Small unit tests cover payload bounds, invalid UTF-8, safe slot
substitution and reuse of the same immutable template.

Per-engine `standalone-metrics` JSON attachments report exported byte size,
first-content/math-ready elapsed time and Chromium's exposed JS heap estimate when
available (`null` elsewhere). These are synthetic fixture observations, not a
benchmark: elapsed time includes file navigation/rendering and test-driver overhead;
heap readings are browser estimates, not process RSS or incremental document cost.
No comparison, mobile performance or assistive-technology claim is made.

POC exports **source/default values**, not current reader input snapshots or editor
state. The existing source, local sidecars and share codec are unchanged. Reset
restores calc defaults; closing/reopening an export does not persist reader changes.
Hidden branches and calc definitions remain in the embedded source; hiding content
is not access control. Complete quizzes, future collections/charts and external media
are not added. The template bundles the ActiveMD version TypeBridge pins (0.6.2, which
adds heading anchors and matching footnote ids); unpublished upstream fixes are not
silently bundled.

After this prototype is reviewed and its downloadable artifact works offline,
a separate product-integration slice can decide current-input snapshot policy,
add **Export → Standalone HTML**, and publish/cache a versioned template through
the normal checked-artifact Pages deployment. This PR does not enable that route or
change production hosting.
