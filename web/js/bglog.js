// Battlegrounds facts from a Power.log: each combat's warbands, the recruit decisions,
// placement and whether the game ended.
//
// - two Player entities: the local player and a dummy (BACON_DUMMY_PLAYER) that is Bartender
//   Bob during recruit and each combat opponent during combat (it is renamed each time);
// - GameEntity TURN is odd in the recruit phase and even in combat;
// - in combat, STEP=MAIN_START comes after both warbands are in place and before any
//   Start of Combat effect, so that is where a combat is captured.

import { PowerLog, iterGames } from './powerlog.js';
import { card as cardOf, baseId } from './cards.js';

const KW_TAGS = ['TAUNT', 'DIVINE_SHIELD', 'REBORN', 'POISONOUS', 'VENOMOUS', 'STEALTH', 'CLEAVE', 'IMMUNE'];
const PLAYABLE = new Set(['MINION', 'BATTLEGROUND_SPELL', 'SPELL']);
const BOB = 'TB_BaconShopBob';
const BREAKERS = ['TB_BaconShop_DragBuy', 'TB_BaconShop_DragSell', 'TB_BaconShop_8p_Reroll',
  'TB_BaconShopTechUp', 'BG36_Button_DarkGift', 'TB_BaconShopLockAll'];

export function minionOf(e) {
  const kws = KW_TAGS.filter(t => e.get(t));
  const wf = e.get('WINDFURY');
  if (wf >= 3 || e.get('MEGA_WINDFURY')) kws.push('MEGA_WINDFURY');
  else if (wf) kws.push('WINDFURY');
  return { card: baseId(e.cardId), atk: e.get('ATK'), hp: e.get('HEALTH') - e.get('DAMAGE'), keywords: kws, entity: e.id };
}

export const minionScene = m => ({ card: m.card, atk: m.atk, hp: Math.max(1, m.hp), keywords: m.keywords });

export const sideScene = s => ({
  hero: s.hero, health: Math.max(1, s.health), armor: s.armor, tier: Math.max(1, s.tier),
  trinkets: s.trinkets, board: s.board.map(minionScene),
});

export const combatScene = c => ({ turn: c.round, me: sideScene(c.me), opponent: sideScene(c.opp) });

class Reader {
  constructor(log, game) {
    this.log = log;
    this.g = game;
    this.pending = null;  // [combat, my life, opp life]
    this.openPlay = null;
    this.seq = 0;
    this.run = 0;
    this.lastWasPlay = false;
    // Some clients (255790) place the opponent's hero and warband only after MAIN_START: until
    // the first attack, an incomplete snapshot is taken again after each top-level block.
    this.snapOpen = false;
    log.onTag((l, e, tag, old, nw) => this._tag(l, e, tag, old, nw));
    log.onBlock((l, b, start) => this._block(l, b, start));
  }

  get turn() {
    const ge = this.log.gameEntity;
    return ge !== null ? this.log.entity(ge).get('TURN') : 0;
  }

  players() {
    const me = this.log.localPlayer;
    if (me === null) return null;
    const others = [...this.log.playerEntity.values()].filter(e => e !== me);
    if (others.length !== 1) return null;
    return [this.log.entity(me), this.log.entity(others[0])];
  }

  heroLife(player) {
    const h = this.log.entity(player.get('HERO_ENTITY'));
    return h.get('HEALTH') - h.get('DAMAGE') + h.get('ARMOR');
  }

  side(player, name) {
    const ctl = player.controller;
    const hero = this.log.entity(player.get('HERO_ENTITY'));
    const inPlay = [...this.log.entities.values()].filter(e => e.controller === ctl && e.zone === 'PLAY');
    const power = inPlay.find(e => e.cardtype === 'HERO_POWER');
    const trinkets = inPlay.filter(e => e.cardtype === 'BATTLEGROUND_TRINKET'
      && !e.cardId.startsWith('BG30_Trinket_')).map(e => e.cardId);  // unpicked placeholders
    const board = this.log.inZone(ctl, 'PLAY', 'MINION').map(minionOf);
    const tier = player.get('PLAYER_TECH_LEVEL') || hero.get('PLAYER_TECH_LEVEL');
    return { name, hero: baseId(hero.cardId), heroPower: power ? baseId(power.cardId) : '',
             health: hero.get('HEALTH') - hero.get('DAMAGE'), armor: hero.get('ARMOR'), tier, trinkets, board };
  }

  myBoard() {
    const ps = this.players();
    if (!ps) return [];
    return this.log.inZone(ps[0].controller, 'PLAY', 'MINION').map(minionOf);
  }

