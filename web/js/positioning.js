// Score a warband arrangement: how does my order compare with the best order?
//
// Every arrangement of my minions fights the opponent's warband; all see the same random
// seeds. A quick screen of every arrangement keeps the best candidates, which are then
// measured again with many more combats.

import { ME, boardNames } from './scene.js';
import { grade, isHopeless, rankKey, cmpKey, sortBest, sameOutcome } from './scoring.js';

/** itertools.permutations(range(n)) in the same (lexicographic) order. */
export function* permutations(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  function* rec(k) {
    if (k === n) { yield a.slice(); return; }
    for (let i = k; i < n; i++) {
      // Lexicographic order: rotate a[i] into place k instead of swapping.
      const v = a[i];
      a.splice(i, 1);
      a.splice(k, 0, v);
      yield* rec(k + 1);
      a.splice(k, 1);
      a.splice(i, 0, v);
    }
  }
  yield* rec(0);
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** All orders, skipping ones that only swap identical minions. */
function uniqueOrders(board) {
  const sigs = board.map(m => {
    const { eid, ...rest } = m;
    return canonical(rest);
  });
  const seen = new Set();
  const out = [];
  for (const order of permutations(board.length)) {
    const key = order.map(i => sigs[i]).join('\u0001');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(order);
    }
  }
  return out;
}

const keyOf = o => o.join(',');

export async function evaluateGame(sim, game, nFinal = 2000, nScreen = 200, keep = 24) {
  const t0 = performance.now();
  const names = boardNames(game);
  const stateJson = game.stateJson();
  const board = JSON.parse(stateJson).players[ME].board;
  if (!board.length) throw new Error('my warband is empty');

  const mineOrder = board.map((_, i) => i);
  const orders = uniqueOrders(board);
  const jobs = os => os.map(o => ({ id: keyOf(o), order: o }));

  let finalists;
  if (orders.length * nFinal <= 400000) {
    finalists = orders;
  } else {
    const screened = await sim.run(stateJson, jobs(orders), nScreen);
    const hopeless = isHopeless([...screened.values()].filter(o => typeof o !== 'string'));
    finalists = sortBest(orders.filter(o => typeof screened.get(keyOf(o)) !== 'string'),
      o => screened.get(keyOf(o)), hopeless).slice(0, keep);
    if (!finalists.some(o => keyOf(o) === keyOf(mineOrder))) finalists.push(mineOrder);
  }
  const final = await sim.run(stateJson, jobs(finalists), nFinal);
  const ok = finalists.filter(o => typeof final.get(keyOf(o)) !== 'string');
  if (!ok.some(o => keyOf(o) === keyOf(mineOrder))) {
    throw new Error(`無法模擬你的站位（${final.get(keyOf(mineOrder))}）`);
  }
  const hopeless = isHopeless(ok.map(o => final.get(keyOf(o))));
  const arrs = sortBest(ok.map(o => ({ order: o, names: o.map(i => names[i]), outcome: final.get(keyOf(o)) })),
    a => a.outcome, hopeless);
  const mine = arrs.find(a => keyOf(a.order) === keyOf(mineOrder));
  const best = cmpKey(rankKey(mine.outcome, hopeless), rankKey(arrs[0].outcome, hopeless)) === 0 ? mine : arrs[0];
  return { mine, best, ranked: arrs, grade: grade(mine.outcome, best.outcome, hopeless), hopeless,
           arrangementsTotal: orders.length, seconds: (performance.now() - t0) / 1000 };
}

/** Best k distinct results, each with how many arrangements share it. */
export function distinct(rep, k = 5) {
  const groups = [];
  for (const a of rep.ranked) {
    const grp = groups.find(g => sameOutcome(g[0].outcome, a.outcome));
    if (grp) grp.push(a);
    else groups.push([a]);
  }
  return groups.slice(0, k).map(grp => {
    const r = grp.find(a => keyOf(a.order) === keyOf(rep.mine.order)) || grp[0];
    return [r, grp.length];
  });
}
