/* Pilot accounts live only in memory. Authentication always leaves the room tab in place. */
(function () {
  'use strict';
  const MAX_AGE = 10 * 60 * 1000, TYPE = 'sameend-fan-code-v1', RESULT = 'sameend-fan-result-v1';
  let config = null, session = null, pending = null, expiry = null;
  const listeners = new Set();
  const loopback = host => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host);
  const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
  function announce(type, message) { for (const fn of listeners) { try { fn({type, message: message || ''}); } catch (_) {} } }
  function dropSession() { clearTimeout(expiry); expiry = null; session = null; }
  function cleanup(tx) { clearTimeout(tx.timer); if (tx.channel) tx.channel.close(); if (pending === tx) pending = null; tx.verifier = ''; }
  function cancel(message) {
    const tx = pending; if (!tx) return;
    cleanup(tx); tx.reject(new Error(message));
    try { tx.child.close(); } catch (_) {}
  }
  function clearSession(reason) { cancel('Sign-in was cancelled.'); dropSession(); announce(reason === 'expired' ? 'expired' : 'signed-out'); }
  function configure(value) {
    const redirect = new URL(value.redirectUri), domain = new URL(value.domain), issuer = new URL(value.issuer);
    const local = location.protocol === 'http:' && loopback(location.hostname);
    if ((!local && location.protocol !== 'https:') || redirect.origin !== location.origin || redirect.pathname !== '/fan-signin.html' || redirect.search || redirect.hash || redirect.username || redirect.password || (redirect.protocol !== 'https:' && !local)) throw new Error('Open Same End at its secure web address to sign in.');
    if (domain.protocol !== 'https:' || !/^[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(domain.hostname) || domain.pathname !== '/' || domain.search || domain.hash || domain.username || domain.password) throw new Error('Pilot sign-in is not configured correctly.');
    if (issuer.protocol !== 'https:' || !/^cognito-idp\.[a-z0-9-]+\.amazonaws\.com$/.test(issuer.hostname) || !/^\/[A-Za-z0-9_-]+$/.test(issuer.pathname) || issuer.search || issuer.hash || issuer.username || issuer.password || !/^[A-Za-z0-9]{1,128}$/.test(value.clientId) || value.scope !== 'sameend-community/use') throw new Error('Pilot sign-in is not configured correctly.');
    const next = {issuer: issuer.href, clientId: value.clientId, domain: domain.origin, redirectUri: redirect.href, scope: value.scope};
    if (config && JSON.stringify(config) !== JSON.stringify(next)) clearSession();
    config = next;
  }
  function decode(token) {
    if (typeof token !== 'string' || token.length > 16384) throw new Error('The sign-in response was not valid.');
    const parts = token.split('.'); if (parts.length !== 3) throw new Error('The sign-in response was not valid.');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
  }
  // These checks bind the browser response to this transaction; the API verifies signatures and access claims.
  function inspect(tokens, tx) {
    const id = decode(tokens.id_token), access = decode(tokens.access_token), now = Date.now() / 1000;
    for (const c of [id, access]) if (c.iss !== tx.config.issuer || typeof c.sub !== 'string' || !c.sub || !Number.isFinite(c.exp) || c.exp <= now || (c.iat !== undefined && (!Number.isFinite(c.iat) || c.iat > now + 30))) throw new Error('The sign-in response expired or did not match. Start again.');
    if (id.token_use !== 'id' || id.aud !== tx.config.clientId || id.nonce !== tx.nonce || id.email_verified !== true || access.token_use !== 'access' || access.client_id !== tx.config.clientId || access.sub !== id.sub || typeof access.scope !== 'string' || !access.scope.split(' ').includes(tx.config.scope)) throw new Error('The sign-in response did not match your account. Start again.');
    return {token: tokens.access_token, expiresAt: Math.min(id.exp, access.exp) * 1000};
  }
  async function receive(data, tx) {
    if (pending !== tx || tx.used || !data || data.type !== TYPE || data.state !== tx.state) return;
    if (Date.now() - tx.createdAt > MAX_AGE || Date.now() < tx.createdAt - 10000) return cancel('Sign-in expired. Start again.');
    if (data.error) return cancel('Sign-in was cancelled or could not finish. Start again when you are ready.');
    if (typeof data.code !== 'string' || !data.code || data.code.length > 4096) return;
    tx.used = true;
    try {
      const response = await fetch(tx.config.domain + '/oauth2/token', {method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20000) : undefined, headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: tx.config.clientId, redirect_uri: tx.config.redirectUri, code: data.code, code_verifier: tx.verifier})});
      if (!response.ok) throw new Error('Sign-in could not finish. Start again.');
      const tokens = await response.json();
      if (pending !== tx) return;
      const next = inspect(tokens, tx);
      const result = {type: RESULT, state: tx.state, ok: true};
      try { tx.child.postMessage(result, location.origin); } catch (_) {}
      if (tx.channel) tx.channel.postMessage(result);
      cleanup(tx); dropSession(); session = next;
      expiry = setTimeout(() => clearSession('expired'), Math.max(1, next.expiresAt - Date.now()));
      announce('signed-in'); tx.resolve();
    } catch (_) {
      if (pending !== tx) return;
      const result = {type: RESULT, state: tx.state, ok: false};
      try { tx.child.postMessage(result, location.origin); } catch (_) {}
      if (tx.channel) tx.channel.postMessage(result);
      cleanup(tx); dropSession(); announce('error', 'Sign-in could not finish. Start again.'); tx.reject(new Error('Sign-in could not finish. Start again.'));
    }
  }
  function signIn() {
    if (!config) return Promise.reject(new Error('Pilot sign-in is still connecting. Try again in a moment.'));
    cancel('A newer sign-in was started.');
    // Reserve the account tab in the click handler, before any asynchronous work.
    const child = window.open('about:blank', '_blank');
    if (!child) return Promise.reject(new Error('Allow Same End to open an account tab, then try again. Your room stays here.'));
    try { child.document.title = 'Same End account'; child.document.body.textContent = 'Opening secure Same End sign-in… Your room stays in its original tab.'; } catch (_) {}
    return new Promise((resolve, reject) => {
      const tx = {config: {...config}, child, resolve, reject, state: random(), nonce: random(), verifier: random(), createdAt: Date.now(), used: false}; pending = tx;
      tx.timer = setTimeout(() => cancel('Sign-in expired. Start again.'), MAX_AGE);
      if (typeof BroadcastChannel === 'function') { tx.channel = new BroadcastChannel('sameend-fan-' + tx.state); tx.channel.onmessage = event => receive(event.data, tx); }
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(tx.verifier)).then(hash => {
        if (pending !== tx) return;
        const url = new URL('/oauth2/authorize', tx.config.domain);
        url.search = new URLSearchParams({response_type: 'code', client_id: tx.config.clientId, redirect_uri: tx.config.redirectUri, scope: 'openid email ' + tx.config.scope, state: tx.state, nonce: tx.nonce, code_challenge: b64(new Uint8Array(hash)), code_challenge_method: 'S256'}).toString();
        child.location.replace(url.href);
      }).catch(() => { if (pending === tx) cancel('This browser could not start secure sign-in.'); });
    });
  }
  function signOut() {
    clearSession();
    if (!config) return;
    const url = new URL('/logout', config.domain); url.search = new URLSearchParams({client_id: config.clientId, logout_uri: config.redirectUri}).toString();
    const child = window.open(url.href, '_blank');
    if (!child) announce('signed-out', 'Signed out here. Allow an account tab to also end the provider session.');
  }
  function signedIn() { if (session && session.expiresAt <= Date.now()) clearSession('expired'); return !!session; }
  window.addEventListener('message', event => { const tx = pending; if (tx && event.origin === location.origin && event.source === tx.child) receive(event.data, tx); });
  window.addEventListener('pagehide', () => { cancel('The room page was closed. Sign in again after opening it.'); dropSession(); });
  window.addEventListener('pageshow', event => { if (event.persisted) clearSession(); });
  window.SameEndFanAuth = {configure, signIn, signOut, clearSession, signedIn, accessToken: () => signedIn() ? session.token : '', onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); }};
})();
