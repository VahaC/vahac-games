// tests/sudoku.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, resetStubs, loadWithPage, bootLikeBrowser, fire, pressKey,
  listenerCount, readRepoFile, idsInHtml, htmlPageSpec, embedMarkup,
  embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

const DIR = 'sudoku';
const SCRIPT = DIR + '/script.js';
// A Windows checkout with core.autocrlf has CRLF files; the shape checks below
// are written for LF, so read every source with LF line endings.
const readLf = (rel) => readRepoFile(rel).replace(/\r\n/g, '\n');
const HTML = readLf(DIR + '/index.html');
const CSS = readLf(DIR + '/style.css');
const SOURCE = readLf(SCRIPT);
const KEY = 'sdk-sudoku-game';
const SOLVED_TEXT = '🎉 Puzzle solved!';

const sdk = loadScript(SCRIPT);

// ── Fixtures ────────────────────────────────────────────────────────────────

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

// A puzzle the game generated before puzzles had to be unique (seed 1 of the
// old generator), with the solution it stored and the second valid solution
// (cells 27, 28, 63 and 64 hold 1 and 4 the other way round).
const AMBIGUOUS =
  '054160000' + '320900006' + '000070300' +
  '000700032' + '000800549' + '030620780' +
  '685247090' + '002000805' + '093008200';
const AMBIGUOUS_STORED =
  '854163927' + '327985416' + '961472358' +
  '418759632' + '276831549' + '539624781' +
  '685247193' + '142396875' + '793518264';
const AMBIGUOUS_OTHER =
  '854163927' + '327985416' + '961472358' +
  '148759632' + '276831549' + '539624781' +
  '685247193' + '412396875' + '793518264';

// A save exactly as every earlier version wrote it: one correct entry
// (cell 2 = 4) and one wrong entry (cell 3 = 1, the solution has 6).
const BASELINE_SAVE = '{"puzzle":"530070000600195000098000060800060003400803001700020006060000280000419005000080079",' +
  '"solution":"534678912672195348198342567859761423426853791713924856961537284287419635345286179",' +
  '"board":"534170000600195000098000060800060003400803001700020006060000280000419005000080079"}';

// ── Helpers ─────────────────────────────────────────────────────────────────

// 81-character string -> 9x9 array of numbers, as the game's solver uses.
function toGrid(s) {
  return Array.from({ length: 9 }, (_, r) => Array.from(s.slice(r * 9, r * 9 + 9), Number));
}

const setAt = (s, i, d) => s.slice(0, i) + d + s.slice(i + 1);
const zeros = (s) => s.split('').filter((d) => d === '0').length;
const hasClass = (el, name) => el.classList.contains(name);

// The other cells in the row, column and 3x3 box of each cell.
const PEERS = Array.from({ length: 81 }, (_, i) => {
  const r = Math.floor(i / 9);
  const c = i % 9;
  const out = new Set();
  for (let k = 0; k < 9; k++) {
    out.add(r * 9 + k);
    out.add(k * 9 + c);
    out.add((r - (r % 3) + Math.floor(k / 3)) * 9 + (c - (c % 3)) + (k % 3));
  }
  out.delete(i);
  return [...out];
});

// True when every row, column and 3x3 box of an 81-character grid holds 1-9 once.
function isSolvedGrid(s) {
  return /^[1-9]{81}$/.test(s) && PEERS.every((peers, i) => peers.every((p) => s[p] !== s[i]));
}

const keepsGivens = (grid, puzzle) => [...puzzle].every((d, i) => d === '0' || d === grid[i]);

// The first cell that is a given in `before` and empty in `after` (-1 if none).
const freedCell = (before, after) => [...after].findIndex((d, i) => d === '0' && before[i] !== '0');

// The number of solutions of an 81-character puzzle, counting up to limit.  A
// separate implementation from the game's, so the tests do not trust the code
// they check.
function referenceCount(puzzle, limit = 2) {
  const cells = Array.from(puzzle, Number);
  if (cells.some((d, i) => d && PEERS[i].some((p) => cells[p] === d))) return 0;
  let count = 0;
  (function search() {
    let best = -1;
    let options = null;
    for (let i = 0; i < 81 && !(options && options.length < 2); i++) {
      if (cells[i]) continue;
      const used = new Set(PEERS[i].map((p) => cells[p]));
      const free = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => !used.has(d));
      if (!options || free.length < options.length) [best, options] = [i, free];
    }
    if (best === -1) {
      count++;
      return;
    }
    for (const d of options) {
      cells[best] = d;
      search();
      cells[best] = 0;
      if (count >= limit) return;
    }
  })();
  return count;
}

const saveOf = (puzzle, solution, board) => JSON.stringify({ puzzle, solution, board });

// Boots the game like a browser page (init runs) on the elements of
// index.html, with mocked timers and a seeded Math.random, after storing
// `save` (a string as is, an object as JSON).  Returns helpers to drive and
// read the page.
function openGame(t, { save, seed = 1, readyState, createMissing } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', seeded(seed));
  if (save !== undefined) localStorage.setItem(KEY, typeof save === 'string' ? save : JSON.stringify(save));
  return view(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), { readyState, createMissing }));
}

function view(boot) {
  const els = boot.els;
  const cells = () => els['sdk-board'].children;
  return {
    boot,
    els,
    cells,
    // Puts text into cell i, as typing, an IME or autofill would, and fires
    // 'input'.  Like a browser, it refuses a disabled cell.
    type(i, text) {
      const cell = cells()[i];
      assert.equal(cell.disabled, false, 'cell ' + i + ' is disabled, so nobody can type in it');
      cell.value = text;
      fire(cell, 'input');
      return cell;
    },
    // Every cell follows the puzzle on screen: its givens are disabled and
    // grey (sdk-cell-fixed), every other cell is editable and not grey.
    assertGivens(puzzle, when) {
      assert.equal(cells().length, 81, 'cells after ' + when);
      cells().forEach((cell, i) => {
        const given = puzzle[i] !== '0';
        assert.equal(cell.disabled, given, 'cell ' + i + ' disabled after ' + when);
        assert.equal(hasClass(cell, 'sdk-cell-fixed'), given, 'cell ' + i + ' sdk-cell-fixed after ' + when);
      });
    },
    values: () => cells().map((c) => c.value || '0').join(''),
    invalid: () => cells().flatMap((c, i) => (hasClass(c, 'sdk-cell-invalid') ? [i] : [])),
    status: () => els['sdk-status'].textContent,
    toast: () => els['sdk-toast'].textContent,
    toastShown: () => hasClass(els['sdk-toast'], 'sdk-show'),
    raw: () => localStorage.getItem(KEY),
    saved: () => JSON.parse(localStorage.getItem(KEY)),
    click: (id) => els[id].click()
  };
}

test.beforeEach(() => resetStubs());

// ── Page files ──────────────────────────────────────────────────────────────

