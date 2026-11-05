// tests/reaction-time.test.js
// Reaction Time Test (reaction-time/, prefix rxt): the game's behaviour.  The
// game runs the way a browser runs it (bootLikeBrowser over the real
// index.html), driven through the listeners its init registers: clicks, mouse
// presses, touches and keys.  The pure helpers are tested through the exports
// the script gives Node.  Markup, stylesheet and source checks live in
// reaction-time.source.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, flushAnimationFrames, resetStubs, createEvent, touchEvent, fire, pressKey,
  listenerCount, listenersOf, createPage, loadWithPage, bootLikeBrowser, readRepoFile, htmlPageSpec,
  setVisibility
} = require('./_setup');

const SCRIPT = 'reaction-time/script.js';
const KEY = 'rxt-reaction-state';
const HTML = readRepoFile('reaction-time/index.html');
const MODES = ['idle', 'waiting', 'active', 'failed'];
const DELAYS = { easy: [2000, 4500], normal: [1500, 3500], hard: [1000, 2500], extreme: [600, 1600] };
// A save exactly as the first published version (commit a4cfbc5) wrote it.
const BASELINE_SAVE = '{"difficulty":"hard","bestReaction":175,"attempts":2,"totalReaction":365,"elapsed":12.3456}';

// performance.now, setTimeout and Math.random under test control.  advance(ms)
// moves the clock and fires the timers that fall due (they see the new time).
function controlTime(t, start = 1000) {
  const clock = { now: start, random: 0 };
  t.mock.method(performance, 'now', () => clock.now);
  t.mock.method(Math, 'random', () => clock.random);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  clock.advance = (ms) => {
    clock.now += ms;
    t.mock.timers.tick(ms);
  };
  return clock;
}

// The game in a browser that has parsed index.html (or, with readyState
// 'loading', one that is still parsing it), with an optional saved session.
function boot(options = {}) {
  if (options.save !== undefined) localStorage.setItem(KEY, options.save);
  const b = bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), {
    readyState: options.readyState
  });
  const els = b.els;
  const text = (id) => els[id].textContent.trim();
  const has = (id, cls) => els[id].classList.contains(cls);
  return {
    b,
    els,
    text,
    has,
    click: (id) => els[id].click(),
    press: (key, props) => pressKey(key, props),
    mouse: (type = 'mousedown', button = 0) => fire(els['rxt-board'], type, { button }),
    touch: () => {
      const ev = touchEvent('touchstart', [120, 160]);
      els['rxt-board'].dispatchEvent(ev);
      return ev;
    },
    choose: (difficulty) => {
      els['rxt-difficulty'].value = difficulty;
      fire(els['rxt-difficulty'], 'change');
    },
    board: () => ({
      mode: MODES.filter((m) => has('rxt-board', 'rxt-board-' + m)).join(' '),
      label: text('rxt-board-label'),
      pill: text('rxt-status-pill')
    }),
    stats: () => ({
      current: text('rxt-current-reaction'),
      best: text('rxt-best-reaction'),
      average: text('rxt-average-reaction'),
      attempts: text('rxt-attempts'),
      timer: text('rxt-timer')
    }),
    overlay: () => has('rxt-overlay', 'rxt-overlay-visible'),
    toast: () => (has('rxt-toast', 'rxt-toast-visible') ? text('rxt-toast') : null),
    save: () => JSON.parse(localStorage.getItem(KEY))
  };
}

// A page reload: the browser fires pagehide, drops the page (listeners, frames,
// elements) and keeps localStorage; then the game boots again.
function reload(options) {
  window.dispatchEvent(createEvent('pagehide'));
  const saved = localStorage.getItem(KEY);
  resetStubs();
  if (saved !== null) localStorage.setItem(KEY, saved);
  return boot(options);
}

// One successful round of `ms` milliseconds: Enter, the minimum delay of the
// difficulty (Math.random() = 0), then Space.
function playRound(g, clock, ms, delay = DELAYS.normal[0]) {
  g.press('Enter');
  clock.advance(delay);
  clock.advance(ms);
  g.press(' ');
}

// A session of nine rounds, one round short of the summary.
const NINE_ROUNDS = '{"difficulty":"normal","bestReaction":150,"attempts":9,"totalReaction":1800,"elapsed":10}';

test.beforeEach(() => {
  resetStubs();
});

// ── Start-up ────────────────────────────────────────────────────────────────

test('reaction: loading under Node starts nothing, even while the document is still loading', () => {
  const doc = globalThis.document;
  const before = doc.readyState;
  try {
    for (const state of ['complete', 'loading']) {
      doc.readyState = state;
      loadScript(SCRIPT);
      assert.equal(listenerCount(doc), 0, state + ': no listener on document (no DOMContentLoaded wait)');
      assert.equal(listenerCount(window), 0, state + ': no listener on window');
    }
  } finally {
    doc.readyState = before;
  }
  assert.equal(flushAnimationFrames(), 0, 'no timer frame was requested');
  assert.equal(localStorage.getItem(KEY), null, 'nothing was saved');
});

test('reaction: in a browser that has parsed the page, init runs at once', (t) => {
  controlTime(t);
  const g = boot();
  assert.deepEqual(g.board(), { mode: 'idle', label: 'Press Start', pill: 'Ready' });
  assert.equal(g.text('rxt-board-hint'), 'Wait for the neon signal, then react instantly.');
  assert.deepEqual(g.stats(), { current: '0 ms', best: '--', average: '0 ms', attempts: '0', timer: '0.0s' });
  assert.equal(g.els['rxt-difficulty'].value, 'normal');
  assert.equal(g.overlay(), false);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.deepEqual(g.save(), { difficulty: 'normal', bestReaction: null, attempts: 0, totalReaction: 0, elapsed: 0 });
  assert.equal(flushAnimationFrames(), 1, 'the session timer runs');
});

test('reaction: while the page is still loading, init waits for DOMContentLoaded', (t) => {
  controlTime(t);
  const g = boot({ readyState: 'loading' });
  assert.equal(g.text('rxt-best-reaction'), '0 ms', 'the markup is untouched');
  assert.equal(listenerCount(document, 'keydown'), 0);
  assert.equal(flushAnimationFrames(), 0);
  g.b.ready();
  assert.equal(g.text('rxt-best-reaction'), '--');
  assert.equal(listenerCount(document, 'keydown'), 1);
  g.press('Enter');
  assert.equal(g.board().label, 'Wait...');
});

// ── Pure helpers ────────────────────────────────────────────────────────────

