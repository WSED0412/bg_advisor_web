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
  hero: s.hero, hero_power: s.heroPower, health: Math.max(1, s.health), armor: s.armor, tier: Math.max(1, s.tier),
  trinkets: s.trinkets, spells: s.spells || [], stats: s.stats || {}, rewards: s.rewards || [],
  board: s.board.map(minionScene),
});

export const combatScene = c => {
  const sc = { turn: c.round, me: sideScene(c.me), opponent: sideScene(c.opp) };
  if (c.lobby && c.lobby.length) sc.lobby = c.lobby;
  return sc;
};

// Player tags -> TavernGym player stats ("this game" numbers that change combats).
const STAT_TAGS = [
  ['1844', 'gem_atk'], ['BACON_BLOODGEMBUFFATKVALUE', 'gem_atk'],          // Blood Gems' extra Attack
  ['2827', 'gem_hp'], ['BACON_BLOODGEMBUFFHEALTHVALUE', 'gem_hp'],
  ['2878', 'elementals_played'], ['BACON_ELEMENTAL_PLAY_COUNTER', 'elementals_played'],
  ['NUM_SPELLS_PLAYED_THIS_GAME', 'spells_cast'],
  ['3874', 'beetle_atk'], ['3924', 'beetle_hp'],                            // Beetles' extra stats this game
  ['4468', 'volumizer_atk'], ['4469', 'volumizer_hp'],                      // Volumizers' extra stats this game
];
// "This game" numbers kept in an enchantment on the player (TAG_SCRIPT_DATA_NUM_1), not a tag.
const ENCHANT_STATS = {
  BG25_011pe: 'undead_atk',  // Undead Bonus Attack Player Enchant: Deathswarmer +1, Plaguerunner +2...
};
const LOBBY_SIZE = 5;

/** The lobby's minion types, from the pool minions seen in the game (most cards first). */
export function lobbyTypes(log) {
  const count = new Map(), seen = new Set();
  for (const e of log.entities.values()) {
    if (e.cardtype !== 'MINION' || !e.get('IS_BACON_POOL_MINION')) continue;
    const cid = baseId(e.cardId);
    if (seen.has(cid)) continue;
    seen.add(cid);
    const races = (cardOf(cid) || {}).races || [];
    if (!races.length || races.length > 2) continue;  // neutral, or "all types"
    for (const r of races) count.set(r, (count.get(r) || 0) + 1);
  }
  const ranked = [...count].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([r]) => r);
  return ranked.slice(0, LOBBY_SIZE).sort();
}

class Reader {
  constructor(log, game) {
    this.log = log;
    this.g = game;
    this.pending = null;  // [combat, my life, opp life]
    this.oppHero = 0;
    this.openPlay = null;
    this.seq = 0;
    this.run = 0;
    this.lastWasPlay = false;
    // Some clients (255790) place the opponent's hero and warband only after MAIN_START: until
    // the first attack, an incomplete snapshot is taken again after each top-level block.
    this.snapOpen = false;
    log.onTag((l, e, tag, old, nw) => this._tag(l, e, tag, old, nw));
    log.onBlock((l, b, start) => this._block(l, b, start));
    log.onChoice((l, c) => this._choice(l, c));
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
    return this.life(player.get('HERO_ENTITY'));
  }

  life(hero) {
    const h = this.log.entity(hero);
    return h.get('HEALTH') - h.get('DAMAGE') + h.get('ARMOR');
  }

  /**
   * The leaderboard hero of the same player as this combat hero. The opponent's hero in combat
   * is a copy: once the combat ends it is removed and its damage reset, while the leaderboard
   * hero keeps each of the eight players' life.
   */
  boardHero(hero) {
    const pid = this.log.entity(hero).get('PLAYER_ID');
    if (!pid) return hero;
    let best = 0;
    for (const e of this.log.entities.values()) {
      if (e.cardtype === 'HERO' && e.get('PLAYER_ID') === pid && e.get('PLAYER_LEADERBOARD_PLACE')
          && (e.zone === 'SETASIDE' || e.zone === 'PLAY') && (!best || e.id < best)) best = e.id;
    }
    return best || hero;
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
    // Spells cast during recruit that act at the start of combat wait in the Secret zone.
    const spells = this.log.inZone(ctl, 'SECRET')
      .filter(e => e.cardId && (e.cardtype === 'BATTLEGROUND_SPELL' || e.cardtype === 'SPELL')).map(e => baseId(e.cardId));
    const rewards = inPlay.filter(e => e.cardtype === 'BATTLEGROUND_QUEST_REWARD' && e.cardId).map(e => baseId(e.cardId));
    const stats = {};
    for (const [tag, k] of STAT_TAGS) {
      const v = player.get(tag);
      if (v) stats[k] = v;
    }
    for (const e of inPlay) {
      const k = ENCHANT_STATS[e.cardId];
      if (k && e.get('ATTACHED') === player.id) {
        const v = e.get('TAG_SCRIPT_DATA_NUM_1');
        if (v) stats[k] = v;
      }
    }
    return { name, hero: baseId(hero.cardId), heroPower: power ? baseId(power.cardId) : '',
             health: hero.get('HEALTH') - hero.get('DAMAGE'), armor: hero.get('ARMOR'), tier, trinkets, board,
             spells, rewards, stats };
  }

