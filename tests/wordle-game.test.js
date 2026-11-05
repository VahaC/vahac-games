// tests/wordle-game.test.js
// Cyberpunk Wordle (wordle-game/, prefix wrd-).  Each test loads a fresh copy
// of script.js on a stub page built from index.html (htmlPageSpec), runs
// init() or calls the exported functions, and drives the listeners init
// registered the way a browser would: pressKey for the physical keyboard,
// focus + focusin + click() for a mouse click or tap (tap) and focus +
// focusin for the Tab key (tabTo), fire() for storage and visibilitychange
// events.  Results are read from the page, the wrdState
// getter and localStorage ('wrd-state').  Timers and Math.random are mocked.
// The pure rules (colouring, saves, clock text) are checked against exact
// values and an independent reference; the last tests read the source files.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, resetStubs, stubElement, createPage, loadWithPage, bootLikeBrowser,
  readRepoFile, htmlPageSpec, idsInHtml, embedMarkup, embedSafety, cssRules, declsAt,
  keyEvent, pressKey, fire, listenerCount, listenersOf, setVisibility
} = require('./_setup');

const SCRIPT = 'wordle-game/script.js';
const KEY = 'wrd-state';
const HTML = readRepoFile('wordle-game/index.html');
const CSS = readRepoFile('wordle-game/style.css');
const SOURCE = readRepoFile(SCRIPT);
const SPEC = htmlPageSpec(HTML);
const WORDS = loadScript(SCRIPT).wrdWords;
const PAGE_IDS = ['wrd-board', 'wrd-games-won', 'wrd-keyboard', 'wrd-new-game', 'wrd-restart-game', 'wrd-timer', 'wrd-toast'];

// Saves exactly as the previous version (commit a4cfbc5) wrote them.
const OLD_SAVES = {
  playing: '{"solution":"PLANT","guesses":["CRANE"],"current":"PL","timer":30,"wins":2,"finished":false}',
  won: '{"solution":"CRANE","guesses":["SLATE","CRANE"],"current":"","timer":65,"wins":3,"finished":true}',
  lost: '{"solution":"CRANE","guesses":["SLATE","BRINE","STONE","SHARE","GRACE","PLANT"],"current":"","timer":125,"wins":1,"finished":true}'
};
const SIX_MISSES = ['SLATE', 'BRINE', 'STONE', 'SHARE', 'GRACE', 'PLANT'];

test.beforeEach(() => resetStubs());

// A save text in the game's field order: an open round on CRANE by default.
function saveText(fields) {
  const state = Object.assign({ solution: 'CRANE', guesses: [], current: '', timer: 0, wins: 0, finished: false }, fields);
  return JSON.stringify({
    solution: state.solution, guesses: state.guesses, current: state.current,
    timer: state.timer, wins: state.wins, finished: state.finished
  });
}

function saved() {
  return JSON.parse(localStorage.getItem(KEY));
}

// The Math.random value that makes wrdPickWord draw `word`.
function randomFor(word) {
  const at = WORDS.indexOf(word);
  assert.ok(at >= 0, word + ' is in the list');
  return (at + 0.5) / WORDS.length;
}

// A fresh copy of the game on its own page, left installed (the script looks
// its elements up when it uses them).
function load() {
  const { exports: wrd, els, page } = loadWithPage(SCRIPT, SPEC, { keep: true });
  return { wrd, els, page };
}

// The page after init() with the clock mocked.  `save` is what localStorage
// holds first; a new game draws `answer`.
function start(t, options) {
  const { save, answer = 'PLANT' } = options || {};
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(Math, 'random', () => randomFor(answer));
  if (save !== undefined) localStorage.setItem(KEY, save);
  const game = load();
  game.wrd.init();
  return game;
}

// A page reload: the old copy's clock and listeners go, localStorage stays.
function reload(game) {
  const text = localStorage.getItem(KEY);
  if (game.wrd.wrdStopTimer) game.wrd.wrdStopTimer();
  resetStubs();
  if (text !== null) localStorage.setItem(KEY, text);
  const next = load();
  next.wrd.init();
  return next;
}

// Moves the focus the way a browser does: focusin, with the :focus-visible
// state the browser gives that way of focusing (false after a mouse click or
// a tap, true after Tab).  Focusing the focused element again fires nothing.
function moveFocus(el, byKeyboard) {
  if (document.activeElement === el) return;
  el.matches = (selector) => selector === ':focus-visible' && byKeyboard;
  el.focus();
  fire(el, 'focusin');
}

// A mouse click or a tap: the button takes the focus, then gets the click.
function tap(el) {
  moveFocus(el, false);
  el.click();
}

// The Tab key (or Shift+Tab) moving the focus to el.
function tabTo(el) {
  moveFocus(el, true);
}

// Physical typing (lower case, as a keyboard without Shift sends it).
function typeWord(word) {
  return word.split('').map((letter) => pressKey(letter.toLowerCase()));
}

function play(wrd, word) {
  word.split('').forEach((letter) => wrd.wrdHandleKey(letter));
  wrd.wrdHandleKey('ENTER');
}

function screenKey(els, label) {
  for (const row of els['wrd-keyboard'].children) {
    for (const key of row.children) {
      if (key.textContent === label) return key;
    }
  }
  throw new Error('no on-screen key ' + label);
}

function cells(els, row) {
  return els['wrd-board'].children.slice(row * 5, row * 5 + 5);
}

function rowText(els, row) {
  return cells(els, row).map((cell) => cell.textContent).join('');
}

// 'correct' | 'present' | 'absent' | '' for each cell of a row.
function rowColours(els, row) {
  return cells(els, row).map((cell) => cell.className.split(' ')
    .filter((name) => name !== 'wrd-cell').map((name) => name.replace(/^wrd-/, '')).join(' '));
}

// Stub elements are large cyclic objects: compare them by identity so a
// failure does not spend minutes printing a diff.
function focusIsOn(el) {
  return document.activeElement === el;
}

// ── Game rules ───────────────────────────────────────────────────────────────

test('wordle: the embedded word list is kept intact (701 five-letter words, slur removed)', () => {
  assert.equal(WORDS.length, 701);
  assert.equal(new Set(WORDS).size, 288);
  assert.ok(!WORDS.includes('KRAUT'), 'the ethnic slur is not a possible answer');
  assert.equal(WORDS[0], 'CRANE');
  assert.equal(WORDS[WORDS.length - 1], 'LASER');
  for (const word of WORDS) assert.match(word, /^[A-Z]{5}$/);
});

test('wordle: wrdPickWord draws the answer with Math.random, index by index', (t) => {
  const { wrd } = load();
  const random = t.mock.method(Math, 'random', () => 0);
  assert.equal(wrd.wrdPickWord(), 'CRANE');
  random.mock.mockImplementation(() => 0.999999);
  assert.equal(wrd.wrdPickWord(), 'LASER');
  random.mock.mockImplementation(() => 0.5);
  assert.equal(wrd.wrdPickWord(), 'METER');
  assert.equal(wrd.wrdWords[350], 'METER');
  random.mock.mockImplementation(() => 6 / 701);
  assert.equal(wrd.wrdPickWord(), 'PLANT', 'k / n draws index k');
  random.mock.mockImplementation(() => 6 / 701 - 1e-12);
  assert.equal(wrd.wrdPickWord(), 'GRACE', 'just below draws index k - 1');
});

// An independent reference for the standard rule, counted per letter: of the
// copies of a letter in the guess, as many are coloured as the solution has
// (exact matches first), the leftover misplaced ones in reading order.
function referenceScore(guess, solution) {
  const out = guess.split('').map((letter, i) => (letter === solution[i] ? 'correct' : 'absent'));
  for (const letter of new Set(guess)) {
    const inSolution = solution.split('').filter((c) => c === letter).length;
    const exact = out.filter((mark, i) => mark === 'correct' && guess[i] === letter).length;
    let left = inSolution - exact;
    for (let i = 0; i < 5 && left > 0; i++) {
      if (guess[i] === letter && out[i] === 'absent') {
        out[i] = 'present';
        left--;
      }
    }
  }
  return out;
}

