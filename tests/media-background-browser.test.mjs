/* Accelerates one hour of paused/background receipt, then decodes at the unchanged group moment.
 * First run npm run test:native-window to generate the twelve local synthetic fixtures. */
import assert from 'node:assert/strict';import http from 'node:http';import {readFile,writeFile} from 'node:fs/promises';
const pw=await import(process.env.HOME+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const root=new URL('../',import.meta.url),out=new URL('privatework/media-background/',root),fixtures=new URL(process.env.SAMEEND_BACKGROUND_FIXTURES||'privatework/native-window/',root);await (await import('node:fs/promises')).mkdir(out,{recursive:true});const player=await readFile(new URL('media-player.js',root));
const clips=await Promise.all(Array.from({length:12},(_,i)=>readFile(new URL('piece-'+i+'.mp4',fixtures))));
const server=http.createServer((req,res)=>{if(req.url==='/player.js')return res.writeHead(200,{'content-type':'text/javascript'}).end(player);if(req.url.startsWith('/piece/'))return res.writeHead(200).end(clips[Number(req.url.split('/').at(-1))]);res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><video id=v muted playsinline></video><script src=/player.js></script>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const b=await pw.chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});let result;
try{const p=await b.newPage();await p.goto('http://127.0.0.1:'+server.address().port);result=await p.evaluate(async()=>{
 const epoch=1700000000000,clips=await Promise.all(Array.from({length:12},(_,i)=>fetch('/piece/'+i).then(r=>r.arrayBuffer()))),failures=[];let phase;const wrap=(name,fn)=>function(...args){try{return fn.apply(this,args)}catch(e){failures.push({phase:name,name:e.name,message:e.message});throw e}};
 for(const name of ['remove','appendBuffer'])SourceBuffer.prototype[name]=wrap(name,SourceBuffer.prototype[name]);const off=Object.getOwnPropertyDescriptor(SourceBuffer.prototype,'timestampOffset');Object.defineProperty(SourceBuffer.prototype,'timestampOffset',{get:off.get,set:wrap('timestampOffset',off.set)});
 const player=new SameEndMedia.Player(v,'video/mp4;codecs=avc3.42001f,mp4a.40.2');await new Promise(r=>player.source.addEventListener('sourceopen',r,{once:true}));const sb=player.sb;
 let appended=0,bytes=0;for(let seq=0;seq<1800;seq++){
 const buf=clips[seq%12],piece={meta:{seq,start:epoch+seq*2000,duration:2000},buf};
 if(player.setPlaybackWindow)player.setPlaybackWindow(seq*2,seq>5);
 player.enqueue(piece,epoch);if(player.mode!=='mse')break;
 if(sb.updating)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('append timeout')),4000);sb.addEventListener('updateend',()=>{clearTimeout(timer);resolve()},{once:true})});appended++;bytes+=buf.byteLength;
 if(seq===0){v.currentTime=.1;v.pause()}
 }
 player.setPlaybackWindow?.(3598.1,false);if(player.sb?.updating)await new Promise(r=>player.sb.addEventListener('updateend',r,{once:true}));await new Promise(r=>setTimeout(r,100));player.sync(3598.1);await new Promise(r=>setTimeout(r,100));player.sync(3598.1);await new Promise(r=>setTimeout(r,500));return{resumedProgramTime:player.programTime(),appended,bytes,frozenTime:v.currentTime,mode:player.mode,facts:player.facts(),failures,buffered:player.sb?Array.from({length:sb.buffered.length},(_,i)=>[sb.buffered.start(i),sb.buffered.end(i)]):null};
 });assert.equal(result.mode,'mse');assert.equal(result.failures.length,0);assert(result.facts.decoderBufferedSeconds<30);assert(result.resumedProgramTime>=3598&&result.resumedProgramTime<3599.2);assert(result.facts.decodedFrames>0);console.log(JSON.stringify(result));}finally{await b.close();await new Promise(r=>server.close(r));if(result)await writeFile(new URL(process.env.SAMEEND_STRESS_OUTPUT||'background-result.json',out),JSON.stringify(result,null,2))}
