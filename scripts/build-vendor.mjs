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
const scratch=await mkdtemp(path.join(tmpdir(),'same-end-vendor-'));
try{
 const input=path.join(scratch,'webtorrent.js'),output=path.join(scratch,'legacy.js');await writeFile(input,upstream);
 execFileSync('npm',['exec','--yes','--package=esbuild@0.25.12','--','esbuild',input,'--bundle','--format=iife','--global-name=SameEndTorrentModule','--target=es2020,safari14.1,ios14.5,chrome90,edge90,firefox90','--minify','--outfile='+output],{stdio:'inherit'});
 await writeFile(path.join(root,'vendor/webtorrent-legacy.js'),'/* WebTorrent 3.0.21 MIT; ES2020 compatibility build. See THIRD_PARTY.md. */\n'+await readFile(output,'utf8')+'\nwindow.WebTorrent=SameEndTorrentModule.default;\n');
}finally{await rm(scratch,{recursive:true,force:true});}
