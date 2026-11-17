// ── defenders: the expansion, 2 of 2 parts: the rules of the twelve new defenders ──
// Owns PKS_SHOOTER_KINDS, pksLateDefenderAct and the step helpers of the
// defenders that levels 51-150 bring (their rows are in defenders, after the
// frozen 15).  Uses core; inside function bodies also defenders (PKS_DEF,
// pksNewDefender), enemies (pksHurt, pksKill, pksShift, PKS_ENEMY), sim
// (pksEmit, pksShoot, pksLane, pksCell, pksTargetAhead, pksCellScratch) and
// enemies-late (pksHeavy, PKS_SLIDE_TIME).  None draws on the sim's RNG.
//
// The rules as they play (numbers from the rows):
//   Canary       kind decoy, a cheap wall every enemy stops at and bites: an
//                Exploit's leap is spent on it (as on a Reverse Proxy), a
//                Phisher walks up to bite it instead of throwing, a Dropper
//                does not throw while it is at one; a Wiper wipes it (and
//                dies), an armed trap is not needed.  A Glitch never blinks
//                past it (nor past any defender).
//   Tracer       kind sniper: every `every` s, when its lane holds a visible
//                enemy ahead of it on the floor, one hit of dmg ('shot':
//                a shield takes it first) on the toughest of them (most HP
//                plus shield; on a tie the one nearest the rack).  It hits at
//                once ('trace' event; no shot object).
//   Batch Job    kind mortar: every `every` s it lobs a shell at the visible
//                enemy ahead of it, at least minRange cells from its centre,
//                with the most enemies within `splash` cells of it in its
//                lane (on a tie the one nearest the rack).  The shell lands
//                `flight` s later where that enemy stood ('lob', then
//                'splash'): dmg as area damage to every enemy on the floor of
//                its lane within `splash` cells of that point (cloaked or not,
//                past shields).
//   Loopback     kind knock: every `every` s it throws the first visible
//                enemy ahead of it in its lane back `push` cells (a heavy
//                one, the boss or a Kernel Panic, heavyPush), never past the
//                right edge of the floor; a leap in progress ends there.  A
//                thrown enemy cannot be thrown again for `every` s (knocked
//                counts it down), by this Loopback or another, and no enemy
//                is thrown more than `times` times in all (knocks counts
//                them): the first one that may be is the target, so stacked
//                Loopbacks cannot pin an enemy (or the boss) at the edge for
//                good, nor stall a level.
//   Token Ring   kind arc: every `every` s an arc of dmg (area damage: past
//                shields, uncloaks) hits the first visible enemy ahead of it
//                in its lane, then jumps on, up to `hits` enemies in all, each
//                time to the nearest enemy on the floor not hit yet within
//                `reach` cells of the last one, in that one's lane or a lane
//                next to it ('arc' with the path).
//   Signature DB kind booster: every defender of a shooter kind in the 3x3
//                around it (itself excepted) deals boost % more damage while
//                the DB is not disabled; two DBs do not stack (boosted is a
//                flag).
//   DNS Sinkhole kind pull: every `every` s it pulls into its own lane the
//                visible enemy on the floor nearest to it of each lane next
//                to it (not the boss, not a Kernel Panic, not one leaping;
//                'pull'); the lane change slides like a Polymorph's.  It
//                waits while there is nothing to pull.
//   Air Gap      kind wall: an enemy's shot (a Phisher's bait, the boss's
//                volley) that reaches it turns back ('reflect') up its own
//                lane and hits only the unit that threw it, for its own
//                damage, cloaked or not, if that unit is in that lane (a
//                volley's shots in the boss's side lanes fly off the field);
//                nothing leaps over it (an Exploit stops), and a Dropper's
//                throw lands in front of it.
//   Backup       kind backup: when a defender in the 3x3 around it is
//                destroyed (eaten, shot, crushed, wiped or blasted; not
//                spent, not removed), a ready Backup puts a new one of the
//                same type, at full HP and fresh timers, in the same cell at
//                once ('restore'), then needs `every` s.  It restores no
//                instant, no Backup and no Canary (a decoy restored for free
//                every minute would be a free wall).  The first ready one in
//                placing order restores; a disabled one does not.
//   Scrubber     an instant (effect scrub): after its fuse, every enemy on
//                the floor whose full HP is at or under `limit` is destroyed
//                outright (no split, no shield); what appears later in the
//                same step (a Hive's Drone, a thrown Bot) is not.
//   Decryptor    kind decrypt: fires like a Firewall (a 'decrypt' shot every
//                `every` s, dmg); a hit strips a shield whole and does double
//                damage to a shielded enemy, or to an armoured one (the row's
//                `armoured`: Worm, Brute Forcer, Hive, Kernel Panic).
//   Honeynet     a trap with `rearm`: it goes off like a Honeypot (armed, at
//                the first touch; armed or not, under a crusher) but stays,
//                arming again `rearm` s later; while it re-arms it is bitten
//                like an unarmed trap.  A crusher (Brute Forcer, Kernel Panic,
//                the boss) that lives through its blast crushes it at once.
// A Jammer silences the shooter kinds (see enemies-late); a Signature DB
// boosts the same kinds.