  _tag(log, e, tag, old, nw) {
    if (tag === 'PLAYER_LEADERBOARD_PLACE') {
      const ps = this.players();
      if (ps && e.id === ps[0].get('HERO_ENTITY') && /^\d+$/.test(nw)) this.g.place = parseInt(nw, 10);
      return;
    }
    if (e.id !== log.gameEntity) return;
    if (tag === 'STATE' && nw === 'COMPLETE') { this.g.complete = true; return; }
    if (tag === 'STEP' && nw === 'MAIN_START' && this.turn % 2 === 0 && this.turn > 0) {
      const ps = this.players();
      if (!ps) return;
      const [me, opp] = ps;
      // The dummy player carries the current opponent's name in combat.
      const combat = { round: Math.floor(this.turn / 2), me: this.side(me, this.g.player),
                       opp: this.side(opp, log.lastName.get(opp.id) || ''), winner: '', damage: 0 };
      this.g.combats.push(combat);
      this.pending = [combat, this.heroLife(me), this.heroLife(opp)];
      this.snapOpen = true;
    } else if (tag === 'TURN') {
      this.snapOpen = false;
      if (this.pending) this.finishCombat();
      this.lastWasPlay = false;
    }
  }

  finishCombat() {
    const [combat, myLife, oppLife] = this.pending;
    this.pending = null;
    const ps = this.players();
    if (!ps) return;
    const [me, opp] = ps;
    const lost = myLife - this.heroLife(me);
    const dealt = oppLife - this.heroLife(opp);
    if (dealt > 0) { combat.winner = 'me'; combat.damage = dealt; }
    else if (lost > 0) { combat.winner = 'opp'; combat.damage = lost; }
    else combat.winner = 'tie';
  }

  /** Retake a combat snapshot that missed the opponent's hero or warband. */
  completeSnapshot() {
    let [combat, myLife, oppLife] = this.pending;
    if (combat.opp.hero !== BOB && combat.opp.board.length && combat.me.board.length) {
      this.snapOpen = false;
      return;
    }
    const ps = this.players();
    if (!ps) return;
    const [me, opp] = ps;
    if (this.log.entity(opp.get('HERO_ENTITY')).cardId === BOB) return;  // not placed yet
    const side = this.side(opp, this.log.lastName.get(opp.id) || combat.opp.name);
    if (side.board.length || !combat.opp.board.length) {
      combat.opp = side;
      oppLife = this.heroLife(opp);
    }
    if (!combat.me.board.length) {
      combat.me = this.side(me, combat.me.name);
      myLife = this.heroLife(me);
    }
    this.pending = [combat, myLife, oppLife];
  }

  _block(log, b, start) {
    if (this.turn % 2 === 0 && this.snapOpen && this.pending) {
      if (start && b.type === 'ATTACK') this.snapOpen = false;  // the fight has begun
      else if (!start && !log.blocks.length) this.completeSnapshot();
      return;
    }
    if (this.turn % 2 === 0 || log.blocks.length > (start ? 1 : 0)) return;  // top-level recruit blocks
    if (b.type !== 'PLAY' || b.entity === null) return;
    const ps = this.players();
    if (!ps) return;
    const me = ps[0];
    const e = log.entity(b.entity);
    if (start) {
      this.openPlay = null;
      if (e.controller !== me.controller) return;
      if (BREAKERS.some(x => e.cardId.startsWith(x)) || (!PLAYABLE.has(e.cardtype) && e.cardtype !== 'HERO_POWER')) {
        this.lastWasPlay = false;
        return;
      }
      if (PLAYABLE.has(e.cardtype) && e.zone !== 'HAND') return;
      const board = this.myBoard();
      let target = null;
      if (b.target !== null) {
        const i = board.findIndex(m => m.entity === b.target);
        target = i >= 0 ? i : null;
      }
      if (!this.lastWasPlay || e.cardtype === 'HERO_POWER') this.run += 1;
      this.seq += 1;
      this.openPlay = { round: Math.floor(this.turn / 2) + 1, seq: this.seq, card: baseId(e.cardId), kind: e.cardtype,
                        handStats: [e.get('ATK'), e.get('HEALTH') - e.get('DAMAGE')], boardBefore: board,
                        targetIndex: target, magnetizedTo: null, position: null, entity: e.id, run: this.run };
      this.lastWasPlay = e.cardtype !== 'HERO_POWER';
    } else {
      const p = this.openPlay;
      this.openPlay = null;
      if (!p || p.entity !== b.entity) return;
      if (p.kind === 'MINION') {
        let ench = null;
        for (const x of log.entities.values()) {
          if (x.cardtype === 'ENCHANTMENT' && x.get('MAGNETIC') && x.get('CREATOR') === p.entity) { ench = x; break; }
        }
        if (ench) {
          const tgt = ench.get('ATTACHED');
          const i = p.boardBefore.findIndex(m => m.entity === tgt);
          p.magnetizedTo = i >= 0 ? i : null;
        }
        if (e.zone === 'PLAY' && e.controller === me.controller) p.position = e.get('ZONE_POSITION') - 1;
      }
      this.g.plays.push(p);
    }
  }
}

