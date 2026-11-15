/** Loaded only for Rendered Markdown, on either editor or shared reading page. */
import { renderActive } from '@vchernoy/remark-active';
import katex from 'katex';
import { mount } from '@vchernoy/active-runtime';
import '@vchernoy/active-runtime/style.css';
import './active-renderer.css';
import { fitFractionFences } from './math-fences';

export function renderDocument(root: HTMLElement, text: string, locale: string) {
  const result = renderActive(text, { locale });
  // Only the package's sanitized output crosses this HTML boundary. Never source text.
  root.innerHTML = result.html;
  const live = mount(root, { locale, loadKatex: async () => katex });
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
  return { destroy: () => {
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
