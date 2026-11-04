// tests/wordle-game.test.js
// Cyberpunk Wordle (wordle-game/, prefix wrd-).  script.js finds its elements
// by id while it loads, so every test loads a fresh copy with
// document.getElementById returning stub elements, then plays through the
// exported functions and reads the result back from those stubs, the state and
// localStorage ('wrd-state').  Key presses go through the real document keydown
// listener (see press below), and the last tests read index.html and style.css.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScript, stubElement, resetStubs } = require('./_setup');

const STORAGE_KEY = 'wrd-state';
const realGetElementById = document.getElementById;
const realCreateElement = document.createElement;
const realAddEventListener = document.addEventListener;

test.after(() => {
  document.getElementById = realGetElementById;
  document.createElement = realCreateElement;
  document.addEventListener = realAddEventListener;
});

function readGameFile(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'wordle-game', name), 'utf8');
}

// _setup's addEventListener and click() are no-ops.  Record the listeners
// instead, so click() runs them as a tap on the button would.
function listening(el) {
  el.listeners = {};
  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.click = () => (el.listeners.click || []).forEach((fn) => fn({ type: 'click', target: el }));
  return el;
}

// A fresh game instance with its own elements.  keepStorage leaves the saved
// game in localStorage, as a page reload would.  game.keydown collects the
// document keydown listeners and game.focused is the element with the focus.
function freshGame(options) {
  if (!options || !options.keepStorage) resetStubs();
  const els = {};
  const game = { els, keydown: [], focused: null };
  document.getElementById = (id) => {
    if (!els[id]) {
      els[id] = listening(stubElement(/^wrd-(new|restart)-game$/.test(id) ? 'button' : 'div'));
      els[id].id = id;
    }
    return els[id];
  };
  document.createElement = (tag) => listening(realCreateElement(tag));
  document.addEventListener = (type, fn) => {
    if (type === 'keydown') game.keydown.push(fn);
  };
  game.wrd = loadScript('wordle-game/script.js');
  return game;
}

// The page after init, with a known answer.  init starts the 1 s timer, so
// setInterval is mocked for the test.
function startedGame(t, solution) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const game = freshGame();
  game.wrd.init();
  game.wrd.wrdState.solution = solution;
  return game;
}

// A physical key press: the document keydown listeners run, then the browser's
// default action unless a listener called preventDefault (Enter clicks the
// focused button).  extra overrides fields of the event (target, ctrlKey ...).
function press(game, key, extra) {
  const event = Object.assign({
    type: 'keydown',
    key,
    target: game.focused || document.body,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
  }, extra);
  game.keydown.forEach((fn) => fn(event));
  if (!event.defaultPrevented && key === 'Enter' && event.target.tagName === 'BUTTON') {
    event.target.click();
  }
  return event;
}

function pressAll(game, keys) {
  return keys.split('').map((key) => press(game, key));
}

// A tap on a button runs its click listeners, and the button keeps the focus.
function tap(game, button) {
  game.focused = button;
  button.click();
}

function screenKey(els, label) {
  for (const row of els['wrd-keyboard'].children) {
    for (const key of row.children) {
      if (key.textContent === label) return key;
    }
  }
  throw new Error('no on-screen key ' + label);
}

// Start a round whose answer is known.
function startRound(wrd, solution) {
  wrd.wrdNewGame();
  wrd.wrdState.solution = solution;
}

function play(wrd, word) {
  word.split('').forEach((letter) => wrd.wrdHandleKey(letter));
  wrd.wrdHandleKey('ENTER');
}

function cells(els, row) {
  return els['wrd-board'].children.slice(row * 5, row * 5 + 5);
}

function rowText(els, row) {
  return cells(els, row).map((cell) => cell.textContent).join('');
}

// 'correct' | 'present' | 'absent' | '' for each cell of a row.
function rowColours(els, row) {
  return cells(els, row).map((cell) => cell.className.replace('wrd-cell', '').replace('wrd-', '').trim());
}

function saved() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY));
}

