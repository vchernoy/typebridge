/**
 * #175 cutover: a tab that ran the single editor at `/` before the cutover reloads into the
 * host. Its session state (open document, unsaved reload backup, caret positions, Replace
 * text) is unscoped; host windows read keys scoped by window id. Move it into the window
 * that will show first, so the reload restores what that tab had. Pure: takes the storage.
 */
import { ACTIVE_DRAFT_KEY_BASE } from '../editor/drafts';
import { REPLACE_KEY } from '../editor/search-settings';
import { POSITION_PREFIX } from '../editor/writing-position';
import { scopeSessionKey, writingPositionNamespace } from '../view/window-id';

const PENDING_KEY_BASE = 'typebridge.pendingDraft.v1';
const PLAIN_KEYS = [ACTIVE_DRAFT_KEY_BASE, PENDING_KEY_BASE, REPLACE_KEY];

/** Moves unscoped single-editor keys to `windowId`; never overwrites the window's own keys. */
export function migrateStandaloneSession(storage: Storage, windowId: string): number {
  const moves: Array<[from: string, to: string]> = [];
  for (const key of PLAIN_KEYS) moves.push([key, scopeSessionKey(key, windowId)]);
  const windowPrefix = POSITION_PREFIX + writingPositionNamespace(windowId);
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(POSITION_PREFIX)) continue;
    const rest = key.slice(POSITION_PREFIX.length);
    // Already window-scoped (`w:<id>.`) or a comparison viewer's (`view:`) offsets.
    if (rest.startsWith('w:') || rest.startsWith('view:')) continue;
    moves.push([key, windowPrefix + rest]);
  }
  let moved = 0;
  for (const [from, to] of moves) {
    const value = storage.getItem(from);
    if (value === null) continue;
    if (storage.getItem(to) === null) {
      storage.setItem(to, value);
      moved += 1;
    }
    storage.removeItem(from);
  }
  return moved;
}
