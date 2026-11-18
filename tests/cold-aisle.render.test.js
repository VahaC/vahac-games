// tests/cold-aisle.render.test.js
// Cold Aisle's renderer: textures and the shade table, the raycaster (walls,
// fisheye correction, doors with their jambs, animated and rebooting racks,
// floor and ceiling), light (distance, zones, the flashlight, glowing
// texels), billboards (on the floor, clipped by walls per column, sorted,
// projectiles at chest height), the view (camera interpolation, the tool in
// hand, bob, switch, effects from events, flashes, the Use bar) and the
// automap.  Hashes of whole frames pin a few fixed scenes, so any change in
// the picture is noticed: when a change is meant, look at the frames
// (.claude/cold-aisle/shot.js) and update the pins.  Test scenes are small
// maps written here; numbers come from the tables.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadScript } = require('./_setup');

const cda = loadScript('cold-aisle/script.js');
const W = cda.CDA_W;
const H = cda.CDA_H;
const S = (seconds) => cda.cdaSteps(seconds);

// ── helpers ────────────────────────────────────────────────────────────────

const ARMED = () => ({ tools: ['driver', 'probe', 'degausser'], ammo: { cell: 120, coil: 30 }, health: 100, armour: 0 });

function newSim(map, over) {
  const o = over || {};
  const lv = cda.cdaParseLevel(Object.assign({ name: 'Test', briefing: 'A test.', facing: 'E', map }, o.level));
  const sim = cda.cdaNewSim(lv, o.carry || ARMED(), {}, 1);
  sim.player.flashlight = o.flashlight === undefined ? 6 : o.flashlight;
  return sim;
}

// Puts the player at (x, y) facing a, the same before and after the last step.
function place(sim, x, y, a) {
  const p = sim.player;
  p.x = p.px = x;
  p.y = p.py = y;
  p.angle = p.pangle = a;
}

function frame(sim, alpha, view) {
  const v = view || cda.cdaNewView();
  const px = new Uint32Array(W * H);
  cda.cdaRender(v, sim, alpha === undefined ? 1 : alpha, px);
  return { px, view: v };
}

const hash = (px) => crypto.createHash('sha256').update(Buffer.from(px.buffer)).digest('hex').slice(0, 16);
const lum = (c) => (c & 255) + ((c >>> 8) & 255) + ((c >>> 16) & 255);
const at = (px, x, y) => px[y * W + x];
const red = (c) => c & 255;
const green = (c) => (c >>> 8) & 255;
const blue = (c) => (c >>> 16) & 255;

function meanLum(px, x0, y0, x1, y1) {
  let s = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += lum(at(px, x, y));
  return s / ((x1 - x0) * (y1 - y0));
}

// The pixels where two frames differ: { n, cols: Set, rows: Set }.
function diff(a, b) {
  const out = { n: 0, cols: new Set(), rows: new Set() };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    out.n++;
    out.cols.add(i % W);
    out.rows.add(Math.floor(i / W));
  }
  return out;
}

const json = (sim) => JSON.stringify(sim);
const copy = (sim) => JSON.parse(JSON.stringify(sim));

// Clears the tool in hand from a frame's statistics: rows above the hand.
const VIEW_ROWS = cda.CDA_HAND_Y;

// A long east-west corridor (three cells high), lit by `light`.
function corridor(len, light, extra) {
  const rows = ['#'.repeat(len), '#' + '.'.repeat(len - 2) + '#', '#' + '.'.repeat(len - 2) + '#', '#' + '.'.repeat(len - 2) + '#', '#'.repeat(len)];
  rows[2] = '#@' + rows[2].slice(2);
  if (extra) extra(rows);
  return newSim(rows, { level: { light } });
}

// ── textures and the shade table ───────────────────────────────────────────

test('cold-aisle render: the shade table runs from the cold fog colour (level 0) to the art\'s own colour (level 15) per tier', () => {
  const T = cda.cdaTextures();
  const fog = (0xff000000 | (cda.CDA_FOG[2] << 16) | (cda.CDA_FOG[1] << 8) | cda.CDA_FOG[0]) >>> 0;
  const top = cda.CDA_SHADES - 1;
  assert.notEqual(fog, 0xff000000, 'not pure black');
  for (const ch of Object.keys(cda.CDA_PALETTE)) {
    const i = T.index[ch];
    assert.equal(T.shade[top * 256 + i], T.pal[i], ch);
    assert.equal(T.shade[i], fog, ch + ' at level 0 is the fog');
    for (let t = 1; t < cda.CDA_TIERS; t++) {
      assert.equal(T.shade[t * 64 + i], T.shade[cda.CDA_TIER_MIN[t] * 256 + i], ch + ': tier ' + t + ' keeps its minimum');
      assert.equal(T.shade[top * 256 + t * 64 + i], T.pal[i]);
    }
    for (let l = 1; l <= top; l++) assert.ok(lum(T.shade[l * 256 + i]) >= lum(T.shade[(l - 1) * 256 + i]), ch + ' brightens with the level');
  }
  // which texels glow: lamps and screens, enemy eyes, all of an effect; enemy bodies and the lift are faint, walls plain
  const tier = (name, ch) => {
    const id = T.id[name];
    const s = cda.cdaSpritePixels(name);
    const rgb = T.pal[T.index[ch]];
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.data[y * s.w + x] === rgb) return T.atlas[T.off[id] + x * s.h + y] >> 6;
    return -1;
  };
  assert.equal(tier('ceil-light', 'w'), 1);
  assert.equal(tier('ceil-light', 'A'), 0);
  assert.equal(tier('enm-crawler-walk0', 'r'), 1);
  assert.equal(tier('enm-crawler-walk0', 'y'), 2);
  assert.equal(tier('wall-rack-infected0', 'r'), 1);
  assert.equal(tier('wall-rack-infected0', 'A'), 2);
  assert.equal(tier('wall-rack-a', 'G'), 1);
  assert.equal(tier('wall-rack-a', 'l'), 0);
  assert.equal(tier('lift-locked', 'T'), 3);
  assert.equal(tier('fx-puff0', 'n'), 1);
  assert.equal(tier('wall-concrete', 'N'), 0);
  assert.equal(tier('it-cell', 'k'), 0);
});

// ── pinned frames ──────────────────────────────────────────────────────────