const C = 'correct';
const P = 'present';
const A = 'absent';
const SCORED = [
  // [solution, guess, colours, what it shows]
  ['CRANE', 'TRACE', [A, C, C, P, C], 'plain mix'],
  ['CRANE', 'CRANE', [C, C, C, C, C], 'all correct'],
  ['CRANE', 'QQQQQ', [A, A, A, A, A], 'all absent'],
  ['CRANE', 'EERIE', [A, A, P, A, C], 'one E in the solution: only the exact E is coloured'],
  ['ABIDE', 'SPEED', [A, A, P, A, P], 'one E: only the first misplaced E is present'],
  ['HOTEL', 'LEVEL', [A, A, A, C, C], 'exact L and E use up the only copies'],
  ['LLAMA', 'ALLEY', [P, C, P, A, A], 'two Ls: one exact, one misplaced'],
  ['CRANE', 'NANNY', [A, P, A, C, A], 'an exact copy wins over an earlier misplaced one'],
  ['EERIE', 'EEEEE', [C, C, A, A, C], 'three exact Es, the other two absent'],
  ['SPEED', 'EERIE', [P, P, A, A, A], 'two Es in the solution colour two of three']
];

test('wordle: wrdScoreGuess colours repeated letters by the standard Wordle rule', () => {
  const { wrd } = load();
  for (const [solution, guess, expected, why] of SCORED) {
    assert.deepEqual(referenceScore(guess, solution), expected, 'reference: ' + why);
    assert.deepEqual(wrd.wrdScoreGuess(guess, solution), expected, guess + ' vs ' + solution + ': ' + why);
  }
  // 3000 pairs over a five-letter alphabet (lots of repeats), seeded
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const word = () => Array.from({ length: 5 }, () => 'ABCDE'[Math.floor(next() * 5)]).join('');
  for (let i = 0; i < 3000; i++) {
    const solution = word();
    const guess = word();
    assert.deepEqual(wrd.wrdScoreGuess(guess, solution), referenceScore(guess, solution), guess + ' vs ' + solution);
  }
});

test('wordle: wrdFormatTime writes mm:ss and keeps counting minutes past 59', () => {
  const { wrd } = load();
  const cases = [[0, '00:00'], [5, '00:05'], [10, '00:10'], [59, '00:59'], [60, '01:00'], [65, '01:05'],
    [599, '09:59'], [600, '10:00'], [3599, '59:59'], [3600, '60:00'], [6000, '100:00']];
  for (const [seconds, text] of cases) assert.equal(wrd.wrdFormatTime(seconds), text, String(seconds));
});

test('wordle: wrdOutcome tells a won, a lost and an open round apart', () => {
  const { wrd } = load();
  assert.equal(wrd.wrdOutcome({ solution: 'CRANE', guesses: [] }), null);
  assert.equal(wrd.wrdOutcome({ solution: 'CRANE', guesses: ['SLATE'] }), null);
  assert.equal(wrd.wrdOutcome({ solution: 'CRANE', guesses: ['SLATE', 'CRANE'] }), 'won');
  assert.equal(wrd.wrdOutcome({ solution: 'CRANE', guesses: SIX_MISSES }), 'lost');
  assert.equal(wrd.wrdOutcome({ solution: 'CRANE', guesses: SIX_MISSES.slice(0, 5).concat('CRANE') }), 'won', 'a sixth-guess hit is a win');
  assert.equal(wrd.wrdOutcome({ solution: '', guesses: [] }), null);
});

// Damaged saves: [what is wrong, save text, wins a fresh game keeps].
const DAMAGED = [
  ['invalid JSON', '{bad json', 0],
  ['null', 'null', 0],
  ['an array', '[]', 0],
  ['a string', '"CRANE"', 0],
  ['a number', '42', 0],
  ['an empty object', '{}', 0],
  ['only a solution', '{"solution":"CRANE"}', 0],
  ['guesses not an array', saveText({ guesses: 'SLATE', wins: 3 }), 3],
  ['a lower-case guess', saveText({ guesses: ['slate'], wins: 3 }), 3],
  ['a four-letter guess', saveText({ guesses: ['SLAT'], wins: 3 }), 3],
  ['a guess inside an array', saveText({ guesses: [['SLATE']], wins: 3 }), 3],
  ['seven guesses', saveText({ guesses: SIX_MISSES.concat('TRACK'), finished: true, wins: 3 }), 3],
  ['a lower-case solution', saveText({ solution: 'crane', wins: 3 }), 3],
  ['a six-letter solution', saveText({ solution: 'CRANES', wins: 3 }), 3],
  ['a solution inside an array', saveText({ solution: ['CRANE'], wins: 3 }), 3],
  ['no solution', saveText({ solution: '', wins: 3 }), 3],
  ['six typed letters', saveText({ current: 'PLANTS', wins: 3 }), 3],
  ['a digit typed', saveText({ current: 'P1', wins: 3 }), 3],
  ['lower-case typed letters', saveText({ current: 'pl', wins: 3 }), 3],
  ['typed letters inside an array', saveText({ current: ['PL'], wins: 3 }), 3],
  ['no timer', saveText({ timer: undefined, wins: 3 }), 3],
  ['the timer as text', saveText({ timer: '30', wins: 3 }), 3],
  ['a negative timer', saveText({ timer: -1, wins: 3 }), 3],
  ['a fractional timer', saveText({ timer: 1.5, wins: 3 }), 3],
  ['a timer of null (NaN once saved)', saveText({ timer: null, wins: 3 }), 3],
  ['wins as text', saveText({ wins: '3' }), 0],
  ['negative wins', saveText({ wins: -2 }), 0],
  ['fractional wins', saveText({ wins: 2.5 }), 0],
  ['wins of null', saveText({ wins: null }), 0],
  ['finished as text', saveText({ finished: 'false', wins: 3 }), 3],
  ['finished without a result', saveText({ guesses: ['SLATE'], finished: true, wins: 3 }), 3],
  ['a won round left open', saveText({ guesses: ['SLATE', 'CRANE'], wins: 3 }), 3],
  ['six misses left open', saveText({ guesses: SIX_MISSES, wins: 3 }), 3],
  ['a guess after the win', saveText({ guesses: ['CRANE', 'SLATE'], finished: true, wins: 3 }), 3],
  // would pass the `finished` check as a lost round with a green first row
  ['five guesses after a first-guess win', saveText({ guesses: ['CRANE'].concat(SIX_MISSES.slice(0, 5)), finished: true, wins: 3 }), 3],
  ['letters typed after the end', saveText({ guesses: ['CRANE'], current: 'PL', finished: true, wins: 3 }), 3]
];

test('wordle: wrdNormalizeState accepts only rounds the game could have saved', () => {
  const { wrd } = load();
  for (const text of Object.values(OLD_SAVES)) {
    const raw = JSON.parse(text);
    const state = wrd.wrdNormalizeState(raw);
    assert.deepEqual(state, raw);
    assert.notEqual(state, raw, 'a copy');
    assert.notEqual(state.guesses, raw.guesses, 'with its own guesses');
  }
  const withExtra = Object.assign(JSON.parse(OLD_SAVES.playing), { theme: 'dark' });
  assert.deepEqual(wrd.wrdNormalizeState(withExtra), JSON.parse(OLD_SAVES.playing), 'unknown fields are dropped');
  assert.equal(wrd.wrdNormalizeState(undefined), null);
  for (const [why, text] of DAMAGED) {
    let raw;
    try { raw = JSON.parse(text); } catch (e) { continue; }
    assert.equal(wrd.wrdNormalizeState(raw), null, why);
  }
});

// ── A round through the exported functions ───────────────────────────────────

test('wordle: a new game resets the round, keeps the wins, saves and draws an empty board and clock', (t) => {
  const { wrd, els } = load();
  t.mock.method(Math, 'random', () => 0);
  els['wrd-timer'].textContent = '01:06';
  Object.assign(wrd.wrdState, { solution: 'PLANT', guesses: ['SLATE'], current: 'AB', timer: 66, wins: 3, finished: true });

  wrd.wrdNewGame();

  const expected = { solution: 'CRANE', guesses: [], current: '', timer: 0, wins: 3, finished: false };
  assert.deepEqual(wrd.wrdState, expected);
  assert.deepEqual(saved(), expected);
  assert.equal(els['wrd-board'].children.length, 30);
  assert.ok(els['wrd-board'].children.every((cell) => cell.className === 'wrd-cell' && cell.textContent === ''));
  assert.equal(els['wrd-toast'].textContent, 'New game started');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 3');
  assert.equal(els['wrd-timer'].textContent, '00:00', 'the clock is reset on screen at once');
});

