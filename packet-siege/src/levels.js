// ── levels: zones, the level table, unlocks, slots, the spawn generator ──
// Owns PKS_ZONES, PKS_LEVEL_ROWS, pksLevel, pksSlots, pksUnlockedDefenders.
// Uses core (pksRand, pksTenth), defenders (PKS_DEFENDERS, PKS_DEF) and
// enemies (PKS_ENEMIES, PKS_ENEMY, PKS_BOSS_TIERS); inside function bodies
// also levels-late (pksLateLevel, pksMarkTunnels), which appends zones 6-15
// and the rows of levels 51-150 to the tables here.
//
// A level is the row of PKS_LEVEL_ROWS (name, threat budget, length) plus
// what its zone says, plus spawns drawn by a mulberry32 generator seeded from
// the level number, so a level is the same on every run and machine.  Levels
// 51-150 also carry `rules` (levels-late); levels 1-50 have no such field.

var PKS_ZONES = [
  { zone: 1, name: 'Server closet', desc: 'L1 uses only the middle lane, L2-3 the three middle lanes.' },
  { zone: 2, name: 'DMZ', desc: 'Cable trays: some cells take nothing.' },
  { zone: 3, name: 'Hot aisle', desc: 'Brownout: no passive cycles, but a bigger start.' },
  { zone: 4, name: 'Cloud edge', desc: 'Fog hides the three right columns.' },
  { zone: 5, name: 'Core', desc: 'Enemies move 25 % faster; trays and fog come back.' }
];

// [name, threat budget, length in seconds]; boss levels (10, 20 ...) carry
// the budget of their escort; the boss tier is their real weight.
var PKS_LEVEL_ROWS = [
  ['Power On', 18, 240], ['Blinking Lights', 22.5, 250], ['Default Password', 27, 260],
  ['Open Port 23', 43.5, 270], ['Cable Spaghetti', 45, 280], ['Botnet Knocking', 46.5, 290],
  ['Unpatched Printer', 49.5, 300], ['Night Shift', 51, 310], ['Gift Attachment', 57, 320],
  ['The Lurker', 36, 330],
  ['Edge Router', 66, 340], ['Port Forward', 73.5, 350], ['Buffer Overrun', 81, 360],
  ['Bait and Switch', 90, 365], ['Packet Storm', 97.5, 375], ['Rate Exceeded', 105, 385],
  ['Dictionary Attack', 112.5, 395], ['Half-Open Handshake', 120, 405], ['Stale Certificate', 129, 415],
  ['The Pivot', 80, 425],
  ['Thermal Throttle', 300, 435], ['Locked Files', 325, 445], ['Fan Failure', 350, 455],
  ['Ransom Note', 375, 465], ['Mining Rig', 400, 475], ['Brownout', 425, 485],
  ['Rolling Blackout', 450, 495], ['Overclocked', 475, 505], ['Melted Solder', 500, 515],
  ['The Exfil', 330, 525],
  ['Invisible Hand', 520, 535], ['Cold Start', 555, 545], ['Region Outage', 590, 555],
  ['Noisy Neighbour', 625, 565], ['Zero-day Tuesday', 660, 575], ['Fog of War', 695, 585],
  ['Lost in Transit', 730, 595], ['Split Brain', 765, 600], ['Latency Spike', 800, 610],
  ['The Ghost', 280, 620],
  ['Shapeshifter', 860, 630], ['Kernel Panic', 890, 640], ['Root Access', 920, 650],
  ['Cascade Failure', 950, 660], ['Total Lockdown', 980, 670], ['Ring Zero', 1010, 680],
  ['Last Backup', 1040, 690], ['Hypervisor Escape', 1070, 700], ['Final Commit', 1100, 710],
  ['The Kingpin', 170, 720]
];

// 150 levels: the 50 rows above, then the 100 that levels-late appends.
var PKS_LEVELS = 150;

var PKS_HINTS = {
  1: 'Build PSUs first for cycles, then a Firewall in the lane before the first Bot gets close.',
  2: 'Script Kiddies run fast: a Reverse Proxy in front of your Firewalls holds them in place.',
  3: 'Each lane has one breaker: the first enemy at the rack trips it, the second ends the level.'
};

var PKS_BROWNOUT_CYCLES = 200;  // startCycles in the Hot aisle (no trickle there)

// Loadout slots at level n: 5, then 6 after level 10, 7 after 30, 8 after 40,
// 9 from level 71, 10 from level 111.
function pksSlots(n) {
  if (n > 110) return 10;
  if (n > 70) return 9;
  if (n > 40) return 8;
  if (n > 30) return 7;
  if (n > 10) return 6;
  return 5;
}

