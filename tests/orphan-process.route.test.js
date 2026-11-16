// tests/orphan-process.route.test.js
// Orphan Process (orphan-process/, prefix orp): the world played with the
// real physics.  The room validator in orphan-process.test.js proves the
// rooms with a coarse cell model (straight falls, no jump arcs); here a bot
// plays them.  It feeds keys to orpStep at the real step (1/120 s), room by
// room along a list of waypoints: from the new-game start through every man
// page, both memory modules and every tty to the boss, wins the fight and
// takes nice; then, continued from the title like a player would, it takes
// the way onward, the shortcut down to .local/bin and goes back through
// Downloads, Documents, .cache and .config for the two secrets of /home.
//
// The bot is skilled but not superhuman:
//   - It reacts to what is on screen: it waits for a bug to walk away, for a
//     turret shot to pass or for the sweep bar of the HUD, shoots enemies in
//     front of it and jumps over a shot coming at it while it walks.
//   - Every jump is played again with the jump key pressed 4 steps (33 ms)
//     earlier and 4 later (one jump of a chain at a time, then all of them),
//     and with the run-up starting 3 px either side.  Each version must land
//     where the waypoint says without a hit.
//   - It never takes a hit: a hurt fails the test, so nothing relies on
//     damage (knock-back or the return to safe ground after spikes).
// A failure names the room, the waypoint and what went wrong, with the
// hero's position.
//
// Waypoints (x in tiles, measured at the hero's centre; floor: the tile row
// the hero stands on):
//   go(x)                walk (or fall) there and stop on the ground
//   jump(at, [x0, x1, floor])  run on, press jump as the centre crosses at,
//                        hold it to the apex, steer in the air to the middle
//                        of x0..x1 and land with a foot on those columns of
//                        floor (options: aim, an x to steer to; when, a
//                        condition that presses instead of at; runDir)
//   chain([[at, to], ...])  jumps one after another without a stop
//   hop(dir, floor, to, gap)  run at the nearest bug on floor and jump it
//                        once the gap is under gap px
//   wait(condition)      stand still until it holds
//   jumpShoot, drop, dash, exit, bossFight: see below.
//
// Measured on 2026-11-16: the first run takes the bot about 5.5 minutes of
// play to the end screen (the boss fight about 70 s) with no hit, nice 13 at
// the arena door; the secrets after it about 1.5 minutes more.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./_setup');

const orp = loadScript('orphan-process/script.js');

const T = 16;
const HERO_W = 10;
const HERO_H = 14;
const IDLE = Object.freeze({ left: false, right: false, jump: false, down: false, shoot: false, dash: false });

// The tolerance every jump is played with.
const PRESS_SLACK = 4;
const START_SLACK = 3;

const centre = (sim) => sim.hero.x + HERO_W / 2;
const floorOf = (sim) => Math.round((sim.hero.y + HERO_H) / T);
const dirInput = (d) => (d > 0 ? { right: true } : d < 0 ? { left: true } : {});
const where = (sim) => 'the hero at x ' + (centre(sim) / T).toFixed(2) + ', feet on ' + ((sim.hero.y + HERO_H) / T).toFixed(2) +
  (sim.hero.ground ? ' (standing)' : ' (in the air)');

// The entities of a type with their feet on floor row (any row without
// one), left to right.
function ents(sim, type, row) {
  return sim.ents.filter((e) => e.type === type && (row === undefined || Math.round((e.y + e.h) / T) === row))
    .sort((a, b) => a.x - b.x);
}

// ── Waypoints: init(sim, opts) -> mem, step(sim, mem) -> { input, done, fail } ──

function go(x, options = {}) {
  return {
    kind: 'go', desc: 'go to ' + x,
    step(sim) {
      const d = x * T - centre(sim);
      if (Math.abs(d) > 2) return { input: dirInput(d) };
      if (options.face && sim.hero.face !== options.face) return { input: dirInput(options.face) };
      if (sim.hero.ground && (!options.stop || Math.abs(sim.hero.vx) < 1)) return { done: true };
      return { input: {} };
    }
  };
}

