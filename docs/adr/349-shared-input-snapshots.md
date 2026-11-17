# Shared numeric snapshots (#349)

Status: proposed end-to-end contract. Gated codec and receiver foundations are
prepared below; product-route initialization, parameter capture and copy behavior
are not implemented.
Builds on the issue's initial research and the reviewed #351 Share-flow design.
Immutable grouping identity is the maintainer's agreed policy; the wire and lifecycle
choices below are recommendations, not evidence of product approval or implementation.

## Codec foundation boundary

The codec can inspect/encode/decode a bounded v2 envelope only with an explicit
`inputSnapshots` integration capability. Existing calls omit it and continue rejecting
v2 with `version`; the production UI still creates v1 source-only links. This prevents
an unready reader accepting parameters that its renderer would then ignore. Empty
snapshots are preserved; schema/byte failures are distinct. The storage validator is
shared through a pure module; no IndexedDB/DOM/rendering dependency enters the codec.
Do not enable the capability on product routes before the initialization/capture and
copy policies below are implemented and independently reviewed.

The shared-reader adapter accepts an optional validated snapshot for integration
tests. It distinguishes absent local state from an empty saved reset using record
existence, chooses one whole baseline, and freezes persistence after failed reads.
Browser fixtures exercise the real adapter and renderer through the first visible
controls/math/conditions, local precedence, empty reset and temporary fallback.
Production callers still omit the snapshot and reject v2; this is preparation, not
an enabled end-to-end parameter-sharing feature.

## Compatibility evidence

Baseline main `081353a`: `share-link.ts` serializes only source/title/format/hints;
`parseSharedDocument` drops unknown fields. The
[probe](../evidence/349/legacy-compat.mjs) executed the actual baseline decoder:

- A valid `1.` payload with an extra numeric envelope is accepted, but the envelope
  disappears from the returned document. The reader would initialize authored defaults.
- The same JSON under `2.` is rejected with the existing `version` reason.

[Recorded output](../evidence/349/legacy-compat.json) contains only outcome metadata.
Repeat using Node 24 from a worktree at the baseline commit with the probe copied in;
it is historical evidence, not a permanent test asserting future decoders reject v2.
The script performs no network or storage operation and logs no document/input content.

Therefore, merely adding an optional field to v1 can silently show the wrong initial
calculation on older clients. Input-bearing links should use an outer **`2.` prefix**.
Old clients then explain that the link needs a newer reader, rather than displaying
authored defaults as though the supplied parameters had been honored.

## Proposed wire contract

Keep v1 encoding unchanged when parameters are not included. New readers accept v1
and v2. V2 uses the existing UTF-8 JSON → deflate-raw → base64url pipeline and existing
source/title/format/view/edit/heading rules, with a required envelope:

```json
{"inputs":{"version":1,"values":[["x",7],["seed",3]]}}
```

This fragment illustrates the added field, not a complete document payload.
Allow an empty values array; it explicitly represents authored defaults. Do not infer
envelope presence from map size or truthiness. UI inclusion remains explicit/default-off;
disable it with an explanation when no accepted numeric state can be obtained.

Validate without recursive coercion: at most 256 unique pairs; each name a nonempty
string of at most 128 UTF-16 code units; each value a finite number. Reject duplicate
names, strings-as-numbers, booleans, nulls, nested values and malformed pair shapes.
Bound the serialized envelope, including its version/keys, to 64 KiB UTF-8. Preserve
case; do not trim or normalize names. No arbitrary application objects or computed
outputs, scores, attempts, history, settings or invalid control text enter the envelope.

Keep the 48,000-character encoded-payload and 2,000,000-byte decompressed-JSON limits;
the envelope counts toward both. Encoding must refuse everything decoding would reject.
Malformed shapes use `malformed`, exceeded bounds use `too-large`, unsupported outer
or envelope versions use `version`. Unsupported semantics must not silently downgrade.
V1 still has authored-default semantics even if manually supplied unknown fields exist.

Codec validation does not execute Markdown or decide current model compatibility.
The supported runtime validates names/current numeric and control bounds when mounting;
unknown/removed/out-of-range values are skipped and missing inputs use authored defaults.
Plain/source/unknown-format reading does not load a renderer just to inspect parameters.
Unknown formats retain their actual format and source fallback.

## Capture and explicit sharing

Capture immutable source/title/format and the accepted input map at sheet open.
Each generation combines that captured state with the currently selected presentation
hints. A later
sender edit cannot mutate an old link or change which values a pending Copy copies.
The preview's own exploratory controls never change the captured map.

