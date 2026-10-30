# Editor navigation

Incremental keyboard navigation for long documents ([#60](https://github.com/vchernoy/typebridge/issues/60)). This document covers what is implemented; later slices (line edits, selection-to-search, OS word navigation) will extend it.

## Go to line

- **Go to line** accepts `line` or `line:column` / `line,column` (1-based). Invalid input leaves the caret unchanged and shows guidance in the go-to status.
- Out-of-range lines clamp to the last line; columns clamp to the end of that line (after the last character).
- Line breaks are `\n`, `\r\n` or lone `\r`. Columns use the textarea’s UTF-16 offsets (the same units as `selectionStart`), so a single emoji may span two columns. If the requested column would place the caret in the middle of a surrogate pair, the caret snaps forward to the next code-point boundary and the status reports the resulting column.
- **Go** or Enter in the field moves a collapsed caret, focuses the editor and reveals the target line with the same scroll helper as Find and Undo. The document text and Undo history are not changed.
- **Cmd/Ctrl+G** focuses the go-to field (and leaves Focus mode if needed so the chrome is visible). The shortcut may also be claimed by the browser’s own Find UI on some platforms.

## Caret position

The footer shows `Ln N, Col M` for the current caret (selection start). It updates on typing, caret moves, Find, Go to line and Undo/Redo reveal. It is visible in Focus mode.

## Shortcut map (navigation)

| Action | Shortcut |
| --- | --- |
| Find | Cmd/Ctrl+F |
| Go to line | Cmd/Ctrl+G |
| Focus mode | Esc (see editor behavior) or Cmd/Ctrl+Shift+Enter |

Avoid colliding with transliteration (Cmd/Ctrl+Shift+Space or the configured F-key) and conversion (Cmd/Ctrl+Shift+L / K).
