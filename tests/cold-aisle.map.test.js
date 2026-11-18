// tests/cold-aisle.map.test.js
// Cold Aisle's level format: the legend, cdaParseLevel and every refusal it
// names, the cell queries, rays and sight by DDA (doors as thin sliding
// walls), and the flow field the enemies follow.  Test levels are small maps
// written here; the real levels have their own tests.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./_setup');

const cda = loadScript('cold-aisle/script.js');

function level(map, over) {
  return Object.assign({ name: 'Test', briefing: 'A test.', facing: 'E', map }, over);
}

function parse(map, over) {
  return cda.cdaParseLevel(level(map, over));
}

function newSim(map, over) {
  return cda.cdaNewSim(parse(map, over), cda.cdaCarryNew(), {}, 1);
}

// The message cdaParseLevel throws for a level.
function refusal(map, over) {
  try {
    parse(map, over);
  } catch (e) {
    return e.message;
  }
  return null;
}

// ── the legend ─────────────────────────────────────────────────────────────

// The wall textures the spec's Art section names (the contract with the art).
const WALL_TEXTURES = ['wall-concrete', 'wall-panel', 'wall-pipes', 'wall-rack-a', 'wall-rack-b', 'wall-rack-c', 'wall-rack-rear',
  'wall-rack-infected0', 'wall-rack-infected1', 'wall-rack-clean', 'wall-terminal0', 'wall-terminal1', 'wall-secret', 'door',
  'door-blue', 'door-yellow', 'door-red', 'door-jamb', 'lift-locked', 'lift-open'];

test('cold-aisle map: every legend texture, frame and flat is one the art names, and every thing names a table row', () => {
  for (const [ch, def] of Object.entries(cda.CDA_LEGEND)) {
    assert.equal(ch.length, 1);
    assert.ok(['floor', 'wall', 'door', 'secret', 'rack', 'lift'].includes(def.kind), ch);
    if (def.kind === 'floor') assert.equal(def.tex, '');
    else assert.ok(WALL_TEXTURES.includes(def.tex), ch + ' ' + def.tex);
  }
  for (const [a, b] of Object.entries(cda.CDA_TEX_FRAMES)) assert.ok(WALL_TEXTURES.includes(a) && WALL_TEXTURES.includes(b));
  for (const t of [cda.CDA_TEX_JAMB, cda.CDA_TEX_RACK_CLEAN, cda.CDA_TEX_LIFT_OPEN]) assert.ok(WALL_TEXTURES.includes(t));
  assert.deepEqual(cda.CDA_FLOORS, ['floor-tile', 'floor-grate', 'floor-concrete', 'floor-plate']);
  assert.deepEqual(cda.CDA_CEILS, ['ceil-panel', 'ceil-light', 'ceil-tray', 'ceil-pipes']);
  const lists = { enemies: cda.CDA_ENEMY, items: cda.CDA_ITEM, decor: cda.CDA_DEC };
  for (const [ch, t] of Object.entries(cda.CDA_THINGS)) {
    assert.ok(!(ch in cda.CDA_LEGEND), ch + ' is a thing or a cell, not both');
    if (t.thing === 'start') continue;
    assert.ok(lists[t.thing][t.id], ch + ' -> ' + t.id);
  }
  // every row of the tables has its character
  for (const [list, rows] of Object.entries(lists)) {
    for (const id of Object.keys(rows)) assert.ok(Object.values(cda.CDA_THINGS).some((t) => t.thing === list && t.id === id), id);
  }
});

