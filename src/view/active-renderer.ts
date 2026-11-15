/** Loaded only for Rendered Markdown, on either editor or shared reading page. */
import { renderActive } from '@vchernoy/remark-active';
import katex from 'katex';
import { mount } from '@vchernoy/active-runtime';
import '@vchernoy/active-runtime/style.css';
import './active-renderer.css';

export function renderDocument(root: HTMLElement, text: string, locale: string) {
  const result = renderActive(text, { locale });
  // Only the package's sanitized output crosses this HTML boundary. Never source text.
  root.innerHTML = result.html;
  const live = mount(root, { locale, loadKatex: async () => katex });
  const formulas = Array.from(root.querySelectorAll<HTMLElement>('.active-math-display'));
  const update = () => {
    for (const formula of formulas) {
      formula.toggleAttribute('data-overflow-start', formula.scrollLeft > 1);
      formula.toggleAttribute('data-overflow-end', formula.scrollWidth - formula.clientWidth - formula.scrollLeft > 1);
    }
  };
  const resize = new ResizeObserver(update);
  for (const formula of formulas) {
    resize.observe(formula);
    formula.addEventListener('scroll', update, { passive: true });
  }
  // Live math replaces its contents after input changes, including intrinsic width.
  const mutations = new MutationObserver(update);
  mutations.observe(root, { childList: true, characterData: true, subtree: true });
  update();
  return { destroy: () => {
    resize.disconnect();
    mutations.disconnect();
    for (const formula of formulas) formula.removeEventListener('scroll', update);
    live.destroy();
  }, messages: result.messages };
}
