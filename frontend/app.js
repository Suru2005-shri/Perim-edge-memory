const API = '/api';
const esc = s => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
const fmtTime = ts => new Date(ts * 1000).toLocaleTimeString();

let DEVICE_ID = localStorage.getItem('perim_device_name');
if (!DEVICE_ID) { DEVICE_ID = 'Unit-' + Math.random().toString(36).slice(2, 6).toUpperCase(); localStorage.setItem('perim_device_name', DEVICE_ID); }
document.getElementById('deviceName').value = DEVICE_ID;
document.getElementById('deviceName').addEventListener('change', e => {
  DEVICE_ID = e.target.value.trim() || DEVICE_ID;
  localStorage.setItem('perim_device_name', DEVICE_ID);
});

let view = 'memory';
let forcedOffline = false;
let status = {};
let searchResults = [];
let live = { on: false, timer: null, hist: [], last: null };

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error('request failed: ' + res.status);
  return res.status === 204 ? null : res.json();
}

function backendReachable() { return navigator.onLine && !forcedOffline; }

async function refreshStatus() {
  document.getElementById('linkBar').textContent =
    (navigator.onLine ? 'browser reports: online' : 'browser reports: OFFLINE') +
    (forcedOffline ? ' · link cut for demo' : '') +
    (navigator.connection ? ` · ${navigator.connection.effectiveType || '?'}` +
      (navigator.connection.rtt != null ? `, rtt ${navigator.connection.rtt}ms` : '') : '');
  const stamp = document.getElementById('linkStamp'), txt = document.getElementById('linkStampText');
  if (!backendReachable()) { stamp.classList.remove('online'); txt.textContent = 'OFFLINE'; return; }
  try {
    status = await api('/status');
    stamp.classList.add('online'); txt.textContent = 'ONLINE';
    document.getElementById('mLocal').textContent = status.device_count_total;
    document.getElementById('mSynced').textContent = status.synced;
    document.getElementById('mCloudMode').textContent = status.cloud_mode;
    document.getElementById('mLastSync').textContent = status.last_sync_at ? fmtTime(status.last_sync_at) : '—';
    document.getElementById('cQueue').textContent = status.pending;
    document.getElementById('cCloud').textContent = status.synced;
  } catch (e) {
    stamp.classList.remove('online'); txt.textContent = 'OFFLINE';
  }
}

document.getElementById('linkStamp').addEventListener('click', () => {
  forcedOffline = !forcedOffline;
  refreshStatus().then(render);
});
window.addEventListener('online', () => { refreshStatus().then(() => { trySync(); render(); }); });
window.addEventListener('offline', () => { refreshStatus().then(render); });
if (navigator.connection) navigator.connection.addEventListener('change', () => refreshStatus().then(render));

async function trySync() {
  if (!backendReachable()) return;
  try { const r = await api('/sync', { method: 'POST' }); if (r.synced) render(); } catch (e) {}
}
setInterval(() => { refreshStatus(); trySync(); }, 6000);

/* ---------------- views ---------------- */
async function render() {
  document.querySelectorAll('.folder').forEach(b => b.classList.toggle('active', b.dataset.v === view));
  const el = document.getElementById('view');
  try {
    if (view === 'memory') el.innerHTML = await vMemory();
    else if (view === 'search') el.innerHTML = vSearch();
    else if (view === 'live') el.innerHTML = vLive();
    else if (view === 'sync') el.innerHTML = await vSync();
    else if (view === 'cloud') el.innerHTML = await vCloud();
    else if (view === 'log') el.innerHTML = await vLog();
  } catch (e) {
    el.innerHTML = `<div class="empty">Can't reach the backend right now (${esc(e.message)}). This device keeps its last known state above.</div>`;
  }
  const items = view === 'memory' ? (await safeMemory()) : null;
  if (items) document.getElementById('cMemory').textContent = items.length;
  wire();
}
async function safeMemory() { try { return await api('/memory'); } catch (e) { return []; } }

function badge(kind) {
  return { local: '<span class="badge local">DEVICE ONLY</span>', synced: '<span class="badge synced">FILED</span>',
    queued: '<span class="badge queued">QUEUED</span>' }[kind];
}
function srcBadge(src) {
  if (src === 'live') return '<span class="badge live">LIVE</span> ';
  if (src === 'cloud') return '<span class="badge cloudsrc">FROM BASE</span> ';
  return '';
}
function cardMemory(m) {
  const tagBadge = m.tag === 'local' ? badge('local') : (m.sync_status === 'synced' ? badge('synced') : badge('queued'));
  return `<div class="card"><div class="top"><div class="txt">${esc(m.text)}</div><div class="badges">${srcBadge(m.source)}${tagBadge}</div></div>
    <div class="meta"><span>${fmtTime(m.updated_at)}</span>
    ${m.tag === 'sync' && m.sync_status === 'synced' ? `<button class="link-btn" data-edit="${m.id}">simulate remote edit</button>` : ''}
    <button class="link-btn" data-del="${m.id}">delete</button></div></div>`;
}

