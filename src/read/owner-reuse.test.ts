import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderOwnerReuse, type ReuseTransport } from './owner-reuse';
import { REUSE_OUTCOME_MS, type ReuseMessage } from '../view/shared-copy-protocol';
const candidate = { documentId: '00000000-0000-4000-8000-000000000001', revision: 1, ownerInstanceId: 'owner', fence: 1 };
class Channel {
  readonly messages: ReuseMessage[] = [];
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  throwCommit = false;
  close = vi.fn();
  postMessage(message: ReuseMessage): void {
    this.messages.push(structuredClone(message));
    if (message.type === 'commit' && this.throwCommit) throw new Error('May already be queued');
  }
  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void { if (type === 'message') this.listeners.add(listener); }
  removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void { if (type === 'message') this.listeners.delete(listener); }
  emit(value: unknown): void { for (const listener of this.listeners) listener({ data: value } as MessageEvent<unknown>); }
  offer(index = 0) { return { ...this.messages.filter(m => m.type === 'probe')[index], type: 'offer' as const, offerId: 'offer1' }; }
}
const attempts: ReaderOwnerReuse[] = [];
function fixture(verify = vi.fn(async () => true), count = 1) {
  const channel = new Channel(); let nonce = 0;
  const onResult = vi.fn();
  const attempt = new ReaderOwnerReuse(Array.from({ length: count }, () => ({ ...candidate })), {
    channel: channel as unknown as ReuseTransport, nonce: () => `n${++nonce}`, verify, onResult,
  });
  attempts.push(attempt);
  return { channel, attempt, verify, onResult };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { for (const attempt of attempts.splice(0)) attempt.cancel(); vi.useRealTimers(); });

