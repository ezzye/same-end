import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function workerHarness() {
  const memory = {}, alarms = new Map(), created = [], notifications = [], clock = { now: Date.now() };
  const event = () => ({ addListener(fn) { this.fn = fn; } });
  const chrome = {
    runtime: { id: 'test-extension', onMessage: event(), onStartup: event() },
    storage: { local: {
      async get(keys) {
        if (keys == null) return { ...memory };
        const out = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) if (key in memory) out[key] = memory[key];
        return out;
      },
      async set(values) { Object.assign(memory, values); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete memory[key]; },
    } },
    alarms: {
      onAlarm: event(),
      async getAll() { return [...alarms].map(([name, scheduledTime]) => ({ name, scheduledTime })); },
      async clear(name) { return alarms.delete(name); },
      create(name, { when }) { alarms.set(name, when); created.push({ name, when }); },
    },
    notifications: { create(...args) { notifications.push(args); } },
    tabs: { async query() { return [{ id: 4, url: 'https://example.org/' }]; }, async update() {}, async create() {} },
    scripting: { async executeScript() { throw new Error('unexpected page injection'); } },
    permissions: { async contains() { return false; } },
  };
  class TestDate extends Date { static now() { return clock.now; } }
  const context = { chrome, URL, Date: TestDate, Map, Set, Promise, Error, AbortController, setTimeout, clearTimeout, fetch, TextDecoder, Uint8Array, self: {} };
  context.globalThis = context;
  vm.createContext(context);
  context.self = context;
  context.importScripts = (...files) => files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(root,'extension',file),'utf8'),context));
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/worker.js'), 'utf8'), context);
  const send = (message, sender) => new Promise(resolve => chrome.runtime.onMessage.fn(message, sender, resolve));
  return { chrome, memory, alarms, created, notifications, clock, send, setBBCResult:fn=>{context.SameEndBBCFollow.refresh=fn;} };
}

test('worker filters messages and limits connected Same End pages to bridge actions', async () => {
  const h = workerHarness();
  const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  const page = { id: 'test-extension', url: 'https://www.sameend.com/watch.html?local=1' };
  assert.equal(h.chrome.runtime.onMessage.fn({ type: 'OTHER', action: 'GET' }, popup, () => {}), false);
  assert.equal((await h.send({ type: 'SE_LOCAL', action: 'GET' }, page)).ok, false);
  h.memory.sameEndConnected = true;
  assert.equal((await h.send({ type: 'SE_LOCAL', action: 'GET' }, page)).ok, true);
  assert.equal((await h.send({ type: 'SE_LOCAL', action: 'SAVE', matches: [] }, page)).ok, false);
  assert.equal((await h.send({ type: 'SE_LOCAL', action: 'GET' }, { ...page, url: 'https://www.sameend.com/private/invite' })).ok, false);
});

test('popup imports are local, near-term reminders fire once, and mutations return full state', async () => {
  const h = workerHarness(), popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  const now = Date.now();
  const match = { id: 'bbc:fixture-7', title: 'Villa v Leeds', home: 'Aston Villa', away: 'Leeds United', startsAt: now + 5 * 60_000, status: 'scheduled', tv: [], sourceUrl: 'https://www.bbc.co.uk/sport/football/fixtures', sourceName: 'BBC', checkedAt: now };
  const saved = await h.send({ type: 'SE_LOCAL', action: 'SAVE', matches: [match] }, popup);
  assert.equal(saved.ok, true, saved.error); assert.equal(saved.matches.length, 1); assert.equal(saved.settings.reminderMinutes, 15); assert.equal(saved.version, '0.2.0');
  assert.equal(h.alarms.size, 1); assert.ok([...h.alarms.values()][0] > Date.now()); assert.ok([...h.alarms.values()][0] < now + 10_000);
  const removed = await h.send({ type: 'SE_LOCAL', action: 'REMOVE', ids: [saved.matches[0].id] }, popup);
  assert.equal(removed.matches.length, 0); assert.deepEqual(removed.settings, saved.settings); assert.equal(removed.version, '0.2.0'); assert.equal(h.alarms.size, 0);
  const reopened = await h.send({ type: 'SE_LOCAL', action: 'OPEN' }, popup);
  assert.equal(reopened.ok, true); assert.equal(reopened.matches.length, 0); assert.equal(h.memory.sameEndConnected, true);
});