test('wordle: typing fills the row up to five letters, Backspace deletes, and only changes are saved', () => {
  const { wrd, els } = load();
  wrd.wrdNewGame();
  wrd.wrdState.solution = 'CRANE';

  'CRANES'.split('').forEach((letter) => wrd.wrdHandleKey(letter));
  assert.equal(wrd.wrdState.current, 'CRANE');
  assert.equal(rowText(els, 0), 'CRANE');
  assert.deepEqual(rowColours(els, 0), ['', '', '', '', ''], 'letters are not coloured before Enter');
  assert.equal(saved().current, 'CRANE');

  localStorage.setItem(KEY, 'marker');
  for (const key of ['S', '1', 'SHIFT', 'a', '', undefined]) wrd.wrdHandleKey(key);
  assert.equal(localStorage.getItem(KEY), 'marker', 'a sixth letter or a key the game does not play saves nothing');
  assert.equal(wrd.wrdState.current, 'CRANE');

  wrd.wrdHandleKey('BACKSPACE');
  assert.equal(wrd.wrdState.current, 'CRAN');
  assert.equal(rowText(els, 0), 'CRAN');
  assert.equal(saved().current, 'CRAN');

  'CRAN'.split('').forEach(() => wrd.wrdHandleKey('BACKSPACE'));
  localStorage.setItem(KEY, 'marker');
  wrd.wrdHandleKey('BACKSPACE');
  assert.equal(wrd.wrdState.current, '');
  assert.equal(localStorage.getItem(KEY), 'marker', 'Backspace on an empty row saves nothing');
});

test('wordle: Enter with fewer than five letters is refused, also right after a guess', () => {
  const { wrd, els } = load();
  wrd.wrdNewGame();
  wrd.wrdState.solution = 'CRANE';
  'CRA'.split('').forEach((letter) => wrd.wrdHandleKey(letter));
  wrd.wrdHandleKey('ENTER');
  assert.deepEqual(wrd.wrdState.guesses, []);
  assert.equal(wrd.wrdState.current, 'CRA');
  assert.equal(els['wrd-toast'].textContent, 'Enter a 5-letter word');

  'CRA'.split('').forEach(() => wrd.wrdHandleKey('BACKSPACE'));
  play(wrd, 'SLATE');
  wrd.wrdShowToast('');
  wrd.wrdHandleKey('ENTER');
  assert.deepEqual(wrd.wrdState.guesses, ['SLATE']);
  assert.equal(els['wrd-toast'].textContent, 'Enter a 5-letter word');
});

test('wordle: a submitted guess is coloured per letter and the next row shows the typing', () => {
  const { wrd, els } = load();
  wrd.wrdNewGame();
  wrd.wrdState.solution = 'CRANE';
  play(wrd, 'TRACE');

  assert.deepEqual(wrd.wrdState.guesses, ['TRACE']);
  assert.equal(wrd.wrdState.current, '');
  assert.equal(wrd.wrdState.finished, false);
  assert.equal(rowText(els, 0), 'TRACE');
  assert.deepEqual(rowColours(els, 0), ['absent', 'correct', 'correct', 'present', 'correct']);
  assert.deepEqual(rowColours(els, 2), ['', '', '', '', '']);

  wrd.wrdHandleKey('S');
  assert.equal(rowText(els, 1), 'S');
});

test('wordle: repeated letters on the board are coloured by the standard rule', () => {
  // The old board marked every misplaced copy present: EERIE against CRANE
  // came out present, present, present, absent, correct.
  for (const [solution, guess, expected] of SCORED) {
    resetStubs();
    const { wrd, els } = load();
    wrd.wrdNewGame();
    wrd.wrdState.solution = solution;
    play(wrd, guess);
    assert.deepEqual(rowColours(els, 0), expected, guess + ' vs ' + solution);
  }
});

test('wordle: any five letters count as a guess (no dictionary check)', () => {
  const { wrd, els } = load();
  wrd.wrdNewGame();
  wrd.wrdState.solution = 'CRANE';
  play(wrd, 'QQQQQ');
  assert.deepEqual(wrd.wrdState.guesses, ['QQQQQ']);
  assert.deepEqual(rowColours(els, 0), ['absent', 'absent', 'absent', 'absent', 'absent']);
});

test('wordle: guessing the word wins, counts the win once and locks the round', () => {
  const { wrd, els } = load();
  wrd.wrdNewGame();
  wrd.wrdState.solution = 'CRANE';
  play(wrd, 'SLATE');
  play(wrd, 'CRANE');

  assert.equal(wrd.wrdState.finished, true);
  assert.equal(wrd.wrdState.wins, 1);
  assert.equal(els['wrd-toast'].textContent, 'You win!');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 1');
  assert.deepEqual(rowColours(els, 1), ['correct', 'correct', 'correct', 'correct', 'correct']);
  assert.equal(saved().wins, 1);

  const before = localStorage.getItem(KEY);
  play(wrd, 'CRANE');
  wrd.wrdSubmitGuess();
  wrd.wrdHandleKey('BACKSPACE');
  assert.deepEqual(wrd.wrdState.guesses, ['SLATE', 'CRANE']);
  assert.equal(wrd.wrdState.current, '');
  assert.equal(wrd.wrdState.wins, 1);
  assert.equal(localStorage.getItem(KEY), before, 'a finished round saves nothing more');
});

test('wordle: six wrong guesses lose the round and reveal the word; a sixth-guess hit wins', () => {
  const { wrd, els } = load();
  wrd.wrdNewGame();
  wrd.wrdState.solution = 'CRANE';
  wrd.wrdState.wins = 2;

  SIX_MISSES.slice(0, 5).forEach((word) => play(wrd, word));
  assert.equal(wrd.wrdState.finished, false);
  play(wrd, SIX_MISSES[5]);
  assert.equal(wrd.wrdState.finished, true);
  assert.equal(wrd.wrdState.wins, 2);
  assert.equal(els['wrd-toast'].textContent, 'Game over! Word: CRANE');
  assert.deepEqual(wrd.wrdState.guesses, SIX_MISSES);
  play(wrd, 'CRANE');
  assert.equal(wrd.wrdState.guesses.length, 6);
  assert.equal(wrd.wrdState.wins, 2);

  wrd.wrdNewGame();
  wrd.wrdState.solution = 'CRANE';
  SIX_MISSES.slice(0, 5).forEach((word) => play(wrd, word));
  play(wrd, 'CRANE');
  assert.equal(wrd.wrdState.finished, true);
  assert.equal(wrd.wrdState.wins, 3);
  assert.equal(els['wrd-toast'].textContent, 'You win!');
});

test('wordle: the save keeps the old format and survives a reload', () => {
  const first = load();
  first.wrd.wrdNewGame();
  first.wrd.wrdState.solution = 'PLANT';
  first.wrd.wrdState.wins = 4;
  play(first.wrd, 'CRANE');
  first.wrd.wrdHandleKey('P');
  first.wrd.wrdHandleKey('L');
  assert.equal(localStorage.getItem(KEY),
    '{"solution":"PLANT","guesses":["CRANE"],"current":"PL","timer":0,"wins":4,"finished":false}');

  const text = localStorage.getItem(KEY);
  resetStubs();
  localStorage.setItem(KEY, text);
  const second = load();
  assert.equal(second.wrd.wrdState.solution, '', 'nothing is restored before wrdLoad');
  assert.equal(second.wrd.wrdLoad(), true);
  assert.deepEqual(second.wrd.wrdState, JSON.parse(text));
  second.wrd.wrdRenderBoard();
  assert.deepEqual(rowColours(second.els, 0), ['absent', 'absent', 'correct', 'correct', 'absent']);
  assert.equal(rowText(second.els, 1), 'PL');

  resetStubs();
  const third = load();
  assert.equal(third.wrd.wrdLoad(), false, 'no save: nothing to resume');
  assert.deepEqual(third.wrd.wrdState, { solution: '', guesses: [], current: '', timer: 0, wins: 0, finished: false });
});

// ── Start-up, saves and storage ──────────────────────────────────────────────

test('wordle: init starts a new game on a first visit', (t) => {
  const { wrd, els } = start(t);
  assert.equal(wrd.wrdState.solution, 'PLANT');
  assert.deepEqual(saved(), { solution: 'PLANT', guesses: [], current: '', timer: 0, wins: 0, finished: false });
  assert.equal(els['wrd-toast'].textContent, 'New game started');
  assert.equal(els['wrd-board'].children.length, 30);
  assert.equal(els['wrd-keyboard'].children.length, 4);
  assert.equal(els['wrd-timer'].textContent, '00:00');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 0');
});

