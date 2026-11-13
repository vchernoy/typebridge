import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorState } from './editor-state';
import { createTakeover } from './takeover';
import type { Workspace } from './workspace';

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeWorkspace(dirty = false): Workspace {
  let isDirty = dirty;
  return {
    sessionId: 'session-1' as const,
    paneId: 'pane-a' as const,
    sessionGeneration: () => 1,
    contentRevision: () => 1,
    paneGeneration: () => 0,
    bumpSessionGeneration: () => 1,
    bumpContentRevision: () => 1,
    documentId: () => 'doc',
    setDocumentId: () => undefined,
    dirty: () => isDirty,
    setDirty: value => { isDirty = value; },
    setPaneRole: () => undefined,
    activePaneId: () => 'pane-a' as const,
    setActivePane: () => undefined,
    captureCommandGeneration: () => ({
      sessionId: 'session-1' as const,
      paneId: 'pane-a' as const,
      paneGeneration: 0,
      sessionGeneration: 1,
    }),
    capturePersistGeneration: () => ({ sessionId: 'session-1' as const, sessionGeneration: 1 }),
    snapshotSession: () => ({}) as never,
    snapshotPane: () => ({}) as never,
    syncDom: () => undefined,
  };
}

function harness(options: { documentPrivate?: boolean; sessionOn?: boolean; dirty?: boolean } = {}) {
  const state = createEditorState();
  state.active = {
    id: 'doc',
    title: 'T',
    text: 'saved',
    updatedAt: 1,
    revision: 2,
    private: options.documentPrivate === true,
  };
  state.db = {} as IDBDatabase;
  if (options.sessionOn) {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'typebridge.autosave.v1' ? 'off' : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  }

  const field = {
    value: 'on screen',
    setSelectionRange: vi.fn(),
  } as unknown as HTMLTextAreaElement;
  const draftTitle = { value: 'T', title: '' } as HTMLInputElement;
  const autosave = { checked: true, disabled: false } as HTMLInputElement;
  const privateMarker = { hidden: true } as HTMLElement;
  const workspace = makeWorkspace(options.dirty === true);
  const saveSoon = vi.fn();
  const updateSaveIndicator = vi.fn();
  const editor = {
    exportHistory: () => undefined,
    restoreHistory: vi.fn(),
  };

  const takeover = createTakeover(state, {
    viewMode: false,
    field,
    draftTitle,
    editor: editor as never,
    workspace,
    autosave,
    privateMarker,
    writingPosition: { save: () => undefined },
    editHereBar: { hidden: true } as HTMLElement,
    editHereWarning: { textContent: '' } as HTMLElement,
    editAccess: {
      acquireFor: async () => ({
        ownership: {
          documentId: 'doc',
          writeFence: async () => ({ instanceId: 'i', fence: 1 }),
          release: async () => undefined,
        },
        generation: 1,
        block: '',
      } as never),
      installOwnership: () => undefined,
      freezeEditorsForTransition: () => undefined,
      unfreezeEditorsAfterTransition: () => undefined,
    },
    focusHandoff: () => undefined,
    showDraft: () => undefined,
    syncTitleTooltip: () => undefined,
    updateSaveIndicator,
    saveSoon,
    onEditableHere: () => undefined,
    rereadDisplayed: async () => undefined,
    markDeletedElsewhere: () => undefined,
  });

  return { state, takeover, autosave, privateMarker, field, saveSoon, workspace };
}

describe('handoff privacy flag (#257 P1)', () => {
  it('captureHandoffSnapshot carries the document private flag, not dirty alone', () => {
    const { takeover } = harness({ documentPrivate: false, dirty: true });
    expect(takeover.captureHandoffSnapshot()).toEqual(expect.objectContaining({
      dirty: true,
      private: false,
      text: 'on screen',
    }));

    const privateDoc = harness({ documentPrivate: true, dirty: false });
    expect(privateDoc.takeover.captureHandoffSnapshot()).toEqual(expect.objectContaining({
      dirty: false,
      private: true,
    }));
  });

  it('dirty snapshot under private session does not invent document private', async () => {
    const { state, takeover, autosave, privateMarker, saveSoon } = harness({
      documentPrivate: false,
      sessionOn: true,
    });
    // Receiver starts non-private; session is on so chrome Autosave is off.
    autosave.checked = false;
    privateMarker.hidden = false;

    const ok = await takeover.takeOverFromHandoff({
      documentId: 'doc',
      snapshot: {
        text: 'session dirty',
        title: 'T',
        dirty: true,
        private: false,
        revision: 2,
      },
      selectionStart: 0,
      selectionEnd: 0,
      fromText: 'saved',
      steal: false,
    });

    expect(ok).toBe(true);
    expect(state.active.private).toBe(false);
    expect(state.active.text).toBe('session dirty');
    // Session still on → checkbox stays off without lasting document private.
    expect(autosave.checked).toBe(false);
    expect(privateMarker.hidden).toBe(false);
    expect(saveSoon).not.toHaveBeenCalled();
  });

  it('document-private dirty snapshot keeps private: true', async () => {
    const { state, takeover, autosave } = harness({ documentPrivate: false });
    autosave.checked = true;

    const ok = await takeover.takeOverFromHandoff({
      documentId: 'doc',
      snapshot: {
        text: 'doc private',
        title: 'T',
        dirty: true,
        private: true,
        revision: 2,
      },
      selectionStart: 0,
      selectionEnd: 0,
      fromText: 'saved',
      steal: false,
    });

    expect(ok).toBe(true);
    expect(state.active.private).toBe(true);
    expect(autosave.checked).toBe(false);
  });
});
