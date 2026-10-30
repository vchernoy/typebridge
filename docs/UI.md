# UI design specification

> Historical design intent, not a current feature inventory. See [README](../README.md), [architecture](ARCHITECTURE.md), [settings lifetimes](SETTINGS-PERSISTENCE.md) and [roadmap](ROADMAP.md) for implemented behavior. Current tabs reopen the latest saved draft (#22), committed drafts/history use IndexedDB (#45), recovery is implemented (#53), and offline support/Pages deployment are enabled. Blank-new-tab wording and future feature descriptions below have not been implemented literally. This documentation update does not change product behavior.


## Visual direction
Quiet, spacious writing workspace; strong hierarchy, high contrast, understated blue accent. Use system fonts, generous line-height, clear labels and visible focus rings. No imitation of competitors' branding. Theme tokens for surface, text, muted text, border, accent, focus and error; test contrast in light and dark themes and forced-colors mode.

## Desktop layout
Compact header with TypeBridge name, theme selector and Settings. Above the main writing area: language/preset, Latin/Russian live-input toggle, optional dual-panel switch and accessible conversion actions. Editor dominates available width and height with a visible resize grip, keyboard-accessible increase/decrease and reset. Footer/status shows character count, draft name, save status and copy/clear actions. A Drafts menu exposes saved documents without conflating separate tabs. Collapsible reference chart shows mappings and separator examples.

Single mode has one editable area. Dual mode uses two labeled side-by-side panels: editable source and read-only converted result with direction and swap controls. At narrow widths stack them, retaining source first. Every action has an accessible label and feedback; controls are usable without hover. Avoid replacing native text selection, context menus or expected keyboard shortcuts.

## Settings
Sections: Input and mappings (preset, per-rule edit, conflicts, preview and reset); Editor (height, font size and panel mode); Appearance (system/light/dark); Privacy (auto-save drafts on by default, disable toggle, local-only explanation, retain/delete saved drafts); Drafts (list, open, rename, delete existing drafts; a new independent tab starts blank); shortcuts and restore defaults. Explicitly state local storage is browser/device-specific and may be cleared. Show unsaved-storage errors without removing text.

## Responsive and accessibility
Target 320px upward, avoid horizontal scrolling and clipped editor/toolbars; keep controls usable when the mobile keyboard opens. Touch targets at least 44 CSS px where practical. Use real buttons, labels, fieldsets, focus order, keyboard-operable resizing, `aria-live` for concise status, and non-color indicators. Respect reduced-motion, browser zoom and high contrast. Test 200% zoom and screen readers; no automatic focus on load.
