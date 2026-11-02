// Post-game review: score every decision of a game read from Power.log.
//
// Per round: the combat result, the warband arrangement score, and the scores of the recruit
// decisions that change the combat (friendly targets, Magnetic placement, play order).
// The result has the same shape as the Python version (bg_advisor/review.py).

import { build, SceneError } from './scene.js';
import { nameOf } from './cards.js';
import { combatScene } from './bglog.js';
import { evaluateGame, distinct } from './positioning.js';
import { Skip, isMagnetic, scoreMagnetize, scoreOrder, scorePick, scoreTarget } from './decisions.js';
import { gameLuck } from './luck.js';
import { chanceOf, describeGrade, outcomeDict, pyRound } from './scoring.js';

export const PRECISION = {
  full: { pos: 2000, screen: 200, dec: 1000 },
  quick: { pos: 500, screen: 100, dec: 300 },
};

const firstSource = g => g.source.split(' + ')[0];
const folderOf = src => {
  const parts = src.split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2] : parts[0].replace(/\.[^.]*$/, '');
};

/** Stable id of a game: its start time (to 0.1 microsecond) and the player, so the same game
 *  gets the same id whether it was read from Logs or from the plugin's backup. */
export function gameKey(g) {
  return `${g.start}_${g.player}`.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '');
}

/** 'YYYY-MM-DD HH:MM' from the session folder name (Hearthstone_2026_10_20_02_12_05). */
export function gameDate(g, fallbackDay = '') {
  const m = /(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})/.exec(folderOf(firstSource(g)));
  const day = m ? `${m[1]}-${m[2]}-${m[3]}` : fallbackDay;
  return `${day} ${g.start.slice(0, 5)}`.trim();
}

const minions = side => side.board.map(m => ({
  card: m.card, name: nameOf(m.card), atk: m.atk, hp: m.hp, keywords: m.keywords, golden: m.card.endsWith('_G'),
}));

function describeChange(c) {
  const f = s => `${s[0]}/${s[1]}（${s[2]} 星）`;
  return `${nameOf(c.card)}：模擬器 ${f(c.engine)}，你的客戶端 ${f(c.client)}`;
}

/**
 * Review one game. `progress(done, total, round)` is called as rounds start.
 *
 * Report format 2 is language-neutral: cards are ids, skips and notes are codes, and the page
 * renders them in the chosen language. The Chinese text fields of format 1 are kept as well.
 */
