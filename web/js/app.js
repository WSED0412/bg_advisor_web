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
  } else if (state.watcher) {
    dot = 'live';
    text = `監看中：${esc(state.dir.name)}`;
  } else {
    text = state.dir ? '已暫停監看' : '尚未設定紀錄檔資料夾';
  }
  el.innerHTML = `<span class="dot2 ${dot}"></span>${text}`;
  const err = $('#error');
  err.hidden = !state.error;
  err.textContent = state.error;
}

function setupCard() {
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

window.addEventListener('hashchange', render);

// ---------------------------------------------------------------- start

(async function main() {
  state.precision = (await getKV('precision')) || 'full';
  const dir = await getKV('dir');
  if (dir) {
    state.dir = dir;
    if (await dir.queryPermission({ mode: 'read' }) === 'granted') await startWatching(dir, true);
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
