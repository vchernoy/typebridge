import { expect, test, type Page } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';
const source = '```calc\ninput x = 2 in 1..10\ninput seed = 3 in 0..20\ny = x + seed\n```\n\n:input[x] :value[y]\n\n$y={{y}}$\n\n:::when[x > 4]\nRevealed\n:::';
async function link(title = 'State fixture') {
  const result = await encodeSharePayload({ title, text: source, format: 'markdown', view: 'rendered', edit: false });
  if (!result.ok) throw new Error('Encoding failed');
  return '/read.html#doc=' + result.payload;
}
async function states(page: Page) {
  return page.evaluate(() => new Promise<{ id: string; revision: number; inputs: [string, number][] }[]>((resolve, reject) => {
    const open = indexedDB.open('typebridge'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const tx = db.transaction('readerStates'); const get = tx.objectStore('readerStates').getAll();
      tx.oncomplete = () => { db.close(); resolve(get.result.filter(row => row.id.startsWith('shared:'))); }; tx.onabort = () => reject(tx.error); };
  }));
}
async function ready(page: Page, x = '2', output = '5') {
  await expect(page.locator('#read-text input')).toHaveValue(x);
  await expect(page.locator('#read-text output')).toHaveText(output);
  await expect(page.locator('#read-text math mn')).toHaveText(output);
}
async function save(page: Page, value: string) {
  await page.locator('#read-text input').fill(value);
  await expect(page.locator('#reader-input-status')).toHaveText('Inputs saved on this device.');
  await expect.poll(async () => (await states(page))[0]?.inputs.find(([name]) => name === 'x')?.[1]).toBe(Number(value));
}
test('accepted inputs restore controls/math/when without changing payload or editable documents', async ({ page }) => {
  const url = await link(); await page.goto(url); await ready(page);
  await save(page, '5');
  await page.locator('#read-text input').fill('0');
  await expect(page.locator('#read-text input')).toHaveAttribute('aria-invalid', 'true');
  expect((await states(page))[0].inputs).toEqual([['x', 5], ['seed', 3]]);
  await page.reload(); await ready(page, '5', '8');
  await expect(page.locator('#read-text [data-active-when]')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  expect(await page.evaluate(() => new Promise<number>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => { const db = r.result; const q = db.transaction('documents').objectStore('documents').count(); q.onsuccess = () => { db.close(); resolve(q.result); }; }; }))).toBe(0);
});
test('restores model-only values, ignores unknown/out-of-range inputs, and captures accepted model values', async ({ page }) => {
  const url = await link(); await page.goto(url); await ready(page);
  await page.evaluate(() => new Promise<void>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => { const db = r.result; const tx = db.transaction(['sharedItems', 'readerStates'], 'readwrite'); const get = tx.objectStore('sharedItems').getAll(); get.onsuccess = () => tx.objectStore('readerStates').put({ id: 'shared:' + get.result[0].id, version: 1, revision: 1, inputs: [['x', 99], ['seed', 7], ['missing', 42]] }); tx.oncomplete = () => { db.close(); resolve(); }; }; }));
  await page.reload(); await ready(page, '2', '9');
  await save(page, '6');
  expect((await states(page))[0].inputs).toEqual([['x', 6], ['seed', 7]]);
  await page.reload(); await ready(page, '6', '13');
});
test('concurrent readers require explicit conflict resolution; reset defeats stale queued saves', async ({ page, context }) => {
  const url = await link(); await page.goto(url); await ready(page);
  const other = await context.newPage(); await other.goto(url); await ready(other);
  await save(page, '5');
  await expect(other.locator('#reader-input-load')).toBeVisible();
  await other.locator('#read-text input').fill('7');
  await other.locator('#reader-input-keep').click();
  await expect.poll(async () => (await states(other))[0]?.inputs.find(([name]) => name === 'x')?.[1]).toBe(7);
  await page.locator('#reader-input-load').click(); await ready(page, '7', '10');
  await page.locator('#reader-input-reset').click(); await ready(page);
  await expect.poll(async () => (await states(page))[0]?.inputs).toEqual([]);
  await expect(other.locator('#reader-input-load')).toBeVisible();
  await other.locator('#reader-input-load').click(); await ready(other);
  await page.reload(); await ready(page);
});
test('keys stay isolated and opt-out changes remain memory-only after re-enabling', async ({ page, context }) => {
  await page.goto(await link()); await ready(page); await save(page, '5');
  const other = await context.newPage(); await other.goto(await link('Other immutable key')); await ready(other);
  await other.locator('summary').filter({ hasText: 'Local shared library' }).click();
  await other.locator('#remember-shared').uncheck(); await other.locator('#read-text input').fill('8');
  await other.locator('#remember-shared').check();
  await expect(other.locator('#reader-input-status')).toContainText('temporary');
  await other.reload(); await ready(other);
  await page.reload(); await ready(page, '5', '8');
});

