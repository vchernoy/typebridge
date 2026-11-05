/**
 * Pure layout helpers for #175 step 5 free windows.
 * Positions/sizes/document ids only — never document text.
 */

export const HOST_WINDOWS_KEY = 'typebridge.host.windows.v1';
export const MAX_HOST_WINDOWS = 4;
export const MIN_WINDOW_WIDTH = 280;
export const MIN_WINDOW_HEIGHT = 200;
/** Snap threshold in CSS pixels from a viewport edge or center line. */
export const SNAP_THRESHOLD_PX = 24;
export const KEYBOARD_MOVE_STEP_PX = 16;

export type WindowRect = { x: number; y: number; w: number; h: number };

export type HostWindowLayout = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Last known document id for this window (never text). */
  documentId?: string;
};

export type HostLayoutState = {
  version: 1;
  windows: HostWindowLayout[];
  /** #175 step 6: which window Focus mode maximizes (never text). */
  focusWindowId?: string;
};

export type ViewportSize = { width: number; height: number };

export function isHostWindowId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(value);
}

export function defaultRectForIndex(index: number, viewport: ViewportSize): WindowRect {
  const inset = 16 + index * 28;
  const w = Math.max(MIN_WINDOW_WIDTH, Math.min(640, viewport.width - inset * 2));
  const h = Math.max(MIN_WINDOW_HEIGHT, Math.min(480, viewport.height - inset * 2));
  return {
    x: Math.min(inset, Math.max(0, viewport.width - w)),
    y: Math.min(inset, Math.max(0, viewport.height - h)),
    w,
    h,
  };
}

export function clampRect(rect: WindowRect, viewport: ViewportSize): WindowRect {
  const w = Math.max(MIN_WINDOW_WIDTH, Math.min(rect.w, viewport.width));
  const h = Math.max(MIN_WINDOW_HEIGHT, Math.min(rect.h, viewport.height));
  const maxX = Math.max(0, viewport.width - w);
  const maxY = Math.max(0, viewport.height - h);
  return {
    x: Math.max(0, Math.min(rect.x, maxX)),
    y: Math.max(0, Math.min(rect.y, maxY)),
    w,
    h,
  };
}

/**
 * Clamp a resize against the space available from the anchored opposite edge(s).
 * Avoids clampRect moving x/y to 0 when an east/south resize hits the viewport.
 */
export function clampResizeRect(
  rect: WindowRect,
  viewport: ViewportSize,
  edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
  start: WindowRect,
): WindowRect {
  let { x, y, w, h } = rect;
  const rightEdge = start.x + start.w;
  const bottomEdge = start.y + start.h;

  if (edges.right && !edges.left) {
    x = start.x;
    w = Math.max(MIN_WINDOW_WIDTH, Math.min(w, viewport.width - start.x));
  } else if (edges.left && !edges.right) {
    x = Math.max(0, Math.min(x, rightEdge - MIN_WINDOW_WIDTH));
    w = rightEdge - x;
  } else if (edges.left && edges.right) {
    x = Math.max(0, x);
    w = Math.max(MIN_WINDOW_WIDTH, Math.min(w, viewport.width - x));
  } else {
    w = Math.max(MIN_WINDOW_WIDTH, Math.min(w, viewport.width));
    x = Math.max(0, Math.min(x, viewport.width - w));
  }

  if (edges.bottom && !edges.top) {
    y = start.y;
    h = Math.max(MIN_WINDOW_HEIGHT, Math.min(h, viewport.height - start.y));
  } else if (edges.top && !edges.bottom) {
    y = Math.max(0, Math.min(y, bottomEdge - MIN_WINDOW_HEIGHT));
    h = bottomEdge - y;
  } else if (edges.top && edges.bottom) {
    y = Math.max(0, y);
    h = Math.max(MIN_WINDOW_HEIGHT, Math.min(h, viewport.height - y));
  } else {
    h = Math.max(MIN_WINDOW_HEIGHT, Math.min(h, viewport.height));
    y = Math.max(0, Math.min(y, viewport.height - h));
  }

  return { x, y, w, h };
}

/** Pointer must travel this far before a full-bleed window restores on drag. */
export const MOVE_RESTORE_THRESHOLD_PX = 4;

/** True when the window fills the viewport (nothing left to move into). */
export function isFullscreenRect(rect: WindowRect, viewport: ViewportSize): boolean {
  return rect.x <= 0 && rect.y <= 0
    && rect.w >= viewport.width
    && rect.h >= viewport.height;
}

/**
 * Desktop-style restore: a full-bleed window becomes a movable default size.
 * When `pointer` is given (host-root coordinates), centre the restored window on it.
 */
export function restoreForMove(
  rect: WindowRect,
  viewport: ViewportSize,
  pointer?: { x: number; y: number },
): WindowRect {
  if (!isFullscreenRect(rect, viewport)) return rect;
  const base = defaultRectForIndex(0, viewport);
  if (!pointer) return clampRect(base, viewport);
  return clampRect({
    ...base,
    x: pointer.x - base.w / 2,
    y: pointer.y - base.h / 2,
  }, viewport);
}

