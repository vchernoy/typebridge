# Share links

Status: #39 v1 is built: the **link format** (`src/editor/share-link.ts`), the **reading page** (`read.html`, `src/read/main.ts`) and **Documents → Share link…** (`src/ui/share-dialog.ts`). Plain and Markdown documents are supported, with source or rendered presentation. The design is in [#244](https://github.com/vchernoy/typebridge/issues/244).

## What a link carries

A shared document travels inside the link's fragment, `https://typebridge.vchernoy.xyz/#doc=1.…`. Browsers never send the fragment to a server, so nothing is uploaded. The link still appears in browser history and wherever it is pasted, and anyone with the link can read the text.

| Field | Meaning |
|---|---|
| `title` | Document title, at most 150 characters |
| `text` | Document text, exactly as written |
| `format` | Document format; `plain` or `markdown` (ActiveMD 0.9.0: GFM, callouts, math, calc and quizzes) |
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

**Share document** in the common title area (also **▾ Documents → Share link…**) shares the title and text shown in that window, including unsaved changes, like Export. The dialog:

- says plainly: "Anyone with the link can read this document. The text travels inside the link itself; nothing is uploaded. The link also stays in your browser history and wherever you paste it."
- offers a collapsed **Document preview** disclosure for the title and start of the text; rendered dependencies load only when opened, and collapsing destroys the preview runtime;
- groups presentation hints under collapsed **Reader options**, with selected settings summarized while closed; for Markdown, has **Readers see: Rendered page / Source**, defaulting to Rendered; plain documents keep source presentation;
- has **Show title on the page** (on by default); turning it off hides the title in both the preview and reading page, while retaining a visually hidden accessible heading, the tab title and the Edit copy’s name;
- has **Readers can edit a copy** (on by default; off hides Edit a copy on the reading page, which is presentation only);
- shows the link in a read-only field and **Copy link** (if the browser refuses clipboard access, the link is selected for the device's copy command);
- offers a collapsed **Embed on another website** disclosure after the link status, with read-only iframe HTML and **Copy embed code** (see [Embedding](#embedding));
- warns when the link is longer than 2,000 characters, and refuses a document too large for a link, suggesting Export instead.

Every control in the dialog is reachable with Tab; Escape or Close returns to the actual Share opener (Share document or ▾). The direct path is Share document → Copy link: two activations, including in source, Rendered, comparison and Focus windows. Sharing does not acquire source editing ownership.

## Embedding

Copy embed code produces `<iframe src="…/embed.html#doc=…" width="100%" height="450" style="border:0" loading="lazy" referrerpolicy="no-referrer" title="Interactive document">`. It carries the same payload as the link, including Include current parameters, so anyone who can read the host page's HTML can decode the document, just like anyone holding the link.

`embed.html` is a minimal reader for that iframe. It shows the title (hidden when the sender turned it off; `$…$` titles typeset) and the document, with the same view rule, sanitized renderer, failure messages and unknown-format notice as the reading page. It has no Edit a copy, Share, remembering or reader-input storage: it writes nothing to storage, registers no service worker and makes no requests beyond loading TypeBridge's own assets. Local anchors (heading links such as `[x](#heading)`, which have targets since ActiveMD 0.6.2) and footnote links, including Unicode labels, scroll inside the frame without replacing the `#doc=` fragment; other links open in a new tab. The frame has a fixed height: a host page that wants another size edits the `height` attribute (automatic resizing is not implemented). Hosts that strip iframes from posted HTML (many comment boxes, chat apps and some hosted blogs) cannot show it; share the link there instead.

Automated Chromium/Firefox/WebKit coverage also loads the actual embed entry inside
a parent page served on a different loopback port. It checks same-origin-policy
isolation, keyboard-driven calculations, frame-local footnotes, an unchanged
payload fragment, no referrer, and no storage/service-worker access or requests
outside the two local origins. This is a cross-origin, same-site harness: it does
not establish real CMS compatibility or cross-site storage-partitioning behavior.

Medium integration is unverified; see the [Medium feasibility report](MEDIUM-EMBEDS.md)
for provider requirements, fragment disclosure and the remaining published-article test.

## Reading page

`/#doc=…` forwards to `/read.html#doc=…`; the fragment stays in the browser. Pasting a share link into a tab that already shows TypeBridge at `/` forwards too, since only the fragment changes. The page shows the title and document, with a quiet **Edit** hyperlink beside the title when the sender allowed editing, and **Written with TypeBridge** below the document. It honors the sender’s source/rendered view choice without a reading toolbar. Source presentation preserves the text, line breaks and spaces as written. Rendered Markdown dynamically loads active-md and inserts only its sanitized output, with KaTeX `trust: false` and MathML output. Raw HTML is dropped, dangerous links are filtered, and remote images are links that require a click. If rendering fails, the page automatically shows the source with a notice. Accepted shared numeric inputs can be saved in a separate local record as described below; they are never journaled into source or shared in links. Editable Preview inputs are stored separately when permitted, as described below. Only `{{…}}` placeholders inside math and `:value[…]` bindings are live; typed-in numbers stay as written, including numbers in a second `aligned` block. For example, `{{final | fixed:2}}` updates with the same formatting as `:value[final]{format=fixed:2}`. It opens offline once TypeBridge itself (`/` or the editor) has been opened in that browser, which installs offline support; the reading page does not install it, so opening only share links does not.

Markdown titles typeset inline `$…$` in the visible page heading, including with a source body. Titles do not interpret Markdown or live `{{…}}` bindings; display fences and invalid TeX remain plain text. The browser tab, title input, Documents list, share preview and export names keep the original plain title, with the same 150-character limit. Plain documents are unchanged.

- **Valid received links are remembered locally by default** in Documents → Shared with me, separately from editable drafts. The Local shared library disclosure on the reader explains this and offers the same remembering preference as Settings. Private session or opt-out prevents automatic content writes; failed preference reads deny writes. Existing items remain until removed. Re-enabling does not save this page retroactively: use Remember explicitly or reopen in a fresh page. Accepted shared-reader numeric inputs are saved separately when permitted (see below).
- **Edit** (shown unless the sender turned it off) can select an exact clean existing editor after fresh owner/source/privacy/lock checks. It leaves the shared page open and preserves current calc inputs on both surfaces. The status says to switch to the existing TypeBridge window if the browser did not bring its tab forward. No source, history or backups are changed.
- If no activation commit was sent, or the owner confirms non-activation, Edit uses the atomic safe-copy fallback: reuse an exact unowned match or save a new document. Private/owned/recovery candidates and unapplied changes stay ineligible in that fallback. Recovery inspection is a conservative localStorage/own-sessionStorage snapshot, not an atomic cross-storage guarantee; unreadable storage disables reuse, and no backup is deleted. Unowned matches use lexical document ID order. It opens `/?open=<id>` and reports whether an existing document was opened or a new copy saved; at the four-window cap the copy is saved with guidance to open it from Documents after closing a window.
- **An unknown activation result never automatically creates a copy.** Edit stays disabled for that unresolved action; **Check status** asks about the same activation without retrying it. **Create new copy** warns that the existing document may already be open and asks for confirmation before making a separate copy. Late old replies cannot change that new action. Hash/navigation/privacy/clear changes cancel pending work; a restored page keeps an unresolved warning in memory, with Check status disabled if its old transport was abandoned. Protocol state is not saved across a full reload. Sender-disabled Edit does not probe or create anything.
- **A link that cannot be opened explains why:** it has no document, it was made by a newer version, it is too large, or it is incomplete or damaged (messengers sometimes cut long links). A format this version cannot show yet is displayed as its raw text with a notice.


Markdown support delivers #244 proposed steps 2–4 through the editor-format/view and
sharing/reading PRs. No author code runs, and no local-image, rich-editor or print/PDF support
is included. Unknown formats still show source with a notice. Reading remembers the validated received payload in IndexedDB when permitted; it never
creates an editable draft. Only Edit a copy creates or safely reuses an editable document.
The app shell is precached; renderer assets cache on demand. A first Markdown render needs
connectivity, and later rendering works offline after those assets have been used online.


Rendered reading supports [numeric radio groups and dropdowns](examples/delivery-choices.md). A saved choice that is no longer offered falls back to its calc default. Rendered reading uses compact number controls sized from their declared ranges, with sentence-sized, normal-weight input text. Math prefers Fira Math, with locally installed STIX Two Math, Cambria Math or Latin Modern Math as fallbacks. TypeBridge bundles Fira Math 0.3.4 (99,332-byte WOFF2, SIL OFL 1.1; [licence](../public/fonts/FiraMath-OFL.txt)) for devices without it. The renderer loads it from this site only when math needs it, tries local Fira Math first, and caches the asset on demand for offline use after its first online render. Fraction fences use a MathML minimum derived from their enclosed layout height, refreshed after font loading and live math changes; explicit authored size limits are preserved. Plain documents load no math font; active-md itself remains font-free. Long display formulas scroll in their HTML wrapper, with a fading edge only where more content remains. Short formulas have no fade.

The six callout kinds have distinct theme-aware borders, tinted backgrounds and title colours; details keep a neutral border. Shared-page Edit and TypeBridge attribution links use the theme accent, hover emphasis and keyboard focus outline. These presentation changes do not save reader input values or change the shared source.


## Planned local shared library and reader state (#322)

The [research design](adr/322-local-reader-state.md) proposes automatic local remembering,
separate reader-input sidecars, privacy/opt-out and deletion rules, and safe editable-copy
reuse. It records current API limitations and the ordered #323–#326 acceptance matrix.
The shared-library slice (#323) implements automatic remembering with an explicit opt-out;
Shared rendered numeric inputs are persisted separately in #324 when permitted; editable-document numeric inputs are persisted separately in #326; quiz attempts (#327) remain later work.


## Local Shared with me library (#323)

The exact validated version-prefixed payload identifies a received item, independent of the
root/read.html route. Different compressed payloads or hints remain distinct. SHA-256 is
only a lookup value; full payload equality is checked in the write transaction. Reopening
updates last-opened time without adding a row. Unknown formats retain source fallback.

Documents has a separate searchable Shared with me collection. Links with exactly the
same title, source and format appear in expandable groups; different presentation hints
remain individual received links. Single items keep a direct title link. Search covers
immutable source/title/format and presentation labels, with matching groups expanded
temporarily. It never searches this recipient's saved input sidecars. Every link opens
its original read-only page in a new tab. Actions can copy that exact received payload
as a link on this site's origin, or confirm individual removal. Copy never includes
recipient-local inputs or current editable/private source. If clipboard access fails,
a selected read-only original URL allows manual copying. Individual removal checks
the expected payload inside its transaction; changed records require review rather
than deleting an unconfirmed replacement. Group
actions offers confirmed removal of all received links and their saved reader inputs,
while preserving editable copies. Changed membership requires a fresh decision;
storage failures cannot commit partial group removal. Input-bearing v2 links are accepted and grouped as distinct received variants. Unavailable stored links remain
visible with a safe individual removal action. Removing an item also removes its
reserved reader sidecar, never an independent editable copy. No account, sender identity
or cross-device sync is implied. A maximum of 100 items / 10 MiB of payloads is retained;
capacity, quota or storage failure leaves the link readable but not remembered. No silent
eviction. Browser storage may be cleared or evicted; this library is not a backup guarantee.

Clear local data deletes received items along with the existing content stores, closes
reader connections and reloads old pages. The one-load cleared notice suppresses automatic
remembering of the erased link after that reload; explicit Remember can save it again.
Removal invalidates remembers already computing their digest through a transactional
library epoch; a later deliberate open may remember the link anew. Settings, including
remembering opt-out and Private session, remain separate from content erasure. Source/plain
readers still download no renderer or font. Offline reopening requires the existing shell
service worker to have been installed by opening TypeBridge; no new network service exists.

Removal and global Clear local data publish a content-free localStorage cancellation
token before their write transaction or database deletion. Readers capture it before initial decoding (and explicit Remember captures a
fresh token); validation/open/hash delays cannot adopt a later removal as their baseline.
The transactional epoch still orders removals against final writes. An unreadable token
denies remembering; an unwritable token refuses removal/erasure with an error. The marker contains
no document identity or content and may survive content erasure.


## Shared reader inputs (#324)

The [snapshot contract](adr/349-shared-input-snapshots.md) covers compatibility,
initialization, reset and copy/privacy boundaries. The shared reader can already
include accepted numeric inputs through [Re-share current parameters](#re-share-current-parameters-372).
Editor-generated links continue to share source and presentation hints.

Rendered shared pages restore accepted numeric inputs, including model-only inputs, from
one versioned record keyed by the exact remembered shared item. Source, payload, authored
defaults, editable documents and history stay unchanged. Local saves never write to
the URL. Readers can explicitly include the current values when creating a new link.
The runtime validates names and current ranges before the staged reading area is revealed.
Invalid/incompatible records use defaults and stay memory-only; storage loading is bounded
to two seconds so a blocked database does not prevent reading. No renderer is loaded for
plain/source reading. Editable Preview persistence is described below; quiz answers remain separate work.

The default-on remembering preference and Private session gate both library and input
writes. Preference read failure denies writes. Opt-out/privacy/removal freezes that mount's
saving; re-enabling does not retroactively save its private values. Reopen to start a new
allowed mount. Existing saved values remain until reset, item removal or global clear.

Only accepted model snapshots are saved, after 500 ms debounce. Invalid control text is
never persisted. Each record permits 256 finite numeric pairs, 128-character names and
64 KiB UTF-8; the 100-item library bounds shared sidecars to at most 6.25 MiB. Oversize,
quota and other failures leave current values usable in memory. Hidden-page flushing is best effort; navigation/destroy cancels queued work.
Closing, reloading or crashing before a transaction completes can lose recent changes;
wait for Inputs saved on this device before leaving.

Whole-snapshot revision CAS prevents stale tabs overwriting saved values. Metadata-only
notifications show Load saved values / Keep these values; remote edits never replace the
current controls automatically. Keep explicitly rereads the winning revision before retry;
another concurrent change can conflict again. Reset inputs to defaults writes an empty
snapshot with a new revision, so an old queued save cannot undo reset. Removal deletes the
item and sidecar atomically and invalidates pending writers; global clear closes old readers
and reloads them through the existing clear lifecycle. No tombstones outlive removed items.


## Editable rendered inputs (#326)

Each saved editable document has its own local numeric input state, separate from source, history and shared links. Switching Edit/Rendered, remounting after source edits and reopening restores compatible input names and current ranges. Two documents with identical Markdown remain independent. Plain documents still load no renderer.

Autosave-off/private and unsaved documents keep inputs in memory. Any permitted Rendered window can save the document’s inputs, including a comparison window or a window where source is read-only because another window edits it. This does not acquire source ownership or change source/title/history. Concurrent input edits use independent revisions and explicit conflict resolution. Privacy or preference-read failure freezes that editor's cached state even after re-enabling: reload to resume permitted saving from the public baseline. Storage failure leaves the current inputs usable. Wait for Inputs saved on this device before leaving; rapid navigation or a crash can lose the latest changes. Reset inputs to defaults clears only the numeric sidecar; deleting/clearing a document removes it too. Quiz answers are not included.

## Re-share current parameters (#372)

A valid shared reading page offers **Share** independently of **Edit**. It captures
its title/source/format/presentation and the live model's accepted numeric values
when opened. **Include current parameters** is explicit and off by default; checking
it creates a bounded version-2 snapshot link. Unchecked links remain legacy version 1
and use authored defaults. Invalid/uncommitted control text, computed outputs,
history and settings are excluded. Nothing is uploaded. Private/opted-out readers
can explicitly re-share without saving locally or taking source ownership.

A new recipient initializes accepted parameters before revealing controls/results.
Existing recipient-local saved state wins as a whole, including an empty Reset record.
**Reset inputs to defaults** uses authored source defaults, not the link's starting
values. The original URL/library item never changes; re-sharing creates a new immutable
variant. Library grouping/search recognizes its incoming parameters, never local sidecars.
Older clients reject version-2 links explicitly; source-only/plain paths load no renderer.
Editable-copy creation/reuse retains existing source-only semantics in this slice; it
does not overwrite a copy's numeric state or promise to copy the recipient's answers.

Re-share inherits the received Edit a copy hint. If off, it stays off and its checkbox
is disabled; if on, the recipient may keep it or turn it off for the new link. This
is presentation behavior, not protection against manually copying visible source.

Edit progress, existing-window activation results and uncertain-activation recovery
actions appear directly below the shared-page header, before long document content.
Browsers may refuse foregrounding another tab; the result explains where the existing
editor was opened without silently making a duplicate copy.
