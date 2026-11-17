// ── enemies: the enemy table, the boss tiers and what enemies do in a step ──
// Owns PKS_ENEMIES (in order of first appearance), PKS_ENEMY, PKS_BOSS_TIERS,
// spawning, damage (pksHurt), kills, freezing, the breakers and every
// enemy's step.  Uses core and defenders (PKS_DEF); inside function bodies
// also sim (pksEmit, pksShoot, pksCell, pksLaneOpen, pksDropDefender).
//
// An enemy walks left at `speed` cells/s; at a defender it stops and bites
// (`bite` HP/s).  `threat` is its price in a level's budget.  Specials:
// pack (DDoS Drone: arrives in packs), spawn (Trojan: releases these where it
// dies), fast (Exploit: speed until its one leap), range (Phisher: stops
// this far from the nearest defender and throws), crush (Brute Forcer:
// crushes a WAF Grate or a Honeypot it steps on), encrypt (Ransomware),
// drain (Cryptominer: cycles/s), cloak (Rootkit), immune (Zero-day: no slow,
// no freeze), morph (Polymorph).  The expansion's twelve (Keylogger to
// Glitch) carry their numbers in their rows; their rules and their step live
// in enemies-late, which this part calls through a few hooks (pksHurt,
// pksKill, pksEnemyAct, pksContact).  The first 13 rows and the 5 boss tiers
// are frozen (levels 1-50 do not change); new rows only ever go after them.

var PKS_RANSOM_CAST = 2;     // seconds a Ransomware takes to encrypt a defender
var PKS_RANSOM_OFF = 10;     // seconds the encrypted defender is then off
var PKS_UNCLOAK_X = 4.5;     // a Rootkit shows itself past this x
var PKS_DRAIN_TICK = 0.5;    // a Cryptominer takes one cycle this often (2/s)
var PKS_LEAP_TIME = 0.5;     // seconds an Exploit's leap takes
var PKS_SHIFT_TIME = 0.5;    // seconds a lane change takes (the renderer slides the unit over)

