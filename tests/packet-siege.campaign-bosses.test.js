// tests/packet-siege.campaign-bosses.test.js
// Packet Siege, levels 51-150: the campaign contract of phase 4, contract 1b
// (see packet-siege.campaign.test.js): every boss level 60-150 is at least
// as demanding as the level before it.  Apart from the bot's plain games on
// those levels (packet-siege.campaign.test.js and
// packet-siege.campaign-late.test.js) so that each module runs in a few
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

test('packet-siege campaign: contract 1b — a boss level is at least as demanding as the level before it: at a toughness the level before is still won with, the boss level is lost', () => {
  for (const n of [60, 70, 80, 90, 100]) {
    const [k, think] = CAMPAIGN.bossDemand[n];
    assert.equal(PLAYERS.playBot(n - 1, { tough: k, think }).won, true, (n - 1) + ' at ' + k);
    assert.equal(PLAYERS.playBot(n, { tough: k, think }).won, false, n + ' at ' + k);
  }
});

test('packet-siege campaign: contract 1b — a boss level 110-150 is at least as demanding as the level before it', () => {
  for (const n of [110, 120, 130, 140, 150]) {
    const [k, think] = CAMPAIGN.bossDemand[n];
    assert.equal(PLAYERS.playBot(n - 1, { tough: k, think }).won, true, (n - 1) + ' at ' + k);
    assert.equal(PLAYERS.playBot(n, { tough: k, think }).won, false, n + ' at ' + k);
  }
});
