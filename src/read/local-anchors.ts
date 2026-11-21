/**
 * Shared pages carry the document in the URL fragment (`#doc=…`), so a local Markdown anchor such as
 * `[Jump](#later)` or a footnote link must scroll to its target instead of replacing that fragment.
 */
export function keepShareFragment(body: HTMLElement): void {
  body.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>('a[href^="#"]');
    if (!anchor || !body.contains(anchor)) return;
    event.preventDefault();
    const raw = anchor.hash.slice(1);
    const fragments = [raw];
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded !== raw) fragments.push(decoded);
    } catch { /* A literal match still works for a malformed percent escape. */ }
    // Prefer the literal ID, which GFM uses for percent-encoded footnote labels.
    // Older links may still need the sanitizer's additional prefix.
    const ids = [...fragments, ...fragments.map(id => 'user-content-' + id)];
    const elements = Array.from(body.querySelectorAll('[id]'));
    const target = ids.map(want => elements.find(element => element.id === want)).find(Boolean);
    target?.scrollIntoView();
  });
}
