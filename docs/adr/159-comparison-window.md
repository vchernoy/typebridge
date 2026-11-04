# ADR: Comparison window and single editing owner (#159)

Status: **Accepted for implementation** (W1). Implements in sequential PRs W2–W6 on `main`. Does **not** close #159, #48, #40 or #37.

## Context (audit of current code)

Relevant entry points today (no comparison UI yet):

| Concern | Location | Notes |
| --- | --- | --- |
| IndexedDB documents | `src/editor/indexeddb.ts` | Store `documents`, `StoredDraft` with `revision` CAS; `commitOrCreateConflictCopy`; delete checks revision |
| Boot / open document | `initializeDrafts` in `src/main.ts` | After recovery Web Lock: open DB → list → sessionStorage active hint → pending restore → else most recent → `showDraft` → optional `persist` → enable fields → `renderRecovery` |
| Autosave / privacy | `src/editor/drafts.ts`, `persist` / `journalEdit` / `savePending` | Autosave off skips IDB/journal/pending writes; import and recovery Recover still commit |
| “Committed” document | Successful IDB row with `revision >= 1` | `revision === 0` means never written or after Delete saved copy |
| Recovery ownership | `OWNER_LOCK = 'typebridge-recovery-owner:'` + `journalTab` UUID | Web Lock suppresses recovery prompts; **not** document edit ownership |
| sessionStorage | active draft hint, pending reload snapshot, writing position, Find strings | Duplicate-tab can clone; `window.open` normally does not |
| URL routing | None for documents | Vite `base: '/'`; hash reserved for future #39 share links |
| Cross-tab signals | None (`BroadcastChannel` unused) | CAS + recovery `storage` events only |
| Document menu | `#doc-menu` / `.doc-actions` in `index.html`, `setupDocumentMenu` | Natural hang for **Open in comparison window** |
| Read-only today | Temporary `readOnly` during Delete; boot `disabled` until init | Insufficient for companion (Editor, Replace, convert, menus, lifecycle flush) |

Constraints from #159 and AGENTS.md remain: client-only, no text logging/telemetry, IndexedDB authoritative, conflict copies retained, Autosave-off privacy unchanged.

## Decision summary

1. **Routing:** query params `doc` + `mode=view` (IDs/mode only). Hash left free for #39. Validate before ordinary boot open.
2. **Companion (W2):** user-triggered `window.open` of a committed document; read-only UI; independent view position; no edit ownership; no document/history writes.
3. **Signals (W3):** `BroadcastChannel('typebridge.documents.v1')` carries minimal metadata; always reread IDB; reconcile on visibility/focus; poll fallback when channel missing.
4. **Ownership (W4):** per-document **Web Lock + IndexedDB fence** (separate store; no destructive migration of `documents`). CAS conflict copies remain the backstop for non-cooperating versions.
5. **Handoff (W5):** explicit **Edit here** only; refuse while dirty / private / IME / in-flight save / conflict; no focus-stealing ownership.
6. **Private source:** never transmit unsaved text to open a companion; explain and Cancel when no committed copy exists.

## Product states

### Window roles

| Role | Meaning |
| --- | --- |
| **Editor** | Designated editing owner for one document (not “has OS focus”). May write that document when fence matches. |
| **Viewer** | Read-only companion for a committed document. Never acquires ownership or writes document content/history. |
| **Ordinary tab** | Today’s default: after W4, also participates in ownership (first acquirer or explicit Edit here). |

Different documents may have different editors at once. Clicking a viewer never steals ownership or triggers saves.

### Document view machine (per window, per open document)

```
                 ┌──────────────────────────────┐
                 │ boot / route parse             │
                 └───────────┬────────────────────┘
                             ▼
              ┌──────────────────────────────┐
              │ resolve target document        │
              │ (IDB get; never create empty)  │
              └───────────┬────────────────────┘
           missing/error  │  found
                ▼         ▼
         ViewerMissing  mode=view? ──yes──► ViewerReady (read-only)
                              │ no
                              ▼
                    acquire ownership?
                         │         │
                      fail/skip   ok
                         ▼         ▼
                  ViewerReady   EditorReady
                         │         │
            signals/reread│         │ edits → dirty → persist (fence+CAS)
                         ▼         ▼
                  ViewerStale*  EditorConflict / EditorBlocked
```

