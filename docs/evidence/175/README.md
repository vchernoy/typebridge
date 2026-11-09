# #175 step 11 verification evidence

Packaging for movable editor windows on `/host.html` (steps 1–10 on `main`, plus step-11 must-ship a11y). Mirror honesty of [#159 S6](../159/README.md): do **not** treat this folder as real-device, real-AT, real-IME, or production Pages evidence.

## Automated Playwright matrix (agent VM)

Host / handoff / ownership / find suites (after `npm run build`):

```bash
npx playwright test \
  e2e/host-window.spec.ts \
  e2e/host-layout-mode.spec.ts \
  e2e/host-shared-settings.spec.ts \
  e2e/host-find.spec.ts \
  e2e/host-a11y-windows.spec.ts \
  e2e/document-names.spec.ts \
  e2e/window-identity.spec.ts \
  e2e/edit-ownership.spec.ts \
  e2e/saved-signals.spec.ts \
  e2e/comparison-window.spec.ts \
  --project=chromium --project=firefox --project=webkit
```

Step-11 must-ship a11y (F6 cycle, named regions, Escape Settings-over-Find, Focus F6 maximize/close restore, title/chrome cycle origin, reload z-order, close marks remaining current) lives in `e2e/host-a11y-windows.spec.ts` (**12** tests). Prefer Chromium for local iteration; CI still runs the three-engine matrix on PRs.

| Date (UTC) | Host | Result |
| --- | --- | --- |
| 2026-11-05 | Cursor cloud agent VM | **34 passed** Chromium on head with 12 `host-a11y-windows` + `host-window` (17) + `host-layout-mode` (5). Full three-engine matrix is CI’s job on the PR. |

## Acceptance 1–10 mapped to suites

From the [#175](https://github.com/vchernoy/typebridge/issues/175) acceptance list. **Covered** means automated Playwright exercises the behavior; **partial** means some paths exist but gaps remain (often real IME / multi-tab / production).

| # | Acceptance (summary) | Status | Suites / notes |
| --- | --- | --- | --- |
| 1 | Two windows, different docs: typing / rename / Undo / Convert / Find / Copy / Go to line stay local | Covered (partial Convert/Go-to depth) | `host-window`, `host-find`, `document-names`, `host-shared-settings` |
| 2 | Same doc, two windows: click read-only → type; handoff; one Undo; no conflict copy | Covered | `edit-ownership`, host handoff paths in window specs |
| 3 | Same as 2 across two real tabs | Covered | `edit-ownership`, `comparison-window`, `saved-signals` |
| 4 | Autosave off: same-tab in-memory handoff; cross-tab never sends text + Edit here | Covered | `edit-ownership`, `host-shared-settings` (Autosave shared) |
| 5 | Handoff during IME / in-flight save / failed save / suspended owner | Partial | Composition stubs and steal paths in unit/e2e; **not** real-device IME |
| 6 | Reload restores layout + doc ids, never private text; per-window recovery | Covered (partial recovery depth) | `host-window`, `host-layout-mode`, recovery specs |
| 7 | Settings change applies to all windows | Covered | `host-shared-settings` |
| 8 | Window manager: mouse/keyboard move/resize, snap, tile, min size, close consent, viewport clamp | Covered | `host-window`, `host-layout-mode` |
| 9 | Phone stacked (390 / 320), height grip, no horizontal overflow | Covered (synthetic viewport) | `host-layout-mode` — not a physical phone |
| 10 | Unique IDs/labels per window; announcements not duplicated | Covered (partial live-region depth) | `host-a11y-windows` (regions + titles), `document-names`, `window-identity` |

Step-11 extras (must-ship a11y, not numbered in 1–10): **F6** cycles windows (`host-a11y-windows`), including from the host title / move handle and while host Focus is on (next window maximized; non-active restored from pre-Focus geometry; Focus-close restores tiled rects); host shells are **`role="region"`** with `aria-label` = document title and `aria-current` on the active shell; Escape closes host Settings before Find when both are open; F6 is ignored while a confirm modal is open; reload keeps the front window’s z-order.

## Layout screenshots (synthetic viewports)

Captured with `scripts/capture-175-evidence.mjs` against `vite preview` (Chromium). Not a substitute for a physical phone or OS theme session.

| File | Viewport | Theme | Layout |
| --- | --- | --- | --- |
| [desktop-light-tiled.png](desktop-light-tiled.png) | 1280×800 | light | free, tiled side-by-side |
| [desktop-dark-tiled.png](desktop-dark-tiled.png) | 1280×800 | dark | free, tiled side-by-side |
| [phone-light-stacked.png](phone-light-stacked.png) | 390×844 | light | stacked |
| [phone-dark-stacked.png](phone-dark-stacked.png) | 390×844 | dark | stacked |

## Explicit non-claims (manual / production)

The following were **not** performed in this step-11 pass. Do not treat CI or these screenshots as evidence for them:

- Real phones/tablets (iOS Safari, Android Chrome), orientation change, software keyboard, or tab discard.
- Real IME composition on device keyboards (Playwright composition stubs only).
- Screen readers (VoiceOver, NVDA, TalkBack) or other assistive technology sessions on the host window UI — named regions + F6 are automated structure checks only.
- Production Pages deploy smoke after this merge, offline install on a user device, or update/reload against a live host.
- Closing #11 / U10 manual AT checklist, or claiming production-verified shipping for #175.

Record device/browser/AT versions and concrete results on #175 (or #11) when those sessions happen.

## Remaining product gaps (not packaging failures)

Tracked on #175 comments / linked issues; step 11 does not claim them done:

- ~~Cutover of standalone `/` to the host entry.~~ Done: `/` is the host; the single editor is `/editor.html`.
- Broader delayed-command / recovery depth beyond existing suites.
- Real-device / IME / AT / production smoke sessions (list above).
- Cross-window Edit here (#164 draft) remains deferred.
- Broader #48 editor-list refresh and related preference signals.