// ------------------------------------------------------------- card numbers vs the engine

const RE_CREATE = /^\s*FULL_ENTITY - Creating ID=\d+ CardID=(\S+)/;
const RE_TAGLINE = /^\s*tag=(\w+) value=(\S+)/;

/** Minions whose creation stats in this log never match the engine's card data. */
export function cardChanges(lines) {
  const seen = new Map();
  let cur = null, tags = {};
  const flush = () => {
    if (cur && tags.CARDTYPE === 'MINION') {
      const k = [parseInt(tags.ATK || 0, 10), parseInt(tags.HEALTH || 0, 10), parseInt(tags.TECH_LEVEL || 0, 10)].join(',');
      const id = baseId(cur);
      if (!seen.has(id)) seen.set(id, new Map());
      const m = seen.get(id);
      m.set(k, (m.get(k) || 0) + 1);
    }
  };
  for (const [, kind, body] of lines) {
    if (kind !== 'Power') continue;
    const m = RE_CREATE.exec(body);
    if (m) { flush(); cur = m[1]; tags = {}; continue; }
    if (cur !== null) {
      const t = RE_TAGLINE.exec(body);
      if (t) { tags[t[1]] = t[2]; continue; }
      flush();
      cur = null;
    }
  }
  flush();
  const out = [];
  for (const [cid, cnt] of seen) {
    const c = cardOf(cid);
    if (!c || c.kind !== 'minion') continue;
    const engine = [c.atk, c.hp, c.tier];
    if (cnt.has(engine.join(',')) || cnt.size !== 1) continue;
    const [[k, n]] = [...cnt];
    let client = k.split(',').map(Number);
    if (client[2] === 0) {  // tier not shown on this entity
      if (client[0] === engine[0] && client[1] === engine[1]) continue;
      client = [client[0], client[1], engine[2]];
    }
    out.push({ card: cid, name: c.name, engine, client, seen: n });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ------------------------------------------------------------- games

/** Every Battlegrounds game in the given logs ([{text, source}]), reconnects merged. */
export function readGames(files) {
  const out = [];
  for (const rg of iterGames(files)) {
    // Skip other game modes before the (slower) entity replay.
    if (!rg.lines.some(([, kind, body]) => kind === 'Game' && body.trim() === 'GameType=GT_BATTLEGROUNDS')) continue;
    const log = new PowerLog();
    const game = { source: rg.source, build: 0, player: '', combats: [], plays: [], reconnect: rg.reconnect,
                   start: '', complete: false, place: 0, hero: '', cardChanges: [] };
    const reader = new Reader(log, game);
    rg.run(log);
    if (log.header.gameType !== 'GT_BATTLEGROUNDS') continue;
    if (reader.pending) reader.finishCombat();  // the game ended in this combat
    game.build = log.header.build;
    const me = log.localPlayer;
    let pid = null;
    for (const [p, e] of log.playerEntity) if (e === me) { pid = p; break; }
    game.player = log.header.playerNames.get(pid) || '';
    for (const c of game.combats) c.me.name = game.player;
    game.cardChanges = cardChanges(rg.lines);
    game.start = rg.lines.length ? rg.lines[0][0] : '';
    if (game.combats.length) game.hero = game.combats[game.combats.length - 1].me.hero;
    if (!game.place) {
      const ps = reader.players();
      if (ps) game.place = log.entity(ps[0].get('HERO_ENTITY')).get('PLAYER_LEADERBOARD_PLACE');
    }
    out.push(game);
  }
  return mergeReconnects(out);
}

/** Join a game with the reconnect that continues it (same player, later rounds). */
export function mergeReconnects(games) {
  const merged = [];
  for (const g of games) {
    const prev = merged.length ? merged[merged.length - 1] : null;
    if (g.reconnect && prev && prev.player === g.player && prev.combats.length && g.combats.length
        && g.combats[0].round > prev.combats[prev.combats.length - 1].round) {
      prev.combats.push(...g.combats);
      const lastRun = Math.max(0, ...prev.plays.map(p => p.run));
      for (const p of g.plays) p.run += lastRun;
      prev.plays.push(...g.plays);
      prev.source += ' + ' + g.source;
      prev.complete = g.complete;
      prev.place = g.place || prev.place;
      prev.hero = g.hero || prev.hero;
      const known = new Set(prev.cardChanges.map(c => c.card));
      prev.cardChanges.push(...g.cardChanges.filter(c => !known.has(c.card)));
    } else {
      merged.push(g);
    }
  }
  return merged;
}
