// ── zones: the rules of zones 6-15 as they play in the sim ──
// Owns the rule constants (PKS_EXPRESS ... PKS_OUTAGE), pksNoRules, the
// per-step rule scratch (pksLaneSpeed, pksSight, pksDownLane and the cell
// flags) and the step of every zone rule.  Uses core; inside function bodies
// also sim (pksEmit, pksDropDefender, pksLaneOpen), enemies (pksSpawnEnemy,
// pksShift) and enemies-late (pksHeavy).  Every rule is deterministic: none
// draws on the sim's RNG.
//
// A level of 51-150 carries level.rules (levels-late builds it); a level
// without the field (1-50, a hand-made test level) has no rule at all and
// plays exactly as before: every hook here is then a no-op (pksLaneSpeed 1,
// pksSight Infinity, pksDownLane -1, no rail, no hot cell, no tunnel).
//
// level.rules, always with every key (pksNoRules is the empty set):
//   names     the rule names the level has, in this order: 'express', 'hot',
//             'rails', 'tunnels', 'blackout', 'cross', 'upkeep', 'outage',
//             'fog' (fog itself is level.fog: columns from the right)
//   express   lanes whose enemies walk PKS_EXPRESS x as fast (every walker:
//             the boss too; a leap, a blink, a knockback keep their own
//             length).  It multiplies with the zone's speed, a slow and an
//             Amplifier's haste.
//   hot       [{lane, col}]: a defender on one (any kind, also under an
//             outage) loses PKS_HOT_DPS HP/s; destroyed there it goes with
//             why 'burnt' (a Backup restores it, onto the same hot cell).  A
//             Patch Server heals it as usual (40 HP/s against 8).
//   rails     [{lane, col}]: a defender on one works PKS_RAIL x as fast:
//             its action timer (t) runs down 1.5 steps a step (one more on
//             every even tick): a PSU's / UPS's production, every shot,
//             pulse, beam, trace, lob, knock, arc, pull and Decryptor shot,
//             a trap's arming and a Honeynet's re-arming, an instant's fuse,
//             a Backup's cooldown; the continuous ones are 1.5x strong: a WAF
//             Grate burns 30 HP/s, a Patch Server heals 60.  Not faster: the
//             damage of a hit, shots in flight, shells, the card's recharge,
//             walls, Canaries, the Signature DB's boost, encryption.
//   tunnels   [{lane, col, every}]: a tunnel exit at column col; the spawns
//             of the lane marked `tunnel: true` (every `every`-th, see
//             levels-late) do not walk in from the right: a shimmer shows on
//             the exit for PKS_SHIMMER s ('shimmer'), then the enemy appears
//             at x = col + 0.5 ('emerge' and its 'spawn').  Nothing can be
//             placed on an exit (pksCanPlace 'tunnel'): an enemy must never
//             appear inside a defender.  The level is won only when no
//             shimmer is left.
//   blackout  null | {every, length, warn, sight}: from `every` s on, every
//             `every` s the lights fail for `length` s, announced `warn` s
//             ahead ('blackoutWarn', then 'blackout' on / off).  While dark
//             the defenders that pick a target down their lane see only
//             `sight` cells ahead of their centre: the lane shooters
//             (Firewall, Tarpit, IDS, Scanner), Tracer, Batch Job, Loopback,
//             Token Ring (its first target; the jumps are not sight) and
//             Decryptor.  A shot already flying hits as usual.  Not dimmed:
//             the Packet Inspector's beam (it reads the wire), pulses, grates,
//             traps, instants, the Sinkhole's pull.
//   cross     [{lane, col, to}]: an arrow from lane to lane `to` (a
//             neighbour).  An enemy whose centre comes into (col - 0.5,
//             col + 0.5] of its lane moves to `to` ('cross', the lane change
//             slides like a Polymorph's), once per cell per enemy (crossed),
//             never into a lane that is not in play, never while it leaps or
//             is frozen.  The boss and a Kernel Panic are too heavy: they
//             walk over.  A defender may stand on a crossover cell: an enemy
//             stopped by it is not on the cell yet and crosses only once the
//             defender is gone.
//   upkeep    null | {cost, every}: every `every` s each installed defender
//             (instants on their fuse excepted) costs `cost` cycles
//             ('upkeep'); never below 0 cycles, and at 0 nothing is switched
//             off: the debt is simply not collected (a defence that dies of
//             its own bill would be unreadable and unrecoverable).  Phase 4
//             took away the doubled trickle the zone first came with: with
//             it the rule paid the player more than it cost (the bot did
//             better with it on than off), so the zone was easier than the
//             ones around it.
//   outage    null | {every, length, warn, order}: from `every` s on, every
//             `every` s the next lane of `order` (cycled) goes offline for
//             `length` s, announced `warn` s ahead ('outageWarn', then
//             'outage' on / off).  Its defenders do nothing and their timers
//             wait (production, shots, fuses, arming, encryption); they are
//             still bitten, burnt and shot; an armed trap there does not go
//             off (it is only bitten); a Signature DB or a Backup there helps
//             nobody.  A defender elsewhere still acts into that lane, and a
//             card may still be placed there (it waits).
//   trickle   cycles a passive trickle gives (25; 0 where level.trickle is
//             false, the power plant)
// State and events: see sim (shimmers, blackout, outage, upkeep).
//
// Overtime (every level with rules, i.e. 51-150): a level must end.  Every
// enemy walks to the rack, but a defence can hold one forever without
// killing it (a wall a Patch Server out-heals against a Drone, a Phisher
// throwing at a healed wall, an enemy no shooter of its lane can see).  So
// once every spawn is out and PKS_OVERTIME s have passed since the nominal
// end, the enemy nearest the rack breaks through: 'overtime', then the
// usual 'lose' with its lane, id and type.  The bots end every level well
// before that (the boss comes with the final surge, 50 s before the end).

