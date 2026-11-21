/**
 * Documents → New from template… (#390 step 3): bundled starter documents. Choosing one
 * creates a normal new document with that text, like Import; nothing is fetched.
 */
import priceQuote from '../templates/price-quote.md?raw';
import lesson from '../templates/lesson.md?raw';
import selfCheck from '../templates/self-check.md?raw';
import type { DocumentFormat } from '../editor/document-fields';

export type DocumentTemplate = { id: string; title: string; description: string; text: string; format: DocumentFormat };

export const DOCUMENT_TEMPLATES: readonly DocumentTemplate[] = [
  { id: 'price-quote', title: 'Price quote', description: 'A form: quantity, price, discount and tax, with live totals.', text: priceQuote, format: 'markdown' },
  { id: 'lesson', title: 'Lesson with a formula', description: 'A formula that fills in as the reader moves a slider.', text: lesson, format: 'markdown' },
  { id: 'self-check', title: 'Quick self-check', description: 'A question with instant feedback for each answer.', text: selfCheck, format: 'markdown' },
];

/**
 * Show the template chooser. Resolves with the chosen template, or undefined when closed
 * (Cancel or Escape). Focus returns to `returnFocus` either way.
 */
export function chooseTemplate(returnFocus: HTMLElement | null): Promise<DocumentTemplate | undefined> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.id = 'template-dialog';
    dialog.className = 'template-dialog';
    dialog.setAttribute('aria-labelledby', 'template-title');
    const title = document.createElement('h2');
    title.id = 'template-title';
    title.textContent = 'New from template';
    const list = document.createElement('ul');
    list.className = 'template-list';
    let chosen: DocumentTemplate | undefined;
    for (const template of DOCUMENT_TEMPLATES) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `template-${template.id}`;
      button.className = 'template-choice';
      const name = document.createElement('strong');
      name.textContent = template.title;
      const description = document.createElement('span');
      description.textContent = template.description;
      button.append(name, description);
      button.addEventListener('click', () => { chosen = template; dialog.close(); });
      item.append(button);
      list.append(item);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.id = 'template-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => dialog.close());
    const actions = document.createElement('div');
    actions.className = 'template-actions';
    actions.append(cancel);
    dialog.append(title, list, actions);
    // Keep keys inside the modal: page handlers (Focus mode, Find and menu Escape layers) listen
    // on document and would otherwise take Escape and preventDefault the native dismissal.
    // Not calling preventDefault here keeps the browser's own Escape → cancel → close.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(chosen);
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    list.querySelector<HTMLButtonElement>('button')?.focus();
  });
}
