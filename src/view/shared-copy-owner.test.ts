import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReuseOwnerController, installReuseOwner } from './shared-copy-owner';
import { REUSE_MAX_OFFERS, type ReuseMessage, type ReuseOffer, type ReuseRequest } from './shared-copy-protocol';

const request = (requestId = 'r1'): ReuseRequest => ({
  documentId: '00000000-0000-4000-8000-000000000001', revision: 1,
  ownerInstanceId: 'owner1', fence: 1, requesterId: 'reader1', requestId, deadline: 2000,
});
const probe = (r = request()) => ({ ...r, v: 1, type: 'probe' });
const message = (offer: ReuseOffer, type: string) => ({ ...offer, v: 1, type });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function fixture() {
  let now = 0;
  let nonce = 0;
  const messages: ReuseMessage[] = [];
  const inspect = vi.fn<(r: ReuseRequest, signal: AbortSignal) => Promise<{ revision: number }>>().mockResolvedValue({ revision: 1 });
  const eligible = vi.fn(() => true);
  const activate = vi.fn(() => 'activated' as const);
  const post = vi.fn((value: ReuseMessage) => { messages.push(value); });
  const deps = { ownerInstanceId: 'owner1', inspect, eligible, activate, post,
    now: () => now, nonce: () => `o${++nonce}` };
  const owner = new ReuseOwnerController(deps);
  const offered = (): ReuseOffer => {
    const m = messages.find(m => m.type === 'offer');
    if (!m || m.type === 'probe') throw new Error('No offer');
    return { ...request(m.requestId), offerId: m.offerId };
  };
  return { owner, deps, inspect, eligible, activate, post, messages, offered, setNow: (n: number) => { now = n; } };
}
afterEach(() => vi.useRealTimers());

