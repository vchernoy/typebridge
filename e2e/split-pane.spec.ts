import { expect, test, type Page } from '@playwright/test';
import { documentAction, openGoto, setAutosave } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

async function openSplit(page: Page): Promise<void> {
  await documentAction(page, '#toggle-split');
  await expect(page.locator('#editor-b')).toBeVisible();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-split', 'on');
}

test('Split editor shows a live same-document companion without a second save stream', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, false);
  await openSplit(page);
  await expect(page.locator('#editor-b')).toHaveAttribute('data-pane-id', 'pane-b');
  await expect(page.locator('#editor-b')).toHaveAttribute('data-pane-role', 'readonly');
  await expect(page.locator('#companion-badge')).toHaveText('Live view · Read-only');

  const field = page.locator('#editor');
  await field.fill('привет из панели');
  await expect(page.locator('#editor-b')).toHaveValue('привет из панели');
  await expect(page.locator('#save-indicator')).toHaveText('Not saved');

  // Companion stays independently selectable while mirroring.
  await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.setSelectionRange(0, 6);
  });
  await field.focus();
  await field.pressSequentially('!');
  await expect(page.locator('#editor-b')).toHaveValue('привет из панели!');
  const companionSel = await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    return { start: node.selectionStart, end: node.selectionEnd };
  });
  expect(companionSel.start).toBe(0);
  expect(companionSel.end).toBe(6);

  // Closing split keeps the text and returns to a single pane.
  await documentAction(page, '#toggle-split');
  await expect(page.locator('#editor-b')).toBeHidden();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-split', 'off');
  await expect(field).toHaveValue('привет из панели!');
});

test('split divider is keyboard-adjustable and reset restores the midpoint', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await openSplit(page);
  const divider = page.locator('#split-divider');
  await expect(divider).toBeVisible();
  await divider.focus();
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  await page.keyboard.press('ArrowRight');
  await expect(divider).not.toHaveAttribute('aria-valuenow', '50');
  const moved = await divider.getAttribute('aria-valuenow');
  await page.locator('#split-reset').click();
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  expect(moved).not.toBe('50');
});

test('comparison viewers cannot open the in-tab split or clear the editor preference', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('saved for companion');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'saved for companion')).toBe(true);
  const id = (await readStoredDocs(page)).find(row => row.text === 'saved for companion')!.id;
  await openSplit(page);
  await expect(page.locator('main.workspace')).toHaveAttribute('data-split', 'on');

  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await expect(viewer.locator('#viewer-badge')).toBeVisible();
  await expect(viewer.locator('#toggle-split')).toBeDisabled();
  await expect(viewer.locator('#editor-b')).toBeHidden();
  await expect(viewer.locator('main.workspace')).toHaveAttribute('data-split', 'off');
  await viewer.close();

  // Viewer must not persist open:false over the editor's remembered split.
  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#editor-b')).toBeVisible();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-split', 'on');
});

test('Find next targets the active companion pane without mutating primary selection', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('one two one');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await page.locator('#editor').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.focus();
    node.setSelectionRange(0, 0);
  });
  await page.locator('#editor-b').focus();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await page.locator('#find-open').click();
  await page.locator('#find-text').fill('one');
  await page.locator('#find-next').click();
  await expect(page.locator('#editor-b')).toBeFocused();
  const companionSel = await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    return { start: node.selectionStart, end: node.selectionEnd };
  });
  const primarySel = await page.locator('#editor').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    return { start: node.selectionStart, end: node.selectionEnd };
  });
  expect(companionSel).toEqual({ start: 0, end: 3 });
  expect(primarySel).toEqual({ start: 0, end: 0 });
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
});

test('opening Find from Focus mode keeps the companion as the active pane', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('focus find target');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await page.locator('#focus-mode').click();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await page.locator('#editor-b').focus();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await page.locator('#find-text').fill('target');
  await page.locator('#find-next').click();
  await expect(page.locator('#editor-b')).toBeFocused();
  await expect(page.locator('#editor-b')).toHaveJSProperty('selectionStart', 11);
  await expect(page.locator('#editor-b')).toHaveJSProperty('selectionEnd', 17);
});

test('entering Focus mode from the companion keeps pane B active', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('line one\nline two');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await page.locator('#editor-b').focus();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await expect(page.locator('#convert-cyrillic')).toBeDisabled();
  await page.locator('#focus-mode').click();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await expect(page.locator('#editor-b')).toBeFocused();
  await expect(page.locator('#convert-cyrillic')).toBeDisabled();
});

test('Escape from the companion enters Focus mode without stealing the active pane', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('escape from companion');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await page.locator('#editor-b').focus();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await expect(page.locator('#editor-b')).toBeFocused();
});

test('Go to line and caret status follow the companion pane', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('alpha\nbeta\ngamma');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await page.locator('#editor').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.focus();
    node.setSelectionRange(0, 0);
  });
  await expect(page.locator('#caret-position')).toHaveText('Ln 1, Col 1');
  await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.focus();
    node.setSelectionRange(6, 6);
  });
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await expect(page.locator('#caret-position')).toHaveText('Ln 2, Col 1');
  await openGoto(page);
  await page.locator('#goto-line').fill('3:2');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.locator('#editor-b')).toBeFocused();
  await expect(page.locator('#editor-b')).toHaveJSProperty('selectionStart', 12);
  await expect(page.locator('#caret-position')).toHaveText('Ln 3, Col 2');
  await expect(page.locator('#editor')).toHaveJSProperty('selectionStart', 0);
});

