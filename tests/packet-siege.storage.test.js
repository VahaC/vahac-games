// tests/packet-siege.storage.test.js
// The save format of Packet Siege (pks-state: parse, merge, blocked and full
// storage, the win record over the whole 150-level campaign, a save written
// by the 50-level game) and the snapshot of a level in progress (pks-run:
// text, validation, the hash of the level tables, the write that never
// overwrites another tab's snapshot, and a round trip mid-level on late
// levels with their zone rules running that plays on exactly like the
// original).
//
// Level numbers (durations, budgets, rule timings) are read from pksLevel and
// the rule tables, never written here: levels 51-150 are tuned elsewhere.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, readRepoFile, createStorage } = require('./_setup');

const GAME = 'packet-siege';
const pks = loadScript(GAME + '/script.js');
const LEVELS = pks.pksConstants.LEVELS;
const ALL = pks.pksDefenders.map((d) => d.id);
const RATE = pks.pksConstants.RATE;

const FRESH = '{"v":1,"unlocked":1,"stars":[' + new Array(LEVELS).fill(0).join(',') + '],"loadout":[],"speed":1,"met":[]}';

function save(over) {
  return Object.assign(pks.pksNewSave(), over);
}

// ── the save ───────────────────────────────────────────────────────────────

test('packet-siege: a new save, its text pinned at 150 levels, and round trips byte for byte', () => {
  assert.equal(LEVELS, 150);
  assert.equal(pks.pksSaveKey, 'pks-state');
  assert.equal(pks.pksSerialize(pks.pksNewSave()), FRESH);
  const stars = new Array(LEVELS).fill(0);
  stars.splice(0, 12, 3, 3, 2, 3, 1, 3, 3, 3, 2, 3, 3, 1);
  stars[120] = 2;
  const text = JSON.stringify({ v: 1, unlocked: 122, stars, loadout: ['ids', 'psu', 'proxy', 'nullroute', 'tarpit', 'firewall', 'canary', 'tracer', 'batch', 'decryptor'], speed: 2, met: ['bot', 'kiddie', 'worm', 'drone', 'trojan', 'exploit', 'glitch', 'boss'] });
  const parsed = pks.pksParseSave(text);
  assert.equal(pks.pksSerialize(parsed), text);
  assert.deepEqual(pks.pksParseSave(pks.pksSerialize(parsed)), parsed);
  assert.equal(parsed.unlocked, 122);
  assert.equal(parsed.speed, 2);
});

test('packet-siege: corrupt, foreign, missing and other-version saves start fresh', () => {
  for (const text of [null, '', 'not json', '{', '[]', '5', 'true', 'null', '"x"', '{}', '{"v":2,"unlocked":9}', '{"v":"1","unlocked":9}', '{"unlocked":9}']) {
    assert.equal(pks.pksSerialize(pks.pksParseSave(text)), FRESH, String(text));
  }
});

