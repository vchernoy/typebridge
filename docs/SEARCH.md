# Find and Replace behavior

Literal search escapes regex punctuation. Match case is off by default; both literal and regex searches use JavaScript case-insensitive matching when unchecked. This includes ordinary English and Russian upper/lowercase. It does not perform Unicode normalization or full Unicode case folding: composed/decomposed text and multi-character folds are not promised equivalent.

Next and Previous wrap through matches and reveal the selected match in the textarea. A first Next includes a zero-width regex match at the caret; another Next advances past it, including at the end of the document. Previous moves to the preceding start offset and wraps. Editing or manually moving the caret resets zero-width navigation. Selection offsets follow the textarea's UTF-16 indexing; navigation chooses actual regex matches rather than incrementing through surrogate pairs.

Regex mode bypasses live transliteration in Find/Replace inputs. Replacement supports JavaScript tokens: `$$`, `$&`, prefix/suffix tokens, numeric captures and `$<name>`. A two-digit capture falls back to a valid first-digit capture plus the remaining digit, for example `$12` with only group 1. Unmatched captures expand to empty strings. In literal mode replacement tokens remain literal. Replace All is one undoable edit; Replace and Replace All share substitution behavior.

Match case/Regex preferences survive reload in localStorage. Query/replacement strings use this tab's sessionStorage; browser session restoration may retain them. See [settings persistence](SETTINGS-PERSISTENCE.md). Large-document responsiveness, real devices and broader Unicode expectations remain under audit in [#62](https://github.com/vchernoy/typebridge/issues/62).
