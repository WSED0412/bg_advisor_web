// The page: pick Hearthstone's Logs folder once, then every finished Battlegrounds game is
// reviewed in the background and its report shows up in the list.

import { canWatch, findLogs, LogWatcher } from './watch.js';
import { allGames, deleteGame, gameKeys, getGame, getKV, saveGame, setKV } from './store.js';
import { esc, placeCls, renderGame, scoreHtml } from './report.js';

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
  progress: null,     // {hero, done, total, text}
  status: '',
  error: '',
  precision: 'full',
  newKey: null,       // a report finished while the list was showing
};

// ---------------------------------------------------------------- review worker

let worker = null;
let pending = Promise.resolve();

function review(files, { limit = 0, onlyComplete = true } = {}) {
  pending = pending.then(() => new Promise(async (resolve) => {
    if (!worker) worker = new Worker(new URL('./review-worker.js', import.meta.url), { type: 'module' });
    state.busy = true;
    state.error = '';
    renderStatus();
    worker.onmessage = async (ev) => {
      const m = ev.data;
      if (m.type !== 'result') tlog(JSON.stringify(m));
      if (m.type === 'status') { state.status = m.text; renderStatus(); }
      else if (m.type === 'found') {
        state.status = m.games.length ? `找到 ${m.games.length} 局新的對局` : '沒有新的英雄戰場對局';
        renderStatus();
      } else if (m.type === 'progress') {
        state.progress = m;
        renderStatus();
      } else if (m.type === 'result') {
        await saveGame(m.result);
        state.progress = null;
        onNewReport(m.result);
      } else if (m.type === 'done' || m.type === 'error') {
        if (m.type === 'error') state.error = m.message;
        state.busy = false;
        state.progress = null;
        state.status = '';
        renderStatus();
        resolve();
      }
    };
    worker.onerror = (e) => {
      tlog(`worker error: ${e.message} @ ${e.filename}:${e.lineno}`);
      state.error = `分析程式出錯：${e.message || e}`;
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
  if (document.hidden) document.title = `● 新報告：${res.hero_name}｜英雄戰場復盤`;
  if (route().page === 'list') location.hash = `#/game/${encodeURIComponent(res.key)}`;
  else render();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && document.title.startsWith('●')) document.title = '英雄戰場復盤';
});

// ---------------------------------------------------------------- folder watching

async function pickFolder() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'hs-logs', mode: 'read' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    state.error = `無法開啟這個資料夾（${e.message}）。如果是放在 Program Files 裡，請看下面的說明。`;
    $('#help-blocked').open = true;
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
  state.error = '';
  const logs = await findLogs(dir, true);
  if (!logs.length) {
    state.error = `「${dir.name}」裡找不到 Power.log。請選擇爐石安裝資料夾裡的 Logs 資料夾，並確認 log.config 有開啟 [Power] 紀錄。`;
  }
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
      state.error = '瀏覽器收回了讀取資料夾的權限，請按「繼續監看」。';
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
// plugin every few seconds whether another game has ended. Only the plugin's ports are used,
// and only after the plugin itself opened the page once (no local requests otherwise).

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
    if (!blob || blob.size < f.size) throw new Error(`無法從外掛完整讀取 ${f.source}`);
    files.push({ file: new File([blob], 'Power.log', { lastModified: Date.parse(f.modified) || Date.now() }), source: f.source });
  }
  if (files.length) review(files, { limit });
}

/** "連線 HDT 外掛" button: look for the plugin on its ports (the user asked for it). */
let connecting = false;
async function connectBridge() {
  if (connecting) return;
  connecting = true;
  state.error = '';
  state.status = '正在尋找 HDT 外掛…（瀏覽器若詢問「存取本機網路」請按允許）';
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
    state.error = '找不到 HDT 外掛。請確認 Hearthstone Deck Tracker 有開著、「BG Advisor」外掛已啟用；'
      + '如果瀏覽器曾詢問「存取本機網路／localhost」而被封鎖，請在網址列左邊的網站設定改回允許，再按一次「連線 HDT 外掛」。';
  } finally {
    connecting = false;
    state.busy = false;
    state.status = '';
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
    text = p ? `正在分析 ${esc(p.hero)}：${esc(p.text)}（${p.done}/${p.total}）` : esc(state.status || '分析中…');
    if (p) text += `<span class="pbar"><i style="width:${(100 * p.done / Math.max(1, p.total)).toFixed(0)}%"></i></span>`;
  } else if (state.bridge && state.bridge.connected) {
    dot = state.bridge.tooOld ? '' : 'live';
    text = '已連線 HDT 外掛' + (state.watcher ? `・監看中：${esc(state.dir.name)}` : '')
      + (state.bridge.tooOld ? '・外掛需要更新' : state.bridge.outdated ? '・有新版外掛' : '');
  } else if (state.watcher) {
    dot = 'live';
    text = `監看中：${esc(state.dir.name)}`;
  } else if (state.bridge) {
    text = '等待 HDT 外掛…';
  } else {
    text = state.dir ? '已暫停監看' : '尚未設定紀錄檔資料夾';
  }
  el.innerHTML = `<span class="dot2 ${dot}"></span>${text}`;
  const err = $('#error');
  err.hidden = !state.error;
  err.textContent = state.error;
}

