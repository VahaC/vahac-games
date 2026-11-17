// ── levels: the expansion, 2 of 2 parts: zones 6-15 and levels 51-150 ──
// Owns PKS_LATE_NAMES, PKS_ROOT_RULES, pksLateBudget, pksLateLevel and
// pksMarkTunnels, and appends zones 6-15 to PKS_ZONES, their pressure to
// PKS_PRESSURE and the rows of levels 51-150 to PKS_LEVEL_ROWS (levels).
// Uses core, enemies (PKS_BOSS_TIERS) and levels; inside function bodies
// also zones (the rule constants, pksNoRules).
//
// Levels 1-50 are frozen (spec-150): nothing here runs for them, and their
// level objects gain no field.  A level n > 50 is built by pksLevel like the
// others (same generator, same seed scheme), and then:
//   zone      ceil(n / 10): 6 Backbone ... 15 Root
//   lanes     all five; no cable trays
//   duration  720 s at L50 + 5.5 s a level, rounded to 5 s (pksLateLength):
//             725 s at L51, 1270 s (about 21 minutes) at L150
//   surges    13 on L51-60 ... 22 on L141-150 (pksSurgeCount)
//   budget    pksLateBudget: PKS_LATE_BUDGETS, fitted by tune.js (see there)
//   slots     8, 9 from L71, 10 from L111 (pksSlots)
//   speed     1, PKS_ROOT_SPEED (1.1) at the root
//   rules     the zone's rule (zones 6-14), or two earlier rules fixed per
//             level (the root: PKS_ROOT_RULES); level.rules.names lists them.
//             fog: PKS_LATE_FOG columns where the rule names fog; trickle off
//             (and startCycles PKS_BROWNOUT_CYCLES) where it names rails.
// The rule cells are drawn by the level's own generator (its RNG, before
// the spawns): express lanes 1-2; hot cells 3-6 (columns 1-8); power rails
// 3-5 (columns 0-7); tunnels 1-2 lanes at column PKS_TUNNEL_COL; crossover
// cells 2-4 (columns 2-7, each in its own column, arrows only to a lane on
// the floor); no two rule cells share a cell.  The outage order is a
// shuffle of the five lanes.

PKS_ZONES.push(
  { zone: 6, name: 'Backbone', desc: 'Express lanes: enemies in the marked lanes move 40 % faster.' },
  { zone: 7, name: 'Storage array', desc: 'Hot cells: a defender standing on one loses 8 HP a second.' },
  { zone: 8, name: 'Power plant', desc: 'Power rails: a defender on one works 50 % faster. No passive cycles.' },
  { zone: 9, name: 'VPN tunnel', desc: 'Tunnel exits at column 6: every 3rd enemy of the lane comes out there after 2 s.' },
  { zone: 10, name: 'Dark fiber', desc: 'Every 50 s the lights fail for 10 s (3 s warning): shooters see 4 cells.' },
  { zone: 11, name: 'Cross-connect', desc: 'Crossover cells: an enemy stepping on one moves to the lane its arrow shows.' },
  { zone: 12, name: 'Metered cloud', desc: 'Upkeep: every defender on the floor costs 1 cycle per 12 s.' },
  { zone: 13, name: 'Mainframe', desc: 'Every 40 s one lane goes offline for 10 s (5 s warning): its defenders stop.' },
  { zone: 14, name: 'Quantum lab', desc: 'Fog hides the 5 right columns, and express lanes are back.' },
  { zone: 15, name: 'Root', desc: 'Enemies move 10 % faster, and every level brings back two earlier rules.' }
);

PKS_PRESSURE.push(2.6, 2.7, 2.8, 2.9, 3, 3.1, 3.2, 3.3, 3.4, 3.5);

