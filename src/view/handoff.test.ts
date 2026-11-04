import { describe, expect, it } from 'vitest';
import {
  HANDOFF_REQUEST_TTL_MS,
  createHandoffRefused,
  createHandoffReleased,
  createHandoffRequest,
  handoffRefuseGuidance,
  handoffRequestExpired,
  mayShowEditHere,
  ownerHandoffBlock,
  parseHandoffSignal,
} from './handoff';

const DOC = '11111111-1111-4111-8111-111111111111';
const REQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('parseHandoffSignal', () => {
  it('accepts request, released and refused payloads', () => {
    expect(parseHandoffSignal(createHandoffRequest(DOC, REQ, ATTEMPT, 1))).toEqual({
      v: 1, type: 'request', documentId: DOC, requesterId: REQ, requestId: ATTEMPT, at: 1,
    });
    expect(parseHandoffSignal(createHandoffReleased(DOC, REQ, ATTEMPT, 2))).toEqual({
      v: 1, type: 'released', documentId: DOC, requesterId: REQ, requestId: ATTEMPT, at: 2,
    });
    expect(parseHandoffSignal(createHandoffRefused(DOC, REQ, ATTEMPT, 3, 'private'))).toEqual({
      v: 1, type: 'refused', documentId: DOC, requesterId: REQ, requestId: ATTEMPT, at: 3, reason: 'private',
    });
  });

  it('drops unknown versions, types, ids and refuse reasons', () => {
    expect(parseHandoffSignal({ v: 2, type: 'request', documentId: DOC, requesterId: REQ, requestId: ATTEMPT, at: 1 })).toBeUndefined();
    expect(parseHandoffSignal({ v: 1, type: 'saved', documentId: DOC, requesterId: REQ, requestId: ATTEMPT, at: 1 })).toBeUndefined();
    expect(parseHandoffSignal({ v: 1, type: 'request', documentId: 'nope', requesterId: REQ, requestId: ATTEMPT, at: 1 })).toBeUndefined();
    expect(parseHandoffSignal({ v: 1, type: 'request', documentId: DOC, requesterId: REQ, at: 1 })).toBeUndefined();
    expect(parseHandoffSignal({ v: 1, type: 'refused', documentId: DOC, requesterId: REQ, requestId: ATTEMPT, at: 1, reason: 'nope' })).toBeUndefined();
    expect(parseHandoffSignal({ text: 'secret' })).toBeUndefined();
  });
});

describe('ownerHandoffBlock', () => {
  const clear = {
    isOwner: true,
    composing: false,
    dirty: false,
    autosaveOn: true,
    saving: false,
    saveFailed: false,
    conflictNotice: false,
    transitioning: false,
    transferFrozen: false,
  };

  it('allows a prompt when the owner is idle', () => {
    expect(ownerHandoffBlock(clear)).toBe('');
  });

  it('refuses private dirty, IME, saving, conflict and busy states', () => {
    expect(ownerHandoffBlock({ ...clear, dirty: true, autosaveOn: false })).toBe('private');
    expect(ownerHandoffBlock({ ...clear, composing: true })).toBe('ime');
    expect(ownerHandoffBlock({ ...clear, saving: true })).toBe('saving');
    expect(ownerHandoffBlock({ ...clear, saveFailed: true })).toBe('save-failed');
    expect(ownerHandoffBlock({ ...clear, conflictNotice: true })).toBe('conflict');
    expect(ownerHandoffBlock({ ...clear, transitioning: true })).toBe('busy');
    expect(ownerHandoffBlock({ ...clear, isOwner: false })).toBe('busy');
  });

  it('allows dirty with Autosave on (owner can flush then transfer)', () => {
    expect(ownerHandoffBlock({ ...clear, dirty: true, autosaveOn: true })).toBe('');
  });
});

describe('mayShowEditHere', () => {
  it('shows for viewers and blocked ordinary readers when locks exist', () => {
    expect(mayShowEditHere({
      viewMode: true, viewMissing: false, editBlock: '', webLocksAvailable: true, fieldDisabled: false,
    })).toBe(true);
    expect(mayShowEditHere({
      viewMode: false, viewMissing: false, editBlock: 'busy', webLocksAvailable: true, fieldDisabled: false,
    })).toBe(true);
    expect(mayShowEditHere({
      viewMode: false, viewMissing: false, editBlock: '', webLocksAvailable: true, fieldDisabled: false,
    })).toBe(false);
    expect(mayShowEditHere({
      viewMode: true, viewMissing: true, editBlock: '', webLocksAvailable: true, fieldDisabled: false,
    })).toBe(false);
  });
});

describe('handoffRefuseGuidance', () => {
  it('explains private and declined refusals', () => {
    expect(handoffRefuseGuidance('private')).toContain('unsaved or private');
    expect(handoffRefuseGuidance('declined')).toContain('still editing');
  });
});

describe('handoffRequestExpired', () => {
  it('expires after the shared TTL', () => {
    expect(handoffRequestExpired(1000, 1000 + HANDOFF_REQUEST_TTL_MS)).toBe(false);
    expect(handoffRequestExpired(1000, 1000 + HANDOFF_REQUEST_TTL_MS + 1)).toBe(true);
    expect(handoffRequestExpired(1000, 1500, 400)).toBe(true);
  });
});
