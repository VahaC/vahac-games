// tests/hash-cracker.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  createEvent, keyEvent, fire, pressKey, focusElement, listenerCount, readRepoFile,
  idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'hash-cracker';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

const STATE_KEY = 'hcr-state';
const STATS_KEY = 'hcr-stats';
const HEX = '0123456789ABCDEF';
const MODES = {
  easy: { symbols: '0123456789', length: 4, distinct: true },
  normal: { symbols: HEX, length: 4, distinct: true },
  hard: { symbols: HEX, length: 5, distinct: false }
};
const BUDGET = 60000;
const NOT_COUNTED = '  └ keys left: too many to count live (over 60,000 search steps)';
const BLOCKED = 'Storage is blocked: progress will not be saved';

// A save in the format the first version writes (a Normal game, two
// attempts made, 9B typed), embedded literally.
const FORMAT_SAVE = '{"mode":"normal","secret":"3A7F","guesses":["0123","4567"],"input":"9B"}';

test.beforeEach(() => resetStubs());

// ── An independent model of the rules ────────────────────────────────────────

// HIT and NEAR the way a player counts them: first every symbol in its right
// place, then each remaining guess symbol paired with one unused copy in the key.
function refScore(secret, guess) {
  const key = secret.split('');
  const rest = guess.split('');
  let hit = 0;
  for (let i = 0; i < key.length; i++) {
    if (key[i] === rest[i]) {
      hit++;
      key[i] = null;
      rest[i] = undefined;
    }
  }
  let near = 0;
  for (const symbol of rest) {
    if (symbol === undefined) continue;
    const at = key.indexOf(symbol);
    if (at !== -1) {
      near++;
      key[at] = null;
    }
  }
  return { hit, near };
}

// Every code over symbols of a length, with or without repeats, in symbol order.
function enumerate(symbols, length, distinct) {
  const out = [];
  (function grow(prefix) {
    if (prefix.length === length) {
      out.push(prefix);
      return;
    }
    for (const symbol of symbols) {
      if (!distinct || !prefix.includes(symbol)) grow(prefix + symbol);
    }
  })('');
  return out;
}

const history = (secret, guesses) => guesses.map((guess) => ({ guess, ...refScore(secret, guess) }));
const consistent = (code, entries) => entries.every((e) => {
  const s = refScore(code, e.guess);
  return s.hit === e.hit && s.near === e.near;
});
const permutations = (n, k) => (k === 0 ? 1 : n * permutations(n - 1, k - 1));
const log2 = (n) => Math.log2(n).toFixed(2);

// ── Pages ────────────────────────────────────────────────────────────────────

function fakeTimers(t) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
}

function writeStorage({ state, stats } = {}) {
  if (state !== undefined) localStorage.setItem(STATE_KEY, typeof state === 'string' ? state : JSON.stringify(state));
  if (stats !== undefined) localStorage.setItem(STATS_KEY, typeof stats === 'string' ? stats : JSON.stringify(stats));
}

// What a player sees and does.
function pageView(els, extra) {
  const keypad = els['hcr-keypad'];
  const toast = els['hcr-toast'];
  const v = {
    els,
    text: (id) => els[id].textContent,
    log: () => els['hcr-log'].children.map((line) => line.textContent),
    lines: () => els['hcr-log'].children,
    prompt: () => els['hcr-prompt'].textContent,
    status: () => els['hcr-status'].textContent,
    warning: () => (els['hcr-warning'].classList.contains('hcr-visible') ? els['hcr-warning'].textContent : null),
    keys: () => keypad.children,
    key: (name) => keypad.children.find((b) => b.getAttribute('data-hcr-key') === name),
    tap: (...names) => names.forEach((name) => v.key(name).click()),
    type: (text) => [...text].forEach((ch) => pressKey(ch)),
    crack: (text) => {
      v.type(text);
      return pressKey('Enter');
    },
    toast: () => (toast.classList.contains('hcr-show') ? toast.textContent : null),
    saved: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    savedStats: () => JSON.parse(localStorage.getItem(STATS_KEY)),
    stats: () => ['hcr-attempts', 'hcr-keys', 'hcr-bits', 'hcr-streak', 'hcr-best', 'hcr-record'].map((id) => els[id].textContent),
    newGame: () => els['hcr-new-game'].click(),
    mode: (name) => els['hcr-mode-' + name].click(),
    disabled: () => keypad.children.filter((b) => b.disabled).map((b) => b.getAttribute('data-hcr-key'))
  };
  return Object.assign(v, extra);
}

function bootPage(storage, options) {
  writeStorage(storage);
  const b = bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options);
  return pageView(b.els, { page: b.page, ready: b.ready, restore: b.restore });
}

// The page as a browser loads it, after writing storage.
function openPage(t, storage, options) {
  fakeTimers(t);
  return bootPage(storage, options);
}

// A reload: the old page and its timers go away, storage stays.
function reload(t, view) {
  fakeTimers(t);
  view.restore();
  return bootPage();
}

const game = (mode, secret, guesses = [], input = '') => ({ mode, secret, guesses, input });
const record = (wins = 0, losses = 0, streak = 0, best = 0) => ({ wins, losses, streak, best });
const freshStats = () => ({ easy: record(), normal: record(), hard: record() });

const px = (value, base = 16) => {
  const m = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(String(value).trim());
  assert.ok(m, 'a px or rem length: ' + value);
  return Number(m[1]) * (m[2] === 'rem' ? base : 1);
};

// ── Keys and scoring ─────────────────────────────────────────────────────────

test('hash-cracker: the three modes, their key-space sizes and the full key lists of Easy and Normal', () => {
  const hcr = loadScript(SCRIPT);
  for (const [mode, spec] of Object.entries(MODES)) {
    const m = hcr.hcrModes[mode];
    assert.deepEqual({ symbols: m.symbols, length: m.length, distinct: m.distinct }, spec, mode);
  }
  assert.equal(hcr.hcrMaxAttempts, 10);
  assert.equal(hcr.hcrSearchBudget, BUDGET);
  // 10*9*8*7, 16*15*14*13 and 16^5, as the spec gives them.
  assert.equal(hcr.hcrKeySpaceSize('easy'), 5040);
  assert.equal(hcr.hcrKeySpaceSize('normal'), 43680);
  assert.equal(hcr.hcrKeySpaceSize('hard'), 1048576);
  assert.equal(hcr.hcrKeySpaceSize('hard'), Math.pow(16, 5));
  for (const mode of ['easy', 'normal']) {
    const { symbols, length } = MODES[mode];
    const codes = hcr.hcrAllCodes(mode);
    assert.equal(codes.length, permutations(symbols.length, length), mode);
    assert.deepEqual(codes, enumerate(symbols, length, true), mode + ': every key once, in symbol order');
    assert.equal(hcr.hcrAllCodes(mode), codes, mode + ': built once');
  }
  assert.equal(hcr.hcrAllCodes('hard'), null, 'the million Hard keys are never listed');
});

test('hash-cracker: a new key has the mode\'s length and symbols, distinct where the mode wants it, from one draw per symbol', (t) => {
  const hcr = loadScript(SCRIPT);
  for (const [mode, spec] of Object.entries(MODES)) {
    let repeats = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = seeded(seed);
      let draws = 0;
      const key = hcr.hcrMakeSecret(mode, () => { draws++; return rnd(); });
      assert.equal(key.length, spec.length, mode);
      assert.equal(draws, spec.length, mode + ': one draw per symbol');
      for (const ch of key) assert.ok(spec.symbols.includes(ch), mode + ' ' + key);
      if (new Set(key).size < key.length) repeats++;
      assert.equal(hcr.hcrIsValidGuess(key, mode), true, mode + ' ' + key);
    }
    if (spec.distinct) assert.equal(repeats, 0, mode + ' never repeats a symbol');
    else assert.ok(repeats > 100, 'Hard repeats symbols (about 48% of keys): ' + repeats);
  }
  // Draws of 0 take the symbols in order; draws just below 1 the last free one;
  // a broken random source that returns 1 still stays inside the alphabet.
  assert.equal(hcr.hcrMakeSecret('easy', () => 0), '0123');
  assert.equal(hcr.hcrMakeSecret('normal', () => 0), '0123');
  assert.equal(hcr.hcrMakeSecret('hard', () => 0), '00000');
  assert.equal(hcr.hcrMakeSecret('easy', () => 0.9999999), '9012');
  assert.equal(hcr.hcrMakeSecret('normal', () => 0.9999999), 'F012');
  assert.equal(hcr.hcrMakeSecret('hard', () => 0.9999999), 'FFFFF');
  assert.equal(hcr.hcrMakeSecret('hard', () => 1), 'FFFFF');
  assert.equal(hcr.hcrMakeSecret('easy', () => 1), '9012');
  // Every symbol shows up in every position over many keys (no dead spots).
  const random = t.mock.method(Math, 'random', seeded(42));
  const seen = Array.from({ length: 4 }, () => new Set());
  for (let i = 0; i < 400; i++) [...hcr.hcrMakeSecret('normal', Math.random)].forEach((ch, at) => seen[at].add(ch));
  for (const set of seen) assert.equal(set.size, 16);
  assert.equal(random.mock.callCount(), 1600);
});

test('hash-cracker: HIT and NEAR match an independent count on hand-picked and random keys, repeats included', () => {
  const hcr = loadScript(SCRIPT);
  const cases = [
    ['1234', '1234', 4, 0], ['1234', '4321', 0, 4], ['1234', '5678', 0, 0], ['1234', '1243', 2, 2],
    ['3A7F', '0123', 0, 1], ['3A7F', 'A3F7', 0, 4], ['3A7F', '3A70', 3, 0],
    // Repeats count once per copy in both codes: the sum of the smaller counts, minus HIT.
    ['AAAB0', 'AAAAA', 3, 0], ['AAAB0', '0AAAA', 2, 2], ['11223', '33211', 1, 3], ['12345', '11111', 1, 0],
    ['FFFFF', 'FFFFF', 5, 0], ['ABCDE', 'EEEEE', 1, 0], ['AABBC', 'ABABA', 2, 2], ['00110', '11001', 0, 4]
  ];
  for (const [secret, guess, hit, near] of cases) {
    assert.deepEqual(hcr.hcrScore(secret, guess), { hit, near }, secret + ' vs ' + guess);
    assert.deepEqual(refScore(secret, guess), { hit, near }, 'the model agrees: ' + secret + ' vs ' + guess);
    assert.deepEqual(hcr.hcrScore(guess, secret), { hit, near }, 'the score is symmetric');
  }
  const rnd = seeded(5);
  for (let i = 0; i < 2000; i++) {
    const mode = ['easy', 'normal', 'hard'][i % 3];
    const secret = hcr.hcrMakeSecret(mode, rnd);
    const guess = hcr.hcrMakeSecret(mode, rnd);
    assert.deepEqual(hcr.hcrScore(secret, guess), refScore(secret, guess), mode + ' ' + secret + ' vs ' + guess);
  }
});