// The jumps of jump() and chain().  opts.pressAt { k: step } presses jump k
// at that step of the waypoint instead of at its take-off point (an early
// press while still in the air from the jump before is kept by the jump
// buffer, as the game does).
function jumps(specs, kind, desc) {
  return {
    kind, desc, specs,
    init(sim, opts) {
      return { k: 0, phase: 'run', n: 0, dir: 0, pressAt: (opts && opts.pressAt) || {}, pressed: [], early: [], held: 0, up: false };
    },
    step(sim, mem) {
      const spec = specs[mem.k];
      const [x0, x1, floor] = spec.to;
      const aim = (spec.aim !== undefined ? spec.aim : (x0 + x1 + 1) / 2) * T;
      const c = centre(sim);
      mem.n += 1;
      const input = {};
      if (mem.phase === 'run') {
        if (!mem.dir) mem.dir = Math.sign(aim - c) || 1;
        Object.assign(input, dirInput(spec.runDir !== undefined ? spec.runDir : mem.dir));
        const forced = mem.pressAt[mem.k];
        const press = forced !== undefined ? mem.n >= forced : spec.when ? spec.when(sim) : (c - spec.at * T) * mem.dir >= 0;
        if (mem.n > 2400) return { fail: 'jump ' + (mem.k + 1) + ' never reached its take-off point' };
        if (!press) return { input };
        mem.pressed[mem.k] = mem.n;
        Object.assign(mem, { dir: 0, phase: 'air', held: 0, up: false });
        input.jump = true;
        return { input };
      }
      mem.held += 1;
      if (!sim.hero.ground) mem.up = true;
      if (sim.hero.vy < 0 || !mem.up) input.jump = true;
      const next = mem.k + 1;
      if (next < specs.length && mem.pressAt[next] !== undefined && mem.n >= mem.pressAt[next]) {
        if (!mem.early[next]) mem.pressed[next] = mem.n;
        mem.early[next] = true;
        input.jump = true;
      }
      if (Math.abs(aim - c) > 3) Object.assign(input, dirInput(aim - c));
      if (mem.up && sim.hero.ground) {
        const left = Math.floor(sim.hero.x / T);
        const right = Math.floor((sim.hero.x + HERO_W - 0.001) / T);
        if (floorOf(sim) !== floor || right < x0 || left > x1) {
          return { fail: 'jump ' + (mem.k + 1) + ' landed on columns ' + left + '-' + right + ' of floor ' + floorOf(sim) + ', not on ' + x0 + '-' + x1 + ' of floor ' + floor };
        }
        mem.k += 1;
        if (mem.k >= specs.length) return { input, done: true };
        Object.assign(mem, mem.early[mem.k] ? { phase: 'air', held: 0, up: false } : { phase: 'run' });
        return { input };
      }
      if (mem.held > 600) return { fail: 'jump ' + (mem.k + 1) + ' never landed' };
      if (!mem.up && mem.held > 14) return { fail: 'jump ' + (mem.k + 1) + ' never left the ground' };
      return { input };
    }
  };
}

function jump(at, to, options = {}) {
  return jumps([Object.assign({ at, to }, options)], 'jump', 'jump at ' + at + ' to columns ' + to[0] + '-' + to[1] + ' of floor ' + to[2]);
}

function chain(list, desc) {
  return jumps(list.map(([at, to]) => ({ at, to })), 'chain', desc);
}

// Runs at the nearest bug ahead on floor row and jumps it once the gap is
// under gap px, landing on to.
function hop(dir, row, to, gap) {
  return jump(dir * 99, to, {
    runDir: dir, aim: dir > 0 ? to[1] + 0.5 : to[0] + 0.5,
    when: (sim) => {
      const ahead = ents(sim, 'bug', row).filter((e) => (e.x - sim.hero.x) * dir > 0);
      const bug = dir > 0 ? ahead[0] : ahead[ahead.length - 1];
      return !!bug && (dir > 0 ? bug.x - (sim.hero.x + HERO_W) : sim.hero.x - (bug.x + bug.w)) < gap;
    }
  });
}

// Holds input (an object or a function of sim and mem) until done(sim).
function hold(input, done, desc, max = 2400) {
  return {
    kind: 'hold', desc,
    init() { return { n: 0 }; },
    step(sim, mem) {
      if (done(sim)) return { done: true };
      mem.n += 1;
      if (mem.n > max) return { fail: 'still waiting after ' + (max / 120).toFixed(0) + ' s' };
      return { input: typeof input === 'function' ? input(sim, mem) : input };
    }
  };
}

const wait = (done, desc, max) => hold({}, done, 'wait: ' + (desc || 'until on the ground'), max);
const grounded = (sim) => sim.hero.ground;

// Walks out through the opening on the right (dir 1) or the left.
function exit(dir) {
  return {
    kind: 'hold', desc: 'leave to the ' + (dir > 0 ? 'right' : 'left'),
    init(sim) { return { n: 0, room: sim.room }; },
    step(sim, mem) {
      if (sim.room !== mem.room) return { done: true };
      mem.n += 1;
      if (mem.n > 1200) return { fail: 'never reached the opening' };
      return { input: dirInput(dir) };
    }
  };
}

// Jumps in place facing dir until done(sim): a target one tile up comes
// into the signal's band near the top of each jump.
function jumpShoot(dir, done, desc) {
  return {
    kind: 'hold', desc,
    init() { return { n: 0, up: false }; },
    step(sim, mem) {
      if (done(sim)) return { done: true };
      mem.n += 1;
      if (mem.n > 2400) return { fail: 'still shooting after 20 s' };
      if (sim.hero.face !== dir) return { input: dirInput(dir) };
      if (sim.hero.ground && !mem.up) {
        mem.up = true;
        return { input: { jump: true } };
      }
      if (mem.up && sim.hero.vy < 0) return { input: { jump: true } };
      mem.up = false;
      return { input: {} };
    }
  };
}

// Down + jump through the one-way platform underfoot, down to a lower floor.
function drop() {
  return {
    kind: 'hold', desc: 'drop through the platform',
    init(sim) { return { n: 0, floor: floorOf(sim) }; },
    step(sim, mem) {
      mem.n += 1;
      if (mem.n > 600) return { fail: 'never got down' };
      if (sim.hero.ground && floorOf(sim) > mem.floor) return { done: true };
      return { input: mem.n <= 2 ? { down: true, jump: mem.n === 2 } : {} };
    }
  };
}