function pinnedScenes() {
  const scenes = {};
  // a rack corridor: a cart, a closed door at the end and a half-open one on the side
  let sim = newSim([
    '##############',
    '#[]|[]|[]|#=##',
    '#@.....u..+.^#',
    '#H]H[H]+H|####',
    '#######.######',
    '##############'
  ], { level: { zones: { 1: { floor: 'floor-grate', ceil: 'ceil-light', light: 2 } }, zoneMap: [
    '..............', '..............', '.....111......', '..............', '..............', '..............'] } });
  sim.doors[1].open = sim.doors[1].popen = 0.5;
  scenes.corridor = sim;
  // every enemy kind, near and far, in a lit hall, one of each projectile in flight
  sim = newSim([
    '######################',
    '#....................#',
    '#@..s....d...t...l...#',
    '#..s.d.t.l.....Z.....#',
    '#....................#',
    '######################'
  ]);
  place(sim, 1.5, 2.5, 0.12);
  for (const [k, kind] of ['spark', 'bolt', 'frost'].entries()) cda.cdaSpawnShot(sim, sim.enemies[k + 1], kind, Math.PI, 6, 1);
  scenes.enemies = sim;
  // a pitch-dark hall: the flashlight, an item, a crawler and a drone beyond its reach
  sim = newSim([
    '####################',
    '#..................#',
    '#@.........s.....d.#',
    '#...c..............#',
    '#|[]|[]|[]|[]|[]|[]#',
    '####################'
  ], { level: { light: 0 } });
  place(sim, 1.5, 2.5, 0.05);
  scenes.dark = sim;
  // an infected rack, one being rebooted, a clean one, the Use bar, the probe firing
  sim = newSim([
    '##############',
    '#[]X[]K[]X[]##',
    '#............#',
    '#............#',
    '#............#',
    '#......@.....#',
    '##############'
  ], { level: { light: 2 } });
  place(sim, 8, 5.5, -Math.PI / 2);
  sim.racks[1].state = 'rebooting';
  sim.racks[1].progress = 0.6;
  sim.reboot = 1;
  sim.tick = cda.CDA_TEX_FLIP;
  sim.player.tool = 'probe';
  sim.player.fireT = 0;
  scenes.infected = sim;
  return scenes;
}

const PINS = {
  corridor: '1dfd548be790b5f1',
  enemies: '287f6875881acb15',
  dark: 'c9f78b18e587e85e',
  infected: 'd7b615bfa5025d81',
  map: '1316409bfaa85fc8'
};

test('cold-aisle render: whole frames of fixed scenes are pinned (look at them with shot.js before updating a pin)', () => {
  const got = {};
  const scenes = pinnedScenes();
  for (const name of Object.keys(scenes)) got[name] = hash(frame(scenes[name]).px);
  const sim = pinnedScenes().corridor;
  for (let i = 0; i < 40; i++) cda.cdaStep(sim, Object.assign(cda.cdaInputNew(), { turn: 0.02 }));
  const f = frame(sim);
  cda.cdaRenderMap(f.view, sim, f.px);
  got.map = hash(f.px);
  assert.deepEqual(got, PINS);
});

// ── walls ──────────────────────────────────────────────────────────────────

test('cold-aisle render: a nearer wall is taller, and a flat wall seen head-on has level edges (no fisheye)', () => {
  const sim = corridor(12, 3);
  const heights = [];
  for (const x of [8.5, 5.5, 2.5]) {
    place(sim, x, 2.5, 0);
    const { view } = frame(sim);
    const top = Array.from(view.wallTop);
    const bot = Array.from(view.wallBot);
    // facing the end wall straight on: every column of it starts and ends on the same row
    const cols = [];
    for (let c = 0; c < W; c++) if (Math.abs(view.zbuf[c] - (11 - x)) < 1e-9) cols.push(c);
    assert.ok(cols.length > 20, 'the end wall fills many columns: ' + cols.length);
    assert.equal(new Set(cols.map((c) => top[c])).size, 1, 'the top edge is level');
    assert.equal(new Set(cols.map((c) => bot[c])).size, 1, 'the bottom edge is level');
    assert.ok(Math.abs(top[160] + bot[160] - H) <= 1, 'the camera is at half the wall height');
    heights.push(bot[160] - top[160]);
  }
  assert.ok(heights[0] > heights[1] && heights[1] > heights[2], heights.join(' > '));
  // the height is the projection of one cell: CDA_PROJ / distance
  assert.ok(Math.abs(heights[0] - cda.CDA_PROJ / 2.5) <= 1, heights[0] + ' vs ' + cda.CDA_PROJ / 2.5);
  // the side walls get lower toward the far end, symmetrically
  place(sim, 1.5, 2.5, 0);
  const { view } = frame(sim);
  assert.ok(view.wallBot[0] - view.wallTop[0] > view.wallBot[100] - view.wallTop[100]);
  assert.equal(view.wallBot[20] - view.wallTop[20], view.wallBot[W - 21] - view.wallTop[W - 21]);
});

test('cold-aisle render: one wall axis is darker than the other', () => {
  const sim = newSim(['#####', '#...#', '#.@.#', '#...#', '#####']);
  place(sim, 2.5, 2.5, Math.PI / 4);
  const { px, view } = frame(sim);
  // looking into the south-east corner: the east wall (x faces) left of the corner, the south wall (y faces) right of it
  const corner = Array.from(view.zbuf).indexOf(Math.max(...view.zbuf));
  const y = H / 2;
  assert.ok(lum(at(px, corner - 30, y)) > 0);
  const east = meanLum(px, corner - 40, y - 10, corner - 20, y + 10);
  const south = meanLum(px, corner + 20, y - 10, corner + 40, y + 10);
  assert.ok(east > south, east + ' > ' + south);
});

// ── doors ──────────────────────────────────────────────────────────────────

// A corridor with a door at x 5 (jambs north and south: a thin wall along y),
// an infected rack (red) at the far end.
function doorScene(open) {
  const sim = newSim(['##########', '##########', '#@...+..X#', '##########', '##########']);
  sim.doors[0].open = sim.doors[0].popen = open;
  place(sim, 1.5, 2.5, 0);
  return sim;
}

test('cold-aisle render: a closed door hides what is behind it, an open one shows it, a half-open one shows it on the open side', () => {
  assert.equal(doorScene(0).doors[0].axis, 'y');
  const closed = frame(doorScene(0));
  const open = frame(doorScene(1));
  const half = frame(doorScene(0.5));
  // the door's line is the cell's middle: 5.5 - 1.5 = 4 cells away
  assert.ok(Math.abs(closed.view.zbuf[160] - 4) < 1e-9, String(closed.view.zbuf[160]));
  assert.ok(Math.abs(open.view.zbuf[160] - 6.5) < 1e-9, 'open: the rack at x 8: ' + open.view.zbuf[160]);
  const reds = (f) => {
    let n = 0;
    for (let x = 140; x < 180; x++) for (let y = 70; y < 110; y++) if (red(at(f.px, x, y)) > 2 * green(at(f.px, x, y)) + 40) n++;
    return n;
  };
  assert.equal(reds(closed), 0, 'the red rack is hidden');
  assert.ok(reds(open) > 100, 'the red rack shows: ' + reds(open));
  // half open: the slab covers y 2.5 .. 3 of its line (the high side), so the left half of the doorway (north) is open
  // and shows the rack, the right half (south) is the slab
  const zl = half.view.zbuf[150];
  const zr = half.view.zbuf[170];
  assert.ok(Math.abs(zl - 6.5) < 1e-9 && Math.abs(zr - 4) < 1e-9, zl + ' ' + zr);
  // the door slides: its texture moves with it
  const column = (f, x) => Array.from({ length: 40 }, (_, k) => at(f.px, x, H / 2 - 20 + k)).join();
  assert.ok([164, 166, 168, 170, 172].some((x) => column(closed, x) !== column(half, x)));
});

