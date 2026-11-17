// ── sim: a new sim, the fixed step, placing and removing, win and loss ──
// Owns pksNewSim, pksStep, pksCanPlace, pksPlace, pksRemove, pksStars and
// the step helpers the other parts call (pksEmit, pksShoot, pksLane,
// pksCell, pksTargetAhead, pksLaneOpen, pksDropDefender).  Uses core,
// defenders, enemies and levels; inside function bodies also zones
// (pksZoneState, pksZoneStep, pksCrossings, pksShimmer, pksEmerge,
// pksTunnelAt, pksSight, pksOvertime).
//
// The sim is plain data (numbers, strings, arrays, plain objects): a
// renderer reads it, JSON.stringify snapshots it, and a JSON copy plays on
// exactly like the original.  pksStep changes it in place by one step of
// 1/60 s and is deterministic: its only randomness is the mulberry32 state in
// sim.rng.
//
// The state:
//   level      the level object (pksLevel); n its number
//   tick, time steps and seconds since the start
//   status     'playing' | 'won' | 'lost'; stars 1-3 once won
//   cycles     whole cycles; trickleT steps to the next passive trickle
//   cards      [{ id, cost, recharge (steps), left (steps until ready) }]
//   defenders  see pksNewDefender (defenders part); enemies: pksSpawnEnemy
//   shots      [{ id, kind ('drop' | 'tar' | 'phish' | 'volley'), lane, x,
//              from, dir (1 right, -1 left), dmg, slow (s), owner, done }]
//   breakers   per lane 'armed' | 'tripped' | 'off' (not in play); tripped
//              counts the tripped ones
//   spawnIndex next spawn of level.spawns; warned / surged: surges announced
//              and started
//   nextId     the next unit id (defenders, enemies and shots share them)
//   stats      { kills, placed, spent, produced }
//   events     what happened in the last step, plus what pksPlace and
//              pksRemove did since; each is { type, ... }:
//     spawn {id, enemy, lane, x}            shot {id, kind, owner, lane, x}
//     hit {id (target), shot, kind, lane, x, dmg}
//     kill {id, enemy, lane, x, by ('shot' | 'area' | 'instant' | 'breaker')}
//     placed {id, def, lane, col, cost}     removed {id, def, lane, col}
//     destroyed {id, def, lane, col, why ('eaten' | 'shot' | 'crushed' | 'spent')}
//     produce {id, lane, col, amount}       trickle {amount}
//     armed {id, lane, col}                 pulse / beam / blast / freeze {id, def, lane, col}
//     encrypt {id (defender), by, lane, col}   disabled {id, lane, col}
//     cleared {id, lane, col}               leap {id, lane, x, to}
//     morph {id, from, lane, x}  (a Polymorph or the boss changing lanes)
//     summon {id, lane, x}                  cloak {id, lane, x, on}
//     surgeWarn {index, at}  surge {index}  breaker {lane}
//     lose {lane, id, enemy}  win {stars}   unlock {def}
//   and the expansion's (rules in enemies-late and defenders-late):
//     shells     [{ id, owner, lane, from, to (x), t (steps left), flight
//                (steps in all), dmg, splash (cells), done }]: Batch Job
//                shells in the air
//     kill.by also 'wipe' (a Wiper dying with what it wiped); destroyed.why
//       also 'wiped' and 'blast' (a Logic Bomb); hit.kind also 'decrypt'
//       and, for a shot an Air Gap sent back, 'phish' / 'volley' again
//     steal {id, lane, x, amount}           detonate {id, lane, x, col, dmg}
//     wipe {id (defender), def, by, lane, col}
//     release {id (Hive), lane, x, child}   throw {id (Dropper), lane, x, to, child}
//     split {id, lane, x, gen (of the copies), children [id, id]}
//     shieldBreak {id, lane, x, by ('shot' | 'decrypt')}
//     blink {id, lane, x, to}               jam {id (defender), lane, col, on}
//     trace {id, def, lane, col, target, x, dmg}
//     lob {id, def, lane, col, shell, to, flight (steps)}
//     splash {id (shell), owner, lane, x, radius}
//     knock {id, def, target, lane, from, to}   (x before and after)
//     arc {id, def, lane, col, dmg, path [{id, lane, x}, ...]}
//     pull {id, def, target, from (lane), lane, x}
//     reflect {id (shot), by (Air Gap), lane, x, owner}
//     restore {id (the new defender), by (Backup), old, def, lane, col}
//     scrub {id, def, lane, col}
//   and the zone rules of levels 51-150 (level.rules; zones has the rules):
//     shimmers   [{ id, lane, col, enemy (type), t (steps until it comes
//                out) }]: tunnel exits about to release an enemy
//     blackout   null, or { state ('clear' | 'warn' | 'dark'), t (steps until
//                the state changes), count (blackouts begun) }
//     outage     null, or { state ('clear' | 'warn' | 'down'), lane (the lane
//                warned or down, -1 while clear), next (the lane of the next
//                outage), t, count (outages begun) }
//     upkeep     null, or { t (steps to the next charge), last (cycles it
//                took last time), due (what was due then) }
//     shimmer {id, lane, col, enemy, at (s it comes out)}
//     emerge {id (the enemy), shimmer, enemy, lane, col, x}  (and its spawn)
//     cross {id, from, lane, col, x}        (an enemy taking a crossover)
//     blackoutWarn {at, length}  blackout {on}
//     outageWarn {lane, at, length}  outage {lane, on}
//     upkeep {amount (taken), due}
//     destroyed.why also 'burnt' (a hot cell)
//     shieldUp {id, lane, x, shield}  bossSplit {id, lane, x, children [id, id]}
//     overtime {at}  (just before the 'lose' of a level that ran
//                    PKS_OVERTIME s past its nominal end, see zones)