// Runs toward dir, dashes once (nice) and runs on until done(sim).
function dash(dir, done, desc) {
  return {
    kind: 'dash', desc, noDodge: true,
    init() { return { n: 0 }; },
    step(sim, mem) {
      if (done(sim)) return { done: true };
      mem.n += 1;
      if (mem.n > 600) return { fail: 'the dash led nowhere' };
      return { input: Object.assign(dirInput(dir), { dash: mem.n === 3 }) };
    }
  };
}

// The boss: the scripted player of the boss test in orphan-process.test.js.
// At every wind-up it hops onto the nearest platform (above the sweep);
// otherwise it waits on the floor under the corner platform next to the
// boss, out of the way of every file it sees coming, and fires while the
// core is open.
const PERCHES = [[3, 7], [12, 17], [22, 26]];

function bossInput(sim, i, mem) {
  const hero = sim.hero;
  const hx = centre(sim);
  const boss = sim.ents.find((e) => e.type === 'boss');
  const input = {};
  const goTo = (x, slack) => {
    if (hx < x - slack) input.right = true;
    else if (hx > x + slack) input.left = true;
  };
  const up = hero.y + HERO_H <= 13 * T;
  if (boss.state === 'sleep') return { right: true };
  if (['intro', 'windup', 'sweep'].includes(boss.state)) {
    if (up && hero.ground) return {};
    if (mem.jump > 0) {
      mem.jump -= 1;
      input.jump = true;
    }
    const perch = PERCHES.map(([a, b]) => (a + b + 1) * T / 2).sort((a, b) => Math.abs(a - hx) - Math.abs(b - hx))[0];
    goTo(perch, 4);
    if (Math.abs(hx - perch) < 24 && hero.ground && !mem.jump) {
      mem.jump = 30;
      input.jump = true;
    }
    return input;
  }
  mem.jump = 0;
  if (up && hero.ground) return { down: true, jump: i % 2 === 1 };
  const left = boss.x < 15 * T;
  const spot = left ? 5.5 * T : 23.5 * T;
  const sheltered = PERCHES.some(([a, b]) => Math.floor((hx - 5) / T) >= a && Math.floor((hx + 5) / T) <= b);
  const threat = sim.ents.find((e) => e.type === 'file' && Math.abs(e.x + 5 - hx) < 16 && e.y + e.h < hero.y && !sheltered);
  if (threat) return hx > threat.x + 5 ? { right: true } : { left: true };
  goTo(spot, 2);
  if (Math.abs(hx - spot) <= 2) {
    const face = left ? -1 : 1;
    if (hero.face !== face) input[face < 0 ? 'left' : 'right'] = true;
    else if (boss.state === 'core' && i % 2) input.shoot = true;
  }
  return input;
}

function bossFight() {
  return {
    kind: 'boss', desc: 'the fight with tmpfiles.d', noShoot: true, noDodge: true, max: 120 * 300,
    init() { return { n: 0 }; },
    step(sim, mem) {
      if (sim.prog.boss) return { done: true };
      mem.n += 1;
      return { input: bossInput(sim, mem.n, mem) };
    }
  };
}

// ── Playing ──────────────────────────────────────────────────────────────────

// The enemies a signal fired now would meet: in front of the hero, in the
// signal's band, within its range.
function targetAhead(sim) {
  const hero = sim.hero;
  return sim.ents.some((e) => {
    if (!orp.orpKinds[e.type].target || e.type === 'boss') return false;
    const dx = (e.x + e.w / 2 - centre(sim)) * hero.face;
    return e.y < hero.y + 8 && e.y + e.h > hero.y + 4 && dx > 0 && dx < 7.5 * T;
  });
}

// A turret shot coming at the hero within 26 px, at its height.
function shotComing(sim) {
  const hero = sim.hero;
  return sim.ents.some((e) => e.type === 'shot' && e.y < hero.y + HERO_H && e.y + e.h > hero.y &&
    Math.sign(centre(sim) - (e.x + e.w / 2)) === Math.sign(e.vx) && Math.abs(centre(sim) - (e.x + e.w / 2)) < 26);
}

