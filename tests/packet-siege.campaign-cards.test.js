// tests/packet-siege.campaign-cards.test.js
// Packet Siege, levels 51-150: contract 5 of phase 4 for the twelve new
// defenders (see packet-siege.campaign.test.js and, for the band,
// packet-siege.campaign-rules.test.js): on a level after its unlock the
// reference bot, over the band of toughness values, wins clearly more often
// with the card than without it (the next card of its order in its slot).
// A card no level shows that for keeps no full-level claim: its pin names
// instead the scripted scenario of packet-siege.expansion.test.js that
// proves it does its stated job (a buff is the owner's call).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScript } = require('./_setup');

const pks = loadScript('packet-siege/script.js');
const SIM_TEST = fs.readFileSync(path.join(__dirname, 'packet-siege.sim.test.js'), 'utf8');
const EXPANSION_TEST = fs.readFileSync(path.join(__dirname, 'packet-siege.expansion.test.js'), 'utf8').replace(/\\'/g, "'");
// eslint-disable-next-line no-new-func
const PLAYERS = new Function(SIM_TEST.slice(SIM_TEST.indexOf('// ── players ──'), SIM_TEST.indexOf('// ── end players ──')) + '\nreturn players;')()(pks);
const CAMPAIGN = require('./packet-siege.campaign.pins.json');

const B = CAMPAIGN.band;
const bandKs = (from) => Array.from({ length: B.width }, (_, i) => Math.round((from + i * B.step) * 1000) / 1000);
const wins = (n, from, opts) => bandKs(from).filter((k) => PLAYERS.playBot(n, Object.assign({ tough: k }, opts)).won).length;

test('packet-siege campaign: contract 5 — every new defender is pinned, by a band on a level after its unlock or by a scripted scenario', () => {
  assert.deepEqual(CAMPAIGN.defenders.map(([id]) => id), pks.pksDefenders.slice(15).map((d) => d.id));
  for (const [id, n, from, good, bad, scenario] of CAMPAIGN.defenders) {
    if (n === null) {
      assert.deepEqual([from, good, bad], [null, null, null], id);
      assert.ok(EXPANSION_TEST.includes('test(\'packet-siege expansion: ' + scenario), id + ': the scenario "' + scenario + '" is a test of packet-siege.expansion.test.js');
    } else {
      assert.equal(scenario, undefined, id);
      assert.ok(B.starts.includes(from), id);
      assert.ok(n % 10 !== 0 && pks.pksUnlockedDefenders(n - 1).includes(id), id + ' is unlocked on ' + n);
    }
  }
});

for (const [id, n, from, good, bad] of CAMPAIGN.defenders) {
  if (n === null) continue;
  test('packet-siege campaign: contract 5 — the ' + pks.pksDefender[id].name + ' earns its place: over the band the bot wins clearly more of level ' + n + ' with it', () => {
    const withIt = PLAYERS.lateLoadoutWith(n, id);
    const without = PLAYERS.lateLoadout(n, id);
    assert.ok(withIt.includes(id) && !without.includes(id), id);
    const w = wins(n, from, { loadout: withIt });
    const wo = wins(n, from, { loadout: without });
    assert.deepEqual([w, wo], [good, bad], id + ' on ' + n + ': wins with / without it');
    assert.ok(w - wo >= B.gap, id + ' on ' + n + ': ' + w + ' wins with it, ' + wo + ' without');
  });
}
