/**
 * #175 step 6: Auto / Free / Stacked layout preference and capability detection.
 * Preference only — never document text.
 */

export const HOST_LAYOUT_MODE_KEY = 'typebridge.host.layoutMode.v1';

export type LayoutModePreference = 'auto' | 'free' | 'stacked';
export type EffectiveLayoutMode = 'free' | 'stacked';

/** Narrow host or coarse/no-hover pointer → phone-style stack under Auto. */
export const STACK_VIEWPORT_MAX_PX = 640;

export function layoutModePreference(value: unknown): LayoutModePreference {
  return value === 'free' || value === 'stacked' || value === 'auto' ? value : 'auto';
}

/** Resolve localStorage without throwing when the getter itself is blocked. */
function defaultStorage(): Storage | undefined {
  try { return localStorage; } catch { return undefined; }
}

export function readLayoutModePreference(storage?: Storage | null): LayoutModePreference {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return 'auto';
  try {
    return layoutModePreference(store.getItem(HOST_LAYOUT_MODE_KEY));
  } catch {
    return 'auto';
  }
}

export function writeLayoutModePreference(
  preference: LayoutModePreference,
  storage?: Storage | null,
): boolean {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return false;
  try {
    if (preference === 'auto') store.removeItem(HOST_LAYOUT_MODE_KEY);
    else store.setItem(HOST_LAYOUT_MODE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

export type LayoutCapabilitySnapshot = {
  narrowViewport: boolean;
  finePointer: boolean;
  hover: boolean;
};

/** Capability detection — never user-agent. */
export function detectLayoutCapabilities(
  matchMedia: (query: string) => { matches: boolean } = globalThis.matchMedia?.bind(globalThis)
    ?? (() => ({ matches: false })),
): LayoutCapabilitySnapshot {
  return {
    narrowViewport: matchMedia(`(max-width: ${STACK_VIEWPORT_MAX_PX}px)`).matches,
    finePointer: matchMedia('(any-pointer: fine)').matches,
    hover: matchMedia('(hover: hover)').matches,
  };
}

/** Auto picks stacked when the viewport is narrow or pointer/hover is phone-like. */
export function prefersStackedCapabilities(caps: LayoutCapabilitySnapshot): boolean {
  return caps.narrowViewport || !caps.finePointer || !caps.hover;
}

export function effectiveLayoutMode(
  preference: LayoutModePreference,
  caps: LayoutCapabilitySnapshot = detectLayoutCapabilities(),
): EffectiveLayoutMode {
  if (preference === 'free') return 'free';
  if (preference === 'stacked') return 'stacked';
  return prefersStackedCapabilities(caps) ? 'stacked' : 'free';
}
