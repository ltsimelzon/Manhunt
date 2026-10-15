'use strict';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const netEl = document.getElementById('net');
const KEY = 'manhunt-session';
const TRANSPORT_PRESETS = ['Lime bike', 'E-scooter', 'Bus', 'Train', 'Tram', 'Metro', 'Taxi'];

let session = readSession();   // { code, token }
let state = null;              // latest lobby state from the server
let version = -1;
let tab = 'status';
let lastFeed = null;
let busy = false;
const drafts = {};             // input values keyed by data-key, survive re-renders

// ---------- utilities ----------

function readSession() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
function writeSession(s) {
  session = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {}
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const val = k => String(drafts[k] ?? '').trim();
const clear = (...keys) => keys.forEach(k => delete drafts[k]);
const me = () => state.players.find(p => p.id === state.you);
const isHost = () => state.hostId === state.you;
const player = id => state.players.find(p => p.id === id);
const nameOf = (id, fallback) => player(id)?.name || fallback || 'Former player';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const rolePill = role => `<span class="pill ${role}">${role}</span>`;

function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = 'toast show ' + kind;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastEl.className = 'toast'; }, 3500);
}

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function accept(data) {
  state = data;
  version = data.version;
  const last = state.feed.length ? state.feed[state.feed.length - 1].id : 0;
  if (lastFeed !== null && last > lastFeed) {
    toast(state.feed[state.feed.length - 1].text);
    if (navigator.vibrate) navigator.vibrate(80);
  }
  lastFeed = last;
  render();
}

function resetSession(message) {
  writeSession(null);
  state = null; version = -1; lastFeed = null; tab = 'status';
  if (message) toast(message, 'bad');
  render();
}

async function poll() {
  if (!session) return;
  try {
    const q = new URLSearchParams({ code: session.code, token: session.token, v: version });
    const data = await api('/api/state?' + q);
    netEl.hidden = true;
    if (!data.unchanged) accept(data);
  } catch (e) {
    if (e.status === 404 || e.status === 403) resetSession(e.message);
    else netEl.hidden = false;
  }
}

async function act(type, payload = {}) {
  if (busy) return false;
  busy = true;
  try {
    accept(await api('/api/action', { code: session.code, token: session.token, type, ...payload }));
    return true;
  } catch (e) {
    toast(e.message, 'bad');
    return false;
  } finally {
    busy = false;
  }
}

