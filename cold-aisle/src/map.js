// ── map: the level format and its legend, cdaParseLevel, cell queries, sight by DDA, the flow field ──
// Owns CDA_LEGEND, CDA_THINGS, CDA_FLOORS, CDA_CEILS, CDA_ZONE_DEFAULT,
// CDA_FACING, CDA_TEX_FRAMES, CDA_TEX_JAMB, CDA_TEX_RACK_CLEAN,
// CDA_TEX_LIFT_OPEN, cdaParseLevel, cdaParseKit, cdaCellOf, cdaSolid, cdaWalkable,
// cdaHitsWalls, cdaCast, cdaSees, cdaFlowUpdate, cdaFlowNext and
// cdaFlowStep.  Uses core and tables (CDA_TOOLS, CDA_TOOL, CDA_ENEMY,
// CDA_ITEM, CDA_DEC).
//
// ── The level format (what the levels agent writes) ──
//   {
//     name: 'Loading Dock',            shown in the HUD and in errors
//     briefing: 'One or two sentences.',
//     facing: 'E',                     the start facing: 'N' | 'E' | 'S' | 'W'
//     floor: 'floor-tile', ceil: 'ceil-panel', light: 3,   optional defaults
//                                      (CDA_ZONE_DEFAULT): zone 0's look
//     zones: { '1': { floor: 'floor-grate', ceil: 'ceil-light', light: 1 } },
//                                      optional; a digit -> its look
//     map: ['#####', '#@..#', ...],    rows of cells, one character each,
//                                      1..64 rows of the same width 1..64
//     zoneMap: ['.....', '.111.', ...] optional, the size of map: '.' zone 0
//                                      (the defaults), a digit its zone
//     kit: { tools: ['driver', 'probe'], ammo: { cell: 30, coil: 0 } }
//                                      optional: the least a player has on
//                                      entering (levels: cdaLevelCarry).
//                                      tools: CDA_TOOLS ids, the driver
//                                      among them, no repeats (the last one
//                                      in hand); ammo: whole numbers from 0
//                                      to the kind's cap, and none of a kind
//                                      whose tool the kit lacks.  Missing:
//                                      the driver alone and no ammo.
//   }
// floor is one of CDA_FLOORS, ceil one of CDA_CEILS, light 0 (pitch dark)
// .. 3 (lit).  Darkness is a look only: it changes nothing in the sim.
//
// ── The legend ──
// Cells (CDA_LEGEND; kind and wall texture):
//   .  floor
//   #  wall-concrete    %  wall-panel      =  wall-pipes
//   [  wall-rack-a      ]  wall-rack-b     |  wall-rack-c
//   H  wall-rack-rear (the hot-aisle side)  T  wall-terminal0 (animated)
//   K  wall-rack-clean (a rack that is already clean: just a wall)
//   $  secret wall (wall-secret): Use opens it for good (it becomes floor)
//   X  infected rack (wall-rack-infected0, animated): hold Use 1.5 s to
//      reboot it; it becomes wall-rack-clean
//   L  lift (lift-locked, lift-open once every rack is clean and every
//      chiller is down): Use ends the level
//   +  door (door)   b  blue door (door-blue)   y  yellow (door-yellow)
//   r  red (door-red): a door needs walls (any non-floor, non-door cell) on
//      two opposite sides, its jambs (drawn with door-jamb); it slides open
//      along the line between them.  The two cells of its way through (the
//      other two sides) must be floor or doors.
// Things, each standing on a floor cell at the cell's centre (CDA_THINGS):
//   @  the player start (exactly one)
//   s  crawler   d  drone   t  turret   l  loader   Z  chiller (the boss)
//   c  cell   o  coil   f  coffee   m  medkit   v  vest   *  patch
//   B  key-blue   Y  key-yellow   R  key-red   P  probe   G  degausser
//   u  cart   n  chair   O  spool   x  crate   e  extinguisher   ^  cone
//   /  ladder   i  lamp   I  pillar
// Every cell on the edge of the map must be a wall, a secret-free one: a
// wall, a rack or a lift, so nothing ever leaves the grid.
//
// ── The parsed level (cdaParseLevel) ──
//   { name, briefing, w, h, facing (radians), start: { x, y },
//     kit { tools [ids], ammo { cell, coil } } (a copy; the default filled in)
//     kind[]  per cell: 'floor' | 'wall' | 'door' | 'secret' | 'rack' | 'lift'
//     tex[]   per cell: the wall texture id ('' for floor), a door's door-*
//     zone[]  per cell: the index into zones
//     block[] per cell: 1 where solid decor stands (enemies route around it)
//     zones   [{ floor, ceil, light }]: zones[0] the defaults, then the
//             defined digits in increasing order
//     doors   [{ cell, x, y, kind: 'plain' | 'blue' | 'yellow' | 'red',
//             axis }]: axis 'x' when the jambs are west and east (the door
//             is a thin wall along x through the cell's middle, y + 0.5,
//             and the way through runs north-south), 'y' when they are
//             north and south (a thin wall along y at x + 0.5)
//     racks [cell], lifts [cell], secrets (how many $ cells),
//     enemies [{ kind, x, y }], items [{ kind, x, y }], decor [{ kind, x, y }] }
// A cell index is y * w + x.
//
// ── Sight, shots and the flow field ──
// cdaCast walks the grid by DDA.  Walls, racks, lifts and closed secrets stop
// a ray where it enters their cell; a door stops it where it crosses the
// door's middle line, unless it crosses in the part the door has slid away
// from: the door covers the part of its line from `open` to 1 (0 at the
// cell's low x / low y side), so at open 1 nothing is left.  Decor, enemies
// and items never stop a ray here (combat tests enemies itself).
// The flow field (sim.flow) holds, per cell, the steps from the player's
// cell (8 directions; a diagonal step only when both cells beside it are
// walkable) or -1.  Walkable for enemies: floor, plain doors (enemies open
// them), and locked doors while they are opening or open.  A floor cell with
// solid decor gets its value but the field never goes on through it, and
// cdaFlowNext never leads into it: enemies route around decor, and one whose
// centre has slid into such a cell's corner still finds its way out.
// It is recomputed when the player's cell changes or sim.flowDirty is set (a
// door started opening or closing, a secret opened).

