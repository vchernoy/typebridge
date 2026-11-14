import type { EditBlock } from '../view/ownership';

export const CONFLICT_COPY = 'Another tab changed this document. Your edits were saved as a conflict copy.';
/** Shown after a draft switch whose flush created a conflict copy of the draft that was left. */
export const CONFLICT_COPY_LEFT = 'Another tab changed the document you left. Your edits were saved as a conflict copy.';
/** Autosave off is privacy mode: neither text nor title is written to storage (#114). */
export const AUTOSAVE_OFF = 'Autosave off — text and title are not saved and will be lost on reload';

export type StatusMessage = { conflict: string; primary: string; risk: string; draftListRefreshFailed: boolean };

/**
 * Apply a draft-list refresh failure without duplicating a warning that is already
 * in `primary` (showSaveState/showSaving often put riskText there with risk '').
 */
export function withDraftListRefreshFailure(message: StatusMessage, risk: string): StatusMessage {
  if (risk && message.primary === risk) return { ...message, draftListRefreshFailed: true, primary: '', risk };
  return { ...message, draftListRefreshFailed: true, risk };
}

/** Progress/action/risk text without the conflict notice (conflict is a separate live region). */
export function renderStatusBody(message: StatusMessage): string {
  const { primary, risk, draftListRefreshFailed } = message;
  let text = primary;
  if (draftListRefreshFailed) {
    // Strip a trailing period only — keep ellipsis on "Saving…" intact.
    text = text.replace(/\.$/, '');
    text += text ? ' — document list could not be refreshed' : 'Document list could not be refreshed.';
  }
  if (risk) text += text ? (/[.…]$/.test(text) ? ' ' : '. ') + risk : risk;
  return text;
}

/**
 * Parts written into `#conflict-notice`, `#status-sep`, and `#status`.
 * Pass `displayedConflict` when the live region may briefly differ from the model
 * (for example during a deferred re-announce).
 */
export function statusLineParts(
  message: StatusMessage,
  displayedConflict: string = message.conflict,
): { conflict: string; sep: string; body: string } {
  const body = renderStatusBody(message);
  return { conflict: displayedConflict, sep: displayedConflict && body ? ' ' : '', body };
}

/** Full status line; pass the live region's displayed text during a deferred re-announce. */
export function renderStatusMessage(message: StatusMessage, displayedConflict: string = message.conflict): string {
  const { conflict, sep, body } = statusLineParts(message, displayedConflict);
  return conflict + sep + body;
}

// One status line carries both save state and action feedback (#52).
// 'progress' is save state that a later save may replace; 'action' is
// feedback the user caused; 'conflict' and 'failure' come from saving and
// must not be hidden by a later background success.
export type StatusKind = 'progress' | 'action' | 'conflict' | 'failure';
export const SAVE_FAILED = 'Save failed — your text is unsaved. Copy or export it, then retry by editing.';
export const SAVE_FAILED_NO_STORAGE = 'Save failed — browser storage is unavailable. Copy or export your text before closing.';
export const STORAGE_UNAVAILABLE = 'Storage unavailable. Copy or export unsaved text before closing.';
export const NOT_OWNER_UNSAVED = 'Changes here are not saved — another window is editing this document. Copy or export them.';
export const READ_ONLY_HERE = 'Read-only here — another window is editing this document.';
/** Handoff success text from focus-handoff.ts; shown quietly as the normal save state. */
export const EDITABLE_HERE = 'You can edit this document in this window now.';
export const READ_ONLY_UNSUPPORTED = 'Read-only — this browser cannot coordinate editing between windows.';
export const READ_ONLY_ERROR = 'Read-only — this window could not confirm it may edit this document.';
export const RETRYING = 'Saving again… The last save failed; your text stays unsaved until a save succeeds.';

/** What decides whether text or storage is at risk. */
export type RiskInputs = {
  /** Non-empty while browser storage cannot be used (only a reload restores it). */
  storageProblem: string;
  dirty: boolean;
  /** Another window owns the document (or ownership is unavailable). */
  blocked: boolean;
  saveFailed: boolean;
  autosaveOn: boolean;
};

/** The warning that must stay visible while text or storage is at risk ('' when none). */
export function riskText(input: RiskInputs): string {
  if (input.storageProblem) {
    if (!input.dirty) return input.storageProblem;
    return input.storageProblem === STORAGE_UNAVAILABLE ? SAVE_FAILED_NO_STORAGE : 'Changes are unsaved. ' + input.storageProblem;
  }
  if (input.blocked && input.dirty) return NOT_OWNER_UNSAVED;
  if (input.saveFailed && input.autosaveOn) return SAVE_FAILED;
  if (input.dirty && !input.autosaveOn) return AUTOSAVE_OFF;
  return '';
}

/** Autosave off is a chosen mode, not a failure. */
export function statusKindForRisk(risk: string): Exclude<StatusKind, 'action' | 'conflict'> {
  return risk === AUTOSAVE_OFF ? 'progress' : 'failure';
}

/** Save-state text while this window cannot edit. A quiet reader looks like a normal editor. */
export function readOnlyStatus(block: EditBlock, quietReader: boolean, autosaveOn: boolean): string {
  if (quietReader) return autosaveOn ? 'Saved locally' : AUTOSAVE_OFF;
  if (block === 'unsupported') return READ_ONLY_UNSUPPORTED;
  if (block === 'error') return READ_ONLY_ERROR;
  return READ_ONLY_HERE;
}
