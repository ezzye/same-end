/* Bounded playback-only conversion of fragmented MP4 to conventional MP4.
 * Signed source bytes are never modified or forwarded in this representation.
 * Unsupported structures fail closed to the existing individual-file player. */
(function(root){
'use strict';
const MAX_PIECE=4*1024*1024,MAX_WINDOW=20*1024*1024,MAX_PIECES=12,MAX_SECONDS=24;
function reject(code){throw new Error(code);}
function bytes(value){return ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);}
function hex(a){let s='';for(const n of a)s+=n.toString(16).padStart(2,'0');return s;}
function parser(value){
 const b=bytes(value);if(b.length<16||b.length>MAX_PIECE)reject('size');const d=new DataView(b.buffer,b.byteOffset,b.byteLength);
 const u32=p=>{if(p<0||p+4>b.length)reject('bounds');return d.getUint32(p);};
 const u64=p=>{const n=u32(p)*4294967296+u32(p+4);if(!Number.isSafeInteger(n))reject('timestamp');return n;};
 const text=p=>String.fromCharCode(...b.subarray(p,p+4));
 function boxes(start,end){let p=start,out=[];if(start<0||end>b.length)reject('bounds');while(p<end){if(p+8>end||out.length>4096)reject('structure');const n=u32(p);if(n<8||p+n>end)reject('structure');out.push({p,n,t:text(p+4)});p+=n;}return out;}
 const children=x=>boxes(x.p+8,x.p+x.n),one=(xs,t)=>{const a=xs.filter(x=>x.t===t);if(a.length!==1)reject('structure');return a[0];};
 function timing(box){const v=b[box.p+8];if(v>1)reject('version');const scale=box.p+(v?28:20),dur=box.p+(v?32:24);if(dur+(v?8:4)>box.p+box.n)reject('structure');const timescale=u32(scale);if(!timescale)reject('timescale');return{timescale,dur,wide:!!v};}
 const top=boxes(0,b.length),ftyp=one(top,'ftyp'),moov=one(top,'moov');
 if(ftyp.p!==0||top.indexOf(moov)!==1)reject('structure');const mc=children(moov),mvhd=one(mc,'mvhd'),movie=timing(mvhd),mvex=one(mc,'mvex');
 if(mc.some(x=>!['mvhd','trak','mvex','udta','free'].includes(x.t)))reject('structure');
 const trex=new Map();for(const x of children(mvex)){if(x.t!=='trex'||x.n!==32)reject('structure');trex.set(u32(x.p+12),{idPos:x.p+12,description:u32(x.p+16),duration:u32(x.p+20),size:u32(x.p+24),flags:u32(x.p+28)});}
 const tracks=[];
 for(const trak of mc.filter(x=>x.t==='trak')){
  const tc=children(trak);if(tc.some(x=>x.t==='edts'))reject('edit-list');const tkhd=one(tc,'tkhd'),version=b[tkhd.p+8];if(version>1)reject('version');
  const idPos=tkhd.p+(version?28:20),id=u32(idPos),tkDur=tkhd.p+(version?36:28),mdia=one(tc,'mdia'),md=children(mdia),mdhd=one(md,'mdhd'),mt=timing(mdhd),handler=text(one(md,'hdlr').p+16);
  if(!['vide','soun'].includes(handler)||tracks.some(t=>t.handler===handler))reject('tracks');const stbl=one(children(one(md,'minf')),'stbl'),sc=children(stbl),stsd=one(sc,'stsd');
  for(const t of ['stts','stsc','stco']){const x=one(sc,t);if(u32(x.p+12)!==0)reject('not-fragmented');}
  if(u32(stsd.p+12)!==1)reject('description');const entry=boxes(stsd.p+16,stsd.p+stsd.n);if(entry.length!==1)reject('description');const defaults=trex.get(id);if(!defaults||defaults.description!==1)reject('defaults');
  const track={trak,stbl,stsd,id,idPos,trexIdPos:defaults.idPos,handler,samples:[],timescale:mt.timescale,tkDur,tkWide:!!version,mdDur:mt.dur,mdWide:mt.wide,description:hex(b.subarray(stsd.p+16,stsd.p+stsd.n)),defaults,ends:0};
  if(handler==='vide'){
   const sample=entry[0];if(!['avc1','avc3'].includes(sample.t)||sample.n<86)reject('codec');const avc=one(boxes(sample.p+86,sample.p+sample.n),'avcC'),p=avc.p+8,end=avc.p+avc.n;if(p+6>end)reject('codec');track.nalLength=(b[p+4]&3)+1;let q=p+6;track.parameterSets=[];
   const sets=n=>{for(let i=0;i<n;i++){if(q+2>end)reject('codec');const size=d.getUint16(q);q+=2;if(!size||q+size>end)reject('codec');track.parameterSets.push(hex(b.subarray(q,q+size)));q+=size;}};
   sets(b[p+5]&31);if(q>=end)reject('codec');sets(b[q++]);
   // Only avc3 can carry replacement parameter sets without another init.
   // Keep all other sample-entry bytes (including colour/layout metadata),
   // avcC codec/profile/length fields and optional extensions in the key.
   track.avc3=sample.t==='avc3';track.streamDescription=track.avc3?hex(b.subarray(sample.p+4,avc.p))+':'+hex(b.subarray(p,p+5))+':'+hex(b.subarray(q,end))+':'+hex(b.subarray(end,sample.p+sample.n)):track.description;
  }else if(entry[0].t!=='mp4a')reject('codec');tracks.push(track);
 }
 if(!tracks.some(t=>t.handler==='vide')||tracks.length>2||trex.size!==tracks.length)reject('tracks');
 const fragments=[];for(let i=2;i<top.length;i++){
  const moof=top[i];if(moof.t==='mfra'||moof.t==='free')continue;if(moof.t!=='moof')reject('structure');const mdats=[];while(top[i+1]?.t==='mdat')mdats.push(top[++i]);if(!mdats.length)reject('structure');
  const fs=children(moof),mfhd=one(fs,'mfhd'),patches=[],runs=[],seen=new Set();
  for(const traf of fs.filter(x=>x.t==='traf')){
   const ts=children(traf);if(ts.some(x=>!['tfhd','tfdt','trun'].includes(x.t)))reject('structure');const tfhd=one(ts,'tfhd'),flags=u32(tfhd.p+8)&0xffffff;
   if(!(flags&0x020000)||(flags&1)||(flags&0x010000)||(flags&~0x02003a))reject('addressing');const track=tracks.find(t=>t.id===u32(tfhd.p+12));if(!track||seen.has(track.id))reject('tracks');seen.add(track.id);
   let q=tfhd.p+16,def={...track.defaults};if(flags&2){if(u32(q)!==1)reject('description');q+=4;}if(flags&8){def.duration=u32(q);q+=4;}if(flags&16){def.size=u32(q);q+=4;}if(flags&32){def.flags=u32(q);q+=4;}if(q!==tfhd.p+tfhd.n)reject('structure');
   const tfdt=one(ts,'tfdt'),v=b[tfdt.p+8];if(v>1||tfdt.n!==(v?20:16))reject('timestamp');const start=v?u64(tfdt.p+12):u32(tfdt.p+12);let ticks=0,first=true;
   for(const trun of ts.filter(x=>x.t==='trun')){
    const f=u32(trun.p+8)&0xffffff,n=u32(trun.p+12);if(!(f&1)||(f&~0x705)||n<1||n>20000)reject('run');let pos=trun.p+16;const offsetPos=pos,offset=d.getInt32(pos);pos+=4;if(f&4)pos+=4;let data=moof.p+offset;runs.push({offsetPos,data});
    for(let s=0;s<n;s++){
     const durationPos=f&0x100?pos:null,duration=f&0x100?u32(pos):def.duration;if(f&0x100)pos+=4;const sizePos=f&0x200?pos:null,size=f&0x200?u32(pos):def.size;if(f&0x200)pos+=4;if(f&0x400)pos+=4;if(f&0x800)pos+=4;
     if(!duration||!size||!mdats.some(m=>data>=m.p+8&&data+size<=m.p+m.n))reject('sample');
     let idr=track.handler==='soun';if(track.handler==='vide'){
      let at=data,configurationChanged=false;while(at<data+size){if(at+track.nalLength>data+size)reject('nal');let len=0;for(let k=0;k<track.nalLength;k++)len=len*256+b[at+k];at+=track.nalLength;if(!len||at+len>data+size)reject('nal');const kind=b[at]&31;if(kind===5)idr=true;if((kind===7||kind===8)&&!track.parameterSets.includes(hex(b.subarray(at,at+len))))configurationChanged=true;at+=len;}
      // Configuration updates are retained byte-for-byte and accepted only on IDRs.
      if(configurationChanged&&!idr)reject('inband-config');if(first&&fragments.length===0&&!idr)reject('random-access');
     }
     if(track.samples.length>=20000)reject('size');track.samples.push({data,size,sizePos,duration,durationPos,start:start+ticks,sync:idr});first=false;ticks+=duration;data+=size;
    }if(pos!==trun.p+trun.n)reject('run');
   }
   if(track.lastDecodeEnd!==undefined&&start<track.lastDecodeEnd&&(track.lastDecodeEnd-start>track.timescale*.15||start<=track.lastSampleStart))reject('overlap');if(track.lastDecodeEnd===undefined&&start>track.timescale*.15)reject('timestamp');if(track.lastDecodeEnd!==undefined&&start-track.lastDecodeEnd>track.timescale*.15)reject('timeline');track.lastSampleStart=track.samples[track.samples.length-1].start;track.lastDecodeEnd=start+ticks;track.ends=Math.max(track.ends,start+ticks);patches.push({track,tfhd:tfhd.p+12,tfdt:tfdt.p+12,wide:!!v,start});
  }
  if(seen.size!==tracks.length)reject('tracks');fragments.push({moof,mdats,mfhd:mfhd.p+12,patches,runs});
 }
 if(!fragments.length||fragments.length>64)reject('structure');return{b,ftyp,moov,movie,tracks,fragments,children};
}
function compatible(a,b){return a.tracks.length===b.tracks.length&&a.tracks.every(t=>b.tracks.some(u=>u.handler===t.handler&&u.timescale===t.timescale&&u.description===t.description&&['description','duration','size','flags'].every(k=>u.defaults[k]===t.defaults[k])));}
function streamReference(parsed){return{tracks:parsed.tracks.map(t=>({handler:t.handler,timescale:t.timescale,description:t.streamDescription||t.description,defaults:{...t.defaults}}))};}
// The source representation remains untouched. Insert declared SPS/PPS into
// each IDR, then repair explicit sample sizes and every affected run address.
function streamFragment(parsed,fragment,moof,maxBytes){
 const insertions=[],view=new DataView(moof.buffer,moof.byteOffset,moof.byteLength);let added=0;
 const samples=parsed.tracks.flatMap(track=>track.samples.map(sample=>({track,sample}))).filter(({sample})=>fragment.mdats.some(m=>sample.data>=m.p+8&&sample.data+sample.size<=m.p+m.n)).sort((a,b)=>a.sample.data-b.sample.data);
 let previousEnd=0;
 for(const {track,sample} of samples){
  if(sample.data<previousEnd)reject('sample');previousEnd=sample.data+sample.size;
  if(track.handler!=='vide'||!track.avc3)continue;
  if(sample.sizePos===null)reject('run');if(!sample.sync)continue;
  const sets=track.parameterSets.map(h=>Uint8Array.from(h.match(/../g)||[],v=>parseInt(v,16)));let sawPPS=false;
  if(!sets.some(s=>(s[0]&31)===7)||!sets.some(s=>(s[0]&31)===8))reject('codec');
  for(const s of sets){const kind=s[0]&31;if(kind===8)sawPPS=true;else if(kind!==7||sawPPS)reject('codec');if(s.length>=256**track.nalLength)reject('nal');}
  const size=sets.reduce((n,s)=>n+track.nalLength+s.length,0);added+=size;if(added+fragment.moof.n+fragment.mdats.reduce((n,m)=>n+m.n,0)>maxBytes)reject('size');
  const prefix=new Uint8Array(size);let at=0;for(const s of sets){let n=s.length;for(let k=track.nalLength-1;k>=0;k--){prefix[at+k]=n%256;n=Math.floor(n/256);}at+=track.nalLength;prefix.set(s,at);at+=s.length;}
  if(sample.size+size>4294967295)reject('size');view.setUint32(sample.sizePos-fragment.moof.p,sample.size+size);insertions.push({at:sample.data,bytes:prefix});
 }
 for(const run of fragment.runs){const shift=insertions.reduce((n,x)=>n+(x.at<run.data?x.bytes.length:0),0),offset=run.data-fragment.moof.p+shift;if(offset>2147483647||offset< -2147483648)reject('addressing');view.setInt32(run.offsetPos-fragment.moof.p,offset);}
 return fragment.mdats.map(m=>{
  const local=insertions.filter(x=>x.at>=m.p+8&&x.at<m.p+m.n);if(!local.length)return parsed.b.slice(m.p,m.p+m.n);
  const out=new Uint8Array(m.n+local.reduce((n,x)=>n+x.bytes.length,0));let source=m.p,target=0;
  for(const x of local){out.set(parsed.b.subarray(source,x.at),target);target+=x.at-source;out.set(x.bytes,target);target+=x.bytes.length;source=x.at;}out.set(parsed.b.subarray(source,m.p+m.n),target);new DataView(out.buffer).setUint32(0,out.length);return out;
 });
}
function setTime(view,pos,wide,n){if(!Number.isSafeInteger(n)||n<0||(!wide&&n>4294967295))reject('timestamp');if(wide){view.setUint32(pos,Math.floor(n/4294967296));view.setUint32(pos+4,n%4294967296);}else view.setUint32(pos,n);}
function box(type,...parts){const length=8+parts.reduce((n,p)=>n+p.length,0);if(length>MAX_WINDOW)reject('size');const out=new Uint8Array(length),view=new DataView(out.buffer);view.setUint32(0,length);for(let i=0;i<4;i++)out[4+i]=type.charCodeAt(i);let at=8;for(const p of parts){out.set(p,at);at+=p.length;}return out;}
function table(type,rows){const body=new Uint8Array(8+rows.reduce((n,row)=>n+row.length*4,0)),d=new DataView(body.buffer);d.setUint32(4,rows.length);let p=8;for(const row of rows)for(const n of row){if(!Number.isSafeInteger(n)||n<0||n>4294967295)reject('timestamp');d.setUint32(p,n);p+=4;}return box(type,body);}
function progressive(reference,selected,start){
 const {b,children}=reference,copy=x=>b.slice(x.p,x.p+x.n),groups=[];let seconds=0;
 for(const track of reference.tracks){
  const samples=[];for(const {piece,parsed} of selected){const source=parsed.tracks.find(t=>t.handler===track.handler),offset=Math.round((piece.meta.start-start)*track.timescale/1000);for(const s of source.samples)samples.push({...s,at:offset+s.start,bytes:parsed.b.subarray(s.data,s.data+s.size)});}
  if(!samples.length||samples.length>20000)reject('sample');
  // Decode times are represented by stts. Preserve the signed source clock,
  // absorbing only the already-validated small capture gaps in the last sample.
  // A nonpositive step cannot be represented and fails closed.
  const runs=[];for(let i=0;i<samples.length;i++){const s=samples[i],duration=i+1<samples.length?samples[i+1].at-s.at:s.duration;if(duration<1||Math.abs(duration-s.duration)>track.timescale*.15)reject('timeline');s.delta=duration;const last=runs[runs.length-1];if(last&&last[1]===duration)last[0]++;else runs.push([1,duration]);}
  if(samples[0].at!==0)reject('timestamp');const ticks=samples.reduce((n,s)=>n+s.delta,0);seconds=Math.max(seconds,ticks/track.timescale);groups.push({track,samples,runs,ticks,offset:0});
 }
 const movieTicks=Math.ceil(seconds*reference.movie.timescale);
 function duration(x,position,wide,ticks){const result=copy(x);setTime(new DataView(result.buffer),position-x.p,wide,ticks);return result;}
 function rewrite(x,group){
  if(x.t==='mvhd')return duration(x,reference.movie.dur,reference.movie.wide,movieTicks);
  if(x.t==='trak'){group=groups.find(g=>g.track.trak.p===x.p);if(!group)reject('tracks');}
  if(x.t==='tkhd')return duration(x,group.track.tkDur,group.track.tkWide,Math.ceil(group.ticks*reference.movie.timescale/group.track.timescale));
  if(x.t==='mdhd')return duration(x,group.track.mdDur,group.track.mdWide,group.ticks);
  if(x.t==='stbl'){
   const {track,samples,runs}=group,stsd=copy(track.stsd);if(track.handler==='vide')stsd[23]=49; // avc3 -> avc1, matching checked in-band parameter sets.
   const sizeBody=new Uint8Array(12+samples.length*4),v=new DataView(sizeBody.buffer);v.setUint32(8,samples.length);samples.forEach((s,i)=>v.setUint32(12+i*4,s.size));
   const tables=[stsd,table('stts',runs),table('stsc',[[1,samples.length,1]]),box('stsz',sizeBody),table('stco',[[group.offset]])];
   if(track.handler==='vide')tables.push(table('stss',samples.flatMap((s,i)=>s.sync?[[i+1]]:[])));
   return box('stbl',...tables);
  }
  if(['moov','trak','mdia','minf'].includes(x.t))return box(x.t,...children(x).filter(c=>c.t!=='mvex').map(c=>rewrite(c,group)));
  return copy(x);
 }
 // First pass fixes metadata length; chunk offsets refer to the single mdat.
 const brands=new Uint8Array([105,115,111,109,0,0,2,0,105,115,111,109,105,115,111,50,97,118,99,49,109,112,52,49]),ftyp=box('ftyp',brands);
 let moov=rewrite(reference.moov),offset=ftyp.length+moov.length+8;for(const group of groups){group.offset=offset;offset+=group.samples.reduce((n,s)=>n+s.size,0);}if(offset>MAX_WINDOW)reject('size');moov=rewrite(reference.moov);
 const payload=groups.flatMap(g=>g.samples.map(s=>s.bytes)),mdat=box('mdat',...payload);return{parts:[ftyp,moov,mdat],seconds};
}
function assemble(pieces,{maxSeconds=16,maxBytes=MAX_WINDOW}={}){
 if(!Array.isArray(pieces)||!pieces.length||pieces.length>MAX_PIECES)return{ok:false,reason:'size'};
 maxSeconds=Math.min(MAX_SECONDS,Math.max(2,maxSeconds));maxBytes=Math.min(MAX_WINDOW,Math.max(MAX_PIECE,maxBytes));
 try{
  const first=pieces[0],start=first.meta?.start;if(!Number.isFinite(start))reject('timeline');let reference=null,total=0,end=start,previous=null,reason=null;const selected=[],lastEnds=new Map();
  for(const piece of pieces){
   const m=piece.meta;if(!m||!Number.isSafeInteger(m.seq)||!Number.isFinite(m.start)||!Number.isFinite(m.duration)||m.duration<100||m.duration>10000)reject('timeline');
   if(previous&&(m.seq!==previous.seq+1||Math.abs(m.start-(previous.start+previous.duration))>150)){reason='timeline';break;}
   if(selected.length&&m.start+m.duration-start>maxSeconds*1000+150)break;
   let parsed;try{parsed=parser(piece.buf);}catch(e){if(selected.length){reason=e.message;break;}throw e;}
   if(parsed.tracks.some(t=>t.ends/t.timescale>m.duration/1000+.15||t.ends/t.timescale<m.duration/1000-.25)){reason='timeline';break;}
   if(reference&&!compatible(reference,parsed)){reason='configuration';break;}reference=reference||parsed;
   if(total+parsed.b.length>maxBytes){reason='size';break;}let overlaps=false;for(const t of parsed.tracks){const offset=(m.start-start)/1000,previousEnd=lastEnds.get(t.handler);if(previousEnd!==undefined&&offset<previousEnd-.1)overlaps=true;}if(overlaps){reason='overlap';break;}for(const t of parsed.tracks)lastEnds.set(t.handler,(m.start-start)/1000+t.ends/t.timescale);total+=parsed.b.length;selected.push({piece,parsed});end=m.start+m.duration;previous=m;
  }
  if(!selected.length)return{ok:false,reason:reason||'short'};
  // Native file players on older iPads reject these independently fragmented
  // recordings, even fully downloaded. Build conventional sample tables for a
  // local file. This copies compressed samples; it never re-encodes the media.
  const presentation=progressive(reference,selected,start);
  const output=presentation.parts,movieEnd=presentation.seconds;
  return{ok:true,parts:output,start,end,mediaSeconds:movieEnd,pieceCount:selected.length,firstSeq:first.meta.seq,lastSeq:selected[selected.length-1].piece.meta.seq,reason};
 }catch(e){return{ok:false,reason:['size','bounds','structure','timestamp','version','timescale','edit-list','not-fragmented','description','defaults','tracks','codec','addressing','run','sample','nal','inband-config','random-access','timeline','overlap'].includes(e.message)?e.message:'structure'};}
}
function createStream(epoch,{maxBytes=MAX_WINDOW}={}){
 if(!Number.isFinite(epoch))return{append:()=>({ok:false,reason:'timestamp'}),snapshot:()=>({pieces:0,bytes:0})};
 maxBytes=Math.max(MAX_PIECE,Math.min(MAX_WINDOW,Math.floor(maxBytes)||MAX_WINDOW));
 let pieces=0,totalBytes=0,lastMeta=null,lastInput=null,lastOutput=null,lastInit=false,nextSequence=1,reference=null,handlers=null;
 const stableId=handler=>handler==='vide'?1:handler==='soun'?2:0;
 const failed=reason=>({ok:false,reason:['size','bounds','structure','timestamp','version','timescale','edit-list','not-fragmented','description','defaults','tracks','codec','addressing','run','sample','nal','inband-config','random-access','timeline','overlap','sequence'].includes(reason)?reason:'structure'});
 const join=parts=>{let size=0;for(const p of parts){size+=p.byteLength;if(size>maxBytes)reject('size');}const out=new Uint8Array(size);let pos=0;for(const p of parts){out.set(p,pos);pos+=p.byteLength;}return out.buffer;};
 return{
  append(piece){
   try{
    const m=piece?.meta;if(!m||!Number.isSafeInteger(m.seq)||m.seq<0||!Number.isFinite(m.start)||!Number.isFinite(m.duration)||m.duration<100||m.duration>10000)reject('timeline');
    if(lastMeta&&m.seq===lastMeta.seq){const candidate=bytes(piece.buf);if(m.start!==lastMeta.start||m.duration!==lastMeta.duration||candidate.length!==lastInput.length)return failed('sequence');for(let i=0;i<candidate.length;i++)if(candidate[i]!==lastInput[i])return failed('sequence');return{ok:true,bytes:lastOutput.slice(0).buffer,initIncluded:lastInit,pieceCount:pieces,totalBytes,idempotent:true};}
    if(!Number.isSafeInteger(pieces+1))reject('size');
    const discontinuity=lastMeta&&(m.seq!==lastMeta.seq+1||Math.abs(m.start-(lastMeta.start+lastMeta.duration))>150);
    const parsed=parser(piece.buf);if(parsed.tracks.some(t=>t.ends/t.timescale>m.duration/1000+.15||t.ends/t.timescale<m.duration/1000-.25))reject('timeline');
    // A recorder may start a new fragment just before its previous sample's
    // declared end. Keep every compressed sample and trim only the copied
    // explicit duration, so the decoder sees non-overlapping decode times.
    const durationFixes=new Map();for(const track of parsed.tracks){for(let i=1;i<track.samples.length;i++){
     const previous=track.samples[i-1],current=track.samples[i],overlap=previous.start+previous.duration-current.start;
     if(overlap<=0)continue;if(overlap>track.timescale*.15||current.start<=previous.start)reject('overlap');
     if(previous.durationPos===null)reject('run');durationFixes.set(previous.durationPos,current.start-previous.start);
    }}
    const nextHandlers=parsed.tracks.map(t=>t.handler).sort();if(handlers&&(handlers.length!==nextHandlers.length||handlers.some((x,i)=>x!==nextHandlers[i])))reject('tracks');
    const nextReference=streamReference(parsed),newInit=!!discontinuity||!reference||!compatible(reference,nextReference);const parts=[];
    if(newInit){
     const ids=new Map(parsed.tracks.map(t=>[t.handler,stableId(t.handler)]));if([...ids.values()].some(id=>!id))reject('tracks');
     const ftyp=parsed.b.slice(parsed.ftyp.p,parsed.ftyp.p+parsed.ftyp.n),moov=parsed.b.slice(parsed.moov.p,parsed.moov.p+parsed.moov.n),d=new DataView(moov.buffer,moov.byteOffset,moov.byteLength);
     for(const track of parsed.tracks){const id=ids.get(track.handler);d.setUint32(track.idPos-parsed.moov.p,id);d.setUint32(track.trexIdPos-parsed.moov.p,id);}
     parts.push(ftyp,moov);
    }
    let sequence=nextSequence;
    for(const fragment of parsed.fragments){if(sequence>4294967295)reject('sequence');
     const moof=parsed.b.slice(fragment.moof.p,fragment.moof.p+fragment.moof.n),d=new DataView(moof.buffer,moof.byteOffset,moof.byteLength);d.setUint32(fragment.mfhd-fragment.moof.p,sequence++);
     for(const [pos,duration] of durationFixes)if(pos>=fragment.moof.p&&pos<fragment.moof.p+fragment.moof.n)d.setUint32(pos-fragment.moof.p,duration);
     for(const patch of fragment.patches){const id=stableId(patch.track.handler),base=Math.round((m.start-epoch)*patch.track.timescale/1000)+patch.start;d.setUint32(patch.tfhd-fragment.moof.p,id);setTime(d,patch.tfdt-fragment.moof.p,patch.wide,base);}
     parts.push(moof,...streamFragment(parsed,fragment,moof,maxBytes));
    }
    const output=join(parts);pieces++;totalBytes+=output.byteLength;lastMeta={seq:m.seq,start:m.start,duration:m.duration};lastInput=bytes(piece.buf).slice();lastOutput=new Uint8Array(output).slice();lastInit=newInit;nextSequence=sequence;handlers=nextHandlers;reference=nextReference;
    return{ok:true,bytes:output,initIncluded:newInit,pieceCount:pieces,totalBytes};
   }catch(e){return failed(e.message);}
  },
  snapshot(){return{pieces,bytes:totalBytes,nextSequence,trackIds:handlers?Object.fromEntries(handlers.map(h=>[h,stableId(h)])):null};}
 };
}
root.SameEndNativeMP4={assemble,createStream,inspect:value=>{try{const p=parser(value);return{ok:true,tracks:p.tracks.map(t=>({handler:t.handler,id:t.id,timescale:t.timescale,seconds:t.ends/t.timescale})),fragments:p.fragments.length};}catch(e){return{ok:false,reason:e.message};}}};
})(window);
