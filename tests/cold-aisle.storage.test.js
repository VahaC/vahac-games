// tests/cold-aisle.storage.test.js
// The save of Cold Aisle (cda-state): the stored text pinned, every field's
// fallback, garbage and other versions, the merge between two tabs, blocked
// and full storage, recording wins, the patch arithmetic over the whole
// upgrade table, buying upgrades and the repairs of a damaged save.
//
// Upgrade costs and tier counts are read from CDA_UPGRADES, never written
// here: they are tuned elsewhere.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, blockStorage, resetStubs } = require('./_setup');

const cda = loadScript('cold-aisle/script.js');
const LINES = cda.CDA_UPGRADES;
const KEY = 'cda-state';

test.beforeEach(() => resetStubs());

// The cost of tiers 1..tiers of a line.
const costOf = (line, tiers) => line.costs.slice(0, tiers).reduce((a, b) => a + b, 0);
// The cost of every tier of every line.
const ALL_COST = LINES.reduce((sum, line) => sum + costOf(line, line.costs.length), 0);

function entry(over) {
  return Object.assign({ time: 300, kills: 10, enemies: 12, secrets: 1, secretsTotal: 2, patches: 15 }, over);
}

function result(over) {
  return Object.assign({ won: true, time: 300, kills: 10, enemies: 12, secrets: 1, secretsTotal: 2, patches: 15 }, over);
}

// A parsed save with `over` applied as raw fields (through the text).
function parse(over, levels) {
  return cda.cdaParseSave(JSON.stringify(Object.assign({ v: 1 }, over)), levels);
}

const PINNED = '{"v":1,"epoch":2,"unlocked":4,"best":[' +
  '{"time":312.5,"kills":14,"enemies":15,"secrets":1,"secretsTotal":2,"patches":17},' +
  '{"time":401.25,"kills":20,"enemies":20,"secrets":2,"secretsTotal":2,"patches":24},' +
  '{"time":288.125,"kills":9,"enemies":18,"secrets":0,"secretsTotal":3,"patches":10},' +
  'null,null,null,null,null,null],' +
  '"upgrades":{"' + LINES[0].id + '":2,"' + LINES[1].id + '":1},' +
  '"deaths":5,"playTime":1834.5,"ended":false,"settings":{"sens":1.5,"mute":true}}';

const FRESH = '{"v":1,"epoch":0,"unlocked":1,"best":[null,null,null,null,null,null,null,null,null],"upgrades":{},' +
  '"deaths":0,"playTime":0,"ended":false,"settings":{"sens":1,"mute":false}}';

// ── the format ─────────────────────────────────────────────────────────────

test('cold-aisle storage: the key, a new save and the stored text pinned, round trip byte for byte', () => {
  assert.equal(cda.CDA_SAVE_KEY, KEY);
  assert.equal(cda.CDA_SAVE_V, 1);
  assert.equal(cda.CDA_SAVE_LEVELS, 9);
  assert.deepEqual([cda.CDA_SENS_MIN, cda.CDA_SENS_MAX, cda.CDA_SENS_DEFAULT], [0.25, 3, 1]);
  assert.equal(cda.cdaSerialize(cda.cdaNewSave()), FRESH);
  // the pinned example must be affordable whatever the table costs
  assert.ok(17 + 24 + 10 >= costOf(LINES[0], 2) + costOf(LINES[1], 1), 'the pinned upgrades fit the patches earned');
  const save = cda.cdaParseSave(PINNED);
  assert.equal(cda.cdaSerialize(save), PINNED);
  assert.deepEqual(cda.cdaParseSave(cda.cdaSerialize(save)), save);
  assert.equal(save.epoch, 2);
  assert.equal(save.unlocked, 4);
  assert.equal(save.best[1].time, 401.25);
  // a save written before the epoch existed reads as epoch 0, its fields kept
  const old = cda.cdaParseSave(PINNED.replace('"epoch":2,', ''));
  assert.equal(old.epoch, 0);
  assert.equal(cda.cdaSerialize(old), PINNED.replace('"epoch":2', '"epoch":0'));
  assert.equal(save.best[3], null);
  assert.deepEqual(save.settings, { sens: 1.5, mute: true });
});

