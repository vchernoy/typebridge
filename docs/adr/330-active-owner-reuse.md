# Active-owner shared-copy reuse (#330)

Status: hosted owner endpoint and shared Edit requester UI are implemented.
Final review, exact-head CI and deployment are tracked in #330. Research baseline: main `7c6cccc` (#329).
The pure core validates metadata, bounds in-memory offers/outcomes, prevents duplicate
activation within retained outcomes, and models indeterminate requester results with
explicit status reconciliation. Unit tests cover expiry, cancellation, capacity,
identity mismatch, partial failures and lost/late results.
`src/view/shared-copy-owner.ts` adds an opt-in owner-side controller and dedicated
BroadcastChannel transport. It reserves bounded ledger entries before asynchronous
inspection, reruns synchronous live eligibility before activation, invalidates work
by lifecycle generation, aborts timed-out/cancelled inspections, and replays terminal
outcomes for status/duplicate commits. `editor-shared-reuse.ts` installs the controller in hosted editing windows only.
Its real adapter uses the existing connection, non-mutating held-fence credentials,
current source/title/format, successful current privacy read, local recovery inspection,
IME/save/transition gates and exact host activation. Stored fences alone never authorize
activation. Ownership object, database and workspace/storage generations must survive
the asynchronous inspection unchanged.
At most 16 unsettled inspections are retained, including providers that ignore abort;
a stuck provider can exhaust those slots until it settles or the page is destroyed.
Invalidation never frees an unsettled slot early or lets its result activate later.
`inspectOwnedSharedCopy` reads document, owner fence and change-log keys in one
readonly transaction on the caller's existing connection. It rejects missing/private,
revision/fence mismatches, unsupported formats and unapplied records, and returns
only local source/identity evidence (no history). Abort cancels inspection; no save,
claim, release, pruning, schema or connection lifecycle changes are performed.
`sharedReuseReady` compares fresh live source/title/format and owner/revision/fence
against that snapshot, requiring positive storage/privacy/recovery/activation evidence
and refusing dirty/composing/saving/transition states. The hosted adapter supplies current evidence, including a successful
privacy read and credentials from the currently held ownership object.
The host now exposes separate `hasExistingEditor` / `activateExistingEditor` hooks.
They require the exact live iframe Window, window ID and live document probe, refuse
modal/closing/cleared/unavailable hosts, and never fall back to session/layout identity
or open a new window. Activation only selects the existing host window (including in
Focus and at the four-window cap, maximizing the selected window while preserving
its pre-Focus geometry for restoration); it does not promise browser foreground focus.
The hosted owner controller invokes these hooks after the final live check.
User edit/action events, preference changes and navigation invalidate offers; pagehide
closes the channel, pageshow recreates it for restored pages, and storage clear disposes
it permanently. Reuse probes never call writeFence or acquire/save/flush anything. A memory-only
journal snapshot left behind after durable cleanup is not pending recovery when its
fields exactly match the current clean document; observable persisted backups still
block reuse. No journal is removed or modified by the adapter.
Reader transport/UI and full shared-Edit cross-tab acceptance regressions remain #330
work. Browser protocol tests exercise real BroadcastChannel offer/commit/status traffic,
private/blocked preference refusal, untracked live edits and post-offer cancellation. These modules do not provide
durable exactly-once execution across owner restart/outcome retirement.
The safe fallback and observable-backup exclusions from #325 remain unchanged.

Reader-side groundwork now includes `listOwnedSharedCopies` (readonly, exact public
matches with observed recovery/pending-change exclusions, lexical identity ordering,
at most 16 metadata candidates) and `ReaderOwnerReuse`. The transport requires an
injected fresh verification before one commit, tries buffered offers serially when
a candidate fails that verification within the shared selection budget, and bounds
pre-commit and result waits. The caller passes the original Edit-click deadline so
candidate lookup cannot renew that budget. Metadata probes use deterministic candidate order; the
first freshly verified responder wins, without promising the lowest-ID owner always
responds first. The transport keeps post-commit silence/transport errors unknown, permits only same-nonce explicit
status reconciliation, and closes its listener after bounded retention. Cancellation
is abandonment, never proof of remote non-activation; `hasCommitted` remains available
so the UI can preserve that warning. No candidate source/title is transported.
`read/edit-shared.ts` now invokes these helpers with fresh current context, privacy,
source and recovery checks, including a final synchronous pre-commit gate. It cancels
on hash/navigation/clear or privacy changes. Owned success keeps the reader usable and
reports internal host selection without promising foreground browser focus. Unknown
results block repeated Edit; Check status sends only the old identity. Create new copy
requires an in-page warning/confirmation and starts a separate action that bypasses
reuse. Late old replies cannot navigate or complete that new action.
In-memory unresolved warnings are retained for up to 16 shared keys across restored
page/history contexts. If that bound is exhausted, the page conservatively requires
a warned copy action instead of evicting uncertainty and silently allowing fallback. If
navigation abandoned its transport, Check status is disabled and the warning explains
that limitation. There is no protocol persistence across full reloads. Candidate and
copy continuations are generation/hash guarded; unowned copy transactions accept an
abort signal and current-context predicate, including a check after add request success
before transaction completion. A transaction already committed before cancellation is
not undone by later navigation. Rendered presentation read-only is not treated as a
lifecycle freeze: clean held owners can be selected without remounting either renderer
or resetting either surface's temporary calc inputs.

