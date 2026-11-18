// tests/_cold-aisle-bot.js
// Scripted players for Cold Aisle's levels: they drive the real cdaStep
// through its input only (they read the sim, never change it).  Shared by
// tests/cold-aisle.route*.test.js and the tuning tool
// (.claude/cold-aisle/tune.js).  The name starts with `_` so the test runner
// does not take it for a test module.
//
//   createBot(cda, kind, seed) -> { input(sim) }   one input per step
//   play(cda, index, kind, opts) -> a run summary (see playLevel)
//   PROFILES                                       what each kind does
//
// kinds:
//   reference  plans its own route by breadth-first search over the map
//              (items it needs, badges, racks, the lift once it is open;
//              doors and secret walls opened with Use), faces and shoots what
//              it sees, picks the tool by range and ammo, sidesteps
//              projectiles and charges, holds Use on racks.
//   novice     the same route, but it notices anything new 0.5 s late
//              (enemies, the vents opening, a charge's telegraph), sees only
//              what is in front of it (and in the dark only what its
//              flashlight reaches) until something hurts it, aims with a
//              seeded error of a few degrees per shot, turns slower, never
//              sidesteps projectiles (only charges, late), never opens
//              secret walls.  Nobody buys upgrades: runs use none.
//   idle       stands still.
'use strict';

const PROFILES = {
  reference: { delay: 0, aimErr: 0, turnRate: 10, dodgeShots: true, secrets: true },
  novice: { delay: 0.5, aimErr: 3, turnRate: 5, dodgeShots: false, secrets: false, cone: true },
  idle: null
};

const ENGAGE_ASLEEP = 14;   // cells: a seen asleep enemy closer than this is shot
const ENGAGE_AWAKE = 24;
const FORGET = 1;           // seconds out of sight after which an enemy is new again

