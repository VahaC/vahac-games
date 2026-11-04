// tests/sudoku.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, stubElement, resetStubs } = require('./_setup');

const sdk = loadScript('sudoku/script.js');

// The well-known puzzle from the Wikipedia "Sudoku" article and its unique
// solution, row by row (0 = empty cell).
const PUZZLE =
  '530070000' + '600195000' + '098000060' +
  '800060003' + '400803001' + '700020006' +
  '060000280' + '000419005' + '000080079';
const SOLUTION =
  '534678912' + '672195348' + '198342567' +
  '859761423' + '426853791' + '713924856' +
  '961537284' + '287419635' + '345286179';

// Mulberry32: a small seeded PRNG, so boards built from Math.random are reproducible.
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 81-character string -> 9x9 array of numbers, as the game's solver uses.
function toGrid(s) {
  return Array.from({ length: 9 }, (_, r) => Array.from(s.slice(r * 9, r * 9 + 9), Number));
}

// True when every row, column and 3x3 box of an 81-character grid holds 1-9 once.
function isSolvedGrid(s) {
  if (!/^[1-9]{81}$/.test(s)) return false;
  for (let k = 0; k < 9; k++) {
    const row = [];
    const col = [];
    const box = [];
    for (let j = 0; j < 9; j++) {
      row.push(s[k * 9 + j]);
      col.push(s[j * 9 + k]);
      box.push(s[(Math.floor(k / 3) * 3 + Math.floor(j / 3)) * 9 + (k % 3) * 3 + (j % 3)]);
    }
    for (const unit of [row, col, box]) {
      if (unit.sort().join('') !== '123456789') return false;
    }
  }
  return true;
}

const zeros = (s) => s.split('').filter((d) => d === '0').length;
const setAt = (s, i, d) => s.slice(0, i) + d + s.slice(i + 1);

// Loads a fresh copy of the game against a fake page.  getElementById returns
// a stub element for each id index.html has, querySelectorAll('.sdk-cell')
// returns the cells the game appended to the board (in order), created inputs
// remember their 'input' listeners so a test can type into them, and
// setTimeout calls are recorded instead of scheduled (the toast timer neither
// fires by itself nor keeps the test process alive).  The mocks end with the test.
function openPage(t) {
  const els = {};
  ['sdk-board', 'sdk-status', 'sdk-toast', 'sdk-new-game-btn', 'sdk-restart-btn', 'sdk-hint-btn']
    .forEach((id) => {
      els[id] = stubElement('div');
      els[id].id = id;
    });
  const timers = [];
  t.mock.method(document, 'getElementById', (id) => els[id] || null);
  t.mock.method(document, 'querySelectorAll', (sel) => (sel === '.sdk-cell' ? els['sdk-board'].children.slice() : []));
  t.mock.method(document, 'createElement', (tag) => {
    const el = stubElement(tag);
    el.listeners = {};
    el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
    return el;
  });
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => timers.push({ fn, ms }));
  const game = loadScript('sudoku/script.js');
  return {
    els,
    timers,
    game,
    newGame: window.sdkNewGame,
    restart: window.sdkRestartGame,
    hint: window.sdkGiveHint,
    cells: () => els['sdk-board'].children,
    saved: () => JSON.parse(localStorage.getItem('sdk-sudoku-game')),
    type: (cell, text) => {
      cell.value = text;
      (cell.listeners.input || []).forEach((fn) => fn());
    }
  };
}

// A saved game in the shape the script stores: one correct entry (cell 2 = 4)
// and one wrong entry (cell 3 = 1, the solution has 6).
function saveWikipediaGame(board) {
  localStorage.setItem('sdk-sudoku-game', JSON.stringify({
    puzzle: PUZZLE,
    solution: SOLUTION,
    board: board === undefined ? setAt(setAt(PUZZLE, 2, '4'), 3, '1') : board
  }));
}

const hasClass = (el, name) => el.classList.contains(name);

test.beforeEach(() => resetStubs());