test('companion focus refuses Convert/Replace on the primary selection', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.locator('#editor');
  await field.fill('alpha beta');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await field.evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.focus();
    node.setSelectionRange(0, 5);
  });
  await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.focus();
    node.setSelectionRange(6, 10);
  });
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await expect(page.locator('#convert-cyrillic')).toBeDisabled();
  await expect(page.locator('#replace-one')).toBeDisabled();
  await page.locator('#convert-cyrillic').click({ force: true });
  await expect(field).toHaveValue('alpha beta');
  await field.focus();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-a');
  await expect(page.locator('#convert-cyrillic')).toBeEnabled();
});

test('Edit in this pane moves editing to the companion without clearing history', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  // Default typing mode is Cyrillic; stay on Latin so ASCII assertions stay stable.
  await page.getByRole('switch', { name: 'Кириллица' }).uncheck();
  const field = page.locator('#editor');
  await field.fill('first');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await field.pressSequentially(' draft');
  await expect(page.locator('#undo')).toBeEnabled();
  await openSplit(page);
  await expect(page.locator('#edit-in-pane-b')).toBeVisible();
  await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.focus();
    node.setSelectionRange(0, 5);
    node.scrollTop = 0;
  });
  await page.locator('#edit-in-pane-b').click();
  await expect(page.locator('#editor-b')).toHaveAttribute('data-pane-role', 'editable');
  await expect(page.locator('#editor')).toHaveAttribute('data-pane-role', 'readonly');
  await expect(page.locator('#editor-b')).toBeFocused();
  await expect(page.locator('#companion-badge')).toBeHidden();
  await expect(page.locator('#primary-live-badge')).toBeVisible();
  await expect(page.locator('#edit-in-pane-a')).toBeVisible();
  const companionSel = await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    return { start: node.selectionStart, end: node.selectionEnd };
  });
  expect(companionSel).toEqual({ start: 0, end: 5 });
  // Transfer preserves the prior companion selection; move to end before appending.
  await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    const end = node.value.length;
    node.setSelectionRange(end, end);
  });
  await page.locator('#editor-b').pressSequentially('!');
  await expect(page.locator('#editor-b')).toHaveValue('first draft!');
  await expect(page.locator('#editor')).toHaveValue('first draft!');
  await page.locator('#undo').click();
  await expect(page.locator('#editor-b')).toHaveValue('first draft');
  await expect(page.locator('#editor')).toHaveValue('first draft');
  await page.locator('#edit-in-pane-a').click();
  await expect(page.locator('#editor')).toHaveAttribute('data-pane-role', 'editable');
  await expect(page.locator('#editor-b')).toHaveAttribute('data-pane-role', 'readonly');
  await expect(page.locator('#companion-badge')).toHaveText('Live view · Read-only');
});

test('Edit in this pane refuses while composing', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('compose guard');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await page.locator('#editor').evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: 'あ' }));
  });
  await page.locator('#edit-in-pane-b').click();
  await expect(page.locator('#editor')).toHaveAttribute('data-pane-role', 'editable');
  await expect(page.locator('#editor-b')).toHaveAttribute('data-pane-role', 'readonly');
  await expect(page.locator('#status')).toContainText('Finish composing');
  await page.locator('#editor').evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionend', { data: 'あ' }));
  });
  await page.locator('#edit-in-pane-b').click();
  await expect(page.locator('#editor-b')).toHaveAttribute('data-pane-role', 'editable');
});

test('closing split after Edit in this pane keeps text and history on the primary', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.getByRole('switch', { name: 'Кириллица' }).uncheck();
  await setAutosave(page, false);
  await page.locator('#editor').fill('keep me');
  await openSplit(page);
  await page.locator('#edit-in-pane-b').click();
  await expect(page.locator('#editor-b')).toHaveAttribute('data-pane-role', 'editable');
  await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    const end = node.value.length;
    node.setSelectionRange(end, end);
  });
  await page.locator('#editor-b').pressSequentially(' safe');
  await documentAction(page, '#toggle-split');
  await expect(page.locator('#editor-b')).toBeHidden();
  await expect(page.locator('#editor')).toHaveValue('keep me safe');
  await expect(page.locator('#editor')).toHaveAttribute('data-pane-role', 'editable');
  await page.locator('#undo').click();
  await expect(page.locator('#editor')).toHaveValue('keep me');
});

