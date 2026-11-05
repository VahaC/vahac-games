// tests/2048-game.test.js
'use strict';

// The pure board logic is tested through the functions script.js exports
// (loadScript).  Everything a player does is tested on the real page:
// bootLikeBrowser runs script.js the way a browser does, init() binds its
// listeners to the stub elements built from index.html, and the tests press
// keys, swipe and click through those listeners, then read the tiles, scores,
// message and toast off the page and the save out of localStorage.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs,
  pressKey, touchEvent, swipe, listenersOf, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt
} = require('./_setup');

const SCRIPT = '2048-game/script.js';
// LF line endings, so the source checks also pass on a Windows checkout with
// core.autocrlf=true.
const lf = (text) => text.replace(/\r\n/g, '\n');
const HTML = lf(readRepoFile('2048-game/index.html'));
const CSS = lf(readRepoFile('2048-game/style.css'));
const JS = lf(readRepoFile(SCRIPT));

const KEY = 'tf8-2048-game';
const BEST = 'tf8-2048-best-score';
const IDS = [
  'tf8-board', 'tf8-score', 'tf8-best-score', 'tf8-message', 'tf8-toast',
  'tf8-new-game-btn', 'tf8-undo-btn', 'tf8-restart-btn'
];
const WON = '🎉 You reached 2048!';
const OVER = '💀 Game Over';

// A save exactly as the first version (commit a4cfbc5) wrote it.
const BASELINE_SAVE = '{"board":[[2,4,0,0],[0,8,0,0],[0,0,16,0],[0,0,0,2048]],"score":1234}';

const empty = () => [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
const withRows = (...rows) => rows.concat(empty().slice(rows.length));

// With Math.random() at 0 every new tile is a 2 on the first empty cell.
const START = [[0, 2, 0, 2], [0, 0, 0, 0], [4, 0, 4, 0], [0, 0, 0, 0]];
const AFTER = {
  ArrowLeft: { board: [[4, 2, 0, 0], [0, 0, 0, 0], [8, 0, 0, 0], [0, 0, 0, 0]], score: 12 },
  ArrowRight: { board: [[2, 0, 0, 4], [0, 0, 0, 0], [0, 0, 0, 8], [0, 0, 0, 0]], score: 12 },
  ArrowUp: { board: [[4, 2, 4, 2], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 0 },
  ArrowDown: { board: [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [4, 2, 4, 2]], score: 0 }
};
// One move left: ArrowLeft fills the last cell and locks the board.
const LOCK_NEXT = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [0, 8, 16, 32]];
const LOCKED = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [8, 16, 32, 2]];
// The same after playing on past 2048: a 4096 and no 2048 tile left.
const LOCK_NEXT_PAST = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [0, 8, 16, 4096]];
const LOCKED_PAST = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [8, 16, 4096, 2]];
// The fresh game Math.random() at 0 deals.
const FRESH = withRows([2, 2, 0, 0]);

// Saves that must not load: no JSON, the wrong shape, or cells that are not
// tiles (0 or a power of two from 2 up).
const cells = (...first) => JSON.stringify({ board: withRows(first.concat([0, 0, 0, 0]).slice(0, 4)), score: 0 });
const BAD_SAVES = [
  null, '', '{bad', 'null', '0', '"text"', '[]', '{}', '{"score":5}',
  '{"board":null}', '{"board":"abc"}', '{"board":[[2,2]]}',
  JSON.stringify({ board: [[2, 0], [0, 0], [0, 0], [0, 0]], score: 0 }),
  JSON.stringify({ board: withRows([2, 0, 0, 0]).concat([[0, 0, 0, 0]]), score: 0 }),
  JSON.stringify({ board: withRows([2, 0, 0, 0, 0]), score: 0 }),
  JSON.stringify({ board: [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], '0000'], score: 0 }),
  JSON.stringify({ board: empty(), score: 0 }),
  cells(3), cells('x'), cells(null), cells(-2), cells(2.5), cells(1), cells(6), cells(true), cells('2'), cells(2, 1e400)
];

// What Math.random() returns while mocks() is on: a number every time, or a
// list of rolls used up in order.
let rolls = 0;

