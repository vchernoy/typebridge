# TypeBridge — Product Roadmap

TypeBridge is a **local-first, desktop-first writing editor** for long-form text (especially Russian-language Facebook posts). Transliteration is optional, not the whole product. Fast typing, predictable undo/redo, privacy, and safe recovery of drafts come before visual complexity.

This document tracks ideas and priorities. A feature is **not shipped** until merged to `main` and verified in production. PR status may change; check linked PRs for current CI results.

## Feature tracking

Each feature has its own [GitHub Issue](https://github.com/vchernoy/typebridge/issues) with **Feature status** (`Research`, `Ready for implementation`, `Implemented in PR`, `Shipped`), priority, description, and PR link when applicable. Issues are the canonical feature records; this document is the high-level overview.

| Issue | Feature | Current stage |
| --- | --- | --- |
| [#32](https://github.com/vchernoy/typebridge/issues/32) | Offline refresh | Merged in PR #30; production checks recorded separately |
| [#33](https://github.com/vchernoy/typebridge/issues/33) | Draft backup | Merged in PR #27; production checks recorded separately |
| [#34](https://github.com/vchernoy/typebridge/issues/34) | Custom mappings | Merged in PR #25; production checks recorded separately |
| [#35](https://github.com/vchernoy/typebridge/issues/35) | Regex replace | Merged in PR #26; production checks recorded separately |
| [#36](https://github.com/vchernoy/typebridge/issues/36) | Word statistics | Merged in PR #28; production checks recorded separately |
| [#37](https://github.com/vchernoy/typebridge/issues/37) | Draft recovery / version history | Emergency recovery merged (#53); retained version snapshots remain research |
| [#38](https://github.com/vchernoy/typebridge/issues/38) | Customizable UI/UX | Research |
| [#39](https://github.com/vchernoy/typebridge/issues/39) | Portable share links | Ready for implementation |
| [#40](https://github.com/vchernoy/typebridge/issues/40) | Universal editor | Plain-text preference merged (#42); Reading View remains open |
| [#41](https://github.com/vchernoy/typebridge/issues/41) | Markdown / smart paste / Facebook / themes | Research |

## Audit and current reliability follow-ups

[Audit #71](https://github.com/vchernoy/typebridge/issues/71) records baseline code, exact verification limits and AI handoff. #62 tracks search correctness/UX; #72 excluded core unit tests; #73 a recovery confirmation-test wait cycle; #74 stale documentation; #75 the Pages release gate. Existing #66–#70 own status feedback, Escape, macOS shortcut conflict, centralized shortcut settings and editor resizing. Design-dependent issues require their specified UX decision before implementation.

This document is a snapshot. A merged implementation and a production-verified release are different stages; consult linked issues/PRs for later changes. Portable sharing, dual panels, Markdown/rich preview, retained version snapshots and advanced navigation/indentation remain future work.

## P0 — Reliability and unfinished work

| Feature | Why / acceptance criteria | Tracking |
| --- | --- | --- |
| Offline refresh and reopening | After one successful online installation, refresh/reopen while offline; preserve and continue editing saved Russian drafts; test Chromium, Firefox and WebKit. | [PR #30](https://github.com/vchernoy/typebridge/pull/30) — merged; verify production separately |
| Draft export/import (TXT, JSON) | Explicit local backup and restore; Unicode and WebKit filenames; never silently overwrite existing drafts. | [PR #27](https://github.com/vchernoy/typebridge/pull/27) — merged; verify production separately |
| Custom transliteration mappings | Local persistence, validation, import/export; do not mutate existing text when mappings change. | [PR #25](https://github.com/vchernoy/typebridge/pull/25) — merged; verify production separately |
| Regex Find & Replace | Optional regex, capture groups, invalid-pattern feedback, undo support and browser tests. | [PR #26](https://github.com/vchernoy/typebridge/pull/26) — merged; verify production separately |
| Live word count / reading time | Correct Unicode word boundaries and updates during editing. | [PR #28](https://github.com/vchernoy/typebridge/pull/28) — merged; verify production separately |
| Draft recovery hardening | Continue real-device/crash verification and design retained snapshots separately from emergency recovery. | IndexedDB #45 and emergency journal #53 merged; #37 remains open |

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
- Never overwrite recipient drafts or auto-save an incoming document before explicit fork.
- Show URL length and compatibility warnings; impose encoded/decompressed size limits; reject corrupt input safely.
- Test share/open/fork, Unicode, long documents, browser compatibility and offline app-shell behavior.
- A true short URL requires persistent server-side mapping or a third-party shortener; **defer backend/shortener** until measurements justify it.

### Universal writing editor
- Plain-text editing and the remembered transliteration toggle are implemented (#42). Keep them first-class while adding optional modes.
- Distinguish **Document** (content), **Workspace** (tool layout) and **View Mode** (reading/editing presentation).
- Provide an uncluttered Reading View for own drafts as well as shared links.

## P2 — Further exploration

- Versioned draft snapshots / restore previous versions (distinct from undo history).
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
