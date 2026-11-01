// A simulation worker: runs chunks of jobs on its own TavernGym instance.

import { Engine } from './engine.js';
import { StepError, parseState, previewOf, runJob } from './simcore.js';
import { EngineError } from './engine.js';

let engine = null;
let module = null;

async function fresh() {
  engine = await Engine.create(module);
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    module = msg.module;
    await fresh();
    self.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'state') {
    if (engine.broken) await fresh();
    let res;
    try {
      const g = engine.fromJson(msg.json);
      try {
        res = [msg.id, previewOf(g, msg.n), null];
      } finally {
        g.free();
      }
    } catch (e) {
      res = [msg.id, null, `${e.name}: ${e.message}`];
    }
    self.postMessage({ type: 'done', chunkId: msg.chunkId, out: res });
    return;
  }
  if (msg.type !== 'chunk') return;
  const { baseJson, jobs, n, chunkId } = msg;
  const base = parseState(baseJson);
  const out = [];
  for (const job of jobs) {
    if (engine.broken) await fresh();
    try {
      out.push([job.id, runJob(engine, base, baseJson, job, n), null]);
    } catch (e) {
      // Expected failures carry just their message (as in the Python version).
      const known = e instanceof StepError || e instanceof EngineError;
      out.push([job.id, null, known ? e.message : `${e.name}: ${e.message}`]);
    }
  }
  self.postMessage({ type: 'done', chunkId, out });
};
