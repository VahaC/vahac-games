// ── sim-combat: tools, rays, enemy projectiles, damage both ways, noise ──
// Owns CDA_TOUCH, CDA_BODY_MAX, cdaBodyMax, cdaPlayerTool, cdaSwitch,
// cdaFire, cdaRayAttack, cdaDamageEnemy, cdaKill, cdaWake, cdaSetState,
// cdaNoise, cdaHurtPlayer, cdaSpawnShot and cdaShotsStep.  Uses core, tables, map and sim (cdaEmit, cdaLiftCheck);
// inside function bodies also sim-boss (cdaBossDamage).
//
// Firing: a tool fires while fire is held and its cooldown is over (and no
// switch is under way).  One use costs one round of its ammo kind; with none
// left the driver comes into hand instead (switch {auto: true}) and nothing
// fires that step.  A use fires the tool's rays (CDA_TOOLS: one straight
// ahead, or `rays` spread evenly over `fan`); each ray hits the nearest
// living enemy it passes within (radius + slack) before a wall, or puffs on
// the wall (a `wall` event) when it reaches one within its reach.  Reach is
// measured to the enemy's surface: its centre's distance along the ray
// minus its radius must be below the tool's reach (the driver hits the
// chiller and a loader from outside them), so the wall is looked for up to
// reach + CDA_BODY_MAX, the widest body's radius.  Every use makes noise:
// asleep enemies within the tool's noise in flow steps wake.
// Killing an enemy clears its hurt flash (a chiller killed through its
// vents shows its die frames, not the hurt one).
//
// Enemy projectiles fly straight from the enemy's centre at a fixed speed,
// never hurt enemies, and end on the player (radius + CDA_SHOT_RADIUS) or in
// the first solid cell.  The player's armour absorbs
// floor(damage * CDA_PLAYER.armourShare) of each hit while it lasts.

var CDA_TOUCH = 0.05;   // a gap between two bodies this small counts as touching
var CDA_BODY_MAX = cdaBodyMax();

// The radius of the widest enemy body (see the header).
function cdaBodyMax() {
  var r = 0;
  for (var i = 0; i < CDA_ENEMIES.length; i++) r = Math.max(r, CDA_ENEMIES[i].radius);
  return r;
}

function cdaSetState(e, state) {
  e.state = state;
  e.t = 0;
}

function cdaSwitch(sim, id, auto) {
  var p = sim.player;
  p.tool = id;
  p.switchT = cdaSteps(CDA_PLAYER.switchTime);
  cdaEmit(sim, 'switch', { tool: id, auto: auto });
}

// The tool part of a step: timers, a switch request, firing.
function cdaPlayerTool(sim, input) {
  var p = sim.player;
  if (p.cooldown > 0) p.cooldown--;
  if (p.switchT > 0) p.switchT--;
  p.fireT++;
  var want = CDA_TOOLS[input.weapon - 1];
  if (want && want.id !== p.tool && p.tools.indexOf(want.id) >= 0) cdaSwitch(sim, want.id, false);
  if (input.fire) cdaFire(sim);
}

function cdaFire(sim) {
  var p = sim.player;
  var tool = sim.tools[p.tool];
  if (p.cooldown > 0 || p.switchT > 0) return;
  if (tool.ammo) {
    if (p.ammo[tool.ammo] === 0) {
      cdaSwitch(sim, 'driver', true);
      return;
    }
    p.ammo[tool.ammo]--;
  }
  p.cooldown = tool.cooldown;
  p.fireT = 0;
  sim.stats.shots++;
  cdaEmit(sim, 'shot', { tool: p.tool, x: p.x, y: p.y, angle: p.angle });
  for (var k = 0; k < tool.rays; k++) cdaRayAttack(sim, p.angle + tool.fan * ((k + 0.5) / tool.rays - 0.5), tool);
  cdaNoise(sim, tool.noise);
}

// One ray of a tool from the player along angle a.
function cdaRayAttack(sim, a, tool) {
  var p = sim.player;
  var dx = Math.cos(a);
  var dy = Math.sin(a);
  var wall = cdaCast(sim, p.x, p.y, dx, dy, tool.reach + CDA_BODY_MAX, false);
  var best = null;
  var bestT = wall.dist;
  for (var i = 0; i < sim.enemies.length; i++) {
    var e = sim.enemies[i];
    var ox = e.x - p.x;
    var oy = e.y - p.y;
    var t = ox * dx + oy * dy;
    var r = e.radius + tool.slack;
    if (e.hp > 0 && t > 0 && t < bestT && t - e.radius < tool.reach && ox * ox + oy * oy - t * t < r * r) {
      best = e;
      bestT = t;
    }
  }
  if (best) cdaDamageEnemy(sim, best, bestT > tool.falloff ? tool.damage * tool.far : tool.damage, p.x + dx * bestT, p.y + dy * bestT);
  else if (wall.cell >= 0 && wall.dist <= tool.reach) cdaEmit(sim, 'wall', { x: wall.x, y: wall.y, cell: wall.cell });
}

