/**
 * Editing the document title from outside the field: the host window's title bar and edits
 * held while editing moves to this window (#175, #197). Every edit goes through the title
 * Editor, so transliteration and Undo behave as if typed in the field; the title stays at
 * most 150 characters and deletes step whole characters.
 */
import { nextCharacterBoundary, previousCharacterBoundary } from '../editor/characters';
import type { Editor } from '../editor/editor';

export type TitleOp = { inputType: string; data: string | null };
/** A held title edit with the selection it was made at, in the (unchanged) field's coordinates. */
export type HeldTitleOp = TitleOp & { start: number; end: number };
export type TitleEditResult = { value: string; start: number; end: number };

export type TitleEditDeps = {
  viewMode: boolean;
  draftTitle: HTMLInputElement;
  titleEditor: Editor;
  syncTitleTooltip: () => void;
  rememberActive: () => void;
};

export function createTitleEditing(deps: TitleEditDeps) {
  /** One title edit through the title Editor (transliteration, undo); host title bar and held edits. */
  function applyTitleEdit(payload: { inputType: string; data: string | null; start: number; end: number }): { value: string; start: number; end: number } | null {
    if (deps.viewMode || deps.draftTitle.readOnly || deps.draftTitle.disabled) return null;
    const length = deps.draftTitle.value.length;
    const start = Math.max(0, Math.min(payload.start, length));
    const end = Math.max(start, Math.min(payload.end, length));
    // Do not focus the hidden embed #draft-title — that steals caret from the host
    // title bar (especially on Firefox) and drops later keystrokes.
    try { deps.draftTitle.setSelectionRange(start, end); } catch { /* Not focused. */ }
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: payload.inputType,
      data: payload.data ?? undefined,
    });
    deps.draftTitle.dispatchEvent(event);
    if (!event.defaultPrevented) {
      if (payload.inputType === 'insertText' && payload.data) {
        const room = Math.max(0, 150 - (deps.draftTitle.value.length - (end - start)));
        deps.draftTitle.setRangeText(payload.data.slice(0, room), start, end, 'end');
        deps.draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType, data: payload.data }));
      } else if (
        (payload.inputType === 'insertFromPaste' || payload.inputType === 'insertFromDrop')
        && payload.data
      ) {
        const room = Math.max(0, 150 - (deps.draftTitle.value.length - (end - start)));
        deps.draftTitle.setRangeText(payload.data.slice(0, room), start, end, 'end');
        deps.draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType, data: payload.data }));
      } else if (payload.inputType === 'deleteContentBackward') {
        if (start === end && start > 0) deps.draftTitle.setRangeText('', previousCharacterBoundary(deps.draftTitle.value, start), start, 'end');
        else deps.draftTitle.setRangeText('', start, end, 'end');
        deps.draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType }));
      } else if (payload.inputType === 'deleteContentForward') {
        if (start === end && start < deps.draftTitle.value.length) deps.draftTitle.setRangeText('', start, nextCharacterBoundary(deps.draftTitle.value, start), 'end');
        else deps.draftTitle.setRangeText('', start, end, 'end');
        deps.draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType }));
      } else if (payload.inputType === 'deleteByCut') {
        deps.draftTitle.setRangeText('', start, end, 'end');
        deps.draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType }));
      } else if (payload.inputType === 'historyUndo') {
        deps.titleEditor.undo();
        try { deps.draftTitle.blur(); } catch { /* Hidden embed field. */ }
      } else if (payload.inputType === 'historyRedo') {
        deps.titleEditor.redo();
        try { deps.draftTitle.blur(); } catch { /* Hidden embed field. */ }
      }
      if (deps.draftTitle.value.length > 150) {
        deps.draftTitle.value = deps.draftTitle.value.slice(0, 150);
        deps.draftTitle.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    deps.syncTitleTooltip();
    deps.rememberActive();
    return {
      value: deps.draftTitle.value,
      start: deps.draftTitle.selectionStart ?? 0,
      end: deps.draftTitle.selectionEnd ?? 0,
    };
  }
  /**
   * Apply held title edits in order. Each edit's selection is in the coordinates of the
   * title shown while waiting; map it past earlier held edits. When `changed` (a newer
   * title arrived meanwhile), keep that title and add the edits at its end.
   */
  function applyHeldTitleOps(ops: HeldTitleOp[], changed: boolean): { start: number; end: number } {
    // A newer title may have arrived with the takeover: keep it and add the edits at its end.
    // The field showed the old title while edits were held, so each edit's selection is in
    // old-title coordinates. Map it past earlier held edits: shifts made at or before a
    // position move it along (End, 1, Home, 2 on "Имя" gives "2Имя1").
    const shifts: { at: number; by: number }[] = [];
    const mapPos = (pos: number): number => pos + shifts.reduce((sum, shift) => sum + (shift.at <= pos ? shift.by : 0), 0);
    let start = deps.draftTitle.value.length;
    let end = start;
    let previous: HeldTitleOp | undefined;
    for (const op of ops) {
      const sameSpot = previous && previous.start === op.start && previous.end === op.end;
      if (!changed && !sameSpot) {
        start = mapPos(op.start);
        end = Math.max(start, mapPos(op.end));
      }
      const before = deps.draftTitle.value.length;
      const result = applyTitleEdit({ inputType: op.inputType, data: op.data, start, end });
      if (!result) break;
      if (!changed) shifts.push({ at: op.start, by: result.value.length - before });
      ({ start, end } = result);
      previous = op;
    }
    return { start, end };
  }
  return { applyTitleEdit, applyHeldTitleOps };
}
