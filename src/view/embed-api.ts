/**
 * The host page (`/`) and each editor window (`/editor.html` in an iframe) are same-origin
 * documents that call each other through functions on their `window` objects. This module
 * is the one typed list of those calls, plus the test-only knobs, so reviewers can see the
 * whole contract in one place. Property names are part of the contract (e2e tests use some),
 * so keep them stable.
 */
import type { FocusHandoffHooks } from './handoff';
import type { PrefName } from './prefs-sync';

/** A title edit result: the new value and caret/selection in it. */
export type TitleEditResult = { value: string; start: number; end: number };

/** One title-bar keystroke routed through the window's title Editor (transliteration, undo). */
export type TitleEditPayload = { inputType: string; data: string | null; start: number; end: number };

/** What each editor window exposes; the host calls these on `frame.contentWindow`. */
export type EditorWindowApi = {
  /** Update reload: ask (with dialogs in this window) whether reloading is safe. */
  __typebridgePrepareUpdateReload: () => Promise<boolean>;
  /** Update reload: validate and arm it; throws to abort. Does not navigate. */
  __typebridgeAssertSafeUpdateReload: () => void;
  /** After every window asserted: freeze editors before awaited discard/navigation (#254). */
  __typebridgeFreezeForUpdateReload: () => void;
  /** After every window asserted: run deferred discard cleanup before navigation. */
  __typebridgeCommitUpdateReload: () => void | Promise<void>;
  __typebridgeCancelUpdateReload: () => void;
  /** Host asks before removing this window's iframe (#175 step 5). */
  __typebridgePrepareWindowClose: () => Promise<boolean>;
  /** Host calls this immediately before removing the iframe once close was allowed. */
  __typebridgeCommitWindowClose: () => void | Promise<void>;
  /** Host prepared close then aborted (e.g. last-window race); thaw a discard freeze. */
  __typebridgeCancelWindowClose: () => void;
  __typebridgeSetFocusMode: (enabled: boolean) => void;
  /** Host Settings asks every window to apply a shared preference (#175 step 7). */
  __typebridgeApplyPrefs: (name: PrefName, origin?: string) => void;
  /** Title-bar rename write-through (#175 step 8). */
  __typebridgeSetTitle: (title: string) => void;
  __typebridgeGetTitle: () => string;
  /** Title-bar beforeinput, run through the window's title Editor. */
  __typebridgeTitleEdit: (payload: TitleEditPayload) => TitleEditResult | null;
  /** Title-bar IME/delete commit, recorded as one undoable title edit. */
  __typebridgeTitleCommit: (value: string, start?: number, end?: number) => TitleEditResult | null;
  __typebridgeToggleTransliteration: () => void;
  /** Title-bar Ctrl/⌘+F opens this window's Find (#175 step 9). */
  __typebridgeOpenFind: () => void;
  /** The title bar was clicked or typed into: move editing to this window. */
  __typebridgeRequestEdit: () => void;
  /** Hold a title-bar edit made while editing moves here; false when nothing is pending. */
  __typebridgeBufferTitleEdit: (op: { inputType: string; data: string | null }, start: number, end: number) => boolean;
};

/** What the host page exposes; editor windows call these on `window.parent`. */
export type HostPageApi = {
  /** A window entered or left Focus mode; the host maximizes or restores it (#175 step 6). */
  __typebridgeHostFocusMode: (enabled: boolean, sourceWindowId?: string) => void;
  /** Documents → Rename… in a window: rename in that window's title bar. */
  __typebridgeHostRename: (windowId: string) => void;
  /** Document ids open in other windows (for the picker's "open elsewhere" mark). */
  __typebridgeOpenDocumentIds: (exceptWindowId?: string) => string[];
  /** Titles open in other windows (for distinct Untitled defaults). */
  __typebridgeOpenTitles: (exceptWindowId?: string) => string[];
  /** Open the host Settings panel, optionally focusing a control by id. */
  __typebridgeOpenSettings: (opts?: { focus?: string; returnFocus?: HTMLElement | null }) => void;
  /** Close the host Settings panel if open (Escape layering); true when it closed. */
  __typebridgeTryCloseSettings: () => boolean;
  /** Read-only probes of the window layout (used by e2e). */
  __typebridgeHostWindows: () => unknown[];
  __typebridgeHostLayoutMode: () => string;
};

/**
 * Test-only knobs: e2e sets these to widen timing windows. They are read, never written, by
 * the app and default to off. CI tests the same build Pages deploys, so they ship too.
 */
export type TestKnobs = {
  __typebridgeDelayAcquireMs: number;
  /** Hold each change-log write (#37 R2c), so a save waits for it. */
  __typebridgeDelayChangeAppendMs: number;
  __typebridgeDelayAfterAcquireMs: number;
  __typebridgeDelayPersistMs: number;
  /** Hold a save after `upToForSave` so e2e can type while the run is anchored (#254). */
  __typebridgeDelayAfterUpToMs: number;
  __typebridgeDelayRefreshMs: number;
  __typebridgeIgnoreHandoffRequests: boolean;
};

export type EditorWindow = Window & Partial<EditorWindowApi> & FocusHandoffHooks;
export type HostWindow = Window & Partial<HostPageApi>;

/** The calls an editor window exposes (none when the frame has no window yet). */
export function editorWindowApi(win: Window | null | undefined): EditorWindow | undefined {
  return (win ?? undefined) as EditorWindow | undefined;
}

/** The host page's calls, from inside an embedded editor window (undefined when top-level). */
export function hostPageApi(): HostWindow | undefined {
  return window.parent === window ? undefined : (window.parent as HostWindow);
}

/** Publish this editor window's calls for the host. */
export function exposeEditorWindowApi(api: Partial<EditorWindowApi>): void {
  Object.assign(window, api);
}

/** Publish the host page's calls for its editor windows. */
export function exposeHostPageApi(api: Partial<HostPageApi>): void {
  Object.assign(window, api);
}

/** Read a test-only knob on this window (undefined unless a test set it). */
export function testKnob<K extends keyof TestKnobs>(name: K): TestKnobs[K] | undefined {
  return (window as unknown as Partial<TestKnobs>)[name];
}