test('cold-aisle render: a door across x sits on its own axis, and the faces of the doorway are door jambs', () => {
  // a north-south way through a door with jambs west and east (axis x: a thin wall along x at y + 0.5)
  const map = ['#######', '#..@..#', '###+###', '#.....#', '#######'];
  const sim = newSim(map);
  assert.equal(sim.doors[0].axis, 'x');
  place(sim, 3.5, 1.5, Math.PI / 2);
  const { view } = frame(sim);
  assert.ok(Math.abs(view.zbuf[160] - 1) < 1e-9, 'the door is 1 cell away (y 2.5): ' + view.zbuf[160]);
  sim.doors[0].open = sim.doors[0].popen = 1;
  assert.ok(Math.abs(frame(sim).view.zbuf[160] - 2.5) < 1e-9, 'open: the far wall');
  // standing in the open doorway facing the east jamb: it is drawn with door-jamb whatever the wall is
  place(sim, 3.5, 2.5, 0);
  const jamb = frame(sim);
  assert.ok(Math.abs(jamb.view.zbuf[160] - 0.5) < 1e-9);
  const other = newSim(['#######', '#..@..#', '###+%%#', '#.....#', '#######']);
  other.doors[0].open = other.doors[0].popen = 1;
  place(other, 3.5, 2.5, 0);
  const jamb2 = frame(other);
  for (let y = 0; y < VIEW_ROWS; y++) assert.equal(at(jamb2.px, 160, y), at(jamb.px, 160, y), 'row ' + y);
  // ... while the same wall seen from the open floor changes with its texture
  place(sim, 1.5, 3.5, -0.3);
  place(other, 1.5, 3.5, -0.3);
  assert.ok(diff(frame(sim).px, frame(other).px).n > 0);
});

test('cold-aisle render: the slab of a door the camera stands in (walking through it) is drawn', () => {
  // the door at x 5 (axis y: its line x 5.5, the slab covering y 2 + open .. 3)
  const sim = doorScene(0.5);
  place(sim, 5.2, 2.6, 0);
  const inside = frame(sim);
  assert.ok(Math.abs(inside.view.zbuf[160] - 0.3) < 1e-6, 'the slab 0.3 ahead: ' + inside.view.zbuf[160]);
  assert.ok(inside.view.zbuf[0] > 0.5, 'the open part of the doorway shows what is behind it: ' + inside.view.zbuf[0]);
  // past the door's line, or with the slab slid away, nothing of it is drawn
  place(sim, 5.7, 2.6, 0);
  assert.ok(Math.abs(frame(sim).view.zbuf[160] - 2.3) < 1e-6, 'the rack at x 8: ' + frame(sim).view.zbuf[160]);
  place(sim, 5.2, 2.6, 0);
  sim.doors[0].open = sim.doors[0].popen = 1;
  assert.ok(Math.abs(frame(sim).view.zbuf[160] - 2.8) < 1e-6);
  // a door across x stood in, facing along its way
  const across = newSim(['#######', '#..@..#', '###+###', '#.....#', '#######']);
  across.doors[0].open = across.doors[0].popen = 0.4;
  place(across, 3.8, 2.3, Math.PI / 2);
  assert.ok(Math.abs(frame(across).view.zbuf[160] - 0.2) < 1e-6, String(frame(across).view.zbuf[160]));
});

// ── light ──────────────────────────────────────────────────────────────────

test('cold-aisle render: far is darker than near, a dark zone is darker than a lit one, a longer flashlight lights further', () => {
  for (let L = 1; L <= 3; L++) assert.ok(cda.cdaLight(L, 1, 0) > cda.cdaLight(L, 12, 0), 'zone ' + L);
  // a wall near and far in a lit corridor
  const sim = corridor(24, 3);
  place(sim, 20.5, 2.5, 0);
  const near = meanLum(frame(sim).px, 150, 70, 170, 100);
  place(sim, 1.5, 2.5, 0);
  const far = meanLum(frame(sim).px, 155, 85, 165, 95);
  assert.ok(near > far * 1.5, near + ' > ' + far);
  // the same hall, lit and dark (no flashlight): the dark one shows (almost) nothing
  const lit = corridor(12, 3);
  const dark = corridor(12, 0);
  lit.player.flashlight = dark.player.flashlight = 0.01;
  const litLum = meanLum(frame(lit).px, 0, 0, W, VIEW_ROWS);
  const darkLum = meanLum(frame(dark).px, 0, 0, W, VIEW_ROWS);
  const fogLum = cda.CDA_FOG[0] + cda.CDA_FOG[1] + cda.CDA_FOG[2];
  assert.ok(litLum > darkLum * 3, litLum + ' > ' + darkLum);
  assert.ok(darkLum < fogLum + 4, 'pitch dark is about the fog: ' + darkLum);
  // zones 1 and 2 lie between
  const mid = [1, 2].map((L) => {
    const s = corridor(12, L);
    s.player.flashlight = 0.01;
    return meanLum(frame(s).px, 0, 0, W, VIEW_ROWS);
  });
  assert.ok(darkLum < mid[0] && mid[0] < mid[1] && mid[1] < litLum, [darkLum, mid, litLum].join(' '));
  // a wall 7 cells away in the dark: a 6-cell flashlight leaves it dark, an 8-cell one reaches it
  const d6 = corridor(12, 0);
  place(d6, 4.5, 2.5, 0);
  const d8 = copy(d6);
  d8.player.flashlight = 8;
  const at6 = meanLum(frame(d6).px, 150, 80, 170, 100);
  const at8 = meanLum(frame(d8).px, 150, 80, 170, 100);
  assert.ok(at8 > at6 + 20, at8 + ' > ' + at6);
  // the light table follows the flashlight when it changes on the same view
  const view = cda.cdaNewView();
  frame(d6, 1, view);
  assert.equal(view.flashFor, 6);
  frame(d8, 1, view);
  assert.equal(view.flashFor, 8);
});

test('cold-aisle render: an enemy within its sight range is never invisible in a pitch-dark zone (its body is faint, its eyes glow)', () => {
  for (const e of cda.CDA_ENEMIES) {
    // as far as the corridor allows, within its sight, beyond the flashlight
    const d = Math.min(e.sight - 0.5, 14);
    const len = Math.ceil(d) + 5;
    const make = (withEnemy) => {
      const sim = corridor(len, 0);
      sim.player.flashlight = 2;
      if (withEnemy) cda.cdaNewEnemy(sim, e.id, 1.5 + d, 2.5, false);
      place(sim, 1.5, 2.5, 0);
      return sim;
    };
    const a = frame(make(false)).px;
    const b = frame(make(true)).px;
    let bright = 0;
    for (let i = 0; i < a.length; i++) if (lum(b[i]) > lum(a[i]) + 30) bright++;
    assert.ok(bright >= 2, e.id + ' at ' + d + ' cells: ' + bright + ' pixels stand out');
  }
});