var CDA_LEGEND = {
  '.': { kind: 'floor', tex: '' },
  '#': { kind: 'wall', tex: 'wall-concrete' },
  '%': { kind: 'wall', tex: 'wall-panel' },
  '=': { kind: 'wall', tex: 'wall-pipes' },
  '[': { kind: 'wall', tex: 'wall-rack-a' },
  ']': { kind: 'wall', tex: 'wall-rack-b' },
  '|': { kind: 'wall', tex: 'wall-rack-c' },
  'H': { kind: 'wall', tex: 'wall-rack-rear' },
  'T': { kind: 'wall', tex: 'wall-terminal0' },
  'K': { kind: 'wall', tex: 'wall-rack-clean' },
  '$': { kind: 'secret', tex: 'wall-secret' },
  'X': { kind: 'rack', tex: 'wall-rack-infected0' },
  'L': { kind: 'lift', tex: 'lift-locked' },
  '+': { kind: 'door', tex: 'door', door: 'plain' },
  'b': { kind: 'door', tex: 'door-blue', door: 'blue' },
  'y': { kind: 'door', tex: 'door-yellow', door: 'yellow' },
  'r': { kind: 'door', tex: 'door-red', door: 'red' }
};

// thing: 'start' or the parsed level's list it joins ('enemies' | 'items' | 'decor'); id: its row in the tables.
var CDA_THINGS = {
  '@': { thing: 'start', id: '' },
  's': { thing: 'enemies', id: 'crawler' },
  'd': { thing: 'enemies', id: 'drone' },
  't': { thing: 'enemies', id: 'turret' },
  'l': { thing: 'enemies', id: 'loader' },
  'Z': { thing: 'enemies', id: 'chiller' },
  'c': { thing: 'items', id: 'cell' },
  'o': { thing: 'items', id: 'coil' },
  'f': { thing: 'items', id: 'coffee' },
  'm': { thing: 'items', id: 'medkit' },
  'v': { thing: 'items', id: 'vest' },
  '*': { thing: 'items', id: 'patch' },
  'B': { thing: 'items', id: 'key-blue' },
  'Y': { thing: 'items', id: 'key-yellow' },
  'R': { thing: 'items', id: 'key-red' },
  'P': { thing: 'items', id: 'probe' },
  'G': { thing: 'items', id: 'degausser' },
  'u': { thing: 'decor', id: 'cart' },
  'n': { thing: 'decor', id: 'chair' },
  'O': { thing: 'decor', id: 'spool' },
  'x': { thing: 'decor', id: 'crate' },
  'e': { thing: 'decor', id: 'extinguisher' },
  '^': { thing: 'decor', id: 'cone' },
  '/': { thing: 'decor', id: 'ladder' },
  'i': { thing: 'decor', id: 'lamp' },
  'I': { thing: 'decor', id: 'pillar' }
};