test('packet-siege: every field of the save falls back on its own', () => {
  const base = { v: 1, unlocked: 4, stars: [3, 2, 1], loadout: ['psu', 'firewall'], speed: 2, met: ['bot', 'kiddie'] };
  const parse = (over) => pks.pksParseSave(JSON.stringify(Object.assign({}, base, over)));
  // unlocked: whole numbers 1..150; stars above it open the level after them
  for (const bad of [0, 151, 3.5, '7', null, -1, true]) assert.equal(parse({ unlocked: bad, stars: [] }).unlocked, 1, String(bad));
  assert.equal(parse({ unlocked: 51, stars: [] }).unlocked, 51, 'past the old 50');
  assert.equal(parse({ unlocked: 150, stars: [] }).unlocked, 150);
  assert.equal(parse({ unlocked: 2 }).unlocked, 4, 'three won levels open the fourth');
  assert.equal(parse({ unlocked: 1, stars: new Array(150).fill(1) }).unlocked, 150);
  // stars: whole 0..3 per level, 150 of them
  assert.deepEqual(parse({ stars: [3, 4, -1, 2.5, '3', null, 2] }).stars.slice(0, 8), [3, 0, 0, 0, 0, 0, 2, 0]);
  assert.equal(parse({ stars: new Array(160).fill(2) }).stars.length, 150);
  assert.deepEqual(parse({ stars: 'lots' }).stars, new Array(150).fill(0));
  const fine = parse({});
  assert.deepEqual([fine.unlocked, fine.stars.slice(0, 4), fine.loadout, fine.speed, fine.met], [4, [3, 2, 1, 0], ['psu', 'firewall'], 2, ['bot', 'kiddie']]);
  // loadout: known ids, no repeats, at most pksSlots(150), in the order saved
  assert.deepEqual(parse({ loadout: ['ids', 'nope', 'ids', 5, 'constructor', null, 'psu'] }).loadout, ['ids', 'psu']);
  assert.deepEqual(parse({ loadout: ALL }).loadout, ALL.slice(0, pks.pksSlots(150)));
  assert.equal(pks.pksSlots(150), 10);
  assert.deepEqual(parse({ loadout: 'psu' }).loadout, []);
  // speed: 1 or 2
  for (const bad of [3, '2', 0, null, 1.5]) assert.equal(parse({ speed: bad }).speed, 1, String(bad));
  // met: known enemies and the boss, in table order, once each
  assert.deepEqual(parse({ met: ['boss', 'worm', 'bot', 'worm', 'dragon', 7, '__proto__', 'glitch'] }).met, ['bot', 'worm', 'glitch', 'boss']);
  assert.deepEqual(parse({ met: { bot: true } }).met, []);
  // the other fields stay when one is broken
  const one = parse({ loadout: 42 });
  assert.deepEqual([one.unlocked, one.speed, one.met], [4, 2, ['bot', 'kiddie']]);
});

// A save exactly as the 50-level game wrote it: level 50 won, a full
// eight-card loadout, 2x speed, everything met.
const OLD_SAVE_WON = '{"v":1,"unlocked":50,"stars":[3,3,3,2,3,3,3,3,2,3,3,3,1,3,3,2,3,3,3,3,3,3,3,2,3,3,3,3,3,1,' +
  '3,3,3,3,2,3,3,3,3,3,3,3,3,2,3,3,3,3,3,2],"loadout":["psu","firewall","proxy","ids","scanner","ups","inspector","quarantine"],' +
  '"speed":2,"met":["bot","kiddie","worm","drone","trojan","exploit","phisher","brute","ransom","miner","rootkit","zeroday","polymorph","boss"]}';
// ... and one half way through: levels 1-36 won, level 37 open.
const OLD_SAVE_MID = '{"v":1,"unlocked":37,"stars":[3,3,3,3,3,3,3,3,3,3,2,2,2,2,2,2,2,2,2,2,1,1,1,1,1,1,1,1,1,1,3,3,3,3,3,3,' +
  '0,0,0,0,0,0,0,0,0,0,0,0,0,0],"loadout":["psu","firewall","tarpit","ids","scanner","ups","inspector"],"speed":1,"met":["bot","worm","boss"]}';

