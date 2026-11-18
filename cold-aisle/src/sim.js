// ── sim: a new sim, the fixed step, the player's movement, doors, Use, items, racks, the lift ──
// Owns cdaNewSim, cdaStep, cdaInputNew, cdaCarryNew, cdaCarryFrom,
// cdaUpgradeBonus, cdaResult and the step helpers the other sim parts call
// (cdaEmit, cdaMove, cdaHitsBodies, cdaOpenDoor, cdaLiftCheck).  Uses core,
// tables and map; inside function bodies also sim-combat (cdaPlayerTool,
// cdaSwitch, cdaShotsStep), sim-enemies (cdaNewEnemy, cdaEnemiesStep).
//
// The sim is plain data (numbers, strings, booleans, arrays, plain objects;
// no typed arrays): a renderer reads it, JSON.stringify snapshots it, and a
// JSON copy plays on exactly like the original.  cdaStep changes it in place
// by one step of 1/120 s and is deterministic: its only randomness is the
// mulberry32 state in sim.rng.  A level restart is a new sim made from the
// same parsed level and the same carried state.
//
// ── Creating and chaining levels ──
//   lv = cdaParseLevel(levelObject)                     (map)
//   sim = cdaNewSim(lv, carry, upgrades, seed)
//   carry: what the player keeps between levels, { tools: ['driver', ...]
//     (in the order they were got; the last one is in hand at the start),
//     ammo: { cell, coil }, health, armour }.  cdaCarryNew() is the start of
//     the episode; cdaCarryFrom(sim) is what a won level hands to the next.
//     On entering, health is raised to CDA_PLAYER.entryHealth and capped at
//     the maximum, ammo and armour capped.  Badges never carry over.
//   upgrades: the tiers bought per CDA_UPGRADES line ({ health: 2, ... }; a
//     missing line is 0), applied here (cdaUpgradeBonus).
//   After the level: cdaResult(sim) (time, kills, secrets, patches earned).
//   On death (sim.status 'dead') the page makes a new sim from the same lv
//   and the same carry.
//
// ── Input for one step (cdaInputNew() makes a neutral one) ──
//   { move: -1..1 (forward), strafe: -1..1 (right), turn: radians to add to
//     the angle (keyboard turn already scaled by CDA_PLAYER.turn * CDA_STEP,
//     plus the mouse), fire: bool (held), use: bool (held: doors, secrets and
//     the lift act when it goes down, a reboot runs while it is held),
//     weapon: 0 | 1..3 (a switch request by slot) }
//
// ── The state the renderer, the sound and the UI read ──
//   name, tick (steps so far), status 'playing' | 'won' | 'dead', rng
//   player { x, y, angle (not wrapped), px, py, pangle (the same before this
//     step: interpolate x = px + (x - px) * alpha), radius, health,
//     maxHealth, armour, tools [ids owned], tool (in hand), ammo { cell,
//     coil }, caps { cell, coil }, cooldown (steps until it may fire),
//     fireT (steps since the tool last fired; CDA_RATE at the start: the
//     in-hand animation picks its atk frames from it), switchT (steps left
//     of a tool switch, the tool lowered and raised), badges { blue, yellow,
//     red } (booleans), useHeld, flashlight (cells) }
//   tools { driver | probe | degausser: { damage, cooldown (steps), reach,
//     slack, rays, fan, falloff, far, ammo, noise } }: CDA_TOOLS with the
//     upgrades applied
//   map { w, h, kind[], tex[], zone[], block[] (as cdaParseLevel), door[]
//     (per cell the index into doors, -1 elsewhere), seen[] (1 for a cell
//     the player has seen: the automap) }; zones [{ floor, ceil, light }]
//     (map.zone[i] indexes it).  tex changes: a rebooted rack becomes
//     CDA_TEX_RACK_CLEAN, the lift CDA_TEX_LIFT_OPEN, an opened secret ''.
//   doors [{ cell, x, y (the cell), kind 'plain' | 'blue' | 'yellow' | 'red',
//     axis 'x' | 'y' (map), open 0..1 (the share slid away), popen (open
//     before this step), state 'closed' | 'opening' | 'open' | 'closing',
//     t (steps left while open) }]
//   enemies: see the header of sim-enemies (state and frames)
//   shots [{ id, kind 'spark' | 'bolt' | 'frost', owner (enemy id), x, y,
//     px, py, dx, dy (unit direction), speed, damage }]
//   items [{ id, kind (CDA_ITEMS id), x, y, taken }]: draw those not taken
//   decor [{ kind (CDA_DECOR id), x, y, solid, radius }]
//   racks [{ cell, x, y, state 'infected' | 'rebooting' | 'clean', t (steps
//     held), progress 0..1 (the Use bar) }]; reboot: the index of the rack
//     being rebooted, -1 when none
//   lifts [{ cell, x, y }]; liftOpen
//   flow [], flowFrom, flowDirty: the flow field (map)
//   stats { kills, enemies (placed by the level), secrets, secretsTotal,
//     patches (picked up), shots }
//   nextId: ids of enemies and shots
//
// ── Events: sim.events holds what happened in the last step ──
// (refilled by every cdaStep; x, y in cells; a cell event's x, y is the
// cell's centre).  Every event is { type, ... }:
//   shot {tool, x, y, angle}            the player used a tool (once per use)
//   hit {id, kind, x, y, damage, blocked}   a ray reached an enemy at x, y;
//                                       blocked: the chiller's armour (0 damage)
//   wall {x, y, cell}                   a ray stopped at a wall or door: a puff
//   switch {tool, auto}                 the tool in hand changed (auto: out of ammo)
//   wake {id, kind, why}                an enemy woke: 'sight' | 'noise' | 'hurt'
//   windup {id, kind, x, y}             an attack's tell began (swing, spark
//                                       charging, lock-on, telegraph, frost)
//   attack {id, kind, x, y}             the attack happens (a strike, a shot,
//                                       a burst, a charge, a frost fan)
//   lockLost {id, x, y}                 a turret lost its lock behind cover
//   stun {id, x, y, hit}                a loader's charge ended (hit: on the player)
//   die {id, kind, x, y}                an enemy was destroyed
//   phase {id, phase}                   the chiller entered phase 2 or 3
//   vent {id, open}                     the chiller's vents opened / closed
//   summon {id, child, x, y}            the chiller called a crawler (child: its id)
//   fire {id, kind, owner, x, y, angle} an enemy projectile was launched
//   shotEnd {id, kind, x, y, hit}       a projectile ended: hit 'player' | 'wall'
//   hurt {damage, absorbed, health, armour, x, y, by}   the player was hurt
//                                       (x, y: where from; by: enemy kind or
//                                       projectile kind)
//   death {}                            the player died (status 'dead')
//   door {cell, x, y, kind, open, by}   a door started opening (open true; by
//                                       'player' | 'enemy' | 'body': someone
//                                       stood in it while it closed) or closing
//                                       (open false, by 'time')
//   doorLocked {cell, x, y, badge}      Use on a locked door without its badge
//   secret {cell, x, y}                 a secret wall opened
//   pickup {id, item, x, y}             an item was picked up
//   rebootStart / rebootStop {rack, cell, x, y}   a reboot began / was interrupted
//   rebootDone {rack, cell, x, y, left} a rack is clean (left: infected ones left)
//   liftLocked {left}                   Use on the locked lift (left: racks)
//   liftOpen {}                         the lift unlocked
//   win {}                              the player took the lift (status 'won')
//   message {text}                      a line for the HUD (CDA_TEXT)

