// tests/packet-siege.campaign-rules-1.test.js
// Packet Siege, levels 51-150: contract 5 of phase 4 for the zone rules
// (see packet-siege.campaign.test.js): every zone's rule makes its levels
// measurably harder.  Not at one toughness, where the chaos of the sim makes
// any single win or loss a coin flip, but over a band: on one level of each
// zone the reference bot plays with the zone's rules and without them at
// each of the band's toughness values, and wins clearly more often without.
// The level and both counts are pinned in packet-siege.campaign.pins.json
// (.claude/packet-siege/tune.js --bands shows the scans behind them, --pins
// writes them).  The band games of contract 5 are split over shards
// (campaign-rules-1 to -4, campaign-cards, campaign-foes-1 to -4) so that each
// runs in a few seconds; the shared code and the table of which shard plays
// which zones and enemies are in _packet-siege-band.js.  This shard also
// checks the band, that every zone is pinned and that the table covers every
// zone and every new enemy exactly once.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pks, CAMPAIGN, B, bandKs, SHARDS, zoneTests } = require('./_packet-siege-band');

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('packet-siege campaign: contract 5 — a band is 11 toughness values 0.04 apart from 1, 1.2, 1.4 or 1.6, and a gap of 3 wins; one level of every zone 6-15 is pinned', () => {
  assert.deepEqual(bandKs(1), [1, 1.04, 1.08, 1.12, 1.16, 1.2, 1.24, 1.28, 1.32, 1.36, 1.4]);
  assert.deepEqual([B.starts, B.gap], [[1, 1.2, 1.4, 1.6], 3]);
  assert.deepEqual(CAMPAIGN.rules.map(([n]) => Math.ceil(n / 10)), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  for (const [n, from] of CAMPAIGN.rules) assert.ok(n % 10 !== 0 && B.starts.includes(from), n);
});

test('packet-siege campaign: contract 5 — the shards play every zone 6-15 and every new enemy exactly once, and every rules or foes shard on disk is in the table', () => {
  const zones = [];
  const enemies = [];
  for (const [file, s] of Object.entries(SHARDS)) {
    const kind = /^packet-siege\.campaign-(rules|foes)-\d+\.test\.js$/.exec(file);
    assert.ok(kind, file + ' is a rules or foes shard');
    const rules = kind[1] === 'rules';
    assert.deepEqual(Object.keys(s), [rules ? 'zones' : 'enemies'], file);
    assert.ok(s[rules ? 'zones' : 'enemies'].length > 0, file + ' plays something');
    (rules ? zones : enemies).push(...s[rules ? 'zones' : 'enemies']);
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(src.includes((rules ? 'zoneTests' : 'enemyTests') + '(__filename);'), file + ' runs its slice');
  }
  assert.deepEqual(zones.slice().sort((a, b) => a - b), range(6, 15), 'zones: ' + zones.join(' '));
  assert.deepEqual(enemies.slice().sort(), pks.pksEnemies.slice(13).map((e) => e.id).sort(), 'enemies: ' + enemies.join(' '));
  const onDisk = fs.readdirSync(__dirname).filter((n) => /^packet-siege\.campaign-(rules|foes)\b.*\.test\.js$/.test(n));
  assert.deepEqual(onDisk.sort(), Object.keys(SHARDS).sort());
});

zoneTests(__filename);
