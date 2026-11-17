// tests/packet-siege.expansion.test.js
// Packet Siege, levels 51-150 (.claude/packet-siege/spec-150.md): the freeze
// of levels 1-50, then the twelve new enemies and twelve new defenders of the
// expansion, each rule and its edge cases on hand-made scenarios, their
// interactions with the old units, determinism and plain data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadScript } = require('./_setup');

const pks = loadScript('packet-siege/script.js');

// ── the freeze of levels 1-50 ──────────────────────────────────────────────
// THE OWNER'S RULE (Vasyl, 2026-11-17): levels 1-50 do not change.  These
// hashes were taken from the code before the expansion started; they must
// never be re-pinned.  If this test fails, you changed level 1-50 or one of
// the original rows of the defender, enemy or boss tables: undo that change
// and put new content in new rows and levels 51+ instead.

const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const FROZEN_LEVELS = [
  'aa7ee354f7be5a1b', '205d014ebfeb5136', '3658d9c3b6b9a5ae', 'b2cbfc52df6c1ffc', '39c9bd6b8ea9c101',
  'b5f0073640e8ee3e', '15459c697f4f891b', '69aba187103d17ae', 'ad3f19febdf266b3', '0812852194e8899c',
  'b26039e40f7b3b74', 'a81f53876da69ccb', '098d23c8c2e88457', '0085d138b217e4bb', 'acf6e4b88de5fd11',
  '0a0935fd9cbb180a', '154fbf1ecb6216fb', '299d2b0e140f31b4', 'f40946b5e5f0694a', '46f7bfc7fc4914ec',
  'bf97af6871afa9f0', 'a753d50f54765730', 'b80c531f5ed2c980', '97f18b36356e57b2', '45a9f032f7ee8cbc',
  '2138965587e39fa2', 'e44af1b3983eaf59', '6c683367988b73f5', '88871b8ea2ae4ddc', '703814a172ce37a8',
  'da25295fc3add31f', '3ffe0e9918387abf', 'bcdca5a6bd3c10ce', 'fe60e3d1d4cebdd1', '33aed46a90136bb7',
  'e018a63c1ab86115', '9d59196ba3a457e8', 'a90851f72231ee53', '20731f3be6d811e8', 'f90eec491c1846c2',
  'ffc11c3c5e04fa7d', '85a754ecef2913e8', 'a16afdca757f50cd', 'ef45fd059bc514e0', '9a52b46a4554206c',
  'afe4821109d3aabd', '49d81edb893924f4', '66fc6e1b0878c9db', '3ca2f2e3be6b05a3', '4d01dac1ce58f6d5'
];
const FROZEN_ALL_LEVELS = '61e7004e7543fc303d1634ab4801feabc7adc7fb50276776098dcfa245d219e2';
const FROZEN_DEFENDERS = '6802e6c62751fdffb7139f8647ed6d12658a4b75f4aeb0e4cd5a5c474564bc17';
const FROZEN_ENEMIES = '6276a04d6b95731e835e352482c4a61269b202726f2c7e1fc7855692a05fbf79';
const FROZEN_BOSS_TIERS = '374ab9fb84754178ae6cbcad8b1bf63d15718b654b7f7133b37db7c95ca0750e';
const BROKE = 'THE OWNER\'S RULE IS BROKEN: levels 1-50 must stay exactly as they were before the expansion ' +
  '(.claude/packet-siege/spec-150.md, "Hard rules"). Do not re-pin this hash: undo the change, and put new ' +
  'content in new table rows (after the old ones) and in levels 51+. ';

test('packet-siege expansion: FREEZE — levels 1-50 and the original 15 defenders, 13 enemies and 5 boss tiers are byte-identical to before the expansion', () => {
  const levels = [];
  for (let n = 1; n <= 50; n++) {
    const lv = pks.pksLevel(n);
    levels.push(lv);
    assert.equal(sha(lv).slice(0, 16), FROZEN_LEVELS[n - 1], BROKE + 'pksLevel(' + n + ') changed.');
  }
  assert.equal(sha(levels), FROZEN_ALL_LEVELS, BROKE + 'pksLevel(1..50) changed.');
  assert.equal(sha(pks.pksDefenders.slice(0, 15)), FROZEN_DEFENDERS, BROKE + 'one of the 15 original defender rows changed (or a new row was put before them).');
  assert.equal(sha(pks.pksEnemies.slice(0, 13)), FROZEN_ENEMIES, BROKE + 'one of the 13 original enemy rows changed (or a new row was put before them).');
  assert.equal(sha(pks.pksBossTiers.slice(0, 5)), FROZEN_BOSS_TIERS, BROKE + 'one of the 5 original boss tiers changed (or a new tier was put before them).');
});

// ── helpers (as in packet-siege.sim.test.js, which exports none) ───────────

const C = pks.pksConstants;
const DEF = pks.pksDefender;
const ENEMY = pks.pksEnemy;
const ALL = pks.pksDefenders.map((d) => d.id);
const NEW_DEFENDERS = ALL.slice(15);
const NEW_ENEMIES = pks.pksEnemies.slice(13).map((e) => e.id);
const RATE = 60;
const REACH = C.REACH;

// A hand-made level: five lanes, no trickle, plenty of cycles and one far
// spawn so the sim keeps playing while a test drives it.
function level(over) {
  return Object.assign({
    n: 77, zone: 8, zoneName: 'Test', name: 'Test', lanes: [0, 1, 2, 3, 4], blocked: [], fog: 0,
    trickle: false, startCycles: 100000, slots: 27, speed: 1, boss: 0,
    spawns: [{ t: 9999, lane: 0, type: 'bot' }], surges: [], duration: 600, budget: 1,
    unlock: null, intro: null, hint: null
  }, over);
}

function newSim(over, loadout) {
  return pks.pksNewSim(level(over), loadout || ALL);
}

// Places a defender now, whatever its card's recharge.
function put(sim, type, lane, col) {
  const card = sim.cards.find((c) => c.id === type);
  card.left = 0;
  sim.cycles = Math.max(sim.cycles, card.cost);
  const r = pks.pksPlace(sim, type, lane, col);
  assert.equal(r.ok, true, type + ' on ' + lane + ',' + col + ': ' + r.reason);
  return sim.defenders.find((d) => d.id === r.id);
}

function enemy(sim, type, lane, x) {
  return pks.pksSpawnEnemy(sim, type, lane, x, 0);
}

// An enemy that stays where it is put (speed 0) but still acts.
function still(sim, type, lane, x) {
  const e = enemy(sim, type, lane, x);
  e.speed = 0;
  return e;
}

function boss(sim, tier, lane, x) {
  return pks.pksSpawnEnemy(sim, 'boss', lane, x, tier);
}

// Runs n steps; returns every event of them.
function run(sim, n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    pks.pksStep(sim);
    for (const e of sim.events) events.push(e);
  }
  return events;
}