async function enter(path, body) {
  try {
    const data = await api(path, body);
    writeSession({ code: data.code, token: data.token });
    clear('joinCode');
    accept(data.state);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

// ---------- rendering ----------

function render() {
  const focused = document.activeElement;
  const fk = focused?.dataset?.key;
  let sel = null;
  try { sel = fk ? [focused.selectionStart, focused.selectionEnd] : null; } catch {}

  app.innerHTML = !session ? home()
    : !state ? '<p class="muted center" style="padding-top:40vh">Connecting…</p>'
    : state.status === 'lobby' ? lobby() : game();

  app.querySelectorAll('[data-key]').forEach(el => {
    const k = el.dataset.key;
    if (k in drafts) el.type === 'checkbox' ? (el.checked = drafts[k]) : (el.value = drafts[k]);
  });
  if (fk) {
    const el = app.querySelector(`[data-key="${CSS.escape(fk)}"]`);
    if (el) { el.focus(); try { if (sel && sel[0] != null) el.setSelectionRange(...sel); } catch {} }
  }
}

function home() {
  return `
  <div class="hero"><h1>MANHUNT</h1><p>Runners grab the item. Hunters stop them.</p></div>
  <section class="card form">
    <label>Your name<input data-key="name" maxlength="20" placeholder="e.g. Alex" autocomplete="nickname"></label>
    <button data-act="create" class="big">Create a lobby</button>
    <div class="divider">— or join one —</div>
    <div class="form inline">
      <input data-key="joinCode" maxlength="5" placeholder="CODE" autocapitalize="characters"
        style="text-transform:uppercase;letter-spacing:.2em;font-weight:700">
      <button data-act="join" data-primary>Join</button>
    </div>
  </section>`;
}

function topbar() {
  const m = me();
  return `<header class="topbar">
    <span class="brand">MANHUNT</span>
    <span class="grow">#${esc(state.code)}</span>
    ${rolePill(m.role)}${isHost() ? '<span class="tag">host</span>' : ''}
    <button class="icon" data-act="leave" data-confirm="${isHost() ? 'Leave? You lose host control' : 'Leave?'}" title="Leave lobby">⏏</button>
  </header>`;
}

function lobby() {
  const s = state, host = isHost();
  const hunters = s.players.filter(p => p.role === 'hunter').length;
  return `${topbar()}
  <section class="card code-card">
    <div class="label">Lobby code</div>
    <div class="code">${esc(s.code)}</div>
    <button class="ghost small" data-act="copy-link">Copy invite link</button>
  </section>

  <section class="card">
    <h2>Players <span class="count">${s.players.length}</span></h2>
    <ul class="list">${s.players.map(p => `
      <li class="row">
        <div class="grow"><strong>${esc(p.name)}</strong>${p.id === s.hostId ? ' <span class="tag">host</span>' : ''}${p.id === s.you ? ' <span class="tag">you</span>' : ''}</div>
        ${host ? `
          <div class="seg">
            <button class="${p.role === 'runner' ? 'on runner' : ''}" data-act="role" data-id="${p.id}" data-role="runner">Runner</button>
            <button class="${p.role === 'hunter' ? 'on hunter' : ''}" data-act="role" data-id="${p.id}" data-role="hunter">Hunter</button>
          </div>
          ${p.id !== s.hostId ? `<button class="icon" data-act="kick" data-id="${p.id}" data-confirm="Kick?" title="Remove player">✕</button>` : ''}`
        : rolePill(p.role)}
      </li>`).join('')}
    </ul>
    ${host ? `
    <div class="form inline">
      <label>Number of hunters<input type="number" min="1" data-key="numHunters" value="${Math.max(1, hunters)}"></label>
      <button data-act="randomize" data-primary>🎲 Randomise</button>
    </div>
    <p class="sub">Tap Runner / Hunter to pick roles yourself, or randomise them.</p>` : ''}
  </section>

  <section class="card">
    <h2>Objective</h2>
    ${host ? settingsForm() : objective()}
  </section>

  <section class="card">
    <h2>Quests</h2>
    ${questList(false)}
    ${host ? questForm() : ''}
  </section>

  <section class="card">
    <h2>Transport costs</h2>
    ${transportList(false)}
    ${host ? transportForm() : ''}
  </section>

  ${host
    ? `<button class="big" data-act="start">Start game</button>`
    : `<p class="muted center">Waiting for the host to start…</p>`}`;
}

function objective() {
  const s = state;
  const holder = s.itemHolder && player(s.itemHolder);
  const status = s.delivered ? '<span class="good">Delivered 🏁</span>'
    : holder ? `Held by ${esc(holder.name)}` : 'Not yet retrieved';
  return `<dl class="obj">
    <dt>Item</dt><dd>${esc(s.item) || '<span class="muted">Not set</span>'}</dd>
    <dt>Deliver to</dt><dd>${esc(s.destination) || '<span class="muted">Not set</span>'}</dd>
    ${s.status !== 'lobby' ? `<dt>Status</dt><dd>${status}</dd>` : ''}
  </dl>`;
}

function settingsForm() {
  const s = state;
  return `<div class="form">
    <label>Item the runners must retrieve
      <input data-key="item" value="${esc(s.item)}" maxlength="120" placeholder="e.g. Red flag tied to the park bench"></label>
    <label>Where they must take it
      <input data-key="destination" value="${esc(s.destination)}" maxlength="120" placeholder="e.g. Town hall steps"></label>
    <label class="check"><input type="checkbox" data-key="requireApproval" ${s.requireApproval ? 'checked' : ''}>
      Host must approve quest completions</label>
    <button data-act="save-settings" data-primary>Save objective</button>
  </div>`;
}

function questList(interactive) {
  const s = state;
  if (!s.quests.length) return '<p class="muted">No quests yet.</p>';
  const canDo = interactive && s.status === 'playing' && me().role === 'runner' && !me().caught;
  return `<ul class="list">${s.quests.map(q => {
    const mine = s.completions.filter(c => c.questId === q.id && c.playerId === s.you);
    const st = mine.some(c => c.status === 'approved') ? 'approved'
      : mine.some(c => c.status === 'pending') ? 'pending' : mine.length ? 'rejected' : null;
    const doneBy = s.completions.filter(c => c.questId === q.id && c.status === 'approved').map(c => nameOf(c.playerId, c.name));
    return `<li class="quest">
      <div class="row">
        <div class="grow"><strong>${esc(q.title)}</strong>${q.description ? `<div class="sub">${esc(q.description)}</div>` : ''}</div>
        <span class="pts-inline">${q.points} pts</span>
        ${isHost() ? `<button class="icon" data-act="rm-quest" data-id="${q.id}" data-confirm="Delete?" title="Delete quest">✕</button>` : ''}
      </div>
      ${interactive && doneBy.length ? `<div class="sub">✔ Done by ${doneBy.map(esc).join(', ')}</div>` : ''}
      ${st === 'approved' ? '<div class="status good">✔ You completed this</div>'
        : st === 'pending' ? '<div class="status warn">⏳ Waiting for host approval</div>'
        : canDo ? `${st === 'rejected' ? '<div class="status bad">Rejected — you can try again</div>' : ''}
          <div class="form inline">
            <input data-key="note-${q.id}" maxlength="200" placeholder="Proof / note (optional)">
            <button data-act="claim" data-id="${q.id}" data-primary>Done!</button>
          </div>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

function questForm() {
  return `<div class="form">
    <div class="pair">
      <input data-key="qTitle" maxlength="80" placeholder="Quest, e.g. Selfie with a pigeon">
      <input data-key="qPoints" type="number" min="1" placeholder="Points">
    </div>
    <input data-key="qDesc" maxlength="300" placeholder="Details (optional)">
    <button data-act="add-quest" data-primary>+ Add quest</button>
  </div>`;
}

function transportList(interactive) {
  const s = state, m = me();
  if (!s.transports.length) return '<p class="muted">No transport options yet.</p>';
  const canBuy = interactive && s.status === 'playing' && m.role === 'runner' && !m.caught;
  return `<ul class="list">${s.transports.map(t => `
    <li class="row">
      <div class="grow"><strong>${esc(t.name)}</strong> <span class="sub">per use</span></div>
      <span class="pts-inline">${t.cost} pts</span>
      ${canBuy ? `<button class="small" data-act="buy" data-id="${t.id}" data-confirm="Spend ${t.cost}?" ${m.points < t.cost ? 'disabled' : ''}>Use</button>` : ''}
      ${isHost() ? `<button class="icon" data-act="rm-transport" data-id="${t.id}" data-confirm="Delete?" title="Delete option">✕</button>` : ''}
    </li>`).join('')}</ul>`;
}

function transportForm() {
  return `<div class="form">
    <div class="chips">${TRANSPORT_PRESETS.map(n => `<button data-act="preset" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>
    <div class="pair">
      <input data-key="tName" maxlength="40" placeholder="Transport, e.g. Bus">
      <input data-key="tCost" type="number" min="0" placeholder="Cost">
    </div>
    <button data-act="add-transport" data-primary>+ Add transport</button>
  </div>`;
}

function game() {
  const s = state, host = isHost();
  const pending = s.completions.filter(c => c.status === 'pending').length;
  const tabs = [
    ['status', 'Status'],
    ['quests', 'Quests' + (host && pending ? `<b class="badge">${pending}</b>` : '')],
    ['travel', 'Travel'],
    ['feed', 'Feed'],
  ];
  const banner = s.status === 'ended'
    ? `<div class="banner ${s.winner || ''}">${s.winner === 'runners' ? '🏃 Runners win!' : s.winner === 'hunters' ? '🎯 Hunters win!' : 'Game over'}</div>`
    : '';
  return `${topbar()}${banner}
    <nav class="tabs">${tabs.map(([k, label]) =>
      `<button class="${tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${label}</button>`).join('')}</nav>
    ${{ status: statusTab, quests: questsTab, travel: travelTab, feed: feedTab }[tab]()}`;
}

function statusTab() {
  const s = state, m = me(), host = isHost(), playing = s.status === 'playing';
  const runners = s.players.filter(p => p.role === 'runner');
  const hunters = s.players.filter(p => p.role === 'hunter');
  const canCatch = playing && (host || m.role === 'hunter');

  let itemButtons = '';
  if (playing && m.role === 'runner' && !m.caught) {
    if (!s.itemHolder && !s.delivered) {
      itemButtons = `<button class="big" data-act="item" data-do="got" data-confirm="Tap again to confirm pickup">📦 I've got the item</button>`;
    } else if (s.itemHolder === m.id) {
      itemButtons = `<div class="btns">
        <button class="big good" data-act="item" data-do="deliver" data-confirm="Tap again to confirm delivery">🏁 Delivered it!</button>
        <button class="ghost" data-act="item" data-do="drop" data-confirm="Drop it?">Dropped it</button>
      </div>`;
    }
  }

  return `
  ${m.role === 'runner' ? `<section class="card balance">
    <div class="label">Your points</div><div class="big-num">${m.points}</div>
    ${m.caught ? '<div class="bad"><strong>You have been caught</strong></div>' : ''}
  </section>` : ''}

  <section class="card">
    <h2>Objective</h2>
    ${objective()}
    ${itemButtons}
    ${host ? `<details><summary>Edit objective</summary>${settingsForm()}</details>` : ''}
  </section>

  <section class="card">
    <h2>Runners <span class="count">${runners.filter(p => !p.caught).length} free</span></h2>
    <ul class="list">${runners.map(p => {
      const done = s.completions.filter(c => c.playerId === p.id && c.status === 'approved').length;
      return `<li class="row ${p.caught ? 'caught' : ''}">
        <div class="grow">
          <strong>${esc(p.name)}</strong>${p.id === s.you ? ' <span class="tag">you</span>' : ''}${p.id === s.itemHolder ? ' <span class="tag item">📦 item</span>' : ''}
          <div class="sub">${plural(done, 'quest')} done · ${p.caught ? '<span class="bad">CAUGHT</span>' : 'free'}</div>
        </div>
        <div class="pts">${p.points}<small>pts</small></div>
        ${canCatch && !p.caught ? `<button class="danger small" data-act="catch" data-id="${p.id}" data-confirm="Sure?">Caught</button>` : ''}
        ${host && playing && p.caught ? `<button class="ghost small" data-act="release" data-id="${p.id}">Free</button>` : ''}
      </li>`;
    }).join('')}</ul>
  </section>

  <section class="card">
    <h2>Hunters</h2>
    <p style="margin:0">${hunters.map(p => esc(p.name)).join(', ') || '<span class="muted">None</span>'}</p>
  </section>

  ${host ? `<section class="card host">
    <h2>Host controls</h2>
    ${runners.length ? `<div class="form inline">
      <select data-key="adjWho">${runners.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <input type="number" data-key="adjAmt" placeholder="± points">
      <button data-act="adjust" data-primary>Adjust points</button>
    </div>` : ''}
    ${playing ? `<div class="btns">
      <button class="good" data-act="end" data-winner="runners" data-confirm="Confirm?">Runners win</button>
      <button class="danger" data-act="end" data-winner="hunters" data-confirm="Confirm?">Hunters win</button>
      <button class="ghost" data-act="end" data-winner="" data-confirm="Confirm?">End game</button>
    </div>` : `<button class="big" data-act="reset" data-confirm="Tap again: points & quests progress reset">Back to lobby for a new round</button>`}
  </section>` : ''}`;
}

function questsTab() {
  const s = state, host = isHost();
  const pending = s.completions.filter(c => c.status === 'pending');
  const approved = s.completions.filter(c => c.status === 'approved').slice().reverse();
  return `
  ${host && pending.length ? `<section class="card alert">
    <h2>Awaiting your approval</h2>
    <ul class="list">${pending.map(c => `
      <li class="row">
        <div class="grow"><strong>${esc(nameOf(c.playerId, c.name))}</strong> — ${esc(c.title)} <span class="pts-inline">+${c.points}</span>
          ${c.note ? `<div class="sub">“${esc(c.note)}”</div>` : ''}</div>
        <button class="good small" data-act="review" data-id="${c.id}" data-ok="1" title="Approve">✓</button>
        <button class="danger small" data-act="review" data-id="${c.id}" data-ok="0" title="Reject">✕</button>
      </li>`).join('')}</ul>
  </section>` : ''}

  <section class="card">
    <h2>Quests</h2>
    ${questList(true)}
    ${host ? questForm() : ''}
  </section>

  <section class="card">
    <h2>Completed quests</h2>
    ${approved.length ? `<ul class="list">${approved.map(c => `
      <li class="row">
        <div class="grow"><strong>${esc(nameOf(c.playerId, c.name))}</strong> — ${esc(c.title)}
          <div class="sub">${fmtTime(c.t)}${c.note ? ` · “${esc(c.note)}”` : ''}</div></div>
        <span class="pts-inline">+${c.points}</span>
      </li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}
  </section>`;
}

function travelTab() {
  const s = state, m = me();
  const used = s.purchases.slice().reverse();
  return `
  ${m.role === 'runner' ? `<section class="card balance"><div class="label">Your points</div><div class="big-num">${m.points}</div></section>` : ''}
  <section class="card">
    <h2>Transport prices</h2>
    ${transportList(true)}
    ${isHost() ? transportForm() : ''}
  </section>
  <section class="card">
    <h2>Transport used</h2>
    ${used.length ? `<ul class="list">${used.map(u => `
      <li class="row">
        <div class="grow"><strong>${esc(nameOf(u.playerId, u.name))}</strong> used ${esc(u.transport)}<div class="sub">${fmtTime(u.t)}</div></div>
        <span class="pts-inline">−${u.cost}</span>
      </li>`).join('')}</ul>` : '<p class="muted">Nobody has used transport yet.</p>'}
  </section>`;
}

function feedTab() {
  return `<section class="card"><h2>Live feed</h2>
    <ul class="list feed">${state.feed.slice().reverse().map(f =>
      `<li><time>${fmtTime(f.t)}</time><span>${esc(f.text)}</span></li>`).join('')}</ul>
  </section>`;
}

// ---------- events ----------

function remember(e) {
  const k = e.target.dataset?.key;
  if (k) drafts[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
}
app.addEventListener('input', remember);
app.addEventListener('change', remember);

app.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  const scope = e.target.closest('.form, .card');
  scope?.querySelector('[data-primary]')?.click();
});

app.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const d = b.dataset;

  // Two-tap confirmation for anything destructive or important.
  if (d.confirm !== undefined && d.armed !== '1') {
    d.armed = '1';
    const label = b.innerHTML;
    b.textContent = d.confirm || 'Tap again';
    b.classList.add('armed');
    setTimeout(() => {
      if (!b.isConnected) return;
      d.armed = '';
      b.innerHTML = label;
      b.classList.remove('armed');
    }, 3000);
    return;
  }

  const s = state;
  switch (d.act) {
    case 'create':
      if (!val('name')) return toast('Enter your name first', 'bad');
      return enter('/api/create', { name: val('name') });
    case 'join':
      if (!val('name')) return toast('Enter your name first', 'bad');
      if (!val('joinCode')) return toast('Enter a lobby code', 'bad');
      return enter('/api/join', { name: val('name'), code: val('joinCode').toUpperCase() });
    case 'leave':
      if (!isHost() && s.status === 'lobby') await act('leave');
      return resetSession();
    case 'copy-link': {
      const link = `${location.origin}/?code=${s.code}`;
      try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
      catch { toast(link); }
      return;
    }
    case 'tab': tab = d.tab; return render();
    case 'role': return act('set_role', { playerId: d.id, role: d.role });
    case 'kick': return act('kick', { playerId: d.id });
    case 'randomize': return act('randomize', { hunters: val('numHunters') || 1 });
    case 'save-settings': {
      const ok = await act('settings', {
        item: 'item' in drafts ? val('item') : s.item,
        destination: 'destination' in drafts ? val('destination') : s.destination,
        requireApproval: 'requireApproval' in drafts ? drafts.requireApproval : s.requireApproval,
      });
      if (ok) { clear('item', 'destination', 'requireApproval'); render(); toast('Objective saved'); }
      return;
    }
    case 'add-quest':
      if (await act('add_quest', { title: val('qTitle'), description: val('qDesc'), points: val('qPoints') })) {
        clear('qTitle', 'qDesc', 'qPoints'); render();
      }
      return;
    case 'rm-quest': return act('remove_quest', { questId: d.id });
    case 'preset': drafts.tName = d.name; render(); app.querySelector('[data-key="tCost"]')?.focus(); return;
    case 'add-transport':
      if (await act('add_transport', { name: val('tName'), cost: val('tCost') })) { clear('tName', 'tCost'); render(); }
      return;
    case 'rm-transport': return act('remove_transport', { transportId: d.id });
    case 'start': tab = 'status'; return act('start');
    case 'end': return act('end', { winner: d.winner || null });
    case 'reset': return act('reset');
    case 'claim':
      if (await act('claim_quest', { questId: d.id, note: val('note-' + d.id) })) { clear('note-' + d.id); render(); }
      return;
    case 'review': return act('review', { completionId: d.id, approve: d.ok === '1' });
    case 'buy': return act('buy', { transportId: d.id });
    case 'item': return act('item', { action: d.do });
    case 'catch': return act('catch', { playerId: d.id });
    case 'release': return act('release', { playerId: d.id });
    case 'adjust': {
      const who = val('adjWho') || s.players.find(p => p.role === 'runner')?.id;
      if (await act('adjust_points', { playerId: who, delta: val('adjAmt') })) { clear('adjAmt'); render(); }
      return;
    }
  }
});

// ---------- start ----------

const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) drafts.joinCode = urlCode.toUpperCase();
render();
poll();
setInterval(poll, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
