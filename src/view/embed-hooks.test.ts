import { afterEach, describe, expect, it } from 'vitest';
import { installEmbedHooks, type EmbedHooksDeps } from './embed-hooks';
import type { EditorWindowApi } from './embed-api';
import { PREFS_EVENT } from './prefs-sync';

type FakeWindow = Partial<EditorWindowApi> & { dispatchEvent: (event: Event) => boolean };
const realWindow = (globalThis as { window?: unknown }).window;
afterEach(() => { (globalThis as { window?: unknown }).window = realWindow; });

function install(): { win: FakeWindow; events: CustomEvent[]; calls: string[] } {
  const events: CustomEvent[] = [];
  const calls: string[] = [];
  const win: FakeWindow = { dispatchEvent: event => { events.push(event as CustomEvent); return true; } };
  (globalThis as { window?: unknown }).window = win;
  const note = (name: string) => () => { calls.push(name); };
  const deps: EmbedHooksDeps = {
    prefsOrigin: 'window:w1',
    leaveGuards: {
      prepareUpdateReload: async () => true,
      assertSafeToReloadAfterUpdate: note('assert'),
      cancelUpdateReload: note('cancel'),
      prepareWindowClose: async () => true,
      commitWindowClose: note('commit'),
      cancelWindowClose: note('cancelClose'),
    },
    setFocusMode: note('focus'),
    getTitle: () => 'Имя',
    setTitle: note('setTitle'),
    commitTitle: () => null,
    applyTitleEdit: () => null,
    toggleTransliteration: note('toggle'),
    openFind: note('find'),
  };
  installEmbedHooks(deps);
  return { win, events, calls };
}

describe('installEmbedHooks', () => {
  it('publishes every host call and routes it', () => {
    const { win, calls } = install();
    expect(win.__typebridgeGetTitle?.()).toBe('Имя');
    win.__typebridgeCancelUpdateReload?.();
    win.__typebridgeCommitWindowClose?.();
    win.__typebridgeCancelWindowClose?.();
    win.__typebridgeToggleTransliteration?.();
    win.__typebridgeOpenFind?.();
    win.__typebridgeSetFocusMode?.(true);
    expect(calls).toEqual(['cancel', 'commit', 'cancelClose', 'toggle', 'find', 'focus']);
    for (const name of ['__typebridgePrepareUpdateReload', '__typebridgeAssertSafeUpdateReload', '__typebridgePrepareWindowClose',
      '__typebridgeSetTitle', '__typebridgeTitleCommit', '__typebridgeTitleEdit', '__typebridgeCancelWindowClose'] as const) {
      expect(typeof win[name]).toBe('function');
    }
  });

  it('re-dispatches host prefs in this window, except its own broadcasts', () => {
    const { win, events } = install();
    win.__typebridgeApplyPrefs?.('appearance', 'window:w1');
    expect(events).toHaveLength(0);
    win.__typebridgeApplyPrefs?.('appearance', 'window:w2');
    win.__typebridgeApplyPrefs?.('reset');
    expect(events.map(event => [event.type, event.detail])).toEqual([
      [PREFS_EVENT, { name: 'appearance', origin: 'window:w2' }],
      [PREFS_EVENT, { name: 'reset', origin: undefined }],
    ]);
  });
});
