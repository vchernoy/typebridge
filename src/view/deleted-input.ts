/**
 * Input in a window whose document was deleted in another window (#175 follow-up). Nobody owns
 * the document any more, so there is no takeover: Keep as new document or Close. Typing or
 * pasting into the text or title keeps it as a new document, and what was typed is held and
 * replayed through the editors (transliteration, undo) once the copy is editable.
 */
import { bufferInsertFromKeyboard, replayBufferedInsert, type BufferedInsert } from './handoff';
import type { EditorState } from './editor-state';
import { titleOpForKey, type HeldTitleOp, type TitleOp } from '../ui/title-edits';

export type DeletedInputDeps = {
  field: HTMLTextAreaElement;
  draftTitle: HTMLInputElement;
  /** Keep as new document is making the copy. */
  isKeepingDeleted: () => boolean;
  /** Save the shown text as a new document; resolves true once it is editable. */
  keepDeletedAsNew: () => Promise<boolean>;
  switchDraft: (id?: string) => Promise<unknown>;
  applyHeldTitleOps: (ops: HeldTitleOp[], changed: boolean) => { start: number; end: number };
};

export function setupDeletedInput(state: EditorState, deps: DeletedInputDeps) {
  const { field, draftTitle } = deps;
  // Deleted elsewhere (#175 follow-up): no takeover (nobody owns it any more). Keep as new
  // document or Close; typing or pasting into the text or title keeps it, then applies.
  document.querySelector<HTMLButtonElement>('#keep-deleted')!.addEventListener('click', () => {
    void deps.keepDeletedAsNew().then(kept => { if (kept) field.focus(); });
  });
  document.querySelector<HTMLButtonElement>('#close-deleted')!.addEventListener('click', () => {
    const other = state.drafts.find(draft => draft.id !== state.active.id);
    void deps.switchDraft(other?.id);
  });
  // Held while the copy is created, then replayed through the editors (transliteration, undo)
  // as soon as it is editable, before any later key or the first save.
  let heldText: BufferedInsert[] = [];
  let heldTitle: HeldTitleOp[] = [];
  let heldTitleBase = '';
  let heldTitleFromHost = false;
  const holdTitleOp = (op: TitleOp, start: number, end: number, fromHost: boolean): void => {
    if (heldTitle.length === 0) { heldTitleBase = draftTitle.value; heldTitleFromHost = fromHost; }
    heldTitle.push({ ...op, start, end });
  };
  const drain = (): void => {
    const text = heldText;
    const title = heldTitle;
    heldText = [];
    heldTitle = [];
    // Focus first: Firefox can drop an unfocused textarea's caret between replayed edits.
    if (text.length) {
      const caretStart = field.selectionStart;
      const caretEnd = field.selectionEnd;
      field.focus();
      try { field.setSelectionRange(caretStart, caretEnd); } catch { /* Not focusable. */ }
    }
    for (const item of text) replayBufferedInsert(field, item);
    if (title.length) {
      const at = deps.applyHeldTitleOps(title, draftTitle.value !== heldTitleBase);
      if (!heldTitleFromHost) {
        draftTitle.focus();
        try { draftTitle.setSelectionRange(at.start, at.end); } catch { /* Not focusable. */ }
      }
    }
  };
  const keepThenApply = (): void => {
    void deps.keepDeletedAsNew().then(kept => {
      if (!kept) { heldText = []; heldTitle = []; }
    });
  };
  const deletedTarget = (event: Event): HTMLTextAreaElement | HTMLInputElement | undefined => {
    if (!state.deletedElsewhere) return undefined;
    return event.target === field ? field : event.target === draftTitle ? draftTitle : undefined;
  };
  // While Keep is making the copy (usually a few ms), the caret and selection must not move:
  // held edits replay at the selection captured when it started.
  const keepPending = (): boolean => deps.isKeepingDeleted() || heldText.length > 0 || heldTitle.length > 0;
  const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  // Capture on the document so these run before the takeover listeners on the field.
  document.addEventListener('pointerdown', event => {
    if (!deletedTarget(event)) return;
    event.stopImmediatePropagation();
    if (keepPending()) event.preventDefault();
  }, true);
  document.addEventListener('keydown', event => {
    const target = deletedTarget(event);
    if (!target) return;
    if (keepPending() && CARET_KEYS.has(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (target === field) {
      const insert = bufferInsertFromKeyboard(event);
      if (!insert) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      heldText.push(insert);
    } else {
      const op = titleOpForKey(event);
      if (!op) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      holdTitleOp(op, draftTitle.selectionStart ?? draftTitle.value.length, draftTitle.selectionEnd ?? draftTitle.value.length, false);
    }
    keepThenApply();
  }, true);
  document.addEventListener('paste', event => {
    const target = deletedTarget(event);
    if (!target) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!text) return;
    if (target === field) heldText.push({ kind: 'paste', text });
    else holdTitleOp({ inputType: 'insertFromPaste', data: text }, draftTitle.selectionStart ?? draftTitle.value.length, draftTitle.selectionEnd ?? draftTitle.value.length, false);
    keepThenApply();
  }, true);

  return {
    /** Replay held input once the kept copy is editable. */
    drain,
    /** Hold a title edit (from the host title bar) made while the copy is created. */
    holdTitleOp,
    /** Keep the document as new, dropping held input if that fails. */
    keepThenApply,
  };
}
