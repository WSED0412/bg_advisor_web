// Golden test of the log parser on the test games: the fixture is written by the Python version
// (bg_advisor repo: python -m tests.test_parse_golden --write --web <this repo>), which checks
// it too, so the two parsers cannot drift apart unnoticed. catalog.json.gz is TavernGym's card
// catalog (the same data the wasm build carries); write both again after a card data update.
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { initCards, card } from '../web/js/cards.js';
import { readGames, cardChanges, mergeReconnects } from '../web/js/bglog.js';
import { discoverPool } from '../web/js/luck.js';

const fixture = name => new URL(`./fixtures/${name}`, import.meta.url);
const catalog = JSON.parse(gunzipSync(readFileSync(fixture('catalog.json.gz'))).toString('utf8'));
const skins = JSON.parse(readFileSync(new URL('../web/data/hero_skins.json', import.meta.url), 'utf8'));
initCards(catalog, {}, skins);

// The order the Python test reads them in.
const LOGS = ['Hearthstone_2026_10_20_02_12_05', 'Hearthstone_2026_10_20_02_28_40',
  'Hearthstone_2026_11_01_21_51_40', 'Hearthstone_2026_11_03_03_49_59', 'game3', 'game4'];
const testdata = d => new URL(`../web/testdata/${d}/Power.log`, import.meta.url);

const minion = m => [m.card, m.atk, m.hp, m.keywords, m.entity, m.origin ?? 0];
const side = s => ({ hero: s.hero, hero_power: s.heroPower, health: s.health, armor: s.armor, tier: s.tier,
  trinkets: s.trinkets, spells: s.spells, rewards: s.rewards, stats: s.stats, board: s.board.map(minion) });
const parent = src => src.split('/').slice(-2, -1)[0];

/** Same shape as canonical() in bg_advisor/tests/test_parse_golden.py. */
const canonical = games => games.map(g => ({
  sources: g.source.split(' + ').map(parent),
  build: g.build, start: g.start, complete: g.complete, place: g.place, hero: g.hero, lobby: g.lobby,
  card_changes: g.cardChanges.map(c => [c.card, c.engine, c.client, c.seen]),
  combats: g.combats.map(c => ({ round: c.round, winner: c.winner, damage: c.damage, me: side(c.me), opp: side(c.opp) })),
  plays: g.plays.map(p => ({ round: p.round, seq: p.seq, card: p.card, kind: p.kind, hand: p.handStats,
    before: p.boardBefore.map(m => minion(m).slice(0, 5)), target: p.targetIndex, magnet: p.magnetizedTo,
    position: p.position, entity: p.entity, run: p.run, creator: p.creator, found: p.found })),
  picks: g.picks.map(k => ({ round: k.round, kind: k.kind, source: k.source, chosen: k.chosen, tier: k.tier,
    options: k.options.map(minion) })),
  standings: g.standings.map(s => ({ round: s.round, players: s.players.map(p => [p.pid, p.hero, p.life, p.place, p.me]) })),
}));

test('the parser reads the test games as the Python version does', { skip: !existsSync(testdata(LOGS[0])) }, () => {
  const want = JSON.parse(readFileSync(fixture('parsed_games.json'), 'utf8'));
  const files = LOGS.map(d => ({ text: readFileSync(testdata(d), 'utf8'), source: `testdata/${d}/Power.log` }));
  const got = JSON.parse(JSON.stringify(canonical(readGames(files))));
  assert.equal(got.length, want.length);
  got.forEach((g, i) => {
    for (const k of Object.keys(want[i])) assert.deepEqual(g[k], want[i][k], `game ${i} (${want[i].sources}): ${k}`);
  });
});

