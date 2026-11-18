// tests/cold-aisle.sim-enemies.test.js
// Cold Aisle's combat and enemies: the three tools (melee reach, rays, the
// degausser's fan and falloff, ammo and the fall back to the driver), noise,
// armour, enemy projectiles, and every ordinary enemy in a small arena of
// its own: it wakes, finds the player (through a door), shows its tell,
// attacks, flinches, dies; a drone's sparks and a turret's bolts can be
// sidestepped, a turret's lock-on is broken by cover, a loader's charge can
// be sidestepped and stuns it.  Numbers come from the tables.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./_setup');

const cda = loadScript('cold-aisle/script.js');
const E = cda.CDA_ENEMY;
const T = cda.CDA_TOOL;
const P = cda.CDA_PLAYER;
const S = (seconds) => cda.cdaSteps(seconds);

function level(map, over) {
  return Object.assign({ name: 'Test', briefing: 'A test.', facing: 'E', map }, over);
}

const ARMED = () => ({ tools: ['driver', 'probe', 'degausser'], ammo: { cell: 120, coil: 30 }, health: 100, armour: 0 });

function newSim(map, opts) {
  const o = opts || {};
  return cda.cdaNewSim(cda.cdaParseLevel(level(map, o.level)), o.carry || ARMED(), o.upgrades || {}, 1);
}

function input(over) {
  return Object.assign(cda.cdaInputNew(), over);
}

// Runs n steps (inp: an input or (sim, i) -> input); returns the events,
// each with the tick it happened on.
function run(sim, n, inp) {
  const out = [];
  for (let i = 0; i < n; i++) {
    cda.cdaStep(sim, typeof inp === 'function' ? inp(sim, i) : inp || cda.cdaInputNew());
    for (const e of sim.events) out.push(Object.assign({ tick: sim.tick }, e));
  }
  return out;
}

// Runs until an event matching pred happens (at most max steps); returns the events.
function until(sim, pred, max, inp) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const ev = run(sim, 1, typeof inp === 'function' ? inp(sim, i) : inp);
    out.push(...ev);
    if (ev.some(pred)) return out;
  }
  assert.fail('no matching event within ' + max + ' steps');
  return out;
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const is = (type, more) => (e) => e.type === type && Object.keys(more || {}).every((k) => e[k] === more[k]);

// Faces the nearest living enemy the player can see and fires at it.
function aimFire(sim, extra) {
  const p = sim.player;
  let best = null;
  for (const e of sim.enemies) {
    if (e.hp > 0 && cda.cdaSees(sim, p.x, p.y, e.x, e.y) && (!best || cda.cdaDist(p.x, p.y, e.x, e.y) < cda.cdaDist(p.x, p.y, best.x, best.y))) best = e;
  }
  if (!best) return input(extra);
  return input(Object.assign({ turn: cda.cdaAngleDiff(cda.cdaAngleTo(p.x, p.y, best.x, best.y), p.angle), fire: true }, extra));
}

// ── tools ──────────────────────────────────────────────────────────────────

