import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {STAFF_REDIRECT_URI} from '../community-infrastructure.mjs';
import {PKCE_KEY} from '../../manage.js';

const auth = {
  issuer: 'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_TestPool',
  clientId: 'staffclient123',
  domain: 'https://sameend-test.auth.eu-west-2.amazoncognito.com',
  redirectUri: STAFF_REDIRECT_URI,
};
const jwt = claims => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture-signature`;

test('real staff button completes a mocked hosted OAuth round trip and rejects replay', async t => {
  let chromium;
  try {
    ({chromium} = await import(process.env.SAMEEND_PLAYWRIGHT || path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
  } catch (error) {
    if (process.env.SAMEEND_REQUIRE_BROWSER === '1') throw error;
    t.skip('Set SAMEEND_PLAYWRIGHT to run the staff sign-in browser check on this host.');
    return;
  }

  const root = new URL('../../', import.meta.url);
  const html = (await readFile(new URL('manage.html', root), 'utf8')).replace('__SAME_END_CONFIG__', JSON.stringify({apiBase: 'https://api.example.com'}));
  const js = await readFile(new URL('manage.js', root), 'utf8');
  const css = await readFile(new URL('manage.css', root), 'utf8');
  const staffMfa = await readFile(new URL('staff-mfa.js', root), 'utf8');
  let staffMfaCss = '';
  try { staffMfaCss = await readFile(new URL('staff-mfa.css', root), 'utf8'); } catch {}

  const now = Date.now();
  const seen = {exchanges: [], getUser: 0};
  let authorizeSeenResolve;
  const authorizeSeen = new Promise(resolve => { authorizeSeenResolve = resolve; });
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  try {
    const context = await browser.newContext();
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: {
        'access-control-allow-origin': 'https://www.sameend.com',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-amz-target',
      }});
      if (url.hostname === 'www.sameend.com' && url.pathname === '/manage.html') return route.fulfill({contentType: 'text/html', body: html});
      if (url.hostname === 'www.sameend.com' && url.pathname === '/manage.js') return route.fulfill({contentType: 'text/javascript', body: js});
      if (url.hostname === 'www.sameend.com' && url.pathname === '/staff-mfa.js') return route.fulfill({contentType: 'text/javascript', body: staffMfa});
      if (url.hostname === 'www.sameend.com' && url.pathname === '/manage.css') return route.fulfill({contentType: 'text/css', body: css});
      if (url.hostname === 'www.sameend.com' && url.pathname === '/staff-mfa.css' && staffMfaCss) return route.fulfill({contentType: 'text/css', body: staffMfaCss});
      if (url.hostname === 'www.sameend.com' && url.pathname === '/leave.html') return route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Left staff desk</title>'});
      if (url.hostname === 'api.example.com' && url.pathname === '/v1/community/config') return route.fulfill({json: {adminAuth: auth}, headers: {'access-control-allow-origin': 'https://www.sameend.com'}});
      if (url.hostname === new URL(auth.issuer).hostname && request.headers()['x-amz-target'] === 'AWSCognitoIdentityProviderService.GetUser') {
        seen.getUser++;
        assert.equal(JSON.parse(request.postData()).AccessToken, 'mock-access-token');
        return route.fulfill({json: {UserMFASettingList: ['SOFTWARE_TOKEN_MFA']}, headers: {'access-control-allow-origin': 'https://www.sameend.com'}});
      }
      if (url.origin === auth.domain && url.pathname === '/oauth2/authorize') {
        const params = url.searchParams;
        const entry = {state: params.get('state'), nonce: params.get('nonce'), challenge: params.get('code_challenge'), redirectUri: params.get('redirect_uri'), scope: params.get('scope')};
        authorizeSeenResolve(entry);
        assert.equal(params.get('response_type'), 'code');
        assert.equal(params.get('client_id'), auth.clientId);
        const fakeProvider = `<!doctype html><script>location.replace(${JSON.stringify(auth.redirectUri + '?code=one-time-code&state=')}+encodeURIComponent(new URL(location.href).searchParams.get('state')))</script>`;
        return route.fulfill({contentType: 'text/html', body: fakeProvider});
      }
      if (url.origin === auth.domain && url.pathname === '/oauth2/token') {
        const body = new URLSearchParams(request.postData());
        const authorize = await authorizeSeen;
        seen.exchanges.push({code: body.get('code'), verifier: body.get('code_verifier')});
        assert.equal(body.get('grant_type'), 'authorization_code');
        assert.equal(body.get('redirect_uri'), authorize.redirectUri);
        assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorize.challenge, 'token exchange verifier matches the authorize challenge');
        return route.fulfill({json: {
          id_token: jwt({iss: auth.issuer, aud: auth.clientId, token_use: 'id', sub: 'staff-fixture', nonce: authorize.nonce, exp: now / 1000 + 900, iat: now / 1000, 'cognito:groups': ['sameend-support']}),
          access_token: 'mock-access-token',
          refresh_token: 'discarded-refresh-token',
        }, headers: {'access-control-allow-origin': 'https://www.sameend.com'}});
      }
      if (url.hostname === 'api.example.com' && url.pathname === '/v1/community/admin/feedback') return route.fulfill({json: {items: []}, headers: {'access-control-allow-origin': 'https://www.sameend.com'}});
      if (url.origin === auth.domain && url.pathname === '/logout') {
        return route.fulfill({status: 302, headers: {location: `${auth.redirectUri}?signedout=1`}});
      }
      return route.fulfill({json: {}});
    });

    const page = await context.newPage();
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('requestfailed', request => browserErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
    await page.goto(auth.redirectUri);
    await page.locator('#hosted-signin').waitFor({state: 'visible'});
    await page.evaluate(key => {
      window.addEventListener('pagehide', () => sessionStorage.setItem('test.pkce.survived-pagehide', String(Boolean(sessionStorage.getItem(key)))));
    }, PKCE_KEY);
    const click = page.locator('#hosted-signin').click();
    const authorize = await authorizeSeen;
    await click;
    assert.ok(authorize.state && authorize.nonce && authorize.challenge);
    assert.equal(authorize.redirectUri, auth.redirectUri);
    assert.ok(authorize.scope.split(' ').includes('aws.cognito.signin.user.admin'));
    try { await page.locator('#desk').waitFor({state: 'visible', timeout: 7000}); }
    catch { assert.fail(JSON.stringify({url: page.url(), notice: await page.locator('#notice').textContent(), session: await page.locator('#session').textContent(), browserErrors, exchanges: seen.exchanges, getUser: seen.getUser})); }
    assert.equal(await page.evaluate(() => location.search + location.hash), '', 'callback URL is scrubbed');
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), PKCE_KEY), null, 'callback consumes the PKCE transaction');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('test.pkce.survived-pagehide')), 'true', 'intentional hosted redirect preserved PKCE through source pagehide');
    assert.equal(await page.evaluate(() => localStorage.length), 0, 'tokens are not written to local storage');
    assert.equal(seen.exchanges.length, 1);
    assert.equal(seen.getUser, 1, 'the ID token is not activated until the access-token MFA check succeeds');

    const callbackUrl = `${auth.redirectUri}?code=one-time-code&state=${encodeURIComponent(authorize.state)}`;
    await page.locator('#signout').click();
    await page.waitForURL('**/manage.html?signedout=1');
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), PKCE_KEY), null, 'explicit signout clears pending PKCE state');

    await page.goto(callbackUrl);
    await page.locator('#notice').filter({hasText: /missing|expired|did not match/i}).waitFor();
    assert.equal(seen.exchanges.length, 1, 'replaying the callback cannot exchange the authorization code again');

    await page.evaluate(({key, redirectUri}) => sessionStorage.setItem(key, JSON.stringify({state: 's'.repeat(43), verifier: 'v'.repeat(43), nonce: 'n'.repeat(43), redirectUri, createdAt: Date.now()})), {key: PKCE_KEY, redirectUri: auth.redirectUri});
    await page.goto('https://www.sameend.com/leave.html');
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), PKCE_KEY), null, 'ordinary navigation clears an unconsumed transaction');
    await context.close();
  } finally {
    await browser.close();
  }
});
