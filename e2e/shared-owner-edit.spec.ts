import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';
import { fillHostEditor } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

type HeldWindow = Window & { BroadcastChannel: typeof BroadcastChannel; __allowReuseResults?: boolean; __heldReuseResults?: unknown[]; __reuseCommits?: number; __reuseProbes?: number };
async function ownerAndReader(owner: Page, context: BrowserContext, hold = false) {
  if (hold) await owner.addInitScript(() => {
    const view = window as HeldWindow;
    const native = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (value) {
      if (this.name === 'typebridge-shared-copy-reuse.v1' && value?.type === 'result' && value?.outcome !== 'unknown' && !view.__allowReuseResults) {
        (view.__heldReuseResults ??= []).push(value); return;
      }
      return native.call(this, value);
    };
  });
  await owner.goto('/');
  const first = owner.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(first.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await fillHostEditor(first, 'Owner original source\n');
  await expect(first.locator('#save-indicator')).toHaveText('Saved');
  const row = (await readStoredDocs(owner)).find(row => row.text === 'Owner original source\n')!;
  await owner.getByRole('button', { name: 'New window' }).click();
  await expect(owner.frameLocator('.host-window[data-window-id="w2"] iframe').locator('#editor')).toBeEnabled({ timeout: 30_000 });
  const encoded = await encodeSharePayload({ title: row.title, text: row.text, format: 'plain', view: 'source', edit: true });
  if (!encoded.ok) throw new Error('share encoding failed');
  const reader = await context.newPage();
  await reader.addInitScript(() => {
    const view = window as HeldWindow;
    view.__reuseCommits = 0; view.__reuseProbes = 0;
    const native = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (value) {
      if (this.name === 'typebridge-shared-copy-reuse.v1' && value?.type === 'commit') view.__reuseCommits = (view.__reuseCommits ?? 0) + 1;
      if (this.name === 'typebridge-shared-copy-reuse.v1' && value?.type === 'probe') view.__reuseProbes = (view.__reuseProbes ?? 0) + 1;
      return native.call(this, value);
    };
  });
  const requests: string[] = [];
  reader.on('request', request => requests.push(new URL(request.url()).pathname));
  await reader.goto('/read.html#doc=' + encoded.payload);
  await expect(reader.locator('#read-text')).toHaveText(row.text, { useInnerText: false });
  return { reader, first, row, requests };
}
async function allowResults(owner: Page, flush = false) {
  await owner.locator('.host-window[data-window-id="main"] iframe').evaluate((frame: HTMLIFrameElement, flush) => {
    const view = frame.contentWindow as HeldWindow;
    view.__allowReuseResults = true;
    if (flush) {
      const channel = new view.BroadcastChannel('typebridge-shared-copy-reuse.v1');
      for (const message of view.__heldReuseResults ?? []) channel.postMessage(message);
      channel.close(); view.__heldReuseResults = [];
    }
  }, flush);
}

test('shared Edit activates a clean existing owner without another document or navigation', async ({ page: owner, context }) => {
  const { reader, first, requests } = await ownerAndReader(owner, context);
  const before = await readStoredDocs(owner);
  await reader.locator('#edit-copy').click();
  await expect(reader.locator('#read-status')).toContainText('Opened the existing document', { timeout: 10_000 });
  await expect(reader).toHaveURL(/\/read.html#doc=/);
  await expect(owner.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-active/);
  await expect(first.locator('#editor')).toHaveValue('Owner original source\n');
  expect(await readStoredDocs(owner)).toEqual(before);
  await expect(reader.locator('#read-edit-actions')).toBeHidden();
  expect(requests.filter(path => /active-renderer|katex/.test(path))).toEqual([]);
  await reader.close();
});

test('dirty live owner refuses and safe fallback preserves the original editor', async ({ page: owner, context }) => {
  const { reader, first, row } = await ownerAndReader(owner, context);
  await first.locator('#editor').evaluate((field: HTMLTextAreaElement) => { field.value = 'Unsaved owner text'; });
  await reader.locator('#edit-copy').click();
  await expect(reader.locator('.host-status')).toHaveText('Saved as a new document in your Documents.', { timeout: 10_000 });
  await expect(first.locator('#editor')).toHaveValue('Unsaved owner text');
  const rows = await readStoredDocs(owner);
  expect(rows).toHaveLength(2);
  expect(rows.find(item => item.id === row.id)).toEqual(row);
  expect(rows.filter(item => item.text === row.text)).toHaveLength(2);
  await reader.close();
});

test('lost activation acknowledgement never creates a copy; explicit status reconciles without a second commit', async ({ page: owner, context }) => {
  const { reader } = await ownerAndReader(owner, context, true);
  const before = await readStoredDocs(owner);
  await reader.locator('#edit-copy').click();
  await expect(reader.locator('#read-status')).toContainText('Activation status is unknown', { timeout: 10_000 });
  await reader.locator('#edit-copy').evaluate((link: HTMLAnchorElement) => link.click());
  expect(await reader.evaluate(() => (window as HeldWindow).__reuseCommits)).toBe(1);
  expect(await readStoredDocs(owner)).toEqual(before);
  await reader.locator('#check-owner-status').click();
  await expect(reader.locator('#check-owner-status')).toBeEnabled({ timeout: 10_000 });
  await expect(reader.locator('#read-status')).toContainText('Activation status is unknown');
  await allowResults(owner);
  await reader.locator('#check-owner-status').click();
  await expect(reader.locator('#read-status')).toContainText('Opened the existing document');
  expect(await reader.evaluate(() => (window as HeldWindow).__reuseCommits)).toBe(1);
  expect(await readStoredDocs(owner)).toEqual(before);
  await reader.close();
});

test('unknown activation needs confirmation before creating a separate new copy', async ({ page: owner, context }) => {
  const { reader, row } = await ownerAndReader(owner, context, true);
  const before = await readStoredDocs(owner);
  await reader.locator('#edit-copy').click();
  await expect(reader.locator('#read-status')).toContainText('Activation status is unknown', { timeout: 10_000 });
  await reader.locator('#create-new-copy').click();
  await expect(reader.getByRole('dialog')).toContainText('may duplicate');
  await reader.getByRole('button', { name: 'Keep reading', exact: true }).click();
  await expect(reader.locator('#create-new-copy')).toBeFocused();
  expect(await readStoredDocs(owner)).toEqual(before);
  await reader.locator('#create-new-copy').click();
  await reader.getByRole('dialog').getByRole('button', { name: 'Create new copy', exact: true }).click();
  await expect(reader.locator('.host-status')).toHaveText('Saved as a new document in your Documents.', { timeout: 10_000 });
  const rows = await readStoredDocs(owner);
  expect(rows).toHaveLength(before.length + 1);
  expect(rows.find(item => item.id === row.id)).toEqual(row);
  await allowResults(owner, true);
  await expect(reader.locator('.host-status')).toHaveText('Saved as a new document in your Documents.');
  await reader.close();
});

test('history lifecycle keeps an unknown warning; old replies cannot complete a different shared document', async ({ page: owner, context }) => {
  const { reader } = await ownerAndReader(owner, context, true);
  const before = await readStoredDocs(owner);
  await reader.locator('#edit-copy').click();
  await expect(reader.locator('#read-status')).toContainText('Activation status is unknown', { timeout: 10_000 });
  await reader.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(reader.locator('#read-status')).toContainText('Activation status is unknown');
  await expect(reader.locator('#check-owner-status')).toBeDisabled();
  await expect(reader.locator('#edit-copy')).toHaveAttribute('aria-disabled', 'true');
  const encoded = await encodeSharePayload({ title: 'Different document', text: 'Different shared source', format: 'plain', view: 'source', edit: true });
  if (!encoded.ok) throw new Error('encoding failed');
  await reader.evaluate(payload => { location.hash = '#doc=' + payload; }, encoded.payload);
  await expect(reader.locator('#read-text')).toHaveText('Different shared source');
  await allowResults(owner, true);
  await expect(reader.locator('#read-text')).toHaveText('Different shared source');
  await expect(reader.locator('#read-status')).toHaveText('');
  expect(await readStoredDocs(owner)).toEqual(before);
  await reader.close();
});

test('shared Edit preserves live calc inputs in the existing Rendered editor and shared reader', async ({ page: owner, context }) => {
  const source = '```calc\ninput x = 2\ny = x * 3\n```\n\n:input[x] :value[y]\n';
  await owner.goto('/');
  const first = owner.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(first.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await fillHostEditor(first, source);
  await first.locator('#doc-menu-open').click();
  await first.locator('#document-format').selectOption('markdown');
  await first.locator('#doc-menu-open').click();
  await expect(first.locator('#save-indicator')).toHaveText('Saved');
  await first.locator('#document-view-preview').click();
  await expect(first.locator('#rendered-document input')).toHaveValue('2');
  await first.locator('#rendered-document input').fill('7');
  await expect(first.locator('#rendered-document output')).toHaveText('21');
  await expect.poll(async () => (await readStoredDocs(owner, true)).find(row => row.text === source)?.format).toBe('markdown');
  const before = await readStoredDocs(owner, true);
  const row = before.find(row => row.text === source)!;
  await owner.getByRole('button', { name: 'New window' }).click();
  await expect(owner.frameLocator('.host-window[data-window-id="w2"] iframe').locator('#editor')).toBeEnabled({ timeout: 30_000 });
  const encoded = await encodeSharePayload({ title: row.title, text: source, format: 'markdown', view: 'rendered', edit: true });
  if (!encoded.ok) throw new Error('encoding failed');
  const reader = await context.newPage();
  await reader.goto('/read.html#doc=' + encoded.payload);
  await expect(reader.locator('#read-text input')).toHaveValue('2');
  await reader.locator('#read-text input').fill('11');
  await expect(reader.locator('#read-text output')).toHaveText('33');
  await reader.locator('#edit-copy').click();
  await expect(reader.locator('#read-status')).toContainText('Opened the existing document', { timeout: 10_000 });
  await expect(first.locator('#rendered-document input')).toHaveValue('7');
  await expect(first.locator('#rendered-document output')).toHaveText('21');
  await expect(reader.locator('#read-text input')).toHaveValue('11');
  await expect(reader.locator('#read-text output')).toHaveText('33');
  expect(await readStoredDocs(owner, true)).toEqual(before);
  await reader.close();
});

test('sender-disabled Edit never probes or creates a document, even if invoked programmatically', async ({ page: owner, context }) => {
  const { reader, row } = await ownerAndReader(owner, context);
  const encoded = await encodeSharePayload({ title: row.title, text: row.text, format: 'plain', view: 'source', edit: false });
  if (!encoded.ok) throw new Error('encoding failed');
  await reader.evaluate(payload => { location.hash = '#doc=' + payload; }, encoded.payload);
  await expect(reader.locator('#edit-copy')).toBeHidden();
  await expect(reader.locator('#read-title')).toHaveText(row.title);
  const before = await readStoredDocs(owner);
  await reader.locator('#edit-copy').evaluate((link: HTMLAnchorElement) => link.click());
  expect(await reader.evaluate(() => ({ commits: (window as HeldWindow).__reuseCommits, probes: (window as HeldWindow).__reuseProbes }))).toEqual({ commits: 0, probes: 0 });
  expect(await readStoredDocs(owner)).toEqual(before);
  await reader.close();
});

test('privacy transitions preserve an unknown warning and never automatically create a copy', async ({ page: owner, context }) => {
  const { reader } = await ownerAndReader(owner, context, true);
  const before = await readStoredDocs(owner);
  await reader.locator('#edit-copy').click();
  await expect(reader.locator('#read-status')).toContainText('Activation status is unknown', { timeout: 10_000 });
  await owner.evaluate(() => { localStorage.setItem('typebridge.autosave.v1', 'off'); });
  await expect(reader.locator('#check-owner-status')).toBeDisabled();
  await expect(reader.locator('#edit-copy')).toHaveAttribute('aria-disabled', 'true');
  await owner.evaluate(() => { localStorage.removeItem('typebridge.autosave.v1'); });
  await expect(reader.locator('#read-status')).toContainText('Activation status is unknown');
  expect(await reader.evaluate(() => (window as HeldWindow).__reuseCommits)).toBe(1);
  expect(await readStoredDocs(owner)).toHaveLength(before.length);
  await expect(reader).toHaveURL(/\/read.html#doc=/);
  await reader.close();
});

test('unknown results for two shared keys retain both warnings when revisiting either key', async ({ page: owner, context }) => {
  const { reader } = await ownerAndReader(owner, context, true);
  const firstHash = await reader.evaluate(() => location.hash);
  await reader.locator('#edit-copy').click();
  await expect(reader.locator('#read-status')).toContainText('Activation status is unknown', { timeout: 10_000 });
  const second = owner.frameLocator('.host-window[data-window-id="w2"] iframe');
  await fillHostEditor(second, 'Second owned source');
  await expect(second.locator('#save-indicator')).toHaveText('Saved');
  const row = (await readStoredDocs(owner)).find(row => row.text === 'Second owned source')!;
  const encoded = await encodeSharePayload({ title: row.title, text: row.text, format: 'plain', view: 'source', edit: true });
  if (!encoded.ok) throw new Error('encoding failed');
  await reader.evaluate(payload => { location.hash = '#doc=' + payload; }, encoded.payload);
  await expect(reader.locator('#read-text')).toHaveText('Second owned source');
  await reader.locator('#edit-copy').click();
  await expect(reader.locator('#read-status')).toContainText('Activation status is unknown', { timeout: 10_000 });
  await reader.evaluate(hash => { location.hash = hash; }, firstHash);
  await expect(reader.locator('#read-text')).toHaveText('Owner original source\n', { useInnerText: false });
  await expect(reader.locator('#read-status')).toContainText('Activation status is unknown');
  await expect(reader.locator('#edit-copy')).toHaveAttribute('aria-disabled', 'true');
  expect(await reader.evaluate(() => (window as HeldWindow).__reuseCommits)).toBe(2);
  expect(await readStoredDocs(owner)).toHaveLength(2);
  await reader.close();
});

for (const timing of ['during', 'after'] as const) {
  test(`Keep reading cancels fallback when terminal refusal arrives ${timing} confirmation`, async ({ page: owner, context }) => {
    const { reader } = await ownerAndReader(owner, context, true);
    await owner.evaluate(() => {
      (window as unknown as { __typebridgeActivateExistingEditor: () => boolean }).__typebridgeActivateExistingEditor = () => false;
    });
    const before = await readStoredDocs(owner);
    await reader.locator('#edit-copy').click();
    await expect(reader.locator('#read-status')).toContainText('Activation status is unknown', { timeout: 10_000 });
    await reader.locator('#create-new-copy').click();
    await expect(reader.getByRole('dialog')).toBeVisible();
    if (timing === 'during') await allowResults(owner, true);
    await reader.getByRole('button', { name: 'Keep reading', exact: true }).click();
    if (timing === 'after') await allowResults(owner, true);
    await expect(reader.locator('#read-status')).toHaveText('You can keep reading or choose Edit again.');
    await expect(reader.locator('#edit-copy')).toBeFocused();
    await expect(reader).toHaveURL(/\/read.html#doc=/);
    await expect(reader.locator('#edit-copy')).toBeEnabled();
    expect(await readStoredDocs(owner)).toEqual(before);
    await reader.close();
  });
}
