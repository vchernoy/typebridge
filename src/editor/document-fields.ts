/** The content fields (including format) share one durable snapshot and change sequence (#257 step 2a). */
export const DOCUMENT_FIELDS = ['text', 'title', 'find', 'replace', 'format'] as const;
export type DocumentField = typeof DOCUMENT_FIELDS[number];
export type DocumentFields = Record<Exclude<DocumentField, 'format'>, string> & { format: DocumentFormat };
/** Old rows have no search content or format; missing format means plain. No migration is needed. */
export type DocumentFieldsInput = Pick<DocumentFields, 'text' | 'title'> & Partial<Pick<DocumentFields, 'find' | 'replace'>> & { format?: string };

export function documentFields(row: DocumentFieldsInput): DocumentFields {
  return { text: row.text, title: row.title, find: row.find ?? '', replace: row.replace ?? '', format: documentFormat(row) };
}

export function sameFields(a: DocumentFieldsInput, b: DocumentFieldsInput): boolean {
  const left = documentFields(a);
  const right = documentFields(b);
  return DOCUMENT_FIELDS.every(field => left[field] === right[field]);
}

export type DocumentFormat = 'plain' | 'markdown';
export function documentFormat(row: { format?: string }): DocumentFormat {
  return row.format === 'markdown' ? 'markdown' : 'plain';
}
