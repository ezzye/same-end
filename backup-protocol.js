/* Pure protocol foundation. Independent captures are NOT interchangeable chunks.
 * Nothing in this module switches a live decoder or authorises a network source.
 */
const verifiedManifests=new WeakSet();
const enc=new TextEncoder();
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const text=s=>typeof s==='string'&&s.length>0&&s.length<=160;
const order=(a,b)=>a<b?-1:a>b?1:0;
const epoch=n=>Number.isSafeInteger(n)&&n>=0;
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const key=k=>{assert(k?.kty==='EC'&&k.crv==='P-256'&&text(k.x)&&text(k.y),'Invalid source key.');return {kty:k.kty,crv:k.crv,x:k.x,y:k.y};};
const identity=s=>JSON.stringify([s.sourceId,s.sourceEpoch]);
const copy=x=>JSON.parse(JSON.stringify(x));
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const from64=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));

export function canonicalSegment(m){
  assert(m?.v===undefined||m.v===1||m.v===2,'Unsupported media version.');
  return JSON.stringify(m.v===2?[2,m.cast,m.sourceId,m.sourceEpoch,m.programId,m.programStartTime,m.alignmentVersion,m.seq,m.start,m.duration,m.size,m.mime,m.hash]:[m.cast,m.seq,m.start,m.duration,m.size,m.mime,m.hash]);
}
export function segmentIdentity(m,legacyEpoch=0){
  assert(text(m?.cast)&&epoch(m.seq),'Invalid segment identity.');
  if(m.v===2)assert(text(m.sourceId)&&epoch(m.sourceEpoch),'Invalid source epoch.');
  return JSON.stringify([m.cast,m.v===2?m.sourceId:'legacy:'+m.cast,m.v===2?m.sourceEpoch:legacyEpoch,m.seq]);
}