test('transfer during an in-flight save keeps dirty text without a second commit race', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('persist transfer');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await page.evaluate(() => {
    (window as Window & { __typebridgeDelayPersistMs?: number }).__typebridgeDelayPersistMs = 800;
  });
  await page.locator('#editor').pressSequentially('!');
  await expect(page.locator('#save-indicator')).toHaveText('Saving…');
  await page.locator('#edit-in-pane-b').click();
  await expect(page.locator('#editor-b')).toHaveAttribute('data-pane-role', 'editable');
  await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    const end = node.value.length;
    node.setSelectionRange(end, end);
  });
  await page.locator('#editor-b').pressSequentially('?');
  await expect(page.locator('#editor-b')).toHaveValue('persist transfer!?');
  await expect(page.locator('#save-indicator')).toHaveText('Saved', { timeout: 5000 });
  const docs = await readStoredDocs(page);
  expect(docs).toHaveLength(1);
  expect(docs[0]?.text).toBe('persist transfer!?');
});

test('split open keeps the primary editor within its pane despite a saved pixel width', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').evaluate(el => {
    (el as HTMLTextAreaElement).style.width = '900px';
  });
  await openSplit(page);
  const primary = await page.locator('.editor-pane-primary').boundingBox();
  const editor = await page.locator('#editor').boundingBox();
  expect(primary).toBeTruthy();
  expect(editor).toBeTruthy();
  expect(editor!.width).toBeLessThanOrEqual(primary!.width + 1);
  await expect(page.locator('#resize-editor')).toBeHidden();
  await documentAction(page, '#toggle-split');
  await expect(page.locator('#resize-editor')).toBeVisible();
});

test('switching documents while split is closed restores companion position against the new text', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('first document text for companion');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.setSelectionRange(0, 5);
    node.dispatchEvent(new Event('select'));
  });
  await documentAction(page, '#toggle-split');
  await expect(page.locator('#editor-b')).toBeHidden();

  await documentAction(page, '#new-draft');
  await page.locator('#editor').fill('short');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await expect(page.locator('#editor-b')).toHaveValue('short');
  const sel = await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    return { start: node.selectionStart, end: node.selectionEnd, value: node.value };
  });
  expect(sel.value).toBe('short');
  expect(sel.end).toBeLessThanOrEqual(sel.value.length);
});

test('stacked split divider changes pane heights on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await openSplit(page);
  await expect(page.locator('#editor-split')).toHaveAttribute('data-split-orientation', 'stacked');
  const before = await page.locator('.editor-pane-primary').boundingBox();
  expect(before).toBeTruthy();
  const divider = page.locator('#split-divider');
  await divider.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const after = await page.locator('.editor-pane-primary').boundingBox();
  expect(after).toBeTruthy();
  expect(after!.height).toBeGreaterThan(before!.height + 4);
});

test('stacked End ratio keeps a usable companion pane after the divider', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await openSplit(page);
  const divider = page.locator('#split-divider');
  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(divider).toHaveAttribute('aria-valuemax', '65');
  await divider.focus();
  await page.keyboard.press('End');
  await expect(divider).toHaveAttribute('aria-valuenow', '65');
  const companion = await page.locator('.editor-pane-companion').boundingBox();
  const field = await page.locator('#editor-b').boundingBox();
  const reset = await page.locator('#split-reset').boundingBox();
  expect(companion).toBeTruthy();
  expect(field).toBeTruthy();
  expect(reset).toBeTruthy();
  expect(companion!.height).toBeGreaterThan(90);
  expect(field!.height).toBeGreaterThan(40);
  expect(reset!.height).toBeGreaterThanOrEqual(44);
  expect(reset!.width).toBeGreaterThanOrEqual(44);
});

test('Focus mode stacked End ratio does not clip the companion textarea', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#focus-mode').click();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await openSplit(page);
  await page.locator('#split-divider').focus();
  await page.keyboard.press('End');
  const pane = await page.locator('.editor-pane-companion').boundingBox();
  const field = await page.locator('#editor-b').boundingBox();
  expect(pane).toBeTruthy();
  expect(field).toBeTruthy();
  expect(field!.height).toBeLessThanOrEqual(pane!.height + 1);
  expect(field!.height).toBeGreaterThan(30);
});

test('conflict-copy creation syncs workspace document identity', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('base for conflict');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'base for conflict')).toBe(true);
  const beforeId = await page.locator('main.workspace').getAttribute('data-document-id');
  expect(beforeId).toBeTruthy();
  const conflictSourceId = beforeId!;

  // Simulate another tab advancing the revision so the next save becomes a conflict copy.
  await page.evaluate(async id => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('typebridge');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('documents', 'readwrite');
        const store = tx.objectStore('documents');
        const get = store.get(id);
        get.onsuccess = () => {
          const row = get.result as { id: string; revision: number; text: string; title: string; updatedAt: number };
          store.put({ ...row, text: 'foreign rewrite', revision: row.revision + 1, updatedAt: Date.now() });
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, conflictSourceId);

  await openSplit(page);
  await page.locator('#editor').fill('local conflict edit');
  await expect(page.locator('#editor-b')).toHaveValue('local conflict edit');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect(page.locator('#conflict-notice')).toContainText('saved as a conflict copy');
  const afterId = await page.locator('main.workspace').getAttribute('data-document-id');
  expect(afterId).toBeTruthy();
  expect(afterId).not.toBe(beforeId);
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.id === afterId && row.text === 'local conflict edit')).toBe(true);
});
