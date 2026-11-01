// Score recruit decisions read from a log: targets, Magnetic placement and play order.
//
// Each decision is replayed from the board at the moment it was made: every alternative is
// applied to a copy, and the resulting warband fights the opponent that this round's combat
// actually met. Later actions of the same turn are not replayed.
//
// Reports are language-neutral: a Skip carries a code and params, and every option an `opt`
// ({pos, card} | {alone} | {cards}) that the page turns into text in the chosen language.

import { ME, SceneError, build } from './scene.js';
import { card, hasCard, nameOf } from './cards.js';
import { combatScene, minionScene } from './bglog.js';
import { grade, isHopeless, rankKey, cmpKey, sortBest, sameOutcome } from './scoring.js';
import { A_MAGNETIZE, A_PLAY, N_BOARD, N_POS, StepError, applySteps } from './simcore.js';
import { permutations } from './positioning.js';

export const MAX_ORDER_CARDS = 5;
// Cards whose result is a card choice or new cards, not a change to the warband.
const NO_COMBAT_EFFECT_WORDS = ['Discover', 'Get a', 'Get an', 'Get two', 'Get 2', 'Get the'];

export class Skip extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

const textOf = cid => (card(cid) || {}).text || '';

export function noCombatEffect(cid) {
  return cid.startsWith('TB_BaconShop_Triples') || NO_COMBAT_EFFECT_WORDS.some(w => textOf(cid).includes(w));
}

export function isMagnetic(cid) {
  return textOf(cid).includes('Magnetic');
}

function sceneFor(plays, combat) {
  const s = combatScene(combat);
  s.me.board = plays[0].boardBefore.map(minionScene);
  s.me.hand = [];
  for (const p of plays) {
    if (p.kind === 'HERO_POWER') continue;
    const h = { card: p.card };
    if (p.kind === 'MINION') {
      h.atk = Math.max(0, p.handStats[0]);
      h.hp = Math.max(1, p.handStats[1]);
    }
    s.me.hand.push(h);
  }
  return s;
}

function setup(engine, plays, combat, notes) {
  for (const p of plays) {
    if (p.kind !== 'HERO_POWER' && !hasCard(p.card)) throw new Skip('unknown_card', { card: p.card });
  }
  let g;
  try {
    g = build(engine, sceneFor(plays, combat), notes);
  } catch (e) {
    if (e instanceof SceneError) throw new Skip('scene', { msg: e.message });
    throw e;
  }
  const me = g.view(ME).me;
  const boardEids = me.board.map(m => m.eid);
  const hids = me.hand.map(h => h.hid);
  // log entity of a minion on the board before the plays -> TavernGym eid
  const ent = new Map(plays[0].boardBefore.map((m, i) => [m.entity, boardEids[i]]));
  const hidOf = new Map();
  let k = 0;
  for (const p of plays) if (p.kind !== 'HERO_POWER') hidOf.set(p.seq, hids[k++]);
  return { g, me, ent, hidOf };
}

function playSteps(p, hid, { target = null, magnet = null, pos = null } = {}) {
  let steps;
  if (p.kind === 'HERO_POWER') steps = [['power', 0]];
  else if (magnet !== null) return [['magnetize', hid, magnet]];
  else steps = [['play', hid, pos]];
  if (target !== null) steps.push(['target', target]);
  return steps;
}

/**
 * @param labels Map id -> Chinese label (kept for older readers of the report)
 * @param opts   Map id -> structured option ({pos, card} | {alone: true} | {cards})
 */
function finish(kind, rnd, subject, labels, opts, results, mineId, notes) {
  const ok = [...results].filter(([, v]) => typeof v !== 'string');
  if (!ok.some(([k]) => k === mineId)) throw new Skip('cannot_reproduce', { msg: String(results.get(mineId)) });
  if (ok.length < 2) throw new Skip('one_option');
  const hopeless = isHopeless(ok.map(([, o]) => o));
  const options = sortBest(ok.map(([k, o]) => ({ id: k, label: labels.get(k), opt: opts.get(k), outcome: o })),
    o => o.outcome, hopeless);
  const mine = options.find(o => o.id === mineId);
  const best = cmpKey(rankKey(mine.outcome, hopeless), rankKey(options[0].outcome, hopeless)) === 0 ? mine : options[0];
  const same = options.every(o => sameOutcome(o.outcome, options[0].outcome));
  const gr = same ? null : grade(mine.outcome, best.outcome, hopeless);
  return { kind, round: rnd, ...subject, options, mine, best, grade: gr, notes };
}

const minionLabel = (names, i) => `${names[i]}（位置 ${i + 1}）`;

// ---------------------------------------------------------------- targets

