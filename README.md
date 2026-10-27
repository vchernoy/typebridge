# TypeBridge

TypeBridge is a planned open-source, browser-based transliteration editor. Its first target is Russian; its architecture is intended to support other languages and rule sets. Transliteration changes writing systems, not the meaning of text.

**Status:** planning and test infrastructure; the editor is not implemented yet.

- [Product requirements](docs/PRD.md)
- [Competitor research](docs/RESEARCH.md)
- [Architecture](docs/ARCHITECTURE.md)
- [UI specification](docs/UI.md)
- [Implementation backlog](docs/BACKLOG.md)

The initial release is planned to run entirely in the browser, without an account or server. See the PRD for explicit local-storage and privacy choices. MIT licensed; see [LICENSE](LICENSE).

## Development

Requires Node.js 22.13 or later in the Node 22 line (or Node 24 or later) and npm. Run `npm ci`, then `npm run dev` to start the local Vite server. The editor is not implemented yet.

Before opening a pull request, run `npm run lint`, `npm run typecheck`, `npm run test:unit`, and `npm run build`. Install the Playwright Chromium browser with `npx playwright install chromium`, then run `npm run test:e2e`. The browser test serves the production build at `/typebridge/`, matching the future GitHub Pages project path. Pages deployment remains disabled until the app is ready.

