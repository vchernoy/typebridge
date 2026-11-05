import { beforeEach, describe, expect, it } from 'vitest';
import { ensurePrimaryWindowId, readHostWindowIds } from './window-ids';

describe('host window ids', () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  } as Storage;

  beforeEach(() => { memory.clear(); });

  it('mints a stable primary id and reuses it', () => {
    expect(readHostWindowIds(storage)).toEqual([]);
    expect(ensurePrimaryWindowId(storage)).toBe('main');
    expect(ensurePrimaryWindowId(storage)).toBe('main');
    expect(readHostWindowIds(storage)).toEqual(['main']);
  });
});
