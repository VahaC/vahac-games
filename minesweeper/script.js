// Minesweeper Game — script.js
// Prefix: msp-
// Dependencies: none.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var mspDifficulties = {
    easy: { rows: 9, cols: 9, mines: 10 },
    medium: { rows: 14, cols: 14, mines: 35 },
    hard: { rows: 18, cols: 18, mines: 65 }
  };

  var MSP_SAVE_KEY = 'msp-save-state';
  var MSP_BEST_PREFIX = 'msp-best-';
  var MSP_TICK_MS = 1000;
  var MSP_TOAST_MS = 2000;
  var MSP_MINE_GLYPH = '✹';
  var MSP_FLAG_GLYPH = '⚑';
  var MSP_NO_BEST = '--';

  var MSP_STATUS = {
    ready: 'Awaiting tactical deployment.',
    won: 'Mission completed.',
    lost: 'Mine triggered.'
  };

  var MSP_TOAST = {
    won: 'Victory achieved.',
    lost: 'System failure detected.'
  };

  // ── State ─────────────────────────────────────────────────────────────────

  // The game in progress, field for field what msp-save-state holds.
  var mspState = {
    rows: 9,
    cols: 9,
    mines: 10,
    board: [],
    revealed: 0,
    flagged: 0,
    firstClick: true,
    timer: 0,
    gameOver: false,
    difficulty: 'easy'
  };

  // Page handles, never saved: the elements (set by mspInit), the clock's
  // interval id and the toast's hide timeout id.
  var mspRuntime = {
    els: null,
    interval: null,
    toastTimeout: null
  };

  // ── Board helpers (no DOM) ────────────────────────────────────────────────

  function mspHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function mspIsLevel(level) {
    return typeof level === 'string' && mspHasOwn(mspDifficulties, level);
  }

  function mspCreateEmptyBoard(rows, cols) {
    var board = [];
    for (var row = 0; row < rows; row++) {
      var cells = [];
      for (var col = 0; col < cols; col++) {
        cells.push({ mine: false, revealed: false, flagged: false, adjacent: 0 });
      }
      board.push(cells);
    }
    return board;
  }

  // Calls fn(cell, row, col) for each of the up to eight cells around (row, col).
  function mspForEachNeighbour(board, row, col, fn) {
    for (var r = row - 1; r <= row + 1; r++) {
      for (var c = col - 1; c <= col + 1; c++) {
        if ((r !== row || c !== col) && r >= 0 && r < board.length && c >= 0 && c < board[r].length) {
          fn(board[r][c], r, c);
        }
      }
    }
  }

  function mspCountMinesAround(board, row, col) {
    var count = 0;
    mspForEachNeighbour(board, row, col, function (cell) {
      if (cell.mine) {
        count++;
      }
    });
    return count;
  }

  // Sets each cell's adjacent to the number of mines around it.  A mine cell
  // counts itself as well, as saves have always stored it; that number is
  // never shown, because the board draws the mine instead.
  function mspCalculateAdjacency(board) {
    for (var row = 0; row < board.length; row++) {
      for (var col = 0; col < board[row].length; col++) {
        var cell = board[row][col];
        cell.adjacent = mspCountMinesAround(board, row, col) + (cell.mine ? 1 : 0);
      }
    }
  }

  // The board's mines, flags, opened safe cells (revealed) and opened mines.
  function mspCountBoard(board) {
    var counts = { mines: 0, flagged: 0, revealed: 0, revealedMines: 0 };
    board.forEach(function (cells) {
      cells.forEach(function (cell) {
        if (cell.mine) {
          counts.mines++;
        }
        if (cell.flagged) {
          counts.flagged++;
        }
        if (cell.revealed && cell.mine) {
          counts.revealedMines++;
        } else if (cell.revealed) {
          counts.revealed++;
        }
      });
    });
    return counts;
  }

  // ── Game rules (mspState, no DOM) ─────────────────────────────────────────

  // Lays mspState.mines mines on a fresh board, never on (safeRow, safeCol),
  // by drawing from the list of free cells, so it always ends.
  function mspPlaceMines(safeRow, safeCol) {
    var board = mspState.board;
    var free = [];
    for (var row = 0; row < board.length; row++) {
      for (var col = 0; col < board[row].length; col++) {
        if (row !== safeRow || col !== safeCol) {
          free.push([row, col]);
        }
      }
    }
    var count = Math.min(mspState.mines, free.length);
    for (var i = 0; i < count; i++) {
      var pick = i + Math.floor(Math.random() * (free.length - i));
      var spot = free[pick];
      free[pick] = free[i];
      free[i] = spot;
      board[spot[0]][spot[1]].mine = true;
    }
    mspCalculateAdjacency(board);
  }

  // Opens the area around (row, col): every closed, unflagged, mine-free
  // neighbour, and onward from each opened cell with no mine around it.
  // Returns how many cells it opened (they are added to mspState.revealed).
  function mspFloodReveal(row, col) {
    var opened = 0;
    var stack = [[row, col]];

    function open(cell, r, c) {
      if (cell.revealed || cell.mine || cell.flagged) {
        return;
      }
      cell.revealed = true;
      opened++;
      if (cell.adjacent === 0) {
        stack.push([r, c]);
      }
    }

    while (stack.length) {
      var at = stack.pop();
      mspForEachNeighbour(mspState.board, at[0], at[1], open);
    }
    mspState.revealed += opened;
    return opened;
  }

  function mspRevealAllMines() {
    mspState.board.forEach(function (cells) {
      cells.forEach(function (cell) {
        if (cell.mine) {
          cell.revealed = true;
        }
      });
    });
  }

  function mspIsWin() {
    return mspState.revealed >= mspState.rows * mspState.cols - mspState.mines;
  }

  // Opens (row, col).  The first reveal of a board lays the mines first.
  // Returns 'ignored' (game over, flagged or already open), 'lost', 'won'
  // or 'ok'.
  function mspRevealCell(row, col) {
    var cell = mspState.board[row][col];
    if (mspState.gameOver || cell.flagged || cell.revealed) {
      return 'ignored';
    }
    if (mspState.firstClick) {
      mspPlaceMines(row, col);
      mspState.firstClick = false;
    }
    cell.revealed = true;
    if (cell.mine) {
      mspRevealAllMines();
      mspState.gameOver = true;
      return 'lost';
    }
    mspState.revealed++;
    if (cell.adjacent === 0) {
      mspFloodReveal(row, col);
    }
    if (mspIsWin()) {
      mspState.gameOver = true;
      return 'won';
    }
    return 'ok';
  }

  // Flags or unflags a closed cell.  Returns false when nothing changed.
  function mspToggleFlag(row, col) {
    var cell = mspState.board[row][col];
    if (mspState.gameOver || cell.revealed) {
      return false;
    }
    cell.flagged = !cell.flagged;
    mspState.flagged += cell.flagged ? 1 : -1;
    return true;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  function mspStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function mspStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      // Storage blocked or full: the game goes on without saving.
    }
  }

  // The save, in the format every version has written.  interval is always
  // null: the first version stored its timer id there.
  function mspSerialize() {
    return {
      rows: mspState.rows,
      cols: mspState.cols,
      mines: mspState.mines,
      board: mspState.board.map(function (cells) {
        return cells.map(function (cell) {
          return { mine: cell.mine, revealed: cell.revealed, flagged: cell.flagged, adjacent: cell.adjacent };
        });
      }),
      revealed: mspState.revealed,
      flagged: mspState.flagged,
      firstClick: mspState.firstClick,
      timer: mspState.timer,
      interval: null,
      gameOver: mspState.gameOver,
      difficulty: mspState.difficulty
    };
  }

  function mspSaveGame() {
    mspStorageSet(MSP_SAVE_KEY, JSON.stringify(mspSerialize()));
  }

  // A rows x cols board of clean cells, or null.  A flag stays only on a
  // closed cell or a mine, and adjacent is worked out again from the mines.
  function mspParseBoard(raw, rows, cols) {
    if (!Array.isArray(raw) || raw.length !== rows) {
      return null;
    }
    var board = [];
    for (var row = 0; row < rows; row++) {
      if (!Array.isArray(raw[row]) || raw[row].length !== cols) {
        return null;
      }
      var cells = [];
      for (var col = 0; col < cols; col++) {
        var cell = raw[row][col];
        if (!cell || typeof cell !== 'object') {
          return null;
        }
        var mine = cell.mine === true;
        var revealed = cell.revealed === true;
        cells.push({
          mine: mine,
          revealed: revealed,
          flagged: cell.flagged === true && (mine || !revealed),
          adjacent: 0
        });
      }
      board.push(cells);
    }
    mspCalculateAdjacency(board);
    return board;
  }

  function mspCleanTimer(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }

  // A saved game (JSON text) as a clean state, or null when it cannot be
  // played: not a known difficulty, a board of the wrong size, a mine count
  // that is neither 0 (before the first click) nor the preset's, cells open
  // before the mines were laid, or a gameOver flag that does not match the
  // board.  The counters are worked out again from the board.
  function mspParseSave(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return null;
    }
    if (!data || !mspIsLevel(data.difficulty)) {
      return null;
    }
    var preset = mspDifficulties[data.difficulty];
    if (data.rows !== preset.rows || data.cols !== preset.cols || data.mines !== preset.mines) {
      return null;
    }
    var board = mspParseBoard(data.board, preset.rows, preset.cols);
    if (!board) {
      return null;
    }
    var counts = mspCountBoard(board);
    var laid = counts.mines === preset.mines;
    var won = laid && counts.revealed === preset.rows * preset.cols - preset.mines;
    var over = counts.revealedMines > 0 || won;
    if ((!laid && (counts.mines > 0 || counts.revealed > 0)) || data.gameOver !== over) {
      return null;
    }
    return {
      rows: preset.rows,
      cols: preset.cols,
      mines: preset.mines,
      board: board,
      revealed: counts.revealed,
      flagged: counts.flagged,
      firstClick: !laid,
      timer: mspCleanTimer(data.timer),
      gameOver: over,
      difficulty: data.difficulty
    };
  }

  // Restores the saved game.  Returns false (and changes nothing) when there
  // is no playable save.
  function mspLoadGame() {
    var saved = mspParseSave(mspStorageGet(MSP_SAVE_KEY));
    if (!saved) {
      return false;
    }
    Object.keys(saved).forEach(function (key) {
      mspState[key] = saved[key];
    });
    if (!mspState.gameOver && !mspState.firstClick) {
      mspStartTimer();
    } else {
      mspStopTimer();
    }
    mspHideToast();
    mspRender();
    mspSyncDifficulty();
    mspSetStatus(mspStatusText());
    return true;
  }

  // The best time of a difficulty in whole seconds, or null when there is
  // none or the stored value is not a whole number.
  function mspReadBest(level) {
    var raw = mspStorageGet(MSP_BEST_PREFIX + level);
    return /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
  }

  function mspSaveBestTime() {
    var best = mspReadBest(mspState.difficulty);
    if (best === null || mspState.timer < best) {
      mspStorageSet(MSP_BEST_PREFIX + mspState.difficulty, String(mspState.timer));
    }
    mspRenderStats();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function mspCellView(cell) {
    var classes = ['msp-cell'];
    var text = '';
    if (cell.revealed) {
      classes.push('msp-cell-revealed');
      if (cell.mine) {
        classes.push('msp-cell-mine');
        text = MSP_MINE_GLYPH;
      } else if (cell.adjacent > 0) {
        text = String(cell.adjacent);
      }
    }
    if (cell.flagged) {
      classes.push('msp-cell-flagged');
      text = MSP_FLAG_GLYPH;
    }
    return { className: classes.join(' '), text: text };
  }

  // Draws every cell as a button in a grid of var(--msp-cell-size) tracks,
  // the size style.css gives the cells at each screen width.
  function mspRenderBoard() {
    var boardEl = mspRuntime.els.board;
    boardEl.innerHTML = '';
    boardEl.style.gridTemplateColumns = 'repeat(' + mspState.cols + ', var(--msp-cell-size))';
    for (var row = 0; row < mspState.rows; row++) {
      for (var col = 0; col < mspState.cols; col++) {
        var view = mspCellView(mspState.board[row][col]);
        var button = document.createElement('button');
        button.className = view.className;
        button.textContent = view.text;
        button.setAttribute('data-row', row);
        button.setAttribute('data-col', col);
        button.setAttribute('aria-label', 'Cell ' + row + ' ' + col);
        boardEl.appendChild(button);
      }
    }
  }

  function mspRenderStats() {
    var els = mspRuntime.els;
    var best = mspReadBest(mspState.difficulty);
    els.mineCounter.textContent = String(mspState.mines - mspState.flagged);
    els.timer.textContent = String(mspState.timer);
    els.best.textContent = best === null ? MSP_NO_BEST : String(best);
  }

  function mspRender() {
    mspRenderBoard();
    mspRenderStats();
  }

  function mspSetStatus(text) {
    mspRuntime.els.status.textContent = text;
  }

  function mspStatusText() {
    if (!mspState.gameOver) {
      return MSP_STATUS.ready;
    }
    return mspCountBoard(mspState.board).revealedMines > 0 ? MSP_STATUS.lost : MSP_STATUS.won;
  }

  function mspSyncDifficulty() {
    mspRuntime.els.difficulty.value = mspState.difficulty;
  }

  function mspShowToast(message) {
    var toast = mspRuntime.els.toast;
    mspHideToast();
    toast.textContent = message;
    toast.classList.add('msp-toast-visible');
    mspRuntime.toastTimeout = setTimeout(mspHideToast, MSP_TOAST_MS);
  }

  function mspHideToast() {
    clearTimeout(mspRuntime.toastTimeout);
    mspRuntime.toastTimeout = null;
    mspRuntime.els.toast.classList.remove('msp-toast-visible');
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  function mspTick() {
    mspState.timer++;
    mspRenderStats();
    mspSaveGame();
  }

  function mspStartTimer() {
    mspStopTimer();
    mspRuntime.interval = setInterval(mspTick, MSP_TICK_MS);
  }

  function mspStopTimer() {
    clearInterval(mspRuntime.interval);
    mspRuntime.interval = null;
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  // A fresh board of a difficulty (Easy for an unknown one), shown and saved.
  function mspApplyDifficulty(level) {
    var key = mspIsLevel(level) ? level : 'easy';
    var preset = mspDifficulties[key];
    mspStopTimer();
    mspState.difficulty = key;
    mspState.rows = preset.rows;
    mspState.cols = preset.cols;
    mspState.mines = preset.mines;
    mspState.board = mspCreateEmptyBoard(preset.rows, preset.cols);
    mspState.revealed = 0;
    mspState.flagged = 0;
    mspState.firstClick = true;
    mspState.gameOver = false;
    mspState.timer = 0;
    mspHideToast();
    mspRender();
    mspSyncDifficulty();
    mspSetStatus(MSP_STATUS.ready);
    mspSaveGame();
  }

  // A fresh board of the current difficulty (Restart and the r key).
  function mspCreateBoard() {
    mspApplyDifficulty(mspState.difficulty);
  }

  function mspWinGame() {
    mspStopTimer();
    mspSetStatus(MSP_STATUS.won);
    mspShowToast(MSP_TOAST.won);
    mspSaveBestTime();
  }

  function mspLoseGame() {
    mspStopTimer();
    mspSetStatus(MSP_STATUS.lost);
    mspShowToast(MSP_TOAST.lost);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // The cell an event on the board came from, as { row, col }, or null when
  // it hit the board itself (its padding or a gap between cells).
  function mspCellAt(event) {
    var target = event.target;
    if (target.getAttribute('data-row') === null) {
      return null;
    }
    return {
      row: parseInt(target.getAttribute('data-row'), 10),
      col: parseInt(target.getAttribute('data-col'), 10)
    };
  }

  function mspHandleReveal(event) {
    var at = mspCellAt(event);
    if (!at) {
      return;
    }
    var firstClick = mspState.firstClick;
    var result = mspRevealCell(at.row, at.col);
    if (result === 'ignored') {
      return;
    }
    if (result === 'won') {
      mspWinGame();
    } else if (result === 'lost') {
      mspLoseGame();
    } else if (firstClick) {
      mspStartTimer();
    }
    mspRender();
    mspSaveGame();
  }

  function mspHandleFlag(event) {
    var at = mspCellAt(event);
    if (!at) {
      return;
    }
    event.preventDefault();
    if (mspToggleFlag(at.row, at.col)) {
      mspRender();
      mspSaveGame();
    }
  }

  function mspIsEditable(target) {
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  // A plain r restarts; not with Ctrl / Cmd / Alt (Ctrl+R reloads the page),
  // not while typing in a field or composing text, not when a page script
  // already handled the key.
  function mspIsRestartKey(event) {
    return event.key === 'r' &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      !event.defaultPrevented && !event.isComposing &&
      !mspIsEditable(event.target);
  }

  function mspHandleKeydown(event) {
    if (mspIsRestartKey(event)) {
      mspCreateBoard();
    }
  }

  function mspBindEvents() {
    var els = mspRuntime.els;
    els.board.addEventListener('click', mspHandleReveal);
    els.board.addEventListener('contextmenu', mspHandleFlag);
    els.newGame.addEventListener('click', function () {
      mspApplyDifficulty(els.difficulty.value);
    });
    els.restart.addEventListener('click', mspCreateBoard);
    els.difficulty.addEventListener('change', function () {
      mspApplyDifficulty(els.difficulty.value);
    });
    document.addEventListener('keydown', mspHandleKeydown);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  // Finds the page elements, binds the controls once and restores the saved
  // game, or starts Easy.
  function mspInit() {
    if (mspRuntime.els) {
      return;
    }
    mspRuntime.els = {
      board: document.getElementById('msp-board'),
      mineCounter: document.getElementById('msp-mine-counter'),
      timer: document.getElementById('msp-timer'),
      best: document.getElementById('msp-best-time'),
      status: document.getElementById('msp-status-text'),
      toast: document.getElementById('msp-toast'),
      difficulty: document.getElementById('msp-difficulty'),
      newGame: document.getElementById('msp-new-game'),
      restart: document.getElementById('msp-restart-game')
    };
    mspBindEvents();
    if (!mspLoadGame()) {
      mspApplyDifficulty('easy');
    }
  }

  // Node (tests): export only, no init and no timers.  Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      mspState: mspState,
      mspDifficulties: mspDifficulties,
      mspInit: mspInit,
      mspCreateEmptyBoard: mspCreateEmptyBoard,
      mspForEachNeighbour: mspForEachNeighbour,
      mspCalculateAdjacency: mspCalculateAdjacency,
      mspCountBoard: mspCountBoard,
      mspPlaceMines: mspPlaceMines,
      mspFloodReveal: mspFloodReveal,
      mspRevealAllMines: mspRevealAllMines,
      mspIsWin: mspIsWin,
      mspRevealCell: mspRevealCell,
      mspToggleFlag: mspToggleFlag,
      mspSerialize: mspSerialize,
      mspParseSave: mspParseSave,
      mspSaveGame: mspSaveGame,
      mspLoadGame: mspLoadGame,
      mspReadBest: mspReadBest,
      mspSaveBestTime: mspSaveBestTime,
      mspApplyDifficulty: mspApplyDifficulty,
      mspCreateBoard: mspCreateBoard,
      mspHandleReveal: mspHandleReveal,
      mspHandleFlag: mspHandleFlag
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mspInit);
  } else {
    mspInit();
  }
})();
