import { describe, expect, it, vi } from 'vitest';
import {
  parseReuseMessage, ReuseOwnerLedger, ReuseRequester,
  REUSE_MAX_ENTRIES, REUSE_MAX_OFFERS, REUSE_OUTCOME_MS, REUSE_OFFER_MS,
  type ReuseRequest, type ReuseOffer,
} from './shared-copy-protocol';

const request = (requestId = 'request1', deadline = 10_000): ReuseRequest => ({
  documentId: '00000000-0000-4000-8000-000000000001', revision: 1,
  ownerInstanceId: 'owner1', fence: 1, requesterId: 'reader1', requestId, deadline,
});
const offer = (): ReuseOffer => ({ ...request(), offerId: 'offer1' });
const result = (o: ReuseOffer, outcome = 'activated') => ({ ...o, v: 1, type: 'result', outcome });

describe('reuse message metadata boundary', () => {
  it('accepts and copies every message variant', () => {
    for (const type of ['probe', 'offer', 'commit', 'status', 'cancel', 'result']) {
      const message = type === 'probe' ? { ...request(), v: 1, type }
        : { ...offer(), v: 1, type, ...(type === 'result' ? { outcome: 'unknown' } : {}) };
      expect(parseReuseMessage(message)).toEqual(message);
      expect(parseReuseMessage(message)).not.toBe(message);
    }
  });
  it('rejects content, malformed or unbounded metadata without coercing objects', () => {
    const probe = { ...request(), v: 1, type: 'probe' };
    const bad = [null, [], { ...probe, v: 2 }, { ...probe, text: 'private source' },
      { ...probe, title: 'private title' }, { ...probe, requestId: 'x'.repeat(129) },
      { ...probe, documentId: 'x'.repeat(1000) }, { ...probe, deadline: Infinity },
      { ...probe, revision: 1.5 }, { ...probe, fence: 0 }, { ...probe, deadline: -1 },
      { ...probe, type: { toString() { throw new Error('must not coerce'); } } },
      { ...probe, offerId: 'unexpected' }, { ...offer(), v: 1, type: 'result', outcome: 'ok' },
      { ...request(), v: 1, type: 'commit' }];
    for (const message of bad) expect(parseReuseMessage(message)).toBeUndefined();
  });
});

describe('bounded owner ledger', () => {
  it('retains one offer per identity and isolates caller mutations', () => {
    const ledger = new ReuseOwnerLedger();
    const r = request();
    const first = ledger.reserve(r, 'offer1', 0)!;
    r.revision = 2;
    first.offerId = 'tampered';
    expect(ledger.reserve(request(), 'offer2', 1)).toEqual(offer());
  });
  it('activates once under duplicate and reentrant commit/status/cancel', () => {
    const ledger = new ReuseOwnerLedger();
    const o = ledger.reserve(request(), 'offer1', 0)!;
    const activate = vi.fn(() => {
      expect(ledger.status(o, 1)).toBe('unknown');
      expect(ledger.cancel(o, 1)).toBe('unknown');
      expect(ledger.commit(o, 1, activate)).toBe('unknown');
      return 'activated' as const;
    });
    expect(ledger.commit(o, 1, activate)).toBe('activated');
    expect(ledger.commit(o, 2, activate)).toBe('activated');
    expect(ledger.cancel(o, 2)).toBe('activated');
    expect(activate).toHaveBeenCalledTimes(1);
  });
  it('cancellation and offer expiry refuse delayed activation', () => {
    for (const cancel of [false, true]) {
      const ledger = new ReuseOwnerLedger();
      const o = ledger.reserve(request('r', 100), 'offer1', 0)!;
      if (cancel) expect(ledger.cancel(o, 1)).toBe('cancelled');
      const activate = vi.fn(() => 'activated' as const);
      expect(ledger.commit(o, 100, activate)).toBe(cancel ? 'cancelled' : 'refused');
      expect(activate).not.toHaveBeenCalled();
    }
  });
  it('expires offers at the offer lifetime even with a later request deadline', () => {
    const ledger = new ReuseOwnerLedger();
    const o = ledger.reserve(request(), 'offer1', 0)!;
    expect(ledger.status(o, REUSE_OFFER_MS)).toBe('refused');
  });
  it('does not execute forged identities, retired offers or offers after restart', () => {
    const ledger = new ReuseOwnerLedger();
    const o = ledger.reserve(request(), 'offer1', 0)!;
    const activate = vi.fn(() => 'activated' as const);
    for (const changed of [{ fence: 2 }, { revision: 2 }, { offerId: 'other' }, { requestId: 'other' }]) {
      expect(ledger.commit({ ...o, ...changed }, 1, activate)).toBe('unknown');
    }
    expect(new ReuseOwnerLedger().commit(o, 1, activate)).toBe('unknown');
    ledger.cancel(o, 1);
    expect(ledger.commit(o, REUSE_OUTCOME_MS + 1, activate)).toBe('unknown');
    expect(activate).not.toHaveBeenCalled();
  });
  it('retains partial activation failures as unknown without retrying', () => {
    const ledger = new ReuseOwnerLedger();
    const o = ledger.reserve(request(), 'offer1', 0)!;
    const activate = vi.fn(() => { throw new Error('activation may already have happened'); });
    expect(ledger.commit(o, 1, activate)).toBe('unknown');
    expect(ledger.commit(o, 2, activate)).toBe('unknown');
    expect(activate).toHaveBeenCalledTimes(1);
  });
  it('bounds live offers without evicting an accepted offer', () => {
    const ledger = new ReuseOwnerLedger();
    for (let i = 0; i < REUSE_MAX_OFFERS; i++) expect(ledger.reserve(request(`r${i}`), `o${i}`, 0)).toBeDefined();
    expect(ledger.reserve(request('extra'), 'extra', 0)).toBeUndefined();
    expect(ledger.reserve(request('r0'), 'replacement', 1)?.offerId).toBe('o0');
  });
  it('bounds retained outcomes and admits new work only after retirement', () => {
    const ledger = new ReuseOwnerLedger();
    for (let i = 0; i < REUSE_MAX_ENTRIES; i++) {
      const o = ledger.reserve(request(`r${i}`), `o${i}`, 0)!;
      expect(o).toBeDefined();
      ledger.commit(o, 0, () => 'activated');
    }
    expect(ledger.reserve(request('extra'), 'extra', 1)).toBeUndefined();
    expect(ledger.reserve(request('new', REUSE_OUTCOME_MS + 100), 'new', REUSE_OUTCOME_MS)).toBeDefined();
  });
});

