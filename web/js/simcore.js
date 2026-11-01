// Running one simulation job against a base state (used inside the simulation workers).
//
// A job changes the scene and then fights my warband (seat 0) against the opponent's (seat 1)
// `n` times with TavernGym's combat preview:
//
//   {id, order: [2, 0, 1]}          rearrange my warband
//   {id, steps: [...], final: [...]} play recruit actions, then arrange
//
// Steps: ["play", hid, pos] (pos null: rightmost), ["magnetize", hid, eid], ["target", eid],
// ["power", slot], ["discover", [{card, atk, hp, kind}...]] (resolve the Discovers the previous
// play opened with the cards really taken: the option with that card if offered, else the
// first option swapped for that card). `final` lists minion eids/card ids giving my warband's
// order afterwards.
// Every job sees the same random seeds, so variants differ only by what the job changes.
// Recruit actions can be random too ("a random friendly minion gets +2/+2"): a job with steps
// is replayed under rerolls(n) recruit seeds, each followed by its share of the combats.

export const ME = 0, OPP = 1;
export const A_HERO_POWER = 4, A_CHOOSE = 30, A_PLAY = 46, A_MAGNETIZE = 126;
export const N_POS = 8, N_BOARD = 7;

export class StepError extends Error {}

// Game states hold u64 numbers (card-table fingerprint, RNG state) beyond JS number precision.
// While a state is a JS object, every integer of 16+ digits is kept as a tagged string.
const TAG = '@@u64:';

function quoteBig(json) {
  let out = '', last = 0, i = 0;
  const n = json.length;
  while (i < n) {
    const c = json.charCodeAt(i);
    if (c === 34) {  // a string: skip it, honouring escapes
      i++;
      while (i < n) {
        const d = json.charCodeAt(i);
        if (d === 92) i += 2;
        else if (d === 34) { i++; break; }
        else i++;
      }
    } else if (c === 45 || (c >= 48 && c <= 57)) {  // a number
      const s = i;
      i++;
      while (i < n) {
        const d = json.charCodeAt(i);
        if ((d >= 48 && d <= 57) || d === 46 || d === 101 || d === 69 || d === 43 || d === 45) i++;
        else break;
      }
      const tok = json.slice(s, i);
      if (/^-?\d{16,}$/.test(tok)) {
        out += json.slice(last, s) + `"${TAG}${tok}"`;
        last = i;
      }
    } else {
      i++;
    }
  }
  return out + json.slice(last);
}

const BIG_OUT = /"@@u64:(-?\d+)"/g;
export const parseState = json => JSON.parse(quoteBig(json));
export const dumpState = obj => JSON.stringify(obj).replace(BIG_OUT, '$1');

const meView = g => g.view(ME).me;

function step(g, action) {
  if (g.legalMask(ME)[action] !== '1') throw new StepError(`illegal action ${action}`);
  g.step(ME, action);
}

function handIndex(me, hid) {
  const i = me.hand.findIndex(h => h.hid === hid);
  if (i < 0) throw new StepError(`hand card ${hid} is gone`);
  return i;
}

function boardIndex(me, eid) {
  const i = me.board.findIndex(m => m.eid === eid);
  if (i < 0) throw new StepError(`minion ${eid} is not on the board`);
  return i;
}

function debugCmd(g, cmd) {
  const out = g.debug(cmd);
  if (out && typeof out === 'object' && out.error) throw new StepError(`${cmd.cmd}: ${out.error}`);
}

/** Take the cards the player really took from the Discovers left open. */
function discover(g, wanted) {
  for (const w of wanted) {
    const me = meView(g);
    const pending = me.pending;
    if (!pending || pending.kind !== 'discover') return;
    const ids = pending.options.map(o => o.id);
    if (ids.includes(w.card)) {
      step(g, A_CHOOSE + ids.indexOf(w.card));
      continue;
    }
    const before = new Set(me.hand.map(h => h.hid));
    step(g, A_CHOOSE);
    const hand = meView(g).hand;
    const fresh = hand.findIndex(h => !before.has(h.hid));
    if (fresh < 0) continue;  // the card went elsewhere (straight to the board...): leave it
    if (!w.kind) continue;    // unknown to the simulator, or not a hand card: keep its pick
    debugCmd(g, { cmd: 'remove', p: ME, zone: 'hand', index: fresh });
    if (w.kind === 'minion') {
      const extra = {};
      for (const k of ['atk', 'hp']) if (w[k] !== null && w[k] !== undefined) extra[k] = w[k];
      debugCmd(g, { cmd: 'add_minion', p: ME, zone: 'hand', card: w.card, ...extra });
    } else {
      debugCmd(g, { cmd: 'add_spell', p: ME, zone: 'hand', card: w.card });
    }
  }
}

/** Take the first option of choices left open (a Discover), so play can go on. */
function settleOpen(g, limit = 4) {
  for (let i = 0; i < limit; i++) {
    if (!meView(g).pending) return;
    step(g, A_CHOOSE);
  }
}