// A tiny Battlegrounds log: my hero gains 6 Armor during the fight, then takes 4 damage.
const ARMOR_LOG = `CREATE_GAME
#GameType=GT_BATTLEGROUNDS
#PlayerID=1, PlayerName=Me#1234
    GameEntity EntityID=1
        tag=TURN value=1
    Player EntityID=2 PlayerID=1 GameAccountId=[hi=144115 lo=1]
        tag=HERO_ENTITY value=10
        tag=CONTROLLER value=1
    Player EntityID=3 PlayerID=2 GameAccountId=[hi=0 lo=0]
        tag=HERO_ENTITY value=20
        tag=CONTROLLER value=2
        tag=BACON_DUMMY_PLAYER value=1
    FULL_ENTITY - Creating ID=10 CardID=TB_BaconShop_HERO_16
        tag=CARDTYPE value=HERO
        tag=HEALTH value=30
        tag=CONTROLLER value=1
        tag=ZONE value=PLAY
    FULL_ENTITY - Creating ID=20 CardID=TB_BaconShop_HERO_16
        tag=CARDTYPE value=HERO
        tag=HEALTH value=30
        tag=CONTROLLER value=2
        tag=ZONE value=PLAY
    FULL_ENTITY - Creating ID=30 CardID=BG28_300
        tag=CARDTYPE value=MINION
        tag=ATK value=1
        tag=HEALTH value=1
        tag=CONTROLLER value=1
        tag=ZONE value=PLAY
        tag=ZONE_POSITION value=1
    FULL_ENTITY - Creating ID=40 CardID=BG28_300
        tag=CARDTYPE value=MINION
        tag=ATK value=1
        tag=HEALTH value=1
        tag=CONTROLLER value=2
        tag=ZONE value=PLAY
        tag=ZONE_POSITION value=1
TAG_CHANGE Entity=GameEntity tag=TURN value=2
TAG_CHANGE Entity=GameEntity tag=STEP value=MAIN_START
TAG_CHANGE Entity=10 tag=ARMOR value=6
TAG_CHANGE Entity=10 tag=ARMOR value=2
TAG_CHANGE Entity=GameEntity tag=TURN value=3`;

const logText = body => body.split('\n').map(l => {
  const kind = l.startsWith('#') ? 'Game' : 'Power';
  return `D 01:02:03.0000000 GameState.DebugPrint${kind}() - ${l.replace(/^#/, '')}`;
}).join('\n') + '\n';

test('Armor gained in a fight does not hide a loss', () => {
  const [game] = readGames([{ text: logText(ARMOR_LOG), source: 'x/Power.log' }]);
  assert.equal(game.combats.length, 1);
  assert.deepEqual([game.combats[0].winner, game.combats[0].damage], ['opp', 4]);
});

test('a tier-only change shows even when the minion is also summoned in combat', () => {
  const c = catalog.find(x => x.kind === 'minion' && x.tier >= 2 && x.tier <= 5);
  const lines = (eid, tier) => [
    ['t', 'Power', `FULL_ENTITY - Creating ID=${eid} CardID=${c.id}`],
    ['t', 'Power', 'tag=CARDTYPE value=MINION'],
    ['t', 'Power', `tag=ATK value=${c.atk}`],
    ['t', 'Power', `tag=HEALTH value=${c.hp}`],
    ...(tier ? [['t', 'Power', `tag=TECH_LEVEL value=${tier}`]] : []),
    ['t', 'Power', ''],
  ];
  const hit = cardChanges([...lines(1, c.tier + 1), ...lines(2, 0)]).filter(x => x.card === c.id);
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].client, [c.atk, c.hp, c.tier + 1]);
  assert.equal(cardChanges([...lines(1, c.tier), ...lines(2, 0)]).filter(x => x.card === c.id).length, 0);
});

test('a reconnect keeps the fuller lobby', () => {
  const g = (source, round, lobby, reconnect) => ({ source, player: 'Me', combats: [{ round }], plays: [], picks: [],
    found: [], copied: new Map(), reconnect, standings: [], cardChanges: [], lobby });
  const [m] = mergeReconnects([g('a', 1, ['BEAST', 'MURLOC'], false),
    g('b', 2, ['BEAST', 'DEMON', 'MECHANICAL', 'MURLOC', 'NAGA'], true)]);
  assert.deepEqual(m.lobby, ['BEAST', 'DEMON', 'MECHANICAL', 'MURLOC', 'NAGA']);
});

test('a type Discover draws up to the player\'s tier', () => {
  const src = catalog.find(c => /Discover a Beast\b/.test(c.text || '') && !c.text.includes('Tier'));
  const beasts = catalog.filter(c => c.kind === 'minion' && c.in_pool && c.reachable !== false
    && c.races.length === 1 && c.races[0] === 'BEAST');
  const t2 = beasts.filter(c => c.tier === 2).slice(0, 3);
  assert.equal(t2.length, 3);
  const options = t2.map((c, i) => ({ card: c.id, atk: c.atk, hp: c.hp, keywords: [], entity: i }));
  const lobby = ['BEAST', 'DEMON', 'MECHANICAL', 'MURLOC', 'NAGA'];
  const tiers = pool => new Set(pool.map(id => card(id).tier));
  assert.deepEqual(tiers(discoverPool({ round: 4, kind: 'discover', source: src.id, chosen: 0, options, tier: 5 }, lobby)),
    new Set([1, 2, 3, 4, 5]));
  assert.deepEqual(tiers(discoverPool({ round: 4, kind: 'discover', source: src.id, chosen: 0, options }, lobby)),
    new Set([2]));
});