// Scratch lookups rebuilt from the sim at the start of every step (not
// state): the living enemies of each lane, and the defender of each cell.
var pksLaneScratch = [[], [], [], [], []];
var pksCellScratch = [];
var pksNoLane = [];
// Whether this step is of a level past PKS_FROZEN_LEVELS (set by pksStep).
// Two fixes of the sim review hold there only, so that levels 1-50 play
// exactly as they always did: an enemy that changed lanes during a step has
// left its old lane's list at once (pksInLane), and an enemy that arrived
// inside a defender's cell is stopped by it (pksInside, enemies).
var pksLateStep = false;

function pksIndexField(sim) {
  var i;
  for (i = 0; i < PKS_LANES; i++) pksLaneScratch[i].length = 0;
  for (i = 0; i < PKS_LANES * PKS_COLS; i++) pksCellScratch[i] = null;
  for (i = 0; i < sim.enemies.length; i++) pksLaneScratch[sim.enemies[i].lane].push(sim.enemies[i]);
  for (i = 0; i < sim.defenders.length; i++) {
    var d = sim.defenders[i];
    pksCellScratch[d.lane * PKS_COLS + d.col] = d;
  }
}

// The enemies of a lane this step (some may have died since, and past level
// 50 some may have left the lane since: see pksInLane), or none.
function pksLane(lane) {
  return lane >= 0 && lane < PKS_LANES ? pksLaneScratch[lane] : pksNoLane;
}

// Whether e, taken from the list of `lane`, is still in that lane.  Past
// level 50 an enemy pulled (or crossed, morphed, moved by the boss's lane
// change) earlier in the step is no longer a target in its old lane; it
// becomes one in its new lane with the next step, like an enemy spawned
// mid-step.  Levels 1-50 keep the lists of the step's start.
function pksInLane(e, lane) {
  return e.lane === lane || !pksLateStep;
}

// The living defender on a cell this step, or null.
function pksCell(lane, col) {
  if (lane < 0 || lane >= PKS_LANES || col < 0 || col >= PKS_COLS) return null;
  var d = pksCellScratch[lane * PKS_COLS + col];
  return d && d.hp > 0 ? d : null;
}

// Whether a lane shot from x would find a visible enemy on the floor (in a
// blackout only within pksSight cells of x, see zones).
function pksTargetAhead(lane, x) {
  var list = pksLane(lane);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e.hp > 0 && !e.cloaked && e.x > x && e.x <= PKS_FLOOR_END && e.x <= x + pksSight && pksInLane(e, lane)) return true;
  }
  return false;
}

function pksLaneOpen(sim, lane) {
  return lane >= 0 && lane < PKS_LANES && sim.breakers[lane] !== 'off';
}

function pksEmit(sim, event) {
  sim.events.push(event);
}

