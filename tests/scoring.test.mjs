// Golden test: the same fixtures are checked by the Python implementation (bg_advisor repo).
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { grade, rankKey, isHopeless } from '../web/js/scoring.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/scoring.json', import.meta.url), 'utf8'));

test('grade and rankKey match the Python implementation', () => {
  for (const [i, c] of cases.entries()) {
    assert.equal(isHopeless([c.mine, c.best]), c.hopeless, `case ${i} hopeless`);
    const g = grade(c.mine, c.best, c.hopeless);
    assert.equal(g.score, c.grade.score, `case ${i} score`);
    assert.equal(g.verdict, c.grade.verdict, `case ${i} verdict`);
    assert.equal(g.mode, c.grade.mode, `case ${i} mode`);
    assert.ok(Math.abs(g.gap - c.grade.gap) < 1e-9, `case ${i} gap`);
    assert.deepEqual(rankKey(c.mine, c.hopeless), c.rank_mine, `case ${i} rankKey`);
  }
});
