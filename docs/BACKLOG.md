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

The four-field model/log foundation shipped in #265 (`c0f9be4`), Refs #257, #255, #37. Step 2b below binds its UI. Residuals (2c), new-private-document traces (3), and clear local data (4) remain later PRs.

## #257 step 2b: document search UI

Implemented in this change, pending review/CI: Find/Replace bound to document fields and independent histories; title history captured/restored; viewer queries in memory only; privacy toggles preserve fields; old search-content keys removed. Host layout stores ids/geometry with no live title strings. Refs #257, #255. Step 2c residuals and steps 3–4 are later PRs.
