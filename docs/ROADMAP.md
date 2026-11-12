# TypeBridge — Product Roadmap

TypeBridge is a **local-first, desktop-first writing editor** for long-form text (especially Russian-language Facebook posts). Transliteration is optional, not the whole product. Fast typing, predictable undo/redo, privacy, and safe recovery of documents come before visual complexity.

This document tracks ideas and priorities. A feature is **not shipped** until merged to `main` and verified in production. PR status may change; check linked PRs for current CI results.

## Feature tracking

Each feature has its own [GitHub Issue](https://github.com/vchernoy/typebridge/issues) with **Feature status** (`Research`, `Ready for implementation`, `Implemented in PR`, `Shipped`), priority, description, and PR link when applicable. Issues are the canonical feature records; this document is the high-level overview.

| Issue | Feature | Current stage |
| --- | --- | --- |
| [#32](https://github.com/vchernoy/typebridge/issues/32) | Offline refresh | Merged in PR #30; production checks recorded separately |
| [#33](https://github.com/vchernoy/typebridge/issues/33) | Document backup | Merged in PR #27; production checks recorded separately |
| [#34](https://github.com/vchernoy/typebridge/issues/34) | Custom mappings | Merged in PR #25; production checks recorded separately |
| [#35](https://github.com/vchernoy/typebridge/issues/35) | Regex replace | Merged in PR #26; production checks recorded separately |
| [#36](https://github.com/vchernoy/typebridge/issues/36) | Word statistics | Merged in PR #28; production checks recorded separately |
| [#37](https://github.com/vchernoy/typebridge/issues/37) | Document recovery / version history | Emergency recovery merged (#53); retained version snapshots remain research |
| [#38](https://github.com/vchernoy/typebridge/issues/38) | Customizable UI/UX | Research |
| [#39](https://github.com/vchernoy/typebridge/issues/39) | Portable share links | Ready for implementation |
| [#40](https://github.com/vchernoy/typebridge/issues/40) | Universal editor | Plain-text preference merged (#42); Reading View remains open |
| [#41](https://github.com/vchernoy/typebridge/issues/41) | Markdown / smart paste / Facebook / themes | Research |
| [#48](https://github.com/vchernoy/typebridge/issues/48) | Cross-tab saved-version notifications | Saved/renamed/deleted signals for viewers and notice-only editors landed via [#159](https://github.com/vchernoy/typebridge/issues/159) W3; remaining scope (clean-editor refresh, editor list refresh, other preference signals) stays on #48, do not close it automatically |
| [#159](https://github.com/vchernoy/typebridge/issues/159) | In-tab split (superseded) | Closed / not planned for further S-slices. W1–W4 kept; in-page split removed in #175 step 10. See [ADR 159](adr/159-comparison-window.md) |
| [#175](https://github.com/vchernoy/typebridge/issues/175) | Movable editor windows in one tab | **Shipped (closed).** Replaced the #159 split. `/` is the multi-window host (cutover #205); each window is `/editor.html` with tab-style editing/ownership, free layout on desktop, stacked on phone, two-line Focus. Paused split/handoff PRs #164 and #174 are closed. [ADR 175](adr/175-editor-windows.md), [evidence/175](evidence/175/README.md) |

## Next (as of 2026-11-12)

Done since the #175 cutover: the `main.ts` split ([#99](https://github.com/vchernoy/typebridge/issues/99), PRs #208–#229, see the [code map](ARCHITECTURE.md#code-map)), the flaky tests found in CI ([#207](https://github.com/vchernoy/typebridge/pull/207), including the [#155](https://github.com/vchernoy/typebridge/issues/155) menu race), writing-position follow-ups ([#107](https://github.com/vchernoy/typebridge/issues/107), PRs #234–#238), the conflict re-announce P2s ([#97](https://github.com/vchernoy/typebridge/issues/97), PR #232), the search audit ([#62](https://github.com/vchernoy/typebridge/issues/62), PR #233) and the first #37 recovery evidence (PRs #239–#241). Current findings are collected in [#242](https://github.com/vchernoy/typebridge/issues/242).

Proposed order; each item is one or a few small PRs.

1. **Next feature: [#39](https://github.com/vchernoy/typebridge/issues/39) portable share links** (ready for implementation; scope to be agreed before starting).
2. **[#37](https://github.com/vchernoy/typebridge/issues/37) R2c: a recovery journal that survives a browser kill.** The [process-crash baseline](evidence/37/README.md) lost the journal when the browser was killed within about a second of typing; committed documents always survived. Retained version history stays a later stage.
3. **Test reliability.** Find the race behind each remaining intermittent failure and fix it in code or test (no retries, skips or quarantine): Firefox `indexeddb.spec.ts:35` (blocked upgrade never reports, seen on #232), and the single sightings listed in #207 (`title-takeover-buffer:116`, `writing-view:71`, `macos-shortcut:11`, `recovery:156`, `edit-ownership:464`, `focus-handoff:242`, `host-shared-settings:214`). `find-replace.spec.ts:43` fails only locally with a newer Chromium that names Cyrillic downloads `download`.
4. **Small follow-ups:** the three P3s left in [#97](https://github.com/vchernoy/typebridge/issues/97); per-edit work on multi-megabyte documents (status counts, caret readout and recovery journal run on every edit; see [search timings](SEARCH.md#responsiveness-on-large-documents)).
5. **Test knobs in production.** The `TestKnobs` in `src/view/embed-api.ts` are read-only, default off and ship because CI tests the deployed build. Moving them to a test-only build needs CI to test that build instead; low priority. The `__typebridge*` host↔window calls are the real multi-window contract and stay.

Manual checks that automation cannot do (VoiceOver/NVDA, physical phones and tablets, 200% zoom) are tracked in [#11](https://github.com/vchernoy/typebridge/issues/11).

Open questions: none from the previous list ([#7](https://github.com/vchernoy/typebridge/issues/7) closed as not planned; [#70](https://github.com/vchernoy/typebridge/issues/70) and [#12](https://github.com/vchernoy/typebridge/issues/12) closed).

## Audit and current reliability follow-ups

[Audit #71](https://github.com/vchernoy/typebridge/issues/71) records baseline code, exact verification limits and AI handoff. #62 tracks search correctness/UX; #72 excluded core unit tests; #73 a recovery confirmation-test wait cycle; #74 stale documentation; #75 the Pages release gate. Existing #66–#70 own status feedback, Escape, macOS shortcut conflict, centralized shortcut settings and editor resizing. Design-dependent issues require their specified UX decision before implementation.

This document is a snapshot. A merged implementation and a production-verified release are different stages; consult linked issues/PRs for later changes. Portable sharing, a source/output dual panel (#7, distinct from windows), Markdown/rich preview, retained version snapshots and advanced navigation/indentation remain future work. Go to line and the caret line/column readout are the first shipped slice of [#60](https://github.com/vchernoy/typebridge/issues/60); see [navigation](NAVIGATION.md).

## P0 — Reliability and unfinished work

| Feature | Why / acceptance criteria | Tracking |
| --- | --- | --- |
| Offline refresh and reopening | After one successful online installation, refresh/reopen while offline; preserve and continue editing saved Russian documents; test Chromium, Firefox and WebKit. | [PR #30](https://github.com/vchernoy/typebridge/pull/30) — merged; verify production separately |
| Document export/import (TXT, JSON) | Explicit local backup and restore; Unicode and WebKit filenames; never silently overwrite existing documents. | [PR #27](https://github.com/vchernoy/typebridge/pull/27) — merged; verify production separately |
| Custom transliteration mappings | Local persistence, validation, import/export; do not mutate existing text when mappings change. | [PR #25](https://github.com/vchernoy/typebridge/pull/25) — merged; verify production separately |
| Regex Find & Replace | Optional regex, capture groups, invalid-pattern feedback, undo support and browser tests. | [PR #26](https://github.com/vchernoy/typebridge/pull/26) — merged; verify production separately |
| Live word count / reading time | Correct Unicode word boundaries and updates during editing. | [PR #28](https://github.com/vchernoy/typebridge/pull/28) — merged; verify production separately |
| Document recovery hardening | Continue real-device/crash verification and design retained snapshots separately from emergency recovery. | IndexedDB #45 and emergency journal #53 merged; #37 remains open |

## P1 — Product UX and sharing

### Customizable workspace
- Keep the editor central; provide **Minimal / Writing / Advanced / Custom** presets.
- Let users show/hide toolbar commands and panels independently of the availability of their keyboard shortcuts.
- Reorder toolbar buttons; move panels between **defined docking regions**; resize panels.
- Offer accessible alternatives to drag-and-drop (keyboard and Move left/right/menu commands), Reset layout, and stable focus/selection while changing layouts.
- Persist workspace preferences **separately from documents**; consider per-device settings.
- Start with UX prototypes and a design review before large UI refactors.
- Maintain fast typing, low bundle weight, responsive desktop-first behavior and mobile usability.

### Portable document links (no backend)
- Share a compressed, versioned UTF-8 document through a URL fragment (`#doc=...`), e.g. gzip + base64url; measure real Russian-text compression.
- **Reading View**: compact, distraction-free document with **Fork / Edit a copy**.
- **Editing View**: immediately create an editable *local copy* with editor tools.
- These are **presentation choices, not permissions or security controls**; recipients can always copy/edit.
- Never overwrite recipient documents or auto-save an incoming document before explicit fork.
- Show URL length and compatibility warnings; impose encoded/decompressed size limits; reject corrupt input safely.
- Test share/open/fork, Unicode, long documents, browser compatibility and offline app-shell behavior.
- A true short URL requires persistent server-side mapping or a third-party shortener; **defer backend/shortener** until measurements justify it.

### Universal writing editor
- Plain-text editing and the remembered transliteration toggle are implemented (#42). Keep them first-class while adding optional modes.
- Distinguish **Document** (content), **Workspace** (tool layout) and **View Mode** (reading/editing presentation).
- Provide an uncluttered Reading View for own documents as well as shared links.

## P2 — Further exploration

- Versioned document snapshots / restore previous versions (distinct from undo history).
- Markdown authoring and optional preview, without making plain-text writing slower.
- Smart paste / clean text formatting.
- Copy for Facebook: preserve line breaks and consider optional Unicode formatting.
- Light/dark themes, typography and accessibility preferences.
- Workspace configuration export/import and multiple custom profiles.
- Investigate whether short-link service (e.g. Cloudflare Worker + KV/D1) is worthwhile, including privacy and deletion policy.
- Mobile polish, including iOS Safari native Undo limitations; desktop experience remains primary.

## UI/UX research checklist

Review **Apple Human Interface Guidelines**, **WCAG 2.2**, **WAI-ARIA Authoring Practices**, and configurable workspaces such as **VS Code** and **Obsidian**. Evaluate:
- discoverability and progressive disclosure;
- keyboard-first flows, visible focus, accessible drag/drop alternatives;
- consistent command placement, undoability and confirmation of destructive actions;
- responsive behavior, readability, contrast and touch target sizes;
- persistence and reset of customizations;
- performance budgets and browser cross-testing.

## Delivery rules

1. One focused feature/PR at a time where practical; avoid large overlapping UI changes.
2. Unit tests + Playwright Chromium/Firefox/WebKit for affected behavior.
3. Do not merge with failing or missing required CI.
4. Keep preview deployments separate from production; verify after deployment.
5. Update this roadmap when a feature is scoped, merged, deferred or dropped.
