import { describe, expect, it } from 'vitest';
import { DATA_SLOT, decodeDocument, encodeDocument, exportStandalone } from './document';
const doc = { title: 'Unicode 🖥️', text: 'café 日本語 </script><script>globalThis.pwned=1</script> $&', format: 'markdown' as const };
describe('standalone document data', () => {
  it('round trips arbitrary text through an inert base64 slot without markup or replacement expansion', () => {
    const encoded = encodeDocument(doc);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/); expect(decodeDocument(encoded)).toEqual(doc);
    const html = exportStandalone('before' + DATA_SLOT + 'after', doc);
    expect(html).not.toContain(doc.text); expect(html).toBe(`before<script id="standalone-data" type="application/octet-stream">${encoded}</script>after`);
  });
  it('requires exactly one slot and leaves the reusable template untouched', () => {
    const template = 'before' + DATA_SLOT + 'after';
    expect(exportStandalone(template, doc)).not.toBe(exportStandalone(template, { ...doc, text: 'Different' }));
    expect(template).toContain(DATA_SLOT);
    expect(() => exportStandalone('no slot', doc)).toThrow();
    expect(() => exportStandalone(DATA_SLOT + DATA_SLOT, doc)).toThrow();
  });
  it('rejects invalid, oversized and non-UTF8 payloads before rendering', () => {
    expect(() => encodeDocument({ ...doc, title: 'a'.repeat(151) })).toThrow();
    expect(() => encodeDocument({ ...doc, text: 'a'.repeat(2_000_001) })).toThrow();
    expect(() => decodeDocument('a'.repeat(2_666_669))).toThrow();
    expect(() => decodeDocument('/w==')).toThrow();
    expect(() => decodeDocument(btoa('{"title":"x","text":"x","format":"html"}'))).toThrow();
  });
});
