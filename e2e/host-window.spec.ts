import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { fillHostEditor, moreAction, setHostAutosave } from './settings-helpers';

/** #175 step 5: host free-layout windows; update notice on the host. */

function luminance(color: string): number {
  const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrastRatio(first: string, second: string): number {
  const colors = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (colors[0] + 0.05) / (colors[1] + 0.05);
}

async function openHost(page: Page): Promise<FrameLocator> {
  await page.goto('/');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(frame.locator('html')).toHaveAttribute('data-embed', '1');
  await expect(frame.locator('html')).toHaveAttribute('data-window-id', 'main');
  return frame;
}

test('host single window matches standalone editor typing and save', async ({ page }) => {
  const editor = await openHost(page);
  await editor.locator('#editor').pressSequentially('privet');
  await expect(editor.locator('#save-indicator')).toHaveText('Saved');
  await expect(editor.locator('#editor')).toHaveValue('привет');
});

test('host toolbar buttons stay readable in dark appearance', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('typebridge.appearance.v1', 'dark'));
  await openHost(page);
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  const button = page.locator('#host-toolbar button').first();
  await expect(button).toBeVisible();
  const colors = await button.evaluate(element => {
    const view = element.ownerDocument.defaultView!;
    const style = view.getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(colors.color).not.toBe(colors.background);
  expect(contrastRatio(colors.color, colors.background)).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({
    path: testInfo.outputPath('host-toolbar-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('dragging the title bar moves a full-bleed window', async ({ page }) => {
  await openHost(page);
  const before = await page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }> };
    return hooks.__typebridgeHostWindows?.().find(win => win.id === 'main');
  });
  expect(before).toBeTruthy();

  const handle = page.getByRole('button', { name: /Move window main/ });
  await handle.click();
  const afterClick = await page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }> };
    return hooks.__typebridgeHostWindows?.().find(win => win.id === 'main');
  });
  // Click may raise z-order but must not restore/shrink or quarter-snap a full-bleed window.
  expect(afterClick).toMatchObject({ x: before!.x, y: before!.y, w: before!.w, h: before!.h });

  const box = await handle.boundingBox();
  expect(box).toBeTruthy();
  // Grip is on the left of the title bar; drag far enough that restore-on-move
  // centres away from the clamped origin (pointer - halfWidth would otherwise stay ≤ 0).
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 360, startY + 120, { steps: 8 });
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }> };
    return hooks.__typebridgeHostWindows?.().find(win => win.id === 'main');
  });
  expect(after).toBeTruthy();
  expect(after!.w).toBeLessThan(before!.w);
  expect(after!.h).toBeLessThan(before!.h);
  expect(after!.w).toBeGreaterThan(before!.w / 3);
  expect(after!.x + after!.y).toBeGreaterThan(0);
});

test('a full-bleed window keeps filling the host when the host grows', async ({ page }) => {
  await openHost(page);
  const main = () => page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }> };
    return hooks.__typebridgeHostWindows?.().find(win => win.id === 'main');
  });
  const root = () => page.locator('#host-root').evaluate(el => ({ w: el.clientWidth, h: el.clientHeight }));
  const before = (await main())!;
  const view = await root();
  expect(before).toMatchObject({ x: 0, y: 0, w: view.w, h: view.h });
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width + 120, height: size.height + 90 });
  const grown = await root();
  expect(grown.w).toBeGreaterThan(view.w);
  await expect.poll(main).toMatchObject({ x: 0, y: 0, w: grown.w, h: grown.h });
  // Still full-bleed, so a drag restores it to a smaller movable window.
  await page.setViewportSize(size);
  await expect.poll(main).toMatchObject({ x: 0, y: 0, w: view.w, h: view.h });
});

test('host mounts an editor when localStorage access is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Access denied', 'SecurityError'); },
    });
  });
  const editor = await openHost(page);
  await expect(page.locator('.host-window')).toHaveCount(1);
  await expect(editor.locator('#editor')).toBeEnabled();
});

