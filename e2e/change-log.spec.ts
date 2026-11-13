import { expect, test, type Page } from '@playwright/test';
import { replayText, type ChangeRecord } from '../src/editor/change-log';
import { setAutosave } from './settings-helpers';

// The change log (#37 R2c step 2b): every edit with Autosave on is a small record; a full save
// says which records it contains (upTo) and removes them. Recovery from it comes in step 2c.
type Row = { id: string; title: string; text: string; revision: number; upTo?: number; private?: boolean };

async function readLog(page: Page): Promise<{ rows: Row[]; changes: ChangeRecord[] }> {
  return page.evaluate(() => new Promise<{ rows: Row[]; changes: ChangeRecord[] }>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['documents', 'changes'], 'readonly');
      const rows = tx.objectStore('documents').getAll();
      const changes = tx.objectStore('changes').getAll();
      tx.oncomplete = () => {
        db.close();
        resolve({
          rows: (rows.result as Row[]).map(({ id, title, text, revision, upTo, private: isPrivate }) => ({
            id, title, text, revision, upTo, private: isPrivate,
          })),
          changes: changes.result as ChangeRecord[],
        });
      };
      tx.onerror = () => reject(tx.error);
    };
  }));
}

/** What crash recovery would rebuild for the only document: its stored row plus its log. */
async function rebuilt(page: Page): Promise<string> {
  const { rows, changes } = await readLog(page);
  const row = rows[0]!;
  return replayText(row.id, row.text, row.upTo ?? 0, changes).text;
}

const holdSaves = (page: Page) => page.evaluate(() => {
  (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 60_000;
});

test('each edit is logged so the saved row plus the log is the shown text', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Первая версия');
  await expect(page.locator('#status')).toContainText('Saved locally');
  // The first save starts the run (a run never starts from shown text): it contains no records yet.
  let log = await readLog(page);
  expect(log.rows).toHaveLength(1);
  expect(log.rows[0]!.upTo).toBe(0);
  expect(log.changes).toEqual([]);
  // With saves held, typing reaches storage only through the log.
  await holdSaves(page);
  await field.press('End');
  await page.keyboard.type(' и ещё 🙂');
  await page.keyboard.press('Enter');
  await page.keyboard.type('строка');
  await page.keyboard.press('Backspace');
  await expect(field).toHaveValue('Первая версия и ещё 🙂\nстрок');
  await expect.poll(() => rebuilt(page)).toBe('Первая версия и ещё 🙂\nстрок');
  log = await readLog(page);
  const seqs = log.changes.map(c => c.seq).sort((a, b) => a - b);
  expect(seqs[0]).toBe((log.rows[0]!.upTo ?? 0) + 1);
  expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
  expect(new Set(log.changes.map(c => c.run)).size).toBe(1);
});

test('Undo is logged like any other change', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Основа');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await holdSaves(page);
  await field.press('End');
  await page.keyboard.type(' лишнее');
  await page.locator('#undo').click();
  const undone = await field.inputValue();
  expect(undone).not.toBe('Основа лишнее');
  await expect.poll(() => rebuilt(page)).toBe(undone);
});

test('with Autosave off nothing reaches the change log', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Видно');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await setAutosave(page, false);
  await field.fill('Личный черновик');
  await page.keyboard.type(' ещё');
  // Give a stray write every chance to land before checking.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  expect((await readLog(page)).changes).toEqual([]);
});

test('turning Autosave off while a save waits for the change log saves no private text (#251 review)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Видно');
  await expect(page.locator('#status')).toContainText('Saved locally');
  // Hold the change-log write so the next save is still waiting for it.
  await page.evaluate(() => { (window as unknown as { __typebridgeDelayChangeAppendMs: number }).__typebridgeDelayChangeAppendMs = 2_000; });
  await field.press('End');
  await page.keyboard.type('!');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500))); // the save starts and waits
  // Autosave goes off and private text is typed before the held write lands.
  await page.evaluate(() => {
    const box = document.querySelector<HTMLInputElement>('#autosave')!;
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await field.press('End');
  await page.keyboard.type(' секрет');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 2_500))); // the held write lands
  const { rows } = await readLog(page);
  expect(rows.map(row => row.text).join()).not.toContain('секрет');
});

