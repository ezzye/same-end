/* Staff credentials stay in this module's memory. Browser JWT decoding controls presentation only;
   API Gateway verifies signatures, and the API enforces roles and token_use independently. */
import {checkStaffMfa,createStaffMfa} from './staff-mfa.js';
export const PKCE_KEY = 'sameend.staff.pkce.v1';
export const STAFF_ROLES = ['sameend-admin', 'sameend-support', 'sameend-moderator', 'sameend-editor'];
const PANELS = {feedback: ['Feedback', 'sameend-support'], forum: ['Forum', 'sameend-moderator'], reports: ['Reports', 'sameend-moderator'], members: ['Members', 'sameend-moderator'], content: ['Waiting content', 'sameend-editor'], settings: ['Settings', 'sameend-admin'], audit: ['Audit trail', 'sameend-admin']};
export function isLoopback(hostname) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname); }
export function allowedPanels(groups) { return Object.keys(PANELS).filter(key => groups.includes('sameend-admin') || groups.includes(PANELS[key][1])); }
export function base64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
export async function makePkce(cryptoApi = globalThis.crypto) {
  const random = () => base64url(cryptoApi.getRandomValues(new Uint8Array(32)));
  const verifier = random();
  return {state: random(), nonce: random(), verifier, challenge: base64url(await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))};
}
export function validateAuthConfiguration(auth, currentUrl) {
  if (!auth || typeof auth.clientId !== 'string' || !/^[a-zA-Z0-9]{1,128}$/.test(auth.clientId)) throw new Error('Staff sign-in is not configured.');
  const issuer = new URL(auth.issuer), domain = new URL(auth.domain), redirect = new URL(auth.redirectUri), current = new URL(currentUrl);
  if (issuer.protocol !== 'https:' || !/^cognito-idp\.[a-z0-9-]+\.amazonaws\.com$/.test(issuer.hostname) || !/^\/[a-z0-9-]+_[A-Za-z0-9]+$/.test(issuer.pathname) || issuer.search || issuer.hash || issuer.username || issuer.password || issuer.port) throw new Error('Invalid staff issuer configuration.');
  if (domain.protocol !== 'https:' || !/^[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(domain.hostname) || domain.pathname !== '/' || domain.search || domain.hash || domain.username || domain.password || domain.port) throw new Error('Invalid staff sign-in domain.');
  if (redirect.protocol !== 'https:' || redirect.origin !== current.origin || redirect.pathname !== current.pathname || redirect.pathname !== '/manage.html' || redirect.search || redirect.hash || redirect.username || redirect.password) throw new Error('Open the configured secure staff address to sign in.');
  return {...auth, issuer: issuer.href.replace(/\/$/, ''), domain: domain.origin, redirectUri: redirect.href};
}
export function validatePkceTransaction(raw, state, redirectUri, now = Date.now()) {
  let transaction;
  try { transaction = JSON.parse(raw); } catch { throw new Error('Sign-in request is missing. Start again.'); }
  if (!transaction || !/^[A-Za-z0-9_-]{43}$/.test(transaction.state || '') || !/^[A-Za-z0-9_-]{43}$/.test(transaction.verifier || '') || !/^[A-Za-z0-9_-]{43}$/.test(transaction.nonce || '') || state !== transaction.state || transaction.redirectUri !== redirectUri || !Number.isFinite(transaction.createdAt) || now - transaction.createdAt > 600000 || transaction.createdAt > now + 1000) throw new Error('Sign-in request expired or did not match. Start again.');
  return transaction;
}
export function inspectIdToken(token, auth, nonce, now = Date.now()) {
  let claims;
  try {
    if (typeof token !== 'string' || token.length > 16000 || token.split('.').length !== 3) throw new Error();
    const part = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), char => char.charCodeAt(0))));
  } catch { throw new Error('Sign-in returned an unreadable identity token.'); }
  if (claims.iss !== auth.issuer || claims.aud !== auth.clientId || claims.token_use !== 'id' || claims.nonce !== nonce || !claims.sub || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now + 5000 || !Number.isFinite(claims.iat) || claims.iat * 1000 > now + 30000) throw new Error('Sign-in returned an invalid or expired identity token.');
  const groups = Array.isArray(claims['cognito:groups']) ? claims['cognito:groups'].filter(group => STAFF_ROLES.includes(group)) : [];
  if (!groups.length) throw new Error('This account has no Same End staff role. Ask an administrator for access.');
  return {groups, expiresAt: claims.exp * 1000, subject: claims.sub};
}
export function takeCallback(locationLike, historyLike) {
  const url = new URL(locationLike.href);
  const result = {code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.has('error')};
  // Remove OAuth code, state, error details and fragments before any network request or navigation.
  if (url.search || url.hash) historyLike.replaceState(null, '', url.pathname);
  return result;
}
export function contentPayload(form) {
  const text = key => String(form.get(key) || '').trim();
  const result = {id: text('id'), type: text('type'), title: text('title'), body: text('body'), published: form.get('published') === 'on', expectedVersion: Number(text('version') || 0)};
  if (result.type === 'quiz') {
    result.question = text('question'); result.choices = text('choices').split('\n').map(choice => choice.trim()).filter(Boolean);
    result.answerIndex = Number(text('answerIndex')) - 1;
    if (text('explanation')) result.explanation = text('explanation');
    if (result.choices.length < 2 || result.choices.length > 6 || !Number.isInteger(result.answerIndex) || result.answerIndex < 0 || result.answerIndex >= result.choices.length) throw new Error('A quiz needs 2–6 choices and a correct choice number.');
  }
  if (result.type === 'ad') {
    result.sponsor = text('sponsor'); result.url = text('url');
    if (!result.url) delete result.url;
    if (!result.sponsor) throw new Error('Add the sponsor name.');
    if (result.url) { const url = new URL(result.url); if (url.protocol !== 'https:' || url.hash || url.username || url.password) throw new Error('Sponsor links must use HTTPS without a fragment or embedded sign-in.'); }
  }
  for (const key of ['startsAt', 'endsAt']) if (text(key)) { result[key] = new Date(text(key)).getTime(); if (!Number.isFinite(result[key])) throw new Error('Choose a valid schedule date.'); }
  if (result.startsAt && result.endsAt && result.endsAt <= result.startsAt) throw new Error('The end of a schedule must follow its start.');
  return result;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') boot().catch(() => {
  const notice = document.getElementById('notice'); if (notice) { notice.textContent = 'The staff desk could not start. Reload to try again.'; notice.dataset.error = 'true'; }
});