test('cold-aisle render: animated walls flip with the tick; a rack being rebooted fills with the clean texture from the bottom up', () => {
  const make = () => {
    const sim = newSim(['#####', '#.@.#', '#...#', '#TXK#', '#####']);
    place(sim, 2.5, 1.5, Math.PI / 2);
    return sim;
  };
  const a = make();
  const b = make();
  b.tick = cda.CDA_TEX_FLIP;
  const c = make();
  c.tick = 2 * cda.CDA_TEX_FLIP;
  const fa = frame(a).px;
  assert.ok(diff(fa, frame(b).px).n > 50, 'the terminal and the infected rack change frame');
  assert.equal(diff(fa, frame(c).px).n, 0, 'and come back');
  // rebooting: progress 0 is the infected rack, 1 is the clean one, between them the clean one rises
  const reboot = (progress) => {
    const s = make();
    s.racks[0].state = 'rebooting';
    s.racks[0].progress = progress;
    return frame(s).px;
  };
  assert.equal(diff(reboot(0), fa).n, 0);
  const clean = make();
  clean.map.tex[clean.racks[0].cell] = cda.CDA_TEX_RACK_CLEAN;
  clean.racks[0].state = 'clean';
  const fc = frame(clean).px;
  assert.equal(diff(reboot(1), fc).n, 0);
  const half = diff(reboot(0.5), fa);
  const rows = [...half.rows];
  assert.ok(half.n > 0 && Math.min(...rows) > H / 2 - 20, 'only the lower part changed: from row ' + Math.min(...rows));
  // an opened secret just vanishes
  const sec = newSim(['#####', '#.@.#', '#...#', '#.$.#', '#...#', '#####']);
  place(sec, 2.5, 1.5, Math.PI / 2);
  const before = frame(sec).view.zbuf[160];
  sec.map.kind[sec.map.w * 3 + 2] = 'floor';
  sec.map.tex[sec.map.w * 3 + 2] = '';
  assert.ok(frame(sec).view.zbuf[160] > before + 1);
});

// ── sprites ────────────────────────────────────────────────────────────────

test('cold-aisle render: a sprite stands on the floor; projectiles fly at chest height; a sprite behind a wall is not drawn', () => {
  const make = (fn) => {
    const sim = corridor(12, 3);
    place(sim, 1.5, 2.5, 0);
    if (fn) fn(sim);
    return frame(sim);
  };
  const empty = make().px;
  const crawler = diff(empty, make((s) => cda.cdaNewEnemy(s, 'crawler', 5.5, 2.5, false)).px);
  const depth = 4;
  const floorY = H / 2 + 0.5 * cda.CDA_PROJ / depth;
  assert.ok(Math.abs(Math.max(...crawler.rows) + 1 - floorY) <= 1, 'the bottom row on the floor line: ' + Math.max(...crawler.rows) + ' vs ' + floorY);
  // centred on its position, one cell wide
  const cols = [...crawler.cols];
  assert.ok(Math.abs((Math.min(...cols) + Math.max(...cols) + 1) / 2 - W / 2) <= 2);
  assert.ok(Math.max(...cols) - Math.min(...cols) + 1 <= cda.CDA_PROJ / depth + 1);
  // an item is half as wide and sits on the floor too
  const item = diff(empty, make((s) => s.items.push({ id: 9, kind: 'medkit', x: 5.5, y: 2.5, taken: false })).px);
  assert.ok(Math.abs(Math.max(...item.rows) + 1 - floorY) <= 1);
  assert.ok(Math.max(...item.cols) - Math.min(...item.cols) + 1 <= cda.CDA_PROJ / depth / 2 + 1);
  // a taken item is not drawn
  assert.equal(diff(empty, make((s) => s.items.push({ id: 9, kind: 'medkit', x: 5.5, y: 2.5, taken: true })).px).n, 0);
  // the pillar (64 high) fills floor to ceiling
  const pillar = diff(empty, make((s) => s.decor.push({ kind: 'pillar', x: 5.5, y: 2.5, solid: true, radius: 0.4 })).px);
  assert.ok(Math.abs(Math.min(...pillar.rows) - (H / 2 - 0.5 * cda.CDA_PROJ / depth)) <= 1.5, 'its top at the ceiling: ' + Math.min(...pillar.rows));
  // a projectile's centre is at chest height
  const bolt = (s) => s.shots.push({ id: 99, kind: 'bolt', owner: 0, x: 5.5, y: 2.5, px: 5.5, py: 2.5, dx: 1, dy: 0, speed: 0, damage: 0 });
  const shot = diff(empty, make(bolt).px);
  const chest = H / 2 + (0.5 - cda.CDA_SHOT_Z) * cda.CDA_PROJ / depth;
  const mid = (Math.min(...shot.rows) + Math.max(...shot.rows) + 1) / 2;
  assert.ok(shot.n > 0 && Math.abs(mid - chest) <= 1.5, 'bolt centre ' + mid + ' vs chest ' + chest);
  // behind the end wall (x 11) nothing shows; behind the camera neither
  assert.equal(diff(empty, make((s) => cda.cdaNewEnemy(s, 'crawler', 13, 2.5, false)).px).n, 0);
  assert.equal(diff(empty, make((s) => cda.cdaNewEnemy(s, 'crawler', 0.9, 2.5, false)).px).n, 0);
});

