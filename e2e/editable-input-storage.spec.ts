import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import type { openEditableInputs } from '../src/editor/editable-input-state';
import type * as DocumentStore from '../src/editor/indexeddb';
let bundle: string | undefined;
async function fixture() {
  if (bundle) return bundle;
  const built = await build({ configFile:false, build:{write:false,lib:{entry:resolve('e2e/fixtures/editable-input-store.ts'),name:'EditableStoreFixture',formats:['iife']},rolldownOptions:{output:{codeSplitting:false}}} });
  const output = (Array.isArray(built)?built:[built]).flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk');
  if (!output || output.type !== 'chunk') throw new Error('Missing fixture'); return bundle=output.code;
}
for (const operation of ['source-owner','private','cancel-put','delete','cas','stale-base','policy-epoch','capability'] as const) test(`editable sidecar transaction guards: ${operation}`, async ({page}) => {
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled(); await page.locator('#editor').fill('Guard fixture'); await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const id = await page.locator('#drafts').inputValue(); await page.addScriptTag({content:await fixture()});
  const result = await page.evaluate(async ({id,operation}) => {
    const api = (window as unknown as {EditableStoreFixture:{openEditableInputs:typeof openEditableInputs}}).EditableStoreFixture;
    const db = await new Promise<IDBDatabase>(resolve => {const r=indexedDB.open('typebridge');r.onsuccess=()=>resolve(r.result);});
    const row = await new Promise<{ownerInstanceId:string;fence:number}>(resolve=>{const q=db.transaction('editOwnership').objectStore('editOwnership').get(id);q.onsuccess=()=>resolve(q.result);});
    let current=true, canEdit=true;
    const a=(await api.openEditableInputs(db,id,()=>current,()=>canEdit))!;
    const b=(await api.openEditableInputs(db,id,()=>true,()=>canEdit))!;
    await a.save(new Map([['x',5]]));
    let outcome: string;
    if (operation === 'stale-base') {
      const reopened=(await api.openEditableInputs(db,id,()=>true,()=>canEdit))!;
      outcome=await reopened.save(new Map([['x',9]]),0); reopened.close();
    } else if (operation === 'cas') outcome = await b.save(new Map([['x',9]]));
    else if (operation === 'cancel-put') {
      const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(value,key){const r=put.call(this,value,key);if(value?.id==='editable:'+id)r.addEventListener('success',()=>{current=false;});return r;};
      try {await a.save(new Map([['x',9]]));} catch { /* Expected abort. */ } finally {IDBObjectStore.prototype.put=put;}
      current=true; outcome = await a.save(new Map([['x',8]]));
    } else if(operation==='capability') { canEdit=false;outcome=await a.save(new Map([['x',9]]));
    } else { await new Promise<void>(resolve=>{const tx=db.transaction(['documents','editOwnership'],'readwrite');
      if(operation==='source-owner') tx.objectStore('editOwnership').put({...row,documentId:id,fence:row.fence+1});
      else if(operation==='delete') tx.objectStore('documents').delete(id);
      else {const q=tx.objectStore('documents').get(id);q.onsuccess=()=>tx.objectStore('documents').put({...q.result,...(operation==='policy-epoch'?{inputEpoch:crypto.randomUUID()}:{private:true})});}
      tx.oncomplete=()=>resolve();});
    outcome = await a.save(new Map([['x',9]])); }
    const inputs=await new Promise<unknown>(resolve=>{const q=db.transaction('readerStates').objectStore('readerStates').get('editable:'+id);q.onsuccess=()=>resolve(q.result.inputs);});
    a.close();b.close();db.close(); return {outcome,inputs};
  },{id,operation});
  expect(result.outcome).toBe(operation==='cas'||operation==='stale-base'?'conflict':operation==='source-owner'?'saved':'cancelled');expect(result.inputs).toEqual([['x',operation==='source-owner'?9:5]]);
});

for(const operation of ['flag-only-privacy-cycle','delete-recreate'] as const) test(`input generation rejects retired handles after ${operation}`, async ({page})=>{
  await page.goto('/editor.html');await expect(page.locator('#editor')).toBeEnabled();await page.locator('#editor').fill('Generation fixture');await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const id=await page.locator('#drafts').inputValue();await page.addScriptTag({content:await fixture()});
  const result=await page.evaluate(async({id,operation})=>{
    const api=(window as unknown as {EditableStoreFixture:{openEditableInputs:typeof openEditableInputs}&typeof DocumentStore}).EditableStoreFixture;
    const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('typebridge');r.onsuccess=()=>resolve(r.result);});
    const get=<T>(store:string,key:string)=>new Promise<T>(resolve=>{const q=db.transaction(store).objectStore(store).get(key);q.onsuccess=()=>resolve(q.result);});
    const row=await get<DocumentStore.StoredDraft>('documents',id), held=await get<{ownerInstanceId:string;fence:number}>('editOwnership',id);
    const fence={instanceId:held.ownerInstanceId,fence:held.fence};
    const input=(await api.openEditableInputs(db,id,()=>true,()=>true))!;
    if(operation==='flag-only-privacy-cycle') {
      const first=await api.updateDocumentPrivateFlag(db,id,true,row.revision,fence);if(!first.ok)throw new Error('Private flag failed');
      const second=await api.updateDocumentPrivateFlag(db,id,false,row.revision,fence);if(!second.ok)throw new Error('Public flag failed');
    } else {
      if(!await api.deleteStoredDraft(db,id,row.revision,fence))throw new Error('Delete failed');
      await api.commitOrCreateConflictCopy(db,{...row,private:false},0,crypto.randomUUID(),fence);
    }
    const after=await get<DocumentStore.StoredDraft>('documents',id);
    const outcome=await input.save(new Map([['x',9]]));input.close();
    const stored=await get<unknown>('readerStates','editable:'+id);db.close();
    return {outcome,empty:stored===undefined,epochChanged:after.inputEpoch!==row.inputEpoch,sourceUnchanged:after.text===row.text&&after.title===row.title&&JSON.stringify(after.history)===JSON.stringify(row.history),revisionUnchanged:after.revision===row.revision};
  },{id,operation});
  expect(result).toEqual({outcome:'cancelled',empty:true,epochChanged:true,sourceUnchanged:true,revisionUnchanged:true});
});
