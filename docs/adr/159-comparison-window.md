# ADR: Comparison window and single editing owner (#159)

Status: **Accepted for implementation** (W1); **W2 read-only companion implemented** (see [W2 implementation notes](#w2-implementation-notes)); **W3 saved-version signals implemented** (see [W3 implementation notes](#w3-implementation-notes)); **W4 single editing owner implemented** (see [W4 implementation notes](#w4-implementation-notes)). Implements in sequential PRs W2–W6 on `main`. Does **not** close #159, #48, #40 or #37.

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
| `doc` | Required for viewer. Stored IndexedDB id: UUID or `recovery-<uuid>`. Reject empty or other shapes. |
| `mode` | `view` = companion. **Only** omit/empty `mode` → ordinary editor boot. Any other mode value is invalid and takes the no-write missing/error path (never `initializeDrafts`). `mode=view` with a missing or malformed `doc` shows the viewer **missing** state. |

Malformed/unknown ID → viewer **missing** UI (clear message, no new empty document, no recovery wipe). Do not trust cloned sessionStorage for window identity: each load mint `instanceId = crypto.randomUUID()` (same pattern as `journalTab`).

Hash (`#…`) is reserved for #39 portable share links; comparison routing must not consume or clear it.

Pure helpers live in `src/view/route.ts` (parse/validate only in W1; wiring in W2).

### Open action

Documents menu → **Open in comparison window** (current saved document). User-gesture open must **not** clone the source tab’s `sessionStorage` (Firefox can copy it when an opener relationship exists), so private pending text never arrives in the companion. Implementation: `window.open('about:blank')`, strip `typebridge.*` session keys in the new context, `opener = null`, then `location.replace` the viewer URL (absolute). If inherited-session cleanup throws, **fail closed**: close the blank window, do not navigate, and do not claim that unsaved typing was not sent. This preserves accurate popup-blocked detection (`null` means blocked); `noopener` alone is unsuitable because it returns `null` even on success. Browser may open a tab (phones commonly do); do not promise an OS window or side-by-side layout. If popup blocked: keep source intact, show guidance—**text remains in the source window**. Never clear the source tab’s backups to solve this.

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
| No `navigator.locks` | **Viewer only.** The client never acquires editing ownership and never takes over a record by heartbeat expiry (see mixed-ownership rule below). UI explains that editing needs a browser with Web Locks; read, copy and export stay available |
| IDB unavailable | No ownership claims; fail closed to read-only / copy guidance; existing storage warnings |

### Mixed ownership: Web Locks and fallback clients (maintainer P2 from #160)

A client with `navigator.locks` and one without can both be open on the same document. The fence record's `updatedAt` heartbeat can lapse while a lock-backed owner is throttled or suspended even though its Web Lock is still held. If a no-Web-Locks client treated that stale heartbeat as permission to acquire, it would take over a live owner, which breaks the single-owner guarantee.

Decision (safest initial option): **clients without Web Locks remain viewers.**

- Only a client with `navigator.locks` may acquire; `mayAcquireEditOwnership(webLocksAvailable)` in `src/view/ownership.ts` encodes this. W4 must call it with the capability, not with a stored record.
- `ownershipHeartbeatExpired` and `EDIT_OWNER_HEARTBEAT_MS` are **diagnostic only** (for example, explaining a possibly stale record). They are not an acquisition rule, and `canAcquireWithoutWebLock` was removed so it cannot be misused.
- Lock-backed owners may still write the optional heartbeat for diagnostics; fallback clients never rely on it to claim ownership.
- A future cooperative fallback (for example, one that proves exclusion some other way) needs a new ADR; it is out of scope for W4.
- W2 viewers never acquire ownership regardless of capability.

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
| **W2** (implemented) | Open action, `mode=view` boot branch, RO gates, popup/missing/blocked storage | Unit + Playwright multi-page: same/different doc, reload, cloned sessionStorage, privacy no-write, invalid id |
| **W3** (implemented) | Broadcast + reread + visibility fallback | Stale/out-of-order/missed, delete, dirty editor notice, no channel |
| **W4** (implemented) | Lock + fence at write boundary; ordinary tabs participate | Simultaneous acquire, crash/release, unsupported locks, stale wake |
| **W5** | Edit here UX + refusals | Busy/dirty/IME/private/conflict; gone owner acquire |
| **W6** | Docs, ROADMAP, evidence, small cleanups | Full matrix; mark real-device/AT pending |

Playwright: Chromium, Firefox, WebKit; multiple pages in one context. Screenshots for visual chrome in W2/W6. Real OS windows, physical iPhone, real IME, VoiceOver/NVDA = manual evidence only.

## W2 implementation notes

Shipped in `src/main.ts` (plus `Editor.setReadOnly`, `writing-position`, `confirm-dialog`, `index.html`):

- **Boot order:** the query string is parsed before anything else. A viewer route runs `initializeViewer()` instead of `initializeDrafts()`: it opens IndexedDB, reads **only** the requested id with `getStoredDraft` (plus the list for the Documents menu), and shows it. It never reads the active-document hint or pending reload snapshot, never restores, never takes the recovery Web Lock, never calls `renderRecovery`, and never creates a document. Missing, malformed, unknown `mode`, or storage-failed routes show the missing/no-write state and keep the list available. Viewer boot must **not** delete `pendingDraft`/`activeDraft` (same-tab editor→viewer navigation relies on those keys for reload restore).
- **Open action:** Documents → **Open in comparison window** builds `comparisonViewerHref(...)` (UUID or `recovery-<uuid>`) and calls `openComparisonWindow(href)`: `window.open('about:blank')`, strip every `typebridge.*` session key in the new context, set `opener = null`, then `location.replace` the absolute viewer URL. Eligibility is the in-memory revision (`>= 1`) so the click stays synchronous; the companion re-verifies the row. If cleanup throws, fail closed (close blank window, do not navigate, do not claim unsaved typing was not sent). A blocked pop-up (`null`) announces guidance and leaves text in place. No committed copy / no storage → Cancel-only info dialog; Autosave is never enabled.
- **Read-only gates (`viewMode`):** text and title `readOnly`; `Editor.setReadOnly(true)` refuses `beforeinput`, paste, cut, drop, undo/redo (buttons, shortcuts and native history), convert, replace, replace-and-select and clear; Undo, Redo, Convert, New, Import, Delete, Clear, Replace and Autosave controls are disabled and their handlers also return early; `scheduleSave`, `persist`, `journalEdit`, `savePending`, `rememberActive`, and the `pagehide`, `beforeunload`, `visibilitychange` and recovery `storage`/interval wiring are skipped or no-ops in viewers.
- **Chrome:** a **Saved version · Read-only** badge replaces the save indicator (wraps on narrow/enlarged text); the status line says nothing is saved from this window. Switching to another saved document (including `recovery-*` ids) uses `getStoredDraft`, keeps the viewer read-only, and updates the address with `history.replaceState` (hash preserved for #39).
- **Identity and position:** `instanceId = crypto.randomUUID()` per load, never from sessionStorage (exposed as `data-instance-id` on `<html>` for viewers only, for tests). Writing position uses the `view:` key namespace (`typebridge.writingPosition.v1.view:{id}`), so a viewer never reads or overwrites an editor's offsets.
- **Not in W2:** no BroadcastChannel (added in W3; before it a viewer stayed on its loaded revision), no ownership acquisition or fence (W4), no Edit here (W5). Ordinary tabs are unchanged and can still race with each other; CAS conflict copies remain the safeguard.

## W3 implementation notes

Shipped in `src/main.ts` and `src/view/signals.ts` (`createDocumentSignal`, `decideReread`, `SIGNAL_POLL_INTERVAL_MS`), `index.html` (`#version-notice`), and `e2e/saved-signals.spec.ts`:

- **Emit (editing windows only):** after a successful IndexedDB commit in `persist` (`saved`, or `renamed` when only the title changed and the text did not), after a successful Delete document and after Delete saved copy when Autosave is turned off (`deleted` with the removed revision), and after Import and recovery-copy commits (`saved` for the new id). Viewers never post. Payloads are exactly `{ v, type, documentId, revision, at }`: no text, title, history or instance id. Autosave-off privacy mode never commits, so it never signals. A conflict copy signals `saved` for the copy id only.
- **Receive:** `parseDocumentSignal` → `shouldApplyDocumentSignal` → `rereadDisplayed()`, which reads the row with `getStoredDraft` and decides with the pure `decideReread`. The signal’s revision is never trusted for content; an inflated revision just causes a reread that finds nothing newer. Results apply only if a monotonic `viewGeneration` (bumped whenever the displayed document changes) and a reread sequence number still match, and `active.id` is unchanged. An editor with a local commit in flight waits for it first so its displayed revision is current.
- **Viewers:** newer committed revision → `showViewerDocument` (content and title replaced; writing position saved before and restored/clamped after via the existing `view:` namespace); row absent or uncommitted → the missing state. The badge exposes the represented revision as `data-revision` and a tooltip (“Saved revision N”). The viewer’s Documents list is refreshed (debounced 250 ms) on any signal, focus and visibility. Status line: “Updated to the latest saved version. Nothing is saved from this window.”
- **Editors:** never replaced. A newer committed revision, or deletion of a document that has a committed revision here, shows `#version-notice` (“A newer saved version of this document exists in another window. Your text here has not been changed.” / “This saved document was deleted in another window. …”). It clears on switching documents or after this window’s own next commit (which, if the versions diverged, already surfaces the conflict-copy notice). Ordinary editors with no committed revision (new or privately kept documents) get no notice. Clean editors are also only notified (no auto-refresh), since automatic replacement belongs with ownership (W4/W5).
- **Reconcile:** `focus` and `visibilitychange` → visible reread the displayed document (viewers and editors). Without `BroadcastChannel` that is the only mechanism, plus a `SIGNAL_POLL_INTERVAL_MS` (15 s) timer for viewers that is a no-op while the page is hidden. There is no polling when the channel exists.
- **Echo:** a `BroadcastChannel` object never delivers to itself and the receive path only reads, so a signal cannot trigger a save. `instanceId` is not on the wire (extra fields are dropped by the parser).
- **Remaining #48 scope (not closed by W3):** editor-to-editor behaviour is notice-only (no merge or auto-refresh of clean editors, no ownership; see W4/W5); editors’ Documents lists are not refreshed from signals; no signal for settings or other preferences; no cross-device sync. #48 stays open for these.

## W4 implementation notes

Shipped in `src/editor/edit-ownership.ts` (`acquireEditOwnership`), `src/editor/indexeddb.ts` (fence-gated writes, `claimEditOwnership`, `releaseEditOwnership`), `src/view/ownership.ts` (`EditBlock`, `editBlockGuidance`, `mayRetryEditOwnership`), `src/main.ts`, `index.html` (`#ownership-notice`), and `e2e/edit-ownership.spec.ts`:

- **Storage:** database version 2 adds the `editOwnership` store (`keyPath: 'documentId'`) in `onupgradeneeded`; `documents` rows are untouched. Tabs still running version 1 code get the existing “Storage was upgraded in another tab” warning; a version 1 build opened after the upgrade cannot open the database and shows its storage-unavailable path.
- **Acquire:** `navigator.locks.request('typebridge-edit-owner:{id}', { ifAvailable: true })`, then, under the lock, a transaction that writes `{ documentId, ownerInstanceId: instanceId, fence: previous + 1, updatedAt }`. It never waits for or steals a held lock. Without `navigator.locks` (`mayAcquireEditOwnership(false)`) the result is `unsupported`. If the fence claim fails (a storage error), the lock is kept and the claim is retried before the first write (`writeFence()`); the write then fails through the ordinary **Save failed** path rather than blocking typing.
- **Write gate:** `commitOrCreateConflictCopy` and `deleteStoredDraft` accept the owner's `{ instanceId, fence }` and read the fence record in the **same transaction** as the revision check. A mismatch (record names another window, a different fence, or a released record) throws `EditOwnershipLostError` and aborts the transaction: no commit, no conflict copy, no delete. Revision CAS still runs after the fence check, so a build without ownership that writes the same document still turns the owner's next save into a conflict copy. When a conflict copy is created the window acquires the copy's ownership before any further save and releases the original.
- **Who participates:** every ordinary boot (`initializeDrafts`), document switch (`switchDraft`, including New and Import), Delete (the replacement blank document) and conflict copy. Boot and switch acquire the target first, then reread it under the fence before enabling editing, then release the previous document. While ownership moves, the text and title are frozen (`readOnly`) so a keystroke cannot land in the document being left. Import and recovery copies create brand-new ids with revision 0 CAS and need no fence; the window acquires them when it opens them.
- **Read-only ordinary window (`editBlock`):** `busy` (lock held elsewhere), `lost` (fence/lock taken while owning), `unsupported` (no Web Locks), `error` (lock request failed). `Editor.setReadOnly` and the title editor gate input; Delete, Clear, Convert, Replace, Undo/Redo and the Autosave toggle are disabled; `persist`, `scheduleSave` and the delete paths return early. New document, Import, switching, Find, Copy, Export, Open in comparison window and recovery stay available. `<html data-role>` is `editor` or `reader` (`viewer` in companions), and `data-instance-id` is now set for every window. Guidance is in `#ownership-notice`; the save indicator reads **Read-only** (or **Not saved** with unsaved text) and the status line carries the risk text.
- **Loss:** a fence mismatch in `persist` or a delete, or the browser taking the lock (`steal`, AbortError on the held request), calls `loseOwnership()`: no further writes, pending timer cleared, text/title/history stay in memory, and the guidance says the changes were not saved. The tab’s reload snapshot (`pendingDraft`) and recovery journal written earlier are kept; `pagehide` still writes the reload snapshot. A reload restores that text read-only if another window still owns the document. Switching away asks before discarding it.
- **Retry:** `busy`, `lost` and `error` windows retry `ifAvailable` acquisition on window `focus`, `visibilitychange` → visible and focusing the text (never on a timer). The retry is single-flight and awaits the authoritative reread before capturing `viewGeneration` and acquiring, so applying a newer snapshot (or a second focus/visibility event) cannot bump the generation under an in-flight acquire and leave the window stuck read-only. A clean window then rereads again under the new fence before enabling editing; if that row is gone (deleted elsewhere), ownership is released and the deleted notice is kept—never editing a ghost snapshot. A window with unsaved text keeps it and saves through CAS (a conflict copy if the document moved on). `unsupported` never retries.
- **Release:** switching documents releases the previous fence (record set to `ownerInstanceId: ''`, fence value kept so the next owner's fence increases; removed when the document has no stored row) and then the lock. Deleting a document removes its fence record in the delete transaction. Closing or crashing relies on the browser releasing the Web Lock; the next owner's claim raises the fence, so a stale page that wakes cannot write.
- **Readers follow saved versions:** a clean read-only ordinary window treats a newer reread like a viewer (content replaced, status “Updated to the latest saved version.”); a deleted document shows the existing deleted notice instead of blanking the text.
- **Viewers** never call `acquireFor`; their focus/visibility rereads never take a lock.
- **Recovery lock** `typebridge-recovery-owner:{journalTab}` is unchanged and separate.
- **Storage unavailable:** with no IndexedDB, no ownership is claimed and the window stays editable with the existing storage warnings (nothing can be written, so there is nothing to protect). This keeps transliteration typing usable when storage is blocked; the ADR capability table's “fail closed to read-only” is narrowed to “no document writes”.
- **W3 follow-ups folded in:** a signal or focus reread that arrives while a window is still initializing is replayed once it is ready (`rereadAfterInit`); choosing a vanished document in a viewer keeps its id in the address (`syncViewerUrl`) so a reload shows the same missing state.
- **Not in W4:** no Edit here / handoff prompt (W5); no force-steal; no automatic acquisition while hidden; Documents lists of editors are still not refreshed from signals (#48). bfcache restore is covered by the fence only (no explicit re-verification on `pageshow`).

## Non-goals

Live streaming of private keystrokes; focus-based ownership; cross-profile/cross-device sync; #7 dual-panel; #39 URL document sharing; backend; claiming RO is a security boundary.

## Implementation notes for later PRs

- Branch companion routing **before** `initializeDrafts` step that selects hint/most-recent/pending.
- Central `viewMode: 'edit' | 'view'` (name flexible) gating all mutation paths listed above.
- Writing position: key by `documentId` + `instanceId` (or `mode=view` namespace) so companions do not clobber editor offsets.
- Keep recovery Web Lock behavior for editors; viewers should not take recovery ownership that clears others’ journals inappropriately—prefer not writing recovery journals from viewers at all.
