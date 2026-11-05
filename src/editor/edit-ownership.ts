import { claimEditOwnership, EditOwnershipLostError, releaseEditOwnership, type WriteFence } from './indexeddb';
import { editOwnerLockName, mayAcquireEditOwnership } from '../view/ownership';

/** Held editing ownership of one document: the Web Lock plus the fence claimed under it (#159 W4). */
export type EditOwnership = {
  readonly documentId: string;
  /**
   * Credentials for the IndexedDB write gate. The fence is claimed on acquire; if that claim
   * failed (a storage error), it is claimed again here, still under the lock. Rejects with
   * EditOwnershipLostError after release or loss.
   */
  writeFence(): Promise<WriteFence>;
  /** Give up the fence, then the lock. Safe to call more than once. */
  release(): Promise<void>;
};

export type AcquireResult =
  | { status: 'acquired'; ownership: EditOwnership }
  /** Another window holds the lock. Never waited for or stolen. */
  | { status: 'busy' }
  /** No Web Locks: this client stays a reader (ADR mixed-ownership rule). */
  | { status: 'unsupported' };

/**
 * Try to become the editing owner of `documentId`. By default never waits or steals
 * (`ifAvailable: true`). Pass `steal: true` only for #175 suspended-owner handoff.
 * `onLost` runs if the browser takes the lock away while this window still holds it.
 * Rejects only when the lock request itself fails.
 */
export function acquireEditOwnership(options: {
  db: IDBDatabase;
  locks: LockManager | undefined;
  documentId: string;
  instanceId: string;
  onLost: () => void;
  /** Take the lock from a suspended/unresponsive owner (#175 step 4). */
  steal?: boolean;
}): Promise<AcquireResult> {
  const { db, locks, documentId, instanceId, onLost, steal = false } = options;
  if (!mayAcquireEditOwnership(locks !== undefined) || !locks) return Promise.resolve({ status: 'unsupported' });
  return new Promise<AcquireResult>((resolve, reject) => {
    let granted = false;
    let released = false;
    let fence: WriteFence | undefined;
    let letGo!: () => void;
    const held = new Promise<void>(done => { letGo = done; });
    const claim = async (): Promise<WriteFence> => {
      fence = { instanceId, fence: await claimEditOwnership(db, documentId, instanceId, Date.now()) };
      return fence;
    };
    const ownership: EditOwnership = {
      documentId,
      async writeFence() {
        if (released) throw new EditOwnershipLostError();
        const current = fence ?? await claim();
        if (released) throw new EditOwnershipLostError();
        return current;
      },
      async release() {
        if (released) return;
        released = true;
        try { if (fence) await releaseEditOwnership(db, documentId, fence, Date.now()); }
        catch { /* The next owner's claim raises the fence anyway. */ }
        finally { letGo(); }
      },
    };
    const lockOptions: LockOptions = steal ? { steal: true } : { ifAvailable: true };
    locks.request(editOwnerLockName(documentId), lockOptions, async lock => {
      if (!lock) { resolve({ status: 'busy' }); return; }
      // Claiming now invalidates any stale owner's fence; a failed claim is retried before the first write.
      try { await claim(); } catch { /* writeFence() claims again. */ }
      granted = true;
      resolve({ status: 'acquired', ownership });
      await held;
    }).then(() => undefined, error => {
      if (!granted) reject(error);
      else if (!released) { released = true; letGo(); onLost(); }
    });
  });
}