test('sudoku: opened on its own the page is dark with no margin, and build-embed never copies that rule', () => {
  // Same colour as the wrapper's own base colour, so page and game match.
  assert.equal(CSS.match(/--sdk-bg-primary:\s*(#[0-9a-f]{6})/i)[1], '#0a0f1e');
  assert.match(HTML, /<link rel="stylesheet" href="style\.css">\n {2}<style>body \{ margin: 0; background: #0a0f1e; \}<\/style>\n<\/head>/);
  assert.equal(HTML.match(/<style/g).length, 1);
  // build-embed copies index.html from the wrapper up to the first <script>.
  const copied = embedMarkup(HTML);
  assert.ok(copied.startsWith('<div class="sdk-wrapper"'));
  assert.ok(HTML.indexOf(copied) > HTML.indexOf('</head>'));
  assert.ok(HTML.slice(HTML.indexOf(copied) + copied.length).startsWith('<script src="script.js"></script>'));
  assert.doesNotMatch(copied, /<style/i);
});

test('sudoku: the sources embed safely in the WordPress block', () => {
  assert.deepEqual(embedSafety(SOURCE), []);
  assert.deepEqual(embedSafety(CSS), []);
  assert.deepEqual(embedSafety(embedMarkup(HTML)), []);
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');
  assert.equal(HTML.match(/<div class="([a-z0-9]{2,4})-wrapper"/)[1], 'sdk');
});

test('sudoku: every class, id, CSS variable, storage key and global carries the sdk prefix', (t) => {
  const ids = idsInHtml(HTML);
  assert.deepEqual(ids, [...new Set(ids)], 'ids are unique');
  ids.forEach((id) => assert.match(id, /^sdk-/));
  [...HTML.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).forEach((c) => assert.match(c, /^sdk-/, c));
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  // Class and id names in selectors (the lookahead skips values such as #e2e8f0).
  const selectorNames = [...css.matchAll(/[.#](-?[_a-zA-Z][\w-]*)(?![^{]*;)/g)].map((m) => m[1]);
  assert.ok(selectorNames.length > 30, selectorNames.length + ' names');
  selectorNames.forEach((name) => assert.match(name, /^sdk-/, name));
  const variables = [...css.matchAll(/(?:^|[{;])\s*--([\w-]+)\s*:/gm)].map((m) => m[1]);
  assert.equal(variables.length, 17);
  variables.forEach((name) => assert.match(name, /^sdk-/, name));
  [...css.matchAll(/var\(--([\w-]+)\)/g)].forEach((m) => assert.ok(variables.includes(m[1]), m[0]));
  assert.equal(sdk.STORAGE_KEY, KEY);

  // Everything the running game puts on the page or on window.
  const game = openGame(t);
  const classes = new Set(game.cells().flatMap((c) => c.className.split(' ')));
  assert.deepEqual([...classes].sort(), ['sdk-cell', 'sdk-cell-bottom-border', 'sdk-cell-fixed', 'sdk-cell-right-border']);
  assert.deepEqual(Object.keys(game.boot.exposed).sort(), ['sdkGiveHint', 'sdkNewGame', 'sdkRestartGame']);
  assert.equal(localStorage.length, 1);
  assert.equal(localStorage.key(0), KEY);
});

test('sudoku: script.js is one strict ES5 IIFE with the start-up guard build-embed expects', () => {
  assert.match(SOURCE, /^(\/\/[^\n]*\n|\n)*\(function \(\) \{\n {2}'use strict';\n/);
  assert.match(SOURCE, /\n\}\)\(\);\n$/);
  assert.ok(SOURCE.includes(
    "  if (document.readyState === 'loading') {\n" +
    "    document.addEventListener('DOMContentLoaded', init);\n" +
    "  } else if (typeof module === 'undefined' || !module.exports) {\n" +
    '    init();\n' +
    '  }\n'
  ));
  // No syntax newer than ES5 outside comments and strings.
  const code = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  for (const [name, re] of [
    ['arrow function', /=>/], ['template literal', /`/], ['let/const/class', /\b(let|const|class)\b/],
    ['spread or rest', /\.\.\./], ['optional chaining', /\?\./], ['module syntax', /\b(import|export)\b/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('sudoku: every element the script looks up exists in index.html', (t) => {
  const game = openGame(t, { createMissing: true });
  assert.deepEqual(game.boot.page.missing, []);
  assert.deepEqual([...game.boot.page.requested].sort(),
    ['sdk-board', 'sdk-hint-btn', 'sdk-new-game-btn', 'sdk-restart-btn', 'sdk-status', 'sdk-toast']);
  game.boot.page.requested.forEach((id) => assert.ok(idsInHtml(HTML).includes(id), id));
});

// ── Stylesheet ──────────────────────────────────────────────────────────────

const RULES = cssRules(CSS);
const px = (len) => Number.parseFloat(len) * (/rem$/.test(len) ? 16 : 1);

function horizontalPadding(padding) {
  const v = padding.split(/\s+/).map(px);
  return v.length === 1 ? 2 * v[0] : v.length === 4 ? v[1] + v[3] : 2 * v[1];
}

// Widths in px of the wrapper (border box), its content box and the board at a
// viewport width, for the standalone page (body margin 0) — inside WordPress
// the same holds with the content column's width in place of the viewport.
function layoutAt(vw) {
  const w = declsAt(RULES, '.sdk-wrapper', vw);
  assert.equal(w.width, '100%');
  const pad = horizontalPadding(w.padding);
  const box = Math.min(vw, px(w['max-width']));
  const content = w['box-sizing'] === 'border-box' ? box - pad : box;
  const b = declsAt(RULES, '.sdk-board', vw);
  assert.equal(b.width, '100%');
  // The board (and its 4px border) is border-box through the ".sdk-wrapper *" rule.
  const board = Math.min(content, px(b['max-width']));
  return { wrapper: content + pad, content, board };
}

test('sudoku: nothing is wider than a phone screen, and the board keeps its size where it fits', () => {
  assert.equal(declsAt(RULES, '.sdk-wrapper', 1280)['box-sizing'], 'border-box');
  for (const sel of ['.sdk-wrapper *', '.sdk-wrapper *::before', '.sdk-wrapper *::after']) {
    assert.equal(declsAt(RULES, sel, 1280)['box-sizing'], 'border-box', sel);
  }
  // Phone: the 8px side padding sits inside the 375px, so the board is 359px
  // (cells of (359 - 2 * 4) / 9 = 39px); the full-width buttons are 359px too.
  assert.deepEqual(layoutAt(375), { wrapper: 375, content: 359, board: 359 });
  assert.equal(declsAt(RULES, '.sdk-btn', 375).width, '100%');
  assert.equal(declsAt(RULES, '.sdk-btn', 641).width, undefined);
  // The buttons stack in one column on phones and sit in a row above 640px.
  assert.equal(declsAt(RULES, '.sdk-controls', 375)['flex-direction'], 'column');
  assert.equal(declsAt(RULES, '.sdk-controls', 641)['flex-direction'], undefined);
  // Tablet and desktop: the board stays at its 640px maximum.
  assert.deepEqual(layoutAt(768), { wrapper: 768, content: 736, board: 640 });
  assert.deepEqual(layoutAt(1280), { wrapper: 860, content: 828, board: 640 });
  assert.equal(declsAt(RULES, '.sdk-board', 1280)['grid-template-columns'], 'repeat(9, 1fr)');

  for (let vw = 320; vw <= 1440; vw += 1) {
    const l = layoutAt(vw);
    assert.ok(l.wrapper <= vw, vw + 'px: wrapper ' + l.wrapper + 'px');
    assert.ok(l.board <= l.content, vw + 'px: board ' + l.board + 'px');
  }
});

// The background a cell gets from the stylesheet: of the rules that set it and
// match the cell's classes (and :focus when focused), the most specific wins,
// the later one on a tie.  Every such rule uses plain compound selectors.
function cellBackground(classes, focused) {
  let best = null;
  for (const rule of RULES) {
    if (!('background' in rule.decls) || rule.media) continue;
    for (const sel of rule.selectors) {
      const m = /^((?:\.[\w-]+)+)((?::[\w-]+)*)$/.exec(sel);
      assert.ok(m, 'a compound selector: ' + sel);
      const need = m[1].slice(1).split('.');
      const pseudo = m[2] ? m[2].slice(1).split(':') : [];
      if (!need.every((c) => classes.includes(c))) continue;
      if (!pseudo.every((p) => p === 'focus' && focused)) continue;
      const weight = need.length + pseudo.length;
      if (!best || weight >= best.weight) best = { weight, value: rule.decls.background };
    }
  }
  return best && best.value;
}

test('sudoku: a wrong digit stays red while its cell has focus (README: wrong digits turn red as you type)', () => {
  const red = 'rgba(239, 68, 68, 0.2)';
  assert.equal(cellBackground(['sdk-cell'], false), 'var(--sdk-bg-input)');
  assert.equal(cellBackground(['sdk-cell'], true), '#172554');
  assert.equal(cellBackground(['sdk-cell', 'sdk-cell-fixed'], false), '#1e293b');
  assert.equal(cellBackground(['sdk-cell', 'sdk-cell-invalid'], false), red);
  assert.equal(cellBackground(['sdk-cell', 'sdk-cell-invalid'], true), red);
  // The focused cell keeps its cyan border: the red rule sets no border.
  const invalidRules = RULES.filter((r) => r.selectors.includes('.sdk-cell-invalid'));
  assert.equal(invalidRules.length, 1);
  assert.deepEqual(Object.keys(invalidRules[0].decls).sort(), ['background', 'color']);
  assert.equal(declsAt(RULES, '.sdk-cell:focus', 1280)['border-color'], 'var(--sdk-accent-cyan)');
});

// ── Puzzle logic ────────────────────────────────────────────────────────────

test('sudoku: createEmptyBoard returns nine independent rows of zeros', () => {
  const board = sdk.createEmptyBoard();
  assert.deepEqual(board, Array.from({ length: 9 }, () => Array(9).fill(0)));
  board[0][0] = 5;
  assert.equal(board[1][0], 0);
});

test('sudoku: boardToString and stringToGrid convert between grids and 81-digit strings in reading order', () => {
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
  assert.deepEqual(sdk.stringToGrid(PUZZLE), toGrid(PUZZLE));
  assert.deepEqual(sdk.stringToGrid(s), board);
});

test('sudoku: isValid rejects a digit already in the row, column or 3x3 box', () => {
  const grid = toGrid(PUZZLE);
  assert.equal(sdk.isValid(grid, 4, 4, 4), false); // row 5 starts with a 4
  assert.equal(sdk.isValid(grid, 4, 4, 7), false); // column 5 has a 7 in row 1
  assert.equal(sdk.isValid(grid, 0, 2, 6), false); // the top-left box has a 6
  assert.equal(sdk.isValid(grid, 0, 2, 9), false); // ... and a 9
  assert.equal(sdk.isValid(grid, 8, 8, 2), false); // the bottom-right box has a 2
  assert.equal(sdk.isValid(grid, 4, 4, 5), true);
  assert.equal(sdk.isValid(grid, 0, 2, 4), true);
  assert.equal(sdk.isValid(grid, 0, 0, 5), false); // the cell's own digit counts
});

test('sudoku: solveBoard fills a known puzzle with its unique solution, in place', (t) => {
  t.mock.method(Math, 'random', seeded(7));
  const grid = toGrid(PUZZLE);
  assert.equal(sdk.solveBoard(grid), true);
  assert.equal(sdk.boardToString(grid), SOLUTION);
  assert.equal(sdk.solveBoard(grid), true, 'a full valid board is already solved');
  assert.equal(sdk.boardToString(grid), SOLUTION);
});

test('sudoku: solveBoard reports a dead end or clashing givens and leaves the board alone', () => {
  // Cells (0,0) and (0,1) both need a 1 or a 2, but column 2 already has both,
  // so every guess for (0,0) leaves (0,1) without a candidate.
  const grid = sdk.createEmptyBoard();
  grid[0] = [0, 0, 3, 4, 5, 6, 7, 8, 9];
  grid[3][1] = 1;
  grid[6][1] = 2;
  const before = JSON.stringify(grid);
  assert.equal(sdk.solveBoard(grid), false);
  assert.equal(JSON.stringify(grid), before);

  const clash = toGrid(setAt(PUZZLE, 2, '5')); // two 5s in the first row
  const clashBefore = JSON.stringify(clash);
  assert.equal(sdk.solveBoard(clash), false);
  assert.equal(JSON.stringify(clash), clashBefore);
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

test('sudoku: shuffle is an unbiased Fisher-Yates on a copy of its input', (t) => {
  const random = t.mock.method(Math, 'random', seeded(5));
  const input = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const out = sdk.shuffle(input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.notEqual(out, input);
  assert.deepEqual([...out].sort(), input);
  assert.notDeepEqual(out, input);

  // From the last position down, element i swaps with floor(random * (i + 1)).
  random.mock.mockImplementation(() => 0);
  assert.deepEqual(sdk.shuffle([1, 2, 3, 4]), [2, 3, 4, 1]);
  random.mock.mockImplementation(() => 0.999);
  assert.deepEqual(sdk.shuffle([1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(sdk.shuffle([]), []);

  // All six orders of three items come up about equally often.
  random.mock.mockImplementation(seeded(42));
  const counts = {};
  for (let i = 0; i < 6000; i++) {
    const key = sdk.shuffle(['a', 'b', 'c']).join('');
    counts[key] = (counts[key] || 0) + 1;
  }
  assert.deepEqual(Object.keys(counts).sort(), ['abc', 'acb', 'bac', 'bca', 'cab', 'cba']);
  Object.values(counts).forEach((n) => assert.ok(n > 850 && n < 1150, JSON.stringify(counts)));
});

test('sudoku: countSolutions counts up to the limit and leaves the board alone', () => {
  assert.equal(referenceCount(PUZZLE, 5), 1);
  assert.equal(referenceCount(AMBIGUOUS, 5), 2);
  const grid = toGrid(PUZZLE);
  assert.equal(sdk.countSolutions(grid, 2), 1);
  assert.deepEqual(grid, toGrid(PUZZLE));
  assert.equal(sdk.countSolutions(toGrid(AMBIGUOUS), 2), 2);
  assert.equal(sdk.countSolutions(toGrid(AMBIGUOUS), 10), 2);
  assert.equal(sdk.countSolutions(toGrid(AMBIGUOUS), 1), 1);
  assert.equal(sdk.countSolutions(toGrid(AMBIGUOUS)), 2, 'the limit defaults to 2');
  assert.equal(sdk.countSolutions(sdk.createEmptyBoard()), 2);
  assert.equal(sdk.countSolutions(sdk.createEmptyBoard(), 7), 7);
  assert.equal(sdk.countSolutions(toGrid(SOLUTION), 2), 1);
  assert.equal(sdk.countSolutions(toGrid(setAt(PUZZLE, 2, '5')), 2), 0, 'clashing givens');
  // The dead end from the solveBoard test has no solution either.
  const deadEnd = sdk.createEmptyBoard();
  deadEnd[0] = [0, 0, 3, 4, 5, 6, 7, 8, 9];
  deadEnd[3][1] = 1;
  deadEnd[6][1] = 2;
  assert.equal(sdk.countSolutions(deadEnd, 2), 0);
});

test('sudoku: removeNumbers empties the requested cells on a copy and keeps exactly one solution', (t) => {
  const random = t.mock.method(Math, 'random', seeded(3));
  const solved = toGrid(SOLUTION);
  const puzzle = sdk.boardToString(sdk.removeNumbers(solved, 45));
  assert.equal(sdk.boardToString(solved), SOLUTION);
  assert.equal(zeros(puzzle), 45);
  assert.ok(keepsGivens(SOLUTION, puzzle));
  assert.equal(referenceCount(puzzle), 1);
  assert.equal(sdk.boardToString(sdk.removeNumbers(solved, 0)), SOLUTION);

  // More blanks than a unique puzzle allows: it stops when no cell can go.
  random.mock.mockImplementation(seeded(3));
  const most = sdk.boardToString(sdk.removeNumbers(solved, 81));
  assert.ok(zeros(most) > 45 && zeros(most) < 65, zeros(most) + ' blanks');
  assert.equal(referenceCount(most), 1);

  // Cells that are already empty stay empty and do not count.
  const more = sdk.boardToString(sdk.removeNumbers(toGrid(PUZZLE), 3));
  assert.ok(zeros(more) > zeros(PUZZLE) && zeros(more) <= zeros(PUZZLE) + 3);
  assert.ok(keepsGivens(more, PUZZLE.replace(/./g, (d, i) => (more[i] === '0' ? '0' : d))));
  assert.equal(referenceCount(more), 1);

  // A puzzle with two solutions gets no further blanks.
  assert.equal(sdk.boardToString(sdk.removeNumbers(toGrid(AMBIGUOUS), 10)), AMBIGUOUS);
});

test('sudoku: generatePuzzle makes 45-blank puzzles with exactly one solution', (t) => {
  const random = t.mock.method(Math, 'random', seeded(100));
  for (let i = 0; i < 40; i++) {
    const game = sdk.generatePuzzle();
    assert.equal(zeros(game.puzzle), sdk.BLANKS, game.puzzle);
    assert.ok(isSolvedGrid(game.solution), game.solution);
    assert.ok(keepsGivens(game.solution, game.puzzle), game.puzzle);
    assert.equal(referenceCount(game.puzzle), 1, game.puzzle);
  }
  assert.equal(sdk.BLANKS, 45);

  // It stops at the first grid that reaches the blanks: from the same seed it
  // builds what one generateSolvedBoard plus removeNumbers builds, with
  // exactly as many random numbers (no extra grids behind the player's back).
  for (const seed of [1, 2, 3]) {
    random.mock.mockImplementation(seeded(seed));
    random.mock.resetCalls();
    const game = sdk.generatePuzzle();
    const calls = random.mock.callCount();
    random.mock.mockImplementation(seeded(seed));
    random.mock.resetCalls();
    const solved = sdk.generateSolvedBoard();
    const puzzle = sdk.boardToString(sdk.removeNumbers(solved, 45));
    assert.deepEqual(game, { puzzle, solution: sdk.boardToString(solved) }, 'seed ' + seed);
    assert.equal(random.mock.callCount(), calls, 'seed ' + seed);
  }
});

test('sudoku: generatePuzzle keeps the last unique puzzle when the blanks cannot be reached', (t) => {
  t.mock.method(Math, 'random', seeded(4));
  const game = sdk.generatePuzzle(70); // no Sudoku with 11 givens has one solution
  assert.ok(zeros(game.puzzle) < 70 && zeros(game.puzzle) > 45, zeros(game.puzzle) + ' blanks');
  assert.ok(isSolvedGrid(game.solution));
  assert.ok(keepsGivens(game.solution, game.puzzle));
  assert.equal(referenceCount(game.puzzle), 1);
});

test('sudoku: isCompleteValidGrid accepts any finished grid that follows the rules and keeps the givens', () => {
  assert.equal(sdk.isCompleteValidGrid(SOLUTION, PUZZLE), true);
  assert.equal(sdk.isCompleteValidGrid(AMBIGUOUS_STORED, AMBIGUOUS), true);
  assert.equal(sdk.isCompleteValidGrid(AMBIGUOUS_OTHER, AMBIGUOUS), true);
  assert.equal(sdk.isCompleteValidGrid(SOLUTION, '0'.repeat(81)), true);
  assert.equal(sdk.isCompleteValidGrid(AMBIGUOUS_OTHER, PUZZLE), false, 'a valid grid with other givens');
  assert.equal(sdk.isCompleteValidGrid(setAt(SOLUTION, 40, '0'), PUZZLE), false, 'an empty cell');
  // Swapping two digits of a row keeps the row but breaks two columns.
  const swapped = setAt(setAt(SOLUTION, 2, SOLUTION[3]), 3, SOLUTION[2]);
  assert.equal(sdk.isCompleteValidGrid(swapped, '0'.repeat(81)), false);
  assert.equal(sdk.isCompleteValidGrid(SOLUTION.slice(1), PUZZLE), false);
  assert.equal(sdk.isCompleteValidGrid(SOLUTION + '1', PUZZLE), false);
  assert.equal(sdk.isCompleteValidGrid(undefined, PUZZLE), false);
  assert.equal(sdk.isCompleteValidGrid(Number(SOLUTION.slice(0, 15)), PUZZLE), false);
});

test('sudoku: hintCandidates lists the empty and wrong cells, never a given', () => {
  const board = setAt(setAt(SOLUTION, 7, '0'), 30, '2').split('');
  assert.deepEqual(sdk.hintCandidates(board, SOLUTION), [7, 30]);
  assert.deepEqual(sdk.hintCandidates(SOLUTION.split(''), SOLUTION), []);
  assert.deepEqual(sdk.hintCandidates(PUZZLE.split(''), SOLUTION), [...PUZZLE].flatMap((d, i) => (d === '0' ? [i] : [])));
  assert.deepEqual(sdk.hintCandidates([], ''), [], 'no game yet');
});

test('sudoku: normalizeDigit always leaves one digit 1-9 or an empty cell', () => {
  const cases = [
    ['', '', ''], ['5', '', '5'], ['0', '', ''], ['x7', '', '7'], [' 5', '', '5'], ['a', '3', ''],
    ['٣', '', ''], ['５', '', ''], // Arabic-Indic and full-width digits are not 1-9
    ['47', '4', '7'], ['74', '4', '7'], ['44', '4', '4'], ['57', '', '7'], ['474', '4', '7'], ['1234', '9', '4'],
    [undefined, '', ''], [null, '', '']
  ];
  for (const [value, previous, expected] of cases) {
    assert.equal(sdk.normalizeDigit(value, previous), expected, JSON.stringify([value, previous]));
  }
});

test('sudoku: parseSave reads the save every version wrote and refuses anything unplayable', () => {
  assert.deepEqual(sdk.parseSave(BASELINE_SAVE), {
    puzzle: PUZZLE,
    solution: SOLUTION,
    board: setAt(setAt(PUZZLE, 2, '4'), 3, '1')
  });
  assert.deepEqual(sdk.parseSave(saveOf(PUZZLE, SOLUTION, PUZZLE).replace('}', ',"extra":1}')).board, PUZZLE);
  // A board that overwrites a given gets the given back.
  assert.equal(sdk.parseSave(saveOf(PUZZLE, SOLUTION, setAt(setAt(PUZZLE, 0, '9'), 2, '4'))).board, setAt(PUZZLE, 2, '4'));

  const bad = {
    'nothing saved': null,
    'not JSON': '{',
    'JSON null': 'null',
    'a number': '42',
    'an array': '[]',
    'an empty object': '{}',
    'no board': JSON.stringify({ puzzle: PUZZLE, solution: SOLUTION }),
    'no puzzle': JSON.stringify({ solution: SOLUTION, board: PUZZLE }),
    'no solution': JSON.stringify({ puzzle: PUZZLE, board: PUZZLE }),
    'a board of 40 cells': saveOf(PUZZLE, SOLUTION, PUZZLE.slice(0, 40)),
    'a board of 82 cells': saveOf(PUZZLE, SOLUTION, PUZZLE + '7'),
    'a board that is a number': JSON.stringify({ puzzle: PUZZLE, solution: SOLUTION, board: 5 }),
    'letters in the board': saveOf(PUZZLE, SOLUTION, setAt(PUZZLE, 2, 'a')),
    'letters in the puzzle': saveOf(setAt(PUZZLE, 2, 'x'), SOLUTION, PUZZLE),
    'a puzzle as an array': JSON.stringify({ puzzle: [...PUZZLE], solution: SOLUTION, board: PUZZLE }),
    'a solution with an empty cell': saveOf(PUZZLE, setAt(SOLUTION, 2, '0'), PUZZLE),
    'a solution that breaks the rules': saveOf('0'.repeat(81), setAt(setAt(SOLUTION, 2, '8'), 3, '4'), '0'.repeat(81)),
    'givens that disagree with the solution': saveOf(setAt(PUZZLE, 0, '6'), SOLUTION, setAt(PUZZLE, 0, '6'))
  };
  for (const [name, raw] of Object.entries(bad)) {
    assert.equal(sdk.parseSave(raw), null, name);
  }
});

// ── Start-up ────────────────────────────────────────────────────────────────

test('sudoku: under Node, loading the script starts nothing and exports the game API', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { exports: game, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML));
  assert.equal(els['sdk-board'].children.length, 0);
  assert.equal(localStorage.length, 0);
  assert.equal(hasClass(els['sdk-toast'], 'sdk-show'), false);
  for (const name of ['STORAGE_KEY', 'createEmptyBoard', 'shuffle', 'isValid', 'solveBoard',
    'generateSolvedBoard', 'removeNumbers', 'boardToString', 'loadGame', 'init']) {
    assert.ok(name in game, name);
  }
  assert.equal(window.sdkNewGame, game.newGame);
  assert.equal(window.sdkRestartGame, game.restartGame);
  assert.equal(window.sdkGiveHint, game.giveHint);
});

test('sudoku: Restart and Hint before any game do nothing, and loadGame reports a missing save', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { exports: game, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  game.restartGame();
  game.giveHint();
  assert.equal(localStorage.length, 0);
  assert.equal(els['sdk-board'].children.length, 0);
  assert.equal(game.loadGame(), false);
  assert.equal(els['sdk-board'].children.length, 0);
  localStorage.setItem(KEY, '{');
  assert.equal(game.loadGame(), false);
  assert.equal(localStorage.getItem(KEY), null, 'a broken save is removed');
  localStorage.setItem(KEY, BASELINE_SAVE);
  assert.equal(game.loadGame(), true);
  assert.equal(els['sdk-board'].children.length, 81);
});

test('sudoku: a first visit draws a fresh 45-blank puzzle, saves it and shows the toast for 2 seconds', (t) => {
  const game = openGame(t, { seed: 11 });
  const saved = game.saved();
  assert.ok(isSolvedGrid(saved.solution), saved.solution);
  assert.equal(zeros(saved.puzzle), 45);
  assert.ok(keepsGivens(saved.solution, saved.puzzle));
  assert.equal(saved.board, saved.puzzle);

  const cells = game.cells();
  assert.equal(cells.length, 81);
  cells.forEach((cell, i) => {
    const given = saved.puzzle[i] !== '0';
    assert.equal(cell.tagName, 'INPUT');
    assert.equal(cell.disabled, given, 'cell ' + i);
    assert.equal(hasClass(cell, 'sdk-cell-fixed'), given, 'cell ' + i);
    assert.equal(cell.value, given ? saved.puzzle[i] : '', 'cell ' + i);
    assert.equal(cell.type, 'tel');
    assert.equal(cell.inputMode, 'numeric');
    assert.equal(cell.pattern, '[1-9]*');
    assert.equal(cell.maxLength, 1);
  });
  assert.deepEqual(game.invalid(), []);
  // Thick box borders after columns 3 and 6 and after rows 3 and 6 only.
  const right = new Set(cells.map((c, i) => (hasClass(c, 'sdk-cell-right-border') ? i % 9 : -1)));
  const bottom = new Set(cells.map((c, i) => (hasClass(c, 'sdk-cell-bottom-border') ? Math.floor(i / 9) : -1)));
  assert.deepEqual([...right].filter((x) => x >= 0).sort(), [2, 5]);
  assert.deepEqual([...bottom].filter((x) => x >= 0).sort(), [2, 5]);

  assert.equal(game.toast(), 'Game saved');
  assert.equal(game.toastShown(), true);
  t.mock.timers.tick(1999);
  assert.equal(game.toastShown(), true);
  t.mock.timers.tick(1);
  assert.equal(game.toastShown(), false);
  assert.equal(game.status(), '');
});

test('sudoku: while the page is still loading the game waits for DOMContentLoaded', (t) => {
  const game = openGame(t, { save: BASELINE_SAVE, readyState: 'loading' });
  assert.equal(game.cells().length, 0);
  game.boot.ready();
  assert.equal(game.cells().length, 81);
  assert.equal(game.values(), setAt(setAt(PUZZLE, 2, '4'), 3, '1'));
});

test('sudoku: the buttons and the board input listener are wired once, also when init runs twice', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', seeded(2));
  const { exports: game, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  const board = els['sdk-board'];
  const cellListeners = () => board.children.reduce((n, cell) => n + listenerCount(cell), 0);
  let cellsAfterInit;
  // One click listener per button and one delegated input listener on the
  // board, after every action; no listener piles up anywhere else.  (Adding
  // the same function twice is a no-op in browsers too: a leak needs a new
  // function, which these counts catch.)
  const assertWiredOnce = (when) => {
    for (const id of ['sdk-new-game-btn', 'sdk-restart-btn', 'sdk-hint-btn']) {
      assert.equal(listenerCount(els[id], 'click'), 1, id + ' after ' + when);
      assert.equal(listenerCount(els[id]), 1, id + ' has no other listener after ' + when);
    }
    assert.equal(listenerCount(board, 'input'), 1, 'board input after ' + when);
    assert.equal(listenerCount(board), 1, 'board has no other listener after ' + when);
    assert.equal(board.children.length, 81, 'the cells are reused, not added, after ' + when);
    assert.equal(cellListeners(), cellsAfterInit, 'cell listeners after ' + when);
    assert.equal(listenerCount(document), 0, 'document listeners after ' + when);
    assert.equal(listenerCount(window), 0, 'window listeners after ' + when);
  };
  game.init();
  cellsAfterInit = cellListeners();
  assertWiredOnce('init');
  game.init();
  assertWiredOnce('a second init');
  const first = JSON.parse(localStorage.getItem(KEY)).puzzle;
  els['sdk-new-game-btn'].click();
  assert.notEqual(JSON.parse(localStorage.getItem(KEY)).puzzle, first);
  els['sdk-new-game-btn'].click();
  assertWiredOnce('two New Games');
  els['sdk-restart-btn'].click();
  assertWiredOnce('Restart');
  els['sdk-hint-btn'].click();
  assertWiredOnce('Hint');
  assert.equal(game.loadGame(), true);
  assertWiredOnce('an extra loadGame');
  // One typed digit runs the handler once: one save, one toast.
  const setItem = t.mock.method(localStorage, 'setItem');
  const empty = JSON.parse(localStorage.getItem(KEY)).board.indexOf('0');
  board.children[empty].value = '5';
  fire(board.children[empty], 'input');
  assert.equal(setItem.mock.callCount(), 1);
  assertWiredOnce('typing');
});

test('sudoku: a save in the format of every earlier version is restored after a reload', (t) => {
  const game = openGame(t, { save: BASELINE_SAVE });
  const cells = game.cells();
  assert.equal(cells.length, 81);
  assert.equal(cells[0].value, '5');
  assert.equal(cells[0].disabled, true);
  assert.equal(cells[2].value, '4');
  assert.equal(cells[2].disabled, false);
  assert.equal(cells[3].value, '1');
  assert.equal(cells[5].value, '');
  assert.equal(game.values(), setAt(setAt(PUZZLE, 2, '4'), 3, '1'));
  assert.deepEqual(game.invalid(), [3]);
  assert.equal(game.raw(), BASELINE_SAVE, 'loading does not rewrite the save');
  assert.equal(game.toastShown(), false);
  assert.equal(game.status(), '');
});

test('sudoku: a corrupt or partial save never breaks start-up: a fresh game replaces it', (t) => {
  const broken = [
    '{', 'null', '42', '[]', '{}', '"text"',
    JSON.stringify({ puzzle: PUZZLE, solution: SOLUTION }),
    JSON.stringify({ solution: SOLUTION, board: PUZZLE }),
    JSON.stringify({ puzzle: PUZZLE, solution: SOLUTION, board: 5 }),
    saveOf(PUZZLE, SOLUTION, PUZZLE.slice(0, 40)),
    saveOf(PUZZLE, SOLUTION, PUZZLE + '1'),
    saveOf(PUZZLE, SOLUTION.slice(0, 80) + '0', PUZZLE),
    saveOf(setAt(PUZZLE, 0, '6'), SOLUTION, PUZZLE)
  ];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', seeded(8));
  for (const raw of broken) {
    localStorage.setItem(KEY, raw);
    const game = view(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML)));
    assert.equal(game.cells().length, 81, raw);
    assert.ok(game.cells().every((c) => /^[1-9]?$/.test(c.value)), raw);
    const saved = game.saved();
    assert.equal(zeros(saved.puzzle), 45, raw);
    assert.equal(saved.board, saved.puzzle, raw);
    assert.deepEqual(game.invalid(), [], raw);
    game.boot.restore();
    localStorage.clear();
  }
  // A board that overwrites a given shows the given and can still be won.
  localStorage.setItem(KEY, saveOf(PUZZLE, SOLUTION, setAt(setAt(SOLUTION, 0, '9'), 2, '0')));
  const game = view(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML)));
  assert.equal(game.cells()[0].value, '5');
  assert.deepEqual(game.invalid(), []);
  assert.equal(game.status(), '');
  game.type(2, '4');
  assert.equal(game.status(), SOLVED_TEXT);
});

test('sudoku: blocked storage never stops the game (no save, no false "Game saved", the win still counts)', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => Object.defineProperty(globalThis, 'localStorage', descriptor));
  // Chrome with site data blocked: reading window.localStorage throws.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: The operation is insecure.'); }
  });
  const game = openGame(t, { seed: 6 });
  assert.equal(game.cells().length, 81);
  assert.equal(game.toastShown(), false);
  const empty = game.values().indexOf('0');
  game.type(empty, '5');
  assert.equal(game.cells()[empty].value, '5');
  game.click('sdk-hint-btn');
  game.click('sdk-restart-btn');
  assert.equal(game.cells()[empty].value, '');
  // Hint until the board is full: the win is still detected.
  for (let i = 0; i < 45; i++) game.click('sdk-hint-btn');
  assert.equal(game.status(), SOLVED_TEXT);
  assert.equal(game.toast(), 'Victory!');
});

test('sudoku: failing getItem, setItem or removeItem never stops the game', (t) => {
  const game = openGame(t, { save: saveOf(PUZZLE, SOLUTION, setAt(setAt(SOLUTION, 2, '0'), 3, '0')) });
  const quota = () => { throw new Error('QuotaExceededError'); };
  // A full storage: the move shows, nothing is saved, the win still counts.
  const setItem = t.mock.method(localStorage, 'setItem', quota);
  game.type(3, '6');
  assert.equal(setItem.mock.callCount(), 1);
  assert.equal(game.cells()[3].value, '6');
  assert.equal(game.toastShown(), false, 'no "Game saved" when nothing was saved');
  assert.equal(game.saved().board[3], '0', 'the old save stays');
  const removeItem = t.mock.method(localStorage, 'removeItem', quota);
  game.type(2, '4');
  assert.equal(removeItem.mock.callCount(), 1);
  assert.equal(game.status(), SOLVED_TEXT);
  assert.equal(game.toast(), 'Victory!');

  // getItem throwing at start-up: a fresh game.
  game.boot.restore();
  setItem.mock.restore();
  t.mock.method(localStorage, 'getItem', quota);
  const fresh = view(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML)));
  assert.equal(fresh.cells().length, 81);
  assert.equal(zeros(fresh.values()), 45);
});

// ── Playing ─────────────────────────────────────────────────────────────────

test('sudoku: typing keeps one digit 1-9, saves the move and marks or clears mistakes', (t) => {
  const game = openGame(t, { save: saveOf(PUZZLE, SOLUTION, PUZZLE) });
  const cell = game.type(2, 'x7');
  assert.equal(cell.value, '7');
  assert.equal(game.saved().board[2], '7');
  assert.deepEqual(game.invalid(), [2]);
  assert.equal(game.toast(), 'Game saved');

  game.type(2, '0');
  assert.equal(cell.value, '');
  assert.equal(game.saved().board, PUZZLE);
  assert.deepEqual(game.invalid(), []);

  game.type(2, '4');
  assert.equal(game.saved().board[2], '4');
  assert.deepEqual(game.invalid(), []);

  game.type(2, ''); // Backspace
  assert.equal(game.saved().board, PUZZLE);
  game.type(2, ' 4');
  assert.equal(cell.value, '4');
  game.type(2, '٣');
  assert.equal(cell.value, '');
  assert.equal(game.saved().board, PUZZLE);
});

test('sudoku: a cell keeps one digit even when its input holds several, so the save stays 81 cells', (t) => {
  const game = openGame(t, { save: saveOf(PUZZLE, SOLUTION, PUZZLE) });
  game.type(2, '4');
  const cell = game.type(2, '47'); // an IME or autofill that ignores maxlength
  assert.equal(cell.value, '7');
  assert.equal(game.saved().board.length, 81);
  assert.equal(game.saved().board, setAt(PUZZLE, 2, '7'));
  game.type(2, '57');
  assert.equal(cell.value, '5');
  game.type(3, '6123');
  assert.equal(game.saved().board, setAt(setAt(PUZZLE, 2, '5'), 3, '3'));
  assert.deepEqual(game.invalid(), [2, 3]);

  // After a reload every cell shows what it showed before.
  const shown = game.values();
  game.boot.restore();
  const again = view(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML)));
  assert.equal(again.values(), shown);
  assert.deepEqual(again.invalid(), [2, 3]);
});

test('sudoku: givens are disabled and ignore input', (t) => {
  const game = openGame(t, { save: BASELINE_SAVE });
  const given = game.cells()[0];
  assert.equal(given.disabled, true);
  given.value = '9'; // a script, since a disabled input takes no typing
  fire(given, 'input');
  assert.equal(game.raw(), BASELINE_SAVE);
  assert.equal(game.toastShown(), false);
  // An input event from something that is not a cell is ignored too.
  fire(game.els['sdk-board'], 'input');
  assert.equal(game.raw(), BASELINE_SAVE);
});

test('sudoku: typing the same digit again or a rejected key changes nothing and saves nothing', (t) => {
  const game = openGame(t, { save: BASELINE_SAVE });
  // The cell is still cleaned up: no junk text stays visible.
  assert.equal(game.type(5, 'q').value, '');
  assert.equal(game.type(2, '4').value, '4');
  // Cell 2 holds 4: an input that ends as "44" (an IME or autofill that
  // ignores maxlength) shows one 4 again.
  assert.equal(game.type(2, '44').value, '4');
  assert.equal(game.type(2, 'a4').value, '4');
  assert.equal(game.values(), setAt(setAt(PUZZLE, 2, '4'), 3, '1'));
  assert.deepEqual(game.invalid(), [3]);
  assert.equal(game.raw(), BASELINE_SAVE);
  assert.equal(game.toastShown(), false);
});

test('sudoku: typing the last missing digit wins, removes the save and shows Victory', (t) => {
  const game = openGame(t, { save: saveOf(PUZZLE, SOLUTION, setAt(SOLUTION, 40, '0')) });
  game.type(40, '5');
  assert.equal(game.status(), SOLVED_TEXT);
  assert.equal(game.toast(), 'Victory!');
  assert.equal(game.raw(), null);
  assert.deepEqual(game.invalid(), []);
});

test('sudoku: every new puzzle has exactly one solution, so a valid grid always matches the solution', (t) => {
  const game = openGame(t, { seed: 21 });
  for (let i = 0; i < 25; i++) {
    const { puzzle, solution } = game.saved();
    assert.equal(zeros(puzzle), 45);
    assert.equal(referenceCount(puzzle), 1, puzzle);
    assert.ok(keepsGivens(solution, puzzle));
    // The reused inputs follow each new puzzle.
    assert.equal(game.values(), puzzle);
    game.assertGivens(puzzle, 'new game ' + i);
    assert.deepEqual(game.invalid(), [], 'new game ' + i);
    game.click('sdk-new-game-btn');
  }
});

test('sudoku: any finished grid that follows the rules wins, also on an older puzzle with two solutions', (t) => {
  const game = openGame(t, { save: saveOf(AMBIGUOUS, AMBIGUOUS_STORED, setAt(AMBIGUOUS_OTHER, 80, '0')) });
  assert.deepEqual(game.invalid(), [27, 28, 63, 64], 'digits of the other solution differ from the stored one');
  game.type(80, AMBIGUOUS_OTHER[80]);
  assert.equal(game.values(), AMBIGUOUS_OTHER);
  assert.equal(game.status(), SOLVED_TEXT);
  assert.equal(game.toast(), 'Victory!');
  assert.equal(game.raw(), null);
  assert.deepEqual(game.invalid(), [], 'nothing stays red on a solved board');
  // Hint has nothing left to fix, so it cannot break the finished grid.
  game.click('sdk-hint-btn');
  assert.equal(game.values(), AMBIGUOUS_OTHER);
  assert.equal(game.raw(), null);
});

test('sudoku: an older save that already holds a finished grid opens as solved', (t) => {
  const game = openGame(t, { save: saveOf(AMBIGUOUS, AMBIGUOUS_STORED, AMBIGUOUS_OTHER) });
  assert.equal(game.status(), SOLVED_TEXT);
  assert.equal(game.raw(), null);
  assert.deepEqual(game.invalid(), []);
});

test('sudoku: after a win the status follows the board: an edit clears it and is saved, fixing it wins again', (t) => {
  const game = openGame(t, { save: saveOf(PUZZLE, SOLUTION, setAt(SOLUTION, 2, '0')) });
  game.type(2, '4');
  assert.equal(game.status(), SOLVED_TEXT);
  assert.equal(game.raw(), null);

  game.type(2, '');
  game.type(2, '9');
  assert.equal(game.status(), '');
  assert.deepEqual(game.invalid(), [2]);
  assert.equal(game.saved().board, setAt(SOLUTION, 2, '9'));
  assert.equal(game.toast(), 'Game saved');

  game.type(2, '4');
  assert.equal(game.status(), SOLVED_TEXT);
  assert.equal(game.toast(), 'Victory!');
  assert.equal(game.raw(), null);
});

test('sudoku: each Hint fixes one wrong or empty cell, keeps it editable, and the last one wins', (t) => {
  const game = openGame(t, { save: BASELINE_SAVE, seed: 9 });
  let board = game.values();
  let hints = 0;
  while (game.status() === '') {
    game.click('sdk-hint-btn');
    hints++;
    const next = game.values();
    const changed = [...next].flatMap((d, i) => (d !== board[i] ? [i] : []));
    assert.equal(changed.length, 1, 'hint ' + hints);
    assert.equal(next[changed[0]], SOLUTION[changed[0]]);
    assert.equal(PUZZLE[changed[0]], '0', 'never a given');
    assert.notEqual(changed[0], 2, 'never the correct entry');
    assert.equal(game.cells()[changed[0]].disabled, false);
    if (game.status() === '') assert.equal(game.saved().board, next);
    board = next;
    assert.ok(hints <= 50, 'too many hints');
  }
  // 51 empty cells, one filled correctly and one wrongly: 50 cells to fix.
  assert.equal(hints, 50);
  assert.equal(game.status(), SOLVED_TEXT);
  assert.equal(game.toast(), 'Victory!');
  assert.equal(game.raw(), null);
  assert.equal(game.values(), SOLUTION);

  // On a solved board Hint does nothing: no save, no new toast.
  t.mock.timers.tick(2000);
  game.click('sdk-hint-btn');
  assert.equal(game.raw(), null);
  assert.equal(game.toastShown(), false);
});

test('sudoku: Hint picks among the cells to fix with Math.random, and the focused cell keeps its focus', (t) => {
  const game = openGame(t, { save: saveOf(PUZZLE, SOLUTION, setAt(setAt(SOLUTION, 10, '0'), 70, '0')) });
  const cells = game.cells().slice();
  cells[70].focus();
  Math.random.mock.mockImplementation(() => 0.999);
  window.sdkGiveHint();
  assert.equal(game.values(), setAt(SOLUTION, 10, '0'), 'the last candidate');
  assert.ok(document.activeElement === cells[70], 'cell 70 keeps the focus');
  assert.ok(game.cells().length === 81 && game.cells().every((c, i) => c === cells[i]), 'the same 81 inputs');
  Math.random.mock.mockImplementation(() => 0);
  game.type(70, '1');
  window.sdkGiveHint();
  assert.equal(game.values()[10], SOLUTION[10], 'the first candidate');
  assert.equal(game.values()[70], '1');
});

test('sudoku: Restart wipes the player entries and the status but keeps the puzzle and its solution', (t) => {
  const game = openGame(t, { save: saveOf(PUZZLE, SOLUTION, setAt(setAt(SOLUTION, 2, '0'), 3, '1')) });
  game.type(3, '');
  game.type(3, '6');
  game.type(2, '4');
  assert.equal(game.status(), SOLVED_TEXT);

  game.click('sdk-restart-btn');
  assert.deepEqual(game.saved(), { puzzle: PUZZLE, solution: SOLUTION, board: PUZZLE });
  assert.equal(game.status(), '');
  assert.equal(game.values(), PUZZLE);
  assert.deepEqual(game.invalid(), []);
  assert.equal(game.toast(), 'Game saved');
  assert.equal(window.sdkRestartGame, game.boot.exposed.sdkRestartGame);
});

test('sudoku: New Game after a win clears the status and starts a fresh puzzle (also by Enter on the button)', (t) => {
  const game = openGame(t, { save: saveOf(PUZZLE, SOLUTION, setAt(SOLUTION, 2, '0')), seed: 13 });
  game.type(2, '4');
  assert.equal(game.status(), SOLVED_TEXT);
  // The 81 inputs are reused, so after each New Game every cell must follow
  // the new puzzle, and a cell that was a given before must take a digit.
  let previous = PUZZLE;
  const assertFreshGame = (when) => {
    const { puzzle, solution } = game.saved();
    assert.notEqual(puzzle, previous, when);
    assert.equal(zeros(puzzle), 45, when);
    assert.equal(game.status(), '', when);
    assert.equal(game.values(), puzzle, when);
    game.assertGivens(puzzle, when);
    assert.deepEqual(game.invalid(), [], when);
    const freed = freedCell(previous, puzzle);
    assert.notEqual(freed, -1, 'a former given is empty now, ' + when);
    game.type(freed, solution[freed]);
    assert.equal(game.saved().board, setAt(puzzle, freed, solution[freed]), when);
    assert.deepEqual(game.invalid(), [], when);
    previous = puzzle;
  };

  game.click('sdk-new-game-btn');
  assertFreshGame('a click on New Game');
  game.els['sdk-new-game-btn'].focus();
  pressKey('Enter');
  assertFreshGame('Enter on New Game');
  window.sdkNewGame();
  assertFreshGame('window.sdkNewGame()');
});

test('sudoku: loading a save with another puzzle moves the givens with it, so freed cells take digits', (t) => {
  // loadGame runs at start-up only, but it must not depend on the puzzle the
  // reused inputs showed before.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', seeded(4));
  const loaded = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  const game = view(loaded);
  loaded.exports.init();
  const before = game.saved().puzzle;
  game.assertGivens(before, 'init');

  // A save with another puzzle, one correct entry (cell 2) and one wrong (cell 3).
  localStorage.setItem(KEY, BASELINE_SAVE);
  assert.equal(loaded.exports.loadGame(), true);
  assert.equal(game.values(), setAt(setAt(PUZZLE, 2, '4'), 3, '1'));
  game.assertGivens(PUZZLE, 'loading the baseline save');
  assert.deepEqual(game.invalid(), [3]);
  const freed = freedCell(before, PUZZLE);
  assert.notEqual(freed, -1);
  game.type(freed, SOLUTION[freed]);
  assert.equal(game.saved().board[freed], SOLUTION[freed]);
  assert.deepEqual(game.invalid(), [3]);

  // And back the other way: cells that were empty become givens.
  localStorage.setItem(KEY, saveOf(AMBIGUOUS, AMBIGUOUS_STORED, AMBIGUOUS));
  assert.equal(loaded.exports.loadGame(), true);
  assert.equal(game.values(), AMBIGUOUS);
  game.assertGivens(AMBIGUOUS, 'loading a second save');
  assert.deepEqual(game.invalid(), []);
  assert.equal(game.cells()[2].disabled, true, 'cell 2 held a player entry and is a given now');
  const freedAgain = freedCell(PUZZLE, AMBIGUOUS);
  assert.notEqual(freedAgain, -1);
  game.type(freedAgain, AMBIGUOUS_STORED[freedAgain]);
  assert.equal(game.saved().board, setAt(AMBIGUOUS, freedAgain, AMBIGUOUS_STORED[freedAgain]));
  assert.equal(game.status(), '');
});

test('sudoku: a newer toast keeps its full 2 seconds instead of ending with an older timer', (t) => {
  const game = openGame(t, { save: saveOf(PUZZLE, SOLUTION, setAt(setAt(SOLUTION, 2, '0'), 3, '0')) });
  game.type(3, '6'); // 'Game saved' at t = 0
  t.mock.timers.tick(1900);
  game.type(2, '4'); // 'Victory!' at t = 1.9 s
  assert.equal(game.toast(), 'Victory!');
  t.mock.timers.tick(100);
  assert.equal(game.toastShown(), true, 'still shown at t = 2 s');
  t.mock.timers.tick(1899);
  assert.equal(game.toastShown(), true);
  t.mock.timers.tick(1);
  assert.equal(game.toastShown(), false, 'hidden at t = 3.9 s');

  // Restart and New Game replace a pending toast timer the same way.
  game.click('sdk-restart-btn');
  t.mock.timers.tick(1500);
  game.click('sdk-new-game-btn');
  t.mock.timers.tick(1999);
  assert.equal(game.toastShown(), true);
  t.mock.timers.tick(1);
  assert.equal(game.toastShown(), false);
});
