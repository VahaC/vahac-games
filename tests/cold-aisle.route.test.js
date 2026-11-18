// tests/cold-aisle.route.test.js
// Cold Aisle's nine levels played through the real cdaStep by the scripted
// players of tests/_cold-aisle-bot.js, every run from the level's bare kit
// (cdaLevelCarry(n, null)) with no upgrades:
//   reference  wins every level; its final state and result are pinned
//              (PINS: a change in the sim, the tables or a level shows here;
//              after a deliberate change run with CDA_PIN=1 to print the new
//              pins and paste them);
//   novice     wins every level on every seed of NOVICE_SEEDS, and on levels
//              1-3 ends with at least half its health and never drops below
//              NOVICE_FLOOR;
//   idle       (stands still) dies on every level except the ones whose start
//              is quiet on purpose (IDLE_SAFE).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadScript } = require('./_setup');
const { play, createBot } = require('./_cold-aisle-bot');

const cda = loadScript('cold-aisle/script.js');
const LEVELS = cda.CDA_LEVELS;

const NOVICE_SEEDS = [1, 2, 3, 4, 5];
const NOVICE_FLOOR = 15;
// Level 1 starts on the loading dock where no enemy can see the player: the
// first minute is for moving, a door and the probe.
const IDLE_SAFE = ['Loading Dock'];
const IDLE_TIME = 120;

// The reference bot's run per level: [ticks, kills, health, hash of the final sim].
const PINS = [
  [2962, 2, 100, 'e309f5f1b26b5e9a'],  // Loading Dock
  [6316, 11, 100, '2f6b1b1ca2b742f4'],  // Meet-Me Room
  [7544, 12, 100, 'f4f2d803c97af115'],  // Cold Aisle A
  [9451, 10, 100, '0fbfb8634c00dd66'],  // Hot Aisle
  [10361, 13, 100, 'a6dcbb5b141d90a7'],  // Tape Vault
  [9175, 16, 100, '8c07f8b333f3cab2'],  // UPS Hall
  [16677, 32, 100, '8bf1f58a04bc41c2'],  // Cable Vault
  [19282, 28, 100, 'f9e8b86734319aec'],  // NOC
  [11354, 3, 100, '47f423abec1110dd'],  // Chiller Plant
];

const hash = (sim) => crypto.createHash('sha256').update(JSON.stringify(sim)).digest('hex').slice(0, 16);

if (process.env.CDA_PIN) {
  const lines = LEVELS.map((L, n) => {
    const r = play(cda, n, 'reference');
    return '  [' + r.sim.tick + ', ' + r.kills + ', ' + r.health + ', \'' + hash(r.sim) + '\'],  // ' + L.name;
  });
  console.log('const PINS = [\n' + lines.join('\n') + '\n];');
}

for (let n = 0; n < LEVELS.length; n++) {
  const name = LEVELS[n].name;

  test('cold-aisle route ' + (n + 1) + ' ' + name + ': the reference bot wins from the bare kit, its run pinned', () => {
    const r = play(cda, n, 'reference');
    assert.equal(r.status, 'won', name + ': ' + JSON.stringify(r.diedAt) + ' racks left ' + r.racksLeft);
    assert.ok(r.health > 0);
    assert.deepEqual([r.sim.tick, r.kills, r.health, hash(r.sim)], PINS[n], name + ' (CDA_PIN=1 prints the pins)');
  });

  test('cold-aisle route ' + (n + 1) + ' ' + name + ': the novice wins on every seed' + (n < 3 ? ', keeping half its health' : ''), () => {
    for (const seed of NOVICE_SEEDS) {
      const r = play(cda, n, 'novice', { seed });
      assert.equal(r.status, 'won', name + ' seed ' + seed + ': ' + JSON.stringify(r.diedAt) + ' racks left ' + r.racksLeft);
      assert.equal(r.secrets, 0, 'the novice never opens a secret');
      if (n < 3) {
        assert.ok(r.health >= r.sim.player.maxHealth / 2, name + ' seed ' + seed + ' ends with ' + r.health);
        assert.ok(r.minHealth >= NOVICE_FLOOR, name + ' seed ' + seed + ' drops to ' + r.minHealth);
      }
    }
  });

  const safe = IDLE_SAFE.includes(name);
  test('cold-aisle route ' + (n + 1) + ' ' + name + ': a player who stands still ' + (safe ? 'is safe (a quiet start)' : 'dies'), () => {
    const r = play(cda, n, 'idle', { maxTime: IDLE_TIME });
    if (safe) {
      assert.equal(r.status, 'playing');
      assert.equal(r.health, r.sim.player.maxHealth);
      assert.ok(r.sim.enemies.every((e) => e.state === 'asleep'), 'nobody even woke');
    } else {
      assert.equal(r.status, 'dead', name + ' idle survived ' + IDLE_TIME + ' s');
    }
  });
}

test('cold-aisle route: the bots only read the sim; they drive it through the input alone', () => {
  for (const kind of ['reference', 'novice']) {
    const lv = cda.cdaParseLevel(LEVELS[7]);
    const sim = cda.cdaNewSim(lv, cda.cdaLevelCarry(7, null), {}, 3);
    const bot = createBot(cda, kind, 3);
    const keys = Object.keys(cda.cdaInputNew()).sort();
    for (let i = 0; i < 1800 && sim.status === 'playing'; i++) {
      const before = JSON.stringify(sim);
      const inp = bot.input(sim);
      assert.equal(JSON.stringify(sim), before, kind + ' step ' + i);
      assert.deepEqual(Object.keys(inp).sort(), keys);
      assert.ok(Math.abs(inp.turn) <= 10 / cda.CDA_RATE + 1e-9 && Math.abs(inp.move) <= 1 + 1e-9 && Math.abs(inp.strafe) <= 1 + 1e-9);
      cda.cdaStep(sim, inp);
    }
  }
});
