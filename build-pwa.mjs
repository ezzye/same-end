import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {zipSync} from 'fflate';
import {transform,build} from 'esbuild';
const dir=path.dirname(fileURLToPath(import.meta.url)), out=path.join(dir,'dist');
const browserTargets=['es2017','safari12.1','ios12.2','chrome80','edge80','firefox78'];
// Hash final script bytes, including inert bundles activated later by the engine.
// A meta policy travels with saved HTML; framing protection still needs an HTTP header.
function secureStaticHtml(document) {
  const hashes = new Set();
  for (const [, attributes, source] of document.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!source.trim() || /\bsrc\s*=|id=["']webtorrent-license["']|type=["']application\/json["']/i.test(attributes)) continue;
    hashes.add("'sha256-" + createHash('sha256').update(source.replace(/\r\n?/g, '\n')).digest('base64') + "'");
  }
  const localConnections = process.env.SAME_END_LOCAL === '1' ? ' http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* ws://[::1]:*' : '';
  const policy = ["default-src 'self'", "script-src 'self' " + [...hashes].join(' '), "script-src-attr 'none'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' blob:", "worker-src 'self' blob:", "child-src 'self' blob:", "connect-src 'self' https: wss:" + localConnections, "object-src 'none'", "base-uri 'none'", "frame-src 'none'", "form-action 'self'"].join('; ');
  const charset = /<meta\s+charset=["'][^"']+["']\s*\/?>/i;
  if (!charset.test(document)) throw Error('A protected static page needs an early charset declaration.');
  return document.replace(charset, match => match + '\n<meta http-equiv="Content-Security-Policy" content="' + policy + '">');
}

await mkdir(out,{recursive:true});
let html=await readFile(path.join(dir,'app.html'),'utf8');
const legacyTorrent=await readFile(path.join(dir,'vendor/webtorrent-legacy.js'),'utf8');
html=html.replace(/(<script[^>]+id="magnet-vendor">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+legacyTorrent+b);
const browserCompat=await readFile(path.join(dir,'browser-compat.js'),'utf8');
const compatPattern=/(<script id="browser-compat">)[\s\S]*?(<\/script>)/;
if(!compatPattern.test(html))throw Error('Embedded browser compatibility shim is missing.');
html=html.replace(compatPattern,(_,open,close)=>open+browserCompat+close);
const mediaPlayer=(await readFile(path.join(dir,'capture-normalize.js'),'utf8'))+'\n'+(await readFile(path.join(dir,'native-mp4.js'),'utf8'))+'\n'+await readFile(path.join(dir,'media-player.js'),'utf8');
const mediaPattern=/(<script id="same-end-media">)[\s\S]*?(<\/script>)/;
if(!mediaPattern.test(html))throw Error('Embedded media helper slot is missing.');
html=html.replace(mediaPattern,(_,open,close)=>open+mediaPlayer+close);
// Packager and players are pinned, bundled and served with the app. No remote
// script or video origin is needed by the verified-cache HLS loaders.
const streaming=await build({entryPoints:[path.join(dir,'streaming-entry.js')],bundle:true,write:false,format:'iife',globalName:'SameEndHLS',platform:'browser',target:browserTargets,minify:true,legalComments:'inline'});
const captureBundle=await build({entryPoints:[path.join(dir,'capture-entry.js')],bundle:true,write:false,format:'iife',globalName:'SameEndHLSCapture',platform:'browser',target:['es2020','chrome94','edge94','safari17'],minify:true,legalComments:'inline'});
html=html.replace(mediaPattern,(_,open,bodyClose)=>open+mediaPlayer+bodyClose+'<script id="same-end-standard-streaming">'+streaming.outputFiles[0].text+'</script><script id="same-end-hls-capture" type="text/plain">'+captureBundle.outputFiles[0].text+'</script>');
// Preserve full upstream licence notices and source availability in saved HTML.
const notices=[['hls.js 1.7.3','HLSJS-LICENSE.txt','https://github.com/video-dev/hls.js/tree/v1.7.3'],['Mediabunny 1.62.1','MEDIABUNNY-LICENSE.txt','https://www.npmjs.com/package/mediabunny/v/1.62.1']];
const escapeHTML=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
let licenceSections='';
for(const [name,file,url] of notices){licenceSections+='<details><summary>'+name+'</summary><p><a href="'+url+'">Versioned upstream source</a> · bundled without upstream source modifications.</p><pre style="white-space:pre-wrap">'+escapeHTML(await readFile(path.join(dir,'vendor',file),'utf8'))+'</pre></details>';}
html=html.replace(/<\/body>(?=<\/html>\s*$)/,'<details class="third-party-notices" style="margin:1rem"><summary>Open-source licences</summary>'+licenceSections+'</details></body>');
await writeFile(path.join(out,'third-party.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Same End open-source software</title><body style="font:16px system-ui;max-width:60rem;margin:2rem auto;padding:1rem"><h1>Same End open-source software</h1>'+licenceSections+'</body></html>');
// Public policy is rendered from the same source as the repository notice.
const privacyText=await readFile(path.join(dir,'PRIVACY.md'),'utf8');
const privacyBlocks=privacyText.split(/\n\s*\n/).map(block=>{
 const heading=block.match(/^(#{1,3}) (.+)$/);if(heading)return '<h'+heading[1].length+'>'+escapeHTML(heading[2])+'</h'+heading[1].length+'>';
 const text=escapeHTML(block).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
 return '<p style="white-space:pre-line">'+text+'</p>';
}).join('');
await writeFile(path.join(out,'privacy.html'),'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>Same End privacy</title><style>body{font:16px/1.65 system-ui,sans-serif;max-width:780px;margin:32px auto;padding:0 22px;background:#f5f6f3;color:#073c2a}h1,h2,h3{line-height:1.25;margin-top:1.8em}a{color:inherit}</style></head><body><a href="./">Back to Same End</a>'+privacyBlocks+'</body></html>');
for(const [id,file,tag] of [['invite-check-style','invite-check.css','style'],['invite-check-sample','invite-sample.js','script'],['room-status-module','room-status.js','script'],['invite-check-module','invite-check.js','script']]){const body=await readFile(path.join(dir,file),'utf8');const pattern=new RegExp('(<'+tag+' id="'+id+'">)[\\s\\S]*?(</'+tag+'>)');if(!pattern.test(html))throw Error('Missing invitation check slot.');html=html.replace(pattern,(_,a,b)=>a+body+b);}
// The standalone source includes its engine for offline sharing. Always hydrate
// the web build from the canonical module so fixes cannot silently drift.
const transport=(await readFile(path.join(dir,'magnet-transport.js'),'utf8')).replace("import WebTorrent from './vendor/webtorrent.min.js';",'const WebTorrent=window.WebTorrent;');
const modulePattern=/(<script[^>]+id="magnet-module">)[\s\S]*?(<\/script>)/;
if(!modulePattern.test(html))throw Error('Embedded magnet module is missing.');
html=html.replace(modulePattern,(_,open,close)=>open+transport+close);
const sourceAudio=await readFile(path.join(dir,'source-audio.js'),'utf8');
const sourceAudioSlot=/(<script id="source-audio-module">)[\s\S]*?(<\/script>)/;
if(!sourceAudioSlot.test(html))throw Error('Missing source sound check slot.');
html=html.replace(sourceAudioSlot,(_,a,b)=>a+sourceAudio+b);
const deliveryHealth=await readFile(path.join(dir,'delivery-health.js'),'utf8');
const deliverySlot=/(<script id="delivery-health-module">)[\s\S]*?(<\/script>)/;
if(!deliverySlot.test(html))throw Error('Missing delivery health slot.');
html=html.replace(deliverySlot,(_,a,b)=>a+deliveryHealth+b);
const clientDelivery=await readFile(path.join(dir,'client-delivery.js'),'utf8');
const clientDeliverySlot=/(<script id="client-delivery-module">)[\s\S]*?(<\/script>)/;
if(!clientDeliverySlot.test(html))throw Error('Missing client delivery measurement slot.');
html=html.replace(clientDeliverySlot,(_,a,b)=>a+clientDelivery+b);
const initialDelay=await readFile(path.join(dir,'initial-delay.js'),'utf8');
const initialDelaySlot=/(<script id="initial-delay-module">)[\s\S]*?(<\/script>)/;
if(!initialDelaySlot.test(html))throw Error('Missing initial delay policy slot.');
html=html.replace(initialDelaySlot,(_,a,b)=>a+initialDelay+b);
const commonStart=await readFile(path.join(dir,'common-start.js'),'utf8');
html=html.replace(/(<script id="common-start-module">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+commonStart+b);
const clientDeliveryUI=await readFile(path.join(dir,'client-delivery-ui.js'),'utf8');
html=html.replace(/(<script id="client-delivery-ui-module">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+clientDeliveryUI+b);
for(const [id,file]of [['share-help-module','share-help.js'],['diagnostics-core','diagnostics-core.js'],['session-diagnostics-ui','diagnostics-ui.js']]){const body=await readFile(path.join(dir,file),'utf8'),pattern=new RegExp('(<script id="'+id+'">)[\\s\\S]*?(</script>)');if(!pattern.test(html))throw Error('Missing test diagnostics slot.');html=html.replace(pattern,(_,a,b)=>a+body+b);}
const resilienceModules=(await Promise.all(['resilience-wire.js','resilience-policy.js','resilience-pacing.js','coordinator-client.js'].map(name=>readFile(path.join(dir,name),'utf8')))).join('\n');
html=html.replace('<script id="cast-engine">','<script id="resilience-modules">'+resilienceModules+'</script><script id="cast-engine">');
const engine=await readFile(path.join(dir,'engine.js'),'utf8');
html=html.replace(/(<script id="cast-engine">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+engine+b);

// All public runtime configuration is explicit. Secrets belong in neither this file nor the build.
let apiBase=process.env.SAME_END_API_BASE||'';
try{if(!apiBase)apiBase=JSON.parse(await readFile(path.join(dir,'public-config.json'),'utf8')).apiBase||'';}catch(e){if(e.code!=='ENOENT')throw e;}
if(process.env.SAME_END_LOCAL==='1')apiBase='';
if(apiBase&&!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(apiBase))throw Error('Use a public HTTPS API origin.');
const runtime={apiBase,resilientDelivery:process.argv.includes('--resilient-delivery')||process.env.SAMEEND_RESILIENT_DELIVERY==='1',buildId:(process.env.CURRENT_DEPLOY_SHA||process.env.GITHUB_SHA)?.slice(0,12)||'local',automaticInitialDelay:process.env.SAMEEND_AUTOMATIC_INITIAL_DELAY!=='0',automaticCommonStart:process.env.SAMEEND_AUTOMATIC_COMMON_START!=='0'};
const communityStyle=await readFile(path.join(dir,'community.css'),'utf8');
const waitingStyle=await readFile(path.join(dir,'waiting.css'),'utf8');
const communityRuntime=(await readFile(path.join(dir,'fan-auth.js'),'utf8'))+'\n'+await readFile(path.join(dir,'community.js'),'utf8');
const waitingRuntime=(await readFile(path.join(dir,'waiting-core.js'),'utf8'))+'\n'+await readFile(path.join(dir,'waiting.js'),'utf8');
const fixtures=JSON.parse(await readFile(path.join(dir,'fixtures.json'),'utf8'));
const hero='data:image/webp;base64,'+(await readFile(path.join(dir,'assets/match-night.webp'))).toString('base64');
const clubhouse='data:image/webp;base64,'+(await readFile(path.join(dir,'assets/clubhouse.webp'))).toString('base64');
const css=(await readFile(path.join(dir,'personal-listings.css'),'utf8'))+'\n'+(await readFile(path.join(dir,'social.css'),'utf8'))+'\n'+(await readFile(path.join(dir,'brand.css'),'utf8')).replace('__HERO_IMAGE__',hero).replace('__CLUB_IMAGE__',clubhouse);
html=html.replace('</head>','<style id="same-end-brand">'+css+'</style><style id="same-end-community-style">'+communityStyle+'\n'+waitingStyle+'</style></head>');
const social=await readFile(path.join(dir,'social.js'),'utf8');
const personalUI=(await readFile(path.join(dir,'extension/reader-core.js'),'utf8'))+'\n'+(await readFile(path.join(dir,'personal-listings.js'),'utf8'));
const scheduleUI=(await readFile(path.join(dir,'listing-sources.js'),'utf8'))+'\n'+await readFile(path.join(dir,'schedule-ui.js'),'utf8');
let rehearsal='';try{rehearsal=await readFile(path.join(dir,'rehearsal.js'),'utf8')}catch(e){if(e.code!=='ENOENT')throw e;}
const json=value=>JSON.stringify(value).replace(/</g,'\\u003c');
// Capture only harmless launch intent before the club module removes secret fragments.
const boot=`window.SameEndConfig=${json(runtime)};window.SameEndFixtures=${json(fixtures)};(()=>{const q=new URLSearchParams(location.hash.slice(1));window.SameEndBoot={rehearsal:q.get('rehearsal'),hasClubInvite:q.has('club')||q.has('openclub')};})();`;
html=html.replace(/<\/body>(?=<\/html>\s*$)/,'<script id="same-end-social">'+boot+'\n'+social+'\n'+rehearsal+'\n'+scheduleUI+'\n'+personalUI+'</script></body>');

html=html.replace('<meta name="viewport"', '<meta name="referrer" content="no-referrer"><link rel="manifest" href="./manifest.webmanifest"><link rel="icon" href="./icon-192.png"><meta name="viewport"');
html=html.replace('<!-- browser-invitation-slot -->',`<div class="invite-link-wrap" id="invitation-ready" hidden><label for="browser-invitation">Your private invitation</label><div class="invitation-copy-row"><input id="browser-invitation" type="text" readonly autocomplete="off" aria-describedby="browser-link-help"><button id="copy-private-invitation" type="button" title="Copy invitation to clipboard" aria-label="Copy invitation to clipboard"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg><span id="copy-invitation-label">Copy</span></button><button id="share-private-invitation" type="button" title="Share private invitation" aria-label="Share private invitation"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 15V3m-4 4 4-4 4 4M6 11H4v10h16V11h-2"/></svg><span>Share</span></button></div><p id="browser-link-help" class="micro">Send this complete link privately.</p></div>`);
html=html.replace('<div class="row invite-actions"><button id="make-magnet" disabled>Invite your mates <span aria-hidden="true">↗</span></button></div>','<div class="row invite-actions"><button id="make-magnet" disabled>Invite your mates <span aria-hidden="true">↗</span></button><button id="copy-browser-link" class="copy-ready" hidden>Copy room invitation <span aria-hidden="true">↗</span></button><button id="video-only-invite" class="secondary" hidden>Send video only instead</button></div>');
const privacyMarkup=await readFile(path.join(dir,'privacy.html'),'utf8');
const privacyStyle=await readFile(path.join(dir,'privacy.css'),'utf8');
const privacyRuntime=(await readFile(path.join(dir,'analytics-core.js'),'utf8'))+'\n'+await readFile(path.join(dir,'privacy.js'),'utf8');
html=html.replace('</head>','<style id="same-end-privacy-style">'+privacyStyle+'</style></head>');
html=html.replace(/<\/body>(?=<\/html>\s*$)/,privacyMarkup+'<script id="same-end-privacy">'+privacyRuntime+'</script></body>');
const installMarkup=await readFile(path.join(dir,'install.html'),'utf8');
const installStyle=await readFile(path.join(dir,'install.css'),'utf8');
const installRuntime=await readFile(path.join(dir,'install.js'),'utf8');
const installModalAt=installMarkup.indexOf('<section id="install-help"');
if(installModalAt<0)throw Error('Installation dialog is missing.');
html=html.replace('<!-- install-slot -->',installMarkup.slice(0,installModalAt)).replace(/<\/body>(?=<\/html>\s*$)/,installMarkup.slice(installModalAt)+'</body>').replace('</head>','<style id="same-end-install-style">'+installStyle+'</style></head>');
html=html.replace('id="native-setup" class="hidden"','id="native-setup" class="hidden pwa-hidden"').replace('</style>','.pwa-hidden{display:none!important}</style>');
html=html.replace(/<\/body>(?=<\/html>\s*$)/,`<script id="same-end-browser-ui">
(()=>{const $=id=>document.getElementById(id);
// This final script is parsed before club mounting/joining, so saved HTML has all
// app code and artwork, with no rendered invitations, private club state or media.
const cleanAppHTML='<!doctype html>\\n'+document.documentElement.outerHTML;
const appFile=()=>new File([cleanAppHTML],'same-end.html',{type:'text/html'});
const saveFile=file=>{const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)};
$('save-app').onclick=()=>{saveFile(appFile());$('file-status').textContent='App saved. Attach the HTML file to share it. Private club keys and video are not included.'};
$('share-app').onclick=async()=>{const file=appFile();try{if(navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:'Same End'});$('file-status').textContent='HTML file shared.';return}}catch(e){if(e.name==='AbortError')return}$('file-status').textContent='File sharing is unavailable here. The app has downloaded; attach the HTML file privately.';saveFile(file)};

$('settings-create-club').hidden=false;$('settings-create-club').onclick=()=>{showDiary();window.SameEndSocial.showCreate()};if(window.SameEndBoot?.hasClubInvite)document.body.classList.add('club-intent');new MutationObserver(()=>{if(document.querySelector('.club-saved-button'))document.body.classList.add('club-intent')}).observe($('club-social'),{childList:true,subtree:true});
if('serviceWorker' in navigator && (location.protocol==='https:'||['localhost','127.0.0.1'].includes(location.hostname))){let reloading=false,activationRequested=false;const idle=()=>!window.PrivateCast?.snapshot().config&&!document.body.classList.contains('joining')&&!window.SameEndSocial?.snapshot().connected&&![...document.querySelectorAll('input,textarea')].some(el=>el.value!==el.defaultValue);const activate=worker=>{if(worker&&idle()){activationRequested=true;worker.postMessage({type:'ACTIVATE_UPDATE'})}};navigator.serviceWorker.addEventListener('controllerchange',()=>{if(activationRequested&&!reloading&&idle()){reloading=true;location.reload()}});navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'}).then(reg=>{activate(reg.waiting);reg.addEventListener('updatefound',()=>{const next=reg.installing;next?.addEventListener('statechange',()=>{if(next.state==='installed'&&navigator.serviceWorker.controller)activate(reg.waiting)})});setInterval(()=>activate(reg.waiting),10000)}).catch(()=>{$('pwa-help').textContent='Offline setup is unavailable. Keep this page open during your room.'});}
const input=$('join-magnet'),cast=$('magnet-link'),copy=$('copy-browser-link'),invitation=$('browser-invitation'),make=$('make-magnet'),videoOnly=$('video-only-invite'),inlineCopy=$('copy-private-invitation'),inlineShare=$('share-private-invitation');let sharing=false,socialInvitation='',socialMagnet='',socialClubId='',inviting=null,invitationError='',videoOnlySelected=false;
function ready(){return !!socialInvitation&&window.SameEndSocial.snapshot().id===socialClubId}
function canPrepareInvitation(snapshot,social){const source=snapshot.active&&snapshot.role==='source';return social.ready&&!snapshot.joiningBusy&&!social.watching&&(source||!snapshot.config&&!document.body.classList.contains('joining')&&(!social.connected||social.owner))}
function changed(){const v=cast.value.trim();const social=window.SameEndSocial.snapshot();if(social.watchInvitation){socialInvitation=social.watchInvitation;socialClubId=social.id}if(!v){socialMagnet='';videoOnlySelected=false}if(social.id!==socialClubId){socialInvitation='';socialClubId=''}const snapshot=window.PrivateCast.snapshot(),complete=ready();make.hidden=complete;make.disabled=!!inviting||!canPrepareInvitation(snapshot,social);make.textContent=inviting?'Preparing your private room…':invitationError?'Retry room invitation':'Invite your mates ↗';copy.hidden=!complete;copy.disabled=!!inviting;inlineCopy.disabled=!!inviting||!(complete||videoOnlySelected);inlineShare.disabled=sharing||inlineCopy.disabled;videoOnly.hidden=!invitationError||!!inviting||complete||!v;$('invitation-ready').hidden=!(complete||videoOnlySelected);if(complete){invitation.value=socialInvitation;$('browser-link-help').textContent='PRIVATE ROOM + CHAT · Invite your mates now. This link works when sharing starts or restarts.'}else if(videoOnlySelected){const u=new URL(location.href);u.hash='join='+encodeURIComponent(v);invitation.value=u.href;$('browser-link-help').textContent='VIDEO ONLY · This invitation does not include chat or match reminders.'}else{invitation.value='';$('browser-link-help').textContent='Invite your mates to a private room. Start sharing whenever you’re ready.'}}

async function copyReady(){changed();if(!ready()&&!videoOnlySelected)return;try{await navigator.clipboard.writeText(invitation.value);window.SameEndPrivacy?.track('invitation_copied');$('copy-invitation-label').textContent='Copied';setTimeout(()=>{$('copy-invitation-label').textContent='Copy'},2000);$('magnet-progress').textContent=ready()?'Private room invitation copied. Send it privately to your mates.':'Video-only invitation copied. Chat and reminders are not included.'}catch{$('copy-invitation-label').textContent='Copy';invitation.focus();invitation.select();$('magnet-progress').textContent='Link selected. Use Copy from your device’s menu, or press Ctrl+C (Command+C on Mac).'}}
async function shareReady(){if(sharing)return;changed();if(!ready()&&!videoOnlySelected)return;const payload={title:'Same End',text:ready()?'Join my private Same End room. We can chat while we wait for the picture.':'Join my Same End video-only room. Chat and reminders are not included.',url:invitation.value};sharing=true;changed();try{if(!navigator.share)throw Error('Sharing unavailable');await navigator.share(payload);$('magnet-progress').textContent='Invitation handed to your chosen app. Send it privately to your mates.'}catch(e){if(e?.name==='AbortError'){$('magnet-progress').textContent='Sharing cancelled. Your invitation is ready when you are.';return}await copyReady();$('magnet-progress').textContent='Sharing is not available here. '+$('magnet-progress').textContent}finally{sharing=false;changed()}}
const create=make.onclick;
async function prepareInvitation(event){if(inviting)return inviting;const initial=window.PrivateCast.snapshot();if(!canPrepareInvitation(initial,window.SameEndSocial.snapshot()))return;inviting=(async()=>{invitationError='';videoOnlySelected=false;$('magnet-progress').textContent='Preparing your private room invitation…';try{let link,v='';if(initial.active&&initial.role==='source'){if(!cast.value.trim())await create(event);v=cast.value.trim();const current=window.PrivateCast.snapshot();if(!current.active||current.role!=='source'||current.config?.id!==initial.config?.id)return;if(!v)throw Error($('status').textContent||'Your screen invitation is still being prepared.');link=await window.SameEndSocial.castInvitation(v);if(cast.value.trim()!==v||window.PrivateCast.snapshot().config?.id!==initial.config?.id)return}else{link=await window.SameEndSocial.prepareRoomInvitation();const current=window.PrivateCast.snapshot();if(current.joiningBusy||current.config&&current.role!=='source'||window.SameEndSocial.snapshot().watching)return}socialInvitation=link;socialMagnet=v;socialClubId=window.SameEndSocial.snapshot().id;$('room-social-status').textContent='Your private room is ready. Chat now; sharing can start whenever you’re ready.';await copyReady()}catch(e){invitationError=e.message||'The room service is unavailable.';socialInvitation='';socialMagnet='';socialClubId='';invitation.value='';$('magnet-progress').textContent='Your room invitation could not connect: '+invitationError+' Choose Retry room invitation.';$('room-social-status').textContent='Your room invitation could not connect: '+invitationError+' The invitation has not been copied.'}finally{inviting=null;changed()}})();changed();return inviting}

make.onclick=prepareInvitation;copy.onclick=copyReady;inlineCopy.onclick=copyReady;inlineShare.onclick=shareReady;
videoOnly.onclick=async()=>{videoOnlySelected=true;changed();try{await navigator.clipboard.writeText(invitation.value);$('magnet-progress').textContent='Video-only invitation copied by your choice. Chat and reminders are not included.'}catch{invitation.focus();invitation.select();$('magnet-progress').textContent='Video-only invitation selected. It does not include chat or reminders.'}};
for(const id of ['demo','capture']){const begin=$(id).onclick;$(id).onclick=async event=>{await begin(event);const snapshot=window.PrivateCast.snapshot();if(snapshot.active&&snapshot.role==='source'){try{await window.SameEndSocial.prepareCastClub();$('room-social-status').textContent='Chat opens here when a mate connects.'}catch(e){$('room-social-status').textContent='Video works, but live chat could not connect. '+e.message}}};}
const room=$('watch-room'),roomFull=$('room-fullscreen');
function showDiary(){document.body.classList.add('room-show-diary');window.SameEndSocial.showClub('club-diary');if(!$('back-to-room')){const back=document.createElement('button');back.id='back-to-room';back.className='room-diary-back';back.textContent='Back to the picture ↑';back.onclick=()=>{document.body.classList.remove('room-show-diary');room.scrollIntoView({block:'start'})};$('club-social').prepend(back)}}
function fullRoomChanged(){room.classList.toggle('is-browser-fullscreen',document.fullscreenElement===room);const expanded=document.fullscreenElement===room||room.classList.contains('room-expanded');roomFull.textContent=expanded?'Exit full room':'Full room';roomFull.setAttribute('aria-pressed',String(expanded))}
roomFull.onclick=async()=>{if(document.fullscreenElement===room){await document.exitFullscreen();return}if(room.classList.contains('room-expanded')){room.classList.remove('room-expanded');fullRoomChanged();return}try{if(!room.requestFullscreen)throw Error('Fullscreen unavailable');await room.requestFullscreen()}catch{room.classList.add('room-expanded');fullRoomChanged()}};
const stopRoom=$('stop').onclick;$('stop').onclick=()=>{room.classList.remove('room-expanded');fullRoomChanged();if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});stopRoom()};
document.addEventListener('fullscreenchange',fullRoomChanged);document.addEventListener('keydown',e=>{if(e.key==='Escape'){room.classList.remove('room-expanded');fullRoomChanged()}});
$('room-chat').onclick=()=>{if(window.SameEndSocial.snapshot().connected){$('club-chat-shell').scrollIntoView({behavior:'smooth',block:'center'});$('club-chat-input').focus()}else if($('room-chat').dataset.chatError)$('room-social-status').textContent='This invitation includes chat, but chat could not connect: '+$('room-chat').dataset.chatError;else $('room-social-status').textContent='This is a video-only invitation. Ask the host to copy a Video + chat invitation from the updated sharing page.'};
$('room-reminders').onclick=async()=>{if(window.SameEndSocial.snapshot().connected){if(document.fullscreenElement)await document.exitFullscreen();room.classList.remove('room-expanded');fullRoomChanged();showDiary();window.SameEndSocial.showClub('club-reminders');$('club-notify-on').scrollIntoView({behavior:'smooth',block:'center'});$('club-notify-on').focus()}else $('room-social-status').textContent='For match reminders, open a new invitation with chat or choose Set up your club in Room settings & help.'};
setInterval(changed,400);changed();
async function joinFromURL(){const params=new URLSearchParams(location.hash.slice(1)),v=params.get('join');if(!v||params.has('club'))return;history.replaceState(null,'',location.pathname+location.search);input.value=v;document.body.classList.add('joining');$('watch-room').scrollIntoView({block:'start',behavior:'smooth'});try{await window.PrivateCast.joinMagnet(v)}catch(e){document.body.classList.remove('joining');$('room-status').textContent=e.message;$('magnet-progress').textContent=e.message;$('join-magnet').closest('details').open=true;}};
const join=$('join-magnet-button').onclick;$('join-magnet-button').onclick=async event=>{document.body.classList.add('joining');try{const raw=input.value.trim();if(/^https?:/.test(raw)){const params=new URLSearchParams(new URL(raw).hash.slice(1));if(params.has('club')&&(params.has('join')||params.get('watch')==='1')){input.value='';await window.SameEndSocial.joinCastLink(raw);return}if(params.get('join'))input.value=params.get('join')}await join(event)}catch(e){window.SameEndInviteCheck?.fail('invitation-incomplete');$('room-status').textContent=e.message;document.body.classList.remove('joining');return}if(!window.PrivateCast.snapshot().config){document.body.classList.remove('joining');$('room-status').textContent=$('status').textContent;}};
addEventListener('load',joinFromURL);addEventListener('hashchange',joinFromURL);
})();
</script></body>`);

// Include the feature sources before the browser UI snapshots its clean saved
// app; fan identity/drafts mount only after DOMContentLoaded/user activation.
html=html.replace('<script id="same-end-browser-ui">','<script id="same-end-install">'+installRuntime+'</script><script id="same-end-community">'+communityRuntime+'\n'+waitingRuntime+'</script><script id="same-end-browser-ui">');
const management=(await readFile(path.join(dir,'manage.html'),'utf8')).replace('__SAME_END_CONFIG__',JSON.stringify(runtime).replace(/</g,'\\u003c'));
await writeFile(path.join(out,'manage.html'),secureStaticHtml(management));
// The account callback is intentionally outside the offline service-worker shell.
for(const file of ['fan-signin.html','fan-signin.css']) { const contents=await readFile(path.join(dir,file),'utf8'); await writeFile(path.join(out,file),file.endsWith('.html')?secureStaticHtml(contents):contents); }
await writeFile(path.join(out,'fan-signin.js'),(await transform(await readFile(path.join(dir,'fan-signin.js'),'utf8'),{loader:'js',target:browserTargets})).code);
await writeFile(path.join(out,'manage.css'),await readFile(path.join(dir,'manage.css')));
// Staff-only starter discussions; validated JSON, published through the authenticated staff desk.
const starters=JSON.parse(await readFile(path.join(dir,'community-starters.json'),'utf8'));if(!Array.isArray(starters.items)||starters.items.length>20)throw Error('Invalid community starter pack.');
await writeFile(path.join(out,'community-starters.json'),JSON.stringify(starters));
await writeFile(path.join(out,'staff-mfa.css'),await readFile(path.join(dir,'staff-mfa.css')));
await writeFile(path.join(out,'staff-mfa.js'),(await transform(await readFile(path.join(dir,'staff-mfa.js'),'utf8'),{loader:'js',target:browserTargets})).code);
await writeFile(path.join(out,'manage.js'),(await transform(await readFile(path.join(dir,'manage.js'),'utf8'),{loader:'js',target:browserTargets})).code);

// This small optional recording is fetched only after Play, outside the eager app shell.
const introAudio=await readFile(path.join(dir,'assets/same-end-intro.m4a'));
if(introAudio.byteLength>100000)throw Error('Keep the Same End introduction below 100 KB.');
await writeFile(path.join(out,'same-end-intro.m4a'),introAudio);

// Keep the generated offline runtime executable on the declared legacy syntax floor.
const inlineScripts=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
for(const [,attributes,source] of inlineScripts){
  if(/type="(?:text\/plain|application\/json)"/i.test(attributes))continue;
  if(/id="magnet-vendor"/i.test(attributes))continue;
  const result=await transform(source,{loader:'js',target:browserTargets});
  html=html.replace(source,()=>result.code);
}
html=secureStaticHtml(html);
await writeFile(path.join(out,'index.html'),html);
await writeFile(path.join(out,'watch.html'),html);
await writeFile(path.join(out,'fixtures.json'),JSON.stringify(fixtures));
await writeFile(path.join(out,'manifest.webmanifest'),JSON.stringify({id:'./',name:'Same End',short_name:'Same End',start_url:'./watch.html',scope:'./',display:'standalone',background_color:'#ffffff',theme_color:'#073c2a',icons:[{src:'./icon-192.png',sizes:'192x192',type:'image/png'},{src:'./icon-512.png',sizes:'512x512',type:'image/png'}]},null,2));
async function png(n){const z=[];const crc=b=>{let c=-1;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^-1)>>>0};const chunk=(t,d)=>{let b=Buffer.concat([Buffer.from(t),d]),h=Buffer.alloc(4);h.writeUInt32BE(d.length);let c=Buffer.alloc(4);c.writeUInt32BE(crc(b));return Buffer.concat([h,b,c])};let raw=Buffer.alloc(n*(n*4+1));for(let y=0;y<n;y++){let row=y*(n*4+1);for(let x=0;x<n;x++){let k=row+1+x*4;const px=x/n,py=y/n,cream=[255,255,255],forest=[7,60,42],coral=[228,42,36];let color=forest;const stripes=[{x:.23,y:.36,h:.36},{x:.41,y:.24,h:.48},{x:.59,y:.44,h:.28}];for(const bar of stripes){if(px>bar.x&&px<bar.x+.12&&py>bar.y&&py<bar.y+bar.h)color=cream;}if((px-.81)**2+(py-.68)**2<.055**2)color=coral;raw[k]=color[0];raw[k+1]=color[1];raw[k+2]=color[2];raw[k+3]=255}}let ih=Buffer.alloc(13);ih.writeUInt32BE(n);ih.writeUInt32BE(n,4);ih.set([8,6,0,0,0],8);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',(await import('node:zlib')).deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])}
for(const n of [192,512])await writeFile(path.join(out,`icon-${n}.png`),await png(n));
const shell=['index.html','watch.html','manifest.webmanifest','icon-192.png','icon-512.png'];let digest=createHash('sha256');for(const f of shell)digest.update(await readFile(path.join(out,f)));const version=digest.digest('hex').slice(0,16);
const workerBundle=await build({entryPoints:[path.join(dir,'hls-sw-handler.js')],bundle:true,write:false,format:'iife',globalName:'SameEndHLSWorker',platform:'browser',target:browserTargets,minify:true});
const serviceWorker=workerBundle.outputFiles[0].text+`\nSameEndHLSWorker.install(self);\nconst CACHE='private-cast-${version}',FILES=${JSON.stringify(shell.map(x=>'./'+x))};
const BASE=new URL('./',self.location.href),INDEX=new URL('index.html',BASE).href,ALLOWED=new Set(FILES.map(f=>new URL(f,BASE).href));
self.addEventListener('message',e=>{if(e.data?.type==='ACTIVATE_UPDATE')self.skipWaiting()});
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>Promise.all(FILES.map(async f=>{const key=new URL(f,BASE),url=new URL(key);url.searchParams.set('v',CACHE);const response=await fetch(url.href,{cache:'reload'});if(!response.ok)throw Error('App update unavailable');await c.put(key.href,response)})))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('private-cast-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('push',e=>{let data={};try{data=e.data?.json()||{}}catch{};const id=/^[0-9a-f-]{36}$/i.test(data.clubId||'')?data.clubId:'';e.waitUntil(self.registration.showNotification('Same End',{body:'Your private club is getting together. Open Same End for the match.',icon:'./icon-192.png',badge:'./icon-192.png',tag:'same-end-'+id+'-'+String(data.eventId||'test').slice(0,36),data:{clubId:id}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const id=e.notification.data?.clubId;if(!/^[0-9a-f-]{36}$/i.test(id||''))return;const url=new URL('./',BASE);url.hash='openclub='+id;e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{const client=clients.find(c=>new URL(c.url).origin===BASE.origin&&new URL(c.url).pathname.startsWith(BASE.pathname));if(client){await client.focus();client.postMessage({type:'sameend:openclub',clubId:id});return}await self.clients.openWindow(url.href)}))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==BASE.origin)return;let key=u.href;const navigation=e.request.mode==='navigate'&&(u.pathname===BASE.pathname||u.pathname===new URL(INDEX).pathname||u.pathname===new URL('watch.html',BASE).pathname);if(navigation){e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('App unavailable');return r}).catch(()=>caches.open(CACHE).then(c=>c.match(INDEX))));return}if(!ALLOWED.has(key))return;e.respondWith(caches.open(CACHE).then(c=>c.match(key)).then(r=>r||fetch(e.request)))});
`;
const legacyServiceWorker=(await transform(serviceWorker,{loader:'js',target:browserTargets,minifyWhitespace:true})).code;
await writeFile(path.join(out,'sw.js'),legacyServiceWorker);

await writeFile(path.join(out,'test-guide.html'),await readFile(path.join(dir,'test-guide.html')));
await writeFile(path.join(out,'device-check.html'),await readFile(path.join(dir,'device-check.html')));

// Ship only the reviewed extension files. No dependencies, profiles or local data.
await mkdir(path.join(dir,'extension/icons'),{recursive:true});
await writeFile(path.join(dir,'extension/icons/icon-128.png'),await png(128));
const extensionFiles=['manifest.json','reader-core.js','bbc-follow.js','capture-page.js','worker.js','popup.html','popup.js','popup.css','bridge.js','icons/icon-128.png'];
const archive={};
for(const file of extensionFiles)archive['Same-End-Local-Fixtures/'+file]=new Uint8Array(await readFile(path.join(dir,'extension',file)));
await writeFile(path.join(out,'same-end-local-fixtures.zip'),zipSync(archive,{level:6}));
await writeFile(path.join(out,'reader-setup.html'),await readFile(path.join(dir,'reader-setup.html')));
