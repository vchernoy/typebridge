export const CONFLICT_COPY = 'Another tab changed this draft. Your edits were saved as a conflict copy.';
/** Shown after a draft switch whose flush created a conflict copy of the draft that was left. */
export const CONFLICT_COPY_LEFT = 'Another tab changed the draft you left. Your edits were saved as a conflict copy.';

export type StatusMessage = { conflict: string; primary: string; risk: string; draftListRefreshFailed: boolean };

/** Render message parts without inferring state from previously displayed text. */
export function renderStatusMessage(message: StatusMessage): string {
  const { conflict, primary, risk, draftListRefreshFailed } = message;
  let text = [conflict, primary].filter(Boolean).join(' ');
  if (draftListRefreshFailed) text += text ? ' — draft list could not be refreshed' : 'Draft list could not be refreshed.';
  if (risk) text += text ? (/[.…]$/.test(text) ? ' ' : '. ') + risk : risk;
  return text;
}