test('cold-aisle combat: the driver hits within its reach of the target\'s surface and only there, and puffs on a wall in reach', () => {
  const sim = newSim(['########', '#@.t...#', '########'], { carry: { tools: ['driver'], ammo: { cell: 0, coil: 0 }, health: 100, armour: 0 } });
  const e = sim.enemies[0];
  let ev = run(sim, 1, input({ fire: true }));
  assert.equal(ofType(ev, 'shot').length, 1);
  assert.equal(ofType(ev, 'hit').length, 0, 'the turret is 2 cells away, out of reach');
  assert.equal(ofType(ev, 'wall').length, 0);
  // just beyond reach of its surface: still nothing
  sim.player.x = e.x - E.turret.radius - T.driver.reach - 0.05;
  run(sim, S(T.driver.cooldown));
  assert.equal(ofType(run(sim, 1, input({ fire: true })), 'hit').length, 0);
  // just within: a hit, although its centre is further than the reach
  sim.player.x = e.x - E.turret.radius - T.driver.reach + 0.05;
  assert.ok(e.x - sim.player.x > T.driver.reach);
  run(sim, S(T.driver.cooldown));
  ev = run(sim, 1, input({ fire: true }));
  assert.deepEqual(ofType(ev, 'hit').map((h) => [h.id, h.damage, h.blocked]), [[e.id, T.driver.damage, false]]);
  assert.equal(e.hp, E.turret.hp - T.driver.damage);
  // the cooldown
  assert.equal(ofType(run(sim, S(T.driver.cooldown) - 1, input({ fire: true })), 'shot').length, 0);
  assert.equal(ofType(run(sim, 1, input({ fire: true })), 'shot').length, 1);
  // a loader, the widest ordinary body, is hit from outside it
  const big = newSim(['########', '#@..l..#', '########'], { carry: { tools: ['driver'], ammo: { cell: 0, coil: 0 }, health: 100, armour: 0 } });
  const l = big.enemies[0];
  big.player.x = l.x - E.loader.radius - big.player.radius - 0.1;
  assert.equal(ofType(run(big, 1, input({ fire: true })), 'hit').length, 1);
  // a wall within reach puffs
  const wall = newSim(['####', '#@.#', '####'], { carry: { tools: ['driver'], ammo: { cell: 0, coil: 0 }, health: 100, armour: 0 } });
  wall.player.x = 2.2;
  ev = run(wall, 1, input({ fire: true }));
  assert.deepEqual(ofType(ev, 'wall').map((w) => [w.x, w.y, w.cell]), [[3, 1.5, 7]]);
  // one past the reach (the ray looks CDA_BODY_MAX further for bodies) does not
  assert.equal(cda.CDA_BODY_MAX, Math.max(...cda.CDA_ENEMIES.map((r) => r.radius)));
  wall.player.x = 3 - T.driver.reach - cda.CDA_BODY_MAX / 2;
  run(wall, S(T.driver.cooldown));
  ev = run(wall, 1, input({ fire: true }));
  assert.equal(ofType(ev, 'shot').length, 1);
  assert.equal(ofType(ev, 'wall').length, 0);
});

test('cold-aisle combat: the probe hits the first enemy in line, uses a cell a shot, and with none left the driver comes into hand', () => {
  const sim = newSim(['##########', '#@..s.s..#', '##########'], { carry: { tools: ['driver', 'probe'], ammo: { cell: 2, coil: 0 }, health: 100, armour: 0 } });
  const [a, b] = sim.enemies;
  let ev = run(sim, 1, input({ fire: true }));
  assert.deepEqual(ofType(ev, 'hit').map((h) => [h.id, h.damage]), [[a.id, T.probe.damage]]);
  assert.equal(b.hp, E.crawler.hp);
  assert.equal(sim.player.ammo.cell, 1);
  assert.equal(sim.stats.shots, 1);
  run(sim, S(T.probe.cooldown), input({ fire: true }));
  assert.equal(sim.player.ammo.cell, 0);
  ev = run(sim, S(T.probe.cooldown), input({ fire: true }));
  assert.deepEqual(ofType(ev, 'switch').map((s) => [s.tool, s.auto]), [['driver', true]]);
  assert.equal(ofType(ev, 'shot').length, 0);
  assert.equal(sim.player.tool, 'driver');
});

