// Fast deterministic coverage for the forum's viewport-aware polling timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

const runtime = process.env.SAMEEND_PLAYWRIGHT || path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
let chromium, importError;
try { ({chromium} = await import(runtime)); } catch (error) { importError = error; }

test('forum polling pauses offscreen and resumes only while visible', {skip: !chromium && process.env.SAMEEND_REQUIRE_BROWSER !== '1' ? `Playwright runtime unavailable: ${importError?.message || runtime}` : false}, async () => {
  if (!chromium) throw importError || new Error(`Playwright runtime unavailable: ${runtime}`);
  const source = await readFile(new URL('../community.js', import.meta.url), 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font:16px system-ui}#spacer{height:1400px}.topbar{height:60px}main{padding:0 20px}
    #quick-room{height:120px;border:1px solid #aaa}footer{height:300px}
  </style><script>window.SameEndConfig={apiBase:location.origin+'/api'};const NativeIO=window.IntersectionObserver;window.IntersectionObserver=class extends NativeIO{constructor(callback,options){super(entries=>{window.__forumVisible=entries.some(entry=>entry.isIntersecting);callback(entries);},options);}};</script></head>
  <body><header class="topbar"></header><main><div id="spacer"></div><div id="quick-room"></div></main><footer></footer>
  <script>${source.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : process.platform === 'darwin' ? {executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'} : {})});
  try {
    const context = await browser.newContext({viewport:{width:800,height:600}}), page = await context.newPage();
    await page.clock.install({time:Date.now()});
    let threadReads = 0;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/fixture') return route.fulfill({status:200,contentType:'text/html',body:html});
      if (url.pathname === '/api/v1/community/threads') {
        threadReads++;
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[],cursor:null,total:0,latest:0})});
      }
      return route.fulfill({status:200,contentType:'application/json',body:'{}'});
    });
    await page.goto('https://sameend.test/fixture');
    await page.waitForFunction(() => window.SameEndCommunity && document.getElementById('fan-forum'));
    await page.waitForFunction(() => document.getElementById('ff-summary')?.textContent.includes('discussion'));
    assert.equal(await page.locator('#fan-forum').evaluate(el => el.getBoundingClientRect().top > innerHeight), true, 'fixture forum starts below the fold');
    // Open without Playwright auto-scrolling the offscreen control into view.
    await page.evaluate(() => document.getElementById('ff-toggle').click());
    await page.waitForTimeout(50);
    assert.equal(threadReads, 1, 'initial list load is the only request before the first poll');
    await page.clock.fastForward(75000);
    assert.equal(threadReads, 1, 'open forum does not poll while it remains offscreen');

    await page.locator('#fan-forum').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.__forumVisible === true);
    const visiblePoll = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/community/threads', {timeout:3000});
    await page.clock.fastForward(26000);
    await visiblePoll;
    assert.equal(threadReads, 2, 'visible open forum polls after its 25 second interval');

    await page.evaluate(() => window.scrollTo(0,0));
    await page.waitForFunction(() => window.__forumVisible === false);
    assert.ok(await page.locator('#fan-forum').evaluate(el => el.getBoundingClientRect().top > innerHeight));
    await page.clock.fastForward(26000);
    assert.equal(threadReads, 2, 'polling stops after the forum leaves the viewport');
    await context.close();
  } finally { await browser.close(); }
});
