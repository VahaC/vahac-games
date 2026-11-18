// ── sim-enemies: the enemies' state, movement and attacks (crawler, drone, turret, loader) ──
// Owns cdaNewEnemy, cdaEnemiesStep, CDA_BEHAVIOUR and the behaviours of the
// four ordinary kinds.  Uses core, tables, map (the flow field, sight), sim
// (cdaEmit, cdaMove, cdaOpenDoor) and sim-combat (cdaSetState, cdaWake,
// cdaHurtPlayer, cdaSpawnShot); the chiller's own step is in sim-boss.
//
// An enemy: { id, kind (CDA_ENEMIES id), x, y, px, py (before this step:
// interpolate), angle (the way it moves or aims; sprites face the camera, so
// only effects need it), hp, maxHp, radius, state, t (steps in the current
// state, counting from 1 on the step after it began), cooldown (steps until
// it may start another attack), flash (the chiller's hurt frame, steps left;
// 0 from the moment it dies),
// side, sideT (a drone's strafing side, 1 | -1, and steps left on it), dir
// (a loader's charge direction), run (cells charged), burst (shots fired in
// the current burst or volley series), phase (the chiller's 1..3), loop (its
// place in CDA_BOSS.loop), summoned (called by the chiller: not counted in
// stats) }.  hp is 0 from the moment it dies.
//
// States and the frame a renderer shows (sprite names from the spec; F =
// floor(t / CDA_ANIM_WALK) % 2, dying: die0 while t < half of
// cdaSteps(CDA_DIE_TIME), then die1):
//   state     crawler, drone, loader            turret
//   asleep    walk0                             idle
//   alert     walk0 (woke: a short pause)       idle
//   chase     walkF (moving or hovering)        idle (watching)
//   windup    atk0 (the swing or the charging   aim (the lock-on)
//             spark); the loader: tell
//   attack    atk1 (the strike / the shot);     atk0 (the burst)
//             the loader: walkF (the charge)
//   hurt      hurt (a flinch)                   hurt
//   stun      the loader only: hurt
//   die       die0, die1                        die0, die1
//   dead      dead (the corpse stays)           dead
// The chiller (sim-boss): asleep, alert, idle, call: idle0 / idle1 by F;
// windup atk0; attack atk1; vent vent0 / vent1 by F; hurt while flash > 0
// (it stays in its state); die: die0, die1, die2 by thirds of
// cdaSteps(CDA_DIE_TIME); dead.
//
// Behaviour (numbers in CDA_ENEMIES):
//   asleep: wakes on seeing the player (a clear line within sight), on being
//     hurt, or on noise (sim-combat); then alert for `alert` s, facing the
//     player, then chase.  Once awake it never sleeps again and always knows
//     where the player is (the flow field).
//   chase: crawler and loader follow the flow field (straight at the player
//     from a neighbouring cell), opening plain doors on the way; the drone
//     holds keepMin..keepMax cells while it sees the player (backing off,
//     strafing) and follows the flow field otherwise; the turret watches.
//   windup -> attack -> chase: every attack has its tell first (see tables).
//   melee (the crawler's swing, the loader's charge) needs a clear line to
//     the player as well as the reach: a crawler starts its swing only when
//     it sees the player within reach, and a swing or a charge lands only
//     when it still does, so no blow ever goes through a wall corner.
//   hurt: `flinch` s, interrupting a windup or attack; the loader never
//     flinches.  stun: the loader after a charge, `stun` s.

var CDA_BEHAVIOUR = {
  crawler: { chase: cdaCrawlerChase, windup: cdaCrawlerWindup, attack: cdaRecover },
  drone: { chase: cdaDroneChase, windup: cdaDroneWindup, attack: cdaRecover },
  turret: { chase: cdaTurretChase, windup: cdaTurretWindup, attack: cdaTurretBurst },
  loader: { chase: cdaLoaderChase, windup: cdaLoaderWindup, attack: cdaLoaderCharge }
};

// The waiting states of the ordinary kinds and the CDA_ENEMIES field that
// says how long each lasts (then chase).
var CDA_WAITS = { alert: 'alert', hurt: 'flinch', stun: 'stun' };

function cdaNewEnemy(sim, kind, x, y, summoned) {
  var row = CDA_ENEMY[kind];
  var e = { id: sim.nextId++, kind: kind, x: x, y: y, px: x, py: y, angle: 0, hp: row.hp, maxHp: row.hp, radius: row.radius,
    state: 'asleep', t: 0, cooldown: 0, flash: 0, side: 1, sideT: 0, dir: 0, run: 0, burst: 0, phase: 1, loop: 0,
    summoned: summoned };
  sim.enemies.push(e);
  return e;
}