// Defender ids owned once level `highestWon` is won (0: none won yet), in
// unlock order.
function pksUnlockedDefenders(highestWon) {
  var out = [];
  for (var i = 0; i < PKS_DEFENDERS.length; i++) {
    if (PKS_DEFENDERS[i].unlock <= highestWon) out.push(PKS_DEFENDERS[i].id);
  }
  return out;
}

// Surges of level n: 3 on L1-5, one more every five levels, 12 on L46-50.
// Levels 1-50 are frozen (the owner's rule, spec-150): pksLevel(1..50)
// stays byte-identical to what it was before the expansion.  So a level
// names in `unlock` only the defender of the first PKS_FROZEN_DEFENDERS rows
// its win unlocks, or, past level PKS_FROZEN_LEVELS, any row's.  The one
// expansion defender a frozen level unlocks, the Canary (by winning level
// 50), is owned through pksUnlockedDefenders(50) and announced by the save
// (pksRecordWin's newDefenders), not by pksLevel(50).unlock.
var PKS_FROZEN_LEVELS = 50;
var PKS_FROZEN_DEFENDERS = 15;

// The defender id pksLevel(n).unlock names, or null.
function pksLevelUnlock(n) {
  var last = n > PKS_FROZEN_LEVELS ? PKS_DEFENDERS.length : PKS_FROZEN_DEFENDERS;
  var id = null;
  for (var i = 0; i < last; i++) {
    if (PKS_DEFENDERS[i].unlock === n) id = PKS_DEFENDERS[i].id;
  }
  return id;
}

// ... then one more every ten levels: 13 on L51-60 ... 22 on L141-150.
function pksSurgeCount(n) {
  if (n > PKS_FROZEN_LEVELS) return 13 + Math.floor((n - PKS_FROZEN_LEVELS - 1) / 10);
  return Math.min(12, 3 + Math.floor((n - 1) / 5));
}

function pksLanesOf(n) {
  if (n === 1) return [2];
  if (n <= 3) return [1, 2, 3];
  return [0, 1, 2, 3, 4];
}

function pksTrays(n, zone) {
  if (zone === 2) return 2 + n % 4;
  if (zone === 5 && n % 2 === 0) return 2 + n % 3;
  return 0;
}

function pksFog(n, zone) {
  return zone === 4 || (zone === 5 && (n % 2 === 1 || n === 50)) ? 3 : 0;
}

// The whole of level n (1..150) as plain data.  Past level 50 pksLateLevel
// sets the zone's fog, trickle, start, speed and `rules` (the last key) and
// pksMarkTunnels marks the spawns that come out of a tunnel.
function pksLevel(n) {
  var row = PKS_LEVEL_ROWS[n - 1];
  var zone = Math.ceil(n / 10);
  var level = {
    n: n, zone: zone, zoneName: PKS_ZONES[zone - 1].name, name: row[0],
    lanes: pksLanesOf(n), blocked: [], fog: pksFog(n, zone),
    trickle: zone !== 3, startCycles: zone === 3 ? PKS_BROWNOUT_CYCLES : PKS_START_CYCLES,
    slots: pksSlots(n), speed: zone === 5 ? 1.25 : 1, boss: n % 10 === 0 ? n / 10 : 0,
    spawns: [], surges: [], duration: row[2], budget: 0,
    unlock: null, intro: null, hint: PKS_HINTS[n] || null
  };
  level.unlock = pksLevelUnlock(n);
  var i;
  for (i = 0; i < PKS_ENEMIES.length; i++) {
    if (PKS_ENEMIES[i].first === n) level.intro = PKS_ENEMIES[i].id;
  }
  var rng = { rng: (n * 0x9E3779B1) ^ 0x5EED };
  pksPlaceTrays(level, pksTrays(n, zone), rng);
  if (n > PKS_FROZEN_LEVELS) pksLateLevel(level, rng);
  pksSchedule(level, row[1], rng);
  if (n > PKS_FROZEN_LEVELS) pksMarkTunnels(level);
  return level;
}

function pksPlaceTrays(level, count, rng) {
  var taken = {};
  while (level.blocked.length < count) {
    var lane = pksRandInt(rng, PKS_LANES);
    var col = 1 + pksRandInt(rng, PKS_COLS - 1);
    if (taken[lane * PKS_COLS + col]) continue;
    taken[lane * PKS_COLS + col] = true;
    level.blocked.push({ lane: lane, col: col });
  }
}

