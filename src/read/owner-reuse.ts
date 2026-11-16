/** Bounded reader transport for #330, connected to Edit/result UI by edit-shared.ts. */
import type { OwnedSharedCopyCandidate } from '../editor/indexeddb';
import {
  parseReuseMessage, ReuseRequester, REUSE_OFFER_MS, REUSE_OUTCOME_MS,
  type ReuseMessage, type ReuseOffer,
} from '../view/shared-copy-protocol';
import { REUSE_CHANNEL } from '../view/shared-copy-owner';

export type OwnerReuseResult = 'activated' | 'fallback' | 'unknown' | 'cancelled';
export type ReuseTransport = Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'removeEventListener' | 'close'>;
export type ReaderReuseDeps = {
  /** Fresh row/source/fence, recovery and current privacy checks; never save/claim. */
  verify: (offer: ReuseOffer, signal: AbortSignal) => Promise<boolean>;
  onResult?: (result: OwnerReuseResult) => void;
  /** Synchronous final context/privacy check after asynchronous verification. */
  canCommit?: () => boolean;
  /** Original Edit-click deadline; candidate lookup must not renew the selection budget. */
  deadline?: number;
  channel?: ReuseTransport | null;
  now?: () => number;
  nonce?: () => string;
};

/** One Edit action. Post-commit unknown never permits automatic fallback or a new commit. */
export class ReaderOwnerReuse {
  readonly first: Promise<OwnerReuseResult>;
  private firstResolve: ((result: OwnerReuseResult) => void) | undefined;
  private readonly channel: ReuseTransport | null;
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private readonly requests = new Map<string, ReuseRequester>();
  private selected: { requester: ReuseRequester; offer: ReuseOffer } | undefined;
  private readonly offers: Array<{ requester: ReuseRequester; offer: ReuseOffer }> = [];
  private failed = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retirement: ReturnType<typeof setTimeout> | undefined;
  private checkPromise: Promise<OwnerReuseResult> | undefined;
  private checkResolve: ((result: OwnerReuseResult) => void) | undefined;
  private ended = false;
  private committed = false;
  private lastResult: OwnerReuseResult | undefined;

  constructor(candidates: readonly OwnedSharedCopyCandidate[], private readonly deps: ReaderReuseDeps) {
    this.first = new Promise(resolve => { this.firstResolve = resolve; });
    this.now = deps.now ?? (() => Date.now());
    this.channel = deps.channel === undefined ? openChannel() : deps.channel;
    if (!this.channel) { this.finish('fallback'); return; }
    const nonce = deps.nonce ?? (() => crypto.randomUUID());
    const deadline = Math.min(deps.deadline ?? Infinity, this.now() + REUSE_OFFER_MS);
    if (!Number.isSafeInteger(deadline) || deadline <= this.now()) { this.finish('fallback'); return; }
    const probes: ReuseMessage[] = [];
    try {
      const requesterId = nonce();
      for (const candidate of candidates.slice(0, 16)) {
        const probe = parseReuseMessage({ ...candidate, v: 1, type: 'probe', requesterId, requestId: nonce(), deadline });
        if (!probe || probe.type !== 'probe') continue;
        this.requests.set(probe.requestId, new ReuseRequester({
          documentId: probe.documentId, revision: probe.revision, ownerInstanceId: probe.ownerInstanceId,
          fence: probe.fence, requesterId, requestId: probe.requestId, deadline,
        }));
        probes.push(probe);
      }
    } catch { this.finish('fallback'); return; }
    if (!probes.length) { this.finish('fallback'); return; }
    try { this.channel.addEventListener('message', this.receive); }
    catch { this.finish('fallback'); return; }
    this.timer = setTimeout(() => this.finish('fallback'), Math.max(0, deadline - this.now()));
    for (const probe of probes) { if (!this.committed && !this.ended) this.post(probe); }
  }

