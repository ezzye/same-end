/* First-time staff MFA only. Passwords, setup keys and Cognito sessions live in memory.
   Enrollment-client tokens never open the staff desk; completion requires fresh OAuth. */
const REQUEST_TIMEOUT = 15000;
const SETUP_TIMEOUT = 10 * 60 * 1000;
const GENERIC_ERROR = 'Authenticator setup could not continue. Try again, or cancel and start setup again.';
const CODE_ERROR = 'That code did not match. Wait for a fresh six-digit code and try again. Check that your phone uses automatic time.';
class Cancelled extends Error {}
class SetupError extends Error {
  constructor(message, retryCode = false) { super(message); this.retryCode = retryCode; }
}

function endpoint(auth) {
  let issuer;
  try { issuer = new URL(auth?.issuer); } catch { throw new SetupError('Staff authenticator setup is not configured.'); }
  if (issuer.protocol !== 'https:' || !/^cognito-idp\.[a-z0-9-]+\.amazonaws\.com$/.test(issuer.hostname) || !/^\/[a-z0-9-]+_[A-Za-z0-9]+\/?$/.test(issuer.pathname) || issuer.port || issuer.username || issuer.password || issuer.search || issuer.hash) throw new SetupError('Staff authenticator setup is not configured.');
  return `${issuer.origin}/`;
}
function validToken(value) { return typeof value === 'string' && value.length > 0 && value.length <= 16000; }
function validSession(value) { return typeof value === 'string' && value.length >= 20 && value.length <= 4096; }
function mfaEnabled(user) { return Array.isArray(user?.UserMFASettingList) && user.UserMFASettingList.includes('SOFTWARE_TOKEN_MFA'); }
function providerError(payload, status) {
  const code = typeof payload?.__type === 'string' ? payload.__type.split('#').pop() : '';
  if (['CodeMismatchException', 'EnableSoftwareTokenMFAException'].includes(code)) return new SetupError(CODE_ERROR, true);
  if (['TooManyRequestsException', 'LimitExceededException', 'TooManyFailedAttemptsException'].includes(code) || status === 429) return new SetupError('Too many attempts. Wait a few minutes, then cancel and start setup again.');
  if (['NotAuthorizedException', 'UserNotFoundException'].includes(code)) return new SetupError('Your sign-in details or setup session were not accepted. Check your details, or cancel and start setup again.');
  if (code === 'UserNotConfirmedException') return new SetupError('Finish confirming your staff account through normal sign-in first, then return to authenticator setup.');
  if (code === 'PasswordResetRequiredException') return new SetupError('Your account needs attention. Use normal staff sign-in to finish your password steps first.');
  if (['SoftwareTokenMFANotFoundException', 'InvalidUserPoolConfigurationException'].includes(code)) return new SetupError('Authenticator setup is not available for this staff desk. Ask an administrator to check the configuration.');
  return new SetupError(GENERIC_ERROR);
}

async function cognito(auth, operation, payload, context) {
  const url = endpoint(auth);
  context?.assert();
  const controller = new AbortController();
  context?.controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const pending = fetch(url, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: {'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`},
      body: JSON.stringify(payload), signal: controller.signal,
    });
    // fetch has synchronously consumed the body; release credential references now.
    for (const key of Object.keys(payload)) delete payload[key];
    const response = await pending;
    context?.assert();
    const raw = await response.text();
    context?.assert();
    if (raw.length > 131072) throw new SetupError(GENERIC_ERROR);
    let result;
    try { result = raw ? JSON.parse(raw) : {}; } catch { throw new SetupError('The sign-in service returned an unreadable response. Cancel and try setup again.'); }
    if (!response.ok) throw providerError(result, response.status);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SetupError(GENERIC_ERROR);
    return result;
  } catch (error) {
    context?.assert();
    if (error instanceof SetupError) throw error;
    throw new SetupError(controller.signal.aborted ? 'The sign-in service took too long. Cancel and try setup again.' : 'The sign-in service could not be reached securely. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
    context?.controllers.delete(controller);
    for (const key of Object.keys(payload)) delete payload[key];
  }
}