test('wordle: saves written by the previous version resume with board, wins, clock and result', (t) => {
  // Before the fix a finished round came back with an empty message and the
  // clock at 00:00, so a lost round never showed its word again.
  let game = start(t, { save: OLD_SAVES.playing });
  let { wrd, els } = game;
  assert.deepEqual(wrd.wrdState, JSON.parse(OLD_SAVES.playing));
  assert.deepEqual(rowColours(els, 0), ['absent', 'absent', 'correct', 'correct', 'absent']);
  assert.equal(rowText(els, 1), 'PL');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 2');
  assert.equal(els['wrd-timer'].textContent, '00:30', 'the saved time shows at once');
  assert.equal(els['wrd-toast'].textContent, '', 'a resumed round shows no "New game started"');
  assert.equal(localStorage.getItem(KEY), OLD_SAVES.playing, 'loading rewrites nothing');
  typeWord('ant');
  pressKey('Enter');
  assert.equal(els['wrd-toast'].textContent, 'You win!');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 3');

  localStorage.setItem(KEY, OLD_SAVES.won);
  game = reload(game);
  ({ wrd, els } = game);
  assert.deepEqual(rowColours(els, 1), ['correct', 'correct', 'correct', 'correct', 'correct']);
  assert.equal(els['wrd-toast'].textContent, 'You win!');
  assert.equal(els['wrd-timer'].textContent, '01:05');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 3');
  assert.equal(pressKey('a').defaultPrevented, false, 'the finished round plays no keys');

  localStorage.setItem(KEY, OLD_SAVES.lost);
  game = reload(game);
  ({ wrd, els } = game);
  assert.deepEqual(SIX_MISSES.map((word, row) => rowText(els, row)), SIX_MISSES);
  assert.equal(els['wrd-toast'].textContent, 'Game over! Word: CRANE');
  assert.equal(els['wrd-timer'].textContent, '02:05');
  t.mock.timers.tick(3000);
  assert.equal(els['wrd-timer'].textContent, '02:05', 'a finished clock stays still');
});

test('wordle: a damaged save never throws; a fresh game starts and keeps usable wins', (t) => {
  // Before the fix '{bad json', 'null' or '"CRANE"' threw at load and left
  // the page without board or keyboard; '{}' showed "Wins: undefined".
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(Math, 'random', () => randomFor('PLANT'));
  for (const [why, text, wins] of DAMAGED) {
    resetStubs();
    localStorage.setItem(KEY, text);
    const { wrd, els } = load();
    assert.doesNotThrow(() => wrd.init(), why);
    assert.deepEqual(saved(), { solution: 'PLANT', guesses: [], current: '', timer: 0, wins, finished: false }, why);
    assert.equal(els['wrd-games-won'].textContent, 'Wins: ' + wins, why);
    assert.equal(els['wrd-board'].children.length, 30, why);
    assert.equal(els['wrd-keyboard'].children.length, 4, why);
    assert.equal(els['wrd-toast'].textContent, 'New game started', why);
    typeWord('plant');
    pressKey('Enter');
    assert.equal(wrd.wrdState.wins, wins + 1, why + ': the round can be won');
    wrd.wrdStopTimer();
  }
});

test('wordle: blocked or full storage never stops the game', (t) => {
  // Before the fix a blocked localStorage threw "The operation is insecure."
  // at load and on every key, and the page stayed empty.
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(Math, 'random', () => randomFor('PLANT'));
  const blocked = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
  const full = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };

  function playThrough(label) {
    const { wrd, els } = load();
    assert.doesNotThrow(() => wrd.init(), label);
    assert.equal(els['wrd-board'].children.length, 30, label);
    assert.equal(els['wrd-keyboard'].children.length, 4, label);
    typeWord('slate');
    pressKey('Enter');
    t.mock.timers.tick(2000);
    assert.equal(els['wrd-timer'].textContent, '00:02', label);
    fire(window, 'storage', { key: KEY, newValue: OLD_SAVES.won });
    assert.equal(els['wrd-toast'].textContent, 'You win!', label + ': another tab still reaches this one');
    tap(els['wrd-new-game']);
    typeWord('plant');
    pressKey('Enter');
    setVisibility('hidden', t);
    setVisibility('visible', t);
    assert.equal(wrd.wrdState.wins, 4, label);
    assert.equal(els['wrd-toast'].textContent, 'You win!', label);
    wrd.wrdStopTimer();
  }

  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: blocked });
  try {
    playThrough('site data blocked');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', storage);
  }

  resetStubs();
  localStorage.setItem(KEY, OLD_SAVES.playing);
  t.mock.method(localStorage, 'getItem', blocked);
  t.mock.method(localStorage, 'setItem', full);
  playThrough('getItem and setItem throwing');
});

test('wordle: with storage full but readable, a page shown again never rewinds to the older save', (t) => {
  // The save in storage stays at the old round, because every write fails.
  // Taking it over when the page is shown again would undo the winning guess.
  const { wrd, els } = start(t, { save: OLD_SAVES.playing });
  const setItem = t.mock.method(localStorage, 'setItem', () => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });
  typeWord('ant');
  pressKey('Enter');
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE', 'PLANT']);
  assert.equal(els['wrd-toast'].textContent, 'You win!');
  assert.ok(setItem.mock.callCount() > 0, 'the game tried to save');
  assert.equal(localStorage.getItem(KEY), OLD_SAVES.playing, 'storage still holds the old round');

  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE', 'PLANT']);
  assert.equal(wrd.wrdState.finished, true);
  assert.equal(wrd.wrdState.wins, 3);
  assert.equal(rowText(els, 1), 'PLANT');
  assert.equal(els['wrd-toast'].textContent, 'You win!');
  wrd.wrdStopTimer();
});

// ── The clock ────────────────────────────────────────────────────────────────

test('wordle: the clock counts mm:ss every second and stops when the round ends', (t) => {
  const { wrd, els } = start(t, { save: saveText({ solution: 'PLANT', timer: 3599 }) });
  assert.equal(els['wrd-timer'].textContent, '59:59');
  t.mock.timers.tick(999);
  assert.equal(els['wrd-timer'].textContent, '59:59');
  t.mock.timers.tick(1);
  assert.equal(wrd.wrdState.timer, 3600);
  assert.equal(els['wrd-timer'].textContent, '60:00');
  t.mock.timers.tick(65000);
  assert.equal(els['wrd-timer'].textContent, '61:05');

  typeWord('plant');
  pressKey('Enter');
  t.mock.timers.tick(5000);
  assert.equal(wrd.wrdState.timer, 3665);
  assert.equal(els['wrd-timer'].textContent, '61:05');
});

test('wordle: New Game shows 00:00 at once and restarts the clock, which never runs twice', (t) => {
  // Before the fix New Game left the old time on screen until the next tick,
  // that tick came after 0-1 s, and a second init() started a second clock.
  const { wrd, els } = start(t);
  t.mock.timers.tick(1500);
  assert.equal(els['wrd-timer'].textContent, '00:01');

  tap(els['wrd-new-game']);
  assert.equal(els['wrd-timer'].textContent, '00:00');
  t.mock.timers.tick(999);
  assert.equal(els['wrd-timer'].textContent, '00:00', 'the first second of the new round is a full one');
  t.mock.timers.tick(1);
  assert.equal(els['wrd-timer'].textContent, '00:01');

  wrd.init();
  wrd.init();
  tap(els['wrd-restart-game']);
  tap(els['wrd-new-game']);
  t.mock.timers.tick(1000);
  assert.equal(wrd.wrdState.timer, 1, 'one clock after three init() calls and several new games');

  wrd.wrdStopTimer();
  wrd.wrdStopTimer();
  t.mock.timers.tick(5000);
  assert.equal(wrd.wrdState.timer, 1, 'stopped');
});

test('wordle: the clock is saved with every change and when the page is hidden, not by a tick alone', (t) => {
  // A tick no longer writes the whole round, so a tab in the background
  // cannot overwrite what another tab saved (see the next tests).
  let game = start(t);
  t.mock.timers.tick(65000);
  assert.equal(saved().timer, 0, 'ticks write nothing');
  pressKey('a');
  assert.equal(saved().timer, 65, 'a change saves the time with it');
  t.mock.timers.tick(5000);
  setVisibility('hidden', t);
  assert.equal(saved().timer, 70, 'hiding the page (switch, close, reload) saves it');

  game = reload(game);
  assert.equal(game.els['wrd-timer'].textContent, '01:10');
  assert.equal(rowText(game.els, 0), 'A');
});

// ── Other tabs ───────────────────────────────────────────────────────────────

