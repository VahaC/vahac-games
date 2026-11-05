// tests/minesweeper.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs,
  fire, pressKey, listenerCount, readRepoFile, idsInHtml, htmlPageSpec,
  embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'minesweeper';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

const PRESETS = {
  easy: { rows: 9, cols: 9, mines: 10 },
  medium: { rows: 14, cols: 14, mines: 35 },
  hard: { rows: 18, cols: 18, mines: 65 }
};
const READY = 'Awaiting tactical deployment.';
const WON = 'Mission completed.';
const LOST = 'Mine triggered.';
const WIN_TOAST = 'Victory achieved.';
const LOSS_TOAST = 'System failure detected.';
const MINE = '✹';
const FLAG = '⚑';
const SAVE_KEY = 'msp-save-state';
const SAVE_FIELDS = ['rows', 'cols', 'mines', 'board', 'revealed', 'flagged', 'firstClick', 'timer', 'interval', 'gameOver', 'difficulty'];
const CELL_FIELDS = ['mine', 'revealed', 'flagged', 'adjacent'];

// A save written by the first version of the game (captured from it: Easy,
// first reveal at (4, 4), a flag on a mine and one on a safe cell, 3 s on
// the clock; interval is that version's timer id).  Map of the board
// (digit = open, # = closed, * = mine, F = flagged mine, f = flagged safe):
const BASELINE_MAP = [
  '00002F200',
  '11002*200',
  '*10011100',
  'f21100000',
  '##*100000',
  '*##212110',
  '####*#*20',
  '#*####*20',
  '##*####10'
];
const BASELINE_SAVE =
  '{"rows":9,"cols":9,"mines":10,"board":[' +
  '[{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":2},{"mine":true,"revealed":false,"flagged":true,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0}],' +
  '[{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":2},{"mine":true,"revealed":false,"flagged":false,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0}],' +
  '[{"mine":true,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0}],' +
  '[{"mine":false,"revealed":false,"flagged":true,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0}],' +
  '[{"mine":false,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":false,"flagged":false,"adjacent":2},{"mine":true,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0},{"mine":false,"revealed":true,"flagged":false,"adjacent":0}],' +
  '[{"mine":true,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":false,"flagged":false,"adjacent":2},{"mine":false,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":0}],' +
  '[{"mine":false,"revealed":false,"flagged":false,"adjacent":2},{"mine":false,"revealed":false,"flagged":false,"adjacent":2},{"mine":false,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":false,"flagged":false,"adjacent":1},{"mine":true,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":false,"flagged":false,"adjacent":3},{"mine":true,"revealed":false,"flagged":false,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":0}],' +
  '[{"mine":false,"revealed":false,"flagged":false,"adjacent":1},{"mine":true,"revealed":false,"flagged":false,"adjacent":2},{"mine":false,"revealed":false,"flagged":false,"adjacent":2},{"mine":false,"revealed":false,"flagged":false,"adjacent":2},{"mine":false,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":false,"flagged":false,"adjacent":3},{"mine":true,"revealed":false,"flagged":false,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":2},{"mine":false,"revealed":true,"flagged":false,"adjacent":0}],' +
  '[{"mine":false,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":false,"flagged":false,"adjacent":2},{"mine":true,"revealed":false,"flagged":false,"adjacent":2},{"mine":false,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":false,"flagged":false,"adjacent":0},{"mine":false,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":false,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":1},{"mine":false,"revealed":true,"flagged":false,"adjacent":0}]' +
  '],"revealed":50,"flagged":2,"firstClick":false,"timer":3,"interval":14,"gameOver":false,"difficulty":"easy"}';

test.beforeEach(() => resetStubs());

// ── An independent model of the board ───────────────────────────────────────

const key = (r, c) => r + ',' + c;
const keySet = (cells) => new Set(cells.map(([r, c]) => key(r, c)));
const fromKey = (k) => k.split(',').map(Number);

function allCells(rows, cols) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out.push([r, c]);
  }
  return out;
}

function neighbours(rows, cols, r, c) {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = r + dr;
      const nc = c + dc;
      if ((dr || dc) && nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push([nr, nc]);
    }
  }
  return out;
}

function minesAround(mines, rows, cols, r, c) {
  return neighbours(rows, cols, r, c).filter(([nr, nc]) => mines.has(key(nr, nc))).length;
}

// The cells a reveal of (r, c) opens: the cell itself and, from every cell
// with no mine around it, each neighbour that is not a mine and not flagged.
function floodModel(rows, cols, mines, flags, r, c) {
  const open = new Set([key(r, c)]);
  const queue = minesAround(mines, rows, cols, r, c) === 0 ? [[r, c]] : [];
  while (queue.length) {
    const [qr, qc] = queue.shift();
    for (const [nr, nc] of neighbours(rows, cols, qr, qc)) {
      const k = key(nr, nc);
      if (open.has(k) || mines.has(k) || flags.has(k)) continue;
      open.add(k);
      if (minesAround(mines, rows, cols, nr, nc) === 0) queue.push([nr, nc]);
    }
  }
  return open;
}

// An Easy layout of 10 mines: a reveal at (4, 4) opens every safe cell but
// (0, 1), which sits between two mines above numbered cells only.
const LAYOUT = [[0, 0], [0, 2], [6, 0], [6, 1], [7, 0], [7, 1], [7, 2], [8, 0], [8, 1], [8, 2]];
const LAYOUT_OPEN = [...floodModel(9, 9, keySet(LAYOUT), new Set(), 4, 4)].map(fromKey);

// The preset's mines packed into the bottom rows (Medium and Hard layouts).
function bottomMines(level) {
  const { rows, cols, mines } = PRESETS[level];
  return allCells(rows, cols).slice(rows * cols - mines);
}

// A save in the first version's format: rows, cols, mines, board (rows x cols
// of { mine, revealed, flagged, adjacent }, a mine's adjacent counting the
// mine itself), revealed, flagged, firstClick, timer, interval (a timer id,
// a number in browsers), gameOver and difficulty.
function makeSave({ difficulty = 'easy', mines = [], open = [], flags = [], timer = 0, gameOver = false } = {}) {
  const { rows, cols } = PRESETS[difficulty];
  const mineSet = keySet(mines);
  const openSet = keySet(open);
  const flagSet = keySet(flags);
  let revealed = 0;
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const k = key(r, c);
      const mine = mineSet.has(k);
      if (openSet.has(k) && !mine) revealed++;
      row.push({
        mine,
        revealed: openSet.has(k),
        flagged: flagSet.has(k),
        adjacent: minesAround(mineSet, rows, cols, r, c) + (mine ? 1 : 0)
      });
    }
    board.push(row);
  }
  return {
    rows, cols, mines: PRESETS[difficulty].mines, board, revealed, flagged: flagSet.size,
    firstClick: mineSet.size === 0, timer, interval: 14, gameOver, difficulty
  };
}

const inProgress = (extra) => makeSave({ mines: LAYOUT, open: LAYOUT_OPEN, timer: 12, ...extra });

// ── Pages ────────────────────────────────────────────────────────────────────

function fakeTimers(t) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
}

function writeStorage({ save, best = {} } = {}) {
  if (save !== undefined) localStorage.setItem(SAVE_KEY, typeof save === 'string' ? save : JSON.stringify(save));
  for (const [level, value] of Object.entries(best)) localStorage.setItem('msp-best-' + level, String(value));
}

// What a player sees and does: the elements, the cell buttons, clicks.
function pageView(els, extra) {
  const board = els['msp-board'];
  const view = {
    els,
    board,
    text: (id) => els[id].textContent,
    cells: () => board.children,
    cell: (r, c) => board.children.find((b) => b.getAttribute('data-row') === String(r) && b.getAttribute('data-col') === String(c)),
    click: (r, c) => view.cell(r, c).click(),
    flag: (r, c) => fire(view.cell(r, c), 'contextmenu'),
    opened: () => board.children.filter((b) => b.classList.contains('msp-cell-revealed')).length,
    toastVisible: () => els['msp-toast'].classList.contains('msp-toast-visible'),
    saved: () => JSON.parse(localStorage.getItem(SAVE_KEY)),
    newGame: () => els['msp-new-game'].click(),
    restart: () => els['msp-restart-game'].click(),
    choose: (level) => {
      els['msp-difficulty'].value = level;
      return fire(els['msp-difficulty'], 'change');
    }
  };
  return Object.assign(view, extra);
}

