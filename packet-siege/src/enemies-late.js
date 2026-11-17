// ── enemies: the expansion, 2 of 2 parts: the rules of the twelve new enemies ──
// Owns PKS_SLIDE_TIME, pksAuras and the step helpers of the enemies that
// levels 51-150 bring (their rows are in enemies, after the frozen 13).
// Uses core; inside function bodies also enemies (PKS_ENEMY, pksSpawnEnemy,
// pksKill, pksBlocker), sim (pksEmit, pksLane, pksCell, pksDropDefender)
// and defenders-late (PKS_SHOOTER_KINDS, pksBoostedNow).
// Every rule here is deterministic: none draws on the sim's RNG.
//
// The rules as they play (numbers from the rows):
//   Keylogger   while it bites (not while it casts, leaps or walks) it takes
//               one cycle every 1/steal s, never below 0 ('steal' events).
//   Logic Bomb  where it dies on the floor it explodes at the end of that
//               step: blast HP to every defender in the 3x3 around the cell
//               it stands in, grates and traps included ('detonate', and
//               destroyed why 'blast').  A breaker defuses it: killed by a
//               breaker, it does not explode; nor does one dying off the
//               floor.
// An aura (Amplifier, Hydra, Jammer) works while its enemy is on the floor
// and not frozen.
//   Amplifier   every OTHER enemy within `aura`
//               cells (centre to centre, a lane counting one cell) moves
//               haste % faster and takes guard % less damage from
//               everything but a breaker.  A second Amplifier adds nothing
//               (amped is a flag), but two Amplifiers amp each other.
//   Wiper       the first defender it touches (anything it would bite: walls,
//               Canaries and unarmed traps included; a WAF Grate is walked
//               over as usual) is destroyed outright (why 'wiped'), and the
//               Wiper dies with it (kill by 'wipe').  An armed Honeypot or
//               Honeynet goes off first and kills it.
//   Hive        while on the floor and not frozen, every `every` s it
//               releases a `release` (a DDoS Drone) where it stands, unless
//               `cap` of its own are alive; the timer starts at `every`.
//   Hydra       every OTHER damaged enemy within `aura`
//               cells regains heal HP/s, never above its full HP; one Hydra
//               heals an enemy per step (mended holds the tick), so two do
//               not stack.  It heals HP only, never a shield, and never a
//               heavy one (the boss, a Kernel Panic): a boss summoning
//               Hydras would otherwise heal itself through them.
//   Payload     its shield (shield / maxShield) takes every lane shot
//               ('shot' damage: Firewall, Tarpit, IDS, Scanner, Tracer)
//               first; what a shot has left after breaking it goes on into
//               HP.  Area, floor, beam, arc, shell and instant damage go past
//               it.  A shot into the shield does not slow.  A Decryptor's
//               shot strips the whole shield at once.
//   Jammer      a defender of a shooter kind
//               (PKS_SHOOTER_KINDS: lane shooters, beams, Tracer, Batch Job,
//               Token Ring, Decryptor) whose centre lies within `aura`
//               cells of it cannot fire (jammed; its timer still runs down).
//               Pulses, grates, walls, traps, generators, healers, the
//               Signature DB, Loopback, Sinkhole, Backup and instants work.
//               A boss of a tier with `jam` (bosses) jams the same way, its
//               aura being its tier's jam radius.
//   Replicator  generation 1 at full HP; when a hit leaves it at half its
//               full HP or below, even a killing hit (not a breaker or a
//               Scrubber, which kill outright), it is replaced by two copies
//               of the next generation with half its full HP each, at full
//               health, where it stood and 0.4 cells behind ('split');
//               generation 3 (of `gens`) does not split.  The copies keep
//               its slow and freeze; the hit that split it does not reach
//               them.  The level is won only when all of them are gone.
//   Dropper     on the floor, every `every` s it throws a `drop` (a Bot)
//               `ahead` cells toward the rack, over every defender but an
//               Air Gap: a gap in between cuts the throw short, the Bot
//               lands touching the gap.  It never lands left of minX (3:
//               a thrown Bot always has columns 0-2 behind it to be shot
//               from and 15 s of walking to the rack), and
//               it does not throw when the landing would be less than half
//               a cell ahead, nor while it is at a Canary.
//   Kernel Panic (titan)  a heavy: an instant does at most `cap` to it, it
//               crushes grates and honeypots like a Brute Forcer, a
//               Loopback throws it back only heavyPush and a Sinkhole
//               cannot pull it.  A breaker does not wipe it: like the boss
//               it is thrown back to PKS_BOSS_PUSH and loses
//               PKS_BOSS_BREAKER of its full HP (one tripped breaker must
//               not be the cheap answer to 4000 HP).
//   Glitch      on the floor, every `every` s it blinks `blink` cells
//               toward the rack, but never past the centre of a defender (a
//               grate does not count): it stops at most touching it, and
//               does not blink while it already touches one.
// Positions: moveFrom / move on the enemy let a renderer slide a knockback,
// a blink or a thrown Bot over PKS_SLIDE_TIME s.