test('wordle: a round saved by another tab is taken over at once and never overwritten by this tab', (t) => {
  // Before the fix every open tab saved its own round each second, so a win
  // in one tab was overwritten by another within a second.
  const { wrd, els } = start(t, { save: saveText({ wins: 4 }) });
  typeWord('sl');
  const won = saveText({ guesses: ['SLATE', 'CRANE'], timer: 3, wins: 5, finished: true });
  localStorage.setItem(KEY, won); // the other tab's storage event is still on its way
  t.mock.timers.tick(5000);
  assert.equal(localStorage.getItem(KEY), won, 'this tab wrote nothing over it');

  fire(window, 'storage', { key: KEY, oldValue: null, newValue: won });
  assert.deepEqual(wrd.wrdState, JSON.parse(won));
  assert.equal(rowText(els, 1), 'CRANE');
  assert.equal(els['wrd-toast'].textContent, 'You win!');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 5');
  assert.equal(els['wrd-timer'].textContent, '00:03');

  const fresh = saveText({ solution: 'PLANT', wins: 5 });
  localStorage.setItem(KEY, fresh);
  fire(window, 'storage', { key: KEY, oldValue: won, newValue: fresh });
  assert.equal(els['wrd-toast'].textContent, 'New game started', 'a new round in the other tab shows here');
  assert.equal(rowText(els, 0), '');
  typeWord('pl');
  assert.equal(saved().current, 'PL', 'and is played on from here');

  const typed = saveText({ solution: 'PLANT', current: 'PLA', wins: 5 });
  fire(window, 'storage', { key: KEY, newValue: typed });
  assert.equal(rowText(els, 0), 'PLA');
  assert.equal(els['wrd-toast'].textContent, 'New game started', 'typing in the other tab keeps the message');
});

test('wordle: another tab can never lower the wins, and unrelated or broken writes are ignored', (t) => {
  const { wrd, els } = start(t, { save: saveText({ wins: 5 }) });
  const stale = saveText({ solution: 'PLANT', wins: 3 });
  fire(window, 'storage', { key: KEY, newValue: stale });
  assert.equal(wrd.wrdState.solution, 'PLANT');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 5');
  assert.equal(saved().wins, 5, 'the larger count is written back');

  const before = JSON.stringify(wrd.wrdState);
  const ignored = [
    { key: 'tf8-2048-game', newValue: saveText({ wins: 9 }) },
    { key: KEY, newValue: null },
    { key: null, newValue: null },
    { key: KEY, newValue: '{bad json' },
    { key: KEY, newValue: saveText({ guesses: ['CRANE', 'SLATE'], finished: true }) },
    { key: KEY, newValue: localStorage.getItem(KEY) }
  ];
  for (const event of ignored) {
    assert.doesNotThrow(() => fire(window, 'storage', event));
    assert.equal(JSON.stringify(wrd.wrdState), before, JSON.stringify(event));
  }
});

test('wordle: a page shown again picks up what other tabs saved while it slept', (t) => {
  const { wrd, els } = start(t);
  typeWord('cr');
  setVisibility('visible', t);
  assert.equal(wrd.wrdState.current, 'CR', 'nothing new: nothing changes');

  const elsewhere = saveText({ solution: 'PLANT', guesses: ['CRANE'], timer: 40, wins: 2 });
  localStorage.setItem(KEY, elsewhere); // its storage event never arrived (frozen or cached page)
  setVisibility('visible', t);
  assert.deepEqual(wrd.wrdState, JSON.parse(elsewhere));
  assert.equal(rowText(els, 0), 'CRANE');
  assert.equal(els['wrd-timer'].textContent, '00:40');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 2');
});

test('wordle: a page shown again with nothing new keeps its clock running', (t) => {
  // The save this tab loaded or took over is not taken over again, which
  // would wind the clock back to the saved time.
  const { wrd, els } = start(t, { save: saveText({ timer: 30 }) });
  t.mock.timers.tick(5000);
  setVisibility('visible', t);
  assert.equal(wrd.wrdState.timer, 35, 'the loaded save');

  const other = saveText({ solution: 'PLANT', timer: 40 });
  localStorage.setItem(KEY, other);
  fire(window, 'storage', { key: KEY, newValue: other });
  assert.equal(wrd.wrdState.timer, 40);
  t.mock.timers.tick(5000);
  setVisibility('visible', t);
  assert.equal(wrd.wrdState.timer, 45, 'a round taken over from another tab');
  assert.equal(els['wrd-timer'].textContent, '00:45');
});

// ── Keys, taps and focus through the real listeners ──────────────────────────

test('wordle: init registers each listener once, also when run again, and New Game adds none', (t) => {
  const { wrd, els } = start(t);
  const counts = () => [
    listenerCount(document, 'keydown'), listenerCount(document, 'focusin'),
    listenerCount(document, 'visibilitychange'), listenerCount(window, 'storage'),
    listenerCount(els['wrd-new-game'], 'click'), listenerCount(els['wrd-restart-game'], 'click')
  ];
  assert.deepEqual(counts(), [1, 1, 1, 1, 1, 1]);
  assert.equal(listenersOf(document, 'focusin')[0].capture, true, 'focusin is heard even if the host stops it');
  wrd.init();
  tap(els['wrd-new-game']);
  tap(els['wrd-restart-game']);
  wrd.wrdNewGame();
  assert.deepEqual(counts(), [1, 1, 1, 1, 1, 1]);
  assert.equal(els['wrd-keyboard'].children.length, 4, 'the keyboard is redrawn, not doubled');
});

test('wordle: the on-screen keyboard has three QWERTY rows plus Enter and Backspace', () => {
  const { wrd, els } = load();
  wrd.wrdRenderKeyboard();
  wrd.wrdRenderKeyboard();

  const rows = els['wrd-keyboard'].children;
  assert.equal(rows.length, 4, 'drawing again replaces the keys');
  assert.ok(rows.every((row) => row.className === 'wrd-key-row'));
  assert.deepEqual(rows.map((row) => row.children.map((key) => key.textContent).join('')),
    ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM', 'ENTER⌫']);
  assert.ok(rows.every((row) => row.children.every((key) => key.tagName === 'BUTTON')));
  assert.equal(rows[0].children[0].className, 'wrd-key');
  assert.equal(rows[3].children[0].className, 'wrd-key wrd-key-wide');
  assert.equal(rows[3].children[1].className, 'wrd-key wrd-key-wide');
});

test('wordle: every on-screen key plays its own letter, and Enter and Backspace work', (t) => {
  const { wrd, els } = start(t);
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    tap(screenKey(els, letter));
    assert.equal(wrd.wrdState.current, letter);
    tap(screenKey(els, '⌫'));
    assert.equal(wrd.wrdState.current, '');
  }
  'CRANX'.split('').forEach((letter) => tap(screenKey(els, letter)));
  tap(screenKey(els, '⌫'));
  tap(screenKey(els, 'E'));
  tap(screenKey(els, 'ENTER'));
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE']);
  assert.equal(wrd.wrdState.current, '');
});

test('wordle: physical letters, Enter and Backspace play the round and cancel their default action', (t) => {
  const { wrd, els } = start(t);
  assert.ok(typeWord('crane').every((event) => event.defaultPrevented));
  assert.equal(wrd.wrdState.current, 'CRANE', 'lower-case keys type capitals');
  assert.equal(pressKey('Backspace').defaultPrevented, true);
  assert.equal(wrd.wrdState.current, 'CRAN');
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.equal(els['wrd-toast'].textContent, 'Enter a 5-letter word');

  pressKey('E', { shiftKey: true });
  pressKey('Enter');
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE']);
  document.dispatchEvent(keyEvent('s'));
  assert.equal(wrd.wrdState.current, 'S', 'a key sent to the document itself plays too');
});

test('wordle: keys the game does not play keep their default action', (t) => {
  const { wrd } = start(t);
  typeWord('cr');
  for (const key of ['1', ' ', 'Tab', 'Shift', 'ArrowLeft', 'F5', 'Escape', 'é', 'Delete']) {
    assert.equal(pressKey(key).defaultPrevented, false, key);
  }
  assert.equal(wrd.wrdState.current, 'CR');
});

test('wordle: Ctrl, Cmd and Alt shortcuts are left to the browser', (t) => {
  const { wrd } = start(t);
  typeWord('cr');
  const shortcuts = [
    ['c', 'ctrlKey'], ['v', 'ctrlKey'], ['r', 'metaKey'], ['a', 'altKey'],
    ['Enter', 'ctrlKey'], ['Backspace', 'altKey'], ['Backspace', 'metaKey']
  ];
  for (const [key, modifier] of shortcuts) {
    assert.equal(pressKey(key, { [modifier]: true }).defaultPrevented, false, modifier + '+' + key);
  }
  assert.equal(wrd.wrdState.current, 'CR', 'Ctrl+C does not type C');
  assert.deepEqual(wrd.wrdState.guesses, []);
});

