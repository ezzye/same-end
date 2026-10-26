/* Optional first-party activity counts. Refusal never blocks the service. */
(() => {
  'use strict';
  const core = globalThis.SameEndAnalyticsCore;
  if (!core || window.SameEndPrivacy) return;
  const $ = id => document.getElementById(id);
  const storage = () => { try { return window.localStorage; } catch (_) { return null; } };
  let choice = core.readChoice(storage()), pageCounted = false, sharing = false, disposed = false, returnFocus = null;
  const web = /^https?:$/.test(location.protocol);
  let endpoint = '';
  if (web) {
    const configured = window.SameEndConfig?.apiBase;
    if (!configured) endpoint = new URL('/api/v1/analytics/events', location.origin).href;
    else if (/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(configured)) endpoint = configured + '/v1/analytics/events';
  }
  const tracker = core.createTracker({url: endpoint, request: (url, options) => {
    if (navigator.onLine === false) return Promise.resolve();
    return fetch(url, options);
  }});
  function refreshPermission() {
    // Check expiry again at every send, not only when the page first opens.
    if (choice === 'allow' && core.readChoice(storage()) !== 'allow') { choice = null; tracker.consent(false); show(false); }
    tracker.consent(choice === 'allow' && web && !disposed);
  }
  function track(name) { refreshPermission(); return tracker.track(name); }
  function pageView() { if (!pageCounted && choice === 'allow' && track('page_view')) pageCounted = true; }
  function space() {
    const banner = $('privacy-banner');
    document.body.classList.toggle('privacy-choice-visible', !banner.hidden);
    document.body.style.setProperty('--privacy-space', banner.hidden ? '0px' : (banner.getBoundingClientRect().height + 30) + 'px');
  }
  function render() {
    $('privacy-current').textContent = choice === 'allow' ? 'Analytics are currently allowed on this browser.' : choice === 'decline' ? 'Analytics are currently off on this browser.' : '';
    space();
  }
  function show(focus = true) { if (disposed) return; const banner = $('privacy-banner'); if (!banner) return; banner.hidden = false; render(); if (focus) $('privacy-allow').focus(); }
  function choose(value) {
    choice = value;
    // Stop in-flight work immediately when consent is withdrawn. Already
    // delivered aggregate counts cannot be removed by identifying a visitor.
    tracker.consent(value === 'allow' && web);
    let saved = false;
    try { storage().setItem(core.CHOICE_KEY, JSON.stringify({v: core.VERSION, analytics: value, savedAt: Date.now()})); saved = true; } catch (_) {}
    if (value === 'allow' && !saved) {
      choice = null; tracker.consent(false);
      $('privacy-current').textContent = 'This browser could not save your choice, so analytics stay off.';
      return;
    }
    $('privacy-banner').hidden = true; $('privacy-detail').hidden = true; $('privacy-details').setAttribute('aria-expanded', 'false'); space();
    if (returnFocus?.isConnected) returnFocus.focus(); else $('privacy-open').focus();
    pageView();
  }
  function init() {
    if (!$('privacy-banner')) return;
    $('privacy-open').addEventListener('click', () => { returnFocus = $('privacy-open'); show(); });
    $('privacy-allow').addEventListener('click', () => choose('allow'));
    $('privacy-decline').addEventListener('click', () => choose('decline'));
    $('privacy-details').addEventListener('click', () => { const detail = $('privacy-detail'); detail.hidden = !detail.hidden; $('privacy-details').setAttribute('aria-expanded', String(!detail.hidden)); space(); });
    if (typeof ResizeObserver === 'function') new ResizeObserver(space).observe($('privacy-banner'));
    window.addEventListener('resize', space);
    window.addEventListener('storage', event => {
      if (event.key !== core.CHOICE_KEY && event.key !== null) return;
      choice = core.readChoice(storage()); tracker.consent(choice === 'allow' && web);
      if (choice === null) show(false); else { $('privacy-banner').hidden = true; render(); }
      // Consent in a different tab does not replay activity in this tab.
    });
    window.addEventListener('sameend:castchange', () => {
      const snapshot = window.PrivateCast?.snapshot();
      const active = !!(snapshot?.active && snapshot.role === 'source');
      if (active && !sharing) track('share_started');
      sharing = active;
    });
    window.addEventListener('pagehide', () => { disposed = true; tracker.consent(false); });
    // A restored page must re-evaluate consent before it sends anything.
    window.addEventListener('pageshow', event => { if (event.persisted) { disposed = false; refreshPermission(); } });
    if (choice === null) show(false); else render();
    refreshPermission(); pageView();
  }
  window.SameEndPrivacy = Object.freeze({track, open: () => show(), choice: () => choice});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})();
