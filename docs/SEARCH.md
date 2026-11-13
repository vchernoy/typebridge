# Find and Replace behavior

The find bar opens on demand ([#123](https://github.com/vchernoy/typebridge/issues/123)): the **Find** toolbar button or **Cmd/Ctrl+F** opens it and focuses the query, leaving Focus mode if needed. Match case and Regex sit inside it. **Escape** in the bar or its **×** closes it and returns to the editor; the query and options are kept. Opening Find closes Go to line and vice versa.

Literal search escapes regex punctuation. Searches use JavaScript Unicode mode (`u`): matches, including zero-width ones, stay on code point boundaries, and regex syntax is the stricter Unicode-mode syntax (for example, unnecessary escapes such as `\-` outside a character class are invalid). Match case is off by default; both literal and regex searches use JavaScript case-insensitive matching when unchecked. This includes ordinary English and Russian upper/lowercase. It does not perform Unicode normalization or full Unicode case folding: composed/decomposed text and multi-character folds are not promised equivalent.

Next and Previous wrap through matches and reveal the selected match in the textarea. A first Next includes a zero-width regex match at the caret; another Next advances past it, including at the end of the document. Previous moves to the preceding start offset and wraps. Editing the text, or moving the caret away from the match, resets zero-width navigation; switching focus (for example Ctrl+F back to Find) does not. Selection offsets follow the textarea's UTF-16 indexing; navigation chooses actual regex matches rather than incrementing through surrogate pairs.

Find and Replace follow the transliteration toggle in Regex mode as well, so patterns can use Russian letters; toggle transliteration off with its shortcut (see [editor behavior](EDITOR-BEHAVIOR.md)) while typing Latin syntax such as `\s` or `$<name>`. Replacement uses native `String.prototype.replace` substitution, so every JavaScript token behaves exactly as in JavaScript: `$$`, `$&`, prefix/suffix tokens, numeric captures (`$12` with only group 1 means group 1 then `2`) and `$<name>`. Unmatched captures expand to empty strings. In literal mode replacement tokens remain literal. Replace All is one undoable edit; Replace and Replace All share substitution behavior.

Match case/Regex preferences survive reload in localStorage. Find/Replace values and their independent histories belong to the shown document (#257 step 2b). They use its save/recovery machinery. Private edits remain in memory, and privacy switches leave the fields unchanged. Viewers search locally in memory without writing document content; legacy standalone search-content keys are removed. See [settings persistence](SETTINGS-PERSISTENCE.md). Real devices and assistive technology remain unverified ([#11](https://github.com/vchernoy/typebridge/issues/11)).

## Case and Unicode behavior

`src/editor/search.ts` builds the pattern (`buildSearchPattern`) and lists matches (`findMatches`). `src/editor/search-unicode.test.ts` pins each row below, and `e2e/search-unicode.spec.ts` checks the same rows in Chromium, Firefox and WebKit, since each engine has its own RegExp implementation ([#62](https://github.com/vchernoy/typebridge/issues/62)).

| Query | Text | Match case off | Why |
|---|---|---|---|
| `hello` / `привет` / `ёлка` | Any capitalization | Matches | Simple case mapping covers Latin and Cyrillic, including Ё/ё |
| `елка` | `ёлка` | No match | Е and Ё are different letters; Find does not merge them |
| `é` (one code point) | `e` + combining acute | No match | No Unicode normalization (NFC/NFD) |
| `ß` | `SS` | No match | No multi-character case folding |
| `ß` | `ẞ` (capital sharp s) | Matches | One-to-one simple folding applies |
| `σ` / `k` | `ς` / `K` (Kelvin sign) | Matches | Simple folding in Unicode mode |
| `i` / `I` | `İ` / `ı` (Turkish) | No match | No locale-specific (Turkish) case rules |
| `🙂` | Emoji in text | Matches whole emoji | Unicode mode never splits a surrogate pair |

With Match case on, only exact code points match. The same policy applies in Regex mode (`\p{Lu}` and other Unicode property escapes work). Replace and Replace all never normalize or re-case the text they leave in place.

## Responsiveness on large documents

Measured in #62 on the production build in headless Chromium (Linux cloud container), by timing each action synchronously in the page. Treat these as relative numbers: a desktop browser on real hardware is usually faster. Text is mixed Cyrillic/Latin/emoji lines; "matches" is the number of hits for the query.

| Document | Matches | Count while typing the query | Next | Previous | Replace all | Undo of Replace all | One keystroke in the text |
|---|---|---|---|---|---|---|---|
| 100 KB | 12 / 1,556 | 1 ms | 20–30 ms | 15 ms | 50–55 ms | 50 ms | 55–85 ms |
| 1 MB | 12 / 15,320 | 3–12 ms | 180 ms | 110–150 ms | 565–575 ms | 630 ms | 550–565 ms |
| 5 MB | 12 / 75,926 | 10–16 ms | 830–840 ms | 515–660 ms | 2.5–3.2 s | 2.7–3.1 s | 2.9–3.1 s |

- **Matching itself is cheap:** counting 76,000 matches in 5 MB takes about 16 ms. Search does not slow typing while Find is closed: closed Find never scans.
- **Edits on very large text are dominated by the browser's own textarea layout:** a plain textarea needs about 300 ms per edit at 1 MB in the same environment. Replace all, Undo and each keystroke pay that cost once. The rest is TypeBridge work that runs on every edit (status counts, Undo history, recovery journal, caret position). #62 removed the largest piece: the character count no longer builds an array of the whole text (1 MB: about 90 ms → 9 ms per edit).
- **Next/Previous** measure the caret's line to scroll the match into view; that measurement grows with the match's distance from the start.
- A catastrophic regex (for example `(a+)+$` on long runs of `a`) can still freeze the page while Find is open; JavaScript offers no way to time out a RegExp. Close Find, or fix the pattern, to recover.