test('wordle: typing in an input, textarea, select or contenteditable on the page does not play', (t) => {
  const { wrd } = start(t);
  typeWord('cr');
  const editable = stubElement('div');
  editable.isContentEditable = true;
  const fields = [stubElement('input'), stubElement('textarea'), stubElement('select'), editable];
  fields.forEach((field) => document.body.appendChild(field));
  t.after(() => fields.forEach((field) => field.remove()));

  for (const target of fields) {
    assert.equal(wrd.wrdIsEditable(target), true, target.tagName);
    for (const key of ['a', 'Enter', 'Backspace']) {
      assert.equal(pressKey(key, { target }).defaultPrevented, false, target.tagName + ' ' + key);
    }
  }
  assert.equal(wrd.wrdState.current, 'CR');
  assert.deepEqual(wrd.wrdState.guesses, []);
  for (const other of [stubElement('button'), stubElement('div'), document.body, document, {}, null, undefined]) {
    assert.equal(wrd.wrdIsEditable(other), false);
  }
  assert.equal(wrd.wrdIsEditable({ isContentEditable: true }), true);
});

test('wordle: a keydown without a key (Chrome autofill) is ignored', (t) => {
  const { wrd } = start(t);
  typeWord('c');
  for (const key of [undefined, null, 13]) {
    assert.equal(pressKey(key).defaultPrevented, false, String(key));
  }
  assert.equal(wrd.wrdState.current, 'C');
});

// Elements of the host page (outside the game), appended to <body> and
// removed after the test: [tagName, attributes].
function hostElements(t, specs) {
  const list = specs.map(([tag, attributes]) => {
    const el = stubElement(tag);
    for (const [name, value] of Object.entries(attributes || {})) el.setAttribute(name, value);
    document.body.appendChild(el);
    return el;
  });
  t.after(() => list.forEach((el) => el.remove()));
  return list;
}

test('wordle: Enter on a link, button or summary of the host page reached with Tab is left to it', (t) => {
  // Before the fix the game cancelled that Enter (the link did not open) and
  // submitted the typed word instead, also for a user moving through the
  // host page with Tab.
  const { wrd, els } = start(t, { save: saveText({ current: 'PLANT' }) });
  const controls = hostElements(t, [
    ['a', { href: '#host-link' }], ['button'], ['summary'], ['area', { href: '#map' }],
    ['div', { role: 'button', tabindex: '0' }], ['span', { role: 'Link', tabindex: '0' }],
    ['li', { role: 'button menuitem', tabindex: '0' }]
  ]); // role tokens are compared without case; the first one counts
  for (const control of controls) {
    const name = control.tagName + ' ' + (control.getAttribute('role') || '');
    tabTo(control);
    assert.equal(pressKey('Enter').defaultPrevented, false, name);
    assert.equal(pressKey('Enter', { repeat: true }).defaultPrevented, false, name + ' held');
    assert.deepEqual(wrd.wrdState.guesses, [], name + ': nothing submitted');
    assert.ok(focusIsOn(control), name + ' keeps the focus');
  }

  // Enter anywhere else is the game's: a link without href, a focusable
  // container (a theme's <main tabindex="-1"> gets the focus when the board
  // is clicked), a non-interactive role, the page itself and the game's own
  // buttons.  The typed word is submitted and the focus stays.
  const others = hostElements(t, [['a'], ['div', { tabindex: '-1' }], ['main', { tabindex: '-1' }], ['span', { role: 'presentation' }]]);
  const expected = ['PLANT'];
  others.forEach((other, i) => {
    other.focus();
    assert.equal(pressKey('Enter').defaultPrevented, true, other.tagName);
    assert.deepEqual(wrd.wrdState.guesses, expected, other.tagName + ' submits the guess');
    assert.ok(focusIsOn(other), other.tagName + ' keeps the focus');
    typeWord(SIX_MISSES[i]);
    expected.push(SIX_MISSES[i]);
  });
  assert.ok(focusIsOn(others[3]), 'typing never moves the focus away from a non-control');

  // <html>: the stub path stops below it, so the listener is called directly
  document.documentElement = stubElement('html');
  t.after(() => { delete document.documentElement; });
  const onPage = keyEvent('Enter', { target: document.documentElement });
  wrd.wrdOnKeyDown(onPage);
  assert.equal(onPage.defaultPrevented, true);
  assert.deepEqual(wrd.wrdState.guesses, expected, 'Enter on the page itself submits');

  // The game's own buttons, known by id, by class, or by an ancestor (a
  // button without a prefix of its own inside the game) are not host
  // controls: Enter is the game's and never clicks them
  const [wrapper] = hostElements(t, [['div']]);
  wrapper.className = 'wrd-wrapper';
  const nested = wrapper.appendChild(stubElement('button'));
  for (const own of [els['wrd-new-game'], screenKey(els, 'Q'), nested]) {
    wrd.wrdShowToast('');
    tabTo(own);
    assert.equal(pressKey('Enter').defaultPrevented, true, own.id || own.className || 'nested');
    assert.equal(els['wrd-toast'].textContent, 'Enter a 5-letter word', 'the game took that Enter');
    assert.equal(wrd.wrdState.current, '', 'Q was not clicked');
    assert.equal(wrd.wrdState.guesses.length, 5, 'New Game was not clicked');
  }
  typeWord('grace');
  screenKey(els, 'Q').focus();
  assert.equal(pressKey('Enter').defaultPrevented, true, 'a focused on-screen key does not swallow the guess');
  assert.equal(wrd.wrdState.guesses.length, 6);
  assert.equal(els['wrd-toast'].textContent, 'Game over! Word: CRANE');
});

test('wordle: a letter or Backspace takes the focus from a host control, so the next Enter submits the guess', (t) => {
  // Review finding: a header button of the host page clicked with the mouse
  // keeps the focus in Chrome.  The typed word filled the row, but Enter
  // clicked that button again (the menu reopened) and the guess was lost.
  const { wrd, els } = start(t);
  const [menu, link] = hostElements(t, [['button', { id: 'menu-toggle' }], ['a', { href: '#search' }]]);
  let menuClicks = 0;
  menu.addEventListener('click', () => { menuClicks += 1; });
  tap(menu); // open the menu
  tap(menu); // and close it
  assert.equal(menuClicks, 2);
  assert.ok(focusIsOn(menu), 'a mouse click leaves the focus on the host button');

  assert.ok(typeWord('crane').every((event) => event.defaultPrevented));
  assert.ok(focusIsOn(document.body), 'the first letter took the focus');
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE']);
  assert.equal(menuClicks, 2, 'Enter did not click the menu again');

  typeWord('sl');
  link.focus();
  assert.equal(pressKey('Backspace').defaultPrevented, true);
  assert.equal(wrd.wrdState.current, 'S');
  assert.ok(focusIsOn(document.body), 'Backspace takes the focus too');

  // The game's own buttons keep the focus while the player types
  tabTo(els['wrd-new-game']);
  typeWord('x');
  assert.ok(focusIsOn(els['wrd-new-game']));
  pressKey('Backspace');
  pressKey('Backspace');

  // A finished round plays no keys: the host control keeps the focus and
  // Enter, also when it was clicked with the mouse (as in the previous version)
  typeWord('plant');
  pressKey('Enter');
  assert.equal(els['wrd-toast'].textContent, 'You win!');
  moveFocus(menu, false);
  assert.equal(pressKey('a').defaultPrevented, false);
  assert.ok(focusIsOn(menu));
  assert.equal(pressKey('Enter').defaultPrevented, false);
  assert.equal(menuClicks, 3, 'Enter clicked the menu');
  assert.equal(els['wrd-toast'].textContent, 'You win!');

  // Targets without getAttribute or blur (never seen in a browser) do not throw
  tap(els['wrd-new-game']);
  const noBlur = { tagName: 'BUTTON', getAttribute: () => null };
  assert.doesNotThrow(() => wrd.wrdOnKeyDown(keyEvent('a', { target: noBlur })));
  assert.equal(wrd.wrdState.current, 'A', 'a control without blur() still plays the letter');
  const bare = keyEvent('Enter', { target: { tagName: 'BUTTON' } });
  wrd.wrdOnKeyDown(bare);
  assert.equal(bare.defaultPrevented, true, 'an element without attributes is not a host control');
  assert.equal(els['wrd-toast'].textContent, 'Enter a 5-letter word');
});