// Plays one waypoint from sim: its input, plus a signal at an enemy ahead
// and, while walking or waiting, a jump over a shot.  Returns { sim, ok,
// why, steps, hurts, mem }.
function playWaypoint(sim, move, opts = {}) {
  const mem = move.init ? move.init(sim, opts) : {};
  let steps = 0;
  let dodge = 0;
  const hurts = [];
  for (;;) {
    const out = move.step(sim, mem);
    if (out.fail) return { sim, ok: false, why: out.fail, steps, hurts, mem };
    if (out.done) return { sim, ok: true, steps, hurts, mem };
    const input = Object.assign({}, IDLE, out.input);
    if (!move.noShoot && sim.prog.abilities.includes('kill') && !sim.last.shoot && targetAhead(sim)) input.shoot = true;
    if (!move.noDodge && (move.kind === 'go' || move.kind === 'hold') && sim.hero.ground && !sim.last.jump && shotComing(sim)) {
      input.jump = true;
      dodge = 30;
    }
    if (dodge > 0) {
      dodge -= 1;
      if (sim.hero.vy < 0) input.jump = true;
    }
    const before = sim;
    sim = orp.orpStep(sim, input);
    steps += 1;
    sim.events.forEach((e) => {
      if (e.type === 'hurt' || e.type === 'death') hurts.push(e.type + ' with ' + where(before));
    });
    if (sim.mode === 'dead') return { sim, ok: false, why: 'the process was killed', steps, hurts, mem };
    if (sim.mode === 'end') return { sim, ok: true, steps, hurts, mem };
    if (steps > (move.max || 7200)) return { sim, ok: false, why: 'stuck for a minute', steps, hurts, mem };
  }
}

// The versions of a jump waypoint a player's hands make (see the header).
function variants(sim, pressed) {
  const out = [];
  pressed.forEach((n, k) => {
    for (const off of [-PRESS_SLACK, PRESS_SLACK]) {
      out.push({ name: 'jump ' + (k + 1) + ' pressed ' + PRESS_SLACK + ' steps ' + (off < 0 ? 'early' : 'late'), sim, opts: { pressAt: { [k]: n + off } } });
    }
  });
  if (pressed.length > 1) {
    for (const off of [-PRESS_SLACK, PRESS_SLACK]) {
      const pressAt = {};
      pressed.forEach((n, k) => { pressAt[k] = n + off; });
      out.push({ name: 'every jump pressed ' + PRESS_SLACK + ' steps ' + (off < 0 ? 'early' : 'late'), sim, opts: { pressAt } });
    }
  }
  for (const dx of [-START_SLACK, START_SLACK]) {
    const moved = JSON.parse(JSON.stringify(sim));
    moved.hero.x += dx;
    out.push({ name: 'the run-up ' + START_SLACK + ' px ' + (dx < 0 ? 'left' : 'right'), sim: moved, opts: {} });
  }
  return out;
}

// Plays the rooms of a part of the route from run.sim, failing with the
// room, the waypoint and the reason; records the play time of each room.
function play(run, rooms) {
  for (const room of rooms) {
    if (room.cont) {
      run.sim = orp.orpNewSim(run.sim.prog);
      continue;
    }
    const title = orp.orpRooms[room.room].title;
    assert.equal(run.sim.room, room.room, 'the route expected ' + title + ' next, the hero is in ' + orp.orpRooms[run.sim.room].title);
    const start = run.sim.prog.time;
    room.moves.forEach((move, i) => {
      const at = title + ', waypoint ' + (i + 1) + ' (' + move.desc + '): ';
      const done = playWaypoint(run.sim, move);
      assert.ok(done.ok, at + done.why + ', ' + where(done.sim));
      assert.deepEqual(done.hurts, [], at + 'the hero was hit');
      if (move.specs) {
        for (const v of variants(run.sim, done.mem.pressed)) {
          const other = playWaypoint(v.sim, move, v.opts);
          assert.ok(other.ok, at + 'fails with ' + v.name + ': ' + other.why + ', ' + where(other.sim));
          assert.deepEqual(other.hurts, [], at + 'the hero is hit with ' + v.name);
        }
      }
      run.sim = done.sim;
      if (run.sim.prog.tty) run.ttys.add(run.sim.prog.tty);
    });
    run.rooms.push([room.room, run.sim.prog.time - start]);
  }
}

// ── The route ────────────────────────────────────────────────────────────────

const crates = (by) => (sim) => !sim.swept && sim.sweep < by;