test('packet-siege: a save written by the 50-level game loads unchanged in meaning: 150 stars, the same progress, level 51 and the Canary for a player who won level 50', () => {
  const old = JSON.parse(OLD_SAVE_WON);
  const won = pks.pksParseSave(OLD_SAVE_WON);
  assert.equal(won.v, 1, 'no new version: the format only grew');
  assert.equal(won.stars.length, 150);
  assert.deepEqual(won.stars.slice(0, 50), old.stars);
  assert.deepEqual(won.stars.slice(50), new Array(100).fill(0), 'padded with zeros');
  assert.equal(won.unlocked, 51, 'level 50 was won, so level 51 is open');
  assert.equal(pks.pksHighestWon(won), 50);
  assert.ok(pks.pksOwnedDefenders(won).includes('canary'), 'the Canary is owned');
  assert.deepEqual(pks.pksOwnedDefenders(won), pks.pksUnlockedDefenders(50));
  assert.deepEqual([won.loadout, won.speed, won.met], [old.loadout, 2, old.met]);
  const lo = pks.pksLoadoutFor(won, 51);
  assert.deepEqual([lo.slots, lo.choose], [8, true]);
  assert.deepEqual(lo.pick, old.loadout, 'the last loadout comes back as it was');
  // written back: the 150-level text, parsed the same
  assert.deepEqual(pks.pksParseSave(pks.pksSerialize(won)), won);
  const mid = pks.pksParseSave(OLD_SAVE_MID);
  assert.equal(mid.unlocked, 37);
  assert.equal(pks.pksHighestWon(mid), 36);
  assert.deepEqual(mid.stars.slice(0, 37), JSON.parse(OLD_SAVE_MID).stars.slice(0, 37));
  assert.ok(!pks.pksOwnedDefenders(mid).includes('canary'));
  assert.deepEqual(mid.loadout, JSON.parse(OLD_SAVE_MID).loadout);
  // winning level 50 from an old save still at 50 opens 51 and announces the Canary
  const at50 = pks.pksParseSave(OLD_SAVE_WON.replace(/,2\],"loadout"/, ',0],"loadout"'));
  assert.equal(at50.unlocked, 50);
  const r = pks.pksRecordWin(at50, 50, 3);
  assert.deepEqual([r.newLevel, r.newDefenders, r.newSlots], [51, ['canary'], null]);
});

test('packet-siege: merging keeps the higher progress of both tabs and the loadout and speed of this one', () => {
  const mine = save({ unlocked: 5, loadout: ['psu'], speed: 2, met: ['bot', 'worm'] });
  mine.stars = mine.stars.map((_, i) => (i < 4 ? 1 : 0));
  const other = save({ unlocked: 9, loadout: ['ids'], speed: 1, met: ['kiddie', 'boss'] });
  other.stars = other.stars.map((_, i) => (i < 8 ? (i % 2 ? 3 : 0) : 0));
  const copyMine = JSON.stringify(mine);
  const copyOther = JSON.stringify(other);
  const merged = pks.pksMergeSaves(mine, other);
  assert.equal(merged.unlocked, 9);
  assert.deepEqual(merged.stars.slice(0, 9), [1, 3, 1, 3, 0, 3, 0, 3, 0]);
  assert.equal(merged.stars.length, 150);
  assert.deepEqual(merged.met, ['bot', 'kiddie', 'worm', 'boss']);
  assert.deepEqual([merged.loadout, merged.speed], [['psu'], 2]);
  assert.equal(JSON.stringify(mine), copyMine);
  assert.equal(JSON.stringify(other), copyOther);
  merged.loadout.push('ids');
  assert.deepEqual(mine.loadout, ['psu'], 'no shared arrays');
});

test('packet-siege: reading: no save, a save, blocked storage and no storage at all', () => {
  const storage = createStorage();
  assert.deepEqual(pks.pksReadSave(storage), { state: pks.pksNewSave(), ok: true, error: null, newer: 0 });
  storage.setItem('pks-state', pks.pksSerialize(save({ unlocked: 7 })));
  assert.equal(pks.pksReadSave(storage).state.unlocked, 7);
  const blocked = { getItem() { throw new DOMException('The operation is insecure.', 'SecurityError'); } };
  const r = pks.pksReadSave(blocked);
  assert.deepEqual([r.ok, r.error.name, r.state], [false, 'SecurityError', pks.pksNewSave()]);
  const none = pks.pksReadSave(null);
  assert.deepEqual([none.ok, none.error instanceof TypeError], [false, true]);
});

