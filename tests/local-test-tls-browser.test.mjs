import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createLocalTestTLS, localTestTLSSPKIPin } from './helpers/local-test-tls.mjs';

const runtimeInput = process.env.SAMEEND_PLAYWRIGHT
  || (process.env.HOME || process.env.USERPROFILE) + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const runtimeURL = /^file:/i.test(runtimeInput) ? new URL(runtimeInput) : pathToFileURL(runtimeInput);
const { chromium } = await import(runtimeURL.href);

function listen(tls) {
  const server = https.createServer(tls, (_req, res) => {
    res.writeHead(200, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end('fixture');
  });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => server);
}

test('Chromium trusts the generated TLS fixture pin and rejects an unrelated self-signed certificate', { timeout: 20000 }, async () => {
  const allowedTLS = createLocalTestTLS(), unrelatedTLS = createLocalTestTLS();
  const allowedPin = localTestTLSSPKIPin(allowedTLS.cert);
  assert.notEqual(allowedPin, localTestTLSSPKIPin(unrelatedTLS.cert));
  const allowedServer = await listen(allowedTLS), unrelatedServer = await listen(unrelatedTLS);
  let browser;
  try {
    const allowedURL = 'https://127.0.0.1:' + allowedServer.address().port;
    const unrelatedURL = 'https://127.0.0.1:' + unrelatedServer.address().port;
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      args: ['--ignore-certificate-errors-spki-list=' + allowedPin, '--disable-background-networking']
    });
    const context = await browser.newContext();
    const outsideRequests = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        outsideRequests.push(url.hostname);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    const response = await page.goto(allowedURL, { waitUntil: 'load', timeout: 8000 });
    assert.equal(response.status(), 200);
    assert.equal(await page.locator('body').textContent(), 'fixture');
    const blockedPage = await context.newPage();
    try {
      await assert.rejects(
        blockedPage.goto(unrelatedURL, { waitUntil: 'load', timeout: 8000 }),
        /ERR_CERT_AUTHORITY_INVALID/
      );
    } finally {
      await blockedPage.close();
    }
    assert.deepEqual(outsideRequests, []);
    await context.close();
  } finally {
    if (browser) await browser.close();
    await Promise.all([
      new Promise(resolve => allowedServer.close(resolve)),
      new Promise(resolve => unrelatedServer.close(resolve))
    ]);
  }
});
