# Grouped Shared with me (#350)

Status: interaction design with a static prototype and partial UI implementation.
The library groups supported received links and uses secondary Actions for existing
individual removal. Confirmed atomic group removal is implemented as described below;
input-bearing links and deployment/production acceptance remain separate.
Builds on the agreed identity model in #350 and the gated snapshot contract in #349.

A pure grouping/search model is prepared in `src/editor/shared-groups.ts`. It consumes
already-validated received records, compares complete title/text/format fields, keeps
original link references, assigns creation-based ordinals and searches only immutable
incoming fields. It performs no decoding, sidecar access, storage or rendering.
The library UI consumes this model for grouping/search. Group actions confirms and
removes the captured group atomically. Per-link Actions copies the exact original
payload or confirms individual removal. Copy has a selected read-only URL fallback;
the per-item transaction refuses a changed payload after confirmation. V2 integration
and remaining production acceptance are separate steps.

## Current boundary

The previous `src/ui/shared-library.ts` rendered one title link plus one always-visible
Remove button per payload. The current UI groups exact matches and searches immutable
source/title/format and presentation hints, preserving expansion during search. The library is
limited to 100 received items and 10 MiB; there is no silent eviction. Items are
ordered by last-opened time. Each original payload owns its separate numeric sidecar.
The library currently rejects v2 through the default decoder capability; do not
enable it merely to implement grouping or show unsupported inputs as defaults.

The prototype's four synthetic received links yield three visible row controls when
collapsed (one group summary, one singleton title and its Actions disclosure), with
no visible Remove button. The current per-item layout would expose eight link/Remove
controls for four items. This is an interaction-count comparison, not a production
performance or layout measurement.

## Proposed list

- Keep Shared with me inside Documents, with its existing local-only explanation
  and one search field. Search label: **Search shared documents and link parameters**.
- A singleton is one title link and a collapsed **Actions** disclosure. No empty
  folder to expand, no row of permanent buttons. Its secondary text identifies the
  incoming parameters/presentation using the same rules as a grouped variant.
- Two or more exact source/title/format matches become one native disclosure:
  **Loan calculator · 3 received links**. Start collapsed. The count is the number of
  immutable received links, not the number of people, edits or editable copies.
- Expansion reveals ordinary links to each original received item, with summaries
  and a per-link Actions disclosure. Opening continues to use the exact stored
  payload in a new tab with `noopener`. No implicit "latest wins" group link.
- Show the source format under the group title, including the actual unknown format
  value with source-only explanation. Display an empty/whitespace-only title as
  Untitled document; display fallback never changes identity. Long titles wrap.
- Order groups by their most recently opened variant, then deterministic stable
  identity for ties. Order variants by last opened, then creation time and stable
  item identity. Reopening an identical link updates recency without adding a row.
  Preserve expansion by exact group identity during refresh, for this mounted list
  only. Do not persist expansion, or move keyboard focus when ordering changes.

## Summaries and search

Use only immutable decoded link data, never this reader's saved input sidecar. Show
**Authored defaults** for v1 or an empty incoming snapshot. Otherwise show up to two
incoming `name = value` pairs, with **+N parameters** and a native **Link details**
disclosure containing all pairs. Preserve numeric names/case; use bounded literal
text, not HTML. Unknown/out-of-range names remain incoming intent until the supported
runtime validates them; labels must not claim they are accepted current model values.
Never mount a renderer, execute calc, or read another window merely for the list.

Follow parameters with explicit view/edit/heading hints, e.g. **Rendered · Read only ·
Heading shown**. Call variants **Received link 1**, **Received link 2**, etc., with a
stable ordinal within the current group based on creation time/item identity, so
identical summaries remain distinguishable after recency sorting. These are local
labels, not author identities. Link details exposes all incoming pairs/hints without
printing the encoded payload or persistence identifiers in the UI.

Search is case-insensitive literal matching across exact title, source, format,
incoming parameter names/number strings, and the displayed hint labels. A
title/source/format match shows all variants; a parameter/hint-only match shows just
matching variants under their group, with **1 of 3 received links**. Keep the group
container even for one matching result if its unfiltered group has multiple items.
Search temporarily opens matching groups. Clearing restores the user's prior
expansion, rather than permanently expanding everything. Do not search recipient
changes, hidden application metadata or private editable-document state. Show an
explicit No matching shared documents result; errors are not empty results.

## Actions, removal and storage failure

Per-link Actions contains **Copy original link** and **Remove received link**. Copy
uses only that original link and visible success/failure feedback; it does not
acquire source ownership or construct a new snapshot. Existing reader reopening and
editable-copy reuse policies remain unchanged.