var CDA_FLOORS = ['floor-tile', 'floor-grate', 'floor-concrete', 'floor-plate'];
var CDA_CEILS = ['ceil-panel', 'ceil-light', 'ceil-tray', 'ceil-pipes'];
var CDA_ZONE_DEFAULT = { floor: 'floor-tile', ceil: 'ceil-panel', light: 3 };
var CDA_FACING = { E: 0, S: Math.PI / 2, W: Math.PI, N: -Math.PI / 2 };
// Animated wall textures: the renderer shows the key and its value in turn.
var CDA_TEX_FRAMES = { 'wall-terminal0': 'wall-terminal1', 'wall-rack-infected0': 'wall-rack-infected1' };
var CDA_TEX_JAMB = 'door-jamb';
var CDA_TEX_RACK_CLEAN = 'wall-rack-clean';
var CDA_TEX_LIFT_OPEN = 'lift-open';
// The 8 directions of the flow field, as dx, dy pairs: 4 straight, then 4 diagonal.
var CDA_DIRS = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];

// A level object (the format above) checked and turned into grids.  Throws
// an Error whose message names the level, the cell (x,y) when there is one,
// and the problem.
function cdaParseLevel(level) {
  var name = String(level.name);
  function fail(where, problem) {
    throw new Error('Cold Aisle level "' + name + '"' + where + ': ' + problem);
  }
  function at(x, y) {
    return ', cell ' + x + ',' + y;
  }
  function look(where, z) {
    if (CDA_FLOORS.indexOf(z.floor) < 0) fail(where, 'unknown floor ' + JSON.stringify(z.floor));
    if (CDA_CEILS.indexOf(z.ceil) < 0) fail(where, 'unknown ceiling ' + JSON.stringify(z.ceil));
    if (!(z.light === 0 || z.light === 1 || z.light === 2 || z.light === 3)) fail(where, 'light must be 0, 1, 2 or 3');
    return { floor: z.floor, ceil: z.ceil, light: z.light };
  }
  var rows = level.map;
  var h = rows.length;
  var w = rows[0].length;
  if (h > CDA_MAX_SIZE || w > CDA_MAX_SIZE) fail('', 'the map is ' + w + 'x' + h + ', more than ' + CDA_MAX_SIZE);
  if (!(level.facing in CDA_FACING)) fail('', 'facing must be N, E, S or W');
  var lv = {
    name: name, briefing: String(level.briefing), w: w, h: h, facing: CDA_FACING[level.facing], start: null,
    kit: cdaParseKit(level.kit || { tools: ['driver'], ammo: {} }, fail),
    kind: [], tex: [], zone: [], block: [], zones: [], doors: [], racks: [], lifts: [], secrets: 0,
    enemies: [], items: [], decor: []
  };
  lv.zones.push(look(' (defaults)', {
    floor: level.floor || CDA_ZONE_DEFAULT.floor,
    ceil: level.ceil || CDA_ZONE_DEFAULT.ceil,
    light: 'light' in level ? level.light : CDA_ZONE_DEFAULT.light
  }));
  var defs = level.zones || {};
  var digits = Object.keys(defs).sort();
  for (var d = 0; d < digits.length; d++) {
    if (!/^[0-9]$/.test(digits[d])) fail('', 'zone names are single digits, not ' + JSON.stringify(digits[d]));
    lv.zones.push(look(' (zone ' + digits[d] + ')', defs[digits[d]]));
  }
  var zrows = level.zoneMap || [];
  if (level.zoneMap && zrows.length !== h) fail('', 'zoneMap has ' + zrows.length + ' rows, the map ' + h);
  var x;
  var y;
  for (y = 0; y < h; y++) {
    if (rows[y].length !== w) fail('', 'row ' + y + ' is ' + rows[y].length + ' wide, not ' + w);
    if (level.zoneMap && zrows[y].length !== w) fail('', 'zoneMap row ' + y + ' is ' + zrows[y].length + ' wide, not ' + w);
    for (x = 0; x < w; x++) {
      var ch = rows[y].charAt(x);
      var cell = CDA_LEGEND[ch];
      var thing = CDA_THINGS[ch];
      if (!cell && !thing) fail(at(x, y), 'unknown character ' + JSON.stringify(ch));
      cell = cell || CDA_LEGEND['.'];
      var edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (edge && cell.kind !== 'wall' && cell.kind !== 'rack' && cell.kind !== 'lift') fail(at(x, y), 'the edge of the map must be wall, rack or lift');
      var i = y * w + x;
      var z = level.zoneMap ? zrows[y].charAt(x) : '.';
      if (z !== '.' && digits.indexOf(z) < 0) fail(at(x, y), 'zone ' + JSON.stringify(z) + ' is not defined');
      lv.kind.push(cell.kind);
      lv.tex.push(cell.tex);
      lv.zone.push(digits.indexOf(z) + 1);
      lv.block.push(0);
      if (cell.kind === 'secret') lv.secrets++;
      if (cell.kind === 'rack') lv.racks.push(i);
      if (cell.kind === 'lift') lv.lifts.push(i);
      if (cell.door) lv.doors.push({ cell: i, x: x, y: y, kind: cell.door, axis: '' });
      if (thing && thing.thing === 'start') {
        if (lv.start) fail(at(x, y), 'a second player start');
        lv.start = { x: x + 0.5, y: y + 0.5 };
      }
      if (thing && thing.thing !== 'start') lv[thing.thing].push({ kind: thing.id, x: x + 0.5, y: y + 0.5 });
      if (thing && thing.thing === 'decor' && CDA_DEC[thing.id].solid) lv.block[i] = 1;
    }
  }
  if (!lv.start) fail('', 'no player start (@)');
  function jamb(cx, cy) {
    var k = lv.kind[cy * w + cx];
    return k !== 'floor' && k !== 'door';
  }
  for (d = 0; d < lv.doors.length; d++) {
    var door = lv.doors[d];
    var we = jamb(door.x - 1, door.y) && jamb(door.x + 1, door.y);
    var ns = jamb(door.x, door.y - 1) && jamb(door.x, door.y + 1);
    if (!we && !ns) fail(at(door.x, door.y), 'a door needs walls on two opposite sides');
    door.axis = we ? 'x' : 'y';
    if (we ? jamb(door.x, door.y - 1) || jamb(door.x, door.y + 1) : jamb(door.x - 1, door.y) || jamb(door.x + 1, door.y)) {
      fail(at(door.x, door.y), 'a door must lead to floor (or another door) on both sides of its way through');
    }
  }
  return lv;
}

