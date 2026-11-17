// tests/packet-siege.sim.test.js
// The simulation core of Packet Siege: the build of script.js from its parts,
// the tables, the 50 levels, every defender and enemy, placing, the economy,
// breakers, surges, the boss tiers, determinism and the difficulty contract
// (a reference bot, an idle player and a fixed weak build play all 50 levels).
// Levels 51-150, their zone rules and boss tiers 6-15 are in
// packet-siege.zones.test.js; their campaign contract (the players below on
// every one of them) in packet-siege.campaign.test.js and
// packet-siege.campaign-late.test.js.  tune.js and those modules read the
// players block below, so it stays plain code between its two markers.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { loadScript, readRepoFile, embedSafety, REPO_ROOT } = require('./_setup');

const GAME = 'packet-siege';
const SCRIPT = GAME + '/script.js';
const JS = readRepoFile(SCRIPT);
const pks = loadScript(SCRIPT);
const BUILD = require(path.join(REPO_ROOT, GAME, 'build.js'));

const C = pks.pksConstants;
const DEF = pks.pksDefender;
const ENEMY = pks.pksEnemy;
const ALL = pks.pksDefenders.map((d) => d.id);
const RATE = 60;

// ── helpers ────────────────────────────────────────────────────────────────

// A hand-made level: five lanes, no trickle, plenty of cycles and one far
// spawn so the sim keeps playing while a test drives it.
function level(over) {
  return Object.assign({
    n: 7, zone: 1, zoneName: 'Test', name: 'Test', lanes: [0, 1, 2, 3, 4], blocked: [], fog: 0,
    trickle: false, startCycles: 100000, slots: 15, speed: 1, boss: 0,
    spawns: [{ t: 9999, lane: 0, type: 'bot' }], surges: [], duration: 600, budget: 1,
    unlock: null, intro: null, hint: null
  }, over);
}

function newSim(over, loadout) {
  return pks.pksNewSim(level(over), loadout || ALL);
}

// Places a defender now, whatever its card's recharge.
function put(sim, type, lane, col) {
  const card = sim.cards.find((c) => c.id === type);
  card.left = 0;
  sim.cycles = Math.max(sim.cycles, card.cost);
  const r = pks.pksPlace(sim, type, lane, col);
  assert.equal(r.ok, true, type + ' on ' + lane + ',' + col + ': ' + r.reason);
  return sim.defenders.find((d) => d.id === r.id);
}

function enemy(sim, type, lane, x) {
  return pks.pksSpawnEnemy(sim, type, lane, x, 0);
}

// Runs n steps; returns every event of them.
function run(sim, n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    pks.pksStep(sim);
    for (const e of sim.events) events.push(e);
  }
  return events;
}

