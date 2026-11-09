import { describe, expect, it } from 'vitest';
import { migrateStandaloneSession } from './session-migration';

function memoryStorage(initial: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
}

describe('migrateStandaloneSession', () => {
  it('moves the single-editor tab state into the first host window', () => {
    const storage = memoryStorage({
      'typebridge.activeDraft.v1': 'doc-1',
      'typebridge.pendingDraft.v1': '{"id":"doc-1"}',
      'typebridge.find.replace.v1': 'с',
      'typebridge.writingPosition.v1.doc-1': '{"start":3}',
      'typebridge.writingPosition.v1.view:doc-1': '{"start":1}',
      'typebridge.writingPosition.v1.w:w2.doc-2': '{"start":2}',
    });
    expect(migrateStandaloneSession(storage, 'main')).toBe(4);
    expect(storage.getItem('typebridge.activeDraft.v1::w:main')).toBe('doc-1');
    expect(storage.getItem('typebridge.pendingDraft.v1::w:main')).toBe('{"id":"doc-1"}');
    expect(storage.getItem('typebridge.find.replace.v1::w:main')).toBe('с');
    expect(storage.getItem('typebridge.writingPosition.v1.w:main.doc-1')).toBe('{"start":3}');
    expect(storage.getItem('typebridge.activeDraft.v1')).toBeNull();
    expect(storage.getItem('typebridge.pendingDraft.v1')).toBeNull();
    expect(storage.getItem('typebridge.writingPosition.v1.doc-1')).toBeNull();
    // Viewer and other windows' offsets stay where they are.
    expect(storage.getItem('typebridge.writingPosition.v1.view:doc-1')).toBe('{"start":1}');
    expect(storage.getItem('typebridge.writingPosition.v1.w:w2.doc-2')).toBe('{"start":2}');
  });

  it("never overwrites the window's own state and is a no-op afterwards", () => {
    const storage = memoryStorage({
      'typebridge.activeDraft.v1': 'old',
      'typebridge.activeDraft.v1::w:main': 'current',
    });
    expect(migrateStandaloneSession(storage, 'main')).toBe(0);
    expect(storage.getItem('typebridge.activeDraft.v1::w:main')).toBe('current');
    expect(storage.getItem('typebridge.activeDraft.v1')).toBeNull();
    expect(migrateStandaloneSession(storage, 'main')).toBe(0);
  });
});
