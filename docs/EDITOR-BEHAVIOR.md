# Editor behavior and release blockers

## Paste and cut

Paste inserts clipboard text as-is, including Latin, Cyrillic, whitespace and Unicode, regardless of the transliteration toggle. It replaces the selection using browser behavior and terminates the pending phonetic sequence. Cut also terminates that sequence. Automatic paste conversion is outside this editor; a future explicit conversion action can provide it.

## History and IME

The editor maintains its own snapshot history because transformed text uses programmatic edits that do not reliably join native undo history. A pre-edit snapshot is recorded only when a subsequent input actually changes the text. Non-cancelable edits are allowed to complete and recorded from their resulting input; a non-cancelable native undo/redo clears custom history after the browser's change, avoiding replay of a stale custom stack at the cost of losing earlier custom undo steps. Composition is treated as one edit in the tested synthetic sequence; undo shortcuts are not intercepted during composition. These precautions do not establish equivalence with native history in all browsers and event orderings.

[MDN's beforeinput documentation](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event) notes that beforeinput can be missing or non-cancelable for IME, autocorrect, autocomplete and other edits, with details varying by browser and OS. In particular, native undo gestures, context menus, predictive keyboards, composition event order, drag-and-drop and edits without a corresponding input event require further validation.

## Test coverage and limitations

Playwright exercises desktop Chromium, Firefox and WebKit typing, selection replacement, deletion, keyboard paste and cut, undo/redo, clear and a narrow touch-enabled viewport. The three engine projects passed in CI run 23 on commit a0a3c54. Playwright WebKit on Linux is not Safari on an Apple device. The non-cancelable input and IME sequences are synthetic events, not a real IME or virtual keyboard. A mobile viewport does not emulate mobile Safari or Android Chrome input methods. No real iOS Safari or Android Chrome device testing has been performed.

- Test real iOS Safari and Android Chrome keyboards, including predictive text, multi-character input, autocorrect, selection, deletion and virtual keyboard undo/redo. Live conversion currently handles single-character cancelable insertText; multi-character and non-cancelable insertions remain unchanged.
- Test real Japanese/Chinese and other IMEs, cancellation and commit, caret and undo after composition, and event ordering around compositionend.
- Verify native context-menu/OS undo and redo after transformed and native edits in Safari, Firefox and Chromium; repair or replace the history strategy if these paths lose or duplicate text.
- Verify drag-and-drop and unusual clipboard/selection edits on devices. No persistence exists yet; reloading loses text. Draft auto-save remains planned in #9.

Keep PR #16 draft until major blockers are resolved or explicitly accepted. Do not publish the first release without owner approval.
