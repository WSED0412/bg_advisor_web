// How lucky a game was: things the player did not choose, measured against what was expected
// (same as bg_advisor/luck.py).
//
// - Combats: the simulated chance to win with the warband really used, against the real result.
// - Discovers: the options offered, against every set of options the Discover could have
//   offered. Each minion that could appear is put in the slot of the minion really taken, in
//   its first fight (with the stats that minion had gained by then), and the fight is
//   simulated. The offered set is then ranked among all sets of three by its best option.
//
// Luck is shown apart from the decision scores and never counts towards them.

import { build, SceneError } from './scene.js';
import { allCards, card, nameOf } from './cards.js';
import { combatScene } from './bglog.js';
import { pickSpans } from './decisions.js';
import { equity } from './scoring.js';

// Cards that Discover only one minion type, by the words of their text.
const TYPE_WORDS = [['Beast', 'BEAST'], ['Demon', 'DEMON'], ['Dragon', 'DRAGON'], ['Elemental', 'ELEMENTAL'],
  ['Mech', 'MECHANICAL'], ['Murloc', 'MURLOC'], ['Naga', 'NAGA'], ['Pirate', 'PIRATE'],
  ['Quilboar', 'QUILBOAR'], ['Undead', 'UNDEAD']];
const FLAT = 0.02;  // options closer than this make the Discover not matter for the fight

const resultScore = w => ({ me: 1.0, tie: 0.5, opp: 0.0 })[w];
const stripGolden = id => (id.endsWith('_G') ? id.slice(0, -2) : id);
const isPoolMinion = c => c && c.kind === 'minion' && c.in_pool;