test('wordle: Enter on a host control clicked with the mouse submits the guess; one reached with Tab keeps it', (t) => {
  // Review finding: typing a word, then clicking a host button (Chrome and
  // Firefox leave the focus on it) and pressing Enter clicked that button a
  // second time and lost the guess.  The previous version submitted it.
  const { wrd, els } = start(t);
  const [dark, link, other] = hostElements(t, [['button', { id: 'dark-toggle' }], ['a', { href: '#search' }], ['button']]);
  let darkClicks = 0;
  dark.addEventListener('click', () => { darkClicks += 1; });

  // Type, click the host button, Enter
  typeWord('crane');
  tap(dark);
  assert.equal(darkClicks, 1);
  assert.ok(focusIsOn(dark), 'the click left the focus on the host button');
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE'], 'the guess was submitted');
  assert.equal(darkClicks, 1, 'Enter did not click the button again');
  assert.ok(focusIsOn(document.body), 'the game took the focus from it');

  // A link clicked with the mouse is not followed again either
  typeWord('slate');
  tap(link);
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE', 'SLATE']);
  assert.ok(focusIsOn(document.body));

  // Type, click, type the last letter, Enter
  typeWord('ston');
  tap(dark);
  typeWord('e');
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE', 'SLATE', 'STONE']);
  assert.equal(darkClicks, 2);

  // A host control reached with Tab keeps its Enter, with the word typed
  typeWord('share');
  tabTo(other);
  assert.equal(pressKey('Enter').defaultPrevented, false, 'a host button reached with Tab keeps its Enter');
  assert.equal(wrd.wrdState.guesses.length, 3, 'nothing submitted');
  assert.ok(focusIsOn(other));

  // The last way the focus arrived counts: clicked, then left and reached
  // again with Tab and Shift+Tab, the button gets its Enter
  tap(dark);
  tabTo(link);
  tabTo(dark);
  assert.equal(pressKey('Enter').defaultPrevented, false);
  assert.equal(darkClicks, 4, 'Enter clicked the button reached with Tab');
  assert.equal(wrd.wrdState.guesses.length, 3);

  // A browser without :focus-visible (the selector throws) or an element
  // without matches() cannot tell: the host control keeps its Enter, as
  // when it was reached with Tab
  const unsupported = [() => { throw new SyntaxError("':focus-visible' is not a valid selector"); }, undefined];
  for (const matches of unsupported) {
    tap(other);
    dark.matches = matches;
    dark.focus();
    fire(dark, 'focusin');
    assert.equal(pressKey('Enter').defaultPrevented, false, String(matches));
  }
  assert.equal(darkClicks, 6);
  assert.equal(wrd.wrdState.guesses.length, 3);
  assert.equal(wrd.wrdState.current, 'SHARE');
});

test('wordle: a click or tap gives the focus back, so Space or Enter never clicks that button again', (t) => {
  // Before the fix the button kept the focus: Space after tapping A typed
  // "AA", Enter typed a stray E after tapping E, and Space on a clicked New
  // Game threw the round away.
  const { wrd, els } = start(t);
  tap(screenKey(els, 'A'));
  assert.equal(pressKey(' ').defaultPrevented, false);
  assert.equal(wrd.wrdState.current, 'A', 'Space did not click A again');
  assert.ok(focusIsOn(document.body), 'the key gave the focus back');
  pressKey('Backspace');

  'CRANE'.split('').forEach((letter) => tap(screenKey(els, letter)));
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE']);
  assert.equal(rowText(els, 1), '', 'no stray E');

  for (const id of ['wrd-new-game', 'wrd-restart-game']) {
    tap(els[id]);
    assert.deepEqual(wrd.wrdState.guesses, [], id + ' starts a new round');
    typeWord('slate');
    assert.equal(pressKey('Enter').defaultPrevented, true);
    typeWord('pl');
    pressKey(' ');
    pressKey('Enter');
    assert.deepEqual(wrd.wrdState.guesses, ['SLATE'], id + ' was not clicked again');
    assert.equal(wrd.wrdState.current, 'PL');
    assert.ok(focusIsOn(document.body), id + ' gave the focus back');
  }
});

test('wordle: buttons used from the keyboard keep the focus', (t) => {
  const { wrd, els } = start(t);
  for (const el of [screenKey(els, 'Q'), els['wrd-new-game']]) {
    tabTo(el);
    fire(el, 'click', { detail: 0 });
    assert.ok(focusIsOn(el), el.textContent || el.id);
  }
  assert.equal(wrd.wrdState.current, '');
  assert.equal(els['wrd-toast'].textContent, 'New game started');
});

test('wordle: a held Enter plays nothing more, so the result of the round stays on screen', (t) => {
  // Before the fix the auto-repeat of the Enter that ended the round clicked
  // a focused New Game, and the win message or the revealed word vanished.
  const { wrd, els } = start(t);
  tabTo(els['wrd-new-game']);
  typeWord('plant');
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.equal(els['wrd-toast'].textContent, 'You win!');
  assert.equal(pressKey('Enter', { repeat: true }).defaultPrevented, true);
  assert.equal(els['wrd-toast'].textContent, 'You win!');
  assert.deepEqual(wrd.wrdState.guesses, ['PLANT']);

  tap(els['wrd-restart-game']);
  typeWord('slate');
  pressKey('Enter');
  typeWord('brine');
  pressKey('Enter', { repeat: true });
  assert.deepEqual(wrd.wrdState.guesses, ['SLATE'], 'a repeat never submits');
  pressKey('Enter');
  ['STONE', 'SHARE', 'GRACE', 'TRACK'].forEach((word) => { typeWord(word); pressKey('Enter'); });
  assert.equal(els['wrd-toast'].textContent, 'Game over! Word: PLANT');
  pressKey('Enter');
  assert.equal(els['wrd-toast'].textContent, 'Game over! Word: PLANT', 'a second Enter after a mouse click on Restart');
});

test('wordle: held letters and Backspace keep playing; only a held Enter is ignored', (t) => {
  // Holding Backspace clears the row letter by letter, as before
  const { wrd } = start(t);
  typeWord('crane');
  for (let i = 0; i < 3; i++) {
    assert.equal(pressKey('Backspace', { repeat: true }).defaultPrevented, true);
  }
  assert.equal(wrd.wrdState.current, 'CR');
  assert.equal(pressKey('s', { repeat: true }).defaultPrevented, true);
  assert.equal(pressKey('s', { repeat: true }).defaultPrevented, true);
  assert.equal(wrd.wrdState.current, 'CRSS');
  pressKey('t');
  assert.equal(pressKey('Enter', { repeat: true }).defaultPrevented, true);
  assert.deepEqual(wrd.wrdState.guesses, []);
  assert.equal(wrd.wrdState.current, 'CRSST');
});

test('wordle: once the round is over, Enter on a focused New Game button starts a new game', (t) => {
  const { wrd, els } = start(t);
  typeWord('plant');
  pressKey('Enter');
  assert.equal(wrd.wrdState.finished, true);

  assert.equal(pressKey('a').defaultPrevented, false, 'a finished round plays no keys');
  tabTo(els['wrd-new-game']);
  assert.equal(pressKey('Enter').defaultPrevented, false);
  assert.equal(wrd.wrdState.finished, false);
  assert.deepEqual(wrd.wrdState.guesses, []);
  assert.equal(wrd.wrdState.wins, 1);
  assert.equal(els['wrd-toast'].textContent, 'New game started');
});

// ── Loading the script ───────────────────────────────────────────────────────

test('wordle: under Node, require() runs no init: no lookups, listeners or timers', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const { page } = load();
  assert.deepEqual(page.requested, [], 'no element is looked up while loading');
  assert.equal(listenerCount(document), 0, 'no document listener');
  assert.equal(listenerCount(window, 'storage'), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
});

test('wordle: in a browser, init runs at once when the page is already parsed', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(Math, 'random', () => randomFor('PLANT'));
  const { els } = bootLikeBrowser(SCRIPT, SPEC);
  assert.equal(els['wrd-board'].children.length, 30);
  assert.equal(els['wrd-keyboard'].children.length, 4);
  assert.equal(els['wrd-toast'].textContent, 'New game started');
  assert.equal(saved().solution, 'PLANT');
  assert.equal(listenerCount(document, 'keydown'), 1);
  typeWord('plant');
  pressKey('Enter');
  assert.equal(els['wrd-toast'].textContent, 'You win!');
});

test('wordle: loaded in <head>, the game starts on DOMContentLoaded once the markup exists', (t) => {
  // Before the fix the elements were looked up while the script loaded, so
  // init threw "Cannot set properties of null" when the script ran early.
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(Math, 'random', () => randomFor('PLANT'));
  const body = createPage(SPEC); // the markup, not parsed yet
  const boot = bootLikeBrowser(SCRIPT, [], { readyState: 'loading' });
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(document, 'keydown'), 0, 'nothing runs before DOMContentLoaded');

  body.install();
  boot.ready();
  assert.equal(body.els['wrd-board'].children.length, 30);
  assert.equal(body.els['wrd-keyboard'].children.length, 4);
  t.mock.timers.tick(1000);
  assert.equal(body.els['wrd-timer'].textContent, '00:01');
  pressKey('q');
  assert.equal(rowText(body.els, 0), 'Q');
});