\*ViewerStale: known revision behind IDB; auto-refresh when still a viewer (W3). Dirty editors get a notice only—never silent replace.

Loss of ownership (W4/W5): window becomes non-editable for that document; pending writes to the original are blocked; in-memory dirty text/title/history preserved for copy/export/recovery choices—never silent discard.

### Unsaved / private source (resolved)

| Source window state | Open in comparison window |
| --- | --- |
| Committed IDB row exists (`revision >= 1`), including dirty editors with a prior save | Offer open of the **latest committed** revision only. Status copy: “Opens the last saved version. Unsaved typing in this window is not sent.” |
| No IDB row (`revision === 0`, new doc, or Delete saved copy while Autosave off) | Dialog: no saved copy to open. **Cancel** default. Saving/export remain separate explicit actions. Never enable Autosave, never write private text, never `postMessage`/session clone of body text to bootstrap the companion. |
| Storage blocked / DB unavailable | Explain; Cancel. Do not invent a document. |

Companion bootstrap must **not** run pending-restore → most-recent → `persist` → recovery clear/create paths that would mutate storage for the source window’s private state.

## Routing contract

### URL shape

Same origin and Vite base (`/` today; preserve non-root base if ever set):

```
{base}?doc={documentId}&mode=view
```

| Param | Rules |
| --- | --- |
| `doc` | Required for viewer. Canonical UUID string as stored in IndexedDB (`crypto.randomUUID()` shape). Reject empty, wrong type, or non-UUID. |
| `mode` | `view` = companion. Omit or other values = ordinary editor boot (W2 does not invent other modes). |

Malformed/unknown ID → viewer **missing** UI (clear message, no new empty document, no recovery wipe). Do not trust cloned sessionStorage for window identity: each load mint `instanceId = crypto.randomUUID()` (same pattern as `journalTab`).

Hash (`#…`) is reserved for #39 portable share links; comparison routing must not consume or clear it.

Pure helpers live in `src/view/route.ts` (parse/validate only in W1; wiring in W2).

### Open action

Documents menu → **Open in comparison window** (current saved document). Uses user-gesture `window.open(url)`. Browser may open a tab (phones commonly do); do not promise an OS window or side-by-side layout. If popup blocked: keep source intact, show guidance to allow popups or open the link manually—**text remains in the source window**.

Companion may later switch to another **saved** document via the Documents list without gaining write rights (W2).

## Wire-message schema (W3)

Channel name: `typebridge.documents.v1`.

Payload: JSON object, **metadata only** (no text, title, history):

```ts
type DocumentSignal =
  | { v: 1; type: 'saved'; documentId: string; revision: number; at: number }
  | { v: 1; type: 'renamed'; documentId: string; revision: number; at: number }
  | { v: 1; type: 'deleted'; documentId: string; revision: number; at: number };
```

Validation: `src/view/signals.ts`. Drop unknown `v`, bad types, non-UUID ids, non-finite revision/`at`.

### Handling rules

1. Signal is **advisory**. On accept: `getStoredDraft` (or confirm absence for delete); recheck the window’s current `documentId` and a monotonic view generation before applying.
2. Ignore stale/out-of-order revisions (apply only if `signal.revision > displayedRevision` for saved/renamed; for deleted, apply if still showing that id).
3. **Viewers** auto-refresh content/title to the committed snapshot; preserve independent scroll/selection where offsets still fit.
4. **Dirty editors** never auto-replace; show a non-destructive notice that a newer saved version exists.
5. Echo avoidance: senders may ignore their own `instanceId` if included later; never save because a signal arrived.
6. Reconcile on `focus` / `visibilitychange` → visible: reread represented document(s).
7. **Fallback** without `BroadcastChannel`: bounded visibility/focus reread only (document in ADR/UI). No busy network polling. Optional slow interval only while a viewer is visible and the channel is unavailable (e.g. ≥ 15s), documented as best-effort.