var PKS_SLIDE_TIME = 0.3;    // seconds a knockback, blink or throw slides
var pksAmpScratch = [];      // the Amplifiers on the floor this step (not state)
var pksJamScratch = [];      // the Jammers on the floor this step (not state)

// Whether (lane, x) is within r cells of unit a (centre to centre, a lane
// counting one cell).
function pksNear(a, lane, x, r) {
  var dl = a.lane - lane;
  var dx = a.x - x;
  return dl * dl + dx * dx <= r * r;
}

// Whether e is in the aura of one of the units in `list` (not its own).
function pksInAura(e, list) {
  for (var i = 0; i < list.length; i++) {
    if (list[i] !== e && pksNear(list[i], e.lane, e.x, list[i].aura)) return true;
  }
  return false;
}

// At the start of every step: the auras (aura, amped), the jammed shooters
// ('jam' events on each change) and the Signature DB boosts.
function pksAuras(sim) {
  var i;
  pksAmpScratch.length = 0;
  pksJamScratch.length = 0;
  for (i = 0; i < sim.enemies.length; i++) {
    var e = sim.enemies[i];
    // a boss of a jamming tier (bosses) projects its jam radius as its aura
    var r = e.tier > 0 ? PKS_BOSS_TIERS[e.tier - 1].jam : PKS_ENEMY[e.type].aura;
    e.aura = r && e.frozen === 0 && e.x <= PKS_FLOOR_END ? r : 0;
    if (e.aura > 0 && e.type === 'amplifier') pksAmpScratch.push(e);
    if (e.aura > 0 && (e.type === 'jammer' || e.tier > 0)) pksJamScratch.push(e);
  }
  for (i = 0; i < sim.enemies.length; i++) sim.enemies[i].amped = pksAmpScratch.length > 0 && pksInAura(sim.enemies[i], pksAmpScratch);
  // only a step with a Signature DB on the floor looks for boosts
  var dbs = false;
  for (i = 0; i < sim.defenders.length; i++) {
    if (sim.defenders[i].type === 'sigdb') dbs = true;
  }
  for (i = 0; i < sim.defenders.length; i++) {
    var d = sim.defenders[i];
    var shooter = PKS_SHOOTER_KIND[d.kind] === true;
    var jam = shooter && pksJamScratch.length > 0 && pksJammedAt(d);
    if (jam !== d.jammed) {
      d.jammed = jam;
      pksEmit(sim, { type: 'jam', id: d.id, lane: d.lane, col: d.col, on: jam });
    }
    d.boosted = shooter && dbs && pksBoostedNow(sim, d);
  }
}

function pksJammedAt(d) {
  for (var i = 0; i < pksJamScratch.length; i++) {
    if (pksNear(pksJamScratch[i], d.lane, d.col + 0.5, pksJamScratch[i].aura)) return true;
  }
  return false;
}

// The steps of the expansion's enemies that act on their own (the boss has
// its own); the others need no step of theirs.
function pksLateEnemyAct(sim, e) {
  switch (e.type) {
    case 'hive':
      pksHiveAct(sim, e);
      break;
    case 'hydra':
      pksHydraAct(sim, e);
      break;
    case 'dropper':
      pksDropperAct(sim, e);
      break;
    case 'glitch':
      pksGlitchAct(sim, e);
      break;
  }
}

// An ability timer (t) that runs only on the floor; true when it is due.
function pksDue(e) {
  if (e.x > PKS_FLOOR_END) return false;
  if (e.t > 0) e.t--;
  return e.t === 0;
}

function pksHiveAct(sim, e) {
  var def = PKS_ENEMY.hive;
  if (!pksDue(e)) return;
  e.t = pksSteps(def.every);
  var own = 0;
  for (var i = 0; i < sim.enemies.length; i++) {
    if (sim.enemies[i].hive === e.id && sim.enemies[i].hp > 0) own++;
  }
  if (own >= def.cap) return;
  var c = pksSpawnEnemy(sim, def.release, e.lane, e.x, 0);
  c.hive = e.id;
  pksEmit(sim, { type: 'release', id: e.id, lane: e.lane, x: e.x, child: c.id });
}

function pksHydraAct(sim, e) {
  if (e.x > PKS_FLOOR_END) return;
  var def = PKS_ENEMY.hydra;
  for (var l = e.lane - 1; l <= e.lane + 1; l++) {
    var list = pksLane(l);
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o === e || o.hp <= 0 || o.hp >= o.maxHp || o.mended === sim.tick || pksHeavy(o) || !pksNear(e, o.lane, o.x, def.aura)) continue;
      o.mended = sim.tick;
      o.hp = Math.min(o.maxHp, o.hp + def.heal / PKS_RATE);
    }
  }
}

