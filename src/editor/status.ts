export const CONFLICT_COPY = 'Another tab changed this draft. Your edits were saved as a conflict copy.';
/** Shown after a draft switch whose flush created a conflict copy of the draft that was left. */
export const CONFLICT_COPY_LEFT = 'Another tab changed the draft you left. Your edits were saved as a conflict copy.';

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
    text += text ? ' — draft list could not be refreshed' : 'Draft list could not be refreshed.';
  }
  if (risk) text += text ? (/[.…]$/.test(text) ? ' ' : '. ') + risk : risk;
  return text;
}

/** Full status line for tests and documentation expectations. */
export function renderStatusMessage(message: StatusMessage): string {
  return [message.conflict, renderStatusBody(message)].filter(Boolean).join(' ');
}
