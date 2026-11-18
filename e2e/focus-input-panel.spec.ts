import { expect, test } from '@playwright/test';
import { readStoredDocs } from './storage-helpers';
const source = '```calc\ninput x = 2\ny = x * 3\n```\n\n:input[x] :value[y]\n\n' + 'Long synthetic paragraph.\n\n'.repeat(60) + 'Final visible paragraph.';
for (const width of [320, 1280]) for (const mode of ['standalone', 'embedded', 'comparison']) {
  test(`Focus keeps rendered content and input panel separate: ${mode} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
    await page.locator('#editor').fill(source);
    await page.locator('#doc-menu-open').click(); await page.locator('#document-format').selectOption('markdown'); await page.locator('#doc-menu-open').click();
    await expect(page.locator('#save-indicator')).toHaveText('Saved');
    const id = await page.locator('#drafts').inputValue();
    if (mode === 'embedded') await page.goto('/?open=' + id);
    if (mode === 'comparison') await page.goto('/editor.html?doc=' + id + '&mode=view');
    const ui = mode === 'embedded' ? page.frameLocator('.host-window[data-window-id="main"] iframe') : page;
    await ui.locator('#document-view-preview').click();
    const input = ui.locator('input[data-active-input="x"]'); await expect(input).toHaveValue('2');
    await input.fill('7'); await expect(ui.locator('#editable-input-status')).toHaveText('Inputs saved on this device.');
    const stored = await readStoredDocs(page, true);
    await page.evaluate(id => new Promise<void>(resolve => {
      const request = indexedDB.open('typebridge');
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('readerStates', 'readwrite'), store = tx.objectStore('readerStates');
        const row = store.get('editable:' + id);
        row.onsuccess = () => store.put({ ...row.result, revision: row.result.revision + 1, inputs: [['x', 9]] });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    }), id);
    await input.fill('8'); await expect(ui.locator('#editable-input-status')).toContainText('Saved inputs changed');
    await expect(ui.locator('#editable-input-load')).toBeVisible();
    for (const focus of [false, true, false]) {
      if (focus) await ui.locator('#focus-mode').click();
      else if (await ui.locator('#exit-focus').isVisible()) await ui.locator('#exit-focus').click();
      await expect(input).toHaveValue('8');
      const last = ui.getByText('Final visible paragraph.', { exact: true });
      await last.scrollIntoViewIfNeeded();
      const geometry = await ui.locator('#rendered-document').evaluate(root => {
        const panel = document.querySelector('#editable-input-state')!;
        const last = root.querySelector('.active-doc > p:last-child')!;
        const r = root.getBoundingClientRect(), p = panel.getBoundingClientRect(), l = last.getBoundingClientRect();
        return { rootBottom: r.bottom, panelTop: p.top, lastBottom: l.bottom, lastTop: l.top, height: innerHeight };
      });
      expect(geometry.rootBottom).toBeLessThanOrEqual(geometry.panelTop + 1);
      expect(geometry.lastBottom).toBeLessThanOrEqual(Math.min(geometry.rootBottom, geometry.height) + 1);
      expect(geometry.lastTop).toBeGreaterThanOrEqual(0);
      await expect(ui.locator('#editable-input-reset')).toBeVisible();
      const panel = ui.locator('#editable-input-state');
      if (mode === 'embedded') {
        const fits = await panel.evaluate(el => el.getBoundingClientRect().bottom <= innerHeight);
        expect(fits).toBe(true);
      }
      const overflow = await ui.locator('html').evaluate(el => ({ width: innerWidth, scroll: el.scrollWidth, offenders: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => ({tag:e.tagName,id:e.id,width:e.getBoundingClientRect().width})).slice(0,15) }));
      await page.screenshot({ path: `/tmp/374-${mode}-${width}-${focus ? "focus" : "normal"}.png` });
      expect(overflow, JSON.stringify({focus, overflow})).toMatchObject({ scroll: overflow.width });
    }
    await ui.locator('#editable-input-load').focus(); await page.keyboard.press('Enter');
    await expect(input).toHaveValue('9');
    const reset = ui.locator('#editable-input-reset'); await expect(reset).toBeFocused();
    await page.keyboard.press('Enter'); await expect(input).toHaveValue('2'); await expect(reset).toBeFocused();
    expect(await readStoredDocs(page, true)).toEqual(stored);
  });
}