Emit after successful commit/rename path and successful delete in the editing window (W3)—not on private dirty keystrokes.

## Ownership primitive (W4)

### Choice

**Web Lock + transactional IndexedDB fence**, distinct from recovery locks.

| Piece | Detail |
| --- | --- |
| Instance | `instanceId` per page load (`crypto.randomUUID()`), never from sessionStorage |
| Liveness | `navigator.locks` name `typebridge-edit-owner:{documentId}` held while this instance is designated editor |
| Fence | New IDB object store `editOwnership` (DB version bump **additive**): `{ documentId, ownerInstanceId, fence: number, updatedAt }` |
| Write gate | Document writes (`commit*`, delete of that id, and any path that mutates that document’s stored content/title/history) run in a transaction that verifies `fence` matches the in-memory fence acquired for this instance; mismatch → abort write, enter non-editable, keep memory |
| Recovery lock | Unchanged `typebridge-recovery-owner:{journalTab}`; never reused for edit ownership |

Why not Web Lock alone: an in-flight async write could complete after release. Why not BroadcastChannel election/focus/heartbeat alone: #159 rejects those as insufficient. Why not only CAS: CAS creates conflict copies after the fact; ownership prevents cooperating tabs from writing concurrently, while CAS remains the safeguard for older app versions.

### Capability / failure

| Capability | Behavior |
| --- | --- |
| Locks + IDB OK | Normal acquire / release / fence |
| No `navigator.locks` | IndexedDB fence with heartbeat (`updatedAt`); acquire allowed if missing or heartbeat expired (bounded, documented, e.g. 30s) **and** no conflicting live cooperators can be proven; UI explains weaker guarantee; prefer read-only + copy/export when contested |
| IDB unavailable | No ownership claims; fail closed to read-only / copy guidance; existing storage warnings |

### Crash / suspend / lost owner

- Page death: browser releases Web Lock; another window may acquire (W4/W5 rules).
- Suspended tab may keep a lock until discarded—treat as live owner; no force-steal (W5).
- Stale owner wakes: lock/fence check fails → non-editable; dirty memory preserved; copy/export/recovery remain.
- Guarantee applies to **cooperating supported versions**. Older builds without ownership still only have revision CAS / conflict copies—never claim ownership controls them.

### Ordinary duplicate tabs (after W4)

Existing entry paths (including duplicate tab / direct URL without `mode=view`) participate: at most one editor per document among cooperating versions; others open read-only or must use Edit here (W5). W2 may ship viewers only without yet forcing ordinary tabs into the protocol; W4 makes the guarantee real for all paths.

## Read-only enforcement (W2+)

Not only `textarea.readOnly`. Gate:

- text/title `beforeinput` / input / IME / paste / drop / cut
- convert selection, Find Replace / Replace all, Clear, Undo/Redo shortcuts and buttons
- `scheduleSave` / `persist` / `journalEdit` / `savePending` / lifecycle flushes
- New / Import / Delete / title commits / any document-management mutation of the viewed id
- Opening/refreshing a viewer must not save, clear recovery entries for other tabs’ work beyond existing exact-match cleanup rules that do not create documents, or change the source window

Allowed: select, copy, independent scroll/caret for reading, switch among saved documents in the companion, Export of the displayed committed text, close window.

Visible chrome: title + **Saved version · Read-only** (wording may match UI.md). Status must not imply Autosave is writing from the viewer.

## Edit here / handoff (W5)