test('hash-cracker: a guess is a full key of the mode, and every refusal names the values involved', () => {
  const hcr = loadScript(SCRIPT);
  const ok = { easy: ['0123', '9876'], normal: ['3A7F', 'FEDC', '0A1B'], hard: ['00000', 'A0A0A', 'FFFF0'] };
  for (const [mode, list] of Object.entries(ok)) {
    for (const guess of list) {
      assert.equal(hcr.hcrGuessError(guess, mode), '', mode + ' ' + guess);
      assert.equal(hcr.hcrIsValidGuess(guess, mode), true, mode + ' ' + guess);
    }
  }
  const refused = [
    ['', 'easy', 'Type a key first: 4 different digits (0-9)'],
    ['', 'hard', 'Type a key first: 5 hex symbols (0-F)'],
    ['12A4', 'easy', 'A is not allowed: Easy keys use 0-9'],
    ['3a7f', 'normal', 'a is not allowed: Normal keys use 0-F'],
    ['1213', 'easy', '1 repeats in 1213: Easy keys use 4 different digits (0-9)'],
    ['AA7F', 'normal', 'A repeats in AA7F: Normal keys use 4 different hex symbols (0-F)'],
    ['3A7', 'normal', '3A7 is too short: Normal keys use 4 different hex symbols (0-F)'],
    ['01234', 'easy', '01234 is too long: Easy keys use 4 different digits (0-9)'],
    ['A0A0', 'hard', 'A0A0 is too short: Hard keys use 5 hex symbols (0-F)'],
    ['A0A0A0', 'hard', 'A0A0A0 is too long: Hard keys use 5 hex symbols (0-F)'],
    ['A0 0A', 'hard', '  is not allowed: Hard keys use 0-F']
  ];
  for (const [guess, mode, message] of refused) {
    assert.equal(hcr.hcrGuessError(guess, mode), message, mode + ' ' + JSON.stringify(guess));
    assert.equal(hcr.hcrIsValidGuess(guess, mode), false);
  }
  for (const value of [null, undefined, 1234, ['0123'], { length: 4 }]) {
    assert.equal(hcr.hcrIsValidGuess(value, 'easy'), false, String(value));
  }

  // Typing one more symbol.
  assert.equal(hcr.hcrTypeError('', '7', 'easy'), '');
  assert.equal(hcr.hcrTypeError('12', 'A', 'easy'), 'A is not allowed: Easy keys use 0-9');
  assert.equal(hcr.hcrTypeError('37', '7', 'easy'), '7 is already in 37: Easy keys use 4 different digits');
  assert.equal(hcr.hcrTypeError('3A', 'A', 'normal'), 'A is already in 3A: Normal keys use 4 different hex symbols');
  assert.equal(hcr.hcrTypeError('AAAA', 'A', 'hard'), '', 'Hard allows repeats');
  assert.equal(hcr.hcrTypeError('3A7F', '1', 'normal'), 'The key has 4 symbols: press Enter to crack 3A7F or Backspace');
  assert.equal(hcr.hcrTypeError('AAAAA', 'A', 'hard'), 'The key has 5 symbols: press Enter to crack AAAAA or Backspace');
  // A key being typed: a valid start of a key.
  for (const [text, mode, partial] of [
    ['', 'easy', true], ['9', 'easy', true], ['987', 'easy', true], ['9876', 'easy', true], ['98765', 'easy', false],
    ['99', 'easy', false], ['9A', 'easy', false], ['9a', 'normal', false], ['FFFFF', 'hard', true], ['FFFFFF', 'hard', false],
    [null, 'easy', false], [7, 'easy', false], [['1'], 'easy', false]
  ]) {
    assert.equal(hcr.hcrIsPartial(text, mode), partial, mode + ' ' + JSON.stringify(text));
  }
});

// ── The key space ────────────────────────────────────────────────────────────

test('hash-cracker: filtering keeps exactly the keys that give every attempt\'s feedback, checked by counting', () => {
  const hcr = loadScript(SCRIPT);
  const easy = hcr.hcrAllCodes('easy');
  const count = (entries) => hcr.hcrFilterCandidates(easy, entries).length;
  // Counted by hand: 0 HIT 0 NEAR leaves the other 6 digits (6*5*4*3); 4 HIT
  // leaves the key; 0 HIT 4 NEAR the 9 derangements of four symbols; 4 NEAR
  // with 2 HIT the 6 ways to swap one pair.
  assert.equal(count([{ guess: '0123', hit: 0, near: 0 }]), 360);
  assert.deepEqual(hcr.hcrFilterCandidates(easy, [{ guess: '0123', hit: 4, near: 0 }]), ['0123']);
  assert.equal(count([{ guess: '0123', hit: 0, near: 4 }]), 9);
  assert.equal(count([{ guess: '0123', hit: 2, near: 2 }]), 6);
  assert.equal(count([{ guess: '0123', hit: 3, near: 1 }]), 0, 'three in place and one swapped cannot happen');
  // One symbol shared, in place: 4 places, then the other 3 from the 6 digits not guessed.
  assert.equal(count([{ guess: '0123', hit: 1, near: 0 }]), 4 * permutations(6, 3));
  assert.equal(hcr.hcrFilterCandidates(hcr.hcrAllCodes('normal'), [{ guess: '0123', hit: 0, near: 0 }]).length, permutations(12, 4));
  assert.deepEqual(hcr.hcrFilterCandidates(easy, []), easy, 'no attempt keeps every key');
  assert.notEqual(hcr.hcrFilterCandidates(easy, []), easy, 'a new list: the full list is never changed');

  // Random games against a brute-force check of every key.
  const rnd = seeded(77);
  for (let game = 0; game < 25; game++) {
    const mode = game % 2 ? 'normal' : 'easy';
    const secret = hcr.hcrMakeSecret(mode, rnd);
    const guesses = [1, 2, 3].map(() => hcr.hcrMakeSecret(mode, rnd));
    const entries = history(secret, guesses);
    assert.deepEqual(hcr.hcrHistory(secret, guesses), entries);
    const left = hcr.hcrFilterCandidates(hcr.hcrAllCodes(mode), entries);
    assert.deepEqual(left, enumerate(MODES[mode].symbols, 4, true).filter((code) => consistent(code, entries)), mode + ' ' + secret);
    assert.ok(left.includes(secret), 'the key is always still possible');
  }
});

test('hash-cracker: the pruned search finds the same keys as brute force, with and without repeats', () => {
  const hcr = loadScript(SCRIPT);
  // Distinct modes: against the filtered full list.
  const rnd = seeded(31);
  for (let game = 0; game < 20; game++) {
    const mode = game % 2 ? 'normal' : 'easy';
    const secret = hcr.hcrMakeSecret(mode, rnd);
    const entries = history(secret, [0, 1, 2].slice(0, 1 + (game % 3)).map(() => hcr.hcrMakeSecret(mode, rnd)));
    assert.deepEqual(hcr.hcrSearchCodes(hcr.hcrModes[mode], entries, Infinity),
      hcr.hcrFilterCandidates(hcr.hcrAllCodes(mode), entries), mode + ' ' + secret);
  }
  // Repeats on a small alphabet: every one of the 4^5 codes checked by the model.
  const small = { symbols: '0123', length: 5, distinct: false };
  const codes = enumerate(small.symbols, 5, false);
  assert.equal(codes.length, 1024);
  assert.deepEqual(hcr.hcrSearchCodes(small, [], Infinity), codes);
  for (let game = 0; game < 30; game++) {
    const pick = () => codes[Math.floor(rnd() * codes.length)];
    const secret = pick();
    const entries = history(secret, [pick(), pick(), pick()].slice(0, 1 + (game % 3)));
    assert.deepEqual(hcr.hcrSearchCodes(small, entries, Infinity), codes.filter((code) => consistent(code, entries)), secret);
  }
  // Hard: two 0 HIT 0 NEAR probes rule out 0-9, so the keys left are the
  // 6^5 codes over A-F; brute force over those checks the rest.
  const secret = 'FACEB';
  const entries = history(secret, ['01234', '56789', 'ABCDE', 'FFAAB']);
  assert.deepEqual(entries.slice(0, 2).map((e) => [e.hit, e.near]), [[0, 0], [0, 0]]);
  const af = enumerate('ABCDEF', 5, false);
  assert.equal(hcr.hcrSearchCodes(hcr.hcrModes.hard, entries.slice(0, 2), BUDGET).length, 7776);
  for (let k = 3; k <= 4; k++) {
    assert.deepEqual(hcr.hcrSearchCodes(hcr.hcrModes.hard, entries.slice(0, k), BUDGET),
      af.filter((code) => consistent(code, entries.slice(0, k))), k + ' attempts');
  }
});

test('hash-cracker: the search gives up past its step budget, to the exact step', () => {
  const hcr = loadScript(SCRIPT);
  // Easy without attempts tries 10 + 10*9 + 10*9*8 + 10*9*8*7 symbols; Normal 16 + 16*15 + ...
  assert.equal(hcr.hcrSearchCodes(hcr.hcrModes.easy, [], 5860).length, 5040);
  assert.equal(hcr.hcrSearchCodes(hcr.hcrModes.easy, [], 5859), null);
  assert.equal(hcr.hcrSearchCodes(hcr.hcrModes.normal, [], 47296).length, 43680);
  assert.equal(hcr.hcrSearchCodes(hcr.hcrModes.normal, [], 47295), null);
  assert.equal(hcr.hcrSearchCodes(hcr.hcrModes.easy, [], 0), null);
  // Hard: one probe that rules out 5 symbols leaves 11^5 = 161,051 keys: over budget.
  const one = [{ guess: '01234', hit: 0, near: 0 }];
  assert.equal(hcr.hcrSearchCodes(hcr.hcrModes.hard, one, BUDGET), null);
  // A contradiction (all five in place and none shared) is settled at the first symbol.
  assert.deepEqual(hcr.hcrSearchCodes(hcr.hcrModes.hard, [{ guess: '01234', hit: 5, near: 0 }, { guess: '01234', hit: 0, near: 0 }], 16), []);
  assert.deepEqual(hcr.hcrSearchCodes(hcr.hcrModes.hard, [{ guess: 'ABCDE', hit: 5, near: 0 }], 80), ['ABCDE']);
  assert.equal(hcr.hcrSearchCodes(hcr.hcrModes.hard, [{ guess: 'ABCDE', hit: 5, near: 0 }], 79), null);
});

test('hash-cracker: the key-space trail counts every attempt, and Hard counts only once few enough keys are left', () => {
  const hcr = loadScript(SCRIPT);
  // Easy and Normal: attempt by attempt, the filtered list.
  const easy = history('5678', ['0123', '4567', '5687', '5678']);
  const trail = hcr.hcrKeyTrail('easy', easy, BUDGET);
  const expected = [5040];
  for (let k = 1; k <= easy.length; k++) {
    expected.push(enumerate(MODES.easy.symbols, 4, true).filter((code) => consistent(code, easy.slice(0, k))).length);
  }
  assert.deepEqual(trail.counts, expected);
  assert.deepEqual(expected.slice(0, 2), [5040, 360]);
  assert.deepEqual(trail.list, ['5678']);
  assert.deepEqual(hcr.hcrKeyTrail('normal', [], BUDGET), { counts: [43680], list: hcr.hcrAllCodes('normal') });

  // Hard: the first probe leaves 161,051 keys (not counted), the second 7,776.
  const hard = history('FACEB', ['01234', '56789', 'ABCDE', 'FFAAB', 'FACEB']);
  const hardTrail = hcr.hcrKeyTrail('hard', hard, BUDGET);
  assert.equal(hardTrail.counts.length, 6);
  assert.deepEqual(hardTrail.counts.slice(0, 3), [1048576, null, 7776]);
  assert.deepEqual(hardTrail.list, ['FACEB']);
  assert.deepEqual(hcr.hcrKeyTrail('hard', [], BUDGET), { counts: [1048576], list: null });
  assert.deepEqual(hcr.hcrKeyTrail('hard', hard.slice(0, 1), BUDGET), { counts: [1048576, null], list: null });

  // The trail searched from the last attempt back equals each prefix searched on its own.
  const rnd = seeded(9);
  for (let game = 0; game < 6; game++) {
    const secret = hcr.hcrMakeSecret('hard', rnd);
    const entries = history(secret, [0, 1, 2, 3, 4, 5].map(() => hcr.hcrMakeSecret('hard', rnd)));
    const forward = [1048576];
    for (let k = 1; k <= entries.length; k++) {
      const keys = hcr.hcrSearchCodes(hcr.hcrModes.hard, entries.slice(0, k), BUDGET);
      forward.push(keys ? keys.length : null);
    }
    assert.deepEqual(hcr.hcrKeyTrail('hard', entries, BUDGET).counts, forward, secret);
  }

  // One more attempt: filter the known list, or search when there is none.
  const list = hcr.hcrAllCodes('easy');
  assert.deepEqual(hcr.hcrNextKeys('easy', list, easy.slice(0, 1), BUDGET).length, 360);
  assert.equal(hcr.hcrNextKeys('hard', null, hard.slice(0, 2), BUDGET).length, 7776);
  assert.equal(hcr.hcrNextKeys('hard', null, hard.slice(0, 1), BUDGET), null);
});

