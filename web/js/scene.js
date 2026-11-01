// Build a TavernGym game that holds a given scene (my warband vs one opponent).
//
// Seat 0 is me, seat 1 the opponent. Notes are {code, card} (rendered by the page). `atk`/`hp` are the numbers shown in the game, auras
// included; TavernGym adds board auras itself, so after setup the stored stats are corrected
// until TavernGym shows the same numbers (otherwise an aura would count twice).

import { nameOf, resolve } from './cards.js';
import { parseState, dumpState } from './simcore.js';

export const ME = 0, OPP = 1;
// A. F. Kay: a Hero Power with no combat effect, so the hero never changes a combat result.
const NEUTRAL_HERO = 'TB_BaconShop_HERO_16';
const KEYWORDS = new Set(['TAUNT', 'DIVINE_SHIELD', 'WINDFURY', 'REBORN', 'VENOMOUS', 'POISONOUS',
  'STEALTH', 'MAGNETIC', 'MEGA_WINDFURY', 'CLEAVE', 'IMMUNE', 'IMMUNE_ATTACKING']);

export class SceneError extends Error {}

const A_PLAY = 46, N_POS = 8;

function recruitGame(engine, seed, lobby = null) {
  const cfg = { record_log: false };
  if (lobby && lobby.length) cfg.lobby_types = lobby.slice(0, 5);
  const g = engine.newGame(seed, cfg);
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
  const power = side.hero_power;
  if (heroSet && power) {
    const have = (g.view(p).me.hero_power || {}).id;
    if (have !== power) {
      try {
        debug(g, { cmd: 'set_hero_power', p, slot: 0, card: power });
      } catch (e) {
        if (!(e instanceof SceneError)) throw e;
        notes.push({ code: 'unknown_hero_power', card: power });
      }
    }
  }

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
  for (const r of side.rewards || []) {
    try {
      debug(g, { cmd: 'give_reward', p, card: r });
    } catch (e) {
      if (!(e instanceof SceneError)) throw e;
      notes.push({ code: 'unknown_reward', card: r });
    }
  }
  // Getting a trinket can trigger its "when you get this" effect again (Portable Factory
  // Discovers a minion): settle any choice it opens, then clear what it produced, so the
  // scene holds only the warband and hand from the log.
  settleChoices(g, p);
  for (const zone of ['board', 'hand']) debug(g, { cmd: 'clear_zone', p, zone });

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

  castWaiting(g, p, side.spells || [], notes);

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

/**
 * Cast again the spells that wait for this combat ("Start of Combat: ..."), so TavernGym holds
 * them too. What else casting does (buffs, cards) is undone: the board is calibrated to the
 * log's numbers afterwards and the hand is cleared.
 */
function castWaiting(g, p, spells, notes) {
  if (!spells.length) return;
  debug(g, { cmd: 'set_player', p, gold: 99 });
  for (const cid of spells) {
    if (cid.startsWith('TB_Bacon_Secrets_')) {
      try {
        debug(g, { cmd: 'add_secret', p, card: cid });
      } catch (e) {
        if (!(e instanceof SceneError)) throw e;
        notes.push({ code: 'unknown_secret', card: cid });
      }
      continue;
    }
    try {
      debug(g, { cmd: 'add_spell', p, zone: 'hand', card: cid });
    } catch (e) {
      if (!(e instanceof SceneError)) throw e;
      notes.push({ code: 'unknown_spell', card: cid });
      continue;
    }
    const hand = g.view(p).me.hand.length - 1;
    const action = A_PLAY + hand * N_POS;
    if (g.legalMask(p)[action] === '1') {
      g.step(p, action);
      settleChoices(g, p);
    } else {
      notes.push({ code: 'cannot_cast', card: cid });
    }
  }
  debug(g, { cmd: 'clear_zone', p, zone: 'hand' });
}

/** The players' "this game" numbers from the scene (not settable by a debug command). */
function setStats(engine, g, scene) {
  const sides = [[ME, scene.me.stats || {}], [OPP, scene.opponent.stats || {}]];
  if (!sides.some(([, st]) => Object.keys(st).length)) return g;
  const state = parseState(g.stateJson());
  for (const [p, st] of sides) {
    const stats = state.players[p].stats;
    for (const k of Object.keys(st).sort()) if (k in stats) stats[k] = Math.trunc(st[k]);
  }
  const g2 = engine.fromJson(dumpState(state));
  g.free();
  return g2;
}

/** Resolve pending choices of seat p (first option, else cancel). */
function settleChoices(g, p, limit = 8) {
  for (let i = 0; i < limit; i++) {
    const v = g.view(p);
    if (v.me.pending === null) return;
    const mask = g.legalMask(p);
    const a = [v.actions.CHOOSE, v.actions.CANCEL].find(x => mask[x] === '1');
    if (a === undefined) return;
    g.step(p, a);
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
  let g = recruitGame(engine, seed, scene.lobby);
  try {
    if ('turn' in scene) debug(g, { cmd: 'set_turn', turn: Math.trunc(scene.turn) });
    setupPlayer(g, ME, scene.me, notes);
    setupPlayer(g, OPP, scene.opponent, notes);
    g = setStats(engine, g, scene);
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
