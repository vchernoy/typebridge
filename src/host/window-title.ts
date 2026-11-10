/**
 * The document title in a host window's title bar (#175 step 8, #197). It is a host-page input
 * that writes through to the window's title Editor (transliteration, undo), stays locked until
 * that title is editable, and in a quiet reader takes over editing from the first click or key,
 * holding what was typed. It also keeps the window's accessible names in step with the title.
 */
import { moveReadOnlyCaret } from '../ui/readonly-caret';
import { titleOpForKey } from '../ui/title-edits';
import { editorWindowApi } from '../view/embed-api';
import type { EffectiveLayoutMode } from './layout-mode';

/** The title shown for a raw title ('Untitled document' when blank). */
export function displayTitle(raw: string): string {
  return raw.trim() || 'Untitled document';
}

/** The move handle's accessible name: how to move (and resize) this window in its layout. */
export function moveHandleLabel(windowId: string, label: string, mode: EffectiveLayoutMode): string {
  return mode === 'stacked'
    ? `Move window ${windowId}: ${label} (Ctrl/⌘+Shift+Up/Down to resize height)`
    : `Move window ${windowId}: ${label} (arrow keys; Ctrl/⌘+Shift+arrows to resize)`;
}

export type WindowTitleDeps = {
  windowId: string;
  shell: HTMLElement;
  frame: HTMLIFrameElement;
  moveHandle: HTMLElement;
  closeBtn: HTMLButtonElement;
  mode: () => EffectiveLayoutMode;
  /** Make this window the active one. */
  activate: () => void;
  /** F6 in the title: move focus to the next (or previous) window from this one. */
  cycleFocus: (backward: boolean) => void;
};

