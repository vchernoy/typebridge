import { expect, test, type Page } from '@playwright/test';
import { fillHostEditor } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';
import type { HostWindowLayout } from '../src/host/layout';
import type { EditorWindow, HostPageApi } from '../src/view/embed-api';

async function prepare(page: Page) {
  await page.goto('/');
  const first = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(first.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await fillHostEditor(first, 'First exact source');
  await expect(first.locator('#save-indicator')).toHaveText('Saved');
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await fillHostEditor(second, 'Second source');
  await expect(second.locator('#save-indicator')).toHaveText('Saved');
  const id = await page.locator('.host-window[data-window-id="main"] iframe').evaluate((frame: HTMLIFrameElement) =>
    (frame.contentWindow as EditorWindow).__typebridgeStoredDocumentId!());
  if (!id) throw new Error('Expected saved main document');
  return id;
}

test('exact existing-editor activation works at the window cap without opening or replacing source', async ({ page }) => {
  const id = await prepare(page);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'New window' }).click();
    await expect(page.frameLocator('.host-window iframe').nth(i + 2).locator('#editor')).toBeEnabled({ timeout: 30_000 });
  }
  const before = await readStoredDocs(page);
  const result = await page.evaluate(id => {
    const api = window as unknown as HostPageApi;
    const frame = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="main"] iframe')!;
    const urls = [...document.querySelectorAll<HTMLIFrameElement>('.host-window iframe')].map(f => f.src);
    const activeBefore = document.querySelector('.host-window.is-active')?.getAttribute('data-window-id');
    const ready = api.__typebridgeHasExistingEditor('main', id, frame.contentWindow!);
    const probeUnchanged = document.querySelector('.host-window.is-active')?.getAttribute('data-window-id') === activeBefore;
    const activated = api.__typebridgeActivateExistingEditor('main', id, frame.contentWindow!);
    return { ready, probeUnchanged, activated, urlsUnchanged: JSON.stringify(urls) === JSON.stringify(
      [...document.querySelectorAll<HTMLIFrameElement>('.host-window iframe')].map(f => f.src)) };
  }, id);
  expect(result).toEqual({ ready: true, probeUnchanged: true, activated: true, urlsUnchanged: true });
  await expect(page.locator('.host-window')).toHaveCount(4);
  await expect(page.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-active/);
  await expect(page.frameLocator('.host-window[data-window-id="main"] iframe').locator('#editor')).toHaveValue('First exact source');
  expect(await readStoredDocs(page)).toEqual(before);
});

test('wrong, missing or unavailable live identities refuse without fallback or layout mutation', async ({ page }) => {
  const id = await prepare(page);
  const before = await readStoredDocs(page);
  const result = await page.evaluate(id => {
    const api = window as unknown as HostPageApi;
    const main = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="main"] iframe')!.contentWindow! as EditorWindow;
    const other = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="w2"] iframe')!.contentWindow!;
    const layoutBefore = JSON.stringify(api.__typebridgeHostWindows());
    const responses: boolean[] = [];
    for (const [wid, doc, source] of [['missing', id, main], ['main', 'not-current', main], ['main', id, other], ['main', id, window]] as const) {
      responses.push(api.__typebridgeHasExistingEditor(wid, doc, source), api.__typebridgeActivateExistingEditor(wid, doc, source));
    }
    const original = main.__typebridgeStoredDocumentId;
    try {
      for (const probe of [undefined, () => undefined, () => '', () => { throw new Error('not ready'); }]) {
        main.__typebridgeStoredDocumentId = probe;
        responses.push(api.__typebridgeHasExistingEditor('main', id, main), api.__typebridgeActivateExistingEditor('main', id, main));
      }
    } finally { main.__typebridgeStoredDocumentId = original; }
    return { responses, layoutUnchanged: JSON.stringify(api.__typebridgeHostWindows()) === layoutBefore };
  }, id);
  expect(result.responses.every(value => value === false)).toBe(true);
  expect(result.layoutUnchanged).toBe(true);
  await expect(page.locator('.host-window')).toHaveCount(2);
  await expect(page.locator('.host-window[data-window-id="w2"]')).toHaveClass(/is-active/);
  expect(await readStoredDocs(page)).toEqual(before);
});

test('modal guards refuse activation and Focus selects the existing window without leaving Focus', async ({ page }) => {
  const id = await prepare(page);
  const result = await page.evaluate(id => {
    const api = window as unknown as HostPageApi;
    const main = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="main"] iframe')!.contentWindow!;
    const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
    const refused = !api.__typebridgeHasExistingEditor('main', id, main) && !api.__typebridgeActivateExistingEditor('main', id, main);
    modal.remove();
    api.__typebridgeHostFocusMode(true, 'w2');
    const activated = api.__typebridgeActivateExistingEditor('main', id, main);
    return { refused, activated };
  }, id);
  expect(result).toEqual({ refused: true, activated: true });
  await expect(page.locator('body')).toHaveClass(/host-focus-mode/);
  await expect(page.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-host-focused/);
  await expect(page.locator('.host-window')).toHaveCount(2);
  await expect(page.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-active/);
  await expect(page.frameLocator('.host-window[data-window-id="main"] iframe').locator('#editor')).toHaveValue('First exact source');
});

test('activating an offset tiled editor in Focus maximizes it and restores both normal rectangles', async ({ page }) => {
  await prepare(page);
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const beforeDocs = await readStoredDocs(page);
  const result = await page.evaluate(() => {
    const api = window as unknown as HostPageApi;
    const rects = () => (api.__typebridgeHostWindows() as HostWindowLayout[]).map(({ id, x, y, w, h }) => ({ id, x, y, w, h })).sort((a, b) => a.id.localeCompare(b.id));
    const before = rects();
    const target = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="w2"] iframe')!.contentWindow! as EditorWindow;
    const id = target.__typebridgeStoredDocumentId!()!;
    const urls = [...document.querySelectorAll<HTMLIFrameElement>('.host-window iframe')].map(frame => frame.src);
    api.__typebridgeHostFocusMode(true, 'main');
    const activated = api.__typebridgeActivateExistingEditor('w2', id, target);
    const focused = rects().find(win => win.id === 'w2')!;
    const root = document.getElementById('host-root')!.getBoundingClientRect();
    const retainedFocus = document.body.classList.contains('host-focus-mode');
    api.__typebridgeHostFocusMode(false);
    return { activated, before, focused, viewport: { w: Math.floor(root.width), h: Math.floor(root.height) }, retainedFocus, after: rects(),
      urlsUnchanged: JSON.stringify(urls) === JSON.stringify([...document.querySelectorAll<HTMLIFrameElement>('.host-window iframe')].map(frame => frame.src)) };
  });
  expect(result.before.find(win => win.id === 'w2')!.x).toBeGreaterThan(0);
  expect(result.activated).toBe(true); expect(result.retainedFocus).toBe(true);
  expect(result.focused).toEqual({ id: 'w2', x: 0, y: 0, ...result.viewport });
  expect(result.after).toEqual(result.before); expect(result.urlsUnchanged).toBe(true);
  await expect(page.locator('.host-window')).toHaveCount(2);
  await expect(page.frameLocator('.host-window[data-window-id="w2"] iframe').locator('#editor')).toHaveValue('Second source');
  expect(await readStoredDocs(page)).toEqual(beforeDocs);
});
