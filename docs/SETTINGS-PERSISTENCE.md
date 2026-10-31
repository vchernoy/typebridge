# Settings and session state

TypeBridge stores everything locally in the browser profile. Browser privacy settings, session restore, storage clearing and eviction can change lifetime. No text is sent to a server.

| Control or state | Storage | Lifetime and tab behavior |
| --- | --- | --- |
| Transliteration on/off | localStorage | Restored on reload, restart and new tabs; each tab writes only this preference. Already-open tabs retain their own current choice. |
| Transliteration shortcut | localStorage | Restored on reload, restart and new tabs. Default is Ctrl+Shift+Space on every platform; existing `default` choices automatically use this binding, including Reset. Saved F7/F8/F9 choices retain Cmd+Shift on macOS and Ctrl+Shift elsewhere; Disabled remains disabled. |
| Saved mapping overrides | localStorage | Restored on reload, restart and new tabs. Unsaved edits in the mapping form are transient. |
| Tab indents | localStorage | Restored on reload, restart and new tabs. |
| Autosave | localStorage | Restored on reload, restart and new tabs. Existing tabs keep their current control state. |
| Match case and Regex | Separate localStorage keys | Restored on reload, restart and new tabs; an already-open tab retains its current values. Each preference is written independently. |
| Find and Replace text | Separate sessionStorage keys | Restored on reload in the same tab. Independent new tabs start empty; duplicated tabs can inherit an initial copy. Closing a tab normally ends its session, but browser session-restore features may retain it across close or restart. Avoid searching for sensitive text on a shared browser; clear the fields when finished. |
| Current document selection | sessionStorage hint | Restored in the same tab where available. Duplicate tabs may inherit the hint. |
| Drafts and undo/redo history | IndexedDB | Committed documents and history survive reload and browser restart subject to browser storage. Revision checks prevent stale writes; conflicts create copies. |
| Emergency recovery | temporary localStorage journal and sessionStorage reload snapshot | Only with autosave enabled; see architecture for recovery, limitations and conflict handling. |
| Focus mode | localStorage | On/off is restored on reload, new tabs and browser restart. Restoring Focus mode focuses the editor after its draft loads and preserves the saved Normal-mode dimensions. Existing tabs keep their current layout. Blocked storage falls back to Normal mode without a warning. |
| Open settings panels | in memory | Reset on reload. |
| Editor resize | localStorage | Resize using the drag control or its arrow keys; the control stays under the editor's right edge as its width changes, in Normal and Focus mode ([#70](https://github.com/vchernoy/typebridge/issues/70)); normal-mode resizing is restored on reload, restart and new tabs, subject to responsive min/max constraints. Focus mode uses its own temporary dimensions; native textarea resizing remains available where supported. |
| Appearance | system color scheme | Follows the operating system; no selectable theme is currently implemented. |
| Editor selection, caret and scroll | sessionStorage, per draft | Restored after the draft loads in the same tab, including when switching drafts. Offsets clamp to current text and Unicode code-point boundaries; scroll clamps to the current layout. Independent new tabs start at the beginning; duplicated tabs/session restore may inherit a copy. Blocked or corrupt metadata is ignored. This stores offsets only, never text or Undo history. |
| Page scroll, Find match selection, imported file picker | in memory/browser managed | Not promised across reload. Undo/redo history is part of the committed draft. |

Storage access can be blocked or exhausted. The editor remains usable, and a Find settings warning indicates when state cannot be saved or restored. If the transliteration or autosave preference cannot be saved, a separate warning beside the save status names it; a later successful draft save does not clear it, and it clears only when that preference is saved. Search fields continue to work for the current page even when storage fails. Browser-provided form restoration is not treated as persistent configuration.
