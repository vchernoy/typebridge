import { describe, expect, it } from 'vitest';
import type { Editor } from '../editor/editor';
import { newDraft } from '../editor/drafts';
import type { StoredDraft } from '../editor/indexeddb';
import {
  bumpSessionContent,
  bumpSessionIdentity,
  createBoundSession,
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

  it('bumps identity and content counters independently', () => {
    const session = createBoundSession({
      sessionId: 'session-1',
      editablePaneId: 'pane-a',
      draft: { ...newDraft(), id: DOC_A, revision: 1 } as StoredDraft,
      editor: fakeEditor(),
      field: fakeField(),
      title: fakeTitle(),
    });
    bumpSessionIdentity(session);
    bumpSessionContent(session);
    expect(session.sessionGeneration).toBe(1);
    expect(session.contentRevision).toBe(1);
    expect(resolveSessionForDocument(DOC_A, [
      { sessionId: session.sessionId, documentId: session.draft.id },
      { sessionId: 'session-2', documentId: DOC_B },
    ])).toBe('session-1');
  });
});
