// ── bosses: the abilities of boss tiers 6-15 ──
// Owns pksLateBossAct (called by pksBossAct for tiers 6-15) and pksBossSplit
// (called by pksKill for every boss).  Uses core; inside function bodies also
// enemies (PKS_BOSS_TIERS, pksSpawnEnemy, pksNeighbourLane), sim (pksEmit,
// pksLane) and enemies-late (pksNear).  The jam aura is set in pksAuras
// (enemies-late), the twin bosses of level 150 by the generator (levels).
//
// The abilities as they play (numbers from the tier rows):
//   shield   the boss starts with `shield` HP of shield (shield / maxShield,
//            as an Encrypted Payload: lane shots break it first, area, beam,
//            floor and instant damage go past, a Decryptor strips it);
//            every shieldEvery s it is back to full ('shieldUp', only when
//            it was not full).  The timer is the boss's t.
//   mend     every other damaged enemy within mendReach cells (centre to
//            centre, a lane counting one cell) of a boss on the floor regains
//            mend HP/s, never above full; one healer an enemy a step (mended,
//            shared with the Hydra).  Never a heavy one: the twin bosses of
//            level 150 (and their split copies) would otherwise heal each
//            other, and a Kernel Panic is the boss's size.
//   jam      on the floor and not frozen, its aura is `jam` cells: every
//            defender of a shooter kind within it cannot fire (as a Jammer).
//   split    killed by anything but a breaker, it splits into two bosses of
//            the same tier with `split` HP each, at full health, no shield
//            and no shield phases, where it stood and 0.4 cells behind in a
//            neighbour lane in play (the sim's RNG picks it, as for a
//            Polymorph); they keep its freeze and slow, and do not split
//            again (used).  'kill' for the boss, then 'bossSplit'.
//   twin     the level brings two of it, in lanes 1 and 3, with the final
//            surge; the tier's hp is the pair's, each has half of it.
// The rules of every boss stay: an instant does at most PKS_BOSS_CAP to it,
// a freeze holds it at most PKS_BOSS_FREEZE s, a breaker throws it back and
// takes PKS_BOSS_BREAKER of its full HP; it crushes traps and grates, and it
// walks over crossover cells.

function pksLateBossAct(sim, e, tier) {
  if (tier.shieldEvery > 0 && !e.used) pksShieldPhase(sim, e, tier);
  if (tier.mend > 0 && e.x <= PKS_FLOOR_END) pksMend(sim, e, tier);
}

function pksShieldPhase(sim, e, tier) {
  if (e.t <= 0) {
    e.t = pksSteps(tier.shieldEvery);
    return;
  }
  if (--e.t > 0) return;
  e.t = pksSteps(tier.shieldEvery);
  if (e.shield >= e.maxShield) return;
  e.shield = e.maxShield;
  pksEmit(sim, { type: 'shieldUp', id: e.id, lane: e.lane, x: e.x, shield: e.shield });
}

function pksMend(sim, e, tier) {
  var reach = Math.ceil(tier.mendReach);
  for (var l = e.lane - reach; l <= e.lane + reach; l++) {
    var list = pksLane(l);
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o === e || o.hp <= 0 || o.hp >= o.maxHp || o.mended === sim.tick || pksHeavy(o) || !pksNear(e, o.lane, o.x, tier.mendReach)) continue;
      o.mended = sim.tick;
      o.hp = Math.min(o.maxHp, o.hp + tier.mend / PKS_RATE);
    }
  }
}

// A boss of a splitting tier, just killed: two smaller ones take its place.
function pksBossSplit(sim, e) {
  var tier = PKS_BOSS_TIERS[e.tier - 1];
  if (!tier.split || e.used) return;
  var a = pksSplitCopy(sim, e, e.lane, e.x, tier);
  var b = pksSplitCopy(sim, e, pksNeighbourLane(sim, e.lane), Math.min(PKS_SPAWN_X, e.x + 0.4), tier);
  pksEmit(sim, { type: 'bossSplit', id: e.id, lane: e.lane, x: e.x, children: [a.id, b.id] });
}

function pksSplitCopy(sim, e, lane, x, tier) {
  var c = pksSpawnEnemy(sim, 'boss', lane, x, e.tier);
  c.hp = c.maxHp = tier.split;
  c.shield = c.maxShield = 0;
  c.used = true;
  c.frozen = e.frozen;
  c.slow = e.slow;
  return c;
}
