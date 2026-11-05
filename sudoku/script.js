// Sudoku Game — script.js
// Prefix: sdk-
// Dependencies: none.
//
// Sections: constants, puzzle logic (pure, no DOM), saves, game state, page
// elements and rendering, input, toast, game actions, start-up, exports.
//
// Boards: the puzzle logic works on 9x9 arrays of numbers (0 = empty); the
// game state and the save hold 81-character strings of digits ('0' = empty)
// in reading order.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var STORAGE_KEY = 'sdk-sudoku-game';
  var SIZE = 9;
  var BOX = 3;
  var CELL_COUNT = SIZE * SIZE;
  var BLANKS = 45;
  var MAX_PUZZLE_TRIES = 20;
  var TOAST_MS = 2000;

  // Bits 1-9 of a candidate mask: bit d is set while digit d may go in a cell.
  var ALL_DIGITS = 0x3fe;

  var TEXT = {
    saved: 'Game saved',
    victory: 'Victory!',
    solved: '🎉 Puzzle solved!'
  };

  var IDS = {
    board: 'sdk-board',
    status: 'sdk-status',
    toast: 'sdk-toast',
    newGame: 'sdk-new-game-btn',
    restart: 'sdk-restart-btn',
    hint: 'sdk-hint-btn'
  };

  var CLS = {
    cell: 'sdk-cell',
    fixed: 'sdk-cell-fixed',
    invalid: 'sdk-cell-invalid',
    right: 'sdk-cell-right-border',
    bottom: 'sdk-cell-bottom-border',
    show: 'sdk-show'
  };

  // ── Puzzle logic (pure) ───────────────────────────────────────────────────

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

  // A copy of the array in random order (Fisher-Yates: every order is equally
  // likely).
  function shuffle(array) {
    var copy = array.slice();
    var i;
    var j;
    var swap;

    for (i = copy.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }

  // The digits not used yet in the row, the column and the 3x3 box of a cell,
  // as a mask (see ALL_DIGITS).  The cell's own digit counts as used.
  function candidateMask(board, row, col) {
    var boxRow = row - (row % BOX);
    var boxCol = col - (col % BOX);
    var used = 0;
    var i;

    for (i = 0; i < SIZE; i++) {
      used |= 1 << board[row][i];
      used |= 1 << board[i][col];
      used |= 1 << board[boxRow + Math.floor(i / BOX)][boxCol + (i % BOX)];
    }
    return ALL_DIGITS & ~used;
  }

  // True when num is not in the row, the column or the 3x3 box of the cell.
  function isValid(board, row, col, num) {
    return (candidateMask(board, row, col) & (1 << num)) !== 0;
  }

  function digitsOf(mask) {
    var digits = [];
    var digit;

    for (digit = 1; digit <= SIZE; digit++) {
      if (mask & (1 << digit)) {
        digits.push(digit);
      }
    }
    return digits;
  }

  // True when no digit on the board repeats in its row, column or box.
  function isConsistent(board) {
    var row;
    var col;
    var digit;
    var valid;

    for (row = 0; row < SIZE; row++) {
      for (col = 0; col < SIZE; col++) {
        digit = board[row][col];
        if (digit !== 0) {
          board[row][col] = 0;
          valid = isValid(board, row, col, digit);
          board[row][col] = digit;
          if (!valid) {
            return false;
          }
        }
      }
    }
    return true;
  }

  // The empty cell with the fewest candidates as { row, col, digits }, or null
  // when the board is full.  Trying the most constrained cell first keeps the
  // searches below small.
  function mostConstrainedCell(board) {
    var best = null;
    var row;
    var col;
    var digits;

    for (row = 0; row < SIZE; row++) {
      for (col = 0; col < SIZE; col++) {
        if (board[row][col] === 0) {
          digits = digitsOf(candidateMask(board, row, col));
          if (!best || digits.length < best.digits.length) {
            best = { row: row, col: col, digits: digits };
            if (digits.length < 2) {
              return best;
            }
          }
        }
      }
    }
    return best;
  }

  function fillRandomly(board) {
    var cell = mostConstrainedCell(board);
    var digits;
    var i;

    if (!cell) {
      return true;
    }
    digits = shuffle(cell.digits);
    for (i = 0; i < digits.length; i++) {
      board[cell.row][cell.col] = digits[i];
      if (fillRandomly(board)) {
        return true;
      }
    }
    board[cell.row][cell.col] = 0;
    return false;
  }

  // Fills the empty cells of the board in place with a random valid solution.
  // Returns false, with the board as it was, when there is none.
  function solveBoard(board) {
    return isConsistent(board) && fillRandomly(board);
  }

  function countFrom(board, limit) {
    var cell = mostConstrainedCell(board);
    var count = 0;
    var i;

    if (!cell) {
      return 1;
    }
    for (i = 0; i < cell.digits.length && count < limit; i++) {
      board[cell.row][cell.col] = cell.digits[i];
      count += countFrom(board, limit - count);
    }
    board[cell.row][cell.col] = 0;
    return count;
  }

  // How many solutions the board has, counting up to limit (default 2: enough
  // to tell a proper puzzle from an ambiguous one).  The board is left alone.
  function countSolutions(board, limit) {
    var copy = copyBoard(board);

    return isConsistent(copy) ? countFrom(copy, limit || 2) : 0;
  }

  function generateSolvedBoard() {
    var board = createEmptyBoard();

    solveBoard(board);
    return board;
  }

  // A copy of the board with up to `blanks` more cells emptied.  The cells are
  // visited once in random order, and one is emptied only while the puzzle
  // keeps exactly one solution, so fewer cells are emptied when no more can go.
  function removeNumbers(board, blanks) {
    var puzzle = copyBoard(board);
    var order = [];
    var removed = 0;
    var i;
    var row;
    var col;
    var digit;

    for (i = 0; i < CELL_COUNT; i++) {
      order.push(i);
    }
    order = shuffle(order);

    for (i = 0; i < CELL_COUNT && removed < blanks; i++) {
      row = Math.floor(order[i] / SIZE);
      col = order[i] % SIZE;
      digit = puzzle[row][col];
      if (digit !== 0) {
        puzzle[row][col] = 0;
        if (countSolutions(puzzle, 2) === 1) {
          removed++;
        } else {
          puzzle[row][col] = digit;
        }
      }
    }
    return puzzle;
  }

  function boardToString(board) {
    return board.map(function (row) {
      return row.join('');
    }).join('');
  }

  function stringToGrid(text) {
    var board = createEmptyBoard();
    var i;

    for (i = 0; i < CELL_COUNT; i++) {
      board[Math.floor(i / SIZE)][i % SIZE] = Number(text.charAt(i));
    }
    return board;
  }

  // A new game as 81-character strings { puzzle, solution }: a random solved
  // grid with `blanks` cells (default BLANKS) emptied and exactly one solution.
  // Almost every grid gets there at the first try; after MAX_PUZZLE_TRIES the
  // last puzzle is kept with the blanks it has.
  function generatePuzzle(blanks) {
    var wanted = blanks === undefined ? BLANKS : blanks;
    var solved;
    var puzzle;
    var tries;

    for (tries = 0; tries < MAX_PUZZLE_TRIES; tries++) {
      solved = generateSolvedBoard();
      puzzle = boardToString(removeNumbers(solved, wanted));
      if (puzzle.split('0').length - 1 >= wanted) {
        break;
      }
    }
    return { puzzle: puzzle, solution: boardToString(solved) };
  }

  function keepsGivens(text, puzzle) {
    var i;
    var given;

    for (i = 0; i < CELL_COUNT; i++) {
      given = puzzle.charAt(i);
      if (given !== '0' && given !== text.charAt(i)) {
        return false;
      }
    }
    return true;
  }

  // True when text is a finished grid (81 digits 1-9, none repeated in a row,
  // column or box) that keeps every given of the puzzle.
  function isCompleteValidGrid(text, puzzle) {
    return typeof text === 'string' && /^[1-9]{81}$/.test(text) &&
      keepsGivens(text, puzzle) && isConsistent(stringToGrid(text));
  }

  // The cells a hint may fill: the empty or wrong ones (different from the
  // solution).  Givens always match the solution, so they never qualify.
  function hintCandidates(board, solution) {
    var list = [];
    var i;

    for (i = 0; i < board.length; i++) {
      if (board[i] !== solution.charAt(i)) {
        list.push(i);
      }
    }
    return list;
  }

  // One digit 1-9, or '' for an empty cell, from whatever a cell input holds.
  // When it holds several digits (an IME, autofill or paste that ignores
  // maxlength) the new one wins: the last digit that differs from `previous`.
  function normalizeDigit(value, previous) {
    var digits = String(value).replace(/[^1-9]/g, '');
    var i;

    for (i = digits.length - 1; i > 0; i--) {
      if (digits.charAt(i) !== previous) {
        return digits.charAt(i);
      }
    }
    return digits.charAt(0);
  }

  // ── Saves ─────────────────────────────────────────────────────────────────
  //
  // The save is JSON { puzzle, solution, board } of 81-digit strings, the
  // format every version has written.  Storage that is blocked or full never
  // stops the game: the helpers swallow the error.

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      // Nothing to do: a save that cannot be removed cannot be read either.
    }
  }

  function isBoardText(value) {
    return typeof value === 'string' && /^[0-9]{81}$/.test(value);
  }

  // The board with every given of the puzzle in its place.
  function withGivens(board, puzzle) {
    var out = '';
    var i;

    for (i = 0; i < CELL_COUNT; i++) {
      out += puzzle.charAt(i) === '0' ? board.charAt(i) : puzzle.charAt(i);
    }
    return out;
  }

  // A saved game as { puzzle, solution, board }, or null when raw is missing,
  // not JSON or not a playable game: the puzzle and the board must be 81
  // digits and the solution a valid grid that keeps the puzzle's givens.
  function parseSave(raw) {
    var data;

    try {
      data = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!data || !isBoardText(data.puzzle) || !isBoardText(data.board) ||
      !isCompleteValidGrid(data.solution, data.puzzle)) {
      return null;
    }
    return {
      puzzle: data.puzzle,
      solution: data.solution,
      board: withGivens(data.board, data.puzzle)
    };
  }

  // ── Game state ────────────────────────────────────────────────────────────

  // board holds one character per cell ('0' = empty); won is true while the
  // board is a finished valid grid.
  var state = { puzzle: '', solution: '', board: [], won: false };

  function setGame(puzzle, solution, board) {
    state.puzzle = puzzle;
    state.solution = solution;
    state.board = board.split('');
    state.won = false;
  }

  function saveGame() {
    var saved = storageSet(STORAGE_KEY, JSON.stringify({
      puzzle: state.puzzle,
      solution: state.solution,
      board: state.board.join('')
    }));

    if (saved) {
      showToast(TEXT.saved);
    }
  }

  // Restores the saved game.  A missing or broken save is removed and false
  // returned, so the caller starts a new game.
  function loadGame() {
    var game = parseSave(storageGet(STORAGE_KEY));

    if (!game) {
      storageRemove(STORAGE_KEY);
      return false;
    }
    setGame(game.puzzle, game.solution, game.board);
    // A save from an older version can hold a finished grid it did not accept.
    checkWin();
    render();
    return true;
  }

  // ── Page elements and rendering ───────────────────────────────────────────

  var ui = null;

  function byId(id) {
    return document.getElementById(id);
  }

  // The page elements, looked up on first use (from init), not while the
  // script loads: the embed may load it before the markup exists.
  function getUi() {
    if (!ui) {
      ui = {
        board: byId(IDS.board),
        status: byId(IDS.status),
        toast: byId(IDS.toast),
        cells: []
      };
    }
    return ui;
  }

  function createCell(index) {
    var input = document.createElement('input');
    var row = Math.floor(index / SIZE);
    var col = index % SIZE;

    input.type = 'tel';
    input.inputMode = 'numeric';
    input.pattern = '[1-9]*';
    input.maxLength = 1;
    input.className = CLS.cell;
    // Thick lines after the third and sixth column and row.
    if (col % BOX === BOX - 1 && col !== SIZE - 1) {
      input.classList.add(CLS.right);
    }
    if (row % BOX === BOX - 1 && row !== SIZE - 1) {
      input.classList.add(CLS.bottom);
    }
    return input;
  }

  // The 81 cell inputs, built once; later renders only update them, so the
  // focused cell keeps its focus.
  function ensureCells() {
    var refs = getUi();
    var i;
    var cell;

    if (!refs.cells.length) {
      for (i = 0; i < CELL_COUNT; i++) {
        cell = createCell(i);
        refs.cells.push(cell);
        refs.board.appendChild(cell);
      }
      refs.board.addEventListener('input', handleBoardInput);
    }
    return refs.cells;
  }

  function renderCell(cell, index) {
    var given = state.puzzle.charAt(index) !== '0';
    var digit = state.board[index];
    var value = digit === '0' ? '' : digit;

    if (cell.value !== value) {
      cell.value = value;
    }
    cell.disabled = given;
    cell.classList.toggle(CLS.fixed, given);
    cell.classList.toggle(CLS.invalid, value !== '' && digit !== state.solution.charAt(index));
  }

  function render() {
    var cells = ensureCells();
    var i;

    for (i = 0; i < CELL_COUNT; i++) {
      renderCell(cells[i], i);
    }
    getUi().status.textContent = state.won ? TEXT.solved : '';
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // One 'input' listener on the board serves every cell.  Givens are disabled
  // and ignored here too.
  function handleBoardInput(event) {
    var cell = event.target;
    var index = getUi().cells.indexOf(cell);
    var previous;
    var digit;

    if (index === -1 || state.puzzle.charAt(index) !== '0') {
      return;
    }
    previous = state.board[index] === '0' ? '' : state.board[index];
    digit = normalizeDigit(cell.value, previous);
    cell.value = digit;
    if (digit !== previous) {
      state.board[index] = digit || '0';
      commitMove();
    }
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  var toastTimer = null;

  function hideToast() {
    toastTimer = null;
    getUi().toast.classList.remove(CLS.show);
  }

  // Shows the message for TOAST_MS; a newer toast replaces the timer of an
  // older one, so every message stays the full time.
  function showToast(message) {
    var toast = getUi().toast;

    toast.textContent = message;
    toast.classList.add(CLS.show);
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(hideToast, TOAST_MS);
  }

  // ── Game actions ──────────────────────────────────────────────────────────

  // Any finished grid that follows the rules and keeps the givens wins.  A
  // puzzle saved by an older version can have more than one solution, so the
  // winning grid becomes the solution and no cell stays marked wrong.
  function checkWin() {
    var board = state.board.join('');

    state.won = isCompleteValidGrid(board, state.puzzle);
    if (state.won) {
      state.solution = board;
      storageRemove(STORAGE_KEY);
      showToast(TEXT.victory);
    }
    return state.won;
  }

  // After the player or a hint changed the board: a win removes the save,
  // anything else is saved.
  function commitMove() {
    if (!checkWin()) {
      saveGame();
    }
    render();
  }

  function newGame() {
    var game = generatePuzzle();

    setGame(game.puzzle, game.solution, game.puzzle);
    render();
    saveGame();
  }

  function restartGame() {
    if (!state.puzzle) {
      return;
    }
    setGame(state.puzzle, state.solution, state.puzzle);
    render();
    saveGame();
  }

  function giveHint() {
    var candidates = hintCandidates(state.board, state.solution);
    var index;

    if (!candidates.length) {
      return;
    }
    index = candidates[Math.floor(Math.random() * candidates.length)];
    state.board[index] = state.solution.charAt(index);
    commitMove();
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  var initialised = false;

  function init() {
    if (initialised) {
      return;
    }
    initialised = true;
    byId(IDS.newGame).addEventListener('click', newGame);
    byId(IDS.restart).addEventListener('click', restartGame);
    byId(IDS.hint).addEventListener('click', giveHint);
    if (!loadGame()) {
      newGame();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else if (typeof module === 'undefined' || !module.exports) {
    init();
  }

  window.sdkNewGame = newGame;
  window.sdkRestartGame = restartGame;
  window.sdkGiveHint = giveHint;

  /* Node test export (no effect in browsers) */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      STORAGE_KEY: STORAGE_KEY,
      BLANKS: BLANKS,
      createEmptyBoard: createEmptyBoard,
      shuffle: shuffle,
      isValid: isValid,
      solveBoard: solveBoard,
      countSolutions: countSolutions,
      generateSolvedBoard: generateSolvedBoard,
      removeNumbers: removeNumbers,
      generatePuzzle: generatePuzzle,
      boardToString: boardToString,
      stringToGrid: stringToGrid,
      isCompleteValidGrid: isCompleteValidGrid,
      hintCandidates: hintCandidates,
      normalizeDigit: normalizeDigit,
      parseSave: parseSave,
      loadGame: loadGame,
      newGame: newGame,
      restartGame: restartGame,
      giveHint: giveHint,
      init: init
    };
  }
})();
