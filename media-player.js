/* Signed, independently playable pieces stay on the peers. No server conversion.
 * MP4/H.264 + AAC is preferred so older Apple browsers can join the same cast.
 */
(() => {
  'use strict';
  // 720p at25fps needs H.264 level3.1; level3.0 underspecifies capture.
  const MP4_AUDIO='video/mp4;codecs=avc1.42001f,mp4a.40.2';
  const MP4_VIDEO='video/mp4;codecs=avc1.42001f';
  const MIMES=[MP4_AUDIO,MP4_VIDEO,'video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8,opus','video/webm;codecs=vp8'];
  const allowedMime=m=>MIMES.includes(m);
  function recordingMime(audio){
    if(!window.MediaRecorder)return null;
    const choices=audio?[MP4_AUDIO,'video/mp4','video/webm;codecs=vp8,opus']:[MP4_VIDEO,'video/mp4','video/webm;codecs=vp8'];
    return choices.find(m=>MediaRecorder.isTypeSupported(m))||null;
  }
  function sourceConstructor(mime){
    return [window.MediaSource,window.ManagedMediaSource].find(C=>C&&typeof C.isTypeSupported==='function'&&C.isTypeSupported(mime));
  }
  function canPlay(mime,video=document.createElement('video')){
    return allowedMime(mime)&&!!(sourceConstructor(mime)||video.canPlayType(mime));
  }
  class Player {
    constructor(video,mime,{onError=()=>{},onMode=()=>{}}={}){
      if(!canPlay(mime,video))throw Error('This browser cannot play this cast. Ask the host to start a fresh room in updated Chrome, Edge or Safari so it uses iPhone-compatible MP4.');
      this.video=video;this.mime=mime;this.onError=onError;this.onMode=onMode;
      this.queue=[];this.queueBytes=0;this.pieces=[];this.pieceBytes=0;this.urls=new Map();this.mode='clips';this.closed=false;this.blocked=false;this.current=null;this.loading=false;this.duration=0;this.demand=true;this.lastRepair=0;
      video.setAttribute('playsinline','');video.setAttribute('webkit-playsinline','');
      // Required for iPhone ManagedMediaSource without a separate AirPlay URL.
      video.disableRemotePlayback=true;video.preload='auto';video.autoplay=true;
      this.onVideoError=()=>{if(this.closed)return;if(this.mode==='mse')this.fallback('Streaming buffer unavailable; using compatibility playback.');else this.onError('This device could not decode the picture. Ask the host to start a new room using MP4 in updated Chrome, Edge or Safari.');};
      video.addEventListener('error',this.onVideoError);
      const C=sourceConstructor(mime);
      if(C){
        this.mode='mse';this.source=new C();this.sourceURL=URL.createObjectURL(this.source);
        this.source.addEventListener('sourceopen',()=>{if(this.closed||this.mode!=='mse')return;clearTimeout(this.openTimer);try{
          this.sb=this.source.addSourceBuffer(mime);this.sb.mode='segments';
          this.sb.addEventListener('updateend',()=>this.pump());
          this.sb.addEventListener('error',()=>this.fallback('Using compatibility playback after a buffer error.'));
          this.pump();
        }catch(e){this.fallback('Using compatibility playback for this browser.');}},{once:true});
        this.source.addEventListener('startstreaming',()=>{this.demand=true;this.pump();});
        this.source.addEventListener('endstreaming',()=>{this.demand=false;});
        video.src=this.sourceURL;
        this.openTimer=setTimeout(()=>{if(!this.sb)this.fallback('Using compatibility playback for this browser.');},5000);
      }
      this.onMode(this.mode);
    }
    fallback(message){
      if(this.closed||this.mode==='clips')return;
      if(!this.video.canPlayType(this.mime)){this.onError('This browser cannot play this cast format. Ask the host to start a fresh MP4 room in updated Chrome, Edge or Safari.');return;}
      clearTimeout(this.openTimer);this.mode='clips';this.sb=null;this.queue=[];this.queueBytes=0;
      this.video.pause();this.video.removeAttribute('src');this.video.load();
      if(this.sourceURL)URL.revokeObjectURL(this.sourceURL);this.sourceURL=null;this.source=null;
      this.onMode(this.mode,message);
    }
    enqueue(piece,epoch){
      if(this.closed)return;
      this.epoch=epoch;this.pieces.push(piece);this.pieceBytes+=piece.buf.byteLength;
      while(this.pieces.length>24||this.pieceBytes>20*1024*1024)this.pieceBytes-=this.pieces.shift().buf.byteLength;
      if(this.mode==='mse'){this.queue.push(piece);this.queueBytes+=piece.buf.byteLength;while(this.queue.length>20||this.queueBytes>20*1024*1024)this.queueBytes-=this.queue.shift().buf.byteLength;this.pump();}
    }
    pump(){
      const sb=this.sb;if(this.closed||this.mode!=='mse'||!sb||sb.updating||!this.demand||!this.queue.length)return;
      try{
        const t=this.video.currentTime;
        if(t>18&&sb.buffered.length&&sb.buffered.start(0)<t-14){sb.remove(0,t-12);return;}
        const piece=this.queue.shift();this.queueBytes-=piece.buf.byteLength;sb.timestampOffset=(piece.meta.start-this.epoch)/1000;sb.appendBuffer(piece.buf);
      }catch(e){this.fallback('Using compatibility playback after a buffer error.');}
    }
    urlFor(piece){
      if(!this.urls.has(piece.meta.seq))this.urls.set(piece.meta.seq,URL.createObjectURL(new Blob([piece.buf],{type:this.mime})));
      for(const [seq,url] of this.urls)if(seq!==piece.meta.seq&&!this.pieces.some(p=>p.meta.seq===seq)){URL.revokeObjectURL(url);this.urls.delete(seq);}
      return this.urls.get(piece.meta.seq);
    }
    sync(target){
      const v=this.video;
      if(target>=0){const cutoff=this.epoch+target*1000-4000;this.pieces=this.pieces.filter(p=>p.meta.start+p.meta.duration>=cutoff);this.pieceBytes=this.pieces.reduce((n,p)=>n+p.buf.byteLength,0);this.queue=this.queue.filter(p=>p.meta.start+p.meta.duration>=cutoff);this.queueBytes=this.queue.reduce((n,p)=>n+p.buf.byteLength,0);}
      if(target<0){v.pause();return {waiting:true,drift:null};}
      let localTarget=target,inRange=false;
      if(this.mode==='mse'){
        if(!this.sb)return {waiting:true,drift:null};
        for(let i=0;i<v.buffered.length;i++)if(target>=v.buffered.start(i)&&target<v.buffered.end(i)-.04)inRange=true;
        // Managed buffers may evict data independently. Repair from our verified
        // bounded piece cache without changing the shared playback clock.
        if(!inRange&&!this.sb.updating&&Date.now()-this.lastRepair>1200){const absolute=this.epoch+target*1000,piece=this.pieces.find(p=>absolute>=p.meta.start&&absolute<p.meta.start+p.meta.duration);if(piece&&!this.queue.some(p=>p.meta.seq===piece.meta.seq)){this.lastRepair=Date.now();this.queue.unshift(piece);this.queueBytes+=piece.buf.byteLength;while(this.queue.length>20||this.queueBytes>20*1024*1024)this.queueBytes-=this.queue.pop().buf.byteLength;this.pump();}}
      }else{
        const absolute=this.epoch+target*1000;
        const piece=this.pieces.find(p=>absolute>=p.meta.start&&absolute<p.meta.start+p.meta.duration);
        if(!piece){v.pause();return {waiting:true,drift:null};}
        localTarget=(absolute-piece.meta.start)/1000;
        if(this.current!==piece.meta.seq){
          this.current=piece.meta.seq;this.duration=piece.meta.duration/1000;
          v.src=this.urlFor(piece);v.load();
          // Keep a single media element: older iOS can stop one video when another
          // starts, and audio permission belongs to the element the user tapped.
          this.play().catch(()=>{});
        }
        // Some browsers initially expose only the first MP4 fragment duration.
        // Pausing against that growing duration deadlocks otherwise valid clips.
        inRange=v.readyState>=2&&localTarget<this.duration-.025;
      }
      if(!inRange){v.pause();return {waiting:true,drift:null};}
      const drift=localTarget-v.currentTime;
      try{if(Math.abs(drift)>.3)v.currentTime=localTarget;else v.playbackRate=1+Math.max(-.025,Math.min(.025,drift*.08));}catch(e){return {waiting:true,drift:null};}
      this.play().catch(()=>{});
      return {waiting:false,drift,playing:!v.paused};
    }
    // Decoded programme position, including the source-relative offset in clip mode.
    // This deliberately differs from a desired clock target: tests need actual playout.
    programTime(){
      if(this.closed||this.video.readyState<2)return null;
      if(this.mode==='mse')return this.video.currentTime;
      const piece=this.pieces.find(p=>p.meta.seq===this.current);
      return piece?(piece.meta.start-this.epoch)/1000+this.video.currentTime:null;
    }
    // Call synchronously from a click: iOS sound permission cannot be acquired
    // later from a timer or loadedmetadata callback.
    play(){const result=this.video.play();return Promise.resolve(result).then(()=>{this.blocked=false;},error=>{if(error.name==='NotAllowedError')this.blocked=true;throw error;});}
    close(){
      this.closed=true;clearTimeout(this.openTimer);this.video.removeEventListener('error',this.onVideoError);
      this.video.pause();this.video.removeAttribute('src');this.video.load();
      if(this.sourceURL)URL.revokeObjectURL(this.sourceURL);
      for(const url of this.urls.values())URL.revokeObjectURL(url);
      this.urls.clear();this.queue=[];this.queueBytes=0;this.pieces=[];this.pieceBytes=0;this.sb=null;this.source=null;
    }
  }
  window.SameEndMedia={allowedMime,recordingMime,canPlay,Player};
})();