test('packet-siege: writing re-reads and merges a second tab\'s progress, and reports blocked or full storage instead of throwing', () => {
  const storage = createStorage();
  const mine = save({ unlocked: 3, loadout: ['firewall', 'psu'], speed: 2, met: ['bot'] });
  mine.stars[0] = 3;
  mine.stars[1] = 1;
  let w = pks.pksWriteSave(storage, mine);
  assert.deepEqual([w.ok, w.error], [true, null]);
  assert.equal(storage.getItem('pks-state'), pks.pksSerialize(mine));
  const other = save({ unlocked: 6, met: ['kiddie'] });
  other.stars = other.stars.map((_, i) => (i < 5 ? 2 : 0));
  storage.setItem('pks-state', pks.pksSerialize(other));
  w = pks.pksWriteSave(storage, mine);
  assert.equal(w.ok, true);
  assert.equal(w.state.unlocked, 6);
  assert.deepEqual(w.state.stars.slice(0, 6), [3, 2, 2, 2, 2, 0]);
  assert.deepEqual(w.state.met, ['bot', 'kiddie']);
  assert.deepEqual(w.state.loadout, ['firewall', 'psu']);
  assert.equal(storage.getItem('pks-state'), pks.pksSerialize(w.state));
  const full = createStorage();
  full.setItem('pks-state', pks.pksSerialize(other));
  full.setItem = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  w = pks.pksWriteSave(full, mine);
  assert.deepEqual([w.ok, w.error.name, w.state.unlocked], [false, 'QuotaExceededError', 6]);
  const blocked = {
    getItem() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    setItem() { throw new DOMException('The operation is insecure.', 'SecurityError'); }
  };
  w = pks.pksWriteSave(blocked, mine);
  assert.deepEqual([w.ok, w.error.name, w.state], [false, 'SecurityError', pks.pksMergeSaves(mine, pks.pksNewSave())]);
  const halfway = createStorage();
  const read = halfway.getItem;
  halfway.getItem = blocked.getItem;
  w = pks.pksWriteSave(halfway, mine);
  assert.equal(w.ok, true);
  assert.equal(read('pks-state'), pks.pksSerialize(mine));
  assert.equal(pks.pksWriteSave(null, mine).ok, false);
});

test('packet-siege: a save of a newer version reads as a new save with its version, and writing never replaces it', () => {
  const storage = createStorage();
  const mine = save({ unlocked: 3, speed: 2 });
  mine.stars[0] = 3;
  mine.stars[1] = 2;
  for (const text of ['{"v":2,"unlocked":9}', '{"v":7}', '{"v":2,"stars":"other"}']) {
    storage.setItem('pks-state', text);
    const r = pks.pksReadSave(storage);
    const v = JSON.parse(text).v;
    assert.deepEqual(r, { state: pks.pksNewSave(), ok: false, error: null, newer: v }, text);
    const w = pks.pksWriteSave(storage, mine);
    assert.deepEqual(w, { state: pks.pksMergeSaves(mine, pks.pksNewSave()), ok: false, error: null, newer: v }, text);
    assert.equal(storage.getItem('pks-state'), text, 'left as it was: ' + text);
  }
  // not newer: an older, a broken or a non-whole version is a foreign save, read fresh and written over
  for (const text of ['{"v":0}', '{"v":-3}', '{"v":"2"}', '{"v":1.5}', '{"v":null}', 'null', '{oops', '{"v":1,"unlocked":2}']) {
    storage.setItem('pks-state', text);
    assert.deepEqual([pks.pksReadSave(storage).ok, pks.pksReadSave(storage).newer], [true, 0], text);
    const w = pks.pksWriteSave(storage, mine);
    assert.deepEqual([w.ok, w.newer], [true, 0], text);
    assert.equal(storage.getItem('pks-state'), pks.pksSerialize(w.state), text);
  }
  assert.equal(pks.pksReadSave(createStorage()).newer, 0, 'no save at all');
});

