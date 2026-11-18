// tests/cold-aisle.levels.test.js
// Cold Aisle's nine levels as data: every level parses; its size, racks,
// kit and enemy kinds keep to the spec; the grid is closed; the zone map and
// the zones agree; the route exists in the order the badges allow (the
// start reaches every rack, every badge before its door is needed, the
// lift), never through a secret wall; every item, enemy and secret is
// reachable (secrets with Use on their wall) and every secret hides a patch.
// Also cdaLevelCarry (kit and carry, field by field).  The scripted players
// that play the levels are in cold-aisle.route.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./_setup');

const cda = loadScript('cold-aisle/script.js');
const LEVELS = cda.CDA_LEVELS;

// The spec's level names (section Levels), in order.
const NAMES = ['Loading Dock', 'Meet-Me Room', 'Cold Aisle A', 'Hot Aisle', 'Tape Vault', 'UPS Hall', 'Cable Vault', 'NOC',
  'Chiller Plant'];
// The spec's "from level" column of the enemies table.
const FROM_LEVEL = { crawler: 1, drone: 2, turret: 4, loader: 5, chiller: 9 };

const parsed = LEVELS.map((L) => cda.cdaParseLevel(L));

// ── reachability over a parsed level ──
// passable: floor (decor included: a body can stand beside it), any door
// whose badge is held, and secret walls when `secrets` (Use opens them).
function reach(lv, badges, secrets) {
  const seen = new Uint8Array(lv.w * lv.h);
  const start = Math.floor(lv.start.y) * lv.w + Math.floor(lv.start.x);
  const doorAt = {};
  for (const d of lv.doors) doorAt[d.cell] = d;
  const pass = (i) => {
    const k = lv.kind[i];
    if (k === 'floor') return true;
    if (k === 'door') return doorAt[i].kind === 'plain' || badges.has(doorAt[i].kind);
    return k === 'secret' && secrets;
  };
  const queue = [start];
  seen[start] = 1;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (const o of [1, -1, lv.w, -lv.w]) {
      const j = i + o;
      if (!seen[j] && pass(j)) {
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  return seen;
}

const cellOf = (lv, t) => Math.floor(t.y) * lv.w + Math.floor(t.x);
const beside = (lv, seen, c) => [1, -1, lv.w, -lv.w].some((o) => seen[c + o] && lv.kind[c + o] === 'floor');

// Picks up badges as they become reachable (no secret walls): the order
// the badges allow.  Returns { seen, badges, order }.
function route(lv) {
  const badges = new Set();
  const order = [];
  for (;;) {
    const seen = reach(lv, badges, false);
    const got = lv.items.filter((it) => /^key-/.test(it.kind) && seen[cellOf(lv, it)] && !badges.has(it.kind.slice(4)));
    if (!got.length) return { seen, badges, order };
    for (const it of got) {
      badges.add(it.kind.slice(4));
      order.push(it.kind.slice(4));
    }
  }
}

// ── where the player's body fits ──
// The cell grids above miss decor and corners; this floods the positions the
// player's centre can take, on a grid of BODY_GRID points per cell side, with
// the sim's own collision (cdaHitsWalls, cdaHitsBodies with solid decor, the
// player's radius).  Enemies are left out (they can be killed); the doors
// whose badge is held stand open, secret walls are open when `secrets`.
// It finds what the cell checks cannot: decor that seals a 1-cell corridor,
// a door that opens onto decor or a wall, a rack beyond the reach of Use.
const BODY_GRID = 8;
function bodySim(lv, badges, secrets) {
  const sim = cda.cdaNewSim(lv, cda.cdaCarryNew(), {}, 1);
  sim.enemies = [];
  sim.player.x = sim.player.y = -1e6;
  for (const d of sim.doors) {
    if (d.kind === 'plain' || badges.has(d.kind)) {
      d.open = 1;
      d.state = 'open';
    }
  }
  if (secrets) for (let i = 0; i < sim.map.kind.length; i++) if (sim.map.kind[i] === 'secret') sim.map.kind[i] = 'floor';
  return sim;
}
// Floods the free centres of sim from the grid points `seeds`, inside the
// cells x0..x1, y0..y1 (the whole map when no window is given).  Returns
// { sim, pts: [x, y, ...] reached, cell: Uint8Array (1 where a reached centre lies) }.
function bodyFlood(lv, sim, seeds, win) {
  const R = cda.CDA_PLAYER.radius;
  const probe = { x: -1e6, y: -1e6, radius: R };
  const [x0, y0, x1, y1] = win || [0, 0, lv.w - 1, lv.h - 1];
  const gw = lv.w * BODY_GRID;
  const seen = new Uint8Array(gw * lv.h * BODY_GRID);
  const free = (gx, gy) => {
    const x = gx / BODY_GRID;
    const y = gy / BODY_GRID;
    return x >= x0 && x < x1 + 1 && y >= y0 && y < y1 + 1 && !cda.cdaHitsWalls(sim, x, y, R) && !cda.cdaHitsBodies(sim, probe, x, y);
  };
  const queue = seeds.filter(([gx, gy]) => free(gx, gy)).map(([gx, gy]) => gy * gw + gx);
  for (const s of queue) seen[s] = 1;
  const pts = [];
  const cell = new Uint8Array(lv.w * lv.h);
  for (let q = 0; q < queue.length; q++) {
    const gx = queue[q] % gw;
    const gy = Math.floor(queue[q] / gw);
    pts.push(gx / BODY_GRID, gy / BODY_GRID);
    cell[Math.floor(gy / BODY_GRID) * lv.w + Math.floor(gx / BODY_GRID)] = 1;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const j = (gy + oy) * gw + gx + ox;
      if (!seen[j] && free(gx + ox, gy + oy)) {
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  return { sim, pts, cell };
}
// From the player's start.
function bodyReach(lv, badges, secrets) {
  const br = bodyFlood(lv, bodySim(lv, badges, secrets), [[lv.start.x * BODY_GRID, lv.start.y * BODY_GRID]]);
  assert.ok(br.pts.length, lv.name + ': the start is free');
  return br;
}
// The grid points of cell c.
function cellPoints(lv, c) {
  const pts = [];
  for (let k = 0; k < BODY_GRID * BODY_GRID; k++) pts.push([(c % lv.w) * BODY_GRID + (k % BODY_GRID), Math.floor(c / lv.w) * BODY_GRID + Math.floor(k / BODY_GRID)]);
  return pts;
}
// Whether Use from a reached centre (facing some point of the cell) reaches cell c.
function usable(lv, br, c) {
  const cx = c % lv.w;
  const cy = Math.floor(c / lv.w);
  const reachUse = cda.CDA_PLAYER.useReach;
  for (let k = 0; k < br.pts.length; k += 2) {
    const x = br.pts[k];
    const y = br.pts[k + 1];
    if (Math.abs(x - cx - 0.5) > reachUse + 0.5 || Math.abs(y - cy - 0.5) > reachUse + 0.5) continue;
    for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.5], [0.9, 0.5], [0.5, 0.1], [0.5, 0.9]]) {
      const dx = cx + fx - x;
      const dy = cy + fy - y;
      const d = Math.hypot(dx, dy);
      if (cda.cdaCast(br.sim, x, y, dx / d, dy / d, reachUse, false).cell === c) return true;
    }
  }
  return false;
}
// Whether an item at t is picked up from some reached centre.
function pickable(br, t) {
  for (let k = 0; k < br.pts.length; k += 2) {
    if (Math.hypot(br.pts[k] - t.x, br.pts[k + 1] - t.y) < cda.CDA_PLAYER.pickup) return true;
  }
  return false;
}
// The badges in the order the body reaches them, secrets shut.
function bodyBadges(lv) {
  const badges = new Set();
  for (;;) {
    const br = bodyReach(lv, badges, false);
    const got = lv.items.filter((it) => /^key-/.test(it.kind) && !badges.has(it.kind.slice(4)) && pickable(br, it));
    if (!got.length) return badges;
    for (const it of got) badges.add(it.kind.slice(4));
  }
}

test('cold-aisle levels: the player\'s body reaches every floor cell, both sides of every door, every item, rack, lift and secret', () => {
  const problems = [];
  const check = (ok, what) => { if (!ok) problems.push(what); };
  for (const lv of parsed) {
    const at = (c) => (c % lv.w) + ',' + Math.floor(c / lv.w);
    const badges = bodyBadges(lv);
    const shut = bodyReach(lv, badges, false);
    for (let i = 0; i < lv.kind.length; i++) {
      if (lv.kind[i] === 'secret') check(usable(lv, shut, i), lv.name + ': the secret at ' + at(i) + ' can be opened from where the body reaches');
    }
    const br = bodyReach(lv, badges, true);
    for (let i = 0; i < lv.kind.length; i++) {
      if ((lv.kind[i] === 'floor' || lv.kind[i] === 'secret') && !lv.block[i]) check(br.cell[i], lv.name + ': floor ' + at(i) + ' is reached');
    }
    for (const d of lv.doors) {
      const sides = d.axis === 'x' ? [d.cell - lv.w, d.cell + lv.w] : [d.cell - 1, d.cell + 1];
      for (const c of sides) check(br.cell[c], lv.name + ': the door at ' + at(d.cell) + ' leads somewhere on its side ' + at(c));
    }
    for (const it of lv.items) check(pickable(br, it), lv.name + ': ' + it.kind + ' at ' + it.x + ',' + it.y + ' can be picked up');
    for (const c of lv.racks.concat(lv.lifts)) check(usable(lv, br, c), lv.name + ': ' + lv.kind[c] + ' at ' + at(c) + ' can be used');
    // solid decor never cuts a way: the open cells beside it (floor, doors) join up within two cells of it
    // (a 1-cell corridor or a door in front of it is cut; a corner pocket a step away is not)
    for (const d of lv.decor) {
      const c = cellOf(lv, d);
      if (!lv.block[c]) continue;
      const near = [c - 1, c + 1, c - lv.w, c + lv.w].filter((n) => (lv.kind[n] === 'floor' && !lv.block[n]) || lv.kind[n] === 'door');
      const x = c % lv.w;
      const y = Math.floor(c / lv.w);
      const local = bodyFlood(lv, br.sim, cellPoints(lv, near[0]), [Math.max(0, x - 2), Math.max(0, y - 2), x + 2, y + 2]);
      for (const n of near) check(local.cell[n], lv.name + ': the ' + d.kind + ' at ' + at(c) + ' cuts ' + at(near[0]) + ' from ' + at(n));
    }
  }
  assert.deepEqual(problems, []);
});

test('cold-aisle levels: no two open cells touch only at a corner between two solid ones (secrets shut or open)', () => {
  const problems = new Set();
  for (const lv of parsed) {
    for (const secretOpen of [false, true]) {
      const open = (i) => lv.kind[i] === 'floor' || lv.kind[i] === 'door' || (secretOpen && lv.kind[i] === 'secret');
      for (let y = 0; y < lv.h - 1; y++) {
        for (let x = 0; x < lv.w - 1; x++) {
          const a = y * lv.w + x;
          const [nw, ne, sw, se] = [a, a + 1, a + lv.w, a + lv.w + 1].map(open);
          if ((nw && se && !ne && !sw) || (ne && sw && !nw && !se)) problems.add(lv.name + ': a diagonal gap in the block at ' + x + ',' + y);
        }
      }
    }
  }
  assert.deepEqual([...problems], []);
});

test('cold-aisle levels: nine levels with the spec\'s names, each parses and registers its object', () => {
  assert.equal(LEVELS.length, 9);
  assert.deepEqual(LEVELS.map((L) => L.name), NAMES);
  assert.deepEqual(parsed.map((lv) => lv.name), NAMES);
  for (const L of LEVELS) {
    const sentences = L.briefing.split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length;
    assert.ok(sentences >= 1 && sentences <= 2, L.name + ': a briefing of one or two sentences (' + sentences + ')');
    assert.ok(L.briefing.length <= 240, L.name + ': the briefing is short');
    assert.ok(Array.isArray(L.zoneMap), L.name + ': has a zone map');
  }
});

test('cold-aisle levels: sizes grow from 24x24 to about 48x40; 1-4 racks; one lift; the boss level has the boss', () => {
  assert.equal(parsed[0].w, 24);
  assert.equal(parsed[0].h, 24);
  for (let n = 0; n < 9; n++) {
    const lv = parsed[n];
    assert.ok(lv.w >= 24 && lv.w <= 48 && lv.h >= 24 && lv.h <= 40, lv.name + ' is ' + lv.w + 'x' + lv.h);
    if (n > 0 && n < 8) assert.ok(lv.w * lv.h >= parsed[n - 1].w * parsed[n - 1].h, lv.name + ' is no smaller than the level before');
    assert.ok(lv.racks.length >= 1 && lv.racks.length <= 4, lv.name + ' racks ' + lv.racks.length);
    assert.equal(lv.lifts.length, 1, lv.name + ' has one lift');
  }
  assert.equal(parsed[0].racks.length, 1, 'level 1 teaches one rack');
  assert.equal(parsed[7].racks.length, 4, 'the NOC has four racks');
});

test('cold-aisle levels: enemy kinds keep to the spec\'s "from level" column; new kinds where the spec puts them', () => {
  for (let n = 0; n < 9; n++) {
    const kinds = new Set(parsed[n].enemies.map((e) => e.kind));
    for (const k of kinds) assert.ok(FROM_LEVEL[k] <= n + 1, parsed[n].name + ': ' + k + ' only from level ' + FROM_LEVEL[k]);
    assert.equal(parsed[n].enemies.filter((e) => e.kind === 'chiller').length, n === 8 ? 1 : 0, parsed[n].name + ' chillers');
  }
  // each kind appears first on its level, and the NOC has every ordinary kind
  for (const [k, from] of Object.entries(FROM_LEVEL)) {
    assert.ok(parsed[from - 1].enemies.some((e) => e.kind === k), k + ' appears on level ' + from);
  }
  for (const k of ['crawler', 'drone', 'turret', 'loader']) assert.ok(parsed[7].enemies.some((e) => e.kind === k), 'NOC has ' + k);
});

test('cold-aisle levels: the kit is valid and grows: the driver on level 1, the probe from 2, the degausser from 4', () => {
  let cells = 0;
  let coils = 0;
  for (let n = 0; n < 9; n++) {
    const L = LEVELS[n];
    const kit = parsed[n].kit;
    assert.deepEqual(kit, { tools: L.kit.tools, ammo: { cell: L.kit.ammo.cell, coil: L.kit.ammo.coil } }, L.name + ' kit has both ammo kinds');
    const want = n === 0 ? ['driver'] : n < 3 ? ['driver', 'probe'] : ['driver', 'probe', 'degausser'];
    assert.deepEqual(kit.tools, want, L.name + ' kit tools');
    if (n >= 1) assert.ok(kit.ammo.cell > 0, L.name + ' kit has cells');
    if (n >= 3) assert.ok(kit.ammo.coil > 0, L.name + ' kit has coils');
    assert.ok(kit.ammo.cell >= cells && kit.ammo.coil >= coils, L.name + ': the kit never shrinks');
    cells = kit.ammo.cell;
    coils = kit.ammo.coil;
  }
  // the tools are found where the spec says: the probe on level 1, the degausser on level 3
  assert.ok(parsed[0].items.some((it) => it.kind === 'probe'));
  assert.ok(parsed[2].items.some((it) => it.kind === 'degausser'));
});

test('cold-aisle levels: the grid is closed and the zone map agrees with the zones', () => {
  for (let n = 0; n < 9; n++) {
    const L = LEVELS[n];
    const lv = parsed[n];
    // nothing walkable, openable or seen-through on the edge; a flood from the start with everything open stays inside
    for (let x = 0; x < lv.w; x++) {
      for (const y of [0, lv.h - 1]) assert.ok(['wall', 'rack', 'lift'].includes(lv.kind[y * lv.w + x]), L.name + ' edge ' + x + ',' + y);
    }
    for (let y = 0; y < lv.h; y++) {
      for (const x of [0, lv.w - 1]) assert.ok(['wall', 'rack', 'lift'].includes(lv.kind[y * lv.w + x]), L.name + ' edge ' + x + ',' + y);
    }
    const all = reach(lv, new Set(['blue', 'yellow', 'red']), true);
    for (let i = 0; i < all.length; i++) {
      if (all[i]) assert.ok(i % lv.w > 0 && i % lv.w < lv.w - 1 && i >= lv.w && i < lv.w * (lv.h - 1), L.name + ' stays inside');
    }
    // every zone digit used is defined (cdaParseLevel) and every defined zone is used on a floor cell
    const used = new Set();
    for (let i = 0; i < lv.zone.length; i++) if (lv.kind[i] === 'floor' || lv.kind[i] === 'door') used.add(lv.zone[i]);
    for (let z = 1; z < lv.zones.length; z++) assert.ok(used.has(z), L.name + ': zone ' + Object.keys(L.zones).sort()[z - 1] + ' is used');
    assert.ok(lv.zones.some((z) => z.light < 3), L.name + ' has a dim or dark part');
  }
  // the dark levels: the UPS hall and the cable vault have pitch-dark floors
  for (const n of [5, 6]) assert.ok(parsed[n].zones.some((z, i) => z.light === 0 && parsed[n].zone.includes(i)), NAMES[n] + ' is pitch dark in places');
  // the flashlight reaches across a dark cabinet aisle
  assert.ok(cda.CDA_PLAYER.flashlight >= 4);
});

test('cold-aisle levels: the route exists in the order the badges allow, never through a secret wall', () => {
  const orders = [];
  for (const lv of parsed) {
    const doorKinds = new Set(lv.doors.map((d) => d.kind).filter((k) => k !== 'plain'));
    const badgeKinds = new Set(lv.items.filter((it) => /^key-/.test(it.kind)).map((it) => it.kind.slice(4)));
    assert.deepEqual([...badgeKinds].sort(), [...doorKinds].sort(), lv.name + ': a badge for every locked door, a door for every badge');
    const { seen, badges, order } = route(lv);
    assert.deepEqual([...badges].sort(), [...badgeKinds].sort(), lv.name + ': every badge is reached before its door is needed');
    for (const r of lv.racks) assert.ok(beside(lv, seen, r), lv.name + ': rack ' + (r % lv.w) + ',' + Math.floor(r / lv.w) + ' is reachable');
    for (const l of lv.lifts) assert.ok(beside(lv, seen, l), lv.name + ': the lift is reachable');
    orders.push(order.join(' '));
    // a badge is never needed to reach itself, and without any badge the lift is out of reach where there are locked doors
    if (doorKinds.size) assert.ok(!lv.lifts.some((l) => beside(lv, reach(lv, new Set(), true), l)), lv.name + ': the lift needs the badges');
  }
  assert.deepEqual(orders, ['', 'blue', '', 'yellow', '', 'red', '', 'blue yellow red', '']);
});

test('cold-aisle levels: every item, enemy and secret is reachable; each secret hides a patch; patches lie in plain sight too', () => {
  for (const lv of parsed) {
    const open = reach(lv, new Set(['blue', 'yellow', 'red']), false);
    const all = reach(lv, new Set(['blue', 'yellow', 'red']), true);
    for (const list of ['items', 'enemies']) {
      for (const t of lv[list]) assert.ok(all[cellOf(lv, t)], lv.name + ': ' + t.kind + ' at ' + t.x + ',' + t.y + ' is reachable');
    }
    let secretCells = 0;
    for (let i = 0; i < lv.kind.length; i++) {
      if (lv.kind[i] !== 'secret') continue;
      secretCells++;
      assert.ok([1, -1, lv.w, -lv.w].some((o) => open[i + o]), lv.name + ': the secret at ' + (i % lv.w) + ' can be opened from the route');
    }
    assert.equal(secretCells, lv.secrets);
    const hidden = lv.items.filter((it) => !open[cellOf(lv, it)]);
    if (lv.secrets) assert.ok(hidden.some((it) => it.kind === 'patch'), lv.name + ': a patch behind the secret');
    assert.ok(lv.items.some((it) => it.kind === 'patch' && open[cellOf(lv, it)]), lv.name + ': a patch in plain sight');
    // decor and things never stand in a door or on a wall (parse puts them on floor); solid decor never blocks the route
    for (const d of lv.decor) assert.equal(lv.kind[cellOf(lv, d)], 'floor');
  }
  assert.equal(parsed[0].secrets, 0, 'level 1 has no secret');
  assert.ok(parsed[1].secrets >= 1 && parsed[4].secrets >= 1, 'the Meet-Me Room and the Tape Vault have secrets');
});

test('cold-aisle levels: the boss arena: cover is wall cells, ammo and health lie on the floor, the lift waits for the chiller', () => {
  const lv = parsed[8];
  const z = lv.enemies.find((e) => e.kind === 'chiller');
  // a 2x2 wall block (a column) stands free in the arena: count wall cells with floor all round their block
  let columns = 0;
  for (let y = 1; y < lv.h - 2; y++) {
    for (let x = 1; x < lv.w - 2; x++) {
      const i = y * lv.w + x;
      const block = [i, i + 1, i + lv.w, i + lv.w + 1];
      if (!block.every((c) => lv.kind[c] === 'wall')) continue;
      const ring = [i - lv.w, i - lv.w + 1, i + 2 * lv.w, i + 2 * lv.w + 1, i - 1, i + lv.w - 1, i + 2, i + lv.w + 2];
      if (ring.every((c) => lv.kind[c] === 'floor')) columns++;
    }
  }
  assert.ok(columns >= 4, 'free-standing columns: ' + columns);
  const kinds = lv.items.map((it) => it.kind);
  for (const k of ['cell', 'coil', 'medkit']) assert.ok(kinds.includes(k), 'the arena has ' + k);
  const sim = cda.cdaNewSim(lv, cda.cdaLevelCarry(8, null), {}, 1);
  for (const r of sim.racks) r.state = 'clean';
  cda.cdaLiftCheck(sim);
  assert.equal(sim.liftOpen, false, 'the lift stays shut while the chiller runs');
  sim.enemies.find((e) => e.kind === 'chiller').hp = 0;
  cda.cdaLiftCheck(sim);
  assert.equal(sim.liftOpen, true);
  assert.ok(z.y < lv.h / 2, 'the chiller stands at the far side from the gallery');
});

test('cold-aisle levels: cdaLevelCarry gives the kit on a fresh start, else the better of kit and carry, field by field', () => {
  const P = cda.CDA_PLAYER;
  const kit = LEVELS[4].kit;
  assert.deepEqual(cda.cdaLevelCarry(4, null), { tools: kit.tools, ammo: kit.ammo, health: P.health, armour: 0 });
  const fresh = cda.cdaLevelCarry(4, null);
  fresh.tools.push('x');
  fresh.ammo.cell = -1;
  assert.deepEqual(cda.cdaLevelCarry(4, null).tools, kit.tools, 'a copy, not the kit itself');
  assert.equal(kit.ammo.cell, LEVELS[4].kit.ammo.cell);
  // a poorer carry is raised to the kit; health and armour are the carried ones
  const poor = { tools: ['driver', 'probe'], ammo: { cell: 1, coil: 0 }, health: 30, armour: 20 };
  const frozen = JSON.stringify(poor);
  assert.deepEqual(cda.cdaLevelCarry(4, poor), {
    tools: ['driver', 'probe', 'degausser'], ammo: { cell: kit.ammo.cell, coil: kit.ammo.coil }, health: 30, armour: 20
  });
  assert.equal(JSON.stringify(poor), frozen, 'the carry is not changed');
  // a richer carry keeps its own order (the last tool got stays in hand) and its ammo
  const rich = { tools: ['driver', 'degausser', 'probe'], ammo: { cell: 110, coil: 29 }, health: 140, armour: 75 };
  assert.deepEqual(cda.cdaLevelCarry(4, rich), rich);
  assert.notEqual(cda.cdaLevelCarry(4, rich).tools, rich.tools);
  // level 1's kit is the driver alone: a carry from nowhere is the episode's start
  assert.deepEqual(cda.cdaLevelCarry(0, null), cda.cdaCarryNew());
  // and the sim takes it: health raised to the entry minimum, tools in hand
  const sim = cda.cdaNewSim(parsed[4], cda.cdaLevelCarry(4, { tools: ['driver'], ammo: { cell: 0, coil: 0 }, health: 1, armour: 0 }), {}, 1);
  assert.equal(sim.player.health, P.entryHealth);
  assert.equal(sim.player.tool, 'degausser');
  assert.deepEqual(sim.player.ammo, kit.ammo);
});

test('cold-aisle levels: cdaLevelCarry reads the parsed kit: a level without a kit or with a partial one gets the defaults', () => {
  const box = { name: 'Box', briefing: '.', facing: 'E', map: ['####', '#@.#', '####'] };
  const keep = LEVELS[0];
  try {
    LEVELS[0] = box;
    assert.deepEqual(cda.cdaLevelCarry(0, null), cda.cdaCarryNew(), 'no kit: the driver alone, no ammo');
    const carry = { tools: ['driver'], ammo: { cell: 0, coil: 0 }, health: 60, armour: 5 };
    assert.deepEqual(cda.cdaLevelCarry(0, carry), carry);
    LEVELS[0] = Object.assign({}, box, { kit: { tools: ['driver', 'probe'], ammo: { cell: 12 } } });
    assert.deepEqual(cda.cdaLevelCarry(0, null).ammo, { cell: 12, coil: 0 }, 'a missing ammo kind is 0, not NaN');
    assert.deepEqual(cda.cdaLevelCarry(0, carry).ammo, { cell: 12, coil: 0 });
    LEVELS[0] = Object.assign({}, box, { kit: { tools: ['driver', 'probe'] } });
    assert.deepEqual(cda.cdaLevelCarry(0, carry), { tools: ['driver', 'probe'], ammo: { cell: 0, coil: 0 }, health: 60, armour: 5 });
  } finally {
    LEVELS[0] = keep;
  }
});
