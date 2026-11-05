import { describe, expect, it } from 'vitest';
import {
  detectLayoutCapabilities,
  effectiveLayoutMode,
  layoutModePreference,
  prefersStackedCapabilities,
  readLayoutModePreference,
  writeLayoutModePreference,
  HOST_LAYOUT_MODE_KEY,
} from './layout-mode';

describe('layout mode preference', () => {
  it('defaults unknown values to auto', () => {
    expect(layoutModePreference(null)).toBe('auto');
    expect(layoutModePreference('weird')).toBe('auto');
    expect(layoutModePreference('stacked')).toBe('stacked');
  });

  it('reads and writes preference without storing auto', () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    } as Storage;
    expect(readLayoutModePreference(storage)).toBe('auto');
    expect(writeLayoutModePreference('free', storage)).toBe(true);
    expect(storage.getItem(HOST_LAYOUT_MODE_KEY)).toBe('free');
    expect(writeLayoutModePreference('auto', storage)).toBe(true);
    expect(storage.getItem(HOST_LAYOUT_MODE_KEY)).toBeNull();
  });

  it('defaults to localStorage when storage is omitted', () => {
    const map = new Map<string, string>();
    const fake = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    } as Storage;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake });
    try {
      expect(writeLayoutModePreference('stacked')).toBe(true);
      expect(readLayoutModePreference()).toBe('stacked');
      expect(writeLayoutModePreference('auto')).toBe(true);
      expect(fake.getItem(HOST_LAYOUT_MODE_KEY)).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

describe('effective layout mode', () => {
  it('honours explicit free and stacked', () => {
    const phone = { narrowViewport: true, finePointer: false, hover: false };
    const desktop = { narrowViewport: false, finePointer: true, hover: true };
    expect(effectiveLayoutMode('free', phone)).toBe('free');
    expect(effectiveLayoutMode('stacked', desktop)).toBe('stacked');
  });

  it('Auto stacks on narrow or coarse/no-hover pointers', () => {
    expect(prefersStackedCapabilities({ narrowViewport: true, finePointer: true, hover: true })).toBe(true);
    expect(prefersStackedCapabilities({ narrowViewport: false, finePointer: false, hover: true })).toBe(true);
    expect(prefersStackedCapabilities({ narrowViewport: false, finePointer: true, hover: false })).toBe(true);
    expect(prefersStackedCapabilities({ narrowViewport: false, finePointer: true, hover: true })).toBe(false);
    expect(effectiveLayoutMode('auto', { narrowViewport: false, finePointer: true, hover: true })).toBe('free');
    expect(effectiveLayoutMode('auto', { narrowViewport: true, finePointer: true, hover: true })).toBe('stacked');
  });

  it('detectLayoutCapabilities uses matchMedia queries', () => {
    const seen: string[] = [];
    const caps = detectLayoutCapabilities(query => {
      seen.push(query);
      return { matches: query.includes('max-width') };
    });
    expect(caps.narrowViewport).toBe(true);
    expect(caps.finePointer).toBe(false);
    expect(caps.hover).toBe(false);
    expect(seen.some(q => q.includes('any-pointer'))).toBe(true);
    expect(seen.some(q => q.includes('hover'))).toBe(true);
  });
});
