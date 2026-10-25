/* The callback relays only a one-use code. The verifier and tokens stay in the room tab. */
(function () {
  'use strict';
  const url = new URL(location.href), state = url.searchParams.get('state'), code = url.searchParams.get('code'), error = url.searchParams.get('error');
  history.replaceState(null, '', location.pathname);
  const title = document.getElementById('title'), message = document.getElementById('message');
  document.getElementById('close').onclick = () => { window.close(); message.textContent = 'Return to your original Same End tab. You can close this tab using your browser.'; };
  if (!code && !error && !state) { title.textContent = 'You can return to Same End'; message.textContent = 'Your account session has finished here. Close this tab and return to your original room.'; return; }
  if (!/^[A-Za-z0-9_-]{43}$/.test(state || '') || ((!code || code.length > 4096) && !error)) { title.textContent = 'Start sign-in again'; message.textContent = 'Open sign-in from the fan forum in your original Same End tab.'; return; }
  const payload = {type: 'sameend-fan-code-v1', state, ...(error ? {error: true} : {code})};
  let channel, timer, timeout;
  function stop() { clearInterval(timer); clearTimeout(timeout); if (channel) channel.close(); window.removeEventListener('message', receive); }
  function done(data) {
    if (!data || data.type !== 'sameend-fan-result-v1' || data.state !== state) return;
    stop(); title.textContent = data.ok ? 'You’re signed in' : 'Start sign-in again';
    message.textContent = data.ok ? 'Return to your original Same End tab to join the conversation. Your room stayed in place.' : 'Sign-in could not finish. Start again from the fan forum in your original tab.';
  }
  function receive(event) { if (event.origin === location.origin && event.source === window.opener) done(event.data); }
  window.addEventListener('message', receive);
  if (typeof BroadcastChannel === 'function') { channel = new BroadcastChannel('sameend-fan-' + state); channel.onmessage = event => done(event.data); }
  function send() { try { if (window.opener) window.opener.postMessage(payload, location.origin); } catch (_) {} if (channel) channel.postMessage(payload); }
  send(); timer = setInterval(send, 750);
  timeout = setTimeout(() => { stop(); title.textContent = 'Return to your original tab'; message.textContent = 'If sign-in did not finish there, start it again from the fan forum. You can close this account tab.'; }, 25000);
  window.addEventListener('pagehide', stop);
})();
