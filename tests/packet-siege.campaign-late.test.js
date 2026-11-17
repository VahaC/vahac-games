// tests/packet-siege.campaign-late.test.js
// Packet Siege, levels 51-150: the campaign contract of phase 4, part 2 of 3
// (see packet-siege.campaign.test.js): the reference bot on levels 101-150
// (their boss levels are in packet-siege.campaign-bosses.test.js, their
// margin in packet-siege.campaign-margin.test.js).
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
const C = pks.pksConstants;
const CAMPAIGN = require('./packet-siege.campaign.pins.json');

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const HALF = range(101, 150);
const memo = {};
const once = (key, fn) => (memo[key] = memo[key] || fn());
const bot = () => once('bot', () => HALF.map((n) => PLAYERS.playBot(n)));

test('packet-siege campaign: contract 2 (101-150) — the reference bot wins every level with only what is unlocked and the level\'s slots, the pinned stars, its breakers mostly in the last third', () => {
  const res = bot();
  for (const n of HALF) {
    const r = res[n - 101];
    const owned = pks.pksUnlockedDefenders(n - 1);
    assert.ok(r.loadout.length <= pks.pksSlots(n), n + ' slots');
    for (const id of r.loadout) assert.ok(owned.includes(id), n + ' ' + id + ' is unlocked');
    assert.equal(r.won, true, 'level ' + n);
    assert.ok(r.sim.time < r.sim.level.duration + C.OVERTIME, n + ' ended in time');
  }
  assert.equal(res.map((r) => r.stars).join(''), CAMPAIGN.botStars.slice(50));
  const trips = [];
  for (const n of HALF) for (const at of res[n - 101].tripped) trips.push(at / pks.pksLevel(n).duration);
  assert.ok(trips.filter((f) => f >= 2 / 3).length >= 0.75 * trips.length, 'late trips: ' + trips.map((f) => f.toFixed(2)).join(' '));
});
