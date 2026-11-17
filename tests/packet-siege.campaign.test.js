// tests/packet-siege.campaign.test.js
// Packet Siege, levels 51-150: the campaign contract of phase 4
// (.claude/packet-siege/spec-150.md, "Balance"), part 1: the budgets, the
// reference bot on levels 51-100 and the boss levels 60-100.  Part 2
// (packet-siege.campaign-late.test.js) plays the bot on 101-150, part 3
// (packet-siege.campaign-players.test.js) the slow bot, the players who must
// lose, the exploits and the end of every level; contract 5, what every zone
// rule, new defender and new enemy is worth, is measured over a band of
// toughness values in packet-siege.campaign-rules, -cards and -foes.  The
// players are the ones of packet-siege.sim.test.js (its players block), as
// tune.js reads them; the pins of all of them are in
// packet-siege.campaign.pins.json, measured by .claude/packet-siege/tune.js
// --pins (its header says how to re-measure).  Split so that each runs in
// well under a minute in its own process.
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
const HALF = range(51, 100);
const memo = {};
const once = (key, fn) => (memo[key] = memo[key] || fn());

// The bot on 51-100, once.
const bot = () => once('bot', () => HALF.map((n) => PLAYERS.playBot(n)));

test('packet-siege campaign: contract 1 (51-150) — the threat budget rises strictly from level 49 over every non-boss level; a boss level brings a smaller escort and its boss', () => {
  let last = pks.pksLevel(49).budget;
  for (let n = 51; n <= 150; n++) {
    const lv = pks.pksLevel(n);
    if (n % 10 === 0) {
      assert.equal(lv.boss, n / 10);
      assert.ok(lv.budget < last, n + ' escort ' + lv.budget + ' under ' + last);
      continue;
    }
    assert.ok(lv.budget > last, 'level ' + n + ': ' + lv.budget + ' after ' + last);
    last = lv.budget;
  }
  assert.deepEqual(range(51, 150).map((n) => pks.pksLevel(n).budget), CAMPAIGN.budgets, 'the budgets tune.js fitted');
});

test('packet-siege campaign: contract 1b — a boss level is at least as demanding as the level before it: at a toughness the level before is still won with, the boss level is lost', () => {
  for (const n of [60, 70, 80, 90, 100]) {
    const [k, think] = CAMPAIGN.bossDemand[n];
    assert.equal(PLAYERS.playBot(n - 1, { tough: k, think }).won, true, (n - 1) + ' at ' + k);
    assert.equal(PLAYERS.playBot(n, { tough: k, think }).won, false, n + ' at ' + k);
  }
});

test('packet-siege campaign: contract 2 (51-100) — the reference bot wins every level with only what is unlocked and the level\'s slots, the pinned stars, its breakers mostly in the last third', () => {
  const res = bot();
  for (const n of HALF) {
    const r = res[n - 51];
    const owned = pks.pksUnlockedDefenders(n - 1);
    assert.ok(r.loadout.length <= pks.pksSlots(n), n + ' slots');
    for (const id of r.loadout) assert.ok(owned.includes(id), n + ' ' + id + ' is unlocked');
    assert.equal(r.won, true, 'level ' + n);
    assert.ok(r.sim.time < r.sim.level.duration + C.OVERTIME, n + ' ended in time');
  }
  assert.equal(res.map((r) => r.stars).join(''), CAMPAIGN.botStars.slice(0, 50));
  const trips = [];
  for (const n of HALF) for (const at of res[n - 51].tripped) trips.push(at / pks.pksLevel(n).duration);
  assert.ok(trips.filter((f) => f >= 2 / 3).length >= 0.75 * trips.length, 'late trips: ' + trips.map((f) => f.toFixed(2)).join(' '));
});

test('packet-siege campaign: contract 2 (51-150) — the pinned stars average 2+ in every zone and never rise from one zone to the next from zone 5 on', () => {
  // zone 5 is the bot's levels 41-50 (BOT_STARS of packet-siege.sim.test.js)
  const zone5 = SIM_TEST.match(/const BOT_STARS = '(\d{50})'/)[1].slice(40);
  const stars = zone5 + CAMPAIGN.botStars;
  assert.equal(stars.length, 110);
  const avg = range(0, 10).map((z) => [...stars.slice(z * 10, z * 10 + 10)].reduce((a, c) => a + Number(c), 0) / 10);
  for (let z = 1; z <= 10; z++) {
    assert.ok(avg[z] >= 2, 'zone ' + (z + 5) + ': ' + avg[z]);
    assert.ok(avg[z] <= avg[z - 1], 'zone ' + (z + 5) + ' ' + avg[z] + ' after ' + avg[z - 1]);
  }
  assert.ok(!stars.includes('0') && !stars.includes('1'), 'never a loss, never a single star');
});

test('packet-siege campaign: contract 2 (51-100) — no razor-thin margin: the bot still wins with every enemy 10 % tougher (sampled: every odd level and every boss level; tune.js --fit checks them all)', () => {
  for (const n of HALF.filter((m) => m % 2 === 1 || m % 10 === 0)) assert.equal(PLAYERS.playBot(n, { tough: CAMPAIGN.hard }).won, true, 'level ' + n);
});