test('hash-cracker: 10 attempts are fair: a player who always tries a key still possible cracks every Easy key and nearly every Normal one', () => {
  const hcr = loadScript(SCRIPT);
  const rnd = seeded(2026);
  const play = (mode) => {
    const secret = hcr.hcrMakeSecret(mode, rnd);
    let list = hcr.hcrAllCodes(mode);
    const guesses = [];
    for (;;) {
      guesses.push(list[Math.floor(rnd() * list.length)]);
      if (hcr.hcrOutcome(secret, guesses) !== 'playing') return hcr.hcrOutcome(secret, guesses) === 'won' ? guesses.length : 0;
      list = hcr.hcrNextKeys(mode, list, hcr.hcrHistory(secret, guesses), BUDGET);
      assert.ok(list.includes(secret));
    }
  };
  const easy = Array.from({ length: 100 }, () => play('easy'));
  assert.ok(easy.every((n) => n >= 1 && n <= 8), 'every Easy key within 8: ' + easy.join(','));
  const normal = Array.from({ length: 40 }, () => play('normal'));
  const won = normal.filter(Boolean);
  assert.ok(won.length >= 36, 'at least 90% of Normal keys within 10: ' + normal.join(','));
  assert.ok(won.some((n) => n >= 8), 'Normal still takes thought: ' + normal.join(','));
});

test('hash-cracker: the outcome, the counters and the terminal lines', () => {
  const hcr = loadScript(SCRIPT);
  assert.equal(hcr.hcrOutcome('1234', []), 'playing');
  assert.equal(hcr.hcrOutcome('1234', ['5678']), 'playing');
  assert.equal(hcr.hcrOutcome('1234', ['5678', '1234']), 'won');
  const nine = ['0123', '0124', '0125', '0126', '0127', '0128', '0129', '0132', '0134'];
  assert.equal(hcr.hcrOutcome('9876', nine), 'playing');
  assert.equal(hcr.hcrOutcome('9876', [...nine, '0135']), 'lost');
  assert.equal(hcr.hcrOutcome('9876', [...nine, '9876']), 'won', 'the tenth attempt can still win');

  assert.equal(hcr.hcrFormatCount(7), '7');
  assert.equal(hcr.hcrFormatCount(5040), '5,040');
  assert.equal(hcr.hcrFormatCount(43680), '43,680');
  assert.equal(hcr.hcrFormatCount(1048576), '1,048,576');
  assert.equal(hcr.hcrFormatBits(hcr.hcrBits(5040)), '12.30');
  assert.equal(hcr.hcrFormatBits(hcr.hcrBits(43680)), '15.41');
  assert.equal(hcr.hcrFormatBits(hcr.hcrBits(1048576)), '20.00');
  assert.equal(hcr.hcrFormatBits(hcr.hcrBits(1)), '0.00');

  assert.equal(hcr.hcrHeadText('easy'), '$ keyspace --mode easy -> 5,040 keys · 12.30 bits');
  assert.equal(hcr.hcrHeadText('normal'), '$ keyspace --mode normal -> 43,680 keys · 15.41 bits');
  assert.equal(hcr.hcrHeadText('hard'), '$ keyspace --mode hard -> 1,048,576 keys · 20.00 bits');
  assert.equal(hcr.hcrAttemptText(3, { guess: '3A7F', hit: 2, near: 1 }), '#03 $ crack 3A7F -> 2 HIT 1 NEAR');
  assert.equal(hcr.hcrAttemptText(10, { guess: 'A0A0A', hit: 0, near: 0 }), '#10 $ crack A0A0A -> 0 HIT 0 NEAR');
  assert.equal(hcr.hcrKeysText(360, 5040), '  └ 360 keys left · ' + log2(360) + ' bits (-' + (Math.log2(5040) - Math.log2(360)).toFixed(2) + ')');
  assert.equal(hcr.hcrKeysText(360, 5040), '  └ 360 keys left · 8.49 bits (-3.81)');
  assert.equal(hcr.hcrKeysText(1, 6), '  └ 1 key left · 0.00 bits (-2.58)');
  assert.equal(hcr.hcrKeysText(7776, null), '  └ 7,776 keys left · 12.92 bits', 'no change shown after an uncounted attempt');
  assert.equal(hcr.hcrKeysText(18, 18), '  └ 18 keys left · 4.17 bits (-0.00)');
  assert.equal(hcr.hcrKeysText(null, 1048576), NOT_COUNTED);
  assert.equal(hcr.hcrResultText('3A7F', ['0123', '3A7F']), 'ACCESS GRANTED · key 3A7F cracked in 2/10');
  assert.equal(hcr.hcrResultText('9876', [...nine, '0135']), 'ACCESS DENIED · the key was 9876');

  assert.equal(hcr.hcrStatusText(game('easy', '1234')), 'Attempt 1 of 10 · type 4 different digits (0-9)');
  assert.equal(hcr.hcrStatusText(game('normal', '3A7F', ['0123'])), 'Attempt 2 of 10 · type 4 different hex symbols (0-F)');
  assert.equal(hcr.hcrStatusText(game('hard', 'AAAAA', ['01234', 'BBBBB'])), 'Attempt 3 of 10 · type 5 hex symbols (0-F), repeats allowed');
  assert.equal(hcr.hcrStatusText(game('normal', '3A7F', ['0123', '3A7F'])), 'Cracked 3A7F in 2 of 10 attempts. Press New Game or Enter for the next key.');
  assert.equal(hcr.hcrStatusText(game('easy', '9876', [...nine, '0135'])), 'Locked out: the key was 9876. Press New Game or Enter for a new key.');
});

// ── Saves ────────────────────────────────────────────────────────────────────

test('hash-cracker: a save keeps mode, key, attempts and the key being typed, and parses back field for field', () => {
  const hcr = loadScript(SCRIPT);
  const state = game('normal', '3A7F', ['0123', '4567'], '9B');
  assert.equal(hcr.hcrSerializeState(state), FORMAT_SAVE);
  assert.deepEqual(hcr.hcrParseState(FORMAT_SAVE), state);
  const parsed = hcr.hcrParseState(FORMAT_SAVE);
  parsed.guesses.push('89AB');
  assert.deepEqual(hcr.hcrParseState(FORMAT_SAVE).guesses, ['0123', '4567'], 'a fresh copy every time');
  for (const s of [game('easy', '0123'), game('hard', 'AAAAA', ['01234', 'AAAAA']), game('easy', '9876', [], '98')]) {
    assert.deepEqual(hcr.hcrParseState(hcr.hcrSerializeState(s)), s);
  }
});

test('hash-cracker: a damaged save falls back field by field and never keeps an unplayable game', () => {
  const hcr = loadScript(SCRIPT);
  const parse = (data) => hcr.hcrParseState(typeof data === 'string' ? data : JSON.stringify(data));
  // Not a save at all.
  for (const text of [null, '', '{', 'null', '42', '"x"', 'true', '[]', '[1,2]']) {
    assert.equal(hcr.hcrParseState(text), null, JSON.stringify(text));
  }
  // The mode falls back to Easy; a key that does not fit the mode is dropped.
  assert.deepEqual(parse({}), game('easy', ''));
  assert.deepEqual(parse({ mode: 'insane', secret: '0123' }), game('easy', '0123'));
  assert.deepEqual(parse({ mode: 'toString', secret: '0123' }), game('easy', '0123'));
  assert.deepEqual(parse({ mode: 'insane', secret: '3A7F' }), game('easy', ''));
  assert.deepEqual(parse({ mode: 'hard', secret: '3A7F', guesses: ['01234'] }), game('hard', ''), 'too short for Hard');
  assert.deepEqual(parse({ mode: 'normal', secret: 'AA7F' }), game('normal', ''), 'repeats in a Normal key');
  assert.deepEqual(parse({ mode: 'normal', secret: '3a7f' }), game('normal', ''));
  assert.deepEqual(parse({ mode: 'normal', secret: 3017 }), game('normal', ''));
  // Attempts: the valid start, no repeats, none after the win, at most 10.
  assert.deepEqual(parse({ mode: 'normal', secret: '3A7F' }), game('normal', '3A7F'));
  assert.deepEqual(parse({ mode: 'normal', secret: '3A7F', guesses: 'oops' }), game('normal', '3A7F'));
  assert.deepEqual(parse({ mode: 'normal', secret: '3A7F', guesses: ['0123', 'zz', '4567'] }), game('normal', '3A7F', ['0123']));
  assert.deepEqual(parse({ mode: 'normal', secret: '3A7F', guesses: ['0123', '0123', '4567'] }), game('normal', '3A7F', ['0123']));
  assert.deepEqual(parse({ mode: 'normal', secret: '3A7F', guesses: ['0123', 4567] }), game('normal', '3A7F', ['0123']));
  assert.deepEqual(parse({ mode: 'normal', secret: '3A7F', guesses: ['3A7F', '0123'], input: '12' }), game('normal', '3A7F', ['3A7F']));
  const eleven = ['0123', '0124', '0125', '0126', '0127', '0128', '0129', '0132', '0134', '0135', '0136'];
  assert.deepEqual(parse({ mode: 'easy', secret: '9876', guesses: eleven, input: '98' }), game('easy', '9876', eleven.slice(0, 10)));
  // The key being typed: kept when it fits the mode, else empty.
  assert.deepEqual(parse({ mode: 'normal', secret: '3A7F', input: 'AB' }), game('normal', '3A7F', [], 'AB'));
  for (const input of ['AA', 'ab', '12345', 12, null, ['1']]) {
    assert.deepEqual(parse({ mode: 'normal', secret: '3A7F', input }), game('normal', '3A7F'), JSON.stringify(input));
  }
});