test('packet-siege: pksRecordWin over the whole 150-level campaign: each new level, defender and slot exactly once, consistent with the core', () => {
  let state = pks.pksNewSave();
  const unlocks = {};
  for (const d of pks.pksDefenders) if (d.unlock > 0) unlocks[d.unlock] = d.id;
  const slotsAt = {};
  for (let n = 1; n < LEVELS; n++) if (pks.pksSlots(n + 1) > pks.pksSlots(n)) slotsAt[n] = pks.pksSlots(n + 1);
  assert.deepEqual(slotsAt, { 10: 6, 30: 7, 40: 8, 70: 9, 110: 10 });
  assert.equal(unlocks[50], 'canary', 'winning level 50 brings the Canary');
  assert.deepEqual(pks.pksOwnedDefenders(state), ['psu', 'firewall']);
  for (let n = 1; n <= LEVELS; n++) {
    assert.equal(state.unlocked, n);
    const before = JSON.stringify(state);
    const r = pks.pksRecordWin(state, n, 1 + n % 3);
    assert.equal(JSON.stringify(state), before, 'the old save is not changed');
    assert.deepEqual([r.level, r.stars, r.before, r.improved], [n, 1 + n % 3, 0, true]);
    assert.equal(r.newLevel, n < LEVELS ? n + 1 : null, 'L' + n);
    assert.deepEqual(r.newDefenders, unlocks[n] ? [unlocks[n]] : [], 'L' + n);
    assert.equal(r.newSlots, slotsAt[n] || null, 'L' + n);
    state = r.state;
    assert.equal(pks.pksHighestWon(state), n);
    assert.deepEqual(pks.pksOwnedDefenders(state), pks.pksUnlockedDefenders(n));
    assert.deepEqual(pks.pksParseSave(pks.pksSerialize(state)), state, 'it saves as it is');
  }
  assert.equal(state.unlocked, 150);
  assert.equal(pks.pksOwnedDefenders(state).length, 27);
  let r = pks.pksRecordWin(state, 7, 1);
  assert.deepEqual([r.stars, r.before, r.improved, r.newLevel, r.newDefenders, r.newSlots], [2, 2, false, null, [], null]);
  r = pks.pksRecordWin(state, 7, 3);
  assert.deepEqual([r.stars, r.before, r.improved, r.newLevel, r.newDefenders, r.newSlots], [3, 2, true, null, [], null]);
  r = pks.pksRecordWin(state, 150, 3);
  assert.deepEqual([r.stars, r.before, r.improved, r.newLevel, r.newDefenders], [3, 1, true, null, []], 'level 150 replayed');
});

test('packet-siege: enemies met are recorded once, in table order; unknown ids are ignored', () => {
  let state = pks.pksNewSave();
  let r = pks.pksRecordMet(state, 'worm');
  assert.deepEqual([r.added, r.state.met], [true, ['worm']]);
  assert.deepEqual(state.met, [], 'the old save is not changed');
  state = r.state;
  r = pks.pksRecordMet(state, 'bot');
  assert.deepEqual(r.state.met, ['bot', 'worm']);
  state = r.state;
  for (const id of ['bot', 'dragon', 'constructor']) {
    r = pks.pksRecordMet(state, id);
    assert.equal(r.added, false);
    assert.equal(r.state, state);
  }
  assert.deepEqual(pks.pksRecordMet(state, 'boss').state.met, ['bot', 'worm', 'boss']);
  assert.deepEqual(pks.pksRecordMet(state, 'titan').state.met, ['bot', 'worm', 'titan']);
});

test('packet-siege: the loadout for a level: everything owned when it fits, else the last loadout filled with the newest, up to 10 slots', () => {
  let r = pks.pksLoadoutFor(save({ unlocked: 4 }), 4);
  assert.deepEqual(r, { owned: ['psu', 'firewall', 'proxy', 'honeypot'], slots: 5, pick: ['psu', 'firewall', 'proxy', 'honeypot'], choose: false });
  const s = save({ unlocked: 11, loadout: ['ids', 'gone', 'psu', 'waf'] });
  r = pks.pksLoadoutFor(s, 11);
  assert.deepEqual([r.slots, r.choose], [6, true]);
  assert.deepEqual(r.owned, pks.pksUnlockedDefenders(10));
  assert.deepEqual(r.pick, ['ids', 'psu', 'nullroute', 'tarpit', 'honeypot', 'proxy']);
  r = pks.pksLoadoutFor(save({ unlocked: 9, loadout: ALL }), 9);
  assert.deepEqual(r.pick, ['psu', 'firewall', 'proxy', 'honeypot', 'tarpit'], 'trimmed to the slots');
  // the late campaign: 9 slots from 71, 10 from 111, filled with the newest
  const late = save({ unlocked: 121, loadout: ['psu', 'firewall'] });
  r = pks.pksLoadoutFor(late, 121);
  assert.equal(r.slots, 10);
  assert.deepEqual(r.pick.slice(0, 2), ['psu', 'firewall']);
  assert.deepEqual(r.pick.slice(2), pks.pksUnlockedDefenders(120).slice(-8).reverse());
  assert.equal(pks.pksLoadoutFor(late, 71).slots, 9);
  const won = save({ unlocked: 150 });
  won.stars[149] = 2;
  assert.equal(pks.pksHighestWon(won), 150);
  assert.equal(pks.pksHighestWon(save({ unlocked: 150 })), 149);
});

