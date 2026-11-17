import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import type { openEditableInputs } from '../src/editor/editable-input-state';
let bundle: string | undefined;
async function fixture() {
  if (bundle) return bundle;
  const built = await build({ configFile:false, build:{write:false,lib:{entry:resolve('src/editor/editable-input-state.ts'),name:'EditableStoreFixture',formats:['iife']},rolldownOptions:{output:{codeSplitting:false}}} });
  const output = (Array.isArray(built)?built:[built]).flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk');
  if (!output || output.type !== 'chunk') throw new Error('Missing fixture'); return bundle=output.code;
}
for (const operation of ['fence','private','cancel-put','delete','cas'] as const) test(`editable sidecar transaction guards: ${operation}`, async ({page}) => {
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled(); await page.locator('#editor').fill('Guard fixture'); await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const id = await page.locator('#drafts').inputValue(); await page.addScriptTag({content:await fixture()});
  const result = await page.evaluate(async ({id,operation}) => {
    const api = (window as unknown as {EditableStoreFixture:{openEditableInputs:typeof openEditableInputs}}).EditableStoreFixture;
    const db = await new Promise<IDBDatabase>(resolve => {const r=indexedDB.open('typebridge');r.onsuccess=()=>resolve(r.result);});
    const row = await new Promise<{ownerInstanceId:string;fence:number}>(resolve=>{const q=db.transaction('editOwnership').objectStore('editOwnership').get(id);q.onsuccess=()=>resolve(q.result);});
    const fence = {instanceId:row.ownerInstanceId,fence:row.fence}; let current=true;
    const a=(await api.openEditableInputs(db,id,()=>current,()=>fence))!;
    const b=(await api.openEditableInputs(db,id,()=>true,()=>fence))!;
    await a.save(new Map([['x',5]]));
    let outcome: string;
    if (operation === 'cas') outcome = await b.save(new Map([['x',9]]));
    else if (operation === 'cancel-put') {
      const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(value,key){const r=put.call(this,value,key);if(value?.id==='editable:'+id)r.addEventListener('success',()=>{current=false;});return r;};
      try {await a.save(new Map([['x',9]]));} catch { /* Expected abort. */ } finally {IDBObjectStore.prototype.put=put;}
      current=true; outcome = await a.save(new Map([['x',8]]));
    } else { await new Promise<void>(resolve=>{const tx=db.transaction(['documents','editOwnership'],'readwrite');
      if(operation==='fence') tx.objectStore('editOwnership').put({...row,documentId:id,fence:row.fence+1});
      else if(operation==='delete') tx.objectStore('documents').delete(id);
      else {const q=tx.objectStore('documents').get(id);q.onsuccess=()=>tx.objectStore('documents').put({...q.result,private:true});}
      tx.oncomplete=()=>resolve();});
    outcome = await a.save(new Map([['x',9]])); }
    const inputs=await new Promise<unknown>(resolve=>{const q=db.transaction('readerStates').objectStore('readerStates').get('editable:'+id);q.onsuccess=()=>resolve(q.result.inputs);});
    a.close();b.close();db.close(); return {outcome,inputs};
  },{id,operation});
  expect(result.outcome).toBe(operation==='cas'?'conflict':'cancelled');expect(result.inputs).toEqual([['x',5]]);
});
