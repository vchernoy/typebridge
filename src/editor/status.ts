export const CONFLICT_COPY = 'Another tab changed this draft. Your edits were saved as a conflict copy.';

export type StatusMessage = { conflict: boolean; primary: string; risk: string; draftListRefreshFailed: boolean };

/** Render message parts without inferring state from previously displayed text. */
export function renderStatusMessage(message: StatusMessage): string {
  const { conflict, primary, risk, draftListRefreshFailed } = message;
  let text = [conflict ? CONFLICT_COPY : '', primary].filter(Boolean).join(' ');
  if (draftListRefreshFailed) text += text ? ' — draft list could not be refreshed' : 'Draft list could not be refreshed.';
  if (risk) text += text ? (/[.…]$/.test(text) ? ' ' : '. ') + risk : risk;
  return text;
}
