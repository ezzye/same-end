/* Read-only observations, deliberately kept inside collapsed room help. */
(() => {
  'use strict';
  let panel;
  const metric=(v,unit)=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(1)+unit:'Not measured';
  const rate=v=>typeof v==='number'&&Number.isFinite(v)?(v/1e6).toFixed(2)+' Mbps':'Measuring';
  const descriptions={'insufficient-data':'Collecting observations',observing:'Delivery observed',constrained:'Delivery is not keeping up',risk:'Reserve needs attention',stale:'Waiting for fresh video',suspended:'Paused while this page is hidden',offline:'This device is offline','clock-unknown':'Waiting for the room clock','path-absent':'Waiting for a supplying peer'};
  function mount(){
    const settings=document.querySelector('#settings .settings-body');if(!settings)return;
    panel=document.createElement('details');panel.id='client-delivery-details';panel.hidden=true;
    panel.innerHTML='<summary>Connection &amp; buffer measurements</summary><p>Observed video delivery on this device. No speed test runs.</p><dl style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.6rem 1rem;overflow-wrap:anywhere"></dl><p class="micro">Trial estimates do not change your room delay. Maximum broadband speed is not measured.</p>';
    const list=panel.querySelector('dl');for(const [id,label]of [['state','Assessment'],['received','Received video'],['needs','Video needs'],['reserve','Verified video ahead'],['coverage','Room delay held in reserve'],['decoder','Ready in player'],['gaps','Delivery gap · 95th percentile'],['common','Group delay'],['fallback','Fallback group delay'],['selected','Starting delay on this device'],['trial','Trial starting delay'],['goal','Trial reserve target']]){const term=document.createElement('dt'),value=document.createElement('dd');term.textContent=label;value.id='client-delivery-'+id;value.style.margin='0';list.append(term,value)}
    settings.append(panel);render();setInterval(render,2000);addEventListener('sameend:castchange',render);
  }
  function render(){
    if(!panel)return;let snapshot;try{snapshot=window.PrivateCast?.snapshot?.()}catch{return}
    const raw=snapshot?.clientDelivery,m=window.SameEndDiagnosticsCore?.safeClientDelivery?.(raw);panel.hidden=!m||snapshot.role!=='viewer';if(panel.hidden)return;
    const r=m.recommendation||{},initial=window.SameEndDiagnosticsCore?.safeInitialDelay?.(snapshot.initialDelay),common=window.SameEndDiagnosticsCore?.safeCommonStart?.(snapshot.commonStart),values={common:common?.state==='pending'?'Checking group delay':metric(common?.delaySeconds??m.baselineDelaySeconds,' s'),fallback:metric(common?.fallbackDelaySeconds??m.baselineDelaySeconds,' s'),selected:initial?.applied?metric(initial.selectedDelaySeconds,' s')+' · automatic':metric(initial?.selectedDelaySeconds??m.baselineDelaySeconds,' s')+' · room setting',state:descriptions[m.state]||'Not enough evidence',received:rate(m.deliveredGoodputBps),needs:rate(m.sourceBitrateBps),reserve:metric(m.reserveSeconds,' s'),coverage:typeof m.baselineReserveFraction==='number'?Math.round(m.baselineReserveFraction*100)+'% of '+metric(m.baselineDelaySeconds,' s'):'Not measured',decoder:metric(m.decoderAheadSeconds,' s'),gaps:metric(m.gapP95Seconds,' s'),trial:r.status==='unvalidated-candidate'?metric(r.candidateInitialDelaySeconds,' s')+' · not applied':r.status==='insufficient-throughput'?'More delay cannot fix a sustained shortfall':r.status==='catchup'?'Waiting for catch-up to finish':'More observations needed',goal:metric(r.candidateReserveSeconds,' s')};
    for(const [id,value]of Object.entries(values)){const el=document.getElementById('client-delivery-'+id);if(el.textContent!==value)el.textContent=value}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