## Observed constraints

- `reuseOrCreateSharedCopy` intentionally excludes every named owner, even one with
  an old heartbeat. Heartbeat expiry never proves that a suspended Web Lock ended.
- A committed exact match does not prove equality of an editor's live fields.
- `focus-handoff.ts` can park/release an owner and ultimately offer explicit stealing.
  Shared Edit must not invoke that operation: it needs confirmation and activation,
  not ownership transfer. Reuse the validation style, not the yield message types.
- `host/window-manager.ts` can activate a document inside its own host. It has no
  guarantee of foregrounding another browser tab. A BroadcastChannel reply cannot
  grant a popup/focus capability or prove that a browser accepted window.focus().
- Existing document signals and cross-tab handoff carry metadata only. Private
  text/title/history must not be added to them or logged.

## Proposed eligibility contract

The reader first obtains an exact committed candidate using the shared import-fields
helper (title, text, effective format), plus document ID, revision, owner instance and
fence. Keep the deterministic candidate order and recovery exclusions from #329.
A content hash alone is not evidence of live equality.

An owner can confirm only if all of these hold:

1. It still owns that document under the requested instance/fence.
2. Its fresh committed row still matches the requested revision and owner record.
3. Its current effective source/title/format equal its committed snapshot. Inspect
   the live controls/model, not only a stale StoredDraft object or a dirty flag.
4. It is non-private, not composing, not switching/deleting/reloading, and has no
   pending save, recovery or source mutation that makes equality uncertain.
5. Its host can activate the exact owning editor without replacing another document.

An unsupported old client, standalone owner without a supported activation path,
missing owner, failed storage inspection or any uncertainty is ineligible. Do not
force a flush/save, discard edits, reset inputs, release locks or change privacy to
make an owner eligible. The old safe-create path remains available under the
pre-commit/confirmed-refusal rules below; a post-commit timeout is not a refusal.

## Two-phase metadata-only exchange

Use a dedicated versioned protocol, separate from edit-yield/handoff. Proposed
messages contain only document ID, committed revision, owner instance/fence,
requester nonce, request nonce, phase and bounded expiry metadata. No document text,
title, history, recovery bytes, reader inputs or content-derived fingerprint travels.
The requester already verified source equality against the row; the owner checks
its own live-versus-committed equality.

1. **Probe:** reader sends the candidate identity and expected revision/fence. Only
   the matching owner may respond with a short-lived offer for that request.
2. **Commit activation:** reader accepts that exact offer. Owner rereads the row and
   fence, then rechecks live state and lifecycle generation after every await.
   The final local equality/readiness check and internal editor activation must have
   no asynchronous gap. A probe reply alone never authorizes reuse.
3. **Result:** owner reports activation success or generic refusal, echoing the
   complete request/offer identity. Reader accepts only its current outstanding
   request. Late, duplicate, wrong-owner, wrong-fence and wrong-generation replies
   cannot complete a different Edit action.

## Timeouts, cancellation and indeterminate outcomes

Separate **no commit sent** from **commit sent, result unknown**. DOM activation and
its acknowledgement are not one atomic distributed operation. No finite reply timeout
proves that the owner did not activate.

| Reader state | Allowed next action |
| --- | --- |
| Probing; no activation commit sent | Timeout/cancel can use the safe #329 fallback. A probe alone cannot activate. |
| Activation commit sent | Wait for a terminal result; on timeout enter indeterminate state, never automatically create a copy or commit another candidate. |
| Confirmed activated | Report existing-editor activation; never create a fallback copy for that action. |
| Confirmed refused/cancelled before activation | The safe #329 fallback is allowed. The owner must retain a terminal non-activation outcome that rejects delayed/duplicate commits for that same offer. |
| Indeterminate | Keep the reader usable, offer explicit status reconciliation or a warned Create new copy action. Missing, expired or unknown status is not confirmed refusal. |

Proposed bounds: a 2-second pre-commit selection budget for an Edit click, at most 16
candidate probes and 16 in-flight offers per owner. Each offer expires at the earlier
of its 2-second TTL and the selection deadline carried by the exchange; a commit must
pass expiry checks when processed, not merely when sent. After sending commit, a
2-second response wait ends in indeterminate state rather than automatic fallback.
These are lifecycle timers, not proof that a remote DOM action did or did not occur.
No background polling, unbounded retry, stealing or heartbeat-based suspension inference.