test('reaction: the signal delay stays inside each difficulty window; unknown names use Normal', () => {
  const rxt = loadScript(SCRIPT);
  assert.deepEqual(rxt.RXT_DELAYS, DELAYS);
  for (const [level, [min, max]] of Object.entries(DELAYS)) {
    assert.equal(rxt.rxtGetDelay(level, 0), min, level + ' minimum');
    assert.equal(rxt.rxtGetDelay(level, 0.5), (min + max) / 2, level + ' midpoint');
    assert.equal(rxt.rxtGetDelay(level, 0.999999), max - 1, level + ' maximum is exclusive');
  }
  for (const odd of ['insane', '', undefined, null, 'constructor', '__proto__', 'toString', 7]) {
    assert.equal(rxt.rxtGetDelay(odd, 0), 1500, String(odd) + ' falls back to Normal');
    assert.equal(rxt.rxtIsDifficulty(odd), false);
  }
  assert.equal(rxt.rxtIsDifficulty('extreme'), true);
});

test('reaction: averages, best checks and the shown texts', () => {
  const rxt = loadScript(SCRIPT);
  assert.equal(rxt.rxtAverage(0, 0), 0, 'no attempts, no average');
  assert.equal(rxt.rxtAverage(831, 3), 277);
  assert.equal(rxt.rxtAverage(365, 2), 183, 'halves round up');
  assert.equal(rxt.rxtIsNewBest(null, 400), true);
  assert.equal(rxt.rxtIsNewBest(250, 249), true);
  assert.equal(rxt.rxtIsNewBest(250, 250), false, 'equalling the best is not a new best');
  assert.equal(rxt.rxtFormatMs(237), '237 ms');
  assert.equal(rxt.rxtFormatMs(0), '0 ms');
  assert.equal(rxt.rxtFormatMs(null), '--');
  assert.equal(rxt.rxtFormatSeconds(0), '0.0s');
  assert.equal(rxt.rxtFormatSeconds(-0.004), '0.0s', 'never -0.0s');
  assert.equal(rxt.rxtFormatSeconds(-3), '0.0s');
  assert.equal(rxt.rxtFormatSeconds(NaN), '0.0s');
  assert.equal(rxt.rxtFormatSeconds(12.04), '12.0s');
  assert.equal(rxt.rxtFormatSeconds(12.06), '12.1s');
  assert.equal(rxt.rxtElapsedSeconds(1000, 3500), 2.5);
  assert.equal(rxt.rxtElapsedSeconds(2000, 1999.9), 0, 'a frame stamped before the start counts as 0');
  assert.equal(rxt.rxtIsSessionComplete(9), false);
  assert.equal(rxt.rxtIsSessionComplete(10), true);
  assert.equal(rxt.rxtIsSessionComplete(12), true);
  assert.equal(rxt.RXT_SESSION_ROUNDS, 10);
  assert.equal(rxt.RXT_TOAST_MS, 2200);
  assert.equal(rxt.rxtSummaryText({ totalReaction: 2285, attempts: 10, bestReaction: 180 }),
    'Average reaction: 229 ms | Best: 180 ms', 'an exact .5 average rounds up');
  assert.equal(rxt.rxtSummaryText({ totalReaction: 0, attempts: 10, bestReaction: null }),
    'Average reaction: 0 ms | Best: --');
});

test('reaction: recording reactions keeps the current, best, total and attempts', () => {
  const rxt = loadScript(SCRIPT);
  const s = { currentReaction: 0, bestReaction: null, attempts: 0, totalReaction: 0 };
  assert.equal(rxt.rxtRecordReaction(s, 300), true, 'the first reaction is a new best');
  assert.equal(rxt.rxtRecordReaction(s, 250), true);
  assert.equal(rxt.rxtRecordReaction(s, 281), false);
  assert.equal(rxt.rxtRecordReaction(s, 250), false);
  assert.deepEqual(s, { currentReaction: 250, bestReaction: 250, attempts: 4, totalReaction: 1081 });
});

test('reaction: a save is cleaned field by field, and anything but an object is no save', () => {
  const rxt = loadScript(SCRIPT);
  const clean = rxt.rxtSanitizeSave(JSON.parse(BASELINE_SAVE));
  assert.deepEqual(clean, { difficulty: 'hard', bestReaction: 175, attempts: 2, totalReaction: 365, elapsed: 12.3456 });
  assert.deepEqual(Object.keys(clean), ['difficulty', 'bestReaction', 'attempts', 'totalReaction', 'elapsed']);
  for (const junk of [null, undefined, 42, 'x', true, [], [1, 2]]) {
    assert.equal(rxt.rxtSanitizeSave(junk), null, JSON.stringify(junk));
  }
  const fresh = { difficulty: 'normal', bestReaction: null, attempts: 0, totalReaction: 0, elapsed: 0 };
  assert.deepEqual(rxt.rxtSanitizeSave({}), fresh);
  const base = { difficulty: 'easy', bestReaction: 190, attempts: 3, totalReaction: 600, elapsed: 8 };
  const cases = [
    [{ difficulty: 'insane' }, { difficulty: 'normal' }],
    [{ difficulty: '__proto__' }, { difficulty: 'normal' }],
    [{ difficulty: 'constructor' }, { difficulty: 'normal' }],
    [{ difficulty: 3 }, { difficulty: 'normal' }],
    [{ bestReaction: undefined }, { bestReaction: null }],
    [{ bestReaction: '150' }, { bestReaction: null }],
    [{ bestReaction: -5 }, { bestReaction: null }],
    [{ bestReaction: 0 }, { bestReaction: 0 }],
    [{ attempts: '3' }, { attempts: 0, totalReaction: 0 }],
    [{ attempts: -1 }, { attempts: 0, totalReaction: 0 }],
    [{ attempts: 2.5 }, { attempts: 0, totalReaction: 0 }],
    [{ attempts: Infinity }, { attempts: 0, totalReaction: 0 }],
    [{ totalReaction: '600' }, { totalReaction: 0 }],
    [{ totalReaction: NaN }, { totalReaction: 0 }],
    [{ elapsed: '5' }, { elapsed: 0 }],
    [{ elapsed: true }, { elapsed: 0 }],
    [{ elapsed: -4 }, { elapsed: 0 }],
    [{ elapsed: null }, { elapsed: 0 }]
  ];
  for (const [patch, fix] of cases) {
    assert.deepEqual(rxt.rxtSanitizeSave({ ...base, ...patch }), { ...base, ...fix }, JSON.stringify(patch));
  }
});

