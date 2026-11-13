import { describe, expect, it } from 'vitest';
import { persistBlockedByFreeze } from './saver';

describe('persistBlockedByFreeze (#256 Codex P1)', () => {
  it('blocks discard/takeover freeze without a transition', () => {
    expect(persistBlockedByFreeze({ transferFrozen: true, transitioning: false })).toBe(true);
  });

  it('allows delete/switch flush under transitioning + freeze', () => {
    expect(persistBlockedByFreeze({ transferFrozen: true, transitioning: true })).toBe(false);
  });

  it('does not block when editors are not frozen', () => {
    expect(persistBlockedByFreeze({ transferFrozen: false, transitioning: false })).toBe(false);
    expect(persistBlockedByFreeze({ transferFrozen: false, transitioning: true })).toBe(false);
  });
});
