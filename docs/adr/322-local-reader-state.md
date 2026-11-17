# Local shared library and reader state (#322)

Status: research baseline below. #323 library and #324 shared numeric inputs are implemented;
#326 editable inputs and #327 quiz persistence remain later work. The implemented #324 bounds
are 256 inputs / 64 KiB per shared item, within the 100-item library, superseding the proposed bounds below. Evidence below records the research
baseline, not a current feature inventory.
Evidence baseline: main `67a2f35`, ActiveMD packages pinned to `0.4.0`.
Delivery order: #323 → #324 → #325 → #326; #327 waits for active-md#48.

## Evidence and boundaries

`read/main.ts` decodes before displaying, uses generation checks for navigation, and opens
IndexedDB only in `saveCopy`. That function always creates a new draft. `share-link.ts`
validates version, compressed/decompressed size and shape; unknown valid formats retain
source fallback. `active-renderer.ts` owns the runtime but returns only messages/destroy;
`markdown-view.ts` destroys it on view/source/document changes. The installed runtime's
public `Mounted` exposes session, program, settled() and destroy(). Session exposes
inputValues(), validated set(), reset() and subscribe(). Mount performs an initial refresh
before returning; it has no initial-input/batch-restore option. These are observed APIs,
not a promise about future quiz/event initialization.

Draft database version 6 holds documents, editOwnership and changes. Its versionchange
handler closes connections; global clear deletes the entire `typebridge` database.
`privateSessionOn()` uses its last successfully observed value when a preference read fails;
without a cached value it defaults to private. A cached non-private value can therefore
survive a failed read. The stricter proposed reader-write gate below must separately
track read success rather than treating this helper as proof of a successful read. Per-document private
flags and revision-zero private identities must remain protected. Existing host activation
can show an already-open document but does not prove its in-memory source equals its row.

## Identity

For #323, identity is the exact validated version-prefixed payload returned by
sharePayloadFromHash, independent of /#doc versus /read.html#doc routing. Do not recompress
or normalize it. Different compressed payloads, even if their decoded fields are equal,
are separate received items. Changed presentation/edit hints are separate items too.
This conservative policy retains original links and makes reset/removal unambiguous.

Use SHA-256 only as a lookup bucket, then compare the complete payload in a readwrite
transaction. Collision buckets may contain multiple records; never overwrite a different
payload with the same digest. Use an opaque local item ID for sidecars/UI, not content in
a server-visible path/query. Reopen with /read.html#doc=<original payload>. Exact title,
source, format and hints come from decoding, including unknown-format fallback.

