import { describe, expect, it, vi } from 'vitest';
import {
  PREFS_EVENT,
  applyPrefsToFrames,
} from './prefs-sync';

describe('prefs-sync', () => {
  it('uses a stable CustomEvent name', () => {
    expect(PREFS_EVENT).toBe('typebridge-prefs');
  });

  it('applyPrefsToFrames calls each frame hook', () => {
    const a = vi.fn();
    const b = vi.fn();
    const frameA = { contentWindow: { __typebridgeApplyPrefs: a } } as unknown as HTMLIFrameElement;
    const frameB = { contentWindow: { __typebridgeApplyPrefs: b } } as unknown as HTMLIFrameElement;
    applyPrefsToFrames([frameA, frameB], 'rules', 'host');
    expect(a).toHaveBeenCalledWith('rules', 'host');
    expect(b).toHaveBeenCalledWith('rules', 'host');
  });

  it('applyPrefsToFrames tolerates missing contentWindow', () => {
    expect(() => applyPrefsToFrames([{ contentWindow: null } as unknown as HTMLIFrameElement], 'appearance')).not.toThrow();
  });
});
