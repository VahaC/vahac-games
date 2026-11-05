// On-Call Shift — script.js
// Prefix: ocs-
// Dependencies: none.
//
// A night on call: twelve servers on a rack (#ocs-rack, a 4x3 grid of
// buttons) raise incidents, and every incident needs one of four actions
// (cleanup, restart, scale, renew) before its SLA timer runs out. A breached
// SLA takes the server down: it collects downtime until it gets the right
// action. A wrong action costs OCS_PENALTY_MS of downtime on that server.
// When a server goes down, the servers that depend on it (OCS_SERVERS
// upstream) get a "lost connection" alert after the level's cascade delay,
// and again after every fix for as long as their upstream stays down.
//
// Score: uptime = 1 - downtime / (12 servers x elapsed shift time), shown
// rounded down (never up to the next nine) and graded in nines.
//
// Clock: a shift is OCS_SHIFT_MS (3 minutes) of play, shown as 22:00 to
// 06:00. The simulation is pure (ocsStep / ocsTick / ocsApply on a plain
// state object, randomness passed in) and moves in fixed OCS_TICK_MS steps.
// The page runs one setInterval only while the shift runs; every callback is
// exactly one tick, so a slow or throttled tab never piles ticks up. The
// shift pauses on the Pause button, on Space and when the tab is hidden, and
// a reloaded shift comes back paused.
//
// Input: tap an action button and then servers (the action stays armed), or
// tap a server and then an action. A mouse or touch click on a tile, an
// action, Start shift / Pause / Resume, the overlay or New Shift hands the
// keys to the rack. Keys work only while the focus is inside the game
// (.ocs-wrapper) and the shift is not over, never in its select or text
// field and never with Ctrl / Alt / Cmd: 1-4 arm an action and Escape clears
// the selection anywhere in the game; on the rack the arrows move its cursor,
// Enter applies the armed action to the cursor's server and Space pauses. A
// focused game button keeps its own Enter, Space and arrows (they scroll the
// page), and once the shift is over every key is left to the page.
//
// Level: the select picks the level of the next shift. A shift whose clock
// has run plays on at its own level; one that has not is replaced at once.
// Shift numbers count shifts whose clock ran.
//
// Saves (localStorage): 'ocs-state' (the shift: clock, servers, incidents,
// downtime, stats and log), 'ocs-best' (best uptime per level) and
// 'ocs-history' (the last 5 shifts in short). Parsing falls back field by
// field; blocked or full storage shows a warning and the game plays on.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser ocsInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var OCS_STATE_KEY = 'ocs-state';
  var OCS_BEST_KEY = 'ocs-best';
  var OCS_HISTORY_KEY = 'ocs-history';
  var OCS_VERSION = 1;

  var OCS_TICK_MS = 100;
  var OCS_SHIFT_MS = 180000;
  // The shift on screen: 22:00 plus 8 hours.
  var OCS_CLOCK_START_MIN = 22 * 60;
  var OCS_SHIFT_GAME_MIN = 8 * 60;
  // Game seconds per real millisecond (8 h in 3 min: 0.16).
  var OCS_GAME_PER_MS = OCS_SHIFT_GAME_MIN * 60 / OCS_SHIFT_MS;
  var OCS_FIRST_SPAWN_MS = 2000;
  var OCS_PENALTY_MS = 1500;
  // Longest SLA or spawn delay a save may hold.
  var OCS_MAX_WAIT_MS = 60000;
  var OCS_SAVE_EVERY_TICKS = 10;
  var OCS_LOG_MAX = 600;
  var OCS_FEED_LINES = 4;
  var OCS_HISTORY_MAX = 5;
  var OCS_TOAST_MS = 2200;
  var OCS_COLS = 4;

  var OCS_ACTIONS = ['cleanup', 'restart', 'scale', 'renew'];

  // Per level: the spawn delay and SLA at the start and at the end of the
  // shift (linear in between) and the cascade delay, all in ms. Normal, the
  // default, is tuned so a player who needs about 1.5 s per fix still keeps
  // two nines (see the balance tests).
  var OCS_LEVELS = {
    easy: { label: 'Easy', spawnStart: 3800, spawnEnd: 1500, slaStart: 11000, slaEnd: 7000, cascadeMs: 4000 },
    normal: { label: 'Normal', spawnStart: 2800, spawnEnd: 1200, slaStart: 8000, slaEnd: 6000, cascadeMs: 3000 },
    hard: { label: 'Hard', spawnStart: 2200, spawnEnd: 700, slaStart: 6500, slaEnd: 4000, cascadeMs: 2000 }
  };

  // The rack in reading order (4 columns, 3 rows): the incidents each server
  // can raise and the servers it depends on (by index).
  var OCS_SERVERS = [
    { name: 'dns-1', kinds: ['renew', 'restart', 'scale'], upstream: [] },
    { name: 'lb-1', kinds: ['renew', 'scale', 'restart'], upstream: [0] },
    { name: 'web-1', kinds: ['cleanup', 'restart', 'scale', 'renew'], upstream: [8] },
    { name: 'web-2', kinds: ['cleanup', 'restart', 'scale', 'renew'], upstream: [9] },
    { name: 'api-1', kinds: ['restart', 'scale', 'renew', 'cleanup'], upstream: [8, 10] },
    { name: 'api-2', kinds: ['restart', 'scale', 'renew', 'cleanup'], upstream: [9, 10] },
    { name: 'worker-1', kinds: ['cleanup', 'restart', 'scale'], upstream: [11] },
    { name: 'backup-1', kinds: ['cleanup', 'restart'], upstream: [8, 9] },
    { name: 'db-1', kinds: ['cleanup', 'restart', 'scale'], upstream: [] },
    { name: 'db-2', kinds: ['cleanup', 'restart', 'scale'], upstream: [] },
    { name: 'cache-1', kinds: ['restart', 'scale'], upstream: [] },
    { name: 'queue-1', kinds: ['cleanup', 'restart', 'scale'], upstream: [] }
  ];
  var OCS_ROWS = OCS_SERVERS.length / OCS_COLS;

  // What each incident looks like: the tile tag and the log text.
  var OCS_KINDS = {
    cleanup: { tag: 'DISK 97%', text: 'disk 97% full' },
    restart: { tag: 'MEM LEAK', text: 'memory leak eating RAM' },
    scale: { tag: 'CPU 100%', text: 'CPU pinned at 100%' },
    renew: { tag: 'CERT EXP', text: 'TLS certificate expires in 2 h' }
  };

  var OCS_MOVES = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
  var OCS_KEY_MOVES = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

  // Grades by the uptime shown (rounded down), best first.
  var OCS_GRADES = [
    { min: 99.999, nines: 5, name: 'five nines', note: 'Flawless shift. Nobody even noticed you were on call.' },
    { min: 99.99, nines: 4, name: 'four nines', note: 'Customers slept and the dashboard stayed green. Frame this one.' },
    { min: 99.9, nines: 3, name: 'three nines', note: 'Solid night: a blip or two, nothing a status page cannot explain.' },
    { min: 99, nines: 2, name: 'two nines', note: 'Rough night: some pages were missed and users noticed.' },
    { min: 90, nines: 1, name: 'one nine', note: 'Major outage. Expect a long meeting tomorrow morning.' },
    { min: 0, nines: 0, name: 'no nines', note: 'Total meltdown. Hand over the pager and try again.' }
  ];

  var OCS_PAUSE_LABEL = { ready: 'Start shift', running: 'Pause', paused: 'Resume', over: 'Shift over' };

  var OCS_TEXT = {
    ready: 'Pager is quiet. Press Start shift (or Space on the rack) to begin the 22:00 to 06:00 shift.',
    started: 'Shift started: the pager is live. Keep the rack green.',
    resumed: 'Back on call: the shift continues.',
    paused: 'Paused. Press Resume or Space on the rack to continue.',
    // The overlay: Space only works once the rack has the focus.
    overlayReady: 'Tap here or press Start shift to begin (Space works once the rack has the focus).',
    overlayPaused: 'Tap here or press Resume to continue (Space works once the rack has the focus).',
    pausedHidden: 'Paused while the tab was hidden. Press Resume or Space on the rack to continue.',
    restored: 'Shift restored, paused at ',
    notRunning: {
      ready: 'The shift has not started: press Start shift first.',
      paused: 'The shift is paused: press Resume or Space first.',
      over: 'The shift is over: start a New Shift.'
    },
    chooseFirst: 'Choose an action first: 1 cleanup, 2 restart, 3 scale, 4 renew.',
    cleared: 'Selection cleared.',
    disarmed: 'No action armed.',
    copied: 'Postmortem copied to the clipboard.',
    noClipboard: 'Clipboard unavailable: the postmortem is selected in the field below, copy it with Ctrl+C (Cmd+C on a Mac).',
    noHistory: 'No finished shifts yet: your last 5 postmortems show up here.'
  };

  // ── State ─────────────────────────────────────────────────────────────────

  // The shift in progress, field for field what ocs-state holds.
  var ocsState = ocsNewShift('normal', 1);
  // Best uptime per level (null: none yet) and the last finished shifts.
  var ocsBest = ocsParseBest(null);
  var ocsHistory = [];

  // Page handles and UI state, never saved.
  var ocsRuntime = {
    els: null,
    tiles: [],
    phase: 'ready',
    interval: null,
    toastTimeout: null,
    ticks: 0,
    armed: null,
    picked: null,
    cursor: 0,
    feedKey: '',
    reportFor: null,
    storageWarned: false
  };

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function ocsHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function ocsIsLevel(level) {
    return typeof level === 'string' && ocsHasOwn(OCS_LEVELS, level);
  }

  function ocsIsAction(action) {
    return typeof action === 'string' && OCS_ACTIONS.indexOf(action) !== -1;
  }

  function ocsIsIndex(i) {
    return typeof i === 'number' && i >= 0 && i < OCS_SERVERS.length && Math.floor(i) === i;
  }

  function ocsIsNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  // A whole number of at least 0 from value, or 0.
  function ocsCount(value) {
    return ocsIsNumber(value) && value >= 0 ? Math.floor(value) : 0;
  }

  function ocsPad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function ocsLerp(from, to, fraction) {
    return from + (to - from) * fraction;
  }

  function ocsRoundToTick(ms) {
    return Math.max(OCS_TICK_MS, Math.round(ms / OCS_TICK_MS) * OCS_TICK_MS);
  }

  // A draw of rnd as an index below length (also for a draw of exactly 1).
  function ocsPick(length, rnd) {
    return Math.min(length - 1, Math.floor(rnd() * length));
  }

  // ── Shift model (pure) ────────────────────────────────────────────────────

  function ocsBlankServer() {
    return {
      st: 'ok',
      kind: null,
      from: null,
      left: 0,
      sla: 0,
      since: 0,
      outage: 0,
      down: 0,
      cascadeAt: null,
      cascadeFrom: null
    };
  }

  function ocsNewStats() {
    return { incidents: 0, fixed: 0, restored: 0, breaches: 0, wrong: 0, cascades: 0, fixMs: 0, worstMs: 0, worst: -1 };
  }

  // A fresh shift of a level (Normal for an unknown one) at 22:00.
  function ocsNewShift(level, shiftNo) {
    return {
      v: OCS_VERSION,
      level: ocsIsLevel(level) ? level : 'normal',
      shiftNo: shiftNo,
      t: 0,
      nextSpawn: OCS_FIRST_SPAWN_MS,
      servers: OCS_SERVERS.map(ocsBlankServer),
      stats: ocsNewStats(),
      log: [[0, -1, 'start', null, 0]]
    };
  }

  function ocsIsOver(state) {
    return state.t >= OCS_SHIFT_MS;
  }

  function ocsProgress(t) {
    return Math.min(1, Math.max(0, t / OCS_SHIFT_MS));
  }

  // The mean delay before the next incident at shift time t.
  function ocsSpawnInterval(level, t) {
    var cfg = OCS_LEVELS[level];
    return ocsLerp(cfg.spawnStart, cfg.spawnEnd, ocsProgress(t));
  }

  // The SLA of an incident raised at shift time t, in whole ticks.
  function ocsSlaFor(level, t) {
    var cfg = OCS_LEVELS[level];
    return ocsRoundToTick(ocsLerp(cfg.slaStart, cfg.slaEnd, ocsProgress(t)));
  }

  function ocsDowntime(state) {
    var total = 0;
    state.servers.forEach(function (server) {
      total += server.down;
    });
    return total;
  }

  // Uptime so far in percent, 0 to 100.
  function ocsUptime(state) {
    if (state.t <= 0) {
      return 100;
    }
    var ratio = 1 - ocsDowntime(state) / (OCS_SERVERS.length * state.t);
    return Math.max(0, Math.min(100, ratio * 100));
  }

  // Uptime rounded down to three decimals, so 99.8999 never shows as 99.9.
  function ocsFloorUptime(uptime) {
    return Math.floor(uptime * 1000 + 1e-7) / 1000;
  }

  function ocsFormatUptime(uptime) {
    var floored = ocsFloorUptime(uptime);
    return floored.toFixed(3).replace(/\.?0+$/, '') + '%';
  }

  function ocsGrade(uptime) {
    var shown = ocsFloorUptime(uptime);
    for (var i = 0; i < OCS_GRADES.length - 1; i++) {
      if (shown >= OCS_GRADES[i].min) {
        return OCS_GRADES[i];
      }
    }
    return OCS_GRADES[OCS_GRADES.length - 1];
  }

  // The wall clock of the shift at time t: 22:00 to 06:00.
  function ocsClockText(t) {
    var minutes = OCS_CLOCK_START_MIN + Math.floor(t * OCS_GAME_PER_MS / 60);
    return ocsPad2(Math.floor(minutes / 60) % 24) + ':' + ocsPad2(minutes % 60);
  }

  // A real duration in ms as shift time: "40 s", "4 min", "1 h 5 min".
  function ocsFormatDuration(ms) {
    var seconds = Math.round(ms * OCS_GAME_PER_MS);
    if (seconds < 60) {
      return seconds + ' s';
    }
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return minutes + ' min';
    }
    return Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min';
  }

  function ocsOpenCount(state) {
    return state.servers.filter(function (server) {
      return server.st !== 'ok';
    }).length;
  }

  function ocsRole(index) {
    return OCS_SERVERS[index].name.split('-')[0];
  }

  // The first upstream of server i that is down, or -1.
  function ocsDownUpstream(state, i) {
    var ups = OCS_SERVERS[i].upstream;
    for (var k = 0; k < ups.length; k++) {
      if (state.servers[ups[k]].st === 'down') {
        return ups[k];
      }
    }
    return -1;
  }

  // What is wrong with server s (index i), as log text.
  function ocsProblemText(s) {
    return s.from === null ? OCS_KINDS[s.kind].text : 'lost connection to ' + OCS_SERVERS[s.from].name;
  }

  function ocsAddLog(state, entry, events) {
    state.log.push(entry);
    if (state.log.length > OCS_LOG_MAX) {
      state.log.splice(0, state.log.length - OCS_LOG_MAX);
    }
    events.push(entry);
  }

  // Raises an incident of kind on server i (from: the upstream index of a
  // cascade, or null).
  function ocsRaise(state, i, kind, from, events) {
    var s = state.servers[i];
    var sla = ocsSlaFor(state.level, state.t);
    s.st = 'alert';
    s.kind = kind;
    s.from = from;
    s.left = sla;
    s.sla = sla;
    s.since = state.t;
    s.outage = 0;
    s.cascadeAt = null;
    s.cascadeFrom = null;
    state.stats.incidents++;
    if (from === null) {
      ocsAddLog(state, [state.t, i, 'alert', kind, 0], events);
    } else {
      state.stats.cascades++;
      ocsAddLog(state, [state.t, i, 'cascade', kind, from], events);
    }
  }

  // One OCS_TICK_MS step of the shift: downtime and SLA timers, breaches,
  // cascades, a new incident when one is due, and the end of the shift.
  // Mutates state; returns the log entries it added.
  function ocsTick(state, rnd) {
    var events = [];
    if (ocsIsOver(state)) {
      return events;
    }
    var cfg = OCS_LEVELS[state.level];
    var servers = state.servers;
    state.t += OCS_TICK_MS;

    servers.forEach(function (s, i) {
      if (s.st === 'down') {
        s.down += OCS_TICK_MS;
        s.outage += OCS_TICK_MS;
      } else if (s.st === 'alert') {
        s.left -= OCS_TICK_MS;
        if (s.left <= 0) {
          s.left = 0;
          s.st = 'down';
          s.outage = 0;
          state.stats.breaches++;
          ocsAddLog(state, [state.t, i, 'breach', s.kind, s.sla], events);
        }
      }
    });

    // Due cascades fire while their upstream is still down.
    servers.forEach(function (s, i) {
      if (s.cascadeAt !== null && s.cascadeAt <= state.t) {
        var from = s.cascadeFrom;
        s.cascadeAt = null;
        s.cascadeFrom = null;
        if (s.st === 'ok' && servers[from].st === 'down') {
          ocsRaise(state, i, 'restart', from, events);
        }
      }
    });
    // A healthy server with a down upstream gets its alert after the delay.
    servers.forEach(function (s, i) {
      if (s.st === 'ok' && s.cascadeAt === null) {
        var up = ocsDownUpstream(state, i);
        if (up !== -1) {
          s.cascadeAt = state.t + cfg.cascadeMs;
          s.cascadeFrom = up;
        }
      }
    });

    if (state.t >= state.nextSpawn) {
      var free = [];
      servers.forEach(function (s, i) {
        if (s.st === 'ok') {
          free.push(i);
        }
      });
      if (free.length) {
        var target = free[ocsPick(free.length, rnd)];
        var kinds = OCS_SERVERS[target].kinds;
        ocsRaise(state, target, kinds[ocsPick(kinds.length, rnd)], null, events);
      }
      state.nextSpawn = state.t + ocsRoundToTick(ocsSpawnInterval(state.level, state.t) * (0.6 + 0.8 * rnd()));
    }

    if (state.t >= OCS_SHIFT_MS) {
      state.t = OCS_SHIFT_MS;
      ocsAddLog(state, [state.t, -1, 'end', null, 0], events);
    }
    return events;
  }

  // The player's action on server i. Returns { result, entry }: result is
  // 'over', 'invalid', 'healthy' (nothing to fix, nothing changes), 'fix',
  // 'restore' (a down server back up) or 'wrong' (OCS_PENALTY_MS downtime).
  function ocsApply(state, i, action) {
    if (ocsIsOver(state)) {
      return { result: 'over', entry: null };
    }
    if (!ocsIsIndex(i) || !ocsIsAction(action)) {
      return { result: 'invalid', entry: null };
    }
    var s = state.servers[i];
    if (s.st === 'ok') {
      return { result: 'healthy', entry: null };
    }
    var events = [];
    if (s.kind !== action) {
      s.down += OCS_PENALTY_MS;
      state.stats.wrong++;
      ocsAddLog(state, [state.t, i, 'wrong', action, OCS_PENALTY_MS], events);
      return { result: 'wrong', entry: events[0] };
    }
    if (s.st === 'down') {
      state.stats.restored++;
      if (s.outage > state.stats.worstMs) {
        state.stats.worstMs = s.outage;
        state.stats.worst = i;
      }
      ocsAddLog(state, [state.t, i, 'restore', action, s.outage], events);
    } else {
      state.stats.fixMs += state.t - s.since;
      ocsAddLog(state, [state.t, i, 'fix', action, state.t - s.since], events);
    }
    state.stats.fixed++;
    var down = s.down;
    state.servers[i] = ocsBlankServer();
    state.servers[i].down = down;
    // Its dependents' pending alerts are off (another down upstream
    // schedules a new one on the next tick).
    state.servers.forEach(function (other) {
      if (other.cascadeFrom === i) {
        other.cascadeAt = null;
        other.cascadeFrom = null;
      }
    });
    return { result: events[0][2], entry: events[0] };
  }

  // The simulation step: input null runs one tick (result 'tick', or 'end'
  // on the tick that ends the shift); input { server, action } applies an
  // action (result as ocsApply). Returns { result, events }.
  function ocsStep(state, input, rnd) {
    if (!input) {
      var events = ocsTick(state, rnd);
      var ended = events.length > 0 && events[events.length - 1][2] === 'end';
      return { result: ended ? 'end' : 'tick', events: events };
    }
    var out = ocsApply(state, input.server, input.action);
    return { result: out.result, events: out.entry ? [out.entry] : [] };
  }

  // A rack index moved one step (left, right, up, down), stopping at edges.
  function ocsMoveIndex(index, dir) {
    var delta = OCS_MOVES[dir];
    var col = Math.max(0, Math.min(OCS_COLS - 1, index % OCS_COLS + delta[0]));
    var row = Math.max(0, Math.min(OCS_ROWS - 1, Math.floor(index / OCS_COLS) + delta[1]));
    return row * OCS_COLS + col;
  }

  // How a server's tile looks: { text, timer, fill (percent), label }.
  function ocsTileView(s, i) {
    var name = OCS_SERVERS[i].name;
    if (s.st === 'ok') {
      return { text: 'OK', timer: '', fill: 0, label: name + ': healthy' };
    }
    var tag = s.from === null ? OCS_KINDS[s.kind].tag : 'NO ' + ocsRole(s.from).toUpperCase();
    var problem = ocsProblemText(s);
    if (s.st === 'down') {
      var downFor = Math.floor(s.outage * OCS_GAME_PER_MS / 60);
      return { text: 'DOWN', timer: downFor + 'm', fill: 100, label: name + ': DOWN, ' + problem + ', down for ' + downFor + ' min' };
    }
    var left = Math.ceil(s.left * OCS_GAME_PER_MS / 60);
    return {
      text: tag,
      timer: left + 'm',
      fill: Math.round(1000 * s.left / s.sla) / 10,
      label: name + ': ' + problem + ', ' + left + ' min of SLA left'
    };
  }

  // One log entry as a postmortem line.
  function ocsLogLine(entry) {
    var time = ocsClockText(entry[0]);
    var code = entry[2];
    var kind = entry[3];
    var n = entry[4];
    if (code === 'start') {
      return time + ' shift started, the pager is live';
    }
    if (code === 'end') {
      return time + ' shift over, pager handed to the day team';
    }
    var name = OCS_SERVERS[entry[1]].name;
    if (code === 'alert') {
      return time + ' ALERT ' + name + ': ' + OCS_KINDS[kind].text;
    }
    if (code === 'cascade') {
      return time + ' ALERT ' + name + ': lost connection to ' + OCS_SERVERS[n].name;
    }
    if (code === 'breach') {
      return time + ' DOWN ' + name + ': SLA of ' + ocsFormatDuration(n) + ' breached';
    }
    if (code === 'fix') {
      return time + ' FIXED ' + name + ': ' + kind + ' in ' + ocsFormatDuration(n);
    }
    if (code === 'restore') {
      return time + ' RESTORED ' + name + ': ' + kind + ' after ' + ocsFormatDuration(n) + ' down';
    }
    return time + ' WRONG ' + name + ': ' + kind + ' did not help, +' + ocsFormatDuration(n) + ' downtime';
  }

  // The status line for what a tick raised: the last breach or cascade.
  function ocsEventsMessage(events) {
    var message = '';
    events.forEach(function (entry) {
      var name = entry[1] >= 0 ? OCS_SERVERS[entry[1]].name : '';
      if (entry[2] === 'breach') {
        message = 'SLA breached: ' + name + ' is DOWN. Use ' + entry[3] + ' to bring it back.';
      } else if (entry[2] === 'cascade') {
        message = 'Cascade: ' + OCS_SERVERS[entry[4]].name + ' is down, so ' + name + ' lost its connection.';
      }
    });
    return message;
  }

  // The postmortem of a shift: { uptime, uptimeText, grade, summary, lines,
  // text } (text: the whole report as plain text for the clipboard).
  function ocsReport(state) {
    var stats = state.stats;
    var uptime = ocsFloorUptime(ocsUptime(state));
    var grade = ocsGrade(uptime);
    var worstMs = stats.worstMs;
    var worst = stats.worst;
    state.servers.forEach(function (s, i) {
      if (s.st === 'down' && s.outage > worstMs) {
        worstMs = s.outage;
        worst = i;
      }
    });
    var fixes = stats.fixed - stats.restored;
    var parts = [
      stats.incidents + ' incidents (' + stats.cascades + ' cascades)',
      stats.fixed + ' fixed' + (fixes > 0 ? ', mean time to fix ' + ocsFormatDuration(stats.fixMs / fixes) : ''),
      stats.breaches + ' SLA breaches',
      stats.wrong + ' wrong actions',
      ocsOpenCount(state) + ' open at handover',
      'total downtime ' + ocsFormatDuration(ocsDowntime(state))
    ];
    if (worst !== -1) {
      parts.push('longest outage ' + OCS_SERVERS[worst].name + ', ' + ocsFormatDuration(worstMs));
    }
    var summary = parts.join(' · ');
    var lines = state.log.map(ocsLogLine);
    var uptimeText = ocsFormatUptime(uptime);
    var text = [
      'On-Call Shift #' + state.shiftNo + ' (' + OCS_LEVELS[state.level].label + ') postmortem',
      'Uptime ' + uptimeText + ' (' + grade.name + ')',
      summary,
      'Timeline:'
    ].concat(lines).join('\n');
    return { uptime: uptime, uptimeText: uptimeText, grade: grade, summary: summary, lines: lines, text: text };
  }

  // ── Parsing saves (pure) ──────────────────────────────────────────────────

  function ocsIsShiftTime(value) {
    return ocsIsNumber(value) && value >= 0 && value <= OCS_SHIFT_MS;
  }

  function ocsIsLogEntry(entry) {
    if (!Array.isArray(entry) || entry.length !== 5 || !ocsIsShiftTime(entry[0]) || !ocsIsNumber(entry[4]) || entry[4] < 0) {
      return false;
    }
    var code = entry[2];
    if (code === 'start' || code === 'end') {
      return entry[1] === -1;
    }
    if (!ocsIsIndex(entry[1]) || !ocsIsAction(entry[3])) {
      return false;
    }
    if (code === 'cascade') {
      return OCS_SERVERS[entry[1]].upstream.indexOf(entry[4]) !== -1;
    }
    return ['alert', 'breach', 'fix', 'restore', 'wrong'].indexOf(code) !== -1;
  }

  // A saved server (index i) as a clean server at shift time t, field by
  // field: an unknown status or kind leaves it healthy, odd timers get the
  // level's SLA.
  function ocsParseServer(raw, i, t, level) {
    var s = ocsBlankServer();
    if (!raw || typeof raw !== 'object') {
      return s;
    }
    s.down = ocsCount(raw.down);
    var ups = OCS_SERVERS[i].upstream;
    if ((raw.st === 'alert' || raw.st === 'down') && ocsIsAction(raw.kind)) {
      s.st = raw.st;
      s.kind = raw.kind;
      s.from = ups.indexOf(raw.from) !== -1 ? raw.from : null;
      s.sla = ocsIsNumber(raw.sla) && raw.sla > 0 && raw.sla <= OCS_MAX_WAIT_MS ? ocsRoundToTick(raw.sla) : ocsSlaFor(level, t);
      s.left = raw.st === 'alert' && ocsIsNumber(raw.left) && raw.left > 0 && raw.left <= s.sla ? ocsRoundToTick(raw.left) : s.sla;
      if (raw.st === 'down') {
        s.left = 0;
        s.outage = Math.min(ocsCount(raw.outage), s.down);
      }
      s.since = ocsIsNumber(raw.since) && raw.since >= 0 && raw.since <= t ? raw.since : t;
    } else if (ocsIsNumber(raw.cascadeAt) && raw.cascadeAt >= t && raw.cascadeAt <= t + OCS_MAX_WAIT_MS && ups.indexOf(raw.cascadeFrom) !== -1) {
      s.cascadeAt = raw.cascadeAt;
      s.cascadeFrom = raw.cascadeFrom;
    }
    return s;
  }

  // A saved shift (JSON text) as a clean state, or null when it is not a
  // JSON object at all. Every field falls back on its own: an unknown level
  // is Normal, an odd clock 0, a broken server list a healthy rack.
  function ocsParseSave(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }
    var state = ocsNewShift(data.level, Math.max(1, ocsCount(data.shiftNo)));
    var t = ocsIsShiftTime(data.t) ? Math.floor(data.t / OCS_TICK_MS) * OCS_TICK_MS : 0;
    state.t = t;
    state.nextSpawn = ocsIsNumber(data.nextSpawn) && data.nextSpawn > t && data.nextSpawn <= t + OCS_MAX_WAIT_MS ?
      ocsRoundToTick(data.nextSpawn) : t + OCS_FIRST_SPAWN_MS;
    if (Array.isArray(data.servers) && data.servers.length === OCS_SERVERS.length) {
      state.servers = data.servers.map(function (raw, i) {
        return ocsParseServer(raw, i, t, state.level);
      });
    }
    var stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
    Object.keys(state.stats).forEach(function (key) {
      state.stats[key] = ocsCount(stats[key]);
    });
    state.stats.worst = ocsIsIndex(stats.worst) && state.stats.worstMs > 0 ? stats.worst : -1;
    if (Array.isArray(data.log)) {
      state.log = data.log.filter(ocsIsLogEntry).slice(-OCS_LOG_MAX);
    }
    return state;
  }

  function ocsIsUptime(value) {
    return ocsIsNumber(value) && value >= 0 && value <= 100;
  }

  // ocs-best: { easy, normal, hard }, each a percentage or null.
  function ocsParseBest(text) {
    var data = null;
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = null;
    }
    var best = {};
    Object.keys(OCS_LEVELS).forEach(function (level) {
      var value = data && typeof data === 'object' ? data[level] : null;
      best[level] = ocsIsUptime(value) ? ocsFloorUptime(value) : null;
    });
    return best;
  }

  // ocs-history: the last shifts, oldest first; broken entries are dropped.
  function ocsParseHistory(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return [];
    }
    if (!Array.isArray(data)) {
      return [];
    }
    return data.filter(function (entry) {
      return entry && typeof entry === 'object' && ocsCount(entry.n) >= 1 && ocsIsLevel(entry.level) && ocsIsUptime(entry.uptime);
    }).map(function (entry) {
      return {
        n: ocsCount(entry.n),
        level: entry.level,
        uptime: ocsFloorUptime(entry.uptime),
        incidents: ocsCount(entry.incidents),
        breaches: ocsCount(entry.breaches),
        wrong: ocsCount(entry.wrong)
      };
    }).slice(-OCS_HISTORY_MAX);
  }

  function ocsHistoryLine(entry) {
    return '#' + entry.n + ' ' + OCS_LEVELS[entry.level].label + ': ' + ocsFormatUptime(entry.uptime) +
      ' (' + ocsGrade(entry.uptime).name + '), ' + entry.incidents + ' incidents, ' +
      entry.breaches + ' breaches, ' + entry.wrong + ' wrong actions';
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // The first failure shows a warning naming the browser's error.
  function ocsStorageProblem(error) {
    if (ocsRuntime.storageWarned) {
      return;
    }
    ocsRuntime.storageWarned = true;
    var name = error && error.name ? error.name : 'Error';
    var what = name === 'QuotaExceededError' ? 'Storage is full' : 'Storage is blocked';
    var warning = ocsRuntime.els.warning;
    warning.textContent = what + ' (' + name + '): this shift, the best uptime and the history will not be saved.';
    warning.hidden = false;
  }

  function ocsStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      ocsStorageProblem(error);
      return null;
    }
  }

  function ocsStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      ocsStorageProblem(error);
    }
  }

  function ocsSave() {
    ocsStorageSet(OCS_STATE_KEY, JSON.stringify(ocsState));
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function ocsSetStatus(text) {
    ocsRuntime.els.status.textContent = text;
  }

  function ocsShowToast(message) {
    var toast = ocsRuntime.els.toast;
    clearTimeout(ocsRuntime.toastTimeout);
    toast.textContent = message;
    toast.classList.add('ocs-show');
    ocsRuntime.toastTimeout = setTimeout(ocsHideToast, OCS_TOAST_MS);
  }

  function ocsHideToast() {
    ocsRuntime.toastTimeout = null;
    ocsRuntime.els.toast.classList.remove('ocs-show');
  }

  function ocsSpan(className, text) {
    var span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  }

  // The twelve tiles, built once; ocsRenderRack updates them in place.
  function ocsBuildRack() {
    var rack = ocsRuntime.els.rack;
    OCS_SERVERS.forEach(function (server, i) {
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.id = 'ocs-srv-' + i;
      tile.className = 'ocs-tile';
      tile.setAttribute('tabindex', '-1');
      tile.setAttribute('data-server', String(i));
      var head = ocsSpan('ocs-tile-head', '');
      head.appendChild(ocsSpan('ocs-tile-led', ''));
      head.appendChild(ocsSpan('ocs-tile-name', server.name));
      var state = ocsSpan('ocs-tile-state', 'OK');
      var timer = ocsSpan('ocs-tile-timer', '');
      var bar = ocsSpan('ocs-tile-bar', '');
      var fill = ocsSpan('ocs-tile-fill', '');
      bar.appendChild(fill);
      tile.appendChild(head);
      tile.appendChild(state);
      tile.appendChild(timer);
      tile.appendChild(bar);
      rack.appendChild(tile);
      ocsRuntime.tiles.push({ el: tile, state: state, timer: timer, fill: fill });
    });
  }

  function ocsRenderRack() {
    var runtime = ocsRuntime;
    runtime.els.rack.setAttribute('aria-activedescendant', 'ocs-srv-' + runtime.cursor);
    ocsState.servers.forEach(function (s, i) {
      var tile = runtime.tiles[i];
      var view = ocsTileView(s, i);
      var classes = ['ocs-tile', 'ocs-tile-' + s.st];
      if (s.kind) {
        classes.push('ocs-kind-' + s.kind);
      }
      if (i === runtime.cursor) {
        classes.push('ocs-tile-cursor');
      }
      if (i === runtime.picked) {
        classes.push('ocs-tile-picked');
      }
      tile.el.className = classes.join(' ');
      tile.el.setAttribute('aria-label', view.label);
      tile.state.textContent = view.text;
      tile.timer.textContent = view.timer;
      tile.fill.style.width = view.fill + '%';
    });
  }

  function ocsRenderHud() {
    var els = ocsRuntime.els;
    var uptime = ocsUptime(ocsState);
    var best = ocsBest[ocsState.level];
    var percent = Math.round(1000 * ocsProgress(ocsState.t)) / 10;
    els.clock.textContent = ocsClockText(ocsState.t);
    els.uptime.textContent = ocsFormatUptime(uptime);
    els.uptime.className = 'ocs-stat-value ocs-nines-' + ocsGrade(uptime).nines;
    els.open.textContent = String(ocsOpenCount(ocsState));
    els.best.textContent = best === null ? '--' : ocsFormatUptime(best);
    els.progressFill.style.width = percent + '%';
    els.progress.setAttribute('aria-valuenow', String(Math.round(percent)));
  }

  function ocsRenderActions() {
    OCS_ACTIONS.forEach(function (action) {
      var button = ocsRuntime.els.acts[action];
      var armed = ocsRuntime.armed === action;
      button.classList.toggle('ocs-act-armed', armed);
      button.setAttribute('aria-pressed', armed ? 'true' : 'false');
    });
  }

  function ocsRenderControls() {
    var els = ocsRuntime.els;
    var phase = ocsRuntime.phase;
    els.pause.textContent = OCS_PAUSE_LABEL[phase];
    els.pause.disabled = phase === 'over';
    els.overlay.hidden = phase === 'running' || phase === 'over';
    els.overlayTitle.textContent = phase === 'paused' ? 'Paused' : 'Ready';
    els.overlayText.textContent = phase === 'paused' ? OCS_TEXT.overlayPaused : OCS_TEXT.overlayReady;
  }

  // The last OCS_FEED_LINES log lines, redrawn only when the log changed.
  function ocsRenderFeed() {
    var log = ocsState.log;
    var last = log[log.length - 1];
    var key = log.length + ':' + (last ? last.join(',') : '');
    if (key === ocsRuntime.feedKey) {
      return;
    }
    ocsRuntime.feedKey = key;
    var feed = ocsRuntime.els.feed;
    feed.innerHTML = '';
    log.slice(-OCS_FEED_LINES).forEach(function (entry) {
      var item = document.createElement('li');
      item.className = 'ocs-feed-line ocs-log-' + entry[2];
      item.textContent = ocsLogLine(entry);
      feed.appendChild(item);
    });
  }

  // The postmortem panel: shown once the shift is over, drawn once per shift.
  function ocsRenderPostmortem() {
    var els = ocsRuntime.els;
    var over = ocsRuntime.phase === 'over';
    els.postmortem.hidden = !over;
    if (!over || ocsRuntime.reportFor === ocsState) {
      return;
    }
    ocsRuntime.reportFor = ocsState;
    var report = ocsReport(ocsState);
    els.pmUptime.textContent = report.uptimeText;
    els.pmGrade.textContent = report.grade.name;
    els.pmGrade.className = 'ocs-pm-grade ocs-nines-' + report.grade.nines;
    els.pmNote.textContent = report.grade.note;
    els.pmStats.textContent = report.summary;
    els.pmLog.innerHTML = '';
    report.lines.forEach(function (line, k) {
      var item = document.createElement('li');
      item.className = 'ocs-pm-line ocs-log-' + ocsState.log[k][2];
      item.textContent = line;
      els.pmLog.appendChild(item);
    });
  }

  function ocsRenderHistory() {
    var list = ocsRuntime.els.history;
    list.innerHTML = '';
    if (!ocsHistory.length) {
      var empty = document.createElement('li');
      empty.className = 'ocs-history-empty';
      empty.textContent = OCS_TEXT.noHistory;
      list.appendChild(empty);
      return;
    }
    ocsHistory.slice().reverse().forEach(function (entry) {
      var item = document.createElement('li');
      item.className = 'ocs-history-line ocs-nines-' + ocsGrade(entry.uptime).nines;
      item.textContent = ocsHistoryLine(entry);
      list.appendChild(item);
    });
  }

  function ocsRender() {
    ocsRenderHud();
    ocsRenderRack();
    ocsRenderActions();
    ocsRenderControls();
    ocsRenderFeed();
    ocsRenderPostmortem();
  }

  // ── Clock and game flow ───────────────────────────────────────────────────

  function ocsStartClock() {
    ocsStopClock();
    ocsRuntime.interval = setInterval(ocsOnTick, OCS_TICK_MS);
  }

  function ocsStopClock() {
    clearInterval(ocsRuntime.interval);
    ocsRuntime.interval = null;
  }

  // One interval callback is one tick (no catching up after a slow tab).
  function ocsOnTick() {
    if (ocsRuntime.phase !== 'running') {
      return;
    }
    var out = ocsStep(ocsState, null, Math.random);
    var message = ocsEventsMessage(out.events);
    if (message) {
      ocsSetStatus(message);
    }
    if (out.result === 'end') {
      ocsFinish();
      return;
    }
    ocsRuntime.ticks++;
    if (ocsRuntime.ticks % OCS_SAVE_EVERY_TICKS === 0) {
      ocsSave();
    }
    ocsRender();
  }

  // Starts a ready shift or resumes a paused one.
  function ocsResume() {
    var phase = ocsRuntime.phase;
    if (phase !== 'ready' && phase !== 'paused') {
      return;
    }
    ocsRuntime.phase = 'running';
    ocsStartClock();
    ocsSetStatus(phase === 'ready' ? OCS_TEXT.started : OCS_TEXT.resumed);
    ocsShowToast(phase === 'ready' ? 'Shift started' : 'Resumed');
    ocsRender();
    ocsSave();
  }

  function ocsPause(reason) {
    if (ocsRuntime.phase !== 'running') {
      return;
    }
    ocsRuntime.phase = 'paused';
    ocsStopClock();
    ocsSetStatus(reason === 'hidden' ? OCS_TEXT.pausedHidden : OCS_TEXT.paused);
    ocsShowToast('Paused');
    ocsRender();
    ocsSave();
  }

  function ocsTogglePause() {
    if (ocsRuntime.phase === 'running') {
      ocsPause('manual');
    } else {
      ocsResume();
    }
  }

  // A fresh shift of a level: running at once (run) or waiting for Start. It
  // takes the next number only when the clock of the old one ran.
  function ocsBeginShift(level, run) {
    ocsStopClock();
    ocsState = ocsNewShift(level, ocsState.t > 0 ? ocsState.shiftNo + 1 : ocsState.shiftNo);
    ocsRuntime.phase = 'ready';
    ocsRuntime.ticks = 0;
    ocsRuntime.armed = null;
    ocsRuntime.picked = null;
    ocsRuntime.els.share.hidden = true;
    ocsRuntime.els.level.value = ocsState.level;
    ocsSetStatus(OCS_TEXT.ready);
    if (run) {
      ocsResume();
    } else {
      ocsRender();
      ocsSave();
    }
  }

  // The end of the shift: best uptime, history, postmortem.
  function ocsFinish() {
    ocsStopClock();
    ocsRuntime.phase = 'over';
    ocsRuntime.armed = null;
    ocsRuntime.picked = null;
    var report = ocsReport(ocsState);
    var level = ocsState.level;
    var stats = ocsState.stats;
    var isBest = ocsBest[level] === null || report.uptime > ocsBest[level];
    if (isBest) {
      ocsBest[level] = report.uptime;
      ocsStorageSet(OCS_BEST_KEY, JSON.stringify(ocsBest));
    }
    ocsHistory = ocsHistory.concat([{
      n: ocsState.shiftNo,
      level: level,
      uptime: report.uptime,
      incidents: stats.incidents,
      breaches: stats.breaches,
      wrong: stats.wrong
    }]).slice(-OCS_HISTORY_MAX);
    ocsStorageSet(OCS_HISTORY_KEY, JSON.stringify(ocsHistory));
    ocsSave();
    ocsSetStatus('Shift over: ' + report.uptimeText + ' uptime (' + report.grade.name + '). The postmortem is below.');
    ocsShowToast('Shift over: ' + report.uptimeText + (isBest ? ', a new best' : ''));
    ocsRender();
    ocsRenderHistory();
  }

  // ── Player actions ────────────────────────────────────────────────────────

  function ocsApplyMessage(result, name, action, problem, entry) {
    if (result === 'healthy') {
      return name + ' is healthy: nothing to ' + action + '.';
    }
    if (result === 'fix') {
      return 'Fixed: ' + action + ' on ' + name + ' worked in ' + ocsFormatDuration(entry[4]) + '.';
    }
    if (result === 'restore') {
      return name + ' is back up after ' + ocsFormatDuration(entry[4]) + ' down.';
    }
    return 'Wrong action: ' + action + ' does not fix "' + problem + '" on ' + name + ', +' + ocsFormatDuration(entry[4]) + ' downtime.';
  }

  function ocsDoApply(i, action) {
    var phase = ocsRuntime.phase;
    if (phase !== 'running') {
      ocsSetStatus(OCS_TEXT.notRunning[phase]);
      return;
    }
    var s = ocsState.servers[i];
    var problem = s.st === 'ok' ? '' : ocsProblemText(s);
    var out = ocsStep(ocsState, { server: i, action: action }, Math.random);
    ocsSetStatus(ocsApplyMessage(out.result, OCS_SERVERS[i].name, action, problem, out.events[0]));
    ocsSave();
    ocsRender();
  }

  // An action chosen by button or key: applied to a picked server, or armed
  // (a click on the armed action disarms it; a key always arms).
  function ocsChooseAction(action, fromKey) {
    var runtime = ocsRuntime;
    if (runtime.phase === 'over') {
      return;
    }
    if (runtime.picked !== null) {
      var target = runtime.picked;
      runtime.picked = null;
      ocsDoApply(target, action);
      return;
    }
    runtime.armed = fromKey || runtime.armed !== action ? action : null;
    ocsRenderActions();
    ocsSetStatus(runtime.armed ?
      'Armed: ' + action + '. Tap a server, or press Enter on the rack, to apply it.' : OCS_TEXT.disarmed);
  }

  function ocsChooseServer(i) {
    var runtime = ocsRuntime;
    if (runtime.phase === 'over') {
      ocsSetStatus(OCS_TEXT.notRunning.over);
      return;
    }
    runtime.cursor = i;
    if (runtime.armed) {
      ocsDoApply(i, runtime.armed);
      return;
    }
    runtime.picked = runtime.picked === i ? null : i;
    ocsRenderRack();
    ocsSetStatus(runtime.picked === null ? OCS_TEXT.cleared :
      OCS_SERVERS[i].name + ' picked: choose an action (1 to 4) for it.');
  }

  function ocsApplyAtCursor() {
    if (!ocsRuntime.armed) {
      ocsSetStatus(OCS_TEXT.chooseFirst);
      return;
    }
    ocsDoApply(ocsRuntime.cursor, ocsRuntime.armed);
  }

  function ocsClearSelection() {
    ocsRuntime.armed = null;
    ocsRuntime.picked = null;
    ocsRenderActions();
    ocsRenderRack();
    ocsSetStatus(OCS_TEXT.cleared);
  }

  function ocsMoveCursor(dir) {
    ocsRuntime.cursor = ocsMoveIndex(ocsRuntime.cursor, dir);
    ocsRenderRack();
  }

  function ocsShowShare(text) {
    var share = ocsRuntime.els.share;
    share.value = text;
    share.hidden = false;
    share.focus();
    share.select();
    ocsSetStatus(OCS_TEXT.noClipboard);
  }

  function ocsCopyReport() {
    var text = ocsReport(ocsState).text;
    var clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text).then(function () {
        ocsShowToast(OCS_TEXT.copied);
      }, function () {
        ocsShowShare(text);
      });
    } else {
      ocsShowShare(text);
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  function ocsIsInside(node, container) {
    for (; node; node = node.parentNode) {
      if (node === container) {
        return true;
      }
    }
    return false;
  }

  function ocsIsField(target) {
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  // The game's name for a key: 'pause', 'apply', 'escape', a move or an
  // action; null for any other key. Digits also by their physical key, so
  // AZERTY and non-Latin layouts work.
  function ocsKeyAction(event) {
    var key = event.key;
    if (key === ' ' || key === 'Spacebar') {
      return 'pause';
    }
    if (key === 'Enter') {
      return 'apply';
    }
    if (key === 'Escape') {
      return 'escape';
    }
    if (ocsHasOwn(OCS_KEY_MOVES, key)) {
      return OCS_KEY_MOVES[key];
    }
    var digit = /^[1-4]$/.test(key) ? key : String(event.code).replace(/^(Digit|Numpad)([1-4])$/, '$2');
    return /^[1-4]$/.test(digit) ? OCS_ACTIONS[digit - 1] : null;
  }

  // Keys only while the focus is in the game and the shift is not over;
  // Space, Enter and the arrows only on the rack (see the header).
  function ocsHandleKeydown(event) {
    var els = ocsRuntime.els;
    var target = event.target;
    if (ocsRuntime.phase === 'over' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented ||
      event.isComposing || !ocsIsInside(target, els.root) || ocsIsField(target)) {
      return;
    }
    var action = ocsKeyAction(event);
    var move = ocsHasOwn(OCS_MOVES, action);
    if (!action || ((move || action === 'pause' || action === 'apply') && !ocsIsInside(target, els.rack))) {
      return;
    }
    event.preventDefault();
    if (event.repeat && !move) {
      return;
    }
    if (move) {
      ocsMoveCursor(action);
    } else if (action === 'pause') {
      ocsTogglePause();
    } else if (action === 'apply') {
      ocsApplyAtCursor();
    } else if (action === 'escape') {
      ocsClearSelection();
    } else {
      ocsChooseAction(action, true);
    }
  }

  // The tile index of a click inside the rack, or -1 (the rack's padding).
  function ocsTileIndex(node) {
    for (; node && node !== ocsRuntime.els.rack; node = node.parentNode) {
      var value = node.getAttribute('data-server');
      if (value !== null) {
        return parseInt(value, 10);
      }
    }
    return -1;
  }

  function ocsFocusRack() {
    ocsRuntime.els.rack.focus({ preventScroll: true });
  }

  function ocsHandleRackClick(event) {
    var i = ocsTileIndex(event.target);
    if (i === -1) {
      return;
    }
    ocsFocusRack();
    ocsChooseServer(i);
  }

  // A mouse or touch click on a game button hands the keys to the rack (a
  // clicked button keeps the focus in Chrome, and gets none in Safari); a
  // keyboard activation (detail 0) leaves the focus on the button.
  function ocsFocusRackOnPointer(event) {
    if (event.detail > 0) {
      ocsFocusRack();
    }
  }

  function ocsActionHandler(action) {
    return function (event) {
      ocsFocusRackOnPointer(event);
      ocsChooseAction(action, false);
    };
  }

  function ocsHandlePause(event) {
    ocsFocusRackOnPointer(event);
    ocsTogglePause();
  }

  function ocsSelectedLevel() {
    var value = ocsRuntime.els.level.value;
    return ocsIsLevel(value) ? value : 'normal';
  }

  function ocsHandleNewShift() {
    ocsBeginShift(ocsSelectedLevel(), true);
    ocsFocusRack();
  }

  // A level change: a shift under way (its clock has run) plays on and the
  // new level waits for New Shift; any other shift is replaced by one of the
  // new level, still running if it was.
  function ocsHandleLevel() {
    var level = ocsSelectedLevel();
    var phase = ocsRuntime.phase;
    if (ocsState.t > 0 && (phase === 'running' || phase === 'paused')) {
      var label = OCS_LEVELS[level].label;
      var current = OCS_LEVELS[ocsState.level].label;
      var shiftName = 'shift #' + ocsState.shiftNo;
      ocsSetStatus(level === ocsState.level ?
        label + ' again: ' + shiftName + ' plays on at ' + current + ', and so will the next one.' :
        label + ' applies from your next shift: ' + shiftName + ' plays on at ' + current +
        '. Press New Shift to switch to ' + label + ' now.');
      ocsShowToast('Next shift: ' + label);
      return;
    }
    ocsBeginShift(level, phase === 'running');
  }

  function ocsHandleOverlay() {
    ocsResume();
    ocsFocusRack();
  }

  function ocsHandleVisibility() {
    if (document.visibilityState === 'hidden') {
      ocsPause('hidden');
    }
  }

  function ocsBindEvents() {
    var els = ocsRuntime.els;
    els.newShift.addEventListener('click', ocsHandleNewShift);
    els.pmNew.addEventListener('click', ocsHandleNewShift);
    els.pause.addEventListener('click', ocsHandlePause);
    els.overlay.addEventListener('click', ocsHandleOverlay);
    els.level.addEventListener('change', ocsHandleLevel);
    els.rack.addEventListener('click', ocsHandleRackClick);
    OCS_ACTIONS.forEach(function (action) {
      els.acts[action].addEventListener('click', ocsActionHandler(action));
    });
    els.pmCopy.addEventListener('click', ocsCopyReport);
    document.addEventListener('keydown', ocsHandleKeydown);
    document.addEventListener('visibilitychange', ocsHandleVisibility);
    window.addEventListener('pagehide', ocsSave);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function ocsFindElements() {
    return {
      root: document.getElementById('ocs-root'),
      newShift: document.getElementById('ocs-new'),
      pause: document.getElementById('ocs-pause'),
      level: document.getElementById('ocs-level'),
      clock: document.getElementById('ocs-clock'),
      uptime: document.getElementById('ocs-uptime'),
      open: document.getElementById('ocs-open'),
      best: document.getElementById('ocs-best'),
      progress: document.getElementById('ocs-progress'),
      progressFill: document.getElementById('ocs-progress-fill'),
      rack: document.getElementById('ocs-rack'),
      overlay: document.getElementById('ocs-overlay'),
      overlayTitle: document.getElementById('ocs-overlay-title'),
      overlayText: document.getElementById('ocs-overlay-text'),
      acts: {
        cleanup: document.getElementById('ocs-act-cleanup'),
        restart: document.getElementById('ocs-act-restart'),
        scale: document.getElementById('ocs-act-scale'),
        renew: document.getElementById('ocs-act-renew')
      },
      status: document.getElementById('ocs-status'),
      warning: document.getElementById('ocs-warning'),
      feed: document.getElementById('ocs-feed'),
      postmortem: document.getElementById('ocs-postmortem'),
      pmUptime: document.getElementById('ocs-pm-uptime'),
      pmGrade: document.getElementById('ocs-pm-grade'),
      pmNote: document.getElementById('ocs-pm-note'),
      pmStats: document.getElementById('ocs-pm-stats'),
      pmLog: document.getElementById('ocs-pm-log'),
      pmNew: document.getElementById('ocs-pm-new'),
      pmCopy: document.getElementById('ocs-pm-copy'),
      share: document.getElementById('ocs-share'),
      history: document.getElementById('ocs-history'),
      toast: document.getElementById('ocs-toast')
    };
  }

  // Finds the elements, builds the rack, binds the controls once and
  // restores the saved shift (paused), or gets a fresh one ready.
  function ocsInit() {
    if (ocsRuntime.els) {
      return;
    }
    ocsRuntime.els = ocsFindElements();
    ocsBuildRack();
    ocsBindEvents();
    ocsBest = ocsParseBest(ocsStorageGet(OCS_BEST_KEY));
    ocsHistory = ocsParseHistory(ocsStorageGet(OCS_HISTORY_KEY));
    var raw = ocsStorageGet(OCS_STATE_KEY);
    var saved = ocsParseSave(raw);
    if (saved) {
      ocsState = saved;
      ocsRuntime.phase = ocsIsOver(saved) ? 'over' : saved.t > 0 ? 'paused' : 'ready';
    } else {
      ocsState = ocsNewShift('normal', 1);
      ocsRuntime.phase = 'ready';
    }
    var status = {
      ready: raw !== null && !saved ? 'The saved shift could not be read (not a JSON object): a fresh shift is ready.' : OCS_TEXT.ready,
      paused: OCS_TEXT.restored + ocsClockText(ocsState.t) + '. Press Resume or Space on the rack to continue.',
      over: 'Shift over: ' + ocsFormatUptime(ocsUptime(ocsState)) + ' uptime. The postmortem is below.'
    };
    ocsSetStatus(status[ocsRuntime.phase]);
    ocsRuntime.els.level.value = ocsState.level;
    ocsRender();
    ocsRenderHistory();
    ocsSave();
  }

  // Node (tests): export only, no init and no timers. Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ocsLevels: OCS_LEVELS,
      ocsServers: OCS_SERVERS,
      ocsKinds: OCS_KINDS,
      ocsActions: OCS_ACTIONS,
      ocsGrades: OCS_GRADES,
      ocsConfig: {
        tickMs: OCS_TICK_MS,
        shiftMs: OCS_SHIFT_MS,
        penaltyMs: OCS_PENALTY_MS,
        firstSpawnMs: OCS_FIRST_SPAWN_MS,
        logMax: OCS_LOG_MAX,
        historyMax: OCS_HISTORY_MAX,
        toastMs: OCS_TOAST_MS,
        cols: OCS_COLS
      },
      ocsRuntime: ocsRuntime,
      ocsGetState: function () { return ocsState; },
      ocsInit: ocsInit,
      ocsNewShift: ocsNewShift,
      ocsTick: ocsTick,
      ocsApply: ocsApply,
      ocsStep: ocsStep,
      ocsSpawnInterval: ocsSpawnInterval,
      ocsSlaFor: ocsSlaFor,
      ocsDowntime: ocsDowntime,
      ocsUptime: ocsUptime,
      ocsFloorUptime: ocsFloorUptime,
      ocsFormatUptime: ocsFormatUptime,
      ocsGrade: ocsGrade,
      ocsClockText: ocsClockText,
      ocsFormatDuration: ocsFormatDuration,
      ocsMoveIndex: ocsMoveIndex,
      ocsTileView: ocsTileView,
      ocsLogLine: ocsLogLine,
      ocsEventsMessage: ocsEventsMessage,
      ocsReport: ocsReport,
      ocsParseSave: ocsParseSave,
      ocsParseBest: ocsParseBest,
      ocsParseHistory: ocsParseHistory,
      ocsHistoryLine: ocsHistoryLine,
      ocsKeyAction: ocsKeyAction,
      ocsOnTick: ocsOnTick
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ocsInit);
  } else {
    ocsInit();
  }
})();
