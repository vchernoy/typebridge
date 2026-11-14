import type { SharedDocument, ShareView } from '../editor/share-link';
/** Unknown formats and plain links retain the source fallback, regardless of presentation hints. */
export function readingView(shared: Pick<SharedDocument, 'format' | 'view'>): ShareView {
  return shared.format === 'markdown' && shared.view === 'rendered' ? 'rendered' : 'source';
}