function createBot(cda, kind, seed) {
  const prof = PROFILES[kind];
  const R = cda.CDA_RATE;
  const delay = prof ? Math.round(prof.delay * R) : 0;
  const rng = { rng: (seed | 0) ^ 0x2545f491 };
  const st = {
    tick: 0, hurt: -1e9, seen: new Map(), lost: new Map(), vent: new Map(), windup: new Map(), useWas: false,
    plan: null, planCell: -1, planTick: -1e9, bias: 0, shots: -1, stuckAt: null, stuckT: 0, jiggle: 0, jiggleA: 0
  };

  function rand() {
    return cda.cdaRand(rng);
  }

  // ── the map as the bot plans over it ──
  function passable(sim, i) {
    const k = sim.map.kind[i];
    if (k === 'floor') return !sim.map.block[i];
    if (k === 'door') {
      const d = sim.doors[sim.map.door[i]];
      return d.kind === 'plain' || sim.player.badges[d.kind];
    }
    if (k === 'secret') return prof.secrets;
    return false;
  }
  function plainFloor(sim, i) {
    return sim.map.kind[i] === 'floor' && !sim.map.block[i];
  }

  // Breadth-first search from the player's cell: { dist, parent }.
  function bfs(sim) {
    const w = sim.map.w;
    const n = sim.map.kind.length;
    const dist = new Int32Array(n).fill(-1);
    const parent = new Int32Array(n).fill(-1);
    const from = cda.cdaCellOf(sim, sim.player.x, sim.player.y);
    dist[from] = 0;
    const queue = [from];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const j = (y + dy) * w + x + dx;
        if (dist[j] >= 0 || !passable(sim, j)) continue;
        if (dx && dy && !(plainFloor(sim, i) && plainFloor(sim, j) && plainFloor(sim, i + dx) && plainFloor(sim, i + dy * w))) continue;
        dist[j] = dist[i] + 1;
        parent[j] = i;
        queue.push(j);
      }
    }
    return { dist, parent, from };
  }

  function centre(sim, i) {
    const w = sim.map.w;
    return { x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 };
  }

  // Whether the player would gain from an item.
  function wanted(sim, it) {
    const p = sim.player;
    const row = cda.CDA_ITEM[it.kind];
    if (row.tool && p.tools.indexOf(row.tool) < 0) return true;
    if (row.badge) return !p.badges[row.badge];
    if (row.patch) return true;
    if (row.ammo) return p.ammo[row.ammo] < p.caps[row.ammo];
    if (row.health) return p.health < p.maxHealth - row.health * 0.5;
    if (row.armour) return p.armour < cda.CDA_PLAYER.armourMax - row.armour * 0.5;
    return false;
  }

  // The best floor cell beside wall cell c (4 sides) by search distance.
  function standBeside(sim, plan, c) {
    const w = sim.map.w;
    let best = -1;
    for (const o of [1, -1, w, -w]) {
      const j = c + o;
      if (plan.dist[j] >= 0 && sim.map.kind[j] === 'floor' && (best < 0 || plan.dist[j] < plan.dist[best])) best = j;
    }
    return best;
  }

  // The goal: { cell (where to stand), face (cell to face, or -1), act: 'item' | 'rack' | 'lift' | 'hunt', score }.
  function chooseGoal(sim, plan) {
    let goal = null;
    function offer(g) {
      if (!goal || g.score < goal.score) goal = g;
    }
    for (const it of sim.items) {
      if (it.taken || !wanted(sim, it)) continue;
      const c = cda.cdaCellOf(sim, it.x, it.y);
      if (plan.dist[c] < 0) continue;
      const row = cda.CDA_ITEM[it.kind];
      offer({ cell: c, face: -1, act: 'item', score: plan.dist[c] - (row.tool || row.badge ? 6 : 0) });
    }
    for (const r of sim.racks) {
      if (r.state === 'clean') continue;
      const c = standBeside(sim, plan, r.cell);
      if (c >= 0) offer({ cell: c, face: r.cell, act: 'rack', score: plan.dist[c] });
    }
    // the lift waits while a tool lies within reach (the level's lesson)
    const toolLeft = sim.items.some((it) => !it.taken && cda.CDA_ITEM[it.kind].tool && sim.player.tools.indexOf(it.kind) < 0 &&
      plan.dist[cda.cdaCellOf(sim, it.x, it.y)] >= 0);
    if (sim.liftOpen && !toolLeft) {
      for (const l of sim.lifts) {
        const c = standBeside(sim, plan, l.cell);
        if (c >= 0) offer({ cell: c, face: l.cell, act: 'lift', score: plan.dist[c] + 12 });
      }
    }
    if (!goal) {
      // nothing left but enemies (the boss): go toward the nearest one alive
      for (const e of sim.enemies) {
        if (e.hp <= 0) continue;
        const c = cda.cdaCellOf(sim, e.x, e.y);
        const s = standNear(sim, plan, c);
        if (s >= 0) offer({ cell: s, face: -1, act: 'hunt', score: plan.dist[s] });
      }
    }
    return goal;
  }

  // The reachable cell nearest (by search) among those around enemy cell c.
  function standNear(sim, plan, c) {
    if (plan.dist[c] >= 0) return c;
    const w = sim.map.w;
    let best = -1;
    for (let r = 1; r < 4 && best < 0; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const j = c + dy * w + dx;
          if (j >= 0 && j < plan.dist.length && plan.dist[j] >= 0 && (best < 0 || plan.dist[j] < plan.dist[best])) best = j;
        }
      }
    }
    return best;
  }

  function pathTo(plan, cell) {
    const path = [];
    for (let c = cell; c >= 0; c = plan.parent[c]) path.unshift(c);
    return path;
  }

  // ── geometry ──
  function decorHit(sim, x, y, r) {
    for (const d of sim.decor) {
      if (d.solid && cda.cdaDist(x, y, d.x, d.y) < r + d.radius) return true;
    }
    return false;
  }
  function free(sim, x, y, r) {
    return !cda.cdaHitsWalls(sim, x, y, r) && !decorHit(sim, x, y, r);
  }
  function clearLine(sim, ax, ay, bx, by, r) {
    const d = cda.cdaDist(ax, ay, bx, by);
    const n = Math.ceil(d / 0.15);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      if (!free(sim, ax + (bx - ax) * t, ay + (by - ay) * t, r)) return false;
    }
    return true;
  }

  // ── perception ──
  // Whether a visible enemy catches the bot's eye now: the novice only
  // notices what is in front of it (the view plus a margin), right beside
  // it, or anything awake once it has just been hurt (it looks around).
  // In the dark it only makes out what its light reaches: a pitch-dark
  // cell (light 0) within the flashlight, a dim one (light 1) a little
  // further.
  function noticed(sim, e, d) {
    if (!prof.cone || d < 2.5) return true;
    const p = sim.player;
    const light = sim.zones[sim.map.zone[cda.cdaCellOf(sim, e.x, e.y)]].light;
    if (light === 0 && d > p.flashlight) return false;
    if (light === 1 && d > p.flashlight + 4) return false;
    if (st.tick - st.hurt < R && e.state !== 'asleep') return true;
    return Math.abs(cda.cdaAngleDiff(cda.cdaAngleTo(p.x, p.y, e.x, e.y), p.angle)) < cda.CDA_FOV / 2 + 10 * cda.CDA_DEG;
  }

  function look(sim) {
    for (const ev of sim.events) if (ev.type === 'hurt') st.hurt = st.tick;
    const p = sim.player;
    const out = [];
    for (const e of sim.enemies) {
      if (e.hp <= 0) {
        st.seen.delete(e.id);
        continue;
      }
      const d = cda.cdaDist(p.x, p.y, e.x, e.y);
      const vis = d <= ENGAGE_AWAKE && cda.cdaSees(sim, p.x, p.y, e.x, e.y);
      if (vis) {
        if (!st.seen.has(e.id) && noticed(sim, e, d)) st.seen.set(e.id, st.tick);
        st.lost.set(e.id, st.tick);
      } else if (st.seen.has(e.id) && st.tick - st.lost.get(e.id) > FORGET * R) {
        st.seen.delete(e.id);
      }
      if (e.kind === 'chiller') {
        if (e.state === 'vent') {
          if (!st.vent.has(e.id)) st.vent.set(e.id, st.tick);
        } else {
          st.vent.delete(e.id);
        }
      }
      if (e.kind === 'loader') {
        if (e.state === 'windup' && e.t === 1) st.windup.set(e.id, st.tick);
      }
      if (vis && st.seen.has(e.id) && st.tick - st.seen.get(e.id) >= delay) out.push({ e, d });
    }
    return out;
  }

  // Projectiles and charges heading for the player that this bot reacts to:
  // { x, y, dx, dy, speed, r, start (s from now), max (cells) }.
  function threats(sim) {
    const out = [];
    if (prof.dodgeShots) {
      for (const s of sim.shots) {
        const wall = cda.cdaCast(sim, s.x, s.y, s.dx, s.dy, 30, false).dist;
        out.push({ x: s.x, y: s.y, dx: s.dx, dy: s.dy, speed: s.speed, r: cda.CDA_SHOT_RADIUS, start: 0, max: wall });
      }
    }
    const row = cda.CDA_ENEMY.loader;
    for (const e of sim.enemies) {
      if (e.kind !== 'loader' || e.hp <= 0 || (e.state !== 'windup' && e.state !== 'attack')) continue;
      const since = st.windup.has(e.id) ? st.tick - st.windup.get(e.id) : 0;
      if (since < delay) continue;
      const start = e.state === 'windup' ? Math.max(0, cda.cdaSteps(row.windup) - e.t) / R : 0;
      out.push({ x: e.x, y: e.y, dx: Math.cos(e.dir), dy: Math.sin(e.dir), speed: row.chargeSpeed, r: e.radius, start,
        max: row.chargeMax - (e.state === 'attack' ? e.run : 0) });
    }
    return out;
  }

  // How badly moving along (vx, vy) (unit or zero) for the next 0.7 s meets the threats.
  function danger(sim, list, vx, vy) {
    const p = sim.player;
    let reach = 0;
    if (vx || vy) {
      for (const step of [0.3, 0.6, 1, 1.5, 2.4]) {
        if (!free(sim, p.x + vx * step, p.y + vy * step, p.radius)) break;
        reach = step;
      }
    }
    let bad = 0;
    for (const t of list) {
      for (let k = 1; k <= 21; k++) {
        const time = k / 30;
        const run = Math.min(reach, time * cda.CDA_PLAYER.speed);
        const px = p.x + vx * run;
        const py = p.y + vy * run;
        const go = Math.max(0, time - t.start) * t.speed;
        if (go > t.max) break;
        if (cda.cdaDist(px, py, t.x + t.dx * go, t.y + t.dy * go) < p.radius + t.r + 0.12) {
          bad += 2 - time;
          break;
        }
      }
    }
    return bad;
  }

  // Picks the world direction to move: the wanted one (vx, vy, maybe zero)
  // unless it is walled off or (with threats) a nearby one is safer.
  function chooseMove(sim, want, list) {
    const p = sim.player;
    const wl = Math.hypot(want.x, want.y);
    const wx = wl ? want.x / wl : 0;
    const wy = wl ? want.y / wl : 0;
    const now = list.length ? danger(sim, list, wx, wy) : 0;
    if (!now && (!wl || free(sim, p.x + wx * 0.25, p.y + wy * 0.25, p.radius) || !want.flee)) return { x: wx, y: wy };
    let best = { x: 0, y: 0 };
    let bestScore = Infinity;
    const cands = [{ x: 0, y: 0 }];
    for (let k = 0; k < 16; k++) cands.push({ x: Math.cos(k * Math.PI / 8), y: Math.sin(k * Math.PI / 8) });
    for (const c of cands) {
      if ((c.x || c.y) && !free(sim, p.x + c.x * 0.3, p.y + c.y * 0.3, p.radius)) continue;
      const dang = list.length ? danger(sim, list, c.x, c.y) : 0;
      const align = c.x * wx + c.y * wy;
      const score = dang * 10 - align;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  // ── fighting ──
  function pickTool(sim, target, near) {
    const p = sim.player;
    const has = (t) => p.tools.indexOf(t) >= 0;
    const coil = has('degausser') && p.ammo.coil > 0;
    const cell = has('probe') && p.ammo.cell > 0;
    const k = target.e.kind;
    if (coil && (k === 'loader' || (k === 'chiller' && target.d < 7) || (target.d < 4 && near >= 2))) return 'degausser';
    if (cell) return 'probe';
    if (coil && target.d < 6) return 'degausser';
    return 'driver';
  }

  // Whether the bot has noticed the chiller's vents open.
  function ventSeen(e) {
    return st.vent.has(e.id) && st.tick - st.vent.get(e.id) >= delay;
  }

  function chooseTarget(seen) {
    let best = null;
    let bestScore = Infinity;
    for (const s of seen) {
      const e = s.e;
      if (e.state === 'asleep' && s.d > ENGAGE_ASLEEP) continue;
      if (e.state === 'die' || e.state === 'dead') continue;
      let score = s.d - (e.state === 'asleep' ? 0 : 4);
      if (e.kind === 'chiller') score += ventSeen(e) ? -30 : 6;
      else if (e.kind === 'crawler' && s.d < 2.2) score -= 40;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  function steerTo(sim, path) {
    const p = sim.player;
    if (path.length < 2) return centre(sim, path[0]);
    let target = centre(sim, path[1]);
    for (let k = 2; k < Math.min(path.length, 6); k++) {
      if (sim.map.kind[path[k - 1]] !== 'floor' || sim.map.kind[path[k]] !== 'floor') break;
      const c = centre(sim, path[k]);
      if (!clearLine(sim, p.x, p.y, c.x, c.y, p.radius + 0.04)) break;
      target = c;
    }
    return target;
  }

  function input(sim) {
    st.tick++;
    const inp = cda.cdaInputNew();
    if (!prof) return inp;
    const p = sim.player;
    const seen = look(sim);
    const list = threats(sim);
    let face = null;     // angle to face
    let want = { x: 0, y: 0 };
    let use = 'none';    // 'none' | 'pulse' | 'hold'
    let fire = false;

    // the route
    const cell = cda.cdaCellOf(sim, p.x, p.y);
    if (cell !== st.planCell || st.tick - st.planTick > R / 2 || !st.plan) {
      const plan = bfs(sim);
      const goal = chooseGoal(sim, plan);
      st.plan = goal ? { goal, path: pathTo(plan, goal.cell) } : null;
      st.planCell = cell;
      st.planTick = st.tick;
    }

    const target = chooseTarget(seen);
    if (target) {
      const e = target.e;
      const near = seen.filter((s) => s.d < 4.5).length;
      const tool = pickTool(sim, target, near);
      if (tool !== p.tool) inp.weapon = cda.CDA_TOOL[tool].slot;
      if (st.shots !== sim.stats.shots) {
        st.shots = sim.stats.shots;
        st.bias = prof.aimErr ? (rand() * 2 - 1) * prof.aimErr * cda.CDA_DEG : 0;
      }
      const aim = cda.cdaAngleTo(p.x, p.y, e.x, e.y) + st.bias;
      face = aim;
      const err = Math.abs(cda.cdaAngleDiff(aim, p.angle));
      const t = sim.tools[p.tool];
      const tol = Math.atan2(e.radius * 0.8, target.d) + (t.rays > 1 ? t.fan * 0.35 : 0);
      const ventOpen = e.kind !== 'chiller' || ventSeen(e);
      const inReach = p.tool !== 'driver' || target.d < t.reach + e.radius * 0.5;
      fire = err < tol && ventOpen && inReach;
      // movement while fighting
      const away = { x: (p.x - e.x) / target.d, y: (p.y - e.y) / target.d };
      if (p.tool === 'driver' && e.kind !== 'chiller') {
        if (target.d > 0.95) want = { x: -away.x, y: -away.y };
      } else if (e.kind === 'crawler' && target.d - e.radius - p.radius < 1.4) {
        want = { x: away.x, y: away.y, flee: true };
      } else if (e.kind === 'loader' && target.d < 3.5 && e.state !== 'stun') {
        want = { x: away.x, y: away.y, flee: true };
      } else if (e.kind === 'chiller' && target.d < 5) {
        want = { x: away.x, y: away.y, flee: true };
      } else if (e.kind === 'chiller' && target.d > 7.5 && st.plan) {
        want = null;   // walk on toward it
      }
    }
    if (!target || want === null) {
      want = { x: 0, y: 0 };
      if (st.plan) {
        const { goal, path } = st.plan;
        const atGoal = path.length === 1;
        // a door or secret wall ahead: open it
        let blocker = -1;
        for (let k = 1; k < Math.min(path.length, 3); k++) {
          const c = path[k];
          const kind = sim.map.kind[c];
          if (kind === 'secret' || (kind === 'door' && sim.doors[sim.map.door[c]].open < cda.CDA_DOOR_PASS)) {
            blocker = c;
            break;
          }
          if (kind !== 'floor' && kind !== 'door') break;
        }
        if (blocker >= 0 && path[1] === blocker) {
          const c = centre(sim, blocker);
          const d = cda.cdaDist(p.x, p.y, c.x, c.y);
          if (!target) face = cda.cdaAngleTo(p.x, p.y, c.x, c.y);
          if (d > 1.05) {
            want = { x: c.x - p.x, y: c.y - p.y };
          } else {
            const kind = sim.map.kind[blocker];
            const door = kind === 'door' ? sim.doors[sim.map.door[blocker]] : null;
            if (!target && (!door || door.state === 'closed' || door.state === 'closing') &&
                Math.abs(cda.cdaAngleDiff(face, p.angle)) < 0.25) use = 'pulse';
          }
        } else if (atGoal && goal.face >= 0) {
          const c = centre(sim, goal.cell);
          const f = centre(sim, goal.face);
          if (cda.cdaDist(p.x, p.y, c.x, c.y) > 0.2) want = { x: c.x - p.x, y: c.y - p.y };
          if (!target) {
            face = cda.cdaAngleTo(p.x, p.y, f.x, f.y);
            if (cda.cdaDist(p.x, p.y, c.x, c.y) < 0.35 && Math.abs(cda.cdaAngleDiff(face, p.angle)) < 0.06) {
              use = goal.act === 'rack' ? 'hold' : 'pulse';
            }
          }
        } else if (!(goal.act === 'hunt' && target && target.d <= 7.5)) {
          const s = steerTo(sim, path);
          want = { x: s.x - p.x, y: s.y - p.y };
          if (Math.hypot(want.x, want.y) < 0.05 && atGoal) want = { x: 0, y: 0 };
          if (!target) face = Math.atan2(want.y, want.x);
          if (!want.x && !want.y) face = null;
        }
      }
      // reloading the hand: the best ranged tool out of a fight
      if (!target) {
        if (p.tools.indexOf('probe') >= 0 && p.ammo.cell > 0 && p.tool !== 'probe') inp.weapon = cda.CDA_TOOL.probe.slot;
        else if (p.tool === 'driver' && p.tools.indexOf('degausser') >= 0 && p.ammo.coil > 0) inp.weapon = cda.CDA_TOOL.degausser.slot;
      }
    }

    // stuck: a short random walk
    if (st.jiggle > 0) {
      st.jiggle--;
      want = { x: Math.cos(st.jiggleA), y: Math.sin(st.jiggleA) };
    } else if (want.x || want.y) {
      if (!st.stuckAt || cda.cdaDist(p.x, p.y, st.stuckAt.x, st.stuckAt.y) > 0.4) {
        st.stuckAt = { x: p.x, y: p.y };
        st.stuckT = st.tick;
      } else if (st.tick - st.stuckT > 2 * R) {
        st.jiggle = Math.round(0.4 * R);
        st.jiggleA = rand() * Math.PI * 2;
        st.stuckAt = null;
      }
    } else {
      st.stuckAt = null;
    }

    const mv = chooseMove(sim, want, list);
    if (face === null && (mv.x || mv.y)) face = Math.atan2(mv.y, mv.x);
    if (face !== null) {
      const diff = cda.cdaAngleDiff(face, p.angle);
      const lim = prof.turnRate / R;
      inp.turn = Math.max(-lim, Math.min(lim, diff));
    }
    const a = p.angle + inp.turn;
    inp.move = mv.x * Math.cos(a) + mv.y * Math.sin(a);
    inp.strafe = -mv.x * Math.sin(a) + mv.y * Math.cos(a);
    inp.fire = fire;
    if (use === 'hold') inp.use = true;
    else if (use === 'pulse') inp.use = !st.useWas;
    st.useWas = inp.use;
    return inp;
  }

  return { input };
}

// Plays level `index` of CDA_LEVELS from its bare kit (cdaLevelCarry(index,
// null)) with one bot.  opts: { seed, maxTime (s), upgrades }.  Returns
// { won, status, time, health, armour, minHealth, cell, coil, kills,
// enemies, secrets, secretsTotal, racksLeft, hurtBy ({ by: damage before
// armour }), diedAt ({ x, y, by } or null), sim }.
function play(cda, index, kind, opts) {
  const o = opts || {};
  const seed = o.seed === undefined ? 1 : o.seed;
  const lv = cda.cdaParseLevel(cda.CDA_LEVELS[index]);
  const sim = cda.cdaNewSim(lv, cda.cdaLevelCarry(index, null), o.upgrades || {}, seed);
  const bot = createBot(cda, kind, seed);
  const max = cda.cdaSteps(o.maxTime || 600);
  let minHealth = sim.player.health;
  let lastBy = '';
  const hurtBy = {};
  while (sim.status === 'playing' && sim.tick < max) {
    cda.cdaStep(sim, bot.input(sim));
    for (const ev of sim.events) {
      if (ev.type !== 'hurt') continue;
      lastBy = ev.by;
      hurtBy[ev.by] = (hurtBy[ev.by] || 0) + ev.damage + ev.absorbed;
    }
    if (o.trace) o.trace(sim);
    if (sim.player.health < minHealth) minHealth = sim.player.health;
  }
  const r = cda.cdaResult(sim);
  const p = sim.player;
  return {
    won: r.won, status: sim.status, time: r.time, health: p.health, armour: p.armour, minHealth,
    cell: p.ammo.cell, coil: p.ammo.coil, kills: r.kills, enemies: r.enemies, secrets: r.secrets, secretsTotal: r.secretsTotal,
    racksLeft: sim.racks.filter((k) => k.state !== 'clean').length, hurtBy,
    diedAt: sim.status === 'won' ? null : { x: Math.floor(p.x), y: Math.floor(p.y), by: lastBy },
    sim
  };
}

module.exports = { PROFILES, createBot, play };