test('hash-cracker: stats count wins, losses and streaks per mode, and a damaged stats save falls back field by field', () => {
  const hcr = loadScript(SCRIPT);
  assert.deepEqual(hcr.hcrFreshStats(), freshStats());
  for (const text of [null, '', '{', '[]', '"x"', '7']) assert.deepEqual(hcr.hcrParseStats(text), freshStats(), JSON.stringify(text));
  const good = { easy: record(4, 1, 2, 3), normal: record(0, 2, 0, 1), hard: record(1, 0, 1, 1) };
  assert.deepEqual(hcr.hcrParseStats(JSON.stringify(good)), good);
  const odd = { easy: { wins: -1, losses: 1.5, streak: '2', best: null }, normal: 'x', hard: { wins: 3, streak: 4, best: 2 }, extra: 1 };
  assert.deepEqual(hcr.hcrParseStats(JSON.stringify(odd)), { easy: record(), normal: record(), hard: record(3, 0, 4, 4) });
  assert.deepEqual(hcr.hcrParseStats('{"easy":{"wins":1e999,"losses":2e9}}').easy, record(), 'infinite or absurd counts');

  const stats = freshStats();
  assert.equal(hcr.hcrRecordResult(stats, 'easy', true), stats, 'changed in place');
  hcr.hcrRecordResult(stats, 'easy', true);
  hcr.hcrRecordResult(stats, 'easy', true);
  assert.deepEqual(stats.easy, record(3, 0, 3, 3));
  hcr.hcrRecordResult(stats, 'easy', false);
  assert.deepEqual(stats.easy, record(3, 1, 0, 3), 'a loss ends the streak, the best stays');
  hcr.hcrRecordResult(stats, 'easy', true);
  assert.deepEqual(stats.easy, record(4, 1, 1, 3));
  hcr.hcrRecordResult(stats, 'hard', false);
  assert.deepEqual(stats.hard, record(0, 1, 0, 0));
  assert.deepEqual(stats.normal, record(), 'each mode has its own record');
});

test('hash-cracker: hcrKeyName reads the key value, then the A-F keys of a non-Latin layout', () => {
  const hcr = loadScript(SCRIPT);
  const name = (key, code) => hcr.hcrKeyName({ key, code });
  for (const ch of '0123456789ABCDEF') assert.equal(name(ch), ch);
  for (const ch of 'abcdef') assert.equal(name(ch), ch.toUpperCase());
  assert.equal(name('Backspace'), 'BACK');
  assert.equal(name('Enter', 'NumpadEnter'), 'ENTER');
  assert.equal(name('7', 'Numpad7'), '7');
  for (const key of ['g', 'G', 'z', ' ', 'Escape', 'Delete', 'ArrowUp', 'Tab', 'F1', '-', 'AB', '']) {
    assert.equal(name(key, 'KeyA'), '', JSON.stringify(key));
  }
  // Ukrainian ф, и, с, в, у, а sit on the A-F keys.
  assert.deepEqual([['ф', 'KeyA'], ['и', 'KeyB'], ['с', 'KeyC'], ['в', 'KeyD'], ['у', 'KeyE'], ['а', 'KeyF']].map(([k, c]) => name(k, c)), [...'ABCDEF']);
  assert.equal(name('й', 'KeyQ'), '', 'not an A-F key');
  assert.equal(name('ф', undefined), '');
  assert.equal(name('q', 'KeyA'), '', 'a Latin layout (AZERTY) types what it shows');
  assert.equal(name(undefined, 'KeyA'), '', 'Chrome autofill sends keydowns without a key');
});

// ── The page ─────────────────────────────────────────────────────────────────

