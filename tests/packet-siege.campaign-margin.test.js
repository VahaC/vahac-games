// tests/packet-siege.campaign-margin.test.js
// Packet Siege, levels 51-150: the campaign contract of phase 4, contract 2's
// margin (see packet-siege.campaign.test.js): the reference bot still wins
// with every enemy 10 % tougher, sampled on 51-100 and on 101-150.  Apart
// from the bot's plain games on those levels (packet-siege.campaign.test.js
// and packet-siege.campaign-late.test.js) so that each module runs in a few
// seconds.
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
const CAMPAIGN = require('./packet-siege.campaign.pins.json');

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('packet-siege campaign: contract 2 (51-100) — no razor-thin margin: the bot still wins with every enemy 10 % tougher (sampled: every odd level and every boss level; tune.js --fit checks them all)', () => {
  for (const n of range(51, 100).filter((m) => m % 2 === 1 || m % 10 === 0)) assert.equal(PLAYERS.playBot(n, { tough: CAMPAIGN.hard }).won, true, 'level ' + n);
});

test('packet-siege campaign: contract 2 (101-150) — no razor-thin margin: the bot still wins with every enemy 10 % tougher (sampled: every odd level and every boss level; tune.js --fit checks them all)', () => {
  for (const n of range(101, 150).filter((m) => m % 2 === 1 || m % 10 === 0)) assert.equal(PLAYERS.playBot(n, { tough: CAMPAIGN.hard }).won, true, 'level ' + n);
});