test('cold-aisle render: a sprite is drawn as tall as its table row says (tall cells for the whole frame), its width by the frame\'s aspect', () => {
  const depth = 3;
  const cell = cda.CDA_PROJ / depth;
  const make = (fn) => {
    const sim = corridor(12, 3);
    place(sim, 1.5, 2.5, 0);
    if (fn) fn(sim);
    return frame(sim).px;
  };
  const empty = make();
  // the rows and columns the sprite's opaque texels span, as cells at this depth
  const box = (name) => {
    const s = cda.cdaSpritePixels(name);
    let y0 = s.h;
    let y1 = -1;
    let x0 = s.w;
    let x1 = -1;
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        if (!s.data[y * s.w + x]) continue;
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
      }
    }
    return { rows: (y1 - y0 + 1) / s.h, cols: (x1 - x0 + 1) / s.h, aspect: s.w / s.h };
  };
  const drawn = (fn) => {
    const d = diff(empty, make(fn));
    return { h: Math.max(...d.rows) - Math.min(...d.rows) + 1, w: Math.max(...d.cols) - Math.min(...d.cols) + 1, bottom: Math.max(...d.rows) + 1 };
  };
  const floorY = H / 2 + 0.5 * cell;
  const heights = {};
  for (const row of cda.CDA_DECOR) {
    const b = box('dc-' + row.id);
    const got = drawn((s) => s.decor.push({ kind: row.id, x: 1.5 + depth, y: 2.5, solid: false, radius: 0 }));
    heights[row.id] = got.h;
    assert.ok(Math.abs(got.h - b.rows * row.tall * cell) <= 2, row.id + ' is ' + got.h + ' px, its row says ' + (b.rows * row.tall * cell));
    assert.ok(Math.abs(got.w - b.cols * row.tall * cell) <= 2, row.id + ' is ' + got.w + ' px wide');
    assert.ok(Math.abs(got.bottom - floorY) <= 1, row.id + ' stands on the floor');
  }
  assert.ok(heights.crate / heights.pillar > 0.35 && heights.crate / heights.pillar < 0.65, 'a crate is about half as tall as a pillar: ' + heights.crate + ' / ' + heights.pillar);
  assert.ok(heights.cone < heights.crate && heights.ladder > heights.lamp);
  for (const row of cda.CDA_ITEMS) {
    const b = box('it-' + row.id);
    const got = drawn((s) => s.items.push({ id: 9, kind: row.id, x: 1.5 + depth, y: 2.5, taken: false }));
    assert.ok(Math.abs(got.h - b.rows * row.tall * cell) <= 2, row.id + ' is ' + got.h + ' px');
  }
  for (const row of cda.CDA_ENEMIES) {
    const b = box(cda.CDA_FRAME_PREFIX[row.id] + cda.CDA_FRAMES[row.id].asleep[0]);
    const got = drawn((s) => cda.cdaNewEnemy(s, row.id, 1.5 + depth, 2.5, false));
    assert.ok(Math.abs(got.h - b.rows * row.tall * cell) <= 2, row.id + ' is ' + got.h + ' px');
    assert.ok(Math.abs(got.w - b.cols * row.tall * cell) <= 2, row.id + ' is ' + got.w + ' px wide');
  }
  // the chiller: one cell tall and one cell wide, its body the circle that fits
  assert.equal(cda.CDA_ENEMY.chiller.tall, 1);
  assert.equal(cda.CDA_ENEMY.chiller.radius * 2, cda.CDA_ENEMY.chiller.tall);
  // a projectile is as tall as its row, centred at chest height
  for (const row of cda.CDA_SHOTS) {
    const b = box('fx-' + row.id + '0');
    const got = drawn((s) => s.shots.push({ id: 99, kind: row.id, owner: 0, x: 1.5 + depth, y: 2.5, px: 1.5 + depth, py: 2.5, dx: 1, dy: 0, speed: 0, damage: 0 }));
    assert.ok(Math.abs(got.h - b.rows * row.tall * cell) <= 2, row.id + ' is ' + got.h + ' px');
  }
});

test('cold-aisle render: a sprite half behind a corner is clipped column by column', () => {
  // the camera looks east along y 1.5; a wall block at x 4..5, y 2 hides the lower right of the view
  const make = (withEnemy) => {
    const sim = newSim(['##########', '#........#', '#@.......#', '#....#...#', '#........#', '##########']);
    place(sim, 1.5, 2.5, 0);
    if (withEnemy) cda.cdaNewEnemy(sim, 'loader', 7.5, 3.5, false);
    return frame(sim);
  };
  const a = make(false);
  const b = make(true);
  const d = diff(a.px, b.px);
  assert.ok(d.n > 0, 'part of it shows');
  const v = b.view;
  const n = Array.from(v.sTex.slice(0, v.count)).findIndex((id) => /^enm-loader/.test(v.tex.names[id]));
  const depth = v.sDepth[n];
  const half = cda.CDA_PROJ / depth / 2;
  let drawn = 0;
  let clipped = 0;
  for (let x = Math.ceil(v.sScreen[n] - half); x < v.sScreen[n] + half - 1; x++) {
    if (v.zbuf[x] > depth) drawn++;
    else clipped++;
  }
  for (const x of d.cols) assert.ok(v.zbuf[x] > depth, 'drawn only where nearer than the wall: ' + x);
  assert.ok(drawn > 3 && clipped > 3, 'its span is partly behind the corner: ' + drawn + ' / ' + clipped);
});

test('cold-aisle render: billboards are drawn far to near, and the list never passes CDA_SPRITE_MAX', () => {
  const sim = corridor(12, 3);
  place(sim, 1.5, 2.5, 0);
  cda.cdaNewEnemy(sim, 'crawler', 6.5, 3.1, false);
  cda.cdaNewEnemy(sim, 'loader', 4.5, 2.5, false);
  const both = frame(sim);
  const loaderOnly = corridor(12, 3);
  place(loaderOnly, 1.5, 2.5, 0);
  cda.cdaNewEnemy(loaderOnly, 'loader', 4.5, 2.5, false);
  // the nearer loader covers the crawler where they overlap: the same frame as the loader alone there
  const lo = frame(loaderOnly);
  const d = diff(both.px, lo.px);
  for (const i of [H / 2 * W + 160]) assert.equal(both.px[i], lo.px[i]);
  assert.ok(d.n > 0, 'the crawler shows around the loader');
  // the list is listed in any order and sorted
  const order = Array.from(both.view.order.slice(0, both.view.count)).map((i) => both.view.sDepth[i]);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] >= order[i]);
  // a level crowded with decor still renders, with at most CDA_SPRITE_MAX billboards
  const crowd = corridor(12, 3);
  place(crowd, 1.5, 2.5, 0);
  for (let i = 0; i < cda.CDA_SPRITE_MAX + 50; i++) crowd.decor.push({ kind: 'cone', x: 3 + (i % 80) / 10, y: 2.5, solid: false, radius: 0 });
  assert.equal(frame(crowd).view.count, cda.CDA_SPRITE_MAX);
});

