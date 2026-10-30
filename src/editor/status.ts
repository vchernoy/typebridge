export type StatusMessage = { primary: string; risk: string; draftListRefreshFailed: boolean };

/** Render message parts without inferring state from previously displayed text. */
export function renderStatusMessage(message: StatusMessage): string {
  const { primary, risk, draftListRefreshFailed } = message;
  let text = primary;
  if (draftListRefreshFailed) text += text ? ' — draft list could not be refreshed' : 'Draft list could not be refreshed.';
  if (risk) text += text ? (draftListRefreshFailed || /[.…]$/.test(text) ? ' ' : '. ') + risk : risk;
  return text;
}