function bootPage(storage, options) {
  writeStorage(storage);
  const b = bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options);
  return pageView(b.els, { page: b.page, ready: b.ready, restore: b.restore });
}

// The page as a browser loads it: index.html's elements and script.js run as
// a classic script (its start-up code runs init), after writing storage.
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

// The script loaded as a module on the page with init run by hand, so a test
// can also reach mspState and the exported functions.
function openModule(t, storage) {
  fakeTimers(t);
  writeStorage(storage);
  const { exports: msp, els, page } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  msp.mspInit();
  return pageView(els, { msp, state: msp.mspState, page });
}

// A fresh board straight on mspState, for the rules without a page.
function freshState(msp, level) {
  const { rows, cols, mines } = PRESETS[level];
  return Object.assign(msp.mspState, {
    difficulty: level, rows, cols, mines, board: msp.mspCreateEmptyBoard(rows, cols),
    revealed: 0, flagged: 0, firstClick: true, gameOver: false, timer: 0
  });
}

function layMines(msp, cells) {
  const state = msp.mspState;
  for (const [r, c] of cells) state.board[r][c].mine = true;
  state.firstClick = false;
  msp.mspCalculateAdjacency(state.board);
  return state;
}

function minesOf(board) {
  return allCells(board.length, board[0].length).filter(([r, c]) => board[r][c].mine);
}

const px = (value) => {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(String(value).trim());
  assert.ok(m, 'a px length: ' + value);
  return Number(m[1]);
};

// ── Files ────────────────────────────────────────────────────────────────────

test('minesweeper: every id the script looks up exists once in index.html, and ids, classes and CSS variables are msp- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'msp-best-time', 'msp-board', 'msp-difficulty', 'msp-mine-counter',
    'msp-new-game', 'msp-restart-game', 'msp-status-text', 'msp-timer', 'msp-toast'
  ]);
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^msp-/);

  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 20);
  for (const name of classes) assert.match(name, /^msp-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^msp-/, selector);
    }
  }
  for (const m of CSS.matchAll(/--([\w-]+)/g)) assert.match(m[1], /^msp-/);
  for (const m of JS.matchAll(/--([\w-]+)/g)) assert.match(m[1], /^msp-/);
});

test('minesweeper: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="msp-wrapper"'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');

  // Without this rule the body is transparent with the browser's 8px margin: light
  // text vanishes in a light browser theme and a white frame shows round the game.
  const bg = CSS.match(/--msp-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  // build-embed copies the markup from the wrapper up to the first <script> only.
  assert.doesNotMatch(embedded, /<style/i);
});