test('hash-cracker: loading the script under Node runs no init: no lookup, no listener, no timer, no save', (t) => {
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const page = createPage(htmlPageSpec(HTML)).install();
  const hcr = loadScript(SCRIPT);
  assert.equal(typeof hcr.hcrInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['hcr-keypad'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('hash-cracker: a first visit starts an Easy key: the terminal, the keypad, the stats and one set of listeners', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const page = openPage(t);
  assert.deepEqual(page.saved(), game('easy', '0123'));
  assert.equal(localStorage.getItem(STATS_KEY), null, 'stats are written when a game ends');
  assert.deepEqual(page.log(), ['$ keyspace --mode easy -> 5,040 keys · 12.30 bits']);
  assert.equal(page.lines()[0].className, 'hcr-line hcr-line--head');
  assert.equal(page.prompt(), '$ crack ____');
  assert.equal(page.els['hcr-prompt'].getAttribute('aria-label'), 'Key: empty, 0 of 4 symbols');
  assert.equal(page.status(), 'Attempt 1 of 10 · type 4 different digits (0-9)');
  assert.deepEqual(page.stats(), ['0/10', '5,040', '12.30', '0', '0', '0 / 0']);
  assert.equal(page.els['hcr-meter-fill'].style.width, '0%');
  assert.equal(page.els['hcr-meter'].getAttribute('aria-valuenow'), '0');
  assert.equal(page.warning(), null);
  assert.equal(page.toast(), null);
  assert.equal(page.els['hcr-mode-easy'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.els['hcr-mode-normal'].getAttribute('aria-pressed'), 'false');
  assert.equal(page.els['hcr-new-game'].textContent, 'New Game');

  // The keypad: 0-F in reading order, then Clear, Backspace and CRACK.
  const keys = page.keys();
  assert.deepEqual(keys.map((b) => b.getAttribute('data-hcr-key')), [...HEX, 'CLEAR', 'BACK', 'ENTER']);
  assert.deepEqual(keys.map((b) => b.textContent), [...HEX, 'CLR', '⌫', 'CRACK']);
  for (const b of keys) {
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.type, 'button');
    assert.match(b.className, /^hcr-key( hcr-key--(action|crack))?$/);
  }
  assert.equal(page.key('A').getAttribute('aria-label'), 'Symbol A');
  assert.equal(page.key('ENTER').getAttribute('aria-label'), 'Crack: try this key');
  assert.deepEqual(page.disabled(), [...'ABCDEF', 'CLEAR', 'BACK'], 'Easy has no A-F, and nothing is typed yet');
  assert.equal(page.key('ENTER').classList.contains('hcr-ready'), false);

  assert.equal(listenerCount(page.els['hcr-new-game'], 'click'), 1);
  for (const mode of ['easy', 'normal', 'hard']) assert.equal(listenerCount(page.els['hcr-mode-' + mode], 'click'), 1);
  assert.equal(listenerCount(page.els['hcr-keypad'], 'click'), 1);
  for (const b of keys) assert.equal(listenerCount(b), 0, 'one listener on the keypad serves every key');
  assert.equal(listenerCount(document), 1);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(window), 0);
});

test('hash-cracker: while the page is still loading, the game waits for DOMContentLoaded', (t) => {
  const page = openPage(t, { state: FORMAT_SAVE }, { readyState: 'loading' });
  assert.equal(page.keys().length, 0);
  assert.equal(page.status(), 'Booting the vault...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(document, 'keydown'), 0);
  page.ready();
  assert.equal(page.keys().length, 19);
  assert.equal(page.prompt(), '$ crack 9B__');
  assert.equal(page.log().length, 5);
  assert.equal(listenerCount(document, 'keydown'), 1);
});

test('hash-cracker: init runs once: a second call builds and binds nothing twice', (t) => {
  fakeTimers(t);
  writeStorage({ state: FORMAT_SAVE });
  const { exports: hcr, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  hcr.hcrInit();
  hcr.hcrInit();
  assert.equal(els['hcr-keypad'].children.length, 19);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(els['hcr-new-game'], 'click'), 1);
  assert.equal(listenerCount(els['hcr-keypad'], 'click'), 1);
  assert.deepEqual({ ...hcr.hcrState, guesses: [...hcr.hcrState.guesses] }, game('normal', '3A7F', ['0123', '4567'], '9B'));
});

test('hash-cracker: the keypad types, deletes and clears, disables what cannot be typed, and every change is saved', (t) => {
  const page = openPage(t, { state: game('easy', '5678') });
  page.tap('1', '2');
  assert.equal(page.prompt(), '$ crack 12__');
  assert.equal(page.els['hcr-prompt'].getAttribute('aria-label'), 'Key: 12, 2 of 4 symbols');
  const slots = page.els['hcr-prompt'].children;
  assert.deepEqual(slots.map((s) => s.className), ['hcr-cmd', 'hcr-slot hcr-slot--filled', 'hcr-slot hcr-slot--filled', 'hcr-slot hcr-slot--cursor', 'hcr-slot']);
  assert.deepEqual(page.disabled(), ['1', '2', ...'ABCDEF'], 'a digit already typed cannot repeat in Easy');
  assert.equal(page.saved().input, '12');
  page.tap('BACK');
  assert.equal(page.prompt(), '$ crack 1___');
  assert.equal(page.saved().input, '1');
  page.tap('CLEAR');
  assert.equal(page.prompt(), '$ crack ____');
  assert.equal(page.saved().input, '');
  assert.deepEqual(page.disabled(), [...'ABCDEF', 'CLEAR', 'BACK']);

  // A full key: nothing more to type, CRACK lights up.
  page.tap('1', '2', '3', '4');
  assert.equal(page.prompt(), '$ crack 1234');
  assert.deepEqual(page.disabled(), [...HEX]);
  assert.equal(page.key('ENTER').classList.contains('hcr-ready'), true);
  page.tap('ENTER');
  // 0 HIT 0 NEAR: the key uses the six other digits, 6*5*4*3 = 360 keys.
  assert.deepEqual(page.log(), [
    '$ keyspace --mode easy -> 5,040 keys · 12.30 bits',
    '#01 $ crack 1234 -> 0 HIT 0 NEAR',
    '  └ 360 keys left · 8.49 bits (-3.81)'
  ]);
  const attempt = page.lines()[1];
  assert.deepEqual(attempt.children.map((s) => [s.className, s.textContent]), [
    ['hcr-num', '#01'], ['hcr-cmd', '$ crack'], ['hcr-guess', '1234'], ['hcr-hit', '0 HIT'], ['hcr-near', '0 NEAR']
  ]);
  assert.equal(attempt.className, 'hcr-line hcr-line--new', 'the newest attempt types in');
  assert.equal(page.lines()[2].className, 'hcr-line hcr-line--keys hcr-line--new');
  assert.deepEqual(page.stats(), ['1/10', '360', '8.49', '0', '0', '0 / 0']);
  assert.equal(page.els['hcr-meter-fill'].style.width, Math.round(100 * (1 - Math.log2(360) / Math.log2(5040))) + '%');
  assert.equal(page.prompt(), '$ crack ____');
  assert.deepEqual(page.saved(), game('easy', '5678', ['1234']));
  assert.equal(page.status(), 'Attempt 2 of 10 · type 4 different digits (0-9)');

  // The next render no longer animates the old attempt.
  page.tap('5', '6', '8', '7');
  page.tap('ENTER');
  assert.deepEqual(page.lines().map((line) => line.className), [
    'hcr-line hcr-line--head', 'hcr-line', 'hcr-line hcr-line--keys', 'hcr-line hcr-line--new', 'hcr-line hcr-line--keys hcr-line--new'
  ]);
  assert.equal(page.log()[3], '#02 $ crack 5687 -> 2 HIT 2 NEAR');

  // A click on the keypad between the keys does nothing.
  page.els['hcr-keypad'].click();
  assert.deepEqual(page.saved(), game('easy', '5678', ['1234', '5687']));
});

test('hash-cracker: an attempt only adds its own lines to the live log, so a screen reader hears just the new feedback', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const page = openPage(t, { state: game('easy', '5678', ['1234']) });
  const log = page.els['hcr-log'];
  // Node identity, checked without printing the stub elements on a failure.
  const kept = (nodes, from) => nodes.every((node, i) => page.lines()[from + i] === node);
  let before = page.lines().slice();
  assert.equal(before.length, 3);
  const appended = [];
  const append = log.appendChild;
  log.appendChild = function (node) {
    appended.push(node);
    return append.call(this, node);
  };

  // A miss: the attempt and its key-space line, nothing rebuilt.  The four
  // digits of 5687 with exactly 2 in place: C(4,2) = 6 keys.
  page.crack('5687');
  assert.equal(page.lines().length, 5);
  assert.ok(kept(before, 0), 'the head and attempt #01 are the same nodes, not redrawn');
  assert.equal(appended.length, 2, 'only the two new lines were added');
  assert.ok(kept(appended, 3), 'the added lines end the log');
  const one = hcrCount('easy', ['1234'], '5678');
  const two = hcrCount('easy', ['1234', '5687'], '5678');
  assert.equal(two, 6);
  assert.deepEqual(page.log().slice(3), [
    '#02 $ crack 5687 -> 2 HIT 2 NEAR',
    '  └ 6 keys left · ' + log2(6) + ' bits (-' + (Math.log2(one) - Math.log2(two)).toFixed(2) + ')'
  ]);
  assert.deepEqual(page.lines().map((line) => line.classList.contains('hcr-line--new')), [false, false, false, true, true]);

  // The winning attempt: its two lines and the result line; the lines of
  // the attempt before stop typing in.
  before = page.lines().slice();
  appended.length = 0;
  page.crack('5678');
  assert.equal(page.lines().length, 8);
  assert.ok(kept(before, 0), 'the five lines before are the same nodes');
  assert.equal(appended.length, 3);
  assert.ok(kept(appended, 5));
  assert.deepEqual(page.lines().map((line) => line.classList.contains('hcr-line--new')), [false, false, false, false, false, true, true, true]);
  assert.equal(page.log()[7], 'ACCESS GRANTED · key 5678 cracked in 3/10');
  log.appendChild = append;

  // The appended log reads as a full redraw does: a reload draws the same text.
  const again = reload(t, page);
  assert.deepEqual(again.log(), page.log());
  // New Game starts the log over with one new head line.
  const head = again.lines()[0];
  again.newGame();
  assert.deepEqual(again.saved(), game('easy', '0123'));
  assert.deepEqual(again.log(), ['$ keyspace --mode easy -> 5,040 keys · 12.30 bits']);
  assert.ok(again.lines()[0] !== head, 'a new head line');
});

test('hash-cracker: physical keys type 0-9 and A-F in any case, Backspace deletes, Enter cracks; other keys keep their default', (t) => {
  const page = openPage(t, { state: game('normal', '3A7F') });
  for (const key of ['3', 'a', 'F', 'Backspace', 'f']) {
    assert.equal(pressKey(key).defaultPrevented, true, key);
  }
  assert.equal(page.prompt(), '$ crack 3AF_');
  assert.equal(pressKey('B', { shiftKey: true }).defaultPrevented, true, 'Shift is fine (capitals)');
  assert.equal(page.prompt(), '$ crack 3AFB');
  for (const key of [' ', 'g', 'ArrowUp', 'Escape', 'Tab', 'PageDown', '/']) {
    assert.equal(pressKey(key).defaultPrevented, false, JSON.stringify(key));
  }
  assert.equal(page.prompt(), '$ crack 3AFB');
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.equal(page.log()[1], '#01 $ crack 3AFB -> 2 HIT 1 NEAR');
  // A Backspace with nothing typed changes and saves nothing.
  const before = localStorage.getItem(STATE_KEY);
  localStorage.removeItem(STATE_KEY);
  assert.equal(pressKey('Backspace').defaultPrevented, true);
  assert.equal(localStorage.getItem(STATE_KEY), null);
  localStorage.setItem(STATE_KEY, before);
  // A key dispatched on the document itself is the game's too.
  document.dispatchEvent(keyEvent('7'));
  assert.equal(page.prompt(), '$ crack 7___');
  // On a Ukrainian layout the A-F keys type A-F.
  pressKey('ф', { code: 'KeyA' });
  assert.equal(page.prompt(), '$ crack 7A__');
});

test('hash-cracker: refusals say what was refused and why, and change nothing', (t) => {
  const page = openPage(t, { state: game('easy', '5678', ['1234']) });
  const unchanged = () => assert.deepEqual(page.saved(), game('easy', '5678', ['1234'], page.saved().input));
  pressKey('A');
  assert.equal(page.toast(), 'A is not allowed: Easy keys use 0-9');
  assert.equal(page.prompt(), '$ crack ____');
  page.type('37');
  pressKey('7');
  assert.equal(page.toast(), '7 is already in 37: Easy keys use 4 different digits');
  assert.equal(page.prompt(), '$ crack 37__');
  pressKey('Enter');
  assert.equal(page.toast(), '37 is too short: Easy keys use 4 different digits (0-9)');
  pressKey('Backspace');
  pressKey('Backspace');
  page.tap('ENTER');
  assert.equal(page.toast(), 'Type a key first: 4 different digits (0-9)');
  page.type('1234');
  pressKey('5');
  assert.equal(page.toast(), 'The key has 4 symbols: press Enter to crack 1234 or Backspace');
  pressKey('Enter');
  assert.equal(page.toast(), '1234 was already tried in attempt #1: it gives no new information');
  assert.equal(page.log().length, 3, 'no attempt was used');
  unchanged();
  assert.equal(page.saved().input, '1234', 'the refused key stays typed for editing');
});

test('hash-cracker: cracking the key wins: the log, the stats, the toast, a closed prompt, and Enter starts the next key', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const page = openPage(t, { state: game('normal', '3A7F', ['0123']), stats: { normal: record(2, 1, 2, 2) } });
  assert.deepEqual(page.stats().slice(3), ['2', '2', '2 / 1']);
  page.crack('3A7F');
  assert.deepEqual(page.log().slice(-3), [
    '#02 $ crack 3A7F -> 4 HIT 0 NEAR',
    '  └ 1 key left · 0.00 bits (-' + log2(hcrCount('normal', ['0123'], '3A7F')) + ')',
    'ACCESS GRANTED · key 3A7F cracked in 2/10'
  ]);
  assert.equal(page.lines()[page.lines().length - 1].className, 'hcr-line hcr-line--won hcr-line--new');
  assert.equal(page.toast(), 'ACCESS GRANTED: 3A7F cracked in 2 attempts');
  assert.equal(page.status(), 'Cracked 3A7F in 2 of 10 attempts. Press New Game or Enter for the next key.');
  assert.equal(page.prompt(), '$ connection closed');
  assert.equal(page.els['hcr-prompt'].getAttribute('aria-label'), 'Connection closed');
  assert.equal(page.els['hcr-terminal'].classList.contains('hcr-granted'), true);
  assert.equal(page.els['hcr-terminal'].classList.contains('hcr-denied'), false);
  assert.deepEqual(page.stats(), ['2/10', '1', '0.00', '3', '3', '3 / 1']);
  assert.equal(page.els['hcr-meter-fill'].style.width, '100%');
  assert.deepEqual(page.savedStats(), { ...freshStats(), normal: record(3, 1, 3, 3) });
  assert.deepEqual(page.saved(), game('normal', '3A7F', ['0123', '3A7F']));
  assert.deepEqual(page.disabled(), [...HEX, 'CLEAR', 'BACK', 'ENTER'], 'a finished game takes no keys');

  // Keys other than Enter are left alone; a held Enter starts nothing.
  for (const key of ['1', 'a', 'Backspace']) assert.equal(pressKey(key).defaultPrevented, false, key);
  assert.equal(pressKey('Enter', { repeat: true }).defaultPrevented, true);
  assert.equal(page.saved().secret, '3A7F');
  t.mock.timers.tick(2000);
  assert.equal(page.toast(), null);
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.deepEqual(page.saved(), game('normal', '0123'), 'a new Normal key');
  assert.equal(page.els['hcr-terminal'].classList.contains('hcr-granted'), false);
  assert.deepEqual(page.log(), ['$ keyspace --mode normal -> 43,680 keys · 15.41 bits']);
  assert.deepEqual(page.stats(), ['0/10', '43,680', '15.41', '3', '3', '3 / 1']);
  assert.equal(page.toast(), null);
});

// The keys left after the first attempts of a game, by the model.
function hcrCount(mode, guesses, secret) {
  const entries = history(secret, guesses);
  return enumerate(MODES[mode].symbols, MODES[mode].length, MODES[mode].distinct).filter((code) => consistent(code, entries)).length;
}

test('hash-cracker: the tenth miss loses: the key is shown, the streak ends, and a reload keeps the loss', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const nine = ['0123', '0124', '0125', '0126', '0127', '0128', '0129', '0132', '0134'];
  const page = openPage(t, { state: game('easy', '9876', nine), stats: { easy: record(5, 0, 5, 5) } });
  assert.equal(page.status(), 'Attempt 10 of 10 · type 4 different digits (0-9)');
  page.crack('0135');
  assert.equal(page.log()[page.log().length - 1], 'ACCESS DENIED · the key was 9876');
  assert.equal(page.lines()[page.log().length - 1].className, 'hcr-line hcr-line--lost hcr-line--new');
  assert.equal(page.toast(), 'ACCESS DENIED: the key was 9876');
  assert.equal(page.status(), 'Locked out: the key was 9876. Press New Game or Enter for a new key.');
  assert.equal(page.els['hcr-terminal'].classList.contains('hcr-denied'), true);
  assert.deepEqual(page.savedStats().easy, record(5, 1, 0, 5));
  assert.deepEqual(page.stats().slice(0, 1).concat(page.stats().slice(3)), ['10/10', '0', '5', '5 / 1']);

  const again = reload(t, page);
  assert.equal(again.log().length, 22, 'the head, 10 attempts with their key lines and the result');
  assert.equal(again.log()[21], 'ACCESS DENIED · the key was 9876');
  assert.equal(again.lines()[21].className, 'hcr-line hcr-line--lost hcr-line--new');
  assert.ok(again.lines().slice(0, 21).every((line) => !line.classList.contains('hcr-line--new')), 'no attempt types in after a reload');
  assert.equal(again.prompt(), '$ connection closed');
  assert.equal(again.els['hcr-terminal'].classList.contains('hcr-denied'), true);
  assert.equal(again.toast(), null);
  assert.deepEqual(again.savedStats().easy, record(5, 1, 0, 5), 'a reload counts nothing again');
  again.newGame();
  assert.deepEqual(again.saved(), game('easy', '0123'), 'a finished game starts the next Easy key at once');
  assert.deepEqual(again.savedStats().easy, record(5, 1, 0, 5));
});

