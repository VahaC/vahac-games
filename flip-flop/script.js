// Flip-Flop — script.js
// Prefix: ffl-
// Dependencies: none.
//
// Reversi on an 8x8 board drawn as a memory dump. Player one writes 1s and
// moves first, player two writes 0s. A move must trap at least one straight
// line of the other side's bits, in any of the 8 directions, between the new
// bit and one of the mover's own; every trapped bit flips. A side with no
// legal move passes, and the game ends when neither side can move: the side
// with more bits wins, equal counts are a draw.
//
// Opponents: the computer at three levels, or a second player on the same
// device (hot-seat). The computer is plain local search in this file; no
// service, model or network of any kind is involved.
//   Easy    a random legal move, each weighted by the bits it flips.
//   Normal  alpha-beta search 2 plies deep on a table of cell weights.
//   Hard    iterative-deepening alpha-beta, 5 plies deep (to the end of the
//           game once 10 or fewer cells are empty), with move ordering,
//           mobility, corner-aware cell weights and a node cap: when the cap
//           is hit it plays the best move of the last depth it finished, so
//           a slow phone never freezes.
// The computer moves FFL_CPU_DELAY_MS after its turn starts (one
// setTimeout); board input is ignored while it thinks.
//
// Saves: 'ffl-state' holds the game (the board as 64 characters, '1', '0' or
// '.', row by row; whose turn; the opponent; the undo history; the hint
// toggle; the last move) and is written after every change. 'ffl-stats'
// holds the wins, losses and draws against each computer level; it is read
// again before a result is added, so a second open tab never overwrites a
// result counted in the first. Both are parsed field by field
// (fflParseState, fflParseStats): a damaged field falls back to its default
// and a damaged board starts a new game. Storage that is blocked or full
// never stops the game; a warning names every key that is not saved.
//
// Keys, only while the focus is inside the game: the arrows move the cursor
// over the board, Enter or Space write a bit there, U undoes, N starts a new
// game. Ctrl / Cmd / Alt combinations, held keys and the opponent select are
// left alone, and nothing on the host page is listened to.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser fflInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var FFL_STATE_KEY = 'ffl-state';
  var FFL_STATS_KEY = 'ffl-stats';
  // Each saved key and what it holds, for the storage warning.
  var FFL_SAVED = [
    { key: FFL_STATE_KEY, what: 'the game' },
    { key: FFL_STATS_KEY, what: 'the record vs CPU' }
  ];

  var FFL_SIZE = 8;
  var FFL_CELLS = 64;
  var FFL_EMPTY = 0;
  var FFL_ONE = 1;
  var FFL_ZERO = 2;
  // The character of each cell value in the save and on the dump.
  var FFL_CHARS = ['.', '1', '0'];
  var FFL_BIT_CLASSES = ['ffl-bit ffl-bit--empty', 'ffl-bit ffl-bit--one', 'ffl-bit ffl-bit--zero'];
  // A full game has at most 60 moves, so the history never drops one.
  var FFL_HISTORY_MAX = 60;

  var FFL_CPU_DELAY_MS = 450;
  var FFL_TOAST_MS = 2200;
  var FFL_CONFIRM_MS = 3000;
  var FFL_START_CURSOR = 19;

  var FFL_MODES = ['easy', 'normal', 'hard', 'pvp'];
  var FFL_DEFAULT_MODE = 'normal';
  var FFL_MODE_NAMES = { easy: 'CPU Easy', normal: 'CPU Normal', hard: 'CPU Hard', pvp: 'two players' };
  var FFL_STAT_LEVELS = ['easy', 'normal', 'hard'];
  var FFL_STAT_LABELS = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
  var FFL_STAT_FIELDS = ['wins', 'losses', 'draws'];

  // The searching levels: plies, the empty-cell count from which the search
  // runs to the end of the game, the full evaluation (mobility and corner
  // aware weights), move ordering and the node cap.
  var FFL_LEVELS = {
    normal: { depth: 2, endgame: 0, full: false, ordered: false, cap: 20000 },
    hard: { depth: 5, endgame: 10, full: true, ordered: true, cap: 30000 }
  };

  // Cell weights: corners are worth most, the cells next to an empty corner
  // hand it to the other side.
  var FFL_WEIGHTS = [
    100, -20, 10, 5, 5, 10, -20, 100,
    -20, -50, -2, -2, -2, -2, -50, -20,
    10, -2, -1, -1, -1, -1, -2, 10,
    5, -2, -1, -1, -1, -1, -2, 5,
    5, -2, -1, -1, -1, -1, -2, 5,
    10, -2, -1, -1, -1, -1, -2, 10,
    -20, -50, -2, -2, -2, -2, -50, -20,
    100, -20, 10, 5, 5, 10, -20, 100
  ];
  // Each corner and the three cells around it, worth FFL_TAKEN_CORNER_NEIGHBOUR
  // instead (full evaluation) once the corner is taken.
  var FFL_CORNERS = [[0, 1, 8, 9], [7, 6, 15, 14], [56, 57, 48, 49], [63, 62, 55, 54]];
  var FFL_TAKEN_CORNER_NEIGHBOUR = 5;
  var FFL_MOBILITY_WEIGHT = 8;
  // A finished line of play is worth this much per bit of margin, more than
  // any position can score.
  var FFL_WIN_SCORE = 10000;
  // Root ordering: the previous depth's choice is tried first.
  var FFL_FIRST_BONUS = 1000;

  var FFL_DR = [-1, -1, -1, 0, 0, 1, 1, 1];
  var FFL_DC = [-1, 0, 1, -1, 1, -1, 0, 1];

  var FFL_ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  var FFL_KEY_ACTIONS = { u: 'undo', n: 'new' };
  var FFL_CODE_ACTIONS = { KeyU: 'undo', KeyN: 'new' };

  // ── State ─────────────────────────────────────────────────────────────────

  // The game, field for field what ffl-state holds (the board as numbers).
  var fflState = fflDefaultState();

  // Wins, losses and draws against each computer level (ffl-stats).
  var fflStats = fflParseStats(null);

  // Page handles and view state, never saved.
  var fflRuntime = {
    els: null,
    cells: [],
    dump: [],
    cpuTimer: null,
    toastTimer: null,
    confirmTimer: null,
    cursor: FFL_START_CURSOR,
    preview: -1,
    flipped: [],
    flipPhase: 0,
    log: '',
    // Saved keys whose storage failed: key -> 'blocked' or 'full'.
    failed: {},
    warning: ''
  };

  // ── Board rules (no DOM) ──────────────────────────────────────────────────

  function fflHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function fflOpponent(player) {
    return 3 - player;
  }

  function fflInside(row, col) {
    return row >= 0 && row < FFL_SIZE && col >= 0 && col < FFL_SIZE;
  }

  // The start position: 0s on the centre's main diagonal, 1s on the other.
  function fflNewBoard() {
    var board = [];
    for (var i = 0; i < FFL_CELLS; i++) {
      board.push(FFL_EMPTY);
    }
    board[27] = FFL_ZERO;
    board[28] = FFL_ONE;
    board[35] = FFL_ONE;
    board[36] = FFL_ZERO;
    return board;
  }

  // Scans the 8 lines from index for a move by player. With out (an array)
  // it adds every bit the move flips, line by line from the move outward,
  // and returns how many; without, it returns 1 at the first line that flips
  // anything (a legality check). 0 when the cell is taken or nothing flips.
  function fflScan(board, player, index, out) {
    if (board[index] !== FFL_EMPTY) {
      return 0;
    }
    var opponent = fflOpponent(player);
    var row = index >> 3;
    var col = index & 7;
    var total = 0;
    for (var d = 0; d < 8; d++) {
      var dr = FFL_DR[d];
      var dc = FFL_DC[d];
      var r = row + dr;
      var c = col + dc;
      var run = 0;
      while (fflInside(r, c) && board[r * FFL_SIZE + c] === opponent) {
        run++;
        r += dr;
        c += dc;
      }
      if (run && fflInside(r, c) && board[r * FFL_SIZE + c] === player) {
        if (!out) {
          return 1;
        }
        for (var k = 1; k <= run; k++) {
          out.push((row + dr * k) * FFL_SIZE + col + dc * k);
        }
        total += run;
      }
    }
    return total;
  }

  // The bits a move by player at index flips ([] for an illegal move).
  function fflFlips(board, player, index) {
    var out = [];
    fflScan(board, player, index, out);
    return out;
  }

  function fflIsLegal(board, player, index) {
    return fflScan(board, player, index, null) > 0;
  }

  // Every legal move of player in cell order, as { index, flips }.
  function fflLegalMoves(board, player) {
    var moves = [];
    for (var i = 0; i < FFL_CELLS; i++) {
      var flips = fflFlips(board, player, i);
      if (flips.length) {
        moves.push({ index: i, flips: flips });
      }
    }
    return moves;
  }

  function fflMobility(board, player) {
    var count = 0;
    for (var i = 0; i < FFL_CELLS; i++) {
      if (fflIsLegal(board, player, i)) {
        count++;
      }
    }
    return count;
  }

  function fflHasMove(board, player) {
    for (var i = 0; i < FFL_CELLS; i++) {
      if (fflIsLegal(board, player, i)) {
        return true;
      }
    }
    return false;
  }

  // A copy of board with player's bit at index and the flips turned over.
  function fflPlace(board, player, index, flips) {
    var next = board.slice();
    next[index] = player;
    for (var i = 0; i < flips.length; i++) {
      next[flips[i]] = player;
    }
    return next;
  }

  // The move as { board, flips } (board a new array), or null when it is
  // not legal. The board passed in is left alone.
  function fflApplyMove(board, player, index) {
    var flips = fflFlips(board, player, index);
    if (!flips.length) {
      return null;
    }
    return { board: fflPlace(board, player, index, flips), flips: flips };
  }

  function fflCount(board) {
    var counts = { ones: 0, zeros: 0, empty: 0 };
    for (var i = 0; i < FFL_CELLS; i++) {
      if (board[i] === FFL_ONE) {
        counts.ones++;
      } else if (board[i] === FFL_ZERO) {
        counts.zeros++;
      } else {
        counts.empty++;
      }
    }
    return counts;
  }

  function fflIsOver(board) {
    return !fflHasMove(board, FFL_ONE) && !fflHasMove(board, FFL_ZERO);
  }

  // The side with more bits (FFL_ONE or FFL_ZERO), or 0 for equal counts.
  function fflWinner(board) {
    var counts = fflCount(board);
    if (counts.ones === counts.zeros) {
      return 0;
    }
    return counts.ones > counts.zeros ? FFL_ONE : FFL_ZERO;
  }

  // Who moves after mover: the other side if it can, else mover again (the
  // other side passes), else nobody (over).
  function fflNextTurn(board, mover) {
    var other = fflOpponent(mover);
    if (fflHasMove(board, other)) {
      return { turn: other, passed: false, over: false };
    }
    if (fflHasMove(board, mover)) {
      return { turn: mover, passed: true, over: false };
    }
    return { turn: other, passed: false, over: true };
  }

  // ── The computer (no DOM) ─────────────────────────────────────────────────

  // The cell weights for a position: the table, or (full) the table with the
  // cells around every taken corner made safe.
  function fflWeights(board, full) {
    if (!full) {
      return FFL_WEIGHTS;
    }
    var weights = FFL_WEIGHTS.slice();
    for (var i = 0; i < FFL_CORNERS.length; i++) {
      var corner = FFL_CORNERS[i];
      if (board[corner[0]] !== FFL_EMPTY) {
        for (var k = 1; k < corner.length; k++) {
          weights[corner[k]] = FFL_TAKEN_CORNER_NEIGHBOUR;
        }
      }
    }
    return weights;
  }

  // A finished position for player: the margin in bits times FFL_WIN_SCORE.
  function fflFinalScore(board, player) {
    var counts = fflCount(board);
    var margin = player === FFL_ONE ? counts.ones - counts.zeros : counts.zeros - counts.ones;
    return margin * FFL_WIN_SCORE;
  }

  // A position's worth for player (positive is good for player): the final
  // margin when neither side can move, else player's cell weights minus the
  // other side's, plus (full) FFL_MOBILITY_WEIGHT per legal move more than
  // the other side has.
  function fflEvaluate(board, player, full) {
    var opponent = fflOpponent(player);
    var mine = fflMobility(board, player);
    var theirs = fflMobility(board, opponent);
    if (!mine && !theirs) {
      return fflFinalScore(board, player);
    }
    var weights = fflWeights(board, full);
    var score = 0;
    for (var i = 0; i < FFL_CELLS; i++) {
      if (board[i] === player) {
        score += weights[i];
      } else if (board[i] === opponent) {
        score -= weights[i];
      }
    }
    return full ? score + FFL_MOBILITY_WEIGHT * (mine - theirs) : score;
  }

  // The moves best-first for the search: first (a cell index, or -1) ahead,
  // then by cell weight; equal weights keep their order.
  function fflOrderMoves(moves, first) {
    var ranked = moves.map(function (move, at) {
      return { move: move, at: at, weight: FFL_WEIGHTS[move.index] + (move.index === first ? FFL_FIRST_BONUS : 0) };
    });
    ranked.sort(function (a, b) {
      return b.weight - a.weight || a.at - b.at;
    });
    return ranked.map(function (entry) {
      return entry.move;
    });
  }

  // A shuffled copy of list (Fisher-Yates with rnd).
  function fflShuffle(list, rnd) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var swap = out[i];
      out[i] = out[j];
      out[j] = swap;
    }
    return out;
  }

  // Easy: one of moves drawn with rnd, each as likely as the bits it flips.
  function fflPickWeighted(moves, rnd) {
    var total = 0;
    var i;
    for (i = 0; i < moves.length; i++) {
      total += moves[i].flips.length;
    }
    var draw = rnd() * total;
    for (i = 0; i < moves.length - 1; i++) {
      draw -= moves[i].flips.length;
      if (draw < 0) {
        return moves[i];
      }
    }
    return moves[moves.length - 1];
  }

  // Negamax with alpha-beta pruning: the worth of board for player to move,
  // depth moves deep (a pass uses none, so with depth at least the number of
  // empty cells every line is played to the end; two passes in a row end the
  // game, so passing never loops). ctx: { nodes, cap, full, ordered,
  // aborted, cutoffs }. Once ctx.nodes reaches ctx.cap the search stops:
  // ctx.aborted is set and every result from then on is meaningless.
  function fflSearch(board, player, depth, alpha, beta, ctx) {
    if (ctx.nodes >= ctx.cap) {
      ctx.aborted = true;
      return 0;
    }
    ctx.nodes++;
    if (depth === 0) {
      return fflEvaluate(board, player, ctx.full);
    }
    var opponent = fflOpponent(player);
    var moves = fflLegalMoves(board, player);
    if (!moves.length) {
      if (!fflHasMove(board, opponent)) {
        return fflFinalScore(board, player);
      }
      return -fflSearch(board, opponent, depth, -beta, -alpha, ctx);
    }
    if (ctx.ordered) {
      moves = fflOrderMoves(moves, -1);
    }
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var child = fflPlace(board, player, moves[i].index, moves[i].flips);
      var score = -fflSearch(child, opponent, depth - 1, -beta, -alpha, ctx);
      if (ctx.aborted) {
        return 0;
      }
      if (score > best) {
        best = score;
      }
      if (best > alpha) {
        alpha = best;
      }
      if (alpha >= beta) {
        ctx.cutoffs++;
        break;
      }
    }
    return best;
  }

  // The best of moves for player, depth plies deep (the first of equals).
  function fflSearchRoot(board, player, moves, depth, ctx) {
    var opponent = fflOpponent(player);
    var alpha = -Infinity;
    var best = moves[0];
    for (var i = 0; i < moves.length; i++) {
      var child = fflPlace(board, player, moves[i].index, moves[i].flips);
      var score = -fflSearch(child, opponent, depth - 1, -Infinity, -alpha, ctx);
      if (ctx.aborted) {
        return best;
      }
      if (score > alpha) {
        alpha = score;
        best = moves[i];
      }
    }
    return best;
  }

  // The computer's move for player: { move, depth, nodes, capped, cutoffs }.
  // move is a cell index, or -1 when player has no legal move; depth the
  // deepest search that finished (0 for Easy and a forced move); nodes the
  // positions searched; capped whether the node cap cut the search short.
  // level is 'easy', 'normal' or 'hard' (anything else searches as Normal).
  // rnd (Math.random in the game) draws Easy's move and shuffles the root
  // moves of Normal and Hard, so equally good moves vary between games. cap
  // (a positive number) replaces the level's node cap.
  function fflChooseMove(board, player, level, rnd, cap) {
    var moves = fflLegalMoves(board, player);
    var result = { move: -1, depth: 0, nodes: 0, capped: false, cutoffs: 0 };
    if (!moves.length) {
      return result;
    }
    if (moves.length === 1) {
      result.move = moves[0].index;
      return result;
    }
    if (level === 'easy') {
      result.move = fflPickWeighted(moves, rnd).index;
      return result;
    }
    var config = fflHasOwn(FFL_LEVELS, level) ? FFL_LEVELS[level] : FFL_LEVELS.normal;
    var empty = fflCount(board).empty;
    var maxDepth = empty <= config.endgame ? empty : config.depth;
    var ctx = {
      nodes: 0,
      cap: cap > 0 ? cap : config.cap,
      full: config.full,
      ordered: config.ordered,
      aborted: false,
      cutoffs: 0
    };
    var root = fflShuffle(moves, rnd);
    var best = config.ordered ? fflOrderMoves(root, -1)[0] : root[0];
    for (var depth = 1; depth <= maxDepth; depth++) {
      var pick = fflSearchRoot(board, player, config.ordered ? fflOrderMoves(root, best.index) : root, depth, ctx);
      if (ctx.aborted) {
        result.capped = true;
        break;
      }
      best = pick;
      result.depth = depth;
    }
    result.move = best.index;
    result.nodes = ctx.nodes;
    result.cutoffs = ctx.cutoffs;
    return result;
  }

  // ── Bits, masks and text (no DOM) ─────────────────────────────────────────

  // player's bits in a row as a number, column 0 the high bit.
  function fflRowMask(board, row, player) {
    var mask = 0;
    for (var col = 0; col < FFL_SIZE; col++) {
      mask = mask * 2 + (board[row * FFL_SIZE + col] === player ? 1 : 0);
    }
    return mask;
  }

  // value in upper-case hex, at least digits long.
  function fflHex(value, digits) {
    var text = value.toString(16).toUpperCase();
    while (text.length < digits) {
      text = '0' + text;
    }
    return text;
  }

  // player's 64-bit board as '0x' and 16 hex digits, row 0 first.
  function fflMaskHex(board, player) {
    var out = '0x';
    for (var row = 0; row < FFL_SIZE; row++) {
      out += fflHex(fflRowMask(board, row, player), 2);
    }
    return out;
  }

  // A cell's address on the dump: 0x00 (top left) to 0x3F.
  function fflAddress(index) {
    return '0x' + fflHex(index, 2);
  }

  function fflRowBits(board, row) {
    var out = '';
    for (var col = 0; col < FFL_SIZE; col++) {
      out += FFL_CHARS[board[row * FFL_SIZE + col]];
    }
    return out;
  }

  function fflBoardToString(board) {
    var out = '';
    for (var i = 0; i < FFL_CELLS; i++) {
      out += FFL_CHARS[board[i]];
    }
    return out;
  }

  // 64 characters of '1', '0' and '.' as a board, or null.
  function fflStringToBoard(text) {
    if (typeof text !== 'string' || text.length !== FFL_CELLS) {
      return null;
    }
    var board = [];
    for (var i = 0; i < FFL_CELLS; i++) {
      var value = FFL_CHARS.indexOf(text.charAt(i));
      if (value === -1) {
        return null;
      }
      board.push(value);
    }
    return board;
  }

  // An undo step: the board's 64 characters and the side to move ('1' / '0').
  function fflSnapshot(board, turn) {
    return fflBoardToString(board) + FFL_CHARS[turn];
  }

  // An undo step as { board, turn }, or null.
  function fflParseSnapshot(text) {
    if (typeof text !== 'string' || text.length !== FFL_CELLS + 1) {
      return null;
    }
    var board = fflStringToBoard(text.slice(0, FFL_CELLS));
    var turn = FFL_CHARS.indexOf(text.charAt(FFL_CELLS));
    if (!board || turn < FFL_ONE) {
      return null;
    }
    return { board: board, turn: turn };
  }

  function fflBitName(player) {
    return player === FFL_ONE ? '1s' : '0s';
  }

  // Who plays player's side: 'You' or the computer level, or 'Player 1' /
  // 'Player 2' in a two-player game.
  function fflSideName(mode, player) {
    if (mode === 'pvp') {
      return player === FFL_ONE ? 'Player 1' : 'Player 2';
    }
    return player === FFL_ONE ? 'You' : FFL_MODE_NAMES[mode];
  }

  function fflPlural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  // The result of a finished board: 'you win 40 to 24 (1s ahead by 16)',
  // 'CPU Hard wins ...', 'Player 2 wins ...' or 'draw, 32 to 32'.
  function fflResultText(board, mode) {
    var counts = fflCount(board);
    var winner = fflWinner(board);
    var high = Math.max(counts.ones, counts.zeros);
    var low = Math.min(counts.ones, counts.zeros);
    var score = high + ' to ' + low;
    if (!winner) {
      return 'draw, ' + score;
    }
    var who = mode !== 'pvp' && winner === FFL_ONE ? 'you win ' : fflSideName(mode, winner) + ' wins ';
    return who + score + ' (' + fflBitName(winner) + ' ahead by ' + (high - low) + ')';
  }

  // The status line: whose move and how many legal moves, the computer
  // thinking, or the result.
  function fflStatusText(state) {
    if (fflIsOver(state.board)) {
      return 'Game over: ' + fflResultText(state.board, state.mode) + '.';
    }
    if (state.mode !== 'pvp' && state.turn === FFL_ZERO) {
      return FFL_MODE_NAMES[state.mode] + ' is thinking…';
    }
    var who = state.mode === 'pvp' ? fflSideName(state.mode, state.turn) + ' to move' : 'Your move';
    var moves = fflMobility(state.board, state.turn);
    return who + ': write a ' + FFL_CHARS[state.turn] + ' (' + fflPlural(moves, 'legal move') + ').';
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function fflDefaultState() {
    return {
      board: fflNewBoard(),
      turn: FFL_ONE,
      mode: FFL_DEFAULT_MODE,
      history: [],
      hint: true,
      last: -1
    };
  }

  // A saved game (JSON text) as a clean state, field by field: an unknown
  // mode becomes Normal, a hint that is not true or false becomes on, broken
  // undo steps are dropped, and a last move that is not a taken cell is
  // forgotten. A board that is not 64 cells of '1', '0' and '.' holding at
  // least the 4 start bits gives a new game (keeping the mode and the hint).
  // The turn is checked against the board: a side without a legal move
  // passes.
  function fflParseState(text) {
    var state = fflDefaultState();
    var data = null;
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = null;
    }
    if (!data || typeof data !== 'object') {
      return state;
    }
    if (FFL_MODES.indexOf(data.mode) !== -1) {
      state.mode = data.mode;
    }
    if (typeof data.hint === 'boolean') {
      state.hint = data.hint;
    }
    var board = fflStringToBoard(data.board);
    if (!board || fflCount(board).empty > FFL_CELLS - 4) {
      return state;
    }
    state.board = board;
    state.turn = fflNextTurn(board, data.turn === FFL_ZERO ? FFL_ONE : FFL_ZERO).turn;
    if (Array.isArray(data.history)) {
      state.history = data.history.filter(function (entry) {
        return fflParseSnapshot(entry) !== null;
      }).slice(-FFL_HISTORY_MAX);
    }
    var last = data.last;
    if (typeof last === 'number' && last % 1 === 0 && last >= 0 && last < FFL_CELLS && board[last] !== FFL_EMPTY) {
      state.last = last;
    }
    return state;
  }

  function fflCleanCount(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 && value % 1 === 0 ? value : 0;
  }

  // Saved stats (JSON text) as { easy, normal, hard } of { wins, losses,
  // draws }; every count that is not a whole number of at least 0 is 0.
  function fflParseStats(text) {
    var data = null;
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = null;
    }
    var stats = {};
    FFL_STAT_LEVELS.forEach(function (level) {
      var row = data && typeof data === 'object' && data[level] && typeof data[level] === 'object' ? data[level] : {};
      stats[level] = {
        wins: fflCleanCount(row.wins),
        losses: fflCleanCount(row.losses),
        draws: fflCleanCount(row.draws)
      };
    });
    return stats;
  }

  // Stats saved by another open tab merged into stats (both parsed): the
  // larger count of each field wins. Counts only ever grow, so this keeps a
  // result the other tab added, and a damaged or missing save (all 0) takes
  // nothing away.
  function fflMergeStats(stats, saved) {
    FFL_STAT_LEVELS.forEach(function (level) {
      FFL_STAT_FIELDS.forEach(function (field) {
        stats[level][field] = Math.max(stats[level][field], saved[level][field]);
      });
    });
    return stats;
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // The warning for every key whose storage failed so far (failed maps a key
  // to 'blocked' or 'full'), naming each key and what it holds; '' if none.
  function fflStorageWarning(failed) {
    var parts = [];
    ['blocked', 'full'].forEach(function (kind) {
      var hit = FFL_SAVED.filter(function (item) {
        return failed[item.key] === kind;
      });
      if (!hit.length) {
        return;
      }
      var keys = hit.map(function (item) {
        return item.key;
      }).join(' and ');
      var what = hit.map(function (item) {
        return item.what;
      }).join(' and ');
      parts.push(kind === 'blocked'
        ? 'Browser storage is blocked: ' + keys + ' cannot be read or saved, so ' + what + ' will not be kept after a reload.'
        : 'Browser storage is full: ' + keys + (hit.length > 1 ? ' were' : ' was') +
          ' not saved, so a reload will lose the latest changes to ' + what + '.');
    });
    return parts.join(' ');
  }

  // Notes the failure on key, so the warning names it with any earlier one.
  function fflStorageFailed(error, key) {
    fflRuntime.failed[key] = /quota/i.test(String(error && error.name)) ? 'full' : 'blocked';
    fflRuntime.warning = fflStorageWarning(fflRuntime.failed);
  }

  function fflStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      fflStorageFailed(error, key);
      return null;
    }
  }

  function fflStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      fflStorageFailed(error, key);
    }
  }

  function fflSerialize() {
    return {
      board: fflBoardToString(fflState.board),
      turn: fflState.turn,
      mode: fflState.mode,
      history: fflState.history.slice(),
      hint: fflState.hint,
      last: fflState.last
    };
  }

  function fflSave() {
    fflStorageSet(FFL_STATE_KEY, JSON.stringify(fflSerialize()));
  }

  function fflSaveStats() {
    fflStorageSet(FFL_STATS_KEY, JSON.stringify(fflStats));
  }

  // Copies every field of from onto to, so exported objects stay the same.
  function fflAssign(to, from) {
    Object.keys(from).forEach(function (key) {
      to[key] = from[key];
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function fflMovesPlayed(board) {
    return FFL_CELLS - 4 - fflCount(board).empty;
  }

  function fflIsCpuTurn() {
    return fflState.mode !== 'pvp' && fflState.turn === FFL_ZERO && !fflIsOver(fflState.board);
  }

  // Whether a person may write a bit now: the game runs and it is not the
  // computer's move.
  function fflHumanToMove() {
    return !fflIsOver(fflState.board) && (fflState.mode === 'pvp' || fflState.turn === FFL_ONE);
  }

  function fflCanUndo() {
    return fflState.history.length > 0 && fflHumanToMove();
  }

  function fflCellLabel(index, value, flips) {
    var where = fflAddress(index) + ', row ' + ((index >> 3) + 1) + ' column ' + ((index & 7) + 1) + ': ';
    if (value !== FFL_EMPTY) {
      return where + FFL_CHARS[value];
    }
    return where + (flips ? 'empty, legal move, flips ' + flips : 'empty');
  }

  function fflRenderBoard() {
    var board = fflState.board;
    var turn = fflState.turn;
    var over = fflIsOver(board);
    var hint = fflState.hint && fflHumanToMove();
    var preview = hint && fflRuntime.preview !== -1 ? fflFlips(board, turn, fflRuntime.preview) : [];
    var boardClass = 'ffl-board';
    if (fflRuntime.cpuTimer !== null) {
      boardClass += ' ffl-board--thinking';
    }
    if (over) {
      boardClass += ' ffl-board--over';
    } else if (turn === FFL_ZERO) {
      boardClass += ' ffl-board--zero-turn';
    }
    fflRuntime.els.board.className = boardClass;
    for (var i = 0; i < FFL_CELLS; i++) {
      var cell = fflRuntime.cells[i];
      var value = board[i];
      var flips = hint ? fflFlips(board, turn, i).length : 0;
      var classes = ['ffl-cell'];
      var text = '';
      if (value === FFL_ONE) {
        classes.push('ffl-cell--one');
        text = '1';
      } else if (value === FFL_ZERO) {
        classes.push('ffl-cell--zero');
        text = '0';
      } else if (flips) {
        classes.push('ffl-cell--legal');
        text = '+' + flips;
        if (i === fflRuntime.preview) {
          classes.push('ffl-cell--ghost');
        }
      }
      if (preview.indexOf(i) !== -1) {
        classes.push('ffl-cell--xor');
      }
      if (i === fflState.last) {
        classes.push('ffl-cell--last');
      }
      if (fflRuntime.flipped.indexOf(i) !== -1) {
        classes.push(fflRuntime.flipPhase ? 'ffl-cell--flip-a' : 'ffl-cell--flip-b');
      }
      cell.className = classes.join(' ');
      cell.textContent = text;
      cell.setAttribute('aria-label', fflCellLabel(i, value, flips));
      cell.setAttribute('tabindex', i === fflRuntime.cursor ? '0' : '-1');
    }
  }

  function fflSideClass(name, active, won) {
    return 'ffl-side ffl-side--' + name + (active ? ' ffl-side--active' : '') + (won ? ' ffl-side--winner' : '');
  }

  function fflRenderSides() {
    var els = fflRuntime.els;
    var board = fflState.board;
    var counts = fflCount(board);
    var over = fflIsOver(board);
    var winner = over ? fflWinner(board) : 0;
    els.nameOne.textContent = '1s · ' + fflSideName(fflState.mode, FFL_ONE);
    els.nameZero.textContent = '0s · ' + fflSideName(fflState.mode, FFL_ZERO);
    els.countOne.textContent = String(counts.ones);
    els.countZero.textContent = String(counts.zeros);
    els.maskOne.textContent = 'popcnt(' + fflMaskHex(board, FFL_ONE) + ')';
    els.maskZero.textContent = 'popcnt(' + fflMaskHex(board, FFL_ZERO) + ')';
    els.sideOne.className = fflSideClass('one', !over && fflState.turn === FFL_ONE, winner === FFL_ONE);
    els.sideZero.className = fflSideClass('zero', !over && fflState.turn === FFL_ZERO, winner === FFL_ZERO);
    els.moves.textContent = 'Moves played: ' + fflMovesPlayed(board) + ' · free cells: ' + counts.empty;
  }

  function fflRenderDump() {
    var board = fflState.board;
    for (var row = 0; row < FFL_SIZE; row++) {
      var line = fflRuntime.dump[row];
      line.addr.textContent = fflAddress(row * FFL_SIZE);
      for (var col = 0; col < FFL_SIZE; col++) {
        var value = board[row * FFL_SIZE + col];
        line.bits[col].className = FFL_BIT_CLASSES[value];
        line.bits[col].textContent = FFL_CHARS[value];
      }
      line.one.textContent = '0x' + fflHex(fflRowMask(board, row, FFL_ONE), 2);
      line.zero.textContent = '0x' + fflHex(fflRowMask(board, row, FFL_ZERO), 2);
    }
  }

  function fflRenderStats() {
    var els = fflRuntime.els;
    FFL_STAT_LEVELS.forEach(function (level) {
      var row = fflStats[level];
      var el = els.stats[level];
      el.textContent = FFL_STAT_LABELS[level] + ': W ' + row.wins + ' · L ' + row.losses + ' · D ' + row.draws;
      el.className = 'ffl-stat' + (level === fflState.mode ? ' ffl-stat--current' : '');
    });
  }

  function fflRenderControls() {
    var els = fflRuntime.els;
    els.undo.disabled = !fflCanUndo();
    els.hint.textContent = 'XOR hint: ' + (fflState.hint ? 'on' : 'off');
    els.hint.setAttribute('aria-pressed', fflState.hint ? 'true' : 'false');
    var confirming = fflRuntime.confirmTimer !== null;
    els.newGame.textContent = confirming ? 'Confirm New Game' : 'New Game';
    els.newGame.setAttribute('aria-label', confirming ? 'Confirm: abandon this game and start a new one' : 'Start a new game');
    els.newGame.className = 'ffl-btn' + (confirming ? ' ffl-btn--confirm' : '');
    // A disabled button drops the focus: give it to the board's cursor.
    if (els.undo.disabled && document.activeElement === els.undo) {
      fflRuntime.cells[fflRuntime.cursor].focus();
    }
  }

  function fflRender() {
    var els = fflRuntime.els;
    fflRenderBoard();
    fflRenderSides();
    fflRenderDump();
    fflRenderStats();
    fflRenderControls();
    els.status.textContent = fflStatusText(fflState);
    els.status.className = 'ffl-status' + (fflIsCpuTurn() ? ' ffl-status--thinking' : '');
    els.log.textContent = '> ' + fflRuntime.log;
    els.warning.textContent = fflRuntime.warning;
    els.warning.hidden = !fflRuntime.warning;
  }

  function fflShowToast(message) {
    var toast = fflRuntime.els.toast;
    clearTimeout(fflRuntime.toastTimer);
    toast.textContent = message;
    toast.classList.add('ffl-toast--show');
    fflRuntime.toastTimer = setTimeout(fflHideToast, FFL_TOAST_MS);
  }

  function fflHideToast() {
    clearTimeout(fflRuntime.toastTimer);
    fflRuntime.toastTimer = null;
    fflRuntime.els.toast.classList.remove('ffl-toast--show');
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  function fflSelectedMode() {
    var value = fflRuntime.els.mode.value;
    return FFL_MODES.indexOf(value) !== -1 ? value : fflState.mode;
  }

  function fflMatchText(mode) {
    return '1s (' + fflSideName(mode, FFL_ONE) + ') vs 0s (' + fflSideName(mode, FFL_ZERO) + ')';
  }

  function fflCancelCpu() {
    clearTimeout(fflRuntime.cpuTimer);
    fflRuntime.cpuTimer = null;
  }

  function fflScheduleCpu() {
    fflCancelCpu();
    fflRuntime.cpuTimer = setTimeout(fflCpuMove, FFL_CPU_DELAY_MS);
  }

  function fflDisarmConfirm() {
    clearTimeout(fflRuntime.confirmTimer);
    fflRuntime.confirmTimer = null;
  }

  // A fresh board for mode; 1s move first, so the computer never starts.
  function fflStartGame(mode) {
    fflCancelCpu();
    fflDisarmConfirm();
    fflHideToast();
    var hint = fflState.hint;
    fflAssign(fflState, fflDefaultState());
    fflState.mode = mode;
    fflState.hint = hint;
    fflRuntime.flipped = [];
    fflRuntime.preview = -1;
    fflRuntime.cursor = FFL_START_CURSOR;
    fflRuntime.log = 'new game: ' + fflMatchText(mode) + '. 1s move first.';
    fflRuntime.els.mode.value = mode;
    fflSave();
    fflRender();
  }

  // New Game and N: a game in progress needs a second press within
  // FFL_CONFIRM_MS, so one stray key never throws it away.
  function fflRequestNewGame() {
    var board = fflState.board;
    var inProgress = !fflIsOver(board) && fflMovesPlayed(board) > 0;
    if (inProgress && fflRuntime.confirmTimer === null) {
      fflRuntime.confirmTimer = setTimeout(fflConfirmExpired, FFL_CONFIRM_MS);
      fflRuntime.log = 'press New Game (or N) again within 3 s to abandon this game: ' +
        fflPlural(fflMovesPlayed(board), 'move') + ' played vs ' + FFL_MODE_NAMES[fflState.mode] + '.';
      fflRender();
      return;
    }
    fflStartGame(fflSelectedMode());
  }

  function fflConfirmExpired() {
    fflRuntime.confirmTimer = null;
    fflRuntime.log = 'new game cancelled: this game goes on.';
    fflRender();
  }

  // The opponent select: a game without moves, or a finished one, starts
  // over against the new opponent at once; a game in progress keeps its
  // opponent until New Game.
  function fflHandleModeChange() {
    var mode = fflSelectedMode();
    var board = fflState.board;
    if (mode === fflState.mode) {
      fflRuntime.log = 'opponent: ' + FFL_MODE_NAMES[mode] + ', as in this game.';
    } else if (fflIsOver(board) || fflMovesPlayed(board) === 0) {
      fflStartGame(mode);
      return;
    } else {
      fflRuntime.log = 'next game vs ' + FFL_MODE_NAMES[mode] + ' from New Game; this game stays vs ' +
        FFL_MODE_NAMES[fflState.mode] + '.';
    }
    fflRender();
  }

  function fflMoveLog(mover, index, flipCount, search) {
    var who = fflSideName(fflState.mode, mover);
    var text = who + ' wrote a ' + FFL_CHARS[mover] + ' at ' + fflAddress(index) + ', flipping ' + fflPlural(flipCount, 'bit');
    if (search && search.depth) {
      text += ' (depth ' + search.depth + ', ' + fflPlural(search.nodes, 'position') + ' searched' +
        (search.capped ? ', node cap reached' : '') + ')';
    }
    return text + '.';
  }

  // The toast when passer has no legal move and the other side goes again.
  function fflPassText(passer) {
    var mode = fflState.mode;
    var other = fflOpponent(passer);
    var again = mode !== 'pvp' && other === FFL_ONE ? 'your move again' : fflSideName(mode, other) + ' moves again';
    var who = mode !== 'pvp' && passer === FFL_ONE ? 'you' : fflSideName(mode, passer);
    return 'No legal move for ' + who + ' (' + fflBitName(passer) + '): pass, ' + again + '.';
  }

  // A finished game: counted once in the stats (computer games only). The
  // saved stats are read again first, so a result another open tab counted
  // meanwhile is kept; storage that cannot be read keeps the counts here.
  function fflFinish() {
    if (fflState.mode !== 'pvp') {
      fflMergeStats(fflStats, fflParseStats(fflStorageGet(FFL_STATS_KEY)));
      var winner = fflWinner(fflState.board);
      var row = fflStats[fflState.mode];
      if (winner === FFL_ONE) {
        row.wins++;
      } else if (winner === FFL_ZERO) {
        row.losses++;
      } else {
        row.draws++;
      }
      fflSaveStats();
    }
    fflShowToast('Game over: ' + fflResultText(fflState.board, fflState.mode) + '.');
  }

  // Puts a legal move on the board and hands the turn on: a pass gets a
  // toast, the end of the game is counted, and the computer is asked to move
  // when it is its turn. The preview stays on the cell under the pointer or
  // cursor, so it shows again as soon as a person may move (a cell that was
  // just taken previews nothing).
  function fflCommitMove(mover, index, result, search) {
    var next = fflNextTurn(result.board, mover);
    fflState.board = result.board;
    fflState.turn = next.turn;
    fflState.last = index;
    fflRuntime.flipped = result.flips;
    fflRuntime.flipPhase = 1 - fflRuntime.flipPhase;
    fflRuntime.log = fflMoveLog(mover, index, result.flips.length, search);
    if (next.over) {
      fflFinish();
    } else if (next.passed) {
      fflShowToast(fflPassText(fflOpponent(mover)));
    }
    fflSave();
    if (fflIsCpuTurn()) {
      fflScheduleCpu();
    }
    fflRender();
  }

  // A person writes a bit at index (a click, a tap, Enter or Space).
  function fflPlay(index) {
    if (!fflHumanToMove()) {
      return;
    }
    var board = fflState.board;
    var turn = fflState.turn;
    fflRuntime.cursor = index;
    var result = fflApplyMove(board, turn, index);
    if (!result) {
      fflRuntime.log = fflAddress(index) + ' refused: ' + (board[index] !== FFL_EMPTY
        ? 'the cell already holds a ' + FFL_CHARS[board[index]]
        : 'a ' + FFL_CHARS[turn] + ' there flips no bits') + '.';
      fflRender();
      return;
    }
    fflDisarmConfirm();
    fflState.history = fflState.history.concat([fflSnapshot(board, turn)]).slice(-FFL_HISTORY_MAX);
    fflCommitMove(turn, index, result, null);
  }

  function fflCpuMove() {
    fflRuntime.cpuTimer = null;
    var player = fflState.turn;
    var search = fflChooseMove(fflState.board, player, fflState.mode, Math.random, 0);
    fflCommitMove(player, search.move, fflApplyMove(fflState.board, player, search.move), search);
  }

  // Undo: back to before the last move of a person (against the computer
  // that takes back its reply too). Not while the computer thinks, and not
  // once the game is over and counted.
  function fflUndo() {
    if (!fflCanUndo()) {
      if (fflIsOver(fflState.board)) {
        fflRuntime.log = 'undo is off: the game is over and its result is counted.';
      } else if (fflIsCpuTurn()) {
        fflRuntime.log = 'undo waits: ' + FFL_MODE_NAMES[fflState.mode] + ' is thinking.';
      } else {
        fflRuntime.log = 'nothing to undo: no move of yours yet.';
      }
      fflRender();
      return;
    }
    var step = fflParseSnapshot(fflState.history.pop());
    fflDisarmConfirm();
    fflState.board = step.board;
    fflState.turn = fflNextTurn(step.board, fflOpponent(step.turn)).turn;
    fflState.last = -1;
    fflRuntime.flipped = [];
    fflRuntime.preview = -1;
    fflRuntime.log = 'undo: back to ' + fflPlural(fflMovesPlayed(step.board), 'move') + ' played.';
    fflSave();
    if (fflIsCpuTurn()) {
      fflScheduleCpu();
    }
    fflRender();
  }

  function fflToggleHint() {
    fflState.hint = !fflState.hint;
    fflRuntime.log = fflState.hint
      ? 'XOR hint on: legal moves show how many bits they flip; point at one to see which.'
      : 'XOR hint off: legal moves are no longer marked.';
    fflSave();
    fflRender();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // The board cell an event came from, as its index, or -1.
  function fflCellIndex(target) {
    var cell = target.closest('.ffl-cell');
    return cell ? fflRuntime.cells.indexOf(cell) : -1;
  }

  function fflHandleBoardClick(event) {
    var index = fflCellIndex(event.target);
    if (index !== -1) {
      fflPlay(index);
    }
  }

  // Pointing at a cell (mouse hover or keyboard focus) previews its flips.
  function fflHandleHover(event) {
    var index = fflCellIndex(event.target);
    if (index !== fflRuntime.preview) {
      fflRuntime.preview = index;
      fflRenderBoard();
    }
  }

  function fflHandleLeave() {
    if (fflRuntime.preview !== -1) {
      fflRuntime.preview = -1;
      fflRenderBoard();
    }
  }

  function fflHandleFocus(event) {
    var index = fflCellIndex(event.target);
    if (index !== -1) {
      fflRuntime.cursor = index;
    }
    fflHandleHover(event);
  }

  function fflMoveCursor(from, step) {
    var row = (from >> 3) + step[0];
    var col = (from & 7) + step[1];
    var to = fflInside(row, col) ? row * FFL_SIZE + col : from;
    fflRuntime.cursor = to;
    fflRuntime.preview = to;
    fflRenderBoard();
    fflRuntime.cells[to].focus();
  }

  function fflIsField(target) {
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  // 'undo' or 'new' for a keydown, or null: the key value first, and the
  // physical U / N keys for keyboard layouts that type no Latin letter there.
  function fflKeyAction(event) {
    var key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (fflHasOwn(FFL_KEY_ACTIONS, key)) {
      return FFL_KEY_ACTIONS[key];
    }
    if (!/^[a-z]$/.test(key) && fflHasOwn(FFL_CODE_ACTIONS, event.code)) {
      return FFL_CODE_ACTIONS[event.code];
    }
    return null;
  }

  // Keys pressed inside the game (the listener sits on the wrapper): arrows
  // and Enter / Space on a board cell, U and N anywhere but the select.
  function fflHandleKeydown(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
      return;
    }
    var key = event.key;
    var index = fflCellIndex(event.target);
    if (index !== -1 && fflHasOwn(FFL_ARROWS, key)) {
      event.preventDefault();
      fflMoveCursor(index, FFL_ARROWS[key]);
      return;
    }
    if (index !== -1 && (key === 'Enter' || key === ' ')) {
      event.preventDefault();
      if (!event.repeat) {
        fflPlay(index);
      }
      return;
    }
    var action = fflKeyAction(event);
    if (!action || event.repeat || fflIsField(event.target)) {
      return;
    }
    event.preventDefault();
    if (action === 'undo') {
      fflUndo();
    } else {
      fflRequestNewGame();
    }
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function fflSpan(className) {
    var span = document.createElement('span');
    span.className = className;
    return span;
  }

  // The 64 cell buttons, made once and updated in place.
  function fflBuildBoard() {
    var board = fflRuntime.els.board;
    for (var i = 0; i < FFL_CELLS; i++) {
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'ffl-cell';
      board.appendChild(cell);
      fflRuntime.cells.push(cell);
    }
  }

  // The dump: per row its address, its 8 bits and the hex of each side.
  function fflBuildDump() {
    var dump = fflRuntime.els.dump;
    for (var row = 0; row < FFL_SIZE; row++) {
      var line = document.createElement('div');
      var entry = {
        addr: fflSpan('ffl-dump-addr'),
        bits: [],
        one: fflSpan('ffl-dump-hex ffl-dump-hex--one'),
        zero: fflSpan('ffl-dump-hex ffl-dump-hex--zero')
      };
      var bits = fflSpan('ffl-dump-bits');
      for (var col = 0; col < FFL_SIZE; col++) {
        entry.bits.push(bits.appendChild(fflSpan('ffl-bit')));
      }
      line.className = 'ffl-dump-row';
      line.appendChild(entry.addr);
      line.appendChild(bits);
      line.appendChild(entry.one);
      line.appendChild(entry.zero);
      dump.appendChild(line);
      fflRuntime.dump.push(entry);
    }
  }

  function fflBindEvents() {
    var els = fflRuntime.els;
    els.board.addEventListener('click', fflHandleBoardClick);
    els.board.addEventListener('mouseover', fflHandleHover);
    els.board.addEventListener('mouseleave', fflHandleLeave);
    els.board.addEventListener('focusin', fflHandleFocus);
    els.root.addEventListener('keydown', fflHandleKeydown);
    els.newGame.addEventListener('click', fflRequestNewGame);
    els.undo.addEventListener('click', fflUndo);
    els.hint.addEventListener('click', fflToggleHint);
    els.mode.addEventListener('change', fflHandleModeChange);
  }

  // Finds the page elements, builds the board once, binds the controls once
  // and restores the saved game (or starts a new one against CPU Normal).
  function fflInit() {
    if (fflRuntime.els) {
      return;
    }
    var byId = function (id) {
      return document.getElementById(id);
    };
    fflRuntime.els = {
      root: byId('ffl-game'),
      board: byId('ffl-board'),
      mode: byId('ffl-mode'),
      newGame: byId('ffl-new-game'),
      undo: byId('ffl-undo'),
      hint: byId('ffl-hint'),
      sideOne: byId('ffl-side-one'),
      sideZero: byId('ffl-side-zero'),
      nameOne: byId('ffl-name-one'),
      nameZero: byId('ffl-name-zero'),
      countOne: byId('ffl-count-one'),
      countZero: byId('ffl-count-zero'),
      maskOne: byId('ffl-mask-one'),
      maskZero: byId('ffl-mask-zero'),
      moves: byId('ffl-moves'),
      dump: byId('ffl-dump'),
      status: byId('ffl-status'),
      log: byId('ffl-log'),
      warning: byId('ffl-warning'),
      toast: byId('ffl-toast'),
      stats: {
        easy: byId('ffl-stat-easy'),
        normal: byId('ffl-stat-normal'),
        hard: byId('ffl-stat-hard')
      }
    };
    fflBuildBoard();
    fflBuildDump();
    fflBindEvents();
    fflAssign(fflState, fflParseState(fflStorageGet(FFL_STATE_KEY)));
    fflAssign(fflStats, fflParseStats(fflStorageGet(FFL_STATS_KEY)));
    var played = fflMovesPlayed(fflState.board);
    fflRuntime.log = played
      ? 'session restored: ' + fflPlural(played, 'move') + ' played, ' + fflMatchText(fflState.mode) + '.'
      : 'ready: ' + fflMatchText(fflState.mode) + '. 1s move first.';
    fflRuntime.els.mode.value = fflState.mode;
    fflSave();
    if (fflIsCpuTurn()) {
      fflScheduleCpu();
    }
    fflRender();
  }

  // Node (tests): export only, no init and no timers. Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      fflState: fflState,
      fflStats: fflStats,
      fflInit: fflInit,
      fflNewBoard: fflNewBoard,
      fflFlips: fflFlips,
      fflIsLegal: fflIsLegal,
      fflLegalMoves: fflLegalMoves,
      fflMobility: fflMobility,
      fflApplyMove: fflApplyMove,
      fflCount: fflCount,
      fflIsOver: fflIsOver,
      fflWinner: fflWinner,
      fflNextTurn: fflNextTurn,
      fflWeights: fflWeights,
      fflEvaluate: fflEvaluate,
      fflOrderMoves: fflOrderMoves,
      fflShuffle: fflShuffle,
      fflPickWeighted: fflPickWeighted,
      fflSearch: fflSearch,
      fflChooseMove: fflChooseMove,
      fflRowMask: fflRowMask,
      fflHex: fflHex,
      fflMaskHex: fflMaskHex,
      fflAddress: fflAddress,
      fflRowBits: fflRowBits,
      fflBoardToString: fflBoardToString,
      fflStringToBoard: fflStringToBoard,
      fflSnapshot: fflSnapshot,
      fflParseSnapshot: fflParseSnapshot,
      fflResultText: fflResultText,
      fflStatusText: fflStatusText,
      fflParseState: fflParseState,
      fflParseStats: fflParseStats,
      fflMergeStats: fflMergeStats,
      fflStorageWarning: fflStorageWarning,
      fflKeyAction: fflKeyAction,
      fflWeightTable: FFL_WEIGHTS,
      fflLevels: FFL_LEVELS
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fflInit);
  } else {
    fflInit();
  }
})();