function cdaFacePlayer(sim, e) {
  e.angle = cdaAngleTo(e.x, e.y, sim.player.x, sim.player.y);
}

// Whether e has a clear line to the player within range cells.
function cdaSeesPlayer(sim, e, range) {
  var p = sim.player;
  return cdaDist(e.x, e.y, p.x, p.y) <= range && cdaSees(sim, e.x, e.y, p.x, p.y);
}

// The gap between e's body and the player's.
function cdaGap(sim, e) {
  var p = sim.player;
  return cdaDist(e.x, e.y, p.x, p.y) - e.radius - p.radius;
}

// Whether a melee blow from e reaches the player: a gap of at most reach and
// a clear line (see the header).
function cdaInReach(sim, e, reach) {
  var p = sim.player;
  return cdaGap(sim, e) <= reach && cdaSees(sim, e.x, e.y, p.x, p.y);
}

function cdaEnemyEvent(sim, type, e) {
  cdaEmit(sim, type, { id: e.id, kind: e.kind, x: e.x, y: e.y });
}

// Moves e at speed along angle a.  Returns whether anything stopped it.
function cdaEnemyGo(sim, e, a, speed) {
  e.angle = a;
  return cdaMove(sim, e, Math.cos(a) * speed * CDA_STEP, Math.sin(a) * speed * CDA_STEP);
}

// One step along the flow field toward the player (see the header).
function cdaChase(sim, e, speed) {
  var p = sim.player;
  var c = cdaCellOf(sim, e.x, e.y);
  var here = sim.flow[c];
  if (here < 0) return;
  var tx = p.x;
  var ty = p.y;
  if (here > 1) {
    var j = cdaFlowNext(sim, c);
    tx = j % sim.map.w + 0.5;
    ty = Math.floor(j / sim.map.w) + 0.5;
    if (sim.map.kind[j] === 'door') cdaOpenDoor(sim, sim.doors[sim.map.door[j]], 'enemy');
  }
  cdaEnemyGo(sim, e, cdaAngleTo(e.x, e.y, tx, ty), speed);
}

function cdaEnemiesStep(sim) {
  var n = sim.enemies.length;
  for (var i = 0; i < n; i++) {
    var e = sim.enemies[i];
    e.px = e.x;
    e.py = e.y;
    e.t++;
    if (e.cooldown > 0) e.cooldown--;
    cdaEnemyStep(sim, e, CDA_ENEMY[e.kind]);
  }
}

function cdaEnemyStep(sim, e, row) {
  var s = e.state;
  if (s === 'dead') return;
  if (s === 'asleep') {
    if (cdaSeesPlayer(sim, e, row.sight)) cdaWake(sim, e, 'sight');
    return;
  }
  if (s === 'die') {
    if (e.t >= cdaSteps(CDA_DIE_TIME)) cdaSetState(e, 'dead');
    return;
  }
  if (e.kind === 'chiller') {
    cdaBossStep(sim, e, row);
    return;
  }
  if (s in CDA_WAITS) {
    cdaFacePlayer(sim, e);
    if (e.t >= cdaSteps(row[CDA_WAITS[s]])) cdaSetState(e, 'chase');
    return;
  }
  CDA_BEHAVIOUR[e.kind][s](sim, e, row);
}

// attack -> chase once the strike frame has shown.
function cdaRecover(sim, e, row) {
  if (e.t >= cdaSteps(row.strike)) cdaSetState(e, 'chase');
}

// Starts the tell of an attack.
function cdaWindup(sim, e) {
  cdaSetState(e, 'windup');
  cdaEnemyEvent(sim, 'windup', e);
}

// ── crawler ──

function cdaCrawlerChase(sim, e, row) {
  cdaChase(sim, e, row.speed);
  if (e.cooldown === 0 && cdaInReach(sim, e, row.reach)) cdaWindup(sim, e);
}

function cdaCrawlerWindup(sim, e, row) {
  cdaFacePlayer(sim, e);
  if (e.t < cdaSteps(row.windup)) return;
  e.cooldown = cdaSteps(row.cooldown);
  cdaSetState(e, 'attack');
  cdaEnemyEvent(sim, 'attack', e);
  if (cdaInReach(sim, e, row.reach + row.slack)) cdaHurtPlayer(sim, row.damage, e.x, e.y, e.kind);
}