test('hash-cracker: giving up a game with attempts asks first, and only a second press within 4 s counts it as a loss', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const page = openPage(t, { state: game('easy', '5678', ['1234']), stats: { easy: record(1, 0, 1, 1) } });
  page.newGame();
  assert.equal(page.toast(), 'Give up this Easy key after 1 of 10 attempts? It counts as a loss: press New Game again');
  assert.equal(page.els['hcr-new-game'].textContent, 'Give up?');
  assert.equal(page.els['hcr-new-game'].getAttribute('aria-label'), 'Give up this key: press again to confirm');
  assert.equal(page.els['hcr-new-game'].classList.contains('hcr-armed'), true);
  assert.equal(page.saved().secret, '5678', 'nothing happened yet');
  t.mock.timers.tick(3999);
  assert.equal(page.els['hcr-new-game'].textContent, 'Give up?');
  t.mock.timers.tick(1);
  assert.equal(page.toast(), null);
  assert.equal(page.els['hcr-new-game'].textContent, 'New Game');
  assert.equal(page.els['hcr-new-game'].classList.contains('hcr-armed'), false);

  // Too late: the next press asks again.  Another toast in between also cancels.
  page.newGame();
  assert.equal(page.els['hcr-new-game'].textContent, 'Give up?');
  pressKey('A');
  assert.equal(page.els['hcr-new-game'].textContent, 'New Game', 'the refusal toast replaced the question');
  page.newGame();
  t.mock.timers.tick(2500);
  page.newGame();
  assert.deepEqual(page.saved(), game('easy', '0123'));
  assert.equal(page.toast(), 'Gave up: the Easy key was 5678 · counted as a loss');
  assert.equal(page.els['hcr-new-game'].textContent, 'New Game');
  assert.deepEqual(page.savedStats().easy, record(1, 1, 0, 1));
  assert.deepEqual(page.stats().slice(3), ['0', '1', '1 / 1']);

  // A fresh key with nothing tried is left at once, also with something typed.
  page.type('12');
  page.newGame();
  assert.deepEqual(page.saved(), game('easy', '0123'));
  assert.equal(page.toast(), null, 'New Game hides the old toast');
  assert.deepEqual(page.savedStats().easy, record(1, 1, 0, 1), 'no loss');
});

test('hash-cracker: the mode buttons switch at once when nothing is at stake, ask when it is, and the current mode does nothing', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const page = openPage(t, { state: game('easy', '5678') });
  page.mode('easy');
  assert.deepEqual(page.saved(), game('easy', '5678'), 'the current mode keeps its key');
  page.mode('normal');
  assert.deepEqual(page.saved(), game('normal', '0123'));
  assert.equal(page.els['hcr-mode-normal'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.els['hcr-mode-normal'].classList.contains('hcr-mode--active'), true);
  assert.equal(page.els['hcr-mode-easy'].getAttribute('aria-pressed'), 'false');
  assert.equal(page.els['hcr-mode-easy'].classList.contains('hcr-mode--active'), false);
  assert.equal(page.key('A').disabled, false, 'Normal types A-F');
  assert.equal(page.status(), 'Attempt 1 of 10 · type 4 different hex symbols (0-F)');

  page.crack('4567');
  page.mode('hard');
  assert.equal(page.toast(), 'Give up this Normal key after 1 of 10 attempts? It counts as a loss: press Hard again');
  assert.equal(page.els['hcr-mode-hard'].classList.contains('hcr-armed'), true);
  assert.equal(page.els['hcr-new-game'].textContent, 'New Game');
  // A different control asks its own question.
  page.newGame();
  assert.equal(page.els['hcr-mode-hard'].classList.contains('hcr-armed'), false);
  assert.equal(page.els['hcr-new-game'].textContent, 'Give up?');
  page.mode('hard');
  assert.equal(page.toast(), 'Give up this Normal key after 1 of 10 attempts? It counts as a loss: press Hard again');
  page.mode('normal');
  assert.equal(page.els['hcr-mode-hard'].classList.contains('hcr-armed'), true, 'the current mode does nothing');
  page.mode('hard');
  assert.deepEqual(page.saved(), game('hard', '00000'));
  assert.equal(page.toast(), 'Gave up: the Normal key was 0123 · counted as a loss');
  assert.deepEqual(page.savedStats().normal, record(0, 1, 0, 0));
  assert.equal(page.status(), 'Attempt 1 of 10 · type 5 hex symbols (0-F), repeats allowed');
  assert.equal(page.prompt(), '$ crack _____');
  assert.deepEqual(page.disabled(), ['CLEAR', 'BACK']);

  // A finished game switches at once.
  page.crack('00000');
  assert.equal(page.saved().guesses.length, 1);
  page.mode('easy');
  assert.deepEqual(page.saved(), game('easy', '0123'));
  assert.deepEqual(page.savedStats().hard, record(1, 0, 1, 1));
  assert.deepEqual(page.stats().slice(3), ['0', '0', '0 / 0'], 'the stats shown are the current mode\'s');
});

test('hash-cracker: a newer toast keeps its full 2 s', (t) => {
  const page = openPage(t, { state: game('easy', '5678') });
  pressKey('A');
  assert.equal(page.toast(), 'A is not allowed: Easy keys use 0-9');
  t.mock.timers.tick(1200);
  pressKey('B');
  assert.equal(page.toast(), 'B is not allowed: Easy keys use 0-9');
  t.mock.timers.tick(800);
  assert.equal(page.toast(), 'B is not allowed: Easy keys use 0-9', 'the first toast\'s time is up, not the second\'s');
  t.mock.timers.tick(1199);
  assert.notEqual(page.toast(), null);
  t.mock.timers.tick(1);
  assert.equal(page.toast(), null);
});

test('hash-cracker: Hard counts the keys left only once few enough remain, and the meter waits meanwhile', (t) => {
  const page = openPage(t, { state: game('hard', 'FACEB') });
  assert.deepEqual(page.log(), ['$ keyspace --mode hard -> 1,048,576 keys · 20.00 bits']);
  assert.deepEqual(page.stats().slice(0, 3), ['0/10', '1,048,576', '20.00']);
  page.crack('01234');
  assert.deepEqual(page.log().slice(1), ['#01 $ crack 01234 -> 0 HIT 0 NEAR', NOT_COUNTED]);
  assert.deepEqual(page.stats().slice(0, 3), ['1/10', 'n/a', 'n/a']);
  assert.equal(page.els['hcr-meter'].classList.contains('hcr-meter--unknown'), true);
  assert.equal(page.els['hcr-meter-fill'].style.width, '0%', 'the last counted key space: the start');
  // The second probe leaves the 6^5 codes over A-F.
  page.crack('56789');
  assert.deepEqual(page.log().slice(3), ['#02 $ crack 56789 -> 0 HIT 0 NEAR', '  └ 7,776 keys left · 12.92 bits']);
  assert.deepEqual(page.stats().slice(0, 3), ['2/10', '7,776', '12.92']);
  assert.equal(page.els['hcr-meter'].classList.contains('hcr-meter--unknown'), false);
  assert.equal(page.els['hcr-meter-fill'].style.width, Math.round(100 * (20 - Math.log2(7776)) / 20) + '%');
  const third = hcrCount('hard', ['01234', '56789', 'AACCB'], 'FACEB');
  page.crack('AACCB');
  assert.equal(page.log()[6], '  └ ' + third + ' keys left · ' + log2(third) + ' bits (-' + (Math.log2(7776) - Math.log2(third)).toFixed(2) + ')');

  // After a reload the same trail comes back, searched from the last attempt.
  const again = reload(t, page);
  assert.deepEqual(again.log(), page.log().map((line) => line));
  assert.deepEqual(again.stats(), page.stats());
  again.crack('FACEB');
  assert.equal(again.log()[8], '  └ 1 key left · 0.00 bits (-' + log2(third) + ')');
  assert.equal(again.log()[9], 'ACCESS GRANTED · key FACEB cracked in 4/10');
});

test('hash-cracker: a game in progress survives a reload with its attempts, its typed key and its stats', (t) => {
  t.mock.method(Math, 'random', seeded(3));
  const page = openPage(t);
  page.mode('normal');
  const secret = page.saved().secret;
  const guesses = ['0123', '4567'].filter((g) => g !== secret);
  for (const g of guesses) page.crack(g);
  page.type('9b');
  const drawn = { log: page.log(), prompt: page.prompt(), stats: page.stats(), disabled: page.disabled() };

  const again = reload(t, page);
  assert.deepEqual(again.saved(), game('normal', secret, guesses, '9B'));
  assert.deepEqual({ log: again.log(), prompt: again.prompt(), stats: again.stats(), disabled: again.disabled() }, drawn);
  assert.equal(again.els['hcr-mode-normal'].getAttribute('aria-pressed'), 'true');
  assert.equal(listenerCount(document, 'keydown'), 1, 'the old page\'s listener went with it');
  again.type('C');
  assert.equal(again.prompt(), '$ crack 9BC_');
});

test('hash-cracker: a save in the current format loads as it is and is written back byte for byte', (t) => {
  const page = openPage(t, { state: FORMAT_SAVE });
  const entries = history('3A7F', ['0123', '4567']);
  assert.deepEqual(page.log().filter((line, i) => i % 2 === 1), entries.map((e, i) => '#0' + (i + 1) + ' $ crack ' + e.guess + ' -> ' + e.hit + ' HIT ' + e.near + ' NEAR'));
  assert.equal(page.prompt(), '$ crack 9B__');
  assert.deepEqual(page.stats().slice(0, 2), ['2/10', hcrCount('normal', ['0123', '4567'], '3A7F').toLocaleString('en-US')]);
  assert.equal(localStorage.getItem(STATE_KEY), FORMAT_SAVE, 'loading writes nothing');
  pressKey('1');
  pressKey('Backspace');
  assert.equal(localStorage.getItem(STATE_KEY), FORMAT_SAVE);
});

test('hash-cracker: corrupt or partial saves never break the page: a playable game, keeping what is still valid', (t) => {
  const corrupt = ['', '{', 'null', '[]', '42', '"x"', '{}', '{"mode":"insane"}', '{"mode":"easy","secret":"1123"}',
    '{"mode":"easy","secret":"ABCD","guesses":["0123"]}', '{"secret":null}', '{"mode":["easy"],"secret":"0123x"}'];
  t.mock.method(Math, 'random', () => 0);
  for (const text of corrupt) {
    resetStubs();
    const page = openPage(t, { state: text, stats: '{"easy":' });
    assert.deepEqual(page.saved(), game('easy', '0123'), JSON.stringify(text));
    assert.deepEqual(page.stats(), ['0/10', '5,040', '12.30', '0', '0', '0 / 0'], text);
    assert.equal(page.warning(), null, text);
    page.crack('0123');
    assert.equal(page.toast(), 'ACCESS GRANTED: 0123 cracked in 1 attempt', text);
    assert.deepEqual(page.savedStats().easy, record(1, 0, 1, 1), text);
  }
  // Only the mode survived: a new key in that mode.
  resetStubs();
  let page = openPage(t, { state: { mode: 'hard', secret: '0123' } });
  assert.deepEqual(page.saved(), game('hard', '00000'));
  // Damaged attempts and input: the valid part stays.
  resetStubs();
  page = openPage(t, { state: { mode: 'normal', secret: '3A7F', guesses: ['0123', 'nope', '4567'], input: 'AA' } });
  assert.equal(page.log().length, 3);
  assert.equal(page.prompt(), '$ crack ____');
  assert.equal(localStorage.getItem(STATE_KEY), JSON.stringify({ mode: 'normal', secret: '3A7F', guesses: ['0123', 'nope', '4567'], input: 'AA' }), 'kept until the next change');
  page.type('4');
  assert.deepEqual(page.saved(), game('normal', '3A7F', ['0123'], '4'));
});

