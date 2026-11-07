// The page: the HDT plugin hands it the Power.log files, every finished Battlegrounds game is
// reviewed in the background and its report shows up in the list. The plugin also keeps a
// backup of the logs and of every report (Documents\BG Advisor).

import { allGames, deleteGame, gameKeys, getGame, getKV, saveGame, setKV } from './store.js';
import { esc, heroIcon, heroName, placeCls, renderGame, scoreHtml } from './report.js';
import { card, getLang, initLang, loadNames, setLang, t } from './i18n.js';
import { initCardTip } from './cardtip.js';
import { anonymize, downloadReports, readExport, sanitizeReport, today } from './share.js';

const $ = sel => document.querySelector(sel);
// Test harness: ?log=...&report=/report also mirrors status and errors to POST /log.
// Only on a local test server, so a crafted link can never send reports anywhere.
const LOCAL = ['127.0.0.1', 'localhost'].includes(location.hostname);
const TEST = LOCAL && new URLSearchParams(location.search).has('report');
const tlog = msg => { if (TEST) fetch('/log', { method: 'POST', body: String(msg) }).catch(() => {}); };
if (TEST) {
  window.addEventListener('error', e => tlog(`error: ${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => tlog(`rejection: ${e.reason && (e.reason.stack || e.reason.message) || e.reason}`));
}
const POLL_MS = 3000;
const BACKFILL_GAMES = 3;

const state = {
  busy: false,
  progress: null,     // {hero, done, total, round}
  status: null,       // {key, vars}
  notice: '',         // a message shown in the status line until the next one
  error: null,        // {key, vars} or {text}
  precision: 'full',
  bridgeToken: '',    // the plugin's token (from #/bridge/<port>/<token>), kept in IndexedDB
};

const setError = (key, vars = {}) => { state.error = { key, vars }; };
const errorText = () => (!state.error ? '' : state.error.text || t(state.error.key, state.error.vars));

// ---------------------------------------------------------------- review worker

let worker = null;
let pending = Promise.resolve();

function review(files, { limit = 0, onlyComplete = true, context = false } = {}) {
  pending = pending.then(() => new Promise(async (resolve) => {
    if (!worker) worker = new Worker(new URL('./review-worker.js', import.meta.url), { type: 'module' });
    state.busy = true;
    state.notice = '';
    state.error = null;
    renderStatus();
    worker.onmessage = async (ev) => {
      const m = ev.data;
      if (m.type !== 'result') tlog(JSON.stringify(m));
      if (m.type === 'status') { state.status = { key: m.code }; renderStatus(); }
      else if (m.type === 'found') {
        state.status = { key: 'status.found', vars: { n: m.games.length } };
        renderStatus();
      } else if (m.type === 'progress') {
        state.progress = m;
        renderStatus();
      } else if (m.type === 'result') {
        await saveGame(m.result);
        backupReport(m.result);
        state.progress = null;
        onNewReport(m.result);
      } else if (m.type === 'done' || m.type === 'error') {
        if (m.type === 'error') state.error = { text: m.message };
        state.busy = false;
        state.progress = null;
        state.status = null;
        renderStatus();
        resolve();
      }
    };
    worker.onerror = (e) => {
      tlog(`worker error: ${e.message} @ ${e.filename}:${e.lineno}`);
      setError('err.worker', { msg: e.message || String(e) });
      state.busy = false;
      worker.terminate();
      worker = null;
      renderStatus();
      resolve();
    };
    // context: the first file is only there for a game reconnected across files; games that lie
    // wholly inside it were (or will be) reviewed with the file before it.
    const skipSource = context && files.length > 1 ? files[0].source : null;
    worker.postMessage({ type: 'review', files, known: await gameKeys(), precision: state.precision, limit, onlyComplete, skipSource });
  }));
  return pending;
}

function onNewReport(res) {
  if (document.hidden) document.title = t('title.new', { hero: heroName(res) });
  if (route().page === 'list') location.hash = `#/game/${encodeURIComponent(res.key)}`;
  else render();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && document.title.startsWith('●')) document.title = t('app.title');
});

