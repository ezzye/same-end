/* Mark 2 Pages only: retire the obsolete root /sw.js registration.
 * Wait for all old controlled clients to close before replacing their worker:
 * active legacy rooms may still need its media routes. Never force activation.
 * There is deliberately no fetch handler: requests use the normal network.
 * A stale homepage can persist until every old controlled page is closed.
 */
// No install, message or fetch handler, skipWaiting, or clients.claim.
self.addEventListener('activate', event => {
  if (self.registration.scope === self.location.origin + '/') {
    event.waitUntil(self.registration.unregister());
  }
});
