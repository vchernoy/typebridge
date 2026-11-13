export type SearchPrivacyScope = { documentId: string; writable: boolean };

/** Observe every boundary, including input arriving before async preference sync finishes. */
export function createSearchPrivacy(readScope: () => SearchPrivacyScope, restorePublicText: () => void) {
  let previous: SearchPrivacyScope | undefined;
  function sync(): boolean {
    const next = readScope();
    if (previous?.documentId === next.documentId && previous.writable === next.writable) return false;
    const restore = previous?.documentId !== next.documentId || (!previous?.writable && next.writable);
    previous = next;
    // Entering private keeps its in-memory query; exiting resets text, IME and undo state.
    if (restore) restorePublicText();
    return true;
  }
  return {
    sync,
    mayPersist(): boolean {
      const changed = sync();
      // A boundary-discovering input must not publish the value it just replaced.
      return !changed && previous?.writable === true && readScope().writable;
    },
  };
}
