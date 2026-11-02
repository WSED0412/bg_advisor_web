import test from 'node:test';
import assert from 'node:assert/strict';
import { anonymize } from '../web/js/share.js';

test('anonymize removes the BattleTag everywhere and keeps other players', () => {
  const r = { key: '12_34_56_7_Ed_1234', player: 'Ed#1234',
              rounds: [{ round: 1, me: { name: 'Ed#1234' }, text: 'Ed vs Bob' }] };
  const a = anonymize(r);
  assert.equal(a.player, 'Player');
  assert.equal(a.key, '12_34_56_7_player');
  assert.equal(a.rounds[0].me.name, 'Player');
  assert.equal(a.rounds[0].text, 'Player vs Bob');
  assert.equal(r.player, 'Ed#1234', 'input is not modified');
  assert.ok(!JSON.stringify(a).includes('Ed'));
});

test('anonymize leaves other words that contain the name alone', () => {
  const r = { key: 'k_Ed_1234', player: 'Ed#1234',
              rounds: [{ round: 1, text: 'Edwin VanCleef, Shredder; Ed played (Ed)' }] };
  assert.equal(anonymize(r).rounds[0].text, 'Edwin VanCleef, Shredder; Player played (Player)');
});

test('anonymize handles names with regex characters and non-Latin names', () => {
  const r = { key: 'k', player: '小明.+#5678', rounds: [{ round: 1, text: '小明.+ 對上 小明X' }] };
  assert.equal(anonymize(r).rounds[0].text, 'Player 對上 小明X');
});