test('cold-aisle render: the frame an enemy shows follows its state (the table in the sim-enemies header)', () => {
  const view = cda.cdaNewView();
  const T = view.tex;
  const name = (e) => T.names[cda.cdaEnemyFrame(view, e)];
  const W2 = cda.CDA_ANIM_WALK;
  const die = S(cda.CDA_DIE_TIME);
  const e = (kind, state, t, flash) => ({ kind, state, t: t || 0, flash: flash || 0 });
  assert.equal(name(e('crawler', 'asleep')), 'enm-crawler-walk0');
  assert.equal(name(e('crawler', 'chase', W2)), 'enm-crawler-walk1');
  assert.equal(name(e('crawler', 'chase', 2 * W2)), 'enm-crawler-walk0');
  assert.equal(name(e('drone', 'windup')), 'enm-drone-atk0');
  assert.equal(name(e('drone', 'attack')), 'enm-drone-atk1');
  assert.equal(name(e('turret', 'chase', W2)), 'enm-turret-idle');
  assert.equal(name(e('turret', 'windup')), 'enm-turret-aim');
  assert.equal(name(e('turret', 'attack')), 'enm-turret-atk0');
  assert.equal(name(e('loader', 'windup')), 'enm-loader-tell');
  assert.equal(name(e('loader', 'attack', W2)), 'enm-loader-walk1');
  assert.equal(name(e('loader', 'stun')), 'enm-loader-hurt');
  assert.equal(name(e('crawler', 'hurt')), 'enm-crawler-hurt');
  assert.equal(name(e('crawler', 'die', Math.ceil(die / 2) - 1)), 'enm-crawler-die0');
  assert.equal(name(e('crawler', 'die', Math.ceil(die / 2))), 'enm-crawler-die1');
  assert.equal(name(e('crawler', 'dead', 999)), 'enm-crawler-dead');
  assert.equal(name(e('chiller', 'idle', W2)), 'boss-chiller-idle1');
  assert.equal(name(e('chiller', 'call')), 'boss-chiller-idle0');
  assert.equal(name(e('chiller', 'vent', W2)), 'boss-chiller-vent1');
  assert.equal(name(e('chiller', 'vent', 0, 3)), 'boss-chiller-hurt');
  assert.equal(name(e('chiller', 'die', 0, 3)), 'boss-chiller-die0');
  assert.equal(name(e('chiller', 'die', Math.ceil(die / 3))), 'boss-chiller-die1');
  assert.equal(name(e('chiller', 'die', die - 1)), 'boss-chiller-die2');
  assert.equal(name(e('chiller', 'dead', 0, 3)), 'boss-chiller-dead', 'a corpse never flashes');
});

// ── the view: camera, hand, effects, flashes ───────────────────────────────

test('cold-aisle render: the camera, enemies, projectiles and doors interpolate; alpha 0 and 1 are the previous and the current state', () => {
  const sim = newSim(['##########', '#@.......#', '#...s....#', '#........#', '##########']);
  const door = newSim(['##########', '#@....+..#', '##########']);
  for (const s of [sim, door]) {
    cda.cdaSpawnShot(s, s.enemies[0] || cda.cdaNewEnemy(s, 'turret', 4.5, 1.5, false), 'spark', 0.3, 6, 1);
    const p = s.player;
    p.px = 1.5; p.x = 2.0; p.py = 1.5; p.y = 1.75; p.pangle = 0.125; p.angle = 0.375;
    for (const e of s.enemies) { e.px = e.x; e.x += 0.5; }
    for (const sh of s.shots) { sh.px = sh.x; sh.py = sh.y; sh.x += 0.5; sh.y += 0.25; }
    for (const d of s.doors) { d.popen = 0.25; d.open = 0.75; }
    const before = copy(s);
    before.player.x = before.player.px; before.player.y = before.player.py; before.player.angle = before.player.pangle;
    for (const e of before.enemies) e.x = e.px;
    for (const sh of before.shots) { sh.x = sh.px; sh.y = sh.py; }
    for (const d of before.doors) d.open = d.popen;
    const after = copy(s);
    after.player.px = after.player.x; after.player.py = after.player.y; after.player.pangle = after.player.angle;
    for (const e of after.enemies) e.px = e.x;
    for (const sh of after.shots) { sh.px = sh.x; sh.py = sh.y; }
    for (const d of after.doors) d.popen = d.open;
    assert.equal(hash(frame(s, 0).px), hash(frame(before, 0.5).px), 'alpha 0 is the step before');
    assert.equal(hash(frame(s, 1).px), hash(frame(after, 0.5).px), 'alpha 1 is the last step');
    const mid = hash(frame(s, 0.5).px);
    assert.notEqual(mid, hash(frame(before).px));
    assert.notEqual(mid, hash(frame(after).px));
  }
});

test('cold-aisle render: cdaRender and cdaRenderMap leave the sim unchanged and allocate their buffers only once', () => {
  const sim = pinnedScenes().enemies;
  for (let i = 0; i < 30; i++) cda.cdaStep(sim, Object.assign(cda.cdaInputNew(), { fire: true, move: 0.5, turn: 0.01 }));
  const view = cda.cdaNewView();
  for (let i = 0; i < 30; i++) cda.cdaViewStep(view, sim);
  const before = json(sim);
  const buffers = [view.zbuf, view.cellKind, view.order, view.sDepth, view.lightTab];
  const px = new Uint32Array(W * H);
  cda.cdaRender(view, sim, 0.3, px);
  cda.cdaRenderMap(view, sim, px);
  cda.cdaRender(view, sim, 0.7, px);
  cda.cdaRenderMap(view, sim, px);
  assert.equal(json(sim), before);
  assert.deepEqual([view.zbuf, view.cellKind, view.order, view.sDepth, view.lightTab], buffers);
  // every pixel is opaque
  for (let i = 0; i < px.length; i++) assert.equal(px[i] >>> 24, 255);
});

test('cold-aisle render: the tool in hand shows its idle frame, then the attack frames CDA_HAND picks from fireT', () => {
  const sim = corridor(12, 3);
  const view = cda.cdaNewView();
  const T = view.tex;
  for (const tool of cda.CDA_TOOLS) {
    sim.player.tool = view.tool = tool.id;
    const cd = sim.tools[tool.id].cooldown;
    sim.player.fireT = 10 * cd;
    assert.equal(T.names[cda.cdaHandFrame(view, sim)], 'vw-' + tool.id + '-idle');
    let lo = 0;
    for (const [f, limit] of cda.CDA_HAND[tool.id]) {
      for (const share of [lo, (lo + limit) / 2]) {
        sim.player.fireT = Math.ceil(share * cd);
        if (sim.player.fireT / cd >= limit) continue;
        assert.equal(T.names[cda.cdaHandFrame(view, sim)], 'vw-' + tool.id + '-' + f, tool.id + ' at ' + sim.player.fireT);
      }
      lo = limit;
    }
    sim.player.fireT = 0;
    const firing = frame(sim, 1, view).px;
    sim.player.fireT = 10 * cd;
    const idle = frame(sim, 1, view).px;
    const d = diff(firing, idle);
    assert.ok(d.n > 0 && Math.min(...d.rows) >= cda.CDA_HAND_Y - 40, tool.id + ': only the hand changes');
  }
});

