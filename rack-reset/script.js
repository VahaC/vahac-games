// Rack Reset — script.js
// Prefix: rkr-
// Dependencies: none.
//
// The front panel of a rack shows an n x n grid of alarm LEDs (3x3 to 6x6).
// Pressing an LED flips it and its neighbours under the toggle mask of the
// rack model, and the goal is to clear every alarm in as few presses as
// possible.  Each row is also shown as a register in hex (a lit LED is a 1
// bit, the left column the highest bit), so 0x00 on every row is a reset rack.
//
// Rack models: each has its own toggle mask, a 3x3 stencil written as three
// hex digits, one per row from the top (bit 4 left, 2 centre, 1 right):
// 0x272 is the cross (+), 0x525 the diagonal X, 0x070 a row of three, 0x575
// an H, 0x632 a hook and 0x777 the full block.  Every mask holds its centre,
// so a press always flips the LED pressed.
//
// Boards: rkrGenerate presses every LED of an all-off rack with chance 1/2
// (so every solvable board is equally likely) and draws again when the
// presses cancel out to an empty rack or the rack needs fewer presses than
// the par floor of its size (3 on 3x3, 4 from 4x4 up), so no rack is dealt
// that one or two presses of the stencil reset.  The par of a board is its true
// minimum: rkrSolveGF2 solves the presses as a linear system over GF(2) by
// Gaussian elimination, also when the matrix is singular (it then returns
// one solution and a basis of the null space), and rkrMinPresses checks every
// solution in that coset for the fewest presses.  Only size and mask pairs
// whose null space has at most RKR_MAX_NULLITY dimensions are offered (the
// largest is 9, 512 candidates, for the block on 5x5), so the search is
// always quick.  The hint uses the same search on the board as it is now.
//
// Scoring: Presses counts the presses on the board now (Undo takes one back,
// Restart goes back to 0).  A reset scores its presses over par, and the best
// per model and size is the lowest of those; a rack where a hint was used,
// or a replay restarted after it was reset, is not scored.
//
// Keys: only while the board has the focus (Tab to it, or click an LED):
// arrows move the cursor, Space / Enter press the LED under it, H hint, U
// undo, R restart, N new game.  Ctrl / Alt / Cmd combinations and every key
// typed elsewhere on the host page are left alone; a held key repeats only
// the cursor moves.  A mouse click or a tap on Undo, Hint, Restart or New
// Game hands the focus back to the board, so the next Space presses an LED
// instead of clicking that button again.
//
// New racks: New Game, N or a new model or size deal at once while the rack
// in play has no presses or is reset.  With presses on it nothing is thrown
// away on one slip: a select only chooses the next rack, and New Game or N
// has to be pressed again within RKR_CONFIRM_MS (the toast names the rack
// that would be lost).
//
// Saves: rkr-state (the rack in play) and rkr-best (fewest presses over par
// and racks cleared per model and size).  Every field is checked on load and
// falls back on its own; a save that cannot be played gives a fresh rack, and
// storage that is blocked or full never stops the game.  When the undo
// history has dropped presses (moves above its length), the saved grid is
// kept with it, since presses commute and Undo only needs the grid.
//
// Tabs: every rkr-state write carries a revision one higher than the last
// one on disk.  Before a press, Undo, Hint, Restart or a new rack the save is
// read again, and a newer revision another tab wrote is taken over instead of
// played on or dealt over;
// the storage event and a page shown again do the same.  A reset is merged
// with the rkr-best on disk, so no tab erases another's best.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser rkrInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var RKR_STATE_KEY = 'rkr-state';
  var RKR_BEST_KEY = 'rkr-best';
  var RKR_SAVE_VERSION = 1;

  var RKR_MODELS = [
    { key: '272', mask: 0x272, name: 'cross' },
    { key: '525', mask: 0x525, name: 'X-link' },
    { key: '070', mask: 0x070, name: 'row bus' },
    { key: '575', mask: 0x575, name: 'H-frame' },
    { key: '632', mask: 0x632, name: 'hook' },
    { key: '777', mask: 0x777, name: 'block' }
  ];
  var RKR_SIZES = [3, 4, 5, 6];
  var RKR_DEFAULT_MODEL = '272';
  var RKR_DEFAULT_SIZE = 5;

  // The most null-space dimensions rkrMinPresses enumerates (2^12 = 4096
  // candidates).  Every offered model and size stays far below it.
  var RKR_MAX_NULLITY = 12;
  var RKR_GENERATE_TRIES = 20;
  // The fewest presses a dealt rack needs, per size.
  var RKR_PAR_FLOOR = { 3: 3, 4: 4, 5: 4, 6: 4 };
  var RKR_HISTORY_CAP = 500;
  var RKR_TOAST_MS = 2000;
  var RKR_CONFIRM_MS = 4000;
  var RKR_COLUMNS = 'ABCDEF';

  // Keys by KeyboardEvent.key (lower-cased), then by the physical key when
  // the key typed one character that is no Latin letter (a Cyrillic layout,
  // say); on a Latin layout such as Dvorak only the letter itself counts.
  var RKR_KEYS = {
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
    ' ': 'press',
    enter: 'press',
    h: 'hint',
    u: 'undo',
    r: 'restart',
    n: 'new'
  };
  var RKR_CODES = { KeyH: 'hint', KeyU: 'undo', KeyR: 'restart', KeyN: 'new' };
  var RKR_MOVES = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };

  // ── State ─────────────────────────────────────────────────────────────────

  // game: the rack in play (rkrFreshGame / rkrParseGame): { rev, model,
  // size, start, grid, moves, history, hinted, replay, par, solved }; start
  // and grid hold one 0 / 1 per LED, row by row, history the LEDs pressed (at
  // most RKR_HISTORY_CAP, the oldest dropped first).  best: rkrParseBest.
  var rkrState = {
    game: null,
    best: null
  };

  // Page handles, never saved.  built: the game the LEDs on screen were
  // built for.  hint: the LED a hint pointed at (-1 for none) and hintLeft
  // the presses the optimum needed from there; both go with the next change
  // of the board.  keys: the last input was a key, so the cursor shows.
  // failed: the storage keys that could not be read or written.  pending:
  // the { model, size } the selects chose while the rack in play had presses
  // (null for none).  confirm: { game, rev } of the rack New Game or N may
  // throw away on the next press, until confirmTimeout ends it.
  var rkrRuntime = {
    els: null,
    built: null,
    leds: [],
    regs: [],
    maskCells: [],
    cursor: 0,
    keys: false,
    hint: -1,
    hintLeft: 0,
    toastTimeout: null,
    pending: null,
    confirm: null,
    confirmTimeout: null,
    failed: []
  };

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function rkrHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function rkrFill(length, value) {
    var out = [];
    for (var i = 0; i < length; i++) {
      out.push(value);
    }
    return out;
  }

  function rkrPresses(count) {
    return count + ' press' + (count === 1 ? '' : 'es');
  }

  function rkrModelOf(key) {
    for (var i = 0; i < RKR_MODELS.length; i++) {
      if (RKR_MODELS[i].key === key) {
        return RKR_MODELS[i];
      }
    }
    return null;
  }

  function rkrComboKey(model, size) {
    return model + '-' + size;
  }

  // Every model and size the game offers, as 'model-size' keys.
  function rkrCombos() {
    var out = [];
    RKR_MODELS.forEach(function (model) {
      RKR_SIZES.forEach(function (size) {
        out.push(rkrComboKey(model.key, size));
      });
    });
    return out;
  }

  // The choice of the two selects as { model, size }; an unknown model or
  // size is the default one.
  function rkrConfigOf(model, size) {
    var n = parseInt(size, 10);
    return {
      model: rkrModelOf(model) ? model : RKR_DEFAULT_MODEL,
      size: RKR_SIZES.indexOf(n) === -1 ? RKR_DEFAULT_SIZE : n
    };
  }

  function rkrModelText(model) {
    return 'RK-' + model + ' ' + rkrModelOf(model).name;
  }

  function rkrRackText(game) {
    return 'RK-' + game.model + ' ' + game.size + 'x' + game.size;
  }

  // ── Masks and racks (no DOM) ──────────────────────────────────────────────

  // A toggle mask as three hex digits: 0x272.
  function rkrMaskHex(mask) {
    var hex = mask.toString(16).toUpperCase();
    while (hex.length < 3) {
      hex = '0' + hex;
    }
    return '0x' + hex;
  }

  // The cells of the 3x3 stencil a mask switches on, as [row step, column
  // step] pairs from the top left, row by row.
  function rkrMaskOffsets(mask) {
    var out = [];
    for (var dr = -1; dr <= 1; dr++) {
      var digit = (mask >> (4 * (1 - dr))) & 7;
      for (var dc = -1; dc <= 1; dc++) {
        if ((digit >> (1 - dc)) & 1) {
          out.push([dr, dc]);
        }
      }
    }
    return out;
  }

  // The LEDs a press on index flips, in index order (the stencil clipped at
  // the edges of the rack).
  function rkrToggled(n, index, mask) {
    var row = Math.floor(index / n);
    var col = index % n;
    var out = [];
    rkrMaskOffsets(mask).forEach(function (step) {
      var r = row + step[0];
      var c = col + step[1];
      if (r >= 0 && r < n && c >= 0 && c < n) {
        out.push(r * n + c);
      }
    });
    return out;
  }

  // A new grid: grid with the press on index applied.
  function rkrPress(grid, n, index, mask) {
    var out = grid.slice();
    rkrToggled(n, index, mask).forEach(function (i) {
      out[i] = 1 - out[i];
    });
    return out;
  }

  function rkrIsSolved(grid) {
    return grid.indexOf(1) === -1;
  }

  function rkrLitCount(grid) {
    return grid.filter(function (v) {
      return v === 1;
    }).length;
  }

  // The presses as a linear system over GF(2): bit j of the equation for LED
  // i is set when a press on j flips i, and the last column is the LED now.
  // Gaussian elimination brings it to reduced row echelon form.  Returns
  // null when no presses clear the grid, else { x, basis, rank }: x one set of
  // presses that clears it (0 / 1 per LED, every free variable 0) and basis
  // the null space (presses that change nothing), one vector per free
  // column.  A singular matrix is the usual case, not an error.
  function rkrSolveGF2(grid, n, mask) {
    var total = n * n;
    var rows = [];
    var i;
    for (i = 0; i < total; i++) {
      var row = rkrFill(total + 1, 0);
      row[total] = grid[i];
      rows.push(row);
    }
    for (var j = 0; j < total; j++) {
      rkrToggled(n, j, mask).forEach(function (cell) {
        rows[cell][j] = 1;
      });
    }
    var pivots = [];
    for (var c = 0; c < total; c++) {
      var r = pivots.length;
      var p = r;
      while (p < total && rows[p][c] === 0) {
        p++;
      }
      if (p === total) {
        continue;
      }
      var swap = rows[p];
      rows[p] = rows[r];
      rows[r] = swap;
      for (i = 0; i < total; i++) {
        if (i !== r && rows[i][c] === 1) {
          for (var k = c; k <= total; k++) {
            rows[i][k] ^= rows[r][k];
          }
        }
      }
      pivots.push(c);
    }
    var rank = pivots.length;
    for (i = rank; i < total; i++) {
      if (rows[i][total] === 1) {
        return null;
      }
    }
    var x = rkrFill(total, 0);
    pivots.forEach(function (col, at) {
      x[col] = rows[at][total];
    });
    var basis = [];
    for (var f = 0; f < total; f++) {
      if (pivots.indexOf(f) === -1) {
        var v = rkrFill(total, 0);
        v[f] = 1;
        pivots.forEach(function (col, at) {
          v[col] = rows[at][f];
        });
        basis.push(v);
      }
    }
    return { x: x, basis: basis, rank: rank };
  }

  // The dimension of the null space of a mask on an n x n rack: how many
  // independent sets of presses change nothing.
  function rkrNullity(n, mask) {
    return rkrSolveGF2(rkrFill(n * n, 0), n, mask).basis.length;
  }

  // The fewest presses that clear grid, as the LEDs to press in index order
  // (each once; order does not matter), or null when nothing clears it.  The
  // solutions are x plus every combination of the null-space basis; they
  // are walked in Gray-code order, so each candidate differs from the one
  // before by one basis vector, and the first with the fewest presses wins.
  // A null space of more than RKR_MAX_NULLITY dimensions is refused, naming
  // its size, because the game never offers one.
  function rkrMinPresses(grid, n, mask) {
    var sol = rkrSolveGF2(grid, n, mask);
    if (!sol) {
      return null;
    }
    var k = sol.basis.length;
    if (k > RKR_MAX_NULLITY) {
      throw new Error('rkrMinPresses: the null space of mask ' + rkrMaskHex(mask) + ' on ' + n + 'x' + n +
        ' has dimension ' + k + ', more than ' + RKR_MAX_NULLITY);
    }
    var cand = sol.x.slice();
    var weight = rkrLitCount(cand);
    var best = cand.slice();
    var bestWeight = weight;
    var count = Math.pow(2, k);
    for (var m = 1; m < count; m++) {
      var bit = 0;
      while (!((m >> bit) & 1)) {
        bit++;
      }
      var vec = sol.basis[bit];
      for (var i = 0; i < cand.length; i++) {
        if (vec[i] === 1) {
          weight += cand[i] === 1 ? -1 : 1;
          cand[i] = 1 - cand[i];
        }
      }
      if (weight < bestWeight) {
        bestWeight = weight;
        best = cand.slice();
      }
    }
    var out = [];
    best.forEach(function (v, i) {
      if (v === 1) {
        out.push(i);
      }
    });
    return out;
  }

  // A new rack: every LED of an all-off grid pressed with chance 1/2 of rnd
  // (a function giving numbers in [0, 1)), drawn again when the presses
  // cancel out or the rack resets in fewer than RKR_PAR_FLOOR presses.
  // After RKR_GENERATE_TRIES such draws (only a broken random source gets
  // there) the LEDs are pressed in index order from all-off until the par
  // reaches the floor (at most n * n presses; the tests check that every
  // offered model and size gets there).
  function rkrGenerate(n, mask, rnd) {
    var total = n * n;
    var floor = RKR_PAR_FLOOR[n];
    var grid;
    var i;
    for (var tries = 0; tries < RKR_GENERATE_TRIES; tries++) {
      grid = rkrFill(total, 0);
      for (i = 0; i < total; i++) {
        if (rnd() < 0.5) {
          grid = rkrPress(grid, n, i, mask);
        }
      }
      if (!rkrIsSolved(grid) && rkrMinPresses(grid, n, mask).length >= floor) {
        return grid;
      }
    }
    grid = rkrFill(total, 0);
    for (i = 0; i < total && rkrMinPresses(grid, n, mask).length < floor; i++) {
      grid = rkrPress(grid, n, i, mask);
    }
    return grid;
  }

  // The register of row r: the LEDs as bits, the left one highest, in hex
  // with as many digits as the row needs (0xB on 4 LEDs, 0x1F on 5).
  function rkrRowHex(grid, n, r) {
    var value = 0;
    for (var c = 0; c < n; c++) {
      value = value * 2 + grid[r * n + c];
    }
    var hex = value.toString(16).toUpperCase();
    var digits = Math.ceil(n / 4);
    while (hex.length < digits) {
      hex = '0' + hex;
    }
    return '0x' + hex;
  }

  // LED names as on a panel: column letter, row number (A1 top left).
  function rkrCellName(index, n) {
    return RKR_COLUMNS.charAt(index % n) + (Math.floor(index / n) + 1);
  }

  // The cursor moved one step by [dr, dc]; it stops at the edges.
  function rkrStep(index, n, move) {
    var r = Math.floor(index / n) + move[0];
    var c = index % n + move[1];
    if (r < 0 || r >= n || c < 0 || c >= n) {
      return index;
    }
    return r * n + c;
  }

  function rkrCentre(n) {
    return Math.floor(n / 2) * n + Math.floor(n / 2);
  }

  // A grid as row strings of 0 and 1 (the save format) and back.
  function rkrGridRows(grid, n) {
    var rows = [];
    for (var r = 0; r < n; r++) {
      rows.push(grid.slice(r * n, r * n + n).join(''));
    }
    return rows;
  }

  // An n x n grid from row strings, or null unless value is n strings of n
  // characters 0 / 1.
  function rkrRowsGrid(value, n) {
    if (!Array.isArray(value) || value.length !== n) {
      return null;
    }
    var grid = [];
    for (var r = 0; r < n; r++) {
      var row = value[r];
      if (typeof row !== 'string' || !/^[01]+$/.test(row) || row.length !== n) {
        return null;
      }
      for (var c = 0; c < n; c++) {
        grid.push(row.charAt(c) === '1' ? 1 : 0);
      }
    }
    return grid;
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function rkrParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function rkrIsObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function rkrIsCount(value) {
    return typeof value === 'number' && value % 1 === 0 && value >= 0;
  }

  // A game at the start of a rack.
  function rkrFreshGame(model, size, start, rev) {
    return {
      rev: rev,
      model: model,
      size: size,
      start: start.slice(),
      grid: start.slice(),
      moves: 0,
      history: [],
      hinted: false,
      replay: false,
      par: rkrMinPresses(start, size, rkrModelOf(model).mask).length,
      solved: false
    };
  }

  // A new random rack of a model and size.
  function rkrNewRack(model, size, rnd, rev) {
    return rkrFreshGame(model, size, rkrGenerate(size, rkrModelOf(model).mask, rnd), rev);
  }

  // The LEDs pressed so far, or null unless value is a list of at most
  // RKR_HISTORY_CAP LED numbers of an n x n rack.
  function rkrHistoryOf(value, n) {
    if (!Array.isArray(value) || value.length > RKR_HISTORY_CAP) {
      return null;
    }
    for (var i = 0; i < value.length; i++) {
      var v = value[i];
      if (!rkrIsCount(v) || v >= n * n) {
        return null;
      }
    }
    return value.slice();
  }

  // A saved game, or null when it cannot be played: an unknown model or
  // size, or a start that is empty or that no presses clear.  Every other
  // field falls back on its own: history to none; a grid that is no grid,
  // or one no presses clear, to the start with the history replayed (and
  // moves to the history's length); a grid that differs from that replay
  // but can be cleared is kept, with its history when moves are above the
  // history's length (the cap dropped the oldest presses, so the replay
  // cannot match; presses commute, so Undo still takes back the kept ones)
  // and without it otherwise; moves to the history's length; hinted,
  // replay and rev to false, false and 0.
  function rkrParseGame(data) {
    var model = rkrModelOf(data.model);
    var n = data.size;
    if (!model || RKR_SIZES.indexOf(n) === -1) {
      return null;
    }
    var start = rkrRowsGrid(data.start, n);
    if (!start || rkrIsSolved(start) || !rkrSolveGF2(start, n, model.mask)) {
      return null;
    }
    var history = rkrHistoryOf(data.history, n) || [];
    var replayed = start;
    history.forEach(function (index) {
      replayed = rkrPress(replayed, n, index, model.mask);
    });
    var grid = rkrRowsGrid(data.grid, n);
    var moves = rkrIsCount(data.moves) && data.moves >= history.length ? data.moves : history.length;
    if (!grid || !rkrSolveGF2(grid, n, model.mask)) {
      grid = replayed;
      moves = history.length;
    } else if (grid.join('') !== replayed.join('') && moves === history.length) {
      history = [];
    }
    var game = rkrFreshGame(model.key, n, start, rkrIsCount(data.rev) ? data.rev : 0);
    game.grid = grid;
    game.moves = moves;
    game.history = history;
    game.hinted = data.hinted === true;
    game.replay = data.replay === true;
    game.solved = rkrIsSolved(grid);
    return game;
  }

  // rkr-state as { model, size, game }: game is null when the save holds no
  // playable game; model and size are then what it asked for, or the
  // defaults.
  function rkrParseState(text) {
    var data = rkrParseJson(text);
    if (!rkrIsObject(data)) {
      data = {};
    }
    var config = rkrConfigOf(data.model, data.size);
    return {
      model: config.model,
      size: config.size,
      game: rkrParseGame(data)
    };
  }

  // rkr-best as { 'model-size': { over, wins } } for every offered model and
  // size: over the fewest presses over par of a scored reset (null for none
  // yet), wins the scored resets.
  function rkrParseBest(text) {
    var data = rkrParseJson(text);
    var best = {};
    rkrCombos().forEach(function (key) {
      var entry = rkrIsObject(data) && rkrIsObject(data[key]) ? data[key] : {};
      best[key] = {
        over: rkrIsCount(entry.over) ? entry.over : null,
        wins: rkrIsCount(entry.wins) ? entry.wins : 0
      };
    });
    return best;
  }

  // Two rkr-best records merged entry by entry (the lower over, the higher
  // wins), so a best one tab wrote is never lost to another tab's.
  function rkrMergeBest(a, b) {
    var best = {};
    rkrCombos().forEach(function (key) {
      var x = a[key].over;
      var y = b[key].over;
      best[key] = {
        over: x === null || (y !== null && y < x) ? y : x,
        wins: Math.max(a[key].wins, b[key].wins)
      };
    });
    return best;
  }

  function rkrSerializeState(game) {
    return {
      v: RKR_SAVE_VERSION,
      rev: game.rev,
      model: game.model,
      size: game.size,
      start: rkrGridRows(game.start, game.size),
      grid: rkrGridRows(game.grid, game.size),
      moves: game.moves,
      history: game.history,
      hinted: game.hinted,
      replay: game.replay
    };
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // Names every key that could not be read or written, once each, what a
  // reload will show and how to fix it.  Full storage still holds the last
  // saves, so a reload goes back to them; blocked storage holds nothing.
  function rkrWarnStorage(key, error) {
    if (rkrRuntime.failed.indexOf(key) !== -1) {
      return;
    }
    rkrRuntime.failed.push(key);
    var warning = rkrRuntime.els.warning;
    var keys = rkrRuntime.failed.join(', ');
    var full = error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED';
    warning.textContent = full ?
      'Storage is full (' + error.name + '): ' + keys + ' not saved. The rack still plays, but a reload goes ' +
        'back to what was saved last. Free some storage for this site (its site data in the browser settings) to save again.' :
      'Storage is blocked (' + error.name + '): ' + keys + ' not saved. The rack still plays, but a reload deals ' +
        'a new rack and shows no bests. Allow site data for this site in the browser settings to keep them.';
    warning.classList.remove('rkr-hidden');
  }

  function rkrStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      rkrWarnStorage(key, error);
      return null;
    }
  }

  function rkrStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      rkrWarnStorage(key, error);
    }
  }

  // The playable game rkr-state holds now, or null.
  function rkrStoredGame() {
    return rkrParseState(rkrStorageGet(RKR_STATE_KEY)).game;
  }

  // Writes the rack in play with a revision one above both its own and the
  // one on disk, so another tab sees it as newer.
  function rkrSaveState() {
    var game = rkrState.game;
    var stored = rkrStoredGame();
    game.rev = Math.max(game.rev, stored ? stored.rev : 0) + 1;
    rkrStorageSet(RKR_STATE_KEY, JSON.stringify(rkrSerializeState(game)));
  }

  // Reads rkr-state again and takes over a game another tab saved with a
  // newer revision, with a toast naming it.  Returns whether it did.
  function rkrSyncState() {
    var stored = rkrStoredGame();
    if (!stored || stored.rev <= rkrState.game.rev) {
      return false;
    }
    rkrState.game = stored;
    rkrRuntime.hint = -1;
    if (rkrRuntime.cursor >= stored.size * stored.size) {
      rkrRuntime.cursor = rkrCentre(stored.size);
    }
    rkrRender();
    rkrShowToast('Another tab saved a newer game (' + rkrRackText(stored) + ', ' + rkrPresses(stored.moves) +
      '): it is shown here.', true);
    return true;
  }

  // Merges the rkr-best on disk into this tab's.
  function rkrSyncBest() {
    rkrState.best = rkrMergeBest(rkrState.best, rkrParseBest(rkrStorageGet(RKR_BEST_KEY)));
  }

  // Records a scored reset, merged with what another tab stored since.
  // Returns whether it beat the best of its model and size.
  function rkrRecordBest(game) {
    rkrSyncBest();
    var entry = rkrState.best[rkrComboKey(game.model, game.size)];
    var over = game.moves - game.par;
    var better = entry.over === null || over < entry.over;
    if (better) {
      entry.over = over;
    }
    entry.wins++;
    rkrStorageSet(RKR_BEST_KEY, JSON.stringify(rkrState.best));
    return better;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  // The LEDs of a game, built once per game: n per row, then the row's
  // register, so the grid places everything in order.
  function rkrBuildBoard(game) {
    var board = rkrRuntime.els.board;
    var n = game.size;
    board.innerHTML = '';
    board.style.gridTemplateColumns = 'repeat(' + n + ', var(--rkr-led)) var(--rkr-reg)';
    rkrRuntime.built = game;
    rkrRuntime.leds = [];
    rkrRuntime.regs = [];
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var led = document.createElement('div');
        var index = r * n + c;
        led.id = 'rkr-led-' + index;
        led.setAttribute('data-index', index);
        led.setAttribute('role', 'button');
        board.appendChild(led);
        rkrRuntime.leds.push(led);
      }
      var reg = document.createElement('span');
      reg.setAttribute('aria-hidden', 'true');
      board.appendChild(reg);
      rkrRuntime.regs.push(reg);
    }
  }

  // The 3x3 stencil of the mask, lit where a press flips.
  function rkrDrawMask(mask) {
    var on = rkrMaskOffsets(mask).map(function (step) {
      return (step[0] + 1) * 3 + step[1] + 1;
    });
    rkrRuntime.maskCells.forEach(function (cell, i) {
      cell.className = 'rkr-mask-cell' + (on.indexOf(i) !== -1 ? ' rkr-mask-cell--on' : '') +
        (i === 4 ? ' rkr-mask-cell--self' : '');
    });
  }

  function rkrBestText(entry) {
    if (entry.over === null) {
      return '--';
    }
    return entry.over === 0 ? 'par' : '+' + entry.over;
  }

  // ' Hint used: not scored.' / ' Replay: not scored.' for a rack that sets
  // no best, '' for one that does.
  function rkrUnscoredText(game) {
    if (game.hinted) {
      return ' Hint used: not scored.';
    }
    return game.replay ? ' Replay: not scored.' : '';
  }

  function rkrStatusText(game, mask) {
    var total = game.size * game.size;
    var over = game.moves - game.par;
    if (game.solved) {
      return 'Rack reset: all ' + total + ' alarms cleared in ' + rkrPresses(game.moves) + ' (par ' + game.par +
        (over === 0 ? ', on par' : ', +' + over) + ').' + rkrUnscoredText(game) + ' New Game deals the next rack.';
    }
    return rkrLitCount(game.grid) + ' of ' + total + ' alarms lit. A press flips the LEDs under mask ' +
      rkrMaskHex(mask) + ' around it.' + rkrUnscoredText(game);
  }

  function rkrSolverText(game, mask) {
    var k = rkrNullity(game.size, mask);
    var total = game.size * game.size;
    return 'GF(2) solver: rank ' + (total - k) + ' of ' + total + ', null space dimension ' + k + ', ' +
      Math.pow(2, k) + (k === 0 ? ' candidate' : ' candidates') + ' for the minimum.';
  }

  function rkrHintText(game) {
    if (rkrRuntime.hint === -1) {
      return '';
    }
    return 'Hint: press ' + rkrCellName(rkrRuntime.hint, game.size) + '. From here the rack resets in ' +
      rkrPresses(rkrRuntime.hintLeft) + '.';
  }

  function rkrDrawLeds(game) {
    var n = game.size;
    rkrRuntime.leds.forEach(function (led, i) {
      var on = game.grid[i] === 1;
      led.className = 'rkr-led' + (on ? ' rkr-led--on' : '') + (i === rkrRuntime.cursor ? ' rkr-led--cursor' : '') +
        (i === rkrRuntime.hint ? ' rkr-led--hint' : '');
      led.setAttribute('aria-label', rkrCellName(i, n) + (on ? ' alarm on' : ' clear'));
    });
    rkrRuntime.regs.forEach(function (reg, r) {
      var hex = rkrRowHex(game.grid, n, r);
      reg.textContent = hex;
      reg.className = 'rkr-reg' + (/^0x0+$/.test(hex) ? ' rkr-reg--zero' : '');
    });
  }

  function rkrRender() {
    var els = rkrRuntime.els;
    var game = rkrState.game;
    var mask = rkrModelOf(game.model).mask;
    var n = game.size;
    var lit = rkrLitCount(game.grid);
    var combo = rkrComboKey(game.model, n);
    if (rkrRuntime.built !== game) {
      rkrBuildBoard(game);
    }
    rkrDrawLeds(game);
    rkrDrawMask(mask);
    els.board.className = 'rkr-board rkr-board--n' + n + (game.solved ? ' rkr-board--solved' : '') +
      (rkrRuntime.keys ? ' rkr-board--keys' : '');
    els.board.setAttribute('aria-label', 'Rack ' + rkrRackText(game) + ': ' + lit + ' of ' + n * n + ' alarms lit');
    els.board.setAttribute('aria-activedescendant', 'rkr-led-' + rkrRuntime.cursor);
    // The selects show the next rack they chose, else the one in play.
    var chosen = rkrRuntime.pending || game;
    els.model.value = chosen.model;
    els.size.value = String(chosen.size);
    els.mode.textContent = rkrModelText(game.model) + ' · ' + n + 'x' + n + ' · mask ' + rkrMaskHex(mask);
    els.maskHex.textContent = rkrMaskHex(mask);
    els.lit.textContent = lit + '/' + n * n;
    els.moves.textContent = String(game.moves);
    els.par.textContent = String(game.par);
    els.best.textContent = rkrBestText(rkrState.best[combo]);
    els.cleared.textContent = String(rkrState.best[combo].wins);
    els.status.textContent = rkrStatusText(game, mask);
    els.solver.textContent = rkrSolverText(game, mask);
    els.hint.textContent = rkrHintText(game);
  }

  function rkrHideToast() {
    clearTimeout(rkrRuntime.toastTimeout);
    rkrRuntime.toastTimeout = null;
    rkrRuntime.els.toast.classList.remove('rkr-show');
  }

  // Shows message for ms (RKR_TOAST_MS when left out); a newer toast gets
  // its full time.  warn marks a refusal or a notice (amber), else a result
  // (green).
  function rkrShowToast(message, warn, ms) {
    var toast = rkrRuntime.els.toast;
    clearTimeout(rkrRuntime.toastTimeout);
    toast.textContent = message;
    toast.classList.toggle('rkr-toast--warn', warn === true);
    toast.classList.add('rkr-show');
    rkrRuntime.toastTimeout = setTimeout(rkrHideToast, ms || RKR_TOAST_MS);
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  // Ends a pending New Game confirmation.
  function rkrDisarm() {
    clearTimeout(rkrRuntime.confirmTimeout);
    rkrRuntime.confirmTimeout = null;
    rkrRuntime.confirm = null;
  }

  // Puts a game on screen with the cursor in the middle and saves it; the
  // toast, a choice of the selects and a confirmation about the rack before
  // go with it.
  function rkrShowGame(game) {
    rkrState.game = game;
    rkrRuntime.hint = -1;
    rkrRuntime.pending = null;
    rkrDisarm();
    rkrHideToast();
    rkrRuntime.cursor = rkrCentre(game.size);
    rkrRender();
    rkrSaveState();
  }

  // The model and size the selects show.
  function rkrChosenConfig() {
    return rkrConfigOf(rkrRuntime.els.model.value, rkrRuntime.els.size.value);
  }

  // New Game or N (confirms true) or a select (false) asks for a new rack of
  // config.  It is dealt at once when the rack in play has no presses or is
  // reset, or when New Game or N comes again within RKR_CONFIRM_MS of the
  // toast that asked for it, on the same rack.  Otherwise the rack stays: a
  // select only keeps its choice for the next New Game (choosing the rack in
  // play again drops it), and the toast names the rack and its presses.  A
  // newer game another tab saved is taken over first, never dealt over.
  function rkrRequestNew(config, confirms) {
    if (rkrSyncState()) {
      return;
    }
    var game = rkrState.game;
    var armed = rkrRuntime.confirm;
    if (game.solved || game.moves === 0 || (confirms && armed && armed.game === game && armed.rev === game.rev)) {
      rkrShowGame(rkrNewRack(config.model, config.size, Math.random, game.rev));
      return;
    }
    var same = config.model === game.model && config.size === game.size;
    rkrRuntime.pending = same ? null : config;
    rkrDisarm();
    if (same && !confirms) {
      rkrHideToast();
      rkrRender();
      return;
    }
    rkrRuntime.confirm = { game: game, rev: game.rev };
    rkrRuntime.confirmTimeout = setTimeout(rkrDisarm, RKR_CONFIRM_MS);
    rkrRender();
    rkrShowToast('Rack ' + rkrRackText(game) + ' has ' + rkrPresses(game.moves) + ' on it: press New Game or N within ' +
      RKR_CONFIRM_MS / 1000 + ' s to throw it away and deal a new ' + rkrRackText(config) + ' rack.', true, RKR_CONFIRM_MS);
  }

  function rkrHandleNewGame() {
    rkrRequestNew(rkrChosenConfig(), true);
  }

  function rkrHandleSelect() {
    rkrRequestNew(rkrChosenConfig(), false);
  }

  // A rack that is already reset refuses presses, Undo and Hint with a toast
  // naming its result.  Returns whether it refused.
  function rkrRefuseSolved(game) {
    if (!game.solved) {
      return false;
    }
    rkrShowToast('Rack ' + rkrRackText(game) + ' is already reset in ' + rkrPresses(game.moves) +
      ': Restart replays it, New Game deals the next one.', true);
    return true;
  }

  function rkrWin(game) {
    var scored = !game.hinted && !game.replay;
    var better = scored && rkrRecordBest(game);
    var over = game.moves - game.par;
    var result = rkrPresses(game.moves) + ' (par ' + game.par + (over === 0 ? ', on par' : ', +' + over) + ')';
    if (!scored) {
      rkrShowToast('Rack reset in ' + result + ': not scored.');
    } else if (better) {
      rkrShowToast('Rack reset in ' + result + ': new best for ' + rkrRackText(game) + '!');
    } else {
      rkrShowToast('Rack reset in ' + result + '.');
    }
  }

  // A press on LED index: flips it and its neighbours under the mask.  A
  // newer game from another tab is taken over instead (the press was made on
  // the old rack).
  function rkrPressLed(index) {
    if (rkrSyncState()) {
      return;
    }
    var game = rkrState.game;
    if (rkrRefuseSolved(game)) {
      return;
    }
    game.grid = rkrPress(game.grid, game.size, index, rkrModelOf(game.model).mask);
    game.history.push(index);
    if (game.history.length > RKR_HISTORY_CAP) {
      game.history.shift();
    }
    game.moves++;
    rkrRuntime.hint = -1;
    game.solved = rkrIsSolved(game.grid);
    if (game.solved) {
      rkrWin(game);
    }
    rkrRender();
    rkrSaveState();
  }

  function rkrUndo() {
    if (rkrSyncState()) {
      return;
    }
    var game = rkrState.game;
    if (rkrRefuseSolved(game)) {
      return;
    }
    if (!game.history.length) {
      rkrShowToast(game.moves ? 'Nothing more to undo: only the last ' + RKR_HISTORY_CAP + ' presses are kept (' +
        rkrPresses(game.moves) + ' on the rack).' : 'Nothing to undo: 0 presses on this rack.', true);
      return;
    }
    var index = game.history.pop();
    game.grid = rkrPress(game.grid, game.size, index, rkrModelOf(game.model).mask);
    game.moves--;
    rkrRuntime.hint = -1;
    rkrRuntime.cursor = index;
    rkrRender();
    rkrSaveState();
  }

  // Restart: the same rack from its first state.  Restarting a reset rack
  // gives a replay, which is not scored.
  function rkrRestart() {
    if (rkrSyncState()) {
      return;
    }
    var game = rkrState.game;
    if (!game.solved && game.grid.join('') === game.start.join('')) {
      rkrShowToast('Rack ' + rkrRackText(game) + ' is already at its first state (' + rkrPresses(game.moves) + ').', true);
      return;
    }
    game.replay = game.replay || game.solved;
    game.grid = game.start.slice();
    game.history = [];
    game.moves = 0;
    game.solved = false;
    rkrRuntime.hint = -1;
    rkrRender();
    rkrSaveState();
    rkrShowToast('Rack ' + rkrRackText(game) + ' restarted (par ' + game.par + ').' + rkrUnscoredText(game));
  }

  // Hint: one LED of a fewest-press reset from the rack as it is now; it
  // takes the cursor, and the rack is no longer scored.
  function rkrHint() {
    if (rkrSyncState()) {
      return;
    }
    var game = rkrState.game;
    if (rkrRefuseSolved(game)) {
      return;
    }
    var presses = rkrMinPresses(game.grid, game.size, rkrModelOf(game.model).mask);
    rkrRuntime.hint = presses[0];
    rkrRuntime.hintLeft = presses.length;
    rkrRuntime.cursor = presses[0];
    game.hinted = true;
    rkrRender();
    rkrSaveState();
  }

  function rkrMoveCursor(move) {
    rkrRuntime.cursor = rkrStep(rkrRuntime.cursor, rkrState.game.size, move);
    rkrRender();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // 'up' / 'down' / 'left' / 'right' / 'press' / 'hint' / 'undo' /
  // 'restart' / 'new' for a keydown, or null.  A keydown without a key
  // (Chrome autofill sends those) is null.
  function rkrKeyAction(event) {
    if (typeof event.key !== 'string') {
      return null;
    }
    var key = event.key.toLowerCase();
    if (rkrHasOwn(RKR_KEYS, key)) {
      return RKR_KEYS[key];
    }
    if (key.length !== 1 || /^[a-z]$/.test(key)) {
      return null;
    }
    return rkrHasOwn(RKR_CODES, event.code) ? RKR_CODES[event.code] : null;
  }

  // Keys reach this listener only while the board (or an LED in it) has the
  // focus.  A held key repeats only the cursor moves.
  function rkrHandleKeydown(event) {
    var action = rkrKeyAction(event);
    if (!action || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    rkrRuntime.keys = true;
    if (rkrHasOwn(RKR_MOVES, action)) {
      rkrMoveCursor(RKR_MOVES[action]);
    } else if (event.repeat) {
      return;
    } else if (action === 'press') {
      rkrPressLed(rkrRuntime.cursor);
    } else if (action === 'hint') {
      rkrHint();
    } else if (action === 'undo') {
      rkrUndo();
    } else if (action === 'restart') {
      rkrRestart();
    } else {
      rkrHandleNewGame();
    }
  }

  // A tap or a click on an LED presses it and takes the cursor; the
  // registers and the board's padding are no LED.
  function rkrHandleClick(event) {
    var led = event.target.closest('.rkr-led');
    if (!led) {
      return;
    }
    var index = Number(led.getAttribute('data-index'));
    rkrRuntime.keys = false;
    rkrRuntime.cursor = index;
    rkrPressLed(index);
  }

  // Another tab wrote to storage: a newer game is taken over, a best merged.
  function rkrHandleStorage(event) {
    if (event.key === RKR_STATE_KEY) {
      rkrSyncState();
    } else if (event.key === RKR_BEST_KEY) {
      rkrSyncBest();
      rkrRender();
    }
  }

  // A tab shown again (or a page restored from the back/forward cache, which
  // misses storage events) reads both saves again.
  function rkrHandleShow() {
    if (document.hidden) {
      return;
    }
    rkrSyncBest();
    if (!rkrSyncState()) {
      rkrRender();
    }
  }

  // A button's click listener: runs action, and after a mouse click or a tap
  // (event.detail above 0; Enter or Space on the button gives 0) moves the
  // focus to the board, so the next Space or Enter acts on the rack instead
  // of clicking the button again.
  function rkrButton(action) {
    return function (event) {
      action();
      if (event.detail > 0) {
        rkrRuntime.els.board.focus({ preventScroll: true });
      }
    };
  }

  function rkrBindEvents() {
    var els = rkrRuntime.els;
    els.board.addEventListener('click', rkrHandleClick);
    els.board.addEventListener('keydown', rkrHandleKeydown);
    els.newGame.addEventListener('click', rkrButton(rkrHandleNewGame));
    els.restart.addEventListener('click', rkrButton(rkrRestart));
    els.undo.addEventListener('click', rkrButton(rkrUndo));
    els.hintButton.addEventListener('click', rkrButton(rkrHint));
    els.model.addEventListener('change', rkrHandleSelect);
    els.size.addEventListener('change', rkrHandleSelect);
    document.addEventListener('visibilitychange', rkrHandleShow);
    window.addEventListener('pageshow', rkrHandleShow);
    window.addEventListener('storage', rkrHandleStorage);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function rkrFindElements() {
    return {
      board: document.getElementById('rkr-board'),
      newGame: document.getElementById('rkr-new-game'),
      restart: document.getElementById('rkr-restart'),
      undo: document.getElementById('rkr-undo'),
      hintButton: document.getElementById('rkr-hint-button'),
      model: document.getElementById('rkr-model'),
      size: document.getElementById('rkr-size'),
      mode: document.getElementById('rkr-mode'),
      maskGrid: document.getElementById('rkr-mask-grid'),
      maskHex: document.getElementById('rkr-mask-hex'),
      lit: document.getElementById('rkr-lit'),
      moves: document.getElementById('rkr-moves'),
      par: document.getElementById('rkr-par'),
      best: document.getElementById('rkr-best'),
      cleared: document.getElementById('rkr-cleared'),
      status: document.getElementById('rkr-status'),
      solver: document.getElementById('rkr-solver'),
      hint: document.getElementById('rkr-hint'),
      warning: document.getElementById('rkr-warning'),
      toast: document.getElementById('rkr-toast')
    };
  }

  // The nine cells of the mask preview, built once.
  function rkrBuildMaskGrid() {
    var grid = rkrRuntime.els.maskGrid;
    grid.innerHTML = '';
    for (var i = 0; i < 9; i++) {
      var cell = document.createElement('span');
      grid.appendChild(cell);
      rkrRuntime.maskCells.push(cell);
    }
  }

  // Finds the elements, binds the controls once and restores the saves: the
  // rack in play, or a new one of the saved (or default) model and size,
  // which is written at once.
  function rkrInit() {
    if (rkrRuntime.els) {
      return;
    }
    rkrRuntime.els = rkrFindElements();
    rkrBuildMaskGrid();
    rkrBindEvents();
    rkrState.best = rkrParseBest(rkrStorageGet(RKR_BEST_KEY));
    var saved = rkrParseState(rkrStorageGet(RKR_STATE_KEY));
    if (saved.game) {
      rkrState.game = saved.game;
      rkrRuntime.cursor = rkrCentre(saved.game.size);
      rkrRender();
    } else {
      rkrShowGame(rkrNewRack(saved.model, saved.size, Math.random, 0));
    }
  }

  // Node (tests): export only, no init and no timers.  Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      rkrState: rkrState,
      rkrRuntime: rkrRuntime,
      rkrInit: rkrInit,
      rkrModels: RKR_MODELS,
      rkrSizes: RKR_SIZES,
      rkrMaxNullity: RKR_MAX_NULLITY,
      rkrHistoryCap: RKR_HISTORY_CAP,
      rkrParFloor: RKR_PAR_FLOOR,
      rkrGenerateTries: RKR_GENERATE_TRIES,
      rkrCombos: rkrCombos,
      rkrConfigOf: rkrConfigOf,
      rkrMaskHex: rkrMaskHex,
      rkrMaskOffsets: rkrMaskOffsets,
      rkrToggled: rkrToggled,
      rkrPress: rkrPress,
      rkrIsSolved: rkrIsSolved,
      rkrSolveGF2: rkrSolveGF2,
      rkrNullity: rkrNullity,
      rkrMinPresses: rkrMinPresses,
      rkrGenerate: rkrGenerate,
      rkrRowHex: rkrRowHex,
      rkrCellName: rkrCellName,
      rkrStep: rkrStep,
      rkrGridRows: rkrGridRows,
      rkrRowsGrid: rkrRowsGrid,
      rkrKeyAction: rkrKeyAction,
      rkrParseState: rkrParseState,
      rkrParseBest: rkrParseBest,
      rkrMergeBest: rkrMergeBest
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rkrInit);
  } else {
    rkrInit();
  }
})();
