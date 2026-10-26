import http from 'node:http';
import { MemoryStore } from './store.mjs';
import { createApi, LIMITS } from './api.mjs';
import { createPushTransport } from './push.mjs';
import {createCommunityApi} from './community-api.mjs';
import {LocalFileStore} from './local-file-store.mjs';

const store = process.env.SAME_END_LOCAL_STATE_FILE?await LocalFileStore.open(process.env.SAME_END_LOCAL_STATE_FILE):new MemoryStore();
const push = createPushTransport({publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY});
const webPort=Number(process.env.SAME_END_LOCAL_WEB_PORT||8792);
const allowedOrigins=[`http://localhost:${webPort}`,`http://127.0.0.1:${webPort}`];
const api = createApi({store, push, allowedOrigins});
const community=createCommunityApi({store,allowedOrigins,localAdminTokenHash:process.env.SAME_END_LOCAL_ADMIN_TOKEN_HASH||''});
// Explicit local fixture bootstrap; production migrations are operator-owned.
await community.backfillListings({dryRun:false,paceMs:0});
const server = http.createServer(async (request, response) => {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > LIMITS.requestBytes) { response.writeHead(413, {'content-type': 'application/json'}).end(JSON.stringify({code: 'payload_too_large', error: 'That club update is too large.'})); return; }
    chunks.push(chunk);
  }
  const url = new URL(request.url, 'http://localhost');
  const target=url.pathname.startsWith('/v1/community/')?community:api;
  const result = await target.handler({rawPath: url.pathname, headers: request.headers, queryStringParameters: Object.fromEntries(url.searchParams), body: Buffer.concat(chunks).toString(), requestContext: {http: {method: request.method, sourceIp: request.socket.remoteAddress}}});
  response.writeHead(result.statusCode, result.headers).end(result.body);
});
server.listen(Number(process.env.PORT || 8795), '127.0.0.1', () => console.log('Same End local API ready; '+(process.env.SAME_END_LOCAL_STATE_FILE?'review data persists locally.':'in-memory data resets on restart.')));
async function close(){server.close();await store.close?.();process.exit(0);}
process.once('SIGTERM',close);process.once('SIGINT',close);
