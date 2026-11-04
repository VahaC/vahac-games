// Sudoku Game — script.js
// Prefix: sdk-
// Dependencies: none.

(function () {
  'use strict';

  var STORAGE_KEY = 'sdk-sudoku-game';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var boardElement = $('sdk-board');
  var statusElement = $('sdk-status');
  var toastElement = $('sdk-toast');

  var currentPuzzle = '';
  var currentSolution = '';
  var currentBoard = [];

  function showToast(message) {
    toastElement.textContent = message;

    toastElement.classList.add('sdk-show');

    setTimeout(function () {
      toastElement.classList.remove('sdk-show');
    }, 2000);
  }

  function createEmptyBoard() {
    return Array.from(
      { length: 9 },
      function () {
        return Array(9).fill(0);
      }
    );
  }

  function shuffle(array) {
    return array
      .slice()
      .sort(function () {
        return Math.random() - 0.5;
      });
  }

  function isValid(board, row, col, num) {
    var i;
    var r;
    var c;

    for (i = 0; i < 9; i++) {
      if (board[row][i] === num) {
        return false;
      }

      if (board[i][col] === num) {
        return false;
      }
    }

    var startRow = row - (row % 3);
    var startCol = col - (col % 3);

    for (r = 0; r < 3; r++) {
      for (c = 0; c < 3; c++) {
        if (
          board[startRow + r][startCol + c] === num
        ) {
          return false;
        }
      }
    }

    return true;
  }

  function solveBoard(board) {
    var row;
    var col;

    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        if (board[row][col] === 0) {
          var numbers = shuffle([
            1, 2, 3, 4, 5, 6, 7, 8, 9
          ]);

          var i;

          for (i = 0; i < numbers.length; i++) {
            var num = numbers[i];

            if (
              isValid(
                board,
                row,
                col,
                num
              )
            ) {
              board[row][col] = num;

              if (solveBoard(board)) {
                return true;
              }

              board[row][col] = 0;
            }
          }

          return false;
        }
      }
    }

    return true;
  }

  function generateSolvedBoard() {
    var board = createEmptyBoard();

    solveBoard(board);

    return board;
  }

  function removeNumbers(board, difficulty) {
    var puzzle = board.map(function (row) {
      return row.slice();
    });

    var removed = 0;

    while (removed < difficulty) {
      var row = Math.floor(
        Math.random() * 9
      );

      var col = Math.floor(
        Math.random() * 9
      );

      if (puzzle[row][col] !== 0) {
        puzzle[row][col] = 0;

        removed++;
      }
    }

    return puzzle;
  }

  function boardToString(board) {
    return board.flat().join('');
  }

  function createBoardUI() {
    boardElement.innerHTML = '';

    var i;

    for (i = 0; i < 81; i++) {
      createCell(i);
    }

    validateBoard();
  }

  function createCell(index) {
    var input =
      document.createElement('input');

    input.type = 'tel';
    input.inputMode = 'numeric';
    input.pattern = '[1-9]*';
    input.maxLength = 1;

    input.className = 'sdk-cell';

    var row = Math.floor(index / 9);
    var col = index % 9;

    if (
      (col + 1) % 3 === 0 &&
      col !== 8
    ) {
      input.classList.add(
        'sdk-cell-right-border'
      );
    }

    if (
      (row + 1) % 3 === 0 &&
      row !== 8
    ) {
      input.classList.add(
        'sdk-cell-bottom-border'
      );
    }

    var puzzleValue =
      currentPuzzle[index];

    var boardValue =
      currentBoard[index];

    if (puzzleValue !== '0') {
      input.value = puzzleValue;

      input.disabled = true;

      input.classList.add(
        'sdk-cell-fixed'
      );
    } else {
      if (boardValue !== '0') {
        input.value = boardValue;
      }

      input.addEventListener(
        'input',
        function () {
          handleInput(input, index);
        }
      );
    }

    boardElement.appendChild(input);
  }

  function handleInput(input, index) {
    var value = input.value.replace(
      /[^1-9]/g,
      ''
    );

    input.value = value;

    currentBoard[index] =
      value || '0';

    validateBoard();

    saveGame();

    checkWin();
  }

  function validateBoard() {
    var cells =
      document.querySelectorAll(
        '.sdk-cell'
      );

    cells.forEach(function (cell) {
      cell.classList.remove(
        'sdk-cell-invalid'
      );
    });

    var i;

    for (i = 0; i < 81; i++) {
      var value = currentBoard[i];

      if (value === '0') {
        continue;
      }

      if (
        value !== currentSolution[i]
      ) {
        cells[i].classList.add(
          'sdk-cell-invalid'
        );
      }
    }
  }

  function checkWin() {
    if (
      currentBoard.join('') ===
      currentSolution
    ) {
      statusElement.textContent =
        '🎉 Puzzle solved!';

      localStorage.removeItem(
        STORAGE_KEY
      );

      showToast('Victory!');
    }
  }

  function saveGame() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        puzzle: currentPuzzle,
        solution: currentSolution,
        board: currentBoard.join('')
      })
    );

    showToast('Game saved');
  }

  function loadGame() {
    var saved =
      localStorage.getItem(
        STORAGE_KEY
      );

    if (!saved) {
      return false;
    }

    var data = JSON.parse(saved);

    currentPuzzle = data.puzzle;
    currentSolution = data.solution;
    currentBoard =
      data.board.split('');

    createBoardUI();

    return true;
  }

  function newGame() {
    statusElement.textContent = '';

    var solvedBoard =
      generateSolvedBoard();

    var puzzleBoard =
      removeNumbers(
        solvedBoard,
        45
      );

    currentSolution =
      boardToString(
        solvedBoard
      );

    currentPuzzle =
      boardToString(
        puzzleBoard
      );

    currentBoard =
      currentPuzzle.split('');

    createBoardUI();

    saveGame();
  }

  function restartGame() {
    currentBoard =
      currentPuzzle.split('');

    statusElement.textContent = '';

    createBoardUI();

    saveGame();
  }

  function giveHint() {
    var available = [];
    var i;

    for (i = 0; i < 81; i++) {
      if (
        currentBoard[i] !==
        currentSolution[i]
      ) {
        available.push(i);
      }
    }

    if (!available.length) {
      return;
    }

    var randomIndex =
      available[
        Math.floor(
          Math.random() *
          available.length
        )
      ];

    currentBoard[randomIndex] =
      currentSolution[randomIndex];

    createBoardUI();

    saveGame();

    checkWin();
  }

  function init() {
    $('sdk-new-game-btn')
      .addEventListener(
        'click',
        newGame
      );

    $('sdk-restart-btn')
      .addEventListener(
        'click',
        restartGame
      );

    $('sdk-hint-btn')
      .addEventListener(
        'click',
        giveHint
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

  window.sdkNewGame = newGame;
  window.sdkRestartGame = restartGame;
  window.sdkGiveHint = giveHint;

  /* Node test export (no effect in browsers) */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      STORAGE_KEY: STORAGE_KEY,
      createEmptyBoard: createEmptyBoard,
      shuffle: shuffle,
      isValid: isValid,
      solveBoard: solveBoard,
      generateSolvedBoard: generateSolvedBoard,
      removeNumbers: removeNumbers,
      boardToString: boardToString,
      loadGame: loadGame
    };
  }
})();