var PKS_EXPRESS = 1.4;       // speed factor of an express lane
var PKS_HOT_DPS = 8;         // HP/s a hot cell takes from its defender
var PKS_RAIL = 1.5;          // work rate on a power rail
var PKS_TUNNEL_COL = 6;      // the column of a tunnel exit
var PKS_TUNNEL_EVERY = 3;    // every this many spawns of a tunnel lane come out of it
var PKS_SHIMMER = 2;         // seconds a tunnel shimmers before the enemy appears
var PKS_BLACKOUT = { every: 50, length: 10, warn: 3, sight: 4 };
var PKS_UPKEEP = { cost: 1, every: 12 };
var PKS_OUTAGE = { every: 40, length: 10, warn: 5 };
var PKS_LATE_FOG = 5;        // fog columns in the quantum lab
var PKS_ROOT_SPEED = 1.1;    // enemy speed factor at the root
var PKS_OVERTIME = 300;      // s past a late level's nominal end before it is lost

// Scratch (not state), set from the level's rules and the sim's clocks at
// the start of every step (pksZoneStep).
var pksLaneSpeed = [1, 1, 1, 1, 1];
var pksSight = Infinity;
var pksDownLane = -1;
var pksRailCells = [];
var pksHotCells = [];

// The empty rule set (what a level without `rules` plays by).
function pksNoRules() {
  return {
    names: [], express: [], hot: [], rails: [], tunnels: [], cross: [],
    blackout: null, upkeep: null, outage: null, trickle: PKS_TRICKLE
  };
}

var PKS_NO_RULES = pksNoRules();

function pksRules(level) {
  return level.rules || PKS_NO_RULES;
}

// The rule clocks of a new sim (sim.blackout, sim.outage, sim.upkeep).
function pksZoneState(sim) {
  var R = pksRules(sim.level);
  if (R.blackout) sim.blackout = { state: 'clear', t: pksSteps(R.blackout.every - R.blackout.warn), count: 0 };
  if (R.outage) sim.outage = { state: 'clear', lane: -1, next: R.outage.order[0], t: pksSteps(R.outage.every - R.outage.warn), count: 0 };
  if (R.upkeep) sim.upkeep = { t: pksSteps(R.upkeep.every), last: 0, due: 0 };
}

