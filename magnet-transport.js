import WebTorrent from './vendor/webtorrent.min.js';

/* Same End magnet discovery and authenticated control transport.
 * Requires the official WebTorrent browser bundle (window.WebTorrent).
 * Media remains on Same End's signedchunks/WebRTC application path.
 */
(() => {
  'use strict';
  const TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev'
  ];
  const STUN=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}];
  const JOIN_WAIT=90000, REANNOUNCE=15000;
  const EXT = 'ut_privatecast';
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const b64 = b => { let s=''; for (const x of b) s+=String.fromCharCode(x); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); };
  const un64 = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const id = () => b64(rand(12));
  const configOK = c => !!c && typeof c.id==='string' && c.id.length<100 && Number.isFinite(c.epoch) && [10,60,300].includes(c.delay) && ['application/vnd.apple.mpegurl','video/mp4;codecs=avc3.42001f,mp4a.40.2','video/mp4;codecs=avc3.42001f','video/mp4;codecs=avc1.42001f,mp4a.40.2','video/mp4;codecs=avc1.42001f','video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8,opus','video/webm;codecs=vp8'].includes(c.mime) && (c.mime!=='application/vnd.apple.mpegurl'||c.mediaProfile==='hls-cmaf-v1') && c.publicKey && c.publicKey.kty==='EC' && c.publicKey.crv==='P-256' && (c.segmentVersion===undefined||(c.segmentVersion===2&&typeof c.sourceId==='string'&&c.sourceId.length>0&&c.sourceId.length<=100&&Number.isSafeInteger(c.sourceEpoch)&&c.sourceEpoch>=0&&typeof c.programId==='string'&&c.programId.length>0&&c.programId.length<=100&&c.alignmentVersion===1));
  function MemoryStore(chunkLength,opts={}){if(!(this instanceof MemoryStore))return new MemoryStore(chunkLength,opts);this.chunkLength=Number(chunkLength);this.length=Number(opts.length)||0;if(!this.chunkLength||this.length>32832)throw Error('Cast descriptor storage exceeds 32 KB.');this.chunks=[];this.closed=false;this.lastChunkLength=(this.length%this.chunkLength)||this.chunkLength;this.lastChunkIndex=Math.ceil(this.length/this.chunkLength)-1;}
  MemoryStore.prototype.put=function(i,b,cb=()=>{}){if(this.closed)return queueMicrotask(()=>cb(Error('Store is closed.')));if(i<0||i>this.lastChunkIndex||b.length!==(i===this.lastChunkIndex?this.lastChunkLength:this.chunkLength))return queueMicrotask(()=>cb(Error('Invalid descriptor chunk.')));this.chunks[i]=b;queueMicrotask(()=>cb(null));};
  MemoryStore.prototype.get=function(i,o,cb=()=>{}){if(typeof o==='function')return this.get(i,null,o);if(this.closed)return queueMicrotask(()=>cb(Error('Store is closed.')));let b=this.chunks[i];if(!b){const e=Error('Chunk not found.');e.notFound=true;return queueMicrotask(()=>cb(e));}o=o||{};if(o.offset||o.length)b=b.slice(o.offset||0,(o.offset||0)+(o.length||b.length));queueMicrotask(()=>cb(null,b));};
  MemoryStore.prototype.close=MemoryStore.prototype.destroy=function(cb=()=>{}){if(this.closed)return queueMicrotask(()=>cb(null));this.closed=true;this.chunks=null;queueMicrotask(()=>cb(null));};

  class MagnetTransport {
    constructor({getStatus=()=>({}),onSession=()=>{},onPeer=()=>{},onError=()=>{},onRecovery=()=>{},onTopology=()=>{},onProgress=()=>{},trackers=TRACKERS}={}) {
      this.readStatus=getStatus; this.onSession=onSession; this.onPeer=onPeer; this.onError=onError; this.onRecovery=onRecovery; this.onTopology=onTopology; this.onProgress=onProgress;
      this.trackers=Array.from(new Set(trackers.map(x=>{const u=new URL(x);if(u.protocol!=='wss:')throw Error('Trackers must use secure WebSocket.');return u.href;}))).slice(0,2);
      this.client=null; this.torrent=null; this.key=null; this.role=null; this.node=String((getStatus()||{}).nodeId||id()); this.label='Friend';
      this.config=null; this.closed=false; this.wires=new Map(); this.links=new Map(); this.timer=null; this.trail=[]; this.parent=null; this.parentRequest=null; this.down=0; this.clockReady=false;
      this.bootstrapGeneration=0;this.bootstrapRetries=0;this.bootstrapTimer=null;this.cancelBootstrapWait=null;this.resumeBootstrapWait=null;this.resetTimer=null;this.resetPromise=null;this.discoveryGeneration=0;this.nextResetAt=0;this.resetFailures=0;this.lastDiscoveryReset=0;this.lastTrackerReply=0;this.lastStatusTick=0;this.watchedTorrents=new WeakSet();this.boundedTrackers=new WeakSet();
      this.joinGeneration=0;this.pendingJoin=null;this.network=null;this.lastReannounce=0;this.observedDiscovery=null;this.observedPeers=new WeakSet();
      this.sessionReady=false; this.recovery=null; this.recoveries=0; this.everParent=false; this.failedSuppliers=new Map(); this.failures=0; this.lastReject=null;
    }
    _rooted(remote){ return remote?.role==='source'||(remote?.rooted===true&&remote?.hasParent===true); }
    getStatus(){
      const s=this.readStatus()||{};
      const trail=this.role==='source'?[]:this.trail;
      const rooted=this.role==='source'||!!(this.parent&&this._rooted(this.parent.remote));
      const relayLimit=Number.isInteger(s.relayLimit)?Math.min(2,Math.max(0,s.relayLimit)):2;
      return {nodeId:String(s.nodeId||this.node),label:String(s.label||this.label).slice(0,40),role:this.role,clockReady:!!s.clockReady,trail:trail.slice(0,12),downCount:Math.max(this.down,Number(s.downCount)||0),relayLimit,hasParent:!!this.parent,rooted};
    }
    _topology(){
      if(this.role==='source')this.trail=[];
      else if(this.parent)this.trail=[...(this.parent.remote.trail||[]),this.parent.remote.nodeId];
      this.onTopology({trail:[...this.trail],sourceReachable:this.getStatus().rooted,supplier:this.parent?{id:this.parent.remote.nodeId,label:this.parent.remote.label}:null});
    }
    _recover(reset=false,reason='searching'){
      if(this.closed||this.role==='source'||this.parent)return;
      if(!this.recovery||reset){this.recovery={state:'searching',attempts:0,startedAt:Date.now(),deadline:Date.now()+45000,retryAt:null,reason,failures:this.failures};this.onRecovery({...this.recovery,recoveries:this.recoveries});}
    }
    retryRecovery(){if(this.closed||this.role==='source'||this.parent)return false;this._recover(true);this._statusTick();return true;}
    recoverSupplier(reason='media-stalled'){
      if(this.closed||this.role==='source'||!this.parent)return false;
      const supplier=this.parent;
      this._coolSupplier(supplier,reason);
      supplier.failureReason=String(reason||'media-stalled').slice(0,80);
      supplier.wire.destroy();
      return true;
    }
    _coolSupplier(s,reason='supplier-failed'){
      const nodeId=s?.remote?.nodeId;if(!nodeId)return;
      const now=Date.now(),existing=this.failedSuppliers.get(nodeId)||0;if(existing>now)return;
      this.failedSuppliers.set(nodeId,now+20000);this.failures++;
      if(this.recovery){this.recovery.reason=String(reason||'supplier-failed').slice(0,80);this.recovery.failures=this.failures;}
    }
    _availability(){
      const now=Date.now();if(this.lastReject&&now-this.lastReject.at>15000)this.lastReject=null;
      const peers=[...this.wires.values()].filter(s=>s.auth&&!s.wire?.destroyed&&s.lastSeen&&now-s.lastSeen<=25000&&this._validStatus(s.remote));
      let rootedSuppliers=0,fullSuppliers=0,eligibleSuppliers=0,unrootedPeers=0;
      for(const s of peers){
        const remote=s.remote,rooted=this._rooted(remote);
        if(!rooted){unrootedPeers++;continue;}
        rootedSuppliers++;
        const relayLimit=Number.isInteger(remote.relayLimit)?Math.min(2,Math.max(0,remote.relayLimit)):2;
        const downCount=Number.isSafeInteger(remote.downCount)&&remote.downCount>=0?remote.downCount:null;
        const full=downCount!==null&&downCount>=relayLimit;
        if(full)fullSuppliers++;
        const cooled=(this.failedSuppliers.get(remote.nodeId)||0)>now;
        if(remote.clockReady===true&&!full&&downCount!==null&&!cooled&&!remote.trail.includes(this.node)&&remote.trail.length<12)eligibleSuppliers++;
      }
      return {authenticatedPeers:Math.min(12,peers.length),rootedSuppliers:Math.min(12,rootedSuppliers),fullSuppliers:Math.min(12,fullSuppliers),eligibleSuppliers:Math.min(12,eligibleSuppliers),unrootedPeers:Math.min(12,unrootedPeers),lastReject:this.lastReject&&now-this.lastReject.at<=15000?this.lastReject.reason:null};
    }
    snapshot(){return {parent:this.parent?.remote?.nodeId||null,trail:[...this.trail],sourceReachable:this.getStatus().rooted,recovery:this.recovery?{...this.recovery,recoveries:this.recoveries,failures:this.failures}:null,authenticatedPeers:[...this.wires.values()].filter(s=>s.auth).length,availability:this._availability(),network:this.network?{...this.network,elapsedSeconds:Math.max(0,Math.min(86400,Math.floor((Date.now()-this.networkStarted)/1000)))}:null};}
    _progress(name){try{this.onProgress(name);}catch{}}
    _status(){ return this.getStatus(); }
    async _cryptoKey(key){ return crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']); }
    async _mac(text){ return new Uint8Array(await crypto.subtle.sign('HMAC',this.hmac,encoder.encode(text))); }
    async _client(){ if(!this.client){this.client=new WebTorrent({dht:false,maxConns:12,tracker:{announce:this.trackers,rtcConfig:{iceServers:STUN},getAnnounceOpts:()=>({numwant:4})}});this.client.on('error',e=>this._fail(e));} return this.client; }
    _resetNetwork(phase){this.nextResetAt=0;this.resetFailures=0;this.lastTrackerReply=0;this.lastDiscoveryReset=0;this.networkStarted=Date.now();this.lastReannounce=Date.now();this.network={phase,problem:null,trackerCount:this.trackers.length,stunServerCount:STUN.length,relayConfigured:false,discoveryResets:0,resetState:'idle',resetProblem:null,bootstrapRetries:this.bootstrapRetries,retryAt:null,reannounces:0,trackerReplies:0,warnings:0,peerAttempts:0,peerErrors:0,monitoredPeers:0,iceConnected:0,iceFailed:0,hostCandidates:0,reflexiveCandidates:0};}
    _watchDiscovery(t){
      const current=()=>!this.closed&&this.torrent===t;
      const observe=()=>{const d=t.discovery;if(!current()||!d||this.observedDiscovery===d)return;this.observedDiscovery=d;this._boundTrackerOffers(d);
        d.on?.('trackerAnnounce',()=>{if(current()&&t.discovery===d){this.lastTrackerReply=Date.now();this.resetFailures=0;this.network.trackerReplies=Math.min(10000,this.network.trackerReplies+1);this._progress('tracker-reply');}});
        d.on?.('peer',peer=>{if(!current()||t.discovery!==d||!peer||typeof peer!=='object'||this.observedPeers.has(peer))return;this.observedPeers.add(peer);this.network.peerAttempts=Math.min(10000,this.network.peerAttempts+1);
          peer.on?.('error',()=>{if(current())this.network.peerErrors=Math.min(10000,this.network.peerErrors+1);});
          const pc=peer._pc;if(!pc?.addEventListener)return;this.network.monitoredPeers=Math.min(10000,this.network.monitoredPeers+1);let connected=false,failed=false;
          const iceState=()=>{if(!current())return;const state=pc.iceConnectionState;if(!connected&&['connected','completed'].includes(state)){connected=true;this.network.iceConnected++;this._progress('ice-connected');}if(!failed&&state==='failed'){failed=true;this.network.iceFailed++;}};pc.addEventListener('iceconnectionstatechange',iceState);iceState();
          pc.addEventListener('icecandidate',event=>{if(!current())return;const type=event.candidate?.type;if(type==='host')this.network.hostCandidates=Math.min(10000,this.network.hostCandidates+1);if(type==='srflx'||type==='prflx')this.network.reflexiveCandidates=Math.min(10000,this.network.reflexiveCandidates+1);});
        });
      };
      if(!this.watchedTorrents.has(t)){this.watchedTorrents.add(t);t.on('infoHash',()=>queueMicrotask(observe));t.on('ready',observe);t.on('warning',()=>{if(current())this.network.warnings=Math.min(10000,this.network.warnings+1);});}observe();queueMicrotask(observe);
    }
    _boundTrackerOffers(discovery){
      // Tracker response intervals are untrusted scheduling hints. The pinned
      // browser tracker otherwise permits arbitrarily rapid offer allocation.
      for(const tracker of discovery?.tracker?._trackers||[]){
        if(this.boundedTrackers.has(tracker)||typeof tracker.setInterval!=='function'||typeof tracker.announce!=='function')continue;
        this.boundedTrackers.add(tracker);const setInterval=tracker.setInterval,announce=tracker.announce;
        tracker.setInterval=function(ms){return setInterval.call(this,ms===0?0:Math.max(REANNOUNCE,Number(ms)||this.DEFAULT_ANNOUNCE_INTERVAL||REANNOUNCE));};
        tracker.announce=function(options={}){
          if(options.event==='stopped'||options.event==='completed')return announce.call(this,options);
          for(const [key,peer] of Object.entries(this.peers||{})){
            if(peer.destroyed||['closed','failed'].includes(peer._pc?.connectionState)||['closed','failed'].includes(peer._pc?.iceConnectionState)){
              clearTimeout(peer.trackerTimeout);peer.trackerTimeout=null;delete this.peers[key];if(!peer.destroyed)peer.destroy();
            }
          }
          const room=Math.max(0,12-Object.keys(this.peers||{}).length),requested=Number(options.numwant);
          const count=Number.isFinite(requested)?Math.max(0,Math.min(4,Math.floor(requested))):4;
          return announce.call(this,{...options,numwant:Math.min(room,count)});
        };
        // Apply the floor to the already-started tracker timer as well.
        tracker.setInterval(REANNOUNCE);
      }
    }
    _refreshDiscovery(){
      if(this.closed||Date.now()-this.lastReannounce<REANNOUNCE||this.lastTrackerReply&&Date.now()-this.lastTrackerReply<REANNOUNCE)return false;const tracker=this.torrent?.discovery?.tracker;if(typeof tracker?.update!=='function')return false;this.lastReannounce=Date.now();
      try{tracker.update({numwant:4});if(this.network)this.network.reannounces=Math.min(10000,this.network.reannounces+1);return true;}catch{if(this.network)this.network.warnings=Math.min(10000,this.network.warnings+1);return false;}
    }
    // Adapter for the pinned WebTorrent bundle: renew tracker sockets/offers,
    // retaining its descriptor store and all still-healthy application wires.
    refreshNetwork(reason='network-change') {
      if(this.resumeBootstrapWait){this.resumeBootstrapWait();return true;}
      if(this.closed||!this.torrent)return false;
      if(this.resetTimer||this.resetPromise)return true;
      const allowed=['online','visible','network-change','recovery-stalled','tracker-stale','manual'];
      const cause=allowed.includes(reason)?reason:'network-change';
      const delay=Math.min(60000,Math.max(200,this.nextResetAt-Date.now())+Math.floor(Math.random()*500));
      if(this.network){this.network.resetState='scheduled';this.network.resetReason=cause;}
      this.resetTimer=setTimeout(()=>{this.resetTimer=null;this.resetPromise=this._renewDiscovery().catch(()=>{}).finally(()=>{this.resetPromise=null;});},delay);
      return true;
    }
    _retireTrackerTimers(discovery){
      // Pinned tracker.destroy() returns early when its socket has already
      // failed, leaving the reconnect timer installed by _onSocketClose alive.
      // Cancel it explicitly so retired discovery wrappers cannot reopen pooled
      // sockets and negotiate orphan peers with no WebTorrent wire listeners.
      for(const tracker of discovery?.tracker?._trackers||[]){
        clearTimeout(tracker.reconnectTimer);tracker.reconnectTimer=null;
        clearInterval(tracker.interval);tracker.interval=null;tracker.reconnecting=false;
      }
    }
    async _renewDiscovery() {
      const torrent=this.torrent,discovery=torrent?.discovery,generation=this.discoveryGeneration;
      const current=()=>!this.closed&&this.torrent===torrent&&this.discoveryGeneration===generation;
      if(!current())return false;
      // These internals are checked explicitly because a vendor upgrade may
      // change them. Unsupported copies retain media and report the limitation.
      if(torrent?.destroyed||this.client?.destroyed){
        if(this.network){this.network.resetState='failed';this.network.resetProblem='discovery-session-ended';}this.nextResetAt=Date.now()+60000;
        if(!this.sessionEndedWarned){this.sessionEndedWarned=true;this._fail(Error('The direct discovery session ended. Reopen your private invitation to reconnect; the saved picture and group clock remain here.'));}return false;
      }
      if(typeof torrent?._startDiscovery!=='function'||discovery&&!discovery.destroyed&&(typeof discovery.destroy!=='function'||!Array.isArray(discovery.tracker?._trackers))){
        if(this.network){this.network.resetState='unsupported';this.network.resetProblem='discovery-adapter-unavailable';}
        this.nextResetAt=Date.now()+60000;
        if(!this.adapterWarned){this.adapterWarned=true;this._fail(Error('Automatic network discovery renewal is unavailable on this app copy. Reopen the current Same End app to reconnect.'));}
        return false;
      }
      const sockets=[...new Set((discovery?.tracker?._trackers||[]).map(t=>t.socket).filter(Boolean))];
      if(sockets.some(s=>typeof s.destroy!=='function')){if(this.network){this.network.resetState='unsupported';this.network.resetProblem='discovery-adapter-unavailable';}this.nextResetAt=Date.now()+60000;return false;}
      this.resetFailures++;this.nextResetAt=Date.now()+Math.min(60000,10000*Math.pow(2,Math.min(3,this.resetFailures-1)));
      if(this.network)this.network.resetState='renewing';
      // _startDiscovery creates a new no-peers timer; retire the old one first.
      clearInterval(torrent._noPeersIntervalId);torrent._noPeersIntervalId=null;this._retireTrackerTimers(discovery);
      if(discovery&&!discovery.destroyed)await new Promise(resolve=>{let settled=false;const done=()=>{if(settled)return;settled=true;clearTimeout(timeout);resolve();};const timeout=setTimeout(done,3000);try{discovery.destroy(done);}catch{done();}});
      // A tracker socket can be shared by discovery clients in this window.
      // Retire the old pooled socket as well, otherwise a new wrapper can reuse
      // the same half-open WebSocket and its multi-minute reconnect backoff.
      for(const socket of sockets){if(!current())return false;if(socket.destroyed)continue;const lastReply=Math.max(this.lastTrackerReply,this.networkStarted||0);if(socket.consumers>0&&socket.connected!==false&&Date.now()-lastReply<45000)continue;await new Promise(resolve=>{let settled=false;const done=()=>{if(settled)return;settled=true;clearTimeout(timeout);resolve();};const timeout=setTimeout(done,1500);socket.once?.('close',done);try{socket.destroy();}catch{done();}if(socket.destroyed)done();});}
      if(!current())return false;
      if(torrent.discovery!==discovery)return false;
      torrent.discovery=null;this.observedDiscovery=null;
      try{torrent._startDiscovery();if(!torrent.discovery||torrent.discovery===discovery||torrent.discovery.destroyed||torrent.destroyed||this.client?.destroyed)throw Error('Discovery was not installed.');this._watchDiscovery(torrent);this.lastDiscoveryReset=Date.now();if(this.network){this.network.discoveryResets=Math.min(10000,this.network.discoveryResets+1);this.network.resetState='renewed';this.network.resetProblem=null;}this._progress('discovery-renewed');return true;}
      catch{if(this.network){this.network.resetState='failed';this.network.resetProblem='discovery-renewal-failed';}this._fail(Error('The network changed. Same End is retrying direct discovery.'));return false;}
    }
    async join(magnet) {
      await this.close();this.closed=false;const intent=++this.bootstrapGeneration;this.bootstrapRetries=0;
      while(intent===this.bootstrapGeneration){
        try{return await this._joinAttempt(magnet);}
        catch(error){
          if(intent!==this.bootstrapGeneration||!['no-direct-peer','transport-error'].includes(error.code)||error.acceptedSession)throw error;
          this.bootstrapRetries++;
          const delay=Math.min(60000,2000*Math.pow(2,Math.min(5,this.bootstrapRetries-1))+Math.floor(Math.random()*1000));
          if(this.network){this.network.bootstrapRetries=this.bootstrapRetries;this.network.retryAt=Date.now()+delay;this.network.phase='retrying';}
          this._progress('bootstrap-retrying');this.onRecovery({state:'retrying',reason:error.code,retryAt:Date.now()+delay,attempts:this.bootstrapRetries});
          await new Promise((resolve,reject)=>{this.cancelBootstrapWait=()=>{clearTimeout(this.bootstrapTimer);this.bootstrapTimer=null;this.cancelBootstrapWait=null;this.resumeBootstrapWait=null;const e=Error('The direct connection search was cancelled.');e.code='cancelled';reject(e);};this.resumeBootstrapWait=()=>{clearTimeout(this.bootstrapTimer);this.bootstrapTimer=null;this.cancelBootstrapWait=null;this.resumeBootstrapWait=null;resolve();};this.bootstrapTimer=setTimeout(this.resumeBootstrapWait,delay);});
          if(intent!==this.bootstrapGeneration){const e=Error('The direct connection search was cancelled.');e.code='cancelled';throw e;}
          this.closed=false;
        }
      }
    }
    async publish(config){
      if(!configOK(config)) throw Error('Unsupported Same End settings.'); await this.close(); this.closed=false;
      this._resetNetwork('publishing');this.role='source'; this.config=config; this.key=rand(32); this.hmac=await this._cryptoKey(this.key); this.label='Source';
      const iv=rand(12), plain=encoder.encode(JSON.stringify({config}));
      if(plain.length>32768) throw Error('Cast descriptor exceeds 32 KB.');
      const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await crypto.subtle.importKey('raw',this.key,'AES-GCM',false,['encrypt']),plain));
      const payload=new Uint8Array(iv.length+cipher.length); payload.set(iv); payload.set(cipher,iv.length);
      const torrent=await this._client();
      await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>reject(Error('Tracker service did not initialize in time.')),20000); const t=this.client.seed(new File([payload],'private-cast.cast',{type:'application/octet-stream'}),{announce:this.trackers,private:true,store:MemoryStore,storeCacheSlots:0,destroyStoreOnDestroy:true},t=>{this.torrent=t;clearTimeout(timer);resolve();}); this.torrent=t;this._watchDiscovery(t); t.on('error',e=>{clearTimeout(timer);reject(e);}); });
      this.network.phase='descriptor-ready';this.sessionReady=true; this._topology(); this._start(); return `${this.torrent.magnetURI}#pc=${b64(this.key)}`;
    }
    async _joinAttempt(magnet){
      this.closed=false;const generation=++this.joinGeneration;
      if(typeof magnet!=='string'||magnet.length>8192||!/^magnet:\?/.test(magnet))throw Error('Choose a valid Same End magnet.');
      const u=new URL(magnet.replace(/%23pc(?:=|%3d)([A-Za-z0-9_-]{43})$/i,'#pc=$1')),packed=u.hash.slice(1).split('&').find(x=>x.startsWith('pc='))?.slice(3);
      if(!packed)throw Error('This magnet is missing its private cast key.');this.key=un64(decodeURIComponent(packed));
      if(this.key.length!==32)throw Error('This magnet has an invalid private cast key.');this.hmac=await this._cryptoKey(this.key);if(this.closed||generation!==this.joinGeneration){const e=Error('The direct connection search was cancelled.');e.code='cancelled';throw e;}this.role='viewer';u.hash='';this.label=String((this.getStatus()||{}).label||'Friend').slice(0,40);
      const xt=u.searchParams.get('xt');if(!/^urn:btih:[a-f\d]{40}$/i.test(xt||''))throw Error('Magnet must contain a valid BitTorrent infohash.');
      this._resetNetwork('finding-peers');const client=await this._client();
      try{await new Promise((resolve,reject)=>{
        let settled=false,timeout,refresh;
        const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timeout);clearInterval(refresh);this.pendingJoin=null;if(error){if(this.network){this.network.phase='failed';this.network.problem=error.code||'descriptor-invalid';}reject(error);}else resolve(this.config);};
        const failure=(code,message)=>{const error=Error(message);error.code=code;finish(error);};
        this.pendingJoin=()=>failure('cancelled','The direct connection search was cancelled.');
        timeout=setTimeout(()=>failure('no-direct-peer','No direct picture route found after 90 seconds. Keep the host and an invited mate on another network online, then try again. Some mobile networks block all available direct routes.'),JOIN_WAIT);
        refresh=setInterval(()=>{if(this.closed||generation!==this.joinGeneration)return failure('cancelled','The direct connection search was cancelled.');this._refreshDiscovery();},REANNOUNCE);
        const clean='magnet:?xt='+xt+this.trackers.map(x=>'&tr='+encodeURIComponent(x)).join('');
        const t=client.add(clean,{store:MemoryStore,storeCacheSlots:0,destroyStoreOnDestroy:true},torrent=>{
          (async()=>{try{
            if(settled||this.closed||generation!==this.joinGeneration)return;
            if(torrent.files.length!==1||torrent.length>32832||torrent.files[0].length>32832)throw Error('Invalid cast descriptor size.');
            const bytes=new Uint8Array(await torrent.files[0].arrayBuffer());if(settled||this.closed||generation!==this.joinGeneration)return;
            if(bytes.length<29||bytes.length>32832)throw Error('Invalid cast descriptor size.');
            const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},await crypto.subtle.importKey('raw',this.key,'AES-GCM',false,['decrypt']),bytes.slice(12));
            if(settled||this.closed||generation!==this.joinGeneration)return;const d=JSON.parse(decoder.decode(plain));if(!d||!configOK(d.config))throw Error('Unsupported cast descriptor.');
            this.config=d.config;this.network.phase='descriptor-ready';await Promise.resolve(this.onSession(this.config));if(settled||this.closed||generation!==this.joinGeneration)return;
            this.sessionReady=true;this._start();finish();
          }catch{failure('descriptor-invalid','Unable to verify this private room. Ask your host for a fresh invitation.');}})();
        });this.torrent=t;this._watchDiscovery(t);t.on('error',()=>failure('transport-error','The direct picture connection stopped. Check the host and try the invitation again.'));t.on('wire',w=>this._attach(w));
      });}catch(e){if(this.network&&this.network.phase!=='failed'){this.network.phase='failed';this.network.problem='transport-error';}const accepted=!!this.config;await this._closeSession();e.acceptedSession=accepted;if(accepted&&!e.code)e.code='descriptor-invalid';throw e;}
    }
    _start(){ this._recover(); if(this.timer)clearInterval(this.timer); this.timer=setInterval(()=>{this._statusTick();},1000); this._statusTick(); this.torrent?.on('wire',w=>this._attach(w)); for(const s of this.wires.values())if(s.auth)this._assign(s); }
    _attach(w){ if(this.closed||this.wires.has(w))return; if(this.wires.size>=12){w.destroy();return;} const state={wire:w,auth:false,remote:null,challenge:b64(rand(24)),peerId:id(),last:0,createdAt:Date.now(),lastSeen:Date.now()}; this.wires.set(w,state);
      const self=this;
      function Extension(wire){this.wire=wire; this.name=EXT; this.onExtendedHandshake=()=>self._send(state,{type:'_pc_hello',challenge:state.challenge,...self._status()}); this.onMessage=buf=>{self._message(state,buf).catch(e=>self._fail(e));};}
      Extension.prototype.name=EXT;
      try{w.use(Extension); w.on('close',()=>this._drop(state)); w.on('error',e=>this._fail(e));}catch(e){this._fail(e);}
    }
    _send(s,m){ if(!s.wire?.extended) return; const json=encoder.encode(JSON.stringify(m)); if(json.length<=4096){const b=new Uint8Array(json.length+1);b[0]=0;b.set(json,1);try{s.wire.extended(EXT,b);}catch(e){this._fail(e);}} }
    async _message(s,buf){
      if(this.closed||!this.wires.has(s.wire))return;
      if(!buf?.length)throw Error('Invalid private cast control message.');
      const kind=buf[0], body=buf.subarray(1);
      if(kind===1){if(s.auth)s.lastSeen=Date.now();if(s.auth&&s.adapter)s.adapter.onmessage?.({data:decoder.decode(body)});return;}
      if(kind===2){if(s.auth)s.lastSeen=Date.now();if(s.auth&&s.adapter)s.adapter.onmessage?.({data:body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength)});return;}
      if(kind!==0)throw Error('Invalid private cast frame.');
      if(body.length>4096)throw Error('Invalid private cast control message.');
      const m=JSON.parse(decoder.decode(body)); if(typeof m.type!=='string'||!m.type.startsWith('_pc_'))throw Error('Invalid private cast control message.');
      if(m.type==='_pc_hello'){
        if(typeof m.challenge!=='string'||m.challenge.length>100||!this._validStatus(m))return;
        s.remote=m; const proof=b64(await this._mac(m.challenge+'|'+this.node)); if(this.closed||!this.wires.has(s.wire))return;this._send(s,{type:'_pc_auth',proof,challenge:s.challenge,...this._status()}); return;
      }
      if(m.type==='_pc_auth'){
        if(!s.remote||!await crypto.subtle.verify('HMAC',this.hmac,un64(m.proof),encoder.encode(s.challenge+'|'+s.remote.nodeId)))return;
        if(this.closed||!this.wires.has(s.wire))return;
        if(m.nodeId!==undefined&&(!this._validStatus(m)||m.nodeId!==s.remote.nodeId))return;
        s.auth=true;s.lastSeen=Date.now();this.resetFailures=0;this._progress('peer-authenticated'); s.remote={...s.remote,...m}; this._send(s,{type:'_pc_ready',proof:b64(await this._mac(s.remote.challenge+'|'+this.node))}); this._assign(s); return;
      }
      if(m.type==='_pc_ready'){
        if(!s.remote||!await crypto.subtle.verify('HMAC',this.hmac,un64(m.proof),encoder.encode(s.challenge+'|'+s.remote.nodeId)))return;
        if(this.closed||!this.wires.has(s.wire))return;
        s.auth=true;s.lastSeen=Date.now();this.resetFailures=0;this._progress('peer-authenticated'); this._assign(s); return;
      }
      if(!s.auth)return;
      if(m.type==='_pc_status'){
        if(!this._validStatus(m)||m.nodeId!==s.remote?.nodeId)return;
        s.lastSeen=Date.now();s.remote={...s.remote,...m};
        if(this.parent===s){
          if(s.remote.trail.includes(this.node)||s.remote.trail.length>=12){s.wire.destroy();return;}
          this._topology();
        }
        this._assign(s);
      } else if(m.type==='_pc_offer'){
        const mine=this._status();
        const reserved=[...this.wires.values()].filter(p=>p.pendingNonce&&p.pendingUntil>Date.now()&&!p.opened).length;
        if(!this._validStatus(m)||m.nodeId!==s.remote?.nodeId||s.opened||!mine.rooted||!mine.clockReady||mine.downCount+reserved>=mine.relayLimit||mine.trail.length>=12||mine.trail.includes(s.remote.nodeId)){
          const reason=!this._validStatus(m)||m.nodeId!==s.remote?.nodeId||s.opened?'invalid-status':!mine.rooted?'source-unavailable':!mine.clockReady?'not-ready':mine.trail.length>=12||mine.trail.includes(s.remote.nodeId)?'loop':'capacity-full';
          this._send(s,{type:'_pc_reject',nonce:m.nonce,reason});return;
        }
        s.remote={...s.remote,...m}; s.pendingNonce=m.nonce; s.pendingUntil=Date.now()+5000;
        this._send(s,{type:'_pc_accept',nonce:s.pendingNonce,...mine});
      } else if(m.type==='_pc_accept'&&s.request&&this.parentRequest===s&&s.requestUntil>Date.now()&&m.nonce===s.requestNonce){
        const accepted={...s.remote,...m};
        if(!this._validStatus(accepted)||accepted.nodeId!==s.remote.nodeId||!this._rooted(accepted)||accepted.trail.includes(this.node)||accepted.trail.length>=12){this._releaseRequest(s);return;}
        s.remote=accepted; s.direction='up'; this._open(s); this._send(s,{type:'_pc_confirm',nonce:m.nonce});
      } else if(m.type==='_pc_confirm'&&s.pendingNonce===m.nonce&&s.pendingUntil>Date.now()){
        const mine=this._status(),reserved=[...this.wires.values()].filter(p=>p!==s&&p.pendingNonce&&p.pendingUntil>Date.now()&&!p.opened).length;s.pendingNonce=null;
        if(!mine.rooted||mine.trail.includes(s.remote.nodeId)||mine.downCount+reserved>=mine.relayLimit){const reason=!mine.rooted?'source-unavailable':mine.trail.includes(s.remote.nodeId)?'loop':'capacity-full';this._send(s,{type:'_pc_reject',nonce:m.nonce,reason});return;}
        s.direction='down'; this._open(s);
      } else if(m.type==='_pc_reject'&&m.nonce===s.requestNonce){
        if(s.request&&this.parentRequest===s&&s.requestUntil>Date.now()){
          if(['capacity-full','source-unavailable','not-ready','loop','invalid-status'].includes(m.reason))this.lastReject={reason:m.reason,at:Date.now()};
          this._releaseRequest(s);
        }else if(this.parent===s)s.wire.destroy();
      }
    }
    _validStatus(m){return typeof m.nodeId==='string'&&m.nodeId.length<100&&m.nodeId!==this.node&&Array.isArray(m.trail)&&m.trail.length<=12&&m.trail.every(x=>typeof x==='string'&&x.length<100)&&new Set(m.trail).size===m.trail.length&&!m.trail.includes(m.nodeId)&&(m.relayLimit===undefined||(Number.isInteger(m.relayLimit)&&m.relayLimit>=0&&m.relayLimit<=2));}
    _releaseRequest(s){s.request=false;s.retryAfter=Date.now()+5000;if(this.parentRequest===s)this.parentRequest=null;}
    _assign(s){
      if(!this.sessionReady||!s.auth||!s.remote||this.role==='source'||this.parent||this.parentRequest||s.opened||s.retryAfter>Date.now())return;
      this._recover();const r=this.recovery;
      if(!r||r.state!=='searching'||Date.now()>=r.deadline||r.attempts>=8)return;
      const remote=s.remote,mine=this._status();
      const coolUntil=this.failedSuppliers.get(remote?.nodeId)||0;if(coolUntil<=Date.now())this.failedSuppliers.delete(remote?.nodeId);
      const relayLimit=Number.isInteger(remote?.relayLimit)?Math.min(2,Math.max(0,remote.relayLimit)):2;
      if(this._validStatus(remote)&&this._rooted(remote)&&remote.clockReady&&Number(remote.downCount)<relayLimit&&coolUntil<=Date.now()&&!remote.trail.includes(this.node)&&remote.trail.length<12)this._request(s,mine);
    }
    _request(s,mine){const r=this.recovery;s.request=true;s.requestNonce=id();s.requestUntil=Date.now()+5000;this.parentRequest=s;r.attempts++;this.onRecovery({...r,recoveries:this.recoveries});this._send(s,{type:'_pc_offer',nonce:s.requestNonce,...mine});}
    _open(s){ if(s.opened)return;
      if(s.direction==='up'){if(this.role==='source'||this.parent){s.wire.destroy();return;}this.parent=s;this.parentRequest=null;s.request=false;this.clockReady=true;if(this.everParent)this.recoveries++;this.everParent=true;this.recovery={...this.recovery,state:'connected',lastRecoveredAt:Date.now()};this._topology();this.onRecovery({...this.recovery,recoveries:this.recoveries});}
      else {if(this.down>=this._status().relayLimit){s.wire.destroy();return;}this.down++;}
      this.lastReject=null;s.opened=true;
      const owner=this,adapter={readyState:'open',get bufferedAmount(){const p=[...(owner.torrent?._peers?.values?.()||[])].find(x=>x.wire===s.wire);return Number(s.wire.readableLength||s.wire._readableState?.length||p?.conn?.channel?.bufferedAmount||p?.conn?._channel?.bufferedAmount||0);},onopen:null,onmessage:null,onclose:null,onerror:null,send:data=>{if(!s.auth||s.wire.destroyed)throw Error('Peer connection is closed.'); const kind=typeof data==='string'?1:2,raw=kind===1?encoder.encode(data):new Uint8Array(data);if(raw.length>65536)throw Error('Peer packet exceeds 64 KB.');const frame=new Uint8Array(raw.length+1);frame[0]=kind;frame.set(raw,1);s.wire.extended(EXT,frame);},close:()=>{s.wire.destroy();}};
      if(this.network)this.network.phase='connected';s.adapter=adapter; this.links.set(s,adapter); this.onPeer({id:s.remote.nodeId,label:String(s.remote.label||'Friend').slice(0,40),direction:s.direction,trail:(s.remote.trail||[]).concat(s.remote.nodeId).slice(-12),channel:adapter});
      queueMicrotask(()=>adapter.onopen?.()); this._broadcast();
    }
    _broadcast(){const st=this._status();for(const s of this.wires.values())if(s.auth)this._send(s,{type:'_pc_status',...st});}
    _statusTick(){
      if(this.closed)return;
      const t=Date.now(),suspended=this.lastStatusTick&&t-this.lastStatusTick>10000;this.lastStatusTick=t;
      for(const [nodeId,until] of this.failedSuppliers)if(until<=t)this.failedSuppliers.delete(nodeId);
      for(const s of this.wires.values()){
        if(suspended)s.lastSeen=t;
        if(s.lastSeen&&t-s.lastSeen>(s.auth?25000:15000)){s.failureReason='peer-unresponsive';s.wire.destroy();continue;}
        if(s.pendingNonce&&s.pendingUntil<t)s.pendingNonce=null;
        if(this.parentRequest===s&&s.requestUntil<t)this._releaseRequest(s);
      }
      const r=this.recovery;
      if(!this.parent&&r?.state==='searching'&&(t>=r.deadline||r.attempts>=8)&&!this.parentRequest){r.state='exhausted';this.failures++;r.failures=this.failures;const delay=Math.min(60000,5000*Math.pow(2,Math.min(4,Math.max(0,r.failures-1))));r.retryAt=t+Math.min(60000,delay+Math.floor(Math.random()*1000));this.onRecovery({...r,recoveries:this.recoveries});}
      if(!this.parent&&r?.state==='exhausted'&&r.retryAt&&t>=r.retryAt)this._recover(true,'automatic-retry');
      this._broadcast();if(this.sessionReady||this.recovery?.state==='searching')this._refreshDiscovery();
      const baseline=Math.max(this.lastTrackerReply,this.lastDiscoveryReset,this.networkStarted||t);
      if(this.torrent&&this.lastReannounce>baseline&&t-baseline>45000)this.refreshNetwork('tracker-stale');
      if(this.sessionReady&&this.role!=='source'&&!this.parent&&this.recovery&&t-this.recovery.startedAt>15000)this.refreshNetwork('recovery-stalled');
      // Prefer the original source, then the shortest authenticated rooted path.
      const candidates=[...this.wires.values()].sort((a,b)=>(a.remote?.trail?.length??99)-(b.remote?.trail?.length??99));
      for(const s of candidates)this._assign(s);
    }
    _drop(s){
      if(!this.wires.has(s.wire))return;
      this.wires.delete(s.wire);this.links.delete(s);
      if(this.parentRequest===s)this._releaseRequest(s);
      if(s.opened){
        if(s.direction==='up'&&this.parent===s){const reason=s.failureReason||'supplier-disconnected';this._coolSupplier(s,reason);this.parent=null;this._topology();this._recover(true,reason);}
        if(s.direction==='down')this.down=Math.max(0,this.down-1);
        if(s.adapter){s.adapter.readyState='closed';s.adapter.onclose?.();}
      }
      this._broadcast();
      if(!this.closed)queueMicrotask(()=>this._statusTick());
    }
    _fail(e){ if(!this.closed)this.onError(e instanceof Error?e:Error(String(e))); }
    async close(){this.bootstrapGeneration++;this.cancelBootstrapWait?.();this.bootstrapRetries=0;await this._closeSession();}
    async _closeSession(){this._retireTrackerTimers(this.torrent?.discovery);this.discoveryGeneration++;clearTimeout(this.resetTimer);this.resetTimer=null;this.closed=true;this.joinGeneration++;const cancel=this.pendingJoin;this.pendingJoin=null;cancel?.();this.observedDiscovery=null; clearInterval(this.timer); this.timer=null; for(const s of this.wires.values())try{s.wire.destroy();}catch{} this.wires.clear();this.links.clear();this.parent=null;this.parentRequest=null;this.down=0;this.sessionReady=false;this.failedSuppliers.clear();this.failures=0;this.recovery=null;this.recoveries=0;this.everParent=false; if(this.torrent&&!this.torrent.destroyed){try{await Promise.race([new Promise(resolve=>this.torrent.destroy({destroyStore:true},resolve)),new Promise(resolve=>setTimeout(resolve,1500))]);}catch{}} if(this.client&&!this.client.destroyed){try{await Promise.race([new Promise(resolve=>this.client.destroy(resolve)),new Promise(resolve=>setTimeout(resolve,1500))]);}catch{}} this.torrent=null;this.client=null;this.config=null;this.hmac=null;this.key=null; }
  }
  window.CastMagnetTransport=MagnetTransport;
})();
