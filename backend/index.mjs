import { DynamoDBStore } from './store.mjs';
import { createApi } from './api.mjs';
import { createPushTransport } from './push.mjs';
import { runReminders } from './reminders.mjs';

const store = new DynamoDBStore(process.env.TABLE_NAME);
const push = createPushTransport({publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject: 'https://www.sameend.com'});
const api = createApi({store, push});
export async function handler(event) {
  // EventBridge invokes this directly. No HTTP route can invoke the scheduler branch.
  if (event.source === 'aws.events' && event['detail-type'] === 'Scheduled Event' && !event.requestContext) {
    try { return await runReminders({store, push, deleteSubscription: api.deleteSubscription}); }
    catch { throw new Error('Reminder processing temporarily failed'); }
  }
  return api.handler(event);
}
