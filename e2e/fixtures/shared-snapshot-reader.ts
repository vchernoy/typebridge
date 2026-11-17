/** Exercise the supported receiver boundary without enabling v2 product routes. */
import { prepareSharedInputs } from '../../src/read/shared-inputs';
import { renderDocument } from '../../src/view/active-renderer';
import type { InputSnapshot } from '../../src/editor/input-snapshot';

export const source = '```calc\ninput x = 2 in 1..10\ninput seed = 3 in 0..20\ny = x + seed\n```\n\n:input[x] :value[y]\n\n$y={{y}}$\n\n:::when[x > 4]\nRevealed\n:::';
let generation = 0;
let controller: Awaited<ReturnType<typeof prepareSharedInputs>> | undefined;
let live: ReturnType<typeof renderDocument> | undefined;
export async function mount(payload: string, incoming: InputSnapshot) {
  const token = ++generation;
  controller?.destroy(); live?.destroy();
  document.querySelector('#snapshot-fixture')?.remove();
  const section = document.createElement('section'); section.id = 'snapshot-fixture';
  const root = document.createElement('div'); root.id = 'snapshot-root'; root.style.visibility = 'hidden';
  const panel = document.createElement('div');
  const status = document.createElement('p'); status.id = 'snapshot-status';
  const reset = document.createElement('button'); reset.id = 'snapshot-reset'; reset.textContent = 'Reset';
  const load = document.createElement('button'), keep = document.createElement('button');
  panel.append(status, reset, load, keep); section.append(root, panel); document.body.append(section);
  controller = await prepareSharedInputs(payload, undefined, () => token === generation, () => true,
    { panel, status, reset, load, keep }, () => {}, incoming);
  live = renderDocument(root, source, 'en', controller.initialInputs);
  await live.settled();
  controller.bind(live);
  root.style.visibility = 'visible';
  // Capture synchronously at the reveal boundary, before a later update could mask a flash.
  return { input: root.querySelector('input')?.value, output: root.querySelector('output')?.textContent,
    math: root.querySelector('math mn')?.textContent,
    conditional: !root.querySelector<HTMLElement>('[data-active-when]')?.hidden };
}
