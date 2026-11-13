import { describe, expect, it, vi } from 'vitest';
import type { StoredDraft } from '../editor/indexeddb';
import { applyRestoredPendingWritable, chooseBootDocument } from './boot';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_NEW = '33333333-3333-4333-8333-333333333333';
const doc = (id: string, over: Partial<StoredDraft> = {}): StoredDraft => ({ id, title: 'T', text: 'x', updatedAt: 1, revision: 1, ...over } as StoredDraft);
const placeholder = doc('placeholder', { revision: 0 });
const fresh = (): StoredDraft => doc('fresh', { revision: 0, text: '', title: 'Untitled document 2' });
const base = { drafts: [doc(ID_A), doc(ID_B)], selected: null, pending: undefined, secondaryHostWindow: false, allocateNew: fresh, fallback: placeholder };

describe('chooseBootDocument', () => {
  it('opens the remembered document, else the newest saved one, else the placeholder', () => {
    expect(chooseBootDocument({ ...base, selected: ID_B }).chosen.id).toBe(ID_B);
    expect(chooseBootDocument(base).chosen.id).toBe(ID_A);
    expect(chooseBootDocument({ ...base, drafts: [] }).chosen).toBe(placeholder);
  });

  it('restores a reload backup that differs from its saved row', () => {
    const pending = doc(ID_B, { text: 'unsaved', updatedAt: 5 });
    const choice = chooseBootDocument({ ...base, selected: ID_A, pending });
    expect(choice).toEqual({ chosen: pending, restorePending: true, clearPendingCopy: false });
    // A backup of a never-saved document is restored too.
    expect(chooseBootDocument({ ...base, pending: doc(ID_NEW, { revision: 0 }) }).restorePending).toBe(true);
  });

  it('drops a backup that matches its saved row and opens normally', () => {
    const choice = chooseBootDocument({ ...base, selected: ID_B, pending: doc(ID_A, { updatedAt: 9 }) });
    expect(choice).toEqual({ chosen: base.drafts[1], restorePending: false, clearPendingCopy: true });
  });

  it('starts a secondary host window on a fresh document instead of the newest one', () => {
    expect(chooseBootDocument({ ...base, secondaryHostWindow: true }).chosen.id).toBe('fresh');
    // A remembered never-saved id keeps that id for the fresh document.
    expect(chooseBootDocument({ ...base, secondaryHostWindow: true, selected: ID_NEW }).chosen.id).toBe(ID_NEW);
    // A remembered saved document still wins.
    expect(chooseBootDocument({ ...base, secondaryHostWindow: true, selected: ID_B }).chosen.id).toBe(ID_B);
  });
});

describe('applyRestoredPendingWritable (#263)', () => {
  it('refreshes the writable cache after bumping content revision', () => {
    const order: string[] = [];
    const revision = { value: 0 };
    const workspace = {
      setDirty: (dirty: boolean) => { order.push(`dirty:${dirty}`); },
      bumpContentRevision: () => {
        revision.value += 1;
        order.push(`bump:${revision.value}`);
        return revision.value;
      },
    };
    const noteWritableSnapshot = vi.fn(() => { order.push(`note:${revision.value}`); });
    applyRestoredPendingWritable(workspace, noteWritableSnapshot);
    expect(order).toEqual(['dirty:true', 'bump:1', 'note:1']);
    expect(noteWritableSnapshot).toHaveBeenCalledTimes(1);
  });
});
