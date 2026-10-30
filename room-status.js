/* Explain only observed room facts. A timeout is neither proof of a departed
 * source nor proof that the room is full. This policy never returns identifiers. */
(() => {
  'use strict';
  const codes = ['idle', 'waiting-for-source', 'source-stopped', 'source-unreachable', 'suppliers-full', 'offline', 'finding-route', 'no-direct-route', 'playing', 'warming-up', 'buffering'];
  function groupDelay(snapshot = {}) {
    const c=snapshot.commonStart;
    if(c?.enabled===true&&c.state==='pending')return {seconds:null,label:c.reason==='waiting-for-first-viewer'?'Ready for your mates':'Checking group delay'};
    const selected=c?.enabled===true&&['selected','fallback'].includes(c.state)&&Number.isInteger(c.delaySeconds)&&c.delaySeconds>=30&&c.delaySeconds<=300?c.delaySeconds:null;
    const seconds=selected??snapshot.config?.delay;
    return {seconds:Number.isFinite(seconds)?seconds:null,label:seconds===300?'5-minute group delay':Number.isFinite(seconds)?seconds+'-second group delay':'Checking group delay'};
  }
  function explain({snapshot = {}, room = {}, online = true, elapsedSeconds = 0, pictureMoving} = {}) {
    snapshot = snapshot || {}; room = room || {};
    const joined = room.connected === true;
    const result = (code, title, detail, tone = 'neutral', waiting = false) => ({code, title, detail, tone, waiting, roomJoined: joined});
    const source = room.roomSource?.state;
    const path = snapshot.sourceReachable === true || snapshot.role === 'source' && snapshot.active === true;
    const clockedPath = path && snapshot.clockReady === true;
    const moving = pictureMoving === undefined ? snapshot.ready >= 2 && snapshot.paused === false : pictureMoving === true;
    // Healthy buffered playback is stronger evidence than an expired owner lease
    // or the browser's best-effort online hint. Do not cover a working picture.
    if (snapshot.config && moving) return result('playing', 'You’re watching together.', !path && snapshot.role === 'viewer' ? 'Playing saved video while we look for the source.' : 'Playing smoothly with your room.');
    if (online === false) return result('offline', 'Your device is offline.', 'Reconnect to the internet. We’ll keep your invitation and try again automatically.', 'warning');
    if (joined && source === 'not-started' && !path) return result('waiting-for-source', 'Your room is open.', 'Chat while you wait. The picture joins here when your host shares a screen.', 'neutral', true);
    if ((joined && source === 'stopped' && !path) || snapshot.sourceEnded === true && !snapshot.config) return result('source-stopped', 'The shared screen has stopped.', joined ? 'You’re still in the room. Chat while your host restarts; the same invitation works.' : 'This video share has ended. Ask your host for a room invitation to follow future shares.', 'neutral', true);
    if (joined && source === 'unreachable' && !path) return result('source-unreachable', 'No recent update from the host.', 'Your room and chat are still open. We’re checking the shared screen and will reconnect when it is available.', 'warning', true);
    const target = snapshot.targetProgramTime;
    if(snapshot.config&&clockedPath&&snapshot.commonStart?.enabled===true&&snapshot.commonStart.state==='pending')return result('warming-up',snapshot.commonStart.reason==='waiting-for-first-viewer'?'Ready for your mates':'Checking group delay',snapshot.commonStart.reason==='waiting-for-first-viewer'?'Send your invitation whenever you’re ready. We’ll check the group delay when someone joins.':'You can chat while we prepare the picture.','neutral',true);
    if(snapshot.config&&clockedPath&&Number.isFinite(snapshot.commonStart?.startRemainingSeconds)&&snapshot.commonStart.startRemainingSeconds>0)return result('warming-up','Starting together','Your picture is getting ready for the shared start. Chat stays open.','neutral',true);
    if (snapshot.config && clockedPath && Number.isFinite(target) && target < 0) return result('warming-up', 'Time to get everyone settled.', 'The picture starts together after the group delay. You can chat while you wait.', 'neutral', true);
    if (path && snapshot.config && snapshot.clockReady === true && Number.isFinite(target) && target >= 0 && ['starting', 'rebuffering', 'recovering'].includes(snapshot.playbackAdaptivePhase)) return result('buffering', 'Building a smoother picture…', 'Saving a little more video before restarting. You can keep chatting while it fills.', 'neutral', true);
    const availability = snapshot.transport?.availability;
    if (!path && availability && (availability.lastReject === 'capacity-full' || availability.rootedSuppliers > 0 && availability.fullSuppliers === availability.rootedSuppliers && availability.eligibleSuppliers === 0)) return result('suppliers-full', 'A supplying connection is full.', 'We’re looking for another mate with room to share. You can stay and chat while we try.', 'warning');
    const network = snapshot.network || snapshot.transport?.network;
    const elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
    const exhausted = snapshot.recovery?.state === 'exhausted' || network?.phase === 'failed' || elapsed >= 90;
    if ((joined || snapshot.config || snapshot.joiningBusy) && exhausted && !path) return result('no-direct-route', 'The picture has no direct connection yet.', joined ? 'You’re in the room and can chat. We’re still trying to reach the source or a supplying mate.' : 'We’re still looking for a peer-to-peer route. Keep this invitation open, or try another network.', 'warning');
    if (joined || snapshot.config || snapshot.joiningBusy) return result('finding-route', joined ? 'You’re in the room. Finding the picture…' : 'Finding your private room…', joined ? 'Chat is ready. We’re looking for a direct connection to the shared screen.' : 'We’ll keep trying automatically. Leave this page open.');
    return result('idle', 'Ready when you are.', 'Open an invitation to watch and chat with your mates.');
  }
  window.SameEndRoomStatus = Object.freeze({explain, groupDelay, codes: Object.freeze(codes)});
})();