// Enemy pool of level n: every enemy introduced by n, weighted toward the
// newer ones; threat is the price of the smallest group (a drone pack of 4).
function pksPool(n) {
  var pool = [];
  for (var i = 0; i < PKS_ENEMIES.length; i++) {
    var e = PKS_ENEMIES[i];
    if (e.first > n) break;
    var age = e.first / n;
    pool.push({ type: e.id, threat: e.threat * (e.pack || 1), weight: 1 + 2 * age * age });
  }
  return pool;
}

// A weighted pick among the types that still fit in `left`, or null.
function pksPick(pool, left, rng) {
  var total = 0;
  var i;
  for (i = 0; i < pool.length; i++) {
    if (pool[i].threat <= left) total += pool[i].weight;
  }
  if (total === 0) return null;
  var roll = pksRand(rng) * total;
  var pick = null;
  for (i = 0; i < pool.length; i++) {
    if (pool[i].threat > left) continue;
    pick = pool[i].type;
    roll -= pool[i].weight;
    if (roll < 0) break;
  }
  return pick;
}

// How many enemies one pick of `type` brings (a drone pack is 4-6, as many
// as the budget still holds).
function pksGroup(type, left, rng) {
  var def = PKS_ENEMY[type];
  if (!def.pack) return 1;
  return Math.min(def.pack + pksRandInt(rng, 3), Math.floor(left / def.threat));
}

// The shape of a level in time (seconds).  The opening: nothing arrives for
// PKS_OPENING s (a first PSU and a first Firewall are paid by then).  The
// first surge comes PKS_FIRST_SURGE s after that, the final one PKS_TAIL s
// before the level's nominal end (the time its last enemies need to walk
// in); the surges between are evenly spaced.
var PKS_OPENING = 25;
var PKS_FIRST_SURGE = 55;
var PKS_TAIL = 50;

// The surge weights: surge i (0-based) of k gets i + 1 shares, the final
// surge PKS_FINAL_SURGE x k shares, so it is clearly the biggest.
var PKS_FINAL_SURGE = 1.5;

// The trickle thickens through the level: pick i of m arrives at
// t0 + (final surge - t0) x (i / m)^PKS_RAMP, so its rate grows as
// t^(1 / PKS_RAMP - 1): a quiet first minute, a crowded last one.
var PKS_RAMP = 0.65;

// The pressure caps: within any PKS_WINDOW s, the enemy HP entering one lane
// (pksLaneCap) and the whole floor (pksFieldCap) stays within what a player
// can plausibly hold at that time.  The plausible economy of a level by
// time t: its startCycles, the passive trickle, and PSUs (pksGenerated);
// after the first 100 cycles (the PSUs)
// all of it in Firewalls, spread over the lanes in play but leaning 1.5x on
// a threatened one, at least one.  One Firewall holds PKS_LANE_HP per window
// (20 per 1.5 s over the 30 s an enemy spends on its half of the floor).
// Zones 3-5 allow more (PKS_PRESSURE), as their players own more, but only
// from the middle of the level: the allowance grows from 1x at the start,
// so every opening is fair and the late level carries the weight.
var PKS_WINDOW = 15;
var PKS_LANE_HP = 400;
var PKS_FIELD_HP = 150;       // HP one Firewall wears down in a window, sustained
var PKS_PRESSURE = [1, 1, 1.5, 2, 2.5];
var PKS_INTRO_ROOM = 12;      // s around a new enemy's first spawns: nothing else in its lane, no other of it

// The plausible Firewalls of a level by time t (see above), all lanes.
function pksFirewalls(level, t) {
  var cycles = level.startCycles + (level.trickle ? PKS_TRICKLE / PKS_TRICKLE_EVERY * t : 0) + pksGenerated(level, t);
  return Math.max(0, cycles - 100) / PKS_DEF.firewall.cost;
}

// Cycles the plausible PSUs made by time t: two from 10 s on, one more
// every PKS_GEN_EVERY s, up to two a lane.
var PKS_GEN_EVERY = 30;
function pksGenerated(level, t) {
  var rate = PKS_DEF.psu.amount / PKS_DEF.psu.every;
  var most = 2 * level.lanes.length;
  var full = 10 + PKS_GEN_EVERY * (most - 2);   // when the last one is in
  var s = Math.max(0, Math.min(t, full) - 10);
  return rate * (2 * s + s * s / (2 * PKS_GEN_EVERY) + most * Math.max(0, t - full));
}

