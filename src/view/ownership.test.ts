import { describe, expect, it } from 'vitest';
import {
  editBlockGuidance,
  editOwnerLockName,
  mayAcquireEditOwnership,
  mayRetryEditOwnership,
  nextOwnershipFence,
  ownershipFenceAllowsWrite,
  ownershipHeartbeatExpired,
  type EditOwnershipRecord,
} from './ownership';

const DOC = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

function record(overrides: Partial<EditOwnershipRecord> = {}): EditOwnershipRecord {
  return {
    documentId: DOC,
    ownerInstanceId: 'owner-1',
    fence: 2,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('edit ownership helpers', () => {
  it('names the Web Lock distinctly from recovery locks', () => {
    expect(editOwnerLockName(DOC)).toBe(`typebridge-edit-owner:${DOC}`);
    expect(editOwnerLockName(DOC).startsWith('typebridge-recovery-owner:')).toBe(false);
  });

  it('increments the fence on acquire', () => {
    expect(nextOwnershipFence(undefined)).toBe(1);
    expect(nextOwnershipFence(record({ fence: 7 }))).toBe(8);
  });

  it('reports heartbeat staleness for diagnostics only', () => {
    expect(ownershipHeartbeatExpired(record({ updatedAt: 1_000 }), 31_001, 30_000)).toBe(true);
    expect(ownershipHeartbeatExpired(record({ updatedAt: 1_000 }), 30_000, 30_000)).toBe(false);
  });

  it('keeps clients without Web Locks as viewers (no heartbeat takeover)', () => {
    expect(mayAcquireEditOwnership(true)).toBe(true);
    expect(mayAcquireEditOwnership(false)).toBe(false);
    // A stale heartbeat does not grant acquisition without Web Locks.
    const stale = record({ updatedAt: 1 });
    expect(ownershipHeartbeatExpired(stale, 1_000_000)).toBe(true);
    expect(mayAcquireEditOwnership(false)).toBe(false);
  });

  it('allows writes only when instance and fence match', () => {
    expect(ownershipFenceAllowsWrite(record(), 'owner-1', 2)).toBe(true);
    expect(ownershipFenceAllowsWrite(record(), 'owner-1', 1)).toBe(false);
    expect(ownershipFenceAllowsWrite(record(), 'other', 2)).toBe(false);
    expect(ownershipFenceAllowsWrite(undefined, 'owner-1', 2)).toBe(false);
  });

  it('rejects a released record and a later tenure of the same window', () => {
    const released = record({ ownerInstanceId: '' });
    expect(ownershipFenceAllowsWrite(released, 'owner-1', 2)).toBe(false);
    expect(ownershipFenceAllowsWrite(released, '', 2)).toBe(false);
    // Re-acquiring after release raises the fence, so a write still carrying the old one fails.
    const reacquired = record({ fence: nextOwnershipFence(released) });
    expect(ownershipFenceAllowsWrite(reacquired, 'owner-1', 2)).toBe(false);
    expect(ownershipFenceAllowsWrite(reacquired, 'owner-1', 3)).toBe(true);
  });
});

describe('read-only access guidance', () => {
  it('retries only blocks that a free lock could resolve', () => {
    expect(mayRetryEditOwnership('busy')).toBe(true);
    expect(mayRetryEditOwnership('lost')).toBe(true);
    expect(mayRetryEditOwnership('error')).toBe(true);
    expect(mayRetryEditOwnership('unsupported')).toBe(false);
    expect(mayRetryEditOwnership('')).toBe(false);
  });

  it('says nothing while this window is the owner', () => {
    expect(editBlockGuidance('', false)).toBe('');
    expect(editBlockGuidance('', true)).toBe('');
  });

  it('explains each read-only reason and points to copy/export', () => {
    expect(editBlockGuidance('busy', false)).toContain('open for editing in another TypeBridge window');
    expect(editBlockGuidance('busy', false)).toContain('close the other window');
    expect(editBlockGuidance('lost', false)).toContain('Another TypeBridge window is now editing this document');
    expect(editBlockGuidance('unsupported', false)).toContain('Web Locks');
    expect(editBlockGuidance('unsupported', false)).toContain('copy and export');
    expect(editBlockGuidance('error', false)).toContain('Reload to try again');
  });

  it('adds the unsaved-text warning only when this window holds unsaved text', () => {
    const warning = 'Your unsaved changes here were not saved; copy or export them to keep them.';
    for (const block of ['busy', 'lost', 'error'] as const) {
      expect(editBlockGuidance(block, true)).toContain(warning);
      expect(editBlockGuidance(block, false)).not.toContain(warning);
    }
  });
});