test('minesweeper: script.js is one strict IIFE in ES5', () => {
  assert.match(JS, /^(\/\/[^\n]*\r?\n)*\r?\n?\(function \(\) \{\r?\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/\(function \(\) \{/g).length, 1);
  const code = JS
    .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('minesweeper: the cells draw their text in the light text colour, so revealed numbers are readable', () => {
  const rules = cssRules(CSS);
  for (const vw of [1280, 640, 375, 320]) {
    const cell = declsAt(rules, '.msp-cell', vw);
    assert.equal(cell.color, 'var(--msp-text)', vw + 'px');
    assert.equal(cell['font-family'], 'inherit', vw + 'px');
  }
  assert.equal(declsAt(rules, '.msp-wrapper', 1280)['--msp-text'], '#dbeafe');
  // Flags and mines keep their own colours: their rules come after .msp-cell.
  assert.equal(declsAt(rules, '.msp-cell-flagged', 375).color, 'var(--msp-amber)');
  assert.equal(declsAt(rules, '.msp-cell-mine', 375).color, 'var(--msp-red)');
  const at = (selector) => rules.findIndex((rule) => rule.selectors.includes(selector));
  assert.ok(at('.msp-cell') < at('.msp-cell-flagged'));
  assert.ok(at('.msp-cell') < at('.msp-cell-mine'));
});

test('minesweeper: at every width from 320 px the Easy board fits its section, and a wider board scrolls from its first column', () => {
  const rules = cssRules(CSS);
  assert.equal(declsAt(rules, '.msp-board-section', 320).overflow, 'auto');
  for (let vw = 320; vw <= 1280; vw++) {
    const wrapper = declsAt(rules, '.msp-wrapper', vw);
    const section = declsAt(rules, '.msp-board-section', vw);
    const board = declsAt(rules, '.msp-board', vw);
    const cell = declsAt(rules, '.msp-cell', vw);
    // The grid tracks (var(--msp-cell-size), set by script.js) and the cells share one size.
    assert.equal(cell.width, 'var(--msp-cell-size)', vw + 'px');
    assert.equal(cell.height, 'var(--msp-cell-size)', vw + 'px');
    assert.equal(declsAt(rules, '.msp-wrapper *', vw)['box-sizing'], 'border-box');
    // A board wider than its section grows to hold its tracks, so the section
    // scrolls from column 0 instead of centring it past both edges.
    assert.equal(board['min-width'], 'max-content', vw + 'px');
    assert.equal(board['justify-content'], 'center');
    assert.equal(section['padding-left'], undefined);
    const size = px(wrapper['--msp-cell-size']);
    const width = 9 * size + 8 * px(board.gap) + 2 * px(board.padding) + 2 * px(board.border.split(/\s+/)[0]);
    const available = Math.min(vw - 2 * px(wrapper.padding), px(section['max-width']));
    assert.ok(width <= available, vw + 'px: an Easy board of ' + width + 'px in ' + available + 'px');
    assert.ok(size >= 26, vw + 'px: cells of ' + size + 'px');
  }
  // The desktop look is unchanged: 42px cells, 6px gaps, 18px padding.
  assert.equal(declsAt(rules, '.msp-wrapper', 1280)['--msp-cell-size'], '42px');
  assert.equal(declsAt(rules, '.msp-board', 1280).gap, '6px');
  assert.equal(declsAt(rules, '.msp-board', 1280).padding, '18px');
});

// ── Board rules ──────────────────────────────────────────────────────────────

test('minesweeper: the presets, an empty board and the neighbours of corner, edge and inner cells', () => {
  const msp = loadScript(SCRIPT);
  assert.deepEqual(msp.mspDifficulties, PRESETS);
  const empty = { mine: false, revealed: false, flagged: false, adjacent: 0 };
  const small = msp.mspCreateEmptyBoard(2, 3);
  assert.deepEqual(small, [[empty, empty, empty], [empty, empty, empty]]);
  small[0][0].mine = true;
  assert.equal(small[0][1].mine, false, 'every cell is its own object');

  function around(board, r, c) {
    const out = [];
    msp.mspForEachNeighbour(board, r, c, (cell, nr, nc) => {
      assert.equal(cell, board[nr][nc]);
      out.push([nr, nc]);
    });
    return out;
  }
  const board = msp.mspCreateEmptyBoard(9, 9);
  assert.deepEqual(around(board, 0, 0), [[0, 1], [1, 0], [1, 1]]);
  assert.deepEqual(around(board, 0, 4), [[0, 3], [0, 5], [1, 3], [1, 4], [1, 5]]);
  assert.deepEqual(around(board, 4, 0), [[3, 0], [3, 1], [4, 1], [5, 0], [5, 1]]);
  assert.deepEqual(around(board, 8, 8), [[7, 7], [7, 8], [8, 7]]);
  assert.deepEqual(around(board, 4, 4), [[3, 3], [3, 4], [3, 5], [4, 3], [4, 5], [5, 3], [5, 4], [5, 5]]);
  const wide = msp.mspCreateEmptyBoard(2, 5);
  assert.deepEqual(around(wide, 1, 4), [[0, 3], [0, 4], [1, 3]]);
  for (const [r, c] of allCells(9, 9)) assert.deepEqual(around(board, r, c), neighbours(9, 9, r, c));
});

test('minesweeper: adjacency counts all eight neighbours, stops at the edges and counts a mine cell itself', () => {
  const msp = loadScript(SCRIPT);
  const board = msp.mspCreateEmptyBoard(9, 9);
  const mines = [[0, 0], [0, 1], [1, 0], [4, 4], [8, 8]];
  for (const [r, c] of mines) board[r][c].mine = true;
  msp.mspCalculateAdjacency(board);
  const adj = (r, c) => board[r][c].adjacent;

  assert.equal(adj(1, 1), 3); // three mines around one cell
  assert.equal(adj(0, 0), 3); // a mine counts itself too (never shown)
  assert.equal(adj(4, 4), 1);
  assert.equal(adj(0, 2), 1);
  assert.equal(adj(2, 2), 0);
  assert.equal(adj(7, 7), 1); // corner mine, diagonal neighbour
  assert.equal(adj(8, 7), 1);
  for (const [r, c] of neighbours(9, 9, 4, 4)) assert.equal(adj(r, c), 1);
  assert.equal(adj(6, 6), 0);
  const set = keySet(mines);
  for (const [r, c] of allCells(9, 9)) {
    assert.equal(adj(r, c), minesAround(set, 9, 9, r, c) + (set.has(key(r, c)) ? 1 : 0), key(r, c));
  }

  // mspCountBoard: mines, flags, opened safe cells and opened mines.
  board[0][0].revealed = true;
  board[0][0].flagged = true;
  board[5][5].revealed = true;
  board[6][6].revealed = true;
  board[3][3].flagged = true;
  assert.deepEqual(msp.mspCountBoard(board), { mines: 5, flagged: 2, revealed: 2, revealedMines: 1 });
});

test('minesweeper: the first reveal lays the mines, never under the clicked cell, and opens the right area', (t) => {
  const msp = loadScript(SCRIPT);
  const random = t.mock.method(Math, 'random', seeded(1));

  for (const level of ['easy', 'medium', 'hard']) {
    for (let seed = 1; seed <= 10; seed++) {
      random.mock.mockImplementation(seeded(seed));
      random.mock.resetCalls();
      const state = freshState(msp, level);
      const r = (seed * 3) % state.rows;
      const c = (seed * 5) % state.cols;
      const where = level + ' seed ' + seed;
      const result = msp.mspRevealCell(r, c);

      const mines = minesOf(state.board);
      assert.equal(mines.length, state.mines, where);
      assert.equal(random.mock.callCount(), state.mines, where + ': one draw per mine');
      assert.equal(state.board[r][c].mine, false, where);
      assert.equal(state.firstClick, false, where);
      const mineSet = keySet(mines);
      for (const [cr, cc] of allCells(state.rows, state.cols)) {
        const expected = minesAround(mineSet, state.rows, state.cols, cr, cc) + (mineSet.has(key(cr, cc)) ? 1 : 0);
        assert.equal(state.board[cr][cc].adjacent, expected, where + ' adjacency ' + key(cr, cc));
      }
      const open = floodModel(state.rows, state.cols, mineSet, new Set(), r, c);
      for (const [cr, cc] of allCells(state.rows, state.cols)) {
        assert.equal(state.board[cr][cc].revealed, open.has(key(cr, cc)), where + ' revealed ' + key(cr, cc));
      }
      assert.equal(state.revealed, open.size, where);
      const safe = state.rows * state.cols - state.mines;
      assert.equal(result, open.size === safe ? 'won' : 'ok', where);
    }
  }

  // The same Math.random gives the same layout.
  random.mock.mockImplementation(seeded(99));
  freshState(msp, 'medium');
  msp.mspRevealCell(5, 5);
  const first = minesOf(msp.mspState.board);
  random.mock.mockImplementation(seeded(99));
  freshState(msp, 'medium');
  msp.mspRevealCell(5, 5);
  assert.deepEqual(minesOf(msp.mspState.board), first);
});

test('minesweeper: laying mines always ends: every free cell, a corrupt huge count, the last draw of Math.random', (t) => {
  const msp = loadScript(SCRIPT);
  const random = t.mock.method(Math, 'random', seeded(4));

  let state = freshState(msp, 'easy');
  state.mines = 80; // every cell but the clicked one
  msp.mspPlaceMines(4, 4);
  assert.equal(minesOf(state.board).length, 80);
  assert.equal(state.board[4][4].mine, false);
  assert.equal(state.board[4][4].adjacent, 8);

  state = freshState(msp, 'easy');
  state.mines = 1e9;
  random.mock.resetCalls();
  msp.mspPlaceMines(0, 0);
  assert.equal(minesOf(state.board).length, 80);
  assert.equal(state.board[0][0].mine, false);
  assert.equal(random.mock.callCount(), 80);

  // Draws just below 1 stay inside the list of free cells.
  random.mock.mockImplementation(() => 0.9999999999);
  state = freshState(msp, 'easy');
  msp.mspPlaceMines(8, 8);
  assert.equal(minesOf(state.board).length, 10);
  assert.equal(state.board[8][8].mine, false);

  // Draws of 0 take the free cells in reading order.
  random.mock.mockImplementation(() => 0);
  state = freshState(msp, 'easy');
  msp.mspPlaceMines(0, 3);
  assert.deepEqual(minesOf(state.board), [[0, 0], [0, 1], [0, 2], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [1, 0], [1, 1]]);
});

test('minesweeper: flood reveal opens a large region, stops at numbers, skips flags and never opens a mine', () => {
  const msp = loadScript(SCRIPT);
  // Hard board, a single mine: one reveal opens all but the mine and a flag.
  let state = freshState(msp, 'hard');
  state.mines = 1;
  layMines(msp, [[0, 0]]);
  msp.mspToggleFlag(10, 10);
  assert.equal(msp.mspRevealCell(17, 17), 'ok'); // the flagged safe cell is still closed
  assert.equal(state.revealed, 322);
  for (const [r, c] of allCells(18, 18)) {
    assert.equal(state.board[r][c].revealed, !((r === 0 && c === 0) || (r === 10 && c === 10)), key(r, c));
  }
  assert.equal(state.board[10][10].flagged, true);
  assert.equal(state.board[0][1].adjacent, 1);

  // From a numbered cell the flood opens its neighbours but never a mine,
  // and returns how many cells it opened.
  state = freshState(msp, 'easy');
  layMines(msp, LAYOUT);
  state.board[0][1].revealed = true;
  state.revealed = 1;
  const opened = msp.mspFloodReveal(0, 1);
  assert.equal(opened, 3); // (1, 0), (1, 1), (1, 2); the mines (0, 0) and (0, 2) stay closed
  assert.equal(state.revealed, 4);
  assert.equal(state.board[0][0].revealed, false);
  assert.equal(state.board[0][2].revealed, false);
  assert.equal(msp.mspFloodReveal(0, 1), 0);
});

test('minesweeper: reveals and flags follow the rules: ignored, ok, won, lost and the counters', () => {
  const msp = loadScript(SCRIPT);
  let state = freshState(msp, 'easy');

  // A flagged cell cannot be opened, so it is not the first click either.
  assert.equal(msp.mspToggleFlag(2, 3), true);
  assert.equal(state.flagged, 1);
  assert.equal(msp.mspRevealCell(2, 3), 'ignored');
  assert.equal(state.firstClick, true);
  assert.equal(minesOf(state.board).length, 0);

  state = freshState(msp, 'easy');
  layMines(msp, LAYOUT);
  assert.equal(msp.mspRevealCell(4, 4), 'ok');
  assert.equal(state.revealed, 70);
  assert.equal(msp.mspRevealCell(4, 4), 'ignored'); // already open
  assert.equal(msp.mspToggleFlag(4, 4), false); // an open cell cannot be flagged
  assert.equal(msp.mspToggleFlag(0, 1), true);
  assert.equal(msp.mspRevealCell(0, 1), 'ignored');
  assert.equal(msp.mspIsWin(), false);
  assert.equal(msp.mspToggleFlag(0, 1), true);
  assert.equal(state.flagged, 0);
  assert.equal(msp.mspRevealCell(0, 1), 'won');
  assert.equal(state.revealed, 71);
  assert.equal(state.gameOver, true);
  assert.equal(msp.mspIsWin(), true);
  assert.equal(msp.mspRevealCell(0, 0), 'ignored'); // over
  assert.equal(msp.mspToggleFlag(0, 0), false);

  state = freshState(msp, 'easy');
  layMines(msp, LAYOUT);
  msp.mspRevealCell(4, 4);
  msp.mspToggleFlag(8, 0);
  assert.equal(msp.mspRevealCell(0, 0), 'lost');
  assert.equal(state.gameOver, true);
  for (const [r, c] of LAYOUT) assert.equal(state.board[r][c].revealed, true, key(r, c));
  assert.equal(state.board[8][0].flagged, true);
  assert.equal(state.board[0][1].revealed, false);
  assert.equal(state.revealed, 70, 'opened mines are not counted as revealed cells');
  assert.equal(msp.mspToggleFlag(0, 1), false);
});

// ── Saves ────────────────────────────────────────────────────────────────────

test('minesweeper: a save keeps every field of the first version, with the same types', () => {
  const msp = loadScript(SCRIPT);
  const state = freshState(msp, 'easy');
  layMines(msp, LAYOUT);
  msp.mspRevealCell(4, 4);
  msp.mspToggleFlag(0, 1);
  state.timer = 9;

  const out = msp.mspSerialize();
  assert.deepEqual(Object.keys(out), SAVE_FIELDS);
  assert.equal(out.interval, null);
  assert.deepEqual(
    Object.fromEntries(SAVE_FIELDS.filter((f) => f !== 'board' && f !== 'interval').map((f) => [f, typeof out[f]])),
    { rows: 'number', cols: 'number', mines: 'number', revealed: 'number', flagged: 'number', firstClick: 'boolean', timer: 'number', gameOver: 'boolean', difficulty: 'string' }
  );
  for (const row of out.board) {
    for (const cell of row) {
      assert.deepEqual(Object.keys(cell), CELL_FIELDS);
      assert.deepEqual([typeof cell.mine, typeof cell.revealed, typeof cell.flagged, typeof cell.adjacent], ['boolean', 'boolean', 'boolean', 'number']);
    }
  }
  assert.deepEqual(out, { ...makeSave({ mines: LAYOUT, open: LAYOUT_OPEN, flags: [[0, 1]], timer: 9 }), interval: null });
  out.board[0][0].mine = false;
  assert.equal(state.board[0][0].mine, true, 'the save is a copy');

  // Parsing it gives the state back.
  const { interval, ...rest } = msp.mspSerialize();
  assert.deepEqual(msp.mspParseSave(JSON.stringify(msp.mspSerialize())), rest);
});

test('minesweeper: parsing a save works the counters and numbers out again and cleans odd values', () => {
  const msp = loadScript(SCRIPT);
  const clean = (save) => {
    const { interval, ...rest } = save;
    return rest;
  };

  // Stored counters and numbers are ignored: the board decides.
  const save = inProgress({ flags: [[0, 1]] });
  save.revealed = 3;
  save.flagged = 9;
  save.firstClick = true;
  save.board[4][4].adjacent = 7;
  save.board[0][0].adjacent = 0;
  assert.deepEqual(msp.mspParseSave(JSON.stringify(save)), clean(inProgress({ flags: [[0, 1]] })));

  // Odd timers become 0 (or are rounded down); non-boolean fields count as false.
  const timerOf = (timer) => msp.mspParseSave(JSON.stringify({ ...inProgress(), timer })).timer;
  assert.equal(timerOf(-5), 0);
  assert.equal(timerOf('12'), 0);
  assert.equal(timerOf(null), 0);
  assert.equal(timerOf(12.9), 12);
  assert.equal(timerOf(0), 0);
  assert.equal(msp.mspParseSave(JSON.stringify(inProgress()).replace('"timer":12', '"timer":1e999')).timer, 0);
  const odd = inProgress();
  odd.board[0][1].flagged = 'yes'; // a closed safe cell
  odd.board[3][3].revealed = 1; // an open cell
  const parsed = msp.mspParseSave(JSON.stringify(odd));
  assert.equal(parsed.board[0][1].flagged, false);
  assert.equal(parsed.board[3][3].revealed, false);
  assert.equal(parsed.revealed, 69);
  odd.board[0][0].mine = 'yes'; // nine real mines left: refused
  assert.equal(msp.mspParseSave(JSON.stringify(odd)), null);

  // A flag on an open safe cell is dropped; a flag on an opened mine (a lost
  // game) stays.
  const flagged = inProgress();
  flagged.board[4][4].flagged = true;
  assert.equal(msp.mspParseSave(JSON.stringify(flagged)).board[4][4].flagged, false);
  assert.equal(msp.mspParseSave(JSON.stringify(flagged)).flagged, 0);
  const lost = makeSave({ mines: LAYOUT, open: [...LAYOUT_OPEN, ...LAYOUT], flags: [[8, 0]], timer: 4, gameOver: true });
  const lostState = msp.mspParseSave(JSON.stringify(lost));
  assert.equal(lostState.board[8][0].flagged, true);
  assert.equal(lostState.flagged, 1);
  assert.equal(lostState.revealed, 70);
  assert.equal(lostState.gameOver, true);

  // A won game and a fresh board with flags.
  const won = msp.mspParseSave(JSON.stringify(makeSave({ mines: LAYOUT, open: [...LAYOUT_OPEN, [0, 1]], gameOver: true, timer: 30 })));
  assert.equal(won.gameOver, true);
  assert.equal(won.revealed, 71);
  const fresh = msp.mspParseSave(JSON.stringify(makeSave({ difficulty: 'medium', flags: [[0, 0], [13, 13]] })));
  assert.equal(fresh.firstClick, true);
  assert.equal(fresh.flagged, 2);
  assert.equal(fresh.difficulty, 'medium');
});

test('minesweeper: parsing refuses saves that cannot be played', () => {
  const msp = loadScript(SCRIPT);
  const valid = () => inProgress();
  const edit = (fn) => {
    const save = valid();
    fn(save);
    return save;
  };
  assert.notEqual(msp.mspParseSave(JSON.stringify(valid())), null);
  for (const [name, text] of Object.entries(corruptSaves(valid, edit))) {
    assert.equal(msp.mspParseSave(text), null, name);
  }
  assert.equal(msp.mspParseSave(null), null, 'no save at all');
});

// Saves that cannot be played, as stored text, by what is wrong with them.
function corruptSaves(valid, edit) {
  const list = {
    'empty text': '',
    'broken JSON': '{"rows":',
    'null': 'null',
    'a number': '42',
    'a string': '"x"',
    'true': 'true',
    'an array': '[]',
    'an empty object': '{}',
    'an unknown difficulty': { ...valid(), difficulty: 'insane' },
    'a difficulty that is not a string': { ...valid(), difficulty: ['easy'] },
    'an inherited name as difficulty': { ...valid(), difficulty: 'toString' },
    'rows that do not match the preset': { ...valid(), rows: 8 },
    'cols that do not match the preset': { ...valid(), cols: 8 },
    'a mine count that does not match the preset': { ...valid(), mines: 9 },
    'more mines than cells': { ...valid(), rows: 2, cols: 2, mines: 10 },
    'no board': { ...valid(), board: null },
    'a short board': edit((s) => s.board.pop()),
    'a short row': edit((s) => s.board[3].pop()),
    'a row that is not an array': edit((s) => { s.board[3] = {}; }),
    'a null cell': edit((s) => { s.board[2][2] = null; }),
    'a cell that is a number': edit((s) => { s.board[2][2] = 5; }),
    'nine mines on the board': edit((s) => { s.board[0][0].mine = false; }),
    'five mines laid and nothing open': makeSave({ mines: LAYOUT.slice(0, 5) }),
    'eleven mines on the board': edit((s) => { s.board[0][1].mine = true; }),
    'cells open before any mine was laid': makeSave({ open: [[4, 4]] }),
    'game over on a board still in play': { ...valid(), gameOver: true },
    'game over on a fresh board': { ...makeSave(), gameOver: true },
    'a won board not marked over': makeSave({ mines: LAYOUT, open: [...LAYOUT_OPEN, [0, 1]] }),
    'an opened mine on a game not marked over': makeSave({ mines: LAYOUT, open: [...LAYOUT_OPEN, [0, 0]] }),
    'no gameOver field': edit((s) => { delete s.gameOver; })
  };
  for (const name of Object.keys(list)) {
    if (typeof list[name] !== 'string') list[name] = JSON.stringify(list[name]);
  }
  return list;
}

test('minesweeper: best times are whole seconds; anything else counts as none', (t) => {
  const msp = loadScript(SCRIPT);
  assert.equal(msp.mspReadBest('easy'), null);
  for (const [stored, best] of [['42', 42], ['0', 0], ['007', 7], ['abc', null], ['-5', null], ['', null], ['4.5', null], [' 7', null], ['1e3', null], ['NaN', null]]) {
    localStorage.setItem('msp-best-hard', stored);
    assert.equal(msp.mspReadBest('hard'), best, JSON.stringify(stored));
  }
  t.mock.method(localStorage, 'getItem', () => { throw new Error('denied'); });
  assert.equal(msp.mspReadBest('hard'), null);
});

// ── The page ─────────────────────────────────────────────────────────────────

test('minesweeper: loading the script under Node runs no init: no lookup, no listener, no timer', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const msp = loadScript(SCRIPT);
  assert.equal(typeof msp.mspInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['msp-board'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('minesweeper: a first visit starts Easy: 81 closed cells, counters, status, select and listeners', (t) => {
  const page = openPage(t);
  assert.equal(page.cells().length, 81);
  assert.equal(page.board.style.gridTemplateColumns, 'repeat(9, var(--msp-cell-size))');
  assert.equal(page.text('msp-mine-counter'), '10');
  assert.equal(page.text('msp-timer'), '0');
  assert.equal(page.text('msp-best-time'), '--');
  assert.equal(page.text('msp-status-text'), READY);
  assert.equal(page.els['msp-difficulty'].value, 'easy');
  assert.equal(page.toastVisible(), false);
  for (const [r, c] of allCells(9, 9)) {
    const cell = page.board.children[r * 9 + c];
    assert.equal(cell.tagName, 'BUTTON');
    assert.equal(cell.className, 'msp-cell');
    assert.equal(cell.textContent, '');
    assert.equal(cell.getAttribute('data-row'), String(r));
    assert.equal(cell.getAttribute('data-col'), String(c));
    assert.equal(cell.getAttribute('aria-label'), 'Cell ' + r + ' ' + c);
  }
  // One listener per control, one keydown on the document, none on window.
  assert.equal(listenerCount(page.board, 'click'), 1);
  assert.equal(listenerCount(page.board, 'contextmenu'), 1);
  assert.equal(listenerCount(page.els['msp-new-game'], 'click'), 1);
  assert.equal(listenerCount(page.els['msp-restart-game'], 'click'), 1);
  assert.equal(listenerCount(page.els['msp-difficulty'], 'change'), 1);
  assert.equal(listenerCount(document), 1);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(window), 0);
  // The fresh board is saved at once.
  assert.deepEqual(page.saved(), { ...makeSave(), interval: null });
  t.mock.timers.tick(5000);
  assert.equal(page.text('msp-timer'), '0', 'no clock before the first reveal');
});

test('minesweeper: while the page is still loading, the game waits for DOMContentLoaded', (t) => {
  const page = openPage(t, { save: inProgress() }, { readyState: 'loading' });
  assert.equal(page.cells().length, 0);
  assert.equal(page.text('msp-status-text').trim(), 'Awaiting deployment...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(document, 'keydown'), 0);
  page.ready();
  assert.equal(page.cells().length, 81);
  assert.equal(page.opened(), 70);
  assert.equal(page.text('msp-timer'), '12');
  assert.equal(listenerCount(document, 'keydown'), 1);
  t.mock.timers.tick(1000);
  assert.equal(page.text('msp-timer'), '13');
});

test('minesweeper: init runs once: a second call binds nothing twice', (t) => {
  const page = openModule(t);
  page.msp.mspInit();
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(page.board, 'click'), 1);
  assert.equal(listenerCount(page.els['msp-new-game'], 'click'), 1);
  assert.equal(page.cells().length, 81);
});

test('minesweeper: New Game reads the select, Restart keeps the difficulty, a select change starts it and r restarts', (t) => {
  t.mock.method(Math, 'random', seeded(8));
  const page = openPage(t);

  page.els['msp-difficulty'].value = 'medium'; // chosen, no change event yet
  page.newGame();
  assert.equal(page.cells().length, 196);
  assert.equal(page.text('msp-mine-counter'), '35');
  assert.equal(page.saved().difficulty, 'medium');

  page.click(7, 7);
  assert.ok(page.opened() > 0);
  page.restart();
  assert.equal(page.cells().length, 196);
  assert.equal(page.opened(), 0);
  assert.equal(page.saved().difficulty, 'medium');
  assert.equal(page.saved().firstClick, true);

  page.choose('hard');
  assert.equal(page.cells().length, 324);
  assert.equal(page.text('msp-mine-counter'), '65');
  assert.equal(page.board.style.gridTemplateColumns, 'repeat(18, var(--msp-cell-size))');

  page.click(0, 0);
  assert.ok(page.opened() > 0);
  pressKey('R', { shiftKey: true }); // only a plain r restarts
  assert.ok(page.opened() > 0);
  pressKey('r');
  assert.equal(page.cells().length, 324);
  assert.equal(page.opened(), 0);
  assert.equal(page.saved().difficulty, 'hard');
  assert.equal(page.saved().firstClick, true);

  // However often a board starts, the listeners never stack up.
  for (let i = 0; i < 3; i++) {
    page.newGame();
    page.restart();
    page.choose('easy');
    pressKey('r');
  }
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(page.board, 'click'), 1);
  assert.equal(listenerCount(page.board, 'contextmenu'), 1);
});

test('minesweeper: the r shortcut leaves the game alone with Ctrl, Cmd or Alt, in text fields, while composing and once handled', (t) => {
  const page = openPage(t, { save: inProgress() });
  const before = localStorage.getItem(SAVE_KEY);
  assert.equal(page.opened(), 70);

  // Ctrl+R / Cmd+R reload the page: the reload must find the saved game.
  pressKey('r', { ctrlKey: true });
  pressKey('r', { metaKey: true });
  pressKey('r', { altKey: true });
  // Typing an r in a field of the host page (search, comments) or the select.
  const input = page.page.add('host-input', 'input');
  const textarea = page.page.add('host-textarea', 'textarea');
  const editable = page.page.add('host-editable', { isContentEditable: true });
  for (const target of [input, textarea, editable, page.els['msp-difficulty']]) pressKey('r', { target });
  // An input method composing text, and a key a page script already handled.
  pressKey('r', { isComposing: true });
  const handled = (event) => event.preventDefault();
  document.addEventListener('keydown', handled, true);
  pressKey('r');
  document.removeEventListener('keydown', handled, true);

  assert.equal(localStorage.getItem(SAVE_KEY), before);
  assert.equal(page.opened(), 70);
  pressKey('r', { target: page.els['msp-new-game'] }); // a plain r on the page restarts
  assert.equal(page.opened(), 0);
  assert.equal(page.saved().firstClick, true);
});

test('minesweeper: a click opens a cell, a right-click flags it without the browser menu, Enter on a focused cell opens it', (t) => {
  t.mock.method(Math, 'random', seeded(3));
  const page = openPage(t);

  // Flags before the first reveal: no clock, no mines laid.
  const event = page.flag(2, 3);
  assert.equal(event.defaultPrevented, true);
  assert.equal(page.cell(2, 3).className, 'msp-cell msp-cell-flagged');
  assert.equal(page.cell(2, 3).textContent, FLAG);
  assert.equal(page.text('msp-mine-counter'), '9');
  assert.equal(page.saved().board[2][3].flagged, true);
  t.mock.timers.tick(3000);
  assert.equal(page.text('msp-timer'), '0');
  page.click(2, 3); // a flagged cell does not open
  assert.equal(page.opened(), 0);
  assert.equal(page.saved().firstClick, true);
  page.flag(2, 3);
  assert.equal(page.cell(2, 3).className, 'msp-cell');
  assert.equal(page.text('msp-mine-counter'), '10');

  // The counter is mines minus flags, so extra flags take it below zero.
  for (let c = 0; c < 9; c++) page.flag(0, c);
  page.flag(1, 0);
  page.flag(1, 1);
  assert.equal(page.text('msp-mine-counter'), '-1');
  for (let c = 0; c < 9; c++) page.flag(0, c);
  page.flag(1, 0);
  page.flag(1, 1);

  // The board's own padding: no cell, so nothing happens and the menu stays.
  assert.equal(fire(page.board, 'contextmenu').defaultPrevented, false);
  page.board.click();
  assert.equal(page.saved().firstClick, true);

  // Enter on a focused cell clicks it, as browsers do with buttons.
  page.cell(4, 4).focus();
  pressKey('Enter');
  assert.ok(page.cell(4, 4).classList.contains('msp-cell-revealed'));
  assert.equal(page.saved().firstClick, false);
  t.mock.timers.tick(2000);
  assert.equal(page.text('msp-timer'), '2');
  assert.equal(page.saved().timer, 2);

  // An open cell takes no flag; the menu is still suppressed on it.
  const onOpen = page.flag(4, 4);
  assert.equal(onOpen.defaultPrevented, true);
  assert.ok(!page.cell(4, 4).classList.contains('msp-cell-flagged'));
  assert.equal(page.text('msp-mine-counter'), '10');
});

test('minesweeper: revealing the last safe cell wins, and a reload shows the won game frozen with its status', (t) => {
  const page = openPage(t, { save: inProgress({ timer: 37 }) });
  assert.equal(page.text('msp-timer'), '37');
  assert.equal(page.text('msp-status-text'), READY);
  // The flood from (4, 4) left exactly one safe cell closed.
  const closed = page.cells().filter((b) => !b.classList.contains('msp-cell-revealed'));
  assert.deepEqual(closed.map((b) => b.getAttribute('aria-label')).sort(), ['Cell 0 0', 'Cell 0 1', 'Cell 0 2', 'Cell 6 0', 'Cell 6 1', 'Cell 7 0', 'Cell 7 1', 'Cell 7 2', 'Cell 8 0', 'Cell 8 1', 'Cell 8 2']);

  page.click(0, 1);
  assert.equal(page.text('msp-status-text'), WON);
  assert.equal(page.text('msp-toast'), WIN_TOAST);
  assert.equal(page.toastVisible(), true);
  assert.equal(page.text('msp-best-time'), '37');
  assert.equal(localStorage.getItem('msp-best-easy'), '37');
  assert.equal(page.saved().gameOver, true);
  assert.equal(page.saved().revealed, 71);
  assert.equal(page.opened(), 71);
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();
  assert.deepEqual(keys, ['msp-best-easy', 'msp-save-state']);

  // The toast hides after 2 s; the clock has stopped.
  t.mock.timers.tick(1999);
  assert.equal(page.toastVisible(), true);
  t.mock.timers.tick(1);
  assert.equal(page.toastVisible(), false);
  t.mock.timers.tick(5000);
  assert.equal(page.text('msp-timer'), '37');

  // Frozen: clicks and flags do nothing (the menu is still suppressed).
  page.click(0, 0);
  assert.ok(!page.cell(0, 0).classList.contains('msp-cell-revealed'));
  assert.equal(page.flag(0, 0).defaultPrevented, true);
  assert.equal(page.text('msp-mine-counter'), '10');

  const again = reload(t, page);
  assert.equal(again.text('msp-status-text'), WON);
  assert.equal(again.opened(), 71);
  assert.equal(again.text('msp-best-time'), '37');
  assert.equal(again.text('msp-timer'), '37');
  t.mock.timers.tick(3000);
  assert.equal(again.text('msp-timer'), '37');
  again.click(0, 0);
  assert.equal(again.opened(), 71);
});

test('minesweeper: stepping on a mine loses: every mine shown, clock stopped, board frozen, and a reload keeps the loss', (t) => {
  const page = openPage(t, { save: inProgress({ flags: [[8, 0], [0, 1]] }) });
  t.mock.timers.tick(2000);
  assert.equal(page.text('msp-timer'), '14');
  page.click(0, 0);

  assert.equal(page.text('msp-status-text'), LOST);
  assert.equal(page.text('msp-toast'), LOSS_TOAST);
  assert.equal(page.toastVisible(), true);
  // Every cell state: opened mines, a flagged mine, a wrong flag, numbers, blanks.
  for (const [r, c] of LAYOUT) {
    if (r === 8 && c === 0) continue;
    assert.equal(page.cell(r, c).className, 'msp-cell msp-cell-revealed msp-cell-mine', key(r, c));
    assert.equal(page.cell(r, c).textContent, MINE);
  }
  assert.equal(page.cell(8, 0).className, 'msp-cell msp-cell-revealed msp-cell-mine msp-cell-flagged');
  assert.equal(page.cell(8, 0).textContent, FLAG);
  assert.equal(page.cell(0, 1).className, 'msp-cell msp-cell-flagged');
  assert.equal(page.cell(0, 1).textContent, FLAG);
  assert.equal(page.cell(1, 1).className, 'msp-cell msp-cell-revealed');
  assert.equal(page.cell(1, 1).textContent, '2');
  assert.equal(page.cell(4, 4).className, 'msp-cell msp-cell-revealed');
  assert.equal(page.cell(4, 4).textContent, '');
  // Every class on the board has a rule in style.css.
  const selectors = new Set(cssRules(CSS).flatMap((rule) => rule.selectors));
  for (const name of new Set(page.cells().flatMap((b) => b.className.split(' ')))) assert.ok(selectors.has('.' + name), name);

  // The loss is saved; no best time is written; the clock has stopped.
  const saved = page.saved();
  assert.equal(saved.gameOver, true);
  for (const [r, c] of LAYOUT) assert.equal(saved.board[r][c].revealed, true);
  assert.equal(saved.timer, 14);
  assert.equal(localStorage.getItem('msp-best-easy'), null);
  assert.equal(page.text('msp-best-time'), '--');
  t.mock.timers.tick(5000);
  assert.equal(page.text('msp-timer'), '14');
  assert.equal(page.saved().timer, 14);
  // Frozen: the wrong flag cannot be lifted, the closed cell cannot be opened.
  assert.equal(page.flag(0, 1).defaultPrevented, true);
  assert.equal(page.cell(0, 1).textContent, FLAG);

  const again = reload(t, page);
  assert.equal(again.text('msp-status-text'), LOST);
  assert.equal(again.cell(0, 0).textContent, MINE);
  assert.equal(again.cell(8, 0).textContent, FLAG);
  assert.equal(again.text('msp-timer'), '14');
  assert.equal(again.text('msp-mine-counter'), '8');
  t.mock.timers.tick(3000);
  assert.equal(again.text('msp-timer'), '14');
  again.flag(0, 1);
  assert.equal(again.cell(0, 1).textContent, FLAG);
  assert.equal(again.saved().gameOver, true);
});

test('minesweeper: New Game, Restart, a difficulty change and r after a loss clear the status and the toast', (t) => {
  const actions = {
    'New Game': (page) => page.newGame(),
    'Restart': (page) => page.restart(),
    'a difficulty change': (page) => page.choose('medium'),
    'the r key': () => pressKey('r')
  };
  for (const [name, action] of Object.entries(actions)) {
    resetStubs();
    const page = openPage(t, { save: inProgress() });
    page.click(0, 0);
    assert.equal(page.text('msp-status-text'), LOST, name);
    assert.equal(page.toastVisible(), true, name);
    action(page);
    assert.equal(page.text('msp-status-text'), READY, name);
    assert.equal(page.toastVisible(), false, name);
    assert.equal(page.opened(), 0, name);
    assert.equal(page.text('msp-timer'), '0', name);
  }
});

test('minesweeper: a toast shown within 2 s of another stays up a full 2 s', (t) => {
  t.mock.method(Math, 'random', seeded(21));
  const page = openPage(t, { save: inProgress() });
  page.click(0, 0); // first loss: toast at 0 s
  assert.equal(page.toastVisible(), true);
  t.mock.timers.tick(1000);
  page.newGame();
  page.click(4, 4);
  const board = page.saved().board;
  const [mr, mc] = allCells(9, 9).find(([r, c]) => board[r][c].mine);
  t.mock.timers.tick(200);
  page.click(mr, mc); // second loss: toast at 1.2 s
  assert.equal(page.text('msp-status-text'), LOST);
  assert.equal(page.toastVisible(), true);
  t.mock.timers.tick(800); // 2 s: the first toast's time is up, not the second's
  assert.equal(page.toastVisible(), true);
  t.mock.timers.tick(1199);
  assert.equal(page.toastVisible(), true);
  t.mock.timers.tick(1);
  assert.equal(page.toastVisible(), false);
});

test('minesweeper: the difficulty select follows the restored game, so New Game keeps its difficulty', (t) => {
  const hard = makeSave({ difficulty: 'hard', mines: bottomMines('hard'), open: [[0, 0]], timer: 5 });
  const page = openPage(t, { save: hard });
  assert.equal(page.els['msp-difficulty'].value, 'hard');
  assert.equal(page.cells().length, 324);
  assert.equal(page.text('msp-mine-counter'), '65');
  assert.equal(page.text('msp-timer'), '5');
  page.newGame();
  assert.equal(page.cells().length, 324);
  assert.equal(page.saved().difficulty, 'hard');

  page.choose('medium');
  page.restart();
  assert.equal(page.els['msp-difficulty'].value, 'medium');
  assert.equal(page.cells().length, 196);

  const reloaded = reload(t, page);
  assert.equal(reloaded.els['msp-difficulty'].value, 'medium');
  assert.equal(reloaded.cells().length, 196);

  resetStubs();
  const medium = makeSave({ difficulty: 'medium', mines: bottomMines('medium'), open: [[0, 0]], flags: [[13, 13]] });
  const restored = openPage(t, { save: medium });
  assert.equal(restored.els['msp-difficulty'].value, 'medium');
  assert.equal(restored.cells().length, 196);
  assert.equal(restored.text('msp-mine-counter'), '34');
});

test('minesweeper: an unknown difficulty starts Easy and the select shows it', (t) => {
  const page = openModule(t);
  page.msp.mspApplyDifficulty('hard');
  for (const level of ['insane', 'toString', undefined, ['hard']]) {
    page.msp.mspApplyDifficulty(level);
    assert.equal(page.state.difficulty, 'easy', String(level));
    assert.equal(page.els['msp-difficulty'].value, 'easy');
    assert.equal(page.cells().length, 81);
  }
});

test('minesweeper: a corrupt or unplayable save never breaks the page: a fresh, playable Easy board instead', (t) => {
  const valid = () => inProgress();
  const edit = (fn) => {
    const save = valid();
    fn(save);
    return save;
  };
  for (const [name, text] of Object.entries(corruptSaves(valid, edit))) {
    if (name === 'more mines than cells') continue; // its own test below
    resetStubs();
    const page = openPage(t, { save: text, best: { easy: 20 } });
    assert.equal(page.cells().length, 81, name);
    assert.equal(page.opened(), 0, name);
    assert.equal(page.text('msp-mine-counter'), '10', name);
    assert.equal(page.text('msp-timer'), '0', name);
    assert.equal(page.text('msp-best-time'), '20', name);
    assert.equal(page.text('msp-status-text'), READY, name);
    assert.equal(page.els['msp-difficulty'].value, 'easy', name);
    assert.equal(page.saved().firstClick, true, name + ': a fresh board replaces the save');
    page.restart();
    assert.equal(page.cells().length, 81, name);
    page.click(4, 4);
    assert.ok(page.opened() > 0, name);
    pressKey('r');
    assert.equal(page.opened(), 0, name);
  }
});

test('minesweeper: a save with more mines than cells cannot hang the first click', (t) => {
  const cell = () => ({ mine: false, revealed: false, flagged: false, adjacent: 0 });
  const page = openPage(t, {
    save: { rows: 2, cols: 2, mines: 10, board: [[cell(), cell()], [cell(), cell()]], revealed: 0, flagged: 0, firstClick: true, timer: 0, interval: null, gameOver: false, difficulty: 'easy' }
  });
  page.click(0, 0);
  assert.equal(page.cells().length, 81);
  assert.ok(page.opened() > 0);
});

test('minesweeper: a corrupt best time shows as none and the next win replaces it', (t) => {
  for (const bad of ['abc', '-5', '4.5']) {
    resetStubs();
    const page = openPage(t, { save: inProgress({ timer: 50 }), best: { easy: bad } });
    assert.equal(page.text('msp-best-time'), '--', bad);
    page.click(0, 1);
    assert.equal(page.text('msp-status-text'), WON, bad);
    assert.equal(page.text('msp-best-time'), '50', bad);
    assert.equal(localStorage.getItem('msp-best-easy'), '50', bad);
  }
});

test('minesweeper: blocked storage never stops the game', (t) => {
  // Reading throws, as with blocked site data: the page starts and plays.
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => Object.defineProperty(globalThis, 'localStorage', real));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  t.mock.method(Math, 'random', seeded(5));
  let page = openPage(t);
  assert.equal(page.cells().length, 81);
  assert.equal(page.text('msp-best-time'), '--');
  page.click(4, 4);
  assert.ok(page.opened() > 0);
  fire(page.cells().find((b) => !b.classList.contains('msp-cell-revealed')), 'contextmenu');
  assert.equal(page.text('msp-mine-counter'), '9');
  t.mock.timers.tick(2000);
  assert.equal(page.text('msp-timer'), '2');
  Object.defineProperty(globalThis, 'localStorage', real);

  // Writing throws, as with a full quota: every move and tick still works.
  resetStubs();
  t.mock.method(localStorage, 'setItem', () => { throw new Error('QuotaExceededError'); });
  page = openPage(t, {});
  page.click(4, 4);
  assert.ok(page.opened() > 0);
  t.mock.timers.tick(1000);
  assert.equal(page.text('msp-timer'), '1');
  page.newGame();
  assert.equal(page.opened(), 0);
});

test('minesweeper: the clock starts on the first reveal, runs one interval at a time, stops at the end and resumes after a reload', (t) => {
  t.mock.method(Math, 'random', seeded(13));
  const page = openPage(t, { save: inProgress() });
  t.mock.timers.tick(1000);
  assert.equal(page.text('msp-timer'), '13');
  assert.equal(page.saved().timer, 13);

  page.newGame(); // stops the old clock
  assert.equal(page.text('msp-timer'), '0');
  t.mock.timers.tick(3000);
  assert.equal(page.text('msp-timer'), '0');
  assert.equal(page.saved().timer, 0);
  page.click(4, 4);
  t.mock.timers.tick(2000);
  assert.equal(page.text('msp-timer'), '2', 'one second per second');
  page.restart();
  page.click(4, 4);
  t.mock.timers.tick(4000);
  assert.equal(page.text('msp-timer'), '4');

  const again = reload(t, page);
  assert.equal(again.text('msp-timer'), '4');
  t.mock.timers.tick(1000);
  assert.equal(again.text('msp-timer'), '5');
  again.newGame();
  again.click(4, 4);
  t.mock.timers.tick(3000);
  assert.equal(again.text('msp-timer'), '3');
  assert.equal(again.saved().timer, 3);
});

test('minesweeper: restoring the save while a game runs keeps one clock, and restoring a finished game stops it', (t) => {
  const page = openModule(t, { save: inProgress() });
  t.mock.timers.tick(1000);
  assert.equal(page.text('msp-timer'), '13');
  assert.equal(page.msp.mspLoadGame(), true);
  t.mock.timers.tick(1000);
  assert.equal(page.text('msp-timer'), '14', 'one second per second');

  localStorage.setItem(SAVE_KEY, JSON.stringify(makeSave({ mines: LAYOUT, open: [...LAYOUT_OPEN, [0, 1]], gameOver: true, timer: 20 })));
  assert.equal(page.msp.mspLoadGame(), true);
  assert.equal(page.text('msp-status-text'), WON);
  assert.equal(page.text('msp-timer'), '20');
  t.mock.timers.tick(3000);
  assert.equal(page.text('msp-timer'), '20');

  // Nothing playable in storage: the game on screen stays as it is.
  localStorage.setItem(SAVE_KEY, '{}');
  assert.equal(page.msp.mspLoadGame(), false);
  assert.equal(page.text('msp-status-text'), WON);
  assert.equal(page.opened(), 71);
});

test('minesweeper: a reveal that opens every safe cell at once wins with a best time of 0', (t) => {
  t.mock.method(Math, 'random', () => 0); // the mines fill the top row and (1, 0)
  const page = openPage(t);
  page.click(8, 8);
  assert.equal(page.opened(), 71);
  assert.equal(page.text('msp-status-text'), WON);
  assert.equal(page.text('msp-best-time'), '0');
  assert.equal(localStorage.getItem('msp-best-easy'), '0');
  t.mock.timers.tick(3000);
  assert.equal(page.text('msp-timer'), '0');
});

test('minesweeper: best time per difficulty keeps the fastest run, compared as numbers', (t) => {
  const page = openModule(t);
  const { msp, state } = page;
  state.timer = 42;
  msp.mspSaveBestTime();
  assert.equal(localStorage.getItem('msp-best-easy'), '42');
  state.timer = 50;
  msp.mspSaveBestTime();
  assert.equal(localStorage.getItem('msp-best-easy'), '42');
  state.timer = 30;
  msp.mspSaveBestTime();
  assert.equal(localStorage.getItem('msp-best-easy'), '30');
  assert.equal(page.text('msp-best-time'), '30');
  // '100' sorts before '30' as text; the game compares numbers.
  state.timer = 100;
  msp.mspSaveBestTime();
  assert.equal(localStorage.getItem('msp-best-easy'), '30');

  // Each difficulty has its own record.
  page.choose('hard');
  assert.equal(page.text('msp-best-time'), '--');
  state.timer = 99;
  msp.mspSaveBestTime();
  assert.equal(localStorage.getItem('msp-best-hard'), '99');
  assert.equal(localStorage.getItem('msp-best-easy'), '30');
  page.choose('easy');
  assert.equal(page.text('msp-best-time'), '30');
});

test('minesweeper: a game in progress survives a reload with the same board', (t) => {
  t.mock.method(Math, 'random', seeded(11));
  const page = openPage(t);
  page.choose('medium');
  page.click(7, 7);
  const closed = page.cells().find((b) => !b.classList.contains('msp-cell-revealed'));
  fire(closed, 'contextmenu');
  t.mock.timers.tick(5000);
  const snapshot = page.saved();
  assert.equal(snapshot.timer, 5);
  assert.equal(snapshot.flagged, 1);
  const drawn = page.cells().map((b) => [b.className, b.textContent]);

  const again = reload(t, page);
  assert.equal(again.els['msp-difficulty'].value, 'medium');
  assert.equal(again.cells().length, 196);
  assert.deepEqual(again.cells().map((b) => [b.className, b.textContent]), drawn);
  assert.equal(again.text('msp-mine-counter'), '34');
  assert.equal(again.text('msp-timer'), '5');
  t.mock.timers.tick(2000);
  assert.equal(again.text('msp-timer'), '7');
  assert.equal(again.saved().timer, 7);
  assert.deepEqual(again.saved().board, snapshot.board);
});

test('minesweeper: a save written by the first version loads with its board, flags, time and counters', (t) => {
  const stored = JSON.parse(BASELINE_SAVE);
  assert.deepEqual(Object.keys(stored), SAVE_FIELDS);
  assert.equal(stored.interval, 14);

  const page = openModule(t, { save: BASELINE_SAVE });
  const { state } = page;
  assert.equal(state.difficulty, 'easy');
  assert.equal(state.revealed, 50);
  assert.equal(state.flagged, 2);
  assert.equal(state.timer, 3);
  assert.equal(state.firstClick, false);
  assert.equal(state.gameOver, false);
  assert.deepEqual(state.board, stored.board);
  assert.equal('interval' in state, false);

  BASELINE_MAP.forEach((line, r) => {
    [...line].forEach((ch, c) => {
      const cell = page.cell(r, c);
      const where = key(r, c) + ' ' + ch;
      if (/\d/.test(ch)) {
        assert.equal(cell.className, 'msp-cell msp-cell-revealed', where);
        assert.equal(cell.textContent, ch === '0' ? '' : ch, where);
      } else if (ch === 'F' || ch === 'f') {
        assert.equal(cell.className, 'msp-cell msp-cell-flagged', where);
        assert.equal(cell.textContent, FLAG, where);
      } else {
        assert.equal(cell.className, 'msp-cell', where);
        assert.equal(cell.textContent, '', where);
      }
      assert.equal(stored.board[r][c].mine, ch === '*' || ch === 'F', where);
    });
  });
  assert.equal(page.text('msp-mine-counter'), '8');
  assert.equal(page.text('msp-timer'), '3');
  assert.equal(page.text('msp-status-text'), READY);
  assert.equal(page.els['msp-difficulty'].value, 'easy');

  // The clock resumes, and the next save keeps the format.
  t.mock.timers.tick(1000);
  assert.equal(page.text('msp-timer'), '4');
  const written = page.saved();
  assert.deepEqual(Object.keys(written), SAVE_FIELDS);
  assert.deepEqual(written, { ...stored, timer: 4, interval: null });

  // A first-version board with flags before the first reveal, and an
  // in-progress game of each size, load too.
  resetStubs();
  const fresh = openPage(t, { save: makeSave({ flags: [[0, 0], [3, 3]] }) });
  assert.equal(fresh.text('msp-mine-counter'), '8');
  t.mock.timers.tick(2000);
  assert.equal(fresh.text('msp-timer'), '0');
  fresh.click(4, 4);
  assert.equal(fresh.saved().firstClick, false);
  assert.equal(fresh.saved().board.flat().filter((cell) => cell.mine).length, 10);
  for (const level of ['easy', 'medium', 'hard']) {
    resetStubs();
    const mines = level === 'easy' ? LAYOUT : bottomMines(level);
    const loaded = openPage(t, { save: makeSave({ difficulty: level, mines, open: [[4, 4]], timer: 8 }) });
    assert.equal(loaded.cells().length, PRESETS[level].rows * PRESETS[level].cols, level);
    assert.equal(loaded.opened(), 1, level);
    assert.equal(loaded.els['msp-difficulty'].value, level);
    assert.equal(loaded.text('msp-timer'), '8', level);
  }
});

test('minesweeper: a double click counts once, and dblclick events change nothing', (t) => {
  const page = openPage(t, { save: BASELINE_SAVE });
  page.click(4, 0);
  page.click(4, 0);
  fire(page.cell(4, 0), 'dblclick');
  assert.equal(page.cell(4, 0).textContent, '1');
  assert.equal(page.opened(), 51);
  assert.equal(page.saved().revealed, 51);
});