test('cold-aisle map: a level with every cell and thing parses into grids, lists and looks', () => {
  const dots = '.'.repeat(27);
  const lv = parse([
    '###%%%===[[[]]]|||HHHTTTKKK',
    '#@.$..X#L.#.#.#scmBuI.dvPn#',
    '#......+..b.y.r...tl*YRGoO#',
    '#.....x#..#.#.#.fe^/iZ....#',
    '###########################'
  ], { floor: 'floor-concrete', ceil: 'ceil-tray', light: 2, zones: { 2: { floor: 'floor-plate', ceil: 'ceil-pipes', light: 0 },
    1: { floor: 'floor-grate', ceil: 'ceil-light', light: 1 } }, zoneMap: [dots, '.11' + dots.slice(3), '.2' + dots.slice(2), dots, dots] });
  assert.equal(lv.name, 'Test');
  assert.equal(lv.briefing, 'A test.');
  assert.equal(lv.w, 27);
  assert.equal(lv.h, 5);
  assert.equal(lv.facing, 0);
  assert.deepEqual(lv.start, { x: 1.5, y: 1.5 });
  assert.deepEqual(lv.zones, [
    { floor: 'floor-concrete', ceil: 'ceil-tray', light: 2 },
    { floor: 'floor-grate', ceil: 'ceil-light', light: 1 },
    { floor: 'floor-plate', ceil: 'ceil-pipes', light: 0 }
  ]);
  assert.equal(lv.zone[27 + 1], 1);
  assert.equal(lv.zone[27 + 2], 1);
  assert.equal(lv.zone[54 + 1], 2);
  assert.equal(lv.zone[0], 0);
  const at = (x, y) => y * 27 + x;
  assert.equal(lv.kind[at(3, 1)], 'secret');
  assert.equal(lv.tex[at(3, 1)], 'wall-secret');
  assert.equal(lv.kind[at(6, 1)], 'rack');
  assert.equal(lv.kind[at(8, 1)], 'lift');
  assert.equal(lv.tex[at(3, 0)], 'wall-panel');
  assert.equal(lv.kind[at(1, 1)], 'floor', 'things stand on floor');
  assert.equal(lv.tex[at(1, 1)], '');
  assert.equal(lv.secrets, 1);
  assert.deepEqual(lv.racks, [at(6, 1)]);
  assert.deepEqual(lv.lifts, [at(8, 1)]);
  assert.deepEqual(lv.doors.map((d) => [d.x, d.y, d.kind, d.axis]),
    [[7, 2, 'plain', 'y'], [10, 2, 'blue', 'y'], [12, 2, 'yellow', 'y'], [14, 2, 'red', 'y']]);
  assert.deepEqual(lv.enemies.map((e) => e.kind), ['crawler', 'drone', 'turret', 'loader', 'chiller']);
  assert.deepEqual(lv.enemies[0], { kind: 'crawler', x: 15.5, y: 1.5 });
  assert.deepEqual(lv.items.map((e) => e.kind).sort(), ['cell', 'coffee', 'coil', 'degausser', 'key-blue', 'key-red', 'key-yellow', 'medkit',
    'patch', 'probe', 'vest'].sort());
  assert.deepEqual(lv.decor.map((e) => e.kind).sort(), ['cart', 'chair', 'cone', 'crate', 'extinguisher', 'ladder', 'lamp', 'pillar',
    'spool'].sort());
  for (const d of lv.decor) assert.equal(lv.block[Math.floor(d.y) * 27 + Math.floor(d.x)], cda.CDA_DEC[d.kind].solid ? 1 : 0, d.kind);
});

test('cold-aisle map: the defaults come from CDA_ZONE_DEFAULT, light 0 is kept, facings are the four compass points', () => {
  const box = ['####', '#@.#', '####'];
  assert.deepEqual(parse(box).zones, [cda.CDA_ZONE_DEFAULT]);
  assert.equal(parse(box).zone.every((z) => z === 0), true);
  assert.equal(parse(box, { light: 0 }).zones[0].light, 0);
  assert.equal(parse(box, { facing: 'S' }).facing, Math.PI / 2);
  assert.equal(parse(box, { facing: 'W' }).facing, Math.PI);
  assert.equal(parse(box, { facing: 'N' }).facing, -Math.PI / 2);
  assert.deepEqual(parse(['#####', '#.#@#', '#+###', '#.###', '#####']).doors[0].axis, 'x');
});

