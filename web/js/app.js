// The page: pick Hearthstone's Logs folder once (or connect the HDT plugin), then every finished
// Battlegrounds game is reviewed in the background and its report shows up in the list.

import { canWatch, findLogs, LogWatcher } from './watch.js';
import { allGames, deleteGame, gameKeys, getGame, getKV, saveGame, setKV } from './store.js';
import { esc, heroName, placeCls, renderGame, scoreHtml } from './report.js';
import { card, getLang, initLang, loadNames, setLang, t } from './i18n.js';

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
  dir: null,          // FileSystemDirectoryHandle
  watcher: null,
  timer: null,
  busy: false,
  progress: null,     // {hero, done, total, round}
  status: null,       // {key, vars}
  error: null,        // {key, vars} or {text}
  precision: 'full',
};

const setError = (key, vars = {}) => { state.error = { key, vars }; };
const errorText = () => (!state.error ? '' : state.error.text || t(state.error.key, state.error.vars));

// ---------------------------------------------------------------- review worker

let worker = null;
let pending = Promise.resolve();

function review(files, { limit = 0, onlyComplete = true } = {}) {
  pending = pending.then(() => new Promise(async (resolve) => {
    if (!worker) worker = new Worker(new URL('./review-worker.js', import.meta.url), { type: 'module' });
    state.busy = true;
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
    worker.postMessage({ type: 'review', files, known: await gameKeys(), precision: state.precision, limit, onlyComplete });
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

// ---------------------------------------------------------------- folder watching

async function pickFolder() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'hs-logs', mode: 'read' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    setError('err.folder', { msg: e.message });
    const help = $('#help-blocked');
    if (help) help.open = true;
    render();
    return;
  }
  await setKV('dir', dir);
  await startWatching(dir, true);
}

async function resumeFolder() {
  const dir = state.dir;
  if (!dir) return;
  if (await dir.requestPermission({ mode: 'read' }) === 'granted') await startWatching(dir, true);
}

async function startWatching(dir, backfill) {
  stopWatching();
  state.dir = dir;
  state.error = null;
  const logs = await findLogs(dir, true);
  if (!logs.length) setError('err.noPowerLog', { dir: dir.name });
  state.watcher = new LogWatcher(dir);
  await state.watcher.start();
  state.timer = setInterval(tick, POLL_MS);
  render();
  if (backfill && logs.length) review(logs.slice(-2), { limit: BACKFILL_GAMES });
}

function stopWatching() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.watcher = null;
}

let ticking = false;
async function tick() {
  if (ticking || !state.watcher) return;
  ticking = true;
  try {
    const ended = await state.watcher.poll();
    if (ended.length) {
      const logs = await findLogs(state.dir, true);
      for (const f of ended) {
        // The log before it may hold the start of a reconnected game.
        const i = logs.findIndex(l => l.source === f.source);
        const files = i > 0 ? [logs[i - 1], logs[i]] : [f];
        await new Promise(r => setTimeout(r, 2000));  // let the client finish the game's last lines
        review(files);
      }
    }
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      stopWatching();
      setError('err.permission');
      render();
    }
  } finally {
    ticking = false;
  }
}

async function analyzeAll() {
  if (!state.dir) return;
  review(await findLogs(state.dir, false));
}

function analyzeFiles(fileList) {
  const files = [...fileList].filter(f => /\.(log|txt)$/i.test(f.name))
    .map(f => ({ file: f, source: f.webkitRelativePath || f.name }));
  if (files.length) review(files, { onlyComplete: false });
}

// ---------------------------------------------------------------- HDT plugin bridge
//
// The BG Advisor plugin for Hearthstone Deck Tracker serves the recent Power.log files on
// 127.0.0.1 and opens this page at #/bridge/<port> when a game ends. The page then asks the
// plugin every few seconds whether another game has ended. Local requests are only made after
// the plugin opened the page, or when the user clicks "Connect to HDT plugin".

const BRIDGE_PORTS = [47613, 47614, 47615, 47616, 47617];
const PLUGIN_URL = 'plugin/BgAdvisorBridge.dll';

