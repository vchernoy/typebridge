# TypeBridge

TypeBridge is an open-source, local-first browser text editor with optional Russian transliteration. Write plain text or type `privet` to get `привет`; transliteration changes writing systems, not meaning. No account, backend, analytics or text uploads. MIT licensed; see [LICENSE](LICENSE).

## Current capabilities

Implemented on `main`: live transliteration and literal input; selected-text conversion in both directions; custom mapping rules with JSON import/export; Find & Replace with optional regex; Undo/Redo saved with drafts; draft creation, naming and deletion; TXT/JSON backup and import; Focus Mode; resizing; word/character counts and system light/dark appearance.

Drafts and history use IndexedDB. Settings use localStorage; tab selection and Find/Replace strings use sessionStorage. Revision checks preserve conflicting tab edits as copies. With autosave enabled, a temporary recovery journal helps recover interrupted edits. These are browser-local copies, subject to quota, eviction and browser lifecycle limits: export important work. See [architecture](docs/ARCHITECTURE.md) and [settings lifetimes](docs/SETTINGS-PERSISTENCE.md).

After a successful online service-worker installation, the production build can reopen offline on the same origin and browser profile. Offline support does not guarantee storage durability. A new independent tab currently opens the latest saved draft; reload uses the tab's selected draft when available. Older blank-tab requirements are historical, not the current behavior.

GitHub Pages deployment is enabled for main. Successful Actions deployment is not proof of every production interaction; record browser/device checks separately. PRs are not automatically hosted previews. See [preview and deployment notes](docs/PREVIEW.md).

## Development

Use Node.js 22.13+ in the Node 22 line, or Node 24+, and npm. Run `npm ci`, then `npm run dev` and open `/typebridge/` at the URL Vite prints.

Before a PR, run `npm run lint`, `npm run typecheck`, `npm run test:unit`, and `npm run build`. Install browsers with `npx playwright install chromium firefox webkit` (Linux may need `--with-deps`), then run `npm run test:e2e`. Playwright tests the production build under `/typebridge/` in Chromium, Firefox and WebKit. See [editor behavior and manual test limits](docs/EDITOR-BEHAVIOR.md); Linux WebKit is not real Safari/iOS testing.

## Requirements and remaining work

- [Product roadmap](docs/ROADMAP.md) and [GitHub backlog](docs/BACKLOG.md)
- [Original product requirements](docs/PRD.md) and [UI design intent](docs/UI.md)
- [Russian mappings](docs/RUSSIAN-MAPPING.md) and [competitor research](docs/RESEARCH.md)
- [Audit and AI handoff](https://github.com/vchernoy/typebridge/issues/71)

The PRD/UI specification include future design intent. Dual panels, portable document links, rich/Markdown preview, retained version snapshots and broader editing commands are not implemented just because they appear there. Current UX work and the audit fixes are tracked in issues; check PR merge and production verification separately.