// A level's kit checked (see the header) and copied, its ammo filled in;
// fail(where, problem) throws.
function cdaParseKit(kit, fail) {
  var tools = kit.tools;
  if (Object.prototype.toString.call(tools) !== '[object Array]' || tools.indexOf('driver') < 0) fail(' (kit)', 'the tools must be a list with the driver');
  for (var k = 0; k < tools.length; k++) {
    if (!CDA_TOOL.hasOwnProperty(tools[k])) fail(' (kit)', 'unknown tool ' + JSON.stringify(tools[k]));
    if (tools.indexOf(tools[k]) !== k) fail(' (kit)', JSON.stringify(tools[k]) + ' twice');
  }
  var ammo = { cell: 0, coil: 0 };
  var given = kit.ammo || {};
  var kinds = Object.keys(given);
  for (k = 0; k < kinds.length; k++) {
    var n = given[kinds[k]];
    var tool = null;
    for (var t = 0; t < CDA_TOOLS.length; t++) if (CDA_TOOLS[t].ammo === kinds[k]) tool = CDA_TOOLS[t];
    if (!tool) fail(' (kit)', 'unknown ammo ' + JSON.stringify(kinds[k]));
    if (!(n === Math.floor(n) && n >= 0 && n <= tool.cap)) fail(' (kit)', kinds[k] + ' must be a whole number from 0 to ' + tool.cap);
    if (n > 0 && tools.indexOf(tool.id) < 0) fail(' (kit)', kinds[k] + ' without the ' + tool.id);
    ammo[kinds[k]] = n;
  }
  return { tools: tools.slice(), ammo: ammo };
}