test('cold-aisle render: a switch lowers the old tool and raises the new one; walking bobs the hand', () => {
  const sim = corridor(12, 3, (rows) => { rows[2] = rows[2].slice(0, 3) + 'P' + rows[2].slice(4); });
  const view = cda.cdaNewView();
  sim.player.tools = ['driver'];
  sim.player.tool = 'driver';
  const total = S(cda.CDA_PLAYER.switchTime);
  // walk east onto the probe: it is picked up and switched to
  const walk = Object.assign(cda.cdaInputNew(), { move: 1 });
  let switched = false;
  for (let i = 0; i < 120 && !switched; i++) {
    cda.cdaStep(sim, walk);
    cda.cdaViewStep(view, sim);
    switched = sim.events.some((e) => e.type === 'switch');
  }
  assert.ok(switched);
  assert.equal(view.prevTool, 'driver');
  assert.equal(view.tool, 'probe');
  const names = [];
  const drops = [];
  for (let i = 0; i <= total; i++) {
    names.push(view.tex.names[cda.cdaHandFrame(view, sim)]);
    drops.push(view.handDrop);
    cda.cdaStep(sim, cda.cdaInputNew());
    cda.cdaViewStep(view, sim);
  }
  assert.equal(names[0], 'vw-driver-idle', 'the old tool first');
  assert.equal(names[names.length - 1], 'vw-probe-idle', 'then the new one');
  const peak = drops.indexOf(Math.max(...drops));
  assert.ok(drops[0] < 5 && drops[peak] > 60 && drops[drops.length - 1] === 0, drops.join(','));
  // the bob: walking moves the hand, standing still brings it back
  for (let i = 0; i < 60; i++) {
    cda.cdaStep(sim, Object.assign(cda.cdaInputNew(), { strafe: i % 40 < 20 ? 1 : -1 }));
    cda.cdaViewStep(view, sim);
  }
  assert.ok(view.bobAmp > 0.9);
  place(sim, 6.5, 2.5, 0);
  const moving = frame(sim, 1, view).px;
  for (let i = 0; i < 60; i++) {
    cda.cdaStep(sim, cda.cdaInputNew());
    cda.cdaViewStep(view, sim);
  }
  assert.equal(view.bobAmp, 0);
  assert.ok(diff(moving, frame(sim, 1, view).px).n > 0);
});

test('cold-aisle render: events spawn effects that play their frames and expire; the pool reuses its oldest slot', () => {
  const sim = corridor(12, 3);
  place(sim, 1.5, 2.5, 0);
  const view = cda.cdaNewView();
  const empty = frame(sim, 1, view).px;
  sim.events = [
    { type: 'wall', x: 11, y: 2.5, cell: 0 },
    { type: 'hit', id: 1, kind: 'drone', x: 6, y: 2.2, damage: 1, blocked: false },
    { type: 'die', id: 2, kind: 'crawler', x: 8, y: 2.8 },
    { type: 'shotEnd', id: 3, kind: 'bolt', x: 9, y: 2.5, hit: 'wall' },
    { type: 'shotEnd', id: 4, kind: 'bolt', x: 1.6, y: 2.5, hit: 'player' },
    { type: 'door', cell: 0, x: 0, y: 0, kind: 'plain', open: true, by: 'player' }
  ];
  cda.cdaViewStep(view, sim);
  assert.deepEqual(Array.from(view.fxKind.slice(0, 5)), [0, 1, 2, 0, -1]);
  assert.ok(view.fxX[0] < 11, 'a wall puff is pulled toward the player');
  assert.equal(view.fxZ[1], cda.CDA_HIT_Z.drone);
  assert.equal(view.fxZ[3], cda.CDA_SHOT_Z);
  sim.events = [];
  const f1 = frame(sim, 1, view);
  assert.equal(f1.view.count, 4);
  assert.ok(diff(empty, f1.px).n > 0);
  // the frames advance with age
  const ids = () => Array.from(view.sTex.slice(0, view.count)).map((i) => view.tex.names[i]).sort();
  const first = ids();
  for (let i = 0; i < S(cda.CDA_FX[0].life) - 1; i++) cda.cdaViewStep(view, sim);
  frame(sim, 1, view);
  assert.notDeepEqual(ids(), first);
  // puffs and hits expire, the boom lasts longer
  cda.cdaViewStep(view, sim);
  assert.deepEqual(Array.from(view.fxKind.slice(0, 4)), [-1, -1, 2, -1]);
  for (let i = 0; i < S(cda.CDA_FX[2].life); i++) cda.cdaViewStep(view, sim);
  assert.equal(diff(empty, frame(sim, 1, view).px).n, 0);
  // more effects than slots: the oldest go
  sim.events = [];
  for (let i = 0; i < 40; i++) sim.events.push({ type: 'hit', id: 1, kind: 'crawler', x: 4 + i / 10, y: 2.5, damage: 1, blocked: false });
  cda.cdaViewStep(view, sim);
  assert.ok(Array.from(view.fxKind).every((k) => k === 1));
  assert.ok(Math.abs(view.fxX[(view.fxNext + 31) % 32] - 7.9) < 1e-9, 'the newest is kept');
});

test('cold-aisle render: getting hurt flashes red, a pickup flashes warm, both fade; the Use bar shows the reboot progress', () => {
  const sim = newSim(['######', '#....#', '#.@..#', '#.X..#', '######']);
  place(sim, 2.5, 2.5, Math.PI / 2);
  const view = cda.cdaNewView();
  const plain = frame(sim, 1, view).px;
  sim.events = [{ type: 'hurt', damage: 5, absorbed: 0, health: 95, armour: 0, x: 0, y: 0, by: 'crawler' }];
  cda.cdaViewStep(view, sim);
  const hurt = frame(sim, 1, view).px;
  const reddish = (a, b) => red(b) - red(a) > Math.abs(blue(b) - blue(a));
  assert.ok(reddish(at(plain, 10, 10), at(hurt, 10, 10)));
  sim.events = [{ type: 'pickup', id: 0, item: 'cell', x: 0, y: 0 }];
  cda.cdaViewStep(view, sim);
  sim.events = [];
  for (let i = 0; i < S(cda.CDA_HURT_TIME); i++) cda.cdaViewStep(view, sim);
  assert.equal(view.hurt, 0);
  assert.equal(view.pick, 0);
  assert.equal(diff(plain, frame(sim, 1, view).px).n, 0, 'both faded');
  sim.events = [{ type: 'pickup', id: 0, item: 'cell', x: 0, y: 0 }];
  cda.cdaViewStep(view, sim);
  const pick = frame(sim, 1, view).px;
  assert.ok(lum(at(pick, 10, 10)) > lum(at(plain, 10, 10)));
  // the bar: a reboot under way
  sim.events = [];
  for (let i = 0; i < S(cda.CDA_PICK_TIME); i++) cda.cdaViewStep(view, sim);
  cda.cdaStep(sim, Object.assign(cda.cdaInputNew(), { use: true }));
  for (let i = 0; i < S(cda.CDA_PLAYER.reboot) / 2; i++) cda.cdaStep(sim, Object.assign(cda.cdaInputNew(), { use: true }));
  assert.equal(sim.reboot, 0);
  const T = view.tex;
  const bar = cda.CDA_BAR;
  const withBar = frame(sim, 1, view).px;
  const filled = Math.round(bar.w * sim.racks[0].progress);
  assert.ok(filled > 10 && filled < bar.w - 10);
  assert.equal(at(withBar, bar.x, bar.y), T.pal[T.index.G]);
  assert.equal(at(withBar, bar.x + filled - 1, bar.y + bar.h - 1), T.pal[T.index.G]);
  assert.equal(at(withBar, bar.x + filled, bar.y), T.pal[T.index.K]);
  assert.equal(at(withBar, bar.x - 1, bar.y - 1), T.pal[T.index.k]);
});

