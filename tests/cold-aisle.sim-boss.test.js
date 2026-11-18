// tests/cold-aisle.sim-boss.test.js
// Cold Aisle's boss, the chiller: its loop (frost fans, calling crawlers,
// open vents), armour outside the vents, the phases at 2/3 and 1/3 of its
// health, its death opening the lift; and the contract of the spec: a simple
// scripted player that hides behind a pillar and shoots through the open
// vents wins, a player that stands still loses.  Numbers come from the tables.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./_setup');

const cda = loadScript('cold-aisle/script.js');
const B = cda.CDA_BOSS;
const ROW = cda.CDA_ENEMY.chiller;
const S = (seconds) => cda.cdaSteps(seconds);

const ARMED = () => ({ tools: ['driver', 'probe', 'degausser'], ammo: { cell: 120, coil: 30 }, health: 100, armour: 0 });

function newSim(map, carry) {
  return cda.cdaNewSim(cda.cdaParseLevel({ name: 'Plant', briefing: 'The boss.', facing: 'N', map }), carry || ARMED(), {}, 1);
}

function input(over) {
  return Object.assign(cda.cdaInputNew(), over);
}

function run(sim, n, inp) {
  const out = [];
  for (let i = 0; i < n; i++) {
    cda.cdaStep(sim, typeof inp === 'function' ? inp(sim, i) : inp || cda.cdaInputNew());
    for (const e of sim.events) out.push(Object.assign({ tick: sim.tick }, e));
  }
  return out;
}

const ofType = (events, type) => events.filter((e) => e.type === type);

// The plant: the chiller at the top, two pillars (wall cells: they stop
// bolts and sight), the player at the bottom by the lift.
const PLANT = [
  '#################',
  '#...............#',
  '#...............#',
  '#.......Z.......#',
  '#...............#',
  '#...............#',
  '#....#.....#....#',
  '#...............#',
  '#...............#',
  '#.......@.......#',
  '########L########'
];

test('cold-aisle chiller: asleep until it sees the player, then its loop: windup, a frost fan, a call, open vents, idle', () => {
  const sim = newSim(PLANT);
  const boss = sim.enemies[0];
  const p = sim.player;
  p.health = 1e9;
  const ph = B.phases[0];
  assert.equal(boss.state, 'asleep');
  let ev = run(sim, 1);
  assert.deepEqual(ofType(ev, 'wake').map((w) => w.why), ['sight']);
  ev = run(sim, S(ROW.alert));
  assert.equal(boss.state, 'windup');
  assert.equal(ofType(ev, 'windup').length, 1);
  const changes = [];
  let last = boss.state;
  ev = run(sim, S(ph.windup + ph.attack + ph.call + ph.vent + ph.idle) + 1, (s) => {
    if (boss.state !== last) {
      changes.push([boss.state, s.tick]);
      last = boss.state;
    }
    return input();
  });
  assert.deepEqual(changes.map((c) => c[0]), ['attack', 'call', 'vent', 'idle', 'windup']);
  const at = (state) => changes.find((c) => c[0] === state)[1];
  assert.equal(at('call') - at('attack'), S(ph.attack));
  assert.equal(at('vent') - at('call'), S(ph.call));
  assert.equal(at('idle') - at('vent'), S(ph.vent));
  assert.equal(at('windup') - at('idle'), S(ph.idle));
  // the fan: `bolts` frost bolts, the middle one straight at the player
  const fires = ofType(ev, 'fire');
  assert.equal(fires.length, ph.bolts * ph.volleys);
  assert.ok(fires.every((f) => f.kind === 'frost' && f.owner === boss.id));
  const aim = cda.cdaAngleTo(boss.x, boss.y, p.x, p.y);
  assert.ok(Math.abs(fires[(ph.bolts - 1) / 2].angle - aim) < 1e-9);
  assert.ok(Math.abs(fires[ph.bolts - 1].angle - fires[0].angle - ph.spread * (ph.bolts - 1) / ph.bolts) < 1e-9);
  assert.deepEqual(ofType(ev, 'vent').map((v) => v.open), [true, false]);
  assert.equal(ofType(ev, 'summon').length, ph.calls);
  assert.ok(ofType(ev, 'hurt').some((h) => h.by === 'frost'), 'a player who stays in the open is hit');
});

