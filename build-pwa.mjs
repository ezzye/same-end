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
html=html.replace('<meta name="viewport"', '<meta name="referrer" content="no-referrer"><link rel="manifest" href="./manifest.webmanifest"><link rel="icon" href="./icon-192.png"><meta name="viewport"');
html=html.replace('<!-- browser-invitation-slot -->',`<div class="invite-link-wrap" id="invitation-ready" hidden><label for="browser-invitation">Your private invitation</label><input id="browser-invitation" type="text" readonly autocomplete="off" aria-describedby="browser-link-help"><p id="browser-link-help" class="micro">Send this complete link privately.</p></div>`);
html=html.replace('<div class="row invite-actions"><button id="make-magnet" disabled>Invite your mates <span aria-hidden="true">↗</span></button></div>','<div class="row invite-actions"><button id="make-magnet" disabled>Invite your mates <span aria-hidden="true">↗</span></button><button id="copy-browser-link" class="copy-ready" hidden>Copy invitation <span aria-hidden="true">↗</span></button></div>');
html=html.replace('<!-- install-slot -->',`<details><summary>Keep Same End handy</summary><button id="install-app" class="secondary" hidden>Install Same End</button><p id="pwa-help">Use your browser menu to Install app or Add to Home Screen.</p></details>`);
html=html.replace('id="native-setup" class="hidden"','id="native-setup" class="hidden pwa-hidden"').replace('</style>','.pwa-hidden{display:none!important}</style>');
html=html.replace(/<\/body>(?=<\/html>\s*$)/,`<script id="same-end-browser-ui">
(()=>{const $=id=>document.getElementById(id),button=$('install-app');let installPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;button.hidden=false;});
button.onclick=async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;button.hidden=true};
if(location.protocol==='file:')$('pwa-help').textContent='Open Same End through its browser address to enable installation.';
if('serviceWorker' in navigator && (location.protocol==='https:'||['localhost','127.0.0.1'].includes(location.hostname))){let reloading=false,activationRequested=false;const idle=()=>!window.PrivateCast?.snapshot().config&&!document.body.classList.contains('joining');const activate=worker=>{if(worker&&idle()){activationRequested=true;worker.postMessage({type:'ACTIVATE_UPDATE'})}};navigator.serviceWorker.addEventListener('controllerchange',()=>{if(activationRequested&&!reloading&&idle()){reloading=true;location.reload()}});navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(reg=>{activate(reg.waiting);reg.addEventListener('updatefound',()=>{const next=reg.installing;next?.addEventListener('statechange',()=>{if(next.state==='installed'&&navigator.serviceWorker.controller)activate(reg.waiting)})});setInterval(()=>activate(reg.waiting),10000)}).catch(()=>{$('pwa-help').textContent='Offline setup is unavailable. Keep this page open during your room.'});}
const input=$('join-magnet'),cast=$('magnet-link'),copy=$('copy-browser-link'),invitation=$('browser-invitation'),make=$('make-magnet');let previous='';
function changed(){const v=cast.value.trim();const ready=!!v;make.hidden=ready;copy.hidden=!ready;$('invitation-ready').hidden=!ready;if(v!==previous){previous=v;if(v){const u=new URL(location.href);u.hash='join='+encodeURIComponent(v);invitation.value=u.href}else invitation.value='';}const local=['localhost','127.0.0.1'].includes(location.hostname);$('browser-link-help').textContent=local?'Test invitation · opens on this computer only.':'Send this complete link privately. Anyone with it can join while the room is open.';}
copy.onclick=async()=>{changed();try{await navigator.clipboard.writeText(invitation.value);$('magnet-progress').textContent='Invitation copied. Drop it in your group chat.';copy.textContent='Copy invitation again ↗'}catch{invitation.focus();invitation.select();$('magnet-progress').textContent='Your invitation is ready below. Select and copy the complete link to send privately.'}};
const create=make.onclick;make.onclick=async event=>{await create(event);changed();if(cast.value.trim())await copy.onclick();else $('magnet-progress').textContent=$('status').textContent};
setInterval(changed,400);changed();
async function joinFromURL(){const params=new URLSearchParams(location.hash.slice(1)),v=params.get('join');if(!v)return;history.replaceState(null,'',location.pathname+location.search);input.value=v;document.body.classList.add('joining');$('watch-room').scrollIntoView({block:'start',behavior:'smooth'});try{await window.PrivateCast.joinMagnet(v)}catch(e){document.body.classList.remove('joining');$('room-status').textContent=e.message;$('magnet-progress').textContent=e.message;$('join-magnet').closest('details').open=true;}};
const join=$('join-magnet-button').onclick;$('join-magnet-button').onclick=async event=>{document.body.classList.add('joining');await join(event);if(!window.PrivateCast.snapshot().config){document.body.classList.remove('joining');$('room-status').textContent=$('status').textContent;}};
addEventListener('load',joinFromURL);addEventListener('hashchange',joinFromURL);
})();
</script></body>`);
await writeFile(path.join(out,'index.html'),html);
await writeFile(path.join(out,'manifest.webmanifest'),JSON.stringify({name:'Same End',short_name:'Same End',start_url:'./',scope:'./',display:'standalone',background_color:'#f6f3e9',theme_color:'#173e32',icons:[{src:'./icon-192.png',sizes:'192x192',type:'image/png'},{src:'./icon-512.png',sizes:'512x512',type:'image/png'}]},null,2));
async function png(n){const z=[];const crc=b=>{let c=-1;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^-1)>>>0};const chunk=(t,d)=>{let b=Buffer.concat([Buffer.from(t),d]),h=Buffer.alloc(4);h.writeUInt32BE(d.length);let c=Buffer.alloc(4);c.writeUInt32BE(crc(b));return Buffer.concat([h,b,c])};let raw=Buffer.alloc(n*(n*4+1));for(let y=0;y<n;y++){let row=y*(n*4+1);for(let x=0;x<n;x++){let k=row+1+x*4;const px=x/n,py=y/n,cream=[246,243,233],forest=[23,62,50],coral=[255,120,78];let color=forest;const stripes=[{x:.23,y:.36,h:.36},{x:.41,y:.24,h:.48},{x:.59,y:.44,h:.28}];for(const bar of stripes){if(px>bar.x&&px<bar.x+.12&&py>bar.y&&py<bar.y+bar.h)color=cream;}if((px-.81)**2+(py-.68)**2<.055**2)color=coral;raw[k]=color[0];raw[k+1]=color[1];raw[k+2]=color[2];raw[k+3]=255}}let ih=Buffer.alloc(13);ih.writeUInt32BE(n);ih.writeUInt32BE(n,4);ih.set([8,6,0,0,0],8);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',(await import('node:zlib')).deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])}
for(const n of [192,512])await writeFile(path.join(out,`icon-${n}.png`),await png(n));
const shell=['index.html','manifest.webmanifest','icon-192.png','icon-512.png'];let digest=createHash('sha256');for(const f of shell)digest.update(await readFile(path.join(out,f)));const version=digest.digest('hex').slice(0,16);
await writeFile(path.join(out,'sw.js'),`const CACHE='private-cast-${version}',FILES=${JSON.stringify(shell.map(x=>'./'+x))};
const BASE=new URL('./',self.location.href),INDEX=new URL('index.html',BASE).href,ALLOWED=new Set(FILES.map(f=>new URL(f,BASE).href));
self.addEventListener('message',e=>{if(e.data?.type==='ACTIVATE_UPDATE')self.skipWaiting()});
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('private-cast-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==BASE.origin)return;let key=u.href;if(e.request.mode==='navigate'&&(u.pathname===BASE.pathname||u.pathname===new URL(INDEX).pathname))key=INDEX;if(!ALLOWED.has(key))return;e.respondWith(caches.open(CACHE).then(c=>c.match(key)).then(r=>r||fetch(e.request)))});
`);

await writeFile(path.join(out,'test-guide.html'),await readFile(path.join(dir,'test-guide.html')));