  get hasCommitted(): boolean { return this.committed; }
  get canCheckStatus(): boolean { return !this.ended && this.selected?.requester.state === 'unknown'; }
  get result(): OwnerReuseResult | undefined { return this.lastResult; }
  private post(message: ReuseMessage): boolean {
    try { this.channel?.postMessage(message); return !!this.channel; } catch { return false; }
  }
  private readonly receive = (event: MessageEvent<unknown>): void => {
    if (this.ended) return;
    const message = parseReuseMessage(event.data);
    if (!message) return;
    if (message.type === 'offer' && !this.committed) {
      const requester = this.requests.get(message.requestId);
      const offer: ReuseOffer = {
        documentId: message.documentId, revision: message.revision, ownerInstanceId: message.ownerInstanceId,
        fence: message.fence, requesterId: message.requesterId, requestId: message.requestId,
        deadline: message.deadline, offerId: message.offerId,
      };
      if (!requester?.acceptOffer(offer, this.now())) return;
      this.offers.push({ requester, offer });
      this.selectNext();
    } else if (message.type === 'result' && this.selected?.requester.receive(message)) {
      const state = this.selected.requester.state;
      this.finish(state === 'activated' ? 'activated' : state === 'refused' ? 'fallback' : 'unknown');
    }
  };
  private selectNext(): void {
    if (this.ended || this.committed || this.selected) return;
    this.selected = this.offers.shift();
    if (this.selected) void this.verifyAndCommit();
    else if (this.failed === this.requests.size) this.finish('fallback');
  }
  private async verifyAndCommit(): Promise<void> {
    const selected = this.selected!;
    let valid = false;
    try { valid = await this.deps.verify({ ...selected.offer }, this.abort.signal); } catch { /* Pre-commit failure is safe fallback. */ }
    if (this.ended || this.abort.signal.aborted) return;
    try { valid = valid && this.deps.canCommit?.() !== false; } catch { valid = false; }
    if (this.ended || this.abort.signal.aborted) return;
    if (!valid) {
      selected.requester.cancel();
      this.post({ ...selected.offer, v: 1, type: 'cancel' });
      this.failed++;
      this.selected = undefined;
      this.selectNext();
      return;
    }
    const offer = selected.requester.commit(this.now());
    if (!offer) { this.finish('fallback'); return; }
    // Set before transport: even a throwing post may have queued a remote commit.
    this.committed = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { selected.requester.timeout(); this.finish('unknown'); }, REUSE_OFFER_MS);
    if (!this.post({ ...offer, v: 1, type: 'commit' })) {
      selected.requester.timeout(); this.finish('unknown');
    }
  }

  private close(): void {
    this.ended = true;
    clearTimeout(this.timer); clearTimeout(this.retirement);
    this.abort.abort();
    try { this.channel?.removeEventListener('message', this.receive); } catch { /* Already unavailable. */ }
    try { this.channel?.close(); } catch { /* Already closed. */ }
  }
  private finish(result: OwnerReuseResult, retire = false): void {
    if (this.ended) return;
    clearTimeout(this.timer);
    this.lastResult = result;
    if (result === 'unknown' && !retire) {
      this.selected?.requester.timeout();
      // Bounded listener lifetime, never background status polling or automatic retry.
      this.retirement ??= setTimeout(() => this.finish('unknown', true), REUSE_OUTCOME_MS);
    } else {
      if ((result === 'fallback' || result === 'cancelled') && this.selected) {
        this.post({ ...this.selected.offer, v: 1, type: 'cancel' });
      }
      this.close();
    }
    const first = this.firstResolve; this.firstResolve = undefined; first?.(result);
    const check = this.checkResolve; this.checkResolve = undefined; this.checkPromise = undefined; check?.(result);
    try { this.deps.onResult?.(result); } catch { /* Presentation cannot change protocol outcome. */ }
  }
  /** Explicit same-nonce status only. Concurrent clicks share one bounded wait. */
  checkStatus(): Promise<OwnerReuseResult> {
    if (this.checkPromise) return this.checkPromise;
    const status = this.selected?.requester.reconciliation();
    if (this.ended || !status) return Promise.resolve(this.lastResult ?? 'unknown');
    const pending = new Promise<OwnerReuseResult>(resolve => { this.checkResolve = resolve; });
    this.checkPromise = pending;
    this.timer = setTimeout(() => this.finish('unknown'), REUSE_OFFER_MS);
    if (!this.post(status)) this.finish('unknown');
    return pending;
  }
  /** Lifecycle cancellation is abandonment, not evidence that remote activation did not occur. */
  cancel(): void {
    if (this.ended) return;
    this.selected?.requester.cancel();
    this.finish('cancelled');
  }
}
function openChannel(): BroadcastChannel | null {
  try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel(REUSE_CHANNEL) : null; }
  catch { return null; }
}
