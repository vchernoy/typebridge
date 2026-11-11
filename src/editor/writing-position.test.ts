import { afterEach, expect, it, vi } from 'vitest';
import { POSITION_PREFIX, POSITION_SAVE_DELAY_MS, setupWritingPosition } from './writing-position';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup(namespace = 'window:') {
  vi.useFakeTimers();
  const field = Object.assign(new EventTarget(), {
    selectionStart: 1, selectionEnd: 3, selectionDirection: 'backward',
    scrollTop: 40, scrollLeft: 0, value: 'abcdef',
    setSelectionRange: vi.fn(),
  }) as unknown as HTMLTextAreaElement;
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const stored = new Map<string, string>();
  const setItem = vi.fn((key: string, value: string) => { stored.set(key, value); });
  const removeItem = vi.fn((key: string) => { stored.delete(key); });
  const getItem = vi.fn<() => string | null>(() => null);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('sessionStorage', { setItem, getItem, removeItem, get length() { return stored.size; }, key: (index: number) => [...stored.keys()][index] ?? null });
  let id = 'first';
  const api = setupWritingPosition(field, () => id, namespace);
  return { field, win, doc, setItem, getItem, removeItem, stored, frames, api, switchId: (next: string) => { id = next; } };
}

it('batches a burst and writes only the latest position after inactivity', () => {
  const { field, setItem } = setup();
  field.dispatchEvent(new Event('input'));
  vi.advanceTimersByTime(200);
  field.selectionStart = 2;
  field.dispatchEvent(new Event('select'));
  vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS - 1);
  expect(setItem).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(setItem).toHaveBeenCalledExactlyOnceWith(POSITION_PREFIX + 'window:first', JSON.stringify({
    start: 2, end: 3, direction: 'backward', scrollTop: 40, scrollLeft: 0,
  }));
});

it('flushes the outgoing document immediately and cancels its timer before restore', () => {
  const { field, setItem, api, switchId } = setup();
  field.dispatchEvent(new Event('select'));
  api.save();
  switchId('second');
  api.restore('second');
  vi.advanceTimersByTime(1000);
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(setItem.mock.calls[0]![0]).toBe(POSITION_PREFIX + 'window:first');
});

it.each(['pagehide', 'hidden'])('flushes the current position on %s without waiting', event => {
  const { field, win, doc, setItem } = setup();
  field.dispatchEvent(new Event('scroll'));
  field.scrollTop = 90;
  if (event === 'hidden') { doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); }
  else win.dispatchEvent(new Event(event));
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(setItem.mock.calls[0]![1]).scrollTop).toBe(90);
  vi.advanceTimersByTime(1000);
  expect(setItem).toHaveBeenCalledTimes(1);
});

it('restore flushes the captured outgoing position without recapturing the incoming field', () => {
  const { field, api, setItem, switchId, stored } = setup();
  field.dispatchEvent(new Event('select'));
  switchId('second');
  field.selectionStart = field.selectionEnd = 5;
  api.restore('second');
  expect(JSON.parse(stored.get(POSITION_PREFIX + 'window:first')!)).toMatchObject({ start: 1, end: 3 });
  expect(stored.has(POSITION_PREFIX + 'window:second')).toBe(false);
  vi.advanceTimersByTime(1000);
  expect(setItem).toHaveBeenCalledTimes(1);
});

it('a failed outgoing flush does not prevent restoration or later saves', () => {
  const { field, api, getItem, setItem, frames, switchId } = setup();
  field.dispatchEvent(new Event('select'));
  switchId('second');
  getItem.mockReturnValue(JSON.stringify({ start: 2, end: 4, direction: 'forward', scrollTop: 10, scrollLeft: 0 }));
  setItem.mockImplementationOnce(() => { throw new Error('quota'); });
  expect(() => api.restore('second')).not.toThrow();
  expect(field.setSelectionRange).toHaveBeenLastCalledWith(2, 4, 'forward');
  frames.shift()!(0);
  frames.shift()!(16);
  api.save();
  expect(setItem).toHaveBeenCalledTimes(2);
});

it('beforeunload no longer writes position metadata; pagehide still flushes it', () => {
  const { field, win, setItem } = setup();
  field.dispatchEvent(new Event('select'));
  win.dispatchEvent(new Event('beforeunload'));
  expect(setItem).not.toHaveBeenCalled();
  win.dispatchEvent(new Event('pagehide'));
  expect(setItem).toHaveBeenCalledTimes(1);
});


