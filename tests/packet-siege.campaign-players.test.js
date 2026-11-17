// tests/packet-siege.campaign-players.test.js
// Packet Siege, levels 51-150: the campaign contract of phase 4, part 3
// (see packet-siege.campaign.test.js): the slow bot (the yardstick of a
// human) on zones 6-11, the players who must lose everything past 50, the
// exploits the earlier phases flagged, and that every level ends.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScript } = require('./_setup');

const pks = loadScript('packet-siege/script.js');
const SIM_TEST = fs.readFileSync(path.join(__dirname, 'packet-siege.sim.test.js'), 'utf8');
// eslint-disable-next-line no-new-func
const PLAYERS = new Function(SIM_TEST.slice(SIM_TEST.indexOf('// ── players ──'), SIM_TEST.indexOf('// ── end players ──')) + '\nreturn players;')()(pks);
const C = pks.pksConstants;
const CAMPAIGN = require('./packet-siege.campaign.pins.json');

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('packet-siege campaign: contract 3 — the slow bot (one action every 2 s) wins most of zones 6-8, half of zones 9-11, and does on 51-55 about as well as on 46-50', () => {
  const slow = (n) => PLAYERS.playBot(n, { think: 120 });
  const res = range(51, 110).map(slow);
  assert.equal(res.map((r) => r.stars).join(''), CAMPAIGN.slowStars);
  const wins = (z) => res.slice((z - 6) * 10, (z - 5) * 10).filter((r) => r.won).length;
  for (const z of [6, 7, 8]) assert.ok(wins(z) >= 7, 'zone ' + z + ': ' + wins(z));
  for (const z of [9, 10, 11]) assert.ok(wins(z) >= 5, 'zone ' + z + ': ' + wins(z));
  // no wall between 50 and 51
  const before = range(46, 50).map(slow);
  const after = res.slice(0, 5);
  const sum = (rows, key) => rows.reduce((a, r) => a + (key === 'won' ? (r.won ? 1 : 0) : r.stars), 0);
  assert.ok(sum(after, 'won') >= sum(before, 'won'), 'wins ' + sum(after, 'won') + ' on 51-55, ' + sum(before, 'won') + ' on 46-50');
  assert.ok(sum(after, 'stars') >= sum(before, 'stars') - 2, 'stars ' + sum(after, 'stars') + ' on 51-55, ' + sum(before, 'stars') + ' on 46-50');
});

test('packet-siege campaign: contract 4 — a player who places nothing loses every level 51-150 before its nominal end; the simple and the weak builds win nothing past 50', () => {
  for (let n = 51; n <= 150; n++) {
    const idle = PLAYERS.playIdle(n);
    assert.equal(idle.won, false, 'idle, level ' + n);
    assert.ok(idle.sim.time < idle.sim.level.duration, 'idle lost at ' + idle.sim.time + ' on ' + n);
  }
  for (let n = 51; n <= 150; n += 3) {
    assert.equal(PLAYERS.playSimple(n).won, false, 'simple, level ' + n);
    assert.equal(PLAYERS.playWeak(n).won, false, 'weak, level ' + n);
  }
});

// ── the exploits the earlier phases flagged ────────────────────────────────

// A scripted player: `want` is [card, lane, col] in order; every 0.5 s the
// first of them that is not standing goes down when it can (rebuilt when
// lost); `cycles`, when given, is what it starts with.  Returns the game and
// every event of it.
function script(n, loadout, want, cycles) {
  const sim = pks.pksNewSim(n, loadout);
  if (cycles) sim.cycles = cycles;
  const events = [];
  while (sim.status === 'playing') {
    if (sim.tick % 30 === 0) {
      for (const [id, l, c] of want) {
        const r = pks.pksCanPlace(sim, id, l, c);
        if (r.reason === 'occupied') continue;
        if (r.ok) pks.pksPlace(sim, id, l, c);
        break;
      }
    }
    pks.pksStep(sim);
    for (const e of sim.events) events.push(e);
  }
  return { sim, events };
}

const LANES = [2, 1, 3, 0, 4];
const each = (id, cols) => cols.flatMap((c) => LANES.map((l) => [id, l, c]));

test('packet-siege campaign: exploits — stacked Loopbacks cannot stall a level: a wall of them and nothing else loses, every enemy thrown at most twice', () => {
  const { sim, events } = script(101, ['psu', 'loopback'], each('psu', [0]).concat(each('loopback', [1, 2, 3, 4, 5, 6])));
  assert.equal(sim.status, 'lost');
  assert.ok(sim.time < sim.level.duration, 'lost at ' + sim.time);
  const knocks = {};
  for (const e of events) if (e.type === 'knock') knocks[e.target] = (knocks[e.target] || 0) + 1;
  assert.ok(Object.keys(knocks).length > 0);
  assert.ok(Object.values(knocks).every((k) => k <= 2));
});

