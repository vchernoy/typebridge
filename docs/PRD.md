# Product requirements

> Historical design intent, not a current feature inventory. See [README](../README.md), [architecture](ARCHITECTURE.md), [settings lifetimes](SETTINGS-PERSISTENCE.md) and [roadmap](ROADMAP.md) for implemented behavior. Current tabs reopen the latest saved draft (#22), committed drafts/history use IndexedDB (#45), emergency recovery is merged (#53) while recovery hardening and version history remain open (#37), and offline support/Pages deployment are enabled. Blank-new-tab wording and future feature descriptions below have not been implemented literally.


## Goal and audience
Enable someone with a Latin keyboard to write, edit and copy Russian naturally, on desktop or mobile, without setting up an OS keyboard. Also support conversion of existing text. English UI initially; Russian UI is desirable after the MVP. Transliteration is not translation, spellchecking, or a guarantee of official passport spelling.

## MVP scope

1. **Single editor:** large native textarea, live Russian phonetic input, plain Latin mode and a visible toggle. Preserve ordinary Cyrillic and punctuation. Configurable shortcut, initially opt-in; never intercept Escape while closing dialogs or during IME composition.
2. **Convert existing text:** explicit Latin → Cyrillic and Cyrillic → Latin actions on a selection, or the whole text when no selection exists. Show direction, warn that reverse conversion may be lossy and do not promise round-tripping.
3. **Optional dual panels:** source editable, output read-only and derived in real time. Direction switch reinterprets the source only after confirmation if it would change displayed results. Copy output; preserve the source when changing mode; no silent data loss. Define transition rules in implementation issue.
4. **Editor:** copy with success/failure feedback and selectable fallback; clear with undo or confirmation for nonempty text; character count and native undo/redo; allow editing selections and at the caret, multiline, paste and international input. Adjustable editor height using pointer and keyboard controls, bounded to viewport and with a reset.
5. **Rules:** ship a documented informal Russian preset with multi-character and common alternate mappings and a visible chart; allow user-customized mappings with validation, conflict explanation, reset and preview. Prefer longest match; define case behavior and explicit separator for ambiguous boundaries (`s+h` → сх). Presets are not certified standards.
6. **Persistence:** settings and dimensions saved locally by default; draft auto-save is on by default and can be disabled in Settings. Each newly opened independent tab starts with a blank draft; existing drafts are available through a Drafts list (open, rename, delete). A reload restores the same draft. Save settings and draft records separately, with stable draft IDs and a versioned schema; avoid creating empty drafts. Detect duplicated-tab IDs and concurrent edits to the same draft and never silently overwrite changes. Explain local-only storage and provide delete drafts/reset settings separately; never send text or settings to a server. Handle blocked storage, quota, corrupt/old data and private browsing without losing the current in-memory session; communicate failures.
7. **Appearance and access:** system/light/dark theme, accessible contrast and focus, keyboard support, responsive layouts and reduced motion. No account, advertising or analytics by default.

## Acceptance examples

- `privet` → `привет`; `sh` → `ш`; `s+h` → `сх`; test capitalized, upper and mixed case using an explicitly documented policy.
- Typing inside text or replacing a selection leaves unaffected text intact and caret correctly positioned; editing a multicharacter sequence, undo/redo and pasted text must have defined predictable results.
- IME composition is not disrupted; existing Cyrillic and punctuation survive; live conversion is not triggered while composing.
- Reload restores preferences and the current tab's draft when auto-save is enabled; a separate new tab starts blank and can open prior drafts from Drafts. Disabling auto-save stops future writes and offers an explicit choice to retain or delete existing drafts. Clearing a saved draft removes it; storage errors leave visible text intact.
- Mobile portrait, touch targets, keyboard navigation, resizing, screen readers and reduced motion work without clipping or trapping focus.
- Each transformation reports its direction and copy/clear failures visibly. No input is transmitted; verify via network inspection.

## Later / non-goals
More language packs, formal standards, shareable rule files, PWA/offline installation, spellcheck and OS-wide input are future candidates, not MVP commitments. No translation, accounts, cloud sync or server backend in MVP. Offline use after initial load requires a future service worker and is not promised by a static site alone.

## Open decisions
Finalize mapping, shortcut and all mixed-case rules with user tests; resolve dual-panel transition semantics and undo behavior against actual browser APIs; assess supported browsers and data migration policy before release. Keep MVP intentionally limited while architecture remains extensible.
