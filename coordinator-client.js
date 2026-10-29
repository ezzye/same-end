/* Short-lived metadata hints; direct authenticated peer links remain authoritative. */
(() => {
  'use strict';
  function create({cast,nodeId,request,now=Date.now}) {
    let seq=0, token=null, expiresAt=0, blockedUntil=0, chain=Promise.resolve(), latest=null, stopped=false;
    function send(action,fields={}) {
      const operation=chain.catch(()=>{}).then(async()=>{
        if(stopped)return null;
        const time=now(); if(token && time>=expiresAt){token=null;expiresAt=0;seq=0;}
        if(!token && (action!=='report'||time<blockedUntil))return null;
        const payload={action,cast,nodeId,seq:++seq,...fields,...(token?{leaseToken:token}:{})};
        try {
          const result=await request(payload);
          if(!result || typeof result.leaseToken!=='string' || !Number.isFinite(result.expiresAt)) {
            if(!token)blockedUntil=now()+16000;
            return null;
          }
          token=result.leaseToken;expiresAt=result.expiresAt;
          latest={...result,receivedAt:now()};return latest;
        } catch { if(!token)blockedUntil=now()+16000;return null; }
      }); chain=operation;return operation;
    }
    return {report:report=>send('report',{report}),reserve:supplierId=>send('reserve',{supplierId}),release:()=>send('release'),latest:()=>latest&&latest.expiresAt>now()?latest:null,close:()=>{stopped=true;token=null;latest=null;}};
  }
  window.SameEndCoordinator={create};
})();