export function createWindowTitle(deps: WindowTitleDeps) {
  const { windowId, shell, frame, moveHandle, closeBtn } = deps;
  // #175 step 8: document title lives on the host chrome; rename write-through to the iframe.
  // Keep the title input a sibling of the move handle (not inside the button).
  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'host-window-title';
  title.value = 'Untitled document';
  title.setAttribute('aria-label', 'Document title');
  title.spellcheck = false;
  // Locked until the iframe mounts an editable #draft-title (avoids lost renames).
  title.readOnly = true;

  // A visible way to rename: the title is a text field, but this makes it obvious.
  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'host-window-rename';
  renameBtn.setAttribute('aria-label', 'Rename document');
  renameBtn.title = 'Rename document';
  renameBtn.textContent = '✎';

  const applyMoveAria = (label: string): void => {
    moveHandle.setAttribute('aria-label', moveHandleLabel(windowId, label, deps.mode()));
  };

  /** Update chrome metadata without rewriting the input while the user is typing. */
  const applyChromeMeta = (raw: string): void => {
    const label = displayTitle(raw);
    title.title = label;
    shell.setAttribute('aria-label', label);
    frame.title = label;
    applyMoveAria(label);
    closeBtn.setAttribute('aria-label', `Close ${label}`);
  };

  const applyChromeTitle = (next: string): void => {
    const label = displayTitle(next);
    if (document.activeElement !== title && title.value !== label) title.value = label;
    applyChromeMeta(title.value);
  };

  /** Runs when the title goes from read-only to editable (set below, after its helpers). */
  let onTitleUnlocked = (): void => {};
  const syncTitleEditable = (): void => {
    const wasReadOnly = title.readOnly;
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      const draft = doc.querySelector<HTMLInputElement>('#draft-title');
      // Stay locked until the iframe title exists (and is editable).
      if (!draft) {
        title.readOnly = true;
        return;
      }
      title.readOnly = draft.readOnly || draft.disabled;
    } catch { /* Cross-origin or mid-navigation — keep current state. */ }
    // Adopt the window's title and caret before any native edit here (#197): held
    // edits may have just been applied there, so this field's text is stale.
    if (wasReadOnly && !title.readOnly) onTitleUnlocked();
  };

  let applyingFromIframe = false;
  let hostTitleComposing = false;
  const applyHostTitleResult = (result: { value: string; start: number; end: number }): void => {
    applyingFromIframe = true;
    title.value = result.value;
    try { title.setSelectionRange(result.start, result.end); } catch { /* Input type may reject. */ }
    applyingFromIframe = false;
    applyChromeMeta(title.value);
    // titleEditor.undo/redo focuses the hidden iframe field; keep caret in the host title.
    if (document.activeElement !== title) title.focus({ preventScroll: true });
  };

  // A window whose document another window is editing looks editable: clicking or
  // typing in its title takes over editing there, then the title unlocks (quiet reader).
  let unlockTimer: ReturnType<typeof setInterval> | undefined;
  /** Rename (✎ or Documents → Rename…) asked for the whole name selected once it unlocks. */
  let selectAllOnUnlock = false;
  const requestEditFromTitle = (): void => {
    syncTitleEditable();
    if (!title.readOnly) return;
    try {
      editorWindowApi(frame.contentWindow)?.__typebridgeRequestEdit?.();
    } catch { /* Frame mid-navigation. */ }
    clearInterval(unlockTimer);
    let tries = 0;
    unlockTimer = setInterval(() => {
      syncTitleEditable();
      if (!title.readOnly || ++tries > 40) clearInterval(unlockTimer);
    }, 50);
  };
  onTitleUnlocked = (): void => {
    clearInterval(unlockTimer);
    const selectAll = selectAllOnUnlock;
    selectAllOnUnlock = false;
    // The takeover may carry a newer (even unsaved) title from the other window;
    // show it before any edit here, so a later commit cannot overwrite it.
    try {
      const authoritative = editorWindowApi(frame.contentWindow)?.__typebridgeGetTitle?.();
      if (authoritative !== undefined && authoritative !== title.value) {
        applyingFromIframe = true;
        title.value = authoritative;
        applyingFromIframe = false;
        // Keep the caret where held edits left it in the window's title.
        const inner = frame.contentDocument?.querySelector<HTMLInputElement>('#draft-title');
        const at = inner?.value === authoritative ? inner.selectionStart ?? authoritative.length : authoritative.length;
        const to = inner?.value === authoritative ? inner.selectionEnd ?? at : at;
        title.setSelectionRange(at, to);
        applyChromeMeta(title.value);
      }
    } catch { /* Frame mid-navigation. */ }
    // Rename replaces the name: select it again after a newer title arrived.
    if (selectAll && document.activeElement === title) title.select();
  };
  title.addEventListener('pointerdown', event => { event.stopPropagation(); requestEditFromTitle(); });
  const startRename = (): void => {
    deps.activate();
    title.focus();
    title.select();
    syncTitleEditable();
    selectAllOnUnlock = title.readOnly;
    requestEditFromTitle();
  };
  renameBtn.addEventListener('pointerdown', event => { event.stopPropagation(); });
  renameBtn.addEventListener('click', event => { event.stopPropagation(); startRename(); });
  title.addEventListener('focus', () => { syncTitleEditable(); });
  /** Hand a title edit made while this window cannot edit to the window, which holds it (#197). */
  const bufferInFrame = (op: { inputType: string; data: string | null }): boolean => {
    try {
      const held = editorWindowApi(frame.contentWindow)?.__typebridgeBufferTitleEdit?.(
        op,
        title.selectionStart ?? title.value.length,
        title.selectionEnd ?? title.value.length,
      );
      // Typed edits replace the selection themselves; do not reselect afterwards.
      if (held) selectAllOnUnlock = false;
      return !!held;
    } catch { return false; }
  };
  title.addEventListener('paste', event => {
    if (!title.readOnly) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text && bufferInFrame({ inputType: 'insertFromPaste', data: text })) event.preventDefault();
    requestEditFromTitle();
  });
  // Plain focus (Tab, F6) must not take over editing; typing into the title does, and
  // what was typed is applied once editing arrives.
  title.addEventListener('keydown', event => {
    if (!title.readOnly || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    // Read-only inputs ignore caret keys; place the caret so held edits land where intended.
    if (moveReadOnlyCaret(title, event)) return;
    const op = titleOpForKey(event);
    if (!op) return;
    if (bufferInFrame(op)) event.preventDefault();
    requestEditFromTitle();
  });
  title.addEventListener('compositionstart', () => { hostTitleComposing = true; });
  title.addEventListener('compositionend', () => {
    hostTitleComposing = false;
    if (title.readOnly) return;
    try {
      const result = editorWindowApi(frame.contentWindow)?.__typebridgeTitleCommit?.(
        title.value,
        title.selectionStart ?? title.value.length,
        title.selectionEnd ?? title.value.length,
      );
      if (result) applyHostTitleResult(result);
      else applyChromeMeta(title.value);
    } catch { applyChromeMeta(title.value); }
  });
  title.addEventListener('keydown', event => {
    // Keep arrow-key window move on the handle; let the input own typing keys.
    // F6 must cycle windows even while renaming — handle before stopPropagation so
    // the document-level host listener is not required for the title field.
    if (event.key === 'F6' && !event.altKey && !event.ctrlKey && !event.metaKey
      && !event.isComposing && !event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      // Title clicks do not activate the shell — cycle from this window, not stale activeId.
      deps.cycleFocus(event.shiftKey);
      return;
    }
    event.stopPropagation();
    if (event.isComposing) return;
    try {
      const hooks = editorWindowApi(frame.contentWindow);
      // #175 step 9: Find stays available in read-only windows (Replace does not).
      // Handle Ctrl/⌘+F before the read-only guard so a read-only title still opens Find.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
        && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        hooks?.__typebridgeOpenFind?.();
        return;
      }
      if (title.readOnly) return;
      // Forward undo/redo to the iframe title Editor (host input has no native history
      // when inserts are applied programmatically).
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'z' || key === 'y') {
          const redo = key === 'y' || (key === 'z' && event.shiftKey);
          event.preventDefault();
          const result = hooks?.__typebridgeTitleEdit?.({
            inputType: redo ? 'historyRedo' : 'historyUndo',
            data: null,
            start: title.selectionStart ?? 0,
            end: title.selectionEnd ?? 0,
          });
          if (result) applyHostTitleResult(result);
          return;
        }
      }
      // Forward the transliteration mode shortcut into the iframe (listener is document-local there).
      if (event.shiftKey && !event.altKey && !event.repeat
        && ((event.ctrlKey && !event.metaKey) || (event.metaKey && !event.ctrlKey))
        && (event.code === 'Space' || event.code === 'F7' || event.code === 'F8' || event.code === 'F9')) {
        hooks?.__typebridgeToggleTransliteration?.();
        event.preventDefault();
        return;
      }
    } catch { /* Frame mid-navigation. */ }
  });
  // Route insert typing through the iframe title Editor (transliteration). Let
  // deletes/clear/IME composition run natively on the host input, then write through.
  title.addEventListener('beforeinput', event => {
    syncTitleEditable();
    if (title.readOnly) {
      event.preventDefault();
      return;
    }
    if (hostTitleComposing || event.inputType.includes('Composition')) return;
    const insert = event.inputType === 'insertText'
      || event.inputType === 'insertFromPaste'
      || event.inputType === 'insertReplacementText'
      || event.inputType === 'insertFromDrop';
    if (!insert) return;
    event.preventDefault();
    try {
      const hooks = editorWindowApi(frame.contentWindow);
      const result = hooks?.__typebridgeTitleEdit?.({
        inputType: event.inputType === 'insertReplacementText' ? 'insertText' : event.inputType,
        data: event.data,
        start: title.selectionStart ?? 0,
        end: title.selectionEnd ?? 0,
      });
      if (result) applyHostTitleResult(result);
      else {
        const authoritative = hooks?.__typebridgeGetTitle?.();
        if (authoritative !== undefined) {
          applyingFromIframe = true;
          title.value = authoritative;
          applyingFromIframe = false;
          applyChromeMeta(title.value);
        }
      }
    } catch { /* Frame mid-navigation. */ }
  });
  title.addEventListener('input', () => {
    if (applyingFromIframe || hostTitleComposing) return;
    syncTitleEditable();
    if (title.readOnly) {
      try {
        const hooks = editorWindowApi(frame.contentWindow);
        const authoritative = hooks?.__typebridgeGetTitle?.();
        if (authoritative !== undefined) title.value = authoritative;
      } catch { /* Frame mid-navigation. */ }
      applyChromeMeta(title.value);
      return;
    }
    // Deletes, fill(), and other non-intercepted edits: commit through the title
    // Editor so undo history stays in sync (setTitle alone skips Editor deltas).
    if (title.value.length > 150) title.value = title.value.slice(0, 150);
    applyChromeMeta(title.value);
    try {
      const result = editorWindowApi(frame.contentWindow)?.__typebridgeTitleCommit?.(
        title.value,
        title.selectionStart ?? title.value.length,
        title.selectionEnd ?? title.value.length,
      );
      if (result) applyHostTitleResult(result);
    } catch { /* Frame mid-navigation. */ }
  });
  title.addEventListener('blur', () => {
    selectAllOnUnlock = false;
    if (title.readOnly) {
      applyChromeMeta(title.value);
      return;
    }
    const label = displayTitle(title.value);
    if (title.value !== label) {
      title.value = label;
      try {
        // Record normalization in titleEditor undo history (setTitle skips deltas).
        editorWindowApi(frame.contentWindow)?.__typebridgeTitleCommit?.(label, label.length, label.length);
      } catch { /* Frame mid-navigation. */ }
    }
    applyChromeMeta(label);
  });

  return {
    title,
    renameBtn,
    /** Rename (✎ or Documents → Rename…): focus and select the title, taking over editing first. */
    startRename,
    syncTitleEditable,
    applyChromeTitle,
  };
}
