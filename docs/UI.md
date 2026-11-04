# Current UI

This describes the implemented workspace. [#123](https://github.com/vchernoy/typebridge/issues/123) records the approved layout; [#137](https://github.com/vchernoy/typebridge/issues/137) tracks follow-up improvements. Future product ideas remain in the [PRD](PRD.md) and [roadmap](ROADMAP.md).

## Normal workspace

The top bar contains a small TypeBridge heading, the document title edited in place, a ▾ **Documents** menu, compact save state, **Latin / Кириллица** typing switch, Focus and Settings. The switch is a real checkbox with the switch role and accessible name “Кириллица”; its description gives the configured shortcut. Clicking a word chooses that typing mode; Space toggles it.

The document menu lists saved documents and offers New document, Import…, Export as TXT, Export as JSON and Delete…. Share link is reserved for #39 and has no menu control until sharing exists. **Open in comparison window** ([#159](https://github.com/vchernoy/typebridge/issues/159)) is specified in the [comparison ADR](adr/159-comparison-window.md) and is not shown until W2 lands; it opens the latest committed saved copy in a second window/tab as read-only, never private unsaved text. Opening focuses the list. Escape, a click outside or an action closes the menu; actions return focus to the trigger. Pointer selection closes the list, while keyboard arrow navigation keeps it open. Documents are browser-local; code, storage identifiers and the export format retain their `draft` names ([#108](https://github.com/vchernoy/typebridge/issues/108)).

The editing toolbar holds Undo/Redo, To Cyrillic and To Latin (convert selected text), Find and Copy. Its **⋯** menu contains Go to line, Clear text and Keyboard shortcuts. The shortcut sheet is a two-column list of actions and keys (with Escape and reserved-shortcut notes), using platform labels, the current typing shortcut and all fixed bindings, with a link to the existing shortcut setting; capture/remapping remains #69. Find/Replace and Go to line open on demand through buttons or Cmd/Ctrl+F and Cmd/Ctrl+G; Escape or × closes them and returns to the editor. Each Find/Replace label stays with its field. Match case and Regex are labeled checkbox chips in the find bar. Previous/Next match use ↑/↓ buttons with accessible names. The status shows the total before navigation and the current position (for example “2 of 5”) after navigation; matching rules are unchanged. See [editor behavior](EDITOR-BEHAVIOR.md) for conversion, search and history details.

A compact dot and label beside the title shows Saved, Saving…, Not saved or Save failed ([#131](https://github.com/vchernoy/typebridge/issues/131), [#156](https://github.com/vchernoy/typebridge/issues/156)). It is the only visible save-state label; Autosave off shows Not saved. Routine “Saved locally” / “Saving…” announcements stay in the lower live region for assistive tech but are not shown again visually. Action feedback, conflict notices and storage/privacy warnings remain visible under the editor beside character/word/read-time counts (with singular forms) and caret position. Long titles ellipsize in the field; the full title remains in the field value and tooltip. Copying or exporting does not dismiss an unsaved warning.

## Settings and privacy

Settings opens a **non-modal side panel**, so changes can be tried in the editor while it remains open. It contains the transliteration shortcut, mapping chart and custom rules editor, Autosave, Tab indents and an About your documents section with storage/history/offline information. A short About your documents link under the editor opens that section in one step and returns focus when closed. Closing with Escape or × returns focus. Focus mode hides this panel.

Autosave is on by default. Turning it off stops subsequent automatic saves of text and title, and offers explicit Keep saved copy / Delete saved copy choices ([#114](https://github.com/vchernoy/typebridge/issues/114)). Unsaved changes can be lost on reload, tab discard or closing. Browser storage is specific to this browser/device and can be cleared or evicted; export important work. See [settings lifetimes](SETTINGS-PERSISTENCE.md) for storage and recovery limits. There is no account, sync, telemetry or text upload.

## Focus mode

Focus keeps the **same title bar controls** above the editor: title, ▾ document menu, save state, typing switch and Exit focus ([#104](https://github.com/vchernoy/typebridge/issues/104), [#136](https://github.com/vchernoy/typebridge/pull/136)). There is no separate document picker. Rename, switch and create use the same controls and save/conflict/discard handling as Normal mode without leaving Focus. The brand, Focus button, Settings, shortcut hint and editing toolbar are hidden. The editor and its history are preserved; Normal and Focus sizes are stored separately.

Escape from the editor or Cmd/Ctrl+Shift+Enter toggles Focus. The Exit button leaves it. Focus preference is restored after the selected document loads; see [settings lifetimes](SETTINGS-PERSISTENCE.md).

## Phones and resizing

At 640 px and below, the brand is visually hidden, the title/menu/save state occupy the first row, and the typing switch and icon-only Focus/Settings controls follow. In Focus mode, the switch and Exit follow the title row. The shortcut hint and toolbar separators are hidden and margins shrink. Convert buttons use shorter Cyr/Lat labels while keeping accessible names. At 400 px and below, Find and Copy use icons with their accessible names retained and 44 px targets. Aim for one editing-toolbar row at 390 px with system fonts; wider fonts or 320 px may wrap. Controls must never cause horizontal overflow. Coverage includes 320/390 px and a 24 px root font.

The editor has one custom corner grip ([#70](https://github.com/vchernoy/typebridge/issues/70)); iPhone Safari does not provide a usable native CSS resize grip. Dragging changes width and height. Keyboard users can focus the grip and use arrow keys to resize. Text selection and native editing remain available.

## Keyboard and accessibility

Escape closes one visible layer: confirmation dialog → Settings → document/More menu → Find/Go to line → Focus shortcut ([#132](https://github.com/vchernoy/typebridge/issues/132)). This also applies after focus moves into the editor. CSS-hidden panels do not intercept Escape. Composition, repeated/already-handled events and collapsed native select popups retain their ownership. Clear text, Delete document, Import, unsaved-change discard and emergency-backup discard use the same in-page confirmation as the Autosave choice. Each names its action and safe alternative; the background is inert while the modal is open, Tab stays inside it, Escape takes the safe choice and focus returns after closing. Browser beforeunload warnings remain browser-managed.

Controls use semantic buttons, labels, dialogs, listbox/menu patterns and visible focus. The detailed status uses polite announcements; the compact save label does not duplicate them. Settings → Appearance offers System, Light or Dark; System follows device changes, manual choices persist in this browser and apply before the application bundle loads. The UI uses semantic color variables in `src/style.css` and has explicit forced-colors system styling. U5 preserved the existing colors. U7 makes the shared confirmation/shortcut dialog use the dark surface for readable text; further contrast checks remain in #137 U10. Aim for 44 px touch targets and preserve native selection, context menus and expected shortcuts. Automated browser checks are not real iPhone, OS input-method, screen-reader or 200% zoom verification; record those separately in [#11](https://github.com/vchernoy/typebridge/issues/11). [#105](https://github.com/vchernoy/typebridge/issues/105)'s Escape typing-mode toggle remains undecided.

## Updates

When a newer offline worker is waiting, a non-blocking New version available notice offers Reload or Not now. It never reloads automatically. Reload first saves or verifies a tab-local reload backup; if neither is available, editing stays open. Autosave-off edits are never silently written: an explicit discard/reload choice warns about losing private changes. Not now hides the notice for this tab's session. Activation failure leaves text on screen. Real browser termination and storage eviction remain outside these guarantees.

## Reset settings

Settings → Reset settings to defaults asks explicitly before resetting appearance (System), typing mode/shortcut, custom rules, Tab indents, Find options, Normal/Focus editor sizes and Focus preference. It does not reload the page, delete documents, change current text/history or enable Autosave. Partial storage failures are reported; they do not prevent other preferences from being reset.