test('cold-aisle storage: the number of levels comes from the caller, 9 when it is missing or not a whole number', () => {
  assert.equal(cda.cdaNewSave(4).best.length, 4);
  for (const bad of [undefined, 0, -2, 2.5, '5', NaN, null]) assert.equal(cda.cdaNewSave(bad).best.length, 9, String(bad));
  const four = cda.cdaParseSave(PINNED, 4);
  assert.equal(four.best.length, 4);
  assert.deepEqual(four.best.slice(0, 3).map((b) => b.patches), [17, 24, 10]);
  assert.equal(four.unlocked, 4);
  const two = cda.cdaParseSave(PINNED, 2);
  assert.equal(two.best.length, 2);
  assert.equal(two.unlocked, 2, 'unlocked 4 is out of range for 2 levels; level 1 won opens 2');
  assert.equal(cda.cdaParseSave(FRESH, 12).best.length, 12);
});

test('cold-aisle storage: garbage, non-object JSON, missing and other-version saves are no save', () => {
  for (const text of [null, undefined, '', 'not json', '{', '[]', '[1]', '5', 'true', 'null', '"x"', '{}',
    '{"v":"1","unlocked":3}', '{"unlocked":3}', '{"v":0,"unlocked":3}', '{"v":1.5,"unlocked":3}', '{"v":2,"unlocked":3}']) {
    assert.equal(cda.cdaSerialize(cda.cdaParseSave(text)), FRESH, String(text));
  }
});

test('cold-aisle storage: every field falls back on its own', () => {
  const base = JSON.parse(PINNED);
  const with_ = (over) => cda.cdaParseSave(JSON.stringify(Object.assign({}, base, over)));
  const fine = with_({});
  // unlocked: whole 1..levels, and raised past every won level
  for (const bad of [0, 10, 3.5, '7', null, -1, true, 1e999]) {
    assert.equal(with_({ unlocked: bad, best: [] }).unlocked, 1, String(bad));
  }
  assert.equal(with_({ unlocked: 9, best: [] }).unlocked, 9);
  assert.equal(with_({ unlocked: 1 }).unlocked, 4, 'three won levels open the fourth');
  assert.equal(with_({ unlocked: 1, best: new Array(9).fill(entry()) }).unlocked, 9, 'never past the last level');
  // best: an array; an entry that is not an object was never won
  assert.deepEqual(with_({ best: 'lots' }).best, new Array(9).fill(null));
  assert.deepEqual(with_({ best: { 0: entry() } }).best, new Array(9).fill(null));
  assert.deepEqual(with_({ best: [5, 'x', [], null, true, entry()] }).best.slice(0, 6), [null, null, null, null, null, entry()]);
  assert.equal(with_({ best: new Array(12).fill(entry()) }).best.length, 9);
  // a best entry's fields: counts whole 0.., time a number above 0 (to the ms) or null
  const field = (over) => with_({ best: [entry(over)] }).best[0];
  for (const name of ['kills', 'enemies', 'secrets', 'secretsTotal', 'patches']) {
    for (const bad of [-1, 2.5, '3', null, true, 1e999, 1e10]) assert.equal(field({ [name]: bad })[name], 0, name + ' ' + bad);
    assert.equal(field({ [name]: 0 })[name], 0);
    assert.equal(field({ [name]: 7 })[name], 7);
    const missing = entry();
    delete missing[name];
    assert.equal(with_({ best: [missing] }).best[0][name], 0, name + ' missing');
  }
  for (const bad of [0, -5, '300', null, true, 1e999, 1e10]) assert.equal(field({ time: bad }).time, null, 'time ' + bad);
  assert.equal(field({ time: 61.23456 }).time, 61.235);
  const other = field({ kills: 'x' });
  assert.deepEqual([other.time, other.enemies, other.patches], [300, 12, 15], 'the other fields stay');
  // (NaN never survives JSON; the setters that take numbers directly are tested with it below)
  // upgrades: known lines, whole tiers 1..top, unknown ids dropped
  assert.deepEqual(with_({ upgrades: 'all' }).upgrades, {});
  assert.deepEqual(with_({ upgrades: [2, 2] }).upgrades, {});
  assert.deepEqual(with_({ upgrades: null }).upgrades, {});
  assert.deepEqual(with_({ upgrades: { [LINES[0].id]: 1, nope: 2, constructor: 1, [LINES[1].id]: 0, [LINES[2].id]: 1.5, [LINES[3].id]: '1', [LINES[4].id]: -1 } }).upgrades,
    { [LINES[0].id]: 1 });
  // deaths and epoch: whole 0..
  for (const bad of [-1, 2.5, '4', null, 1e999]) assert.equal(with_({ deaths: bad }).deaths, 0, String(bad));
  for (const bad of [-1, 2.5, '4', null, true, 1e999]) assert.equal(with_({ epoch: bad }).epoch, 0, String(bad));
  assert.equal(with_({ epoch: 7 }).epoch, 7);
  // playTime: a number 0..
  for (const bad of [-1, '40', null, true, 1e999]) assert.equal(with_({ playTime: bad }).playTime, 0, String(bad));
  assert.equal(with_({ playTime: 12.5 }).playTime, 12.5);
  // ended: true only
  for (const bad of [1, 'true', null]) assert.equal(with_({ ended: bad }).ended, false, String(bad));
  assert.equal(with_({ ended: true }).ended, true);
  // settings: an object; sens a number in range, mute true only
  assert.deepEqual(with_({ settings: 'loud' }).settings, { sens: 1, mute: false });
  assert.deepEqual(with_({ settings: [1.5, true] }).settings, { sens: 1, mute: false });
  for (const bad of [0.2, 3.5, -1, '1.5', null, 1e999]) assert.equal(with_({ settings: { sens: bad, mute: true } }).settings.sens, 1, String(bad));
  assert.equal(with_({ settings: { sens: 0.25 } }).settings.sens, 0.25);
  assert.equal(with_({ settings: { sens: 3 } }).settings.sens, 3);
  for (const bad of [1, 'true', null]) assert.equal(with_({ settings: { sens: 2, mute: bad } }).settings.mute, false, String(bad));
  // every field missing: the new save; and one broken field keeps the others
  assert.equal(cda.cdaSerialize(cda.cdaParseSave('{"v":1}')), FRESH);
  const one = with_({ deaths: 'many' });
  assert.deepEqual([one.unlocked, one.best, one.upgrades, one.playTime, one.settings], [fine.unlocked, fine.best, fine.upgrades, fine.playTime, fine.settings]);
});