// The zone's allowance at t: 1 at the start, PKS_PRESSURE from mid-level on.
function pksAllowance(level, t) {
  return 1 + (PKS_PRESSURE[level.zone - 1] - 1) * Math.min(1, 2 * t / level.duration);
}

// Most enemy HP that may enter one lane within a window ending at t.
function pksLaneCap(level, t) {
  return pksAllowance(level, t) * PKS_LANE_HP * Math.max(1, 1.5 * pksFirewalls(level, t) / level.lanes.length);
}

// Most enemy HP that may enter all lanes together within a window ending at
// t: what the plausible Firewalls kill in it, PKS_FIELD_HP each, at least
// one Firewall's worth.
function pksFieldCap(level, t) {
  return pksAllowance(level, t) * PKS_FIELD_HP * Math.max(1, pksFirewalls(level, t));
}

// HP of one enemy of `type`, what it releases included.
function pksThreatHp(type) {
  var def = PKS_ENEMY[type];
  return def.hp + (def.spawn ? 2 * PKS_ENEMY[def.spawn].hp : 0);
}

// Surge times, sizes and spawns of a level.  A share of the budget (50 % at
// L1, falling to 40 % at L50) trickles in from the end of the opening to the
// final surge, ever denser, so there is no idle stretch between surges; the
// rest arrives with the surges.  Enemies get tougher through the level: a
// trickle pick may cost at most 1 + (the pool's dearest - 1) x p^1.5 (p: the
// share of the trickle spent), a pick of surge i at most 1.5 + the dearest x
// ((i + 1) / k)^0.8.  The enemy a level introduces comes early and alone
// (three of it, 45 s apart from 40 s after the opening; one pack of drones):
// nothing else in its lane for PKS_INTRO_ROOM s before and after.  Lanes are
// given out in time order under the pressure cap (pksLaneCap): a group that
// fits no lane waits a second.  In zone 1 a group goes to the least loaded
// lane, so a surge spreads over the lanes instead of stacking one.  The boss
// arrives with the final surge.
function pksSchedule(level, budget, rng) {
  var n = level.n;
  var pool = pksPool(n);
  var k = pksSurgeCount(n);
  var t0 = PKS_OPENING;
  var first = t0 + PKS_FIRST_SURGE;
  var last = level.duration - PKS_TAIL;
  var i;
  var dearest = 0;
  for (i = 0; i < pool.length; i++) dearest = Math.max(dearest, pool[i].threat);
  var weights = [];
  var total = 0;
  for (i = 0; i < k; i++) {
    weights.push(i === k - 1 ? PKS_FINAL_SURGE * k : i + 1);
    total += weights[i];
    level.surges.push(pksTenth(first + (last - first) * i / (k - 1)));
  }
  var groups = [];             // [t, type, count, intro] before lanes are given
  var spent = 0;
  function group(t, type, count, intro) {
    groups.push([t, type, count, intro]);
    spent += count * PKS_ENEMY[type].threat;
  }
  // the new enemy, alone
  var type;
  if (level.intro) {
    var count = level.intro === 'drone' ? 1 : 3;
    for (i = 0; i < count; i++) group(t0 + 40 + 45 * i, level.intro, pksGroup(level.intro, PKS_ENEMY[level.intro].threat * 6, rng), true);
  }
  // the trickle: picks first, then their times (40 % from level 50 on)
  var trickle = budget * (0.5 - 0.1 * (Math.min(n, PKS_FROZEN_LEVELS) - 1) / (PKS_FROZEN_LEVELS - 1));
  var left = trickle - spent;
  var picks = [];
  while ((type = pksPick(pool, Math.min(left, 1 + (dearest - 1) * Math.pow(1 - left / trickle, 1.5)), rng)) !== null) {
    var size = pksGroup(type, left, rng);
    picks.push([type, size]);
    left -= size * PKS_ENEMY[type].threat;
  }
  for (i = 0; i < picks.length; i++) group(t0 + (last - t0) * Math.pow(i / picks.length, PKS_RAMP), picks[i][0], picks[i][1], false);
  // the surges, each bigger than the one before and spread over 5-15 s;
  // what one leaves over goes to the next
  var surgeBudget = budget - spent;
  left = 0;
  for (i = 0; i < k; i++) {
    left += surgeBudget * weights[i] / total;
    var cap = 1.5 + dearest * Math.pow((i + 1) / k, 0.8);
    var spread = 5 + 10 * weights[i] / weights[k - 1];
    while ((type = pksPick(pool, Math.min(left, cap), rng)) !== null) {
      var g = pksGroup(type, left, rng);
      group(level.surges[i] + pksRand(rng) * spread, type, g, false);
      left -= g * PKS_ENEMY[type].threat;
    }
  }
  pksGiveLanes(level, groups, rng);
  if (level.boss) {
    // two bosses (lanes 1 and 3) when the tier is a twin (level 150)
    var bossLanes = PKS_BOSS_TIERS[level.boss - 1].twin ? [1, 3] : [2];
    for (i = 0; i < bossLanes.length; i++) level.spawns.push({ t: level.surges[k - 1], lane: bossLanes[i], type: 'boss', seq: level.spawns.length });
  }
  level.spawns.sort(function (a, b) { return a.t - b.t || a.seq - b.seq; });
  for (i = 0; i < level.spawns.length; i++) delete level.spawns[i].seq;
  level.budget = pksTenth(level.budget);
}