Editable equality (#325) is deliberately different: compare effective imported title,
exact text and documentFormat using one shared import-fields helper. Preserve the current
blank-title fallback and actual import trimming policy; do not add normalization. Hints,
reader values, history and provenance are excluded. Among provably safe exact matches,
choose lexical document ID for all rows, including legacy documents. StoredDraft has
updatedAt, not createdAt; neither updatedAt nor enumeration order represents creation
time, and this policy requires no creation-timestamp migration. An unrelated exact local match
is eligible; a formerly imported but changed document is not.

## Storage and limits

Add sharedItems and readerStates stores to the existing database in #323, using a schema
upgrade that preserves every existing document, fence and change record. No new database
or persistent content in localStorage. Shared item: local ID, digest, exact payload,
createdAt, lastOpenedAt and payload byte count. Decode on reopen rather than storing a
second mutable copy of the source. Reader state is a separately versioned sidecar keyed
by namespace (shared/editable) and stable item/document ID, with revision and bounded
finite numeric input pairs. Do not persist computed values or arbitrary object graphs.

Proposed explicit bounds: 100 shared items, 10 MiB total UTF-8 payload bytes; each input
sidecar at most 1,000 named values and 128 KiB serialized UTF-8; total sidecars 10 MiB.
Reject an oversize state as a whole and use defaults, with honest feedback. On automatic
remembering, do not silently evict sources or reader answers: at capacity leave this item
memory-only and offer removal of old items. Do not evict editable drafts. Reopening updates
lastOpenedAt in the same atomic payload-match transaction. Quota/blocked/upgrade failure
leaves reading usable and says it was not remembered. Never log payloads or answers.

## Privacy and deletion

Add a default-on app preference “Remember shared documents and reader inputs on this device”.
Expose it on the reader as well as Settings; explain automatic local remembering before
claiming the feature shipped. Global Private session overrides it. A failed preference
read denies content writes. Turning either gate off immediately cancels queued writes and
keeps subsequent state in memory; existing saved items remain until explicitly removed.
Turning it back on must not retroactively persist changes made while private: require an
explicit remember/save-current-state action or a new eligible open. Share links already
in browser history are outside this erasure promise.

Editable input state additionally follows document Autosave/privateNow, with no persistent
identity for a new private document. No input values enter Markdown, source dirty state,
Undo/Redo, export, share URLs, change logs or crash/reload source backups. Source persistence
and reader persistence have separate lifecycles. Memory values survive Preview remounts
while the document is open, including private documents.

Removing a shared item atomically removes its sidecar; editable copies are independent.
Deleting an editable document removes its sidecar, never a shared item. Reset to authored
defaults clears/replaces only that reader's state. Source discard restores source through
the existing flow and revalidates compatible inputs; it is not an implicit input reset.

Global clear includes both new stores through existing database deletion. Every new
connection must close on versionchange; cancel timers/subscriptions and suppress final
flushes before cleanup completes. Old readers must stop remembering/writing and follow
the successful-clear reload lifecycle. The fresh page may display the URL source but must
not automatically reinsert that old item after a clear: consume a one-load cleared notice
and require explicit Remember for that existing link. Partial failures retain retry and
must not report completion. The separately tracked host-layout race in #168 remains open;
this work must not claim to fix it or add replacement bootstrap paths.

## Restore and synchronization

In #324 load the sidecar and renderer under the current navigation generation. Mount into
a connected but non-visible staging container, apply only names in inputValues() through
validated set(), then await settled() before revealing it. Validate finite numeric values
and both model bounds and any narrower authored control bounds; skip unknown/incompatible
entries. Do not scrape DOM values as the state model. Subscribe for persistence only after
restore, and never record rejected intermediate control text. Test that initial controls,
values, math and conditional visibility agree. Keep the loading/failure message accessible;
failed restore uses defaults and rendering failures retain source fallback.

This can hide intermediate refreshes for today's 0.4.0 model, but cannot promise precedence
over future initialization events. Before supporting those events, require a public
ActiveMD initial-input or bounded batch-restore hook that applies restored values before
session-start events/first refresh. Request/link that prerequisite if the then-pinned API
cannot supply it; never patch package internals. Explicit reset/new-variant events may
replace restored state. Quiz/graded snapshots remain deferred to #327.

Proposed multi-tab policy: document-scoped state, whole-snapshot compare-and-swap revision;
500 ms debounce, best-effort flush on visibility/pagehide with no durability guarantee.
Notify with IDs/revisions only, read authoritative state from IndexedDB. A stale writer
must not overwrite the winning revision: retain local values in memory, show a conflict
notice and offer explicit Load saved values or Keep these values (retry against current
revision). Do not silently merge input sets or apply remote changes mid-interaction.
Removal/reset bumps or tombstones the revision while open mounts exist so a queued old
save cannot resurrect state; global clear also invalidates all pending generations.
Bound tombstones under the same retention policy and define safe retirement before code.

#326 reuses this adapter, keyed by editable document ID rather than source hash. Compatible
names survive punctuation/title/formula edits; setters and current bounds decide validity.
Capture and unsubscribe before destroy, keep memory state per document and reject stale
async completions. Ownership loss freezes persistent writes; handoff/remount rereads the
sidecar revision and transfers memory values only through an explicitly validated existing
handoff path. No second writer bypasses source ownership fences.

## Safe editable-copy reuse (#325)

Do not equate a matching stored row with a matching active editor. Under one transactional
matching/create protocol, verify exact fields and revision and exclude private or owned
candidates unless the owner provides a fresh, fenced, revision/content-identity response
confirming the current in-memory effective fields. Recheck at activation; never yield,
overwrite or discard private/dirty content to deduplicate. Unreachable owners, changing
revisions, deleted candidates or uncertain equality choose a new independent copy.

Concurrent readers must coordinate candidate selection/create with the same IndexedDB
readwrite serialization and ownership store; UI click suppression alone is insufficient.
An owner must participate in this protocol or remain ineligible. Define its handshake in
#325 before implementation, with negative controls proving dirty owner exclusion. Existing
host openDocument activation/cap handling remains the presentation path. Report “Opened
existing document” versus “Saved a new copy” accurately; saving can succeed when four
windows prevent opening. Sender-disabled Edit remains disabled.

The [active-owner protocol proposal](330-active-owner-reuse.md) records the bounded
confirmation/activation contract for #330. It is not implemented; the safe fallback
from #329 remains in force until separately reviewed implementation ships.

## Acceptance matrix and review gates

| Slice | Required regression evidence |
| --- | --- |
| #323 | Both routes, repeats and concurrent tabs deduplicate; deliberate digest collision; different compression/hints stay distinct; invalid/oversize leaves no row; keyboard list/reopen/remove; unknown format; capacity/quota/private/opt-out; offline shell prerequisite; plain loads no renderer; clear does not repopulate. |
| #324 | Visible and model-only inputs; accepted/rejected edits; initial controls/math/when agreement; reload/offline; item isolation; invalid schema/name/type/range/size; reset/remove races; CAS conflicts; late navigation/destroy and storage refusal. |
| #325 | Exact content/title/format and blank-title policy; unrelated/multiple matches; changed stored or dirty/private owner; stale handshake/deleted row; rapid/concurrent clicks; activation/four-window cap; Edit disabled. |
| #326 | View/remount/restart; compatible source edits; identical source/different IDs; private new/existing docs; ownership/handoff; reset/discard/delete/clear; stale generations; plain no renderer. |
| #327 | Blocked until supported quiz snapshot/restore API; stable answer IDs, unanswered/draft/submitted state, reorder/edit compatibility, deterministic seed/order and event state. |

Each implementation gets its own PR, independent review and exact-head quality plus
Chromium/Firefox/WebKit CI. Preserve existing safety assertions. Deployment of the checked
main artifact is separate from PR CI and from manual device/assistive-technology evidence.
The numerical limits and UI/privacy policies here are proposed decisions for review, not
measurements or already-shipped guarantees.