// ── repairs ────────────────────────────────────────────────────────────────

test('cold-aisle storage: repairs on load: tiers above the top are cut, and upgrades the patches do not pay for are dropped in table order', () => {
  const rich = [entry({ patches: ALL_COST + 50 })];
  // a tier above the top is cut to the top tier
  const over = {};
  for (const line of LINES) over[line.id] = line.costs.length + 3;
  const top = parse({ best: rich, upgrades: over });
  for (const line of LINES) assert.equal(top.upgrades[line.id], line.costs.length, line.id);
  assert.equal(cda.cdaPatchesSpent(top), ALL_COST);
  assert.equal(cda.cdaPatchBalance(top), 50);
  // nothing earned: every upgrade dropped
  assert.deepEqual(parse({ best: [], upgrades: over }).upgrades, {});
  // just enough for line 0 complete and line 1's first tier: the rest is refunded
  const a = LINES[0];
  const b = LINES[1];
  const earned = costOf(a, a.costs.length) + costOf(b, 1);
  const cut = parse({ best: [entry({ patches: earned })], upgrades: over });
  assert.deepEqual(cut.upgrades, { [a.id]: a.costs.length, [b.id]: 1 });
  assert.equal(cda.cdaPatchBalance(cut), 0);
  // the first tier that does not fit ends its line; a cheaper tier of a later line still fits
  assert.ok(a.costs[1] > b.costs[0], 'precondition: a second tier costs more than a first tier');
  const lean = parse({ best: [entry({ patches: costOf(a, 1) + costOf(b, 1) })], upgrades: { [a.id]: 2, [b.id]: 1 } });
  assert.deepEqual(lean.upgrades, { [a.id]: 1, [b.id]: 1 });
  assert.equal(cda.cdaPatchBalance(lean), 0);
  // a save that pays exactly is untouched
  const exact = parse({ best: [entry({ patches: ALL_COST })], upgrades: over });
  assert.equal(cda.cdaPatchesSpent(exact), ALL_COST);
  assert.equal(cda.cdaPatchBalance(exact), 0);
  // one patch short: the last line loses its top tier only
  const short = parse({ best: [entry({ patches: ALL_COST - 1 })], upgrades: over });
  const last = LINES[LINES.length - 1];
  assert.equal(short.upgrades[last.id], last.costs.length - 1);
  assert.equal(cda.cdaPatchesSpent(short), ALL_COST - last.costs[last.costs.length - 1]);
});

