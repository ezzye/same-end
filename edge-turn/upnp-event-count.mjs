import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {isIP} from 'node:net';

const MAX_BODY = 16384;
const NOTIFY_TIMEOUT_MS = 2500;
const REQUEST_TIMEOUT_MS = 2500;
const escapeRE=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

function normalizeAddress(value) {
 return String(value||'').replace(/^::ffff:/i,'').replace(/^\[|\]$/g,'');
}

function parseCount(body) {
 let xml=body.trim();if(/^<\?xml\b/i.test(xml)){const end=xml.indexOf('?>');if(end<0)throw Error('Malformed router GENA XML declaration');xml=xml.slice(end+2).trimStart();}
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('Router GENA event declarations are not allowed');
 const root=/^<((?:[A-Za-z_][A-Za-z0-9_.-]*:)?)propertyset\b([^>]*)>([\s\S]*)<\/\1propertyset\s*>$/i.exec(xml);
 if(!root)throw Error('Router GENA event is not a complete property set');
 const prefix=root[1].slice(0,-1),declarations=[...root[2].matchAll(/\bxmlns(?::([A-Za-z_][A-Za-z0-9_.-]*))?\s*=\s*["']([^"']*)["']/g)],namespace=declarations.find(value=>(value[1]||'')===prefix)?.[2];
 if(namespace!=='urn:schemas-upnp-org:event-1-0')throw Error('Router GENA event has an unexpected namespace');
 if(declarations.some(value=>!value[1]&&value[2]))throw Error('Router GENA event default namespace prevents an unqualified state variable');
 const propertyTag=escapeRE(root[1]+'property'),propertyRx=new RegExp('<'+propertyTag+'>([\\s\\S]*?)<\\/'+propertyTag+'\\s*>','g'),properties=[...root[3].matchAll(propertyRx)];
 if(root[3].replace(propertyRx,'').trim())throw Error('Router GENA property set contains unexpected content');
 const countRx=/^<PortMappingNumberOfEntries>([0-9]{1,5})<\/PortMappingNumberOfEntries>$/;
 const values=properties.map(property=>property[1].trim()).filter(value=>value.includes('PortMappingNumberOfEntries'));
 if(values.length!==1)throw Error('Router GENA event has no unambiguous mapping count property');
 const match=countRx.exec(values[0]);if(!match)throw Error('Router GENA mapping count must be a direct, sole state-variable child');
 const count=Number(match[1]);if(!Number.isInteger(count)||count>65535)throw Error('Router GENA mapping count is out of range');return count;
}

function readRequest(req,limit=MAX_BODY){
 return new Promise((resolve,reject)=>{
  const chunks=[];let size=0,done=false;
  const fail=e=>{if(done)return;done=true;reject(e);};
  const timer=setTimeout(()=>{req.destroy();fail(Error('Router GENA notification timed out'));},REQUEST_TIMEOUT_MS);timer.unref?.();
  req.on('data',chunk=>{size+=chunk.length;if(size>limit){req.destroy();fail(Error('Router GENA notification exceeded bound'));return;}chunks.push(chunk);});
  req.on('end',()=>{if(done)return;done=true;clearTimeout(timer);resolve(Buffer.concat(chunks).toString('utf8'));});
  req.on('error',e=>{clearTimeout(timer);fail(e);});
 });
}

function request(url,method,headers,localAddress){
 return new Promise((resolve,reject)=>{
  const req=http.request({protocol:'http:',hostname:url.hostname,port:url.port||80,path:url.pathname,method,headers:{connection:'close',...headers},localAddress,agent:false,signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)},res=>{
   const chunks=[];let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>MAX_BODY){res.destroy(Error('Router GENA response exceeded bound'));return;}chunks.push(chunk);});
   res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));
   res.on('error',reject);
  });
  req.on('error',reject);req.end();
 });
}

function validateEventUrl(value,gatewayAddress){
 const u=new URL(value);
 if(u.protocol!=='http:'||u.hostname!==gatewayAddress||u.username||u.password||u.search||u.hash||u.pathname==='')throw Error('Invalid explicit UPnP event URL');
 return u;
}

