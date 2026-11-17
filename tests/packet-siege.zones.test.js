// tests/packet-siege.zones.test.js
// Packet Siege, levels 51-150 (.claude/packet-siege/spec-150.md, phase 2):
// the level table of 51-150, the rules of zones 6-15 (express lanes, hot
// cells, power rails, tunnels, blackouts, crossovers, upkeep, outages, fog,
// the root's pairs) on hand-made scenarios and with the units they meet,
// boss tiers 6-15, determinism over real late levels, the idle player and
// the overtime that ends every late level.  The campaign contract of 51-150
// (the players on every level) is in packet-siege.campaign.test.js and
// packet-siege.campaign-late.test.js; levels 1-50 are pinned by the freeze
// test in packet-siege.expansion.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScript } = require('./_setup');

const pks = loadScript('packet-siege/script.js');

const C = pks.pksConstants;
const DEF = pks.pksDefender;
const ENEMY = pks.pksEnemy;
const TIERS = pks.pksBossTiers;
const ALL = pks.pksDefenders.map((d) => d.id);
const RATE = 60;
const LATE = Array.from({ length: 100 }, (_, i) => i + 51);

// The scripted players of packet-siege.sim.test.js (the block between its
// players markers), as tune.js reads them.
const SIM_TEST = fs.readFileSync(path.join(__dirname, 'packet-siege.sim.test.js'), 'utf8');
// eslint-disable-next-line no-new-func
const PLAYERS = new Function(SIM_TEST.slice(SIM_TEST.indexOf('// ── players ──'), SIM_TEST.indexOf('// ── end players ──')) + '\nreturn players;')()(pks);

// ── helpers ────────────────────────────────────────────────────────────────

const rules = (over) => Object.assign(pks.pksNoRules(), over);

// A hand-made level: five lanes, no trickle, plenty of cycles, one far spawn
// so the sim keeps playing, and the given rules.
function level(over) {
  return Object.assign({
    n: 120, zone: 12, zoneName: 'Test', name: 'Test', lanes: [0, 1, 2, 3, 4], blocked: [], fog: 0,
    trickle: false, startCycles: 100000, slots: 27, speed: 1, boss: 0,
    spawns: [{ t: 9999, lane: 0, type: 'bot' }], surges: [], duration: 600, budget: 1,
    unlock: null, intro: null, hint: null, rules: rules({})
  }, over);
}

function newSim(over, loadout) {
  return pks.pksNewSim(level(over), loadout || ALL);
}

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

// A target that neither moves nor dies.
function dummy(sim, lane, x) {
  const e = still(sim, 'bot', lane, x);
  e.hp = e.maxHp = 1e9;
  return e;
}

function boss(sim, tier, lane, x) {
  return pks.pksSpawnEnemy(sim, 'boss', lane, x, tier);
}

function run(sim, n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    pks.pksStep(sim);
    for (const e of sim.events) events.push(e);
  }
  return events;
}

// Steps until an event of `type` (matching `pick`) happens; returns the tick.
function untilEvent(sim, type, max, pick) {
  for (let i = 0; i < max; i++) {
    pks.pksStep(sim);
    if (sim.events.some((e) => e.type === type && (!pick || pick(e)))) return sim.tick;
  }
  assert.fail(type + ' within ' + max + ' steps');
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const alive = (sim, id) => sim.enemies.find((e) => e.id === id);
const standing = (sim, id) => sim.defenders.find((d) => d.id === id);
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-9);
const zoneOf = (n) => Math.ceil(n / 10);
const cellsOf = (R) => R.hot.concat(R.rails, R.tunnels, R.cross);

// ── the table of levels 51-150 ─────────────────────────────────────────────

const ZONE_RULES = {
  6: ['express'], 7: ['hot'], 8: ['rails'], 9: ['tunnels'], 10: ['blackout'],
  11: ['cross'], 12: ['upkeep'], 13: ['outage'], 14: ['express', 'fog']
};

// The nominal length of level n > 50: 720 s at level 50, 5.5 s more a level,
// rounded to 5 s (about 12 minutes at L51, 21 at L150).
const lengthOf = (n) => Math.round((720 + 5.5 * (n - 50)) / 5) * 5;