// ── reading and writing ────────────────────────────────────────────────────

test('cold-aisle storage: reading: no save, a save, a newer version, blocked storage and no storage', () => {
  assert.deepEqual(cda.cdaReadSave(), { state: cda.cdaNewSave(), ok: true, error: null, newer: 0 });
  localStorage.setItem(KEY, PINNED);
  const r = cda.cdaReadSave();
  assert.equal(cda.cdaSerialize(r.state), PINNED);
  assert.equal(r.ok, true);
  assert.equal(cda.cdaReadSave(5).state.best.length, 5);
  localStorage.setItem(KEY, 'garbage');
  assert.deepEqual(cda.cdaReadSave(), { state: cda.cdaNewSave(), ok: true, error: null, newer: 0 });
  for (const text of ['{"v":2,"unlocked":9}', '{"v":7}']) {
    localStorage.setItem(KEY, text);
    assert.deepEqual(cda.cdaReadSave(), { state: cda.cdaNewSave(), ok: false, error: null, newer: JSON.parse(text).v }, text);
  }
  for (const text of ['{"v":2.5}', '[2]', '{"v":"2"}', '{"v":1e999}']) {
    localStorage.setItem(KEY, text);
    assert.equal(cda.cdaReadSave().newer, 0, text);
  }
  localStorage.setItem(KEY, PINNED);
  const restore = blockStorage('access');
  const blocked = cda.cdaReadSave(3);
  assert.deepEqual([blocked.ok, blocked.error.name, blocked.newer, blocked.state], [false, 'SecurityError', 0, cda.cdaNewSave(3)]);
  restore();
  blockStorage('getItem');
  assert.equal(cda.cdaReadSave().error.name, 'SecurityError');
  resetStubs();
  const saved = globalThis.localStorage;
  try {
    delete globalThis.localStorage;
    const none = cda.cdaReadSave();
    assert.deepEqual([none.ok, none.error instanceof ReferenceError], [false, true]);
    const w = cda.cdaWriteSave(cda.cdaNewSave());
    assert.deepEqual([w.ok, w.error instanceof ReferenceError], [false, true]);
  } finally {
    globalThis.localStorage = saved;
  }
});

test('cold-aisle storage: writing stores the text, re-reads and merges a second tab, and the save passed in takes the merged state', () => {
  const mine = cda.cdaNewSave();
  cda.cdaRecordWin(mine, 1, result());
  cda.cdaSetSens(mine, 2);
  let w = cda.cdaWriteSave(mine);
  assert.deepEqual([w.ok, w.error, w.newer, w.state === mine], [true, null, 0, true]);
  assert.equal(localStorage.getItem(KEY), cda.cdaSerialize(mine));
  // another tab won level 2 meanwhile
  const other = cda.cdaParseSave(localStorage.getItem(KEY));
  cda.cdaRecordWin(other, 2, result({ patches: 30 }));
  cda.cdaRecordDeath(other);
  cda.cdaSetMute(other, true);
  cda.cdaWriteSave(other);
  cda.cdaAddPlayTime(mine, 5);
  w = cda.cdaWriteSave(mine);
  assert.equal(w.ok, true);
  assert.equal(mine.unlocked, 3);
  assert.equal(mine.best[1].patches, 30);
  assert.equal(mine.deaths, 1);
  assert.equal(mine.playTime, 5);
  assert.deepEqual(mine.settings, { sens: 2, mute: false }, 'the settings of the writer');
  assert.equal(localStorage.getItem(KEY), cda.cdaSerialize(mine));
});

