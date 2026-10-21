import webpush from 'web-push';
import { createECDH } from 'node:crypto';

export const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
export function validateSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) throw new Error('Invalid push subscription');
  if (typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 2048) throw new Error('Invalid push endpoint');
  const url = new URL(subscription.endpoint);
  // Exact provider host or Apple push subdomain; no arbitrary hosts, credentials, custom ports or fragments.
  const hostAllowed = PUSH_HOSTS.includes(url.hostname) || /^[a-z0-9-]+\.push\.apple\.com$/.test(url.hostname);
  if (url.protocol !== 'https:' || !hostAllowed || url.username || url.password || url.port && url.port !== '443' || url.hash || url.pathname.length < 2) throw new Error('Push service is not supported');
  const key = subscription.keys;
  if (!key || !base64url(key.auth, 16) || !base64url(key.p256dh, 65)) throw new Error('Invalid push keys');
  try { const dh = createECDH('prime256v1'); dh.generateKeys(); dh.computeSecret(Buffer.from(key.p256dh, 'base64url')); } catch { throw new Error('Invalid push public key'); }
  return {endpoint: url.href, keys: {auth: key.auth, p256dh: key.p256dh}};
}
function base64url(value, bytes) { return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').length === bytes && Buffer.from(value, 'base64url').toString('base64url') === value; }
export function payloadFor(clubId, eventId) {
  return {title: 'Your mates are gathering', body: 'Open Same End for your private match room.', clubId, ...(eventId && {eventId}), url: `https://www.sameend.com/#openclub=${clubId}`};
}
export function createPushTransport({publicKey = '', privateKey = '', subject = 'https://www.sameend.com'} = {}) {
  const enabled = !!(publicKey && privateKey);
  return {enabled, publicKey: enabled ? publicKey : '', async send(subscription, payload) {
    if (!enabled) throw Object.assign(new Error('Push is not configured'), {statusCode: 503});
    validateSubscription(subscription);
    // Redirects are not followed by web-push. Timeout keeps retries and scheduler duration bounded.
    await webpush.sendNotification(subscription, JSON.stringify(payload), {vapidDetails: {subject, publicKey, privateKey}, TTL: 900, urgency: 'normal', timeout: 6000});
  }};
}
