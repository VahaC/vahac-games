// Port Knocker — script.js
// Prefix: pkn-
// Dependencies: none.
//
// A memory game on a homelab patch panel: the ports flash a knock sequence,
// the player knocks it back, and every passed round adds one knock.
//
// Rounds: a round's show starts on Start, Enter or Space (New Game, Restart
// and Daily start it too), never by itself after a reload or a pause. The
// show flashes the sequence; from round 5 on its first knocks are printed in
// a knockd log line instead. Knocks during the show are ignored. Then the
// player knocks (tap, click or the keys 1-9). A wrong knock ends the run
// ("Connection refused", the log line printing the knocks the round wanted),
// the last right one opens the firewall ("ssh:
// connection established") and the next round's show follows after a short
// pause. Between two knocks the knock window (3 s) runs, as in a real
// port-knocking daemon: when it closes, the knocks entered so far are dropped
// and the round starts over from its first knock (the show is not repeated).
//
// Modes: Forward repeats the sequence as shown (FIFO), Reverse backwards
// (LIFO), Stride every second knock (the 1st, 3rd, 5th ...). Panels have 4,
// 6 or 9 ports; with 9 the keys follow the numeric keypad (7 is top left).
//
// Daily: one sequence a day, the same for everyone (FNV-1a of "pkn:" and the
// local date seeds a mulberry32 PRNG), on 6 ports, the mode rotating
// Forward / Reverse / Stride by the Daily number, up to a target length. One
// scored attempt: pkn-daily records it before its first show; a reload, or
// the Daily button after a practice game, resumes the round it reached with
// the show replayed. A finished Daily shows its result and can be replayed
// unscored. The streak counts consecutive Daily numbers won. A Daily left
// open across midnight finishes for the day it began; left for practice or
// for the new day's Daily after midnight, it counts as lost. Another tab may
// play the same Daily: a result it stored first stands (this tab takes it,
// stops its round and never writes over it), and a new Daily builds its
// streak on the later of the stored record and the one in memory.
//
// Score: the length of the longest sequence repeated ("sequence 8"); in
// Stride that is more than the knocks entered, so it is never called knocks.
//
// Saves (localStorage, every access guarded; blocked or full storage only
// costs the saves and says so in the note line): pkn-state (the game on
// screen), pkn-best (the longest repeated sequence per mode and panel size),
// pkn-daily (the latest Daily attempt and the streak) and pkn-sound ("on" or
// "off"; off by default, so an embedded page never makes noise unasked).
//
// Keys: only while the focus is inside the game (.pkn-wrapper), not in its
// selects, never with Ctrl, Alt or Meta. Enter and Space on the game's own
// buttons stay with those buttons.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser pknInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var PKN_STATE_KEY = 'pkn-state';
  var PKN_BEST_KEY = 'pkn-best';
  var PKN_DAILY_KEY = 'pkn-daily';
  var PKN_SOUND_KEY = 'pkn-sound';
  var PKN_SAVE_VERSION = 1;

  // The panel's ports: port index i is PKN_PORTS[i], in reading order.
  var PKN_PORTS = [
    { port: 22, service: 'ssh' },
    { port: 80, service: 'http' },
    { port: 443, service: 'https' },
    { port: 3306, service: 'mysql' },
    { port: 53, service: 'dns' },
    { port: 8080, service: 'proxy' },
    { port: 5432, service: 'postgres' },
    { port: 6379, service: 'redis' },
    { port: 8096, service: 'jellyfin' }
  ];
  var PKN_SIZES = [4, 6, 9];
  // Grid columns per panel size: 2x2, 3x2 and 3x3.
  var PKN_COLUMNS = { 4: 2, 6: 3, 9: 3 };
  var PKN_MODES = ['forward', 'reverse', 'stride'];
  var PKN_MODE_INFO = {
    forward: {
      label: 'Forward',
      flag: '--fifo',
      hint: 'Forward (FIFO): knock the ports in the order they flashed.'
    },
    reverse: {
      label: 'Reverse',
      flag: '--lifo',
      hint: 'Reverse (LIFO): knock them backwards, the last flash first, like popping a stack.'
    },
    stride: {
      label: 'Stride',
      flag: '--stride=2',
      hint: 'Stride: knock only every second port, the 1st, 3rd, 5th and so on.'
    }
  };
  var PKN_KINDS = ['practice', 'daily', 'replay'];
  var PKN_RESULTS = ['playing', 'lost', 'won'];

  var PKN_START_LENGTH = 3;
  var PKN_MAX_LENGTH = 200;
  // Show pace: the time from one flash to the next, 600 ms in round 1 and
  // 35 ms less every round down to 250 ms; a flash lights for 60 % of it.
  var PKN_INTERVAL_SLOW = 600;
  var PKN_INTERVAL_FAST = 250;
  var PKN_INTERVAL_STEP = 35;
  var PKN_FLASH_SHARE = 0.6;
  var PKN_LEAD_MS = 500;
  var PKN_LOG_FROM_ROUND = 5;
  var PKN_LOG_BASE_MS = 900;
  var PKN_LOG_KNOCK_MS = 450;
  var PKN_LOG_GAP_MS = 300;
  var PKN_END_MS = 200;
  var PKN_WINDOW_MS = 3000;
  var PKN_KNOCK_FLASH_MS = 180;
  var PKN_NEXT_ROUND_MS = 1400;
  var PKN_TOAST_MS = 2200;
  var PKN_DAY_MS = 86400000;
  var PKN_DAILY_SIZE = 6;
  var PKN_DAILY_TARGET = { forward: 10, reverse: 8, stride: 12 };
  var PKN_HOST = 'homelab.lan';
  // One tone per port index (a pentatonic scale), Hz.
  var PKN_TONES = [262, 294, 330, 392, 440, 523, 587, 659, 784];
  var PKN_NO_BEST = '--';
  var PKN_HIDDEN = 'pkn-hidden';
  var PKN_PORT_STATES = ['pkn-port-lit', 'pkn-port-hit', 'pkn-port-bad', 'pkn-port-want'];

  // ── State ─────────────────────────────────────────────────────────────────

  // The game on screen, as pkn-state saves it. kind: 'practice', 'daily' or
  // 'replay' (a Daily played again unscored); sequence: port indices; result:
  // 'playing', 'lost' or 'won' (a Daily or replay that reached its target);
  // day: the Daily's date key, null in practice.
  var pknGame = {
    kind: 'practice',
    mode: 'forward',
    size: 4,
    sequence: [],
    result: 'playing',
    day: null
  };

  // Runtime only, never saved.
  var pknRt = {
    els: null,
    phase: 'idle',        // idle | show | input | success | over
    paused: false,        // idle after a reload or a pause: Start replays the show
    entered: [],          // this round's knocks so far
    steps: [],            // the show being played (pknShowSteps)
    step: 0,
    showTimer: null,
    knockTimer: null,
    knockPort: -1,
    windowTimer: null,
    windowDeadline: 0,
    windowLeft: null,     // ms left on the knock window while the tab is hidden
    firstKnockAt: 0,
    nextTimer: null,
    toastTimer: null,
    daily: null,          // the latest Daily record (pkn-daily)
    best: {},
    sound: false,
    audio: null,
    builtSize: 0,
    ports: []
  };

  // ── Pure game logic (no DOM) ──────────────────────────────────────────────

  function pknOneOf(list, value, fallback) {
    return list.indexOf(value) !== -1 ? value : fallback;
  }

  function pknIsCount(value) {
    return typeof value === 'number' && value >= 0 && value % 1 === 0;
  }

  function pknIsObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function pknParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  // A copy of seq with one more knock: a port index in [0, size) drawn with
  // rnd() (a number in [0, 1)), never the port that knocked last, so two
  // flashes in a row are always two ports.
  function pknExtendSequence(seq, rnd, size) {
    var next = seq.slice();
    var choices = seq.length ? size - 1 : size;
    var draw = Math.min(choices - 1, Math.floor(rnd() * choices));
    if (seq.length && draw >= seq[seq.length - 1]) {
      draw += 1;
    }
    next.push(draw);
    return next;
  }

  // The knocks the player owes for a shown sequence: as shown (Forward),
  // backwards (Reverse) or every second one from the first (Stride).
  function pknExpectedOrder(seq, mode) {
    if (mode === 'reverse') {
      return seq.slice().reverse();
    }
    if (mode === 'stride') {
      return seq.filter(function (port, index) {
        return index % 2 === 0;
      });
    }
    return seq.slice();
  }

  // One knock checked: 'wrong', 'ok' (right, more to come) or 'done' (right
  // and the last one). entered holds the knocks before this one.
  function pknCheckInput(expected, entered, port) {
    if (entered.length >= expected.length || expected[entered.length] !== port) {
      return 'wrong';
    }
    return entered.length + 1 === expected.length ? 'done' : 'ok';
  }

  // The longest sequence repeated when the round of a sequence this long is
  // passed (its length) or failed (the round before, 0 for the first round).
  function pknScoreFor(length, passed) {
    if (passed) {
      return length;
    }
    return length - 1 >= PKN_START_LENGTH ? length - 1 : 0;
  }

  function pknRoundFor(length) {
    return length - PKN_START_LENGTH + 1;
  }

  function pknIntervalFor(round) {
    return Math.max(PKN_INTERVAL_FAST, PKN_INTERVAL_SLOW - PKN_INTERVAL_STEP * (round - 1));
  }

  // How many of the first knocks go to the log line: none before round 5,
  // then 2, one more every second round, and always at least two flashes.
  function pknLogCountFor(round, length) {
    if (round < PKN_LOG_FROM_ROUND) {
      return 0;
    }
    return Math.min(length - 2, 2 + Math.floor((round - PKN_LOG_FROM_ROUND) / 2));
  }

  // The show of a sequence as timed steps ({ at: ms from the start, type })
  // in order: 'log' (ports: the logged knocks) and 'unlog', then 'on' / 'off'
  // per flashed knock (port, index), then 'end'.
  function pknShowSteps(seq) {
    var round = pknRoundFor(seq.length);
    var interval = pknIntervalFor(round);
    var flash = Math.round(interval * PKN_FLASH_SHARE);
    var logCount = pknLogCountFor(round, seq.length);
    var steps = [];
    var at = PKN_LEAD_MS;
    if (logCount > 0) {
      steps.push({ at: at, type: 'log', ports: seq.slice(0, logCount) });
      at += PKN_LOG_BASE_MS + PKN_LOG_KNOCK_MS * logCount;
      steps.push({ at: at, type: 'unlog' });
      at += PKN_LOG_GAP_MS;
    }
    for (var i = logCount; i < seq.length; i++) {
      steps.push({ at: at, type: 'on', port: seq[i], index: i });
      steps.push({ at: at + flash, type: 'off', port: seq[i], index: i });
      at += interval;
    }
    steps.push({ at: at - interval + flash + PKN_END_MS, type: 'end' });
    return steps;
  }

  // The port a key knocks on a panel of size ports, or null. The key value
  // (1-9) first, then the physical key (Digit1-9, Numpad1-9), so AZERTY
  // layouts and a keypad without Num Lock work too. With 9 ports the digits
  // follow the keypad: 7 8 9 on the top row, 1 2 3 on the bottom.
  function pknKeyToPort(event, size) {
    var digit = typeof event.key === 'string' && /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
    var code = /^(?:Digit|Numpad)([1-9])$/.exec(String(event.code));
    if (!digit && code) {
      digit = Number(code[1]);
    }
    if (!digit) {
      return null;
    }
    if (size === 9) {
      return (2 - Math.floor((digit - 1) / 3)) * 3 + (digit - 1) % 3;
    }
    return digit <= size ? digit - 1 : null;
  }

  // The key printed on a port: the inverse of pknKeyToPort.
  function pknKeyLabel(index, size) {
    if (size === 9) {
      return String((2 - Math.floor(index / 3)) * 3 + index % 3 + 1);
    }
    return String(index + 1);
  }

  function pknIsSequence(value, size) {
    if (!Array.isArray(value) || value.length < PKN_START_LENGTH || value.length > PKN_MAX_LENGTH) {
      return false;
    }
    return value.every(function (port) {
      return pknIsCount(port) && port < size;
    });
  }

  // ── Daily (pure) ──────────────────────────────────────────────────────────

  function pknPad2(number) {
    return (number < 10 ? '0' : '') + number;
  }

  // The local calendar date of a Date as YYYY-MM-DD.
  function pknDayKey(date) {
    return date.getFullYear() + '-' + pknPad2(date.getMonth() + 1) + '-' + pknPad2(date.getDate());
  }

  function pknIsDayKey(value) {
    var m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    if (!m) {
      return false;
    }
    var date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 &&
      date.getUTCDate() === Number(m[3]);
  }

  // Daily #1 is 2026-11-01; counted in UTC days, so DST never shifts it.
  function pknDailyNumber(dayKey) {
    var parts = dayKey.split('-');
    return (Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) - Date.UTC(2026, 10, 1)) / PKN_DAY_MS + 1;
  }

  // FNV-1a, 32 bit, over the UTF-16 code units of text.
  function pknFnv1a(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // mulberry32: a reproducible stream of numbers in [0, 1) for a 32-bit seed.
  function pknMulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The first length knocks of a day's sequence: the same for everyone.
  function pknDailySequence(dayKey, length, size) {
    var rnd = pknMulberry32(pknFnv1a('pkn:' + dayKey));
    var seq = [];
    while (seq.length < length) {
      seq = pknExtendSequence(seq, rnd, size);
    }
    return seq;
  }

  // A Daily's mode (Forward, Reverse, Stride in turn), panel size and target.
  function pknDailyConfig(number) {
    var mode = PKN_MODES[((number - 1) % 3 + 3) % 3];
    return { mode: mode, size: PKN_DAILY_SIZE, target: PKN_DAILY_TARGET[mode] };
  }

  // The streak to show on Daily number today: the stored one while its last
  // win is today's or yesterday's Daily, else 0 (a missed day resets it).
  function pknStreakFor(record, today) {
    return record && record.lastWin > 0 && record.lastWin >= today - 1 ? record.streak : 0;
  }

  function pknShareText(record) {
    var config = pknDailyConfig(record.number);
    return 'Port Knocker #' + record.number + ' ' + PKN_MODE_INFO[config.mode].label + ' ' +
      config.size + ' ports seq ' + record.score + '/' + config.target + ', ' +
      (record.status === 'won' ? 'ssh: connection established' : 'connection refused');
  }

  // ── Save parsing (pure) ───────────────────────────────────────────────────

  // pkn-state, field by field: an unknown mode, size, kind or result falls
  // back on its own, a Daily or replay without a valid day becomes practice,
  // and a broken sequence comes back as null (a fresh one is drawn). null
  // when the text is no object at all.
  function pknParseState(text) {
    var data = pknParseJson(text);
    if (!pknIsObject(data)) {
      return null;
    }
    var size = pknOneOf(PKN_SIZES, data.size, PKN_SIZES[0]);
    var day = pknIsDayKey(data.day) ? data.day : null;
    var kind = day ? pknOneOf(PKN_KINDS, data.kind, 'practice') : 'practice';
    var result = pknOneOf(PKN_RESULTS, data.result, 'playing');
    if (kind === 'practice' && result === 'won') {
      result = 'playing';
    }
    return {
      kind: kind,
      mode: pknOneOf(PKN_MODES, data.mode, 'forward'),
      size: size,
      sequence: pknIsSequence(data.sequence, size) ? data.sequence.slice() : null,
      result: result,
      day: kind === 'practice' ? null : day
    };
  }

  // pkn-best: { "<mode>-<size>": length } with only known keys and whole
  // positive lengths kept.
  function pknParseBest(text) {
    var data = pknParseJson(text);
    var out = {};
    if (!pknIsObject(data)) {
      return out;
    }
    PKN_MODES.forEach(function (mode) {
      PKN_SIZES.forEach(function (size) {
        var key = mode + '-' + size;
        if (pknIsCount(data[key]) && data[key] > 0) {
          out[key] = data[key];
        }
      });
    });
    return out;
  }

  // pkn-daily, field by field. The number always comes from the day. An
  // unknown status counts as 'lost', so a damaged record never hands out a
  // second scored attempt; a score is capped at the Daily's target (one
  // below it while the attempt is still playing). null for no object.
  function pknParseDaily(text) {
    var data = pknParseJson(text);
    if (!pknIsObject(data)) {
      return null;
    }
    var day = pknIsDayKey(data.day) ? data.day : null;
    var number = day ? pknDailyNumber(day) : 0;
    var status = pknOneOf(PKN_RESULTS, data.status, 'lost');
    var target = pknDailyConfig(number).target;
    var cap = status === 'playing' ? target - 1 : target;
    return {
      day: day,
      number: number,
      status: status,
      score: day && pknIsCount(data.score) ? Math.min(data.score, cap) : 0,
      streak: pknIsCount(data.streak) ? data.streak : 0,
      lastWin: pknIsCount(data.lastWin) ? data.lastWin : 0
    };
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // A failing storage call: the note line names the error and what is lost.
  function pknStorageProblem(error) {
    var name = error && error.name ? String(error.name) : 'Error';
    var what = name === 'QuotaExceededError' ? 'Storage is full (' : 'Storage is blocked (';
    pknSetNote(what + name + '): progress, best scores and the Daily result will not be saved.');
  }

  function pknStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      pknStorageProblem(error);
      return null;
    }
  }

  function pknStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      pknStorageProblem(error);
      return false;
    }
  }

  function pknSaveState() {
    pknStorageSet(PKN_STATE_KEY, JSON.stringify({
      v: PKN_SAVE_VERSION,
      kind: pknGame.kind,
      mode: pknGame.mode,
      size: pknGame.size,
      sequence: pknGame.sequence,
      round: pknRoundFor(pknGame.sequence.length),
      result: pknGame.result,
      day: pknGame.day
    }));
  }

  function pknReadDaily() {
    return pknParseDaily(pknStorageGet(PKN_DAILY_KEY));
  }

  // The later of two Daily records: the stored one (another tab may have
  // played on), unless the one in memory is of a later day. A record
  // without a day counts as the oldest; either may be null.
  function pknLaterDaily(stored, memory) {
    var storedDay = stored && stored.day ? stored.day : '';
    var memoryDay = memory && memory.day ? memory.day : '';
    return !stored || memoryDay > storedDay ? memory : stored;
  }

  // Writes the current Daily record, unless storage holds a later day's
  // record by now (a newer Daily begun in another tab after midnight). Day
  // keys are YYYY-MM-DD, so they compare as text.
  function pknCommitDaily() {
    var stored = pknReadDaily();
    var record = pknRt.daily;
    if (stored && stored.day > record.day) {
      return;
    }
    pknStorageSet(PKN_DAILY_KEY, JSON.stringify({
      day: record.day,
      number: record.number,
      status: record.status,
      score: record.score,
      streak: record.streak,
      lastWin: record.lastWin
    }));
  }

  function pknBestKey() {
    return pknGame.mode + '-' + pknGame.size;
  }

  // Records a passed round's length as the best of its mode and size.
  // Returns true for a new best.
  function pknRecordBest(length) {
    var key = pknBestKey();
    var best = pknParseBest(pknStorageGet(PKN_BEST_KEY));
    Object.keys(pknRt.best).forEach(function (name) {
      best[name] = Math.max(best[name] || 0, pknRt.best[name]);
    });
    pknRt.best = best;
    if (length <= (best[key] || 0)) {
      return false;
    }
    best[key] = length;
    pknStorageSet(PKN_BEST_KEY, JSON.stringify(best));
    return true;
  }

  // ── Sound (optional, off by default) ──────────────────────────────────────

  function pknAudioClass() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function pknAudio() {
    var AudioClass = pknAudioClass();
    if (!pknRt.audio && AudioClass) {
      try {
        pknRt.audio = new AudioClass();
      } catch (error) {
        pknRt.audio = null;
      }
    }
    return pknRt.audio;
  }

  // A user gesture lets a suspended context play.
  function pknWakeAudio() {
    var context = pknRt.sound ? pknAudio() : null;
    if (context && context.state === 'suspended') {
      context.resume();
    }
  }

  function pknPlay(frequency, ms, wave) {
    var context = pknRt.sound ? pknAudio() : null;
    if (!context) {
      return;
    }
    try {
      var start = context.currentTime;
      var end = start + ms / 1000;
      var oscillator = context.createOscillator();
      var gain = context.createGain();
      oscillator.type = wave;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    } catch (error) {
      // A broken audio stack only costs the sound.
    }
  }

  function pknToneFor(index) {
    pknPlay(PKN_TONES[index], 160, 'triangle');
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function pknSpan(className, text) {
    var span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  }

  // Builds the port buttons when the panel size changed.
  function pknBuildPorts() {
    var panel = pknRt.els.panel;
    if (pknRt.builtSize === pknGame.size) {
      return;
    }
    panel.textContent = '';
    pknRt.ports = [];
    panel.style.setProperty('--pkn-cols', String(PKN_COLUMNS[pknGame.size]));
    panel.setAttribute('data-size', String(pknGame.size));
    for (var i = 0; i < pknGame.size; i++) {
      var info = PKN_PORTS[i];
      var key = pknKeyLabel(i, pknGame.size);
      var button = document.createElement('button');
      var jack = pknSpan('pkn-jack', '');
      button.type = 'button';
      button.className = 'pkn-port';
      button.setAttribute('data-port', String(i));
      button.setAttribute('tabindex', '-1');
      button.setAttribute('aria-label', 'Port ' + info.port + ' (' + info.service + '), key ' + key);
      jack.appendChild(pknSpan('pkn-pins', ''));
      button.appendChild(pknSpan('pkn-led', ''));
      button.appendChild(jack);
      button.appendChild(pknSpan('pkn-port-num', String(info.port)));
      button.appendChild(pknSpan('pkn-port-svc', info.service));
      button.appendChild(pknSpan('pkn-key', key));
      panel.appendChild(button);
      pknRt.ports.push(button);
    }
    pknRt.builtSize = pknGame.size;
  }

  function pknMark(index, className, on) {
    pknRt.ports[index].classList.toggle(className, on);
  }

  function pknClearPorts() {
    pknRt.ports.forEach(function (button) {
      PKN_PORT_STATES.forEach(function (name) {
        button.classList.remove(name);
      });
    });
    pknRt.els.panel.classList.remove('pkn-panel-up');
    pknRt.els.panel.classList.remove('pkn-panel-down');
  }

  // Restarts a CSS animation class on an element.
  function pknReplay(el, className) {
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
  }

  function pknSetOutput(text, kind) {
    var output = pknRt.els.output;
    output.className = 'pkn-output';
    void output.offsetWidth;
    if (kind) {
      output.classList.add('pkn-out-' + kind);
    }
    output.textContent = text;
  }

  // Port indices as the port numbers they stand for, '22 80 443'.
  function pknPortList(ports) {
    return ports.map(function (index) {
      return PKN_PORTS[index].port;
    }).join(' ');
  }

  function pknShowLog(text) {
    var log = pknRt.els.log;
    log.textContent = text;
    log.classList.add('pkn-log-on');
  }

  function pknHideLog() {
    pknRt.els.log.classList.remove('pkn-log-on');
    pknRt.els.log.textContent = '';
  }

  function pknSetStatus(text) {
    pknRt.els.status.textContent = text;
  }

  function pknSetNote(text) {
    var note = pknRt.els.note;
    note.textContent = text;
    note.classList.remove(PKN_HIDDEN);
  }

  function pknShowToast(message) {
    var toast = pknRt.els.toast;
    clearTimeout(pknRt.toastTimer);
    toast.textContent = message;
    toast.classList.add('pkn-show');
    pknRt.toastTimer = setTimeout(pknHideToast, PKN_TOAST_MS);
  }

  function pknHideToast() {
    pknRt.toastTimer = null;
    pknRt.els.toast.classList.remove('pkn-show');
  }

  function pknToday() {
    var day = pknDayKey(new Date());
    return { day: day, number: pknDailyNumber(day) };
  }

  function pknIsDaily() {
    return pknGame.kind === 'daily';
  }

  function pknDailyName(number) {
    return 'Daily #' + number;
  }

  // The Daily record of today, or null.
  function pknTodayRecord(today) {
    var record = pknRt.daily;
    return record && record.day === today.day ? record : null;
  }

  // The Daily button's text and accessible name. The name starts with the
  // text, so voice control finds the button by what it shows.
  function pknDailyButton(today) {
    var record = pknTodayRecord(today);
    var name = pknDailyName(today.number);
    if (record && record.status !== 'playing') {
      return [name + ' done', name + ' done: show the result'];
    }
    if (pknIsDaily() && pknGame.day === today.day) {
      return [name, name + ': today\'s sequence, on the panel now'];
    }
    if (record) {
      return ['Resume ' + name, 'Resume ' + name + ' at the round it reached'];
    }
    return [name, name + ': play today\'s sequence, one scored attempt'];
  }

  function pknLongest() {
    return pknScoreFor(pknGame.sequence.length, pknGame.result === 'won');
  }

  // A Daily record's score against its target: "sequence 3 of 8".
  function pknScoreText(record) {
    return 'sequence ' + record.score + ' of ' + pknDailyConfig(record.number).target;
  }

  // The Start button's label; it is disabled while a round runs.
  var PKN_RUNNING_LABELS = { show: 'Watch...', input: 'Knock!', success: 'Connected' };

  function pknStartLabel() {
    var phase = pknRt.phase;
    if (phase === 'idle') {
      return pknRt.paused ? 'Replay show' : 'Start';
    }
    if (phase === 'over') {
      return pknIsDaily() ? 'Daily result' : 'Try again';
    }
    return PKN_RUNNING_LABELS[phase];
  }

  function pknRenderProgress() {
    var progress = pknRt.els.progress;
    var owed = pknExpectedOrder(pknGame.sequence, pknGame.mode).length;
    var filled = pknRt.phase === 'success' ? owed : pknRt.entered.length;
    progress.textContent = '';
    for (var i = 0; i < owed; i++) {
      progress.appendChild(pknSpan(i < filled ? 'pkn-dot pkn-dot-on' : 'pkn-dot', ''));
    }
    progress.setAttribute('aria-label', filled + ' of ' + owed + ' knocks entered');
  }

  function pknCommandText() {
    var host = PKN_HOST;
    if (pknGame.kind !== 'practice') {
      host = 'daily-' + pknDailyNumber(pknGame.day) + '.' + PKN_HOST;
    }
    return '$ knock ' + PKN_MODE_INFO[pknGame.mode].flag + ' ' + host +
      (pknGame.kind === 'replay' ? '   # unscored replay' : '');
  }

  function pknRender() {
    var els = pknRt.els;
    var today = pknToday();
    var best = pknRt.best[pknBestKey()];
    var daily = pknDailyButton(today);
    pknBuildPorts();
    els.round.textContent = String(pknRoundFor(pknGame.sequence.length));
    els.longest.textContent = String(pknLongest());
    els.best.textContent = best ? String(best) : PKN_NO_BEST;
    els.streak.textContent = String(pknStreakFor(pknRt.daily, today.number));
    els.command.textContent = pknCommandText();
    els.hint.textContent = PKN_MODE_INFO[pknGame.mode].hint;
    els.mode.value = pknGame.mode;
    els.size.value = String(pknGame.size);
    els.daily.textContent = daily[0];
    els.daily.setAttribute('aria-label', daily[1]);
    els.start.textContent = pknStartLabel();
    els.start.disabled = PKN_RUNNING_LABELS[pknRt.phase] !== undefined;
    els.sound.textContent = pknRt.sound ? 'Sound: on' : 'Sound: off';
    els.sound.setAttribute('aria-pressed', String(pknRt.sound));
    els.sound.setAttribute('aria-label', pknRt.sound ? 'Sound on: turn the sound off' : 'Sound off: turn the sound on');
    pknRenderProgress();
  }

  // What the status line says while the game waits for Start. A length is
  // always a "sequence"; "knocks" are only what the player enters.
  function pknIdleStatus() {
    var round = pknRoundFor(pknGame.sequence.length);
    var length = pknGame.sequence.length;
    if (pknRt.paused) {
      return 'Round ' + round + ' (sequence ' + length + ') is waiting. Press Start or Enter to replay the show.';
    }
    return 'Round ' + round + ' (sequence ' + length + '): watch the panel, then knock it back. Press Start or Enter.';
  }

  function pknInputStatus() {
    var length = pknGame.sequence.length;
    if (pknGame.mode === 'reverse') {
      return 'Your turn: knock the ' + length + ' ports backwards, the last one first.';
    }
    if (pknGame.mode === 'stride') {
      return 'Your turn: knock every second port, ' + pknExpectedOrder(pknGame.sequence, 'stride').length +
        ' of the ' + length + '.';
    }
    return 'Your turn: knock the ' + length + ' ports in order.';
  }

  // The Daily result card (only for a finished Daily).
  function pknShowResult(record) {
    var els = pknRt.els;
    var config = pknDailyConfig(record.number);
    var won = record.status === 'won';
    els.resultTitle.textContent = pknDailyName(record.number) + (won ? ': ssh: connection established' : ': connection refused');
    els.resultText.textContent = PKN_MODE_INFO[config.mode].label + ', ' + config.size + ' ports: ' +
      pknScoreText(record) + '. Streak: ' + record.streak +
      '. One scored attempt a day; a new Daily starts at midnight.';
    els.shareText.classList.add(PKN_HIDDEN);
    els.result.classList.remove(PKN_HIDDEN);
  }

  function pknHideResult() {
    pknRt.els.result.classList.add(PKN_HIDDEN);
  }

  // ── Timers ────────────────────────────────────────────────────────────────

  function pknStopWindow() {
    clearTimeout(pknRt.windowTimer);
    pknRt.windowTimer = null;
    pknRt.windowLeft = null;
    pknRt.els.windowFill.classList.remove('pkn-window-run');
  }

  // Runs the knock window with ms left of its PKN_WINDOW_MS.
  function pknStartWindow(ms) {
    var fill = pknRt.els.windowFill;
    clearTimeout(pknRt.windowTimer);
    pknRt.windowLeft = null;
    pknRt.windowDeadline = performance.now() + ms;
    pknRt.windowTimer = setTimeout(pknWindowClosed, ms);
    fill.style.setProperty('--pkn-window-ms', PKN_WINDOW_MS + 'ms');
    fill.style.setProperty('--pkn-window-delay', (ms - PKN_WINDOW_MS) + 'ms');
    pknReplay(fill, 'pkn-window-run');
  }

  function pknClearKnockFlash() {
    clearTimeout(pknRt.knockTimer);
    pknRt.knockTimer = null;
    if (pknRt.knockPort !== -1) {
      pknMark(pknRt.knockPort, 'pkn-port-hit', false);
      pknRt.knockPort = -1;
    }
  }

  // Stops the show, the knock window, the next-round pause and the flashes.
  function pknStopAll() {
    clearTimeout(pknRt.showTimer);
    clearTimeout(pknRt.nextTimer);
    pknRt.showTimer = null;
    pknRt.nextTimer = null;
    pknClearKnockFlash();
    pknStopWindow();
    pknHideLog();
    pknClearPorts();
    pknRt.entered = [];
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  function pknFreshSequence(size) {
    var seq = [];
    while (seq.length < PKN_START_LENGTH) {
      seq = pknExtendSequence(seq, Math.random, size);
    }
    return seq;
  }

  // Puts a game on screen, idle; paused says whether Start replays its show.
  function pknSetGame(game, phase, paused) {
    pknStopAll();
    pknHideResult();
    pknGame.kind = game.kind;
    pknGame.mode = game.mode;
    pknGame.size = game.size;
    pknGame.sequence = game.sequence;
    pknGame.result = game.result;
    pknGame.day = game.day;
    pknRt.phase = phase;
    pknRt.paused = paused;
    pknSetOutput('knockd: listening on ' + PKN_HOST, '');
    pknRender();
  }

  // A new practice run of mode and size, saved; it starts its show at once
  // when start is true (New Game, Restart), else it waits for Start.
  function pknNewPractice(mode, size, start) {
    pknSetGame({ kind: 'practice', mode: mode, size: size, sequence: pknFreshSequence(size), result: 'playing', day: null }, 'idle', false);
    pknSaveState();
    if (start) {
      pknRunShow();
    } else {
      pknSetStatus(pknIdleStatus());
    }
  }

  function pknDailyGame(kind, day, length) {
    var config = pknDailyConfig(pknDailyNumber(day));
    return {
      kind: kind,
      mode: config.mode,
      size: config.size,
      sequence: pknDailySequence(day, length, config.size),
      result: 'playing',
      day: day
    };
  }

  // The length of the round a Daily record has reached: the next round while
  // it plays or after a loss, the target length once it is won.
  function pknDailyLength(record) {
    return Math.max(PKN_START_LENGTH, record.status === 'won' ? record.score : record.score + 1);
  }

  function pknRunShow() {
    if (pknIsDaily() && pknTakeOverDaily()) {
      return;
    }
    pknStopAll();
    pknHideResult();
    pknRt.phase = 'show';
    pknRt.paused = false;
    pknRt.steps = pknShowSteps(pknGame.sequence);
    pknRt.step = 0;
    pknSetOutput('knockd: replaying knock sequence', '');
    var logged = pknRt.steps[0].type === 'log' ? pknRt.steps[0].ports.length : 0;
    pknSetStatus('Watch the panel: round ' + pknRoundFor(pknGame.sequence.length) + ', sequence ' +
      pknGame.sequence.length + (logged ? ', the first ' + logged + ' in the log line.' : '.'));
    pknRender();
    pknRt.showTimer = setTimeout(pknShowStep, pknRt.steps[0].at);
  }

  function pknShowStep() {
    var step = pknRt.steps[pknRt.step];
    pknRt.showTimer = null;
    pknRt.step += 1;
    if (step.type === 'log') {
      pknShowLog('[knockd] seq ' + pknPortList(step.ports) + ' ...');
    } else if (step.type === 'unlog') {
      pknHideLog();
    } else if (step.type === 'on') {
      pknMark(step.port, 'pkn-port-lit', true);
      pknToneFor(step.port);
    } else if (step.type === 'off') {
      pknMark(step.port, 'pkn-port-lit', false);
    } else {
      pknBeginInput();
      return;
    }
    pknRt.showTimer = setTimeout(pknShowStep, pknRt.steps[pknRt.step].at - step.at);
  }

  function pknBeginInput() {
    pknRt.phase = 'input';
    pknRt.entered = [];
    pknSetOutput('knockd: waiting for the first knock', '');
    pknSetStatus(pknInputStatus());
    pknRender();
  }

  // Start, Enter and Space: the show of a waiting round, a new try after a
  // lost practice run or replay, or the result of a finished Daily.
  function pknStart() {
    pknWakeAudio();
    if (pknRt.phase === 'idle') {
      pknRunShow();
    } else if (pknRt.phase === 'over' && pknIsDaily()) {
      pknShowResult(pknRt.daily);
    } else if (pknRt.phase === 'over' && pknGame.kind === 'replay') {
      pknStartReplay(pknGame.day);
    } else if (pknRt.phase === 'over') {
      pknNewPractice(pknGame.mode, pknGame.size, true);
    }
  }

  // A knock on port index. Returns whether the game took it.
  function pknKnock(index) {
    if (pknRt.phase !== 'input' || index >= pknGame.size) {
      return false;
    }
    var expected = pknExpectedOrder(pknGame.sequence, pknGame.mode);
    var verdict = pknCheckInput(expected, pknRt.entered, index);
    pknClearKnockFlash();
    pknMark(index, 'pkn-port-hit', true);
    pknRt.knockPort = index;
    pknRt.knockTimer = setTimeout(pknClearKnockFlash, PKN_KNOCK_FLASH_MS);
    if (pknRt.entered.length === 0) {
      pknRt.firstKnockAt = performance.now();
    }
    if (verdict === 'wrong') {
      pknPlay(110, 420, 'sawtooth');
      pknRoundFailed(index, expected[pknRt.entered.length]);
      return true;
    }
    pknToneFor(index);
    pknRt.entered.push(index);
    if (verdict === 'done') {
      pknRoundPassed(expected.length);
    } else {
      pknStartWindow(PKN_WINDOW_MS);
      pknSetOutput('knockd: stage ' + pknRt.entered.length + '/' + expected.length + ' ok', '');
      pknRenderProgress();
    }
    return true;
  }

  function pknWindowClosed() {
    var last = pknRt.entered[pknRt.entered.length - 1];
    pknRt.windowTimer = null;
    pknRt.entered = [];
    pknRt.els.windowFill.classList.remove('pkn-window-run');
    pknSetOutput('knockd: sequence timeout (' + PKN_WINDOW_MS / 1000 + ' s), state reset', 'warn');
    pknSetStatus('Knock window closed: more than ' + PKN_WINDOW_MS / 1000 + ' s after port ' +
      PKN_PORTS[last].port + '. The sequence reset: start again from the first knock.');
    pknRenderProgress();
  }

  function pknRoundPassed(knocks) {
    if (pknIsDaily() && pknTakeOverDaily()) {
      return;
    }
    var length = pknGame.sequence.length;
    var seconds = ((performance.now() - pknRt.firstKnockAt) / 1000).toFixed(2);
    var target = pknGame.kind === 'practice' ? 0 : pknDailyConfig(pknDailyNumber(pknGame.day)).target;
    pknStopWindow();
    pknRt.phase = 'success';
    pknRt.els.panel.classList.add('pkn-panel-up');
    pknSetOutput('ssh: connection established (' + knocks + ' knocks in ' + seconds + ' s)', 'ok');
    pknPlay(880, 220, 'sine');
    if (pknGame.kind !== 'replay' && pknRecordBest(length)) {
      pknShowToast('New best: sequence ' + length + ' (' + PKN_MODE_INFO[pknGame.mode].label + ', ' + pknGame.size + ' ports)');
    }
    if (pknIsDaily()) {
      pknRt.daily.score = length;
      pknCommitDaily();
    }
    if (target && length >= target) {
      pknFinishDaily('won', '');
      return;
    }
    pknGame.sequence = pknGame.kind === 'practice' ?
      pknExtendSequence(pknGame.sequence, Math.random, pknGame.size) :
      pknDailySequence(pknGame.day, length + 1, pknGame.size);
    pknSaveState();
    pknSetStatus('Access granted: sequence ' + length + '. Round ' + pknRoundFor(length + 1) + ' (sequence ' +
      (length + 1) + ') starts in a moment.');
    pknRender();
    pknRt.nextTimer = setTimeout(pknNextRound, PKN_NEXT_ROUND_MS);
  }

  function pknNextRound() {
    pknRt.nextTimer = null;
    pknRunShow();
  }

  // A wrong knock: the run ends, and the log line shows the whole sequence
  // the round wanted, in the order it was owed.
  function pknRoundFailed(port, wanted) {
    if (pknIsDaily() && pknTakeOverDaily()) {
      return;
    }
    var position = pknRt.entered.length + 1;
    var expected = pknExpectedOrder(pknGame.sequence, pknGame.mode);
    var owed = expected.length;
    pknStopWindow();
    pknRt.phase = 'over';
    pknRt.entered = [];
    pknGame.result = 'lost';
    pknMark(port, 'pkn-port-bad', true);
    pknMark(wanted, 'pkn-port-want', true);
    pknReplay(pknRt.els.panel, 'pkn-panel-down');
    pknSetOutput('ssh: connect to host ' + PKN_HOST + ' port 22: Connection refused', 'err');
    pknShowLog('[knockd] expected ' + pknPortList(expected));
    pknSaveState();
    var why = 'Connection refused: you knocked ' + PKN_PORTS[port].port + ', the sequence wanted ' +
      PKN_PORTS[wanted].port + ' (knock ' + position + ' of ' + owed + '). Longest: sequence ' + pknLongest() + '.';
    if (pknIsDaily()) {
      pknFinishDaily('lost', why + ' ');
      return;
    }
    pknSetStatus(why + ' Press Start or Enter for a new run.');
    pknRender();
  }

  // The end of a Daily (status 'won' or 'lost') or of its unscored replay
  // reaching the target; lead goes before the status text.
  function pknFinishDaily(status, lead) {
    var record = pknRt.daily;
    pknRt.phase = 'over';
    pknGame.result = status;
    pknSaveState();
    if (pknGame.kind === 'replay') {
      pknSetStatus('Unscored replay of ' + pknDailyName(pknDailyNumber(pknGame.day)) + ' complete: sequence ' +
        pknGame.sequence.length + '. Press Start to play it again.');
      pknRender();
      return;
    }
    record.status = status;
    record.score = pknLongest();
    if (status === 'won') {
      record.streak = record.lastWin === record.number - 1 ? record.streak + 1 : 1;
      record.lastWin = record.number;
    } else {
      record.streak = 0;
    }
    pknCommitDaily();
    pknSetStatus(lead + (status === 'won' ?
      pknDailyName(record.number) + ' complete: ' + pknScoreText(record) + ', streak ' + record.streak + '.' :
      pknDailyName(record.number) + ' is over at ' + pknScoreText(record) + '. Streak reset to 0.'));
    pknRender();
    pknShowResult(record);
  }

  // Another tab may have finished the Daily this tab still plays: storage
  // then holds a record of the same day with a final status. That result
  // stands: it becomes this tab's record (never written over) and a toast
  // names it. Only called while the Daily on screen plays. Returns whether
  // it happened.
  function pknFinishedElsewhere() {
    var stored = pknReadDaily();
    if (!stored || stored.day !== pknRt.daily.day || stored.status === 'playing') {
      return false;
    }
    pknRt.daily = stored;
    pknShowToast(pknDailyName(stored.number) + ' was finished in another tab: ' + stored.status + ' at ' +
      pknScoreText(stored) + '.');
    return true;
  }

  // Checked before every scored step of the Daily on screen (its show, a
  // passed or failed round): when another tab finished it, the round stops
  // and the Daily is put on screen finished, with its result card, as a
  // reload would show it. Returns whether it happened.
  function pknTakeOverDaily() {
    if (!pknFinishedElsewhere()) {
      return false;
    }
    var record = pknRt.daily;
    var daily = pknDailyGame('daily', record.day, pknDailyLength(record));
    daily.result = record.status;
    pknSetGame(daily, 'over', false);
    pknSaveState();
    pknSetStatus(pknDailyName(record.number) + ' was finished in another tab: ' + record.status + ' at ' +
      pknScoreText(record) + ', streak ' + record.streak + '. A new Daily starts at midnight.');
    pknShowResult(record);
    return true;
  }

  // The Daily button: today's attempt begun (its record written before the
  // first show), resumed, or its result shown when it is finished.
  // Storage is read again first (another tab may have played on); the later
  // of the stored record and the one in memory counts, so a blocked, full or
  // cleared storage never hands out a second attempt, and a record another
  // tab wrote since never loses its streak.
  function pknOnDaily() {
    var today = pknToday();
    if (pknIsDaily() && pknGame.day === today.day && pknRt.phase !== 'over') {
      if (!pknTakeOverDaily()) {
        pknStart();
      }
      return;
    }
    if (pknIsDaily() && pknGame.result === 'playing') {
      // A Daily begun before midnight still runs: it ends here, and a
      // practice game takes the screen until today's Daily does.
      pknLeaveDaily();
      pknNewPractice(pknGame.mode, pknGame.size, false);
    }
    var previous = pknLaterDaily(pknReadDaily(), pknRt.daily);
    if (previous && previous.day === today.day) {
      pknRt.daily = previous;
      if (previous.status === 'playing') {
        pknSetGame(pknDailyGame('daily', today.day, pknDailyLength(previous)), 'idle', true);
        pknSaveState();
        pknStart();
      } else {
        pknRender();
        pknShowResult(previous);
      }
      return;
    }
    pknRt.daily = {
      day: today.day,
      number: today.number,
      status: 'playing',
      score: 0,
      streak: pknStreakFor(previous, today.number),
      lastWin: previous ? previous.lastWin : 0
    };
    pknCommitDaily();
    pknSetGame(pknDailyGame('daily', today.day, PKN_START_LENGTH), 'idle', false);
    pknSaveState();
    pknStart();
  }

  function pknStartReplay(day) {
    pknSetGame(pknDailyGame('replay', day, PKN_START_LENGTH), 'idle', false);
    pknSaveState();
    pknStart();
  }

  // The mode and panel size the selects show.
  function pknSelectedMode() {
    return pknOneOf(PKN_MODES, pknRt.els.mode.value, 'forward');
  }

  function pknSelectedSize() {
    return pknOneOf(PKN_SIZES, Number(pknRt.els.size.value), PKN_SIZES[0]);
  }

  // Leaving a running Daily for practice keeps its attempt: say how to
  // come back to it. One begun before midnight cannot come back (the Daily
  // button begins today's), so leaving it ends it as lost, as a reload would.
  // One another tab has finished meanwhile keeps that result.
  function pknLeaveDaily() {
    if (!pknIsDaily() || pknGame.result !== 'playing' || pknFinishedElsewhere()) {
      return;
    }
    var today = pknToday();
    var name = pknDailyName(pknDailyNumber(pknGame.day));
    var round = pknRoundFor(pknGame.sequence.length);
    if (pknGame.day === today.day) {
      pknShowToast(name + ' paused at round ' + round + ': the Daily button resumes it.');
      return;
    }
    pknRt.daily.status = 'lost';
    pknRt.daily.streak = 0;
    pknCommitDaily();
    pknShowToast(name + ' ended at round ' + round + ': it began before midnight, and today is ' +
      pknDailyName(today.number) + '.');
  }

  function pknOnNewGame() {
    pknLeaveDaily();
    pknNewPractice(pknSelectedMode(), pknSelectedSize(), true);
    pknFocusStage();
  }

  // Restart: the current practice game (or replay) again from round 1. The
  // Daily has one scored attempt, so Restart refuses while it is on screen.
  function pknOnRestart() {
    if (pknIsDaily()) {
      pknShowToast('Restart is off during ' + pknDailyName(pknDailyNumber(pknGame.day)) +
        ': it has one scored attempt. New Game switches to practice.');
      return;
    }
    if (pknGame.kind === 'replay') {
      pknStartReplay(pknGame.day);
    } else {
      pknNewPractice(pknGame.mode, pknGame.size, true);
    }
    pknFocusStage();
  }

  // A mode or panel size picked: a new practice game that waits for Start.
  function pknOnSettingChange() {
    pknLeaveDaily();
    pknNewPractice(pknSelectedMode(), pknSelectedSize(), false);
  }

  function pknOnSoundToggle() {
    if (!pknRt.sound && !pknAudioClass()) {
      pknShowToast('Sound is not available: this browser has no Web Audio (AudioContext).');
      return;
    }
    pknRt.sound = !pknRt.sound;
    pknStorageSet(PKN_SOUND_KEY, pknRt.sound ? 'on' : 'off');
    pknWakeAudio();
    pknRender();
  }

  // Share: the result line to the clipboard, or selected in a read-only
  // field when the clipboard is missing or refuses.
  function pknOnShare() {
    var text = pknShareText(pknRt.daily);
    var clipboard = navigator.clipboard;
    function fallback() {
      var field = pknRt.els.shareText;
      field.value = text;
      field.classList.remove(PKN_HIDDEN);
      field.focus();
      field.select();
      pknShowToast('Clipboard unavailable: the result is selected in the field below.');
    }
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text).then(function () {
        pknShowToast('Copied: ' + text);
      }, fallback);
    } else {
      fallback();
    }
  }

  function pknOnReplay() {
    pknStartReplay(pknRt.daily.day);
    pknFocusStage();
  }

  function pknOnResultClose() {
    pknHideResult();
    pknFocusStage();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  function pknInGame(node) {
    for (; node; node = node.parentNode) {
      if (node === pknRt.els.wrapper) {
        return true;
      }
    }
    return false;
  }

  function pknFocusStage() {
    pknRt.els.stage.focus({ preventScroll: true });
  }

  function pknIsField(target) {
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  function pknIsActionKey(event) {
    return event.key === 'Enter' || event.key === ' ' || event.code === 'Space' || event.code === 'NumpadEnter';
  }

  function pknIsPort(target) {
    return pknRt.ports.indexOf(target) !== -1;
  }

  // Digits knock, Enter and Space start (see the header for whose keys these
  // are). A held key acts once.
  function pknOnKeydown(event) {
    var target = event.target;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing ||
        !pknInGame(target) || pknIsField(target)) {
      return;
    }
    var port = pknKeyToPort(event, pknGame.size);
    if (port !== null) {
      event.preventDefault();
      if (!event.repeat) {
        pknKnock(port);
      }
    } else if (pknIsActionKey(event) && (target.tagName !== 'BUTTON' || pknIsPort(target))) {
      event.preventDefault();
      if (!event.repeat) {
        pknStart();
      }
    }
  }

  // A click or tap on the panel: the port it hit knocks. Keys need the focus
  // in the game, so a port clicked while the focus is elsewhere (Safari does
  // not focus buttons) hands it to the play area.
  function pknOnPanelClick(event) {
    var port = event.target.closest('.pkn-port');
    if (!port) {
      return;
    }
    if (!pknInGame(document.activeElement)) {
      pknFocusStage();
    }
    pknKnock(Number(port.getAttribute('data-port')));
  }

  function pknOnStartClick() {
    pknStart();
    pknFocusStage();
  }

  // A hidden tab pauses whatever runs on a clock: the show (Start replays
  // it), the pause before the next round, and the knock window (its time
  // left comes back when the tab does).
  function pknOnVisibilityChange() {
    if (document.visibilityState !== 'hidden') {
      if (pknRt.phase === 'input' && pknRt.windowLeft !== null) {
        pknStartWindow(pknRt.windowLeft);
      }
      return;
    }
    if (pknRt.phase === 'show' || pknRt.phase === 'success') {
      pknStopAll();
      pknRt.phase = 'idle';
      pknRt.paused = true;
      pknSetOutput('knockd: paused', '');
      pknSetStatus('Paused while the tab was hidden. Press Start or Enter to replay round ' +
        pknRoundFor(pknGame.sequence.length) + '.');
      pknRender();
    } else if (pknRt.windowTimer !== null) {
      var left = Math.max(0, pknRt.windowDeadline - performance.now());
      clearTimeout(pknRt.windowTimer);
      pknRt.windowTimer = null;
      pknRt.windowLeft = left;
      pknRt.els.windowFill.classList.remove('pkn-window-run');
    }
  }

  function pknBindEvents() {
    var els = pknRt.els;
    els.panel.addEventListener('click', pknOnPanelClick);
    els.start.addEventListener('click', pknOnStartClick);
    els.newGame.addEventListener('click', pknOnNewGame);
    els.restart.addEventListener('click', pknOnRestart);
    els.daily.addEventListener('click', pknOnDaily);
    els.sound.addEventListener('click', pknOnSoundToggle);
    els.mode.addEventListener('change', pknOnSettingChange);
    els.size.addEventListener('change', pknOnSettingChange);
    els.share.addEventListener('click', pknOnShare);
    els.replay.addEventListener('click', pknOnReplay);
    els.resultClose.addEventListener('click', pknOnResultClose);
    document.addEventListener('keydown', pknOnKeydown);
    document.addEventListener('visibilitychange', pknOnVisibilityChange);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  // Restores what storage holds: a practice game or replay as saved, today's
  // Daily resumed (waiting) or finished, anything else a fresh practice game.
  // A Daily attempt left unfinished on an earlier day counts as lost.
  function pknLoad() {
    var today = pknToday();
    var record = pknReadDaily();
    var saved = pknParseState(pknStorageGet(PKN_STATE_KEY));
    pknRt.best = pknParseBest(pknStorageGet(PKN_BEST_KEY));
    pknRt.daily = record;
    if (record && record.status === 'playing' && record.day !== today.day) {
      record.status = 'lost';
      record.streak = 0;
      pknCommitDaily();
    }
    if (!saved) {
      pknNewPractice('forward', PKN_SIZES[0], false);
      return;
    }
    if (saved.kind === 'daily' && record && record.day === saved.day && saved.day === today.day) {
      var finished = record.status !== 'playing';
      var daily = pknDailyGame('daily', saved.day, pknDailyLength(record));
      daily.result = record.status;
      pknSetGame(daily, finished ? 'over' : 'idle', !finished);
      if (finished) {
        pknSetStatus(pknDailyName(record.number) + ' is finished: ' + pknScoreText(record) + '. A new Daily starts at midnight.');
        pknShowResult(record);
      } else {
        pknSetStatus(pknDailyName(record.number) + ' resumed. ' + pknIdleStatus());
      }
      return;
    }
    if (saved.kind === 'daily' || !saved.sequence) {
      pknNewPractice(saved.mode, saved.size, false);
      return;
    }
    if (saved.kind === 'replay') {
      saved.mode = pknDailyConfig(pknDailyNumber(saved.day)).mode;
      saved.size = PKN_DAILY_SIZE;
      saved.sequence = pknDailySequence(saved.day, saved.sequence.length, PKN_DAILY_SIZE);
    }
    var over = saved.result !== 'playing';
    pknSetGame(saved, over ? 'over' : 'idle', !over);
    pknSetStatus(over ? 'The last run ended at sequence ' + pknLongest() + '. Press Start or Enter for a new run.' : pknIdleStatus());
  }

  function pknFindElements() {
    return {
      wrapper: document.getElementById('pkn-game'),
      stage: document.getElementById('pkn-stage'),
      panel: document.getElementById('pkn-panel'),
      command: document.getElementById('pkn-command'),
      log: document.getElementById('pkn-log'),
      output: document.getElementById('pkn-output'),
      progress: document.getElementById('pkn-progress'),
      windowFill: document.getElementById('pkn-window-fill'),
      hint: document.getElementById('pkn-hint'),
      round: document.getElementById('pkn-round'),
      longest: document.getElementById('pkn-longest'),
      best: document.getElementById('pkn-best'),
      streak: document.getElementById('pkn-streak'),
      mode: document.getElementById('pkn-mode'),
      size: document.getElementById('pkn-size'),
      newGame: document.getElementById('pkn-new-game'),
      restart: document.getElementById('pkn-restart'),
      daily: document.getElementById('pkn-daily'),
      sound: document.getElementById('pkn-sound'),
      start: document.getElementById('pkn-start'),
      status: document.getElementById('pkn-status'),
      note: document.getElementById('pkn-note'),
      result: document.getElementById('pkn-result'),
      resultTitle: document.getElementById('pkn-result-title'),
      resultText: document.getElementById('pkn-result-text'),
      share: document.getElementById('pkn-share'),
      shareText: document.getElementById('pkn-share-text'),
      replay: document.getElementById('pkn-replay'),
      resultClose: document.getElementById('pkn-result-close'),
      toast: document.getElementById('pkn-toast')
    };
  }

  // Runs once; a second call changes nothing.
  function pknInit() {
    if (pknRt.els) {
      return;
    }
    pknRt.els = pknFindElements();
    pknBindEvents();
    pknRt.sound = pknStorageGet(PKN_SOUND_KEY) === 'on' && !!pknAudioClass();
    pknLoad();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      pknGame: pknGame,
      pknRt: pknRt,
      pknPorts: PKN_PORTS,
      pknModes: PKN_MODES,
      pknSizes: PKN_SIZES,
      pknInit: pknInit,
      pknExtendSequence: pknExtendSequence,
      pknExpectedOrder: pknExpectedOrder,
      pknCheckInput: pknCheckInput,
      pknScoreFor: pknScoreFor,
      pknRoundFor: pknRoundFor,
      pknIntervalFor: pknIntervalFor,
      pknLogCountFor: pknLogCountFor,
      pknShowSteps: pknShowSteps,
      pknKeyToPort: pknKeyToPort,
      pknKeyLabel: pknKeyLabel,
      pknDayKey: pknDayKey,
      pknIsDayKey: pknIsDayKey,
      pknDailyNumber: pknDailyNumber,
      pknFnv1a: pknFnv1a,
      pknMulberry32: pknMulberry32,
      pknDailySequence: pknDailySequence,
      pknDailyConfig: pknDailyConfig,
      pknStreakFor: pknStreakFor,
      pknShareText: pknShareText,
      pknLaterDaily: pknLaterDaily,
      pknParseState: pknParseState,
      pknParseBest: pknParseBest,
      pknParseDaily: pknParseDaily
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pknInit);
  } else {
    pknInit();
  }
})();
