import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
import {ReadableStream,TransformStream} from 'node:stream/web';
import {webcrypto} from 'node:crypto';

test('legacy build starts WebTorrent and creates a seed torrent without unsupported platform APIs',async()=>{
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const shim=html.match(/<script id="browser-compat">([\s\S]*?)<\/script>/)?.[1];
  const vendor=html.match(/<script type="application\/x-privatecast" id="magnet-vendor">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(shim&&vendor);
  const context=createContext({Uint8Array,Uint16Array,ArrayBuffer,DataView,performance,console,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,Blob,TextEncoder,TextDecoder,URL,MessageChannel,ReadableStream,TransformStream,btoa:value=>Buffer.from(value,'binary').toString('base64'),atob:value=>Buffer.from(value,'base64').toString('binary'),crypto:webcrypto,WebSocket:class{},navigator:{}});
  runInContext('window=globalThis;self=globalThis;delete Uint8Array.prototype.toBase64;delete Uint8Array.prototype.toHex;delete Uint8Array.fromHex;delete Object.hasOwn;delete crypto.randomUUID;delete globalThis.structuredClone;globalThis.WritableStream=undefined',context);
  runInContext(shim,context);
  runInContext(vendor,context);
  runInContext('client=new WebTorrent({dht:false,tracker:false})',context);
  assert.equal(runInContext('typeof WritableStream',context),'undefined','the compatibility path must not invent WritableStream');
  const seeded=await runInContext(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('WebTorrent seed timed out')),3000);client.seed(new Uint8Array([108,101,103,97,99,121]),{name:'legacy.txt'},torrent=>{clearTimeout(timer);if(torrent)resolve({name:torrent.files[0].name,length:torrent.length,magnet:typeof torrent.magnetURI});else reject(Error('seed callback omitted torrent'))})})`,context);
  assert.deepEqual({...seeded},{name:'legacy.txt',length:6,magnet:'string'});
  runInContext('client.destroy()',context);
});

test('compatibility shim restores missing globals, Blob and File readers, and microtask order',async()=>{
  const source=await readFile(new URL('../browser-compat.js',import.meta.url),'utf8');
  class FakeBlob{constructor(parts){this.bytes=Uint8Array.from(parts.flatMap(part=>Array.from(typeof part==='string'?new TextEncoder().encode(part):part)));}}
  class FakeFile extends FakeBlob{}
  class FileReader{readAsArrayBuffer(blob){this.result=blob.bytes.slice().buffer;Promise.resolve().then(()=>this.onload())}readAsText(blob){this.result=new TextDecoder().decode(blob.bytes);Promise.resolve().then(()=>this.onload())}}
  const context=createContext({Blob:FakeBlob,File:FakeFile,FileReader,TextDecoder,TextEncoder,Promise,TypeError,Error,Uint8Array,ArrayBuffer,Object,Element:undefined,crypto:webcrypto,setTimeout});
  runInContext('window=globalThis;self=window;delete globalThis.globalThis;delete window.queueMicrotask;delete Blob.prototype.arrayBuffer;delete Blob.prototype.text',context);
  runInContext(source,context);
  assert.equal(runInContext('globalThis===window',context),true);
  const result=await runInContext(`(async()=>{const blob=new Blob(['hello']);const file=new File(['file text'],'note.txt');const bytes=new Uint8Array(await blob.arrayBuffer());const text=await blob.text();const fileBytes=new Uint8Array(await file.arrayBuffer());const fileText=await file.text();const order=['sync'];queueMicrotask(()=>order.push('microtask'));Promise.resolve().then(()=>order.push('promise'));await new Promise(resolve=>setTimeout(()=>{order.push('timer');resolve()},0));return{bytes:Array.from(bytes),text,fileBytes:Array.from(fileBytes),fileText,order:order.join(',')}})()`,context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{bytes:[104,101,108,108,111],text:'hello',fileBytes:[102,105,108,101,32,116,101,120,116],fileText:'file text',order:'sync,microtask,promise,timer'});
});