async function vMemory() {
  const items = await safeMemory();
  return `<h2>Field notes</h2><p class="lede">Every note this unit has taken. Saved and embedded on-device the instant you write it — filed to base only if it's sync-eligible and the link is up.</p>
  <div class="row"><textarea id="newText" placeholder="Log something this unit should remember…"></textarea></div>
  <div class="row" style="justify-content:space-between; align-items:center;">
    <span class="hint">Notes mentioning a password, PIN or key stay device-only automatically.</span>
    <button class="btn" id="addBtn">File note</button>
  </div>
  ${items.length ? items.map(cardMemory).join('') : '<div class="empty">Nothing logged yet — write the first note above.</div>'}`;
}

function vSearch() {
  return `<h2>Search this unit's memory</h2><p class="lede">Runs against the on-device store only — identical result whether the link is up or down.</p>
  <div class="row"><input type="text" id="q" placeholder="Search field notes…"></div>
  <div id="results">${searchResults.length ? searchResults.map(r => `<div class="card"><div class="top"><div class="txt">${esc(r.text)}</div><span class="score">${r.score.toFixed(2)}</span></div></div>`).join('') : ''}</div>`;
}

async function readSensors() {
  const c = navigator.connection || {};
  let batt = null, chg = null;
  try { if (navigator.getBattery) { const b = await navigator.getBattery(); batt = Math.round(b.level * 100); chg = b.charging; } } catch (e) {}
  return { ts: Date.now(), batt, chg, type: c.effectiveType || 'n/a', rtt: c.rtt ?? null, down: c.downlink ?? null, online: navigator.onLine };
}
function spark(vals, color, min, max) {
  const v = vals.filter(x => x != null); if (v.length < 2) return '<small>collecting readings…</small>';
  const w = 300, h = 46, lo = min ?? Math.min(...v), hi = max ?? Math.max(...v);
  const pts = v.map((x, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - ((x - lo) / ((hi - lo) || 1)) * h).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}
function vLive() {
  const r = live.last, h = live.hist;
  return `<h2>Live instrument feed ${live.on ? '<span class="pulse"></span>' : ''}</h2>
  <p class="lede">Real battery and network readings from this device, captured every 5 seconds and filed as ordinary notes — classified, queued and synced the same way.</p>
  <div class="row"><button class="btn" id="liveBtn">${live.on ? 'Stop feed' : 'Start feed'}</button><button class="btn ghost" id="locBtn">Log position (device-only)</button></div>
  ${r ? `<div class="kv"><div><small>BATTERY</small><b>${r.batt != null ? r.batt + '%' : 'n/a'}</b></div><div><small>NETWORK</small><b>${r.type}</b></div><div><small>ROUND-TRIP</small><b>${r.rtt != null ? r.rtt + 'ms' : 'n/a'}</b></div><div><small>DOWNLINK</small><b>${r.down != null ? r.down + 'Mbps' : 'n/a'}</b></div></div>
  <div class="spark"><small>BATTERY %</small>${spark(h.map(x => x.batt), '#B9861A', 0, 100)}</div>
  <div class="spark"><small>ROUND-TRIP TIME (ms)</small>${spark(h.map(x => x.rtt), '#3B6B41')}</div>` : '<div class="empty">Start the feed to stream real readings from this device.</div>'}
  <p class="hint">Some browsers don't expose battery or network detail — those read n/a and the feed still runs.</p>`;
}
async function tick() {
  const r = await readSensors(); live.last = r; live.hist.push(r); if (live.hist.length > 40) live.hist.shift();
  const text = `Instrument reading · battery ${r.batt != null ? r.batt + '%' + (r.chg ? ' (charging)' : '') : 'n/a'} · link ${r.type}${r.rtt != null ? ', rtt ' + r.rtt + 'ms' : ''} · ${r.online ? 'online' : 'offline'}`;
  try { await api('/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, device_id: DEVICE_ID, source: 'live' }) }); } catch (e) {}
  trySync(); render();
}
function toggleLive() {
  live.on = !live.on;
  if (live.on) { tick(); live.timer = setInterval(tick, 5000); } else clearInterval(live.timer);
  render();
}
function addLocation() {
  if (!navigator.geolocation) { render(); return; }
  navigator.geolocation.getCurrentPosition(async p => {
    const text = `Position ${p.coords.latitude.toFixed(4)}, ${p.coords.longitude.toFixed(4)} (±${Math.round(p.coords.accuracy)}m)`;
    try { await api('/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, device_id: DEVICE_ID, source: 'live', force_tag: 'local' }) }); } catch (e) {}
    render();
  }, () => render(), { timeout: 8000 });
}

async function vSync() {
  const items = await safeMemory();
  const pending = items.filter(m => m.tag === 'sync' && m.sync_status !== 'synced' && !m.conflict);
  const conflicts = items.filter(m => m.conflict);
  return `<h2>Dispatch to base</h2><p class="lede">Sync-eligible notes queue here while the link is down, and file automatically the moment it's back — checked every few seconds. Device-only notes never leave this screen.</p>
  ${!backendReachable() ? `<div class="empty">Link is down — ${pending.length} note(s) waiting. They'll dispatch on their own once it's back.</div>` : ''}
  ${backendReachable() && !pending.length && !conflicts.length ? '<div class="empty">Everything sync-eligible has been filed.</div>' : ''}
  ${conflicts.map(m => `<div class="conflict"><h3>Conflict — edited here and at base</h3><div class="versions"><div><b>This unit</b>${esc(m.text)}</div><div><b>Base copy</b>${esc(m.cloud_text || '')}</div></div>
    <div class="row" style="margin-bottom:0;"><button class="btn ghost" data-resolve="${m.id}" data-keep="device">Keep this unit</button><button class="btn ghost" data-resolve="${m.id}" data-keep="cloud">Keep base copy</button><button class="btn ghost" data-resolve="${m.id}" data-keep="newest">Keep most recent</button></div></div>`).join('')}
  ${pending.map(m => `<div class="card"><div class="top"><div class="txt">${esc(m.text)}</div>${badge('queued')}</div></div>`).join('')}`;
}

async function vCloud() {
  let docs = [];
  try { docs = await api('/cloud'); } catch (e) {}
  const devices = new Set(docs.map(d => d.device_id)).size;
  return `<h2>Base station</h2><p class="lede">${status.cloud_mode === 'remote' ? 'A real remote Qdrant Server — every unit that files a note shows up here.' : 'A local stand-in for the base station (point PERIM_CLOUD_URL at a real Qdrant Server to make this live across machines).'}</p>
  <div class="kv"><div><small>NOTES ON FILE</small><b>${docs.length}</b></div><div><small>UNITS REPORTING</small><b>${devices}</b></div><div><small>MODE</small><b style="font-size:13px">${status.cloud_mode || '—'}</b></div></div>
  ${docs.length ? docs.slice(0, 60).map(d => `<div class="card"><div class="top"><div class="txt">${esc(d.text)}</div><span class="badge ${d.device_id === DEVICE_ID ? 'synced' : 'live'}">${esc(d.device_id === DEVICE_ID ? 'THIS UNIT' : d.device_id)}</span></div></div>`).join('') : '<div class="empty">Nothing filed yet.</div>'}`;
}

async function vLog() {
  let rows = [];
  try { rows = await api('/activity'); } catch (e) {}
  return `<h2>Log book</h2><p class="lede">Every local and dispatch event on this unit, most recent first.</p>
  ${rows.length ? rows.map(r => `<div class="log-line"><time>${fmtTime(r.ts)}</time><span class="k ${r.kind}">${r.kind}</span><span>${esc(r.text)}</span></div>`).join('') : '<div class="empty">No activity yet.</div>'}`;
}

/* ---------------- wiring ---------------- */
function wire() {
  const $ = id => document.getElementById(id);
  if ($('addBtn')) $('addBtn').addEventListener('click', async () => {
    const t = $('newText').value.trim(); if (!t) return;
    try { await api('/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t, device_id: DEVICE_ID }) }); trySync(); render(); } catch (e) { render(); }
  });
  if ($('liveBtn')) $('liveBtn').addEventListener('click', toggleLive);
  if ($('locBtn')) $('locBtn').addEventListener('click', addLocation);
  document.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async e => {
    try { await api('/memory/' + e.target.dataset.del, { method: 'DELETE' }); } catch (err) {} render();
  }));
  document.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async e => {
    view = 'sync';
    try { await api('/memory/' + e.target.dataset.edit + '/simulate-remote-edit', { method: 'POST' }); } catch (err) {}
    render();
  }));
  document.querySelectorAll('[data-resolve]').forEach(b => b.addEventListener('click', async e => {
    try { await api('/memory/' + e.target.dataset.resolve + '/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: e.target.dataset.keep }) }); } catch (err) {}
    render();
  }));
  const q = $('q');
  if (q && !q._wired) {
    q._wired = true;
    q.addEventListener('input', async () => {
      const query = q.value.trim();
      if (!query) { searchResults = []; $('results').innerHTML = ''; return; }
      try { searchResults = await api('/search?q=' + encodeURIComponent(query)); } catch (e) { searchResults = []; }
      $('results').innerHTML = searchResults.length ? searchResults.map(r => `<div class="card"><div class="top"><div class="txt">${esc(r.text)}</div><span class="score">${r.score.toFixed(2)}</span></div></div>`).join('') : `<div class="empty">No local matches for "${esc(query)}".</div>`;
    });
  }
}
document.querySelectorAll('.folder').forEach(b => b.addEventListener('click', () => { view = b.dataset.v; render(); }));

refreshStatus().then(render);