function pksDropperAct(sim, e) {
  var def = PKS_ENEMY.dropper;
  if (!pksDue(e)) return;
  e.t = pksSteps(def.every);
  var at = pksBlocker(e);
  if (at && at.kind === 'decoy') return;
  var to = e.x - def.ahead;
  for (var col = 0; col < PKS_COLS; col++) {
    var g = pksCell(e.lane, col);
    if (g && g.type === 'airgap' && col + 0.5 > to && col + 0.5 < e.x) to = col + 0.5 + PKS_REACH;
  }
  to = Math.max(to, def.minX);
  if (to > e.x - 0.5) return;
  var b = pksSpawnEnemy(sim, def.drop, e.lane, to, 0);
  b.moveFrom = e.x;
  b.move = pksSteps(PKS_SLIDE_TIME);
  pksEmit(sim, { type: 'throw', id: e.id, lane: e.lane, x: e.x, to: to, child: b.id });
}

function pksGlitchAct(sim, e) {
  var def = PKS_ENEMY.glitch;
  if (!pksDue(e)) return;
  e.t = pksSteps(def.every);
  // inside a defender's cell (pksInside) it touches that one
  if (pksInside(e)) return;
  var to = e.x - def.blink;
  for (var col = 0; col < PKS_COLS; col++) {
    var d = pksCell(e.lane, col);
    if (d && d.kind !== 'floor' && col + 0.5 < e.x) to = Math.max(to, col + 0.5 + PKS_REACH);
  }
  if (to >= e.x) return;
  pksEmit(sim, { type: 'blink', id: e.id, lane: e.lane, x: e.x, to: to });
  e.moveFrom = e.x;
  e.x = to;
  e.move = pksSteps(PKS_SLIDE_TIME);
}

// Keylogger, one step of its bite: a cycle every 1/steal s.
function pksSteal(sim, e) {
  if (e.t > 0) e.t--;
  if (e.t > 0) return;
  e.t = pksSteps(1 / PKS_ENEMY.keylogger.steal);
  if (sim.cycles <= 0) return;
  sim.cycles--;
  pksEmit(sim, { type: 'steal', id: e.id, lane: e.lane, x: e.x, amount: 1 });
}

// Wiper: the defender it touches is gone, and so is the Wiper.
function pksWipe(sim, e, d) {
  pksEmit(sim, { type: 'wipe', id: d.id, def: d.type, by: e.id, lane: d.lane, col: d.col });
  pksDropDefender(sim, d, 'wiped');
  pksKill(sim, e, 'wipe');
}

// What stops an Exploit's leap: a Reverse Proxy, an Air Gap or a Canary.
function pksStopsLeap(d) {
  return d.type === 'proxy' || d.type === 'airgap' || d.kind === 'decoy';
}

// A lane shot of dmg into e's shield: returns what goes on into HP.
function pksShieldTake(sim, e, dmg) {
  e.flash = PKS_FLASH;
  if (dmg < e.shield) {
    e.shield -= dmg;
    return 0;
  }
  dmg -= e.shield;
  e.shield = 0;
  pksEmit(sim, { type: 'shieldBreak', id: e.id, lane: e.lane, x: e.x, by: 'shot' });
  return dmg;
}

// Replicator: two copies of the next generation take its place.
function pksSplit(sim, e) {
  e.hp = 0;
  var a = pksCopy(sim, e, e.x);
  var b = pksCopy(sim, e, Math.min(PKS_SPAWN_X, e.x + 0.4));
  pksEmit(sim, { type: 'split', id: e.id, lane: e.lane, x: e.x, gen: e.gen + 1, children: [a.id, b.id] });
}

function pksCopy(sim, e, x) {
  var c = pksSpawnEnemy(sim, 'replicator', e.lane, x, 0);
  c.gen = e.gen + 1;
  c.maxHp = e.maxHp / 2;
  c.hp = c.maxHp;
  c.slow = e.slow;
  c.frozen = e.frozen;
  return c;
}

// The heavy enemies: the boss and the Kernel Panic.
function pksHeavy(e) {
  return e.tier > 0 || e.type === 'titan';
}

// At the end of a step: every Logic Bomb that died in it explodes.
function pksBlasts(sim) {
  for (var i = 0; i < sim.enemies.length; i++) {
    var e = sim.enemies[i];
    if (e.type === 'logicbomb' && e.used) {
      e.used = false;
      pksDetonate(sim, e);
    }
  }
}

function pksDetonate(sim, e) {
  if (e.x > PKS_FLOOR_END) return;
  var dmg = PKS_ENEMY.logicbomb.blast;
  var col = Math.max(0, Math.min(PKS_COLS - 1, Math.floor(e.x)));
  pksEmit(sim, { type: 'detonate', id: e.id, lane: e.lane, x: e.x, col: col, dmg: dmg });
  for (var l = e.lane - 1; l <= e.lane + 1; l++) {
    for (var c = col - 1; c <= col + 1; c++) {
      var d = pksCell(l, c);
      if (!d) continue;
      d.hp -= dmg;
      d.flash = PKS_FLASH;
      if (d.hp <= 0) pksDropDefender(sim, d, 'blast');
    }
  }
}