test('cold-aisle combat: the degausser fans its rays; past its falloff each ray does less and fewer reach a body', () => {
  const near = newSim(['############', '#@.l.......#', '############']);
  const e = near.enemies[0];
  near.player.tool = 'degausser';
  let ev = run(near, 1, input({ fire: true }));
  assert.equal(near.player.ammo.coil, 29);
  const hits = ofType(ev, 'hit');
  assert.equal(hits.length, T.degausser.rays, 'every ray hits a loader 2 cells away');
  for (const h of hits) assert.equal(h.damage, T.degausser.damage);
  assert.equal(e.hp, E.loader.hp - T.degausser.rays * T.degausser.damage);
  const far = newSim(['############', '#@........l#', '############']);
  far.player.tool = 'degausser';
  ev = run(far, 1, input({ fire: true }));
  const farHits = ofType(ev, 'hit');
  assert.ok(farHits.length > 0 && farHits.length < T.degausser.rays, farHits.length + ' rays reach 9 cells');
  for (const h of farHits) assert.equal(h.damage, T.degausser.damage * T.degausser.far);
  assert.equal(ofType(ev, 'wall').length, T.degausser.rays - farHits.length, 'the others puff on the far wall');
  // an extra ray from the upgrade
  const up = cda.cdaNewSim(cda.cdaParseLevel(level(['############', '#@.l.......#', '############'])), ARMED(), { rays: 1 }, 1);
  up.player.tool = 'degausser';
  assert.equal(ofType(run(up, 1, input({ fire: true })), 'hit').length, T.degausser.rays + 1);
});

test('cold-aisle combat: a corpse stops no shot; kills are counted', () => {
  const sim = newSim(['##########', '#@.s.s...#', '##########']);
  const [a, b] = sim.enemies;
  sim.player.tool = 'probe';
  a.hp = 1;
  run(sim, 1, input({ fire: true }));
  assert.equal(a.hp, 0);
  assert.equal(a.state, 'die');
  assert.equal(sim.stats.kills, 1);
  const ev = run(sim, S(T.probe.cooldown), input({ fire: true }));
  assert.deepEqual(ofType(ev, 'hit').map((h) => h.id), [b.id]);
  run(sim, S(cda.CDA_DIE_TIME));
  assert.equal(a.state, 'dead');
  const t = a.t;
  run(sim, 10);
  assert.equal(a.state, 'dead');
  assert.equal(a.t, t + 10);
});

test('cold-aisle combat: a shot wakes the asleep enemies within its noise in flow steps, not those farther away', () => {
  // two closed rooms south of the corridor; the near crawler is 4 flow steps away, the far one 13
  const sim = newSim([
    '##################',
    '#@...............#',
    '###+#########+####',
    '#..s#########...s#',
    '##################'
  ]);
  const [nearE, farE] = sim.enemies;
  assert.ok(T.probe.noise >= sim.flow[3 * 18 + 3] && T.probe.noise < sim.flow[3 * 18 + 16]);
  assert.equal(nearE.state, 'asleep');
  const ev = run(sim, 1, input({ fire: true, weapon: 2 }));
  assert.deepEqual(ofType(ev, 'shot').length, 0, 'the switch comes first');
  run(sim, S(P.switchTime));
  const ev2 = run(sim, 1, input({ fire: true }));
  assert.deepEqual(ofType(ev2, 'wake').map((w) => [w.id, w.why]), [[nearE.id, 'noise']]);
  assert.equal(farE.state, 'asleep');
});

test('cold-aisle combat: armour absorbs its share of each hit while it lasts', () => {
  const sim = newSim(['#####', '#@..#', '#####'], { carry: Object.assign(ARMED(), { armour: 7 }) });
  const p = sim.player;
  cda.cdaHurtPlayer(sim, 10, 3, 1.5, 'drone');
  const a1 = Math.floor(10 * P.armourShare);
  assert.equal(p.armour, 7 - a1);
  assert.equal(p.health, 100 - (10 - a1));
  cda.cdaHurtPlayer(sim, 10, 3, 1.5, 'drone');
  assert.equal(p.armour, 0, 'only what is left');
  assert.equal(p.health, 100 - (10 - a1) - (10 - (7 - a1)));
  assert.deepEqual(ofType(sim.events, 'hurt').map((h) => [h.damage, h.absorbed, h.by]), [[10 - a1, a1, 'drone'], [10 - (7 - a1), 7 - a1, 'drone']]);
});

// ── crawler ────────────────────────────────────────────────────────────────

const CRAWLER_ROOM = [
  '#########',
  '#@......#',
  '####+####',
  '#.......#',
  '#...s...#',
  '#########'
];