// /home, before kill and with it, to the gate's switch.
const HOME_ROUTE = [
  { room: 'home', moves: [
    go(11.5),
    jump(14.125, [16, 18, 16]),
    jump(21.0625, [22, 24, 15]),
    go(25),
    jump(27.75, [30, 33, 17]),
    jump(33.875, [37, 38, 17]),
    jump(37.9375, [39, 42, 15]),
    jump(42.4375, [44, 47, 13]),
    jump(44.1875, [39, 42, 11]),
    jump(42.625, [44, 48, 9]),
    jump(44.125, [38, 41, 7]),
    go(39.6),
    jump(44.375, [44, 48, 9]),
    exit(1)
  ] },
  { room: 'config', moves: [
    go(9),
    go(12),
    // No weapon yet: land behind the bug on the block as it nears the far end, then hop it on its way back.
    wait((s) => ents(s, 'bug', 10)[0].face > 0 && ents(s, 'bug', 10)[0].x > 22.5 * T, 'the bug on the block nears its right end'),
    jump(16.9375, [19, 20, 10], { aim: 19.6 }),
    hop(1, 10, [21, 24, 10], 22),
    jump(24.6875, [28, 31, 12]),
    jump(31.9375, [34, 39, 10]),
    jump(33.4375, [35, 37, 8], { aim: 36.4 }),
    go(38.6),
    jump(39.75, [43, 47, 12]),
    go(46),
    wait((s) => ents(s, 'bug', 19).pop().face < 0 && ents(s, 'bug', 19).pop().x < 44 * T, 'the floor bug below walks off to the left'),
    go(50),
    jump(56.125, [58, 58, 18]),
    exit(1)
  ] },
  { room: 'cache', moves: [
    jump(7.5625, [6, 10, 40]),
    jump(10.375, [12, 16, 38]),
    go(13),
    wait((s) => ents(s, 'bug', 36)[0].face > 0 && ents(s, 'bug', 36)[0].x > 21 * T, 'the bug on the block nears its right end'),
    jump(16.375, [18, 19, 36], { aim: 18.6 }),
    hop(1, 36, [21, 22, 36], 18),
    jump(20.375, [24, 28, 34]),
    jump(24.125, [18, 22, 32]),
    jump(18.625, [12, 16, 30]),
    jump(12.625, [6, 10, 28]),
    jump(6.625, [1, 4, 26]),
    go(2.5),
    jump(7.1875, [6, 10, 28]),
    jump(10.4375, [12, 16, 26]),
    jump(16.4375, [18, 22, 24]),
    jump(21.875, [24, 26, 24]),
    exit(1)
  ] },
  { room: 'ssh', moves: [
    jump(8.9375, [12, 16, 15]),
    jump(15.4375, [17, 19, 13]),
    jump(19.9375, [22, 26, 11]),
    go(25.5),
    jump(26.9375, [29, 33, 9]),
    go(31.5),
    wait((s) => ents(s, 'bug', 15).every((b) => b.face < 0 && b.x < 33 * T), 'both floor bugs walk off to the left'),
    go(36.5),
    go(38.4),
    wait((s) => ents(s, 'bug', 15).every((b) => b.face > 0), 'both floor bugs come back'),
    hop(-1, 15, [20, 37, 15], 20),
    hop(-1, 15, [20, 37, 15], 20),
    jump(23.1875, [17, 19, 13]),
    jump(12.125, [1, 8, 15]),
    exit(-1)
  ] },
  { room: 'cache', moves: [
    jump(25.125, [18, 22, 24]),
    go(19),
    wait((s) => ents(s, 'bug', 22)[0].face > 0 && ents(s, 'bug', 22)[0].x < 13.5 * T, 'the bug on the platform turns at its left end'),
    jump(20.6875, [15, 17, 22], { aim: 16.6 }),
    hop(-1, 22, [12, 13, 22], 36),
    jump(14.6875, [6, 10, 20]),
    go(8),
    wait((s) => ents(s, 'bug', 18)[0].face < 0 && ents(s, 'bug', 18)[0].x < 3 * T, 'the bug on the ledge walks to the wall'),
    jump(9.25, [4, 5, 18]),
    jump(6.1875, [6, 10, 16]),
    jump(11.375, [12, 16, 14]),
    jump(17.375, [18, 22, 12]),
    jump(23.375, [25, 31, 10]),
    go(29.5),
    jump(25.0625, [18, 22, 8]),
    jump(23.0625, [25, 31, 6]),
    go(27.5),
    exit(1)
  ] },
  { room: 'docs', moves: [
    go(4.5),
    go(9.5),
    go(14),
    wait((s) => !ents(s, 'bug', 6).length, 'the signal gets the bug on the block'),
    go(19.5),
    go(44, { stop: true }),
    jumpShoot(1, (s) => !ents(s, 'daemon').length, 'jump and shoot the daemon on its block'),
    wait(grounded),
    jump(42.875, [46, 50, 20]),
    exit(1)
  ] },
  { room: 'downloads', moves: [
    go(4.5),
    jump(19.9375, [23, 30, 24]),
    go(31),
    jump(32.4375, [34, 35, 22]),
    jump(38.4375, [36, 45, 24]),
    go(60),
    jump(65, [64, 67, 22]),
    jump(64.625, [59, 62, 20]),
    jump(60.6875, [55, 58, 18]),
    go(12),
    jump(10.125, [4, 7, 16]),
    jump(4.625, [1, 3, 14]),
    go(2.5),
    jump(1.3125, [5, 8, 12]),
    go(7.5),
    go(49.5),
    jump(48.3125, [52, 55, 10]),
    jump(55.4375, [57, 60, 8]),
    go(57.6, { stop: true }),
    wait((s) => ents(s, 'bug', 6).every((b) => b.x > 68 * T), 'the bug on the top ledge walks away from its edge'),
    jump(60.375, [62, 66, 6]),
    go(66.5),
    jump(74.125, [76, 76, 5]),
    exit(1)
  ] },
  { room: 'gate', moves: [
    go(14),
    jump(18.0625, [17, 20, 15]),
    jump(20.4375, [22, 25, 13]),
    jump(22.1875, [17, 20, 11]),
    jump(20.625, [22, 25, 9]),
    jump(25.125, [27, 32, 8]),
    go(32),
    hold((s, m) => ({ shoot: m.n % 2 === 0 }), (s) => s.prog.switches.length > 0, 'shoot the switch', 240),
    go(36),
    exit(1)
  ] }
];

