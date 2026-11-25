import { expect, test, type Page } from '@playwright/test';
import { setAutosave, selectDocument, documentAction } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';
const source = '# Calc\n\n```calc\ninput x = 2 in 0..10\ninput seed = 3\ny = x + seed\n```\n\n:input[x] :value[y]\n';
async function makeDocument(page: Page) {
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill(source);
  await page.locator('#doc-menu-open').click(); await page.locator('#document-format').selectOption('markdown'); await page.locator('#doc-menu-open').click();
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  return page.locator('#drafts').inputValue();
}
async function preview(page: Page) {
  await page.locator('#document-view-preview').click(); await expect(page.locator('#rendered-document .active-doc')).toBeVisible();
}
const input = (page: Page) => page.locator('#rendered-document input[data-active-input="x"]');
const status = (page: Page) => page.locator('#editable-input-status');
async function holdEditableRead(page: Page, id: string) {
  return page.evaluate(id=>{
    const get=IDBObjectStore.prototype.get; const view=window as unknown as {heldRemountRead:boolean;releaseRemountRead?:()=>void};
    IDBObjectStore.prototype.get=function(key){const r=get.call(this,key);if(this.name==='documents' && key===id && !view.heldRemountRead) {
      r.addEventListener('success',event=>{event.stopImmediatePropagation();view.heldRemountRead=true;view.releaseRemountRead=()=>{r.onsuccess?.call(r,new Event('success'));};},{once:true});
    }return r;};
  },id);
}
async function states(page: Page) {
  return page.evaluate(() => new Promise<Array<{id: string; inputs: [string,number][]}>>(resolve => {
    const r = indexedDB.open('typebridge'); r.onsuccess = () => { const db = r.result, q = db.transaction('readerStates').objectStore('readerStates').getAll(); q.onsuccess = () => { db.close(); resolve(q.result.filter(row => row.id.startsWith('editable:'))); }; };
  }));
}
test('input state survives remount, compatible source edits and restart without changing source/history', async ({ page }) => {
  const id = await makeDocument(page); await preview(page);
  const before = await readStoredDocs(page, true);
  await input(page).fill('5'); await expect(status(page)).toHaveText('Inputs saved on this device.');
  expect((await states(page))[0]).toMatchObject({id: 'editable:' + id, inputs: [['x',5],['seed',3]]});
  expect(await readStoredDocs(page, true)).toEqual(before);
  await page.locator('#document-view-edit').click(); await preview(page); await expect(input(page)).toHaveValue('5');
  await page.locator('#document-view-edit').click(); await page.locator('#editor').fill(source + '\nA comma, and a sentence.');
  await expect(page.locator('#save-indicator')).toHaveText('Saved'); await preview(page); await expect(input(page)).toHaveValue('5');
  await expect(page.locator('#rendered-document output')).toHaveText('8');
  await page.reload(); await expect(input(page)).toHaveValue('5');
  await page.locator('#editable-input-reset').click(); await expect(input(page)).toHaveValue('2');
  await expect(status(page)).toHaveText('Inputs saved on this device.');
  expect((await states(page))[0].inputs).toEqual([]);
  await page.reload(); await expect(input(page)).toHaveValue('2');
});
test('private changes survive remount in memory but are never retroactively saved', async ({ page }) => {
  await makeDocument(page); await preview(page);
  await input(page).fill('4'); await expect(status(page)).toHaveText('Inputs saved on this device.');
  const before = await states(page);
  await page.locator('#document-view-edit').click(); await setAutosave(page, false); await preview(page);
  await input(page).fill('8'); await page.locator('#document-view-edit').click(); await preview(page); await expect(input(page)).toHaveValue('8');
  await expect(status(page)).toContainText('temporary'); expect(await states(page)).toEqual(before);
  await page.locator('#document-view-edit').click(); await setAutosave(page, true); await preview(page);
  await input(page).fill('9'); await page.clock.install(); await page.clock.fastForward(1000);
  expect(await states(page)).toEqual(before); await expect(status(page)).toContainText('temporary');
});
test('failed preference proof latches the document into memory-only across remounts', async ({ page }) => {
  await makeDocument(page); await preview(page);
  await page.evaluate(() => {
    const get = Storage.prototype.getItem;
    (window as unknown as {restoreInputs:()=>void}).restoreInputs = () => { Storage.prototype.getItem = get; };
    Storage.prototype.getItem = function(key) { if(key === 'typebridge.autosave.v1') throw new Error('Denied'); return get.call(this,key); };
  });
  await input(page).fill('6'); await expect(status(page)).toContainText('temporary');
  await page.evaluate(() => (window as unknown as {restoreInputs:()=>void}).restoreInputs());
  await page.locator('#document-view-edit').click(); await preview(page); await input(page).fill('7');
  await page.clock.install(); await page.clock.fastForward(1000);
  expect(await states(page)).toEqual([]); await expect(status(page)).toContainText('temporary');
});
for (const comparison of [false,true]) test(`Rendered window saves inputs without source ownership (comparison=${comparison})`, async ({page,context}) => {
  const id=await makeDocument(page);
  await page.clock.install({time:new Date('2026-11-17T05:00:00Z')});await page.clock.pauseAt(new Date('2026-11-17T05:00:01Z'));
  const other=await context.newPage();await other.goto('/editor.html?doc='+id+(comparison?'&mode=view':''));
  await expect(other.locator('#editor')).toHaveValue(source);await expect(other.locator('#editor')).toHaveAttribute('readonly','');
  await other.locator('#document-view-preview').click();await other.clock.runFor(150);await expect(input(other)).toHaveValue('2');
  const owner=()=>page.evaluate(id=>new Promise<{ownerInstanceId:string;fence:number}>(resolve=>{const r=indexedDB.open('typebridge');r.onsuccess=()=>{const db=r.result,q=db.transaction('editOwnership').objectStore('editOwnership').get(id);q.onsuccess=()=>{db.close();resolve({ownerInstanceId:q.result.ownerInstanceId,fence:q.result.fence});};};}),id);
  const held=await owner();
  await page.evaluate(()=>{(window as unknown as {__typebridgeDelayPersistMs:number}).__typebridgeDelayPersistMs=5000;});
  const edited=source+'\nUnsaved source stays in its owner.';await page.locator('#editor').fill(edited);
  const before=await readStoredDocs(page,true);
  await input(other).fill('7');await other.clock.runFor(1000);await expect(status(other)).toHaveText('Inputs saved on this device.');
  expect(await owner()).toEqual(held);expect(await readStoredDocs(page,true)).toEqual(before);await expect(page.locator('#editor')).toHaveValue(edited);
  await expect(page.locator('#save-indicator')).toHaveText('Saving…');
  await other.reload();await expect(other.locator('#document-view')).toBeVisible();await other.clock.runFor(150);await expect(input(other)).toHaveValue('7');
  expect((await states(other))[0].inputs).toEqual([['x',7],['seed',3]]);expect(await owner()).toEqual(held);
  await page.evaluate(()=>{(window as unknown as {__typebridgeDelayPersistMs:number}).__typebridgeDelayPersistMs=0;});
  await page.clock.runFor(6000);await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await page.locator('#editor').fill(edited+' Still editable.');await page.clock.runFor(350);await expect(page.locator('#save-indicator')).toHaveText('Saved');
  expect(await owner()).toEqual(held);expect((await states(other))[0].inputs).toEqual([['x',7],['seed',3]]);
  await expect(other.locator('#editor')).toHaveValue(edited+' Still editable.');await other.clock.runFor(150);await expect(input(other)).toHaveValue('7');
  await input(other).fill('8');await other.clock.runFor(1000);await expect(status(other)).toHaveText('Inputs saved on this device.');
  expect(await owner()).toEqual(held);expect((await states(other))[0].inputs).toEqual([['x',8],['seed',3]]);
});