test('cold-aisle map: cdaParseLevel refuses a broken level, naming the level, the cell and the problem', () => {
  const box = ['####', '#@.#', '####'];
  const cases = [
    [['#'.repeat(65), '#@' + '.'.repeat(62) + '#', '#'.repeat(65)], {}, /^Cold Aisle level "Test": the map is 65x3, more than 64$/],
    [box, { facing: 'X' }, /facing must be N, E, S or W/],
    [box, { floor: 'floor-wood' }, /"Test" \(defaults\): unknown floor "floor-wood"/],
    [box, { ceil: 'sky' }, /\(defaults\): unknown ceiling "sky"/],
    [box, { light: 4 }, /\(defaults\): light must be 0, 1, 2 or 3/],
    [box, { zones: { 1: { floor: 'floor-tile', ceil: 'ceil-panel', light: 1.5 } } }, /\(zone 1\): light must be/],
    [box, { zones: { a: { floor: 'floor-tile', ceil: 'ceil-panel', light: 1 } } }, /zone names are single digits, not "a"/],
    [box, { zoneMap: ['....'] }, /zoneMap has 1 rows, the map 3/],
    [['####', '#@.#', '###'], {}, /row 2 is 3 wide, not 4/],
    [box, { zoneMap: ['....', '...', '....'] }, /zoneMap row 1 is 3 wide, not 4/],
    [['####', '#@?#', '####'], {}, /"Test", cell 2,1: unknown character "\?"/],
    [['####', '#@..', '####'], {}, /cell 3,1: the edge of the map must be wall, rack or lift/],
    [['#+##', '#@.#', '####'], {}, /cell 1,0: the edge/],
    [['##$#', '#@.#', '####'], {}, /cell 2,0: the edge/],
    [box, { zones: { 1: { floor: 'floor-tile', ceil: 'ceil-panel', light: 1 } }, zoneMap: ['....', '.12.', '....'] }, /cell 2,1: zone "2" is not defined/],
    [['####', '#@@#', '####'], {}, /cell 2,1: a second player start/],
    [['####', '#..#', '####'], {}, /: no player start \(@\)/],
    [['#####', '#@..#', '#.+.#', '#...#', '#####'], {}, /cell 2,2: a door needs walls on two opposite sides/],
    // the way through a door: both cells beyond it must be floor or doors (north, south, west, east)
    [['#####', '#.#.#', '##+##', '#@..#', '#####'], {}, /cell 2,2: a door must lead to floor \(or another door\) on both sides of its way through/],
    [['#####', '#...#', '##+##', '#@#.#', '#####'], {}, /cell 2,2: a door must lead to floor/],
    [['#####', '#@#.#', '##+.#', '#.#.#', '#####'], {}, /cell 2,2: a door must lead to floor/],
    [['#####', '#.#@#', '#.+##', '#.#.#', '#####'], {}, /cell 2,2: a door must lead to floor/]
  ];
  for (const [map, over, re] of cases) {
    const msg = refusal(map, over);
    assert.match(String(msg), re, map.join('/') + ' ' + msg);
  }
  // the edge rule passes racks and lifts
  assert.equal(refusal(['#XL#', '#@.#', '####']), null);
  assert.equal(refusal(box), null);
  assert.equal(refusal(['####', '#..#', '####'], { name: 'Dock' }), 'Cold Aisle level "Dock": no player start (@)');
});

test('cold-aisle map: a level\'s kit is checked and copied, the driver alone and no ammo when it has none', () => {
  const box = ['####', '#@.#', '####'];
  assert.deepEqual(parse(box).kit, { tools: ['driver'], ammo: { cell: 0, coil: 0 } });
  const kit = { tools: ['driver', 'probe', 'degausser'], ammo: { cell: cda.CDA_TOOL.probe.cap, coil: 3 } };
  const lv = parse(box, { kit });
  assert.deepEqual(lv.kit, kit);
  assert.notEqual(lv.kit.tools, kit.tools, 'a copy');
  assert.deepEqual(parse(box, { kit: { tools: ['probe', 'driver'] } }).kit, { tools: ['probe', 'driver'], ammo: { cell: 0, coil: 0 } });
  assert.deepEqual(parse(box, { kit: { tools: ['driver'], ammo: { cell: 0 } } }).kit.ammo, { cell: 0, coil: 0 }, 'none of a missing tool');
  const cases = [
    [{ tools: 'driver' }, /"Test" \(kit\): the tools must be a list with the driver/],
    [{ tools: ['probe'] }, /the tools must be a list with the driver/],
    [{ tools: ['driver', 'wrench'] }, /\(kit\): unknown tool "wrench"/],
    [{ tools: ['driver', 'probe', 'probe'] }, /\(kit\): "probe" twice/],
    [{ tools: ['driver', 'probe'], ammo: { fuel: 1 } }, /\(kit\): unknown ammo "fuel"/],
    [{ tools: ['driver', 'probe'], ammo: { cell: 1.5 } }, /\(kit\): cell must be a whole number from 0 to /],
    [{ tools: ['driver', 'probe'], ammo: { cell: -1 } }, /cell must be a whole number/],
    [{ tools: ['driver', 'probe'], ammo: { cell: cda.CDA_TOOL.probe.cap + 1 } }, /cell must be a whole number/],
    [{ tools: ['driver', 'probe'], ammo: { cell: '3' } }, /cell must be a whole number/],
    [{ tools: ['driver'], ammo: { coil: 2 } }, /\(kit\): coil without the degausser/]
  ];
  for (const [k, re] of cases) assert.match(String(refusal(box, { kit: k })), re, JSON.stringify(k));
});

