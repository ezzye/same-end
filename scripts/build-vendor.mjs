// Opt-in maintainer command; ordinary builds need no npm runtime dependencies.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
let upstream=await readFile(path.join(root,'vendor/webtorrent.min.js'),'utf8');
// Same End explicitly uses MemoryStore. Upstream's eager disk-store cleanup is
// unrelated to our descriptors, can reject in Safari private contexts, and must
// not remove an unrelated app's origin-private "chunks" directory.
const cleanup='globalThis.navigator?.storage?.getDirectory&&navigator.storage.getDirectory().then(e=>{e.removeEntry("chunks",{recursive:!0}).catch(()=>{})});';
if(upstream.split(cleanup).length!==2)throw Error('Review upstream disk initialization before updating WebTorrent.');
upstream=upstream.replace(cleanup,'');
// WebTorrent includes an unused File System Access compatibility store which
// eagerly extends WritableStream. Same End always selects MemoryStore; retain
// the upstream module but gate its shim when the browser has no real streams.
const streamClass='class Rt extends WritableStream';
const streamGate='!globalThis.FileSystemFileHandle||globalThis.FileSystemFileHandle.prototype.createWritable||globalThis.FileSystemWritableFileStream||';
if(upstream.split(streamClass).length!==2||upstream.split(streamGate).length!==2)throw Error('Review the upstream File System Access compatibility module before updating WebTorrent.');
upstream=upstream.replace(streamClass,'class Rt extends (globalThis.WritableStream||class {})').replace(streamGate,'typeof globalThis.WritableStream==="undefined"||!globalThis.FileSystemFileHandle||globalThis.FileSystemFileHandle.prototype.createWritable||globalThis.FileSystemWritableFileStream||');
const scratch=await mkdtemp(path.join(tmpdir(),'same-end-vendor-'));
try{
 const input=path.join(scratch,'webtorrent.js'),output=path.join(scratch,'legacy.js');await writeFile(input,upstream);
 execFileSync('npm',['exec','--','esbuild',input,'--bundle','--format=iife','--global-name=SameEndTorrentModule','--target=es2017,safari12.1,ios12.2,chrome80,edge80,firefox78','--minify','--outfile='+output],{cwd:root,stdio:'inherit'});
 await writeFile(path.join(root,'vendor/webtorrent-legacy.js'),'/* WebTorrent 3.0.21 MIT; ES2017 compatibility build. See THIRD_PARTY.md. */\n'+await readFile(output,'utf8')+'\nwindow.WebTorrent=SameEndTorrentModule.default;\n');
}finally{await rm(scratch,{recursive:true,force:true});}
