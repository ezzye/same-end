import test from 'node:test';
import assert from 'node:assert/strict';
import { VerifiedHlsCache, createVerifiedLoader, HLS_BASE, cachePath, Player } from '../hls-player.js';
const bytes = text => new TextEncoder().encode(text).buffer;
const media = (seq=0) => '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:'+seq+'\n#EXT-X-MAP:URI="init.mp4"\n'+Array.from({length:6},(_,i)=>'#EXTINF:2,\ns'+(i+seq)+'.m4s\n').join('');
function bundle(seq=0,start=0) { return {start:start+10,duration:2,playlistStart:start,files:[{path:'master.m3u8',bytes:bytes('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo.m3u8\n')},{path:'video.m3u8',bytes:bytes(media(seq))},{path:'init.mp4',bytes:bytes('init')},...Array.from({length:6},(_,i)=>({path:'s'+(i+seq)+'.m4s',bytes:bytes('segment'+(i+seq))}))]}; }
test('cache accepts only verified local namespace; URI traversal and every external route fail closed',()=>{
 for(const url of ['https://evil.test/a','file:///x',HLS_BASE+'../a',HLS_BASE+'%2e%2e/a',HLS_BASE+'a?x',HLS_BASE+'a#b',HLS_BASE+'/a'])assert.throws(()=>cachePath(url));
 for(const uri of ['https://evil.test/v.m3u8','//evil.test/v','../x','%2e%2e/x','data:x','blob:x','v?x']) { const c=new VerifiedHlsCache();const b=bundle();b.files[0].bytes=bytes('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n'+uri+'\n');assert.throws(()=>c.add(b));assert.equal(c.files.size,0); }
 for(const tag of ['#EXT-X-KEY:METHOD=AES-128,URI="key"','#EXT-X-CONTENT-STEERING:SERVER-URI="x"','#EXT-X-MAP:URI="https://evil.test/x"']){const c=new VerifiedHlsCache(),b=bundle();b.files[1].bytes=bytes(media()+tag+'\n');assert.throws(()=>c.add(b));}
});
test('sliding media sequence uses explicit playlist origin, bounds visible edge and rejects media replacement',()=>{
 const c=new VerifiedHlsCache({aheadSeconds:2});c.target=31;c.add(bundle(15,30),{epoch:1700000000000});assert.equal(c.timeline.get('s15.m4s').start,30);assert.equal(c.timeline.get('s20.m4s').end,42);
 const list=c.read(HLS_BASE+'video.m3u8');assert.match(list,/MEDIA-SEQUENCE:15/);assert.match(list,/s16.m4s/);assert.doesNotMatch(list,/s17.m4s/);
 const b=bundle(15,30);b.files.at(-1).bytes=bytes('tampered');assert.throws(()=>c.add(b),/changed/);
});
test('custom loader waits for peer delivery, supports ranges, aborts and rejects network without fetch',async()=>{
 const c=new VerifiedHlsCache(),Loader=createVerifiedLoader(c),loader=new Loader();let fetches=0;const old=global.fetch;global.fetch=()=>{fetches++;throw Error('network forbidden')};
 try {const result=new Promise((resolve,reject)=>loader.load({url:HLS_BASE+'s0.m4s',responseType:'arraybuffer',rangeStart:1,rangeEnd:4},{timeout:200},{onSuccess:resolve,onError:reject,onTimeout:()=>reject(Error('timeout'))}));await new Promise(r=>setTimeout(r,5));c.add(bundle());assert.equal(new TextDecoder().decode((await result).data),'egm');assert.equal(fetches,0);
 const denied=new Loader();await new Promise(resolve=>denied.load({url:'https://evil.test/media',responseType:'arraybuffer'},{timeout:200},{onSuccess:()=>assert.fail(),onError:e=>{assert.equal(e.code,403);resolve()},onTimeout:()=>assert.fail()}));
 const aborted=new Loader();aborted.load({url:HLS_BASE+'missing',responseType:'arraybuffer'},{timeout:20},{onSuccess:()=>assert.fail(),onError:()=>assert.fail(),onTimeout:()=>assert.fail()});aborted.abort();assert.equal(c.listeners.size,0);await new Promise(r=>setTimeout(r,30)); }finally{global.fetch=old;}
});
test('retention and byte ceiling retain bootstrap and recent media only',()=>{
 const c=new VerifiedHlsCache({maxBytes:4096,retainSeconds:12});c.add(bundle());c.add(bundle(200,400));assert(!c.files.has('s0.m4s'));assert(c.files.has('s200.m4s'));assert(c.files.has('init.mp4'));assert(c.bytes<=4096);assert(c.timeline.size<=6);
});
test('missing peer intervals keep the standard duration and sequence with EXT-X-GAP',()=>{
 const c=new VerifiedHlsCache();const b=bundle();b.files=b.files.filter(f=>f.path!=='s2.m4s');c.add(b);const list=c.read(HLS_BASE+'video.m3u8');assert.match(list,/#EXTINF:2,\n#EXT-X-GAP\ns2.m4s/);assert.equal((list.match(/#EXTINF:/g)||[]).length,6);assert.equal(c.timeline.get('s3.m4s').start,6);
});
test('hls.js zero range sentinel loads the full verified file',async()=>{
 const c=new VerifiedHlsCache();c.add(bundle());const Loader=createVerifiedLoader(c),loader=new Loader();const r=await new Promise((resolve,reject)=>loader.load({url:HLS_BASE+'s0.m4s',responseType:'arraybuffer',rangeStart:0,rangeEnd:0},{timeout:200},{onSuccess:resolve,onError:reject,onTimeout:()=>reject(Error('timeout'))}));assert.equal(new TextDecoder().decode(r.data),'segment0');
});
test('cached source ahead of delayed group never exposes its live edge',()=>{
 const c=new VerifiedHlsCache({aheadSeconds:12});c.target=31;
 for(let seq=0;seq<=170;seq+=5)c.add(bundle(seq,seq*2));
 // Last snapshot alone represents the live edge and has no group media; serve
 // no playlist rather than letting hls.js catch the group up by five minutes.
 assert.equal(c.read(HLS_BASE+'video.m3u8'),null);
 assert(c.files.has('s15.m4s'));assert(c.bytes<128*1024*1024);
});

test('bootstrap overflow fails with a bounded empty cache',()=>{
 const c=new VerifiedHlsCache({maxBytes:4096});c.add(bundle());const extra={start:12,duration:2,playlistStart:0,files:[{path:'bootstrap.mp4',bytes:new Uint8Array(3900).buffer}]};assert.throws(()=>c.add(extra),/exceeds cache limit/);assert(c.bytes<=4096);
});

test('valid zero-based source without a media-sequence tag gains one when windowed',()=>{
 const c=new VerifiedHlsCache();c.target=31;const b=bundle();b.files[1].bytes=bytes(media().replace('#EXT-X-MEDIA-SEQUENCE:0\n',''));c.add(b);assert.match(c.read(HLS_BASE+'video.m3u8'),/#EXT-X-MEDIA-SEQUENCE:3/);
});


test('sound preferences cannot start a warming or hidden standard player',async()=>{
 let plays=0;const p=Object.create(Player.prototype);Object.assign(p,{closed:false,suspended:false,target:-2,video:{muted:true,play(){plays++;return Promise.resolve()}}});
 await p.requestSound();assert.equal(p.video.muted,false);assert.equal(plays,0);p.target=5;p.suspended=true;await p.requestSound();assert.equal(plays,0);p.suspended=false;await p.play();assert.equal(plays,1);p.closed=true;await p.play();assert.equal(plays,1);
});


test('a long player-local cache soak retains a minute rather than another relay history',()=>{
 const c=new VerifiedHlsCache({maxBytes:32*1024*1024,retainSeconds:60});
 for(let i=0;i<1500;i++){c.target=i*2;c.add(bundle(i,i*2));assert(c.bytes<=32*1024*1024);assert(c.files.size<45);assert(c.timeline.size<45);}
 assert(!c.files.has('s0.m4s'));assert(c.files.has('s1504.m4s'));assert(c.files.has('init.mp4'));
});