test('packet-siege zones: 150 levels; zones 6-15 with a name and a one-line rule; rows 51-150 are [name, budget, 720 s + 5.5 s a level]', () => {
  assert.equal(C.LEVELS, 150);
  assert.equal(pks.pksLevelRows.length, 150);
  assert.deepEqual(pks.pksZones.slice(5).map((z) => z.zone), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  for (const z of pks.pksZones) assert.ok(z.name.length > 2 && z.desc.length > 20 && z.desc.length < 90 && !z.desc.includes('\n'), z.name);
  const names = new Set(pks.pksLevelRows.map((r) => r[0]));
  assert.equal(names.size, 150, 'every level has its own name');
  for (const n of LATE) {
    const row = pks.pksLevelRows[n - 1];
    assert.ok(row[0].length >= 5 && row[0].length <= 20, n + ' ' + row[0]);
    assert.equal(row[2], lengthOf(n));
    assert.equal(row[2] % 5, 0);
  }
  assert.equal(pks.pksLevelRows[50][2], 725, 'about 12 minutes at level 51');
  assert.equal(pks.pksLevelRows[149][2], 1270, 'about 21 minutes at level 150');
  assert.equal(pks.pksLevelRows[149][0], 'The Architect');
  // the numbers of each zone line are the rule's own
  const nums = (z) => (pks.pksZones[z - 1].desc.match(/\d+/g) || []).map(Number);
  assert.deepEqual(nums(6), [Math.round((C.EXPRESS - 1) * 100)]);
  assert.deepEqual(nums(7), [C.HOT_DPS]);
  assert.deepEqual(nums(8), [Math.round((C.RAIL - 1) * 100)]);
  assert.deepEqual(nums(9), [C.TUNNEL_COL, C.TUNNEL_EVERY, C.SHIMMER]);
  assert.deepEqual(nums(10), [C.BLACKOUT_EVERY, C.BLACKOUT_LENGTH, C.BLACKOUT_WARN, C.BLACKOUT_SIGHT]);
  assert.deepEqual(nums(11), []);
  assert.deepEqual(nums(12), [C.UPKEEP_COST, C.UPKEEP_EVERY]);
  assert.deepEqual(nums(13), [C.OUTAGE_EVERY, C.OUTAGE_LENGTH, C.OUTAGE_WARN]);
  assert.deepEqual(nums(14), [C.LATE_FOG]);
  assert.deepEqual(nums(15), [Math.round((C.ROOT_SPEED - 1) * 100)]);
  assert.deepEqual(pks.pksRuleOrder, ['express', 'hot', 'rails', 'tunnels', 'blackout', 'cross', 'upkeep', 'outage', 'fog']);
});

test('packet-siege zones: levels 51-150 are plain data of the old shape plus rules, with their surges, lanes, slots, unlocks and intros', () => {
  const old = Object.keys(pks.pksLevel(50));
  for (const n of LATE) {
    const lv = pks.pksLevel(n);
    const z = zoneOf(n);
    assert.deepEqual(JSON.parse(JSON.stringify(lv)), lv, n + ' plain data');
    assert.deepEqual(pks.pksLevel(n), lv, n + ' the same on every call');
    assert.deepEqual(Object.keys(lv), old.concat(['rules']), n + ' keys');
    assert.equal(lv.n, n);
    assert.equal(lv.zone, z);
    assert.equal(lv.zoneName, pks.pksZones[z - 1].name);
    assert.equal(lv.name, pks.pksLevelRows[n - 1][0]);
    assert.deepEqual(lv.lanes, [0, 1, 2, 3, 4]);
    assert.deepEqual(lv.blocked, []);
    assert.equal(lv.slots, n > 110 ? 10 : n > 70 ? 9 : 8);
    assert.equal(lv.boss, n % 10 === 0 ? n / 10 : 0);
    assert.equal(lv.speed, z === 15 ? C.ROOT_SPEED : 1);
    assert.equal(lv.duration, lengthOf(n));
    assert.equal(lv.surges.length, 13 + Math.floor((n - 51) / 10), n + ' surges');
    for (let i = 0; i < lv.surges.length; i++) {
      assert.ok(lv.surges[i] > (i ? lv.surges[i - 1] : 25) && lv.surges[i] < lv.duration, n + ' surge ' + i);
    }
    assert.equal(lv.unlock, pks.pksLevelUnlock(n));
    const intro = pks.pksEnemies.find((e) => e.first === n);
    assert.equal(lv.intro, intro ? intro.id : null);
    assert.equal(lv.hint, null);
    let budget = 0;
    for (let i = 0; i < lv.spawns.length; i++) {
      const s = lv.spawns[i];
      assert.ok(i === 0 || s.t >= lv.spawns[i - 1].t, n + ' sorted');
      assert.ok(s.t >= 25 && s.t < lv.duration, n + ' spawn at ' + s.t);
      assert.ok(lv.lanes.includes(s.lane));
      if (s.tunnel) {
        assert.deepEqual(Object.keys(s), ['t', 'lane', 'type', 'tunnel']);
        assert.equal(s.tunnel, true);
        assert.ok(lv.rules.tunnels.some((t) => t.lane === s.lane), n + ' tunnel spawn in a tunnel lane');
      } else {
        assert.deepEqual(Object.keys(s), ['t', 'lane', 'type']);
      }
      if (s.type === 'boss') continue;
      assert.ok(ENEMY[s.type].first <= n, n + ' ' + s.type + ' is introduced by then');
      budget += ENEMY[s.type].threat;
    }
    assert.equal(lv.budget, Math.round(budget * 10) / 10);
    const bosses = lv.spawns.filter((s) => s.type === 'boss');
    assert.equal(bosses.length, n === 150 ? 2 : lv.boss ? 1 : 0, n + ' bosses');
    for (const b of bosses) assert.equal(b.t, lv.surges[lv.surges.length - 1], n + ' the boss comes with the final surge');
    if (n === 150) assert.deepEqual(bosses.map((b) => b.lane), [1, 3]);
    // the final surge is the biggest
    const foes = lv.spawns.filter((s) => s.type !== 'boss');
    const share = lv.surges.map((at) => foes.filter((s) => s.t >= at && s.t < at + 20).reduce((a, s) => a + ENEMY[s.type].threat, 0));
    assert.equal(Math.max(...share), share[share.length - 1], n + ' final surge');
    // steady flow after the first minute
    for (let i = 1; i < foes.length; i++) {
      if (foes[i - 1].t >= 60) assert.ok(foes[i].t - foes[i - 1].t <= 36, n + ': ' + foes[i - 1].t + ' to ' + foes[i].t);
    }
  }
});

test('packet-siege zones: the rules of a level are well-formed, inside the floor, and leave every lane buildable', () => {
  for (const n of LATE) {
    const lv = pks.pksLevel(n);
    const R = lv.rules;
    const z = zoneOf(n);
    // 141 had express + hot until the sim review (2026-11-17): at the root
    // that pair held no draw with 10 % to spare
    const roots = [['hot', 'tunnels'], ['rails', 'blackout'], ['tunnels', 'cross'], ['upkeep', 'outage'], ['express', 'blackout'],
      ['hot', 'outage'], ['rails', 'cross'], ['tunnels', 'upkeep'], ['cross', 'fog'], ['express', 'outage']];
    const want = z === 15 ? roots[n - 141] : ZONE_RULES[z];
    assert.deepEqual(R.names, pks.pksRuleOrder.filter((r) => want.includes(r)), n + ' names');
    assert.deepEqual(Object.keys(R), Object.keys(pks.pksNoRules()), n + ' every key');
    const has = (r) => R.names.includes(r);
    // express
    if (has('express')) {
      assert.ok(R.express.length >= 1 && R.express.length <= 2 && new Set(R.express).size === R.express.length, n + ' express');
      for (const l of R.express) assert.ok(l >= 0 && l < 5);
      assert.deepEqual(R.express, R.express.slice().sort());
    } else {
      assert.deepEqual(R.express, []);
    }
    const inRange = (cells, lo, hi, name) => {
      for (const c of cells) assert.ok(c.lane >= 0 && c.lane < 5 && c.col >= lo && c.col <= hi, n + ' ' + name + ' ' + JSON.stringify(c));
    };
    assert.ok(has('hot') ? R.hot.length >= 3 && R.hot.length <= 6 : R.hot.length === 0, n + ' hot');
    inRange(R.hot, 1, 8, 'hot');
    assert.ok(has('rails') ? R.rails.length >= 3 && R.rails.length <= 5 : R.rails.length === 0, n + ' rails');
    inRange(R.rails, 0, 7, 'rails');
    assert.ok(has('tunnels') ? R.tunnels.length >= 1 && R.tunnels.length <= 2 : R.tunnels.length === 0, n + ' tunnels');
    for (const t of R.tunnels) assert.deepEqual(Object.keys(t), ['lane', 'col', 'every']);
    for (const t of R.tunnels) assert.ok(t.col === C.TUNNEL_COL && t.every === C.TUNNEL_EVERY);
    assert.equal(new Set(R.tunnels.map((t) => t.lane)).size, R.tunnels.length);
    assert.ok(has('cross') ? R.cross.length >= 2 && R.cross.length <= 4 : R.cross.length === 0, n + ' cross');
    inRange(R.cross, 2, 7, 'cross');
    assert.equal(new Set(R.cross.map((c) => c.col)).size, R.cross.length, n + ' one crossover a column');
    for (const c of R.cross) assert.ok(Math.abs(c.to - c.lane) === 1 && c.to >= 0 && c.to < 5, n + ' arrow ' + JSON.stringify(c));
    const cells = cellsOf(R).map((c) => c.lane * 9 + c.col);
    assert.equal(new Set(cells).size, cells.length, n + ' no two rule cells share a cell');
    // every lane keeps at least seven cells a defender can stand on
    for (let l = 0; l < 5; l++) assert.ok(9 - R.tunnels.filter((t) => t.lane === l).length >= 7);
    assert.deepEqual(R.blackout, has('blackout') ? { every: 50, length: 10, warn: 3, sight: 4 } : null);
    assert.deepEqual(R.upkeep, has('upkeep') ? { cost: 1, every: 12 } : null);
    if (has('outage')) {
      assert.deepEqual(Object.keys(R.outage), ['every', 'length', 'warn', 'order']);
      assert.deepEqual([R.outage.every, R.outage.length, R.outage.warn], [C.OUTAGE_EVERY, C.OUTAGE_LENGTH, C.OUTAGE_WARN]);
      assert.deepEqual(R.outage.order.slice().sort(), [0, 1, 2, 3, 4]);
    } else {
      assert.equal(R.outage, null);
    }
    assert.equal(lv.fog, has('fog') ? 5 : 0);
    assert.equal(lv.trickle, !has('rails'));
    assert.equal(lv.startCycles, has('rails') ? C.BROWNOUT_CYCLES : 100);
    assert.equal(R.trickle, has('rails') ? 0 : 25, n + ' the trickle (no longer doubled under upkeep)');
  }
  // every rule is somewhere at the root, and both lanes at the floor's edges
  // get arrows inward
  const root = new Set();
  for (let n = 141; n <= 150; n++) for (const r of pks.pksLevel(n).rules.names) root.add(r);
  assert.deepEqual([...root].sort(), pks.pksRuleOrder.slice().sort());
  const arrows = LATE.flatMap((n) => pks.pksLevel(n).rules.cross);
  for (const c of arrows) if (c.lane === 0 || c.lane === 4) assert.equal(c.to, c.lane === 0 ? 1 : 3);
  assert.ok(arrows.some((c) => c.to < c.lane) && arrows.some((c) => c.to > c.lane));
});

test('packet-siege zones: every 3rd spawn of a tunnel lane comes out of the tunnel, never the boss or the level\'s new enemy', () => {
  let marked = 0;
  for (const n of LATE) {
    const lv = pks.pksLevel(n);
    for (const t of lv.rules.tunnels) {
      const mine = lv.spawns.filter((s) => s.lane === t.lane && s.type !== 'boss' && s.type !== lv.intro);
      mine.forEach((s, i) => assert.equal(!!s.tunnel, i % 3 === 2, n + ' lane ' + t.lane + ' spawn ' + i));
      marked += mine.filter((s) => s.tunnel).length;
    }
    for (const s of lv.spawns) if (s.type === 'boss' || s.type === lv.intro) assert.ok(!s.tunnel);
  }
  assert.ok(marked > 100, marked + ' tunnel spawns');
});

test('packet-siege zones: the threat budget rises strictly from level 49 over every non-boss level to 150; boss levels go by tier', () => {
  let last = pks.pksLevel(49).budget;
  for (const n of LATE) {
    const lv = pks.pksLevel(n);
    if (lv.boss) {
      assert.equal(TIERS[lv.boss - 1].level, n);
      assert.ok(lv.budget < last, n + ' escort');
      continue;
    }
    assert.ok(lv.budget > last, 'level ' + n + ': ' + lv.budget + ' after ' + last);
    last = lv.budget;
  }
});

// ── the sim of a level with rules ──────────────────────────────────────────

test('packet-siege zones: a new sim carries the rule clocks its level needs, and none for a level without them', () => {
  const plain = pks.pksNewSim(1, []);
  assert.deepEqual([plain.shimmers, plain.blackout, plain.outage, plain.upkeep], [[], null, null, null]);
  const lv = level({ rules: rules({ blackout: { every: 50, length: 10, warn: 3, sight: 4 }, upkeep: { cost: 1, every: 12 },
    outage: { every: 45, length: 8, warn: 5, order: [3, 1, 4, 0, 2] } }) });
  const sim = pks.pksNewSim(lv, []);
  assert.deepEqual(sim.blackout, { state: 'clear', t: 47 * RATE, count: 0 });
  assert.deepEqual(sim.outage, { state: 'clear', lane: -1, next: 3, t: 40 * RATE, count: 0 });
  assert.deepEqual(sim.upkeep, { t: 12 * RATE, last: 0, due: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(sim)), sim);
  // a real level: the clocks of its rules
  const l144 = pks.pksNewSim(144, []);
  assert.ok(l144.upkeep && l144.outage && !l144.blackout);
});

test('packet-siege zones: express lanes — enemies there walk 40 % faster, with an Amplifier and the zone speed on top', () => {
  const sim = newSim({ rules: rules({ express: [1, 3] }) });
  const slow = enemy(sim, 'bot', 0, 8);
  const fast = enemy(sim, 'bot', 1, 8);
  const ampd = enemy(sim, 'bot', 3, 6);
  still(sim, 'amplifier', 3, 5);
  run(sim, 60);
  assert.ok(near(8 - slow.x, 0.2));
  assert.ok(near(8 - fast.x, 0.2 * 1.4));
  assert.ok(near(6 - ampd.x, 0.2 * 1.3 * 1.4, 1e-6), 'the haste and the lane multiply');
  // the zone speed and a slow
  const root = newSim({ speed: 1.25, rules: rules({ express: [2] }) });
  const b = enemy(root, 'bot', 2, 8);
  b.slow = 1000;
  run(root, 60);
  assert.ok(near(8 - b.x, 0.2 * 1.25 * 0.5 * 1.4));
  // a lane change into an express lane speeds it up from then on
  const sim2 = newSim({ rules: rules({ express: [2] }) });
  const pm = enemy(sim2, 'bot', 1, 8);
  run(sim2, 1);
  pm.lane = 2;
  const x = pm.x;
  run(sim2, 60);
  assert.ok(near(x - pm.x, 0.28));
});

test('packet-siege zones: hot cells — a defender there loses 8 HP/s and burns down; a Patch Server out-heals it, a Backup restores it onto the hot cell', () => {
  const sim = newSim({ rules: rules({ hot: [{ lane: 1, col: 3 }] }) });
  const fw = put(sim, 'firewall', 1, 3);
  const cool = put(sim, 'firewall', 1, 4);
  run(sim, 60);
  assert.ok(near(fw.hp, 300 - 8, 1e-6));
  assert.equal(cool.hp, 300);
  const events = run(sim, 37 * RATE);
  assert.deepEqual(ofType(events, 'destroyed'), [{ type: 'destroyed', id: fw.id, def: 'firewall', lane: 1, col: 3, why: 'burnt' }]);
  // a Patch Server next to it: healed back to full every step
  const sim2 = newSim({ rules: rules({ hot: [{ lane: 1, col: 3 }] }) });
  const wall = put(sim2, 'proxy', 1, 3);
  put(sim2, 'patch', 0, 3);
  run(sim2, 600);
  assert.equal(wall.hp, 2400);
  // a Backup: restored at once onto the same hot cell, at full HP, burning again
  const sim3 = newSim({ rules: rules({ hot: [{ lane: 2, col: 5 }] }) });
  const psu = put(sim3, 'psu', 2, 5);
  const bk = put(sim3, 'backup', 2, 4);
  psu.hp = 0.05;
  const ev3 = run(sim3, 1);
  const restore = ofType(ev3, 'restore')[0];
  assert.deepEqual([restore.by, restore.old, restore.lane, restore.col], [bk.id, psu.id, 2, 5]);
  assert.equal(ofType(ev3, 'destroyed')[0].why, 'burnt');
  run(sim3, 60);
  assert.ok(near(standing(sim3, restore.id).hp, 300 - 8, 1e-6));
  // heat burns under an outage too, and a grate burns like anything else
  const sim4 = newSim({ rules: rules({ hot: [{ lane: 0, col: 2 }], outage: { every: 45, length: 8, warn: 5, order: [0, 1, 2, 3, 4] } }) });
  const waf = put(sim4, 'waf', 0, 2);
  sim4.outage.state = 'warn';
  sim4.outage.lane = 0;
  sim4.outage.t = 1;
  run(sim4, 60);
  assert.equal(sim4.outage.state, 'down');
  assert.ok(waf.hp < 300);
});

// [defender, setup(sim) of its targets, the event that marks its action]
const TIMED = [
  ['psu', () => {}, 'produce'],
  ['ups', () => {}, 'produce'],
  ['firewall', (s) => dummy(s, 0, 7), 'shot'],
  ['ids', (s) => dummy(s, 0, 7), 'shot'],
  ['limiter', (s) => dummy(s, 0, 1.5), 'pulse'],
  ['inspector', (s) => dummy(s, 0, 7), 'beam'],
  ['tracer', (s) => dummy(s, 0, 7), 'trace'],
  ['batch', (s) => dummy(s, 0, 7), 'lob'],
  ['tokenring', (s) => dummy(s, 0, 7), 'arc'],
  ['decryptor', (s) => dummy(s, 0, 7), 'shot'],
  // (a Loopback throws an enemy at most twice: enough of them to throw)
  ['loopback', (s) => { for (let i = 0; i < 20; i++) dummy(s, 0, 5 + i * 0.1).frozen = 1e9; }, 'knock'],
  ['sinkhole', (s) => { for (let i = 0; i < 20; i++) dummy(s, 1, 2 + i * 0.3).frozen = 1e9; }, 'pull']
];

test('packet-siege zones: power rails — every defender\'s action timer runs 1.5x on a rail: production, shots, pulses, beams, traces, lobs, arcs, knocks, pulls', () => {
  for (const [id, setup, ev] of TIMED) {
    const count = (rail) => {
      const sim = newSim({ rules: rules({ rails: rail ? [{ lane: 0, col: 0 }] : [] }) });
      put(sim, id, 0, 0);
      setup(sim);
      return ofType(run(sim, 3600), ev).filter((e) => (e.owner || e.id) === sim.defenders.find((d) => d.type === id).id).length;
    };
    const off = count(false);
    const on = count(true);
    assert.ok(off >= 4, id + ' acts: ' + off);
    assert.ok(Math.abs(on - 1.5 * off) <= 1.5, id + ': ' + on + ' on a rail, ' + off + ' off');
  }
});

test('packet-siege zones: power rails — a trap arms, an instant fuses, a Backup and a Honeynet recover 1.5x as fast; a grate burns and a patch heals 1.5x; walls, boosts and hits do not change', () => {
  const sim = newSim({ rules: rules({ rails: [{ lane: 0, col: 0 }, { lane: 0, col: 1 }, { lane: 0, col: 2 }, { lane: 0, col: 3 }, { lane: 1, col: 4 }, { lane: 2, col: 4 }] }) });
  const pot = put(sim, 'honeypot', 0, 0);
  const slow = put(sim, 'honeypot', 3, 0);
  const placed = sim.tick;
  const armed = untilEvent(sim, 'armed', 20 * RATE, (e) => e.id === pot.id);
  assert.ok(Math.abs(armed - placed - 8 * RATE) <= 1, 'armed in 8 s, not 12: ' + (armed - placed));
  assert.equal(slow.state, 'arming');
  // a Null Route's 1 s fuse takes 2/3 s
  const nr = put(sim, 'nullroute', 0, 1);
  const at = sim.tick;
  const blast = untilEvent(sim, 'blast', 120, (e) => e.id === nr.id);
  assert.ok(Math.abs(blast - at - 40) <= 1, 'fuse ' + (blast - at));
  // a Backup's cooldown and a Honeynet's re-arming run 1.5 steps a step
  const bk = put(sim, 'backup', 0, 2);
  bk.t = 600;
  const net = put(sim, 'honeynet', 0, 3);
  net.t = 600;
  run(sim, 60);
  assert.ok(Math.abs(bk.t - 510) <= 1 && Math.abs(net.t - 510) <= 1, bk.t + ' ' + net.t);
  // a grate burns 30 HP/s on a rail, a patch heals 60
  const g = newSim({ rules: rules({ rails: [{ lane: 1, col: 4 }, { lane: 2, col: 4 }] }) });
  put(g, 'waf', 1, 4);
  const e = still(g, 'worm', 1, 4.5);
  put(g, 'patch', 2, 4);
  const hurt = put(g, 'proxy', 2, 5);
  hurt.hp = 1000;
  run(g, 60);
  assert.ok(near(560 - e.hp, 30, 1e-6), 'burnt ' + (560 - e.hp));
  assert.ok(near(hurt.hp, 1060, 1e-6), 'healed to ' + hurt.hp);
  // a Signature DB's boost and a shot's damage stay as they are
  const b = newSim({ rules: rules({ rails: [{ lane: 0, col: 0 }, { lane: 0, col: 1 }] }) });
  put(b, 'firewall', 0, 0);
  put(b, 'sigdb', 0, 1);
  dummy(b, 0, 7);
  const hits = ofType(run(b, 300), 'hit');
  assert.ok(hits.length > 0 && hits.every((h) => h.dmg === 30));
});

test('packet-siege zones: tunnels — a marked spawn shimmers on the exit for 2 s, then comes out at column 6; nothing can stand on the exit', () => {
  const lv = level({
    rules: rules({ tunnels: [{ lane: 2, col: 6, every: 3 }] }),
    spawns: [{ t: 1, lane: 2, type: 'worm', tunnel: true }, { t: 9999, lane: 0, type: 'bot' }]
  });
  const sim = pks.pksNewSim(lv, ALL);
  const r = pks.pksCanPlace(sim, 'firewall', 2, 6);
  assert.deepEqual(r, { ok: false, reason: 'tunnel', card: 'firewall', lane: 2, col: 6, cost: 100, cycles: 100000 });
  assert.equal(pks.pksCanPlace(sim, 'firewall', 1, 6).ok, true, 'only the tunnel lane\'s exit');
  assert.equal(pks.pksCanPlace(sim, 'firewall', 2, 5).ok, true);
  const first = run(sim, 60);
  const sh = ofType(first, 'shimmer');
  assert.equal(sh.length, 1);
  assert.deepEqual(sh[0], { type: 'shimmer', id: sh[0].id, lane: 2, col: 6, enemy: 'worm', at: 3 });
  assert.deepEqual(sim.shimmers, [{ id: sh[0].id, lane: 2, col: 6, enemy: 'worm', t: 120 }]);
  assert.equal(ofType(first, 'spawn').length, 0, 'it does not walk in from the right');
  let events = run(sim, 119);
  assert.equal(ofType(events, 'emerge').length, 0);
  assert.equal(sim.shimmers[0].t, 1);
  events = run(sim, 1);
  const em = ofType(events, 'emerge')[0];
  assert.equal(sim.tick, 180, 'exactly 2 s later');
  assert.deepEqual(em, { type: 'emerge', id: em.id, shimmer: sh[0].id, enemy: 'worm', lane: 2, col: 6, x: 6.5 });
  assert.deepEqual(ofType(events, 'spawn'), [{ type: 'spawn', id: em.id, enemy: 'worm', lane: 2, x: 6.5 }]);
  assert.deepEqual(sim.shimmers, []);
  assert.ok(alive(sim, em.id));
  // a level is not won while a shimmer is pending
  const lone = pks.pksNewSim(level({ rules: rules({ tunnels: [{ lane: 2, col: 6, every: 3 }] }), spawns: [{ t: 0.5, lane: 2, type: 'bot', tunnel: true }] }), []);
  run(lone, 31);
  assert.equal(lone.shimmers.length, 1);
  assert.equal(lone.status, 'playing', 'everything spawned, nothing on the floor, but a shimmer');
  run(lone, 120);
  assert.equal(lone.enemies.length, 1);
  lone.enemies[0].hp = 0;
  run(lone, 1);
  assert.equal(lone.status, 'won');
  // a marked spawn in a lane without a tunnel comes out at the usual column
  const odd = pks.pksNewSim(level({ spawns: [{ t: 0.5, lane: 4, type: 'bot', tunnel: true }, { t: 9999, lane: 0, type: 'bot' }] }), []);
  assert.equal(ofType(run(odd, 31), 'shimmer')[0].col, C.TUNNEL_COL);
});

test('packet-siege zones: a tunnel enemy meets a Loopback (thrown back from the exit) and a DNS Sinkhole (pulled out of the tunnel lane)', () => {
  const lv = level({
    rules: rules({ tunnels: [{ lane: 2, col: 6, every: 3 }] }),
    spawns: [{ t: 0.5, lane: 2, type: 'bot', tunnel: true }, { t: 9999, lane: 0, type: 'bot' }]
  });
  const sim = pks.pksNewSim(lv, ALL);
  put(sim, 'loopback', 2, 1);
  const events = run(sim, 30 + 121);
  const em = ofType(events, 'emerge')[0];
  const k = ofType(events, 'knock')[0];
  assert.ok(k, 'the Loopback throws it at once');
  assert.deepEqual([k.target, k.from, k.to], [em.id, 6.5, 8.5]);
  const sim2 = pks.pksNewSim(lv, ALL);
  const sink = put(sim2, 'sinkhole', 1, 6);
  sink.t = 100000;
  const ev2 = run(sim2, 30 + 120);
  const e2 = alive(sim2, ofType(ev2, 'emerge')[0].id);
  sink.t = 0;
  const pulls = ofType(run(sim2, 1), 'pull');
  assert.deepEqual(pulls.map((p) => [p.target, p.from, p.lane]), [[e2.id, 2, 1]]);
  assert.equal(e2.lane, 1);
});

test('packet-siege zones: blackouts — every 50 s from 50 s on, 10 s dark after a 3 s warning; the clock is in the state', () => {
  const sim = newSim({ rules: rules({ blackout: { every: 50, length: 10, warn: 3, sight: 4 } }) });
  const marks = [];
  for (let i = 0; i < 160 * RATE; i++) {
    pks.pksStep(sim);
    for (const e of sim.events) if (e.type === 'blackoutWarn' || e.type === 'blackout') marks.push([sim.tick].concat(Object.values(e)));
    if (sim.tick === 52 * RATE) assert.deepEqual(sim.blackout, { state: 'dark', t: 8 * RATE, count: 1 });
    if (sim.tick === 48 * RATE) assert.deepEqual(sim.blackout, { state: 'warn', t: 2 * RATE, count: 0 });
  }
  assert.deepEqual(marks, [
    [47 * RATE, 'blackoutWarn', 50, 10], [50 * RATE, 'blackout', true], [60 * RATE, 'blackout', false],
    [97 * RATE, 'blackoutWarn', 100, 10], [100 * RATE, 'blackout', true], [110 * RATE, 'blackout', false],
    [147 * RATE, 'blackoutWarn', 150, 10], [150 * RATE, 'blackout', true], [160 * RATE, 'blackout', false]
  ]);
});

// A sim in the dark (a blackout that lasts) with `id` at (0, 0) and a target.
function dark(id, x, lit) {
  const sim = newSim({ rules: rules({ blackout: { every: 50, length: 10, warn: 3, sight: 4 } }) });
  if (!lit) sim.blackout = { state: 'dark', t: 1e9, count: 1 };
  put(sim, id, 0, 0);
  dummy(sim, 0, x);
  return sim;
}

test('packet-siege zones: in a blackout lane shooters, Tracer, Batch Job, Loopback, Token Ring and Decryptor see only 4 cells; the Packet Inspector\'s beam still reaches the whole lane', () => {
  const acts = { firewall: 'shot', scanner: 'shot', tracer: 'trace', batch: 'lob', loopback: 'knock', tokenring: 'arc', decryptor: 'shot', inspector: 'beam' };
  for (const [id, ev] of Object.entries(acts)) {
    const far = ofType(run(dark(id, 6), 600), ev).length;
    const close = ofType(run(dark(id, 4.4), 600), ev).length;
    const lit = ofType(run(dark(id, 6, true), 600), ev).length;
    assert.ok(lit > 0 && close > 0, id);
    if (id === 'inspector') assert.equal(far, lit, 'the beam ignores the dark');
    else assert.equal(far, 0, id + ' cannot see 5.5 cells away in the dark');
  }
  // the edge: 4 cells from the centre of the shooter
  assert.ok(ofType(run(dark('firewall', 4.5), 60), 'shot').length > 0);
  assert.equal(ofType(run(dark('firewall', 4.51), 60), 'shot').length, 0);
  // a Scanner's neighbour lanes are dimmed too
  const sc = newSim({ rules: rules({ blackout: { every: 50, length: 10, warn: 3, sight: 4 } }) });
  sc.blackout = { state: 'dark', t: 1e9, count: 1 };
  put(sc, 'scanner', 1, 0);
  dummy(sc, 2, 6);
  assert.equal(ofType(run(sc, 300), 'shot').length, 0);
  // the light comes back: the shooter fires again
  const sim = dark('tracer', 7);
  sim.blackout.t = 61;
  const events = run(sim, 300);
  assert.equal(ofType(events, 'blackout')[0].on, false);
  assert.ok(ofType(events, 'trace').length > 0);
  // a shot already in the air hits what it meets
  const fly = dark('firewall', 6, true);
  run(fly, 1);
  fly.blackout = { state: 'dark', t: 1e9, count: 1 };
  assert.equal(ofType(run(fly, 120), 'hit').length, 1);
});

test('packet-siege zones: crossovers — an enemy stepping on one moves to the lane its arrow shows, once per cell; never out of play, never the heavy ones, a leaper or a frozen one', () => {
  const sim = newSim({ rules: rules({ cross: [{ lane: 1, col: 5, to: 2 }, { lane: 2, col: 3, to: 3 }] }) });
  const bot = enemy(sim, 'bot', 1, 6);
  let events = [];
  while (bot.lane === 1) events = events.concat(run(sim, 1));
  const c = ofType(events, 'cross')[0];
  assert.deepEqual(c, { type: 'cross', id: bot.id, from: 1, lane: 2, col: 5, x: c.x });
  assert.ok(c.x <= 5.5 && c.x > 5.49);
  assert.deepEqual([bot.from, bot.shift], [1, 30]);
  assert.deepEqual(bot.crossed, [14]);
  // on to the next one in its new lane
  events = run(sim, 15 * RATE);
  assert.deepEqual(ofType(events, 'cross').map((e) => [e.from, e.lane, e.col]), [[2, 3, 3]]);
  assert.equal(bot.lane, 3);
  // once per cell: thrown back over it, it does not cross again
  bot.lane = 1;
  bot.x = 5.6;
  events = run(sim, 2 * RATE);
  assert.equal(ofType(events, 'cross').length, 0);
  assert.equal(bot.lane, 1);
  // the heavy ones, a leaper, a frozen one and a lane out of play
  const s2 = newSim({ lanes: [0, 1], rules: rules({ cross: [{ lane: 1, col: 5, to: 2 }, { lane: 0, col: 5, to: 1 }] }) });
  const out = enemy(s2, 'bot', 1, 5.6);
  const b = boss(s2, 1, 0, 5.6);
  b.summonT = 1e9;
  const titan = enemy(s2, 'titan', 0, 5.7);
  const frozen = enemy(s2, 'bot', 0, 5.45);
  frozen.frozen = 1e9;
  const leaper = enemy(s2, 'exploit', 0, 5.8);
  leaper.state = 'leaping';
  leaper.leapTo = 3;
  events = run(s2, 2 * RATE);
  assert.equal(ofType(events, 'cross').length, 0, 'nothing crossed');
  assert.deepEqual([out.lane, b.lane, titan.lane, frozen.lane, leaper.lane], [1, 0, 0, 0, 0]);
});

test('packet-siege zones: a defender may stand on a crossover; an enemy stopped by it crosses only once it is gone; a pulled enemy and a Polymorph cross too', () => {
  const sim = newSim({ rules: rules({ cross: [{ lane: 1, col: 5, to: 0 }] }) });
  const wall = put(sim, 'proxy', 1, 5);
  const bot = enemy(sim, 'bot', 1, 7);
  run(sim, 12 * RATE);
  assert.equal(bot.state, 'biting');
  assert.equal(bot.lane, 1);
  pks.pksRemove(sim, 1, 5);
  assert.ok(wall);
  const events = run(sim, 5 * RATE);
  assert.equal(ofType(events, 'cross')[0].lane, 0);
  // pulled by a Sinkhole into a lane with a crossover ahead of it
  const s2 = newSim({ rules: rules({ cross: [{ lane: 2, col: 4, to: 3 }] }) });
  const sink = put(s2, 'sinkhole', 2, 1);
  const pulled = enemy(s2, 'bot', 1, 5.2);
  const ev2 = run(s2, 1);
  assert.equal(ofType(ev2, 'pull')[0].target, pulled.id);
  sink.t = 1e9;
  const ev3 = run(s2, 10 * RATE);
  assert.deepEqual(ofType(ev3, 'cross').map((e) => [e.id, e.from, e.lane]), [[pulled.id, 2, 3]]);
  // a Polymorph crosses, then morphs at half HP as usual
  const s3 = newSim({ rules: rules({ cross: [{ lane: 2, col: 6, to: 1 }] }) });
  const pm = enemy(s3, 'polymorph', 2, 6.55);
  const ev4 = run(s3, 30);
  assert.equal(ofType(ev4, 'cross')[0].id, pm.id);
  pm.hp = 290;
  put(s3, 'firewall', 1, 0);
  const ev5 = run(s3, 3 * RATE);
  assert.equal(ofType(ev5, 'morph')[0].from, 1);
});

test('packet-siege zones: an enemy crossing into a lane inside a defender\'s cell is stopped by that defender and bites it', () => {
  // the review's repro: a crossover (1, 5) to lane 2 and a Proxy at (2, 5)
  const sim = newSim({ rules: rules({ cross: [{ lane: 1, col: 5, to: 2 }] }) });
  const wall = put(sim, 'proxy', 2, 5);
  const bot = enemy(sim, 'bot', 1, 6);
  let events = [];
  while (bot.lane === 1) events = events.concat(run(sim, 1));
  const c = ofType(events, 'cross')[0];
  assert.ok(c.x > 5 && c.x <= 5.5, 'it arrives inside the Proxy\'s cell: ' + c.x);
  run(sim, 10 * RATE);
  assert.deepEqual([bot.lane, bot.x, bot.state], [2, c.x, 'biting']);
  assert.ok(wall.hp < 2400 - 900, String(wall.hp));
  // crossing right of the centre it touches the defender as usual
  const s2 = newSim({ rules: rules({ cross: [{ lane: 1, col: 5, to: 2 }] }) });
  put(s2, 'proxy', 1, 4);
  const w2 = put(s2, 'proxy', 2, 4);
  const b2 = enemy(s2, 'bot', 1, 6);
  run(s2, 20 * RATE);
  assert.deepEqual([b2.lane, b2.state], [2, 'biting']);
  assert.ok(w2.hp < 2400);
});

test('packet-siege zones: upkeep — every 12 s each installed defender costs a cycle, never below 0, and at 0 nothing is switched off; instants on their fuse are free; the trickle of the rules is paid', () => {
  const lv = level({ trickle: true, startCycles: 1000, rules: rules({ upkeep: { cost: 1, every: 12 }, trickle: 50 }) });
  const sim = pks.pksNewSim(lv, ALL);
  put(sim, 'psu', 0, 0);
  put(sim, 'firewall', 1, 0);
  put(sim, 'proxy', 2, 5);
  sim.cycles = 1000;
  let events = run(sim, 10 * RATE);
  assert.deepEqual(ofType(events, 'trickle'), [{ type: 'trickle', amount: 50 }]);
  assert.equal(ofType(events, 'upkeep').length, 0);
  events = run(sim, 2 * RATE);
  assert.deepEqual(ofType(events, 'upkeep'), [{ type: 'upkeep', amount: 3, due: 3 }]);
  assert.deepEqual(sim.upkeep, { t: 12 * RATE, last: 3, due: 3 });
  // an instant on its fuse does not count
  sim.upkeep.t = 2;
  put(sim, 'nullroute', 4, 8);
  assert.deepEqual(ofType(run(sim, 2), 'upkeep'), [{ type: 'upkeep', amount: 3, due: 3 }]);
  // at 0 cycles: nothing taken, nothing switched off
  sim.cycles = 2;
  sim.upkeep.t = 1;
  assert.deepEqual(ofType(run(sim, 1), 'upkeep'), [{ type: 'upkeep', amount: 2, due: 3 }]);
  assert.equal(sim.cycles, 0);
  sim.upkeep.t = 1;
  assert.deepEqual(ofType(run(sim, 1), 'upkeep'), [{ type: 'upkeep', amount: 0, due: 3 }]);
  assert.equal(sim.cycles, 0);
  dummy(sim, 1, 6);
  assert.ok(ofType(run(sim, 120), 'shot').length > 0, 'the Firewall still fires');
  // nothing installed: no event
  const empty = pks.pksNewSim(lv, []);
  assert.equal(ofType(run(empty, 13 * RATE), 'upkeep').length, 0);
  assert.equal(empty.upkeep.due, 0);
});

test('packet-siege zones: rolling outage — every 40 s the next lane of the order is offline for 10 s after a 5 s warning; the clock is in the state', () => {
  const [E, L, W] = [C.OUTAGE_EVERY, C.OUTAGE_LENGTH, C.OUTAGE_WARN];
  assert.deepEqual([E, L, W], [40, 10, 5], 'the numbers of the title');
  const sim = newSim({ rules: rules({ outage: { every: E, length: L, warn: W, order: [3, 1, 4, 0, 2] } }) });
  const marks = [];
  for (let i = 0; i < 6 * E * RATE; i++) {
    pks.pksStep(sim);
    for (const e of sim.events) if (e.type === 'outageWarn' || e.type === 'outage') marks.push([sim.tick / RATE].concat(Object.values(e).slice(1)));
    if (sim.tick === (E + 1) * RATE) assert.deepEqual(sim.outage, { state: 'down', lane: 3, next: 3, t: (L - 1) * RATE, count: 1 });
    if (sim.tick === (E + L + 1) * RATE) assert.deepEqual(sim.outage, { state: 'clear', lane: -1, next: 1, t: (E - W - L - 1) * RATE, count: 1 });
  }
  assert.deepEqual(marks.slice(0, 6), [[E - W, 3, E, L], [E, 3, true], [E + L, 3, false], [2 * E - W, 1, 2 * E, L], [2 * E, 1, true], [2 * E + L, 1, false]]);
  assert.deepEqual(marks.filter((m) => m[2] === true).map((m) => m[1]), [3, 1, 4, 0, 2, 3], 'the order, cycled');
});

// A sim with lane 2 down for good.
function down(over) {
  const sim = newSim(Object.assign({ rules: rules({ outage: { every: 45, length: 8, warn: 5, order: [2] } }) }, over));
  sim.outage = { state: 'down', lane: 2, next: 2, t: 1e9, count: 1 };
  return sim;
}

test('packet-siege zones: in an outage a lane\'s defenders do nothing and their timers wait, but they are still bitten; a card may still go there', () => {
  const sim = down();
  const fw = put(sim, 'firewall', 2, 0);
  const psu = put(sim, 'psu', 2, 1);
  const lit = put(sim, 'firewall', 1, 0);
  dummy(sim, 2, 7);
  dummy(sim, 1, 7);
  const t0 = psu.t;
  const events = run(sim, 600);
  assert.equal(ofType(events, 'shot').filter((s) => s.owner === fw.id).length, 0);
  assert.ok(ofType(events, 'shot').filter((s) => s.owner === lit.id).length > 3, 'other lanes work');
  assert.equal(ofType(events, 'produce').length, 0);
  assert.equal(psu.t, t0, 'its timer waits');
  // bitten all the same
  const wall = put(sim, 'proxy', 2, 4);
  enemy(sim, 'bot', 2, 5.2);
  run(sim, 60);
  assert.ok(wall.hp < 2400);
  // an instant's fuse waits, then goes off when the lane is back
  const nr = put(sim, 'nullroute', 2, 6);
  run(sim, 120);
  assert.ok(standing(sim, nr.id), 'still on its fuse');
  sim.outage.t = 1;
  const back = run(sim, 120);
  assert.deepEqual(ofType(back, 'outage'), [{ type: 'outage', lane: 2, on: false }]);
  assert.equal(ofType(back, 'blast')[0].id, nr.id);
  assert.ok(ofType(back, 'shot').some((s) => s.owner === fw.id), 'the Firewall fires again');
});

test('packet-siege zones: an outage silences an armed Honeynet (it is only bitten), a Backup (it restores nothing) and a Signature DB (it boosts nobody)', () => {
  const sim = down();
  const net = put(sim, 'honeynet', 2, 4);
  net.t = 0;
  run(sim, 1);
  net.state = 'armed';
  const bot = enemy(sim, 'bot', 2, 5.1);
  const events = run(sim, 60);
  assert.equal(ofType(events, 'blast').length, 0);
  assert.equal(bot.state, 'biting');
  assert.ok(net.hp < 300);
  assert.ok(alive(sim, bot.id));
  // a Backup in the lane under the outage
  const s2 = down();
  put(s2, 'backup', 2, 3);
  const psu = put(s2, 'psu', 1, 3);
  psu.hp = 1;
  enemy(s2, 'bot', 1, 4.15);
  const ev2 = run(s2, 60);
  assert.equal(ofType(ev2, 'destroyed').length, 1);
  assert.equal(ofType(ev2, 'restore').length, 0);
  // a Signature DB in the lane under the outage, a Firewall next to it
  const s3 = down();
  put(s3, 'sigdb', 2, 1);
  const fw = put(s3, 'firewall', 1, 1);
  dummy(s3, 1, 7);
  const hits = ofType(run(s3, 200), 'hit');
  assert.ok(hits.length > 0 && hits.every((h) => h.dmg === 20));
  assert.equal(fw.boosted, false);
  // a Backup elsewhere still restores a defender of the dark lane
  const s4 = down();
  put(s4, 'backup', 1, 3);
  const ids = put(s4, 'ids', 2, 3);
  ids.hp = 1;
  enemy(s4, 'bot', 2, 4.15);
  assert.equal(ofType(run(s4, 60), 'restore').length, 1);
});

test('packet-siege zones: the root — enemies 10 % faster, two earlier rules a level; the quantum lab fogs 5 columns over express lanes', () => {
  assert.equal(C.ROOT_SPEED, 1.1);
  for (let n = 141; n <= 150; n++) {
    const lv = pks.pksLevel(n);
    assert.equal(lv.speed, C.ROOT_SPEED);
    assert.equal(lv.rules.names.length, 2, n);
  }
  for (let n = 131; n <= 140; n++) {
    const lv = pks.pksLevel(n);
    assert.equal(lv.fog, 5);
    assert.ok(lv.rules.express.length >= 1);
  }
  // a root level plays its two rules: L142 rails and blackouts, no trickle
  const sim = pks.pksNewSim(142, []);
  assert.ok(sim.blackout && !sim.outage && !sim.upkeep);
  assert.equal(sim.cycles, C.BROWNOUT_CYCLES);
  const events = run(sim, 51 * RATE);
  assert.equal(ofType(events, 'trickle').length, 0);
  assert.equal(ofType(events, 'blackout').length, 1);
  // its enemies walk at 1.1 x their speed
  const bot = sim.enemies.find((e) => e.type === 'bot');
  if (bot) assert.ok(near(bot.speed, 0.2 * C.ROOT_SPEED));
});

// ── boss tiers 6-15 ────────────────────────────────────────────────────────

const NEW_ABILITIES = ['shieldEvery', 'mend', 'jam', 'split'];
const abilities = (t) => ['summonEvery', 'laneEvery', 'volleyEvery', 'cloakEvery'].concat(NEW_ABILITIES, ['twin']).filter((k) => t[k] > 0 || t[k] === true);

test('packet-siege zones: boss tiers 6-15 on levels 60-150: each stronger than the last, each with a body, a hue and a new or combined ability', () => {
  assert.equal(TIERS.length, 15);
  for (let i = 5; i < 15; i++) {
    const t = TIERS[i];
    assert.equal(t.tier, i + 1);
    assert.equal(t.level, 10 * (i + 1));
    assert.equal(pks.pksLevel(t.level).boss, t.tier);
    assert.ok(t.hp > TIERS[i - 1].hp && t.bite >= TIERS[i - 1].bite, 'tier ' + t.tier + ' is stronger');
    assert.ok([1, 2, 3].includes(t.body), 'body');
    assert.ok(typeof t.hue === 'number' && t.hue >= 0 && t.hue < 360, 'hue');
    assert.ok(NEW_ABILITIES.some((k) => t[k] > 0), 'tier ' + t.tier + ' has an ability of the expansion');
    assert.notDeepEqual(abilities(t), abilities(TIERS[i - 1]), 'tier ' + t.tier + ' adds or combines');
    assert.ok(abilities(t).length >= abilities(TIERS[i - 1]).length - 1);
    for (const type of t.summon) assert.ok(ENEMY[type].first <= t.level, t.tier + ' summons ' + type);
    assert.match(t.name, new RegExp('^APT-' + t.tier + ' '));
    assert.ok(t.desc.length > 20 && t.desc.length < 90);
    for (const x of (t.desc.match(/\d+(\.\d+)?/g) || []).map(Number)) assert.ok(Object.values(t).includes(x), t.tier + ': ' + x);
    assert.equal(t.shield > 0, t.shieldEvery > 0);
    assert.equal(t.mend > 0, t.mendReach > 0);
    if (t.split) assert.ok(t.split < t.hp / 2);
  }
  assert.deepEqual(TIERS.map((t) => !!t.twin), Array.from({ length: 15 }, (_, i) => i === 14), 'two bosses on level 150 only');
  // the last tier has everything but the jam: a jam radius under the 0.7 a
  // boss stops short of what it bites would reach nothing (so its text says
  // "every ability but jamming")
  assert.deepEqual(abilities(TIERS[14]), ['summonEvery', 'laneEvery', 'volleyEvery', 'cloakEvery', 'shieldEvery', 'mend', 'split', 'twin'], 'the last tier: everything but the jam');
  assert.match(TIERS[14].desc, /every ability but jamming/);
  // every new ability shows up alone first, then combined
  const firstAlone = NEW_ABILITIES.map((k) => TIERS.findIndex((t) => t[k] > 0));
  assert.deepEqual(firstAlone, [5, 6, 7, 8]);
});

test('packet-siege zones: a shielded boss (tier 6): lane shots break its shield first, it comes back every 25 s, a Decryptor strips it; the old caps still hold', () => {
  const t = TIERS[5];
  assert.equal(t.shieldEvery, 25, 'the number of the title');
  const sim = newSim();
  const b = boss(sim, 6, 2, 7);
  b.speed = 0;
  b.summonT = b.moveT = b.volleyT = 1e9;
  assert.deepEqual([b.shield, b.maxShield, b.hp], [t.shield, t.shield, t.hp]);
  put(sim, 'firewall', 2, 0);
  run(sim, 2 * RATE);
  assert.ok(b.shield < t.shield && b.hp === t.hp, 'the shield takes the shots');
  b.shield = 0;
  const events = run(sim, t.shieldEvery * RATE);
  assert.deepEqual(ofType(events, 'shieldUp').map((e) => [e.id, e.shield]), [[b.id, t.shield]]);
  assert.ok(b.shield > 0);
  // full at its phase: no event
  b.shield = b.maxShield;
  const sim2 = newSim();
  const b2 = boss(sim2, 6, 2, 7);
  b2.speed = 0;
  b2.summonT = b2.moveT = b2.volleyT = 1e9;
  assert.equal(ofType(run(sim2, (t.shieldEvery + 1) * RATE), 'shieldUp').length, 0);
  // a Decryptor strips it whole
  put(sim2, 'decryptor', 2, 0);
  const ev = run(sim2, 2 * RATE);
  assert.equal(ofType(ev, 'shieldBreak')[0].by, 'decrypt');
  assert.equal(b2.shield, 0);
  // an instant: at most the boss cap, past the shield
  pks.pksRemove(sim2, 2, 0);
  sim2.shots.length = 0;
  const hp = b2.hp;
  put(sim2, 'failover', 2, 3);
  run(sim2, RATE);
  assert.equal(hp - b2.hp, C.BOSS_CAP);
});

test('packet-siege zones: a mending boss (tier 7) heals other damaged enemies within 1.5 cells by 30 HP/s, not itself, not above full, not with a Hydra on top', () => {
  const t = TIERS[6];
  assert.deepEqual([t.mend, t.mendReach], [30, 1.5]);
  const sim = newSim();
  const b = boss(sim, 7, 2, 7);
  b.speed = 0;
  b.summonT = b.moveT = b.volleyT = 1e9;
  b.hp = 1000;
  const inReach = still(sim, 'worm', 1, 7 + Math.sqrt(t.mendReach * t.mendReach - 1) - 0.01);
  const edge = still(sim, 'worm', 2, 7 + t.mendReach);
  const outside = still(sim, 'worm', 2, 7 - t.mendReach - 0.1);
  const full = still(sim, 'worm', 3, 7);
  for (const e of [inReach, edge, outside]) e.hp = 100;
  run(sim, 60);
  assert.ok(near(inReach.hp, 100 + t.mend, 1e-6));
  assert.ok(near(edge.hp, 100 + t.mend, 1e-6), 'exactly at the reach');
  assert.equal(outside.hp, 100);
  assert.equal(full.hp, 560);
  assert.equal(b.hp, 1000, 'never itself');
  // with a Hydra beside: one heal a step
  const hy = still(sim, 'hydra', 1, 7.5);
  hy.hp = 600;
  inReach.hp = 100;
  run(sim, 60);
  assert.ok(near(inReach.hp, 100 + t.mend, 1e-6), 'not both');
  // never another heavy one: twin bosses (level 150) or a boss and its split
  // copy would heal each other, and a Kernel Panic is the boss's size
  const twin = boss(sim, 7, 3, 7.5);
  twin.speed = 0;
  twin.summonT = twin.moveT = twin.volleyT = 1e9;
  twin.hp = 500;
  const panic = still(sim, 'titan', 1, 6.5);
  panic.hp = 500;
  run(sim, 60);
  assert.deepEqual([twin.hp, panic.hp, b.hp], [500, 500, 1000]);
  // off the floor it heals nobody
  const s2 = newSim();
  const b2 = boss(s2, 7, 2, 9.5);
  b2.speed = 0;
  const w = still(s2, 'worm', 2, 9);
  w.hp = 100;
  run(s2, 60);
  assert.equal(w.hp, 100);
});

test('packet-siege zones: a jamming boss (tier 8) keeps every shooter within 1.5 cells from firing while it is on the floor and not frozen', () => {
  assert.equal(TIERS[7].jam, 1.5);
  const sim = newSim();
  const b = boss(sim, 8, 2, 5);
  b.speed = 0;
  b.summonT = b.moveT = b.volleyT = 1e9;
  const close = put(sim, 'firewall', 2, 3);
  const diag = put(sim, 'tracer', 1, 5);
  const far = put(sim, 'firewall', 2, 0);
  const pulse = put(sim, 'limiter', 2, 4);
  const events = run(sim, 2 * RATE);
  assert.equal(b.aura, 1.5);
  assert.deepEqual(ofType(events, 'jam').filter((e) => e.on).map((e) => e.id).sort(), [close.id, diag.id].sort());
  assert.equal(far.jammed, false);
  assert.equal(pulse.jammed, false, 'a pulse is no shooter');
  assert.ok(ofType(events, 'shot').every((s) => s.owner !== close.id));
  b.frozen = 1e9;
  const ev2 = run(sim, 1);
  assert.equal(b.aura, 0);
  assert.equal(ofType(ev2, 'jam').filter((e) => !e.on).length, 2);
});

test('packet-siege zones: a splitting boss (tier 9) comes apart into two bosses of 2500 HP that do not split again; a breaker kill does not split it', () => {
  const t = TIERS[8];
  assert.equal(t.split, 2500, 'the number of the title');
  const sim = newSim();
  const b = boss(sim, 9, 2, 6);
  b.speed = 0;
  b.summonT = b.moveT = b.volleyT = 1e9;
  b.hp = 10;
  b.frozen = 1000;
  put(sim, 'firewall', 2, 0);
  const events = run(sim, 2 * RATE);
  const sp = ofType(events, 'bossSplit')[0];
  assert.ok(sp, 'split');
  assert.equal(sp.id, b.id);
  assert.deepEqual(ofType(events, 'kill').filter((k) => k.id === b.id).length, 1);
  const kids = sp.children.map((id) => alive(sim, id));
  for (const k of kids) {
    assert.deepEqual([k.type, k.tier, k.maxHp, k.used, k.shield], ['boss', 9, t.split, true, 0]);
    assert.ok(k.frozen > 0, 'keeps the freeze');
  }
  assert.equal(kids[0].lane, 2);
  assert.ok(Math.abs(kids[1].lane - 2) === 1);
  assert.ok(near(kids[1].x, 6.4));
  // a copy does not split
  kids[0].hp = 1;
  kids[0].frozen = 0;
  const ev2 = run(sim, 2 * RATE);
  assert.equal(ofType(ev2, 'bossSplit').length, 0);
  // a breaker kill
  const s2 = newSim();
  const b2 = boss(s2, 9, 2, 0.001);
  b2.hp = 100;
  const ev3 = run(s2, 1);
  assert.equal(ofType(ev3, 'breaker').length, 1);
  assert.equal(ofType(ev3, 'bossSplit').length, 0);
  assert.equal(s2.enemies.length, 0);
  // an old tier never splits
  const s3 = newSim();
  const old = boss(s3, 5, 2, 6);
  old.hp = 1;
  old.frozen = 100;
  put(s3, 'firewall', 2, 0);
  assert.equal(ofType(run(s3, 2 * RATE), 'bossSplit').length, 0);
});

test('packet-siege zones: every boss tier 6-15 plays its abilities on the floor for a minute without breaking the sim', () => {
  for (let tier = 6; tier <= 15; tier++) {
    const t = TIERS[tier - 1];
    const sim = newSim();
    const b = boss(sim, tier, 2, 8);
    put(sim, 'firewall', 0, 0);
    put(sim, 'firewall', 2, 0);
    put(sim, 'proxy', 2, 3);
    put(sim, 'firewall', 1, 5);
    // a shooter right where the boss stands, inside any jam radius
    put(sim, 'firewall', 2, 7);
    const seen = new Set();
    for (let i = 0; i < 60 * RATE; i++) {
      pks.pksStep(sim);
      for (const e of sim.events) seen.add(e.type);
      b.x = Math.max(b.x, 6);
      if (b.hp < 1000) b.hp = t.hp;
      for (const l of [0, 1, 2, 3, 4]) sim.breakers[l] = 'armed';
    }
    assert.ok(seen.has('summon'), tier + ' summons');
    if (t.jam) assert.ok(seen.has('jam'), tier + ' jams');
    if (t.cloakEvery) assert.ok(seen.has('cloak'), tier + ' cloaks');
    assert.deepEqual(JSON.parse(JSON.stringify(sim)), sim);
  }
  // level 150 sends two of them, sharing the tier's HP
  const lv = pks.pksLevel(150);
  assert.deepEqual(lv.spawns.filter((s) => s.type === 'boss').map((s) => s.lane), [1, 3]);
  const pair = newSim();
  const one = boss(pair, 15, 1, 9);
  assert.deepEqual([one.hp, one.maxHp], [TIERS[14].hp / 2, TIERS[14].hp / 2]);
  assert.equal(boss(pair, 14, 2, 9).maxHp, TIERS[13].hp, 'a single boss has all of it');
});

// ── determinism, the idle player, the reference bot ───────────────────────

// Plays a real level with scripted placements, the breakers re-armed.
function play(sim, steps, from) {
  const cards = ['psu', 'firewall', 'proxy', 'ids', 'tracer', 'batch', 'loopback', 'tokenring', 'backup', 'honeynet', 'sigdb', 'sinkhole'];
  for (let i = 0; i < steps && sim.status === 'playing'; i++) {
    const k = (from || 0) + i;
    if (k % 89 === 0) {
      const j = k / 89;
      const card = sim.cards.find((c) => c.id === cards[j % cards.length]);
      if (card) {
        card.left = 0;
        sim.cycles = Math.max(sim.cycles, 400);
        pks.pksPlace(sim, card.id, j % 5, (j * 7) % 9);
      }
    }
    for (const l of [0, 1, 2, 3, 4]) if (sim.breakers[l] === 'tripped') sim.breakers[l] = 'armed';
    pks.pksStep(sim);
  }
  return sim;
}

test('packet-siege zones: the same inputs on a real level 51+ give the identical state; a JSON copy taken mid-level plays on identically', () => {
  for (const n of [143, 144, 146, 150]) {
    const a = play(pks.pksNewSim(n, ALL), 9000);
    const b = play(pks.pksNewSim(n, ALL), 9000);
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'level ' + n);
    const copy = JSON.parse(JSON.stringify(a));
    play(a, 6000, 9000);
    play(copy, 6000, 9000);
    assert.equal(JSON.stringify(copy), JSON.stringify(a), 'level ' + n + ': the state is all in the data');
  }
});