it('reapplies after layout and ignores restore-generated selection/scroll writes', () => {
  const { field, api, getItem, setItem, frames } = setup();
  getItem.mockReturnValue(JSON.stringify({ start: 1, end: 3, direction: 'backward', scrollTop: 90, scrollLeft: 0 }));
  api.restore('first');
  field.scrollTop = 0; // An intermediate layout clamps the initial scroll.
  field.dispatchEvent(new Event('scroll'));
  field.dispatchEvent(new Event('select'));
  api.save(); // Leaving during restore must not persist that intermediate clamp.
  expect(setItem).not.toHaveBeenCalled();
  frames.shift()!(0);
  expect(field.scrollTop).toBe(90);
  field.dispatchEvent(new Event('scroll'));
  frames.shift()!(16);
  vi.advanceTimersByTime(1000);
  expect(setItem).not.toHaveBeenCalled();
});

it('user input cancels deferred restoration and saves the user position', () => {
  const { field, api, getItem, setItem, frames } = setup();
  getItem.mockReturnValue(JSON.stringify({ start: 1, end: 3, direction: 'backward', scrollTop: 90, scrollLeft: 0 }));
  api.restore('first');
  field.dispatchEvent(new Event('keydown'));
  field.scrollTop = 20;
  field.selectionStart = field.selectionEnd = 4;
  field.dispatchEvent(new Event('input'));
  frames.shift()!(0);
  expect(field.scrollTop).toBe(20);
  vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS);
  expect(JSON.parse(setItem.mock.calls[0]![1])).toMatchObject({ start: 4, end: 4, scrollTop: 20 });
});


it('does not overwrite a selection remapped programmatically after restore (#235)', () => {
  const { field, api, getItem, frames } = setup();
  getItem.mockReturnValue(JSON.stringify({ start: 1, end: 3, direction: 'backward', scrollTop: 90, scrollLeft: 0 }));
  api.restore('first');
  expect(field.setSelectionRange).toHaveBeenCalledTimes(1);
  // Ownership handoff maps the old offsets to the newly loaded document after showDraft.
  field.setSelectionRange(4, 6, 'forward');
  frames.shift()!(0);
  frames.shift()!(16);
  expect(field.setSelectionRange).toHaveBeenCalledTimes(2);
  expect(field.setSelectionRange).toHaveBeenLastCalledWith(4, 6, 'forward');
});


it('removes a deleted document and prevents timer, input and lifecycle writes from recreating it', () => {
  const { field, api, stored, setItem, win } = setup();
  stored.set(POSITION_PREFIX + 'window:first', '{}');
  field.dispatchEvent(new Event('select'));
  api.remove('first');
  vi.advanceTimersByTime(1000);
  field.dispatchEvent(new Event('input'));
  win.dispatchEvent(new Event('pagehide'));
  expect(stored.has(POSITION_PREFIX + 'window:first')).toBe(false);
  expect(setItem).not.toHaveBeenCalled();
});

it('prunes only its own obsolete keys, keeping saved and current private positions', () => {
  const { api, stored, removeItem } = setup();
  const own = POSITION_PREFIX + 'window:';
  for (const key of [own + 'first', own + 'saved', own + 'stale', own + 'view:stale',
    POSITION_PREFIX + 'w:other.stale', 'typebridge.pendingDraft.v1']) stored.set(key, '{}');
  api.prune(['saved']);
  expect(removeItem).toHaveBeenCalledExactlyOnceWith(own + 'stale');
  expect(stored.has(own + 'first')).toBe(true);
  expect(stored.has(own + 'saved')).toBe(true);
});

it('a removed document does not block later documents, and cleanup storage errors are optional', () => {
  const { api, removeItem, switchId, stored } = setup();
  removeItem.mockImplementationOnce(() => { throw new Error('blocked'); });
  expect(() => api.remove('first')).not.toThrow();
  switchId('second');
  api.save();
  expect(stored.has(POSITION_PREFIX + 'window:second')).toBe(true);
});


it('unscoped pruning cannot reach embedded or viewer namespaces', () => {
  const { api, stored, removeItem } = setup('');
  for (const key of [POSITION_PREFIX + 'obsolete', POSITION_PREFIX + 'view:obsolete',
    POSITION_PREFIX + 'w:main.obsolete', POSITION_PREFIX + 'w:main.view:obsolete']) stored.set(key, '{}');
  api.prune([]);
  expect(removeItem).toHaveBeenCalledExactlyOnceWith(POSITION_PREFIX + 'obsolete');
});


it('pruning does not suppress position saving when a temporarily absent document returns', () => {
  const { api, stored, switchId } = setup();
  const key = POSITION_PREFIX + 'window:returning';
  stored.set(key, '{}');
  api.prune([]);
  expect(stored.has(key)).toBe(false);
  // Delete saved copy can remove a row temporarily without changing its document id.
  api.prune(['returning']);
  switchId('returning');
  api.restore('returning');
  api.save();
  expect(stored.has(key)).toBe(true);
});