// A shot: kind 'drop' / 'tar' (defenders, dir 1) or 'phish' / 'volley'
// (enemies, dir -1); from is where it left, owner the unit that fired it.
function pksShoot(sim, kind, lane, x, dir, dmg, owner, slow) {
  var s = { id: sim.nextId++, kind: kind, lane: lane, x: x, from: x, dir: dir, dmg: dmg, slow: slow, owner: owner.id, done: false };
  sim.shots.push(s);
  pksEmit(sim, { type: 'shot', id: s.id, kind: kind, owner: owner.id, lane: lane, x: x });
}

// A defender leaves the field: why is 'eaten', 'shot', 'crushed' or 'spent'
// (and 'wiped' or 'blast' in the expansion).  Unless it was spent, a Backup
// next to it may put a new one in its place at once (pksRestore).
function pksDropDefender(sim, d, why) {
  d.hp = 0;
  pksEmit(sim, { type: 'destroyed', id: d.id, def: d.type, lane: d.lane, col: d.col, why: why });
  if (why !== 'spent') pksRestore(sim, d);
}

// A new sim of `level` (a level number, or a level object as pksLevel
// returns it) with the cards of `loadout` (defender ids; unknown ids and
// repeats are dropped).
function pksNewSim(level, loadout) {
  var lv = typeof level === 'number' ? pksLevel(level) : level;
  var sim = {
    level: lv, n: lv.n, tick: 0, time: 0, rng: (lv.n * 7919 + 17) | 0, status: 'playing',
    cycles: lv.startCycles, trickleT: pksSteps(PKS_TRICKLE_EVERY),
    cards: [], defenders: [], enemies: [], shots: [], shells: [],
    breakers: [], tripped: 0, spawnIndex: 0, warned: 0, surged: 0,
    nextId: 1, stars: 0, events: [],
    stats: { kills: 0, placed: 0, spent: 0, produced: 0 },
    shimmers: [], blackout: null, outage: null, upkeep: null
  };
  pksZoneState(sim);
  var i;
  for (i = 0; i < PKS_LANES; i++) sim.breakers.push(lv.lanes.indexOf(i) === -1 ? 'off' : 'armed');
  for (i = 0; i < loadout.length; i++) {
    var def = PKS_DEF[loadout[i]];
    if (!def || pksCard(sim, def.id)) continue;
    sim.cards.push({ id: def.id, cost: def.cost, recharge: pksSteps(def.recharge), left: 0 });
  }
  return sim;
}

function pksCard(sim, id) {
  for (var i = 0; i < sim.cards.length; i++) {
    if (sim.cards[i].id === id) return sim.cards[i];
  }
  return null;
}

function pksOccupant(sim, lane, col) {
  for (var i = 0; i < sim.defenders.length; i++) {
    var d = sim.defenders[i];
    if (d.lane === lane && d.col === col && d.hp > 0) return d;
  }
  return null;
}

function pksIsBlocked(level, lane, col) {
  for (var i = 0; i < level.blocked.length; i++) {
    if (level.blocked[i].lane === lane && level.blocked[i].col === col) return true;
  }
  return false;
}

function pksOnField(lane, col) {
  return lane >= 0 && lane < PKS_LANES && col >= 0 && col < PKS_COLS && lane === Math.floor(lane) && col === Math.floor(col);
}

// Whether card `cardId` can go on (lane, col) now.  Always returns
// { ok, reason, card, lane, col } plus the values a UI needs to explain a
// refusal:
//   'over'        the level has ended
//   'no-card'     the card is not in the loadout
//   'recharging'  seconds (left, rounded up to 0.1 s), recharge (its full
//                 time in s), cost, cycles
//   'cycles'      have, need
//   'off-field'   lane/col are not a cell
//   'lane-closed' lanes (the lanes in play)
//   'blocked'     a cable tray
//   'tunnel'      a tunnel exit (zones: nothing stands where enemies come out)
//   'occupied'    occupant (its type), occupantId
// ok is true with reason null when it fits (cost and cycles are set too).
function pksCanPlace(sim, cardId, lane, col) {
  var r = { ok: false, reason: null, card: cardId, lane: lane, col: col };
  var card = pksCard(sim, cardId);
  var occupant;
  if (sim.status !== 'playing') {
    r.reason = 'over';
  } else if (!card) {
    r.reason = 'no-card';
  } else if (card.left > 0) {
    r.reason = 'recharging';
    r.seconds = Math.ceil(card.left / (PKS_RATE / 10)) / 10;
    r.recharge = card.recharge / PKS_RATE;
  } else if (sim.cycles < card.cost) {
    r.reason = 'cycles';
    r.have = sim.cycles;
    r.need = card.cost;
  } else if (!pksOnField(lane, col)) {
    r.reason = 'off-field';
  } else if (!pksLaneOpen(sim, lane)) {
    r.reason = 'lane-closed';
    r.lanes = sim.level.lanes.slice();
  } else if (pksIsBlocked(sim.level, lane, col)) {
    r.reason = 'blocked';
  } else if (pksTunnelAt(sim.level, lane, col)) {
    r.reason = 'tunnel';
  } else if ((occupant = pksOccupant(sim, lane, col)) !== null) {
    r.reason = 'occupied';
    r.occupant = occupant.type;
    r.occupantId = occupant.id;
  } else {
    r.ok = true;
  }
  if (card) {
    r.cost = card.cost;
    r.cycles = sim.cycles;
  }
  return r;
}

