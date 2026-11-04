// tests/reaction-time.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScript, stubElement, flushAnimationFrames, resetStubs } = require('./_setup');

const DIR = path.join(__dirname, '..', 'reaction-time');
const STORAGE_KEY = 'rxt-reaction-state';

// Every id script.js looks up, read from the script itself so a renamed id
// fails the markup test below.
const SCRIPT_SRC = fs.readFileSync(path.join(DIR, 'script.js'), 'utf8');
const IDS = Array.from(SCRIPT_SRC.matchAll(/getElementById\('([^']+)'\)/g), (m) => m[1]);

// Load a fresh copy of the game with stub elements behind document.getElementById
// (the script reads its elements once, at load time).  The elements record their
// listeners, and document.addEventListener is captured while init() runs, so a
// test can click buttons and press keys the way a browser would.
function loadGame() {
  const els = {};
  IDS.forEach((id) => {
    const el = stubElement(id === 'rxt-difficulty' ? 'select' : 'div');
    el.id = id;
    el.listeners = {};
    el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
    els[id] = el;
  });
  els['rxt-board'].className = 'rxt-board rxt-board-idle';
  els['rxt-difficulty'].value = 'normal';

  const docListeners = {};
  const originalGet = document.getElementById;
  document.getElementById = (id) => els[id] || null;
  let game;
  try {
    game = loadScript('reaction-time/script.js');
  } finally {
    document.getElementById = originalGet;
  }

  function init() {
    const originalAdd = document.addEventListener;
    document.addEventListener = (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); };
    try {
      game.rxtInit();
    } finally {
      document.addEventListener = originalAdd;
    }
  }

  function fire(id, type) {
    (els[id].listeners[type] || []).forEach((fn) => fn({ type: type }));
  }

  function press(code) {
    let prevented = false;
    const ev = { type: 'keydown', code: code, preventDefault: () => { prevented = true; } };
    (docListeners.keydown || []).forEach((fn) => fn(ev));
    return prevented;
  }

  const text = (id) => String(els[id].textContent);
  const has = (id, cls) => els[id].classList.contains(cls);

  return { game, els, init, fire, press, text, has };
}

