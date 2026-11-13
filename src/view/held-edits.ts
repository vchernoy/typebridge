/**
 * Edits made in a quiet reader (#175, #197): a clean window whose document another window is
 * editing. A title edit or a document-changing control starts the takeover; what was typed or
 * clicked is held and applied once editing arrives here, so nothing is lost. Plain focus (Tab,
 * F6, programmatic) does not take over; the text field starts a takeover itself (focus-handoff).
 */
import { EDITABLE_HERE } from '../editor/status';
import type { StatusLine } from '../ui/status-line';
import { moveReadOnlyCaret } from '../ui/readonly-caret';
import { titleOpForKey, type HeldTitleOp, type TitleOp } from '../ui/title-edits';
import type { EditorState } from './editor-state';
import type { FocusHandoffController } from './focus-handoff';

/** Controls whose click in a quiet reader is replayed once this window can edit. */
const REPLAY_AFTER_TAKEOVER = new Set(['undo', 'redo', 'delete-draft', 'convert-cyrillic', 'convert-latin', 'clear', 'replace-one', 'replace-all']);

export type HeldEditsDeps = {
  captureSearchCommand?: () => () => void;
  draftTitle: HTMLInputElement;
  applyHeldTitleOps: (ops: HeldTitleOp[], changed: boolean) => { start: number; end: number };
  quietReader: () => boolean;
  readOnlyNow: () => boolean;
  focusHandoff: () => FocusHandoffController | undefined;
};

export function createHeldEdits(state: EditorState, statusLine: StatusLine, deps: HeldEditsDeps) {
  const { draftTitle, applyHeldTitleOps, quietReader, readOnlyNow } = deps;
  const { showSaveState, announceAction } = statusLine;
  /** A control clicked in a quiet reader; it runs once this window can edit that document. */
  let replayButton: { button: HTMLButtonElement; documentId: string; restoreSearch?: () => void } | undefined;
  /** Title edits held during a takeover, tied to their document (#197). */
  let titleBuffer: { documentId: string; baseValue: string; ops: HeldTitleOp[]; fromHost: boolean } | undefined;
  /** Rename… started while read-only: select the (possibly newer) title once editable. */
  let selectTitleWhenEditable = false;

  /** Apply held title edits through the title Editor (transliteration, undo) at the user's caret. */
  function replayTitleBuffer(): void {
    const held = titleBuffer;
    titleBuffer = undefined;
    if (!held || held.documentId !== state.active.id || draftTitle.readOnly) return;
    const { start, end } = applyHeldTitleOps(held.ops, draftTitle.value !== held.baseValue);
    // Leave focus where the user put it; only place the caret if the title still has it.
    if (!held.fromHost && document.activeElement === draftTitle) {
      try { draftTitle.setSelectionRange(start, end); } catch { /* Not focusable. */ }
    }
  }
  /** Editing moved to this window: show the normal save state and finish a pending control. */
  function onEditableHere(): void {
    showSaveState();
    replayTitleBuffer();
    if (selectTitleWhenEditable) {
      selectTitleWhenEditable = false;
      if (document.activeElement === draftTitle) draftTitle.select();
    }
    const pendingAction = replayButton;
    replayButton = undefined;
    if (!pendingAction || pendingAction.documentId !== state.active.id || readOnlyNow()) return;
    const { button } = pendingAction;
    if (button.isConnected && !button.disabled) { pendingAction.restoreSearch?.(); button.click(); }
  }
  /** Focus handoff feedback: editing arrived, or the takeover failed and held edits are dropped. */
  function onHandoffAnnouncement(text: string): void {
    if (text === EDITABLE_HERE) onEditableHere();
    else {
      replayButton = undefined;
      if (titleBuffer) {
        titleBuffer = undefined;
        announceAction('Your title change was not applied.', { keepConflict: true });
      }
      announceAction(text, { keepConflict: true });
    }
  }
  /** Start a takeover from an edit gesture (title, controls, host title bar). */
  const requestEditHere = (): void => {
    if (!quietReader() || state.transitioning || state.deleting || state.transferFrozen) return;
    const focusHandoff = deps.focusHandoff();
    if (focusHandoff?.pending()) return;
    focusHandoff?.requestHandoff();
  };
  /**
   * Hold a title edit made while this window cannot edit yet, and start the takeover.
   * Returns false when the title is editable (the edit should run normally).
   */
  const bufferTitleEdit = (op: TitleOp, start: number, end: number, fromHost: boolean): boolean => {
    if (!draftTitle.readOnly || !quietReader()) return false;
    if (!titleBuffer || titleBuffer.documentId !== state.active.id) {
      titleBuffer = { documentId: state.active.id, baseValue: draftTitle.value, ops: [], fromHost };
    }
    titleBuffer.ops.push({ ...op, start, end });
    // Typed edits replace the selection themselves; do not reselect afterwards.
    selectTitleWhenEditable = false;
    requestEditHere();
    return true;
  };
  function installTitleListeners(): void {
    draftTitle.addEventListener('pointerdown', requestEditHere);
    draftTitle.addEventListener('beforeinput', requestEditHere);
    draftTitle.addEventListener('paste', event => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text && bufferTitleEdit({ inputType: 'insertFromPaste', data: text },
        draftTitle.selectionStart ?? draftTitle.value.length, draftTitle.selectionEnd ?? draftTitle.value.length, false)) {
        event.preventDefault();
      } else requestEditHere();
    });
    // A read-only input fires no beforeinput, so start from keyboard intent; focus alone does not.
    // The key itself is held and applied once editing arrives, so nothing typed is lost (#197).
    draftTitle.addEventListener('keydown', event => {
      // Read-only inputs ignore caret keys; place the caret so held edits land where intended.
      if (moveReadOnlyCaret(draftTitle, event)) return;
      const op = titleOpForKey(event);
      if (!op) return;
      if (bufferTitleEdit(op, draftTitle.selectionStart ?? draftTitle.value.length,
        draftTitle.selectionEnd ?? draftTitle.value.length, false)) event.preventDefault();
    });
  }
  /** A document-changing control clicked in a quiet reader takes over, then runs. */
  function installControlReplay(): void {
    document.addEventListener('click', event => {
      const button = (event.target as Element | null)?.closest?.('button');
      if (!button || !REPLAY_AFTER_TAKEOVER.has(button.id) || !quietReader()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      replayButton = { button, documentId: state.active.id, restoreSearch: button.id.startsWith('replace-') ? deps.captureSearchCommand?.() : undefined };
      requestEditHere();
    }, true);
  }

  return {
    onEditableHere,
    onHandoffAnnouncement,
    requestEditHere,
    bufferTitleEdit,
    installTitleListeners,
    installControlReplay,
    /** Drop held edits (the shown document changed). */
    clear(): void { replayButton = undefined; titleBuffer = undefined; },
    selectTitleWhenEditable(next: boolean): void { selectTitleWhenEditable = next; },
  };
}