test('reaction: reading and writing the save survive broken JSON and blocked storage', (t) => {
  const rxt = loadScript(SCRIPT);
  assert.equal(rxt.RXT_STORAGE_KEY, KEY);
  assert.equal(rxt.rxtReadSave(), null, 'no save yet');
  localStorage.setItem(KEY, BASELINE_SAVE);
  assert.deepEqual(rxt.rxtReadSave(), JSON.parse(BASELINE_SAVE));
  assert.equal(rxt.rxtWriteSave(), true);
  assert.equal(localStorage.getItem(KEY), '{"difficulty":"normal","bestReaction":null,"attempts":0,"totalReaction":0,"elapsed":0}');

  t.mock.method(console, 'error', () => {});
  localStorage.setItem(KEY, '{not json');
  assert.equal(rxt.rxtReadSave(), null);
  assert.equal(console.error.mock.callCount(), 0, 'a broken save is not logged on the host page');

  t.mock.method(localStorage, 'getItem', () => { throw new Error('SecurityError'); });
  t.mock.method(localStorage, 'setItem', () => { throw new Error('QuotaExceededError'); });
  assert.equal(rxt.rxtReadSave(), null);
  assert.equal(rxt.rxtWriteSave(), false);
});

// ── Playing ─────────────────────────────────────────────────────────────────

test('reaction: a mouse press before the signal is a false start and counts nothing', (t) => {
  const clock = controlTime(t);
  const g = boot();
  g.click('rxt-action-trigger');
  assert.deepEqual(g.board(), { mode: 'waiting', label: 'Wait...', pill: 'Waiting' });
  assert.equal(g.text('rxt-board-hint'), 'Do NOT click until the neon signal appears.');

  clock.advance(500);
  g.mouse();
  assert.deepEqual(g.board(), { mode: 'failed', label: 'Too Early', pill: 'Fault' });
  assert.equal(g.text('rxt-board-hint'), 'You reacted before the signal appeared.');
  assert.equal(g.toast(), 'False start detected');
  assert.equal(g.text('rxt-attempts'), '0');

  // The pending signal was cancelled: waiting out the longest delay changes nothing.
  clock.advance(3500);
  assert.deepEqual(g.board(), { mode: 'failed', label: 'Too Early', pill: 'Fault' });
  assert.equal(g.toast(), null, 'the toast hides after 2.2 s');

  // The next round clears the red board.
  g.click('rxt-action-trigger');
  assert.equal(g.board().mode, 'waiting');
});

test('reaction: reacting to the signal measures and records the time', (t) => {
  const clock = controlTime(t);
  const g = boot();
  assert.equal(g.press('Enter').defaultPrevented, false, 'the Enter that starts a round is not cancelled');
  clock.advance(1499);
  assert.equal(g.board().mode, 'waiting', 'Normal waits at least 1500 ms');
  clock.advance(1);
  assert.deepEqual(g.board(), { mode: 'active', label: 'CLICK NOW', pill: 'GO' });
  assert.equal(g.text('rxt-board-hint'), 'Tap, click, or press Space immediately.');

  clock.advance(237.4);
  assert.equal(g.press(' ').defaultPrevented, true, 'Space is swallowed so the page does not scroll');
  assert.deepEqual(g.board(), { mode: 'idle', label: '237 ms', pill: 'Completed' });
  assert.equal(g.text('rxt-board-hint'), 'Excellent reflexes. Start another round.');
  assert.deepEqual(g.stats(), { current: '237 ms', best: '237 ms', average: '237 ms', attempts: '1', timer: '1.7s' });
  assert.equal(g.toast(), 'New best reaction time!');
  clock.advance(2199);
  assert.equal(g.toast(), 'New best reaction time!');
  clock.advance(1);
  assert.equal(g.toast(), null, 'the toast hides after 2.2 s');
  const saved = g.save();
  assert.deepEqual([saved.bestReaction, saved.attempts, saved.totalReaction], [237, 1, 237]);
});

test('reaction: the best only improves and the average is the rounded mean', (t) => {
  const clock = controlTime(t);
  const g = boot();
  playRound(g, clock, 300);
  clock.advance(2200);
  playRound(g, clock, 250);
  clock.advance(2200);
  playRound(g, clock, 281);
  assert.deepEqual(g.stats(), { current: '281 ms', best: '250 ms', average: '277 ms', attempts: '3', timer: '9.7s' });
  assert.equal(g.toast(), null, 'a slower round shows no toast');
});

test('reaction: touching the board is a false start while waiting and a reaction on the signal', (t) => {
  const clock = controlTime(t);
  const g = boot();
  g.click('rxt-action-trigger');
  clock.advance(700);
  g.touch();
  assert.equal(g.board().label, 'Too Early');

  g.click('rxt-action-trigger');
  clock.advance(1500);
  clock.advance(204.5);
  g.touch();
  g.mouse();               // the mouse events a phone emulates after the touch
  g.mouse('click');
  assert.equal(g.board().label, '205 ms', 'rounded to the nearest ms');
  assert.equal(g.text('rxt-attempts'), '1', 'one touch counts once');
});

test('reaction: a touch the game takes is not also a scroll or a click on the summary; idle touches stay the page\'s (N1)', (t) => {
  // After a touch, a phone emulates mousedown and click at the same spot.
  // Unless the touch is cancelled, the click of the tenth reaction lands on
  // Play Again, which the summary has just put there, and wipes the session.
  const clock = controlTime(t);
  const g = boot({ save: NINE_ROUNDS });
  // Browsers ignore preventDefault in a passive listener (the harness does not).
  assert.deepEqual(listenersOf(g.els['rxt-board'], 'touchstart').map((l) => l.passive), [false]);
  assert.equal(g.touch().defaultPrevented, false, 'idle: a swipe on the board still scrolls the page');
  g.click('rxt-action-trigger');
  clock.advance(1500);
  clock.advance(170);
  assert.equal(g.touch().defaultPrevented, true, 'the reaction touch is cancelled: no emulated click');
  assert.equal(g.overlay(), true);
  assert.equal(g.touch().defaultPrevented, false, 'the session is over: the touch is not the game\'s');

  g.click('rxt-overlay-button');
  g.click('rxt-action-trigger');
  clock.advance(400);
  assert.equal(g.touch().defaultPrevented, true, 'a false start is cancelled too');
  assert.equal(g.board().label, 'Too Early');
});

test('reaction: Space before the signal is a false start too', (t) => {
  const clock = controlTime(t);
  const g = boot();
  g.press('Enter');
  clock.advance(300);
  assert.equal(g.press(' ').defaultPrevented, true);
  assert.equal(g.board().label, 'Too Early');
  assert.equal(g.text('rxt-attempts'), '0');
});

test('reaction: presses while idle do nothing', (t) => {
  controlTime(t);
  const g = boot();
  const before = [g.board(), g.stats(), g.toast()];
  g.mouse();
  g.mouse('click');
  g.touch();
  g.press(' ');
  assert.deepEqual([g.board(), g.stats(), g.toast()], before);
});