async function boot() {
  const callback = takeCallback(window.location, window.history);
  const callbackTransaction = callback.code ? sessionStorage.getItem(PKCE_KEY) : null;
  if (callback.code || callback.error) sessionStorage.removeItem(PKCE_KEY);
  const $ = id => document.getElementById(id);
  const local = isLoopback(location.hostname);
  const baseValue = window.SameEndConfig?.apiBase || (local ? '/api' : '');
  let apiBase;
  try {
    const api = new URL(baseValue, location.origin);
    if (!baseValue || api.username || api.password || api.search || api.hash || (local ? !['https:', 'http:'].includes(api.protocol) : api.protocol !== 'https:')) throw new Error();
    apiBase = api.href.replace(/\/$/, '') + '/v1/community';
  } catch { $('session').textContent = 'Staff API is not configured'; $('signin-help').textContent = 'An administrator needs to configure this staff desk.'; return; }
  let requestedThread = '';
  let auth, token = '', expiry = 0, expiryTimer, groups = [], localReview = false, section = '', epoch = 0, authRedirectInProgress = false, mfaSetup = null;
  function message(value = '', error = false) { $('notice').textContent = value; $('notice').dataset.error = String(error); }
  function resetSession(note = 'Signed out', {preservePkce = false} = {}) {
    token = ''; expiry = 0; groups = []; localReview = false; epoch++; clearTimeout(expiryTimer);
    if(!preservePkce)sessionStorage.removeItem(PKCE_KEY);
    mfaSetup?.cancel(); $('desk').hidden = true; $('panel').replaceChildren(); $('sections').replaceChildren(); $('signin').hidden = false; $('signout').hidden = true; $('session').textContent = note;
  }
  async function request(path, {method = 'GET', body, publicRequest = false} = {}) {
    if (!publicRequest && (!token || expiry <= Date.now())) { resetSession('Session ended'); throw new Error('Your session ended. Sign in again.'); }
    const requestEpoch = epoch;
    const response = await fetch(`${apiBase}${path}`, {method, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: {...(!publicRequest ? {Authorization: `Bearer ${token}`} : {}), ...(body !== undefined ? {'Content-Type': 'application/json'} : {})}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
    if (!publicRequest && requestEpoch !== epoch) throw new Error('The session changed. Sign in again.');
    let payload; try { payload = await response.json(); } catch { throw new Error('The service returned an unreadable response. Try again.'); }
    if (!response.ok) {
      if (response.status === 401 && !publicRequest) resetSession('Session ended');
      if (response.status === 409) throw new Error('Someone changed this record. Refresh and review the latest version before saving.');
      if (response.status === 403) throw new Error('Your staff role does not allow this action.');
      throw new Error(response.status === 429 ? 'The desk is busy. Wait a moment and try again.' : String(payload.message || payload.error || 'The request could not be completed.').slice(0, 220));
    }
    return payload;
  }
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = String(text); if (className) el.className = className; return el; };
  const button = (label, action, className = 'secondary') => { const el = node('button', label, className); el.type = 'button'; el.addEventListener('click', () => run(el, action)); return el; };
  async function run(control, action) { control.disabled = true; message(); try { await action(); } catch (error) { message(error.message || 'The action failed. Try again.', true); } finally { control.disabled = false; } }
  const field = (label, tag = 'input', value = '', options = {}) => { const wrapper = node('label', label); const input = node(tag); input.setAttribute('aria-label', label); Object.assign(input, {value, ...options}); wrapper.append(input); return {wrapper, input}; };
  const selectField = (label, values, value) => { const out = field(label, 'select'); values.forEach(item => { const option = node('option', Array.isArray(item) ? item[1] : item); option.value = Array.isArray(item) ? item[0] : item; out.input.append(option); }); if (value !== undefined) out.input.value = value; return out; };
  const actions = (...children) => { const el = node('div', undefined, 'actions'); el.append(...children); return el; };
  const card = () => node('article', undefined, 'card');
  const date = time => Number.isFinite(Number(time)) ? new Date(Number(time)).toLocaleString() : 'Unknown time';
  function details(label, value) { const el = node('details', undefined, 'details'); el.append(node('summary', label), node('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2))); return el; }
  const version = record => { if (!Number.isInteger(record?.version) || record.version < 0) throw new Error('This record has no edit version. Refresh after the service has been updated.'); return record.version; };
  function activateSession(newToken, metadata, review = false) {
    token = newToken; expiry = metadata.expiresAt; groups = metadata.groups; localReview = review; epoch++;
    $('signin').hidden = true; $('desk').hidden = false; $('signout').hidden = false;
    $('session').textContent = review ? 'Local review · test credential · 30 minutes' : `Signed in · ${groups.map(role => role.slice(8)).join(', ')} · until ${date(expiry)}`;
    clearTimeout(expiryTimer); expiryTimer = setTimeout(() => { resetSession('Session expired'); message('Your session ended. Sign in again to continue.'); }, Math.max(0, expiry - Date.now()));
    const available = allowedPanels(groups); $('sections').replaceChildren(); available.forEach(key => { const control = button(PANELS[key][0], () => show(key)); control.dataset.section = key; $('sections').append(control); });
    return show(available[0]);
  }
  $('refresh').addEventListener('click', () => run($('refresh'), () => show(section)));
  $('signout').addEventListener('click', () => {
    const wasReview = localReview; resetSession(); message('Signed out. Staff information has been cleared from this desk.');
    if (auth && !wasReview) { const url = new URL('/logout', auth.domain); url.search = new URLSearchParams({client_id: auth.clientId, logout_uri: auth.redirectUri}); location.assign(url.href); }
  });
  async function show(key) {
    if (!allowedPanels(groups).includes(key)) throw new Error('This section is not available for your staff role.');
    section = key; const thisEpoch = ++epoch; message(); $('section-title').textContent = PANELS[key][0]; $('panel').replaceChildren(node('p', 'Loading…', 'muted'));
    document.querySelectorAll('#sections button').forEach(control => control.setAttribute('aria-current', String(control.dataset.section === key)));
    const container = node('div'); $('panel').replaceChildren(container);
    try { await ({feedback, forum, reports, members, content, settings, audit}[key])(container, thisEpoch); } catch (error) { if (thisEpoch === epoch) { container.replaceChildren(node('p', 'This section could not load. Use Refresh to try again.', 'empty')); throw error; } }
  }
  async function listing(container, path, render, scopeEpoch, query = '') {
    const cards = node('div', undefined, 'cards'); container.append(cards); let cursor; let loaded = false;
    const more = button('Load more', async () => load(), 'secondary more'); more.hidden = true; container.append(more);
    async function load() {
      const separator = query ? '&' : '?'; const data = await request(`${path}${query}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (scopeEpoch !== epoch) return;
      const items = Array.isArray(data.items) ? data.items : [];
      if (!loaded && !items.length) cards.append(node('p', 'Nothing here yet.', 'empty'));
      items.forEach(item => cards.append(render(item))); loaded = true; cursor = data.cursor; more.hidden = !cursor;
    }
    await load();
  }
  async function feedback(container, scopeEpoch) {
    container.append(node('p', 'Feedback is private to the sender and support staff. Replies appear in the sender’s feedback history.', 'muted'));
    await listing(container, '/admin/feedback', item => {
      const el = card(); el.append(node('h2', item.title), node('p', `${item.kind} · ${item.status} · ${date(item.createdAt)}`, 'meta'), node('p', item.text, 'body'));
      if (item.contact) el.append(details('Sender contact', item.contact)); if (item.diagnostics) el.append(details('Submitted diagnostics', item.diagnostics));
      const status = selectField('Status', ['received', 'investigating', 'answered', 'fixed'], item.status), response = field('Reply to the sender', 'textarea', item.response || '', {maxLength: 4000});
      el.append(status.wrapper, response.wrapper, actions(button('Save reply and status', async () => { await request(`/admin/feedback/${encodeURIComponent(item.id)}`, {method: 'POST', body: {status: status.input.value, response: response.input.value, expectedVersion: version(item)}}); await show('feedback'); message('Feedback updated.'); })));
      return el;
    }, scopeEpoch);
  }
  function moderationControls(item, thread, onSaved) {
    const out = node('div'); const reason = field('Reason for the audit trail', 'textarea', '', {maxLength: 300, placeholder: 'Explain this moderation decision'}); out.append(reason.wrapper);
    async function moderate(action, target) { if (!reason.input.value.trim()) throw new Error('Add a short reason before applying moderation.'); await request('/admin/moderation', {method: 'POST', body: {threadId: thread.id, postId: target.id, action, reason: reason.input.value.trim(), expectedVersion: version(target)}}); await onSaved(); message('Moderation saved.'); }
    const controls = [];
    if (!item.deleted) controls.push(button(item.hidden ? 'Restore post' : 'Hide post', () => moderate(item.hidden ? 'restore' : 'hide', item)));
    if (item.id === thread.id) controls.push(button(thread.locked ? 'Unlock thread' : 'Lock thread', () => moderate(thread.locked ? 'unlock' : 'lock', thread)));
    out.append(actions(...controls)); return out;
  }
  async function forum(container, scopeEpoch) {
    const category = selectField('Category', [['', 'All categories'], ['general', 'General'], ['club', 'Club'], ['match', 'Match · spoilers'], ['ideas', 'Ideas']], '');
    const threadLookup = field('Open a thread by ID', 'input', requestedThread, {maxLength: 36});
    const filters = node('div', undefined, 'filters'); filters.append(category.wrapper, threadLookup.wrapper, button('Open thread', () => openThread(threadLookup.input.value.trim()))); container.append(filters);
    const list = node('div'); container.append(list); let categoryEpoch = scopeEpoch;
    async function load() { list.replaceChildren(); categoryEpoch = ++epoch; await listing(list, '/admin/threads', item => {
      const el = card(); el.append(button(item.title, () => openThread(item.id), 'record-button'), node('p', `${item.category} · ${item.authorName || item.authorId} · ${item.replyCount || 0} replies · ${item.hidden ? 'Hidden' : 'Visible'}${item.locked ? ' · Locked' : ''}`, 'meta')); return el;
    }, categoryEpoch, category.input.value ? `?category=${encodeURIComponent(category.input.value)}` : ''); }
    category.input.addEventListener('change', () => run(category.input, load)); await load();
    if (requestedThread) { const id = requestedThread; requestedThread = ''; await openThread(id); }
    async function openThread(id) {
      const thisEpoch = ++epoch; const data = await request(`/admin/threads/${encodeURIComponent(id)}`); if (thisEpoch !== epoch) return;
      container.replaceChildren(actions(button('← Back to threads', () => show('forum')))); const thread = data.thread;
      const posts = node('div', undefined, 'cards'); container.append(posts);
      function post(item) { const el = card(); if (item.id === thread.id) el.append(node('h2', thread.title)); el.append(node('p', `${item.authorName || item.authorId} · ${date(item.createdAt)}${item.hidden ? ' · Hidden' : ''}${item.deleted ? ' · Author deleted' : ''}`, 'meta'), node('p', item.deleted ? 'The author deleted this post. Its text cannot be restored.' : item.text, 'body')); el.append(details('Member ID for participation review', item.authorId)); if (item.id === thread.id) el.append(node('p', thread.locked ? 'Thread locked' : 'Replies open', 'badge')); if (!item.deleted || item.id === thread.id) el.append(moderationControls(item, thread, () => openThread(id))); return el; }
      posts.append(post(thread)); (data.replies || []).forEach(item => posts.append(post(item))); let cursor = data.cursor;
      const more = button('Load more replies', async () => { const next = await request(`/admin/threads/${encodeURIComponent(id)}?cursor=${encodeURIComponent(cursor)}`); if (thisEpoch !== epoch) return; (next.replies || []).forEach(item => posts.append(post(item))); cursor = next.cursor; more.hidden = !cursor; }); more.hidden = !cursor; container.append(actions(more));
    }
  }
  async function reports(container, scopeEpoch) {
    container.append(node('p', 'Review the reported thread in Forum before deciding. Resolving a report does not hide a post.', 'muted'));
    await listing(container, '/admin/reports', item => {
      const el = card(); el.append(node('h2', `Report · ${item.status}`), node('p', item.reason, 'body'), node('p', `Thread ${item.threadId} · Post ${item.postId} · ${date(item.createdAt)}`, 'meta'));
      el.append(actions(button('Review reported thread', async () => { requestedThread = item.threadId; await show('forum'); })));
      const status = selectField('Report status', ['open', 'resolved'], item.status), note = field('Staff note', 'textarea', item.note || '', {maxLength: 500});
      el.append(status.wrapper, note.wrapper, actions(button('Save report decision', async () => { await request(`/admin/reports/${encodeURIComponent(item.id)}`, {method: 'POST', body: {status: status.input.value, note: note.input.value, expectedVersion: version(item)}}); await show('reports'); message('Report updated.'); }))); return el;
    }, scopeEpoch);
  }
  async function members(container) {
    container.append(node('p', 'Use the author ID from a thread to find a member. Suspension prevents forum participation; feedback remains available.', 'muted'));
    const search = field('Member ID', 'input', '', {maxLength: 128}), result = node('div');
    container.append(search.wrapper, actions(button('Find member', async () => {
      if (!search.input.value.trim()) throw new Error('Enter a member ID.'); const item = await request(`/admin/members/${encodeURIComponent(search.input.value.trim())}`); result.replaceChildren(); const el = card(); el.append(node('h2', item.name || item.id), node('p', `${item.id} · ${item.status}`, 'meta'));
      const status = selectField('Participation', [['active', 'Active'], ['suspended', 'Suspended']], item.status);
      el.append(status.wrapper, actions(button('Save participation status', async () => { await request(`/admin/members/${encodeURIComponent(item.id)}`, {method: 'POST', body: {status: status.input.value, expectedVersion: version(item)}}); await show('members'); message('Member participation updated.'); }))); result.append(el);
    })), result);
  }
  async function content(container) {
    const data = await request('/admin/content'); const items = data.items || []; container.append(node('p', `Text only · published content follows its schedule · pack revision ${data.revision || 0}`, 'muted'));
    const picker = selectField('Edit an item', [['', 'Create a new item'], ...items.map(item => [item.id, `${item.title} · ${item.published ? 'published' : 'draft'}`])], ''); container.append(picker.wrapper);
    const split = node('div', undefined, 'split'); container.append(split);
    const form = node('form', undefined, 'editor'), preview = node('aside', undefined, 'preview'); form.append(node('h2', 'Prepare waiting content')); split.append(form, preview);
    const fields = {};
    function add(name, label, tag, options) { const out = field(label, tag || 'input', '', {name, ...options}); fields[name] = out; form.append(out.wrapper); return out.input; }
    add('id', 'Item ID', 'input', {required: true, maxLength: 36, readOnly: true}); add('version', 'Edit version', 'input', {type: 'hidden'}); fields.version.wrapper.hidden = true; fields.id.wrapper.hidden = true;
    fields.type = selectField('Item type', [['story', 'Short story'], ['quiz', 'Quiz'], ['ad', 'Sponsor card']]); fields.type.input.name = 'type'; form.append(fields.type.wrapper);
    add('title', 'Title', 'input', {required: true, maxLength: 120}); add('body', 'Body', 'textarea', {required: true, maxLength: 4000});
    add('question', 'Quiz question', 'input', {maxLength: 240}); add('choices', 'Quiz choices · one per line, 2–6 choices', 'textarea', {maxLength: 965}); add('answerIndex', 'Correct choice number · starts at 1', 'input', {type: 'number', min: 1, max: 6}); add('explanation', 'Answer explanation', 'textarea', {maxLength: 1000});
    add('sponsor', 'Sponsor name', 'input', {maxLength: 100}); add('url', 'Sponsor link · HTTPS only', 'input', {type: 'url', maxLength: 500});
    add('startsAt', 'Starts · your local time (optional)', 'input', {type: 'datetime-local'}); add('endsAt', 'Ends · your local time (optional)', 'input', {type: 'datetime-local'});
    add('published', 'Published · show during its schedule', 'input', {type: 'checkbox'}); fields.published.wrapper.className = 'check';
    const save = node('button', 'Save item'); save.type = 'submit'; const remove = button('Delete item', async () => {
      const id = fields.id.input.value; if (!confirm('Delete this waiting-content item? Fans will no longer receive it.')) return;
      await request(`/admin/content/${encodeURIComponent(id)}`, {method: 'DELETE', body: {expectedVersion: Number(fields.version.input.value)}}); await show('content'); message('Content deleted.');
    }, 'danger'); form.append(actions(save, remove));
    function localDate(value) { if (!value) return ''; const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
    function edit(item) {
      fields.id.input.readOnly = true; remove.hidden = !item;
      for (const [name, {input}] of Object.entries(fields)) {
        if (name === 'published') input.checked = Boolean(item?.published);
        else if (name === 'version') input.value = item ? version(item) : 0;
        else if (name === 'id') input.value = item?.id || crypto.randomUUID();
        else if (name === 'type') input.value = item?.type || 'story';
        else if (name === 'choices') input.value = (item?.choices || []).join('\n');
        else if (name === 'answerIndex') input.value = Number.isInteger(item?.answerIndex) ? item.answerIndex + 1 : 1;
        else if (['startsAt', 'endsAt'].includes(name)) input.value = localDate(item?.[name]);
        else input.value = item?.[name] || '';
      }
      paintPreview();
    }
    function paintPreview() {
      const type = fields.type.input.value;
      ['question', 'choices', 'answerIndex', 'explanation'].forEach(name => { fields[name].wrapper.hidden = type !== 'quiz'; }); ['sponsor', 'url'].forEach(name => { fields[name].wrapper.hidden = type !== 'ad'; });
      preview.replaceChildren(node('h2', 'Fan preview'), node('p', fields.published.input.checked ? 'Published when schedule is active' : 'Draft · fans cannot see this', 'badge'), node('h3', fields.title.input.value || 'Your title'), node('p', fields.body.input.value || 'Your text appears here.', 'body'));
      if (type === 'quiz') {
        preview.append(node('h3', fields.question.input.value || 'Your question')); const list = node('ol'); fields.choices.input.value.split('\n').filter(choice => choice.trim()).forEach(choice => list.append(node('li', choice))); preview.append(list, details('Reveal answer', `Choice ${fields.answerIndex.input.value}\n${fields.explanation.input.value}`));
      }
      if (type === 'ad') { preview.append(node('p', `Sponsor: ${fields.sponsor.input.value || 'Sponsor name'}`, 'muted')); if (fields.url.input.value) preview.append(node('p', fields.url.input.value, 'body')); }
    }
    picker.input.addEventListener('change', () => { edit(items.find(item => item.id === picker.input.value)); }); form.addEventListener('input', paintPreview);
    form.addEventListener('submit', event => { event.preventDefault(); run(save, async () => { const payload = contentPayload(new FormData(form)); await request('/admin/content', {method: 'POST', body: payload}); await show('content'); message('Content saved. The fan pack contains only published items within their schedule.'); }); }); edit();
  }
  async function settings(container) {
    const item = await request('/admin/settings'); const el = node('form', undefined, 'editor');
    const enabled = field('Allow forum membership and discussion', 'input', '', {type: 'checkbox', checked: Boolean(item.forumEnabled)}); enabled.wrapper.className = 'check';
    const code = field('Set or rotate pilot joining code', 'input', '', {type: 'password', autoComplete: 'new-password', maxLength: 128, placeholder: 'Leave blank to keep the current code'});
    el.append(node('h2', 'Forum pilot'), node('p', item.hasJoinCode ? 'A joining code is configured. It cannot be retrieved here.' : 'Set a joining code before enabling the forum.', 'muted'), enabled.wrapper, code.wrapper, node('p', 'Rotating the joining code affects future joins. Existing members keep their membership.', 'muted'));
    const save = node('button', 'Save settings'); el.append(save); el.addEventListener('submit', event => { event.preventDefault(); run(save, async () => { const body = {forumEnabled: enabled.input.checked, expectedVersion: version(item)}; if (code.input.value.trim()) body.joinCode = code.input.value.trim(); await request('/admin/settings', {method: 'POST', body}); code.input.value = ''; await show('settings'); message('Forum settings saved. Share any new pilot code privately with intended members.'); }); }); container.append(el);
  }
  async function audit(container, scopeEpoch) {
    container.append(node('p', 'Staff actions, targets and times. Credentials, feedback text and private room details do not belong in this log.', 'muted'));
    await listing(container, '/admin/audit', item => {
      const el = card(); el.append(node('h2', item.action), node('p', `Actor ${item.actorId || item.actor || 'unknown'} · Target ${item.target || item.targetId || ''}`, 'meta'), node('p', date(item.time || item.createdAt), 'meta')); if (item.reason) el.append(node('p', item.reason, 'body')); return el;
    }, scopeEpoch);
  }
  $('hosted-signin').addEventListener('click', () => run($('hosted-signin'), async () => {
    if (!auth) throw new Error('Secure staff sign-in is not configured for this address.');
    mfaSetup?.cancel();
    const transaction = await makePkce(); sessionStorage.setItem(PKCE_KEY, JSON.stringify({...transaction, createdAt: Date.now(), redirectUri: auth.redirectUri}));
    const url = new URL('/oauth2/authorize', auth.domain); url.search = new URLSearchParams({response_type: 'code', client_id: auth.clientId, redirect_uri: auth.redirectUri, scope: 'openid email aws.cognito.signin.user.admin', state: transaction.state, nonce: transaction.nonce, code_challenge: transaction.challenge, code_challenge_method: 'S256'});
    authRedirectInProgress=true;
    try{location.assign(url.href);}catch(error){authRedirectInProgress=false;sessionStorage.removeItem(PKCE_KEY);throw error;}
  }));
  $('finish-mfa').addEventListener('click',()=>run($('finish-mfa'),async()=>{
    if(!mfaSetup)throw new Error('Authenticator setup is not configured yet. Reload and try again.');
    resetSession('Finish authenticator setup');await mfaSetup.begin();
  }));
  $('review-signin').hidden = !local;
  $('review-signin').addEventListener('submit', event => { event.preventDefault(); const control = $('review-signin').querySelector('button'); run(control, async () => {
    const credential = $('review-token').value.trim(); $('review-token').value = ''; if (!local || !credential) throw new Error('Enter the explicitly configured local review credential.');
    await activateSession(credential, {groups: STAFF_ROLES, expiresAt: Date.now() + 1800000}, true);
  }); });
  try {
    const config = await request('/config', {publicRequest: true});
    try { auth = validateAuthConfiguration(config.adminAuth, location.href); $('hosted-signin').disabled = false; $('session').textContent = 'Signed out';
      mfaSetup=createStaffMfa({auth,container:$('staff-mfa'),onComplete:()=>{message('Your authenticator is ready. Choose “Sign in securely” to finish.');$('session').textContent='Authenticator ready';$('hosted-signin').disabled=false;$('hosted-signin').focus();},onCancel:()=>{$('hosted-signin').disabled=!auth;}});
      $('finish-mfa').hidden=!auth.enrollmentClientId;
    }
    catch (error) { $('session').textContent = local ? 'Local review' : 'Sign-in unavailable'; $('signin-help').textContent = local ? 'Use the configured test credential below for local review. Production requires secure sign-in and MFA.' : error.message; }
    if (callback.error) { sessionStorage.removeItem(PKCE_KEY); throw new Error('Secure sign-in was cancelled or failed. Start again.'); }
    if (callback.code) {
      const raw = callbackTransaction;
      if (!auth) throw new Error('Staff sign-in configuration is unavailable. Start again at the secure staff address.');
      const transaction = validatePkceTransaction(raw, callback.state, auth.redirectUri);
      const response = await fetch(`${auth.domain}/oauth2/token`, {method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: auth.clientId, redirect_uri: auth.redirectUri, code: callback.code, code_verifier: transaction.verifier})});
      if (!response.ok) throw new Error('Sign-in could not be completed. Start again.'); const result = await response.json();
      const metadata=result.id_token?inspectIdToken(result.id_token,auth,transaction.nonce):null;
      if(typeof result.access_token!=='string')throw new Error('Sign-in did not return the information needed to check your authenticator. Start again.');
      const registered=await checkStaffMfa(auth,result.access_token);
      if(!registered){
        const setupToken=result.access_token;delete result.access_token;delete result.id_token;delete result.refresh_token;
        message('Finish setting up your authenticator before opening management.');$('session').textContent='Authenticator setup required';await mfaSetup.begin(setupToken);
      }else{
        delete result.access_token;delete result.refresh_token;
        if(!metadata)throw new Error('Your authenticator is ready. Choose “Sign in securely” again to finish.');
        await activateSession(result.id_token,metadata);
      }
    }
  } catch (error) { message(error.message || 'Staff sign-in could not be loaded. Reload to try again.', true); }
  // Unloading clears credentials naturally. A back/forward-cache restoration must sign in again.
  window.addEventListener('pagehide', () => {
    resetSession('Signed out',{preservePkce:authRedirectInProgress});
    authRedirectInProgress=false;
  });
}
