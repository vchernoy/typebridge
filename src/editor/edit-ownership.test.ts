import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  fences: new Map<string, number>(),
  claimFails: false,
  released: [] as { documentId: string; instanceId: string; fence: number }[],
}));

vi.mock('./indexeddb', () => ({
  EditOwnershipLostError: class extends Error { name = 'EditOwnershipLostError'; },
  claimEditOwnership: vi.fn(async (_db: unknown, documentId: string) => {
    if (storage.claimFails) throw new Error('claim failed');
    const fence = (storage.fences.get(documentId) ?? 0) + 1;
    storage.fences.set(documentId, fence);
    return fence;
  }),
  releaseEditOwnership: vi.fn(async (_db: unknown, documentId: string, owner: { instanceId: string; fence: number }) => {
    storage.released.push({ documentId, ...owner });
  }),
}));

import { acquireEditOwnership } from './edit-ownership';

/** Exclusive-only LockManager with ifAvailable and steal, enough for ownership semantics. */
class FakeLocks {
  private held = new Map<string, { abort: (error: unknown) => void }>();
  isHeld(name: string): boolean { return this.held.has(name); }
  request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown> {
    if (options.steal && this.held.has(name)) this.steal(name);
    if (options.ifAvailable && this.held.has(name)) return Promise.resolve(callback(null));
    return new Promise((resolve, reject) => {
      const entry = { abort: reject };
      this.held.set(name, entry);
      Promise.resolve(callback({ name, mode: 'exclusive' } as Lock)).then(value => {
        if (this.held.get(name) === entry) this.held.delete(name);
        resolve(value);
      }, error => {
        if (this.held.get(name) === entry) this.held.delete(name);
        reject(error);
      });
    });
  }
  steal(name: string): void {
    const entry = this.held.get(name);
    this.held.delete(name);
    entry?.abort(new DOMException('Lock stolen', 'AbortError'));
  }
}

const DOC = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const LOCK = `typebridge-edit-owner:${DOC}`;
const db = {} as IDBDatabase;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('acquireEditOwnership', () => {
  let locks: FakeLocks;
  beforeEach(() => {
    locks = new FakeLocks();
    storage.fences.clear();
    storage.claimFails = false;
    storage.released = [];
  });
  const acquire = (instanceId: string, onLost = () => undefined) =>
    acquireEditOwnership({ db, locks: locks as unknown as LockManager, documentId: DOC, instanceId, onLost });

  it('leaves clients without Web Locks as readers', async () => {
    await expect(acquireEditOwnership({ db, locks: undefined, documentId: DOC, instanceId: 'a', onLost: () => undefined }))
      .resolves.toEqual({ status: 'unsupported' });
    expect(storage.fences.size).toBe(0);
  });

  it('gives the first window the lock and a fence; a second window is busy and claims nothing', async () => {
    const first = await acquire('a');
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;
    await expect(first.ownership.writeFence()).resolves.toEqual({ instanceId: 'a', fence: 1 });
    expect(locks.isHeld(LOCK)).toBe(true);
    await expect(acquire('b')).resolves.toEqual({ status: 'busy' });
    expect(storage.fences.get(DOC)).toBe(1);
  });

  it('releases the fence before the lock, then lets the next window acquire a higher fence', async () => {
    const first = await acquire('a');
    if (first.status !== 'acquired') throw new Error('expected acquire');
    await first.ownership.release();
    await first.ownership.release();
    expect(storage.released).toEqual([{ documentId: DOC, instanceId: 'a', fence: 1 }]);
    await flush();
    expect(locks.isHeld(LOCK)).toBe(false);
    const second = await acquire('b');
    if (second.status !== 'acquired') throw new Error('expected acquire');
    await expect(second.ownership.writeFence()).resolves.toEqual({ instanceId: 'b', fence: 2 });
    // A released ownership never hands out credentials again.
    await expect(first.ownership.writeFence()).rejects.toThrow();
  });

  it('reports a taken lock once and does not report a normal release', async () => {
    const lost = vi.fn();
    const first = await acquire('a', lost);
    if (first.status !== 'acquired') throw new Error('expected acquire');
    locks.steal(LOCK);
    await flush();
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(first.ownership.writeFence()).rejects.toMatchObject({ name: 'EditOwnershipLostError' });

    const quiet = vi.fn();
    const again = await acquire('b', quiet);
    if (again.status !== 'acquired') throw new Error('expected acquire');
    await again.ownership.release();
    await flush();
    expect(quiet).not.toHaveBeenCalled();
  });

  it('keeps the lock when the fence claim fails and claims again before the first write', async () => {
    storage.claimFails = true;
    const first = await acquire('a');
    if (first.status !== 'acquired') throw new Error('expected acquire');
    expect(locks.isHeld(LOCK)).toBe(true);
    await expect(acquire('b')).resolves.toEqual({ status: 'busy' });
    await expect(first.ownership.writeFence()).rejects.toThrow('claim failed');
    storage.claimFails = false;
    await expect(first.ownership.writeFence()).resolves.toEqual({ instanceId: 'a', fence: 1 });
    await first.ownership.release();
    expect(storage.released).toEqual([{ documentId: DOC, instanceId: 'a', fence: 1 }]);
  });

  it('releases without touching storage when no fence was ever claimed', async () => {
    storage.claimFails = true;
    const first = await acquire('a');
    if (first.status !== 'acquired') throw new Error('expected acquire');
    await first.ownership.release();
    await flush();
    expect(storage.released).toEqual([]);
    expect(locks.isHeld(LOCK)).toBe(false);
  });

  it('elects exactly one owner when windows ask at the same time', async () => {
    const results = await Promise.all(['a', 'b', 'c'].map(id => acquire(id)));
    expect(results.filter(r => r.status === 'acquired')).toHaveLength(1);
    expect(results.filter(r => r.status === 'busy')).toHaveLength(2);
    expect(storage.fences.get(DOC)).toBe(1);
  });

  it('steals a held lock when steal is requested (#175 suspended owner)', async () => {
    const lost = vi.fn();
    const first = await acquire('a', lost);
    if (first.status !== 'acquired') throw new Error('expected acquire');
    const second = await acquireEditOwnership({
      db, locks: locks as unknown as LockManager, documentId: DOC, instanceId: 'b',
      onLost: () => undefined, steal: true,
    });
    await flush();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('acquired');
    if (second.status !== 'acquired') return;
    await expect(second.ownership.writeFence()).resolves.toEqual({ instanceId: 'b', fence: 2 });
  });
});
