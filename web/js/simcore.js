// Running one simulation job against a base state (used inside the simulation workers).
//
// A job changes the scene and then fights my warband (seat 0) against the opponent's (seat 1)
// `n` times with TavernGym's combat preview:
//
//   {id, order: [2, 0, 1]}          rearrange my warband
//   {id, steps: [...], final: [...]} play recruit actions, then arrange
//
// Steps: ["play", hid, pos] (pos null: rightmost), ["magnetize", hid, eid], ["target", eid],
// ["power", slot]. `final` lists minion eids/card ids giving my warband's order afterwards.
// Every job sees the same random seeds, so variants differ only by what the job changes.

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

/** Take the first option of choices left open (a Discover), so play can go on. */
function settleOpen(g, limit = 4) {
  for (let i = 0; i < limit; i++) {
    if (!meView(g).pending) return;
    step(g, A_CHOOSE);
  }
}

export function applySteps(g, steps, settle = true) {
  for (const st of steps) {
    if (st[0] !== 'target') settleOpen(g);  // a Discover opened by the previous card would block this one
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

function preview(g, n) {
  return g.debug({ cmd: 'combat_preview', a: ME, b: OPP, n });
}

export function runJob(engine, base, baseJson, job, n) {
  let g;
  if (job.order) {
    const keys = job.order.map(i => base.players[ME].board[i].eid);
    g = engine.fromJson(dumpState(reorder(base, keys)));
  } else {
    g = engine.fromJson(baseJson);
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
  }
  try {
    return preview(g, n);
  } finally {
    g.free();
  }
}
