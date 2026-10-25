import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkStaffMfa} from '../../staff-mfa.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const auth = {issuer: 'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_TestPool', clientId: 'OAuthClient123', enrollmentClientId: 'SetupClient456'};
const KEY = 'JBSWY3DPEHPK3PXP', SESSION1 = 'initiate-session-fixture-1111', SESSION2 = 'associate-session-fixture-2222', SESSION3 = 'verified-session-fixture-3333';
const enabled = {Username: 'canonical-user', UserMFASettingList: ['SOFTWARE_TOKEN_MFA']};
const response = (value, status = 200) => new Response(JSON.stringify(value), {status});

test('GetUser checks actual TOTP settings through only the trusted Cognito HTTPS origin', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({url, options, body: JSON.parse(options.body)}); return response(calls.length === 1 ? enabled : {PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA', UserMFASettingList: ['SMS_MFA']}); };
  try {
    assert.equal(await checkStaffMfa(auth, 'fixture-access-token'), true);
    assert.equal(await checkStaffMfa(auth, 'fixture-access-token'), false);
    assert.equal(calls[0].url, 'https://cognito-idp.eu-west-2.amazonaws.com/');
    assert.deepEqual(calls[0].body, {AccessToken: 'fixture-access-token'});
    assert.equal(calls[0].options.headers['X-Amz-Target'], 'AWSCognitoIdentityProviderService.GetUser');
    for (const {options} of calls) {
      assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.ok(options.signal instanceof AbortSignal);
    }
    for (const issuer of ['http://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_TestPool', 'https://evil.example/eu-west-2_TestPool', `${auth.issuer}?key=private`, 'https://private@cognito-idp.eu-west-2.amazonaws.com/eu-west-2_TestPool', 'https://cognito-idp.eu-west-2.amazonaws.com:8443/eu-west-2_TestPool']) await assert.rejects(checkStaffMfa({...auth, issuer}, 'fixture-token'), /not configured/);
    assert.equal(calls.length, 2);
    await assert.rejects(checkStaffMfa(auth, ''), /Sign in again/);
  } finally { globalThis.fetch = original; }
});

test('service errors, unreadable responses and timeouts never expose provider details', async () => {
  const original = globalThis.fetch, originalTimer = globalThis.setTimeout;
  try {
    globalThis.fetch = async () => response({__type: 'NotAuthorizedException', message: 'PRIVATE_PROVIDER_BODY'}, 400);
    await assert.rejects(checkStaffMfa(auth, 'fixture-token'), error => !error.message.includes('PRIVATE_PROVIDER_BODY') && /not accepted/.test(error.message));
    globalThis.fetch = async () => new Response('<html>PRIVATE_PROVIDER_BODY</html>');
    await assert.rejects(checkStaffMfa(auth, 'fixture-token'), /unreadable response/);
    globalThis.setTimeout = fn => { queueMicrotask(fn); return 0; };
    globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('PRIVATE_NETWORK_DETAIL'))));
    await assert.rejects(checkStaffMfa(auth, 'fixture-token'), /took too long/);
  } finally { globalThis.fetch = original; globalThis.setTimeout = originalTimer; }
});

test('helper contains no persistence, external QR service, HTML interpolation or credential logging', async () => {
  const source = await readFile(path.join(root, 'staff-mfa.js'), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|console\.|innerHTML|insertAdjacentHTML|document\.write|otpauth:|qrserver|chart\.google/i);
});

const runtime = process.env.SAMEEND_PLAYWRIGHT || path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
let browserAvailable = true;
try { await access(runtime); } catch { browserAvailable = false; }

