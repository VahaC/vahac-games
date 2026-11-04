// tests/2048-game.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, stubElement, resetStubs } = require('./_setup');

// script.js looks its elements up once while it loads (top of the IIFE), so a
// test that renders, saves or shows a toast needs those ids to resolve.  Each
// call gives a fresh copy of the game (board, score, best score and undo
// history live in the module) with its own stub elements.
const IDS = [
  'tf8-board', 'tf8-score', 'tf8-best-score', 'tf8-message', 'tf8-toast',
  'tf8-new-game-btn', 'tf8-undo-btn', 'tf8-restart-btn'
];

function freshGame() {
  const els = {};
  for (const id of IDS) {
    els[id] = stubElement('div');
    els[id].id = id;
  }
  const original = document.getElementById;
  document.getElementById = (id) => (Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null);
  try {
    return { tf8: loadScript('2048-game/script.js'), els };
  } finally {
    document.getElementById = original;
  }
}

// Put a board, score and best score into localStorage and load them, the way
// the page resumes a saved game.
function startFrom(tf8, board, score, best) {
  localStorage.setItem('tf8-2048-game', JSON.stringify({ board: board, score: score || 0 }));
  localStorage.setItem('tf8-2048-best-score', String(best || 0));
  assert.equal(tf8.loadGame(), true);
}

function saved() {
  return JSON.parse(localStorage.getItem('tf8-2048-game'));
}

const empty = () => [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

test.beforeEach(() => resetStubs());

test('2048: loading under Node does not start a game (init is skipped)', () => {
  const tf8 = loadScript('2048-game/script.js');
  assert.equal(localStorage.getItem('tf8-2048-game'), null);
  assert.equal(localStorage.getItem('tf8-2048-best-score'), null);
  assert.equal(tf8.STORAGE_KEY, 'tf8-2048-game');
  assert.equal(tf8.BEST_SCORE_KEY, 'tf8-2048-best-score');
  assert.equal(tf8.MAX_HISTORY, 10);
});

test('2048: every id the script looks up exists in index.html', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '2048-game');
  const js = fs.readFileSync(path.join(dir, 'script.js'), 'utf8');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const used = [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(used, [...IDS].sort());
  for (const id of used) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' is missing from index.html');
  }
});

const DIR = require('node:path').join(__dirname, '..', '2048-game');
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

