// tests/packet-siege.campaign-foes.test.js
// Packet Siege, levels 51-150: contract 5 of phase 4 for the twelve new
// enemies (see packet-siege.campaign.test.js and, for the band,
// packet-siege.campaign-rules.test.js): on the level that introduces it the
// reference bot, over the band of toughness values, wins clearly more often
// with the enemy taken out of the level.  An enemy that does not show that
// is named in WEAK (and pinned all the same, so a change shows).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScript } = require('./_setup');

const pks = loadScript('packet-siege/script.js');
const SIM_TEST = fs.readFileSync(path.join(__dirname, 'packet-siege.sim.test.js'), 'utf8');
// eslint-disable-next-line no-new-func
const PLAYERS = new Function(SIM_TEST.slice(SIM_TEST.indexOf('// ── players ──'), SIM_TEST.indexOf('// ── end players ──')) + '\nreturn players;')()(pks);
const CAMPAIGN = require('./packet-siege.campaign.pins.json');

const B = CAMPAIGN.band;
const bandKs = (from) => Array.from({ length: B.width }, (_, i) => Math.round((from + i * B.step) * 1000) / 1000);
const wins = (n, from, opts) => bandKs(from).filter((k) => PLAYERS.playBot(n, Object.assign({ tough: k }, opts)).won).length;

// The new enemies whose first level does not get clearly harder with them
// (measured 2026-11-17; see the report of the sim review).
const WEAK = ['wiper', 'payload'];

test('packet-siege campaign: contract 5 — every new enemy is pinned on its first level', () => {
  assert.deepEqual(CAMPAIGN.enemies.map(([id]) => id), pks.pksEnemies.slice(13).map((e) => e.id));
  for (const id of WEAK) assert.ok(pks.pksEnemy[id], id);
});

for (const [id, from, good, bad] of CAMPAIGN.enemies) {
  const n = pks.pksEnemy[id].first;
  test('packet-siege campaign: contract 5 — the ' + pks.pksEnemy[id].name + ' matters: over the band the bot wins ' + (WEAK.includes(id) ? 'NOT clearly' : 'clearly') + ' more of level ' + n + ' without it', () => {
    const lv = JSON.parse(JSON.stringify(pks.pksLevel(n)));
    lv.spawns = lv.spawns.filter((s) => s.type !== id);
    assert.ok(pks.pksLevel(n).spawns.some((s) => s.type === id), id + ' on level ' + n);
    const without = wins(n, from, { level: lv });
    const withIt = wins(n, from, {});
    assert.deepEqual([without, withIt], [good, bad], id + ' on ' + n + ': wins without / with it');
    if (WEAK.includes(id)) assert.ok(without - withIt < B.gap, id + ' is no longer weak: take it out of WEAK');
    else assert.ok(without - withIt >= B.gap, id + ' on ' + n + ': ' + without + ' wins without it, ' + withIt + ' with it');
  });
}
