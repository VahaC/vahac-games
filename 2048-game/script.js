// 2048 Game — script.js
// Prefix: tf8-
// Dependencies: none.
(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var STORAGE_KEY = 'tf8-2048-game';
  var BEST_SCORE_KEY = 'tf8-2048-best-score';

  var SIZE = 4;
  var WIN_VALUE = 2048;
  var MAX_HISTORY = 10;
  // A new tile is a 2 when Math.random() is below this, otherwise a 4.
  var TWO_PROBABILITY = 0.9;
  // Pixels a finger must travel along the swipe's main axis to count.
  var SWIPE_THRESHOLD = 40;
  var TOAST_MS = 1800;

  // Keyed by what gameStatus() returns.
  var MESSAGES = {
    won: '🎉 You reached 2048!',
    over: '💀 Game Over'
  };

  var TOASTS = {
    undo: 'Undo',
    restart: 'Restarted'
  };

  var KEY_DIRECTIONS = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down'
  };

  // Clockwise quarter turns that make a direction "left": a move turns the
  // board, slides every row left and turns it back.
  var TURNS = {
    left: 0,
    down: 1,
    right: 2,
    up: 3
  };

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  // ── Board logic (pure: boards in, new values out) ─────────────────────────
  // A board is SIZE rows of SIZE numbers, row-major; 0 is an empty cell.

  function createEmptyBoard() {
    var board = [];
    var row;
    var col;

    for (row = 0; row < SIZE; row++) {
      board.push([]);

      for (col = 0; col < SIZE; col++) {
        board[row].push(0);
      }
    }

    return board;
  }

  function copyBoard(board) {
    return board.map(function (row) {
      return row.slice();
    });
  }

  function rotateBoardClockwise(board) {
    var result = createEmptyBoard();
    var row;
    var col;

    for (row = 0; row < SIZE; row++) {
      for (col = 0; col < SIZE; col++) {
        result[col][SIZE - 1 - row] = board[row][col];
      }
    }

    return result;
  }

  // A copy of board turned clockwise `turns` quarter turns.
  function rotateBoard(board, turns) {
    var result = copyBoard(board);
    var i;

    for (i = 0; i < turns; i++) {
      result = rotateBoardClockwise(result);
    }

    return result;
  }

  function isTile(value) {
    return value !== 0;
  }

  // Slides one row to the left and merges each pair of equal tiles once, as
  // { row, gained } where gained is the sum of the merged tiles:
  // [2, 2, 2, 2] -> { row: [4, 4, 0, 0], gained: 8 }.
  function slideRow(row) {
    var tiles = row.filter(isTile);
    var result = [];
    var gained = 0;
    var i;

    for (i = 0; i < tiles.length; i++) {
      if (tiles[i] === tiles[i + 1]) {
        result.push(tiles[i] * 2);
        gained += tiles[i] * 2;
        i++;
      } else {
        result.push(tiles[i]);
      }
    }

    while (result.length < row.length) {
      result.push(0);
    }

    return { row: result, gained: gained };
  }

  // Every tile slid towards direction ('left', 'right', 'up' or 'down') as
  // { board, gained, changed }, or null for any other direction.  The board
  // passed in is left alone.
  function moveBoard(board, direction) {
    var turned;
    var slid;
    var gained = 0;
    var changed = false;
    var row;

    if (!hasOwn(TURNS, direction)) {
      return null;
    }

    turned = rotateBoard(board, TURNS[direction]);

    for (row = 0; row < SIZE; row++) {
      slid = slideRow(turned[row]);

      if (slid.row.join(',') !== turned[row].join(',')) {
        changed = true;
      }

      turned[row] = slid.row;
      gained += slid.gained;
    }

    return {
      // The remaining quarter turns bring the board back upright.
      board: rotateBoard(turned, (4 - TURNS[direction]) % 4),
      gained: gained,
      changed: changed
    };
  }

  // The empty cells of board as { row, col }, row by row.
  function emptyCells(board) {
    var cells = [];
    var row;
    var col;

    for (row = 0; row < SIZE; row++) {
      for (col = 0; col < SIZE; col++) {
        if (board[row][col] === 0) {
          cells.push({ row: row, col: col });
        }
      }
    }

    return cells;
  }

  // One empty cell picked with Math.random(), or null when the board is full.
  function randomCell(board) {
    var cells = emptyCells(board);

    if (!cells.length) {
      return null;
    }

    return cells[Math.floor(Math.random() * cells.length)];
  }

  // Puts a new tile on a random empty cell of board (changing board) and
  // returns that cell, or null when the board is full.  The cell is rolled
  // before the value.
  function addRandomTile(board) {
    var cell = randomCell(board);

    if (!cell) {
      return null;
    }

    board[cell.row][cell.col] = Math.random() < TWO_PROBABILITY ? 2 : 4;

    return cell;
  }

  // True while some move would change the board: an empty cell, or two equal
  // tiles side by side or one above the other.
  function canMove(board) {
    var row;
    var col;

    for (row = 0; row < SIZE; row++) {
      for (col = 0; col < SIZE; col++) {
        if (board[row][col] === 0) {
          return true;
        }

        if (col < SIZE - 1 && board[row][col] === board[row][col + 1]) {
          return true;
        }

        if (row < SIZE - 1 && board[row][col] === board[row + 1][col]) {
          return true;
        }
      }
    }

    return false;
  }

  // True when some tile on board passes test(value).
  function someTile(board, test) {
    var row;
    var col;

    for (row = 0; row < SIZE; row++) {
      for (col = 0; col < SIZE; col++) {
        if (test(board[row][col])) {
          return true;
        }
      }
    }

    return false;
  }

  function isWinTile(value) {
    return value === WIN_VALUE;
  }

  function isWinOrMore(value) {
    return value >= WIN_VALUE;
  }

  // True once a tile has reached WIN_VALUE (a 4096 still counts).
  function hasWon(board) {
    return someTile(board, isWinOrMore);
  }

  // 'won', 'over' or '' (still playing).  A 2048 tile shows the win even on a
  // locked board.  Once the player has played on past 2048 (no 2048 tile left)
  // the win stays while the board can move, and a locked board is Game Over.
  function gameStatus(board) {
    if (someTile(board, isWinTile)) {
      return 'won';
    }

    if (!canMove(board)) {
      return 'over';
    }

    return hasWon(board) ? 'won' : '';
  }

  // The direction of a swipe that moved dx, dy pixels, or '' when it is too
  // short.  A swipe exactly as wide as it is tall counts as vertical.
  function swipeDirection(dx, dy) {
    var horizontal = Math.abs(dx) > Math.abs(dy);
    var distance = horizontal ? dx : dy;

    if (Math.abs(distance) <= SWIPE_THRESHOLD) {
      return '';
    }

    if (horizontal) {
      return distance > 0 ? 'right' : 'left';
    }

    return distance > 0 ? 'down' : 'up';
  }

  // ── Saves (pure) ──────────────────────────────────────────────────────────

  // 0 or a power of two from 2 up.
  function isTileValue(value) {
    if (value === 0) {
      return true;
    }

    if (typeof value !== 'number' || !(value >= 2)) {
      return false;
    }

    while (value > 2 && value % 2 === 0) {
      value /= 2;
    }

    return value === 2;
  }

  // A SIZE x SIZE array of tile values with at least one tile on it.
  function isPlayableBoard(board) {
    var tiles = 0;
    var row;
    var col;

    if (!Array.isArray(board) || board.length !== SIZE) {
      return false;
    }

    for (row = 0; row < SIZE; row++) {
      if (!Array.isArray(board[row]) || board[row].length !== SIZE) {
        return false;
      }

      for (col = 0; col < SIZE; col++) {
        if (!isTileValue(board[row][col])) {
          return false;
        }

        if (board[row][col]) {
          tiles++;
        }
      }
    }

    return tiles > 0;
  }

  // A score: a whole number of 0 or more; anything else reads as 0.
  function toScore(value) {
    return typeof value === 'number' && value >= 0 && value % 1 === 0 ? value : 0;
  }

  // The saved game in raw (the STORAGE_KEY text, JSON {"board": [[...]],
  // "score": n} as every version wrote it) as { board, score }, or null when it
  // is missing, not JSON or not a playable board.
  function parseSave(raw) {
    var data;

    try {
      data = JSON.parse(raw);
    } catch (e) {
      return null;
    }

    if (!data || !isPlayableBoard(data.board)) {
      return null;
    }

    return { board: copyBoard(data.board), score: toScore(data.score) };
  }

  // The saved best score (the BEST_SCORE_KEY text), 0 when missing or junk.
  function parseBestScore(raw) {
    var best = parseInt(raw, 10);

    return best > 0 ? best : 0;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  var state = {
    board: createEmptyBoard(),
    score: 0,
    bestScore: 0,
    // { board, score } from before each of the last MAX_HISTORY moves.
    history: [],
    toastTimer: null
  };

  // The page's elements, looked up by init().
  var els = null;

  // { id, x, y } of the one finger a swipe on the board started with.
  var touchStart = null;

  // ── Rendering ─────────────────────────────────────────────────────────────

  function $(id) {
    return document.getElementById(id);
  }

  function renderTiles() {
    var row;
    var col;
    var value;
    var tile;

    els.board.innerHTML = '';

    for (row = 0; row < SIZE; row++) {
      for (col = 0; col < SIZE; col++) {
        value = state.board[row][col];
        tile = document.createElement('div');
        tile.className = 'tf8-tile tf8-tile-' + value;
        tile.textContent = value === 0 ? '' : String(value);
        els.board.appendChild(tile);
      }
    }
  }

  // Draws the board, both scores and the message the board calls for.
  function render() {
    renderTiles();
    els.score.textContent = String(state.score);
    els.bestScore.textContent = String(state.bestScore);
    els.message.textContent = MESSAGES[gameStatus(state.board)] || '';
  }

  function hideToast() {
    state.toastTimer = null;
    els.toast.classList.remove('tf8-show');
  }

  // Shows text for TOAST_MS; a new toast restarts the timer.
  function showToast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('tf8-show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(hideToast, TOAST_MS);
  }

  // ── Persistence ───────────────────────────────────────────────────────────
  // Storage can throw (site data blocked, quota full): the game then plays on
  // without saving.

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      // Nothing to do: the game keeps running unsaved.
    }
  }

  function saveGame() {
    writeStorage(STORAGE_KEY, JSON.stringify({ board: state.board, score: state.score }));
    writeStorage(BEST_SCORE_KEY, String(state.bestScore));
  }

  // Reads the best score and resumes the saved game; false (with only the
  // best score read) when there is no usable save.
  function loadGame() {
    var save = parseSave(readStorage(STORAGE_KEY));

    state.bestScore = parseBestScore(readStorage(BEST_SCORE_KEY));

    if (!save) {
      return false;
    }

    state.board = save.board;
    state.score = save.score;
    state.bestScore = Math.max(state.bestScore, state.score);
    state.history = [];
    render();

    return true;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function pushHistory() {
    state.history.push({ board: copyBoard(state.board), score: state.score });

    if (state.history.length > MAX_HISTORY) {
      state.history.shift();
    }
  }

  // Slides the tiles towards direction.  A move that changes nothing (or an
  // unknown direction) does nothing at all and returns false.
  function handleMove(direction) {
    var result = moveBoard(state.board, direction);

    if (!result || !result.changed) {
      return false;
    }

    pushHistory();
    state.board = result.board;
    state.score += result.gained;
    addRandomTile(state.board);

    if (state.score > state.bestScore) {
      state.bestScore = state.score;
    }

    render();
    saveGame();

    return true;
  }

  // Steps back one move; false when there is nothing to undo.  The best score
  // stays.
  function undoMove() {
    var previous = state.history.pop();

    if (!previous) {
      return false;
    }

    state.board = previous.board;
    state.score = previous.score;
    render();
    saveGame();
    showToast(TOASTS.undo);

    return true;
  }

  // A fresh board with two tiles and an empty undo history; the best score
  // stays.
  function newGame() {
    state.board = createEmptyBoard();
    state.score = 0;
    state.history = [];
    addRandomTile(state.board);
    addRandomTile(state.board);
    render();
    saveGame();
  }

  function restartGame() {
    newGame();
    showToast(TOASTS.restart);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // Keys typed into a field of the host page belong to that field.
  function isEditable(target) {
    var tag = target.tagName;

    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  // At least part of the board is inside the window, so the player sees what
  // an arrow key does.  While it is scrolled away the arrows scroll the page.
  function isBoardOnScreen() {
    var rect = els.board.getBoundingClientRect();

    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function onKeyDown(event) {
    if (
      !hasOwn(KEY_DIRECTIONS, event.key) ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      isEditable(event.target) ||
      !isBoardOnScreen()
    ) {
      return;
    }

    // The arrow keys play the game instead of scrolling the page.
    event.preventDefault();
    handleMove(KEY_DIRECTIONS[event.key]);
  }

  function onTouchStart(event) {
    var touch = event.touches[0];

    // A second finger cancels the swipe.
    touchStart = event.touches.length === 1 ?
      { id: touch.identifier, x: touch.clientX, y: touch.clientY } :
      null;
  }

  function onTouchEnd(event) {
    var start = touchStart;
    var touch = null;
    var i;

    if (!start) {
      return;
    }

    for (i = 0; i < event.changedTouches.length; i++) {
      if (event.changedTouches[i].identifier === start.id) {
        touch = event.changedTouches[i];
      }
    }

    if (!touch) {
      return;
    }

    touchStart = null;
    handleMove(swipeDirection(touch.clientX - start.x, touch.clientY - start.y));
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function init() {
    if (els) {
      return;
    }

    els = {
      board: $('tf8-board'),
      score: $('tf8-score'),
      bestScore: $('tf8-best-score'),
      message: $('tf8-message'),
      toast: $('tf8-toast'),
      newGameButton: $('tf8-new-game-btn'),
      undoButton: $('tf8-undo-btn'),
      restartButton: $('tf8-restart-btn')
    };

    document.addEventListener('keydown', onKeyDown);
    els.board.addEventListener('touchstart', onTouchStart, { passive: true });
    els.board.addEventListener('touchend', onTouchEnd, { passive: true });
    els.newGameButton.addEventListener('click', newGame);
    els.undoButton.addEventListener('click', undoMove);
    els.restartButton.addEventListener('click', restartGame);

    if (!loadGame()) {
      newGame();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else if (typeof module === 'undefined' || !module.exports) {
    init();
  }

  /* Node test export (no effect in browsers) */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      STORAGE_KEY: STORAGE_KEY,
      BEST_SCORE_KEY: BEST_SCORE_KEY,
      SIZE: SIZE,
      WIN_VALUE: WIN_VALUE,
      MAX_HISTORY: MAX_HISTORY,
      SWIPE_THRESHOLD: SWIPE_THRESHOLD,
      TOAST_MS: TOAST_MS,
      MESSAGES: MESSAGES,
      TOASTS: TOASTS,
      createEmptyBoard: createEmptyBoard,
      copyBoard: copyBoard,
      rotateBoardClockwise: rotateBoardClockwise,
      slideRow: slideRow,
      moveBoard: moveBoard,
      emptyCells: emptyCells,
      randomCell: randomCell,
      addRandomTile: addRandomTile,
      canMove: canMove,
      hasWon: hasWon,
      gameStatus: gameStatus,
      swipeDirection: swipeDirection,
      parseSave: parseSave,
      parseBestScore: parseBestScore,
      init: init,
      render: render,
      saveGame: saveGame,
      loadGame: loadGame,
      newGame: newGame,
      restartGame: restartGame,
      undoMove: undoMove,
      handleMove: handleMove
    };
  }
})();
