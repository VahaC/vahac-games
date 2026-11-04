// tests/minesweeper.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, stubElement, resetStubs } = require('./_setup');

// script.js looks up its six display elements (#msp-board, #msp-mine-counter,
// #msp-timer, #msp-status-text, #msp-toast, #msp-best-time) once, when it
// loads, and writes to them on every move.  _setup's getElementById returns
// null, so hand out one stub element per id before loading and keep them.
const elements = {};
document.getElementById = function (id) {
  if (!elements[id]) {
    elements[id] = stubElement('div');
    elements[id].id = id;
  }
  return elements[id];
};

const msp = loadScript('minesweeper/script.js');
const state = msp.mspState;

// Fake timers, so the 1 s game clock and the 2 s toast never use real time.
// Call once per test, before the first move.
function useFakeTimers(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
}

// Empty storage and start a new board, as the New Game button does.
function newGame(level) {
  resetStubs();
  msp.mspApplyDifficulty(level);
}

// Lay mines by hand ([row, col] pairs) on a fresh board and skip the
// first-click mine placement.  The state's mine count follows, so the win
// check (rows * cols - mines safe cells) matches the layout.
function layMines(cells) {
  cells.forEach(function ([r, c]) { state.board[r][c].mine = true; });
  state.mines = cells.length;
  state.firstClick = false;
  msp.mspCalculateAdjacency();
}

// The rendered cell button, as the click handlers receive it.
function button(r, c) {
  return elements['msp-board'].children[r * state.cols + c];
}

function reveal(r, c) {
  msp.mspHandleReveal({ currentTarget: button(r, c) });
}

function flag(r, c) {
  const event = {
    currentTarget: button(r, c),
    prevented: false,
    preventDefault: function () { this.prevented = true; }
  };
  msp.mspHandleFlag(event);
  return event;
}

function text(id) {
  return elements[id].textContent;
}

function saved() {
  return JSON.parse(localStorage.getItem('msp-save-state'));
}

// Deterministic Math.random replacement (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function neighbours(r, c) {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = r + dr;
      const nc = c + dc;
      if ((dr || dc) && nr >= 0 && nr < state.rows && nc >= 0 && nc < state.cols) out.push([nr, nc]);
    }
  }
  return out;
}

function cells() {
  const out = [];
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) out.push([r, c]);
  }
  return out;
}

function countMines(list) {
  return list.filter(([r, c]) => state.board[r][c].mine).length;
}

// What mspCalculateAdjacency stores: the mines around a cell, and for a mine
// cell itself too (its 3x3 loop includes the centre).  A mine's count is never
// shown, because the board draws a mine instead of a number.
function expectedAdjacent(r, c) {
  return countMines(neighbours(r, c)) + (state.board[r][c].mine ? 1 : 0);
}

// The cells a reveal of (r, c) should open, worked out independently of the
// game: the cell itself, and, from every cell with no mine around it, each
// neighbour that is not a mine and not flagged.
function expectedOpen(r, c) {
  const open = new Set([r + ',' + c]);
  const queue = countMines(neighbours(r, c)) === 0 ? [[r, c]] : [];
  while (queue.length) {
    const [qr, qc] = queue.shift();
    neighbours(qr, qc).forEach(function ([nr, nc]) {
      const key = nr + ',' + nc;
      const cell = state.board[nr][nc];
      if (open.has(key) || cell.mine || cell.flagged) return;
      open.add(key);
      if (countMines(neighbours(nr, nc)) === 0) queue.push([nr, nc]);
    });
  }
  return open;
}

test('minesweeper: every id the script looks up exists in index.html, and the files embed safely', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'minesweeper');
  const js = fs.readFileSync(path.join(dir, 'script.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

  const ids = Array.from(js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'msp-best-time', 'msp-board', 'msp-difficulty', 'msp-mine-counter',
    'msp-new-game', 'msp-restart-game', 'msp-status-text', 'msp-timer', 'msp-toast'
  ]);
  for (const id of ids) assert.ok(html.includes('id="' + id + '"'), id);

  // The block embeds these files inside an HTML comment and a script tag.
  for (const [name, source] of [['script.js', js], ['style.css', css]]) {
    assert.ok(!source.includes('<!--') && !source.includes('-->'), name);
    assert.ok(!/<\/script/i.test(source), name);
  }
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(css), 'no bare html/body rule');
  assert.equal(html.match(/<div class="([a-z0-9]{2,4})-wrapper"/)[1], 'msp');
});

