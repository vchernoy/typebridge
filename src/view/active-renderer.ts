/** Loaded only for Rendered Markdown, on either editor or shared reading page. */
import { renderActive } from '@vchernoy/remark-active';
import { mount } from '@vchernoy/active-runtime';
import './active-renderer.css';

export function renderDocument(root: HTMLElement, text: string, locale: string) {
  const result = renderActive(text, { locale });
  // Only the package's sanitized output crosses this HTML boundary. Never source text.
  root.innerHTML = result.html;
  const live = mount(root, { locale });
  return { destroy: () => live.destroy(), messages: result.messages };
}
