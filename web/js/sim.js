// A pool of simulation workers, each with its own TavernGym instance.

import { outcomeOf } from './scoring.js';

export class SimPool {
  /** @param module compiled WebAssembly.Module of the engine */
  static async create(module, workers = null) {
    const n = workers || Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 1));
    const pool = new SimPool(n);
    await Promise.all(pool.workers.map(w => new Promise((resolve, reject) => {
      w.onmessage = ev => (ev.data.type === 'ready' ? resolve() : null);
      w.onerror = e => reject(new Error(`模擬 worker 無法啟動：${e.message || e}`));
      w.postMessage({ type: 'init', module });
    })));
    for (const w of pool.workers) {
      w.onmessage = ev => pool._done(w, ev.data);
      w.onerror = e => pool._fail(w, e);
    }
    return pool;
  }

  constructor(n) {
    this.size = n;
    this.workers = Array.from({ length: n }, () =>
      new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' }));
    this.idle = [...this.workers];
    this.queue = [];
    this.waiting = new Map();  // chunkId -> {resolve, reject}
    this.busy = new Map();     // worker -> chunkId
    this.nextId = 1;
  }

  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const msg = this.queue.shift();
      this.busy.set(w, msg.chunkId);
      w.postMessage(msg);
    }
  }

  _done(w, data) {
    if (data.type !== 'done') return;
    this.busy.delete(w);
    this.idle.push(w);
    const p = this.waiting.get(data.chunkId);
    this.waiting.delete(data.chunkId);
    if (p) p.resolve(data.out);
    this._pump();
  }

  _fail(w, e) {
    const msg = `模擬失敗：${(e && e.message) || e}`;
    const id = this.busy.get(w);
    this.busy.delete(w);
    // The crashed worker leaves the pool for good; the others keep taking queued chunks.
    w.terminate();
    this.workers = this.workers.filter(x => x !== w);
    this.idle = this.idle.filter(x => x !== w);
    const p = this.waiting.get(id);
    this.waiting.delete(id);
    if (p) p.reject(new Error(msg));
    if (!this.workers.length) {
      // Nobody is left to run the rest: fail it now instead of waiting forever.
      for (const job of this.queue) {
        const q = this.waiting.get(job.chunkId);
        this.waiting.delete(job.chunkId);
        if (q) q.reject(new Error(msg));
      }
      this.queue = [];
    } else {
      this._pump();
    }
  }

  _chunk(baseJson, jobs, n) {
    const chunkId = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(chunkId, { resolve, reject });
      this.queue.push({ type: 'chunk', chunkId, baseJson, jobs, n });
      this._pump();
    });
  }

  /** {job id: outcome} or {job id: error string} for jobs that could not run. */
  async run(game, jobs, n) {
    if (!jobs.length) return new Map();
    n = Math.max(1, Math.min(Math.trunc(n), 5000));  // combat_preview caps n at 5000
    const baseJson = typeof game === 'string' ? game : game.stateJson();
    const k = this.size * 4;
    const size = Math.max(1, Math.ceil(jobs.length / k));
    const parts = [];
    for (let i = 0; i < jobs.length; i += size) parts.push(this._chunk(baseJson, jobs.slice(i, i + size), n));
    // Results in job order, so ties always rank the same way.
    const out = new Map();
    for (const chunk of await Promise.all(parts)) {
      for (const [id, r, err] of chunk) out.set(id, r !== null ? outcomeOf(r) : err);
    }
    return out;
  }

  /** {id: outcome} for whole scenes (Map id -> state JSON), each fought as it stands. */
  async runStates(states, n) {
    const out = new Map();
    if (!states.size) return out;
    n = Math.max(1, Math.min(Math.trunc(n), 5000));
    const parts = [...states].map(([id, json]) => {
      const chunkId = this.nextId++;
      return new Promise((resolve, reject) => {
        this.waiting.set(chunkId, { resolve, reject });
        this.queue.push({ type: 'state', chunkId, id, json, n });
        this._pump();
      });
    });
    for (const [id, r, err] of await Promise.all(parts)) out.set(id, r !== null ? outcomeOf(r) : err);
    return out;
  }

  close() {
    for (const w of this.workers) w.terminate();
  }
}