test('reaction: Enter, Start and the difficulty never disturb a round in progress', (t) => {
  const clock = controlTime(t);
  const g = boot();
  g.press('Enter');
  clock.advance(1000);
  g.press('Enter');
  g.click('rxt-action-trigger');
  g.choose('extreme');
  assert.equal(g.toast(), 'Difficulty updated');
  clock.advance(499);
  assert.equal(g.board().mode, 'waiting', 'the pending signal keeps its Normal delay');
  clock.advance(1);
  assert.equal(g.board().label, 'CLICK NOW');
  g.press('Enter');
  g.click('rxt-action-trigger');
  assert.equal(g.board().label, 'CLICK NOW', 'Enter and Start are ignored while the signal shows');
  clock.advance(120);
  g.press(' ');
  clock.advance(5000);
  assert.equal(g.board().label, '120 ms', 'exactly one signal was pending');

  // The next round uses the Extreme window.
  g.press('Enter');
  clock.advance(599);
  assert.equal(g.board().mode, 'waiting');
  clock.advance(1);
  assert.equal(g.board().mode, 'active');
});

test('reaction: a difficulty change is saved at once, with the session time, and shows a 2.2 s toast', (t) => {
  const clock = controlTime(t);
  const g = boot();
  clock.now += 4000;   // no timer frame has run since init
  g.choose('hard');
  assert.deepEqual(g.save(), { difficulty: 'hard', bestReaction: null, attempts: 0, totalReaction: 0, elapsed: 4 },
    'the saved time is brought up to the change');
  assert.equal(g.toast(), 'Difficulty updated');
  clock.advance(2200);
  assert.equal(g.toast(), null);
});

test('reaction: the tenth success ends the session with a summary and stops the timer', (t) => {
  const clock = controlTime(t);
  const g = boot();
  const times = [210, 190, 250, 230, 205, 300, 180, 220, 240, 260];
  times.slice(0, 9).forEach((ms) => {
    playRound(g, clock, ms);
    clock.advance(2200);
  });
  assert.equal(g.overlay(), false, 'nine rounds are not a session');
  flushAnimationFrames();

  playRound(g, clock, times[9]);
  assert.equal(g.overlay(), true);
  assert.equal(g.text('rxt-overlay-title'), 'Session Complete');
  assert.equal(g.text('rxt-overlay-text'), 'Average reaction: 229 ms | Best: 180 ms');
  assert.deepEqual(g.board(), { mode: 'idle', label: '260 ms', pill: 'Completed' });
  assert.equal(flushAnimationFrames(), 0, 'the session timer frame was cancelled');
  const elapsed = (clock.now - 1000) / 1000;
  assert.equal(g.text('rxt-timer'), elapsed.toFixed(1) + 's', 'the timer stops on the exact session time');
  assert.equal(g.save().elapsed, elapsed);
  assert.equal(document.activeElement, g.els['rxt-overlay-button'], 'Play Again has the focus');

  g.click('rxt-overlay-button');
  assert.equal(g.overlay(), false);
  assert.deepEqual(g.stats(), { current: '0 ms', best: '--', average: '0 ms', attempts: '0', timer: '0.0s' });
  assert.deepEqual(g.board(), { mode: 'idle', label: 'Press Start', pill: 'Ready' });
  assert.equal(document.activeElement, g.els['rxt-board']);
  assert.equal(flushAnimationFrames(clock.now + 3000), 1, 'the timer runs again');
  assert.equal(g.text('rxt-timer'), '3.0s');
});

test('reaction: Restart clears the session and cancels a pending signal', (t) => {
  const clock = controlTime(t);
  const g = boot();
  playRound(g, clock, 222);
  g.press('Enter');
  g.click('rxt-restart-game');
  assert.deepEqual(g.board(), { mode: 'idle', label: 'Press Start', pill: 'Ready' });
  assert.deepEqual(g.stats(), { current: '0 ms', best: '--', average: '0 ms', attempts: '0', timer: '0.0s' });
  clock.advance(3500);
  assert.equal(g.board().label, 'Press Start', 'the signal never fires');
  assert.deepEqual(g.save(), { difficulty: 'normal', bestReaction: null, attempts: 0, totalReaction: 0, elapsed: 0 });
});

test('reaction: Restart while the signal shows removes it, and a press afterwards does nothing', (t) => {
  const clock = controlTime(t);
  const g = boot();
  g.press('Enter');
  clock.advance(1500);
  g.click('rxt-restart-game');
  assert.deepEqual(g.board(), { mode: 'idle', label: 'Press Start', pill: 'Ready' });
  g.mouse();
  g.press(' ');
  assert.equal(g.text('rxt-attempts'), '0');
  assert.equal(g.board().label, 'Press Start');
});

test('reaction: New Game resets and starts a round straight away', (t) => {
  const clock = controlTime(t);
  const g = boot();
  playRound(g, clock, 200);
  g.click('rxt-new-game');
  assert.equal(g.text('rxt-attempts'), '0');
  assert.deepEqual(g.board(), { mode: 'waiting', label: 'Wait...', pill: 'Waiting' });
});

test('reaction: New Game, Restart and Start never stack listeners, timers or signals', (t) => {
  const clock = controlTime(t);
  const g = boot();
  const counts = () => ({
    keydown: listenerCount(document, 'keydown'),
    visibility: listenerCount(document, 'visibilitychange'),
    pagehide: listenerCount(window, 'pagehide'),
    board: listenerCount(g.els['rxt-board']),
    buttons: ['rxt-new-game', 'rxt-restart-game', 'rxt-action-trigger', 'rxt-overlay-button']
      .map((id) => listenerCount(g.els[id], 'click')),
    select: listenerCount(g.els['rxt-difficulty'], 'change')
  });
  const first = counts();
  assert.deepEqual(first, { keydown: 1, visibility: 1, pagehide: 1, board: 2, buttons: [1, 1, 1, 1], select: 1 });
  for (let i = 0; i < 5; i++) {
    g.click('rxt-new-game');
    g.click('rxt-restart-game');
    g.click('rxt-action-trigger');
    g.click('rxt-action-trigger');
    g.click('rxt-new-game');
  }
  assert.deepEqual(counts(), first);
  assert.equal(flushAnimationFrames(), 1, 'one timer frame, however many restarts');
  clock.advance(1500);
  clock.advance(150);
  g.press(' ');
  clock.advance(5000);
  assert.equal(g.board().label, '150 ms', 'only one signal was pending');
  assert.equal(g.text('rxt-attempts'), '1');
});