test('wordle: the embedded word list is kept intact (702 five-letter words)', () => {
  const { wrd } = freshGame();
  assert.equal(wrd.wrdWords.length, 702);
  assert.equal(new Set(wrd.wrdWords).size, 289);
  assert.equal(wrd.wrdWords[0], 'CRANE');
  assert.equal(wrd.wrdWords[wrd.wrdWords.length - 1], 'LASER');
  for (const word of wrd.wrdWords) assert.match(word, /^[A-Z]{5}$/);
});

test('wordle: wrdPickWord picks the answer with Math.random', (t) => {
  const { wrd } = freshGame();
  const random = t.mock.method(Math, 'random', () => 0);
  assert.equal(wrd.wrdPickWord(), 'CRANE');
  random.mock.mockImplementation(() => 0.999999);
  assert.equal(wrd.wrdPickWord(), 'LASER');
  random.mock.mockImplementation(() => 0.5);
  assert.equal(wrd.wrdPickWord(), wrd.wrdWords[351]);
  assert.equal(wrd.wrdPickWord(), 'NINJA');
});

test('wordle: a new game resets the round, keeps the wins, saves and draws an empty 6x5 board', (t) => {
  const { wrd, els } = freshGame();
  t.mock.method(Math, 'random', () => 0);
  Object.assign(wrd.wrdState, { solution: 'PLANT', guesses: ['SLATE'], current: 'AB', timer: 42, wins: 3, finished: true });

  wrd.wrdNewGame();

  const expected = { solution: 'CRANE', guesses: [], current: '', timer: 0, wins: 3, finished: false };
  assert.deepEqual(wrd.wrdState, expected);
  assert.deepEqual(saved(), expected);
  assert.equal(els['wrd-board'].children.length, 30);
  assert.ok(els['wrd-board'].children.every((cell) => cell.className === 'wrd-cell' && cell.textContent === ''));
  assert.equal(els['wrd-toast'].textContent, 'New game started');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 3');
});

test('wordle: typing fills the current row up to five letters, Backspace deletes, other keys do nothing', () => {
  const { wrd, els } = freshGame();
  startRound(wrd, 'CRANE');

  'CRANES'.split('').forEach((letter) => wrd.wrdHandleKey(letter));
  assert.equal(wrd.wrdState.current, 'CRANE');
  assert.equal(rowText(els, 0), 'CRANE');
  assert.deepEqual(rowColours(els, 0), ['', '', '', '', ''], 'letters are not coloured before Enter');

  wrd.wrdHandleKey('BACKSPACE');
  wrd.wrdHandleKey('1');
  wrd.wrdHandleKey('SHIFT');
  assert.equal(wrd.wrdState.current, 'CRAN');
  assert.equal(rowText(els, 0), 'CRAN');
  assert.equal(saved().current, 'CRAN');
});

test('wordle: Enter with fewer than five letters is refused', () => {
  const { wrd, els } = freshGame();
  startRound(wrd, 'CRANE');
  'CRA'.split('').forEach((letter) => wrd.wrdHandleKey(letter));
  wrd.wrdHandleKey('ENTER');
  assert.deepEqual(wrd.wrdState.guesses, []);
  assert.equal(wrd.wrdState.current, 'CRA');
  assert.equal(els['wrd-toast'].textContent, 'Enter a 5-letter word');
});

test('wordle: a submitted guess is coloured correct, present or absent per letter', () => {
  const { wrd, els } = freshGame();
  startRound(wrd, 'CRANE');
  play(wrd, 'TRACE');

  assert.deepEqual(wrd.wrdState.guesses, ['TRACE']);
  assert.equal(wrd.wrdState.current, '');
  assert.equal(wrd.wrdState.finished, false);
  assert.equal(rowText(els, 0), 'TRACE');
  assert.deepEqual(rowColours(els, 0), ['absent', 'correct', 'correct', 'present', 'correct']);

  wrd.wrdHandleKey('S');
  assert.equal(rowText(els, 1), 'S', 'the next row shows what is being typed');
});

