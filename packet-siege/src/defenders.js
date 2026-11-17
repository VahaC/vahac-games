// ── defenders: the defender table and what each kind does in a step ──
// Owns PKS_DEFENDERS (in unlock order), the lookup PKS_DEF and
// pksDefenderAct.  Uses core (constants, pksSteps); inside function bodies
// also the step helpers of enemies (pksHurt, pksFreeze) and sim
// (pksEmit, pksShoot, pksLane, pksCell, pksTargetAhead, pksDropDefender).
//
// Kinds: gen (makes cycles), shooter (fires down its lane, or three lanes),
// wall, trap (honeypot: arms, then blows up on the first touch), floor (WAF:
// walked over, never bitten), pulse (3x3 damage), healer, beam (whole lane),
// instant (acts once after a fuse and is gone: blast / lane / freeze, and
// the expansion's scrub).  The expansion adds the kinds decoy (Canary),
// sniper (Tracer), mortar (Batch Job), knock (Loopback), arc (Token Ring),
// booster (Signature DB), pull (DNS Sinkhole), backup (Backup) and decrypt
// (Decryptor); the Air Gap is a wall and the Honeynet a trap that re-arms.
// Their rules and their step live in defenders-late; pksDefenderAct hands
// every kind it does not know to pksLateDefenderAct.
// Times are seconds, damage is HP, cost is cycles; unlock is the level whose
// win unlocks it (0: owned from the start).  The first 15 rows are frozen
// (levels 1-50 do not change); new rows only ever go after them.

