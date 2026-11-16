# Active-owner shared-copy reuse (#330)

Status: proposed protocol; not implemented. Baseline: main `7c6cccc` (#329).
This is the research prerequisite for #330, not evidence that owner reuse ships.
The safe fallback and observable-backup exclusions from #325 remain unchanged.

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
make an owner eligible. All old safe-create behavior remains available.

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

Proposed bound: one overall 2-second attempt for an Edit click, at most 16 candidate
probes and 16 in-flight offers per owner, with a 2-second offer TTL and bounded
cleanup. No polling, unbounded retry, automatic stealing or suspension inference.
Expired offers refuse activation. Cancel on navigation, changed share payload,
private transition, storage clear, document switch and destroyed owner/reader.
Use the existing runtime clock only for lifecycle timeout; calc stays deterministic.

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

If there is no eligible committed activation result, use #329's atomic unowned
matching/create path. That path still never reuses an owned candidate based on a
stale probe. Existing host opening and four-window-cap guidance applies to a newly
saved copy. Sender-disabled Edit does not probe or create anything.

## Required implementation and tests

Add a bounded parser/transport and cancellation state machine; connect owner readiness
to current model fields, privacy, IME, save and lifecycle gates; add a host activation
hook that does not perform yield/steal; integrate reader fallback. None exist merely
because this document describes them. Keep source writes and backup mutation out of
this protocol. Reject unknown versions and malformed/oversized identity fields.

Regression matrix:

- Clean exact owned editor reuses without a new row; unowned positive reuse stays green.
- Dirty text/title/format, private mode, IME, pending save and recovery refuse without
  changing the original row, history, backups, inputs or ownership.
- Edit/switch/delete/fence changes between probe and activation cannot reuse stale state.
- Unresponsive, suspended, old or unsupported owners time out to the safe fallback.
- Duplicate/spoofed/stale responses, request cancellation and rapid/concurrent readers
  neither activate the wrong document nor create duplicate fallback copies.
- Browser focus denial still accurately reports internal activation; multiple hosts
  and four-window cap preserve existing behavior.
- Metadata transport fixtures prove that content/history/input values are absent.
- Clear/private transitions cancel pending offers; no late activation or persistence.

Validate unit state-machine cases and real multi-page Chromium/Firefox/WebKit flows.
Merge implementation only with independent review, green exact-head CI and successful
post-merge deployment; do not close #330 after merging this research alone.