// ── the snapshot of a level in progress ────────────────────────────────────

// The cards of the snapshots below: ten defenders every root level owns.
const CARDS = ['psu', 'firewall', 'proxy', 'ids', 'scanner', 'tracer', 'batch', 'tokenring', 'decryptor', 'honeynet'];

// Level n played with a fixed defence (plenty of cycles, a wall of shooters
// on the left columns) until done(sim) or its own duration is up.
function playUntil(n, done) {
  const sim = pks.pksNewSim(n, CARDS);
  sim.cycles = 1e6;
  for (let lane = 0; lane < 5; lane++) {
    for (const [id, col] of [['firewall', 0], ['ids', 1], ['scanner', 2], ['proxy', 4]]) {
      sim.cards.find((c) => c.id === id).left = 0;
      pks.pksPlace(sim, id, lane, col);
    }
  }
  const end = Math.round((sim.level.duration + 60) * RATE);
  while (sim.status === 'playing' && !done(sim) && sim.tick < end) pks.pksStep(sim);
  assert.equal(sim.status, 'playing', 'L' + n + ' still on');
  assert.ok(done(sim), 'L' + n + ': the moment came within the level');
  return sim;
}

// The first level of 51-150 whose rules include `name`.
const levelWith = (name) => {
  for (let n = 51; n <= LEVELS; n++) if (pks.pksLevel(n).rules.names.includes(name)) return n;
  return 0;
};

test('packet-siege: a snapshot mid-level on late levels with their rules running plays on exactly like the original', () => {
  const cases = [
    ['blackout dark', levelWith('blackout'), (s) => s.blackout.state === 'dark'],
    ['outage down', levelWith('outage'), (s) => s.outage.state === 'down'],
    ['a tunnel shimmering', levelWith('tunnels'), (s) => s.shimmers.length > 0],
    ['upkeep charged', levelWith('upkeep'), (s) => s.upkeep.last > 0],
    ['two root rules', 144, (s) => s.outage.state === 'warn'],
    ['root: crossovers and tunnels', 143, (s) => s.enemies.some((e) => e.crossed.length > 0)]
  ];
  for (const [what, n, done] of cases) {
    assert.ok(n > 50, what);
    const sim = playUntil(n, done);
    const text = pks.pksRunText(sim, CARDS);
    const raw = JSON.parse(text);
    assert.deepEqual(Object.keys(raw), ['v', 'n', 'hash', 'cards', 'sim']);
    assert.deepEqual([raw.v, raw.n, raw.hash, raw.cards], [1, n, pks.pksRunHash(n), CARDS]);
    assert.equal(raw.sim.level, undefined, 'the level is not stored');
    assert.equal(raw.sim.events, undefined, 'nor the events');
    const run = pks.pksParseRun(text);
    assert.ok(run, what);
    assert.deepEqual([run.n, run.cards, run.time], [n, CARDS, sim.time]);
    assert.deepEqual(run.sim.level, sim.level);
    // the state as text, in one key order, and the events of the step
    const same = (where) => {
      assert.equal(pks.pksRunText(run.sim, CARDS), pks.pksRunText(sim, CARDS), where);
      assert.equal(JSON.stringify(run.sim.events), JSON.stringify(sim.events), where);
    };
    assert.deepEqual(run.sim.events, []);
    sim.events = [];
    same(what + ': the same state');
    // both play on: the same events and the same state, step by step, past the rule's next turn
    for (let i = 0; i < 20 * RATE; i++) {
      pks.pksStep(sim);
      pks.pksStep(run.sim);
      if (i % 30 === 0 || sim.status !== 'playing') same(what + ' step ' + i);
      if (sim.status !== 'playing') break;
    }
    same(what);
  }
});