var PKS_SHOOTER_KINDS = ['shooter', 'beam', 'sniper', 'mortar', 'arc', 'decrypt'];
var PKS_SHOOTER_KIND = pksKindSet(PKS_SHOOTER_KINDS);   // the same as a lookup

function pksKindSet(kinds) {
  var set = {};
  for (var i = 0; i < kinds.length; i++) set[kinds[i]] = true;
  return set;
}

// dmg with d's Signature DB boost, if it has one this step.
function pksBoosted(d, dmg) {
  return d.boosted ? dmg * (1 + PKS_DEF.sigdb.boost / 100) : dmg;
}

// Whether a working Signature DB stands in the 3x3 around d.
function pksBoostedNow(sim, d) {
  for (var l = d.lane - 1; l <= d.lane + 1; l++) {
    for (var c = d.col - 1; c <= d.col + 1; c++) {
      var o = pksCell(l, c);
      if (o && o.type === 'sigdb' && o.off === 0 && o.lane !== pksDownLane) return true;
    }
  }
  return false;
}

// One step of a defender of the expansion's kinds (decoy, booster and
// backup have none of their own).
function pksLateDefenderAct(sim, d, def) {
  if (d.t > 0) return;
  switch (d.kind) {
    case 'sniper':
      if (!d.jammed) pksTrace(sim, d, def);
      break;
    case 'mortar':
      if (!d.jammed) pksLob(sim, d, def);
      break;
    case 'arc':
      if (!d.jammed) pksArc(sim, d, def);
      break;
    case 'decrypt':
      if (!d.jammed && pksTargetAhead(d.lane, d.col + 0.5)) {
        pksShoot(sim, 'decrypt', d.lane, d.col + 0.7, 1, pksBoosted(d, def.dmg), d, 0);
        pksFired(d, def);
      }
      break;
    case 'knock':
      pksKnock(sim, d, def);
      break;
    case 'pull':
      pksPull(sim, d, def);
      break;
  }
}

function pksFired(d, def) {
  d.t = pksSteps(def.every);
  d.fire = PKS_FIRE_ANIM;
}

// Whether e (of d's lane list) is a target defender d can see ahead (in a
// blackout only within pksSight cells, see zones; past level 50 only while
// e is still in that lane, see pksInLane).
function pksSeen(e, d) {
  return e.hp > 0 && !e.cloaked && e.x > d.col + 0.5 && e.x <= PKS_FLOOR_END && e.x <= d.col + 0.5 + pksSight && pksInLane(e, d.lane);
}

// The first visible enemy ahead of d in its lane (that a Loopback may throw
// now, when `fresh`), or null.
function pksFirstAhead(d, fresh) {
  var list = pksLane(d.lane);
  var best = null;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (pksSeen(e, d) && !(fresh && (e.knocked > 0 || e.knocks >= PKS_DEF.loopback.times)) && (!best || e.x < best.x)) best = e;
  }
  return best;
}