var PKS_ENEMIES = [
  { id: 'bot', name: 'Bot', first: 1, hp: 200, speed: 0.2, threat: 1, bite: 100,
    desc: 'A compromised host doing what it is told. Slow, steady, plentiful.' },
  { id: 'kiddie', name: 'Script Kiddie', first: 2, hp: 140, speed: 0.42, threat: 1.5, bite: 100,
    desc: 'Runs other people\'s tools at twice the pace of a Bot.' },
  { id: 'worm', name: 'Worm', first: 4, hp: 560, speed: 0.2, threat: 2.5, bite: 100,
    desc: 'Self-replicating and thick-skinned: takes a lot of packets.' },
  { id: 'drone', name: 'DDoS Drone', first: 6, hp: 60, speed: 0.36, threat: 0.5, bite: 40, pack: 4,
    desc: 'Flimsy alone, but they come in packs of four to six.' },
  { id: 'trojan', name: 'Trojan', first: 9, hp: 400, speed: 0.2, threat: 3, bite: 100, spawn: 'bot',
    desc: 'Looks harmless; releases two Bots where it dies.' },
  { id: 'exploit', name: 'Exploit', first: 11, hp: 340, speed: 0.2, fast: 0.4, threat: 3, bite: 100,
    desc: 'Fast until it leaps over the first defender it meets. A Reverse Proxy stops the leap.' },
  { id: 'phisher', name: 'Phisher', first: 14, hp: 300, speed: 0.2, threat: 3.5, bite: 100,
    range: 3, throwDmg: 40, throwEvery: 2,
    desc: 'Stops three cells short of your defenders and lobs bait at them.' },
  { id: 'brute', name: 'Brute Forcer', first: 17, hp: 1600, speed: 0.14, threat: 5, bite: 300, crush: true,
    desc: 'Huge and slow, bites three times as hard and crushes grates and honeypots.' },
  { id: 'ransom', name: 'Ransomware', first: 21, hp: 500, speed: 0.2, threat: 4, bite: 100, encrypt: true,
    desc: 'Encrypts the first defender it touches: 10 s offline unless patched.' },
  { id: 'miner', name: 'Cryptominer', first: 25, hp: 450, speed: 0.16, threat: 4, bite: 100, drain: 2,
    desc: 'Steals 2 cycles a second for as long as it runs.' },
  { id: 'rootkit', name: 'Rootkit', first: 31, hp: 400, speed: 0.25, threat: 4.5, bite: 100, cloak: true,
    desc: 'Cloaked: shots pass through it until it bites, an area effect hits it or it passes the middle.' },
  { id: 'zeroday', name: 'Zero-day', first: 35, hp: 700, speed: 0.3, threat: 5.5, bite: 100, immune: true,
    desc: 'Nobody has a signature yet: it cannot be slowed or frozen.' },
  { id: 'polymorph', name: 'Polymorph', first: 41, hp: 600, speed: 0.22, threat: 5.5, bite: 100, morph: true,
    desc: 'At half health it rewrites itself: jumps to a neighbour lane and heals.' },
  // ── the expansion (levels 51-150): what each does is in enemies-late ──
  { id: 'keylogger', name: 'Keylogger', first: 52, hp: 350, speed: 0.24, threat: 4.5, bite: 100, steal: 10,
    desc: 'While it bites, it also steals 10 cycles a second.' },
  { id: 'logicbomb', name: 'Logic Bomb', first: 56, hp: 300, speed: 0.26, threat: 4.5, bite: 100, blast: 300,
    desc: 'Explodes where it dies: 300 to every defender in the 3x3 around it. A breaker defuses it.' },
  { id: 'amplifier', name: 'Amplifier', first: 62, hp: 500, speed: 0.18, threat: 6, bite: 100,
    aura: 1.5, haste: 30, guard: 30,
    desc: 'Other enemies within 1.5 cells move 30 % faster and take 30 % less damage.' },
  { id: 'wiper', name: 'Wiper', first: 67, hp: 250, speed: 0.34, threat: 5, bite: 100, wipe: true,
    desc: 'Destroys the first defender it touches outright, and dies with it.' },
  { id: 'hive', name: 'Hive', first: 73, hp: 1200, speed: 0.12, threat: 9, bite: 100,
    release: 'drone', every: 5, cap: 4,
    desc: 'On the floor it releases a DDoS Drone every 5 s, up to 4 of its own alive at once.' },
  { id: 'hydra', name: 'Hydra', first: 78, hp: 600, speed: 0.2, threat: 7, bite: 100, aura: 1.5, heal: 30,
    desc: 'Heals other enemies within 1.5 cells by 30 HP/s, never itself.' },
  { id: 'payload', name: 'Encrypted Payload', first: 84, hp: 500, shield: 600, speed: 0.18, threat: 7, bite: 100,
    desc: 'A 600 shield takes lane shots first; area, floor and beam damage go past it.' },
  { id: 'jammer', name: 'Jammer', first: 93, hp: 450, speed: 0.2, threat: 6.5, bite: 100, aura: 2,
    desc: 'On the floor, shooters within 2 cells of it cannot fire.' },
  { id: 'replicator', name: 'Replicator', first: 103, hp: 800, speed: 0.2, threat: 9, bite: 100, gens: 3,
    desc: 'At half HP it splits into two copies of half size, which split once more.' },
  { id: 'dropper', name: 'Dropper', first: 112, hp: 700, speed: 0.16, threat: 8, bite: 100,
    drop: 'bot', every: 8, ahead: 3, minX: 3,
    desc: 'Every 8 s throws a Bot 3 cells ahead, over your defenders, never over an Air Gap.' },
  { id: 'titan', name: 'Kernel Panic', first: 123, hp: 4000, speed: 0.1, threat: 24, bite: 300, cap: 600, crush: true,
    desc: 'Bites 300 HP/s, crushes grates and honeypots; an instant does at most 600 to it.' },
  { id: 'glitch', name: 'Glitch', first: 134, hp: 500, speed: 0.22, threat: 8, bite: 100, every: 4, blink: 1,
    desc: 'Every 4 s it blinks a cell forward, but never past a defender.' }
];

var PKS_ENEMY = pksIndex(PKS_ENEMIES);