test('cold-aisle storage: the merge between two tabs, field by field, changes neither and shares nothing', () => {
  const a = cda.cdaNewSave();
  const b = cda.cdaNewSave();
  a.unlocked = 3;
  b.unlocked = 5;
  a.best[0] = entry({ time: 200, kills: 8, enemies: 12, secrets: 2, secretsTotal: 2, patches: 11 });
  b.best[0] = entry({ time: 250, kills: 12, enemies: 12, secrets: 1, secretsTotal: 3, patches: 14 });
  a.best[1] = entry({ time: null, patches: 3 });
  b.best[1] = entry({ time: 90, patches: 2 });
  b.best[2] = entry({ time: 120, patches: 4 });
  a.best[3] = entry({ time: 80, patches: 5 });
  b.best[3] = entry({ time: null, patches: 5 });
  a.upgrades = { [LINES[0].id]: 2, [LINES[1].id]: 1 };
  b.upgrades = { [LINES[0].id]: 1, [LINES[2].id]: 1 };
  a.deaths = 4;
  b.deaths = 2;
  a.playTime = 100;
  b.playTime = 300;
  b.ended = true;
  a.settings = { sens: 0.5, mute: true };
  b.settings = { sens: 2.5, mute: false };
  const copyA = JSON.stringify(a);
  const copyB = JSON.stringify(b);
  const m = cda.cdaMergeSaves(a, b);
  assert.equal(m.unlocked, 5);
  assert.deepEqual(m.best[0], { time: 200, kills: 12, enemies: 12, secrets: 2, secretsTotal: 3, patches: 14 });
  assert.equal(m.best[1].time, 90, 'a known time beats an unknown one');
  assert.equal(m.best[1].patches, 3);
  assert.deepEqual(m.best[2], b.best[2]);
  assert.notEqual(m.best[2], b.best[2], 'a copy');
  assert.equal(m.best[3].time, 80);
  assert.equal(m.best[4], null);
  assert.deepEqual(m.upgrades, { [LINES[0].id]: 2, [LINES[1].id]: 1, [LINES[2].id]: 1 });
  assert.deepEqual([m.deaths, m.playTime, m.ended], [4, 300, true]);
  assert.deepEqual(m.settings, { sens: 0.5, mute: true });
  assert.notEqual(m.settings, a.settings);
  assert.equal(cda.cdaMergeSaves(b, a).ended, true, 'ended if either');
  assert.equal(cda.cdaMergeSaves(a, a).ended, false);
  assert.equal(JSON.stringify(a), copyA);
  assert.equal(JSON.stringify(b), copyB);
  // both tabs spent the same patches: the merge repairs what they cannot pay for
  const x = cda.cdaNewSave();
  x.best[0] = entry({ patches: costOf(LINES[0], LINES[0].costs.length) });
  const y = cda.cdaParseSave(cda.cdaSerialize(x));
  while (cda.cdaBuyUpgrade(x, LINES[0].id));
  while (cda.cdaBuyUpgrade(y, LINES[1].id) || cda.cdaBuyUpgrade(y, LINES[2].id));
  assert.equal(cda.cdaPatchBalance(x), 0);
  const both = cda.cdaMergeSaves(y, x);
  assert.ok(cda.cdaPatchesSpent(both) <= cda.cdaPatchesEarned(both));
  assert.deepEqual(both.upgrades, { [LINES[0].id]: LINES[0].costs.length }, 'kept in table order');
  assert.equal(cda.cdaPatchBalance(both), 0);
  // saves of different lengths: the levels of `mine`
  assert.equal(cda.cdaMergeSaves(cda.cdaNewSave(3), cda.cdaNewSave(2)).best.length, 3);
  assert.equal(m.epoch, 0, 'the same epoch merges and keeps it');
});

