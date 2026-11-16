/**
 * #330 owner-side metadata transport. Not installed by the editor yet.
 * No source writes, ownership transfers, automatic retries or reader persistence.
 */
import {
  parseReuseMessage, ReuseOwnerLedger, REUSE_MAX_OFFERS, REUSE_OFFER_MS,
  type ReuseMessage, type ReuseOffer, type ReuseOutcome, type ReuseRequest,
} from './shared-copy-protocol';

export const REUSE_CHANNEL = 'typebridge-shared-copy-reuse.v1';

export type ReuseOwnerDeps<Proof> = {
  ownerInstanceId: string;
  /** Fresh committed row/fence inspection; must not save/flush or mutate ownership. */
  inspect: (request: ReuseRequest, signal: AbortSignal) => Promise<Proof>;
  /** Recheck live source, privacy, IME, pending writes, ownership and lifecycle NOW. */
  eligible: (request: ReuseRequest, proof: Proof) => boolean;
  /** Synchronous internal host selection only; a partial failure must be unknown. */
  activate: (request: ReuseRequest) => ReuseOutcome;
  post: (message: ReuseMessage) => void;
  now: () => number;
  nonce: () => string;
};

const identity = (r: ReuseRequest): ReuseRequest => ({
  documentId: r.documentId, revision: r.revision, ownerInstanceId: r.ownerInstanceId,
  fence: r.fence, requesterId: r.requesterId, requestId: r.requestId, deadline: r.deadline,
});
const key = (o: ReuseOffer): string => JSON.stringify([
  o.documentId, o.revision, o.ownerInstanceId, o.fence, o.requesterId,
  o.requestId, o.deadline, o.offerId,
]);

export class ReuseOwnerController<Proof> {
  private ledger = new ReuseOwnerLedger();
  private generation = 0;
  private disposed = false;
  // Keep the slot until inspection settles, even if abort is ignored. A stuck
  // provider can exhaust capacity, but cannot accumulate unbounded pending work.
  private readonly jobs = new Map<string, AbortController>();

  constructor(private readonly deps: ReuseOwnerDeps<Proof>) {}

  private post(message: ReuseMessage): void {
    if (this.disposed) return;
    try { this.deps.post(message); } catch { /* Lost result stays unknown to requester. */ }
  }
  private result(offer: ReuseOffer, outcome: ReuseOutcome): void {
    this.post({ ...offer, v: 1, type: 'result', outcome });
  }

  /** Only parsed, metadata-only requests addressed to this owner are processed. */
  async handle(value: unknown): Promise<void> {
    const message = parseReuseMessage(value);
    if (this.disposed || !message || message.ownerInstanceId !== this.deps.ownerInstanceId) return;
    if (message.type === 'offer' || message.type === 'result') return;
    const request = identity(message);
    if (message.type === 'probe') {
      let nonce: string;
      try { nonce = this.deps.nonce(); } catch { return; }
      const offer = this.ledger.reserve(request, nonce, this.deps.now());
      if (offer) await this.inspect(offer, false);
      return;
    }
    const offer = { ...request, offerId: message.offerId };
    if (message.type === 'status') {
      this.result(offer, this.ledger.status(offer, this.deps.now()));
    } else if (message.type === 'cancel') {
      const outcome = this.ledger.cancel(offer, this.deps.now());
      this.jobs.get(key(offer))?.abort();
      this.result(offer, outcome);
    } else if (this.ledger.isOffered(offer, this.deps.now())) {
      await this.inspect(offer, true);
    } else {
      this.result(offer, this.ledger.status(offer, this.deps.now()));
    }
  }

  private async inspect(offer: ReuseOffer, commit: boolean): Promise<void> {
    const id = key(offer);
    if (this.jobs.has(id)) {
      // Do not begin a second read/activation. A commit before its probe has
      // completed is not a published offer and will not activate later by itself.
      if (commit) this.result(offer, 'unknown');
      return;
    }
    if (this.jobs.size >= REUSE_MAX_OFFERS) {
      const outcome = this.ledger.cancel(offer, this.deps.now());
      if (commit) this.result(offer, outcome);
      return;
    }
    const ledger = this.ledger;
    const generation = this.generation;
    const abort = new AbortController();
    this.jobs.set(id, abort);
    const current = (): boolean => !this.disposed && generation === this.generation;
    const timer = setTimeout(() => {
      abort.abort();
      if (!current()) return;
      const outcome = ledger.cancel(offer, this.deps.now());
      if (commit) this.result(offer, outcome);
    }, Math.max(0, Math.min(REUSE_OFFER_MS, offer.deadline - this.deps.now())));
    try {
      const proof = await this.deps.inspect(identity(offer), abort.signal);
      if (!current()) return;
      const ready = (): boolean => current() && !abort.signal.aborted
        && this.deps.eligible(identity(offer), proof) && current() && !abort.signal.aborted;
      if (commit) {
        // Ledger rechecks expiry/cancellation and marks executing before calling
        // us. Final live verification and selection have no await between them.
        const outcome = ledger.commit(offer, this.deps.now(), () =>
          ready() ? this.deps.activate(identity(offer)) : 'refused');
        if (current()) this.result(offer, outcome);
      } else if (ledger.isOffered(offer, this.deps.now()) && ready()) {
        this.post({ ...offer, v: 1, type: 'offer' });
      } else {
        ledger.cancel(offer, this.deps.now());
      }
    } catch {
      if (!current()) return;
      // Inspection did not activate anything. If an activation callback threw,
      // the ledger already caught it and retained unknown instead.
      const outcome = ledger.cancel(offer, this.deps.now());
      if (commit) this.result(offer, outcome);
    } finally {
      clearTimeout(timer);
      this.jobs.delete(id);
    }
  }

  /** Call on document/private/storage/lifecycle changes before accepting more work. */
  invalidate(): void {
    this.generation++;
    this.ledger = new ReuseOwnerLedger();
    for (const job of this.jobs.values()) job.abort();
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }
}

/** Explicit opt-in installation. Caller owns lifecycle invalidation and fresh guards. */
export function installReuseOwner<Proof>(
  deps: Omit<ReuseOwnerDeps<Proof>, 'post' | 'now' | 'nonce'>,
  channel: BroadcastChannel | null = openChannel(),
): { invalidate: () => void; dispose: () => void } {
  const owner = new ReuseOwnerController({
    ...deps, post: message => channel?.postMessage(message),
    now: () => Date.now(), nonce: () => crypto.randomUUID(),
  });
  const receive = (event: MessageEvent<unknown>): void => { void owner.handle(event.data); };
  channel?.addEventListener('message', receive);
  return {
    invalidate: () => owner.invalidate(),
    dispose: () => {
      owner.dispose();
      channel?.removeEventListener('message', receive);
      try { channel?.close(); } catch { /* Channel already closed. */ }
    },
  };
}
function openChannel(): BroadcastChannel | null {
  try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel(REUSE_CHANNEL) : null; }
  catch { return null; }
}
