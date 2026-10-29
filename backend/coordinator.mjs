import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {Conflict} from './store.mjs';

const TTL = 15_000, MAX_NODES = 64, MAX_RECOMMENDATIONS = 5;
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x) && !['__proto__','constructor','prototype',...Object.getOwnPropertyNames(Object.prototype)].includes(x);
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
const keys = (x, allowed) => obj(x) && Object.keys(x).every(k => allowed.includes(k));
const number = (x, min, max) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const digest = x => createHash('sha256').update(x).digest('hex');
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
class CoordinatorError extends Error { constructor(status, code) { super('The room coordinator could not accept that request.'); this.status=status; this.code=code; } }
const invalid = () => { throw new CoordinatorError(400, 'invalid_coordinator'); };
const bool = x => typeof x === 'boolean';
function cleanReport(r) {
  const allowed=['role','leafOnly','clockReady','sourceReachable','trail','parentId','children','relayLimit','sourceAgeSeconds','reserveSeconds','requestedRenditions','cache','outgoingMbps','queueBytes','neededRange'];
  if (!keys(r,allowed) || !['source','viewer'].includes(r.role) || !bool(r.leafOnly) || !bool(r.clockReady) || !bool(r.sourceReachable) || !Array.isArray(r.trail) || r.trail.length > 16 || r.trail.some(x=>!id(x)) || new Set(r.trail).size!==r.trail.length || !(r.parentId===null || id(r.parentId)) || !Array.isArray(r.children) || r.children.length>8 || !Number.isInteger(r.relayLimit) || !number(r.relayLimit,0,8) || !(r.sourceAgeSeconds===null || number(r.sourceAgeSeconds,0,86400)) || !number(r.reserveSeconds,0,86400) || !Array.isArray(r.requestedRenditions) || r.requestedRenditions.length>3 || r.requestedRenditions.some(x=>!['audio','v360','v480'].includes(x)) || new Set(r.requestedRenditions).size!==r.requestedRenditions.length || !Array.isArray(r.cache) || r.cache.length>12 || !(r.outgoingMbps===null || number(r.outgoingMbps,0,10000)) || !number(r.queueBytes,0,100000000)) invalid();
  if (r.neededRange !== undefined && (!keys(r.neededRange,['start','end']) || !number(r.neededRange.start,0,1e12) || !number(r.neededRange.end,r.neededRange.start,1e12) || r.neededRange.end===r.neededRange.start)) invalid();
  for (const c of r.children) if (!keys(c,['nodeId','queuedBytes','deliveredMbps','health']) || !id(c.nodeId) || !number(c.queuedBytes,0,100000000) || !(c.deliveredMbps===null || number(c.deliveredMbps,0,10000)) || !['good','degraded','poor'].includes(c.health)) invalid();
  if (new Set(r.children.map(c=>c.nodeId)).size!==r.children.length) invalid();
  for (const c of r.cache) if (!keys(c,['rendition','start','end','firstSeq','lastSeq']) || !['audio','v360','v480'].includes(c.rendition) || !number(c.start,0,1e12) || !number(c.end,c.start,1e12) || !Number.isSafeInteger(c.firstSeq) || !Number.isSafeInteger(c.lastSeq) || c.firstSeq<0 || c.lastSeq<c.firstSeq) invalid();
  return structuredClone(r);
}
function rooted(nodes, nodeId) {
  const seen=new Set(); let n=nodes[nodeId];
  while(n) { if(seen.has(n.nodeId)) return false; seen.add(n.nodeId); const r=n.report; if(!r.clockReady || !r.sourceReachable) return false; if(r.role==='source') return r.parentId===null; if(!r.parentId) return false; n=nodes[r.parentId]; }
  return false;
}
function eligible(nodes, reservations, caller, candidate) {
  const r=candidate.report, cr=caller.report;
  if(candidate.nodeId===caller.nodeId || r.leafOnly || !r.relayLimit || !rooted(nodes,candidate.nodeId) || (r.outgoingMbps!==null && r.outgoingMbps<=0) || (r.sourceAgeSeconds!==null && r.sourceAgeSeconds>30) || r.queueBytes>2_000_000 || r.trail.includes(caller.nodeId)) return false;
  let n=candidate; const seen=new Set();
  while(n) { if(n.nodeId===caller.nodeId || seen.has(n.nodeId)) return false; seen.add(n.nodeId); n=n.report.parentId && nodes[n.report.parentId]; }
  if(!cr.requestedRenditions.every(want=>r.cache.some(c=>c.rendition===want && c.end>c.start && (!cr.neededRange || c.start<=cr.neededRange.start && c.end>=cr.neededRange.end)))) return false;
  const active=new Set(Object.values(nodes).filter(x=>x.report.parentId===candidate.nodeId).map(x=>x.nodeId));
  for(const child of r.children) active.add(child.nodeId);
  for(const reservation of Object.values(reservations)) if(reservation.supplierId===candidate.nodeId) active.add(reservation.nodeId);
  active.delete(caller.nodeId);
  // Source slots are an operator-declared bounded budget, not measured uplink headroom.
  return active.size<(r.role!=='source' ? Math.min(1,r.relayLimit) : r.relayLimit);
}
function recommendations(nodes,reservations,caller) {
  return Object.values(nodes).filter(n=>eligible(nodes,reservations,caller,n)).map(n=>({nodeId:n.nodeId, score:Math.max(0,Math.round(100-Math.min(n.report.sourceAgeSeconds ?? 20,30)-Math.min(n.report.queueBytes/100000,20)+(n.report.role==='source'?10:0))), reason:n.report.outgoingMbps===null?(n.report.role==='source'?'declared source slot; capacity unmeasured':'provisional: outgoing capacity unknown'):'rooted peer: reported slot available'})).sort((a,b)=>b.score-a.score || a.nodeId.localeCompare(b.nodeId)).slice(0,MAX_RECOMMENDATIONS);
}
export function createCoordinator({store, now=Date.now}={}) {
  return async function coordinate(clubId, body) {
    if (!keys(body,['action','cast','nodeId','seq','report','supplierId','leaseToken']) || !['report','reserve','release'].includes(body.action) || !id(body.cast) || !id(body.nodeId) || !Number.isSafeInteger(body.seq) || body.seq<1 || (body.leaseToken!==undefined && (typeof body.leaseToken!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(body.leaseToken)))) invalid();
    if(body.action==='report' ? (body.supplierId!==undefined || !body.report) : (body.report!==undefined || (body.action==='reserve' && !id(body.supplierId)) || (body.action==='release' && body.supplierId!==undefined))) invalid();
    const report=body.action==='report' ? cleanReport(body.report) : null;
    if(report && (report.parentId===body.nodeId || report.trail.includes(body.nodeId) || report.children.some(c=>c.nodeId===body.nodeId))) invalid();
    const pk=`CLUB#${clubId}`, sk=`COORD#${body.cast}`;
    for(let attempt=0;attempt<12;attempt++) {
      const time=now(), previous=await store.get(pk,sk);
      const nodes=Object.fromEntries(Object.entries(previous?.nodes||{}).filter(([,n])=>n.expiresAt>time));
      const reservations=Object.fromEntries(Object.entries(previous?.reservations||{}).filter(([,r])=>r.expiresAt>time && nodes[r.nodeId] && nodes[r.supplierId]));
      let caller=nodes[body.nodeId], token=body.leaseToken;
      if(caller) {
        if(!token || !same(caller.tokenHash,digest(token)) || body.seq<=caller.seq) throw new CoordinatorError(409,'coordinator_lease');
      } else {
        if(body.action!=='report' || token || Object.keys(nodes).length>=MAX_NODES) throw new CoordinatorError(409,'coordinator_lease');
        token=randomBytes(32).toString('base64url');
      }
      if(body.action==='report') caller=nodes[body.nodeId]={nodeId:body.nodeId,tokenHash:digest(token),seq:body.seq,report,expiresAt:time+TTL};
      else { caller.seq=body.seq; }
      if(body.action==='reserve') {
        const supplier=nodes[body.supplierId];
        if(!supplier || !eligible(nodes,reservations,caller,supplier)) throw new CoordinatorError(409,'coordinator_capacity');
        reservations[body.nodeId]={nodeId:body.nodeId,supplierId:body.supplierId,expiresAt:Math.min(time+TTL,caller.expiresAt,supplier.expiresAt)};
      }
      if(body.action==='release') delete reservations[body.nodeId];
      // Once a reported parent is active, its reservation is no longer pending.
      if(body.action==='report' && reservations[body.nodeId]?.supplierId===report.parentId) delete reservations[body.nodeId];
      const item={pk,sk,rev:randomUUID(),nodes,reservations,expiresAt:Math.ceil((time+TTL)/1000)};
      try { await store.put(item,previous?{attribute:'rev',equals:previous.rev}:{absent:true}); return {leaseToken:token,expiresAt:caller.expiresAt,recommendations:recommendations(nodes,reservations,caller),...(reservations[body.nodeId]?{reservation:{supplierId:reservations[body.nodeId].supplierId,expiresAt:reservations[body.nodeId].expiresAt}}:{})}; }
      catch(e) { if(!(e instanceof Conflict)) throw e; }
    }
    throw new CoordinatorError(503,'coordinator_busy');
  };
}