// /tmp, to the arena's door.
const TMP_ROUTE = [
  { room: 'tmp', moves: [
    go(4.5),
    go(8.5),
    go(22),
    wait(crates(14), 'the crates are there for a while'),
    jump(21.375, [25, 25, 16]),
    jump(23.375, [27, 27, 15]),
    jump(25.5, [30, 33, 13]),
    go(44),
    wait(crates(16), 'the crates are there for a while'),
    jump(50.375, [53, 54, 13]),
    exit(1)
  ] },
  { room: 'tmpx', moves: [
    // Over the crumbling floor at a run, then the stones over the spikes without a stop.
    go(23.5),
    chain([
      [24.5625, [26, 27, 15]],
      [27.9375, [30, 31, 13]],
      [31.875, [35, 36, 13]],
      [36.625, [40, 41, 15]],
      [41.875, [45, 48, 17]]
    ], 'the crumbling stones over the spikes'),
    go(47.5),
    jump(58.125, [60, 60, 16]),
    exit(1)
  ] },
  { room: 'x11', moves: [
    go(14.5),
    wait((s) => !s.ents.some((e) => e.type === 'shot' && e.y > 17 * T && e.x < 23 * T) && ents(s, 'turret', 19)[0].cd > 0.8,
      'a turret shot just hit the crate'),
    jump(15.125, [17, 19, 19]),
    wait((s) => !ents(s, 'turret', 19).some((e) => e.x < 30 * T), 'the signals get the floor turret'),
    go(24),
    jump(24.875, [26, 27, 17]),
    wait((s) => !s.ents.some((e) => e.type === 'shot' && e.y > 13 * T && e.y < 15 * T && e.x > 25.5 * T && e.x < 33 * T),
      'a shot of the turret on the block just went by'),
    jump(27.4375, [28, 31, 15]),
    go(39.5),
    go(44),
    jump(44.625, [48, 48, 17]),
    wait((s) => !s.ents.some((e) => e.type === 'shot' && e.y > 17 * T && e.x > 48 * T) && ents(s, 'turret', 19).every((e) => e.cd > 0.8),
      'a shot of the floor turret ahead just hit the crate'),
    go(64.5),
    exit(1)
  ] },
  { room: 'sysd', moves: [
    go(21.5),
    wait((s) => !ents(s, 'daemon').length, 'the signals get the daemon', 1200),
    go(3),
    wait(crates(14), 'the crates are there for a while'),
    jump(3.75, [5, 6, 35]),
    jump(6.6875, [8, 9, 33]),
    jump(9.6875, [11, 12, 31]),
    jump(12.6875, [14, 15, 29]),
    jump(15.875, [17, 20, 27]),
    wait((s) => !ents(s, 'turret', 27).length, 'the signals get the turret on the block', 600),
    go(18),
    wait(crates(14), 'the crates are there for a while'),
    jump(17.25, [14, 15, 25]),
    jump(14.3125, [11, 12, 23]),
    jump(11.3125, [8, 9, 21]),
    jump(8.3125, [5, 6, 19]),
    jump(5.125, [1, 3, 17]),
    go(2.5),
    exit(-1)
  ] },
  { room: 'sess', moves: [
    jump(41.9375, [36, 39, 17]),
    go(19.5),
    wait((s) => !ents(s, 'daemon').length, 'the signals get the daemon', 1200),
    go(28),
    jump(31.4375, [30, 33, 15]),
    go(31.5),
    jump(30.4375, [25, 28, 13]),
    jump(25.125, [19, 22, 11]),
    jump(19.125, [13, 16, 9]),
    jump(13.125, [8, 10, 7]),
    go(3.5),
    go(12),
    go(38),
    jump(38.9375, [41, 42, 17]),
    exit(1)
  ] },
  { room: 'sysd', moves: [
    go(2.5),
    wait(crates(14), 'the crates are there for a while'),
    jump(3.5625, [5, 6, 15]),
    jump(6.875, [8, 9, 13]),
    jump(9.6875, [11, 12, 11]),
    jump(12.6875, [14, 15, 9]),
    jump(15.6875, [17, 20, 7]),
    go(26, { face: 1 }),
    wait((s) => !ents(s, 'turret', 7).length, 'the signals get the turret by the door', 600),
    exit(1)
  ] },
  { room: 'ttyr', moves: [
    go(15.5),
    go(22.5),
    wait(crates(16), 'the crates are there for a while'),
    jump(26.125, [28, 28, 14]),
    jump(29.3125, [30, 30, 13]),
    exit(1)
  ] }
];

const FIGHT_ROUTE = [
  { room: 'arena', moves: [
    bossFight(),
    wait((s) => !s.ents.some((e) => e.type === 'wreck'), 'the wreck stops smoking', 600),
    jump(7.4375, [9, 9, 13]),
    jump(15.375, [12, 17, 13]),
    go(14.5),
    drop(),
    wait((s) => s.mode === 'end', 'the end screen', 600)
  ] }
];