test('reaction: a second init does not double the listeners or the timer, and drops a pending signal', (t) => {
  const clock = controlTime(t);
  const page = createPage(htmlPageSpec(HTML));
  const { exports: rxt } = loadWithPage(SCRIPT, page, { keep: true });
  rxt.rxtInit();
  pressKey('Enter');
  assert.equal(rxt.rxtState.status, 'waiting');
  rxt.rxtInit();
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(page.els['rxt-board'], 'mousedown'), 1);
  assert.equal(listenerCount(page.els['rxt-new-game'], 'click'), 1);
  assert.equal(flushAnimationFrames(), 1);
  assert.equal(rxt.rxtState.status, 'idle');
  clock.advance(3500);
  assert.equal(rxt.rxtState.status, 'idle', 'the old round\'s signal never fires');
  assert.equal(page.els['rxt-board-label'].textContent, 'Press Start');
});

test('reaction: the session timer counts from init in tenths of a second', (t) => {
  controlTime(t, 1000);
  const g = boot();
  assert.equal(g.text('rxt-timer'), '0.0s');
  assert.equal(flushAnimationFrames(3500), 1);
  assert.equal(g.text('rxt-timer'), '2.5s');
  assert.equal(flushAnimationFrames(3500), 1, 'an unchanged time keeps the text');
  assert.equal(g.text('rxt-timer'), '2.5s');
  assert.equal(flushAnimationFrames(13000), 1, 'the timer keeps requesting frames');
  assert.equal(g.text('rxt-timer'), '12.0s');
});

// ── Saves ───────────────────────────────────────────────────────────────────

test('reaction: the stats and the difficulty survive a reload', (t) => {
  const clock = controlTime(t);
  const first = boot();
  first.choose('hard');
  playRound(first, clock, 190, 1000);
  clock.advance(2200);
  playRound(first, clock, 175, 1000);

  const saved = first.save();
  assert.deepEqual(Object.keys(saved), ['difficulty', 'bestReaction', 'attempts', 'totalReaction', 'elapsed']);
  assert.deepEqual(saved, { difficulty: 'hard', bestReaction: 175, attempts: 2, totalReaction: 365, elapsed: 4.565 });

  const second = reload();
  assert.equal(second.els['rxt-difficulty'].value, 'hard');
  assert.deepEqual(second.stats(), { current: '0 ms', best: '175 ms', average: '183 ms', attempts: '2', timer: '4.6s' });
  assert.deepEqual(second.board(), { mode: 'idle', label: 'Press Start', pill: 'Ready' });
  second.press('Enter');
  clock.advance(999);
  assert.equal(second.board().mode, 'waiting');
  clock.advance(1);
  assert.equal(second.board().mode, 'active', 'Hard is back in force');
});

test('reaction: a save written by the first published version loads into every field', (t) => {
  const clock = controlTime(t);
  const g = boot({ save: BASELINE_SAVE });
  assert.equal(g.els['rxt-difficulty'].value, 'hard');
  assert.deepEqual(g.stats(), { current: '0 ms', best: '175 ms', average: '183 ms', attempts: '2', timer: '12.3s' });
  playRound(g, clock, 160, 1000);
  const { elapsed, ...rest } = g.save();
  assert.deepEqual(rest, { difficulty: 'hard', bestReaction: 160, attempts: 3, totalReaction: 525 });
  assert.ok(Math.abs(elapsed - 13.5056) < 1e-9, 'the timer went on from 12.3456 s: ' + elapsed);
});

test('reaction: broken JSON in storage falls back to a fresh game without a console error', (t) => {
  controlTime(t);
  t.mock.method(console, 'error', () => {});
  const g = boot({ save: '{not json' });
  assert.equal(console.error.mock.callCount(), 0);
  assert.deepEqual(g.stats(), { current: '0 ms', best: '--', average: '0 ms', attempts: '0', timer: '0.0s' });
  assert.equal(g.els['rxt-difficulty'].value, 'normal');
  assert.equal(g.save().difficulty, 'normal', 'the clean state replaces the broken one');
});

// ── Fixed bugs (each test failed on the first published version) ────────────

test('reaction: Enter on a focused New Game button runs only the button, and later Enters keep the session (B1)', (t) => {
  const clock = controlTime(t);
  const g = boot();
  playRound(g, clock, 200);
  g.els['rxt-new-game'].focus();
  g.press('Enter');
  assert.equal(g.text('rxt-attempts'), '0', 'a new game');
  assert.equal(g.board().label, 'Wait...');
  clock.advance(1500);
  clock.advance(180);
  g.press(' ');
  assert.equal(g.text('rxt-attempts'), '1');
  g.press('Enter');
  assert.equal(g.text('rxt-attempts'), '1', 'Enter starts the next round without wiping the session');
  assert.equal(g.board().label, 'Wait...');
});

test('reaction: Enter on a focused Restart button restarts, and the next Enter starts a round (B1)', (t) => {
  controlTime(t);
  const g = boot();
  g.els['rxt-restart-game'].focus();
  g.press('Enter');
  assert.equal(g.board().label, 'Press Start');
  g.press('Enter');
  assert.equal(g.board().label, 'Wait...');
});

test('reaction: after New Game, Restart, Start or Play Again the keys go to the board (B1)', (t) => {
  controlTime(t);
  const g = boot({ save: NINE_ROUNDS.replace('"attempts":9', '"attempts":10') });
  for (const id of ['rxt-overlay-button', 'rxt-new-game', 'rxt-restart-game', 'rxt-action-trigger']) {
    document.activeElement = document.body;
    g.click(id);
    assert.equal(document.activeElement, g.els['rxt-board'], id);
  }
});

test('reaction: a mouse press during the wait is a false start, even when released after the signal (B2)', (t) => {
  const clock = controlTime(t);
  const g = boot();
  g.click('rxt-action-trigger');
  clock.advance(500);
  g.mouse('mousedown');
  assert.equal(g.board().label, 'Too Early');
  clock.advance(3000);
  g.mouse('mouseup');
  g.mouse('click');
  assert.equal(g.board().label, 'Too Early');
  assert.equal(g.text('rxt-attempts'), '0');
});

test('reaction: a mouse reaction is timed at the press; release, click and other buttons do not count (B2)', (t) => {
  const clock = controlTime(t);
  const g = boot();
  g.click('rxt-action-trigger');
  g.mouse('click');
  assert.equal(g.board().mode, 'waiting', 'a click (release) alone is no false start');
  clock.advance(1500);
  g.mouse('click');
  g.mouse('mousedown', 2);
  g.mouse('mousedown', 1);
  assert.equal(g.board().label, 'CLICK NOW', 'click, right and middle buttons do not react');
  clock.advance(180);
  g.mouse('mousedown');
  clock.advance(150);
  g.mouse('mouseup');
  g.mouse('click');
  assert.equal(g.board().label, '180 ms', 'the hold time is not added');
  assert.equal(g.text('rxt-attempts'), '1');
});

