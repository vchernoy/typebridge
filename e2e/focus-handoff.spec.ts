import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { setAutosave } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

/** #175 step 4: same-document focus handoff between two same-tab windows. */

async function waitReady(frame: FrameLocator): Promise<void> {
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
}

async function openDocMenu(frame: FrameLocator): Promise<void> {
  const panel = frame.locator('#doc-menu');
  if (await panel.isHidden()) await frame.locator('#doc-menu-open').click();
  await expect(panel).toBeVisible();
}

async function reloadFrame(page: Page, iframeSelector: string): Promise<void> {
  await page.locator(iframeSelector).evaluate((el: HTMLIFrameElement) => {
    el.contentWindow!.location.reload();
  });
}

/** Place a collapsed caret without starting handoff by itself (caller clicks/types). */
async function placeCaret(frame: FrameLocator, where: 'start' | 'end'): Promise<void> {
  await frame.locator('#editor').evaluate((el: HTMLTextAreaElement, at: 'start' | 'end') => {
    const pos = at === 'start' ? 0 : el.value.length;
    el.setSelectionRange(pos, pos);
  }, where);
}

async function openSharedDocument(page: Page): Promise<{ alpha: FrameLocator; beta: FrameLocator; docId: string }> {
  await page.goto('/window-identity-harness.html');
  const alpha = page.frameLocator('#win-alpha');
  const beta = page.frameLocator('#win-beta');
  await waitReady(alpha);
  await waitReady(beta);

  await alpha.locator('#editor').fill('Shared handoff text');
  await expect(alpha.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'Shared handoff text')).toBe(true);
  const docId = (await readStoredDocs(page)).find(row => row.text === 'Shared handoff text')!.id;

  await reloadFrame(page, '#win-beta');
  await waitReady(beta);
  await openDocMenu(beta);
  await beta.locator('#drafts').selectOption(docId);
  // selectOption is a keyboard-style pick, so the menu stays open; close it like a user.
  await beta.locator('#drafts').press('Escape');
  await expect(beta.locator('#doc-menu')).toBeHidden();
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(beta.locator('#editor')).toHaveJSProperty('readOnly', true);
  return { alpha, beta, docId };
}

test('same-tab click into read-only window takes editing without dropping keys', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta } = await openSharedDocument(page);

  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'editor');
  await beta.locator('#editor').click();
  await placeCaret(beta, 'end');
  // Type immediately during handoff — buffered keys must apply.
  await beta.locator('#editor').pressSequentially('!');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveJSProperty('readOnly', false);
  await expect(beta.locator('#editor')).toHaveValue('Shared handoff text!');
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(alpha.locator('#editor')).toHaveJSProperty('readOnly', true);
  // Owner shows last saved text (pre-handoff save), not the new keystroke.
  await expect(alpha.locator('#editor')).toHaveValue('Shared handoff text');
  await expect(beta.locator('#save-indicator')).toHaveText('Saved');
  // No conflict copy — still one document row for this text family.
  const docs = await readStoredDocs(page);
  expect(docs.filter(row => row.text.startsWith('Shared handoff text')).length).toBe(1);
});

test('failed takeover keeps the owner private text (two-phase park)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const { alpha, beta, docId } = await openSharedDocument(page);

  await setAutosave(alpha as unknown as Page, false);
  await reloadFrame(page, '#win-beta');
  await waitReady(beta);
  await openDocMenu(beta);
  await beta.locator('#drafts').selectOption(docId);
  await beta.locator('#drafts').press('Escape');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'reader');

  await alpha.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.value = `${el.value} keep-me`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(alpha.locator('#save-indicator')).toHaveText('Not saved');

  // Delay beta's acquire so we can grab the lock after alpha parks but before beta claims it.
  await page.locator('#win-beta').evaluate((el: HTMLIFrameElement) => {
    (el.contentWindow as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 1_000;
  });

  const lockName = `typebridge-edit-owner:${docId}`;
  const holder = await context.newPage();
  await holder.goto('/icon-192.png');

  await beta.locator('#editor').click();
  // Alpha parks (reader) but must still show its private text until confirmation.
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'reader', { timeout: 5_000 });
  await expect(alpha.locator('#editor')).toHaveValue('Shared handoff text keep-me');

  await holder.evaluate(name => new Promise<void>((resolve, reject) => {
    void navigator.locks.request(name, { ifAvailable: true }, lock => {
      if (!lock) { reject(new Error('lock not free after park')); return; }
      resolve();
      return new Promise(() => undefined);
    });
  }), lockName);

  await expect(beta.locator('html')).toHaveAttribute('data-role', 'reader', { timeout: 10_000 });
  await expect(alpha.locator('#editor')).toHaveValue('Shared handoff text keep-me');
  await holder.close();
});

test('same-tab Autosave-off handoff carries unsaved text in memory', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta, docId } = await openSharedDocument(page);

  // Turn Autosave off only in alpha after both windows are open — beta keeps its
  // startup Autosave-on checkbox; the receiver must still not persist private text.
  await setAutosave(alpha as unknown as Page, false);
  await alpha.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.value = `${el.value} private`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(alpha.locator('#save-indicator')).toHaveText('Not saved');

  await beta.locator('#editor').click();
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveValue('Shared handoff text private');
  await expect(beta.locator('#save-indicator')).toHaveText('Not saved');
  await page.waitForTimeout(500);
  const after = await readStoredDocs(page);
  expect(after.find(row => row.id === docId)?.text).toBe('Shared handoff text');
});

