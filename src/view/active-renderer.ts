/** Loaded only for Rendered Markdown, on either editor or shared reading page. */
import { renderActive } from '@vchernoy/remark-active';
import katex from 'katex';
import { mount } from '@vchernoy/active-runtime';
import '@vchernoy/active-runtime/style.css';
// Optional hand-drawn look (ActiveMD 0.12.0); inert unless <html> has .active-sketch.
import '@vchernoy/active-runtime/sketch.css';
import './active-renderer.css';
import { fitFractionFences } from './math-fences';

export function renderDocument(root: HTMLElement, text: string, locale: string, initialInputs?: ReadonlyMap<string, number>) {
  // Quizzes (ActiveMD 0.7.0): question groups render as controls; the answers stay in the
  // returned manifest, which goes straight to the runtime and never into the HTML.
  const result = renderActive(text, { locale, quizManifest: true });
  // Only the package's sanitized output crosses this HTML boundary. Never source text.
  root.innerHTML = result.html;
  const live = mount(root, { locale, initialInputs, ...(result.quiz ? { quiz: result.quiz } : {}), loadKatex: async () => katex });
  const formulas = Array.from(root.querySelectorAll<HTMLElement>('.active-math-display'));
  const sizedFences = new WeakSet<Element>();
  const updateOverflow = (targets = formulas) => {
    for (const formula of targets) {
      formula.toggleAttribute('data-overflow-start', formula.scrollLeft > 1);
      formula.toggleAttribute('data-overflow-end', formula.scrollWidth - formula.clientWidth - formula.scrollLeft > 1);
    }
  };
  const pendingMath = new Set<Element>();
  const pendingOverflow = new Set<HTMLElement>();
  const scrolled = (event: Event) => updateOverflow([event.currentTarget as HTMLElement]);
  let frame: number | undefined;
  let destroyed = false;
  const collect = (node: Node) => {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    if (!element || !root.contains(element)) return;
    const display = element.closest<HTMLElement>('.active-math-display');
    if (display) pendingOverflow.add(display);
    for (const child of element.querySelectorAll<HTMLElement>('.active-math-display')) pendingOverflow.add(child);
    const math = element.closest('math');
    if (math) pendingMath.add(math);
    for (const child of element.querySelectorAll('math')) pendingMath.add(child);
  };
  const flush = () => {
    frame = undefined;
    for (const math of pendingMath) {
      if (root.contains(math)) fitFractionFences(math, sizedFences);
    }
    pendingMath.clear();
    updateOverflow(Array.from(pendingOverflow));
    pendingOverflow.clear();
  };
  const schedule = () => {
    if (!destroyed && frame === undefined && (pendingMath.size || pendingOverflow.size)) frame = requestAnimationFrame(flush);
  };
  const resize = new ResizeObserver(entries => {
    for (const entry of entries) collect(entry.target);
    schedule();
  });
  for (const formula of formulas) {
    resize.observe(formula);
    formula.addEventListener('scroll', scrolled, { passive: true });
  }
  // A live replacement can change inner and outer fences in the same formula.
  // Process that formula inside-out once per frame; leave its neighbours alone.
  const mutations = new MutationObserver(records => {
    for (const record of records) collect(record.target);
    schedule();
  });
  mutations.observe(root, { childList: true, characterData: true, subtree: true });
  const fonts = root.ownerDocument.fonts;
  const fontLoaded = () => { collect(root); schedule(); };
  fonts.addEventListener('loadingdone', fontLoaded);
  fitFractionFences(root, sizedFences);
  updateOverflow();
  const quizSeeds = new Set(result.quiz?.groups.map(group => group.seed));
  return { quizSeeds, session: live.session, settled: () => live.settled(), resetInputs: () => live.resetInputs(), destroy: () => {
    destroyed = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    pendingMath.clear();
    pendingOverflow.clear();
    resize.disconnect();
    mutations.disconnect();
    fonts.removeEventListener('loadingdone', fontLoaded);
    for (const formula of formulas) formula.removeEventListener('scroll', scrolled);
    live.destroy();
  }, messages: result.messages };
}

/** Inline title math only: no Markdown, HTML or live-value interpretation. */
export function renderTitle(root: HTMLElement, source: string): void {
  const fragment = document.createDocumentFragment();
  let start = 0;
  const escaped = (index: number) => {
    let count = 0;
    while (index > 0 && source[--index] === '\\') count++;
    return count % 2 === 1;
  };
  try {
    for (let index = 0; index < source.length; index++) {
      if (source[index] !== '$' || escaped(index)) continue;
      // Display fences and live bindings are deliberately literal in titles.
      if (source[index + 1] === '$') return;
      let end = index + 1;
      while (end < source.length && (source[end] !== '$' || escaped(end))) end++;
      if (end === source.length || end === index + 1) return;
      const tex = source.slice(index + 1, end);
      if (tex.includes('{{')) return;
      fragment.append(document.createTextNode(source.slice(start, index)));
      const span = document.createElement('span');
      // KaTeX owns this boundary; source text is never inserted as HTML.
      span.innerHTML = katex.renderToString(tex, { trust: false, throwOnError: true, output: 'mathml', displayMode: false });
      fragment.append(span);
      index = end;
      start = end + 1;
    }
    fragment.append(document.createTextNode(source.slice(start)));
    root.replaceChildren(fragment);
  } catch { /* Keep the complete plain title on malformed TeX. */ }
}
