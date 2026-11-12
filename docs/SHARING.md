# Share links

Status: the **link format** exists (`src/editor/share-link.ts`). The reading page and the **Share link…** dialog are the next #39 steps and are not built yet. Design for later formats, rendered views, images and active documents is in [#244](https://github.com/vchernoy/typebridge/issues/244).

## What a link carries

A shared document travels inside the link's fragment, `https://typebridge.vchernoy.xyz/#doc=1.…`. Browsers never send the fragment to a server, so nothing is uploaded. The link still appears in browser history and wherever it is pasted, and anyone with the link can read the text.

| Field | Meaning |
|---|---|
| `title` | Document title, at most 150 characters |
| `text` | Document text, exactly as written |
| `format` | Document format; `plain` is the only one this version renders |
| `view` | How the reading page first shows it: `source` or `rendered` (presentation only) |
| `edit` | Whether the reading page offers **Edit a copy** (presentation only; it does not protect the text) |

Undo history and settings (theme, transliteration rules, Find options) are always local and never travel.

## Encoding (version 1)

`1.` + base64url (no padding) of the deflate-raw-compressed UTF-8 JSON of the fields above. The leading version lets later builds change the encoding while still reading old links.

## Limits and untrusted input

Every link is untrusted input. Decoding never throws; it returns a reason (`missing`, `version`, `too-large`, `malformed`).

- Payloads over 48,000 characters are refused before decompression.
- Decompression stops at 2 MB of output, so a small link cannot expand into a huge document.
- JSON must have a string `title` and `text` and a format matching `[a-z0-9][a-z0-9+.-]{0,31}`. Unknown `view` falls back to `source`; a missing `edit` means allowed.
- A format this build does not know (e.g. a future `markdown`) is still decoded, so the reading page can show its raw text with a notice instead of failing.
- Links longer than 2,000 characters are allowed but should be flagged to the sender: messengers, mail clients and social sites often cut or refuse long links.

`e2e/share-link-format.spec.ts` checks that a payload made in Node decodes in Chromium, Firefox and WebKit, and that each browser's payload decodes in Node.