Copy constructs the current origin's `/read.html#doc=` URL with the unchanged stored
payload. No recipient-side inputs, private editor state or reconstructed source enter
it. Clipboard access occurs only on explicit activation; failure exposes a selected
read-only URL for manual copying. Late callbacks from replaced rows cannot overwrite
new search feedback or focus. Unavailable/unsupported stored payloads have removal
only, with no copy action exposing their raw data.

Individual removal captures the selected ID/payload before its safe-default dialog,
then rechecks the payload inside the existing deletion transaction. A changed or
missing row is not deleted and does not advance the library epoch; existing removal
invalidation still cancels old writers. Cancel does not invoke removal or invalidate
writers. Failures preserve the row and return the enabled retry action.

Expanded groups expose one **Group actions** disclosure with **Remove all N received
links**. There is no editable-copy action at group level, because a group has no
single presentation/input snapshot. Removal asks in the existing accessible dialog:

> Remove all 3 received links for Loan calculator from this browser? Their saved
> reader inputs will also be removed. Editable copies stay unchanged.

Initial focus and Escape choose **Cancel**. Confirm is **Remove 3 links**. Single
removal uses singular wording and preserves every other variant. Successful removal
returns focus to the surviving group summary or next/previous title link; when empty,
to search. Do not return focus to a deleted row. A failure retains the current rows,
group context and a visible error; never report success before transaction commit.
The confirmation closes before committing; a failure restores the enabled removal
action so the person can retry after reading the library's error status.

Group removal uses an atomic transaction over the exact captured item set and
their sidecars, plus the existing invalidation/epoch protocol. Re-read group
membership before deleting: if membership changed, cancel without deleting anything,
refresh and ask again. Do not loop individual remove calls, silently omit failed
members or delete a newly arrived variant the person never confirmed. Identity
validation must precede invalidation/removal. No record/schema migration is needed
for grouping; derived UI state is not another stored document collection.

No new Clear library action in this slice. Existing global clear/delete controls
retain their existing explicit scope and confirmation; grouping must not narrow or
widen them. Existing quotas still count original variants/bytes, not group count.
Unsupported/corrupt payloads must produce an honest unavailable-item indication and
safe removal path without exposing raw content or silently pretending the collection
is complete. Storage failure leaves shared links usable and does not evict records.

Implementation note: `removeSharedGroup` copies the confirmed fields/member set,
reads received identities and the library epoch in one readonly transaction, then
decodes and compares full grouping fields before invalidation. Its write transaction
rechecks the epoch and complete received identity set, deletes only captured IDs and
their sidecars, and advances the epoch atomically. Any concurrent new/changed received
identity conservatively requires refresh/reconfirmation, even if it might belong to
another group; recency-only updates do not. Read/proof/write failure cannot commit a
partial deletion. Existing invalidation cancels stale sidecar/remembering writers.

## Accessibility and narrow screens

Use lists, links, native details/summary and the existing dialog; no treeview/menu
keyboard model. Tab visits visible links/disclosures, Enter activates them, Space
toggles summaries. Collapsed content is absent from Tab order. Give repeated Actions
names context (e.g. Actions for Loan calculator, received link 2). Keep visible focus,
minimum 44px action targets, wrapping summaries/parameter names and no horizontal
scroll at 320px or 200% text size. An open action disclosure occupies normal flow,
avoiding nested popovers and clipped phone controls. Use one polite status region
for copy, search result counts, storage errors and completed removal.

The [static prototype](../evidence/350/prototype.html) exercises disclosure/search/
cancel/single removal and focus behavior with fixed synthetic examples only. It uses
no storage, clipboard or real shared links. Its group-removal simulation does not
implement or prove the atomic persistence protocol above. It is not the production
Documents menu and cannot prove integration with that menu, host windows, actual
renderer state, native assistive technologies or real devices.

## Implementation and acceptance gates

1. Review this proposal before production UI work. Add a pure exact-field grouping
   function with collision-safe equality and tests for whitespace/title/source/format
   differences, unknown formats, hints/inputs as variants and unchanged identities.
2. Integrate compact UI/search/disclosures without decoder capability changes. Test
   real original links, unchanged sidecars/editable copies, focus across refresh,
   group-to-singleton transitions and 320px/desktop. Simulate corrupt/failed reads.
3. Add independently reviewed atomic group removal, races and rollback tests before
   exposing that destructive action. Existing per-item removal may ship separately.
4. Coordinate v2 parameter summaries with #349's end-to-end enablement; test both
   supported and unsupported versions honestly. Independent current-head review,
   quality plus all three browser CI, post-merge deployment and production checks
   precede completion claims. Keep #350 open until its full acceptance is met.
