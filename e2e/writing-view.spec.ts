import { expect, test, type Locator } from '@playwright/test';
import { selectDocument, documentAction } from './settings-helpers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FOCUS_KEY = 'typebridge.focusMode.v1';
const PREFIX = 'typebridge.writingPosition.v1.';
const text = Array.from({ length: 140 }, (_, i) => `Строка ${i}: Привет 🙂`).join('\n');

test('Focus preference survives closing and reopening a real browser profile', async ({ playwright, browserName, baseURL }, testInfo) => {
  if (!baseURL) throw new Error('A Playwright baseURL is required');
  const appURL = new URL('/editor.html', baseURL).href;
  const options = { ...testInfo.project.use.launchOptions };
  if (testInfo.project.use.headless !== undefined) options.headless = testInfo.project.use.headless;
  if (testInfo.project.use.channel !== undefined) options.channel = testInfo.project.use.channel;
  const dir = await mkdtemp(join(tmpdir(), 'typebridge-writing-view-'));
  let context = await playwright[browserName].launchPersistentContext(dir, options);
  try {
    let page = await context.newPage();
    await page.goto(appURL);
    await expect(page.locator('#editor')).toBeEnabled();
    await page.locator('#editor').press('Escape');
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    await context.close();
    context = await playwright[browserName].launchPersistentContext(dir, options);
    page = await context.newPage();
    await page.goto(appURL);
    await expect(page.locator('#editor')).toBeEnabled();
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    await expect(page.locator('#editor')).toBeFocused();
  } finally { await context.close(); await rm(dir, { recursive: true, force: true }); }
});

async function position(field: Locator) {
  return field.evaluate((el: HTMLTextAreaElement) => ({
    start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, scrollTop: el.scrollTop,
  }));
}

test('Focus mode survives reload and new tabs without overwriting Normal-mode size', async ({ page, context }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  // Use the keyboard resize control so this checks the real size-persistence path.
  await page.locator('#resize-editor').press('ArrowRight');
  await page.locator('#resize-editor').press('ArrowDown');
  const normal = await field.evaluate(el => ({ width: el.style.width, height: el.style.height }));
  const size = await page.evaluate(() => localStorage.getItem('typebridge.editor.size.v1'));
  await field.press('Escape');
  await page.reload();
  await expect(field).toBeEnabled();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('typebridge.editor.size.v1'))).toBe(size);
  const other = await context.newPage();
  await other.goto('/editor.html');
  await expect(other.locator('#editor')).toBeEnabled();
  await expect(other.locator('body')).toHaveClass(/focus-mode/);
  await expect(other.locator('#editor')).toBeFocused();
  await other.close();
  await field.press('Escape');
  expect(await field.evaluate(el => ({ width: el.style.width, height: el.style.height }))).toEqual(normal);
  await page.reload();
  await expect(field).toBeEnabled();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  expect(await page.evaluate(key => localStorage.getItem(key), FOCUS_KEY)).toBe('off');
});

for (const focused of [false, true]) {
  test(`reload restores backward selection and editor scroll without changing text or Undo; Focus=${focused}`, async ({ page }) => {
    await page.goto('/editor.html');
    const field = page.locator('#editor');
    await expect(field).toBeEnabled();
    await field.fill(text);
    await expect(page.locator('#status')).toContainText('Saved locally');
    if (focused) await field.press('Escape');
    await field.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(900, 918, 'backward');
      el.scrollTop = 450;
      el.dispatchEvent(new Event('select'));
      el.dispatchEvent(new Event('scroll'));
    });
    const before = await position(field);
    await page.reload();
    await expect(field).toBeEnabled();
    await expect(field).toHaveValue(text);
    await expect.poll(() => position(field)).toEqual(before);
    if (focused) await expect(field).toBeFocused();
    // Restoring a view must not insert a history edit or destroy the saved history.
    await field.press('Control+z');
    await expect(field).toHaveValue('');
    await field.press('Control+Shift+z');
    await expect(field).toHaveValue(text);
  });
}

