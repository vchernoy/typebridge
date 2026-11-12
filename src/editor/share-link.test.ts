import { describe, expect, it } from 'vitest';
import {
  SHARE_DECOMPRESSED_MAX_BYTES,
  SHARE_LINK_WARN_CHARS,
  SHARE_PAYLOAD_MAX_CHARS,
  decodeSharePayload,
  encodeSharePayload,
  parseSharedDocument,
  shareLinkLength,
  sharePayloadFromHash,
  shareUrl,
  type SharedDocument,
} from './share-link';

/** Encode, failing the test if the document is refused. */
async function encodeSharePayloadOk(document: SharedDocument): Promise<string> {
  const result = await encodeSharePayload(document);
  if (!result.ok) throw new Error('refused: ' + result.reason);
  return result.payload;
}

const doc = (text: string, extra: Partial<SharedDocument> = {}): SharedDocument => ({
  title: 'Письмо', text, format: 'plain', view: 'source', edit: true, ...extra,
});

/** A payload whose JSON is `json`, encoded the same way the app does. */
async function payloadOf(json: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return '1.' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('share link round trip', () => {
  it('keeps Cyrillic, emoji, combining marks, tabs and newlines exactly', async () => {
    for (const text of ['', 'Привет, мир!', 'Ёлка 🙂👩‍💻 é', 'line 1\nline 2\r\n\tindented', 'a'.repeat(10_000)]) {
      const result = await decodeSharePayload(await encodeSharePayloadOk(doc(text)));
      expect(result).toEqual({ ok: true, document: doc(text), knownFormat: true });
    }
  });

  it('keeps the view and edit hints', async () => {
    const shared = doc('Текст', { view: 'rendered', edit: false });
    expect(await decodeSharePayload(await encodeSharePayloadOk(shared))).toEqual({ ok: true, document: shared, knownFormat: true });
  });

  it('uses only URL-safe characters after the version prefix', async () => {
    const payload = await encodeSharePayloadOk(doc('Привет 🙂 '.repeat(200)));
    expect(payload).toMatch(/^1\.[A-Za-z0-9_-]+$/);
  });

  it('compresses repetitive text well below its size', async () => {
    const text = 'Строка текста для проверки. '.repeat(500);
    const payload = await encodeSharePayloadOk(doc(text));
    expect(payload.length).toBeLessThan(text.length / 10);
  });

  it('builds and reads back a #doc= link on the site root', async () => {
    const payload = await encodeSharePayloadOk(doc('Привет'));
    const url = shareUrl('https://typebridge.vchernoy.xyz/', payload);
    expect(url).toBe(`https://typebridge.vchernoy.xyz/#doc=${payload}`);
    expect(sharePayloadFromHash(new URL(url).hash)).toBe(payload);
    expect(sharePayloadFromHash('#other=1')).toBeUndefined();
    expect(sharePayloadFromHash('')).toBeUndefined();
  });
});

describe('untrusted links', () => {
  it('explains a missing, unknown-version or malformed payload instead of throwing', async () => {
    expect(await decodeSharePayload(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(await decodeSharePayload('')).toEqual({ ok: false, reason: 'missing' });
    expect(await decodeSharePayload('2.AAAA')).toEqual({ ok: false, reason: 'version' });
    for (const bad of ['1', '1.', '.abc', '1.@@@@', '1.A', '1.AAAAAAAA', '1.ZZZZ']) {
      expect(await decodeSharePayload(bad), bad).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('rejects JSON that is not a shared document', async () => {
    for (const json of ['null', '[]', '"text"', '{}', '{"title":"t"}', '{"title":1,"text":"x","format":"plain"}',
      '{"title":"t","text":"x","format":"<script>"}', '{"title":"t","text":"x"}']) {
      expect(await decodeSharePayload(await payloadOf(json)), json).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(await decodeSharePayload(await payloadOf('not json'))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a payload that is too long before decompressing it', async () => {
    expect(await decodeSharePayload('1.' + 'A'.repeat(SHARE_PAYLOAD_MAX_CHARS + 4))).toEqual({ ok: false, reason: 'too-large' });
  });

  it('stops a compression bomb at the decompressed size limit', async () => {
    const bomb = await payloadOf(JSON.stringify({ title: 't', text: 'a'.repeat(SHARE_DECOMPRESSED_MAX_BYTES * 2), format: 'plain' }));
    expect(bomb.length).toBeLessThan(SHARE_PAYLOAD_MAX_CHARS);
    expect(await decodeSharePayload(bomb)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('keeps an unknown future format so the page can show raw text', async () => {
    const result = await decodeSharePayload(await payloadOf(JSON.stringify({ title: 't', text: '# Заголовок', format: 'markdown+calc' })));
    expect(result).toEqual({ ok: true, knownFormat: false, document: { title: 't', text: '# Заголовок', format: 'markdown+calc', view: 'source', edit: true } });
  });
});

describe('parseSharedDocument', () => {
  it('falls back to safe hints and the title length limit', () => {
    expect(parseSharedDocument({ title: 'T'.repeat(200), text: 'x', format: 'plain', view: 'weird', edit: 'no' }))
      .toEqual({ title: 'T'.repeat(150), text: 'x', format: 'plain', view: 'source', edit: true });
    expect(parseSharedDocument({ title: 't', text: 'x', format: 'plain', edit: false })?.edit).toBe(false);
  });
});

describe('shareLinkLength', () => {
  it('warns above the messenger-friendly length', () => {
    expect(shareLinkLength('https://x/#doc=1.abc')).toBe('ok');
    expect(shareLinkLength('https://x/#doc=' + 'a'.repeat(SHARE_LINK_WARN_CHARS))).toBe('long');
  });
});

describe('encoding refuses what decoding would refuse', () => {
  it('refuses very repetitive text that compresses small but is too large to open (#245 review)', async () => {
    const text = 'a'.repeat(SHARE_DECOMPRESSED_MAX_BYTES);
    expect(await encodeSharePayload(doc(text))).toEqual({ ok: false, reason: 'too-large' });
  });
  it('refuses text that does not compress below the payload limit', async () => {
    // Random code points barely compress.
    let text = '';
    let seed = 1;
    while (text.length < SHARE_PAYLOAD_MAX_CHARS) { seed = (seed * 48271) % 2147483647; text += String.fromCharCode(0x4e00 + (seed % 20000)); }
    expect(await encodeSharePayload(doc(text))).toEqual({ ok: false, reason: 'too-large' });
  });
  it('refuses a format name that decoding would reject (#245 review)', async () => {
    expect(await encodeSharePayload(doc('x', { format: '<script>' }))).toEqual({ ok: false, reason: 'format' });
    expect(await encodeSharePayload(doc('x', { format: '' }))).toEqual({ ok: false, reason: 'format' });
  });
  it('accepts the largest document that still opens', async () => {
    const text = 'Строка. '.repeat(50_000); // about 700 KB of UTF-8, very compressible
    const result = await encodeSharePayload(doc(text));
    expect(result.ok).toBe(true);
    if (result.ok) expect((await decodeSharePayload(result.payload)).ok).toBe(true);
  });
});