test('hash-cracker: blocked storage never stops the game and says so', (t) => {
  t.mock.method(Math, 'random', () => 0);
  blockStorage('access', t);
  const page = openPage(t);
  assert.equal(page.warning(), BLOCKED);
  assert.equal(page.els['hcr-warning'].getAttribute('role'), 'alert');
  page.crack('4567');
  assert.equal(page.log().length, 3);
  page.crack('0123');
  assert.equal(page.toast(), 'ACCESS GRANTED: 0123 cracked in 2 attempts');
  assert.deepEqual(page.stats().slice(3), ['1', '1', '1 / 0'], 'the stats still count on the page');
  pressKey('Enter');
  page.crack('0123');
  assert.deepEqual(page.stats().slice(3), ['2', '2', '2 / 0']);
  assert.equal(page.warning(), BLOCKED);
});

test('hash-cracker: full storage still loads the game and names the save it could not write', (t) => {
  writeStorage({ state: game('easy', '5678'), stats: { easy: record(3, 0, 3, 3) } });
  blockStorage('full', t);
  const page = openPage(t);
  assert.equal(page.warning(), null, 'reading works');
  assert.deepEqual(page.stats().slice(3), ['3', '3', '3 / 0']);
  pressKey('1');
  assert.equal(page.warning(), 'Storage is full: hcr-state was not saved, so progress will not survive a reload');
  assert.equal(page.prompt(), '$ crack 1___', 'the game goes on');
  pressKey('Backspace');
  page.crack('5678');
  assert.deepEqual(page.stats().slice(3), ['4', '4', '4 / 0']);
  assert.equal(page.warning(), 'Storage is full: hcr-state was not saved, so progress will not survive a reload', 'shown once, as first found');
  assert.deepEqual(JSON.parse(localStorage.getItem(STATE_KEY)), game('easy', '5678'), 'the old save stays');
  assert.deepEqual(JSON.parse(localStorage.getItem(STATS_KEY)).easy, record(3, 0, 3, 3));
  // The next game adds to the stats on the page, not to the older ones still stored.
  t.mock.method(Math, 'random', () => 0);
  pressKey('Enter');
  page.crack('0123');
  assert.deepEqual(page.stats().slice(3), ['5', '5', '5 / 0']);
});

test('hash-cracker: storage that fails to read starts a fresh game; stats another tab saved meanwhile are added to, not overwritten', (t) => {
  t.mock.method(Math, 'random', () => 0);
  writeStorage({ state: game('easy', '5678', ['1234']) });
  const restore = blockStorage('getItem');
  let page = openPage(t);
  assert.equal(page.warning(), BLOCKED);
  restore();
  assert.deepEqual(page.saved(), game('easy', '0123'), 'a new key, written over the unreadable save');

  resetStubs();
  page = openPage(t, { state: game('easy', '5678'), stats: { easy: record(2, 0, 2, 2) } });
  assert.deepEqual(page.stats().slice(3), ['2', '2', '2 / 0']);
  localStorage.setItem(STATS_KEY, JSON.stringify({ easy: record(5, 1, 3, 4), hard: record(1, 0, 1, 1) }));
  page.crack('5678');
  assert.deepEqual(page.savedStats(), { easy: record(6, 1, 4, 4), normal: record(), hard: record(1, 0, 1, 1) });
  assert.deepEqual(page.stats().slice(3), ['4', '4', '6 / 1']);
});

test('hash-cracker: links, buttons and fields of the host page keep their keys, and so do shortcuts', (t) => {
  const page = openPage(t, { state: game('normal', '3A7F') });
  const link = page.page.add('host-link', { tagName: 'a', attributes: { href: '#host' } });
  const hostButton = page.page.add('host-button', 'button');
  const hostClicks = [];
  hostButton.addEventListener('click', () => hostClicks.push('host'));
  const fields = ['input', 'textarea', 'select'].map((tag) => page.page.add('host-' + tag, tag));
  const editable = page.page.add('host-editable', { isContentEditable: true });
  for (const target of [link, hostButton, ...fields, editable]) {
    for (const key of ['1', 'a', 'F', 'Backspace', 'Enter']) {
      assert.equal(pressKey(key, { target }).defaultPrevented, false, target.id + ' ' + key);
    }
  }
  assert.deepEqual(hostClicks, ['host'], 'Enter on the focused host button clicked it');
  // Ctrl, Cmd and Alt combinations, composing text, keys a page script handled, autofill.
  for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    assert.equal(pressKey('a', mods).defaultPrevented, false, JSON.stringify(mods));
    assert.equal(pressKey('Enter', mods).defaultPrevented, false, JSON.stringify(mods));
  }
  const handled = (event) => event.preventDefault();
  document.addEventListener('keydown', handled, true);
  pressKey('1');
  document.removeEventListener('keydown', handled, true);
  assert.equal(pressKey(undefined).defaultPrevented, false);
  assert.equal(page.prompt(), '$ crack ____');
  assert.equal(localStorage.getItem(STATE_KEY), JSON.stringify(game('normal', '3A7F')));

  // A host element that holds the game (a theme's tabindex=-1 content area)
  // has the focus: the keys are the game's; a link beside the game keeps its own.
  const content = page.page.add('host-content', { attributes: { tabindex: '-1' } });
  content.appendChild(page.els['hcr-game']);
  const innerLink = page.page.add('host-inner-link', { tagName: 'a', parent: 'host-content', attributes: { href: '#more' } });
  content.focus();
  assert.equal(pressKey('a').defaultPrevented, true);
  assert.equal(page.prompt(), '$ crack A___');
  assert.equal(pressKey('b', { target: innerLink }).defaultPrevented, false);
  assert.equal(page.prompt(), '$ crack A___');
});

test('hash-cracker: a game button focused with Tab keeps Enter; a clicked one gives its focus back, so Enter cracks', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const page = openPage(t, { state: game('normal', '3A7F', ['0123']) });
  // Keyboard focus on a keypad key: Enter presses that key, other keys type.
  const five = page.key('5');
  focusElement(five, { keyboard: true });
  assert.equal(pressKey('Enter').defaultPrevented, false);
  assert.equal(page.prompt(), '$ crack 5___');
  focusElement(page.key('6'), { keyboard: true });
  assert.equal(pressKey('a').defaultPrevented, true);
  assert.equal(page.prompt(), '$ crack 5A__');
  // Keyboard activation (detail 0) keeps the focus; a mouse click (detail 1) gives it back.
  const seven = page.key('7');
  seven.focus();
  seven.dispatchEvent(createEvent('click', { detail: 0 }));
  assert.equal(document.activeElement, seven);
  assert.equal(page.prompt(), '$ crack 5A7_');
  const eight = page.key('8');
  eight.focus();
  eight.click();
  assert.equal(document.activeElement, document.body);
  assert.equal(page.prompt(), '$ crack 5A78');
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.equal(page.log()[3], '#02 $ crack 5A78 -> 2 HIT 0 NEAR');

  // New Game and the mode buttons give the focus back after a click too, and
  // keep it on keyboard activation; Enter on a focused New Game is its own.
  const newGame = page.els['hcr-new-game'];
  focusElement(newGame, { keyboard: true });
  assert.equal(pressKey('Enter').defaultPrevented, false);
  assert.equal(newGame.textContent, 'Give up?', 'Enter pressed the focused New Game');
  const hard = page.els['hcr-mode-hard'];
  hard.focus();
  hard.dispatchEvent(createEvent('click', { detail: 0 }));
  assert.equal(document.activeElement, hard);
  assert.equal(hard.classList.contains('hcr-armed'), true);
  hard.click();
  assert.equal(document.activeElement, document.body);
  assert.equal(page.saved().mode, 'hard');

  // A held Enter cracks once.
  page.type('ABCDE');
  assert.equal(pressKey('Enter', { repeat: true }).defaultPrevented, true);
  assert.equal(page.saved().guesses.length, 0);
  pressKey('Enter');
  assert.equal(page.saved().guesses.length, 1);
  assert.equal(pressKey('Enter', { repeat: true }).defaultPrevented, true);
  assert.equal(page.saved().guesses.length, 1);
  // Held symbol keys keep typing, as in any field.
  pressKey('A', { repeat: true });
  pressKey('A', { repeat: true });
  assert.equal(page.prompt(), '$ crack AA___');
});

// ── Files ────────────────────────────────────────────────────────────────────

test('hash-cracker: every id the script looks up exists once in index.html, and ids, classes, variables, keys and exports are hcr- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'hcr-attempts', 'hcr-best', 'hcr-bits', 'hcr-game', 'hcr-keypad', 'hcr-keys', 'hcr-log', 'hcr-meter',
    'hcr-meter-fill', 'hcr-mode-easy', 'hcr-mode-hard', 'hcr-mode-normal', 'hcr-new-game', 'hcr-prompt',
    'hcr-record', 'hcr-status', 'hcr-streak', 'hcr-terminal', 'hcr-toast', 'hcr-warning'
  ]);
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^hcr-/);

  const markup = embedMarkup(HTML);
  const classes = Array.from(markup.matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^hcr-/, name);
  const cssClasses = new Set();
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      if (rule.keyframes) continue;
      assert.match(selector, /^\.hcr-/, selector);
      for (const m of selector.matchAll(/\.([\w-]+)/g)) {
        assert.match(m[1], /^hcr-/, selector);
        cssClasses.add(m[1]);
      }
    }
  }
  for (const name of classes) assert.ok(cssClasses.has(name), 'a rule for .' + name);
  // Custom properties: a -- that does not continue a class name (.hcr-mode--active).
  const props = Array.from(CSS.matchAll(/(?<![\w-])--([\w-]+)/g), (m) => m[1]);
  assert.ok(props.length > 20);
  for (const name of props) assert.match(name, /^hcr-/, name);
  for (const m of CSS.matchAll(/@keyframes\s+([\w-]+)/g)) assert.match(m[1], /^hcr-/);
  for (const m of CSS.matchAll(/animation:\s*([\w-]+)/g)) assert.match(m[1], /^(hcr-|none$)/);
  assert.doesNotMatch(JS, /['"(]--[\w-]/, 'the script sets no custom property');
  // Every 'hcr-...' text in the script is an id, a class with a rule, or a storage key.
  for (const literal of JS.match(/'hcr-[\w-]+'/g)) {
    const name = literal.slice(1, -1);
    const known = htmlIds.includes(name) || cssClasses.has(name) || name === STATE_KEY || name === STATS_KEY ||
      (name.endsWith('--') && [...cssClasses].some((c) => c.startsWith(name)));
    assert.ok(known, name);
  }
  assert.ok(JS.includes("'data-hcr-key'"));
  // The Node exports.
  const hcr = loadScript(SCRIPT);
  assert.ok(Object.keys(hcr).length > 30);
  for (const name of Object.keys(hcr)) assert.match(name, /^hcr[A-Z]/, name);
});

