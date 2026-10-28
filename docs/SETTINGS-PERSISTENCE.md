# Settings and session state

TypeBridge stores everything locally in the browser profile. Browser privacy settings, session restore, storage clearing and eviction can change lifetime. No text is sent to a server.

| Control or state | Storage | Lifetime and tab behavior |
| --- | --- | --- |
| Transliteration on/off | localStorage | Restored on reload, restart and new tabs; each tab writes only this preference. Already-open tabs retain their own current choice. |
| Transliteration shortcut | localStorage | Restored on reload, restart and new tabs. |
| Saved mapping overrides | localStorage | Restored on reload, restart and new tabs. Unsaved edits in the mapping form are transient. |
| Autosave | localStorage | Restored on reload, restart and new tabs. Existing tabs keep their current control state. |
| Match case and Regex | Separate localStorage keys | Restored on reload, restart and new tabs; an already-open tab retains its current values. Each preference is written independently. |
| Find and Replace text | Separate sessionStorage keys | Restored on reload in the same tab. Independent new tabs start empty; duplicated tabs can inherit an initial copy. Closing a tab normally ends its session, but browser session-restore features may retain it across close or restart. Avoid searching for sensitive text on a shared browser; clear the fields when finished. |
| Current document selection | sessionStorage hint | Restored in the same tab where available. Duplicate tabs may inherit the hint. |
| Drafts and undo/redo history | IndexedDB | Committed documents and history survive reload and browser restart subject to browser storage. Revision checks prevent stale writes; conflicts create copies. |
| Emergency recovery | temporary localStorage journal and sessionStorage reload snapshot | Only with autosave enabled; see architecture for recovery, limitations and conflict handling. |
| Focus mode and open settings panels | in memory | Reset on reload; editing layout is not a saved preference. |
| Editor resize | localStorage | Explicit mouse/touch resizing in normal mode is restored on reload, restart and new tabs, subject to responsive min/max constraints. Focus mode uses its own temporary dimensions. |
| Appearance | system color scheme | Follows the operating system; no selectable theme is currently implemented. |
| Selection, caret, scroll, Find match selection, imported file picker | in memory | Transient and not promised across reload. Undo/redo history is part of the committed draft. |

Storage access can be blocked or exhausted. The editor remains usable, and a Find settings warning indicates when state cannot be saved or restored. Search fields continue to work for the current page even when storage fails. Browser-provided form restoration is not treated as persistent configuration.
