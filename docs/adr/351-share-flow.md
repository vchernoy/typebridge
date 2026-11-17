# Share document: measured baseline and proposed next slice (#351)

Status: proposal for independent design review; no UI or payload change is implemented.
Refs #349 (input snapshots), #350 (received groups), #351 (Share friction).

## Measured baseline

On 2026-11-17, six fresh isolated Chromium contexts opened the production standalone
`/editor.html`, created synthetic Markdown with one numeric input, and opened Share
from source or Rendered view. This measures the standalone window, not the host's
embedded windows, physical phones, OS clipboard, or assistive technology.
Production's new #346 deployment was still running; these observations describe the
already deployed Share UI. No precise production build identity was inferred.

The measured path is **Documents → Share link… → Copy link: three activations**.
Document creation, format selection and choosing the starting view are fixture setup,
not counted as sharing. Playwright automatically scrolls targets into view; the table
records geometry **before** each click, not a measured count of human swipe gestures.

| Viewport | Starting view | Share top / bottom | Initially within viewport? | Copy top / bottom | Initially within viewport? |
| --- | --- | --- | --- | --- | --- |
| 320×568 | Source | 615 / 659 | No | 267 / 311 | Yes |
| 320×568 | Rendered | 621 / 665 | No | 267 / 311 | Yes |
| 320×800 | Source | 621 / 665 | Yes | 358 / 402 | Yes |
| 320×800 | Rendered | 621 / 665 | Yes | 309 / 353 | Yes |
| 1440×800 | Source | 499 / 543 | Yes | 335 / 379 | Yes |
| 1440×800 | Rendered | 499 / 543 | Yes | 303 / 347 | Yes |

Rounded CSS pixels; [raw geometry](../evidence/351/baseline.json) retains fractions.
Both measured action targets are 44px high. At short-phone height, reaching Share
requires moving past a viewport boundary before opening the sheet. At 320×800 the
simple fixture needs no scroll to Copy; repeated scrolling was **not** reproduced
there. Longer content, zoom, keyboard and embedded-window cases remain to measure.

The current sheet puts the privacy explanation, Link and Copy before three separate
reader options and the preview. Copy already fits in all measured sheets, so moving
it above the preview alone would duplicate an existing improvement. The expanded
Documents menu is the first measured obstacle on the short phone.

Clipboard success used an isolated `writeText` stub, not the user's clipboard.
All six flows reported “Link copied”; Escape closed the sheet and returned focus
to Documents. Screenshots were inspected at desktop and both phone heights;
[short phone](../evidence/351/phone-share.png) and
[desktop](../evidence/351/desktop-share.png) retain synthetic fixture evidence.
The browser context required `ignoreHTTPSErrors` for environment certificate trust;
this is application-flow evidence, not a public TLS audit.

To repeat the synthetic measurement after `npm ci` and installing Playwright Chromium,
run `node docs/evidence/351/measure.mjs` from the repository root. It writes raw JSON
and screenshots under `/tmp/351-*`, uses isolated contexts and a clipboard stub, and
never reads an existing browser profile. Recheck live build identity separately.

## Proposed interaction

Use a direct **Share document** control in the existing toolbar's More-actions slot,
with the existing source-only secondary tools moved into a concise Tools disclosure
in Documents. Preserve Copy text as its separate editing action. Keep Share available
as common window chrome in source, Rendered and comparison windows, even when source
editing controls are disabled. Do not increase the number of always-visible buttons.
Retain the Documents Share entry as a secondary discoverability path during migration.

Go to line, Clear text and Keyboard shortcuts must remain individually named and
keyboard reachable; existing shortcuts and confirmation semantics remain. Clear text
must never be relabeled as Delete document. If this placement makes a secondary tool
unreasonably hard to find in host/Focus layouts, revise the placement before shipping.

The sheet opens with a concise, persistent summary: document title, source format,
and whether current parameters are included. Keep “Anyone with the link can read it”
and “Nothing is uploaded” visible before Copy; put the longer browser-history/privacy
explanation behind an accessible “About this link” disclosure. Copy and Close stay
reachable without scrolling the main sheet at the tested phone sizes.

Put presentation hints (Rendered/Source, title visibility, Edit a copy) in a collapsed
**Reader options** disclosure, preserving current defaults. Put the document preview
in a separate collapsed disclosure. Editing options regenerates the link with current
generation guards: disable Copy and clear the old link until the new snapshot is ready.
Long-link and too-large feedback stays next to Copy, outside collapsed disclosures.

## Coordinate parameters with #349

An explicit **Include current parameters** control belongs in the main sheet, not
under Reader options. Proposed default: off, preserving existing sharing semantics;
show “Uses authored defaults” until selected. If accepted values are available, show
their count and an optional parameter summary without exposing model-only values by
default. The control must never imply that local persistence has been enabled.

Capture source/title/format and the chosen accepted numeric snapshot together when
the sheet opens. Preview controls must not mutate that captured document snapshot.
No DOM scraping, taking source ownership, silent fallback to another window's state,
or saving private inputs merely to share them. If a source window cannot obtain its
intended current input snapshot through the supported document-state API, explain
that parameters are unavailable; keep default-only sharing usable.

The versioned envelope, validation/size limits, recipient restore precedence, Reset,
and Edit/reuse initialization are #349 design responsibilities, not decided by this
UI proposal. Its implementation must settle those rules before enabling the control.
Distinct parameter links remain immutable variants; #350 groups their exact
title/text/format without replacing links. No grouped-library work is bundled here.

## Acceptance targets for implementation

- Primary path: **two activations**, Share document → Copy link (3→2, one-third fewer).
  Do not automatically copy when opening the sheet.
- At 320×568, 320×800 and 1440×800, Share and the initial Copy/Close controls fit
  without user scrolling from the normal top-of-document state. Verify host embedded,
  standalone, comparison and Focus layouts; do not assume standalone results transfer.
- No extra always-visible button; all changed action targets at least 44×44px,
  no horizontal overflow. Enlarged text may scroll secondary content but cannot hide
  Copy/Close or trap focus. Inspect actual before/after screenshots.
- Test source-owner A plus Rendered input editor B: B opens Share without stealing
  A's source lock or changing source/history; #349 selects the intended snapshot.
- Keyboard-only open/copy/disclosure/Escape/focus return, long-link/oversize errors,
  denied clipboard with selected-link fallback, cancellation during generation, and
  privacy/source immutability pass in Chromium, Firefox and WebKit.
- No new content requests; no history/settings/invalid control text in links. Plain
  or source-only flows retain renderer laziness. No remote image in the preview.

## Delivery boundaries

1. Independently review this measured proposal and settle the common-chrome placement.
2. Implement the direct Share entry and compact disclosures as one small #351 PR,
   initially retaining legacy payload behavior. Re-measure the same six flows and
   add host/Focus, keyboard, clipboard refusal and enlarged-text regressions.
3. Integrate #349's separately reviewed parameter contract into the reserved main
   control; keep #350 grouping separate. Verify final end-to-end snapshot flow.

This document does not close #351. UI implementation, full CI/independent review,
successful deployment and production verification are still required.