/** -1, 0 or 1, comparing dotted versions ("0.1.0" < "0.10.0"). */
function cmpVersion(a, b) {
  const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// plugin/version.json on this site: {"latest": newest plugin, "min": oldest one this page works with}.
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

async function bridgeFetch(path) {
  const r = await fetch(`http://127.0.0.1:${state.bridge.port}${path}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
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
    const st = await (await bridgeFetch(statusPath())).json();
    const wasConnected = b.connected;
    b.connected = true;
    b.error = '';
    b.logDirOk = st.logDirOk;
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
    if (b.ends === null) {
      // First contact: review recent finished games without a report (like the folder backfill).
      b.ends = st.gameEnds;
      if (st.logDirOk) await bridgeReview(BACKFILL_GAMES);
    } else if (st.gameEnds > b.ends) {
      b.ends = st.gameEnds;
      await new Promise(r => setTimeout(r, 2000));  // let the client finish the game's last lines
      await bridgeReview(0);
    }
    if (!wasConnected && route().page === 'list') render();
  } catch (e) {
    const wasConnected = b.connected;
    b.connected = false;
    b.error = e.message;
    if (wasConnected && route().page === 'list') render();
  } finally {
    bridgeBusy = false;
    renderStatus();
  }
}

async function bridgeReview(limit) {
  const list = await (await bridgeFetch('/logs')).json();
  const files = [];
  for (const f of list.slice(-2)) {  // the log before may hold the start of a reconnected game
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
    files.push({ file: new File([blob], 'Power.log', { lastModified: Date.parse(f.modified) || Date.now() }), source: f.source });
  }
  if (files.length) review(files, { limit });
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

async function forgetBridge() {
  if (state.bridgeTimer) clearInterval(state.bridgeTimer);
  state.bridgeTimer = null;
  state.bridge = null;
  await setKV('bridgePort', null);
  render();
}

/** #/bridge/<port>: opened by the plugin. */
async function handleBridgeRoute() {
  const m = /^#\/bridge\/(\d+)$/.exec(location.hash);
  if (!m) return false;
  const port = parseInt(m[1], 10);
  history.replaceState(null, '', location.pathname + location.search + '#/');
  if (BRIDGE_PORTS.includes(port)) await startBridge(port);
  return true;
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
  } else if (state.bridge && state.bridge.connected) {
    dot = state.bridge.tooOld ? '' : 'live';
    text = esc(t('status.bridge') + (state.watcher ? '・' + t('status.watching', { dir: state.dir.name }) : '')
      + (state.bridge.tooOld ? t('status.bridge.tooOld') : state.bridge.outdated ? t('status.bridge.update') : ''));
  } else if (state.watcher) {
    dot = 'live';
    text = esc(t('status.watching', { dir: state.dir.name }));
  } else if (state.bridge) {
    text = esc(t('status.waitBridge'));
  } else {
    text = esc(t(state.dir ? 'status.paused' : 'status.noFolder'));
  }
  el.innerHTML = `<span class="dot2 ${dot}"></span>${text}`;
  const err = $('#error');
  const msg = errorText();
  err.hidden = !msg;
  err.textContent = msg;
}

function pluginHelp(open = false) {
  return `<details class="plugin"${open ? ' open' : ''}><summary>${esc(t('plugin.summary'))}</summary>`
    + `<p>${esc(t('plugin.ready'))}<button data-act="connect-bridge">${esc(t('btn.connectBridge'))}</button></p>`
    + t('plugin.steps', { url: PLUGIN_URL }) + '</details>';
}

function setupCard() {
  const b = state.bridge;
  if (b && b.connected) {
    const warn = b.logDirOk === false ? `<p class="warn">${esc(t('setup.bridgeNoLogs'))}</p>` : '';
    const steps = t('setup.updateSteps', { url: PLUGIN_URL });
    const update = b.tooOld
      ? `<div class="warn err">${esc(t('setup.tooOld', { version: b.version, min: b.min }))}${steps}</div>`
      : b.outdated ? `<div class="warn">${esc(t('setup.outdated', { version: b.version, latest: b.latest }))}${steps}</div>` : '';
    return `<p>${esc(t('setup.bridgeOn', { version: b.version || '?' }))}</p>${update}${warn}`
      + `<div class="actions">${fileButton()}<button class="ghost" data-act="forget-bridge">${esc(t('btn.forgetBridge'))}</button>${precisionToggle()}</div>`;
  }
  if (b) {
    return `<p>${esc(t('setup.bridgeMissing', { port: b.port }))}</p>`
      + `<div class="actions"><button data-act="connect-bridge">${esc(t('btn.reconnect'))}</button>${fileButton()}`
      + `<button class="ghost" data-act="forget-bridge">${esc(t('btn.forgetBridge'))}</button></div>`;
  }
  return folderOrBrowserCard() + (state.watcher ? '' : pluginHelp());
}

function folderOrBrowserCard() {
  if (state.watcher) {
    return `<div class="actions"><button class="ghost" data-act="all">${esc(t('btn.analyzeAll'))}</button>`
      + `<button class="ghost" data-act="pick">${esc(t('btn.changeFolder'))}</button>${fileButton()}${precisionToggle()}</div>`;
  }
  if (state.dir) {
    return `<p>${t('setup.lastFolder', { dir: esc(state.dir.name) })}</p>`
      + `<div class="actions"><button data-act="resume">${esc(t('btn.resume'))}</button>`
      + `<button class="ghost" data-act="pick">${esc(t('btn.changeFolder'))}</button>${fileButton()}</div>`;
  }
  if (!canWatch() && navigator.brave) {
    return `<p>${t('setup.brave')}</p><div class="actions">${fileButton(true)}</div>`;
  }
  if (!canWatch()) {
    return `<p>${esc(t('setup.noWatch'))}</p><div class="actions">${fileButton(true)}</div>`;
  }
  return `<p>${t('setup.first')}</p>`
    + `<div class="actions"><button data-act="pick">${esc(t('btn.pickFolder'))}</button>${fileButton()}</div>`;
}

const fileButton = (primary = false) =>
  `<label class="${primary ? 'btn' : 'btn ghost'}">${esc(t('btn.pickFile'))}<input type="file" accept=".log,.txt" multiple hidden data-act="files"></label>`;

const precisionToggle = () =>
  `<label class="small mute toggle"><input type="checkbox" data-act="quick" ${state.precision === 'quick' ? 'checked' : ''}> ${esc(t('quick'))}</label>`;

async function renderList() {
  const games = await allGames();
  const list = games.length ? games.map(g => {
    const s = g.summary || {};
    const misses = (s.misplays || []).length;
    return `<a class="g" href="#/game/${encodeURIComponent(g.key)}">`
      + `<div class="place ${placeCls(g.place)}">${g.place || '?'}</div>`
      + `<div><b>${esc(heroName(g))}</b> <span class="mute small">${esc(g.date)}・${esc(t('list.rounds', { n: g.rounds.length }))}${g.complete === false ? esc(t('list.incomplete')) : ''}</span>`
      + `<div class="small">${esc(t('list.misses', { n: misses }))}</div></div>`
      + `<div class="right small">${esc(t('list.positioning'))} ${scoreHtml(s.positioning_avg)}　${esc(t('list.decisions'))} ${scoreHtml(s.decisions_avg)}</div></a>`;
  }).join('') : `<p class="mute">${esc(t('list.empty'))}</p>`;
  return `<section class="card">${setupCard()}</section><div class="games">${list}</div>`;
}

function renderChrome() {
  $('#brand').textContent = t('app.title');
  const btn = $('#lang');
  btn.textContent = t('lang.switch');
  btn.title = t('lang.switch.title');
  $('#help').innerHTML =
    `<details id="help-blocked" class="card help"><summary>${esc(t('help.blocked.summary'))}</summary>${t('help.blocked.body')}</details>`
    + `<details class="card help"><summary>${esc(t('help.about.summary'))}</summary>${t('help.about.body')}</details>`;
  $('.dropzone').textContent = t('drop');
}

async function render() {
  const r = route();
  const main = $('#view');
  if (r.page === 'game') {
    const res = await getGame(r.key);
    main.innerHTML = res ? renderGame(res) : `<p>${t('list.notFound')}</p>`;
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
  const a = ev.target.closest('[data-round],[data-act],[data-delete]');
  if (!a) return;
  if (a.dataset.round) {
    ev.preventDefault();
    const el = document.getElementById(`r${a.dataset.round}`);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  } else if (a.dataset.delete) {
    ev.preventDefault();
    if (confirm(t('confirm.delete'))) {
      await deleteGame(a.dataset.delete);
      location.hash = '#/';
    }
  } else if (a.dataset.act === 'pick') pickFolder();
  else if (a.dataset.act === 'resume') resumeFolder();
  else if (a.dataset.act === 'all') analyzeAll();
  else if (a.dataset.act === 'forget-bridge') forgetBridge();
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
  if (el.dataset.act === 'files') analyzeFiles(el.files);
  else if (el.dataset.act === 'quick') {
    state.precision = el.checked ? 'quick' : 'full';
    await setKV('precision', state.precision);
  }
});

document.addEventListener('dragover', ev => { ev.preventDefault(); document.body.classList.add('drop'); });
document.addEventListener('dragleave', ev => { if (!ev.relatedTarget) document.body.classList.remove('drop'); });
document.addEventListener('drop', ev => {
  ev.preventDefault();
  document.body.classList.remove('drop');
  analyzeFiles(ev.dataTransfer.files);
});

window.addEventListener('hashchange', async () => {
  await handleBridgeRoute();
  await render();
  if (route().page === 'game') window.scrollTo(0, 0);
});

// ---------------------------------------------------------------- start

(async function main() {
  initLang(await getKV('lang'));
  await loadNames();
  renderChrome();
  state.precision = (await getKV('precision')) || 'full';
  const dir = await getKV('dir');
  if (dir) {
    state.dir = dir;
    if (await dir.queryPermission({ mode: 'read' }) === 'granted') await startWatching(dir, true);
  }
  if (!(await handleBridgeRoute())) {
    const port = await getKV('bridgePort');
    if (BRIDGE_PORTS.includes(port)) await startBridge(port);
  }
  await render();
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
})();
