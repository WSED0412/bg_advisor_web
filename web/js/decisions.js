// Score recruit decisions read from a log: targets, Magnetic placement and play order.
//
// Each decision is replayed from the board at the moment it was made: every alternative is
// applied to a copy, and the resulting warband fights the opponent that this round's combat
// actually met. Later actions of the same turn are not replayed.

import { ME, SceneError, build } from './scene.js';
import { card, hasCard, nameOf } from './cards.js';
import { combatScene, minionScene } from './bglog.js';
import { grade, isHopeless, rankKey, cmpKey, sortBest, sameOutcome } from './scoring.js';
import { A_MAGNETIZE, A_PLAY, N_BOARD, N_POS, StepError, applySteps } from './simcore.js';
import { permutations } from './positioning.js';

export const MAX_ORDER_CARDS = 5;
// Cards whose result is a card choice or new cards, not a change to the warband.
const NO_COMBAT_EFFECT_WORDS = ['Discover', 'Get a', 'Get an', 'Get two', 'Get 2', 'Get the'];

export class Skip extends Error {}

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
    if (p.kind !== 'HERO_POWER' && !hasCard(p.card)) throw new Skip(`TavernGym 不認得 ${p.card}`);
  }
  let g;
  try {
    g = build(engine, sceneFor(plays, combat), notes);
  } catch (e) {
    if (e instanceof SceneError) throw new Skip(e.message);
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

function finish(kind, rnd, title, labels, results, mineId, notes) {
  const ok = [...results].filter(([, v]) => typeof v !== 'string');
  if (!ok.some(([k]) => k === mineId)) {
    throw new Skip(`無法在模擬器重現你的選擇（${results.get(mineId)}）`);
  }
  if (ok.length < 2) throw new Skip('只有一個可行選項');
  const hopeless = isHopeless(ok.map(([, o]) => o));
  const opts = sortBest(ok.map(([k, o]) => ({ id: k, label: labels.get(k), outcome: o })), o => o.outcome, hopeless);
  const mine = opts.find(o => o.label === labels.get(mineId));
  const best = cmpKey(rankKey(mine.outcome, hopeless), rankKey(opts[0].outcome, hopeless)) === 0 ? mine : opts[0];
  const same = opts.every(o => sameOutcome(o.outcome, opts[0].outcome));
  const gr = same ? null : grade(mine.outcome, best.outcome, hopeless);
  return { kind, round: rnd, title, options: opts, mine, best, grade: gr, notes };
}

const minionLabel = (names, i) => `${names[i]}（位置 ${i + 1}）`;

// ---------------------------------------------------------------- targets

export async function scoreTarget(engine, sim, p, combat, n = 1000) {
  if (p.targetIndex === null) throw new Skip('沒有選擇友方目標');
  if (noCombatEffect(p.card)) throw new Skip(`${nameOf(p.card)} 的效果是拿牌，不影響這場戰鬥`);
  const notes = [];
  const { g, me, ent, hidOf } = setup(engine, [p], combat, notes);
  try {
    if (p.kind === 'HERO_POWER') {
      const hp = (me.hero_power || {}).id;
      if (hp !== p.card) throw new Skip(`模擬器中的英雄技能（${hp}）和實際的（${p.card}）不同`);
    }
    const hid = hidOf.get(p.seq) ?? null;
    const names = me.board.map(m => nameOf(m.id));
    const eids = me.board.map(m => m.eid);

    const probe = g.copy();
    let pending;
    try {
      applySteps(probe, playSteps(p, hid).slice(0, 1));
      pending = probe.view(ME).me.pending;
    } catch (e) {
      if (e instanceof StepError) throw new Skip(`模擬器裡無法打出：${e.message}`);
      throw e;
    } finally {
      probe.free();
    }
    if (!pending || pending.kind !== 'target') throw new Skip('模擬器裡這張牌不需要選目標');
    const legal = eids.map((e, i) => (pending.targets.includes(e) ? i : -1)).filter(i => i >= 0);
    if (legal.length < 2) throw new Skip('只有一個合法目標');
    if (!legal.includes(p.targetIndex)) throw new Skip('你選的目標在模擬器裡不合法');

    const jobs = legal.map(i => ({ id: String(i), steps: playSteps(p, hid, { target: eids[i], pos: p.position }) }));
    const results = await sim.run(g, jobs, n);
    const labels = new Map(legal.map(i => [String(i), minionLabel(names, i)]));
    return finish('target', p.round, `${nameOf(p.card)} 的目標`, labels, results, String(p.targetIndex), notes);
  } finally {
    g.free();
  }
}

// ---------------------------------------------------------------- Magnetic

export async function scoreMagnetize(engine, sim, p, combat, n = 1000) {
  if (p.kind !== 'MINION' || !isMagnetic(p.card)) throw new Skip('不是磁力隨從');
  const notes = [];
  const { g, me, hidOf } = setup(engine, [p], combat, notes);
  try {
    const hid = hidOf.get(p.seq);
    const names = me.board.map(m => nameOf(m.id));
    const eids = me.board.map(m => m.eid);
    const hand = me.hand.findIndex(h => h.hid === hid);
    const mask = g.legalMask(ME);

    const jobs = [], labels = new Map();
    const standalonePos = p.position !== null ? p.position : eids.length;
    if (eids.length < 7 && mask[A_PLAY + hand * N_POS + Math.min(standalonePos, eids.length)] === '1') {
      jobs.push({ id: 'alone', steps: [['play', hid, standalonePos]] });
      labels.set('alone', '單獨下場');
    }
    eids.forEach((e, i) => {
      if (mask[A_MAGNETIZE + hand * N_BOARD + i] === '1') {
        jobs.push({ id: String(i), steps: [['magnetize', hid, e]] });
        labels.set(String(i), '吸附到 ' + minionLabel(names, i));
      }
    });
    const mineId = p.magnetizedTo !== null ? String(p.magnetizedTo) : 'alone';
    const results = await sim.run(g, jobs, n);
    return finish('magnetize', p.round, `${nameOf(p.card)} 放哪裡`, labels, results, mineId, notes);
  } finally {
    g.free();
  }
}

// ---------------------------------------------------------------- play order

export async function scoreOrder(engine, sim, run, combat, n = 1000) {
  if (run.length < 2) throw new Skip('只有一張牌');
  if (run.length > MAX_ORDER_CARDS) throw new Skip(`超過 ${MAX_ORDER_CARDS} 張牌，排列太多`);
  if (run.some(p => p.kind === 'HERO_POWER')) throw new Skip('包含英雄技能');
  if (run.some(p => noCombatEffect(p.card))) throw new Skip('包含拿牌或發現的牌，順序的影響無法只靠戰鬥判斷');
  const notes = [];
  const { g, ent, hidOf } = setup(engine, run, combat, notes);
  try {
    const stepsFor = p => {
      let target = null, magnet = null;
      if (p.targetIndex !== null) {
        const e = p.boardBefore[p.targetIndex].entity;
        if (!ent.has(e)) throw new Skip('目標是同一輪中剛打出的隨從');
        target = ent.get(e);
      }
      if (p.magnetizedTo !== null) {
        const e = p.boardBefore[p.magnetizedTo].entity;
        if (!ent.has(e)) throw new Skip('磁力吸附到同一輪中剛打出的隨從');
        magnet = ent.get(e);
      }
      return playSteps(p, hidOf.get(p.seq) ?? null, { target, magnet });
    };
    const perPlay = new Map(run.map(p => [p.seq, stepsFor(p)]));
    // After the plays, arrange the warband as it was in the combat that followed.
    const final = combat.me.board.map(m => (ent.has(m.entity) ? ent.get(m.entity) : m.card));
    const jobs = [], labels = new Map();
    for (const perm of permutations(run.length)) {
      const id = perm.join(',');
      jobs.push({ id, steps: perm.flatMap(i => perPlay.get(run[i].seq)), final });
      labels.set(id, perm.map(i => nameOf(run[i].card)).join(' → '));
    }
    const results = await sim.run(g, jobs, n);
    const mineId = run.map((_, i) => i).join(',');
    return finish('order', run[0].round, '出牌順序', labels, results, mineId, notes);
  } finally {
    g.free();
  }
}
