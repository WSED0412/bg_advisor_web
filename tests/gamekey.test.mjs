// Game ids: the same cases (fixtures/gamekey.json) are checked by the Python version
// (bg_advisor repo, tests/test_gamekey.py), so both give every game the same id.
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gameDay, keyOf, gameKey, gameDate, migrateReport } from '../web/js/gamekey.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/gamekey.json', import.meta.url), 'utf8'));

test('ids and dates match the Python version', () => {
  for (const c of cases.keys) {
    const day = gameDay(c.source, c.start, c.fallback);
    assert.equal(keyOf(day, c.start), c.key, JSON.stringify(c));
    assert.equal(gameKey({ source: c.source, start: c.start }, c.fallback), c.key);
    assert.equal(gameDate({ source: c.source, start: c.start }, c.fallback), c.date);
  }
});

test('older ids migrate as in the Python version', () => {
  for (const c of cases.migrate) {
    const m = migrateReport(c.report);
    assert.deepEqual(m ? [m.key, m.date] : [null, null], [c.key, c.date], JSON.stringify(c));
    if (m) assert.equal(m.source, c.report.source);  // the rest of the report is kept
  }
});