test('reaction: keys typed into page fields stay with the field (B3)', (t) => {
  const clock = controlTime(t);
  const g = boot();
  const editable = document.createElement('div');
  editable.isContentEditable = true;
  const fields = [document.createElement('input'), document.createElement('textarea'), editable, document.createElement('select')];
  fields.forEach((f) => document.body.appendChild(f));
  try {
    for (const field of fields) {
      field.focus();
      assert.equal(g.press(' ').defaultPrevented, false, field.tagName + ' keeps its Space');
      g.press('Enter');
      assert.equal(g.board().label, 'Press Start', 'Enter in ' + field.tagName + ' starts no round');
    }
    g.click('rxt-action-trigger');
    clock.advance(1500);
    fields[0].focus();
    g.press(' ');
    assert.equal(g.board().label, 'CLICK NOW', 'typing a space during a round is no reaction');
  } finally {
    fields.forEach((f) => f.remove());
  }
});

test('reaction: during a round, Space on a focused button or link is theirs, not a reaction (B3)', (t) => {
  const clock = controlTime(t);
  const g = boot();
  const link = document.createElement('a');
  document.body.appendChild(link);
  try {
    g.press('Enter');
    clock.advance(1500);
    link.focus();
    assert.equal(g.press(' ').defaultPrevented, false, 'the link keeps its Space (the page scrolls)');
    assert.equal(g.board().label, 'CLICK NOW', 'no reaction');
    g.els['rxt-restart-game'].focus();
    assert.equal(g.press(' ').defaultPrevented, false, 'the button keeps its Space');
    assert.deepEqual(g.board(), { mode: 'idle', label: 'Press Start', pill: 'Ready' }, 'Space pressed Restart');
    assert.equal(g.text('rxt-attempts'), '0');
  } finally {
    link.remove();
  }
});

test('reaction: Enter on the difficulty select starts a round and hands Space to the board; other keys work the select', (t) => {
  // Picking a difficulty with the mouse leaves the focus on the select.
  const clock = controlTime(t);
  const g = boot();
  const select = g.els['rxt-difficulty'];
  select.focus();
  g.choose('extreme');
  for (const key of [' ', 'ArrowDown', 'e']) {
    assert.equal(g.press(key).defaultPrevented, false, JSON.stringify(key) + ' stays with the select');
    assert.equal(g.board().label, 'Press Start', JSON.stringify(key) + ' starts no round');
  }
  g.press('Enter', { ctrlKey: true });
  assert.equal(g.board().label, 'Press Start', 'Ctrl+Enter is not the game\'s');
  assert.equal(document.activeElement, select);

  g.press('Enter');
  assert.equal(g.board().label, 'Wait...', 'Enter starts a round');
  assert.equal(document.activeElement, g.els['rxt-board'], 'the keys go to the board');
  clock.advance(599);
  assert.equal(g.board().mode, 'waiting');
  clock.advance(1);
  assert.equal(g.board().mode, 'active', 'on the Extreme window just picked');
  clock.advance(140);
  assert.equal(g.press(' ').defaultPrevented, true);
  assert.equal(g.board().label, '140 ms', 'the next Space reacts');

  // During a round Space stays with the select, and Enter only hands the keys over.
  g.press('Enter');
  select.focus();
  assert.equal(g.press(' ').defaultPrevented, false, 'Space on the select is no false start');
  assert.equal(g.board().label, 'Wait...');
  g.press('Enter');
  assert.equal(document.activeElement, g.els['rxt-board']);
  clock.advance(599);
  assert.equal(g.board().mode, 'waiting', 'Enter started no second round');
  clock.advance(1);
  clock.advance(90);
  g.press(' ');
  clock.advance(5000);
  assert.equal(g.board().label, '90 ms', 'one signal was pending');
  assert.equal(g.text('rxt-attempts'), '2');
});

test('reaction: an unknown saved difficulty plays on Normal instead of throwing (B4)', (t) => {
  const clock = controlTime(t);
  const g = boot({ save: '{"difficulty":"insane","bestReaction":200,"attempts":1,"totalReaction":200,"elapsed":1}' });
  assert.equal(g.els['rxt-difficulty'].value, 'normal');
  g.click('rxt-action-trigger');
  clock.advance(1499);
  assert.equal(g.board().label, 'Wait...');
  clock.advance(1);
  assert.equal(g.board().label, 'CLICK NOW');
  assert.equal(g.save().difficulty, 'normal');
});

test('reaction: corrupt or partial saves load without throwing and each bad field falls back (B4)', (t) => {
  const clock = controlTime(t);
  const fresh = { current: '0 ms', best: '--', average: '0 ms', attempts: '0', timer: '0.0s' };
  const cases = [
    ['{"difficulty":"constructor","attempts":0}', fresh],
    ['{"difficulty":"normal","bestReaction":200,"attempts":1,"totalReaction":200,"elapsed":"5"}',
      { current: '0 ms', best: '200 ms', average: '200 ms', attempts: '1', timer: '0.0s' }],
    ['{"difficulty":"hard","attempts":2,"totalReaction":400}',
      { current: '0 ms', best: '--', average: '200 ms', attempts: '2', timer: '0.0s' }],
    ['{"difficulty":"normal","bestReaction":200,"attempts":"3","totalReaction":600,"elapsed":1}',
      { current: '0 ms', best: '200 ms', average: '0 ms', attempts: '0', timer: '1.0s' }],
    ['{"bestReaction":"150","attempts":1.5,"totalReaction":-3,"elapsed":-2}', fresh],
    ['null', fresh], ['42', fresh], ['"x"', fresh], ['[]', fresh], ['true', fresh], ['', fresh]
  ];
  for (const [save, stats] of cases) {
    resetStubs();
    const g = boot({ save });
    assert.deepEqual(g.stats(), stats, save);
    // A round still works, with the Normal window unless the save says Hard.
    const delay = save.includes('hard') ? 1000 : 1500;
    g.press('Enter');
    clock.advance(delay - 1);
    assert.equal(g.board().mode, 'waiting', save);
    clock.advance(1);
    clock.advance(64);
    g.press(' ');
    assert.equal(g.board().label, '64 ms', save);
    assert.equal(g.text('rxt-attempts'), String(Number(stats.attempts) + 1), save);
    assert.notEqual(g.text('rxt-best-reaction'), 'undefined ms', save);
  }
});