// The APT, one tier per boss level (10, 20 ... 150).  Each tier adds an
// ability: summon (every summonEvery s, the types in `summon` beside it),
// lane change (every laneEvery s), volley (every volleyEvery s one shot of
// volleyDmg into its lane and both neighbours), cloak phases (every
// cloakEvery s cloaked for cloakFor s).  0 means the tier lacks it.
var PKS_BOSS_TIERS = [
  { tier: 1, level: 10, name: 'APT-1 Lurker', hp: 2400, speed: 0.12, bite: 100,
    summon: ['bot'], summonEvery: 14, laneEvery: 0, volleyEvery: 0, volleyDmg: 0, cloakEvery: 0, cloakFor: 0,
    desc: 'Calls in Bots every 14 s.' },
  { tier: 2, level: 20, name: 'APT-2 Pivot', hp: 3500, speed: 0.12, bite: 150,
    summon: ['bot', 'kiddie'], summonEvery: 14, laneEvery: 16, volleyEvery: 0, volleyDmg: 0, cloakEvery: 0, cloakFor: 0,
    desc: 'Calls in help and pivots to a neighbour lane every 16 s.' },
  { tier: 3, level: 30, name: 'APT-3 Exfil', hp: 4800, speed: 0.12, bite: 200,
    summon: ['kiddie', 'worm'], summonEvery: 15, laneEvery: 16, volleyEvery: 9, volleyDmg: 60, cloakEvery: 0, cloakFor: 0,
    desc: 'Adds a volley into three lanes every 9 s.' },
  { tier: 4, level: 40, name: 'APT-4 Ghost', hp: 6000, speed: 0.12, bite: 200,
    summon: ['bot', 'exploit'], summonEvery: 15, laneEvery: 16, volleyEvery: 9, volleyDmg: 60, cloakEvery: 18, cloakFor: 5,
    desc: 'Adds cloak phases: lane shots miss it for 5 s.' },
  { tier: 5, level: 50, name: 'APT-5 Kingpin', hp: 7500, speed: 0.1, bite: 250,
    summon: ['bot', 'kiddie'], summonEvery: 14, laneEvery: 14, volleyEvery: 8, volleyDmg: 60, cloakEvery: 16, cloakFor: 5,
    desc: 'Everything at once, faster.' },
  // ── the expansion (levels 60-150): the abilities are in bosses.  shield:
  // a shield of that HP from the start, back to full every shieldEvery s;
  // mend: heals other enemies within mendReach cells by mend HP/s; jam:
  // shooters within jam cells cannot fire; split: at its end it splits into
  // two bosses of split HP; twin: the level brings two of it.  body: which of
  // the three boss bodies a renderer draws (1 the APT of tiers 1-5), hue: a
  // hue shift in degrees it may apply.
  { tier: 6, level: 60, name: 'APT-6 Bulwark', hp: 9600, speed: 0.1, bite: 250,
    summon: ['keylogger', 'bot'], summonEvery: 14, laneEvery: 16, volleyEvery: 9, volleyDmg: 60, cloakEvery: 0, cloakFor: 0,
    shield: 500, shieldEvery: 25, mend: 0, mendReach: 0, jam: 0, split: 0, twin: false, body: 2, hue: 0,
    desc: 'A 500 shield takes lane shots first and comes back every 25 s.' },
  { tier: 7, level: 70, name: 'APT-7 Warden', hp: 9700, speed: 0.1, bite: 250,
    summon: ['wiper', 'logicbomb'], summonEvery: 14, laneEvery: 16, volleyEvery: 9, volleyDmg: 60, cloakEvery: 0, cloakFor: 0,
    shield: 0, shieldEvery: 0, mend: 30, mendReach: 1.5, jam: 0, split: 0, twin: false, body: 3, hue: 0,
    desc: 'Heals its escort within 1.5 cells by 30 HP/s and calls in Wipers.' },
  { tier: 8, level: 80, name: 'APT-8 Static', hp: 10500, speed: 0.1, bite: 250,
    summon: ['amplifier', 'bot'], summonEvery: 15, laneEvery: 16, volleyEvery: 9, volleyDmg: 60, cloakEvery: 0, cloakFor: 0,
    shield: 0, shieldEvery: 0, mend: 0, mendReach: 0, jam: 1.5, split: 0, twin: false, body: 1, hue: 60,
    desc: 'Shooters within 1.5 cells of it cannot fire.' },
  { tier: 9, level: 90, name: 'APT-9 Schism', hp: 10600, speed: 0.1, bite: 250,
    summon: ['hydra', 'kiddie'], summonEvery: 15, laneEvery: 16, volleyEvery: 9, volleyDmg: 60, cloakEvery: 0, cloakFor: 0,
    shield: 0, shieldEvery: 0, mend: 0, mendReach: 0, jam: 0, split: 2500, twin: false, body: 2, hue: 120,
    desc: 'At its end it splits into two bosses of 2500 HP.' },
  { tier: 10, level: 100, name: 'APT-10 Shade', hp: 10700, speed: 0.1, bite: 250,
    summon: ['jammer', 'bot'], summonEvery: 15, laneEvery: 16, volleyEvery: 9, volleyDmg: 60, cloakEvery: 16, cloakFor: 5,
    shield: 500, shieldEvery: 25, mend: 0, mendReach: 0, jam: 0, split: 0, twin: false, body: 3, hue: 200,
    desc: 'Shield phases and cloak phases at once.' },
  { tier: 11, level: 110, name: 'APT-11 Weaver', hp: 10800, speed: 0.1, bite: 250,
    summon: ['replicator', 'kiddie'], summonEvery: 15, laneEvery: 12, volleyEvery: 9, volleyDmg: 60, cloakEvery: 0, cloakFor: 0,
    shield: 600, shieldEvery: 25, mend: 30, mendReach: 1.5, jam: 0, split: 0, twin: false, body: 1, hue: 280,
    desc: 'Shields itself, heals its escort and changes lanes every 12 s.' },
  { tier: 12, level: 120, name: 'APT-12 Collector', hp: 10900, speed: 0.1, bite: 250,
    summon: ['dropper', 'bot'], summonEvery: 15, laneEvery: 14, volleyEvery: 8, volleyDmg: 80, cloakEvery: 0, cloakFor: 0,
    shield: 0, shieldEvery: 0, mend: 0, mendReach: 0, jam: 1.5, split: 3000, twin: false, body: 2, hue: 240,
    desc: 'Jams shooters within 1.5 cells and splits into two of 3000 HP.' },
  { tier: 13, level: 130, name: 'APT-13 Operator', hp: 11000, speed: 0.1, bite: 250,
    summon: ['wiper', 'dropper'], summonEvery: 14, laneEvery: 14, volleyEvery: 8, volleyDmg: 80, cloakEvery: 0, cloakFor: 0,
    shield: 600, shieldEvery: 22, mend: 40, mendReach: 2, jam: 1.5, split: 0, twin: false, body: 3, hue: 120,
    desc: 'Shield phases, a healing aura and jamming at once.' },
  { tier: 14, level: 140, name: 'APT-14 Observer', hp: 11100, speed: 0.1, bite: 250,
    summon: ['glitch', 'kiddie'], summonEvery: 14, laneEvery: 14, volleyEvery: 8, volleyDmg: 80, cloakEvery: 16, cloakFor: 5,
    shield: 600, shieldEvery: 22, mend: 40, mendReach: 2, jam: 1.5, split: 3000, twin: false, body: 1, hue: 180,
    desc: 'Every ability so far, and it splits into two of 3000 HP.' },
  { tier: 15, level: 150, name: 'APT-15 Architect', hp: 11350, speed: 0.1, bite: 250,
    summon: ['glitch', 'bot'], summonEvery: 20, laneEvery: 20, volleyEvery: 12, volleyDmg: 40, cloakEvery: 20, cloakFor: 3,
    shield: 300, shieldEvery: 30, mend: 10, mendReach: 1, jam: 0, split: 1000, twin: true, body: 3, hue: 320,
    desc: 'Two of them sharing its HP: every ability but jamming; each splits into two of 1000 HP.' }
];

