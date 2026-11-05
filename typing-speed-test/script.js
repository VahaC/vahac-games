// Typing Speed Test — script.js
// Prefix: tst-
// Dependencies: none.
(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var STORAGE_KEY = 'tst-state';
  var DEFAULT_DIFFICULTY = 'medium';
  var ROUND_SECONDS = 60;
  var ROUND_MS = ROUND_SECONDS * 1000;
  var TICK_MS = 1000;
  // WPM is never worked out over less than one second.
  var MIN_ELAPSED_MS = 1000;
  var CHARS_PER_WORD = 5;
  var TOAST_MS = 2000;
  var FINISH_MESSAGE = 'Session completed';

  var CLASS_HIDDEN = 'tst-hidden';
  var CLASS_CORRECT = 'tst-char-correct';
  var CLASS_WRONG = 'tst-char-wrong';
  var CLASS_CURRENT = 'tst-char-current';

  // Element ids by role.  They are looked up in tstInit, not while the script
  // loads, so the game also starts when the script runs before the markup.
  var ELEMENT_IDS = {
    difficulty: 'tst-difficulty',
    newGame: 'tst-new-game',
    restart: 'tst-restart-game',
    textDisplay: 'tst-text-display',
    input: 'tst-input',
    wpm: 'tst-wpm',
    accuracy: 'tst-accuracy',
    timer: 'tst-timer',
    best: 'tst-best',
    result: 'tst-result',
    resultText: 'tst-result-text',
    toast: 'tst-toast'
  };

  // The sentences of each difficulty.  The display writes every character
  // into innerHTML as it is, so they must not contain < > & or ".
  var tstTexts = {
    easy: [
      'Typing fast requires rhythm and consistency more than raw speed.',
      'Cyberpunk interfaces make keyboard training feel futuristic and immersive.'
    ],
    medium: [
      'Developers often improve productivity dramatically after mastering touch typing and keyboard shortcuts.',
      'Typing accuracy matters because excessive mistakes reduce effective words per minute performance.'
    ],
    hard: [
      'The futuristic terminal glowed intensely while holographic dashboards streamed complex diagnostics across the neon interface.',
      'Professional programmers frequently rely on mechanical keyboards, rapid command execution, and efficient typing habits.'
    ]
  };

  // ── State ─────────────────────────────────────────────────────────────────

  // status: 'idle' until the first keystroke, 'running' while the clock runs,
  // 'finished' once the text is done or the time is up (input is ignored then).
  var tstState = {
    status: 'idle',
    secondsLeft: ROUND_SECONDS,
    startedAt: 0,
    text: '',
    difficulty: DEFAULT_DIFFICULTY,
    bestWpm: 0,
    intervalId: null,
    toastTimerId: null
  };

  // The page elements by role (see ELEMENT_IDS), filled in by tstInit.
  var tstElements = {};

  // ── Game logic (no DOM) ───────────────────────────────────────────────────

  function tstIsDifficulty(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(tstTexts, value);
  }

  function tstPickText(difficulty) {
    var pool = tstTexts[difficulty];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // The class of each character of text once typed has been entered: correct
  // or wrong where typed reaches, current for the next one, '' after that.
  function tstCharClasses(text, typed) {
    var classes = [];
    var i;
    for (i = 0; i < text.length; i++) {
      if (i < typed.length) {
        classes.push(typed.charAt(i) === text.charAt(i) ? CLASS_CORRECT : CLASS_WRONG);
      } else {
        classes.push(i === typed.length ? CLASS_CURRENT : '');
      }
    }
    return classes;
  }

  // Typed characters that match the text at the same position.
  function tstCountCorrect(text, typed) {
    var correct = 0;
    var i;
    for (i = 0; i < typed.length; i++) {
      if (typed.charAt(i) === text.charAt(i)) {
        correct += 1;
      }
    }
    return correct;
  }

  function tstAccuracy(correct, typedLength) {
    return typedLength ? Math.round((correct / typedLength) * 100) : 100;
  }

  // Correct characters / 5 per minute.
  function tstWpm(correct, elapsedMs) {
    var minutes = Math.max(elapsedMs, MIN_ELAPSED_MS) / 60000;
    return Math.round(correct / CHARS_PER_WORD / minutes);
  }

  function tstComputeStats(text, typed, elapsedMs) {
    var correct = tstCountCorrect(text, typed);
    return { wpm: tstWpm(correct, elapsedMs), accuracy: tstAccuracy(correct, typed.length) };
  }

  // A saved best WPM: a finite number >= 0 (a number stored as text counts),
  // without its fraction; anything else is 0.
  function tstCleanBest(value) {
    var number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof number === 'number' && isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  }

  // The stored 'tst-state' text as { bestWpm, difficulty }.  Never throws:
  // missing or corrupt JSON, another shape and bad values fall back to 0 and
  // medium, field by field.
  function tstParseSave(raw) {
    var save = { bestWpm: 0, difficulty: DEFAULT_DIFFICULTY };
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return save;
    }
    if (data && typeof data === 'object') {
      save.bestWpm = tstCleanBest(data.bestWpm);
      if (tstIsDifficulty(data.difficulty)) {
        save.difficulty = data.difficulty;
      }
    }
    return save;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  function tstReadSave() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      // Site data blocked: play with the defaults.
    }
    return tstParseSave(raw);
  }

  function tstWriteSave() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        bestWpm: tstState.bestWpm,
        difficulty: tstState.difficulty
      }));
    } catch (e) {
      // Storage blocked or full: keep playing without saving.
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function tstRenderText(typed) {
    var classes = tstCharClasses(tstState.text, typed);
    var html = '';
    var i;
    for (i = 0; i < classes.length; i++) {
      html += '<span class="' + classes[i] + '">' + tstState.text.charAt(i) + '</span>';
    }
    tstElements.textDisplay.innerHTML = html;
  }

  function tstRenderStats(stats) {
    tstElements.wpm.textContent = String(stats.wpm);
    tstElements.accuracy.textContent = stats.accuracy + '%';
  }

  function tstRenderTimer() {
    tstElements.timer.textContent = String(tstState.secondsLeft);
  }

  function tstRenderBest() {
    tstElements.best.textContent = String(tstState.bestWpm);
  }

  function tstShowResult(stats) {
    tstElements.resultText.textContent =
      'Final WPM: ' + stats.wpm + ' | Accuracy: ' + stats.accuracy + '%';
    tstElements.result.classList.remove(CLASS_HIDDEN);
  }

  function tstShowToast(message) {
    clearTimeout(tstState.toastTimerId);
    tstElements.toast.textContent = message;
    tstElements.toast.classList.remove(CLASS_HIDDEN);
    tstState.toastTimerId = setTimeout(tstHideToast, TOAST_MS);
  }

  function tstHideToast() {
    clearTimeout(tstState.toastTimerId);
    tstState.toastTimerId = null;
    tstElements.toast.classList.add(CLASS_HIDDEN);
  }

  // ── The round ─────────────────────────────────────────────────────────────

  // Milliseconds since the round's first keystroke, at most the round length.
  function tstElapsedMs() {
    return Math.min(performance.now() - tstState.startedAt, ROUND_MS);
  }

  function tstLiveStats() {
    return tstComputeStats(tstState.text, tstElements.input.value, tstElapsedMs());
  }

  function tstStartRound() {
    var intervalId = setInterval(function () {
      // Only the round's own interval ticks: once it is cleared (or replaced
      // by a later round's) a call that still arrives does nothing.
      if (intervalId === tstState.intervalId) {
        tstTick();
      }
    }, TICK_MS);
    tstState.intervalId = intervalId;
    tstState.status = 'running';
    tstState.startedAt = performance.now();
  }

  function tstStopClock() {
    clearInterval(tstState.intervalId);
    tstState.intervalId = null;
  }

  function tstTick() {
    tstState.secondsLeft -= 1;
    tstRenderTimer();
    if (tstState.secondsLeft <= 0) {
      tstFinish(ROUND_MS);
    } else {
      tstRenderStats(tstLiveStats());
    }
  }

  // Ends the round, scored over elapsedMs: the real time taken for a finished
  // text, the whole minute when the time runs out.  Stops the clock, locks the
  // textarea and keeps the final WPM as the best when it beats it.
  function tstFinish(elapsedMs) {
    var stats = tstComputeStats(tstState.text, tstElements.input.value, elapsedMs);
    tstStopClock();
    tstState.status = 'finished';
    tstElements.input.readOnly = true;
    tstRenderStats(stats);
    if (stats.wpm > tstState.bestWpm) {
      tstState.bestWpm = stats.wpm;
      tstRenderBest();
      tstWriteSave();
    }
    tstShowResult(stats);
    tstShowToast(FINISH_MESSAGE);
  }

  // The selected difficulty, or the current one if the select names no pool.
  function tstSelectedDifficulty() {
    var value = tstElements.difficulty.value;
    return tstIsDifficulty(value) ? value : tstState.difficulty;
  }

  // A fresh round on the selected difficulty (New Game, Restart and a
  // difficulty change): clock stopped at 60, a new random sentence, an empty
  // unlocked textarea, zeroed stats, the result and the toast hidden.
  function tstResetRound() {
    tstStopClock();
    tstHideToast();
    tstState.status = 'idle';
    tstState.secondsLeft = ROUND_SECONDS;
    tstState.difficulty = tstSelectedDifficulty();
    tstState.text = tstPickText(tstState.difficulty);
    tstElements.input.value = '';
    tstElements.input.readOnly = false;
    tstElements.result.classList.add(CLASS_HIDDEN);
    tstRenderTimer();
    tstRenderStats({ wpm: 0, accuracy: 100 });
    tstRenderText('');
    tstWriteSave();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // Every change to the textarea: the first one starts the clock, the exact
  // text finishes the round.  A finished round ignores input until a reset.
  function tstOnInput() {
    var typed = tstElements.input.value;
    if (tstState.status === 'finished') {
      return;
    }
    if (tstState.status === 'idle') {
      tstStartRound();
    }
    tstRenderText(typed);
    if (typed === tstState.text) {
      tstFinish(tstElapsedMs());
    } else {
      tstRenderStats(tstLiveStats());
    }
  }

  // ── Init and start-up ─────────────────────────────────────────────────────

  function tstFindElements() {
    Object.keys(ELEMENT_IDS).forEach(function (role) {
      tstElements[role] = document.getElementById(ELEMENT_IDS[role]);
    });
  }

  function tstBindEvents() {
    tstElements.newGame.addEventListener('click', tstResetRound);
    tstElements.restart.addEventListener('click', tstResetRound);
    tstElements.difficulty.addEventListener('change', tstResetRound);
    tstElements.input.addEventListener('input', tstOnInput);
  }

  function tstInit() {
    var save = tstReadSave();
    tstFindElements();
    tstBindEvents();
    tstState.bestWpm = save.bestWpm;
    tstState.difficulty = save.difficulty;
    tstElements.difficulty.value = save.difficulty;
    tstRenderBest();
    tstResetRound();
  }

  // In a browser start now or on DOMContentLoaded; under Node (tests) only
  // export, without init, listeners or timers.
  if (typeof module === 'undefined' || !module.exports) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tstInit);
    } else {
      tstInit();
    }
  }

  /* Node test export (no effect in browsers) */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      tstTexts: tstTexts,
      tstIsDifficulty: tstIsDifficulty,
      tstPickText: tstPickText,
      tstCharClasses: tstCharClasses,
      tstCountCorrect: tstCountCorrect,
      tstAccuracy: tstAccuracy,
      tstWpm: tstWpm,
      tstComputeStats: tstComputeStats,
      tstParseSave: tstParseSave
    };
  }
})();