test('clear-document removes only the editable sidecar atomically with its source', async ({ page }) => {
  const id = await makeDocument(page); await preview(page); await input(page).fill('5'); await expect(status(page)).toHaveText('Inputs saved on this device.');
  await page.locator('#document-view-edit').click();
  await page.locator('#doc-menu-open').click(); await page.locator('#clear-document-data').click();
  await page.getByRole('dialog', {name:'Clear this document’s saved data?'}).getByRole('button', {name:'Clear saved data', exact:true}).click();
  await expect.poll(() => page.locator('#drafts').inputValue()).not.toBe(id);
  expect(await states(page)).toEqual([]);
});

test('model-only values restore by identity while current ranges reject incompatible values', async ({page}) => {
  const id=await makeDocument(page); await preview(page);
  await page.evaluate(id => new Promise<void>(resolve=>{const r=indexedDB.open('typebridge');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('readerStates','readwrite');tx.objectStore('readerStates').put({id:'editable:'+id,version:1,revision:1,inputs:[['x',20],['seed',7],['removed',4]]});tx.oncomplete=()=>{db.close();resolve();};};}),id);
  await page.reload();await expect(input(page)).toHaveValue('2');await expect(page.locator('#rendered-document output')).toHaveText('9');
  await input(page).fill('4');await expect(status(page)).toHaveText('Inputs saved on this device.');
  expect((await states(page))[0].inputs).toEqual([['x',4],['seed',7]]);
});