test('host owns Settings; shortcuts sheet can open the host panel', async ({ page }) => {
  const editor = await openHost(page);
  await expect(page.locator('#settings-panel')).toHaveCount(1);
  await expect(editor.locator('#settings-open')).toBeHidden();

  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-panel')).toBeHidden();

  await moreAction(editor as unknown as Page, '#keyboard-shortcuts');
  await expect(editor.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Change typing shortcut' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await expect(page.locator('#translit-shortcut')).toBeFocused();
});

test('embedded editor does not mount its own update notice', async ({ page }) => {
  const editor = await openHost(page);
  await expect(editor.locator('#update-notice')).toHaveCount(0);
});

test('offline host refresh stays on the host shell', async ({ page, context }) => {
  const editor = await openHost(page);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error('Offline worker did not activate');
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
  await fillHostEditor(editor, 'Offline host draft');
  await expect(editor.locator('#save-indicator')).toHaveText('Saved');
  await context.setOffline(true);
  await page.reload();
  expect(new URL(page.url()).pathname).toBe('/');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(frame.locator('html')).toHaveAttribute('data-embed', '1');
  await expect(frame.locator('#editor')).toHaveValue('Offline host draft');
  await context.setOffline(false);
});

test('host does not reload when private edits change after update consent', async ({ page }) => {
  const editor = await openHost(page);
  await setHostAutosave(page, false);
  await fillHostEditor(editor, 'Keep this private text');
  await expect(editor.locator('#save-indicator')).toHaveText('Not saved');

  const prepare = page.evaluate(async () => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe.host-editor')!;
    const hooks = frame.contentWindow as Window & { __typebridgePrepareUpdateReload?: () => Promise<boolean> };
    return hooks.__typebridgePrepareUpdateReload?.() ?? false;
  });
  const dialog = editor.getByRole('dialog', { name: 'Reload without saving?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes and reload' }).click();
  expect(await prepare).toBe(true);

  await editor.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.value = `${el.value}!`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const outcome = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe.host-editor')!;
    const hooks = frame.contentWindow as Window & { __typebridgeAssertSafeUpdateReload?: () => void };
    try {
      hooks.__typebridgeAssertSafeUpdateReload?.();
      return 'allowed';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(outcome).toContain('Private edits changed');
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(editor.locator('#editor')).toHaveValue('Keep this private text!');
});

test('new window stays a blank editor after host reload without typing', async ({ page }) => {
  test.setTimeout(90_000);
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(second.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(second.locator('#editor')).toHaveValue('');

  await page.reload();
  await expect(page.locator('.host-window')).toHaveCount(2);
  const restored = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(restored.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(restored.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(restored.locator('#editor')).toHaveValue('');
});

test('New window tiles and persists two free windows', async ({ page }) => {
  test.setTimeout(90_000);
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(second.locator('html')).toHaveAttribute('data-window-id', 'w2');

  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const geometry = await page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; x: number; w: number }> };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  expect(geometry).toHaveLength(2);
  expect(geometry[0].x).toBe(0);
  expect(geometry[1].x).toBeGreaterThan(0);

  await second.locator('#editor').click();
  await fillHostEditor(second, 'Second window text');
  await expect(second.locator('#editor')).toHaveValue('Second window text');
  await expect(second.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem('typebridge.host.windows.v1');
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { windows?: Array<{ id: string; documentId?: string }> };
    return !!parsed.windows?.find(win => win.id === 'w2')?.documentId;
  })).toBe(true);

  await page.reload();
  await expect(page.locator('.host-window')).toHaveCount(2);
  const restored = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(restored.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(restored.locator('#editor')).toHaveValue('Second window text');
});

test('update reload asks every window about private text', async ({ page }) => {
  test.setTimeout(90_000);
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await setHostAutosave(page, false);
  await fillHostEditor(second, 'Private only in second');
  await expect(second.locator('#save-indicator')).toHaveText('Not saved');

  const prepare = page.evaluate(async () => {
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.host-editor')];
    for (const frame of frames) {
      const hooks = frame.contentWindow as Window & { __typebridgePrepareUpdateReload?: () => Promise<boolean> };
      const prepareOne = hooks.__typebridgePrepareUpdateReload;
      if (!prepareOne) continue;
      if (!await prepareOne()) return false;
    }
    return true;
  });
  const dialog = second.getByRole('dialog', { name: 'Reload without saving?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  expect(await prepare).toBe(false);
  await expect(second.locator('#editor')).toHaveValue('Private only in second');
});

test('failed second-window assert cancels prior allowUpdateReload', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (sessionStorage.getItem('typebridge.e2e.blockDocumentPuts') === 'yes' && this.name === 'documents') {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const first = page.frameLocator('.host-window[data-window-id="main"] iframe');
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });

  // Only the second window is private — first stays clean so prepare shows one dialog.
  await setHostAutosave(page, false);
  await fillHostEditor(second, 'Private in second');
  await expect(second.locator('#save-indicator')).toHaveText('Not saved');

  const prepare = page.evaluate(async () => {
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.host-editor')];
    for (const frame of frames) {
      const hooks = frame.contentWindow as Window & { __typebridgePrepareUpdateReload?: () => Promise<boolean> };
      const prepareOne = hooks.__typebridgePrepareUpdateReload;
      if (!prepareOne) continue;
      if (!await prepareOne()) return false;
    }
    return true;
  });
  const dialog = second.getByRole('dialog', { name: 'Reload without saving?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes and reload' }).click();
  expect(await prepare).toBe(true);

  await second.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.value = `${el.value}!`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const outcome = await page.evaluate(() => {
    type Hooks = {
      __typebridgeAssertSafeUpdateReload?: () => void;
      __typebridgeCancelUpdateReload?: () => void;
    };
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.host-editor')];
    try {
      for (const frame of frames) {
        const hooks = frame.contentWindow as Window & Hooks;
        const assertSafe = hooks.__typebridgeAssertSafeUpdateReload;
        if (!assertSafe) throw new Error('Editor reload unavailable');
        assertSafe();
      }
      return 'allowed';
    } catch (error) {
      for (const frame of frames) {
        (frame.contentWindow as Window & Hooks).__typebridgeCancelUpdateReload?.();
      }
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(outcome).toContain('Private edits changed');

  // Shared Autosave was off for the private-text dialog; restore it so the first
  // window can attempt a save (and leave a pending backup when puts fail).
  await setHostAutosave(page, true);
  await page.evaluate(() => sessionStorage.setItem('typebridge.e2e.blockDocumentPuts', 'yes'));
  await fillHostEditor(first, 'Pending after cancelled assert');
  await expect(first.locator('#save-indicator')).toHaveText('Save failed');
  await page.locator('.host-window[data-window-id="main"] iframe').evaluate((frame: HTMLIFrameElement) => {
    frame.contentWindow!.dispatchEvent(new Event('pagehide'));
  });
  await expect.poll(async () =>
    page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1::w:main') ?? ''),
  ).toContain('Pending after cancelled assert');
});

test('clicking a background editor raises its window', async ({ page }) => {
  test.setTimeout(90_000);
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Tile side by side' }).click();
  await page.getByRole('button', { name: /Move window main/ }).click();
  await expect(page.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-active/);

  await second.locator('#editor').click();
  await expect(page.locator('.host-window[data-window-id="w2"]')).toHaveClass(/is-active/);
  const order = await page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; z: number }> };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  const mainZ = order.find(win => win.id === 'main')?.z ?? 0;
  const secondZ = order.find(win => win.id === 'w2')?.z ?? 0;
  expect(secondZ).toBeGreaterThan(mainZ);
});

test('refused multi-window update leaves backups and visibility saves working', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (sessionStorage.getItem('typebridge.e2e.blockDocumentPuts') === 'yes' && this.name === 'documents') {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const first = page.frameLocator('.host-window[data-window-id="main"] iframe');
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await setHostAutosave(page, false);
  await fillHostEditor(second, 'Private refuse reload');
  await expect(second.locator('#save-indicator')).toHaveText('Not saved');

  const prepare = page.evaluate(async () => {
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.host-editor')];
    for (const frame of frames) {
      const hooks = frame.contentWindow as Window & { __typebridgePrepareUpdateReload?: () => Promise<boolean> };
      if (!await hooks.__typebridgePrepareUpdateReload?.()) return false;
    }
    return true;
  });
  const dialog = second.getByRole('dialog', { name: 'Reload without saving?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  expect(await prepare).toBe(false);

  await page.evaluate(() => {
    for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe.host-editor')) {
      const hooks = frame.contentWindow as Window & { __typebridgeCancelUpdateReload?: () => void };
      hooks.__typebridgeCancelUpdateReload?.();
    }
  });

  // Shared Autosave was off for the private refuse path; turn it back on for the
  // post-refuse save / backup checks on the first window.
  await setHostAutosave(page, true);
  await fillHostEditor(first, 'Still autosaved after refuse');
  await expect(first.locator('#save-indicator')).toHaveText('Saved');
  await page.locator('.host-window[data-window-id="main"] iframe').evaluate((frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument!;
    Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    doc.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(first.locator('#save-indicator')).toHaveText('Saved');

  await page.evaluate(() => sessionStorage.setItem('typebridge.e2e.blockDocumentPuts', 'yes'));
  await fillHostEditor(first, 'Pending after refused reload');
  await expect(first.locator('#save-indicator')).toHaveText('Save failed');
  await page.locator('.host-window[data-window-id="main"] iframe').evaluate((frame: HTMLIFrameElement) => {
    frame.contentWindow!.dispatchEvent(new Event('pagehide'));
  });
  await expect.poll(async () =>
    page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1::w:main') ?? ''),
  ).toContain('Pending after refused reload');
});

test('discarded close after save failure does not revive text under a reused id', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (sessionStorage.getItem('typebridge.e2e.blockDocumentPuts') === 'yes' && this.name === 'documents') {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const secondShell = page.locator('.host-window[data-window-id="w2"]');
  const second = secondShell.frameLocator('iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });

  // Save once successfully so the stub is known-live, then block further document puts.
  // The change log still works (#37 R2c 2d-2): the journal is not required while it protects.
  await fillHostEditor(second, 'Before block');
  await expect(second.locator('#save-indicator')).toHaveText('Saved');
  await page.evaluate(() => sessionStorage.setItem('typebridge.e2e.blockDocumentPuts', 'yes'));
  await fillHostEditor(second, 'Discarded after failed save');
  await expect(second.locator('#save-indicator')).toHaveText('Save failed');
  // Unsaved text must be in the change log (documents puts fail; changes still land).
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('changes', 'readonly');
      const req = tx.objectStore('changes').getAll();
      tx.oncomplete = () => {
        db.close();
        resolve((req.result as Array<{ change?: [number, string, string] }>).some(record =>
          JSON.stringify(record.change ?? []).includes('Discarded after failed save')
          || (typeof record === 'object' && JSON.stringify(record).includes('Discarded after failed save')),
        ));
      };
      tx.onerror = () => reject(tx.error);
    };
  }))).toBe(true);

  await secondShell.locator('.host-window-close').click();
  const dialog = second.getByRole('dialog', { name: 'Close and discard unsaved changes?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes and close' }).click();
  await expect(page.locator('.host-window')).toHaveCount(1);
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1::w:w2'))).toBeNull();
  // Discard clears journal entries and change-log records for that document.
  expect(await page.evaluate(() =>
    Object.keys(localStorage).filter(key =>
      key.startsWith('typebridge.recovery.v1.')
      && (localStorage.getItem(key) ?? '').includes('Discarded after failed save'),
    ),
  )).toEqual([]);
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('changes', 'readonly');
      const req = tx.objectStore('changes').getAll();
      tx.oncomplete = () => {
        db.close();
        resolve((req.result as unknown[]).filter(record =>
          JSON.stringify(record).includes('Discarded after failed save'),
        ).length);
      };
      tx.onerror = () => reject(tx.error);
    };
  }))).toBe(0);

  await page.getByRole('button', { name: 'New window' }).click();
  const revived = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(revived.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  // Must not revive the discarded unsaved text (a prior successful save may still exist).
  await expect(revived.locator('#editor')).not.toHaveValue('Discarded after failed save');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1::w:w2'))).toBeNull();
  await expect(revived.getByRole('button', { name: /Recover / })).toHaveCount(0);
  await expect(revived.locator('#status')).not.toContainText('Recovered unsaved text');
});


