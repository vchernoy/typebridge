import { polishedMarkdown, assertPolishedMarkdown } from './markdown-polish-helpers';
import { expect, test, type Page } from '@playwright/test';
import { openFind, setAutosave } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

const source = `# Active document

:::note
A useful note.
:::

| Name | Value |
| --- | --- |
| A | B |

Inline $x={{y}}$.

$$
y={{y}}
$$

\`\`\`calc
input x = 2
y = x * 3
\`\`\`

:input[x] :value[y]
`;
async function markdown(page: Page, text = source): Promise<void> {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill(text);
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  await page.locator('#doc-menu-open').click();
  await expect(page.locator('#doc-menu')).toBeHidden();
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
}
async function rendered(page: Page): Promise<void> {
  await page.locator('#document-view-preview').click();
  await expect(page.locator('#rendered-document .active-doc')).toBeVisible();
}

test('Markdown format persists; rendered calc and MathML are temporary reader state', async ({ page }) => {
  await markdown(page);
  await rendered(page);
  const root = page.locator('#rendered-document');
  await expect(root.locator('.callout-note')).toContainText('A useful note');
  await expect(root.locator('table')).toContainText('Value');
  await expect(root.locator('math')).toHaveCount(2);
  const input = root.locator('input[data-active-input="x"]');
  await input.fill('4');
  await input.dispatchEvent('input');
  await expect(root.locator('output')).toHaveText('12');
  await expect(root.locator('math').first()).toContainText('12');
  const rows = await readStoredDocs(page, true);
  expect(rows[0]).toMatchObject({ text: source, format: 'markdown' });
  await page.reload();
  await expect(page.locator('#rendered-document .active-doc')).toBeVisible();
  await expect(page.locator('#rendered-document input')).toHaveValue('2');
  expect(await readStoredDocs(page, true)).toEqual(rows);
  await page.locator('#doc-menu-open').click();
  await expect(page.locator('#document-format')).toHaveValue('markdown');
});

test('rendered window follows another editor and problems navigate to source', async ({ page, context }) => {
  await markdown(page);
  const other = await context.newPage();
  await other.goto('/editor.html');
  await expect(other.locator('#editor')).toHaveValue(source);
  await rendered(other);
  await page.locator('#editor').fill(source.replace('A useful note.', 'Changed note.'));
  await expect(other.locator('.callout-note')).toContainText('Changed note.');
  await page.locator('#editor').fill('Title\n\n```calc\ny = unknown\n```');
  await expect(other.locator('#render-problems')).toBeVisible();
  await other.locator('#render-problems summary').click();
  await other.locator('#render-problem-list button').first().click();
  await expect(other.locator('#editor')).toBeVisible();
  const position = await other.locator('#editor').evaluate((el: HTMLTextAreaElement) => el.selectionStart);
  expect(position).toBeGreaterThanOrEqual('Title\n\n```calc\n'.length);
});

test('private format changes remain only in memory', async ({ page }) => {
  await page.goto('/editor.html');
  await page.locator('#editor').fill('Saved as plain');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await setAutosave(page, false);
  const before = await readStoredDocs(page, true);
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  await page.locator('#doc-menu-open').click();
  await expect(page.locator('#doc-menu')).toBeHidden();
  await rendered(page);
  expect(await readStoredDocs(page, true)).toEqual(before);
  expect(before.every(row => row.format !== 'markdown')).toBe(true);
});

test('Markdown reading area fits 320px with formulas scrolling locally', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await markdown(page, source + '\n$' + 'x+'.repeat(200) + 'x$');
  await rendered(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('plain documents never request active-md chunks, including offline installation', async ({ page, context }) => {
  const active: string[] = [];
  context.on('request', request => { if (/\/assets\/(active-renderer|katex)-/.test(request.url()) || request.resourceType() === 'font') active.push(request.url()); });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Plain text');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect(page.locator('#document-view')).toBeHidden();
  expect(active).toEqual([]);
});

test('rendered Markdown and changing math work offline after first online use', async ({ page, context }) => {
  await page.goto('/editor.html');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // The next navigation is controlled; renderer-only assets are cached by actual use.
  await markdown(page);
  await rendered(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#rendered-document input')).toHaveValue('2');
  await page.locator('#rendered-document input').fill('7');
  await expect(page.locator('#rendered-document output')).toHaveText('21');
  await expect(page.locator('#rendered-document math').first()).toContainText('21');
});

test('format changes follow the document across windows', async ({ page, context }) => {
  await page.goto('/editor.html');
  await page.locator('#editor').fill('# Shared format');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const other = await context.newPage(); await other.goto('/editor.html');
  await expect(other.locator('#editor')).toHaveValue('# Shared format');
  await expect(other.locator('#document-view')).toBeHidden();
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  await expect(other.locator('#document-view')).toBeVisible();
  await rendered(other);
  await expect(other.locator('#rendered-document h1')).toHaveText('Shared format');
  await page.locator('#document-format').selectOption('plain');
  await expect(other.locator('#document-view')).toBeHidden();
  await expect(other.locator('#editor')).toHaveValue('# Shared format');
});

test('switching to Rendered waits for composition to finish', async ({ page }) => {
  await markdown(page);
  await page.locator('#editor').dispatchEvent('compositionstart');
  await page.locator('#document-view-preview').click();
  await expect(page.locator('#document-view-edit')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#editor').dispatchEvent('compositionend', { data: '' });
  await rendered(page);
});

test('Format cannot edit a provisional document while storage is still opening', async ({ page }) => {
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args: Parameters<IDBFactory['open']>) {
      IDBFactory.prototype.open = open;
      const request = open.apply(this, args);
      let handler: ((event: Event) => void) | undefined;
      Object.defineProperty(request, 'onsuccess', { configurable: true, set(value: typeof handler) { handler = value; } });
      request.addEventListener('success', event => {
        (window as unknown as { releaseMarkdownBoot: () => void }).releaseMarkdownBoot = () => handler?.call(request, event);
      });
      return request;
    };
  });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeDisabled();
  await expect(page.locator('#document-format')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseMarkdownBoot?: unknown }).releaseMarkdownBoot)).toBe('function');
  await page.evaluate(() => (window as unknown as { releaseMarkdownBoot: () => void }).releaseMarkdownBoot());
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#document-format')).toBeEnabled();
});

