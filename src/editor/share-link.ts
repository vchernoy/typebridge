/**
 * Portable share links (#39): a document travels inside the link's `#doc=` fragment, so
 * nothing is uploaded and the fragment never reaches a server. The payload is versioned
 * (`1.` prefix), JSON, UTF-8, deflate-compressed and base64url-encoded.
 *
 * Only the title, the text, the document format and two presentation hints travel. Undo
 * history and settings stay local. Decoding treats every link as untrusted input: it enforces
 * size limits before and during decompression and validates the shape. A format this build
 * does not know is still decoded, so the reader can show its raw text (see #244).
 */

/** Format of the current payload, written as the fragment's prefix. */
export const SHARE_LINK_VERSION = 1;
/** Fragment parameter name: `#doc=1.…`. */
export const SHARE_FRAGMENT_KEY = 'doc';
/** Formats this build can render. Others are shown as raw text. */
export const KNOWN_SHARE_FORMATS = ['plain'] as const;
/** Longer links may be cut or refused by messengers, mail and social sites. */
export const SHARE_LINK_WARN_CHARS = 2_000;
/** Longest payload (base64url characters after `1.`) this build creates or accepts. */
export const SHARE_PAYLOAD_MAX_CHARS = 48_000;
/** Most UTF-8 bytes a payload may decompress to (guards against compression bombs). */
export const SHARE_DECOMPRESSED_MAX_BYTES = 2_000_000;
/** Same limit as the document title field. */
export const SHARE_TITLE_MAX = 150;

export type ShareView = 'source' | 'rendered';

/** What a share link carries. Presentation hints only: nothing here is access control. */
export type SharedDocument = {
  title: string;
  text: string;
  /** Document format, e.g. `plain`. Unknown formats are kept so the reader can explain them. */
  format: string;
  /** How the recipient's page first shows it. */
  view: ShareView;
  /** Whether the reading page offers Edit a copy. Hiding it does not protect the text. */
  edit: boolean;
};

export type DecodeFailure = 'missing' | 'version' | 'too-large' | 'malformed';
/** A link is only offered when this build can open it again: same limits as decoding. */
export type EncodedShare = { ok: true; payload: string } | { ok: false; reason: 'too-large' };
export type DecodedShare =
  | { ok: true; document: SharedDocument; knownFormat: boolean }
  | { ok: false; reason: DecodeFailure };

const FORMAT_PATTERN = /^[a-z0-9][a-z0-9+.-]{0,31}$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return undefined;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { return undefined; }
}

async function compress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decompress, stopping as soon as the output would exceed `maxBytes`. */
async function decompress(bytes: Uint8Array<ArrayBuffer>, maxBytes: number): Promise<Uint8Array | 'too-large' | undefined> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return 'too-large';
      }
      chunks.push(value);
    }
  } catch { return undefined; }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/**
 * The payload for `#doc=`: `1.` followed by base64url of the compressed JSON. Refused
 * (`too-large`) whenever decoding would refuse it: more than SHARE_DECOMPRESSED_MAX_BYTES of
 * JSON (very repetitive text compresses below the payload limit but still cannot be opened),
 * or a payload longer than SHARE_PAYLOAD_MAX_CHARS.
 */
export async function encodeSharePayload(document: SharedDocument): Promise<EncodedShare> {
  const json = JSON.stringify({
    title: document.title.slice(0, SHARE_TITLE_MAX),
    text: document.text,
    format: document.format,
    view: document.view,
    edit: document.edit,
  });
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > SHARE_DECOMPRESSED_MAX_BYTES) return { ok: false, reason: 'too-large' };
  const encoded = bytesToBase64Url(await compress(bytes));
  if (encoded.length > SHARE_PAYLOAD_MAX_CHARS) return { ok: false, reason: 'too-large' };
  return { ok: true, payload: `${SHARE_LINK_VERSION}.${encoded}` };
}

/** A full link to `base` (the site root) that opens `payload` as a shared document. */
export function shareUrl(base: string, payload: string): string {
  const url = new URL(base);
  url.hash = `${SHARE_FRAGMENT_KEY}=${payload}`;
  return url.toString();
}

/** The `#doc=` payload in a URL hash (`#doc=1.…`), or undefined when the hash is not a share link. */
export function sharePayloadFromHash(hash: string): string | undefined {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const prefix = `${SHARE_FRAGMENT_KEY}=`;
  return fragment.startsWith(prefix) ? fragment.slice(prefix.length) : undefined;
}

/** Whether a created link should carry a warning: `long` above SHARE_LINK_WARN_CHARS. */
export function shareLinkLength(url: string): 'ok' | 'long' {
  return url.length > SHARE_LINK_WARN_CHARS ? 'long' : 'ok';
}

/** Validate decoded JSON into a SharedDocument, or undefined when its shape is wrong. */
export function parseSharedDocument(value: unknown): SharedDocument | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== 'string' || typeof raw.text !== 'string') return undefined;
  const format = typeof raw.format === 'string' && FORMAT_PATTERN.test(raw.format) ? raw.format : undefined;
  if (!format) return undefined;
  return {
    title: raw.title.slice(0, SHARE_TITLE_MAX),
    text: raw.text,
    format,
    // Unknown or missing presentation hints fall back to the safe, plain defaults.
    view: raw.view === 'rendered' ? 'rendered' : 'source',
    edit: raw.edit !== false,
  };
}

/** Decode a `#doc=` payload. Never throws: every failure has a reason the page can explain. */
export async function decodeSharePayload(payload: string | undefined): Promise<DecodedShare> {
  if (!payload) return { ok: false, reason: 'missing' };
  const dot = payload.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  if (payload.slice(0, dot) !== String(SHARE_LINK_VERSION)) return { ok: false, reason: 'version' };
  const encoded = payload.slice(dot + 1);
  if (encoded.length > SHARE_PAYLOAD_MAX_CHARS) return { ok: false, reason: 'too-large' };
  const bytes = base64UrlToBytes(encoded);
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'malformed' };
  const inflated = await decompress(bytes, SHARE_DECOMPRESSED_MAX_BYTES);
  if (inflated === 'too-large') return { ok: false, reason: 'too-large' };
  if (!inflated) return { ok: false, reason: 'malformed' };
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inflated)); }
  catch { return { ok: false, reason: 'malformed' }; }
  const document = parseSharedDocument(json);
  if (!document) return { ok: false, reason: 'malformed' };
  return { ok: true, document, knownFormat: (KNOWN_SHARE_FORMATS as readonly string[]).includes(document.format) };
}
