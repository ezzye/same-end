import {createHash} from 'node:crypto';
import {Conflict} from './store.mjs';

const DAY = 86400000, RETENTION = 90 * 86400;
const EVENTS = ['page_view', 'share_started', 'invitation_copied'];
const digest = value => createHash('sha256').update(value).digest('hex');
const expiry = now => Math.floor(now / 1000) + RETENTION;
const dateFor = time => new Date(time).toISOString().slice(0, 10);
const pkFor = day => `ANALYTICS#${day}`;

export function createAnalytics({store, now = Date.now} = {}) {
  async function collect(event, origin, allowedOrigins, sourceIp) {
    if (origin == null || !allowedOrigins.includes(origin)) throw Object.assign(new Error('Open Same End from its usual address.'), {status: 403, code: 'origin_not_allowed'});
    if (!event || event.v !== 1 || Object.keys(event).length !== 2 || !EVENTS.includes(event.event)) throw Object.assign(new Error('That analytics event is not valid.'), {status: 400, code: 'invalid_event'});
    const time = now(), day = dateFor(time), bucketEnd = Math.floor(time / DAY) * DAY + DAY;
    const ipHash = digest(`${day}/${sourceIp || 'isolated'}`);
    try {
      await store.consume(`analytics-ip-${ipHash}`, 600, Math.floor(bucketEnd / 1000) + 3600);
      await store.transact([
        {key: {pk: 'RATE#analytics-global', sk: day}, add: {count: 1}, set: {expiresAt: expiry(time)}, condition: {attribute: 'count', lt: 10000}},
        {key: {pk: pkFor(day), sk: 'COUNTERS'}, add: {[event.event]: 1}, set: {day, expiresAt: expiry(time)}}
      ]);
    } catch (error) {
      if (error instanceof Conflict) throw Object.assign(new Error('The analytics service has reached its daily limit. Try again tomorrow.'), {status: 429, code: 'daily_limit'});
      throw error;
    }
    return {accepted: true};
  }
  async function summary(days) {
    const end = Math.floor(now() / DAY) * DAY;
    const result = [];
    for (let offset = days - 1; offset >= 0; offset--) {
      const day = dateFor(end - offset * DAY), row = await store.get(pkFor(day), 'COUNTERS');
      result.push({day, page_view: row?.expiresAt > now() / 1000 ? row.page_view || 0 : 0, share_started: row?.expiresAt > now() / 1000 ? row.share_started || 0 : 0, invitation_copied: row?.expiresAt > now() / 1000 ? row.invitation_copied || 0 : 0});
    }
    return {days: result};
  }
  return {collect, summary};
}

export {EVENTS};
