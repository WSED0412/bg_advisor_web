// Export reports to a JSON file and import them back (to move them, or to share them).
//
// File: {"app": "bg_advisor_web", "kind": "reports", "version": 1, "exported": ISO time,
//        "reports": [report, ...]}. A bare report or a list of reports is read too.
//
// An imported file may come from anyone, so every report is checked and cleaned before it is
// stored: the report pages put some fields into HTML unescaped (numbers they expect), so no
// string may carry the characters that could open a tag or leave an attribute.

const KEY_RE = /^[A-Za-z0-9_]{1,200}$/;
const UNSAFE = { '<': '＜', '>': '＞', '"': '＂', '`': '｀' };

/** Copy of a JSON value with the unsafe characters of every string replaced. */
function clean(v, depth = 0) {
  if (depth > 40) throw new Error('too deep');
  if (typeof v === 'string') return v.replace(/[<>"`]/g, c => UNSAFE[c]);
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v === null || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(x => clean(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = clean(x, depth + 1);
    }
    return out;
  }
  return null;
}

/** A report that looks complete enough to be shown, or null. */
function validReport(r) {
  return r && typeof r === 'object' && !Array.isArray(r) && typeof r.key === 'string' && KEY_RE.test(r.key)
    && Array.isArray(r.rounds) && r.rounds.every(x => x && typeof x === 'object' && Number.isInteger(x.round))
    && (r.summary === undefined || (r.summary && typeof r.summary === 'object'));
}

/** {reports: [cleaned reports], bad: number of entries that are not reports}. Throws on bad JSON. */
export function readExport(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data && Array.isArray(data.reports) ? data.reports : [data];
  const reports = [];
  let bad = 0;
  for (const r of list) {
    if (!validReport(r)) { bad += 1; continue; }
    const c = clean(r);
    if (validReport(c)) reports.push(c);
    else bad += 1;
  }
  return { reports, bad };
}

const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Copy of a value with every string's whole-word occurrences of `names` replaced by `to`: a
 * name counts only when no letter, digit or _ touches it ("Ed vs Bob", "Ed#1234"), so a short
 * name never eats into other words ("Edwin", "Shred").
 */
function replaceNames(v, names, to) {
  if (!names.length) return v;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${names.map(reEscape).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  const walk = x => {
    if (typeof x === 'string') return x.replace(re, to);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const out = {};
      for (const [k, y] of Object.entries(x)) out[k] = walk(y);
      return out;
    }
    return x;
  };
  return walk(v);
}

/**
 * Copy of a report with the player's BattleTag removed: the name (with and without its #1234),
 * and the same name inside the report key. Other players' names are not touched.
 */
export function anonymize(report) {
  const player = typeof report.player === 'string' ? report.player : '';
  if (!player) return report;
  const bare = player.split('#')[0];
  const keyForm = s => s.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '');
  // Longest first, so "Name#1234" goes before "Name".
  const names = [...new Set([player, bare].filter(Boolean))].sort((a, b) => b.length - a.length);
  const out = replaceNames(report, names, 'Player');
  const pk = keyForm(player);
  if (pk && typeof report.key === 'string' && report.key.endsWith(pk)) out.key = report.key.slice(0, -pk.length) + 'player';
  out.player = 'Player';
  return out;
}

/** Let the browser save these reports as a JSON file. */
export function downloadReports(reports, name) {
  const data = { app: 'bg_advisor_web', kind: 'reports', version: 1, exported: new Date().toISOString(), reports };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** File-name-safe date: 2026-11-02. */
export function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