test('packet-siege zones: a player who places nothing loses every level 51-150', () => {
  for (const n of LATE) assert.equal(PLAYERS.playIdle(n).won, false, 'level ' + n);
});

test('packet-siege zones: overtime — a late level held past its end without a kill is lost PKS_OVERTIME s after its nominal end; levels 1-50 have no overtime', () => {
  assert.equal(C.OVERTIME, 300);
  // a Drone (bites 40) at a wall a Patch Server heals by 40: nobody can win
  const stall = (over) => {
    const sim = newSim(Object.assign({ duration: 100, spawns: [{ t: 1, lane: 2, type: 'drone' }] }, over));
    put(sim, 'proxy', 2, 4);
    put(sim, 'patch', 1, 4);
    return sim;
  };
  const sim = stall();
  let events = run(sim, (100 + C.OVERTIME) * RATE - 1);
  assert.equal(sim.status, 'playing');
  const drone = sim.enemies[0];
  assert.equal(drone.state, 'biting', 'held at the wall for good');
  events = run(sim, 1);
  assert.equal(sim.status, 'lost');
  assert.deepEqual(events.map((e) => e.type), ['overtime', 'lose']);
  assert.deepEqual(events[1], { type: 'lose', lane: 2, id: drone.id, enemy: 'drone' });
  assert.equal(events[0].at, 100 + C.OVERTIME);
  // the enemy nearest the rack is the one that breaks through
  const two = stall({ spawns: [{ t: 1, lane: 0, type: 'drone' }, { t: 1, lane: 2, type: 'drone' }, { t: 1, lane: 4, type: 'drone' }] });
  for (const l of [0, 4]) {
    put(two, 'proxy', l, 6);
    put(two, 'patch', l, 5);
  }
  run(two, (100 + C.OVERTIME) * RATE);
  assert.equal(two.status, 'lost');
  assert.deepEqual(two.enemies.map((e) => e.lane), [0, 2, 4]);
  assert.equal(two.events[1].lane, 2);
  // a level without rules (1-50, or a hand-made one) never times out
  const old = stall();
  delete old.level.rules;
  run(old, (100 + C.OVERTIME + 60) * RATE);
  assert.equal(old.status, 'playing');
  // nor one whose spawns are not all out, nor one with only a shimmer left
  const early = stall({ spawns: [{ t: 1, lane: 2, type: 'drone' }, { t: 500, lane: 2, type: 'drone' }] });
  run(early, 450 * RATE);
  assert.equal(early.status, 'playing');
  const lone = pks.pksNewSim(level({ duration: 1, rules: rules({ tunnels: [{ lane: 2, col: 6, every: 3 }] }), spawns: [{ t: 0.5, lane: 2, type: 'bot', tunnel: true }] }), []);
  lone.tick = (1 + C.OVERTIME) * RATE;
  run(lone, 31);
  assert.deepEqual([lone.status, lone.shimmers.length, lone.enemies.length], ['playing', 1, 0]);
});
