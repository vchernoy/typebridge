/** Label for one option in the Drafts select (pure; no DOM). */
export function draftOptionLabel(params: {
  savedTitle: string;
  /** On-screen title for the open draft (trimmed, or Untitled). */
  displayTitle: string;
  isCurrent: boolean;
  unsaved: boolean;
}): string {
  const title = params.isCurrent ? params.displayTitle : params.savedTitle;
  if (!params.isCurrent) return title;
  return params.unsaved ? `${title} (current, unsaved)` : `${title} (current)`;
}
