import { describe, expect, it } from 'vitest';
import {
  bufferInsertFromKeyboard,
  deleteRangeForDirection,
  mapSelectionAcrossTextChange,
  nextGraphemeBoundary,
  ownerYieldBlock,
  parseHandoffMessage,
  previousGraphemeBoundary,
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
    expect(ownerYieldBlock({
      isOwner: true,
      composing: false,
      transitioning: false,
      saving: false,
      saveFailed: true,
      dirty: true,
      autosaveOn: true,
      allowPrivateTransfer: true,
    })).toBe('');
    expect(ownerYieldBlock({
      isOwner: true,
      composing: false,
      transitioning: false,
      saving: false,
      saveFailed: true,
      dirty: true,
      autosaveOn: true,
      allowPrivateTransfer: false,
    })).toBe('save-failed');
  });

  it('buffers printable keys, Enter and deletes; never traps Tab', () => {
    const key = (partial: Partial<KeyboardEvent>) => partial as KeyboardEvent;
    expect(bufferInsertFromKeyboard(key({ key: 'a' }))).toEqual({ kind: 'type', text: 'a' });
    expect(bufferInsertFromKeyboard(key({ key: 'Enter' }))).toEqual({ kind: 'break', text: '\n' });
    expect(bufferInsertFromKeyboard(key({ key: 'Backspace' }))).toEqual({
      kind: 'delete', direction: 'backward',
    });
    expect(bufferInsertFromKeyboard(key({ key: 'Tab' }))).toBeUndefined();
    expect(bufferInsertFromKeyboard(key({ key: 'a', ctrlKey: true }))).toBeUndefined();
    expect(bufferInsertFromKeyboard(key({ key: 'Shift' }))).toBeUndefined();
  });

  it('steps collapsed deletes by grapheme (emoji, flag, combining mark)', () => {
    const emoji = 'ab😀cd';
    // 😀 is one grapheme spanning two UTF-16 code units after "ab".
    expect(previousGraphemeBoundary(emoji, 4)).toBe(2);
    expect(nextGraphemeBoundary(emoji, 2)).toBe(4);
    expect(deleteRangeForDirection(emoji, 4, 4, 'backward')).toEqual({ start: 2, end: 4 });
    expect(deleteRangeForDirection(emoji, 2, 2, 'forward')).toEqual({ start: 2, end: 4 });

    const flag = `xx${String.fromCodePoint(0x1f1fa, 0x1f1f8)}yy`;
    // US flag is one grapheme (two regional indicators = four UTF-16 units).
    expect(previousGraphemeBoundary(flag, 6)).toBe(2);
    expect(nextGraphemeBoundary(flag, 2)).toBe(6);
    expect(deleteRangeForDirection(flag, 6, 6, 'backward')).toEqual({ start: 2, end: 6 });

    const combined = `aaи\u0306bb`; // base и + combining breve
    expect(previousGraphemeBoundary(combined, 4)).toBe(2);
    expect(nextGraphemeBoundary(combined, 2)).toBe(4);
    expect(deleteRangeForDirection(combined, 4, 4, 'backward')).toEqual({ start: 2, end: 4 });
    // Non-collapsed selection is replaced as-is.
    expect(deleteRangeForDirection('hello', 1, 4, 'backward')).toEqual({ start: 1, end: 4 });
  });

  it('maps reader selections onto owner text via shared prefix/suffix', () => {
    const reader = 'Hello world';
    const owner = 'Hi there, Hello world';
    // "world" at 6–11 in the reader maps into the shared suffix.
    expect(mapSelectionAcrossTextChange(reader, owner, 6, 11)).toEqual({ start: 16, end: 21 });
    expect(owner.slice(16, 21)).toBe('world');

    // Selection that spans the changed middle collapses (no replace).
    expect(mapSelectionAcrossTextChange('aaaXXXbbb', 'aaaYYYYbbb', 2, 6)).toEqual({
      start: 3, end: 3,
    });

    // Identical texts keep the range.
    expect(mapSelectionAcrossTextChange(reader, reader, 6, 11)).toEqual({ start: 6, end: 11 });
  });

});