Expose a supported document-state snapshot capability; never scrape DOM controls or
acquire source editing ownership. Rendered windows use their accepted model snapshot,
including model-only inputs. A source window uses its document's pending accepted
memory snapshot, or an eligible authoritative saved baseline if no memory snapshot
exists. Conflicting/pending local snapshots are not silently replaced by another
window's values. Show the chosen parameters on demand before Copy so the user can
understand the snapshot. Validate compatibility against captured source through the
supported model boundary; do not invent an ad hoc Markdown/calc parser.

Private/Autosave-off sharing is explicit, like current source sharing, and writes no
local content merely to construct a link. Failed preference/storage proof must not
fall back to reading another window's private state. If a suitable snapshot cannot
be obtained safely, leave source-only sharing usable and explain why Include current
parameters is unavailable. Re-enabling storage does not retroactively save private
values. Including private current values requires the explicit inclusion choice.

## Recipient initialization and reset

| Recipient state | Initial state |
| --- | --- |
| Valid saved record, including an empty reset record | Entire saved snapshot |
| Eligible read proves no local record exists | Incoming envelope, otherwise authored defaults |
| Private/opted-out reader | Incoming envelope in memory, otherwise authored defaults |
| Storage read fails or saved schema is incompatible | Incoming envelope temporarily (v1: authored defaults), with visible fallback status and writes frozen |

Choose one whole snapshot, then let runtime validation fill missing inputs with
authored defaults. Never merge missing local names from incoming parameters: an empty
saved reset must not resurrect the link's values. Expose record existence/revision
from the storage adapter; `Map.size` cannot distinguish absence from explicit reset.
Read failure is not proof of absence and must not permit replacement of stored data.

Initialize through supported `initialInputs`, await settled in a connected hidden
stage, then reveal consistent controls/results/math/conditions. Subscribe for saving
after initialization; no write-on-restore. Keep navigation/destroy guards and bounded
storage loading. Recipient edits remain sidecars, never new links/library variants.

**Reset inputs to defaults means authored source defaults**, not the link's starting
parameters. Persist an empty snapshot with a new CAS revision when permitted; in a
temporary page reset only memory. Existing reset/deletion/privacy/CAS protections
remain. Do not add a second reset meaning without a separate product decision.

## Identity, editable copies and unresolved private-copy prerequisite

Exact validated versioned payload remains received-item identity. Different input or
presentation snapshots are distinct immutable variants; #350 groups exact title +
text + format without replacing links. Recipient sidecars do not alter identity.

Recommend new editable copies start from the link's incoming parameters, not private
adjustments made by this recipient. Explain this before creation; current receiver
values stay in its reader. For public new copies, create source plus initial numeric
sidecar atomically, so quota/abort cannot report an initialized copy with missing state.
Validate through supported APIs before first visible editor Preview.

Reuse/activation of an existing editable document must preserve its entire input state
and source/history. Report that existing parameters were kept. If the user wants the
link's parameters instead, offer an explicit independent-copy action; never rebase or
overwrite an existing copy merely because source/title/format match.

Private-copy initialization is a prerequisite to settle before enabling that path:
the current private editor skips persisted input loading, so writing an initial sidecar
alone would not initialize its controls. Require a bounded supported memory-only
handoff or another independently reviewed policy-preserving mechanism. Do not smuggle
private values through URLs/sessionStorage, enable Autosave, acquire source ownership,
or claim initialized-copy success while silently showing authored defaults. This
proposal does not claim that a suitable handoff already exists.

## Implementation slices and review evidence

1. Review this contract, including outer-version behavior and private-copy mechanism.
2. Implement bounded v1/v2 codec/types and independent unit + browser cross-codec
   vectors. Keep the include control disabled until end-to-end initialization exists.
3. Implement capture and reader precedence. Fresh x-default-2/link-7 opens at 7 on
   first visible render; local-9 reopens at 9; reset/reopen yields 2; sender changes
   leave the old link unchanged. Test model-only values and malformed/type/range/name/
   duplicate/size/version cases, read failure and invalid/empty local records.
4. Integrate new-copy/reuse/private-copy behavior with the existing safe activation
   protocol, then enable the explicit main-sheet control. Test source-owner A with
   Rendered input/share B, no source/history writes, private explicit sharing without
   persistence, immutable variants, and plain/source no-renderer behavior.

Each slice needs issue linkage, independent current-change review and quality plus
Chromium/Firefox/WebKit CI. Close #349 only after the full contract is implemented,
deployed and production verified. #350 grouping and #351 chrome remain separate.