test('conflict keeps current values until explicit load and returns keyboard focus', async ({page}) => {
  const id=await makeDocument(page);await preview(page);
  await page.evaluate(id=>new Promise<void>(resolve=>{const r=indexedDB.open('typebridge');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('readerStates','readwrite');tx.objectStore('readerStates').put({id:'editable:'+id,version:1,revision:1,inputs:[['x',9],['seed',3]]});tx.oncomplete=()=>{db.close();resolve();};};}),id);
  await input(page).fill('4');await expect(status(page)).toContainText('Saved inputs changed');await expect(input(page)).toHaveValue('4');
  await page.locator('#editable-input-load').focus();await page.keyboard.press('Enter');await expect(input(page)).toHaveValue('9');
  await expect(page.locator('#editable-input-reset')).toBeFocused();
});
test('identical source under another editable ID does not inherit inputs', async ({page}) => {
  const first=await makeDocument(page);await preview(page);await input(page).fill('5');await expect(status(page)).toHaveText('Inputs saved on this device.');
  await page.locator('#document-view-edit').click();await page.locator('#doc-menu-open').click();await page.locator('#new-draft').click();
  await page.locator('#editor').fill(source);await page.locator('#doc-menu-open').click();await page.locator('#document-format').selectOption('markdown');await page.locator('#doc-menu-open').click();
  await expect(page.locator('#save-indicator')).toHaveText('Saved');const second=await page.locator('#drafts').inputValue();expect(second).not.toBe(first);
  await preview(page);await expect(input(page)).toHaveValue('2');await input(page).fill('7');await expect(status(page)).toHaveText('Inputs saved on this device.');
  expect(await states(page)).toEqual(expect.arrayContaining([expect.objectContaining({id:'editable:'+first,inputs:[['x',5],['seed',3]]}),expect.objectContaining({id:'editable:'+second,inputs:[['x',7],['seed',3]]})]));
});