test('incompatible saved schema uses readable defaults without rewriting the state', async ({ page }) => {
  const url = await link(); await page.goto(url); await ready(page); await save(page, '5');
  await page.evaluate(() => new Promise<void>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('readerStates', 'readwrite'); const get = tx.objectStore('readerStates').getAll(); get.onsuccess = () => { const row = get.result.find(row => row.id.startsWith('shared:')); tx.objectStore('readerStates').put({ ...row, version: 99 }); }; tx.oncomplete = () => { db.close(); resolve(); }; }; }));
  await page.reload(); await ready(page);
  await expect(page.locator('#reader-input-status')).toContainText('temporary');
  await page.locator('#read-text input').fill('6');
  await page.locator('#reader-input-reset').click(); await ready(page);
  expect((await states(page))[0].inputs).toEqual([['x', 5], ['seed', 3]]);
});
test('source/plain paths leave stored inputs unchanged and fetch no renderer', async ({ page }) => {
  const encoded = await encodeSharePayload({ title: 'Source only', text: source, format: 'markdown', view: 'source', edit: false });
  if (!encoded.ok) throw new Error('Encoding failed');
  const requests: string[] = []; page.on('request', r => requests.push(r.url()));
  await page.goto('/read.html#doc=' + encoded.payload);
  await expect(page.locator('#read-text')).toHaveText(source);
  await expect(page.locator('#reader-input-state')).toBeHidden();
  await expect(page.locator('#shared-memory-status')).toContainText('Remembered');
  expect(await states(page)).toEqual([]);
  expect(requests.filter(path => /active-renderer|katex|\.woff2/.test(path))).toEqual([]);
});
test('removing an item cancels its old reader state without resurrecting it', async ({ page, context }) => {
  await page.goto(await link()); await ready(page); await save(page, '5');
  const editor = await context.newPage(); await editor.goto('/editor.html');
  await expect(editor.locator('#editor')).toBeEnabled();
  await editor.locator('#doc-menu-open').click(); await editor.getByText('Shared with me', { exact: true }).click();
  await editor.getByRole('button', { name: 'Remove shared document State fixture', exact: true }).click();
  await expect(page.locator('#reader-input-status')).toContainText('temporary');
  await page.locator('#read-text input').fill('7');
  await page.locator('#reader-input-reset').click(); await ready(page);
  expect(await states(page)).toEqual([]);
});
test('stored values reopen offline after the normal shell and renderer caches are installed', async ({ page, context }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.evaluate(() => navigator.serviceWorker.ready);
  const url = await link(); await page.goto(url); await ready(page); await save(page, '5');
  await context.setOffline(true);
  await page.reload(); await ready(page, '5', '8');
  await save(page, '6');
  await page.reload(); await ready(page, '6', '9');
});

for (const gate of ['private', 'unreadable'] as const) {
  test(`reader inputs remain memory-only when preferences are ${gate}`, async ({ page }) => {
    await page.addInitScript(gate => {
      if (gate === 'private') localStorage.setItem('typebridge.autosave.v1', 'off');
      else {
        const get = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) { if (key === 'typebridge.autosave.v1') throw new Error('Preference denied'); return get.call(this, key); };
      }
    }, gate);
    await page.goto(await link()); await ready(page);
    await page.locator('#read-text input').fill('7');
    await expect(page.locator('#read-text output')).toHaveText('10');
    await expect(page.locator('#reader-input-status')).toContainText('temporary');
    expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
    await page.reload(); await ready(page);
  });
}
test('quota refusal preserves readable values without claiming they were saved', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'readerStates' && value?.id?.startsWith('shared:')) throw new DOMException('Quota fixture', 'QuotaExceededError');
      return put.call(this, value, key);
    };
  });
  await page.goto(await link()); await ready(page);
  await page.locator('#read-text input').fill('7');
  await expect(page.locator('#reader-input-status')).toContainText('Could not save inputs');
  await expect(page.locator('#read-text output')).toHaveText('10');
  expect(await states(page)).toEqual([]);
  await page.reload(); await ready(page);
});
test('hash navigation cancels a queued old snapshot without touching the next key', async ({ page }) => {
  const original = await link(); await page.goto(original); await ready(page); await save(page, '5');
  await page.locator('#read-text input').fill('7');
  await page.evaluate(url => { location.hash = new URL(url, location.href).hash; }, await link('Next key'));
  await ready(page);
  expect((await states(page))[0].inputs).toEqual([['x', 5], ['seed', 3]]);
  await page.goto(original); await ready(page, '5', '8');
});
test('global clear ends old input writers and does not restore their saved state', async ({ page, context }) => {
  await page.goto(await link()); await ready(page); await save(page, '5');
  const editor = await context.newPage(); await editor.goto('/editor.html');
  await expect(editor.locator('#editor')).toBeEnabled();
  await editor.locator('#settings-open').click(); await editor.locator('#clear-local-data').click();
  await editor.getByRole('dialog', { name: 'Clear local data?' }).getByRole('button', { name: 'Clear local data', exact: true }).click();
  await ready(page);
  await expect(page.locator('#reader-input-status')).toContainText('temporary');
  expect(await states(editor)).toEqual([]);
});