describe('requester ambiguity and reconciliation', () => {
  it('permits fallback on timeout only before sending a commit', () => {
    for (const accept of [false, true]) {
      const requester = new ReuseRequester(request());
      if (accept) requester.acceptOffer(offer(), 0);
      requester.timeout();
      expect(requester.canFallback).toBe(true);
      expect(requester.commit(1)).toBeUndefined();
    }
  });
  it('marks awaiting before transport; lost results only allow status reconciliation', () => {
    const requester = new ReuseRequester(request());
    requester.acceptOffer(offer(), 0);
    expect(requester.commit(1)).toEqual(offer());
    expect(requester.state).toBe('awaiting');
    requester.timeout();
    expect(requester.state).toBe('unknown');
    expect(requester.canFallback).toBe(false);
    expect(requester.commit(2)).toBeUndefined();
    expect(requester.reconciliation()).toEqual({ ...offer(), v: 1, type: 'status' });
    requester.receive(result(offer(), 'unknown'));
    expect(requester.canFallback).toBe(false);
    expect(requester.receive(result(offer()))).toBe(true);
    expect(requester.state).toBe('activated');
    expect(requester.reconciliation()).toBeUndefined();
    expect(requester.receive(result(offer(), 'refused'))).toBe(false);
  });
  it('allows safe fallback after an acknowledged non-activation', () => {
    for (const outcome of ['refused', 'cancelled']) {
      const requester = new ReuseRequester(request());
      requester.acceptOffer(offer(), 0); requester.commit(1);
      expect(requester.receive(result(offer(), outcome))).toBe(true);
      expect(requester.canFallback).toBe(true);
    }
  });
  it('rejects mismatched, duplicate, expired and cancelled-action replies', () => {
    const requester = new ReuseRequester(request());
    expect(requester.acceptOffer({ ...offer(), fence: 2 }, 0)).toBe(false);
    expect(requester.acceptOffer(offer(), 10_000)).toBe(false);
    expect(requester.acceptOffer(offer(), 0)).toBe(true);
    expect(requester.acceptOffer(offer(), 0)).toBe(false);
    requester.commit(1);
    expect(requester.receive(result({ ...offer(), offerId: 'other' }))).toBe(false);
    requester.cancel();
    expect(requester.receive(result(offer()))).toBe(false);
    expect(requester.canFallback).toBe(false);
    const next = new ReuseRequester(request('next'));
    expect(next.acceptOffer(offer(), 0)).toBe(false);
  });
  it('does not send a commit after its request deadline', () => {
    const requester = new ReuseRequester(request());
    requester.acceptOffer(offer(), 0);
    expect(requester.commit(10_000)).toBeUndefined();
    expect(requester.canFallback).toBe(true);
  });
});
