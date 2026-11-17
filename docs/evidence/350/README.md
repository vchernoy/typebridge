# Grouped library proposal evidence

The standalone [prototype](prototype.html) uses four fixed synthetic received-link
examples in two groups. It does not import production code, parse payloads, access
storage/clipboard, or navigate real shared links. It demonstrates the interaction
proposal, not implemented grouping or persistence. Read the
[design and remaining gates](../../adr/350-grouped-shared-library.md).

Run from a checkout after `npm ci`, with installed Playwright browsers:

```sh
node docs/evidence/350/check-prototype.mjs
PROTOTYPE_BROWSER=firefox node docs/evidence/350/check-prototype.mjs
PROTOTYPE_BROWSER=webkit node docs/evidence/350/check-prototype.mjs
```

`PLAYWRIGHT_BROWSERS_PATH` can select the installed browser cache.
`PROTOTYPE_WEBKIT_EXECUTABLE` optionally supplies a local WebKit launcher; hosted
browser checks use the repository's unchanged configuration. Output defaults to
`/tmp/typebridge-350-prototype`; `PROTOTYPE_OUTPUT` overrides it. The script checks
320px/1440px, keyboard/disclosures, search, cancellation/focus, simulated removal,
44px targets, overflow and 200% text. It records metadata only and takes screenshots
of synthetic examples. It does not claim OS screen-reader or real-device coverage.

Recorded measurements and screenshots below are local prototype evidence. Production
integration, exact original links, transactional rollback/races, unknown formats,
corrupt items, quotas and private-reader sidecars remain implementation test gates.

The final local run covered Chromium, Firefox and WebKit at both widths (six cases).
See [measurements.json](measurements.json), the [collapsed phone view](phone-collapsed.png),
[expanded phone view](phone-expanded.png) and [expanded desktop view](desktop-expanded.png).
All measured visible row targets were at least 44px, with no horizontal overflow.
The collapsed synthetic list has three visible row controls; the current individual
link/Remove layout would have eight for these four items. Native WebKit used the
installed browser binary through a local launcher supplying temporary extracted
libraries; repository CI configuration was not modified.