describe('owner reuse controller', () => {
  it('inspects before offering, rereads before commit and caches terminal results', async () => {
    const f = fixture();
    await f.owner.handle(probe());
    expect(f.inspect).toHaveBeenCalledTimes(1);
    expect(f.activate).not.toHaveBeenCalled();
    const o = f.offered();
    await f.owner.handle(message(o, 'commit'));
    await f.owner.handle(message(o, 'commit'));
    await f.owner.handle(message(o, 'status'));
    expect(f.inspect).toHaveBeenCalledTimes(2);
    expect(f.activate).toHaveBeenCalledTimes(1);
    expect(f.messages.slice(1).map(m => m.type === 'result' && m.outcome)).toEqual(['activated', 'activated', 'activated']);
    for (const m of f.messages) expect(Object.keys(m).sort()).toEqual([
      'deadline', 'documentId', 'fence', 'offerId', 'ownerInstanceId',
      'requestId', 'requesterId', 'revision', 'type', 'v', ...(m.type === 'result' ? ['outcome'] : []),
    ].sort());
    f.owner.dispose();
  });
  it('rechecks live eligibility after the asynchronous commit read', async () => {
    const f = fixture();
    await f.owner.handle(probe());
    const o = f.offered();
    const read = deferred<{ revision: number }>();
    f.inspect.mockReturnValueOnce(read.promise);
    const pending = f.owner.handle(message(o, 'commit'));
    f.eligible.mockReturnValue(false); // source/privacy/IME can change while storage waits
    read.resolve({ revision: 1 }); await pending;
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toMatchObject({ type: 'result', outcome: 'refused' });
    f.owner.dispose();
  });
  it('cancels pending reads and rejects delayed/duplicate commits', async () => {
    const f = fixture();
    await f.owner.handle(probe());
    const o = f.offered();
    const read = deferred<{ revision: number }>();
    f.inspect.mockReturnValueOnce(read.promise);
    const pending = f.owner.handle(message(o, 'commit'));
    const signal = f.inspect.mock.calls.at(-1)![1];
    await f.owner.handle(message(o, 'cancel'));
    expect(signal.aborted).toBe(true);
    read.resolve({ revision: 1 }); await pending;
    await f.owner.handle(message(o, 'commit'));
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toMatchObject({ outcome: 'cancelled' });
    f.owner.dispose();
  });
  it('invalidates in-flight proof and emits no stale result or activation', async () => {
    for (const dispose of [false, true]) {
      const f = fixture();
      await f.owner.handle(probe());
      const o = f.offered();
      const read = deferred<{ revision: number }>();
      f.inspect.mockReturnValueOnce(read.promise);
      const pending = f.owner.handle(message(o, 'commit'));
      if (dispose) f.owner.dispose(); else f.owner.invalidate();
      read.resolve({ revision: 1 }); await pending;
      expect(f.activate).not.toHaveBeenCalled();
      expect(f.messages).toHaveLength(1);
      if (!dispose) {
        await f.owner.handle(message(o, 'commit'));
        expect(f.messages.at(-1)).toMatchObject({ outcome: 'unknown' });
      }
      f.owner.dispose();
    }
  });
  it('expires inspection and never activates if the provider ignores abort', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.owner.handle(probe());
    const read = deferred<{ revision: number }>();
    f.inspect.mockReturnValueOnce(read.promise);
    const pending = f.owner.handle(message(f.offered(), 'commit'));
    f.setNow(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.inspect.mock.calls.at(-1)![1].aborted).toBe(true);
    expect(f.messages.at(-1)).toMatchObject({ outcome: 'refused' });
    read.resolve({ revision: 1 }); await pending;
    expect(f.activate).not.toHaveBeenCalled();
    f.owner.dispose();
  });
  it('bounds unsettled inspections even across invalidation and offer expiry', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const read = deferred<{ revision: number }>();
    f.inspect.mockReturnValue(read.promise);
    const pending: Promise<void>[] = [];
    for (let i = 0; i < REUSE_MAX_OFFERS; i++) pending.push(f.owner.handle(probe(request(`r${i}`))));
    expect(f.inspect).toHaveBeenCalledTimes(REUSE_MAX_OFFERS);
    f.setNow(2000); await vi.advanceTimersByTimeAsync(2000);
    f.owner.invalidate();
    await f.owner.handle(probe({ ...request('extra'), deadline: 4000 }));
    expect(f.inspect).toHaveBeenCalledTimes(REUSE_MAX_OFFERS);
    read.resolve({ revision: 1 }); await Promise.all(pending);
    expect(f.messages).toHaveLength(0);
    await f.owner.handle(probe({ ...request('new'), deadline: 4000 }));
    expect(f.inspect).toHaveBeenCalledTimes(REUSE_MAX_OFFERS + 1);
    expect(f.messages.at(-1)).toMatchObject({ type: 'offer', requestId: 'new' });
    f.owner.dispose();
  });
  it('does not start duplicate concurrent inspections or activate before an offer', async () => {
    const f = fixture();
    const read = deferred<{ revision: number }>();
    f.inspect.mockReturnValueOnce(read.promise);
    const pending = f.owner.handle(probe());
    await f.owner.handle(probe());
    await f.owner.handle(message({ ...request(), offerId: 'o1' }, 'commit'));
    expect(f.inspect).toHaveBeenCalledTimes(1);
    expect(f.messages.at(-1)).toMatchObject({ outcome: 'unknown' });
    read.resolve({ revision: 1 }); await pending;
    expect(f.activate).not.toHaveBeenCalled();
    f.owner.dispose();
  });
  it('does no storage work for malformed, foreign-owner or unknown-offer traffic', async () => {
    const f = fixture();
    for (const value of [null, { ...probe(), text: 'secret' }, probe({ ...request(), ownerInstanceId: 'other' }),
      message({ ...request(), offerId: 'absent' }, 'commit')]) await f.owner.handle(value);
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.messages).toEqual([{ ...request(), offerId: 'absent', v: 1, type: 'result', outcome: 'unknown' }]);
    f.owner.dispose();
  });
  it('retains partial activation failure as unknown even when posting throws', async () => {
    const f = fixture();
    await f.owner.handle(probe());
    const o = f.offered();
    f.activate.mockImplementation(() => { throw new Error('possibly selected already'); });
    f.post.mockImplementationOnce(() => { throw new Error('channel closed'); });
    await f.owner.handle(message(o, 'commit'));
    await f.owner.handle(message(o, 'status'));
    await f.owner.handle(message(o, 'commit'));
    expect(f.activate).toHaveBeenCalledTimes(1);
    expect(f.messages.at(-1)).toMatchObject({ outcome: 'unknown' });
    f.owner.dispose();
  });
  it('storage failures never activate; a probe alone cannot leave a published offer', async () => {
    const f = fixture();
    f.inspect.mockRejectedValueOnce(new Error('storage unavailable'));
    await f.owner.handle(probe());
    expect(f.messages).toEqual([]);
    expect(f.activate).not.toHaveBeenCalled();
    f.owner.dispose();
  });
  it('honors synchronous lifecycle invalidation inside guard or activation hooks', async () => {
    for (const duringActivation of [false, true]) {
      const f = fixture();
      await f.owner.handle(probe());
      const o = f.offered();
      if (duringActivation) f.activate.mockImplementation(() => { f.owner.invalidate(); return 'activated'; });
      else f.eligible.mockImplementation(() => { f.owner.invalidate(); return true; });
      await f.owner.handle(message(o, 'commit'));
      expect(f.activate).toHaveBeenCalledTimes(duringActivation ? 1 : 0);
      expect(f.messages).toHaveLength(1); // no result from the invalidated generation
      f.owner.dispose();
    }
  });
  it('installation removes its listener and closes its channel on disposal', () => {
    const f = fixture();
    const addEventListener = vi.fn(); const removeEventListener = vi.fn(); const close = vi.fn();
    const channel = { addEventListener, removeEventListener, close, postMessage: vi.fn() } as unknown as BroadcastChannel;
    const installed = installReuseOwner(f.deps, channel);
    const handler = addEventListener.mock.calls[0][1];
    expect(addEventListener).toHaveBeenCalledWith('message', handler);
    installed.dispose();
    expect(removeEventListener).toHaveBeenCalledWith('message', handler);
    expect(close).toHaveBeenCalledTimes(1);
    f.owner.dispose();
  });
});