test('hash-cracker: the classes the page draws all have rules, and the keypad\'s states are styled', (t) => {
  const page = openPage(t, { state: game('easy', '9876', ['0123', '0124', '0125', '0126', '0127', '0128', '0129', '0132', '0134']) });
  page.crack('0135');
  const rules = cssRules(CSS);
  const selectors = new Set(rules.flatMap((rule) => rule.selectors));
  const drawn = new Set();
  const walk = (el) => {
    String(el.className || '').split(/\s+/).filter(Boolean).forEach((c) => drawn.add(c));
    (el.children || []).forEach(walk);
  };
  walk(page.els['hcr-game']);
  const styled = new Set([...selectors].flatMap((s) => Array.from(s.matchAll(/\.([\w-]+)/g), (m) => m[1])));
  assert.ok(drawn.size > 25, drawn.size + ' classes');
  for (const name of drawn) assert.ok(styled.has(name), name);
  assert.equal(declsAt(rules, '.hcr-key:disabled', 375).opacity, '0.3');
  assert.equal(declsAt(rules, '.hcr-warning', 375).display, 'none');
  assert.equal(declsAt(rules, '.hcr-warning.hcr-visible', 375).display, 'block');
  assert.equal(declsAt(rules, '.hcr-toast', 375)['pointer-events'], 'none');
  assert.equal(declsAt(rules, '.hcr-toast.hcr-show', 375).opacity, '1');
  // Reduced motion turns the animations off.
  const reduced = declsAt(rules, '.hcr-line--new', 375, { matchMedia: (m) => /prefers-reduced-motion/.test(m) });
  assert.equal(reduced.animation, 'none');
  assert.equal(declsAt(rules, '.hcr-line--new', 375).animation, 'hcr-type-in 0.35s ease-out');
});

test('hash-cracker: the game stores nothing but hcr-state and hcr-stats', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const page = openPage(t);
  page.crack('4567');
  page.crack('0123');
  pressKey('Enter');
  page.mode('hard');
  page.crack('00000');
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();
  assert.deepEqual(keys, [STATE_KEY, STATS_KEY]);
  assert.deepEqual(page.savedStats(), { easy: record(1, 0, 1, 1), normal: record(), hard: record(1, 0, 1, 1) });
  assert.equal(sessionStorage.length, 0);
});

test('hash-cracker: index.html labels the controls and live regions for screen readers', () => {
  const spec = htmlPageSpec(HTML);
  assert.equal(spec['hcr-game'].className, 'hcr-wrapper');
  assert.equal(spec['hcr-new-game'].tagName, 'button');
  assert.equal(spec['hcr-new-game'].type, 'button');
  assert.equal(spec['hcr-new-game'].attributes['aria-label'], 'Start a new game with a new key');
  for (const [mode, pressed] of [['easy', 'true'], ['normal', 'false'], ['hard', 'false']]) {
    const button = spec['hcr-mode-' + mode];
    assert.equal(button.tagName, 'button');
    assert.equal(button.type, 'button');
    assert.equal(button.attributes['aria-pressed'], pressed, mode);
  }
  assert.match(HTML, /<div class="hcr-modes" role="group" aria-label="Mode">/);
  assert.equal(spec['hcr-log'].attributes.role, 'log');
  assert.equal(spec['hcr-log'].attributes['aria-live'], 'polite');
  assert.equal(spec['hcr-status'].attributes.role, 'status');
  assert.equal(spec['hcr-warning'].attributes.role, 'alert');
  assert.equal(spec['hcr-toast'].attributes['aria-live'], 'polite');
  assert.equal(spec['hcr-keypad'].attributes.role, 'group');
  assert.equal(spec['hcr-keypad'].attributes['aria-label'], 'Hex keypad');
  assert.equal(spec['hcr-meter'].attributes.role, 'progressbar');
  assert.deepEqual([spec['hcr-meter'].attributes['aria-valuemin'], spec['hcr-meter'].attributes['aria-valuemax']], ['0', '100']);
  assert.match(HTML, /Keyboard: 0-9 and A-F type, Backspace deletes, Enter cracks the key\./);
  assert.match(HTML, /HIT: right symbol, right place\.\s+NEAR: right symbol, wrong place\./);
});

test('hash-cracker: script.js is one strict IIFE in ES5', () => {
  assert.match(JS, /^(\/\/[^\n]*\n)*\n?\(function \(\) \{\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/\(function \(\) \{/g).length, 1);
  assert.equal(JS.match(/'use strict';/g).length, 1);
  const code = JS
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['async', /\b(async|await)\b/],
    ['exponent operator', /\*\*/], ['Array.from / includes / find', /\.(includes|find|findIndex|fill)\(|Array\.from/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
  // The start-up guard: exports under Node, DOMContentLoaded while loading, else at once.
  assert.match(JS, /if \(typeof module !== 'undefined' && module\.exports\) \{\n {4}module\.exports = \{/);
  assert.match(JS, /\} else if \(document\.readyState === 'loading'\) \{\n {4}document\.addEventListener\('DOMContentLoaded', hcrInit\);\n {2}\} else \{\n {4}hcrInit\(\);\n {2}\}/);
  // No network and no AI service: nothing fetched, nothing posted.
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|Worker)\b/);
  assert.doesNotMatch(JS + CSS + HTML, /https?:\/\/(?!www\.w3\.org)/, 'no external URL');
});

test('hash-cracker: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="hcr-wrapper" id="hcr-game">'));
  assert.deepEqual(embedSafety(embedded), []);
  for (const id of idsInHtml(HTML)) assert.ok(embedded.includes('id="' + id + '"'), id + ' is in the embedded markup');
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');
  assert.doesNotMatch(embedded, /<style/i);
  const bg = CSS.match(/--hcr-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.match(head, /<title>Hash Cracker — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  assert.match(HTML, /<script src="script\.js"><\/script>\n<\/body>/);
  assert.equal((HTML.match(/<script/g) || []).length, 1);
  assert.doesNotMatch(HTML, /<link(?![^>]*href="style\.css")/, 'no other stylesheet or font');
});

test('hash-cracker: phones from 320 to 414 px fit the modes, stats, terminal and a keypad of finger-sized keys without overflow', () => {
  const rules = cssRules(CSS);
  for (let vw = 320; vw <= 414; vw++) {
    const at = (selector) => declsAt(rules, selector, vw);
    const wrapper = at('.hcr-wrapper');
    const side = px(wrapper.padding.split(/\s+/)[1]);
    const available = vw - 2 * side;
    assert.equal(side, 12, vw + 'px: 0.75rem side padding');
    // Grids of equal columns that may shrink: nothing pushes the page wider.
    assert.equal(at('.hcr-modes')['grid-template-columns'], 'repeat(3, minmax(0, 1fr))');
    assert.equal(at('.hcr-stats')['grid-template-columns'], 'repeat(3, minmax(0, 1fr))');
    assert.equal(at('.hcr-keypad')['grid-template-columns'], 'repeat(4, minmax(0, 1fr))');
    for (const selector of ['.hcr-mode', '.hcr-stat', '.hcr-key']) assert.equal(at(selector)['min-width'], '0', selector);
    assert.equal(at('.hcr-title-group')['min-width'], '0');
    // The keypad: four keys of at least 44 px a row.
    const keypad = at('.hcr-keypad');
    const width = Math.min(available, px(keypad['max-width']));
    const key = (width - 3 * px(keypad.gap)) / 4;
    assert.ok(key >= 60, vw + 'px: keys ' + key.toFixed(1) + 'px wide');
    assert.ok(px(wrapper['--hcr-key-size']) >= 44, vw + 'px: keys tall enough for a finger');
    assert.equal(at('.hcr-key').height, 'var(--hcr-key-size)');
    // A mode button holds its name: the widest, "Normal" at 0.95rem bold, about 0.62em a letter.
    const mode = (available - 2 * px(at('.hcr-modes').gap)) / 3 - 2 * px(at('.hcr-mode').padding.split(/\s+/)[1]) - 2;
    assert.ok(6 * 0.62 * 0.95 * 16 <= mode, vw + 'px: mode buttons ' + mode.toFixed(1) + 'px');
    // A stat holds "1,048,576" in the monospace value font (0.6em a character).
    const stat = (available - 2 * px(at('.hcr-stats').gap)) / 3 - 2 * px(at('.hcr-stat').padding.split(/\s+/)[1]) - 2;
    assert.ok(9 * 0.6 * px(at('.hcr-stat-value')['font-size']) <= stat, vw + 'px: stats ' + stat.toFixed(1) + 'px');
    // Terminal lines wrap instead of scrolling sideways; the log scrolls inside itself.
    assert.equal(at('.hcr-line')['white-space'], 'pre-wrap');
    assert.equal(at('.hcr-line')['overflow-wrap'], 'anywhere');
    assert.equal(at('.hcr-log')['overflow-y'], 'auto');
    assert.equal(at('.hcr-terminal').overflow, 'hidden');
    assert.equal(at('.hcr-prompt')['flex-wrap'], 'wrap');
    // The toast: a fixed box at left: 50% with auto width would shrink to the
    // right half of the screen; max-content lets it use the viewport less
    // 1rem a side, centred by the translate.
    const toast = at('.hcr-toast');
    assert.equal(toast.position, 'fixed');
    assert.equal(toast.left, '50%');
    assert.equal(toast.width, 'max-content', vw + 'px: the toast is as wide as its message');
    assert.equal(toast['max-width'], 'calc(100% - 2rem)');
    assert.match(toast.transform, /^translateX\(-50%\)/);
    assert.match(at('.hcr-toast.hcr-show').transform, /^translateX\(-50%\)/);
    assert.equal(at('.hcr-btn').width, vw <= 400 ? '100%' : undefined);
    assert.equal(at('.hcr-wrapper *')['box-sizing'], 'border-box');
  }
  // At every width up to desktop, a stat holds the widest value, a mode its name.
  for (let vw = 320; vw <= 1280; vw++) {
    const at = (selector) => declsAt(rules, selector, vw);
    const content = Math.min(vw, px(at('.hcr-wrapper')['max-width'])) - 2 * px(at('.hcr-wrapper').padding.split(/\s+/)[1]);
    const columns = Number(/^repeat\((\d+),/.exec(at('.hcr-stats')['grid-template-columns'])[1]);
    const stat = (content - (columns - 1) * px(at('.hcr-stats').gap)) / columns - 2 * px(at('.hcr-stat').padding.split(/\s+/)[1]) - 2;
    assert.ok(9 * 0.6 * px(at('.hcr-stat-value')['font-size']) <= stat, vw + 'px: ' + columns + ' stats of ' + stat.toFixed(1) + 'px');
    const mode = (content - 2 * px(at('.hcr-modes').gap)) / 3 - 2 * px(at('.hcr-mode').padding.split(/\s+/)[1]) - 2;
    assert.ok(6 * 0.62 * 0.95 * 16 <= mode, vw + 'px');
  }
  // No rule blocks page scrolling (no touch-action: none anywhere); the tap
  // targets take touch-action: manipulation, so a quick double tap on a key
  // types twice instead of zooming the page, and panning still works.
  assert.doesNotMatch(CSS, /touch-action:\s*none/);
  for (const vw of [320, 375, 414, 1280]) {
    for (const selector of ['.hcr-key', '.hcr-mode', '.hcr-btn']) {
      assert.equal(declsAt(rules, selector, vw)['touch-action'], 'manipulation', vw + 'px: ' + selector);
    }
    for (const selector of ['.hcr-wrapper', '.hcr-log', '.hcr-terminal', '.hcr-keypad']) {
      assert.equal(declsAt(rules, selector, vw)['touch-action'], undefined, vw + 'px: ' + selector + ' scrolls as usual');
    }
  }
  assert.equal((CSS.match(/touch-action:/g) || []).length, 3, 'only the three tap targets set touch-action');
  // Desktop: six stats in a row and 52 px keys.
  assert.equal(declsAt(rules, '.hcr-stats', 1280)['grid-template-columns'], 'repeat(6, minmax(0, 1fr))');
  assert.equal(declsAt(rules, '.hcr-wrapper', 1280)['--hcr-key-size'], '52px');
  assert.equal(declsAt(rules, '.hcr-wrapper', 1280).padding, '2rem 1rem');
});