test('numeric state controls fit 320px and reset is keyboard accessible', async ({page}) => {
  await page.setViewportSize({width:320,height:720});await makeDocument(page);await preview(page);
  const reset=page.locator('#editable-input-reset');await expect(reset).toBeVisible();
  expect(await reset.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await input(page).fill('5');await expect(status(page)).toHaveText('Inputs saved on this device.');
  await reset.focus();await page.keyboard.press('Enter');await expect(input(page)).toHaveValue('2');await expect(reset).toBeFocused();
  await page.screenshot({path:'/tmp/tb326-phone.png',fullPage:true});
});

test('pending CAS baseline survives real owner handoff, repeated remounts and local reset', async ({page, context}) => {
  const id = await makeDocument(page); await preview(page);
  await page.clock.install({time:new Date('2026-11-17T05:00:00Z')}); await page.clock.pauseAt(new Date('2026-11-17T05:00:01Z'));
  await input(page).fill('5'); await page.locator('#document-view-edit').click();
  await documentAction(page,'#new-draft'); await expect(page.locator('#drafts')).not.toHaveValue(id);
  const other = await context.newPage(); await other.goto('/editor.html?doc='+id);
  await expect(other.locator('#editor')).toBeEditable(); await other.locator('#document-view-preview').click(); await other.clock.runFor(150); await expect(input(other)).toBeVisible();
  await input(other).fill('9'); await other.clock.runFor(1000); await expect(status(other)).toHaveText('Inputs saved on this device.');
  const durable = await states(other);
  await other.locator('#document-view-edit').click(); await documentAction(other,'#new-draft');
  await selectDocument(page,id); await expect(page.locator('#editor')).toBeEditable();
  const renderAgain = async () => { await page.locator('#document-view-preview').click(); await page.clock.runFor(150); await expect(input(page)).toBeVisible(); };
  await renderAgain(); await expect(input(page)).toHaveValue('5'); await page.clock.runFor(1000);
  expect(await states(page)).toEqual(durable); await expect(status(page)).toContainText('Saved inputs changed');
  await page.locator('#document-view-edit').click(); await renderAgain(); await page.clock.runFor(1000);
  expect(await states(page)).toEqual(durable); await expect(page.locator('#editable-input-load')).toBeVisible();
  await page.locator('#editable-input-reset').click(); await expect(input(page)).toHaveValue('2'); await page.clock.runFor(1000);
  expect(await states(page)).toEqual(durable);
  await page.locator('#document-view-edit').click(); await renderAgain(); await page.clock.runFor(1000);
  expect(await states(page)).toEqual(durable);
  await page.locator('#editable-input-load').click(); await page.clock.runFor(150); await expect(input(page)).toHaveValue('9');
  await input(page).fill('7'); await page.clock.runFor(1000); await expect(status(page)).toHaveText('Inputs saved on this device.');
  expect((await states(page))[0].inputs).toEqual([['x',7],['seed',3]]);
});
for (const completion of ['release','timeout'] as const) test(`late public prepare cannot hide private preview controls: ${completion}`, async ({page}) => {
  const first = await makeDocument(page);
  await documentAction(page,'#new-draft'); await page.locator('#editor').fill(source.replace('input x = 2','input x = 8'));
  await page.locator('#doc-menu-open').click(); await page.locator('#document-format').selectOption('markdown'); await page.locator('#doc-menu-open').click();
  await expect(page.locator('#save-indicator')).toHaveText('Saved'); const second = await page.locator('#drafts').inputValue();
  await setAutosave(page,false); await preview(page); await input(page).fill('6'); await page.locator('#document-view-edit').click();
  await selectDocument(page,first);
  await page.evaluate(id => {
    const get=IDBObjectStore.prototype.get; const view=window as unknown as {heldInputsRead:boolean;releaseInputsRead?:()=>void};
    IDBObjectStore.prototype.get=function(key){const r=get.call(this,key); if(this.name==='documents' && key===id && !view.heldInputsRead) {
      r.addEventListener('success',event=>{event.stopImmediatePropagation();view.heldInputsRead=true;view.releaseInputsRead=()=>{r.onsuccess?.call(r,new Event('success'));};},{once:true});
    } return r;};
  },first);
  await page.clock.install({time:new Date('2026-11-17T05:00:00Z')}); await page.clock.pauseAt(new Date('2026-11-17T05:00:01Z'));
  await page.locator('#document-view-preview').click(); await page.clock.runFor(150);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {heldInputsRead:boolean}).heldInputsRead)).toBe(true);
  await selectDocument(page,second); await page.clock.runFor(150); await expect(input(page)).toHaveValue('6');
  await expect(page.locator('#editable-input-reset')).toBeVisible(); const before = await readStoredDocs(page,true), inputBefore = await states(page);
  if(completion==='release') await page.evaluate(()=>(window as unknown as {releaseInputsRead:()=>void}).releaseInputsRead());
  await page.clock.runFor(2100);
  await expect(status(page)).toBeVisible(); await expect(page.locator('#editable-input-reset')).toBeVisible();
  await page.locator('#editable-input-reset').click(); await expect(input(page)).toHaveValue('8');
  expect(await readStoredDocs(page,true)).toEqual(before); expect(await states(page)).toEqual(inputBefore);
});