// ── the automap ────────────────────────────────────────────────────────────

test('cold-aisle render: the automap shows only the cells seen, doors by badge, racks by state, the lift, and the player arrow', () => {
  const sim = newSim([
    '##########',
    '#@...b...#',
    '#....#...#',
    '#XXX.y...#',
    '#....#...#',
    '#+#..r...#',
    '#....#...#',
    '########L#'
  ]);
  const view = cda.cdaNewView();
  const T = view.tex;
  const col = (ch) => T.pal[T.index[ch]];
  const px = new Uint32Array(W * H);
  const back = (0xff000000 | 0x102030) >>> 0;
  const fill = () => { for (let i = 0; i < px.length; i++) px[i] = back; };
  const dim = ((back >>> 2) & 0x3f3f3f | 0xff000000) >>> 0;
  const m = sim.map;
  const cs = Math.max(2, Math.min(8, Math.floor(300 / m.w), Math.floor(168 / m.h)));
  const ox = (W - m.w * cs) >> 1;
  const oy = (H - m.h * cs) >> 1;
  const cell = (x, y) => at(px, ox + x * cs + 1, oy + y * cs + 1);
  // nothing seen: only the arrow
  for (let i = 0; i < m.seen.length; i++) m.seen[i] = 0;
  fill();
  cda.cdaRenderMap(view, sim, px);
  assert.equal(cell(5, 5), dim);
  assert.equal(cell(0, 0), dim);
  assert.equal(at(px, Math.floor(ox + 1.5 * cs + 2), Math.floor(oy + 1.5 * cs)), col('w'), 'the arrow points east');
  assert.equal(at(px, Math.floor(ox + 1.5 * cs - 1), Math.floor(oy + 1.5 * cs - 7)), dim, 'but not beside it');
  // everything seen
  for (let i = 0; i < m.seen.length; i++) m.seen[i] = 1;
  sim.racks[1].state = 'rebooting';
  sim.racks[2].state = 'clean';
  fill();
  cda.cdaRenderMap(view, sim, px);
  assert.equal(cell(4, 4), col('A'), 'floor');
  assert.equal(cell(0, 0), col('N'), 'wall');
  assert.deepEqual([cell(1, 3), cell(2, 3), cell(3, 3)], [col('x'), col('o'), col('G')], 'racks by state');
  assert.equal(cell(8, 7), col('P'), 'the locked lift');
  // doors: a bar across the cell along its axis, in the badge's colour
  const mid = (cs - Math.max(1, cs >> 2)) >> 1;
  assert.equal(at(px, ox + 5 * cs + mid, oy + 1 * cs + 1), col('B'), 'the blue door (axis y: a vertical bar)');
  assert.equal(at(px, ox + 5 * cs, oy + 1 * cs + 1), col('A'));
  assert.equal(at(px, ox + 5 * cs + mid, oy + 3 * cs), col('y'));
  assert.equal(at(px, ox + 5 * cs + mid, oy + 5 * cs), col('r'));
  assert.equal(sim.doors.find((d) => d.kind === 'plain').axis, 'x');
  assert.equal(at(px, ox + 1 * cs + 1, oy + 5 * cs + mid), col('n'), 'the plain door (axis x: a horizontal bar)');
  sim.liftOpen = true;
  fill();
  cda.cdaRenderMap(view, sim, px);
  assert.equal(cell(8, 7), col('c'), 'the open lift');
  // a big map uses smaller cells
  const big = newSim(['#'.repeat(64)].concat(Array.from({ length: 62 }, (_, i) => '#' + (i === 0 ? '@' : '.') + '.'.repeat(61) + '#'), ['#'.repeat(64)]));
  fill();
  cda.cdaRenderMap(view, big, px);
  assert.ok(px.some((c) => c === col('A')));
});

test('cold-aisle render: the automap also draws a wall, door, rack or lift cell beside a seen floor cell (no holes in seen walls)', () => {
  const sim = newSim([
    '##########',
    '#@...#...#',
    '#....+...#',
    '#....#...#',
    '#X...$...#',
    '#....#...#',
    '#######L##'
  ]);
  const view = cda.cdaNewView();
  const T = view.tex;
  const col = (ch) => T.pal[T.index[ch]];
  const px = new Uint32Array(W * H);
  const m = sim.map;
  const cs = Math.max(2, Math.min(8, Math.floor(300 / m.w), Math.floor(168 / m.h)));
  const ox = (W - m.w * cs) >> 1;
  const oy = (H - m.h * cs) >> 1;
  const cell = (x, y) => at(px, ox + x * cs + 1, oy + y * cs + 1);
  const dim = ((0xff102030 >>> 2) & 0x3f3f3f | 0xff000000) >>> 0;
  // only the floor of the west room is seen: none of its walls
  for (let i = 0; i < m.seen.length; i++) m.seen[i] = m.kind[i] === 'floor' && i % m.w < 5 ? 1 : 0;
  px.fill(0xff102030);
  cda.cdaRenderMap(view, sim, px);
  assert.equal(cell(2, 2), col('A'), 'seen floor');
  assert.equal(cell(0, 0), col('N'), 'a corner wall touching a seen floor cell diagonally');
  assert.equal(cell(3, 0), col('N'), 'the north wall');
  assert.equal(cell(1, 4), col('x'), 'the infected rack');
  assert.equal(cell(5, 2), col('A'), 'the door beside the room (drawn as floor with its bar)');
  assert.equal(cell(5, 4), col('N'), 'the secret looks like a wall, like every wall');
  assert.equal(cell(7, 6), dim, 'the lift is beside no seen floor');
  assert.equal(cell(6, 2), dim, 'the unseen floor of the east room stays dark');
  assert.equal(cell(9, 2), dim, 'the east room\'s wall too');
  assert.ok([0, 3, 9].every((x) => m.seen[x] === 0), 'the sim\'s seen cells are unchanged');
  assert.equal(cda.cdaMapShown(m, 0, 0), true);
  // a seen wall does not light its neighbours: only seen floor does
  for (let i = 0; i < m.seen.length; i++) m.seen[i] = m.kind[i] === 'floor' ? 0 : 1;
  m.seen[m.w * 5 + 6] = 1;
  assert.equal(cda.cdaMapShown(m, 7, 6), true, 'the lift beside the seen floor at (6, 5)');
  m.seen[m.w * 6 + 7] = 0;
  assert.equal(cda.cdaMapShown(m, 7, 6), true);
  m.seen[m.w * 5 + 6] = 0;
  assert.equal(cda.cdaMapShown(m, 7, 6), false, 'only seen walls around it');
  assert.equal(cda.cdaMapShown(m, 6, 5), false, 'an unseen floor cell is never drawn');
});