// ── cells, rays, sight ─────────────────────────────────────────────────────

test('cold-aisle map: cdaCast stops at walls along both axes and both directions, and gives up at max', () => {
  const sim = newSim(['#######', '#.....#', '#..@..#', '#.....#', '#######']);
  const p = sim.player;
  assert.deepEqual(cda.cdaCast(sim, p.x, p.y, 1, 0, 20, false), { dist: 2.5, x: 6, y: 2.5, cell: 2 * 7 + 6 });
  assert.equal(cda.cdaCast(sim, p.x, p.y, -1, 0, 20, false).dist, 2.5);
  assert.equal(cda.cdaCast(sim, p.x, p.y, 0, 1, 20, false).dist, 1.5);
  assert.equal(cda.cdaCast(sim, p.x, p.y, 0, -1, 20, false).cell, 3);
  const short = cda.cdaCast(sim, p.x, p.y, 1, 0, 1, false);
  assert.deepEqual(short, { dist: 1, x: 4.5, y: 2.5, cell: -1 });
  const d = Math.SQRT1_2;
  const diag = cda.cdaCast(sim, p.x, p.y, d, d, 20, false);
  assert.ok(Math.abs(diag.dist - 1.5 * Math.SQRT2) < 1e-9, 'into the corner row');
  assert.equal(cda.cdaSolid(sim, diag.cell), true);
  assert.equal(cda.cdaCellOf(sim, 3.9, 2.1), 2 * 7 + 3);
});

test('cold-aisle map: cdaCast marks what it crosses as seen, and cdaNewSim has swept the start view already', () => {
  const sim = newSim(['#########', '#@......#', '#########']);
  assert.equal(sim.map.seen[1 * 9 + 7], 1, 'the start sweep saw down the corridor');
  assert.equal(sim.map.seen[1 * 9 + 8], 1, 'and the wall that stopped it');
  sim.map.seen.fill(0);
  cda.cdaCast(sim, 1.5, 1.5, 1, 0, 3, false);
  assert.equal(sim.map.seen.some((s) => s), false);
  cda.cdaCast(sim, 1.5, 1.5, 1, 0, 3, true);
  assert.deepEqual(sim.map.seen.slice(9, 18), [0, 1, 1, 1, 1, 0, 0, 0, 0]);
});

test('cold-aisle map: a door is a thin wall on its middle line that slides away from its low side', () => {
  // axis 'y' door at (3,1): the line x = 3.5, covering y from 1 + open to 2
  const sim = newSim(['######', '#@.+.#', '######']);
  const door = sim.doors[0];
  assert.equal(door.axis, 'y');
  assert.equal(cda.cdaCast(sim, 1.5, 1.5, 1, 0, 10, false).dist, 2);
  assert.equal(cda.cdaSolid(sim, door.cell), true);
  door.open = 0.6;
  assert.equal(cda.cdaCast(sim, 1.5, 1.7, 1, 0, 10, false).dist, 2, 'y 1.7: still covered');
  assert.equal(cda.cdaCast(sim, 1.5, 1.5, 1, 0, 10, false).dist, 3.5, 'y 1.5: through the gap to the far wall');
  assert.equal(cda.cdaSolid(sim, door.cell), true, 'not open enough to pass');
  door.open = cda.CDA_DOOR_PASS;
  assert.equal(cda.cdaSolid(sim, door.cell), false);
  assert.equal(cda.cdaSees(sim, 1.5, 1.5, 4.5, 1.5), true);
  door.open = 0;
  assert.equal(cda.cdaSees(sim, 1.5, 1.5, 4.5, 1.5), false);
  assert.equal(cda.cdaSees(sim, 1.5, 1.5, 2.9, 1.5), true, 'short of the door line');
  assert.equal(cda.cdaSees(sim, 1.5, 1.5, 1.5, 1.5), true, 'a point sees itself (no endless walk)');
  // axis 'x' door at (1,2): the line y = 2.5, covering x from 1 + open to 2
  const v = newSim(['###', '#@#', '#+#', '#.#', '###']);
  assert.equal(v.doors[0].axis, 'x');
  assert.equal(cda.cdaCast(v, 1.5, 1.5, 0, 1, 10, false).dist, 1);
  v.doors[0].open = 0.6;
  assert.equal(cda.cdaCast(v, 1.3, 1.5, 0, 1, 10, false).dist, 2.5, 'x 1.3 is in the open part');
  // a ray that grazes past a door line inside the cell without crossing it there
  assert.ok(Math.abs(cda.cdaCast(v, 1.9, 2.4, 1, 0, 10, false).dist - 0.1) < 1e-9, 'stopped by the jamb, not the door');
});