export async function checkStaffMfa(auth, accessToken) {
  if (!validToken(accessToken)) throw new SetupError('Your staff sign-in has ended. Sign in again.');
  try { return mfaEnabled(await cognito(auth, 'GetUser', {AccessToken: accessToken})); }
  finally { accessToken = ''; }
}

export function createStaffMfa({auth, container, onComplete = () => {}, onCancel = () => {}}) {
  if (!container?.ownerDocument) throw new SetupError('Choose a place to show authenticator setup.');
  const doc = container.ownerDocument, view = doc.defaultView;
  let generation = 0, active = false, access = '', session = '', username = '', secret = '', expiryTimer;
  let status, submit, busy = false;
  const controllers = new Set(), fields = new Set();
  const node = (tag, text, className) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  function scrubFields() { for (const input of fields) { input.value = ''; input.removeAttribute('value'); } fields.clear(); }
  function clearScreen() { scrubFields(); container.replaceChildren(); status = undefined; submit = undefined; }
  function clean() {
    active = false; generation++; busy = false; clearTimeout(expiryTimer);
    for (const controller of controllers) controller.abort(); controllers.clear();
    access = ''; session = ''; username = ''; secret = '';
    clearScreen(); view?.removeEventListener('pagehide', pagehide);
  }
  function cancel(notify = true) { const wasActive = active; clean(); container.hidden = true; if (notify && wasActive) onCancel(); }
  function pagehide() { cancel(false); }
  function context() { const epoch = generation; return {controllers, assert() { if (!active || generation !== epoch) throw new Cancelled(); }}; }
  function message(text, error = false) { if (status) { status.textContent = text; status.dataset.error = String(error); } }
  function button(text, action, secondary = false) {
    const el = node('button', text, secondary ? 'secondary' : undefined); el.type = 'button'; el.addEventListener('click', action); return el;
  }
  function frame(title, intro) {
    clearScreen(); container.hidden = false;
    const card = node('section', undefined, 'staff-mfa'); card.setAttribute('aria-label', 'Staff authenticator setup');
    const heading = node('h2', title); heading.tabIndex = -1;
    status = node('p', '', 'staff-mfa-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
    card.append(heading, node('p', intro), status); container.append(card);
    return {card, heading};
  }
  function field(label, options = {}) {
    const wrapper = node('label', label), input = node('input');
    Object.assign(input, options); input.setAttribute('aria-label', label); fields.add(input); wrapper.append(input);
    return {wrapper, input};
  }
  function cancelButton() { return button('Cancel setup', () => cancel(), true); }
  async function run(action) {
    if (!active || busy) return;
    const ctx = context(); busy = true; if (submit) submit.disabled = true; message('Working securely…');
    try { await action(ctx); } catch (error) {
      if (!(error instanceof Cancelled)) { try { ctx.assert(); message(error instanceof SetupError ? error.message : GENERIC_ERROR, true); } catch {} }
    } finally {
      try { ctx.assert(); busy = false; if (submit) submit.disabled = false; } catch {}
    }
  }
  function ordinarySignIn(note) {
    // Even an unexpected authentication result is never handed to the staff desk.
    clean(); active = true; view?.addEventListener('pagehide', pagehide);
    const {card, heading} = frame('Continue with normal sign-in', note);
    card.append(button('Return to staff sign-in', () => cancel())); heading.focus();
  }
  function complete(ctx) {
    ctx.assert(); clean(); container.hidden = true; onComplete();
  }
  async function ensureMfa(ctx, alwaysSet = false) {
    const enabled = alwaysSet ? false : mfaEnabled(await cognito(auth, 'GetUser', {AccessToken: access}, ctx));
    if (!enabled) {
      await cognito(auth, 'SetUserMFAPreference', {AccessToken: access, SoftwareTokenMfaSettings: {Enabled: true, PreferredMfa: true}}, ctx);
      const confirmed = await cognito(auth, 'GetUser', {AccessToken: access}, ctx);
      if (!mfaEnabled(confirmed)) throw new SetupError('Your authenticator could not be confirmed as active. Cancel and try setup again before signing in.');
    }
    complete(ctx);
  }
  async function verify(code, ctx) {
    let result = await cognito(auth, 'VerifySoftwareToken', {...(access ? {AccessToken: access} : {Session: session}), UserCode: code}, ctx);
    code = '';
    if (validSession(result.Session)) session = result.Session;
    if (result.Status !== 'SUCCESS') throw new SetupError(CODE_ERROR, true);
    session = validSession(result.Session) ? result.Session : '';
    secret = '';
    const {card} = frame('Finishing authenticator setup', 'Authenticator verified. Confirming that your account is ready for normal staff sign-in…'); card.append(cancelButton());
    // The verified key must never be shown again, including if the final request fails.
    if (access) { session = ''; await ensureMfa(ctx, true); return; }
    if (!validSession(session)) throw new SetupError('Your setup session has ended. Cancel and start setup again.');
    result = await cognito(auth, 'RespondToAuthChallenge', {ClientId: auth.enrollmentClientId, ChallengeName: 'MFA_SETUP', ChallengeResponses: {USERNAME: username}, Session: session}, ctx);
    session = ''; username = '';
    access = result.AuthenticationResult?.AccessToken || '';
    delete result.AuthenticationResult;
    if (!validToken(access)) throw new SetupError('Setup was verified, but sign-in confirmation did not finish. Cancel and use normal staff sign-in.');
    await ensureMfa(ctx);
  }
  function showKey() {
    const {card, heading} = frame('Add your staff authenticator', 'In your authenticator app, add an account using a setup key. Choose time-based codes, six digits and SHA-1 if asked. Keep this key private.');
    const key = field('Authenticator setup key', {type: 'password', readOnly: true, value: secret, autoComplete: 'off', spellcheck: false});
    const keyActions = node('div', undefined, 'staff-mfa-actions');
    const show = button('Show key', () => { key.input.type = key.input.type === 'password' ? 'text' : 'password'; show.textContent = key.input.type === 'password' ? 'Show key' : 'Hide key'; show.setAttribute('aria-pressed', String(key.input.type === 'text')); }, true);
    show.setAttribute('aria-pressed', 'false');
    const copy = button('Copy key', async () => {
      const ctx = context();
      try { if (!secret || !view?.navigator.clipboard?.writeText) throw new Error(); await view.navigator.clipboard.writeText(secret); ctx.assert(); message('Key copied. Paste it only into your authenticator app.'); }
      catch { try { ctx.assert(); message('Copy is unavailable here. Choose Show key and enter it in your authenticator app.'); } catch {} }
    }, true);
    keyActions.append(show, copy);
    const form = node('form'); form.setAttribute('autocomplete', 'off');
    const code = field('Six-digit authenticator code', {type: 'text', inputMode: 'numeric', autoComplete: 'one-time-code', pattern: '[0-9]{6}', maxLength: 6, required: true});
    submit = node('button', 'Verify authenticator'); submit.type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault(); if (busy) return;
      let value = code.input.value.trim(); code.input.value = '';
      if (!/^[0-9]{6}$/.test(value)) { message('Enter the six digits shown in your authenticator app.', true); code.input.focus(); return; }
      void run(ctx => verify(value, ctx)); value = '';
    });
    const actions = node('div', undefined, 'staff-mfa-actions'); actions.append(submit, cancelButton()); form.append(code.wrapper, actions);
    card.append(key.wrapper, keyActions, node('p', 'Name the account “Same End staff” in your app, then enter its current code below.', 'staff-mfa-help'), form); heading.focus();
  }
  async function associate(ctx) {
    const result = await cognito(auth, 'AssociateSoftwareToken', access ? {AccessToken: access} : {Session: session}, ctx);
    if (typeof result.SecretCode !== 'string' || !/^[A-Za-z0-9]{16,256}$/.test(result.SecretCode)) throw new SetupError(GENERIC_ERROR);
    if (!access && !validSession(result.Session)) throw new SetupError('Your setup session has ended. Cancel and start setup again.');
    secret = result.SecretCode; delete result.SecretCode;
    session = validSession(result.Session) ? result.Session : ''; ctx.assert(); showKey();
  }
  function credentials() {
    const {card, heading} = frame('Set up your staff authenticator', 'This one-time step sends your staff email and password directly to Amazon Cognito over a secure connection. Have your authenticator app ready. After setup, sign in normally to open the desk.');
    const form = node('form'); form.setAttribute('autocomplete', 'off');
    const email = field('Staff email', {type: 'email', autoComplete: 'username', required: true, maxLength: 128});
    const password = field('Staff password', {type: 'password', autoComplete: 'off', required: true, maxLength: 256});
    submit = node('button', 'Continue to authenticator setup'); submit.type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault(); if (busy) { password.input.value = ''; return; }
      const enteredUsername = email.input.value.trim();
      let enteredPassword = password.input.value; password.input.value = '';
      if (!enteredUsername || !enteredPassword) { enteredPassword = ''; message('Enter your staff email and password to continue.', true); return; }
      // Construct the request before releasing the local password reference. No retry stores it.
      const payload = {ClientId: auth.enrollmentClientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: {USERNAME: enteredUsername, PASSWORD: enteredPassword}};
      enteredPassword = '';
      void run(async ctx => {
        const result = await cognito(auth, 'InitiateAuth', payload, ctx);
        if (result.ChallengeName === 'SOFTWARE_TOKEN_MFA') { ordinarySignIn('An authenticator is already registered for this account. Use normal staff sign-in and enter the code there.'); return; }
        if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') { ordinarySignIn('Finish choosing your permanent password through normal staff sign-in first, then return here if authenticator setup is still needed.'); return; }
        if (result.ChallengeName !== 'MFA_SETUP' || !validSession(result.Session)) {
          delete result.AuthenticationResult;
          throw new SetupError('This account did not return an authenticator setup session. Cancel and use normal staff sign-in, or ask an administrator for help.');
        }
        session = result.Session;
        username = result.ChallengeParameters?.USER_ID_FOR_SRP || result.ChallengeParameters?.USERNAME || enteredUsername;
        if (typeof username !== 'string' || !username || username.length > 128) throw new SetupError(GENERIC_ERROR);
        await associate(ctx);
      });
    });
    const actions = node('div', undefined, 'staff-mfa-actions'); actions.append(submit, cancelButton());
    form.append(email.wrapper, password.wrapper, actions); card.append(form); heading.focus();
  }
  async function begin(accessToken) {
    clean(); active = true; container.hidden = false; view?.addEventListener('pagehide', pagehide);
    expiryTimer = setTimeout(() => {
      if (!active) return;
      ordinarySignIn('This setup window expired. Return to staff sign-in and start authenticator setup again.');
    }, SETUP_TIMEOUT);
    try {
      endpoint(auth);
      if (!/^[A-Za-z0-9]{1,128}$/.test(auth?.enrollmentClientId || '') || auth.enrollmentClientId === auth.clientId) throw new SetupError('Staff authenticator setup is not configured. Ask an administrator for help.');
      if (accessToken !== undefined && !validToken(accessToken)) throw new SetupError('Your staff sign-in has ended. Cancel and start setup again.');
      if (!accessToken) { credentials(); return; }
      access = accessToken; accessToken = '';
      const {card, heading} = frame('Set up your staff authenticator', 'Checking your account before creating a private authenticator key…'); card.append(cancelButton()); heading.focus();
      await run(async ctx => {
        const user = await cognito(auth, 'GetUser', {AccessToken: access}, ctx);
        if (mfaEnabled(user)) { ordinarySignIn('An authenticator is already registered for this account. Return to normal staff sign-in and enter its code there.'); return; }
        await associate(ctx);
      });
    } catch (error) {
      accessToken = ''; access = ''; session = ''; secret = ''; username = '';
      const {card, heading} = frame('Authenticator setup', 'Setup needs attention before you can continue.');
      message(error instanceof SetupError ? error.message : GENERIC_ERROR, true); card.append(cancelButton()); heading.focus();
    }
  }
  return {begin, cancel: () => cancel()};
}
