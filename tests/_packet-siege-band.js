// tests/_packet-siege-band.js
// Not a test module: what the contract-5 shards of Packet Siege share
// (packet-siege.campaign-rules-N.test.js and packet-siege.campaign-foes-N.test.js,
// see packet-siege.campaign.test.js).  Over a band of toughness values the
// reference bot plays a level with and without a zone's rules or a new enemy;
// one band costs seconds, so the zones and the enemies are spread over shards
// that each run in a few seconds.  SHARDS below is the one table of which
// shard plays which zones or enemies; packet-siege.campaign-rules-1.test.js
// checks that every zone 6-15 and every new enemy is in exactly one of them.
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

// The band (tune.js BAND): 11 toughness values 0.04 apart from one of four
// fixed starts (1.00, 1.04 ... 1.40 from the first), and the gap in wins a
// rule must make.
const B = CAMPAIGN.band;
const bandKs = (from) => Array.from({ length: B.width }, (_, i) => Math.round((from + i * B.step) * 1000) / 1000);
const wins = (n, from, opts) => bandKs(from).filter((k) => PLAYERS.playBot(n, Object.assign({ tough: k }, opts)).won).length;

// A copy of level n with its zone's rules switched off (tune.js rulesOff).
function rulesOff(n) {
  const L = JSON.parse(JSON.stringify(pks.pksLevel(n)));
  const R = L.rules;
  R.express = [];
  R.hot = [];
  if (R.names.includes('rails')) {
    R.rails = [];
    L.trickle = true;
    L.startCycles = C.START_CYCLES;
    R.trickle = C.TRICKLE;
  }
  R.tunnels = [];
  for (const s of L.spawns) delete s.tunnel;
  R.blackout = null;
  R.cross = [];
  R.upkeep = null;
  R.outage = null;
  L.fog = 0;
  L.speed = 1;
  return L;
}

// The new enemies whose first level does not get clearly harder with them
// (measured 2026-11-17; see the report of the sim review).
const WEAK = ['wiper', 'payload'];

// Which shard plays which zones (rules) or new enemies (foes), by file name:
// later levels are longer, so later shards take fewer of them (each shard
// about 8 s alone on the development machine, measured 2026-11-17).
// The first shard of each kind also holds the test that its pins are
// complete, and campaign-rules-1 the test that this table covers every zone
// and every new enemy exactly once.
const SHARDS = {
  'packet-siege.campaign-rules-1.test.js': { zones: [6, 7, 8, 9] },
  'packet-siege.campaign-rules-2.test.js': { zones: [10, 11] },
  'packet-siege.campaign-rules-3.test.js': { zones: [12, 13] },
  'packet-siege.campaign-rules-4.test.js': { zones: [14, 15] },
  'packet-siege.campaign-foes-1.test.js': { enemies: ['keylogger', 'logicbomb', 'amplifier', 'wiper'] },
  'packet-siege.campaign-foes-2.test.js': { enemies: ['hive', 'hydra', 'payload'] },
  'packet-siege.campaign-foes-3.test.js': { enemies: ['jammer', 'replicator', 'dropper'] },
  'packet-siege.campaign-foes-4.test.js': { enemies: ['titan', 'glitch'] }
};

// The slice of the shard `file` (its __filename).
function shard(file) {
  const s = SHARDS[path.basename(file)];
  if (!s) throw new Error(path.basename(file) + ' is not in SHARDS of tests/_packet-siege-band.js');
  return s;
}

// One test per zone of the shard `file`: the zone's rules make one of its
// levels measurably harder over the band (the level and both counts pinned
// in CAMPAIGN.rules).
function zoneTests(file) {
  for (const z of shard(file).zones) {
    test('packet-siege campaign: contract 5 — zone ' + z + '\'s rules matter: over the band the bot wins clearly more of a level of the zone without them', () => {
      const [n, from, good, bad] = CAMPAIGN.rules[z - 6];
      const without = wins(n, from, { level: rulesOff(n) });
      const withIt = wins(n, from, {});
      assert.deepEqual([without, withIt], [good, bad], 'level ' + n + ': wins without / with its rules');
      assert.ok(without - withIt >= B.gap, 'level ' + n + ': ' + without + ' wins without its rules, ' + withIt + ' with them');
    });
  }
}

// One test per new enemy of the shard `file`: on the level that introduces
// it the bot wins clearly more over the band with the enemy taken out (an
// enemy in WEAK the other way round; the counts pinned in CAMPAIGN.enemies).
function enemyTests(file) {
  for (const [id, from, good, bad] of CAMPAIGN.enemies.filter(([e]) => shard(file).enemies.includes(e))) {
    const n = pks.pksEnemy[id].first;
    test('packet-siege campaign: contract 5 — the ' + pks.pksEnemy[id].name + ' matters: over the band the bot wins ' + (WEAK.includes(id) ? 'NOT clearly' : 'clearly') + ' more of level ' + n + ' without it', () => {
      const lv = JSON.parse(JSON.stringify(pks.pksLevel(n)));
      lv.spawns = lv.spawns.filter((s) => s.type !== id);
      assert.ok(pks.pksLevel(n).spawns.some((s) => s.type === id), id + ' on level ' + n);
      const without = wins(n, from, { level: lv });
      const withIt = wins(n, from, {});
      assert.deepEqual([without, withIt], [good, bad], id + ' on ' + n + ': wins without / with it');
      if (WEAK.includes(id)) assert.ok(without - withIt < B.gap, id + ' is no longer weak: take it out of WEAK');
      else assert.ok(without - withIt >= B.gap, id + ' on ' + n + ': ' + without + ' wins without it, ' + withIt + ' with it');
    });
  }
}

module.exports = { pks, CAMPAIGN, B, bandKs, WEAK, SHARDS, zoneTests, enemyTests };
