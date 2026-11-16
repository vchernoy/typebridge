import { describe, expect, it } from 'vitest';
import { sharedReuseReady, type SharedReuseLiveState } from './shared-copy-readiness';
import type { OwnedSharedCopySnapshot } from '../editor/indexeddb';

const request = { documentId: 'doc', revision: 2, ownerInstanceId: 'owner', fence: 3,
  requesterId: 'reader', requestId: 'r1', deadline: 2000 };
const snapshot: OwnedSharedCopySnapshot = { documentId: 'doc', revision: 2, ownerInstanceId: 'owner', fence: 3,
  title: 'Title', text: 'Exact text\n', format: 'markdown' };
const live = (): SharedReuseLiveState => ({ ...snapshot, fields: { ...snapshot },
  storageReady: true, publicSession: true, autosaveOn: true, ownsLock: true, canActivate: true, recoveryClear: true,
  documentPrivate: false, composing: false, transitioning: false, saving: false, saveFailed: false,
  pendingChanges: false, dirty: false,
});
describe('final shared-copy readiness', () => {
  it('accepts an exact clean live owner without modifying source or proof', () => {
    const state = live();
    const before = structuredClone({ request, snapshot, state });
    expect(sharedReuseReady(request, snapshot, state)).toBe(true);
    expect({ request, snapshot, state }).toEqual(before);
  });
  it.each(['storageReady', 'publicSession', 'autosaveOn', 'ownsLock', 'canActivate', 'recoveryClear'] as const)(
    'requires positive evidence for %s', field => {
      expect(sharedReuseReady(request, snapshot, { ...live(), [field]: false })).toBe(false);
    });
  it.each(['documentPrivate', 'composing', 'transitioning', 'saving', 'saveFailed', 'pendingChanges', 'dirty'] as const)(
    'refuses %s without trusting equality alone', field => {
      expect(sharedReuseReady(request, snapshot, { ...live(), [field]: true })).toBe(false);
    });
  it('compares live source/title/format even when a dirty flag was missed', () => {
    for (const fields of [{ ...live().fields, text: 'Changed' }, { ...live().fields, title: 'Changed' },
      { ...live().fields, format: 'plain' as const }]) {
      expect(sharedReuseReady(request, snapshot, { ...live(), fields })).toBe(false);
    }
  });
  it('rejects missing proof and revision/fence/identity changes on either side', () => {
    expect(sharedReuseReady(request, undefined, live())).toBe(false);
    for (const change of [{ documentId: 'other' }, { revision: 3 }, { fence: 4 }, { ownerInstanceId: 'other' }]) {
      expect(sharedReuseReady(request, { ...snapshot, ...change }, live())).toBe(false);
      expect(sharedReuseReady(request, snapshot, { ...live(), ...change })).toBe(false);
    }
  });
});
