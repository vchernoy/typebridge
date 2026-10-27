# Editor behavior and release blockers

## Paste
Paste inserts clipboard text as-is, including Latin, Cyrillic, whitespace and Unicode, regardless of transliteration toggle. It replaces the selection using browser behavior and terminates the pending phonetic sequence. Undo/redo should restore the previous text and selection. Automatic paste conversion is not part of the current editor; use a future explicit conversion action.

## History and IME
The prototype uses a JavaScript snapshot history for keyboard shortcuts and cancelable beforeinput history events, because programmatic setRangeText does not reliably participate in browser-native undo. It is not browser-native undo. OS context-menu undo/redo, iOS gestures, Android keyboard actions, non-cancelable history events, autocorrect, and platform-specific composition sequencing are not established. Non-cancelable history is left to the browser and can diverge from the custom history. The editor does not intercept undo shortcuts during IME composition; synthetic tests do not substitute for real IME verification.

## Open blockers for independent review
- Test real iOS Safari and Android Chrome keyboards, including predictive text, multi-character insertText, autocorrect, selection, deletion and virtual keyboard undo/redo. Current conversion handles only single-character cancelable insertText events; multi-character and non-cancelable insertions are preserved unchanged, so mobile live transliteration is not guaranteed.
- Test real Japanese/Chinese and other IMEs, cancellation/commit, caret and undo after composition, and keyboard shortcut behavior during composition.
- Verify native context-menu/OS undo and redo after transformed and native edits in Safari, Firefox and Chromium; repair or replace history strategy if these paths lose or duplicate text.
- Confirm cut, drag-and-drop, paste, autocorrect and selection replacements with undo/redo. No persistence exists yet; reloading loses text. Draft auto-save remains planned in #9.

Keep PR #16 draft until blockers are resolved or explicitly accepted. Do not publish the first release without owner approval.
