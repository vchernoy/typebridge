import { UNTITLED_TITLE } from './drafts';
import { documentFormat, type DocumentFormat } from './document-fields';
import type { SharedDocument } from './share-link';

export type SharedCopyFields = { title: string; text: string; format: DocumentFormat };

/** Exactly the fields the reader imports; presentation hints and reader values are excluded. */
export function sharedCopyFields(shared: Pick<SharedDocument, 'title' | 'text' | 'format'>): SharedCopyFields {
  return { title: shared.title.trim() || UNTITLED_TITLE, text: shared.text, format: documentFormat(shared) };
}

export function sameSharedCopy(candidate: { title: string; text: string; format?: string }, fields: SharedCopyFields): boolean {
  return candidate.title === fields.title && candidate.text === fields.text && documentFormat(candidate) === fields.format;
}
