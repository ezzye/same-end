import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {createHash, webcrypto} from 'node:crypto';
import {template} from '../cloudformation.mjs';
import {addCommunityInfrastructure, STAFF_GROUPS, STAFF_REDIRECT_URI, FAN_REDIRECT_URI, FAN_SCOPE} from '../community-infrastructure.mjs';
import {allowedPanels, base64url, makePkce, validateAuthConfiguration, validatePkceTransaction, inspectIdToken, takeCallback, contentPayload, isLoopback, PKCE_KEY} from '../../manage.js';
const auth = {issuer: 'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_TestPool', clientId: 'client123', domain: 'https://sameend-test.auth.eu-west-2.amazoncognito.com', redirectUri: STAFF_REDIRECT_URI};
const now = 1800000000000;
const transaction = {state: 's'.repeat(43), verifier: 'v'.repeat(43), nonce: 'n'.repeat(43), redirectUri: STAFF_REDIRECT_URI, createdAt: now};
const claims = {...{iss: auth.issuer, aud: auth.clientId, token_use: 'id', sub: 'opaque-id', nonce: transaction.nonce, exp: now / 1000 + 900, iat: now / 1000}, 'cognito:groups': ['sameend-support']};
const jwt = value => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(value)).toString('base64url')}.testsignature`;

test('staff template preserves existing routes/environment and hardens every admin entry', () => {
  const before = JSON.stringify(template), added = addCommunityInfrastructure(template), r = added.Resources;
  assert.equal(JSON.stringify(template), before, 'merge must not mutate input');
  assert.deepEqual(r.Route, template.Resources.Route);
  assert.deepEqual(r.StaffUserPool.Properties.AdminCreateUserConfig, {AllowAdminCreateUserOnly: true});
  assert.equal(r.StaffUserPool.Properties.MfaConfiguration, 'ON');
  assert.deepEqual(r.StaffUserPool.Properties.EnabledMfas, ['SOFTWARE_TOKEN_MFA']);
  assert.equal(r.StaffUserPool.DeletionPolicy, 'Retain'); assert.equal(r.StaffUserPool.Properties.DeletionProtection, 'ACTIVE');
  const client = r.StaffClient.Properties;
  assert.equal(client.GenerateSecret, false); assert.deepEqual(client.AllowedOAuthFlows, ['code']);
  assert.deepEqual(client.CallbackURLs, [STAFF_REDIRECT_URI]); assert.deepEqual(client.LogoutURLs, [STAFF_REDIRECT_URI]);
  assert.ok(client.AllowedOAuthScopes.includes('aws.cognito.signin.user.admin'));
  assert.deepEqual(r.StaffEnrollmentClient.Properties.ExplicitAuthFlows,['ALLOW_USER_PASSWORD_AUTH']);assert.equal(r.StaffEnrollmentClient.Properties.AllowedOAuthFlowsUserPoolClient,false);assert.equal(r.StaffEnrollmentClient.Properties.GenerateSecret,false);
  assert.equal(client.IdTokenValidity, 15); assert.equal(client.TokenValidityUnits.IdToken, 'minutes');
  assert.deepEqual(r.StaffAuthorizer.Properties.IdentitySource, ['$request.header.Authorization']);
  assert.deepEqual(r.StaffAuthorizer.Properties.JwtConfiguration.Audience, [{Ref: 'StaffClient'}]);
  for (const key of ['StaffAdminRoute', 'StaffAdminBaseRoute']) {
    assert.equal(r[key].Properties.AuthorizationType, 'JWT'); assert.deepEqual(r[key].Properties.AuthorizerId, {Ref: 'StaffAuthorizer'});
    assert.equal(r[key].Properties.AuthorizationScopes, undefined, 'ID token contract uses audience, not access-token scopes');
    assert.deepEqual(r[key].Properties.Target, r.Route.Properties.Target);
  }
  assert.deepEqual(Object.values(r).filter(item => item.Type === 'AWS::Cognito::UserPoolGroup').map(item => item.Properties.GroupName).sort(), [...STAFF_GROUPS].sort());
  assert.deepEqual(r.Control.Properties.Environment.Variables.TABLE_NAME, template.Resources.Control.Properties.Environment.Variables.TABLE_NAME);
  assert.deepEqual(r.Control.Properties.Environment.Variables.COMMUNITY_ADMIN_CLIENT_ID, {Ref: 'StaffClient'});
  assert.equal(Object.keys(r.Control.Properties.Environment.Variables).some(key => /LOCAL_ADMIN/.test(key)), false);
  assert.deepEqual(Object.keys(added.Outputs).filter(key => key.startsWith('Staff')).sort(), ['StaffClientId', 'StaffDomain', 'StaffEnrollmentClientId', 'StaffIssuer', 'StaffRedirectUri', 'StaffUserPoolId']);
  assert.throws(() => addCommunityInfrastructure(added), /already installed/);
  assert.throws(() => addCommunityInfrastructure({Resources: {}}), /requires Api/);
});

test('fan email/password signup is a separate retained pool with verified-email recovery and a public PKCE client', () => {
  const r = addCommunityInfrastructure(template).Resources, pool = r.FanUserPool, client = r.FanClient.Properties;
  assert.equal(pool.Type, 'AWS::Cognito::UserPool');
  assert.equal(pool.DeletionPolicy, 'Retain'); assert.equal(pool.UpdateReplacePolicy, 'Retain'); assert.equal(pool.Properties.DeletionProtection, 'ACTIVE');
  assert.equal(pool.Properties.UserPoolTier, 'LITE');
  assert.deepEqual(pool.Properties.AdminCreateUserConfig, {AllowAdminCreateUserOnly: false});
  assert.equal(pool.Properties.MfaConfiguration, 'OFF');
  assert.deepEqual(pool.Properties.UsernameAttributes, ['email']); assert.deepEqual(pool.Properties.AutoVerifiedAttributes, ['email']);
  assert.deepEqual(pool.Properties.UsernameConfiguration, {CaseSensitive: false});
  assert.deepEqual(pool.Properties.AccountRecoverySetting, {RecoveryMechanisms: [{Name: 'verified_email', Priority: 1}]});
  assert.ok(pool.Properties.Schema.some(attribute => attribute.Name === 'email' && attribute.Required === true));
  const password = pool.Properties.Policies.PasswordPolicy;
  assert.ok(password.MinimumLength >= 12); assert.equal(password.RequireLowercase, true); assert.equal(password.RequireUppercase, true); assert.equal(password.RequireNumbers, true);
  assert.equal(pool.Properties.VerificationMessageTemplate.DefaultEmailOption, 'CONFIRM_WITH_CODE');
  assert.match(pool.Properties.VerificationMessageTemplate.EmailMessage, /\{####\}/);
  assert.equal(pool.Properties.LambdaConfig, undefined, 'no auto-confirm trigger bypasses email verification');
  assert.deepEqual(client.UserPoolId, {Ref: 'FanUserPool'}); assert.notDeepEqual(client.UserPoolId, r.StaffClient.Properties.UserPoolId);
  assert.equal(client.GenerateSecret, false); assert.equal(client.AllowedOAuthFlowsUserPoolClient, true); assert.deepEqual(client.AllowedOAuthFlows, ['code']);
  assert.deepEqual(client.SupportedIdentityProviders, ['COGNITO']);
  assert.deepEqual(client.CallbackURLs, [FAN_REDIRECT_URI]); assert.deepEqual(client.LogoutURLs, [FAN_REDIRECT_URI]); assert.equal(client.DefaultRedirectURI, FAN_REDIRECT_URI);
  assert.notEqual(FAN_REDIRECT_URI, STAFF_REDIRECT_URI); assert.match(FAN_REDIRECT_URI, /^https:\/\/www\.sameend\.com\/[^?#]+\.html$/);
  assert.equal(client.EnableTokenRevocation, true); assert.equal(client.PreventUserExistenceErrors, 'ENABLED');
  assert.equal(client.TokenValidityUnits.AccessToken, 'minutes'); assert.ok(client.AccessTokenValidity >= 5 && client.AccessTokenValidity <= 60);
  assert.equal(client.TokenValidityUnits.RefreshToken, 'days'); assert.equal(client.RefreshTokenValidity, 1);
  assert.deepEqual(r.FanDomain.Properties.UserPoolId, {Ref: 'FanUserPool'}); assert.equal(r.FanDomain.Properties.ManagedLoginVersion, 1, 'Lite uses classic hosted login');
  assert.equal(r.StaffUserPool.Properties.MfaConfiguration, 'ON'); assert.deepEqual(r.StaffUserPool.Properties.EnabledMfas, ['SOFTWARE_TOKEN_MFA']);
  assert.deepEqual(r.StaffUserPool.Properties.AdminCreateUserConfig, {AllowAdminCreateUserOnly: true});
  for (const group of Object.values(r).filter(resource => resource.Type === 'AWS::Cognito::UserPoolGroup')) assert.deepEqual(group.Properties.UserPoolId, {Ref: 'StaffUserPool'});
});

test('fan member routes require the custom access scope without changing public rooms or staff authorization', () => {
  const added = addCommunityInfrastructure(template), r = added.Resources;
  const server = r.FanResourceServer.Properties;
  assert.deepEqual(server.UserPoolId, {Ref: 'FanUserPool'});
  assert.ok(server.Scopes.some(scope => `${server.Identifier}/${scope.ScopeName}` === FAN_SCOPE));
  assert.equal(r.FanClient.DependsOn, 'FanResourceServer', 'custom scope must exist before the client');
  assert.deepEqual(r.FanClient.Properties.AllowedOAuthScopes, ['openid', 'email', FAN_SCOPE]);
  assert.deepEqual(r.FanAuthorizer.Properties.JwtConfiguration, {Audience: [{Ref: 'FanClient'}], Issuer: {'Fn::Sub': 'https://cognito-idp.${AWS::Region}.${AWS::URLSuffix}/${FanUserPool}'}});
  assert.equal(r.FanAuthorizer.Properties.AuthorizerType, 'JWT'); assert.deepEqual(r.FanAuthorizer.Properties.IdentitySource, ['$request.header.Authorization']);
  for (const [key, route] of [['FanMemberRoute', 'ANY /v1/community/member/{proxy+}'], ['FanMemberBaseRoute', 'ANY /v1/community/member']]) {
    assert.equal(r[key].Properties.RouteKey, route); assert.equal(r[key].Properties.AuthorizationType, 'JWT');
    assert.deepEqual(r[key].Properties.AuthorizerId, {Ref: 'FanAuthorizer'}); assert.deepEqual(r[key].Properties.AuthorizationScopes, [FAN_SCOPE]);
    assert.deepEqual(r[key].Properties.Target, r.Route.Properties.Target);
  }
  assert.equal(r.Route.Properties.RouteKey, 'ANY /v1/{proxy+}'); assert.equal(r.Route.Properties.AuthorizationType, undefined);
  for (const [key, resource] of Object.entries(template.Resources)) {
    if (key !== 'Control') assert.deepEqual(r[key], resource, `existing room/control resource ${key} must remain unchanged`);
  }
  assert.deepEqual(r.Control.Properties.Role, template.Resources.Control.Properties.Role);
  assert.deepEqual(r.StaffAuthorizer.Properties.JwtConfiguration.Audience, [{Ref: 'StaffClient'}]);
  for (const key of ['StaffAdminRoute', 'StaffAdminBaseRoute']) {
    assert.deepEqual(r[key].Properties.AuthorizerId, {Ref: 'StaffAuthorizer'}); assert.equal(r[key].Properties.AuthorizationScopes, undefined);
  }
  const fanRoutes = Object.values(r).filter(resource => resource.Type === 'AWS::ApiGatewayV2::Route' && resource.Properties.AuthorizerId?.Ref === 'FanAuthorizer');
  assert.equal(fanRoutes.length, 2); assert.ok(fanRoutes.every(resource => /^ANY \/v1\/community\/member(?:$|\/)/.test(resource.Properties.RouteKey)));
});

test('fan public output values and Lambda configuration refer only to the fan pool and client', () => {
  const added = addCommunityInfrastructure(template), environment = added.Resources.Control.Properties.Environment.Variables;
  const expected = {
    FanUserPoolId: {Ref: 'FanUserPool'},
    FanIssuer: {'Fn::Sub': 'https://cognito-idp.${AWS::Region}.${AWS::URLSuffix}/${FanUserPool}'},
    FanClientId: {Ref: 'FanClient'},
    FanDomain: {'Fn::Sub': 'https://${FanDomain}.auth.${AWS::Region}.amazoncognito.com'},
    FanRedirectUri: FAN_REDIRECT_URI
  };
  assert.deepEqual(Object.fromEntries(Object.entries(added.Outputs).filter(([key]) => key.startsWith('Fan')).map(([key, output]) => [key, output.Value])), expected);
  assert.deepEqual(environment.COMMUNITY_FAN_ISSUER, expected.FanIssuer); assert.deepEqual(environment.COMMUNITY_FAN_CLIENT_ID, expected.FanClientId);
  assert.deepEqual(environment.COMMUNITY_FAN_DOMAIN, expected.FanDomain); assert.equal(environment.COMMUNITY_FAN_REDIRECT_URI, FAN_REDIRECT_URI); assert.equal(environment.COMMUNITY_FAN_SCOPE, FAN_SCOPE);
  assert.deepEqual(environment.TABLE_NAME, template.Resources.Control.Properties.Environment.Variables.TABLE_NAME);
  assert.deepEqual(environment.VAPID_PRIVATE_KEY, template.Resources.Control.Properties.Environment.Variables.VAPID_PRIVATE_KEY);
  assert.deepEqual(added.Outputs.ApiBase, template.Outputs.ApiBase);
});

test('fan and staff preflight bypass JWT only for OPTIONS on their exact base and proxy paths', () => {
  const r = addCommunityInfrastructure(template).Resources;
  const preflightRoutes = [
    ['StaffAdminPreflightRoute', 'StaffAdminRoute', '/v1/community/admin/{proxy+}'],
    ['StaffAdminBasePreflightRoute', 'StaffAdminBaseRoute', '/v1/community/admin'],
    ['FanMemberPreflightRoute', 'FanMemberRoute', '/v1/community/member/{proxy+}'],
    ['FanMemberBasePreflightRoute', 'FanMemberBaseRoute', '/v1/community/member']
  ];
  for (const [preflightName, protectedName, path] of preflightRoutes) {
    const preflight = r[preflightName].Properties, protectedRoute = r[protectedName].Properties;
    assert.equal(preflight.RouteKey, `OPTIONS ${path}`);
    assert.equal(preflight.AuthorizationType, 'NONE');
    assert.equal(preflight.AuthorizerId, undefined); assert.equal(preflight.AuthorizationScopes, undefined);
    assert.deepEqual(preflight.ApiId, {Ref: 'Api'}); assert.deepEqual(preflight.Target, r.Route.Properties.Target);
    assert.equal(protectedRoute.RouteKey, `ANY ${path}`); assert.equal(protectedRoute.AuthorizationType, 'JWT');
    assert.deepEqual(protectedRoute.AuthorizerId, {Ref: protectedName.startsWith('Fan') ? 'FanAuthorizer' : 'StaffAuthorizer'});
    assert.deepEqual(protectedRoute.AuthorizationScopes, protectedName.startsWith('Fan') ? [FAN_SCOPE] : undefined);
  }
  const explicitlyUnauthenticated = Object.values(r).filter(resource => resource.Type === 'AWS::ApiGatewayV2::Route' && resource.Properties.AuthorizationType === 'NONE');
  assert.equal(explicitlyUnauthenticated.length, 4);
  assert.ok(explicitlyUnauthenticated.every(resource => resource.Properties.RouteKey.startsWith('OPTIONS ')), 'no application method may bypass JWT');
  assert.deepEqual(r.Route, template.Resources.Route, 'public private-room routes remain unchanged');
});

test('domain derives a unique lowercase prefix of safe length from account and stack UUID', () => {
  const r = addCommunityInfrastructure(template).Resources;
  const prefix = r.StaffDomain.Properties.Domain;
  function resolve(value) {
    if (typeof value === 'string') return value;
    if (value.Ref) return {'AWS::AccountId': '123456789012', 'AWS::StackId': 'arn:aws:cloudformation:eu-west-2:123456789012:stack/sameend-control/12345678-abcd-abcd-abcd-123456789012'}[value.Ref];
    if (value['Fn::Join']) { const [delimiter, list] = value['Fn::Join']; return list.map(resolve).join(delimiter); }
    if (value['Fn::Split']) { const [delimiter, string] = value['Fn::Split']; return resolve(string).split(delimiter); }
    if (value['Fn::Select']) { const [index, list] = value['Fn::Select']; return resolve(list)[index]; }
    throw new Error('Unknown intrinsic');
  }
  const domain = resolve(prefix), fanDomain = resolve(r.FanDomain.Properties.Domain);
  for (const value of [domain, fanDomain]) {
    assert.match(value, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/); assert.ok(value.includes('123456789012')); assert.ok(value.includes('12345678-abcd')); assert.ok(value.length <= 63);
  }
  assert.notEqual(fanDomain, domain, 'fan and staff hosted sign-in domains must be distinct');
});

test('PKCE uses independent strong randomness and a reproducible SHA256 challenge', async () => {
  const value = await makePkce(webcrypto), another = await makePkce(webcrypto);
  for (const key of ['verifier', 'state', 'nonce', 'challenge']) assert.match(value[key], /^[a-zA-Z0-9_-]{43}$/);
  assert.equal(value.challenge, createHash('sha256').update(value.verifier).digest('base64url'));
  assert.notEqual(value.state, value.nonce); assert.notEqual(value.verifier, another.verifier);
  assert.equal(base64url(new Uint8Array([255, 255])), '__8');
});

test('sign-in configuration rejects redirect substitution, untrusted domains and URL secrets', () => {
  assert.deepEqual(validateAuthConfiguration(auth, STAFF_REDIRECT_URI), auth);
  for (const changes of [{redirectUri: 'https://evil.example/manage.html'}, {domain: 'https://sameend-test.auth.eu-west-2.amazoncognito.com.evil.example'}, {domain: `${auth.domain}/other`}, {issuer: 'https://evil.example/pool'}, {clientId: 'bad?client'}, {issuer: `${auth.issuer}?secret=1`}]) assert.throws(() => validateAuthConfiguration({...auth, ...changes}, STAFF_REDIRECT_URI));
  assert.throws(() => validateAuthConfiguration(auth, 'http://localhost/manage.html'), /secure staff address/);
  assert.equal(isLoopback('localhost'), true); assert.equal(isLoopback('127.0.0.1'), true); assert.equal(isLoopback('localhost.evil.example'), false);
});

test('state, verifier, nonce, redirect and transaction age are required', () => {
  assert.deepEqual(validatePkceTransaction(JSON.stringify(transaction), transaction.state, STAFF_REDIRECT_URI, now), transaction);
  assert.throws(() => validatePkceTransaction(JSON.stringify(transaction), 'wrong-state', STAFF_REDIRECT_URI, now));
  assert.throws(() => validatePkceTransaction(JSON.stringify(transaction), transaction.state, STAFF_REDIRECT_URI, now + 600001));
  for (const changes of [{verifier: ''}, {nonce: ''}, {createdAt: now + 10000}, {redirectUri: 'https://evil.example'}]) assert.throws(() => validatePkceTransaction(JSON.stringify({...transaction, ...changes}), transaction.state, STAFF_REDIRECT_URI, now));
});

test('ID token presentation rejects wrong purpose, issuer, audience, nonce, expiry and role', () => {
  assert.deepEqual(inspectIdToken(jwt(claims), auth, transaction.nonce, now).groups, ['sameend-support']);
  for (const changes of [{token_use: 'access'}, {iss: 'https://evil.example'}, {aud: 'another-client'}, {nonce: 'wrong'}, {exp: now / 1000 - 1}, {iat: now / 1000 + 100}, {'cognito:groups': ['sameend-fan']}]) assert.throws(() => inspectIdToken(jwt({...claims, ...changes}), auth, transaction.nonce, now));
  assert.throws(() => inspectIdToken('not.a.token', auth, transaction.nonce, now));
  assert.deepEqual(allowedPanels(['sameend-support']), ['feedback']); assert.deepEqual(allowedPanels(['sameend-editor']), ['content']); assert.equal(allowedPanels(['sameend-admin']).length, 7); assert.deepEqual(allowedPanels([]), []);
});

test('OAuth callback parameters are scrubbed before their values can be used', () => {
  const history = {replaceState(...args) { this.args = args; }};
  assert.deepEqual(takeCallback({href: `${STAFF_REDIRECT_URI}?code=private-code&state=sensitive#token=never`}, history), {code: 'private-code', state: 'sensitive', error: false});
  assert.deepEqual(history.args, [null, '', '/manage.html']);
});

