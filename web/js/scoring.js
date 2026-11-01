// Shared outcome type and grading for every decision kind (positioning, targets, order).
//
// A decision is graded against the best alternative by win equity (a tie counts half). When
// even the best alternative rarely wins, what the choice still changes is the hero damage, so
// the grade switches to expected net damage.

export const HOPELESS_EQUITY = 0.05;

/** Outcome from a combat_preview result. */
export function outcomeOf(r) {
  return { n: Math.round(r.n), win: r.win_a, tie: r.tie, loss: r.win_b,
           dmg_dealt: r.avg_damage_by_a, dmg_taken: r.avg_damage_by_b };
}

export const equity = o => o.win + 0.5 * o.tie;
export const netDamage = o => o.win * o.dmg_dealt - o.loss * o.dmg_taken;
export const sameOutcome = (a, b) =>
  a.win === b.win && a.tie === b.tie && a.loss === b.loss && a.dmg_dealt === b.dmg_dealt && a.dmg_taken === b.dmg_taken;

export const isHopeless = outcomes => Math.max(...outcomes.map(equity)) < HOPELESS_EQUITY;

const r6 = x => Math.round(x * 1e6) / 1e6;

export function rankKey(o, hopeless) {
  return hopeless ? [r6(netDamage(o)), equity(o)] : [r6(equity(o)), netDamage(o)];
}

export function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Stable sort, best first (like Python's sorted(key, reverse=True)). */
export function sortBest(items, outcome, hopeless) {
  return items
    .map((it, i) => ({ it, k: rankKey(outcome(it), hopeless), i }))
    .sort((a, b) => cmpKey(b.k, a.k) || a.i - b.i)
    .map(x => x.it);
}

export const verdict = score => (score >= 91 ? '最佳或接近最佳' : score >= 70 ? '還可以更好' : '明顯失誤');

// Python's round(): halves to even.
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

/** Win mode: -3 per win-rate point given up. Damage mode: -10 per hero damage point. */
export function grade(mine, best, hopeless) {
  if (hopeless) {
    const gap = Math.max(0, netDamage(best) - netDamage(mine));
    const score = pyRound(Math.max(0, 100 - 10 * gap));
    return { score, verdict: verdict(score), gap, mode: 'damage' };
  }
  const gap = Math.max(0, 100 * (equity(best) - equity(mine)));
  const score = pyRound(Math.max(0, 100 - 3 * gap));
  return { score, verdict: verdict(score), gap, mode: 'win' };
}

export function describeGrade(g) {
  if (g.mode === 'damage') {
    return `${g.score} / 100（${g.verdict}；怎麼做都很難贏，比最佳多受 ${g.gap.toFixed(1)} 點傷害）`;
  }
  return `${g.score} / 100（${g.verdict}，比最佳少 ${g.gap.toFixed(1)} 個百分點）`;
}

/** How likely the simulation found the result that actually happened. */
export function chanceOf(o, winner) {
  return { me: o.win, opp: o.loss, tie: o.tie }[winner] ?? null;
}

/** The outcome as stored in a report (with derived numbers). */
export const outcomeDict = o => ({ ...o, equity: equity(o), net_damage: netDamage(o) });
