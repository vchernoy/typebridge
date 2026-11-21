/** Internal proof-of-concept payload; not a new share-link or persistence schema. */
export type StandaloneDocument = { title: string; text: string; format: 'plain' | 'markdown' };
export const DATA_SLOT = '<script id="standalone-data" type="application/octet-stream">TYPEBRIDGE_STANDALONE_DATA_V1</script>';
const LIMIT = 2_000_000;

export function encodeDocument(value: StandaloneDocument): string {
  if (typeof value.title !== 'string' || value.title.length > 150 || typeof value.text !== 'string'
    || (value.format !== 'plain' && value.format !== 'markdown')) throw new Error('Invalid document');
  const bytes = new TextEncoder().encode(JSON.stringify({ title: value.title, text: value.text, format: value.format }));
  if (bytes.length > LIMIT) throw new Error('Document exceeds 2 MB');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeDocument(encoded: string): StandaloneDocument {
  if (encoded.length > Math.ceil(LIMIT / 3) * 4) throw new Error('Document exceeds 2 MB');
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length > LIMIT) throw new Error('Document exceeds 2 MB');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object') throw new Error('Invalid document');
  const data = value as Record<string, unknown>;
  if (typeof data.title !== 'string' || data.title.length > 150 || typeof data.text !== 'string'
    || (data.format !== 'plain' && data.format !== 'markdown')) throw new Error('Invalid document');
  return { title: data.title, text: data.text, format: data.format };
}

export function exportStandalone(template: string, value: StandaloneDocument): string {
  if (template.split(DATA_SLOT).length !== 2) throw new Error('Invalid viewer template');
  // Only base64 enters HTML; arbitrary source never becomes executable markup.
  const data = `<script id="standalone-data" type="application/octet-stream">${encodeDocument(value)}</script>`;
  return template.replace(DATA_SLOT, () => data);
}