export async function scoreTarget(engine, sim, p, combat, n = 1000) {
  if (p.targetIndex === null) throw new Skip('no_friendly_target');
  if (noCombatEffect(p.card)) throw new Skip('gets_cards', { card: p.card });
  const notes = [];
  const { g, me, ent, hidOf } = setup(engine, [p], combat, notes);
  try {
    if (p.kind === 'HERO_POWER') {
      const hp = (me.hero_power || {}).id;
      if (hp !== p.card) throw new Skip('hero_power_differs', { sim: hp, real: p.card });
    }
    const hid = hidOf.get(p.seq) ?? null;
    const names = me.board.map(m => nameOf(m.id));
    const ids = me.board.map(m => m.id);
    const eids = me.board.map(m => m.eid);

    const probe = g.copy();
    let pending;
    try {
      applySteps(probe, playSteps(p, hid).slice(0, 1), false);  // keep the target choice open
      pending = probe.view(ME).me.pending;
    } catch (e) {
      if (e instanceof StepError) throw new Skip('cannot_play', { msg: e.message });
      throw e;
    } finally {
      probe.free();
    }
    if (!pending || pending.kind !== 'target') throw new Skip('no_target_needed');
    const legal = eids.map((e, i) => (pending.targets.includes(e) ? i : -1)).filter(i => i >= 0);
    if (legal.length < 2) throw new Skip('one_target');
    if (!legal.includes(p.targetIndex)) throw new Skip('target_illegal');

    const jobs = legal.map(i => ({ id: String(i), steps: playSteps(p, hid, { target: eids[i], pos: p.position }) }));
    const results = await sim.run(g, jobs, n);
    const labels = new Map(legal.map(i => [String(i), minionLabel(names, i)]));
    const opts = new Map(legal.map(i => [String(i), { pos: i + 1, card: ids[i] }]));
    return finish('target', p.round, { title: `${nameOf(p.card)} 的目標`, card: p.card },
      labels, opts, results, String(p.targetIndex), notes);
  } finally {
    g.free();
  }
}

// ---------------------------------------------------------------- Magnetic

export async function scoreMagnetize(engine, sim, p, combat, n = 1000) {
  if (p.kind !== 'MINION' || !isMagnetic(p.card)) throw new Skip('not_magnetic');
  const notes = [];
  const { g, me, hidOf } = setup(engine, [p], combat, notes);
  try {
    const hid = hidOf.get(p.seq);
    const names = me.board.map(m => nameOf(m.id));
    const ids = me.board.map(m => m.id);
    const eids = me.board.map(m => m.eid);
    const hand = me.hand.findIndex(h => h.hid === hid);
    const mask = g.legalMask(ME);

    const jobs = [], labels = new Map(), opts = new Map();
    const standalonePos = p.position !== null ? p.position : eids.length;
    if (eids.length < 7 && mask[A_PLAY + hand * N_POS + Math.min(standalonePos, eids.length)] === '1') {
      jobs.push({ id: 'alone', steps: [['play', hid, standalonePos]] });
      labels.set('alone', '單獨下場');
      opts.set('alone', { alone: true });
    }
    eids.forEach((e, i) => {
      if (mask[A_MAGNETIZE + hand * N_BOARD + i] === '1') {
        jobs.push({ id: String(i), steps: [['magnetize', hid, e]] });
        labels.set(String(i), '吸附到 ' + minionLabel(names, i));
        opts.set(String(i), { pos: i + 1, card: ids[i] });
      }
    });
    const mineId = p.magnetizedTo !== null ? String(p.magnetizedTo) : 'alone';
    const results = await sim.run(g, jobs, n);
    return finish('magnetize', p.round, { title: `${nameOf(p.card)} 放哪裡`, card: p.card },
      labels, opts, results, mineId, notes);
  } finally {
    g.free();
  }
}

// ---------------------------------------------------------------- play order

export async function scoreOrder(engine, sim, run, combat, n = 1000) {
  if (run.length < 2) throw new Skip('one_card');
  if (run.length > MAX_ORDER_CARDS) throw new Skip('too_many', { n: MAX_ORDER_CARDS });
  if (run.some(p => p.kind === 'HERO_POWER')) throw new Skip('has_hero_power');
  if (run.some(p => noCombatEffect(p.card))) throw new Skip('has_discover');
  const notes = [];
  const { g, ent, hidOf } = setup(engine, run, combat, notes);
  try {
    const stepsFor = p => {
      let target = null, magnet = null;
      if (p.targetIndex !== null) {
        const e = p.boardBefore[p.targetIndex].entity;
        if (!ent.has(e)) throw new Skip('target_new_minion');
        target = ent.get(e);
      }
      if (p.magnetizedTo !== null) {
        const e = p.boardBefore[p.magnetizedTo].entity;
        if (!ent.has(e)) throw new Skip('magnet_new_minion');
        magnet = ent.get(e);
      }
      return playSteps(p, hidOf.get(p.seq) ?? null, { target, magnet });
    };
    const perPlay = new Map(run.map(p => [p.seq, stepsFor(p)]));
    // After the plays, arrange the warband as it was in the combat that followed.
    const final = combat.me.board.map(m => (ent.has(m.entity) ? ent.get(m.entity) : m.card));
    const jobs = [], labels = new Map(), opts = new Map();
    for (const perm of permutations(run.length)) {
      const id = perm.join(',');
      jobs.push({ id, steps: perm.flatMap(i => perPlay.get(run[i].seq)), final });
      labels.set(id, perm.map(i => nameOf(run[i].card)).join(' → '));
      opts.set(id, { cards: perm.map(i => run[i].card) });
    }
    const results = await sim.run(g, jobs, n);
    const mineId = run.map((_, i) => i).join(',');
    return finish('order', run[0].round, { title: '出牌順序', cards: run.map(p => p.card) },
      labels, opts, results, mineId, notes);
  } finally {
    g.free();
  }
}
