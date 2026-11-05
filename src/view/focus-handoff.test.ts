import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFocusHandoff } from './focus-handoff';
import { HANDOFF_YIELD_TIMEOUT_MS, type HandoffSnapshot } from './handoff';

/** Minimal textarea stand-in — unit tests stay node-only (no happy-dom). */
function makeField(initial = 'private text'): HTMLTextAreaElement {
  const listeners = new Map<string, Set<EventListener>>();
  let value = initial;
  let selectionStart = initial.length;
  let selectionEnd = initial.length;
  const field = {
    get value() { return value; },
    set value(next: string) { value = next; },
    get selectionStart() { return selectionStart; },
    get selectionEnd() { return selectionEnd; },
    disabled: false,
    readOnly: true,
    addEventListener(type: string, listener: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    setSelectionRange(start: number, end: number) {
      selectionStart = start;
      selectionEnd = end;
    },
    setRangeText(replacement: string, start: number, end: number, mode: string) {
      value = value.slice(0, start) + replacement + value.slice(end);
      if (mode === 'end') selectionStart = selectionEnd = start + replacement.length;
    },
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) ?? []) {
        (listener as EventListener).call(field, event);
      }
      return true;
    },
  };
  return field as unknown as HTMLTextAreaElement;
}

beforeEach(() => {
  const self = { frames: { length: 0 } } as unknown as Window;
  Object.defineProperty(self, 'parent', { value: self, configurable: true });
  vi.stubGlobal('window', self);
});
afterEach(() => {
  vi.useRealTimers();
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

  it('replays keys buffered before an Edit here steal', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(0), 0) as unknown as number;
    });
    vi.stubGlobal('InputEvent', class extends Event {
      inputType: string;
      data: string | null;
      constructor(
        type: string,
        init: { inputType?: string; data?: string | null; bubbles?: boolean; cancelable?: boolean } = {},
      ) {
        super(type, init);
        this.inputType = init.inputType ?? '';
        this.data = init.data ?? null;
      }
    });
    vi.useFakeTimers();
    const field = makeField('Shared handoff text');
    const DOC = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    const showEditHere = vi.fn();
    let block: 'busy' | '' = 'busy';
    const takeOver = vi.fn(async () => {
      block = '';
      field.readOnly = false;
      return true;
    });
    const controller = installFocusHandoff({
      field,
      windowId: 'beta',
      instanceId: 'reader-1',
      channel: null,
      getDocumentId: () => DOC,
      isViewMode: () => false,
      isOwner: () => false,
      editBlock: () => block,
      isComposing: () => false,
      isTransitioning: () => false,
      isSaving: () => false,
      saveFailed: () => false,
      isDirty: () => false,
      autosaveOn: () => true,
      confirmDiscardDirtyForHandoff: async () => true,
      flushSave: async () => undefined,
      captureSnapshot: () => ({ text: 'x', title: 'y', dirty: false, revision: 1 }),
      beginParkFreeze: () => undefined,
      finishParkRelease: async () => undefined,
      discardParkedText: async () => undefined,
      recoverParkedOwnership: async () => undefined,
      takeOver,
      announce: () => undefined,
      showEditHere,
    });

    // Seed the pending buffer the same way a typed key would during the wait.
    (controller.requestHandoff as (options?: {
      steal?: boolean;
      initialBuffer?: { kind: 'type'; text: string }[];
    }) => void)({
      initialBuffer: [{ kind: 'type', text: '!' }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.pending()).toBe(true);

    await vi.advanceTimersByTimeAsync(HANDOFF_YIELD_TIMEOUT_MS);
    expect(showEditHere).toHaveBeenCalledWith('unresponsive');
    // Same request stays pending so input remains blocked and the buffer is kept.
    expect(controller.pending()).toBe(true);

    controller.requestHandoff({ steal: true });
    await vi.runAllTimersAsync();
    expect(takeOver).toHaveBeenCalled();
    expect(field.value).toBe('Shared handoff text!');
    controller.dispose();
  });
});