var PKS_DEFENDERS = [
  { id: 'psu', name: 'PSU', unlock: 0, cost: 50, recharge: 5, hp: 300, kind: 'gen',
    amount: 25, every: 10, first: 6,
    desc: 'Power supply: +25 cycles every 10 s.' },
  { id: 'firewall', name: 'Firewall', unlock: 0, cost: 100, recharge: 5, hp: 300, kind: 'shooter',
    every: 1.5, dmg: 20, shots: 1, spread: 0, slow: 0,
    desc: 'Fires one packet every 1.5 s at the first enemy in its lane.' },
  { id: 'proxy', name: 'Reverse Proxy', unlock: 1, cost: 50, recharge: 20, hp: 2400, kind: 'wall',
    desc: 'A wall that soaks up bites and stops an Exploit\'s leap.' },
  { id: 'honeypot', name: 'Honeypot', unlock: 3, cost: 25, recharge: 20, hp: 300, kind: 'trap',
    arm: 12, dmg: 900,
    desc: 'Arms in 12 s, then blows up the first enemy to touch it (900).' },
  { id: 'tarpit', name: 'Tarpit', unlock: 5, cost: 175, recharge: 5, hp: 300, kind: 'shooter',
    every: 1.5, dmg: 20, shots: 1, spread: 0, slow: 4,
    desc: 'Shoots like a Firewall; a hit slows the target to half speed.' },
  { id: 'nullroute', name: 'Null Route', unlock: 8, cost: 150, recharge: 35, hp: 300, kind: 'instant',
    effect: 'blast', fuse: 1, dmg: 1800,
    desc: 'After a 1 s fuse, 1800 damage to everything in the 3x3 around it.' },
  { id: 'ids', name: 'IDS', unlock: 10, cost: 175, recharge: 5, hp: 300, kind: 'shooter',
    every: 1.5, dmg: 20, shots: 2, spread: 0, slow: 0,
    desc: 'Intrusion detection: two shots every 1.5 s.' },
  { id: 'waf', name: 'WAF Grate', unlock: 13, cost: 100, recharge: 5, hp: 300, kind: 'floor',
    dps: 20,
    desc: 'A floor grate: whatever walks over it takes 20 a second. Never bitten.' },
  { id: 'limiter', name: 'Rate Limiter', unlock: 16, cost: 125, recharge: 5, hp: 300, kind: 'pulse',
    every: 1.5, dmg: 20,
    desc: 'Every 1.5 s a pulse of 20 to every enemy in the 3x3 around it.' },
  { id: 'patch', name: 'Patch Server', unlock: 20, cost: 150, recharge: 10, hp: 300, kind: 'healer',
    heal: 40,
    desc: 'Repairs the defenders around it by 40 HP/s and clears encryption.' },
  { id: 'scanner', name: 'Scanner', unlock: 24, cost: 325, recharge: 5, hp: 300, kind: 'shooter',
    every: 1.5, dmg: 20, shots: 1, spread: 1, slow: 0,
    desc: 'Fires into its lane and both neighbours every 1.5 s.' },
  { id: 'ups', name: 'UPS', unlock: 28, cost: 150, recharge: 10, hp: 300, kind: 'gen',
    amount: 50, every: 10, first: 6,
    desc: 'Battery bank: +50 cycles every 10 s.' },
  { id: 'inspector', name: 'Packet Inspector', unlock: 33, cost: 300, recharge: 10, hp: 300, kind: 'beam',
    every: 3, dmg: 40,
    desc: 'Every 3 s a beam hits every enemy in its lane for 40, cloaked or not.' },
  { id: 'failover', name: 'Failover', unlock: 37, cost: 125, recharge: 40, hp: 300, kind: 'instant',
    effect: 'lane', fuse: 0.5, dmg: 1800,
    desc: 'After a 0.5 s fuse, 1800 damage to every enemy in its lane.' },
  { id: 'quarantine', name: 'Quarantine', unlock: 44, cost: 75, recharge: 45, hp: 300, kind: 'instant',
    effect: 'freeze', fuse: 0.5, freeze: 5,
    desc: 'After a 0.5 s fuse, freezes every enemy on the floor for 5 s.' },
  // ── the expansion (levels 51-150): what each does is in defenders-late ──
  { id: 'canary', name: 'Canary', unlock: 50, cost: 25, recharge: 8, hp: 150, kind: 'decoy',
    desc: 'A cheap decoy: every enemy stops to bite it, even one that would leap or throw.' },
  { id: 'tracer', name: 'Tracer', unlock: 54, cost: 250, recharge: 5, hp: 300, kind: 'sniper',
    every: 4, dmg: 150,
    desc: 'Every 4 s one heavy shot of 150 at the toughest enemy in its lane.' },
  { id: 'batch', name: 'Batch Job', unlock: 59, cost: 225, recharge: 5, hp: 300, kind: 'mortar',
    every: 3, dmg: 60, splash: 1, minRange: 2, flight: 1,
    desc: 'Every 3 s lobs a shell at the densest group 2+ cells away: 60 within 1 cell.' },
  { id: 'loopback', name: 'Loopback', unlock: 65, cost: 175, recharge: 5, hp: 300, kind: 'knock',
    every: 6, push: 2, heavyPush: 0.5, times: 2,
    desc: 'Every 6 s throws the first enemy in its lane back 2 cells (heavy ones 0.5), 2 times each.' },
  { id: 'tokenring', name: 'Token Ring', unlock: 71, cost: 275, recharge: 5, hp: 300, kind: 'arc',
    every: 2, dmg: 30, hits: 3, reach: 2,
    desc: 'Every 2 s an arc of 30 that jumps on to up to 3 enemies in this or the next lanes.' },
  { id: 'sigdb', name: 'Signature DB', unlock: 77, cost: 200, recharge: 10, hp: 300, kind: 'booster',
    boost: 50,
    desc: 'Shooters in the 3x3 around it deal 50 % more damage. Boosts do not stack.' },
  { id: 'sinkhole', name: 'DNS Sinkhole', unlock: 85, cost: 200, recharge: 10, hp: 300, kind: 'pull',
    every: 8,
    desc: 'Every 8 s pulls the nearest enemy of each neighbour lane into its own lane.' },
  { id: 'airgap', name: 'Air Gap', unlock: 92, cost: 125, recharge: 20, hp: 1800, kind: 'wall',
    desc: 'An 1800 HP wall: a thrown shot bounces back and hits its thrower if it is in that lane.' },
  { id: 'backup', name: 'Backup', unlock: 100, cost: 250, recharge: 10, hp: 300, kind: 'backup',
    every: 60,
    desc: 'Every 60 s at most, rebuilds a lost defender in the 3x3; not a Canary, instant or Backup.' },
  { id: 'scrubber', name: 'Scrubber', unlock: 110, cost: 150, recharge: 40, hp: 300, kind: 'instant',
    effect: 'scrub', fuse: 0.5, limit: 200,
    desc: 'After a 0.5 s fuse, destroys every enemy on the floor whose full HP is 200 or less.' },
  { id: 'decryptor', name: 'Decryptor', unlock: 120, cost: 200, recharge: 5, hp: 300, kind: 'decrypt',
    every: 1.5, dmg: 40, armoured: ['worm', 'brute', 'hive', 'titan'],
    desc: 'Every 1.5 s a shot of 40 that strips shields; double damage to shielded or armoured.' },
  { id: 'honeynet', name: 'Honeynet', unlock: 132, cost: 150, recharge: 20, hp: 300, kind: 'trap',
    arm: 12, dmg: 900, rearm: 20,
    desc: 'A Honeypot (900, arms in 12 s) that arms again 20 s after it goes off.' }
];

