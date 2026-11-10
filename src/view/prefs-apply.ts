/**
 * Applying a shared preference changed in another window (#175 step 7). Which settings a
 * change touches is a pure rule; the caller supplies how to re-read each one from storage.
 */
import type { PrefName } from './prefs-sync';

export type PrefTarget = 'appearance' | 'typing' | 'tabIndent' | 'autosave' | 'findOptions' | 'layout';

/** The settings to re-read for a change of `name` (Reset settings re-reads all of them). */
export function prefTargets(name: PrefName): PrefTarget[] {
  const targets: PrefTarget[] = [];
  if (name === 'appearance' || name === 'reset') targets.push('appearance');
  if (name === 'transliteration' || name === 'shortcut' || name === 'reset') targets.push('typing');
  if (name === 'tabIndent' || name === 'reset') targets.push('tabIndent');
  if (name === 'autosave' || name === 'reset') targets.push('autosave');
  if (name === 'reset') targets.push('findOptions', 'layout');
  return targets;
}

/** Re-read the settings a change touches, in order. Find options and layout are best-effort. */
export function applyPrefs(name: PrefName, apply: Record<PrefTarget, () => void>): void {
  for (const target of prefTargets(name)) {
    if (target === 'findOptions' || target === 'layout') {
      try { apply[target](); } catch { /* Best-effort: the Find bar may be closed; layout reset is optional. */ }
    } else apply[target]();
  }
}