// ── drone ──

function cdaDroneChase(sim, e, row) {
  var p = sim.player;
  var d = cdaDist(e.x, e.y, p.x, p.y);
  var sees = cdaSees(sim, e.x, e.y, p.x, p.y);
  var toward = cdaAngleTo(e.x, e.y, p.x, p.y);
  if (!sees || d > row.keepMax) {
    cdaChase(sim, e, row.speed);
  } else if (d < row.keepMin) {
    cdaEnemyGo(sim, e, toward + Math.PI, row.speed);
  } else {
    e.sideT--;
    if (e.sideT <= 0) {
      e.side = -e.side;
      e.sideT = cdaSteps(row.strafe * (0.5 + cdaRand(sim)));
    }
    if (cdaEnemyGo(sim, e, toward + e.side * Math.PI / 2, row.speed)) e.side = -e.side;
  }
  if (e.cooldown === 0 && cdaSeesPlayer(sim, e, row.range)) cdaWindup(sim, e);
}

function cdaDroneWindup(sim, e, row) {
  cdaFacePlayer(sim, e);
  if (e.t < cdaSteps(row.windup)) return;
  e.cooldown = cdaSteps(row.cooldown);
  cdaSetState(e, 'attack');
  cdaEnemyEvent(sim, 'attack', e);
  cdaSpawnShot(sim, e, 'spark', e.angle, row.shotSpeed, row.damage);
}

// ── turret ──

function cdaTurretChase(sim, e, row) {
  if (!cdaSeesPlayer(sim, e, row.range)) return;
  cdaFacePlayer(sim, e);
  if (e.cooldown === 0) cdaWindup(sim, e);
}

function cdaTurretShot(sim, e, row) {
  cdaFacePlayer(sim, e);
  cdaSpawnShot(sim, e, 'bolt', e.angle, row.shotSpeed, row.damage);
  e.burst++;
}

// The lock-on: it holds while the turret sees the player.
function cdaTurretWindup(sim, e, row) {
  if (!cdaSeesPlayer(sim, e, row.range)) {
    e.cooldown = cdaSteps(row.relock);
    cdaSetState(e, 'chase');
    cdaEmit(sim, 'lockLost', { id: e.id, x: e.x, y: e.y });
    return;
  }
  cdaFacePlayer(sim, e);
  if (e.t < cdaSteps(row.windup)) return;
  cdaSetState(e, 'attack');
  cdaEnemyEvent(sim, 'attack', e);
  e.burst = 0;
  cdaTurretShot(sim, e, row);
}

// The burst: a bolt every `gap` s, aimed at the player each time.
function cdaTurretBurst(sim, e, row) {
  if (e.t % cdaSteps(row.gap) !== 0) return;
  if (e.burst < row.burst) {
    cdaTurretShot(sim, e, row);
    return;
  }
  e.cooldown = cdaSteps(row.cooldown);
  cdaSetState(e, 'chase');
}

// ── loader ──

function cdaLoaderChase(sim, e, row) {
  cdaChase(sim, e, row.speed);
  if (e.cooldown > 0 || !cdaSeesPlayer(sim, e, row.chargeRange)) return;
  cdaFacePlayer(sim, e);
  e.dir = e.angle;
  cdaWindup(sim, e);
}

// The telegraph: it faces the way it will charge.
function cdaLoaderWindup(sim, e, row) {
  if (e.t < cdaSteps(row.windup)) return;
  e.run = 0;
  cdaSetState(e, 'attack');
  cdaEnemyEvent(sim, 'attack', e);
}

function cdaLoaderCharge(sim, e, row) {
  var blocked = cdaEnemyGo(sim, e, e.dir, row.chargeSpeed);
  e.run += row.chargeSpeed * CDA_STEP;
  var hit = cdaInReach(sim, e, CDA_TOUCH);
  if (hit) cdaHurtPlayer(sim, row.damage, e.x, e.y, e.kind);
  if (!(hit || blocked || e.run >= row.chargeMax)) return;
  e.cooldown = cdaSteps(row.cooldown);
  cdaSetState(e, 'stun');
  cdaEmit(sim, 'stun', { id: e.id, x: e.x, y: e.y, hit: hit });
}

CDA_API.CDA_BEHAVIOUR = CDA_BEHAVIOUR;
CDA_API.cdaNewEnemy = cdaNewEnemy;
CDA_API.cdaEnemiesStep = cdaEnemiesStep;
CDA_API.cdaChase = cdaChase;
