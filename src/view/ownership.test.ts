import { describe, expect, it } from 'vitest';
import {
  canAcquireWithoutWebLock,
  editOwnerLockName,
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

  it('expires heartbeats only for the unsupported-locks fallback', () => {
    expect(ownershipHeartbeatExpired(record({ updatedAt: 1_000 }), 31_001, 30_000)).toBe(true);
    expect(ownershipHeartbeatExpired(record({ updatedAt: 1_000 }), 30_000, 30_000)).toBe(false);
  });

  it('allows acquire without Web Locks when missing, same instance, or expired', () => {
    expect(canAcquireWithoutWebLock(undefined, 'a', 0)).toBe(true);
    expect(canAcquireWithoutWebLock(record(), 'owner-1', 1_000)).toBe(true);
    expect(canAcquireWithoutWebLock(record(), 'other', 1_000)).toBe(false);
    expect(canAcquireWithoutWebLock(record({ updatedAt: 1 }), 'other', 50_000)).toBe(true);
  });

  it('allows writes only when instance and fence match', () => {
    expect(ownershipFenceAllowsWrite(record(), 'owner-1', 2)).toBe(true);
    expect(ownershipFenceAllowsWrite(record(), 'owner-1', 1)).toBe(false);
    expect(ownershipFenceAllowsWrite(record(), 'other', 2)).toBe(false);
    expect(ownershipFenceAllowsWrite(undefined, 'owner-1', 2)).toBe(false);
  });
});
