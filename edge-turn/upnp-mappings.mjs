/* Only the explicitly configured local router; never knowingly overwrites another app's map. */
import {isIP} from 'node:net';
const xml=s=>String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const field=(body,name)=>new RegExp('<(?:[A-Za-z0-9_]+:)?'+name+'>([^<]*)</').exec(body)?.[1]??null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function routerClient({controlUrl,gatewayAddress,localAddress,description='Same End Edge'}={}){
 const url=new URL(controlUrl);if(url.protocol!=='http:'||url.hostname!==gatewayAddress||!isIP(gatewayAddress)||!isIP(localAddress)||url.username||url.password||url.hash||description!=='Same End Edge')throw Error('Invalid explicit local router configuration');
 const service='urn:schemas-upnp-org:service:WANIPConnection:1';let lastStart=0,callChain=Promise.resolve(),operationChain=Promise.resolve();
 async function responseText(r){
  if(!r.body)return '';const reader=r.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw Error('Router response exceeded bound');}chunks.push(value);}}
  finally{reader.releaseLock();}return new TextDecoder().decode(Buffer.concat(chunks));
 }
 function call(action,args){
  const task=callChain.catch(()=>{}).then(async()=>{
   const wait=100-(Date.now()-lastStart);if(wait>0)await sleep(wait);lastStart=Date.now();
   const body='<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:'+action+' xmlns:u="'+service+'">'+Object.entries(args).map(([k,v])=>'<'+k+'>'+xml(v)+'</'+k+'>').join('')+'</u:'+action+'></s:Body></s:Envelope>';
   const r=await fetch(url,{method:'POST',redirect:'error',headers:{connection:'close','content-type':'text/xml; charset="utf-8"',soapaction:'"'+service+'#'+action+'"'},body,signal:AbortSignal.timeout(3000)});const t=await responseText(r);const code=field(t,'errorCode');if(!r.ok||code){const e=Error('Router operation failed');e.code=Number(code)||r.status;throw e;}return t;
  });callChain=task;return task;
 }
 function exclusive(fn){const task=operationChain.catch(()=>{}).then(fn);operationChain=task;return task;}
 function checked(m){if(!m||!['UDP','TCP'].includes(m.protocol)||!Number.isInteger(m.external)||!Number.isInteger(m.internal)||m.external<1||m.external>65535||m.internal<1024||m.internal>65535)throw Error('Invalid relay port mapping');return m;}
 function lease(seconds){if(!Number.isInteger(seconds)||seconds<60||seconds>7200)throw Error('Invalid mapping lease');}
 const item=t=>({client:field(t,'NewInternalClient'),internal:Number(field(t,'NewInternalPort')),description:field(t,'NewPortMappingDescription'),enabled:field(t,'NewEnabled')==='1'});
 async function inventory(){
  const rows=[];
  for(let index=0;index<128;index++){
   let t;try{t=await call('GetGenericPortMappingEntry',{NewPortMappingIndex:index});}catch(e){if(e.code===713||e.code===601)return rows;throw e;}
   const external=Number(field(t,'NewExternalPort')),protocol=field(t,'NewProtocol'),v=item(t),remote=field(t,'NewRemoteHost')||'';
   if(!Number.isInteger(external)||external<1||external>65535||!['UDP','TCP'].includes(protocol)||!v.client||!Number.isInteger(v.internal)||v.internal<1||v.internal>65535)throw Error('Router returned an invalid mapping inventory');
   rows.push({...v,external,protocol,remote});
  }
  throw Error('Router mapping list exceeded bound');
 }
 async function get(m){checked(m);try{const t=await call('GetSpecificPortMappingEntry',{NewRemoteHost:'',NewExternalPort:m.external,NewProtocol:m.protocol});return item(t);}catch(e){if(e.code===714)return null;if(e.code===501){const rows=await inventory(),matches=rows.filter(x=>x.external===m.external&&x.protocol===m.protocol);if(matches.length>1)throw Error('Ambiguous router mapping');return matches[0]||null;}throw e;}}
 const owned=(v,m)=>v&&v.client===localAddress&&v.internal===m.internal&&v.description===description&&(!v.remote||v.remote==='');
 const add=(m,seconds)=>call('AddPortMapping',{NewRemoteHost:'',NewExternalPort:m.external,NewProtocol:m.protocol,NewInternalPort:m.internal,NewInternalClient:localAddress,NewEnabled:1,NewPortMappingDescription:description,NewLeaseDuration:seconds});
 function matching(rows,m){return rows.filter(v=>v.external===m.external&&v.protocol===m.protocol);}
 return{
  async ensureAll(mappings,seconds=3600){return exclusive(async()=>{
   if(!Array.isArray(mappings)||!mappings.length||mappings.length>64)throw Error('Invalid relay mapping set');lease(seconds);const ids=new Set();
   for(const m of mappings){checked(m);const k=m.protocol+':'+m.external;if(ids.has(k))throw Error('Duplicate relay port mapping');ids.add(k);}
   const before=await inventory();for(const m of mappings){const found=matching(before,m);if(found.length>1||found.some(v=>!owned(v,m)))throw Error('An existing port mapping belongs to another service');}
   // Renew only explicitly owned mappings, serially, at the requested bounded lease.
   for(const m of mappings)await add(m,seconds);
   const after=await inventory();for(const m of mappings){const found=matching(after,m);if(found.length!==1||!owned(found[0],m)||!found[0].enabled)throw Error('Relay mapping could not be verified');}
   return true;
  });},
  async ensure(m,seconds=3600){return exclusive(async()=>{checked(m);lease(seconds);const before=await get(m);if(before&&!owned(before,m))throw Error('An existing port mapping belongs to another service');await add(m,seconds);const after=await get(m);if(!owned(after,m)||!after.enabled)throw Error('Relay mapping could not be verified');return true;});},
  async remove(m){return exclusive(async()=>{const before=await get(m);if(!before)return false;if(!owned(before,m))throw Error('Refusing to remove another service mapping');await call('DeletePortMapping',{NewRemoteHost:'',NewExternalPort:m.external,NewProtocol:m.protocol});return true;});},get,async externalAddress(){return field(await call('GetExternalIPAddress',{}),'NewExternalIPAddress');}
 };
}