test('an interrupted reset keeps its empty-snapshot intent and original CAS base on remount', async ({page}) => {
  await makeDocument(page); await preview(page); await input(page).fill('5'); await expect(status(page)).toHaveText('Inputs saved on this device.');
  await page.evaluate(() => {
    const put=IDBObjectStore.prototype.put; let intercepted=false;
    IDBObjectStore.prototype.put=function(value,key){const r=put.call(this,value,key); if(this.name==='readerStates' && value?.id?.startsWith('editable:') && !intercepted) {
      intercepted=true; r.addEventListener('success',()=>document.querySelector<HTMLButtonElement>('#document-view-edit')!.click(),{once:true});
    } return r;};
  });
  await page.locator('#editable-input-reset').click(); await expect(page.locator('#editor')).toBeVisible();
  await preview(page); await expect(input(page)).toHaveValue('2'); await expect(status(page)).toHaveText('Inputs saved on this device.');
  expect((await states(page))[0]).toMatchObject({revision:2,inputs:[]});
});

for (const completion of ['release','timeout'] as const) test(`cancelled public preparation restores and keeps saving on rapid remount: ${completion}`, async ({page}) => {
  const id=await makeDocument(page);await preview(page);await input(page).fill('5');await expect(status(page)).toHaveText('Inputs saved on this device.');
  await page.locator('#document-view-edit').click();await page.reload();await expect(page.locator('#editor')).toHaveValue(source);await expect(page.locator('#editor')).toBeEditable();
  await holdEditableRead(page,id);
  await page.clock.install({time:new Date('2026-11-17T05:00:00Z')});await page.clock.pauseAt(new Date('2026-11-17T05:00:01Z'));
  await page.locator('#document-view-preview').click();await page.clock.runFor(150);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {heldRemountRead:boolean}).heldRemountRead)).toBe(true);
  await page.locator('#document-view-edit').click();await page.locator('#document-view-preview').click();await page.clock.runFor(150);
  await expect(input(page)).toHaveValue('5');
  if(completion==='release')await page.evaluate(()=>(window as unknown as {releaseRemountRead:()=>void}).releaseRemountRead());
  await page.clock.runFor(2100);await expect(page.locator('#editable-input-reset')).toBeVisible();await expect(input(page)).toHaveValue('5');
  await input(page).fill('7');await page.clock.runFor(1000);await expect(status(page)).toHaveText('Inputs saved on this device.');
  expect((await states(page))[0].inputs).toEqual([['x',7],['seed',3]]);
  await page.locator('#document-view-edit').click();await page.locator('#document-view-preview').click();await page.clock.runFor(150);await expect(input(page)).toHaveValue('7');
});

test('a genuine active storage timeout stays memory-only after the old read recovers', async ({page}) => {
  const id=await makeDocument(page);await preview(page);await input(page).fill('5');await expect(status(page)).toHaveText('Inputs saved on this device.');
  await page.locator('#document-view-edit').click();await page.reload();await expect(page.locator('#editor')).toHaveValue(source);await expect(page.locator('#editor')).toBeEditable();
  const before=await states(page);await holdEditableRead(page,id);
  await page.clock.install({time:new Date('2026-11-17T05:00:00Z')});await page.clock.pauseAt(new Date('2026-11-17T05:00:01Z'));
  await page.locator('#document-view-preview').click();await page.clock.runFor(150);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {heldRemountRead:boolean}).heldRemountRead)).toBe(true);
  await page.clock.runFor(2100);await expect(input(page)).toHaveValue('2');await expect(status(page)).toContainText('temporary');
  await page.evaluate(()=>(window as unknown as {releaseRemountRead:()=>void}).releaseRemountRead());await input(page).fill('7');
  await page.locator('#document-view-edit').click();await page.locator('#document-view-preview').click();await page.clock.runFor(150);await expect(input(page)).toHaveValue('7');
  await input(page).fill('8');await page.clock.runFor(1000);await expect(status(page)).toContainText('temporary');expect(await states(page)).toEqual(before);
});

