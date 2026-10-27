# Proposed implementation issues

These are draft issue bodies until created in GitHub. Sequence dependencies are explicit; implementation is intentionally not part of this planning change.

## 1. Scaffold Vite, TypeScript and quality gates
Add locked dependencies, Vite static app, npm scripts for typecheck, unit, e2e and build. Enable `.github/workflows/ci.yml` and prove clean push/PR checks. No product features. Dependency: none.

## 2. Define Russian mapping and rule contracts
Document informal default mappings, alternatives, case, separators, punctuation and lossy reverse conversion; implement typed language pack contract with validation and conflict errors. Acceptance: reviewed examples and Vitest coverage for ambiguous/invalid rules. Depends on 1.

## 3. Build pure transliteration engine
Implement deterministic longest-match batch conversion in both directions, Unicode/case/boundary handling and rule tests. Acceptance: PRD examples, selection-ready transforms, stable deterministic behavior, no DOM or network. Depends on 2.

## 4. Implement accessible single-editor shell
Semantic editor, controls, theme tokens, responsive layout, count, copy feedback and safe clear. Acceptance: keyboard, mobile layout and browser tests; no hidden data loss. Depends on 1.

## 5. Add live input and editing semantics
Connect engine to editor with mode toggle, caret/selection, composition, paste, undo and separator handling. Acceptance: Playwright tests plus manual IME checks; document browser limitations. Depends on 3 and 4.

## 6. Add selection and whole-text conversion
Add both directions, selection/whole-text behavior and lossiness notice. Acceptance: preserve untouched text, selection and sensible undo, with browser tests. Depends on 3 and 4.

## 7. Add optional dual-panel mode
Editable source, derived read-only output, direction control, copy, responsive stacking and non-destructive transition policy. Acceptance: no source loss on toggling; test modes and direction changes. Depends on 3 and 4.

## 8. Build mapping settings and reference chart
Preset selection, validated custom rules, conflicts, preview, reset and accessible reference. Acceptance: errors explain conflicts; edits do not mutate the default preset. Depends on 2 and 4.

## 9. Implement versioned local persistence
Save settings and editor dimensions; opt-in draft separately, deletion and error handling. Acceptance: reload, corrupt data, unavailable storage and opt-in privacy tests. Depends on 4.

## 10. Add keyboard-accessible editor resizing
Pointer and keyboard resize, viewport bounds, reset and saved size. Acceptance: small screen and zoom tests, size persists only when storage works. Depends on 4 and 9.

## 11. Accessibility, privacy and browser audit
Test keyboard, screen readers, mobile, real IMEs, zoom, contrast and network activity; fix failures, record remaining limitations. Depends on 5–10.

## 12. Enable GitHub Pages release
After checks pass and release is approved, configure Pages Actions source, verify `/typebridge/` asset paths and manual deployment. Acceptance: deployed build works on reload; rollback instructions documented. Depends on 1 and 11.