export function applySteps(g, steps, settle = true) {
  for (const st of steps) {
    if (st[0] !== 'target' && st[0] !== 'discover') settleOpen(g);  // a Discover opened by the previous card would block this one
    const me = meView(g);
    const kind = st[0];
    if (kind === 'play') {
      const hand = handIndex(me, st[1]);
      let pos = st[2] === null || st[2] === undefined ? me.board.length : Math.min(st[2], me.board.length);
      if (!('eid' in me.hand[hand])) pos = 0;  // spells (minions in hand carry an eid)
      step(g, A_PLAY + hand * N_POS + pos);
    } else if (kind === 'magnetize') {
      const hand = handIndex(me, st[1]);
      step(g, A_MAGNETIZE + hand * N_BOARD + boardIndex(me, st[2]));
    } else if (kind === 'target') {
      const pending = me.pending;
      if (!pending || pending.kind !== 'target' || !pending.targets.includes(st[1])) {
        throw new StepError('target not offered');
      }
      step(g, A_CHOOSE + pending.targets.indexOf(st[1]));
    } else if (kind === 'power') {
      step(g, A_HERO_POWER + st[1]);
    } else if (kind === 'discover') {
      discover(g, st[1]);
    } else {
      throw new StepError(`unknown step ${kind}`);
    }
  }
  // A choice left open (Discover...) would block combat: take the first option.
  if (settle) settleOpen(g);
}

/** Arrange my warband by `final` (eids or card ids); unmatched minions keep their order. */
export function reorder(state, final) {
  const board = state.players[ME].board;
  const rest = board.map((_, i) => i);
  const order = [];
  for (const key of final) {
    for (let k = 0; k < rest.length; k++) {
      const m = board[rest[k]];
      if (m.eid === key || m._id === key) {
        order.push(rest[k]);
        rest.splice(k, 1);
        break;
      }
    }
  }
  order.push(...rest);
  const players = [...state.players];
  players[ME] = { ...players[ME], board: order.map(i => board[i]) };
  return { ...state, players };
}

export function previewOf(g, n) {
  return preview(g, n);
}

function preview(g, n) {
  return g.debug({ cmd: 'combat_preview', a: ME, b: OPP, n });
}

const M64 = (1n << 64n) - 1n;
const GOLDEN = 0x9E3779B97F4A7C15n;
export const REROLL_COMBATS = 50;  // combats per recruit seed
export const MAX_REROLLS = 20;

/** How many recruit seeds a job with steps is replayed under (n combats in all). */
export function rerolls(n) {
  return Math.max(1, Math.min(MAX_REROLLS, Math.floor(n / REROLL_COMBATS)));
}

const big = v => BigInt(typeof v === 'string' && v.startsWith(TAG) ? v.slice(TAG.length) : v);
const tagged = b => `${TAG}${b}`;

function splitmix(x) {
  x = (x + GOLDEN) & M64;
  let z = x;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
  return [x, z ^ (z >> 31n)];
}

/** The state with recruit seed k: TavernGym's Rng::new(seed) for a seed derived from k. */
export function reseed(state, k) {
  const seed = (big(state.seed) ^ ((GOLDEN * BigInt(k + 1)) & M64)) & M64;
  let x = seed;
  const s = [];
  for (let i = 0; i < 4; i++) {
    let z;
    [x, z] = splitmix(x);
    s.push(tagged(z));
  }
  return { ...state, seed: tagged(seed), rng: { s } };
}

/** One combat_preview result from several (counts and damage totals add up). */
export function merge(results) {
  let n = 0, wa = 0, wb = 0, tie = 0, da = 0, db = 0;
  for (const r of results) n += Math.trunc(r.n);
  for (const r of results) wa += Math.round(r.win_a * r.n);
  for (const r of results) wb += Math.round(r.win_b * r.n);
  for (const r of results) tie += Math.round(r.tie * r.n);
  for (const r of results) da += Math.round(r.avg_damage_by_a * Math.round(r.win_a * r.n));
  for (const r of results) db += Math.round(r.avg_damage_by_b * Math.round(r.win_b * r.n));
  return { n, win_a: wa / n, win_b: wb / n, tie: tie / n,
           avg_damage_by_a: wa ? da / wa : 0, avg_damage_by_b: wb ? db / wb : 0 };
}

export function runJob(engine, base, baseJson, job, n) {
  if (job.order) {
    const keys = job.order.map(i => base.players[ME].board[i].eid);
    const g = engine.fromJson(dumpState(reorder(base, keys)));
    try {
      return preview(g, n);
    } finally {
      g.free();
    }
  }
  const k = rerolls(n);
  const parts = [];
  for (let i = 0; i < k; i++) parts.push(runSteps(engine, dumpState(reseed(base, i)), job, Math.floor(n / k)));
  return merge(parts);
}

function runSteps(engine, baseJson, job, n) {
  let g = engine.fromJson(baseJson);
  try {
    applySteps(g, job.steps || []);
    if (job.final && job.final.length) {
      const st = parseState(g.stateJson());
      const ids = new Map(meView(g).board.map(m => [m.eid, m.id]));
      for (const m of st.players[ME].board) m._id = ids.get(m.eid);
      const st2 = reorder(st, job.final);
      for (const m of st2.players[ME].board) delete m._id;
      g.free();
      g = engine.fromJson(dumpState(st2));
    }
  } catch (e) {
    g.free();
    throw e;
  }
  try {
    return preview(g, n);
  } finally {
    g.free();
  }
}