test('wordle: duplicate letters are coloured one by one (staging behaviour, not the NYT rule)', () => {
  // CRANE has one E, yet every misplaced E in EERIE is marked present.
  // The NYT rule would give absent, absent, present, absent, correct.
  const { wrd, els } = freshGame();
  startRound(wrd, 'CRANE');
  play(wrd, 'EERIE');
  assert.deepEqual(rowColours(els, 0), ['present', 'present', 'present', 'absent', 'correct']);
});

test('wordle: any five letters count as a guess (no dictionary check)', () => {
  const { wrd, els } = freshGame();
  startRound(wrd, 'CRANE');
  play(wrd, 'QQQQQ');
  assert.deepEqual(wrd.wrdState.guesses, ['QQQQQ']);
  assert.deepEqual(rowColours(els, 0), ['absent', 'absent', 'absent', 'absent', 'absent']);
});

test('wordle: guessing the word wins, counts the win once and locks the round', () => {
  const { wrd, els } = freshGame();
  startRound(wrd, 'CRANE');
  play(wrd, 'SLATE');
  play(wrd, 'CRANE');

  assert.equal(wrd.wrdState.finished, true);
  assert.equal(wrd.wrdState.wins, 1);
  assert.equal(els['wrd-toast'].textContent, 'You win!');
  assert.equal(els['wrd-games-won'].textContent, 'Wins: 1');
  assert.deepEqual(rowColours(els, 1), ['correct', 'correct', 'correct', 'correct', 'correct']);
  assert.equal(saved().wins, 1);

  play(wrd, 'CRANE');
  wrd.wrdSubmitGuess();
  assert.deepEqual(wrd.wrdState.guesses, ['SLATE', 'CRANE']);
  assert.equal(wrd.wrdState.current, '');
  assert.equal(wrd.wrdState.wins, 1);
});

test('wordle: six wrong guesses lose the round and reveal the word', () => {
  const { wrd, els } = freshGame();
  startRound(wrd, 'CRANE');
  wrd.wrdState.wins = 2;
  const wrong = ['SLATE', 'BRINE', 'STONE', 'SHARE', 'GRACE', 'PLANT'];

  wrong.slice(0, 5).forEach((word) => play(wrd, word));
  assert.equal(wrd.wrdState.finished, false);

  play(wrd, wrong[5]);
  assert.equal(wrd.wrdState.finished, true);
  assert.equal(wrd.wrdState.wins, 2);
  assert.equal(els['wrd-toast'].textContent, 'Game over! Word: CRANE');
  assert.deepEqual(wrd.wrdState.guesses, wrong);

  play(wrd, 'CRANE');
  assert.equal(wrd.wrdState.guesses.length, 6);
  assert.equal(wrd.wrdState.wins, 2);
});

test('wordle: the game survives a reload through localStorage', () => {
  const first = freshGame();
  startRound(first.wrd, 'CRANE');
  first.wrd.wrdState.wins = 4;
  play(first.wrd, 'TRACE');
  'PL'.split('').forEach((letter) => first.wrd.wrdHandleKey(letter));
  const before = JSON.parse(JSON.stringify(first.wrd.wrdState));
  assert.deepEqual(saved(), before);

  const second = freshGame({ keepStorage: true });
  assert.equal(second.wrd.wrdState.solution, '', 'nothing is restored before wrdLoad');
  second.wrd.wrdLoad();
  assert.deepEqual(second.wrd.wrdState, before);
  second.wrd.wrdRenderBoard();
  assert.deepEqual(rowColours(second.els, 0), ['absent', 'correct', 'correct', 'present', 'correct']);
  assert.equal(rowText(second.els, 1), 'PL');
});