var PKS_LATE_NAMES = [
  'Trunk Line', 'Fast Path', 'Fiber Spine', 'Express Hop', 'Core Switch',
  'Peering Point', 'Jumbo Frames', 'Route Flap', 'Transit Link', 'The Bulwark',
  'Spinning Rust', 'Hot Spare', 'RAID Rebuild', 'Write Cache', 'Bad Block',
  'Thermal Runaway', 'Disk Shelf', 'Parity Error', 'Cold Storage', 'The Warden',
  'Busbar', 'Phase Shift', 'Load Shedding', 'Surge Arrester', 'Transformer Hum',
  'Grid Tie', 'Spinning Reserve', 'Ground Fault', 'Peak Demand', 'The Static',
  'Handshake', 'Split Tunnel', 'Encapsulation', 'Keepalive', 'Wormhole',
  'MTU Mismatch', 'Tunnel Vision', 'Rekey', 'Dead Peer', 'The Schism',
  'Lights Out', 'Unlit Strand', 'Dark Window', 'Night Vision', 'Signal Loss',
  'Blind Spot', 'Black Glass', 'Faint Carrier', 'Eclipse', 'The Shade',
  'Patch Bay', 'Crossed Wires', 'Lane Swap', 'Jumper Cable', 'Crosstalk',
  'Switchback', 'Meet-me Room', 'Wrong Turn', 'Cable Weave', 'The Weaver',
  'Pay As You Go', 'Egress Fees', 'Spot Instance', 'Reserved Capacity', 'Burst Credits',
  'Cost Explorer', 'Overage', 'Billing Cycle', 'Budget Alert', 'The Collector',
  'Batch Window', 'Punch Card', 'Green Screen', 'Job Control', 'Core Dump',
  'Tape Library', 'Channel Program', 'Big Iron', 'Abend', 'The Operator',
  'Superposition', 'Qubit Drift', 'Entangled', 'Decoherence', 'Uncertainty',
  'Spooky Action', 'Wave Collapse', 'Cold Trap', 'Bit Flip', 'The Observer',
  'Sudo Make', 'Privilege Ring', 'Setuid', 'Init System', 'Bootloader',
  'Firmware Flash', 'Master Key', 'Chain of Trust', 'Last Login', 'The Architect'
];

// The rules of zones 6-14, and the two of each root level (141-150).
var PKS_ZONE_RULES = {
  6: ['express'], 7: ['hot'], 8: ['rails'], 9: ['tunnels'], 10: ['blackout'],
  11: ['cross'], 12: ['upkeep'], 13: ['outage'], 14: ['express', 'fog']
};
var PKS_ROOT_RULES = [
  ['hot', 'tunnels'], ['rails', 'blackout'], ['tunnels', 'cross'], ['upkeep', 'outage'], ['express', 'blackout'],
  ['hot', 'outage'], ['rails', 'cross'], ['tunnels', 'upkeep'], ['cross', 'fog'], ['express', 'outage']
];
var PKS_RULE_ORDER = ['express', 'hot', 'rails', 'tunnels', 'blackout', 'cross', 'upkeep', 'outage', 'fog'];

// The threat budgets (the rows' budget) of levels 51-150, fitted by
// .claude/packet-siege/tune.js --fit (phase 4 of spec-150): a smooth curve
// through each zone's capacity (the budget at which the reference bot's
// margin is the zone's target), held so that it only ever rises, then each
// level nudged to a draw where the bot wins with the stars the zone plans
// for it and with 10 % to spare.  The realised budgets (the sum of threat
// over the spawns, always a little under the row's) rise strictly from
// level 49's 1100 over the non-boss levels, to about 2300 at the root; a
// boss level carries about 35 % of the level before it as its boss's
// escort.  Re-fit after any change that moves the campaign.
var PKS_LATE_BUDGETS = [
  1151, 1176.5, 1202.5, 1229.5, 1250.5, 1258.5, 1266, 1279.5, 1281, 448.5,
  1281.5, 1287, 1290, 1296.5, 1301, 1319, 1343, 1353.5, 1372.5, 412,
  1411, 1429.5, 1448, 1466, 1484.5, 1509.5, 1535, 1567, 1584.5, 480,
  1634, 1658, 1684, 1710.5, 1734.5, 1735.5, 1737, 1738.5, 1740.5, 609,
  1742, 1758.5, 1759, 1760.5, 1765.5, 1766, 1766.5, 1768, 1772, 620,
  1782.5, 1788.5, 1794, 1799.5, 1806, 1849.5, 1891, 1935.5, 1978, 494.5,
  2063.5, 2107, 2151, 2194, 2238, 2240.5, 2241.5, 2242.5, 2244, 841.5,
  2247.5, 2248, 2249, 2250.5, 2252.5, 2257, 2262, 2266.5, 2276, 967,
  2282.5, 2287.5, 2292, 2298.5, 2301.5, 2302.5, 2304.5, 2306, 2313, 711,
  2314.5, 2317.5, 2322, 2323.5, 2323.5, 2329, 2331, 2331.5, 2339.5, 865.5
];

function pksLateBudget(n) {
  return PKS_LATE_BUDGETS[n - PKS_FROZEN_LEVELS - 1];
}

// The nominal length of level n > 50 in seconds: 720 s at level 50, 5.5 s
// more a level, rounded to 5 s.
function pksLateLength(n) {
  return Math.round((720 + 5.5 * (n - PKS_FROZEN_LEVELS)) / 5) * 5;
}

// Rows [name, budget, length in s] of levels 51-150.
function pksLateRows() {
  var rows = [];
  for (var n = PKS_FROZEN_LEVELS + 1; n <= PKS_LEVELS; n++) {
    rows.push([PKS_LATE_NAMES[n - PKS_FROZEN_LEVELS - 1], pksLateBudget(n), pksLateLength(n)]);
  }
  return rows;
}

