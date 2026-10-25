import { DynamoDBStore } from './store.mjs';
import { createApi } from './api.mjs';
import { createPushTransport } from './push.mjs';
import { runReminders } from './reminders.mjs';
import { createCommunityApi } from './community-api.mjs';

const store = new DynamoDBStore(process.env.TABLE_NAME);
const push = createPushTransport({publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject: 'https://www.sameend.com'});
const api = createApi({store, push});
const community = createCommunityApi({store,adminAuth:{issuer:process.env.COMMUNITY_ADMIN_ISSUER||'',clientId:process.env.COMMUNITY_ADMIN_CLIENT_ID||'',domain:process.env.COMMUNITY_ADMIN_DOMAIN||'',redirectUri:process.env.COMMUNITY_ADMIN_REDIRECT_URI||'',enrollmentClientId:process.env.COMMUNITY_ENROLLMENT_CLIENT_ID||''},fanAuth:{issuer:process.env.COMMUNITY_FAN_ISSUER||'',clientId:process.env.COMMUNITY_FAN_CLIENT_ID||'',domain:process.env.COMMUNITY_FAN_DOMAIN||'',redirectUri:process.env.COMMUNITY_FAN_REDIRECT_URI||'',scope:process.env.COMMUNITY_FAN_SCOPE||'sameend-community/use'}});
export async function handler(event) {
  // EventBridge invokes this directly. No HTTP route can invoke the scheduler branch.
  if (event.source === 'aws.events' && event['detail-type'] === 'Scheduled Event' && !event.requestContext) {
    try { return await runReminders({store, push, deleteSubscription: api.deleteSubscription}); }
    catch { throw new Error('Reminder processing temporarily failed'); }
  }
  if((event.rawPath||event.path||'').startsWith('/v1/community/'))return community.handler(event);
  return api.handler(event);
}
