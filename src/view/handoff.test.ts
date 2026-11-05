import { describe, expect, it } from 'vitest';
import {
  bufferInsertFromKeyboard,
  ownerYieldBlock,
  parseHandoffMessage,
} from './handoff';

describe('handoff helpers', () => {
  it('parses handoff messages without accepting snapshots on the channel', () => {
    const released = parseHandoffMessage({
      v: 1,
      type: 'handoff-released',
      documentId: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
      toInstanceId: 'i',
      requestId: 'r',
      at: 1,
      snapshot: { text: 'secret', title: 't', dirty: true, revision: 1 },
    });
    expect(released).toEqual({
      v: 1,
      type: 'handoff-released',
      documentId: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
      toInstanceId: 'i',
      requestId: 'r',
      at: 1,
    });
    expect(parseHandoffMessage({ type: 'handoff-request' })).toBeUndefined();
    expect(parseHandoffMessage({
      v: 1,
      type: 'handoff-complete',
      documentId: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
      requestId: 'r',
      ok: true,
      at: 1,
    })?.type).toBe('handoff-complete');
  });

  it('blocks cross-tab private yield but allows same-origin private transfer', () => {
    expect(ownerYieldBlock({
      isOwner: true,
      composing: false,
      transitioning: false,
      saving: false,
      saveFailed: false,
      dirty: true,
      autosaveOn: false,
      allowPrivateTransfer: true,
    })).toBe('');
    expect(ownerYieldBlock({
      isOwner: true,
      composing: false,
      transitioning: false,
      saving: false,
      saveFailed: false,
      dirty: true,
      autosaveOn: false,
      allowPrivateTransfer: false,
    })).toBe('cross-tab-private');
    expect(ownerYieldBlock({
      isOwner: true,
      composing: true,
      transitioning: false,
      saving: false,
      saveFailed: false,
      dirty: false,
      autosaveOn: true,
      allowPrivateTransfer: true,
    })).toBe('ime');
  });

  it('buffers printable keys and Enter with kind for transliteration replay', () => {
    const key = (partial: Partial<KeyboardEvent>) => partial as KeyboardEvent;
    expect(bufferInsertFromKeyboard(key({ key: 'a' }))).toEqual({ kind: 'type', text: 'a' });
    expect(bufferInsertFromKeyboard(key({ key: 'Enter' }))).toEqual({ kind: 'break', text: '\n' });
    expect(bufferInsertFromKeyboard(key({ key: 'a', ctrlKey: true }))).toBeUndefined();
    expect(bufferInsertFromKeyboard(key({ key: 'Shift' }))).toBeUndefined();
  });
});