// The index of the cell under (x, y).
function cdaCellOf(sim, x, y) {
  return Math.floor(y) * sim.map.w + Math.floor(x);
}

// Whether cell i stops bodies: walls, racks, lifts, closed secrets, and
// doors that are not open enough (CDA_DOOR_PASS).
function cdaSolid(sim, i) {
  var k = sim.map.kind[i];
  if (k === 'door') return sim.doors[sim.map.door[i]].open < CDA_DOOR_PASS;
  return k !== 'floor';
}

// Whether the flow field may pass cell i (see the header).
function cdaWalkable(sim, i) {
  var k = sim.map.kind[i];
  if (k === 'door') {
    var d = sim.doors[sim.map.door[i]];
    return d.kind === 'plain' || d.state === 'opening' || d.state === 'open';
  }
  return k === 'floor';
}

// Whether a circle of radius r (< 1) at (x, y) overlaps a solid cell.
function cdaHitsWalls(sim, x, y, r) {
  var w = sim.map.w;
  for (var cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
    for (var cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
      if (!cdaSolid(sim, cy * w + cx)) continue;
      var nx = x - Math.max(cx, Math.min(x, cx + 1));
      var ny = y - Math.max(cy, Math.min(y, cy + 1));
      if (nx * nx + ny * ny < r * r) return true;
    }
  }
  return false;
}

// Where a ray within cell i between ray distances t0 and t1 is stopped, or
// -1 (see the header).
function cdaCastCell(sim, i, x, y, dx, dy, t0, t1) {
  var m = sim.map;
  var k = m.kind[i];
  if (k === 'floor') return -1;
  if (k !== 'door') return t0;
  var d = sim.doors[m.door[i]];
  var t = d.axis === 'x' ? (d.y + 0.5 - y) / dy : (d.x + 0.5 - x) / dx;
  var f = d.axis === 'x' ? x + dx * t - d.x : y + dy * t - d.y;
  return t >= t0 && t <= t1 && f >= d.open ? t : -1;
}

// Walks the grid from (x, y) along the unit vector (dx, dy) for at most max
// cells.  Returns { dist, x, y, cell }: where the ray was stopped (cell the
// stopping cell), or, when nothing stopped it within max, the point at max
// and cell -1.  With mark set, every cell the ray reaches, the stopping one
// included, is marked seen (sim.map.seen).
function cdaCast(sim, x, y, dx, dy, max, mark) {
  var m = sim.map;
  var cx = Math.floor(x);
  var cy = Math.floor(y);
  var stepX = dx < 0 ? -1 : 1;
  var stepY = dy < 0 ? -1 : 1;
  var ddx = Math.abs(1 / dx);
  var ddy = Math.abs(1 / dy);
  var sx = (dx < 0 ? x - cx : cx + 1 - x) * ddx;
  var sy = (dy < 0 ? y - cy : cy + 1 - y) * ddy;
  var t = 0;
  for (;;) {
    var i = cy * m.w + cx;
    if (mark) m.seen[i] = 1;
    var next = sx < sy ? sx : sy;
    var hit = cdaCastCell(sim, i, x, y, dx, dy, t, next);
    if (hit >= 0 && hit <= max) return { dist: hit, x: x + dx * hit, y: y + dy * hit, cell: i };
    // (not `next >= max`: a zero-length direction makes next NaN, and this ends it)
    if (!(next < max)) return { dist: max, x: x + dx * max, y: y + dy * max, cell: -1 };
    t = next;
    if (sx < sy) {
      sx += ddx;
      cx += stepX;
    } else {
      sy += ddy;
      cy += stepY;
    }
  }
}

