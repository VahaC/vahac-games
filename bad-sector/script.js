// Bad Sector — script.js
// Prefix: bds-
// Dependencies: none.
//
// A brick breaker on an unrolled hard-disk platter.  The read head (the
// ball) bounces off the walls and the carriage (the paddle) and wears the
// sectors down: a sector holds 1 hit, a bad sector 2 or 3, and a read-only
// sector never breaks.  A broken sector flashes its LBA address.  Some
// sectors drop a bonus: RAID1 (a mirrored second head), ECC (a wide
// carriage for 12 s) or SLOW-SEEK (the heads at 60 % speed for 10 s).  A head
// that falls past the carriage is a reallocated sector on the SMART readout;
// the third one fails the drive.  A track with no sector left is "Surface
// scan complete" and the next track follows, with more rows and faster heads.
//
// Physics: bdsStep(sim, input, dt) is a pure function (no DOM, no clock):
// it returns the next state and leaves sim alone.  The heads move in
// sub-steps of at most half their radius, so even a head at the speed cap
// (or a long dt) never passes through a sector without touching it.  A head
// that touches sectors bounces off the nearest one, along the axis on which
// it overlaps least.  The page runs bdsStep at a fixed 120 steps a second
// from requestAnimationFrame with an accumulator; a frame never catches up
// more than 100 ms, so a tab shown again or a slow frame never runs a burst
// of piled-up steps.  The canvas only draws the state.
//
// Tracks: bdsGenerateGrid lays every track (row) out as a fragmented disk:
// files of 2-5 sectors (plain or bad) with free cells between them, and
// single read-only sectors.  Any sector the head could never reach (walled
// in by read-only sectors) is dropped.  Free play draws from Math.random;
// the Daily from the date.
//
// Daily disk: one track for everyone, built from the local date: FNV-1a of
// 'bds:' + YYYY-MM-DD seeds a mulberry32 generator (Math.random is never used
// for it).  Daily #1 is 2026-11-01, counted in UTC days so a daylight saving
// change never skips or repeats one.  One scored attempt per day: the
// attempt is written to bds-daily the moment it begins; a reload resumes it
// (a head in flight paused where it was) or shows its result, and Practice
// replays a finished Daily unscored.  A Daily left open across midnight
// finishes as the day it started; at local midnight the page shows the new
// day's Daily button and streak.  Streak = consecutive Daily numbers cleared.
// Share copies one plain-text line, or shows it selected for copying by hand.
//
// Controls: the carriage follows the mouse; a finger drags it from wherever
// it touches the canvas (the carriage moves as far as the finger, so the
// finger can stay in the strip below the carriage instead of on the field;
// a drag past a wall moves the anchor along, so the way back moves the
// carriage at once).
// A tap or a click launches, resumes or opens the next track.  Keys only
// while the canvas has the focus: Left / Right or A / D move, Space
// launches, P pauses.  Ctrl / Alt / Cmd combinations and keys typed anywhere
// else on the host page are left alone; a held key moves the carriage until
// it is let go, the canvas loses the focus or the window does.  The game
// pauses with the Pause button, P, and whenever the tab is hidden.
//
// Saves: bds-state (the free game: track, sectors, score, lives, bonuses,
// view), bds-best (best score and highest track), bds-daily (the Daily
// attempt, its result and the streak).  The heads in flight, their speed,
// the carriage and the falling bonuses are saved too: a game set aside (the
// other view, a reload) comes back paused where it was, so neither hands a
// lost head back.  Every field is checked on load and falls back on its own;
// storage that is blocked or full never stops the game, and the warning
// names each key that is not saved.
//
// New disk and Practice drop a scored free scan under way only on a second
// press of the same button within 4 s.
//
// Tabs: bds-daily is read again before every write; a record another tab
// saved since that is a later Daily (up to today), the same Daily finished,
// or the same attempt further along is taken over instead of overwritten,
// at once through the storage event too.  A new best is merged with the one
// on disk, so no tab erases another's.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser bdsInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var BDS_STATE_KEY = 'bds-state';
  var BDS_BEST_KEY = 'bds-best';
  var BDS_DAILY_KEY = 'bds-daily';
  var BDS_SAVE_VERSION = 1;

  // The field, in field units; the canvas has BDS_SCALE pixels per unit.
  var BDS_W = 360;
  var BDS_H = 480;
  var BDS_SCALE = 2;

  // The sector grid: tracks (rows) of sectors (columns).
  var BDS_COLS = 10;
  var BDS_ROWS = 8;
  var BDS_CELLS = BDS_COLS * BDS_ROWS;
  var BDS_GRID_X = 15;
  var BDS_GRID_Y = 64;
  var BDS_CELL_W = 33;
  var BDS_CELL_H = 16;
  var BDS_RO = 9;

  var BDS_PADDLE_Y = 424;
  var BDS_PADDLE_H = 10;
  var BDS_PADDLE_W = 64;
  var BDS_PADDLE_WIDE = 96;
  var BDS_PADDLE_SPEED = 420;

  var BDS_BALL_R = 5;
  var BDS_BASE_SPEED = 230;
  var BDS_LEVEL_SPEEDUP = 15;
  var BDS_HIT_SPEEDUP = 2;
  var BDS_MAX_SPEED = 460;
  var BDS_MAX_ANGLE = Math.PI / 3;
  var BDS_SERVE_ANGLE = Math.PI / 9;
  var BDS_MAX_SUBSTEPS = 256;
  var BDS_MAX_BALLS = 2;

  var BDS_POWERS = ['', 'raid', 'ecc', 'slow'];
  // The label on a falling capsule (short enough for BDS_DROP_W in BDS_FONT_BOLD).
  var BDS_DROP_LABELS = { raid: 'RAID1', ecc: 'ECC', slow: 'SLOW' };
  var BDS_POWER_TOASTS = {
    raid: 'RAID1: a mirrored second head.',
    ecc: 'ECC: a wide carriage for 12 s.',
    slow: 'SLOW-SEEK: the heads at 60 % speed for 10 s.'
  };
  var BDS_ECC_SECONDS = 12;
  var BDS_SLOW_SECONDS = 10;
  var BDS_SLOW_FACTOR = 0.6;
  var BDS_DROP_SPEED = 110;
  var BDS_DROP_W = 44;
  var BDS_DROP_H = 14;
  var BDS_FLASH_SECONDS = 0.9;

  // Canvas text, in field units: on a 320 px phone the platter is 294 px for
  // 360 units, so 12 units are 9.8 px and the LBA flash 11.4 px.
  var BDS_FONT = '12px monospace';
  var BDS_FONT_BOLD = 'bold 12px monospace';
  var BDS_FONT_FLASH = 'bold 14px monospace';

  var BDS_HIT_POINTS = 5;
  var BDS_BREAK_POINTS = 10;
  var BDS_POWER_POINTS = 25;
  var BDS_RAID_BONUS = 50;
  var BDS_CLEAR_POINTS = 100;

  var BDS_LIVES = 3;
  var BDS_MAX_LEVEL = 999;
  var BDS_GEN_TRIES = 20;
  var BDS_MIN_SECTORS = 12;
  var BDS_DAILY_LEVEL = 4;
  var BDS_DAILY_ROWS = 7;

  var BDS_STEP = 1 / 120;
  var BDS_STEP_MS = 1000 / 120;
  var BDS_MAX_FRAME_MS = 100;
  var BDS_TAP_SLOP = 10;

  var BDS_EPOCH = Date.UTC(2026, 10, 1);
  var BDS_DAY_MS = 86400000;
  var BDS_TOAST_MS = 2200;
  var BDS_CONFIRM_MS = 4000;
  var BDS_MIDNIGHT_SLACK_MS = 50;

  var BDS_KEYS = { arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', ' ': 'action', p: 'pause' };
  var BDS_CODES = { KeyA: 'left', KeyD: 'right', KeyP: 'pause', Space: 'action' };
  var BDS_STATUS_RANK = { playing: 0, won: 1, lost: 1 };
  var BDS_DAILY_PHASE = { playing: 'play', won: 'cleared', lost: 'over' };
  var BDS_DAILY_MARKS = { playing: '', won: ' ✓', lost: ' ✗' };
  var BDS_SYNC_VERBS = { playing: 'saved', won: 'cleared', lost: 'lost' };
  var BDS_SAVE_EVENTS = ['hit', 'break', 'power', 'lost', 'over', 'clear'];

  var BDS_COLORS = {
    bg: '#070b16',
    trackA: '#0d1424',
    trackB: '#101a2e',
    ruler: '#2a3a5c',
    label: '#64748b',
    ok: '#0e7490',
    okTop: '#22d3ee',
    bad: ['', '#ef4444', '#f59e0b', '#d97706'],
    ro: '#334155',
    roLine: '#64748b',
    text: '#e2e8f0',
    dark: '#0a0f1e',
    paddle: '#94a3b8',
    paddleWide: '#10b981',
    ball: '#e0f2fe',
    glow: '#22d3ee',
    drop: { raid: '#3b82f6', ecc: '#10b981', slow: '#a78bfa' },
    flash: '#fbbf24'
  };

  // ── State ─────────────────────────────────────────────────────────────────

  // view: 'free' or 'daily', the game on screen.  free: { sim, practice },
  // practice the number of the Daily a practice run replays (null for a
  // scored free game).  daily: the Daily record (bdsParseDaily).  best:
  // { score, level } (bdsParseBest).  A sim is what bdsStep works on (see
  // bdsNewSim).
  var bdsState = {
    view: 'free',
    free: null,
    daily: null,
    best: null
  };

  // Page handles, never saved.  frame: the pending animation frame (null
  // while the loop stands); lastTs / acc: the loop's last frame time and the
  // time not yet stepped.  keys: the held keys; target: where the mouse or a
  // finger put the carriage (null while the keys steer it); launch: a launch
  // waiting for the next step; press: the pointer pressed on the canvas.
  // dailyText: the bds-daily text this tab last read or wrote, so a record
  // another tab wrote since stands out.  failed: the keys storage refused.
  // confirming: the button ('new' or 'practice') waiting for its second
  // press, or null.  midnightTimeout: the render at the next local midnight.
  var bdsRuntime = {
    els: null,
    ctx: null,
    frame: null,
    lastTs: null,
    acc: 0,
    paused: false,
    hiddenPause: false,
    keys: { left: false, right: false },
    target: null,
    launch: false,
    press: null,
    toastTimeout: null,
    confirmTimeout: null,
    confirming: null,
    midnightTimeout: null,
    failed: [],
    dailyText: null
  };

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function bdsHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function bdsFill(length, value) {
    var out = [];
    for (var i = 0; i < length; i++) {
      out.push(value);
    }
    return out;
  }

  function bdsPad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function bdsClamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function bdsCopy(obj) {
    var out = {};
    Object.keys(obj).forEach(function (key) {
      out[key] = obj[key];
    });
    return out;
  }

  // An unsigned number as upper-case hex of at least digits digits.
  function bdsHex(value, digits) {
    var text = value.toString(16).toUpperCase();
    while (text.length < digits) {
      text = '0' + text;
    }
    return text;
  }

  // ── Sectors (no DOM) ──────────────────────────────────────────────────────

  // A cell of the grid is one integer: 0 a free cell, BDS_RO a read-only
  // sector, else power * 100 + max * 10 + hp: a sector that takes max hits
  // (1 plain, 2-3 bad) with hp left, dropping power (an index of BDS_POWERS)
  // when it breaks.
  function bdsCell(power, max, hp) {
    return power * 100 + max * 10 + hp;
  }

  function bdsCellPower(code) {
    return Math.floor(code / 100);
  }

  function bdsCellMax(code) {
    return Math.floor(code / 10) % 10;
  }

  function bdsCellHp(code) {
    return code % 10;
  }

  // Whether code is a sector that can break (neither free nor read-only).
  function bdsIsSector(code) {
    return code > 0 && code !== BDS_RO;
  }

  function bdsValidCell(code) {
    if (code === 0 || code === BDS_RO) {
      return true;
    }
    if (typeof code !== 'number' || code % 1 !== 0 || code < 0 || code > 399) {
      return false;
    }
    var max = bdsCellMax(code);
    var hp = bdsCellHp(code);
    return max >= 1 && max <= 3 && hp >= 1 && hp <= max;
  }

  function bdsCountSectors(grid) {
    return grid.filter(bdsIsSector).length;
  }

  // The rectangle of cell index, a unit inside its grid slot.
  function bdsCellRect(index) {
    return {
      x: BDS_GRID_X + (index % BDS_COLS) * BDS_CELL_W + 1,
      y: BDS_GRID_Y + Math.floor(index / BDS_COLS) * BDS_CELL_H + 1,
      w: BDS_CELL_W - 2,
      h: BDS_CELL_H - 2
    };
  }

  // The LBA a sector of a track stands for: track level, row and column.
  function bdsLba(level, index) {
    return level * 65536 + Math.floor(index / BDS_COLS) * 1024 + (index % BDS_COLS) * 64;
  }

  function bdsLbaText(level, index) {
    return 'LBA 0x' + bdsHex(bdsLba(level, index), 6);
  }

  // The cells next to index (north, east, south, west) inside the grid.
  function bdsNeighbours(index) {
    var row = Math.floor(index / BDS_COLS);
    var col = index % BDS_COLS;
    var out = [];
    if (row > 0) {
      out.push(index - BDS_COLS);
    }
    if (col < BDS_COLS - 1) {
      out.push(index + 1);
    }
    if (row < BDS_ROWS - 1) {
      out.push(index + BDS_COLS);
    }
    if (col > 0) {
      out.push(index - 1);
    }
    return out;
  }

  // The cells a head can reach, as a list of 80 booleans.  The grid has open
  // space on every side (the side margins are wider than the head), so every
  // cell on its rim that is not read-only is reached, and from there every
  // cell next to a reached one that is not read-only (a sector opens its
  // cell once it breaks).
  function bdsReachable(grid) {
    var seen = bdsFill(BDS_CELLS, false);
    var stack = [];
    function visit(index) {
      if (!seen[index] && grid[index] !== BDS_RO) {
        seen[index] = true;
        stack.push(index);
      }
    }
    for (var i = 0; i < BDS_CELLS; i++) {
      if (bdsNeighbours(i).length < 4) {
        visit(i);
      }
    }
    while (stack.length) {
      bdsNeighbours(stack.pop()).forEach(visit);
    }
    return seen;
  }

  // Drops every sector the head can never reach; read-only sectors stay.
  function bdsPrune(grid) {
    var seen = bdsReachable(grid);
    return grid.map(function (code, index) {
      return seen[index] || code === BDS_RO ? code : 0;
    });
  }

  // How many tracks of the grid a level fills: 5 on track 1, up to all 8.
  function bdsLevelRows(level) {
    return Math.min(BDS_ROWS, 4 + Math.ceil(level / 2));
  }

  // The odds of a read-only sector and of a bad file, rising with the level.
  function bdsLevelOdds(level) {
    return {
      ro: Math.min(0.14, 0.04 + 0.02 * level),
      bad: Math.min(0.45, 0.12 + 0.05 * level)
    };
  }

  // One draw of a fragmented disk: on each of the first rows tracks, free
  // cells (fragment gaps), single read-only sectors and files of 2-5
  // sectors, plain or bad (2-3 hits), one in ten with a bonus.
  function bdsDrawGrid(level, rows, rnd) {
    var grid = bdsFill(BDS_CELLS, 0);
    var odds = bdsLevelOdds(level);
    for (var row = 0; row < rows; row++) {
      var col = 0;
      while (col < BDS_COLS) {
        var index = row * BDS_COLS + col;
        if (rnd() < 0.22) {
          col++;
          continue;
        }
        var kind = rnd();
        if (kind < odds.ro) {
          grid[index] = BDS_RO;
          col++;
          continue;
        }
        var bad = kind < odds.ro + odds.bad;
        var end = Math.min(BDS_COLS, col + 2 + Math.floor(rnd() * 4));
        for (; col < end; col++) {
          var max = bad ? 2 + Math.floor(rnd() * 2) : 1;
          var power = rnd() < 0.1 ? 1 + Math.floor(rnd() * 3) : 0;
          grid[row * BDS_COLS + col] = bdsCell(power, max, max);
        }
      }
    }
    return bdsPrune(grid);
  }

  // A track for level on its first rows rows: a draw with at least
  // BDS_MIN_SECTORS sectors to break.  After BDS_GEN_TRIES poorer draws (only
  // a broken random source does that) every cell of those rows is a plain
  // sector.
  function bdsGenerateGrid(level, rows, rnd) {
    for (var tries = 0; tries < BDS_GEN_TRIES; tries++) {
      var grid = bdsDrawGrid(level, rows, rnd);
      if (bdsCountSectors(grid) >= BDS_MIN_SECTORS) {
        return grid;
      }
    }
    return bdsFill(BDS_CELLS, 0).map(function (code, index) {
      return index < rows * BDS_COLS ? bdsCell(0, 1, 1) : 0;
    });
  }

  // ── Physics (no DOM) ──────────────────────────────────────────────────────

  function bdsLevelSpeed(level) {
    return Math.min(BDS_MAX_SPEED, BDS_BASE_SPEED + BDS_LEVEL_SPEEDUP * (level - 1));
  }

  // A sim: { level, score, lives, total (the sectors the track started
  // with), grid, phase ('serve': the head waits on the carriage, 'play',
  // 'cleared', 'over'), paddleX (the carriage's centre), balls [{ x, y, vx,
  // vy }], speed (the heads' speed now), drops [{ x, y, p }], ecc / slow (the
  // seconds the bonus has left), flashes [{ x, y, lba, t }], events }.
  // events: what the last step did, for the page ({ type: 'launch' | 'paddle'
  // | 'ro' | 'hit' | 'break' | 'power' | 'lost' | 'over' | 'clear', ... }).
  function bdsNewSim(level, grid, score, lives) {
    return {
      level: level,
      score: score,
      lives: lives,
      total: bdsCountSectors(grid),
      grid: grid.slice(),
      phase: 'serve',
      paddleX: BDS_W / 2,
      balls: [],
      speed: bdsLevelSpeed(level),
      drops: [],
      ecc: 0,
      slow: 0,
      flashes: [],
      events: []
    };
  }

  function bdsCloneSim(sim) {
    return {
      level: sim.level,
      score: sim.score,
      lives: sim.lives,
      total: sim.total,
      grid: sim.grid.slice(),
      phase: sim.phase,
      paddleX: sim.paddleX,
      balls: sim.balls.map(bdsCopy),
      speed: sim.speed,
      drops: sim.drops.map(bdsCopy),
      ecc: sim.ecc,
      slow: sim.slow,
      flashes: sim.flashes.map(bdsCopy),
      events: []
    };
  }

  function bdsPaddleWidth(sim) {
    return sim.ecc > 0 ? BDS_PADDLE_WIDE : BDS_PADDLE_W;
  }

  function bdsSpeedOf(ball) {
    return Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  }

  function bdsSetSpeed(ball, speed) {
    var scale = speed / bdsSpeedOf(ball);
    ball.vx *= scale;
    ball.vy *= scale;
  }

  // The squared distance from a head's centre to the nearest point of rect.
  function bdsRectDistance(ball, rect) {
    var dx = ball.x - bdsClamp(ball.x, rect.x, rect.x + rect.w);
    var dy = ball.y - bdsClamp(ball.y, rect.y, rect.y + rect.h);
    return dx * dx + dy * dy;
  }

  // Bounces a head off rect along the axis on which their bounding boxes
  // overlap least (y on a tie), pushing it out of the rect on that axis.
  function bdsReflect(ball, rect) {
    var r = BDS_BALL_R;
    var ox = Math.min(ball.x + r - rect.x, rect.x + rect.w - (ball.x - r));
    var oy = Math.min(ball.y + r - rect.y, rect.y + rect.h - (ball.y - r));
    if (ox < oy) {
      if (ball.x < rect.x + rect.w / 2) {
        ball.x -= ox;
        ball.vx = -Math.abs(ball.vx);
      } else {
        ball.x += ox;
        ball.vx = Math.abs(ball.vx);
      }
    } else if (ball.y < rect.y + rect.h / 2) {
      ball.y -= oy;
      ball.vy = -Math.abs(ball.vy);
    } else {
      ball.y += oy;
      ball.vy = Math.abs(ball.vy);
    }
  }

  function bdsMovePaddle(s, input, dt) {
    var half = bdsPaddleWidth(s) / 2;
    var x = typeof input.target === 'number' ? input.target : s.paddleX + input.move * BDS_PADDLE_SPEED * dt;
    s.paddleX = bdsClamp(x, half, BDS_W - half);
  }

  // The head leaves the carriage 20 degrees off the vertical, toward the
  // wider side of the field.
  function bdsLaunch(s) {
    var angle = (s.paddleX < BDS_W / 2 ? 1 : -1) * BDS_SERVE_ANGLE;
    s.balls = [{
      x: s.paddleX,
      y: BDS_PADDLE_Y - BDS_BALL_R - 1,
      vx: s.speed * Math.sin(angle),
      vy: -s.speed * Math.cos(angle)
    }];
    s.phase = 'play';
    s.events.push({ type: 'launch' });
  }

  // Whether a head at (x, y) would be in open space the heads reach: it
  // touches no sector, and when it is inside the grid its cell is reachable
  // (not a pocket walled in by read-only sectors).
  function bdsOpenSpot(grid, x, y) {
    var probe = { x: x, y: y };
    for (var i = 0; i < BDS_CELLS; i++) {
      if (grid[i] && bdsRectDistance(probe, bdsCellRect(i)) < BDS_BALL_R * BDS_BALL_R) {
        return false;
      }
    }
    var col = Math.floor((x - BDS_GRID_X) / BDS_CELL_W);
    var row = Math.floor((y - BDS_GRID_Y) / BDS_CELL_H);
    if (col < 0 || col >= BDS_COLS || row < 0 || row >= BDS_ROWS) {
      return true;
    }
    return bdsReachable(grid)[row * BDS_COLS + col];
  }

  // RAID1: a second head at the mirrored spot across the field, moving the
  // mirrored way; where that spot is not open space, it starts from the
  // head's own spot instead.
  function bdsApplyPower(s, power) {
    var name = BDS_POWERS[power];
    s.score += BDS_POWER_POINTS;
    if (name === 'raid') {
      if (s.balls.length === 1) {
        var ball = s.balls[0];
        var x = bdsOpenSpot(s.grid, BDS_W - ball.x, ball.y) ? BDS_W - ball.x : ball.x;
        s.balls.push({ x: x, y: ball.y, vx: -ball.vx, vy: ball.vy });
      } else {
        s.score += BDS_RAID_BONUS;
      }
    } else if (name === 'ecc') {
      s.ecc = BDS_ECC_SECONDS;
    } else {
      s.slow = BDS_SLOW_SECONDS;
    }
    s.events.push({ type: 'power', power: name });
  }

  // Bonuses fall; the carriage catches those that touch it, and those that
  // fall past the bottom are gone.
  function bdsMoveDrops(s, dt) {
    var half = bdsPaddleWidth(s) / 2;
    var kept = [];
    s.drops.forEach(function (drop) {
      drop.y += BDS_DROP_SPEED * dt;
      var caught = Math.abs(drop.x - s.paddleX) < half + BDS_DROP_W / 2 &&
        drop.y + BDS_DROP_H / 2 >= BDS_PADDLE_Y && drop.y - BDS_DROP_H / 2 <= BDS_PADDLE_Y + BDS_PADDLE_H;
      if (caught) {
        bdsApplyPower(s, drop.p);
      } else if (drop.y - BDS_DROP_H / 2 <= BDS_H) {
        kept.push(drop);
      }
    });
    s.drops = kept;
  }

  function bdsBounceWalls(ball) {
    var r = BDS_BALL_R;
    if (ball.x < r) {
      ball.x = r;
      ball.vx = Math.abs(ball.vx);
    } else if (ball.x > BDS_W - r) {
      ball.x = BDS_W - r;
      ball.vx = -Math.abs(ball.vx);
    }
    if (ball.y < r) {
      ball.y = r;
      ball.vy = Math.abs(ball.vy);
    }
  }

  // A head falling onto the carriage goes back up at an angle that depends
  // on where it landed: straight up in the middle, up to 60 degrees at the
  // ends.
  function bdsBouncePaddle(s, ball) {
    var half = bdsPaddleWidth(s) / 2;
    var rect = { x: s.paddleX - half, y: BDS_PADDLE_Y, w: half * 2, h: BDS_PADDLE_H };
    if (ball.vy <= 0 || bdsRectDistance(ball, rect) >= BDS_BALL_R * BDS_BALL_R) {
      return;
    }
    var angle = bdsClamp((ball.x - s.paddleX) / half, -1, 1) * BDS_MAX_ANGLE;
    var speed = bdsSpeedOf(ball);
    ball.vx = speed * Math.sin(angle);
    ball.vy = -speed * Math.cos(angle);
    ball.y = Math.min(ball.y, BDS_PADDLE_Y - BDS_BALL_R);
    s.events.push({ type: 'paddle' });
  }

  // One hit on cell index: a read-only sector only bounces the head; any
  // other loses a hit, and a sector with none left breaks, flashes its LBA
  // and drops its bonus.  Each hit speeds the heads up a little.
  function bdsDamage(s, index, ball) {
    var code = s.grid[index];
    if (code === BDS_RO) {
      s.events.push({ type: 'ro', index: index });
      return;
    }
    var power = bdsCellPower(code);
    var max = bdsCellMax(code);
    var hp = bdsCellHp(code) - 1;
    s.speed = Math.min(BDS_MAX_SPEED, s.speed + BDS_HIT_SPEEDUP);
    bdsSetSpeed(ball, s.speed);
    if (hp > 0) {
      s.grid[index] = bdsCell(power, max, hp);
      s.score += BDS_HIT_POINTS;
      s.events.push({ type: 'hit', index: index });
      return;
    }
    var rect = bdsCellRect(index);
    var x = rect.x + rect.w / 2;
    var y = rect.y + rect.h / 2;
    s.grid[index] = 0;
    s.score += BDS_BREAK_POINTS * max;
    s.flashes.push({ x: x, y: y, lba: bdsLbaText(s.level, index), t: BDS_FLASH_SECONDS });
    if (power) {
      s.drops.push({ x: x, y: y, p: power });
    }
    s.events.push({ type: 'break', index: index, power: BDS_POWERS[power] });
  }

  // The head against the sectors it touches: it bounces off the nearest one
  // and hits it.
  function bdsHitSectors(s, ball) {
    var r = BDS_BALL_R;
    var c0 = Math.max(0, Math.floor((ball.x - r - BDS_GRID_X) / BDS_CELL_W));
    var c1 = Math.min(BDS_COLS - 1, Math.floor((ball.x + r - BDS_GRID_X) / BDS_CELL_W));
    var r0 = Math.max(0, Math.floor((ball.y - r - BDS_GRID_Y) / BDS_CELL_H));
    var r1 = Math.min(BDS_ROWS - 1, Math.floor((ball.y + r - BDS_GRID_Y) / BDS_CELL_H));
    var best = -1;
    var nearest = r * r;
    for (var row = r0; row <= r1; row++) {
      for (var col = c0; col <= c1; col++) {
        var index = row * BDS_COLS + col;
        var d = s.grid[index] ? bdsRectDistance(ball, bdsCellRect(index)) : nearest;
        if (d < nearest) {
          best = index;
          nearest = d;
        }
      }
    }
    if (best !== -1) {
      bdsReflect(ball, bdsCellRect(best));
      bdsDamage(s, best, ball);
    }
  }

  function bdsLoseLife(s) {
    s.lives--;
    s.drops = [];
    s.ecc = 0;
    s.slow = 0;
    s.speed = bdsLevelSpeed(s.level);
    s.phase = s.lives > 0 ? 'serve' : 'over';
    s.events.push({ type: 'lost', lives: s.lives });
    if (!s.lives) {
      s.events.push({ type: 'over' });
    }
  }

  // Every head moves in sub-steps of at most half its radius (at most
  // BDS_MAX_SUBSTEPS of them), bouncing off the walls, the carriage and the
  // sectors after each.  A head below the field is gone; with none left the
  // drive loses a life.
  function bdsMoveBalls(s, dt) {
    var factor = s.slow > 0 ? BDS_SLOW_FACTOR : 1;
    var kept = [];
    s.balls.forEach(function (ball) {
      if (bdsSpeedOf(ball) > BDS_MAX_SPEED) {
        bdsSetSpeed(ball, BDS_MAX_SPEED);
      }
      var distance = bdsSpeedOf(ball) * factor * dt;
      var count = Math.min(BDS_MAX_SUBSTEPS, Math.max(1, Math.ceil(distance / (BDS_BALL_R / 2))));
      var h = factor * dt / count;
      for (var i = 0; i < count; i++) {
        ball.x += ball.vx * h;
        ball.y += ball.vy * h;
        bdsBounceWalls(ball);
        bdsBouncePaddle(s, ball);
        bdsHitSectors(s, ball);
        if (ball.y - BDS_BALL_R > BDS_H) {
          return;
        }
      }
      kept.push(ball);
    });
    s.balls = kept;
    if (!kept.length) {
      bdsLoseLife(s);
    }
  }

  function bdsAgeFlashes(s, dt) {
    s.flashes = s.flashes.filter(function (flash) {
      flash.t -= dt;
      return flash.t > 0;
    });
  }

  function bdsClearLevel(s) {
    s.phase = 'cleared';
    s.balls = [];
    s.drops = [];
    s.score += BDS_CLEAR_POINTS * s.level;
    s.events.push({ type: 'clear', bonus: BDS_CLEAR_POINTS * s.level });
  }

  // The state dt seconds later, for input { move: -1 | 0 | 1 (the keys),
  // target: the carriage centre the pointer asks for, or null, launch:
  // whether to launch a waiting head }.  sim is left as it was.  On a
  // cleared or failed track only the last LBA flashes fade out.
  function bdsStep(sim, input, dt) {
    var s = bdsCloneSim(sim);
    bdsAgeFlashes(s, dt);
    if (s.phase !== 'serve' && s.phase !== 'play') {
      return s;
    }
    if (s.phase === 'serve') {
      bdsMovePaddle(s, input, dt);
      if (input.launch) {
        bdsLaunch(s);
      }
      return s;
    }
    s.ecc = Math.max(0, s.ecc - dt);
    s.slow = Math.max(0, s.slow - dt);
    bdsMovePaddle(s, input, dt);
    bdsMoveDrops(s, dt);
    bdsMoveBalls(s, dt);
    if (s.phase === 'play' && bdsCountSectors(s.grid) === 0) {
      bdsClearLevel(s);
    }
    return s;
  }

  // ── Daily (no DOM) ────────────────────────────────────────────────────────

  // FNV-1a, 32 bit, over the UTF-16 code units of text.
  function bdsHash(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // mulberry32: a seeded generator of numbers in [0, 1).
  function bdsMulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The Daily number of a calendar date, counted in UTC days.
  function bdsDayNumber(year, month, date) {
    return (Date.UTC(year, month, date) - BDS_EPOCH) / BDS_DAY_MS + 1;
  }

  // The local calendar date of now as { key: 'YYYY-MM-DD', day }.
  function bdsDayInfo(now) {
    var year = now.getFullYear();
    var month = now.getMonth();
    var date = now.getDate();
    return {
      key: year + '-' + bdsPad2(month + 1) + '-' + bdsPad2(date),
      day: bdsDayNumber(year, month, date)
    };
  }

  // The Daily number of a 'YYYY-MM-DD' key, or null when it is not a real
  // date in that form.
  function bdsKeyDay(key) {
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
    return bdsDayNumber(year, month, date);
  }

  function bdsDailyGrid(key) {
    return bdsGenerateGrid(BDS_DAILY_LEVEL, BDS_DAILY_ROWS, bdsMulberry32(bdsHash('bds:' + key)));
  }

  // The streak as of Daily number today: kept while the last clear is
  // today's or yesterday's, 0 once a day was missed.
  function bdsLiveStreak(daily, today) {
    var gap = today - daily.lastWon;
    return daily.lastWon !== null && (gap === 0 || gap === 1) ? daily.streak : 0;
  }

  // The share of a track's sectors broken, in whole percent rounded down.
  function bdsScanned(sim) {
    return Math.floor((sim.total - bdsCountSectors(sim.grid)) * 100 / Math.max(1, sim.total));
  }

  function bdsShareText(daily) {
    var sim = daily.sim;
    var realloc = BDS_LIVES - sim.lives;
    return 'Bad Sector Daily #' + daily.day + ': ' + (daily.status === 'won' ?
      'surface scan complete, ' + sim.score + ' points, SMART realloc ' + realloc + '/' + BDS_LIVES :
      'drive failure at ' + bdsScanned(sim) + '% scanned, ' + sim.score + ' points');
  }

  // Whether a Daily record another tab stored has to win over this tab's
  // (both as bdsParseDaily gives them): a later Daily, the same Daily
  // finished while ours is not, or the same attempt further along (more
  // points, or as many with fewer lives left).  A record from after today
  // (a clock set back) never wins.
  function bdsIsNewerDaily(stored, ours, today) {
    if (stored.key === null || stored.day > today) {
      return false;
    }
    if (ours.key === null) {
      return true;
    }
    if (stored.day !== ours.day) {
      return stored.day > ours.day;
    }
    var rank = BDS_STATUS_RANK[stored.status] - BDS_STATUS_RANK[ours.status];
    if (rank !== 0 || stored.status !== 'playing') {
      return rank > 0;
    }
    if (stored.sim.score !== ours.sim.score) {
      return stored.sim.score > ours.sim.score;
    }
    return stored.sim.lives < ours.sim.lives;
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function bdsParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function bdsIsObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function bdsIsInteger(value) {
    return typeof value === 'number' && value % 1 === 0;
  }

  function bdsIsCount(value) {
    return bdsIsInteger(value) && value >= 0;
  }

  function bdsIsFinite(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function bdsInRange(value, low, high) {
    return bdsIsFinite(value) && value >= low && value <= high;
  }

  // Saved heads: [x, y, vx, vy] each, inside the field and moving; a
  // damaged one is dropped alone, and at most two are kept.
  function bdsParseBalls(value) {
    var out = [];
    (Array.isArray(value) ? value : []).forEach(function (item) {
      var ok = Array.isArray(item) && item.length === 4 && bdsInRange(item[0], 0, BDS_W) &&
        bdsInRange(item[1], 0, BDS_H + BDS_BALL_R) && bdsIsFinite(item[2]) && bdsIsFinite(item[3]) &&
        (item[2] !== 0 || item[3] !== 0);
      if (ok && out.length < BDS_MAX_BALLS) {
        out.push({ x: item[0], y: item[1], vx: item[2], vy: item[3] });
      }
    });
    return out;
  }

  // Saved falling bonuses: [x, y, power] each; a damaged one is dropped alone.
  function bdsParseDrops(value) {
    var out = [];
    (Array.isArray(value) ? value : []).forEach(function (item) {
      if (Array.isArray(item) && item.length === 3 && bdsInRange(item[0], 0, BDS_W) &&
          bdsInRange(item[1], 0, BDS_H + BDS_DROP_H / 2) && bdsIsInteger(item[2]) && item[2] >= 1 &&
          item[2] < BDS_POWERS.length) {
        out.push({ x: item[0], y: item[1], p: item[2] });
      }
    });
    return out;
  }

  // A saved grid: 80 cells, each damaged cell a free one; null when it is no
  // list of 80.
  function bdsParseGrid(value) {
    if (!Array.isArray(value) || value.length !== BDS_CELLS) {
      return null;
    }
    return value.map(function (code) {
      return bdsValidCell(code) ? code : 0;
    });
  }

  function bdsParseLives(value) {
    return bdsIsInteger(value) && value >= 1 && value <= BDS_LIVES ? value : BDS_LIVES;
  }

  // Seconds of a bonus, 0 to max, else 0.
  function bdsParseEffect(value, max) {
    return typeof value === 'number' && value >= 0 && value <= max ? value : 0;
  }

  // A sim from saved fields (grid already parsed); total is never below the
  // sectors left, the speed never below the track's own nor above the cap,
  // and the carriage stays inside the walls.  phase 'play' keeps the saved
  // heads in flight and the falling bonuses; with no valid head left the
  // head waits on the carriage ('serve').
  function bdsLoadSim(data, level, grid, lives, phase) {
    var sim = bdsNewSim(level, grid, bdsIsCount(data.score) ? data.score : 0, lives);
    sim.total = bdsIsCount(data.total) && data.total >= sim.total ? data.total : sim.total;
    sim.ecc = bdsParseEffect(data.ecc, BDS_ECC_SECONDS);
    sim.slow = bdsParseEffect(data.slow, BDS_SLOW_SECONDS);
    sim.speed = bdsInRange(data.speed, sim.speed, BDS_MAX_SPEED) ? data.speed : sim.speed;
    var half = bdsPaddleWidth(sim) / 2;
    sim.paddleX = bdsInRange(data.paddle, 0, BDS_W) ? bdsClamp(data.paddle, half, BDS_W - half) : sim.paddleX;
    var balls = phase === 'play' ? bdsParseBalls(data.balls) : [];
    sim.phase = phase === 'play' && !balls.length ? 'serve' : phase;
    if (balls.length) {
      sim.balls = balls;
      sim.drops = bdsParseDrops(data.drops);
    }
    return sim;
  }

  // bds-state as { view, practice, level, sim }: sim is null when the save
  // holds no track left to play (the page draws a fresh one for level, with
  // the score and lives kept: those are in score and lives).  A save with no
  // lives is a failed drive; 'cleared' waits for the next track; 'play' has
  // its heads in flight.
  function bdsParseState(text) {
    var data = bdsParseJson(text);
    if (!bdsIsObject(data)) {
      data = {};
    }
    var level = bdsIsInteger(data.level) && data.level >= 1 && data.level <= BDS_MAX_LEVEL ? data.level : 1;
    var over = data.lives === 0;
    var lives = over ? 0 : bdsParseLives(data.lives);
    var phase = over ? 'over' : data.phase === 'cleared' || data.phase === 'play' ? data.phase : 'serve';
    var grid = bdsParseGrid(data.grid);
    var sim = null;
    if (over || phase === 'cleared' || (grid && bdsCountSectors(grid))) {
      sim = bdsLoadSim(data, level, grid || bdsFill(BDS_CELLS, 0), lives, phase);
    }
    return {
      view: data.view === 'daily' ? 'daily' : 'free',
      practice: bdsIsInteger(data.practice) && data.practice >= 1 ? data.practice : null,
      level: level,
      score: bdsIsCount(data.score) ? data.score : 0,
      lives: lives,
      sim: sim
    };
  }

  // bds-daily as { key, day, status ('playing', 'won', 'lost'), sim, streak,
  // lastWon }.  Without a valid key there is no attempt (key and sim null)
  // but the streak stays.  An attempt in progress whose grid is damaged or
  // has nothing left starts from the day's track again.
  function bdsParseDaily(text) {
    var data = bdsParseJson(text);
    if (!bdsIsObject(data)) {
      data = {};
    }
    var daily = {
      key: null,
      day: 0,
      status: 'playing',
      sim: null,
      streak: bdsIsCount(data.streak) ? data.streak : 0,
      lastWon: bdsIsInteger(data.lastWon) ? data.lastWon : null
    };
    var day = bdsKeyDay(data.key);
    if (day === null) {
      return daily;
    }
    var status = data.status === 'won' || data.status === 'lost' ? data.status : 'playing';
    var grid = bdsParseGrid(data.grid);
    var phase = BDS_DAILY_PHASE[status];
    if (status === 'playing' && !(grid && bdsCountSectors(grid))) {
      grid = bdsDailyGrid(data.key);
      phase = 'serve';
    }
    var lives = status === 'lost' ? 0 : bdsParseLives(data.lives);
    daily.key = data.key;
    daily.day = day;
    daily.status = status;
    daily.sim = bdsLoadSim(data, BDS_DAILY_LEVEL, grid || bdsFill(BDS_CELLS, 0), lives, phase);
    return daily;
  }

  // bds-best as { score, level }: 0 for none.
  function bdsParseBest(text) {
    var data = bdsParseJson(text);
    var best = bdsIsObject(data) ? data : {};
    return {
      score: bdsIsCount(best.score) ? best.score : 0,
      level: bdsIsInteger(best.level) && best.level >= 0 && best.level <= BDS_MAX_LEVEL ? best.level : 0
    };
  }

  function bdsMergeBest(a, b) {
    return { score: Math.max(a.score, b.score), level: Math.max(a.level, b.level) };
  }

  function bdsRound(value) {
    return Math.round(value * 100) / 100;
  }

  // The saved fields of a sim, the heads in flight and the falling bonuses
  // with them (their positions unrounded, so a head pushed out of a sector
  // is never put back inside it).
  function bdsSimFields(sim, out) {
    out.score = sim.score;
    out.lives = sim.lives;
    out.total = sim.total;
    out.grid = sim.grid;
    out.ecc = bdsRound(sim.ecc);
    out.slow = bdsRound(sim.slow);
    out.speed = sim.speed;
    out.paddle = sim.paddleX;
    out.balls = sim.balls.map(function (ball) {
      return [ball.x, ball.y, ball.vx, ball.vy];
    });
    out.drops = sim.drops.map(function (drop) {
      return [drop.x, drop.y, drop.p];
    });
    return out;
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // Notes that storage refused key and names every refused key in the
  // warning.
  function bdsWarnStorage(key, error) {
    var failed = bdsRuntime.failed;
    if (failed.indexOf(key) !== -1) {
      return;
    }
    failed.push(key);
    failed.sort();
    var warning = bdsRuntime.els.warning;
    warning.textContent = 'Storage is blocked or full (' + error.name + '): ' + failed.join(', ') +
      (failed.length > 1 ? ' are' : ' is') + ' not saved on this page. The game plays on.';
    warning.classList.remove('bds-hidden');
  }

  function bdsStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      bdsWarnStorage(key, error);
      return null;
    }
  }

  function bdsStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      bdsWarnStorage(key, error);
    }
  }

  function bdsActiveSim() {
    return bdsState.view === 'daily' ? bdsState.daily.sim : bdsState.free.sim;
  }

  function bdsSetActiveSim(sim) {
    if (bdsState.view === 'daily') {
      bdsState.daily.sim = sim;
    } else {
      bdsState.free.sim = sim;
    }
  }

  function bdsSerializeState() {
    var free = bdsState.free;
    var sim = free.sim;
    return bdsSimFields(sim, {
      v: BDS_SAVE_VERSION,
      view: bdsState.view,
      level: sim.level,
      phase: sim.phase,
      practice: free.practice
    });
  }

  function bdsSerializeDaily() {
    var daily = bdsState.daily;
    var out = bdsSimFields(daily.sim, {
      v: BDS_SAVE_VERSION,
      key: daily.key,
      day: daily.day,
      status: daily.status
    });
    out.streak = daily.streak;
    out.lastWon = daily.lastWon;
    return out;
  }

  // Writes the free game and the view on screen (never the Daily).
  function bdsSaveState() {
    bdsStorageSet(BDS_STATE_KEY, JSON.stringify(bdsSerializeState()));
  }

  // Reads bds-daily again and takes over the record another tab saved there
  // when it has to win over this tab's (bdsIsNewerDaily); a Daily on screen
  // follows, with a toast naming what came in.  Returns whether it did.
  function bdsSyncDaily() {
    var text = bdsStorageGet(BDS_DAILY_KEY);
    if (text === bdsRuntime.dailyText) {
      return false;
    }
    var stored = bdsParseDaily(text);
    if (!bdsIsNewerDaily(stored, bdsState.daily, bdsDayInfo(new Date()).day)) {
      return false;
    }
    bdsRuntime.dailyText = text;
    bdsState.daily = stored;
    if (bdsState.view === 'daily') {
      bdsHoldFlight();
      bdsReleaseKeys();
      bdsShowToast('Another tab ' + BDS_SYNC_VERBS[stored.status] + ' Daily disk #' + stored.day + ' (' +
        stored.sim.score + ' points, SMART realloc ' + (BDS_LIVES - stored.sim.lives) + '/' + BDS_LIVES +
        '): it is shown here.');
    }
    bdsUpdateLoop();
    bdsRender();
    return true;
  }

  // Writes the Daily attempt, unless another tab saved a record that has to
  // win over it: that one is taken over instead.
  function bdsSaveDaily() {
    if (bdsSyncDaily()) {
      return;
    }
    bdsRuntime.dailyText = JSON.stringify(bdsSerializeDaily());
    bdsStorageSet(BDS_DAILY_KEY, bdsRuntime.dailyText);
  }

  function bdsSaveActive() {
    if (bdsState.view === 'daily') {
      bdsSaveDaily();
    } else {
      bdsSaveState();
    }
  }

  // Keeps the best score and the highest track, merged with what another
  // tab may have stored since.  Returns whether the score is a new best.
  function bdsRecordBest(sim) {
    var best = bdsMergeBest(bdsState.best, bdsParseBest(bdsStorageGet(BDS_BEST_KEY)));
    var better = sim.score > best.score;
    bdsState.best = bdsMergeBest(best, { score: sim.score, level: sim.level });
    bdsStorageSet(BDS_BEST_KEY, JSON.stringify(bdsState.best));
    return better;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  // The unrolled platter: one band per track, a ruler of sector offsets
  // along the top and the spindle side along the bottom.
  function bdsDrawPlatter(ctx) {
    var c = BDS_COLORS;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, BDS_W, BDS_H);
    for (var row = 0; row < BDS_ROWS; row++) {
      ctx.fillStyle = row % 2 ? c.trackB : c.trackA;
      ctx.fillRect(0, BDS_GRID_Y + row * BDS_CELL_H, BDS_W, BDS_CELL_H);
    }
    ctx.fillStyle = c.ruler;
    ctx.fillRect(BDS_GRID_X, BDS_GRID_Y - 6, BDS_COLS * BDS_CELL_W, 1);
    ctx.font = BDS_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (var col = 0; col < BDS_COLS; col++) {
      var x = BDS_GRID_X + col * BDS_CELL_W;
      ctx.fillStyle = c.ruler;
      ctx.fillRect(x, BDS_GRID_Y - 9, 1, 4);
      ctx.fillStyle = c.label;
      ctx.fillText('+' + bdsHex(col * 64, 3), x + BDS_CELL_W / 2, BDS_GRID_Y - 11);
    }
    ctx.textAlign = 'left';
    ctx.fillText('PLATTER 0 · SIDE A · UNROLLED', 4, 18);
    ctx.fillStyle = c.ruler;
    ctx.fillRect(0, BDS_PADDLE_Y + BDS_PADDLE_H + 8, BDS_W, 1);
    ctx.fillStyle = c.label;
    ctx.textAlign = 'center';
    ctx.fillText('SPINDLE · drag here to move the carriage', BDS_W / 2, BDS_H - 14);
  }

  function bdsDrawSector(ctx, code, index, level) {
    var c = BDS_COLORS;
    var rect = bdsCellRect(index);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (code === BDS_RO) {
      ctx.fillStyle = c.ro;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = c.roLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var k = 0; k < rect.w; k += 6) {
        ctx.moveTo(rect.x + k, rect.y + rect.h);
        ctx.lineTo(rect.x + Math.min(rect.w, k + rect.h), rect.y);
      }
      ctx.stroke();
      ctx.fillStyle = c.text;
      ctx.font = BDS_FONT_BOLD;
      ctx.fillText('RO', rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
      return;
    }
    var max = bdsCellMax(code);
    var hp = bdsCellHp(code);
    var power = BDS_POWERS[bdsCellPower(code)];
    if (max === 1) {
      ctx.fillStyle = c.ok;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = c.okTop;
      ctx.fillRect(rect.x, rect.y, rect.w, 2);
    } else {
      // The hits left as dots down the left edge, the LBA tail (about 22
      // units wide) in the middle, between the dots and the bonus bar.
      ctx.fillStyle = c.bad[hp];
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = c.dark;
      for (var p = 0; p < hp; p++) {
        ctx.fillRect(rect.x + 2, rect.y + 2 + p * 4, 2, 2);
      }
      ctx.font = BDS_FONT;
      ctx.fillText(bdsHex(bdsLba(level, index), 6).slice(-3), rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
    }
    if (power) {
      // A bar down the right edge in the bonus colour.
      ctx.fillStyle = c.drop[power];
      ctx.fillRect(rect.x + rect.w - 4, rect.y + 2, 2, rect.h - 4);
    }
  }

  function bdsDrawPaddle(ctx, sim) {
    var c = BDS_COLORS;
    var w = bdsPaddleWidth(sim);
    var x = sim.paddleX - w / 2;
    ctx.fillStyle = sim.ecc > 0 ? c.paddleWide : c.paddle;
    ctx.fillRect(x, BDS_PADDLE_Y, w, BDS_PADDLE_H);
    ctx.fillStyle = c.dark;
    ctx.fillRect(sim.paddleX - 4, BDS_PADDLE_Y + 3, 8, 4);
    ctx.fillStyle = c.ruler;
    ctx.fillRect(sim.paddleX - 1, BDS_PADDLE_Y + BDS_PADDLE_H, 2, 8);
  }

  function bdsDrawBall(ctx, ball) {
    var c = BDS_COLORS;
    ctx.fillStyle = c.glow;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BDS_BALL_R + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.ball;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BDS_BALL_R, 0, Math.PI * 2);
    ctx.fill();
  }

  function bdsDrawDrop(ctx, drop) {
    var c = BDS_COLORS;
    var name = BDS_POWERS[drop.p];
    ctx.fillStyle = c.drop[name];
    ctx.fillRect(drop.x - BDS_DROP_W / 2, drop.y - BDS_DROP_H / 2, BDS_DROP_W, BDS_DROP_H);
    ctx.fillStyle = c.text;
    ctx.font = BDS_FONT_BOLD;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(BDS_DROP_LABELS[name], drop.x, drop.y + 1);
  }

  // The LBA of a broken sector rises and fades; near a side wall it moves in
  // so the whole address stays on the platter.
  function bdsDrawFlash(ctx, flash) {
    ctx.globalAlpha = flash.t / BDS_FLASH_SECONDS;
    ctx.fillStyle = BDS_COLORS.flash;
    ctx.font = BDS_FONT_FLASH;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var half = ctx.measureText(flash.lba).width / 2 + 2;
    ctx.fillText(flash.lba, bdsClamp(flash.x, half, BDS_W - half), flash.y - (BDS_FLASH_SECONDS - flash.t) * 24);
    ctx.globalAlpha = 1;
  }

  function bdsDraw(sim) {
    var ctx = bdsRuntime.ctx;
    ctx.setTransform(BDS_SCALE, 0, 0, BDS_SCALE, 0, 0);
    bdsDrawPlatter(ctx);
    sim.grid.forEach(function (code, index) {
      if (code) {
        bdsDrawSector(ctx, code, index, sim.level);
      }
    });
    sim.drops.forEach(function (drop) {
      bdsDrawDrop(ctx, drop);
    });
    bdsDrawPaddle(ctx, sim);
    var balls = sim.phase === 'serve' ? [{ x: sim.paddleX, y: BDS_PADDLE_Y - BDS_BALL_R - 1 }] : sim.balls;
    balls.forEach(function (ball) {
      bdsDrawBall(ctx, ball);
    });
    sim.flashes.forEach(function (flash) {
      bdsDrawFlash(ctx, flash);
    });
  }

  // ── Page text ─────────────────────────────────────────────────────────────

  function bdsSetText(el, text) {
    if (el.textContent !== text) {
      el.textContent = text;
    }
  }

  function bdsPausable(sim) {
    return sim.phase === 'serve' || sim.phase === 'play';
  }

  // The message on the platter (and in the status line) for the game on
  // screen.
  function bdsMessage() {
    var sim = bdsActiveSim();
    var daily = bdsState.daily;
    var free = bdsState.free;
    var inDaily = bdsState.view === 'daily';
    if (inDaily && daily.status === 'won') {
      return 'Surface scan complete: Daily disk #' + daily.day + ' is clean, ' + sim.score + ' points, SMART realloc ' +
        (BDS_LIVES - sim.lives) + '/' + BDS_LIVES + '. Streak ' + daily.streak + '.';
    }
    if (inDaily && daily.status === 'lost') {
      return 'Drive failure on Daily disk #' + daily.day + ' at ' + bdsScanned(sim) + '% scanned, ' + sim.score +
        ' points. Practice replays it, unscored.';
    }
    if (sim.phase === 'over') {
      return 'Drive failure: SMART threshold exceeded on track ' + sim.level + ' with ' + sim.score + ' points. ' +
        (free.practice === null ? 'New disk starts a fresh scan.' : 'Practice run, not scored.');
    }
    if (sim.phase === 'cleared') {
      return free.practice === null ?
        'Surface scan complete: track ' + sim.level + ' is clean. Press Space or tap the platter for track ' +
          (sim.level + 1) + '.' :
        'Surface scan complete: practice run of Daily disk #' + free.practice + ', not scored.';
    }
    if (bdsRuntime.paused) {
      return (bdsRuntime.hiddenPause ? 'Paused while the tab was hidden.' : 'Paused.') +
        ' Press P or Space, or tap the platter, to resume.';
    }
    if (sim.phase === 'serve') {
      return 'Press Space or tap the platter to launch the read head.';
    }
    return 'Scanning ' + (inDaily ? 'Daily disk #' + daily.day : 'track ' + sim.level) + '.';
  }

  function bdsModeText() {
    var daily = bdsState.daily;
    var free = bdsState.free;
    if (bdsState.view === 'daily') {
      return 'Daily disk #' + daily.day + ' · ' + daily.key;
    }
    if (free.practice !== null) {
      return 'Practice of Daily disk #' + free.practice + ' · not scored';
    }
    return 'Free scan · track ' + free.sim.level;
  }

  function bdsEffectsText(sim) {
    var parts = [];
    if (sim.balls.length > 1) {
      parts.push('RAID1 mirror');
    }
    if (sim.ecc > 0) {
      parts.push('ECC ' + Math.ceil(sim.ecc) + ' s');
    }
    if (sim.slow > 0) {
      parts.push('SLOW-SEEK ' + Math.ceil(sim.slow) + ' s');
    }
    return parts.length ? parts.join(' · ') : 'No bonus active';
  }

  function bdsBestText(best) {
    return best.score === 0 && best.level === 0 ? '--' : best.score + ' / T' + best.level;
  }

  function bdsRenderControls(sim) {
    var els = bdsRuntime.els;
    var daily = bdsState.daily;
    var inDaily = bdsState.view === 'daily';
    var finished = inDaily && daily.status !== 'playing';
    var today = bdsDayInfo(new Date());
    var pausable = bdsPausable(sim);
    els.pause.disabled = !pausable;
    bdsSetText(els.pause, bdsRuntime.paused ? 'Resume' : 'Pause');
    els.pause.setAttribute('aria-pressed', String(bdsRuntime.paused));
    els.next.classList.toggle('bds-hidden', inDaily || sim.phase !== 'cleared' || bdsState.free.practice !== null);
    els.practice.classList.toggle('bds-hidden', !finished);
    els.share.classList.toggle('bds-hidden', !finished);
    bdsSetText(els.dailyButton, inDaily ? 'Free scan' :
      'Daily #' + today.day + (daily.key === today.key ? BDS_DAILY_MARKS[daily.status] : ''));
    els.dailyButton.setAttribute('aria-label', inDaily ? 'Back to the free scan' : 'Open Daily disk #' + today.day);
    bdsSetText(els.newDisk, bdsRuntime.confirming === 'new' ? 'Confirm new disk' : 'New disk');
    bdsSetText(els.practice, bdsRuntime.confirming === 'practice' ? 'Confirm practice' : 'Practice');
    bdsSetText(els.streak, String(bdsLiveStreak(daily, today.day)));
  }

  // Draws the game on screen and every text about it.
  function bdsRender() {
    var els = bdsRuntime.els;
    var sim = bdsActiveSim();
    var message = bdsMessage();
    bdsDraw(sim);
    bdsSetText(els.score, String(sim.score));
    bdsSetText(els.level, bdsState.view === 'daily' ? 'Daily' : String(sim.level));
    bdsSetText(els.sectors, bdsCountSectors(sim.grid) + '/' + sim.total);
    bdsSetText(els.smart, (BDS_LIVES - sim.lives) + '/' + BDS_LIVES);
    bdsSetText(els.best, bdsBestText(bdsState.best));
    bdsSetText(els.mode, bdsModeText());
    bdsSetText(els.effects, bdsEffectsText(sim));
    bdsSetText(els.status, message);
    bdsSetText(els.overlayText, message);
    els.overlay.classList.toggle('bds-hidden', sim.phase === 'play' && !bdsRuntime.paused);
    bdsRenderControls(sim);
  }

  function bdsHideToast() {
    bdsRuntime.toastTimeout = null;
    bdsRuntime.els.toast.classList.remove('bds-show');
  }

  // Shows message for ms (BDS_TOAST_MS by default); a newer toast gets its
  // full time.
  function bdsShowToast(message, ms) {
    var toast = bdsRuntime.els.toast;
    clearTimeout(bdsRuntime.toastTimeout);
    toast.textContent = message;
    toast.classList.add('bds-show');
    bdsRuntime.toastTimeout = setTimeout(bdsHideToast, ms || BDS_TOAST_MS);
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  // Whether the game on screen has to run: a track under way (or the last
  // LBA flashes of a finished one fading out), not paused, in a visible tab.
  function bdsCanRun() {
    var sim = bdsActiveSim();
    return (bdsPausable(sim) || sim.flashes.length > 0) && !bdsRuntime.paused && !document.hidden;
  }

  // A game that comes (back) on screen with a head in flight waits, paused
  // where it was, for Space, a tap, P or Resume.
  function bdsHoldFlight() {
    bdsRuntime.paused = bdsActiveSim().phase === 'play';
    bdsRuntime.hiddenPause = false;
  }

  function bdsReleaseKeys() {
    bdsRuntime.keys.left = false;
    bdsRuntime.keys.right = false;
  }

  // Starts or stops the loop to match bdsCanRun.  A loop that starts again
  // forgets the time it stood, so it never runs a burst of steps.
  function bdsUpdateLoop() {
    var run = bdsCanRun();
    if (run && bdsRuntime.frame === null) {
      bdsRuntime.lastTs = null;
      bdsRuntime.acc = 0;
      bdsRuntime.frame = requestAnimationFrame(bdsFrame);
    } else if (!run && bdsRuntime.frame !== null) {
      cancelAnimationFrame(bdsRuntime.frame);
      bdsRuntime.frame = null;
    }
  }

  // One fixed step of the game on screen, and what its events mean for the
  // page: toasts, the end of a track, saves.
  function bdsAdvance() {
    var keys = bdsRuntime.keys;
    var sim = bdsStep(bdsActiveSim(), {
      move: (keys.right ? 1 : 0) - (keys.left ? 1 : 0),
      target: bdsRuntime.target,
      launch: bdsRuntime.launch
    }, BDS_STEP);
    bdsRuntime.launch = false;
    bdsSetActiveSim(sim);
    var save = false;
    sim.events.forEach(function (event) {
      save = save || BDS_SAVE_EVENTS.indexOf(event.type) !== -1;
      if (event.type === 'power') {
        bdsShowToast(BDS_POWER_TOASTS[event.power]);
      } else if (event.type === 'lost' && event.lives > 0) {
        bdsShowToast('Head lost: SMART Reallocated_Sector_Ct is ' + (BDS_LIVES - event.lives) + ' of ' + BDS_LIVES +
          '. Press Space or tap to launch the next head.');
      } else if (event.type === 'over' || event.type === 'clear') {
        bdsEndTrack(sim, event);
      }
    });
    if (save) {
      bdsSaveActive();
    }
  }

  // A track cleared or a drive failed: the Daily records its result, a
  // scored free game its best.
  function bdsEndTrack(sim, event) {
    var won = event.type === 'clear';
    if (bdsState.view === 'daily') {
      bdsFinishDaily(won ? 'won' : 'lost');
      bdsShowToast(won ? 'Surface scan complete: Daily disk #' + bdsState.daily.day + ', ' + sim.score + ' points.' :
        'Drive failure on Daily disk #' + bdsState.daily.day + ': ' + sim.score + ' points.');
      return;
    }
    var record = bdsState.free.practice === null && bdsRecordBest(sim);
    bdsShowToast((won ? 'Surface scan complete: track ' + sim.level + ' clean, +' + event.bonus + ' points' :
      'Drive failure on track ' + sim.level + ': ' + sim.score + ' points') + (record ? ', a new best!' : '.'));
  }

  function bdsFrame(ts) {
    bdsRuntime.frame = null;
    var last = bdsRuntime.lastTs === null ? ts : bdsRuntime.lastTs;
    bdsRuntime.lastTs = ts;
    bdsRuntime.acc += bdsClamp(ts - last, 0, BDS_MAX_FRAME_MS);
    while (bdsRuntime.acc >= BDS_STEP_MS && bdsCanRun()) {
      bdsRuntime.acc -= BDS_STEP_MS;
      bdsAdvance();
    }
    bdsRender();
    if (bdsRuntime.frame === null && bdsCanRun()) {
      bdsRuntime.frame = requestAnimationFrame(bdsFrame);
    }
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  // A fresh track for level, with the score and lives carried over.
  function bdsFreshSim(level, score, lives) {
    return bdsNewSim(level, bdsGenerateGrid(level, bdsLevelRows(level), Math.random), score, lives);
  }

  // Puts a view on screen (a head in flight paused), saves the free game and
  // the view, and runs the loop when the track on screen is under way.
  function bdsShowView(view) {
    bdsState.view = view;
    bdsHoldFlight();
    bdsRuntime.target = null;
    bdsRuntime.launch = false;
    bdsSaveState();
    bdsUpdateLoop();
    bdsRender();
  }

  // Before another game takes the screen: the game on screen is saved as it
  // is, a head in flight included.
  function bdsShelveActive() {
    bdsReleaseKeys();
    bdsSaveActive();
  }

  // The free game something replaces, named for the toast: '' when it is
  // not under way, so nothing is lost.
  function bdsReplacedText() {
    var free = bdsState.free;
    var sim = free.sim;
    if (sim.score === 0 || sim.phase === 'over' || free.practice !== null) {
      return '';
    }
    return ' Your free scan (track ' + sim.level + ', ' + sim.score + ' points) was replaced.';
  }

  function bdsEndConfirm() {
    clearTimeout(bdsRuntime.confirmTimeout);
    bdsRuntime.confirmTimeout = null;
    bdsRuntime.confirming = null;
  }

  function bdsConfirmExpired() {
    bdsEndConfirm();
    bdsRender();
  }

  // Whether the button action (labelled label) may replace the free game
  // now: at once when no scored free scan is under way, else only on a
  // second press of the same button within 4 s (the first one asks).
  function bdsConfirmDrop(action, label) {
    if (!bdsReplacedText() || bdsRuntime.confirming === action) {
      bdsEndConfirm();
      return true;
    }
    var sim = bdsState.free.sim;
    bdsEndConfirm();
    bdsRuntime.confirming = action;
    bdsRuntime.confirmTimeout = setTimeout(bdsConfirmExpired, BDS_CONFIRM_MS);
    bdsShowToast('Press ' + label + ' again within 4 s to drop your free scan (track ' + sim.level + ', ' +
      sim.score + ' points).', BDS_CONFIRM_MS);
    bdsRender();
    return false;
  }

  // New disk: a new free game from track 1.  A free game under way needs a
  // second press within 4 s.
  function bdsNewDisk() {
    if (!bdsConfirmDrop('new', 'New disk')) {
      return;
    }
    bdsShelveActive();
    bdsState.free = { sim: bdsFreshSim(1, 0, BDS_LIVES), practice: null };
    bdsShowView('free');
  }

  // The next track of a scored free game, with its score and lives.
  function bdsNextTrack() {
    var free = bdsState.free;
    var sim = free.sim;
    free.sim = bdsFreshSim(sim.level + 1, sim.score, sim.lives);
    bdsShowView('free');
  }

  // Starts the Daily attempt of today.
  function bdsBeginDaily(today) {
    var daily = bdsState.daily;
    daily.streak = bdsLiveStreak(daily, today.day);
    daily.key = today.key;
    daily.day = today.day;
    daily.status = 'playing';
    daily.sim = bdsNewSim(BDS_DAILY_LEVEL, bdsDailyGrid(today.key), 0, BDS_LIVES);
  }

  // Today's Daily: takes over what another tab stored since, then resumes
  // the attempt of today or shows its result, or begins a new one, written
  // the moment it begins.
  function bdsOpenDaily() {
    var today = bdsDayInfo(new Date());
    bdsSyncDaily();
    if (bdsState.daily.key !== today.key) {
      bdsBeginDaily(today);
      bdsSaveDaily();
    }
    bdsShowView('daily');
  }

  function bdsToggleDaily() {
    bdsShelveActive();
    if (bdsState.view === 'daily') {
      bdsShowView('free');
    } else {
      bdsOpenDaily();
    }
  }

  function bdsFinishDaily(status) {
    var daily = bdsState.daily;
    daily.status = status;
    if (status === 'won') {
      daily.streak = daily.lastWon === daily.day - 1 ? daily.streak + 1 : 1;
      daily.lastWon = daily.day;
    } else {
      daily.streak = 0;
    }
  }

  // Practice: a finished Daily's track again, in free play and unscored.  A
  // scored free scan under way needs a second press within 4 s, as for New
  // disk.
  function bdsPractice() {
    var daily = bdsState.daily;
    if (bdsState.view !== 'daily' || daily.status === 'playing') {
      return;
    }
    var replaced = bdsReplacedText();
    if (!bdsConfirmDrop('practice', 'Practice')) {
      return;
    }
    bdsShelveActive();
    bdsState.free = { sim: bdsNewSim(BDS_DAILY_LEVEL, bdsDailyGrid(daily.key), 0, BDS_LIVES), practice: daily.day };
    bdsShowView('free');
    bdsShowToast('Practice run of Daily disk #' + daily.day + ': not scored.' + replaced);
  }

  function bdsPause(hidden) {
    bdsRuntime.paused = true;
    bdsRuntime.hiddenPause = hidden;
    bdsReleaseKeys();
    bdsUpdateLoop();
    bdsSaveActive();
    bdsRender();
  }

  function bdsResume() {
    bdsRuntime.paused = false;
    bdsRuntime.hiddenPause = false;
    bdsUpdateLoop();
    bdsRender();
  }

  // Pause / Resume (the button and P): only while a track is under way.
  function bdsTogglePause() {
    if (bdsRuntime.paused) {
      bdsResume();
    } else if (bdsPausable(bdsActiveSim())) {
      bdsPause(false);
    }
  }

  // Why Space or a tap does nothing now, with the values that say so.
  function bdsRefusalText(sim) {
    var free = bdsState.free;
    var daily = bdsState.daily;
    if (bdsState.view === 'daily') {
      return 'Daily disk #' + daily.day + ' is ' + (daily.status === 'won' ? 'cleared' : 'lost') + ' (' + sim.score +
        ' points): Practice replays it, unscored.';
    }
    if (free.practice !== null) {
      return 'This practice run of Daily disk #' + free.practice + ' is over: New disk deals a scored disk.';
    }
    return 'The drive failed on track ' + sim.level + ' (' + sim.score + ' points): New disk starts a fresh scan.';
  }

  // Space, a tap or a click on the platter: resume, launch, or the next
  // track; anything else says why not.
  function bdsPrimaryAction() {
    var sim = bdsActiveSim();
    if (bdsRuntime.paused) {
      bdsResume();
    } else if (sim.phase === 'serve') {
      bdsRuntime.launch = true;
    } else if (sim.phase === 'cleared' && bdsState.view === 'free' && bdsState.free.practice === null) {
      bdsNextTrack();
    } else if (sim.phase !== 'play') {
      bdsShowToast(bdsRefusalText(sim));
    }
  }

  // Shows the share text selected in its read-only field, for copying by
  // hand when the clipboard is missing or refuses.
  function bdsShowShareField(text) {
    var field = bdsRuntime.els.shareText;
    field.value = text;
    field.classList.remove('bds-hidden');
    field.focus();
    field.select();
    bdsShowToast('The clipboard is not available: copy the selected result below.');
  }

  function bdsShare() {
    var text = bdsShareText(bdsState.daily);
    var clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text).then(function () {
        bdsShowToast('Copied: ' + text);
      }, function () {
        bdsShowShareField(text);
      });
    } else {
      bdsShowShareField(text);
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // 'left' / 'right' / 'action' / 'pause' for a key, by its value and then
  // by the physical key for layouts whose letters are not Latin; else null.
  function bdsKeyAction(event) {
    if (typeof event.key !== 'string') {
      return null;
    }
    var key = event.key.toLowerCase();
    if (bdsHasOwn(BDS_KEYS, key)) {
      return BDS_KEYS[key];
    }
    return bdsHasOwn(BDS_CODES, event.code) ? BDS_CODES[event.code] : null;
  }

  // Keys reach this listener only while the canvas (inside the stage) has
  // the focus.  A held arrow keeps the carriage moving until its keyup; a
  // held Space or P acts once.
  function bdsHandleKeydown(event) {
    var action = bdsKeyAction(event);
    if (!action || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    if (action === 'left' || action === 'right') {
      bdsRuntime.keys[action] = true;
      bdsRuntime.target = null;
    } else if (event.repeat) {
      return;
    } else if (action === 'pause') {
      bdsTogglePause();
    } else {
      bdsPrimaryAction();
    }
  }

  function bdsHandleKeyup(event) {
    var action = bdsKeyAction(event);
    if (action === 'left' || action === 'right') {
      bdsRuntime.keys[action] = false;
    }
  }

  // The field x of a pointer event on the canvas.
  function bdsFieldX(event) {
    var rect = bdsRuntime.els.canvas.getBoundingClientRect();
    return (event.clientX - rect.left) * BDS_W / rect.width;
  }

  // A press on the canvas takes the focus (so the keys work) and is
  // remembered: a finger drags the carriage from there, and a press let go
  // where it began is a tap.  A second finger is ignored, and so are the
  // other mouse buttons; a press of the same pointer replaces one whose
  // release happened outside the canvas.
  function bdsHandlePointerDown(event) {
    var press = bdsRuntime.press;
    if ((press && press.id !== event.pointerId) || event.button > 0) {
      return;
    }
    bdsRuntime.els.canvas.focus();
    bdsRuntime.press = {
      id: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      fieldX: bdsFieldX(event),
      paddleX: bdsActiveSim().paddleX,
      moved: 0
    };
  }

  // The mouse puts the carriage under it; a finger moves it as far as the
  // finger moved since it touched down.  A finger that drags the carriage
  // into a wall takes the anchor along (the press starts again from the
  // wall), so the carriage turns back as soon as the finger does.
  function bdsHandlePointerMove(event) {
    var press = bdsRuntime.press;
    var own = !!press && press.id === event.pointerId;
    if (own) {
      press.moved = Math.max(press.moved, Math.abs(event.clientX - press.clientX) + Math.abs(event.clientY - press.clientY));
    }
    if (event.pointerType !== 'touch') {
      bdsRuntime.target = bdsFieldX(event);
    } else if (own) {
      var x = bdsFieldX(event);
      var half = bdsPaddleWidth(bdsActiveSim()) / 2;
      var wanted = press.paddleX + x - press.fieldX;
      var target = bdsClamp(wanted, half, BDS_W - half);
      if (target !== wanted) {
        press.paddleX = target;
        press.fieldX = x;
      }
      bdsRuntime.target = target;
    }
  }

  function bdsHandlePointerUp(event) {
    var press = bdsRuntime.press;
    if (!press || press.id !== event.pointerId) {
      return;
    }
    bdsRuntime.press = null;
    if (press.moved < BDS_TAP_SLOP) {
      bdsPrimaryAction();
    }
  }

  function bdsHandlePointerCancel() {
    bdsRuntime.press = null;
  }

  // A mouse or touch click on a game button hands the keys to the canvas;
  // a keyboard activation (detail 0) leaves the focus on the button.
  function bdsButton(action) {
    return function (event) {
      if (event.detail > 0) {
        bdsRuntime.els.canvas.focus();
      }
      action();
    };
  }

  // A hidden tab pauses a track under way and saves it; shown again, it
  // stays paused until the player resumes.  A track that was not paused (a
  // page opened in a background tab, a Daily another tab took over) runs.
  function bdsHandleVisibility() {
    if (document.hidden && !bdsRuntime.paused && bdsPausable(bdsActiveSim())) {
      bdsPause(true);
    }
    bdsUpdateLoop();
    bdsRender();
  }

  // Another tab wrote to storage: its Daily record is taken over when it
  // has to win over this tab's, and its best is merged in.
  function bdsHandleStorage(event) {
    if (event.key === BDS_DAILY_KEY) {
      bdsSyncDaily();
    } else if (event.key === BDS_BEST_KEY) {
      bdsState.best = bdsMergeBest(bdsState.best, bdsParseBest(bdsStorageGet(BDS_BEST_KEY)));
      bdsRender();
    }
  }

  function bdsHandlePageHide() {
    bdsSaveActive();
  }

  // One render just after the next local midnight (and again every night),
  // so a page standing still (a finished track, a pause) shows the new
  // day's Daily button and streak.
  function bdsArmMidnight() {
    clearTimeout(bdsRuntime.midnightTimeout);
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    bdsRuntime.midnightTimeout = setTimeout(bdsMidnight, next.getTime() - now.getTime() + BDS_MIDNIGHT_SLACK_MS);
  }

  function bdsMidnight() {
    bdsArmMidnight();
    bdsRender();
  }

  function bdsBindEvents() {
    var els = bdsRuntime.els;
    els.stage.addEventListener('keydown', bdsHandleKeydown);
    els.stage.addEventListener('keyup', bdsHandleKeyup);
    els.stage.addEventListener('focusout', bdsReleaseKeys);
    els.canvas.addEventListener('pointerdown', bdsHandlePointerDown);
    els.canvas.addEventListener('pointermove', bdsHandlePointerMove);
    els.canvas.addEventListener('pointerup', bdsHandlePointerUp);
    els.canvas.addEventListener('pointercancel', bdsHandlePointerCancel);
    els.newDisk.addEventListener('click', bdsButton(bdsNewDisk));
    els.dailyButton.addEventListener('click', bdsButton(bdsToggleDaily));
    els.pause.addEventListener('click', bdsButton(bdsTogglePause));
    els.next.addEventListener('click', bdsButton(bdsPrimaryAction));
    els.practice.addEventListener('click', bdsButton(bdsPractice));
    els.shareButton.addEventListener('click', bdsShare);
    document.addEventListener('visibilitychange', bdsHandleVisibility);
    window.addEventListener('storage', bdsHandleStorage);
    window.addEventListener('pagehide', bdsHandlePageHide);
    window.addEventListener('blur', bdsReleaseKeys);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function bdsFindElements() {
    return {
      stage: document.getElementById('bds-stage'),
      canvas: document.getElementById('bds-canvas'),
      overlay: document.getElementById('bds-overlay'),
      overlayText: document.getElementById('bds-overlay-text'),
      newDisk: document.getElementById('bds-new'),
      dailyButton: document.getElementById('bds-daily-button'),
      pause: document.getElementById('bds-pause'),
      next: document.getElementById('bds-next'),
      practice: document.getElementById('bds-practice'),
      score: document.getElementById('bds-score'),
      level: document.getElementById('bds-level'),
      sectors: document.getElementById('bds-sectors'),
      smart: document.getElementById('bds-smart'),
      best: document.getElementById('bds-best'),
      streak: document.getElementById('bds-streak'),
      mode: document.getElementById('bds-mode'),
      effects: document.getElementById('bds-effects'),
      status: document.getElementById('bds-status'),
      warning: document.getElementById('bds-warning'),
      share: document.getElementById('bds-share'),
      shareButton: document.getElementById('bds-share-button'),
      shareText: document.getElementById('bds-share-text'),
      toast: document.getElementById('bds-toast')
    };
  }

  // Finds the elements, binds the controls once and restores the saves: the
  // free game (a fresh track where the save has none left) and, when the
  // Daily was on screen, today's Daily.
  function bdsInit() {
    if (bdsRuntime.els) {
      return;
    }
    bdsRuntime.els = bdsFindElements();
    bdsRuntime.ctx = bdsRuntime.els.canvas.getContext('2d');
    bdsBindEvents();
    bdsState.best = bdsParseBest(bdsStorageGet(BDS_BEST_KEY));
    bdsRuntime.dailyText = bdsStorageGet(BDS_DAILY_KEY);
    bdsState.daily = bdsParseDaily(bdsRuntime.dailyText);
    var saved = bdsParseState(bdsStorageGet(BDS_STATE_KEY));
    bdsState.free = {
      sim: saved.sim || bdsFreshSim(saved.level, saved.score, saved.lives),
      practice: saved.practice
    };
    if (saved.view === 'daily') {
      bdsOpenDaily();
    } else {
      bdsShowView('free');
    }
    bdsArmMidnight();
  }

  // Node (tests): export only, no init, no listeners and no frames.
  // Browser: init once the markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      bdsState: bdsState,
      bdsRuntime: bdsRuntime,
      bdsInit: bdsInit,
      bdsCell: bdsCell,
      bdsValidCell: bdsValidCell,
      bdsIsSector: bdsIsSector,
      bdsCountSectors: bdsCountSectors,
      bdsCellRect: bdsCellRect,
      bdsLba: bdsLba,
      bdsLbaText: bdsLbaText,
      bdsNeighbours: bdsNeighbours,
      bdsReachable: bdsReachable,
      bdsPrune: bdsPrune,
      bdsLevelRows: bdsLevelRows,
      bdsLevelOdds: bdsLevelOdds,
      bdsGenerateGrid: bdsGenerateGrid,
      bdsLevelSpeed: bdsLevelSpeed,
      bdsNewSim: bdsNewSim,
      bdsPaddleWidth: bdsPaddleWidth,
      bdsReflect: bdsReflect,
      bdsStep: bdsStep,
      bdsHash: bdsHash,
      bdsMulberry32: bdsMulberry32,
      bdsDayInfo: bdsDayInfo,
      bdsKeyDay: bdsKeyDay,
      bdsDailyGrid: bdsDailyGrid,
      bdsLiveStreak: bdsLiveStreak,
      bdsScanned: bdsScanned,
      bdsShareText: bdsShareText,
      bdsIsNewerDaily: bdsIsNewerDaily,
      bdsParseGrid: bdsParseGrid,
      bdsParseState: bdsParseState,
      bdsParseDaily: bdsParseDaily,
      bdsParseBest: bdsParseBest,
      bdsMergeBest: bdsMergeBest,
      bdsKeyAction: bdsKeyAction,
      bdsConstants: {
        W: BDS_W, H: BDS_H, COLS: BDS_COLS, ROWS: BDS_ROWS, CELLS: BDS_CELLS, GRID_X: BDS_GRID_X,
        GRID_Y: BDS_GRID_Y, CELL_W: BDS_CELL_W, CELL_H: BDS_CELL_H, RO: BDS_RO, PADDLE_Y: BDS_PADDLE_Y,
        PADDLE_H: BDS_PADDLE_H, PADDLE_W: BDS_PADDLE_W, PADDLE_WIDE: BDS_PADDLE_WIDE, PADDLE_SPEED: BDS_PADDLE_SPEED,
        BALL_R: BDS_BALL_R, MAX_SPEED: BDS_MAX_SPEED, STEP: BDS_STEP, SCALE: BDS_SCALE, DROP_W: BDS_DROP_W,
        DROP_H: BDS_DROP_H
      }
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bdsInit);
  } else {
    bdsInit();
  }
})();