var PKS_DEF = pksIndex(PKS_DEFENDERS);

// A new defender of type `type` on (lane, col).  Every timer counts steps.
//   t      steps to the next action (production, shot, pulse, beam) or to the
//          end of the fuse / arming
//   state  'idle' | 'firing' | 'arming' | 'armed' | 'fuse' | 'encrypting' | 'off'
//   anim   steps since placing (the idle animation clock)
//   fire   steps left of the firing frame
//   flash  steps left of the white hit flash
//   enc    steps left until the encryption takes hold (Ransomware)
//   off    steps left disabled
//   healed the tick a Patch Server last healed it (-1: never)
//   jammed  a Jammer keeps it from firing this step (shooter kinds only,
//          PKS_SHOOTER_KINDS); a 'jam' event marks each change
//   boosted a Signature DB adds its boost to its damage this step (shooter
//          kinds only)
// For a Backup, t is its cooldown (0: ready); for a Honeynet that went off,
// t counts down its re-arming (state 'arming' again).
function pksNewDefender(sim, type, lane, col) {
  var def = PKS_DEF[type];
  var t = 0;
  if (def.kind === 'gen') t = pksSteps(def.first);
  else if (def.kind === 'trap') t = pksSteps(def.arm);
  else if (def.kind === 'instant') t = pksSteps(def.fuse);
  return {
    id: sim.nextId++, type: type, kind: def.kind, lane: lane, col: col,
    hp: def.hp, maxHp: def.hp, t: t, state: pksIdleState(def.kind), anim: 0,
    fire: 0, flash: 0, enc: 0, off: 0, healed: -1, jammed: false, boosted: false
  };
}

function pksIdleState(kind) {
  if (kind === 'trap') return 'arming';
  if (kind === 'instant') return 'fuse';
  return 'idle';
}

