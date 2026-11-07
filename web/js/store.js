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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
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
