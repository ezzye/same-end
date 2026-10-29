import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkLocalTurn} from './local-turn-check.mjs';
const binary='/Users/errolelliott/Library/Application Support/Same End Edge/runtime/bin/turnserver';
const exists=await access(binary).then(()=>true,()=>false);
async function port(){const s=createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
test('local authenticated TURN allocation and release initializes the live allocation gauge',{skip:!exists,timeout:20000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sameend-turn-check-')),config=path.join(dir,'turn.conf'),secret=randomBytes(32).toString('base64url'),turnPort=await port(),metricsPort=await port();
 const lines=['listening-ip=127.0.0.1','relay-ip=127.0.0.1',`listening-port=${turnPort}`,'min-port=55000','max-port=55010','realm=localhost','use-auth-secret',`static-auth-secret=${secret}`,'no-tls','no-dtls','no-cli','no-multicast-peers','prometheus','prometheus-address=127.0.0.1',`prometheus-port=${metricsPort}`,'no-stdout-log',`log-file=${dir}/turn.log`];await writeFile(config,lines.join('\n')+'\n',{mode:0o600});
 const process=spawn(binary,['-c',config],{stdio:'ignore'});let metrics;
 async function scrape(){const response=await fetch(`http://127.0.0.1:${metricsPort}/metrics`,{signal:AbortSignal.timeout(500)});if(!response.ok)throw Error('metrics unavailable');return response.text();}
 try{
  for(let i=0;i<40;i++){try{metrics=await scrape();break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.ok(metrics);assert.match(metrics,/# TYPE turn_total_allocations gauge/);
  const result=await checkLocalTurn({port:turnPort,secret});assert.deepEqual(result,{binding:true,allocation:true,deallocation:true});
  for(let i=0;i<60;i++){metrics=await scrape();if(/turn_total_allocations\{type="UDP"\} 0(?:\.0+)?(?:\s|$)/m.test(metrics))break;await new Promise(r=>setTimeout(r,100));}
  assert.match(metrics,/turn_total_allocations\{type="UDP"\} 0(?:\.0+)?(?:\s|$)/m);
 }finally{process.kill('SIGTERM');await new Promise(resolve=>{if(process.exitCode!==null)return resolve();process.once('exit',resolve);setTimeout(()=>{process.kill('SIGKILL');resolve();},2000).unref();});await rm(dir,{recursive:true,force:true});}
});
test('local preflight rejects missing credentials',async()=>{await assert.rejects(checkLocalTurn({port:3478,secret:''}));});