test('zero-minute reminders fire at kick-off once and stay fired after startup recovery', async () => {
  const h = workerHarness(), popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  await h.send({ type: 'SE_LOCAL', action: 'SETTINGS', settings: { country: 'GB', remindersEnabled: true, reminderMinutes: 0 } }, popup);
  const start = h.clock.now + 60_000, match = { id: 'fixture-zero', title: 'Villa v Leeds', home: 'Villa', away: 'Leeds', startsAt: start, status: 'scheduled', tv: [], sourceUrl: 'https://www.bbc.co.uk/sport/football/fixtures', sourceName: 'BBC' };
  const saved = await h.send({ type: 'SE_LOCAL', action: 'SAVE', matches: [match] }, popup);
  assert.equal(saved.settings.reminderMinutes, 0); assert.equal([...h.alarms.values()][0], start);
  h.clock.now = start + 1_000;
  const alarm = { name: [...h.alarms.keys()][0] };
  h.chrome.alarms.onAlarm.fn(alarm); await new Promise(setImmediate);
  h.chrome.alarms.onAlarm.fn(alarm); h.chrome.runtime.onStartup.fn(); await new Promise(setImmediate);
  assert.equal(h.notifications.length, 1); assert.match(h.notifications[0][1].message, /UK time/); assert.equal(h.alarms.size, 0);
});

test('unsupported active pages are rejected before the capture script runs', async () => {
  const h = workerHarness(), popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  const result = await h.send({ type: 'SE_LOCAL', action: 'IMPORT_TAB' }, popup);
  assert.equal(result.ok, false); assert.match(result.error, /supported football fixture page/);
});

test('following BBC schedules local daily updates, upserts changes and preserves good data on failure', async()=>{
 const h=workerHarness(),popup={id:'test-extension',url:'chrome-extension://test-extension/popup.html'};
 h.chrome.permissions.contains=async()=>true;
 const now=h.clock.now,fixture={id:'stable-source-id',title:'Villa v Test',home:'Villa',away:'Test',startsAt:now+3600000,status:'scheduled',sourceUrl:'https://www.bbc.co.uk/sport/football/teams/aston-villa/scores-fixtures',sourceName:'BBC'};
 // Inject only the source-reader result; the actual BBC fetch/parser has separate tests.
 h.setBBCResult(async()=>[fixture]);
 const first=await h.send({type:'SE_LOCAL',action:'FOLLOW_BBC',enabled:true,team:'aston-villa'},popup);
 assert.equal(first.ok,true,first.error);assert.equal(first.matches.length,1);assert.equal(first.follow.enabled,true);assert.ok(h.alarms.has('sameend-bbc-daily'));
 h.setBBCResult(async()=>[{...fixture,startsAt:now+7200000}]);h.chrome.alarms.onAlarm.fn({name:'sameend-bbc-daily'});await new Promise(setImmediate);
 let state=await h.send({type:'SE_LOCAL',action:'GET'},popup);assert.equal(state.matches.length,1);assert.equal(state.matches[0].startsAt,now+7200000);
 h.setBBCResult(async()=>{throw Error('Provider unavailable')});h.chrome.alarms.onAlarm.fn({name:'sameend-bbc-daily'});await new Promise(setImmediate);
 state=await h.send({type:'SE_LOCAL',action:'GET'},popup);assert.equal(state.matches[0].startsAt,now+7200000);assert.match(state.follow.error,/unavailable/);
 await h.send({type:'SE_LOCAL',action:'FOLLOW_BBC',enabled:false},popup);assert.equal(h.alarms.has('sameend-bbc-daily'),false);
});
test('test reminders use the real local alarm path and record acceptance only after notification API resolves',async()=>{
 const h=workerHarness(),popup={id:'test-extension',url:'chrome-extension://test-extension/popup.html'};
 const result=await h.send({type:'SE_LOCAL',action:'TEST_NOTIFICATION'},popup);assert.equal(result.ok,true);assert.equal(h.notifications.length,0);assert.ok(h.alarms.has('sameend-test-reminder'));
 assert.equal((await h.send({type:'SE_LOCAL',action:'TEST_NOTIFICATION'},popup)).ok,false);
 h.chrome.alarms.onAlarm.fn({name:'sameend-test-reminder'});await new Promise(setImmediate);assert.equal(h.notifications.length,1);assert.ok(h.memory.sameEndNotificationTest.acceptedAt);
});
