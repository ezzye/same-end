import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url)), out=path.join(dir,'dist');
await mkdir(out,{recursive:true});
let html=await readFile(path.join(dir,'app.html'),'utf8');
// The standalone source includes its engine for offline sharing. Always hydrate
// the web build from the canonical module so fixes cannot silently drift.
const transport=(await readFile(path.join(dir,'magnet-transport.js'),'utf8')).replace("import WebTorrent from './vendor/webtorrent.min.js';",'const WebTorrent=window.WebTorrent;');
const modulePattern=/(<script[^>]+id="magnet-module">)[\s\S]*?(<\/script>)/;
if(!modulePattern.test(html))throw Error('Embedded magnet module is missing.');
html=html.replace(modulePattern,(_,open,close)=>open+transport+close);
html=html.replace('<meta name="viewport"', '<meta name="referrer" content="no-referrer"><link rel="manifest" href="./manifest.webmanifest"><meta name="theme-color" content="#732842"><link rel="icon" href="./icon-192.png"><meta name="viewport"');
html=html.replace('</header>',`<section class="panel" id="pwa-tools"><h2>Use this app in your browser</h2><button id="install-app" class="secondary" hidden>Install Same End</button><p id="pwa-help" class="muted">You can also use your browser menu: choose Install app or Add to Home Screen.</p></section></header>`);
html=html.replace('<div class="row"><button id="make-magnet" disabled>Make join link</button><button id="copy-magnet" class="secondary" disabled>Copy join link</button></div>','<div class="row"><button id="make-magnet" disabled>Make invitation</button><button id="copy-browser-link" class="secondary" disabled>Copy invitation</button></div><label for="browser-invitation">Your private browser invitation</label><input id="browser-invitation" type="text" readonly autocomplete="off" placeholder="Start a cast, then make its invitation"><p id="browser-link-help" class="muted">Share this complete browser link privately.</p>');
html=html.replace('<label for="magnet-link">Your private cast magnet</label><input id="magnet-link" type="text" readonly placeholder="Start a cast, then make its link">','<details><summary>Advanced: raw magnet link</summary><label for="magnet-link">Your private cast magnet</label><input id="magnet-link" type="text" readonly placeholder="Start a cast, then make its link"><button id="copy-magnet" class="secondary" disabled>Copy raw magnet</button></details>');
html=html.replace('<strong>Make join link</strong>','<strong>Make invitation</strong>').replace('open it in the Same End desktop app. The connection reply travels automatically.','open the invitation in this browser app. The connection reply travels automatically.');
html=html.replace('Ready. Copy this private magnet and send it to your viewer. Keep this cast open.','Ready. Copy invitation and send it privately to your viewer. Keep this cast open.');
html=html.replace('id="native-setup" class="hidden"','id="native-setup" class="hidden pwa-hidden"').replace('<footer class="file-controls">','<footer class="file-controls pwa-hidden">');
html=html.replace('<footer>','<footer class="pwa-hidden">').replace('</footer>','</footer><footer><p><a href="./test-guide.html">How to test with a friend</a> · <a href="https://github.com/ezzye/same-end" target="_blank" rel="noopener noreferrer">Source &amp; privacy</a></p><p>Keep this window open and your laptop awake during the cast. Share invitations privately.</p></footer>');
html=html.replace('A magnet click needs the desktop app installed as its handler. Browser magnet mode needs the included localhost launcher; the offline file supports manual connections.','Use the browser join link for a click-to-join invitation. Magnet links can also be pasted here.');
html=html.replace('</style>','.pwa-hidden{display:none!important}</style>');
html=html.replace(/<\/body>(?=<\/html>\s*$)/,`<script>
(()=>{let installPrompt=null;const $=id=>document.getElementById(id),button=$('install-app');
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;button.hidden=false;});
button.onclick=async()=>{if(!installPrompt){$('pwa-help').textContent='Open your browser menu and choose Install app or Add to Home Screen.';return}installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;button.hidden=true};
if(location.protocol==='file:')$('pwa-help').textContent='Open through the local browser address to enable offline reopening and installation.';
if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost' || location.hostname==='127.0.0.1'))navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{$('pwa-help').textContent='Offline setup could not start. The page remains usable while it is open.'});
const input=$('join-magnet'),cast=$('magnet-link'),copy=$('copy-browser-link'),invitation=$('browser-invitation'),current=()=>cast.value.trim()||input.value.trim();
function browserURL(v){if(!v)return '';const u=new URL(location.href);u.hash='join='+encodeURIComponent(v);return u.href;}
function changed(){const v=current();copy.disabled=!v;const url=browserURL(v);if(invitation.value!==url)invitation.value=url;let h=location.hostname==='localhost'||location.hostname==='127.0.0.1';$('browser-link-help').textContent=h?'This localhost invitation is for local testing on this computer only. Family invitations need a shared HTTPS address.':'Send the complete invitation privately. Anyone with it can join while the cast is available.'}
setInterval(changed,500);changed();copy.onclick=async()=>{changed();try{await navigator.clipboard.writeText(invitation.value);$('magnet-progress').textContent='Browser invitation copied. Send it privately.'}catch{invitation.focus();invitation.select();$('magnet-progress').textContent='Clipboard access is unavailable. The complete invitation is selected above; copy it using your browser or keyboard.'}};
function joinFromURL(){const params=new URLSearchParams(location.hash.slice(1)),v=params.get('join');if(v){history.replaceState(null,'',location.pathname+location.search);input.value=v;window.PrivateCast?.joinMagnet(v).catch(e=>{$('magnet-progress').textContent=e.message})}};addEventListener('load',joinFromURL);addEventListener('hashchange',joinFromURL);
})();
</script></body>`);
await writeFile(path.join(out,'index.html'),html);
await writeFile(path.join(out,'manifest.webmanifest'),JSON.stringify({name:'Same End',short_name:'Same End',start_url:'./',scope:'./',display:'standalone',background_color:'#f4f1eb',theme_color:'#732842',icons:[{src:'./icon-192.png',sizes:'192x192',type:'image/png'},{src:'./icon-512.png',sizes:'512x512',type:'image/png'}]},null,2));
async function png(n){const z=[];const crc=b=>{let c=-1;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^-1)>>>0};const chunk=(t,d)=>{let b=Buffer.concat([Buffer.from(t),d]),h=Buffer.alloc(4);h.writeUInt32BE(d.length);let c=Buffer.alloc(4);c.writeUInt32BE(crc(b));return Buffer.concat([h,b,c])};let raw=Buffer.alloc(n*(n*4+1));for(let y=0;y<n;y++){let row=y*(n*4+1);for(let x=0;x<n;x++){let k=row+1+x*4,edge=Math.min(x,y,n-1-x,n-1-y),circle=(x-n/2)**2+(y-n/2)**2<(n*.34)**2;raw[k]=circle?255:115;raw[k+1]=circle?255:40;raw[k+2]=circle?255:66;raw[k+3]=255}}let ih=Buffer.alloc(13);ih.writeUInt32BE(n);ih.writeUInt32BE(n,4);ih.set([8,6,0,0,0],8);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',(await import('node:zlib')).deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])}
for(const n of [192,512])await writeFile(path.join(out,`icon-${n}.png`),await png(n));
const shell=['index.html','manifest.webmanifest','icon-192.png','icon-512.png'];let digest=createHash('sha256');for(const f of shell)digest.update(await readFile(path.join(out,f)));const version=digest.digest('hex').slice(0,16);
await writeFile(path.join(out,'sw.js'),`const CACHE='private-cast-${version}',FILES=${JSON.stringify(shell.map(x=>'./'+x))};
const BASE=new URL('./',self.location.href),INDEX=new URL('index.html',BASE).href,ALLOWED=new Set(FILES.map(f=>new URL(f,BASE).href));
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('private-cast-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==BASE.origin)return;let key=u.href;if(e.request.mode==='navigate'&&(u.pathname===BASE.pathname||u.pathname===new URL(INDEX).pathname))key=INDEX;if(!ALLOWED.has(key))return;e.respondWith(caches.open(CACHE).then(c=>c.match(key)).then(r=>r||fetch(e.request)))});
`);

await writeFile(path.join(out,'test-guide.html'),await readFile(path.join(dir,'test-guide.html')));