// ---------------------------------------------------------------- HDT plugin bridge
//
// The BG Advisor plugin for Hearthstone Deck Tracker serves the recent Power.log files on
// 127.0.0.1 and opens this page at #/bridge/<port> when a game ends. The page then asks the
// plugin every few seconds whether another game has ended. Local requests are only made after
// the plugin opened the page, or when the user clicks "Connect to HDT plugin".
//
// Plugin 0.3.0 and later also keep a backup (Documents\BG Advisor): every Power.log with a
// Battlegrounds game, and every report this page sends. On connecting, reports missing on
// either side are copied over, so clearing the browser's data loses nothing.
//
// Plugin 0.4.0 and later answer only requests with their token (Authorization: Bearer ...),
// which they pass in the address they open: #/bridge/<port>/<token>. Without it /status only
// says the plugin is there and its version, and the page asks to be opened from HDT once.
// Older plugins get no token header: they do not allow it, and the browser would block the call.

const BRIDGE_PORTS = [47613, 47614, 47615, 47616, 47617];
const PLUGIN_URL = 'plugin/BgAdvisorBridge.dll';
const BACKUP_VERSION = '0.3.0';  // first plugin with the backup
const TOKEN_VERSION = '0.4.0';   // first plugin that wants the token
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** -1, 0 or 1, comparing dotted versions ("0.1.0" < "0.10.0"). */
function cmpVersion(a, b) {
  const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// plugin/version.json on this site: {"latest": newest plugin, "min": oldest one this page works with,
// "sha256": the published DLL's SHA-256} (written by plugin/build.ps1 -Publish; CI checks the hash).
let pluginRelease = null;
async function pluginReleaseInfo() {
  if (!pluginRelease) {
    try {
      pluginRelease = await (await fetch('plugin/version.json', { cache: 'no-store' })).json();
    } catch {
      return {};  // offline or missing: no update check this time
    }
  }
  return pluginRelease;
}

/** The browser this page runs in, so the plugin can open this one after a game. */
function browserId() {
  if (navigator.brave) return 'brave';
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Vivaldi/.test(ua)) return 'vivaldi';
  if (/OPR\//.test(ua)) return '';  // Opera: let the plugin use the default browser
  if (/Chrome\//.test(ua)) return 'chrome';
  return '';
}
const statusPath = () => `/status?browser=${browserId()}`;

class BridgeHttpError extends Error {
  constructor(status) { super(`HTTP ${status}`); this.status = status; }
}

/** Whether requests to the connected plugin carry the token. */
const sendToken = () => !!(state.bridgeToken && state.bridge && state.bridge.version
  && cmpVersion(state.bridge.version, TOKEN_VERSION) >= 0);

async function bridgeFetch(path, init = {}, auth = sendToken()) {
  const headers = { ...(init.headers || {}) };
  if (auth) headers.Authorization = `Bearer ${state.bridgeToken}`;
  const r = await fetch(`http://127.0.0.1:${state.bridge.port}${path}`, { cache: 'no-store', ...init, headers });
  if (!r.ok) throw new BridgeHttpError(r.status);
  return r;
}

/** The plugin's /status: the full one with the token, else the short one (name, version, auth). */
async function readStatus() {
  let st = await (await bridgeFetch(statusPath())).json();
  // The version was not known yet: ask again with the token, now that it may be sent.
  if (st.auth === 'required' && state.bridgeToken && !sendToken()) {
    state.bridge.version = st.version;
    st = await (await bridgeFetch(statusPath(), {}, true)).json();
  }
  return st;
}

/** The connected plugin keeps backups. */
const canBackup = () => !!(state.bridge && state.bridge.connected && cmpVersion(state.bridge.version, BACKUP_VERSION) >= 0);

/** Keep a report in the plugin's backup (quietly: the report is in this browser anyway). */
async function backupReport(res) {
  if (!canBackup()) return;
  try {
    await bridgeFetch(`/report?key=${encodeURIComponent(res.key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(res) });
  } catch (e) {
    tlog(`backup of ${res.key} failed: ${e.message}`);
  }
}

/** Copy reports missing on either side: this browser <-> the plugin's backup. */
async function syncReports() {
  const b = state.bridge;
  const remote = new Set(await (await bridgeFetch('/reports')).json());
  const local = new Set(await gameKeys());
  let restored = 0;
  for (const key of remote) {
    if (local.has(key)) continue;
    try {
      const res = await (await bridgeFetch(`/report?key=${encodeURIComponent(key)}`)).json();
      const ok = res && res.key === key ? sanitizeReport(res) : null;
      if (ok) { await saveGame(ok); restored += 1; } else tlog(`restore of ${key} skipped: not a valid report`);
    } catch (e) {
      tlog(`restore of ${key} failed: ${e.message}`);
    }
  }
  for (const key of local) {
    if (!remote.has(key)) await backupReport(await getGame(key));
  }
  b.restored = restored;
  if (restored && route().page === 'list') render();
}

async function startBridge(port) {
  if (state.bridgeTimer) clearInterval(state.bridgeTimer);
  state.bridge = { port, connected: false, ends: null, error: '' };
  await setKV('bridgePort', port);
  bridgeTick();
  state.bridgeTimer = setInterval(bridgeTick, POLL_MS);
}

let bridgeBusy = false;
async function bridgeTick() {
  const b = state.bridge;
  if (bridgeBusy || !b) return;
  bridgeBusy = true;
  try {
    if (b.needToken) {
      // Another tab opened from HDT may have stored the token meanwhile.
      const kept = await getKV('bridgeToken');
      if (TOKEN_RE.test(kept || '')) state.bridgeToken = kept;
    }
    const known = b.version;
    const st = await readStatus();
    if (known !== b.version) b.version = known;  // let the version check below run
    const wasConnected = b.connected;
    b.connected = true;
    b.error = '';
    const needToken = st.auth === 'required';
    if (needToken !== !!b.needToken) {
      b.needToken = needToken;
      b.tokenRejected = needToken && !!state.bridgeToken;
      if (route().page === 'list') render();
    }
    b.logDirOk = st.logDirOk;
    b.backupDir = st.backupDir || null;
    b.logBackups = st.logBackups || 0;
    b.reports = st.reports || 0;
    if (b.version !== st.version) {
      const rel = await pluginReleaseInfo();
      b.version = st.version;
      b.latest = rel.latest || null;
      b.min = rel.min || null;
      b.outdated = !!rel.latest && cmpVersion(st.version, rel.latest) < 0;
      b.tooOld = !!rel.min && cmpVersion(st.version, rel.min) < 0;
      if (route().page === 'list') render();
    }
    if (b.tooOld) return;  // this page may not understand an old plugin: ask for the update first
    if (b.needToken) return;  // not paired: the page must be opened from HDT once
    if (b.ends === null) {
      // First contact: bring the reports in line with the backup, then review recent finished
      // games that still have no report.
      b.ends = st.gameEnds;
      if (canBackup()) await syncReports();
      if (st.logDirOk) await bridgeReview(BACKFILL_GAMES);
    } else if (st.gameEnds > b.ends) {
      b.ends = st.gameEnds;
      await new Promise(r => setTimeout(r, 2000));  // let the client finish the game's last lines
      await bridgeReview(0);
    }
    if (!wasConnected && route().page === 'list') render();
  } catch (e) {
    const wasConnected = b.connected;
    if (e instanceof BridgeHttpError && e.status === 401) {
      // The plugin made a new token (or never had this one): pair again.
      b.connected = true;
      if (!b.needToken) {
        b.needToken = true;
        b.tokenRejected = true;
        if (route().page === 'list') render();
      }
      return;
    }
    b.connected = false;
    b.error = e.message;
    if (wasConnected && route().page === 'list') render();
  } finally {
    bridgeBusy = false;
    renderStatus();
  }
}

/** One Power.log from the plugin, as a File for the review worker. */
async function fetchLog(f) {
  let blob = null;
  // The file only grows; a smaller download was cut off on the way, so try again.
  for (let i = 0; i < 3 && !(blob && blob.size >= f.size); i++) {
    try {
      blob = await (await bridgeFetch(`/log?source=${encodeURIComponent(f.source)}`)).blob();
    } catch {
      blob = null;
    }
  }
  if (!blob || blob.size < f.size) throw new Error(t('err.bridgeRead', { source: f.source }));
  return { file: new File([blob], 'Power.log', { lastModified: Date.parse(f.modified) || Date.now() }), source: f.source };
}

async function bridgeReview(limit) {
  const list = await (await bridgeFetch('/logs')).json();
  const files = [];
  // The log before may hold the start of a reconnected game (one more when backfilling).
  for (const f of list.slice(limit ? -3 : -2)) files.push(await fetchLog(f));
  if (files.length) review(files, { limit, context: true });
}

/** "Analyze every backed-up game": each session with the one before it (reconnects). */
let analyzingAll = false;
async function analyzeBackups() {
  if (analyzingAll || !state.bridge || !state.bridge.connected) return;
  analyzingAll = true;
  try {
    const list = await (await bridgeFetch('/logs?all=1')).json();
    for (let i = 0; i < list.length; i++) {
      const files = [];
      for (const f of list.slice(Math.max(0, i - 1), i + 1)) files.push(await fetchLog(f));
      await review(files, { context: true });
    }
  } catch (e) {
    state.error = { text: e.message };
    renderStatus();
  } finally {
    analyzingAll = false;
  }
}

/** "Connect to HDT plugin" button: look for the plugin on its ports (the user asked for it). */
let connecting = false;
async function connectBridge() {
  if (connecting) return;
  connecting = true;
  state.error = null;
  state.status = { key: 'status.searchBridge' };
  state.busy = true;
  renderStatus();
  try {
    for (const port of BRIDGE_PORTS) {
      const ctl = new AbortController();
      // A refused port fails at once; a pending permission prompt waits for the user.
      const timer = setTimeout(() => ctl.abort(), port === BRIDGE_PORTS[0] ? 60000 : 3000);
      try {
        const st = await (await fetch(`http://127.0.0.1:${port}${statusPath()}`, { cache: 'no-store', signal: ctl.signal })).json();
        if (st && st.name === 'bg_advisor_bridge') {
          state.busy = false;
          await startBridge(port);
          render();
          return;
        }
      } catch {
        // not this port
      } finally {
        clearTimeout(timer);
      }
    }
    setError('err.noBridge');
  } finally {
    connecting = false;
    state.busy = false;
    state.status = null;
    renderStatus();
  }
}

/** #/bridge/<port>[/<token>]: opened by the plugin. The token is kept and taken off the address. */
async function handleBridgeRoute() {
  const m = /^#\/bridge\/(\d+)(?:\/([^/]*))?$/.exec(location.hash);
  if (!m) return false;
  const port = parseInt(m[1], 10);
  history.replaceState(null, '', location.pathname + location.search + '#/');
  if (m[2] && TOKEN_RE.test(m[2])) {
    state.bridgeToken = m[2];
    await setKV('bridgeToken', m[2]);
  }
  if (BRIDGE_PORTS.includes(port)) await startBridge(port);
  return true;
}

// ---------------------------------------------------------------- import / export

/** Read report files exported by this page (anyone's): keep the new ones, here and in the backup. */
async function importFiles(files) {
  const known = new Set(await gameKeys());
  let added = 0, had = 0, bad = 0;
  const badFiles = [];
  for (const f of files) {
    let got;
    try {
      got = readExport(await f.text());
    } catch {
      badFiles.push(f.name);
      continue;
    }
    bad += got.bad;
    for (const r of got.reports) {
      if (known.has(r.key)) { had += 1; continue; }  // never overwrite a report already here
      if (!r.imported) r.imported = new Date().toISOString();
      await saveGame(r);
      backupReport(r);
      known.add(r.key);
      added += 1;
    }
  }
  state.error = badFiles.length ? { text: t('err.importFile', { names: badFiles.join('、') }) } : null;
  state.notice = t('notice.imported', { n: added }) + (had ? t('notice.importHad', { n: had }) : '')
    + (bad ? t('notice.importBad', { n: bad }) : '');
  await render();
}

// ---------------------------------------------------------------- rendering

function route() {
  const m = /^#\/game\/(.+)$/.exec(location.hash);
  return m ? { page: 'game', key: decodeURIComponent(m[1]) } : { page: 'list' };
}

function renderStatus() {
  const el = $('#status');
  if (!el) return;
  let dot = '', text = '';
  if (state.busy) {
    const p = state.progress;
    dot = 'busy';
    if (p && p.round !== null && p.round !== undefined) {
      text = esc(t('status.progress', { hero: card(p.hero), round: p.round, done: p.done, total: p.total }))
        + `<span class="pbar"><i style="width:${(100 * p.done / Math.max(1, p.total)).toFixed(0)}%"></i></span>`;
    } else {
      text = esc(state.status ? t(state.status.key, state.status.vars || {}) : t('status.analyzing'));
    }
  } else if (state.notice) {
    text = esc(state.notice);
  } else if (state.bridge && state.bridge.connected) {
    const b = state.bridge;
    dot = b.tooOld || b.needToken ? '' : 'live';
    text = esc(t('status.bridge') + (b.tooOld ? t('status.bridge.tooOld') : b.needToken ? t('status.bridge.pair')
      : b.outdated ? t('status.bridge.update') : ''));
  } else if (state.bridge) {
    text = esc(t('status.waitBridge'));
  } else {
    text = esc(t('status.noBridge'));
  }
  el.innerHTML = `<span class="dot2 ${dot}"></span>${text}`;
  const err = $('#error');
  const msg = errorText();
  err.hidden = !msg;
  err.textContent = msg;
}

/** The published DLL's SHA-256 and how to check it, once version.json has been read. */
function pluginHash() {
  const sha = pluginRelease && pluginRelease.sha256;
  return /^[0-9a-f]{64}$/.test(sha || '') ? `<p class="small mute sha">${t('plugin.sha', { sha })}</p>` : '';
}

function pluginHelp() {
  return `<p>${t('setup.first')}</p>` + t('plugin.steps', { url: PLUGIN_URL }) + pluginHash()
    + `<div class="actions"><button data-act="connect-bridge">${esc(t('btn.connectBridge'))}</button></div>`;
}

function backupInfo(b) {
  if (!b.backupDir) return `<p class="small mute">${esc(t('setup.noBackup'))}</p>`;
  return `<p class="small mute">${esc(t('setup.backup', { dir: b.backupDir, logs: b.logBackups, reports: b.reports }))}`
    + (b.restored ? esc(t('setup.restored', { n: b.restored })) : '') + '</p>';
}

function setupCard() {
  const b = state.bridge;
  if (b && b.connected) {
    const warn = b.logDirOk === false ? `<p class="warn">${esc(t('setup.bridgeNoLogs'))}</p>` : '';
    const steps = t('setup.updateSteps', { url: PLUGIN_URL }) + pluginHash();
    const update = b.tooOld
      ? `<div class="warn err">${esc(t('setup.tooOld', { version: b.version, min: b.min }))}${steps}</div>`
      : b.outdated ? `<div class="warn">${esc(t('setup.outdated', { version: b.version, latest: b.latest }))}${steps}</div>` : '';
    if (b.needToken && !b.tooOld) {
      return `<div class="warn">${esc(t(b.tokenRejected ? 'setup.pairAgain' : 'setup.pair', { version: b.version || '?' }))}`
        + `${t('setup.pairSteps')}</div>${update}`
        + `<div class="actions"><button data-act="connect-bridge">${esc(t('btn.reconnect'))}</button></div>`;
    }
    return `<p>${esc(t('setup.bridgeOn', { version: b.version || '?' }))}</p>${update}${warn}${backupInfo(b)}`
      + `<div class="actions"><button class="ghost" data-act="all">${esc(t('btn.analyzeAll'))}</button>`
      + `${precisionToggle()}</div>`;
  }
  if (b) {
    return `<p>${esc(t('setup.bridgeMissing', { port: b.port }))}</p>`
      + `<div class="actions"><button data-act="connect-bridge">${esc(t('btn.reconnect'))}</button>`
      + `</div>`
      + `<details class="plugin"><summary>${esc(t('plugin.summary'))}</summary>${t('plugin.steps', { url: PLUGIN_URL })}${pluginHash()}</details>`;
  }
  return pluginHelp();
}

const precisionToggle = () =>
  `<label class="small mute toggle"><input type="checkbox" data-act="quick" ${state.precision === 'quick' ? 'checked' : ''}> ${esc(t('quick'))}</label>`;

async function renderList() {
  const games = await allGames();
  const list = games.length ? games.map(g => {
    const s = g.summary || {};
    const misses = (s.misplays || []).length;
    return `<a class="g" href="#/game/${encodeURIComponent(g.key)}">`
      + `<div class="place ${placeCls(g.place)}">${g.place || '?'}</div>`
      + `<div>${g.format >= 2 ? heroIcon(g.hero) : ''}<b>${esc(heroName(g))}</b> <span class="mute small">${esc(g.date)}・${esc(t('list.rounds', { n: (g.rounds || []).length }))}${g.complete === false ? esc(t('list.incomplete')) : ''}`
      + `${g.imported ? esc(t('list.imported', { player: g.player || '?' })) : ''}</span>`
      + `<div class="small">${esc(t('list.misses', { n: misses }))}</div></div>`
      + `<div class="right small">${esc(t('list.positioning'))} ${scoreHtml(s.positioning_avg)}　${esc(t('list.decisions'))} ${scoreHtml(s.decisions_avg)}</div></a>`;
  }).join('') : `<p class="mute">${esc(t('list.empty'))}</p>`;
  const tools = `<div class="actions listbar">`
    + (games.length ? `<button class="ghost" data-act="export-all">${esc(t('btn.exportAll'))}</button>` : '')
    + `<label class="btn ghost">${esc(t('btn.import'))}<input type="file" accept=".json,application/json" multiple hidden data-act="import"></label></div>`;
  return `<section class="card">${setupCard()}</section>${tools}<div class="games">${list}</div>`;
}

function renderChrome() {
  $('#brand').textContent = t('app.title');
  const btn = $('#lang');
  btn.textContent = t('lang.switch');
  btn.title = t('lang.switch.title');
  $('#help').innerHTML =
    `<details class="card help"><summary>${esc(t('help.about.summary'))}</summary>${t('help.about.body')}</details>`
    + `<details class="card help"><summary>${esc(t('help.privacy.summary'))}</summary>${t('help.privacy.body')}</details>`;
}

async function render() {
  const r = route();
  const main = $('#view');
  if (r.page === 'game') {
    const res = await getGame(r.key);
    let html = `<p>${esc(t('list.notFound'))}</p>`;
    try {
      if (res) html = renderGame(res);
    } catch (e) {
      html = `<p class="warn">${esc(t('err.render', { msg: e.message }))}</p>`
        + `<p class="small"><a href="#" data-delete="${esc(res.key)}" class="mute">${esc(t('r.delete'))}</a></p>`;
    }
    main.innerHTML = html;
    document.title = res
      ? t('title.game', { hero: heroName(res), place: res.place ? t('title.place', { place: res.place }) : '' })
      : t('app.title');
  } else {
    main.innerHTML = await renderList();
    if (!document.title.startsWith('●')) document.title = t('app.title');
  }
  renderStatus();
}

// ---------------------------------------------------------------- events

document.addEventListener('click', async (ev) => {
  const a = ev.target.closest('[data-round],[data-act],[data-delete],[data-export]');
  if (!a) return;
  if (a.dataset.round) {
    ev.preventDefault();
    const el = document.getElementById(`r${a.dataset.round}`);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  } else if (a.dataset.delete) {
    ev.preventDefault();
    if (confirm(t(canBackup() ? 'confirm.deleteBackup' : 'confirm.delete'))) {
      await deleteGame(a.dataset.delete);
      if (canBackup()) {
        try {
          await bridgeFetch(`/report?key=${encodeURIComponent(a.dataset.delete)}`, { method: 'DELETE' });
        } catch (e) {
          tlog(`delete of ${a.dataset.delete} in the backup failed: ${e.message}`);
        }
      }
      location.hash = '#/';
    }
  } else if (a.dataset.export) {
    ev.preventDefault();
    const res = await getGame(a.dataset.export);
    if (res) {
      const anon = confirm(t('export.anon'));
      const out = anon ? anonymize(res) : res;
      downloadReports([out], `bg_advisor_${out.key}.json`);
    }
  } else if (a.dataset.act === 'export-all') {
    const all = await allGames();
    downloadReports(confirm(t('export.anon')) ? all.map(anonymize) : all, `bg_advisor_reports_${today()}.json`);
  } else if (a.dataset.act === 'all') analyzeBackups();
  else if (a.dataset.act === 'connect-bridge') connectBridge();
  else if (a.dataset.act === 'lang') {
    const y = window.scrollY;
    setLang(getLang() === 'zh' ? 'en' : 'zh');
    await setKV('lang', getLang());
    renderChrome();
    await render();
    window.scrollTo(0, y);  // same place on the page, other language
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset.act === 'import') {
    await importFiles([...el.files]);
    el.value = '';
  } else if (el.dataset.act === 'quick') {
    state.precision = el.checked ? 'quick' : 'full';
    await setKV('precision', state.precision);
  }
});

window.addEventListener('hashchange', async () => {
  await handleBridgeRoute();
  await render();
  if (route().page === 'game') window.scrollTo(0, 0);
});

// ---------------------------------------------------------------- start

(async function main() {
  try {
    await start();
  } catch (e) {
    // Without this a failure here (storage blocked by the browser, say) leaves a blank page.
    console.error(e);
    const box = document.querySelector('#error') || document.body.appendChild(document.createElement('div'));
    box.className = 'warn err';
    box.hidden = false;
    box.textContent = `Could not start: ${(e && e.message) || e}. Browser storage may be blocked (private mode?). / 無法啟動：${(e && e.message) || e}。瀏覽器的儲存空間可能被封鎖（無痕模式？）`;
  }
})();

async function start() {
  initLang(await getKV('lang'));
  await loadNames();
  initCardTip();
  renderChrome();
  state.precision = (await getKV('precision')) || 'full';
  const token = await getKV('bridgeToken');
  if (TOKEN_RE.test(token || '')) state.bridgeToken = token;
  if (!(await handleBridgeRoute())) {
    const port = await getKV('bridgePort');
    if (BRIDGE_PORTS.includes(port)) await startBridge(port);
  }
  await render();
  // The install and update steps show the DLL's SHA-256 from version.json.
  if (!pluginRelease) pluginReleaseInfo().then(() => { if (route().page === 'list') render(); });
  // Test hook: ?log=<url> reviews a log served next to the page (used by the test harness).
  const q = new URLSearchParams(location.search);
  const sameOrigin = u => new URL(u, location.href).origin === location.origin;
  if (LOCAL && q.get('log') && q.getAll('log').every(sameOrigin) && (!q.get('report') || sameOrigin(q.get('report')))) {
    const files = [];
    for (const url of q.getAll('log')) {
      const blob = await (await fetch(url)).blob();
      files.push({ file: new File([blob], url.split('/').pop()), source: url });
    }
    state.precision = q.get('precision') || state.precision;
    await review(files, { onlyComplete: false });
    if (q.get('report')) {
      await fetch(q.get('report'), { method: 'POST', body: JSON.stringify(await allGames()) });
    }
  }
}