test('cold-aisle map: cdaHitsWalls tests a circle against the solid cells around it', () => {
  const sim = newSim(['#####', '#@..#', '#####']);
  assert.equal(cda.cdaHitsWalls(sim, 1.5, 1.5, 0.22), false);
  assert.equal(cda.cdaHitsWalls(sim, 1.2, 1.5, 0.22), true, 'into the west wall');
  assert.equal(cda.cdaHitsWalls(sim, 1.25, 1.25, 0.3), true, 'into the corner');
  assert.equal(cda.cdaHitsWalls(sim, 1.23, 1.5, 0.22), false, 'just clear');
});

// ── the flow field ─────────────────────────────────────────────────────────

test('cold-aisle map: the flow field counts 8-way steps, cuts no corners and routes around solid decor', () => {
  const sim = newSim([
    '#######',
    '#@....#',
    '#.##..#',
    '#.#x..#',
    '#.....#',
    '#######'
  ]);
  const at = (x, y) => sim.flow[y * 7 + x];
  assert.equal(at(1, 1), 0);
  assert.equal(at(2, 1), 1);
  assert.equal(at(1, 4), 3);
  assert.equal(at(2, 4), 4, 'no diagonal past the wall corner at 2,3');
  assert.ok(at(3, 3) > 0, 'a solid-decor cell has a value, to lead out of it');
  const crate = 3 * 7 + 3;
  assert.ok(cda.cdaFlowNext(sim, crate) >= 0 && sim.flow[cda.cdaFlowNext(sim, crate)] < at(3, 3));
  for (let c = 0; c < sim.flow.length; c++) if (sim.flow[c] > 0) assert.notEqual(cda.cdaFlowNext(sim, c), crate, 'never into the crate');
  assert.equal(at(4, 2), 4, 'the diagonal from 3,1 would cut the wall corner at 3,2: 4,1 then down');
  assert.equal(at(0, 0), -1);
  assert.equal(cda.cdaFlowNext(sim, 4 * 7 + 1), 3 * 7 + 1);
  assert.equal(cda.cdaFlowNext(sim, 1 * 7 + 1), -1, 'nowhere nearer than the player cell');
  assert.equal(cda.cdaFlowStep(sim, 4 * 7 + 1, 5), -1, 'a diagonal into a wall');
  // recomputed only when the player's cell changes or it is marked dirty
  sim.flow[2 * 7 + 4] = 99;
  cda.cdaFlowUpdate(sim);
  assert.equal(at(4, 2), 99);
  sim.flowDirty = true;
  cda.cdaFlowUpdate(sim);
  assert.equal(at(4, 2), 4);
  sim.player.x = 5.5;
  cda.cdaFlowUpdate(sim);
  assert.equal(at(5, 1), 0);
  assert.equal(sim.flowFrom, 1 * 7 + 5);
});

test('cold-aisle map: plain doors are always walkable for the flow field, locked ones only while opening or open', () => {
  const sim = newSim(['#########', '#@.+.b..#', '#########']);
  const plain = sim.doors[0];
  const blue = sim.doors[1];
  assert.equal(cda.cdaWalkable(sim, plain.cell), true);
  assert.equal(cda.cdaWalkable(sim, blue.cell), false);
  assert.equal(sim.flow[1 * 9 + 6], -1);
  blue.state = 'opening';
  assert.equal(cda.cdaWalkable(sim, blue.cell), true);
  blue.state = 'open';
  assert.equal(cda.cdaWalkable(sim, blue.cell), true);
  sim.flowDirty = true;
  cda.cdaFlowUpdate(sim);
  assert.equal(sim.flow[1 * 9 + 6], 5);
  blue.state = 'closing';
  assert.equal(cda.cdaWalkable(sim, blue.cell), false);
});
