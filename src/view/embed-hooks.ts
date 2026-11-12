/**
 * This editor window's side of the host↔window contract (view/embed-api.ts): what the host page
 * calls on an embedded window. The calls only route to the modules that do the work.
 */
import type { PrefName } from './prefs-sync';
import { PREFS_EVENT } from './prefs-sync';
import { exposeEditorWindowApi, type EditorWindowApi } from './embed-api';
import type { TitleEditResult } from '../ui/title-edits';

export type EmbedHooksDeps = {
  /** This window's prefs origin (`window:<id>`); its own broadcasts are not re-applied. */
  prefsOrigin: string;
  leaveGuards: {
    prepareUpdateReload: () => Promise<boolean>;
    assertSafeToReloadAfterUpdate: () => void;
    commitUpdateReload: () => void | Promise<void>;
    cancelUpdateReload: () => void;
    prepareWindowClose: () => Promise<boolean>;
    commitWindowClose: () => void | Promise<void>;
    cancelWindowClose: () => void;
  };
  setFocusMode: (enabled: boolean) => void;
  getTitle: () => string;
  setTitle: (title: string) => void;
  commitTitle: (value: string, start?: number, end?: number) => TitleEditResult | null;
  applyTitleEdit: EditorWindowApi['__typebridgeTitleEdit'];
  toggleTransliteration: () => void;
  openFind: () => void;
};

export function installEmbedHooks(deps: EmbedHooksDeps): void {
  const { leaveGuards } = deps;
  exposeEditorWindowApi({
    __typebridgePrepareUpdateReload: leaveGuards.prepareUpdateReload,
    __typebridgeAssertSafeUpdateReload: leaveGuards.assertSafeToReloadAfterUpdate,
    __typebridgeCommitUpdateReload: () => leaveGuards.commitUpdateReload(),
    __typebridgeCancelUpdateReload: () => { leaveGuards.cancelUpdateReload(); },
    __typebridgePrepareWindowClose: leaveGuards.prepareWindowClose,
    __typebridgeCommitWindowClose: leaveGuards.commitWindowClose,
    __typebridgeCancelWindowClose: () => { leaveGuards.cancelWindowClose(); },
    __typebridgeSetFocusMode: deps.setFocusMode,
    __typebridgeApplyPrefs: (name: PrefName, origin?: string) => {
      if (origin && origin === deps.prefsOrigin) return;
      // Re-dispatch in this window with iframe-local primitives so every module
      // listener runs (rules, appearance, …). Avoid host-realm detail objects.
      window.dispatchEvent(new CustomEvent(PREFS_EVENT, {
        detail: {
          name: String(name) as PrefName,
          origin: origin !== undefined ? String(origin) : undefined,
        },
      }));
    },
    __typebridgeGetTitle: deps.getTitle,
    __typebridgeSetTitle: deps.setTitle,
    __typebridgeToggleTransliteration: deps.toggleTransliteration,
    __typebridgeOpenFind: deps.openFind,
    __typebridgeTitleCommit: deps.commitTitle,
    __typebridgeTitleEdit: deps.applyTitleEdit,
  });
}