test('minesweeper: opened on its own, the page has no margin and the wrapper background, kept out of the embed', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'minesweeper');
  const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

  // Without this rule the body is transparent with the browser's 8px margin: light
  // text vanishes in a light browser theme and a white frame shows round the game.
  const bg = css.match(/--msp-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));

  // build-embed copies the markup from the wrapper up to the first <script> only,
  // so the body rule never reaches WordPress.
  const embedded = html.slice(html.indexOf('<div class="msp-wrapper"'), html.indexOf('<script'));
  assert.ok(!/<style/i.test(embedded), 'no <style> in the embedded markup');
});

test('minesweeper: difficulty presets and a fresh board', (t) => {
  useFakeTimers(t);
  assert.deepEqual(msp.mspDifficulties, {
    easy: { rows: 9, cols: 9, mines: 10 },
    medium: { rows: 14, cols: 14, mines: 35 },
    hard: { rows: 18, cols: 18, mines: 65 }
  });

  for (const level of ['easy', 'medium', 'hard']) {
    newGame(level);
    const preset = msp.mspDifficulties[level];
    assert.equal(state.difficulty, level);
    assert.equal(state.rows, preset.rows);
    assert.equal(state.cols, preset.cols);
    assert.equal(state.mines, preset.mines);
    assert.equal(state.firstClick, true);
    assert.equal(state.gameOver, false);
    assert.equal(state.revealed, 0);
    assert.equal(state.timer, 0);
    assert.equal(state.board.length, preset.rows);
    for (const row of state.board) {
      assert.equal(row.length, preset.cols);
      for (const cell of row) {
        assert.deepEqual(cell, { mine: false, revealed: false, flagged: false, adjacent: 0 });
      }
    }
    // Rendered: one button per cell in a fixed 42px grid, counters reset.
    assert.equal(elements['msp-board'].children.length, preset.rows * preset.cols);
    assert.equal(elements['msp-board'].style.gridTemplateColumns, 'repeat(' + preset.cols + ', 42px)');
    assert.equal(button(1, 2).getAttribute('aria-label'), 'Cell 1 2');
    assert.equal(text('msp-mine-counter'), String(preset.mines));
    assert.equal(text('msp-timer'), '0');
    assert.equal(text('msp-best-time'), '--');
    // The new board is saved at once.
    assert.equal(saved().difficulty, level);
    assert.equal(saved().board.length, preset.rows);
  }
});

test('minesweeper: the first reveal lays the mines, never under the clicked cell, and opens the right area', (t) => {
  useFakeTimers(t);
  const random = t.mock.method(Math, 'random', seeded(1));

  for (const level of ['easy', 'medium', 'hard']) {
    for (let seed = 1; seed <= 10; seed++) {
      random.mock.mockImplementation(seeded(seed));
      newGame(level);
      assert.equal(countMines(cells()), 0, 'no mines before the first click');

      const r = (seed * 3) % state.rows;
      const c = (seed * 5) % state.cols;
      reveal(r, c);

      const where = level + ' seed ' + seed;
      assert.equal(countMines(cells()), state.mines, where);
      assert.equal(state.board[r][c].mine, false, where);
      assert.equal(state.board[r][c].revealed, true, where);
      assert.equal(state.firstClick, false, where);
      for (const [cr, cc] of cells()) {
        assert.equal(state.board[cr][cc].adjacent, expectedAdjacent(cr, cc), where + ' adjacency ' + cr + ',' + cc);
      }

      const open = expectedOpen(r, c);
      for (const [cr, cc] of cells()) {
        assert.equal(state.board[cr][cc].revealed, open.has(cr + ',' + cc), where + ' revealed ' + cr + ',' + cc);
      }
      assert.equal(state.revealed, open.size, where);
    }
  }

  // The first reveal also starts the clock, which ticks once a second and saves.
  random.mock.mockImplementation(seeded(42));
  newGame('easy');
  reveal(4, 4);
  assert.equal(state.gameOver, false);
  t.mock.timers.tick(3000);
  assert.equal(state.timer, 3);
  assert.equal(text('msp-timer'), '3');
  assert.equal(saved().timer, 3);
});

test('minesweeper: adjacency counts all eight neighbours and stops at the edges', (t) => {
  useFakeTimers(t);
  newGame('easy');
  layMines([[0, 0], [0, 1], [1, 0], [4, 4], [8, 8]]);
  const adj = (r, c) => state.board[r][c].adjacent;

  assert.equal(adj(1, 1), 3); // three mines around one cell
  assert.equal(adj(0, 0), 3); // a mine cell counts itself too (never displayed)
  assert.equal(adj(4, 4), 1);
  assert.equal(adj(0, 2), 1);
  assert.equal(adj(2, 2), 0);
  assert.equal(adj(7, 7), 1); // corner mine, diagonal neighbour
  assert.equal(adj(8, 7), 1);
  for (const [r, c] of neighbours(4, 4)) assert.equal(adj(r, c), 1);
  assert.equal(adj(6, 6), 0);
});