test('each draft and independent tab keeps its own writing position', async ({ page, context }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Первый черновик 🙂');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const first = await page.locator('#drafts').inputValue();
  await field.evaluate((el: HTMLTextAreaElement) => { el.setSelectionRange(3, 7); el.dispatchEvent(new Event('select')); });
  await documentAction(page, '#new-draft');
  await field.fill('Второй черновик');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const second = await page.locator('#drafts').inputValue();
  await field.evaluate((el: HTMLTextAreaElement) => { el.setSelectionRange(5, 5); el.dispatchEvent(new Event('select')); });
  await selectDocument(page, first);
  await expect.poll(() => position(field)).toMatchObject({ start: 3, end: 7 });
  await selectDocument(page, second);
  await expect.poll(() => position(field)).toMatchObject({ start: 5, end: 5 });
  const other = await context.newPage();
  await other.goto('/editor.html');
  await expect(other.locator('#editor')).toBeEnabled();
  await expect(other.locator('#editor')).toHaveValue('Второй черновик');
  await expect.poll(() => position(other.locator('#editor'))).toMatchObject({ start: 0, end: 0 });
  await other.locator('#editor').evaluate((el: HTMLTextAreaElement) => { el.setSelectionRange(9, 9); el.dispatchEvent(new Event('select')); });
  await page.reload();
  await expect(field).toBeEnabled();
  await expect.poll(() => position(field)).toMatchObject({ start: 5, end: 5 });
});

test('stale offsets clamp at Unicode boundaries and corrupt view metadata is ignored', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('a🙂');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const id = await page.locator('#drafts').inputValue();
  await page.addInitScript(({ key }) => sessionStorage.setItem(key, JSON.stringify({ start: 2, end: 900, direction: 'backward', scrollTop: 999999, scrollLeft: 0 })), { key: PREFIX + id });
  await page.reload();
  await expect(field).toBeEnabled();
  await expect.poll(() => position(field)).toMatchObject({ start: 3, end: 3, scrollTop: 0 });
  await expect(field).toHaveValue('a🙂');
  await page.addInitScript(({ key }) => sessionStorage.setItem(key, '{bad'), { key: PREFIX + id });
  await page.reload();
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue('a🙂');
});

test('blocked view storage starts normally and never prevents editing or toggling Focus', async ({ page }) => {
  await page.addInitScript(({ focus, prefix }) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === focus || key.startsWith(prefix)) throw new DOMException('blocked', 'SecurityError');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === focus || key.startsWith(prefix)) throw new DOMException('blocked', 'SecurityError');
      return set.call(this, key, value);
    };
  }, { focus: FOCUS_KEY, prefix: PREFIX });
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await field.fill('Не терять');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await field.press('Escape');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await page.reload();
  await expect(field).toBeEnabled();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await expect(field).toHaveValue('Не терять');
});

test('position events batch storage writes and pagehide flushes the latest selection immediately (#107)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Позиция 🙂 текста');
  await expect(page.locator('#status')).toContainText('Saved locally');
  // Let boot/input-generated selection events settle before measuring a new burst.
  await page.waitForTimeout(300);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.evaluate(() => {
    const w = window as unknown as { positionWrites: number };
    w.positionWrites = 0;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('typebridge.writingPosition.v1.')) w.positionWrites++;
      original.call(this, key, value);
    };
    const area = document.querySelector<HTMLTextAreaElement>('#editor')!;
    for (let i = 1; i <= 8; i++) {
      area.setSelectionRange(i, i);
      area.dispatchEvent(new Event('select'));
      area.dispatchEvent(new Event('keyup'));
    }
  });
  const writes = () => page.evaluate(() => (window as unknown as { positionWrites: number }).positionWrites);
  await page.clock.runFor(249);
  expect(await writes()).toBe(0);
  await page.clock.runFor(1);
  expect(await writes()).toBe(1);
  const id = await page.locator('#drafts').inputValue();
  await field.evaluate((area: HTMLTextAreaElement) => {
    area.setSelectionRange(2, 5, 'backward');
    area.dispatchEvent(new Event('select'));
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(await writes()).toBe(2);
  const saved = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), PREFIX + id);
  expect(saved).toMatchObject({ start: 2, end: 5, direction: 'backward' });
  await page.clock.runFor(300);
  expect(await writes()).toBe(2);
});

