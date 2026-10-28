# Draft recovery: investigation and implementation plan

Status: research for #37 and #9. This document describes observed code and proposed work; no recovery guarantee is added by this document.

## Findings on main

- `src/editor/drafts.ts` stores all drafts in one `typebridge.drafts.v1` localStorage array. `saveDraft` reads it, filters by id, appends, and writes it back. There is no revision or lock. Two tabs editing one draft can silently overwrite each other. Concurrent read-modify-write of the shared array can also lose unrelated updates.
- `read()` treats storage exceptions, invalid JSON and a non-array as an empty array and silently filters invalid entries. A later save may overwrite a corrupt or partially invalid record, destroying recoverable data. Treat corruption differently from an empty collection; retain original bytes.
- Startup chooses the saved session ID if valid, otherwise the latest draft. Issue #9 and PRD currently say a new independent tab starts blank. This mismatch needs product clarification against any later accepted decision before changing behavior.
- `persist()` is debounced 300 ms and also called on `pagehide`; it catches writes and reports failure. Startup accesses to sessionStorage/localStorage and some setting operations are not consistently guarded. UI status must not claim a save succeeded when storage failed.
- A page lifecycle event is not a crash guarantee. A crash or process kill can lose changes since the last completed save. Offline availability from the service worker and persistence of draft content are separate guarantees.
- Undo history is saved with draft state. It is an editing history, not an independent retained version or backup. A new browser, storage clearing, quota pressure or profile loss may remove all local copies.

## Browser constraints

- [Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria): quota and eviction are browser- and origin-dependent. localStorage writes can throw; persistence is not equivalent to a backup. Estimate quota only as a hint, never as a write guarantee. Offer export.
- [pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event) may not fire, especially on mobile. [visibilitychange](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event) is a useful additional opportunity to flush; neither protects against abrupt termination.
- [storage events](https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event) notify other documents, not the writing document, and are notifications rather than a transaction or mutual exclusion. A revision check alone followed by a localStorage write is not atomic across tabs.
- [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) can coordinate cooperating tabs on a secure origin, but capability and failure handling need tests. [IndexedDB transactions](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB) can make revision check and write atomic. A sessionStorage ID is not an exclusive lock; an opener may receive a copy of its sessionStorage ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)).

## Recommended staged design

1. **Prevent destructive recovery first.** Introduce explicit read states: absent, valid, malformed, unavailable. Never replace malformed or unsupported data with an empty set. Keep editor text in memory, display a persistent unsaved/recovery notice, and offer copy/export. Preserve existing bytes for manual recovery; do not auto-migrate on error. Avoid writing empty drafts merely on pagehide.
2. **Atomic conflict protection.** Move versioned draft records to IndexedDB in a subsequent reviewed implementation, keeping v1 localStorage untouched until migration commits successfully. In one read-write transaction, read the current revision, compare with the editor's expected revision, and write the next revision only on match. Use per-draft records; ensure the migration and all writers honor the same protocol. On conflict retain the local buffer and offer save as a new copy, reload the saved version, or compare; never silently overwrite. Cross-tab notifications update UI but are not the safety boundary. A tab with blocked/unavailable database must remain editable and visibly unsaved; do not fall back to unsafe writes.
3. **Recovery snapshots separate from undo.** Versioned snapshots contain draft id, timestamp, immutable text and schema version; do not automatically restore over current content. Create bounded snapshots on explicit milestones and at a reviewed cadence, deduplicate unchanged content and cap retention by count and storage budget. A restore must preserve the current version first and offer a preview/confirmation. Decide retention and performance budgets before implementation. Handle quota failure without deleting the only good copy.
4. **Lifecycle and durability.** Keep debounced saves during typing, flush pending edits when visibility becomes hidden and on pagehide where possible, and avoid duplicate no-op snapshots. Clearly show Saving, Saved locally and Unsaved/error; no promise of crash-proof or cross-device storage. Export remains the independent backup path.
5. **Migration / rollback.** Validate every v1 entry and preserve the full original v1 payload. Write and verify v2 transactionally; record a migration marker only after successful commit. Test interrupted migration, quota errors, malformed fields, older/unknown versions, re-entry and rollback. Define when the old copy may be removed in a separately reviewed retention policy.

## Acceptance tests

- Unit: valid/missing/corrupt/unsupported/blocked/quota cases; v1 data retained across failed migration; version and snapshot validation; snapshot retention and empty/no-op behavior.
- Two real browser pages: simultaneously edit the same revision with deterministic barriers; one save succeeds, the other is blocked or creates a separately named copy, and both texts remain recoverable. Repeat with distinct drafts and duplicated/opened tabs. Verify that storage events alone do not count as atomicity.
- Reload, hidden/pagehide, explicit clear, offline reload and restore-to-copy; preserve Russian, emoji and long text. Verify no write after autosave is disabled and no text lost when quota is exceeded.
- Run Chromium, Firefox and WebKit; manually verify macOS/Windows browser crash scenarios and document test limitations. Simulations of crashes or mobile viewports are not actual process/device tests.

## Open decisions

- Resolve the conflicting new-tab behavior in #9/PRD versus current implementation and later product decisions.
- Select snapshot frequency, count/size limits, retention under quota pressure and restore UI before implementing version history.
- Decide whether the first safety increment must include IndexedDB migration or can use a proven lock protocol with a safe no-lock fallback. Do not present a non-atomic localStorage read/check/write as conflict protection.