test('minesweeper: revealing an empty cell opens the area up to the numbers and leaves flags alone', (t) => {
  useFakeTimers(t);
  newGame('easy');
  layMines([[0, 0]]);
  flag(8, 8);
  reveal(4, 4);

  for (const [r, c] of cells()) {
    const hidden = (r === 0 && c === 0) || (r === 8 && c === 8);
    assert.equal(state.board[r][c].revealed, !hidden, r + ',' + c);
  }
  assert.equal(state.revealed, 79);
  assert.equal(state.gameOver, false); // the flagged safe cell is still closed
  assert.equal(state.board[8][8].flagged, true);

  // Rendered: numbers on the border, blanks inside, the flag kept.
  assert.equal(button(0, 1).textContent, '1');
  assert.ok(button(0, 1).classList.contains('msp-cell-revealed'));
  assert.equal(button(4, 4).textContent, '');
  assert.ok(button(4, 4).classList.contains('msp-cell-revealed'));
  assert.equal(button(8, 8).textContent, '⚑');
  assert.ok(button(8, 8).classList.contains('msp-cell-flagged'));
  assert.ok(!button(0, 0).classList.contains('msp-cell-revealed'));
});

test('minesweeper: revealing the last safe cell wins and records the time', (t) => {
  useFakeTimers(t);
  newGame('easy');
  layMines([[0, 0], [0, 2]]);
  state.timer = 37;

  // (0, 1) sits between the two mines with no empty neighbour, so the flood
  // from the far corner leaves it closed.
  reveal(8, 8);
  assert.equal(state.revealed, 78);
  assert.equal(state.board[0][1].revealed, false);
  assert.equal(state.gameOver, false);

  reveal(0, 1);
  assert.equal(state.revealed, 79);
  assert.equal(state.gameOver, true);
  assert.equal(text('msp-status-text'), 'Mission completed.');
  assert.equal(text('msp-toast'), 'Victory achieved.');
  assert.ok(elements['msp-toast'].classList.contains('msp-toast-visible'));
  assert.equal(localStorage.getItem('msp-best-easy'), '37');
  assert.equal(text('msp-best-time'), '37');
  assert.equal(saved().gameOver, true); // the win is saved

  // Once over, the board ignores flags (the context menu is still suppressed).
  const event = flag(0, 0);
  assert.equal(event.prevented, true);
  assert.equal(state.board[0][0].flagged, false);

  // The toast hides after 2 s.
  t.mock.timers.tick(2000);
  assert.ok(!elements['msp-toast'].classList.contains('msp-toast-visible'));
});

test('minesweeper: stepping on a mine loses, shows every mine and stops the clock', (t) => {
  useFakeTimers(t);
  t.mock.method(Math, 'random', seeded(7));
  newGame('easy');
  reveal(4, 4);
  t.mock.timers.tick(2000);
  assert.equal(state.timer, 2);

  const mines = cells().filter(([r, c]) => state.board[r][c].mine);
  const before = state.revealed;
  const [mr, mc] = mines[0];
  reveal(mr, mc);

  assert.equal(state.gameOver, true);
  assert.equal(text('msp-status-text'), 'Mine triggered.');
  assert.equal(text('msp-toast'), 'System failure detected.');
  for (const [r, c] of mines) {
    assert.equal(state.board[r][c].revealed, true);
    assert.equal(button(r, c).textContent, '✹');
    assert.ok(button(r, c).classList.contains('msp-cell-mine'));
  }

  // Frozen: the clock stops and further reveals do nothing.
  t.mock.timers.tick(5000);
  assert.equal(state.timer, 2);
  const closed = cells().find(([r, c]) => !state.board[r][c].revealed);
  reveal(closed[0], closed[1]);
  assert.equal(state.board[closed[0]][closed[1]].revealed, false);
  assert.equal(state.revealed, before + 1);
});

test('minesweeper: flags toggle, drive the mine counter and block reveals', (t) => {
  useFakeTimers(t);
  t.mock.method(Math, 'random', seeded(3));
  newGame('easy');

  const event = flag(2, 3);
  assert.equal(event.prevented, true); // no browser context menu
  assert.equal(state.board[2][3].flagged, true);
  assert.equal(state.flagged, 1);
  assert.equal(text('msp-mine-counter'), '9');
  assert.equal(button(2, 3).textContent, '⚑');
  assert.equal(saved().board[2][3].flagged, true);

  // A flagged cell cannot be revealed, so it does not count as the first click.
  reveal(2, 3);
  assert.equal(state.board[2][3].revealed, false);
  assert.equal(state.firstClick, true);
  assert.equal(countMines(cells()), 0);

  flag(2, 3);
  assert.equal(state.board[2][3].flagged, false);
  assert.equal(text('msp-mine-counter'), '10');

  // The counter is mines minus flags with no floor, so extra flags go negative.
  for (let c = 0; c < 9; c++) flag(0, c);
  flag(1, 0);
  flag(1, 1);
  assert.equal(state.flagged, 11);
  assert.equal(text('msp-mine-counter'), '-1');

  // A revealed cell cannot be flagged.
  reveal(8, 8);
  assert.equal(state.board[8][8].revealed, true);
  flag(8, 8);
  assert.equal(state.board[8][8].flagged, false);
  assert.equal(state.flagged, 11);
});

