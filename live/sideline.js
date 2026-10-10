// The sideline page. Every tap shows at once and goes into an outbox saved on the phone; the outbox is sent in order
// and retried until the Worker confirms it, so nothing is lost when the signal drops. Each change carries an id made
// on the phone, so a retry is never counted twice. Plain JavaScript, no build step.
'use strict';

const $ = (id) => document.getElementById(id);
// Practice mode (the demo campaign's page on the site embeds this page with a #practice tracker): everything works the
// same, but a pretend server on this device stands in for the Worker, and nothing leaves the phone
const PRACTICE = (() => { try { return JSON.parse(document.getElementById('practice')?.textContent || 'null'); } catch { return null; } })();
const NS = PRACTICE ? 'fonur-live-practice' : 'fonur-live';
const KEY = { outbox: `${NS}:outbox`, recent: `${NS}:recent`, cur: `${NS}:tracker` };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: still works for this visit */ } };
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '');
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const surname = (label) => label.trim().split(/\s+/).slice(-1)[0];

/** Builds an element: h('button', { class: 'x', onclick }, 'text', child) — text is always set as text, never HTML */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const api = PRACTICE ? practiceServer(PRACTICE) : (url, init) => fetch(url, init);

/** The pretend server for practice mode: the Worker's rules in miniature, kept in this browser's storage */
function practiceServer(t) {
  const key = `${NS}:server:${t.id}`;
  const fresh = () => ({ counts: {}, added: [], status: null, version: 0, updated: null, changes: [] });
  const db = () => load(key, fresh());
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('fonur-live-practice') : null;
  // Latest additions for the demo page's feed: as live-core.ts latestAdditions (a −1 takes back that player's last tap)
  const recent = (d) => {
    const kept = [], open = {};
    for (const c of d.changes) {
      if (c.kind !== 'add' || c.undone) continue;
      if (c.delta > 0) { (open[c.entry] ||= []).push(kept.length); kept.push({ entry: c.entry, delta: c.delta, at: c.at }); }
      else for (let k = 0; k < -c.delta; k++) { const i = (open[c.entry] || []).pop(); if (i !== undefined) kept[i] = null; }
    }
    return kept.filter(Boolean).slice(-5).reverse();
  };
  const out = (d) => ({ counts: d.counts, added: d.added, status: d.status, version: d.version, updated: d.updated, recent: recent(d) });
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const slug = (v) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const handle = (url, init) => {
    const u = new URL(url, location.href);
    if (u.pathname === '/v1/reset') { save(key, fresh()); channel?.postMessage({ id: t.id, state: out(fresh()) }); return reply({ ok: true }); }
    const d = db();
    if (u.pathname === '/v1/me') return reply({ email: 'practice mode', now: new Date().toISOString(), trackers: [t] });
    if (u.pathname === '/v1/state') return reply({ trackers: { [t.id]: out(d) } });
    if (u.pathname === '/v1/changes') return reply({ changes: d.changes.slice(-15).reverse() });
    const op = JSON.parse(init.body);
    if (d.changes.some((c) => c.op_id === op.opId)) return reply({ ok: true, duplicate: true, state: out(d) });
    const at = new Date().toISOString();
    const log = (o) => d.changes.push({ op_id: op.opId, kind: op.kind, by: 'practice', at, undone: 0, ...o });
    if (op.kind === 'add') { const prev = d.counts[op.entry] || 0; d.counts[op.entry] = Math.max(0, prev + op.delta); log({ entry: op.entry, delta: op.delta, prev }); }
    else if (op.kind === 'set') { log({ entry: op.entry, value: String(op.value), prev: d.counts[op.entry] || 0 }); d.counts[op.entry] = op.value; }
    else if (op.kind === 'status') { log({ value: op.value, prev: d.status }); d.status = op.value; }
    else if (op.kind === 'entry') { const k = `x-${slug(op.label)}`; d.added.push({ key: k, label: op.label, ...(op.number !== undefined ? { number: op.number } : {}) }); d.counts[k] = 0; log({ entry: k, value: op.label }); }
    else if (op.kind === 'undo') {
      const c = d.changes.find((x) => x.op_id === op.target);
      if (!c) return reply({ error: 'nothing to undo' }, 404);
      if (!c.undone) {
        c.undone = 1;
        if (c.kind === 'add') { const applied = Math.max(0, c.prev + c.delta) - c.prev; d.counts[c.entry] = Math.max(0, (d.counts[c.entry] || 0) - applied); }
        else if (c.kind === 'set') d.counts[c.entry] = c.prev;
        else if (c.kind === 'status') d.status = c.prev;
        else if (c.kind === 'entry') { d.added = d.added.filter((a) => a.key !== c.entry); delete d.counts[c.entry]; }
        log({ value: op.target });
      }
    }
    d.version += 1;
    d.updated = at;
    save(key, d);
    channel?.postMessage({ id: t.id, state: out(d) });
    return reply({ ok: true, state: out(d) });
  };
  // A short pause, like a real round trip
  return (url, init = {}) => new Promise((resolve) => setTimeout(() => resolve(handle(url, init)), 120));
}

