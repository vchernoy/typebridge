# Medium embed feasibility

Research for [#384](https://github.com/vchernoy/typebridge/issues/384), checked
2026-11-21 against TypeBridge `9c5bfa45d337c1231876582153b4b92f90e85337`.
This report adds no endpoint, provider integration or supported-host claim.

**Recommendation: wait for provider/Medium confirmation before implementation.**
There is a documented provider application route; the evidence does not establish
that TypeBridge is forbidden or that registration guarantees a working Medium
embed. Published TypeBridge rendering in Medium remains untested. Keep #384 open.

## Primary sources and their limits

All links below were inspected on the research date. Dates in parentheses are
source update dates when the page supplies an exact date, not compatibility tests.

- [Medium: Using embeds](https://help.medium.com/hc/en-us/articles/214981378-Using-embeds)
  (2026-11-11): paste an HTTP(S) URL on a new line and press Enter. Supported
  services produce embeds, unsupported services preview cards; interactivity is
  available after publication. Raw embed code and user-inserted scripts are
  unsupported. Medium identifies Embedly as its integration service and says a
  new provider's content should work on Medium. This is a pathway, not evidence
  of TypeBridge acceptance or preservation of fragments. The article lists
  examples rather than a TypeBridge-specific approval.
- [Embedly: Become a Provider](https://embed.ly/providers/new)
  (no exact update date shown): applications require representative public URLs
  and an oEmbed endpoint. Pages must be server-crawlable; the endpoint and embed
  resources need HTTPS. Interactive media is eligible for consideration, ordinary
  marketing/blog pages are not. Requirements include responsive widths of
  280–800px, iframe rather than script-tag embeds, and an iframe `referrer`
  parameter. Height control is optional. Embedly reviews technical fit and may
  decline; the current page lists a one-time **$99 implementation fee after
  approval**. Medium's page instead says becoming a provider is free. These
  official statements conflict: confirm terms before applying or committing
  money. No application, payment or support contact was made for this report.
- [Embedly provider directory](https://embed.ly/providers): no TypeBridge entry
  was found in the retrieved catalog. This does not prove absence of private
  arrangements or recognition under another name.
- [oEmbed specification](https://oembed.com/): the consumer requests a URL via an
  encoded `url` query argument; optional size/format arguments constrain the
  response. A rich response includes HTML, width, height and version `1.0`.
  Discovery uses alternate links or HTTP Link headers. Discovery describes how
  a consumer can find an endpoint, not a requirement that Medium use an arbitrary
  newly discovered endpoint. A link response is metadata, not an interactive
  rich embed. The protocol does not require a document database.
- [RFC 3986 §3.5](https://www.rfc-editor.org/rfc/rfc3986#section-3.5)
  (January 2005): a fragment is separated before resource dereferencing.
- [GitHub Pages hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages):
  serves static build output. Static JSON is possible; a per-request response
  computed from arbitrary query arguments requires a separate execution service.
- [Embedly provider height resizing](https://docs.embed.ly/reference/provider-height-resizing)
  (only a relative update date shown): documents a provider message protocol for
  native consumers including Medium. This is not TypeBridge's existing protocol.
- [Medium Rules: embedded content and collection of personal information](https://help.medium.com/hc/en-us/articles/213477928-Medium-Rules)
  (2026-11-11): restricts onsite collection of reader information and requires
  disclosures for offsite collection. A local calculator is not proof of policy
  approval for arbitrary authored forms. Any application needs a precise account
  of supported content and data handling.

No inspected source specifies whether Medium has an additional allowlist, the
exact URL it forwards, fragment handling, usable URL-length limits, or a
TypeBridge-specific CSP/sandbox contract. Do not invent those requirements or
assume that provider listing alone settles them.

## Behavior matrix

| Author action | Documented platform behavior | TypeBridge-specific observed evidence |
| --- | --- | --- |
| Insert a normal hyperlink | Medium supports links | No published article tested; external reader works independently |
| Paste URL then Enter | Unsupported services become preview cards | Actual TypeBridge card appearance and payload handling unverified |
| Paste a recognized rich provider URL | Provider path can produce interactive content after publication | No TypeBridge provider approval or functioning Medium iframe verified |
| Paste raw TypeBridge iframe HTML | Medium does not support embed-code insertion | Existing Copy embed code is for hosts accepting iframe HTML, not a Medium integration |

An editor preview, screenshot or working standalone iframe is not a successful
Medium test. Existing #383/#388 browser coverage establishes TypeBridge's iframe
reader and same-site cross-origin loopback isolation, not Medium compatibility,
real cross-site behavior or device acceptance. See [Embedding](SHARING.md#embedding).

## Fragment transport and disclosure

Current links use `/#doc=…`, `/read.html#doc=…` and `/embed.html#doc=…`.
Fetching any of those pages does not send the fragment in that HTTP request.
Server-side scraping therefore cannot derive a document-specific title or
rendered content from the static response. Existing Open Graph tags describe the
application; source inspection found no oEmbed discovery or endpoint.

A consumer that already has the complete pasted URL could instead encode it:

```text
/capture?url=https%3A%2F%2Ftypebridge.vchernoy.xyz%2Fembed.html%23doc%3DSYNTHETIC_SENTINEL
```

Here `%23doc%3D…` is query data sent to the receiving server. Thus an endpoint
**can** receive the original fragment if an intermediary forwards it this way.
Whether Medium and Embedly actually do so is unknown. Forwarding would disclose
source and any included input snapshot to those services and potentially their
logs/caches. `?doc=…` would likewise disclose it; compression is not encryption.
The eventual iframe fragment does not undo earlier disclosure. Neither long-URL
acceptance nor non-truncation has been demonstrated through the provider chain.

Reproduce the narrow transport check with:

```sh
node docs/evidence/384/probe-fragments.mjs
```

On Node v24.22.1 it passed assertions against a real loopback HTTP capture:
`directRequestHasFragment: false`,
`encodedQueryDisclosesFullOriginalURL: true`, `externalRequests: 0`.
Only a synthetic sentinel was used. This tests Node HTTP transport, not browsers,
Medium, Embedly, payload decoding or an oEmbed implementation. The capture server
exists only for the probe and is closed afterward.

## Architecture choices (analysis, not approved designs)

| Option | Smallest change and implications | Assessment |
| --- | --- | --- |
| Existing static iframe with fragment | No backend; host must accept supplied iframe HTML. Whoever can inspect the host HTML can read the payload. | Already supported for compatible hosts; no demonstrated Medium route |
| Prebuilt public document pages/metadata | Static hosting could serve per-document files and JSON produced at build time. Requires a publishing workflow and deliberately public content. | Separate product design; does not solve arbitrary current fragment links |
| Edge oEmbed responder | Request-time service could validate an allowlisted TypeBridge URL and return a fixed reader iframe, without storing documents. Requires the full fragment to survive forwarding. | Smallest plausible dynamic route; still a backend, approval/operations cost and new disclosure requiring explicit consent |
| Stored document / short ID | Service stores content and resolves a stable public identifier; shorter links, but access, deletion, retention and abuse handling become product obligations. | Larger change; not required by oEmbed itself, not justified yet |
| Link with an author-supplied screenshot | No provider backend; reader follows link to interact. Image can be public and becomes stale. | Honest fallback, with no inline-interactivity claim |

A future dynamic responder would need strict origin/path/scheme and payload size
validation, safe iframe attribute encoding, bounded decoding, size negotiation,
rate/abuse controls and logging/cache policy. It should not fetch arbitrary URLs.
Generic discovery/OG metadata cannot supply document content missing from a
server request. CSP `frame-ancestors`, host sandbox restrictions and required
resource loads must be verified together on the actual platform, not guessed.

The provider's `referrer` argument is distinct from HTTP Referrer-Policy.
TypeBridge currently uses `no-referrer`; this report does not add parent tracking.
Any referrer support needs a privacy decision. Likewise #385 owns the unresolved
resize scope: copying a full-location, wildcard postMessage example could expose
`#doc=` to ancestors. Do not adopt it without a reviewed protocol. Existing
320px browser checks do not certify the full provider width range or real mobile
behavior.

## Remaining proof and next gate

No Medium account draft/story was created or published, and no private document
was submitted to an external resolver. Actual publication requires explicit
maintainer authorization; provider/support contact and backend deployment are
also outside this research change. There is no support response to report.

Before code, obtain evidence of provider eligibility, Medium acceptance,
fragment preservation, URL limits, current fees and data-handling requirements.
Then present a concrete opt-in architecture for approval. Only afterward prepare
an authorized harmless slider/result article test, verifying the **published**
article's keyboard/input behavior, scrolling, layout, height, parent isolation,
network/storage behavior and desktop/mobile operation. Record exact URLs,
versions and observations, including failures. A provider rejection or confirmed
fragment stripping could change the recommendation; neither has been observed.

This completes a source-backed research slice. It leaves #384's actual-platform
acceptance open and authorizes no implementation, provider application or release.