test('wordle: init starts a new game on a first visit and resumes a saved one', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(Math, 'random', () => 0);

  const first = freshGame();
  first.wrd.init();
  assert.equal(first.wrd.wrdState.solution, 'CRANE');
  assert.equal(first.els['wrd-toast'].textContent, 'New game started');
  assert.equal(first.els['wrd-keyboard'].children.length, 4);

  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    solution: 'PLANT', guesses: ['CRANE'], current: 'PL', timer: 30, wins: 2, finished: false
  }));
  const second = freshGame({ keepStorage: true });
  second.wrd.init();
  assert.equal(second.wrd.wrdState.solution, 'PLANT');
  assert.deepEqual(rowColours(second.els, 0), ['absent', 'absent', 'correct', 'correct', 'absent']);
  assert.equal(rowText(second.els, 1), 'PL');
  assert.equal(second.els['wrd-games-won'].textContent, 'Wins: 2');
  assert.equal(second.els['wrd-toast'].textContent, '', 'a resumed game shows no "New game started"');
});

test('wordle: the timer counts seconds as mm:ss, saves them and stops when the round ends', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { wrd, els } = freshGame();
  startRound(wrd, 'CRANE');
  wrd.wrdStartTimer();

  t.mock.timers.tick(65000);
  assert.equal(wrd.wrdState.timer, 65);
  assert.equal(els['wrd-timer'].textContent, '01:05');
  assert.equal(saved().timer, 65);

  play(wrd, 'CRANE');
  t.mock.timers.tick(5000);
  assert.equal(wrd.wrdState.timer, 65);
  assert.equal(els['wrd-timer'].textContent, '01:05');
});