test('restoring Focus after delayed startup keeps the control the user focused (#107)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('typebridge.focusMode.v1', 'on');
    (window as unknown as { __typebridgeDelayAcquireMs: number }).__typebridgeDelayAcquireMs = 1000;
  });
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeDisabled();
  const mode = page.locator('#enabled');
  await mode.focus();
  await expect(mode).toBeFocused();
  await expect(field).toBeEnabled();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(mode).toBeFocused();
});

for (const fail of [false, true]) {
  test(`position cleanup follows successful deletion only; failed=${fail} (#107)`, async ({ page }) => {
    await page.goto('/editor.html');
    const field = page.locator('#editor');
    await expect(field).toBeEnabled();
    await field.fill('Позиция документа');
    await expect(page.locator('#status')).toContainText('Saved locally');
    const id = await page.locator('#drafts').inputValue();
    await field.evaluate((area: HTMLTextAreaElement) => {
      area.setSelectionRange(2, 4, 'backward');
      area.dispatchEvent(new Event('select'));
      window.dispatchEvent(new Event('pagehide'));
    });
    const key = PREFIX + id;
    expect(await page.evaluate(key => sessionStorage.getItem(key), key)).not.toBeNull();
    if (fail) await page.evaluate(() => {
      IDBObjectStore.prototype.delete = function () { throw new DOMException('blocked', 'UnknownError'); };
    });
    await documentAction(page, '#delete-draft');
    await page.getByRole('dialog', { name: 'Delete document?' }).getByRole('button', { name: 'Delete document', exact: true }).click();
    await expect(page.locator('#status')).toContainText(fail ? 'Could not delete' : 'Document deleted');
    // Let queued select/scroll events and debounce timers run: deleted keys must stay absent.
    await page.waitForTimeout(350);
    const stored = await page.evaluate(key => sessionStorage.getItem(key), key);
    if (fail) expect(stored).not.toBeNull();
    else expect(stored).toBeNull();
  });
}

test('list refresh prunes obsolete positions without touching another window or viewer (#107)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const current = await page.locator('#drafts').inputValue();
  const keys = [PREFIX + current, PREFIX + 'obsolete', PREFIX + 'w:other.obsolete', PREFIX + 'view:obsolete'];
  await page.evaluate(keys => { for (const key of keys) sessionStorage.setItem(key, '{}'); }, keys);
  await page.locator('#doc-menu-open').click();
  await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), keys[1]!)).toBeNull();
  for (const key of [keys[0]!, keys[2]!, keys[3]!]) {
    expect(await page.evaluate(key => sessionStorage.getItem(key), key)).not.toBeNull();
  }
});

test('a failed list refresh leaves position keys untouched (#107)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const key = PREFIX + 'obsolete';
  await page.evaluate(key => {
    sessionStorage.setItem(key, '{}');
    IDBObjectStore.prototype.getAll = function () { throw new DOMException('blocked', 'UnknownError'); };
  }, key);
  await page.locator('#doc-menu-open').click();
  await expect(page.locator('#doc-menu')).toBeVisible();
  // The failed refresh must not turn the previous list into authority for pruning.
  await page.waitForTimeout(350);
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBe('{}');
});

