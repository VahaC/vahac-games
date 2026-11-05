// Hash Cracker — script.js
// Prefix: hcr-
// Dependencies: none.  No network and no AI of any kind: the key, the
// scoring and the key-space counter are plain local JavaScript.
//
// The game: crack a hidden key in 10 attempts.  After every attempt the
// terminal prints how many symbols sit in the right place (HIT) and how many
// are in the key but elsewhere (NEAR), then how many keys are still possible
// and their entropy in bits (log2 of that count).
//   Easy    4 different digits 0-9          5,040 keys
//   Normal  4 different hex symbols 0-F    43,680 keys
//   Hard    5 hex symbols, repeats allowed  1,048,576 keys
// Easy and Normal filter the full list of keys after each attempt.  Hard
// never scans its million keys: a pruned search with a step budget counts the
// keys that are left, and gives up (the counter shows n/a) while too many
// remain, so the page never stalls.
//
// Input: the on-screen hex keypad, or the physical keys 0-9, A-F, Backspace
// and Enter while the focus is on the page body, the game or a host element
// that holds the game; fields, links and buttons of the host page keep their
// keys, and Ctrl/Alt/Cmd shortcuts stay with the browser.  On a non-Latin
// layout the keys in the A-F positions type A-F.
//
// Saves: hcr-state (mode, key, attempts, the key being typed) after every
// change; hcr-stats (wins, losses, current and best streak per mode) when a
// game ends.  Giving up a game with attempts made counts as a loss, after a
// second press of New Game (or of the other mode) within 4 s.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var HCR_HEX = '0123456789ABCDEF';

  var HCR_MODES = {
    easy: { name: 'Easy', length: 4, symbols: '0123456789', distinct: true, unit: 'digits', range: '0-9' },
    normal: { name: 'Normal', length: 4, symbols: HCR_HEX, distinct: true, unit: 'hex symbols', range: '0-F' },
    hard: { name: 'Hard', length: 5, symbols: HCR_HEX, distinct: false, unit: 'hex symbols', range: '0-F' }
  };
  var HCR_MODE_KEYS = ['easy', 'normal', 'hard'];

  var HCR_MAX_ATTEMPTS = 10;
  // Search steps the Hard counter may spend after an attempt (a few ms).
  var HCR_SEARCH_BUDGET = 60000;

  var HCR_STATE_KEY = 'hcr-state';
  var HCR_STATS_KEY = 'hcr-stats';
  var HCR_TOAST_MS = 2000;
  var HCR_CONFIRM_MS = 4000;

  var HCR_NEW_GAME_LABEL = 'New Game';
  var HCR_GIVE_UP_LABEL = 'Give up?';

  // ── State ─────────────────────────────────────────────────────────────────

  // The game in progress, field for field what hcr-state holds.  Changed in
  // place, so a reference to it stays current.
  var hcrState = {
    mode: 'easy',
    secret: '',
    guesses: [],
    input: ''
  };

  // Page handles and derived data, never saved: the elements and keypad
  // buttons (set by hcrInit), the stats and whether storage holds them, the
  // key-space counts after each attempt (counts[0] before the first), the
  // keys still possible (null when not counted), the toast timer, the
  // pending give-up confirmation ('new' or a mode), and whether a storage
  // warning showed.
  var hcrRuntime = {
    els: null,
    keys: {},
    stats: null,
    statsSaved: true,
    counts: [],
    list: null,
    toastTimer: null,
    confirm: null,
    storageWarned: false
  };

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function hcrHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function hcrIsObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hcrIsMode(mode) {
    return typeof mode === 'string' && hcrHasOwn(HCR_MODES, mode);
  }

  function hcrZeros(size) {
    var out = [];
    for (var i = 0; i < size; i++) {
      out.push(0);
    }
    return out;
  }

  // 43680 -> '43,680'.
  function hcrFormatCount(count) {
    return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // The entropy of a key space of `count` keys, in bits.
  function hcrBits(count) {
    return Math.log(count) / Math.LN2;
  }

  function hcrFormatBits(bits) {
    return bits.toFixed(2);
  }

  // '1 key', '5,040 keys'.
  function hcrPlural(count, word) {
    return hcrFormatCount(count) + ' ' + word + (count === 1 ? '' : 's');
  }

  // ── Keys and scoring (no DOM) ─────────────────────────────────────────────

  // A random key of a mode.  rnd returns numbers in [0, 1) like Math.random;
  // distinct modes draw without putting symbols back (a partial shuffle).
  function hcrMakeSecret(mode, rnd) {
    var spec = HCR_MODES[mode];
    var pool = spec.symbols.split('');
    var key = '';
    for (var i = 0; i < spec.length; i++) {
      var from = spec.distinct ? i : 0;
      var pick = Math.min(pool.length - 1, from + Math.floor(rnd() * (pool.length - from)));
      var symbol = pool[pick];
      if (spec.distinct) {
        pool[pick] = pool[i];
        pool[i] = symbol;
      }
      key += symbol;
    }
    return key;
  }

  // { hit, near } of a guess against the key (two codes of the same length):
  // hit counts the positions that match, near the shared symbols in other
  // positions: the sum over symbols of the smaller count in either code,
  // minus hit, so repeated symbols count once per copy in both.
  function hcrScore(secret, guess) {
    var inSecret = hcrZeros(HCR_HEX.length);
    var inGuess = hcrZeros(HCR_HEX.length);
    var hit = 0;
    var shared = 0;
    for (var i = 0; i < secret.length; i++) {
      if (secret.charAt(i) === guess.charAt(i)) {
        hit++;
      }
      inSecret[HCR_HEX.indexOf(secret.charAt(i))]++;
      inGuess[HCR_HEX.indexOf(guess.charAt(i))]++;
    }
    for (var s = 0; s < HCR_HEX.length; s++) {
      shared += Math.min(inSecret[s], inGuess[s]);
    }
    return { hit: hit, near: shared - hit };
  }

  function hcrSymbolError(symbol, mode) {
    var spec = HCR_MODES[mode];
    return symbol + ' is not allowed: ' + spec.name + ' keys use ' + spec.range;
  }

  // Why symbol cannot be typed after input in a mode, or '' when it can.
  function hcrTypeError(input, symbol, mode) {
    var spec = HCR_MODES[mode];
    if (input.length >= spec.length) {
      return 'The key has ' + spec.length + ' symbols: press Enter to crack ' + input + ' or Backspace';
    }
    if (spec.symbols.indexOf(symbol) === -1) {
      return hcrSymbolError(symbol, mode);
    }
    if (spec.distinct && input.indexOf(symbol) !== -1) {
      return symbol + ' is already in ' + input + ': ' + spec.name + ' keys use ' + spec.length + ' different ' + spec.unit;
    }
    return '';
  }

  // Whether text is a key being typed in a mode: allowed symbols, no repeat
  // where repeats are not allowed, at most the key length.
  function hcrIsPartial(text, mode) {
    if (typeof text !== 'string') {
      return false;
    }
    for (var i = 0; i < text.length; i++) {
      if (hcrTypeError(text.slice(0, i), text.charAt(i), mode)) {
        return false;
      }
    }
    return true;
  }

  // Why guess cannot be cracked in a mode, or '' when it is a full key.
  function hcrGuessError(guess, mode) {
    var spec = HCR_MODES[mode];
    var what = spec.length + ' ' + (spec.distinct ? 'different ' : '') + spec.unit + ' (' + spec.range + ')';
    if (guess === '') {
      return 'Type a key first: ' + what;
    }
    for (var i = 0; i < guess.length; i++) {
      var symbol = guess.charAt(i);
      if (spec.symbols.indexOf(symbol) === -1) {
        return hcrSymbolError(symbol, mode);
      }
      if (spec.distinct && guess.indexOf(symbol) !== i) {
        return symbol + ' repeats in ' + guess + ': ' + spec.name + ' keys use ' + what;
      }
    }
    if (guess.length !== spec.length) {
      return guess + ' is too ' + (guess.length < spec.length ? 'short' : 'long') + ': ' + spec.name + ' keys use ' + what;
    }
    return '';
  }

  function hcrIsValidGuess(guess, mode) {
    return typeof guess === 'string' && hcrGuessError(guess, mode) === '';
  }

  // How many keys a mode has: n!/(n-k)! without repeats, n^k with them.
  function hcrKeySpaceSize(mode) {
    var spec = HCR_MODES[mode];
    var size = spec.symbols.length;
    var count = 1;
    for (var i = 0; i < spec.length; i++) {
      count *= spec.distinct ? size - i : size;
    }
    return count;
  }

  // ── The key space (no DOM) ────────────────────────────────────────────────

  // Every key of spec ({ symbols, length, distinct }) whose score against
  // each history entry ({ guess, hit, near }) is that entry's feedback, in
  // symbol order, found by a depth-first search that drops a prefix as soon
  // as some entry's hit or shared-symbol count can no longer come out right.
  // It returns null when it would take more than `budget` steps (symbols
  // tried), so a large key space is never scanned.
  function hcrSearchCodes(spec, history, budget) {
    var size = spec.symbols.length;
    var length = spec.length;
    var entries = history.map(function (entry) {
      var at = [];
      var counts = hcrZeros(size);
      for (var i = 0; i < length; i++) {
        at.push(spec.symbols.indexOf(entry.guess.charAt(i)));
        counts[at[i]]++;
      }
      return { at: at, counts: counts, hit: entry.hit, shared: entry.hit + entry.near, hits: 0, common: 0 };
    });
    var used = hcrZeros(size);
    var code = [];
    var found = [];
    var steps = 0;

    // Whether symbol s at pos can still meet every entry, with `left`
    // positions after it.
    function fits(s, pos, left) {
      for (var j = 0; j < entries.length; j++) {
        var e = entries[j];
        var hits = e.hits + (e.at[pos] === s ? 1 : 0);
        var common = e.common + (used[s] < e.counts[s] ? 1 : 0);
        if (hits > e.hit || common > e.shared || hits + left < e.hit || common + left < e.shared) {
          return false;
        }
      }
      return true;
    }

    // Puts symbol s at pos (sign 1) or takes it back (sign -1).
    function step(s, pos, sign) {
      if (sign < 0) {
        used[s]--;
      }
      for (var j = 0; j < entries.length; j++) {
        var e = entries[j];
        e.hits += sign * (e.at[pos] === s ? 1 : 0);
        e.common += sign * (used[s] < e.counts[s] ? 1 : 0);
      }
      if (sign > 0) {
        used[s]++;
      }
    }

    // Fills positions pos.. ; false when the budget ran out.
    function fill(pos) {
      if (pos === length) {
        found.push(code.join(''));
        return true;
      }
      for (var s = 0; s < size; s++) {
        if (spec.distinct && used[s] > 0) {
          continue;
        }
        steps++;
        if (steps > budget) {
          return false;
        }
        if (!fits(s, pos, length - pos - 1)) {
          continue;
        }
        step(s, pos, 1);
        code[pos] = spec.symbols.charAt(s);
        var finished = fill(pos + 1);
        step(s, pos, -1);
        if (!finished) {
          return false;
        }
      }
      return true;
    }

    return fill(0) ? found : null;
  }

  var hcrCodeCache = {};

  // Every key of Easy (5,040) or Normal (43,680), built once; null for Hard,
  // whose million keys are never listed.
  function hcrAllCodes(mode) {
    var spec = HCR_MODES[mode];
    if (!spec.distinct) {
      return null;
    }
    if (!hcrHasOwn(hcrCodeCache, mode)) {
      hcrCodeCache[mode] = hcrSearchCodes(spec, [], Infinity);
    }
    return hcrCodeCache[mode];
  }

  // The codes whose score against every history entry is its feedback.
  function hcrFilterCandidates(codes, history) {
    return codes.filter(function (code) {
      return history.every(function (entry) {
        var score = hcrScore(code, entry.guess);
        return score.hit === entry.hit && score.near === entry.near;
      });
    });
  }

  // The attempts with their feedback: [{ guess, hit, near }].
  function hcrHistory(secret, guesses) {
    return guesses.map(function (guess) {
      var score = hcrScore(secret, guess);
      return { guess: guess, hit: score.hit, near: score.near };
    });
  }

  // The keys still possible after the last entry of history, given list,
  // the keys possible before it (null when those were not counted).
  function hcrNextKeys(mode, list, history, budget) {
    if (list) {
      return hcrFilterCandidates(list, history.slice(-1));
    }
    return hcrSearchCodes(HCR_MODES[mode], history, budget);
  }

  // The key space before the first attempt and after each one:
  // { counts: [n0, n1, ...] (null where not counted), list: the keys still
  // possible after the last attempt, or null }.  Easy and Normal filter
  // their full list attempt by attempt.  Hard searches from the last attempt
  // back: a shorter history never takes fewer search steps (every prefix it
  // drops is dropped by the longer one too), so the first search over budget
  // means no earlier one fits either, and a reload runs at most one search
  // that gives up.
  function hcrKeyTrail(mode, history, budget) {
    var list = hcrAllCodes(mode);
    var counts = [hcrKeySpaceSize(mode)];
    var i;
    if (list) {
      for (i = 0; i < history.length; i++) {
        list = hcrFilterCandidates(list, [history[i]]);
        counts.push(list.length);
      }
      return { counts: counts, list: list };
    }
    var after = [];
    for (i = history.length; i > 0; i--) {
      var keys = hcrSearchCodes(HCR_MODES[mode], history.slice(0, i), budget);
      if (!keys) {
        break;
      }
      after[i] = keys;
    }
    for (i = 1; i <= history.length; i++) {
      counts.push(after[i] ? after[i].length : null);
    }
    return { counts: counts, list: after[history.length] || null };
  }

  // 'won' (the last attempt was the key), 'lost' (all attempts used) or
  // 'playing'.
  function hcrOutcome(secret, guesses) {
    if (guesses.length && guesses[guesses.length - 1] === secret) {
      return 'won';
    }
    return guesses.length >= HCR_MAX_ATTEMPTS ? 'lost' : 'playing';
  }

  // ── Terminal text (no DOM) ────────────────────────────────────────────────

  function hcrPad2(number) {
    return number < 10 ? '0' + number : String(number);
  }

  // The line printed before the first attempt.
  function hcrHeadText(mode) {
    var count = hcrKeySpaceSize(mode);
    return '$ keyspace --mode ' + mode + ' -> ' + hcrFormatCount(count) + ' keys · ' +
      hcrFormatBits(hcrBits(count)) + ' bits';
  }

  // '#03 $ crack 3A7F -> 2 HIT 1 NEAR' for attempt number n (1-based).
  function hcrAttemptText(n, entry) {
    return '#' + hcrPad2(n) + ' $ crack ' + entry.guess + ' -> ' + entry.hit + ' HIT ' + entry.near + ' NEAR';
  }

  // The key-space line under an attempt: count keys left after it, before
  // the count before it (either null when not counted).
  function hcrKeysText(count, before) {
    if (count === null) {
      return '  └ keys left: too many to count live (over ' + hcrFormatCount(HCR_SEARCH_BUDGET) + ' search steps)';
    }
    var text = '  └ ' + hcrPlural(count, 'key') + ' left · ' +
      hcrFormatBits(hcrBits(count)) + ' bits';
    if (before !== null) {
      text += ' (-' + hcrFormatBits(hcrBits(before) - hcrBits(count)) + ')';
    }
    return text;
  }

  function hcrResultText(secret, guesses) {
    if (hcrOutcome(secret, guesses) === 'won') {
      return 'ACCESS GRANTED · key ' + secret + ' cracked in ' + guesses.length + '/' + HCR_MAX_ATTEMPTS;
    }
    return 'ACCESS DENIED · the key was ' + secret;
  }

  // What the player should do now, or how the game ended.
  function hcrStatusText(state) {
    var spec = HCR_MODES[state.mode];
    var outcome = hcrOutcome(state.secret, state.guesses);
    if (outcome === 'won') {
      return 'Cracked ' + state.secret + ' in ' + state.guesses.length + ' of ' + HCR_MAX_ATTEMPTS +
        ' attempts. Press New Game or Enter for the next key.';
    }
    if (outcome === 'lost') {
      return 'Locked out: the key was ' + state.secret + '. Press New Game or Enter for a new key.';
    }
    return 'Attempt ' + (state.guesses.length + 1) + ' of ' + HCR_MAX_ATTEMPTS + ' · type ' + spec.length + ' ' +
      (spec.distinct ? 'different ' : '') + spec.unit + ' (' + spec.range + ')' +
      (spec.distinct ? '' : ', repeats allowed');
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function hcrParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return undefined;
    }
  }

  // A saved game (JSON text) as a clean state, field by field, or null when
  // the text is no save at all.  An unknown mode falls back to Easy; a key
  // that does not fit the mode leaves secret '' (the game starts a new key in
  // that mode); the attempts keep their valid start (full keys of the mode,
  // none repeated, at most 10, none after the winning one); the key being
  // typed is kept only while the game is on and it fits the mode.
  function hcrParseState(text) {
    var data = hcrParseJson(text);
    if (!hcrIsObject(data)) {
      return null;
    }
    var mode = hcrIsMode(data.mode) ? data.mode : 'easy';
    var state = { mode: mode, secret: '', guesses: [], input: '' };
    if (!hcrIsValidGuess(data.secret, mode)) {
      return state;
    }
    state.secret = data.secret;
    var guesses = Array.isArray(data.guesses) ? data.guesses : [];
    for (var i = 0; i < guesses.length && hcrOutcome(state.secret, state.guesses) === 'playing'; i++) {
      if (!hcrIsValidGuess(guesses[i], mode) || state.guesses.indexOf(guesses[i]) !== -1) {
        break;
      }
      state.guesses.push(guesses[i]);
    }
    if (hcrOutcome(state.secret, state.guesses) === 'playing' && hcrIsPartial(data.input, mode)) {
      state.input = data.input;
    }
    return state;
  }

  function hcrSerializeState(state) {
    return JSON.stringify({
      mode: state.mode,
      secret: state.secret,
      guesses: state.guesses.slice(),
      input: state.input
    });
  }

  function hcrFreshRecord() {
    return { wins: 0, losses: 0, streak: 0, best: 0 };
  }

  function hcrFreshStats() {
    var stats = {};
    HCR_MODE_KEYS.forEach(function (mode) {
      stats[mode] = hcrFreshRecord();
    });
    return stats;
  }

  function hcrCount(value) {
    return typeof value === 'number' && value >= 0 && value <= 1e9 && Math.floor(value) === value ? value : 0;
  }

  // The stats (JSON text) per mode, field by field: anything but a whole
  // number from 0 counts as 0, and the best streak is never below the
  // current one.
  function hcrParseStats(text) {
    var data = hcrParseJson(text);
    var stats = hcrFreshStats();
    HCR_MODE_KEYS.forEach(function (mode) {
      var raw = hcrIsObject(data) && hcrIsObject(data[mode]) ? data[mode] : {};
      var record = stats[mode];
      record.wins = hcrCount(raw.wins);
      record.losses = hcrCount(raw.losses);
      record.streak = hcrCount(raw.streak);
      record.best = Math.max(hcrCount(raw.best), record.streak);
    });
    return stats;
  }

  // Adds a won or lost game of a mode to stats (changed in place, returned).
  function hcrRecordResult(stats, mode, won) {
    var record = stats[mode];
    if (won) {
      record.wins++;
      record.streak++;
      record.best = Math.max(record.best, record.streak);
    } else {
      record.losses++;
      record.streak = 0;
    }
    return stats;
  }

  // The game's key name for a keydown: '0'-'9', 'A'-'F', 'BACK', 'ENTER',
  // or '' for a key the game does not play.  The key value counts first (any
  // case); a single non-Latin letter falls back to the physical A-F keys.
  function hcrKeyName(event) {
    var key = event.key;
    if (typeof key !== 'string') {
      return '';
    }
    if (/^[0-9a-f]$/i.test(key)) {
      return key.toUpperCase();
    }
    if (key === 'Backspace') {
      return 'BACK';
    }
    if (key === 'Enter') {
      return 'ENTER';
    }
    var physical = /^Key([A-F])$/.exec(String(event.code));
    return key.length === 1 && key.charCodeAt(0) > 127 && physical ? physical[1] : '';
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // Shows once per page which storage problem stops the saves.
  function hcrStorageProblem(error, key) {
    if (hcrRuntime.storageWarned) {
      return;
    }
    hcrRuntime.storageWarned = true;
    var warning = hcrRuntime.els.warning;
    warning.textContent = /quota/i.test(String(error.name)) ?
      'Storage is full: ' + key + ' was not saved, so progress will not survive a reload' :
      'Storage is blocked: progress will not be saved';
    warning.classList.add('hcr-visible');
  }

  function hcrStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      hcrStorageProblem(error, key);
      return null;
    }
  }

  // Whether the value was written.
  function hcrStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      hcrStorageProblem(error, key);
      return false;
    }
  }

  function hcrSave() {
    hcrStorageSet(HCR_STATE_KEY, hcrSerializeState(hcrState));
  }

  // Adds the finished game to the stats as stored now (another tab may have
  // added games since), or to the stats on screen when storage has none or
  // the last write failed (full storage still holds older stats).
  function hcrRecordGame(won) {
    var text = hcrRuntime.statsSaved ? hcrStorageGet(HCR_STATS_KEY) : null;
    var stats = text === null ? hcrRuntime.stats : hcrParseStats(text);
    hcrRuntime.stats = hcrRecordResult(stats, hcrState.mode, won);
    hcrRuntime.statsSaved = hcrStorageSet(HCR_STATS_KEY, JSON.stringify(hcrRuntime.stats));
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function hcrSpan(className, text) {
    var span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  }

  // A log line: classes is a list of extra class names ('' entries are
  // skipped), parts its text and spans in order.
  function hcrLine(classes, parts) {
    var line = document.createElement('div');
    line.className = ['hcr-line'].concat(classes).filter(Boolean).join(' ');
    parts.forEach(function (part) {
      line.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
    });
    return line;
  }

  // The attempt line in coloured pieces; its text is hcrAttemptText.
  function hcrAttemptLine(n, entry, fresh) {
    return hcrLine([fresh], [
      hcrSpan('hcr-num', '#' + hcrPad2(n)),
      ' ',
      hcrSpan('hcr-cmd', '$ crack'),
      ' ',
      hcrSpan('hcr-guess', entry.guess),
      ' -> ',
      hcrSpan('hcr-hit', entry.hit + ' HIT'),
      ' ',
      hcrSpan('hcr-near', entry.near + ' NEAR')
    ]);
  }

  // Adds attempt n (1-based) and the key-space line under it to the log;
  // fresh is 'hcr-line--new' for lines that type in, else ''.
  function hcrAppendAttempt(log, n, entry, fresh) {
    var counts = hcrRuntime.counts;
    log.appendChild(hcrAttemptLine(n, entry, fresh));
    log.appendChild(hcrLine(['hcr-line--keys', fresh], [hcrKeysText(counts[n], counts[n - 1])]));
  }

  // Ends the log with the result line (which always types in) once the game
  // is over, and scrolls to the bottom.
  function hcrAppendResult(log) {
    var outcome = hcrOutcome(hcrState.secret, hcrState.guesses);
    if (outcome !== 'playing') {
      log.appendChild(hcrLine(['hcr-line--' + outcome, 'hcr-line--new'], [hcrResultText(hcrState.secret, hcrState.guesses)]));
    }
    log.scrollTop = log.scrollHeight;
  }

  // The whole log, for a new or restored game: the head line, every attempt
  // (none typing in) and the result.
  function hcrRenderLog() {
    var log = hcrRuntime.els.log;
    log.innerHTML = '';
    log.appendChild(hcrLine(['hcr-line--head'], [hcrHeadText(hcrState.mode)]));
    hcrHistory(hcrState.secret, hcrState.guesses).forEach(function (entry, i) {
      hcrAppendAttempt(log, i + 1, entry, '');
    });
    hcrAppendResult(log);
  }

  // After an attempt only its lines (and the result) are added, so the live
  // log announces just the new feedback, not the whole history again; the
  // lines that typed in before stop animating.
  function hcrLogAttempt() {
    var log = hcrRuntime.els.log;
    var history = hcrHistory(hcrState.secret, hcrState.guesses);
    for (var i = 0; i < log.children.length; i++) {
      log.children[i].classList.remove('hcr-line--new');
    }
    hcrAppendAttempt(log, history.length, history[history.length - 1], 'hcr-line--new');
    hcrAppendResult(log);
  }

  // '$ crack 3A__' with a cursor on the next slot; a finished game closes the
  // prompt.
  function hcrRenderPrompt() {
    var prompt = hcrRuntime.els.prompt;
    var spec = HCR_MODES[hcrState.mode];
    var input = hcrState.input;
    prompt.innerHTML = '';
    if (hcrOutcome(hcrState.secret, hcrState.guesses) !== 'playing') {
      prompt.appendChild(hcrSpan('hcr-cmd', '$ connection closed'));
      prompt.setAttribute('aria-label', 'Connection closed');
      return;
    }
    prompt.appendChild(hcrSpan('hcr-cmd', '$ crack '));
    for (var i = 0; i < spec.length; i++) {
      var filled = i < input.length;
      var slot = 'hcr-slot' + (filled ? ' hcr-slot--filled' : '') + (i === input.length ? ' hcr-slot--cursor' : '');
      prompt.appendChild(hcrSpan(slot, filled ? input.charAt(i) : '_'));
    }
    prompt.setAttribute('aria-label', 'Key: ' + (input || 'empty') + ', ' + input.length + ' of ' + spec.length + ' symbols');
  }

  // The number of keys at the last attempt whose key space was counted
  // (Easy, Normal and the start of Hard always are).
  function hcrLastCounted() {
    var counts = hcrRuntime.counts;
    var i = counts.length - 1;
    while (counts[i] === null) {
      i--;
    }
    return counts[i];
  }

  function hcrRenderStats() {
    var els = hcrRuntime.els;
    var record = hcrRuntime.stats[hcrState.mode];
    var counts = hcrRuntime.counts;
    var count = counts[counts.length - 1];
    var start = hcrBits(counts[0]);
    var cracked = Math.round(100 * (start - hcrBits(hcrLastCounted())) / start);
    els.attempts.textContent = hcrState.guesses.length + '/' + HCR_MAX_ATTEMPTS;
    els.keys.textContent = count === null ? 'n/a' : hcrFormatCount(count);
    els.bits.textContent = count === null ? 'n/a' : hcrFormatBits(hcrBits(count));
    els.meter.classList.toggle('hcr-meter--unknown', count === null);
    els.streak.textContent = String(record.streak);
    els.best.textContent = String(record.best);
    els.record.textContent = record.wins + ' / ' + record.losses;
    els.meterFill.style.width = cracked + '%';
    els.meter.setAttribute('aria-valuenow', String(cracked));
  }

  function hcrRenderModes() {
    HCR_MODE_KEYS.forEach(function (mode) {
      var button = hcrRuntime.els.modes[mode];
      var active = mode === hcrState.mode;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.classList.toggle('hcr-mode--active', active);
      button.classList.toggle('hcr-armed', hcrRuntime.confirm === mode);
    });
    var newGame = hcrRuntime.els.newGame;
    var armed = hcrRuntime.confirm === 'new';
    newGame.textContent = armed ? HCR_GIVE_UP_LABEL : HCR_NEW_GAME_LABEL;
    newGame.setAttribute('aria-label', armed ? 'Give up this key: press again to confirm' : 'Start a new game with a new key');
    newGame.classList.toggle('hcr-armed', armed);
  }

  // Symbols that cannot be typed now are disabled; Backspace and Clear need
  // something typed; CRACK lights up when the key is complete.
  function hcrRenderKeypad() {
    var keys = hcrRuntime.keys;
    var playing = hcrOutcome(hcrState.secret, hcrState.guesses) === 'playing';
    var input = hcrState.input;
    HCR_HEX.split('').forEach(function (symbol) {
      keys[symbol].disabled = !playing || hcrTypeError(input, symbol, hcrState.mode) !== '';
    });
    keys.BACK.disabled = !playing || input === '';
    keys.CLEAR.disabled = !playing || input === '';
    keys.ENTER.disabled = !playing;
    keys.ENTER.classList.toggle('hcr-ready', playing && input.length === HCR_MODES[hcrState.mode].length);
  }

  function hcrRenderStatus() {
    var els = hcrRuntime.els;
    var outcome = hcrOutcome(hcrState.secret, hcrState.guesses);
    els.status.textContent = hcrStatusText(hcrState);
    els.terminal.classList.toggle('hcr-granted', outcome === 'won');
    els.terminal.classList.toggle('hcr-denied', outcome === 'lost');
  }

  function hcrRenderInput() {
    hcrRenderPrompt();
    hcrRenderKeypad();
  }

  // Everything but the log.
  function hcrRenderPanels() {
    hcrRenderModes();
    hcrRenderStats();
    hcrRenderInput();
    hcrRenderStatus();
  }

  function hcrRender() {
    hcrRenderLog();
    hcrRenderPanels();
  }

  // A toast replaces the one showing, keeps its full time, and ends any
  // give-up confirmation that was pending.
  function hcrShowToast(message, ms) {
    var toast = hcrRuntime.els.toast;
    clearTimeout(hcrRuntime.toastTimer);
    hcrRuntime.confirm = null;
    toast.textContent = message;
    toast.classList.add('hcr-show');
    hcrRuntime.toastTimer = setTimeout(hcrHideToast, ms || HCR_TOAST_MS);
    hcrRenderModes();
  }

  function hcrHideToast() {
    clearTimeout(hcrRuntime.toastTimer);
    hcrRuntime.toastTimer = null;
    hcrRuntime.confirm = null;
    hcrRuntime.els.toast.classList.remove('hcr-show');
    hcrRenderModes();
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  function hcrUpdateTrail() {
    var trail = hcrKeyTrail(hcrState.mode, hcrHistory(hcrState.secret, hcrState.guesses), HCR_SEARCH_BUDGET);
    hcrRuntime.counts = trail.counts;
    hcrRuntime.list = trail.list;
  }

  // A new key in a mode, shown and saved.
  function hcrNewGame(mode) {
    hcrState.mode = mode;
    hcrState.secret = hcrMakeSecret(mode, Math.random);
    hcrState.guesses = [];
    hcrState.input = '';
    hcrUpdateTrail();
    hcrRender();
    hcrSave();
  }

  function hcrPlaying() {
    return hcrOutcome(hcrState.secret, hcrState.guesses) === 'playing';
  }

  // Whether leaving the game now gives it up: it is on and has attempts.
  function hcrAtStake() {
    return hcrPlaying() && hcrState.guesses.length > 0;
  }

  // New Game ('new') or another mode: at once when nothing is at stake;
  // otherwise the first press asks, and a second press of the same control
  // within 4 s gives the game up as a loss.
  function hcrRequest(action) {
    var mode = action === 'new' ? hcrState.mode : action;
    if (!hcrAtStake()) {
      hcrHideToast();
      hcrNewGame(mode);
      return;
    }
    if (hcrRuntime.confirm !== action) {
      var control = action === 'new' ? 'New Game' : HCR_MODES[action].name;
      hcrShowToast('Give up this ' + HCR_MODES[hcrState.mode].name + ' key after ' + hcrState.guesses.length + ' of ' +
        HCR_MAX_ATTEMPTS + ' attempts? It counts as a loss: press ' + control + ' again', HCR_CONFIRM_MS);
      hcrRuntime.confirm = action;
      hcrRenderModes();
      return;
    }
    var gaveUp = hcrState.secret;
    var name = HCR_MODES[hcrState.mode].name;
    hcrRecordGame(false);
    hcrNewGame(mode);
    hcrShowToast('Gave up: the ' + name + ' key was ' + gaveUp + ' · counted as a loss');
  }

  function hcrSubmit() {
    var guess = hcrState.input;
    var error = hcrGuessError(guess, hcrState.mode);
    var tried = hcrState.guesses.indexOf(guess);
    if (!error && tried !== -1) {
      error = guess + ' was already tried in attempt #' + (tried + 1) + ': it gives no new information';
    }
    if (error) {
      hcrShowToast(error);
      return;
    }
    hcrState.guesses.push(guess);
    hcrState.input = '';
    var history = hcrHistory(hcrState.secret, hcrState.guesses);
    hcrRuntime.list = hcrNextKeys(hcrState.mode, hcrRuntime.list, history, HCR_SEARCH_BUDGET);
    hcrRuntime.counts.push(hcrRuntime.list ? hcrRuntime.list.length : null);
    var outcome = hcrOutcome(hcrState.secret, hcrState.guesses);
    if (outcome !== 'playing') {
      hcrRecordGame(outcome === 'won');
    }
    hcrSave();
    hcrLogAttempt();
    hcrRenderPanels();
    if (outcome === 'won') {
      hcrShowToast('ACCESS GRANTED: ' + guess + ' cracked in ' + hcrPlural(hcrState.guesses.length, 'attempt'));
    } else if (outcome === 'lost') {
      hcrShowToast('ACCESS DENIED: the key was ' + hcrState.secret);
    }
  }

  // One key of a game in progress, from the keypad or the keyboard: a
  // symbol, 'BACK', 'CLEAR' or 'ENTER' (a finished game disables the keypad,
  // and its keydowns never come here).  A symbol that cannot be typed says
  // why.
  function hcrPress(key) {
    if (key === 'ENTER') {
      hcrSubmit();
      return;
    }
    var input = hcrState.input;
    var next;
    if (key === 'BACK') {
      next = input.slice(0, -1);
    } else if (key === 'CLEAR') {
      next = '';
    } else {
      var error = hcrTypeError(input, key, hcrState.mode);
      if (error) {
        hcrShowToast(error);
        return;
      }
      next = input + key;
    }
    if (next === input) {
      return;
    }
    hcrState.input = next;
    hcrRenderInput();
    hcrSave();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  function hcrIsEditable(target) {
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  // Whether a key pressed on target is the game's: the document, the page
  // body or a host element that holds the game (a theme's focusable content
  // area), or one of the game's own controls.  Fields anywhere, and links and
  // buttons of the host page, keep their keys.
  function hcrOwnsKeyTarget(target) {
    var wrapper = hcrRuntime.els.wrapper;
    if (target === document) {
      return true;
    }
    if (hcrIsEditable(target)) {
      return false;
    }
    return target.contains(wrapper) || wrapper.contains(target);
  }

  // Physical keys.  A focused game button keeps Enter (the player reached it
  // with Tab); a held Enter cracks once; in a finished game Enter starts the
  // next key and the other keys are left alone.
  function hcrOnKeydown(event) {
    var key = hcrKeyName(event);
    if (!key || event.ctrlKey || event.metaKey || event.altKey || event.isComposing ||
        event.defaultPrevented || !hcrOwnsKeyTarget(event.target)) {
      return;
    }
    if (key === 'ENTER' && event.target.tagName === 'BUTTON') {
      return;
    }
    if (!hcrPlaying() && key !== 'ENTER') {
      return;
    }
    event.preventDefault();
    if (key === 'ENTER' && event.repeat) {
      return;
    }
    if (hcrPlaying()) {
      hcrPress(key);
    } else {
      hcrRequest('new');
    }
  }

  // A mouse click or a tap leaves the focus on a button, and the browser
  // would click it again on the next Enter; keyboard activation (detail 0)
  // keeps it.
  function hcrReleasePointerFocus(button, event) {
    if (event.detail > 0) {
      button.blur();
    }
  }

  function hcrOnKeypadClick(event) {
    var button = event.target.closest('[data-hcr-key]');
    if (!button) {
      return;
    }
    hcrReleasePointerFocus(button, event);
    hcrPress(button.getAttribute('data-hcr-key'));
  }

  function hcrKeyButton(label, key, ariaLabel, className) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.setAttribute('data-hcr-key', key);
    button.setAttribute('aria-label', ariaLabel);
    hcrRuntime.keys[key] = button;
    return button;
  }

  // The 4x4 hex keypad in reading order, then Clear, Backspace and CRACK.
  function hcrBuildKeypad() {
    var keypad = hcrRuntime.els.keypad;
    HCR_HEX.split('').forEach(function (symbol) {
      keypad.appendChild(hcrKeyButton(symbol, symbol, 'Symbol ' + symbol, 'hcr-key'));
    });
    keypad.appendChild(hcrKeyButton('CLR', 'CLEAR', 'Clear the key', 'hcr-key hcr-key--action'));
    keypad.appendChild(hcrKeyButton('⌫', 'BACK', 'Delete the last symbol', 'hcr-key hcr-key--action'));
    keypad.appendChild(hcrKeyButton('CRACK', 'ENTER', 'Crack: try this key', 'hcr-key hcr-key--crack'));
  }

  function hcrControlHandler(action) {
    return function (event) {
      hcrReleasePointerFocus(this, event);
      if (action === 'new' || action !== hcrState.mode) {
        hcrRequest(action);
      }
    };
  }

  function hcrBindEvents() {
    var els = hcrRuntime.els;
    els.newGame.addEventListener('click', hcrControlHandler('new'));
    HCR_MODE_KEYS.forEach(function (mode) {
      els.modes[mode].addEventListener('click', hcrControlHandler(mode));
    });
    els.keypad.addEventListener('click', hcrOnKeypadClick);
    document.addEventListener('keydown', hcrOnKeydown);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function hcrFindElements() {
    return {
      wrapper: document.getElementById('hcr-game'),
      newGame: document.getElementById('hcr-new-game'),
      modes: {
        easy: document.getElementById('hcr-mode-easy'),
        normal: document.getElementById('hcr-mode-normal'),
        hard: document.getElementById('hcr-mode-hard')
      },
      attempts: document.getElementById('hcr-attempts'),
      keys: document.getElementById('hcr-keys'),
      bits: document.getElementById('hcr-bits'),
      streak: document.getElementById('hcr-streak'),
      best: document.getElementById('hcr-best'),
      record: document.getElementById('hcr-record'),
      meter: document.getElementById('hcr-meter'),
      meterFill: document.getElementById('hcr-meter-fill'),
      terminal: document.getElementById('hcr-terminal'),
      log: document.getElementById('hcr-log'),
      prompt: document.getElementById('hcr-prompt'),
      status: document.getElementById('hcr-status'),
      warning: document.getElementById('hcr-warning'),
      keypad: document.getElementById('hcr-keypad'),
      toast: document.getElementById('hcr-toast')
    };
  }

  // Finds the page elements, builds the keypad, binds the controls once and
  // restores the saved game, or starts a new key (in the saved mode when
  // only the mode survived).
  function hcrInit() {
    if (hcrRuntime.els) {
      return;
    }
    hcrRuntime.els = hcrFindElements();
    hcrBuildKeypad();
    hcrBindEvents();
    hcrRuntime.stats = hcrParseStats(hcrStorageGet(HCR_STATS_KEY));
    var saved = hcrParseState(hcrStorageGet(HCR_STATE_KEY));
    if (saved && saved.secret) {
      hcrState.mode = saved.mode;
      hcrState.secret = saved.secret;
      hcrState.guesses = saved.guesses;
      hcrState.input = saved.input;
      hcrUpdateTrail();
      hcrRender();
    } else {
      hcrNewGame(saved ? saved.mode : 'easy');
    }
  }

  // Node (tests): export only, no init.  Browser: init once the markup is
  // there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      hcrModes: HCR_MODES,
      hcrMaxAttempts: HCR_MAX_ATTEMPTS,
      hcrSearchBudget: HCR_SEARCH_BUDGET,
      hcrState: hcrState,
      hcrInit: hcrInit,
      hcrMakeSecret: hcrMakeSecret,
      hcrScore: hcrScore,
      hcrTypeError: hcrTypeError,
      hcrIsPartial: hcrIsPartial,
      hcrGuessError: hcrGuessError,
      hcrIsValidGuess: hcrIsValidGuess,
      hcrKeySpaceSize: hcrKeySpaceSize,
      hcrSearchCodes: hcrSearchCodes,
      hcrAllCodes: hcrAllCodes,
      hcrFilterCandidates: hcrFilterCandidates,
      hcrHistory: hcrHistory,
      hcrNextKeys: hcrNextKeys,
      hcrKeyTrail: hcrKeyTrail,
      hcrOutcome: hcrOutcome,
      hcrBits: hcrBits,
      hcrFormatCount: hcrFormatCount,
      hcrFormatBits: hcrFormatBits,
      hcrHeadText: hcrHeadText,
      hcrAttemptText: hcrAttemptText,
      hcrKeysText: hcrKeysText,
      hcrResultText: hcrResultText,
      hcrStatusText: hcrStatusText,
      hcrParseState: hcrParseState,
      hcrSerializeState: hcrSerializeState,
      hcrFreshStats: hcrFreshStats,
      hcrParseStats: hcrParseStats,
      hcrRecordResult: hcrRecordResult,
      hcrKeyName: hcrKeyName
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hcrInit);
  } else {
    hcrInit();
  }
})();
