import { afterEach, expect, it, vi } from 'vitest';
import { createEditAccess, type EditAccessDeps } from './edit-access';
import { createEditorState } from './editor-state';
import type { StatusLine } from '../ui/status-line';
import { getStoredDraft } from '../editor/indexeddb';
import { acquireEditOwnership } from '../editor/edit-ownership';

vi.mock('../editor/indexeddb', () => ({ getStoredDraft: vi.fn() }));
vi.mock('../editor/edit-ownership', () => ({ acquireEditOwnership: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(['session', 'document', 'public', 'saved'])('new/private ownership policy: %s', async mode => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('localStorage', { getItem: () => mode === 'session' ? 'off' : 'on' });
  const state = createEditorState(); state.db = {} as IDBDatabase;
  state.active = { ...state.active, id: 'doc', revision: mode === 'saved' ? 1 : 0, private: mode === 'document' || mode === 'saved' };
  vi.mocked(getStoredDraft).mockResolvedValue(mode === 'saved' ? state.active : undefined);
  vi.mocked(acquireEditOwnership).mockResolvedValue({ status: 'busy' });
  const access = createEditAccess(state, {} as StatusLine, {
    viewMode: false, instanceId: 'instance', webLocks: {} as LockManager,
  } as EditAccessDeps);
  const result = await access.acquireFor('doc');
  if (mode === 'session' || mode === 'document') {
    expect(result.block).toBe(''); expect(result.ownership).toBeUndefined();
    expect(acquireEditOwnership).not.toHaveBeenCalled();
  } else {
    expect(acquireEditOwnership).toHaveBeenCalledWith(expect.objectContaining({ deferClaim: mode === 'public' }));
  }
});
