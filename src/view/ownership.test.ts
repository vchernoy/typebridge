import { describe, expect, it } from 'vitest';
import {
  editOwnerLockName,
  mayAcquireEditOwnership,
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
});
