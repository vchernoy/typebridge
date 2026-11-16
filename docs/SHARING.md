# Share links

Status: #39 v1 is built: the **link format** (`src/editor/share-link.ts`), the **reading page** (`read.html`, `src/read/main.ts`) and **Documents → Share link…** (`src/ui/share-dialog.ts`). Plain and Markdown documents are supported, with source or rendered presentation. The design is in [#244](https://github.com/vchernoy/typebridge/issues/244).

## What a link carries

A shared document travels inside the link's fragment, `https://typebridge.vchernoy.xyz/#doc=1.…`. Browsers never send the fragment to a server, so nothing is uploaded. The link still appears in browser history and wherever it is pasted, and anyone with the link can read the text.

| Field | Meaning |
|---|---|
| `title` | Document title, at most 150 characters |
| `text` | Document text, exactly as written |
| `format` | Document format; `plain` or `markdown` (active-md 0.4.0: GFM, callouts, math and calc) |
| `view` | How the reading page first shows it: `source` or `rendered` (presentation only) |
| `heading` | Optional `false` hides the visible page title; omitted or other values show it. The accessible heading, tab title and Edit copy name remain. Old readers ignore the hint. |
| `edit` | Whether the reading page offers **Edit a copy** (presentation only; it does not protect the text) |

Markdown calc supports ln, log, exp, trigonometric functions, pi and e.

Undo history and settings (theme, transliteration rules, Find options) are always local and never travel.

## Encoding (version 1)

`1.` + base64url (no padding) of the deflate-raw-compressed UTF-8 JSON of the fields above. The leading version lets later builds change the encoding while still reading old links.

## Limits and untrusted input

Every link is untrusted input. Decoding never throws; it returns a reason (`missing`, `version`, `too-large`, `malformed`).

- Payloads over 48,000 characters are refused before decompression.
- Decompression stops at 2 MB of output, so a small link cannot expand into a huge document.
- JSON must have a string `title` and `text` and a format matching `[a-z0-9][a-z0-9+.-]{0,31}`. Unknown `view` falls back to `source`; a missing `edit` means allowed.
- A format this build does not know (e.g. `future-markdown`) is still decoded, so the reading page can show its raw text with a notice instead of failing.
- **Encoding refuses what decoding would refuse:** a document whose JSON exceeds 2 MB (even when very repetitive text would compress into a short link), or whose payload exceeds 48,000 characters, gets `too-large` instead of a link, and a format name decoding would reject gets `format`, so nobody is offered a link that cannot be opened.
- Links longer than 2,000 characters are allowed but should be flagged to the sender: messengers, mail clients and social sites often cut or refuse long links.

`e2e/share-link-format.spec.ts` checks that a payload made in Node decodes in Chromium, Firefox and WebKit, and that each browser's payload decodes in Node.

## Share link… (sender)

**▾ Documents → Share link…** shares the title and text shown in that window, including unsaved changes, like Export. The dialog:

- says plainly: "Anyone with the link can read this document. The text travels inside the link itself; nothing is uploaded. The link also stays in your browser history and wherever you paste it."
- previews what the reader sees first (title and the start of the text);
- for Markdown, has **Readers see: Rendered page / Source**, defaulting to Rendered; plain documents keep source presentation;
- has **Show title on the page** (on by default); turning it off hides the title in both the preview and reading page, while retaining a visually hidden accessible heading, the tab title and the Edit copy’s name;
- has **Readers can edit a copy** (on by default; off hides Edit a copy on the reading page, which is presentation only);
- shows the link in a read-only field and **Copy link** (if the browser refuses clipboard access, the link is selected for the device's copy command);
- warns when the link is longer than 2,000 characters, and refuses a document too large for a link, suggesting Export instead.

Every control in the dialog is reachable with Tab; Escape or Close returns to ▾.

## Reading page

`/#doc=…` forwards to `/read.html#doc=…`; the fragment stays in the browser. Pasting a share link into a tab that already shows TypeBridge at `/` forwards too, since only the fragment changes. The page shows the title and document, with a quiet **Edit** hyperlink beside the title when the sender allowed editing, and **Written with TypeBridge** below the document. It honors the sender’s source/rendered view choice without a reading toolbar. Source presentation preserves the text, line breaks and spaces as written. Rendered Markdown dynamically loads active-md and inserts only its sanitized output, with KaTeX `trust: false` and MathML output. Raw HTML is dropped, dangerous links are filtered, and remote images are links that require a click. If rendering fails, the page automatically shows the source with a notice. Calc input values are temporary; they are never saved, journaled or shared. Only `{{…}}` placeholders inside math and `:value[…]` bindings are live; typed-in numbers stay as written, including numbers in a second `aligned` block. For example, `{{final | fixed:2}}` updates with the same formatting as `:value[final]{format=fixed:2}`. It opens offline once TypeBridge itself (`/` or the editor) has been opened in that browser, which installs offline support; the reading page does not install it, so opening only share links does not.

Markdown titles typeset inline `$…$` in the visible page heading, including with a source body. Titles do not interpret Markdown or live `{{…}}` bindings; display fences and invalid TeX remain plain text. The browser tab, title input, Documents list, share preview and export names keep the original plain title, with the same 150-character limit. Plain documents are unchanged.

- **Nothing is stored while reading.** No database is opened and no history or settings are written.
- **Edit** (shown unless the sender turned it off) saves source text and its format as a **new** document and never overwrites an existing one. It then opens `/?open=<id>`: the host shows the copy in a new editor window, or activates the window that already shows it, and confirms "Saved as a new document in your Documents." When every window is open (the cap is 4), the copy is still saved, and the confirmation says to close a window and open it from ▾ Documents.
- **A link that cannot be opened explains why:** it has no document, it was made by a newer version, it is too large, or it is incomplete or damaged (messengers sometimes cut long links). A format this version cannot show yet is displayed as its raw text with a notice.


Markdown support delivers #244 proposed steps 2–4 through the editor-format/view and
sharing/reading PRs. No author code runs, and no local-image, rich-editor or print/PDF support
is included. Unknown formats still show source with a notice. Reading alone does not open
IndexedDB or write localStorage/sessionStorage; Edit a copy remains the only storage action.
The app shell is precached; renderer assets cache on demand. A first Markdown render needs
connectivity, and later rendering works offline after those assets have been used online.


Rendered reading uses compact number controls sized from their declared ranges, with sentence-sized, normal-weight input text. Math prefers Fira Math, with locally installed STIX Two Math, Cambria Math or Latin Modern Math as fallbacks. TypeBridge bundles Fira Math 0.3.4 (99,332-byte WOFF2, SIL OFL 1.1; [licence](../public/fonts/FiraMath-OFL.txt)) for devices without it. The renderer loads it from this site only when math needs it, tries local Fira Math first, and caches the asset on demand for offline use after its first online render. Fraction fences use a MathML minimum derived from their enclosed layout height, refreshed after font loading and live math changes; explicit authored size limits are preserved. Plain documents load no math font; active-md itself remains font-free. Long display formulas scroll in their HTML wrapper, with a fading edge only where more content remains. Short formulas have no fade.

The six callout kinds have distinct theme-aware borders, tinted backgrounds and title colours; details keep a neutral border. Shared-page Edit and TypeBridge attribution links use the theme accent, hover emphasis and keyboard focus outline. These presentation changes do not save reader input values or change the shared source.