test('cold-aisle crawler: woken by a shot, it comes through the door, winds up, strikes, flinches when hit, and dies', () => {
  const sim = newSim(CRAWLER_ROOM);
  const e = sim.enemies[0];
  const row = E.crawler;
  sim.player.tool = 'probe';
  let ev = run(sim, 1, input({ fire: true }));
  assert.deepEqual(ofType(ev, 'wall').length, 1);
  assert.deepEqual(ofType(ev, 'wake').map((w) => w.why), ['noise']);
  assert.equal(e.state, 'alert');
  run(sim, S(row.alert));
  assert.equal(e.state, 'chase');
  ev = until(sim, is('hurt'), 1200);
  assert.deepEqual(ofType(ev, 'door').map((d) => d.by), ['enemy']);
  const windup = ofType(ev, 'windup')[0];
  const attack = ofType(ev, 'attack')[0];
  const hurt = ofType(ev, 'hurt')[0];
  assert.equal(attack.tick - windup.tick, S(row.windup), 'the tell is readable');
  assert.equal(hurt.tick, attack.tick);
  assert.deepEqual([hurt.damage, hurt.by], [row.damage, 'crawler']);
  assert.equal(e.state, 'attack');
  run(sim, S(row.strike));
  assert.equal(e.state, 'chase');
  // the next swing, interrupted by a hit
  ev = until(sim, is('windup'), 600);
  ev = run(sim, 1, (s) => aimFire(s));
  assert.equal(ofType(ev, 'hit').length, 1);
  assert.equal(e.state, 'hurt');
  ev = run(sim, S(row.windup) + 1);
  assert.equal(ofType(ev, 'attack').length, 0, 'the flinch cancelled the swing');
  ev = until(sim, is('die'), 600, (s) => aimFire(s));
  assert.equal(e.hp, 0);
  assert.equal(sim.stats.kills, 1);
  assert.ok(sim.player.health < 100 && sim.player.health > 0);
});

test('cold-aisle crawler: a swing the player backs away from misses', () => {
  const sim = newSim(['###########', '#@.s......#', '###########']);
  const e = sim.enemies[0];
  sim.player.x = 4.5;
  sim.player.angle = Math.PI;
  run(sim, 1);
  assert.equal(e.state, 'alert');
  until(sim, is('windup'), 600);
  const ev = run(sim, S(E.crawler.windup), input({ move: -1 }));
  assert.equal(ofType(ev, 'attack').length, 1);
  assert.equal(ofType(ev, 'hurt').length, 0);
});

// ── drone ──────────────────────────────────────────────────────────────────

const DRONE_ROOM = [
  '####################',
  '#..................#',
  '#..................#',
  '#@.............d...#',
  '#..................#',
  '#..................#',
  '####################'
];

test('cold-aisle drone: it wakes on sight, holds its distance, strafes, and its sparks hurt a player who stands still', () => {
  const sim = newSim(DRONE_ROOM);
  const e = sim.enemies[0];
  const row = E.drone;
  const p = sim.player;
  let ev = run(sim, 1);
  assert.deepEqual(ofType(ev, 'wake').map((w) => w.why), ['sight']);
  ev = until(sim, is('hurt'), 1200);
  const fire = ofType(ev, 'fire')[0];
  assert.equal(fire.kind, 'spark');
  assert.equal(ofType(ev, 'attack')[0].tick - ofType(ev, 'windup')[0].tick, S(row.windup));
  const hurt = ofType(ev, 'hurt')[0];
  assert.deepEqual([hurt.damage, hurt.by], [row.damage, 'spark']);
  assert.deepEqual(ofType(ev, 'shotEnd').map((s) => [s.id, s.hit]), [[fire.id, 'player']]);
  assert.ok(hurt.tick - fire.tick >= S((row.keepMin - 1) / row.shotSpeed), 'it flew for a while');
  const sides = new Set();
  const dists = [];
  run(sim, 600, (s) => {
    sides.add(e.side);
    dists.push(cda.cdaDist(e.x, e.y, p.x, p.y));
    return input();
  });
  assert.deepEqual([...sides].sort(), [-1, 1], 'it strafes both ways');
  for (const d of dists.slice(120)) assert.ok(d > row.keepMin - 1 && d < row.keepMax + 1, 'at ' + d.toFixed(2));
});