// One step of the zone rules, before anything acts: the scratch, the clocks
// (blackout, outage, upkeep) and the hot cells.
function pksZoneStep(sim) {
  var R = pksRules(sim.level);
  var i;
  for (i = 0; i < PKS_LANES; i++) pksLaneSpeed[i] = 1;
  for (i = 0; i < R.express.length; i++) pksLaneSpeed[R.express[i]] = PKS_EXPRESS;
  pksMarkCells(pksRailCells, R.rails);
  pksMarkCells(pksHotCells, R.hot);
  pksSight = Infinity;
  pksDownLane = -1;
  if (sim.blackout) pksBlackoutStep(sim, R.blackout);
  if (sim.outage) pksOutageStep(sim, R.outage);
  if (sim.upkeep) pksUpkeepStep(sim, R.upkeep);
  if (R.hot.length) pksHeat(sim);
}

function pksMarkCells(flags, cells) {
  var i;
  for (i = 0; i < PKS_LANES * PKS_COLS; i++) flags[i] = false;
  for (i = 0; i < cells.length; i++) flags[cells[i].lane * PKS_COLS + cells[i].col] = true;
}

// Whether d stands on a power rail; its work rate there.
function pksRailAt(d) {
  return pksRailCells[d.lane * PKS_COLS + d.col] === true;
}

function pksRailRate(d) {
  return pksRailAt(d) ? PKS_RAIL : 1;
}

// clear -> warn (warn s) -> dark (length s) -> clear (the rest of every s).
function pksBlackoutStep(sim, rule) {
  var b = sim.blackout;
  if (--b.t <= 0) {
    if (b.state === 'clear') {
      b.state = 'warn';
      b.t = pksSteps(rule.warn);
      pksEmit(sim, { type: 'blackoutWarn', at: pksTenth(sim.time + rule.warn), length: rule.length });
    } else if (b.state === 'warn') {
      b.state = 'dark';
      b.t = pksSteps(rule.length);
      b.count++;
      pksEmit(sim, { type: 'blackout', on: true });
    } else {
      b.state = 'clear';
      b.t = pksSteps(rule.every - rule.warn - rule.length);
      pksEmit(sim, { type: 'blackout', on: false });
    }
  }
  if (b.state === 'dark') pksSight = rule.sight;
}

// clear -> warn (the next lane) -> down -> clear, as the blackout.
function pksOutageStep(sim, rule) {
  var o = sim.outage;
  if (--o.t <= 0) {
    if (o.state === 'clear') {
      o.state = 'warn';
      o.lane = o.next;
      o.t = pksSteps(rule.warn);
      pksEmit(sim, { type: 'outageWarn', lane: o.lane, at: pksTenth(sim.time + rule.warn), length: rule.length });
    } else if (o.state === 'warn') {
      o.state = 'down';
      o.t = pksSteps(rule.length);
      o.count++;
      pksEmit(sim, { type: 'outage', lane: o.lane, on: true });
    } else {
      pksEmit(sim, { type: 'outage', lane: o.lane, on: false });
      o.state = 'clear';
      o.lane = -1;
      o.next = rule.order[o.count % rule.order.length];
      o.t = pksSteps(rule.every - rule.warn - rule.length);
    }
  }
  if (o.state === 'down') pksDownLane = o.lane;
}

// Every `every` s: cost per installed defender, as much as there is.
function pksUpkeepStep(sim, rule) {
  var u = sim.upkeep;
  if (--u.t > 0) return;
  u.t = pksSteps(rule.every);
  var due = 0;
  for (var i = 0; i < sim.defenders.length; i++) {
    if (sim.defenders[i].hp > 0 && sim.defenders[i].kind !== 'instant') due += rule.cost;
  }
  var take = Math.min(due, Math.max(0, sim.cycles));
  sim.cycles -= take;
  u.last = take;
  u.due = due;
  if (due > 0) pksEmit(sim, { type: 'upkeep', amount: take, due: due });
}