1. Viewer requests transfer (explicit control).
2. Live owner: prompt; default **Keep editing / Cancel**. Refuse while composing (IME), dirty private/unsaved that cannot be committed safely, save in flight, save failed, or conflict-copy just created—clear guidance, no silent Autosave-on, no discard.
3. Owner quiesces editing, finishes or cancels pending writes, verifies revision, releases lock + fence.
4. Requester acquires fence, rereads IDB, then enables editing.
5. If owner is gone: follow W4 recovery acquire. No force-steal from a live owner.

## UX sketches (compact)

### Desktop — Documents menu

```
┌ Document title ············· ▾ Documents  Saved  [Latin|Кир]  Focus  Settings
│ ┌─────────────────────────┐
│ │ (document list)         │
│ │ Open in comparison window │  ← current committed doc
│ │ New document            │
│ │ Import…                 │
│ │ Export as TXT / JSON    │
│ │ Delete…                 │
│ └─────────────────────────┘
└ Editor…
```

### Companion chrome (desktop / phone)

```
┌ Title (read-only)  ▾ Documents  Saved version · Read-only  [copy tools…]
└ Textarea read-only (selectable); Find OK; Replace/Convert/Undo gated off
```

Phone: same signals in the existing title row wrap; do not add a second toolbar row solely for this badge.

### No committed copy

```
┌ Cannot open comparison ─────────────────┐
│ There is no saved copy of this document. │
│ Save or export first if you want a       │
│ second window. Unsaved text stays here.  │
│                        [ Cancel ]        │
└──────────────────────────────────────────┘
```

### Edit here refused (owner dirty / private)

```
┌ Cannot edit here yet ────────────────────┐
│ The editing window still has unsaved or  │
│ private changes. Finish or export there, │
│ then try Edit here again.                │
│                        [ OK ]            │
└──────────────────────────────────────────┘
```

### Deleted / missing in viewer

```
Status: This saved document is no longer available.
[Choose another saved document…]  (does not create a new empty saved doc)
```

## Upgrade / compatibility

- Additive IDB store only; existing `documents` rows unchanged.
- Old tabs: CAS conflict copies unchanged.
- Viewers on old builds: N/A until W2 ships; mixed versions → conflict copies if both write.
- Do not close #48 when W3 lands; record remaining #48 scope on that issue.
- Reading View (#40) and dual-panel (#7) stay separate.

## Slice map and test plan

| Slice | Deliverable | Tests (minimum) |
| --- | --- | --- |
| **W1** (this PR) | ADR + pure `route` / `signals` contracts | Vitest parse/validate |
| **W2** | Open action, `mode=view` boot branch, RO gates, popup/missing/blocked storage | Unit + Playwright multi-page: same/different doc, reload, cloned sessionStorage, privacy no-write, invalid id |
| **W3** | Broadcast + reread + visibility fallback | Stale/out-of-order/missed, delete, dirty editor notice, no channel |
| **W4** | Lock + fence at write boundary; ordinary tabs participate | Simultaneous acquire, crash/release, unsupported locks, stale wake |
| **W5** | Edit here UX + refusals | Busy/dirty/IME/private/conflict; gone owner acquire |
| **W6** | Docs, ROADMAP, evidence, small cleanups | Full matrix; mark real-device/AT pending |

Playwright: Chromium, Firefox, WebKit; multiple pages in one context. Screenshots for visual chrome in W2/W6. Real OS windows, physical iPhone, real IME, VoiceOver/NVDA = manual evidence only.

## Non-goals

Live streaming of private keystrokes; focus-based ownership; cross-profile/cross-device sync; #7 dual-panel; #39 URL document sharing; backend; claiming RO is a security boundary.

## Implementation notes for later PRs

- Branch companion routing **before** `initializeDrafts` step that selects hint/most-recent/pending.
- Central `viewMode: 'edit' | 'view'` (name flexible) gating all mutation paths listed above.
- Writing position: key by `documentId` + `instanceId` (or `mode=view` namespace) so companions do not clobber editor offsets.
- Keep recovery Web Lock behavior for editors; viewers should not take recovery ownership that clears others’ journals inappropriately—prefer not writing recovery journals from viewers at all.