  myBoard() {
    const ps = this.players();
    if (!ps) return [];
    return this.log.inZone(ps[0].controller, 'PLAY', 'MINION').map(minionOf);
  }

  _tag(log, e, tag, old, nw) {
    if (tag === 'COPIED_FROM_ENTITY_ID') {
      // Each round's copy of a minion links back to the previous one.
      if (/^\d+$/.test(nw)) {
        const from = parseInt(nw, 10);
        if (from && from !== e.id && !this.g.copied.has(e.id)) this.g.copied.set(e.id, from);
      }
      return;
    }
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
      this.oppHero = this.boardHero(opp.get('HERO_ENTITY'));
      this.pending = [combat, this.heroLife(me), this.life(this.oppHero)];
      this.snapOpen = true;
    } else if (tag === 'TURN') {
      this.snapOpen = false;
      if (this.pending) this.finishCombat();
      this.lastWasPlay = false;
    }
  }

  /** Every player's life and place now, from the leaderboard heroes. */
  standing(rnd) {
    const me = this.log.localPlayer;
    const myPid = me != null ? this.log.entity(this.log.entity(me).get('HERO_ENTITY')).get('PLAYER_ID') : 0;
    const heroes = new Map();
    for (const e of this.log.entities.values()) {
      const pid = e.get('PLAYER_ID');
      if (e.cardtype === 'HERO' && pid && e.get('PLAYER_LEADERBOARD_PLACE')
          && (e.zone === 'SETASIDE' || e.zone === 'PLAY' || e.zone === 'GRAVEYARD')
          && (!heroes.has(pid) || e.id < heroes.get(pid).id)) heroes.set(pid, e);
    }
    if (heroes.size < 2) return;
    const players = [...heroes.keys()].sort((a, b) => a - b).map(pid => {
      const e = heroes.get(pid);
      return { pid, hero: baseId(e.cardId), life: this.life(e.id),
               place: e.get('PLAYER_LEADERBOARD_PLACE'), me: pid === myPid };
    });
    this.g.standings = this.g.standings.filter(x => x.round !== rnd);
    this.g.standings.push({ round: rnd, players });
  }

  finishCombat() {
    const [combat, myLife, oppLife] = this.pending;
    this.pending = null;
    this.standing(combat.round);
    const ps = this.players();
    if (!ps) return;
    const [me] = ps;
    const lost = myLife - this.heroLife(me);
    // The opponent's leaderboard hero, kept when the combat began (by now, the next turn, the
    // other player is Bob).
    const dealt = oppLife - this.life(this.oppHero || 0);
    if (lost > 0) { combat.winner = 'opp'; combat.damage = lost; }
    else if (me.get('BACON_WON_LAST_COMBAT')) { combat.winner = 'me'; combat.damage = Math.max(0, dealt); }
    else combat.winner = 'tie';
  }

  /** A minion bought from the Tavern: remember the whole Tavern at that moment. */
  buy(log, bob, target) {
    const shop = log.inZone(bob.controller, 'PLAY', 'MINION').map(minionOf);
    if (shop.some(m => m.entity === target) && shop.length >= 2) {
      this.g.picks.push({ round: Math.floor(this.turn / 2) + 1, kind: 'buy', source: '', chosen: target, options: shop });
    }
  }

  /** A Discover of minions during recruit, and the one picked. */
  _choice(log, c) {
    if (c.type !== 'GENERAL' || this.turn % 2 === 0 || c.chosen.length !== 1 || c.options.length < 2) return;
    if (this.g.player && c.player !== this.g.player) return;
    if (c.source !== null) {  // a card taken from a Discover opened by a played card
      const e = log.entity(c.chosen[0]);
      const minion = e.cardtype === 'MINION';
      this.g.found.push({ round: Math.floor(this.turn / 2) + 1, source: c.source, card: baseId(e.cardId),
                          atk: minion ? e.get('ATK') : null, hp: minion ? e.get('HEALTH') - e.get('DAMAGE') : null });
    }
    const ents = c.options.map(id => log.entity(id));
    if (ents.some(e => e.cardtype !== 'MINION')) return;
    const source = c.source !== null ? baseId(log.entity(c.source).cardId) : '';
    this.g.picks.push({ round: Math.floor(this.turn / 2) + 1, kind: 'discover', source, chosen: c.chosen[0],
                        options: ents.map(minionOf) });
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
      this.oppHero = this.boardHero(opp.get('HERO_ENTITY'));
      oppLife = this.life(this.oppHero);
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
      if (e.cardId === 'TB_BaconShop_DragBuy' && b.target !== null) this.buy(log, ps[1], b.target);
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
                        targetIndex: target, magnetizedTo: null, position: null, entity: e.id, run: this.run,
                        creator: e.get('CREATOR'), found: [] };
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

