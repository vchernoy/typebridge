import { afterEach, expect, it, vi } from 'vitest';
import { POSITION_PREFIX, POSITION_SAVE_DELAY_MS, setupWritingPosition } from './writing-position';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup() {
  vi.useFakeTimers();
  const field = Object.assign(new EventTarget(), {
    selectionStart: 1, selectionEnd: 3, selectionDirection: 'backward',
    scrollTop: 40, scrollLeft: 0, value: 'abcdef',
    setSelectionRange: vi.fn(),
  }) as unknown as HTMLTextAreaElement;
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const setItem = vi.fn();
  const getItem = vi.fn<() => string | null>(() => null);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('sessionStorage', { setItem, getItem });
  let id = 'first';
  const api = setupWritingPosition(field, () => id, 'window:');
  return { field, win, doc, setItem, getItem, frames, api, switchId: (next: string) => { id = next; } };
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

it.each(['pagehide', 'beforeunload', 'hidden'])('flushes the current position on %s without waiting', event => {
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

it('restoration cancels a pending write and storage failure leaves later flushes usable', () => {
  const { field, api, setItem } = setup();
  field.dispatchEvent(new Event('select'));
  api.restore('first');
  vi.advanceTimersByTime(1000);
  expect(setItem).not.toHaveBeenCalled();
  setItem.mockImplementationOnce(() => { throw new Error('quota'); });
  expect(() => api.save()).not.toThrow();
  api.save();
  expect(setItem).toHaveBeenCalledTimes(2);
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