PKS_LEVEL_ROWS.push.apply(PKS_LEVEL_ROWS, pksLateRows());

// The rule names of level n > 50, in PKS_RULE_ORDER.
function pksLateRuleNames(n) {
  var zone = Math.ceil(n / 10);
  var names = zone === 15 ? PKS_ROOT_RULES[n - 141] : PKS_ZONE_RULES[zone];
  return PKS_RULE_ORDER.filter(function (r) { return names.indexOf(r) >= 0; });
}

// The zone part of level n > 50 (fog, trickle, start, speed, rules), drawn
// with the level's generator before its spawns.
function pksLateLevel(level, rng) {
  var names = pksLateRuleNames(level.n);
  var R = pksNoRules();
  var has = function (r) { return names.indexOf(r) >= 0; };
  var taken = {};
  R.names = names;
  if (has('express')) R.express = pksPickLanes(1 + level.n % 2, rng).sort();
  if (has('tunnels')) {
    var lanes = pksPickLanes(1 + (level.n + 1) % 2, rng).sort();
    for (var i = 0; i < lanes.length; i++) {
      R.tunnels.push({ lane: lanes[i], col: PKS_TUNNEL_COL, every: PKS_TUNNEL_EVERY });
      taken[lanes[i] * PKS_COLS + PKS_TUNNEL_COL] = true;
    }
  }
  if (has('hot')) R.hot = pksPickCells(3 + level.n % 4, 1, 8, taken, rng);
  if (has('rails')) R.rails = pksPickCells(3 + level.n % 3, 0, 7, taken, rng);
  if (has('cross')) R.cross = pksPickCross(2 + level.n % 3, taken, rng);
  if (has('blackout')) R.blackout = { every: PKS_BLACKOUT.every, length: PKS_BLACKOUT.length, warn: PKS_BLACKOUT.warn, sight: PKS_BLACKOUT.sight };
  if (has('upkeep')) R.upkeep = { cost: PKS_UPKEEP.cost, every: PKS_UPKEEP.every };
  if (has('outage')) {
    R.outage = { every: PKS_OUTAGE.every, length: PKS_OUTAGE.length, warn: PKS_OUTAGE.warn, order: pksPickLanes(PKS_LANES, rng) };
  }
  level.fog = has('fog') ? PKS_LATE_FOG : 0;
  level.trickle = !has('rails');
  level.startCycles = level.trickle ? PKS_START_CYCLES : PKS_BROWNOUT_CYCLES;
  level.speed = level.zone === 15 ? PKS_ROOT_SPEED : 1;
  R.trickle = level.trickle ? PKS_TRICKLE : 0;
  level.rules = R;
}

// `count` distinct lanes in random order.
function pksPickLanes(count, rng) {
  var all = [0, 1, 2, 3, 4];
  var out = [];
  while (out.length < count) out.push(all.splice(pksRandInt(rng, all.length), 1)[0]);
  return out;
}

// `count` cells in columns from..to that no other rule holds.
function pksPickCells(count, from, to, taken, rng) {
  var out = [];
  while (out.length < count) {
    var lane = pksRandInt(rng, PKS_LANES);
    var col = from + pksRandInt(rng, to - from + 1);
    if (taken[lane * PKS_COLS + col]) continue;
    taken[lane * PKS_COLS + col] = true;
    out.push({ lane: lane, col: col });
  }
  return out.sort(pksCellOrder);
}

function pksCellOrder(a, b) {
  return a.lane - b.lane || a.col - b.col;
}

// `count` crossover cells, each in a column of its own (2-7), pointing to a
// neighbour lane on the floor.
function pksPickCross(count, taken, rng) {
  var out = [];
  var cols = {};
  while (out.length < count) {
    var lane = pksRandInt(rng, PKS_LANES);
    var col = 2 + pksRandInt(rng, 6);
    var up = pksRand(rng) < 0.5;
    if (taken[lane * PKS_COLS + col] || cols[col]) continue;
    taken[lane * PKS_COLS + col] = true;
    cols[col] = true;
    var to = lane === 0 ? 1 : lane === PKS_LANES - 1 ? lane - 1 : up ? lane - 1 : lane + 1;
    out.push({ lane: lane, col: col, to: to });
  }
  return out.sort(pksCellOrder);
}

// After the schedule: in a lane with a tunnel, every `every`-th spawn (not
// the boss, not the level's new enemy) comes out of the tunnel.
function pksMarkTunnels(level) {
  var tunnels = level.rules.tunnels;
  for (var i = 0; i < tunnels.length; i++) {
    var count = 0;
    for (var j = 0; j < level.spawns.length; j++) {
      var s = level.spawns[j];
      if (s.lane !== tunnels[i].lane || s.type === 'boss' || s.type === level.intro) continue;
      if (++count % tunnels[i].every === 0) s.tunnel = true;
    }
  }
}
