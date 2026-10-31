# Editor behavior and release blockers

## Paste and cut

Paste inserts clipboard text as-is, including Latin, Cyrillic, whitespace and Unicode, regardless of the transliteration toggle. It replaces the selection using browser behavior and terminates the pending phonetic sequence. Cut also terminates that sequence. Automatic paste conversion is outside this editor; a future explicit conversion action can provide it.

## Focus mode keys

Escape in the editor, or with no control focused (for example after clicking the page background), toggles Focus mode in both directions, and Escape anywhere exits Focus mode. Outside Focus mode, Escape in Find/Replace, the title field, selects and other controls keeps its usual cancel role and does not switch modes. In either mode, Escape is ignored while an IME composition is active, when the key auto-repeats, and when another handler has already handled it (`preventDefault`). Cmd/Ctrl+Shift+Enter also toggles Focus mode from anywhere, including Find/Replace (where plain Enter and Shift+Enter still find the next and previous match). Focus returns to the editor after each switch.

## Go to line

Cmd/Ctrl+G focuses **Go to line** (exiting Focus mode when needed). Enter or **Go** moves a collapsed caret to a 1-based `line` or `line:column`, clamps out-of-range values, reveals the line and leaves text/history unchanged. The footer shows `Ln N, Col M` for the caret. Details and limits: [navigation](NAVIGATION.md).

## Transliteration in other fields

The draft title, Find and Replace follow the same transliteration mode and custom rules as the editor, and the transliteration shortcut toggles the mode from any of them. This includes Regex mode: to mix Russian letters with Latin regex syntax such as `\s`, `[a-z]` or `$<name>`, toggle transliteration with the shortcut while typing the pattern (#102). The mappings box always keeps Latin rule text.

## Indentation

With the "Tab indents" setting on (the default), Tab at a caret inserts four spaces, Tab with a selection indents every line it touches, and Shift+Tab removes up to one indentation unit (a tab or up to four spaces) from each touched line. A selection that ends at the start of a line does not include that line, and empty lines are not indented. Each operation is one Undo step. Tab is not intercepted during IME composition or with Ctrl, Cmd or Alt. To leave the editor with the keyboard, press Shift+Tab on a line with nothing to outdent, or turn "Tab indents" off so Tab moves focus as usual.

## History and IME

The editor maintains its own delta history (up to 500 steps) because transformed text uses programmatic edits that do not reliably join native undo history. With transliteration off, consecutive typing at a collapsed caret is grouped into one step while keystrokes arrive less than 800 ms apart and nothing is available to redo; a longer pause, a selection replacement, a composition commit or any transliterated keystroke starts a new step. A step is recorded only when an input actually changes the text. Non-cancelable edits are allowed to complete and recorded from their resulting input; a non-cancelable native undo/redo clears custom history after the browser's change, avoiding replay of a stale custom stack at the cost of losing earlier custom undo steps. Composition is treated as one edit in the tested synthetic sequence; undo shortcuts are not intercepted during composition. These precautions do not establish equivalence with native history in all browsers and event orderings.

[MDN's beforeinput documentation](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event) notes that beforeinput can be missing or non-cancelable for IME, autocorrect, autocomplete and other edits, with details varying by browser and OS. In particular, native undo gestures, context menus, predictive keyboards, composition event order, drag-and-drop and edits without a corresponding input event require further validation.

## Test coverage and limitations

Playwright exercises desktop Chromium, Firefox and WebKit typing, selection replacement, deletion, keyboard paste and cut, undo/redo, clear and a narrow touch-enabled viewport. The three engine projects passed in CI run 23 on commit a0a3c54. Playwright WebKit on Linux is not Safari on an Apple device. The non-cancelable input and IME sequences are synthetic events, not a real IME or virtual keyboard. A mobile viewport does not emulate mobile Safari or Android Chrome input methods. No real iOS Safari or Android Chrome device testing has been performed.

- Test real iOS Safari and Android Chrome keyboards, including predictive text, multi-character input, autocorrect, selection, deletion and virtual keyboard undo/redo. Live conversion currently handles single-character cancelable insertText; multi-character and non-cancelable insertions remain unchanged.
- Test real Japanese/Chinese and other IMEs, cancellation and commit, caret and undo after composition, and event ordering around compositionend.
- Verify native context-menu/OS undo and redo after transformed and native edits in Safari, Firefox and Chromium; repair or replace the history strategy if these paths lose or duplicate text.
- Verify drag-and-drop and unusual clipboard/selection edits on devices. Committed drafts and delta Undo/Redo history persist in IndexedDB; autosave, conflict copies and emergency text recovery exist. The tab's reload snapshot keeps unsaved Undo history; the cross-tab emergency journal keeps only text and title. See [architecture](ARCHITECTURE.md) for durability limits.

PR #16 and subsequent editor/persistence work are merged; Pages is enabled. The original CI run above is historical evidence, not a claim that later changes or real devices were verified. Record current checks on the relevant PR. Full version history, real-device input testing and broader recovery hardening remain separate work in #37/#11.