function pluginHelp(open = false) {
  return `<details class="plugin"${open ? ' open' : ''}><summary>有用 Hearthstone Deck Tracker？裝外掛就不用設定資料夾</summary>`
    + `<p>已經裝好外掛、HDT 也開著：<button data-act="connect-bridge">連線 HDT 外掛</button></p>`
    + `<ol><li>下載 <a href="${PLUGIN_URL}" download>BgAdvisorBridge.dll</a>，在檔案上按右鍵 › 內容，勾選「解除封鎖」後按確定。</li>`
    + `<li>把它放進 <code>%AppData%\\HearthstoneDeckTracker\\Plugins</code>，重新啟動 HDT。</li>`
    + `<li>HDT 的 選項 › 追蹤器 › 外掛 裡啟用「BG Advisor」，再按一次「開啟復盤網頁」。</li>`
    + `<li>瀏覽器問「允許存取本機網路上的裝置」時按允許。</li></ol>`
    + `<p class="small mute">之後每局英雄戰場結束，HDT 會自動打開這局的報告。外掛只在本機 127.0.0.1 提供紀錄檔給這個網站，不會上傳任何東西。</p></details>`;
}

function setupCard() {
  const b = state.bridge;
  if (b && b.connected) {
    const warn = b.logDirOk === false
      ? '<p class="warn">外掛找不到爐石的 Logs 資料夾，請確認 HDT 設定裡的爐石安裝路徑。</p>' : '';
    const steps = `<a href="${PLUGIN_URL}" download>下載新版外掛</a>，關閉 HDT，用它取代 `
      + `<code>%AppData%\\HearthstoneDeckTracker\\Plugins\\BgAdvisorBridge.dll</code>`
      + `（在新檔案上按右鍵 › 內容，勾選「解除封鎖」），再重新開啟 HDT。`;
    const update = b.tooOld
      ? `<div class="warn err">外掛版本太舊（${esc(b.version)}），這個網頁需要 ${esc(b.min)} 以上才能自動分析。${steps}</div>`
      : b.outdated ? `<div class="warn">有新版外掛：${esc(b.version)} → ${esc(b.latest)}。${steps}</div>` : '';
    return `<p>已連線 HDT 外掛（${esc(b.version || '?')}）：每局英雄戰場結束後會自動分析，不需要設定資料夾。</p>${update}${warn}`
      + `<div class="actions">${fileButton()}<button class="ghost" data-act="forget-bridge">不再使用外掛</button>${precisionToggle()}</div>`;
  }
  if (b) {
    return `<p>找不到 HDT 外掛（連接埠 ${b.port}）。請確認 Hearthstone Deck Tracker 有開著，而且「BG Advisor」外掛已啟用。`
      + `如果瀏覽器問過「存取本機網路」而你按了封鎖，需要在網址列左邊的網站設定裡改回允許。</p>`
      + `<div class="actions"><button data-act="connect-bridge">重新連線</button>${fileButton()}`
      + `<button class="ghost" data-act="forget-bridge">不再使用外掛</button></div>`;
  }
  return folderOrBrowserCard() + (state.watcher ? '' : pluginHelp());
}

