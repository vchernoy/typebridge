/**
 * Preference write failures (#57) are shown apart from the document status line, so a later
 * successful document save cannot hide them. Each clears only when that preference is saved.
 */

/** The warning for preferences that could not be saved ('' when none). */
export function preferenceWarningText(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `Could not save the ${names[0]} setting; it may reset on reload.`;
  return `Could not save the ${names.join(' and ')} settings; they may reset on reload.`;
}

/** Returns `preferenceSaved(name, saved)`, which settings modules call after each write. */
export function createPreferenceWarning(element: HTMLElement): (name: string, saved: boolean) => void {
  const failed = new Set<string>();
  return (name, saved) => {
    if (saved) failed.delete(name); else failed.add(name);
    const text = preferenceWarningText([...failed]);
    element.textContent = text;
    element.hidden = !text;
  };
}
