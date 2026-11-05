import { describe, expect, it } from 'vitest';
import type { Editor } from '../editor/editor';
import { newDraft } from '../editor/drafts';
import type { StoredDraft } from '../editor/indexeddb';
import {
  bumpSessionContent,
  bumpSessionIdentity,
  createBoundSession,
  createSessionRegistry,
  snapshotBoundSession,
} from './bound-session';
import { resolveSessionForDocument } from './session';

function fakeField(value = ''): HTMLTextAreaElement {
  return { value } as HTMLTextAreaElement;
}

function fakeTitle(value = ''): HTMLInputElement {
  return { value } as HTMLInputElement;
}

function fakeEditor(): Editor {
  return { exportHistory: () => ({ v: 1 as const, undo: [], redo: [], current: '' }) } as unknown as Editor;
}

const DOC_A = '11111111-1111-4111-8111-111111111111';
const DOC_B = '22222222-2222-4222-8222-222222222222';

describe('bound-session', () => {
  it('snapshots text, title and history from bound surfaces', () => {
    const field = fakeField('hello');
    const title = fakeTitle('Note');
    const session = createBoundSession({
      sessionId: 'session-1',
      editablePaneId: 'pane-a',
      draft: { ...newDraft(), id: DOC_A, revision: 1, text: 'stale', title: 'Old' } as StoredDraft,
      editor: fakeEditor(),
      field,
      title,
    });
    const snap = snapshotBoundSession(session, 'Untitled document');
    expect(snap.text).toBe('hello');
    expect(snap.title).toBe('Note');
    expect(snap.id).toBe(DOC_A);
  });

  it('registry reuses a session for an already-represented document', () => {
    const primary = createBoundSession({
      sessionId: 'session-1',
      editablePaneId: 'pane-a',
      draft: { ...newDraft(), id: DOC_A, revision: 1 } as StoredDraft,
      editor: fakeEditor(),
      field: fakeField(),
      title: fakeTitle(),
    });
    const registry = createSessionRegistry(primary);
    const secondary = createBoundSession({
      sessionId: 'session-2',
      editablePaneId: 'pane-b',
      draft: { ...newDraft(), id: DOC_B, revision: 1 } as StoredDraft,
      editor: fakeEditor(),
      field: fakeField(),
      title: fakeTitle(),
    });
    registry.setSecondary(secondary);
    expect(registry.byDocumentId(DOC_A)?.sessionId).toBe('session-1');
    expect(registry.byDocumentId(DOC_B)?.sessionId).toBe('session-2');
    expect(resolveSessionForDocument(DOC_B, registry.all().map(s => ({
      sessionId: s.sessionId,
      documentId: s.draft.id,
    })))).toBe('session-2');
    bumpSessionIdentity(primary);
    bumpSessionContent(secondary);
    expect(primary.sessionGeneration).toBe(1);
    expect(secondary.contentRevision).toBe(1);
  });
});