test('packet-siege: the level-table hash: one per level, the same every time, stale when a level or a unit table changes', () => {
  const h = pks.pksRunHash(120);
  assert.match(h, /^[0-9a-f]{8}$/);
  assert.equal(pks.pksRunHash(120), h);
  assert.notEqual(pks.pksRunHash(121), h);
  const sim = playUntil(121, (s) => s.tick > 600);
  const raw = JSON.parse(pks.pksRunText(sim, CARDS));
  assert.ok(pks.pksParseRun(JSON.stringify(raw)));
  assert.equal(pks.pksParseRun(JSON.stringify(Object.assign({}, raw, { hash: 'deadbeef' }))), null, 'another version of the tables');
  // another copy of the game, loaded again: the same tables, the same hash
  assert.equal(loadScript(GAME + '/script.js').pksRunHash(120), h);
});

test('packet-siege: a snapshot that is not sound is null: every part is checked, and a sim that cannot step is refused', () => {
  const sim = playUntil(101, (s) => s.tick > 300);
  const good = JSON.parse(pks.pksRunText(sim, CARDS));
  const bad = (change) => {
    const raw = JSON.parse(JSON.stringify(good));
    change(raw);
    return pks.pksParseRun(JSON.stringify(raw));
  };
  assert.ok(bad(() => {}));
  for (const text of ['{', 'null', '5', '[]', '"run"', null]) assert.equal(pks.pksParseRun(text), null, String(text));
  const cases = [
    ['version', (r) => { r.v = 2; }], ['level 0', (r) => { r.n = 0; }], ['level 151', (r) => { r.n = 151; }],
    ['level 3.5', (r) => { r.n = 3.5; }], ['cards missing', (r) => { delete r.cards; }], ['no cards', (r) => { r.cards = []; }],
    ['too many cards', (r) => { r.cards = ALL.slice(0, 11); }], ['an unknown card', (r) => { r.cards[0] = 'nope'; }],
    ['a card twice', (r) => { r.cards[1] = r.cards[0]; }], ['a number for a card', (r) => { r.cards[0] = 7; }],
    ['an inherited name', (r) => { r.cards[0] = 'constructor'; }],
    ['no sim', (r) => { delete r.sim; }], ['another level', (r) => { r.sim.n = 102; }], ['over', (r) => { r.sim.status = 'won'; }],
    ['no stats', (r) => { delete r.sim.stats; }], ['stats not an object', (r) => { r.sim.stats = 5; }],
    ['no shots', (r) => { r.sim.shots = null; }], ['no shimmers', (r) => { delete r.sim.shimmers; }],
    ['a count lost', (r) => { r.sim.tick = null; }], ['a count as text', (r) => { r.sim.cycles = '9'; }],
    ['a count not finite', (r) => { r.sim.rng = 1e999; }],
    ['four breakers', (r) => { r.sim.breakers.pop(); }], ['a card short', (r) => { r.sim.cards.pop(); }],
    ['another card', (r) => { r.sim.cards[2].id = 'waf'; }], ['a card missing', (r) => { r.sim.cards[2] = null; }],
    ['a sim that throws', (r) => { r.sim.defenders = [null]; }]
  ];
  for (const [what, change] of cases) assert.equal(bad(change), null, what);
  assert.equal(JSON.stringify(sim).length > 0, true);
});

