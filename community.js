/* Fan forum (section 3) and private feedback. No room secrets or chat are read here.
 * Anyone can read an open forum. Posting, replying and liking need the pilot code. */
(function () {
  'use strict';
  const STORE_KEY = 'sameend-fan-identity-v1', UI_KEY = 'sameend-forum-ui-v1', DRAFT_KEY = 'sameend-fc-feedback-draft';
  const CATEGORIES = [{ id: 'general', label: 'General' }, { id: 'club', label: 'Club' }, { id: 'match', label: 'Match' }, { id: 'ideas', label: 'Ideas' }];
  const SORTS = [{ id: 'hot', label: 'Hot' }, { id: 'new', label: 'New' }, { id: 'top', label: 'Top' }];
  const POLL_MS = 25000, MAX_POLL_MS = 120000, CHILD_PREVIEW = 3, TOP_PREVIEW = 20;
  const RULES = 'I agree to the forum rules: be kind, keep personal information private, and never post viewing links or private room details. Posts are public: anyone using Same End can read them.';
  const state = {
    identity: null, me: null, meLoaded: false, ui: { open: false, sort: 'hot', category: 'all', commentSort: 'top', lastSeen: 0 },
    list: { items: [], cursor: null, total: 0, latest: 0, loaded: false, loading: false, error: '' },
    thread: null, pending: 0, closed: false, revealed: new Set(), drafts: new Map(), composing: false, joining: false,
    replyTo: null, menuFor: null, reportFor: null, deleteFor: null, timer: null, pollMs: POLL_MS, busy: false,
    feedbackOpen: false, focus: null, draft: null, built: false,
  };

  // ---------- small DOM helpers ----------
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'className') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') for (const [e, f] of Object.entries(v)) n.addEventListener(e, f);
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'required' || k === 'value') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children || []) if (c !== null && c !== undefined && c !== false) n.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }
  function replace(n, ...children) { n.replaceChildren(...children.filter(Boolean)); }
  function button(label, fn, cls, attrs) { return el('button', { type: 'button', className: cls || 'ff-btn', on: { click: fn }, ...(attrs || {}) }, typeof label === 'string' ? [label] : label); }
  const $ = id => document.getElementById(id);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const categoryLabel = id => (CATEGORIES.find(c => c.id === id) || { label: 'General' }).label;
  const SVG = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const paths = {
      up: 'M12 5l7 8h-4.5v6h-5v-6H5z', comment: 'M4 5h16v11H9l-5 4z', back: 'M15 5l-7 7 7 7', more: 'M5 12h.01M12 12h.01M19 12h.01',
      reply: 'M10 8L4 13l6 5M4 13h10a6 6 0 0 1 6 6', chevron: 'M6 9l6 6 6-6', plus: 'M12 5v14M5 12h14',
    };
    const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'ff-icon ff-icon-' + name);
    const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', paths[name]); svg.append(p); return svg;
  }
  function ago(time) {
    if (!Number.isFinite(time)) return '';
    const s = Math.round((time - Date.now()) / 1000), abs = Math.abs(s);
    if (abs < 45) return 'just now';
    try {
      const f = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto', style: 'short' });
      if (abs < 3600) return f.format(Math.round(s / 60), 'minute');
      if (abs < 86400) return f.format(Math.round(s / 3600), 'hour');
      if (abs < 7 * 86400) return f.format(Math.round(s / 86400), 'day');
    } catch (_) { /* Older browsers fall through to a date. */ }
    return new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: abs > 300 * 86400 ? 'numeric' : undefined });
  }
  function stamp(time) {
    const t = el('time', { className: 'ff-time', text: ago(time) });
    if (Number.isFinite(time)) { t.dateTime = new Date(time).toISOString(); t.title = new Date(time).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
    return t;
  }
  function tone(name) { let h = 0; for (const ch of String(name || '').trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0; return String(h % 8); }
  function avatar(name, small) {
    const first = [...String(name || '').trim()][0];
    return el('span', { className: 'ff-avatar' + (small ? ' ff-avatar-sm' : ''), 'data-tone': name ? tone(name) : 'x', 'aria-hidden': 'true', text: first ? first.toLocaleUpperCase('en-GB') : '·' });
  }

  // ---------- storage, identity and requests ----------
  function loadUI() {
    try { Object.assign(state.ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch (_) { /* Defaults. */ }
    if (!SORTS.some(s => s.id === state.ui.sort)) state.ui.sort = 'hot';
    if (state.ui.category !== 'all' && !CATEGORIES.some(c => c.id === state.ui.category)) state.ui.category = 'all';
    if (state.ui.commentSort !== 'new') state.ui.commentSort = 'top';
  }
  function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(state.ui)); } catch (_) { /* Per-browser convenience only. */ } }
  function apiBase() {
    let base = window.SameEndConfig && window.SameEndConfig.apiBase;
    if (!base && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) base = '/api';
    if (!base) throw new Error('The fan forum is not connected on this copy of Same End.');
    const u = new URL(base, location.href);
    if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) || u.username || u.password || u.hash || u.search) throw new Error('The fan forum is not configured correctly.');
    return u.href.replace(/\/$/, '');
  }
  const KNOWN = { forum_closed: 'The fan forum is not open yet.', membership_required: 'Join the conversation to post, reply or like.', thread_locked: 'This discussion is locked.', reply_limit: 'This discussion has reached its reply limit.', join_unavailable: 'That code was not accepted. Check it with the organiser.', post_not_found: 'That comment is no longer available.', thread_not_found: 'This discussion is no longer available.', member_suspended: 'This identity cannot take part in the forum.' };
  function request(path, method, body, auth) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && state.identity) headers.Authorization = 'Bearer ' + state.identity.token;
    let url; try { url = apiBase() + '/v1/community' + path; } catch (e) { return Promise.reject(e); }
    return fetch(url, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(r => r.json().catch(() => ({})).then(data => {
        if (r.ok) return data;
        const e = new Error(KNOWN[data.code] || (r.status === 409 ? 'Something changed while you were working. Try again.' : r.status === 429 ? 'Too many requests. Give it a moment and try again.' : r.status === 401 ? 'Your saved fan identity was not recognised.' : 'The forum could not complete that. Try again shortly.'));
        e.status = r.status; e.code = data.code; throw e;
      }), e => { throw new Error(e instanceof TypeError ? 'The forum is unreachable. Check your connection and try again.' : e.message); });
  }
  // Reads include the saved identity (for likes and blocks) but never fail because of it.
  function read(path) { return request(path, 'GET', null, true).catch(e => { if (e.status === 401 && state.identity) return request(path, 'GET', null, false); throw e; }); }
  function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    return [...b].map((x, i) => ([4, 6, 8, 10].includes(i) ? '-' : '') + x.toString(16).padStart(2, '0')).join('');
  }
  function loadIdentity() {
    try { state.identity = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { state.identity = null; }
    if (!state.identity || !state.identity.id || !state.identity.token || !state.identity.name) state.identity = null;
  }
  function saveIdentity() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state.identity)); } catch (_) { throw new Error('This browser could not save your fan identity. Enable browser storage and try again.'); } }
  function ensureIdentity(name) {
    if (state.identity) return Promise.resolve(state.identity);
    if (!window.crypto || !crypto.getRandomValues || !crypto.subtle) return Promise.reject(new Error('This browser cannot securely create a fan identity.'));
    const token = b64(crypto.getRandomValues(new Uint8Array(32))), id = uuid(), cleanName = String(name || 'Fan').trim().slice(0, 40) || 'Fan';
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)).then(hash => {
      const tokenHash = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
      return request('/identities', 'POST', { id, tokenHash, name: cleanName }, false).then(profile => {
        state.identity = { id, token, name: String(profile.name || cleanName).slice(0, 40) }; saveIdentity(); state.me = profile; return state.identity;
      });
    });
  }
  function getMe() {
    return ensureIdentity().then(() => request('/me', 'GET', null, true)).then(m => { state.me = m; state.meLoaded = true; if (m && m.name) state.identity.name = String(m.name).slice(0, 40); return m; });
  }
  function loadMe() {
    if (!state.identity) { state.meLoaded = true; return Promise.resolve(null); }
    return getMe().catch(() => { state.meLoaded = true; return null; });
  }
  const member = () => !!(state.me && state.me.forumMember && state.me.status === 'active');

  // ---------- section shell ----------
  function status(text, bad) { const n = $('ff-status'); if (n) { n.textContent = text || ''; n.classList.toggle('ff-error', !!bad); } }
  function build() {
    if (state.built || !document.body) return; state.built = true;
    loadUI(); loadIdentity();
    const top = document.querySelector('.topbar');
    if (top) top.append(el('div', { className: 'fc-header-access' }, [button('Fan forum', () => openForum(), 'fc-access')]));
    const footer = document.querySelector('footer');
    if (footer) footer.insertBefore(el('div', { className: 'fc-footer-access' }, [button('Send feedback', () => openFeedback(), 'fc-access')]), footer.firstChild);
    const toggle = el('button', { type: 'button', id: 'ff-toggle', className: 'ff-toggle', 'aria-expanded': 'false', 'aria-controls': 'ff-body', on: { click: () => setOpen(!state.ui.open) } }, [
      el('span', { className: 'ff-step', 'aria-hidden': 'true', text: '3' }),
      el('span', { className: 'ff-head-copy' }, [el('span', { className: 'ff-title', id: 'ff-title', text: 'Fan forum' }), el('span', { className: 'ff-summary', id: 'ff-summary', text: 'Talk football with fans everywhere' })]),
      el('span', { className: 'ff-chevron' }, [icon('chevron')]),
    ]);
    const section = el('section', { id: 'fan-forum', className: 'ff', 'aria-labelledby': 'ff-title' }, [
      el('h2', { className: 'ff-heading' }, [toggle]),
      el('div', { id: 'ff-body', className: 'ff-body', hidden: true }, [
        el('p', { id: 'ff-status', className: 'ff-status', role: 'status', 'aria-live': 'polite' }),
        el('div', { id: 'ff-view', className: 'ff-view' }),
        el('p', { className: 'ff-foot' }, ['Posts are public. Be kind, and never share viewing links or private room details. ', button('Send private feedback to the Same End team', () => openFeedback(), 'ff-link')]),
      ]),
    ]);
    // Always third: directly after the two steps, and directly after the picture while a room is open.
    const quick = $('quick-room');
    if (quick && quick.parentNode) quick.parentNode.insertBefore(section, quick.nextSibling); else document.body.append(section);
    buildFeedbackPanel();
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(state.timer); else if (state.ui.open) poll(); });
    document.addEventListener('click', e => { if (state.menuFor && !e.target.closest('.ff-menu-wrap')) { state.menuFor = null; render(); } });
    setOpen(state.ui.open, true);
    loadMe().then(() => refreshList(true));
  }
  function setOpen(open, initial) {
    state.ui.open = !!open; saveUI();
    $('ff-toggle').setAttribute('aria-expanded', String(state.ui.open)); $('ff-body').hidden = !state.ui.open; $('fan-forum').classList.toggle('ff-is-open', state.ui.open);
    if (state.ui.open) { render(); if (!initial) markSeen(); schedule(); } else clearTimeout(state.timer);
  }
  function openForum() { build(); if (!state.ui.open) setOpen(true); $('fan-forum').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('ff-toggle').focus({ preventScroll: true }); }
  function markSeen() { if (state.list.loaded) { state.ui.lastSeen = Math.max(state.ui.lastSeen || 0, state.list.latest || 0); saveUI(); } }
  function updateSummary() {
    const n = $('ff-summary'); if (!n) return;
    if (state.closed) { n.textContent = 'Opening soon'; return; }
    if (!state.list.loaded) { n.textContent = 'Talk football with fans everywhere'; return; }
    const fresh = state.seenAtLoad ? state.list.items.filter(t => t.createdAt > state.seenAtLoad && (!state.identity || t.authorId !== state.identity.id)).length : 0;
    const parts = [plural(state.list.total, 'discussion')];
    if (fresh) parts.push(fresh + ' new since your last visit');
    else if (!state.list.total) parts.push('be the first to start one');
    n.textContent = parts.join(' · ');
  }

  // ---------- data ----------
  function listQuery(sort) { return '/threads?category=' + encodeURIComponent(state.ui.category) + '&sort=' + encodeURIComponent(sort || state.ui.sort); }
  function refreshList(reset) {
    if (reset) { state.list.items = []; state.list.cursor = null; }
    if (state.seenAtLoad === undefined) state.seenAtLoad = state.ui.lastSeen || 0;
    state.list.loading = true; state.list.error = ''; if (state.ui.open && !state.thread) render();
    return read(listQuery() + (state.list.cursor && !reset ? '&cursor=' + encodeURIComponent(state.list.cursor) : '')).then(data => {
      state.closed = false;
      state.list.items = reset ? data.items || [] : state.list.items.concat(data.items || []);
      state.list.cursor = data.cursor || null; state.list.total = Number.isFinite(data.total) ? data.total : state.list.items.length;
      state.list.latest = Math.max(state.list.latest || 0, data.latest || 0); state.list.loaded = true; state.pending = 0;
    }).catch(e => { if (e.code === 'forum_closed') state.closed = true; else state.list.error = e.message; })
      .finally(() => { state.list.loading = false; updateSummary(); if (state.ui.open && !state.thread) render(); if (state.ui.open) markSeen(); });
  }
  function openThread(id, keepScroll) {
    state.thread = { id, data: null, loading: true, collapsed: new Set(), expanded: new Set(), shown: TOP_PREVIEW };
    state.replyTo = null; state.pending = 0; state.menuFor = null; render();
    if (!keepScroll) $('fan-forum').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return loadThread();
  }
  function loadThread() {
    const t = state.thread; if (!t) return Promise.resolve();
    return read('/threads/' + encodeURIComponent(t.id)).then(data => { if (state.thread === t) { t.data = data; t.next = null; t.loading = false; t.error = ''; state.pending = 0; } })
      .catch(e => { if (state.thread === t) { t.loading = false; t.error = e.message; } })
      .finally(() => { if (state.thread === t) render(); });
  }

  // ---------- auto-refresh: only while the section is open and the page is visible ----------
  function schedule() { clearTimeout(state.timer); if (state.ui.open && !document.hidden) state.timer = setTimeout(poll, state.pollMs); }
  function poll() {
    clearTimeout(state.timer); if (!state.ui.open || document.hidden) return;
    const t = state.thread, mine = id => state.identity && id === state.identity.id;
    let check = Promise.resolve();
    if (t && t.data) check = read('/threads/' + encodeURIComponent(t.id)).then(data => {
      if (state.thread !== t || !t.data) return;
      const known = new Set(t.data.replies.map(r => r.id)), fresh = (data.replies || []).filter(r => !known.has(r.id) && !mine(r.authorId)).length;
      // Like counts refresh quietly; new comments wait until the reader asks for them.
      const scores = new Map((data.replies || []).map(r => [r.id, r.score]));
      for (const r of t.data.replies) if (scores.has(r.id)) r.score = scores.get(r.id);
      t.data.thread.score = data.thread.score; t.data.thread.replyCount = data.thread.replyCount;
      if (fresh) { state.pending = fresh; t.next = data; }
      updateScores(); updateLive();
    });
    else if (!t) check = read(listQuery('new')).then(data => {
      const known = new Set(state.list.items.map(x => x.id)), fresh = (data.items || []).filter(x => !known.has(x.id) && !mine(x.authorId)).length;
      if (Number.isFinite(data.total)) state.list.total = data.total;
      if (fresh) state.pending = fresh;
      updateLive(); updateSummary();
    });
    check.then(() => { state.pollMs = POLL_MS; }, () => { state.pollMs = Math.min(MAX_POLL_MS, state.pollMs * 2); }).then(schedule);
  }
  function updateScores() {
    const t = state.thread; if (!t || !t.data) return;
    const all = [t.data.thread].concat(t.data.replies);
    for (const p of all) document.querySelectorAll('[data-like="' + p.id + '"] .ff-score').forEach(n => { n.textContent = p.score || p.title || !n.closest('.ff-like-compact') ? String(p.score || 0) : ''; });
  }
  function updateLive() {
    const slot = $('ff-live'); if (!slot) return;
    replace(slot, state.pending ? button([icon('up'), (state.thread ? plural(state.pending, 'new comment') : plural(state.pending, 'new discussion')) + ' · Show'], () => {
      const t = state.thread;
      if (t && t.next) { t.data = t.next; t.next = null; state.pending = 0; render(); } else { state.pending = 0; refreshList(true); }
    }, 'ff-live-pill') : null);
  }

  // ---------- rendering ----------
  function render() {
    const view = $('ff-view'); if (!view || !state.ui.open) return;
    // Keep half-written text across re-renders.
    view.querySelectorAll('[data-draft]').forEach(n => state.drafts.set(n.dataset.draft, n.value));
    const focused = document.activeElement && view.contains(document.activeElement) ? document.activeElement.id : null;
    if (state.closed) replace(view, emptyState('The fan forum opens soon.', 'Check back later — or send the team your ideas now.'));
    else replace(view, ...(state.thread ? renderThread() : renderList()));
    view.querySelectorAll('textarea.ff-grow').forEach(grow);
    if (focused && $(focused)) $(focused).focus({ preventScroll: true });
    updateLive();
  }
  function emptyState(title, text, action) { return el('div', { className: 'ff-empty' }, [el('strong', { text: title }), el('p', { text }), action || null]); }
  function identityBar() {
    if (!state.meLoaded) return null;
    if (member()) return el('div', { className: 'ff-me' }, [avatar(state.me.name, true), el('span', { className: 'ff-me-name' }, ['Posting as ', el('b', { text: state.me.name })]),
      !state.thread && !state.composing ? button([icon('plus'), 'Start a discussion'], () => { state.composing = true; render(); const n = $('ff-new-title'); if (n) n.focus(); }, 'ff-btn ff-primary ff-start') : null]);
    if (state.joining) return joinForm();
    return el('div', { className: 'ff-guest' }, [el('p', {}, [el('b', { text: 'Reading as a guest. ' }), 'Join the conversation to start discussions, reply and like.']),
      button('Join the conversation', () => { state.joining = true; render(); const n = $('fc-name'); if (n) n.focus(); }, 'ff-btn ff-primary')]);
  }
  function joinForm() {
    const known = (state.me && state.me.name !== 'Fan' && state.me.name) || (state.identity && state.identity.name !== 'Fan' && state.identity.name) || '';
    const name = el('input', { id: 'fc-name', 'data-draft': 'join-name', maxlength: '40', required: true, autocomplete: 'nickname', placeholder: 'How other fans see you', value: state.drafts.get('join-name') || known });
    const code = el('input', { id: 'fc-code', type: 'password', maxlength: '128', minlength: '8', required: true, autocomplete: 'off', placeholder: 'From the organiser' });
    const agree = el('input', { id: 'fc-agree', type: 'checkbox', required: true });
    return el('form', { className: 'ff-join', on: { submit: e => { e.preventDefault(); joinForum(name.value, code.value, agree.checked); } } }, [
      el('strong', { className: 'ff-join-title', text: 'Join the conversation' }),
      el('div', { className: 'ff-join-grid' }, [field('Display name', name), field('Pilot code', code)]),
      el('label', { className: 'ff-check' }, [agree, ' ' + RULES]),
      el('div', { className: 'ff-actions' }, [el('button', { type: 'submit', className: 'ff-btn ff-primary', text: 'Join and start posting' }), button('Not now', () => { state.joining = false; render(); }, 'ff-btn ff-ghost')]),
    ]);
  }
  function field(label, control) { return el('label', { className: 'ff-field' }, [el('span', { text: label }), control]); }
  function joinForum(name, code, agreed) {
    if (!agreed || state.busy) return;
    const body = { code, agree: true }, chosen = String(name || '').trim().slice(0, 40); if (chosen) body.name = chosen;
    state.busy = true; status('Joining…');
    ensureIdentity(chosen || 'Fan').then(() => request('/membership', 'POST', body, true)).then(me => {
      state.me = me; state.meLoaded = true; if (me && me.name) state.identity.name = me.name; state.joining = false; state.drafts.delete('join-name');
      status('Welcome, ' + me.name + '. You can now post, reply and like.');
      // Re-read so your own likes and blocks apply.
      if (state.thread) loadThread(); else refreshList(true);
    }).catch(e => status(e.message, true)).finally(() => { state.busy = false; });
  }
  function needMember(message) { state.joining = true; state.replyTo = null; render(); status(message || 'Join the conversation to take part.'); const n = $('fc-name'); if (n) { n.scrollIntoView({ block: 'center', behavior: 'smooth' }); n.focus({ preventScroll: true }); } }

  function renderList() {
    const chips = el('div', { className: 'ff-chips', role: 'group', 'aria-label': 'Topics' }, [{ id: 'all', label: 'All' }].concat(CATEGORIES).map(c =>
      button(c.label, () => { if (state.ui.category === c.id) return; state.ui.category = c.id; saveUI(); refreshList(true); }, 'ff-chip ff-chip-' + c.id, { 'aria-pressed': String(state.ui.category === c.id) })));
    const sorts = el('div', { className: 'ff-sorts', role: 'group', 'aria-label': 'Sort discussions' }, SORTS.map(s =>
      button(s.label, () => { if (state.ui.sort === s.id) return; state.ui.sort = s.id; saveUI(); refreshList(true); }, 'ff-sort', { 'aria-pressed': String(state.ui.sort === s.id) })));
    const items = state.list.items;
    let list;
    if (state.list.loading && !items.length) list = el('div', { className: 'ff-list', 'aria-busy': 'true' }, [0, 1, 2].map(() => el('div', { className: 'ff-card ff-skeleton' }, [el('span'), el('span'), el('span')])));
    else if (state.list.error && !items.length) list = emptyState('The forum could not load.', state.list.error, button('Try again', () => refreshList(true), 'ff-btn'));
    else if (!items.length) list = emptyState(state.ui.category === 'all' ? 'No discussions yet.' : 'Nothing in ' + categoryLabel(state.ui.category) + ' yet.', member() ? 'Start the first one — what’s on your mind?' : 'Join the conversation and start the first one.');
    else list = el('div', { className: 'ff-list', id: 'fc-thread-list' }, items.map(card));
    return [identityBar(), state.composing && member() ? newThreadForm() : null, el('div', { className: 'ff-toolbar' }, [chips, sorts]), el('div', { id: 'ff-live', className: 'ff-live' }), list,
      state.list.cursor ? button(state.list.loading ? 'Loading…' : 'Show more discussions', () => refreshList(false), 'ff-btn ff-more-list', { disabled: state.list.loading }) : null];
  }
  function likeButton(threadId, post, compact) {
    const liked = post.myVote === 1, score = post.score || 0;
    // Like YouTube comments, an unliked comment shows just the arrow.
    return button([icon('up'), el('span', { className: 'ff-score', text: compact && !score && !post.title ? '' : String(score) })], e => { e.stopPropagation(); like(threadId, post); }, 'ff-like' + (liked ? ' ff-liked' : '') + (compact ? ' ff-like-compact' : ''),
      { 'aria-pressed': String(liked), 'aria-label': (liked ? 'Remove your like' : 'Like') + ' (' + plural(score, 'like') + ')', 'data-like': post.id });
  }
  function spoilerHidden(t) { return t.spoiler && !state.revealed.has(t.id); }
  function card(t) {
    const hidden = spoilerHidden(t), open = () => openThread(t.id);
    return el('article', { className: 'ff-card' + (t.locked ? ' ff-locked' : ''), 'data-category': t.category }, [
      el('div', { className: 'ff-card-vote' }, [likeButton(t.id, t, true)]),
      el('div', { className: 'ff-card-main' }, [
        el('div', { className: 'ff-meta' }, [el('span', { className: 'ff-tag ff-tag-' + t.category, text: categoryLabel(t.category) }), avatar(t.authorName, true), el('span', { className: 'ff-author', text: t.authorName || 'Fan' }), stamp(t.createdAt), t.locked ? el('span', { className: 'ff-badge', text: 'Locked' }) : null]),
        el('h3', { className: 'ff-card-title' }, [button(hidden ? 'Match discussion — spoilers hidden' : t.title || 'Discussion', open, 'ff-card-link fc-thread-card')]),
        hidden ? el('p', { className: 'ff-excerpt ff-spoiler-note', text: 'Contains match spoilers. Open it when you’re ready.' }) : t.excerpt ? el('p', { className: 'ff-excerpt', text: t.excerpt }) : null,
        el('div', { className: 'ff-card-foot' }, [button([icon('comment'), plural(t.replyCount || 0, 'comment')], open, 'ff-meta-btn', { tabindex: '-1' })]),
      ]),
    ]);
  }
  function newThreadForm() {
    const title = el('input', { id: 'ff-new-title', 'data-draft': 'new-title', maxlength: '120', required: true, placeholder: 'Give it a clear title', 'aria-label': 'Title', value: state.drafts.get('new-title') || '' });
    const text = el('textarea', { id: 'ff-new-text', 'data-draft': 'new-text', className: 'ff-grow', rows: '3', maxlength: '4000', required: true, placeholder: 'What do you want to talk about?', 'aria-label': 'Message', on: { input: e => grow(e.target) } });
    text.value = state.drafts.get('new-text') || '';
    let category = state.ui.category === 'all' ? 'general' : state.ui.category;
    const spoiler = el('input', { type: 'checkbox' }), spoilerRow = el('label', { className: 'ff-check', hidden: category === 'match' }, [spoiler, ' Contains match spoilers']);
    const topic = el('div', { className: 'ff-chips ff-topic', role: 'radiogroup', 'aria-label': 'Topic' });
    const drawTopic = () => replace(topic, ...CATEGORIES.map(c => button(c.label, () => { category = c.id; drawTopic(); spoilerRow.hidden = c.id === 'match'; }, 'ff-chip ff-chip-' + c.id, { role: 'radio', 'aria-checked': String(category === c.id) })));
    drawTopic();
    let postId = null; [title, text].forEach(n => n.addEventListener('input', () => { postId = null; }));
    return el('form', { className: 'ff-compose', on: { submit: e => {
      e.preventDefault(); if (state.busy) return; postId = postId || uuid(); state.busy = true; status('Posting…');
      request('/threads', 'POST', { id: postId, category, title: title.value.trim(), text: text.value.trim(), spoiler: category === 'match' || spoiler.checked }, true).then(t => {
        state.drafts.delete('new-title'); state.drafts.delete('new-text'); state.composing = false; status('Your discussion is live.');
        if (state.ui.category !== 'all' && state.ui.category !== category) state.ui.category = 'all';
        state.ui.sort = 'new'; saveUI(); state.revealed.add(t.id);
        return refreshList(true).then(() => openThread(t.id, true));
      }).catch(e2 => status(e2.message + ' Your text is still here.', true)).finally(() => { state.busy = false; });
    } } }, [
      el('strong', { className: 'ff-compose-title', text: 'Start a discussion' }), topic, title, text, spoilerRow,
      el('div', { className: 'ff-actions' }, [el('button', { type: 'submit', className: 'ff-btn ff-primary', text: 'Post discussion' }), button('Cancel', () => { state.composing = false; render(); }, 'ff-btn ff-ghost')]),
    ]);
  }

  // ---------- one discussion ----------
  function renderThread() {
    const t = state.thread, back = button([icon('back'), 'All discussions'], () => { state.thread = null; state.pending = 0; state.menuFor = null; render(); refreshList(true); }, 'ff-back');
    if (t.loading && !t.data) return [back, el('div', { className: 'ff-post ff-skeleton' }, [el('span'), el('span'), el('span')])];
    if (!t.data) return [back, emptyState('This discussion could not load.', t.error || '', button('Try again', () => openThread(t.id, true), 'ff-btn'))];
    const thread = t.data.thread, replies = t.data.replies || [];
    if (spoilerHidden(thread)) return [back, el('div', { className: 'ff-spoiler-gate' }, [el('strong', { text: 'Match discussion — spoilers hidden' }), el('p', { text: 'Reveal it when you’re ready. The title and comments may give away the score.' }), button('Show the discussion', () => { state.revealed.add(thread.id); render(); }, 'ff-btn ff-primary')])];
    const post = el('article', { className: 'ff-post' }, [
      el('div', { className: 'ff-meta' }, [el('span', { className: 'ff-tag ff-tag-' + thread.category, text: categoryLabel(thread.category) }), avatar(thread.authorName, true), el('span', { className: 'ff-author', text: thread.authorName }), stamp(thread.createdAt), thread.locked ? el('span', { className: 'ff-badge', text: 'Locked' }) : null]),
      el('h3', { className: 'ff-post-title fc-thread-title', text: thread.title }),
      el('p', { className: 'ff-post-text', text: thread.text }),
      el('div', { className: 'ff-c-actions' }, [likeButton(thread.id, thread), el('span', { className: 'ff-count' }, [icon('comment'), plural(visibleCount(replies), 'comment')]), moreMenu(thread, thread.id)]),
      inlineTools(thread, thread.id),
    ]);
    const sort = el('div', { className: 'ff-sorts', role: 'group', 'aria-label': 'Sort comments' }, [['top', 'Top'], ['new', 'Newest']].map(([id, label]) =>
      button(label, () => { state.ui.commentSort = id; saveUI(); render(); }, 'ff-sort', { 'aria-pressed': String(state.ui.commentSort === id) })));
    const composer = thread.locked ? el('p', { className: 'ff-note', text: 'This discussion is locked. New comments are closed.' }) : member() ? replyForm(thread.id, null) : identityBar();
    const tree = buildTree(replies), roots = sortRoots(tree.get(null) || []), shown = roots.slice(0, t.shown);
    return [back, post, composer,
      el('div', { className: 'ff-comments-head' }, [el('strong', { text: plural(visibleCount(replies), 'comment') }), sort]),
      el('div', { id: 'ff-live', className: 'ff-live' }),
      roots.length ? el('div', { className: 'ff-comments' }, shown.map(r => comment(r, tree, thread))) : emptyState('No comments yet.', member() ? 'Get the conversation going.' : 'Join the conversation to add the first comment.'),
      roots.length > t.shown ? button('Show ' + Math.min(TOP_PREVIEW, roots.length - t.shown) + ' more comments', () => { t.shown += TOP_PREVIEW; render(); }, 'ff-btn ff-more-list') : null];
  }
  const visibleCount = replies => replies.filter(r => !r.deleted && !r.hidden && !r.blocked).length;
  function buildTree(replies) { const map = new Map(); for (const r of replies) { const k = r.parentId || null; if (!map.has(k)) map.set(k, []); map.get(k).push(r); } return map; }
  function sortRoots(list) { return list.slice().sort(state.ui.commentSort === 'new' ? (a, b) => b.createdAt - a.createdAt : (a, b) => (b.score || 0) - (a.score || 0) || a.createdAt - b.createdAt); }
  function descendants(id, tree) { let n = 0; for (const c of tree.get(id) || []) n += 1 + descendants(c.id, tree); return n; }
  function comment(r, tree, thread) {
    const t = state.thread, children = tree.get(r.id) || [], collapsed = t.collapsed.has(r.id), removed = r.deleted || r.hidden || r.blocked, mine = state.identity && r.authorId === state.identity.id;
    const toggle = button(collapsed ? '+' : '−', () => { if (collapsed) t.collapsed.delete(r.id); else t.collapsed.add(r.id); render(); }, 'ff-collapse', { 'aria-expanded': String(!collapsed), 'aria-label': (collapsed ? 'Expand' : 'Collapse') + ' comment' + (r.authorName ? ' by ' + r.authorName : '') });
    const head = el('div', { className: 'ff-c-head' }, [
      el('span', { className: 'ff-author', text: removed ? (r.deleted ? '[deleted]' : r.hidden ? '[removed]' : '[hidden]') : r.authorName }),
      !removed && r.authorId === thread.authorId ? el('span', { className: 'ff-op', title: 'Started this discussion', text: 'OP' }) : null,
      !removed && mine ? el('span', { className: 'ff-you', text: 'You' }) : null,
      stamp(r.createdAt), toggle,
      collapsed && children.length ? el('span', { className: 'ff-hidden-count', text: plural(descendants(r.id, tree), 'reply') + ' hidden' }) : null,
    ]);
    const body = [head];
    if (!collapsed) {
      body.push(removed ? el('p', { className: 'ff-c-text ff-removed', text: r.deleted ? 'This comment was deleted by its author.' : r.hidden ? 'This comment was removed by a moderator.' : 'You blocked this fan.' })
        : el('p', { className: 'ff-c-text' }, [r.replyToName ? el('span', { className: 'ff-mention', text: '@' + r.replyToName + ' ' }) : null, r.text]));
      if (!removed) {
        body.push(el('div', { className: 'ff-c-actions' }, [likeButton(thread.id, r, true),
          !thread.locked ? button([icon('reply'), 'Reply'], () => { if (!member()) { needMember('Join the conversation to reply.'); return; } state.replyTo = state.replyTo === r.id ? null : r.id; render(); const box = $('ff-reply-' + r.id); if (box) box.focus(); }, 'ff-meta-btn') : null,
          moreMenu(r, thread.id)]));
        body.push(inlineTools(r, thread.id));
        if (state.replyTo === r.id && member()) body.push(replyForm(thread.id, r));
      }
    }
    let kids = null;
    if (!collapsed && children.length) {
      const ordered = children.slice().sort((a, b) => a.createdAt - b.createdAt), open = t.expanded.has(r.id) || ordered.length <= CHILD_PREVIEW + 1;
      const visible = open ? ordered : ordered.slice(0, CHILD_PREVIEW);
      kids = el('div', { className: 'ff-children' }, [
        button('', () => { t.collapsed.add(r.id); render(); }, 'ff-thread-line', { 'aria-label': 'Collapse replies' + (r.authorName ? ' to ' + r.authorName : '') }),
        el('div', { className: 'ff-children-list' }, visible.map(c => comment(c, tree, thread)).concat(open ? [] : [button('View ' + plural(ordered.length - CHILD_PREVIEW, 'more reply'), () => { t.expanded.add(r.id); render(); }, 'ff-view-more')])),
      ]);
    }
    return el('div', { className: 'ff-c fc-reply' + (collapsed ? ' ff-c-collapsed' : '') + (mine ? ' ff-c-mine' : ''), 'data-depth': String(r.depth || 1), id: 'ff-c-' + r.id }, [
      el('div', { className: 'ff-c-row' }, [avatar(removed ? '' : r.authorName), el('div', { className: 'ff-c-body' }, body)]), kids]);
  }
  function replyForm(threadId, parent) {
    const key = 'reply-' + (parent ? parent.id : threadId);
    const box = el('textarea', { id: parent ? 'ff-reply-' + parent.id : 'ff-comment-box', 'data-draft': key, className: 'ff-grow', rows: '1', maxlength: '4000', required: true, placeholder: parent ? 'Reply to ' + parent.authorName + '…' : 'Add a comment…', 'aria-label': parent ? 'Reply to ' + parent.authorName : 'Add a comment', on: { input: e => grow(e.target), focus: e => e.target.closest('form').classList.add('ff-active') } });
    box.value = state.drafts.get(key) || '';
    let replyId = null; box.addEventListener('input', () => { replyId = null; });
    box.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); box.form.requestSubmit(); } });
    return el('form', { className: 'ff-reply' + (parent ? ' ff-reply-nested' : '') + (box.value ? ' ff-active' : ''), on: { submit: e => {
      e.preventDefault(); const text = box.value.trim(); if (!text || state.busy) return; replyId = replyId || uuid(); state.busy = true; status('Posting…');
      request('/threads/' + encodeURIComponent(threadId) + '/replies', 'POST', { id: replyId, text, ...(parent && { parentId: parent.id }) }, true).then(reply => {
        state.drafts.delete(key); state.replyTo = null; status('');
        const t = state.thread;
        if (t && t.data) {
          t.data.replies = t.data.replies.filter(x => x.id !== reply.id).concat([{ ...reply, score: 0, myVote: 0 }]);
          if (parent) { t.collapsed.delete(parent.id); t.expanded.add(parent.id); if (reply.parentId && reply.parentId !== parent.id) t.expanded.add(reply.parentId); }
          else t.shown += 1;
        }
        render(); const n = $('ff-c-' + reply.id); if (n) { n.classList.add('ff-flash'); n.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      }).catch(e2 => status(e2.message + ' Your reply is still here.', true)).finally(() => { state.busy = false; });
    } } }, [
      parent ? null : avatar(state.me && state.me.name, true), box,
      el('div', { className: 'ff-reply-actions' }, [button('Cancel', () => { state.replyTo = null; state.drafts.delete(key); render(); }, 'ff-btn ff-ghost'), el('button', { type: 'submit', className: 'ff-btn ff-primary', text: parent ? 'Reply' : 'Comment' })]),
    ]);
  }
  function grow(n) { n.style.height = 'auto'; n.style.height = Math.min(n.scrollHeight + 2, 260) + 'px'; }

  // ---------- likes ----------
  function like(threadId, post) {
    if (!member()) { needMember('Join the conversation to like posts.'); return; }
    const before = { score: post.score || 0, myVote: post.myVote || 0 }, value = before.myVote ? 0 : 1;
    post.myVote = value; post.score = Math.max(0, before.score + (value ? 1 : -1)); render();
    request('/votes', 'POST', { threadId, postId: post.id, value }, true).then(r => { post.score = r.score; post.myVote = r.myVote; render(); })
      .catch(e => { post.score = before.score; post.myVote = before.myVote; render(); status(e.message, true); });
  }

  // ---------- ⋯ menu: report, block, delete ----------
  function moreMenu(post, threadId) {
    const open = state.menuFor === post.id;
    const more = button([icon('more')], () => { state.menuFor = open ? null : post.id; state.reportFor = null; state.deleteFor = null; render(); }, 'ff-more', { 'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-label': 'More actions' });
    if (!open) return el('span', { className: 'ff-menu-wrap' }, [more]);
    const mine = state.identity && post.authorId === state.identity.id, items = [];
    if (mine) items.push(button('Delete', () => { state.menuFor = null; state.deleteFor = post.id; render(); }, 'ff-menu-item ff-danger'));
    else {
      items.push(button('Report', () => { if (!member()) { needMember('Join the conversation to report posts.'); return; } state.menuFor = null; state.reportFor = post.id; render(); const n = $('ff-report-reason'); if (n) n.focus(); }, 'ff-menu-item'));
      if (post.authorId && member()) items.push(button('Block ' + (post.authorName || 'this fan'), () => { state.menuFor = null; block(post.authorId); }, 'ff-menu-item'));
    }
    return el('span', { className: 'ff-menu-wrap' }, [more, el('div', { className: 'ff-menu', role: 'menu' }, items.map(i => { i.setAttribute('role', 'menuitem'); return i; }))]);
  }
  function inlineTools(post, threadId) {
    if (state.reportFor === post.id) {
      const reason = el('input', { id: 'ff-report-reason', maxlength: '300', required: true, placeholder: 'What’s wrong with this post?', 'aria-label': 'Reason for reporting' });
      return el('form', { className: 'ff-inline-form', on: { submit: e => { e.preventDefault(); request('/reports', 'POST', { id: uuid(), threadId, postId: post.id, reason: reason.value.trim().slice(0, 300) }, true).then(() => { state.reportFor = null; render(); status('Thanks — the moderators will take a look.'); }).catch(e2 => status(e2.message, true)); } } },
        [reason, el('button', { type: 'submit', className: 'ff-btn ff-primary', text: 'Send report' }), button('Cancel', () => { state.reportFor = null; render(); }, 'ff-btn ff-ghost')]);
    }
    if (state.deleteFor === post.id) {
      return el('div', { className: 'ff-inline-form' }, [el('span', { text: post.id === threadId ? 'Delete this discussion for everyone?' : 'Delete your comment?' }),
        button('Delete', () => {
          request('/posts/delete', 'POST', { threadId, postId: post.id, expectedVersion: post.version }, true).then(() => {
            state.deleteFor = null; status('Deleted.');
            if (post.id === threadId) { state.thread = null; refreshList(true); } else loadThread();
          }).catch(e => status(e.message, true));
        }, 'ff-btn ff-danger-btn'), button('Keep it', () => { state.deleteFor = null; render(); }, 'ff-btn ff-ghost')]);
    }
    return null;
  }
  function block(memberId) {
    request('/blocks', 'POST', { memberId, blocked: true }, true).then(me => { state.me = me; status('You won’t see that fan’s posts any more.'); return state.thread ? loadThread() : refreshList(true); }).catch(e => status(e.message, true));
  }

  // ---------- private feedback (dialog) ----------
  function buildFeedbackPanel() {
    const backdrop = el('div', { id: 'fc-backdrop', className: 'fc-backdrop', hidden: true, on: { click: e => { if (e.target === backdrop) closeFeedback(); } } });
    const panel = el('section', { id: 'fc-panel', className: 'fc-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fc-title', tabindex: '-1', hidden: true }, [
      el('div', { className: 'fc-panel-head' }, [el('div', {}, [el('p', { className: 'fc-eyebrow', text: 'Private · Same End team only' }), el('h2', { id: 'fc-title', text: 'Send feedback' })]), button('Close', closeFeedback, 'fc-close', { 'aria-label': 'Close feedback' })]),
      el('p', { id: 'fc-status', className: 'fc-status', role: 'status', 'aria-live': 'polite' }), el('div', { id: 'fc-body', className: 'fc-body' }),
    ]);
    document.body.append(backdrop, panel);
    document.addEventListener('keydown', e => { if (!state.feedbackOpen) return; if (e.key === 'Escape') { e.preventDefault(); closeFeedback(); } if (e.key === 'Tab') trapFocus(e, panel); });
  }
  function fbStatus(text, bad) { const n = $('fc-status'); if (n) { n.textContent = text || ''; n.classList.toggle('fc-error', !!bad); } }
  function trapFocus(e, panel) {
    const list = panel.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]');
    if (!list.length) { e.preventDefault(); panel.focus(); return; }
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function openFeedback() {
    build(); state.focus = document.activeElement; state.feedbackOpen = true;
    $('fc-backdrop').hidden = false; $('fc-panel').hidden = false; document.body.classList.add('fc-open'); fbStatus(''); renderFeedback($('fc-body')); $('fc-panel').focus();
  }
  function closeFeedback() {
    if (!state.feedbackOpen) return; state.feedbackOpen = false;
    $('fc-backdrop').hidden = true; $('fc-panel').hidden = true; replace($('fc-body')); document.body.classList.remove('fc-open');
    if (state.focus && state.focus.isConnected) state.focus.focus();
  }
  function fcField(label, control) { return el('label', { className: 'fc-field' }, [el('span', { text: label }), control]); }
  function renderFeedback(body) {
    replace(body);
    const kind = el('select', { id: 'fc-kind', required: true }, [el('option', { value: 'suggestion', text: 'Suggestion' }), el('option', { value: 'problem', text: 'Something went wrong' }), el('option', { value: 'worked', text: 'Something worked well' })]);
    const title = el('input', { id: 'fc-feedback-title', maxlength: '120', required: true, placeholder: 'A short title' });
    const text = el('textarea', { id: 'fc-feedback-text', rows: '4', maxlength: '6000', required: true, placeholder: 'Tell us what happened or what you would change.' });
    const contact = el('input', { id: 'fc-contact', maxlength: '200', type: 'text', placeholder: 'Optional contact detail' });
    const saveDraft = () => {
      const old = state.draft || {}, next = { id: old.id, kind: kind.value, title: title.value, text: text.value, contact: contact.value };
      if (old.id && (old.kind !== next.kind || old.title !== next.title || old.text !== next.text || old.contact !== next.contact)) next.id = null;
      state.draft = next; try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(next)); } catch (_) { /* Draft is a convenience. */ }
    };
    try { const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); if (d) state.draft = d; } catch (_) { /* No draft. */ }
    if (state.draft) { kind.value = state.draft.kind || 'suggestion'; title.value = state.draft.title || ''; text.value = state.draft.text || ''; contact.value = state.draft.contact || ''; }
    [kind, title, text, contact].forEach(x => { x.addEventListener('input', saveDraft); x.addEventListener('change', saveDraft); });
    const form = el('form', { className: 'fc-form', on: { submit: e => { e.preventDefault(); sendFeedback(form); } } }, [
      el('p', { className: 'fc-audience', text: 'Private feedback · visible to the Same End support team only' }),
      fcField('What kind of feedback?', kind), fcField('Title', title), fcField('Your feedback', text), fcField('Contact (optional)', contact),
      el('p', { className: 'fc-privacy-note', text: 'No browser diagnostics are attached. Never include private room links, keys or chat in feedback.' }),
      el('div', { className: 'fc-form-actions' }, [el('button', { type: 'submit', className: 'fc-button', text: 'Send private feedback' })]),
    ]);
    const list = el('div', { className: 'fc-feedback-list' });
    body.append(form, list); loadFeedback(list);
  }
  function sendFeedback(form) {
    if (state.busy) return;
    const id = (state.draft && state.draft.id) || uuid();
    const payload = { id, kind: $('fc-kind').value, title: $('fc-feedback-title').value.trim(), text: $('fc-feedback-text').value.trim() }, contact = $('fc-contact').value.trim();
    if (contact) payload.contact = contact;
    state.draft = { id, kind: payload.kind, title: payload.title, text: payload.text, contact }; try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(state.draft)); } catch (_) { /* Convenience. */ }
    const controls = form.querySelectorAll('input,textarea,select,button'); controls.forEach(c => { c.disabled = true; });
    state.busy = true; fbStatus('Sending private feedback…');
    ensureIdentity(state.identity ? null : 'Fan').then(() => request('/feedback', 'POST', payload, true)).then(() => {
      state.draft = null; try { sessionStorage.removeItem(DRAFT_KEY); } catch (_) { /* Convenience. */ }
      if (state.feedbackOpen) { renderFeedback($('fc-body')); fbStatus('Received by the Same End support team. Your receipt is saved below.'); }
    }).catch(e => { if (state.feedbackOpen) fbStatus(e.message + ' Your draft is kept here; retrying will use the same receipt ID.', true); })
      .finally(() => { state.busy = false; if (form.isConnected) controls.forEach(c => { c.disabled = false; }); });
  }
  function loadFeedback(target) {
    replace(target, el('h3', { text: 'Your feedback' }), el('p', { className: 'fc-muted', text: 'Receipts and replies are private to your browser identity.' }));
    if (!state.identity) { target.append(el('p', { className: 'fc-muted', text: 'Your first receipt will appear here after you send feedback.' })); return Promise.resolve(); }
    return getMe().then(() => request('/feedback', 'GET', null, true)).then(data => {
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) { target.append(el('p', { className: 'fc-muted', text: 'No feedback sent from this browser yet.' })); return; }
      for (const item of items) target.append(el('article', { className: 'fc-record' }, [
        el('div', { className: 'fc-record-top' }, [el('strong', { text: item.title || 'Feedback' }), el('span', { className: 'fc-pill', text: item.status || 'received' })]),
        el('p', { text: item.text || '' }), item.response ? el('p', { className: 'fc-response', text: 'Reply: ' + item.response }) : null,
        el('small', { text: item.createdAt ? new Date(item.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '' }),
      ]));
    }).catch(() => { target.append(el('p', { className: 'fc-muted', text: 'Your private feedback list is unavailable right now.' })); });
  }

  // ---------- public API (waiting screen, header and tests) ----------
  function refresh() {
    const list = document.querySelector('.fc-feedback-list');
    return Promise.all([state.feedbackOpen && list ? loadFeedback(list) : null, state.ui.open ? (state.thread ? loadThread() : refreshList(true)) : null]);
  }
  window.SameEndCommunity = { open: openForum, forum: openForum, feedback: openFeedback, refresh };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true }); else setTimeout(build, 0);
})();