var CDA_DOOR_OPEN_TIME = 0.5;   // seconds a door takes to slide fully open (and closed)
var CDA_DOOR_STAY = 3;          // seconds a door stays open once nobody stands in it

function cdaEmit(sim, type, ev) {
  ev.type = type;
  sim.events.push(ev);
}

function cdaInputNew() {
  return { move: 0, strafe: 0, turn: 0, fire: false, use: false, weapon: 0 };
}

function cdaCarryNew() {
  return { tools: ['driver'], ammo: { cell: 0, coil: 0 }, health: CDA_PLAYER.health, armour: 0 };
}

function cdaCarryFrom(sim) {
  var p = sim.player;
  return { tools: p.tools.slice(), ammo: { cell: p.ammo.cell, coil: p.ammo.coil }, health: p.health, armour: p.armour };
}

// What the tiers bought of upgrade line id add.
function cdaUpgradeBonus(upgrades, id) {
  return (upgrades[id] || 0) * CDA_UPGRADE[id].step;
}

function cdaCellCentre(sim, i) {
  return { cell: i, x: i % sim.map.w + 0.5, y: Math.floor(i / sim.map.w) + 0.5 };
}

function cdaNewSim(lv, carry, upgrades, seed) {
  var n = lv.w * lv.h;
  var tools = {};
  for (var k = 0; k < CDA_TOOLS.length; k++) {
    var row = CDA_TOOLS[k];
    tools[row.id] = { damage: row.damage, cooldown: cdaSteps(row.cooldown), reach: row.reach, slack: row.slack, rays: row.rays,
      fan: row.fan, falloff: row.falloff, far: row.far, ammo: row.ammo, noise: row.noise };
  }
  tools.probe.damage += cdaUpgradeBonus(upgrades, 'probeDamage');
  tools.probe.cooldown = cdaSteps(CDA_TOOL.probe.cooldown * (1 - cdaUpgradeBonus(upgrades, 'probeSpeed')));
  tools.degausser.rays += cdaUpgradeBonus(upgrades, 'rays');
  var maxHealth = CDA_PLAYER.health + cdaUpgradeBonus(upgrades, 'health');
  var caps = { cell: CDA_TOOL.probe.cap + cdaUpgradeBonus(upgrades, 'cells'), coil: CDA_TOOL.degausser.cap };
  var sim = {
    name: lv.name, tick: 0, status: 'playing', rng: seed | 0, events: [], nextId: 1, reboot: -1, liftOpen: false,
    player: {
      x: lv.start.x, y: lv.start.y, angle: lv.facing, px: lv.start.x, py: lv.start.y, pangle: lv.facing,
      radius: CDA_PLAYER.radius, maxHealth: maxHealth,
      health: Math.min(maxHealth, Math.max(carry.health, CDA_PLAYER.entryHealth)),
      armour: Math.min(CDA_PLAYER.armourMax, carry.armour),
      tools: carry.tools.slice(), tool: carry.tools[carry.tools.length - 1],
      ammo: { cell: Math.min(caps.cell, carry.ammo.cell), coil: Math.min(caps.coil, carry.ammo.coil) }, caps: caps,
      cooldown: 0, fireT: CDA_RATE, switchT: 0, badges: { blue: false, yellow: false, red: false }, useHeld: false,
      flashlight: CDA_PLAYER.flashlight + cdaUpgradeBonus(upgrades, 'flashlight')
    },
    tools: tools,
    map: { w: lv.w, h: lv.h, kind: lv.kind.slice(), tex: lv.tex.slice(), zone: lv.zone.slice(), block: lv.block.slice(), door: [], seen: [] },
    zones: lv.zones.map(function (z) { return { floor: z.floor, ceil: z.ceil, light: z.light }; }),
    doors: lv.doors.map(function (d) {
      return { cell: d.cell, x: d.x, y: d.y, kind: d.kind, axis: d.axis, open: 0, popen: 0, state: 'closed', t: 0 };
    }),
    enemies: [], shots: [],
    items: lv.items.map(function (it, i) { return { id: i, kind: it.kind, x: it.x, y: it.y, taken: false }; }),
    decor: lv.decor.map(function (d) { return { kind: d.kind, x: d.x, y: d.y, solid: CDA_DEC[d.kind].solid, radius: CDA_DEC[d.kind].radius }; }),
    flow: [], flowFrom: -1, flowDirty: true,
    stats: { kills: 0, enemies: lv.enemies.length, secrets: 0, secretsTotal: lv.secrets, patches: 0, shots: 0 }
  };
  sim.racks = lv.racks.map(function (i) {
    var c = cdaCellCentre(sim, i);
    return { cell: i, x: c.x, y: c.y, state: 'infected', t: 0, progress: 0 };
  });
  sim.lifts = lv.lifts.map(function (i) { return cdaCellCentre(sim, i); });
  for (var i = 0; i < n; i++) {
    sim.map.door.push(-1);
    sim.map.seen.push(0);
    sim.flow.push(-1);
  }
  for (k = 0; k < sim.doors.length; k++) sim.map.door[sim.doors[k].cell] = k;
  for (k = 0; k < lv.enemies.length; k++) cdaNewEnemy(sim, lv.enemies[k].kind, lv.enemies[k].x, lv.enemies[k].y, false);
  cdaLiftCheck(sim);
  cdaFlowUpdate(sim);
  cdaSeenSweep(sim);
  sim.events = [];
  return sim;
}