test('packet-siege: reading, writing and dropping the snapshot: one slot, never another tab\'s, never a throw', () => {
  const storage = createStorage();
  const sim = playUntil(91, (s) => s.tick > 120);
  const text = pks.pksRunText(sim, CARDS);
  assert.equal(pks.pksRunKey, 'pks-run');
  assert.equal(pks.pksRunEvery, 30);
  assert.deepEqual(pks.pksReadRun(storage), { text: null, run: null, ok: true, error: null, newer: 0 });
  // the first write expects an empty slot
  assert.deepEqual(pks.pksPutRun(storage, text, null), { ok: true, lost: false, error: null });
  let r = pks.pksReadRun(storage);
  assert.deepEqual([r.text, r.run.n, r.ok], [text, 91, true]);
  // the next one expects its own text; another tab's text there means the slot is lost
  pks.pksStep(sim);
  const next = pks.pksRunText(sim, CARDS);
  assert.equal(pks.pksPutRun(storage, next, text).ok, true);
  storage.setItem('pks-run', 'another tab');
  assert.deepEqual(pks.pksPutRun(storage, text, next), { ok: false, lost: true, error: null });
  assert.equal(storage.getItem('pks-run'), 'another tab', 'not overwritten');
  assert.equal(pks.pksPutRun(storage, text, null).lost, true, 'nor when this tab wrote nothing yet');
  // dropping: only what is expected, or anything without an expectation
  assert.equal(pks.pksDropRun(storage, next), true);
  assert.equal(storage.getItem('pks-run'), 'another tab', 'not another tab\'s');
  r = pks.pksReadRun(storage);
  assert.deepEqual([r.text, r.run], ['another tab', null], 'not sound: no run');
  assert.equal(pks.pksDropRun(storage, 'another tab'), true);
  assert.equal(storage.getItem('pks-run'), null);
  storage.setItem('pks-run', text);
  assert.equal(pks.pksDropRun(storage), true);
  assert.equal(storage.getItem('pks-run'), null, 'a start drops whatever is there');
  // blocked or full storage never throws
  const blocked = {
    getItem() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    setItem() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    removeItem() { throw new DOMException('The operation is insecure.', 'SecurityError'); }
  };
  r = pks.pksReadRun(blocked);
  assert.deepEqual([r.text, r.run, r.ok, r.error.name], [null, null, false, 'SecurityError']);
  const w = pks.pksPutRun(blocked, text, null);
  assert.deepEqual([w.ok, w.lost, w.error.name], [false, false, 'SecurityError']);
  assert.equal(pks.pksDropRun(blocked), false);
  const full = createStorage();
  full.setItem = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  assert.equal(pks.pksPutRun(full, text, null).error.name, 'QuotaExceededError');
  assert.equal(pks.pksPutRun(null, text, null).ok, false);
  assert.equal(pks.pksDropRun(null), false);
  assert.equal(pks.pksReadRun(null).ok, false);
});

test('packet-siege: a snapshot of a newer version is never offered, dropped or written over', () => {
  const storage = createStorage();
  const mine = pks.pksRunText(pks.pksNewSim(5, ['psu', 'firewall']), ['psu', 'firewall']);
  for (const text of ['{"v":2,"n":5}', '{"v":9,"whatever":true}']) {
    storage.setItem('pks-run', text);
    assert.deepEqual(pks.pksReadRun(storage), { text, run: null, ok: true, error: null, newer: JSON.parse(text).v }, text);
    assert.equal(pks.pksDropRun(storage), true, 'nothing refused');
    assert.equal(storage.getItem('pks-run'), text, 'not dropped by a level start');
    assert.equal(pks.pksDropRun(storage, text), true);
    assert.equal(storage.getItem('pks-run'), text, 'nor as the text read');
    assert.deepEqual(pks.pksPutRun(storage, mine, null), { ok: false, lost: true, error: null });
    assert.deepEqual(pks.pksPutRun(storage, mine, text), { ok: false, lost: true, error: null }, 'not even when expected');
    assert.equal(storage.getItem('pks-run'), text, 'never written over');
  }
  // not newer: an older, a non-whole or a broken version is any other unsound snapshot: dropped
  for (const text of ['{"v":0}', '{"v":1.5}', '{"v":"2"}', '{oops']) {
    storage.setItem('pks-run', text);
    assert.equal(pks.pksReadRun(storage).newer, 0, text);
    pks.pksDropRun(storage);
    assert.equal(storage.getItem('pks-run'), null, text);
  }
});

test('packet-siege: the storage part keeps to the rules: no DOM, clock or randomness, storage passed in', () => {
  const code = readRepoFile(GAME + '/src/storage.js').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /\bdocument\b|\bwindow\b|localStorage|Math\.random|Date\b|performance\./);
  assert.ok(readRepoFile(GAME + '/src/storage.js').split('\n').length < 900);
});
