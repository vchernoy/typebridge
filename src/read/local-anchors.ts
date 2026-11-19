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
    let id: string;
    try {
      id = decodeURIComponent(anchor.hash.slice(1));
    } catch {
      return;
    }
    // The sanitizer prefixes rendered ids with "user-content-" (footnotes get it twice), so try that too.
    const ids = [id, 'user-content-' + id];
    const elements = Array.from(body.querySelectorAll('[id]'));
    const target = ids.map(want => elements.find(element => element.id === want)).find(Boolean);
    target?.scrollIntoView();
  });
}
