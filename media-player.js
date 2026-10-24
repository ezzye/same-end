/* Signed, independently playable pieces stay on the peers. No server conversion.
 * MP4/H.264 + AAC is preferred so older Apple browsers can join the same cast.
 */
(() => {
  'use strict';
  // 720p at25fps needs H.264 level3.1; level3.0 underspecifies capture.
  // Tab capture may change size while recording (including fullscreen changes).
  // avc3 carries updated H.264 parameter sets in-band; avc1 only writes the
  // initial configuration and can fail Mac hardware decoding after a resize.
  const MP4_AUDIO='video/mp4;codecs=avc3.42001f,mp4a.40.2';
  const MP4_VIDEO='video/mp4;codecs=avc3.42001f';
  const MP4_AUDIO_LEGACY='video/mp4;codecs=avc1.42001f,mp4a.40.2';
  const MP4_VIDEO_LEGACY='video/mp4;codecs=avc1.42001f';
  const MIMES=[MP4_AUDIO,MP4_VIDEO,MP4_AUDIO_LEGACY,MP4_VIDEO_LEGACY,'video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8,opus','video/webm;codecs=vp8'];
  const allowedMime=m=>MIMES.includes(m);
  function nativeMime(mime,video){
    if(video.canPlayType(mime))return mime;
    const legacy=mime.replace('codecs=avc3.','codecs=avc1.');
    return legacy!==mime&&video.canPlayType(legacy)?legacy:null;
  }
  // Some native Apple players accept H.264 but reject the avc3 sample-entry
  // label. Relabel only MP4 headers on a playback copy, retaining all encoded
  // parameter sets, audio, timing and the original signed/forwarded bytes.
  function nativeMP4(buffer){
    const bytes=ArrayBuffer.isView(buffer)?new Uint8Array(buffer.buffer,buffer.byteOffset,buffer.byteLength):new Uint8Array(buffer);
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),edits=[];
    const text=p=>String.fromCharCode(...bytes.subarray(p,p+4));
    function walk(start,end,depth){
      if(depth>8)return false;
      for(let p=start;p<end;){
        if(p+8>end)return false;const size=view.getUint32(p),type=text(p+4);
        if(size<8||p+size>end)return false;
        if(type==='ftyp'){for(let q=p+8;q+4<=p+size;q+=4)if(q!==p+12&&text(q)==='avc3')edits.push(q);}
        else if(['moov','trak','mdia','minf','stbl'].includes(type)){if(!walk(p+8,p+size,depth+1))return false;}
        else if(type==='stsd'){
          if(size<16)return false;let q=p+16;const count=view.getUint32(p+12);if(count>32)return false;
          for(let n=0;n<count;n++){if(q+8>p+size)return false;const length=view.getUint32(q);if(length<8||q+length>p+size)return false;if(text(q+4)==='avc3')edits.push(q+4);q+=length;}
        }
        p+=size;
      }return true;
    }
    if(!walk(0,bytes.length,0)||!edits.length)return buffer;
    const copy=bytes.slice();for(const offset of edits)copy[offset+3]=49;return copy;
  }
  function recordingMime(audio){
    if(!window.MediaRecorder)return null;
    const choices=audio?[MP4_AUDIO,MP4_AUDIO_LEGACY,'video/mp4','video/webm;codecs=vp8,opus']:[MP4_VIDEO,MP4_VIDEO_LEGACY,'video/mp4','video/webm;codecs=vp8'];
    return choices.find(m=>MediaRecorder.isTypeSupported(m)&&(sourceConstructor(m)||document.createElement('video').canPlayType(m)))||null;
  }
  function sourceConstructor(mime){
    return [window.MediaSource,window.ManagedMediaSource].find(C=>C&&typeof C.isTypeSupported==='function'&&C.isTypeSupported(mime));
  }
  function canPlay(mime,video=document.createElement('video')){
    return allowedMime(mime)&&!!(sourceConstructor(mime)||nativeMime(mime,video));
  }
  class Player {
    constructor(video,mime,{onError=()=>{},onMode=()=>{}}={}){
      if(!canPlay(mime,video))throw Error('This browser cannot play this cast. Ask the host to start a fresh room in updated Chrome, Edge or Safari so it uses iPhone-compatible MP4.');
      this.video=video;this.mime=mime;this.nativeWindow=null;this.playbackMetrics={srcChanges:0,lastLoadMs:null,firstFrameMs:null};this.nativeMime=nativeMime(mime,video);this.nativeBlobType=mime.startsWith('video/mp4')?'video/mp4':(this.nativeMime||mime);this.onError=onError;this.onMode=onMode;
      this.queue=[];this.queueBytes=0;this.pieces=[];this.pieceBytes=0;this.urls=new Map();this.mode='clips';this.fallbackReason='unsupported-mse';this.mediaErrorCode=null;this.closed=false;this.blocked=false;this.current=null;this.loading=false;this.duration=0;this.demand=true;this.lastRepair=0;
      video.setAttribute('playsinline','');video.setAttribute('webkit-playsinline','');
      // Required for iPhone ManagedMediaSource without a separate AirPlay URL.
      video.disableRemotePlayback=true;video.preload='auto';video.autoplay=true;
      this.onVideoError=()=>{if(this.closed)return;const code=video.error?.code;this.mediaErrorCode=Number.isInteger(code)&&code>=1&&code<=4?code:null;if(this.nativeWindow){this.nativeJoinDisabled=true;this.packagingReason='decode';URL.revokeObjectURL(this.nativeWindow.url);this.nativeWindow=null;this.current=null;this.video.pause();this.video.removeAttribute('src');this.video.load();this.onMode('clips','Using individual pieces after a compatibility-window decode error.');return;}if(this.mode==='mse')this.fallback('Streaming buffer unavailable; using compatibility playback.','decode-error');else this.onError('This device could not decode the picture. Ask the host to start a new room using MP4 in updated Chrome, Edge or Safari.');};
      video.addEventListener('error',this.onVideoError);this.onFirstFrame=()=>{if(this.loadStartedAt!==undefined&&this.playbackMetrics.firstFrameMs===null&&video.readyState>=2)this.playbackMetrics.firstFrameMs=Math.max(0,Date.now()-this.loadStartedAt);};video.addEventListener('loadeddata',this.onFirstFrame);
      const C=sourceConstructor(mime);
      if(C){
        this.mode='mse';this.fallbackReason=null;this.source=new C();this.sourceURL=URL.createObjectURL(this.source);
        this.source.addEventListener('sourceopen',()=>{if(this.closed||this.mode!=='mse')return;clearTimeout(this.openTimer);try{
          this.sb=this.source.addSourceBuffer(mime);this.sb.mode='segments';
          this.sb.addEventListener('updateend',()=>this.pump());
          this.sb.addEventListener('error',()=>this.fallback('Using compatibility playback after a buffer error.','buffer-error'));
          this.pump();
        }catch(e){this.fallback('Using compatibility playback for this browser.','buffer-open');}},{once:true});
        this.source.addEventListener('startstreaming',()=>{this.demand=true;this.pump();});
        this.source.addEventListener('endstreaming',()=>{this.demand=false;});
        video.src=this.sourceURL;
        this.openTimer=setTimeout(()=>{if(!this.sb)this.fallback('Using compatibility playback for this browser.','open-timeout');},5000);
      }
      this.onMode(this.mode);
    }
    fallback(message,reason='unknown'){
      if(this.closed||this.mode==='clips')return;
      if(!this.nativeMime){this.onError('This browser cannot play this cast format. Ask the host to start a fresh MP4 room in updated Chrome, Edge or Safari.');return;}
      clearTimeout(this.openTimer);this.mode='clips';this.fallbackReason=reason;this.sb=null;this.queue=[];this.queueBytes=0;
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
      }catch(e){this.fallback('Using compatibility playback after a buffer error.','buffer-append');}
    }
    urlFor(piece){
      if(!this.urls.has(piece.meta.seq))this.urls.set(piece.meta.seq,URL.createObjectURL(new Blob([this.nativeMime!==this.mime?nativeMP4(piece.buf):piece.buf],{type:this.nativeBlobType})));
      for(const [seq,url] of this.urls)if(seq!==piece.meta.seq&&!this.pieces.some(p=>p.meta.seq===seq)){URL.revokeObjectURL(url);this.urls.delete(seq);}
      return this.urls.get(piece.meta.seq);
    }
    lookAheadSeconds(){return this.mode==='clips'&&!this.nativeJoinDisabled&&window.SameEndNativeMP4&&this.mime.startsWith('video/mp4')?22:4;}
    // Make a complete local presentation from matching verified pieces. One
    // video element retains its sound permission; no duplicate audio players.
    loadNative(piece){
      let joined=null;
      if(!this.nativeJoinDisabled&&window.SameEndNativeMP4&&this.mime.startsWith('video/mp4')){
        const candidates=this.pieces.filter(p=>p.meta.seq>=piece.meta.seq).sort((a,b)=>a.meta.seq-b.meta.seq).slice(0,12);
        joined=window.SameEndNativeMP4.assemble(candidates,{maxSeconds:16});
      }
      if(!this.nativeJoinDisabled)this.packagingReason=joined?.ok?joined.reason:(joined?.reason||null);
      if(this.nativeWindow){URL.revokeObjectURL(this.nativeWindow.url);this.nativeWindow=null;}
      let url;
      if(joined?.ok){
        let parts=joined.parts;
        if(this.nativeMime!==this.mime){const length=parts.reduce((n,b)=>n+b.byteLength,0),copy=new Uint8Array(length);let pos=0;for(const part of parts){copy.set(part,pos);pos+=part.byteLength;}parts=[nativeMP4(copy)];}
        url=URL.createObjectURL(new Blob(parts,{type:this.nativeBlobType}));
        this.nativeWindow={url,start:joined.start,end:joined.end,pieceCount:joined.pieceCount,mediaSeconds:joined.mediaSeconds};
      }else url=this.urlFor(piece);
      this.current=piece.meta.seq;this.duration=piece.meta.duration/1000;
      this.playbackMetrics.srcChanges++;this.playbackMetrics.firstFrameMs=null;this.loadStartedAt=Date.now();
      this.video.src=url;this.video.load();this.playbackMetrics.lastLoadMs=Math.max(0,Date.now()-this.loadStartedAt);
      this.play().catch(()=>{});
    }
    facts(){
      const v=this.video;let ahead=0;for(let i=0;i<v.buffered.length;i++)if(v.currentTime>=v.buffered.start(i)&&v.currentTime<v.buffered.end(i))ahead=v.buffered.end(i)-v.currentTime;
      const q=v.getVideoPlaybackQuality?.();return{mode:this.nativeWindow?'native-window':this.mode,fallbackReason:this.fallbackReason,packagingReason:this.packagingReason||null,errorCode:this.mediaErrorCode,width:v.videoWidth||0,height:v.videoHeight||0,playableAheadSeconds:ahead,windowSeconds:this.nativeWindow?(this.nativeWindow.end-this.nativeWindow.start)/1000:null,srcChanges:this.playbackMetrics.srcChanges,lastLoadMs:this.playbackMetrics.lastLoadMs,firstFrameMs:this.playbackMetrics.firstFrameMs,decodedFrames:q?.totalVideoFrames??v.webkitDecodedFrameCount??null,droppedFrames:q?.droppedVideoFrames??v.webkitDroppedFrameCount??null};
    }
    sync(target){
      const v=this.video;
      if(target>=0){const cutoff=this.epoch+target*1000-4000;this.pieces=this.pieces.filter(p=>p.meta.start+p.meta.duration>=cutoff);this.pieceBytes=this.pieces.reduce((n,p)=>n+p.buf.byteLength,0);this.queue=this.queue.filter(p=>p.meta.start+p.meta.duration>=cutoff);this.queueBytes=this.queue.reduce((n,p)=>n+p.buf.byteLength,0);}
      if(target<0){v.pause();return {waiting:true,drift:null};}
      let localTarget=target,inRange=false;
      if(this.mode==='mse'){
        if(!this.sb)return {waiting:true,drift:null};
        for(let i=0;i<v.buffered.length;i++){
          const start=v.buffered.start(i),end=v.buffered.end(i);
          if(target>=start&&target<end)inRange=true;
          // Independently recorded AAC/video can leave a few unencoded samples
          // between pieces. Do not deliberately pause or repeatedly seek back
          // into that hole. Skip only a bounded, already-buffered capture gap;
          // actual programme position still reports the decoded media clock.
          if(i>0&&target>=v.buffered.end(i-1)&&target<start&&start-v.buffered.end(i-1)<=.15){
            try{v.currentTime=start+.001;inRange=true;}catch{}
          }
        }
        // Managed buffers may evict data independently. Repair from our verified
        // bounded piece cache without changing the shared playback clock.
        if(!inRange&&!this.sb.updating&&Date.now()-this.lastRepair>1200){const absolute=this.epoch+target*1000,piece=this.pieces.find(p=>absolute>=p.meta.start&&absolute<p.meta.start+p.meta.duration);if(piece&&!this.queue.some(p=>p.meta.seq===piece.meta.seq)){this.lastRepair=Date.now();this.queue.unshift(piece);this.queueBytes+=piece.buf.byteLength;while(this.queue.length>20||this.queueBytes>20*1024*1024)this.queueBytes-=this.queue.pop().buf.byteLength;this.pump();}}
      }else{
        const absolute=this.epoch+target*1000;
        const withinWindow=this.nativeWindow&&absolute>=this.nativeWindow.start&&absolute<this.nativeWindow.end;
        if(!withinWindow){
          const piece=this.pieces.find(p=>absolute>=p.meta.start&&absolute<p.meta.start+p.meta.duration);
          if(!piece){v.pause();return {waiting:true,drift:null};}
          if(this.current!==piece.meta.seq||this.nativeWindow)this.loadNative(piece);
        }
        if(this.nativeWindow)localTarget=(absolute-this.nativeWindow.start)/1000;
        else{const piece=this.pieces.find(p=>p.meta.seq===this.current);if(!piece){v.pause();return{waiting:true,drift:null};}localTarget=(absolute-piece.meta.start)/1000;}
        inRange=v.readyState>=2&&!this.nativeWindow&&localTarget<this.duration-.025;
        if(this.nativeWindow&&v.readyState>=2){for(let i=0;i<v.buffered.length;i++){const start=v.buffered.start(i),end=v.buffered.end(i);if(localTarget>=start&&localTarget<end)inRange=true;else if(i>0&&localTarget>=v.buffered.end(i-1)&&localTarget<start&&start-v.buffered.end(i-1)<=.15){try{v.currentTime=start+.001;inRange=true;}catch{}}}}
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
      if(this.nativeWindow)return (this.nativeWindow.start-this.epoch)/1000+this.video.currentTime;
      const piece=this.pieces.find(p=>p.meta.seq===this.current);
      return piece?(piece.meta.start-this.epoch)/1000+this.video.currentTime:null;
    }
    // Call synchronously from a click: iOS sound permission cannot be acquired
    // later from a timer or loadedmetadata callback.
    play(){const result=this.video.play();return Promise.resolve(result).then(()=>{this.blocked=false;},error=>{if(error.name==='NotAllowedError')this.blocked=true;throw error;});}
    close(){
      this.closed=true;clearTimeout(this.openTimer);this.video.removeEventListener('error',this.onVideoError);this.video.removeEventListener('loadeddata',this.onFirstFrame);if(this.nativeWindow)URL.revokeObjectURL(this.nativeWindow.url);this.nativeWindow=null;
      this.video.pause();this.video.removeAttribute('src');this.video.load();
      if(this.sourceURL)URL.revokeObjectURL(this.sourceURL);
      for(const url of this.urls.values())URL.revokeObjectURL(url);
      this.urls.clear();this.queue=[];this.queueBytes=0;this.pieces=[];this.pieceBytes=0;this.sb=null;this.source=null;
    }
  }
  window.SameEndMedia={allowedMime,recordingMime,canPlay,nativeMP4,Player};
})();