The owner maintains a bounded in-memory outcome table keyed by the full requester,
request, offer, document, owner instance/fence and revision identity. Reserve a slot
before issuing an offer. Proposed limits: 64 total reserved/terminal entries, terminal
retention 60 seconds; refuse new offers at capacity instead of evicting a live reservation.
Mark a commit executing before invoking the local activation hook, then record its
terminal result before sending a reply. An exception or partial hook failure after an
activation may have happened remains unknown, not terminal refusal. Repeated commits
return the recorded result (or unknown while executing) and never invoke activation again. Once an offer expires or its result is
retired, an old commit cannot create a fresh offer or execute again. Owner restart,
cache expiry or an unknown nonce yields **unknown**, not a fabricated refusal.

Reconciliation is an explicit user-requested, bounded status query for the exact old
identity, with at most a 2-second response wait. It does not send another commit or
refresh an expired offer. A recorded activation resolves success; a recorded terminal
non-activation resolves refusal. A lost/unknown status leaves the reader indeterminate.
Repeated Edit clicks in this state do not silently start another activation attempt.
The UI says “Activation status is unknown. The document may already be open.” It can
offer “Check status” and “Create new copy”, with a warning that the latter may create
a duplicate. Explicit copy creation is a new user action with a new nonce, not success
or failure attributed to the unresolved old request; late old replies cannot navigate
or change the new action's result.

Cancel on navigation, changed share payload, private transition, storage clear, document
switch and destroyed owner/reader. Before commit, cancel removes the outstanding probe.
After commit, cancellation is best effort: a positive cancel acknowledgement permits
fallback only if it records terminal cancellation before any activation and rejects any
later commit for that offer. If activation already occurred, return that outcome; do not
claim to undo selection. Without acknowledgement, or if the requester is destroyed,
activation may have occurred or may still occur when an already-sent commit is processed.
Requester teardown ignores later replies; owner-side expiry and lifecycle rechecks still
apply, but there is no unconditional no-late-activation guarantee after commit. The
protocol never authorizes persistence or source mutation, regardless of cancellation.

Cross-storage recovery inspection remains an explicitly non-atomic snapshot. Do not
promise equality persists after activation: subsequent user edits and document deletion
are normal concurrent changes. The proof applies at activation, not indefinitely.

## Reader and host UX

A successful owner response selects the existing editor in its host and may attempt
foreground focus. Keep the reader usable and report “Opened the existing document
in another TypeBridge window.” Do not promise that the browser brought its tab to
the foreground. If foreground focus is denied, give a non-destructive instruction
to switch to that existing window; denial alone must not create another copy after
successful internal activation.

If no activation commit was sent, or the owner confirms terminal non-activation,
use #329's atomic unowned matching/create path. Do not invoke it automatically for an
indeterminate post-commit outcome. That path still never reuses an owned candidate based on a
stale probe. Existing host opening and four-window-cap guidance applies to a newly
saved copy. Sender-disabled Edit does not probe or create anything.

## Required implementation and tests

The bounded protocol, hosted owner adapter and exact host activation hook now exist.
Reader candidate probing, result/unknown UI and safe fallback are integrated.
The regression matrix below covers the full flow plus the bounded protocol tests;
closing #330 still requires independent review, green final-head CI and deployment. Keep source writes and backup mutation out of
this protocol. Reject unknown versions and malformed/oversized identity fields.

Regression matrix:

- Clean exact owned editor reuses without a new row; unowned positive reuse stays green.
- Dirty text/title/format, private mode, IME, pending save and recovery refuse without
  changing the original row, history, backups, inputs or ownership.
- Edit/switch/delete/fence changes between probe and activation cannot reuse stale state.
- Unresponsive, suspended, old or unsupported owners with no commit sent time out to
  the safe fallback; after commit they produce indeterminate state unless reconciled.
- Hold a success reply after activation past the reader deadline: no automatic copy or
  second commit, then same-nonce reconciliation reports activation without repeating it.
- Delay a commit until after timeout/navigation: assert indeterminate/best-effort cancel
  behavior and reject expired offers, rather than claiming timeout proves non-activation.
- Lost/duplicate status replies, owner restart and retired cache entries remain unknown;
  only a recorded terminal refusal/cancellation enables automatic fallback.
- Acknowledged pre-activation cancel rejects delayed commit; post-activation cancel
  reports the prior activation. Explicit warned copy creation uses a new action identity.
- Duplicate/spoofed/stale responses cannot activate the wrong document or complete a new
  action. Concurrent fallback tests cover #329's atomic matching/create under unchanged
  eligibility; do not promise global exactly-once behavior across lost acknowledgements,
  owner transitions or explicitly requested copies.
- Browser focus denial still accurately reports internal activation; multiple hosts
  and four-window cap preserve existing behavior.
- Metadata transport fixtures prove that content/history/input values are absent.
- Clear/private transitions invalidate offers and generations; no protocol persistence.
  Already-sent commits follow the documented post-commit cancellation limitations.

Validate unit state-machine cases and real multi-page Chromium/Firefox/WebKit flows.
Merge implementation only with independent review, green exact-head CI and successful
post-merge deployment; do not close #330 after merging this research alone.
