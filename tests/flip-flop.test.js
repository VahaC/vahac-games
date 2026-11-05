// tests/flip-flop.test.js
// Flip-Flop (flip-flop/, prefix ffl-): Reversi in ones and zeros against a
// local computer opponent or a second player.
//
// The rules and the computer are checked against an independent model kept
// in this file: a Reversi that reads each ray from a move as text and
// matches it with a regular expression, and a plain minimax without pruning.
// The page is booted like a browser from the real index.html
// (bootLikeBrowser) and driven through the listeners the game registered
// itself: clicks, hovers, focus and keys on the board, the buttons and the
// opponent select. setTimeout is mocked (the computer's move, the toast and
// the New Game confirmation) and Math.random is mocked wherever the computer
// draws or shuffles, so nothing waits on the real clock.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, focusElement, listenerCount, readRepoFile, idsInHtml, htmlPageSpec,
  embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

const GAME = 'flip-flop';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);
const STATE_KEY = 'ffl-state';
const STATS_KEY = 'ffl-stats';
const CPU_DELAY = 450;
const TOAST_MS = 2200;
const CONFIRM_MS = 3000;
const SAVE_FIELDS = ['board', 'turn', 'mode', 'history', 'hint', 'last'];
const NO_STATS = { easy: { wins: 0, losses: 0, draws: 0 }, normal: { wins: 0, losses: 0, draws: 0 }, hard: { wins: 0, losses: 0, draws: 0 } };

test.beforeEach(() => resetStubs());

// ── An independent model of the rules ───────────────────────────────────────

const EMPTY = 0;
const ONE = 1;
const ZERO = 2;
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const START = '...........................01......10...........................';

const fromText = (text) => [...text].map((ch) => '.10'.indexOf(ch));
const toText = (board) => board.map((v) => '.10'[v]).join('');
const other = (player) => 3 - player;

// The cells from index outward in one direction, up to the edge.
function ray(index, dr, dc) {
  const cells = [];
  for (let r = Math.floor(index / 8) + dr, c = (index % 8) + dc; r >= 0 && r < 8 && c >= 0 && c < 8; r += dr, c += dc) {
    cells.push(r * 8 + c);
  }
  return cells;
}

// Each ray read as text ('o' the other side, 'm' the mover, '.' empty): a run
// of o's closed by an m flips.
function modelFlips(board, player, index) {
  if (board[index] !== EMPTY) return [];
  const out = [];
  for (const [dr, dc] of DIRS) {
    const cells = ray(index, dr, dc);
    const text = cells.map((i) => (board[i] === EMPTY ? '.' : board[i] === player ? 'm' : 'o')).join('');
    const m = /^(o+)m/.exec(text);
    if (m) out.push(...cells.slice(0, m[1].length));
  }
  return out;
}

const modelMoves = (board, player) => board.map((v, i) => i).filter((i) => modelFlips(board, player, i).length > 0);

function modelPlay(board, player, index) {
  const next = board.slice();
  next[index] = player;
  for (const i of modelFlips(board, player, index)) next[i] = player;
  return next;
}

const modelCount = (board, player) => board.filter((v) => v === player).length;
const modelOver = (board) => !modelMoves(board, ONE).length && !modelMoves(board, ZERO).length;
const margin = (board, player) => modelCount(board, player) - modelCount(board, other(player));

// A random game played with the model (seeded), every position on the way,
// passes included, as { board, player } with player to move.
function randomGame(seed) {
  const rnd = seeded(seed);
  const positions = [];
  let board = fromText(START);
  let player = ONE;
  for (;;) {
    positions.push({ board, player });
    const moves = modelMoves(board, player);
    if (!moves.length) {
      if (!modelMoves(board, other(player)).length) return positions;
      player = other(player);
      continue;
    }
    board = modelPlay(board, player, moves[Math.floor(rnd() * moves.length)]);
    player = other(player);
  }
}

// Minimax without pruning, with the same leaves as the game's search: the
// game's evaluation at depth 0, the final margin at the end, and a pass that
// uses no ply.
function minimax(ffl, board, player, depth, full) {
  if (depth === 0) return ffl.fflEvaluate(board, player, full);
  const moves = modelMoves(board, player);
  if (!moves.length) {
    if (!modelMoves(board, other(player)).length) return margin(board, player) * 10000;
    return -minimax(ffl, board, other(player), depth, full);
  }
  let best = -Infinity;
  for (const m of moves) best = Math.max(best, -minimax(ffl, modelPlay(board, player, m), other(player), depth - 1, full));
  return best;
}

// The final margin for player with perfect play from both sides.
function exact(board, player) {
  const moves = modelMoves(board, player);
  if (!moves.length) {
    if (!modelMoves(board, other(player)).length) return margin(board, player);
    return -exact(board, other(player));
  }
  return Math.max(...moves.map((m) => -exact(modelPlay(board, player, m), other(player))));
}

// A board with one empty cell, 63: the mover's only move, flipping 62 and
// filling the board with moverFinal of the mover's bits.
function finale(mover, moverFinal) {
  const board = new Array(64).fill(other(mover));
  board[63] = EMPTY;
  board[61] = mover;
  board[55] = mover;
  board[54] = mover;
  let need = moverFinal - 5;
  for (let i = 0; i < 64 && need > 0; i++) {
    if (![54, 55, 61, 62, 63].includes(i)) {
      board[i] = mover;
      need--;
    }
  }
  return board;
}

// Found by search and checked in the tests: with 1s to move, 1 at 63 leaves
// the 0s without a move and the 1s with one more at 0 (PASS_FOR_ZERO); with
// 0s to move, the 0s' only move is 63, after which the 1s cannot move and
// the 0s play 0 (PASS_FOR_ONE); a position with ten empty cells where Hard's
// search to the end runs into its node cap (CAPPED, 0s to move).
const PASS_FOR_ZERO = '.01110100011110011011011101100100000000110011100101110101100101.';
const PASS_FOR_ONE = '.00000001100000010110111100111001010110010001110100010111001011.';
const CAPPED = '11111111.0001000.001010..0001101.001111110111101.11111011.1..1.1';

function save(fields) {
  return Object.assign({ board: START, turn: 1, mode: 'normal', history: [], hint: true, last: -1 }, fields);
}

// ── Pages ────────────────────────────────────────────────────────────────────

function fakeTimers(t) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
}

function writeStorage({ state, stats } = {}) {
  if (state !== undefined) localStorage.setItem(STATE_KEY, typeof state === 'string' ? state : JSON.stringify(state));
  if (stats !== undefined) localStorage.setItem(STATS_KEY, typeof stats === 'string' ? stats : JSON.stringify(stats));
}