test('wordle: the on-screen keyboard has three QWERTY rows plus Enter and Backspace', () => {
  const { wrd, els } = freshGame();
  wrd.wrdRenderKeyboard();
  wrd.wrdRenderKeyboard();

  const rows = els['wrd-keyboard'].children;
  assert.equal(rows.length, 4, 'drawing again replaces the keys');
  assert.ok(rows.every((row) => row.className === 'wrd-key-row'));
  assert.deepEqual(rows.map((row) => row.children.map((key) => key.textContent).join('')),
    ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM', 'ENTER⌫']);
  assert.equal(rows[0].children[0].tagName, 'BUTTON');
  assert.equal(rows[0].children[0].className, 'wrd-key');
  assert.equal(rows[3].children[1].className, 'wrd-key wrd-key-wide');
});

test('wordle: the on-screen keys play the round', (t) => {
  const game = startedGame(t, 'PLANT');
  const { wrd, els } = game;
  'CRANX'.split('').forEach((letter) => tap(game, screenKey(els, letter)));
  tap(game, screenKey(els, '⌫'));
  tap(game, screenKey(els, 'E'));
  tap(game, screenKey(els, 'ENTER'));
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE']);
  assert.equal(wrd.wrdState.current, '');
});

test('wordle: physical letters, Enter and Backspace play the round and cancel their default action', (t) => {
  const game = startedGame(t, 'PLANT');
  const { wrd, els } = game;
  assert.equal(game.keydown.length, 1, 'init listens for keydown on the document');

  assert.ok(pressAll(game, 'crane').every((event) => event.defaultPrevented));
  assert.equal(wrd.wrdState.current, 'CRANE', 'lower-case keys type capitals');
  assert.equal(press(game, 'Backspace').defaultPrevented, true);
  assert.equal(wrd.wrdState.current, 'CRAN');
  assert.equal(press(game, 'Enter').defaultPrevented, true);
  assert.equal(els['wrd-toast'].textContent, 'Enter a 5-letter word');

  press(game, 'E', { shiftKey: true });
  press(game, 'Enter');
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE']);
});

test('wordle: keys the game does not play keep their default action', (t) => {
  const game = startedGame(t, 'PLANT');
  pressAll(game, 'cr');
  for (const key of ['1', ' ', 'Tab', 'Shift', 'ArrowLeft', 'F5', 'Escape', 'é']) {
    assert.equal(press(game, key).defaultPrevented, false, key);
  }
  assert.equal(game.wrd.wrdState.current, 'CR');
});

test('wordle: physical Enter after tapping an on-screen key submits once, with no stray letter', (t) => {
  // Before the fix Enter submitted CRANE and then clicked the focused E key,
  // which typed a stray E into row 2.
  const game = startedGame(t, 'PLANT');
  const { wrd, els } = game;
  'CRANE'.split('').forEach((letter) => tap(game, screenKey(els, letter)));
  assert.equal(game.focused.textContent, 'E');

  const enter = press(game, 'Enter');
  assert.deepEqual(wrd.wrdState.guesses, ['CRANE']);
  assert.equal(wrd.wrdState.current, '', 'the focused E key was not clicked again');
  assert.equal(rowText(els, 1), '');
  assert.equal(enter.defaultPrevented, true);
});

test('wordle: physical Enter after clicking New Game or Restart submits the guess and does not restart', (t) => {
  // Before the fix Enter submitted the guess and then clicked the focused
  // button, which threw the round away.
  t.mock.method(Math, 'random', () => 0);
  const game = startedGame(t, 'PLANT');
  const { wrd, els } = game;
  for (const id of ['wrd-new-game', 'wrd-restart-game']) {
    tap(game, els[id]);
    assert.equal(wrd.wrdState.solution, 'CRANE', id + ' starts a new round');
    pressAll(game, 'slate');
    const enter = press(game, 'Enter');
    assert.deepEqual(wrd.wrdState.guesses, ['SLATE'], id + ' was not clicked again');
    assert.equal(enter.defaultPrevented, true);
  }
});

test('wordle: once the round is over, Enter on a focused New Game button starts a new game', (t) => {
  const game = startedGame(t, 'PLANT');
  const { wrd, els } = game;
  pressAll(game, 'plant');
  press(game, 'Enter');
  assert.equal(wrd.wrdState.finished, true);

  assert.equal(press(game, 'a').defaultPrevented, false, 'a finished round plays no keys');
  game.focused = els['wrd-new-game']; // reached with Tab
  assert.equal(press(game, 'Enter').defaultPrevented, false);
  assert.equal(wrd.wrdState.finished, false);
  assert.deepEqual(wrd.wrdState.guesses, []);
  assert.equal(wrd.wrdState.wins, 1);
  assert.equal(els['wrd-toast'].textContent, 'New game started');
});

test('wordle: Ctrl, Cmd and Alt shortcuts are left to the browser', (t) => {
  const game = startedGame(t, 'PLANT');
  pressAll(game, 'cr');
  const shortcuts = [
    ['c', 'ctrlKey'], ['v', 'ctrlKey'], ['r', 'metaKey'], ['a', 'altKey'],
    ['Enter', 'ctrlKey'], ['Backspace', 'altKey'], ['Backspace', 'metaKey']
  ];
  for (const [key, modifier] of shortcuts) {
    assert.equal(press(game, key, { [modifier]: true }).defaultPrevented, false, modifier + '+' + key);
  }
  assert.equal(game.wrd.wrdState.current, 'CR', 'Ctrl+C no longer types C');
  assert.deepEqual(game.wrd.wrdState.guesses, []);
});

test('wordle: typing in an input, textarea, select or contenteditable on the page does not play', (t) => {
  const game = startedGame(t, 'PLANT');
  const { wrd } = game;
  pressAll(game, 'cr');
  const editable = stubElement('div');
  editable.isContentEditable = true;
  const fields = [stubElement('input'), stubElement('textarea'), stubElement('select'), editable];

  for (const target of fields) {
    assert.equal(wrd.wrdIsEditable(target), true, target.tagName);
    for (const key of ['a', 'Enter', 'Backspace']) {
      assert.equal(press(game, key, { target }).defaultPrevented, false, target.tagName + ' ' + key);
    }
  }
  assert.equal(wrd.wrdState.current, 'CR');
  assert.deepEqual(wrd.wrdState.guesses, []);
  for (const other of [stubElement('button'), stubElement('div'), document.body, null, undefined]) {
    assert.equal(wrd.wrdIsEditable(other), false);
  }
});

test('wordle: a keydown without a key (Chrome autofill) is ignored', (t) => {
  const game = startedGame(t, 'PLANT');
  pressAll(game, 'c');
  for (const key of [undefined, null, 13]) {
    assert.equal(press(game, key).defaultPrevented, false, String(key));
  }
  assert.equal(game.wrd.wrdState.current, 'C');
});

test('wordle: index.html paints the standalone page in the wrapper colour, from <head> only', () => {
  // Opened on its own the page had a transparent body with an 8px margin.
  // build-embed copies index.html from the wrapper to the first <script>, so
  // this rule never reaches WordPress.
  const html = readGameFile('index.html');
  const css = readGameFile('style.css');
  const rule = '<style>body { margin: 0; background: #0a0f1e; }</style>';

  assert.match(html, /<link rel="stylesheet" href="style\.css">\r?\n {2}<style>body \{ margin: 0; background: #0a0f1e; \}<\/style>\r?\n<\/head>/);
  assert.equal(html.split(rule).length, 2, 'the rule appears once');
  const wrapperAt = html.indexOf('<div class="wrd-wrapper"');
  assert.ok(html.indexOf(rule) < html.indexOf('</head>') && html.indexOf('</head>') < wrapperAt);
  assert.doesNotMatch(html.slice(wrapperAt, html.indexOf('<script', wrapperAt)), /<style/i);

  assert.equal(css.match(/--wrd-bg:\s*(#[0-9a-f]{6});/i)[1], '#0a0f1e', 'same colour as the wrapper');
  assert.doesNotMatch(css, /^\s*(html|body)\b[^{]*\{/m, 'style.css keeps no bare html/body rule');
});

// Declarations of one rule inside style.css's @media (max-width: 640px) block.
function phoneRule(selector) {
  const css = readGameFile('style.css');
  const media = css.slice(css.indexOf('@media (max-width: 640px)'));
  const match = media.match(new RegExp('\\n\\s*' + selector.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}'));
  assert.ok(match, selector + ' has a phone rule');
  const declarations = {};
  for (const part of match[1].split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0) declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return declarations;
}

test('wordle: on phones every keyboard row fits a 320-414px screen with keys about 28px or wider', () => {
  // Before the fix the 10-key row was 512px wide (44px keys, 8px gaps), so at
  // 375px Q, W, A and S sat off the left edge.  This works the phone rules
  // through for each screen width; it is arithmetic, not a browser layout.
  const wrapper = phoneRule('.wrd-wrapper');
  const row = phoneRule('.wrd-key-row');
  const key = phoneRule('.wrd-key');
  const wide = phoneRule('.wrd-key-wide');

  const sidePadding = parseFloat(wrapper.padding.split(/\s+/)[1]);
  const gap = parseFloat(row.gap);
  assert.equal(key['min-width'], '0', 'keys may shrink below the 44px desktop size');
  const basis = key.flex.match(/^0 1 calc\(\(100% - (\d+)px\) \/ 10\)$/);
  assert.ok(basis, 'each key takes a tenth of the row: ' + key.flex);
  assert.equal(Number(basis[1]), 9 * gap, 'the basis leaves room for the nine gaps of the QWERTY row');
  const maxKey = parseFloat(key['max-width']);
  const wideKey = parseFloat(wide['max-width']);
  assert.equal(maxKey, 44);
  assert.equal(wide.flex, '0 1 ' + wide['max-width']);

  for (const screen of [320, 360, 375, 414, 640]) {
    const rowWidth = screen - 2 * sidePadding;
    const keyWidth = Math.min(maxKey, (rowWidth - 9 * gap) / 10);
    for (const keys of [10, 9, 7]) {
      assert.ok(keys * keyWidth + (keys - 1) * gap <= rowWidth + 0.001, screen + 'px: a ' + keys + '-key row fits');
    }
    assert.ok(2 * wideKey + gap <= rowWidth, screen + 'px: ENTER and Backspace fit');
    assert.ok(keyWidth >= 27.5, screen + 'px: keys are ' + keyWidth.toFixed(1) + 'px wide');
  }
});