// Hot cells: PKS_HOT_DPS HP/s from every defender standing on one.
function pksHeat(sim) {
  var n = sim.defenders.length;
  for (var i = 0; i < n; i++) {
    var d = sim.defenders[i];
    if (d.hp <= 0 || !pksHotCells[d.lane * PKS_COLS + d.col]) continue;
    d.hp -= PKS_HOT_DPS / PKS_RATE;
    if (d.hp <= 0) pksDropDefender(sim, d, 'burnt');
  }
}

// The tunnel exit of `lane` on this level, or null.
function pksTunnelOf(level, lane) {
  var list = pksRules(level).tunnels;
  for (var i = 0; i < list.length; i++) {
    if (list[i].lane === lane) return list[i];
  }
  return null;
}

// Whether (lane, col) is a tunnel exit (nothing can be placed there).
function pksTunnelAt(level, lane, col) {
  var t = pksTunnelOf(level, lane);
  return t !== null && t.col === col;
}

// A spawn marked `tunnel`: a shimmer on its lane's exit.
function pksShimmer(sim, s) {
  var t = pksTunnelOf(sim.level, s.lane);
  var col = t ? t.col : PKS_TUNNEL_COL;
  var sh = { id: sim.nextId++, lane: s.lane, col: col, enemy: s.type, t: pksSteps(PKS_SHIMMER) };
  sim.shimmers.push(sh);
  pksEmit(sim, { type: 'shimmer', id: sh.id, lane: sh.lane, col: col, enemy: s.type, at: pksTenth(sim.time + PKS_SHIMMER) });
}

// Shimmers whose time is up release their enemy at the exit.
function pksEmerge(sim) {
  var list = sim.shimmers;
  var w = 0;
  for (var i = 0; i < list.length; i++) {
    var sh = list[i];
    if (--sh.t > 0) {
      list[w++] = sh;
      continue;
    }
    var e = pksSpawnEnemy(sim, sh.enemy, sh.lane, sh.col + 0.5, 0);
    pksEmit(sim, { type: 'emerge', id: e.id, shimmer: sh.id, enemy: sh.enemy, lane: sh.lane, col: sh.col, x: e.x });
  }
  list.length = w;
}

// At the end of a step: a late level held PKS_OVERTIME s past its end is
// lost to the enemy nearest the rack (a shimmer alone waits its 2 s).
function pksOvertime(sim) {
  var lv = sim.level;
  if (!lv.rules || sim.spawnIndex < lv.spawns.length || sim.time < lv.duration + PKS_OVERTIME || !sim.enemies.length) return;
  var e = sim.enemies[0];
  for (var i = 1; i < sim.enemies.length; i++) {
    if (sim.enemies[i].x < e.x) e = sim.enemies[i];
  }
  sim.status = 'lost';
  pksEmit(sim, { type: 'overtime', at: pksTenth(sim.time) });
  pksEmit(sim, { type: 'lose', lane: e.lane, id: e.id, enemy: e.type });
}

// After the enemies moved: crossovers.
function pksCrossings(sim) {
  var cross = pksRules(sim.level).cross;
  if (!cross.length) return;
  for (var i = 0; i < sim.enemies.length; i++) {
    var e = sim.enemies[i];
    if (e.hp <= 0 || e.frozen > 0 || e.state === 'leaping' || pksHeavy(e)) continue;
    for (var j = 0; j < cross.length; j++) {
      var c = cross[j];
      var key = c.lane * PKS_COLS + c.col;
      if (c.lane !== e.lane || e.x > c.col + 0.5 || e.x <= c.col - 0.5 || e.crossed.indexOf(key) >= 0 || !pksLaneOpen(sim, c.to)) continue;
      e.crossed.push(key);
      pksEmit(sim, { type: 'cross', id: e.id, from: e.lane, lane: c.to, col: c.col, x: e.x });
      pksShift(e, c.to);
      break;
    }
  }
}
