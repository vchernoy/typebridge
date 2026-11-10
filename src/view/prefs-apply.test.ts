import { describe, expect, it } from 'vitest';
import { applyPrefs, prefTargets, type PrefTarget } from './prefs-apply';

describe('prefTargets', () => {
  it('re-reads only the setting that changed', () => {
    expect(prefTargets('appearance')).toEqual(['appearance']);
    expect(prefTargets('transliteration')).toEqual(['typing']);
    expect(prefTargets('shortcut')).toEqual(['typing']);
    expect(prefTargets('tabIndent')).toEqual(['tabIndent']);
    expect(prefTargets('autosave')).toEqual(['autosave']);
  });
  it('leaves settings other modules apply themselves', () => {
    expect(prefTargets('rules')).toEqual([]);
    expect(prefTargets('windowLayout')).toEqual([]);
  });
  it('re-reads everything on Reset settings', () => {
    expect(prefTargets('reset')).toEqual(['appearance', 'typing', 'tabIndent', 'autosave', 'findOptions', 'layout']);
  });
});

describe('applyPrefs', () => {
  it('runs targets in order and tolerates best-effort failures', () => {
    const calls: PrefTarget[] = [];
    const note = (target: PrefTarget) => () => { calls.push(target); };
    applyPrefs('reset', {
      appearance: note('appearance'), typing: note('typing'), tabIndent: note('tabIndent'), autosave: note('autosave'),
      findOptions: () => { throw new Error('closed'); },
      layout: note('layout'),
    });
    expect(calls).toEqual(['appearance', 'typing', 'tabIndent', 'autosave', 'layout']);
  });
});