// Steps until done(sim) or max steps; returns the steps taken.
function until(sim, done, max) {
  let i = 0;
  while (!done(sim) && i < max) {
    pks.pksStep(sim);
    i++;
  }
  assert.ok(done(sim), 'condition reached within ' + max + ' steps');
  return i;
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const alive = (sim, id) => sim.enemies.find((e) => e.id === id);
const standing = (sim, id) => sim.defenders.find((d) => d.id === id);

// ── players ──
// The scripted players: a reference bot (a sensible player with a 0.5 s
// reaction time, one action per decision; past level 50 it plays
// decideLate, the late bot below), a novice, a simple build, a fixed weak
// build (PSU and Firewall only, in a fixed order) and an idle player
// (places nothing).  None reads the future: they see the enemies on the
// floor, and the late bot a lane's outage once it is down.
function players(api) {
  const K = api.pksConstants;
  const THINK = 30;
  const ORDER = [2, 1, 3, 0, 4];
  const roster = (n) => new Set(api.pksEnemies.filter((e) => e.first <= n).map((e) => e.id));

  // The cards: all owned when they fit; else the newest and what the
  // enemies met so far call for.
  function loadoutFor(n) {
    const owned = api.pksUnlockedDefenders(n - 1);
    const slots = api.pksSlots(n);
    if (owned.length <= slots) return owned;
    const types = roster(n);
    const prefs = ['psu', 'proxy', 'ids'];
    if (types.has('rootkit')) prefs.push('inspector');
    if (types.has('ransom')) prefs.push('patch');
    prefs.push('nullroute', 'scanner', 'ups', 'tarpit', 'firewall', 'failover', 'quarantine', 'limiter', 'waf', 'honeypot', 'patch', 'inspector');
    const out = [owned[owned.length - 1]];
    for (const id of prefs) if (out.length < slots && !out.includes(id) && owned.includes(id)) out.push(id);
    return out;
  }

  const card = (sim, id) => sim.cards.find((c) => c.id === id);
  const owns = (sim, id) => !!card(sim, id);
  const ready = (sim, id) => {
    const c = card(sim, id);
    return !!c && c.left === 0 && sim.cycles >= c.cost;
  };

  // What the player sees: enemies on the floor, except under the fog, where
  // only the hits of the lane's own shooters show them.
  function analyse(sim) {
    const grid = [];
    for (let l = 0; l < K.LANES; l++) grid.push(new Array(K.COLS).fill(null));
    for (const b of sim.level.blocked) grid[b.lane][b.col] = 'tray';
    // levels 51+: a tunnel exit takes nothing; a hot cell only what lasts
    // there (a wall: see decideLate)
    const R = sim.level.rules;
    const hot = new Set();
    if (R) for (const c of R.tunnels) grid[c.lane][c.col] = 'tray';
    if (R) for (const c of R.hot) hot.add(c.lane * K.COLS + c.col);
    for (const d of sim.defenders) grid[d.lane][d.col] = d;
    const lanes = {};
    for (const l of sim.level.lanes) lanes[l] = { enemies: [], hp: 0, nearest: 99, shooters: 0 };
    for (const d of sim.defenders) if (d.kind === 'shooter' || d.kind === 'beam') lanes[d.lane].shooters++;
    for (const e of sim.enemies) {
      const L = lanes[e.lane];
      if (e.hp <= 0 || e.x > K.FLOOR_END) continue;
      if (sim.level.fog && e.x > K.COLS - sim.level.fog && !(L.shooters > 0 && !e.cloaked)) continue;
      L.enemies.push(e);
      L.hp += e.hp;
      L.nearest = Math.min(L.nearest, e.x);
    }
    return { grid, lanes, hot };
  }

  const free = (A, lane, col) => !!A.lanes[lane] && col >= 0 && col < K.COLS && A.grid[lane][col] === null;

  // The build plan: [kind, col] in order, for every lane.
  function plan(sim, types) {
    const p = [['gen', 0], ['shoot', 2], ['gen', 1]];
    if (types.has('rootkit') && owns(sim, 'inspector')) p.push(['inspector', 5]);
    else if (types.has('ransom') && owns(sim, 'patch')) p.push(['patch', 5]);
    p.push(['wall', 6]);
    if (owns(sim, 'waf') && !types.has('brute')) p.push(['waf', 7]);
    if (owns(sim, 'honeypot')) p.push(['honeypot', 8]);
    p.push(['shoot', 3]);
    if (owns(sim, 'limiter')) p.push(['limiter', 5]);
    p.push(['shoot', 4], ['shoot', 5]);
    if (owns(sim, 'tarpit')) p.push(['shoot', 1]);
    return p;
  }

  function resolve(sim, A, kind, lane, col) {
    if (kind === 'gen') return col === 1 && owns(sim, 'ups') ? 'ups' : 'psu';
    if (kind === 'wall') return 'proxy';
    if (kind !== 'shoot') return kind;
    const has = (t) => A.grid[lane].some((d) => d && d.type === t);
    const shooters = A.lanes[lane].shooters;
    if (owns(sim, 'tarpit') && !has('tarpit') && shooters >= 1) return 'tarpit';
    if (owns(sim, 'scanner') && A.lanes[lane - 1] && A.lanes[lane + 1] && !has('scanner') && shooters >= 1) return 'scanner';
    if (owns(sim, 'ids')) return 'ids';
    if (owns(sim, 'firewall')) return 'firewall';
    return 'tarpit';
  }

  function window3(A, lane, col) {
    let hp = 0;
    let close = false;
    for (const dl of [-1, 0, 1]) {
      const L = A.lanes[lane + dl];
      if (!L) continue;
      for (const e of L.enemies) {
        if (e.x >= col - 0.8 && e.x <= col + 1.8) {
          hp += e.type === 'boss' ? 300 : e.hp;
          if (e.x < 3) close = true;
        }
      }
    }
    return { hp, close };
  }

  function anyFree(A, lane) {
    for (let c = 8; c >= 0; c--) if (free(A, lane, c)) return c;
    return -1;
  }

  // Instants on crowds and emergencies, a patch beside an encrypted
  // defender, a wall in front of what is about to break through.
  function instants(sim, A, lanes) {
    if (ready(sim, 'quarantine')) {
      let close = 0;
      for (const l of lanes) close += A.lanes[l].enemies.filter((e) => e.x < 4 && e.type !== 'zeroday').length;
      if (close >= 3) for (const l of lanes) if (anyFree(A, l) >= 0) return ['quarantine', l, anyFree(A, l)];
    }
    if (ready(sim, 'failover')) {
      let best = null;
      for (const l of lanes) {
        const L = A.lanes[l];
        const hp = L.enemies.reduce((s, e) => s + (e.type === 'boss' ? 300 : Math.min(1800, e.hp)), 0);
        if ((hp >= 1200 || (L.nearest < 3.5 && hp >= 300)) && anyFree(A, l) >= 0 && (!best || hp > best.hp)) best = { l, hp };
      }
      if (best) return ['failover', best.l, anyFree(A, best.l)];
    }
    if (ready(sim, 'nullroute')) {
      let best = null;
      for (const l of lanes) {
        for (let c = 0; c < K.COLS; c++) {
          if (!free(A, l, c)) continue;
          const w = window3(A, l, c);
          if ((w.hp >= 800 || (w.close && w.hp >= 250)) && (!best || w.hp > best.hp)) best = { l, c, hp: w.hp };
        }
      }
      if (best) return ['nullroute', best.l, best.c];
    }
    if (ready(sim, 'patch')) {
      for (const d of sim.defenders) {
        if (d.enc === 0 && d.off === 0) continue;
        if (sim.defenders.some((p) => p.type === 'patch' && Math.abs(p.lane - d.lane) <= 1 && Math.abs(p.col - d.col) <= 1)) continue;
        for (const [dl, dc] of [[0, -1], [-1, 0], [1, 0], [-1, -1], [1, -1]]) {
          if (free(A, d.lane + dl, d.col + dc)) return ['patch', d.lane + dl, d.col + dc];
        }
      }
    }
    if (ready(sim, 'proxy')) {
      for (const l of lanes) {
        const L = A.lanes[l];
        const lead = L.enemies.reduce((m, e) => (!m || e.x < m.x ? e : m), null);
        if (!lead || lead.x > 6.5) continue;
        const col = Math.floor(lead.x - 1.25);
        const walled = A.grid[l].some((d, c) => d && d.type === 'proxy' && c < lead.x && c >= col - 1);
        if (col >= 1 && !walled && free(A, l, col)) return ['proxy', l, col];
      }
    }
    return null;
  }

  // Where a card unlocked by the last level goes when the bot first tries it.
  const TRY = { proxy: 6, honeypot: 8, tarpit: 3, ids: 3, waf: 7, limiter: 5, patch: 5, scanner: 3, ups: 1, inspector: 5 };

  function tryFresh(sim, A, lanes, mem) {
    const id = mem.fresh;
    if (!(id in TRY) || mem.tried || sim.defenders.some((d) => d.type === id)) return null;
    const col = TRY[id];
    for (const l of lanes) {
      if (!free(A, l, col) || col + 1.3 >= A.lanes[l].nearest) continue;
      if (id === 'scanner' && !(A.lanes[l - 1] && A.lanes[l + 1])) continue;
      return ready(sim, id) ? [id, l, col] : 'wait';
    }
    return null;
  }

  function decide(sim, A, mem) {
    const lanes = ORDER.filter((l) => A.lanes[l]);
    const act = instants(sim, A, lanes);
    if (act) return act;
    const fresh = mem.tryFresh && sim.time > 30 ? tryFresh(sim, A, lanes, mem) : null;
    if (fresh === 'wait') return null;
    if (fresh) {
      mem.tried = true;
      return fresh;
    }
    const danger = (l) => {
      const L = A.lanes[l];
      return L.enemies.length ? L.hp / Math.max(1, L.nearest - 1) / (1 + L.shooters) : 0;
    };
    const byDanger = lanes.slice().sort((a, b) => danger(b) - danger(a));
    const steps = plan(sim, mem.types);
    const late = sim.time > sim.level.duration * 0.6;
    const queue = [];
    for (let i = 0; i < steps.length; i++) {
      const col = steps[i][1];
      // late in the level a lost generator's cell takes a shooter instead
      const kind = steps[i][0] === 'gen' && late ? 'shoot' : steps[i][0];
      for (const l of (i === 0 ? lanes : byDanger)) {
        if (!free(A, l, col) || col + 1.3 >= A.lanes[l].nearest) continue;
        const id = resolve(sim, A, kind, l, col);
        if (owns(sim, id)) queue.push([id, l, col, danger(l)]);
      }
    }
    // a shooter for an endangered lane jumps the queue
    const urgent = (q) => (q[3] > 20 && q[0] !== 'psu' && q[0] !== 'ups' ? 1 : 0);
    queue.sort((a, b) => urgent(b) - urgent(a));
    for (const [id, l, col] of queue) {
      if (ready(sim, id)) return [id, l, col];
      if (sim.cycles < card(sim, id).cost) return null;
    }
    return null;
  }

  // A handicap for tuning: keeps only `income` (0..1) of every produce and
  // trickle event's cycles.  Returns a function to call after each step.
  function taxer(income) {
    let debt = 0;
    return (sim) => {
      if (income >= 1) return;
      for (const ev of sim.events) {
        if (ev.type === 'produce' || ev.type === 'trickle') debt += ev.amount * (1 - income);
      }
      const take = Math.min(Math.floor(debt), sim.cycles);
      sim.cycles -= take;
      debt -= take;
    };
  }

  // Enemies that came onto the field this step with their row's HP (a
  // boss: its tier's, or its split's) get k times as much (a Replicator's
  // copy, made from a tougher parent, already has).
  function toughen(sim, k) {
    for (const ev of sim.events) {
      if (ev.type !== 'spawn') continue;
      const e = sim.enemies.find((o) => o.id === ev.id);
      const row = e && e.tier ? api.pksBossTiers[e.tier - 1] : api.pksEnemy[ev.enemy];
      if (e && (e.maxHp === (row.twin ? row.hp / 2 : row.hp) || (e.tier && e.maxHp === row.split))) {
        e.maxHp *= k;
        e.hp *= k;
      }
    }
  }

  // When each breaker tripped (seconds), for the tables.
  const trips = (sim, out) => {
    for (const ev of sim.events) if (ev.type === 'breaker') out.push(Math.round(sim.time));
  };

  // ── the late bot: levels 51-150 ──
  // The same player past level 50 (decideLate; levels 1-50 keep decide, so
  // their pinned results stay): generators first, a block of shooters behind
  // a wall in every lane, Signature DBs among the shooters, instants on
  // crowds, and the expansion's answers: a Canary in front of a Wiper, area
  // damage (Batch Job, Token Ring, Scrubber) where Hives and Replicators
  // come, Decryptors where shields and armour come, shooters out of a
  // Jammer's reach.  Each zone rule is played: no building on a tunnel exit
  // or a hot cell; rails taken first for shooters; walls nearer in the dark
  // and in front of a tunnel exit; a lane that is down gets its help from
  // outside (a Quarantine, a Null Route from the next lane); fewer
  // throw-away cards under upkeep.  It sees what a player sees: enemies on
  // the floor, a shimmer once it shows, an outage once it is announced.
  const LATE_ORDER = ['psu', 'ups', 'ids', 'proxy', 'sigdb', 'tracer', 'nullroute', 'failover', 'quarantine', 'tokenring',
    'decryptor', 'batch', 'canary', 'airgap', 'scrubber', 'backup', 'honeynet', 'loopback', 'sinkhole', 'inspector',
    'limiter', 'patch', 'scanner', 'waf', 'honeypot', 'tarpit', 'firewall'];
  const LATE_CORE = 10;

  // What level n calls for: the roster, its rules and its boss tier.
  function needs(n) {
    const types = roster(n);
    const lv = api.pksLevel(n);
    const tier = lv.boss ? api.pksBossTiers[lv.boss - 1] : null;
    const want = new Set();
    if (types.has('payload') || types.has('titan') || (tier && tier.shield > 0)) want.add('decryptor');
    if (types.has('hive') || types.has('replicator')) want.add('batch').add('scrubber');
    if (types.has('wiper')) want.add('canary');
    return { types, lv, tier, want };
  }

  // The cards of a late level (without `except`, when given: the next card
  // of the order takes its slot).
  function lateLoadout(n, except) {
    const owned = api.pksUnlockedDefenders(n - 1).filter((id) => id !== except);
    const slots = api.pksSlots(n);
    const { want } = needs(n);
    const out = [];
    const take = (id) => { if (out.length < slots && owned.includes(id) && !out.includes(id)) out.push(id); };
    for (const id of LATE_ORDER.slice(0, LATE_CORE)) take(id);
    for (const id of LATE_ORDER) if (want.has(id)) take(id);
    for (const id of LATE_ORDER) take(id);
    return out;
  }

  // The cards of a late level with `id` among them: its own, or, when they
  // leave it out, with it in the last slot.
  function lateLoadoutWith(n, id) {
    const out = lateLoadout(n);
    if (!out.includes(id)) out[out.length - 1] = id;
    return out;
  }

  // The lane plan of a late level: where the wall stands (nearer in the dark
  // and in a tunnel lane) and which columns hold shooters.
  function lanePlan(sim, lane) {
    const R = sim.level.rules;
    const near = !!R.blackout || R.tunnels.some((t) => t.lane === lane);
    const wall = near ? 5 : 6;
    const shoot = [];
    for (let c = 2; c < wall; c++) shoot.push(c);
    return { wall, shoot };
  }

  function railAt(sim, lane, col) {
    return sim.level.rules.rails.some((c) => c.lane === lane && c.col === col);
  }

  // The best shooter for a lane: an IDS first, then one of each kind the
  // level calls for, then IDS again.
  function lateShooter(sim, A, lane, mem) {
    const has = (t) => A.grid[lane].some((d) => d && d.type === t);
    const count = A.grid[lane].filter((d) => d && d !== 'tray' && PKS_SHOOT.has(d.kind)).length;
    if (count === 0 && owns(sim, 'ids')) return 'ids';
    for (const id of ['tracer', 'decryptor', 'tokenring', 'batch', 'loopback']) {
      if (owns(sim, id) && !has(id) && (id !== 'batch' || mem.want.has('batch')) && (id !== 'decryptor' || mem.want.has('decryptor'))) return id;
    }
    return owns(sim, 'ids') ? 'ids' : 'firewall';
  }
  const RICH = 1500;
  const HOT_RICH = 600;
  // A wall card: the Reverse Proxy, or while it recharges the Air Gap, or
  // a Canary (it stops a leap as well).
  const wallCard = (sim) => ['proxy', 'airgap', 'canary'].find((id) => ready(sim, id)) || 'proxy';
  const PKS_SHOOT = new Set(['shooter', 'beam', 'sniper', 'mortar', 'arc', 'decrypt']);

  function lateInstants(sim, A, lanes, mem) {
    const down = sim.outage && sim.outage.state === 'down' ? sim.outage.lane : -1;
    const smalls = lanes.reduce((s, l) => s + A.lanes[l].enemies.filter((e) => e.maxHp <= 200).length, 0);
    if (ready(sim, 'scrubber') && smalls >= 8) {
      for (const l of lanes) if (l !== down && anyFree(A, l) >= 0) return ['scrubber', l, anyFree(A, l)];
    }
    if (ready(sim, 'quarantine')) {
      let close = 0;
      for (const l of lanes) close += A.lanes[l].enemies.filter((e) => e.x < 4 && e.type !== 'zeroday').length;
      if (close >= 3) for (const l of lanes) if (l !== down && anyFree(A, l) >= 0) return ['quarantine', l, anyFree(A, l)];
    }
    if (ready(sim, 'failover')) {
      let best = null;
      for (const l of lanes) {
        if (l === down) continue;
        const L = A.lanes[l];
        const hp = L.enemies.reduce((s, e) => s + (e.type === 'boss' ? 300 : Math.min(1800, e.hp)), 0);
        if ((hp >= 1200 || (L.nearest < 3.5 && hp >= 300)) && anyFree(A, l) >= 0 && (!best || hp > best.hp)) best = { l, hp };
      }
      if (best) return ['failover', best.l, anyFree(A, best.l)];
    }
    if (ready(sim, 'nullroute')) {
      let best = null;
      for (const l of lanes) {
        if (l === down) continue;
        for (let c = 0; c < K.COLS; c++) {
          if (!free(A, l, c)) continue;
          const w = window3(A, l, c);
          if ((w.hp >= 800 || (w.close && w.hp >= 250)) && (!best || w.hp > best.hp)) best = { l, c, hp: w.hp };
        }
      }
      if (best) return ['nullroute', best.l, best.c];
    }
    // a Canary in front of a Wiper, so it wipes 25 cycles, not a wall
    if (ready(sim, 'canary')) {
      for (const l of lanes) {
        const wipers = A.lanes[l].enemies.filter((e) => e.type === 'wiper');
        if (!wipers.length) continue;
        const lead = Math.min(...wipers.map((e) => e.x));
        let front = -1;
        A.grid[l].forEach((d, c) => { if (d && d !== 'tray' && d.kind !== 'floor' && c < lead) front = c; });
        if (front >= 0 && A.grid[l][front].kind === 'decoy') continue;
        for (let c = Math.floor(lead - 1.3); c > front; c--) if (free(A, l, c)) return ['canary', l, c];
      }
    }
    if (ready(sim, 'patch')) {
      for (const d of sim.defenders) {
        if (d.enc === 0 && d.off === 0) continue;
        if (sim.defenders.some((p) => p.type === 'patch' && Math.abs(p.lane - d.lane) <= 1 && Math.abs(p.col - d.col) <= 1)) continue;
        for (const [dl, dc] of [[0, -1], [-1, 0], [1, 0], [-1, -1], [1, -1]]) {
          if (free(A, d.lane + dl, d.col + dc)) return ['patch', d.lane + dl, d.col + dc];
        }
      }
    }
    const wall = wallCard(sim);
    if (ready(sim, wall)) {
      for (const l of lanes) {
        const L = A.lanes[l];
        const lead = L.enemies.reduce((m, e) => (!m || e.x < m.x ? e : m), null);
        if (!lead || lead.x > 6.5) continue;
        const col = Math.floor(lead.x - 1.25);
        const walled = A.grid[l].some((d, c) => d && d !== 'tray' && (d.kind === 'wall' || d.kind === 'decoy') && c < lead.x && c >= col - 1);
        if (col >= 1 && !walled && free(A, l, col)) return [wall, l, col];
      }
      // the boss eats a shooter a second: the defender in its way makes
      // room for a wall
      for (const l of lanes) {
        const heavy = A.lanes[l].enemies.find((e) => e.tier > 0 && e.x < 8);
        if (!heavy) continue;
        const col = Math.floor(heavy.x - 1.25);
        const d = col >= 1 ? A.grid[l][col] : null;
        const walled = A.grid[l].some((o, c) => o && o !== 'tray' && (o.kind === 'wall' || o.kind === 'decoy') && c < heavy.x && c >= col - 1);
        if (d && d !== 'tray' && !walled) return ['remove', l, col];
      }
    }
    return null;
  }

  function decideLate(sim, A, mem) {
    const lanes = ORDER.filter((l) => A.lanes[l]);
    const act = lateInstants(sim, A, lanes, mem);
    if (act) return act;
    const down = sim.outage && sim.outage.state === 'down' ? sim.outage.lane : -1;
    const danger = (l) => {
      const L = A.lanes[l];
      const shooters = l === down ? 0 : L.shooters;
      return L.enemies.length ? L.hp / Math.max(1, L.nearest - 1) / (1 + shooters) : 0;
    };
    const byDanger = lanes.slice().sort((a, b) => danger(b) - danger(a));
    const late = sim.time > sim.level.duration * 0.6;
    const plans = {};
    for (const l of lanes) plans[l] = lanePlan(sim, l);
    // [kind, column of the lane plan] in order
    const steps = [['gen', () => 0], ['shoot', (p) => p.shoot[0]], ['gen', () => 1], ['wall', (p) => p.wall],
      ['boost', () => 3], ['backup', (p) => p.wall - 1], ['pull', () => 4],
      ['shoot', (p) => p.shoot[1]], ['shoot', (p) => p.shoot[2]], ['shoot', (p) => p.shoot[3]],
      ['front', (p) => p.wall + 1], ['shoot', () => 1], ['shoot', () => 0]];
    const queue = [];
    for (let i = 0; i < steps.length; i++) {
      const [kind0, colOf] = steps[i];
      const kind = kind0 === 'gen' && (late || (mem.rich && colOf() === 0)) ? 'shoot' : kind0;
      for (const l of (i === 0 ? lanes : byDanger)) {
        let col = colOf(plans[l]);
        if (col === undefined) continue;
        // a rail in the shooter block is taken first
        if (kind === 'shoot') {
          const rail = plans[l].shoot.find((c) => free(A, l, c) && railAt(sim, l, c));
          if (rail !== undefined) col = rail;
        }
        if (!free(A, l, col) || col + 1.3 >= A.lanes[l].nearest) continue;
        // a hot cell burns 8 HP/s: only a wall (2400 HP) lasts there, and
        // anything else only pays once the bot is rich enough to rebuild it
        if (A.hot.has(l * K.COLS + col) && kind !== 'wall' && kind !== 'front' && sim.cycles < HOT_RICH) continue;
        let id;
        if (kind === 'gen' && col === 1 && mem.rich) id = 'ups';
        else if (kind === 'gen') id = col === 1 && owns(sim, 'ups') ? 'ups' : 'psu';
        else if (kind === 'wall') id = wallCard(sim);
        else if (kind === 'boost' || kind === 'backup') {
          // a Signature DB among the shooters, a Backup behind the walls, in
          // lanes 1 and 3: between them they cover all five lanes
          if (l !== 1 && l !== 3) continue;
          id = kind === 'boost' ? 'sigdb' : 'backup';
        } else if (kind === 'pull') {
          // a Sinkhole beside an express lane pulls its enemies into a slow one
          const R = sim.level.rules;
          if (R.express.includes(l) || !R.express.some((e) => Math.abs(e - l) === 1)) continue;
          id = 'sinkhole';
        } else if (kind === 'front') {
          id = ['honeynet', 'honeypot'].find((t) => owns(sim, t)) || (owns(sim, 'waf') && !mem.types.has('brute') ? 'waf' : wallCard(sim));
        } else id = lateShooter(sim, A, l, mem);
        if (owns(sim, id)) queue.push([id, l, col, danger(l)]);
      }
    }
    const urgent = (q) => (q[3] > 20 && q[0] !== 'psu' && q[0] !== 'ups' ? 1 : 0);
    queue.sort((a, b) => urgent(b) - urgent(a));
    for (const [id, l, col] of queue) {
      if (ready(sim, id)) return [id, l, col];
      if (sim.cycles < card(sim, id).cost) return null;
    }
    // rich with the board full: a generator makes way for a shooter (and
    // from then on a generator's cell takes a shooter)
    if (sim.cycles >= RICH && !queue.length) {
      const gen = sim.defenders.filter((d) => d.type === 'psu').sort((a, b) => danger(b.lane) - danger(a.lane) || a.col - b.col)[0];
      if (gen) {
        mem.rich = true;
        return ['remove', gen.lane, gen.col];
      }
    }
    return null;
  }

  // Level n with the cards unlocked before it and its slot count.  opts:
  // think (steps between decisions, 30 = 0.5 s), income (see taxer),
  // loadout (to play with other cards than loadoutFor's), fresh (place the
  // card the last level unlocked once early, whether needed or not).
  // Past level 50 it plays decideLate with lateLoadout's cards; there opts
  // also take tough (every enemy that walks in or is released has that
  // many times its HP: the margin of tune.js) and level (a level object to
  // play instead of pksLevel(n), for the rule and enemy ablations) and
  // stopAt (the tick from which it does nothing more).
  function playBot(n, opts) {
    const o = Object.assign({ think: THINK, income: 1, tough: 1, stopAt: Infinity }, opts);
    const isLate = n > 50;
    const loadout = o.loadout || (isLate ? lateLoadout(n) : loadoutFor(n));
    const sim = api.pksNewSim(o.level || n, loadout);
    const mem = { fresh: n > 1 ? api.pksLevel(n - 1).unlock : null, tryFresh: !!o.fresh, tried: false, types: roster(n) };
    if (isLate) mem.want = needs(n).want;
    const used = new Set();
    const tax = taxer(o.income);
    const tripped = [];
    while (sim.status === 'playing') {
      if (sim.tick % o.think === 0 && sim.tick < o.stopAt) {
        const act = (isLate ? decideLate : decide)(sim, analyse(sim), mem);
        if (act && act[0] === 'remove') api.pksRemove(sim, act[1], act[2]);
        else if (act && api.pksPlace(sim, act[0], act[1], act[2]).ok) used.add(act[0]);
      }
      api.pksStep(sim);
      tax(sim);
      if (o.tough !== 1) toughen(sim, o.tough);
      trips(sim, tripped);
    }
    return { won: sim.status === 'won', stars: api.pksStars(sim), used, loadout, tripped, sim };
  }

  // The best lane shooter owned (no Scanner: it needs both neighbours).
  const bestShooter = (owned) => ['ids', 'tarpit', 'firewall'].find((id) => owned.includes(id));

  // A simple player: a generator column, a shooter column (the best shooter
  // owned), walls ahead; anything lost is rebuilt; no instants, no reaction
  // to where the enemies are.
  function playSimple(n) {
    const owned = api.pksUnlockedDefenders(n - 1);
    const shooter = bestShooter(owned);
    const loadout = ['psu', shooter].concat(owned.includes('proxy') ? ['proxy'] : []);
    const sim = api.pksNewSim(n, loadout);
    const lanes = ORDER.filter((l) => sim.level.lanes.includes(l));
    const want = [];
    for (const [id, col] of [['psu', 0], [shooter, 1], ['proxy', 6]]) {
      if (loadout.includes(id)) for (const l of lanes) want.push([id, l, col]);
    }
    const tripped = [];
    while (sim.status === 'playing') {
      if (sim.tick % THINK === 0) {
        for (const [id, l, c] of want) {
          const r = api.pksCanPlace(sim, id, l, c);
          if (r.reason === 'occupied' || r.reason === 'blocked') continue;
          if (r.ok) api.pksPlace(sim, id, l, c);
          break;
        }
      }
      api.pksStep(sim);
      trips(sim, tripped);
    }
    return { won: sim.status === 'won', stars: api.pksStars(sim), tripped, sim };
  }

  function weakOrder(lanesInPlay) {
    const lanes = ORDER.filter((l) => lanesInPlay.includes(l));
    const order = [];
    for (const l of lanes) order.push(['psu', l, 0]);
    for (const l of lanes) order.push(['firewall', l, 2]);
    for (const l of lanes) order.push(['psu', l, 1]);
    for (const col of [3, 4, 5]) for (const l of lanes) order.push(['firewall', l, col]);
    return order;
  }

  // A novice: acts at most once every 3 s, never looks ahead.  A PSU or two
  // first; then it reacts only to lanes where an enemy is already visible:
  // a shooter there for every 300 HP in the lane, a wall (or a
  // Honeypot) in front of whatever got close to the rack or to its
  // defenders; more generators while
  // nothing threatens.  No instants.
  const NOVICE = 180;
  function playNovice(n) {
    const owned = api.pksUnlockedDefenders(n - 1);
    const prefs = ['psu', 'firewall', 'ids', 'proxy', 'honeypot', 'tarpit', 'waf', 'limiter', 'ups', 'scanner', 'patch', 'inspector'];
    const loadout = prefs.filter((id) => owned.includes(id)).slice(0, api.pksSlots(n));
    const shooter = owned.includes('ids') ? 'ids' : 'firewall';
    const sim = api.pksNewSim(n, loadout);
    const lanes = ORDER.filter((l) => sim.level.lanes.includes(l));
    const genCols = lanes.length < 3 ? [0, 1] : [0];
    const tripped = [];
    const tryPlace = (id, l, c) => owns(sim, id) && api.pksPlace(sim, id, l, c).ok;
    function act() {
      const A = analyse(sim);
      const gens = sim.defenders.filter((d) => d.kind === 'gen').length;
      const genSpot = () => {
        for (const c of genCols) for (const l of lanes) if (free(A, l, c)) return [l, c];
        return null;
      };
      if (gens < 2) {
        const g = genSpot();
        if (g) return tryPlace('psu', g[0], g[1]);
      }
      const threatened = lanes.filter((l) => A.lanes[l].enemies.length).sort((a, b) => A.lanes[a].nearest - A.lanes[b].nearest);
      for (const l of threatened) {
        const L = A.lanes[l];
        let front = -1;
        A.grid[l].forEach((d, c) => { if (d && d !== 'tray' && d.kind !== 'floor') front = c; });
        if (L.nearest < 4 || L.nearest - front < 3.5) {
          const col = front + 2.2 < L.nearest ? front + 1 : Math.floor(L.nearest - 1.25);
          const walled = A.grid[l].some((d, c) => d && (d.type === 'proxy' || d.type === 'honeypot') && c <= col + 1 && c >= col - 1);
          if (col >= 1 && !walled && free(A, l, col) && (tryPlace('proxy', l, col) || tryPlace('honeypot', l, col))) return true;
        }
        const want = Math.min(6, Math.ceil(L.hp / 300));
        if (L.shooters < want) {
          for (let c = genCols.length; c < K.COLS; c++) {
            if (c + 1.3 >= L.nearest) break;
            if (free(A, l, c)) return tryPlace(shooter, l, c);
          }
        }
      }
      if (threatened.length === 0) {
        const g = genSpot();
        if (g) return tryPlace('psu', g[0], g[1]);
      }
      return false;
    }
    while (sim.status === 'playing') {
      if (sim.tick % NOVICE === 0) act();
      api.pksStep(sim);
      trips(sim, tripped);
    }
    return { won: sim.status === 'won', stars: api.pksStars(sim), tripped, sim };
  }

  // PSU and Firewall only, in a fixed order, each as soon as it can go
  // (order: weakOrder, or another list of [id, lane, col]).
  function playWeak(n, order) {
    const sim = api.pksNewSim(n, ['psu', 'firewall']);
    const plan = order || weakOrder(sim.level.lanes);
    let next = 0;
    const tripped = [];
    while (sim.status === 'playing') {
      if (sim.tick % THINK === 0 && next < plan.length) {
        const [id, l, c] = plan[next];
        const r = api.pksPlace(sim, id, l, c);
        if (r.ok || r.reason === 'blocked' || r.reason === 'lane-closed') next++;
      }
      api.pksStep(sim);
      trips(sim, tripped);
    }
    return { won: sim.status === 'won', stars: api.pksStars(sim), tripped, sim };
  }

  // One PSU and one Firewall per lane, then nothing (the review's
  // no-reaction build).
  function playPsuFw(n) {
    const order = [];
    for (const l of ORDER) order.push(['psu', l, 0], ['firewall', l, 1]);
    return playWeak(n, order);
  }

  function playIdle(n) {
    const sim = api.pksNewSim(n, []);
    while (sim.status === 'playing') api.pksStep(sim);
    return { won: sim.status === 'won', sim };
  }

  return { loadoutFor, lateLoadout, lateLoadoutWith, playBot, playNovice, playSimple, playWeak, playPsuFw, playIdle, taxer };
}
// ── end players ──

// The players play through an api that keeps, for every sim they start, a
// running sha256 of its event stream (what sim.events holds before each step:
// the last step's events and any placing or removing since), for the pin of
// levels 1-50 below.  The sim itself is untouched.
const STREAM = new WeakMap();
const HASHING_API = Object.assign({}, pks, {
  pksNewSim(level, loadout) {
    const sim = pks.pksNewSim(level, loadout);
    STREAM.set(sim, crypto.createHash('sha256'));
    return sim;
  },
  pksStep(sim) {
    const h = STREAM.get(sim);
    if (sim.events.length) h.update(sim.tick + JSON.stringify(sim.events));
    return pks.pksStep(sim);
  }
});
const PLAYERS = players(HASHING_API);
const LEVELS = Array.from({ length: 50 }, (_, i) => i + 1);

// Each player's results over the 50 levels, computed once and shared.
const memo = {};
function results(kind) {
  if (!memo[kind]) {
    const play = {
      bot: (n) => PLAYERS.playBot(n),
      slow: (n) => PLAYERS.playBot(n, { think: 120 }),
      novice: PLAYERS.playNovice,
      simple: PLAYERS.playSimple,
      weak: (n) => PLAYERS.playWeak(n),
      psufw: PLAYERS.playPsuFw,
      idle: PLAYERS.playIdle
    }[kind];
    memo[kind] = LEVELS.map((n) => play(n));
  }
  return memo[kind];
}

// ── build and source ───────────────────────────────────────────────────────

test('packet-siege: script.js is build() of src/ (byte for byte, apart from the checkout\'s line endings) and PARTS is the set of files in src/', () => {
  const built = BUILD.build();
  const disk = fs.readFileSync(path.join(REPO_ROOT, SCRIPT), 'utf8');
  assert.equal(disk.replace(/\r\n/g, '\n'), built, 'run node packet-siege/build.js');
  assert.doesNotMatch(built, /\r/, 'LF only');
  assert.ok(built.endsWith('})();\n'), 'one trailing newline after the IIFE');
  const files = fs.readdirSync(path.join(REPO_ROOT, GAME, 'src')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
  assert.deepEqual([...BUILD.PARTS].sort(), files.sort());
  assert.equal(new Set(BUILD.PARTS).size, BUILD.PARTS.length);
  assert.equal(BUILD.PARTS[0], 'core');
  assert.equal(BUILD.PARTS[BUILD.PARTS.length - 1], 'main');
});

test('packet-siege: build.js --check passes on the repo and fails, writing nothing, on a stale copy', () => {
  const ok = spawnSync(process.execPath, [path.join(REPO_ROOT, GAME, 'build.js'), '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pks-build-'));
  try {
    fs.copyFileSync(path.join(REPO_ROOT, GAME, 'build.js'), path.join(dir, 'build.js'));
    fs.mkdirSync(path.join(dir, 'src'));
    for (const part of BUILD.PARTS) fs.copyFileSync(path.join(REPO_ROOT, GAME, 'src', part + '.js'), path.join(dir, 'src', part + '.js'));
    fs.writeFileSync(path.join(dir, 'script.js'), 'stale\n');
    const stale = spawnSync(process.execPath, [path.join(dir, 'build.js'), '--check'], { encoding: 'utf8' });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /script\.js is stale: run `node packet-siege\/build\.js`/);
    assert.equal(fs.readFileSync(path.join(dir, 'script.js'), 'utf8'), 'stale\n');
    fs.rmSync(path.join(dir, 'script.js'));
    assert.equal(spawnSync(process.execPath, [path.join(dir, 'build.js'), '--check']).status, 1, 'a missing script.js is stale too');
    const write = spawnSync(process.execPath, [path.join(dir, 'build.js')]);
    assert.equal(write.status, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'script.js'), 'utf8'), BUILD.build());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packet-siege: the header says the file is generated and names the parts; every part sits under its banner in PARTS order', () => {
  const lines = JS.split('\n');
  assert.match(lines[0], /^\/\/ Packet Siege — script\.js, GENERATED by packet-siege\/build\.js: do not edit by hand\.$/);
  assert.ok(JS.includes('// Parts, in order: ' + BUILD.PARTS.map((p) => 'src/' + p + '.js').join(', ') + '.'));
  assert.match(JS, /\n\/\/ Prefix: pks-\n\/\/ Dependencies: none\.\n/);
  let at = 0;
  for (const part of BUILD.PARTS) {
    const banner = '\n  // ── src/' + part + '.js ──\n';
    const next = JS.indexOf(banner, at);
    assert.ok(next > at, part + ' banner in order');
    at = next;
  }
});