function until(sim, done, max) {
  let i = 0;
  while (!done(sim) && i < max) {
    pks.pksStep(sim);
    i++;
  }
  assert.ok(done(sim), 'condition reached within ' + max + ' steps');
  return i;
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const alive = (sim, id) => sim.enemies.find((e) => e.id === id);
const standing = (sim, id) => sim.defenders.find((d) => d.id === id);
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ── tables, exports and parts ──────────────────────────────────────────────

test('packet-siege expansion: the 12 new defenders and 12 new enemies follow the old rows, with the spec\'s ids, unlocks and first levels', () => {
  assert.deepEqual(NEW_DEFENDERS, ['canary', 'tracer', 'batch', 'loopback', 'tokenring', 'sigdb', 'sinkhole', 'airgap', 'backup', 'scrubber', 'decryptor', 'honeynet']);
  assert.deepEqual(pks.pksDefenders.slice(15).map((d) => [d.unlock, d.cost, d.hp]), [
    [50, 25, 150], [54, 250, 300], [59, 225, 300], [65, 175, 300], [71, 275, 300], [77, 200, 300],
    [85, 200, 300], [92, 125, 1800], [100, 250, 300], [110, 150, 300], [120, 200, 300], [132, 150, 300]
  ]);
  assert.deepEqual(NEW_ENEMIES, ['keylogger', 'logicbomb', 'amplifier', 'wiper', 'hive', 'hydra', 'payload', 'jammer', 'replicator', 'dropper', 'titan', 'glitch']);
  assert.deepEqual(pks.pksEnemies.slice(13).map((e) => [e.first, e.hp, e.speed]), [
    [52, 350, 0.24], [56, 300, 0.26], [62, 500, 0.18], [67, 250, 0.34], [73, 1200, 0.12], [78, 600, 0.2],
    [84, 500, 0.18], [93, 450, 0.2], [103, 800, 0.2], [112, 700, 0.16], [123, 4000, 0.1], [134, 500, 0.22]
  ]);
  assert.equal(ENEMY.payload.shield, 600);
  assert.equal(ENEMY.titan.name, 'Kernel Panic');
  for (const e of pks.pksEnemies.slice(13)) assert.ok(e.first > 50 && e.threat > 0 && e.bite > 0, e.id);
  for (const d of pks.pksDefenders.slice(16)) assert.ok(d.unlock > 50, d.id);
  // every number a description states comes from its row: the same test as
  // in packet-siege.sim.test.js, run here on the new rows alone
  const numbers = (text) => (text.replace(/3x3/g, '').match(/\d+(\.\d+)?/g) || []).map(Number);
  for (const row of pks.pksDefenders.slice(15).concat(pks.pksEnemies.slice(13))) {
    const own = new Set(Object.values(row).filter((v) => typeof v === 'number'));
    for (const x of numbers(row.desc)) assert.ok(own.has(x), row.id + ': ' + x);
  }
  assert.match(DEF.scrubber.desc, new RegExp('^After a ' + DEF.scrubber.fuse + ' s fuse'));
});

test('packet-siege expansion: exports for the UI: shooter kinds, the slide time, the frozen bounds and pksLevelUnlock', () => {
  assert.deepEqual(pks.pksShooterKinds, ['shooter', 'beam', 'sniper', 'mortar', 'arc', 'decrypt']);
  assert.equal(C.SLIDE_TIME, 0.3);
  assert.equal(C.FROZEN_LEVELS, 50);
  assert.equal(C.FROZEN_DEFENDERS, 15);
  // the level that names a defender in its unlock: every row's level past
  // 50, only the old rows' up to 50 (the Canary, won on 50, is not named)
  assert.equal(pks.pksLevelUnlock(1), 'proxy');
  assert.equal(pks.pksLevelUnlock(44), 'quarantine');
  assert.equal(pks.pksLevelUnlock(50), null);
  assert.equal(pks.pksLevel(50).unlock, null);
  assert.equal(pks.pksLevelUnlock(51), null);
  assert.equal(pks.pksLevelUnlock(54), 'tracer');
  assert.equal(pks.pksLevelUnlock(132), 'honeynet');
  for (const d of pks.pksDefenders.slice(16)) assert.equal(pks.pksLevelUnlock(d.unlock), d.id);
  assert.ok(pks.pksUnlockedDefenders(50).includes('canary'));
  assert.ok(!pks.pksUnlockedDefenders(53).includes('tracer'));
  assert.ok(pks.pksUnlockedDefenders(54).includes('tracer'));
});

test('packet-siege expansion: the new parts sit after sim, are ES5 and pure (no Math.random, no clock, no DOM)', () => {
  const BUILD = require('../packet-siege/build.js');
  const at = (p) => BUILD.PARTS.indexOf(p);
  assert.ok(at('sim') < at('enemies-late') && at('enemies-late') < at('defenders-late') && at('defenders-late') < at('sprites-support'));
  const fs = require('node:fs');
  const path = require('node:path');
  for (const part of ['enemies-late', 'defenders-late']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'packet-siege', 'src', part + '.js'), 'utf8')
      .replace(/'(?:[^'\\n]|\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
    for (const re of [/Math\.random/, /Date\b|performance\.|setTimeout|setInterval/, /\bdocument\b|\bwindow\b/, /\blet\s|\bconst\s|=>|`/]) {
      assert.doesNotMatch(src, re, part);
    }
  }
});

test('packet-siege expansion: new units carry plain state for a renderer from the start', () => {
  const sim = newSim();
  const d = put(sim, 'tracer', 0, 0);
  assert.equal(d.jammed, false);
  assert.equal(d.boosted, false);
  const p = enemy(sim, 'payload', 1, 8);
  assert.deepEqual([p.shield, p.maxShield, p.gen, p.aura, p.amped, p.mended, p.hive, p.moveFrom, p.move, p.knocked], [600, 600, 0, 0, false, -1, 0, -1, 0, 0]);
  assert.equal(enemy(sim, 'replicator', 2, 8).gen, 1);
  assert.equal(enemy(sim, 'hive', 3, 8).t, 5 * RATE, 'a timed ability starts at its row\'s every');
  assert.equal(enemy(sim, 'bot', 4, 8).t, 0);
  assert.deepEqual(sim.shells, []);
  assert.deepEqual(JSON.parse(JSON.stringify(sim)), sim);
});

// ── the new enemies ────────────────────────────────────────────────────────

test('packet-siege expansion: a Keylogger steals 10 cycles a second while it bites, never below 0, and nothing while it walks', () => {
  const sim = newSim();
  const wall = put(sim, 'proxy', 0, 3);
  sim.cycles = 25;
  const k = enemy(sim, 'keylogger', 0, 6);
  assert.equal(ofType(run(sim, 60), 'steal').length, 0, 'walking');
  assert.equal(sim.cycles, 25);
  k.x = 3.5 + REACH;
  let events = run(sim, 60);
  assert.equal(k.state, 'biting');
  const steals = ofType(events, 'steal');
  assert.equal(steals.length, 10);
  assert.deepEqual(steals[0], { type: 'steal', id: k.id, lane: 0, x: k.x, amount: 1 });
  assert.equal(sim.cycles, 15);
  assert.ok(near(wall.hp, 2400 - 100), 'and bites 100 HP/s');
  events = run(sim, 2 * RATE);
  assert.equal(ofType(events, 'steal').length, 15, 'only what there was');
  assert.equal(sim.cycles, 0);
});

test('packet-siege expansion: a Logic Bomb explodes where it dies: 300 to every defender in the 3x3 around its cell, at the end of the step', () => {
  const sim = newSim();
  const wall = put(sim, 'proxy', 2, 3);
  const psu = put(sim, 'psu', 3, 3);
  const fw = put(sim, 'firewall', 1, 5);
  const grate = put(sim, 'waf', 1, 4);
  const out = [put(sim, 'ups', 2, 6), put(sim, 'psu', 0, 4), put(sim, 'psu', 2, 2)];
  const bomb = enemy(sim, 'logicbomb', 2, 3.5 + REACH);
  bomb.hp = 1;
  put(sim, 'failover', 2, 0);
  const events = run(sim, 30);
  const det = ofType(events, 'detonate');
  assert.deepEqual(det, [{ type: 'detonate', id: bomb.id, lane: 2, x: det[0].x, col: 4, dmg: 300 }]);
  assert.ok(wall.hp < 2400 - 299 && wall.hp > 0);
  assert.deepEqual(ofType(events, 'destroyed').filter((d) => d.why === 'blast').map((d) => d.id).sort(), [psu.id, fw.id, grate.id].sort());
  for (const d of out) assert.equal(d.hp, d.maxHp, d.type + ' outside the 3x3');
  // the blast comes after everything else in the step: the kill first
  const kill = events.findIndex((e) => e.type === 'kill' && e.id === bomb.id);
  assert.ok(kill >= 0 && kill < events.indexOf(det[0]));
  // a breaker defuses it; so does dying off the floor
  const sim2 = newSim();
  put(sim2, 'psu', 1, 4);
  const b1 = enemy(sim2, 'logicbomb', 1, 0.001);
  enemy(sim2, 'logicbomb', 1, 1.1);
  const ev2 = run(sim2, 1);
  assert.equal(ofType(ev2, 'breaker').length, 1);
  assert.equal(ofType(ev2, 'kill').filter((k) => k.by === 'breaker').length, 2);
  assert.equal(ofType(ev2, 'detonate').length, 0);
  assert.equal(alive(sim2, b1.id), undefined);
  const sim3 = newSim();
  const fw3 = put(sim3, 'firewall', 4, 7);
  const lure = enemy(sim3, 'bot', 4, 8.5);
  lure.frozen = 1000;
  const far = enemy(sim3, 'logicbomb', 4, 9.4);
  far.frozen = 1000;
  far.hp = 1;
  run(sim3, 1);
  lure.hp = 0; // the shot in the air flies on to the bomb off the floor
  const ev3 = run(sim3, 60);
  assert.ok(ofType(ev3, 'kill').some((k) => k.id === far.id));
  assert.equal(ofType(ev3, 'detonate').length, 0);
  assert.equal(fw3.hp, 300);
});

test('packet-siege expansion: a Logic Bomb killed by a Honeypot leaves the spent Honeypot alone; by the rack its blast stays on the floor', () => {
  const sim = newSim();
  const pot = put(sim, 'honeypot', 0, 4);
  pot.t = 1;
  const wall = put(sim, 'proxy', 1, 4);
  enemy(sim, 'logicbomb', 0, 4.5 + REACH);
  const events = run(sim, 2);
  assert.equal(ofType(events, 'detonate').length, 1);
  assert.deepEqual(ofType(events, 'destroyed').map((d) => [d.id, d.why]), [[pot.id, 'spent']], 'destroyed once');
  assert.ok(near(wall.hp, 2100));
  const sim2 = newSim();
  const psu = put(sim2, 'psu', 0, 0);
  const b = enemy(sim2, 'logicbomb', 0, 0.9);
  b.frozen = 100;
  b.hp = 1;
  put(sim2, 'nullroute', 1, 0);
  const ev2 = run(sim2, 60);
  assert.equal(ofType(ev2, 'detonate')[0].col, 0);
  assert.equal(standing(sim2, psu.id), undefined);
});

test('packet-siege expansion: an Amplifier makes other enemies within 1.5 cells 30 % faster and 30 % tougher; not itself, no stacking, not off the floor or frozen', () => {
  const sim = newSim();
  const amp = still(sim, 'amplifier', 2, 6);
  const inLane = still(sim, 'bot', 2, 7);
  const diag = still(sim, 'bot', 3, 6.5);
  const far = still(sim, 'bot', 2, 7.6);
  const farDiag = still(sim, 'bot', 3, 7.2);
  run(sim, 1);
  assert.deepEqual([amp.amped, inLane.amped, diag.amped, far.amped, farDiag.amped], [false, true, true, false, false]);
  assert.equal(amp.aura, 1.5);
  assert.equal(inLane.aura, 0);
  // damage: a beam of 40 over the lane
  put(sim, 'inspector', 2, 0);
  run(sim, 1);
  assert.ok(near(inLane.hp, 200 - 28), '30 % less: ' + inLane.hp);
  assert.equal(far.hp, 160);
  assert.equal(amp.hp, 460, 'not its own aura');
  // speed
  inLane.speed = ENEMY.bot.speed;
  const x0 = inLane.x;
  run(sim, 60);
  assert.ok(near(x0 - inLane.x, 0.26), 'moved ' + (x0 - inLane.x));
  // a second Amplifier adds nothing, but the two amp each other
  const sim2 = newSim();
  const a1 = still(sim2, 'amplifier', 1, 6);
  const a2 = still(sim2, 'amplifier', 1, 6.5);
  const bot = still(sim2, 'bot', 1, 6.2);
  put(sim2, 'inspector', 1, 0);
  run(sim2, 1);
  assert.deepEqual([a1.amped, a2.amped, bot.amped], [true, true, true]);
  assert.ok(near(bot.hp, 172) && near(a1.hp, 472));
  // off the floor or frozen: no aura
  const sim3 = newSim();
  const off = still(sim3, 'amplifier', 0, 9.5);
  const frozen = still(sim3, 'amplifier', 3, 5);
  frozen.frozen = 100;
  const b1 = still(sim3, 'bot', 0, 9);
  const b2 = still(sim3, 'bot', 3, 5.5);
  run(sim3, 1);
  assert.deepEqual([off.aura, frozen.aura, b1.amped, b2.amped], [0, 0, false, false]);
});

test('packet-siege expansion: an amped boss still takes the breaker\'s full share; an amped enemy takes 30 % less of an instant, after the boss cap', () => {
  const sim = newSim();
  const b = boss(sim, 1, 2, 6);
  b.frozen = 100;
  still(sim, 'amplifier', 2, 6.5);
  enemy(sim, 'bot', 2, 0.001);
  run(sim, 1);
  assert.equal(b.amped, true);
  assert.equal(b.hp, 2400 - 2400 * C.BOSS_BREAKER, 'the breaker is not softened');
  const sim2 = newSim();
  const b2 = boss(sim2, 1, 2, 4.5);
  b2.frozen = 100;
  still(sim2, 'amplifier', 2, 5);
  put(sim2, 'nullroute', 2, 4);
  run(sim2, 60);
  assert.ok(near(b2.hp, 2400 - C.BOSS_CAP * 0.7), 'capped at 300, then 30 % less: ' + b2.hp);
});

test('packet-siege expansion: a Wiper destroys the first defender it touches and dies with it; walls and decoys count, a grate is walked over, an armed trap goes off first', () => {
  const sim = newSim();
  const wall = put(sim, 'proxy', 0, 3);
  const canary = put(sim, 'canary', 1, 3);
  const pot = put(sim, 'honeypot', 3, 3);
  pot.t = 1;
  const unarmed = put(sim, 'honeypot', 4, 3);
  const w0 = enemy(sim, 'wiper', 0, 3.5 + REACH);
  const w1 = enemy(sim, 'wiper', 1, 3.5 + REACH);
  const w3 = enemy(sim, 'wiper', 3, 3.5 + REACH);
  const w4 = enemy(sim, 'wiper', 4, 3.5 + REACH);
  const events = run(sim, 1);
  assert.deepEqual(ofType(events, 'wipe').map((e) => [e.id, e.def, e.by, e.lane, e.col]), [
    [wall.id, 'proxy', w0.id, 0, 3], [canary.id, 'canary', w1.id, 1, 3], [unarmed.id, 'honeypot', w4.id, 4, 3]
  ]);
  assert.deepEqual(ofType(events, 'destroyed').map((e) => [e.id, e.why]), [
    [wall.id, 'wiped'], [canary.id, 'wiped'], [pot.id, 'spent'], [unarmed.id, 'wiped']
  ]);
  assert.deepEqual(ofType(events, 'kill').map((k) => [k.id, k.by]), [[w0.id, 'wipe'], [w1.id, 'wipe'], [w3.id, 'instant'], [w4.id, 'wipe']]);
  assert.equal(sim.defenders.length, 0);
  // a grate is walked over (and burns it); the Firewall behind is wiped
  const sim2 = newSim();
  const grate = put(sim2, 'waf', 2, 4);
  const fw = put(sim2, 'firewall', 2, 2);
  fw.t = 100000;
  const w = enemy(sim2, 'wiper', 2, 5.3);
  const ev2 = run(sim2, 20 * RATE);
  assert.ok(standing(sim2, grate.id), 'the grate stays');
  assert.deepEqual(ofType(ev2, 'wipe').map((e) => e.id), [fw.id]);
  assert.equal(alive(sim2, w.id), undefined);
});

test('packet-siege expansion: a Hive on the floor releases a Drone every 5 s where it stands, up to 4 of its own alive; not off the floor, not frozen', () => {
  const sim = newSim();
  const h = still(sim, 'hive', 1, 9.5);
  run(sim, 2 * RATE);
  assert.equal(h.t, 5 * RATE, 'the timer waits off the floor');
  h.x = 6;
  let events = run(sim, 5 * RATE - 1);
  assert.equal(ofType(events, 'release').length, 0);
  events = run(sim, 1);
  const rel = ofType(events, 'release');
  assert.equal(rel.length, 1);
  assert.deepEqual(rel[0], { type: 'release', id: h.id, lane: 1, x: 6, child: rel[0].child });
  const drone = alive(sim, rel[0].child);
  assert.equal(drone.type, 'drone');
  assert.equal(drone.hive, h.id);
  assert.deepEqual(ofType(events, 'spawn').map((s) => [s.enemy, s.lane, s.x]), [['drone', 1, 6]]);
  drone.frozen = 100000;
  // a Drone of another Hive does not count against the cap
  const other = still(sim, 'drone', 3, 8);
  other.hive = 999;
  other.frozen = 100000;
  for (let i = 0; i < 3; i++) {
    events = run(sim, 5 * RATE);
    for (const r of ofType(events, 'release')) alive(sim, r.child).frozen = 100000;
  }
  const own = () => sim.enemies.filter((e) => e.hive === h.id).length;
  assert.equal(own(), 4);
  events = run(sim, 5 * RATE);
  assert.equal(ofType(events, 'release').length, 0, 'four of its own are alive');
  assert.equal(h.t, 5 * RATE, 'the try spent the timer');
  sim.enemies.find((e) => e.hive === h.id).hp = 0;
  events = run(sim, 5 * RATE);
  assert.equal(ofType(events, 'release').length, 1, 'one fewer: it releases again');
  h.frozen = 10 * RATE;
  assert.equal(ofType(run(sim, 10 * RATE - 1), 'release').length, 0, 'frozen, it releases nothing');
});

test('packet-siege expansion: a Hydra heals other damaged enemies within 1.5 cells by 30 HP/s, never itself, never above full, two do not stack', () => {
  const sim = newSim();
  const hy = still(sim, 'hydra', 2, 6);
  hy.hp = 300;
  const a = still(sim, 'bot', 2, 7);
  const b = still(sim, 'bot', 3, 6.5);
  const full = still(sim, 'bot', 2, 6.5);
  const far = still(sim, 'bot', 2, 7.6);
  const dead = still(sim, 'bot', 1, 6);
  for (const e of [a, b, far]) e.hp = 100;
  dead.hp = 0;
  run(sim, 1);
  assert.equal(a.mended, sim.tick);
  assert.equal(full.mended, -1, 'nothing to heal');
  run(sim, 59);
  assert.ok(near(a.hp, 130) && near(b.hp, 130), a.hp + ' ' + b.hp);
  assert.deepEqual([full.hp, far.hp, hy.hp], [200, 100, 300]);
  a.hp = 199.9;
  run(sim, 1);
  assert.equal(a.hp, 200, 'never above full');
  // a second Hydra: still 30 HP/s
  const hy2 = still(sim, 'hydra', 1, 6.6);
  a.hp = 100;
  run(sim, 60);
  assert.ok(near(a.hp, 130), 'no stacking: ' + a.hp);
  assert.ok(hy.hp > 300 && hy2.hp === 600, 'they heal each other');
  // off the floor or frozen it heals nothing
  const sim2 = newSim();
  still(sim2, 'hydra', 0, 9.5);
  const frozen = still(sim2, 'hydra', 3, 5);
  frozen.frozen = 100;
  const c = still(sim2, 'bot', 0, 9.2);
  const d = still(sim2, 'bot', 3, 5.5);
  c.hp = d.hp = 50;
  run(sim2, 30);
  assert.deepEqual([c.hp, d.hp], [50, 50]);
  // never a heavy one: a boss summoning Hydras would heal itself through
  // them (tier 9 does), and a Kernel Panic is the boss's size
  const sim3 = newSim();
  still(sim3, 'hydra', 2, 6);
  const bs = boss(sim3, 9, 2, 6.5);
  bs.speed = 0;
  bs.summonT = bs.moveT = bs.volleyT = 1e9;
  bs.hp = 1000;
  const ti = still(sim3, 'titan', 3, 6);
  ti.hp = 1000;
  const small = still(sim3, 'bot', 1, 6);
  small.hp = 100;
  run(sim3, 60);
  assert.deepEqual([bs.hp, ti.hp], [1000, 1000]);
  assert.ok(near(small.hp, 130));
});

test('packet-siege expansion: a Hydra and an Amplifier together: the Amplifier is healed, the Hydra amped, the enemy beside both gets both', () => {
  const sim = newSim();
  const hy = still(sim, 'hydra', 2, 6);
  const amp = still(sim, 'amplifier', 2, 6.8);
  const bot = still(sim, 'bot', 2, 6.4);
  hy.hp = 300;
  amp.hp = 300;
  bot.hp = 100;
  put(sim, 'inspector', 2, 0);
  run(sim, 1);
  assert.deepEqual([hy.amped, amp.amped, bot.amped], [true, false, true]);
  assert.ok(near(bot.hp, 100 - 28 + 0.5), 'beam 40 less 30 %, then half a HP of healing: ' + bot.hp);
  assert.ok(near(amp.hp, 300 - 40 + 0.5), 'the Amplifier is not amped by itself, but healed');
  assert.ok(near(hy.hp, 300 - 28), 'the Hydra is amped, not healed by itself');
});

test('packet-siege expansion: an Encrypted Payload\'s 600 shield takes lane shots first; beams, pulses, grates and instants go past it', () => {
  const sim = newSim();
  const p = still(sim, 'payload', 2, 6);
  put(sim, 'firewall', 2, 0);
  let events = run(sim, 2 * RATE);
  assert.equal(ofType(events, 'hit').length, 1);
  assert.deepEqual([p.shield, p.hp], [580, 500]);
  assert.equal(p.maxShield, 600);
  // the shot that breaks it carries the rest into HP
  p.shield = 5;
  events = run(sim, 90);
  assert.deepEqual(ofType(events, 'shieldBreak'), [{ type: 'shieldBreak', id: p.id, lane: 2, x: 6, by: 'shot' }]);
  assert.deepEqual([p.shield, p.hp], [0, 485]);
  // past it: beam, pulse, grate, instant
  const sim2 = newSim();
  const q = still(sim2, 'payload', 1, 4.6);
  put(sim2, 'inspector', 1, 0);
  put(sim2, 'limiter', 0, 4);
  put(sim2, 'waf', 1, 4);
  put(sim2, 'nullroute', 2, 4);
  run(sim2, 1);
  assert.equal(q.shield, 600);
  assert.ok(near(q.hp, 500 - 40 - 20 - 20 / RATE), 'beam and pulse and a grate step: ' + q.hp);
  run(sim2, 59);
  assert.equal(alive(sim2, q.id), undefined, 'the Null Route goes through');
});

test('packet-siege expansion: a Tarpit shot into a Payload\'s shield does not slow it; once the shield is gone it does', () => {
  const sim = newSim();
  const p = still(sim, 'payload', 3, 6);
  put(sim, 'tarpit', 3, 0);
  p.shield = 10;
  until(sim, () => p.shield === 0, 3 * RATE);
  assert.equal(p.slow, 0, 'the shot that broke the shield did not slow');
  assert.equal(p.hp, 490);
  until(sim, () => p.hp < 490, 3 * RATE);
  assert.equal(p.slow, 4 * RATE - 1);
});

test('packet-siege expansion: a Jammer on the floor keeps every shooter kind within 2 cells from firing; pulses, Loopbacks and the rest work; jam events mark each change', () => {
  const sim = newSim();
  const j = still(sim, 'jammer', 2, 5);
  for (let l = 0; l < 5; l++) {
    const t = still(sim, 'worm', l, 8.9);
    t.hp = 1e9;
    t.maxHp = 1e9;
  }
  const jammed = {
    firewall: put(sim, 'firewall', 2, 3), tracer: put(sim, 'tracer', 2, 4), batch: put(sim, 'batch', 2, 6),
    tokenring: put(sim, 'tokenring', 1, 4), decryptor: put(sim, 'decryptor', 1, 5), inspector: put(sim, 'inspector', 3, 4),
    ids: put(sim, 'ids', 3, 5), scanner: put(sim, 'scanner', 1, 3), tarpit: put(sim, 'tarpit', 3, 6)
  };
  const free = {
    firewall: put(sim, 'firewall', 0, 5), limiter: put(sim, 'limiter', 2, 7), loopback: put(sim, 'loopback', 3, 3),
    far: put(sim, 'tracer', 2, 2)
  };
  const acts = (events, d) => events.filter((e) => (e.type === 'shot' && e.owner === d.id) || (e.id === d.id && ['trace', 'lob', 'arc', 'beam', 'pulse', 'knock'].includes(e.type))).length;
  let events = run(sim, 3 * RATE);
  for (const [id, d] of Object.entries(jammed)) {
    assert.equal(d.jammed, true, id);
    assert.equal(acts(events, d), 0, id + ' is silent');
  }
  for (const [id, d] of Object.entries(free)) {
    assert.equal(d.jammed, false, id);
    assert.ok(acts(events, d) > 0, id + ' works');
  }
  const on = ofType(events, 'jam');
  assert.equal(on.length, Object.keys(jammed).length, 'one event each, when it changes');
  assert.deepEqual(on.find((e) => e.id === jammed.firewall.id), { type: 'jam', id: jammed.firewall.id, lane: 2, col: 3, on: true });
  assert.equal(jammed.firewall.t, 0, 'the timer ran down');
  j.hp = 0;
  events = run(sim, 2);
  assert.equal(ofType(events, 'jam').filter((e) => !e.on).length, Object.keys(jammed).length);
  events = events.concat(run(sim, 2 * RATE));
  for (const [id, d] of Object.entries(jammed)) assert.ok(acts(events, d) > 0, id + ' fires again');
  // off the floor or frozen it jams nothing
  const sim2 = newSim();
  const fw = put(sim2, 'firewall', 0, 8);
  const fw2 = put(sim2, 'firewall', 4, 4);
  still(sim2, 'jammer', 0, 9.5);
  const fj = still(sim2, 'jammer', 4, 5);
  fj.frozen = 100;
  run(sim2, 1);
  assert.deepEqual([fw.jammed, fw2.jammed], [false, false]);
});

test('packet-siege expansion: a Replicator splits at half HP into two of half size, which split once more; the third generation dies', () => {
  const sim = newSim();
  const r = still(sim, 'replicator', 2, 6);
  r.frozen = 1000;
  r.slow = 50;
  r.hp = 401;
  put(sim, 'inspector', 2, 0);
  let events = run(sim, 1);
  const split = ofType(events, 'split');
  assert.equal(split.length, 1);
  assert.deepEqual(split[0], { type: 'split', id: r.id, lane: 2, x: 6, gen: 2, children: split[0].children });
  assert.equal(ofType(events, 'kill').length, 0, 'a split is not a kill');
  assert.equal(alive(sim, r.id), undefined);
  const kids = split[0].children.map((id) => alive(sim, id));
  assert.deepEqual(kids.map((k) => [k.type, k.gen, k.hp, k.maxHp, k.x, k.lane]), [
    ['replicator', 2, 400, 400, 6, 2], ['replicator', 2, 400, 400, 6.4, 2]
  ]);
  assert.deepEqual(kids.map((k) => [k.frozen, k.slow]), [[1000 - 1, 50 - 0], [1000 - 1, 50]], 'they keep its freeze and slow');
  assert.deepEqual(ofType(events, 'spawn').map((s) => s.id), split[0].children);
  kids[0].hp = 201;
  events = run(sim, 3 * RATE);
  const second = ofType(events, 'split');
  assert.ok(second.length >= 1);
  assert.equal(second[0].gen, 3);
  const g3 = alive(sim, second[0].children[0]);
  assert.deepEqual([g3.gen, g3.maxHp], [3, 200]);
  g3.hp = 10;
  events = run(sim, 3 * RATE);
  assert.ok(ofType(events, 'kill').some((k) => k.id === g3.id), 'the third generation dies');
  assert.equal(ofType(events, 'split').filter((s) => s.id === g3.id).length, 0);
});

test('packet-siege expansion: a Replicator vs a Failover (splits even on a killing blow, the copies unhurt), a breaker (all gone) and a Scrubber (only the third generation)', () => {
  const sim = newSim();
  const r = still(sim, 'replicator', 3, 6);
  r.frozen = 1000;
  put(sim, 'failover', 3, 0);
  const events = run(sim, 30);
  const split = ofType(events, 'split');
  assert.equal(split.length, 1);
  assert.deepEqual(split[0].children.map((id) => alive(sim, id).hp), [400, 400]);
  const sim2 = newSim();
  put(sim2, 'psu', 1, 4);
  enemy(sim2, 'replicator', 1, 0.001);
  const r2 = enemy(sim2, 'replicator', 1, 3);
  r2.hp = 300;
  const ev2 = run(sim2, 1);
  assert.equal(ofType(ev2, 'split').length, 0);
  assert.equal(ofType(ev2, 'kill').filter((k) => k.by === 'breaker').length, 2);
  const sim3 = newSim();
  const g1 = still(sim3, 'replicator', 0, 6);
  const g2 = still(sim3, 'replicator', 1, 6);
  g2.gen = 2;
  g2.maxHp = g2.hp = 400;
  const g3 = still(sim3, 'replicator', 2, 6);
  g3.gen = 3;
  g3.maxHp = g3.hp = 200;
  put(sim3, 'scrubber', 4, 0);
  const ev3 = run(sim3, 30);
  assert.deepEqual(ofType(ev3, 'kill').map((k) => k.id), [g3.id]);
  assert.ok(alive(sim3, g1.id) && alive(sim3, g2.id));
  assert.equal(ofType(ev3, 'split').length, 0);
});

test('packet-siege expansion: a level with a Replicator is won only when every copy is gone', () => {
  const sim = pks.pksNewSim(level({ spawns: [{ t: 0.1, lane: 2, type: 'replicator' }] }), ['failover', 'scrubber']);
  run(sim, 7);
  const r = sim.enemies[0];
  r.x = 6;
  r.frozen = 1000;
  put(sim, 'failover', 2, 0);
  run(sim, 30);
  assert.equal(sim.status, 'playing');
  assert.equal(sim.enemies.length, 2);
  for (const e of sim.enemies) e.hp = 1;
  const events = run(sim, 1);
  assert.equal(sim.status, 'playing', 'nothing hit them yet');
  sim.cards.find((c) => c.id === 'failover').left = 0;
  sim.enemies.forEach((e) => { e.gen = 3; });
  put(sim, 'failover', 2, 1);
  until(sim, () => sim.status !== 'playing', 60);
  assert.equal(sim.status, 'won');
  assert.ok(Array.isArray(events));
});

test('packet-siege expansion: a Dropper throws a Bot 3 cells ahead every 8 s, over defenders, never over an Air Gap, never left of column 3', () => {
  const sim = newSim();
  const dr = still(sim, 'dropper', 2, 8);
  put(sim, 'firewall', 2, 6).t = 100000;
  let events = run(sim, 8 * RATE - 1);
  assert.equal(ofType(events, 'throw').length, 0);
  events = run(sim, 1);
  const th = ofType(events, 'throw');
  assert.deepEqual(th, [{ type: 'throw', id: dr.id, lane: 2, x: 8, to: 5, child: th[0].child }]);
  const bot = alive(sim, th[0].child);
  assert.equal(bot.type, 'bot');
  assert.deepEqual([bot.moveFrom, bot.move], [8, Math.round(C.SLIDE_TIME * RATE) - 1]);
  assert.ok(bot.x < 5 && bot.x > 4.99, 'landed past the Firewall');
  // an Air Gap cuts the throw short: the Bot lands touching it
  const sim2 = newSim();
  const d2 = still(sim2, 'dropper', 1, 8.9);
  put(sim2, 'airgap', 1, 6);
  put(sim2, 'airgap', 1, 4);
  d2.t = 1;
  const ev2 = run(sim2, 1);
  assert.ok(near(ofType(ev2, 'throw')[0].to, 6.5 + REACH));
  // too close to the gap to throw at all
  const sim3 = newSim();
  const d3 = still(sim3, 'dropper', 1, 7.5);
  put(sim3, 'airgap', 1, 6);
  d3.t = 1;
  assert.equal(ofType(run(sim3, 1), 'throw').length, 0);
  assert.equal(d3.t, 8 * RATE, 'the try spent the timer');
  // never behind the lines: it lands at x 3 at the least (columns 0-2
  // stay behind a thrown Bot, 15 s of walking from the rack), or not at all
  assert.equal(ENEMY.dropper.minX, 3);
  const sim4 = newSim();
  const d4 = still(sim4, 'dropper', 3, 5);
  const d5 = still(sim4, 'dropper', 4, 3.4);
  d4.t = d5.t = 1;
  const ev4 = run(sim4, 1);
  assert.deepEqual(ofType(ev4, 'throw').map((t) => [t.id, t.to]), [[d4.id, 3]]);
  // off the floor the timer waits
  const sim5 = newSim();
  const d6 = still(sim5, 'dropper', 0, 9.5);
  run(sim5, 10 * RATE);
  assert.equal(d6.t, 8 * RATE);
});

test('packet-siege expansion: a Kernel Panic bites 300/s, takes at most 600 from an instant, crushes grates and honeypots; a breaker throws it back like the boss', () => {
  const sim = newSim();
  const wall = put(sim, 'proxy', 0, 3);
  const t = enemy(sim, 'titan', 0, 3.5 + REACH);
  run(sim, 60);
  assert.ok(near(wall.hp, 2400 - 300));
  assert.equal(t.state, 'biting');
  const sim2 = newSim();
  const t2 = still(sim2, 'titan', 2, 4.5);
  t2.frozen = 1000;
  put(sim2, 'nullroute', 2, 4);
  put(sim2, 'failover', 2, 0);
  run(sim2, 60);
  assert.equal(t2.hp, 4000 - 600 - 600);
  const sim3 = newSim();
  const grate = put(sim3, 'waf', 1, 4);
  enemy(sim3, 'titan', 1, 5.31);
  const pot = put(sim3, 'honeypot', 3, 4);
  const t3 = enemy(sim3, 'titan', 3, 4.5 + REACH);
  const ev3 = run(sim3, 10);
  assert.deepEqual(ofType(ev3, 'destroyed').map((d) => [d.id, d.why]).sort(), [[grate.id, 'crushed'], [pot.id, 'spent']].sort());
  assert.equal(t3.hp, 4000 - 600, 'an unarmed Honeypot goes off under it, capped');
  // the breaker: the lane is wiped but the Panic is thrown back to x 4 and
  // loses a fifth of its full HP (no cheap kill of 4000 HP for one star)
  const sim4 = newSim();
  const t4 = enemy(sim4, 'titan', 4, 0.001);
  const bot4 = enemy(sim4, 'bot', 4, 2);
  bot4.speed = 0;
  const ev4 = run(sim4, 1);
  assert.equal(sim4.breakers[4], 'tripped');
  assert.ok(alive(sim4, t4.id), 'the Panic survives the breaker');
  assert.equal(alive(sim4, bot4.id), undefined, 'the rest of the lane is wiped');
  assert.equal(t4.x, C.BOSS_PUSH);
  assert.equal(t4.hp, 4000 - 4000 * C.BOSS_BREAKER);
  assert.deepEqual(ofType(ev4, 'kill').map((k) => [k.id, k.by]), [[bot4.id, 'breaker']]);
  // a Panic further right than x 4 is not pulled forward
  const sim5 = newSim();
  const far = still(sim5, 'titan', 1, 6);
  enemy(sim5, 'bot', 1, 0.001);
  run(sim5, 1);
  assert.deepEqual([far.x, far.hp], [6, 3200]);
  // the second time it reaches the rack, the level is lost
  t4.x = 0.001;
  t4.speed = 1;
  run(sim4, 1);
  assert.equal(sim4.status, 'lost');
});

test('packet-siege expansion: a Glitch blinks a cell forward every 4 s, never past a defender; grates do not count; it blinks onto the rack if nothing stands there', () => {
  const sim = newSim();
  const g = still(sim, 'glitch', 2, 8);
  put(sim, 'proxy', 2, 4);
  put(sim, 'waf', 2, 6);
  let events = run(sim, 4 * RATE - 1);
  assert.equal(ofType(events, 'blink').length, 0);
  events = run(sim, 1);
  assert.deepEqual(ofType(events, 'blink'), [{ type: 'blink', id: g.id, lane: 2, x: 8, to: 7 }]);
  assert.deepEqual([g.x, g.moveFrom, g.move], [7, 8, Math.round(C.SLIDE_TIME * RATE)]);
  events = run(sim, 4 * RATE);
  assert.ok(near(ofType(events, 'blink')[0].to, 6), 'over the grate');
  events = run(sim, 4 * RATE);
  assert.ok(near(ofType(events, 'blink')[0].to, 4.5 + REACH), 'it stops touching the wall');
  events = run(sim, 4 * RATE);
  assert.equal(ofType(events, 'blink').length, 0, 'no blink while it touches one');
  assert.equal(g.state, 'biting');
  const sim2 = newSim();
  const g2 = still(sim2, 'glitch', 1, 0.6);
  g2.t = 1;
  const ev2 = run(sim2, 1);
  assert.equal(ofType(ev2, 'breaker').length, 1);
  const sim3 = newSim();
  const g3 = still(sim3, 'glitch', 1, 9.4);
  run(sim3, 5 * RATE);
  assert.equal(g3.t, 4 * RATE, 'off the floor the timer waits');
});

// ── the new defenders ──────────────────────────────────────────────────────

test('packet-siege expansion: a Canary is a 150 HP decoy every enemy stops at: an Exploit spends its leap, a Phisher walks up and bites, a Dropper does not throw', () => {
  const sim = newSim();
  const c0 = put(sim, 'canary', 0, 4);
  const ex = enemy(sim, 'exploit', 0, 4.5 + REACH);
  run(sim, 1);
  assert.equal(ex.state, 'biting');
  assert.equal(ex.used, true);
  assert.equal(ex.speed, ENEMY.exploit.speed, 'the leap is spent');
  assert.ok(near(c0.hp, 150 - 100 / RATE));
  assert.equal(c0.kind, 'decoy');
  assert.equal(c0.state, 'idle');
  const c1 = put(sim, 'canary', 1, 3);
  put(sim, 'firewall', 1, 0).t = 100000;
  const ph = enemy(sim, 'phisher', 1, 8);
  until(sim, () => ph.state === 'biting', 30 * RATE);
  assert.ok(ph.x <= 3.5 + REACH + 1e-9, 'it walked up to the Canary');
  assert.equal(ofType(sim.events, 'shot').filter((s) => s.kind === 'phish').length, 0);
  assert.ok(c1.hp < 150);
  const c2 = put(sim, 'canary', 2, 3);
  const dr = enemy(sim, 'dropper', 2, 3.5 + REACH);
  dr.t = 1;
  const events = run(sim, 1);
  assert.equal(ofType(events, 'throw').length, 0, 'lured');
  assert.equal(dr.state, 'biting');
  assert.ok(c2.hp < 150);
  // the Canary falls in 1.5 s to a Bot
  const sim2 = newSim();
  const c3 = put(sim2, 'canary', 3, 4);
  enemy(sim2, 'bot', 3, 4.5 + REACH);
  const ev2 = run(sim2, 90);
  assert.deepEqual(ofType(ev2, 'destroyed').map((d) => [d.id, d.why]), [[c3.id, 'eaten']]);
});

test('packet-siege expansion: a Tracer fires 150 every 4 s at the toughest visible enemy ahead in its lane (a shield counts), the nearer one on a tie', () => {
  const sim = newSim();
  const tr = put(sim, 'tracer', 2, 1);
  assert.equal(ofType(run(sim, 30), 'trace').length, 0, 'nothing to aim at');
  assert.equal(tr.t, 0);
  const bot = still(sim, 'bot', 2, 5);
  const worm = still(sim, 'worm', 2, 7);
  const pay = still(sim, 'payload', 2, 8);
  const rk = still(sim, 'rootkit', 2, 6);
  rk.hp = rk.maxHp = 5000;
  still(sim, 'brute', 2, 9.5);
  still(sim, 'brute', 2, 0.9);
  let events = run(sim, 1);
  const tr1 = ofType(events, 'trace');
  assert.deepEqual(tr1, [{ type: 'trace', id: tr.id, def: 'tracer', lane: 2, col: 1, target: pay.id, x: 8, dmg: 150 }]);
  assert.equal(pay.shield, 450, 'into the shield');
  assert.equal(tr.t, 4 * RATE);
  assert.equal(tr.state, 'firing');
  assert.equal(sim.shots.length, 0, 'it hits at once');
  pay.hp = 0;
  worm.hp = 200;
  events = run(sim, 4 * RATE);
  assert.equal(ofType(events, 'trace')[0].target, bot.id, 'a tie: the nearer one');
  assert.equal(bot.hp, 50);
  assert.equal(worm.hp, 200);
});

test('packet-siege expansion: a Batch Job lobs a shell every 3 s at the densest group 2+ cells away; it lands 1 s later: 60 to everything within 1 cell, past shields and cloaks', () => {
  const sim = newSim();
  const bj = put(sim, 'batch', 2, 0);
  const close = still(sim, 'worm', 2, 2);
  const lone = still(sim, 'worm', 2, 4);
  const group = [still(sim, 'worm', 2, 6), still(sim, 'payload', 2, 6.5), still(sim, 'rootkit', 2, 7)];
  const edge = still(sim, 'worm', 2, 9.4);
  let events = run(sim, 1);
  const lob = ofType(events, 'lob');
  assert.equal(lob.length, 1, 'the Worm at 6 (the cloaked Rootkit is no target; a tie with the Payload goes to the nearer)');
  assert.deepEqual(lob[0], { type: 'lob', id: bj.id, def: 'batch', lane: 2, col: 0, shell: lob[0].shell, to: 6, flight: 60 });
  assert.deepEqual(sim.shells, [{ id: lob[0].shell, owner: bj.id, lane: 2, from: 0.5, to: 6, t: 59, flight: 60, dmg: 60, splash: 1, done: false }]);
  events = run(sim, 58);
  assert.equal(ofType(events, 'splash').length, 0);
  events = run(sim, 1);
  assert.deepEqual(ofType(events, 'splash'), [{ type: 'splash', id: lob[0].shell, owner: bj.id, lane: 2, x: 6, radius: 1 }]);
  assert.deepEqual(group.map((e) => e.hp), [500, 440, 340]);
  assert.equal(group[1].shield, 600, 'past the shield');
  assert.equal(group[2].cloaked, false, 'it uncloaks a Rootkit');
  assert.deepEqual([close.hp, lone.hp, edge.hp], [560, 560, 560]);
  assert.deepEqual(sim.shells, []);
  // a tie: the nearer; nothing far enough away: no shell
  const sim2 = newSim();
  put(sim2, 'batch', 1, 0);
  still(sim2, 'bot', 1, 2.4);
  const a = still(sim2, 'bot', 1, 5);
  still(sim2, 'bot', 1, 7);
  const ev2 = run(sim2, 1);
  assert.equal(ofType(ev2, 'lob')[0].to, a.x);
  const sim3 = newSim();
  const b3 = put(sim3, 'batch', 1, 0);
  still(sim3, 'bot', 1, 2.4);
  assert.equal(ofType(run(sim3, 10), 'lob').length, 0);
  assert.equal(b3.t, 0);
  // the shell lands on the spot, not on the enemy: one that walked off is missed
  const sim4 = newSim();
  put(sim4, 'batch', 3, 0);
  const runner = enemy(sim4, 'kiddie', 3, 5);
  const evs = run(sim4, 1);
  assert.equal(ofType(evs, 'lob')[0].to, 5);
  runner.x = 3.5;
  run(sim4, 60);
  assert.equal(runner.hp, 140);
});

test('packet-siege expansion: a Loopback throws the first enemy in its lane back 2 cells every 6 s; the boss and a Kernel Panic only 0.5; never off the floor', () => {
  const sim = newSim();
  const lb = put(sim, 'loopback', 2, 0);
  assert.equal(ofType(run(sim, 10), 'knock').length, 0);
  const a = still(sim, 'bot', 2, 3);
  const b = still(sim, 'bot', 2, 4);
  let events = run(sim, 1);
  assert.deepEqual(ofType(events, 'knock'), [{ type: 'knock', id: lb.id, def: 'loopback', target: a.id, lane: 2, from: 3, to: 5 }]);
  assert.deepEqual([a.x, a.moveFrom, a.move, b.x], [5, 3, Math.round(C.SLIDE_TIME * RATE) - 1, 4], 'one step of the slide gone');
  assert.equal(lb.t, 6 * RATE);
  a.x = 8.5;
  b.x = 9.5;
  run(sim, 6 * RATE);
  assert.equal(a.x, C.FLOOR_END, 'never off the floor');
  const sim2 = newSim();
  put(sim2, 'loopback', 1, 0);
  put(sim2, 'loopback', 3, 0);
  const bs = boss(sim2, 2, 1, 3);
  bs.frozen = 100;
  const ti = still(sim2, 'titan', 3, 3);
  run(sim2, 1);
  assert.deepEqual([bs.x, ti.x], [3.5, 3.5]);
  // a thrown enemy is spared for 6 s: a second Loopback takes the next one
  const sim5 = newSim();
  put(sim5, 'loopback', 4, 0);
  put(sim5, 'loopback', 4, 1);
  const lead = still(sim5, 'bot', 4, 3);
  const next = still(sim5, 'bot', 4, 4);
  const ev5 = run(sim5, 1);
  assert.deepEqual(ofType(ev5, 'knock').map((k) => [k.target, k.from, k.to]), [[lead.id, 3, 5], [next.id, 4, 6]]);
  assert.equal(lead.knocked, 6 * RATE - 1);
  const pinned = newSim();
  put(pinned, 'loopback', 0, 0);
  put(pinned, 'loopback', 0, 1);
  const b5 = boss(pinned, 1, 0, 4);
  b5.summonT = 100000;
  const ev6 = run(pinned, 6 * RATE);
  assert.equal(ofType(ev6, 'knock').length, 1, 'the boss is not pinned by stacked Loopbacks');
  assert.equal(ofType(run(pinned, 1), 'knock').length, 1, 'once the 6 s are over it can be thrown again');
  // and no enemy is thrown more than twice in all: five Loopbacks cannot
  // hold a lone Bot at the edge of the floor for good
  assert.equal(DEF.loopback.times, 2);
  assert.equal(b5.knocks, 2);
  assert.equal(ofType(run(pinned, 30 * RATE), 'knock').length, 0, 'the boss is thrown twice, never again');
  const wall = newSim();
  for (let c = 0; c < 5; c++) put(wall, 'loopback', 2, c);
  const lone = enemy(wall, 'bot', 2, 8);
  const ev7 = run(wall, 60 * RATE);
  assert.deepEqual(ofType(ev7, 'knock').map((k) => k.target), [lone.id, lone.id]);
  assert.ok(lone.state === 'biting' || lone.x < 6, 'it walks on: ' + lone.x);
  // a leap in progress ends where it is thrown
  const sim3 = newSim();
  put(sim3, 'firewall', 0, 4).t = 100000;
  const ex = enemy(sim3, 'exploit', 0, 4.5 + REACH + 0.001);
  until(sim3, () => ex.state === 'leaping', 60);
  const lb3 = put(sim3, 'loopback', 0, 0);
  run(sim3, 1);
  assert.equal(ex.state, 'walking');
  assert.equal(lb3.fire, C.FIRE_ANIM - 0);
});

test('packet-siege expansion: a Token Ring arcs 30 into the first enemy of its lane and jumps on to up to 3 in all, nearest first, within 2 cells, across lanes', () => {
  const sim = newSim();
  const tr = put(sim, 'tokenring', 2, 0);
  const a = still(sim, 'bot', 2, 3);
  const b = still(sim, 'bot', 2, 4.5);
  const c = still(sim, 'rootkit', 3, 3.5);
  const far = still(sim, 'bot', 4, 5.5);
  const off = still(sim, 'bot', 3, 9.5);
  let events = run(sim, 1);
  const arc = ofType(events, 'arc');
  assert.equal(arc.length, 1);
  assert.deepEqual(arc[0], { type: 'arc', id: tr.id, def: 'tokenring', lane: 2, col: 0, dmg: 30, path: [
    { id: a.id, lane: 2, x: 3 }, { id: c.id, lane: 3, x: 3.5 }, { id: b.id, lane: 2, x: 4.5 }
  ] });
  assert.deepEqual([a.hp, b.hp, c.hp, far.hp, off.hp], [170, 170, 370, 200, 200]);
  assert.equal(c.cloaked, false, 'area damage: it uncloaks');
  assert.equal(tr.t, 2 * RATE);
  // nothing in reach: one hit; a dead one is skipped
  const sim2 = newSim();
  put(sim2, 'tokenring', 1, 0);
  const lone = still(sim2, 'payload', 1, 3);
  still(sim2, 'bot', 1, 5.5);
  const dead = still(sim2, 'bot', 0, 3);
  dead.hp = 0;
  const ev2 = run(sim2, 1);
  assert.deepEqual(ofType(ev2, 'arc')[0].path.map((p) => p.id), [lone.id]);
  assert.deepEqual([lone.hp, lone.shield], [470, 600], 'past the shield');
  const sim3 = newSim();
  const t3 = put(sim3, 'tokenring', 1, 0);
  assert.equal(ofType(run(sim3, 5), 'arc').length, 0);
  assert.equal(t3.t, 0);
});

test('packet-siege expansion: a Signature DB adds 50 % to the shooters in the 3x3 around it; two do not stack; a disabled one adds nothing', () => {
  const sim = newSim();
  const db = put(sim, 'sigdb', 2, 2);
  const fw = put(sim, 'firewall', 2, 1);
  const out = put(sim, 'firewall', 2, 4);
  const beam = put(sim, 'inspector', 1, 3);
  const psu = put(sim, 'psu', 3, 2);
  for (let l = 1; l <= 2; l++) still(sim, 'worm', l, 8).hp = 1e9;
  let events = run(sim, 1);
  assert.deepEqual([fw.boosted, out.boosted, beam.boosted, psu.boosted, db.boosted], [true, false, true, false, false]);
  assert.deepEqual(ofType(events, 'shot').map((s) => [s.owner, sim.shots.find((o) => o.id === s.id).dmg]), [[fw.id, 30], [out.id, 20]]);
  assert.equal(ofType(events, 'beam').length, 1);
  assert.equal(sim.enemies.find((e) => e.lane === 1).hp, 1e9 - 60);
  put(sim, 'sigdb', 2, 0);
  run(sim, 90);
  assert.equal(sim.shots.filter((s) => s.owner === fw.id).every((s) => s.dmg === 30), true, 'two DBs: still 50 %');
  const sim2 = newSim();
  const db2 = put(sim2, 'sigdb', 0, 2);
  const fw2 = put(sim2, 'firewall', 0, 1);
  db2.off = 100;
  run(sim2, 1);
  assert.equal(fw2.boosted, false);
});

test('packet-siege expansion: a DNS Sinkhole pulls the nearest visible enemy of each neighbour lane into its own every 8 s; not the boss, a Kernel Panic, a leaper or a cloak', () => {
  const sim = newSim();
  const sh = put(sim, 'sinkhole', 2, 4);
  assert.equal(ofType(run(sim, 5), 'pull').length, 0, 'nothing to pull: it waits');
  assert.equal(sh.t, 0);
  const a = still(sim, 'bot', 1, 3.2);
  const a2 = still(sim, 'bot', 1, 6);
  const bs = boss(sim, 1, 3, 4.5);
  bs.frozen = 1000;
  const ti = still(sim, 'titan', 3, 4.6);
  const rk = still(sim, 'rootkit', 3, 4.7);
  const b = still(sim, 'bot', 3, 6.6);
  still(sim, 'bot', 3, 9.5);
  const events = run(sim, 1);
  assert.deepEqual(ofType(events, 'pull'), [
    { type: 'pull', id: sh.id, def: 'sinkhole', target: a.id, from: 1, lane: 2, x: 3.2 },
    { type: 'pull', id: sh.id, def: 'sinkhole', target: b.id, from: 3, lane: 2, x: 6.6 }
  ]);
  assert.deepEqual([a.lane, a.from, a.shift, b.lane], [2, 1, 29, 2]);
  assert.deepEqual([a2.lane, bs.lane, ti.lane, rk.lane], [1, 3, 3, 3]);
  assert.equal(sh.t, 8 * RATE);
  // at the edge, next to a closed lane: only the open neighbour; a leaper stays
  const sim2 = newSim({ lanes: [1, 2, 3] });
  const s2 = put(sim2, 'sinkhole', 1, 4);
  const c = still(sim2, 'bot', 2, 5);
  const ev2 = run(sim2, 1);
  assert.deepEqual(ofType(ev2, 'pull').map((p) => [p.target, p.from, p.lane]), [[c.id, 2, 1]]);
  assert.equal(s2.t, 8 * RATE);
  const sim3 = newSim();
  put(sim3, 'sinkhole', 0, 2);
  const lp = still(sim3, 'exploit', 1, 3);
  lp.state = 'leaping';
  lp.leapTo = 0;
  lp.frozen = 0;
  const dead = still(sim3, 'bot', 1, 4);
  dead.hp = 0;
  assert.equal(ofType(run(sim3, 1), 'pull').length, 0);
  // two Sinkholes on one lane: the second takes the next one, not the one already pulled
  const sim4 = newSim();
  put(sim4, 'sinkhole', 0, 4);
  put(sim4, 'sinkhole', 2, 4);
  const p1 = still(sim4, 'bot', 1, 4.5);
  const p2 = still(sim4, 'bot', 1, 6);
  const ev4 = run(sim4, 1);
  assert.deepEqual(ofType(ev4, 'pull').map((p) => [p.target, p.lane]), [[p1.id, 0], [p2.id, 2]]);
});

test('packet-siege expansion: an enemy put inside a defender\'s cell (left of its centre) is stopped by it and bites it: pulled, thrown, split, morphed, moved by the boss, or built on', () => {
  // the review's repro: a Sinkhole at (2, 3), a Proxy at (2, 5), a Bot of
  // lane 1 at 5.25: pulled into the Proxy's cell, it bites the Proxy
  const sim = newSim();
  const sink = put(sim, 'sinkhole', 2, 3);
  const proxy = put(sim, 'proxy', 2, 5);
  const bot = enemy(sim, 'bot', 1, 5.25);
  run(sim, 10 * RATE);
  assert.deepEqual([bot.lane, bot.x, bot.state], [2, 5.25, 'biting']);
  assert.ok(near(proxy.hp, 2400 - 100 * 10), 'bitten from the first step: ' + proxy.hp);
  assert.equal(sink.hp, 300);
  // a Phisher pulled into a wall bites it rather than throwing past it
  const ps = newSim();
  put(ps, 'sinkhole', 2, 3);
  const pw = put(ps, 'proxy', 2, 5);
  const ph = enemy(ps, 'phisher', 1, 5.4);
  const pev = run(ps, 3 * RATE);
  assert.equal(ofType(pev, 'shot').length, 0);
  assert.equal(ph.state, 'biting');
  assert.ok(pw.hp < 2400);
  // a Dropper's Bot landing inside a wall's cell
  const ds = newSim();
  const dw = put(ds, 'proxy', 0, 5);
  const dr = still(ds, 'dropper', 0, 8.2);
  dr.t = 1;
  const dev = run(ds, 2 * RATE);
  const thrown = alive(ds, ofType(dev, 'throw')[0].child);
  assert.ok(near(thrown.x, 5.2));
  assert.equal(thrown.state, 'biting');
  assert.ok(dw.hp < 2400);
  // a Glitch inside a defender's cell does not blink out of it
  const gs = newSim();
  const gw = put(gs, 'proxy', 0, 5);
  const gl = still(gs, 'glitch', 0, 5.3);
  gl.t = 1;
  const gev = run(gs, RATE);
  assert.equal(ofType(gev, 'blink').length, 0);
  assert.deepEqual([gl.x, gl.state, gl.t], [5.3, 'biting', 4 * RATE - RATE + 1]);
  assert.ok(gw.hp < 2400);
  // a Polymorph morphing and the boss changing lanes, into a wall's cell
  const ms = newSim();
  const walls = [put(ms, 'proxy', 0, 5), put(ms, 'proxy', 2, 5), put(ms, 'proxy', 3, 5), put(ms, 'proxy', 4, 5)];
  const pm = still(ms, 'polymorph', 1, 5.3);
  pm.hp = 301;
  put(ms, 'firewall', 1, 0);
  const b = boss(ms, 6, 3, 5.3);
  b.speed = 0;
  b.moveT = 1;
  b.summonT = b.volleyT = 1e9;
  const mev = run(ms, 2 * RATE);
  assert.equal(ofType(mev, 'morph').length, 2);
  assert.ok(pm.lane !== 1 && b.lane !== 3);
  assert.deepEqual([pm.state, b.state], ['biting', 'biting']);
  assert.deepEqual([pm.x, b.x], [5.3, 5.3]);
  for (const w of walls) assert.equal(w.hp < 2400, w.lane === pm.lane || w.lane === b.lane, 'lane ' + w.lane);
  // split copies: a Replicator's second copy (0.4 behind) and a boss's
  // second copy (0.4 behind, in a neighbour lane) inside a wall's cell
  const ss = newSim();
  const sw = put(ss, 'proxy', 3, 5);
  const rp = still(ss, 'replicator', 3, 5);
  put(ss, 'failover', 3, 0).t = 1;
  const sev = run(ss, RATE);
  const kids = ofType(sev, 'split')[0].children.map((id) => alive(ss, id));
  assert.deepEqual(kids.map((k) => k.state), ['walking', 'biting']);
  assert.ok(near(kids[0].x, 5 - ENEMY.replicator.speed) && kids[1].x === 5.4, 'the first walks on, the second stays');
  assert.ok(sw.hp < 2400 && rp.hp <= 0);
  const bss = newSim();
  const bw = [put(bss, 'proxy', 1, 5), put(bss, 'proxy', 3, 5)];
  const big = boss(bss, 9, 2, 5);
  big.speed = 0;
  big.hp = 1;
  big.summonT = big.moveT = big.volleyT = 1e9;
  put(bss, 'failover', 2, 0).t = 1;
  const bev = run(bss, RATE);
  const copies = ofType(bev, 'bossSplit')[0].children.map((id) => alive(bss, id));
  assert.equal(copies[1].state, 'biting');
  assert.ok(bw.find((w) => w.lane === copies[1].lane).hp < 2400);
  // a wall built on top of an enemy that has passed its cell's centre
  const os = newSim();
  const walker = enemy(os, 'bot', 4, 5.4);
  run(os, 1);
  const ow = put(os, 'proxy', 4, 5);
  run(os, RATE);
  assert.equal(walker.state, 'biting');
  assert.ok(ow.hp < 2400);
  // levels 1-50 keep their rule: there such an enemy walks out of the cell
  const early = pks.pksNewSim(level({ n: 7 }), ALL);
  put(early, 'sinkhole', 2, 3);
  const ep = put(early, 'proxy', 2, 5);
  const eb = enemy(early, 'bot', 1, 5.25);
  run(early, 10 * RATE);
  assert.equal(eb.lane, 2);
  assert.ok(eb.x < 5);
  assert.equal(ep.hp, 2400);
});

test('packet-siege expansion: a Loopback\'s throw lands against a defender behind the enemy, never inside its cell', () => {
  const sim = newSim();
  put(sim, 'loopback', 2, 0);
  put(sim, 'proxy', 2, 2);
  const back = put(sim, 'firewall', 2, 5);
  back.t = 1e9;
  const bot = still(sim, 'bot', 2, 3.2);
  const k = ofType(run(sim, 1), 'knock')[0];
  assert.deepEqual([k.from, k.to, bot.x], [3.2, 5, 5]);
  bot.speed = ENEMY.bot.speed;
  run(sim, 5 * RATE);
  assert.equal(back.hp, 300, 'it walks away from it');
  assert.ok(bot.x < 5);
  // with nothing there it flies the full 2 cells
  const s2 = newSim();
  put(s2, 'loopback', 2, 0);
  const b2 = still(s2, 'bot', 2, 3.2);
  run(s2, 1);
  assert.ok(near(b2.x, 5.2));
});

test('packet-siege expansion: an enemy pulled out of a lane has left it at once: later in the same step nothing in its old lane knocks, traces, shells, shoots or hits it', () => {
  // the Sinkhole acts first (placed first); the bot in lane 1 is pulled into
  // lane 2 (where a Proxy holds it); then a defender of lane 1 acts
  // (the area effects too: a beam, a lane instant, a grate of lane 1, and a
  // pulse and a blast whose 3x3 covers lanes 0-1 only)
  const scene = (type, lane, col) => {
    const sim = newSim();
    put(sim, 'sinkhole', 2, 3);
    put(sim, 'proxy', 2, 6);
    const d = type ? put(sim, type, lane === undefined ? 1 : lane, col || 0) : null;
    if (d && d.kind === 'instant') d.t = 1;
    const bot = still(sim, 'bot', 1, 6.9);
    return { sim, d, bot };
  };
  for (const [type, lane, col] of [['loopback'], ['tracer'], ['batch'], ['firewall'], ['decryptor'], ['tokenring'],
    ['inspector'], ['failover'], ['waf', 1, 6], ['limiter', 0, 6], ['nullroute', 0, 6]]) {
    const { sim, bot } = scene(type, lane, col);
    const events = run(sim, 1);
    assert.equal(bot.lane, 2, type);
    assert.deepEqual(ofType(events, 'pull').map((p) => p.target), [bot.id], type);
    for (const kind of ['knock', 'trace', 'lob', 'shot', 'arc', 'beam', 'pulse']) assert.equal(ofType(events, kind).length, 0, type + ': ' + kind);
    assert.equal(bot.hp, ENEMY.bot.hp, type);
  }
  // a shot already flying in lane 1 flies on past it, a shell landing there
  // misses it
  const { sim, bot } = scene(null);
  sim.shots.push({ id: sim.nextId++, kind: 'drop', lane: 1, x: 6.55, from: 5, dir: 1, dmg: 20, slow: 0, owner: 0, done: false });
  sim.shells.push({ id: sim.nextId++, owner: 0, lane: 1, from: 0.5, to: 6.9, t: 1, flight: 60, dmg: 60, splash: 1, done: false });
  const events = run(sim, 1);
  assert.equal(bot.lane, 2);
  assert.equal(ofType(events, 'hit').length, 0);
  assert.equal(ofType(events, 'splash').length, 1);
  assert.equal(bot.hp, ENEMY.bot.hp);
  // an armed Honeypot of lane 1 going off later in the step spares it
  const hs = newSim();
  put(hs, 'sinkhole', 2, 7);
  put(hs, 'proxy', 2, 6);
  const hp = put(hs, 'honeypot', 1, 5);
  hp.t = 0;
  run(hs, 1);
  const pulled = still(hs, 'bot', 1, 6.6);
  const trigger = still(hs, 'bot', 1, 6.2);
  const hev = run(hs, 1);
  assert.deepEqual(ofType(hev, 'pull').map((p) => p.target), [pulled.id]);
  assert.equal(ofType(hev, 'blast').length, 1);
  assert.deepEqual([pulled.hp, trigger.hp], [ENEMY.bot.hp, 0]);
  // a Phisher pulled away from its bait, which an Air Gap sent back: the
  // bait flies on in its lane
  const ps = newSim();
  put(ps, 'sinkhole', 2, 3);
  put(ps, 'proxy', 2, 6);
  const ph = still(ps, 'phisher', 1, 6.9);
  ps.shots.push({ id: ps.nextId++, kind: 'phish', lane: 1, x: 6.55, from: 5, dir: 1, dmg: 40, slow: 0, owner: ph.id, done: false });
  const pev = run(ps, 1);
  assert.equal(ph.lane, 2);
  assert.equal(ofType(pev, 'hit').length, 0);
  assert.equal(ph.hp, ENEMY.phisher.hp);
  // in its new lane it is a target from the next step on
  put(sim, 'firewall', 2, 0);
  assert.equal(ofType(run(sim, 1), 'shot').length, 1);
});

test('packet-siege expansion: an Air Gap sends a Phisher\'s bait and the boss\'s volley back at the thrower; an Exploit cannot leap it', () => {
  const sim = newSim();
  const ag = put(sim, 'airgap', 2, 3);
  const ph = enemy(sim, 'phisher', 2, 9);
  until(sim, () => ph.state === 'throwing', 30 * RATE);
  const events = run(sim, 3 * RATE);
  const refl = ofType(events, 'reflect');
  assert.ok(refl.length >= 1);
  assert.deepEqual(Object.keys(refl[0]), ['type', 'id', 'by', 'lane', 'x', 'owner']);
  assert.equal(refl[0].by, ag.id);
  assert.equal(refl[0].owner, ph.id);
  const back = ofType(events, 'hit').filter((h) => h.kind === 'phish');
  assert.ok(back.length >= 1);
  assert.equal(back[0].id, ph.id);
  assert.equal(ph.hp, 300 - 40 * back.length);
  assert.equal(ag.hp, 1800, 'the gap takes nothing');
  // the boss's volley, cloaked or not
  const sim2 = newSim();
  const b = boss(sim2, 4, 1, 8);
  b.volleyT = 1;
  b.summonT = b.moveT = 100000;
  b.cloakT = 1;
  b.speed = 0;
  put(sim2, 'airgap', 1, 4);
  const wall = put(sim2, 'proxy', 2, 4);
  run(sim2, 3 * RATE);
  assert.equal(b.cloaked, true);
  assert.equal(b.hp, 6000 - 60, 'its own volley');
  assert.equal(wall.hp, 2400 - 60, 'a plain wall takes it');
  // a volley shot sent back in a side lane finds no thrower there: it flies
  // off (the text: "hits its thrower if it is in that lane")
  const side = newSim();
  const sb = boss(side, 4, 1, 8);
  sb.volleyT = 1;
  sb.summonT = sb.moveT = sb.cloakT = 100000;
  sb.speed = 0;
  put(side, 'airgap', 0, 4);
  put(side, 'airgap', 2, 4);
  const sev = run(side, 4 * RATE);
  assert.equal(ofType(sev, 'reflect').length, 2);
  assert.equal(ofType(sev, 'hit').length, 0);
  assert.equal(sb.hp, 6000);
  assert.equal(side.shots.length, 0);
  assert.match(DEF.airgap.desc, /if it is in that lane/);
  // a returned shot whose thrower is gone flies off the field
  const sim3 = newSim();
  put(sim3, 'airgap', 0, 6);
  const p3 = enemy(sim3, 'phisher', 0, 9);
  until(sim3, () => ofType(sim3.events, 'reflect').length > 0, 30 * RATE);
  p3.hp = 0;
  run(sim3, 1);
  p3.hp = 300;
  sim3.enemies.length = 0;
  run(sim3, 2 * RATE);
  assert.equal(sim3.shots.length, 0);
  // an Exploit stops at it
  const sim4 = newSim();
  const ag4 = put(sim4, 'airgap', 3, 4);
  const ex = enemy(sim4, 'exploit', 3, 4.5 + REACH);
  run(sim4, 1);
  assert.equal(ex.state, 'biting');
  assert.ok(ag4.hp < 1800);
});

test('packet-siege expansion: a Backup restores a destroyed defender in the 3x3 around it at once, at full HP, in the same cell, then waits 60 s', () => {
  const sim = newSim();
  const bk = put(sim, 'backup', 2, 2);
  const fw = put(sim, 'firewall', 2, 3);
  fw.t = 100000;
  fw.hp = 1;
  enemy(sim, 'bot', 2, 3.5 + REACH);
  let events = run(sim, 1);
  const rest = ofType(events, 'restore');
  assert.equal(rest.length, 1);
  const fresh = standing(sim, rest[0].id);
  assert.deepEqual(rest[0], { type: 'restore', id: fresh.id, by: bk.id, old: fw.id, def: 'firewall', lane: 2, col: 3 });
  assert.deepEqual([fresh.type, fresh.lane, fresh.col, fresh.t], ['firewall', 2, 3, 0]);
  assert.ok(fresh.hp > 300 - 2, 'full HP (one bite since)');
  assert.equal(bk.t, 60 * RATE);
  assert.equal(bk.fire, C.FIRE_ANIM, 'it shows its firing frame from the next step');
  assert.equal(events.findIndex((e) => e.type === 'destroyed') < events.indexOf(rest[0]), true);
  // cooling down: the next one is lost
  fresh.hp = 1;
  events = run(sim, 2);
  assert.equal(ofType(events, 'restore').length, 0);
  assert.equal(ofType(events, 'destroyed').length, 1);
  sim.enemies[0].hp = 0;
  // 60 s later it is ready again
  run(sim, 60 * RATE);
  assert.equal(bk.t, 0);
});

test('packet-siege expansion: a Backup restores no instant, no Backup, no Canary, nothing removed, spent or out of reach; a disabled one restores nothing', () => {
  const sim = newSim();
  const bk = put(sim, 'backup', 2, 2);
  const nr = put(sim, 'nullroute', 1, 1);
  nr.hp = 1;
  enemy(sim, 'bot', 1, 1.5 + REACH);
  const bk2 = put(sim, 'backup', 3, 3);
  bk2.hp = 1;
  enemy(sim, 'bot', 3, 3.5 + REACH);
  const farFw = put(sim, 'firewall', 2, 4);
  farFw.hp = 1;
  farFw.t = 100000;
  enemy(sim, 'bot', 2, 4.5 + REACH);
  const pot = put(sim, 'honeypot', 1, 3);
  pot.t = 1;
  enemy(sim, 'bot', 1, 3.5 + REACH);
  const events = run(sim, 2);
  assert.deepEqual(ofType(events, 'destroyed').map((d) => d.def).sort(), ['backup', 'firewall', 'honeypot', 'nullroute']);
  assert.equal(ofType(events, 'restore').length, 0);
  assert.equal(bk.t, 0);
  const psu = put(sim, 'psu', 1, 2);
  pks.pksRemove(sim, 1, 2);
  assert.equal(ofType(sim.events, 'restore').length, 0, 'removing is not destroying');
  assert.ok(!standing(sim, psu.id));
  // a Canary (a free decoy every minute would be a free wall)
  const sim3 = newSim();
  const b3 = put(sim3, 'backup', 2, 2);
  const can = put(sim3, 'canary', 2, 3);
  can.hp = 1;
  enemy(sim3, 'bot', 2, 3.5 + REACH);
  const ev3 = run(sim3, 1);
  assert.deepEqual(ofType(ev3, 'destroyed').map((d) => d.def), ['canary']);
  assert.equal(ofType(ev3, 'restore').length, 0);
  assert.equal(b3.t, 0, 'still ready for something worth restoring');
  // disabled
  const sim2 = newSim();
  const b2 = put(sim2, 'backup', 0, 0);
  b2.off = 100;
  const psu2 = put(sim2, 'psu', 0, 1);
  psu2.hp = 1;
  enemy(sim2, 'bot', 0, 1.5 + REACH);
  assert.equal(ofType(run(sim2, 1), 'restore').length, 0);
});

test('packet-siege expansion: a Backup vs a crushed grate (restored, then crushed for good), a wiped wall (restored) and a Logic Bomb that takes the Backup too', () => {
  const sim = newSim();
  put(sim, 'backup', 1, 3);
  const grate = put(sim, 'waf', 1, 4);
  enemy(sim, 'brute', 1, 5.32);
  let events = run(sim, 20);
  assert.deepEqual(ofType(events, 'destroyed').map((d) => d.why), ['crushed', 'crushed']);
  assert.equal(ofType(events, 'restore').length, 1);
  assert.equal(ofType(events, 'restore')[0].old, grate.id);
  const sim2 = newSim();
  put(sim2, 'backup', 0, 2);
  const wall = put(sim2, 'proxy', 0, 3);
  const w = enemy(sim2, 'wiper', 0, 3.5 + REACH);
  events = run(sim2, 1);
  assert.equal(ofType(events, 'wipe')[0].id, wall.id);
  const back = standing(sim2, ofType(events, 'restore')[0].id);
  assert.deepEqual([back.type, back.hp], ['proxy', 2400]);
  assert.equal(alive(sim2, w.id), undefined);
  // the blast reaches the Backup (lane 1) before the PSU (lane 2): nothing comes back
  const sim3 = newSim();
  put(sim3, 'backup', 1, 4);
  put(sim3, 'psu', 2, 4);
  const bomb = still(sim3, 'logicbomb', 2, 5.5);
  bomb.hp = 1;
  bomb.frozen = 100;
  put(sim3, 'nullroute', 3, 6);
  events = run(sim3, 60);
  assert.equal(ofType(events, 'destroyed').filter((d) => d.why === 'blast').length, 2);
  assert.equal(ofType(events, 'restore').length, 0);
});

test('packet-siege expansion: a Scrubber destroys every enemy on the floor whose full HP is 200 or less; a Drone a Hive releases in the same step survives', () => {
  const sim = newSim();
  const sc = put(sim, 'scrubber', 0, 0);
  const small = [still(sim, 'bot', 1, 5), still(sim, 'kiddie', 2, 5), still(sim, 'drone', 3, 5)];
  const big = [still(sim, 'worm', 4, 5), still(sim, 'payload', 1, 6), still(sim, 'bot', 2, 9.5)];
  const hurt = still(sim, 'worm', 3, 6);
  hurt.hp = 10;
  const dead = still(sim, 'bot', 4, 6);
  dead.hp = 0;
  const b = boss(sim, 1, 0, 6);
  b.frozen = 1000;
  const h = still(sim, 'hive', 3, 7);
  h.t = 30;
  const events = run(sim, 30);
  assert.deepEqual(ofType(events, 'scrub'), [{ type: 'scrub', id: sc.id, def: 'scrubber', lane: 0, col: 0 }]);
  assert.deepEqual(ofType(events, 'kill').map((k) => [k.id, k.by]), small.map((e) => [e.id, 'instant']));
  for (const e of big.concat([hurt, b, h])) assert.ok(alive(sim, e.id), e.type + ' stays');
  const rel = ofType(events, 'release');
  assert.equal(rel.length, 1);
  assert.ok(alive(sim, rel[0].child), 'the Drone came after the scrub');
  assert.equal(standing(sim, sc.id), undefined, 'spent');
});

test('packet-siege expansion: a Decryptor strips a shield at once with a double hit, and hits armoured enemies double', () => {
  const sim = newSim();
  const dc = put(sim, 'decryptor', 2, 0);
  const p = still(sim, 'payload', 2, 5);
  let events = run(sim, 60);
  assert.deepEqual(ofType(events, 'shieldBreak'), [{ type: 'shieldBreak', id: p.id, lane: 2, x: 5, by: 'decrypt' }]);
  const dmg = DEF.decryptor.dmg;
  assert.deepEqual([p.shield, p.hp], [0, 500 - 2 * dmg]);
  assert.equal(ofType(events, 'shot')[0].kind, 'decrypt');
  assert.equal(ofType(events, 'hit')[0].kind, 'decrypt');
  events = run(sim, 90);
  assert.equal(p.hp, 500 - 3 * dmg, 'no shield left: a plain hit');
  assert.equal(dc.t > 0, true);
  const sim2 = newSim();
  put(sim2, 'decryptor', 0, 0);
  put(sim2, 'decryptor', 1, 0);
  const brute = still(sim2, 'brute', 0, 5);
  const bot = still(sim2, 'bot', 1, 5);
  run(sim2, 60);
  assert.deepEqual([brute.hp, bot.hp], [1600 - 2 * DEF.decryptor.dmg, 200 - DEF.decryptor.dmg]);
  for (const id of DEF.decryptor.armoured) assert.ok(ENEMY[id], id);
});

test('packet-siege expansion: a Honeynet goes off like a Honeypot and arms again 20 s later; while it re-arms it is bitten; a crusher sets it off, armed or not, and crushes it if it lives', () => {
  const sim = newSim();
  const hn = put(sim, 'honeynet', 0, 4);
  hn.t = 1;
  run(sim, 1);
  assert.equal(hn.state, 'armed');
  const w1 = enemy(sim, 'worm', 0, 5.2);
  let events = run(sim, 1);
  assert.deepEqual(ofType(events, 'blast'), [{ type: 'blast', id: hn.id, def: 'honeynet', lane: 0, col: 4 }]);
  assert.equal(w1.hp, 0);
  assert.equal(ofType(events, 'destroyed').length, 0, 'it stays');
  assert.deepEqual([hn.state, hn.t], ['arming', 20 * RATE]);
  const bot = enemy(sim, 'bot', 0, 4.5 + REACH);
  run(sim, 60);
  assert.ok(hn.hp < 300 && bot.state === 'biting', 'bitten while it re-arms');
  bot.hp = 0;
  events = run(sim, 20 * RATE);
  assert.equal(ofType(events, 'armed').length, 1);
  assert.equal(hn.state, 'armed');
  const w2 = enemy(sim, 'worm', 0, 5.2);
  run(sim, 1);
  assert.equal(w2.hp, 0, 'and goes off again');
  // a crusher: armed, it goes off, and the Brute that lives through it
  // crushes it at once
  const sim2 = newSim();
  const h2 = put(sim2, 'honeynet', 1, 4);
  h2.t = 1;
  run(sim2, 1);
  const br = enemy(sim2, 'brute', 1, 4.5 + REACH);
  events = run(sim2, 1);
  assert.equal(br.hp, 1600 - 900);
  assert.deepEqual(ofType(events, 'blast').map((x) => x.id), [h2.id]);
  assert.deepEqual(ofType(events, 'destroyed').map((d) => [d.id, d.why]), [[h2.id, 'crushed']]);
  assert.equal(ofType(run(sim2, 60), 'blast').length, 0, 'one blast');
  // still arming for the first time: it goes off like a Honeypot in the
  // same spot (the review's repro: a Brute at 4.15 onto an unarmed trap)
  for (const type of ['honeypot', 'honeynet']) {
    const s3 = newSim();
    const trap = put(s3, type, 2, 3);
    const b3 = enemy(s3, 'brute', 2, 4.15);
    const ev3 = run(s3, 3 * RATE);
    assert.equal(trap.state, 'arming', type + ' not armed');
    assert.deepEqual(ofType(ev3, 'blast').map((x) => x.id), [trap.id], type);
    assert.equal(b3.hp, 1600 - 900, type);
    assert.equal(ofType(ev3, 'destroyed')[0].why, type === 'honeypot' ? 'spent' : 'crushed', type);
  }
  // a crusher the blast kills leaves it standing: it re-arms
  const s4 = newSim();
  const h4 = put(s4, 'honeynet', 2, 3);
  const b4 = enemy(s4, 'brute', 2, 4.15);
  b4.hp = 800;
  const ev4 = run(s4, 3 * RATE);
  assert.equal(ofType(ev4, 'blast').length, 1);
  assert.equal(b4.hp, 0);
  assert.equal(ofType(ev4, 'destroyed').length, 0);
  assert.deepEqual([h4.hp, h4.state, h4.t], [300, 'arming', 20 * RATE - (3 * RATE - 1)], 'went off on the first step');
});

// ── determinism and plain data ─────────────────────────────────────────────

// A busy floor: every new defender and every new enemy, a few old ones and
// a boss, with enemies streaming in from a level's spawns.
function busy() {
  const spawns = [];
  const types = NEW_ENEMIES.concat(['bot', 'phisher', 'exploit', 'brute', 'rootkit', 'trojan']);
  for (let i = 0; i < 90; i++) spawns.push({ t: 1 + i * 1.3, lane: (i * 3) % 5, type: types[i % types.length] });
  spawns.push({ t: 20, lane: 2, type: 'boss' });
  const sim = pks.pksNewSim(level({ spawns, boss: 4 }), ALL);
  const cells = [
    ['canary', 0, 6], ['tracer', 1, 1], ['batch', 2, 0], ['loopback', 3, 1], ['tokenring', 4, 1], ['sigdb', 1, 2],
    ['sinkhole', 2, 4], ['airgap', 3, 5], ['backup', 2, 2], ['decryptor', 2, 1], ['honeynet', 4, 6],
    ['firewall', 1, 3], ['ids', 0, 1], ['proxy', 1, 6], ['psu', 0, 0], ['ups', 4, 0], ['limiter', 3, 3]
  ];
  for (const [id, l, c] of cells) put(sim, id, l, c);
  return sim;
}

function play(sim, steps, seen) {
  for (let i = 0; i < steps && sim.status === 'playing'; i++) {
    if (i === 900) {
      sim.cards.find((c) => c.id === 'scrubber').left = 0;
      pks.pksPlace(sim, 'scrubber', 0, 3);
    }
    pks.pksStep(sim);
    if (seen) for (const e of sim.events) seen.add(e.type);
  }
  return sim;
}

test('packet-siege expansion: the same inputs give the identical state with every new unit on the floor, and a JSON copy plays on identically', () => {
  const seen = new Set();
  const a = play(busy(), 1800, seen);
  const b = play(busy(), 1800);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const copy = JSON.parse(JSON.stringify(a));
  for (let i = 0; i < 3000 && a.status === 'playing'; i++) {
    pks.pksStep(a);
    pks.pksStep(copy);
    for (const e of a.events) seen.add(e.type);
  }
  assert.equal(JSON.stringify(copy), JSON.stringify(a), 'the state is all in the data');
  // the floor really was busy: the new mechanics fired
  for (const t of ['steal', 'detonate', 'wipe', 'release', 'split', 'shieldBreak', 'jam', 'throw', 'blink', 'trace', 'lob', 'splash',
    'knock', 'arc', 'pull', 'scrub']) {
    assert.ok(seen.has(t), t);
  }
});

test('packet-siege expansion: a step stays cheap with the new rules: 20 000 steps of a busy floor in well under the suite\'s budget', () => {
  const sim = busy();
  const start = process.hrtime.bigint();
  let steps = 0;
  for (; steps < 20000; steps++) {
    // keep the game going whatever leaks through
    for (const l of [0, 1, 2, 3, 4]) sim.breakers[l] = 'armed';
    sim.status = 'playing';
    pks.pksStep(sim);
  }
  assert.ok(sim.enemies.length > 0 || sim.spawnIndex === sim.level.spawns.length);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 4000, ms + ' ms');
});
