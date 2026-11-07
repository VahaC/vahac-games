// Defrag — script.js
// Prefix: dfg-
// Dependencies: none.
//
// A disk of 6 to 9 tracks (columns) holds the blocks of 4 to 8 files, mixed
// up: .log, .iso, .db ...  Tap a track, then another: the top fragment of the
// first (every block of the same file on top of it, never the fixed block
// under them) moves onto the second when the second is empty or ends with
// the same file, has room for the whole fragment, and is not reserved for
// another file.  The disk is defragmented when every file lies in one
// unbroken run.  The score is the fragmentation: the fragments still to
// merge as a share of the most a disk of these files can have
// (dfgFragmentation), shown as "fragmentation 63% → 0%".
//
// Twists: files have different sizes (2 to 5 blocks on 4- or 5-block
// tracks), and from level 5 a system file (boot.sys, swap.sys) has a fixed
// block at the bottom of its own track: that block never moves, and the
// track takes no other file.
//
// Boards: dfgGenerate starts from the defragmented disk (every file on its
// own track, the free tracks empty) and makes legal reverse moves
// (dfgReverseMoves: every one undoes a move dfgMoveError allows, exactly),
// so every board can be solved.  A board is kept only when the solver
// (dfgIda, an iterative-deepening search with a node cap, memoised on
// canonical states) proves it needs at least the level's minimum number of
// moves; after DFG_GEN_TRIES boards the hardest one found is kept.  Par is
// the shortest route the solver finds within its cap, or the reversed
// scramble when that is shorter: an upper bound, shown as "par ≤ 14".
//
// Solver: dfgIda finds the shortest route while its node cap lasts; the
// number of fragments still to merge is a lower bound on the moves left (a
// move merges at most two runs), which guides it.  When the cap runs out
// dfgExplore, a depth-first search over every reachable state, finds some
// route or proves there is none.  The hint (H) shows the first move of the
// solver's route (asked again on the same disk, it is not counted again);
// after every move dfgDeadEndText runs dfgExplore with a smaller cap and
// warns of a dead end, naming how many moves to undo.
//
// Levels: numbered 1 to 999, each seeded from its number (FNV-1a of
// "dfg:level:<n>" through mulberry32, never Math.random), so a level is the
// same board for everyone.  The next level opens once the one before is
// defragmented.  Leaving a level with moves made (Prev, Next, N) takes a
// second press within 3 s, like Restart: the level starts over later.
//
// Daily: one board a day for everyone, seeded with FNV-1a of
// "dfg:YYYY-MM-DD" (the local date) through mulberry32.  Daily #1 is
// 2026-11-01, counted in UTC days so a daylight saving change never skips
// one.  The attempt is written to dfg-daily the moment it begins; a reload
// resumes it or shows its result, and it is scored once.  A defragmented
// Daily can be replayed as an unscored practice run (not saved).  A Daily
// left open across midnight finishes as the day it started.  Streak =
// consecutive Daily numbers defragmented.  Share copies one line of text, or
// shows it selected when the clipboard is unavailable.  The result names the
// undos and hints besides the moves (the move count is net of undos).
//
// Keys: only while the focus is inside the game (never in its result
// field): 1-9 pick tracks, U undo, H hint, R restart (twice within 3 s when
// moves would be lost), N next level, Escape puts a picked fragment back.
// Ctrl / Alt / Cmd combinations and held keys are left alone.  A mouse click
// or tap on a game button moves the focus to the disk, so Space scrolls the
// page instead of clicking the button again.
//
// Saves: dfg-state (the level game and the view on screen), dfg-progress
// (the highest level defragmented and the fewest moves per level),
// dfg-daily (the Daily attempt, its result and the streak).  Every field is
// checked on load and falls back on its own; storage that is blocked or full
// never stops the game and a warning names the keys that are not saved.
//
// Tabs: dfg-progress is read again and merged before every write, so no tab
// erases another's best.  dfg-daily is read again before every write: a
// record another tab saved since that is a later Daily (up to today), the
// same Daily defragmented, or the same attempt further along is taken over
// instead of overwritten, at once through the storage event too.  dfg-state
// is read again the same way: another tab's game of the same level that is
// further along is taken over (a game of another level is the level that
// tab chose last, and is written over).
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser dfgInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var DFG_STATE_KEY = 'dfg-state';
  var DFG_PROGRESS_KEY = 'dfg-progress';
  var DFG_DAILY_KEY = 'dfg-daily';
  var DFG_SAVE_VERSION = 1;

  var DFG_MAX_LEVEL = 999;
  var DFG_HISTORY_MAX = 500;
  var DFG_GEN_TRIES = 24;
  var DFG_MAX_BOUND = 200;
  var DFG_UNDO_LOOKBACK = 20;
  var DFG_CACHE_MAX = 40;
  var DFG_CONFIRM_MS = 3000;
  var DFG_TOAST_MS = 2200;

  // Node caps of the searches: the shortest-route search, the full search
  // after it, and the dead-end check after every move.
  var DFG_LIMITS = { solve: 20000, search: 8000, check: 2500 };

  var DFG_EPOCH = Date.UTC(2026, 10, 1);
  var DFG_DAY_MS = 86400000;

  // The regular files a level draws from, and the system files whose first
  // block is fixed at the bottom of their own track.
  var DFG_TYPES = [
    { ext: 'log', name: 'syslog.log' },
    { ext: 'iso', name: 'debian.iso' },
    { ext: 'db', name: 'users.db' },
    { ext: 'jpg', name: 'photo.jpg' },
    { ext: 'txt', name: 'notes.txt' },
    { ext: 'tar', name: 'backup.tar' },
    { ext: 'mp4', name: 'demo.mp4' },
    { ext: 'cfg', name: 'nginx.cfg' }
  ];
  var DFG_SYSTEM_TYPES = [
    { ext: 'boot', name: 'boot.sys' },
    { ext: 'swap', name: 'swap.sys' }
  ];

  // Levels 1-12, then the last four rows in turn: [files, free tracks, blocks
  // a track, mixed sizes (1) or all full (0), system files, minimum moves,
  // reverse moves of the scramble].  Files + free tracks never pass 9.
  var DFG_TIERS = [
    [4, 2, 4, 0, 0, 5, 24],
    [4, 2, 4, 0, 0, 6, 32],
    [4, 2, 4, 1, 0, 6, 32],
    [5, 2, 4, 0, 0, 8, 40],
    [5, 2, 4, 1, 1, 8, 40],
    [5, 2, 5, 1, 1, 9, 44],
    [6, 2, 4, 0, 0, 10, 48],
    [6, 2, 5, 1, 1, 11, 52],
    [6, 2, 5, 1, 2, 11, 56],
    [7, 2, 4, 1, 1, 11, 60],
    [7, 2, 5, 1, 1, 13, 64],
    [7, 2, 5, 1, 2, 13, 64]
  ];
  var DFG_LATE = [
    [7, 2, 5, 1, 2, 14, 70],
    [8, 1, 5, 1, 1, 14, 70],
    [7, 2, 5, 1, 1, 14, 72],
    [8, 1, 5, 1, 2, 14, 76]
  ];
  var DFG_DAILY_TIER = [6, 2, 5, 1, 1, 12, 56];

  // Keys by KeyboardEvent.key (lower-cased), then by the physical key for
  // layouts whose letters are not Latin; the digits also by code (AZERTY
  // types them with Shift, the keypad has codes of its own).
  var DFG_KEYS = { u: 'undo', h: 'hint', r: 'restart', n: 'next', escape: 'cancel' };
  var DFG_CODES = { KeyU: 'undo', KeyH: 'hint', KeyR: 'restart', KeyN: 'next' };

  // ── State ─────────────────────────────────────────────────────────────────

  // view: 'level' or 'daily', the disk on screen.  level: the level game.
  // daily: the Daily record (dfgParseDaily).  practice: an unscored replay
  // of a defragmented Daily (never saved).  progress: dfgParseProgress.
  // A game is { kind: 'level' / 'daily' / 'practice', id (the level number
  // or the Daily key), board, tracks, history, moves, undos, hints, solved }:
  // tracks are the blocks of every track, bottom first, as file indexes;
  // history the moves made, [from, to, blocks], for undo.
  var dfgState = {
    view: 'level',
    level: null,
    daily: null,
    practice: null,
    progress: null
  };

  // Page handles, never saved.  selected: the track whose top fragment is
  // picked up (-1 for none).  hint: the move the last hint showed.  note:
  // the hint or dead-end line under the disk.  failed: storage keys that
  // could not be read or written, with the error name.  dailyText: the
  // dfg-daily text this tab last read or wrote.  stateText: the dfg-state
  // text this tab last wrote or already compared with its own game.
  // confirmAction, confirmUntil: the action ('restart', 'level5') a second
  // press of which until then throws the moves away.
  var dfgRuntime = {
    els: null,
    selected: -1,
    hint: null,
    note: '',
    noteKind: '',
    failed: {},
    toastTimeout: null,
    dailyText: null,
    stateText: null,
    confirmAction: '',
    confirmUntil: 0
  };

  var dfgBoardCache = {};
  var dfgBoardCacheSize = 0;

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function dfgHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function dfgPlural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  function dfgPad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function dfgCopyTracks(tracks) {
    return tracks.map(function (track) {
      return track.slice();
    });
  }

  function dfgSameTracks(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // A copy of list in an order drawn with rnd (Fisher-Yates).
  function dfgShuffle(list, rnd) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var keep = out[i];
      out[i] = out[j];
      out[j] = keep;
    }
    return out;
  }

  // ── Levels (no DOM) ───────────────────────────────────────────────────────

  function dfgConfigOf(row) {
    return {
      files: row[0],
      free: row[1],
      capacity: row[2],
      mixed: row[3] === 1,
      system: row[4],
      minMoves: row[5],
      scramble: row[6]
    };
  }

  // The make-up of a numbered level (1 to DFG_MAX_LEVEL).
  function dfgLevelConfig(level) {
    if (level <= DFG_TIERS.length) {
      return dfgConfigOf(DFG_TIERS[level - 1]);
    }
    return dfgConfigOf(DFG_LATE[(level - DFG_TIERS.length - 1) % DFG_LATE.length]);
  }

  function dfgDailyConfig() {
    return dfgConfigOf(DFG_DAILY_TIER);
  }

  // The files of a board: the system files first, then regular ones in an
  // order drawn with rnd.  Mixed sizes run from two blocks under the track
  // size up to it, and are never all the same.
  function dfgMakeFiles(config, rnd) {
    var regular = dfgShuffle(DFG_TYPES, rnd);
    var files = [];
    for (var i = 0; i < config.files; i++) {
      var system = i < config.system;
      var type = system ? DFG_SYSTEM_TYPES[i] : regular[i - config.system];
      var size = config.mixed ? config.capacity - Math.floor(rnd() * 3) : config.capacity;
      files.push({ ext: type.ext, name: type.name, size: size, system: system });
    }
    var last = files[files.length - 1];
    var same = files.every(function (file) {
      return file.size === files[0].size;
    });
    if (config.mixed && same) {
      last.size += last.size === config.capacity ? -1 : 1;
    }
    return files;
  }

  // The defragmented disk: file i alone on track i, the free tracks empty,
  // and every system file's track reserved for it (sys holds the file of
  // each track's fixed block, -1 for none).
  function dfgSolvedLayout(files, config) {
    var tracks = [];
    var sys = [];
    for (var t = 0; t < config.files + config.free; t++) {
      var track = [];
      var file = files[t];
      for (var k = 0; file && k < file.size; k++) {
        track.push(t);
      }
      tracks.push(track);
      sys.push(file && file.system ? t : -1);
    }
    return { tracks: tracks, sys: sys };
  }

  // ── Moves (no DOM) ────────────────────────────────────────────────────────
  //
  // A board is { files, sys, capacity, start, goal, steps, least, par }:
  // only files, sys and capacity matter to the rules.  tracks[t] lists the
  // blocks of track t, bottom first, by file index.

  function dfgTop(track) {
    return track.length ? track[track.length - 1] : -1;
  }

  // How many blocks of the top fragment of track t can move: the run of one
  // file on top, the fixed block of a reserved track never included.
  function dfgTopRun(board, tracks, t) {
    var track = tracks[t];
    var low = board.sys[t] >= 0 ? 1 : 0;
    var count = 0;
    for (var i = track.length - 1; i >= low && track[i] === track[track.length - 1]; i--) {
      count++;
    }
    return count;
  }

  // Why the top fragment of track a cannot move onto track b, as { code,
  // a, b, file, count, other, room }, or null when it can.
  function dfgMoveError(board, tracks, a, b) {
    if (a === b) {
      return { code: 'same', a: a };
    }
    var count = dfgTopRun(board, tracks, a);
    if (!count) {
      return { code: tracks[a].length ? 'fixed' : 'empty', a: a, file: dfgTop(tracks[a]) };
    }
    var file = dfgTop(tracks[a]);
    var target = tracks[b];
    var error = { a: a, b: b, file: file, count: count };
    if (board.sys[b] >= 0 && board.sys[b] !== file) {
      error.code = 'reserved';
      error.other = board.sys[b];
    } else if (target.length && dfgTop(target) !== file) {
      error.code = 'top';
      error.other = dfgTop(target);
    } else if (target.length + count > board.capacity) {
      error.code = 'room';
      error.room = board.capacity - target.length;
    } else {
      return null;
    }
    return error;
  }

  // The tracks after count blocks moved from the top of a onto b.
  function dfgApplyMove(tracks, a, b, count) {
    var out = dfgCopyTracks(tracks);
    var moved = out[a].splice(out[a].length - count, count);
    out[b] = out[b].concat(moved);
    return out;
  }

  // Every legal move [from, to, blocks].
  function dfgLegalMoves(board, tracks) {
    var out = [];
    for (var a = 0; a < tracks.length; a++) {
      for (var b = 0; b < tracks.length; b++) {
        if (!dfgMoveError(board, tracks, a, b)) {
          out.push([a, b, dfgTopRun(board, tracks, a)]);
        }
      }
    }
    return out;
  }

  // Every reverse move [b, a, blocks]: taking that many blocks off the top
  // of b and putting them on a gives a state from which the move of exactly
  // those blocks from a back onto b is legal.  So b must take them back (its
  // reserved file, and under them nothing, the same file or b's own fixed
  // block of it), and on a they must be the whole top fragment (a's own top
  // is another file, a fixed block or nothing) and fit.
  function dfgReverseMoves(board, tracks) {
    var out = [];
    for (var b = 0; b < tracks.length; b++) {
      var run = dfgTopRun(board, tracks, b);
      var file = dfgTop(tracks[b]);
      if (!run || (board.sys[b] >= 0 && board.sys[b] !== file)) {
        continue;
      }
      for (var count = 1; count <= run; count++) {
        var rest = tracks[b].length - count;
        if (count === run && rest > 0 && tracks[b][rest - 1] !== file) {
          continue;
        }
        for (var a = 0; a < tracks.length; a++) {
          var merges = dfgTopRun(board, tracks, a) > 0 && dfgTop(tracks[a]) === file;
          if (a !== b && !merges && tracks[a].length + count <= board.capacity) {
            out.push([b, a, count]);
          }
        }
      }
    }
    return out;
  }

  // How many runs of one file the tracks hold, all files together.
  function dfgRunCount(tracks) {
    var runs = 0;
    tracks.forEach(function (track) {
      for (var i = 0; i < track.length; i++) {
        if (i === 0 || track[i] !== track[i - 1]) {
          runs++;
        }
      }
    });
    return runs;
  }

  // Fragments still to merge: runs beyond one per file.  A move merges at
  // most two runs, so this is a lower bound on the moves left.
  function dfgExtra(board, tracks) {
    return dfgRunCount(tracks) - board.files.length;
  }

  function dfgIsSolved(board, tracks) {
    return dfgExtra(board, tracks) === 0;
  }

  // The fragmentation in whole percent, rounded up so only a defragmented
  // disk shows 0%: the fragments to merge as a share of the most these files
  // can have (every block a run of its own).
  function dfgFragmentation(board, tracks) {
    var most = 0;
    board.files.forEach(function (file) {
      most += file.size - 1;
    });
    return Math.ceil(100 * dfgExtra(board, tracks) / most);
  }

  // A state key that equal states share: the reserved tracks in place, the
  // others sorted (any two of them can swap places).
  function dfgKey(board, tracks) {
    var fixed = [];
    var loose = [];
    tracks.forEach(function (track, t) {
      var text = String.fromCharCode.apply(null, track.map(function (file) {
        return 97 + file;
      }));
      (board.sys[t] >= 0 ? fixed : loose).push(text);
    });
    loose.sort();
    return fixed.join('|') + '#' + loose.join('|');
  }

  // The moves the solver tries from tracks, each with the tracks after it
  // and the fragments left, fewest first.  Moves that change nothing but the
  // order of the tracks are left out: onto any empty track but the first,
  // and a whole track's single fragment onto an empty one.
  function dfgChildren(board, tracks) {
    var firstEmpty = -1;
    for (var e = tracks.length - 1; e >= 0; e--) {
      if (!tracks[e].length) {
        firstEmpty = e;
      }
    }
    var out = [];
    dfgLegalMoves(board, tracks).forEach(function (move) {
      var whole = move[2] === tracks[move[0]].length;
      if (!tracks[move[1]].length && (move[1] !== firstEmpty || whole)) {
        return;
      }
      var next = dfgApplyMove(tracks, move[0], move[1], move[2]);
      out.push({ move: move, tracks: next, h: dfgExtra(board, next), order: out.length });
    });
    out.sort(function (x, y) {
      return x.h - y.h || x.order - y.order;
    });
    return out;
  }

  // ── Solver (no DOM) ───────────────────────────────────────────────────────

  // The shortest route from tracks, by iterative deepening on the fragments
  // left (an admissible bound), memoised on dfgKey within each pass, with at
  // most cap nodes and routes of at most maxBound moves.  Status 'solved'
  // with path (the moves, shortest), 'dead' (no route at all), 'beyond' (no
  // route of maxBound moves or fewer; lower is the next bound) or 'unknown'
  // (the cap ran out; every route needs at least lower moves).
  function dfgIda(board, tracks, cap, maxBound) {
    var nodes = 0;
    var path = [];
    var seen = {};
    var aborted = false;
    function search(cur, g, bound) {
      nodes++;
      if (nodes > cap) {
        aborted = true;
        return 0;
      }
      var h = dfgExtra(board, cur);
      if (h === 0) {
        return 0;
      }
      if (g + h > bound) {
        return g + h;
      }
      var key = dfgKey(board, cur);
      if (dfgHasOwn(seen, key) && seen[key] <= g) {
        return Infinity;
      }
      seen[key] = g;
      var next = Infinity;
      var children = dfgChildren(board, cur);
      for (var i = 0; i < children.length; i++) {
        path.push(children[i].move);
        var found = search(children[i].tracks, g + 1, bound);
        if (found === 0) {
          return 0;
        }
        path.pop();
        next = Math.min(next, found);
      }
      return next;
    }
    var bound = dfgExtra(board, tracks);
    while (bound <= maxBound) {
      seen = {};
      var result = search(tracks, 0, bound);
      if (aborted) {
        return { status: 'unknown', lower: bound, nodes: cap };
      }
      if (result === 0) {
        return { status: 'solved', path: path, nodes: nodes };
      }
      if (result === Infinity) {
        return { status: 'dead', nodes: nodes };
      }
      bound = result;
    }
    return { status: 'beyond', lower: bound, nodes: nodes };
  }

  // The moves from the start to a node of dfgExplore.
  function dfgPathOf(node) {
    var moves = [];
    for (var at = node; at.parent; at = at.parent) {
      moves.unshift(at.move);
    }
    return moves;
  }

  // A depth-first search over every state reachable from tracks, fewest
  // fragments first, each state once, at most cap states: status 'solved'
  // with a path (a route, not always the shortest), 'dead' (no state that
  // can be reached is defragmented) or 'unknown' (the cap ran out); nodes is
  // how many states it looked at.
  function dfgExplore(board, tracks, cap) {
    var seen = {};
    var stack = [{ tracks: tracks, parent: null, move: null }];
    var nodes = 0;
    while (stack.length) {
      var node = stack.pop();
      var key = dfgKey(board, node.tracks);
      if (!dfgHasOwn(seen, key)) {
        seen[key] = true;
        nodes++;
        if (nodes > cap) {
          return { status: 'unknown', nodes: cap };
        }
        if (dfgIsSolved(board, node.tracks)) {
          return { status: 'solved', path: dfgPathOf(node), nodes: nodes };
        }
        var children = dfgChildren(board, node.tracks);
        for (var i = children.length - 1; i >= 0; i--) {
          stack.push({ tracks: children[i].tracks, parent: node, move: children[i].move });
        }
      }
    }
    return { status: 'dead', nodes: nodes };
  }

  // The solver behind the hint: the shortest route while the cap of dfgIda
  // lasts, else any route dfgExplore finds.  { status, path, optimal, nodes }:
  // nodes counts the states both searches looked at.
  function dfgSolve(board, tracks, limits) {
    var ida = dfgIda(board, tracks, limits.solve, DFG_MAX_BOUND);
    if (ida.status === 'solved' || ida.status === 'dead') {
      return { status: ida.status, path: ida.path || null, optimal: ida.status === 'solved', nodes: ida.nodes };
    }
    var dfs = dfgExplore(board, tracks, limits.search);
    return { status: dfs.status, path: dfs.path || null, optimal: false, nodes: ida.nodes + dfs.nodes };
  }

  // ── Boards (no DOM) ───────────────────────────────────────────────────────

  // steps reverse moves drawn with rnd from tracks, never straight back
  // along the one before.  { tracks, moves }.
  function dfgScramble(board, tracks, steps, rnd) {
    var moves = [];
    var last = null;
    for (var s = 0; s < steps; s++) {
      var options = dfgReverseMoves(board, tracks).filter(function (m) {
        return !last || m[0] !== last[1] || m[1] !== last[0] || m[2] !== last[2];
      });
      if (!options.length) {
        break;
      }
      last = options[Math.floor(rnd() * options.length)];
      tracks = dfgApplyMove(tracks, last[0], last[1], last[2]);
      moves.push(last);
    }
    return { tracks: tracks, moves: moves };
  }

  // A board for config drawn with rnd: { files, sys, capacity, start, goal,
  // steps, least, par }.  start: the scrambled tracks, goal: the
  // defragmented layout they came from (in the same track order), steps:
  // the reverse moves made, least: the fewest moves the solver proved a
  // route needs, par: the shortest route known (the solver's or the
  // reversed scramble), an upper bound.
  // One try of dfgGenerate: new files, scrambled, the tracks in an order
  // drawn with rnd.
  function dfgDrawBoard(config, rnd) {
    var files = dfgMakeFiles(config, rnd);
    var layout = dfgSolvedLayout(files, config);
    var mixed = dfgScramble({ files: files, sys: layout.sys, capacity: config.capacity }, layout.tracks, config.scramble, rnd);
    var order = dfgShuffle(layout.tracks.map(function (track, t) {
      return t;
    }), rnd);
    return {
      files: files,
      sys: order.map(function (t) { return layout.sys[t]; }),
      capacity: config.capacity,
      start: order.map(function (t) { return mixed.tracks[t]; }),
      goal: order.map(function (t) { return layout.tracks[t]; }),
      steps: mixed.moves.length
    };
  }

  function dfgGenerate(config, rnd, limits) {
    limits = limits || DFG_LIMITS;
    var best = null;
    for (var tries = 0; tries < DFG_GEN_TRIES; tries++) {
      var board = dfgDrawBoard(config, rnd);
      var check = dfgIda(board, board.start, limits.solve, config.minMoves - 1);
      board.least = check.status === 'solved' ? check.path.length : check.lower;
      if (!best || board.least > best.least) {
        best = board;
      }
      if (check.status === 'beyond') {
        break;
      }
    }
    var route = dfgSolve(best, best.start, limits);
    best.par = route.path && route.path.length < best.steps ? route.path.length : best.steps;
    return best;
  }

  // ── Daily (no DOM) ────────────────────────────────────────────────────────

  // FNV-1a, 32 bit, over the UTF-16 code units of text.
  function dfgHash(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // mulberry32: a seeded generator of numbers in [0, 1).
  function dfgMulberry32(seed) {
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
  function dfgDayNumber(year, month, date) {
    return (Date.UTC(year, month, date) - DFG_EPOCH) / DFG_DAY_MS + 1;
  }

  // The local calendar date of now as { key: 'YYYY-MM-DD', day }.
  function dfgDayInfo(now) {
    var year = now.getFullYear();
    var month = now.getMonth();
    var date = now.getDate();
    return {
      key: year + '-' + dfgPad2(month + 1) + '-' + dfgPad2(date),
      day: dfgDayNumber(year, month, date)
    };
  }

  // The Daily number of a 'YYYY-MM-DD' key, or null when it is not a real
  // date in that form.
  function dfgKeyDay(key) {
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
    return dfgDayNumber(year, month, date);
  }

  // A board from the cache, or made once by make.
  function dfgCachedBoard(seedText, make) {
    if (!dfgHasOwn(dfgBoardCache, seedText)) {
      if (dfgBoardCacheSize >= DFG_CACHE_MAX) {
        dfgBoardCache = {};
        dfgBoardCacheSize = 0;
      }
      dfgBoardCache[seedText] = make(dfgMulberry32(dfgHash(seedText)));
      dfgBoardCacheSize++;
    }
    return dfgBoardCache[seedText];
  }

  function dfgLevelBoard(level) {
    return dfgCachedBoard('dfg:level:' + level, function (rnd) {
      return dfgGenerate(dfgLevelConfig(level), rnd);
    });
  }

  function dfgDailyBoard(key) {
    return dfgCachedBoard('dfg:' + key, function (rnd) {
      return dfgGenerate(dfgDailyConfig(), rnd);
    });
  }

  // The streak as of Daily number today: kept while the last win is today's
  // or yesterday's, 0 once a day was missed.
  function dfgLiveStreak(daily, today) {
    var gap = today - daily.lastWon;
    return daily.lastWon !== null && (gap === 0 || gap === 1) ? daily.streak : 0;
  }

  // ', 3 undos, 1 hint' for the help a game took, each part only when used.
  function dfgHelpText(game) {
    return (game.undos ? ', ' + dfgPlural(game.undos, 'undo') : '') + (game.hints ? ', ' + dfgPlural(game.hints, 'hint') : '');
  }

  // The share line of a defragmented Daily: the moves are net of undos, so
  // the undos are named too.
  function dfgShareText(day, startFrag, game, par) {
    return 'Defrag #' + day + ' fragmentation ' + startFrag + '% → 0% in ' + dfgPlural(game.moves, 'move') +
      ' (par ≤ ' + par + ')' + dfgHelpText(game);
  }

  // Actions taken on a game: every move, every undo (a move less, an undo
  // more) and every hint adds one, so of two records of one game the one
  // with more is further along.
  function dfgSteps(game) {
    return game.moves + 2 * game.undos + game.hints;
  }

  // Whether a Daily record another tab stored has to win over this tab's
  // (both as dfgParseDaily gives them): a later Daily, the same Daily
  // defragmented while ours is not, or the same attempt further along.  A
  // record from after today (a clock set back) never wins.
  function dfgIsNewerDaily(stored, ours, today) {
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
    return dfgSteps(stored.game) > dfgSteps(ours.game);
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function dfgParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function dfgIsObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function dfgIsInteger(value) {
    return typeof value === 'number' && value % 1 === 0;
  }

  function dfgIsCount(value) {
    return dfgIsInteger(value) && value >= 0;
  }

  // A copy of value when it is the tracks of a state of board: as many
  // tracks, each within the track size, every file's blocks all there, and
  // every reserved track with its fixed block at the bottom; else null.
  function dfgValidTracks(value, board) {
    if (!Array.isArray(value) || value.length !== board.sys.length) {
      return null;
    }
    var counts = board.files.map(function () {
      return 0;
    });
    for (var t = 0; t < value.length; t++) {
      var track = value[t];
      if (!Array.isArray(track) || track.length > board.capacity) {
        return null;
      }
      for (var i = 0; i < track.length; i++) {
        if (!dfgIsInteger(track[i]) || track[i] < 0 || track[i] >= counts.length) {
          return null;
        }
        counts[track[i]]++;
      }
      if (board.sys[t] >= 0 && track[0] !== board.sys[t]) {
        return null;
      }
    }
    var whole = board.files.every(function (file, f) {
      return counts[f] === file.size;
    });
    return whole ? dfgCopyTracks(value) : null;
  }

  // A copy of value when it is a list of moves [from, to, blocks] with
  // track numbers of board, else null.
  function dfgMoveList(value, board) {
    if (!Array.isArray(value) || value.length > DFG_HISTORY_MAX) {
      return null;
    }
    var tracks = board.sys.length;
    var ok = value.every(function (move) {
      return Array.isArray(move) && move.length === 3 && move.every(dfgIsInteger) &&
        move[0] >= 0 && move[0] < tracks && move[1] >= 0 && move[1] < tracks && move[2] >= 1;
    });
    return ok ? value.map(function (move) { return move.slice(); }) : null;
  }

  // Whether history leads to tracks: undone from the end, every move must
  // have been legal and moved exactly its blocks, and a full history (one
  // not cut at DFG_HISTORY_MAX) must end at the start.
  function dfgHistoryFits(board, tracks, history) {
    var cur = tracks;
    for (var i = history.length - 1; i >= 0; i--) {
      var move = history[i];
      if (dfgTopRun(board, cur, move[1]) < move[2] || cur[move[0]].length + move[2] > board.capacity) {
        return false;
      }
      cur = dfgApplyMove(cur, move[1], move[0], move[2]);
      if (dfgMoveError(board, cur, move[0], move[1]) || dfgTopRun(board, cur, move[0]) !== move[2]) {
        return false;
      }
    }
    return history.length === DFG_HISTORY_MAX || dfgSameTracks(cur, board.start);
  }

  // The tracks history leads to from the start, or null when a move of it
  // is not legal there or moves other blocks.
  function dfgReplay(board, history) {
    var cur = board.start;
    for (var i = 0; i < history.length; i++) {
      var move = history[i];
      if (dfgMoveError(board, cur, move[0], move[1]) || dfgTopRun(board, cur, move[0]) !== move[2]) {
        return null;
      }
      cur = dfgApplyMove(cur, move[0], move[1], move[2]);
    }
    return cur;
  }

  function dfgMakeGame(kind, id, board, tracks, history, moves, undos, hints) {
    return {
      kind: kind,
      id: id,
      board: board,
      tracks: tracks,
      history: history,
      moves: moves,
      undos: undos,
      hints: hints,
      solved: dfgIsSolved(board, tracks)
    };
  }

  function dfgFreshGame(kind, id, board) {
    return dfgMakeGame(kind, id, board, dfgCopyTracks(board.start), [], 0, 0, 0);
  }

  // A saved game of board, field by field: the tracks when they are a state
  // of the board (else where the history leads from the start, else the
  // start), the history when it leads there (else none), the moves when
  // they are at least the moves of the history (else the history's
  // length), the undos and the hints (else 0).
  function dfgParseGame(data, kind, id, board) {
    var tracks = dfgValidTracks(data.tracks, board);
    var history = dfgMoveList(data.history, board);
    if (!tracks) {
      tracks = history ? dfgReplay(board, history) : null;
      if (!tracks) {
        tracks = dfgCopyTracks(board.start);
        history = [];
      }
    }
    if (!history || !dfgHistoryFits(board, tracks, history)) {
      history = [];
    }
    return dfgMakeGame(kind, id, board, tracks, history,
      dfgIsCount(data.moves) && data.moves >= history.length ? data.moves : history.length,
      dfgIsCount(data.undos) ? data.undos : 0,
      dfgIsCount(data.hints) ? data.hints : 0);
  }

  // dfg-progress as { highest, moves }: the highest level defragmented (0
  // for none) and the fewest moves per level ('7': 12), each on its own.
  function dfgParseProgress(text) {
    var data = dfgParseJson(text);
    if (!dfgIsObject(data)) {
      data = {};
    }
    var moves = {};
    if (dfgIsObject(data.moves)) {
      Object.keys(data.moves).forEach(function (key) {
        var level = Number(key);
        if (String(level) === key && level >= 1 && level <= DFG_MAX_LEVEL && dfgIsCount(data.moves[key])) {
          moves[key] = data.moves[key];
        }
      });
    }
    var highest = dfgIsCount(data.highest) ? Math.min(data.highest, DFG_MAX_LEVEL) : 0;
    return { highest: highest, moves: moves };
  }

  // Two progress records merged: the higher level, the fewer moves of each.
  function dfgMergeProgress(a, b) {
    var moves = {};
    [a.moves, b.moves].forEach(function (list) {
      Object.keys(list).forEach(function (key) {
        if (!dfgHasOwn(moves, key) || list[key] < moves[key]) {
          moves[key] = list[key];
        }
      });
    });
    return { highest: Math.max(a.highest, b.highest), moves: moves };
  }

  // dfg-state as { view, level, game }: the level is the saved one while it
  // is open (at most one past the highest defragmented), else the next one
  // to play; the game is the saved one of that level, field by field, or a
  // fresh one.
  function dfgParseState(text, highest) {
    var data = dfgParseJson(text);
    if (!dfgIsObject(data)) {
      data = {};
    }
    var open = Math.min(highest + 1, DFG_MAX_LEVEL);
    var saved = dfgIsInteger(data.level) && data.level >= 1 && data.level <= open;
    var level = saved ? data.level : open;
    var board = dfgLevelBoard(level);
    return {
      view: data.view === 'daily' ? 'daily' : 'level',
      level: level,
      game: saved ? dfgParseGame(data, 'level', level, board) : dfgFreshGame('level', level, board)
    };
  }

  // dfg-daily as { key, day, status, game, streak, lastWon }.  Without a
  // valid key there is no attempt (key and game null) but the streak stays.
  // A finished attempt whose tracks are not defragmented shows the board's
  // goal; an unfinished one whose tracks are starts again from the start.
  function dfgParseDaily(text) {
    var data = dfgParseJson(text);
    if (!dfgIsObject(data)) {
      data = {};
    }
    var daily = {
      key: null,
      day: 0,
      status: 'playing',
      game: null,
      streak: dfgIsCount(data.streak) ? data.streak : 0,
      lastWon: dfgIsInteger(data.lastWon) ? data.lastWon : null
    };
    var day = dfgKeyDay(data.key);
    if (day === null) {
      return daily;
    }
    var board = dfgDailyBoard(data.key);
    var game = dfgParseGame(data, 'daily', data.key, board);
    var won = data.status === 'won';
    if (game.solved !== won) {
      game.tracks = dfgCopyTracks(won ? board.goal : board.start);
      game.history = [];
      game.solved = won;
    }
    daily.key = data.key;
    daily.day = day;
    daily.status = won ? 'won' : 'playing';
    daily.game = game;
    return daily;
  }

  // ── Texts (no DOM) ────────────────────────────────────────────────────────

  function dfgFileName(board, file) {
    return board.files[file].name;
  }

  // A refusal from dfgMoveError, naming the tracks, the file and the sizes.
  function dfgErrorText(board, error) {
    var a = 'Track ' + (error.a + 1);
    var b = 'track ' + (error.b + 1);
    if (error.code === 'empty') {
      return a + ' is empty: nothing to move.';
    }
    if (error.code === 'fixed') {
      return a + ' holds only the fixed ' + dfgFileName(board, error.file) + ' block: it never moves.';
    }
    var fragment = 'the ' + dfgFileName(board, error.file) + ' fragment on ' + a.toLowerCase() + ' (' +
      dfgPlural(error.count, 'block') + ')';
    if (error.code === 'reserved') {
      return 'Track ' + (error.b + 1) + ' is reserved for ' + dfgFileName(board, error.other) + ': it takes no ' +
        dfgFileName(board, error.file) + ' blocks.';
    }
    if (error.code === 'top') {
      return 'Track ' + (error.b + 1) + ' ends with ' + dfgFileName(board, error.other) + ': ' + fragment +
        ' goes only onto ' + dfgFileName(board, error.file) + ' or an empty track.';
    }
    return 'Track ' + (error.b + 1) + ' has room for ' + dfgPlural(error.room, 'block') + ': ' + fragment +
      ' does not fit, and a fragment never splits.';
  }

  // The hint line for a solver result from dfgSolve.
  function dfgHintText(board, tracks, result) {
    if (result.status === 'solved') {
      var move = result.path[0];
      var left = result.path.length;
      return 'Hint: move ' + dfgFileName(board, dfgTop(tracks[move[0]])) + ' (' + dfgPlural(move[2], 'block') +
        ') from track ' + (move[0] + 1) + ' to track ' + (move[1] + 1) + '; ' +
        (result.optimal ? dfgPlural(left, 'move') + ' to go.' : 'a route of ' + dfgPlural(left, 'move') + ' is left.');
    }
    if (result.status === 'dead') {
      return 'No hint: no move sequence defragments the disk from here (' + dfgPlural(result.nodes, 'state') +
        ' checked). Undo with U.';
    }
    return 'No hint: the search stopped after ' + dfgPlural(result.nodes, 'state') + ' without a route. Undo a move and ask again.';
  }

  // The dead-end warning for a game, or '' when a route may still exist:
  // dfgExplore with a small cap from the tracks, then from each state the
  // undo history goes back through, to say how many moves to undo.
  function dfgDeadEndText(game, cap) {
    var board = game.board;
    var here = dfgExplore(board, game.tracks, cap);
    if (here.status !== 'dead') {
      return '';
    }
    var text = 'Dead end: no move sequence defragments the disk from here (' + dfgPlural(here.nodes, 'state') + ' checked). ';
    var cur = game.tracks;
    var back = Math.min(game.history.length, DFG_UNDO_LOOKBACK);
    for (var i = 1; i <= back; i++) {
      var move = game.history[game.history.length - i];
      cur = dfgApplyMove(cur, move[1], move[0], move[2]);
      var before = dfgExplore(board, cur, cap);
      if (before.status !== 'dead') {
        return text + 'Undo ' + (before.status === 'solved' ? '' : 'at least ') + dfgPlural(i, 'move') + ' (U).';
      }
    }
    if (!back) {
      return text + 'Restart (R): there is no move to undo.';
    }
    return text + 'Undo more than ' + dfgPlural(back, 'move') + ' (U), or Restart (R).';
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // The warning for every key whose storage failed so far.
  function dfgStorageWarning(failed) {
    var keys = Object.keys(failed).sort();
    var names = keys.map(function (key) {
      return failed[key];
    }).filter(function (name, i, list) {
      return list.indexOf(name) === i;
    });
    return 'Storage is blocked or full (' + names.join(', ') + '): ' + keys.join(', ') + (keys.length === 1 ? ' is' : ' are') +
      ' not saved on this page. The game plays on.';
  }

  function dfgStorageFailed(key, error) {
    var warning = dfgRuntime.els.warning;
    dfgRuntime.failed[key] = String(error.name);
    warning.textContent = dfgStorageWarning(dfgRuntime.failed);
    warning.classList.remove('dfg-hidden');
  }

  function dfgStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      dfgStorageFailed(key, error);
      return null;
    }
  }

  // Returns whether the value was written.
  function dfgStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      dfgStorageFailed(key, error);
      return false;
    }
  }

  function dfgSerializeGame(game, out) {
    out.tracks = game.tracks;
    out.history = game.history;
    out.moves = game.moves;
    out.undos = game.undos;
    out.hints = game.hints;
    return out;
  }

  function dfgSerializeState() {
    return dfgSerializeGame(dfgState.level, { v: DFG_SAVE_VERSION, view: dfgState.view, level: dfgState.level.id });
  }

  function dfgSerializeDaily() {
    var daily = dfgState.daily;
    var out = dfgSerializeGame(daily.game, { v: DFG_SAVE_VERSION, key: daily.key, day: daily.day, status: daily.status });
    out.streak = daily.streak;
    out.lastWon = daily.lastWon;
    return out;
  }

  // Reads dfg-state again and takes over the level game another tab saved
  // there when it is of the same level and further along; level play on
  // screen follows, with a toast naming it.  A record once compared is not
  // compared again.  Returns whether it did.
  function dfgSyncState() {
    var text = dfgStorageGet(DFG_STATE_KEY);
    if (text === dfgRuntime.stateText) {
      return false;
    }
    dfgRuntime.stateText = text;
    var stored = dfgParseState(text, dfgState.progress.highest);
    var ours = dfgState.level;
    if (stored.level !== ours.id || dfgSteps(stored.game) <= dfgSteps(ours)) {
      return false;
    }
    dfgState.level = stored.game;
    if (dfgState.view === 'level') {
      dfgClearPick();
      dfgShowToast('Another tab saved level ' + ours.id + ' (' + dfgPlural(stored.game.moves, 'move') + '): it is shown here.');
    }
    dfgRender();
    return true;
  }

  // Writes the level game and the view on screen (never the Daily), after
  // taking over another tab's game of the same level that is further along.
  // A write that fails leaves stateText alone, so the record still stored
  // (maybe this tab's own older one) is not taken for another tab's.
  function dfgSaveState() {
    dfgSyncState();
    var text = JSON.stringify(dfgSerializeState());
    if (dfgStorageSet(DFG_STATE_KEY, text)) {
      dfgRuntime.stateText = text;
    }
  }

  // Reads dfg-daily again and takes over the record another tab saved there
  // when it has to win over this tab's; a Daily on screen follows, with a
  // toast naming what came in.  Returns whether it did.
  function dfgSyncDaily() {
    var text = dfgStorageGet(DFG_DAILY_KEY);
    if (text === dfgRuntime.dailyText) {
      return false;
    }
    var stored = dfgParseDaily(text);
    if (!dfgIsNewerDaily(stored, dfgState.daily, dfgDayInfo(new Date()).day)) {
      return false;
    }
    dfgRuntime.dailyText = text;
    dfgState.daily = stored;
    if (dfgState.view === 'daily' && !dfgState.practice) {
      dfgClearPick();
      dfgShowToast('Another tab ' + (stored.status === 'won' ? 'defragmented' : 'saved') + ' Daily #' + stored.day +
        ' (' + dfgPlural(stored.game.moves, 'move') + '): it is shown here.');
    }
    dfgRender();
    return true;
  }

  // Writes the Daily attempt, unless another tab saved a record that has to
  // win over it: that one is taken over instead.
  function dfgSaveDaily() {
    if (dfgSyncDaily()) {
      return;
    }
    dfgRuntime.dailyText = JSON.stringify(dfgSerializeDaily());
    dfgStorageSet(DFG_DAILY_KEY, dfgRuntime.dailyText);
  }

  // Keeps the fewest moves of a level and the highest level, merged with
  // what another tab may have stored since.  Returns whether the moves are a
  // new best.
  function dfgRecordLevel(level, moves) {
    var progress = dfgMergeProgress(dfgState.progress, dfgParseProgress(dfgStorageGet(DFG_PROGRESS_KEY)));
    var key = String(level);
    var better = !dfgHasOwn(progress.moves, key) || moves < progress.moves[key];
    if (better) {
      progress.moves[key] = moves;
    }
    progress.highest = Math.max(progress.highest, level);
    dfgState.progress = progress;
    dfgStorageSet(DFG_PROGRESS_KEY, JSON.stringify({ v: DFG_SAVE_VERSION, highest: progress.highest, moves: progress.moves }));
    return better;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function dfgActive() {
    if (dfgState.view === 'daily') {
      return dfgState.practice || dfgState.daily.game;
    }
    return dfgState.level;
  }

  // Columns of the disk on phones: one shelf up to five tracks, two above.
  function dfgShelfColumns(count) {
    return count <= 5 ? count : Math.ceil(count / 2);
  }

  // A track for screen readers: its number, its reservation, its runs from
  // the bottom up and the free blocks.
  function dfgTrackLabel(board, tracks, t) {
    var track = tracks[t];
    var runs = [];
    for (var i = 0; i < track.length; i++) {
      if (i === 0 || track[i] !== track[i - 1]) {
        runs.push({ file: track[i], count: 0, fixed: i === 0 && board.sys[t] >= 0 });
      }
      runs[runs.length - 1].count++;
    }
    var parts = runs.map(function (run) {
      return dfgFileName(board, run.file) + ' x' + run.count + (run.fixed ? ' (fixed block at the bottom)' : '');
    });
    return 'Track ' + (t + 1) + (board.sys[t] >= 0 ? ', reserved for ' + dfgFileName(board, board.sys[t]) : '') + ': ' +
      (parts.length ? parts.join(', ') : 'empty') + '; ' + (board.capacity - track.length) + ' free';
  }

  function dfgTrackClass(game, t, targets) {
    var hint = dfgRuntime.hint;
    var classes = ['dfg-track'];
    if (game.board.sys[t] >= 0) {
      classes.push('dfg-track--sys');
    }
    if (t === dfgRuntime.selected) {
      classes.push('dfg-track--selected');
    }
    if (targets.indexOf(t) !== -1) {
      classes.push('dfg-track--target');
    }
    if (hint && hint[0] === t) {
      classes.push('dfg-track--hint-from');
    }
    if (hint && hint[1] === t) {
      classes.push('dfg-track--hint-to');
    }
    return classes.join(' ');
  }

  // The tracks of a game, built again on every render (at most 9 x 5 blocks).
  function dfgDrawDisk(game) {
    var board = game.board;
    var disk = dfgRuntime.els.disk;
    var count = board.sys.length;
    var selected = dfgRuntime.selected;
    var lift = selected >= 0 ? dfgTopRun(board, game.tracks, selected) : 0;
    var targets = [];
    for (var t = 0; t < count && selected >= 0; t++) {
      if (!dfgMoveError(board, game.tracks, selected, t)) {
        targets.push(t);
      }
    }
    disk.innerHTML = '';
    disk.style.setProperty('--dfg-tracks', String(count));
    disk.style.setProperty('--dfg-shelf', String(dfgShelfColumns(count)));
    disk.className = 'dfg-disk' + (game.solved ? ' dfg-disk--solved' : '');
    disk.setAttribute('aria-label', 'Disk with ' + count + ' tracks of ' + board.capacity + ' blocks. Keys: 1 to ' + count +
      ' pick up the top fragment of a track and write it onto another, U undo, H hint, R restart, N next level, Escape puts it back.');
    // A track is drawn, not focused: its label reads it out, the number keys
    // on the disk act on it.
    game.tracks.forEach(function (track, t) {
      var el = document.createElement('div');
      var num = document.createElement('span');
      var slots = document.createElement('div');
      el.className = dfgTrackClass(game, t, targets);
      el.setAttribute('data-track', t);
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', dfgTrackLabel(board, game.tracks, t));
      num.className = 'dfg-track-num';
      num.textContent = (t + 1) + (board.sys[t] >= 0 ? ' ' + board.files[board.sys[t]].ext : '');
      slots.className = 'dfg-slots';
      for (var s = 0; s < board.capacity; s++) {
        var cell = document.createElement('span');
        if (s < track.length) {
          var file = board.files[track[s]];
          cell.className = 'dfg-block dfg-type-' + file.ext + (s === 0 && board.sys[t] >= 0 ? ' dfg-block--sys' : '') +
            (t === selected && s >= track.length - lift ? ' dfg-block--lift' : '');
          cell.textContent = file.ext;
        } else {
          cell.className = 'dfg-slot';
        }
        slots.appendChild(cell);
      }
      el.appendChild(num);
      el.appendChild(slots);
      disk.appendChild(el);
    });
  }

  function dfgGameName(game) {
    if (game.kind === 'level') {
      return 'level ' + game.id;
    }
    return (game.kind === 'practice' ? 'the practice run of Daily #' : 'Daily #') + dfgKeyDay(game.id);
  }

  function dfgModeText(game) {
    var board = game.board;
    var make = dfgPlural(board.files.length, 'file') + ' · ' + board.sys.length + ' tracks of ' + board.capacity;
    if (game.kind === 'level') {
      return 'Level ' + game.id + ' · ' + make;
    }
    return (game.kind === 'practice' ? 'Practice of Daily #' : 'Daily #') + dfgKeyDay(game.id) + ' · ' + game.id + ' · ' + make;
  }

  function dfgStatusText(game) {
    var board = game.board;
    var daily = dfgState.daily;
    var start = dfgFragmentation(board, board.start);
    var par = ' (par ≤ ' + board.par + ')';
    if (game.kind === 'daily' && daily.status === 'won') {
      return 'Daily #' + daily.day + ' defragmented in ' + dfgPlural(game.moves, 'move') + par +
        dfgHelpText(game) + '. Streak ' + daily.streak + '.';
    }
    if (game.solved) {
      return 'Defragmented: ' + dfgGameName(game) + ' in ' + dfgPlural(game.moves, 'move') + par + ', fragmentation ' +
        start + '% → 0%.' + (game.kind === 'practice' ? ' Practice run, not scored.' : '');
    }
    if (dfgRuntime.selected >= 0) {
      var t = dfgRuntime.selected;
      return 'Track ' + (t + 1) + ': the ' + dfgFileName(board, dfgTop(game.tracks[t])) + ' fragment (' +
        dfgPlural(dfgTopRun(board, game.tracks, t), 'block') + ') is picked up. Tap a track to write it there, or the same track to put it back.';
    }
    return 'Fragmentation ' + dfgFragmentation(board, game.tracks) + '%: ' +
      dfgPlural(dfgExtra(board, game.tracks), 'fragment') + ' to merge. Tap a track to pick up its top fragment.';
  }

  function dfgRenderControls(game) {
    var els = dfgRuntime.els;
    var daily = dfgState.daily;
    var inDaily = dfgState.view === 'daily';
    var won = inDaily && !dfgState.practice && daily.status === 'won';
    var today = dfgDayInfo(new Date());
    var level = dfgState.level.id;
    var open = !inDaily && level <= dfgState.progress.highest && level < DFG_MAX_LEVEL;
    els.dailyButton.textContent = inDaily ? 'Levels' :
      'Daily #' + today.day + (daily.key === today.key && daily.status === 'won' ? ' ✓' : '');
    els.dailyButton.setAttribute('aria-label', inDaily ? 'Back to the numbered levels' : 'Open Daily #' + today.day);
    els.prev.disabled = inDaily || level <= 1;
    els.next.disabled = !open;
    els.next.classList.toggle('dfg-btn--go', open && game.solved);
    els.restart.textContent = won ? 'Practice' : 'Restart';
    els.restart.setAttribute('aria-label', won ? 'Practice this Daily disk, not scored' : 'Restart this disk from its first state');
    els.share.classList.toggle('dfg-hidden', !won);
    els.streak.textContent = String(dfgLiveStreak(daily, today.day));
  }

  function dfgRender() {
    var els = dfgRuntime.els;
    var game = dfgActive();
    var board = game.board;
    var frag = dfgFragmentation(board, game.tracks);
    var best = game.kind === 'level' ? dfgState.progress.moves[String(game.id)] : undefined;
    dfgDrawDisk(game);
    els.mode.textContent = dfgModeText(game);
    els.frag.textContent = frag + '%';
    els.fragLine.textContent = 'fragmentation ' + dfgFragmentation(board, board.start) + '% → ' + frag + '%';
    els.meterFill.style.width = frag + '%';
    els.moves.textContent = String(game.moves);
    els.par.textContent = '≤ ' + board.par;
    els.best.textContent = best === undefined ? '--' : String(best);
    els.hints.textContent = String(game.hints);
    els.status.textContent = dfgStatusText(game);
    els.note.textContent = dfgRuntime.note;
    els.note.className = 'dfg-note' + (dfgRuntime.note ? ' dfg-note--' + dfgRuntime.noteKind : ' dfg-hidden');
    dfgRenderControls(game);
  }

  function dfgHideToast() {
    dfgRuntime.toastTimeout = null;
    dfgRuntime.els.toast.classList.remove('dfg-show');
  }

  // Shows message for DFG_TOAST_MS; a newer toast gets its full time.
  function dfgShowToast(message) {
    var toast = dfgRuntime.els.toast;
    clearTimeout(dfgRuntime.toastTimeout);
    toast.textContent = message;
    toast.classList.add('dfg-show');
    dfgRuntime.toastTimeout = setTimeout(dfgHideToast, DFG_TOAST_MS);
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  function dfgClearPick() {
    dfgRuntime.selected = -1;
    dfgRuntime.hint = null;
    dfgRuntime.note = '';
    dfgRuntime.confirmUntil = 0;
  }

  // Writes the game on screen: the Daily attempt, the level game, or
  // nothing for a practice run.
  function dfgSaveActive() {
    var game = dfgActive();
    if (game.kind === 'daily') {
      dfgSaveDaily();
    } else if (game.kind === 'level') {
      dfgSaveState();
    }
  }

  // Before a move, an undo, a hint, a restart or leaving a level: whether
  // another tab's record of the game on screen was taken over instead, so
  // the press (made on the old disk) does nothing.  A practice run is this
  // tab's alone.
  function dfgStaleGame() {
    var kind = dfgActive().kind;
    if (kind === 'daily') {
      return dfgSyncDaily();
    }
    return kind === 'level' && dfgSyncState();
  }

  // Whether this press of action is the second within DFG_CONFIRM_MS; the
  // first arms it and shows message.  A move or an undo in between disarms
  // it (dfgClearPick).
  function dfgConfirmed(action, message) {
    var now = performance.now();
    if (dfgRuntime.confirmAction === action && now < dfgRuntime.confirmUntil) {
      return true;
    }
    dfgRuntime.confirmAction = action;
    dfgRuntime.confirmUntil = now + DFG_CONFIRM_MS;
    dfgShowToast(message);
    return false;
  }

  function dfgRefuseSolved(game) {
    var next = game.kind === 'level' ? 'Restart or Next level.' : game.kind === 'daily' ? 'Practice replays it.' : 'Restart replays it.';
    dfgShowToast(dfgGameName(game).charAt(0).toUpperCase() + dfgGameName(game).slice(1) + ' is defragmented: ' + next);
  }

  // After a move or an undo: the dead-end check, then render and save.
  function dfgAfterChange(game) {
    dfgRuntime.note = game.solved ? '' : dfgDeadEndText(game, DFG_LIMITS.check);
    dfgRuntime.noteKind = 'dead';
    dfgRender();
    dfgSaveActive();
  }

  function dfgFinishDaily() {
    var daily = dfgState.daily;
    daily.status = 'won';
    daily.streak = daily.lastWon === daily.day - 1 ? daily.streak + 1 : 1;
    daily.lastWon = daily.day;
  }

  function dfgWin(game) {
    var name = dfgGameName(game);
    var done = name.charAt(0).toUpperCase() + name.slice(1) + ' defragmented in ' + dfgPlural(game.moves, 'move');
    if (game.kind === 'level') {
      dfgShowToast(done + (dfgRecordLevel(game.id, game.moves) ? ': new best!' : '.'));
    } else if (game.kind === 'daily') {
      dfgFinishDaily();
      dfgShowToast(done + '. Streak ' + dfgState.daily.streak + '.');
    } else {
      dfgShowToast(done + ': not scored.');
    }
  }

  // Moves the top fragment of track a onto track b, or names why not.
  function dfgMoveFragment(a, b) {
    var game = dfgActive();
    var error = dfgMoveError(game.board, game.tracks, a, b);
    dfgClearPick();
    if (error) {
      dfgShowToast(dfgErrorText(game.board, error));
      dfgRender();
      return;
    }
    var count = dfgTopRun(game.board, game.tracks, a);
    game.tracks = dfgApplyMove(game.tracks, a, b, count);
    game.history.push([a, b, count]);
    if (game.history.length > DFG_HISTORY_MAX) {
      game.history.shift();
    }
    game.moves++;
    game.solved = dfgIsSolved(game.board, game.tracks);
    if (game.solved) {
      dfgWin(game);
    }
    dfgAfterChange(game);
  }

  // A tap on track t (or its number key): picks up its top fragment, puts
  // it back, or writes the fragment picked up onto it.
  function dfgPickTrack(t) {
    if (dfgStaleGame()) {
      return;
    }
    var game = dfgActive();
    if (game.solved) {
      dfgRefuseSolved(game);
      return;
    }
    var from = dfgRuntime.selected;
    if (from === t) {
      dfgRuntime.selected = -1;
      dfgRender();
      return;
    }
    if (from >= 0) {
      dfgMoveFragment(from, t);
      return;
    }
    if (!dfgTopRun(game.board, game.tracks, t)) {
      dfgShowToast(dfgErrorText(game.board, dfgMoveError(game.board, game.tracks, t, -1)));
      return;
    }
    dfgRuntime.selected = t;
    dfgRender();
  }

  function dfgUndo() {
    if (dfgStaleGame()) {
      return;
    }
    var game = dfgActive();
    if (game.solved) {
      dfgRefuseSolved(game);
      return;
    }
    var move = game.history.pop();
    if (!move) {
      dfgShowToast('Nothing to undo: ' + (game.moves ? 'the undo history keeps the last ' + DFG_HISTORY_MAX + ' moves.' : 'the disk is at its first state.'));
      return;
    }
    dfgClearPick();
    game.tracks = dfgApplyMove(game.tracks, move[1], move[0], move[2]);
    game.moves = Math.max(0, game.moves - 1);
    game.undos++;
    dfgAfterChange(game);
  }

  // The hint: the solver's next move, counted once per disk state (a hint
  // still shown is the same move again, so asking again costs nothing).
  function dfgHint() {
    if (dfgStaleGame()) {
      return;
    }
    var game = dfgActive();
    if (game.solved) {
      dfgRefuseSolved(game);
      return;
    }
    var shown = dfgRuntime.hint !== null;
    var result = dfgSolve(game.board, game.tracks, DFG_LIMITS);
    dfgClearPick();
    dfgRuntime.note = dfgHintText(game.board, game.tracks, result);
    dfgRuntime.noteKind = result.status === 'solved' ? 'hint' : 'dead';
    if (result.status === 'solved') {
      dfgRuntime.hint = result.path[0];
      game.hints += shown ? 0 : 1;
    }
    dfgRender();
    dfgSaveActive();
  }

  // Restart: the same disk from its first state.  A Daily in progress is one
  // scored attempt and refuses; a defragmented Daily gives a practice run;
  // with moves to lose a second press within DFG_CONFIRM_MS is needed.
  function dfgRestart() {
    if (dfgStaleGame()) {
      return;
    }
    var game = dfgActive();
    var daily = dfgState.daily;
    if (game.kind === 'daily' && daily.status === 'playing') {
      dfgShowToast('Daily #' + daily.day + ' is one scored attempt and cannot be restarted (' +
        dfgPlural(game.moves, 'move') + ' so far). Undo with U.');
      return;
    }
    if (game.kind === 'daily') {
      dfgClearPick();
      dfgState.practice = dfgFreshGame('practice', daily.key, game.board);
      dfgRender();
      dfgShowToast('Practice run of Daily #' + daily.day + ': not scored, not saved.');
      return;
    }
    if (game.moves > 0 && !game.solved &&
      !dfgConfirmed('restart', 'Press Restart again within 3 s to throw away ' + dfgPlural(game.moves, 'move') + ' on ' + dfgGameName(game) + '.')) {
      return;
    }
    dfgClearPick();
    var fresh = dfgFreshGame(game.kind, game.id, game.board);
    if (game.kind === 'level') {
      dfgState.level = fresh;
    } else {
      dfgState.practice = fresh;
    }
    dfgRender();
    dfgSaveActive();
  }

  // A level on screen, fresh.  Leaving a level with moves made takes a
  // second press of button (Prev or Next) within DFG_CONFIRM_MS, since
  // only one level game is kept.
  function dfgGoLevel(level, button) {
    if (dfgStaleGame()) {
      return;
    }
    var old = dfgState.level;
    if (old.moves > 0 && !old.solved && !dfgConfirmed('level' + level, 'Press ' + button + ' again within 3 s to leave level ' +
      old.id + ' and throw away its ' + dfgPlural(old.moves, 'move') + ' (the level starts over when you come back).')) {
      return;
    }
    dfgClearPick();
    dfgState.level = dfgFreshGame('level', level, dfgLevelBoard(level));
    dfgRender();
    dfgSaveState();
  }

  function dfgPrevLevel() {
    if (dfgState.view === 'level' && dfgState.level.id > 1) {
      dfgGoLevel(dfgState.level.id - 1, 'Prev');
    }
  }

  // The next level, once this one has been defragmented (now or before).
  function dfgNextLevel() {
    var level = dfgState.level.id;
    if (dfgState.view === 'daily') {
      dfgShowToast('Next level works in level play: Daily #' + dfgState.daily.day + ' is on screen.');
    } else if (level >= DFG_MAX_LEVEL) {
      dfgShowToast('Level ' + DFG_MAX_LEVEL + ' is the last level.');
    } else if (level > dfgState.progress.highest) {
      dfgShowToast('Level ' + (level + 1) + ' opens once level ' + level + ' is defragmented.');
    } else {
      dfgGoLevel(level + 1, 'Next');
    }
  }

  // Starts the Daily attempt of today.
  function dfgBeginDaily(today) {
    var daily = dfgState.daily;
    daily.streak = dfgLiveStreak(daily, today.day);
    daily.key = today.key;
    daily.day = today.day;
    daily.status = 'playing';
    daily.game = dfgFreshGame('daily', today.key, dfgDailyBoard(today.key));
  }

  // Today's Daily: takes over what another tab stored since, then resumes
  // the attempt of today or shows its result, or begins a new one, written
  // the moment it begins (yesterday's attempt is left as it was).
  function dfgOpenDaily() {
    var today = dfgDayInfo(new Date());
    dfgSyncDaily();
    if (dfgState.daily.key !== today.key) {
      dfgBeginDaily(today);
      dfgSaveDaily();
    }
    dfgState.view = 'daily';
    dfgClearPick();
    dfgRender();
    dfgSaveState();
  }

  function dfgToggleDaily() {
    if (dfgState.view === 'daily') {
      dfgState.view = 'level';
      dfgState.practice = null;
      dfgClearPick();
      dfgRender();
      dfgSaveState();
    } else {
      dfgOpenDaily();
    }
  }

  // Shows the share text selected in its read-only field, for copying by
  // hand when the clipboard is missing or refuses.
  function dfgShowShareField(text) {
    var field = dfgRuntime.els.shareText;
    field.value = text;
    field.classList.remove('dfg-hidden');
    field.focus();
    field.select();
    dfgShowToast('The clipboard is not available: copy the selected result below.');
  }

  function dfgShare() {
    var daily = dfgState.daily;
    var game = daily.game;
    var board = game.board;
    var text = dfgShareText(daily.day, dfgFragmentation(board, board.start), game, board.par);
    var clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text).then(function () {
        dfgShowToast('Copied: ' + text);
      }, function () {
        dfgShowShareField(text);
      });
    } else {
      dfgShowShareField(text);
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // 'track1' ... 'track9', 'undo', 'hint', 'restart', 'next' or 'cancel' for
  // a keydown, or null.  A keydown without a key (Chrome autofill sends
  // those) is null.
  function dfgKeyAction(event) {
    if (typeof event.key !== 'string') {
      return null;
    }
    var key = event.key.toLowerCase();
    if (/^[1-9]$/.test(key)) {
      return 'track' + key;
    }
    if (dfgHasOwn(DFG_KEYS, key)) {
      return DFG_KEYS[key];
    }
    var digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
    if (digit) {
      return 'track' + digit[1];
    }
    return dfgHasOwn(DFG_CODES, event.code) ? DFG_CODES[event.code] : null;
  }

  // A field of the game itself (the result to copy) keeps its keys.
  function dfgIsField(el) {
    var tag = String(el.tagName).toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }

  // Keys reach this listener only while the focus is inside the game.
  function dfgHandleKeydown(event) {
    var action = dfgKeyAction(event);
    if (!action || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented ||
      dfgIsField(event.target) || (action === 'cancel' && dfgRuntime.selected === -1)) {
      return;
    }
    event.preventDefault();
    if (event.repeat) {
      return;
    }
    if (action === 'cancel') {
      dfgRuntime.selected = -1;
      dfgRender();
    } else if (action === 'undo') {
      dfgUndo();
    } else if (action === 'hint') {
      dfgHint();
    } else if (action === 'restart') {
      dfgRestart();
    } else if (action === 'next') {
      dfgNextLevel();
    } else {
      dfgPressTrack(Number(action.slice(5)) - 1);
    }
  }

  // A track number key: a track of this disk, or a refusal naming the count.
  function dfgPressTrack(t) {
    var count = dfgActive().board.sys.length;
    if (t >= count) {
      dfgShowToast('There is no track ' + (t + 1) + ': this disk has ' + count + ' tracks.');
      return;
    }
    dfgPickTrack(t);
  }

  function dfgHandleDiskClick(event) {
    var track = event.target.closest('.dfg-track');
    if (track) {
      dfgPickTrack(Number(track.getAttribute('data-track')));
    }
  }

  // Another tab wrote to storage: its Daily record or its level game is
  // taken over when it has to win over this tab's, and its progress is
  // merged in.
  function dfgHandleStorage(event) {
    if (event.key === DFG_DAILY_KEY) {
      dfgSyncDaily();
    } else if (event.key === DFG_STATE_KEY) {
      dfgSyncState();
    } else if (event.key === DFG_PROGRESS_KEY) {
      dfgState.progress = dfgMergeProgress(dfgState.progress, dfgParseProgress(dfgStorageGet(DFG_PROGRESS_KEY)));
      dfgRender();
    }
  }

  // A click listener for a game button running action.  A mouse click or a
  // tap leaves the focus on the button, and Space or Enter would click it
  // again (a second undo, a restart); keyboard activation (detail 0) keeps
  // it there.  So a pointer click moves the focus to the disk first: the
  // game keys keep working and Space scrolls the page.
  function dfgButton(action) {
    return function (event) {
      if (event.detail > 0) {
        dfgRuntime.els.disk.focus({ preventScroll: true });
      }
      action();
    };
  }

  function dfgBindEvents() {
    var els = dfgRuntime.els;
    els.game.addEventListener('keydown', dfgHandleKeydown);
    els.disk.addEventListener('click', dfgHandleDiskClick);
    els.undo.addEventListener('click', dfgButton(dfgUndo));
    els.hint.addEventListener('click', dfgButton(dfgHint));
    els.restart.addEventListener('click', dfgButton(dfgRestart));
    els.prev.addEventListener('click', dfgButton(dfgPrevLevel));
    els.next.addEventListener('click', dfgButton(dfgNextLevel));
    els.dailyButton.addEventListener('click', dfgButton(dfgToggleDaily));
    els.shareButton.addEventListener('click', dfgButton(dfgShare));
    window.addEventListener('storage', dfgHandleStorage);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function dfgFindElements() {
    return {
      game: document.getElementById('dfg-game'),
      disk: document.getElementById('dfg-disk'),
      dailyButton: document.getElementById('dfg-daily-button'),
      prev: document.getElementById('dfg-prev'),
      next: document.getElementById('dfg-next'),
      mode: document.getElementById('dfg-mode'),
      frag: document.getElementById('dfg-frag'),
      fragLine: document.getElementById('dfg-frag-line'),
      meterFill: document.getElementById('dfg-meter-fill'),
      moves: document.getElementById('dfg-moves'),
      par: document.getElementById('dfg-par'),
      best: document.getElementById('dfg-best'),
      hints: document.getElementById('dfg-hints'),
      streak: document.getElementById('dfg-streak'),
      undo: document.getElementById('dfg-undo'),
      hint: document.getElementById('dfg-hint'),
      restart: document.getElementById('dfg-restart'),
      status: document.getElementById('dfg-status'),
      note: document.getElementById('dfg-note'),
      warning: document.getElementById('dfg-warning'),
      share: document.getElementById('dfg-share'),
      shareButton: document.getElementById('dfg-share-button'),
      shareText: document.getElementById('dfg-share-text'),
      toast: document.getElementById('dfg-toast')
    };
  }

  // Finds the elements, binds the controls once and restores the saves: the
  // level game (or the next level to play) and, when the Daily was on
  // screen, today's Daily.
  function dfgInit() {
    if (dfgRuntime.els) {
      return;
    }
    dfgRuntime.els = dfgFindElements();
    dfgBindEvents();
    dfgState.progress = dfgParseProgress(dfgStorageGet(DFG_PROGRESS_KEY));
    dfgRuntime.dailyText = dfgStorageGet(DFG_DAILY_KEY);
    dfgState.daily = dfgParseDaily(dfgRuntime.dailyText);
    dfgRuntime.stateText = dfgStorageGet(DFG_STATE_KEY);
    var saved = dfgParseState(dfgRuntime.stateText, dfgState.progress.highest);
    dfgState.level = saved.game;
    if (saved.view === 'daily') {
      dfgOpenDaily();
    } else {
      dfgRender();
      dfgSaveState();
    }
  }

  // Node (tests): export only, no init and no timers.  Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      dfgState: dfgState,
      dfgRuntime: dfgRuntime,
      dfgLimits: DFG_LIMITS,
      dfgInit: dfgInit,
      dfgLevelConfig: dfgLevelConfig,
      dfgDailyConfig: dfgDailyConfig,
      dfgMakeFiles: dfgMakeFiles,
      dfgSolvedLayout: dfgSolvedLayout,
      dfgTopRun: dfgTopRun,
      dfgMoveError: dfgMoveError,
      dfgApplyMove: dfgApplyMove,
      dfgLegalMoves: dfgLegalMoves,
      dfgReverseMoves: dfgReverseMoves,
      dfgExtra: dfgExtra,
      dfgIsSolved: dfgIsSolved,
      dfgFragmentation: dfgFragmentation,
      dfgKey: dfgKey,
      dfgChildren: dfgChildren,
      dfgIda: dfgIda,
      dfgExplore: dfgExplore,
      dfgSolve: dfgSolve,
      dfgScramble: dfgScramble,
      dfgGenerate: dfgGenerate,
      dfgLevelBoard: dfgLevelBoard,
      dfgDailyBoard: dfgDailyBoard,
      dfgHash: dfgHash,
      dfgMulberry32: dfgMulberry32,
      dfgDayInfo: dfgDayInfo,
      dfgKeyDay: dfgKeyDay,
      dfgLiveStreak: dfgLiveStreak,
      dfgShareText: dfgShareText,
      dfgSteps: dfgSteps,
      dfgIsNewerDaily: dfgIsNewerDaily,
      dfgValidTracks: dfgValidTracks,
      dfgHistoryFits: dfgHistoryFits,
      dfgReplay: dfgReplay,
      dfgParseState: dfgParseState,
      dfgParseProgress: dfgParseProgress,
      dfgMergeProgress: dfgMergeProgress,
      dfgParseDaily: dfgParseDaily,
      dfgErrorText: dfgErrorText,
      dfgHintText: dfgHintText,
      dfgDeadEndText: dfgDeadEndText,
      dfgStorageWarning: dfgStorageWarning,
      dfgKeyAction: dfgKeyAction,
      dfgShelfColumns: dfgShelfColumns
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', dfgInit);
  } else {
    dfgInit();
  }
})();
