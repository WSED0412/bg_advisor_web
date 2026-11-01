// Build a TavernGym game that holds a given scene (my warband vs one opponent).
//
// Seat 0 is me, seat 1 the opponent. Notes are {code, card} (rendered by the page). `atk`/`hp` are the numbers shown in the game, auras
// included; TavernGym adds board auras itself, so after setup the stored stats are corrected
// until TavernGym shows the same numbers (otherwise an aura would count twice).

import { nameOf, resolve } from './cards.js';

export const ME = 0, OPP = 1;
// A. F. Kay: a Hero Power with no combat effect, so the hero never changes a combat result.
const NEUTRAL_HERO = 'TB_BaconShop_HERO_16';
const KEYWORDS = new Set(['TAUNT', 'DIVINE_SHIELD', 'WINDFURY', 'REBORN', 'VENOMOUS', 'POISONOUS',
  'STEALTH', 'MAGNETIC', 'MEGA_WINDFURY', 'CLEAVE', 'IMMUNE', 'IMMUNE_ATTACKING']);

export class SceneError extends Error {}

function recruitGame(engine, seed) {
  const g = engine.newGame(seed, { record_log: false });
  const n = JSON.parse(g.stateJson()).players.length;
  for (let p = 0; p < n; p++) g.step(p, g.view(p).actions.CHOOSE);
  for (let p = 0; p < n; p++) {
    for (let i = 0; i < 4; i++) {  // choices some heroes open at the start (Finley, ...)
      const v = g.view(p);
      if (v.me.pending === null) break;
      g.step(p, v.actions.CHOOSE);
    }
  }
  return g;
}

function debug(g, cmd) {
  let out;
  try {
    out = g.debug(cmd);
  } catch (e) {
    throw new SceneError(`${cmd.cmd}: ${e.message}`);
  }
  if (out && typeof out === 'object' && !Array.isArray(out) && out.error) {
    throw new SceneError(`${cmd.cmd}: ${out.error}`);
  }
  return out;
}

function cardId(cardRef, kind = null) {
  try {
    return resolve(cardRef, kind).id;
  } catch {
    throw new SceneError(`TavernGym does not know card ${cardRef}`);
  }
}

function setupPlayer(g, p, side, notes) {
  const hero = side.hero;
  let heroSet = false;
  if (hero) {
    try {
      debug(g, { cmd: 'set_hero', p, hero: resolve(hero, 'hero').id });
      heroSet = true;
    } catch {
      notes.push({ code: 'unknown_hero', card: hero });
    }
  }
  if (!heroSet) debug(g, { cmd: 'set_hero', p, hero: NEUTRAL_HERO });

  for (const zone of ['board', 'hand']) debug(g, { cmd: 'clear_zone', p, zone });
  const fields = {};
  for (const k of ['tier', 'health', 'armor']) if (k in side) fields[k] = Math.trunc(side[k]);
  if (Object.keys(fields).length) debug(g, { cmd: 'set_player', p, ...fields });

  for (const t of side.trinkets || []) {
    try {
      debug(g, { cmd: 'give_trinket', p, card: cardId(t) });
    } catch (e) {
      if (!(e instanceof SceneError)) throw e;
      notes.push({ code: 'unknown_trinket', card: t });
    }
  }

  const board = side.board || [];
  if (board.length > 7) throw new SceneError('a warband holds at most 7 minions');
  board.forEach((m, i) => {
    const cid = cardId(m.card, 'minion');
    debug(g, { cmd: 'add_minion', p, zone: 'board', card: cid, golden: !!m.golden,
               atk: m.atk ?? null, hp: m.hp ?? null });
    if ('keywords' in m) {
      const bad = m.keywords.filter(k => !KEYWORDS.has(k));
      if (bad.length) throw new SceneError(`unknown keywords ${bad}`);
      debug(g, { cmd: 'edit_minion', p, zone: 'board', index: i, keywords: m.keywords });
    }
  });

  for (const h of side.hand || []) {
    let c = null;
    try { c = h.card ? resolve(h.card) : null; } catch { c = null; }
    if (!c) throw new SceneError(`TavernGym does not know card ${h.card}`);
    if (c.kind === 'minion') {
      debug(g, { cmd: 'add_minion', p, zone: 'hand', card: c.id, golden: !!h.golden,
                 atk: h.atk ?? null, hp: h.hp ?? null });
    } else {
      debug(g, { cmd: 'add_spell', p, zone: 'hand', card: c.id });
    }
  }
}

function calibrate(g, p, board, rounds = 3) {
  for (let r = 0; r < rounds; r++) {
    const shown = g.view(p).me.board;
    const stored = JSON.parse(g.stateJson()).players[p].board;
    let changed = false;
    const n = Math.min(board.length, shown.length, stored.length);
    for (let i = 0; i < n; i++) {
      const want = board[i], s = shown[i], st = stored[i];
      const da = (want.atk ?? s.atk) - s.atk;
      const dh = (want.hp ?? s.hp) - s.hp;
      if (da || dh) {
        debug(g, { cmd: 'edit_minion', p, zone: 'board', index: i,
                   atk: Math.max(0, st.atk + da), hp: Math.max(1, st.hp + dh) });
        changed = true;
      }
    }
    if (!changed) return;
  }
}

/** The scene in a TavernGym game; `notes` collects what could not be reproduced. */
export function build(engine, scene, notes = [], seed = 1) {
  const g = recruitGame(engine, seed);
  try {
    if ('turn' in scene) debug(g, { cmd: 'set_turn', turn: Math.trunc(scene.turn) });
    setupPlayer(g, ME, scene.me, notes);
    setupPlayer(g, OPP, scene.opponent, notes);
    debug(g, { cmd: 'set_player', p: ME, gold: 99 });  // recruit decisions should never lack Gold
    calibrate(g, ME, scene.me.board || []);
    calibrate(g, OPP, scene.opponent.board || []);
  } catch (e) {
    g.free();
    throw e;
  }
  return g;
}

export const boardNames = (g, p = ME) => g.view(p).me.board.map(m => nameOf(m.id));