test('resize keeps the dragged size instead of snapping to a half', async ({ page }) => {
  test.setTimeout(90_000);
  await openHost(page);
  const before = await page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; w: number; h: number }> };
    return hooks.__typebridgeHostWindows?.().find(win => win.id === 'main');
  });
  expect(before).toBeTruthy();

  const handle = page.locator('.host-window[data-window-id="main"] .host-window-resize-se');
  const box = await handle.boundingBox();
  expect(box).toBeTruthy();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 160, startY - 120);
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }> };
    return hooks.__typebridgeHostWindows?.().find(win => win.id === 'main');
  });
  expect(after).toBeTruthy();
  expect(after!.w).toBeLessThan(before!.w - 80);
  expect(after!.h).toBeLessThan(before!.h - 60);
  // Must not have jumped to a half or quarter of the host.
  const host = await page.locator('#host-root').boundingBox();
  expect(host).toBeTruthy();
  expect(after!.w).not.toBeCloseTo(host!.width / 2, 0);
  expect(after!.h).not.toBeCloseTo(host!.height / 2, 0);
});

test('aborted close after discard prepare thaws the surviving editor (#254)', async ({ page }) => {
  // Fails if keepFrozenOnSuccess leaves the editor frozen with no host cancel path (#254 Codex/Claude P1).
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (sessionStorage.getItem('typebridge.e2e.blockDocumentPuts') === 'yes' && this.name === 'documents') {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await fillHostEditor(second, 'Before block');
  await expect(second.locator('#save-indicator')).toHaveText('Saved');
  await page.evaluate(() => sessionStorage.setItem('typebridge.e2e.blockDocumentPuts', 'yes'));
  await fillHostEditor(second, 'Frozen then thawed');
  await expect(second.locator('#save-indicator')).toHaveText('Save failed');

  const prepare = page.evaluate(async () => {
    const frame = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="w2"] iframe.host-editor')!;
    const hooks = frame.contentWindow as Window & { __typebridgePrepareWindowClose?: () => Promise<boolean> };
    return hooks.__typebridgePrepareWindowClose?.() ?? false;
  });
  const dialog = second.getByRole('dialog', { name: 'Close and discard unsaved changes?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes and close' }).click();
  expect(await prepare).toBe(true);
  // Host would call cancelClose when the post-await last-window check refuses removal.
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="w2"] iframe.host-editor')!;
    (frame.contentWindow as Window & { __typebridgeCancelWindowClose?: () => void }).__typebridgeCancelWindowClose?.();
  });
  await expect(second.locator('#editor')).toBeEditable();
  await fillHostEditor(second, 'Editable again after abort');
  await expect(second.locator('#editor')).toHaveValue('Editable again after abort');
});

test('closing a dirty Autosave-off window asks before removing it', async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);
  const secondShell = page.locator('.host-window[data-window-id="w2"]');
  const second = secondShell.frameLocator('iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await setHostAutosave(page, false);
  await fillHostEditor(second, 'Private in second');
  await expect(second.locator('#save-indicator')).toHaveText('Not saved');

  await secondShell.locator('.host-window-close').click();
  const dialog = second.getByRole('dialog', { name: 'Close without saving?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);

  await secondShell.locator('.host-window-close').click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes and close' }).click();
  await expect(page.locator('.host-window')).toHaveCount(1);
  await expect(editor.locator('#editor')).toBeEnabled();
});