test('content serializes conditional versions, quiz answer and schedule safely', () => {
  const values = new Map(Object.entries({id: 'uuid', type: 'quiz', title: 'Quiz', body: 'Try this', choices: 'One\nTwo', question: 'Which?', answerIndex: '2', explanation: 'The answer', version: '3', published: 'on', startsAt: '2026-10-25T13:00', endsAt: '2026-10-25T14:00'}));
  const item = contentPayload(values); assert.equal(item.expectedVersion, 3); assert.equal(item.answerIndex, 1); assert.equal(item.published, true); assert.ok(item.endsAt > item.startsAt);
  values.set('answerIndex', '8'); assert.throws(() => contentPayload(values), /correct choice/);
  const ad = new Map(Object.entries({type: 'ad', sponsor: 'Example', url: 'https://example.com/#secret'})); assert.throws(() => contentPayload(ad), /HTTPS/);
  ad.set('url', ''); assert.equal('url' in contentPayload(ad), false);
});

test('a quiz with an optional blank explanation saves through the real API', async () => {
  const {createCommunityApi} = await import('../community-api.mjs');
  const {MemoryStore} = await import('../store.mjs');
  const values = new Map(Object.entries({id: '550e8400-e29b-41d4-a716-446655440000', type: 'quiz', title: 'A quick quiz', body: 'Try this while you wait.', question: 'Which answer?', choices: 'One\nTwo', answerIndex: '2', explanation: '   ', version: '0'}));
  const payload = contentPayload(values);
  const api = createCommunityApi({store: new MemoryStore(), now: () => now, adminAuth: auth});
  const response = await api.handler({rawPath: '/v1/community/admin/content', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload), requestContext: {http: {method: 'POST'}, authorizer: {jwt: {claims: {...claims, 'cognito:groups': ['sameend-editor']}}}}});
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(JSON.parse(response.body).answerIndex, 1);
});

