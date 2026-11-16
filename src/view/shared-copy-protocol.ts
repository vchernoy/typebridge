import { isDocumentId } from './route';

export const REUSE_OFFER_MS = 2_000;
export const REUSE_OUTCOME_MS = 60_000;
export const REUSE_MAX_OFFERS = 16;
export const REUSE_MAX_ENTRIES = 64;

export type ReuseRequest = {
  documentId: string; revision: number; ownerInstanceId: string; fence: number;
  requesterId: string; requestId: string; deadline: number;
};
export type ReuseOffer = ReuseRequest & { offerId: string };
export type ReuseOutcome = 'activated' | 'refused' | 'cancelled' | 'unknown';
export type ReuseMessage =
  | (ReuseRequest & { v: 1; type: 'probe' })
  | (ReuseOffer & { v: 1; type: 'offer' | 'commit' | 'status' | 'cancel' })
  | (ReuseOffer & { v: 1; type: 'result'; outcome: ReuseOutcome });
const FIELDS = ['documentId', 'revision', 'ownerInstanceId', 'fence', 'requesterId', 'requestId', 'deadline'] as const;
const token = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(s);
const clock = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const outcome = (x: unknown): x is ReuseOutcome => x === 'activated' || x === 'refused' || x === 'cancelled' || x === 'unknown';

/** Strict metadata boundary: no unknown fields, nested values, source, titles or histories. */
export function parseReuseMessage(value: unknown): ReuseMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.type !== 'string' || !['probe', 'offer', 'commit', 'status', 'cancel', 'result'].includes(v.type)) return undefined;
  if (typeof v.documentId !== 'string' || v.documentId.length > 45 || !isDocumentId(v.documentId) || !clock(v.revision) || v.revision < 1 || !clock(v.fence) || v.fence < 1 ||
      !clock(v.deadline) || !token(v.ownerInstanceId) || !token(v.requesterId) || !token(v.requestId)) return undefined;
  const allowed: readonly string[] = [...FIELDS, 'v', 'type', ...(v.type !== 'probe' ? ['offerId'] : []), ...(v.type === 'result' ? ['outcome'] : [])];
  if (Object.keys(v).some(key => !allowed.includes(key)) || (v.type !== 'probe' && !token(v.offerId)) || (v.type === 'result' && !outcome(v.outcome))) return undefined;
  // Copy only validated scalar fields; caller mutations cannot alter an accepted identity.
  return Object.fromEntries(allowed.map(key => [key, v[key]])) as ReuseMessage;
}
const copyRequest = (r: ReuseRequest): ReuseRequest => ({
  documentId: r.documentId, revision: r.revision, ownerInstanceId: r.ownerInstanceId,
  fence: r.fence, requesterId: r.requesterId, requestId: r.requestId, deadline: r.deadline,
});
const requestKey = (r: ReuseRequest): string => JSON.stringify(FIELDS.map(k => r[k]));
const sameOffer = (a: ReuseOffer, b: ReuseOffer): boolean => requestKey(a) === requestKey(b) && a.offerId === b.offerId;
const validOffer = (o: ReuseOffer): boolean => !!parseReuseMessage({ ...o, v: 1, type: 'commit' });
type Entry = { offer: ReuseOffer; state: 'offered' | 'executing' | ReuseOutcome; expiresAt: number; retainUntil: number };