const DIR = require('node:path').join(__dirname, '..', 'sudoku');
const readSource = (name) => require('node:fs').readFileSync(require('node:path').join(DIR, name), 'utf8');

// The rules of style.css in source order as { media, selectors, decls }, where
// media is N for a rule inside "@media (max-width: Npx)" and Infinity outside.
// Enough for this file: plain rules and one level of max-width media blocks.
function cssRules(css) {
  const rules = [];
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{|([^{}]+)\{([^{}]*)\}|\}/g;
  let media = Infinity;
  let m;
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  while ((m = re.exec(css))) {
    if (m[1]) {
      media = Number(m[1]);
    } else if (m[2] !== undefined) {
      const decls = {};
      for (const d of m[3].split(';')) {
        const i = d.indexOf(':');
        if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
      }
      rules.push({ media, selectors: m[2].split(',').map((s) => s.trim()), decls });
    } else {
      media = Infinity; // the closing brace of a media block
    }
  }
  return rules;
}

// The declarations that apply to one selector at a viewport width (equal
// specificity, so the later rule wins).
function declsAt(rules, selector, vw) {
  const out = {};
  for (const r of rules) {
    if (vw <= r.media && r.selectors.includes(selector)) Object.assign(out, r.decls);
  }
  return out;
}

const px = (len) => Number.parseFloat(len) * (/rem$/.test(len) ? 16 : 1);

function horizontalPadding(padding) {
  const v = padding.split(/\s+/).map(px);
  return v.length === 1 ? 2 * v[0] : v.length === 4 ? v[1] + v[3] : 2 * v[1];
}

// Widths in px of the wrapper (border box), its content box and the board at a
// viewport width, for the standalone page (body margin 0) — inside WordPress
// the same holds with the content column's width in place of the viewport.
function layoutAt(rules, vw) {
  const w = declsAt(rules, '.sdk-wrapper', vw);
  assert.equal(w.width, '100%');
  const pad = horizontalPadding(w.padding);
  const box = Math.min(vw, px(w['max-width']));
  const content = w['box-sizing'] === 'border-box' ? box - pad : box;
  const b = declsAt(rules, '.sdk-board', vw);
  assert.equal(b.width, '100%');
  // The board (and its 4px border) is border-box through the ".sdk-wrapper *" rule.
  const board = Math.min(content, px(b['max-width']));
  return { wrapper: content + pad, content, board };
}