// What a player sees and does on the page.
function pageView(els, extra) {
  const board = els['ffl-board'];
  const has = (el, name) => el.classList.contains(name);
  const view = {
    els,
    board,
    text: (id) => els[id].textContent,
    cells: () => board.children,
    cell: (i) => board.children[i],
    click: (i) => board.children[i].click(),
    glyphs: () => board.children.map((c) => (has(c, 'ffl-cell--one') ? '1' : has(c, 'ffl-cell--zero') ? '0' : '.')).join(''),
    marked: (name) => board.children.map((c, i) => (has(c, name) ? i : -1)).filter((i) => i !== -1),
    legal: () => view.marked('ffl-cell--legal'),
    saved: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    stats: () => JSON.parse(localStorage.getItem(STATS_KEY)),
    status: () => els['ffl-status'].textContent,
    log: () => els['ffl-log'].textContent,
    toast: () => els['ffl-toast'].textContent,
    toastVisible: () => has(els['ffl-toast'], 'ffl-toast--show'),
    newGame: () => els['ffl-new-game'].click(),
    undo: () => els['ffl-undo'].click(),
    hint: () => els['ffl-hint'].click(),
    choose: (mode) => {
      els['ffl-mode'].value = mode;
      return fire(els['ffl-mode'], 'change');
    }
  };
  return Object.assign(view, extra);
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

// The script as a module on the page with init run by hand.
function openModule(t, storage) {
  fakeTimers(t);
  writeStorage(storage);
  const { exports: ffl, els, page } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  ffl.fflInit();
  return pageView(els, { ffl, page });
}

// The cell the computer wrote between two boards (text).
function newBit(before, after, glyph) {
  const at = [...after].findIndex((ch, i) => ch === glyph && before[i] === '.');
  assert.notEqual(at, -1, 'a new ' + glyph);
  return at;
}

const bits = (n) => n + (n === 1 ? ' bit' : ' bits');
const hex = (index) => '0x' + index.toString(16).toUpperCase().padStart(2, '0');

const px = (value) => {
  const m = /^(-?\d+(?:\.\d+)?)(px|rem|em)$/.exec(String(value).trim());
  assert.ok(m, 'a length: ' + value);
  return Number(m[1]) * (m[2] === 'px' ? 1 : 16);
};

// ── Files ────────────────────────────────────────────────────────────────────

test('flip-flop: every id the script looks up exists once in index.html, and ids, classes, CSS variables, keys and exports are ffl- prefixed', () => {
  const ids = Array.from(JS.matchAll(/byId\('([^']+)'\)/g), (m) => m[1]);
  assert.equal(ids.length, 23);
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  assert.deepEqual([...new Set(ids)].sort(), [...htmlIds].sort(), 'the script uses every id of the page, and only those');
  for (const id of htmlIds) assert.match(id, /^ffl-/);
  assert.match(JS, /getElementById\(id\)/);

  const markup = embedMarkup(HTML);
  const classes = Array.from(markup.matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^ffl-/);
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors);
  for (const selector of selectors) {
    assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
    for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^ffl-/, selector);
  }
  // Every class in the markup has a rule.
  for (const name of new Set(classes)) {
    assert.ok(selectors.some((s) => new RegExp('\\.' + name + '(?![\\w-])').test(s)), name + ' has a rule');
  }
  // Custom property declarations (not class modifiers such as --secondary:hover).
  const props = Array.from(CSS.matchAll(/(?:^|[\s{;])--([\w-]+)\s*:/g), (m) => m[1]);
  assert.ok(props.length > 20);
  for (const name of props) assert.match(name, /^ffl-/);
  for (const m of CSS.matchAll(/var\(--([\w-]+)/g)) assert.match(m[1], /^ffl-/);
  for (const m of CSS.matchAll(/@keyframes\s+([\w-]+)/g)) assert.match(m[1], /^ffl-/);
  for (const m of JS.matchAll(/'(ffl-[\w-]*)'/g)) assert.match(m[1], /^ffl-/);
  assert.match(JS, /var FFL_STATE_KEY = 'ffl-state';/);
  assert.match(JS, /var FFL_STATS_KEY = 'ffl-stats';/);
  const ffl = loadScript(SCRIPT);
  assert.ok(Object.keys(ffl).length > 30);
  for (const name of Object.keys(ffl)) assert.match(name, /^ffl[A-Z]/, name);
});

test('flip-flop: the files embed safely, and the standalone page sets its own background outside the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="ffl-wrapper" id="ffl-game">'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.doesNotMatch(embedded, /<style|<link|<script/i);

  const bg = CSS.match(/--ffl-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule));
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.match(head, /<title>Flip-Flop — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
});

test('flip-flop: script.js is one strict ES5 IIFE, and nothing reaches the network or any outside service', () => {
  assert.match(JS, /^(\/\/[^\n]*\n)*\n?\(function \(\) \{\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/\(function \(\) \{/g).length, 1);
  const code = JS.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['exponent operator', /\*\*/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
  // No network, no workers, no code from strings: the opponent is this file.
  for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\bimport\s*\(/,
    /\beval\s*\(/, /new Function/, /\bWorker\b/, /https?:/]) {
    assert.doesNotMatch(code, re, String(re));
  }
  assert.doesNotMatch(CSS, /url\(|@import|https?:/);
  // The page loads nothing but its own two files.
  const refs = Array.from(HTML.matchAll(/\s(?:src|href)="([^"]+)"/g), (m) => m[1]);
  assert.deepEqual(refs, ['style.css', 'script.js']);
});

test('flip-flop: from 320 px up the board fits without sideways scrolling, with cells of at least 34 px on phones', () => {
  const rules = cssRules(CSS);
  const hpad = (padding) => px(padding.split(/\s+/)[1]);
  for (let vw = 320; vw <= 1280; vw++) {
    const wrapper = declsAt(rules, '.ffl-wrapper', vw);
    const main = declsAt(rules, '.ffl-main', vw);
    const boardRule = declsAt(rules, '.ffl-board', vw);
    assert.equal(declsAt(rules, '.ffl-wrapper *', vw)['box-sizing'], 'border-box');
    assert.equal(boardRule.width, '100%');
    assert.equal(boardRule['grid-template-columns'], 'repeat(8, minmax(0, 1fr))');
    assert.equal(declsAt(rules, '.ffl-cell', vw)['aspect-ratio'], '1 / 1');
    const content = Math.min(vw, px(wrapper['max-width'])) - 2 * hpad(wrapper.padding);
    const single = main['grid-template-columns'] === 'minmax(0, 1fr)';
    assert.equal(single, vw <= 760, vw + 'px: one column on phones and small tablets');
    const column = single ? content : content - 272 - px(main.gap);
    if (!single) assert.equal(main['grid-template-columns'], 'minmax(0, 1fr) 272px');
    const board = Math.min(column, px(boardRule['max-width']));
    const pad = px(wrapper['--ffl-board-pad']);
    const gap = px(wrapper['--ffl-gap']);
    const cell = (board - 2 * pad - 2 - 7 * gap) / 8;
    assert.ok(cell >= (vw <= 414 ? 34 : 38), vw + 'px: cells of ' + cell.toFixed(1) + 'px');
    // The dump rows (4 columns in em) fit their card on every width.
    const row = declsAt(rules, '.ffl-dump-row', vw);
    const em = px(row['font-size']);
    const cols = row['grid-template-columns'].split(/\s+/).reduce((sum, w) => sum + parseFloat(w), 0);
    const rowWidth = (cols + 3 * parseFloat(row.gap)) * em;
    const card = (single ? content : 272) - 2 * px(declsAt(rules, '.ffl-card', vw).padding) - 2;
    assert.ok(rowWidth <= card, vw + 'px: a dump row of ' + rowWidth.toFixed(0) + 'px in ' + card + 'px');
  }
  // 320 px: 304 px of content, 35 px cells.
  assert.equal(declsAt(rules, '.ffl-wrapper', 320).padding, '1rem 0.5rem');
  assert.equal(declsAt(rules, '.ffl-wrapper', 320)['--ffl-gap'], '2px');
  // Wrapping rows instead of overflowing ones, and long hex masks break.
  assert.equal(declsAt(rules, '.ffl-toolbar', 320)['flex-wrap'], 'wrap');
  assert.equal(declsAt(rules, '.ffl-actions', 320)['flex-wrap'], 'wrap');
  assert.equal(declsAt(rules, '.ffl-field', 320)['min-width'], '0');
  assert.equal(declsAt(rules, '.ffl-side-mask', 320)['word-break'], 'break-all');
  assert.equal(declsAt(rules, '.ffl-log', 320)['overflow-wrap'], 'anywhere');
  assert.equal(declsAt(rules, '.ffl-toast', 320)['max-width'], 'calc(100vw - 2rem)');
  assert.equal(declsAt(rules, '.ffl-sides', 320)['grid-template-columns'], 'minmax(0, 1fr) minmax(0, 1fr)');
  // Taps on the board never zoom, and nothing stops the page from scrolling.
  assert.equal(declsAt(rules, '.ffl-board', 320)['touch-action'], 'manipulation');
  assert.doesNotMatch(CSS, /touch-action:\s*none/);
  assert.equal(declsAt(rules, '.ffl-btn', 320)['min-height'], '44px');
  // Reduced motion turns the flips off.
  const calm = declsAt(rules, '.ffl-cell', 375, { matchMedia: (m) => /prefers-reduced-motion/.test(m) });
  assert.equal(calm.animation, 'none');
});

// ── Board rules ──────────────────────────────────────────────────────────────

test('flip-flop: the start position and its four legal moves, each flipping one bit', () => {
  const ffl = loadScript(SCRIPT);
  const board = ffl.fflNewBoard();
  assert.equal(toText(board), START);
  assert.deepEqual(ffl.fflCount(board), { ones: 2, zeros: 2, empty: 60 });
  assert.deepEqual(ffl.fflLegalMoves(board, ONE), [
    { index: 19, flips: [27] }, { index: 26, flips: [27] }, { index: 37, flips: [36] }, { index: 44, flips: [36] }
  ]);
  assert.deepEqual(ffl.fflLegalMoves(board, ZERO).map((m) => m.index), [20, 29, 34, 43]);
  assert.equal(ffl.fflMobility(board, ONE), 4);
  assert.equal(ffl.fflIsOver(board), false);
  assert.notEqual(ffl.fflNewBoard(), ffl.fflNewBoard(), 'a new array every time');
});

test('flip-flop: legal moves, flips and moves match the independent model in 12 random games', () => {
  const ffl = loadScript(SCRIPT);
  let positions = 0;
  for (let seed = 1; seed <= 12; seed++) {
    for (const { board, player } of randomGame(seed)) {
      positions++;
      const before = board.slice();
      for (const p of [ONE, ZERO]) {
        const moves = ffl.fflLegalMoves(board, p);
        assert.deepEqual(moves.map((m) => m.index), modelMoves(board, p));
        for (const m of moves) assert.deepEqual([...m.flips].sort((a, b) => a - b), modelFlips(board, p, m.index).sort((a, b) => a - b));
        assert.equal(ffl.fflMobility(board, p), moves.length);
      }
      for (let i = 0; i < 64; i++) {
        const result = ffl.fflApplyMove(board, player, i);
        const legal = modelFlips(board, player, i).length > 0;
        assert.equal(ffl.fflIsLegal(board, player, i), legal);
        if (legal) assert.deepEqual(result.board, modelPlay(board, player, i));
        else assert.equal(result, null);
      }
      assert.deepEqual(board, before, 'the board passed in is left alone');
      assert.equal(ffl.fflIsOver(board), modelOver(board));
    }
  }
  assert.ok(positions > 700);
});

test('flip-flop: a move flips every trapped line at once, never wraps around an edge and stops at gaps', () => {
  const ffl = loadScript(SCRIPT);
  // 1 at 0x24 (row 4, col 4 = 36) traps lines in three directions.
  const board = fromText(START);
  board.fill(EMPTY);
  for (const [i, v] of [[28, ZERO], [20, ONE], [35, ZERO], [34, ONE], [27, ZERO], [18, ONE], [37, ZERO], [45, ZERO]]) board[i] = v;
  const result = ffl.fflApplyMove(board, ONE, 36);
  assert.deepEqual(result.flips, [27, 28, 35]);
  assert.equal(modelCount(result.board, ONE), 7);
  assert.equal(result.board[37], ZERO, 'a line with no 1 at its end stays');
  assert.equal(result.board[45], ZERO);

  // Row ends are not neighbours: 0x07 and 0x08 sit on different rows.
  const edge = new Array(64).fill(EMPTY);
  edge[6] = ZERO;
  edge[5] = ONE;
  edge[8] = ZERO;
  edge[9] = ONE;
  assert.deepEqual(ffl.fflFlips(edge, ONE, 7), [6]);
  assert.deepEqual(ffl.fflFlips(edge, ONE, 15), []);
  // A gap breaks the line; a taken cell, or one off the board, is never legal.
  const gap = new Array(64).fill(EMPTY);
  gap[1] = ZERO;
  gap[3] = ONE;
  assert.deepEqual(ffl.fflFlips(gap, ONE, 0), []);
  assert.equal(ffl.fflApplyMove(gap, ONE, 3), null);
  assert.equal(ffl.fflApplyMove(gap, ONE, -1), null);
  assert.equal(ffl.fflApplyMove(gap, ONE, 64), null);
});

test('flip-flop: counts, the end of the game, the winner and who moves next (passes included)', () => {
  const ffl = loadScript(SCRIPT);
  const full = finale(ONE, 40);
  full[63] = ONE;
  full[62] = ONE;
  assert.deepEqual(ffl.fflCount(full), { ones: 40, zeros: 24, empty: 0 });
  assert.equal(ffl.fflIsOver(full), true);
  assert.equal(ffl.fflWinner(full), ONE);
  const flipped = full.map((v) => other(v));
  assert.equal(ffl.fflWinner(flipped), ZERO);
  const drawn = finale(ONE, 32);
  drawn[63] = ONE;
  drawn[62] = ONE;
  assert.equal(ffl.fflWinner(drawn), 0);

  // A wipe-out ends the game with empty cells left.
  const wipe = new Array(64).fill(EMPTY);
  wipe[0] = ONE;
  wipe[1] = ZERO;
  const after = ffl.fflApplyMove(wipe, ONE, 2).board;
  assert.equal(ffl.fflIsOver(after), true);
  assert.deepEqual(ffl.fflNextTurn(after, ONE), { turn: ZERO, passed: false, over: true });

  // The other side moves, or passes, or nobody can.
  assert.deepEqual(ffl.fflNextTurn(fromText(START), ZERO), { turn: ONE, passed: false, over: false });
  const pass = ffl.fflApplyMove(fromText(PASS_FOR_ZERO), ONE, 63).board;
  assert.deepEqual(modelMoves(pass, ZERO), []);
  assert.deepEqual(modelMoves(pass, ONE), [0]);
  assert.deepEqual(ffl.fflNextTurn(pass, ONE), { turn: ONE, passed: true, over: false });
  assert.deepEqual(modelMoves(fromText(PASS_FOR_ONE), ZERO), [63]);
  const pass2 = modelPlay(fromText(PASS_FOR_ONE), ZERO, 63);
  assert.deepEqual(modelMoves(pass2, ONE), []);
  assert.deepEqual(modelMoves(pass2, ZERO), [0]);
  assert.deepEqual(ffl.fflNextTurn(pass2, ZERO), { turn: ZERO, passed: true, over: false });
  assert.equal(modelOver(modelPlay(pass2, ZERO, 0)), true);
});

test('flip-flop: row masks, hex addresses, the 64-bit masks and their popcount', () => {
  const ffl = loadScript(SCRIPT);
  const board = fromText(START);
  assert.equal(ffl.fflRowMask(board, 3, ONE), 0x08);
  assert.equal(ffl.fflRowMask(board, 3, ZERO), 0x10);
  assert.equal(ffl.fflRowMask(board, 0, ONE), 0);
  assert.equal(ffl.fflMaskHex(board, ONE), '0x0000000810000000');
  assert.equal(ffl.fflMaskHex(board, ZERO), '0x0000001008000000');
  assert.equal(ffl.fflRowBits(board, 4), '...10...');
  assert.equal(ffl.fflHex(255, 2), 'FF');
  assert.equal(ffl.fflHex(10, 4), '000A');
  assert.equal(ffl.fflAddress(0), '0x00');
  assert.equal(ffl.fflAddress(27), '0x1B');
  assert.equal(ffl.fflAddress(63), '0x3F');
  // The mask, read as one 64-bit number, has as many set bits as the side has bits.
  const popcount = (text) => [...BigInt(text).toString(2)].filter((b) => b === '1').length;
  for (const { board: b } of randomGame(3)) {
    for (const p of [ONE, ZERO]) {
      const mask = ffl.fflMaskHex(b, p);
      assert.match(mask, /^0x[0-9A-F]{16}$/);
      assert.equal(popcount(mask), modelCount(b, p));
      for (let row = 0; row < 8; row++) {
        const bits = [...ffl.fflRowBits(b, row)].map((ch) => (ch === '.10'[p] ? '1' : '0')).join('');
        assert.equal(ffl.fflRowMask(b, row, p), parseInt(bits, 2));
      }
    }
  }
});

test('flip-flop: boards and undo steps go to text and back, and anything else is refused', () => {
  const ffl = loadScript(SCRIPT);
  const board = fromText(PASS_FOR_ZERO);
  assert.equal(ffl.fflBoardToString(board), PASS_FOR_ZERO);
  assert.deepEqual(ffl.fflStringToBoard(PASS_FOR_ZERO), board);
  for (const bad of [null, 42, '', START.slice(1), START + '.', START.replace('1', 'x'), START.replace('.', ' ')]) {
    assert.equal(ffl.fflStringToBoard(bad), null, JSON.stringify(bad));
  }
  assert.equal(ffl.fflSnapshot(board, ONE), PASS_FOR_ZERO + '1');
  assert.equal(ffl.fflSnapshot(board, ZERO), PASS_FOR_ZERO + '0');
  assert.deepEqual(ffl.fflParseSnapshot(START + '0'), { board: fromText(START), turn: ZERO });
  for (const bad of [null, START, START + '.', START + '2', START + '10', 'x'.repeat(65)]) {
    assert.equal(ffl.fflParseSnapshot(bad), null, JSON.stringify(bad));
  }
});

// ── The computer ─────────────────────────────────────────────────────────────

test('flip-flop: the evaluation adds cell weights, mobility and taken corners, and scores finished boards by margin', () => {
  const ffl = loadScript(SCRIPT);
  const TABLE = [
    100, -20, 10, 5, 5, 10, -20, 100, -20, -50, -2, -2, -2, -2, -50, -20,
    10, -2, -1, -1, -1, -1, -2, 10, 5, -2, -1, -1, -1, -1, -2, 5,
    5, -2, -1, -1, -1, -1, -2, 5, 10, -2, -1, -1, -1, -1, -2, 10,
    -20, -50, -2, -2, -2, -2, -50, -20, 100, -20, 10, 5, 5, 10, -20, 100
  ];
  assert.deepEqual(ffl.fflWeightTable, TABLE);
  for (let i = 0; i < 64; i++) {
    const r = Math.floor(i / 8);
    const c = i % 8;
    assert.equal(TABLE[i], TABLE[c * 8 + r], 'symmetric');
    assert.equal(TABLE[i], TABLE[(7 - r) * 8 + c]);
  }
  const corners = { 0: [1, 8, 9], 7: [6, 15, 14], 56: [57, 48, 49], 63: [62, 55, 54] };
  function reference(board, player, full) {
    if (modelOver(board)) return margin(board, player) * 10000;
    const weights = TABLE.slice();
    if (full) {
      for (const [corner, around] of Object.entries(corners)) {
        if (board[corner] !== EMPTY) for (const i of around) weights[i] = 5;
      }
    }
    let score = 0;
    board.forEach((v, i) => { if (v === player) score += weights[i]; else if (v !== EMPTY) score -= weights[i]; });
    if (full) score += 8 * (modelMoves(board, player).length - modelMoves(board, other(player)).length);
    return score;
  }
  let cornersSeen = 0;
  for (const seed of [2, 5, 9]) {
    for (const { board } of randomGame(seed)) {
      if (board[0] || board[7] || board[56] || board[63]) cornersSeen++;
      for (const p of [ONE, ZERO]) {
        for (const full of [false, true]) {
          assert.equal(ffl.fflEvaluate(board, p, full), reference(board, p, full));
          assert.equal(Math.abs(ffl.fflEvaluate(board, p, full) + ffl.fflEvaluate(board, other(p), full)), 0, 'zero-sum');
        }
      }
    }
  }
  assert.ok(cornersSeen > 20);
  assert.equal(ffl.fflWeights(fromText(START), false), ffl.fflWeightTable);
  const taken = fromText(START);
  taken[63] = ZERO;
  assert.deepEqual([62, 55, 54].map((i) => ffl.fflWeights(taken, true)[i]), [5, 5, 5]);
  assert.equal(ffl.fflWeights(taken, true)[1], -20);
  const won = finale(ONE, 40);
  won[63] = ONE;
  won[62] = ONE;
  assert.equal(ffl.fflEvaluate(won, ONE, true), 160000);
  assert.equal(ffl.fflEvaluate(won, ZERO, false), -160000);
});

test('flip-flop: alpha-beta gives exactly the minimax value, with cut-offs, passes and finished lines, in fewer positions', () => {
  const ffl = loadScript(SCRIPT);
  let cutoffs = 0;
  let checked = 0;
  for (const seed of [4, 7]) {
    const game = randomGame(seed);
    for (let at = 6; at < game.length; at += 11) {
      const { board, player } = game[at];
      for (const full of [false, true]) {
        for (const depth of [1, 2, 3]) {
          for (const ordered of [false, true]) {
            const ctx = { nodes: 0, cap: Infinity, full, ordered, aborted: false, cutoffs: 0 };
            assert.equal(ffl.fflSearch(board, player, depth, -Infinity, Infinity, ctx), minimax(ffl, board, player, depth, full), seed + '/' + at + '/' + depth);
            assert.equal(ctx.aborted, false);
            cutoffs += ctx.cutoffs;
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked >= 36);
  assert.ok(cutoffs > 50, cutoffs + ' cut-offs');
  // A side with no move passes without using a ply; nobody moving is the end.
  const pass = ffl.fflApplyMove(fromText(PASS_FOR_ZERO), ONE, 63).board;
  const ctx = { nodes: 0, cap: Infinity, full: true, ordered: true, aborted: false, cutoffs: 0 };
  assert.equal(ffl.fflSearch(pass, ZERO, 1, -Infinity, Infinity, ctx), -exact(pass, ONE) * 10000);
  assert.equal(ctx.nodes, 3, 'the pass, the 1 at 0x00 and the finished board');
  const end = modelPlay(pass, ONE, 0);
  assert.equal(ffl.fflSearch(end, ZERO, 4, -Infinity, Infinity, ctx), margin(end, ZERO) * 10000);
  // The cap stops the search: aborted, and the node count stays at the cap.
  const capped = { nodes: 0, cap: 5, full: false, ordered: false, aborted: false, cutoffs: 0 };
  assert.equal(ffl.fflSearch(fromText(START), ONE, 4, -Infinity, Infinity, capped), 0);
  assert.equal(capped.aborted, true);
  assert.equal(capped.nodes, 5);
});

test('flip-flop: Easy draws a legal move weighted by the bits it flips; ordering and shuffling are fair and stable', () => {
  const ffl = loadScript(SCRIPT);
  const moves = [{ index: 3, flips: [1] }, { index: 9, flips: [1, 2, 3] }, { index: 20, flips: [4, 5] }];
  const pick = (r) => ffl.fflPickWeighted(moves, () => r).index;
  // Buckets of 1, 3 and 2 of 6.
  assert.equal(pick(0), 3);
  assert.equal(pick(0.16), 3);
  assert.equal(pick(1 / 6 + 1e-9), 9);
  assert.equal(pick(0.66), 9);
  assert.equal(pick(4 / 6 + 1e-9), 20);
  assert.equal(pick(0.9999999), 20);
  const tally = { 3: 0, 9: 0, 20: 0 };
  const rnd = seeded(11);
  for (let i = 0; i < 6000; i++) tally[ffl.fflPickWeighted(moves, rnd).index]++;
  assert.ok(Math.abs(tally[3] - 1000) < 120 && Math.abs(tally[9] - 3000) < 150 && Math.abs(tally[20] - 2000) < 150, JSON.stringify(tally));

  // Ordering: the chosen first move, then corners, then by weight; ties keep their order.
  const list = [19, 0, 9, 26, 7, 2].map((index) => ({ index, flips: [] }));
  assert.deepEqual(ffl.fflOrderMoves(list, -1).map((m) => m.index), [0, 7, 2, 19, 26, 9]);
  assert.deepEqual(ffl.fflOrderMoves(list, 9).map((m) => m.index), [9, 0, 7, 2, 19, 26]);
  // Fisher-Yates: every order of three items about equally often.
  const orders = {};
  const shuffleRnd = seeded(5);
  for (let i = 0; i < 6000; i++) {
    const key = ffl.fflShuffle(['a', 'b', 'c'], shuffleRnd).join('');
    orders[key] = (orders[key] || 0) + 1;
  }
  assert.equal(Object.keys(orders).length, 6);
  for (const count of Object.values(orders)) assert.ok(Math.abs(count - 1000) < 120, JSON.stringify(orders));
  const original = ['a', 'b'];
  ffl.fflShuffle(original, () => 0);
  assert.deepEqual(original, ['a', 'b'], 'a copy is shuffled');
});

test('flip-flop: the computer passes when it has no move, plays a forced move without searching, and Easy uses Math.random', () => {
  const ffl = loadScript(SCRIPT);
  const pass = ffl.fflApplyMove(fromText(PASS_FOR_ZERO), ONE, 63).board;
  assert.deepEqual(ffl.fflChooseMove(pass, ZERO, 'hard', Math.random, 0), { move: -1, depth: 0, nodes: 0, capped: false, cutoffs: 0 });
  const forced = fromText(PASS_FOR_ONE);
  for (const level of ['easy', 'normal', 'hard']) {
    assert.deepEqual(ffl.fflChooseMove(forced, ZERO, level, () => { throw new Error('no draw'); }, 0), { move: 63, depth: 0, nodes: 0, capped: false, cutoffs: 0 });
  }
  const start = fromText(START);
  assert.equal(ffl.fflChooseMove(start, ONE, 'easy', () => 0, 0).move, 19);
  assert.equal(ffl.fflChooseMove(start, ONE, 'easy', () => 0.99, 0).move, 44);
  assert.equal(ffl.fflChooseMove(start, ZERO, 'easy', () => 0.3, 0).move, 29);
});

test('flip-flop: Normal plays the best move 2 plies deep on cell weights; equal moves vary with Math.random', () => {
  const ffl = loadScript(SCRIPT);
  for (const seed of [3, 8]) {
    const game = randomGame(seed);
    for (let at = 4; at < game.length; at += 7) {
      const { board, player } = game[at];
      const moves = modelMoves(board, player);
      if (moves.length < 2) continue;
      const result = ffl.fflChooseMove(board, player, 'normal', seeded(at), 0);
      assert.equal(result.depth, 2);
      assert.equal(result.capped, false);
      const value = (m) => -minimax(ffl, modelPlay(board, player, m), other(player), 1, false);
      assert.equal(value(result.move), Math.max(...moves.map(value)), seed + '/' + at);
      // An unknown level searches like Normal.
      assert.equal(ffl.fflChooseMove(board, player, 'pvp', seeded(at), 0).move, result.move);
    }
  }
  // At the start all four moves are worth the same: the shuffle decides.
  const seen = new Set();
  for (let s = 1; s <= 20; s++) seen.add(ffl.fflChooseMove(fromText(START), ONE, 'normal', seeded(s), 0).move);
  assert.deepEqual([...seen].sort((a, b) => a - b), [19, 26, 37, 44]);
});

test('flip-flop: Hard plays the endgame perfectly, finds the 5-ply best move and keeps its search under the node cap', () => {
  const ffl = loadScript(SCRIPT);
  // Ten or fewer empty cells: the search runs to the end of the game.
  let solved = 0;
  for (const seed of [1, 2, 6, 10, 13]) {
    const game = randomGame(seed);
    const spot = game.find(({ board, player }) => board.filter((v) => v === EMPTY).length === 7 && modelMoves(board, player).length > 1);
    if (!spot) continue;
    const { board, player } = spot;
    const result = ffl.fflChooseMove(board, player, 'hard', seeded(seed), 0);
    assert.equal(result.capped, false);
    assert.equal(result.depth, 7);
    const best = exact(board, player);
    assert.equal(-exact(modelPlay(board, player, result.move), other(player)), best, 'seed ' + seed);
    solved++;
  }
  assert.ok(solved >= 4);
  // Late middle game (14 empty cells): the 5-ply choice is the minimax best.
  const late = randomGame(32)[46];
  assert.equal(late.board.filter((v) => v === EMPTY).length, 14);
  const lateMoves = modelMoves(late.board, late.player);
  assert.equal(lateMoves.length, 4);
  const pick = ffl.fflChooseMove(late.board, late.player, 'hard', seeded(32), 0);
  assert.deepEqual([pick.depth, pick.capped], [5, false]);
  const worth = (m) => -minimax(ffl, modelPlay(late.board, late.player, m), other(late.player), 4, true);
  assert.equal(worth(pick.move), Math.max(...lateMoves.map(worth)));
  // Middle game: 5 plies, with alpha-beta cut-offs, under the cap.
  const mid = randomGame(21)[14];
  const deep = ffl.fflChooseMove(mid.board, mid.player, 'hard', seeded(2), 0);
  assert.ok(deep.depth >= 4 && deep.depth <= 5, 'depth ' + deep.depth);
  assert.ok(deep.nodes <= ffl.fflLevels.hard.cap);
  assert.ok(deep.cutoffs > 0);
  assert.deepEqual(ffl.fflLevels, {
    normal: { depth: 2, endgame: 0, full: false, ordered: false, cap: 20000 },
    hard: { depth: 5, endgame: 10, full: true, ordered: true, cap: 30000 }
  });
});

test('flip-flop: when the node cap stops Hard, it plays the best move of the last depth it finished', () => {
  const ffl = loadScript(SCRIPT);
  const { board, player } = randomGame(17)[12];
  const moves = modelMoves(board, player);
  assert.ok(moves.length >= 4);
  const result = ffl.fflChooseMove(board, player, 'hard', seeded(4), 300);
  assert.equal(result.capped, true);
  assert.ok(result.nodes <= 300);
  assert.ok(result.depth >= 1 && result.depth <= 3, 'depth ' + result.depth);
  const value = (m) => -minimax(ffl, modelPlay(board, player, m), other(player), result.depth - 1, true);
  assert.equal(value(result.move), Math.max(...moves.map(value)));
  // A cap too small for even 1 ply: Hard's best-ordered move, Normal's first shuffled one.
  const tiny = ffl.fflChooseMove(fromText(CAPPED), ZERO, 'hard', seeded(1), 3);
  assert.deepEqual([tiny.depth, tiny.capped, tiny.nodes], [0, true, 3]);
  const capMoves = modelMoves(fromText(CAPPED), ZERO);
  const topWeight = Math.max(...capMoves.map((m) => ffl.fflWeightTable[m]));
  assert.equal(ffl.fflWeightTable[tiny.move], topWeight);
  const normal = ffl.fflChooseMove(fromText(START), ONE, 'normal', () => 0, 2);
  assert.deepEqual([normal.move, normal.depth, normal.capped], [26, 0, true]);
  // Ten empty cells: the full search needs more than the cap, so it is cut.
  const full = ffl.fflChooseMove(fromText(CAPPED), ZERO, 'hard', seeded(1), 0);
  assert.equal(full.capped, true);
  assert.equal(full.nodes, 30000);
  assert.ok(capMoves.includes(full.move));
});

test('flip-flop: the levels are ordered: Hard beats Normal, Normal beats Easy on either side, and no move passes the node cap', () => {
  const ffl = loadScript(SCRIPT);
  function play(levelOne, levelZero, seed) {
    const rnd = seeded(seed);
    let board = ffl.fflNewBoard();
    let turn = ONE;
    for (;;) {
      const pick = ffl.fflChooseMove(board, turn, turn === ONE ? levelOne : levelZero, rnd, 0);
      assert.ok(pick.nodes <= 30000);
      board = ffl.fflApplyMove(board, turn, pick.move).board;
      const next = ffl.fflNextTurn(board, turn);
      if (next.over) return ffl.fflWinner(board);
      turn = next.turn;
    }
  }
  // One Hard game (a full game of Hard is slow under coverage), on the side
  // that moves second.
  assert.equal(play('normal', 'hard', 2), ZERO);
  for (const seed of [1, 2, 3]) {
    assert.equal(play('normal', 'easy', seed), ONE);
    assert.equal(play('easy', 'normal', seed + 10), ZERO);
  }
});

// ── Saves and text ───────────────────────────────────────────────────────────

test('flip-flop: parsing a save keeps a good one and falls back field by field', () => {
  const ffl = loadScript(SCRIPT);
  const fresh = { board: fromText(START), turn: ONE, mode: 'normal', history: [], hint: true, last: -1 };
  const after = modelPlay(modelPlay(fromText(START), ONE, 19), ZERO, 18);
  const good = save({ board: toText(after), history: [START + '1'], last: 18, hint: false, mode: 'hard' });
  assert.deepEqual(ffl.fflParseState(JSON.stringify(good)), { board: after, turn: ONE, mode: 'hard', history: [START + '1'], hint: false, last: 18 });

  const parse = (fields) => ffl.fflParseState(JSON.stringify(save(fields)));
  for (const mode of ['easy', 'normal', 'hard', 'pvp']) assert.equal(parse({ mode }).mode, mode);
  for (const mode of ['insane', 'toString', 3, null]) assert.equal(parse({ mode }).mode, 'normal');
  assert.equal(parse({ hint: 'no' }).hint, true);
  assert.equal(parse({ hint: false }).hint, false);
  for (const last of [-1, 64, 1.5, '19', 0, null]) assert.equal(parse({ last }).last, -1, String(last));
  assert.equal(parse({ last: 27 }).last, 27);
  assert.deepEqual(parse({ history: ['bad', START + '1', 7, START + '2', START + '0'] }).history, [START + '1', START + '0']);
  assert.deepEqual(parse({ history: 'x' }).history, []);
  const long = Array.from({ length: 70 }, (_, i) => START + (i % 2 ? '0' : '1'));
  assert.equal(parse({ history: long }).history.length, 60);
  // The turn follows the board: a side without a move passes.
  assert.equal(parse({ turn: 2 }).turn, ZERO);
  assert.equal(parse({ turn: 7 }).turn, ONE);
  const pass = ffl.fflBoardToString(ffl.fflApplyMove(fromText(PASS_FOR_ZERO), ONE, 63).board);
  assert.equal(parse({ board: pass, turn: 2 }).turn, ONE);
  const onePasses = ffl.fflBoardToString(modelPlay(fromText(PASS_FOR_ONE), ZERO, 63));
  assert.equal(parse({ board: onePasses, turn: 1 }).turn, ZERO);

  // A board that cannot be a game gives a new one, keeping mode and hint.
  for (const board of [undefined, '', START.slice(2), START.replace('1', 'x'), '.'.repeat(64), '...'.repeat(21) + '1', 42]) {
    assert.deepEqual(parse({ board, mode: 'pvp', hint: false }), { ...fresh, mode: 'pvp', hint: false }, JSON.stringify(board));
  }
  for (const text of [null, undefined, '', '{', 'null', '42', '"x"', 'true', '[]']) {
    assert.deepEqual(ffl.fflParseState(text), fresh, String(text));
  }
});

test('flip-flop: parsing stats keeps whole counts per level and zeroes anything else', () => {
  const ffl = loadScript(SCRIPT);
  assert.deepEqual(ffl.fflParseStats(null), NO_STATS);
  const good = { easy: { wins: 3, losses: 1, draws: 0 }, normal: { wins: 0, losses: 2, draws: 1 }, hard: { wins: 1, losses: 9, draws: 2 } };
  assert.deepEqual(ffl.fflParseStats(JSON.stringify(good)), good);
  assert.deepEqual(ffl.fflParseStats('{"normal":{"wins":"3","losses":-1,"draws":2.5},"hard":{"wins":4},"easy":7}'), {
    ...NO_STATS, hard: { wins: 4, losses: 0, draws: 0 }
  });
  assert.deepEqual(ffl.fflParseStats('{"normal":{"wins":1e999}}'), NO_STATS);
  for (const text of ['', '{', '[]', '"x"', '42', '{"easy":null}']) assert.deepEqual(ffl.fflParseStats(text), NO_STATS, text);
});

test('flip-flop: status and result lines name the side to move, the legal moves and the score', () => {
  const ffl = loadScript(SCRIPT);
  const state = (fields) => ({ board: fromText(START), turn: ONE, mode: 'normal', history: [], hint: true, last: -1, ...fields });
  assert.equal(ffl.fflStatusText(state()), 'Your move: write a 1 (4 legal moves).');
  assert.equal(ffl.fflStatusText(state({ turn: ZERO, mode: 'hard' })), 'CPU Hard is thinking…');
  assert.equal(ffl.fflStatusText(state({ turn: ZERO, mode: 'pvp' })), 'Player 2 to move: write a 0 (4 legal moves).');
  assert.equal(ffl.fflStatusText(state({ mode: 'pvp' })), 'Player 1 to move: write a 1 (4 legal moves).');
  assert.equal(ffl.fflStatusText(state({ board: fromText(PASS_FOR_ONE), turn: ZERO, mode: 'pvp' })), 'Player 2 to move: write a 0 (1 legal move).');
  const full = (mover, bits) => {
    const b = finale(mover, bits);
    return modelPlay(b, mover, 63);
  };
  assert.equal(ffl.fflStatusText(state({ board: full(ONE, 40) })), 'Game over: you win 40 to 24 (1s ahead by 16).');
  assert.equal(ffl.fflStatusText(state({ board: full(ZERO, 40), mode: 'easy' })), 'Game over: CPU Easy wins 40 to 24 (0s ahead by 16).');
  assert.equal(ffl.fflStatusText(state({ board: full(ONE, 32) })), 'Game over: draw, 32 to 32.');
  assert.equal(ffl.fflResultText(full(ONE, 33), 'pvp'), 'Player 1 wins 33 to 31 (1s ahead by 2)');
  assert.equal(ffl.fflResultText(full(ZERO, 50), 'pvp'), 'Player 2 wins 50 to 14 (0s ahead by 36)');
});

test('flip-flop: U and N by key value, and by physical key only on layouts that type no Latin letter there', () => {
  const ffl = loadScript(SCRIPT);
  const action = (key, code) => ffl.fflKeyAction({ key, code });
  assert.equal(action('u', 'KeyU'), 'undo');
  assert.equal(action('U', 'KeyU'), 'undo');
  assert.equal(action('n', 'KeyN'), 'new');
  assert.equal(action('N', 'KeyB'), 'new');
  assert.equal(action('г', 'KeyU'), 'undo'); // Ukrainian layout
  assert.equal(action('т', 'KeyN'), 'new');
  assert.equal(action('b', 'KeyN'), null); // Dvorak: that key types b
  assert.equal(action('x', 'KeyX'), null);
  assert.equal(action('Enter', 'Enter'), null);
  assert.equal(action(undefined, 'KeyU'), 'undo');
  assert.equal(action(undefined, undefined), null);
});

// ── The page ─────────────────────────────────────────────────────────────────

test('flip-flop: loading the script under Node runs no init: no lookup, listener, timer or save', (t) => {
  const timeouts = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const ffl = loadScript(SCRIPT);
  assert.equal(typeof ffl.fflInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['ffl-board'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(listenerCount(page.els['ffl-game']), 0);
  assert.equal(timeouts.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('flip-flop: a first visit draws the start position, the scores, the dump and the record, and saves it', (t) => {
  const page = openPage(t);
  assert.equal(page.cells().length, 64);
  for (const cell of page.cells()) {
    assert.equal(cell.tagName, 'BUTTON');
    assert.equal(cell.type, 'button');
  }
  assert.equal(page.glyphs(), START);
  assert.equal(page.cell(28).textContent, '1');
  assert.equal(page.cell(27).textContent, '0');
  assert.equal(page.cell(0).textContent, '');
  assert.deepEqual(page.legal(), [19, 26, 37, 44]);
  assert.equal(page.cell(19).textContent, '+1');
  assert.equal(page.cell(19).getAttribute('aria-label'), '0x13, row 3 column 4: empty, legal move, flips 1');
  assert.equal(page.cell(28).getAttribute('aria-label'), '0x1C, row 4 column 5: 1');
  assert.equal(page.cell(0).getAttribute('aria-label'), '0x00, row 1 column 1: empty');
  assert.deepEqual(page.cells().map((c) => c.getAttribute('tabindex')).filter((v) => v === '0').length, 1);
  assert.equal(page.cell(19).getAttribute('tabindex'), '0');
  assert.equal(page.text('ffl-name-one'), '1s · You');
  assert.equal(page.text('ffl-name-zero'), '0s · CPU Normal');
  assert.equal(page.text('ffl-count-one'), '2');
  assert.equal(page.text('ffl-count-zero'), '2');
  assert.equal(page.text('ffl-mask-one'), 'popcnt(0x0000000810000000)');
  assert.equal(page.text('ffl-mask-zero'), 'popcnt(0x0000001008000000)');
  assert.equal(page.els['ffl-side-one'].className, 'ffl-side ffl-side--one ffl-side--active');
  assert.equal(page.els['ffl-side-zero'].className, 'ffl-side ffl-side--zero');
  assert.equal(page.text('ffl-moves'), 'Moves played: 0 · free cells: 60');
  assert.equal(page.status(), 'Your move: write a 1 (4 legal moves).');
  assert.equal(page.log(), '> ready: 1s (You) vs 0s (CPU Normal). 1s move first.');
  assert.equal(page.els['ffl-warning'].hidden, true);
  assert.equal(page.els['ffl-mode'].value, 'normal');
  assert.equal(page.els['ffl-undo'].disabled, true);
  assert.equal(page.text('ffl-hint'), 'XOR hint: on');
  assert.equal(page.els['ffl-hint'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.text('ffl-stat-normal'), 'Normal: W 0 · L 0 · D 0');
  assert.equal(page.els['ffl-stat-normal'].className, 'ffl-stat ffl-stat--current');
  assert.equal(page.els['ffl-stat-easy'].className, 'ffl-stat');
  // The dump: one line per row with its address, bits and the hex of each side.
  const rows = page.els['ffl-dump'].children;
  assert.equal(rows.length, 8);
  const line = (r) => rows[r].children.map((span) => span.textContent);
  assert.deepEqual(line(0), ['0x00', '........', '0x00', '0x00']);
  assert.deepEqual(line(3), ['0x18', '...01...', '0x08', '0x10']);
  assert.deepEqual(line(4), ['0x20', '...10...', '0x10', '0x08']);
  assert.deepEqual(rows[3].children[1].children.map((b) => b.className.split(' ').pop()), [
    'ffl-bit--empty', 'ffl-bit--empty', 'ffl-bit--empty', 'ffl-bit--zero', 'ffl-bit--one', 'ffl-bit--empty', 'ffl-bit--empty', 'ffl-bit--empty'
  ]);
  // Saved at once, in the save format.
  assert.deepEqual(page.saved(), save({}));
  assert.deepEqual(Object.keys(page.saved()), SAVE_FIELDS);
  assert.equal(localStorage.getItem(STATS_KEY), null);
  // Listeners: once each, on the game's own elements; nothing on the host page.
  assert.equal(listenerCount(page.board, 'click'), 1);
  assert.equal(listenerCount(page.board, 'mouseover'), 1);
  assert.equal(listenerCount(page.board, 'mouseleave'), 1);
  assert.equal(listenerCount(page.board, 'focusin'), 1);
  assert.equal(listenerCount(page.els['ffl-game'], 'keydown'), 1);
  for (const id of ['ffl-new-game', 'ffl-undo', 'ffl-hint']) assert.equal(listenerCount(page.els[id], 'click'), 1, id);
  assert.equal(listenerCount(page.els['ffl-mode'], 'change'), 1);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(listenerCount(document.body), 0);
  t.mock.timers.tick(10000);
  assert.equal(page.glyphs(), START, 'the computer never opens');
});

test('flip-flop: with the script in the page head the game waits for DOMContentLoaded, and init runs only once', (t) => {
  const page = openPage(t, { state: save({ board: toText(modelPlay(fromText(START), ONE, 19)), turn: 2 }) }, { readyState: 'loading' });
  assert.equal(page.cells().length, 0);
  assert.equal(page.status(), 'Loading the board...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  page.ready();
  assert.equal(page.cells().length, 64);
  assert.equal(page.status(), 'CPU Normal is thinking…');

  resetStubs();
  const module = openModule(t);
  module.ffl.fflInit();
  assert.equal(module.cells().length, 64);
  assert.equal(listenerCount(module.board, 'click'), 1);
  assert.equal(listenerCount(module.els['ffl-game'], 'keydown'), 1);
  assert.equal(module.els['ffl-dump'].children.length, 8);
});

test('flip-flop: a move writes the bit and flips the trapped ones; the computer answers after its delay while input is ignored', (t) => {
  t.mock.method(Math, 'random', seeded(3));
  const page = openPage(t);
  page.click(19);
  const afterMove = toText(modelPlay(fromText(START), ONE, 19));
  assert.equal(page.glyphs(), afterMove);
  assert.equal(page.log(), '> You wrote a 1 at 0x13, flipping 1 bit.');
  assert.deepEqual(page.marked('ffl-cell--last'), [19]);
  assert.deepEqual(page.marked('ffl-cell--flip-a'), [27]);
  assert.equal(page.status(), 'CPU Normal is thinking…');
  assert.equal(page.els['ffl-status'].className, 'ffl-status ffl-status--thinking');
  assert.equal(page.board.className, 'ffl-board ffl-board--thinking ffl-board--zero-turn');
  assert.equal(page.els['ffl-side-zero'].className, 'ffl-side ffl-side--zero ffl-side--active');
  assert.deepEqual(page.legal(), [], 'no hints for the computer');
  assert.equal(page.els['ffl-undo'].disabled, true);
  assert.deepEqual(page.saved(), save({ board: afterMove, turn: 2, history: [START + '1'], last: 19 }));
  // Clicks and keys on the board are ignored while it thinks.
  page.click(26);
  pressKey('Enter', { target: page.cell(26) });
  assert.equal(page.glyphs(), afterMove);

  t.mock.timers.tick(CPU_DELAY - 1);
  assert.equal(page.glyphs(), afterMove);
  t.mock.timers.tick(1);
  const after = page.glyphs();
  const at = newBit(afterMove, after, '0');
  assert.ok([18, 20, 34].includes(at));
  assert.equal(after, toText(modelPlay(fromText(afterMove), ZERO, at)));
  assert.match(page.log(), new RegExp('^> CPU Normal wrote a 0 at ' + hex(at) + ', flipping 1 bit \\(depth 2, \\d+ positions searched\\)\\.$'));
  assert.deepEqual(page.marked('ffl-cell--flip-b').length, 1);
  assert.deepEqual(page.marked('ffl-cell--last'), [at]);
  assert.equal(page.board.className, 'ffl-board');
  assert.equal(page.status(), 'Your move: write a 1 (' + modelMoves(fromText(after), ONE).length + ' legal moves).');
  assert.deepEqual(page.legal(), modelMoves(fromText(after), ONE));
  assert.equal(page.els['ffl-undo'].disabled, false);
  assert.equal(page.text('ffl-moves'), 'Moves played: 2 · free cells: 58');
  assert.deepEqual(page.saved(), save({ board: after, turn: 1, history: [START + '1'], last: at }));
  t.mock.timers.tick(5000);
  assert.equal(page.glyphs(), after, 'one answer per move');
});

test('flip-flop: an illegal or taken cell is refused with its address, and nothing changes', (t) => {
  const page = openPage(t);
  const before = localStorage.getItem(STATE_KEY);
  page.click(0);
  assert.equal(page.log(), '> 0x00 refused: a 1 there flips no bits.');
  page.click(28);
  assert.equal(page.log(), '> 0x1C refused: the cell already holds a 1.');
  page.click(27);
  assert.equal(page.log(), '> 0x1B refused: the cell already holds a 0.');
  assert.equal(page.glyphs(), START);
  assert.equal(localStorage.getItem(STATE_KEY), before);
  // A click on the board's padding is no cell at all.
  page.board.click();
  assert.equal(page.log(), '> 0x1B refused: the cell already holds a 0.');
});

test('flip-flop: Undo takes back your move and the reply, step by step, and refuses with a reason when it cannot', (t) => {
  t.mock.method(Math, 'random', seeded(9));
  const page = openPage(t);
  pressKey('u', { target: page.els['ffl-new-game'] });
  assert.equal(page.log(), '> nothing to undo: no move of yours yet.');
  page.click(19);
  pressKey('u', { target: page.els['ffl-new-game'] });
  assert.equal(page.log(), '> undo waits: CPU Normal is thinking.');
  t.mock.timers.tick(CPU_DELAY);
  const two = page.glyphs();
  const legal = page.legal();
  page.click(legal[0]);
  t.mock.timers.tick(CPU_DELAY);
  assert.equal(page.saved().history.length, 2);
  page.undo();
  assert.equal(page.glyphs(), two);
  assert.equal(page.log(), '> undo: back to 2 moves played.');
  assert.deepEqual(page.marked('ffl-cell--last'), []);
  assert.deepEqual(page.saved().history, [START + '1']);
  pressKey('U', { target: page.cell(3), shiftKey: true });
  assert.equal(page.glyphs(), START);
  assert.equal(page.log(), '> undo: back to 0 moves played.');
  assert.equal(page.els['ffl-undo'].disabled, true);
  assert.deepEqual(page.saved(), save({}));
  t.mock.timers.tick(5000);
  assert.equal(page.glyphs(), START, 'undo back to your move starts no computer move');
});

test('flip-flop: a disabled Undo hands the focus to the board cursor', (t) => {
  t.mock.method(Math, 'random', seeded(2));
  const page = openPage(t);
  page.click(26);
  t.mock.timers.tick(CPU_DELAY);
  focusElement(page.els['ffl-undo'], { keyboard: true });
  pressKey('Enter');
  assert.equal(page.els['ffl-undo'].disabled, true);
  assert.equal(document.activeElement, page.cell(26));
  assert.equal(page.cell(26).getAttribute('tabindex'), '0');
});

test('flip-flop: two players on one device alternate 1s and 0s, and Undo takes back one move', (t) => {
  const page = openPage(t, { state: save({ mode: 'pvp' }) });
  assert.equal(page.text('ffl-name-one'), '1s · Player 1');
  assert.equal(page.text('ffl-name-zero'), '0s · Player 2');
  assert.equal(page.status(), 'Player 1 to move: write a 1 (4 legal moves).');
  page.click(37);
  assert.equal(page.status(), 'Player 2 to move: write a 0 (3 legal moves).');
  assert.equal(page.board.className, 'ffl-board ffl-board--zero-turn');
  assert.deepEqual(page.legal(), modelMoves(modelPlay(fromText(START), ONE, 37), ZERO));
  assert.equal(page.log(), '> Player 1 wrote a 1 at 0x25, flipping 1 bit.');
  t.mock.timers.tick(5000);
  assert.equal(page.status(), 'Player 2 to move: write a 0 (3 legal moves).', 'no computer');
  const zero = page.legal()[0];
  page.click(zero);
  assert.match(page.log(), /^> Player 2 wrote a 0 at 0x/);
  assert.equal(page.saved().history.length, 2);
  page.undo();
  assert.equal(page.status(), 'Player 2 to move: write a 0 (3 legal moves).');
  assert.equal(page.saved().turn, 2);
  page.undo();
  assert.equal(page.glyphs(), START);
  // Hot-seat games are not counted.
  assert.equal(page.text('ffl-stat-normal'), 'Normal: W 0 · L 0 · D 0');
  assert.equal(page.els['ffl-stat-normal'].className, 'ffl-stat');
});

test('flip-flop: a side without a legal move passes with a toast naming it, and the other side moves again', (t) => {
  // The computer passes: you move again.
  let page = openPage(t, { state: save({ board: PASS_FOR_ZERO }) });
  page.click(63);
  assert.equal(page.toast(), 'No legal move for CPU Normal (0s): pass, your move again.');
  assert.equal(page.toastVisible(), true);
  assert.equal(page.status(), 'Your move: write a 1 (1 legal move).');
  assert.deepEqual(page.legal(), [0]);
  t.mock.timers.tick(CPU_DELAY);
  assert.equal(page.saved().turn, 1);

  // You pass: the computer moves twice in a row.
  resetStubs();
  page = openPage(t, { state: save({ board: PASS_FOR_ONE, turn: 2 }) });
  assert.equal(page.status(), 'CPU Normal is thinking…');
  t.mock.timers.tick(CPU_DELAY);
  assert.equal(page.toast(), 'No legal move for you (1s): pass, CPU Normal moves again.');
  assert.equal(page.status(), 'CPU Normal is thinking…');
  assert.equal(page.log(), '> CPU Normal wrote a 0 at 0x3F, flipping ' + bits(modelFlips(fromText(PASS_FOR_ONE), ZERO, 63).length) + '.');
  t.mock.timers.tick(CPU_DELAY);
  assert.equal(page.log(), '> CPU Normal wrote a 0 at 0x00, flipping ' + bits(modelFlips(modelPlay(fromText(PASS_FOR_ONE), ZERO, 63), ZERO, 0).length) + '.');
  assert.match(page.status(), /^Game over: /);

  // Two players: Player 2 passes.
  resetStubs();
  page = openPage(t, { state: save({ board: PASS_FOR_ZERO, mode: 'pvp' }) });
  page.click(63);
  assert.equal(page.toast(), 'No legal move for Player 2 (0s): pass, Player 1 moves again.');
});

test('flip-flop: the end of the game shows the result, counts it once per level and locks the board', (t) => {
  const page = openPage(t, { state: save({ board: toText(finale(ONE, 40)), mode: 'hard' }), stats: { hard: { wins: 2, losses: 5, draws: 1 } } });
  assert.equal(page.status(), 'Your move: write a 1 (1 legal move).');
  page.click(63);
  assert.equal(page.status(), 'Game over: you win 40 to 24 (1s ahead by 16).');
  assert.equal(page.toast(), 'Game over: you win 40 to 24 (1s ahead by 16).');
  assert.equal(page.els['ffl-side-one'].className, 'ffl-side ffl-side--one ffl-side--winner');
  assert.equal(page.els['ffl-side-zero'].className, 'ffl-side ffl-side--zero');
  assert.equal(page.board.className, 'ffl-board ffl-board--over');
  assert.deepEqual(page.stats(), { ...NO_STATS, hard: { wins: 3, losses: 5, draws: 1 } });
  assert.equal(page.text('ffl-stat-hard'), 'Hard: W 3 · L 5 · D 1');
  assert.equal(page.els['ffl-undo'].disabled, true);
  pressKey('u', { target: page.cell(10) });
  assert.equal(page.log(), '> undo is off: the game is over and its result is counted.');
  page.click(0);
  assert.equal(page.log(), '> undo is off: the game is over and its result is counted.', 'clicks do nothing');
  // A reload shows the result again and counts nothing twice.
  const again = reload(t, page);
  assert.equal(again.status(), 'Game over: you win 40 to 24 (1s ahead by 16).');
  assert.equal(again.text('ffl-stat-hard'), 'Hard: W 3 · L 5 · D 1');
  assert.deepEqual(again.stats(), { ...NO_STATS, hard: { wins: 3, losses: 5, draws: 1 } });
  // A finished game needs no confirmation for a new one, and a mode change starts it at once.
  again.choose('easy');
  assert.equal(again.glyphs(), START);
  assert.equal(again.log(), '> new game: 1s (You) vs 0s (CPU Easy). 1s move first.');
  assert.equal(again.els['ffl-stat-easy'].className, 'ffl-stat ffl-stat--current');
});

test('flip-flop: losses and draws are counted for their level, the computer\'s last move included; hot-seat results are not', (t) => {
  let page = openPage(t, { state: save({ board: toText(finale(ZERO, 40)), turn: 2, mode: 'easy' }) });
  t.mock.timers.tick(CPU_DELAY);
  assert.equal(page.status(), 'Game over: CPU Easy wins 40 to 24 (0s ahead by 16).');
  assert.equal(page.log(), '> CPU Easy wrote a 0 at 0x3F, flipping 1 bit.');
  assert.deepEqual(page.stats(), { ...NO_STATS, easy: { wins: 0, losses: 1, draws: 0 } });

  resetStubs();
  page = openPage(t, { state: save({ board: toText(finale(ONE, 32)), mode: 'normal' }) });
  page.click(63);
  assert.equal(page.status(), 'Game over: draw, 32 to 32.');
  assert.deepEqual(page.stats(), { ...NO_STATS, normal: { wins: 0, losses: 0, draws: 1 } });
  assert.equal(page.els['ffl-side-one'].className, 'ffl-side ffl-side--one');

  resetStubs();
  page = openPage(t, { state: save({ board: toText(finale(ONE, 50)), mode: 'pvp' }) });
  page.click(63);
  assert.equal(page.status(), 'Game over: Player 1 wins 50 to 14 (1s ahead by 36).');
  assert.equal(localStorage.getItem(STATS_KEY), null);
});

test('flip-flop: New Game in the middle of a game asks for a second press within 3 s; N does the same', (t) => {
  t.mock.method(Math, 'random', seeded(4));
  const page = openPage(t);
  page.newGame();
  assert.equal(page.log(), '> new game: 1s (You) vs 0s (CPU Normal). 1s move first.', 'no moves yet: at once');
  page.click(44);
  t.mock.timers.tick(CPU_DELAY);
  const game = page.glyphs();
  // Screen readers hear the button's new name and the prompt in the log (a status region).
  assert.match(HTML, /<div id="ffl-log" class="ffl-log" role="status"><\/div>/);
  const label = () => page.els['ffl-new-game'].getAttribute('aria-label');
  assert.equal(label(), 'Start a new game');
  page.newGame();
  assert.equal(page.glyphs(), game);
  assert.equal(page.text('ffl-new-game'), 'Confirm New Game');
  assert.equal(label(), 'Confirm: abandon this game and start a new one');
  assert.equal(page.els['ffl-new-game'].className, 'ffl-btn ffl-btn--confirm');
  assert.equal(page.log(), '> press New Game (or N) again within 3 s to abandon this game: 2 moves played vs CPU Normal.');
  t.mock.timers.tick(CONFIRM_MS - 1);
  assert.equal(page.text('ffl-new-game'), 'Confirm New Game');
  t.mock.timers.tick(1);
  assert.equal(page.text('ffl-new-game'), 'New Game');
  assert.equal(label(), 'Start a new game');
  assert.equal(page.log(), '> new game cancelled: this game goes on.');
  assert.equal(page.glyphs(), game);

  pressKey('n', { target: page.cell(0) });
  assert.equal(page.text('ffl-new-game'), 'Confirm New Game');
  pressKey('n', { target: page.cell(0) });
  assert.equal(page.glyphs(), START);
  assert.equal(page.text('ffl-new-game'), 'New Game');
  assert.deepEqual(page.saved(), save({}));
  t.mock.timers.tick(CONFIRM_MS);
  assert.equal(page.log(), '> new game: 1s (You) vs 0s (CPU Normal). 1s move first.', 'the confirmation timer is gone');

  // A move made while the confirmation waits cancels it.
  page.click(44);
  t.mock.timers.tick(CPU_DELAY);
  page.newGame();
  page.click(page.legal()[0]);
  assert.equal(page.text('ffl-new-game'), 'New Game');
  t.mock.timers.tick(CPU_DELAY);
  page.newGame();
  page.undo();
  assert.equal(page.text('ffl-new-game'), 'New Game');
});

test('flip-flop: New Game while the computer thinks cancels its move, and leaves no timer behind', (t) => {
  t.mock.method(Math, 'random', seeded(6));
  const page = openPage(t);
  page.click(19);
  page.newGame();
  page.newGame();
  assert.equal(page.glyphs(), START);
  assert.equal(page.board.className, 'ffl-board');
  t.mock.timers.tick(10000);
  assert.equal(page.glyphs(), START);
  assert.equal(page.status(), 'Your move: write a 1 (4 legal moves).');
  // However often a game starts, nothing is bound twice.
  for (let i = 0; i < 3; i++) {
    page.click(19);
    page.newGame();
    page.newGame();
    page.choose('hard');
  }
  assert.equal(listenerCount(page.board, 'click'), 1);
  assert.equal(listenerCount(page.els['ffl-game'], 'keydown'), 1);
  assert.equal(listenerCount(page.els['ffl-new-game'], 'click'), 1);
  assert.equal(page.cells().length, 64);
});

test('flip-flop: the opponent select starts a game without moves at once, and waits for New Game in the middle of one', (t) => {
  t.mock.method(Math, 'random', seeded(8));
  const page = openPage(t);
  page.choose('hard');
  assert.equal(page.log(), '> new game: 1s (You) vs 0s (CPU Hard). 1s move first.');
  assert.equal(page.text('ffl-name-zero'), '0s · CPU Hard');
  assert.equal(page.saved().mode, 'hard');
  page.choose('hard');
  assert.equal(page.log(), '> opponent: CPU Hard, as in this game.');
  page.click(26);
  page.choose('pvp');
  assert.equal(page.log(), '> next game vs two players from New Game; this game stays vs CPU Hard.');
  assert.equal(page.saved().mode, 'hard');
  t.mock.timers.tick(CPU_DELAY);
  assert.match(page.log(), /^> CPU Hard wrote a 0 at/);
  page.newGame();
  page.newGame();
  assert.equal(page.log(), '> new game: 1s (Player 1) vs 0s (Player 2). 1s move first.');
  assert.equal(page.saved().mode, 'pvp');
  // A value the select cannot hold keeps the current opponent.
  page.els['ffl-mode'].value = 'bogus';
  page.newGame();
  assert.equal(page.saved().mode, 'pvp');
  assert.equal(page.els['ffl-mode'].value, 'pvp');
});

test('flip-flop: the XOR hint marks legal moves with their flips and previews the flipped bits; it can be turned off', (t) => {
  const page = openPage(t);
  fire(page.cell(37), 'mouseover');
  assert.deepEqual(page.marked('ffl-cell--xor'), [36]);
  assert.deepEqual(page.marked('ffl-cell--ghost'), [37]);
  fire(page.cell(0), 'mouseover');
  assert.deepEqual(page.marked('ffl-cell--xor'), [], 'an illegal cell previews nothing');
  assert.deepEqual(page.marked('ffl-cell--ghost'), []);
  fire(page.cell(26), 'mouseover');
  assert.deepEqual(page.marked('ffl-cell--xor'), [27]);
  fire(page.cell(26), 'mouseover');
  fire(page.board, 'mouseover');
  assert.deepEqual(page.marked('ffl-cell--xor'), []);
  fire(page.cell(44), 'mouseover');
  fire(page.board, 'mouseleave');
  assert.deepEqual(page.marked('ffl-cell--xor'), []);
  fire(page.board, 'mouseleave');

  page.hint();
  assert.equal(page.text('ffl-hint'), 'XOR hint: off');
  assert.equal(page.els['ffl-hint'].getAttribute('aria-pressed'), 'false');
  assert.equal(page.log(), '> XOR hint off: legal moves are no longer marked.');
  assert.deepEqual(page.legal(), []);
  assert.equal(page.cell(19).textContent, '');
  assert.equal(page.cell(19).getAttribute('aria-label'), '0x13, row 3 column 4: empty');
  fire(page.cell(37), 'mouseover');
  assert.deepEqual(page.marked('ffl-cell--xor'), []);
  assert.equal(page.saved().hint, false);
  // Off stays off after a reload and a new game.
  const again = reload(t, page);
  assert.equal(again.text('ffl-hint'), 'XOR hint: off');
  again.newGame();
  assert.deepEqual(again.legal(), []);
  again.hint();
  assert.equal(again.log(), '> XOR hint on: legal moves show how many bits they flip; point at one to see which.');
  assert.deepEqual(again.legal(), [19, 26, 37, 44]);
  assert.equal(again.saved().hint, true);
});

test('flip-flop: the preview under the pointer or the cursor comes back by itself once the computer has replied', (t) => {
  t.mock.method(Math, 'random', () => 0);
  // Easy with Math.random 0 answers 19 with 18; 37 stays legal for the 1s.
  const reply = toText(modelPlay(modelPlay(fromText(START), ONE, 19), ZERO, 18));
  const page = openPage(t, { state: save({ mode: 'easy' }) });
  fire(page.cell(19), 'mouseover');
  page.click(19);
  assert.deepEqual(page.marked('ffl-cell--xor'), [], 'the taken cell previews nothing');
  fire(page.cell(37), 'mouseover');
  assert.deepEqual(page.marked('ffl-cell--xor'), [], 'no preview while the computer thinks');
  t.mock.timers.tick(CPU_DELAY);
  assert.equal(page.glyphs(), reply);
  const flips = modelFlips(fromText(reply), ONE, 37).sort((a, b) => a - b);
  assert.ok(flips.length > 0);
  assert.deepEqual(page.marked('ffl-cell--xor'), flips, 'the mouse never moved, and the flips show again');
  assert.deepEqual(page.marked('ffl-cell--ghost'), [37]);

  // The keyboard: the cursor moved on while the computer thought.
  resetStubs();
  const keys = openPage(t, { state: save({ mode: 'easy' }) });
  focusElement(keys.cell(19), { keyboard: true });
  pressKey('Enter');
  pressKey('ArrowDown');
  pressKey('ArrowDown');
  pressKey('ArrowRight');
  pressKey('ArrowRight');
  assert.equal(document.activeElement, keys.cell(37));
  assert.deepEqual(keys.marked('ffl-cell--xor'), []);
  t.mock.timers.tick(CPU_DELAY);
  assert.equal(keys.glyphs(), reply);
  assert.deepEqual(keys.marked('ffl-cell--xor'), flips);
  assert.deepEqual(keys.marked('ffl-cell--ghost'), [37]);
});

test('flip-flop: on the board the arrows move a cursor (and the focus), Enter or Space write there, a held key once', (t) => {
  t.mock.method(Math, 'random', seeded(12));
  const page = openPage(t);
  focusElement(page.cell(19), { keyboard: true });
  let ev = pressKey('ArrowUp');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(document.activeElement, page.cell(11));
  assert.equal(page.cell(11).getAttribute('tabindex'), '0');
  assert.equal(page.cell(19).getAttribute('tabindex'), '-1');
  pressKey('ArrowUp');
  pressKey('ArrowUp');
  assert.equal(document.activeElement, page.cell(3), 'row 0 is the top');
  pressKey('ArrowLeft');
  pressKey('ArrowLeft');
  pressKey('ArrowLeft');
  pressKey('ArrowLeft');
  assert.equal(document.activeElement, page.cell(0), 'column 0 is the left edge');
  for (let i = 0; i < 9; i++) pressKey('ArrowDown');
  assert.equal(document.activeElement, page.cell(56));
  for (let i = 0; i < 9; i++) pressKey('ArrowRight');
  assert.equal(document.activeElement, page.cell(63));
  // The cursor previews like the mouse.
  focusElement(page.cell(37), { keyboard: true });
  assert.deepEqual(page.marked('ffl-cell--xor'), [36]);
  pressKey('ArrowLeft');
  pressKey('ArrowRight');
  assert.deepEqual(page.marked('ffl-cell--ghost'), [37]);
  // A held Enter writes nothing; a single one writes at the cursor, once.
  ev = pressKey('Enter', { repeat: true });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(page.glyphs(), START);
  ev = pressKey('Enter');
  assert.equal(ev.defaultPrevented, true, 'the button is not clicked as well');
  assert.equal(page.glyphs(), toText(modelPlay(fromText(START), ONE, 37)));
  assert.equal(page.saved().history.length, 1);
  t.mock.timers.tick(CPU_DELAY);
  const target = page.legal()[0];
  focusElement(page.cell(target), { keyboard: true });
  pressKey(' ');
  assert.equal(page.saved().history.length, 2);
  assert.equal(page.saved().last, target);
});

test('flip-flop: keys outside the board, in the select, with modifiers or already handled are left alone', (t) => {
  const page = openPage(t, { state: save({ board: toText(modelPlay(modelPlay(fromText(START), ONE, 19), ZERO, 18)), history: [START + '1'] }) });
  const before = localStorage.getItem(STATE_KEY);
  const host = page.page.add('host-input', 'input');
  const link = page.page.add('host-link', 'a');
  for (const target of [host, link, document.body]) {
    for (const key of ['u', 'n', 'ArrowDown', 'Enter', ' ']) {
      assert.equal(pressKey(key, { target }).defaultPrevented, false, key + ' on ' + target.tagName);
    }
  }
  // Inside the game: the select keeps its letters, buttons keep arrows (page scroll).
  assert.equal(pressKey('u', { target: page.els['ffl-mode'] }).defaultPrevented, false);
  assert.equal(pressKey('n', { target: page.els['ffl-mode'] }).defaultPrevented, false);
  assert.equal(pressKey('ArrowDown', { target: page.els['ffl-hint'] }).defaultPrevented, false);
  assert.equal(pressKey('x', { target: page.cell(0) }).defaultPrevented, false);
  // Ctrl/Cmd/Alt shortcuts, an input method composing, held keys and handled keys.
  for (const props of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    for (const key of ['u', 'n', 'ArrowDown', 'Enter']) {
      assert.equal(pressKey(key, { target: page.cell(19), ...props }).defaultPrevented, false, key + ' ' + JSON.stringify(props));
    }
  }
  assert.equal(pressKey('u', { target: page.cell(19), repeat: true }).defaultPrevented, false);
  const handled = (event) => event.preventDefault();
  page.els['ffl-game'].addEventListener('keydown', handled, true);
  pressKey('u', { target: page.cell(19) });
  pressKey('Enter', { target: page.cell(19) });
  page.els['ffl-game'].removeEventListener('keydown', handled, true);
  assert.equal(localStorage.getItem(STATE_KEY), before);
  assert.equal(page.saved().history.length, 1);
  // Enter on the game's own buttons clicks them, as usual.
  pressKey('Enter', { target: page.els['ffl-hint'] });
  assert.equal(page.saved().hint, false);
  // A key without a key value (autofill) is nothing.
  assert.equal(pressKey(undefined, { target: page.cell(19) }).defaultPrevented, false);
});

test('flip-flop: a game in progress survives a reload: board, turn, opponent, last move and the undo steps', (t) => {
  t.mock.method(Math, 'random', seeded(14));
  const page = openPage(t);
  page.choose('easy');
  page.click(26);
  t.mock.timers.tick(CPU_DELAY);
  page.click(page.legal()[1]);
  t.mock.timers.tick(CPU_DELAY);
  // What the cells show, without the one-off flip animation.
  const view = (v) => v.cells().map((c) => [c.className.replace(/ ffl-cell--flip-[ab]/, ''), c.textContent]);
  const drawn = view(page);
  const snapshot = page.saved();
  assert.equal(snapshot.history.length, 2);

  const again = reload(t, page);
  assert.equal(again.glyphs(), snapshot.board);
  assert.deepEqual(view(again), drawn);
  assert.deepEqual(again.marked('ffl-cell--last'), [snapshot.last]);
  assert.equal(again.els['ffl-mode'].value, 'easy');
  assert.equal(again.text('ffl-name-zero'), '0s · CPU Easy');
  assert.equal(again.log(), '> session restored: 4 moves played, 1s (You) vs 0s (CPU Easy).');
  assert.deepEqual(again.saved(), snapshot);
  again.undo();
  again.undo();
  assert.equal(again.glyphs(), START);
});

test('flip-flop: a reload while the computer thinks lets it move after its delay', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const afterMove = toText(modelPlay(fromText(START), ONE, 19));
  const page = openPage(t, { state: save({ board: afterMove, turn: 2, mode: 'easy', history: [START + '1'], last: 19 }) });
  assert.equal(page.status(), 'CPU Easy is thinking…');
  assert.equal(page.els['ffl-undo'].disabled, true);
  t.mock.timers.tick(CPU_DELAY);
  // Easy with Math.random 0: the first legal move in cell order.
  const first = modelMoves(fromText(afterMove), ZERO)[0];
  assert.equal(page.glyphs(), toText(modelPlay(fromText(afterMove), ZERO, first)));
  assert.equal(page.log(), '> CPU Easy wrote a 0 at ' + hex(first) + ', flipping 1 bit.');
});

test('flip-flop: Hard reports its search, and says so when the node cap cut it short', (t) => {
  t.mock.method(Math, 'random', seeded(1));
  const page = openPage(t, { state: save({ board: CAPPED, turn: 2, mode: 'hard' }) });
  t.mock.timers.tick(CPU_DELAY);
  assert.match(page.log(), /^> CPU Hard wrote a 0 at 0x[0-9A-F]{2}, flipping \d+ bits? \(depth \d+, 30000 positions searched, node cap reached\)\.$/);
});

test('flip-flop: a save in this version\'s format loads, and the next save keeps it', (t) => {
  const board = toText(modelPlay(modelPlay(fromText(START), ONE, 19), ZERO, 18));
  const text = '{"board":"' + board + '","turn":1,"mode":"normal","history":["' + START + '1"],"hint":true,"last":18}';
  const page = openModule(t, { state: text });
  assert.equal(localStorage.getItem(STATE_KEY), text, 'written back byte for byte');
  assert.equal(page.glyphs(), board);
  assert.deepEqual(page.marked('ffl-cell--last'), [18]);
  assert.deepEqual(page.ffl.fflState, { board: fromText(board), turn: ONE, mode: 'normal', history: [START + '1'], hint: true, last: 18 });
  page.undo();
  assert.equal(localStorage.getItem(STATE_KEY), '{"board":"' + START + '","turn":1,"mode":"normal","history":[],"hint":true,"last":-1}');
});

test('flip-flop: corrupt or partial saves never break the page: a fresh, playable game, keeping what still makes sense', (t) => {
  t.mock.method(Math, 'random', seeded(5));
  const corrupt = ['', '{', 'null', '42', '"x"', 'true', '[]', '{}', '{"board":7}', JSON.stringify(save({ board: START.slice(1) })),
    JSON.stringify(save({ board: START.replace('1', 'x') })), JSON.stringify(save({ board: '.'.repeat(64) }))];
  for (const text of corrupt) {
    resetStubs();
    const page = openPage(t, { state: text, stats: '{bad' });
    assert.equal(page.glyphs(), START, text);
    assert.equal(page.status(), 'Your move: write a 1 (4 legal moves).', text);
    assert.equal(page.text('ffl-stat-normal'), 'Normal: W 0 · L 0 · D 0');
    page.click(19);
    t.mock.timers.tick(CPU_DELAY);
    assert.equal(page.saved().history.length, 1, text);
    assert.equal(page.status().startsWith('Your move'), true, text);
  }
  // Partial: each field falls back on its own.
  resetStubs();
  const partial = openPage(t, { state: { board: PASS_FOR_ZERO, mode: 'pvp', hint: 'yes', last: 99, history: ['junk'] } });
  assert.equal(partial.glyphs(), PASS_FOR_ZERO);
  assert.equal(partial.text('ffl-name-one'), '1s · Player 1');
  assert.equal(partial.text('ffl-hint'), 'XOR hint: on');
  assert.deepEqual(partial.marked('ffl-cell--last'), []);
  assert.equal(partial.els['ffl-undo'].disabled, true);
  assert.deepEqual(partial.saved(), save({ board: PASS_FOR_ZERO, mode: 'pvp' }));
});

test('flip-flop: an edited undo step that gives the computer the move makes it move instead of stalling the game', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const two = toText(modelPlay(modelPlay(fromText(START), ONE, 19), ZERO, 18));
  const page = openPage(t, { state: save({ board: two, history: [START + '0'], mode: 'easy' }) });
  page.undo();
  assert.equal(page.glyphs(), START);
  assert.equal(page.status(), 'CPU Easy is thinking…');
  t.mock.timers.tick(CPU_DELAY);
  assert.equal(page.glyphs(), toText(modelPlay(fromText(START), ZERO, 20)), 'Easy with Math.random 0 takes the first legal cell');
  assert.equal(page.status(), 'Your move: write a 1 (' + modelMoves(modelPlay(fromText(START), ZERO, 20), ONE).length + ' legal moves).');
});

test('flip-flop: blocked storage never stops the game, and the warning names both keys and what they hold', (t) => {
  blockStorage('access', t);
  t.mock.method(Math, 'random', seeded(7));
  const page = openPage(t);
  assert.equal(page.els['ffl-warning'].hidden, false);
  assert.equal(page.text('ffl-warning'), 'Browser storage is blocked: ffl-state and ffl-stats cannot be read or saved, so the game and the record vs CPU will not be kept after a reload.');
  assert.equal(page.glyphs(), START);
  page.click(19);
  t.mock.timers.tick(CPU_DELAY);
  assert.equal(modelCount(fromText(page.glyphs()), ZERO) >= 1, true);
  page.undo();
  assert.equal(page.glyphs(), START);
  assert.equal(page.text('ffl-warning'), 'Browser storage is blocked: ffl-state and ffl-stats cannot be read or saved, so the game and the record vs CPU will not be kept after a reload.', 'later saves keep both keys named');
});

test('flip-flop: full storage still loads the save; the warning names each key that failed, the stats included', (t) => {
  writeStorage({ state: save({ board: toText(finale(ONE, 40)) }) });
  blockStorage('full', t);
  const page = openPage(t);
  assert.equal(page.glyphs(), toText(finale(ONE, 40)));
  assert.equal(page.text('ffl-warning'), 'Browser storage is full: ffl-state was not saved, so a reload will lose the latest changes to the game.');
  page.click(63);
  assert.equal(page.status(), 'Game over: you win 40 to 24 (1s ahead by 16).');
  assert.equal(page.text('ffl-stat-normal'), 'Normal: W 1 · L 0 · D 0', 'counted on the page');
  assert.equal(page.text('ffl-warning'), 'Browser storage is full: ffl-state and ffl-stats were not saved, so a reload will lose the latest changes to the game and the record vs CPU.');
  assert.equal(localStorage.getItem(STATS_KEY), null);
  // The stats write alone fails: only its key is named.
  resetStubs();
  writeStorage({ state: save({ board: toText(finale(ONE, 40)) }) });
  t.mock.method(localStorage, 'setItem', (key) => {
    if (key === STATS_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });
  const stats = openPage(t);
  assert.equal(stats.els['ffl-warning'].hidden, true);
  stats.click(63);
  assert.equal(stats.text('ffl-warning'), 'Browser storage is full: ffl-stats was not saved, so a reload will lose the latest changes to the record vs CPU.');
});

test('flip-flop: the storage warning names each failed key with what it holds, blocked before full', () => {
  const ffl = loadScript(SCRIPT);
  assert.equal(ffl.fflStorageWarning({}), '');
  assert.equal(ffl.fflStorageWarning({ 'ffl-stats': 'blocked' }), 'Browser storage is blocked: ffl-stats cannot be read or saved, so the record vs CPU will not be kept after a reload.');
  assert.equal(ffl.fflStorageWarning({ 'ffl-stats': 'full', 'ffl-state': 'full' }), 'Browser storage is full: ffl-state and ffl-stats were not saved, so a reload will lose the latest changes to the game and the record vs CPU.');
  assert.equal(ffl.fflStorageWarning({ 'ffl-stats': 'full', 'ffl-state': 'blocked' }),
    'Browser storage is blocked: ffl-state cannot be read or saved, so the game will not be kept after a reload. ' +
    'Browser storage is full: ffl-stats was not saved, so a reload will lose the latest changes to the record vs CPU.');
  assert.equal(ffl.fflStorageWarning({ 'other-key': 'full' }), '', 'only the game\'s own keys');
});

test('flip-flop: a result counted in a second open tab is kept when this tab finishes a game', (t) => {
  const page = openPage(t, { state: save({ board: toText(finale(ONE, 40)) }), stats: { normal: { wins: 1, losses: 0, draws: 0 } } });
  assert.equal(page.text('ffl-stat-normal'), 'Normal: W 1 · L 0 · D 0');
  // The other tab wins and loses a game against Normal and wins one against Easy.
  writeStorage({ stats: { ...NO_STATS, normal: { wins: 2, losses: 1, draws: 0 }, easy: { wins: 4, losses: 0, draws: 0 } } });
  page.click(63);
  assert.deepEqual(page.stats(), { ...NO_STATS, normal: { wins: 3, losses: 1, draws: 0 }, easy: { wins: 4, losses: 0, draws: 0 } });
  assert.equal(page.text('ffl-stat-normal'), 'Normal: W 3 · L 1 · D 0');
  assert.equal(page.text('ffl-stat-easy'), 'Easy: W 4 · L 0 · D 0');

  // A damaged save in between takes nothing away from the counts on the page.
  resetStubs();
  const damaged = openPage(t, { state: save({ board: toText(finale(ONE, 32)) }), stats: { normal: { wins: 5, losses: 2, draws: 1 } } });
  writeStorage({ stats: '{bad' });
  damaged.click(63);
  assert.deepEqual(damaged.stats(), { ...NO_STATS, normal: { wins: 5, losses: 2, draws: 2 } });

  // Storage blocked after the page loaded: the counts on the page are kept.
  resetStubs();
  const blocked = openPage(t, { state: save({ board: toText(finale(ZERO, 40)), turn: 2, mode: 'easy' }), stats: { easy: { wins: 0, losses: 3, draws: 0 } } });
  blockStorage('access', t);
  t.mock.timers.tick(CPU_DELAY);
  assert.equal(blocked.text('ffl-stat-easy'), 'Easy: W 0 · L 4 · D 0');
  assert.equal(blocked.text('ffl-warning'), 'Browser storage is blocked: ffl-state and ffl-stats cannot be read or saved, so the game and the record vs CPU will not be kept after a reload.');
});

test('flip-flop: merging saved stats keeps the larger count of every field, and a damaged save changes nothing', () => {
  const ffl = loadScript(SCRIPT);
  const mine = { easy: { wins: 3, losses: 0, draws: 1 }, normal: { wins: 0, losses: 2, draws: 0 }, hard: { wins: 1, losses: 1, draws: 1 } };
  const theirs = { easy: { wins: 2, losses: 4, draws: 1 }, normal: { wins: 6, losses: 2, draws: 0 }, hard: { wins: 0, losses: 0, draws: 0 } };
  const merged = ffl.fflMergeStats(mine, theirs);
  assert.equal(merged, mine, 'merged in place');
  assert.deepEqual(merged, { easy: { wins: 3, losses: 4, draws: 1 }, normal: { wins: 6, losses: 2, draws: 0 }, hard: { wins: 1, losses: 1, draws: 1 } });
  assert.deepEqual(theirs.hard, { wins: 0, losses: 0, draws: 0 }, 'the saved side is left alone');
  const before = JSON.parse(JSON.stringify(merged));
  assert.deepEqual(ffl.fflMergeStats(merged, ffl.fflParseStats('{bad')), before);
  assert.deepEqual(ffl.fflMergeStats(merged, ffl.fflParseStats(null)), before);
});

test('flip-flop: a newer toast keeps its full duration, and New Game hides the old one', (t) => {
  const page = openPage(t, { state: save({ board: PASS_FOR_ZERO }) });
  page.click(63);
  assert.equal(page.toastVisible(), true);
  t.mock.timers.tick(1000);
  page.click(0);
  assert.match(page.toast(), /^Game over: /);
  t.mock.timers.tick(TOAST_MS - 1);
  assert.equal(page.toastVisible(), true, 'the first toast\'s time is up, not the second\'s');
  t.mock.timers.tick(1);
  assert.equal(page.toastVisible(), false);
  // A new game takes an old toast away at once.
  resetStubs();
  const next = openPage(t, { state: save({ board: PASS_FOR_ZERO }) });
  next.click(63);
  assert.equal(next.toastVisible(), true);
  next.newGame();
  next.newGame();
  assert.equal(next.toastVisible(), false);
  assert.equal(next.glyphs(), START);
});

test('flip-flop: every class the page puts on its elements has a rule in style.css', (t) => {
  t.mock.method(Math, 'random', seeded(3));
  const seen = new Set();
  function collect(view) {
    const walk = (el) => {
      String(el.className || '').split(/\s+/).filter(Boolean).forEach((name) => seen.add(name));
      (el.children || []).forEach(walk);
    };
    walk(view.els['ffl-game']);
  }
  let page = openPage(t);
  collect(page);
  fire(page.cell(19), 'mouseover');
  collect(page);
  page.click(19);
  collect(page);
  t.mock.timers.tick(CPU_DELAY);
  collect(page);
  page.newGame();
  collect(page);
  resetStubs();
  page = openPage(t, { state: save({ board: toText(finale(ONE, 40)) }) });
  page.click(63);
  collect(page);
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors);
  for (const name of ['ffl-cell--ghost', 'ffl-cell--xor', 'ffl-cell--flip-a', 'ffl-cell--flip-b', 'ffl-board--thinking',
    'ffl-board--over', 'ffl-side--winner', 'ffl-btn--confirm', 'ffl-status--thinking', 'ffl-toast--show', 'ffl-bit--one']) {
    assert.ok(seen.has(name), name + ' was drawn');
  }
  for (const name of seen) {
    assert.ok(selectors.some((s) => new RegExp('\\.' + name + '(?![\\w-])').test(s)), name + ' has a rule');
  }
});
