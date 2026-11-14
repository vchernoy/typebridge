# Share links

Status: #39 v1 is built: the **link format** (`src/editor/share-link.ts`), the **reading page** (`read.html`, `src/read/main.ts`) and **Documents → Share link…** (`src/ui/share-dialog.ts`). Plain text only. Design for later formats, rendered views, images and active documents is in [#244](https://github.com/vchernoy/typebridge/issues/244).

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
- **Encoding refuses what decoding would refuse:** a document whose JSON exceeds 2 MB (even when very repetitive text would compress into a short link), or whose payload exceeds 48,000 characters, gets `too-large` instead of a link, and a format name decoding would reject gets `format`, so nobody is offered a link that cannot be opened.
- Links longer than 2,000 characters are allowed but should be flagged to the sender: messengers, mail clients and social sites often cut or refuse long links.

`e2e/share-link-format.spec.ts` checks that a payload made in Node decodes in Chromium, Firefox and WebKit, and that each browser's payload decodes in Node.

## Share link… (sender)

**▾ Documents → Share link…** shares the title and text shown in that window, including unsaved changes, like Export. The dialog:

- says plainly: "Anyone with the link can read this document. The text travels inside the link itself; nothing is uploaded. The link also stays in your browser history and wherever you paste it."
- previews what the reader sees first (title and the start of the text);
- has **Readers can edit a copy** (on by default; off hides Edit a copy on the reading page, which is presentation only);
- shows the link in a read-only field and **Copy link** (if the browser refuses clipboard access, the link is selected for the device's copy command);
- warns when the link is longer than 2,000 characters, and refuses a document too large for a link, suggesting Export instead.

Every control in the dialog is reachable with Tab; Escape or Close returns to ▾.

## Reading page

`/#doc=…` forwards to `/read.html#doc=…`; the fragment stays in the browser. Pasting a share link into a tab that already shows TypeBridge at `/` forwards too, since only the fragment changes. The page looks like a plain read-only web page: the title, the text exactly as written (line breaks and spaces kept), a quiet **Shared document · read-only** label and **Written with TypeBridge**. The text is always written as text, never parsed as HTML. It opens offline once TypeBridge itself (`/` or the editor) has been opened in that browser, which installs offline support; the reading page does not install it, so opening only share links does not.

- **Nothing is stored while reading.** No database is opened and no history or settings are written.
- **Edit a copy** (shown unless the sender turned it off) saves the text as a **new** document and never overwrites an existing one. It then opens `/?open=<id>`: the host shows the copy in a new editor window, or activates the window that already shows it, and confirms "Saved as a new document in your Documents." When every window is open (the cap is 4), the copy is still saved, and the confirmation says to close a window and open it from ▾ Documents.
- **A link that cannot be opened explains why:** it has no document, it was made by a newer version, it is too large, or it is incomplete or damaged (messengers sometimes cut long links). A format this version cannot show yet is displayed as its raw text with a notice.


The editor's #244 format/Rendered-view work is separate from the shared reading page: until
its follow-up PR, the sender still creates plain/source links and the reading page treats
Markdown links as unknown formats, showing source. The editor's JSON export/import already
retains the document format; old files default to plain.
