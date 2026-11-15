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
    const root = { innerHTML: '', querySelectorAll: () => [formula] } as unknown as HTMLElement;
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
    // A detached old formula must no longer receive updates from scroll events.
    formula.toggleAttribute.mockClear();
    formula.scrollLeft = 0;
    formula.dispatchEvent(new Event('scroll'));
    expect(formula.toggleAttribute).not.toHaveBeenCalled();
  }
});