test('cold-aisle storage: a New game (a higher epoch) wins outright over an older save, both ways, through a write and a second tab', () => {
  const old = cda.cdaNewSave();
  cda.cdaRecordWin(old, 1, result());
  cda.cdaRecordWin(old, 2, result());
  cda.cdaRecordDeath(old);
  old.upgrades = { [LINES[0].id]: 1 };
  cda.cdaSetSens(old, 2);
  const fresh = cda.cdaNewSave();
  fresh.epoch = 1;
  cda.cdaSetMute(fresh, true);
  const copyOld = JSON.stringify(old);
  // the erase stored, the old tab writes its progress: the erase stays, the writer's settings
  const m = cda.cdaMergeSaves(old, fresh);
  assert.equal(m.epoch, 1);
  assert.deepEqual([m.unlocked, m.best, m.upgrades, m.deaths], [1, new Array(9).fill(null), {}, 0]);
  assert.deepEqual(m.settings, { sens: 2, mute: false });
  assert.notEqual(m.settings, old.settings);
  assert.equal(JSON.stringify(old), copyOld, 'neither is changed');
  // the tab that erased writes over the old save: its own fresh state
  const n = cda.cdaMergeSaves(fresh, old);
  assert.equal(cda.cdaSerialize(n), cda.cdaSerialize(fresh));
  assert.notEqual(n, fresh);
  // through localStorage: the old save stored, the erase written, then the old tab writes again
  localStorage.setItem(KEY, cda.cdaSerialize(old));
  assert.equal(cda.cdaWriteSave(fresh).ok, true);
  assert.equal(cda.cdaParseSave(localStorage.getItem(KEY)).unlocked, 1);
  const stale = cda.cdaParseSave(copyOld);
  cda.cdaAddPlayTime(stale, 30);
  cda.cdaWriteSave(stale);
  assert.equal(stale.epoch, 1, 'the old tab takes the erase');
  assert.deepEqual([stale.unlocked, stale.deaths, stale.playTime], [1, 0, 0]);
  assert.equal(localStorage.getItem(KEY), cda.cdaSerialize(stale));
  // a winner with fewer levels than mine: the levels of `mine`
  const short = cda.cdaNewSave(2);
  short.epoch = 3;
  assert.equal(cda.cdaMergeSaves(cda.cdaNewSave(4), short).best.length, 4);
});

test('cold-aisle storage: blocked or full storage is reported, never thrown; a newer save is never written over', () => {
  const mine = cda.cdaNewSave();
  cda.cdaRecordWin(mine, 1, result());
  // full: the write fails, the read still merged
  const other = cda.cdaNewSave();
  cda.cdaRecordWin(other, 1, result());
  cda.cdaRecordWin(other, 2, result());
  localStorage.setItem(KEY, cda.cdaSerialize(other));
  let restore = blockStorage('full');
  let w = cda.cdaWriteSave(mine);
  assert.deepEqual([w.ok, w.error.name, w.newer, mine.unlocked], [false, 'QuotaExceededError', 0, 3]);
  restore();
  // access blocked
  restore = blockStorage('access');
  w = cda.cdaWriteSave(cda.cdaNewSave());
  assert.deepEqual([w.ok, w.error.name], [false, 'SecurityError']);
  restore();
  // setItem alone blocked
  restore = blockStorage('setItem');
  w = cda.cdaWriteSave(mine);
  assert.deepEqual([w.ok, w.error.name], [false, 'SecurityError']);
  restore();
  // getItem alone blocked: nothing to merge with, the write goes through
  restore = blockStorage('getItem');
  const lone = cda.cdaNewSave();
  w = cda.cdaWriteSave(lone);
  assert.deepEqual([w.ok, w.error], [true, null]);
  restore();
  assert.equal(localStorage.getItem(KEY), FRESH);
  // a newer version: read as a new save, merged, never written over
  localStorage.setItem(KEY, '{"v":3,"whatever":1}');
  w = cda.cdaWriteSave(mine);
  assert.deepEqual([w.ok, w.error, w.newer, w.state === mine], [false, null, 3, true]);
  assert.equal(localStorage.getItem(KEY), '{"v":3,"whatever":1}');
  assert.equal(mine.unlocked, 3, 'progress kept in memory');
});

// ── wins ───────────────────────────────────────────────────────────────────

