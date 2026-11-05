// Reaction Time Test — script.js
// Prefix: rxt-
// Dependencies: none.
//
// Sections: constants, state, pure game logic (no DOM), persistence,
// rendering, session timer, rounds, input handling, init and start-up.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var RXT_STORAGE_KEY = 'rxt-reaction-state';
  var RXT_DEFAULT_DIFFICULTY = 'normal';

  // Signal delay window per difficulty: [minimum, maximum) in ms.
  var RXT_DELAYS = {
    easy: [2000, 4500],
    normal: [1500, 3500],
    hard: [1000, 2500],
    extreme: [600, 1600]
  };

  var RXT_SESSION_ROUNDS = 10;
  var RXT_TOAST_MS = 2200;

  // Element ids, by the name the script uses for each element.
  var RXT_IDS = {
    board: 'rxt-board',
    boardLabel: 'rxt-board-label',
    boardHint: 'rxt-board-hint',
    currentReaction: 'rxt-current-reaction',
    bestReaction: 'rxt-best-reaction',
    averageReaction: 'rxt-average-reaction',
    attempts: 'rxt-attempts',
    timer: 'rxt-timer',
    difficulty: 'rxt-difficulty',
    newGame: 'rxt-new-game',
    restartGame: 'rxt-restart-game',
    actionTrigger: 'rxt-action-trigger',
    toast: 'rxt-toast',
    overlay: 'rxt-overlay',
    overlayTitle: 'rxt-overlay-title',
    overlayText: 'rxt-overlay-text',
    overlayButton: 'rxt-overlay-button',
    statusPill: 'rxt-status-pill'
  };

  var RXT_BOARD_CLASSES = [
    'rxt-board-idle',
    'rxt-board-waiting',
    'rxt-board-active',
    'rxt-board-failed'
  ];

  // What the board, its hint and the status pill show in each situation.
  // The result view takes the reaction time as its label.
  var RXT_VIEWS = {
    ready: {
      board: 'rxt-board-idle',
      label: 'Press Start',
      hint: 'Wait for the neon signal, then react instantly.',
      pill: 'Ready'
    },
    waiting: {
      board: 'rxt-board-waiting',
      label: 'Wait...',
      hint: 'Do NOT click until the neon signal appears.',
      pill: 'Waiting'
    },
    active: {
      board: 'rxt-board-active',
      label: 'CLICK NOW',
      hint: 'Tap, click, or press Space immediately.',
      pill: 'GO'
    },
    result: {
      board: 'rxt-board-idle',
      label: '',
      hint: 'Excellent reflexes. Start another round.',
      pill: 'Completed'
    },
    failed: {
      board: 'rxt-board-failed',
      label: 'Too Early',
      hint: 'You reacted before the signal appeared.',
      pill: 'Fault'
    }
  };

  var RXT_TEXT = {
    falseStart: 'False start detected',
    newBest: 'New best reaction time!',
    difficulty: 'Difficulty updated',
    sessionComplete: 'Session Complete'
  };

  // A key pressed while one of these has the focus belongs to that element
  // (except Enter on the game's own difficulty select, which starts a round).
  var RXT_OWN_KEY_TAGS = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'];

  // ── State ─────────────────────────────────────────────────────────────────

  // The session.  difficulty, bestReaction, attempts, totalReaction and
  // elapsed (seconds) are saved.  status: 'idle', 'waiting' (signal pending),
  // 'active' (signal shown) or 'complete' (the summary is up).
  var rxtState = {
    status: 'idle',
    difficulty: RXT_DEFAULT_DIFFICULTY,
    currentReaction: 0,
    bestReaction: null,
    attempts: 0,
    totalReaction: 0,
    elapsed: 0
  };

  // Timer handles and timestamps (performance.now() ms), and the save text
  // this tab last read or wrote; never saved.
  var rxtRuntime = {
    signalTimeout: null,
    toastTimeout: null,
    timerFrame: null,
    sessionStart: 0,
    signalTime: 0,
    lastSave: null
  };

  var rxtElements = {};

  // ── Pure game logic ───────────────────────────────────────────────────────

  function rxtIsDifficulty(value) {
    return typeof value === 'string' &&
      Object.prototype.hasOwnProperty.call(RXT_DELAYS, value);
  }

  // A signal delay in ms inside the difficulty's window, for a random number
  // in [0, 1).  An unknown difficulty uses the default window.
  function rxtGetDelay(difficulty, random) {
    var range = RXT_DELAYS[rxtIsDifficulty(difficulty) ? difficulty : RXT_DEFAULT_DIFFICULTY];
    return Math.floor(random * (range[1] - range[0]) + range[0]);
  }

  function rxtAverage(total, attempts) {
    return attempts > 0 ? Math.round(total / attempts) : 0;
  }

  function rxtIsNewBest(best, ms) {
    return best === null || ms < best;
  }

  function rxtFormatMs(ms) {
    return ms === null ? '--' : ms + ' ms';
  }

  // Tenths of a second; a negative or missing time shows as 0.0s.
  function rxtFormatSeconds(seconds) {
    return (seconds > 0 ? seconds : 0).toFixed(1) + 's';
  }

  function rxtElapsedSeconds(start, now) {
    return Math.max(0, (now - start) / 1000);
  }

  function rxtIsSessionComplete(attempts) {
    return attempts >= RXT_SESSION_ROUNDS;
  }

  function rxtSummaryText(state) {
    return 'Average reaction: ' + rxtAverage(state.totalReaction, state.attempts) +
      ' ms | Best: ' + rxtFormatMs(state.bestReaction);
  }

  // Adds a successful reaction of ms to the stats; true when it is a new best.
  function rxtRecordReaction(state, ms) {
    var newBest = rxtIsNewBest(state.bestReaction, ms);
    state.currentReaction = ms;
    state.attempts += 1;
    state.totalReaction += ms;
    if (newBest) {
      state.bestReaction = ms;
    }
    return newBest;
  }

  function rxtIsAmount(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0;
  }

  // A saved session checked field by field, each bad field falling back to
  // its fresh-game value; null when the save is not an object at all.
  function rxtSanitizeSave(saved) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      return null;
    }
    var attempts = rxtIsAmount(saved.attempts) && saved.attempts % 1 === 0 ? saved.attempts : 0;
    return {
      difficulty: rxtIsDifficulty(saved.difficulty) ? saved.difficulty : RXT_DEFAULT_DIFFICULTY,
      bestReaction: rxtIsAmount(saved.bestReaction) ? saved.bestReaction : null,
      attempts: attempts,
      totalReaction: attempts > 0 && rxtIsAmount(saved.totalReaction) ? saved.totalReaction : 0,
      elapsed: rxtIsAmount(saved.elapsed) ? saved.elapsed : 0
    };
  }

  // The saved fields, in the order every version has written them.
  function rxtSaveData(state) {
    return {
      difficulty: state.difficulty,
      bestReaction: state.bestReaction,
      attempts: state.attempts,
      totalReaction: state.totalReaction,
      elapsed: state.elapsed
    };
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  // The cleaned save, or null when there is none, storage is blocked or the
  // JSON is broken.  A broken save is not logged: the game starts fresh, and
  // the host page's console stays clean.
  function rxtReadSave() {
    var raw;
    try {
      raw = localStorage.getItem(RXT_STORAGE_KEY);
    } catch (error) {
      return null;
    }
    rxtRuntime.lastSave = raw;
    if (!raw) {
      return null;
    }
    try {
      return rxtSanitizeSave(JSON.parse(raw));
    } catch (error) {
      return null;
    }
  }

  // Full or blocked storage only costs the save, never the game.
  function rxtWriteSave() {
    var raw = JSON.stringify(rxtSaveData(rxtState));
    try {
      localStorage.setItem(RXT_STORAGE_KEY, raw);
    } catch (error) {
      return false;
    }
    rxtRuntime.lastSave = raw;
    return true;
  }

  // True while storage still holds the save this tab last read or wrote.
  // Anything else means another tab of the game has saved since.
  function rxtOwnsSave() {
    try {
      return localStorage.getItem(RXT_STORAGE_KEY) === rxtRuntime.lastSave;
    } catch (error) {
      return false;
    }
  }

  function rxtLoadState() {
    var saved = rxtReadSave();
    if (saved) {
      Object.keys(saved).forEach(function (key) {
        rxtState[key] = saved[key];
      });
    }
  }

  // Saves with the session time brought up to this moment.
  function rxtPersist() {
    rxtSyncElapsed();
    rxtWriteSave();
  }

  // Hiding or leaving the page saves the session time, but never over a save
  // another tab wrote in the meantime: an idle tab would wipe its progress.
  function rxtPersistOnHide() {
    if (rxtOwnsSave()) {
      rxtPersist();
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function rxtSetText(element, text) {
    if (element.textContent !== text) {
      element.textContent = text;
    }
  }

  function rxtRenderBoard(viewName, label) {
    var view = RXT_VIEWS[viewName];
    var classes = rxtElements.board.classList;
    RXT_BOARD_CLASSES.forEach(function (name) {
      classes.toggle(name, name === view.board);
    });
    rxtElements.boardLabel.textContent = label || view.label;
    rxtElements.boardHint.textContent = view.hint;
    rxtElements.statusPill.textContent = view.pill;
  }

  function rxtRenderTimer() {
    rxtSetText(rxtElements.timer, rxtFormatSeconds(rxtState.elapsed));
  }

  function rxtRenderStats() {
    rxtElements.currentReaction.textContent = rxtFormatMs(rxtState.currentReaction);
    rxtElements.bestReaction.textContent = rxtFormatMs(rxtState.bestReaction);
    rxtElements.averageReaction.textContent =
      rxtFormatMs(rxtAverage(rxtState.totalReaction, rxtState.attempts));
    rxtElements.attempts.textContent = String(rxtState.attempts);
    rxtRenderTimer();
  }

  function rxtHideToast() {
    rxtRuntime.toastTimeout = null;
    rxtElements.toast.classList.remove('rxt-toast-visible');
  }

  // A new toast replaces the current one and gets its own full display time.
  function rxtShowToast(message) {
    clearTimeout(rxtRuntime.toastTimeout);
    rxtElements.toast.textContent = message;
    rxtElements.toast.classList.add('rxt-toast-visible');
    rxtRuntime.toastTimeout = setTimeout(rxtHideToast, RXT_TOAST_MS);
  }

  function rxtShowOverlay() {
    rxtElements.overlayTitle.textContent = RXT_TEXT.sessionComplete;
    rxtElements.overlayText.textContent = rxtSummaryText(rxtState);
    rxtElements.overlay.classList.add('rxt-overlay-visible');
    rxtElements.overlayButton.focus({ preventScroll: true });
  }

  function rxtHideOverlay() {
    rxtElements.overlay.classList.remove('rxt-overlay-visible');
  }

  // ── Session timer ─────────────────────────────────────────────────────────

  function rxtTick(now) {
    rxtState.elapsed = rxtElapsedSeconds(rxtRuntime.sessionStart, now);
    rxtRenderTimer();
    rxtRuntime.timerFrame = requestAnimationFrame(rxtTick);
  }

  // Runs the timer on from the current elapsed time (0 after a reset, the
  // saved time after a reload).
  function rxtStartTimer() {
    rxtStopTimer();
    rxtRuntime.sessionStart = performance.now() - rxtState.elapsed * 1000;
    rxtRuntime.timerFrame = requestAnimationFrame(rxtTick);
  }

  function rxtSyncElapsed() {
    if (rxtRuntime.timerFrame !== null) {
      rxtState.elapsed = rxtElapsedSeconds(rxtRuntime.sessionStart, performance.now());
    }
  }

  function rxtStopTimer() {
    rxtSyncElapsed();
    cancelAnimationFrame(rxtRuntime.timerFrame);
    rxtRuntime.timerFrame = null;
  }

  // ── Rounds ────────────────────────────────────────────────────────────────

  function rxtCancelSignal() {
    clearTimeout(rxtRuntime.signalTimeout);
    rxtRuntime.signalTimeout = null;
  }

  function rxtActivateBoard() {
    rxtRuntime.signalTimeout = null;
    rxtState.status = 'active';
    rxtRuntime.signalTime = performance.now();
    rxtRenderBoard('active');
  }

  // Starts a round when none is running and the session is not over.
  function rxtStartRound() {
    if (rxtState.status !== 'idle') {
      return;
    }
    rxtState.status = 'waiting';
    rxtRenderBoard('waiting');
    rxtRuntime.signalTimeout = setTimeout(
      rxtActivateBoard,
      rxtGetDelay(rxtState.difficulty, Math.random())
    );
  }

  // Start and Enter: a round, or on a finished session the summary again,
  // with its Play Again button.
  function rxtRequestRound() {
    if (rxtState.status === 'complete') {
      rxtShowOverlay();
    } else {
      rxtStartRound();
    }
  }

  function rxtFalseStart() {
    rxtCancelSignal();
    rxtState.status = 'idle';
    rxtRenderBoard('failed');
    rxtShowToast(RXT_TEXT.falseStart);
  }

  // The tenth success: play stops, the timer stops on the exact session time
  // and the summary opens with the focus on Play Again.
  function rxtCompleteSession() {
    rxtState.status = 'complete';
    rxtStopTimer();
    rxtShowOverlay();
  }

  function rxtReact(now) {
    var ms = Math.round(now - rxtRuntime.signalTime);
    var newBest = rxtRecordReaction(rxtState, ms);
    rxtState.status = 'idle';
    rxtRenderBoard('result', rxtFormatMs(ms));
    if (newBest) {
      rxtShowToast(RXT_TEXT.newBest);
    }
    if (rxtIsSessionComplete(rxtState.attempts)) {
      rxtCompleteSession();
    }
    rxtSyncElapsed();
    rxtRenderStats();
    rxtWriteSave();
  }

  // A press on the board (mouse, touch or Space): a false start while the
  // signal is pending, a reaction while it shows, nothing otherwise.
  function rxtPress() {
    if (rxtState.status === 'waiting') {
      rxtFalseStart();
    } else if (rxtState.status === 'active') {
      rxtReact(performance.now());
    }
  }

  function rxtResetGame() {
    rxtCancelSignal();
    rxtStopTimer();
    rxtState.status = 'idle';
    rxtState.currentReaction = 0;
    rxtState.bestReaction = null;
    rxtState.attempts = 0;
    rxtState.totalReaction = 0;
    rxtState.elapsed = 0;
    rxtHideOverlay();
    rxtRenderBoard('ready');
    rxtRenderStats();
    rxtStartTimer();
    rxtWriteSave();
  }

  // ── Input handling ────────────────────────────────────────────────────────

  // After a control the keys go to the board: Space reacts there instead of
  // pressing the control again.  A finished session leaves them on Play Again.
  function rxtFocusBoard() {
    if (rxtState.status !== 'complete') {
      rxtElements.board.focus({ preventScroll: true });
    }
  }

  function rxtOnNewGame() {
    rxtResetGame();
    rxtStartRound();
    rxtFocusBoard();
  }

  // Restart and Play Again.
  function rxtOnRestart() {
    rxtResetGame();
    rxtFocusBoard();
  }

  function rxtOnStart() {
    rxtRequestRound();
    rxtFocusBoard();
  }

  function rxtIsRoundRunning() {
    return rxtState.status === 'waiting' || rxtState.status === 'active';
  }

  // The press itself counts (mousedown, not click), so holding the button
  // adds nothing and pressing early is a false start.  A press the game takes
  // is cancelled, so the browser neither selects text nor moves the focus to
  // the board (after the tenth reaction it belongs to Play Again).
  function rxtOnBoardMouseDown(event) {
    if (event.button === 0 && rxtIsRoundRunning()) {
      event.preventDefault();
      rxtPress();
    }
  }

  // A touch during a round is the game's: cancelling it stops the page from
  // scrolling and the phone from emulating a click, which after the tenth
  // reaction would land on Play Again.  Other touches stay the page's.
  function rxtOnBoardTouchStart(event) {
    if (rxtIsRoundRunning()) {
      event.preventDefault();
      rxtPress();
    }
  }

  function rxtOnDifficultyChange() {
    rxtState.difficulty = rxtElements.difficulty.value;
    rxtPersist();
    rxtShowToast(RXT_TEXT.difficulty);
  }

  function rxtIsSpace(event) {
    return event.code === 'Space' || event.key === ' ';
  }

  function rxtIsEnter(event) {
    return event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
  }

  // Keys typed into fields, on buttons or links, or with Ctrl, Alt or Meta
  // are not game keys.  On the difficulty select only Enter is the game's;
  // Space, arrows and letters still work the select.
  function rxtIgnoresKey(event) {
    var target = event.target;
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return true;
    }
    if (target === rxtElements.difficulty) {
      return !rxtIsEnter(event);
    }
    return RXT_OWN_KEY_TAGS.indexOf(target.tagName) !== -1 ||
      target.isContentEditable === true;
  }

  // Enter starts a round, Space reacts.  Space is kept from scrolling the page
  // only during a round and on the focused board.  Enter on the difficulty
  // select also hands the keys to the board, so the next Space reacts.  On a
  // finished session Enter moves the focus to Play Again, so it is cancelled:
  // otherwise the browser lets the same key press click Play Again.
  function rxtOnKeyDown(event) {
    if (rxtIgnoresKey(event)) {
      return;
    }
    if (rxtIsSpace(event)) {
      if (rxtIsRoundRunning() || event.target === rxtElements.board) {
        event.preventDefault();
      }
      if (!event.repeat) {
        rxtPress();
      }
    } else if (rxtIsEnter(event) && !event.repeat) {
      if (rxtState.status === 'complete') {
        event.preventDefault();
      }
      rxtRequestRound();
      if (event.target === rxtElements.difficulty) {
        rxtFocusBoard();
      }
    }
  }

  function rxtOnVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      rxtPersistOnHide();
    }
  }

  // Named handlers: adding one twice is a no-op, so a second init stacks
  // nothing.
  function rxtBindEvents() {
    rxtElements.newGame.addEventListener('click', rxtOnNewGame);
    rxtElements.restartGame.addEventListener('click', rxtOnRestart);
    rxtElements.overlayButton.addEventListener('click', rxtOnRestart);
    rxtElements.actionTrigger.addEventListener('click', rxtOnStart);
    rxtElements.board.addEventListener('mousedown', rxtOnBoardMouseDown);
    rxtElements.board.addEventListener('touchstart', rxtOnBoardTouchStart, { passive: false });
    rxtElements.difficulty.addEventListener('change', rxtOnDifficultyChange);
    document.addEventListener('keydown', rxtOnKeyDown);
    document.addEventListener('visibilitychange', rxtOnVisibilityChange);
    window.addEventListener('pagehide', rxtPersistOnHide);
  }

  // ── Init and start-up ─────────────────────────────────────────────────────

  function rxtCacheElements() {
    Object.keys(RXT_IDS).forEach(function (key) {
      rxtElements[key] = document.getElementById(RXT_IDS[key]);
    });
  }

  function rxtInit() {
    rxtCacheElements();
    rxtBindEvents();
    rxtCancelSignal();
    rxtLoadState();
    rxtElements.difficulty.value = rxtState.difficulty;
    if (rxtIsSessionComplete(rxtState.attempts)) {
      // A session finished before the reload stays finished with its timer
      // stopped, but the summary waits for Start or Enter instead of covering
      // the host page and taking the focus at load.
      rxtState.status = 'complete';
      rxtRenderBoard('result', RXT_TEXT.sessionComplete);
    } else {
      rxtState.status = 'idle';
      rxtRenderBoard('ready');
      rxtStartTimer();
    }
    rxtRenderStats();
    rxtWriteSave();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      RXT_STORAGE_KEY: RXT_STORAGE_KEY,
      RXT_DELAYS: RXT_DELAYS,
      RXT_SESSION_ROUNDS: RXT_SESSION_ROUNDS,
      RXT_TOAST_MS: RXT_TOAST_MS,
      rxtState: rxtState,
      rxtIsDifficulty: rxtIsDifficulty,
      rxtGetDelay: rxtGetDelay,
      rxtAverage: rxtAverage,
      rxtIsNewBest: rxtIsNewBest,
      rxtFormatMs: rxtFormatMs,
      rxtFormatSeconds: rxtFormatSeconds,
      rxtElapsedSeconds: rxtElapsedSeconds,
      rxtIsSessionComplete: rxtIsSessionComplete,
      rxtSummaryText: rxtSummaryText,
      rxtRecordReaction: rxtRecordReaction,
      rxtSanitizeSave: rxtSanitizeSave,
      rxtReadSave: rxtReadSave,
      rxtWriteSave: rxtWriteSave,
      rxtInit: rxtInit
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rxtInit);
  } else {
    rxtInit();
  }
})();