// A new enemy on the field.  Fields every enemy has (so states are uniform):
//   id, type, lane, x (cells), hp, maxHp, speed (cells/s now, with the
//   level's speed factor), bite (HP/s), tier (boss tier, 0 for the rest)
//   state  'walking' | 'biting' | 'throwing' | 'leaping' | 'casting' | 'frozen'
//   anim   animation clock in steps (stands still while frozen)
//   flash  steps of the white hit flash; slow, frozen: steps left
//   cloaked  lane shots pass through; used: the one-off special is spent
//   t      steps to the next throw / drain / end of an encryption cast
//   leapTo x where a leap lands; from, shift: the lane before a lane change
//          and the steps left of its animation (from is -1 otherwise)
//   cast   steps left of the boss's casting frame
//   summonT, moveT, volleyT, cloakT: steps to the boss's next ability
// and, for the expansion (see enemies-late; 0 / false / -1 for the rest):
//   t      also the Keylogger's steal tick and the Hive's, Dropper's and
//          Glitch's ability timer (it starts at the row's `every`)
//   shield, maxShield  the Encrypted Payload's shield HP now and at full
//   gen    a Replicator's generation, 1..3 (0 for every other enemy)
//   aura   radius in cells of the aura it projects now (Amplifier, Hydra,
//          Jammer while on the floor), 0 otherwise
//   amped  inside an Amplifier's aura this step
//   mended the tick a Hydra last healed it (-1: never)
//   hive   the id of the Hive that released it (0: none)
//   moveFrom, move  x before a knockback, blink or throw and the steps left
//          of that slide (the renderer slides from moveFrom to x)
//   knocked steps left before a Loopback may throw it back again; knocks
//          how often one has (at most the Loopback's `times`)
// and, for the zone rules (see zones):
//   crossed  the crossover cells (lane * 9 + col) it has already taken
// A boss of tier 6-15 also uses shield / maxShield (its shield phases), t
// (steps to the next shield phase) and used (a copy from a split).
function pksSpawnEnemy(sim, type, lane, x, tier) {
  var def = type === 'boss' ? PKS_BOSS_TIERS[tier - 1] : PKS_ENEMY[type];
  // a twin tier's HP is the pair's: each of the two has half
  var hp = def.twin ? def.hp / 2 : def.hp;
  var e = {
    id: sim.nextId++, type: type, lane: lane, x: x, hp: hp, maxHp: hp,
    speed: (def.fast || def.speed) * sim.level.speed, bite: def.bite, tier: type === 'boss' ? tier : 0,
    state: 'walking', anim: 0, flash: 0, slow: 0, frozen: 0, cloaked: !!def.cloak, used: false,
    t: pksSteps(def.every || 0), leapTo: 0, from: -1, shift: 0, cast: 0,
    summonT: pksSteps(def.summonEvery || 0), moveT: pksSteps(def.laneEvery || 0),
    volleyT: pksSteps(def.volleyEvery || 0), cloakT: pksSteps(def.cloakEvery || 0),
    shield: def.shield || 0, maxShield: def.shield || 0, gen: def.gens ? 1 : 0, aura: 0, amped: false,
    mended: -1, hive: 0, moveFrom: -1, move: 0, knocked: 0, crossed: [], knocks: 0
  };
  sim.enemies.push(e);
  pksEmit(sim, { type: 'spawn', id: e.id, enemy: type, lane: lane, x: x });
  return e;
}

