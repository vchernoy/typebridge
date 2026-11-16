/** Content-free cancellation marker for received-link removal and global erasure. */
export const SHARED_REMOVAL_KEY = 'typebridge.sharedRemoval.v1';
export function sharedRemovalToken(): string | undefined {
  try { return localStorage.getItem(SHARED_REMOVAL_KEY) ?? ''; } catch { return undefined; }
}
/** Must succeed before erasure starts; the marker survives content metadata cleanup. */
export function invalidateSharedRemembering(): void {
  localStorage.setItem(SHARED_REMOVAL_KEY, crypto.randomUUID());
}