/** The local player's name from the game header (the player with a real account). */
function localName(rg) {
  const names = new Map(), his = new Map();
  for (const [, kind, body] of rg.lines.slice(0, 4000)) {
    const b = body.trim();
    let m = kind === 'Game' ? /^PlayerID=(\d+), PlayerName=(.*)$/.exec(b) : null;
    if (m) names.set(parseInt(m[1], 10), m[2]);
    m = kind === 'Power' ? /^Player EntityID=\d+ PlayerID=(\d+) GameAccountId=\[hi=(\d+)/.exec(b) : null;
    if (m) his.set(parseInt(m[1], 10), parseInt(m[2], 10));
  }
  for (const [pid, hi] of his) if (hi && names.has(pid)) return names.get(pid);
  return '';
}

/** Every Battlegrounds game in the given logs ([{text, source}]), reconnects merged. */
export function readGames(files) {
  const out = [];
  for (const rg of iterGames(files)) {
    // Skip other game modes before the (slower) entity replay.
    if (!rg.lines.some(([, kind, body]) => kind === 'Game' && body.trim() === 'GameType=GT_BATTLEGROUNDS')) continue;
    const log = new PowerLog();
    const game = { source: rg.source, build: 0, player: localName(rg), combats: [], plays: [], picks: [],
                   found: [], copied: new Map(), reconnect: rg.reconnect,
                   start: '', complete: false, place: 0, hero: '', cardChanges: [], standings: [] };
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
    game.lobby = lobbyTypes(log);
    if (!game.place) {
      const ps = reader.players();
      if (ps) game.place = log.entity(ps[0].get('HERO_ENTITY')).get('PLAYER_LEADERBOARD_PLACE');
    }
    out.push(game);
  }
  const games = mergeReconnects(out);
  for (const g of games) {
    attachFound(g);
    attachOrigins(g);
    delete g.copied;  // only needed here
    for (const c of g.combats) c.lobby = g.lobby || [];
  }
  return games;
}

/** Give each play the cards taken from the Discovers it opened. */
function attachFound(game) {
  const plays = new Map(game.plays.map(p => [`${p.round}:${p.entity}`, p]));
  for (const f of game.found) {
    const p = plays.get(`${f.round}:${f.source}`);
    if (p) p.found.push({ card: f.card, atk: f.atk, hp: f.hp });
  }
}

/** Mark each minion with its first entity, so a minion can be followed across rounds. */
function attachOrigins(game) {
  const root = e => {
    const seen = new Set();
    while (game.copied.has(e) && !seen.has(e)) {
      seen.add(e);
      e = game.copied.get(e);
    }
    return e;
  };
  for (const c of game.combats) for (const m of c.me.board) m.origin = root(m.entity);
  for (const k of game.picks) for (const m of k.options) m.origin = root(m.entity);
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
      prev.picks.push(...g.picks);
      prev.found.push(...g.found);
      for (const [k, v] of g.copied) if (!prev.copied.has(k)) prev.copied.set(k, v);
      prev.source += ' + ' + g.source;
      prev.complete = g.complete;
      prev.place = g.place || prev.place;
      prev.hero = g.hero || prev.hero;
      prev.standings.push(...g.standings);
      const known = new Set(prev.cardChanges.map(c => c.card));
      prev.cardChanges.push(...g.cardChanges.filter(c => !known.has(c.card)));
    } else {
      merged.push(g);
    }
  }
  return merged;
}