// Whether circle o stops body b from moving to (nx, ny): they would overlap
// and get nearer than they are (so bodies that already overlap can part).
function cdaBlocks(b, o, nx, ny) {
  var r = b.radius + o.radius;
  var ex = nx - o.x;
  var ey = ny - o.y;
  var d2 = ex * ex + ey * ey;
  var ox = b.x - o.x;
  var oy = b.y - o.y;
  return d2 < r * r && d2 < ox * ox + oy * oy;
}

// Whether another body (the player, a living enemy, solid decor) stops b at (nx, ny).
function cdaHitsBodies(sim, b, nx, ny) {
  var p = sim.player;
  if (b !== p && cdaBlocks(b, p, nx, ny)) return true;
  for (var i = 0; i < sim.enemies.length; i++) {
    var e = sim.enemies[i];
    if (e !== b && e.hp > 0 && cdaBlocks(b, e, nx, ny)) return true;
  }
  for (i = 0; i < sim.decor.length; i++) {
    if (sim.decor[i].solid && cdaBlocks(b, sim.decor[i], nx, ny)) return true;
  }
  return false;
}

// Moves body b ({ x, y, radius }) by (dx, dy), one axis at a time, so it
// slides along what stops it.  Returns whether anything stopped it.
function cdaMove(sim, b, dx, dy) {
  var blocked = false;
  var nx = b.x + dx;
  if (cdaHitsWalls(sim, nx, b.y, b.radius) || cdaHitsBodies(sim, b, nx, b.y)) blocked = true;
  else b.x = nx;
  var ny = b.y + dy;
  if (cdaHitsWalls(sim, b.x, ny, b.radius) || cdaHitsBodies(sim, b, b.x, ny)) blocked = true;
  else b.y = ny;
  return blocked;
}

