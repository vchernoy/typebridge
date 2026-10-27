# Architecture

## Platform
Static TypeScript application, built with Vite, rendered in semantic vanilla HTML and CSS, hosted under GitHub Pages project path `/typebridge/`. No backend. Set Vite `base` appropriately for deployment and test direct asset loading. Development scripts use `npm ci`, typecheck, Vitest, Playwright and `vite build`; pin dependencies via a committed lockfile when scaffolding.

## Boundaries

- `src/core/`: pure rule compilation, conflict validation and transliteration. Language pack contains id, version, direction, ordered mappings and case/boundary policies; Russian is the first pack. Longest-prefix lookup must resolve overlaps deterministically; reject duplicate input sequences with conflicting outputs and validate empty/unbounded rules.
- `src/editor/`: DOM adapter translating browser `beforeinput`, input, selection and composition events into edits. Do not transform during composition. Browser undo differs across implementations; investigate native editing semantics with Playwright before choosing a method, and document fallback. Maintain caret and selection in UTF-16 offsets; test surrogate pairs and combining characters.
- `src/state/`: typed application state and explicit transitions for modes, draft and settings. Derive output from source, never mutate it independently. Mode switch preserves text and protects destructive changes.
- `src/storage/`: versioned, validated settings and separately opt-in draft in localStorage; catch exceptions and migrate safely. Never overwrite recoverable data on parsing failure. Storage may be unavailable or cleared by browsers; do not promise durability.
- `src/ui/`: accessible controls, layout, theme tokens, resize and clipboard integration; use textContent/value rather than HTML insertion for user input. No third-party scripts or telemetry.

Input processing for live editing needs bounded context around the caret to recognize digraphs, avoid rewriting unrelated text, and reset at boundaries and mode changes. Paste behavior, ambiguous sequences, capitalization, deletion and undo are first-class test cases. Batch conversion is a separate pure operation; reverse transliteration is potentially ambiguous and lossy.

## Quality and deployment
Unit tests cover rules, conflicting mappings, case, Unicode, boundaries, storage validation and migration. Browser tests cover typing, selection, IME where automation permits, clipboard fallback, resize, mobile layout, persistence and keyboard navigation. Manual testing remains necessary for real IMEs, screen readers and mobile devices. CI workflow is staged until the scaffold exists; Pages workflow is manual and must not publish before the application is ready. Enable Pages source “GitHub Actions” in repo settings when deployment is authorized.
