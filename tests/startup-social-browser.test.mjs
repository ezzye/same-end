/* Isolated regression: picture join must start while bundled-invite chat loads. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createApi } from '../backend/api.mjs';
import { MemoryStore } from '../backend/store.mjs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import(process.env.SAMEEND_PLAYWRIGHT || '/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')); }
const root = new URL('../', import.meta.url), js = await readFile(new URL('social.js', root), 'utf8'), css = await readFile(new URL('social.css', root), 'utf8');
const origin = 'http://127.0.0.1:18893', store = new MemoryStore();
const api = createApi({ store, push: { enabled: false }, allowedOrigins: [origin] });
let heldPath = null, heldRequest = null, releaseHeld;
const held = new Promise(resolve => { heldRequest = resolve; });
let offline = false;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, origin);
  if (heldPath === u.pathname && req.method === 'GET') {
    heldPath = null; heldRequest();
    await new Promise(resolve => { releaseHeld = resolve; });
  }
  if (offline && u.pathname.startsWith('/api/v1/clubs/')) { res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"offline chat fixture"}'); return; }
  if (u.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const result = await api.handler({ rawPath: u.pathname.slice(4), headers: req.headers, body: Buffer.concat(chunks).toString(), queryStringParameters: Object.fromEntries(u.searchParams), requestContext: { http: { method: req.method, sourceIp: 'startup-social-test' } } });
    res.writeHead(result.statusCode, result.headers).end(result.body); return;
  }
  if (u.pathname === '/fixtures.json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"fixtures":[]}'); return; }
  res.writeHead(200, { 'content-type': 'text/html', 'referrer-policy': 'no-referrer' }).end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:20px;font:16px system-ui}button,input,textarea,select{font:inherit}input,textarea,select{width:100%}[hidden]{display:none!important}${css}</style><main><section id="club-social"></section><section id="watch-room"><div class="stage"><video id="player"></video></div><input id="magnet-link"><div id="room-status"></div><div id="room-social-status"></div><div id="room-chat"></div></section></main><script>window.SameEndConfig={apiBase:'/api'};window.SameEndFixtures=[];window.PrivateCast={calls:[],joinMagnet(m){this.calls.push(m);return Promise.resolve()},snapshot(){return {active:false,role:'source',config:null}}};</script><script>${js}</script>`);
});
await new Promise(resolve => server.listen(18893, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const contexts = [], errors = [];
async function page() { const c = await browser.newContext(); contexts.push(c); const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); await p.goto(origin); await p.waitForFunction(() => window.SameEndSocial?.snapshot().ready); return p; }
try {
  const owner = await page();
  await owner.evaluate(() => SameEndSocial.createClub({ name: 'Startup club', theme: 'red' }));
  const stableInvite = await owner.evaluate(() => SameEndSocial.castInvitation('magnet:?xt=urn:btih:startup#pc=private-test'));
  const invite = stableInvite.replace('&watch=1', '') + '&join=' + encodeURIComponent('magnet:?xt=urn:btih:startup#pc=private-test');
  const clubId = new URL(invite).hash.match(/club=([0-9a-f-]{36})\./i)?.[1];
  assert(clubId, 'bundled screen invitation includes private club credentials');

  heldPath = `/api/v1/clubs/${decodeURIComponent(clubId)}`;
  const viewer = await page();
  await viewer.goto(invite);
  await Promise.race([held, new Promise((_, reject) => setTimeout(() => reject(Error('viewer chat request was not held')), 5000))]);
  const calledBeforeChatSettled = await viewer.evaluate(() => PrivateCast.calls.length);
  releaseHeld();
  await viewer.waitForFunction(() => SameEndSocial.snapshot().connected);
  assert.equal(await viewer.evaluate(() => location.hash), '', 'private invitation fragment is removed');
  assert.equal(await viewer.evaluate(() => PrivateCast.calls.length), 1, 'picture join called exactly once');
  assert.equal(calledBeforeChatSettled, 1, 'picture join starts before the held chat request settles');
  assert.equal(await viewer.locator('#club-chat-shell').isVisible(), true, 'chat opens after the gate is released');

  offline = true;
  const failedChat = await page();
  await failedChat.goto(invite);
  await failedChat.waitForFunction(() => PrivateCast.calls.length === 1);
  await failedChat.waitForFunction(() => document.body.innerText.includes('club service to reconnect'));
  assert.equal(await failedChat.evaluate(() => PrivateCast.calls.length), 1, 'picture join still called exactly once after chat failure');
  assert.match(await failedChat.locator('#club-notice').textContent(), /club service to reconnect/i, 'transient chat failure explains automatic recovery separately');
  offline = false;
  await failedChat.waitForFunction(() => SameEndSocial.snapshot().connected, null, {timeout:45000});
  assert.equal(await failedChat.evaluate(() => PrivateCast.calls.length), 1, 'chat recovery does not duplicate the legacy picture join');
  assert.deepEqual(errors, []);
  console.log('PASS: bundled picture join starts during held chat read; fragment clears; chat opens; offline chat failure still starts picture exactly once.');
} finally {
  releaseHeld?.();
  await Promise.all(contexts.map(c => c.close())); await browser.close(); await new Promise(resolve => server.close(resolve));
}