// dmg to enemy e (alive: every caller checks).  how: 'shot' (lane shots,
// which a cloak dodges), 'area' (pulses, beams, grates: they also uncloak a
// Rootkit), 'instant' (capped against the boss) or 'breaker'.  The
// expansion: an instant does at most its row's cap to a Kernel Panic; an
// enemy in an Amplifier's aura takes its guard less (not from a breaker); a
// lane shot goes into a Payload's shield first; a Replicator at half HP or
// below splits (even when the blow would have killed it).
function pksHurt(sim, e, dmg, how) {
  if (e.tier > 0 && how === 'instant') dmg = Math.min(dmg, PKS_BOSS_CAP);
  if (e.type === 'titan' && how === 'instant') dmg = Math.min(dmg, PKS_ENEMY.titan.cap);
  if (e.amped && how !== 'breaker') dmg *= 1 - PKS_ENEMY.amplifier.guard / 100;
  if (e.shield > 0 && how === 'shot') dmg = pksShieldTake(sim, e, dmg);
  e.hp -= dmg;
  if (dmg >= 1) e.flash = PKS_FLASH;
  if (e.cloaked && e.type === 'rootkit' && how !== 'shot') pksUncloak(sim, e);
  if (e.gen > 0 && e.gen < PKS_ENEMY.replicator.gens && e.hp <= e.maxHp / 2) {
    pksSplit(sim, e);
    return;
  }
  if (e.hp <= 0) {
    pksKill(sim, e, how);
  } else if (e.type === 'polymorph' && !e.used && e.hp <= e.maxHp / 2) {
    pksMorph(sim, e);
  }
}

function pksUncloak(sim, e) {
  e.cloaked = false;
  pksEmit(sim, { type: 'cloak', id: e.id, lane: e.lane, x: e.x, on: false });
}