export async function reviewGame(engine, sim, game, prec = PRECISION.full, progress = () => {}, fallbackDay = '') {
  const result = {
    key: gameKey(game), date: gameDate(game, fallbackDay), player: game.player, build: game.build,
    hero: game.hero, hero_name: nameOf(game.hero), place: game.place, complete: game.complete,
    source: game.source, rounds: [], card_changes: game.cardChanges.map(describeChange),
    format: 2, changes: game.cardChanges.map(c => ({ card: c.card, engine: c.engine, client: c.client })),
  };
  const changed = new Map(game.cardChanges.map(c => [c.card, c]));
  const rounds = [...new Set([...game.combats.map(c => c.round), ...game.plays.map(p => p.round)])].sort((a, b) => a - b);
  let done = 0;
  for (const rnd of rounds) {
    progress(done, rounds.length, rnd);
    const combat = game.combats.find(c => c.round === rnd);
    const rr = { round: rnd, decisions: [] };
    result.rounds.push(rr);
    done += 1;
    if (!combat) continue;
    Object.assign(rr, {
      opponent: combat.opp.name || '幽靈（已淘汰玩家）', ghost: !combat.opp.name, opp_hero: combat.opp.hero,
      opp_hero_name: nameOf(combat.opp.hero), result: combat.winner, damage: combat.damage,
      my_board: minions(combat.me), opp_board: minions(combat.opp),
      my_health: combat.me.health + combat.me.armor, my_tier: combat.me.tier, opp_tier: combat.opp.tier,
      notes: [], skipped: [],
    });
    const hit = [...new Set([...combat.me.board, ...combat.opp.board].map(m => m.card))]
      .filter(c => changed.has(c)).map(c => nameOf(c)).sort();
    if (hit.length) {
      rr.changed_cards = hit;
      rr.changed_ids = [...new Set([...combat.me.board, ...combat.opp.board].map(m => m.card))].filter(c => changed.has(c));
    }

    const pos = await reviewPositioning(engine, sim, combat, prec, rr);
    if (pos) {
      rr.positioning = {
        score: pos.grade.score, verdict: pos.grade.verdict, mode: pos.grade.mode, gap: pos.grade.gap,
        describe: describeGrade(pos.grade), mine: pos.mine.names, best: pos.best.names,
        mine_cards: pos.mine.cards, best_cards: pos.best.cards,
        mine_outcome: outcomeDict(pos.mine.outcome), best_outcome: outcomeDict(pos.best.outcome),
        arrangements: pos.arrangementsTotal,
        alternatives: distinct(pos, 4).map(([a, k]) => ({
          names: a.names, cards: a.cards, count: k, mine: a.order.join() === pos.mine.order.join(), outcome: outcomeDict(a.outcome),
        })),
      };
    }
    const plays = game.plays.filter(p => p.round === rnd);
    const picks = (game.picks || []).filter(k => k.round === rnd);
    const later = game.combats.filter(c => c.round >= rnd);
    for (const rep of await reviewDecisions(engine, sim, plays, combat, prec.dec, rr.skipped, picks, later)) {
      rr.decisions.push({
        kind: rep.kind, title: rep.title, card: rep.card || null, cards: rep.cards || null,
        gap: rep.grade ? rep.grade.gap : null, mode: rep.grade ? rep.grade.mode : null,
        score: rep.grade ? rep.grade.score : null,
        verdict: rep.grade ? rep.grade.verdict : '不影響這場戰鬥',
        describe: rep.grade ? describeGrade(rep.grade) : '',
        mine: rep.mine.label, best: rep.best.label,
        mine_outcome: outcomeDict(rep.mine.outcome), best_outcome: outcomeDict(rep.best.outcome),
        options: rep.options.slice(0, 6).map(o => ({ label: o.label, opt: o.opt, mine: o === rep.mine, outcome: outcomeDict(o.outcome) })),
        notes: rep.notes, ...(rep.span ? { span: rep.span } : {}),
      });
    }
  }
  progress(rounds.length, rounds.length, null);
  result.standings = game.standings || [];
  result.luck = await gameLuck(engine, sim, result, game.picks || [], game.combats, game.lobby || [],
                               Math.max(50, Math.floor(prec.dec / LUCK_SHARE)));
  summarize(result);
  return result;
}

async function reviewPositioning(engine, sim, combat, prec, rr) {
  if (!combat.me.board.length) { rr.positioning_skip = '你場上沒有隨從'; rr.pos_skip = { code: 'no_my_minions' }; return null; }
  if (!combat.opp.board.length) { rr.positioning_skip = '對手場上沒有隨從'; rr.pos_skip = { code: 'no_opp_minions' }; return null; }
  const notes = [];
  let g = null, rep;
  try {
    g = build(engine, combatScene(combat), notes);
    rep = await evaluateGame(sim, g, prec.pos, prec.screen);
  } catch (e) {
    if (!(e instanceof SceneError) && !(e instanceof Error)) throw e;
    rr.positioning_skip = `無法模擬（${e.message}）`;
    rr.pos_skip = { code: 'sim_failed', msg: e.message };
    return null;
  } finally {
    if (g) g.free();
  }
  rr.chance = chanceOf(rep.mine.outcome, combat.winner);
  rr.sim_outcome = outcomeDict(rep.mine.outcome);
  rr.notes.push(...notes);
  if (rep.arrangementsTotal === 1) {
    rr.positioning_skip = '只有一種排法，不評分';
    rr.pos_skip = { code: 'single_order' };
    return null;
  }
  return rep;
}