test('entering Rendered preserves pending Find and Replace edits', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await markdown(page);
  await openFind(page);
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  await page.locator('#find-text').fill('pending find');
  await page.locator('#replace-text').fill('pending replacement');
  await page.locator('#document-view-preview').click();
  await page.clock.runFor(400);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const fields = await page.evaluate(() => new Promise<{ find: string; replace: string }>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const get = db.transaction('documents').objectStore('documents').getAll();
      get.onsuccess = () => { db.close(); resolve(get.result[0]); };
      get.onerror = () => reject(get.error);
    };
  }));
  expect(fields).toMatchObject({ find: 'pending find', replace: 'pending replacement' });
  await page.clock.resume();
  await page.reload();
  await page.locator('#document-view-edit').click();
  await openFind(page);
  await expect(page.locator('#find-text')).toHaveValue('pending find');
  await expect(page.locator('#replace-text')).toHaveValue('pending replacement');
});

test('published renderer keeps compact controls on one line and formatted math live', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await markdown(page, polishedMarkdown);
  await rendered(page);
  await assertPolishedMarkdown(page.locator('#rendered-document'));
});

for (const width of [320, 390, 1280]) {
  test(`Edit/Preview is one click on the title row at ${width}px, including Focus`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await markdown(page, '# Preview switch\n\nSame source.');
    const group = page.getByRole('group', { name: 'View', exact: true });
    const edit = group.getByRole('button', { name: 'Edit', exact: true });
    const preview = group.getByRole('button', { name: 'Preview', exact: true });
    await expect(edit).toHaveAttribute('aria-pressed', 'true');
    await expect(preview).toHaveAttribute('aria-pressed', 'false');
    const geometry = [];
    for (const focus of [false, true]) {
      if (focus) await page.locator('#focus-mode').click();
      await expect(group).toBeVisible();
      const boxes = await Promise.all(['#doc-menu-open', '#autosave', '#document-view', '#save-indicator'].map(id => page.locator(id).boundingBox()));
      const centres = boxes.map(box => box!.y + box!.height / 2);
      expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(4);
      // Autosave and its status stay adjacent; the view control follows both (#316).
      const autosave = (await page.locator('.autosave-doc-toggle').boundingBox())!;
      const saved = (await page.locator('#save-indicator').boundingBox())!;
      const view = (await group.boundingBox())!;
      expect(saved.x).toBeGreaterThanOrEqual(autosave.x + autosave.width);
      expect(saved.x - (autosave.x + autosave.width)).toBeLessThanOrEqual(8);
      expect(view.x).toBeGreaterThanOrEqual(saved.x + saved.width);
      const editTop = (await page.locator('#editor').boundingBox())!.y;
      await preview.click();
      await expect(preview).toHaveAttribute('aria-pressed', 'true');
      await expect(edit).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#editor')).toBeHidden();
      await expect(page.locator('#rendered-document h1')).toHaveText('Preview switch');
      const previewTop = (await page.locator('#rendered-document').boundingBox())!.y;
      expect(previewTop).toBeLessThanOrEqual(editTop);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (width <= 640) for (const button of [edit, preview]) {
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: testInfo.outputPath(`preview-${width}-${focus ? 'focus' : 'normal'}.png`) });
      // Native keyboard button behavior remains available with the icon-only UI.
      await edit.focus(); await edit.press('Enter');
      await expect(edit).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#editor')).toHaveValue('# Preview switch\n\nSame source.');
      geometry.push({ width, focus, editTop, previewTop });
    }
    await testInfo.attach('view-switch-geometry.json', { body: JSON.stringify(geometry), contentType: 'application/json' });
  });
}