function pksKill(sim, e, how) {
  e.hp = 0;
  sim.stats.kills++;
  pksEmit(sim, { type: 'kill', id: e.id, enemy: e.type, lane: e.lane, x: e.x, by: how });
  var def = PKS_ENEMY[e.type];
  if (def && def.spawn) {
    pksSpawnEnemy(sim, def.spawn, e.lane, e.x, 0);
    pksSpawnEnemy(sim, def.spawn, e.lane, Math.min(PKS_SPAWN_X, e.x + 0.4), 0);
  }
  // a Logic Bomb goes off at the end of the step (pksBlasts), unless a
  // breaker cut it
  if (e.type === 'logicbomb' && how !== 'breaker') e.used = true;
  // a boss of a splitting tier comes apart (bosses)
  if (e.tier > 0 && how !== 'breaker') pksBossSplit(sim, e);
}

// Polymorph at half HP: to a neighbour lane in play (picked by the sim's
// RNG), and back half of what it lost.
function pksMorph(sim, e) {
  e.used = true;
  e.hp += (e.maxHp - e.hp) / 2;
  var to = pksNeighbourLane(sim, e.lane);
  pksEmit(sim, { type: 'morph', id: e.id, from: e.lane, lane: to, x: e.x });
  pksShift(e, to);
}

// A random lane next to `lane` that is in play, or `lane` when there is none.
function pksNeighbourLane(sim, lane) {
  var up = pksLaneOpen(sim, lane - 1);
  var down = pksLaneOpen(sim, lane + 1);
  if (up && down) return pksRand(sim) < 0.5 ? lane - 1 : lane + 1;
  if (up) return lane - 1;
  if (down) return lane + 1;
  return lane;
}

function pksShift(e, to) {
  e.from = e.lane;
  e.lane = to;
  e.shift = pksSteps(PKS_SHIFT_TIME);
}

// Freeze for `seconds`: a Zero-day shrugs it off, the boss holds briefly.
function pksFreeze(e, seconds) {
  if (e.type === 'zeroday') return;
  var steps = pksSteps(e.tier > 0 ? Math.min(seconds, PKS_BOSS_FREEZE) : seconds);
  if (steps > e.frozen) e.frozen = steps;
}

function pksSlow(e, seconds) {
  if (e.type === 'zeroday') return;
  var steps = pksSteps(seconds);
  if (steps > e.slow) e.slow = steps;
}

// An enemy reached the rack.  An armed breaker trips: every enemy in the
// lane is wiped, except the heavy ones (the boss, and the expansion's Kernel
// Panic), which are thrown back (never forward) and hurt.  A tripped
// breaker means a Breach: the level is lost.
function pksRackHit(sim, e) {
  if (sim.breakers[e.lane] === 'tripped') {
    sim.status = 'lost';
    pksEmit(sim, { type: 'lose', lane: e.lane, id: e.id, enemy: e.type });
    return;
  }
  sim.breakers[e.lane] = 'tripped';
  sim.tripped++;
  pksEmit(sim, { type: 'breaker', lane: e.lane });
  for (var i = 0; i < sim.enemies.length; i++) {
    var o = sim.enemies[i];
    if (o.lane !== e.lane || o.hp <= 0) continue;
    if (pksHeavy(o)) {
      o.x = Math.max(o.x, PKS_BOSS_PUSH);
      pksHurt(sim, o, o.maxHp * PKS_BOSS_BREAKER, 'breaker');
    } else {
      pksKill(sim, o, 'breaker');
    }
  }
}

