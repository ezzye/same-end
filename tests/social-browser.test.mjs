/* Isolated browser acceptance: no user profile, no permission grants, ephemeral in-memory API. */
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
const store = new MemoryStore(), origin = 'http://127.0.0.1:18892';
const api = createApi({ store, push: { enabled: false }, allowedOrigins: [origin] });
let conflicts = 0; const requests = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, origin); requests.push({ path: u.pathname, referer: req.headers.referer || '' });
  if (u.pathname.startsWith('/api/')) { const chunks = []; for await (const c of req) chunks.push(c); const result = await api.handler({ rawPath: u.pathname.slice(4), headers: req.headers, body: Buffer.concat(chunks).toString(), queryStringParameters: Object.fromEntries(u.searchParams), requestContext: { http: { method: req.method, sourceIp: 'social-test' } } }); if (result.statusCode === 409) conflicts++; res.writeHead(result.statusCode, result.headers).end(result.body); return; }
  if (u.pathname === '/fixtures.json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"fixtures":[]}'); return; }
  res.writeHead(200, { 'content-type': 'text/html', 'referrer-policy': 'no-referrer' }).end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:20px;font:16px system-ui}button,input,textarea,select{font:inherit}input,textarea,select{width:100%}[hidden]{display:none!important}${css}</style><main><section id="club-social"></section><section id="watch-room"><div class="stage"><video id="player"></video></div><input id="magnet-link"></section></main><script>window.SameEndConfig={apiBase:'/api'};window.SameEndFixtures=[];window.PrivateCast={state:{active:false,role:'source',config:null},snapshot(){return this.state},joinMagnet(m){this.joined=!!m;this.state={active:true,role:'viewer',config:{id:'test'}}},async leaveRoom(){this.state={active:false,role:null,config:null,peers:[]}}};</script><script>${js}</script>`);
});
await new Promise(resolve => server.listen(18892, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const contexts = []; const errors = [];
async function page(blockedStorage = false) { const c = await browser.newContext(); if (blockedStorage) await c.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: { open() { throw Error('Storage unavailable for isolated acceptance test'); } } })); contexts.push(c); const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); await p.goto(origin); await p.waitForFunction(() => window.SameEndSocial?.snapshot().ready); return p; }
try {
  const owner = await page();
  await owner.evaluate(() => SameEndSocial.createClub({ name: 'Acceptance club', theme: 'red' }));
  assert.equal(await owner.locator('#club-name').textContent(), 'Acceptance club');
  assert.equal(await owner.locator('#club-chat-shell').isVisible(), true, 'chat visible before a cast');
  const invite = await owner.locator('#club-invite-url').inputValue(); assert(!invite.includes('owner='));
  await owner.locator('.club-settings > summary').click(); await owner.locator('.club-owner-link > summary').click(); await owner.locator('#club-owner-reveal').click();
  const ownerInvite = await owner.locator('#club-owner-url').inputValue(); assert(ownerInvite.includes('owner='));
  const member = await page(); await member.goto(invite); await member.waitForFunction(() => window.SameEndSocial?.snapshot().ready);
  assert.equal(await member.evaluate(() => location.hash), '');
  await member.locator('#club-join-submit').click(); await member.waitForFunction(() => SameEndSocial.snapshot().connected);
  assert.equal(await member.evaluate(() => SameEndSocial.snapshot().owner), false);
  assert.equal(await member.locator('#club-plan').isVisible(), false);
  await assert.rejects(() => member.evaluate(() => SameEndSocial.updateClub({ name: 'Denied edit' })), /Only the organiser/);
  await owner.evaluate(() => SameEndSocial.saveEvent({ title: 'Private final', startsAt: Date.now() + 86400000, reminderMinutes: 15 }));
  await member.waitForFunction(() => SameEndSocial.snapshot().eventCount === 1);
  const calendar = await owner.evaluate(() => SameEndSocial.calendarText(SameEndSocial.snapshot().events[0].id));
  await owner.locator('#club-diary > summary').click();
  const downloadEvent = owner.waitForEvent('download'); await owner.locator('.club-event-actions button').first().click(); const calendarDownload = await downloadEvent; assert.equal(calendarDownload.suggestedFilename(), 'same-end-match.ics'); assert.equal((await readFile(await calendarDownload.path(), 'utf8')).replace(/DTSTAMP:.*\r\n/, ''), calendar.replace(/DTSTAMP:.*\r\n/, ''));
  assert(calendar.includes('BEGIN:VALARM')); assert(calendar.includes('TRIGGER:-PT15M')); assert(calendar.includes('URL:')); assert(!calendar.includes('owner='));
  const timeChecks = await owner.evaluate(() => ({ winter: SameEndSocial.londonTime('2027-01-10T15:00'), summer: SameEndSocial.londonTime('2027-07-10T15:00'), gap: SameEndSocial.londonCandidates('2027-03-28T01:30'), duplicate: SameEndSocial.londonCandidates('2026-10-25T01:30'), bad: (() => { try { SameEndSocial.londonTime('2026-10-25T01:30'); return false; } catch { return true; } })() }));
  assert.equal(new Date(timeChecks.winter).toISOString(), '2027-01-10T15:00:00.000Z'); assert.equal(new Date(timeChecks.summer).toISOString(), '2027-07-10T14:00:00.000Z'); assert.equal(timeChecks.gap.length, 0); assert.equal(timeChecks.duplicate.length, 2); assert(timeChecks.bad);
  await owner.evaluate(() => { window.controlMessages = []; SameEndSocial.onMessage(m => { if (m.payload.kind === 'rehearsal') controlMessages.push(m.payload.phase); }); });
  await member.evaluate(() => SameEndSocial.postEncryptedMessage('rehearsal', { phase: 'ready' }));
  await owner.waitForFunction(() => controlMessages.includes('ready'));
  assert.equal(await owner.evaluate(() => SameEndSocial.snapshot().chatCount), 0);
  const xss = '<img src=x onerror="window.testXss=1">';
  await member.evaluate(text => SameEndSocial.sendChat(text, '<b>A mate</b>'), xss);
  await owner.waitForFunction(() => SameEndSocial.snapshot().chatCount === 1);
  assert.equal(await owner.locator('.club-message p').textContent(), xss); assert.equal(await owner.locator('.club-message img').count(), 0); assert.equal(await owner.evaluate(() => window.testXss), undefined);
  const owner2 = await page(); await owner2.evaluate(link => SameEndSocial.joinClub(link, { save: true }), ownerInvite);
  await Promise.all([owner.evaluate(() => SameEndSocial.updateClub({ description: 'Conflict description' })), owner2.evaluate(() => SameEndSocial.updateClub({ theme: 'night' }))]);
  await owner.waitForFunction(() => SameEndSocial.snapshot().theme === 'night');
  await owner2.waitForFunction(() => document.querySelector('#club-description').textContent === 'Conflict description');
  assert(conflicts >= 1, 'concurrent owner writes exercise 409 merge');
  await owner.locator('#club-edit-name').fill('Edited club'); await owner2.evaluate(() => SameEndSocial.updateClub({ theme: 'terrace' })); await owner.waitForFunction(() => SameEndSocial.snapshot().theme === 'terrace'); await owner.locator('#club-edit-form button[type=submit]').click(); await owner.waitForFunction(() => SameEndSocial.snapshot().name === 'Edited club'); assert.equal(await owner.evaluate(() => SameEndSocial.snapshot().theme), 'terrace', 'UI preserves remotely edited fields the organiser did not touch');
  await owner.setViewportSize({ width: 390, height: 844 }); assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'club has no mobile horizontal overflow'); await owner.setViewportSize({ width: 1280, height: 800 });
  await owner.evaluate(() => { PrivateCast.state = { active: true, role: 'source', config: { id: 'test' }, invitationConfigId: 'test' }; document.querySelector('#magnet-link').value = 'magnet:?xt=urn:btih:test#pc=private-test'; });
  await member.waitForFunction(() => SameEndSocial.snapshot().hasLive);
  await member.locator('#club-join-live').click(); assert.equal(await member.evaluate(() => PrivateCast.joined), true); await owner.evaluate(() => SameEndSocial.clearLive()); await member.waitForFunction(() => !SameEndSocial.snapshot().hasLive); assert.equal(await owner.evaluate(() => SameEndSocial.snapshot().hasLive), false, 'manual clear remains cleared while the same cast is active');
  await owner.evaluate(() => { PrivateCast.state = { active: false, role: 'source', config: null }; document.querySelector('#magnet-link').value = ''; });
  await member.waitForFunction(() => !SameEndSocial.snapshot().hasLive);
  const id = await member.evaluate(() => SameEndSocial.snapshot().id); await member.reload(); await member.evaluate(id => SameEndSocial.openClub(id), id); assert.equal(await member.evaluate(() => SameEndSocial.snapshot().chatCount), 0); // replay is asynchronous
  await member.waitForFunction(() => SameEndSocial.snapshot().chatCount === 1);
  await member.goto(origin + '/#openclub=' + id); await member.waitForFunction(() => SameEndSocial?.snapshot().connected); assert.equal(await member.evaluate(() => location.hash), '');
  await member.locator('.club-settings > summary').click(); await member.locator('#club-forget').click(); await member.locator('#club-forget-confirm').click(); await member.waitForFunction(() => !SameEndSocial.snapshot().connected);
  await assert.rejects(() => member.evaluate(id => SameEndSocial.openClub(id), id), /not saved/);
  const serialized = JSON.stringify([...store.items.values()]); assert(!serialized.includes('Private final')); assert(!serialized.includes('Acceptance club')); assert(!serialized.includes(xss)); assert(!serialized.includes('private-test'));
  assert(requests.every(r => !r.path.includes('#') && !r.referer.includes('#')));
  await owner.evaluate(()=>{PrivateCast.state={active:true,role:'source',config:{id:'direct'},invitationConfigId:'direct'};document.querySelector('#magnet-link').value='magnet:?xt=urn:btih:direct#pc=test'});
  const directLink=await owner.evaluate(()=>SameEndSocial.castInvitation('magnet:?xt=urn:btih:direct#pc=test'));
  assert(!directLink.includes('owner='));const direct=await page();await direct.goto(directLink);await direct.waitForFunction(()=>SameEndSocial.snapshot().connected&&PrivateCast.joined);assert.equal(await direct.evaluate(()=>location.hash),'');assert.equal(await direct.locator('#club-chat-shell').isVisible(),true,'accepted room invitation opens chat before a picture connection');await direct.evaluate(()=>{PrivateCast.state.peers=[{ready:true,state:'connected'}];dispatchEvent(new Event('sameend:castchange'))});assert(await direct.locator('#club-chat-shell').isVisible());
  const unsaved = await page(true); await unsaved.evaluate(() => SameEndSocial.createClub({ name: 'Unsaved browser club' })); assert.equal(await unsaved.evaluate(() => SameEndSocial.snapshot().connected), true); assert.equal(await unsaved.evaluate(() => SameEndSocial.snapshot().saved), false); assert.match(await unsaved.locator('#club-notice').textContent(), /could not save/); assert.equal(await unsaved.locator('#club-open').isVisible(), true); assert((await unsaved.locator('#club-invite-url').inputValue()).includes('#club='));
  assert.deepEqual(errors, []);
  console.log('PASS: isolated owner/member encryption, fragment removal, saved reopening/forget, owner permissions, DST, calendar alarm, XSS-safe chat, reserved controls, 409 merge, live publish/join/clear; no browser errors.');
} finally { await Promise.all(contexts.map(c => c.close())); await browser.close(); await new Promise(resolve => server.close(resolve)); }