function cdaPlayerMove(sim, input) {
  var p = sim.player;
  p.angle += input.turn;
  var mv = input.move;
  var st = input.strafe;
  var len = Math.sqrt(mv * mv + st * st);
  if (len > 1) {
    mv /= len;
    st /= len;
  }
  var sp = CDA_PLAYER.speed * CDA_STEP;
  var c = Math.cos(p.angle);
  var s = Math.sin(p.angle);
  cdaMove(sim, p, (c * mv - s * st) * sp, (s * mv + c * st) * sp);
}

// Starts door d opening, when it is closed or closing.
function cdaOpenDoor(sim, d, by) {
  if (d.state !== 'closed' && d.state !== 'closing') return;
  d.state = 'opening';
  sim.flowDirty = true;
  cdaEmit(sim, 'door', { cell: d.cell, x: d.x + 0.5, y: d.y + 0.5, kind: d.kind, open: true, by: by });
}

// Whether body b overlaps door d's cell.
function cdaInDoor(b, d) {
  var nx = b.x - Math.max(d.x, Math.min(b.x, d.x + 1));
  var ny = b.y - Math.max(d.y, Math.min(b.y, d.y + 1));
  return nx * nx + ny * ny < b.radius * b.radius;
}

// Whether a body (the player, a living enemy) stands in door d.
function cdaDoorBusy(sim, d) {
  if (cdaInDoor(sim.player, d)) return true;
  for (var i = 0; i < sim.enemies.length; i++) {
    if (sim.enemies[i].hp > 0 && cdaInDoor(sim.enemies[i], d)) return true;
  }
  return false;
}

function cdaDoorsStep(sim) {
  var rate = 1 / cdaSteps(CDA_DOOR_OPEN_TIME);
  for (var i = 0; i < sim.doors.length; i++) {
    var d = sim.doors[i];
    d.popen = d.open;
    if (d.state === 'opening') {
      d.open = Math.min(1, d.open + rate);
      if (d.open === 1) {
        d.state = 'open';
        d.t = cdaSteps(CDA_DOOR_STAY);
      }
    } else if (d.state === 'open') {
      d.t = cdaDoorBusy(sim, d) ? cdaSteps(CDA_DOOR_STAY) : d.t - 1;
      if (d.t === 0) {
        d.state = 'closing';
        sim.flowDirty = true;
        cdaEmit(sim, 'door', { cell: d.cell, x: d.x + 0.5, y: d.y + 0.5, kind: d.kind, open: false, by: 'time' });
      }
    } else if (d.state === 'closing') {
      if (cdaDoorBusy(sim, d)) {
        cdaOpenDoor(sim, d, 'body');
      } else {
        d.open = Math.max(0, d.open - rate);
        if (d.open === 0) d.state = 'closed';
      }
    }
  }
}

