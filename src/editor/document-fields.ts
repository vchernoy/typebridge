/** The four content fields share one durable snapshot and change sequence (#257 step 2a). */
export const DOCUMENT_FIELDS = ['text', 'title', 'find', 'replace'] as const;
export type DocumentField = typeof DOCUMENT_FIELDS[number];
export type DocumentFields = Record<DocumentField, string>;
/** Rows predating step 2a have no search content. No migration is needed. */
export type DocumentFieldsInput = Pick<DocumentFields, 'text' | 'title'> & Partial<Pick<DocumentFields, 'find' | 'replace'>>;

export function documentFields(row: DocumentFieldsInput): DocumentFields {
  return { text: row.text, title: row.title, find: row.find ?? '', replace: row.replace ?? '' };
}

export function sameFields(a: DocumentFieldsInput, b: DocumentFieldsInput): boolean {
  const left = documentFields(a);
  const right = documentFields(b);
  return DOCUMENT_FIELDS.every(field => left[field] === right[field]);
}
