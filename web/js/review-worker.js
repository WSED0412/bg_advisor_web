// The review worker: reads Power.log files, finds Battlegrounds games without a report and
// reviews them, posting progress and each finished report. It owns the simulation pool.
//
// in:  {type: 'review', files: [{handle | file, source}], known: [keys], precision, limit, onlyComplete,
//        skipSource (games read only from this file are left out)}
// out: {type: 'status', text} | {type: 'found', games: [{key, hero}]} |
//      {type: 'progress', key, done, total, text} | {type: 'result', result} |
//      {type: 'done', reviewed} | {type: 'error', message}

import { compileEngine, Engine } from './engine.js';
import { initCards } from './cards.js';
import { readGames } from './bglog.js';
import { SimPool } from './sim.js';
import { PRECISION, gameKey, reviewGame } from './review.js';

let module = null, engine = null, sim = null, ready = null;

function init() {
  if (!ready) {
    ready = (async () => {
      module = await compileEngine();
      engine = await Engine.create(module);
      const json = async f => {
        try { return await (await fetch(new URL(`../data/${f}`, import.meta.url))).json(); } catch { return {}; }
      };
      const [tw, skins] = await Promise.all([json('names_zhTW.json'), json('hero_skins.json')]);
      initCards(engine.catalog(), tw, skins);
      sim = await SimPool.create(module);
    })();
  }
  return ready;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The text of a log; the client may be writing it, so a read can fail and is retried. */
async function readText(entry) {
  let last = null;
  for (let i = 0; i < 8; i++) {
    try {
      const f = entry.handle ? await entry.handle.getFile() : entry.file;
      return { text: await f.text(), day: dayOf(f.lastModified) };
    } catch (e) {
      last = e;
      if (!entry.handle) break;
      await sleep(750);
    }
  }
  throw new Error(`${entry.source}: ${last && last.message}`);
}

function dayOf(ms) {
  const d = new Date(ms || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function review(msg) {
  self.postMessage({ type: 'status', code: 'status.loading' });
  await init();
  self.postMessage({ type: 'status', code: 'status.reading' });
  const files = [];
  const days = new Map();
  for (const entry of msg.files) {
    const { text, day } = await readText(entry);
    files.push({ text, source: entry.source });
    days.set(entry.source, day);
  }
  const known = new Set(msg.known || []);
  let games = readGames(files).filter(g => g.combats.length && (!msg.onlyComplete || g.complete)
    && g.source !== msg.skipSource);
  games = games.filter(g => !known.has(gameKey(g)));
  if (msg.limit) games = games.slice(-msg.limit);
  self.postMessage({ type: 'found', games: games.map(g => ({ key: gameKey(g), hero: g.hero })) });

  const prec = PRECISION[msg.precision] || PRECISION.full;
  let reviewed = 0;
  for (const g of games) {
    if (engine.broken) engine = await Engine.create(module);
    const key = gameKey(g);
    const t0 = performance.now();
    const result = await reviewGame(engine, sim, g, prec, (done, total, round) =>
      self.postMessage({ type: 'progress', key, hero: g.hero, done, total, round }),
      days.get(g.source.split(' + ')[0]) || '');
    result.seconds = Math.round((performance.now() - t0) / 1000);
    result.precision = msg.precision || 'full';
    self.postMessage({ type: 'result', result });
    reviewed += 1;
  }
  self.postMessage({ type: 'done', reviewed });
}

let queue = Promise.resolve();
self.onmessage = (ev) => {
  if (ev.data.type !== 'review') return;
  queue = queue.then(() => review(ev.data)).catch(e => {
    self.postMessage({ type: 'error', message: `${e && e.message || e}` });
  });
};