test('cold-aisle storage: record win: a first win, a better and a worse replay, the last level', () => {
  const save = cda.cdaNewSave();
  let r = cda.cdaRecordWin(save, 1, result({ time: 300.0004, kills: 10, enemies: 12, secrets: 1, secretsTotal: 2, patches: 15 }));
  assert.deepEqual(r, {
    best: { time: 300, kills: 10, enemies: 12, secrets: 1, secretsTotal: 2, patches: 15 }, first: true, newTime: true,
    patches: 15, unlocked: 2, finished: false
  });
  assert.equal(r.best, save.best[0]);
  assert.equal(save.unlocked, 2);
  assert.equal(cda.cdaPatchesEarned(save), 15);
  // a better replay: faster, more kills, more patches; only the difference is new
  r = cda.cdaRecordWin(save, 1, result({ time: 250, kills: 12, secrets: 0, patches: 18 }));
  assert.deepEqual([r.first, r.newTime, r.patches, r.unlocked, r.finished], [false, true, 3, null, false]);
  assert.deepEqual(save.best[0], { time: 250, kills: 12, enemies: 12, secrets: 1, secretsTotal: 2, patches: 18 });
  assert.equal(cda.cdaPatchesEarned(save), 18);
  // a worse replay changes nothing
  r = cda.cdaRecordWin(save, 1, result({ time: 400, kills: 3, secrets: 0, patches: 4 }));
  assert.deepEqual([r.first, r.newTime, r.patches, r.unlocked], [false, false, 0, null]);
  assert.equal(save.best[0].time, 250);
  // the same time again is not a new time
  assert.equal(cda.cdaRecordWin(save, 1, result({ time: 250 })).newTime, false);
  // a replay of an earlier level once later ones are open opens nothing
  save.unlocked = 5;
  assert.equal(cda.cdaRecordWin(save, 2, result()).unlocked, null);
  // an entry whose time was lost gets one back
  save.best[2] = entry({ time: null });
  assert.equal(cda.cdaRecordWin(save, 3, result({ time: 500 })).newTime, true);
  // a result without a usable time keeps a first win's time unknown
  const odd = cda.cdaNewSave(2);
  assert.equal(cda.cdaRecordWin(odd, 1, result({ time: 0 })).best.time, null);
  // the last level: finished, nothing past it opens
  const end = cda.cdaNewSave(3);
  end.unlocked = 3;
  r = cda.cdaRecordWin(end, 3, result());
  assert.deepEqual([r.first, r.unlocked, r.finished, end.unlocked], [true, null, true, 3]);
  assert.equal(cda.cdaNewSave().best.length, 9);
  const nine = cda.cdaNewSave();
  nine.unlocked = 9;
  assert.equal(cda.cdaRecordWin(nine, 9, result()).finished, true);
  // the save's levels decide the last one
  const two = cda.cdaNewSave(2);
  r = cda.cdaRecordWin(two, 1, result());
  assert.deepEqual([r.unlocked, r.finished], [2, false]);
  assert.equal(cda.cdaRecordWin(two, 2, result()).finished, true);
});

test('cold-aisle storage: a win recorded from a real cdaResult shape', () => {
  const save = cda.cdaNewSave();
  const res = { won: true, time: 1234 * cda.CDA_STEP, kills: 3, enemies: 5, secrets: 0, secretsTotal: 1, patches: 4 };
  const r = cda.cdaRecordWin(save, 1, res);
  assert.equal(r.best.time, Math.round(res.time * 1000) / 1000);
  assert.equal(cda.cdaSerialize(cda.cdaParseSave(cda.cdaSerialize(save))), cda.cdaSerialize(save));
});

// ── patches and upgrades ───────────────────────────────────────────────────