const S = {
  email: '', trackers: [], cur: load(KEY.cur, ''),
  server: {},        // tracker id → state from the Worker { counts, added, status, version, updated }
  outbox: load(KEY.outbox, []),   // changes not yet confirmed, oldest first
  recent: load(KEY.recent, []),   // this phone's last changes, newest first, for Undo
  sending: false, retryIn: 1000, offline: false, signedOut: false,
};
const tracker = () => S.trackers.find((t) => t.id === S.cur);
const isOpen = (t, now = Date.now()) => now >= Date.parse(t.opens) && now < Date.parse(t.closes);

// ---------- What to show: the Worker's numbers with this phone's unsent changes applied on top

function view(t) {
  const s = S.server[t.id] || { counts: {}, added: [], status: null, version: 0 };
  const counts = { ...s.counts };
  const added = [...s.added];
  let status = s.status;
  for (const op of S.outbox) {
    if (op.tracker !== t.id) continue;
    const e = op.effect || {};
    if (e.delta !== undefined) counts[e.entry] = Math.max(0, (counts[e.entry] || 0) + e.delta);
    if (e.set !== undefined) counts[e.entry] = e.set;
    if (e.status !== undefined) status = e.status;
    if (e.add && !added.some((a) => a.key === e.add.key)) added.push(e.add);
    if (e.remove) { const i = added.findIndex((a) => a.key === e.remove); if (i >= 0) added.splice(i, 1); delete counts[e.remove]; }
  }
  const entries = [...t.entries, ...added].sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.label.localeCompare(b.label));
  return { counts, entries, status };
}

// ---------- Making a change

function send(t, op, effect, describe) {
  const full = { ...op, opId: newId(), tracker: t.id, effect };
  S.outbox.push(full);
  save(KEY.outbox, S.outbox);
  if (describe) {
    S.recent.unshift({ opId: full.opId, tracker: t.id, text: describe, at: new Date().toISOString(), effect, kind: op.kind });
    S.recent = S.recent.slice(0, 8);
    save(KEY.recent, S.recent);
  }
  wake();
  render();
  flush();
}

function undo(item) {
  const t = S.trackers.find((x) => x.id === item.tracker);
  if (!t) return;
  item.undone = true;
  save(KEY.recent, S.recent);
  // Not sent yet: just drop it
  const i = S.outbox.findIndex((o) => o.opId === item.opId);
  if (i >= 0) { S.outbox.splice(i, 1); save(KEY.outbox, S.outbox); render(); return; }
  const e = item.effect || {};
  const inverse = e.delta !== undefined ? { entry: e.entry, delta: -e.delta } : e.add ? { remove: e.add.key } : {};
  send(t, { kind: 'undo', target: item.opId }, inverse, null);
}

async function flush() {
  if (S.sending || !S.outbox.length || S.signedOut) return syncPill();
  S.sending = true;
  syncPill();
  const op = S.outbox[0];
  const { effect, ...body } = op;
  try {
    const res = await api('/v1/op', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fonur-Live': '1' }, body: JSON.stringify(body), credentials: 'same-origin' });
    if (res.status === 401 || res.redirected || res.type === 'opaqueredirect') { S.signedOut = true; note(); return; }
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      S.outbox.shift();
      if (data.state) take(op.tracker, data.state);
      S.offline = false; S.retryIn = 1000;
    } else if (res.status >= 500) {
      throw new Error(data.error || `error ${res.status}`);
    } else {
      // Refused (closed, unknown player, …): drop it, say why, and get the true numbers
      S.outbox.shift();
      const r = S.recent.find((x) => x.opId === op.opId);
      if (r) { r.undone = true; save(KEY.recent, S.recent); }
      toast(`Not saved: ${data.error || `error ${res.status}`}`);
      poll(true);
    }
    save(KEY.outbox, S.outbox);
    S.sending = false;
    render();
    if (S.outbox.length) flush();
  } catch {
    // No signal or the Worker is busy: keep it and try again, waiting a little longer each time (up to 10 seconds)
    S.offline = true;
    S.sending = false;
    syncPill();
    setTimeout(flush, S.retryIn);
    S.retryIn = Math.min(S.retryIn * 2, 10_000);
  }
}