test('browser MFA setup, recovery, retry and cancellation use only memory and discard every sign-in result', {skip: !browserAvailable, timeout: 60000}, async t => {
  const {chromium} = await import(runtime);
  const files = {'/staff-mfa.js': ['text/javascript', await readFile(path.join(root, 'staff-mfa.js'))], '/staff-mfa.css': ['text/css', await readFile(path.join(root, 'staff-mfa.css'))]};
  const html = `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/staff-mfa.css"><div id="setup"></div><script type="module">
    import {createStaffMfa} from '/staff-mfa.js';
    window.calls=[];window.queue=[];window.completed=0;window.cancelled=0;window.storageWrites=0;
    Storage.prototype.setItem=function(){window.storageWrites++;throw Error('Storage forbidden');};
    window.fetch=async function(url,options){window.calls.push({url,body:JSON.parse(options.body),method:options.method,credentials:options.credentials,cache:options.cache,redirect:options.redirect,target:options.headers['X-Amz-Target']});const item=window.queue.shift();if(!item)throw Error('Unexpected mock call');if(item.pending)return await new Promise(resolve=>{window.release=()=>resolve(new Response(JSON.stringify(item.body),{status:item.status||200}));});return new Response(JSON.stringify(item.body),{status:item.status||200});};
    window.makeMfa=(config=${JSON.stringify(auth)})=>{window.helper?.cancel();window.helper=createStaffMfa({auth:config,container:document.getElementById('setup'),onComplete:()=>window.completed++,onCancel:()=>window.cancelled++});return window.helper;};window.makeMfa();window.ready=true;
  </script>`;
  const server = createServer((req, res) => { const file = files[req.url]; res.writeHead(200, {'Content-Type': file ? file[0] : 'text/html'}); res.end(file ? file[1] : html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : process.platform === 'darwin' ? {executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'} : {})});
    const page = await browser.newPage({viewport: {width: 390, height: 844}});
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
    const start = async queue => {
      await page.evaluate(queue => { window.helper.cancel(); window.makeMfa(); window.calls = []; window.queue = queue; window.completed = 0; window.cancelled = 0; window.release = undefined; window.helper.begin(); }, queue);
    };
    const credentials = async () => {
      await page.getByLabel('Staff email', {exact: true}).fill('staff@example.test');
      await page.getByLabel('Staff password', {exact: true}).fill('fixture-password-only');
      await page.getByRole('button', {name: 'Continue to authenticator setup', exact: true}).click();
    };
    const verify = async code => {
      await page.getByLabel('Six-digit authenticator code', {exact: true}).fill(code);
      await page.getByRole('button', {name: 'Verify authenticator', exact: true}).click();
    };
    const operationNames = async () => page.evaluate(() => window.calls.map(call => call.target.split('.').pop()));
    const setup = [
      {body: {ChallengeName: 'MFA_SETUP', Session: SESSION1, ChallengeParameters: {USER_ID_FOR_SRP: 'canonical-user'}}},
      {body: {SecretCode: KEY, Session: SESSION2}},
    ];
    await t.test('lost initial login recovers using the latest session and canonical username, with a final enabled-MFA check', async () => {
      await start([...setup, {body: {Status: 'SUCCESS', Session: SESSION3}}, {body: {AuthenticationResult: {AccessToken: 'enrollment-access-fixture', IdToken: 'discard-id-fixture', RefreshToken: 'discard-refresh-fixture'}}}, {body: {UserMFASettingList: []}}, {body: {}}, {body: enabled}]);
      await credentials();
      const keyInput = page.getByLabel('Authenticator setup key', {exact: true});
      await keyInput.waitFor(); assert.equal(await keyInput.getAttribute('type'), 'password');
      assert.equal(await keyInput.inputValue(), KEY);
      await page.getByRole('button', {name: 'Show key', exact: true}).click(); assert.equal(await keyInput.getAttribute('type'), 'text');
      await page.getByRole('button', {name: 'Hide key', exact: true}).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await verify('123456'); await page.waitForFunction(() => window.completed === 1);
      const calls = await page.evaluate(() => window.calls);
      assert.deepEqual(await operationNames(), ['InitiateAuth', 'AssociateSoftwareToken', 'VerifySoftwareToken', 'RespondToAuthChallenge', 'GetUser', 'SetUserMFAPreference', 'GetUser']);
      assert.deepEqual(calls[0].body, {ClientId: auth.enrollmentClientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: {USERNAME: 'staff@example.test', PASSWORD: 'fixture-password-only'}});
      assert.deepEqual(calls[1].body, {Session: SESSION1}); assert.deepEqual(calls[2].body, {Session: SESSION2, UserCode: '123456'});
      assert.deepEqual(calls[3].body, {ClientId: auth.enrollmentClientId, ChallengeName: 'MFA_SETUP', ChallengeResponses: {USERNAME: 'canonical-user'}, Session: SESSION3});
      assert.deepEqual(calls[5].body, {AccessToken: 'enrollment-access-fixture', SoftwareTokenMfaSettings: {Enabled: true, PreferredMfa: true}});
      assert.equal(await page.locator('#setup').innerHTML(), ''); assert.equal(await page.evaluate(() => window.storageWrites), 0);
      assert.ok(calls.every(call => call.url === 'https://cognito-idp.eu-west-2.amazonaws.com/' && call.credentials === 'omit' && call.cache === 'no-store' && call.redirect === 'error'));
    });
    await t.test('one-time access-token setup verifies, enables preference, and confirms MFA without requesting a password', async () => {
      await start([]);
      await page.evaluate(({KEY, enabled}) => { window.queue = [{body: {UserMFASettingList: []}}, {body: {SecretCode: KEY}}, {body: {Status: 'SUCCESS'}}, {body: {}}, {body: enabled}]; window.helper.begin('first-login-access-fixture'); }, {KEY, enabled});
      await page.getByLabel('Authenticator setup key', {exact: true}).waitFor(); assert.equal(await page.locator('input[type="password"]').count(), 1);
      await verify('654321'); await page.waitForFunction(() => window.completed === 1);
      assert.deepEqual(await operationNames(), ['GetUser', 'AssociateSoftwareToken', 'VerifySoftwareToken', 'SetUserMFAPreference', 'GetUser']);
      const calls = await page.evaluate(() => window.calls); assert.deepEqual(calls[1].body, {AccessToken: 'first-login-access-fixture'}); assert.deepEqual(calls[2].body, {AccessToken: 'first-login-access-fixture', UserCode: '654321'});
      assert.equal(await page.locator('#setup').innerHTML(), '');
    });
    await t.test('wrong code permits a fresh code using the same setup session and clears the entered code', async () => {
      await start([...setup, {status: 400, body: {__type: 'CodeMismatchException', message: 'PRIVATE_PROVIDER_BODY'}}, {body: {Status: 'SUCCESS', Session: SESSION3}}, {body: {AuthenticationResult: {AccessToken: 'retry-access-fixture'}}}, {body: enabled}]);
      await credentials(); await verify('000000'); await page.getByRole('status').filter({hasText: 'That code did not match'}).waitFor();
      assert.equal(await page.getByLabel('Six-digit authenticator code', {exact: true}).inputValue(), ''); assert.ok(!(await page.locator('#setup').innerText()).includes('PRIVATE_PROVIDER_BODY'));
      await verify('123456'); await page.waitForFunction(() => window.completed === 1);
      const calls = await page.evaluate(() => window.calls); assert.equal(calls[2].body.Session, SESSION2); assert.equal(calls[3].body.Session, SESSION2);
    });
    await t.test('a rejected-code response carries its updated session into the next explicit attempt', async () => {
      await start([...setup, {body: {Status: 'ERROR', Session: 'rejected-code-session-fixture-4444'}}, {body: {Status: 'SUCCESS', Session: SESSION3}}, {body: {AuthenticationResult: {AccessToken: 'retry-access-fixture'}}}, {body: enabled}]);
      await credentials(); await verify('000000'); await page.getByRole('status').filter({hasText: 'That code did not match'}).waitFor();
      await verify('123456'); await page.waitForFunction(() => window.completed === 1);
      assert.equal(await page.evaluate(() => window.calls[3].body.Session), 'rejected-code-session-fixture-4444');
    });
    await t.test('a successful verification without its required continuation session never reuses an older session', async () => {
      await start([...setup, {body: {Status: 'SUCCESS'}}]); await credentials(); await verify('123456');
      await page.getByRole('status').filter({hasText: 'setup session has ended'}).waitFor();
      assert.deepEqual(await operationNames(), ['InitiateAuth', 'AssociateSoftwareToken', 'VerifySoftwareToken']);
      assert.equal(await page.evaluate(() => window.completed), 0); assert.equal(await page.locator('input').count(), 0);
    });
    await t.test('password is blank while authentication is pending; cancel blocks late provider responses', async () => {
      await start([{pending: true, body: {ChallengeName: 'MFA_SETUP', Session: SESSION1}}]);
      await credentials(); await page.waitForFunction(() => typeof window.release === 'function');
      assert.equal(await page.getByLabel('Staff password', {exact: true}).inputValue(), '');
      await page.getByRole('button', {name: 'Cancel setup', exact: true}).click();
      await page.evaluate(() => window.release()); await page.waitForTimeout(30);
      assert.equal(await page.locator('#setup').innerHTML(), ''); assert.equal(await page.evaluate(() => window.calls.length), 1); assert.equal(await page.evaluate(() => window.completed), 0);
    });
    await t.test('cancel scrubs even detached form fields and ignores responses from an older begin', async () => {
      await start([...setup, {pending: true, body: {Status: 'SUCCESS', Session: SESSION3}}]);
      await credentials(); await page.getByLabel('Authenticator setup key', {exact: true}).waitFor();
      await page.evaluate(() => { window.oldKey = document.querySelector('input[readonly]'); });
      await verify('123456'); await page.waitForFunction(() => typeof window.release === 'function');
      await page.evaluate(() => { window.helper.begin(); window.release(); }); await page.waitForTimeout(30);
      assert.equal(await page.evaluate(() => window.oldKey.value), ''); assert.equal(await page.getByLabel('Staff password', {exact: true}).inputValue(), '');
      assert.equal(await page.evaluate(() => window.calls.length), 3); assert.equal(await page.evaluate(() => window.completed), 0);
    });
    await t.test('existing MFA and temporary passwords return to normal sign-in without collecting a code or resetting anything', async () => {
      for (const [challenge, phrase] of [['SOFTWARE_TOKEN_MFA', 'already registered'], ['NEW_PASSWORD_REQUIRED', 'permanent password']]) {
        await start([{body: {ChallengeName: challenge, Session: SESSION1}}]); await credentials();
        await page.getByText(new RegExp(phrase)).waitFor(); assert.equal(await page.locator('input').count(), 0); assert.deepEqual(await operationNames(), ['InitiateAuth']); assert.equal(await page.evaluate(() => window.completed), 0);
      }
      await start([]); await page.evaluate(enabled => { window.queue = [{body: enabled}]; window.helper.begin('existing-access-fixture'); }, enabled);
      await page.getByText(/already registered/).waitFor(); assert.deepEqual(await operationNames(), ['GetUser']);
    });
    await t.test('pagehide clears private fields, and unconfirmed final MFA never completes setup', async () => {
      await start([...setup]); await credentials(); await page.getByLabel('Authenticator setup key', {exact: true}).waitFor();
      await page.evaluate(() => { window.oldKey = document.querySelector('input[readonly]'); window.dispatchEvent(new Event('pagehide')); });
      assert.equal(await page.evaluate(() => window.oldKey.value), ''); assert.equal(await page.locator('#setup').innerHTML(), '');
      await start([...setup, {body: {Status: 'SUCCESS', Session: SESSION3}}, {body: {AuthenticationResult: {AccessToken: 'unconfirmed-access-fixture'}}}, {body: {UserMFASettingList: []}}, {body: {}}, {body: {UserMFASettingList: []}}]);
      await credentials(); await verify('123456'); await page.getByRole('status').filter({hasText: 'could not be confirmed'}).waitFor();
      assert.equal(await page.evaluate(() => window.completed), 0); assert.equal(await page.locator('input').count(), 0); assert.ok(!(await page.locator('#setup').innerHTML()).includes(KEY));
      assert.equal(await page.evaluate(() => window.storageWrites), 0);
    });
    await t.test('missing dedicated enrollment client prevents every network request', async () => {
      await page.evaluate(auth => { window.makeMfa({...auth, enrollmentClientId: auth.clientId}); window.calls = []; window.helper.begin(); }, auth);
      await page.getByRole('status').filter({hasText: 'not configured'}).waitFor(); assert.equal(await page.evaluate(() => window.calls.length), 0);
    });
    await page.close();
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