for (const viewer of [false, true]) {
  test(`startup prunes its namespace and restores saved selection once; viewer=${viewer} (#107)`, async ({ page }) => {
    await page.goto('/editor.html');
    const field = page.locator('#editor');
    await expect(field).toBeEnabled();
    await field.fill(text);
    await expect(page.locator('#status')).toContainText('Saved locally');
    const id = await page.locator('#drafts').inputValue();
    const prefix = PREFIX + (viewer ? 'view:' : '');
    await page.addInitScript(({ key, stale, other }) => {
      sessionStorage.setItem(key, JSON.stringify({ start: 900, end: 918, direction: 'backward', scrollTop: 450, scrollLeft: 0 }));
      sessionStorage.setItem(stale, '{}');
      sessionStorage.setItem(other, '{}');
      const win = window as unknown as { restoreSelectionCalls: number };
      win.restoreSelectionCalls = 0;
      const original = HTMLTextAreaElement.prototype.setSelectionRange;
      HTMLTextAreaElement.prototype.setSelectionRange = function (start, end, direction) {
        if (this.id === 'editor' && start === 900 && end === 918 && direction === 'backward') win.restoreSelectionCalls++;
        original.call(this, start, end, direction);
      };
    }, { key: prefix + id, stale: prefix + 'obsolete', other: PREFIX + 'w:other.obsolete' });
    await page.goto(viewer ? `/editor.html?doc=${id}&mode=view` : '/editor.html');
    await expect(field).toBeEnabled();
    await expect(field).toHaveValue(text);
    await expect.poll(() => position(field)).toMatchObject({ start: 900, end: 918, direction: 'backward', scrollTop: 450 });
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), prefix + 'obsolete')).toBeNull();
    expect(await page.evaluate(() => (window as unknown as { restoreSelectionCalls: number }).restoreSelectionCalls)).toBe(1);
    expect(await page.evaluate(key => sessionStorage.getItem(key), PREFIX + 'w:other.obsolete')).toBe('{}');
  });
}

for (const storageFails of [false, true]) {
  test(`missing viewer startup handles pruning safely; storage failure=${storageFails} (#107)`, async ({ page }) => {
    await page.addInitScript(({ key, fail }) => {
      sessionStorage.setItem(key, '{}');
      if (fail) Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new Error('blocked'); } } });
    }, { key: PREFIX + 'view:obsolete', fail: storageFails });
    await page.goto('/editor.html?doc=11111111-1111-4111-8111-111111111111&mode=view');
    await expect(page.locator('#editor')).toBeEnabled();
    await expect(page.locator('#editor')).toHaveValue('');
    await expect(page.locator('#viewer-notice')).toContainText(storageFails ? 'storage is unavailable' : 'no longer available');
    const stored = await page.evaluate(key => sessionStorage.getItem(key), PREFIX + 'view:obsolete');
    expect(stored).toBe(storageFails ? '{}' : null);
  });
}

test('startup pruning retains the recovered unsaved public document position (#107)', async ({ page }) => {
  const id = '22222222-2222-4222-8222-222222222222';
  await page.addInitScript(({ id, text, key }) => {
    localStorage.setItem('typebridge.autosave.v1', 'on');
    // Keep this public recovery unsaved via storage failure; new private documents retain no positions (#257).
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'documents') throw new DOMException('save blocked', 'QuotaExceededError');
      return put.apply(this, args);
    };
    sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify({
      id, title: 'Recovered position', text, updatedAt: Date.now(), revision: 0,
    }));
    sessionStorage.setItem(key, JSON.stringify({ start: 900, end: 918, direction: 'backward', scrollTop: 450, scrollLeft: 0 }));
  }, { id, text, key: PREFIX + id });
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue(text);
  await expect(page.locator('#drafts')).toHaveValue(id);
  await expect.poll(() => position(field)).toMatchObject({ start: 900, end: 918, direction: 'backward', scrollTop: 450 });
  expect(await page.evaluate(key => sessionStorage.getItem(key), PREFIX + id)).not.toBeNull();
});

test('removing position beforeunload handling preserves the unsaved-document warning (#107)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('typebridge.autosave.v1', 'off'));
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await expect(page.locator('#autosave')).not.toBeChecked();
  await field.fill('Приватный несохранённый текст');
  const prevented = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(field).toHaveValue('Приватный несохранённый текст');
  // Position-only cleanup must not weaken the privacy/unsaved leave guard.
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1'))).toBeNull();
});
