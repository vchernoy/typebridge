# Implementation backlog

GitHub Issues are the source of truth for scope, status and dependencies. Links use actual GitHub issue numbers. The first editor and Pages deployment are implemented. Older issues may contain superseded acceptance wording; check merged PRs and current behavior before starting work.

- [#1 — Scaffold Vite, TypeScript and quality gates](https://github.com/vchernoy/typebridge/issues/1)
- [#2 — Define Russian mapping and rule contracts](https://github.com/vchernoy/typebridge/issues/2)
- [#3 — Implement accessible single-editor shell](https://github.com/vchernoy/typebridge/issues/3)
- [#4 — Add selection and whole-text conversion](https://github.com/vchernoy/typebridge/issues/4)
- [#5 — Build pure transliteration engine](https://github.com/vchernoy/typebridge/issues/5)
- [#6 — Add live input and editing semantics](https://github.com/vchernoy/typebridge/issues/6)
- [#7 — Add optional dual-panel mode](https://github.com/vchernoy/typebridge/issues/7)
- [#8 — Build mapping settings and reference chart](https://github.com/vchernoy/typebridge/issues/8)
- [#9 — Implement default auto-save and independent multi-tab documents](https://github.com/vchernoy/typebridge/issues/9)
- [#10 — Add keyboard-accessible editor resizing](https://github.com/vchernoy/typebridge/issues/10)
- [#11 — Accessibility, privacy and browser audit](https://github.com/vchernoy/typebridge/issues/11)
- [#12 — Publish early usable editor + transliteration MVP on GitHub Pages](https://github.com/vchernoy/typebridge/issues/12)

Implemented portions of the original backlog include the shell/live input, both conversion directions on a selection, custom rules, saved document/history management and keyboard resizing. Whole-document conversion, dual panels and some original UX acceptance criteria remain incomplete or require review; do not bulk-close issues based on this summary.

Current follow-ups and priorities are listed once, in [ROADMAP.md](ROADMAP.md); see also [audit #71](https://github.com/vchernoy/typebridge/issues/71).


## #257 private mode: step 2a model/log

The four-field model/log foundation shipped in #265 (`c0f9be4`), Refs #257, #255, #37. Step 2b shipped in #266 (`1a749b0`). New-private-document traces (3) and clear local data (4) remain later PRs.

## #257 step 2b: document search UI

Shipped in #266: Find/Replace bound to document fields and independent histories; title history captured/restored; viewer queries in memory only; privacy toggles preserve fields; old search-content keys removed. Host layout stores ids/geometry with no live title strings. Refs #257, #255. Steps 3–4 are later PRs.

### Private mode step 2c — carried residuals

Implemented in this change, pending review/CI: missing comparison viewers retain the requested document ID and accept recreation at revision 1 (#261), including missed-signal reconciliation on focus; pending startup restore refreshes the writable boundary after its revision bump (#263); storage preference sync uses the same-target/reversal guard. Refs #257. Steps 3–4 remain separate.


### Private mode step 3 — new private documents leave no trace

Implemented in this change, pending independent review and CI: private revision-zero documents omit rows/logs/ownership records, active hints, positions, backups, and host-layout IDs. Their local picker labels them Private / Not saved; other windows learn no new document. Saving opts into normal ownership and metadata. New tests inspect IndexedDB, session/local storage, BroadcastChannel messages, host layout, second-tab pickers, reload/close, and resuming saving. Step 4 remains later work. Refs #257, #255.


### Private mode step 4 — clear local data

Implemented in this change, pending independent review and CI, Refs #257/#255: separately confirmed per-document and all-content clearing; settings/private preference retained; old connections and in-flight writes invalidated; cross-tab notices and session cleanup; global clear empties all live documents/history; per-document clear retains only the initiating private scratch copy. Clearing uses existing document deletion and database versionchange mechanisms. Unit and browser checks inspect data/metadata, cancel/failure behavior, second tabs/viewers, host layout, resaving a kept scratch document, delayed appends before per-document deletion, partial metadata failures and a held transaction during clear-all.
