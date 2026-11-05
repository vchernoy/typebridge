import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFocusHandoff } from './focus-handoff';
import type { HandoffSnapshot } from './handoff';

/** Minimal textarea stand-in — unit tests stay node-only (no happy-dom). */
function makeField(): HTMLTextAreaElement {
  const listeners = new Map<string, Set<EventListener>>();
  const field = {
    value: 'private text',
    selectionStart: 0,
    selectionEnd: 0,
    disabled: false,
    addEventListener(type: string, listener: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    setSelectionRange() { /* no-op */ },
    dispatchEvent() { return true; },
  };
  return field as unknown as HTMLTextAreaElement;
}

beforeEach(() => {
  const self = { frames: { length: 0 } } as unknown as Window;
  Object.defineProperty(self, 'parent', { value: self, configurable: true });
  vi.stubGlobal('window', self);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installFocusHandoff', () => {
  it('yields a same-origin snapshot for a peer request when dirty and Autosave is off', async () => {
    const field = makeField();
    const snapshot: HandoffSnapshot = {
      text: 'private text',
      title: 'Untitled document',
      dirty: true,
      revision: 1,
    };
    const releaseOwnership = vi.fn(async () => undefined);
    const controller = installFocusHandoff({
      field,
      windowId: 'alpha',
      instanceId: 'owner-1',
      tabToken: 'tab-shared',
      channel: null,
      getDocumentId: () => 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
      isViewMode: () => false,
      isOwner: () => true,
      editBlock: () => '',
      isComposing: () => false,
      isTransitioning: () => false,
      isSaving: () => false,
      saveFailed: () => false,
      isDirty: () => true,
      autosaveOn: () => false,
      flushSave: async () => undefined,
      captureSnapshot: () => snapshot,
      releaseOwnership,
      takeOver: async () => false,
      announce: () => undefined,
      showEditHere: () => undefined,
    });

    const result = await controller.hooks.__typebridgeYieldForHandoff!({
      documentId: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
      fromInstanceId: 'reader-1',
      requestId: 'req-1',
      tabToken: 'tab-shared',
    });
    expect(result).toEqual({ status: 'released', snapshot });
    expect(releaseOwnership).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('refuses cross-tab private yield', async () => {
    const field = makeField();
    const controller = installFocusHandoff({
      field,
      windowId: 'alpha',
      instanceId: 'owner-1',
      tabToken: 'tab-a',
      channel: null,
      getDocumentId: () => 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
      isViewMode: () => false,
      isOwner: () => true,
      editBlock: () => '',
      isComposing: () => false,
      isTransitioning: () => false,
      isSaving: () => false,
      saveFailed: () => false,
      isDirty: () => true,
      autosaveOn: () => false,
      flushSave: async () => undefined,
      captureSnapshot: () => ({ text: 'x', title: 'y', dirty: true, revision: 1 }),
      releaseOwnership: async () => undefined,
      takeOver: async () => false,
      announce: () => undefined,
      showEditHere: () => undefined,
    });

    await expect(controller.hooks.__typebridgeYieldForHandoff!({
      documentId: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
      fromInstanceId: 'reader-1',
      requestId: 'req-1',
      tabToken: 'tab-other',
    })).resolves.toEqual({ status: 'refused', reason: 'cross-tab-private' });
    controller.dispose();
  });
});
