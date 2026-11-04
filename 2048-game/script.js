// 2048 Game — script.js
// Prefix: tf8-
// Dependencies: none.
(function () {
  'use strict';

  var STORAGE_KEY = 'tf8-2048-game';
  var BEST_SCORE_KEY = 'tf8-2048-best-score';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var boardElement = $('tf8-board');
  var scoreElement = $('tf8-score');
  var bestScoreElement = $('tf8-best-score');
  var messageElement = $('tf8-message');
  var toastElement = $('tf8-toast');

  var board = [];
  var score = 0;
  var bestScore = 0;

  var history = [];
  var MAX_HISTORY = 10;

  var touchStartX = 0;
  var touchStartY = 0;

  function showToast(message) {
    toastElement.textContent = message;

    toastElement.classList.add('tf8-show');

    setTimeout(function () {
      toastElement.classList.remove('tf8-show');
    }, 1800);
  }

  function createEmptyBoard() {
    return [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ];
  }

  function randomCell() {
    var empty = [];

    var row;
    var col;

    for (row = 0; row < 4; row++) {
      for (col = 0; col < 4; col++) {
        if (board[row][col] === 0) {
          empty.push({
            row: row,
            col: col
          });
        }
      }
    }

    if (!empty.length) {
      return null;
    }

    return empty[
      Math.floor(Math.random() * empty.length)
    ];
  }

  function addRandomTile() {
    var cell = randomCell();

    if (!cell) {
      return;
    }

    board[cell.row][cell.col] =
      Math.random() < 0.9 ? 2 : 4;
  }

  function renderBoard() {
    boardElement.innerHTML = '';

    var row;
    var col;

    for (row = 0; row < 4; row++) {
      for (col = 0; col < 4; col++) {
        var value = board[row][col];

        var tile = document.createElement('div');

        tile.className =
          'tf8-tile tf8-tile-' + value;

        tile.textContent =
          value === 0 ? '' : value;

        boardElement.appendChild(tile);
      }
    }

    scoreElement.textContent = score;
    bestScoreElement.textContent = bestScore;
  }

  function rotateBoardClockwise(matrix) {
    var result = createEmptyBoard();

    var row;
    var col;

    for (row = 0; row < 4; row++) {
      for (col = 0; col < 4; col++) {
        result[col][3 - row] = matrix[row][col];
      }
    }

    return result;
  }

  function slide(row) {
    row = row.filter(function (value) {
      return value !== 0;
    });

    var i;

    for (i = 0; i < row.length - 1; i++) {
      if (row[i] === row[i + 1]) {
        row[i] *= 2;

        score += row[i];

        row[i + 1] = 0;
      }
    }

    row = row.filter(function (value) {
      return value !== 0;
    });

    while (row.length < 4) {
      row.push(0);
    }

    return row;
  }

  function copyBoard(src) {
    return src.map(function (row) {
      return row.slice();
    });
  }

  function savePreviousState() {
	history.push({
	  board: copyBoard(board),
	  score: score
	});
	if (history.length > MAX_HISTORY) {
	  history.shift();
	}
  }

  function moveLeft() {
//    savePreviousState();

    var changed = false;

    var row;

    for (row = 0; row < 4; row++) {
      var original = board[row].join(',');

      board[row] = slide(board[row]);

      if (original !== board[row].join(',')) {
        changed = true;
      }
    }

    return changed;
  }

  function moveRight() {
    rotateTwice();

    var changed = moveLeft();

    rotateTwice();

    return changed;
  }

  function moveUp() {
    rotateLeft();

    var changed = moveLeft();

    rotateRight();

    return changed;
  }

  function moveDown() {
    rotateRight();

    var changed = moveLeft();

    rotateLeft();

    return changed;
  }

  function rotateLeft() {
    board = rotateBoardClockwise(board);
    board = rotateBoardClockwise(board);
    board = rotateBoardClockwise(board);
  }

  function rotateRight() {
    board = rotateBoardClockwise(board);
  }

  function rotateTwice() {
    board = rotateBoardClockwise(board);
    board = rotateBoardClockwise(board);
  }

  function canMove() {
    var row;
    var col;

    for (row = 0; row < 4; row++) {
      for (col = 0; col < 4; col++) {
        if (board[row][col] === 0) {
          return true;
        }

        if (
          col < 3 &&
          board[row][col] === board[row][col + 1]
        ) {
          return true;
        }

        if (
          row < 3 &&
          board[row][col] === board[row + 1][col]
        ) {
          return true;
        }
      }
    }

    return false;
  }

  function saveGame() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        board: board,
        score: score
      })
    );

    localStorage.setItem(
      BEST_SCORE_KEY,
      String(bestScore)
    );
  }

  function loadGame() {
    var saved = localStorage.getItem(STORAGE_KEY);

    var savedBest = localStorage.getItem(BEST_SCORE_KEY);

    if (savedBest) {
      bestScore = parseInt(savedBest, 10) || 0;
    }

    if (!saved) {
      return false;
    }

    var data = JSON.parse(saved);

    board = data.board;
    score = data.score || 0;

    renderBoard();

    return true;
  }

  function newGame() {
    board = createEmptyBoard();

    score = 0;

    messageElement.textContent = '';

    addRandomTile();
    addRandomTile();

    renderBoard();

    saveGame();
  }

  function restartGame() {
    newGame();

    showToast('Restarted');
  }

  function undoMove() {
    if (!history.length) {
      return;
    }
    var state = history.pop();
    board = copyBoard(state.board);
    score = state.score;
    renderBoard();
    saveGame();
  
    showToast('Undo');
  }

  function handleMove(direction) {
	savePreviousState(); 

	var changed = false;

	if (direction === 'left')  { changed = moveLeft();  }
	if (direction === 'right') { changed = moveRight(); }
	if (direction === 'up')    { changed = moveUp();    }
	if (direction === 'down')  { changed = moveDown();  }

    if (!changed) {
      return;
    }

    addRandomTile();

    if (score > bestScore) {
      bestScore = score;
    }

    renderBoard();

    saveGame();

    if (!canMove()) {
      messageElement.textContent =
        '💀 Game Over';
    }

    if (has2048()) {
      messageElement.textContent =
        '🎉 You reached 2048!';
    }
  }

  function has2048() {
    var row;
    var col;

    for (row = 0; row < 4; row++) {
      for (col = 0; col < 4; col++) {
        if (board[row][col] === 2048) {
          return true;
        }
      }
    }

    return false;
  }

  function init() {
  document.addEventListener(
    'keydown',
    function (event) {
      if (event.key === 'ArrowLeft') {
        handleMove('left');
      }

      if (event.key === 'ArrowRight') {
        handleMove('right');
      }

      if (event.key === 'ArrowUp') {
        handleMove('up');
      }

      if (event.key === 'ArrowDown') {
        handleMove('down');
      }
    }
  );

  boardElement.addEventListener(
    'touchstart',
    function (event) {
      touchStartX =
        event.touches[0].clientX;

      touchStartY =
        event.touches[0].clientY;
    },
    { passive: true }
  );

  boardElement.addEventListener(
    'touchend',
    function (event) {
      var dx =
        event.changedTouches[0].clientX -
        touchStartX;

      var dy =
        event.changedTouches[0].clientY -
        touchStartY;

      if (
        Math.abs(dx) > Math.abs(dy)
      ) {
        if (dx > 40) {
          handleMove('right');
        }

        if (dx < -40) {
          handleMove('left');
        }
      } else {
        if (dy > 40) {
          handleMove('down');
        }

        if (dy < -40) {
          handleMove('up');
        }
      }
    },
    { passive: true }
  );

  $('tf8-new-game-btn')
    .addEventListener(
      'click',
      newGame
    );

  $('tf8-restart-btn')
    .addEventListener(
      'click',
      restartGame
    );

  $('tf8-undo-btn')
    .addEventListener(
      'click',
      undoMove
    );

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
      MAX_HISTORY: MAX_HISTORY,
      createEmptyBoard: createEmptyBoard,
      rotateBoardClockwise: rotateBoardClockwise,
      slide: slide,
      copyBoard: copyBoard,
      randomCell: randomCell,
      addRandomTile: addRandomTile,
      renderBoard: renderBoard,
      moveLeft: moveLeft,
      moveRight: moveRight,
      moveUp: moveUp,
      moveDown: moveDown,
      canMove: canMove,
      has2048: has2048,
      saveGame: saveGame,
      loadGame: loadGame,
      newGame: newGame,
      restartGame: restartGame,
      undoMove: undoMove,
      handleMove: handleMove
    };
  }
})();