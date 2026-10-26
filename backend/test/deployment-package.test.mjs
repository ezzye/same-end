// Build the real Lambda archive in an isolated directory and cold-import its
// extracted entry point. No AWS calls or existing deployment state are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),backend=fileURLToPath(new URL('../',import.meta.url));
test('prepared Lambda archive imports with all transitive runtime modules', {timeout:120000}, async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sameend-deploy-package-'));
 try{
  const state=path.join(dir,'state'),extracted=path.join(dir,'extracted');await mkdir(extracted);
  const prep=await exec(process.execPath,['deploy.mjs','--prepare-only'],{cwd:backend,env:{...process.env,SAME_END_DEPLOY_STATE_DIR:state,AWS_EC2_METADATA_DISABLED:'true'},timeout:90000,maxBuffer:1024*1024});
  assert.equal(JSON.parse(prep.stdout).stackStatus,'PREPARED');
  await exec('/usr/bin/unzip',['-q',path.join(state,'control.zip'),'-d',extracted]);
  const cold=await exec(process.execPath,['--input-type=module','-e',"const m=await import('./index.mjs');if(typeof m.handler!=='function')process.exit(1);console.log('cold-import-ok')"],{cwd:extracted,env:{...process.env,TABLE_NAME:'isolated-package-test',AWS_EC2_METADATA_DISABLED:'true'},timeout:20000});
  assert.match(cold.stdout,/cold-import-ok/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