// Whether nothing stops a ray from (ax, ay) to (bx, by).
function cdaSees(sim, ax, ay, bx, by) {
  var d = cdaDist(ax, ay, bx, by);
  var c = cdaCast(sim, ax, ay, (bx - ax) / d, (by - ay) / d, d, false);
  return c.cell < 0;
}

// The cell one step in direction k (0..7, CDA_DIRS) from cell i, or -1 when
// that step is not walkable (a diagonal also needs both cells beside it).
function cdaFlowStep(sim, i, k) {
  var w = sim.map.w;
  var dx = CDA_DIRS[k * 2];
  var dy = CDA_DIRS[k * 2 + 1];
  var j = i + dy * w + dx;
  if (!cdaWalkable(sim, j)) return -1;
  if (k >= 4 && !(cdaWalkable(sim, i + dx) && cdaWalkable(sim, i + dy * w))) return -1;
  return j;
}

// Recomputes sim.flow when the player's cell changed or sim.flowDirty is set.
function cdaFlowUpdate(sim) {
  var from = cdaCellOf(sim, sim.player.x, sim.player.y);
  if (from === sim.flowFrom && !sim.flowDirty) return;
  sim.flowFrom = from;
  sim.flowDirty = false;
  var f = sim.flow;
  for (var c = 0; c < f.length; c++) f[c] = -1;
  f[from] = 0;
  var queue = [from];
  for (var q = 0; q < queue.length; q++) {
    var i = queue[q];
    for (var k = 0; k < 8; k++) {
      var j = cdaFlowStep(sim, i, k);
      if (j < 0 || f[j] >= 0) continue;
      f[j] = f[i] + 1;
      if (!sim.map.block[j]) queue.push(j);
    }
  }
}

// The neighbour of cell i one flow step nearer the player (the first in
// CDA_DIRS order with the lowest value, never a solid-decor cell), or -1
// when there is none.
function cdaFlowNext(sim, i) {
  var best = -1;
  var low = sim.flow[i];
  for (var k = 0; k < 8; k++) {
    var j = cdaFlowStep(sim, i, k);
    if (j >= 0 && !sim.map.block[j] && sim.flow[j] >= 0 && sim.flow[j] < low) {
      best = j;
      low = sim.flow[j];
    }
  }
  return best;
}

CDA_API.CDA_LEGEND = CDA_LEGEND;
CDA_API.CDA_THINGS = CDA_THINGS;
CDA_API.CDA_FLOORS = CDA_FLOORS;
CDA_API.CDA_CEILS = CDA_CEILS;
CDA_API.CDA_ZONE_DEFAULT = CDA_ZONE_DEFAULT;
CDA_API.CDA_FACING = CDA_FACING;
CDA_API.CDA_TEX_FRAMES = CDA_TEX_FRAMES;
CDA_API.CDA_TEX_JAMB = CDA_TEX_JAMB;
CDA_API.CDA_TEX_RACK_CLEAN = CDA_TEX_RACK_CLEAN;
CDA_API.CDA_TEX_LIFT_OPEN = CDA_TEX_LIFT_OPEN;
CDA_API.cdaParseLevel = cdaParseLevel;
CDA_API.cdaParseKit = cdaParseKit;
CDA_API.cdaCellOf = cdaCellOf;
CDA_API.cdaSolid = cdaSolid;
CDA_API.cdaWalkable = cdaWalkable;
CDA_API.cdaHitsWalls = cdaHitsWalls;
CDA_API.cdaCast = cdaCast;
CDA_API.cdaSees = cdaSees;
CDA_API.cdaFlowStep = cdaFlowStep;
CDA_API.cdaFlowUpdate = cdaFlowUpdate;
CDA_API.cdaFlowNext = cdaFlowNext;
