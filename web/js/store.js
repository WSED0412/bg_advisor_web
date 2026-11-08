// Reports and settings in IndexedDB (they stay in this browser only).

const DB = 'bg_advisor';
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('games', { keyPath: 'key' });
        db.createObjectStore('kv');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbp = null; };  // let a newer page upgrade it
        db.onclose = () => { dbp = null; };                     // closed by the browser: open again
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab of this page'));
    });
    // A failure (private window, a disk hiccup, another tab) is not kept: the next call tries again.
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    // Some failures (storage full, eviction) only abort the transaction.
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
}

export const saveGame = res => tx('games', 'readwrite', s => s.put(res));
export const getGame = key => tx('games', 'readonly', s => s.get(key));
export const deleteGame = key => tx('games', 'readwrite', s => s.delete(key));
export const allGames = async () => {
  const games = await tx('games', 'readonly', s => s.getAll());
  return games.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
};
export const gameKeys = () => tx('games', 'readonly', s => s.getAllKeys());
export const getKV = key => tx('kv', 'readonly', s => s.get(key)).catch(() => undefined);
export const setKV = (key, value) => tx('kv', 'readwrite', s => s.put(value, key));

// Reports the player deleted: not brought back by a sync or reviewed again automatically.
const DELETED = 'deletedKeys';
export async function deletedKeys() {
  const v = await getKV(DELETED);
  return new Set(Array.isArray(v) ? v : []);
}
export async function markDeleted(key) {
  const keys = await deletedKeys();
  if (!keys.has(key)) await setKV(DELETED, [...keys, key]);
}
export async function unmarkDeleted(key) {
  const keys = await deletedKeys();
  if (keys.delete(key)) await setKV(DELETED, [...keys]);
}