// performance.now, setTimeout and Math.random under test control.
function controlTime(t, start) {
  const clock = { now: start === undefined ? 1000 : start };
  t.mock.method(performance, 'now', () => clock.now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return clock;
}

// One successful round of `ms` milliseconds: start, wait out the random delay,
// then react.  Math.random() = 0 makes the delay the difficulty's minimum.
function playRound(g, t, clock, ms) {
  g.game.rxtStartRound();
  const delay = g.game.rxtGetDelay();
  t.mock.timers.tick(delay);
  clock.now += ms;
  g.game.rxtHandleBoardInteraction();
}

test.beforeEach(() => {
  resetStubs();
});

test('reaction-time: index.html has every element id the script looks up', () => {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  assert.equal(IDS.length, 18);
  IDS.forEach((id) => {
    assert.ok(html.includes('id="' + id + '"'), 'index.html is missing id="' + id + '"');
  });
  assert.ok(html.indexOf('<div class="rxt-wrapper"') < html.indexOf('<script src="script.js"></script>'));
});

test('reaction-time: sources are safe inside a block comment and touch no bare html/body', () => {
  // The publishing tool copies style.css, script.js and the index.html part from
  // the wrapper up to the <script> tag into one <!-- wp:vahac/tool-embed --> comment.
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const embedded = {
    'style.css': fs.readFileSync(path.join(DIR, 'style.css'), 'utf8'),
    'script.js': SCRIPT_SRC,
    'index.html (wrapper)': html.slice(html.indexOf('<div class="rxt-wrapper"'), html.indexOf('<script'))
  };
  for (const [name, src] of Object.entries(embedded)) {
    for (const bad of ['<!--', '-->', '</script']) {
      assert.equal(src.toLowerCase().includes(bad), false, name + ' contains ' + bad);
    }
  }
  assert.equal(/^\s*(html|body)\b[^{]*\{/m.test(embedded['style.css']), false);
});

test('reaction-time: opened on its own, the page has no margin and the wrapper background, kept out of the embed', () => {
  const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

  // Without this rule the body is transparent with the browser's 8px margin: light
  // text vanishes in a light browser theme and a white frame shows round the game.
  const bg = css.match(/--rxt-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));

  // build-embed copies the markup from the wrapper up to the first <script> only,
  // so the body rule never reaches WordPress.
  const embedded = html.slice(html.indexOf('<div class="rxt-wrapper"'), html.indexOf('<script'));
  assert.equal(/<style/i.test(embedded), false, 'no <style> in the embedded markup');
});

test('reaction-time: loading under Node does not start the game', () => {
  const g = loadGame();
  assert.equal(g.game.rxtState.status, 'idle');
  assert.equal(g.game.rxtState.sessionStart, null);
  assert.equal(flushAnimationFrames(), 0, 'no timer frame was requested');
  assert.equal(localStorage.getItem(STORAGE_KEY), null, 'nothing was saved');
});

test('reaction-time: random delay stays inside each difficulty window', (t) => {
  const g = loadGame();
  const windows = { easy: [2000, 4500], normal: [1500, 3500], hard: [1000, 2500], extreme: [600, 1600] };
  let r = 0;
  t.mock.method(Math, 'random', () => r);
  for (const [level, [min, max]] of Object.entries(windows)) {
    g.game.rxtState.difficulty = level;
    r = 0;
    assert.equal(g.game.rxtGetDelay(), min, level + ' minimum');
    r = 0.999999;
    assert.equal(g.game.rxtGetDelay(), max - 1, level + ' maximum is exclusive');
    r = 0.5;
    assert.equal(g.game.rxtGetDelay(), (min + max) / 2, level + ' midpoint');
  }
});

test('reaction-time: a click before the signal is a false start and counts nothing', (t) => {
  const clock = controlTime(t);
  t.mock.method(Math, 'random', () => 0);
  const g = loadGame();
  g.init();

  g.fire('rxt-action-trigger', 'click');
  assert.equal(g.game.rxtState.status, 'waiting');
  assert.ok(g.has('rxt-board', 'rxt-board-waiting'));
  assert.equal(g.text('rxt-board-label'), 'Wait...');
  assert.equal(g.text('rxt-status-pill'), 'Waiting');

  clock.now += 500;
  g.fire('rxt-board', 'click');
  assert.equal(g.text('rxt-board-label'), 'Too Early');
  assert.equal(g.text('rxt-status-pill'), 'Fault');
  assert.ok(g.has('rxt-board', 'rxt-board-failed'));
  assert.equal(g.has('rxt-board', 'rxt-board-waiting'), false);
  assert.equal(g.text('rxt-toast'), 'False start detected');
  assert.equal(g.game.rxtState.attempts, 0);

  // The pending signal was cancelled: waiting out the longest delay changes nothing.
  t.mock.timers.tick(3500);
  assert.equal(g.game.rxtState.status, 'idle');
  assert.equal(g.text('rxt-board-label'), 'Too Early');
  assert.equal(g.text('rxt-attempts'), '0');
});

test('reaction-time: reacting to the signal measures and records the time', (t) => {
  const clock = controlTime(t);
  t.mock.method(Math, 'random', () => 0);
  const g = loadGame();
  g.init();

  g.press('Enter');
  assert.equal(g.game.rxtState.status, 'waiting');
  t.mock.timers.tick(1499);
  assert.equal(g.game.rxtState.status, 'waiting', 'normal waits at least 1500 ms');
  t.mock.timers.tick(1);
  assert.equal(g.game.rxtState.status, 'active');
  assert.equal(g.text('rxt-board-label'), 'CLICK NOW');
  assert.equal(g.text('rxt-status-pill'), 'GO');
  assert.ok(g.has('rxt-board', 'rxt-board-active'));

  clock.now += 237.4;
  assert.equal(g.press('Space'), true, 'Space is swallowed so the page does not scroll');
  assert.equal(g.text('rxt-board-label'), '237 ms');
  assert.equal(g.text('rxt-status-pill'), 'Completed');
  assert.equal(g.text('rxt-current-reaction'), '237 ms');
  assert.equal(g.text('rxt-best-reaction'), '237 ms');
  assert.equal(g.text('rxt-average-reaction'), '237 ms');
  assert.equal(g.text('rxt-attempts'), '1');
  assert.equal(g.text('rxt-toast'), 'New best reaction time!');
  assert.ok(g.has('rxt-toast', 'rxt-toast-visible'));
  t.mock.timers.tick(2200);
  assert.equal(g.has('rxt-toast', 'rxt-toast-visible'), false, 'toast hides after 2.2 s');
});

test('reaction-time: best only improves, average is the rounded mean', (t) => {
  const clock = controlTime(t);
  t.mock.method(Math, 'random', () => 0);
  const g = loadGame();
  g.init();

  playRound(g, t, clock, 300);
  t.mock.timers.tick(2200);
  playRound(g, t, clock, 250);
  t.mock.timers.tick(2200);
  playRound(g, t, clock, 281);

  assert.equal(g.game.rxtState.bestReaction, 250);
  assert.equal(g.text('rxt-best-reaction'), '250 ms');
  assert.equal(g.text('rxt-current-reaction'), '281 ms');
  assert.equal(g.text('rxt-average-reaction'), '277 ms', 'round(831 / 3)');
  assert.equal(g.text('rxt-attempts'), '3');
  assert.equal(g.has('rxt-toast', 'rxt-toast-visible'), false, 'a slower round shows no toast');
});

test('reaction-time: clicking the board while idle does nothing', (t) => {
  controlTime(t);
  const g = loadGame();
  g.init();
  const before = ['rxt-board-label', 'rxt-status-pill', 'rxt-attempts', 'rxt-toast'].map(g.text);
  g.fire('rxt-board', 'click');
  g.fire('rxt-board', 'touchstart');
  g.press('Space');
  assert.equal(g.game.rxtState.status, 'idle');
  assert.equal(g.game.rxtState.attempts, 0);
  assert.deepEqual(['rxt-board-label', 'rxt-status-pill', 'rxt-attempts', 'rxt-toast'].map(g.text), before);
  assert.ok(g.has('rxt-board', 'rxt-board-idle'));
  assert.equal(g.text('rxt-best-reaction'), '--');
});

test('reaction-time: the tenth success ends the session and stops the timer', (t) => {
  const clock = controlTime(t);
  t.mock.method(Math, 'random', () => 0);
  const g = loadGame();
  g.init();

  const times = [210, 190, 250, 230, 205, 300, 180, 220, 240, 260];
  times.slice(0, 9).forEach((ms) => { playRound(g, t, clock, ms); t.mock.timers.tick(2200); });
  assert.equal(g.has('rxt-overlay', 'rxt-overlay-visible'), false, 'nine rounds are not a session');

  playRound(g, t, clock, times[9]);
  assert.ok(g.has('rxt-overlay', 'rxt-overlay-visible'));
  assert.equal(g.text('rxt-overlay-title'), 'Session Complete');
  assert.equal(g.text('rxt-overlay-text'), 'Average reaction: 229 ms | Best: 180 ms');
  assert.equal(flushAnimationFrames(), 0, 'the session timer frame was cancelled');

  g.fire('rxt-overlay-button', 'click');
  assert.equal(g.has('rxt-overlay', 'rxt-overlay-visible'), false);
  assert.equal(g.text('rxt-attempts'), '0');
  assert.equal(g.text('rxt-best-reaction'), '--');
});

test('reaction-time: Restart clears the session and cancels a pending signal', (t) => {
  const clock = controlTime(t);
  t.mock.method(Math, 'random', () => 0);
  const g = loadGame();
  g.init();

  playRound(g, t, clock, 222);
  g.game.rxtStartRound();
  g.fire('rxt-restart-game', 'click');

  assert.equal(g.game.rxtState.status, 'idle');
  assert.equal(g.text('rxt-board-label'), 'Press Start');
  assert.equal(g.text('rxt-status-pill'), 'Ready');
  assert.equal(g.text('rxt-current-reaction'), '0 ms');
  assert.equal(g.text('rxt-best-reaction'), '--', 'restart also forgets the best time');
  assert.equal(g.text('rxt-average-reaction'), '0 ms');
  t.mock.timers.tick(3500);
  assert.equal(g.game.rxtState.status, 'idle', 'the signal never fires');
  assert.deepEqual(JSON.parse(localStorage.getItem(STORAGE_KEY)), {
    difficulty: 'normal', bestReaction: null, attempts: 0, totalReaction: 0, elapsed: 0
  });
});

test('reaction-time: New Game resets and starts a round straight away', (t) => {
  const clock = controlTime(t);
  t.mock.method(Math, 'random', () => 0);
  const g = loadGame();
  g.init();
  playRound(g, t, clock, 200);
  g.fire('rxt-new-game', 'click');
  assert.equal(g.game.rxtState.attempts, 0);
  assert.equal(g.game.rxtState.status, 'waiting');
  assert.equal(g.text('rxt-board-label'), 'Wait...');
});

test('reaction-time: stats survive a reload through localStorage', (t) => {
  const clock = controlTime(t);
  t.mock.method(Math, 'random', () => 0);
  const first = loadGame();
  first.init();
  first.els['rxt-difficulty'].value = 'hard';
  first.fire('rxt-difficulty', 'change');
  playRound(first, t, clock, 190);
  t.mock.timers.tick(2200);
  playRound(first, t, clock, 175);

  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  assert.deepEqual(Object.keys(saved), ['difficulty', 'bestReaction', 'attempts', 'totalReaction', 'elapsed']);
  assert.equal(saved.difficulty, 'hard');
  assert.equal(saved.bestReaction, 175);
  assert.equal(saved.attempts, 2);
  assert.equal(saved.totalReaction, 365);

  const second = loadGame();
  second.init();
  assert.equal(second.els['rxt-difficulty'].value, 'hard');
  assert.equal(second.text('rxt-best-reaction'), '175 ms');
  assert.equal(second.text('rxt-average-reaction'), '183 ms', 'round(365 / 2)');
  assert.equal(second.text('rxt-attempts'), '2');
  assert.equal(second.text('rxt-current-reaction'), '0 ms', 'the last reaction is not stored');
  assert.equal(second.game.rxtGetDelay(), 1000, 'hard difficulty is back in force');
});

test('reaction-time: missing or broken saved state falls back to defaults', (t) => {
  t.mock.method(console, 'error', () => {});
  localStorage.setItem(STORAGE_KEY, '{"difficulty":"","attempts":0}');
  let g = loadGame();
  g.game.rxtLoadState();
  assert.equal(g.game.rxtState.difficulty, 'normal');
  assert.equal(g.game.rxtState.attempts, 0);
  assert.equal(g.game.rxtState.totalReaction, 0);

  localStorage.setItem(STORAGE_KEY, '{not json');
  g = loadGame();
  g.game.rxtLoadState();
  assert.equal(console.error.mock.callCount(), 1, 'the parse error is logged');
  assert.equal(g.game.rxtState.difficulty, 'normal');
  assert.equal(g.game.rxtState.bestReaction, null);
});

test('reaction-time: the session timer counts from init in tenths of a second', (t) => {
  controlTime(t, 1000);
  const g = loadGame();
  g.init();
  assert.equal(g.text('rxt-timer'), '0.0s');
  assert.equal(flushAnimationFrames(3500), 1);
  assert.equal(g.text('rxt-timer'), '2.5s');
  assert.equal(flushAnimationFrames(13000), 1, 'the timer keeps requesting frames');
  assert.equal(g.text('rxt-timer'), '12.0s');
});