function comb(n, k) {
  if (k < 0 || n < k) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/** Expected against real wins and damage taken, over the rounds that were simulated. */
export function combatLuck(rounds) {
  const rows = [];
  for (const r of rounds) {
    const o = r.sim_outcome, real = resultScore(r.result);
    if (!o || real === undefined) continue;
    const eq = o.win + 0.5 * o.tie;
    rows.push({ round: r.round, equity: eq, real, luck: real - eq,
                exp_taken: o.loss * o.dmg_taken, taken: r.result === 'opp' ? (r.damage || 0) : 0 });
  }
  const sum = k => rows.reduce((a, x) => a + x[k], 0);
  return { rounds: rows, expected_wins: sum('equity'), wins: sum('real'),
           expected_taken: sum('exp_taken'), taken: sum('taken') };
}

/** The minions the Discover could have offered, or null if that cannot be told. */
export function discoverPool(pick, lobby) {
  const offered = pick.options.map(o => card(stripGolden(o.card)));
  if (offered.some(c => !isPoolMinion(c))) return null;  // not plain Tavern minions
  let tiers = new Set(offered.map(c => c.tier));
  if (tiers.size > 1) {  // not a one-tier Discover: anything up to the highest tier offered
    const top = Math.max(...tiers);
    tiers = new Set(Array.from({ length: top }, (_, i) => i + 1));
  }
  let types = new Set(lobby);
  const src = pick.source ? ((card(pick.source) || {}).text || '') : '';
  const only = new Set(TYPE_WORDS.filter(([w]) => src.includes(w)).map(([, t]) => t));
  if (only.size === 1) types = only;
  const pool = [];
  for (const c of allCards()) {
    if (!isPoolMinion(c) || !tiers.has(c.tier) || c.reachable === false) continue;
    const races = c.races || [];
    const hit = races.some(r => types.has(r));
    if (races.length && !races.includes('ALL') && !hit) continue;
    if (only.size === 1 && !(hit || races.includes('ALL'))) continue;
    pool.push(c.id);
  }
  for (const c of offered) if (!pool.includes(c.id)) pool.push(c.id);  // whatever was offered was possible
  pool.sort();
  return pool.length >= 3 ? pool : null;
}

/** [share of all sets of three whose best option is worse, expected best of a set]. */
export function rankTriples(values, offered) {
  const vs = [...values.values()].sort((a, b) => a - b);
  const n = vs.length, total = comb(n, 3);
  const best = Math.max(...offered.map(c => values.get(c)));
  const below = vs.filter(v => v < best - 1e-9).length;
  const equal = vs.filter(v => Math.abs(v - best) <= 1e-9).length;
  const worse = comb(below, 3) + 0.5 * (comb(below + equal, 3) - comb(below, 3));
  let expected = 0;
  vs.forEach((v, i) => { expected += v * comb(i, 2); });
  return [worse / total, expected / total];
}

/** How good the offered options were among all the Discover could offer (null: unknown). */
export async function discoverLuck(engine, sim, pick, combats, lobby, n = 200) {
  const pool = discoverPool(pick, lobby);
  if (!pool) return null;
  const spans = pickSpans(pick, combats);
  if (!spans.length) return null;
  const [combat, slot] = spans[0];
  const chosen = pick.options.find(o => o.entity === pick.chosen);
  const onBoard = combat.me.board[slot];
  // Stats gained after the pick, on top of the card's own (Tavern buffs and keywords gained
  // are not counted: every option is compared by its card alone).
  const dAtk = onBoard.atk - chosen.atk, dHp = onBoard.hp - chosen.hp;
  const states = new Map();
  for (const id of pool) {
    const c = card(id);
    const sc = combatScene(combat);
    sc.me.board[slot] = { card: id, atk: Math.max(0, c.atk + dAtk), hp: Math.max(1, c.hp + dHp) };
    let g;
    try {
      g = build(engine, sc, []);
    } catch (e) {
      if (!(e instanceof SceneError)) throw e;
      continue;
    }
    try {
      states.set(id, g.stateJson());
    } finally {
      g.free();
    }
  }
  const res = await sim.runStates(states, n);
  const values = new Map();
  for (const id of pool) {  // in pool order, so ties always rank the same way
    const r = res.get(id);
    if (r !== undefined && typeof r !== 'string') values.set(id, equity(r));
  }
  const offered = pick.options.map(o => stripGolden(o.card));
  if (values.size < 3 || offered.some(c => !values.has(c))) return null;
  const vals = [...values.values()];
  const flat = Math.max(...vals) - Math.min(...vals) < FLAT;
  const [pct, expected] = rankTriples(values, offered);
  const bestCard = offered.reduce((a, c) => (values.get(c) > values.get(a) ? c : a));
  const top = [...values.keys()].sort((a, b) => values.get(b) - values.get(a)).slice(0, 3);
  return {
    round: pick.round, source: pick.source, source_name: pick.source ? nameOf(pick.source) : '', fight: combat.round,
    offered: offered.map(c => ({ card: c, name: nameOf(c), equity: values.get(c) })),
    taken: stripGolden(chosen.card), best_offered: bestCard, best_equity: values.get(bestCard),
    expected_best: expected, percentile: pct, pool_size: values.size, flat,
    pool_top: top.map(c => ({ card: c, name: nameOf(c), equity: values.get(c) })),
  };
}

/** good / bad / even, from the combats and the Discovers that mattered. */
export function verdict(combat, discovers) {
  let score = 0;
  const diff = combat.wins - combat.expected_wins;
  score += diff >= 1 ? 1 : diff <= -1 ? -1 : 0;
  const counted = discovers.filter(d => !d.flat).map(d => d.percentile);
  if (counted.length) {
    const avg = counted.reduce((a, b) => a + b, 0) / counted.length;
    score += avg >= 0.65 ? 1 : avg <= 0.35 ? -1 : 0;
  }
  return score > 0 ? 'good' : score < 0 ? 'bad' : 'even';
}

export async function gameLuck(engine, sim, result, picks, combats, lobby, n) {
  const combat = combatLuck(result.rounds);
  const discovers = [];
  for (const p of picks) {
    if (p.kind !== 'discover') continue;
    const d = await discoverLuck(engine, sim, p, combats, lobby, n);
    if (d) discovers.push(d);
  }
  const counted = discovers.filter(d => !d.flat).map(d => d.percentile);
  return { combat, discovers,
           discover_avg: counted.length ? counted.reduce((a, b) => a + b, 0) / counted.length : null,
           verdict: verdict(combat, discovers) };
}
