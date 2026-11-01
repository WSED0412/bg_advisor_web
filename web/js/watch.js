// Watching Hearthstone's Logs folder (File System Access API, Chrome / Edge).
//
// Hearthstone writes one folder per client session (Logs/Hearthstone_YYYY_MM_DD_HH_MM_SS/)
// holding Power.log. The watcher reads only the bytes appended since its last look and reports
// a log in which a game ended (GameEntity STATE=COMPLETE).

const GAME_OVER = 'GameEntity tag=STATE value=COMPLETE';
const RECENT_SESSIONS = 3;

export const canWatch = () => typeof window.showDirectoryPicker === 'function';

/** Power.log files under `dir` (the Logs folder, one session folder, or Hearthstone's folder). */
export async function findLogs(dir, recentOnly = false) {
  const out = [];
  async function walk(d, path, depth) {
    const subdirs = [];
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'file' && /^Power.*\.log$/i.test(name)) out.push({ handle: h, source: path ? `${path}/${name}` : name });
      else if (h.kind === 'directory' && depth < 2) subdirs.push([name, h]);
    }
    subdirs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    let list = subdirs;
    if (recentOnly) {
      // Session folders sort by time; only recent ones can still be written.
      const sessions = subdirs.filter(([n]) => n.startsWith('Hearthstone_'));
      list = [...subdirs.filter(([n]) => !n.startsWith('Hearthstone_')), ...sessions.slice(-RECENT_SESSIONS)];
    }
    for (const [name, h] of list) await walk(h, path ? `${path}/${name}` : name, depth + 1);
  }
  await walk(dir, dir.name, 0);
  // Oldest first, by session folder name then file name.
  return out.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

export class LogWatcher {
  constructor(dir) {
    this.dir = dir;
    this.offsets = new Map();   // source -> bytes already seen
    this.carry = new Map();     // source -> partial last line
    this.dec = new TextDecoder();
  }

  /** Start from what is in the logs now (older games are handled by the backfill). */
  async start() {
    for (const f of await findLogs(this.dir, true)) {
      try { this.offsets.set(f.source, (await f.handle.getFile()).size); } catch { /* next poll */ }
    }
  }

  /** Logs in which a game ended since the last call: [{handle, source}]. */
  async poll() {
    const hits = [];
    for (const f of await findLogs(this.dir, true)) {
      let file;
      try { file = await f.handle.getFile(); } catch { continue; }
      let start = this.offsets.get(f.source) ?? 0;
      if (file.size < start) { start = 0; this.carry.set(f.source, ''); }  // started over
      if (file.size === start) continue;
      let text;
      try {
        text = this.dec.decode(await file.slice(start, file.size).arrayBuffer());
      } catch {
        continue;  // the client wrote meanwhile; read again next time
      }
      this.offsets.set(f.source, file.size);
      text = (this.carry.get(f.source) || '') + text;
      const cut = text.lastIndexOf('\n') + 1;
      this.carry.set(f.source, text.slice(cut).slice(-4096));
      if (text.slice(0, cut).split('\n').some(l => l.includes(GAME_OVER) && l.includes('GameState.'))) hits.push(f);
    }
    return hits;
  }
}