test('cold-aisle drone: every spark can be sidestepped', () => {
  const sim = newSim(DRONE_ROOM);
  const p = sim.player;
  let fired = 0;
  let dodge = 0;
  let dir = 1;
  const ev = run(sim, 1800, (s) => {
    if (dodge > 0) {
      dodge--;
      return input({ strafe: dir });
    }
    if (s.events.some((e) => e.type === 'fire')) {
      fired++;
      dodge = S(0.5);
      dir = p.y > 3.5 ? -1 : 1;
    }
    return input();
  });
  assert.ok(fired >= 5, fired + ' sparks');
  assert.equal(ofType(ev, 'hurt').length, 0);
  assert.ok(ofType(ev, 'shotEnd').every((s) => s.hit === 'wall'));
});

test('cold-aisle drone: too close it backs off; blocked while strafing it turns the other way; it follows the flow through a door', () => {
  const sim = newSim(DRONE_ROOM);
  const e = sim.enemies[0];
  const p = sim.player;
  e.state = 'chase';
  e.x = p.x + 2;
  e.y = p.y;
  e.cooldown = 999;
  const d0 = cda.cdaDist(e.x, e.y, p.x, p.y);
  run(sim, 30);
  assert.ok(cda.cdaDist(e.x, e.y, p.x, p.y) > d0 + 0.5, 'backed off');
  // strafing into the north wall
  e.x = p.x + 5;
  e.y = 1 + e.radius + 0.001;
  p.y = 1.5;
  e.side = 1;
  e.sideT = 999;
  run(sim, 1);
  assert.equal(e.side, -1);
  // behind a door, out of sight
  const room = newSim(['############', '#@.........#', '#####+######', '#.....d....#', '############']);
  const r = room.enemies[0];
  r.state = 'chase';
  let top = r.y;
  const ev = run(room, 600, () => {
    top = Math.min(top, r.y);
    return input();
  });
  assert.deepEqual(ofType(ev, 'door').map((d) => d.by).slice(0, 1), ['enemy']);
  assert.ok(top < 2.5, 'came into the doorway, from where it sees the player');
  // and it dies to the probe
  room.player.tool = 'probe';
  until(room, is('die'), 1200, (s) => aimFire(s));
  assert.equal(r.state, 'die');
});

// ── turret ─────────────────────────────────────────────────────────────────

const TURRET_ROOM = [
  '##########',
  '#........#',
  '#........#',
  '#....#...#',
  '#..@....t#',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
  '##########'
];

test('cold-aisle turret: it locks on visibly, then fires a burst of bolts at the player; it never moves', () => {
  const sim = newSim(TURRET_ROOM);
  const e = sim.enemies[0];
  const row = E.turret;
  const x0 = e.x;
  let ev = until(sim, is('windup'), 200);
  assert.equal(ofType(ev, 'wake')[0].why, 'sight');
  assert.equal(e.state, 'windup');
  ev = run(sim, S(row.windup) + S(row.gap) * row.burst + 120);
  const fires = ofType(ev, 'fire');
  assert.equal(fires.length, row.burst);
  assert.equal(fires[0].kind, 'bolt');
  assert.equal(fires[1].tick - fires[0].tick, S(row.gap));
  assert.equal(ofType(ev, 'attack')[0].tick, fires[0].tick);
  const hurts = ofType(ev, 'hurt');
  assert.equal(hurts.length, row.burst);
  for (const h of hurts) assert.deepEqual([h.damage, h.by], [row.damage, 'bolt']);
  assert.equal(e.x, x0);
  assert.equal(e.state, 'chase');
  assert.ok(e.cooldown > 0);
});

