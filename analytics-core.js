/* Fixed activity names only. No URLs, identities, timestamps or event metadata. */
(() => {
  'use strict';
  const VERSION = 1, CHOICE_KEY = 'sameend-privacy-v1', CHOICE_DAYS = 180;
  const EVENTS = Object.freeze(['page_view', 'share_started', 'invitation_copied']);
  function readChoice(storage, now = Date.now()) {
    try {
      const value = JSON.parse(storage.getItem(CHOICE_KEY));
      if (!value || value.v !== VERSION || !['allow', 'decline'].includes(value.analytics) ||
          !Number.isFinite(value.savedAt) || value.savedAt > now || now - value.savedAt >= CHOICE_DAYS * 86400000) return null;
      return value.analytics;
    } catch (_) { return null; }
  }
  function createTracker({url, request, controller = () => new AbortController(), schedule = setTimeout, unschedule = clearTimeout} = {}) {
    let allowed = false, remaining = 60, disposed = false;
    const pending = new Set();
    const stop = () => { for (const item of pending) { item.abort.abort(); unschedule(item.timer); } pending.clear(); };
    return Object.freeze({
      consent(value) { allowed = value === true && !disposed; if (!allowed) stop(); },
      track(event) {
        if (!allowed || disposed || !EVENTS.includes(event) || remaining <= 0 || pending.size >= 3 || !url || typeof request !== 'function') return false;
        remaining--;
        const item = {abort: controller(), timer: null}; pending.add(item);
        item.timer = schedule(() => { item.abort.abort(); pending.delete(item); }, 4000);
        try {
          Promise.resolve(request(url, {
            method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
            headers: {'Content-Type': 'application/json'}, body: JSON.stringify({v: VERSION, event}), signal: item.abort.signal
          })).catch(() => {}).finally(() => { unschedule(item.timer); pending.delete(item); });
        } catch (_) { unschedule(item.timer); pending.delete(item); }
        // Deliberately no queue or retry: declined/past activity is never replayed.
        return true;
      },
      dispose() { allowed = false; disposed = true; stop(); }
    });
  }
  globalThis.SameEndAnalyticsCore = Object.freeze({VERSION, CHOICE_KEY, CHOICE_DAYS, EVENTS, readChoice, createTracker});
})();