// Opens the lift once every rack is clean and every chiller is down.
function cdaLiftCheck(sim) {
  if (sim.liftOpen) return;
  for (var i = 0; i < sim.racks.length; i++) if (sim.racks[i].state !== 'clean') return;
  for (i = 0; i < sim.enemies.length; i++) if (sim.enemies[i].kind === 'chiller' && sim.enemies[i].hp > 0) return;
  sim.liftOpen = true;
  for (i = 0; i < sim.lifts.length; i++) sim.map.tex[sim.lifts[i].cell] = CDA_TEX_LIFT_OPEN;
  cdaEmit(sim, 'liftOpen', {});
  cdaEmit(sim, 'message', { text: cdaText('open', {}) });
}

function cdaRacksLeft(sim) {
  var left = 0;
  for (var i = 0; i < sim.racks.length; i++) if (sim.racks[i].state !== 'clean') left++;
  return left;
}

function cdaRebootStop(sim) {
  var r = sim.racks[sim.reboot];
  r.state = 'infected';
  r.t = 0;
  r.progress = 0;
  cdaEmit(sim, 'rebootStop', { rack: sim.reboot, cell: r.cell, x: r.x, y: r.y });
  sim.reboot = -1;
}

// Use held on rack cell `cell` for one step.
function cdaRebootStep(sim, cell) {
  var n = 0;
  while (sim.racks[n].cell !== cell) n++;
  var r = sim.racks[n];
  if (r.state === 'clean') return;
  if (r.state === 'infected') {
    r.state = 'rebooting';
    sim.reboot = n;
    cdaEmit(sim, 'rebootStart', { rack: n, cell: cell, x: r.x, y: r.y });
  }
  var total = cdaSteps(CDA_PLAYER.reboot);
  r.t++;
  r.progress = r.t / total;
  if (r.t < total) return;
  r.state = 'clean';
  sim.reboot = -1;
  sim.map.tex[cell] = CDA_TEX_RACK_CLEAN;
  cdaEmit(sim, 'rebootDone', { rack: n, cell: cell, x: r.x, y: r.y, left: cdaRacksLeft(sim) });
  cdaEmit(sim, 'message', { text: cdaText('rebooted', {}) });
  cdaLiftCheck(sim);
}

function cdaUseDoor(sim, d) {
  if (d.kind !== 'plain' && !sim.player.badges[d.kind]) {
    cdaEmit(sim, 'doorLocked', { cell: d.cell, x: d.x + 0.5, y: d.y + 0.5, badge: d.kind });
    cdaEmit(sim, 'message', { text: cdaText('locked', { item: CDA_ITEM['key-' + d.kind].name }) });
    return;
  }
  cdaOpenDoor(sim, d, 'player');
}

function cdaOpenSecret(sim, i) {
  sim.map.kind[i] = 'floor';
  sim.map.tex[i] = '';
  sim.flowDirty = true;
  sim.stats.secrets++;
  var c = cdaCellCentre(sim, i);
  cdaEmit(sim, 'secret', { cell: i, x: c.x, y: c.y });
  cdaEmit(sim, 'message', { text: cdaText('secret', {}) });
}

function cdaUseLift(sim) {
  if (sim.liftOpen) {
    sim.status = 'won';
    cdaEmit(sim, 'win', {});
    return;
  }
  var left = cdaRacksLeft(sim);
  cdaEmit(sim, 'liftLocked', { left: left });
  cdaEmit(sim, 'message', { text: left ? cdaText('lift', { n: left }) : cdaText('boss', {}) });
}

// Use: what the player faces within reach.
function cdaPlayerUse(sim, input) {
  var p = sim.player;
  var edge = input.use && !p.useHeld;
  p.useHeld = input.use;
  var target = -1;
  if (input.use) target = cdaCast(sim, p.x, p.y, Math.cos(p.angle), Math.sin(p.angle), CDA_PLAYER.useReach, false).cell;
  if (sim.reboot >= 0 && sim.racks[sim.reboot].cell !== target) cdaRebootStop(sim);
  if (target < 0) return;
  var kind = sim.map.kind[target];
  if (kind === 'rack') cdaRebootStep(sim, target);
  else if (edge && kind === 'door') cdaUseDoor(sim, sim.doors[sim.map.door[target]]);
  else if (edge && kind === 'secret') cdaOpenSecret(sim, target);
  else if (edge && kind === 'lift') cdaUseLift(sim);
}

