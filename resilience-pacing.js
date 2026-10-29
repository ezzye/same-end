/* Target-rate pacing is a conservative sender budget, not a link-speed test. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.SameEndResiliencePacing=api;})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 const MAX_PIECE=4*1024*1024;
 class Pacer{
  constructor({rate,now=Date.now}={}){this.now=now;this.at=now();this.rate=Math.max(1,Number(rate)||1);this.tokens=this.capacity;}
  get capacity(){return Math.max(128*1024,this.rate*3);}
  update(rate){const t=this.now(),elapsed=Math.max(0,Math.min(2,(t-this.at)/1000));this.at=t;this.rate=Math.max(1,Number(rate)||1);this.tokens=Math.min(this.capacity,this.tokens+elapsed*this.rate*1.6);}
  take(bytes,priority=false){
   if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>MAX_PIECE)return false;
   // One valid variable-size video bundle may borrow against future credit at
   // a full bucket. Its entire debt is retained, so it cannot block forever or
   // turn each oversized bundle into a new unmetered burst.
   const oversized=bytes>this.capacity&&this.tokens>=this.capacity-1;
   if(!priority&&this.tokens<bytes&&!oversized)return false;
   if(priority&&this.tokens-bytes < -2*MAX_PIECE)return false;
   this.tokens-=bytes;return true;
  }
 }
 return {Pacer};
});