// Gives each group a lane, in time order (the new enemy's first), under the
// pressure cap; a group that fits nowhere waits a second.
function pksGiveLanes(level, groups, rng) {
  var load = [];               // per lane: [t, hp] of what entered it
  var intros = [];             // [t, lane, type] of the new enemy
  var i;
  for (i = 0; i < PKS_LANES; i++) load.push([]);
  groups.sort(pksGroupOrder);
  while (groups.length) {
    var g = groups.shift();
    var t = pksTenth(g[0]);
    var hp = g[2] * pksThreatHp(g[1]);
    var lane = pksFreeLane(level, load, intros, t, hp, g, rng);
    if (lane < 0) {
      g[0] = t + 1;
      pksInsert(groups, g);
      continue;
    }
    load[lane].push([t, hp]);
    if (g[3]) intros.push([t, lane, g[1]]);
    for (var j = 0; j < g[2]; j++) {
      level.spawns.push({ t: pksTenth(t + j * 0.4), lane: lane, type: g[1], seq: level.spawns.length });
      level.budget += PKS_ENEMY[g[1]].threat;
    }
  }
}

// The new enemy's groups first, then by time.
function pksGroupOrder(a, b) {
  return (b[3] ? 1 : 0) - (a[3] ? 1 : 0) || a[0] - b[0];
}

// Puts g back into the ordered queue.
function pksInsert(groups, g) {
  var at = 0;
  while (at < groups.length && pksGroupOrder(groups[at], g) <= 0) at++;
  groups.splice(at, 0, g);
}

// A lane for group g (hp entering at t): none while the floor's window is
// full; else one where the lane's window stays under its cap and, unless g
// is the new enemy itself, no new enemy is near (in this lane, or of g's
// type in any lane); in zone 1 the least loaded such lane, elsewhere a
// random one.  -1 when none fits.
function pksFreeLane(level, load, intros, t, hp, g, rng) {
  var lanes = level.lanes;
  var all = [];
  var j;
  for (j = 0; j < PKS_LANES; j++) all = all.concat(load[j]);
  if (!pksFits(level, all, t, hp, pksFieldCap)) return -1;
  var from = pksRandInt(rng, lanes.length);
  var best = -1;
  var bestLoad = 0;
  for (var i = 0; i < lanes.length; i++) {
    var lane = lanes[(from + i) % lanes.length];
    var near = false;
    for (j = 0; j < intros.length; j++) {
      if ((intros[j][1] === lane || intros[j][2] === g[1]) && Math.abs(intros[j][0] - t) < PKS_INTRO_ROOM) near = true;
    }
    if ((near && !g[3]) || !pksFits(level, load[lane], t, hp, pksLaneCap)) continue;
    if (level.zone > 1) return lane;
    var sum = pksWindow(load[lane], t);
    if (best < 0 || sum < bestLoad) {
      best = lane;
      bestLoad = sum;
    }
  }
  return best;
}

// HP of the entries ([t, hp]) in the window ending at `end`.
function pksWindow(entries, end) {
  var sum = 0;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i][0] > end - PKS_WINDOW && entries[i][0] <= end) sum += entries[i][1];
  }
  return sum;
}

// Whether hp more at t keeps every window it falls in under cap(level, end):
// the one ending at t and the ones ending at each later entry within reach
// (the new enemy's groups are given out first, ahead of time).
function pksFits(level, entries, t, hp, cap) {
  if (pksWindow(entries, t) + hp > cap(level, t)) return false;
  for (var i = 0; i < entries.length; i++) {
    var end = entries[i][0];
    if (end > t && end < t + PKS_WINDOW && pksWindow(entries, end) + hp > cap(level, end)) return false;
  }
  return true;
}