// One step of enemy e (alive).
function pksEnemyAct(sim, e) {
  if (e.flash > 0) e.flash--;
  if (e.shift > 0) e.shift--;
  if (e.cast > 0) e.cast--;
  if (e.move > 0) e.move--;
  if (e.knocked > 0) e.knocked--;
  if (e.frozen > 0) {
    e.frozen--;
    e.state = 'frozen';
    return;
  }
  e.anim++;
  if (e.slow > 0) e.slow--;
  var mult = e.slow > 0 ? 0.5 : 1;
  if (e.type === 'miner') pksDrain(sim, e);
  if (e.tier > 0) pksBossAct(sim, e);
  else pksLateEnemyAct(sim, e);
  if (e.cloaked && e.type === 'rootkit' && e.x <= PKS_UNCLOAK_X) pksUncloak(sim, e);
  if (e.state === 'leaping') {
    e.x -= (1 + PKS_REACH) / PKS_LEAP_TIME / PKS_RATE;
    if (e.x <= e.leapTo) {
      e.x = e.leapTo;
      e.state = 'walking';
    }
  } else if (e.state === 'casting' && e.t > 0) {
    e.t--;
    return;
  } else if (e.type === 'phisher' && pksPhish(sim, e)) {
    return;
  } else {
    var d = pksBlocker(e);
    if (d) {
      pksContact(sim, e, d, mult);
      return;
    }
    e.x -= e.speed * (e.amped ? mult * (1 + PKS_ENEMY.amplifier.haste / 100) : mult) * pksLaneSpeed[e.lane] / PKS_RATE;
    e.state = 'walking';
  }
  if (e.x <= 0) pksRackHit(sim, e);
}

// The defender e is touching: the one whose centre is within reach on its
// left (WAF Grates are walked over).  An enemy still off the floor touches
// nothing: it walks on first, where shooters can see it.  Past level 50
// also the defender whose cell e is inside of, left of its centre
// (pksInside), first.
function pksBlocker(e) {
  if (e.x > PKS_FLOOR_END) return null;
  var d = pksInside(e);
  if (d) return d;
  var col = Math.ceil(e.x - 0.5 - PKS_REACH);
  if (col >= e.x - 0.5) return null;
  d = pksCell(e.lane, col);
  return d && d.kind !== 'floor' ? d : null;
}

// Past level 50 (pksLateStep): the defender (not a grate) in whose cell e
// stands left of its centre, x in (col, col + 0.5], or null.  A walking
// enemy never gets there (it stops 0.7 right of the centre), but one put
// there sideways or forward does: pulled by a Sinkhole, crossing over,
// thrown by a Dropper, a split copy, a Polymorph or the boss changing lanes,
// or a defender placed on top of it.  It is stopped by that defender and
// bites it, rather than walking out of it toward the rack.  (Levels 1-50
// keep their old rule: such an enemy walks on.)
function pksInside(e) {
  if (!pksLateStep) return null;
  var col = Math.ceil(e.x) - 1;
  var d = pksCell(e.lane, col);
  return d && d.kind !== 'floor' && e.x <= col + 0.5 ? d : null;
}

// A crusher sets off a trap it steps on, armed or not, like any enemy an
// armed one.  The expansion: a Honeynet goes off the same way, and a crusher
// that lives through its blast then crushes it; a Wiper destroys what it touches; a
// Reverse Proxy, an Air Gap or a Canary stops an Exploit's leap; a Keylogger
// steals while it bites.
function pksContact(sim, e, d, mult) {
  var crush = e.type === 'brute' || e.tier > 0 || e.type === 'titan';
  // a trap in a lane under an outage (zones) is only bitten
  if (d.kind === 'trap' && (d.state === 'armed' || crush) && d.lane !== pksDownLane) {
    pksHoneypot(sim, d);
    // a crusher that lives through a Honeynet's blast crushes it at once
    // (it would set it off again every step while it re-arms)
    if (crush && e.hp > 0 && d.hp > 0) pksDropDefender(sim, d, 'crushed');
    return;
  }
  if (e.type === 'wiper') {
    pksWipe(sim, e, d);
    return;
  }
  if (e.type === 'exploit' && !e.used) {
    e.used = true;
    e.speed = PKS_ENEMY.exploit.speed * sim.level.speed;
    if (!pksStopsLeap(d)) {
      e.state = 'leaping';
      e.leapTo = d.col - 0.25;
      pksEmit(sim, { type: 'leap', id: e.id, lane: e.lane, x: e.x, to: e.leapTo });
      return;
    }
  }
  if (e.type === 'ransom' && !e.used && d.enc === 0 && d.off === 0) {
    e.used = true;
    e.state = 'casting';
    e.t = pksSteps(PKS_RANSOM_CAST);
    d.enc = pksSteps(PKS_RANSOM_CAST);
    pksEmit(sim, { type: 'encrypt', id: d.id, by: e.id, lane: d.lane, col: d.col });
    return;
  }
  if (e.cloaked && e.type === 'rootkit') pksUncloak(sim, e);
  e.state = 'biting';
  d.hp -= e.bite * mult / PKS_RATE;
  if (e.type === 'keylogger') pksSteal(sim, e);
  if (d.hp <= 0) pksDropDefender(sim, d, 'eaten');
}

