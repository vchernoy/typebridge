# New UI accessibility audit (#137 U10)

Scope: the layout from #123 and its document/title, typing-mode, save-state, Settings, Find, Escape and shared-dialog follow-ups through U7. This is a source review plus automated browser coverage, not a claim of a real screen-reader or physical-device session. Broader audit: [#11](https://github.com/vchernoy/typebridge/issues/11).

## Checks enforced by browser CI

| Area | Evidence |
| --- | --- |
| Typing switch | Real switch/checkbox state, name “Кириллица”, configured shortcut description; existing mode-switch/shortcut suites and `ui-accessibility.spec.ts` |
| Documents and More | Labeled dialog/listbox and menu patterns, keyboard traversal, Escape and trigger focus; document-names/toolbar/focus/escape suites |
| Settings | Non-modal dialog permits editor focus, Escape closes Settings before Focus; Settings and accessibility suites |
| Shared confirmations and shortcuts | Modal role, inert background, safe Escape, focus containment/return and scrollable message on short viewports; confirmation/keyboard-shortcut suites |
| Find and save state | Named inputs/options/buttons; detailed polite status remains the announced source, compact indicator is not a duplicate live region |
| Contrast | Computed text/background contrast ≥4.5:1 in both system themes for labels, save/search state, privacy text and shared dialogs; unchecked switch border ≥3:1 |
| Motion and layout | Reduced-motion switch transition; 640×400 CSS viewport represents the layout space of 1280×800 at 200% zoom; existing 320/390 px and enlarged-text tests remain |
| Forced colors | Chromium emulation checks panel boundaries/focus, with existing resize-grip system-color coverage; this is not a real Windows High Contrast session |
| Privacy | Synthetic writing canary stays out of request URLs/bodies; app requests remain same-origin. This does not prove absence under every browser extension or deployment |

`e2e/ui-accessibility.spec.ts` adds the focused checks. CI on the PR's final head supplies pass/fail evidence; record the run and verdict in #137/#11 after merge. Existing specialized suites remain authoritative for editing, persistence, privacy and IME simulation.

## Small fixes in this pass

- Find/Go-to status uses the theme's muted text color instead of a fixed light-theme color in dark mode.
- Unchecked typing-switch borders use muted text colors in both themes for visible control boundaries. Checked state retains the accent and the native accessible state.
- U7 already corrected the shared dark-modal surface and made long messages independently scrollable; this pass checks that behavior.

## Manual checks still pending

- VoiceOver on iPhone Safari: reading/focus order, switch announcement, native document list, Settings, status updates and dialog navigation with the software keyboard.
- NVDA with Firefox/Chrome (or another real screen-reader/browser pair): menu/listbox/dialog semantics and non-duplicated announcements.
- Actual browser 200% zoom and OS high-contrast themes. CSS viewport and forced-color emulation are useful coverage, not equivalent evidence.
- Real IME composition, touch resizing, orientation changes and browser/tab-discard recovery on physical devices.

Do not close #11 or mark the manual part of U10 complete from this automated run alone (#137 is closed; the manual part continues in #11). Items added since: the repeated conflict notice (#232) and Apple-symbol shortcut labels under VoiceOver (#231). Record device/browser/assistive-technology versions and concrete results when those sessions occur.
