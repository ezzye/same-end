import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
let playwright;
try{playwright=require('playwright');}
catch{playwright=await import(process.env.SAMEEND_PLAYWRIGHT||process.env.HOME+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');}

test('real Chromium and WebKit restore legacy Blob/File and microtask APIs without weakening crypto', {timeout:60000}, async()=>{
  const shim=await readFile(new URL('../browser-compat.js',import.meta.url),'utf8');
  const html=`<!doctype html><meta charset="utf-8"><title>Legacy API fallback test</title>
<script>window.originalCrypto=window.crypto;delete window.globalThis;delete window.queueMicrotask;delete Blob.prototype.arrayBuffer;delete Blob.prototype.text;if(window.File){delete File.prototype.arrayBuffer;delete File.prototype.text;}</script>
<script>${shim}</script><script>
window.result=(async()=>{
 const blob=new Blob([new Uint8Array([0,65,255])],{type:'application/octet-stream'}),file=new File(['file text'],'legacy.txt',{type:'text/plain'});
 const bytes=Array.from(new Uint8Array(await blob.arrayBuffer())),text=await blob.text(),fileBytes=Array.from(new Uint8Array(await file.arrayBuffer())),fileText=await file.text();
 const order=['sync'];queueMicrotask(()=>order.push('microtask'));Promise.resolve().then(()=>order.push('promise'));await new Promise(resolve=>setTimeout(()=>{order.push('timer');resolve();},0));
 const message=new TextEncoder().encode('same end crypto smoke test'),pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,message),verified=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pair.publicKey,signature,message);
 const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:128},false,['encrypt','decrypt']),iv=crypto.getRandomValues(new Uint8Array(12)),ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,message),plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv},aes,ciphertext);
 return{globalThisRestored:globalThis===window,blobBytes:bytes,blobText:text,fileBytes,fileText,microtaskOrder:order.join(','),cryptoIdentity:crypto===originalCrypto,verified,aesText:new TextDecoder().decode(plaintext)};
})();
</script>`;
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(),url=`http://127.0.0.1:${address.port}/`;
  try{
    for(const engine of ['chromium','webkit']){
      const browser=await playwright[engine].launch({headless:true});
      try{
        const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(url);const result=await page.evaluate(()=>window.result);assert.deepEqual(JSON.parse(JSON.stringify(result)),{globalThisRestored:true,blobBytes:[0,65,255],blobText:'\u0000A\ufffd',fileBytes:[102,105,108,101,32,116,101,120,116],fileText:'file text',microtaskOrder:'sync,microtask,promise,timer',cryptoIdentity:true,verified:true,aesText:'same end crypto smoke test'},engine);assert.deepEqual(errors,[],engine);
      }finally{await browser.close();}
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
});