test('cold-aisle storage: patch arithmetic and buying every tier of the whole upgrade table', () => {
  const save = cda.cdaNewSave();
  assert.deepEqual([cda.cdaPatchesEarned(save), cda.cdaPatchesSpent(save), cda.cdaPatchBalance(save)], [0, 0, 0]);
  // earned: the sum of the best patches per level
  save.best[0] = entry({ patches: ALL_COST - 7 });
  save.best[4] = entry({ patches: 7 });
  assert.equal(cda.cdaPatchesEarned(save), ALL_COST);
  // buy every line to its top tier, checking each next tier and cost against the table
  let spent = 0;
  for (const line of LINES) {
    for (let t = 0; t < line.costs.length; t++) {
      assert.deepEqual(cda.cdaUpgradeNext(save, line.id), { id: line.id, tier: t + 1, cost: line.costs[t] });
      assert.equal(cda.cdaBuyUpgrade(save, line.id), true, line.id + ' tier ' + (t + 1));
      spent += line.costs[t];
      assert.equal(save.upgrades[line.id], t + 1);
      assert.equal(cda.cdaPatchesSpent(save), spent);
      assert.equal(cda.cdaPatchBalance(save), ALL_COST - spent);
    }
    assert.equal(cda.cdaUpgradeNext(save, line.id), null, line.id + ' at the top tier');
    assert.equal(cda.cdaBuyUpgrade(save, line.id), false);
  }
  assert.equal(spent, ALL_COST);
  assert.equal(cda.cdaPatchBalance(save), 0);
  // the stored text keeps the tiers, in table order
  const back = cda.cdaParseSave(cda.cdaSerialize(save));
  assert.deepEqual(Object.keys(back.upgrades), LINES.map((l) => l.id));
  assert.equal(cda.cdaPatchesSpent(back), ALL_COST);
  // the balance is never shown below 0
  save.best[4] = null;
  assert.equal(cda.cdaPatchBalance(save), 0);
  assert.equal(cda.cdaPatchesEarned(save) - cda.cdaPatchesSpent(save), -7);
  // an id that is not a line
  assert.equal(cda.cdaUpgradeNext(save, 'nope'), null);
  assert.equal(cda.cdaBuyUpgrade(save, 'nope'), false);
});

test('cold-aisle storage: buying is refused when the balance is short and allowed once it is enough', () => {
  const line = LINES[0];
  const save = cda.cdaNewSave();
  assert.equal(cda.cdaBuyUpgrade(save, line.id), false, 'nothing earned');
  assert.deepEqual(save.upgrades, {});
  save.best[0] = entry({ patches: line.costs[0] - 1 });
  assert.equal(cda.cdaBuyUpgrade(save, line.id), false, 'one patch short');
  assert.deepEqual(save.upgrades, {});
  save.best[0].patches = line.costs[0];
  assert.equal(cda.cdaBuyUpgrade(save, line.id), true, 'exactly enough');
  assert.equal(cda.cdaPatchBalance(save), 0);
  assert.equal(cda.cdaBuyUpgrade(save, line.id), false);
  assert.equal(save.upgrades[line.id], 1);
});

// ── the small setters ──────────────────────────────────────────────────────

test('cold-aisle storage: deaths, play time, sensitivity (clamped), mute and the end of the episode', () => {
  const save = cda.cdaNewSave();
  cda.cdaRecordDeath(save);
  cda.cdaRecordDeath(save);
  assert.equal(save.deaths, 2);
  cda.cdaAddPlayTime(save, 1 / 120);
  cda.cdaAddPlayTime(save, 10.5);
  assert.equal(save.playTime, 10.508);
  for (const bad of [-1, NaN, '5', null, undefined, Infinity]) cda.cdaAddPlayTime(save, bad);
  assert.equal(save.playTime, 10.508);
  cda.cdaAddPlayTime(save, 0);
  assert.equal(save.playTime, 10.508);
  assert.equal(cda.cdaSetSens(save, 1.75), 1.75);
  assert.equal(cda.cdaSetSens(save, 0.01), cda.CDA_SENS_MIN);
  assert.equal(cda.cdaSetSens(save, 99), cda.CDA_SENS_MAX);
  assert.equal(cda.cdaSetSens(save, -Infinity), cda.CDA_SENS_MIN);
  for (const bad of [NaN, '2', null, undefined]) assert.equal(cda.cdaSetSens(save, bad), cda.CDA_SENS_MIN, String(bad));
  cda.cdaSetMute(save, 1);
  assert.equal(save.settings.mute, true);
  cda.cdaSetMute(save, 0);
  assert.equal(save.settings.mute, false);
  assert.equal(save.ended, false);
  cda.cdaMarkEnded(save);
  assert.equal(save.ended, true);
  const back = cda.cdaParseSave(cda.cdaSerialize(save));
  assert.deepEqual([back.deaths, back.playTime, back.ended, back.settings], [2, 10.508, true, { sens: cda.CDA_SENS_MIN, mute: false }]);
});
