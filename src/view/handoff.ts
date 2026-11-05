/**
 * Same-tab focus handoff protocol for #175 step 4.
 * Metadata may travel on BroadcastChannel; unsaved text/title/history never does —
 * same-tab transfer uses in-memory postMessage / same-origin frame calls only.
 */

import { isDocumentId } from './route';
import { isWindowId, type WindowId } from './window-id';

export const HANDOFF_CHANNEL = 'typebridge-handoff.v1';
export const TAB_TOKEN_KEY = 'typebridge.tabToken.v1';
/** How long a requester waits for a cooperative yield before stealing a suspended lock. */
export const HANDOFF_YIELD_TIMEOUT_MS = 2_000;

export type HandoffSnapshot = {
  text: string;
  title: string;
  history?: unknown;
  dirty: boolean;
  revision: number;
};

export type HandoffRequestMessage = {
  v: 1;
  type: 'handoff-request';
  tabToken: string;
  documentId: string;
  fromWindowId: WindowId | '';
  fromInstanceId: string;
  requestId: string;
  at: number;
};

export type HandoffReleasedMessage = {
  v: 1;
  type: 'handoff-released';
  tabToken: string;
  documentId: string;
  toInstanceId: string;
  requestId: string;
  at: number;
  /** Present only on same-tab in-memory routes — never set on BroadcastChannel. */
  snapshot?: HandoffSnapshot;
};

export type HandoffRefusedMessage = {
  v: 1;
  type: 'handoff-refused';
  tabToken: string;
  documentId: string;
  toInstanceId: string;
  requestId: string;
  at: number;
  reason: HandoffRefuseReason;
};

export type HandoffRefuseReason =
  | 'ime'
  | 'busy'
  | 'private'
  | 'saving'
  | 'save-failed'
  | 'cross-tab-private';

export type HandoffMessage = HandoffRequestMessage | HandoffReleasedMessage | HandoffRefusedMessage;

const REFUSE_REASONS = new Set<HandoffRefuseReason>([
  'ime', 'busy', 'private', 'saving', 'save-failed', 'cross-tab-private',
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate an unknown handoff payload; returns undefined when it must be ignored. */
export function parseHandoffMessage(value: unknown): HandoffMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  if (typeof record.type !== 'string') return undefined;
  if (typeof record.tabToken !== 'string' || !record.tabToken) return undefined;
  if (typeof record.documentId !== 'string' || !isDocumentId(record.documentId)) return undefined;
  if (typeof record.requestId !== 'string' || !record.requestId) return undefined;
  if (!isFiniteNumber(record.at)) return undefined;

  if (record.type === 'handoff-request') {
    if (typeof record.fromInstanceId !== 'string' || !record.fromInstanceId) return undefined;
    const fromWindowId = record.fromWindowId;
    if (fromWindowId !== '' && (typeof fromWindowId !== 'string' || !isWindowId(fromWindowId))) return undefined;
    return {
      v: 1,
      type: 'handoff-request',
      tabToken: record.tabToken,
      documentId: record.documentId,
      fromWindowId: (fromWindowId || '') as WindowId | '',
      fromInstanceId: record.fromInstanceId,
      requestId: record.requestId,
      at: record.at,
    };
  }

  if (record.type === 'handoff-released') {
    if (typeof record.toInstanceId !== 'string' || !record.toInstanceId) return undefined;
    return {
      v: 1,
      type: 'handoff-released',
      tabToken: record.tabToken,
      documentId: record.documentId,
      toInstanceId: record.toInstanceId,
      requestId: record.requestId,
      at: record.at,
      // snapshot is never accepted from untrusted BroadcastChannel parsing callers —
      // they must strip it; same-origin frame calls may attach it after parse.
    };
  }

  if (record.type === 'handoff-refused') {
    if (typeof record.toInstanceId !== 'string' || !record.toInstanceId) return undefined;
    if (typeof record.reason !== 'string' || !REFUSE_REASONS.has(record.reason as HandoffRefuseReason)) {
      return undefined;
    }
    return {
      v: 1,
      type: 'handoff-refused',
      tabToken: record.tabToken,
      documentId: record.documentId,
      toInstanceId: record.toInstanceId,
      requestId: record.requestId,
      at: record.at,
      reason: record.reason as HandoffRefuseReason,
    };
  }

  return undefined;
}

/** Strip any accidental text payload before BroadcastChannel.postMessage. */
export function metadataOnlyHandoff(message: HandoffMessage): HandoffMessage {
  if (message.type !== 'handoff-released') return message;
  const { snapshot: _ignored, ...meta } = message;
  return meta;
}

/** Shared by every same-origin iframe in this tab (sessionStorage is per-tab). */
export function ensureTabToken(storage: Storage = sessionStorage): string {
  try {
    const existing = storage.getItem(TAB_TOKEN_KEY);
    if (existing && /^[a-z0-9-]{8,64}$/i.test(existing)) return existing;
    const token = crypto.randomUUID();
    storage.setItem(TAB_TOKEN_KEY, token);
    return token;
  } catch {
    return crypto.randomUUID();
  }
}

export function sameTab(a: string, b: string): boolean {
  return a.length > 0 && a === b;
}

/** Owner-side gate for automatic same-tab yield (no dialog). */
export function ownerYieldBlock(input: {
  isOwner: boolean;
  composing: boolean;
  transitioning: boolean;
  saving: boolean;
  saveFailed: boolean;
  dirty: boolean;
  autosaveOn: boolean;
  sameTab: boolean;
}): HandoffRefuseReason | '' {
  if (!input.isOwner) return 'busy';
  if (input.transitioning) return 'busy';
  if (input.composing) return 'ime';
  if (input.saving) return 'saving';
  if (input.saveFailed) return 'save-failed';
  // Cross-tab must never receive private/unsaved text; refuse so requester shows Edit here.
  if (input.dirty && !input.autosaveOn && !input.sameTab) return 'cross-tab-private';
  return '';
}

export function handoffRefuseGuidance(reason: HandoffRefuseReason): string {
  switch (reason) {
    case 'ime':
      return 'The editing window is mid-composition. Finish the composition there, then click here again.';
    case 'busy':
      return 'The editing window is busy with another document action. Click here again in a moment.';
    case 'saving':
      return 'The editing window is still saving. Wait a moment, then click here again.';
    case 'save-failed':
      return 'The editing window could not save. Fix or export there, then click here again.';
    case 'private':
    case 'cross-tab-private':
      return 'The editing window still has unsaved or private changes. Use Edit here after finishing or exporting there, or continue in that window.';
  }
}

/** Character / paste inserts buffered while a handoff is in flight. */
export type BufferedInsert = { text: string };

export function bufferInsertFromKeyboard(event: KeyboardEvent): BufferedInsert | undefined {
  if (event.isComposing || event.key === 'Process') return undefined;
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  if (event.key === 'Enter') return { text: '\n' };
  if (event.key === 'Tab') return { text: '\t' };
  if (event.key.length === 1) return { text: event.key };
  return undefined;
}

export type SameOriginYieldResult =
  | { status: 'released'; snapshot?: HandoffSnapshot }
  | { status: 'refused'; reason: HandoffRefuseReason };

export type FocusHandoffHooks = {
  __typebridgeOwnsDocument?: (documentId: string) => boolean;
  __typebridgeYieldForHandoff?: (request: {
    documentId: string;
    fromInstanceId: string;
    requestId: string;
    tabToken: string;
  }) => Promise<SameOriginYieldResult>;
};
