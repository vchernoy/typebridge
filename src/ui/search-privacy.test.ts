import { describe, expect, it } from 'vitest';
import { planSearchPrivacyTransition } from './search-privacy';

const DOC = 'doc-a';
const OTHER = 'doc-b';

describe('planSearchPrivacyTransition (#264 P0)', () => {
  it('bootstraps by restoring public text and allowing persist when writable', () => {
    expect(planSearchPrivacyTransition('', DOC, true)).toEqual({
      scope: `${DOC}:true`,
      restore: true,
      allowPersist: true,
      changed: true,
    });
  });

  it('observes entry into private without restoring (keeps in-memory query)', () => {
    expect(planSearchPrivacyTransition(`${DOC}:true`, DOC, false)).toEqual({
      scope: `${DOC}:false`,
      restore: false,
      allowPersist: false,
      changed: true,
    });
  });

  it('restores public text when leaving private so a held-save reversal cannot persist a private query', () => {
    // on → type private → off while last-save still in flight: scope was observed as private.
    expect(planSearchPrivacyTransition(`${DOC}:false`, DOC, true)).toEqual({
      scope: `${DOC}:true`,
      restore: true,
      allowPersist: true,
      changed: true,
    });
  });

  it('no-ops when scope is unchanged (finish after already-observed enter must not wipe the query)', () => {
    expect(planSearchPrivacyTransition(`${DOC}:false`, DOC, false)).toEqual({
      scope: `${DOC}:false`,
      restore: false,
      allowPersist: false,
      changed: false,
    });
    expect(planSearchPrivacyTransition(`${DOC}:true`, DOC, true)).toEqual({
      scope: `${DOC}:true`,
      restore: false,
      allowPersist: true,
      changed: false,
    });
  });

  it('restores when switching documents even while private', () => {
    expect(planSearchPrivacyTransition(`${DOC}:false`, OTHER, false)).toEqual({
      scope: `${OTHER}:false`,
      restore: true,
      allowPersist: false,
      changed: true,
    });
  });

  it('treats on→off→on as observe private, restore on leave, observe private again', () => {
    const enter = planSearchPrivacyTransition(`${DOC}:true`, DOC, false);
    expect(enter.restore).toBe(false);
    const leave = planSearchPrivacyTransition(enter.scope, DOC, true);
    expect(leave.restore).toBe(true);
    expect(leave.allowPersist).toBe(true);
    const reenter = planSearchPrivacyTransition(leave.scope, DOC, false);
    expect(reenter.restore).toBe(false);
    expect(reenter.allowPersist).toBe(false);
  });
});