test('cold-aisle chiller: armour outside the vents; through them damage counts, and phases change at 2/3 and 1/3', () => {
  const sim = newSim(PLANT);
  const boss = sim.enemies[0];
  // a hit while asleep: blocked, but it wakes
  cda.cdaDamageEnemy(sim, boss, 50, boss.x, boss.y + 1);
  assert.deepEqual(ofType(sim.events, 'hit').map((h) => [h.damage, h.blocked]), [[0, true]]);
  assert.deepEqual(ofType(sim.events, 'wake').map((w) => w.why), ['hurt']);
  assert.equal(boss.hp, ROW.hp);
  boss.state = 'vent';
  sim.events = [];
  cda.cdaDamageEnemy(sim, boss, 50, boss.x, boss.y + 1);
  assert.deepEqual(ofType(sim.events, 'hit').map((h) => [h.damage, h.blocked]), [[50, false]]);
  assert.equal(boss.hp, ROW.hp - 50);
  assert.equal(boss.flash, S(B.flash));
  run(sim, 3);
  assert.equal(boss.flash, S(B.flash) - 3);
  // into phase 2
  boss.state = 'vent';
  sim.events = [];
  cda.cdaDamageEnemy(sim, boss, boss.hp - Math.floor(ROW.hp * 2 / 3), boss.x, boss.y);
  assert.deepEqual(ofType(sim.events, 'phase').map((e) => e.phase), [2]);
  assert.deepEqual(ofType(sim.events, 'vent').map((v) => v.open), [false]);
  assert.equal(boss.state, 'idle');
  assert.equal(boss.loop, B.loop.length - 1);
  // into phase 3
  boss.state = 'vent';
  sim.events = [];
  cda.cdaDamageEnemy(sim, boss, boss.hp - Math.floor(ROW.hp / 3), boss.x, boss.y);
  assert.equal(boss.phase, 3);
  // the phase-3 fan has its phase's bolts and volleys
  const ph = B.phases[2];
  sim.player.health = 1e9;
  const ev = run(sim, S(ph.idle + ph.windup + ph.attack) + 1);
  assert.equal(ofType(ev, 'fire').length, ph.bolts * ph.volleys);
  // killing it through the vents opens the lift
  boss.state = 'vent';
  sim.events = [];
  assert.equal(sim.liftOpen, false);
  run(sim, 1);
  boss.state = 'vent';
  cda.cdaDamageEnemy(sim, boss, 1, boss.x, boss.y);
  assert.ok(boss.flash > 0, 'its hurt flash is running');
  sim.events = [];
  cda.cdaDamageEnemy(sim, boss, boss.hp, boss.x, boss.y);
  assert.deepEqual(ofType(sim.events, 'die').map((d) => d.kind), ['chiller']);
  // killed with its vents open, they close first: the vent events come in pairs
  assert.deepEqual(sim.events.filter((e) => e.type === 'vent' || e.type === 'die').map((e) => e.type + (e.type === 'vent' ? ':' + e.open : '')),
    ['vent:false', 'die']);
  assert.equal(sim.events.find((e) => e.type === 'vent').id, boss.id);
  assert.equal(boss.flash, 0, 'a dead chiller has no flash (its step no longer runs to count it down)');
  assert.equal(sim.liftOpen, true);
  assert.equal(sim.stats.kills, 1);
  run(sim, S(cda.CDA_DIE_TIME));
  assert.equal(boss.state, 'dead');
  assert.equal(boss.flash, 0);
});

test('cold-aisle chiller: a player with only the driver can fight it: the reach is measured to its body, which is one cell wide', () => {
  const sim = newSim(PLANT, { tools: ['driver'], ammo: { cell: 0, coil: 0 }, health: 100, armour: 0 });
  const boss = sim.enemies[0];
  const p = sim.player;
  const driver = cda.CDA_TOOL.driver;
  assert.equal(ROW.radius, 0.5, 'drawn one cell wide (render-sprites), so its body is half a cell');
  // walk north into it: the bodies stop at the sum of the radii
  p.health = 1e9;
  run(sim, S(2), input({ move: 1 }));
  assert.ok(Math.abs(cda.cdaDist(p.x, p.y, boss.x, boss.y) - (ROW.radius + p.radius)) < 0.05);
  boss.state = 'vent';
  boss.t = 0;
  sim.events = [];
  const ev = run(sim, 1, input({ fire: true }));
  assert.deepEqual(ofType(ev, 'hit').map((h) => [h.damage, h.blocked]), [[driver.damage, false]]);
  assert.equal(boss.hp, ROW.hp - driver.damage);
  // and from just within its reach of the body's surface, not beyond
  const far = newSim(PLANT, { tools: ['driver'], ammo: { cell: 0, coil: 0 }, health: 100, armour: 0 });
  const b2 = far.enemies[0];
  b2.state = 'vent';
  far.player.x = far.player.px = b2.x;
  far.player.y = far.player.py = b2.y + ROW.radius + driver.reach - 0.05;
  assert.equal(ofType(run(far, 1, input({ fire: true })), 'hit').length, 1);
  b2.state = 'vent';
  far.player.y = far.player.py = b2.y + ROW.radius + driver.reach + 0.05;
  assert.equal(ofType(run(far, S(driver.cooldown), input({ fire: true })), 'hit').length, 0);
});

