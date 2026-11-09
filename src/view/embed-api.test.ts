import { afterEach, describe, expect, it } from 'vitest';
import { editorWindowApi, exposeEditorWindowApi, exposeHostPageApi, hostPageApi, testKnob } from './embed-api';

type FakeWindow = Record<string, unknown> & { parent?: FakeWindow };
const realWindow = (globalThis as { window?: unknown }).window;

function useWindow(win: FakeWindow): void {
  (globalThis as { window?: unknown }).window = win;
}

afterEach(() => { (globalThis as { window?: unknown }).window = realWindow; });

describe('embed-api', () => {
  it('has no host API in a top-level page and the parent in an embedded one', () => {
    const top: FakeWindow = {};
    top.parent = top;
    useWindow(top);
    expect(hostPageApi()).toBeUndefined();
    const host: FakeWindow = {};
    host.parent = host;
    useWindow({ parent: host });
    expect(hostPageApi()).toBe(host);
  });

  it('publishes calls under their contract names', () => {
    const win: FakeWindow = {};
    win.parent = win;
    useWindow(win);
    const open = (): void => {};
    exposeHostPageApi({ __typebridgeOpenSettings: open });
    exposeEditorWindowApi({ __typebridgeGetTitle: () => 'Имя' });
    expect(win.__typebridgeOpenSettings).toBe(open);
    expect(editorWindowApi(win as unknown as Window)?.__typebridgeGetTitle?.()).toBe('Имя');
    expect(editorWindowApi(null)).toBeUndefined();
  });

  it('reads test knobs only when a test set them', () => {
    const win: FakeWindow = {};
    useWindow(win);
    expect(testKnob('__typebridgeDelayAcquireMs')).toBeUndefined();
    win.__typebridgeDelayAcquireMs = 250;
    expect(testKnob('__typebridgeDelayAcquireMs')).toBe(250);
  });
});