// ── Source files ─────────────────────────────────────────────────────────────

test('wordle: every id the script uses exists exactly once in index.html', (t) => {
  const ids = idsInHtml(HTML);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual([...ids].sort(), PAGE_IDS);
  const { page, els } = start(t);
  typeWord('crane');
  pressKey('Enter');
  tap(els['wrd-restart-game']);
  t.mock.timers.tick(1000);
  assert.deepEqual([...new Set(page.requested)].sort(), PAGE_IDS);
});

// The source with comments and string literals blanked.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '\'\'')
    .replace(/\/\/.*$/gm, '');
}

test('wordle: script.js is one strict ES5 IIFE with the vahac start-up guard', () => {
  const code = codeOnly(SOURCE);
  const banned = [['let', /\blet\b/], ['const', /\bconst\b/], ['arrow function', /=>/], ['class', /\bclass\b/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread', /\.\.\./], ['double quotes', /"/]];
  for (const [what, pattern] of banned) assert.doesNotMatch(code, pattern, what);
  const text = SOURCE.replace(/\r\n/g, '\n');
  assert.match(text, /^(\/\/.*\n)+\(function \(\) \{\n {2}'use strict';\n/);
  assert.match(text, /\n\}\)\(\);\n$/);
  assert.equal(text.split('(function () {').length, 2, 'one IIFE');
  assert.ok(text.includes("  if (document.readyState === 'loading') {\n    document.addEventListener('DOMContentLoaded', init);\n" +
    "  } else if (typeof module === 'undefined' || !module.exports) {\n    init();\n  }"), 'the start-up guard build-embed looks for');
  assert.doesNotMatch(SOURCE, /\\u[0-9a-fA-F]{4}/, 'no \\u escapes');
});

test('wordle: every id, class, CSS variable and storage key carries the wrd- prefix', (t) => {
  for (const id of idsInHtml(HTML)) assert.match(id, /^wrd-/, id);
  const markup = embedMarkup(HTML);
  for (const [, names] of markup.matchAll(/class="([^"]*)"/g)) {
    for (const name of names.split(/\s+/)) assert.match(name, /^wrd-/, 'index.html class ' + name);
  }
  const rules = cssRules(CSS);
  const cssClasses = new Set();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      for (const [, , name] of selector.matchAll(/([.#])([\w-]+)/g)) {
        assert.match(name, /^wrd-/, 'style.css selector ' + selector);
        cssClasses.add(name);
      }
      assert.match(selector, /^[.#]wrd-/, 'every selector starts at a wrd- class or id: ' + selector);
    }
  }
  for (const [name] of CSS.matchAll(/--[\w-]+/g)) assert.match(name, /^--wrd-/, name);
  for (const [, literal] of SOURCE.matchAll(/'(wrd-[^']*)'/g)) {
    for (const name of literal.split(' ')) {
      assert.ok(name === 'wrd-' || name === KEY || PAGE_IDS.includes(name) || cssClasses.has(name),
        'script.js string ' + name + ' is a page id, a styled class or the storage key');
    }
  }

  // every class the game puts on the page is styled
  const { els } = start(t, { answer: 'CRANE' });
  typeWord('trace');
  pressKey('Enter');
  const used = new Set();
  const collect = (el) => {
    el.className.split(/\s+/).filter(Boolean).forEach((name) => used.add(name));
    el.children.forEach(collect);
  };
  els['wrd-board'].children.forEach(collect);
  els['wrd-keyboard'].children.forEach(collect);
  for (const name of used) assert.ok(cssClasses.has(name), name + ' is styled');
  assert.deepEqual([...used].sort(), ['wrd-absent', 'wrd-cell', 'wrd-correct', 'wrd-key', 'wrd-key-row', 'wrd-key-wide', 'wrd-present']);
  assert.equal(localStorage.length, 1);
  assert.equal(localStorage.key(0), KEY, 'the only storage key');
});

test('wordle: script.js, style.css and the embedded markup are safe inside the WordPress block', () => {
  assert.deepEqual(embedSafety(SOURCE), []);
  assert.deepEqual(embedSafety(CSS), []);
  const markup = embedMarkup(HTML);
  assert.ok(markup.startsWith('<div class="wrd-wrapper"'));
  assert.deepEqual(embedSafety(markup), []);
  assert.doesNotMatch(markup, /<(style|script)\b/i);
});

test('wordle: index.html paints the standalone page in the wrapper colour, from <head> only', () => {
  // Opened on its own the page had a transparent body with an 8px margin.
  // build-embed copies index.html from the wrapper to the first <script>, so
  // this rule never reaches WordPress.
  const rule = '<style>body { margin: 0; background: #0a0f1e; }</style>';
  assert.match(HTML, /<link rel="stylesheet" href="style\.css">\r?\n {2}<style>body \{ margin: 0; background: #0a0f1e; \}<\/style>\r?\n<\/head>/);
  assert.equal(HTML.split(rule).length, 2, 'the rule appears once');
  const wrapperAt = HTML.indexOf('<div class="wrd-wrapper"');
  assert.ok(HTML.indexOf(rule) < HTML.indexOf('</head>') && HTML.indexOf('</head>') < wrapperAt);
  assert.doesNotMatch(HTML.slice(wrapperAt, HTML.indexOf('<script', wrapperAt)), /<style/i);

  const wrapper = declsAt(cssRules(CSS), '.wrd-wrapper', 1280);
  assert.equal(wrapper['--wrd-bg'], '#0a0f1e', 'same colour as the wrapper');
  assert.equal(wrapper.background, 'linear-gradient(180deg, var(--wrd-bg), var(--wrd-panel))');
  assert.equal(wrapper['--wrd-panel'], '#111827');
  assert.doesNotMatch(CSS, /^\s*(html|body)\b[^{]*\{/m, 'style.css keeps no bare html/body rule');
});

test('wordle: on phones every keyboard row fits a 320-414px screen with keys about 28px or wider', () => {
  // Before the fix the 10-key row was 512px wide (44px keys, 8px gaps), so at
  // 375px Q, W, A and S sat off the left edge.  This works the phone rules
  // through for each screen width; it is arithmetic, not a browser layout.
  const rules = cssRules(CSS);
  const desktop = declsAt(rules, '.wrd-key', 1280);
  assert.equal(desktop['min-width'], '44px');
  assert.equal(desktop.flex, undefined, 'desktop keys keep their natural size');

  for (const screen of [320, 360, 375, 414, 640]) {
    const wrapper = declsAt(rules, '.wrd-wrapper', screen);
    const row = declsAt(rules, '.wrd-key-row', screen);
    const key = declsAt(rules, '.wrd-key', screen);
    const wide = declsAt(rules, '.wrd-key-wide', screen);

    assert.equal(wrapper.padding, '16px 8px');
    const sidePadding = parseFloat(wrapper.padding.split(/\s+/)[1]);
    const gap = parseFloat(row.gap);
    assert.equal(gap, 3);
    assert.equal(key['min-width'], '0', 'keys may shrink below the 44px desktop size');
    const basis = key.flex.match(/^0 1 calc\(\(100% - (\d+)px\) \/ 10\)$/);
    assert.ok(basis, 'each key takes a tenth of the row: ' + key.flex);
    assert.equal(Number(basis[1]), 9 * gap, 'the basis leaves room for the nine gaps of the QWERTY row');
    const maxKey = parseFloat(key['max-width']);
    const wideKey = parseFloat(wide['max-width']);
    assert.equal(maxKey, 44);
    assert.equal(wide.flex, '0 1 ' + wide['max-width']);
    assert.equal(wideKey, 120);

    const rowWidth = screen - 2 * sidePadding;
    const keyWidth = Math.min(maxKey, (rowWidth - 9 * gap) / 10);
    for (const keys of [10, 9, 7]) {
      assert.ok(keys * keyWidth + (keys - 1) * gap <= rowWidth + 0.001, screen + 'px: a ' + keys + '-key row fits');
    }
    assert.ok(2 * wideKey + gap <= rowWidth, screen + 'px: ENTER and Backspace fit');
    assert.ok(keyWidth >= 27.5, screen + 'px: keys are ' + keyWidth.toFixed(1) + 'px wide');
  }
});