// Places card `cardId` on (lane, col) when pksCanPlace allows it: pays,
// starts the card's recharge, adds a 'placed' event.  Returns the
// pksCanPlace result, with id (the new defender's) when it was placed.
function pksPlace(sim, cardId, lane, col) {
  var r = pksCanPlace(sim, cardId, lane, col);
  if (!r.ok) return r;
  var card = pksCard(sim, cardId);
  var d = pksNewDefender(sim, cardId, lane, col);
  sim.defenders.push(d);
  sim.cycles -= card.cost;
  card.left = card.recharge;
  sim.stats.placed++;
  sim.stats.spent += card.cost;
  r.id = d.id;
  pksEmit(sim, { type: 'placed', id: d.id, def: cardId, lane: lane, col: col, cost: card.cost });
  return r;
}

// Decommission: removes the defender on (lane, col), no refund.  Returns
// { ok, reason ('over' | 'empty' | null), lane, col, id, def }.
function pksRemove(sim, lane, col) {
  var r = { ok: false, reason: null, lane: lane, col: col };
  var d = pksOccupant(sim, lane, col);
  if (sim.status !== 'playing') {
    r.reason = 'over';
  } else if (!d) {
    r.reason = 'empty';
  } else {
    sim.defenders.splice(sim.defenders.indexOf(d), 1);
    r.ok = true;
    r.id = d.id;
    r.def = d.type;
    pksEmit(sim, { type: 'removed', id: d.id, def: d.type, lane: lane, col: col });
  }
  return r;
}

// 3 stars: no breaker tripped; 2: one or two; 1: more; 0 until won.
function pksStars(sim) {
  if (sim.status !== 'won') return 0;
  if (sim.tripped === 0) return 3;
  return sim.tripped <= 2 ? 2 : 1;
}

// One step (1/60 s) of the sim, in place.  Returns the sim.
function pksStep(sim) {
  sim.events = [];
  if (sim.status !== 'playing') return sim;
  sim.tick++;
  sim.time = sim.tick / PKS_RATE;
  pksLateStep = sim.n > PKS_FROZEN_LEVELS;
  pksEconomy(sim);
  pksSpawns(sim);
  pksZoneStep(sim);
  pksIndexField(sim);
  pksAuras(sim);
  var i;
  for (i = 0; i < sim.defenders.length; i++) {
    if (sim.defenders[i].hp > 0) pksDefenderAct(sim, sim.defenders[i]);
  }
  for (i = 0; i < sim.shots.length; i++) pksShotAct(sim, sim.shots[i]);
  for (i = 0; i < sim.shells.length; i++) pksShellAct(sim, sim.shells[i]);
  for (i = 0; i < sim.enemies.length && sim.status === 'playing'; i++) {
    if (sim.enemies[i].hp > 0) pksEnemyAct(sim, sim.enemies[i]);
  }
  pksCrossings(sim);
  pksBlasts(sim);
  pksSweep(sim);
  if (sim.status === 'playing') pksOvertime(sim);
  if (sim.status === 'playing' && sim.spawnIndex >= sim.level.spawns.length && sim.enemies.length === 0 && sim.shimmers.length === 0) {
    sim.status = 'won';
    sim.stars = pksStars(sim);
    pksEmit(sim, { type: 'win', stars: sim.stars });
    if (sim.level.unlock) pksEmit(sim, { type: 'unlock', def: sim.level.unlock });
  }
  return sim;
}