describe('reader owner transport', () => {
  it('requires a fresh verification and sends one commit for the first accepted offer', async () => {
    const f = fixture(undefined, 2);
    f.channel.emit(f.channel.offer()); f.channel.emit(f.channel.offer(1));
    await settle();
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.channel.messages.filter(m => m.type === 'commit')).toHaveLength(1);
    expect(f.attempt.hasCommitted).toBe(true);
    f.channel.emit({ ...f.channel.offer(), type: 'result', outcome: 'activated' });
    expect(await f.attempt.first).toBe('activated');
    expect(f.channel.close).toHaveBeenCalledTimes(1);
    expect(f.channel.listeners.size).toBe(0);
  });
  it('tries another buffered candidate after fresh verification refuses the first', async () => {
    const verify = vi.fn(async () => true).mockResolvedValueOnce(false);
    const f = fixture(verify, 2);
    f.channel.emit(f.channel.offer()); f.channel.emit(f.channel.offer(1));
    await settle();
    expect(verify).toHaveBeenCalledTimes(2);
    const commits = f.channel.messages.filter(m => m.type === 'commit');
    expect(commits).toHaveLength(1);
    expect(commits[0].requestId).toBe(f.channel.offer(1).requestId);
    f.channel.emit({ ...f.channel.offer(1), type: 'result', outcome: 'activated' });
    expect(await f.attempt.first).toBe('activated');
  });
  it.each([false, true])('rechecks final context and honors cancellation inside the guard (reentrant=%s)', async reentrant => {
    const channel = new Channel(); let nonce = 0;
    const attempt = new ReaderOwnerReuse([candidate], { channel: channel as unknown as ReuseTransport,
      nonce: () => `guard${++nonce}`, verify: async () => true,
      canCommit: () => { if (reentrant) attempt.cancel(); return reentrant; } });
    attempts.push(attempt);
    channel.emit(channel.offer()); await settle();
    expect(await attempt.first).toBe(reentrant ? 'cancelled' : 'fallback');
    expect(channel.messages.some(message => message.type === 'commit')).toBe(false);
  });
  it('bounds probes to sixteen and transmits metadata without source fields', () => {
    const f = fixture(undefined, 25);
    expect(f.channel.messages).toHaveLength(16);
    for (const message of f.channel.messages) expect(Object.keys(message).sort()).toEqual([
      'deadline', 'documentId', 'fence', 'ownerInstanceId', 'requestId', 'requesterId', 'revision', 'type', 'v',
    ]);
  });
  it('falls back before commit after silence or a failed fresh verification', async () => {
    const silence = fixture();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await silence.attempt.first).toBe('fallback');
    expect(silence.attempt.hasCommitted).toBe(false);
    const rejected = fixture(vi.fn(async () => false));
    rejected.channel.emit(rejected.channel.offer()); await settle();
    expect(await rejected.attempt.first).toBe('fallback');
    expect(rejected.channel.messages.some(m => m.type === 'commit')).toBe(false);
  });
  it('does not commit if verification finishes after the pre-commit deadline', async () => {
    let resolve!: (valid: boolean) => void;
    const verify = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const f = fixture(verify);
    f.channel.emit(f.channel.offer());
    await vi.advanceTimersByTimeAsync(2000);
    expect(await f.attempt.first).toBe('fallback');
    resolve(true); await settle();
    expect(f.channel.messages.some(m => m.type === 'commit')).toBe(false);
    expect(f.channel.messages.some(m => m.type === 'cancel')).toBe(true);
  });
  it('lost results become unknown, then a late result resolves without another commit', async () => {
    const f = fixture(); f.channel.emit(f.channel.offer()); await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await f.attempt.first).toBe('unknown');
    expect(f.attempt.hasCommitted).toBe(true);
    expect(f.channel.close).not.toHaveBeenCalled();
    f.channel.emit({ ...f.channel.offer(), type: 'result', outcome: 'activated' });
    expect(f.onResult.mock.calls.map(([value]) => value)).toEqual(['unknown', 'activated']);
    expect(f.channel.messages.filter(m => m.type === 'commit')).toHaveLength(1);
  });
  it('reconciles only the selected old identity and coalesces simultaneous checks', async () => {
    const f = fixture(); f.channel.emit(f.channel.offer()); await settle();
    await vi.advanceTimersByTimeAsync(2000);
    const first = f.attempt.checkStatus(); const second = f.attempt.checkStatus();
    expect(first).toBe(second);
    expect(f.channel.messages.filter(m => m.type === 'status')).toEqual([{ ...f.channel.offer(), type: 'status' }]);
    f.channel.emit({ ...f.channel.offer(), type: 'result', outcome: 'activated' });
    expect(await first).toBe('activated');
    expect(f.channel.messages.filter(m => m.type === 'commit')).toHaveLength(1);
  });
  it('unknown status never authorizes fallback and queries stop at retention expiry', async () => {
    const f = fixture(); f.channel.emit(f.channel.offer()); await settle();
    await vi.advanceTimersByTimeAsync(2000);
    const first = f.attempt.checkStatus();
    f.channel.emit({ ...f.channel.offer(), type: 'result', outcome: 'unknown' });
    expect(await first).toBe('unknown');
    await vi.advanceTimersByTimeAsync(REUSE_OUTCOME_MS - 500);
    const crossingRetirement = f.attempt.checkStatus();
    let reentrant: Promise<string> | undefined;
    f.onResult.mockImplementation(() => { reentrant = f.attempt.checkStatus(); });
    await vi.advanceTimersByTimeAsync(500);
    expect(await reentrant).toBe('unknown');
    expect(await crossingRetirement).toBe('unknown');
    expect(f.channel.close).toHaveBeenCalledTimes(1);
    const count = f.channel.messages.length;
    expect(await f.attempt.checkStatus()).toBe('unknown');
    expect(f.channel.messages).toHaveLength(count);
  });
  it.each(['refused', 'cancelled'])('only confirmed %s permits fallback after commit', async outcome => {
    const f = fixture(); f.channel.emit(f.channel.offer()); await settle();
    f.channel.emit({ ...f.channel.offer(), type: 'result', outcome });
    expect(await f.attempt.first).toBe('fallback');
  });
  it('treats a throwing commit transport as unknown even if it may have queued work', async () => {
    const f = fixture(); f.channel.throwCommit = true; f.channel.emit(f.channel.offer()); await settle();
    expect(await f.attempt.first).toBe('unknown');
    expect(f.attempt.hasCommitted).toBe(true);
  });
  it('ignores spoofed offers, wrong-nonce results and replies after lifecycle cancellation', async () => {
    const f = fixture();
    f.channel.emit({ ...f.channel.offer(), fence: 99 });
    f.channel.emit({ ...f.channel.offer(), text: 'not metadata' });
    expect(f.verify).not.toHaveBeenCalled();
    f.channel.emit(f.channel.offer()); await settle();
    f.channel.emit({ ...f.channel.offer(), type: 'result', requestId: 'other', outcome: 'activated' });
    expect(f.onResult).not.toHaveBeenCalled();
    f.attempt.cancel();
    expect(await f.attempt.first).toBe('cancelled');
    expect(f.attempt.hasCommitted).toBe(true); // Cancellation is not proof of non-activation.
    f.channel.emit({ ...f.channel.offer(), type: 'result', outcome: 'activated' });
    expect(f.onResult.mock.calls.map(([value]) => value)).toEqual(['cancelled']);
  });
  it('aborts pending verification and never commits when it resolves after navigation', async () => {
    let resolve!: (valid: boolean) => void;
    const f = fixture(vi.fn(() => new Promise<boolean>(done => { resolve = done; })));
    f.channel.emit(f.channel.offer());
    f.attempt.cancel(); resolve(true); await settle();
    expect(await f.attempt.first).toBe('cancelled');
    expect(f.channel.messages.some(m => m.type === 'commit')).toBe(false);
  });
  it('does not renew a partially spent Edit-click deadline after candidate lookup', async () => {
    const channel = new Channel();
    const attempt = new ReaderOwnerReuse([candidate], { deadline: 100, channel: channel as unknown as ReuseTransport,
      nonce: () => 'id', verify: async () => true });
    attempts.push(attempt);
    await vi.advanceTimersByTimeAsync(100);
    expect(await attempt.first).toBe('fallback');
    expect(channel.messages[0].deadline).toBe(100);
    expect(attempt.hasCommitted).toBe(false);
  });
  it('does not probe when the original selection deadline is already exhausted', async () => {
    const channel = new Channel();
    const attempt = new ReaderOwnerReuse([candidate], { deadline: 0, channel: channel as unknown as ReuseTransport, verify: async () => true });
    expect(await attempt.first).toBe('fallback');
    expect(channel.messages).toEqual([]);
  });
  it('uses fallback without opening a channel when transport is unsupported', async () => {
    const attempt = new ReaderOwnerReuse([candidate], { channel: null, verify: async () => true });
    expect(await attempt.first).toBe('fallback');
    expect(attempt.hasCommitted).toBe(false);
  });
});
