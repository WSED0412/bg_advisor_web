// The id of a game, the same as the Python version's (bg_advisor/gamekey.py):
//
//   20261020_021802_6826019   day the game was played, its start time, the fraction (0.1 µs)
//
// The day comes from the session folder (Hearthstone_2026_10_20_02_12_05), one day later when the
// game started before the folder was made (past midnight); without a folder, the log file's day.
// No player name (reports are shared) and no folder (a log read from the plugin's backup is the
// same game). Older ids migrate: "HH_MM_SS_fffffff_<player>" (this page before 2026-11-08) and
// "<folder>_HH_MM_SS_fffffff" (the Python version).

const FOLDER_RE = /(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})(?:_(\d{2}))?/;
export const NEW_KEY_RE = /^\d{8}_\d{6}_\d+$/;
const OLD_WEB_RE = /^(\d{2})_(\d{2})_(\d{2})_(\d+)/;
const OLD_PY_RE = /(\d{2})_(\d{2})_(\d{2})_(\d+)$/;

const folderOf = src => {
  const parts = src.split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2] : parts[0].replace(/\.[^.]*$/, '');
};

/** 'YYYY-MM-DD' the game was played (see above), else fallbackDay. */
export function gameDay(source, start, fallbackDay = '') {
  const m = FOLDER_RE.exec(folderOf((source || '').split(' + ')[0]));
  if (!m) return fallbackDay;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (start && start.slice(0, 8) < `${m[4]}:${m[5]}:${m[6] || '00'}`) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function keyOf(day, start) {
  const t = start.replace(/\D/g, '');
  return `${day.replace(/-/g, '') || '00000000'}_${t.slice(0, 6)}_${t.slice(6)}`;
}

/** Id of a game read from a log ({source, start}). */
export function gameKey(g, fallbackDay = '') {
  return keyOf(gameDay(g.source, g.start, fallbackDay), g.start);
}

/** 'YYYY-MM-DD HH:MM' the game started (past midnight: the next day). */
export function gameDate(g, fallbackDay = '') {
  return `${gameDay(g.source, g.start, fallbackDay)} ${g.start.slice(0, 5)}`.trim();
}

/** A report saved under an older id, with the new id and date; null if it needs no change. */
export function migrateReport(r) {
  if (!r || typeof r.key !== 'string' || NEW_KEY_RE.test(r.key)) return null;
  const m = OLD_WEB_RE.exec(r.key) || OLD_PY_RE.exec(r.key);
  if (!m) return null;
  const start = `${m[1]}:${m[2]}:${m[3]}.${m[4]}`;
  const day = gameDay(typeof r.source === 'string' ? r.source : '', start,
    typeof r.date === 'string' ? r.date.slice(0, 10) : '');
  return { ...r, key: keyOf(day, start), date: `${day} ${start.slice(0, 5)}`.trim() };
}