test('restored values agree on the first visible render and a late old open cannot replace a new key', async ({ page }) => {
  const original = await link(); await page.goto(original); await ready(page); await save(page, '5');
  await page.addInitScript(() => {
    const values: string[] = []; (window as unknown as { visibleReaderValues: string[] }).visibleReaderValues = values;
    new MutationObserver(() => {
      const input = document.querySelector<HTMLInputElement>('#read-text input');
      if (input && getComputedStyle(input).visibility === 'visible' && input.getClientRects().length) values.push(input.value);
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  await page.reload(); await ready(page, '5', '8');
  const seen = await page.evaluate(() => (window as unknown as { visibleReaderValues: string[] }).visibleReaderValues);
  expect(seen.length).toBeGreaterThan(0); expect(seen.every(value => value === '5')).toBe(true);
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB); let count = 0;
    indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
      const request = open(...args);
      if (++count === 2) {
        let handler: ((event: Event) => void) | null = null;
        Object.defineProperty(request, 'onsuccess', { get: () => handler, set: value => { handler = value; } });
        request.addEventListener('success', event => {
          (window as unknown as { releaseInputOpen: () => void }).releaseInputOpen = () => { handler?.call(request, event); };
        }, { once: true });
      }
      return request;
    };
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseInputOpen?: unknown }).releaseInputOpen)).toBe('function');
  await page.evaluate(url => { location.hash = new URL(url, location.href).hash; }, await link('New key after held open'));
  await ready(page);
  await page.evaluate(() => (window as unknown as { releaseInputOpen: () => void }).releaseInputOpen());
  await expect(page.locator('#read-title')).toHaveText('New key after held open'); await ready(page);
  expect((await states(page))[0].inputs).toEqual([['x', 5], ['seed', 3]]);
});

test('blocked initial state load falls back to defaults and a late open never hydrates it', async ({ page }) => {
  const url = await link(); await page.goto(url); await ready(page); await save(page, '5');
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB); let count = 0;
    indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
      const request = open(...args);
      if (++count === 2) {
        let handler: ((event: Event) => void) | null = null;
        Object.defineProperty(request, 'onsuccess', { get: () => handler, set: value => { handler = value; } });
        request.addEventListener('success', event => { (window as unknown as { releaseInputOpen: () => void }).releaseInputOpen = () => { handler?.call(request, event); }; }, { once: true });
      }
      return request;
    };
  });
  await page.clock.install(); await page.reload();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseInputOpen?: unknown }).releaseInputOpen)).toBe('function');
  await page.clock.fastForward(2100); await ready(page);
  await expect(page.locator('#reader-input-status')).toContainText('temporary');
  await page.evaluate(() => (window as unknown as { releaseInputOpen: () => void }).releaseInputOpen());
  await page.locator('#read-text input').fill('7');
  await expect(page.locator('#read-text output')).toHaveText('10');
  expect((await states(page))[0].inputs).toEqual([['x', 5], ['seed', 3]]);
});
test('reader state controls fit 320px and provide a keyboard reset target', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(await link()); await ready(page); await save(page, '5');
  const button = page.locator('#reader-input-reset');
  const rect = await button.evaluate(element => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height }; });
  expect(rect.width).toBeGreaterThanOrEqual(44); expect(rect.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await button.focus(); await page.keyboard.press('Enter'); await ready(page);
  await expect.poll(async () => (await states(page))[0]?.inputs).toEqual([]);
  await expect(button).toBeFocused();
  await page.screenshot({ path: '/tmp/324-reader-phone.png', fullPage: true });
});

test('history restore reads saved values without rearming writes from the abandoned mount', async ({ page }) => {
  await page.goto(await link()); await ready(page); await save(page, '5');
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await ready(page, '5', '8');
  await expect(page.locator('#reader-input-status')).toContainText('temporary');
  await page.locator('#read-text input').fill('7');
  await page.locator('#reader-input-reset').click(); await ready(page);
  expect((await states(page))[0].inputs).toEqual([['x', 5], ['seed', 3]]);
});
