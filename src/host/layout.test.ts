import { describe, expect, it } from 'vitest';
import {
  MAX_HOST_WINDOWS,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  bringToFront,
  clampRect,
  mintWindowId,
  parseHostLayout,
  snapRect,
  tileSideBySide,
  tileStacked,
  windowsOverlap,
} from './layout';

describe('host layout helpers', () => {
  const viewport = { width: 1000, height: 800 };

  it('clamps size and position inside the viewport', () => {
    expect(clampRect({ x: -40, y: 900, w: 100, h: 50 }, viewport)).toEqual({
      x: 0,
      y: 600,
      w: MIN_WINDOW_WIDTH,
      h: MIN_WINDOW_HEIGHT,
    });
  });

  it('tiles side by side and stacked', () => {
    const windows = [
      { id: 'main', x: 0, y: 0, w: 100, h: 100, z: 1 },
      { id: 'w2', x: 10, y: 10, w: 100, h: 100, z: 2 },
    ];
    const side = tileSideBySide(windows, viewport);
    expect(side[0]).toMatchObject({ x: 0, y: 0, w: 500, h: 800 });
    expect(side[1]).toMatchObject({ x: 500, y: 0, w: 500, h: 800 });
    expect(windowsOverlap(side)).toBe(false);

    const stacked = tileStacked(windows, viewport);
    expect(stacked[0]).toMatchObject({ x: 0, y: 0, w: 1000, h: 400 });
    expect(stacked[1]).toMatchObject({ x: 0, y: 400, w: 1000, h: 400 });
    expect(windowsOverlap(stacked)).toBe(false);
  });

  it('falls back to a non-overlapping grid when four side-by-side tiles cannot fit', () => {
    const windows = [1, 2, 3, 4].map(n => ({
      id: n === 1 ? 'main' : `w${n}`,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      z: n,
    }));
    const view = { width: 1024, height: 700 };
    const tiled = tileSideBySide(windows, view);
    expect(tiled).toHaveLength(4);
    expect(windowsOverlap(tiled)).toBe(false);
    expect(tiled.every(win => win.w >= MIN_WINDOW_WIDTH && win.h >= MIN_WINDOW_HEIGHT)).toBe(true);
    // 2×2 grid: two distinct x and two distinct y positions.
    expect(new Set(tiled.map(win => win.x)).size).toBe(2);
    expect(new Set(tiled.map(win => win.y)).size).toBe(2);
  });

  it('falls back to a non-overlapping grid for three windows in an 800px-wide host', () => {
    const windows = [1, 2, 3].map(n => ({
      id: n === 1 ? 'main' : `w${n}`,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      z: n,
    }));
    const view = { width: 800, height: 700 };
    // 3 × MIN_WINDOW_WIDTH = 840 > 800 → grid, not one row.
    const tiled = tileSideBySide(windows, view);
    expect(tiled).toHaveLength(3);
    expect(windowsOverlap(tiled)).toBe(false);
    expect(tiled.every(win => win.w >= MIN_WINDOW_WIDTH && win.h >= MIN_WINDOW_HEIGHT)).toBe(true);
  });

  it('snaps to a left half near the left edge', () => {
    const snapped = snapRect({ x: 8, y: 8, w: 480, h: 784 }, viewport);
    expect(snapped).toEqual({ x: 0, y: 0, w: 500, h: 800 });
  });

  it('brings a window to the front and mints ids up to the cap', () => {
    const raised = bringToFront([
      { id: 'main', x: 0, y: 0, w: 100, h: 100, z: 1 },
      { id: 'w2', x: 0, y: 0, w: 100, h: 100, z: 3 },
    ], 'main');
    expect(raised.find(w => w.id === 'main')?.z).toBe(4);
    expect(mintWindowId(['main'])).toBe('w2');
    expect(mintWindowId(['main', 'w2', 'w3', 'w4'])).toBe('w5');
    expect(MAX_HOST_WINDOWS).toBe(4);
  });

  it('parses persisted layout without accepting text payloads', () => {
    const parsed = parseHostLayout({
      version: 1,
      windows: [
        { id: 'main', x: 1, y: 2, w: 300, h: 220, z: 1, documentId: 'doc-1', text: 'secret' },
        { id: 'not valid!', x: 0, y: 0, w: 100, h: 100, z: 1 },
      ],
    });
    expect(parsed?.windows).toEqual([
      { id: 'main', x: 1, y: 2, w: 300, h: 220, z: 1, documentId: 'doc-1' },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });
});