/** Accepts the Worker's numbers unless they're older than what we already have */
function take(id, state) {
  const have = S.server[id];
  if (have && state.version < have.version) return;
  S.server[id] = state;
}

async function poll(force) {
  const t = tracker();
  if (!t || (document.hidden && !force)) return;
  try {
    const res = await api(`/v1/state?t=${encodeURIComponent(t.id)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (res.ok) { const data = await res.json(); take(t.id, data.trackers[t.id]); S.offline = false; render(); }
  } catch { S.offline = true; syncPill(); }
}

async function boot() {
  try {
    const res = await api('/v1/me', { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 401 || res.redirected) { S.signedOut = true; note(); return; }
    const data = await res.json();
    S.email = data.email;
    S.trackers = data.trackers;
    S.signedOut = false;
    // Open on the tracker that's open now (or was picked last)
    const open = S.trackers.filter((t) => isOpen(t));
    if (!S.trackers.some((t) => t.id === S.cur)) S.cur = (open[0] || S.trackers[0] || {}).id || '';
    save(KEY.cur, S.cur);
    render();
    poll(true);
    flush();
  } catch {
    S.offline = true;
    note();
    setTimeout(boot, 5000);
  }
}

// ---------- Drawing the page

function syncPill() {
  const pill = $('sync');
  const n = S.outbox.length;
  pill.className = `pill${S.signedOut ? ' off' : n ? ' wait' : ''}`;
  pill.textContent = S.signedOut ? 'Signed out' : n ? `${n} waiting${S.offline ? ' · no signal' : ''}` : S.offline ? 'No signal' : 'Saved';
}

function note() {
  const box = $('notes');
  box.replaceChildren();
  if (PRACTICE) box.append(h('p', { class: 'note practice' }, 'Practice mode: this is the real sideline screen, but taps stay on this device and only change the demo page.'));
  if (S.signedOut) box.append(h('p', { class: 'note err' }, 'You\'ve been signed out. ', h('a', { href: '/admin' }, 'Sign in again'), ' — your unsent taps are kept and will be sent.'));
  const t = tracker();
  if (t && !isOpen(t)) {
    const now = Date.now();
    box.append(h('p', { class: 'note' }, now < Date.parse(t.opens) ? `Opens at ${clock(t.opens)}. You can look, but taps won't count until then.` : `Closed at ${clock(t.closes)}. You can still undo or correct a count for an hour.`));
  }
  syncPill();
}

function render() {
  const t = tracker();
  note();
  const tabs = $('tabs');
  tabs.hidden = S.trackers.length < 2;
  tabs.replaceChildren(...S.trackers.map((x) => h('button', { type: 'button', 'aria-pressed': x.id === S.cur, onclick: () => { S.cur = x.id; save(KEY.cur, S.cur); render(); poll(true); } }, x.title)));
  const main = $('view');
  if (!t) {
    $('title').textContent = 'FONUR live';
    $('sum').textContent = S.email ? `Signed in as ${S.email}` : '';
    main.replaceChildren(h('p', { class: 'empty' }, S.signedOut ? '' : 'Nothing is open in the next 24 hours. Trackers come from the campaign and fixture files on the site.'));
    renderRecent();
    return;
  }
  $('title').textContent = t.title;
  const v = view(t);
  if (t.kind === 'match') {
    $('sum').textContent = `${v.status || 'Not started'} · ${v.counts.us || 0}–${v.counts.them || 0}`;
    main.replaceChildren(matchView(t, v));
  } else {
    const total = Object.values(v.counts).reduce((a, n) => a + n, 0);
    $('sum').replaceChildren(h('b', {}, total), ` ${t.unit || 'in all'}`);
    main.replaceChildren(boardView(t, v));
  }
  renderRecent();
}

function flash(el) { el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); try { navigator.vibrate && navigator.vibrate(12); } catch { /* not supported */ } }