function pksTrace(sim, d, def) {
  var list = pksLane(d.lane);
  var best = null;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!pksSeen(e, d)) continue;
    var tough = e.hp + e.shield;
    if (!best || tough > best.hp + best.shield || (tough === best.hp + best.shield && e.x < best.x)) best = e;
  }
  if (!best) return;
  var dmg = pksBoosted(d, def.dmg);
  pksEmit(sim, { type: 'trace', id: d.id, def: d.type, lane: d.lane, col: d.col, target: best.id, x: best.x, dmg: dmg });
  pksFired(d, def);
  pksHurt(sim, best, dmg, 'shot');
}

// Enemies on the floor of `list` (of `lane`) within r cells of x.
function pksCrowd(list, lane, x, r) {
  var n = 0;
  for (var i = 0; i < list.length; i++) {
    if (list[i].hp > 0 && list[i].x <= PKS_FLOOR_END && Math.abs(list[i].x - x) <= r && pksInLane(list[i], lane)) n++;
  }
  return n;
}

function pksLob(sim, d, def) {
  var list = pksLane(d.lane);
  var best = null;
  var most = 0;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!pksSeen(e, d) || e.x - (d.col + 0.5) < def.minRange) continue;
    var n = pksCrowd(list, d.lane, e.x, def.splash);
    if (n > most || (n === most && e.x < best.x)) {
      best = e;
      most = n;
    }
  }
  if (!best) return;
  var flight = pksSteps(def.flight);
  var s = {
    id: sim.nextId++, owner: d.id, lane: d.lane, from: d.col + 0.5, to: best.x, t: flight, flight: flight,
    dmg: pksBoosted(d, def.dmg), splash: def.splash, done: false
  };
  sim.shells.push(s);
  pksEmit(sim, { type: 'lob', id: d.id, def: d.type, lane: d.lane, col: d.col, shell: s.id, to: s.to, flight: flight });
  pksFired(d, def);
}

// One step of a shell in the air; it lands when its time is up.
function pksShellAct(sim, s) {
  if (--s.t > 0) return;
  s.done = true;
  pksEmit(sim, { type: 'splash', id: s.id, owner: s.owner, lane: s.lane, x: s.to, radius: s.splash });
  var list = pksLane(s.lane);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e.hp > 0 && e.x <= PKS_FLOOR_END && Math.abs(e.x - s.to) <= s.splash && pksInLane(e, s.lane)) pksHurt(sim, e, s.dmg, 'area');
  }
}

function pksKnock(sim, d, def) {
  var e = pksFirstAhead(d, true);
  if (!e) return;
  var from = e.x;
  e.x = Math.min(PKS_FLOOR_END, e.x + (pksHeavy(e) ? def.heavyPush : def.push));
  // it lands against a defender behind it, not inside its cell (where it
  // would bite it, see pksInside)
  var col = Math.ceil(e.x) - 1;
  var back = pksCell(e.lane, col);
  if (back && back.kind !== 'floor' && e.x <= col + 0.5) e.x = col;
  if (e.state === 'leaping') e.state = 'walking';
  e.moveFrom = from;
  e.move = pksSteps(PKS_SLIDE_TIME);
  e.knocked = pksSteps(def.every);
  e.knocks++;
  pksEmit(sim, { type: 'knock', id: d.id, def: d.type, target: e.id, lane: e.lane, from: from, to: e.x });
  pksFired(d, def);
}

function pksArc(sim, d, def) {
  var first = pksFirstAhead(d, false);
  if (!first) return;
  var path = [first];
  var last = first;
  while (path.length < def.hits) {
    var next = null;
    var best = 0;
    for (var l = last.lane - 1; l <= last.lane + 1; l++) {
      var list = pksLane(l);
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (o.hp <= 0 || o.x > PKS_FLOOR_END || path.indexOf(o) >= 0) continue;
        var dl = o.lane - last.lane;
        var dx = o.x - last.x;
        var dist = dl * dl + dx * dx;
        if (dist <= def.reach * def.reach && (!next || dist < best)) {
          next = o;
          best = dist;
        }
      }
    }
    if (!next) break;
    path.push(next);
    last = next;
  }
  var dmg = pksBoosted(d, def.dmg);
  var out = [];
  for (var j = 0; j < path.length; j++) out.push({ id: path[j].id, lane: path[j].lane, x: path[j].x });
  pksEmit(sim, { type: 'arc', id: d.id, def: d.type, lane: d.lane, col: d.col, dmg: dmg, path: out });
  pksFired(d, def);
  for (j = 0; j < path.length; j++) pksHurt(sim, path[j], dmg, 'area');
}