test('reaction: unreadable storage still gives a playable game (B5)', (t) => {
  const clock = controlTime(t);
  t.mock.method(localStorage, 'getItem', () => { throw new Error('SecurityError'); });
  const g = boot();
  assert.equal(g.text('rxt-best-reaction'), '--', 'init ran to the end');
  playRound(g, clock, 210);
  assert.equal(g.text('rxt-attempts'), '1');
  // Leaving the page cannot tell whether another tab saved since, so it skips the save.
  t.mock.method(localStorage, 'setItem');
  setVisibility('hidden', t);
  window.dispatchEvent(createEvent('pagehide'));
  assert.equal(localStorage.setItem.mock.callCount(), 0);
});

test('reaction: blocked localStorage (the getter throws) still gives a playable game (B5)', (t) => {
  const clock = controlTime(t);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: access denied'); }
  });
  try {
    const g = boot();
    playRound(g, clock, 230);
    assert.equal(g.board().label, '230 ms');
    g.choose('easy');
    assert.equal(g.toast(), 'Difficulty updated');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', descriptor);
  }
});

test('reaction: a full storage only loses the save; the round ends and the next press is ignored (B5)', (t) => {
  const clock = controlTime(t);
  const g = boot();
  t.mock.method(localStorage, 'setItem', () => { throw new Error('QuotaExceededError'); });
  g.press('Enter');
  clock.advance(1500);
  clock.advance(150);
  g.press(' ');
  assert.deepEqual(g.board(), { mode: 'idle', label: '150 ms', pill: 'Completed' });
  clock.advance(500);
  g.press(' ');
  g.mouse();
  assert.equal(g.text('rxt-attempts'), '1');
  g.click('rxt-restart-game');
  assert.equal(g.board().label, 'Press Start');
});

test('reaction: nothing plays behind the Session Complete summary (B6)', (t) => {
  const clock = controlTime(t);
  const g = boot({ save: NINE_ROUNDS });
  const playAgain = g.els['rxt-overlay-button'];
  playRound(g, clock, 200);
  assert.equal(g.overlay(), true);
  assert.equal(g.text('rxt-overlay-text'), 'Average reaction: 200 ms | Best: 150 ms');
  assert.equal(document.activeElement, playAgain, 'focus moves to Play Again');

  // Enter and Start start no round; they hand the focus back to Play Again.
  // That Enter is cancelled, or the browser would let it click Play Again too.
  playAgain.blur();
  assert.equal(g.press('Enter').defaultPrevented, true);
  assert.equal(document.activeElement, playAgain, 'Enter');
  playAgain.blur();
  g.click('rxt-action-trigger');
  assert.equal(document.activeElement, playAgain, 'Start');
  playAgain.blur();
  clock.advance(5000);
  g.press(' ');
  g.mouse();
  g.touch();
  assert.deepEqual(g.board(), { mode: 'idle', label: '200 ms', pill: 'Completed' });
  assert.equal(g.text('rxt-attempts'), '10');
  assert.equal(g.overlay(), true);
  assert.equal(g.text('rxt-overlay-text'), 'Average reaction: 200 ms | Best: 150 ms');
  assert.equal(g.save().attempts, 10);

  // Enter on the focused Play Again button is the button's own click.
  playAgain.focus();
  g.press('Enter');
  assert.equal(g.overlay(), false);
  assert.equal(g.text('rxt-attempts'), '0');
});

test('reaction: the mouse press the game takes is cancelled, so the tenth leaves Play Again focused (B6)', (t) => {
  // The browser's default mousedown action focuses the board (tabindex 0);
  // after the tenth reaction it would pull the focus from Play Again to the
  // board behind the summary, where Space and Enter do nothing.
  const clock = controlTime(t);
  const g = boot({ save: NINE_ROUNDS });
  assert.equal(g.mouse().defaultPrevented, false, 'idle: the press focuses the board as usual');
  g.click('rxt-action-trigger');
  clock.advance(400);
  assert.equal(g.mouse().defaultPrevented, true, 'a false start: no text selection, no focus change');
  assert.equal(g.board().label, 'Too Early');
  g.click('rxt-action-trigger');
  clock.advance(1500);
  assert.equal(g.mouse('mousedown', 2).defaultPrevented, false, 'a right press is not the game\'s');
  clock.advance(170);
  assert.equal(g.mouse().defaultPrevented, true, 'the tenth reaction');
  assert.equal(g.overlay(), true);
  assert.equal(document.activeElement, g.els['rxt-overlay-button'], 'Play Again keeps the focus');
  assert.equal(g.mouse().defaultPrevented, false, 'the session is over: the press is not the game\'s');
});

test('reaction: a reload keeps a finished session finished without covering the page; Start or Enter bring the summary back (B6)', (t) => {
  const clock = controlTime(t);
  const g = boot({ save: '{"difficulty":"easy","bestReaction":140,"attempts":10,"totalReaction":1855,"elapsed":61.2}' });
  assert.equal(g.overlay(), false, 'no summary over the host page at load');
  assert.equal(document.activeElement, document.body, 'the focus is not taken');
  assert.deepEqual(g.board(), { mode: 'idle', label: 'Session Complete', pill: 'Completed' });
  assert.deepEqual(g.stats(), { current: '0 ms', best: '140 ms', average: '186 ms', attempts: '10', timer: '61.2s' });
  assert.equal(flushAnimationFrames(), 0, 'the timer stays stopped');
  g.els['rxt-board'].focus();
  g.press(' ');
  g.mouse();
  g.touch();
  clock.advance(5000);
  assert.equal(g.board().label, 'Session Complete', 'presses on the board start nothing');
  assert.equal(g.overlay(), false);

  assert.equal(g.press('Enter').defaultPrevented, true, 'the same key press does not also click Play Again');
  assert.equal(g.overlay(), true, 'Enter shows the summary');
  assert.equal(g.text('rxt-overlay-text'), 'Average reaction: 186 ms | Best: 140 ms');
  assert.equal(document.activeElement, g.els['rxt-overlay-button']);
  clock.advance(5000);
  assert.equal(g.board().label, 'Session Complete', 'and starts no round');
  assert.equal(g.save().attempts, 10);
  g.click('rxt-overlay-button');
  assert.equal(g.text('rxt-attempts'), '0');

  // Start does the same; an older save from the bug (more than 10 attempts) is finished as well.
  resetStubs();
  const old = boot({ save: '{"difficulty":"normal","bestReaction":12,"attempts":12,"totalReaction":2000,"elapsed":30}' });
  assert.equal(old.overlay(), false);
  old.click('rxt-action-trigger');
  assert.equal(old.overlay(), true, 'Start shows the summary');
  assert.equal(old.text('rxt-overlay-text'), 'Average reaction: 167 ms | Best: 12 ms');
  assert.equal(document.activeElement, old.els['rxt-overlay-button']);
  assert.equal(old.board().label, 'Session Complete');
});

