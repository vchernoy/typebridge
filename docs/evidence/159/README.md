# #159 S6 verification evidence

Honest matrix for the in-tab split workspace (S1–S5b on `main`). This folder records what was run and what was **not**. It does not close #159 by itself.

## Automated Playwright matrix (agent VM)

Command (after `npm run build`):

```bash
npx playwright test e2e/split-pane.spec.ts e2e/split-dual-document.spec.ts \
  --project=chromium --project=firefox --project=webkit
```

| Date (UTC) | Host | Result |
| --- | --- | --- |
| 2026-11-05 | Cursor cloud agent VM | **147 passed** (~2.7 m): 49 split tests × Chromium + Firefox + WebKit |

Coverage relative to #159 acceptance items 1–8 (split/close, Autosave-off privacy, dual documents, local Edit-in-this-pane, dirty/ownership close, delayed-command guards, cross-tab ownership notices, keyboard divider / responsive hooks) is exercised by those suites plus earlier W2–W4 specs (`e2e/comparison-window.spec.ts`, `e2e/saved-signals.spec.ts`, `e2e/edit-ownership.spec.ts`). Reload / pending / recovery / storage-error paths remain covered by existing `e2e/recovery.spec.ts`, `e2e/offline.spec.ts`, `e2e/persistence-regressions.spec.ts` and related suites — re-run on the PR’s final head in CI, not only locally.

## Layout screenshots (synthetic viewports)

Captured with `scripts/capture-159-evidence.mjs` against `vite preview` (Chromium). Not a substitute for a physical phone or OS theme session.

| File | Viewport | Theme |
| --- | --- | --- |
| [desktop-light-split.png](desktop-light-split.png) | 1280×800 | light |
| [desktop-dark-split.png](desktop-dark-split.png) | 1280×800 | light→dark `colorScheme` |
| [phone-light-stacked.png](phone-light-stacked.png) | 390×844 | light (stacked panes) |
| [phone-dark-stacked.png](phone-dark-stacked.png) | 390×844 | dark (stacked panes) |

## Explicit non-claims (manual / production)

The following were **not** performed in this S6 pass. Do not treat CI or these screenshots as evidence for them:

- Real phones/tablets (iOS Safari, Android Chrome), orientation change, software keyboard, or tab discard.
- Real IME composition on device keyboards (Playwright composition stubs only).
- Screen readers (VoiceOver, NVDA, TalkBack) or other assistive technology sessions on the split UI.
- Production Pages deploy smoke after this merge, offline install on a user device, or update/reload against a live host.
- Closing #11 / U10 manual AT checklist, or claiming production-verified shipping for #159.

Record device/browser/AT versions and concrete results on #159 (or #11) when those sessions happen.

## Remaining product gaps (not S6 failures)

Tracked separately; S6 does not claim them done:

- S2 primary `DocumentSession` extraction out of `main.ts` is still partial (#166 / ADR).
- New document / Import targeting pane B.
- Cross-window Edit here (#164 draft) remains deferred.
- Broader #48 editor-list refresh and related preference signals.