export function bringToFront(windows: HostWindowLayout[], id: string): HostWindowLayout[] {
  const maxZ = windows.reduce((m, win) => Math.max(m, win.z), 0);
  return windows.map(win => (win.id === id ? { ...win, z: maxZ + 1 } : win));
}

/** Cascade with a visible offset when even a grid cannot fit every minimum size. */
export function cascadeWindows(windows: HostWindowLayout[], viewport: ViewportSize): HostWindowLayout[] {
  const offset = 28;
  return windows.map((win, index) => {
    const x = Math.min(index * offset, Math.max(0, viewport.width - MIN_WINDOW_WIDTH));
    const y = Math.min(index * offset, Math.max(0, viewport.height - MIN_WINDOW_HEIGHT));
    return {
      ...win,
      ...clampRect({
        x,
        y,
        w: Math.max(MIN_WINDOW_WIDTH, Math.min(640, viewport.width - x)),
        h: Math.max(MIN_WINDOW_HEIGHT, Math.min(480, viewport.height - y)),
      }, viewport),
    };
  });
}

/** Non-overlapping grid (e.g. 2×2 for four). Falls back to cascade when mins cannot fit. */
export function tileGrid(windows: HostWindowLayout[], viewport: ViewportSize): HostWindowLayout[] {
  if (windows.length === 0) return [];
  const count = windows.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  if (cols * MIN_WINDOW_WIDTH > viewport.width || rows * MIN_WINDOW_HEIGHT > viewport.height) {
    return cascadeWindows(windows, viewport);
  }
  const cellW = Math.floor(viewport.width / cols);
  const cellH = Math.floor(viewport.height / rows);
  return windows.map((win, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = col * cellW;
    const y = row * cellH;
    const w = col === cols - 1 ? viewport.width - x : cellW;
    const h = row === rows - 1 ? viewport.height - y : cellH;
    return { ...win, ...clampRect({ x, y, w, h }, viewport) };
  });
}

function rectanglesOverlap(a: WindowRect, b: WindowRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** True when any pair of windows shares interior area (used by tests). */
export function windowsOverlap(windows: HostWindowLayout[]): boolean {
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      if (rectanglesOverlap(windows[i], windows[j])) return true;
    }
  }
  return false;
}

export function tileSideBySide(windows: HostWindowLayout[], viewport: ViewportSize): HostWindowLayout[] {
  if (windows.length === 0) return [];
  const count = windows.length;
  if (count * MIN_WINDOW_WIDTH > viewport.width) return tileGrid(windows, viewport);
  const w = Math.max(MIN_WINDOW_WIDTH, Math.floor(viewport.width / count));
  return windows.map((_, index) => clampRect({
    x: index * w,
    y: 0,
    w: index === count - 1 ? viewport.width - index * w : w,
    h: viewport.height,
  }, viewport)).map((rect, index) => ({ ...windows[index], ...rect }));
}

export function tileStacked(windows: HostWindowLayout[], viewport: ViewportSize): HostWindowLayout[] {
  if (windows.length === 0) return [];
  const count = windows.length;
  if (count * MIN_WINDOW_HEIGHT > viewport.height) return tileGrid(windows, viewport);
  const h = Math.max(MIN_WINDOW_HEIGHT, Math.floor(viewport.height / count));
  return windows.map((_, index) => clampRect({
    x: 0,
    y: index * h,
    w: viewport.width,
    h: index === count - 1 ? viewport.height - index * h : h,
  }, viewport)).map((rect, index) => ({ ...windows[index], ...rect }));
}

/**
 * Phone stack: full-width scrolling list. Each window keeps its own height
 * (at least MIN_WINDOW_HEIGHT; not capped to the viewport). Later windows are
 * pushed down — the host scrolls when the stack exceeds the viewport.
 */
export function stackPhoneWindows(
  windows: HostWindowLayout[],
  viewport: ViewportSize,
  heights?: number[],
): HostWindowLayout[] {
  if (windows.length === 0) return [];
  const width = Math.max(MIN_WINDOW_WIDTH, Math.floor(viewport.width));
  const defaultHeight = Math.max(
    MIN_WINDOW_HEIGHT,
    Math.min(420, Math.max(MIN_WINDOW_HEIGHT, Math.floor(viewport.height * 0.55) || MIN_WINDOW_HEIGHT)),
  );
  let y = 0;
  return windows.map((win, index) => {
    const requested = heights?.[index] ?? (win.h >= MIN_WINDOW_HEIGHT ? win.h : defaultHeight);
    const h = Math.max(MIN_WINDOW_HEIGHT, Math.floor(requested));
    const next = { ...win, x: 0, y, w: width, h };
    y += h;
    return next;
  });
}

/**
 * Snap a free-moving window to halves/quarters when close to edges or center.
 * Returns the same rect when no snap applies.
 */