async function reviewDecisions(engine, sim, plays, combat, n, skipped, picks = [], later = []) {
  const reports = [];
  const tryScore = async (subject, fn) => {
    try {
      reports.push(await fn());
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      skipped.push({ ...subject, code: e.code, params: e.params });
    }
  };
  for (const p of plays) {
    if (p.targetIndex !== null) {
      await tryScore({ kind: 'target', card: p.card }, () => scoreTarget(engine, sim, p, combat, n));
    }
    if (p.kind === 'MINION' && isMagnetic(p.card)) {
      await tryScore({ kind: 'magnetize', card: p.card }, () => scoreMagnetize(engine, sim, p, combat, n));
    }
  }
  const runs = new Map();
  for (const p of plays) {
    if (p.kind === 'HERO_POWER') continue;
    if (!runs.has(p.run)) runs.set(p.run, []);
    runs.get(p.run).push(p);
  }
  for (const run of runs.values()) {
    if (run.length >= 2) {
      await tryScore({ kind: 'order', cards: run.map(p => p.card) }, () => scoreOrder(engine, sim, run, combat, n));
    }
  }
  // Picks: power in the combats that followed, shown for reference (not in averages).
  for (const k of picks) {
    await tryScore({ kind: k.kind, card: k.source || null }, () => scorePick(engine, sim, k, later, n));
  }
  return reports;
}

export const PICK_KINDS = ['buy', 'discover'];
// Discover luck fights every minion the Discover could offer: fewer combats each.
const LUCK_SHARE = 5;

// A common leveling pace: the Tavern tier most players have reached by a round. Being below
// it is not a mistake by itself; it is pointed out only in rounds that were lost.
const PACE = [[11, 6], [9, 5], [7, 4], [5, 3], [2, 2]];
export const typicalTier = rnd => (PACE.find(([r]) => rnd >= r) || [0, 1])[1];
const eqOf = o => (o ? o.win + 0.5 * o.tie : null);

/** The lost combats, most damage first, with what the simulation says about each. */
function losses(result) {
  const out = [];
  for (const r of result.rounds) {
    if (r.result !== 'opp') continue;
    const eq = eqOf(r.sim_outcome);
    const best = r.positioning ? eqOf(r.positioning.best_outcome) : eq;
    let cause;
    if (eq === null) cause = 'unknown';
    else if (best - eq >= 0.10) cause = 'positioning';
    else if (best < 0.30) cause = 'weak';
    else if (eq >= 0.50) cause = 'unlucky';
    else cause = 'close';
    const myTier = r.my_tier || 0;
    out.push({ round: r.round, damage: r.damage || 0, equity: eq, best_equity: best, cause,
               my_tier: myTier, opp_tier: r.opp_tier || 0, behind: !!myTier && myTier < typicalTier(r.round) });
  }
  return out.sort((a, b) => b.damage - a.damage || a.round - b.round);
}

const tempoOf = result => result.rounds.filter(r => r.my_tier).map(r => ({
  round: r.round, my_tier: r.my_tier, opp_tier: r.opp_tier || 0, typical: typicalTier(r.round),
  health: r.my_health ?? null, result: r.result, damage: r.damage || 0,
}));

function summarize(result) {
  const pos = result.rounds.filter(r => r.positioning).map(r => r.positioning.score);
  // Buys and Discovers are judged by this round's power only: shown, but not counted.
  const decs = result.rounds.flatMap(r => r.decisions).filter(d => d.score !== null && !PICK_KINDS.includes(d.kind));
  const misplays = [
    ...result.rounds.filter(r => r.positioning && r.positioning.verdict === '明顯失誤')
      .map(r => ({ round: r.round, what: '站位', kind: 'positioning', score: r.positioning.score })),
    ...result.rounds.flatMap(r => r.decisions.filter(d => d.verdict === '明顯失誤' && !PICK_KINDS.includes(d.kind))
      .map(d => ({ round: r.round, what: d.title, kind: d.kind, card: d.card, cards: d.cards, score: d.score }))),
  ];
  const avg = xs => pyRound(xs.reduce((a, b) => a + b, 0) / xs.length);
  const ls = losses(result);
  result.summary = {
    losses: ls.slice(0, 3), damage_taken: ls.reduce((a, x) => a + x.damage, 0), tempo: tempoOf(result),
    behind_rounds: ls.filter(x => x.behind).map(x => x.round).sort((a, b) => a - b),
    positioning_avg: pos.length ? avg(pos) : null, positioning_n: pos.length,
    decisions_avg: decs.length ? avg(decs.map(d => d.score)) : null, decisions_n: decs.length,
    misplays: misplays.sort((a, b) => a.round - b.round),
  };
}