// One step of defender d (alive, on the field).
function pksDefenderAct(sim, d) {
  var def = PKS_DEF[d.type];
  d.anim++;
  if (d.flash > 0) d.flash--;
  if (d.fire > 0) d.fire--;
  // zones: in a lane under an outage it does nothing, its timers wait
  if (d.lane === pksDownLane) return;
  if (d.enc > 0) {
    d.enc--;
    if (d.enc === 0) {
      d.off = pksSteps(PKS_RANSOM_OFF);
      pksEmit(sim, { type: 'disabled', id: d.id, lane: d.lane, col: d.col });
    }
  }
  if (d.off > 0) {
    d.off--;
    d.state = 'off';
    return;
  }
  if (d.t > 0) d.t--;
  // zones: on a power rail its timer runs 1.5x (one more step every other)
  if (d.t > 0 && (sim.tick & 1) === 0 && pksRailAt(d)) d.t--;
  switch (d.kind) {
    case 'gen':
      if (d.t === 0) {
        sim.cycles += def.amount;
        sim.stats.produced += def.amount;
        d.t = pksSteps(def.every);
        d.fire = PKS_FIRE_ANIM;
        pksEmit(sim, { type: 'produce', id: d.id, lane: d.lane, col: d.col, amount: def.amount });
      }
      break;
    case 'shooter':
      if (d.t === 0 && !d.jammed && pksShooterHasTarget(d, def)) {
        pksFire(sim, d, def);
        d.t = pksSteps(def.every);
        d.fire = PKS_FIRE_ANIM;
      }
      break;
    case 'trap':
      if (d.t > 0) {
        d.state = 'arming';
      } else if (d.state !== 'armed') {
        d.state = 'armed';
        pksEmit(sim, { type: 'armed', id: d.id, lane: d.lane, col: d.col });
      }
      return;
    case 'floor':
      pksGrate(sim, d, def);
      break;
    case 'pulse':
      if (d.t === 0 && pksAreaHasEnemy(d.lane, d.col)) {
        pksPulse(sim, d, def.dmg, 'pulse');
        d.t = pksSteps(def.every);
        d.fire = PKS_FIRE_ANIM;
      }
      break;
    case 'healer':
      pksHeal(sim, d, def.heal * pksRailRate(d) / PKS_RATE);
      break;
    case 'beam':
      if (d.t === 0 && !d.jammed && pksLaneHasEnemy(d.lane)) {
        pksBeam(sim, d, pksBoosted(d, def.dmg));
        d.t = pksSteps(def.every);
        d.fire = PKS_FIRE_ANIM;
      }
      break;
    case 'instant':
      if (d.t === 0) pksInstant(sim, d, def);
      return;
    case 'wall':
      break;
    default:
      pksLateDefenderAct(sim, d, def);
  }
  d.state = d.enc > 0 ? 'encrypting' : (d.fire > 0 ? 'firing' : 'idle');
}

// A shooter fires when one of its lanes holds a visible enemy ahead of it.
function pksShooterHasTarget(d, def) {
  for (var dl = -def.spread; dl <= def.spread; dl++) {
    if (pksTargetAhead(d.lane + dl, d.col + 0.5)) return true;
  }
  return false;
}

function pksFire(sim, d, def) {
  var x = d.col + 0.7;
  var dmg = pksBoosted(d, def.dmg);
  for (var dl = -def.spread; dl <= def.spread; dl++) {
    var lane = d.lane + dl;
    if (!pksLaneOpen(sim, lane)) continue;
    for (var s = 0; s < def.shots; s++) {
      pksShoot(sim, def.slow > 0 ? 'tar' : 'drop', lane, x - s * 0.3, 1, dmg, d, def.slow);
    }
  }
}

// WAF Grate: everything over the cell burns; a Brute Forcer crushes it.
function pksGrate(sim, d, def) {
  var list = pksLane(d.lane);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e.hp <= 0 || e.x < d.col || e.x > d.col + 1 + PKS_BODY || !pksInLane(e, d.lane)) continue;
    if (e.type === 'brute' || e.type === 'titan') {
      pksDropDefender(sim, d, 'crushed');
      return;
    }
    pksHurt(sim, e, def.dps * pksRailRate(d) / PKS_RATE, 'area');
  }
}

// Whether a living enemy is on the floor in a lane.
function pksLaneHasEnemy(lane) {
  var list = pksLane(lane);
  for (var i = 0; i < list.length; i++) {
    if (list[i].hp > 0 && list[i].x <= PKS_FLOOR_END && pksInLane(list[i], lane)) return true;
  }
  return false;
}

