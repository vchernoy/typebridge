/** #330 local-only final readiness check; no source data belongs on the channel. */
import type { OwnedSharedCopySnapshot } from '../editor/indexeddb';
import { sameSharedCopy, type SharedCopyFields } from '../editor/shared-copy';
import type { ReuseRequest } from './shared-copy-protocol';

export type SharedReuseLiveState = {
  documentId: string;
  revision: number;
  ownerInstanceId: string;
  fence: number;
  fields: SharedCopyFields;
  storageReady: boolean;
  /** True only after a successful current preference read, never a cached fallback. */
  publicSession: boolean;
  autosaveOn: boolean;
  ownsLock: boolean;
  canActivate: boolean;
  /** Successful conservative inspection of visible recovery sources; uncertainty is false. */
  recoveryClear: boolean;
  documentPrivate: boolean;
  composing: boolean;
  transitioning: boolean;
  saving: boolean;
  saveFailed: boolean;
  pendingChanges: boolean;
  dirty: boolean;
};

/**
 * Call synchronously with fresh live fields immediately before internal activation.
 * The caller must also invalidate the controller on lifecycle/privacy/storage changes.
 * A matching stored fence alone never proves live lock ownership or clean source.
 */
export function sharedReuseReady(
  request: ReuseRequest,
  snapshot: OwnedSharedCopySnapshot | undefined,
  live: SharedReuseLiveState,
): boolean {
  return !!snapshot
    && live.storageReady === true && live.publicSession === true && live.autosaveOn === true
    && live.ownsLock === true && live.canActivate === true && live.recoveryClear === true
    && live.documentPrivate === false && live.composing === false && live.transitioning === false
    && live.saving === false && live.saveFailed === false && live.pendingChanges === false && live.dirty === false
    && snapshot.documentId === request.documentId && live.documentId === request.documentId
    && snapshot.revision === request.revision && live.revision === request.revision
    && snapshot.ownerInstanceId === request.ownerInstanceId && live.ownerInstanceId === request.ownerInstanceId
    && snapshot.fence === request.fence && live.fence === request.fence
    && (live.fields.format === 'plain' || live.fields.format === 'markdown')
    && sameSharedCopy(live.fields, snapshot);
}