function boardView(t, v) {
  const grid = h('div', { class: 'grid' });
  for (const e of v.entries) {
    const n = v.counts[e.key] || 0;
    const tag = e.number !== undefined ? `#${e.number} ${surname(e.label)}` : e.label;
    const plus = h('button', { type: 'button', class: 'plus', 'aria-label': `Add one for ${e.label}, now ${n}` },
      h('span', { class: 'num' }, e.number ?? '–'), h('span', { class: 'count' }, n), h('span', { class: 'name' }, e.number !== undefined ? surname(e.label) : e.label));
    plus.addEventListener('click', () => { flash(plus); send(t, { kind: 'add', entry: e.key, delta: 1 }, { entry: e.key, delta: 1 }, `+1 ${tag}`); announce(`${e.label} ${n + 1}`); });
    const minus = h('button', { type: 'button', class: 'minus', 'aria-label': `Take one away from ${e.label}`, disabled: n === 0 }, '−');
    minus.addEventListener('click', (ev) => { ev.stopPropagation(); send(t, { kind: 'add', entry: e.key, delta: -1 }, { entry: e.key, delta: -1 }, `−1 ${tag}`); announce(`${e.label} ${Math.max(0, n - 1)}`); });
    grid.append(h('div', { class: 'tile' }, plus, minus));
  }
  if (t.allowAdd) grid.append(h('button', { type: 'button', class: 'add', onclick: () => addPlayer(t, v) }, '+ Add player'));
  return grid;
}

function matchView(t, v) {
  const wrap = h('div');
  wrap.append(h('div', { class: 'status', role: 'group', 'aria-label': 'Match status' },
    t.statuses.map((st) => h('button', { type: 'button', 'aria-pressed': (v.status || 'Not started') === st, onclick: () => { if ((v.status || 'Not started') !== st) send(t, { kind: 'status', value: st }, { status: st }, st); } }, st))));
  const sides = h('div', { class: 'sides' });
  for (const e of t.entries) {
    const n = v.counts[e.key] || 0;
    const score = h('div', { class: 'score', 'aria-label': `${e.label} ${n}` }, n);
    const col = h('div', { class: 'side' }, h('h2', {}, e.label), score);
    for (const a of t.actions) col.append(h('button', { type: 'button', class: 'pts', onclick: () => { flash(score); send(t, { kind: 'add', entry: e.key, delta: a.delta }, { entry: e.key, delta: a.delta }, `${e.label} ${a.label} +${a.delta}`); } }, `${a.label} +${a.delta}`));
    col.append(h('button', { type: 'button', class: 'pts minus1', disabled: n === 0, onclick: () => send(t, { kind: 'add', entry: e.key, delta: -1 }, { entry: e.key, delta: -1 }, `${e.label} −1`) }, '−1 (fix)'));
    sides.append(col);
  }
  wrap.append(sides);
  return wrap;
}

function renderRecent() {
  const box = $('recent');
  const mine = S.recent.filter((r) => r.tracker === S.cur).slice(0, 5);
  box.replaceChildren(...mine.map((r) => h('div', { class: `chip${r.undone ? ' undone' : ''}` }, r.text, h('span', { class: 't' }, clock(r.at)),
    r.undone || r.kind === 'set' ? null : h('button', { type: 'button', onclick: () => undo(r) }, 'Undo'))));
}

let liveTimer;
function announce(text) { clearTimeout(liveTimer); liveTimer = setTimeout(() => { $('live').textContent = text; }, 400); }

let toastTimer;
function toast(text) { const el = $('toast'); el.textContent = text; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 5000); }

// ---------- Dialogs: add a player, correct a count, everyone's recent changes

function dialog(...kids) { const d = $('dlg'); d.replaceChildren(...kids); d.showModal(); return d; }
const close = () => $('dlg').close();

function addPlayer(t, v) {
  const num = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 999, id: 'apNum' });
  const name = h('input', { type: 'text', id: 'apName', autocomplete: 'off', maxlength: 60 });
  const err = h('p', { class: 'note err', hidden: true });
  const go = () => {
    const label = name.value.trim(), number = num.value === '' ? undefined : Number(num.value);
    if (!label) { err.textContent = 'Type the player\'s name.'; err.hidden = false; return; }
    if (number !== undefined && v.entries.some((e) => e.number === number)) { err.textContent = `#${number} is already on the list.`; err.hidden = false; return; }
    const key = 'x-' + label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    send(t, { kind: 'entry', label, number }, { add: { key, label, number } }, `Added ${number !== undefined ? `#${number} ` : ''}${label}`);
    close();
  };
  dialog(h('h2', {}, 'Add a player'), h('label', { for: 'apNum' }, 'Number'), num, h('label', { for: 'apName' }, 'Name'), name, err,
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: close }, 'Cancel'), h('button', { type: 'button', class: 'go', onclick: go }, 'Add')));
  num.focus();
}