test('two Rendered writers use independent numeric CAS without taking source ownership', async ({page,context}) => {
  const id=await makeDocument(page);
  const other=await context.newPage(), third=await context.newPage();
  for(const reader of [other,third]){await reader.goto('/editor.html?doc='+id+'&mode=view');await expect(reader.locator('#editor')).toHaveValue(source);await preview(reader);}
  const owners=()=>page.evaluate(id=>new Promise<string>(resolve=>{const r=indexedDB.open('typebridge');r.onsuccess=()=>{const db=r.result,q=db.transaction('editOwnership').objectStore('editOwnership').get(id);q.onsuccess=()=>{db.close();resolve(JSON.stringify({owner:q.result.ownerInstanceId,fence:q.result.fence}));};};}),id);
  const before=await owners();await input(other).fill('5');await expect(status(other)).toHaveText('Inputs saved on this device.');
  const saved=await states(other);await input(third).fill('7');await expect(status(third)).toContainText('Saved inputs changed');expect(await states(third)).toEqual(saved);
  await third.locator('#editable-input-load').click();await expect(input(third)).toHaveValue('5');await input(third).fill('8');await expect(status(third)).toHaveText('Inputs saved on this device.');
  const newer=await states(third);await input(other).fill('6');await expect(status(other)).toContainText('Saved inputs changed');expect(await states(other)).toEqual(newer);
  expect(await owners()).toBe(before);await expect(page.locator('#editor')).toBeEditable();
});
test('document privacy in source owner freezes another Rendered window without retrospective saving', async ({page,context}) => {
  const id=await makeDocument(page);const other=await context.newPage();await other.goto('/editor.html?doc='+id);await expect(other.locator('#editor')).toHaveValue(source);await preview(other);
  await input(other).fill('5');await expect(status(other)).toHaveText('Inputs saved on this device.');const before=await states(other);
  await setAutosave(page,false);await expect(other.locator('#autosave')).not.toBeChecked();
  await input(other).fill('8');await expect(status(other)).toContainText('temporary');
  await setAutosave(page,true);await expect(other.locator('#autosave')).toBeChecked();await input(other).fill('9');
  await other.clock.install();await other.clock.fastForward(1000);expect(await states(other)).toEqual(before);await expect(status(other)).toContainText('temporary');
  await other.reload();await expect(other.locator('#document-view')).toBeVisible();await other.clock.runFor(150);await expect(input(other)).toHaveValue('5');
});
test('a retired document policy generation freezes pending cache even with unchanged numeric revision', async ({page}) => {
  const id=await makeDocument(page);await preview(page);await input(page).fill('5');await expect(status(page)).toHaveText('Inputs saved on this device.');
  await page.clock.install({time:new Date('2026-11-17T05:00:00Z')});await page.clock.pauseAt(new Date('2026-11-17T05:00:01Z'));
  await input(page).fill('8');await page.locator('#document-view-edit').click();const before=await states(page);
  // Simulate a missed privacy cycle: public again, unchanged numeric CAS, new policy generation.
  await page.evaluate(id=>new Promise<void>(resolve=>{const r=indexedDB.open('typebridge');r.onsuccess=()=>{const db=r.result,tx=db.transaction('documents','readwrite'),q=tx.objectStore('documents').get(id);q.onsuccess=()=>tx.objectStore('documents').put({...q.result,inputEpoch:crypto.randomUUID()});tx.oncomplete=()=>{db.close();resolve();};};}),id);
  await page.locator('#document-view-preview').click();await page.clock.runFor(150);await expect(input(page)).toHaveValue('8');await expect(status(page)).toContainText('temporary');
  await input(page).fill('9');await page.clock.runFor(1000);expect(await states(page)).toEqual(before);
  await page.reload();await expect(page.locator('#document-view')).toBeVisible();await page.clock.runFor(150);await expect(input(page)).toHaveValue('5');
});

