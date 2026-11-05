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
    readOnly: false,
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
  it('parks ownership and returns a snapshot for same-origin dirty yield', async () => {
    const field = makeField();
    const snapshot: HandoffSnapshot = {
      text: 'private text',
      title: 'Untitled document',
      dirty: true,
      revision: 1,
    };
    const DOC = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    const beginParkFreeze = vi.fn();
    const finishParkRelease = vi.fn(async () => undefined);
    const discardParkedText = vi.fn(async () => undefined);
    const recoverParkedOwnership = vi.fn(async () => undefined);
    const controller = installFocusHandoff({
      field,
      windowId: 'alpha',
      instanceId: 'owner-1',
      channel: null,
      getDocumentId: () => DOC,
      isViewMode: () => false,
      isOwner: () => true,
      editBlock: () => '',
      isComposing: () => false,
      isTransitioning: () => false,
      isSaving: () => false,
      saveFailed: () => false,
      isDirty: () => true,
      autosaveOn: () => false,
      confirmDiscardDirtyForHandoff: async () => true,
      flushSave: async () => undefined,
      captureSnapshot: () => snapshot,
      beginParkFreeze,
      finishParkRelease,
      discardParkedText,
      recoverParkedOwnership,
      takeOver: async () => false,
      announce: () => undefined,
      showEditHere: () => undefined,
    });

    const result = await controller.hooks.__typebridgeYieldForHandoff!({
      documentId: DOC,
      fromInstanceId: 'reader-1',
      requestId: 'req-1',
    });
    expect(result).toEqual({ status: 'released', snapshot });
    expect(beginParkFreeze).toHaveBeenCalledTimes(1);
    expect(finishParkRelease).toHaveBeenCalledTimes(1);
    expect(discardParkedText).not.toHaveBeenCalled();

    controller.hooks.__typebridgeHandoffComplete?.('req-1', true);
    await Promise.resolve();
    expect(discardParkedText).toHaveBeenCalledWith(DOC);
    expect(recoverParkedOwnership).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('recovers parked text when takeover confirmation fails', async () => {
    const field = makeField();
    const DOC = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    const recoverParkedOwnership = vi.fn(async () => undefined);
    const discardParkedText = vi.fn(async () => undefined);
    const controller = installFocusHandoff({
      field,
      windowId: 'alpha',
      instanceId: 'owner-1',
      channel: null,
      getDocumentId: () => DOC,
      isViewMode: () => false,
      isOwner: () => true,
      editBlock: () => '',
      isComposing: () => false,
      isTransitioning: () => false,
      isSaving: () => false,
      saveFailed: () => false,
      isDirty: () => true,
      autosaveOn: () => false,
      confirmDiscardDirtyForHandoff: async () => true,
      flushSave: async () => undefined,
      captureSnapshot: () => ({ text: 'x', title: 'y', dirty: true, revision: 1 }),
      beginParkFreeze: () => undefined,
      finishParkRelease: async () => undefined,
      discardParkedText,
      recoverParkedOwnership,
      takeOver: async () => false,
      announce: () => undefined,
      showEditHere: () => undefined,
    });

    await controller.hooks.__typebridgeYieldForHandoff!({
      documentId: DOC,
      fromInstanceId: 'reader-1',
      requestId: 'req-fail',
    });
    controller.hooks.__typebridgeHandoffComplete?.('req-fail', false);
    await Promise.resolve();
    expect(recoverParkedOwnership).toHaveBeenCalledWith(DOC);
    expect(discardParkedText).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('parks for dirty same-tab frame-call yield', async () => {
    const field = makeField();
    const DOC = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    let dirty = true;
    const controller = installFocusHandoff({
      field,
      windowId: 'alpha',
      instanceId: 'owner-1',
      channel: null,
      getDocumentId: () => DOC,
      isViewMode: () => false,
      isOwner: () => true,
      editBlock: () => '',
      isComposing: () => false,
      isTransitioning: () => false,
      isSaving: () => false,
      saveFailed: () => false,
      isDirty: () => dirty,
      autosaveOn: () => false,
      confirmDiscardDirtyForHandoff: async () => true,
      flushSave: async () => undefined,
      captureSnapshot: () => ({ text: 'x', title: 'y', dirty: true, revision: 1 }),
      beginParkFreeze: () => { dirty = true; },
      finishParkRelease: async () => undefined,
      discardParkedText: async () => undefined,
      recoverParkedOwnership: async () => undefined,
      takeOver: async () => false,
      announce: () => undefined,
      showEditHere: () => undefined,
    });

    await expect(controller.hooks.__typebridgeYieldForHandoff!({
      documentId: DOC,
      fromInstanceId: 'reader-1',
      requestId: 'req-1',
    })).resolves.toMatchObject({ status: 'released' });
    controller.dispose();
  });
});
