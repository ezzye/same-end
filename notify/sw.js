/* Tell me (ADR-123). Shows a notification when someone this browser's person follows starts a room.
 * It has no fetch handler and no cache, and its scope, /notify/, holds no pages: every page still loads from the network.
 * The message was encrypted to this browser by the owner's browser. The coordinator that passed it on could not read it.
 */
const bytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), letter => letter.charCodeAt(0));
const isKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const TWO_HOURS = 2 * 60 * 60 * 1000;

// The people this browser's person follows are kept by the page in IndexedDB. Nothing is written here.
function following(key) {
  return new Promise(resolve => {
    try {
      const open = indexedDB.open('same-end-follows', 1);
      open.onupgradeneeded = () => open.transaction.abort();
      open.onerror = () => resolve();
      open.onsuccess = () => {
        const db = open.result;
        try {
          const read = db.transaction('people').objectStore('people').get('following:' + key);
          read.onsuccess = () => { resolve(read.result); db.close(); };
          read.onerror = () => { resolve(); db.close(); };
        } catch { resolve(); db.close(); }
      };
    } catch { resolve(); }
  });
}

async function words(event) {
  // Every push shows something: a browser withdraws permission from a site that receives one and shows nothing.
  const plain = {title: 'Same End', body: 'A room has started.', tag: 'same-end-room'};
  try {
    const sent = event.data.json();
    if (!isKey(sent.o) || typeof sent.r !== 'string' || sent.r.length > 64 || typeof sent.t !== 'string' || !sent.t || sent.t.length > 80 ||
        !Number.isSafeInteger(sent.a) || Math.abs(Date.now() - sent.a) > TWO_HOURS || typeof sent.s !== 'string') return plain;
    const person = await following(sent.o);
    if (!person || person.key !== sent.o) return plain;
    const key = await crypto.subtle.importKey('raw', bytes(sent.o), 'Ed25519', false, ['verify']);
    const signed = new TextEncoder().encode(JSON.stringify(['same-end-tell-room-v1', sent.o, sent.r, sent.t, sent.a]));
    if (!await crypto.subtle.verify('Ed25519', key, bytes(sent.s), signed)) return plain;
    const name = typeof person.nickname === 'string' && person.nickname ? person.nickname : 'Someone you follow';
    return {title: name + ' started a room', body: sent.t, tag: 'same-end-' + sent.r};
  } catch { return plain; }
}

self.addEventListener('push', event => event.waitUntil(words(event).then(({title, body, tag}) =>
  self.registration.showNotification(title, {body, tag, icon: '/icons/app-192.png', badge: '/icons/app-192.png', data: {url: '/'}}))));

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    const page = open.find(client => new URL(client.url).origin === self.location.origin);
    if (page) return page.focus();
    return self.clients.openWindow('/');
  })());
});
