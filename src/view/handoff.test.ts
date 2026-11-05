import { describe, expect, it } from 'vitest';
import {
  bufferInsertFromKeyboard,
  ensureTabToken,
  metadataOnlyHandoff,
  ownerYieldBlock,
  parseHandoffMessage,
  sameTab,
  TAB_TOKEN_KEY,
} from './handoff';

describe('handoff helpers', () => {
  it('mints and reuses a tab token in sessionStorage', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value); },
      removeItem: (key: string) => { memory.delete(key); },
    } as Storage;
    const first = ensureTabToken(storage);
    expect(first.length).toBeGreaterThan(7);
    expect(ensureTabToken(storage)).toBe(first);
    expect(memory.get(TAB_TOKEN_KEY)).toBe(first);
  });

  it('detects same-tab tokens', () => {
    expect(sameTab('abc', 'abc')).toBe(true);
    expect(sameTab('abc', 'xyz')).toBe(false);
    expect(sameTab('', '')).toBe(false);
  });

  it('parses handoff messages and strips snapshots for BroadcastChannel', () => {
    const released = parseHandoffMessage({
      v: 1,
      type: 'handoff-released',
      tabToken: 't',
      documentId: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
      toInstanceId: 'i',
      requestId: 'r',
      at: 1,
      snapshot: { text: 'secret', title: 't', dirty: true, revision: 1 },
    });
    expect(released?.type).toBe('handoff-released');
    if (released?.type === 'handoff-released') {
      expect(released.snapshot).toBeUndefined();
      expect(metadataOnlyHandoff({
        ...released,
        snapshot: { text: 'secret', title: 't', dirty: true, revision: 1 },
      })).not.toHaveProperty('snapshot');
    }
    expect(parseHandoffMessage({ type: 'handoff-request' })).toBeUndefined();
  });

  it('blocks cross-tab private yield but allows same-tab', () => {
    expect(ownerYieldBlock({
      isOwner: true,
      composing: false,
      transitioning: false,
      saving: false,
      saveFailed: false,
      dirty: true,
      autosaveOn: false,
      sameTab: true,
    })).toBe('');
    expect(ownerYieldBlock({
      isOwner: true,
      composing: false,
      transitioning: false,
      saving: false,
      saveFailed: false,
      dirty: true,
      autosaveOn: false,
      sameTab: false,
    })).toBe('cross-tab-private');
    expect(ownerYieldBlock({
      isOwner: true,
      composing: true,
      transitioning: false,
      saving: false,
      saveFailed: false,
      dirty: false,
      autosaveOn: true,
      sameTab: true,
    })).toBe('ime');
  });

  it('buffers printable keys and Enter', () => {
    const key = (partial: Partial<KeyboardEvent>) => partial as KeyboardEvent;
    expect(bufferInsertFromKeyboard(key({ key: 'a' }))).toEqual({ text: 'a' });
    expect(bufferInsertFromKeyboard(key({ key: 'Enter' }))).toEqual({ text: '\n' });
    expect(bufferInsertFromKeyboard(key({ key: 'a', ctrlKey: true }))).toBeUndefined();
    expect(bufferInsertFromKeyboard(key({ key: 'Shift' }))).toBeUndefined();
  });
});