// Whether any enemy is in the 3x3 around (lane, col).
function pksAreaHasEnemy(lane, col) {
  for (var l = lane - 1; l <= lane + 1; l++) {
    var list = pksLane(l);
    for (var i = 0; i < list.length; i++) {
      if (pksInArea(list[i], lane, col)) return true;
    }
  }
  return false;
}

// Whether e is in the 3x3 around (lane, col) (past level 50 by the lane it
// is in now, see pksInLane).
function pksInArea(e, lane, col) {
  return e.hp > 0 && e.x >= col - 1 && e.x <= col + 2 && e.x <= PKS_FLOOR_END && (!pksLateStep || Math.abs(e.lane - lane) <= 1);
}

// dmg to every enemy in the 3x3 around d; how is 'pulse' or 'instant'.
function pksPulse(sim, d, dmg, how) {
  pksEmit(sim, { type: how === 'pulse' ? 'pulse' : 'blast', id: d.id, def: d.type, lane: d.lane, col: d.col });
  for (var l = d.lane - 1; l <= d.lane + 1; l++) {
    var list = pksLane(l);
    for (var i = 0; i < list.length; i++) {
      if (pksInArea(list[i], d.lane, d.col)) pksHurt(sim, list[i], dmg, how === 'pulse' ? 'area' : 'instant');
    }
  }
}

function pksBeam(sim, d, dmg) {
  pksEmit(sim, { type: 'beam', id: d.id, def: d.type, lane: d.lane, col: d.col });
  var list = pksLane(d.lane);
  for (var i = 0; i < list.length; i++) {
    if (list[i].hp > 0 && list[i].x <= PKS_FLOOR_END && pksInLane(list[i], d.lane)) pksHurt(sim, list[i], dmg, 'area');
  }
}

// Patch Server: heals the 3x3 around it (itself included) and clears
// encryption at once.  Patches do not stack: a defender is healed by one
// patch a step (healed holds the tick of its last heal).
function pksHeal(sim, d, amount) {
  for (var l = d.lane - 1; l <= d.lane + 1; l++) {
    for (var c = d.col - 1; c <= d.col + 1; c++) {
      var o = pksCell(l, c);
      if (!o || o.healed === sim.tick) continue;
      o.healed = sim.tick;
      o.hp = Math.min(o.maxHp, o.hp + amount);
      if (o.enc > 0 || o.off > 0) {
        o.enc = 0;
        o.off = 0;
        pksEmit(sim, { type: 'cleared', id: o.id, lane: o.lane, col: o.col });
      }
    }
  }
}

// The instants: blast (3x3), lane, freeze (the whole floor).  The defender
// is gone afterwards.
function pksInstant(sim, d, def) {
  var i;
  if (def.effect === 'blast') {
    pksPulse(sim, d, def.dmg, 'instant');
  } else if (def.effect === 'scrub') {
    pksScrub(sim, d, def);
  } else if (def.effect === 'lane') {
    pksEmit(sim, { type: 'blast', id: d.id, def: d.type, lane: d.lane, col: d.col });
    var list = pksLane(d.lane);
    for (i = 0; i < list.length; i++) {
      if (list[i].hp > 0 && list[i].x <= PKS_FLOOR_END && pksInLane(list[i], d.lane)) pksHurt(sim, list[i], def.dmg, 'instant');
    }
  } else {
    pksEmit(sim, { type: 'freeze', id: d.id, def: d.type, lane: d.lane, col: d.col });
    for (i = 0; i < sim.enemies.length; i++) {
      if (sim.enemies[i].hp > 0 && sim.enemies[i].x <= PKS_FLOOR_END) pksFreeze(sim.enemies[i], def.freeze);
    }
  }
  pksDropDefender(sim, d, 'spent');
}