test('cold-aisle chiller: it calls crawlers on free spots only, never more than maxCalled alive; called ones are not counted', () => {
  const sim = newSim(PLANT);
  const boss = sim.enemies[0];
  const ph = B.phases[2];
  boss.state = 'alert';
  boss.phase = 3;
  cda.cdaStep(sim, input());
  // enter the call state straight away, repeatedly
  const call = () => {
    sim.events = [];
    boss.state = 'attack';
    boss.loop = 1;
    boss.t = S(ph.attack) - 1;
    boss.burst = ph.volleys;
    cda.cdaStep(sim, input());
    return ofType(sim.events, 'summon');
  };
  const first = call();
  assert.equal(first.length, ph.calls);
  for (const s of first) {
    const c = sim.enemies.find((e) => e.id === s.child);
    assert.equal(c.kind, 'crawler');
    assert.equal(c.summoned, true);
    assert.equal(c.state, 'alert');
  }
  assert.equal(call().length, B.maxCalled - ph.calls);
  assert.equal(call().length, 0, 'four alive');
  const called = sim.enemies.filter((e) => e.summoned);
  called[0].hp = 1;
  cda.cdaDamageEnemy(sim, called[0], 5, called[0].x, called[0].y);
  assert.equal(sim.stats.kills, 0);
  assert.equal(sim.stats.enemies, 1);
  assert.equal(call().length, 1);
  // in a tight spot only the free cells around it are used
  const tight = newSim(['#####', '#.Z.#', '#...#', '#.@.#', '#####']);
  const tb = tight.enemies[0];
  tb.state = 'attack';
  tb.loop = 1;
  tb.t = S(B.phases[0].attack) - 1;
  tb.burst = 9;
  cda.cdaStep(tight, input());
  const spots = ofType(tight.events, 'summon');
  assert.ok(spots.length < B.phases[0].calls + 1);
  for (const s of spots) assert.equal(cda.cdaHitsWalls(tight, s.x, s.y, cda.CDA_ENEMY.crawler.radius), false);
});

// ── the scripted players ───────────────────────────────────────────────────

// Steers the player toward (x, y) while facing `face` (radians).
function steer(sim, x, y, face, fire) {
  const p = sim.player;
  const turn = cda.cdaAngleDiff(face, p.angle);
  const d = cda.cdaDist(p.x, p.y, x, y);
  if (d < 0.05) return input({ turn, fire });
  const w = cda.cdaAngleTo(p.x, p.y, x, y) - (p.angle + turn);
  const k = Math.min(1, d / (cda.CDA_PLAYER.speed * cda.CDA_STEP));
  return input({ turn, fire, move: Math.cos(w) * k, strafe: Math.sin(w) * k });
}

// The bot: behind the west pillar while the chiller can shoot; out to a
// spot it sees from while the vents are open.  A called crawler within 3
// cells it shoots first (the probe), then the open chiller (the degausser
// while it has coils), then any crawler it sees.
const COVER = { x: 4.5, y: 7.5 };
const OPEN = { x: 6.5, y: 7.5 };
function plantBot(sim) {
  const p = sim.player;
  const boss = sim.enemies[0];
  const dist = (e) => cda.cdaDist(p.x, p.y, e.x, e.y);
  const seen = sim.enemies.filter((e) => e !== boss && e.hp > 0 && cda.cdaSees(sim, p.x, p.y, e.x, e.y)).sort((a, b) => dist(a) - dist(b));
  const venting = boss.state === 'vent';
  let target = seen.length && dist(seen[0]) < 3 ? seen[0] : null;
  if (!target && venting && cda.cdaSees(sim, p.x, p.y, boss.x, boss.y)) target = boss;
  if (!target && seen.length) target = seen[0];
  const tool = target === boss && p.ammo.coil > 0 ? 3 : 2;
  const face = cda.cdaAngleTo(p.x, p.y, (target || boss).x, (target || boss).y);
  const inp = steer(sim, venting ? OPEN.x : COVER.x, venting ? OPEN.y : COVER.y, face, !!target);
  inp.weapon = p.tool !== cda.CDA_TOOLS[tool - 1].id ? tool : 0;
  return inp;
}

test('cold-aisle chiller: a simple scripted player beats it from behind a pillar; a player who stands still loses', () => {
  const sim = newSim(PLANT);
  const boss = sim.enemies[0];
  const events = [];
  for (let i = 0; i < S(240) && sim.status === 'playing'; i++) {
    // once the chiller is down, walk to the lift and use it
    const inp = boss.hp > 0 ? plantBot(sim) : steer(sim, 8.5, 9.5, Math.PI / 2, false);
    inp.use = boss.hp <= 0 && i % 2 === 0;
    cda.cdaStep(sim, inp);
    for (const e of sim.events) events.push(e);
  }
  assert.equal(sim.status, 'won', 'health ' + sim.player.health + ', chiller ' + boss.hp);
  assert.deepEqual(ofType(events, 'phase').map((e) => e.phase), [2, 3]);
  assert.ok(ofType(events, 'hit').some((h) => h.id === boss.id && !h.blocked));
  assert.ok(ofType(events, 'summon').length >= 4);
  // never more than maxCalled called crawlers alive (checked on the final state and through the run's summons)
  assert.ok(sim.enemies.filter((e) => e.summoned && e.hp > 0).length <= B.maxCalled);
  assert.ok(sim.player.health > 0);
  const still = newSim(PLANT);
  const ev = run(still, S(120), input());
  assert.equal(still.status, 'dead');
  assert.ok(ofType(ev, 'hurt').some((h) => h.by === 'frost'));
});