test('cold-aisle turret: stepping behind cover during the lock-on breaks it; bolts can be outrun; a hit interrupts it', () => {
  const sim = newSim(TURRET_ROOM);
  const e = sim.enemies[0];
  const row = E.turret;
  until(sim, is('windup'), 200);
  let ev = run(sim, S(0.4), input({ strafe: -1 }));
  assert.deepEqual(ofType(ev, 'lockLost').map((l) => l.id), [e.id]);
  assert.equal(ofType(ev, 'fire').length, 0);
  assert.equal(e.state, 'chase');
  ev = run(sim, S(row.relock) + 60);
  assert.equal(ofType(ev, 'windup').length, 0, 'no line, no lock');
  // back in sight: a new lock; run sideways as the burst starts
  run(sim, S(0.4), input({ strafe: 1 }));
  until(sim, is('attack'), 400);
  ev = run(sim, S(1.2), input({ strafe: 1 })).concat(run(sim, 120));
  assert.equal(ofType(ev, 'fire').length, row.burst - 1);
  assert.equal(ofType(ev, 'hurt').length, 0, 'every bolt missed');
  // a hit during the lock-on makes it flinch
  until(sim, is('windup'), 600);
  sim.player.tool = 'probe';
  run(sim, 1, (s) => aimFire(s));
  assert.equal(e.state, 'hurt');
  until(sim, is('die'), 1200, (s) => aimFire(s));
});

// ── loader ─────────────────────────────────────────────────────────────────

test('cold-aisle loader: it telegraphs, charges where the player stood, hits and is stunned; it never flinches', () => {
  const sim = newSim(['###############', '#.............#', '#@...........l#', '#.............#', '###############']);
  const e = sim.enemies[0];
  const row = E.loader;
  let ev = until(sim, is('windup'), 1200);
  assert.equal(ofType(ev, 'wake')[0].why, 'sight');
  assert.ok(cda.cdaDist(e.x, e.y, sim.player.x, sim.player.y) <= row.chargeRange);
  const dir = e.dir;
  // a hit during the tell changes nothing
  sim.player.tool = 'probe';
  run(sim, 1, (s) => aimFire(s));
  assert.equal(e.state, 'windup');
  assert.equal(e.hp, row.hp - T.probe.damage);
  ev = until(sim, is('stun'), 600);
  assert.equal(ofType(ev, 'attack').length, 1);
  const hurt = ofType(ev, 'hurt')[0];
  assert.deepEqual([hurt.damage, hurt.by], [row.damage, 'loader']);
  assert.equal(ofType(ev, 'stun')[0].hit, true);
  assert.equal(e.dir, dir, 'straight on');
  assert.equal(e.state, 'stun');
  run(sim, S(row.stun));
  assert.equal(e.state, 'chase');
  until(sim, is('die'), 2400, (s) => aimFire(s));
});

test('cold-aisle loader: a charge sidestepped in time runs into the wall, or out of steam in the open, and stuns it', () => {
  const short = newSim(['###########', '#.........#', '#.........#', '#@.......l#', '#.........#', '###########']);
  const e = short.enemies[0];
  let ev = until(short, is('windup'), 600);
  ev = until(short, is('stun'), 600, input({ strafe: -1 }));
  assert.equal(ofType(ev, 'hurt').length, 0);
  assert.equal(ofType(ev, 'stun')[0].hit, false);
  assert.ok(e.x < 2, 'into the west wall');
  const long = newSim(['##############################', '#............................#', '#............................#',
    '#..........@.........l.......#', '#............................#', '##############################']);
  const f = long.enemies[0];
  until(long, is('windup'), 600);
  const x0 = f.x;
  ev = until(long, is('stun'), 600, input({ strafe: -1 }));
  assert.equal(ofType(ev, 'stun')[0].hit, false);
  assert.ok(f.x > 2, 'stopped in the open');
  assert.ok(Math.abs(x0 - f.x - E.loader.chargeMax) < 0.1, 'after chargeMax cells');
});

