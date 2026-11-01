// Card lookup: a CardID ("BG28_300") or a name (English, Simplified or Traditional Chinese).
// The catalogue comes from the engine itself; Traditional Chinese names from data/names_zhTW.json.

let byId = null;
let byName = null;
let tw = {};

export function initCards(catalog, namesZhTW) {
  tw = namesZhTW || {};
  byId = new Map();
  byName = new Map();
  for (const c of catalog) {
    byId.set(c.id, c);
    for (const key of [c.name, c.name_zh, tw[c.id]]) {
      if (!key) continue;
      const k = key.toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(c);
    }
  }
}

export function card(id) {
  return byId.get(id);
}

export function hasCard(id) {
  return byId.has(id);
}

function rank(c) {
  // Prefer cards that can appear in a lobby, normal over golden copies, real Battlegrounds
  // ids over tutorial/test variants.
  const id = c.id;
  return [!c.reachable, !!c.normal_id, id.includes('Tutorial'),
          !(id.startsWith('BG') || id.startsWith('TB_Bacon')), id];
}

function cmpTuple(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/** The card record for a CardID or a name; throws if unknown. */
export function resolve(cardRef, kind = null) {
  if (byId.has(cardRef)) return byId.get(cardRef);
  let hits = byName.get(String(cardRef).toLowerCase()) || [];
  if (kind) hits = hits.filter(c => c.kind === kind);
  if (!hits.length) throw new Error(`unknown card: ${cardRef}`);
  return [...hits].sort((a, b) => cmpTuple(rank(a), rank(b)))[0];
}

/** Traditional Chinese name, else English, else the id. */
export function nameOf(id) {
  if (tw[id]) return tw[id];
  const c = byId.get(id);
  return c ? c.name : id;
}