export function snapRect(rect: WindowRect, viewport: ViewportSize, threshold = SNAP_THRESHOLD_PX): WindowRect {
  const halfW = viewport.width / 2;
  const halfH = viewport.height / 2;
  let { x, y } = rect;
  const { w, h } = rect;

  const nearLeft = Math.abs(x) <= threshold;
  const nearRight = Math.abs(x + w - viewport.width) <= threshold;
  const nearTop = Math.abs(y) <= threshold;
  const nearBottom = Math.abs(y + h - viewport.height) <= threshold;
  const nearCenterX = Math.abs(x + w / 2 - halfW) <= threshold;
  const nearCenterY = Math.abs(y + h / 2 - halfH) <= threshold;

  // Full viewport when all edges are near.
  if (nearLeft && nearRight && nearTop && nearBottom) {
    return clampRect({ x: 0, y: 0, w: viewport.width, h: viewport.height }, viewport);
  }
  // Halves
  if (nearLeft && nearTop && nearBottom && w >= halfW - threshold) {
    return clampRect({ x: 0, y: 0, w: halfW, h: viewport.height }, viewport);
  }
  if (nearRight && nearTop && nearBottom && w >= halfW - threshold) {
    return clampRect({ x: halfW, y: 0, w: halfW, h: viewport.height }, viewport);
  }
  if (nearTop && nearLeft && nearRight && h >= halfH - threshold) {
    return clampRect({ x: 0, y: 0, w: viewport.width, h: halfH }, viewport);
  }
  if (nearBottom && nearLeft && nearRight && h >= halfH - threshold) {
    return clampRect({ x: 0, y: halfH, w: viewport.width, h: halfH }, viewport);
  }
  // Quarters
  if (nearLeft && nearTop) {
    return clampRect({ x: 0, y: 0, w: halfW, h: halfH }, viewport);
  }
  if (nearRight && nearTop) {
    return clampRect({ x: halfW, y: 0, w: halfW, h: halfH }, viewport);
  }
  if (nearLeft && nearBottom) {
    return clampRect({ x: 0, y: halfH, w: halfW, h: halfH }, viewport);
  }
  if (nearRight && nearBottom) {
    return clampRect({ x: halfW, y: halfH, w: halfW, h: halfH }, viewport);
  }
  // Soft center snap for free placement.
  if (nearCenterX) x = halfW - w / 2;
  if (nearCenterY) y = halfH - h / 2;
  return clampRect({ x, y, w, h }, viewport);
}

export function parseHostLayout(raw: unknown): HostLayoutState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as { version?: unknown; windows?: unknown };
  if (record.version !== 1 || !Array.isArray(record.windows)) return undefined;
  const windows: HostWindowLayout[] = [];
  for (const entry of record.windows) {
    if (!entry || typeof entry !== 'object') continue;
    const win = entry as Record<string, unknown>;
    if (typeof win.id !== 'string' || !isHostWindowId(win.id)) continue;
    if (![win.x, win.y, win.w, win.h, win.z].every(n => typeof n === 'number' && Number.isFinite(n))) {
      continue;
    }
    const documentId = typeof win.documentId === 'string' && win.documentId ? win.documentId : undefined;
    windows.push({
      id: win.id,
      x: win.x as number,
      y: win.y as number,
      w: win.w as number,
      h: win.h as number,
      z: win.z as number,
      documentId,
    });
    if (windows.length >= MAX_HOST_WINDOWS) break;
  }
  if (windows.length === 0) return undefined;
  const focusWindowId = typeof (record as { focusWindowId?: unknown }).focusWindowId === 'string'
    && isHostWindowId((record as { focusWindowId: string }).focusWindowId)
    && windows.some(win => win.id === (record as { focusWindowId: string }).focusWindowId)
    ? (record as { focusWindowId: string }).focusWindowId
    : undefined;
  return { version: 1, windows, ...(focusWindowId ? { focusWindowId } : {}) };
}

/** Resolve localStorage without throwing when the getter itself is blocked. */
function defaultStorage(): Storage | undefined {
  try { return localStorage; } catch { return undefined; }
}

export function readHostLayout(storage?: Storage): HostLayoutState | undefined {
  const store = storage ?? defaultStorage();
  if (!store) return undefined;
  try {
    return parseHostLayout(JSON.parse(store.getItem(HOST_WINDOWS_KEY) ?? 'null'));
  } catch {
    return undefined;
  }
}

/** Persist layout. Never writes document text. Returns false when storage rejects the write. */
export function writeHostLayout(state: HostLayoutState, storage?: Storage): boolean {
  const store = storage ?? defaultStorage();
  if (!store) return false;
  try {
    const payload: HostLayoutState = {
      version: 1,
      windows: state.windows.slice(0, MAX_HOST_WINDOWS).map(win => ({
        id: win.id,
        x: win.x,
        y: win.y,
        w: win.w,
        h: win.h,
        z: win.z,
        ...(win.documentId ? { documentId: win.documentId } : {}),
      })),
      ...(state.focusWindowId && state.windows.some(win => win.id === state.focusWindowId)
        ? { focusWindowId: state.focusWindowId }
        : {}),
    };
    store.setItem(HOST_WINDOWS_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function mintWindowId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has('main')) return 'main';
  for (let i = 2; i <= MAX_HOST_WINDOWS + 8; i++) {
    const id = `w${i}`;
    if (!taken.has(id)) return id;
  }
  return `w${Date.now().toString(36)}`;
}