// Two floor cells that touch only at a corner, between two wall cells: the
// player in the top left one, a crawler in the bottom right one.
const CORNER = ['####', '#@##', '##s#', '####'];

test('cold-aisle crawler: melee needs a clear line: no swing and no blow through the gap between two wall corners', () => {
  const sim = newSim(CORNER);
  const e = sim.enemies[0];
  const p = sim.player;
  // both bodies as far into the corner as the walls let them, within reach of each other
  p.x = 1.75;
  p.y = 1.7;
  e.x = 2.3;
  e.y = 2.32;
  e.state = 'chase';
  assert.ok(cda.cdaDist(e.x, e.y, p.x, p.y) - e.radius - p.radius <= E.crawler.reach, 'the gap alone would do');
  assert.equal(cda.cdaSees(sim, e.x, e.y, p.x, p.y), false);
  let ev = run(sim, S(2));
  assert.equal(ofType(ev, 'windup').length, 0, 'it never starts a swing');
  assert.equal(e.state, 'chase');
  // a swing already under way does not land either
  e.state = 'windup';
  e.t = 0;
  ev = run(sim, S(E.crawler.windup) + 1);
  assert.equal(ofType(ev, 'attack').length, 1);
  assert.equal(ofType(ev, 'hurt').length, 0);
  assert.equal(p.health, 100);
  // the same gap in the open: the swing starts and lands
  const open = newSim(['####', '#@.#', '#.s#', '####']);
  Object.assign(open.player, { x: 1.75, y: 1.7 });
  Object.assign(open.enemies[0], { x: 2.3, y: 2.32, state: 'chase' });
  ev = until(open, is('hurt'), S(2));
  assert.equal(ofType(ev, 'windup').length, 1);
});

test('cold-aisle loader: a charge that ends against a wall with the player just beyond it does no harm', () => {
  // forced: the loader's centre a hair inside the wall between them, the bodies touching
  const sim = newSim(['#####', '#@#l#', '#####']);
  const e = sim.enemies[0];
  sim.player.x = 1.4;
  e.x = 2.05;
  e.dir = Math.PI;
  e.state = 'attack';
  e.t = 0;
  assert.ok(cda.cdaDist(e.x, e.y, sim.player.x, sim.player.y) - e.radius - sim.player.radius <= cda.CDA_TOUCH);
  const ev = run(sim, 1);
  assert.deepEqual(ofType(ev, 'stun').map((s) => s.hit), [false]);
  assert.equal(ofType(ev, 'hurt').length, 0);
});

test('cold-aisle loader: woken by noise it opens a door to reach the player', () => {
  const sim = newSim(CRAWLER_ROOM.map((r) => r.replace('s', 'l')));
  sim.player.tool = 'probe';
  run(sim, 1, input({ fire: true }));
  const ev = until(sim, is('windup'), 1800);
  assert.deepEqual(ofType(ev, 'door').map((d) => d.by), ['enemy']);
});

test('cold-aisle crawler: enemies never open a locked door; behind a closed one an awake crawler waits where it is', () => {
  const sim = newSim(['#########', '#@......#', '####b####', '#...s...#', '#########']);
  const e = sim.enemies[0];
  e.state = 'chase';
  const x = e.x;
  const ev = run(sim, 240);
  assert.equal(sim.flow[3 * 9 + 4], -1);
  assert.equal(ofType(ev, 'door').length, 0);
  assert.equal(e.x, x);
  assert.equal(sim.doors[0].state, 'closed');
});

test('cold-aisle crawler: one whose centre slid into the corner of a crate\'s cell still finds its way to the player', () => {
  const sim = newSim(['#########', '#@......#', '#.......#', '#....x..#', '#.......#', '#########']);
  const e = cda.cdaNewEnemy(sim, 'crawler', 5.08, 3.08, false);
  e.state = 'chase';
  assert.equal(sim.map.block[cda.cdaCellOf(sim, e.x, e.y)], 1);
  run(sim, 240);
  assert.ok(cda.cdaDist(e.x, e.y, sim.player.x, sim.player.y) < 1.5);
});
