// TavernGym in WebAssembly (engine/src/lib.rs): a thin wrapper over its C ABI.
//
// Strings cross as UTF-8 in the module's memory; every call leaves its output (or error
// message) in one buffer read right after the call. Games are handles and must be freed.

const enc = new TextEncoder();
const dec = new TextDecoder();

export class EngineError extends Error {}

let modulePromise = null;

/** The compiled module (compiled once per thread, shareable with workers). */
export function compileEngine(url = new URL('../engine/taverngym.wasm', import.meta.url)) {
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`無法載入模擬器（${res.status}）`);
      return WebAssembly.compile(await res.arrayBuffer());
    })();
  }
  return modulePromise;
}

export class Engine {
  static async create(module) {
    module = module || await compileEngine();
    const inst = await WebAssembly.instantiate(module, {});
    return new Engine(inst, module);
  }

  constructor(inst, module) {
    this.module = module;
    this.x = inst.exports;
    this.broken = false;
  }

  _out(code) {
    const x = this.x;
    const s = dec.decode(new Uint8Array(x.memory.buffer, x.tg_out_ptr(), x.tg_out_len()));
    if (code !== 0) throw new EngineError(s);
    return s;
  }

  _call(fn) {
    try {
      return fn();
    } catch (e) {
      if (e instanceof EngineError) throw e;
      // A trap (Rust panic) leaves this instance unusable.
      this.broken = true;
      throw new EngineError(`engine crashed: ${e && e.message || e}`);
    }
  }

  _withStr(s, f) {
    return this._withBytes(enc.encode(s), f);
  }

  _withBytes(b, f) {
    const x = this.x;
    const len = b.length;
    const p = x.tg_alloc(len);
    new Uint8Array(x.memory.buffer, p, len).set(b);
    try {
      return f(p, len);
    } finally {
      if (!this.broken) x.tg_free(p, len);
    }
  }

  newGame(seed, cfg = null) {
    return this._call(() => {
      const s = cfg ? JSON.stringify(cfg) : '';
      const h = this._withStr(s, (p, n) => this._out(this.x.tg_game_new(BigInt(seed), p, n)));
      return new Game(this, Number(h));
    });
  }

  fromJson(json) {
    return this._call(() => {
      const h = this._withStr(json, (p, n) => this._out(this.x.tg_game_from_json(p, n)));
      return new Game(this, Number(h));
    });
  }

  catalog() {
    return this._call(() => JSON.parse(this._out(this.x.tg_catalog())));
  }

  version() {
    return this._call(() => this._out(this.x.tg_version()));
  }
}

export class Game {
  constructor(engine, h) {
    this.e = engine;
    this.h = h;
  }

  _str(fn) {
    return this.e._call(() => this.e._out(fn(this.e.x)));
  }

  stateJson() { return this._str(x => x.tg_state_json(this.h)); }

  /** The JSON view of seat p, parsed. */
  view(p) { return JSON.parse(this._str(x => x.tg_view(this.h, p))); }

  /** A debug command (object), result parsed. */
  debug(cmd) {
    const e = this.e;
    return JSON.parse(e._call(() =>
      e._withStr(JSON.stringify(cmd), (p, n) => e._out(e.x.tg_debug(this.h, p, n)))));
  }

  /** Legal-action mask of seat p: a string of '0'/'1'. */
  legalMask(p) { return this._str(x => x.tg_legal_mask(this.h, p)); }

  step(p, action) { this._str(x => x.tg_step(this.h, p, action)); }

  copy() { return new Game(this.e, Number(this._str(x => x.tg_game_copy(this.h)))); }

  /** A copy with seat p's warband rearranged: order[k] = index of the minion for slot k. */
  reordered(p, order) {
    const e = this.e;
    const h = e._call(() => e._withBytes(Uint8Array.from(order),
      (ptr, n) => e._out(e.x.tg_game_reordered(this.h, p, ptr, n))));
    return new Game(e, Number(h));
  }

  free() {
    if (this.h !== null && !this.e.broken) this.e.x.tg_game_free(this.h);
    this.h = null;
  }
}