// Damage to enemy e, hit at (hx, hy).
function cdaDamageEnemy(sim, e, dmg, hx, hy) {
  if (e.kind === 'chiller') {
    cdaBossDamage(sim, e, dmg, hx, hy);
    return;
  }
  e.hp -= dmg;
  cdaEmit(sim, 'hit', { id: e.id, kind: e.kind, x: hx, y: hy, damage: dmg, blocked: false });
  if (e.hp <= 0) {
    cdaKill(sim, e);
    return;
  }
  cdaWake(sim, e, 'hurt');
  if (CDA_ENEMY[e.kind].flinch > 0) cdaSetState(e, 'hurt');
}

function cdaKill(sim, e) {
  e.hp = 0;
  e.flash = 0;
  cdaSetState(e, 'die');
  if (!e.summoned) sim.stats.kills++;
  cdaEmit(sim, 'die', { id: e.id, kind: e.kind, x: e.x, y: e.y });
  cdaLiftCheck(sim);
}

function cdaWake(sim, e, why) {
  if (e.state !== 'asleep') return;
  cdaSetState(e, 'alert');
  cdaEmit(sim, 'wake', { id: e.id, kind: e.kind, why: why });
}

// Wakes the asleep enemies within `range` flow steps of the player.
function cdaNoise(sim, range) {
  for (var i = 0; i < sim.enemies.length; i++) {
    var e = sim.enemies[i];
    var f = sim.flow[cdaCellOf(sim, e.x, e.y)];
    if (f >= 0 && f <= range) cdaWake(sim, e, 'noise');
  }
}

// dmg to the player from (x, y), by an enemy or projectile kind.
function cdaHurtPlayer(sim, dmg, x, y, by) {
  var p = sim.player;
  var absorbed = Math.min(p.armour, Math.floor(dmg * CDA_PLAYER.armourShare));
  p.armour -= absorbed;
  p.health = Math.max(0, p.health - (dmg - absorbed));
  cdaEmit(sim, 'hurt', { damage: dmg - absorbed, absorbed: absorbed, health: p.health, armour: p.armour, x: x, y: y, by: by });
  if (p.health === 0 && sim.status === 'playing') {
    sim.status = 'dead';
    cdaEmit(sim, 'death', {});
  }
}

// A projectile of `kind` from enemy e along angle a.
function cdaSpawnShot(sim, e, kind, a, speed, damage) {
  var s = { id: sim.nextId++, kind: kind, owner: e.id, x: e.x, y: e.y, px: e.x, py: e.y, dx: Math.cos(a), dy: Math.sin(a),
    speed: speed, damage: damage };
  sim.shots.push(s);
  cdaEmit(sim, 'fire', { id: s.id, kind: kind, owner: e.id, x: e.x, y: e.y, angle: a });
}

function cdaShotsStep(sim) {
  var p = sim.player;
  var keep = [];
  for (var i = 0; i < sim.shots.length; i++) {
    var s = sim.shots[i];
    s.px = s.x;
    s.py = s.y;
    s.x += s.dx * s.speed * CDA_STEP;
    s.y += s.dy * s.speed * CDA_STEP;
    if (cdaDist(s.x, s.y, p.x, p.y) < p.radius + CDA_SHOT_RADIUS) {
      cdaEmit(sim, 'shotEnd', { id: s.id, kind: s.kind, x: s.x, y: s.y, hit: 'player' });
      cdaHurtPlayer(sim, s.damage, s.x - s.dx, s.y - s.dy, s.kind);
    } else if (cdaSolid(sim, cdaCellOf(sim, s.x, s.y))) {
      cdaEmit(sim, 'shotEnd', { id: s.id, kind: s.kind, x: s.x, y: s.y, hit: 'wall' });
    } else {
      keep.push(s);
    }
  }
  sim.shots = keep;
}

CDA_API.CDA_TOUCH = CDA_TOUCH;
CDA_API.CDA_BODY_MAX = CDA_BODY_MAX;
CDA_API.cdaSwitch = cdaSwitch;
CDA_API.cdaFire = cdaFire;
CDA_API.cdaDamageEnemy = cdaDamageEnemy;
CDA_API.cdaWake = cdaWake;
CDA_API.cdaNoise = cdaNoise;
CDA_API.cdaHurtPlayer = cdaHurtPlayer;
CDA_API.cdaSpawnShot = cdaSpawnShot;
