import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const sandbox={};vm.runInNewContext(await readFile(new URL('../analytics-core.js',import.meta.url),'utf8'),sandbox);
const core=sandbox.SameEndAnalyticsCore;
const storage=value=>({getItem:()=>JSON.stringify(value)});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(request=()=>Promise.resolve()){
 const calls=[],controllers=[];
 const tracker=core.createTracker({url:'https://sameend.test/api/v1/analytics/events',request:(...args)=>{calls.push(args);return request(...args)},controller:()=>{const c=new AbortController();controllers.push(c);return c},schedule:()=>0,unschedule:()=>{}});
 return{tracker,calls,controllers};
}
test('choice is purpose-versioned, finite, and fails closed on invalid or unavailable storage',()=>{
 const now=1000000000000;
 assert.equal(core.readChoice(storage({v:1,analytics:'allow',savedAt:now}),now),'allow');
 assert.equal(core.readChoice(storage({v:1,analytics:'decline',savedAt:now}),now),'decline');
 for(const v of [null,{}, {v:2,analytics:'allow',savedAt:now},{v:1,analytics:'allow',savedAt:now+1},{v:1,analytics:'allow',savedAt:now-180*86400000},{v:1,analytics:'yes',savedAt:now}])assert.equal(core.readChoice(storage(v),now),null);
 assert.equal(core.readChoice({getItem(){throw Error('blocked')}},now),null);
});
test('collection requires prior opt-in and permits no custom fields or names',async()=>{
 const h=harness();assert.equal(h.tracker.track('page_view'),false);h.tracker.consent(true);
 assert.equal(h.tracker.track('room#secret'),false);assert.equal(h.tracker.track('page_view'),true);await tick();
 assert.equal(h.calls.length,1);const[url,options]=h.calls[0];assert.equal(url,'https://sameend.test/api/v1/analytics/events');
 assert.deepEqual(JSON.parse(options.body),{v:1,event:'page_view'});assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.redirect,'error');
 h.tracker.consent(false);assert.equal(h.tracker.track('share_started'),false);h.tracker.consent(true);await tick();assert.equal(h.calls.length,1,'no replay of past events');
});
test('withdrawal aborts pending requests; failure has no retry or queue',async()=>{
 const h=harness(()=>new Promise(()=>{}));h.tracker.consent(true);h.tracker.track('page_view');h.tracker.consent(false);assert.equal(h.controllers[0].signal.aborted,true);await tick();assert.equal(h.calls.length,1);
 const failed=harness(()=>Promise.reject(Error('offline')));failed.tracker.consent(true);failed.tracker.track('page_view');await tick();await tick();assert.equal(failed.calls.length,1);
 failed.tracker.dispose();failed.tracker.consent(true);assert.equal(failed.tracker.track('page_view'),false);
});
test('bounded concurrency and per-page request budget remain finite',async()=>{
 const h=harness(()=>new Promise(()=>{}));h.tracker.consent(true);for(let n=0;n<10;n++)h.tracker.track('invitation_copied');assert.equal(h.calls.length,3);h.tracker.consent(false);
 const finite=harness();finite.tracker.consent(true);for(let n=0;n<80;n++){finite.tracker.track('invitation_copied');await tick()}assert.equal(finite.calls.length,60);
});