test('switching documents during a pending handoff cancels takeover', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta, docId } = await openSharedDocument(page);

  await page.locator('#win-beta').evaluate((el: HTMLIFrameElement) => {
    (el.contentWindow as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 1_500;
  });

  await beta.locator('#editor').click();
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'reader', { timeout: 5_000 });

  await openDocMenu(beta);
  await beta.locator('#new-draft').click();
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveValue('');
  // Shared document must not receive beta's editing role after the cancel.
  await expect.poll(async () => {
    const docs = await readStoredDocs(page);
    return docs.find(row => row.id === docId)?.text;
  }).toBe('Shared handoff text');
});

test('keys typed during delayed acquire are all kept', async ({ page }) => {
  test.setTimeout(90_000);
  const { beta } = await openSharedDocument(page);

  await page.locator('#win-beta').evaluate((el: HTMLIFrameElement) => {
    (el.contentWindow as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 800;
  });

  await beta.locator('#editor').click();
  await placeCaret(beta, 'end');
  // Digits are not transliterated — asserts buffering through acquire without mode toggles.
  await beta.locator('#editor').pressSequentially('123');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveValue('Shared handoff text123');
});

test('Backspace during delayed acquire is buffered with surrounding keys', async ({ page }) => {
  test.setTimeout(90_000);
  const { beta } = await openSharedDocument(page);

  await page.locator('#win-beta').evaluate((el: HTMLIFrameElement) => {
    (el.contentWindow as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 1_000;
  });

  await beta.locator('#editor').click();
  await placeCaret(beta, 'end');
  await beta.locator('#editor').press('1');
  await beta.locator('#editor').press('2');
  await beta.locator('#editor').press('Backspace');
  await beta.locator('#editor').press('3');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveValue('Shared handoff text13');
});

test('Кириллица transliterates keys buffered during handoff', async ({ page }) => {
  test.setTimeout(90_000);
  const { beta } = await openSharedDocument(page);

  await expect(beta.getByRole('switch', { name: 'Кириллица' })).toBeChecked();
  await page.locator('#win-beta').evaluate((el: HTMLIFrameElement) => {
    (el.contentWindow as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 800;
  });

  await beta.locator('#editor').click();
  await placeCaret(beta, 'end');
  await beta.locator('#editor').pressSequentially('privet');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveValue('Shared handoff textпривет');
});

test('keyboard typing into a focused read-only field starts handoff', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta } = await openSharedDocument(page);

  await beta.locator('#editor').focus();
  await placeCaret(beta, 'end');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'reader');
  // First key starts handoff (not plain focus); "!" is not transliterated.
  await beta.locator('#editor').press('!');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveValue('Shared handoff text!');
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'reader');
});

test('collapsed caret at offset zero is preserved across takeover', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta } = await openSharedDocument(page);

  await beta.locator('#editor').focus();
  await placeCaret(beta, 'start');
  await beta.locator('#editor').press('!');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveValue('!Shared handoff text');
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'reader');
});

test('programmatic focus alone does not take ownership', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta } = await openSharedDocument(page);

  // App-driven focus (e.g. returning from a dialog) must not start handoff without a key.
  await beta.locator('#editor').evaluate((el: HTMLTextAreaElement) => { el.focus(); });
  await page.waitForTimeout(300);
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'editor');
});

test('Tab leaves a read-only editor without starting handoff', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta } = await openSharedDocument(page);

  await beta.locator('#editor').focus();
  await expect(beta.locator('#editor')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(beta.locator('#editor')).not.toBeFocused();
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'editor');
});

test('selecting a word then typing replaces that selection after takeover', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta } = await openSharedDocument(page);

  await beta.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    const start = el.value.indexOf('handoff');
    el.setSelectionRange(start, start + 'handoff'.length);
  });
  await expect(beta.locator('#editor')).toBeFocused();
  // "!" is not transliterated under Кириллица — assert the selection was replaced.
  await beta.locator('#editor').press('!');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveValue('Shared ! text');
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'reader');
});

test('Edit here after unresponsive timeout keeps keys typed during the wait', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta } = await openSharedDocument(page);

  await page.locator('#win-alpha').evaluate((el: HTMLIFrameElement) => {
    (el.contentWindow as Window & { __typebridgeIgnoreHandoffRequests?: boolean })
      .__typebridgeIgnoreHandoffRequests = true;
  });

  await beta.locator('#editor').click();
  await placeCaret(beta, 'end');
  // Digits are not transliterated — assert the pre-timeout buffer survives Edit here.
  await beta.locator('#editor').pressSequentially('123');
  await expect(beta.locator('#edit-here-bar')).toBeVisible({ timeout: 10_000 });
  await beta.locator('#edit-here').click();
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveValue('Shared handoff text123');
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'reader');
});

test('selection maps onto owner private text that diverged before the range', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta } = await openSharedDocument(page);

  await setAutosave(alpha as unknown as Page, false);
  await alpha.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.value = `PREFIX ${el.value}`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(alpha.locator('#save-indicator')).toHaveText('Not saved');
  await expect(beta.locator('#editor')).toHaveValue('Shared handoff text');

  await beta.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    const start = el.value.indexOf('handoff');
    el.setSelectionRange(start, start + 'handoff'.length);
  });
  await beta.locator('#editor').press('!');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  // Offsets measured on the reader text must land on "handoff" in the longer owner snapshot.
  await expect(beta.locator('#editor')).toHaveValue('PREFIX Shared ! text');
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'reader');
});
