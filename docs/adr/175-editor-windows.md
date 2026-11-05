# ADR: Movable editor windows in one tab (#175)

Status: **Accepted plan** (maintainer, Nov 2026). Replaces the in-page split goal from [#159](https://github.com/vchernoy/typebridge/issues/159) (S2–S6). **Keeps #159 W1–W4** (routing, separate-window comparison companion, metadata-only saved-version signals, per-document Web Lock + IndexedDB fence). PR [#174](https://github.com/vchernoy/typebridge/pull/174) and [#164](https://github.com/vchernoy/typebridge/pull/164) stay draft/paused; do not merge them for the old goals. **Step 1** landed as docs-only. **Step 2** (this work): parse `?window=`, scope tab-local sessionStorage keys by window id, keep unscoped keys when the param is absent, and cover two same-tab iframes with Playwright.

## Context

#159 delivered W1–W4 foundations and an in-tab split (S2–S5b on `main`: workspace shell, same-doc live companion, dual-document panes, local Edit in this pane). Maintainer decision: stop growing that split. The product need remains **two (or more) document views in one browser tab**, but the model should match **how TypeBridge already coordinates separate browser tabs**, not a second in-memory session/pane abstraction that duplicates ownership and handoff.

Constraints from AGENTS.md remain: client-only; no text logging/telemetry; IndexedDB authoritative; conflict copies retained; Autosave-off privacy unchanged unless an explicit same-tab in-memory handoff applies (below).

## Decision summary

1. **Windows, not panes.** Several **editor windows in one browser tab**. Each window looks and works like today’s editor: document title, ▾ Documents picker, save state, toolbar, and text.
2. **Tab semantics.** Two windows in one tab behave like two browser tabs on the same or different documents. Reuse Web Lock, IndexedDB fence, and BroadcastChannel saved-version signals — **one mechanism**, not a parallel live-mirror path.
3. **Iframe instances.** Each window is a same-origin **iframe** running the existing editor in an embedded mode. Web Locks, IndexedDB, and BroadcastChannel already work across iframes. No new framework; no in-page sharing of a single Editor history between windows.
4. **Different documents.** Every window is editable (subject to cross-tab/window ownership). Focus only decides where typing goes.
5. **Same document.** **The focused window edits.** Pointer-down / focus in a read-only window’s text triggers handoff: previous owner flushes and releases; new owner acquires, rereads text and Undo from IndexedDB, becomes editable with the caret where clicked. Other windows show the **last saved** text (not a live unsaved mirror). Same rules within one tab and across tabs, except the privacy handoff rule below.
6. **Unsaved / Autosave-off / failed-save text.**
   - **Within one tab:** handoff **may** pass unsaved text to the new window **in memory** (direct same-origin call or `postMessage`). Never stored for that transfer, never put in a URL, never BroadcastChannel’d.
   - **Across tabs:** unsaved/private text is **never** sent. The other window shows **Edit here** with a warning instead of taking over silently. This replaces #164’s cross-window request protocol for the new product goal.
7. **Layout — computer.** Free windows: drag title bar, resize edges/corner, z-order, snap halves/quarters, tile side-by-side or stacked, keyboard move/resize. Cap **4** windows. Persist layout (positions, sizes, document ids — **never text**) in localStorage.
8. **Layout — phone.** Stacked full-width; each keeps the existing corner height grip. Detect with capabilities (viewport width + `(any-pointer: fine)` / `(hover: hover)`), not user-agent. **Settings → Layout: Auto / Free windows / Stacked** overrides misdetection.
9. **Focus mode.** Maximizes the **active** window (step 6); other windows stay in the layout but are not the Focus surface. Existing single-editor Focus behavior becomes per-active-window once the host exists.
10. **Shared across windows (page-level).** Settings, keyboard shortcuts, transliteration rules, appearance, Latin/Кириллица mode. One Settings panel on the host page; changes apply to every window immediately.
11. **Per window.** Selected document, title, caret/selection/scroll, window size/position, Find/Replace UI (Replace only when that window is editing). Ctrl/⌘+F opens Find in the focused window, pre-filled with the last search text (**shared**). “Search all documents” is later/out of scope.
12. **sessionStorage is shared by iframes in one tab.** Today’s tab-scoped keys (`activeDraft`, pending backups, Find text, writing position, update-notice dismissal, recovery journal tab id, …) must be keyed by a **window id** (e.g. `?window=<id>`) so instances do not clobber each other.
13. **Remove the in-page split (later step).** Delete pane B, live mirror, `PENDING_KEY_B`, split preferences, and related `main.ts` code. Fold “Open in comparison window” into opening a read-only window. Keep W1–W4. Clean old split prefs without touching documents.
14. **Modules.** Do not grow `src/main.ts` further. New behavior goes in focused modules (host page, window manager, handoff). Step 10 should shrink `main.ts` (see #99).

## Product states

| Situation | Behavior |
| --- | --- |
| One window, one document | Parity with today’s single editor |
| Two windows, different documents | Both editable (unless another tab holds a lock); independent Undo/save |
| Two windows, same document | Focused window editable; others read-only on last saved text; handoff on focus into text |
| Same document across real tabs | Existing W3/W4; no unsaved-text transfer; Edit here + warning when private |
| Autosave off / failed save, same tab | In-memory handoff allowed; nothing written for the transfer itself |
| Suspended / lost owner | Existing lost/read-only guidance; fence rejects late writes; steal only where #175 step 4 specifies |
| Close window | Same unsaved/private prompts as closing a tab |
| Focus mode | Active window maximized; exit restores prior free/stacked layout |
| Reload | Restore layout + document ids; never restore private Autosave-off text from layout prefs |

## Non-goals

- Keeping or extending the #159 in-page split / live mirror / dual `BoundSession` as the long-term UX
- Merging #174 or #164 for those paused goals
- #7 derived Latin/Cyrillic dual-panel
- #39 URL sharing / backend / collab
- Broadcasting or URL-encoding document body text
- Claiming read-only is a security boundary

## Slice map (from #175)

| Step | Deliverable | Runtime? |
| --- | --- | --- |
| **0** (done) | Stop/supersede #159 S-slices; pause #174/#164 | Docs/process |
| **1** (this PR) | This ADR + ARCHITECTURE / UI / ROADMAP | No |
| **2** | Per-window identity; key sessionStorage by window id; two-instance Playwright “like two tabs” | Yes (shipped in this slice) |
| **3** | Embedded mode + host page; single-window parity; Settings/update notice on host | Yes |
| **4** | Focus handoff (flush, lock, reread, IME/buffer, same-tab unsaved transfer) | Yes |
| **5** | Window manager (desktop free layout) | Yes |
| **6** | Phone stack, Layout setting, Focus mode | Yes |
| **7** | Shared settings live across windows | Yes |
| **8** | Title/picker redesign | Yes |
| **9** | Find/Replace per window | Yes |
| **10** | Remove in-page split | Yes |
| **11** | Verification, screenshots, honest device/AT limits | Docs + tests |

## Merge / PR notes

- PRs use `Refs #175`. Avoid GitHub closing keywords next to issue numbers in descriptions.
- **Merge authorization** for this plan lives on the [#175 issue body](https://github.com/vchernoy/typebridge/issues/175) (standing conditions as of 2026-11-05: linked PR, final-head CI green on quality + Chromium/Firefox/WebKit, independent review with no open P0/P1, remaining P2/P3 recorded on #175 or a linked issue). Do not restate a conflicting rule here — if the issue and this ADR disagree, **the issue wins**.

## Relation to ADR 159

[ADR 159](159-comparison-window.md) remains the record of W1–W4 and of the shipped-but-superseded split slices. Mark it **superseded for the in-tab split goal**; do not delete historical S1–S5b notes. New window work follows **this** ADR.