test('browser callback exchanges once, restricts support UI, clears credentials on signout and rejects bad state', async t => {
  let chromium;
  try { ({chromium}=await import(process.env.SAMEEND_PLAYWRIGHT || path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'))); } catch(error) { if(process.env.SAMEEND_REQUIRE_BROWSER==='1')throw error; t.skip('Set SAMEEND_PLAYWRIGHT to run browser OAuth checks on this host.'); return; }
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  const html = (await readFile(new URL('../../manage.html', import.meta.url), 'utf8')).replace('__SAME_END_CONFIG__', JSON.stringify({apiBase: 'https://api.example.com'}));
  const js = await readFile(new URL('../../manage.js', import.meta.url), 'utf8'), css = await readFile(new URL('../../manage.css', import.meta.url), 'utf8');
  const mfaJs=await readFile(new URL('../../staff-mfa.js',import.meta.url),'utf8'),mfaCss=await readFile(new URL('../../staff-mfa.css',import.meta.url),'utf8');
  const actualNow = Date.now(), tx = {...transaction, createdAt: actualNow}, browserClaims = {...claims, exp: actualNow / 1000 + 900, iat: actualNow / 1000};
  const seen = [], errors = []; let exchanges = 0;
  try {
    const context = await browser.newContext(); await context.addInitScript(({key, tx}) => sessionStorage.setItem(key, JSON.stringify(tx)), {key: PKCE_KEY, tx});
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()); seen.push({url: url.href, authorization: req.headers().authorization});
      if (url.pathname === '/manage.html') return route.fulfill({contentType: 'text/html', body: html});
      if (url.pathname === '/manage.js') return route.fulfill({contentType: 'text/javascript', body: js});
      if(url.pathname==='/staff-mfa.js')return route.fulfill({contentType:'text/javascript',body:mfaJs});
      if(url.pathname==='/staff-mfa.css')return route.fulfill({contentType:'text/css',body:mfaCss});
      if(req.headers()['x-amz-target']==='AWSCognitoIdentityProviderService.GetUser')return route.fulfill({json:{UserMFASettingList:['SOFTWARE_TOKEN_MFA']}});
      if (url.pathname === '/manage.css') return route.fulfill({contentType: 'text/css', body: css});
      if (url.pathname === '/v1/community/config') return route.fulfill({json: {adminAuth: auth}});
      if (url.pathname === '/oauth2/token') { exchanges++; const body = new URLSearchParams(req.postData()); assert.equal(body.get('code_verifier'), tx.verifier); assert.equal(body.get('grant_type'), 'authorization_code'); return route.fulfill({json: {id_token: jwt(browserClaims), access_token: 'discarded', refresh_token: 'discarded'}}); }
      if (url.pathname === '/v1/community/admin/feedback') return route.fulfill({json: {items: [{id: 'feedback1', version: 1, title: '<img src=x onerror=alert(1)>', text: '<script>private</script>', kind: 'problem', status: 'received', response: '', createdAt: actualNow}]}});
      return route.fulfill({json: {}});
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${STAFF_REDIRECT_URI}?code=one-time-code&state=${tx.state}`); await page.locator('#desk').waitFor({state: 'visible'});
    await page.getByRole('heading', {name: '<img src=x onerror=alert(1)>'}).waitFor();
    assert.equal(await page.evaluate(() => location.search + location.hash), '');
    assert.equal(await page.locator('#sections button').count(), 1); assert.equal(await page.locator('#review-signin').isVisible(), false);
    assert.equal(await page.locator('#panel img,#panel script').count(), 0, 'untrusted posts render as text');
    assert.deepEqual(await page.evaluate(() => ({local: Object.keys(localStorage), session: Object.keys(sessionStorage)})), {local: [], session: []});
    const adminRequests = seen.filter(item => item.url.includes('/admin/')); assert.equal(adminRequests.length, 1); assert.equal(adminRequests[0].authorization, `Bearer ${jwt(browserClaims)}`);
    assert.equal(exchanges, 1);
    await page.locator('#signout').click(); await page.waitForURL('**/logout?**');
    await page.goto(`${STAFF_REDIRECT_URI}?code=another-code&state=bad-state`); await page.locator('#notice').filter({hasText: /did not match/}).waitFor(); assert.equal(exchanges, 1, 'mismatched state never exchanges a code');
    assert.equal(await page.locator('#desk').isVisible(), false); assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
});