test('packet-siege: every part is a fragment of the one closure: no IIFE or exports of its own, an opening comment, under 900 lines', () => {
  for (const part of BUILD.PARTS) {
    const text = readRepoFile(GAME + '/src/' + part + '.js');
    assert.match(text, /^\/\/ ── [a-z][a-z-]*: /, part + ' opens with what it owns');
    assert.doesNotMatch(text, /\(function \(\) \{/, part + ' has no IIFE');
    assert.ok(text.split('\n').length < 900, part + ' stays under 900 lines');
    if (part !== 'main') assert.doesNotMatch(text, /module\.exports/, part + ' exports nothing');
    assert.doesNotMatch(text, /'use strict'/, part + ' leaves strict mode to the build');
  }
});

test('packet-siege: script.js is one strict IIFE in ES5 with the start-up guard, embeds safely and has no clock, randomness or DOM in the sim', () => {
  assert.match(JS, /^(\/\/[^\n]*\n)*\n?\(function \(\) \{\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1);
  assert.equal(JS.match(/\(function \(\) \{/g).length, 1, 'no inner IIFE');
  assert.equal(JS.match(/^\}\)\(\);/gm).length, 1);
  assert.match(JS, /if \(typeof module !== 'undefined' && module\.exports\) \{\n\s+module\.exports = \{/);
  const code = JS.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['nullish coalescing', /\?\?/], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['double-quoted string', /"/], ['async', /\basync\b|\bawait\b/],
    ['newer methods', /\.(padStart|padEnd|includes|find|findIndex|flat|flatMap|fill|assign|entries|values|repeat|startsWith|endsWith)\(/],
    ['Object.assign', /Object\.assign/], ['Array.from', /Array\.from/], ['Math.hypot / sign / trunc', /Math\.(hypot|sign|trunc)/],
    ['Math.random', /Math\.random/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
  // Only the page parts (ui-*, and main's start-up) touch the DOM and the
  // frame clock; everything below them stays pure.
  const pure = BUILD.PARTS.filter((part) => !/^ui-/.test(part) && part !== 'main');
  assert.ok(pure.length >= 14 && pure.includes('sim') && pure.includes('storage'));
  for (const part of pure) {
    const src = readRepoFile(GAME + '/src/' + part + '.js').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
    for (const [name, re] of [
      ['clock', /Date\b|performance\.|setTimeout|setInterval|requestAnimationFrame/],
      ['DOM', /\bdocument\b|\bwindow\b|localStorage/]
    ]) {
      assert.doesNotMatch(src, re, part + ': ' + name);
    }
  }
  assert.doesNotMatch(code, /Date\b|performance\.|setTimeout|setInterval/, 'the page runs on animation frames alone');
  assert.deepEqual(embedSafety(JS), []);
});

test('packet-siege: every export, top-level function and top-level variable is pks-named', () => {
  for (const key of Object.keys(pks)) assert.match(key, /^pks[A-Z]/, key);
  const fns = Array.from(JS.matchAll(/^ {2}function (\w+)/gm), (m) => m[1]);
  const vars = Array.from(JS.matchAll(/^ {2}var (\w+)/gm), (m) => m[1]);
  assert.ok(fns.length > 50 && vars.length > 30);
  for (const name of fns) assert.match(name, /^pks[A-Z]/, name);
  for (const name of vars) assert.match(name, /^(PKS_[A-Z0-9_]+|pks[A-Z]\w*)$/, name);
});

// ── tables ─────────────────────────────────────────────────────────────────

test('packet-siege: the constants', () => {
  assert.deepEqual(
    { W: C.W, H: C.H, FIELD_X: C.FIELD_X, FIELD_Y: C.FIELD_Y, CELL: C.CELL, COLS: C.COLS, LANES: C.LANES, RATE: C.RATE, MAX_FRAME: C.MAX_FRAME, SPAWN_X: C.SPAWN_X, SHOT_SPEED: C.SHOT_SPEED, START_CYCLES: C.START_CYCLES, TRICKLE: C.TRICKLE, TRICKLE_EVERY: C.TRICKLE_EVERY, SURGE_WARN: C.SURGE_WARN, LEVELS: C.LEVELS },
    { W: 320, H: 180, FIELD_X: 24, FIELD_Y: 20, CELL: 32, COLS: 9, LANES: 5, RATE: 60, MAX_FRAME: 0.25, SPAWN_X: 9.6, SHOT_SPEED: 6, START_CYCLES: 100, TRICKLE: 25, TRICKLE_EVERY: 10, SURGE_WARN: 3, LEVELS: 150 }
  );
  assert.equal(C.STEP, 1 / 60);
  assert.equal(C.FIELD_X + C.COLS * C.CELL + 8, C.W, 'rack, floor and the 8 px margin fill the width');
  assert.equal(C.FIELD_Y + C.LANES * C.CELL, C.H, 'the strip and the floor fill the height');
  for (const value of Object.values(C)) assert.equal(typeof value, 'number');
});

test('packet-siege: 27 defenders (15, then the expansion\'s 12) with names, one-line descriptions, cost, recharge and the unlock schedule', () => {
  assert.deepEqual(pks.pksDefenders.map((d) => [d.id, d.unlock]), [
    ['psu', 0], ['firewall', 0], ['proxy', 1], ['honeypot', 3], ['tarpit', 5], ['nullroute', 8], ['ids', 10],
    ['waf', 13], ['limiter', 16], ['patch', 20], ['scanner', 24], ['ups', 28], ['inspector', 33], ['failover', 37],
    ['quarantine', 44],
    ['canary', 50], ['tracer', 54], ['batch', 59], ['loopback', 65], ['tokenring', 71], ['sigdb', 77], ['sinkhole', 85],
    ['airgap', 92], ['backup', 100], ['scrubber', 110], ['decryptor', 120], ['honeynet', 132]
  ]);
  const kinds = ['gen', 'shooter', 'wall', 'trap', 'floor', 'pulse', 'healer', 'beam', 'instant',
    'decoy', 'sniper', 'mortar', 'knock', 'arc', 'booster', 'pull', 'backup', 'decrypt'];
  for (const d of pks.pksDefenders) {
    assert.equal(DEF[d.id], d);
    assert.ok(d.name.length > 2 && d.desc.length > 20 && d.desc.length < 90 && !d.desc.includes('\n'), d.id);
    assert.ok(d.cost > 0 && d.recharge > 0 && d.hp > 0, d.id);
    assert.ok(kinds.includes(d.kind), d.id);
  }
  assert.equal(new Set(pks.pksDefenders.map((d) => d.name)).size, 27);
  assert.deepEqual(pks.pksDefenders.map((d) => [d.cost, d.recharge]), [
    [50, 5], [100, 5], [50, 20], [25, 20], [175, 5], [150, 35], [175, 5], [100, 5], [125, 5], [150, 10],
    [325, 5], [150, 10], [300, 10], [125, 40], [75, 45],
    [25, 8], [250, 5], [225, 5], [175, 5], [275, 5], [200, 10], [200, 10], [125, 20], [250, 10], [150, 40],
    [200, 5], [150, 20]
  ]);
  assert.equal(DEF.proxy.hp, 2400);
});

test('packet-siege: 25 enemies (13, then the expansion\'s 12) in order of first appearance, and five boss tiers that each add an ability', () => {
  assert.deepEqual(pks.pksEnemies.map((e) => [e.id, e.first]), [
    ['bot', 1], ['kiddie', 2], ['worm', 4], ['drone', 6], ['trojan', 9], ['exploit', 11], ['phisher', 14],
    ['brute', 17], ['ransom', 21], ['miner', 25], ['rootkit', 31], ['zeroday', 35], ['polymorph', 41],
    ['keylogger', 52], ['logicbomb', 56], ['amplifier', 62], ['wiper', 67], ['hive', 73], ['hydra', 78],
    ['payload', 84], ['jammer', 93], ['replicator', 103], ['dropper', 112], ['titan', 123], ['glitch', 134]
  ]);
  for (const e of pks.pksEnemies) {
    assert.equal(ENEMY[e.id], e);
    assert.ok(e.name.length > 2 && e.desc.length > 20 && e.desc.length < 100, e.id);
    assert.ok(e.hp > 0 && e.speed > 0 && e.threat > 0 && e.bite > 0, e.id);
  }
  const tiers = pks.pksBossTiers;
  assert.deepEqual(tiers.map((t) => [t.tier, t.level]), Array.from({ length: 15 }, (_, i) => [i + 1, 10 * (i + 1)]));
  const abilities = (t) => ['summonEvery', 'laneEvery', 'volleyEvery', 'cloakEvery'].filter((k) => t[k] > 0).length;
  assert.deepEqual(tiers.slice(0, 5).map(abilities), [1, 2, 3, 4, 4]);
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(tiers[i].hp > tiers[i - 1].hp, 'tier ' + (i + 1) + ' has more HP');
    assert.ok(tiers[i].bite >= tiers[i - 1].bite);
  }
  assert.ok(tiers[4].laneEvery < tiers[3].laneEvery && tiers[4].cloakEvery < tiers[3].cloakEvery, 'the last tier is faster');
  for (const t of tiers) {
    assert.ok(t.name && t.desc, 'tier ' + t.tier);
    for (const type of t.summon) assert.ok(ENEMY[type]);
  }
});

test('packet-siege: zones, slots and the unlocked defenders', () => {
  assert.deepEqual(pks.pksZones.map((z) => [z.zone, z.name]), [[1, 'Server closet'], [2, 'DMZ'], [3, 'Hot aisle'], [4, 'Cloud edge'], [5, 'Core'],
    [6, 'Backbone'], [7, 'Storage array'], [8, 'Power plant'], [9, 'VPN tunnel'], [10, 'Dark fiber'], [11, 'Cross-connect'],
    [12, 'Metered cloud'], [13, 'Mainframe'], [14, 'Quantum lab'], [15, 'Root']]);
  assert.deepEqual(Array.from({ length: 150 }, (_, i) => pks.pksSlots(i + 1)).join(''),
    '5'.repeat(10) + '6'.repeat(20) + '7'.repeat(10) + '8'.repeat(30) + '9'.repeat(40) + '10'.repeat(40));
  assert.deepEqual(pks.pksUnlockedDefenders(0), ['psu', 'firewall']);
  assert.deepEqual(pks.pksUnlockedDefenders(1), ['psu', 'firewall', 'proxy']);
  assert.deepEqual(pks.pksUnlockedDefenders(9), ['psu', 'firewall', 'proxy', 'honeypot', 'tarpit', 'nullroute']);
  // winning level 50 also gives the expansion's first defender, the Canary
  assert.deepEqual(pks.pksUnlockedDefenders(49), ALL.slice(0, 15));
  assert.deepEqual(pks.pksUnlockedDefenders(50), ALL.slice(0, 15).concat(['canary']));
  assert.deepEqual(pks.pksUnlockedDefenders(150), ALL);
});

test('packet-siege: pksRand is mulberry32 on a holder', () => {
  const holder = { rng: 7 };
  const reference = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  };
  const ref = reference(7);
  for (let i = 0; i < 100; i++) assert.equal(pks.pksRand(holder), ref());
});

// ── the 50 levels ──────────────────────────────────────────────────────────

test('packet-siege: all 50 levels are plain data of the specified shape', () => {
  const names = new Set();
  for (const n of LEVELS) {
    const lv = pks.pksLevel(n);
    assert.deepEqual(JSON.parse(JSON.stringify(lv)), lv, 'plain data');
    assert.deepEqual(pks.pksLevel(n), lv, 'the same on every call');
    for (const key of ['n', 'zone', 'name', 'lanes', 'blocked', 'fog', 'trickle', 'startCycles', 'slots', 'spawns', 'surges', 'duration', 'unlock', 'intro', 'hint']) {
      assert.ok(key in lv, n + ' ' + key);
    }
    const zone = Math.ceil(n / 10);
    assert.equal(lv.n, n);
    assert.equal(lv.zone, zone);
    assert.equal(lv.zoneName, pks.pksZones[zone - 1].name);
    assert.equal(lv.name, pks.pksLevelRows[n - 1][0]);
    assert.ok(lv.name.length >= 5 && !names.has(lv.name), n + ' name');
    names.add(lv.name);
    assert.deepEqual(lv.lanes, n === 1 ? [2] : n <= 3 ? [1, 2, 3] : [0, 1, 2, 3, 4]);
    assert.equal(lv.slots, pks.pksSlots(n));
    assert.equal(lv.trickle, zone !== 3);
    assert.equal(lv.startCycles, zone === 3 ? C.BROWNOUT_CYCLES : 100);
    assert.ok(C.BROWNOUT_CYCLES > 100);
    assert.equal(lv.speed, zone === 5 ? 1.25 : 1);
    assert.equal(lv.boss, n % 10 === 0 ? n / 10 : 0);
    assert.equal(lv.fog, zone === 4 || (zone === 5 && (n % 2 === 1 || n === 50)) ? 3 : 0);
    const trays = lv.blocked.length;
    if (zone === 2) assert.ok(trays >= 2 && trays <= 5, n + ' trays');
    else if (zone === 5 && n % 2 === 0) assert.ok(trays >= 2, n + ' trays');
    else assert.equal(trays, 0, n + ' no trays');
    const cells = new Set(lv.blocked.map((b) => b.lane + ',' + b.col));
    assert.equal(cells.size, trays, 'distinct trays');
    for (const b of lv.blocked) assert.ok(b.lane >= 0 && b.lane < 5 && b.col >= 1 && b.col < 9);
    assert.equal(lv.surges.length, Math.min(12, 3 + Math.floor((n - 1) / 5)), n + ' surges');
    for (let i = 0; i < lv.surges.length; i++) {
      assert.ok(lv.surges[i] > (i ? lv.surges[i - 1] : 20) && lv.surges[i] < lv.duration, n + ' surge ' + i);
    }
    assert.ok(lv.spawns.length > 0);
    let budget = 0;
    for (let i = 0; i < lv.spawns.length; i++) {
      const s = lv.spawns[i];
      assert.deepEqual(Object.keys(s), ['t', 'lane', 'type']);
      assert.ok(i === 0 || s.t >= lv.spawns[i - 1].t, n + ' spawns sorted');
      assert.ok(s.t >= 20 && s.t < lv.duration, n + ' spawn time ' + s.t);
      assert.ok(lv.lanes.includes(s.lane), n + ' spawn lane');
      if (s.type === 'boss') continue;
      assert.ok(ENEMY[s.type].first <= n, n + ' ' + s.type + ' is introduced by then');
      budget += ENEMY[s.type].threat;
    }
    assert.equal(lv.budget, Math.round(budget * 10) / 10);
    assert.equal(lv.spawns.filter((s) => s.type === 'boss').length, lv.boss ? 1 : 0);
    assert.equal(lv.duration, pks.pksLevelRows[n - 1][2]);
    assert.equal(lv.hint === null, n > 3, n + ' hint');
  }
  for (const n of [1, 2, 3]) assert.ok(pks.pksLevel(n).hint.length > 30);
});

test('packet-siege: levels last 4 minutes at L1 rising to 12 minutes at L50, and unlock and introduce on schedule', () => {
  const durations = LEVELS.map((n) => pks.pksLevel(n).duration);
  assert.equal(durations[0], 240);
  assert.equal(durations[49], 720);
  for (let i = 1; i < 50; i++) assert.ok(durations[i] >= durations[i - 1]);
  for (const n of LEVELS) {
    const lv = pks.pksLevel(n);
    // the frozen level 50 does not name the Canary its win unlocks (see
    // pksLevelUnlock): pksLevel(1..50) stays as it was before the expansion
    const unlock = pks.pksDefenders.find((d) => d.unlock === n && d.id !== 'canary');
    assert.equal(lv.unlock, unlock ? unlock.id : null, n + ' unlock');
    const intro = pks.pksEnemies.find((e) => e.first === n);
    assert.equal(lv.intro, intro ? intro.id : null, n + ' intro');
  }
});

test('packet-siege: a new enemy comes early and alone (three of it, or one pack of drones), and the trickle opens with weak enemies', () => {
  for (const e of pks.pksEnemies.filter((o) => o.first <= C.LEVELS)) {
    const lv = pks.pksLevel(e.first);
    const mine = lv.spawns.filter((s) => s.type === e.id);
    const first = mine.filter((s) => s.t < 200);
    assert.ok(first.length >= (e.id === 'drone' ? 4 : 3), e.id + ' shows in the first minutes of level ' + e.first);
    if (e.id !== 'bot') assert.ok(mine[0].t >= 60, e.id + ' after the opening');
    // the first three (or the pack) have their lane to themselves for 12 s
    // around them, and no other of their kind anywhere near
    // (on level 1 everything is a Bot)
    const intro = e.id === 'bot' ? [] : e.id === 'drone' ? [mine[0]] : mine.slice(0, 3);
    for (const s of intro) {
      const near = lv.spawns.filter((o) => o !== s && Math.abs(o.t - s.t) < 12 && (o.lane === s.lane || o.type === e.id));
      const pack = near.filter((o) => e.id === 'drone' && o.type === 'drone' && o.lane === s.lane);
      assert.equal(near.length, pack.length, e.id + ' alone at ' + s.t + ' on level ' + e.first);
    }
  }
  for (const n of LEVELS) {
    const lv = pks.pksLevel(n);
    assert.ok(ENEMY[lv.spawns[0].type].threat <= 1.5, 'level ' + n + ' opens with a weak enemy');
    assert.ok(lv.spawns[0].t >= 25, 'level ' + n + ': nothing in the first 25 s');
  }
  // a drone pack: 4-6 drones 0.4 s apart in one lane
  const lv = pks.pksLevel(6);
  const drones = lv.spawns.filter((s) => s.type === 'drone');
  const first = drones.filter((s) => s.lane === drones[0].lane && s.t - drones[0].t < 2.5);
  assert.ok(first.length >= 4 && first.length <= 6);
  for (let i = 1; i < first.length; i++) assert.ok(Math.abs(first[i].t - first[i - 1].t - 0.4) < 0.11);
});

// The pressure cap of the level generator, re-derived here from the tables:
// the plausible Firewalls by time t (start, trickle, PSUs: two from 10 s,
// one more every 30 s up to two a lane; the first 100 cycles on PSUs).
function plausibleFirewalls(lv, t) {
  const rate = DEF.psu.amount / DEF.psu.every;
  const most = 2 * lv.lanes.length;
  const full = 10 + 30 * (most - 2);
  const s = Math.max(0, Math.min(t, full) - 10);
  const gen = rate * (2 * s + s * s / 60 + most * Math.max(0, t - full));
  const cycles = lv.startCycles + (lv.trickle ? C.TRICKLE / C.TRICKLE_EVERY * t : 0) + gen;
  return Math.max(0, cycles - 100) / DEF.firewall.cost;
}
const hpOf = (type) => ENEMY[type].hp + (ENEMY[type].spawn ? 2 * ENEMY[ENEMY[type].spawn].hp : 0);

test('packet-siege: zones 1-2 never pile into one lane: within 15 s a lane gets at most what the level\'s economy so far can hold there', () => {
  for (let n = 1; n <= 20; n++) {
    const lv = pks.pksLevel(n);
    const foes = lv.spawns.filter((s) => s.type !== 'boss');
    for (const s of foes) {
      const fw = plausibleFirewalls(lv, s.t);
      const lane = foes.filter((o) => o.lane === s.lane && o.t > s.t - 15 && o.t <= s.t).reduce((a, o) => a + hpOf(o.type), 0);
      const field = foes.filter((o) => o.t > s.t - 15 && o.t <= s.t).reduce((a, o) => a + hpOf(o.type), 0);
      assert.ok(lane <= 400 * Math.max(1, 1.5 * fw / lv.lanes.length) + 1e-6, 'L' + n + ' lane ' + s.lane + ' at ' + s.t + ': ' + lane + ' HP');
      assert.ok(field <= 150 * Math.max(1, fw) + 1e-6, 'L' + n + ' floor at ' + s.t + ': ' + field + ' HP');
    }
  }
  // the owner's case: on L4 no lane ever holds a Worm and two Bots at once
  // within the first two minutes
  const l4 = pks.pksLevel(4).spawns.filter((s) => s.t < 120);
  for (const s of l4) {
    const lane = l4.filter((o) => o.lane === s.lane && Math.abs(o.t - s.t) < 15).reduce((a, o) => a + hpOf(o.type), 0);
    assert.ok(lane < 960, 'L4 lane ' + s.lane + ' at ' + s.t + ': ' + lane + ' HP');
  }
});

test('packet-siege: a level is steady pressure: no idle stretch after the opening, surges grow and the final one is the biggest', () => {
  for (const n of LEVELS) {
    const lv = pks.pksLevel(n);
    const foes = lv.spawns.filter((s) => s.type !== 'boss');
    // after the first minute something is always on its way: never more
    // than 36 s (less than a Bot needs to cross the floor) without a spawn
    for (let i = 1; i < foes.length; i++) {
      if (foes[i - 1].t >= 60) assert.ok(foes[i].t - foes[i - 1].t <= 36, 'L' + n + ': ' + foes[i - 1].t + ' to ' + foes[i].t);
    }
    // what arrives in the 20 s from each surge on
    const k = lv.surges.length;
    const share = lv.surges.map((at) => foes.filter((s) => s.t >= at && s.t < at + 20).reduce((a, s) => a + ENEMY[s.type].threat, 0));
    assert.equal(Math.max(...share), share[k - 1], 'L' + n + ' the final surge is the biggest: ' + share.join(' '));
    assert.ok(share[k - 1] > share[0], 'L' + n);
    const bossAt = lv.spawns.find((s) => s.type === 'boss');
    if (lv.boss) assert.equal(bossAt.t, lv.surges[k - 1], 'L' + n + ' the boss comes with the final surge');
    // the second half of the level carries more than the first
    const half = lv.duration / 2;
    const early = foes.filter((s) => s.t < half).reduce((a, s) => a + ENEMY[s.type].threat, 0);
    assert.ok(lv.budget - early > early, 'L' + n + ' back-loaded');
  }
});

test('packet-siege: enemies weight toward the newer ones and drones never come alone outside a pack', () => {
  // in the second half of a level (the full pool) each of the newest
  // enemies takes a bigger share of the budget than each of the oldest
  let newer = 0;
  let older = 0;
  for (let n = 41; n <= 49; n++) {
    const lv = pks.pksLevel(n);
    for (const s of lv.spawns) {
      if (s.t < lv.surges[lv.surges.length >> 1]) continue;
      if (ENEMY[s.type].first >= 31) newer += ENEMY[s.type].threat;
      if (ENEMY[s.type].first <= 9) older += ENEMY[s.type].threat;
    }
  }
  assert.ok(newer / 3 > older / 5, 'per type: ' + newer / 3 + ' for the three newest, ' + older / 5 + ' for the five oldest');
  for (const n of LEVELS) {
    const spawns = pks.pksLevel(n).spawns;
    for (const s of spawns) {
      if (s.type !== 'drone') continue;
      const pack = spawns.filter((o) => o.type === 'drone' && o.lane === s.lane && Math.abs(o.t - s.t) <= 2.1);
      assert.ok(pack.length >= 4, 'level ' + n + ' drone at ' + s.t);
    }
  }
});

// ── the sim: state ─────────────────────────────────────────────────────────

test('packet-siege: a new sim is plain data with the level, the cards of the loadout and armed breakers on the lanes in play', () => {
  const sim = pks.pksNewSim(2, ['psu', 'firewall', 'nope', 'psu', 'proxy']);
  assert.deepEqual(JSON.parse(JSON.stringify(sim)), sim);
  assert.deepEqual(sim.level, pks.pksLevel(2));
  assert.equal(sim.n, 2);
  assert.equal(sim.status, 'playing');
  assert.equal(sim.cycles, 100);
  assert.deepEqual(sim.cards, [
    { id: 'psu', cost: 50, recharge: 300, left: 0 },
    { id: 'firewall', cost: 100, recharge: 300, left: 0 },
    { id: 'proxy', cost: 50, recharge: 1200, left: 0 }
  ], 'unknown ids and repeats are dropped');
  assert.deepEqual(sim.breakers, ['off', 'armed', 'armed', 'armed', 'off']);
  assert.deepEqual([sim.tick, sim.time, sim.tripped, sim.spawnIndex, sim.stars], [0, 0, 0, 0, 0]);
  assert.deepEqual(sim.stats, { kills: 0, placed: 0, spent: 0, produced: 0 });
  assert.deepEqual([sim.defenders, sim.enemies, sim.shots, sim.events], [[], [], [], []]);
  const custom = level({ lanes: [4] });
  assert.equal(pks.pksNewSim(custom, []).level, custom, 'a level object is used as it is');
});

test('packet-siege: units carry stable ids and the fields a renderer needs', () => {
  const sim = newSim();
  const d = put(sim, 'firewall', 2, 2);
  const e = enemy(sim, 'bot', 2, 8);
  assert.deepEqual(Object.keys(d).sort(), ['anim', 'col', 'enc', 'fire', 'flash', 'healed', 'hp', 'id', 'kind', 'lane', 'maxHp', 'off', 'state', 't', 'type',
    'jammed', 'boosted'].sort());
  assert.deepEqual(Object.keys(e).sort(), ['anim', 'bite', 'cast', 'cloakT', 'cloaked', 'flash', 'frozen', 'from', 'hp', 'id', 'lane', 'leapTo', 'maxHp', 'moveT', 'shift', 'slow', 'speed', 'state', 'summonT', 't', 'tier', 'type', 'used', 'volleyT', 'x',
    'shield', 'maxShield', 'gen', 'aura', 'amped', 'mended', 'hive', 'moveFrom', 'move', 'knocked', 'crossed', 'knocks'].sort());
  let events = run(sim, 1);
  assert.equal(d.state, 'firing');
  events = events.concat(run(sim, 69));
  assert.equal(d.anim, 70);
  assert.equal(e.state, 'walking');
  assert.equal(e.anim, 70);
  const shot = ofType(events, 'shot')[0];
  assert.deepEqual(shot, { type: 'shot', id: shot.id, kind: 'drop', owner: d.id, lane: 2, x: 2.7 });
  const hit = ofType(events, 'hit')[0];
  assert.deepEqual(Object.keys(hit), ['type', 'id', 'shot', 'kind', 'lane', 'x', 'dmg']);
  assert.equal(hit.id, e.id);
  const fresh = newSim();
  put(fresh, 'firewall', 0, 0);
  const target = enemy(fresh, 'bot', 0, 2);
  until(fresh, () => target.hp < 200, 60);
  assert.equal(target.flash, C.FLASH - 1, 'the hit flash, one step in');
  const ids = [d.id, e.id, shot.id];
  assert.equal(new Set(ids).size, 3);
  assert.equal(d.state, 'idle');
  assert.equal(standing(sim, d.id), d, 'the same object keeps its id');
});

// ── defenders ──────────────────────────────────────────────────────────────

test('packet-siege: a PSU makes 25 cycles 6 s after placing and every 10 s after, a UPS 50', () => {
  const sim = newSim({ startCycles: 1000 });
  const psu = put(sim, 'psu', 0, 0);
  const ups = put(sim, 'ups', 1, 0);
  sim.cycles = 0;
  let events = run(sim, 6 * RATE - 1);
  assert.equal(ofType(events, 'produce').length, 0);
  events = run(sim, 1);
  assert.deepEqual(ofType(events, 'produce'), [
    { type: 'produce', id: psu.id, lane: 0, col: 0, amount: 25 },
    { type: 'produce', id: ups.id, lane: 1, col: 0, amount: 50 }
  ]);
  assert.equal(sim.cycles, 75);
  assert.equal(psu.state, 'firing');
  events = run(sim, 10 * RATE);
  assert.equal(ofType(events, 'produce').length, 2);
  assert.equal(sim.cycles, 150);
  assert.equal(sim.stats.produced, 150);
});

test('packet-siege: a Firewall fires every 1.5 s, 20 a hit, only at a visible enemy ahead of it on the floor', () => {
  const sim = newSim();
  const fw = put(sim, 'firewall', 2, 4);
  assert.equal(ofType(run(sim, 120), 'shot').length, 0, 'nothing in its lane');
  const behind = enemy(sim, 'bot', 2, 3);
  behind.frozen = 100000;
  enemy(sim, 'bot', 1, 6).frozen = 100000;
  const off = enemy(sim, 'bot', 2, 9.5);
  assert.equal(ofType(run(sim, 20), 'shot').length, 0, 'not behind it, not in other lanes, not off the floor');
  off.x = 7;
  off.frozen = 100000;
  const events = run(sim, 3 * RATE);
  const shots = ofType(events, 'shot');
  assert.equal(shots.length, 2);
  assert.equal(shots[0].owner, fw.id);
  assert.equal(off.hp, 200 - 40);
  assert.equal(behind.hp, 200);
  assert.deepEqual(ofType(events, 'hit').map((h) => h.dmg), [20, 20]);
});

test('packet-siege: a shot hits the first enemy ahead of where it left and is gone past the right edge', () => {
  const sim = newSim();
  put(sim, 'firewall', 0, 0);
  const near = enemy(sim, 'bot', 0, 6);
  const far = enemy(sim, 'bot', 0, 5);
  near.frozen = far.frozen = 100000;
  run(sim, 60);
  assert.equal(far.hp, 180, 'the nearer one, whatever the order of the list');
  assert.equal(near.hp, 200);
  const sim2 = newSim();
  put(sim2, 'firewall', 0, 0);
  const e = enemy(sim2, 'bot', 0, 8.9);
  run(sim2, 1);
  e.x = 20;
  run(sim2, 120);
  assert.equal(sim2.shots.length, 0, 'the missed shot is gone');
});

test('packet-siege: an IDS fires two shots, a Scanner one into each lane in play next to it', () => {
  const sim = newSim({ lanes: [0, 1, 2] });
  put(sim, 'ids', 2, 0);
  put(sim, 'scanner', 0, 0);
  enemy(sim, 'bot', 2, 6).frozen = 1000;
  enemy(sim, 'bot', 1, 6).frozen = 1000;
  const events = run(sim, 1);
  const shots = ofType(events, 'shot');
  assert.deepEqual(shots.map((s) => [s.lane, Math.round(s.x * 10) / 10]), [[2, 0.7], [2, 0.4], [0, 0.7], [1, 0.7]]);
  const sim2 = newSim({ lanes: [1, 2, 3] });
  put(sim2, 'scanner', 2, 0);
  enemy(sim2, 'bot', 3, 6).frozen = 1000;
  assert.deepEqual(ofType(run(sim2, 1), 'shot').map((s) => s.lane), [1, 2, 3], 'any of its lanes wakes all three');
});

test('packet-siege: a Tarpit hit slows to half speed for 4 s; a Zero-day shrugs it off', () => {
  const sim = newSim();
  put(sim, 'tarpit', 0, 0);
  const bot = enemy(sim, 'bot', 0, 3);
  const events = until(sim, () => bot.slow > 0, 120);
  assert.ok(events > 0);
  assert.equal(bot.slow, 4 * RATE - 1, 'set by the hit, then one step of it gone');
  assert.equal(ofType(sim.events, 'hit')[0].kind, 'tar');
  const x = bot.x;
  run(sim, 60);
  assert.ok(Math.abs(x - bot.x - 0.1) < 1e-9, 'half of 0.2 cells/s');
  const sim2 = newSim();
  put(sim2, 'tarpit', 0, 0);
  const zd = enemy(sim2, 'zeroday', 0, 3);
  run(sim2, 120);
  assert.ok(zd.hp < 700);
  assert.equal(zd.slow, 0);
});

test('packet-siege: a Reverse Proxy is a 2400 HP wall', () => {
  const sim = newSim();
  const wall = put(sim, 'proxy', 0, 3);
  const bot = enemy(sim, 'bot', 0, 3.5 + C.REACH);
  run(sim, 60);
  assert.equal(bot.state, 'biting');
  assert.ok(Math.abs(wall.hp - 2300) < 1e-6);
  assert.equal(bot.x, 3.5 + C.REACH, 'it stopped at the wall');
  const events = run(sim, 23 * RATE);
  assert.deepEqual(ofType(events, 'destroyed'), [{ type: 'destroyed', id: wall.id, def: 'proxy', lane: 0, col: 3, why: 'eaten' }]);
  assert.equal(standing(sim, wall.id), undefined);
});

test('packet-siege: a Honeypot arms after 12 s, then the first touch costs everything in its cell 900, once', () => {
  const sim = newSim();
  const pot = put(sim, 'honeypot', 0, 4);
  assert.equal(pot.state, 'arming');
  let events = run(sim, 12 * RATE - 1);
  assert.equal(ofType(events, 'armed').length, 0);
  events = run(sim, 1);
  assert.deepEqual(ofType(events, 'armed'), [{ type: 'armed', id: pot.id, lane: 0, col: 4 }]);
  assert.equal(pot.state, 'armed');
  const a = enemy(sim, 'worm', 0, 5.2);
  const b = enemy(sim, 'worm', 0, 5.6);
  const far = enemy(sim, 'worm', 0, 7);
  events = run(sim, 1);
  assert.deepEqual(ofType(events, 'blast'), [{ type: 'blast', id: pot.id, def: 'honeypot', lane: 0, col: 4 }]);
  assert.deepEqual([a.hp, b.hp, far.hp], [0, 0, 560]);
  assert.equal(ofType(events, 'destroyed')[0].why, 'spent');
  assert.equal(standing(sim, pot.id), undefined);
  // encrypted while arming, it waits out the 10 s and arms afterwards
  const sim3 = newSim();
  const pot3 = put(sim3, 'honeypot', 1, 4);
  pot3.enc = 1;
  let ev3 = run(sim3, 1);
  assert.equal(ofType(ev3, 'disabled').length, 1);
  assert.equal(pot3.state, 'off');
  ev3 = run(sim3, 10 * RATE);
  assert.equal(pot3.state, 'arming');
  ev3 = run(sim3, 12 * RATE);
  assert.equal(ofType(ev3, 'armed').length, 1);
  assert.equal(pot3.state, 'armed');
  // unarmed, it is just bitten
  const sim2 = newSim();
  const pot2 = put(sim2, 'honeypot', 0, 4);
  enemy(sim2, 'bot', 0, 5.2);
  run(sim2, 60);
  assert.ok(pot2.hp < 300 && pot2.state === 'arming');
});

test('packet-siege: a Null Route goes off 1 s after placing: 1800 to everything in the 3x3, then it is gone', () => {
  const sim = newSim();
  const nr = put(sim, 'nullroute', 2, 4);
  assert.equal(nr.state, 'fuse');
  const inside = [enemy(sim, 'brute', 1, 3.1), enemy(sim, 'brute', 3, 5.9), enemy(sim, 'brute', 2, 4.5)];
  const outside = [enemy(sim, 'brute', 0, 4.5), enemy(sim, 'brute', 2, 6.2), enemy(sim, 'brute', 2, 2.9)];
  for (const e of inside.concat(outside)) e.frozen = 1000;
  let events = run(sim, 59);
  assert.equal(ofType(events, 'blast').length, 0);
  events = run(sim, 1);
  assert.deepEqual(ofType(events, 'blast'), [{ type: 'blast', id: nr.id, def: 'nullroute', lane: 2, col: 4 }]);
  assert.deepEqual(inside.map((e) => e.hp), [0, 0, 0]);
  assert.deepEqual(outside.map((e) => e.hp), [1600, 1600, 1600]);
  assert.equal(standing(sim, nr.id), undefined);
  assert.equal(ofType(events, 'destroyed')[0].why, 'spent');
});

test('packet-siege: a WAF Grate is walked over, burns 20 a second and is never bitten; a Brute Forcer crushes it', () => {
  const sim = newSim();
  const waf = put(sim, 'waf', 0, 4);
  const bot = enemy(sim, 'bot', 0, 5.5);
  run(sim, 60);
  assert.equal(bot.state, 'walking');
  assert.ok(Math.abs(bot.x - 5.3) < 1e-9, 'not stopped');
  run(sim, 5 * RATE);
  assert.ok(bot.x < 4.5);
  assert.equal(waf.hp, 300, 'never bitten');
  const burnt = 200 - bot.hp;
  assert.ok(burnt > 80 && burnt < 120, 'about 20 a second over the cell: ' + burnt);
  const sim2 = newSim();
  const waf2 = put(sim2, 'waf', 0, 4);
  enemy(sim2, 'brute', 0, 5.32);
  const events = run(sim2, 10);
  assert.deepEqual(ofType(events, 'destroyed'), [{ type: 'destroyed', id: waf2.id, def: 'waf', lane: 0, col: 4, why: 'crushed' }]);
});

test('packet-siege: a Rate Limiter pulses 20 into the 3x3 every 1.5 s while something is there', () => {
  const sim = newSim();
  const rl = put(sim, 'limiter', 2, 4);
  assert.equal(ofType(run(sim, 200), 'pulse').length, 0, 'idle while the area is empty');
  const a = enemy(sim, 'bot', 1, 5.8);
  const b = enemy(sim, 'bot', 3, 3.2);
  const c = enemy(sim, 'bot', 2, 6.5);
  a.frozen = b.frozen = c.frozen = 1000;
  const events = run(sim, 90);
  assert.deepEqual(ofType(events, 'pulse'), [{ type: 'pulse', id: rl.id, def: 'limiter', lane: 2, col: 4 }]);
  assert.deepEqual([a.hp, b.hp, c.hp], [180, 180, 200]);
  assert.equal(ofType(run(sim, 1), 'pulse').length, 1, 'again 1.5 s later');
});

test('packet-siege: a Patch Server heals the 3x3 by 40 HP/s, one patch at a time, and clears encryption', () => {
  const sim = newSim();
  const p1 = put(sim, 'patch', 2, 2);
  const p2 = put(sim, 'patch', 2, 4);
  const wall = put(sim, 'proxy', 2, 3);
  const far = put(sim, 'proxy', 2, 6);
  wall.hp = 1000;
  far.hp = 1000;
  run(sim, 60);
  assert.ok(Math.abs(wall.hp - 1040) < 1e-6, 'two patches do not stack');
  assert.equal(far.hp, 1000, 'out of reach');
  assert.equal(p1.hp, 300, 'never above max');
  wall.enc = 30;
  wall.off = 0;
  const events = run(sim, 1);
  assert.deepEqual(ofType(events, 'cleared'), [{ type: 'cleared', id: wall.id, lane: 2, col: 3 }]);
  assert.deepEqual([wall.enc, wall.off], [0, 0]);
  wall.off = 100;
  run(sim, 1);
  assert.equal(wall.off, 0);
  assert.equal(p2.state, 'idle');
});

test('packet-siege: a Packet Inspector beams every enemy in its lane for 40 every 3 s, cloaked or not', () => {
  const sim = newSim();
  const pi = put(sim, 'inspector', 1, 1);
  assert.equal(ofType(run(sim, 30), 'beam').length, 0);
  enemy(sim, 'bot', 1, 9.5).frozen = 1000;
  assert.equal(ofType(run(sim, 30), 'beam').length, 0, 'nothing on the floor yet');
  sim.enemies.length = 0;
  const a = enemy(sim, 'rootkit', 1, 8);
  const b = enemy(sim, 'bot', 1, 0.5);
  const off = enemy(sim, 'bot', 1, 9.4);
  a.frozen = b.frozen = off.frozen = 1000;
  let events = run(sim, 1);
  assert.deepEqual(ofType(events, 'beam'), [{ type: 'beam', id: pi.id, def: 'inspector', lane: 1, col: 1 }]);
  assert.deepEqual([a.hp, b.hp, off.hp], [360, 160, 200]);
  assert.equal(a.cloaked, false, 'the beam uncloaks a Rootkit');
  events = run(sim, 3 * RATE);
  assert.equal(ofType(events, 'beam').length, 1);
});

test('packet-siege: a Failover hits every enemy in its lane for 1800 half a second after placing', () => {
  const sim = newSim();
  const fo = put(sim, 'failover', 3, 0);
  const a = enemy(sim, 'brute', 3, 8.5);
  const b = enemy(sim, 'worm', 3, 2);
  const c = enemy(sim, 'brute', 2, 2);
  const off = enemy(sim, 'bot', 3, 9.5);
  for (const e of [a, b, c, off]) e.frozen = 1000;
  const events = run(sim, 30);
  assert.deepEqual(ofType(events, 'blast'), [{ type: 'blast', id: fo.id, def: 'failover', lane: 3, col: 0 }]);
  assert.deepEqual([a.hp, b.hp, c.hp, off.hp], [0, 0, 1600, 200]);
  assert.equal(standing(sim, fo.id), undefined);
});

test('packet-siege: a Quarantine freezes every enemy on the floor for 5 s; a Zero-day is immune, the boss holds 1 s', () => {
  const sim = newSim();
  const q = put(sim, 'quarantine', 0, 0);
  const bot = enemy(sim, 'bot', 4, 6);
  const zd = enemy(sim, 'zeroday', 3, 6);
  const boss = pks.pksSpawnEnemy(sim, 'boss', 2, 6, 1);
  const off = enemy(sim, 'bot', 1, 9.5);
  const events = run(sim, 30);
  assert.deepEqual(ofType(events, 'freeze'), [{ type: 'freeze', id: q.id, def: 'quarantine', lane: 0, col: 0 }]);
  assert.equal(bot.frozen, 5 * RATE - 1, 'set by the freeze, then one step of it gone');
  assert.equal(bot.state, 'frozen');
  assert.equal(zd.frozen, 0);
  assert.equal(boss.frozen, RATE - 1);
  assert.equal(off.frozen, 0, 'not on the floor yet');
  const x = bot.x;
  const anim = bot.anim;
  run(sim, 5 * RATE - 1);
  assert.equal(bot.x, x);
  assert.equal(bot.anim, anim, 'the animation clock stops too');
  run(sim, 1);
  assert.ok(bot.x < x);
  assert.equal(bot.state, 'walking');
});

test('packet-siege: Decommission removes a defender without a refund', () => {
  const sim = newSim({ startCycles: 500 });
  pks.pksPlace(sim, 'proxy', 1, 1);
  const before = sim.cycles;
  const r = pks.pksRemove(sim, 1, 1);
  assert.deepEqual(r, { ok: true, reason: null, lane: 1, col: 1, id: r.id, def: 'proxy' });
  assert.equal(sim.cycles, before);
  assert.deepEqual(sim.events.slice(-1), [{ type: 'removed', id: r.id, def: 'proxy', lane: 1, col: 1 }]);
  assert.deepEqual(pks.pksRemove(sim, 1, 1), { ok: false, reason: 'empty', lane: 1, col: 1 });
  sim.status = 'lost';
  assert.deepEqual(pks.pksRemove(sim, 1, 1), { ok: false, reason: 'over', lane: 1, col: 1 });
});

// ── enemies ────────────────────────────────────────────────────────────────

test('packet-siege: a Bot walks 0.2 cells/s, stops at a defender and bites 100 HP/s; a Script Kiddie runs 0.42', () => {
  const sim = newSim();
  const bot = enemy(sim, 'bot', 0, 8);
  const kid = enemy(sim, 'kiddie', 1, 8);
  run(sim, 60);
  assert.ok(Math.abs(bot.x - 7.8) < 1e-9);
  assert.ok(Math.abs(kid.x - 7.58) < 1e-9);
  const fw = put(sim, 'firewall', 0, 6);
  fw.t = 100000;
  until(sim, () => bot.state === 'biting', 300);
  assert.ok(Math.abs(bot.x - (6.5 + C.REACH)) < 0.01);
  run(sim, 60);
  assert.ok(Math.abs(fw.hp - 200) < 2);
});

test('packet-siege: a Trojan releases two Bots where it dies', () => {
  const sim = newSim();
  const tr = enemy(sim, 'trojan', 2, 5);
  tr.hp = 10;
  put(sim, 'firewall', 2, 0);
  const events = run(sim, 60);
  const kill = ofType(events, 'kill').find((k) => k.id === tr.id);
  assert.ok(kill);
  const bots = ofType(events, 'spawn').filter((s) => s.enemy === 'bot');
  assert.equal(bots.length, 2);
  assert.ok(Math.abs(bots[0].x - kill.x) < 1e-9 && Math.abs(bots[1].x - (kill.x + 0.4)) < 1e-9);
  assert.deepEqual(bots.map((b) => b.lane), [2, 2]);
  const sim2 = newSim();
  pks.pksSpawnEnemy(sim2, 'boss', 1, 8.5, 1).hp = 1;
  put(sim2, 'nullroute', 1, 8);
  const ev2 = run(sim2, 60);
  assert.equal(ofType(ev2, 'kill').length, 1);
  assert.equal(ofType(ev2, 'spawn').length, 0, 'the boss releases nothing');
});

test('packet-siege: an Exploit runs fast to the first defender, leaps it once and walks on slowly; a Reverse Proxy stops the leap', () => {
  const sim = newSim();
  const ex = enemy(sim, 'exploit', 0, 8);
  run(sim, 60);
  assert.ok(Math.abs(ex.x - 7.6) < 1e-9, '0.4 cells/s');
  const fw = put(sim, 'firewall', 0, 4);
  fw.t = 100000;
  until(sim, () => ex.state === 'leaping', 600);
  assert.deepEqual(ofType(sim.events, 'leap'), [{ type: 'leap', id: ex.id, lane: 0, x: ofType(sim.events, 'leap')[0].x, to: 3.75 }]);
  assert.equal(ex.leapTo, 3.75);
  until(sim, () => ex.state !== 'leaping', 60);
  assert.equal(ex.x, 3.75);
  assert.equal(ex.speed, 0.2);
  assert.equal(fw.hp, 300, 'leapt, not bitten');
  run(sim, 60);
  assert.ok(Math.abs(ex.x - 3.55) < 1e-9);
  const fw2 = put(sim, 'firewall', 0, 2);
  fw2.t = 100000;
  until(sim, () => ex.state === 'biting', 600);
  assert.ok(fw2.hp < 300 || ex.state === 'biting', 'the second defender is bitten');
  // a proxy stops it
  const sim2 = newSim();
  const ex2 = enemy(sim2, 'exploit', 0, 5.3);
  const wall = put(sim2, 'proxy', 0, 4);
  run(sim2, 60);
  assert.equal(ex2.state, 'biting');
  assert.equal(ex2.speed, 0.2);
  assert.ok(wall.hp < 2400);
  // a leap from the first column lands on the rack
  const sim3 = newSim();
  const ex3 = enemy(sim3, 'exploit', 0, 1.3);
  put(sim3, 'psu', 0, 0);
  const ev3 = run(sim3, 60);
  assert.equal(ofType(ev3, 'breaker').length, 1);
  assert.equal(alive(sim3, ex3.id), undefined);
});

test('packet-siege: a Phisher stops 3 cells from the nearest defender in its lane and throws 40 every 2 s; it walks on when the lane is empty', () => {
  const sim = newSim();
  const ph = enemy(sim, 'phisher', 0, 9.5);
  const wall = put(sim, 'proxy', 0, 3);
  const grate = put(sim, 'waf', 0, 5);
  const fw = put(sim, 'firewall', 0, 1);
  fw.t = 100000;
  until(sim, () => ph.state === 'throwing', 30 * RATE);
  assert.ok(Math.abs(ph.x - 6.5) < 0.01, 'stopped 3 cells from the wall, the grate does not count');
  const edge = newSim();
  const ph0 = enemy(edge, 'phisher', 0, 9.5);
  put(edge, 'proxy', 0, 7);
  until(edge, () => ph0.state === 'throwing', 10 * RATE);
  assert.ok(ph0.x <= C.FLOOR_END && ph0.x > C.FLOOR_END - 0.01, 'it stops only once on the floor');
  const events = run(sim, 4 * RATE);
  const shots = ofType(events, 'shot').filter((s) => s.kind === 'phish');
  assert.equal(shots.length, 2);
  assert.equal(shots[0].owner, ph.id);
  const hits = ofType(events, 'hit').filter((h) => h.kind === 'phish');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, wall.id, 'the first defender (not a grate) it reaches');
  assert.equal(wall.hp, 2400 - 40 * hits.length);
  assert.equal(grate.hp, 300);
  pks.pksRemove(sim, 0, 3);
  pks.pksRemove(sim, 0, 5);
  pks.pksRemove(sim, 0, 1);
  run(sim, 2 * RATE);
  assert.equal(ph.state, 'walking');
  assert.equal(sim.shots.length, 0, 'a throw with nothing left to hit flies off the field');
  // a throw that kills
  const sim2 = newSim();
  const ph2 = enemy(sim2, 'phisher', 1, 7);
  const psu = put(sim2, 'psu', 1, 4);
  psu.hp = 30;
  const ev2 = run(sim2, 60);
  assert.deepEqual(ofType(ev2, 'destroyed').map((d) => [d.id, d.why]), [[psu.id, 'shot']]);
  assert.equal(ph2.state, 'walking', 'and walks on');
});

test('packet-siege: a Brute Forcer bites 300 HP/s and crushes a Honeypot, which still goes off', () => {
  const sim = newSim();
  const br = enemy(sim, 'brute', 0, 4.5 + C.REACH);
  const wall = put(sim, 'proxy', 0, 4);
  run(sim, 60);
  assert.ok(Math.abs(wall.hp - 2100) < 1e-6, '300 a second');
  assert.equal(br.state, 'biting');
  const sim2 = newSim();
  const pot = put(sim2, 'honeypot', 0, 4);
  const br2 = enemy(sim2, 'brute', 0, 4.5 + C.REACH);
  const events = run(sim2, 2);
  assert.equal(pot.state, 'arming', 'not even armed');
  assert.equal(ofType(events, 'blast').length, 1);
  assert.equal(br2.hp, 1600 - 900);
  const boss = (() => {
    const s3 = newSim();
    put(s3, 'honeypot', 0, 4);
    const b = pks.pksSpawnEnemy(s3, 'boss', 0, 5.2, 1);
    run(s3, 1);
    return b;
  })();
  assert.equal(boss.hp, 2400 - C.BOSS_CAP, 'the boss crushes it too and takes capped damage');
});

test('packet-siege: Ransomware encrypts the first defender it touches: 2 s, then 10 s off; after that it bites', () => {
  const sim = newSim();
  const fw = put(sim, 'firewall', 0, 3);
  const rw = enemy(sim, 'ransom', 0, 3.5 + C.REACH);
  rw.hp = 100000;
  let events = run(sim, 1);
  assert.deepEqual(ofType(events, 'encrypt'), [{ type: 'encrypt', id: fw.id, by: rw.id, lane: 0, col: 3 }]);
  assert.equal(rw.state, 'casting');
  run(sim, 1);
  assert.equal(fw.state, 'encrypting');
  events = run(sim, 2 * RATE - 1);
  assert.deepEqual(ofType(events, 'disabled'), [{ type: 'disabled', id: fw.id, lane: 0, col: 3 }]);
  assert.equal(fw.state, 'off');
  assert.equal(fw.hp, 300, 'not bitten while it casts');
  events = run(sim, 60);
  assert.equal(rw.state, 'biting');
  assert.ok(fw.hp < 300);
  assert.equal(ofType(events, 'shot').length, 0, 'an encrypted Firewall does not fire');
  assert.equal(rw.used, true);
  // a defender that is already encrypted or off is just bitten
  const sim2 = newSim();
  const wall = put(sim2, 'proxy', 0, 3);
  wall.off = 600;
  const rw2 = enemy(sim2, 'ransom', 0, 3.5 + C.REACH);
  run(sim2, 2);
  assert.equal(rw2.state, 'biting');
  assert.equal(rw2.used, false);
});

test('packet-siege: a Cryptominer drains 2 cycles a second while on the floor, never below 0', () => {
  const sim = newSim({ startCycles: 10 });
  const m = enemy(sim, 'miner', 0, 9.5);
  m.frozen = 0;
  run(sim, 30);
  assert.equal(sim.cycles, 10, 'nothing before it is on the floor');
  m.x = 8;
  run(sim, 60);
  assert.equal(sim.cycles, 8);
  run(sim, 5 * RATE);
  assert.equal(sim.cycles, 0);
});

test('packet-siege: a Rootkit is cloaked from lane shots until an area effect hurts it or it passes x = 4.5', () => {
  const sim = newSim();
  put(sim, 'firewall', 0, 0);
  const rk = enemy(sim, 'rootkit', 0, 7);
  assert.equal(rk.cloaked, true);
  run(sim, 5 * RATE);
  assert.equal(rk.hp, 400, 'shots pass through');
  assert.equal(sim.shots.length, 0, 'and none are fired at it');
  until(sim, () => !rk.cloaked, 30 * RATE);
  const uncloak = ofType(sim.events, 'cloak');
  assert.deepEqual(uncloak, [{ type: 'cloak', id: rk.id, lane: 0, x: uncloak[0].x, on: false }]);
  assert.ok(uncloak[0].x <= C.UNCLOAK_X && uncloak[0].x > C.UNCLOAK_X - 0.01);
  run(sim, 3 * RATE);
  assert.ok(rk.hp < 400);
  const sim2 = newSim();
  const rk2 = enemy(sim2, 'rootkit', 0, 7);
  rk2.frozen = 1000;
  put(sim2, 'limiter', 0, 6);
  run(sim2, 1);
  assert.equal(rk2.cloaked, false, 'a pulse uncloaks it');
});

test('packet-siege: a Polymorph at half HP moves to a neighbour lane once and regains half of what it lost', () => {
  const sim = newSim();
  const pm = enemy(sim, 'polymorph', 2, 6);
  pm.frozen = 1000;
  put(sim, 'nullroute', 2, 5);
  sim.cards.find((c) => c.id === 'nullroute').left = 0;
  pm.hp = 1900;
  const events = run(sim, 60);
  const morph = ofType(events, 'morph');
  assert.equal(morph.length, 1);
  assert.equal(morph[0].from, 2);
  assert.ok([1, 3].includes(pm.lane));
  assert.equal(pm.from, 2);
  assert.ok(pm.shift > 0);
  assert.equal(pm.hp, 100 + (600 - 100) / 2);
  assert.equal(pm.used, true);
  pm.hp = 100;
  const sim2 = newSim();
  const pm2 = enemy(sim2, 'polymorph', 0, 6);
  pm2.frozen = 1000;
  const fw = put(sim2, 'limiter', 0, 5);
  pm2.hp = 310;
  run(sim2, 1);
  assert.equal(pm2.lane, 1, 'from the edge lane the only neighbour');
  assert.equal(fw.lane, 0);
  const sim3 = newSim({ lanes: [3, 4] });
  const pm3 = enemy(sim3, 'polymorph', 4, 6);
  pm3.frozen = 1000;
  put(sim3, 'limiter', 4, 5);
  pm3.hp = 310;
  run(sim3, 1);
  assert.equal(pm3.lane, 3, 'the other edge');
  const sim4 = newSim({ lanes: [2] });
  const pm4 = enemy(sim4, 'polymorph', 2, 6);
  pm4.frozen = 1000;
  put(sim4, 'limiter', 2, 5);
  pm4.hp = 310;
  const ev4 = run(sim4, 1);
  assert.equal(pm4.lane, 2, 'no lane next to it is in play');
  assert.equal(ofType(ev4, 'morph')[0].lane, 2);
  assert.equal(pm4.hp, 290 + 310 / 2);
});

test('packet-siege: the boss tiers: summons, lane changes, volleys, cloak phases', () => {
  const tiers = pks.pksBossTiers.slice(0, 5);
  for (const t of tiers) {
    const sim = newSim();
    const boss = pks.pksSpawnEnemy(sim, 'boss', 2, 8, t.tier);
    assert.equal(boss.hp, t.hp);
    assert.equal(boss.tier, t.tier);
    boss.frozen = 0;
    const events = [];
    for (let i = 0; i < 40 * RATE; i++) {
      pks.pksStep(sim);
      events.push(...sim.events);
      boss.x = 8;
      boss.hp = t.hp;
    }
    const summons = ofType(events, 'summon').length;
    assert.equal(summons, Math.floor(40 / t.summonEvery), 'tier ' + t.tier + ' summons');
    const spawned = ofType(events, 'spawn').map((s) => s.enemy);
    assert.equal(spawned.length, summons * t.summon.length);
    const moves = ofType(events, 'morph').length;
    assert.equal(moves, t.laneEvery ? Math.floor(40 / t.laneEvery) : 0, 'tier ' + t.tier + ' lane changes');
    const volleys = ofType(events, 'shot').filter((s) => s.kind === 'volley');
    assert.ok(t.volleyEvery ? volleys.length >= 2 * Math.floor(40 / t.volleyEvery) : volleys.length === 0, 'tier ' + t.tier + ' volleys');
    const cloaks = ofType(events, 'cloak');
    if (t.cloakEvery) {
      assert.equal(cloaks[0].on, true);
      assert.equal(cloaks[1].on, false);
      assert.ok(Math.abs(cloaks.length - Math.floor(40 / (t.cloakEvery + t.cloakFor)) * 2) <= 1);
    } else {
      assert.equal(cloaks.length, 0);
    }
  }
});

test('packet-siege: the boss takes capped damage from instants; a breaker only throws it back and hurts it', () => {
  const sim = newSim();
  const boss = pks.pksSpawnEnemy(sim, 'boss', 2, 5, 3);
  boss.frozen = 100;
  put(sim, 'nullroute', 2, 4);
  put(sim, 'failover', 1, 0);
  run(sim, 60);
  assert.equal(boss.hp, 4800 - C.BOSS_CAP);
  boss.frozen = 0;
  boss.x = 0.001;
  const bot = enemy(sim, 'bot', 2, 3);
  const events = run(sim, 1);
  assert.deepEqual(ofType(events, 'breaker'), [{ type: 'breaker', lane: 2 }]);
  assert.equal(boss.x, C.BOSS_PUSH);
  assert.equal(boss.hp, 4800 - C.BOSS_CAP - 4800 * C.BOSS_BREAKER);
  assert.equal(alive(sim, bot.id), undefined, 'everything else in the lane is wiped');
  assert.equal(sim.status, 'playing');
  boss.x = 0.001;
  const lose = run(sim, 1);
  assert.deepEqual(ofType(lose, 'lose'), [{ type: 'lose', lane: 2, id: boss.id, enemy: 'boss' }]);
  assert.equal(sim.status, 'lost');
});

test('packet-siege: a boss volley hits the first defender it reaches in each of three lanes', () => {
  const sim = newSim();
  const boss = pks.pksSpawnEnemy(sim, 'boss', 0, 8, 3);
  boss.volleyT = 1;
  boss.summonT = boss.moveT = 100000;
  boss.frozen = 0;
  const a = put(sim, 'proxy', 0, 3);
  const b = put(sim, 'proxy', 1, 5);
  const first = run(sim, 1);
  assert.equal(ofType(first, 'shot').filter((s) => s.kind === 'volley').length, 2, 'the volley leaves on the first step');
  assert.equal(boss.cast, Math.round(0.6 * RATE), 'and the boss shows its casting frame');
  const events = first.concat(run(sim, 2 * RATE));
  const shots = ofType(events, 'shot').filter((s) => s.kind === 'volley');
  assert.deepEqual(shots.map((s) => s.lane), [0, 1], 'only the lanes in play');
  assert.equal(a.hp, 2400 - 60);
  assert.equal(b.hp, 2400 - 60);
  assert.equal(boss.cast, 0, 'the casting frame is over');
});

test('packet-siege: an enemy off the floor bites nothing: it walks onto the floor first, where a shooter in column 8 hits it', () => {
  const sim = newSim();
  const fw = put(sim, 'firewall', 2, 8);
  const bot = enemy(sim, 'bot', 2, C.SPAWN_X);
  until(sim, () => bot.state === 'biting', 10 * RATE);
  assert.ok(bot.x <= C.FLOOR_END, 'it stops on the floor, not at ' + bot.x);
  run(sim, 3 * RATE);
  assert.ok(bot.hp < 200, 'the Firewall in column 8 fires at it');
  assert.ok(fw.hp < 300);
});

test('packet-siege: a breaker never pulls the boss toward the rack: a boss further right stays where it is', () => {
  const sim = newSim();
  const boss = pks.pksSpawnEnemy(sim, 'boss', 2, 6, 1);
  boss.frozen = 100;
  enemy(sim, 'bot', 2, 0.001);
  const events = run(sim, 1);
  assert.deepEqual(ofType(events, 'breaker'), [{ type: 'breaker', lane: 2 }]);
  assert.equal(boss.x, 6);
  assert.equal(boss.hp, 2400 - 2400 * C.BOSS_BREAKER, 'it is still hurt');
});

test('packet-siege: a Rootkit that starts biting shows itself, so a lane shooter can finish it however far right it bites', () => {
  const sim = newSim();
  put(sim, 'ids', 0, 0);
  const wall = put(sim, 'proxy', 0, 7);
  const rk = enemy(sim, 'rootkit', 0, 8.3);
  until(sim, () => rk.state === 'biting', 10 * RATE);
  assert.equal(rk.cloaked, false);
  assert.ok(rk.x > C.UNCLOAK_X);
  until(sim, () => !alive(sim, rk.id), 60 * RATE);
  assert.ok(wall.hp > 0, 'killed while it bit the wall');
  assert.match(ENEMY.rootkit.desc, /until it bites/);
});

test('packet-siege: build.js --check passes on a fresh build checked out with CRLF line endings (core.autocrlf=true)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pks-crlf-'));
  try {
    fs.copyFileSync(path.join(REPO_ROOT, GAME, 'build.js'), path.join(dir, 'build.js'));
    fs.mkdirSync(path.join(dir, 'src'));
    for (const part of BUILD.PARTS) fs.copyFileSync(path.join(REPO_ROOT, GAME, 'src', part + '.js'), path.join(dir, 'src', part + '.js'));
    fs.writeFileSync(path.join(dir, 'script.js'), BUILD.build().replace(/\n/g, '\r\n'));
    const r = spawnSync(process.execPath, [path.join(dir, 'build.js'), '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packet-siege: every number in a description, a hint or a zone line is the table\'s own', () => {
  const numbers = (text) => (text.replace(/3x3/g, '').match(/\d+(\.\d+)?/g) || []).map(Number);
  const values = (row) => {
    const out = new Set();
    for (const v of Object.values(row)) if (typeof v === 'number') out.add(v);
    return out;
  };
  // numbers a row borrows from the shared constants
  const borrowed = { ransom: [C.RANSOM_OFF, C.RANSOM_CAST] };
  for (const rows of [pks.pksDefenders, pks.pksEnemies, pks.pksBossTiers]) {
    for (const row of rows) {
      const own = values(row);
      for (const x of borrowed[row.id] || []) own.add(x);
      for (const x of numbers(row.desc)) assert.ok(own.has(x), (row.id || 'tier ' + row.tier) + ': ' + x + ' in "' + row.desc + '"');
    }
  }
  // the words: two shots, three times the bite, packs of four to six, twice the pace
  assert.equal(DEF.ids.shots, 2);
  assert.match(DEF.ids.desc, /two shots/);
  assert.equal(ENEMY.brute.bite, 3 * ENEMY.bot.bite);
  assert.match(ENEMY.brute.desc, /three times as hard/);
  assert.equal(ENEMY.drone.pack, 4);
  assert.match(ENEMY.drone.desc, /packs of four to six/);
  assert.ok(Math.abs(ENEMY.kiddie.speed / ENEMY.bot.speed - 2) < 0.15);
  // an instant says its fuse
  for (const id of ['nullroute', 'failover', 'quarantine']) assert.match(DEF[id].desc, new RegExp('^After a ' + DEF[id].fuse + ' s fuse'), id);
  // zone 5's speed-up is the enemies' and its number is the level's
  const z5 = pks.pksZones[4].desc;
  assert.match(z5, /^Enemies move \d+ % faster/);
  assert.equal(Number(z5.match(/(\d+) %/)[1]), Math.round((pks.pksLevel(41).speed - 1) * 100));
  for (const n of [1, 2, 3]) assert.deepEqual(numbers(pks.pksLevel(n).hint), [], 'hint ' + n + ' states no numbers that could go stale');
});

// ── placing ────────────────────────────────────────────────────────────────

test('packet-siege: pksCanPlace explains every refusal with the values a UI needs', () => {
  const sim = pks.pksNewSim(level({ lanes: [1, 2, 3], blocked: [{ lane: 2, col: 5 }], startCycles: 120 }), ['psu', 'firewall', 'proxy']);
  const base = { ok: false, card: 'firewall' };
  assert.deepEqual(pks.pksCanPlace(sim, 'firewall', 2, 2), { ok: true, reason: null, card: 'firewall', lane: 2, col: 2, cost: 100, cycles: 120 });
  assert.deepEqual(pks.pksCanPlace(sim, 'ids', 2, 2), { ok: false, reason: 'no-card', card: 'ids', lane: 2, col: 2 });
  assert.deepEqual(pks.pksCanPlace(sim, 'firewall', 0, 2), Object.assign({}, base, { reason: 'lane-closed', lane: 0, col: 2, lanes: [1, 2, 3], cost: 100, cycles: 120 }));
  assert.deepEqual(pks.pksCanPlace(sim, 'firewall', 2, 5), Object.assign({}, base, { reason: 'blocked', lane: 2, col: 5, cost: 100, cycles: 120 }));
  for (const [lane, col] of [[-1, 0], [5, 0], [1, -1], [1, 9], [1.5, 2], [1, 2.5], [undefined, 2], ['1', 2], [1, NaN]]) {
    assert.equal(pks.pksCanPlace(sim, 'firewall', lane, col).reason, 'off-field', lane + ',' + col);
  }
  const placed = pks.pksPlace(sim, 'firewall', 2, 2);
  assert.equal(placed.ok, true);
  assert.equal(typeof placed.id, 'number');
  assert.equal(sim.cycles, 20);
  assert.deepEqual(sim.events.slice(-1), [{ type: 'placed', id: placed.id, def: 'firewall', lane: 2, col: 2, cost: 100 }]);
  assert.deepEqual(pks.pksCanPlace(sim, 'firewall', 1, 2), Object.assign({}, base, { reason: 'recharging', lane: 1, col: 2, seconds: 5, recharge: 5, cost: 100, cycles: 20 }));
  run(sim, 1);
  assert.equal(pks.pksCanPlace(sim, 'firewall', 1, 2).seconds, 5, 'rounded up to a tenth');
  run(sim, 6);
  assert.equal(pks.pksCanPlace(sim, 'firewall', 1, 2).seconds, 4.9);
  run(sim, 5 * RATE);
  assert.deepEqual(pks.pksCanPlace(sim, 'firewall', 1, 2), Object.assign({}, base, { reason: 'cycles', lane: 1, col: 2, have: 20, need: 100, cost: 100, cycles: 20 }));
  sim.cycles = 1000;
  assert.deepEqual(pks.pksCanPlace(sim, 'proxy', 2, 2), { ok: false, reason: 'occupied', card: 'proxy', lane: 2, col: 2, occupant: 'firewall', occupantId: placed.id, cost: 50, cycles: 1000 });
  assert.equal(pks.pksPlace(sim, 'proxy', 2, 2).ok, false);
  assert.equal(sim.cycles, 1000, 'a refused place costs nothing');
  sim.status = 'won';
  assert.deepEqual(pks.pksCanPlace(sim, 'proxy', 1, 1), { ok: false, reason: 'over', card: 'proxy', lane: 1, col: 1, cost: 50, cycles: 1000 });
  assert.deepEqual(pks.pksCanPlace(sim, 'ids', 1, 1), { ok: false, reason: 'over', card: 'ids', lane: 1, col: 1 });
  assert.deepEqual(sim.stats, { kills: 0, placed: 1, spent: 100, produced: 0 });
});

test('packet-siege: a cell freed by an eaten defender takes a new one at once', () => {
  const sim = newSim();
  const psu = put(sim, 'psu', 0, 0);
  psu.hp = 1;
  enemy(sim, 'bot', 0, 1.15);
  const events = run(sim, 2);
  assert.equal(ofType(events, 'destroyed')[0].why, 'eaten');
  assert.equal(pks.pksCanPlace(sim, 'proxy', 0, 0).ok, true);
});

// ── economy ────────────────────────────────────────────────────────────────

test('packet-siege: the passive trickle gives 25 every 10 s unless the level switches it off; cards recharge', () => {
  const sim = pks.pksNewSim(1, ['psu']);
  assert.equal(sim.cycles, 100);
  let events = run(sim, 10 * RATE - 1);
  assert.equal(ofType(events, 'trickle').length, 0);
  events = run(sim, 1);
  assert.deepEqual(ofType(events, 'trickle'), [{ type: 'trickle', amount: 25 }]);
  assert.equal(sim.cycles, 125);
  run(sim, 10 * RATE);
  assert.equal(sim.cycles, 150);
  const dark = pks.pksNewSim(21, ['psu']);
  assert.equal(dark.cycles, C.BROWNOUT_CYCLES);
  run(dark, 30 * RATE);
  assert.equal(dark.cycles, C.BROWNOUT_CYCLES, 'brownout: no trickle');
  pks.pksPlace(dark, 'psu', 0, 0);
  assert.equal(dark.cards[0].left, 300);
  run(dark, 100);
  assert.equal(dark.cards[0].left, 200);
});

// ── breakers, surges, win and loss ─────────────────────────────────────────

test('packet-siege: the first enemy at the rack trips the lane\'s breaker and wipes the lane; the next one is a Breach', () => {
  const sim = newSim();
  const first = enemy(sim, 'bot', 1, 0.002);
  const second = enemy(sim, 'worm', 1, 3);
  const other = enemy(sim, 'bot', 2, 3);
  let events = run(sim, 1);
  assert.deepEqual(ofType(events, 'breaker'), [{ type: 'breaker', lane: 1 }]);
  assert.deepEqual(ofType(events, 'kill').map((k) => [k.id, k.by]), [[first.id, 'breaker'], [second.id, 'breaker']]);
  assert.ok(alive(sim, other.id));
  assert.deepEqual(sim.breakers, ['armed', 'tripped', 'armed', 'armed', 'armed']);
  assert.equal(sim.tripped, 1);
  enemy(sim, 'bot', 1, 0.002);
  const last = enemy(sim, 'bot', 1, 0.001);
  events = run(sim, 1);
  assert.equal(ofType(events, 'lose').length, 1);
  assert.equal(sim.status, 'lost');
  assert.ok(alive(sim, last.id), 'nothing moves after the Breach');
  assert.deepEqual(run(sim, 5), [], 'a finished sim no longer steps');
  assert.equal(pks.pksStars(sim), 0);
});

test('packet-siege: a level is won when everything has spawned and nothing is left; stars count the tripped breakers', () => {
  const lv = level({ spawns: [{ t: 0.5, lane: 0, type: 'bot' }], unlock: 'ids' });
  const sim = pks.pksNewSim(lv, ['firewall']);
  pks.pksPlace(sim, 'firewall', 0, 8);
  const spawnAt = run(sim, 30);
  assert.equal(ofType(spawnAt, 'spawn').length, 1);
  assert.equal(sim.spawnIndex, 1);
  sim.enemies[0].hp = 1;
  sim.enemies[0].x = 8.95;
  const events = run(sim, 60);
  assert.deepEqual(events.filter((e) => e.type === 'win' || e.type === 'unlock'), [{ type: 'win', stars: 3 }, { type: 'unlock', def: 'ids' }]);
  assert.equal(sim.status, 'won');
  assert.equal(sim.stars, 3);
  assert.equal(sim.stats.kills, 1);
  for (const [tripped, stars] of [[0, 3], [1, 2], [2, 2], [3, 1], [5, 1]]) {
    assert.equal(pks.pksStars(Object.assign({}, sim, { tripped })), stars);
  }
  const plain = pks.pksNewSim(level({ spawns: [] }), []);
  assert.deepEqual(run(plain, 1), [{ type: 'win', stars: 3 }], 'no unlock event without an unlock');
  assert.equal(pks.pksStars(pks.pksNewSim(1, [])), 0, 'no stars while playing');
});

test('packet-siege: a surge is announced 3 s ahead, then starts', () => {
  const sim = pks.pksNewSim(level({ surges: [10, 20] }), []);
  const events = run(sim, 25 * RATE);
  const marks = events.filter((e) => e.type === 'surgeWarn' || e.type === 'surge');
  assert.deepEqual(marks, [
    { type: 'surgeWarn', index: 0, at: 10 }, { type: 'surge', index: 0 },
    { type: 'surgeWarn', index: 1, at: 20 }, { type: 'surge', index: 1 }
  ]);
  const sim2 = pks.pksNewSim(level({ surges: [10] }), []);
  until(sim2, () => sim2.events.some((e) => e.type === 'surgeWarn'), 20 * RATE);
  assert.equal(sim2.tick, 7 * RATE);
  until(sim2, () => sim2.events.some((e) => e.type === 'surge'), 20 * RATE);
  assert.equal(sim2.tick, 10 * RATE);
  assert.deepEqual([sim2.warned, sim2.surged], [1, 1]);
});

test('packet-siege: spawns arrive on time at the spawn line, the boss with its level\'s tier', () => {
  for (const n of [10, 50]) {
    const sim = pks.pksNewSim(n, []);
    const lv = sim.level;
    const events = [];
    let boss = null;
    while (sim.spawnIndex < lv.spawns.length) {
      // re-armed breakers keep the idle game alive until everything is out
      for (const l of lv.lanes) sim.breakers[l] = 'armed';
      pks.pksStep(sim);
      for (const e of sim.events) {
        if (e.type === 'spawn' && e.x === C.SPAWN_X) events.push([sim.tick, e.enemy, e.lane]);
        if (e.type === 'spawn' && e.enemy === 'boss') boss = Object.assign({}, sim.enemies.find((o) => o.id === e.id));
      }
    }
    assert.equal(sim.status, 'playing');
    assert.deepEqual(events, lv.spawns.map((s) => [Math.round(s.t * RATE), s.type, s.lane]));
    const at = lv.spawns.find((s) => s.type === 'boss');
    assert.ok(boss, 'L' + n + ' boss spawned');
    assert.equal(boss.tier, n / 10);
    assert.equal(boss.maxHp, pks.pksBossTiers[n / 10 - 1].hp);
    assert.equal(boss.lane, at.lane);
    assert.equal(at.t, lv.surges[lv.surges.length - 1], 'with the final surge');
  }
});

// ── determinism and plain data ─────────────────────────────────────────────

test('packet-siege: the same level and the same inputs give the identical state after N steps; a JSON copy plays on identically', () => {
  const play = (sim, steps) => {
    for (let i = 0; i < steps; i++) {
      if (i % 97 === 0) pks.pksPlace(sim, ['psu', 'ids', 'proxy', 'tarpit'][(i / 97) % 4], (i / 97) % 5, (i / 97) % 9);
      pks.pksStep(sim);
    }
    return sim;
  };
  const a = play(pks.pksNewSim(41, ALL), 9000);
  const b = play(pks.pksNewSim(41, ALL), 9000);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const copy = JSON.parse(JSON.stringify(a));
  play(a, 3000);
  play(copy, 3000);
  assert.equal(JSON.stringify(copy), JSON.stringify(a), 'the state is all in the data');
});

test('packet-siege: a whole bot game is the same on every run', () => {
  const a = PLAYERS.playBot(12).sim;
  const b = PLAYERS.playBot(12).sim;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ── the difficulty contract ────────────────────────────────────────────────

// Measured on 2026-11-17 (after the 3x longer levels); a change in the sim
// or the tables shows up here.  Re-measure with .claude/packet-siege/tune.js.
const BOT_STARS = '33333333333333333333332223333333332323223333222222';
const WEAK_FIRST_LOSS = 7;

const ZONES = [1, 2, 3, 4, 5];
const zoneOf = (res, z) => res.slice((z - 1) * 10, z * 10);
const wins = (rows) => rows.filter((r) => r.won).length;
const avgStars = (rows) => rows.reduce((a, r) => a + r.stars, 0) / rows.length;

test('packet-siege: contract 1 — the threat budget rises strictly over the 45 non-boss levels; boss levels go by tier', () => {
  let last = 0;
  for (const n of LEVELS) {
    const lv = pks.pksLevel(n);
    if (lv.boss) {
      assert.equal(lv.boss, n / 10);
      continue;
    }
    assert.ok(lv.budget > last, 'level ' + n + ': ' + lv.budget + ' after ' + last);
    last = lv.budget;
  }
  // zone 5 is clearly the hardest: its budgets start well above zone 4's end
  assert.ok(pks.pksLevel(41).budget > 1.05 * pks.pksLevel(39).budget);
});

test('packet-siege: contract 2 — the reference bot wins all 50 levels with only what is unlocked and the level\'s slots, 3 stars on most of zones 1-2, at least 2 on average everywhere, never better zone by zone', () => {
  const res = results('bot');
  for (const n of LEVELS) {
    const r = res[n - 1];
    const owned = pks.pksUnlockedDefenders(n - 1);
    assert.ok(r.loadout.length <= pks.pksSlots(n), n + ' slots');
    for (const id of r.loadout) assert.ok(owned.includes(id), n + ' ' + id + ' is unlocked');
    assert.equal(r.won, true, 'level ' + n);
  }
  assert.ok(res.slice(0, 20).filter((r) => r.stars === 3).length >= 16, '3 stars on most of zones 1-2');
  const avg = ZONES.map((z) => avgStars(zoneOf(res, z)));
  for (const z of ZONES) assert.ok(avg[z - 1] >= 2, 'zone ' + z + ': ' + avg[z - 1]);
  for (let z = 1; z < 5; z++) assert.ok(avg[z] <= avg[z - 1], 'zone ' + (z + 1) + ' ' + avg[z] + ' after ' + avg[z - 1]);
  assert.ok(avg[4] < avg[3], 'zone 5 is harder than zone 4');
  // the outcome stays open late: from zone 3 on most breakers trip in the
  // last third of a level, not in the opening
  const trips = [];
  for (let n = 21; n <= 50; n++) for (const at of res[n - 1].tripped) trips.push(at / pks.pksLevel(n).duration);
  assert.ok(trips.length > 0);
  assert.ok(trips.filter((f) => f >= 2 / 3).length >= 0.75 * trips.length, 'late trips: ' + trips.map((f) => f.toFixed(2)).join(' '));
  assert.equal(res.map((r) => r.stars).join(''), BOT_STARS);
});

// Levels 1-50 play exactly as they did before levels 51-150 were reworked:
// per level a hash of the reference bot's whole game (its event stream and
// its final state) and the same for the weak build, from the runs the
// contracts above and below make anyway.  Measured on 2026-11-17 before the
// sim review's fixes; never re-measure to make this pass: a red pin means a
// change reached levels 1-50.  (PKS_WRITE_EARLY_PINS=1 writes the file.)
const EARLY_PINS = path.join(__dirname, 'packet-siege.early.pins.json');

function gameHash(r) {
  const state = crypto.createHash('sha256').update(JSON.stringify(r.sim)).digest('hex');
  return STREAM.get(r.sim).copy().digest('hex').slice(0, 16) + ':' + state.slice(0, 16);
}

test('packet-siege: levels 1-50 play exactly as before: every event and the final state of the reference bot\'s and the weak build\'s games are pinned', () => {
  const now = { bot: results('bot').map(gameHash), weak: results('weak').map(gameHash) };
  if (process.env.PKS_WRITE_EARLY_PINS) fs.writeFileSync(EARLY_PINS, JSON.stringify(now, null, 1) + '\n');
  const pins = JSON.parse(fs.readFileSync(EARLY_PINS, 'utf8'));
  for (const who of ['bot', 'weak']) {
    assert.equal(pins[who].length, 50);
    for (const n of LEVELS) assert.equal(now[who][n - 1], pins[who][n - 1], who + ', level ' + n);
  }
});

test('packet-siege: contract 2b — the reference bot acting only every 2 s still wins all of zone 1 and most of zone 2', () => {
  const res = results('slow');
  for (let n = 1; n <= 10; n++) assert.equal(res[n - 1].won, true, 'level ' + n);
  assert.ok(wins(zoneOf(res, 2)) >= 8, 'zone 2: ' + wins(zoneOf(res, 2)));
});

test('packet-siege: contract 2c — a novice (acts every 3 s, reacts only to what it sees) wins all of zone 1, 2+ stars on L1-6, and most of zone 2', () => {
  const res = results('novice');
  for (let n = 1; n <= 10; n++) assert.equal(res[n - 1].won, true, 'level ' + n);
  for (let n = 1; n <= 6; n++) assert.ok(res[n - 1].stars >= 2, 'level ' + n + ': ' + res[n - 1].stars);
  assert.ok(wins(zoneOf(res, 2)) >= 8, 'zone 2: ' + wins(zoneOf(res, 2)));
  // and it is no match for the late zones
  assert.ok(wins(zoneOf(res, 5)) <= 2, 'zone 5: ' + wins(zoneOf(res, 5)));
});

test('packet-siege: contract 3 — a player who places nothing loses every level', () => {
  const res = results('idle');
  for (const n of LEVELS) assert.equal(res[n - 1].won, false, 'level ' + n);
});

test('packet-siege: contract 4 — the fixed weak build wins the early levels and loses every level from 20 on; one PSU + one Firewall a lane loses all of zone 2', () => {
  const res = results('weak');
  const firstLoss = res.findIndex((r) => !r.won) + 1;
  assert.equal(firstLoss, WEAK_FIRST_LOSS);
  for (const n of [1, 2, 3, 4, 5]) assert.equal(res[n - 1].won, true, 'level ' + n);
  for (let n = 20; n <= 50; n++) assert.equal(res[n - 1].won, false, 'level ' + n);
  const psufw = results('psufw');
  for (let n = 11; n <= 20; n++) assert.equal(psufw[n - 1].won, false, 'one PSU and one Firewall a lane, level ' + n);
});

test('packet-siege: contract 4b — a simple build (generators, one shooter column, walls, rebuilt) wins most of zone 1, almost nothing in zone 5, and never more in a later zone', () => {
  const res = results('simple');
  const w = ZONES.map((z) => wins(zoneOf(res, z)));
  assert.ok(w[0] >= 6, 'zone 1: ' + w[0]);
  assert.ok(w[4] <= 1, 'zone 5: ' + w[4]);
  for (let z = 1; z < 5; z++) assert.ok(w[z] <= w[z - 1], 'wins per zone ' + w.join(' '));
});

// A duel on a hand-made level: `base` (and, when `extra` is given, that
// defender too: [type, lane, col, placed after s]) against `wave`, for
// `seconds`.  An enemy at the rack counts as a leak (and leaves); the score
// is twice the HP of every leak plus the HP still standing: lower is better.
function duel(base, wave, seconds, extra) {
  const sim = newSim();
  for (const [type, lane, col] of base) put(sim, type, lane, col);
  const foes = wave.map(([type, lane, x]) => enemy(sim, type, lane, x));
  let score = 0;
  for (let i = 0; i < seconds * RATE; i++) {
    if (extra && i === Math.round(extra[3] * RATE)) put(sim, extra[0], extra[1], extra[2]);
    for (const e of sim.enemies) {
      if (e.hp > 0 && e.x < 0.2) {
        score += 2 * e.maxHp;
        e.hp = 0;
      }
    }
    pks.pksStep(sim);
  }
  assert.ok(foes.length > 0);
  return score + sim.enemies.reduce((a, e) => a + Math.max(0, e.hp), 0);
}

test('packet-siege: contract 5 — every defender earns its place: generators pay for themselves many times over a level, every other defender beats the same defence without it; every enemy appears on its first level', () => {
  for (const id of ['psu', 'ups']) {
    const sim = newSim();
    put(sim, id, 0, 0);
    run(sim, 240 * RATE);
    assert.ok(sim.stats.produced >= 5 * DEF[id].cost, id + ' made ' + sim.stats.produced);
  }
  const bots = (n, x) => Array.from({ length: n }, (_, i) => ['bot', 2, x + i * 0.6]);
  const fw = [['firewall', 2, 1]];
  // [base, wave, seconds, where the defender goes: [lane, col, after s]]
  const scenarios = {
    firewall: [[], bots(3, 9), 60, [2, 1]],
    ids: [[], bots(3, 9), 60, [2, 1]],
    tarpit: [fw, bots(4, 9), 60, [2, 2]],
    scanner: [[], [['bot', 1, 8], ['bot', 2, 8], ['bot', 3, 8]], 60, [2, 1]],
    proxy: [fw, bots(3, 6), 60, [2, 3]],
    honeypot: [fw, [['worm', 2, 9.6]], 60, [2, 6]],
    nullroute: [fw, bots(4, 5), 30, [2, 5, 3]],
    waf: [fw, bots(3, 9), 60, [2, 5]],
    limiter: [fw, [['bot', 1, 7], ['bot', 2, 7], ['bot', 3, 7]], 60, [2, 4]],
    patch: [[['firewall', 2, 4], ['firewall', 2, 1]], [['ransom', 2, 5.3], ['bot', 2, 6], ['bot', 2, 6.6]], 30, [1, 4]],
    inspector: [fw, [['rootkit', 2, 9], ['rootkit', 2, 9.5]], 40, [2, 2]],
    failover: [fw, [['worm', 2, 6], ['worm', 2, 6.5], ['worm', 2, 7]], 30, [2, 0, 1]],
    quarantine: [fw, bots(4, 2.5), 20, [0, 8]],
    // the expansion's
    canary: [[['ids', 2, 1]], [['exploit', 2, 6]], 60, [2, 5]],
    tracer: [[], [['worm', 2, 9]], 60, [2, 1]],
    batch: [[], bots(4, 8), 60, [2, 1]],
    loopback: [fw, bots(3, 6), 60, [2, 2]],
    tokenring: [[], [['bot', 1, 6], ['bot', 2, 6], ['bot', 3, 6]], 60, [2, 1]],
    sigdb: [fw, bots(4, 9), 60, [2, 0]],
    sinkhole: [fw, [['bot', 1, 7], ['bot', 3, 7]], 60, [2, 4]],
    airgap: [[['psu', 2, 0]], [['phisher', 2, 9]], 60, [2, 4]],
    backup: [[['firewall', 2, 1], ['proxy', 2, 3]], bots(4, 4.5), 30, [1, 3]],
    scrubber: [fw, bots(4, 5), 30, [2, 5, 3]],
    decryptor: [[], [['payload', 2, 9]], 60, [2, 1]],
    honeynet: [fw, [['worm', 2, 9.6]], 60, [2, 6]]
  };
  for (const d of pks.pksDefenders) {
    if (d.kind === 'gen') continue;
    const sc = scenarios[d.id];
    assert.ok(sc, d.id + ' has a scenario');
    const [base, wave, seconds, at] = sc;
    const without = duel(base, wave, seconds);
    const withIt = duel(base, wave, seconds, [d.id, at[0], at[1], at[2] || 0]);
    assert.ok(withIt < without, d.id + ': ' + withIt + ' with it, ' + without + ' without');
  }
  for (const e of pks.pksEnemies.filter((o) => o.first <= C.LEVELS)) {
    assert.ok(pks.pksLevel(e.first).spawns.some((s) => s.type === e.id), e.id + ' on level ' + e.first);
  }
});