test('a stale public view observing a private row cannot rearm cached inputs after privacy ends', async ({page}) => {
  const id=await makeDocument(page);
  const flag=(value:boolean)=>page.evaluate(({id,value})=>new Promise<void>(resolve=>{const r=indexedDB.open('typebridge');r.onsuccess=()=>{const db=r.result,tx=db.transaction('documents','readwrite'),q=tx.objectStore('documents').get(id);q.onsuccess=()=>tx.objectStore('documents').put({...q.result,private:value,inputEpoch:q.result.inputEpoch+'-retired'});tx.oncomplete=()=>{db.close();resolve();};};}),{id,value});
  // No advisory signal: the displayed source is stale, but the authoritative row is private.
  await flag(true);await preview(page);await input(page).fill('8');await expect(status(page)).toContainText('temporary');
  await page.locator('#document-view-edit').click();await flag(false);await preview(page);await expect(input(page)).toHaveValue('8');
  await input(page).fill('9');await page.clock.install();await page.clock.fastForward(1000);
  expect(await states(page)).toEqual([]);await expect(status(page)).toContainText('temporary');
});

test('editor shares a fixed input snapshot and Edit initializes only new copies', async ({ page, browser }) => {
  await makeDocument(page);
  await preview(page);
  await input(page).fill('7');
  await expect(page.locator('#rendered-document output')).toHaveText('10');
  await page.locator('#share-open').click();
  const dialog = page.getByRole('dialog', { name: 'Share link', exact: true });
  const parameters = dialog.getByLabel('Include current parameters');
  const url = dialog.locator('#share-url');
  await expect(parameters).not.toBeChecked();
  const defaultsLink = await url.inputValue();
  await parameters.check();
  await expect(dialog.locator('#share-copy')).toBeEnabled();
  const snapshotLink = await url.inputValue();
  expect(snapshotLink).not.toBe(defaultsLink);
  await page.keyboard.press('Escape');
  await input(page).fill('4');

  const context = await browser.newContext({ storageState: {
    cookies: [],
    origins: [{ origin: new URL(snapshotLink).origin, localStorage: [{ name: 'typebridge.welcomeSeen.v1', value: '1' }] }],
  } });
  try {
    const recipient = await context.newPage();
    await recipient.goto(defaultsLink);
    await expect(recipient.locator('#read-text input')).toHaveValue('2');
    await recipient.goto(snapshotLink);
    await expect(recipient.locator('#read-text input')).toHaveValue('7');
    await expect(recipient.locator('#read-text output')).toHaveText('10');
    await recipient.locator('#read-text input').fill('9');
    await recipient.locator('#edit-copy').click();
    await expect(recipient.locator('.host-status')).toHaveText('Saved as a new document in your Documents.');
    const editor = recipient.frameLocator('iframe[src*="doc="]');
    await expect(editor.locator('#editor')).toHaveValue(source);
    await editor.locator('#document-view-preview').click();
    const copiedInput = editor.locator('#rendered-document input[data-active-input="x"]');
    await expect(copiedInput).toHaveValue('7');
    await editor.locator('#editable-input-reset').click();
    await expect(copiedInput).toHaveValue('2');
    await expect(editor.locator('#editable-input-status')).toHaveText('Inputs saved on this device.');

    const copyId = await editor.locator('#drafts').inputValue();
    await recipient.goto(snapshotLink);
    await expect(recipient.locator('#edit-copy')).toBeVisible();
    // Model an unowned copy explicitly. Navigation can leave a stale ownership
    // fence, and the normal fallback deliberately refuses to reuse that candidate.
    await recipient.evaluate(id => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('typebridge');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('editOwnership', 'readwrite');
        tx.objectStore('editOwnership').delete(id);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), copyId);
    await recipient.locator('#edit-copy').click();
    await expect(recipient.locator('.host-status')).toHaveText('Opened an existing document from your Documents.');
    const edit = editor.locator('#document-view-edit');
    await expect(edit).toBeVisible();
    if (await edit.getAttribute('aria-pressed') === 'true') await editor.locator('#document-view-preview').click();
    await expect(copiedInput).toHaveValue('2');
  } finally {
    await context.close();
  }
});
