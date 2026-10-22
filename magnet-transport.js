import WebTorrent from './vendor/webtorrent.min.js';

/* Same End magnet discovery and authenticated control transport.
 * Requires the official WebTorrent browser bundle (window.WebTorrent).
 * Media remains on Same End's signedchunks/WebRTC application path.
 */
(() => {
  'use strict';
  const TRACKERS = [
    'wss://tracker.openwebtorrent.com'
  ];
  const EXT = 'ut_privatecast';
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const b64 = b => { let s=''; for (const x of b) s+=String.fromCharCode(x); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); };
  const un64 = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const id = () => b64(rand(12));
  const configOK = c => !!c && typeof c.id==='string' && c.id.length<100 && Number.isFinite(c.epoch) && [10,60,300].includes(c.delay) && ['video/mp4;codecs=avc1.42001f,mp4a.40.2','video/mp4;codecs=avc1.42001f','video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8,opus','video/webm;codecs=vp8'].includes(c.mime) && c.publicKey && c.publicKey.kty==='EC' && c.publicKey.crv==='P-256' && (c.segmentVersion===undefined||(c.segmentVersion===2&&typeof c.sourceId==='string'&&c.sourceId.length>0&&c.sourceId.length<=100&&Number.isSafeInteger(c.sourceEpoch)&&c.sourceEpoch>=0&&typeof c.programId==='string'&&c.programId.length>0&&c.programId.length<=100&&c.alignmentVersion===1));
  function MemoryStore(chunkLength,opts={}){if(!(this instanceof MemoryStore))return new MemoryStore(chunkLength,opts);this.chunkLength=Number(chunkLength);this.length=Number(opts.length)||0;if(!this.chunkLength||this.length>32832)throw Error('Cast descriptor storage exceeds 32 KB.');this.chunks=[];this.closed=false;this.lastChunkLength=(this.length%this.chunkLength)||this.chunkLength;this.lastChunkIndex=Math.ceil(this.length/this.chunkLength)-1;}
  MemoryStore.prototype.put=function(i,b,cb=()=>{}){if(this.closed)return queueMicrotask(()=>cb(Error('Store is closed.')));if(i<0||i>this.lastChunkIndex||b.length!==(i===this.lastChunkIndex?this.lastChunkLength:this.chunkLength))return queueMicrotask(()=>cb(Error('Invalid descriptor chunk.')));this.chunks[i]=b;queueMicrotask(()=>cb(null));};
  MemoryStore.prototype.get=function(i,o,cb=()=>{}){if(typeof o==='function')return this.get(i,null,o);if(this.closed)return queueMicrotask(()=>cb(Error('Store is closed.')));let b=this.chunks[i];if(!b){const e=Error('Chunk not found.');e.notFound=true;return queueMicrotask(()=>cb(e));}o=o||{};if(o.offset||o.length)b=b.slice(o.offset||0,(o.offset||0)+(o.length||b.length));queueMicrotask(()=>cb(null,b));};
  MemoryStore.prototype.close=MemoryStore.prototype.destroy=function(cb=()=>{}){if(this.closed)return queueMicrotask(()=>cb(null));this.closed=true;this.chunks=null;queueMicrotask(()=>cb(null));};

  class MagnetTransport {
    constructor({getStatus=()=>({}),onSession=()=>{},onPeer=()=>{},onError=()=>{},onRecovery=()=>{},onTopology=()=>{},trackers=TRACKERS}={}) {
      this.readStatus=getStatus; this.onSession=onSession; this.onPeer=onPeer; this.onError=onError; this.onRecovery=onRecovery; this.onTopology=onTopology;
      this.trackers=Array.from(new Set(trackers.map(x=>{const u=new URL(x);if(u.protocol!=='wss:')throw Error('Trackers must use secure WebSocket.');return u.href;}))).slice(0,2);
      this.client=null; this.torrent=null; this.key=null; this.role=null; this.node=String((getStatus()||{}).nodeId||id()); this.label='Friend';
      this.config=null; this.closed=false; this.wires=new Map(); this.links=new Map(); this.timer=null; this.trail=[]; this.parent=null; this.parentRequest=null; this.down=0; this.clockReady=false;
      this.sessionReady=false; this.recovery=null; this.recoveries=0; this.everParent=false;
    }
    _rooted(remote){ return remote?.role==='source'||(remote?.rooted===true&&remote?.hasParent===true); }
    getStatus(){
      const s=this.readStatus()||{};
      const trail=this.role==='source'?[]:this.trail;
      const rooted=this.role==='source'||!!(this.parent&&this._rooted(this.parent.remote));
      return {nodeId:String(s.nodeId||this.node),label:String(s.label||this.label).slice(0,40),role:this.role,clockReady:!!s.clockReady,trail:trail.slice(0,12),downCount:Math.max(this.down,Number(s.downCount)||0),hasParent:!!this.parent,rooted};
    }
    _topology(){
      if(this.role==='source')this.trail=[];
      else if(this.parent)this.trail=[...(this.parent.remote.trail||[]),this.parent.remote.nodeId];
      this.onTopology({trail:[...this.trail],sourceReachable:this.getStatus().rooted,supplier:this.parent?{id:this.parent.remote.nodeId,label:this.parent.remote.label}:null});
    }
    _recover(reset=false){
      if(this.closed||this.role==='source'||this.parent)return;
      if(!this.recovery||reset){this.recovery={state:'searching',attempts:0,startedAt:Date.now(),deadline:Date.now()+45000};this.onRecovery({...this.recovery,recoveries:this.recoveries});}
    }
    retryRecovery(){if(this.closed||this.role==='source'||this.parent)return false;this._recover(true);this._statusTick();return true;}
    snapshot(){return {parent:this.parent?.remote?.nodeId||null,trail:[...this.trail],sourceReachable:this.getStatus().rooted,recovery:this.recovery?{...this.recovery,recoveries:this.recoveries}:null,authenticatedPeers:[...this.wires.values()].filter(s=>s.auth).length};}
    _status(){ return this.getStatus(); }
    async _cryptoKey(key){ return crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']); }
    async _mac(text){ return new Uint8Array(await crypto.subtle.sign('HMAC',this.hmac,encoder.encode(text))); }
    async _client(){ if(!this.client){this.client=new WebTorrent({dht:false,tracker:{announce:this.trackers,rtcConfig:{iceServers:[{urls:'stun:stun.l.google.com:19302'}]}}});this.client.on('error',e=>this._fail(e));} return this.client; }
    async publish(config){
      if(!configOK(config)) throw Error('Unsupported Same End settings.'); await this.close(); this.closed=false;
      this.role='source'; this.config=config; this.key=rand(32); this.hmac=await this._cryptoKey(this.key); this.label='Source';
      const iv=rand(12), plain=encoder.encode(JSON.stringify({config}));
      if(plain.length>32768) throw Error('Cast descriptor exceeds 32 KB.');
      const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await crypto.subtle.importKey('raw',this.key,'AES-GCM',false,['encrypt']),plain));
      const payload=new Uint8Array(iv.length+cipher.length); payload.set(iv); payload.set(cipher,iv.length);
      const torrent=await this._client();
      await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>reject(Error('Tracker service did not initialize in time.')),20000); const t=this.client.seed(new File([payload],'private-cast.cast',{type:'application/octet-stream'}),{announce:this.trackers,private:true,store:MemoryStore,storeCacheSlots:0,destroyStoreOnDestroy:true},t=>{this.torrent=t;clearTimeout(timer);resolve();}); this.torrent=t; t.on('error',e=>{clearTimeout(timer);reject(e);}); });
      this.sessionReady=true; this._topology(); this._start(); return `${this.torrent.magnetURI}#pc=${b64(this.key)}`;
    }
    async join(magnet){
      await this.close(); this.closed=false;
      if(typeof magnet!=='string'||magnet.length>8192||!/^magnet:\?/.test(magnet)) throw Error('Choose a valid Same End magnet.');
      const u=new URL(magnet.replace(/%23pc(?:=|%3d)([A-Za-z0-9_-]{43})$/i,'#pc=$1')); const packed=u.hash.slice(1).split('&').find(x=>x.startsWith('pc='))?.slice(3);
      if(!packed) throw Error('This magnet is missing its private cast key.'); this.key=un64(decodeURIComponent(packed));
      if(this.key.length!==32) throw Error('This magnet has an invalid private cast key.'); this.hmac=await this._cryptoKey(this.key); this.role='viewer';
      u.hash=''; this.label=String((this.getStatus()||{}).label||'Friend').slice(0,40);
      const client=await this._client();
      await new Promise((resolve,reject)=>{
        let timer=setTimeout(()=>reject(Error('No cast source found. Check that it is online and that tracker access is available.')),30000);
        const xt=u.searchParams.get('xt');if(!/^urn:btih:[a-f\d]{40}$/i.test(xt||''))return reject(Error('Magnet must contain a valid BitTorrent infohash.'));
        const clean='magnet:?xt='+xt+this.trackers.map(x=>'&tr='+encodeURIComponent(x)).join('');
        const t=client.add(clean,{store:MemoryStore,storeCacheSlots:0,destroyStoreOnDestroy:true},torrent=>{
          this.torrent=torrent; torrent.on('error',reject);
          (async()=>{try { if(torrent.files.length!==1||torrent.length>32832||torrent.files[0].length>32832)throw Error('Invalid cast descriptor size.'); const bytes=new Uint8Array(await torrent.files[0].arrayBuffer()); if(bytes.length<29||bytes.length>32832)throw Error('Invalid cast descriptor size.'); const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},await crypto.subtle.importKey('raw',this.key,'AES-GCM',false,['decrypt']),bytes.slice(12)); const d=JSON.parse(decoder.decode(plain)); if(!d||!configOK(d.config))throw Error('Unsupported cast descriptor.'); this.config=d.config; clearTimeout(timer); await Promise.resolve(this.onSession(this.config)); this.sessionReady=true; this._start(); resolve(this.config); } catch(e){reject(Error('Unable to unlock this cast descriptor: '+e.message));} })();
        });this.torrent=t; t.on('error',reject); t.on('wire',w=>this._attach(w));
      });
    }
    _start(){ this._recover(); if(this.timer)clearInterval(this.timer); this.timer=setInterval(()=>{this._statusTick();},1000); this._statusTick(); this.torrent?.on('wire',w=>this._attach(w)); for(const s of this.wires.values())if(s.auth)this._assign(s); }
    _attach(w){ if(this.closed||this.wires.has(w))return; if(this.wires.size>=12){w.destroy();return;} const state={wire:w,auth:false,remote:null,challenge:b64(rand(24)),peerId:id(),last:0}; this.wires.set(w,state);
      const self=this;
      function Extension(wire){this.wire=wire; this.name=EXT; this.onExtendedHandshake=()=>self._send(state,{type:'_pc_hello',challenge:state.challenge,...self._status()}); this.onMessage=buf=>{self._message(state,buf).catch(e=>self._fail(e));};}
      Extension.prototype.name=EXT;
      try{w.use(Extension); w.on('close',()=>this._drop(state)); w.on('error',e=>this._fail(e));}catch(e){this._fail(e);}
    }
    _send(s,m){ if(!s.wire?.extended) return; const json=encoder.encode(JSON.stringify(m)); if(json.length<=4096){const b=new Uint8Array(json.length+1);b[0]=0;b.set(json,1);try{s.wire.extended(EXT,b);}catch(e){this._fail(e);}} }
    async _message(s,buf){
      if(!buf?.length)throw Error('Invalid private cast control message.');
      const kind=buf[0], body=buf.subarray(1);
      if(kind===1){if(s.auth&&s.adapter)s.adapter.onmessage?.({data:decoder.decode(body)});return;}
      if(kind===2){if(s.auth&&s.adapter)s.adapter.onmessage?.({data:body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength)});return;}
      if(kind!==0)throw Error('Invalid private cast frame.');
      if(body.length>4096)throw Error('Invalid private cast control message.');
      const m=JSON.parse(decoder.decode(body)); if(typeof m.type!=='string'||!m.type.startsWith('_pc_'))throw Error('Invalid private cast control message.');
      if(m.type==='_pc_hello'){
        if(typeof m.challenge!=='string'||m.challenge.length>100||!this._validStatus(m))return;
        s.remote=m; const proof=b64(await this._mac(m.challenge+'|'+this.node)); this._send(s,{type:'_pc_auth',proof,challenge:s.challenge,...this._status()}); return;
      }
      if(m.type==='_pc_auth'){
        if(!s.remote||!await crypto.subtle.verify('HMAC',this.hmac,un64(m.proof),encoder.encode(s.challenge+'|'+s.remote.nodeId)))return;
        s.auth=true; s.remote={...s.remote,...m}; this._send(s,{type:'_pc_ready',proof:b64(await this._mac(s.remote.challenge+'|'+this.node))}); this._assign(s); return;
      }
      if(m.type==='_pc_ready'){
        if(!s.remote||!await crypto.subtle.verify('HMAC',this.hmac,un64(m.proof),encoder.encode(s.challenge+'|'+s.remote.nodeId)))return;
        s.auth=true; this._assign(s); return;
      }
      if(!s.auth)return;
      if(m.type==='_pc_status'){
        if(!this._validStatus(m))return;
        s.remote={...s.remote,...m};
        if(this.parent===s){
          if(s.remote.trail.includes(this.node)||s.remote.trail.length>=12){s.wire.destroy();return;}
          this._topology();
        }
        this._assign(s);
      } else if(m.type==='_pc_offer'){
        const mine=this._status();
        const reserved=[...this.wires.values()].filter(p=>p.pendingNonce&&p.pendingUntil>Date.now()&&!p.opened).length;
        if(!this._validStatus(m)||s.opened||!mine.rooted||!mine.clockReady||mine.downCount+reserved>=2||mine.trail.length>=12||mine.trail.includes(s.remote.nodeId)){
          this._send(s,{type:'_pc_reject',nonce:m.nonce});return;
        }
        s.remote={...s.remote,...m}; s.pendingNonce=m.nonce; s.pendingUntil=Date.now()+5000;
        this._send(s,{type:'_pc_accept',nonce:s.pendingNonce,...mine});
      } else if(m.type==='_pc_accept'&&s.request&&this.parentRequest===s&&m.nonce===s.requestNonce){
        const accepted={...s.remote,...m};
        if(!this._validStatus(accepted)||!this._rooted(accepted)||accepted.trail.includes(this.node)||accepted.trail.length>=12){this._releaseRequest(s);return;}
        s.remote=accepted; s.direction='up'; this._open(s); this._send(s,{type:'_pc_confirm',nonce:m.nonce});
      } else if(m.type==='_pc_confirm'&&s.pendingNonce===m.nonce&&s.pendingUntil>Date.now()){
        const mine=this._status();s.pendingNonce=null;
        if(!mine.rooted||mine.trail.includes(s.remote.nodeId)||mine.downCount>=2){this._send(s,{type:'_pc_reject',nonce:m.nonce});return;}
        s.direction='down'; this._open(s);
      } else if(m.type==='_pc_reject'&&m.nonce===s.requestNonce){if(this.parent===s)s.wire.destroy();else if(this.parentRequest===s)this._releaseRequest(s);}
    }
    _validStatus(m){return typeof m.nodeId==='string'&&m.nodeId.length<100&&m.nodeId!==this.node&&Array.isArray(m.trail)&&m.trail.length<=12&&m.trail.every(x=>typeof x==='string'&&x.length<100)&&new Set(m.trail).size===m.trail.length&&!m.trail.includes(m.nodeId);}
    _releaseRequest(s){s.request=false;s.retryAfter=Date.now()+5000;if(this.parentRequest===s)this.parentRequest=null;}
    _assign(s){
      if(!this.sessionReady||!s.auth||!s.remote||this.role==='source'||this.parent||this.parentRequest||s.opened||s.retryAfter>Date.now())return;
      this._recover();const r=this.recovery;
      if(!r||r.state!=='searching'||Date.now()>=r.deadline||r.attempts>=8)return;
      const remote=s.remote,mine=this._status();
      if(this._validStatus(remote)&&this._rooted(remote)&&remote.clockReady&&Number(remote.downCount)<2&&!remote.trail.includes(this.node)&&remote.trail.length<12)this._request(s,mine);
    }
    _request(s,mine){const r=this.recovery;s.request=true;s.requestNonce=id();s.requestUntil=Date.now()+5000;this.parentRequest=s;r.attempts++;this.onRecovery({...r,recoveries:this.recoveries});this._send(s,{type:'_pc_offer',nonce:s.requestNonce,...mine});}
    _open(s){ if(s.opened)return;
      if(s.direction==='up'){if(this.role==='source'||this.parent){s.wire.destroy();return;}this.parent=s;this.parentRequest=null;s.request=false;this.clockReady=true;if(this.everParent)this.recoveries++;this.everParent=true;this.recovery={...this.recovery,state:'connected',lastRecoveredAt:Date.now()};this._topology();this.onRecovery({...this.recovery,recoveries:this.recoveries});}
      else {if(this.down>=2){s.wire.destroy();return;}this.down++;}
      s.opened=true;
      const owner=this,adapter={readyState:'open',get bufferedAmount(){const p=[...(owner.torrent?._peers?.values?.()||[])].find(x=>x.wire===s.wire);return Number(s.wire.readableLength||s.wire._readableState?.length||p?.conn?.channel?.bufferedAmount||p?.conn?._channel?.bufferedAmount||0);},onopen:null,onmessage:null,onclose:null,onerror:null,send:data=>{if(!s.auth||s.wire.destroyed)throw Error('Peer connection is closed.'); const kind=typeof data==='string'?1:2,raw=kind===1?encoder.encode(data):new Uint8Array(data);if(raw.length>65536)throw Error('Peer packet exceeds 64 KB.');const frame=new Uint8Array(raw.length+1);frame[0]=kind;frame.set(raw,1);s.wire.extended(EXT,frame);},close:()=>{s.wire.destroy();}};
      s.adapter=adapter; this.links.set(s,adapter); this.onPeer({id:s.remote.nodeId,label:String(s.remote.label||'Friend').slice(0,40),direction:s.direction,trail:(s.remote.trail||[]).concat(s.remote.nodeId).slice(-12),channel:adapter});
      queueMicrotask(()=>adapter.onopen?.()); this._broadcast();
    }
    _broadcast(){const st=this._status();for(const s of this.wires.values())if(s.auth)this._send(s,{type:'_pc_status',...st});}
    _statusTick(){
      if(this.closed)return;
      const t=Date.now();
      for(const s of this.wires.values()){
        if(s.pendingNonce&&s.pendingUntil<t)s.pendingNonce=null;
        if(this.parentRequest===s&&s.requestUntil<t)this._releaseRequest(s);
      }
      const r=this.recovery;
      if(!this.parent&&r?.state==='searching'&&(t>=r.deadline||r.attempts>=8)&&!this.parentRequest){r.state='exhausted';this.onRecovery({...r,recoveries:this.recoveries});}
      this._broadcast();
      // Prefer the original source, then the shortest authenticated rooted path.
      const candidates=[...this.wires.values()].sort((a,b)=>(a.remote?.trail?.length??99)-(b.remote?.trail?.length??99));
      for(const s of candidates)this._assign(s);
    }
    _drop(s){
      if(!this.wires.has(s.wire))return;
      this.wires.delete(s.wire);this.links.delete(s);
      if(this.parentRequest===s)this._releaseRequest(s);
      if(s.opened){
        if(s.direction==='up'&&this.parent===s){this.parent=null;this._topology();this._recover(true);}
        if(s.direction==='down')this.down=Math.max(0,this.down-1);
        if(s.adapter){s.adapter.readyState='closed';s.adapter.onclose?.();}
      }
      this._broadcast();
      if(!this.closed)queueMicrotask(()=>this._statusTick());
    }
    _fail(e){ if(!this.closed)this.onError(e instanceof Error?e:Error(String(e))); }
    async close(){this.closed=true; clearInterval(this.timer); this.timer=null; for(const s of this.wires.values())try{s.wire.destroy();}catch{} this.wires.clear();this.links.clear();this.parent=null;this.parentRequest=null;this.down=0;this.sessionReady=false; if(this.torrent&&!this.torrent.destroyed){try{await Promise.race([new Promise(resolve=>this.torrent.destroy({destroyStore:true},resolve)),new Promise(resolve=>setTimeout(resolve,1500))]);}catch{}} if(this.client&&!this.client.destroyed){try{await Promise.race([new Promise(resolve=>this.client.destroy(resolve)),new Promise(resolve=>setTimeout(resolve,1500))]);}catch{}} this.torrent=null;this.client=null;this.config=null;this.hmac=null;this.key=null; }
  }
  window.CastMagnetTransport=MagnetTransport;
})();