function pksPull(sim, d, def) {
  var c = d.col + 0.5;
  var pulled = 0;
  for (var l = d.lane - 1; l <= d.lane + 1; l += 2) {
    var list = pksLane(l);
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.hp <= 0 || e.cloaked || e.lane !== l || e.x > PKS_FLOOR_END || pksHeavy(e) || e.state === 'leaping') continue;
      if (!best || Math.abs(e.x - c) < Math.abs(best.x - c)) best = e;
    }
    if (!best) continue;
    pksEmit(sim, { type: 'pull', id: d.id, def: d.type, target: best.id, from: l, lane: d.lane, x: best.x });
    pksShift(best, d.lane);
    pulled++;
  }
  if (pulled > 0) pksFired(d, def);
}

// Air Gap: an enemy's shot turns back toward its thrower.
function pksReflect(sim, s, d) {
  s.dir = 1;
  s.from = s.x;
  d.flash = PKS_FLASH;
  pksEmit(sim, { type: 'reflect', id: s.id, by: d.id, lane: s.lane, x: s.x, owner: s.owner });
}

// A shot an Air Gap sent back: it hits only its thrower, or flies off.
function pksReturnAct(sim, s) {
  var list = pksLane(s.lane);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e.id === s.owner && e.hp > 0 && e.x - PKS_BODY <= s.x && pksInLane(e, s.lane)) {
      s.done = true;
      pksEmit(sim, { type: 'hit', id: e.id, shot: s.id, kind: s.kind, lane: s.lane, x: e.x, dmg: s.dmg });
      pksHurt(sim, e, s.dmg, 'shot');
      return;
    }
  }
  if (s.x > PKS_SHOT_END) s.done = true;
}

// A Decryptor's shot on e.
function pksDecryptHit(sim, e, dmg) {
  if (e.shield > 0) {
    e.shield = 0;
    pksEmit(sim, { type: 'shieldBreak', id: e.id, lane: e.lane, x: e.x, by: 'decrypt' });
    dmg *= 2;
  } else if (PKS_DEF.decryptor.armoured.indexOf(e.type) >= 0) {
    dmg *= 2;
  }
  pksHurt(sim, e, dmg, 'shot');
}

// Scrubber: every enemy on the floor whose full HP is at most the limit.
function pksScrub(sim, d, def) {
  pksEmit(sim, { type: 'scrub', id: d.id, def: d.type, lane: d.lane, col: d.col });
  for (var i = 0; i < sim.enemies.length; i++) {
    var e = sim.enemies[i];
    if (e.hp > 0 && e.maxHp <= def.limit && e.x <= PKS_FLOOR_END) pksKill(sim, e, 'instant');
  }
}

// Backup: d (destroyed, not spent) comes back if a ready Backup is next to it.
function pksRestore(sim, d) {
  if (d.kind === 'instant' || d.kind === 'decoy' || d.type === 'backup') return;
  for (var i = 0; i < sim.defenders.length; i++) {
    var b = sim.defenders[i];
    if (b.type !== 'backup' || b.hp <= 0 || b.off > 0 || b.t > 0 || b.lane === pksDownLane || Math.abs(b.lane - d.lane) > 1 || Math.abs(b.col - d.col) > 1) continue;
    var n = pksNewDefender(sim, d.type, d.lane, d.col);
    sim.defenders.push(n);
    pksCellScratch[d.lane * PKS_COLS + d.col] = n;
    b.t = pksSteps(PKS_DEF.backup.every);
    b.fire = PKS_FIRE_ANIM;
    pksEmit(sim, { type: 'restore', id: n.id, by: b.id, old: d.id, def: d.type, lane: d.lane, col: d.col });
    return;
  }
}