/** In-memory owner ledger only. Does not read storage, yield locks, focus a window or send messages. */
export class ReuseOwnerLedger {
  private readonly entries = new Map<string, Entry>();
  private cleanup(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.state === 'offered' && now >= entry.expiresAt) {
        entry.state = 'refused';
        entry.retainUntil = entry.expiresAt + REUSE_OUTCOME_MS;
      }
      if (entry.state !== 'offered' && entry.state !== 'executing' && now >= entry.retainUntil) this.entries.delete(key);
    }
  }
  reserve(request: ReuseRequest, offerId: string, now: number): ReuseOffer | undefined {
    const parsed = parseReuseMessage({ ...request, v: 1, type: 'probe' });
    if (!parsed || !token(offerId) || !clock(now) || request.deadline <= now) return undefined;
    this.cleanup(now);
    const prior = this.entries.get(requestKey(request));
    if (prior) return prior.state === 'offered' ? { ...prior.offer } : undefined;
    if (this.entries.size >= REUSE_MAX_ENTRIES || [...this.entries.values()].filter(e => e.state === 'offered' || e.state === 'executing').length >= REUSE_MAX_OFFERS) return undefined;
    const identity = copyRequest(parsed);
    const offer: ReuseOffer = { ...identity, offerId };
    this.entries.set(requestKey(offer), { offer, state: 'offered', expiresAt: Math.min(request.deadline, now + REUSE_OFFER_MS), retainUntil: Infinity });
    return { ...offer };
  }
  private find(offer: ReuseOffer, now: number): Entry | undefined {
    if (!clock(now) || !validOffer(offer)) return undefined;
    this.cleanup(now);
    const entry = this.entries.get(requestKey(offer));
    return entry && sameOffer(entry.offer, offer) ? entry : undefined;
  }
  status(offer: ReuseOffer, now: number): ReuseOutcome {
    const state = this.find(offer, now)?.state;
    return state && state !== 'offered' && state !== 'executing' ? state : 'unknown';
  }
  /**
   * Integrator must reread row/fence asynchronously BEFORE this call, then synchronously
   * recheck live source/privacy/lifecycle and activate inside verifyAndActivate.
   * Refused means no activation occurred; exceptions/partial effects remain unknown.
   */
  commit(offer: ReuseOffer, now: number, verifyAndActivate: () => ReuseOutcome): ReuseOutcome {
    const entry = this.find(offer, now);
    if (!entry) return 'unknown';
    if (entry.state !== 'offered') return this.status(offer, now);
    entry.state = 'executing';
    let result: ReuseOutcome = 'unknown';
    try { const value = verifyAndActivate(); if (outcome(value)) result = value; } catch { /* Partial effect is not refusal. */ }
    entry.state = result;
    entry.retainUntil = now + REUSE_OUTCOME_MS;
    return result;
  }
  cancel(offer: ReuseOffer, now: number): ReuseOutcome {
    const entry = this.find(offer, now);
    if (!entry) return 'unknown';
    if (entry.state === 'offered') { entry.state = 'cancelled'; entry.retainUntil = now + REUSE_OUTCOME_MS; }
    return this.status(offer, now);
  }
}

export type ReuseRequesterState = 'probing' | 'offered' | 'awaiting' | 'unknown' | 'activated' | 'refused' | 'fallback' | 'cancelled';

/** One Edit action; a warned new-copy action needs a NEW instance/request identity. */
export class ReuseRequester {
  private current: ReuseRequesterState = 'probing';
  private selected: ReuseOffer | undefined;
  private readonly request: ReuseRequest;
  constructor(request: ReuseRequest) {
    const parsed = parseReuseMessage({ ...request, v: 1, type: 'probe' });
    if (!parsed) throw new Error('Invalid reuse request');
    const identity = copyRequest(parsed);
    this.request = identity;
  }
  get state(): ReuseRequesterState { return this.current; }
  get canFallback(): boolean { return this.current === 'fallback' || this.current === 'refused'; }
  acceptOffer(offer: ReuseOffer, now: number): boolean {
    if (this.current !== 'probing' || !clock(now) || !validOffer(offer) || now >= this.request.deadline || requestKey(offer) !== requestKey(this.request)) return false;
    this.selected = { ...offer }; this.current = 'offered'; return true;
  }
  /** Mark before sending; a thrown/unknown transport result must not enable fallback. */
  commit(now: number): ReuseOffer | undefined {
    if (this.current !== 'offered' || !clock(now)) return undefined;
    if (now >= this.request.deadline) { this.current = 'fallback'; return undefined; }
    this.current = 'awaiting'; return { ...this.selected! };
  }
  timeout(): void {
    if (this.current === 'probing' || this.current === 'offered') this.current = 'fallback';
    else if (this.current === 'awaiting') this.current = 'unknown';
  }
  receive(message: unknown): boolean {
    const parsed = parseReuseMessage(message);
    if (!parsed || parsed.type !== 'result' || !this.selected || !sameOffer(parsed, this.selected) || (this.current !== 'awaiting' && this.current !== 'unknown')) return false;
    this.current = parsed.outcome === 'cancelled' ? 'refused' : parsed.outcome;
    return true;
  }
  /** User-triggered status only: no new commit, offer renewal or automatic retry. */
  reconciliation(): ReuseMessage | undefined {
    return this.current === 'unknown' && this.selected ? { ...this.selected, v: 1, type: 'status' } : undefined;
  }
  /** Lifecycle cancellation ignores late results; caller may send best-effort cancel. */
  cancel(): void { this.current = 'cancelled'; }
}