// Passive trickle (unless the level switches it off; its rules may make it
// bigger) and card recharge.
function pksEconomy(sim) {
  if (sim.level.trickle && --sim.trickleT === 0) {
    var amount = sim.level.rules ? sim.level.rules.trickle : PKS_TRICKLE;
    sim.trickleT = pksSteps(PKS_TRICKLE_EVERY);
    sim.cycles += amount;
    pksEmit(sim, { type: 'trickle', amount: amount });
  }
  for (var i = 0; i < sim.cards.length; i++) {
    if (sim.cards[i].left > 0) sim.cards[i].left--;
  }
}

// Spawns that are due, and the surge warning / surge events.
function pksSpawns(sim) {
  var lv = sim.level;
  pksEmerge(sim);
  while (sim.spawnIndex < lv.spawns.length && pksSteps(lv.spawns[sim.spawnIndex].t) <= sim.tick) {
    var s = lv.spawns[sim.spawnIndex++];
    if (s.tunnel) pksShimmer(sim, s);
    else pksSpawnEnemy(sim, s.type, s.lane, PKS_SPAWN_X, s.type === 'boss' ? lv.boss : 0);
  }
  if (sim.warned < lv.surges.length && pksSteps(lv.surges[sim.warned] - PKS_SURGE_WARN) <= sim.tick) {
    pksEmit(sim, { type: 'surgeWarn', index: sim.warned, at: lv.surges[sim.warned] });
    sim.warned++;
  }
  if (sim.surged < lv.surges.length && pksSteps(lv.surges[sim.surged]) <= sim.tick) {
    pksEmit(sim, { type: 'surge', index: sim.surged });
    sim.surged++;
  }
}

// One step of a shot: defenders' shots hit the first visible enemy ahead,
// enemies' shots the first defender (not a grate) they reach.  The
// expansion: a shot into a Payload's shield does not slow; a Decryptor's
// shot strips shields (pksDecryptHit); an Air Gap sends an enemy's shot back
// (dir 1, kind kept), and then it hits only its thrower (pksReturnAct).
function pksShotAct(sim, s) {
  s.x += s.dir * PKS_SHOT_SPEED / PKS_RATE;
  if (s.dir > 0 && (s.kind === 'phish' || s.kind === 'volley')) {
    pksReturnAct(sim, s);
    return;
  }
  if (s.dir > 0) {
    var list = pksLane(s.lane);
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.hp > 0 && !e.cloaked && e.x >= s.from && e.x - PKS_BODY <= s.x && (!hit || e.x < hit.x) && pksInLane(e, s.lane)) hit = e;
    }
    if (hit) {
      s.done = true;
      pksEmit(sim, { type: 'hit', id: hit.id, shot: s.id, kind: s.kind, lane: s.lane, x: hit.x, dmg: s.dmg });
      if (s.kind === 'decrypt') {
        pksDecryptHit(sim, hit, s.dmg);
        return;
      }
      if (s.slow > 0 && hit.shield <= 0) pksSlow(hit, s.slow);
      pksHurt(sim, hit, s.dmg, 'shot');
    } else if (s.x > PKS_SHOT_END) {
      s.done = true;
    }
    return;
  }
  var col = Math.floor(s.x);
  var d = pksCell(s.lane, col);
  if (d && d.type === 'airgap' && s.x <= col + 0.5) {
    pksReflect(sim, s, d);
  } else if (d && d.kind !== 'floor' && s.x <= col + 0.5) {
    s.done = true;
    d.hp -= s.dmg;
    d.flash = PKS_FLASH;
    pksEmit(sim, { type: 'hit', id: d.id, shot: s.id, kind: s.kind, lane: s.lane, x: s.x, dmg: s.dmg });
    if (d.hp <= 0) pksDropDefender(sim, d, 'shot');
  } else if (s.x < 0) {
    s.done = true;
  }
}

// Drops dead enemies, spent shots and gone defenders, keeping order.
function pksSweep(sim) {
  pksKeep(sim.enemies, 'hp');
  pksKeep(sim.defenders, 'hp');
  pksKeepLive(sim.shots);
  pksKeepLive(sim.shells);
}

function pksKeepLive(list) {
  var w = 0;
  for (var i = 0; i < list.length; i++) {
    if (!list[i].done) list[w++] = list[i];
  }
  list.length = w;
}

function pksKeep(list, field) {
  var w = 0;
  for (var i = 0; i < list.length; i++) {
    if (list[i][field] > 0) list[w++] = list[i];
  }
  list.length = w;
}