// From tty1 over its crates to the arena's door, and over the arena's
// crates and platforms to its right end.
const TO_ARENA = { room: 'ttyr', moves: [
  wait(crates(16), 'the crates are there for a while'),
  jump(26.125, [28, 28, 14]),
  jump(29.3125, [30, 30, 13]),
  exit(1)
] };
const ACROSS_ARENA = [
  jump(7.4375, [9, 9, 13]),
  jump(15.3125, [12, 17, 13]),
  jump(17.375, [20, 20, 13]),
  jump(25.375, [22, 26, 13])
];

// With nice, continued from the title each time the episode ends.
const NICE_ROUTE = [
  { cont: true },
  TO_ARENA,
  { room: 'arena', moves: ACROSS_ARENA.concat([
    go(25),
    dash(1, (s) => s.mode === 'end', 'dash through the upper cracked wall to the way onward')
  ]) },
  { cont: true },
  TO_ARENA,
  { room: 'arena', moves: ACROSS_ARENA.concat([
    go(27.5),
    dash(1, (s) => s.room === 'bin', 'dash through the lower cracked wall, the shortcut down to .local/bin')
  ]) },
  { room: 'bin', moves: [
    wait(grounded),
    go(30, { face: 1 }),
    dash(1, (s) => s.prog.collected.includes('bin:36,20'), 'dash through the cracked wall to the memory module'),
    go(7),
    jump(6.125, [1, 3, 21]),
    exit(-1)
  ] },
  { room: 'downloads', moves: [
    jump(74.0625, [62, 71, 24]),
    go(56),
    jump(37.5625, [34, 35, 22]),
    wait((s) => ents(s, 'bug', 24).every((b) => b.x > 36 * T || (b.x < 27 * T && b.face < 0)), 'the bug behind the block walks away'),
    jump(29.9375, [27, 31, 24]),
    go(24),
    jump(23.125, [10, 19, 24]),
    go(4.5),
    exit(-1)
  ] },
  { room: 'docs', moves: [
    go(53, { face: -1, stop: true }),
    jumpShoot(-1, (s) => !ents(s, 'daemon').length, 'jump and shoot the daemon on its block'),
    wait(grounded),
    jump(52.0625, [46, 50, 20]),
    go(19),
    // Up the ladder of one-way platforms by the wall.
    jump(17.1875, [15, 17, 20]),
    jump(17.5625, [15, 17, 18]),
    jump(16.125, [15, 17, 16]),
    jump(15.9375, [15, 17, 14]),
    jump(17.625, [15, 17, 12]),
    jump(16.1875, [15, 17, 10]),
    jump(15.9375, [15, 17, 8]),
    jump(17.625, [15, 17, 6]),
    exit(-1)
  ] },
  { room: 'cache', moves: [
    go(23.5),
    go(25.5),
    go(23.5),
    go(4),
    exit(-1)
  ] },
  { room: 'config', moves: [
    jump(60.0625, [50, 57, 19]),
    go(42),
    jump(40.125, [27, 36, 19]),
    go(25),
    jump(24.6875, [22, 23, 17]),
    jump(22.3125, [19, 21, 15]),
    jump(19.25, [17, 19, 13]),
    jump(17.875, [11, 16, 12]),
    jump(12.125, [8, 10, 10]),
    jump(8.875, [1, 7, 9]),
    exit(-1)
  ] },
  { room: 'home', moves: [
    go(38.3),
    jump(37.125, [30, 33, 17]),
    jump(30.625, [25, 27, 17]),
    jump(26.125, [22, 24, 15]),
    go(20.5),
    jump(19.8125, [16, 18, 16]),
    go(11.5),
    go(6, { face: -1 }),
    dash(-1, (s) => s.prog.collected.includes('man:init'), 'dash through the cracked wall to init(1)')
  ] }
];

// ── Tests: the route in order, each part from where the one before ended ────

const run = { sim: orp.orpNewSim(orp.orpFreshProgress()), rooms: [], ttys: new Set(), part: 0 };

// Plays part n of the route (in order: an earlier part that failed leaves
// nothing to play on).
function playPart(n, rooms) {
  assert.equal(run.part, n - 1, 'an earlier part of the route failed');
  play(run, rooms);
  run.part = n;
}

const manOf = (prog) => prog.collected.filter((id) => id.startsWith('man:')).map((id) => id.slice(4)).sort();

test('orphan-process route: /home with the real physics, from the start through .config, .cache and .ssh without a weapon, then kill, Downloads and the gate switch', () => {
  playPart(1, HOME_ROUTE);
  const prog = run.sim.prog;
  assert.equal(run.sim.room, 'tmp');
  assert.deepEqual(prog.abilities, ['kill']);
  assert.deepEqual(prog.switches, ['gate:38,7']);
  assert.deepEqual(manOf(prog), ['chmod', 'fork', 'kill', 'nohup', 'proc', 'ps', 'signal', 'top']);
  assert.deepEqual([...run.ttys], ['home:11,16', 'cache:27,5', 'downloads:4,23']);
});