test('packet-siege campaign: exploits — Backup + Canary: a Backup restores no Canary, so a farm of them buys no free decoys, not even with all the cycles in the world', () => {
  const want = each('ids', [2, 3]).concat([['backup', 1, 6], ['backup', 3, 6]], each('canary', [7]), each('ids', [4, 5, 1, 0]));
  const { events } = script(101, ['ids', 'backup', 'canary'], want, 1e6);
  const canaries = events.filter((e) => e.type === 'destroyed' && e.def === 'canary').length;
  assert.ok(canaries > 5, canaries + ' Canaries lost');
  assert.equal(events.filter((e) => e.type === 'restore' && e.def === 'canary').length, 0);
  assert.ok(events.some((e) => e.type === 'restore'), 'the Backups did restore other defenders');
});

test('packet-siege campaign: exploits — Air Gaps sending the boss\'s volleys back are a bonus, not a win: a boss level held by Air Gaps alone is lost, and the volleys returned are a small part of the boss', () => {
  const { sim, events } = script(100, ['psu', 'airgap', 'proxy'], each('psu', [0]).concat(each('airgap', [6]), each('proxy', [4])));
  assert.equal(sim.status, 'lost');
  const bossIds = new Set(events.filter((e) => e.type === 'spawn' && e.enemy === 'boss').map((e) => e.id));
  const back = events.filter((e) => e.type === 'hit' && bossIds.has(e.id) && e.kind === 'volley').reduce((a, e) => a + e.dmg, 0);
  assert.ok(back < 0.15 * pks.pksBossTiers[9].hp, back + ' returned to the boss');
});

test('packet-siege campaign: exploits — a Scrubber only clears the small: Scrubbers alone lose level 111, and on the Replicator\'s level a scrub takes the third generation and spares the first two', () => {
  const { sim, events } = script(111, ['psu', 'scrubber'], each('psu', [0, 1]).concat(each('scrubber', [8, 7, 6, 5, 4, 3, 2])));
  assert.equal(sim.status, 'lost');
  const limit = pks.pksDefender.scrubber.limit;
  const scrubbed = events.filter((e) => e.type === 'kill' && e.by === 'instant');
  assert.ok(scrubbed.length > 0, 'the Scrubbers did scrub');
  for (const e of scrubbed) assert.ok(pks.pksEnemy[e.enemy].hp <= limit, e.enemy + ' scrubbed');
  // on the Replicator's own level, with an IDS a lane splitting them: a
  // scrub takes the third generation and spares every first and second one
  // on the floor at that moment
  const s103 = pks.pksNewSim(103, ['psu', 'ids', 'scrubber']);
  s103.cycles = 1e6;
  const want = each('psu', [0]).concat(each('ids', [2]), each('scrubber', [8, 7, 6, 5]));
  let spared = 0;
  let taken = 0;
  while (s103.status === 'playing') {
    if (s103.tick % 30 === 0) {
      for (const [id, l, c] of want) {
        const r = pks.pksCanPlace(s103, id, l, c);
        if (r.reason === 'occupied') continue;
        if (r.ok) pks.pksPlace(s103, id, l, c);
        break;
      }
    }
    const before = s103.enemies.filter((e) => e.type === 'replicator' && e.hp > 0 && e.x <= C.FLOOR_END).map((e) => [e.id, e.maxHp]);
    pks.pksStep(s103);
    if (!s103.events.some((e) => e.type === 'scrub')) continue;
    const killed = new Set(s103.events.filter((e) => e.type === 'kill' && e.by === 'instant').map((e) => e.id));
    for (const [id, maxHp] of before) {
      if (maxHp > limit) {
        assert.equal(killed.has(id), false, 'a Replicator of ' + maxHp + ' HP scrubbed');
        spared++;
      } else if (killed.has(id)) taken++;
    }
  }
  assert.ok(spared > 0 && taken > 0, spared + ' first or second generation on the floor at a scrub, ' + taken + ' third scrubbed');
});

test('packet-siege campaign: a level always ends: the bot that stops acting a third of the way in is done by the nominal end plus the overtime', () => {
  // the players on an api that fails a game running past that, and counts
  // what the bot does after it stops (nothing)
  let limit = Infinity;
  let late = 0;
  const api = Object.assign({}, pks, {
    pksStep(sim) {
      if (sim.time > sim.level.duration + C.OVERTIME) throw new Error('level ' + sim.n + ' still playing at ' + sim.time + ' s');
      return pks.pksStep(sim);
    },
    pksPlace(sim, id, l, c) {
      if (sim.tick >= limit) late++;
      return pks.pksPlace(sim, id, l, c);
    },
    pksRemove(sim, l, c) {
      if (sim.tick >= limit) late++;
      return pks.pksRemove(sim, l, c);
    }
  });
  const players = new Function(SIM_TEST.slice(SIM_TEST.indexOf('// ── players ──'), SIM_TEST.indexOf('// ── end players ──')) + '\nreturn players;')()(api);
  for (const n of [75, 125]) {
    const lv = pks.pksLevel(n);
    limit = Math.round(lv.duration / 3) * 60;
    late = 0;
    const r = players.playBot(n, { stopAt: limit });
    assert.equal(late, 0, n + ': it stopped acting');
    assert.ok(r.sim.tick > limit, n + ': it played on past the stop');
    assert.ok(r.sim.time <= lv.duration + C.OVERTIME, n + ' ended at ' + r.sim.time);
  }
});