// A Honeypot goes off: 900 to everything in its cell, then it is gone.  A
// Honeynet (a trap with `rearm`) stays and arms again `rearm` s later.
function pksHoneypot(sim, d) {
  var def = PKS_DEF[d.type];
  pksEmit(sim, { type: 'blast', id: d.id, def: d.type, lane: d.lane, col: d.col });
  var list = pksLane(d.lane);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e.hp > 0 && e.x >= d.col && e.x <= d.col + 1 + PKS_REACH && pksInLane(e, d.lane)) pksHurt(sim, e, def.dmg, 'instant');
  }
  if (def.rearm) {
    d.t = pksSteps(def.rearm);
    d.state = 'arming';
    return;
  }
  pksDropDefender(sim, d, 'spent');
}

// Phisher: once on the floor, stops `range` cells short of the nearest
// defender on its left and throws.  Returns whether it stopped.  When that
// nearest defender is a Canary it walks on and bites it instead.
function pksPhish(sim, e) {
  var def = PKS_ENEMY.phisher;
  // one inside a defender's cell bites it (pksInside)
  if (e.x > PKS_FLOOR_END || pksInside(e)) return false;
  for (var col = Math.min(PKS_COLS - 1, Math.floor(e.x - 0.5)); col >= 0; col--) {
    var d = pksCell(e.lane, col);
    if (!d || d.kind === 'floor') continue;
    if (d.kind === 'decoy') return false;
    if (e.x - (col + 0.5) > def.range) return false;
    e.state = 'throwing';
    if (e.t > 0) e.t--;
    if (e.t === 0) {
      pksShoot(sim, 'phish', e.lane, e.x - PKS_BODY, -1, def.throwDmg, e, 0);
      e.t = pksSteps(def.throwEvery);
    }
    return true;
  }
  return false;
}

// Cryptominer: one cycle every PKS_DRAIN_TICK while on the floor.
function pksDrain(sim, e) {
  if (e.x > PKS_FLOOR_END) return;
  if (e.t > 0) e.t--;
  if (e.t === 0) {
    if (sim.cycles > 0) sim.cycles--;
    e.t = pksSteps(PKS_DRAIN_TICK);
  }
}

// The boss's abilities, each on its own timer (0: the tier lacks it).
function pksBossAct(sim, e) {
  var tier = PKS_BOSS_TIERS[e.tier - 1];
  var i;
  if (tier.summonEvery > 0 && --e.summonT <= 0) {
    e.summonT = pksSteps(tier.summonEvery);
    e.cast = pksSteps(0.6);
    pksEmit(sim, { type: 'summon', id: e.id, lane: e.lane, x: e.x });
    for (i = 0; i < tier.summon.length; i++) {
      pksSpawnEnemy(sim, tier.summon[i], e.lane, Math.min(PKS_SPAWN_X, e.x + 0.6 + i * 0.5), 0);
    }
  }
  if (tier.laneEvery > 0 && --e.moveT <= 0) {
    e.moveT = pksSteps(tier.laneEvery);
    var to = pksNeighbourLane(sim, e.lane);
    pksEmit(sim, { type: 'morph', id: e.id, from: e.lane, lane: to, x: e.x });
    pksShift(e, to);
  }
  if (tier.volleyEvery > 0 && --e.volleyT <= 0) {
    e.volleyT = pksSteps(tier.volleyEvery);
    e.cast = pksSteps(0.6);
    for (var l = e.lane - 1; l <= e.lane + 1; l++) {
      if (pksLaneOpen(sim, l)) pksShoot(sim, 'volley', l, e.x - 0.5, -1, tier.volleyDmg, e, 0);
    }
  }
  if (tier.cloakEvery > 0 && --e.cloakT <= 0) {
    e.cloaked = !e.cloaked;
    e.cloakT = pksSteps(e.cloaked ? tier.cloakFor : tier.cloakEvery);
    pksEmit(sim, { type: 'cloak', id: e.id, lane: e.lane, x: e.x, on: e.cloaked });
  }
  if (e.tier > 5) pksLateBossAct(sim, e, tier);
}