function mocks(t, random) {
  rolls = random === undefined ? 0 : random;
  t.mock.method(Math, 'random', () => {
    if (typeof rolls === 'number') return rolls;
    assert.ok(rolls.length, 'Math.random() was called more often than the test expects');
    return rolls.shift();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

function store(save, best) {
  if (save !== undefined) localStorage.setItem(KEY, typeof save === 'string' ? save : JSON.stringify(save));
  if (best !== undefined) localStorage.setItem(BEST, String(best));
}

const saved = () => JSON.parse(localStorage.getItem(KEY));

// The window is 1280x900 and the board a 400 px square inside it, unless a
// test moves it (g.placeBoard).  The stubs have no layout of their own.
const WINDOW = { innerWidth: 1280, innerHeight: 900 };
const ON_SCREEN = { top: 200, left: 440, width: 400, height: 400 };

function rect(box) {
  return {
    x: box.left, y: box.top, top: box.top, left: box.left,
    right: box.left + box.width, bottom: box.top + box.height,
    width: box.width, height: box.height
  };
}

// What a player sees on the page.
function view(b) {
  const els = b.els;
  const tiles = () => els['tf8-board'].children;
  let box = ON_SCREEN;
  if (els['tf8-board']) els['tf8-board'].getBoundingClientRect = () => rect(box);
  return {
    b,
    els,
    tiles,
    board() {
      const values = tiles().map((tile) => (tile.textContent === '' ? 0 : Number(tile.textContent)));
      assert.equal(values.length, 16, 'the board shows 16 cells');
      return [0, 4, 8, 12].map((i) => values.slice(i, i + 4));
    },
    score: () => els['tf8-score'].textContent,
    best: () => els['tf8-best-score'].textContent,
    message: () => els['tf8-message'].textContent,
    toast: () => els['tf8-toast'].textContent,
    toastShown: () => els['tf8-toast'].classList.contains('tf8-show'),
    click: (id) => els[id].click(),
    placeBoard: (next) => { box = next; }
  };
}

// Puts a save in place (a board, { board, score } or raw text) and opens the
// page the way a browser does.  Call mocks(t) first.
function boot(options) {
  const o = options || {};
  const save = Array.isArray(o.save) ? { board: o.save, score: 0 } : o.save;
  store(save, o.best);
  return view(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML)));
}

test.beforeEach(() => Object.assign(window, WINDOW));
test.afterEach(() => {
  for (const key of Object.keys(WINDOW)) delete window[key];
});

test.beforeEach(() => resetStubs());

// ── Source checks ───────────────────────────────────────────────────────────

test('2048: loading under Node starts nothing and looks nothing up', () => {
  const page = createPage(htmlPageSpec(HTML)).install();
  const tf8 = loadScript(SCRIPT);
  assert.equal(localStorage.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(page.els['tf8-board'].children.length, 0);
  // Elements are looked up by init(), so a script in the page head works.
  assert.deepEqual(page.requested, []);
  assert.equal(tf8.STORAGE_KEY, KEY);
  assert.equal(tf8.BEST_SCORE_KEY, BEST);
  assert.equal(tf8.SIZE, 4);
  assert.equal(tf8.WIN_VALUE, 2048);
  assert.equal(tf8.MAX_HISTORY, 10);
  assert.equal(tf8.SWIPE_THRESHOLD, 40);
  assert.equal(tf8.TOAST_MS, 1800);
  assert.deepEqual(tf8.MESSAGES, { won: WON, over: OVER });
  assert.deepEqual(tf8.TOASTS, { undo: 'Undo', restart: 'Restarted' });
});

test('2048: every id the script looks up exists once in index.html, and init looks up exactly those', (t) => {
  const used = [...JS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...used].sort(), [...IDS].sort());
  const ids = idsInHtml(HTML);
  assert.equal(new Set(ids).size, ids.length, 'ids in index.html are unique');
  for (const id of IDS) assert.ok(ids.includes(id), id + ' is missing from index.html');

  mocks(t);
  const g = boot();
  assert.deepEqual([...g.b.page.requested].sort(), [...IDS].sort());
});

// Comments and string literals of a script (script.js has no regex literals).
const TOKENS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g;

// The source with comments and string literals blanked out.
function codeOnly(js) {
  return js.replace(TOKENS, ' ');
}

// The contents of every string literal, comments skipped.
function stringLiterals(js) {
  return (js.match(TOKENS) || []).filter((tok) => tok[0] === '\'' || tok[0] === '"').map((tok) => tok.slice(1, -1));
}

test('2048: every class, id, custom property and storage key starts with tf8-', (t) => {
  const bad = (list) => list.filter((name) => !name.startsWith('tf8-'));

  const classes = [...HTML.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean));
  assert.ok(classes.length > 10);
  assert.deepEqual(bad(classes), [], 'classes in index.html');
  assert.deepEqual(bad(idsInHtml(HTML)), [], 'ids in index.html');

  const selectors = cssRules(CSS).flatMap((r) => r.selectors);
  const names = selectors.flatMap((s) => [...s.matchAll(/[.#]([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
  assert.ok(names.length > 30);
  assert.deepEqual(bad(names), [], 'classes and ids in style.css');
  for (const s of selectors) assert.match(s, /^\.tf8-/, 'every selector is scoped to a tf8- class: ' + s);
  const props = [...CSS.matchAll(/(?<![\w-])--([\w-]+)/g)].map((m) => m[1]);
  assert.ok(props.length > 20);
  assert.deepEqual(bad(props), [], 'custom properties in style.css');

  // Every hyphenated name in the script's strings: class names, ids and keys.
  const strings = stringLiterals(JS);
  const hyphenated = strings.flatMap((s) => s.match(/[a-z0-9]+(?:-[a-z0-9]+)+-?/gi) || []);
  assert.ok(hyphenated.length >= 12);
  assert.deepEqual(bad(hyphenated), [], 'names in script.js');

  // What a game actually writes to localStorage.
  mocks(t);
  boot();
  pressKey('ArrowRight');
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();
  assert.deepEqual(keys, [BEST, KEY].sort());
});

test('2048: script.js is one strict-mode IIFE in ES5 syntax with the start-up guard build-embed expects', () => {
  assert.doesNotThrow(() => new vm.Script(JS, { filename: SCRIPT }));
  const code = codeOnly(JS);
  for (const [what, re] of [
    ['arrow function', /=>/],
    ['let', /\blet\s/],
    ['const', /\bconst\s/],
    ['template literal', /`/],
    ['class', /\bclass\s/],
    ['optional chaining', /\?\./],
    ['spread or rest', /\.\.\./],
    ['module syntax', /\b(import|export)\s/]
  ]) {
    assert.doesNotMatch(code, re, 'no ' + what);
  }
  assert.match(JS, /^(\/\/[^\n]*\n)+\(function \(\) \{\n {2}'use strict';\n/);
  assert.match(JS, /\n\}\)\(\);\n$/);
  assert.equal((code.match(/\(function \(\) \{/g) || []).length, 1, 'one IIFE');
  const guard = "  if (document.readyState === 'loading') {\n" +
    "    document.addEventListener('DOMContentLoaded', init);\n" +
    "  } else if (typeof module === 'undefined' || !module.exports) {\n" +
    '    init();\n' +
    '  }';
  assert.ok(JS.includes(guard), 'the start-up guard is unchanged');
  assert.ok(JS.indexOf('module.exports = {') > JS.indexOf(guard), 'the exports come last');
});

test('2048: the files embed safely in the WordPress block, and the page alone is dark with no margin', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const markup = embedMarkup(HTML);
  assert.ok(markup.startsWith('<div class="tf8-wrapper"'));
  assert.deepEqual(embedSafety(markup), []);
  assert.doesNotMatch(markup, /<style|<script/i);
  assert.ok(HTML.indexOf('<div class="tf8-wrapper"') > HTML.indexOf('</head>'));
  assert.ok(HTML.indexOf('<script src="script.js"></script>') > HTML.indexOf('<div class="tf8-wrapper"'));
  assert.doesNotMatch(CSS, /^\s*(html|body)\b[^{]*\{/m, 'no bare html or body rule');
  // Opened on its own, the page has the wrapper's base colour and no margin;
  // that rule sits in the head, which build-embed never copies.
  assert.equal(CSS.match(/--tf8-bg-primary:\s*(#[0-9a-f]{6})/i)[1], '#0a0f1e');
  assert.match(HTML, /<link rel="stylesheet" href="style\.css">\n {2}<style>body \{ margin: 0; background: #0a0f1e; \}<\/style>\n<\/head>/);
  assert.equal(HTML.match(/<style/g).length, 1);
});

const px = (len) => Number.parseFloat(len) * (/rem$/.test(len) ? 16 : 1);

function horizontalPadding(padding) {
  const v = padding.split(/\s+/).map(px);
  return v.length === 1 ? 2 * v[0] : v.length === 4 ? v[1] + v[3] : 2 * v[1];
}

// Widths in px of the wrapper (border box), its content box, the board and a
// tile at a viewport width, for the standalone page (body margin 0); inside
// WordPress the same holds with the content column's width as the viewport.
function layoutAt(rules, vw) {
  const w = declsAt(rules, '.tf8-wrapper', vw);
  assert.equal(w.width, '100%');
  const pad = horizontalPadding(w.padding);
  const box = Math.min(vw, px(w['max-width']));
  const content = w['box-sizing'] === 'border-box' ? box - pad : box;
  const b = declsAt(rules, '.tf8-board', vw);
  assert.equal(b.width, '100%');
  // The board is border-box through the ".tf8-wrapper *" rule.
  const board = Math.min(content, px(b['max-width']));
  const tile = (board - 2 * px(b.padding) - 3 * px(b.gap)) / 4;
  return { wrapper: content + pad, content, board, tile };
}

test('2048: nothing is wider than a phone screen, and the board keeps its size where it fits', () => {
  const rules = cssRules(CSS);
  assert.equal(declsAt(rules, '.tf8-wrapper', 1280)['box-sizing'], 'border-box');
  for (const sel of ['.tf8-wrapper *', '.tf8-wrapper *::before', '.tf8-wrapper *::after']) {
    assert.equal(declsAt(rules, sel, 1280)['box-sizing'], 'border-box', sel);
  }

  // Phone: the 8px side padding sits inside the 375px, so the board is 359px.
  assert.deepEqual(layoutAt(rules, 375), { wrapper: 375, content: 359, board: 359, tile: 74.75 });
  // Tablet and desktop: the board stays at its 560px maximum and the tiles at
  // 125px; the wrapper's border box stops at 760px.
  assert.deepEqual(layoutAt(rules, 768), { wrapper: 760, content: 728, board: 560, tile: 125 });
  assert.deepEqual(layoutAt(rules, 1280), { wrapper: 760, content: 728, board: 560, tile: 125 });

  for (let vw = 320; vw <= 1440; vw += 1) {
    const l = layoutAt(rules, vw);
    assert.ok(l.wrapper <= vw, vw + 'px: wrapper ' + l.wrapper + 'px');
    assert.ok(l.board <= l.content, vw + 'px: board ' + l.board + 'px');
  }
});

test('2048: every tile up to 4096 has its colour, empty cells match the board, and the stylesheet is well-formed', () => {
  const rules = cssRules(CSS);
  const vars = declsAt(rules, '.tf8-wrapper', 1280);
  const resolve = (value) => value.replace(/^var\((--[\w-]+)\)$/, (all, name) => vars[name]);
  // Every declaration is a real property (no "//width" pseudo-comments).
  for (const r of rules) {
    for (const prop of Object.keys(r.decls)) {
      assert.match(prop, /^(--[a-z0-9-]+|[a-z][a-z-]*)$/, r.selectors.join(', ') + ' { ' + prop + ' }');
    }
  }
  const cell = resolve(declsAt(rules, '.tf8-tile', 1280).background);
  assert.equal(cell, '#111827');
  assert.equal(resolve(declsAt(rules, '.tf8-tile-0', 1280).background), cell);
  const colours = {};
  for (let v = 2; v <= 4096; v *= 2) colours[v] = declsAt(rules, '.tf8-tile-' + v, 1280).background;
  assert.deepEqual(colours, {
    2: '#172554', 4: '#1d4ed8', 8: '#0369a1', 16: '#0f766e', 32: '#15803d', 64: '#ca8a04',
    128: '#ea580c', 256: '#ea580c', 512: '#ea580c', 1024: '#dc2626', 2048: '#dc2626', 4096: '#dc2626'
  });
  // Swipes on the board never scroll the page; the toast hides until shown.
  assert.equal(declsAt(rules, '.tf8-board', 375)['touch-action'], 'none');
  assert.equal(declsAt(rules, '.tf8-toast', 375).opacity, '0');
  assert.equal(declsAt(rules, '.tf8-toast.tf8-show', 375).opacity, '1');
});

// ── Board logic ─────────────────────────────────────────────────────────────

test('2048: slideRow packs a row to the left, merges each pair once and counts the merged tiles', () => {
  const { slideRow } = loadScript(SCRIPT);
  const cases = [
    [[2, 2, 2, 2], [4, 4, 0, 0], 8],
    [[2, 2, 4, 0], [4, 4, 0, 0], 4],
    [[0, 4, 4, 8], [8, 8, 0, 0], 8],
    [[2, 0, 0, 2], [4, 0, 0, 0], 4],
    [[4, 4, 4, 0], [8, 4, 0, 0], 8],
    [[8, 4, 4, 0], [8, 8, 0, 0], 8],
    [[4, 4, 8, 0], [8, 8, 0, 0], 8],
    [[2, 4, 8, 16], [2, 4, 8, 16], 0],
    [[0, 0, 0, 2], [2, 0, 0, 0], 0],
    [[0, 0, 0, 0], [0, 0, 0, 0], 0],
    [[1024, 1024, 0, 0], [2048, 0, 0, 0], 2048]
  ];
  for (const [row, expected, gained] of cases) {
    const input = row.slice();
    assert.deepEqual(slideRow(input), { row: expected, gained }, JSON.stringify(row));
    assert.deepEqual(input, row, 'the row passed in is left alone');
  }
});

test('2048: rotateBoardClockwise turns the board a quarter and leaves the input alone', () => {
  const tf8 = loadScript(SCRIPT);
  const m = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]];
  const copy = tf8.copyBoard(m);
  assert.deepEqual(tf8.rotateBoardClockwise(m), [
    [13, 9, 5, 1], [14, 10, 6, 2], [15, 11, 7, 3], [16, 12, 8, 4]
  ]);
  assert.deepEqual(m, copy);
  let r = m;
  for (let i = 0; i < 4; i++) r = tf8.rotateBoardClockwise(r);
  assert.deepEqual(r, m);
  // copyBoard and createEmptyBoard hand out new row arrays.
  assert.notEqual(copy[0], m[0]);
  const a = tf8.createEmptyBoard();
  const b = tf8.createEmptyBoard();
  assert.deepEqual(a, empty());
  assert.notEqual(a[0], b[0]);
});

test('2048: moveBoard slides and merges in all four directions without touching the board it gets', () => {
  const { moveBoard } = loadScript(SCRIPT);
  const board = [
    [2, 2, 0, 4],
    [0, 4, 0, 4],
    [2, 0, 8, 0],
    [2, 0, 8, 4]
  ];
  const copy = JSON.stringify(board);
  const expected = {
    left: { board: [[4, 4, 0, 0], [8, 0, 0, 0], [2, 8, 0, 0], [2, 8, 4, 0]], gained: 12, changed: true },
    right: { board: [[0, 0, 4, 4], [0, 0, 0, 8], [0, 0, 2, 8], [0, 2, 8, 4]], gained: 12, changed: true },
    up: { board: [[4, 2, 16, 8], [2, 4, 0, 4], [0, 0, 0, 0], [0, 0, 0, 0]], gained: 28, changed: true },
    down: { board: [[0, 0, 0, 0], [0, 0, 0, 0], [2, 2, 0, 4], [4, 4, 16, 8]], gained: 28, changed: true }
  };
  for (const direction of Object.keys(expected)) {
    const result = moveBoard(board, direction);
    assert.deepEqual(result, expected[direction], direction);
    assert.equal(JSON.stringify(board), copy, direction + ' left the board alone');
  }

  // Nothing can move left on a packed board without equal neighbours.
  const packed = withRows([2, 4, 0, 0], [8, 0, 0, 0]);
  const blocked = moveBoard(packed, 'left');
  assert.deepEqual(blocked, { board: packed, gained: 0, changed: false });
  assert.notEqual(blocked.board, packed);
  assert.equal(moveBoard(packed, 'down').changed, true);

  for (const direction of ['sideways', '', 'toString', 'constructor', undefined]) {
    assert.equal(moveBoard(board, direction), null, String(direction));
  }
});

test('2048: canMove, hasWon and gameStatus read a board; a 2048 beats a locked board, a locked board past 2048 is Game Over', () => {
  const { canMove, hasWon, gameStatus, emptyCells } = loadScript(SCRIPT);
  const copy = (b) => b.map((row) => row.slice());
  assert.equal(canMove(LOCKED), false);
  assert.equal(hasWon(LOCKED), false);
  assert.equal(gameStatus(LOCKED), 'over');
  assert.deepEqual(emptyCells(LOCKED), []);

  const horizontal = copy(LOCKED);
  horizontal[3][3] = 32; // equal to its left neighbour
  const vertical = copy(LOCKED);
  vertical[3][0] = 2; // equal to the tile above
  const gap = copy(LOCKED);
  gap[1][2] = 0;
  for (const b of [horizontal, vertical, gap]) {
    assert.equal(canMove(b), true, JSON.stringify(b));
    assert.equal(gameStatus(b), '');
  }
  assert.deepEqual(emptyCells(gap), [{ row: 1, col: 2 }]);
  const all = emptyCells(empty());
  assert.equal(all.length, 16);
  assert.deepEqual([all[0], all[5], all[15]], [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 3, col: 3 }]);

  const won = copy(gap);
  won[2][1] = 2048;
  assert.equal(hasWon(won), true);
  assert.equal(gameStatus(won), 'won');
  // Past 2048 the game is still won; a locked board with 2048 shows the win.
  assert.equal(gameStatus(withRows([4096, 2, 0, 0])), 'won');
  const lockedWin = copy(LOCKED);
  lockedWin[0][0] = 2048;
  assert.equal(canMove(lockedWin), false);
  assert.equal(gameStatus(lockedWin), 'won');
  assert.equal(gameStatus(withRows([1024, 1024, 0, 0])), '');

  // Played on past 2048 with no 2048 tile left: the win stays while the board
  // can move, and a locked board is Game Over, as it always was.
  for (const big of [4096, 8192, 131072]) {
    const lockedPast = copy(LOCKED);
    lockedPast[3][2] = big;
    assert.equal(canMove(lockedPast), false, String(big));
    assert.equal(hasWon(lockedPast), true, String(big));
    assert.equal(gameStatus(lockedPast), 'over', String(big));
    const playable = copy(lockedPast);
    playable[0][0] = 0;
    assert.equal(gameStatus(playable), 'won', String(big));
  }
  assert.equal(gameStatus(LOCKED_PAST), 'over');
  assert.equal(gameStatus(LOCK_NEXT_PAST), 'won');
  // A 2048 next to a 4096 on a locked board still shows the win.
  const lockedBoth = copy(LOCKED_PAST);
  lockedBoth[0][0] = 2048;
  assert.equal(canMove(lockedBoth), false);
  assert.equal(gameStatus(lockedBoth), 'won');
});

test('2048: a new tile lands on the rolled empty cell, a 2 below 0.9 and otherwise a 4', (t) => {
  const { addRandomTile, randomCell } = loadScript(SCRIPT);
  mocks(t, [0, 0.95, 0.45, 0.2]);
  const b = empty();
  // Cell 0 of 16 -> (0,0), value roll 0.95 -> 4; cell floor(0.45 * 15) = 6 of
  // the 15 left, row by row -> (1,3), value roll 0.2 -> 2.
  assert.deepEqual(addRandomTile(b), { row: 0, col: 0 });
  assert.deepEqual(addRandomTile(b), { row: 1, col: 3 });
  assert.deepEqual(b, withRows([4, 0, 0, 0], [0, 0, 0, 2]));

  rolls = [0.9999, 0.8999];
  assert.deepEqual(addRandomTile(empty()), { row: 3, col: 3 });
  const last = LOCKED.map((row) => row.slice());
  last[2][2] = 0;
  rolls = [0.99, 0.9];
  assert.deepEqual(addRandomTile(last), { row: 2, col: 2 });
  assert.equal(last[2][2], 4);
  rolls = [0.5, 0.8999];
  const two = empty();
  addRandomTile(two);
  assert.equal(two[2][0], 2);

  // A full board gets nothing and rolls nothing.
  rolls = [];
  const full = LOCKED.map((row) => row.slice());
  assert.equal(addRandomTile(full), null);
  assert.equal(randomCell(full), null);
  assert.deepEqual(full, LOCKED);
});

test('2048: swipeDirection needs more than 40 px along the main axis; a tie goes vertical', () => {
  const { swipeDirection } = loadScript(SCRIPT);
  const cases = [
    [41, 0, 'right'], [-41, 0, 'left'], [0, 41, 'down'], [0, -41, 'up'],
    [41, 5, 'right'], [5, -41, 'up'], [-41, 40, 'left'],
    [60, 60, 'down'], [-60, -60, 'up'], [60, -60, 'up'], [-60, 60, 'down'],
    [40, 0, ''], [-40, 0, ''], [0, 40, ''], [0, -40, ''], [30, 30, ''], [0, 0, '']
  ];
  for (const [dx, dy, direction] of cases) assert.equal(swipeDirection(dx, dy), direction, dx + ',' + dy);
});

test('2048: parseSave accepts the original save format and rejects anything that is not a playable board', () => {
  const { parseSave, parseBestScore } = loadScript(SCRIPT);
  assert.deepEqual(parseSave(BASELINE_SAVE), {
    board: [[2, 4, 0, 0], [0, 8, 0, 0], [0, 0, 16, 0], [0, 0, 0, 2048]],
    score: 1234
  });
  const board = JSON.stringify(withRows([2, 2, 0, 0]));
  assert.deepEqual(parseSave('{"board":' + board + ',"score":4,"extra":true}'), { board: withRows([2, 2, 0, 0]), score: 4 });
  assert.deepEqual(parseSave(JSON.stringify({ board: withRows([131072, 65536, 0, 0]), score: 0 })).board[0], [131072, 65536, 0, 0]);

  // A score that is not a whole number of 0 or more reads as 0.
  for (const score of ['"abc"', '-50', '12.5', 'null', 'true', '"40"', '1e400', '[]']) {
    assert.deepEqual(parseSave('{"board":' + board + ',"score":' + score + '}'), { board: withRows([2, 2, 0, 0]), score: 0 }, score);
  }
  assert.equal(parseSave('{"board":' + board + '}').score, 0);

  for (const raw of BAD_SAVES) assert.equal(parseSave(raw), null, String(raw));

  assert.equal(parseBestScore('5000'), 5000);
  assert.equal(parseBestScore('12abc'), 12);
  for (const raw of [null, '', 'junk', '-5', '0', 'NaN']) assert.equal(parseBestScore(raw), 0, String(raw));
});

// ── Start-up ────────────────────────────────────────────────────────────────

test('2048: with nothing saved the page deals a new game of two tiles, keeps the best score and saves', (t) => {
  mocks(t, [0, 0.95, 0.45, 0.2]);
  const g = boot({ best: 77 });
  const expected = withRows([4, 0, 0, 0], [0, 0, 0, 2]);
  assert.deepEqual(g.board(), expected);
  const tiles = g.tiles();
  assert.equal(tiles[0].className, 'tf8-tile tf8-tile-4');
  assert.equal(tiles[0].textContent, '4');
  assert.equal(tiles[7].className, 'tf8-tile tf8-tile-2');
  assert.equal(tiles[1].className, 'tf8-tile tf8-tile-0');
  assert.equal(tiles[1].textContent, '');
  assert.equal(g.score(), '0');
  assert.equal(g.best(), '77');
  assert.equal(g.message(), '');
  assert.equal(localStorage.getItem(KEY), JSON.stringify({ board: expected, score: 0 }));
  assert.equal(localStorage.getItem(BEST), '77');

  // init bound each control once.
  assert.equal(listenerCount(document, 'keydown'), 1);
  const board = g.els['tf8-board'];
  for (const type of ['touchstart', 'touchend']) {
    const list = listenersOf(board, type);
    assert.equal(list.length, 1, type);
    assert.equal(list[0].passive, true, type + ' is passive');
  }
  for (const id of ['tf8-new-game-btn', 'tf8-undo-btn', 'tf8-restart-btn']) {
    assert.equal(listenerCount(g.els[id], 'click'), 1, id);
  }
});

test('2048: a script loaded in the page head waits for DOMContentLoaded and finds the markup then', (t) => {
  mocks(t);
  const page = createPage({}); // the body is not parsed yet
  const b = bootLikeBrowser(SCRIPT, page, { readyState: 'loading' });
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(document, 'keydown'), 0);
  assert.deepEqual(page.requested, []);

  for (const [id, props] of Object.entries(htmlPageSpec(HTML))) page.add(id, props);
  b.ready();
  const g = view(b);
  assert.deepEqual(g.board(), FRESH);
  assert.equal(listenerCount(document, 'keydown'), 1);
  pressKey('ArrowRight');
  assert.deepEqual(g.board(), withRows([2, 0, 0, 4]));
});

test('2048: a save written by the first version loads unchanged and is written back byte for byte', (t) => {
  mocks(t);
  store(BASELINE_SAVE, '5000');
  const { exports: tf8, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  tf8.init();
  const g = view({ els });
  assert.deepEqual(g.board(), [[2, 4, 0, 0], [0, 8, 0, 0], [0, 0, 16, 0], [0, 0, 0, 2048]]);
  assert.equal(g.score(), '1234');
  assert.equal(g.best(), '5000');
  assert.equal(g.message(), WON);
  assert.equal(localStorage.getItem(KEY), BASELINE_SAVE, 'loading does not rewrite the save');
  tf8.saveGame();
  assert.equal(localStorage.getItem(KEY), BASELINE_SAVE);
  assert.equal(localStorage.getItem(BEST), '5000');

  // The exported actions report what they did.
  assert.equal(tf8.undoMove(), false);
  assert.equal(tf8.handleMove('sideways'), false);
  assert.equal(localStorage.getItem(KEY), BASELINE_SAVE);
  assert.equal(tf8.handleMove('left'), true);
  const moved = g.board();
  assert.notDeepEqual(moved, JSON.parse(BASELINE_SAVE).board);

  // A second init binds nothing twice and does not load the save again: the
  // move just made and its undo step are still there.
  tf8.init();
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(els['tf8-undo-btn'], 'click'), 1);
  assert.deepEqual(g.board(), moved);
  assert.equal(tf8.undoMove(), true);
  assert.equal(localStorage.getItem(KEY), BASELINE_SAVE);
});

test('2048: a corrupt or partial save starts a fresh game instead of crashing', (t) => {
  mocks(t);
  for (const raw of BAD_SAVES.filter((r) => r !== null)) {
    resetStubs();
    store(raw, '300');
    let g;
    assert.doesNotThrow(() => { g = boot(); }, raw);
    assert.deepEqual(g.board(), FRESH, raw);
    assert.equal(g.score(), '0', raw);
    assert.equal(g.best(), '300', raw);
    assert.equal(g.message(), '', raw);
    assert.deepEqual(saved(), { board: FRESH, score: 0 }, raw + ' is replaced by the new game');
    assert.doesNotThrow(() => pressKey('ArrowRight'), raw);
    assert.deepEqual(g.board(), withRows([2, 0, 0, 4]), raw);
    assert.equal(g.score(), '4', raw);
  }
});

test('2048: a saved score that is not a whole number of 0 or more reads as 0 and merges add up from there', (t) => {
  mocks(t);
  for (const score of ['"abc"', '-50', '12.5', 'null', '"40"', '1e400']) {
    resetStubs();
    store('{"board":[[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],"score":' + score + '}');
    const g = boot();
    assert.deepEqual(g.board(), FRESH, score);
    assert.equal(g.score(), '0', score);
    pressKey('ArrowRight');
    assert.equal(g.score(), '4', score);
    assert.equal(saved().score, 4, score);
  }
});

test('2048: blocked or full storage never stops the game: it starts, plays and still shows Game Over', (t) => {
  mocks(t);
  // Storage full: saving throws, but the locking move still shows Game Over.
  store({ board: LOCK_NEXT, score: 0 });
  const setItem = t.mock.method(localStorage, 'setItem', () => {
    throw new Error('QuotaExceededError');
  });
  let g = boot();
  assert.doesNotThrow(() => pressKey('ArrowLeft'));
  assert.deepEqual(g.board(), LOCKED);
  assert.equal(g.message(), OVER);
  assert.ok(setItem.mock.callCount() >= 2);
  g.click('tf8-undo-btn');
  assert.deepEqual(g.board(), LOCK_NEXT);
  assert.equal(g.message(), '');

  // Reading throws too: a fresh game starts and plays.
  resetStubs();
  t.mock.method(localStorage, 'getItem', () => {
    throw new Error('SecurityError');
  });
  g = boot();
  assert.deepEqual(g.board(), FRESH);
  pressKey('ArrowRight');
  assert.deepEqual(g.board(), withRows([2, 0, 0, 4]));

  // Site data blocked: even touching localStorage throws.
  resetStubs();
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: The operation is insecure.'); }
  });
  try {
    g = boot();
    assert.deepEqual(g.board(), FRESH);
    pressKey('ArrowRight');
    assert.deepEqual(g.board(), withRows([2, 0, 0, 4]));
    g.click('tf8-new-game-btn');
    assert.deepEqual(g.board(), FRESH);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', real);
  }
});

// ── Keyboard ────────────────────────────────────────────────────────────────

test('2048: each arrow key slides the tiles its way and does not scroll the page', (t) => {
  mocks(t);
  for (const [key, after] of Object.entries(AFTER)) {
    resetStubs();
    const g = boot({ save: START });
    const event = pressKey(key);
    assert.equal(event.defaultPrevented, true, key + ' is prevented');
    assert.deepEqual(g.board(), after.board, key);
    assert.equal(g.score(), String(after.score), key);
    assert.deepEqual(saved(), after, key);
  }

  // An arrow that moves nothing is still the game's key, not the page's.
  resetStubs();
  const g = boot({ save: withRows([2, 0, 0, 0]) });
  const raw = localStorage.getItem(KEY);
  assert.equal(pressKey('ArrowLeft').defaultPrevented, true);
  assert.deepEqual(g.board(), withRows([2, 0, 0, 0]));
  assert.equal(localStorage.getItem(KEY), raw);
});

test('2048: while the board is scrolled out of the window the arrows scroll the page and leave the board alone', (t) => {
  mocks(t);
  const g = boot({ save: START });
  const raw = localStorage.getItem(KEY);
  const away = {
    above: { top: -400, left: 440, width: 400, height: 400 },
    left: { top: 200, left: -400, width: 400, height: 400 },
    below: { top: 900, left: 440, width: 400, height: 400 },
    right: { top: 200, left: 1280, width: 400, height: 400 }
  };
  for (const [where, box] of Object.entries(away)) {
    g.placeBoard(box);
    for (const key of Object.keys(AFTER)) {
      assert.equal(pressKey(key).defaultPrevented, false, key + ' with the board ' + where);
    }
    assert.deepEqual(g.board(), START, 'board ' + where);
    assert.equal(localStorage.getItem(KEY), raw, 'board ' + where);
  }

  // One row of pixels inside the window is enough to play.
  g.placeBoard({ top: -399, left: 440, width: 400, height: 400 });
  assert.equal(pressKey('ArrowLeft').defaultPrevented, true);
  assert.deepEqual(g.board(), AFTER.ArrowLeft.board);
  g.placeBoard({ top: 899, left: 879, width: 400, height: 400 });
  g.click('tf8-undo-btn');
  assert.equal(pressKey('ArrowRight').defaultPrevented, true);
  assert.deepEqual(g.board(), AFTER.ArrowRight.board);
});

test('2048: keys typed into a field of the host page, with Ctrl, Alt or Meta, or already handled leave the board alone; Shift+Arrow plays', (t) => {
  mocks(t);
  const g = boot({ save: START });
  const raw = localStorage.getItem(KEY);
  const untouched = (what) => {
    assert.deepEqual(g.board(), START, what);
    assert.equal(localStorage.getItem(KEY), raw, what);
  };

  for (const key of ['a', 'w', 'Enter', ' ', 'Escape', 'Tab', 'Home', 'PageDown', undefined]) {
    assert.equal(pressKey(key).defaultPrevented, false, String(key));
    untouched(String(key));
  }

  const page = g.b.page;
  const fields = [
    page.add('host-search', 'input'),
    page.add('host-comment', 'textarea'),
    page.add('host-sort', 'select'),
    page.add('host-editor', { isContentEditable: true })
  ];
  for (const field of fields) {
    field.focus();
    assert.equal(pressKey('ArrowLeft').defaultPrevented, false, field.tagName + ' keeps its caret keys');
    untouched(field.tagName);
    field.blur();
  }

  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    assert.equal(pressKey('ArrowLeft', { [modifier]: true }).defaultPrevented, false, modifier);
    untouched(modifier);
  }

  // Shift is no shortcut modifier: Shift+Arrow still plays, as it always did.
  assert.equal(pressKey('ArrowLeft', { shiftKey: true }).defaultPrevented, true, 'shiftKey');
  assert.deepEqual(g.board(), AFTER.ArrowLeft.board, 'shiftKey');
  g.click('tf8-undo-btn');
  untouched('shiftKey, then Undo');

  const hostHandler = (event) => event.preventDefault();
  window.addEventListener('keydown', hostHandler, true);
  pressKey('ArrowLeft');
  untouched('a key the host page already handled');
  window.removeEventListener('keydown', hostHandler, true);

  // A focused game button does not stop the arrows; Enter still clicks it.
  g.els['tf8-undo-btn'].focus();
  assert.equal(pressKey('ArrowLeft').defaultPrevented, true);
  assert.deepEqual(g.board(), AFTER.ArrowLeft.board);
  pressKey('Enter');
  assert.deepEqual(g.board(), START);
  assert.equal(g.toast(), 'Undo');
});

// ── Touch ───────────────────────────────────────────────────────────────────

test('2048: a swipe on the board longer than 40 px slides the tiles its way', (t) => {
  mocks(t);
  const cases = [
    [-100, 0, 'ArrowLeft'], [100, 0, 'ArrowRight'], [0, -100, 'ArrowUp'], [0, 100, 'ArrowDown'],
    [41, 5, 'ArrowRight'], [-41, 40, 'ArrowLeft'], [60, 60, 'ArrowDown'], [-60, -60, 'ArrowUp']
  ];
  for (const [dx, dy, key] of cases) {
    resetStubs();
    const g = boot({ save: START });
    swipe(g.els['tf8-board'], [150, 150], [150 + dx, 150 + dy]);
    assert.deepEqual(g.board(), AFTER[key].board, dx + ',' + dy);
    assert.equal(g.score(), String(AFTER[key].score), dx + ',' + dy);
  }

  resetStubs();
  const g = boot({ save: START });
  for (const [dx, dy] of [[40, 0], [-40, 0], [0, 40], [0, -40], [30, 30], [0, 0]]) {
    swipe(g.els['tf8-board'], [150, 150], [150 + dx, 150 + dy]);
    assert.deepEqual(g.board(), START, dx + ',' + dy + ' is too short');
  }
});

test('2048: a second finger cancels the swipe, and only the finger that started it can end it', (t) => {
  mocks(t);
  const g = boot({ save: START });
  const board = g.els['tf8-board'];
  const finger = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });

  // A pinch: finger 0 down, finger 1 down 120 px to its right, finger 1 lifts
  // 100 px further right and finger 0 lifts 100 px to the left of where it
  // started.  Each finger alone would be a swipe; together they are not.
  board.dispatchEvent(touchEvent('touchstart', [finger(0, 100, 100)]));
  board.dispatchEvent(touchEvent('touchstart', [finger(0, 100, 100), finger(1, 220, 100)]));
  board.dispatchEvent(touchEvent('touchend', [finger(1, 320, 100)]));
  board.dispatchEvent(touchEvent('touchend', [finger(0, 0, 100)]));
  assert.deepEqual(g.board(), START);

  // A touchend with no swipe started is ignored.
  board.dispatchEvent(touchEvent('touchend', [finger(3, 300, 100)]));
  assert.deepEqual(g.board(), START);

  // Another finger lifting does not end the swipe; the one that started it does.
  board.dispatchEvent(touchEvent('touchstart', [finger(5, 150, 100)]));
  board.dispatchEvent(touchEvent('touchend', [finger(6, 300, 100)]));
  assert.deepEqual(g.board(), START);
  board.dispatchEvent(touchEvent('touchend', [finger(6, 300, 100), finger(5, 50, 100)]));
  assert.deepEqual(g.board(), AFTER.ArrowLeft.board);

  // The swipe is over: lifting finger 5 again does nothing.
  board.dispatchEvent(touchEvent('touchend', [finger(5, 300, 100)]));
  assert.deepEqual(g.board(), AFTER.ArrowLeft.board);
});

// ── Buttons, undo and messages ──────────────────────────────────────────────

test('2048: New Game deals a fresh board, keeps the best score and forgets the old moves', (t) => {
  mocks(t);
  const g = boot({ save: withRows([0, 0, 0, 2]), best: 40 });
  pressKey('ArrowLeft');
  pressKey('ArrowRight');
  assert.equal(g.score(), '4');

  // Cell floor(0.5 * 16) = 8 -> (2,0), roll 0.95 -> 4; cell floor(0.1 * 15) = 1 -> (0,1), 2.
  rolls = [0.5, 0.95, 0.1, 0.5];
  g.click('tf8-new-game-btn');
  const fresh = withRows([0, 2, 0, 0], [0, 0, 0, 0], [4, 0, 0, 0]);
  assert.deepEqual(g.board(), fresh);
  assert.equal(g.score(), '0');
  assert.equal(g.best(), '40');
  assert.equal(g.message(), '');
  assert.deepEqual(saved(), { board: fresh, score: 0 });
  assert.equal(localStorage.getItem(BEST), '40');

  rolls = 0;
  g.click('tf8-undo-btn');
  assert.deepEqual(g.board(), fresh, 'Undo cannot reach the previous game');
  assert.equal(g.toastShown(), false);

  for (let i = 0; i < 5; i++) g.click('tf8-new-game-btn');
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(g.els['tf8-board'], 'touchstart'), 1);
  assert.equal(listenerCount(g.els['tf8-board'], 'touchend'), 1);
});

test('2048: Restart starts over like New Game, says so in a toast and forgets the old moves', (t) => {
  mocks(t);
  const g = boot({ save: withRows([0, 0, 0, 2]), best: 40 });
  pressKey('ArrowLeft');
  g.click('tf8-restart-btn');
  assert.deepEqual(g.board(), FRESH);
  assert.equal(g.score(), '0');
  assert.equal(g.best(), '40');
  assert.equal(g.toast(), 'Restarted');
  assert.equal(g.toastShown(), true);
  assert.deepEqual(saved(), { board: FRESH, score: 0 });

  g.click('tf8-undo-btn');
  assert.deepEqual(g.board(), FRESH);
  assert.equal(g.toast(), 'Restarted');
  t.mock.timers.tick(1800);
  assert.equal(g.toastShown(), false);
});

test('2048: Undo steps back through the last 10 moves, one per click, and never lowers the best score', (t) => {
  mocks(t);
  const g = boot({ save: withRows([2, 0, 0, 0]) });
  const snapshots = [localStorage.getItem(KEY)];
  const moves = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowDown',
    'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
  for (const key of moves) {
    pressKey(key);
    const raw = localStorage.getItem(KEY);
    assert.notEqual(raw, snapshots[snapshots.length - 1], key + ' moved something');
    snapshots.push(raw);
  }
  const best = g.best();
  assert.equal(best, String(saved().score));

  for (let i = 1; i <= 10; i++) {
    g.click('tf8-undo-btn');
    const raw = snapshots[12 - i];
    assert.equal(localStorage.getItem(KEY), raw, 'undo ' + i);
    assert.deepEqual(g.board(), JSON.parse(raw).board, 'undo ' + i);
    assert.equal(g.score(), String(JSON.parse(raw).score), 'undo ' + i);
    assert.equal(g.toast(), 'Undo');
    assert.equal(g.best(), best);
  }
  // Only the last 10 moves are kept: an 11th undo changes nothing.
  t.mock.timers.tick(1800);
  g.click('tf8-undo-btn');
  assert.equal(localStorage.getItem(KEY), snapshots[2]);
  assert.equal(g.toastShown(), false);
  assert.equal(localStorage.getItem(BEST), best);
});

test('2048: a move that changes nothing is not recorded, so Undo goes back to the last real move', (t) => {
  mocks(t);
  const start = withRows([0, 0, 0, 2]);
  const g = boot({ save: start });
  pressKey('ArrowRight'); // blocked
  g.click('tf8-undo-btn');
  assert.deepEqual(g.board(), start);
  assert.equal(g.toastShown(), false, 'nothing to undo, so no toast');

  pressKey('ArrowLeft'); // a real move
  assert.deepEqual(g.board(), withRows([2, 2, 0, 0]));
  for (let i = 0; i < 10; i++) pressKey('ArrowUp'); // blocked
  g.click('tf8-undo-btn');
  assert.deepEqual(g.board(), start);
  assert.deepEqual(saved().board, start);
  assert.equal(g.toastShown(), true);
});

test('2048: a toast shows for 1.8 s, and a new toast restarts that time', (t) => {
  mocks(t);
  const g = boot({ save: withRows([0, 0, 0, 2]) });
  pressKey('ArrowLeft');
  pressKey('ArrowDown');
  g.click('tf8-undo-btn');
  assert.equal(g.toast(), 'Undo');
  assert.equal(g.toastShown(), true);
  t.mock.timers.tick(1799);
  assert.equal(g.toastShown(), true);
  t.mock.timers.tick(1);
  assert.equal(g.toastShown(), false);

  g.click('tf8-undo-btn');
  assert.equal(g.toastShown(), true);
  t.mock.timers.tick(1200);
  g.click('tf8-restart-btn');
  assert.equal(g.toast(), 'Restarted');
  t.mock.timers.tick(1799);
  assert.equal(g.toastShown(), true, 'the first toast\'s timer no longer hides the second');
  t.mock.timers.tick(1);
  assert.equal(g.toastShown(), false);
});

test('2048: a real move adds a tile, scores the merges, raises Best only when beaten and saves in the original format', (t) => {
  mocks(t);
  let g = boot({ save: { board: withRows([2, 2, 0, 0]), score: 10 }, best: 8 });
  pressKey('ArrowRight');
  assert.equal(localStorage.getItem(KEY), '{"board":[[2,0,0,4],[0,0,0,0],[0,0,0,0],[0,0,0,0]],"score":14}');
  assert.equal(localStorage.getItem(BEST), '14');
  assert.equal(g.score(), '14');
  assert.equal(g.best(), '14');

  // A move that changes nothing saves nothing.
  localStorage.removeItem(KEY);
  pressKey('ArrowUp');
  assert.equal(localStorage.getItem(KEY), null);

  // Best stays when the score does not beat it.
  resetStubs();
  g = boot({ save: { board: withRows([4, 4, 0, 0]), score: 20 }, best: 50 });
  pressKey('ArrowLeft');
  assert.deepEqual(saved(), { board: withRows([8, 2, 0, 0]), score: 28 });
  assert.equal(localStorage.getItem(BEST), '50');
  assert.equal(g.best(), '50');

  // Several merges in one move add up: (2+2) + (4+4) + (8+8) + (16+16) = 60.
  resetStubs();
  g = boot({ save: withRows([2, 2, 4, 4], [8, 8, 16, 16]) });
  pressKey('ArrowLeft');
  assert.deepEqual(g.board(), withRows([4, 8, 2, 0], [16, 32, 0, 0]));
  assert.equal(g.score(), '60');
});

test('2048: the message follows the board: Game Over and the win show up, and Undo takes them back', (t) => {
  mocks(t);
  let g = boot({ save: { board: LOCK_NEXT, score: 50 }, best: 50 });
  assert.equal(g.message(), '');
  pressKey('ArrowLeft');
  assert.deepEqual(g.board(), LOCKED);
  assert.equal(g.message(), OVER);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) pressKey(key);
  assert.deepEqual(g.board(), LOCKED, 'nothing moves on a locked board');
  g.click('tf8-undo-btn');
  assert.deepEqual(g.board(), LOCK_NEXT);
  assert.equal(g.message(), '', 'Undo brings the game back');
  pressKey('ArrowDown');
  assert.deepEqual(g.board(), [[2, 4, 2, 4], [2, 2, 4, 2], [4, 4, 2, 4], [2, 8, 16, 32]]);
  assert.equal(g.message(), '');

  // Merging two 1024s adds 2048 and wins; Undo takes the win back, not Best.
  resetStubs();
  g = boot({ save: { board: withRows([1024, 1024, 0, 0]), score: 100 } });
  pressKey('ArrowLeft');
  assert.deepEqual(g.board(), withRows([2048, 2, 0, 0]));
  assert.equal(g.message(), WON);
  assert.equal(g.score(), '2148');
  assert.equal(g.best(), '2148');
  assert.equal(saved().score, 2148);
  assert.equal(localStorage.getItem(BEST), '2148');
  g.click('tf8-undo-btn');
  assert.deepEqual(g.board(), withRows([1024, 1024, 0, 0]));
  assert.equal(g.message(), '');
  assert.equal(g.score(), '100');
  assert.equal(g.best(), '2148');

  // Reaching 2048 with the board locked shows the win, not Game Over.
  resetStubs();
  g = boot({ save: [[1024, 1024, 2, 4], [4, 8, 16, 8], [8, 4, 8, 4], [4, 8, 4, 8]] });
  pressKey('ArrowLeft');
  assert.deepEqual(g.board()[0], [2048, 2, 4, 2]);
  assert.equal(g.message(), WON);

  // Playing on past 2048 keeps the win on screen.
  resetStubs();
  g = boot({ save: withRows([2048, 2048, 0, 0]) });
  assert.equal(g.message(), WON);
  pressKey('ArrowLeft');
  assert.deepEqual(g.board()[0], [4096, 2, 0, 0]);
  assert.equal(g.message(), WON);

  // Past 2048 (no 2048 tile left) the move that locks the board shows Game
  // Over; Undo brings the board, and with it the win, back.
  resetStubs();
  g = boot({ save: { board: LOCK_NEXT_PAST, score: 60000 } });
  assert.equal(g.message(), WON);
  pressKey('ArrowLeft');
  assert.deepEqual(g.board(), LOCKED_PAST);
  assert.equal(g.message(), OVER);
  g.click('tf8-undo-btn');
  assert.deepEqual(g.board(), LOCK_NEXT_PAST);
  assert.equal(g.message(), WON);
});

test('2048: after a reload the message matches the saved board', (t) => {
  mocks(t);
  const cases = [
    [LOCKED, OVER],
    [LOCKED_PAST, OVER],
    [withRows([2048, 2, 0, 0]), WON],
    [withRows([4096, 2, 0, 0]), WON],
    [LOCK_NEXT_PAST, WON],
    [START, '']
  ];
  for (const [board, message] of cases) {
    resetStubs();
    const g = boot({ save: board });
    assert.equal(g.message(), message, JSON.stringify(board));
    assert.deepEqual(g.board(), board);
  }
});

test('2048: Best never shows less than Score after a reload', (t) => {
  mocks(t);
  for (const [best, shown] of [[undefined, '500'], ['100', '500'], ['junk', '500'], ['-3', '500'], ['900', '900']]) {
    resetStubs();
    const g = boot({ save: { board: withRows([2, 0, 0, 0]), score: 500 }, best });
    assert.equal(g.score(), '500');
    assert.equal(g.best(), shown, String(best));
  }
});

test('2048: the game picks up where it left off after a reload, without the old undo history', (t) => {
  mocks(t);
  let g = boot({ save: { board: withRows([4, 4, 0, 0]), score: 20 }, best: 50 });
  pressKey('ArrowLeft');
  const before = { board: g.board(), score: g.score(), best: g.best(), raw: localStorage.getItem(KEY) };
  assert.deepEqual(before.board, withRows([8, 2, 0, 0]));
  g.b.restore(); // the page unloads
  assert.equal(listenerCount(document, 'keydown'), 0);

  g = boot();
  assert.deepEqual(g.board(), before.board);
  assert.equal(g.score(), '28');
  assert.equal(g.best(), '50');
  assert.equal(localStorage.getItem(KEY), before.raw);
  g.click('tf8-undo-btn');
  assert.deepEqual(g.board(), before.board);
  assert.equal(g.toastShown(), false);
});
