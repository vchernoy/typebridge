/**
 * Find/Replace privacy scope (#257 step 2 / #264 P0).
 *
 * Scope is `${documentId}:${writable}`. Entering private on the same document must
 * observe the new scope without wiping an in-memory private query. Leaving private,
 * switching documents, or the first sync must restore public stored text before
 * persistence is allowed again.
 */

export type SearchPrivacyPlan = {
  scope: string;
  /** Re-read public Find/Replace from sessionStorage and reset editor history. */
  restore: boolean;
  /** Allow sessionStorage writes for Find/Replace text. */
  allowPersist: boolean;
  changed: boolean;
};

/** Decide whether a privacy/document transition should restore stored search text. */
export function planSearchPrivacyTransition(
  prevScope: string,
  documentId: string,
  writable: boolean,
): SearchPrivacyPlan {
  const scope = `${documentId}:${writable}`;
  if (scope === prevScope) {
    return {
      scope,
      restore: false,
      // A writable scope only persists after bootstrap/restore for that scope string.
      allowPersist: writable && prevScope !== '',
      changed: false,
    };
  }
  const prevId = prevScope.includes(':') ? prevScope.slice(0, prevScope.lastIndexOf(':')) : '';
  const sameDocument = prevId === documentId;
  // Same document entering (or re-entering) private: keep the in-memory private query.
  if (!writable && sameDocument && prevScope !== '') {
    return { scope, restore: false, allowPersist: false, changed: true };
  }
  return { scope, restore: true, allowPersist: writable, changed: true };
}
