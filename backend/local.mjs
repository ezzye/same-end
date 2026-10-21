import http from 'node:http';
import { MemoryStore } from './store.mjs';
import { createApi, LIMITS } from './api.mjs';
import { createPushTransport } from './push.mjs';

const store = new MemoryStore();
const push = createPushTransport({publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY});
const api = createApi({store, push, allowedOrigins: ['http://localhost:8792', 'http://127.0.0.1:8792']});
const server = http.createServer(async (request, response) => {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > LIMITS.requestBytes) { response.writeHead(413, {'content-type': 'application/json'}).end(JSON.stringify({code: 'payload_too_large', error: 'That club update is too large.'})); return; }
    chunks.push(chunk);
  }
  const url = new URL(request.url, 'http://localhost');
  const result = await api.handler({rawPath: url.pathname, headers: request.headers, queryStringParameters: Object.fromEntries(url.searchParams), body: Buffer.concat(chunks).toString(), requestContext: {http: {method: request.method, sourceIp: request.socket.remoteAddress}}});
  response.writeHead(result.statusCode, result.headers).end(result.body);
});
server.listen(Number(process.env.PORT || 8795), '127.0.0.1', () => console.log('Same End private local API is ready on 127.0.0.1:8795; in-memory data resets on restart; Web Push ' + (push.enabled ? 'configured.' : 'disabled.')));