test('going private abandons queued change records for later private typing (#257 / #251)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Удалить всё');
  await expect(page.locator('#status')).toContainText('Saved locally');
  // Hold the change-log write so it is still queued when going private.
  await page.evaluate(() => { (window as unknown as { __typebridgeDelayChangeAppendMs: number }).__typebridgeDelayChangeAppendMs = 800; });
  await field.press('End');
  await page.keyboard.type('!?');
  await setAutosave(page, false);
  await expect(page.locator('#private-marker')).toBeVisible();
  await field.press('End');
  await page.keyboard.type(' секрет');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 2_000))); // every held write has landed
  const log = await readLog(page);
  expect(log.rows).toHaveLength(1);
  expect(log.rows[0]!.private).toBe(true);
  expect(log.rows.map(row => row.text).join()).not.toContain('секрет');
  expect(log.changes).toEqual([]);
});

test('upgrading a version 2 database keeps documents and ownership and adds the change log', async ({ page }) => {
  await page.goto('/icon-192.png');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 2);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('documents', { keyPath: 'id' }).put({ id: 'v2', title: 'Старый', text: 'Текст v2', updatedAt: 1, revision: 4 });
      open.result.createObjectStore('editOwnership', { keyPath: 'documentId' });
    };
    open.onsuccess = () => { open.result.close(); resolve(); };
    open.onerror = () => reject(open.error);
  }));
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toHaveValue('Текст v2');
  // A row from before the log has no upTo. A run starts at the first save, never from shown text.
  await page.locator('#editor').press('End');
  await page.keyboard.type('!');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await holdSaves(page);
  await page.keyboard.type('?');
  await expect.poll(() => rebuilt(page)).toBe('Текст v2!?');
});

test('after a tab crash, unsaved text from the change log comes back as a copy without a click (#37 R2c)', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Page.crash requires Chromium CDP');
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#draft-title').fill('Заметка');
  await field.fill('Оригинал');
  await expect(page.locator('#status')).toContainText('Saved locally');
  // Saves are held, so the unsaved text and title exist only in the change log (and the journal).
  // Renaming before the crash must land in the recovered copy's title (#37 R2c 2d-1); fails on
  // old code that recovers with the stored title "Заметка (recovered)".
  await holdSaves(page);
  await page.locator('#draft-title').fill('Новое имя');
  await field.click();
  await field.press('End');
  await page.keyboard.type(' — несохранённое 🙂');
  await expect.poll(() => rebuilt(page)).toBe('Оригинал — несохранённое 🙂');
  await expect.poll(async () => {
    const { changes } = await readLog(page);
    return changes.some(c => c.title === 'Новое имя');
  }).toBe(true);
  const crashed = page.waitForEvent('crash');
  const cdp = await context.newCDPSession(page);
  void cdp.send('Page.crash').catch(() => { /* The renderer closes the command; the crash event is required. */ });
  await crashed;
  const next = await context.newPage();
  await next.goto('/editor.html');
  await expect(next.locator('#editor')).toHaveValue('Оригинал');
  await expect(next.locator('#status')).toContainText('Recovered unsaved text from an earlier session as “Новое имя (recovered)”');
  const log = await readLog(next);
  expect(log.rows.find(row => row.text === 'Оригинал — несохранённое 🙂' && row.title === 'Новое имя (recovered)')).toBeDefined();
  expect(log.rows.find(row => row.text === 'Оригинал')).toBeDefined();
  expect(log.changes).toEqual([]);
  // The journal held the same text and title: it is not offered a second time.
  await expect(next.getByRole('button', { name: /^Recover / })).toHaveCount(0);
  await page.close();
});
