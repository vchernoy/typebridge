import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { renderActive } from '@vchernoy/remark-active';
import type { Mounted } from '@vchernoy/active-runtime';

test('installed ActiveMD runtime restores model-only and visible inputs before refresh and resets defaults', async ({ page }) => {
  const bundle = await build({ configFile: false, build: { write: false,
    lib: { entry: resolve('node_modules/@vchernoy/active-runtime/dist/index.js'), name: 'ActiveRuntimeFixture', formats: ['iife'] },
    rolldownOptions: { output: { codeSplitting: false } },
  } });
  const outputs = Array.isArray(bundle) ? bundle : [bundle];
  const code = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
  if (!code || code.type !== 'chunk') throw new Error('Missing installed-runtime browser bundle');
  const source = '```calc\ninput x = 2 in 1..10\ninput seed = 3 in 0..20\ny = x + seed\n```\n\n:input[x] :input[x]{widget=slider step=1}\n\n:value[y]\n\n$y={{y}}$\n\n:::when[x > 4]\nVisible\n:::';
  const rendered = renderActive(source, { locale: 'en-US' });
  expect(rendered.messages).toEqual([]);
  await page.setContent(rendered.html); await page.addScriptTag({ content: code.code });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { ActiveRuntimeFixture: { mount: typeof import('@vchernoy/active-runtime').mount } }).ActiveRuntimeFixture;
    const live: Mounted = api.mount(document.body, { initialInputs: new Map([['x', 5], ['seed', 7]]), locale: 'en-US' });
    const snapshot = () => ({ values: [...live.session.inputValues()], controls: [...document.querySelectorAll('input')].map(input => input.value),
      output: document.querySelector('output[data-active-value="y"]')?.textContent,
      math: document.querySelector('math mn')?.textContent,
      hidden: document.querySelector<HTMLElement>('[data-active-when]')?.hidden });
    await live.settled(); const restored = snapshot();
    live.resetInputs(); await live.settled(); const reset = snapshot(); live.destroy();
    return { restored, reset };
  });
  expect(result.restored).toEqual({ values: [['x', 5], ['seed', 7]], controls: ['5', '5'], output: '12', math: '12', hidden: false });
  expect(result.reset).toEqual({ values: [['x', 2], ['seed', 3]], controls: ['2', '2'], output: '5', math: '5', hidden: true });
});
