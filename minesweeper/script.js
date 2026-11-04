// Minesweeper Game — script.js
// Prefix: msp-
// Dependencies: none.

(function () {
  'use strict';

  var mspState = {
    rows: 9,
    cols: 9,
    mines: 10,
    board: [],
    revealed: 0,
    flagged: 0,
    firstClick: true,
    timer: 0,
    interval: null,
    gameOver: false,
    difficulty: 'easy'
  };

  var mspDifficulties = {
    easy: {
      rows: 9,
      cols: 9,
      mines: 10
    },
    medium: {
      rows: 14,
      cols: 14,
      mines: 35
    },
    hard: {
      rows: 18,
      cols: 18,
      mines: 65
    }
  };

  var mspBoardElement = document.getElementById('msp-board');
  var mspMineCounter = document.getElementById('msp-mine-counter');
  var mspTimer = document.getElementById('msp-timer');
  var mspStatus = document.getElementById('msp-status-text');
  var mspToast = document.getElementById('msp-toast');
  var mspBestTime = document.getElementById('msp-best-time');

  function mspCreateBoard() {
    mspState.board = [];
    mspState.revealed = 0;
    mspState.flagged = 0;
    mspState.firstClick = true;
    mspState.gameOver = false;
    mspState.timer = 0;

    clearInterval(mspState.interval);

    var row;
    var col;

    for (row = 0; row < mspState.rows; row++) {

      var rowData = [];

      for (col = 0; col < mspState.cols; col++) {

        rowData.push({
          mine: false,
          revealed: false,
          flagged: false,
          adjacent: 0
        });

      }

      mspState.board.push(rowData);
    }

    mspRenderBoard();
    mspUpdateStats();
    mspSaveGame();
  }

  function mspPlaceMines(safeRow, safeCol) {

    var placed = 0;

    while (placed < mspState.mines) {

      var row = Math.floor(Math.random() * mspState.rows);
      var col = Math.floor(Math.random() * mspState.cols);

      if (
        !mspState.board[row][col].mine &&
        !(row === safeRow && col === safeCol)
      ) {

        mspState.board[row][col].mine = true;
        placed++;

      }
    }

    mspCalculateAdjacency();
  }

  function mspCalculateAdjacency() {

    var row;
    var col;

    for (row = 0; row < mspState.rows; row++) {

      for (col = 0; col < mspState.cols; col++) {

        var count = 0;

        for (var dr = -1; dr <= 1; dr++) {

          for (var dc = -1; dc <= 1; dc++) {

            var nr = row + dr;
            var nc = col + dc;

            if (
              nr >= 0 &&
              nr < mspState.rows &&
              nc >= 0 &&
              nc < mspState.cols &&
              mspState.board[nr][nc].mine
            ) {
              count++;
            }

          }
        }

        mspState.board[row][col].adjacent = count;
      }
    }
  }

  function mspRenderBoard() {

    mspBoardElement.innerHTML = '';

    mspBoardElement.style.gridTemplateColumns =
      'repeat(' + mspState.cols + ', 42px)';

    for (var row = 0; row < mspState.rows; row++) {

      for (var col = 0; col < mspState.cols; col++) {

        var cell = mspState.board[row][col];

        var button = document.createElement('button');

        button.className = 'msp-cell';

        button.setAttribute('data-row', row);
        button.setAttribute('data-col', col);

        button.setAttribute(
          'aria-label',
          'Cell ' + row + ' ' + col
        );

        if (cell.revealed) {

          button.classList.add('msp-cell-revealed');

          if (cell.mine) {

            button.classList.add('msp-cell-mine');
            button.textContent = '✹';

          } else if (cell.adjacent > 0) {

            button.textContent = cell.adjacent;

          }
        }

        if (cell.flagged) {

          button.classList.add('msp-cell-flagged');
          button.textContent = '⚑';

        }

        button.addEventListener('click', mspHandleReveal);
        button.addEventListener('contextmenu', mspHandleFlag);

        mspBoardElement.appendChild(button);
      }
    }
  }

  function mspHandleReveal(event) {

    if (mspState.gameOver) {
      return;
    }

    var row = parseInt(
      event.currentTarget.getAttribute('data-row'),
      10
    );

    var col = parseInt(
      event.currentTarget.getAttribute('data-col'),
      10
    );

    var cell = mspState.board[row][col];

    if (cell.flagged || cell.revealed) {
      return;
    }

    if (mspState.firstClick) {

      mspPlaceMines(row, col);

      mspState.firstClick = false;

      mspStartTimer();
    }

    cell.revealed = true;
    mspState.revealed++;

    if (cell.mine) {

      mspRevealAllMines();
      mspLoseGame();
      return;
    }

    if (cell.adjacent === 0) {
      mspFloodReveal(row, col);
    }

    mspCheckWin();
    mspRenderBoard();
    mspSaveGame();
  }

  function mspFloodReveal(row, col) {

    for (var dr = -1; dr <= 1; dr++) {

      for (var dc = -1; dc <= 1; dc++) {

        var nr = row + dr;
        var nc = col + dc;

        if (
          nr >= 0 &&
          nr < mspState.rows &&
          nc >= 0 &&
          nc < mspState.cols
        ) {

          var neighbor = mspState.board[nr][nc];

          if (
            !neighbor.revealed &&
            !neighbor.mine &&
            !neighbor.flagged
          ) {

            neighbor.revealed = true;
            mspState.revealed++;

            if (neighbor.adjacent === 0) {
              mspFloodReveal(nr, nc);
            }
          }
        }
      }
    }
  }

  function mspHandleFlag(event) {

    event.preventDefault();

    if (mspState.gameOver) {
      return;
    }

    var row = parseInt(
      event.currentTarget.getAttribute('data-row'),
      10
    );

    var col = parseInt(
      event.currentTarget.getAttribute('data-col'),
      10
    );

    var cell = mspState.board[row][col];

    if (cell.revealed) {
      return;
    }

    cell.flagged = !cell.flagged;

    if (cell.flagged) {
      mspState.flagged++;
    } else {
      mspState.flagged--;
    }

    mspUpdateStats();
    mspRenderBoard();
    mspSaveGame();
  }

  function mspRevealAllMines() {

    for (var row = 0; row < mspState.rows; row++) {

      for (var col = 0; col < mspState.cols; col++) {

        if (mspState.board[row][col].mine) {

          mspState.board[row][col].revealed = true;

        }
      }
    }
  }

  function mspCheckWin() {

    var safeCells =
      (mspState.rows * mspState.cols) - mspState.mines;

    if (mspState.revealed >= safeCells) {

      mspState.gameOver = true;

      clearInterval(mspState.interval);

      mspStatus.textContent = 'Mission completed.';

      mspShowToast('Victory achieved.');

      mspSaveBestTime();
    }
  }

  function mspLoseGame() {

    mspState.gameOver = true;

    clearInterval(mspState.interval);

    mspStatus.textContent = 'Mine triggered.';

    mspShowToast('System failure detected.');

    mspRenderBoard();
  }

  function mspUpdateStats() {

    mspMineCounter.textContent =
      mspState.mines - mspState.flagged;

    mspTimer.textContent = mspState.timer;

    var best = localStorage.getItem(
      'msp-best-' + mspState.difficulty
    );

    mspBestTime.textContent = best || '--';
  }

  function mspStartTimer() {

    mspState.interval = setInterval(function () {

      mspState.timer++;

      mspUpdateStats();

      mspSaveGame();

    }, 1000);
  }

  function mspShowToast(message) {

    mspToast.textContent = message;

    mspToast.classList.add('msp-toast-visible');

    setTimeout(function () {

      mspToast.classList.remove('msp-toast-visible');

    }, 2000);
  }

  function mspSaveBestTime() {

    var key = 'msp-best-' + mspState.difficulty;

    var current = localStorage.getItem(key);

    if (
      !current ||
      mspState.timer < parseInt(current, 10)
    ) {

      localStorage.setItem(
        key,
        mspState.timer
      );

    }

    mspUpdateStats();
  }

  function mspSaveGame() {

    var saveData = JSON.stringify(mspState);

    localStorage.setItem(
      'msp-save-state',
      saveData
    );
  }

  function mspLoadGame() {

    var saveData = localStorage.getItem(
      'msp-save-state'
    );

    if (!saveData) {
      return false;
    }

    try {

      var parsed = JSON.parse(saveData);

      mspState.rows = parsed.rows;
      mspState.cols = parsed.cols;
      mspState.mines = parsed.mines;
      mspState.board = parsed.board;
      mspState.revealed = parsed.revealed;
      mspState.flagged = parsed.flagged;
      mspState.firstClick = parsed.firstClick;
      mspState.timer = parsed.timer;
      mspState.gameOver = parsed.gameOver;
      mspState.difficulty = parsed.difficulty;

      mspRenderBoard();
      mspUpdateStats();

      if (!mspState.gameOver && !mspState.firstClick) {
        mspStartTimer();
      }

      return true;

    } catch (error) {

      return false;

    }
  }

  function mspApplyDifficulty(level) {

    var settings = mspDifficulties[level];

    mspState.rows = settings.rows;
    mspState.cols = settings.cols;
    mspState.mines = settings.mines;
    mspState.difficulty = level;

    mspCreateBoard();
  }

  function mspBindEvents() {

    document
      .getElementById('msp-new-game')
      .addEventListener('click', function () {

        mspApplyDifficulty(
          document.getElementById('msp-difficulty').value
        );

      });

    document
      .getElementById('msp-restart-game')
      .addEventListener('click', function () {

        mspApplyDifficulty(
          mspState.difficulty
        );

      });

    document
      .getElementById('msp-difficulty')
      .addEventListener('change', function (event) {

        mspApplyDifficulty(event.target.value);

      });

    document.addEventListener('keydown', function (event) {

      if (event.key === 'r') {

        mspApplyDifficulty(
          mspState.difficulty
        );

      }

    });
  }

  function mspInit() {

    mspBindEvents();

    if (!mspLoadGame()) {

      mspApplyDifficulty('easy');

    }

    mspStatus.textContent =
      'Awaiting tactical deployment.';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mspInit);
  } else if (typeof module === 'undefined' || !module.exports) {
    mspInit();
  }

  /* Node test export (no effect in browsers) */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      mspState: mspState,
      mspDifficulties: mspDifficulties,
      mspCreateBoard: mspCreateBoard,
      mspPlaceMines: mspPlaceMines,
      mspCalculateAdjacency: mspCalculateAdjacency,
      mspFloodReveal: mspFloodReveal,
      mspRevealAllMines: mspRevealAllMines,
      mspCheckWin: mspCheckWin,
      mspHandleReveal: mspHandleReveal,
      mspHandleFlag: mspHandleFlag,
      mspSaveBestTime: mspSaveBestTime,
      mspSaveGame: mspSaveGame,
      mspLoadGame: mspLoadGame,
      mspApplyDifficulty: mspApplyDifficulty
    };
  }

})();