test('reaction: New Game and Restart close the summary along with the old session (V1)', (t) => {
  const clock = controlTime(t);
  for (const id of ['rxt-restart-game', 'rxt-new-game']) {
    resetStubs();
    const g = boot({ save: NINE_ROUNDS });
    playRound(g, clock, 200);
    assert.equal(g.overlay(), true);
    g.els[id].focus();
    g.press('Enter');
    assert.equal(g.overlay(), false, id + ' hides the summary');
    assert.equal(g.text('rxt-attempts'), '0');
    assert.equal(g.board().label, id === 'rxt-new-game' ? 'Wait...' : 'Press Start');
  }
});

test('reaction: Space scrolls the host page while idle, and only the game swallows it (V2)', (t) => {
  const clock = controlTime(t);
  const g = boot();
  assert.equal(g.press(' ').defaultPrevented, false, 'idle, focus on the page');
  g.els['rxt-board'].focus();
  assert.equal(g.press(' ').defaultPrevented, true, 'Space on the focused board never scrolls');
  document.activeElement = document.body;
  g.press('Enter');
  assert.equal(g.press(' ').defaultPrevented, true, 'a false start');
  g.press('Enter');
  clock.advance(1500);
  assert.equal(g.press(' ').defaultPrevented, true, 'a reaction');
  assert.equal(g.press(' ').defaultPrevented, false, 'idle again');
});

test('reaction: the session timer resumes after a reload and is saved when the page hides (B7)', (t) => {
  const clock = controlTime(t, 1000);
  const g = boot({ save: '{"difficulty":"hard","bestReaction":200,"attempts":3,"totalReaction":700,"elapsed":42.5}' });
  assert.equal(g.text('rxt-timer'), '42.5s');
  flushAnimationFrames(1300);
  assert.equal(g.text('rxt-timer'), '42.8s', 'the timer goes on from the saved time');

  clock.now = 6000;
  setVisibility('hidden', t);
  assert.equal(g.save().elapsed, 47.5, 'hiding the tab saves the time');
  clock.now = 6500;
  setVisibility('visible', t);
  assert.equal(g.save().elapsed, 47.5, 'showing it again saves nothing');
  clock.now = 7000;
  const again = reload();   // fires pagehide first
  assert.equal(again.text('rxt-timer'), '48.5s');
  flushAnimationFrames(7250);
  assert.equal(again.text('rxt-timer'), '48.8s');
});

test('reaction: hiding or closing a tab never overwrites what another tab of the game saved since', (t) => {
  // Two tabs: this one idles while the other plays and saves.  Saving this
  // tab's stale session on hide or close would wipe the other tab's progress.
  const clock = controlTime(t);
  const g = boot({ save: BASELINE_SAVE });
  const newer = '{"difficulty":"hard","bestReaction":18,"attempts":3,"totalReaction":383,"elapsed":20}';
  localStorage.setItem(KEY, newer);   // the other tab's save
  clock.now += 5000;
  setVisibility('visible', t);
  setVisibility('hidden', t);
  window.dispatchEvent(createEvent('pagehide'));
  assert.equal(localStorage.getItem(KEY), newer, 'the newer save is kept');
  assert.equal(g.text('rxt-attempts'), '2', 'this tab plays on with its own session');

  // Reopened (the old page's pagehide skips the save as well) on a full
  // storage, so the cleaned save cannot be written back at load.
  window.dispatchEvent(createEvent('pagehide'));
  assert.equal(localStorage.getItem(KEY), newer);
  resetStubs();
  localStorage.setItem(KEY, newer);
  const full = t.mock.method(localStorage, 'setItem', () => { throw new Error('QuotaExceededError'); });
  const reopened = boot();
  full.mock.restore();
  assert.deepEqual(reopened.stats(), { current: '0 ms', best: '18 ms', average: '128 ms', attempts: '3', timer: '20.0s' });
  // The tab that read the save last owns it: hiding it saves the time again.
  clock.now += 2000;
  setVisibility('hidden', t);
  assert.equal(reopened.save().elapsed, 22);
});

test('reaction: the timer never shows -0.0s after a restart (B8)', (t) => {
  const clock = controlTime(t, 1000);
  const g = boot();
  clock.now = 2000;
  g.click('rxt-restart-game');
  flushAnimationFrames(1999.9);   // a frame stamped just before the click
  assert.equal(g.text('rxt-timer'), '0.0s');
});

test('reaction: a second toast stays its full 2.2 s (B9)', (t) => {
  const clock = controlTime(t);
  const g = boot();
  g.choose('hard');
  clock.advance(1800);
  g.choose('easy');
  clock.advance(600);
  assert.equal(g.toast(), 'Difficulty updated', 'the first toast timer does not hide the second toast');
  clock.advance(1599);
  assert.equal(g.toast(), 'Difficulty updated');
  clock.advance(1);
  assert.equal(g.toast(), null);
});

test('reaction: keypad Enter and a key-only Space work; modifier combos and auto-repeat do not (B10)', (t) => {
  const clock = controlTime(t);
  const g = boot();
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
    g.press('Enter', { [mod]: true });
    assert.equal(g.board().label, 'Press Start', mod + '+Enter');
  }
  g.press('Enter', { code: 'NumpadEnter' });
  assert.equal(g.board().label, 'Wait...', 'keypad Enter starts a round');
  clock.advance(1500);
  g.press(' ', { altKey: true });
  g.press(' ', { repeat: true });
  assert.equal(g.board().label, 'CLICK NOW', 'Alt+Space and a held Space do not react');
  clock.advance(90);
  g.press(' ', { code: '' });
  assert.equal(g.board().label, '90 ms', 'Space recognised by its key alone');
  g.press('Enter', { repeat: true });
  assert.equal(g.board().label, '90 ms', 'a held Enter does not start the next round');
  g.press('Enter', { code: '' });
  assert.equal(g.board().label, 'Wait...', 'Enter recognised by its key alone');
  g.press(' ');
  assert.equal(g.board().label, 'Too Early');

  // Keyboards that report no key value are matched by the physical key.
  for (const code of ['NumpadEnter', 'Enter']) {
    g.press(undefined, { code });
    assert.equal(g.board().label, 'Wait...', 'key-less ' + code);
    g.press(undefined, { code: 'Space' });
    assert.equal(g.board().label, 'Too Early', 'key-less Space');
  }
  g.press('Tab');
  g.press(undefined);
  assert.equal(g.board().label, 'Too Early', 'other keys do nothing');
});
