// Bitmap Decoder — script.js
// Prefix: bmd-
// Dependencies: none.
//
// A nonogram whose clues are run-length encoding: the numbers next to every
// row and column are the lengths of its runs of filled cells.  Fill the grid
// until every line matches and a hidden 1-bit icon decodes, shown afterwards
// as a hex dump, ASCII art and the icon's name.
//
// Modes: Daily (one 10x10 icon of the day from the built-in library, one
// scored attempt per day, a streak) and Endless (a 5x5 to 30x30 bitmap made
// from noise; 15x15 and up only on screens wide enough for them, see
// BMD_SCREEN_LIMITS).  Every puzzle can be solved by line logic alone,
// so it has exactly one solution.  Rules: Easy checks each move (a wrong cell
// counts as a mistake, and the size's limit of them ends the game, see
// BMD_MISTAKE_LIMITS), Relaxed checks each move with no limit (and sets no
// best time), Hard checks nothing until the grid matches every clue.
//
// Storage (localStorage, each read and write guarded):
//   bmd-state  { v, mode, size, rules, tool, endless }  the settings and the
//              Endless puzzle in progress (id, name, size, rules, solution,
//              fills, marks, mistakes, elapsed ms, status, practice: true
//              once it was restarted, so it sets no best time).
//   bmd-best   { "5": ms, "10": ms, ... "30": ms }  the best time per size.
//   bmd-daily  { v, day, icon, rules, fills, marks, mistakes, elapsed,
//              status, streak, lastWon, maxStreak }  today's attempt, written
//              the moment it begins, and the streak.
// Grids are saved as rows of '0' / '1' text.  Every field of a save falls
// back on its own, so a damaged save never stops the game.  The saves are
// written on every move and when the page is hidden or closed; a save made
// by another open tab of the game is taken over (see bmdHandleStorage), and
// a page shown again reads the saves back before it writes (see bmdResume).
//
// The clock of a puzzle runs from the moment it is on show in a visible
// page, not from the first move: reading the clues is part of the solve.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var BMD_NAME = 'Bitmap Decoder';
  var BMD_SIZES = [5, 10, 15, 20, 25, 30];
  var BMD_DAILY_SIZE = 10;
  var BMD_EMPTY = 0;
  var BMD_FILL = 1;
  var BMD_MARK = 2;
  // The mistakes Easy allows per board size: the last one ends the game.
  var BMD_MISTAKE_LIMITS = { 5: 3, 10: 3, 15: 5, 20: 6, 25: 8, 30: 10 };
  // The rules by value: Easy and Relaxed check each move, Hard does not.
  var BMD_RULES = ['easy', 'relaxed', 'hard'];
  var BMD_RULE_LABELS = { easy: 'Easy', relaxed: 'Relaxed', hard: 'Hard' };
  var BMD_STATE_KEY = 'bmd-state';
  var BMD_BEST_KEY = 'bmd-best';
  var BMD_DAILY_KEY = 'bmd-daily';
  // Daily #1 is 2026-11-01; days are counted in UTC, so DST never shifts them.
  var BMD_EPOCH = Date.UTC(2026, 10, 1);
  var BMD_DAY_MS = 86400000;
  // Days past this (a clock set centuries ahead) skip the no-repeat cycle.
  var BMD_LAST_CYCLED_DAY = 40000;
  var BMD_TICK_MS = 1000;
  // The midnight re-render waits this much past midnight, so it surely runs
  // on the new day.
  var BMD_MIDNIGHT_SLACK_MS = 1000;
  var BMD_TOAST_MS = 2200;
  var BMD_FILL_RATE = 0.55;
  var BMD_MIN_DENSITY = 0.3;
  var BMD_MAX_DENSITY = 0.75;
  // The big Endless sizes and the screens too narrow for them (the query),
  // smallest first: a size is offered only on a screen the query does not
  // match, so a screen too narrow for one is too narrow for every later one.
  // note says why the option is disabled.
  var BMD_SCREEN_LIMITS = [
    { size: 15, query: '(max-width: 600px)', note: 'screens over 600 px' },
    { size: 20, query: '(max-width: 767px)', note: 'screens 768 px and wider' },
    { size: 25, query: '(max-width: 1023px)', note: 'screens 1024 px and wider' },
    { size: 30, query: '(max-width: 1279px)', note: 'screens 1280 px and wider' }
  ];
  var BMD_MAX_TEXT = 64;
  // Cell classes and words by state (EMPTY, FILL, MARK).
  var BMD_CELL_CLASS = ['', ' bmd-cell--fill', ' bmd-cell--mark'];
  var BMD_CELL_WORD = ['empty', 'filled', 'marked'];
  var BMD_MOVES = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1]
  };

  // The icon library: original 10x10 pixel icons, one hex number per row
  // (10 bits, leftmost pixel in the highest bit).  Every one of them is
  // solved by line logic alone (tests/bitmap-decoder.test.js checks it).
  var BMD_ICONS = [
    { id: 'rack-server', name: 'Rack Server', hex: '3ff 201 2d5 201 3ff 3ff 201 2d5 201 3ff' },
    { id: 'floppy-disk', name: 'Floppy Disk', hex: '3fe 2f9 2d9 2f9 201 2fd 285 285 2fd 3ff' },
    { id: 'router', name: 'Router', hex: '102 102 102 102 3ff 201 2ad 201 3ff 102' },
    { id: 'cat', name: 'Cat', hex: '201 303 387 3ff 249 3ff 231 303 186 0fc' },
    { id: 'coffee-mug', name: 'Coffee Mug', hex: '090 048 090 000 3fc 207 205 207 204 1f8' },
    { id: 'key', name: 'Key', hex: '078 0cc 084 0cc 078 030 030 03c 030 038' },
    { id: 'padlock', name: 'Padlock', hex: '078 084 084 084 3ff 201 231 231 201 3ff' },
    { id: 'cloud', name: 'Cloud', hex: '000 038 1bc 3fe 3ff 3ff 1fe 000 000 000' },
    { id: 'shell-prompt', name: 'Shell Prompt', hex: '3ff 201 2c1 261 231 261 2dd 201 3ff 000' },
    { id: 'power-plug', name: 'Power Plug', hex: '088 088 1fc 1fc 1fc 0f8 070 020 020 030' },
    { id: 'battery', name: 'Battery', hex: '000 3fe 202 2db 2db 2db 202 3fe 000 000' },
    { id: 'bug', name: 'Bug', hex: '084 048 0fc 0b4 2fd 1fe 2fd 1fe 279 000' },
    { id: 'hard-drive', name: 'Hard Drive', hex: '3ff 241 279 285 2b5 285 27b 205 203 3ff' },
    { id: 'cpu', name: 'CPU', hex: '048 1fe 102 37b 14a 14a 37b 102 1fe 048' },
    { id: 'monitor', name: 'Monitor', hex: '3ff 201 281 2c1 201 201 3ff 030 078 1fe' },
    { id: 'mouse', name: 'Mouse', hex: '018 020 0f8 1ac 1ac 1fc 1fc 1fc 0f8 070' },
    { id: 'house', name: 'House', hex: '030 078 0fc 1fe 3ff 102 16a 162 162 1fe' },
    { id: 'wireless', name: 'Wireless', hex: '1fe 303 279 186 078 0cc 030 030 000 000' },
    { id: 'gear', name: 'Gear', hex: '030 17a 1fe 0cc 3cf 3cf 0cc 1fe 17a 030' },
    { id: 'lightning-bolt', name: 'Lightning Bolt', hex: '03c 078 0f0 1fc 0fc 038 070 0e0 0c0 100' },
    { id: 'heart', name: 'Heart', hex: '000 186 3cf 3ff 3ff 1fe 0fc 078 030 000' },
    { id: 'folder', name: 'Folder', hex: '000 3c0 27f 201 3ff 201 201 201 3ff 000' },
    { id: 'envelope', name: 'Envelope', hex: '000 3ff 387 2cd 279 231 201 201 3ff 000' },
    { id: 'magnifier', name: 'Magnifier', hex: '0f0 198 30c 284 30c 198 0fc 01e 00f 007' },
    { id: 'clock', name: 'Clock', hex: '0fc 1fe 3df 3df 3c7 3ff 3ff 1fe 0fc 000' },
    { id: 'bell', name: 'Bell', hex: '030 078 0fc 0fc 0fc 1fe 1fe 3ff 000 030' },
    { id: 'light-bulb', name: 'Light Bulb', hex: '078 0fc 1fe 1b6 1ce 0cc 078 000 078 030' },
    { id: 'database', name: 'Database', hex: '0fc 102 1fe 102 1fe 102 1fe 102 0fc 000' },
    { id: 'flash-drive', name: 'Flash Drive', hex: '078 048 078 0fc 084 0b4 084 084 084 0fc' },
    { id: 'headphones', name: 'Headphones', hex: '0fc 186 303 201 201 387 3cf 3cf 387 000' },
    { id: 'smartphone', name: 'Smartphone', hex: '1fe 132 1fe 102 17a 102 162 102 1ce 1fe' },
    { id: 'trash-can', name: 'Trash Can', hex: '078 3ff 000 1fe 14a 14a 14a 14a 102 0fc' },
    { id: 'shield', name: 'Shield', hex: '3ff 201 2fd 2fd 2fd 17a 17a 0b4 048 030' },
    { id: 'music-note', name: 'Music Note', hex: '07e 07e 042 042 042 042 1ce 3de 3de 18c' },
    { id: 'moon', name: 'Moon', hex: '078 0e0 1c0 3c0 380 380 3c0 1e1 0fe 078' },
    { id: 'skull', name: 'Skull', hex: '0fc 1fe 3ff 279 279 3ff 3cf 1fe 0b4 0fc' },
    { id: 'gamepad', name: 'Gamepad', hex: '000 000 1fe 3bb 315 3bb 3ff 387 303 000' },
    { id: 'cassette', name: 'Cassette', hex: '3ff 201 2fd 2b5 2fd 201 279 285 3ff 000' },
    { id: 'power-button', name: 'Power Button', hex: '030 1b6 333 231 201 201 303 1fe 0fc 000' },
    { id: 'hourglass', name: 'Hourglass', hex: '3ff 102 0fc 078 030 030 048 0b4 1fe 3ff' },
    { id: 'rubber-duck', name: 'Rubber Duck', hex: '070 0f8 0de 0fe 070 1fc 3ff 3ff 1fe 0fc' },
    { id: 'robot', name: 'Robot', hex: '030 030 1fe 102 36b 303 17a 102 1fe 084' },
    { id: 'rocket', name: 'Rocket', hex: '030 078 078 048 078 0fc 1fe 1b6 030 048' },
    { id: 'network-jack', name: 'Network Jack', hex: '3ff 201 2ab 2ab 201 201 387 084 0fc 000' },
    { id: 'thermometer', name: 'Thermometer', hex: '030 048 04a 048 07a 078 07a 0fc 0fc 078' },
    { id: 'camera', name: 'Camera', hex: '000 0e0 3ff 21d 223 22b 223 21d 3ff 000' },
    { id: 'printer', name: 'Printer', hex: '0fc 084 3ff 201 205 3ff 084 0b4 0fc 000' },
    { id: 'pine-tree', name: 'Pine Tree', hex: '030 078 0fc 078 0fc 1fe 0fc 1fe 3ff 030' },
    { id: 'flag', name: 'Flag', hex: '200 3f0 3f8 3fc 3f8 3f0 200 200 200 380' },
    { id: 'chat-bubble', name: 'Chat Bubble', hex: '1fe 3ff 3ff 2db 3ff 3ff 1fe 0c0 180 200' },
    { id: 'download', name: 'Download', hex: '078 078 078 078 3ff 1fe 0fc 078 030 3ff' },
    { id: 'memory-card', name: 'Memory Card', hex: '0ff 1ab 3ab 3ff 3ff 303 303 303 3ff 3ff' },
    { id: 'calendar', name: 'Calendar', hex: '108 3ff 3ff 201 2a9 201 2a9 201 3ff 000' },
    { id: 'toolbox', name: 'Toolbox', hex: '078 048 3ff 201 3cf 231 201 3ff 000 000' },
    { id: 'smiley', name: 'Smiley', hex: '0fc 1fe 37b 37b 3ff 2fd 37b 387 1fe 0fc' }
  ];

  // The 5x5 picture an Endless 5x5 board falls back to (see bmdGenerate).
  var BMD_MINI_ICON = { id: 'mini-heart', name: 'Mini Heart', hex: '0a 1f 1f 0e 04' };

  // ── State ─────────────────────────────────────────────────────────────────

  // The settings bmd-state keeps: the tab on show, the Endless size, the
  // rules for the next puzzle and what a tap does.
  var bmdState = { mode: 'daily', size: 10, rules: 'easy', tool: 'fill' };

  // The two puzzles: the Daily attempt (null until the Daily tab is shown)
  // and the Endless puzzle (null until the Endless tab is shown).
  var bmdGames = { daily: null, endless: null };

  // The streak part of bmd-daily, and the attempt it held when the page
  // loaded (attempt: a game, or null).
  var bmdRecord = { streak: 0, lastWon: null, maxStreak: 0, attempt: null };

  // Best times in ms per size, null for none.
  var bmdBest = { 5: null, 10: null, 15: null, 20: null, 25: null, 30: null };

  // Generation tuning (a test seam: tests lower attempts to reach the fallback).
  var bmdTuning = { attempts: 200 };

  // Page handles, never saved.
  var bmdRuntime = {
    els: null,
    cellEls: [],
    rowClueEls: [],
    colClueEls: [],
    builtFor: null,
    cursor: { row: 0, col: 0 },
    stroke: null,
    clockGame: null,
    clockStart: 0,
    interval: null,
    toastTimeout: null,
    midnightTimeout: null,
    warned: false,
    // The largest Endless size this screen offers (see BMD_SCREEN_LIMITS).
    maxSize: 30
  };

  // ── Small helpers (no DOM) ────────────────────────────────────────────────

  function bmdHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function bmdIsSize(value) {
    return BMD_SIZES.indexOf(value) !== -1;
  }

  function bmdIsInt(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  }

  // A finite number >= 0 rounded down (and capped at max when given), else 0.
  function bmdCount(value, max) {
    if (typeof value !== 'number' || !isFinite(value) || value < 0) {
      return 0;
    }
    return Math.min(Math.floor(value), max === undefined ? Infinity : max);
  }

  // A non-empty string of at most 64 characters, else fallback.
  function bmdText(value, fallback) {
    return typeof value === 'string' && value.length > 0 && value.length <= BMD_MAX_TEXT ? value : fallback;
  }

  function bmdPad2(number) {
    return number < 10 ? '0' + number : String(number);
  }

  function bmdPlural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  function bmdGridOf(size, value) {
    var grid = [];
    for (var row = 0; row < size; row++) {
      var line = [];
      for (var col = 0; col < size; col++) {
        line.push(value);
      }
      grid.push(line);
    }
    return grid;
  }

  function bmdColumn(grid, col) {
    return grid.map(function (line) {
      return line[col];
    });
  }

  function bmdColumns(grid) {
    return grid[0].map(function (value, col) {
      return bmdColumn(grid, col);
    });
  }

  function bmdSameList(a, b) {
    return a.length === b.length && a.every(function (value, i) {
      return value === b[i];
    });
  }

  // ── Clues and the line solver (no DOM) ────────────────────────────────────

  // The run-length encoding of a line: the lengths of its runs of 1s (a
  // FILL cell is 1), [] for a line with none.
  function bmdCluesOf(line) {
    var clues = [];
    var run = 0;
    line.forEach(function (value) {
      if (value === BMD_FILL) {
        run++;
      } else if (run) {
        clues.push(run);
        run = 0;
      }
    });
    if (run) {
      clues.push(run);
    }
    return clues;
  }

  // Whether a run of len filled cells can start at start: no known empty
  // cell under it and no filled cell right after it.
  function bmdRunFits(len, line, start) {
    var end = start + len;
    if (end > line.length) {
      return false;
    }
    for (var i = start; i < end; i++) {
      if (line[i] === 0) {
        return false;
      }
    }
    return end === line.length || line[end] !== 1;
  }

  function bmdTable(rows, cols) {
    var table = [];
    for (var i = 0; i < rows; i++) {
      var line = [];
      for (var j = 0; j < cols; j++) {
        line.push(false);
      }
      table.push(line);
    }
    return table;
  }

  // One line of the solver: clue is the run lengths, line the cells as -1
  // (unknown), 0 (empty) or 1 (filled).  Returns the line with every cell
  // that is the same in all placements of the runs that fit decided, or null
  // when no placement fits.  Dynamic programming over (cell, run): fits[i][j]
  // says cells i.. can hold runs j..; a forward pass then marks what each
  // cell can be.
  function bmdSolveLine(clue, line) {
    var n = line.length;
    var k = clue.length;
    var fits = bmdTable(n + 1, k + 1);
    var reach = bmdTable(n + 1, k + 1);
    var canFill = [];
    var canEmpty = [];
    var i;
    var j;
    fits[n][k] = true;
    for (i = n - 1; i >= 0; i--) {
      for (j = k; j >= 0; j--) {
        fits[i][j] = (line[i] !== 1 && fits[i + 1][j]) ||
          (j < k && bmdRunFits(clue[j], line, i) && fits[Math.min(i + clue[j] + 1, n)][j + 1]);
      }
    }
    if (!fits[0][0]) {
      return null;
    }
    for (i = 0; i < n; i++) {
      canFill.push(false);
      canEmpty.push(false);
    }
    reach[0][0] = true;
    for (i = 0; i < n; i++) {
      for (j = 0; j <= k; j++) {
        if (!reach[i][j]) {
          continue;
        }
        if (line[i] !== 1 && fits[i + 1][j]) {
          canEmpty[i] = true;
          reach[i + 1][j] = true;
        }
        if (j < k && bmdRunFits(clue[j], line, i) && fits[Math.min(i + clue[j] + 1, n)][j + 1]) {
          var end = i + clue[j];
          for (var x = i; x < end; x++) {
            canFill[x] = true;
          }
          if (end < n) {
            canEmpty[end] = true;
          }
          reach[Math.min(end + 1, n)][j + 1] = true;
        }
      }
    }
    return line.map(function (value, x) {
      if (canFill[x] !== canEmpty[x]) {
        return canFill[x] ? 1 : 0;
      }
      return value;
    });
  }

  // Line logic on the whole grid until nothing changes.  Returns { grid
  // (-1 / 0 / 1), solved } or null when the clues contradict each other.  A
  // grid it solves completely has exactly one solution.
  function bmdSolveGrid(rowClues, colClues) {
    var height = rowClues.length;
    var width = colClues.length;
    var grid = [];
    var row;
    var col;
    var line;
    for (row = 0; row < height; row++) {
      grid.push([]);
      for (col = 0; col < width; col++) {
        grid[row].push(-1);
      }
    }
    var changed = true;
    while (changed) {
      changed = false;
      for (row = 0; row < height; row++) {
        line = bmdSolveLine(rowClues[row], grid[row]);
        if (!line) {
          return null;
        }
        for (col = 0; col < width; col++) {
          if (line[col] !== grid[row][col]) {
            grid[row][col] = line[col];
            changed = true;
          }
        }
      }
      for (col = 0; col < width; col++) {
        line = bmdSolveLine(colClues[col], bmdColumn(grid, col));
        if (!line) {
          return null;
        }
        for (row = 0; row < height; row++) {
          if (line[row] !== grid[row][col]) {
            grid[row][col] = line[row];
            changed = true;
          }
        }
      }
    }
    var solved = grid.every(function (cells) {
      return cells.indexOf(-1) === -1;
    });
    return { grid: grid, solved: solved };
  }

  // Whether every row and column of cells (FILL counts as filled) has the
  // runs of its clue.
  function bmdIsSolved(cells, rowClues, colClues) {
    return cells.every(function (line, row) {
      return bmdSameList(bmdCluesOf(line), rowClues[row]);
    }) && colClues.every(function (clue, col) {
      return bmdSameList(bmdCluesOf(bmdColumn(cells, col)), clue);
    });
  }

  // ── Icons and generation (no DOM) ─────────────────────────────────────────

  function bmdHexDigits(size) {
    return Math.ceil(size / 4);
  }

  // A library hex string ('078 0cc ...', one number per row) as a grid of
  // 0 / 1, square: the number of rows is the size.  null when a row has the
  // wrong number of digits, a non-hex digit or more bits than the size.
  function bmdDecodeIcon(hex) {
    var rows = String(hex).trim().split(/\s+/);
    var size = rows.length;
    var digits = bmdHexDigits(size);
    var grid = [];
    for (var row = 0; row < size; row++) {
      if (rows[row].length !== digits || /[^0-9a-f]/i.test(rows[row])) {
        return null;
      }
      var value = parseInt(rows[row], 16);
      if (value >= Math.pow(2, size)) {
        return null;
      }
      var line = [];
      for (var col = size - 1; col >= 0; col--) {
        line.push(Math.floor(value / Math.pow(2, col)) % 2);
      }
      grid.push(line);
    }
    return grid;
  }

  // A grid row as upper-case hex, padded to the size's digit count.
  function bmdRowHex(line) {
    var value = parseInt(line.join(''), 2);
    var hex = value.toString(16).toUpperCase();
    while (hex.length < bmdHexDigits(line.length)) {
      hex = '0' + hex;
    }
    return hex;
  }

  // The icon's grid centred in a size x size grid (size >= the icon's).
  function bmdFitIcon(icon, size) {
    var art = bmdDecodeIcon(icon.hex);
    var offset = Math.floor((size - art.length) / 2);
    var grid = bmdGridOf(size, 0);
    art.forEach(function (line, row) {
      line.forEach(function (value, col) {
        grid[row + offset][col + offset] = value;
      });
    });
    return grid;
  }

  // Noise: about 55 % of the cells filled, then smoothed once (a cell with 5
  // or more filled cells in its 3x3 block fills, one with 3 or fewer empties;
  // cells outside the grid count as empty).  Never mirrored: a symmetric
  // board would leave only half of it to solve.
  function bmdNoiseGrid(size, rnd) {
    var grid = bmdGridOf(size, 0);
    var row;
    var col;
    for (row = 0; row < size; row++) {
      for (col = 0; col < size; col++) {
        grid[row][col] = rnd() < BMD_FILL_RATE ? 1 : 0;
      }
    }
    return grid.map(function (line, r) {
      return line.map(function (value, c) {
        var count = 0;
        for (var dr = -1; dr <= 1; dr++) {
          for (var dc = -1; dc <= 1; dc++) {
            count += r + dr >= 0 && r + dr < size && c + dc >= 0 && c + dc < size ? grid[r + dr][c + dc] : 0;
          }
        }
        if (count >= 5) {
          return 1;
        }
        return count <= 3 ? 0 : value;
      });
    });
  }

  // Whether a grid makes a fair puzzle: 30-75 % filled and solved by line
  // logic alone.
  function bmdIsFair(grid) {
    var size = grid.length;
    var filled = 0;
    grid.forEach(function (line) {
      filled += bmdCluesOf(line).reduce(function (sum, run) {
        return sum + run;
      }, 0);
    });
    var density = filled / (size * size);
    if (density < BMD_MIN_DENSITY || density > BMD_MAX_DENSITY) {
      return false;
    }
    return bmdSolveGrid(grid.map(bmdCluesOf), bmdColumns(grid).map(bmdCluesOf)).solved;
  }

  // An Endless solution: noise grids drawn from rnd until one is fair, at
  // most maxAttempts of them.  Returns { solution, attempts, icon }: icon is
  // null for noise; after maxAttempts misses it is the library icon the
  // solution falls back to (a random one centred on 10x10 and larger, the
  // mini heart on 5x5).
  function bmdGenerate(size, rnd, maxAttempts) {
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      var grid = bmdNoiseGrid(size, rnd);
      if (bmdIsFair(grid)) {
        return { solution: grid, attempts: attempt, icon: null };
      }
    }
    var icon = size === 5 ? BMD_MINI_ICON : BMD_ICONS[Math.floor(rnd() * BMD_ICONS.length)];
    return { solution: bmdFitIcon(icon, size), attempts: maxAttempts, icon: icon };
  }

  function bmdIconById(id) {
    for (var i = 0; i < BMD_ICONS.length; i++) {
      if (BMD_ICONS[i].id === id) {
        return BMD_ICONS[i];
      }
    }
    return null;
  }

  // ── Daily (no DOM) ────────────────────────────────────────────────────────

  // FNV-1a, 32 bits.
  function bmdFnv1a(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // mulberry32: a PRNG returning numbers in [0, 1).
  function bmdMulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The local calendar date of a Date as YYYY-MM-DD.
  function bmdDayKey(date) {
    return date.getFullYear() + '-' + bmdPad2(date.getMonth() + 1) + '-' + bmdPad2(date.getDate());
  }

  // The daily number of a Date's local calendar day: 2026-11-01 is #1.
  function bmdDayNumber(date) {
    return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - BMD_EPOCH) / BMD_DAY_MS + 1;
  }

  // The day key of a daily number (the inverse of bmdDayNumber).
  function bmdDayKeyOf(day) {
    var date = new Date(BMD_EPOCH + (day - 1) * BMD_DAY_MS);
    return date.getUTCFullYear() + '-' + bmdPad2(date.getUTCMonth() + 1) + '-' + bmdPad2(date.getUTCDate());
  }

  // The PRNG of a day: mulberry32 seeded with FNV-1a of 'bmd:' + day key.
  function bmdDayRandom(day) {
    return bmdMulberry32(bmdFnv1a('bmd:' + bmdDayKeyOf(day)));
  }

  // The library index of a day's icon, out of count (>= 2) icons.  From
  // Daily #1 on, the days run in cycles of count days that show every icon
  // once: each day draws one of the icons its cycle has not shown yet with
  // its own PRNG, and the first day of a cycle never repeats the day before.
  // Days before #1 or past BMD_LAST_CYCLED_DAY take a plain draw.
  function bmdDailyIconIndex(day, count) {
    if (day < 1 || day > BMD_LAST_CYCLED_DAY) {
      return Math.floor(bmdDayRandom(day)() * count);
    }
    var pool = [];
    var pick = -1;
    for (var d = 1; d <= day; d++) {
      if (!pool.length) {
        for (var i = 0; i < count; i++) {
          pool.push(i);
        }
      }
      var choices = pool.length > 1 ? bmdWithout(pool, pick) : pool;
      var next = choices[Math.floor(bmdDayRandom(d)() * choices.length)];
      pool.splice(pool.indexOf(next), 1);
      pick = next;
    }
    return pick;
  }

  function bmdWithout(list, value) {
    return list.filter(function (item) {
      return item !== value;
    });
  }

  // The streak shown on a day: the stored one while the last win is today or
  // yesterday, else 0.
  function bmdStreakAsOf(record, today) {
    return record.lastWon !== null && record.lastWon >= today - 1 ? record.streak : 0;
  }

  // Milliseconds as m:ss, or h:mm:ss from an hour on.
  function bmdFormatTime(ms) {
    var seconds = Math.floor(ms / 1000);
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor(seconds / 60) % 60;
    var rest = bmdPad2(seconds % 60);
    return hours ? hours + ':' + bmdPad2(minutes) + ':' + rest : minutes + ':' + rest;
  }

  // Milliseconds until the next local midnight (a DST day is 23 or 25 h).
  function bmdMsUntilMidnight(now) {
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  // The time left until the next local midnight as 'Xh Ym'.
  function bmdUntilMidnight(now) {
    var minutes = Math.ceil(bmdMsUntilMidnight(now) / 60000);
    return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
  }

  // The plain-text result line of a finished game, e.g.
  // 'Bitmap Decoder #5 10x10 1:42 Easy 1 mistake' (Relaxed counts its
  // mistakes too; a restarted Endless puzzle ends in 'practice').
  function bmdShareText(game) {
    var parts = [game.kind === 'daily' ? BMD_NAME + ' #' + game.day : BMD_NAME + ' Endless', game.size + 'x' + game.size];
    if (game.status === 'lost') {
      parts.push('failed');
    }
    parts.push(bmdFormatTime(game.elapsed));
    parts.push(bmdLabelRules(game.rules) + (bmdChecks(game.rules) ? ' ' + bmdPlural(game.mistakes, 'mistake') : ''));
    if (game.practice) {
      parts.push('practice');
    }
    return parts.join(' ');
  }

  // The rows as a hex dump: row number, hex value and bits.
  function bmdHexDump(solution) {
    var width = bmdHexDigits(solution.length);
    var head = 'ROW  HEX' + new Array(width + 2).join(' ') + 'BITS';
    return [head].concat(solution.map(function (line, row) {
      return bmdPad2(row) + '   0x' + bmdRowHex(line) + '  ' + line.join('');
    })).join('\n');
  }

  function bmdAsciiArt(solution) {
    return solution.map(function (line) {
      return line.map(function (value) {
        return value ? '#' : '.';
      }).join('');
    }).join('\n');
  }

  // ── Game rules (no DOM) ───────────────────────────────────────────────────

  // A fresh game: base is { kind, day?, id, name, rules, solution }.
  function bmdMakeGame(base) {
    var solution = base.solution;
    return {
      kind: base.kind,
      day: base.day,
      id: base.id,
      name: base.name,
      size: solution.length,
      rules: base.rules,
      solution: solution,
      rowClues: solution.map(bmdCluesOf),
      colClues: bmdColumns(solution).map(bmdCluesOf),
      cells: bmdGridOf(solution.length, BMD_EMPTY),
      mistakes: 0,
      elapsed: 0,
      status: 'playing',
      practice: false,
      flash: null
    };
  }

  // Whether a move was made: a cell is set or a mistake was counted (a
  // cleared Daily keeps its mistakes).
  function bmdHasMoves(game) {
    return game.mistakes > 0 || game.cells.some(function (line) {
      return line.some(function (cell) {
        return cell !== BMD_EMPTY;
      });
    });
  }

  function bmdDailyBase(day, icon, rules) {
    return { kind: 'daily', day: day, id: icon.id, name: icon.name, rules: rules, solution: bmdDecodeIcon(icon.hex) };
  }

  // What a drag or tap that starts on a cell in state start does with tool
  // (FILL or MARK): an empty cell paints the tool's state onto empty cells,
  // a filled or marked one clears the cells in that same state.
  function bmdPaintAction(start, tool) {
    if (start === BMD_EMPTY) {
      return { from: BMD_EMPTY, to: tool };
    }
    return { from: start, to: BMD_EMPTY };
  }

  // Whether rules check each move against the solution (Easy and Relaxed).
  function bmdChecks(rules) {
    return rules !== 'hard';
  }

  // The mistakes that end a game: the size's limit on Easy, 0 (none) on
  // Relaxed and Hard.
  function bmdMistakeLimit(game) {
    return game.rules === 'easy' ? BMD_MISTAKE_LIMITS[game.size] : 0;
  }

  // 'won', 'lost' or 'playing' from the cells and mistakes.
  function bmdStatusOf(game) {
    var limit = bmdMistakeLimit(game);
    if (limit && game.mistakes >= limit) {
      return 'lost';
    }
    return bmdIsSolved(game.cells, game.rowClues, game.colClues) ? 'won' : 'playing';
  }

  // Sets one cell.  Easy and Relaxed check a fill or a mark against the solution:
  // a wrong one counts a mistake and the cell shows the truth instead (a
  // wrong fill becomes a mark, a wrong mark a fill).  Returns 'same' (game
  // over or nothing to change), 'set', 'mistake', 'won' or 'lost'.
  function bmdApplyCell(game, row, col, to) {
    if (game.status !== 'playing' || game.cells[row][col] === to) {
      return 'same';
    }
    var result = 'set';
    if (bmdChecks(game.rules) && to !== BMD_EMPTY && (to === BMD_FILL) !== (game.solution[row][col] === 1)) {
      game.mistakes++;
      game.cells[row][col] = to === BMD_FILL ? BMD_MARK : BMD_FILL;
      result = 'mistake';
    } else {
      game.cells[row][col] = to;
    }
    game.status = bmdStatusOf(game);
    return game.status === 'playing' ? result : game.status;
  }

  // The cells from a to b on one row or column, a and b included.
  function bmdSegment(a, b) {
    var cells = [];
    var steps = Math.max(Math.abs(b.row - a.row), Math.abs(b.col - a.col));
    var dr = b.row > a.row ? 1 : b.row < a.row ? -1 : 0;
    var dc = b.col > a.col ? 1 : b.col < a.col ? -1 : 0;
    for (var i = 0; i <= steps; i++) {
      cells.push({ row: a.row + dr * i, col: a.col + dc * i });
    }
    return cells;
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function bmdParseJson(text) {
    try {
      var data = JSON.parse(text);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (error) {
      return null;
    }
  }

  // size rows of size '0' / '1' characters as a grid of numbers, or null.
  function bmdParseRows(raw, size) {
    if (!Array.isArray(raw) || raw.length !== size) {
      return null;
    }
    var grid = [];
    for (var row = 0; row < size; row++) {
      if (typeof raw[row] !== 'string' || raw[row].length !== size || /[^01]/.test(raw[row])) {
        return null;
      }
      grid.push(raw[row].split('').map(Number));
    }
    return grid;
  }

  function bmdRowsText(grid, state) {
    return grid.map(function (line) {
      return line.map(function (value) {
        return value === state ? '1' : '0';
      }).join('');
    });
  }

  // A game restored from a save object on top of base (see bmdMakeGame):
  // rules, fills, marks, mistakes and elapsed each fall back on their own;
  // a cell both filled and marked is filled.  The status follows from what
  // was restored.
  function bmdRestoreGame(raw, base) {
    var game = bmdMakeGame(base);
    var size = game.size;
    var fills = bmdParseRows(raw.fills, size) || bmdGridOf(size, 0);
    var marks = bmdParseRows(raw.marks, size) || bmdGridOf(size, 0);
    game.cells = fills.map(function (line, row) {
      return line.map(function (value, col) {
        return value ? BMD_FILL : marks[row][col] ? BMD_MARK : BMD_EMPTY;
      });
    });
    game.mistakes = bmdChecks(game.rules) ? bmdCount(raw.mistakes, bmdMistakeLimit(game) || undefined) : 0;
    game.elapsed = bmdCount(raw.elapsed);
    game.status = bmdStatusOf(game);
    return game;
  }

  function bmdRules(value) {
    return BMD_RULES.indexOf(value) !== -1 ? value : 'easy';
  }

  // The Endless game of a bmd-state save, or null when it has no playable
  // solution (an unknown size, rows of the wrong shape, or no filled cell).
  function bmdParseEndless(raw) {
    if (!raw || typeof raw !== 'object' || !bmdIsSize(raw.size)) {
      return null;
    }
    var solution = bmdParseRows(raw.solution, raw.size);
    if (!solution || bmdAsciiArt(solution).indexOf('#') === -1) {
      return null;
    }
    var game = bmdRestoreGame(raw, {
      kind: 'endless',
      id: bmdText(raw.id, 'endless'),
      name: bmdText(raw.name, 'Unnamed bitmap'),
      rules: bmdRules(raw.rules),
      solution: solution
    });
    game.practice = raw.practice === true;
    return game;
  }

  // bmd-state text as clean settings plus the Endless game (or null).
  function bmdParseState(text) {
    var data = bmdParseJson(text) || {};
    return {
      mode: data.mode === 'endless' ? 'endless' : 'daily',
      size: bmdIsSize(data.size) ? data.size : 10,
      rules: bmdRules(data.rules),
      tool: data.tool === 'mark' ? 'mark' : 'fill',
      endless: bmdParseEndless(data.endless)
    };
  }

  // bmd-daily text as { streak, lastWon, maxStreak, attempt }: attempt is
  // the saved day's game (its icon from the saved id, else from the day), or
  // null when the save has no whole day number.
  function bmdParseDaily(text) {
    var data = bmdParseJson(text) || {};
    var record = {
      streak: bmdCount(data.streak),
      lastWon: bmdIsInt(data.lastWon) ? data.lastWon : null,
      maxStreak: 0,
      attempt: null
    };
    record.maxStreak = Math.max(bmdCount(data.maxStreak), record.streak);
    if (bmdIsInt(data.day)) {
      var icon = bmdIconById(data.icon) || BMD_ICONS[bmdDailyIconIndex(data.day, BMD_ICONS.length)];
      record.attempt = bmdRestoreGame(data, bmdDailyBase(data.day, icon, bmdRules(data.rules)));
    }
    return record;
  }

  // bmd-best text as { 5, 10, ... 30 } of ms or null.
  function bmdParseBest(text) {
    var data = bmdParseJson(text) || {};
    var best = {};
    BMD_SIZES.forEach(function (size) {
      var value = data[size];
      best[size] = typeof value === 'number' && isFinite(value) && value >= 0 ? Math.floor(value) : null;
    });
    return best;
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  function bmdWarnStorage(error) {
    if (bmdRuntime.warned) {
      return;
    }
    bmdRuntime.warned = true;
    var warning = bmdRuntime.els.warning;
    warning.textContent = 'Storage is blocked or full (' + error.name + '): progress will not be saved after a reload.';
    warning.hidden = false;
  }

  function bmdStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      bmdWarnStorage(error);
      return null;
    }
  }

  function bmdStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      bmdWarnStorage(error);
    }
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  function bmdActive() {
    return bmdGames[bmdState.mode];
  }

  // A game's time in ms, the running stretch included.
  function bmdElapsedOf(game) {
    return game.elapsed + (bmdRuntime.clockGame === game ? performance.now() - bmdRuntime.clockStart : 0);
  }

  // Once a second while the clock runs: the time and the status (it names
  // the next Daily once midnight has passed).  The running time is saved
  // with every move and when the page is hidden or closed, not every
  // second, so another open tab of the game is not woken up each second.
  function bmdTick() {
    var game = bmdActive();
    bmdRenderStats(game);
    bmdRenderStatus(game);
  }

  // Runs the clock for the game on show while it is being played and the
  // page is visible (from the moment it is shown, so studying the clues
  // counts); stops it otherwise.
  function bmdClockSync() {
    var game = bmdActive();
    var run = game.status === 'playing' && !document.hidden;
    if (run && !bmdRuntime.clockGame) {
      bmdRuntime.clockGame = game;
      bmdRuntime.clockStart = performance.now();
      bmdRuntime.interval = setInterval(bmdTick, BMD_TICK_MS);
    } else if (!run) {
      bmdClockStop();
    }
  }

  // Stops the clock and adds the running stretch to its game.
  function bmdClockStop() {
    var game = bmdRuntime.clockGame;
    if (!game) {
      return;
    }
    game.elapsed = bmdElapsedOf(game);
    bmdRuntime.clockGame = null;
    clearInterval(bmdRuntime.interval);
    bmdRuntime.interval = null;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  function bmdSerializeGame(game) {
    return {
      id: game.id,
      name: game.name,
      size: game.size,
      rules: game.rules,
      solution: bmdRowsText(game.solution, 1),
      fills: bmdRowsText(game.cells, BMD_FILL),
      marks: bmdRowsText(game.cells, BMD_MARK),
      mistakes: game.mistakes,
      elapsed: Math.round(bmdElapsedOf(game)),
      status: game.status,
      practice: game.practice
    };
  }

  function bmdSaveState() {
    bmdStorageSet(BMD_STATE_KEY, JSON.stringify({
      v: 1,
      mode: bmdState.mode,
      size: bmdState.size,
      rules: bmdState.rules,
      tool: bmdState.tool,
      endless: bmdGames.endless ? bmdSerializeGame(bmdGames.endless) : null
    }));
  }

  // bmd-daily: the Daily attempt (once there is one this page load) and the
  // streak.
  function bmdSaveDaily() {
    var game = bmdGames.daily;
    if (!game) {
      return;
    }
    var saved = bmdSerializeGame(game);
    bmdStorageSet(BMD_DAILY_KEY, JSON.stringify({
      v: 1,
      day: game.day,
      icon: game.id,
      rules: saved.rules,
      fills: saved.fills,
      marks: saved.marks,
      mistakes: saved.mistakes,
      elapsed: saved.elapsed,
      status: saved.status,
      streak: bmdRecord.streak,
      lastWon: bmdRecord.lastWon,
      maxStreak: bmdRecord.maxStreak
    }));
  }

  function bmdSaveAll() {
    bmdSaveState();
    bmdSaveDaily();
  }

  // Reads the three saves.  endless is the Endless puzzle kept when
  // bmd-state holds none (null at start-up).  The size for New Game is the
  // size of that puzzle (a damaged save may name another one), but no larger
  // than the screen offers (10x10 instead of 15x15 on a phone).
  function bmdLoad(endless) {
    var saved = bmdParseState(bmdStorageGet(BMD_STATE_KEY));
    var game = saved.endless || endless;
    var size = game ? game.size : saved.size;
    bmdState.mode = saved.mode;
    bmdState.size = Math.min(size, bmdRuntime.maxSize);
    bmdState.rules = saved.rules;
    bmdState.tool = saved.tool;
    bmdGames.endless = game;
    bmdBest = bmdParseBest(bmdStorageGet(BMD_BEST_KEY));
    bmdRecord = bmdParseDaily(bmdStorageGet(BMD_DAILY_KEY));
  }

  // Takes the saves in storage over, so this tab never writes an older copy
  // back: the settings, the Endless puzzle (unless the save has none), the
  // best times and the Daily record, with the attempt when it is of this
  // tab's day or a later one.  A save of an older day (another tab left
  // open across midnight) leaves this tab's attempt and streak alone.  The
  // tab on show stays.
  function bmdTakeOver() {
    var mode = bmdState.mode;
    var daily = bmdGames.daily;
    var record = bmdRecord;
    bmdClockStop();
    bmdRuntime.stroke = null;
    bmdLoad(bmdGames.endless);
    bmdState.mode = mode;
    if (daily && !(bmdRecord.attempt && bmdRecord.attempt.day >= daily.day)) {
      bmdRecord = record;
    } else if (daily) {
      bmdGames.daily = bmdRecord.attempt;
    }
    bmdRender();
    bmdClockSync();
  }

  // Another tab of the game wrote a save (key null: it cleared the storage).
  function bmdHandleStorage(event) {
    if (event.key === null || [BMD_STATE_KEY, BMD_BEST_KEY, BMD_DAILY_KEY].indexOf(event.key) !== -1) {
      bmdTakeOver();
    }
  }

  // A page shown again (a tab switched back to, a page restored from the
  // back/forward cache, a frozen tab woken up) got no storage event for what
  // other tabs or loads of the game saved meanwhile.  So it reads the saves
  // back before anything is written (its own copy would undo a newer save,
  // such as a Daily won elsewhere), shows them (the status and the streak
  // may have passed midnight) and restarts the clock.  While this tab's own
  // writes fail (bmdWarnStorage), storage may be older than this tab, so it
  // is not read back.
  function bmdResume() {
    bmdScheduleMidnight();
    if (bmdRuntime.warned) {
      bmdRender();
      bmdClockSync();
    } else {
      bmdTakeOver();
    }
  }

  // At local midnight the page shows the new day: the status names the next
  // Daily and the streak counts as of today, also for a finished game whose
  // clock has stopped.  One timeout per page, set again each midnight.
  function bmdScheduleMidnight() {
    clearTimeout(bmdRuntime.midnightTimeout);
    bmdRuntime.midnightTimeout = setTimeout(bmdAtMidnight, bmdMsUntilMidnight(new Date()) + BMD_MIDNIGHT_SLACK_MS);
  }

  function bmdAtMidnight() {
    bmdRender();
    bmdScheduleMidnight();
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  function bmdToday() {
    return bmdDayNumber(new Date());
  }

  function bmdNewDaily(day) {
    var icon = BMD_ICONS[bmdDailyIconIndex(day, BMD_ICONS.length)];
    return bmdMakeGame(bmdDailyBase(day, icon, bmdState.rules));
  }

  function bmdNewEndless(size) {
    var seed = Math.floor(Math.random() * 4294967296);
    var made = bmdGenerate(size, bmdMulberry32(seed), bmdTuning.attempts);
    var tag = (seed + 4294967296).toString(16).slice(1).toUpperCase();
    return bmdMakeGame({
      kind: 'endless',
      id: 'e' + size + '-' + tag.toLowerCase(),
      name: made.icon ? made.icon.name : 'Bitmap ' + tag,
      rules: bmdState.rules,
      solution: made.solution
    });
  }

  // Makes sure the mode's game exists: the Daily attempt saved for today
  // (or a new one, written at once), the saved or a new Endless puzzle.
  function bmdEnsureGame(mode) {
    if (bmdGames[mode]) {
      return;
    }
    if (mode === 'daily') {
      var today = bmdToday();
      var attempt = bmdRecord.attempt;
      bmdGames.daily = attempt && attempt.day === today ? attempt : bmdNewDaily(today);
    } else {
      bmdGames.endless = bmdNewEndless(bmdState.size);
    }
  }

  // Shows a mode's game, pausing the other one's clock.
  function bmdShowMode(mode) {
    bmdClockStop();
    bmdState.mode = mode;
    bmdRuntime.stroke = null;
    bmdEnsureGame(mode);
    bmdRender();
    bmdClockSync();
    bmdSaveAll();
  }

  // A new puzzle replaced the one on show.
  function bmdStartPuzzle() {
    bmdClockStop();
    bmdRuntime.stroke = null;
    bmdHideToast();
    bmdRender();
    bmdClockSync();
    bmdSaveAll();
  }

  // New Game makes a new Endless puzzle; New Daily starts today's Daily
  // once the attempt on show is from an earlier day.
  function bmdHandleNewGame() {
    if (bmdState.mode === 'endless') {
      bmdGames.endless = bmdNewEndless(bmdState.size);
      bmdStartPuzzle();
      return;
    }
    var today = bmdToday();
    var game = bmdGames.daily;
    if (game.day >= today) {
      bmdShowToast('Daily #' + game.day + (game.status === 'playing' ? ' is in progress' : ' is finished') +
        ': Daily #' + (game.day + 1) + ' unlocks in ' + bmdUntilMidnight(new Date()) + '.');
      return;
    }
    bmdGames.daily = bmdNewDaily(today);
    bmdStartPuzzle();
  }

  // Clears the board.  Endless starts the puzzle over (clock and mistakes
  // too) as practice: its clues have been on show while the clock ran, so a
  // fresh clock would not be a fair time, and it sets no best time.  The
  // Daily attempt keeps its clock and mistakes, because it is scored
  // (Restart is disabled once it is over).
  function bmdHandleRestart() {
    var game = bmdActive();
    bmdClockStop();
    bmdRuntime.stroke = null;
    game.cells = bmdGridOf(game.size, BMD_EMPTY);
    game.flash = null;
    if (game.kind === 'endless') {
      game.practice = true;
      game.mistakes = 0;
      game.elapsed = 0;
      game.status = 'playing';
      bmdShowToast('Board cleared for practice: the clock starts over, and a restarted puzzle sets no best time.');
    } else {
      bmdShowToast('Board cleared: Daily #' + game.day + ' keeps its clock (' + bmdFormatTime(game.elapsed) +
        ')' + (bmdChecks(game.rules) ? ' and mistakes (' + bmdMistakeCount(game) + ')' : '') + '.');
    }
    bmdRender();
    bmdClockSync();
    bmdSaveAll();
  }

  function bmdHandleSizeChange() {
    bmdState.size = parseInt(bmdRuntime.els.size.value, 10);
    bmdGames.endless = bmdNewEndless(bmdState.size);
    bmdStartPuzzle();
  }

  // The rules for the next puzzle.  The puzzle on show takes them at once
  // while it has no move yet (a fresh Daily attempt too); one already played
  // keeps its rules, so a scored attempt never changes them halfway.  The
  // one exception lifts the limit: an Endless puzzle being played turns
  // Relaxed at once (keeping its mistakes), since Relaxed sets no best time.
  function bmdHandleRulesChange() {
    bmdState.rules = bmdRules(bmdRuntime.els.rules.value);
    var game = bmdActive();
    var label = bmdLabelRules(bmdState.rules);
    if (game.rules === bmdState.rules) {
      bmdSaveState();
    } else if (!bmdHasMoves(game)) {
      game.rules = bmdState.rules;
      bmdShowToast(label + ' rules apply to this puzzle now: it has no moves yet.');
      bmdRender();
      bmdSaveAll();
    } else if (game.kind === 'endless' && game.status === 'playing' && bmdState.rules === 'relaxed') {
      game.rules = 'relaxed';
      bmdShowToast('No mistake limit on this puzzle now: it goes on with ' + bmdPlural(game.mistakes, 'mistake') +
        ' and sets no best time.');
      bmdRender();
      bmdSaveAll();
    } else {
      bmdShowToast(label + ' rules apply from the next puzzle; this one stays ' + bmdLabelRules(game.rules) + ' (it has moves).');
      bmdSaveState();
    }
  }

  function bmdSetTool(tool) {
    bmdState.tool = tool;
    bmdRenderControls(bmdActive());
    bmdSaveState();
  }

  // The end of a game: the clock stops, a win may set a best time, and the
  // Daily attempt moves the streak.
  function bmdFinish(game) {
    bmdClockStop();
    var daily = game.kind === 'daily';
    if (game.status === 'lost') {
      if (daily) {
        bmdRecord.streak = 0;
      }
      bmdShowToast('Decode failed: ' + bmdMistakeCount(game) + ' mistakes. It was ' + game.name + '.');
      return;
    }
    var best = bmdBest[game.size];
    var relaxed = game.rules === 'relaxed';
    var record = !game.practice && !relaxed && (best === null || game.elapsed < best);
    var size = game.size + 'x' + game.size;
    var note = '.';
    if (record) {
      bmdBest[game.size] = Math.floor(game.elapsed);
      bmdStorageSet(BMD_BEST_KEY, JSON.stringify(bmdBest));
      note = ': a new best for ' + size + '!';
    } else if (game.practice) {
      note = ' (practice: no best time).';
    } else if (relaxed) {
      note = ' (no mistake limit: no best time).';
    }
    if (daily) {
      bmdRecord.streak = (bmdRecord.lastWon === game.day - 1 ? bmdRecord.streak : 0) + 1;
      bmdRecord.lastWon = game.day;
      bmdRecord.maxStreak = Math.max(bmdRecord.maxStreak, bmdRecord.streak);
    }
    bmdShowToast('Decoded ' + game.name + ' in ' + bmdFormatTime(game.elapsed) + note);
  }

  // What follows a changed cell: a mistake flashes the cell, ends the drag
  // and says which cell was wrong; a win or loss ends the game.
  function bmdAfterChange(game, result, at) {
    game.flash = result === 'mistake' || result === 'lost' ? at.row + ',' + at.col : null;
    if (result === 'mistake') {
      bmdRuntime.stroke = null;
      bmdShowToast('Mistake ' + bmdMistakeCount(game) + ': row ' + (at.row + 1) + ', column ' +
        (at.col + 1) + (game.cells[at.row][at.col] === BMD_MARK ? ' is not' : ' is') + ' part of the bitmap.');
    } else if (result === 'won' || result === 'lost') {
      bmdRuntime.stroke = null;
      bmdFinish(game);
    }
  }

  function bmdCommit() {
    bmdRender();
    bmdClockSync();
    bmdSaveAll();
  }

  // A tap or key on one cell with a tool.
  function bmdApplyAt(game, at, tool) {
    var action = bmdPaintAction(game.cells[at.row][at.col], tool);
    bmdAfterChange(game, bmdApplyCell(game, at.row, at.col, action.to), at);
    bmdCommit();
  }

  // Extends the drag to the cell at: the drag keeps to the row or column it
  // first moved along, and paints every cell from its start to at's
  // projection on that line.
  function bmdStrokeTo(at) {
    var stroke = bmdRuntime.stroke;
    var game = bmdActive();
    if (stroke.axis === null && (at.row !== stroke.row || at.col !== stroke.col)) {
      stroke.axis = Math.abs(at.row - stroke.row) > Math.abs(at.col - stroke.col) ? 'col' : 'row';
    }
    var vertical = stroke.axis === 'col';
    var end = { row: vertical ? at.row : stroke.row, col: vertical ? stroke.col : at.col };
    var cells = bmdSegment(stroke, end);
    var changed = false;
    for (var i = 0; i < cells.length && bmdRuntime.stroke; i++) {
      var cell = cells[i];
      if (game.cells[cell.row][cell.col] === stroke.action.from) {
        changed = true;
        bmdAfterChange(game, bmdApplyCell(game, cell.row, cell.col, stroke.action.to), cell);
      }
    }
    bmdRuntime.cursor = end;
    if (changed) {
      bmdCommit();
    } else {
      bmdRenderBoard(game);
    }
  }

  function bmdHandleShare() {
    var game = bmdActive();
    if (game.status === 'playing') {
      return;
    }
    var text = bmdShareText(game);
    var field = bmdRuntime.els.shareField;
    var promise;

    function copied() {
      field.hidden = true;
      bmdShowToast('Copied: ' + text);
    }

    function fallback() {
      field.value = text;
      field.hidden = false;
      field.focus();
      field.select();
      bmdShowToast('Clipboard unavailable: copy the selected result below.');
    }

    try {
      promise = navigator.clipboard.writeText(text);
    } catch (error) {
      fallback();
      return;
    }
    promise.then(copied, fallback);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function bmdLabelRules(rules) {
    return BMD_RULE_LABELS[rules];
  }

  // The mistakes so far, out of the limit when there is one: '2/5' or '2'.
  function bmdMistakeCount(game) {
    var limit = bmdMistakeLimit(game);
    return game.mistakes + (limit ? '/' + limit : '');
  }

  function bmdClueSpans(box, clue) {
    var numbers = clue.length ? clue : [0];
    numbers.forEach(function (number) {
      var span = document.createElement('span');
      span.className = 'bmd-num';
      span.textContent = String(number);
      box.appendChild(span);
    });
  }

  // Builds the clue boxes and cells of a game (once per game).
  function bmdBuildBoard(game) {
    var els = bmdRuntime.els;
    var size = game.size;
    bmdRuntime.builtFor = game;
    bmdRuntime.cellEls = [];
    bmdRuntime.rowClueEls = [];
    bmdRuntime.colClueEls = [];
    bmdRuntime.cursor = {
      row: Math.min(bmdRuntime.cursor.row, size - 1),
      col: Math.min(bmdRuntime.cursor.col, size - 1)
    };
    els.board.className = 'bmd-board bmd-board--s' + size;
    els.colClues.innerHTML = '';
    els.rowClues.innerHTML = '';
    els.grid.innerHTML = '';
    els.grid.style.gridTemplateColumns = 'repeat(' + size + ', var(--bmd-cell))';
    els.grid.setAttribute('aria-label', 'Bitmap grid, ' + size + ' by ' + size + ': arrows move, Space fills, X marks');
    game.colClues.forEach(function (clue, col) {
      var box = document.createElement('div');
      box.setAttribute('aria-label', 'Column ' + (col + 1) + ' RLE ' + (clue.join(' ') || '0'));
      bmdClueSpans(box, clue);
      els.colClues.appendChild(box);
      bmdRuntime.colClueEls.push(box);
    });
    game.rowClues.forEach(function (clue, row) {
      var box = document.createElement('div');
      box.setAttribute('aria-label', 'Row ' + (row + 1) + ' RLE ' + (clue.join(' ') || '0'));
      bmdClueSpans(box, clue);
      els.rowClues.appendChild(box);
      bmdRuntime.rowClueEls.push(box);
      var line = document.createElement('div');
      line.className = 'bmd-row';
      line.setAttribute('role', 'row');
      var cells = [];
      for (var col = 0; col < size; col++) {
        var cell = document.createElement('div');
        cell.id = 'bmd-cell-' + row + '-' + col;
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('data-row', row);
        cell.setAttribute('data-col', col);
        line.appendChild(cell);
        cells.push(cell);
      }
      els.grid.appendChild(line);
      bmdRuntime.cellEls.push(cells);
    });
  }

  function bmdRenderCells(game) {
    var size = game.size;
    var cursor = bmdRuntime.cursor;
    bmdRuntime.els.grid.className = 'bmd-grid' + (game.status === 'playing' ? '' : ' bmd-grid--' + game.status);
    bmdRuntime.els.grid.setAttribute('aria-activedescendant', 'bmd-cell-' + cursor.row + '-' + cursor.col);
    bmdRuntime.cellEls.forEach(function (cells, row) {
      cells.forEach(function (cell, col) {
        var state = game.cells[row][col];
        var hidden = game.status === 'lost' && game.solution[row][col] === 1 && state !== BMD_FILL;
        cell.className = 'bmd-cell' + BMD_CELL_CLASS[state] +
          (col % 5 === 4 && col < size - 1 ? ' bmd-cell--edge-r' : '') +
          (row % 5 === 4 && row < size - 1 ? ' bmd-cell--edge-b' : '') +
          (hidden ? ' bmd-cell--reveal' : '') +
          (game.flash === row + ',' + col ? ' bmd-cell--error' : '') +
          (row === cursor.row && col === cursor.col ? ' bmd-cell--cursor' : '');
        cell.setAttribute('aria-label', 'Row ' + (row + 1) + ', column ' + (col + 1) + ': ' + BMD_CELL_WORD[state]);
      });
    });
  }

  function bmdLineDone(line, clue) {
    return bmdSameList(bmdCluesOf(line), clue);
  }

  // Strikes through the clues of the lines that match, and lights up the
  // cursor's row and column.
  function bmdRenderClues(game) {
    var cursor = bmdRuntime.cursor;
    bmdRuntime.rowClueEls.forEach(function (box, row) {
      var ok = bmdLineDone(game.cells[row], game.rowClues[row]);
      box.className = 'bmd-clue bmd-clue--row' + (ok ? ' bmd-clue--done' : '') + (row === cursor.row ? ' bmd-clue--active' : '');
    });
    bmdRuntime.colClueEls.forEach(function (box, col) {
      var ok = bmdLineDone(bmdColumn(game.cells, col), game.colClues[col]);
      box.className = 'bmd-clue bmd-clue--col' + (ok ? ' bmd-clue--done' : '') + (col === cursor.col ? ' bmd-clue--active' : '');
    });
  }

  // How many rows and columns match their clues.
  function bmdLinesDone(game) {
    var done = { rows: 0, cols: 0 };
    game.rowClues.forEach(function (clue, row) {
      done.rows += bmdLineDone(game.cells[row], clue) ? 1 : 0;
    });
    game.colClues.forEach(function (clue, col) {
      done.cols += bmdLineDone(bmdColumn(game.cells, col), clue) ? 1 : 0;
    });
    return done;
  }

  function bmdRenderBoard(game) {
    bmdRenderCells(game);
    bmdRenderClues(game);
  }

  function bmdRenderStats(game) {
    var els = bmdRuntime.els;
    var best = bmdBest[game.size];
    els.time.textContent = bmdFormatTime(bmdElapsedOf(game));
    els.mistakes.textContent = bmdChecks(game.rules) ? bmdMistakeCount(game) : 'off';
    els.best.textContent = best === null ? '--' : bmdFormatTime(best);
    els.streak.textContent = String(bmdStreakAsOf(bmdRecord, bmdToday())) + ' (max ' + bmdRecord.maxStreak + ')';
  }

  function bmdRenderControls(game) {
    var els = bmdRuntime.els;
    var daily = bmdState.mode === 'daily';
    els.tabDaily.setAttribute('aria-pressed', String(daily));
    els.tabEndless.setAttribute('aria-pressed', String(!daily));
    // The size on show (a phone may still finish a saved 15x15 puzzle; a
    // disabled option can be the selected one), so choosing 10x10 then is a
    // change and starts a 10x10 board.
    els.size.value = String(daily ? BMD_DAILY_SIZE : game.size);
    els.size.disabled = daily;
    BMD_SCREEN_LIMITS.forEach(function (limit) {
      els.sizeOptions[limit.size].disabled = limit.size > bmdRuntime.maxSize;
    });
    els.rules.value = bmdState.rules;
    // Easy's limit for the board on show (the next Endless one has its size).
    els.rulesEasy.textContent = 'Easy: ' + BMD_MISTAKE_LIMITS[game.size] + ' mistakes';
    els.toolFill.setAttribute('aria-pressed', String(bmdState.tool === 'fill'));
    els.toolMark.setAttribute('aria-pressed', String(bmdState.tool === 'mark'));
    els.newGame.textContent = daily ? 'New Daily' : 'New Game';
    els.restart.disabled = daily && game.status !== 'playing';
  }

  function bmdRenderStatus(game) {
    var els = bmdRuntime.els;
    var size = game.size;
    var rules = bmdLabelRules(game.rules);
    var title = game.kind === 'daily' ? 'Daily #' + game.day : 'Endless';
    var playing = game.status === 'playing';
    var subject = game.kind === 'daily' ? 'icon hidden until decoded' : 'puzzle ' + game.id;
    els.puzzle.textContent = title + ' · ' + size + 'x' + size + ' · ' + rules + ' · ' + (playing ? subject : game.name) +
      (game.practice ? ' · practice' : '');
    var text;
    if (playing) {
      var done = bmdLinesDone(game);
      text = 'Decoding: ' + done.rows + '/' + size + ' rows and ' + done.cols + '/' + size + ' columns match their RLE.';
    } else if (game.status === 'won') {
      text = 'Decoded ' + game.name + ' in ' + bmdFormatTime(game.elapsed) +
        (bmdChecks(game.rules) ? ' with ' + bmdPlural(game.mistakes, 'mistake') : '') + '.';
    } else {
      text = 'Decode failed after ' + game.mistakes + ' mistakes. The bitmap was ' + game.name + '.';
    }
    var today = bmdToday();
    if (game.kind === 'daily' && game.day < today) {
      text += ' Daily #' + today + ' is ready: press New Daily.';
    }
    // Set only when it changes: the clock re-renders it every second, and
    // a screen reader would read the same status again.
    if (els.status.textContent !== text) {
      els.status.textContent = text;
    }
  }

  function bmdRenderDecode(game) {
    var els = bmdRuntime.els;
    var over = game.status !== 'playing';
    els.decode.hidden = !over;
    if (!over) {
      els.shareField.hidden = true;
      return;
    }
    var won = game.status === 'won';
    els.decode.className = won ? 'bmd-decode' : 'bmd-decode bmd-decode--lost';
    els.decodeLabel.textContent = won ? 'Decoded:' : 'Decode failed. It was:';
    els.decodeName.textContent = game.name;
    els.stream.textContent = 'stream ' + game.solution.map(bmdRowHex).join(' ');
    els.hex.textContent = bmdHexDump(game.solution);
    els.ascii.textContent = bmdAsciiArt(game.solution);
  }

  function bmdRender() {
    var game = bmdActive();
    if (bmdRuntime.builtFor !== game) {
      bmdBuildBoard(game);
    }
    bmdRenderBoard(game);
    bmdRenderStats(game);
    bmdRenderControls(game);
    bmdRenderStatus(game);
    bmdRenderDecode(game);
  }

  function bmdShowToast(message) {
    var toast = bmdRuntime.els.toast;
    clearTimeout(bmdRuntime.toastTimeout);
    toast.textContent = message;
    toast.classList.add('bmd-toast--show');
    bmdRuntime.toastTimeout = setTimeout(bmdHideToast, BMD_TOAST_MS);
  }

  function bmdHideToast() {
    clearTimeout(bmdRuntime.toastTimeout);
    bmdRuntime.toastTimeout = null;
    bmdRuntime.els.toast.classList.remove('bmd-toast--show');
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // An index moved into 0 .. size - 1 (NaN, from a grid with no size, is 0).
  function bmdClampIndex(value, size) {
    return value > 0 ? Math.min(value, size - 1) : 0;
  }

  // The cell under a viewport point.  Outside the cells (on the grid's
  // border, or while the grid has no size, as before layout) it is null, or
  // with clamp the nearest cell, so a drag that overshoots the edge paints
  // up to the edge.
  function bmdCellFromPoint(x, y, clamp) {
    var size = bmdActive().size;
    var grid = bmdRuntime.els.grid;
    var rect = grid.getBoundingClientRect();
    var left = grid.clientLeft || 0;
    var top = grid.clientTop || 0;
    var col = Math.floor((x - rect.left - left) / (rect.width - 2 * left) * size);
    var row = Math.floor((y - rect.top - top) / (rect.height - 2 * top) * size);
    if (clamp) {
      return { row: bmdClampIndex(row, size), col: bmdClampIndex(col, size) };
    }
    return col >= 0 && col < size && row >= 0 && row < size ? { row: row, col: col } : null;
  }

  // A press on the grid starts a drag: the left button (a finger, a pen)
  // uses the Fill / Mark tool, the right button always marks.
  function bmdPointerDown(event) {
    var game = bmdActive();
    var at = bmdCellFromPoint(event.clientX, event.clientY);
    if ((event.button !== 0 && event.button !== 2) || game.status !== 'playing' || !at) {
      return;
    }
    var grid = bmdRuntime.els.grid;
    var tool = event.button === 2 || bmdState.tool === 'mark' ? BMD_MARK : BMD_FILL;
    bmdRuntime.stroke = {
      id: event.pointerId,
      row: at.row,
      col: at.col,
      axis: null,
      last: at,
      action: bmdPaintAction(game.cells[at.row][at.col], tool)
    };
    if (typeof grid.setPointerCapture === 'function') {
      try {
        grid.setPointerCapture(event.pointerId);
      } catch (error) {
        // An unknown pointer id: the drag still works while the pointer stays on the grid.
      }
    }
    bmdStrokeTo(at);
  }

  function bmdPointerMove(event) {
    var stroke = bmdRuntime.stroke;
    if (!stroke || event.pointerId !== stroke.id) {
      return;
    }
    // Many moves land on the cell of the last one: only a new cell paints.
    var at = bmdCellFromPoint(event.clientX, event.clientY, true);
    if (at.row !== stroke.last.row || at.col !== stroke.last.col) {
      stroke.last = at;
      bmdStrokeTo(at);
    }
  }

  function bmdPointerEnd(event) {
    var stroke = bmdRuntime.stroke;
    if (stroke && event.pointerId === stroke.id) {
      bmdRuntime.stroke = null;
    }
  }

  // FILL for Space and Enter, MARK for X (any case or layout), else null.
  function bmdKeyTool(event) {
    if (event.key === ' ' || event.key === 'Enter') {
      return BMD_FILL;
    }
    return event.key === 'x' || event.key === 'X' || event.code === 'KeyX' ? BMD_MARK : null;
  }

  // Keys on the focused grid (the only place the game takes keys): arrows
  // move the cursor, Space / Enter fill, X marks.  Shortcuts with Ctrl, Alt
  // or Cmd and keys while composing text stay with the browser.
  function bmdHandleKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
      return;
    }
    var game = bmdActive();
    var cursor = bmdRuntime.cursor;
    if (bmdHasOwn(BMD_MOVES, event.key)) {
      var move = BMD_MOVES[event.key];
      event.preventDefault();
      bmdRuntime.cursor = {
        row: Math.max(0, Math.min(game.size - 1, cursor.row + move[0])),
        col: Math.max(0, Math.min(game.size - 1, cursor.col + move[1]))
      };
      bmdRenderBoard(game);
      return;
    }
    var tool = bmdKeyTool(event);
    if (tool === null) {
      return;
    }
    event.preventDefault();
    if (!event.repeat && game.status === 'playing') {
      bmdApplyAt(game, cursor, tool);
    }
  }

  // Hidden: the clock stops and both saves are written.  Shown again: the
  // saves are read back first (see bmdResume).
  function bmdHandleVisibility() {
    if (document.hidden) {
      bmdClockSync();
      bmdSaveAll();
    } else {
      bmdResume();
    }
  }

  // persisted: the page comes back from the back/forward cache (a first
  // load has just read the saves).
  function bmdHandlePageShow(event) {
    if (event.persisted) {
      bmdResume();
    }
  }

  function bmdMatches(query) {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  }

  // The largest Endless size the screen offers: the size before the first
  // one whose screen is too narrow, else the largest.
  function bmdScreenMaxSize() {
    for (var i = 0; i < BMD_SCREEN_LIMITS.length; i++) {
      if (bmdMatches(BMD_SCREEN_LIMITS[i].query)) {
        return BMD_SIZES[BMD_SIZES.indexOf(BMD_SCREEN_LIMITS[i].size) - 1];
      }
    }
    return BMD_SIZES[BMD_SIZES.length - 1];
  }

  function bmdBindEvents() {
    var els = bmdRuntime.els;
    els.tabDaily.addEventListener('click', function () {
      bmdShowMode('daily');
    });
    els.tabEndless.addEventListener('click', function () {
      bmdShowMode('endless');
    });
    els.size.addEventListener('change', bmdHandleSizeChange);
    els.rules.addEventListener('change', bmdHandleRulesChange);
    els.newGame.addEventListener('click', bmdHandleNewGame);
    els.restart.addEventListener('click', bmdHandleRestart);
    els.toolFill.addEventListener('click', function () {
      bmdSetTool('fill');
    });
    els.toolMark.addEventListener('click', function () {
      bmdSetTool('mark');
    });
    els.share.addEventListener('click', bmdHandleShare);
    els.grid.addEventListener('pointerdown', bmdPointerDown);
    els.grid.addEventListener('pointermove', bmdPointerMove);
    els.grid.addEventListener('pointerup', bmdPointerEnd);
    els.grid.addEventListener('pointercancel', bmdPointerEnd);
    els.grid.addEventListener('contextmenu', function (event) {
      event.preventDefault();
    });
    els.grid.addEventListener('keydown', bmdHandleKeydown);
    document.addEventListener('visibilitychange', bmdHandleVisibility);
    window.addEventListener('pagehide', bmdSaveAll);
    window.addEventListener('pageshow', bmdHandlePageShow);
    window.addEventListener('storage', bmdHandleStorage);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function bmdFindElements() {
    var ids = {
      tabDaily: 'bmd-tab-daily',
      tabEndless: 'bmd-tab-endless',
      size: 'bmd-size',
      rules: 'bmd-rules',
      rulesEasy: 'bmd-rules-easy',
      newGame: 'bmd-new-game',
      restart: 'bmd-restart',
      toolFill: 'bmd-tool-fill',
      toolMark: 'bmd-tool-mark',
      time: 'bmd-time',
      mistakes: 'bmd-mistakes',
      best: 'bmd-best-time',
      streak: 'bmd-streak',
      puzzle: 'bmd-puzzle',
      board: 'bmd-board',
      colClues: 'bmd-col-clues',
      rowClues: 'bmd-row-clues',
      grid: 'bmd-grid',
      status: 'bmd-status',
      warning: 'bmd-warning',
      decode: 'bmd-decode',
      decodeLabel: 'bmd-decode-label',
      decodeName: 'bmd-decode-name',
      stream: 'bmd-stream',
      hex: 'bmd-hex',
      ascii: 'bmd-ascii',
      share: 'bmd-share',
      shareField: 'bmd-share-field',
      toast: 'bmd-toast'
    };
    var els = {};
    Object.keys(ids).forEach(function (name) {
      els[name] = document.getElementById(ids[name]);
    });
    // The options of the big sizes by size (bmd-size-15 ... bmd-size-30).
    els.sizeOptions = {};
    BMD_SCREEN_LIMITS.forEach(function (limit) {
      els.sizeOptions[limit.size] = document.getElementById('bmd-size-' + limit.size);
    });
    return els;
  }

  // Runs once: finds the elements, restores the saves, binds the controls
  // and shows the saved tab (Daily on a first visit).
  function bmdInit() {
    if (bmdRuntime.els) {
      return;
    }
    bmdRuntime.els = bmdFindElements();
    bmdRuntime.maxSize = bmdScreenMaxSize();
    BMD_SCREEN_LIMITS.forEach(function (limit) {
      if (limit.size > bmdRuntime.maxSize) {
        bmdRuntime.els.sizeOptions[limit.size].textContent = limit.size + 'x' + limit.size + ' (' + limit.note + ')';
      }
    });
    bmdLoad(null);
    bmdBindEvents();
    bmdShowMode(bmdState.mode);
    bmdScheduleMidnight();
  }

  // Node (tests): export only, no init and no timers.  Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      bmdState: bmdState,
      bmdGames: bmdGames,
      bmdTuning: bmdTuning,
      bmdIcons: BMD_ICONS,
      bmdMiniIcon: BMD_MINI_ICON,
      bmdScreenLimits: BMD_SCREEN_LIMITS,
      bmdMistakeLimits: BMD_MISTAKE_LIMITS,
      bmdInit: bmdInit,
      bmdCluesOf: bmdCluesOf,
      bmdSolveLine: bmdSolveLine,
      bmdSolveGrid: bmdSolveGrid,
      bmdIsSolved: bmdIsSolved,
      bmdDecodeIcon: bmdDecodeIcon,
      bmdRowHex: bmdRowHex,
      bmdFitIcon: bmdFitIcon,
      bmdNoiseGrid: bmdNoiseGrid,
      bmdIsFair: bmdIsFair,
      bmdGenerate: bmdGenerate,
      bmdFnv1a: bmdFnv1a,
      bmdMulberry32: bmdMulberry32,
      bmdDayKey: bmdDayKey,
      bmdDayNumber: bmdDayNumber,
      bmdDayKeyOf: bmdDayKeyOf,
      bmdDailyIconIndex: bmdDailyIconIndex,
      bmdStreakAsOf: bmdStreakAsOf,
      bmdFormatTime: bmdFormatTime,
      bmdUntilMidnight: bmdUntilMidnight,
      bmdMsUntilMidnight: bmdMsUntilMidnight,
      bmdShareText: bmdShareText,
      bmdHexDump: bmdHexDump,
      bmdAsciiArt: bmdAsciiArt,
      bmdMakeGame: bmdMakeGame,
      bmdHasMoves: bmdHasMoves,
      bmdPaintAction: bmdPaintAction,
      bmdApplyCell: bmdApplyCell,
      bmdSegment: bmdSegment,
      bmdParseState: bmdParseState,
      bmdParseDaily: bmdParseDaily,
      bmdParseBest: bmdParseBest,
      bmdSerializeGame: bmdSerializeGame
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bmdInit);
  } else {
    bmdInit();
  }
})();
