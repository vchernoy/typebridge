import { afterEach, expect, it, vi } from 'vitest';
import { renderDocument } from './active-renderer';

const { runtimeDestroy } = vi.hoisted(() => ({ runtimeDestroy: vi.fn() }));
vi.mock('@vchernoy/remark-active', () => ({ renderActive: () => ({ html: '<sanitized-math>', messages: [] }) }));
vi.mock('@vchernoy/active-runtime', () => ({ mount: () => ({ destroy: runtimeDestroy }) }));
vi.mock('katex', () => ({ default: {} }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('repeated rendered views disconnect observers, remove scroll listeners and destroy the runtime', () => {
  const resizeDisconnect = vi.fn(), mutationDisconnect = vi.fn();
  const resizeObserve = vi.fn(), mutationObserve = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    observe = resizeObserve;
    disconnect = resizeDisconnect;
  });
  vi.stubGlobal('MutationObserver', class {
    observe = mutationObserve;
    disconnect = mutationDisconnect;
  });
  for (let render = 1; render <= 2; render++) {
    const formula = Object.assign(new EventTarget(), {
      scrollLeft: 0, scrollWidth: 300, clientWidth: 100, toggleAttribute: vi.fn(),
    });
    const remove = vi.spyOn(formula, 'removeEventListener');
    const fonts = new EventTarget();
    const removeFonts = vi.spyOn(fonts, 'removeEventListener');
    const root = { innerHTML: '', ownerDocument: { fonts }, querySelectorAll: (selector: string) => selector === '.active-math-display' ? [formula] : [] } as unknown as HTMLElement;
    const view = renderDocument(root, 'source', 'en');
    expect(root.innerHTML).toBe('<sanitized-math>');
    expect(resizeObserve).toHaveBeenLastCalledWith(formula);
    expect(mutationObserve).toHaveBeenLastCalledWith(root, { childList: true, characterData: true, subtree: true });
    // Establish that the scroll handler is active before testing its removal.
    formula.toggleAttribute.mockClear();
    formula.scrollLeft = 200;
    formula.dispatchEvent(new Event('scroll'));
    expect(formula.toggleAttribute).toHaveBeenCalledWith('data-overflow-start', true);
    expect(formula.toggleAttribute).toHaveBeenCalledWith('data-overflow-end', false);
    view.destroy();
    expect(resizeDisconnect).toHaveBeenCalledTimes(render);
    expect(mutationDisconnect).toHaveBeenCalledTimes(render);
    expect(runtimeDestroy).toHaveBeenCalledTimes(render);
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(removeFonts).toHaveBeenCalledWith('loadingdone', expect.any(Function));
    // A detached old formula must no longer receive updates from scroll events.
    formula.toggleAttribute.mockClear();
    formula.scrollLeft = 0;
    formula.dispatchEvent(new Event('scroll'));
    expect(formula.toggleAttribute).not.toHaveBeenCalled();
    fonts.dispatchEvent(new Event('loadingdone'));
    expect(formula.toggleAttribute).not.toHaveBeenCalled();
  }
});

it('coalesces changed formulas per frame, refreshes all on fonts and cancels on destroy', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  const cancel = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal('cancelAnimationFrame', cancel);
  let mutate!: MutationCallback;
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: MutationCallback) { mutate = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const makeMath = () => {
    const measure = vi.fn(() => ({ top: 0, bottom: 40 }));
    const write = vi.fn();
    const fence = { localName: 'mo', getAttribute: (key: string) => key === 'fence' ? 'true' : '40px', hasAttribute: () => false, setAttribute: write };
    const row = { children: [fence, { localName: 'mfrac', getBoundingClientRect: measure }], querySelector: () => ({}) };
    const math = { nodeType: 1, closest: (selector: string) => selector === 'math' ? math : null, querySelectorAll: (selector: string) => selector === 'math mrow' ? [row] : [] };
    return { math, measure, write };
  };
  const first = makeMath(), second = makeMath();
  const fonts = new EventTarget();
  const root = { innerHTML: '', ownerDocument: { fonts }, nodeType: 1,
    contains: () => true, closest: () => null,
    querySelectorAll: (selector: string) => selector === 'math' ? [first.math, second.math] : [],
  } as unknown as HTMLElement;
  const view = renderDocument(root, 'source', 'en');
  const change = () => mutate([{ target: first.math } as unknown as MutationRecord], {} as MutationObserver);
  change(); change(); change();
  expect(frames.size).toBe(1);
  expect(first.measure).not.toHaveBeenCalled();
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); };
  flush();
  expect(first.measure).toHaveBeenCalledTimes(1);
  expect(second.measure).not.toHaveBeenCalled();
  expect(first.write).not.toHaveBeenCalled(); // unchanged size produces no DOM write
  fonts.dispatchEvent(new Event('loadingdone'));
  flush();
  expect(first.measure).toHaveBeenCalledTimes(2);
  expect(second.measure).toHaveBeenCalledTimes(1);
  change();
  view.destroy();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(0);
  fonts.dispatchEvent(new Event('loadingdone'));
  expect(frames.size).toBe(0);
});