test('orphan-process route: /tmp with the real physics, the sweep, the crumbling stones, the turret corridor, the crate climbs and sess_, to tty1', () => {
  playPart(2, TMP_ROUTE);
  const prog = run.sim.prog;
  assert.equal(run.sim.room, 'arena');
  assert.deepEqual(manOf(prog), ['chmod', 'fork', 'kill', 'nice', 'nohup', 'proc', 'ps', 'signal', 'tmpfiles', 'top', 'tty']);
  assert.ok(prog.collected.includes('sess:3,6'), 'the memory module of sess_');
  assert.deepEqual([...run.ttys].slice(3), ['tmp:4,16', 'x11:64,18', 'ttyr:22,14']);
  // A thorough first run comes to the boss at nice 13 (the spec: 12-13).
  assert.equal(prog.nice, 13);
});

test('orphan-process route: the boss falls without a hit, nice ends the episode, and the first run takes the bot 4 to 8 minutes of play', () => {
  playPart(3, FIGHT_ROUTE);
  const prog = run.sim.prog;
  assert.equal(run.sim.mode, 'end');
  assert.equal(prog.boss, true);
  assert.deepEqual(prog.abilities, ['kill', 'nice']);
  assert.equal(prog.deaths, 0);
  assert.ok(prog.nice >= 12 && prog.nice <= 13, 'nice ' + prog.nice);
  const fight = run.rooms[run.rooms.length - 1][1];
  assert.ok(fight < 120, 'the fight and the pedestal took ' + fight.toFixed(1) + ' s');
  assert.ok(prog.time > 240 && prog.time < 480, 'the first run took ' + prog.time.toFixed(0) + ' s of play');
});

test('orphan-process route: with nice the way onward ends the episode again, the shortcut leads down to .local/bin, and the way back through /home reaches both secrets: everything is collected', () => {
  playPart(4, NICE_ROUTE);
  const prog = run.sim.prog;
  assert.equal(run.sim.room, 'home');
  assert.deepEqual(prog.walls.sort(), ['arena:29,12', 'arena:29,14', 'bin:33,20', 'home:4,16']);
  assert.equal(manOf(prog).length, 12);
  assert.ok(prog.collected.includes('bin:36,20') && prog.collected.includes('sess:3,6'), 'both memory modules');
  assert.equal(run.ttys.size, orp.orpKnownIds().ttys.length, 'every tty');
  assert.equal(orp.orpCompletion(prog), 100);
  assert.equal(prog.deaths, 0);
});

// ── The way back: the two rooms that are crossed the other way too ──────────

// From /tmp's tty back through the gate (its switch on) and up the ladder by
// its west wall into Downloads; from .X11-unix's tty over the crates, the
// platform east of the middle block and the block back to its west exit.
// The bot has what it has there on a first run: kill, not nice.
const BACK_ROUTE = [
  { room: 'tmp', moves: [
    exit(-1)
  ] },
  { room: 'gate', moves: [
    go(12),
    wait((s) => !ents(s, 'bug').length, 'the signals get both floor bugs', 1200),
    go(12),
    jump(11.0625, [9, 10, 15]),
    jump(9.5, [9, 10, 13]),
    jump(9.5, [9, 10, 11]),
    jump(9.5, [9, 10, 9]),
    jump(9.5, [9, 10, 7]),
    jump(9.5, [1, 8, 6]),
    exit(-1)
  ] }
];

const X11_BACK = [
  { room: 'x11', moves: [
    go(51),
    jump(49.5, [48, 48, 17]),
    // Under the line of fire of the turret on the block: its shots fly over the platform.
    jump(48.25, [42, 45, 16]),
    go(42.5),
    wait((s) => s.ents.some((e) => e.type === 'shot' && e.vx > 0 && e.y > 13 * T && e.y < 15 * T && e.x > 43 * T && e.x < 45 * T),
      'a shot of the turret on the block just went over'),
    jump(42.25, [39, 40, 15], { aim: 40.4 }),
    go(40.4, { face: -1 }),
    wait((s) => !ents(s, 'turret', 15).length, 'the signals get the turret on the block', 600),
    wait(grounded),
    jump(40.75, [41, 44, 13]),
    wait((s) => !ents(s, 'chip').length, 'the chip at 43,12 is picked up', 1),
    go(41.5),
    go(37),
    wait((s) => !ents(s, 'bug', 15).length, 'the signals get the bug on the block', 1200),
    go(26.5),
    wait((s) => ents(s, 'turret', 19)[0].cd > 1.5, 'the floor turret just fired at the step'),
    go(24, { face: -1 }),
    wait((s) => !ents(s, 'turret', 19).length, 'the signals get the floor turret', 600),
    jump(18, [10, 15, 19]),
    exit(-1)
  ] }
];

test('orphan-process route: the way back with kill: from /tmp through the open gate and up the ladder into Downloads, and across .X11-unix from its tty to its west exit', () => {
  const prog = Object.assign(orp.orpFreshProgress(), { abilities: ['kill'], switches: ['gate:38,7'], tty: 'tmp:4,16' });
  const back = { sim: orp.orpNewSim(prog), rooms: [], ttys: new Set() };
  play(back, BACK_ROUTE);
  assert.equal(back.sim.room, 'downloads');
  const x11 = { sim: orp.orpNewSim(Object.assign({}, prog, { tty: 'x11:64,18' })), rooms: [], ttys: new Set() };
  play(x11, X11_BACK);
  assert.equal(x11.sim.room, 'tmpx');
});
