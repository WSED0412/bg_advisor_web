// Low-level Hearthstone Power.log reader: replays the GameState stream into entity states.
//
// Only `GameState.DebugPrintPower()` lines are used (PowerTaskList lines repeat the same events
// later, as the client plays the animations). Each game starts at CREATE_GAME; a reconnect
// also starts with CREATE_GAME and a full dump of the current state.

const PREFIX = /^D [\d:.]+ GameState\.DebugPrint(Power|Game)\(\) - (.*)$/;
const ENT_BRACKET = /^\[([^\]]*)\]/;
const KV = /(\w+)=((?:(?! \w+=).)*)/g;
const RE_TAG = /^tag=(\S+) value=(.*)$/;
const RE_TAG_CHANGE = /^TAG_CHANGE Entity=(.*) tag=(\S+) value=(\S+)/;
const RE_ENTITY = /^\w+ - (?:Creating ID=(\d+)|Updating (?:Entity=)?(.*?)) CardID=(\S*)/;
const RE_HIDE = /^HIDE_ENTITY - Entity=(.*) tag=(\S+) value=(\S+)/;
const RE_BLOCK = /^BLOCK_START BlockType=(\S+) Entity=(.*?) EffectCardId=(.*?) EffectIndex=.*? Target=(.*?) SubOption/;
const RE_PLAYER = /^Player EntityID=(\d+) PlayerID=(\d+)(?: GameAccountId=\[hi=(\d+))?/;
const isDigits = s => /^\d+$/.test(s);

export class Entity {
  constructor(id) {
    this.id = id;
    this.cardId = '';
    this.tags = Object.create(null);
  }
  get(tag, dflt = 0) {
    const v = this.tags[tag];
    if (v === undefined) return dflt;
    return /^-?\d+$/.test(v) ? parseInt(v, 10) : dflt;
  }
  s(tag) { return this.tags[tag] ?? ''; }
  get zone() { return this.s('ZONE'); }
  get controller() { return this.get('CONTROLLER'); }
  get cardtype() { return this.s('CARDTYPE'); }
}

export class PowerLog {
  constructor() {
    this.header = { build: 0, gameType: '', playerNames: new Map() };
    this.entities = new Map();
    this.playerEntity = new Map();   // PlayerID -> entity id
    this.gameEntity = null;
    this.blocks = [];                 // open BLOCK_START stack
    this.time = '';
    this._current = null;
    this._accountHi = new Map();
    this._nameCache = new Map();
    this.lastName = new Map();        // entity id -> latest display name used
    this._tagHandlers = [];
    this._blockHandlers = [];
  }

  onTag(fn) { this._tagHandlers.push(fn); }
  onBlock(fn) { this._blockHandlers.push(fn); }

  entity(eid) {
    let e = this.entities.get(eid);
    if (!e) { e = new Entity(eid); this.entities.set(eid, e); }
    return e;
  }

  playerByName(name) {
    for (const [pid, n] of this.header.playerNames) {
      if (n === name) return this.playerEntity.get(pid) ?? null;
    }
    const cached = this._nameCache.get(name);
    if (cached !== undefined) {
      if (name !== 'Bartender Bob') this.lastName.set(cached, name);
      return cached;
    }
    // Battlegrounds renames the second (dummy) player after each combat opponent and
    // Bartender Bob; any name we have not seen belongs to the player who is not local.
    const local = this.localPlayer;
    const others = [...this.playerEntity.values()].filter(e => e !== local);
    if (local !== null && others.length === 1) {
      this._nameCache.set(name, others[0]);
      if (name !== 'Bartender Bob') this.lastName.set(others[0], name);
      return others[0];
    }
    return null;
  }

  /** Entity id of the player whose GameAccountId is real (hi != 0). */
  get localPlayer() {
    for (const [pid, eid] of this.playerEntity) {
      if ((this._accountHi.get(pid) || 0) !== 0 && !this.entity(eid).get('BACON_DUMMY_PLAYER')) {
        return eid;
      }
    }
    return null;
  }

  inZone(controller, zone, cardtype = null) {
    const out = [];
    for (const e of this.entities.values()) {
      if (e.controller === controller && e.zone === zone && (cardtype === null || e.cardtype === cardtype)) {
        out.push(e);
      }
    }
    return out.sort((a, b) => a.get('ZONE_POSITION') - b.get('ZONE_POSITION'));
  }

  _ref(text) {
    text = text.trim();
    const m = ENT_BRACKET.exec(text);
    if (m) {
      let id = null;  // the last id= wins, as with a dict of all pairs
      for (const kv of m[1].matchAll(KV)) {
        if (kv[1] === 'id') id = kv[2];
      }
      return id !== null && isDigits(id) ? parseInt(id, 10) : null;
    }
    if (isDigits(text)) return parseInt(text, 10);
    if (text === 'GameEntity') return this.gameEntity;
    return this.playerByName(text);
  }

  _set(e, tag, value, notify) {
    const old = e.tags[tag] ?? '';
    e.tags[tag] = value;
    if (notify && old !== value) {
      for (const fn of this._tagHandlers) fn(this, e, tag, old, value);
    }
  }

  feed(kind, body) {
    if (kind === 'Game') { this._feedHeader(body); return; }
    const s = body.trim();
    if (s.startsWith('tag=')) {
      const m = RE_TAG.exec(s);
      if (m && this._current) this._set(this._current, m[1], m[2].trim(), false);
      return;
    }
    this._current = null;

    if (s.startsWith('TAG_CHANGE ')) {
      const m = RE_TAG_CHANGE.exec(s);
      if (m) {
        const eid = this._ref(m[1]);
        if (eid !== null) this._set(this.entity(eid), m[2], m[3], true);
      }
    } else if (s.startsWith('FULL_ENTITY') || s.startsWith('SHOW_ENTITY') || s.startsWith('CHANGE_ENTITY')) {
      const m = RE_ENTITY.exec(s);
      if (m) {
        const eid = m[1] ? parseInt(m[1], 10) : this._ref(m[2]);
        if (eid !== null) {
          const e = this.entity(eid);
          if (m[3]) e.cardId = m[3];
          this._current = e;
        }
      }
    } else if (s.startsWith('HIDE_ENTITY')) {
      const m = RE_HIDE.exec(s);
      if (m) {
        const eid = this._ref(m[1]);
        if (eid !== null) this._set(this.entity(eid), m[2], m[3], true);
      }
    } else if (s.startsWith('BLOCK_START')) {
      const m = RE_BLOCK.exec(s);
      const b = m
        ? { type: m[1], entity: this._ref(m[2]), target: this._ref(m[4]), effectCard: m[3].trim(), raw: s, time: this.time }
        : { type: 'UNKNOWN', entity: null, target: null, effectCard: '', raw: s, time: this.time };
      if (b.type === 'PLAY' && this.blocks.length) {
        // A PLAY block is a player action and never nests; blocks still open here lost
        // their BLOCK_END in the log (it happens), so close them now.
        while (this.blocks.length) {
          const stale = this.blocks.pop();
          for (const fn of this._blockHandlers) fn(this, stale, false);
        }
      }
      this.blocks.push(b);
      for (const fn of this._blockHandlers) fn(this, b, true);
    } else if (s.startsWith('BLOCK_END')) {
      if (this.blocks.length) {
        const b = this.blocks.pop();
        for (const fn of this._blockHandlers) fn(this, b, false);
      }
    } else if (s.startsWith('GameEntity EntityID=')) {
      const eid = parseInt(s.split('=')[1], 10);
      this.gameEntity = eid;
      this._current = this.entity(eid);
    } else if (s.startsWith('Player EntityID=')) {
      const m = RE_PLAYER.exec(s);
      if (m) {
        const eid = parseInt(m[1], 10), pid = parseInt(m[2], 10);
        this.playerEntity.set(pid, eid);
        this._accountHi.set(pid, parseInt(m[3] || '0', 10));
        this._current = this.entity(eid);
      }
    }
  }

  _feedHeader(body) {
    const t = body.trim();
    const m = /^(\w+)=(.*)$/.exec(t);
    if (!m) return;
    const [, k, v] = m;
    if (k === 'BuildNumber') this.header.build = parseInt(v, 10);
    else if (k === 'GameType') this.header.gameType = v;
    else if (k === 'PlayerID') {
      const pm = /^PlayerID=(\d+), PlayerName=(.*)$/.exec(t);
      if (pm) this.header.playerNames.set(parseInt(pm[1], 10), pm[2]);
    }
  }
}

/** One game's lines: [time, kind, body]. */
export class RawGame {
  constructor(lines, source, reconnect) {
    this.lines = lines;
    this.source = source;
    this.reconnect = reconnect;
  }
  run(log) {
    for (const [t, kind, body] of this.lines) {
      log.time = t;
      log.feed(kind, body);
    }
    return log;
  }
}

/** Split log texts ([{text, source}]) into games (CREATE_GAME to the next CREATE_GAME). */
export function* iterGames(files) {
  // The DebugPrintGame header (build, game type, player names) follows CREATE_GAME.
  for (const { text, source } of files) {
    let cur = null;
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start);
      if (end < 0) end = text.length;
      let line = text.slice(start, end);
      start = end + 1;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.charCodeAt(0) !== 68 /* D */ || !line.includes('GameState.DebugPrint')) continue;
      const m = PREFIX.exec(line);
      if (!m) continue;
      const kind = m[1], body = m[2];
      const t = line.split(' ', 2)[1];
      if (kind === 'Power' && body.trim() === 'CREATE_GAME') {
        if (cur !== null) yield finish(cur, source);
        cur = [];
      }
      if (cur !== null) cur.push([t, kind, body]);
    }
    if (cur !== null) yield finish(cur, source);
  }
}

function finish(lines, source) {
  let turn = 0;
  for (const [, , body] of lines.slice(0, 200)) {
    const m = /^\s*tag=TURN value=(\d+)/.exec(body);
    if (m) { turn = parseInt(m[1], 10); break; }
  }
  return new RawGame(lines, source, turn > 1);
}