// Gives the player item row `row`; returns whether it changed anything.
function cdaItemGive(sim, row) {
  var p = sim.player;
  var took = false;
  if (row.tool && p.tools.indexOf(row.tool) < 0) {
    p.tools.push(row.tool);
    cdaSwitch(sim, row.tool, false);
    took = true;
  }
  if (row.ammo) {
    var a = Math.min(p.caps[row.ammo], p.ammo[row.ammo] + row.amount);
    if (a > p.ammo[row.ammo]) took = true;
    p.ammo[row.ammo] = a;
  }
  if (row.health) {
    var h = Math.min(p.maxHealth, p.health + row.health);
    if (h > p.health) took = true;
    p.health = h;
  }
  if (row.armour) {
    var v = Math.min(CDA_PLAYER.armourMax, p.armour + row.armour);
    if (v > p.armour) took = true;
    p.armour = v;
  }
  if (row.badge) {
    if (!p.badges[row.badge]) took = true;
    p.badges[row.badge] = true;
  }
  if (row.patch) {
    sim.stats.patches += row.patch;
    took = true;
  }
  return took;
}

function cdaPickup(sim) {
  var p = sim.player;
  for (var i = 0; i < sim.items.length; i++) {
    var it = sim.items[i];
    if (it.taken || cdaDist(p.x, p.y, it.x, it.y) >= CDA_PLAYER.pickup) continue;
    var row = CDA_ITEM[it.kind];
    if (!cdaItemGive(sim, row)) continue;
    it.taken = true;
    cdaEmit(sim, 'pickup', { id: it.id, item: it.kind, x: it.x, y: it.y });
    cdaEmit(sim, 'message', { text: cdaText('pickup', { item: row.name }) });
  }
}

// Marks what the player sees now (CDA_SEEN_RAYS rays over CDA_FOV).
function cdaSeenSweep(sim) {
  var p = sim.player;
  for (var k = 0; k < CDA_SEEN_RAYS; k++) {
    var a = p.angle + CDA_FOV * ((k + 0.5) / CDA_SEEN_RAYS - 0.5);
    cdaCast(sim, p.x, p.y, Math.cos(a), Math.sin(a), CDA_SEEN_RANGE, true);
  }
}

// One step of 1/120 s.  Does nothing (but empty sim.events) once the level
// is won or lost.
function cdaStep(sim, input) {
  sim.events = [];
  if (sim.status !== 'playing') return;
  sim.tick++;
  var p = sim.player;
  p.px = p.x;
  p.py = p.y;
  p.pangle = p.angle;
  cdaPlayerMove(sim, input);
  cdaPlayerTool(sim, input);
  cdaPlayerUse(sim, input);
  if (sim.status !== 'playing') return;
  cdaPickup(sim);
  cdaDoorsStep(sim);
  cdaFlowUpdate(sim);
  cdaEnemiesStep(sim);
  cdaShotsStep(sim);
  if (sim.tick % CDA_SEEN_EVERY === 0) cdaSeenSweep(sim);
}

// The level's result: { won, time (seconds), kills, enemies, secrets,
// secretsTotal, patches (earned: CDA_REWARDS for a won level plus the patch
// items picked up) }.
function cdaResult(sim) {
  var won = sim.status === 'won';
  var s = sim.stats;
  var earned = won ? CDA_REWARDS.finish + s.kills * CDA_REWARDS.kill + s.secrets * CDA_REWARDS.secret : 0;
  return { won: won, time: sim.tick * CDA_STEP, kills: s.kills, enemies: s.enemies, secrets: s.secrets, secretsTotal: s.secretsTotal,
    patches: earned + s.patches };
}

CDA_API.CDA_DOOR_OPEN_TIME = CDA_DOOR_OPEN_TIME;
CDA_API.CDA_DOOR_STAY = CDA_DOOR_STAY;
CDA_API.cdaInputNew = cdaInputNew;
CDA_API.cdaCarryNew = cdaCarryNew;
CDA_API.cdaCarryFrom = cdaCarryFrom;
CDA_API.cdaUpgradeBonus = cdaUpgradeBonus;
CDA_API.cdaNewSim = cdaNewSim;
CDA_API.cdaStep = cdaStep;
CDA_API.cdaResult = cdaResult;
CDA_API.cdaMove = cdaMove;
CDA_API.cdaHitsBodies = cdaHitsBodies;
CDA_API.cdaOpenDoor = cdaOpenDoor;
CDA_API.cdaLiftCheck = cdaLiftCheck;
