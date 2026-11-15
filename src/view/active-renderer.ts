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
  const updateOverflow = () => {
    for (const formula of formulas) {
      formula.toggleAttribute('data-overflow-start', formula.scrollLeft > 1);
      formula.toggleAttribute('data-overflow-end', formula.scrollWidth - formula.clientWidth - formula.scrollLeft > 1);
    }
  };
  const update = () => {
    fitFractionFences(root, sizedFences);
    updateOverflow();
  };
  const resize = new ResizeObserver(update);
  for (const formula of formulas) {
    resize.observe(formula);
    formula.addEventListener('scroll', updateOverflow, { passive: true });
  }
  // Live math replaces its contents after input changes, including intrinsic width.
  const mutations = new MutationObserver(update);
  mutations.observe(root, { childList: true, characterData: true, subtree: true });
  const fonts = root.ownerDocument.fonts;
  fonts.addEventListener('loadingdone', update);
  update();
  return { destroy: () => {
    resize.disconnect();
    mutations.disconnect();
    fonts.removeEventListener('loadingdone', update);
    for (const formula of formulas) formula.removeEventListener('scroll', updateOverflow);
    live.destroy();
  }, messages: result.messages };
}
