/**
 * Tab and Shift+Tab indent lines (#56). Keyboard users are never trapped: the "Tab indents"
 * setting turns this off, and Shift+Tab on a line with nothing to outdent moves focus as usual.
 * The indent rule itself is the pure indentEdit in editor/indent.ts.
 */
import type { Editor } from '../editor/editor';
import { indentEdit } from '../editor/indent';
import { SHORTCUTS } from '../editor/keyboard-shortcuts';
import { notifyPrefsChanged } from '../view/prefs-sync';

const TAB_INDENT_KEY = 'typebridge.editor.tabIndent.v1';

export type TabIndentDeps = {
  checkbox: HTMLInputElement;
  /** This window's prefs origin, so it ignores its own change broadcast. */
  prefsOrigin: string;
  /** False while this window must not change the document. */
  canIndent: () => boolean;
};

export function setupTabIndent(deps: TabIndentDeps) {
  const { checkbox } = deps;
  try { checkbox.checked = localStorage.getItem(TAB_INDENT_KEY) !== 'off'; } catch { /* Keep the default. */ }
  function save(): boolean {
    try {
      localStorage.setItem(TAB_INDENT_KEY, checkbox.checked ? 'on' : 'off');
      notifyPrefsChanged({ name: 'tabIndent', origin: deps.prefsOrigin });
      return true;
    } catch { return false; }
  }
  let applyingRemote = false;
  checkbox.addEventListener('change', () => {
    if (applyingRemote) return;
    save();
  });
  function applyFromStorage(): void {
    applyingRemote = true;
    try {
      try { checkbox.checked = localStorage.getItem(TAB_INDENT_KEY) !== 'off'; } catch { /* keep */ }
    } finally {
      applyingRemote = false;
    }
  }
  function handleKeydown(event: KeyboardEvent, surface: HTMLTextAreaElement, surfaceEditor: Editor): void {
    if (event.key !== SHORTCUTS.indent.key || !checkbox.checked || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || surface.readOnly || !deps.canIndent()) return;
    const change = indentEdit(surface.value, surface.selectionStart, surface.selectionEnd, event.shiftKey);
    // Only Shift+Tab with nothing to outdent leaves the editor; a forward Tab that changes nothing stays put.
    if (!change && event.shiftKey) return;
    event.preventDefault();
    if (!change) return;
    surfaceEditor.replaceAndSelect(change.start, change.end, change.text, change.selectionStart, change.selectionEnd);
  }
  return {
    applyFromStorage,
    handleKeydown,
    /** Settings → Reset: turn Tab indents back on; false when it could not be saved. */
    reset(): boolean { checkbox.checked = true; return save(); },
  };
}
