import {realpathSync} from 'node:fs';
/* Explicitly configured Mac edge prerequisites. Never changes cloud state. */
import {readFile, writeFile, rename, chmod, stat, unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate, createPrivateKey, createPublicKey, createHash} from 'node:crypto';
import {connect} from 'node:tls';
import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {routerClient} from './upnp-mappings.mjs';
import {checkPublicTurn,readPrivateSecret} from './public-turn-check.mjs';
const runFile=promisify(execFile), TTL=600000, LEASE=3600, RENEW_BEFORE=48*3600000;
async function atomic(file,data,mode=0o600){const tmp=`${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;try{await writeFile(tmp,data,{mode,flag:'wx'});await chmod(tmp,mode);await rename(tmp,file);}finally{await unlink(tmp).catch(()=>{});}}
function validate(c){
 if(!c||!c.router||isIP(c.expectedPublicIPv4)!==4||!Array.isArray(c.mappings)||!c.mappings.length||!['certPath','keyPath','acmePath','coturnPidFile','statusPath','legoPath'].every(k=>typeof c[k]==='string'&&path.isAbsolute(c[k])))throw Error('Invalid supervisor configuration');
 if(c.forwardingMode!==undefined&&!['upnp','operator-static'].includes(c.forwardingMode))throw Error('Invalid forwarding mode');
 if(c.forwardingMode==='operator-static'&&(!path.isAbsolute(c.staticManifestPath||'')||!/^[a-f0-9]{64}$/.test(c.staticManifestSha256||'')))throw Error('Invalid static manifest configuration');
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
export function canonicalStaticManifest(m){
 if(!m||Object.keys(m).some(k=>!['version','localIPv4','publicIPv4','mappings','tlsExternalPort','relayMin','relayMax','secretPath'].includes(k))||m.version!==1||isIP(m.localIPv4)!==4||isIP(m.publicIPv4)!==4||!Array.isArray(m.mappings)||!m.mappings.length||m.mappings.length>64||!Number.isInteger(m.tlsExternalPort)||m.tlsExternalPort<1||m.tlsExternalPort>65535||!Number.isInteger(m.relayMin)||!Number.isInteger(m.relayMax)||m.relayMin<1024||m.relayMax>65535||m.relayMin>m.relayMax||m.relayMax-m.relayMin>63||!path.isAbsolute(m.secretPath||''))throw Error('static-manifest-invalid');
 const mappings=m.mappings.map(x=>{if(!x||Object.keys(x).some(k=>!['protocol','external','internal'].includes(k))||!['TCP','UDP'].includes(x.protocol)||!Number.isInteger(x.external)||x.external<1||x.external>65535||!Number.isInteger(x.internal)||x.internal<1024||x.internal>65535||x.protocol==='TCP'&&x.external===80)throw Error('static-manifest-invalid');return {protocol:x.protocol,external:x.external,internal:x.internal};}).sort((a,b)=>a.protocol.localeCompare(b.protocol)||a.external-b.external||a.internal-b.internal);
 if(new Set(mappings.map(x=>x.protocol+':'+x.external)).size!==mappings.length)throw Error('static-manifest-invalid');
 if(!mappings.some(x=>x.protocol==='TCP'&&x.external===m.tlsExternalPort))throw Error('static-manifest-invalid');for(let p=m.relayMin;p<=m.relayMax;p++)if(!mappings.some(x=>x.protocol==='UDP'&&x.external===p&&x.internal===p))throw Error('static-manifest-invalid');
 return JSON.stringify({version:1,localIPv4:m.localIPv4,publicIPv4:m.publicIPv4,mappings,tlsExternalPort:m.tlsExternalPort,relayMin:m.relayMin,relayMax:m.relayMax,secretPath:m.secretPath});
}
async function readStaticManifest(c){
 const meta=await (await import('node:fs/promises')).lstat(c.staticManifestPath);if(!meta.isFile()||meta.isSymbolicLink()||(meta.mode&0o077)!==0||(typeof process.getuid==='function'&&meta.uid!==process.getuid())||meta.size>32768)throw Error('static-manifest-invalid');
 const manifest=JSON.parse(await readFile(c.staticManifestPath,'utf8')),canonical=canonicalStaticManifest(manifest),digest=createHash('sha256').update(canonical).digest('hex');
 if(digest!==c.staticManifestSha256||manifest.localIPv4!==c.router.localAddress||manifest.publicIPv4!==c.expectedPublicIPv4)throw Error('static-manifest-mismatch');
 const configMappings=canonicalStaticManifest({...manifest,mappings:c.mappings});if(configMappings!==canonical||!manifest.mappings.some(x=>x.protocol==='TCP'&&x.external===manifest.tlsExternalPort&&x.internal===c.tlsPort))throw Error('static-manifest-mismatch');
 return manifest;
}
export const supervisorTiming = {statusTtlMs: TTL, mappingLeaseSeconds: LEASE};
export function legoArgs(c){return ['run','--path',c.acmePath,'--cert.name','same-end-edge','--domains',c.expectedPublicIPv4,'--profile','shortlived','--http','--http.address',':8080','--accept-tos','--account-id','same-end-edge','--no-random-sleep'];}
const defaults={interfaces:networkInterfaces,router:routerClient,readCertificate,verifyTls,readStaticManifest,readPrivateSecret,checkPublicTurn,atomic,now:()=>Date.now(),issue:async c=>{await runFile(c.legoPath,legoArgs(c),{timeout:180000,maxBuffer:65536});},reload:async c=>{const value=(await readFile(c.coturnPidFile,'utf8')).trim();if(!/^[1-9]\d*$/.test(value))throw Error('Invalid coturn PID');process.kill(Number(value),'SIGUSR2');}};
export async function supervisorCycle(c, overrides={}){
 const a={...defaults,...overrides}, now=a.now();let reasons=[],evidence=null,failureStage=null,probeStage=null,probeCauseStage=null,probeErrorCode=null,stage='configuration';
 const status=async ok=>a.atomic(c.statusPath,JSON.stringify({ok,checkedAtMs:now,expiresAtMs:now+TTL,reasons,...(evidence?{evidence}:{}),...(failureStage?{failureStage}:{}),...(probeStage?{probeStage}:{}),...(probeCauseStage?{probeCauseStage}:{}),...(probeErrorCode!==null?{probeErrorCode}:{})})+'\n');
 // Invalidate any previous success while a potentially slow renewal is running.
 reasons=['check-in-progress'];await status(false);reasons=[];
 try{
  validate(c);
  stage='local-address';const interfaces=a.interfaces();
  if (!interfaces || !Object.values(interfaces).some(entries => Array.isArray(entries) && entries.some(entry => entry.family === 'IPv4' && !entry.internal && entry.address === c.router.localAddress))) throw Error('local-ip-not-assigned');
  stage='public-address';const router=a.router(c.router);
  if(await router.externalAddress()!==c.expectedPublicIPv4)throw Error('public-ip-mismatch-or-unknown');
  if(c.forwardingMode==='operator-static'){
   stage='manifest';const manifest=await a.readStaticManifest(c);stage='renewal-marker';const pendingPath=c.statusPath+'.renewal-pending';try{await readFile(pendingPath);throw Error('static-renewal-pending');}catch(e){if(e.code!=='ENOENT')throw e;}
   stage='certificate';const leaf=await a.readCertificate(c.certPath,c.keyPath,c.expectedPublicIPv4,now,true);if(leaf.end-now<=RENEW_BEFORE)throw Error('static-renewal-required');stage='loopback-tls';await a.verifyTls(c,leaf.fingerprint);
   stage='turn-secret';const secret=await a.readPrivateSecret(manifest.secretPath);stage='public-turn-proof';const proof=await a.checkPublicTurn({host:c.expectedPublicIPv4,port:manifest.tlsExternalPort,fingerprint:leaf.fingerprint,relayMin:manifest.relayMin,relayMax:manifest.relayMax,secret});if(proof?.ok!==true||proof.allocations!==2||proof.directions!==2)throw Error('static-proof-failed');
   evidence={kind:'authenticated-turn',allocations:2,directions:2,coverage:'two-allocated-relay-ports',vantage:'public-endpoint-from-host',staticRules:'operator-asserted'};await status(true);return {ok:true,checkedAtMs:now,expiresAtMs:now+TTL,reasons};
  }
  if (typeof router.ensureAll === 'function') await router.ensureAll(c.mappings,LEASE);
  else for(const mapping of c.mappings)await router.ensure(mapping,LEASE);
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
 }catch(e){if(c.forwardingMode==='operator-static'){failureStage=stage;if(stage==='public-turn-proof'){const allowed=['configuration','secret','tls','transport','frame','timeout','protocol','challenge','relay','bandwidth','data','cleanup'];if(allowed.includes(e?.stage))probeStage=e.stage;if(allowed.includes(e?.causeStage))probeCauseStage=e.causeStage;if(Number.isInteger(e?.turnCode)&&e.turnCode>=300&&e.turnCode<=699)probeErrorCode=e.turnCode;}}reasons=[c.forwardingMode==='operator-static'?(['static-manifest-invalid','static-manifest-mismatch','static-renewal-pending','static-renewal-required','static-proof-failed','local-ip-not-assigned','public-ip-mismatch-or-unknown'].includes(e?.message)?e.message:'static-prerequisite-failed'):String(e?.message||'supervisor-check-failed').slice(0,160)];}
 await status(reasons.length===0);return {ok:reasons.length===0,checkedAtMs:now,expiresAtMs:now+TTL,reasons};
}
async function main(){if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('Explicit --config required');const file=process.argv[3],meta=await stat(file);if(!meta.isFile()||(meta.mode&0o077))throw Error('Supervisor config must be private');const c=JSON.parse(await readFile(file,'utf8'));validate(c);const tick=async()=>{try{await supervisorCycle(c);}catch{console.error('Supervisor status write failed');}setTimeout(tick,c.intervalMs);};await tick();}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
