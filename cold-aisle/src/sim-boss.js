// ── sim-boss: the chiller, the boss of level 9 ──
// Owns cdaBossStep, cdaBossEnter, cdaBossVolley, cdaBossCall and
// cdaBossDamage.  Uses core, tables (CDA_BOSS, CDA_ENEMY), map, sim
// (cdaEmit, cdaHitsBodies) and sim-combat / sim-enemies (cdaSetState,
// cdaKill, cdaWake, cdaSpawnShot, cdaNewEnemy, cdaFacePlayer,
// cdaEnemyEvent).
//
// A rogue air-conditioning unit: it never moves.  Asleep, it wakes like any
// enemy (sight, noise, a hit); after `alert` s it runs CDA_BOSS.loop for good:
//   windup  the frost tell (a windup event)
//   attack  `volleys` fans of `bolts` frost bolts, `gap` s apart, spread over
//           `spread` and centred on the player (bolts is odd: the middle one
//           flies straight at where the player stands; stepping aside or
//           behind a wall avoids a fan: a bolt ends only in a solid cell,
//           never on decor, so cover is a wall or a column of wall cells)
//   call    calls `calls` crawlers (awake at once), at most CDA_BOSS.maxCalled
//           of them alive, on free spots around it (a summon event each)
//   vent    the vents are open (vent events at both ends, also when it is
//           killed with them open: the closing event comes before its die):
//           the only state in which damage counts; any other hit is a `hit`
//           with blocked true
//   idle    a breather
// Each state lasts its phase's seconds of that name.  The phase follows hp:
// 1 above 2/3 of maxHp, 2 above 1/3, else 3; crossing a line sends a phase
// event, closes the vents and puts it at idle.  Killing it opens the lift
// when the racks are clean (sim: cdaLiftCheck).

// The phase for e's hp.
function cdaBossPhase(e) {
  if (e.hp * 3 > e.maxHp * 2) return 1;
  return e.hp * 3 > e.maxHp ? 2 : 3;
}

// Enters CDA_BOSS.loop[n].
function cdaBossEnter(sim, e, n) {
  var ph = CDA_BOSS.phases[e.phase - 1];
  if (e.state === 'vent') cdaEmit(sim, 'vent', { id: e.id, open: false });
  e.loop = n;
  cdaSetState(e, CDA_BOSS.loop[n]);
  if (e.state === 'windup') {
    cdaEnemyEvent(sim, 'windup', e);
  } else if (e.state === 'attack') {
    cdaEnemyEvent(sim, 'attack', e);
    e.burst = 0;
    cdaBossVolley(sim, e, ph);
  } else if (e.state === 'call') {
    cdaBossCall(sim, e, ph);
  } else if (e.state === 'vent') {
    cdaEmit(sim, 'vent', { id: e.id, open: true });
  }
}

function cdaBossStep(sim, e, row) {
  var ph = CDA_BOSS.phases[e.phase - 1];
  if (e.flash > 0) e.flash--;
  cdaFacePlayer(sim, e);
  if (e.state === 'alert') {
    if (e.t >= cdaSteps(row.alert)) cdaBossEnter(sim, e, 0);
    return;
  }
  if (e.state === 'attack' && e.t % cdaSteps(ph.gap) === 0 && e.burst < ph.volleys) cdaBossVolley(sim, e, ph);
  if (e.t >= cdaSteps(ph[e.state])) cdaBossEnter(sim, e, (e.loop + 1) % CDA_BOSS.loop.length);
}

// One fan of frost bolts at the player.
function cdaBossVolley(sim, e, ph) {
  for (var k = 0; k < ph.bolts; k++) {
    cdaSpawnShot(sim, e, 'frost', e.angle + ph.spread * ((k + 0.5) / ph.bolts - 0.5), ph.boltSpeed, CDA_ENEMY.chiller.damage);
  }
  e.burst++;
}

// Calls crawlers on the free spots in the 8 directions (CDA_DIRS order), a
// gap of 0.3 cells out from its body (1.1 cells from its centre).
function cdaBossCall(sim, e, ph) {
  var alive = 0;
  for (var i = 0; i < sim.enemies.length; i++) if (sim.enemies[i].summoned && sim.enemies[i].hp > 0) alive++;
  var want = Math.min(ph.calls, CDA_BOSS.maxCalled - alive);
  var r = CDA_ENEMY.crawler.radius;
  // a probe body far away, so cdaHitsBodies reports any overlap at the spot
  var probe = { x: -1e6, y: -1e6, radius: r };
  for (var k = 0; k < 8 && want > 0; k++) {
    var x = e.x + CDA_DIRS[k * 2] * (e.radius + r + 0.3);
    var y = e.y + CDA_DIRS[k * 2 + 1] * (e.radius + r + 0.3);
    if (cdaHitsWalls(sim, x, y, r) || cdaHitsBodies(sim, probe, x, y)) continue;
    var c = cdaNewEnemy(sim, 'crawler', x, y, true);
    cdaSetState(c, 'alert');
    cdaEmit(sim, 'summon', { id: e.id, child: c.id, x: x, y: y });
    want--;
  }
}

function cdaBossDamage(sim, e, dmg, hx, hy) {
  cdaWake(sim, e, 'hurt');
  var open = e.state === 'vent';
  cdaEmit(sim, 'hit', { id: e.id, kind: e.kind, x: hx, y: hy, damage: open ? dmg : 0, blocked: !open });
  if (!open) return;
  e.hp -= dmg;
  e.flash = cdaSteps(CDA_BOSS.flash);
  if (e.hp <= 0) {
    cdaEmit(sim, 'vent', { id: e.id, open: false });
    cdaKill(sim, e);
    return;
  }
  var phase = cdaBossPhase(e);
  if (phase === e.phase) return;
  e.phase = phase;
  cdaEmit(sim, 'phase', { id: e.id, phase: phase });
  cdaBossEnter(sim, e, CDA_BOSS.loop.length - 1);
}

CDA_API.cdaBossStep = cdaBossStep;
CDA_API.cdaBossDamage = cdaBossDamage;