export function validateManifest(input){
  const m=copy(input);
  assert(m?.version===1&&text(m.cast)&&text(m.programId)&&text(m.feedId)&&epoch(m.revision),'Invalid manifest identity.');
  assert(finite(m.issuedAt)&&finite(m.expiresAt)&&m.expiresAt>m.issuedAt,'Invalid manifest validity.');
  assert(Array.isArray(m.sources)&&m.sources.length>0&&m.sources.length<=4,'A manifest authorises one to four sources.');
  const ids=new Set();
  for(const s of m.sources){
    assert(text(s.sourceId)&&epoch(s.sourceEpoch)&&!ids.has(identity(s)),'Duplicate or invalid source epoch.');ids.add(identity(s));
    assert(s.programId===m.programId&&s.feedId===m.feedId,'Mismatched programme or feed.');
    assert(text(s.mime)&&finite(s.captureAnchorTime)&&finite(s.programAnchorTime)&&finite(s.validFrom)&&finite(s.validUntil)&&s.validUntil>s.validFrom,'Invalid source mapping.');
    s.publicKey=key(s.publicKey);
  }
  assert(Array.isArray(m.alignments)&&m.alignments.length<=8,'Invalid alignment records.');
  const alignmentIds=new Set();
  for(const a of m.alignments){
    assert(text(a.id)&&!alignmentIds.has(a.id),'Duplicate alignment ID.');alignmentIds.add(a.id);
    assert(a.version===1&&a.method==='verified-program-offset'&&a.programId===m.programId&&a.feedId===m.feedId,'Alignment must identify the exact programme feed.');
    assert(ids.has(identity({sourceId:a.fromSourceId,sourceEpoch:a.fromEpoch}))&&ids.has(identity({sourceId:a.toSourceId,sourceEpoch:a.toEpoch})),'Alignment source epoch is unauthorised.');
    assert(finite(a.offsetMs)&&finite(a.uncertaintyMs)&&a.uncertaintyMs>=0&&finite(a.validFrom)&&finite(a.validUntil)&&a.validUntil>a.validFrom&&text(a.evidenceId),'Alignment needs measured uncertainty, validity and evidence.');
  }
  return m;
}
export function canonicalManifest(input){
  const m=validateManifest(input);
  const sources=m.sources.map(s=>[s.sourceId,s.sourceEpoch,s.programId,s.feedId,s.mime,s.publicKey,s.captureAnchorTime,s.programAnchorTime,s.validFrom,s.validUntil]).sort((a,b)=>order(JSON.stringify(a),JSON.stringify(b)));
  const alignments=m.alignments.map(a=>[a.id,a.version,a.method,a.programId,a.feedId,a.fromSourceId,a.fromEpoch,a.toSourceId,a.toEpoch,a.offsetMs,a.uncertaintyMs,a.validFrom,a.validUntil,a.evidenceId]).sort((a,b)=>order(a[0],b[0]));
  return JSON.stringify(['source-manifest',1,m.cast,m.programId,m.feedId,m.revision,m.issuedAt,m.expiresAt,sources,alignments]);
}
export async function verifyManifest(input,authorityKey,{now=Date.now(),minimumRevision=0,crypto=globalThis.crypto}={}){
  const m=validateManifest(input);
  assert(finite(now)&&now>=m.issuedAt&&now<m.expiresAt&&m.revision>=minimumRevision,'Expired, future or rolled-back manifest.');
  const pub=await crypto.subtle.importKey('jwk',key(authorityKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  assert(typeof m.sig==='string'&&m.sig.length<=200&&await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,from64(m.sig),enc.encode(canonicalManifest(m))),'Manifest signature failed.');
  freeze(m);verifiedManifests.add(m);return m;
}
function source(m,id,e){const s=m.sources.find(s=>s.sourceId===id&&s.sourceEpoch===e);assert(s,'Source epoch is not authorised by this manifest.');return s;}
export function mapCaptureToProgram(s,captureTime,{programId,feedId}){
  assert(s?.programId===programId&&s.feedId===feedId&&finite(captureTime)&&finite(s.captureAnchorTime)&&finite(s.programAnchorTime),'Cannot map a mismatched or unknown feed.');
  return captureTime-s.captureAnchorTime+s.programAnchorTime;
}

export function planPromotion(manifest,{fromSourceId,fromEpoch,toSourceId,toEpoch,alignmentId,boundaryProgramTime,nowProgramTime,maxUncertaintyMs=40,minLeadMs=4000,now=Date.now()}){
  assert(verifiedManifests.has(manifest),'Verify the source manifest before planning promotion.');
  const m=manifest;
  assert(now>=m.issuedAt&&now<m.expiresAt,'The authorised source manifest has expired.');
  assert(finite(nowProgramTime)&&finite(boundaryProgramTime)&&finite(minLeadMs)&&minLeadMs>=1000&&boundaryProgramTime>=nowProgramTime+minLeadMs,'Promotion needs a future programme boundary with adequate lead time.');
  assert(finite(maxUncertaintyMs)&&maxUncertaintyMs>=0&&maxUncertaintyMs<=100,'Invalid alignment tolerance.');
  assert(fromSourceId!==toSourceId||fromEpoch!==toEpoch,'Promotion must change source epoch.');
  const from=source(m,fromSourceId,fromEpoch),to=source(m,toSourceId,toEpoch);
  assert(from.mime===to.mime,'Different codecs require a separate decoder transition.');
  const a=m.alignments.find(a=>a.id===alignmentId&&a.fromSourceId===fromSourceId&&a.fromEpoch===fromEpoch&&a.toSourceId===toSourceId&&a.toEpoch===toEpoch);
  assert(a&&a.uncertaintyMs<=maxUncertaintyMs,'A verified source-pair alignment within tolerance is required.');
  for(const validity of [from,to,a])assert(boundaryProgramTime>=validity.validFrom&&boundaryProgramTime<validity.validUntil,'The future boundary is outside source or alignment validity.');
  // For the same captured programme frame, target capture time = source capture
  // time + measured offset. Clock agreement alone cannot produce this evidence.
  const expectedOffset=(to.captureAnchorTime-to.programAnchorTime)-(from.captureAnchorTime-from.programAnchorTime);
  assert(Math.abs(expectedOffset-a.offsetMs)<=a.uncertaintyMs,'Measured offset disagrees with the authorised programme mapping.');
  return freeze({version:1,type:'scheduled-source-promotion',cast:m.cast,programId:m.programId,feedId:m.feedId,manifestRevision:m.revision,fromSourceId,fromEpoch,toSourceId,toEpoch,alignmentId,boundaryProgramTime,offsetMs:a.offsetMs,uncertaintyMs:a.uncertaintyMs,decoderTransition:'required-and-unverified'});
}
export function canonicalPromotion(p){
  return JSON.stringify(['scheduled-source-promotion',1,p.cast,p.programId,p.feedId,p.manifestRevision,p.fromSourceId,p.fromEpoch,p.toSourceId,p.toEpoch,p.alignmentId,p.boundaryProgramTime,p.offsetMs,p.uncertaintyMs]);
}
