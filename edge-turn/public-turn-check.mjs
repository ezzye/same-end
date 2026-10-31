/* Authenticated, bounded public-TURNS path proof. Never prints network identity or secrets. */
import {connect} from 'node:tls';
import {X509Certificate,createHmac,createHash,randomBytes} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {isIP} from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {attr,packet,decode} from './local-turn-check.mjs';
const COOKIE=0x2112a442, MAX_FRAME=65556;
function problem(stage){const error=Error('public-turn-'+stage);error.stage=stage;return error;}
export async function readPrivateSecret(file){
 if(typeof file!=='string'||!path.isAbsolute(file))throw problem('secret');const meta=await lstat(file);
 if(!meta.isFile()||meta.isSymbolicLink()||(meta.mode&0o077)!==0||(typeof process.getuid==='function'&&meta.uid!==process.getuid())||meta.size>1024)throw problem('secret');
 const text=(await readFile(file,'utf8')).trim();if(text.length<16||text.length>512||/[\x00-\x1f]/.test(text))throw problem('secret');return text;
}
function peerAddress(address,port){const ip=address.split('.').map(Number),b=Buffer.alloc(8);b[1]=1;b.writeUInt16BE(port^(COOKIE>>>16),2);for(let i=0;i<4;i++)b[4+i]=ip[i]^((COOKIE>>>(24-i*8))&255);return b;}
function unpeer(b){if(!b||b.length!==8||b[0]!==0||b[1]!==1)return null;const port=b.readUInt16BE(2)^(COOKIE>>>16),ip=Array.from(b.subarray(4),(x,i)=>x^((COOKIE>>>(24-i*8))&255)).join('.');return {ip,port};}
export function createPublicTurnConnection({host,port,fingerprint,signal,dial=connect}){
 const socket=dial({host,port,rejectUnauthorized:true,checkServerIdentity:(_host,cert)=>{const leaf=new X509Certificate(cert.raw);if(!leaf.checkIP(host)||leaf.fingerprint256!==fingerprint.toUpperCase())return Error('peer identity mismatch');},signal});
 let buffer=Buffer.alloc(0),failure=null,changed=null,frames=[],pendingSession=null;
 const wake=()=>{if(changed){changed();changed=null;}};
 socket.on('error',()=>{failure=problem('transport');wake();});socket.on('close',()=>{failure??=problem('transport');wake();});
 socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>MAX_FRAME*4){failure=problem('frame');socket.destroy();wake();return;}while(buffer.length>=20){const len=buffer.readUInt16BE(2)+20;if(len>MAX_FRAME){failure=problem('frame');socket.destroy();break;}if(buffer.length<len)break;frames.push(buffer.subarray(0,len));buffer=buffer.subarray(len);if(frames.length>64){failure=problem('frame');socket.destroy();break;}}wake();});
 const aborted=new Promise((_,reject)=>{if(signal.aborted)return reject(problem('timeout'));signal.addEventListener('abort',()=>reject(problem('timeout')),{once:true});});aborted.catch(()=>{});
 async function open(){await Promise.race([new Promise((resolve,reject)=>{socket.once('secureConnect',resolve);socket.once('error',()=>reject(problem('tls')));}),aborted]);}
 async function next(match){for(;;){if(failure)throw failure;const ix=frames.findIndex(match);if(ix>=0)return frames.splice(ix,1)[0];await Promise.race([new Promise(resolve=>{changed=resolve;}),aborted]);}}
 async function exchange(type,attrs,key,expected){const tx=randomBytes(12);socket.write(packet(type,tx,attrs,key));const frame=await next(b=>b.subarray(8,20).equals(tx));const response=decode(frame,tx,key);if(!response||response.type!==expected)throw problem('protocol');return response;}
 return {socket,open,exchange,async allocate(secret){
  const challenge=await exchange(3,[attr(0x19,Buffer.from([17,0,0,0]))],null,0x0113),code=challenge.attrs.get(9),realm=challenge.attrs.get(0x14),nonce=challenge.attrs.get(0x15);
  if(!code||code.length<4||code[2]!==4||code[3]!==1||!realm?.length||realm.length>256||!nonce?.length||nonce.length>512)throw problem('challenge');
  const username=Buffer.from(`${Math.floor(Date.now()/1000)+60}:${randomBytes(16).toString('base64url')}`),password=createHmac('sha1',secret).update(username).digest('base64'),key=createHash('md5').update(Buffer.concat([username,Buffer.from(':'),realm,Buffer.from(':'+password)])).digest();
  const auth=[attr(6,username),attr(0x14,realm),attr(0x15,nonce)],lifetime=Buffer.alloc(4);lifetime.writeUInt32BE(60);pendingSession={relay:null,key,auth};
  const result=await exchange(3,[attr(0x19,Buffer.from([17,0,0,0])),attr(0x0d,lifetime),...auth],key,0x0103),relay=unpeer(result.attrs.get(0x16));
  pendingSession.relay=relay;return pendingSession;
 },async permission(peer,session){await exchange(8,[attr(0x12,peerAddress(peer.ip,peer.port)),...session.auth],session.key,0x0108);},
 send(peer,bytes){socket.write(packet(0x0016,randomBytes(12),[attr(0x12,peerAddress(peer.ip,peer.port)),attr(0x13,bytes)],null));},
 // A permitted address can send unrelated traffic after a relay port is reused.
 // Ignore bounded noise, but accept only the exact peer and nonce before the deadline.
 async receive(peer,nonce){for(let n=0;n<64;n++){const frame=await next(b=>b.readUInt16BE(0)===0x0017);const result=decode(frame,frame.subarray(8,20),null),address=unpeer(result?.attrs.get(0x12)),data=result?.attrs.get(0x13);if(address&&address.ip===peer.ip&&address.port===peer.port&&data?.equals(nonce))return;}throw problem('data');},
 get pendingSession(){return pendingSession;},async closeAllocation(session){const lifetime=Buffer.alloc(4),response=await exchange(4,[attr(0x0d,lifetime),...session.auth],session.key,0x0104),confirmed=response.attrs.get(0x0d);if(!confirmed||confirmed.length!==4||confirmed.readUInt32BE(0)!==0)throw problem('cleanup');},close(){socket.destroy();}};
}
export async function checkPublicTurn({host,port=443,fingerprint,relayMin,relayMax,secret,timeoutMs=20000,makeConnection=createPublicTurnConnection}={}){
 if(isIP(host)!==4||!Number.isInteger(port)||port<1||port>65535||typeof fingerprint!=='string'||!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(fingerprint)||!Number.isInteger(relayMin)||!Number.isInteger(relayMax)||relayMin<1024||relayMax>65535||relayMin>relayMax||relayMax-relayMin>127||typeof secret!=='string'||secret.length<16||secret.length>512||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)throw problem('configuration');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),clients=[],sessions=[];let failed=null,cleanupFailed=false;
 try{
  for(let i=0;i<2;i++){const c=makeConnection({host,port,fingerprint,signal:controller.signal});clients.push(c);await c.open();const session=await c.allocate(secret);sessions.push(session);if(!session.relay||session.relay.ip!==host||session.relay.port<relayMin||session.relay.port>relayMax)throw problem('relay');}
  if(sessions[0].relay.port===sessions[1].relay.port)throw problem('relay');
  await clients[0].permission(sessions[1].relay,sessions[0]);await clients[1].permission(sessions[0].relay,sessions[1]);
  const first=randomBytes(32),second=randomBytes(32);clients[0].send(sessions[1].relay,first);await clients[1].receive(sessions[0].relay,first);clients[1].send(sessions[0].relay,second);await clients[0].receive(sessions[1].relay,second);
 }catch(e){failed=e?.stage?e:problem('transport');}
 finally{
  for(let i=clients.length-1;i>=0;i--)if(clients[i].pendingSession)try{await clients[i].closeAllocation(clients[i].pendingSession);}catch{cleanupFailed=true;}
  for(const c of clients)c.close();clearTimeout(timer);
 }
 if(cleanupFailed)throw problem('cleanup');if(failed)throw failed;return {ok:true,stage:'complete',allocations:2,directions:2,coverage:'two-allocated-relay-ports'};
}
async function main(){if(process.argv.length!==4||process.argv[2]!=='--config')throw problem('configuration');const file=process.argv[3],meta=await lstat(file);if(!meta.isFile()||(meta.mode&0o077)!==0||(typeof process.getuid==='function'&&meta.uid!==process.getuid()))throw problem('configuration');const c=JSON.parse(await readFile(file,'utf8')),secret=await readPrivateSecret(c.secretPath),result=await checkPublicTurn({...c,secret});console.log(JSON.stringify(result));}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)main().catch(e=>{console.error(JSON.stringify({ok:false,stage:['configuration','secret','tls','transport','frame','timeout','protocol','challenge','relay','data','cleanup'].includes(e.stage)?e.stage:'unknown'}));process.exitCode=1;});