function correct(t) {
  const v = view(t);
  const pick = h('select', { id: 'cPick' }, v.entries.map((e) => h('option', { value: e.key }, `${e.number !== undefined ? `#${e.number} ` : ''}${e.label} (now ${v.counts[e.key] || 0})`)));
  const val = h('input', { type: 'number', inputmode: 'numeric', min: 0, id: 'cVal' });
  const go = () => {
    const value = Number(val.value);
    if (val.value === '' || !Number.isInteger(value) || value < 0) return;
    const e = v.entries.find((x) => x.key === pick.value);
    if (!confirm(`Set ${e.label} to ${value}?`)) return;
    send(t, { kind: 'set', entry: e.key, value }, { entry: e.key, set: value }, `${e.label} set to ${value}`);
    close();
  };
  dialog(h('h2', {}, 'Correct a count'), h('label', { for: 'cPick' }, t.kind === 'match' ? 'Team' : 'Player'), pick, h('label', { for: 'cVal' }, 'The right number'), val,
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: close }, 'Cancel'), h('button', { type: 'button', class: 'go', onclick: go }, 'Set')));
}

async function history(t) {
  const list = h('ul', { class: 'list' }, h('li', {}, 'Loading…'));
  dialog(h('h2', {}, 'Recent changes (everyone)'), list, h('div', { class: 'row' }, h('button', { type: 'button', onclick: close }, 'Close')));
  try {
    const res = await api(`/v1/changes?tracker=${encodeURIComponent(t.id)}`, { cache: 'no-store', credentials: 'same-origin' });
    const { changes } = await res.json();
    const name = (k) => [...t.entries, ...view(t).entries].find((e) => e.key === k)?.label ?? k ?? '';
    const what = (c) => c.kind === 'add' ? `${c.delta > 0 ? '+' : ''}${c.delta} ${name(c.entry)}` : c.kind === 'set' ? `${name(c.entry)} set to ${c.value}` : c.kind === 'status' ? c.value : c.kind === 'entry' ? `Added ${c.value}` : 'Undo';
    list.replaceChildren(...(changes.length ? changes.map((c) => h('li', { class: c.undone ? 'undone' : '' }, `${what(c)}${c.undone ? ' (undone)' : ''}`, h('div', { class: 'who' }, `${clock(c.at)} · ${c.by}`))) : [h('li', {}, 'No changes yet.')]));
  } catch { list.replaceChildren(h('li', {}, 'Couldn\'t load them. Check the signal.')); }
}

$('menuBtn').addEventListener('click', () => {
  const t = tracker();
  dialog(h('h2', {}, 'Menu'), h('div', { class: 'menu-list' },
    t ? h('button', { type: 'button', onclick: () => correct(t) }, 'Correct a count') : null,
    t ? h('button', { type: 'button', onclick: () => history(t) }, 'Recent changes (everyone)') : null,
    h('button', { type: 'button', onclick: () => { close(); boot(); } }, 'Refresh'),
    PRACTICE ? h('button', { type: 'button', onclick: async () => { if (!confirm('Clear all practice taps?')) return; close(); S.outbox = []; S.recent = []; S.server = {}; save(KEY.outbox, []); save(KEY.recent, []); await api('/v1/reset'); boot(); } }, 'Start the practice over') : null,
    h('p', { class: 'who' }, S.email ? `Signed in as ${S.email}` : '')),
  h('div', { class: 'row' }, h('button', { type: 'button', onclick: close }, 'Close')));
});

// ---------- Keep the screen on while counting, and keep everything fresh

let lock;
async function wake() { try { if (!lock && navigator.wakeLock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = undefined; }); } } catch { /* not supported */ } }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); poll(true); flush(); } });
window.addEventListener('online', () => { S.retryIn = 1000; flush(); });
setInterval(() => poll(false), 5000);
setInterval(() => { if (!document.hidden) boot(); }, 120_000);
setInterval(note, 30_000);
boot();
