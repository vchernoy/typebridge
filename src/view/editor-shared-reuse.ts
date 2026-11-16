/** Hosted editor owner adapter for #330. Reader integration remains separate. */
import type { EditOwnership } from '../editor/edit-ownership';
import { inspectOwnedSharedCopy, type OwnedSharedCopySnapshot } from '../editor/indexeddb';
import { AUTOSAVE_PREF_KEY } from '../editor/drafts';
import { PREFS_EVENT } from './prefs-sync';
import { installReuseOwner } from './shared-copy-owner';
import { sharedReuseReady, type SharedReuseLiveState } from './shared-copy-readiness';
import type { ReuseRequest } from './shared-copy-protocol';

export type EditorReuseCapture = {
  db: IDBDatabase | undefined;
  ownership: EditOwnership | undefined;
  sessionGeneration: number;
  storageGeneration: number;
  live: SharedReuseLiveState;
};
export type EditorSharedReuseDeps = {
  ownerInstanceId: string;
  capture: () => EditorReuseCapture;
  /** Synchronous exact host selection; no open/create/ownership-transfer fallback. */
  activate: (request: ReuseRequest) => boolean;
};
type Proof = { before: EditorReuseCapture; snapshot: OwnedSharedCopySnapshot | undefined };

export function installEditorSharedReuse(deps: EditorSharedReuseDeps): { invalidate: () => void; dispose: () => void } {
  let finished = false;
  let owner: ReturnType<typeof installReuseOwner<Proof>> | undefined;
  const start = (): void => {
    if (finished || owner) return;
    owner = installReuseOwner<Proof>({
      ownerInstanceId: deps.ownerInstanceId,
      inspect: async (request, signal) => {
        const before = deps.capture();
        if (!before.db || !before.ownership) return { before, snapshot: undefined };
        return { before, snapshot: await inspectOwnedSharedCopy(before.db, request, signal) };
      },
      eligible: (request, proof) => {
        const after = deps.capture();
        return !!proof.before.ownership && proof.before.ownership === after.ownership
          && proof.before.db === after.db && proof.before.sessionGeneration === after.sessionGeneration
          && proof.before.storageGeneration === after.storageGeneration
          && sharedReuseReady(request, proof.snapshot, after.live);
      },
      activate: request => deps.activate(request) ? 'activated' : 'refused',
    });
  };
  const invalidate = (): void => { owner?.invalidate(); };
  const storage = (event: StorageEvent): void => {
    if (event.key === null || event.key === AUTOSAVE_PREF_KEY) invalidate();
  };
  const hide = (): void => { owner?.dispose(); owner = undefined; };
  // User edits/actions cancel old offers before existing app handlers run. Host
  // title edits still face fresh field/revision/fence checks at commit time.
  const events = ['beforeinput', 'input', 'change', 'click', 'keydown', 'compositionstart'] as const;
  for (const event of events) document.addEventListener(event, invalidate, true);
  window.addEventListener(PREFS_EVENT, invalidate);
  window.addEventListener('storage', storage);
  window.addEventListener('beforeunload', invalidate);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', start);
  start();
  return {
    invalidate,
    dispose: () => {
      finished = true; hide();
      for (const event of events) document.removeEventListener(event, invalidate, true);
      window.removeEventListener(PREFS_EVENT, invalidate);
      window.removeEventListener('storage', storage);
      window.removeEventListener('beforeunload', invalidate);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', start);
    },
  };
}