function folderOrBrowserCard() {
  if (state.watcher) {
    return `<div class="actions"><button class="ghost" data-act="all">分析資料夾裡所有對局</button>`
      + `<button class="ghost" data-act="pick">更換資料夾</button>${fileButton()}${precisionToggle()}</div>`;
  }
  if (state.dir) {
    return `<p>上次使用的資料夾：<b>${esc(state.dir.name)}</b>。瀏覽器需要你再按一次才能讀取。</p>`
      + `<div class="actions"><button data-act="resume">繼續監看</button><button class="ghost" data-act="pick">更換資料夾</button>${fileButton()}</div>`;
  }
  if (!canWatch() && navigator.brave) {
    // Brave ships the File System Access API behind a flag.
    return `<p>Brave 預設關閉了「讓網頁讀取資料夾」的功能，所以現在只能手動選擇或拖曳 Power.log。`
      + `想要打完自動分析，可以開啟這個功能（只需要一次）：</p>`
      + `<ol><li>在網址列輸入 <code>brave://flags/#file-system-access-api</code></li>`
      + `<li>把「File System Access API」改成 <b>Enabled</b></li><li>按右下角的 <b>Relaunch</b> 重新啟動 Brave，再回到這個頁面</li></ol>`
      + `<div class="actions">${fileButton(true)}</div>`;
  }
  if (!canWatch()) {
    return `<p>這個瀏覽器不支援自動監看資料夾（需要 Chrome、Edge，或開啟設定的 Brave）。可以在每局結束後，手動選擇或拖曳 Power.log 到這個頁面。</p>`
      + `<div class="actions">${fileButton(true)}</div>`;
  }
  return `<p>第一次使用：選擇爐石安裝資料夾裡的 <b>Logs</b> 資料夾（通常是 <code>C:\\Program Files (x86)\\Hearthstone\\Logs</code>）。`
    + `之後開著這個分頁去打英雄戰場，每局結束就會自動分析。</p>`
    + `<div class="actions"><button data-act="pick">選擇 Logs 資料夾</button>${fileButton()}</div>`;
}

const fileButton = (primary = false) =>
  `<label class="${primary ? 'btn' : 'btn ghost'}">選擇 Power.log<input type="file" accept=".log,.txt" multiple hidden data-act="files"></label>`;

const precisionToggle = () =>
  `<label class="small mute toggle"><input type="checkbox" data-act="quick" ${state.precision === 'quick' ? 'checked' : ''}> 快速模式（較快、較不準）</label>`;

async function renderList() {
  const games = await allGames();
  const list = games.length ? games.map(g => {
    const s = g.summary || {};
    const misses = (s.misplays || []).length;
    return `<a class="g" href="#/game/${encodeURIComponent(g.key)}">`
      + `<div class="place ${placeCls(g.place)}">${g.place || '?'}</div>`
      + `<div><b>${esc(g.hero_name)}</b> <span class="mute small">${esc(g.date)}・${g.rounds.length} 回合${g.complete === false ? '・未完成' : ''}</span>`
      + `<div class="small">${misses ? `明顯失誤 ${misses} 個` : '沒有明顯失誤'}</div></div>`
      + `<div class="right small">站位 ${scoreHtml(s.positioning_avg)}　決策 ${scoreHtml(s.decisions_avg)}</div></a>`;
  }).join('') : '<p class="mute">還沒有報告。打完一局英雄戰場後會自動出現在這裡。</p>';
  return `<section class="card">${setupCard()}</section><div class="games">${list}</div>`;
}

async function render() {
  const r = route();
  const main = $('#view');
  if (r.page === 'game') {
    const res = await getGame(r.key);
    main.innerHTML = res ? renderGame(res) : '<p>找不到這份報告。<a href="#/">回到列表</a></p>';
    document.title = res ? `${res.hero_name}${res.place ? ` 第 ${res.place} 名` : ''}｜英雄戰場復盤` : '英雄戰場復盤';
    window.scrollTo(0, 0);
  } else {
    main.innerHTML = await renderList();
    if (!document.title.startsWith('●')) document.title = '英雄戰場復盤';
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
    if (confirm('刪除這份報告？')) {
      await deleteGame(a.dataset.delete);
      location.hash = '#/';
    }
  } else if (a.dataset.act === 'pick') pickFolder();
  else if (a.dataset.act === 'resume') resumeFolder();
  else if (a.dataset.act === 'all') analyzeAll();
  else if (a.dataset.act === 'forget-bridge') forgetBridge();
  else if (a.dataset.act === 'connect-bridge') connectBridge();
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
  if (await handleBridgeRoute()) render();
  else render();
});

// ---------------------------------------------------------------- start

(async function main() {
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