/** Read the initial evented PortMappingNumberOfEntries value via a short-lived local GENA subscription. */
export async function readInitialMappingCount({eventSubUrl,gatewayAddress,localAddress}={}){
 if(!isIP(gatewayAddress)||!isIP(localAddress))throw Error('Invalid UPnP GENA local address configuration');
 const eventUrl=validateEventUrl(eventSubUrl,gatewayAddress);
 const nonce=randomBytes(24).toString('hex');
 let expectedSid=null,received=null,initialInProgress=false,notifyError=null,settle;
 const initial=new Promise((resolve,reject)=>{settle={resolve,reject};});
 // Keep a handler attached during the callback-before-SUBSCRIBE-ACK race.
 initial.catch(()=>{});
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.method!=='NOTIFY'||req.url!=='/'+nonce||normalizeAddress(req.socket.remoteAddress)!==normalizeAddress(gatewayAddress))throw Error('Unexpected UPnP GENA notification source or route');
   if(received||initialInProgress)throw Error('Additional UPnP GENA notification followed the initial event');
   const headers=req.headers;
   if(String(headers.nt||'').toLowerCase()!=='upnp:event'||String(headers.nts||'').toLowerCase()!=='upnp:propchange'||String(headers.seq)!=='0'||typeof headers.sid!=='string'||!/^uuid:[A-Za-z0-9._:-]{1,180}$/.test(headers.sid))throw Error('Invalid initial UPnP GENA notification headers');
   if(typeof headers['content-type']!=='string'||!/^text\/xml(?:\s*;|$)/i.test(headers['content-type']))throw Error('Invalid UPnP GENA notification content type');
   initialInProgress=true;
   const body=await readRequest(req);
   const count=parseCount(body),event={sid:headers.sid,count};
   if(expectedSid&&event.sid!==expectedSid)throw Error('UPnP GENA notification SID did not match the subscription');
   received=event;settle.resolve(event);res.writeHead(200,{connection:'close'}).end();
  }catch(e){notifyError=e;settle.reject(e);if(!res.headersSent)res.writeHead(412,{connection:'close'}).end();else res.destroy();}
 });
 server.requestTimeout=REQUEST_TIMEOUT_MS;server.headersTimeout=REQUEST_TIMEOUT_MS;server.maxHeadersCount=32;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,localAddress,resolve);});
 const address=server.address();if(!address||typeof address==='string')throw Error('UPnP GENA callback listener did not bind locally');
 const callbackHost=localAddress.includes(':')?'['+localAddress+']':localAddress;
 const callback='http://'+callbackHost+':'+address.port+'/'+nonce;
 let acknowledgedSid=null,primaryError=null,count=null;
 try{
  const ack=await request(eventUrl,'SUBSCRIBE',{callback:'<'+callback+'>',nt:'upnp:event',timeout:'Second-5'},localAddress);
  if(ack.status!==200)throw Error('Router did not acknowledge the UPnP GENA subscription');
  const responseSid=ack.headers.sid;
  if(typeof responseSid!=='string'||!/^uuid:[A-Za-z0-9._:-]{1,180}$/.test(responseSid))throw Error('Router returned an invalid UPnP GENA SID');
  acknowledgedSid=responseSid;
  expectedSid=acknowledgedSid;
  if(received&&received.sid!==acknowledgedSid)throw Error('UPnP GENA notification SID did not match the acknowledged subscription');
  if(notifyError)throw notifyError;
  const timeoutMatch=typeof ack.headers.timeout==='string'&&/^Second-([1-9][0-9]*)$/i.exec(ack.headers.timeout),timeoutSeconds=timeoutMatch?Number(timeoutMatch[1]):null;
  if(!Number.isSafeInteger(timeoutSeconds)||timeoutSeconds>60)throw Error('Router returned an invalid UPnP GENA subscription lifetime');
  const event=received||await Promise.race([initial,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Router did not send an initial UPnP GENA notification')),NOTIFY_TIMEOUT_MS);t.unref?.();})]);
  if(event.sid!==acknowledgedSid)throw Error('UPnP GENA notification SID did not match the acknowledged subscription');
  count=event.count;
 }catch(e){primaryError=e;}
 finally{
  let cleanupError=null;
  try{
   if(acknowledgedSid){const unsub=await request(eventUrl,'UNSUBSCRIBE',{sid:acknowledgedSid},localAddress);if(unsub.status!==200)throw Error('Router refused UPnP GENA unsubscribe cleanup');}
  }catch(e){cleanupError=e;}
  try{const closed=new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));server.closeAllConnections?.();await closed;}catch(e){cleanupError??=e;}
  if(cleanupError)throw Error('UPnP GENA cleanup failed: '+cleanupError.message,{cause:primaryError||cleanupError});
 }
 if(primaryError)throw primaryError;
 if(notifyError)throw Error('Router sent an invalid or additional UPnP GENA notification',{cause:notifyError});
 return count;
}
