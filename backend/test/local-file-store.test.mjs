import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LocalFileStore} from '../local-file-store.mjs';
import {Conflict} from '../store.mjs';
test('local review data survives a clean restart and conditional writes stay atomic',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sameend-review-')),file=path.join(dir,'state.json');let store;
 try{store=await LocalFileStore.open(file);await store.put({pk:'A',sk:'N',version:1,text:'Saved feedback'},{absent:true});
  const result=await Promise.allSettled([store.put({pk:'A',sk:'N',version:2,text:'First update'},{attribute:'version',equals:1}),store.put({pk:'A',sk:'N',version:2,text:'Stale update'},{attribute:'version',equals:1})]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.ok(result.find(r=>r.status==='rejected').reason instanceof Conflict);
  await assert.rejects(()=>LocalFileStore.open(file),/running API/);await store.close();store=await LocalFileStore.open(file);assert.equal((await store.get('A','N')).text,'First update');assert.equal((await stat(file)).mode&0o777,0o600);
 }finally{await store?.close();await rm(dir,{recursive:true,force:true});}
});