test('2048: opened on its own the page is dark with no margin, and build-embed never copies that rule', () => {
  const html = readSource('index.html');
  const css = readSource('style.css');
  // Same colour as the wrapper's own base colour, so page and game match.
  assert.equal(css.match(/--tf8-bg-primary:\s*(#[0-9a-f]{6})/i)[1], '#0a0f1e');
  assert.match(html, /<link rel="stylesheet" href="style\.css">\n {2}<style>body \{ margin: 0; background: #0a0f1e; \}<\/style>\n<\/head>/);
  assert.equal(html.match(/<style/g).length, 1);
  // build-embed copies index.html from the wrapper up to the first <script>.
  const start = html.indexOf('<div class="tf8-wrapper"');
  assert.ok(start > html.indexOf('</head>'));
  const copied = html.slice(start, html.indexOf('<script', start));
  assert.doesNotMatch(copied, /<style|<!--|-->/i);
});

test('2048: the sources embed safely in the WordPress block', () => {
  const css = readSource('style.css');
  for (const [name, source] of [['script.js', readSource('script.js')], ['style.css', css]]) {
    assert.ok(!source.includes('<!--') && !source.includes('-->'), name);
    assert.ok(!/<\/script/i.test(source), name);
  }
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(css), 'no bare html/body rule');
  assert.equal(readSource('index.html').match(/<div class="([a-z0-9]{2,4})-wrapper"/)[1], 'tf8');
});

test('2048: nothing is wider than a phone screen, and the board keeps its size where it fits', () => {
  const rules = cssRules(readSource('style.css'));
  assert.equal(declsAt(rules, '.tf8-wrapper', 1280)['box-sizing'], 'border-box');
  for (const sel of ['.tf8-wrapper *', '.tf8-wrapper *::before', '.tf8-wrapper *::after']) {
    assert.equal(declsAt(rules, sel, 1280)['box-sizing'], 'border-box', sel);
  }

  // Phone: the 8px side padding sits inside the 375px, so the board is 359px.
  assert.deepEqual(layoutAt(rules, 375), { wrapper: 375, content: 359, board: 359, tile: 74.75 });
  // Tablet and desktop: the board stays at its 560px maximum and the tiles at
  // 125px, as before the fix; the wrapper's border box stops at 760px.
  assert.deepEqual(layoutAt(rules, 768), { wrapper: 760, content: 728, board: 560, tile: 125 });
  assert.deepEqual(layoutAt(rules, 1280), { wrapper: 760, content: 728, board: 560, tile: 125 });

  for (let vw = 320; vw <= 1440; vw += 1) {
    const l = layoutAt(rules, vw);
    assert.ok(l.wrapper <= vw, vw + 'px: wrapper ' + l.wrapper + 'px');
    assert.ok(l.board <= l.content, vw + 'px: board ' + l.board + 'px');
  }
});

test('2048: slide packs a row to the left and merges each pair once', () => {
  const { tf8 } = freshGame();
  assert.deepEqual(tf8.slide([2, 2, 2, 2]), [4, 4, 0, 0]);
  assert.deepEqual(tf8.slide([2, 2, 4, 0]), [4, 4, 0, 0]);
  assert.deepEqual(tf8.slide([0, 4, 4, 8]), [8, 8, 0, 0]);
  assert.deepEqual(tf8.slide([2, 0, 0, 2]), [4, 0, 0, 0]);
  assert.deepEqual(tf8.slide([4, 4, 4, 0]), [8, 4, 0, 0]);
  assert.deepEqual(tf8.slide([2, 4, 8, 16]), [2, 4, 8, 16]);
  assert.deepEqual(tf8.slide([0, 0, 0, 0]), [0, 0, 0, 0]);
  // Every merge adds the new tile's value to the score: (4+4) + 4 + 8 + 4 + 8 = 32.
  tf8.saveGame();
  assert.equal(saved().score, 32);
});

test('2048: rotateBoardClockwise turns the board a quarter and leaves the input alone', () => {
  const { tf8 } = freshGame();
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

test('2048: moves slide and merge in all four directions and report a change', () => {
  const { tf8 } = freshGame();
  const board = [
    [2, 2, 0, 4],
    [0, 4, 0, 4],
    [2, 0, 8, 0],
    [2, 0, 8, 4]
  ];

  startFrom(tf8, board);
  assert.equal(tf8.moveLeft(), true);
  tf8.saveGame();
  assert.deepEqual(saved().board, [[4, 4, 0, 0], [8, 0, 0, 0], [2, 8, 0, 0], [2, 8, 4, 0]]);
  assert.equal(saved().score, 12);

  startFrom(tf8, board);
  assert.equal(tf8.moveRight(), true);
  tf8.saveGame();
  assert.deepEqual(saved().board, [[0, 0, 4, 4], [0, 0, 0, 8], [0, 0, 2, 8], [0, 2, 8, 4]]);

  startFrom(tf8, board);
  assert.equal(tf8.moveUp(), true);
  tf8.saveGame();
  assert.deepEqual(saved().board, [[4, 2, 16, 8], [2, 4, 0, 4], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(saved().score, 28);

  startFrom(tf8, board);
  assert.equal(tf8.moveDown(), true);
  tf8.saveGame();
  assert.deepEqual(saved().board, [[0, 0, 0, 0], [0, 0, 0, 0], [2, 2, 0, 4], [4, 4, 16, 8]]);

  // Nothing can move left on a packed board without equal neighbours.
  startFrom(tf8, [[2, 4, 0, 0], [8, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(tf8.moveLeft(), false);
});

test('2048: canMove and has2048 read the current board', () => {
  const { tf8 } = freshGame();
  const locked = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];

  startFrom(tf8, locked);
  assert.equal(tf8.canMove(), false);
  assert.equal(tf8.has2048(), false);
  assert.equal(tf8.randomCell(), null);

  const horizontal = tf8.copyBoard(locked);
  horizontal[3][3] = 4; // equal to its left neighbour
  startFrom(tf8, horizontal);
  assert.equal(tf8.canMove(), true);

  const vertical = tf8.copyBoard(locked);
  vertical[3][0] = 2; // equal to the tile above
  startFrom(tf8, vertical);
  assert.equal(tf8.canMove(), true);

  const gap = tf8.copyBoard(locked);
  gap[1][2] = 0;
  startFrom(tf8, gap);
  assert.equal(tf8.canMove(), true);
  assert.deepEqual(tf8.randomCell(), { row: 1, col: 2 });

  const won = tf8.copyBoard(locked);
  won[2][1] = 2048;
  startFrom(tf8, won);
  assert.equal(tf8.has2048(), true);
});

test('2048: newGame places two tiles (2 below 0.9, else 4) and saves', (t) => {
  const { tf8, els } = freshGame();
  const rolls = [0, 0.95, 0.45, 0.2];
  t.mock.method(Math, 'random', () => rolls.shift());
  els['tf8-message'].textContent = 'old message';

  tf8.newGame();

  // Rolls: cell 0 of 16 -> (0,0), value roll 0.95 -> 4; cell floor(0.45*15)=6 of the
  // remaining 15 -> (1,3), value roll 0.2 -> 2.
  const expected = empty();
  expected[0][0] = 4;
  expected[1][3] = 2;
  assert.deepEqual(saved(), { board: expected, score: 0 });
  assert.equal(localStorage.getItem('tf8-2048-best-score'), '0');
  assert.equal(els['tf8-message'].textContent, '');
  // renderBoard draws 16 tiles with a value class and the value as text.
  const tiles = els['tf8-board'].children;
  assert.equal(tiles.length, 16);
  assert.equal(tiles[0].className, 'tf8-tile tf8-tile-4');
  assert.equal(tiles[0].textContent, '4');
  assert.equal(tiles[7].className, 'tf8-tile tf8-tile-2');
  assert.equal(tiles[1].className, 'tf8-tile tf8-tile-0');
  assert.equal(tiles[1].textContent, '');
});

test('2048: handleMove spawns a tile, raises the best score and saves; a blocked move does nothing', (t) => {
  const { tf8, els } = freshGame();
  t.mock.method(Math, 'random', () => 0); // first empty cell, value 2

  startFrom(tf8, [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 10, 8);
  tf8.handleMove('right');
  assert.deepEqual(saved(), {
    board: [[2, 0, 0, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    score: 14
  });
  assert.equal(localStorage.getItem('tf8-2048-best-score'), '14');
  assert.equal(els['tf8-score'].textContent, '14');
  assert.equal(els['tf8-best-score'].textContent, '14');

  // Up is blocked (both tiles already on the top row): no tile, no save.
  const before = localStorage.getItem('tf8-2048-game');
  localStorage.removeItem('tf8-2048-game');
  tf8.handleMove('up');
  assert.equal(localStorage.getItem('tf8-2048-game'), null);
  tf8.saveGame();
  assert.equal(localStorage.getItem('tf8-2048-game'), before);

  // An unknown direction is ignored.
  tf8.handleMove('sideways');
  assert.equal(localStorage.getItem('tf8-2048-game'), before);
});

test('2048: game over and 2048 messages, the win message wins when both apply', (t) => {
  const { tf8, els } = freshGame();
  t.mock.method(Math, 'random', () => 0);

  // The last free cell fills after the move and no neighbours match.
  startFrom(tf8, [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [0, 8, 16, 32]]);
  tf8.handleMove('left');
  assert.deepEqual(saved().board[3], [8, 16, 32, 2]);
  assert.equal(els['tf8-message'].textContent, '💀 Game Over');

  startFrom(tf8, [[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 100, 0);
  els['tf8-message'].textContent = '';
  tf8.handleMove('left');
  assert.equal(els['tf8-message'].textContent, '🎉 You reached 2048!');
  assert.equal(saved().score, 2148);
  assert.equal(localStorage.getItem('tf8-2048-best-score'), '2148');

  // Reaching 2048 with the board locked shows the win message, not Game Over.
  startFrom(tf8, [[1024, 1024, 2, 4], [4, 8, 16, 8], [8, 4, 8, 4], [4, 8, 4, 8]]);
  els['tf8-message'].textContent = '';
  tf8.handleMove('left');
  assert.equal(tf8.canMove(), false);
  assert.equal(els['tf8-message'].textContent, '🎉 You reached 2048!');
});

test('2048: undo steps back through at most 10 moves and shows a toast for 1.8 s', (t) => {
  const { tf8, els } = freshGame();
  t.mock.method(Math, 'random', () => 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  startFrom(tf8, [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  tf8.saveGame();
  const snapshots = [localStorage.getItem('tf8-2048-game')];
  const moves = ['right', 'left', 'down', 'up', 'right', 'down', 'left', 'up', 'right', 'down', 'left', 'up'];
  for (const m of moves) {
    tf8.handleMove(m);
    snapshots.push(localStorage.getItem('tf8-2048-game'));
  }

  tf8.undoMove();
  assert.equal(localStorage.getItem('tf8-2048-game'), snapshots[11]);
  assert.equal(els['tf8-toast'].textContent, 'Undo');
  assert.equal(els['tf8-toast'].classList.contains('tf8-show'), true);
  t.mock.timers.tick(1799);
  assert.equal(els['tf8-toast'].classList.contains('tf8-show'), true);
  t.mock.timers.tick(1);
  assert.equal(els['tf8-toast'].classList.contains('tf8-show'), false);

  for (let i = 2; i <= 10; i++) {
    tf8.undoMove();
    assert.equal(localStorage.getItem('tf8-2048-game'), snapshots[12 - i]);
  }
  // History holds only the last 10 moves: an 11th undo changes nothing.
  els['tf8-toast'].textContent = '';
  tf8.undoMove();
  assert.equal(localStorage.getItem('tf8-2048-game'), snapshots[2]);
  assert.equal(els['tf8-toast'].textContent, '');
});

test('2048: saved game round-trips through localStorage into a new page load', (t) => {
  const first = freshGame();
  t.mock.method(Math, 'random', () => 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  startFrom(first.tf8, [[4, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 20, 50);
  first.tf8.handleMove('left');
  const stored = localStorage.getItem('tf8-2048-game');
  assert.deepEqual(JSON.parse(stored), {
    board: [[8, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    score: 28
  });
  assert.equal(localStorage.getItem('tf8-2048-best-score'), '50');

  // A second copy of the script (a reload) resumes the same board and scores.
  const second = freshGame();
  assert.equal(second.tf8.loadGame(), true);
  const tiles = second.els['tf8-board'].children;
  assert.deepEqual(tiles.slice(0, 2).map((el) => el.textContent), ['8', '2']);
  assert.equal(second.els['tf8-score'].textContent, '28');
  assert.equal(second.els['tf8-best-score'].textContent, '50');
  second.tf8.saveGame();
  assert.equal(localStorage.getItem('tf8-2048-game'), stored);

  // Restart starts over but keeps the best score.
  second.tf8.restartGame();
  assert.equal(saved().score, 0);
  assert.equal(saved().board.flat().filter(Boolean).length, 2);
  assert.equal(localStorage.getItem('tf8-2048-best-score'), '50');
  assert.equal(second.els['tf8-toast'].textContent, 'Restarted');

  // Nothing saved: loadGame reports false; a junk best score reads as 0.
  resetStubs();
  const third = freshGame();
  localStorage.setItem('tf8-2048-best-score', 'junk');
  assert.equal(third.tf8.loadGame(), false);
  third.tf8.saveGame();
  assert.equal(localStorage.getItem('tf8-2048-best-score'), '0');
});