test('minesweeper: best time per difficulty keeps the fastest run, compared as numbers', (t) => {
  useFakeTimers(t);
  newGame('easy');

  state.timer = 42;
  msp.mspSaveBestTime();
  assert.equal(localStorage.getItem('msp-best-easy'), '42');

  state.timer = 50;
  msp.mspSaveBestTime();
  assert.equal(localStorage.getItem('msp-best-easy'), '42');

  state.timer = 30;
  msp.mspSaveBestTime();
  assert.equal(localStorage.getItem('msp-best-easy'), '30');
  assert.equal(text('msp-best-time'), '30');

  // '100' sorts before '30' as text; the game compares numbers.
  state.timer = 100;
  msp.mspSaveBestTime();
  assert.equal(localStorage.getItem('msp-best-easy'), '30');

  // Each difficulty has its own record.
  msp.mspApplyDifficulty('hard');
  assert.equal(text('msp-best-time'), '--');
  state.timer = 99;
  msp.mspSaveBestTime();
  assert.equal(localStorage.getItem('msp-best-hard'), '99');
  assert.equal(localStorage.getItem('msp-best-easy'), '30');
  msp.mspApplyDifficulty('easy');
  assert.equal(text('msp-best-time'), '30');
});

test('minesweeper: a game in progress survives a reload', (t) => {
  useFakeTimers(t);
  t.mock.method(Math, 'random', seeded(11));
  newGame('medium');
  reveal(7, 7);
  const closed = cells().find(([r, c]) => !state.board[r][c].revealed);
  flag(closed[0], closed[1]);
  t.mock.timers.tick(5000);

  const snapshot = localStorage.getItem('msp-save-state');
  const before = JSON.parse(snapshot);
  assert.equal(before.timer, 5);
  assert.equal(before.flagged, 1);

  // Reload: the page starts from scratch, then reads the save back.
  newGame('easy');
  localStorage.setItem('msp-save-state', snapshot);
  assert.equal(msp.mspLoadGame(), true);

  assert.equal(state.difficulty, 'medium');
  assert.equal(state.rows, 14);
  assert.equal(state.cols, 14);
  assert.equal(state.mines, 35);
  assert.equal(state.timer, 5);
  assert.equal(state.flagged, 1);
  assert.equal(state.revealed, before.revealed);
  assert.equal(state.firstClick, false);
  assert.equal(state.gameOver, false);
  assert.deepEqual(state.board, before.board);
  assert.equal(elements['msp-board'].children.length, 196);
  assert.equal(text('msp-mine-counter'), '34');

  // The clock picks up where it stopped.
  t.mock.timers.tick(2000);
  assert.equal(state.timer, 7);
  assert.equal(saved().timer, 7);
});

test('minesweeper: a missing or corrupt save is ignored', (t) => {
  useFakeTimers(t);
  newGame('hard');

  localStorage.removeItem('msp-save-state');
  assert.equal(msp.mspLoadGame(), false);

  localStorage.setItem('msp-save-state', '{"rows":');
  assert.equal(msp.mspLoadGame(), false);
  assert.equal(state.difficulty, 'hard');
  assert.equal(state.rows, 18);
});

// Staging behaviour, pinned on purpose: mspHandleReveal returns before
// mspSaveGame when a mine is hit, and mspLoseGame does not save either, so the
// loss never reaches storage.  A reload brings back the board from before the
// fatal click, with the mines where they were.  The fix would be a
// mspSaveGame() call at the end of mspLoseGame; this test then changes.
test('minesweeper: a lost game is not saved, so a reload undoes the fatal click (staging behaviour)', (t) => {
  useFakeTimers(t);
  t.mock.method(Math, 'random', seeded(7));
  newGame('easy');
  reveal(4, 4);
  const [mr, mc] = cells().find(([r, c]) => state.board[r][c].mine);
  reveal(mr, mc);
  assert.equal(state.gameOver, true);

  assert.equal(saved().gameOver, false);
  assert.equal(msp.mspLoadGame(), true);
  assert.equal(state.gameOver, false);
  assert.equal(state.board[mr][mc].mine, true);
  assert.equal(state.board[mr][mc].revealed, false);
});