test('sudoku: opened on its own the page is dark with no margin, and build-embed never copies that rule', () => {
  const html = readSource('index.html');
  const css = readSource('style.css');
  // Same colour as the wrapper's own base colour, so page and game match.
  assert.equal(css.match(/--sdk-bg-primary:\s*(#[0-9a-f]{6})/i)[1], '#0a0f1e');
  assert.match(html, /<link rel="stylesheet" href="style\.css">\n {2}<style>body \{ margin: 0; background: #0a0f1e; \}<\/style>\n<\/head>/);
  assert.equal(html.match(/<style/g).length, 1);
  // build-embed copies index.html from the wrapper up to the first <script>.
  const start = html.indexOf('<div class="sdk-wrapper"');
  assert.ok(start > html.indexOf('</head>'));
  const copied = html.slice(start, html.indexOf('<script', start));
  assert.doesNotMatch(copied, /<style|<!--|-->/i);
});

test('sudoku: the sources embed safely in the WordPress block', () => {
  const css = readSource('style.css');
  for (const [name, source] of [['script.js', readSource('script.js')], ['style.css', css]]) {
    assert.ok(!source.includes('<!--') && !source.includes('-->'), name);
    assert.ok(!/<\/script/i.test(source), name);
  }
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(css), 'no bare html/body rule');
  assert.equal(readSource('index.html').match(/<div class="([a-z0-9]{2,4})-wrapper"/)[1], 'sdk');
});

test('sudoku: nothing is wider than a phone screen, and the board keeps its size where it fits', () => {
  const rules = cssRules(readSource('style.css'));
  assert.equal(declsAt(rules, '.sdk-wrapper', 1280)['box-sizing'], 'border-box');
  for (const sel of ['.sdk-wrapper *', '.sdk-wrapper *::before', '.sdk-wrapper *::after']) {
    assert.equal(declsAt(rules, sel, 1280)['box-sizing'], 'border-box', sel);
  }

  // Phone: the 8px side padding sits inside the 375px, so the board is 359px
  // (cells of (359 - 2 * 4) / 9 = 39px); the full-width buttons are 359px too.
  assert.deepEqual(layoutAt(rules, 375), { wrapper: 375, content: 359, board: 359 });
  assert.equal(declsAt(rules, '.sdk-btn', 375).width, '100%');
  // Tablet and desktop: the board stays at its 640px maximum, as before the fix.
  assert.deepEqual(layoutAt(rules, 768), { wrapper: 768, content: 736, board: 640 });
  assert.deepEqual(layoutAt(rules, 1280), { wrapper: 860, content: 828, board: 640 });

  for (let vw = 320; vw <= 1440; vw += 1) {
    const l = layoutAt(rules, vw);
    assert.ok(l.wrapper <= vw, vw + 'px: wrapper ' + l.wrapper + 'px');
    assert.ok(l.board <= l.content, vw + 'px: board ' + l.board + 'px');
  }
});

test('sudoku: createEmptyBoard returns nine independent rows of zeros', () => {
  const board = sdk.createEmptyBoard();
  assert.deepEqual(board, Array.from({ length: 9 }, () => Array(9).fill(0)));
  board[0][0] = 5;
  assert.equal(board[1][0], 0);
});

test('sudoku: boardToString flattens the rows in reading order', () => {
  const board = sdk.createEmptyBoard();
  board[0][8] = 7;
  board[1][0] = 3;
  board[8][8] = 9;
  const s = sdk.boardToString(board);
  assert.equal(s.length, 81);
  assert.equal(s[8], '7');
  assert.equal(s[9], '3');
  assert.equal(s[80], '9');
  assert.equal(s.replace(/0/g, ''), '739');
  assert.equal(sdk.boardToString(toGrid(SOLUTION)), SOLUTION);
});

test('sudoku: isValid rejects a digit already in the row, column or 3x3 box', () => {
  const grid = toGrid(PUZZLE);
  assert.equal(sdk.isValid(grid, 4, 4, 4), false); // row 5 starts with a 4
  assert.equal(sdk.isValid(grid, 4, 4, 7), false); // column 5 has a 7 in row 1
  assert.equal(sdk.isValid(grid, 0, 2, 6), false); // the top-left box has a 6
  assert.equal(sdk.isValid(grid, 0, 2, 9), false); // ... and a 9
  assert.equal(sdk.isValid(grid, 4, 4, 5), true);
  assert.equal(sdk.isValid(grid, 0, 2, 4), true);
});

test('sudoku: solveBoard fills a known puzzle with its unique solution, in place', (t) => {
  assert.ok(isSolvedGrid(SOLUTION));
  t.mock.method(Math, 'random', seeded(7));
  const grid = toGrid(PUZZLE);
  assert.equal(sdk.solveBoard(grid), true);
  assert.equal(sdk.boardToString(grid), SOLUTION);
});

test('sudoku: solveBoard reports a dead end and undoes its guesses', () => {
  // Cells (0,0) and (0,1) both need a 1 or a 2, but column 2 already has both,
  // so every guess for (0,0) leaves (0,1) without a candidate.
  const grid = sdk.createEmptyBoard();
  grid[0] = [0, 0, 3, 4, 5, 6, 7, 8, 9];
  grid[3][1] = 1;
  grid[6][1] = 2;
  const before = JSON.stringify(grid);
  assert.equal(sdk.solveBoard(grid), false);
  assert.equal(JSON.stringify(grid), before);
});

test('sudoku: generateSolvedBoard builds complete valid grids, reproducible from Math.random', (t) => {
  const random = t.mock.method(Math, 'random', seeded(1));
  const first = sdk.boardToString(sdk.generateSolvedBoard());
  random.mock.mockImplementation(seeded(1));
  const again = sdk.boardToString(sdk.generateSolvedBoard());
  random.mock.mockImplementation(seeded(2));
  const other = sdk.boardToString(sdk.generateSolvedBoard());
  assert.ok(isSolvedGrid(first), first);
  assert.ok(isSolvedGrid(other), other);
  assert.equal(again, first);
  assert.notEqual(other, first);
  for (let seed = 3; seed <= 22; seed++) {
    random.mock.mockImplementation(seeded(seed));
    const grid = sdk.boardToString(sdk.generateSolvedBoard());
    assert.ok(isSolvedGrid(grid), 'seed ' + seed + ': ' + grid);
  }
});

test('sudoku: removeNumbers blanks exactly the requested cells on a copy', (t) => {
  t.mock.method(Math, 'random', seeded(3));
  const solved = toGrid(SOLUTION);
  const puzzle = sdk.boardToString(sdk.removeNumbers(solved, 45));
  assert.equal(sdk.boardToString(solved), SOLUTION);
  assert.equal(zeros(puzzle), 45);
  puzzle.split('').forEach((d, i) => assert.ok(d === '0' || d === SOLUTION[i], 'cell ' + i));
  assert.equal(zeros(sdk.boardToString(sdk.removeNumbers(solved, 0))), 0);
});

test('sudoku: shuffle returns a reordered copy of its input', (t) => {
  t.mock.method(Math, 'random', seeded(5));
  const input = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const out = sdk.shuffle(input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.notEqual(out, input);
  assert.deepEqual([...out].sort(), input);
  assert.notDeepEqual(out, input);
});

test('sudoku: New Game draws a 45-blank puzzle, saves it and toasts for 2 seconds', (t) => {
  const page = openPage(t);
  t.mock.method(Math, 'random', seeded(11));
  page.newGame();

  const saved = page.saved();
  assert.ok(isSolvedGrid(saved.solution), saved.solution);
  assert.equal(saved.puzzle.length, 81);
  assert.equal(zeros(saved.puzzle), 45);
  saved.puzzle.split('').forEach((d, i) => assert.ok(d === '0' || d === saved.solution[i], 'cell ' + i));
  assert.equal(saved.board, saved.puzzle);

  const cells = page.cells();
  assert.equal(cells.length, 81);
  cells.forEach((cell, i) => {
    const given = saved.puzzle[i] !== '0';
    assert.equal(cell.disabled, given, 'cell ' + i);
    assert.equal(hasClass(cell, 'sdk-cell-fixed'), given, 'cell ' + i);
    assert.equal(cell.value, given ? saved.puzzle[i] : '', 'cell ' + i);
    assert.equal(cell.type, 'tel');
    assert.equal(cell.inputMode, 'numeric');
  });
  // Thick box borders after columns 3 and 6 and after rows 3 and 6 only.
  const right = new Set(cells.map((c, i) => (hasClass(c, 'sdk-cell-right-border') ? i % 9 : -1)));
  const bottom = new Set(cells.map((c, i) => (hasClass(c, 'sdk-cell-bottom-border') ? Math.floor(i / 9) : -1)));
  assert.deepEqual([...right].filter((x) => x >= 0).sort(), [2, 5]);
  assert.deepEqual([...bottom].filter((x) => x >= 0).sort(), [2, 5]);

  const toast = page.els['sdk-toast'];
  assert.equal(toast.textContent, 'Game saved');
  assert.equal(hasClass(toast, 'sdk-show'), true);
  assert.equal(page.timers.length, 1);
  assert.equal(page.timers[0].ms, 2000);
  page.timers[0].fn();
  assert.equal(hasClass(toast, 'sdk-show'), false);
  assert.equal(page.els['sdk-status'].textContent, '');
});

test('sudoku: a saved game is restored after a reload, with the wrong entry marked', (t) => {
  const page = openPage(t);
  assert.equal(page.game.loadGame(), false);
  assert.equal(page.cells().length, 0);

  saveWikipediaGame();
  assert.equal(page.game.loadGame(), true);
  const cells = page.cells();
  assert.equal(cells.length, 81);
  assert.equal(cells[0].value, '5');
  assert.equal(cells[0].disabled, true);
  assert.equal(cells[2].value, '4');
  assert.equal(cells[2].disabled, false);
  assert.equal(cells[3].value, '1');
  assert.equal(cells[5].value, '');
  assert.deepEqual(cells.map((c, i) => (hasClass(c, 'sdk-cell-invalid') ? i : -1)).filter((i) => i >= 0), [3]);
});

test('sudoku: typing keeps one digit 1-9, saves the move and marks or clears mistakes', (t) => {
  saveWikipediaGame(PUZZLE);
  const page = openPage(t);
  page.game.loadGame();
  const cell = page.cells()[2];

  page.type(cell, 'x7');
  assert.equal(cell.value, '7');
  assert.equal(page.saved().board[2], '7');
  assert.equal(hasClass(page.cells()[2], 'sdk-cell-invalid'), true);

  page.type(cell, '0');
  assert.equal(cell.value, '');
  assert.equal(page.saved().board, PUZZLE);
  assert.equal(hasClass(page.cells()[2], 'sdk-cell-invalid'), false);

  page.type(cell, '4');
  assert.equal(page.saved().board[2], '4');
  assert.equal(hasClass(cell, 'sdk-cell-invalid'), false);
  assert.equal(page.els['sdk-toast'].textContent, 'Game saved');
});

test('sudoku: typing the last missing digit wins and clears the save', (t) => {
  saveWikipediaGame(setAt(SOLUTION, 40, '0'));
  const page = openPage(t);
  page.game.loadGame();

  page.type(page.cells()[40], '5');
  assert.equal(page.els['sdk-status'].textContent, '🎉 Puzzle solved!');
  assert.equal(page.els['sdk-toast'].textContent, 'Victory!');
  assert.equal(localStorage.getItem('sdk-sudoku-game'), null);
});

test('sudoku: each Hint fixes one wrong or empty cell, and the last one wins', (t) => {
  saveWikipediaGame();
  const page = openPage(t);
  t.mock.method(Math, 'random', seeded(9));
  page.game.loadGame();

  let board = page.saved().board;
  let hints = 0;
  while (page.els['sdk-status'].textContent === '') {
    page.hint();
    hints++;
    const next = localStorage.getItem('sdk-sudoku-game') === null ? SOLUTION : page.saved().board;
    const changed = next.split('').map((d, i) => (d !== board[i] ? i : -1)).filter((i) => i >= 0);
    assert.equal(changed.length, 1, 'hint ' + hints);
    assert.equal(next[changed[0]], SOLUTION[changed[0]]);
    assert.notEqual(changed[0], 2); // never touches the correct entry
    board = next;
    assert.ok(hints <= 50, 'too many hints');
  }
  // 51 empty cells, one filled correctly and one wrongly: 50 cells to fix.
  assert.equal(hints, 50);
  assert.equal(page.els['sdk-status'].textContent, '🎉 Puzzle solved!');
  assert.equal(page.els['sdk-toast'].textContent, 'Victory!');
  assert.equal(localStorage.getItem('sdk-sudoku-game'), null);
  assert.equal(page.cells().every((c, i) => c.value === SOLUTION[i]), true);

  page.hint();
  assert.equal(localStorage.getItem('sdk-sudoku-game'), null);
});

test('sudoku: Restart wipes the player entries but keeps the puzzle and its solution', (t) => {
  saveWikipediaGame();
  const page = openPage(t);
  page.game.loadGame();
  page.els['sdk-status'].textContent = '🎉 Puzzle solved!';

  page.restart();
  assert.deepEqual(page.saved(), { puzzle: PUZZLE, solution: SOLUTION, board: PUZZLE });
  assert.equal(page.els['sdk-status'].textContent, '');
  const cells = page.cells();
  assert.equal(cells[2].value, '');
  assert.equal(cells[3].value, '');
  assert.equal(cells.some((c) => hasClass(c, 'sdk-cell-invalid')), false);
});
