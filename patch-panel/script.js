// Patch Panel — script.js
// Prefix: ppn-
// Dependencies: none.
//
// A rack of N x N patch-panel tiles (5x5, 7x7 or 9x9, optionally wrapped
// round like a torus).  Every tile holds a piece of cable (a straight, a
// corner, a tee) or an end device (server, NAS, access point); the core
// switch sits in the middle.  A tap turns a tile a quarter turn clockwise.
// The network is up when every link is answered by the neighbouring tile,
// every tile is reached from the switch and no loop (a broadcast storm) is
// left.  Any such connection wins, so the game needs no solver.  Tiles the
// switch reaches light up green while you play, and packets run out from
// the switch along them: in along each tile's uplink, out along its other
// cables.
//
// Boards: ppnGenerate grows a random spanning tree from the centre (Prim's
// algorithm on the grid, at most three links per tile), then turns every
// tile 0-3 quarter turns.  The target is the number of clockwise taps that
// turn the board back to the generated orientation.  A board can have other
// solutions, so the target is an upper bound, never an optimum.  A scored
// free-play win offers the next rung of the ladder 5x5, 7x7, 9x9, then the
// same three with wrap.
//
// Daily: 7x7 without wrap, built from the local date: FNV-1a of
// "ppn:" + YYYY-MM-DD seeds a mulberry32 generator (Math.random is never used
// for it), so every visitor gets the same board.  Daily #1 is 2026-11-01.
// One scored attempt per day: the attempt is written to ppn-daily the moment
// it begins; a reload resumes it or shows its result, and Restart only offers
// an unscored practice run of a finished Daily.  A Daily left open across
// midnight is finished as the day it started; the next one starts with the
// Daily button or a reload.  Streak = consecutive daily numbers won.
//
// Restart: the same board from its scramble.  Once a tile of it was turned
// the board is known, so the run is a replay and sets no best; New Game
// deals a scored board.
//
// Clock: a free game's clock runs from its first rotation, and after a
// reload from the next one.  The Daily's clock runs while its attempt is on
// screen, so the time shared is the time spent on the board.  Both stop
// while the tab is hidden.
//
// Keys: only while the board has the focus (Tab to it, or click a tile):
// arrows move the cursor, Space / Enter turn the tile clockwise, Q turns it
// back, L locks it, N starts a new game.  Ctrl / Alt / Cmd combinations and
// every key typed elsewhere on the host page are left alone.  A right-click
// locks a tile; the contextmenu of a long press on a touch screen does not.
//
// Saves: ppn-state (the free-play game and the view on screen), ppn-best
// (best time and fewest rotations per board), ppn-daily (the Daily attempt,
// its result and the streak).  Every field is checked on load and falls back
// on its own; storage that is blocked or full never stops the game.
//
// Tabs: ppn-daily is written only when the Daily changes, and it is read
// again first: a record another tab saved since that is a later Daily (up
// to today), the same Daily solved, or the same attempt further along is
// taken over instead of overwritten, at once through the storage event too.
// A new best is merged with the one on disk, so no tab erases another's.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser ppnInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var PPN_STATE_KEY = 'ppn-state';
  var PPN_BEST_KEY = 'ppn-best';
  var PPN_DAILY_KEY = 'ppn-daily';
  var PPN_SAVE_VERSION = 1;

  var PPN_SIZES = [5, 7, 9];
  var PPN_DEFAULT_SIZE = 5;
  var PPN_DAILY_SIZE = 7;
  var PPN_CONFIGS = ['5', '7', '9', '5w', '7w', '9w'];
  var PPN_MAX_LINKS = 3;
  var PPN_SCRAMBLE_TRIES = 10;

  var PPN_EPOCH = Date.UTC(2026, 10, 1);
  var PPN_DAY_MS = 86400000;
  var PPN_TICK_MS = 1000;
  var PPN_TOAST_MS = 2000;

  // Link bits of a tile, by direction index d: 1 << d is north, east, south,
  // west.  A quarter turn clockwise moves every bit one step along the list.
  var PPN_DIR_NAMES = ['N', 'E', 'S', 'W'];
  var PPN_STEPS = [[-1, 0], [0, 1], [1, 0], [0, -1]];
  var PPN_ARM_CLASSES = ['ppn-arm-n', 'ppn-arm-e', 'ppn-arm-s', 'ppn-arm-w'];

  var PPN_DEVICES = ['server', 'nas', 'ap'];
  var PPN_DEVICE_NAMES = { server: 'server', nas: 'NAS', ap: 'access point' };
  var PPN_COLUMNS = 'ABCDEFGHI';

  // Keys by KeyboardEvent.key (lower-cased), then by the physical key for
  // layouts whose letters are not Latin.
  var PPN_KEYS = {
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
    ' ': 'rotate',
    enter: 'rotate',
    q: 'back',
    l: 'lock',
    n: 'new'
  };
  var PPN_CODES = { KeyQ: 'back', KeyL: 'lock', KeyN: 'new' };
  var PPN_MOVES = { up: 0, right: 1, down: 2, left: 3 };

  // ── State ─────────────────────────────────────────────────────────────────

  // view: 'free' or 'daily', the board on screen.  free: the free-play game.
  // daily: the Daily record (ppnParseDaily).  best: per board (ppnParseBest).
  // A game is { n, wrap, masks, start, turns, locks, moves, elapsed,
  // practice, replay, solved }: masks are the generated (solved) link bits,
  // start and turns the scrambled and the current clockwise quarter turns of
  // each tile, locks 0 / 1 per tile, elapsed the clock in ms, practice the
  // number of the Daily a practice run replays (null otherwise), replay true
  // for a free board restarted after it was turned (neither scores).
  var ppnState = {
    view: 'free',
    free: null,
    daily: null,
    best: null
  };

  // Page handles, never saved.  game: the game the tiles on screen were
  // built for; angles: the quarter turns each cable layer shows (they only
  // grow or shrink, so a turn always animates the short way).  since: the
  // performance.now() the clock last started at, null while it stands.
  // dailyText: the ppn-daily text this tab last read or wrote, so a record
  // another tab wrote since stands out.  touch: the latest press on the
  // board was a finger.
  var ppnRuntime = {
    els: null,
    game: null,
    tiles: [],
    cables: [],
    arms: [],
    rim: [],
    angles: [],
    cursor: 0,
    lockMode: false,
    keys: false,
    since: null,
    interval: null,
    resumeOnShow: false,
    toastTimeout: null,
    warned: false,
    dailyText: null,
    touch: false
  };

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function ppnHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function ppnFill(length, value) {
    var out = [];
    for (var i = 0; i < length; i++) {
      out.push(value);
    }
    return out;
  }

  function ppnPad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  // Whole seconds as m:ss; minutes keep counting past 59 (61:05).
  function ppnFormatTime(seconds) {
    return Math.floor(seconds / 60) + ':' + ppnPad2(seconds % 60);
  }

  function ppnRotations(count) {
    return count + ' rotation' + (count === 1 ? '' : 's');
  }

  function ppnConfigKey(n, wrap) {
    return n + (wrap ? 'w' : '');
  }

  // A board choice of the select ('7', '9w' ...) as { n, wrap }; an unknown
  // size is the default one.
  function ppnConfigOf(value) {
    var n = parseInt(value, 10);
    return { n: PPN_SIZES.indexOf(n) === -1 ? PPN_DEFAULT_SIZE : n, wrap: /w$/.test(value) };
  }

  function ppnSizeText(game) {
    return game.n + 'x' + game.n + (game.wrap ? ' wrap' : '');
  }

  // ── Tiles and boards (no DOM) ─────────────────────────────────────────────

  // The link bits of a tile turned clockwise by turns quarter turns (any
  // integer; negative turns go anticlockwise).
  function ppnRotateMask(mask, turns) {
    var k = ((turns % 4) + 4) % 4;
    var out = mask;
    for (var i = 0; i < k; i++) {
      out = ((out << 1) | (out >> 3)) & 15;
    }
    return out;
  }

  function ppnLinkCount(mask) {
    var count = 0;
    for (var d = 0; d < 4; d++) {
      count += (mask >> d) & 1;
    }
    return count;
  }

  // How many quarter turns bring a tile back to itself: 1 for a cross (or
  // nothing), 2 for a straight, 4 for everything else.
  function ppnPeriod(mask) {
    if (ppnRotateMask(mask, 1) === mask) {
      return 1;
    }
    return ppnRotateMask(mask, 2) === mask ? 2 : 4;
  }

  // The switch sits on the middle cell (every size is odd).
  function ppnCenter(n) {
    return (n * n - 1) / 2;
  }

  // The cell next to index in direction d, or -1 off the board.  With wrap
  // the edges meet, as on a torus.
  function ppnNeighbour(index, d, n, wrap) {
    var row = Math.floor(index / n) + PPN_STEPS[d][0];
    var col = index % n + PPN_STEPS[d][1];
    if (wrap) {
      row = (row + n) % n;
      col = (col + n) % n;
    } else if (row < 0 || row >= n || col < 0 || col >= n) {
      return -1;
    }
    return row * n + col;
  }

  // The link bits every tile shows now.
  function ppnCurrent(masks, turns) {
    return masks.map(function (mask, i) {
      return ppnRotateMask(mask, turns[i]);
    });
  }

  // The neighbour that answers the link of cell index in direction d, or -1
  // when there is no such link or nobody answers it.
  function ppnLinkedTo(cur, index, d, n, wrap) {
    if (!(cur[index] & (1 << d))) {
      return -1;
    }
    var j = ppnNeighbour(index, d, n, wrap);
    return j !== -1 && (cur[j] & (1 << ((d + 2) % 4))) ? j : -1;
  }

  // A breadth-first search from the switch over answered links: for every
  // cell the direction (0-3) of its uplink, the link it was reached by, which
  // leads back toward the switch; -1 for the switch itself and null for a
  // cell the switch does not reach.
  function ppnUplinks(cur, n, wrap) {
    var uplinks = ppnFill(cur.length, null);
    var queue = [ppnCenter(n)];
    uplinks[queue[0]] = -1;
    while (queue.length) {
      var at = queue.shift();
      for (var d = 0; d < 4; d++) {
        var j = ppnLinkedTo(cur, at, d, n, wrap);
        if (j !== -1 && uplinks[j] === null) {
          uplinks[j] = (d + 2) % 4;
          queue.push(j);
        }
      }
    }
    return uplinks;
  }

  // Which cells the switch reaches over answered links, as one boolean per
  // cell.
  function ppnConnectedSet(cur, n, wrap) {
    return ppnUplinks(cur, n, wrap).map(function (dir) {
      return dir !== null;
    });
  }

  // Every link nobody answers, as { index, dir } with dir the link bit: a
  // cable pointing off the board (without wrap) or at a tile that does not
  // point back.
  function ppnOpenEnds(cur, n, wrap) {
    var ends = [];
    for (var i = 0; i < cur.length; i++) {
      for (var d = 0; d < 4; d++) {
        if ((cur[i] & (1 << d)) && ppnLinkedTo(cur, i, d, n, wrap) === -1) {
          ends.push({ index: i, dir: 1 << d });
        }
      }
    }
    return ends;
  }

  // The cells on a loop, or on a path between two loops, as one boolean per
  // cell: what is left of the answered links after stripping every cell with
  // fewer than two of them, again and again.
  function ppnLoopCells(cur, n, wrap) {
    var links = cur.map(function (mask, i) {
      var list = [];
      for (var d = 0; d < 4; d++) {
        var j = ppnLinkedTo(cur, i, d, n, wrap);
        if (j !== -1) {
          list.push(j);
        }
      }
      return list;
    });
    var degree = links.map(function (list) {
      return list.length;
    });
    var stripped = ppnFill(cur.length, false);
    var stack = [];
    degree.forEach(function (count, i) {
      if (count < 2) {
        stack.push(i);
      }
    });
    function strip(j) {
      degree[j]--;
      if (!stripped[j] && degree[j] < 2) {
        stack.push(j);
      }
    }
    while (stack.length) {
      var at = stack.pop();
      if (!stripped[at]) {
        stripped[at] = true;
        links[at].forEach(strip);
      }
    }
    return stripped.map(function (gone) {
      return !gone;
    });
  }

  function ppnHasLoop(cur, n, wrap) {
    return ppnLoopCells(cur, n, wrap).indexOf(true) !== -1;
  }

  // Every link answered, every cell reached from the switch, no loop.
  function ppnIsSolved(cur, n, wrap) {
    return ppnOpenEnds(cur, n, wrap).length === 0 &&
      ppnConnectedSet(cur, n, wrap).indexOf(false) === -1 &&
      !ppnHasLoop(cur, n, wrap);
  }

  // The edges from the tree to a cell outside it, as [from, d, to], from
  // tree cells that still have fewer than PPN_MAX_LINKS links.
  function ppnFrontier(masks, inTree, n, wrap) {
    var edges = [];
    for (var i = 0; i < masks.length; i++) {
      if (inTree[i] && ppnLinkCount(masks[i]) < PPN_MAX_LINKS) {
        for (var d = 0; d < 4; d++) {
          var j = ppnNeighbour(i, d, n, wrap);
          if (j !== -1 && !inTree[j]) {
            edges.push([i, d, j]);
          }
        }
      }
    }
    return edges;
  }

  // Turns every tile 0-3 quarter turns with rnd.  A scramble that leaves the
  // board solved is drawn again; after PPN_SCRAMBLE_TRIES such draws (only a
  // broken random source does that) one end device is turned once more,
  // which always breaks a solved board.
  function ppnScramble(masks, n, wrap, rnd) {
    var start = [];
    for (var tries = 0; tries < PPN_SCRAMBLE_TRIES; tries++) {
      start = masks.map(function () {
        return Math.floor(rnd() * 4);
      });
      if (!ppnIsSolved(ppnCurrent(masks, start), n, wrap)) {
        return start;
      }
    }
    var leaf = masks.map(ppnLinkCount).indexOf(1);
    start[leaf] = (start[leaf] + 1) % 4;
    return start;
  }

  // A new n x n board: { n, wrap, masks, start }.  rnd is a function giving
  // numbers in [0, 1) (Math.random, or a seeded generator for the Daily).
  // The cap of three links never leaves the tree stuck: if every tree tile
  // next to the cells still outside had three links, each would be linked to
  // all its other neighbours, which closes a ring of links round those cells
  // (a cycle a tree cannot have); and next to a board edge without wrap such
  // a tile has at most two other neighbours.
  function ppnGenerate(n, rnd, wrap) {
    var total = n * n;
    var masks = ppnFill(total, 0);
    var inTree = ppnFill(total, false);
    inTree[ppnCenter(n)] = true;
    for (var added = 1; added < total; added++) {
      var edges = ppnFrontier(masks, inTree, n, wrap);
      var edge = edges[Math.floor(rnd() * edges.length)];
      masks[edge[0]] |= 1 << edge[1];
      masks[edge[2]] |= 1 << ((edge[1] + 2) % 4);
      inTree[edge[2]] = true;
    }
    return { n: n, wrap: wrap, masks: masks, start: ppnScramble(masks, n, wrap, rnd) };
  }

  // Clockwise taps that turn every tile from start back to the generated
  // orientation, counting a straight's half-turn symmetry: an upper bound on
  // the rotations a board needs.
  function ppnTargetOf(masks, start) {
    var total = 0;
    masks.forEach(function (mask, i) {
      var period = ppnPeriod(mask);
      total += (period - start[i] % period) % period;
    });
    return total;
  }

  // The end device of a cell: server, NAS and access point in diagonal
  // stripes (column + row), so every board size mixes all three.
  function ppnDevice(index, n) {
    return PPN_DEVICES[(index % n + Math.floor(index / n)) % 3];
  }

  // The next rung of the ladder 5x5, 7x7, 9x9, 5x5 wrap, 7x7 wrap, 9x9 wrap
  // as { n, wrap }, or null after the top one.
  function ppnNextRung(n, wrap) {
    var next = PPN_CONFIGS[PPN_CONFIGS.indexOf(ppnConfigKey(n, wrap)) + 1];
    return next ? ppnConfigOf(next) : null;
  }

  // What a tile is, from its generated link bits: switch, server / NAS /
  // access point, straight, corner, tee or cross.
  function ppnShape(mask, index, n) {
    var links = ppnLinkCount(mask);
    if (index === ppnCenter(n)) {
      return 'switch';
    }
    if (links === 1) {
      return PPN_DEVICE_NAMES[ppnDevice(index, n)];
    }
    if (links === 3) {
      return 'tee';
    }
    if (links === 4) {
      return 'cross';
    }
    return ppnPeriod(mask) === 2 ? 'straight' : 'corner';
  }

  // Port names as on a panel: column letter, row number (A1 top left).
  function ppnCellName(index, n) {
    return PPN_COLUMNS.charAt(index % n) + (Math.floor(index / n) + 1);
  }

  // ── Wrap rim (no DOM) ─────────────────────────────────────────────────────

  // The crossings of a wrap board's rim, where a cable can leave one edge and
  // come back in on the opposite one: one per row (its west and east tiles),
  // then one per column (its north and south tiles).  Each is { axis: 'row'
  // or 'col', line, a, b, aOut, bOut }: a is the west or north tile, b the
  // east or south one, and aOut / bOut whether its cable points across the
  // rim (bit 3 west, 1 east, 0 north, 2 south).  No crossings without wrap.
  function ppnWrapCrossings(cur, n, wrap) {
    var out = [];
    if (!wrap) {
      return out;
    }
    for (var row = 0; row < n; row++) {
      var west = row * n;
      var east = west + n - 1;
      out.push({ axis: 'row', line: row, a: west, b: east, aOut: (cur[west] & 8) !== 0, bOut: (cur[east] & 2) !== 0 });
    }
    for (var col = 0; col < n; col++) {
      var south = (n - 1) * n + col;
      out.push({ axis: 'col', line: col, a: col, b: south, aOut: (cur[col] & 1) !== 0, bOut: (cur[south] & 4) !== 0 });
    }
    return out;
  }

  // How one end of a crossing looks: like the tile beside it.  live: that
  // tile is on the switch's network and in no loop (what .ppn-tile--up
  // shows); stormy: that tile is in a loop (.ppn-tile--storm).  Where cables
  // meet across the rim the end is 'storm', 'up', or 'link' for a dark tile;
  // an end whose cable nobody answers is 'open' (amber, like a live cable's
  // open end) when live, 'loose' otherwise; 'idle' where no cable crosses.
  function ppnCrossingLook(crossing, end, live, stormy) {
    if (crossing.aOut && crossing.bOut) {
      if (stormy) {
        return 'storm';
      }
      return live ? 'up' : 'link';
    }
    if (end === 'a' ? crossing.aOut : crossing.bOut) {
      return live ? 'open' : 'loose';
    }
    return 'idle';
  }

  // The tiles across the rim from index on a wrap board: the other end of its
  // row when it sits in the first or last column, of its column when it sits
  // in the first or last row (a corner has both).  None without wrap.
  function ppnWrapTwins(index, n, wrap) {
    var out = [];
    if (!wrap) {
      return out;
    }
    var row = Math.floor(index / n);
    var col = index % n;
    if (col === 0 || col === n - 1) {
      out.push(row * n + (n - 1 - col));
    }
    if (row === 0 || row === n - 1) {
      out.push((n - 1 - row) * n + col);
    }
    return out;
  }

  // Where the rim edges of a tile continue on a wrap board, for the hint
  // under it, kept short for phones: ' · wraps W→E1, N→A5'.
  function ppnWrapHint(index, n, wrap) {
    var row = Math.floor(index / n);
    var col = index % n;
    var notes = [];
    if (wrap) {
      if (col === 0) {
        notes.push('W→' + ppnCellName(row * n + n - 1, n));
      }
      if (col === n - 1) {
        notes.push('E→' + ppnCellName(row * n, n));
      }
      if (row === 0) {
        notes.push('N→' + ppnCellName((n - 1) * n + col, n));
      }
      if (row === n - 1) {
        notes.push('S→' + ppnCellName(col, n));
      }
    }
    return notes.length ? ' · wraps ' + notes.join(', ') : '';
  }

  // ── Daily (no DOM) ────────────────────────────────────────────────────────

  // FNV-1a, 32 bit, over the UTF-16 code units of text.
  function ppnHash(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // mulberry32: a seeded generator of numbers in [0, 1).
  function ppnMulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The Daily number of a calendar date, counted in UTC days so a change of
  // daylight saving time never skips or repeats one.
  function ppnDayNumber(year, month, date) {
    return (Date.UTC(year, month, date) - PPN_EPOCH) / PPN_DAY_MS + 1;
  }

  // The local calendar date of now as { key: 'YYYY-MM-DD', day }.
  function ppnDayInfo(now) {
    var year = now.getFullYear();
    var month = now.getMonth();
    var date = now.getDate();
    return {
      key: year + '-' + ppnPad2(month + 1) + '-' + ppnPad2(date),
      day: ppnDayNumber(year, month, date)
    };
  }

  // The Daily number of a 'YYYY-MM-DD' key, or null when it is not a real
  // date in that form.
  function ppnKeyDay(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof key === 'string' ? key : '');
    if (!m) {
      return null;
    }
    var year = Number(m[1]);
    var month = Number(m[2]) - 1;
    var date = Number(m[3]);
    var check = new Date(Date.UTC(year, month, date));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== date) {
      return null;
    }
    return ppnDayNumber(year, month, date);
  }

  function ppnDailyBoard(key) {
    return ppnGenerate(PPN_DAILY_SIZE, ppnMulberry32(ppnHash('ppn:' + key)), false);
  }

  // The streak as of Daily number today: kept while the last win is today's
  // or yesterday's, 0 once a day was missed.
  function ppnLiveStreak(daily, today) {
    var gap = today - daily.lastWon;
    return daily.lastWon !== null && (gap === 0 || gap === 1) ? daily.streak : 0;
  }

  function ppnShareText(day, n, seconds, moves, target) {
    return 'Patch Panel #' + day + ' ' + n + 'x' + n + ' ' + ppnFormatTime(seconds) + ' ' +
      ppnRotations(moves) + ' (target ' + target + ')';
  }

  // Whether a Daily record another tab stored has to win over this tab's
  // (both as ppnParseDaily gives them; elapsed is this tab's clock now): a
  // later Daily, the same Daily solved while ours is not, or the same
  // attempt further along (more rotations, or as many and more time).  A
  // record from after today (a clock set back) never wins.
  function ppnIsNewerDaily(stored, ours, elapsed, today) {
    if (stored.key === null || stored.day > today) {
      return false;
    }
    if (ours.key === null) {
      return true;
    }
    if (stored.day !== ours.day) {
      return stored.day > ours.day;
    }
    if (stored.status !== ours.status) {
      return stored.status === 'won';
    }
    if (stored.game.moves !== ours.game.moves) {
      return stored.game.moves > ours.game.moves;
    }
    return stored.game.elapsed > elapsed;
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function ppnParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function ppnIsObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function ppnIsInteger(value) {
    return typeof value === 'number' && value % 1 === 0;
  }

  function ppnIsCount(value) {
    return ppnIsInteger(value) && value >= 0;
  }

  // A copy of value when it is an array of length integers from min to max,
  // else null.
  function ppnIntList(value, length, min, max) {
    if (!Array.isArray(value) || value.length !== length) {
      return null;
    }
    for (var i = 0; i < length; i++) {
      var v = value[i];
      if (!ppnIsInteger(v) || v < min || v > max) {
        return null;
      }
    }
    return value.slice();
  }

  // Whether generated link bits make a solved board with wrap (a boolean),
  // else the first of no wrap and wrap that does; null for neither.
  function ppnWrapOf(masks, n, wrap) {
    if (typeof wrap === 'boolean') {
      return ppnIsSolved(masks, n, wrap) ? wrap : null;
    }
    if (ppnIsSolved(masks, n, false)) {
      return false;
    }
    return ppnIsSolved(masks, n, true) ? true : null;
  }

  function ppnMakeGame(game) {
    game.solved = ppnIsSolved(ppnCurrent(game.masks, game.turns), game.n, game.wrap);
    return game;
  }

  // A game at its scrambled start, from a board ({ n, wrap, masks, start }).
  function ppnFreshGame(board, practice, replay) {
    return ppnMakeGame({
      n: board.n,
      wrap: board.wrap,
      masks: board.masks.slice(),
      start: board.start.slice(),
      turns: board.start.slice(),
      locks: ppnFill(board.n * board.n, 0),
      moves: 0,
      elapsed: 0,
      practice: practice,
      replay: replay
    });
  }

  // The size of a saved game: its n, else the size its masks have, else the
  // default.
  function ppnSizeOf(data) {
    if (PPN_SIZES.indexOf(data.n) !== -1) {
      return data.n;
    }
    var length = Array.isArray(data.masks) ? data.masks.length : 0;
    var sizes = PPN_SIZES.filter(function (n) {
      return n * n === length;
    });
    return sizes.length ? sizes[0] : PPN_DEFAULT_SIZE;
  }

  // A saved n x n game, or null when its board cannot be played: masks that
  // are not a solvable board, and neither turns nor a start.  Every other
  // field falls back on its own: turns to the start and the start to the
  // turns, locks to none, moves and the clock to 0, practice to null and
  // replay to false.
  function ppnParseGame(data, n) {
    var total = n * n;
    var masks = ppnIntList(data.masks, total, 1, 15);
    var wrap = masks ? ppnWrapOf(masks, n, data.wrap) : null;
    var start = ppnIntList(data.start, total, 0, 3);
    var turns = ppnIntList(data.turns, total, 0, 3) || (start && start.slice());
    if (wrap === null || !turns) {
      return null;
    }
    return ppnMakeGame({
      n: n,
      wrap: wrap,
      masks: masks,
      start: start || turns.slice(),
      turns: turns,
      locks: ppnIntList(data.locks, total, 0, 1) || ppnFill(total, 0),
      moves: ppnIsCount(data.moves) ? data.moves : 0,
      elapsed: ppnIsCount(data.elapsed) ? data.elapsed : 0,
      practice: ppnIsInteger(data.practice) ? data.practice : null,
      replay: data.replay === true
    });
  }

  // ppn-state as { view, n, wrap, game }: game is null when the save holds
  // no playable game; n and wrap are then the board it asked for.
  function ppnParseState(text) {
    var data = ppnParseJson(text);
    if (!ppnIsObject(data)) {
      data = {};
    }
    var n = ppnSizeOf(data);
    var game = ppnParseGame(data, n);
    return {
      view: data.view === 'daily' ? 'daily' : 'free',
      n: n,
      wrap: game ? game.wrap : data.wrap === true,
      game: game
    };
  }

  // ppn-daily as { key, day, status, game, time, streak, lastWon }.  Without
  // a valid key there is no attempt (key null, game null) but the streak
  // stays.  The board comes from the key; a finished attempt shows the
  // generated solution when its turns are not solved, and an unfinished one
  // whose turns are solved starts from its scramble again.
  function ppnParseDaily(text) {
    var data = ppnParseJson(text);
    if (!ppnIsObject(data)) {
      data = {};
    }
    var daily = {
      key: null,
      day: 0,
      status: 'playing',
      game: null,
      time: 0,
      streak: ppnIsCount(data.streak) ? data.streak : 0,
      lastWon: ppnIsInteger(data.lastWon) ? data.lastWon : null
    };
    var day = ppnKeyDay(data.key);
    if (day === null) {
      return daily;
    }
    var board = ppnDailyBoard(data.key);
    var game = ppnParseGame({
      masks: board.masks,
      wrap: false,
      start: board.start,
      turns: data.turns,
      locks: data.locks,
      moves: data.moves,
      elapsed: data.elapsed
    }, PPN_DAILY_SIZE);
    var won = data.status === 'won';
    if (game.solved !== won) {
      game.turns = won ? ppnFill(game.masks.length, 0) : game.start.slice();
      game.solved = won;
    }
    daily.key = data.key;
    daily.day = day;
    daily.status = won ? 'won' : 'playing';
    daily.game = game;
    daily.time = ppnIsCount(data.time) ? data.time : Math.floor(game.elapsed / 1000);
    return daily;
  }

  // ppn-best as { '5': { time, moves }, '5w': ... }: the best time in whole
  // seconds and the fewest rotations of each board, null when none.
  function ppnParseBest(text) {
    var data = ppnParseJson(text);
    var best = {};
    PPN_CONFIGS.forEach(function (key) {
      var entry = ppnIsObject(data) && ppnIsObject(data[key]) ? data[key] : {};
      best[key] = {
        time: ppnIsCount(entry.time) ? entry.time : null,
        moves: ppnIsCount(entry.moves) ? entry.moves : null
      };
    });
    return best;
  }

  // The lower of two best values, either of which may be null (none yet).
  function ppnLower(a, b) {
    if (a === null) {
      return b;
    }
    return b === null || a <= b ? a : b;
  }

  // Two ppn-best records (ppnParseBest) merged board by board and field by
  // field, so a best one tab wrote is never lost to another tab's.
  function ppnMergeBest(a, b) {
    var best = {};
    PPN_CONFIGS.forEach(function (key) {
      best[key] = {
        time: ppnLower(a[key].time, b[key].time),
        moves: ppnLower(a[key].moves, b[key].moves)
      };
    });
    return best;
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  function ppnWarnStorage(error) {
    if (ppnRuntime.warned) {
      return;
    }
    ppnRuntime.warned = true;
    var warning = ppnRuntime.els.warning;
    warning.textContent = 'Storage is blocked or full (' + error.name + '): progress on this page will not be saved.';
    warning.classList.remove('ppn-hidden');
  }

  function ppnStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      ppnWarnStorage(error);
      return null;
    }
  }

  function ppnStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      ppnWarnStorage(error);
    }
  }

  function ppnActive() {
    return ppnState.view === 'daily' ? ppnState.daily.game : ppnState.free;
  }

  // A game's clock in ms, the running stretch included.
  function ppnElapsedOf(game) {
    var running = ppnRuntime.since !== null && game === ppnActive();
    return game.elapsed + (running ? Math.round(performance.now() - ppnRuntime.since) : 0);
  }

  function ppnSerializeState() {
    var game = ppnState.free;
    return {
      v: PPN_SAVE_VERSION,
      view: ppnState.view,
      n: game.n,
      wrap: game.wrap,
      masks: game.masks,
      start: game.start,
      turns: game.turns,
      locks: game.locks,
      moves: game.moves,
      elapsed: ppnElapsedOf(game),
      practice: game.practice,
      replay: game.replay
    };
  }

  function ppnSerializeDaily() {
    var daily = ppnState.daily;
    var game = daily.game;
    return {
      v: PPN_SAVE_VERSION,
      key: daily.key,
      day: daily.day,
      status: daily.status,
      turns: game.turns,
      locks: game.locks,
      moves: game.moves,
      elapsed: ppnElapsedOf(game),
      time: daily.time,
      streak: daily.streak,
      lastWon: daily.lastWon
    };
  }

  // Writes the free-play game and the view on screen (never the Daily).
  function ppnSaveState() {
    ppnStorageSet(PPN_STATE_KEY, JSON.stringify(ppnSerializeState()));
  }

  // Reads ppn-daily again and takes over the record another tab saved there
  // when it has to win over this tab's (ppnIsNewerDaily); a Daily on screen
  // follows, with a toast naming what came in.  Returns whether it did.
  function ppnSyncDaily() {
    var text = ppnStorageGet(PPN_DAILY_KEY);
    var ours = ppnState.daily;
    if (text === ppnRuntime.dailyText) {
      return false;
    }
    var stored = ppnParseDaily(text);
    var elapsed = ours.game ? ppnElapsedOf(ours.game) : 0;
    if (!ppnIsNewerDaily(stored, ours, elapsed, ppnDayInfo(new Date()).day)) {
      return false;
    }
    var onScreen = ppnState.view === 'daily';
    if (onScreen) {
      ppnPauseClock();
    }
    ppnRuntime.dailyText = text;
    ppnState.daily = stored;
    if (ppnDailyLive()) {
      ppnStartClock();
    }
    ppnRender();
    if (onScreen) {
      ppnShowToast('Another tab ' + (stored.status === 'won' ? 'solved' : 'saved') + ' Daily #' + stored.day + ' (' +
        ppnRotations(stored.game.moves) + ', ' + ppnFormatTime(Math.floor(stored.game.elapsed / 1000)) +
        '): it is shown here.');
    }
    return true;
  }

  // Writes the Daily attempt, unless another tab saved a record that has to
  // win over it: that one is taken over instead.
  function ppnSaveDaily() {
    if (ppnSyncDaily()) {
      return;
    }
    ppnRuntime.dailyText = JSON.stringify(ppnSerializeDaily());
    ppnStorageSet(PPN_DAILY_KEY, ppnRuntime.dailyText);
  }

  // Writes the game on screen: the Daily attempt or the free-play game.
  function ppnSaveActive() {
    if (ppnState.view === 'daily') {
      ppnSaveDaily();
    } else {
      ppnSaveState();
    }
  }

  // Keeps the best time and the fewest rotations of the game's board, merged
  // with what another tab may have stored since.  Returns whether this game
  // improved either.
  function ppnRecordBest(game) {
    ppnState.best = ppnMergeBest(ppnState.best, ppnParseBest(ppnStorageGet(PPN_BEST_KEY)));
    var entry = ppnState.best[ppnConfigKey(game.n, game.wrap)];
    var time = Math.floor(game.elapsed / 1000);
    var better = false;
    if (entry.time === null || time < entry.time) {
      entry.time = time;
      better = true;
    }
    if (entry.moves === null || game.moves < entry.moves) {
      entry.moves = game.moves;
      better = true;
    }
    ppnStorageSet(PPN_BEST_KEY, JSON.stringify(ppnState.best));
    return better;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  // The tiles of a game, built once per game: a rotating cable layer with
  // one arm per generated link and a hub, and for the switch and the end
  // devices a device that stays upright.
  function ppnBuildBoard(game) {
    var board = ppnRuntime.els.board;
    var n = game.n;
    board.innerHTML = '';
    board.style.gridTemplateColumns = 'repeat(' + n + ', var(--ppn-tile))';
    ppnRuntime.game = game;
    ppnRuntime.tiles = [];
    ppnRuntime.cables = [];
    ppnRuntime.arms = [];
    ppnRuntime.angles = game.turns.slice();
    game.masks.forEach(function (mask, i) {
      var tile = document.createElement('div');
      var cable = document.createElement('span');
      var hub = document.createElement('span');
      var arms = [];
      var shape = ppnShape(mask, i, n);
      tile.id = 'ppn-tile-' + i;
      tile.setAttribute('data-index', i);
      tile.setAttribute('role', 'button');
      cable.className = 'ppn-cable';
      for (var d = 0; d < 4; d++) {
        if (mask & (1 << d)) {
          var arm = document.createElement('span');
          cable.appendChild(arm);
          arms.push({ d: d, el: arm });
        }
      }
      hub.className = 'ppn-hub';
      cable.appendChild(hub);
      tile.appendChild(cable);
      if (shape === 'switch' || ppnLinkCount(mask) === 1) {
        var node = document.createElement('span');
        node.className = 'ppn-node ppn-node-' + (shape === 'switch' ? 'switch' : ppnDevice(i, n));
        tile.appendChild(node);
      }
      board.appendChild(tile);
      ppnRuntime.tiles.push(tile);
      ppnRuntime.cables.push(cable);
      ppnRuntime.arms.push(arms);
    });
    ppnBuildRim(game);
  }

  // The rim marks of a wrap board, after the tiles: two per crossing, one in
  // the padding beside each end.  Each mark is placed on its tile's grid cell
  // and positioned out of it, so it needs no sizes of its own.  Both lines of
  // the cell are given: for an absolutely positioned grid item an auto end
  // line is the board's padding edge, not the next line.
  function ppnBuildRim(game) {
    var n = game.n;
    ppnRuntime.rim = [];
    ppnWrapCrossings(game.masks, n, game.wrap).forEach(function (crossing, k) {
      var row = crossing.axis === 'row';
      [['a', row ? 'w' : 'n'], ['b', row ? 'e' : 's']].forEach(function (end) {
        var mark = document.createElement('span');
        var index = crossing[end[0]];
        var line = Math.floor(index / n) + 1;
        var col = index % n + 1;
        mark.setAttribute('aria-hidden', 'true');
        mark.style.gridRow = line + ' / ' + (line + 1);
        mark.style.gridColumn = col + ' / ' + (col + 1);
        ppnRuntime.els.board.appendChild(mark);
        ppnRuntime.rim.push({ el: mark, k: k, end: end[0], side: end[1] });
      });
    });
  }

  function ppnDrawRim(game, cur, uplinks, storm) {
    var crossings = ppnWrapCrossings(cur, game.n, game.wrap);
    ppnRuntime.rim.forEach(function (mark) {
      var crossing = crossings[mark.k];
      var tile = crossing[mark.end];
      var look = ppnCrossingLook(crossing, mark.end, uplinks[tile] !== null && !storm[tile], storm[tile]);
      mark.el.className = 'ppn-rim ppn-rim--' + mark.side + ' ppn-rim--' + look;
    });
  }

  // The class of one arm of a tile: amber when nobody answers it, and
  // marked as the uplink when it points back toward the switch (packets run
  // in along the uplink and out along the other arms).
  function ppnArmClass(arm, turns, openBits, uplink) {
    var dir = (arm.d + turns) % 4;
    return 'ppn-arm ' + PPN_ARM_CLASSES[arm.d] + (openBits & (1 << dir) ? ' ppn-arm--open' : '') +
      (dir === uplink ? ' ppn-arm--uplink' : '');
  }

  // Draws every tile's state and returns how many ports are up (reached
  // from the switch and not in a storm).
  function ppnDrawTiles(game, cur, uplinks, storm, ends) {
    var n = game.n;
    var open = ppnFill(cur.length, 0);
    var upCount = 0;
    // A rim tile under the cursor and the tile(s) across the rim from it share
    // a dashed outline, so a tap with the mouse or a finger shows the pair.
    var twins = ppnWrapTwins(ppnRuntime.cursor, n, game.wrap);
    if (twins.length) {
      twins.push(ppnRuntime.cursor);
    }
    ends.forEach(function (end) {
      open[end.index] |= end.dir;
    });
    ppnRuntime.tiles.forEach(function (tile, i) {
      var classes = ['ppn-tile'];
      var state = 'link down';
      if (storm[i]) {
        classes.push('ppn-tile--storm');
        state = 'broadcast storm';
      } else if (uplinks[i] !== null) {
        classes.push('ppn-tile--up');
        state = 'link up';
        upCount++;
      }
      if (game.locks[i]) {
        classes.push('ppn-tile--locked');
      }
      if (i === ppnRuntime.cursor) {
        classes.push('ppn-tile--cursor');
      }
      if (twins.indexOf(i) !== -1) {
        classes.push('ppn-tile--twin');
      }
      tile.className = classes.join(' ');
      tile.setAttribute('aria-label', ppnCellName(i, n) + ' ' + ppnShape(game.masks[i], i, n) + ', ' +
        state + (game.locks[i] ? ', locked' : ''));
      ppnRuntime.cables[i].style.transform = 'rotate(' + ppnRuntime.angles[i] * 90 + 'deg)';
      ppnRuntime.arms[i].forEach(function (arm) {
        arm.el.className = ppnArmClass(arm, game.turns[i], open[i], uplinks[i]);
      });
    });
    return upCount;
  }

  function ppnDrawBoardFrame(game, upCount) {
    var board = ppnRuntime.els.board;
    board.className = 'ppn-board ppn-board--n' + game.n +
      (game.wrap ? ' ppn-board--wrap' : '') +
      (game.solved ? ' ppn-board--solved' : '') +
      (ppnRuntime.lockMode ? ' ppn-board--lockmode' : '') +
      (ppnRuntime.keys ? ' ppn-board--keys' : '');
    board.setAttribute('aria-label', 'Patch panel ' + ppnSizeText(game) + ': ' + upCount + ' of ' +
      game.n * game.n + ' ports up');
    board.setAttribute('aria-activedescendant', 'ppn-tile-' + ppnRuntime.cursor);
  }

  function ppnBestText(best) {
    if (best.time === null && best.moves === null) {
      return '--';
    }
    return (best.time === null ? '--' : ppnFormatTime(best.time)) + ' / ' +
      (best.moves === null ? '--' : String(best.moves));
  }

  function ppnRenderTime(game) {
    ppnRuntime.els.time.textContent = ppnFormatTime(Math.floor(ppnElapsedOf(game) / 1000));
  }

  // ' Practice run, not scored.' / ' Replay, not scored.' for a game that
  // sets no best, '' for one that does.
  function ppnUnscoredText(game) {
    if (game.practice !== null) {
      return ' Practice run, not scored.';
    }
    return game.replay ? ' Replay, not scored.' : '';
  }

  function ppnStatusText(game, upCount, stormCount, openCount) {
    var daily = ppnState.daily;
    var total = game.n * game.n;
    var target = ppnTargetOf(game.masks, game.start);
    var unscored = ppnUnscoredText(game);
    var tail;
    var next;
    if (ppnState.view === 'daily' && daily.status === 'won') {
      return 'Daily #' + daily.day + ' solved in ' + ppnFormatTime(daily.time) + ' with ' + ppnRotations(game.moves) +
        ' (target ' + target + '). Streak ' + daily.streak + '.';
    }
    if (game.solved) {
      next = ppnNextRung(game.n, game.wrap);
      tail = game.practice !== null ? '' : next ? ' Next rung: ' + ppnSizeText(next) + '.' : ' Top rung of the ladder.';
      return 'Network converged: all ' + total + ' ports up in ' +
        ppnFormatTime(Math.floor(game.elapsed / 1000)) + ' with ' + ppnRotations(game.moves) + ' (target ' +
        target + ').' + unscored + tail;
    }
    if (stormCount) {
      return 'Broadcast storm: a loop runs through ' + stormCount + ' tiles. Turn one of the red tiles to break it.';
    }
    tail = game.elapsed > 0 && ppnRuntime.since === null ? ' Clock paused: it runs again with your next rotation.' : '';
    return 'Ports up ' + upCount + '/' + total + ', open cable ends: ' + openCount + '.' + unscored + tail;
  }

  // The tile under the cursor: name, kind, link bits now (as hex and as
  // directions) and its lock.
  function ppnHintText(game, index, cur) {
    var mask = cur[index];
    var names = PPN_DIR_NAMES.filter(function (name, d) {
      return mask & (1 << d);
    });
    return ppnCellName(index, game.n) + ' ' + ppnShape(game.masks[index], index, game.n) + ': mask 0x' +
      mask.toString(16).toUpperCase() + ' (' + names.join(' ') + ')' + (game.locks[index] ? ', locked' : '') +
      ppnWrapHint(index, game.n, game.wrap);
  }

  function ppnModeText(game) {
    var daily = ppnState.daily;
    if (ppnState.view === 'daily') {
      return 'Daily #' + daily.day + ' · ' + ppnSizeText(game) + ' · ' + daily.key;
    }
    if (game.practice !== null) {
      return 'Practice of Daily #' + game.practice + ' · ' + ppnSizeText(game);
    }
    return (game.replay ? 'Replay' : 'Free play') + ' · ' + ppnSizeText(game);
  }

  function ppnRenderControls() {
    var els = ppnRuntime.els;
    var daily = ppnState.daily;
    var inDaily = ppnState.view === 'daily';
    var won = inDaily && daily.status === 'won';
    var game = ppnActive();
    var next = !inDaily && game.solved && game.practice === null ? ppnNextRung(game.n, game.wrap) : null;
    var today = ppnDayInfo(new Date());
    els.dailyButton.textContent = inDaily ? 'Free Play' :
      'Daily #' + today.day + (daily.key === today.key && daily.status === 'won' ? ' ✓' : '');
    els.dailyButton.setAttribute('aria-label', inDaily ? 'Back to free play' : 'Open Daily #' + today.day);
    els.restart.textContent = won ? 'Practice' : 'Restart';
    els.restart.setAttribute('aria-label', won ? 'Practice this Daily board, not scored' : 'Restart this board');
    els.share.classList.toggle('ppn-hidden', !won);
    els.next.classList.toggle('ppn-hidden', !next);
    if (next) {
      els.next.textContent = 'Next rung: ' + ppnSizeText(next);
      els.next.setAttribute('aria-label', 'Start a new ' + ppnSizeText(next) + ' board, the next rung of the ladder');
    }
    els.lockMode.textContent = 'Lock mode: ' + (ppnRuntime.lockMode ? 'on' : 'off');
    els.lockMode.setAttribute('aria-pressed', String(ppnRuntime.lockMode));
    els.streak.textContent = String(ppnLiveStreak(daily, today.day));
  }

  function ppnRender() {
    var els = ppnRuntime.els;
    var game = ppnActive();
    var cur = ppnCurrent(game.masks, game.turns);
    var uplinks = ppnUplinks(cur, game.n, game.wrap);
    var storm = ppnLoopCells(cur, game.n, game.wrap);
    var ends = ppnOpenEnds(cur, game.n, game.wrap);
    if (ppnRuntime.game !== game) {
      ppnBuildBoard(game);
    }
    var upCount = ppnDrawTiles(game, cur, uplinks, storm, ends);
    ppnDrawRim(game, cur, uplinks, storm);
    ppnDrawBoardFrame(game, upCount);
    els.wrapNote.classList.toggle('ppn-hidden', !game.wrap);
    els.hint.classList.toggle('ppn-hint--wrap', game.wrap);
    els.mode.textContent = ppnModeText(game);
    els.ports.textContent = upCount + '/' + game.n * game.n;
    els.moves.textContent = String(game.moves);
    els.target.textContent = String(ppnTargetOf(game.masks, game.start));
    els.best.textContent = ppnBestText(ppnState.best[ppnConfigKey(game.n, game.wrap)]);
    ppnRenderTime(game);
    els.status.textContent = ppnStatusText(game, upCount, storm.filter(Boolean).length, ends.length);
    els.hint.textContent = ppnHintText(game, ppnRuntime.cursor, cur);
    ppnRenderControls();
  }

  function ppnHideToast() {
    ppnRuntime.toastTimeout = null;
    ppnRuntime.els.toast.classList.remove('ppn-show');
  }

  // Shows message for PPN_TOAST_MS; a newer toast gets its full time.
  function ppnShowToast(message) {
    var toast = ppnRuntime.els.toast;
    clearTimeout(ppnRuntime.toastTimeout);
    toast.textContent = message;
    toast.classList.add('ppn-show');
    ppnRuntime.toastTimeout = setTimeout(ppnHideToast, PPN_TOAST_MS);
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  function ppnTick() {
    ppnRenderTime(ppnActive());
    ppnSaveActive();
  }

  // Starts the clock of the game on screen; a solved game's clock stands.
  function ppnStartClock() {
    if (ppnRuntime.since !== null || ppnActive().solved) {
      return;
    }
    ppnRuntime.since = performance.now();
    ppnRuntime.interval = setInterval(ppnTick, PPN_TICK_MS);
  }

  // Whether the Daily clock has to run: its attempt is on screen, not
  // finished, in a visible tab.
  function ppnDailyLive() {
    return ppnState.view === 'daily' && ppnState.daily.status === 'playing' && !document.hidden;
  }

  // Stops the clock of the game on screen and adds the running stretch to it.
  function ppnPauseClock() {
    if (ppnRuntime.since === null) {
      return;
    }
    var game = ppnActive();
    game.elapsed = ppnElapsedOf(game);
    ppnRuntime.since = null;
    clearInterval(ppnRuntime.interval);
    ppnRuntime.interval = null;
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  // Puts a view on screen with the cursor on the switch, starts the Daily
  // clock when its attempt is live, and saves the free game and the view.
  function ppnShowView(view) {
    ppnState.view = view;
    ppnRuntime.cursor = ppnCenter(ppnActive().n);
    ppnRuntime.els.config.value = ppnConfigKey(ppnState.free.n, ppnState.free.wrap);
    if (ppnDailyLive()) {
      ppnStartClock();
    }
    ppnRender();
    ppnSaveState();
  }

  // Before another game takes the screen: writes the Daily attempt when it
  // is on screen (with its running clock), then stops the clock.
  function ppnStopActive() {
    if (ppnState.view === 'daily') {
      ppnSaveDaily();
    }
    ppnPauseClock();
  }

  // The free game set aside while the Daily is on screen, named for the
  // toast when something replaces it: '' when no tile of it was turned or it
  // is solved, so nothing is lost.
  function ppnReplacedText(game) {
    if (game.moves === 0 || game.solved) {
      return '';
    }
    return ' Your ' + ppnSizeText(game) + ' game set aside (' + ppnRotations(game.moves) + ', ' +
      ppnFormatTime(Math.floor(game.elapsed / 1000)) + ') was replaced.';
  }

  // A new free-play game of the board in config ({ n, wrap }).
  function ppnNewGame(config) {
    var replaced = ppnState.view === 'daily' ? ppnReplacedText(ppnState.free) : '';
    ppnStopActive();
    ppnState.free = ppnFreshGame(ppnGenerate(config.n, Math.random, config.wrap), null, false);
    ppnShowView('free');
    if (replaced) {
      ppnShowToast('New ' + ppnSizeText(ppnState.free) + ' board.' + replaced);
    }
  }

  function ppnNewGameFromConfig() {
    ppnNewGame(ppnConfigOf(ppnRuntime.els.config.value));
  }

  // The Next rung button (shown after a scored free-play win): a new board
  // one rung up the ladder.  Nothing above the top rung.
  function ppnClimb() {
    var next = ppnNextRung(ppnState.free.n, ppnState.free.wrap);
    if (next) {
      ppnNewGame(next);
    }
  }

  // Restart: the same board from its scramble.  A Daily in progress is one
  // scored attempt and refuses; a finished Daily gives a practice run; a
  // free board with a turned tile (or a replay already) gives a replay.
  // Neither sets a best.
  function ppnRestart() {
    var daily = ppnState.daily;
    var game = ppnActive();
    var inDaily = ppnState.view === 'daily';
    if (inDaily && daily.status === 'playing') {
      ppnShowToast('Daily #' + daily.day + ' is one scored attempt and cannot be restarted (rotations so far: ' +
        game.moves + ').');
      return;
    }
    var practice = inDaily ? daily.day : game.practice;
    var replay = practice === null && (game.replay || game.moves > 0);
    var replaced = inDaily ? ppnReplacedText(ppnState.free) : '';
    ppnStopActive();
    ppnState.free = ppnFreshGame(game, practice, replay);
    ppnShowView('free');
    if (practice !== null) {
      ppnShowToast('Practice run of Daily #' + practice + ': not scored.' + replaced);
    } else if (replay) {
      ppnShowToast('Replay of this ' + ppnSizeText(game) + ' board: not scored. New Game deals a scored one.');
    }
  }

  // Starts the Daily attempt of today.
  function ppnBeginDaily(today) {
    var daily = ppnState.daily;
    daily.streak = ppnLiveStreak(daily, today.day);
    daily.key = today.key;
    daily.day = today.day;
    daily.status = 'playing';
    daily.time = 0;
    daily.game = ppnFreshGame(ppnDailyBoard(today.key), null, false);
  }

  // Today's Daily: takes over what another tab stored since, then resumes
  // the attempt of today or shows its result, or begins a new one, written
  // the moment it begins (yesterday's attempt is left as it was).
  function ppnOpenDaily() {
    var today = ppnDayInfo(new Date());
    ppnPauseClock();
    ppnSyncDaily();
    if (ppnState.daily.key !== today.key) {
      ppnBeginDaily(today);
      ppnSaveDaily();
    }
    ppnShowView('daily');
  }

  function ppnToggleDaily() {
    if (ppnState.view === 'daily') {
      ppnStopActive();
      ppnShowView('free');
    } else {
      ppnOpenDaily();
    }
  }

  function ppnFinishDaily(game) {
    var daily = ppnState.daily;
    daily.status = 'won';
    daily.time = Math.floor(game.elapsed / 1000);
    daily.streak = daily.lastWon === daily.day - 1 ? daily.streak + 1 : 1;
    daily.lastWon = daily.day;
  }

  function ppnWin(game) {
    ppnPauseClock();
    if (ppnState.view === 'daily') {
      ppnFinishDaily(game);
    }
    var record = game.practice === null && !game.replay && ppnRecordBest(game);
    ppnShowToast('All ' + game.n * game.n + ' ports up' + (record ? ': new best!' : '.'));
  }

  // Before a turn or a lock on the Daily: whether another tab's record was
  // taken over instead, so the tap (made on the old board) does nothing.
  function ppnStaleDaily() {
    return ppnState.view === 'daily' && ppnSyncDaily();
  }

  // Turns tile index by step quarter turns (1 clockwise, -1 back).
  function ppnRotate(index, step) {
    if (ppnStaleDaily()) {
      return;
    }
    var game = ppnActive();
    if (game.solved) {
      return;
    }
    if (game.locks[index]) {
      ppnShowToast(ppnCellName(index, game.n) + ' is locked: unlock it with L, a right-click or Lock mode.');
      return;
    }
    game.turns[index] = (game.turns[index] + step + 4) % 4;
    ppnRuntime.angles[index] += step;
    game.moves++;
    ppnStartClock();
    game.solved = ppnIsSolved(ppnCurrent(game.masks, game.turns), game.n, game.wrap);
    if (game.solved) {
      ppnWin(game);
    }
    ppnRender();
    ppnSaveActive();
  }

  function ppnToggleLock(index) {
    if (ppnStaleDaily()) {
      return;
    }
    var game = ppnActive();
    if (game.solved) {
      return;
    }
    game.locks[index] = 1 - game.locks[index];
    ppnRender();
    ppnSaveActive();
  }

  function ppnMoveCursor(d) {
    var game = ppnActive();
    var next = ppnNeighbour(ppnRuntime.cursor, d, game.n, game.wrap);
    if (next !== -1) {
      ppnRuntime.cursor = next;
    }
    ppnRender();
  }

  function ppnToggleLockMode() {
    ppnRuntime.lockMode = !ppnRuntime.lockMode;
    ppnRender();
  }

  // Shows the share text selected in its read-only field, for copying by
  // hand when the clipboard is missing or refuses.
  function ppnShowShareField(text) {
    var field = ppnRuntime.els.shareText;
    field.value = text;
    field.classList.remove('ppn-hidden');
    field.focus();
    field.select();
    ppnShowToast('The clipboard is not available: copy the selected result below.');
  }

  function ppnShare() {
    var daily = ppnState.daily;
    var game = daily.game;
    var text = ppnShareText(daily.day, game.n, daily.time, game.moves, ppnTargetOf(game.masks, game.start));
    var clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text).then(function () {
        ppnShowToast('Copied: ' + text);
      }, function () {
        ppnShowShareField(text);
      });
    } else {
      ppnShowShareField(text);
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // 'up' / 'down' / 'left' / 'right' / 'rotate' / 'back' / 'lock' / 'new'
  // for a keydown, or null.  A keydown without a key (Chrome autofill sends
  // those) is null.
  function ppnKeyAction(event) {
    if (typeof event.key !== 'string') {
      return null;
    }
    var key = event.key.toLowerCase();
    if (ppnHasOwn(PPN_KEYS, key)) {
      return PPN_KEYS[key];
    }
    return ppnHasOwn(PPN_CODES, event.code) ? PPN_CODES[event.code] : null;
  }

  // Keys reach this listener only while the board (or a tile in it) has the
  // focus.  A held key repeats only the cursor moves.
  function ppnHandleKeydown(event) {
    var action = ppnKeyAction(event);
    if (!action || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    ppnRuntime.keys = true;
    if (ppnHasOwn(PPN_MOVES, action)) {
      ppnMoveCursor(PPN_MOVES[action]);
    } else if (event.repeat) {
      return;
    } else if (action === 'rotate') {
      ppnRotate(ppnRuntime.cursor, 1);
    } else if (action === 'back') {
      ppnRotate(ppnRuntime.cursor, -1);
    } else if (action === 'lock') {
      ppnToggleLock(ppnRuntime.cursor);
    } else {
      ppnNewGameFromConfig();
    }
  }

  // The tile an event on the board came from, which also takes the cursor,
  // or -1 for the board's own padding and gaps.
  function ppnPointedTile(event) {
    var tile = event.target.closest('.ppn-tile');
    if (!tile) {
      return -1;
    }
    var index = Number(tile.getAttribute('data-index'));
    ppnRuntime.keys = false;
    ppnRuntime.cursor = index;
    return index;
  }

  // A tap or a click turns the tile clockwise, or locks it in Lock mode.
  function ppnHandleClick(event) {
    var index = ppnPointedTile(event);
    if (index === -1) {
      return;
    }
    if (ppnRuntime.lockMode) {
      ppnToggleLock(index);
    } else {
      ppnRotate(index, 1);
    }
  }

  // Remembers whether the latest press on the board was a finger (Android
  // sends a contextmenu after a long press, which must lock nothing).
  function ppnHandlePointerDown(event) {
    ppnRuntime.touch = event.pointerType === 'touch';
  }

  // A right-click (mouse or pen) locks or unlocks the tile instead of
  // opening the menu; a long press of a finger only keeps the menu away.
  function ppnHandleContextMenu(event) {
    var index = ppnPointedTile(event);
    if (index === -1) {
      return;
    }
    event.preventDefault();
    if (!ppnRuntime.touch) {
      ppnToggleLock(index);
    }
  }

  // A hidden tab stops a running clock and saves its game (nothing else:
  // a tab merely hidden writes nothing).  Shown again, the clock runs on if
  // it ran when the tab was hidden, and the Daily's whenever it is live.
  function ppnHandleVisibility() {
    if (document.hidden) {
      ppnRuntime.resumeOnShow = ppnRuntime.since !== null;
      if (ppnRuntime.resumeOnShow) {
        ppnPauseClock();
        ppnSaveActive();
      }
      return;
    }
    var resume = ppnRuntime.resumeOnShow || ppnDailyLive();
    ppnRuntime.resumeOnShow = false;
    if (resume) {
      ppnStartClock();
      ppnRender();
    }
  }

  // Another tab wrote to storage: its Daily record is taken over at once
  // when it has to win over this tab's.
  function ppnHandleStorage(event) {
    if (event.key === PPN_DAILY_KEY) {
      ppnSyncDaily();
    }
  }

  function ppnBindEvents() {
    var els = ppnRuntime.els;
    els.board.addEventListener('pointerdown', ppnHandlePointerDown);
    els.board.addEventListener('click', ppnHandleClick);
    els.board.addEventListener('contextmenu', ppnHandleContextMenu);
    els.board.addEventListener('keydown', ppnHandleKeydown);
    els.newGame.addEventListener('click', ppnNewGameFromConfig);
    els.restart.addEventListener('click', ppnRestart);
    els.config.addEventListener('change', ppnNewGameFromConfig);
    els.dailyButton.addEventListener('click', ppnToggleDaily);
    els.lockMode.addEventListener('click', ppnToggleLockMode);
    els.shareButton.addEventListener('click', ppnShare);
    els.next.addEventListener('click', ppnClimb);
    document.addEventListener('visibilitychange', ppnHandleVisibility);
    window.addEventListener('storage', ppnHandleStorage);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function ppnFindElements() {
    return {
      board: document.getElementById('ppn-board'),
      newGame: document.getElementById('ppn-new-game'),
      restart: document.getElementById('ppn-restart'),
      config: document.getElementById('ppn-config'),
      dailyButton: document.getElementById('ppn-daily-button'),
      lockMode: document.getElementById('ppn-lock-mode'),
      mode: document.getElementById('ppn-mode'),
      ports: document.getElementById('ppn-ports'),
      moves: document.getElementById('ppn-moves'),
      target: document.getElementById('ppn-target'),
      time: document.getElementById('ppn-time'),
      best: document.getElementById('ppn-best'),
      streak: document.getElementById('ppn-streak'),
      status: document.getElementById('ppn-status'),
      hint: document.getElementById('ppn-hint'),
      wrapNote: document.getElementById('ppn-wrap-note'),
      next: document.getElementById('ppn-next'),
      warning: document.getElementById('ppn-warning'),
      share: document.getElementById('ppn-share'),
      shareButton: document.getElementById('ppn-share-button'),
      shareText: document.getElementById('ppn-share-text'),
      toast: document.getElementById('ppn-toast')
    };
  }

  // Finds the elements, binds the controls once and restores the saves: the
  // free-play game (or a new 5x5 one) and, when the Daily was on screen,
  // today's Daily.
  function ppnInit() {
    if (ppnRuntime.els) {
      return;
    }
    ppnRuntime.els = ppnFindElements();
    ppnBindEvents();
    ppnState.best = ppnParseBest(ppnStorageGet(PPN_BEST_KEY));
    ppnRuntime.dailyText = ppnStorageGet(PPN_DAILY_KEY);
    ppnState.daily = ppnParseDaily(ppnRuntime.dailyText);
    var saved = ppnParseState(ppnStorageGet(PPN_STATE_KEY));
    ppnState.free = saved.game || ppnFreshGame(ppnGenerate(saved.n, Math.random, saved.wrap), null, false);
    if (saved.view === 'daily') {
      ppnOpenDaily();
    } else {
      ppnShowView('free');
    }
  }

  // Node (tests): export only, no init and no timers.  Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ppnState: ppnState,
      ppnRuntime: ppnRuntime,
      ppnInit: ppnInit,
      ppnRotateMask: ppnRotateMask,
      ppnLinkCount: ppnLinkCount,
      ppnPeriod: ppnPeriod,
      ppnCenter: ppnCenter,
      ppnNeighbour: ppnNeighbour,
      ppnCurrent: ppnCurrent,
      ppnUplinks: ppnUplinks,
      ppnConnectedSet: ppnConnectedSet,
      ppnOpenEnds: ppnOpenEnds,
      ppnLoopCells: ppnLoopCells,
      ppnHasLoop: ppnHasLoop,
      ppnIsSolved: ppnIsSolved,
      ppnGenerate: ppnGenerate,
      ppnTargetOf: ppnTargetOf,
      ppnShape: ppnShape,
      ppnCellName: ppnCellName,
      ppnWrapCrossings: ppnWrapCrossings,
      ppnCrossingLook: ppnCrossingLook,
      ppnWrapTwins: ppnWrapTwins,
      ppnWrapHint: ppnWrapHint,
      ppnHash: ppnHash,
      ppnMulberry32: ppnMulberry32,
      ppnDayInfo: ppnDayInfo,
      ppnKeyDay: ppnKeyDay,
      ppnDailyBoard: ppnDailyBoard,
      ppnLiveStreak: ppnLiveStreak,
      ppnFormatTime: ppnFormatTime,
      ppnShareText: ppnShareText,
      ppnIsNewerDaily: ppnIsNewerDaily,
      ppnMergeBest: ppnMergeBest,
      ppnConfigOf: ppnConfigOf,
      ppnNextRung: ppnNextRung,
      ppnKeyAction: ppnKeyAction,
      ppnParseState: ppnParseState,
      ppnParseDaily: ppnParseDaily,
      ppnParseBest: ppnParseBest
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ppnInit);
  } else {
    ppnInit();
  }
})();
