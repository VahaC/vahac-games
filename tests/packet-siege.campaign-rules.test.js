// tests/packet-siege.campaign-rules.test.js
// Packet Siege, levels 51-150: contract 5 of phase 4 for the zone rules
// (see packet-siege.campaign.test.js): every zone's rule makes its levels
// measurably harder.  Not at one toughness, where the chaos of the sim makes
// any single win or loss a coin flip, but over a band: on one level of each
// zone the reference bot plays with the zone's rules and without them at
// each of the band's toughness values, and wins clearly more often without.
// The level and both counts are pinned in packet-siege.campaign.pins.json
// (.claude/packet-siege/tune.js --bands shows the scans behind them, --pins
// writes them).  The band games of contract 5 are split over three modules
// (rules, cards, foes) so that each runs in well under a minute.
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

test('packet-siege campaign: contract 5 — a band is 11 toughness values 0.04 apart from 1, 1.2, 1.4 or 1.6, and a gap of 3 wins; one level of every zone 6-15 is pinned', () => {
  assert.deepEqual(bandKs(1), [1, 1.04, 1.08, 1.12, 1.16, 1.2, 1.24, 1.28, 1.32, 1.36, 1.4]);
  assert.deepEqual([B.starts, B.gap], [[1, 1.2, 1.4, 1.6], 3]);
  assert.deepEqual(CAMPAIGN.rules.map(([n]) => Math.ceil(n / 10)), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  for (const [n, from] of CAMPAIGN.rules) assert.ok(n % 10 !== 0 && B.starts.includes(from), n);
});

for (let z = 6; z <= 15; z++) {
  test('packet-siege campaign: contract 5 — zone ' + z + '\'s rules matter: over the band the bot wins clearly more of a level of the zone without them', () => {
    const [n, from, good, bad] = CAMPAIGN.rules[z - 6];
    const without = wins(n, from, { level: rulesOff(n) });
    const withIt = wins(n, from, {});
    assert.deepEqual([without, withIt], [good, bad], 'level ' + n + ': wins without / with its rules');
    assert.ok(without - withIt >= B.gap, 'level ' + n + ': ' + without + ' wins without its rules, ' + withIt + ' with them');
  });
}
