import {realpathSync} from 'node:fs';
/* Explicitly configured Mac edge prerequisites. Never changes cloud state. */
import {readFile, writeFile, rename, chmod, stat, unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate, createPrivateKey, createPublicKey} from 'node:crypto';
import {connect} from 'node:tls';
import {isIP} from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {routerClient} from './upnp-mappings.mjs';
const runFile=promisify(execFile), TTL=600000, LEASE=3600, RENEW_BEFORE=48*3600000;
async function atomic(file,data,mode=0o600){const tmp=`${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;try{await writeFile(tmp,data,{mode,flag:'wx'});await chmod(tmp,mode);await rename(tmp,file);}finally{await unlink(tmp).catch(()=>{});}}
function validate(c){
 if(!c||!c.router||isIP(c.expectedPublicIPv4)!==4||!Array.isArray(c.mappings)||!c.mappings.length||!['certPath','keyPath','acmePath','coturnPidFile','statusPath','legoPath'].every(k=>typeof c[k]==='string'&&path.isAbsolute(c[k])))throw Error('Invalid supervisor configuration');
 if(c.mappings.some(m=>m.external===80&&m.protocol==='TCP'))throw Error('Port 80 is reserved for renewal');
 if(!Number.isInteger(c.tlsPort)||c.tlsPort<1024||c.tlsPort>65535)throw Error('Invalid TLS port');
 if(!Number.isInteger(c.intervalMs)||c.intervalMs<30000||c.intervalMs>120000)throw Error('Invalid supervisor interval');
 routerClient(c.router);
}
async function readCertificate(certPath,keyPath,ip,now,allowExpired=false){
 const [cert,key]=await Promise.all([readFile(certPath),readFile(keyPath)]);const leaf=new X509Certificate(cert);
 const start=Date.parse(leaf.validFrom),end=Date.parse(leaf.validTo);
 if(!leaf.checkIP(ip)||!Number.isFinite(start)||!Number.isFinite(end)||now<start||(!allowExpired&&now>=end))throw Error('Certificate invalid for public IP or time');
 if(!createPublicKey(createPrivateKey(key)).export({type:'spki',format:'der'}).equals(leaf.publicKey.export({type:'spki',format:'der'})))throw Error('Certificate and key do not match');
 return {cert,key,end,fingerprint:leaf.fingerprint256};
}
async function verifyTls(c,expectedFingerprint){
 return new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port:c.tlsPort,rejectUnauthorized:true,checkServerIdentity:(_host,cert)=>{const leaf=new X509Certificate(cert.raw);if(!leaf.checkIP(c.expectedPublicIPv4))return Error('TLS IP mismatch');}});let settled=false;
 const done=(err)=>{if(settled)return;settled=true;socket.destroy();err?reject(err):resolve();};socket.setTimeout(3000,()=>done(Error('TLS timeout')));socket.on('error',done);socket.on('secureConnect',()=>{try{const leaf=new X509Certificate(socket.getPeerCertificate(true).raw);if(leaf.fingerprint256!==expectedFingerprint)throw Error('TLS leaf differs from configured certificate');done();}catch(e){done(e);}});});
}
export const supervisorTiming = {statusTtlMs: TTL, mappingLeaseSeconds: LEASE};
export function legoArgs(c){return ['run','--path',c.acmePath,'--cert.name','same-end-edge','--domains',c.expectedPublicIPv4,'--profile','shortlived','--http','--http.address',':8080','--accept-tos','--account-id','same-end-edge','--no-random-sleep'];}
const defaults={router:routerClient,readCertificate,verifyTls,atomic,now:()=>Date.now(),issue:async c=>{await runFile(c.legoPath,legoArgs(c),{timeout:180000,maxBuffer:65536});},reload:async c=>{const value=(await readFile(c.coturnPidFile,'utf8')).trim();if(!/^[1-9]\d*$/.test(value))throw Error('Invalid coturn PID');process.kill(Number(value),'SIGUSR2');}};
export async function supervisorCycle(c, overrides={}){
 const a={...defaults,...overrides}, now=a.now();let reasons=[];
 const status=async ok=>a.atomic(c.statusPath,JSON.stringify({ok,checkedAtMs:now,expiresAtMs:now+TTL,reasons})+'\n');
 // Invalidate any previous success while a potentially slow renewal is running.
 reasons=['check-in-progress'];await status(false);reasons=[];
 try{
  validate(c);const router=a.router(c.router);
  if(await router.externalAddress()!==c.expectedPublicIPv4)throw Error('public-ip-mismatch-or-unknown');
  for(const mapping of c.mappings)await router.ensure(mapping,LEASE);
  const pendingPath=c.statusPath+'.renewal-pending';
  let pending=false, challengeRemoved=false;
  try { await readFile(pendingPath); pending=true; } catch(e) { if(e.code!=='ENOENT') throw e; }
  let leaf;
  if(!pending) {
   leaf=await a.readCertificate(c.certPath,c.keyPath,c.expectedPublicIPv4,now,true);
   if(leaf.end-now<=RENEW_BEFORE){
    const challenge={protocol:'TCP',external:80,internal:8080};let mapped=false;
    try{
     await router.ensure(challenge,LEASE);mapped=true;await a.issue(c);
     // Validate before recording intent. The marker survives crashes during either replacement.
     const fresh=await a.readCertificate(path.join(c.acmePath,'certificates','same-end-edge.crt'),path.join(c.acmePath,'certificates','same-end-edge.key'),c.expectedPublicIPv4,a.now());
     if(fresh.end-a.now()<=RENEW_BEFORE)throw Error('Renewed certificate expires too soon');
     await a.atomic(pendingPath,'pending\n');pending=true;
    }finally{if(mapped){await router.remove(challenge);challengeRemoved=true;}}
   }
  }
  if(pending){
   // Reconcile from the validated ACME pair on every retry, even if only one file was replaced.
   const acmeCert=path.join(c.acmePath,'certificates','same-end-edge.crt'), acmeKey=path.join(c.acmePath,'certificates','same-end-edge.key');
   let fresh=await a.readCertificate(acmeCert,acmeKey,c.expectedPublicIPv4,a.now(),true);
   if(fresh.end-a.now()<=RENEW_BEFORE){
    const challenge={protocol:'TCP',external:80,internal:8080};let mapped=false;
    try{await router.ensure(challenge,LEASE);mapped=true;await a.issue(c);}
    finally{if(mapped){await router.remove(challenge);challengeRemoved=true;}}
    fresh=await a.readCertificate(acmeCert,acmeKey,c.expectedPublicIPv4,a.now());
    if(fresh.end-a.now()<=RENEW_BEFORE)throw Error('Renewed certificate expires too soon');
   }
   await a.atomic(c.keyPath,fresh.key);await a.atomic(c.certPath,fresh.cert);await a.reload(c);
   await a.verifyTls(c,fresh.fingerprint);
   // Also clean up a challenge mapping left by an interrupted prior cycle.
   if(!challengeRemoved)await router.remove({protocol:'TCP',external:80,internal:8080});
   await unlink(pendingPath);leaf=fresh;
  }else await a.verifyTls(c,leaf.fingerprint);
 }catch(e){reasons=[String(e?.message||'supervisor-check-failed').slice(0,160)];}
 await status(reasons.length===0);return {ok:reasons.length===0,checkedAtMs:now,expiresAtMs:now+TTL,reasons};
}
async function main(){if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('Explicit --config required');const file=process.argv[3],meta=await stat(file);if(!meta.isFile()||(meta.mode&0o077))throw Error('Supervisor config must be private');const c=JSON.parse(await readFile(file,'utf8'));validate(c);const tick=async()=>{try{await supervisorCycle(c);}catch{console.error('Supervisor status write failed');}setTimeout(tick,c.intervalMs);};await tick();}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
