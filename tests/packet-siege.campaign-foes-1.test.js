// tests/packet-siege.campaign-foes-1.test.js
// Packet Siege, levels 51-150: contract 5 of phase 4 for the twelve new
// enemies (see packet-siege.campaign.test.js and, for the band,
// packet-siege.campaign-rules-1.test.js): on the level that introduces it the
// reference bot, over the band of toughness values, wins clearly more often
// with the enemy taken out of the level.  An enemy that does not show that
// is named in WEAK of _packet-siege-band.js (and pinned all the same, so a
// change shows).  The enemies are split over shards campaign-foes-1 to -4
// (SHARDS of _packet-siege-band.js); this one also checks that every new
// enemy is pinned.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pks, CAMPAIGN, WEAK, enemyTests } = require('./_packet-siege-band');

test('packet-siege campaign: contract 5 — every new enemy is pinned on its first level', () => {
  assert.deepEqual(CAMPAIGN.enemies.map(([id]) => id), pks.pksEnemies.slice(13).map((e) => e.id));
  for (const id of WEAK) assert.ok(pks.pksEnemy[id], id);
});

enemyTests(__filename);
