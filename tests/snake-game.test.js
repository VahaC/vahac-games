// tests/snake-game.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, stubElement, resetStubs, flushAnimationFrames } = require('./_setup');

// snake-game/script.js looks up its elements as soon as it loads (as the staging
// page does), so hand out one stub per id, set up like the markup in index.html.
// Every stub (and document) records its listeners so a test that runs snpInit
// (see boot) can click buttons and press keys through fire().
const elements = {};
const listeners = new Map();

function recordListeners(target) {
  target.addEventListener = (type, fn) => {
    if (!listeners.has(target)) listeners.set(target, {});
    const byType = listeners.get(target);
    (byType[type] = byType[type] || []).push(fn);
  };
}

function fire(target, type, event) {
  const fns = (listeners.get(target) || {})[type] || [];
  assert.ok(fns.length, 'no ' + type + ' listener on ' + (target.id || 'document'));
  fns.forEach((fn) => fn(event || {}));
}

// A keydown as a browser sends it: the target is the focused element (the
// page body when nothing has the focus), no modifier keys unless given, and
// preventDefault() marks the default action cancelled.
function keyEvent(key, extra) {
  return Object.assign({
    key,
    target: document.body,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
  }, extra);
}

// A key pressed on the page: the document keydown listener runs, then, unless
// it cancelled the default action, the browser's own default runs too: Enter
// or Space on a focused button clicks that button. Returns the event.
function press(key, extra) {
  const event = keyEvent(key, extra);
  fire(document, 'keydown', event);
  const onButton = event.target && event.target.tagName === 'BUTTON';
  if (!event.defaultPrevented && onButton && (key === 'Enter' || key === ' ')) {
    fire(event.target, 'click');
  }
  return event;
}

const BUTTON_IDS = [
  'snp-new-game', 'snp-restart-game', 'snp-pause-game', 'snp-overlay-button',
  'snp-up', 'snp-down', 'snp-left', 'snp-right'
];

function makeElement(id) {
  const tag = id === 'snp-game-canvas' ? 'canvas'
    : id === 'snp-speed-select' ? 'select'
      : BUTTON_IDS.includes(id) ? 'button' : 'div';
  const el = stubElement(tag);
  el.id = id;
  if (id === 'snp-game-canvas') {
    el.width = 600;
    el.height = 600;
  }
  if (id === 'snp-speed-select') el.value = '120';
  if (id === 'snp-overlay') el.className = 'snp-overlay snp-hidden';
  if (id === 'snp-toast') el.className = 'snp-toast snp-hidden';
  if (id === 'snp-pause-game') {
    el.textContent = 'Start';
    el.setAttribute('aria-label', 'Start game');
  }
  if (id === 'snp-start-hint') el.className = 'snp-start-hint snp-hidden';
  recordListeners(el);
  return el;
}
recordListeners(document);

document.getElementById = (id) => {
  if (!elements[id]) elements[id] = makeElement(id);
  return elements[id];
};

const snp = loadScript('snake-game/script.js');
const S = snp.snpState;
const KEY = 'snp-snake-state';
const $ = (id) => document.getElementById(id);
const hidden = (id) => $(id).classList.contains('snp-hidden');
const cells = (list) => list.map(([x, y]) => ({ x, y }));
const saved = () => JSON.parse(localStorage.getItem(KEY));
const START = cells([[15, 15], [14, 15], [13, 15]]);
const UP = { x: 0, y: -1 };
const DOWN = { x: 0, y: 1 };
const RIGHT = { x: 1, y: 0 };

// The Pause/Resume button's visible text and aria-label.
const pauseButton = () => [$('snp-pause-game').textContent, $('snp-pause-game').getAttribute('aria-label')];

// A new or restored game holds still behind the start prompt.
function assertWaiting(label) {
  assert.equal(S.paused, true, label);
  assert.equal(S.waiting, true, label);
  assert.equal(hidden('snp-start-hint'), false, label);
  assert.deepEqual(pauseButton(), ['Start', 'Start game'], label);
}

function assertRunning(label) {
  assert.equal(S.paused, false, label);
  assert.equal(S.waiting, false, label);
  assert.equal(hidden('snp-start-hint'), true, label);
  assert.deepEqual(pauseButton(), ['Pause', 'Pause game'], label);
}

// Fresh game for each test: empty storage, mocked setTimeout (the toast hides
// after 2.2 s; mocks are enabled once per test), a hidden toast with no pending
// timer from an earlier test, then a reset with food parked away from the action.
const mockedTimers = new WeakSet();
function fresh(t) {
  resetStubs();
  if (!mockedTimers.has(t)) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockedTimers.add(t);
  }
  delete $('snp-toast').timeout;
  $('snp-toast').classList.add('snp-hidden');
  $('snp-speed-select').value = '120';
  snp.snpReset();
  S.bestScore = 0;
  S.food = { x: 25, y: 25 };
}

function place(snake, dir, food) {
  S.snake = cells(snake);
  S.direction = { x: dir[0], y: dir[1] };
  S.nextDirection = S.direction;
  S.food = { x: food[0], y: food[1] };
  S.gameOver = false;
  S.paused = false;
  S.waiting = false;
}

// A real page start: the game state back to its page-load defaults, the given
// save (if any) in storage, setInterval (game and timer loops) and setTimeout
// (toast) mocked, and snpInit run with fresh listeners. play(t, ms) then lets
// the loops run for ms. Use boot or fresh in a test, not both (timers are
// mocked once per test).
function boot(t, save) {
  resetStubs();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  listeners.clear();
  delete $('snp-toast').timeout;
  $('snp-toast').classList.add('snp-hidden');
  $('snp-overlay').classList.add('snp-hidden');
  $('snp-start-hint').classList.add('snp-hidden');
  $('snp-pause-game').textContent = 'Start';
  $('snp-pause-game').setAttribute('aria-label', 'Start game');
  $('snp-speed-select').value = '120';
  Object.assign(S, {
    snake: [], direction: RIGHT, nextDirection: RIGHT, food: { x: 10, y: 10 },
    score: 0, bestScore: 0, timer: 0, gameOver: false, paused: false, waiting: false,
    speed: 120, loop: null, timerLoop: null
  });
  if (save) localStorage.setItem(KEY, JSON.stringify(save));
  snp.snpInit();
}

function play(t, ms) {
  t.mock.timers.tick(ms);
  flushAnimationFrames();
}

// Math.random returning the given values in order.
function randomSequence(t, values) {
  let i = 0;
  return t.mock.method(Math, 'random', () => {
    if (i >= values.length) throw new Error('Math.random called more often than expected');
    return values[i++];
  });
}

test('snake: loading under Node starts no game, timer or frame', () => {
  assert.deepEqual(S.snake, []);
  assert.equal(S.loop, null);
  assert.equal(S.timerLoop, null);
  assert.equal(localStorage.getItem(KEY), null);
  assert.equal(flushAnimationFrames(), 0);
  assert.equal(snp.snpTileCount, 30);
});

test('snake: reset builds a 3-segment snake heading right and saves it', (t) => {
  resetStubs();
  Object.assign(S, { score: 70, timer: 99, gameOver: true, paused: true, bestScore: 120 });
  $('snp-overlay').classList.remove('snp-hidden');
  $('snp-speed-select').value = '85';
  // First draw lands on the head (15,15), second on (3,6).
  const random = randomSequence(t, [0.5, 0.5, 0.1, 0.2]);

  snp.snpReset();

  assert.deepEqual(S.snake, cells([[15, 15], [14, 15], [13, 15]]));
  assert.deepEqual(S.direction, { x: 1, y: 0 });
  assert.deepEqual(S.nextDirection, { x: 1, y: 0 });
  assert.deepEqual(S.food, { x: 3, y: 6 });
  assert.equal(random.mock.callCount(), 4);
  assert.equal(S.score, 0);
  assert.equal(S.timer, 0);
  assert.equal(S.bestScore, 120, 'reset keeps the best score');
  assert.equal(S.gameOver, false);
  assertWaiting('a new game waits for the first direction');
  assert.equal(saved().paused, true);
  assert.equal(S.speed, 85, 'speed comes from the difficulty select');
  assert.equal(hidden('snp-overlay'), true);
  assert.equal($('snp-score').textContent, '0');
  assert.equal($('snp-best-score').textContent, '120');
  assert.equal($('snp-timer').textContent, '00:00');
  assert.deepEqual(saved().snake, S.snake);
  assert.equal(saved().speed, 85);
});

test('snake: a tick moves the head one tile, drops the tail and draws the board', (t) => {
  fresh(t);
  place([[5, 5], [4, 5], [3, 5]], [1, 0], [20, 20]);
  const ctx = $('snp-game-canvas').getContext('2d');
  const rects = [];
  const arcs = [];
  t.mock.method(ctx, 'fillRect', (x, y, w, h) => rects.push([ctx.fillStyle, x, y, w, h]));
  t.mock.method(ctx, 'arc', (x, y, r) => arcs.push([x, y, r]));

  snp.snpGameTick();

  assert.deepEqual(S.snake, cells([[6, 5], [5, 5], [4, 5]]));
  assert.equal(S.score, 0);
  assert.equal(S.gameOver, false);
  assert.deepEqual(saved().snake, S.snake);
  // 30x30 checkerboard of 20 px tiles, then one 16 px square per segment, head in cyan.
  assert.equal(rects.length, 900 + 3);
  assert.deepEqual(rects[0], ['#0f172a', 0, 0, 20, 20]);
  assert.deepEqual(rects[1], ['#111c34', 0, 20, 20, 20]);
  assert.deepEqual(rects[900], ['#22d3ee', 6 * 20 + 2, 5 * 20 + 2, 16, 16]);
  assert.deepEqual(rects[901], ['#3b82f6', 5 * 20 + 2, 5 * 20 + 2, 16, 16]);
  assert.deepEqual(arcs, [[20 * 20 + 10, 20 * 20 + 10, 8]]);
  assert.equal(ctx.shadowBlur, 0, 'glow is switched off after drawing');
});

test('snake: eating food grows the snake, scores 10, respawns food and toasts', (t) => {
  fresh(t);
  place([[5, 5], [4, 5], [3, 5]], [1, 0], [6, 5]);
  randomSequence(t, [0.9, 0.9]);

  snp.snpGameTick();

  assert.deepEqual(S.snake, cells([[6, 5], [5, 5], [4, 5], [3, 5]]));
  assert.equal(S.score, 10);
  assert.equal(S.bestScore, 10);
  assert.deepEqual(S.food, { x: 27, y: 27 });
  assert.equal($('snp-score').textContent, '10');
  assert.equal($('snp-best-score').textContent, '10');
  assert.equal(saved().score, 10);
  assert.equal($('snp-toast').textContent, 'Energy node acquired +10');
  assert.equal(hidden('snp-toast'), false);
  t.mock.timers.tick(2199);
  assert.equal(hidden('snp-toast'), false);
  t.mock.timers.tick(1);
  assert.equal(hidden('snp-toast'), true);
});

test('snake: the best score only goes up', (t) => {
  fresh(t);
  S.bestScore = 50;
  place([[5, 5], [4, 5], [3, 5]], [1, 0], [6, 5]);
  randomSequence(t, [0.9, 0.9]);

  snp.snpGameTick();

  assert.equal(S.score, 10);
  assert.equal(S.bestScore, 50);
});

test('snake: hitting any wall ends the game and shows the overlay', (t) => {
  const walls = [
    { snake: [[29, 10], [28, 10]], dir: [1, 0] },
    { snake: [[0, 10], [1, 10]], dir: [-1, 0] },
    { snake: [[10, 0], [10, 1]], dir: [0, -1] },
    { snake: [[10, 29], [10, 28]], dir: [0, 1] }
  ];
  for (const wall of walls) {
    fresh(t);
    place(wall.snake, wall.dir, [20, 20]);

    snp.snpGameTick();

    assert.equal(S.gameOver, true, JSON.stringify(wall));
    assert.deepEqual(S.snake, cells(wall.snake), 'the crashing head is not added');
    assert.equal(hidden('snp-overlay'), false);
    assert.equal($('snp-overlay-title').textContent, 'System Failure');
    assert.equal($('snp-overlay-text').textContent, 'Snake crashed into the cyber grid.');
    assert.equal(saved().gameOver, true);
  }
  // A finished game no longer moves.
  snp.snpGameTick();
  assert.deepEqual(S.snake, cells(walls[3].snake));
});

test('snake: running into its own body ends the game, the tail cell included', (t) => {
  fresh(t);
  // Head (5,5) turns down into the body segment at (5,6).
  place([[5, 5], [6, 5], [6, 6], [5, 6], [4, 6]], [0, 1], [20, 20]);
  snp.snpGameTick();
  assert.equal(S.gameOver, true);

  // A 2x2 loop: the tail (5,6) would move away this tick, but the staging rules
  // count it as a collision anyway.
  fresh(t);
  place([[5, 5], [6, 5], [6, 6], [5, 6]], [0, 1], [20, 20]);
  snp.snpGameTick();
  assert.equal(S.gameOver, true);
});

test('snake: direction changes wait for the next tick and cannot reverse', (t) => {
  fresh(t);
  place([[5, 5], [4, 5], [3, 5]], [1, 0], [20, 20]);

  snp.snpSetDirection(-1, 0);
  assert.deepEqual(S.nextDirection, { x: 1, y: 0 }, 'left is a reversal of right');

  snp.snpSetDirection(0, -1);
  assert.deepEqual(S.nextDirection, { x: 0, y: -1 });
  assert.deepEqual(S.direction, { x: 1, y: 0 }, 'not applied before the tick');

  // Still checked against the direction in force, so up-then-left in one tick
  // cannot fold the snake back onto itself.
  snp.snpSetDirection(-1, 0);
  assert.deepEqual(S.nextDirection, { x: 0, y: -1 });

  snp.snpGameTick();
  assert.deepEqual(S.direction, { x: 0, y: -1 });
  assert.deepEqual(S.snake[0], { x: 5, y: 4 });
  assert.equal(S.gameOver, false);
});

test('snake: keys steer, P pauses, Enter starts over; capitals are ignored', (t) => {
  fresh(t);
  place([[5, 5], [4, 5], [3, 5]], [1, 0], [20, 20]);

  snp.snpHandleKeydown(keyEvent('s'));
  assert.deepEqual(S.nextDirection, { x: 0, y: 1 });
  snp.snpHandleKeydown(keyEvent('ArrowUp'));
  assert.deepEqual(S.nextDirection, { x: 0, y: -1 });
  snp.snpHandleKeydown(keyEvent('D'));
  snp.snpHandleKeydown(keyEvent('S'));
  assert.deepEqual(S.nextDirection, { x: 0, y: -1 }, 'only lower-case WASD is read');

  snp.snpHandleKeydown(keyEvent('p'));
  assert.equal(S.paused, true);
  assert.equal($('snp-pause-game').textContent, 'Resume');
  assert.equal($('snp-toast').textContent, 'Simulation paused');
  snp.snpHandleKeydown(keyEvent('p'));
  assert.equal(S.paused, false);
  assert.equal($('snp-pause-game').textContent, 'Pause');
  assert.equal($('snp-toast').textContent, 'Simulation resumed');

  S.score = 40;
  snp.snpHandleKeydown(keyEvent('Enter'));
  assert.equal(S.score, 0);
  assert.deepEqual(S.snake, START);
  assertWaiting('Enter starts a new game that waits');
});

test('snake: pause freezes the snake; a finished game cannot be paused', (t) => {
  fresh(t);
  place([[5, 5], [4, 5], [3, 5]], [1, 0], [20, 20]);

  snp.snpTogglePause();
  snp.snpGameTick();
  assert.deepEqual(S.snake, cells([[5, 5], [4, 5], [3, 5]]));
  assert.equal(saved().paused, true);
  snp.snpTogglePause();
  snp.snpGameTick();
  assert.deepEqual(S.snake[0], { x: 6, y: 5 });

  S.gameOver = true;
  snp.snpTogglePause();
  assert.equal(S.paused, false);
});

test('snake: reaching 150 segments wins the game', (t) => {
  fresh(t);
  // Boustrophedon path over rows 0-4 (150 cells); the snake fills the first 149
  // with its head on (28,4) and the food on the last cell (29,4).
  const path = [];
  for (let y = 0; y < 5; y++) {
    for (let i = 0; i < 30; i++) path.push([y % 2 === 0 ? i : 29 - i, y]);
  }
  place(path.slice(0, 149).reverse(), [1, 0], [29, 4]);
  S.score = 1480;
  randomSequence(t, [0.5, 0.5]);

  snp.snpGameTick();

  assert.equal(S.snake.length, 150);
  assert.equal(S.gameOver, true);
  assert.equal(S.score, 1490);
  assert.equal(hidden('snp-overlay'), false);
  assert.equal($('snp-overlay-title').textContent, 'Grid Dominated');
  assert.equal($('snp-overlay-text').textContent, 'You reached maximum snake length.');
  assert.equal(saved().bestScore, 1490);
  // Staging behaviour: the win returns before the UI update, so the last +10 is
  // saved but not shown on the scoreboard.
  assert.notEqual($('snp-score').textContent, '1490');
});

test('snake: food only lands on a free cell', (t) => {
  fresh(t);
  const free = { x: 17, y: 23 };
  const snake = [];
  for (let x = 0; x < 30; x++) {
    for (let y = 0; y < 30; y++) {
      if (x !== free.x || y !== free.y) snake.push({ x, y });
    }
  }
  S.snake = snake;
  snp.snpSpawnFood();
  assert.deepEqual(S.food, free);
});

test('snake: snpFormatTime pads minutes and seconds', () => {
  assert.equal(snp.snpFormatTime(0), '00:00');
  assert.equal(snp.snpFormatTime(9), '00:09');
  assert.equal(snp.snpFormatTime(59), '00:59');
  assert.equal(snp.snpFormatTime(61), '01:01');
  assert.equal(snp.snpFormatTime(3600), '60:00');
  assert.equal(snp.snpFormatTime(6005), '100:05');
});

test('snake: save and load round-trip through localStorage', (t) => {
  fresh(t);
  place([[8, 3], [8, 4], [8, 5], [7, 5]], [0, -1], [12, 2]);
  S.nextDirection = { x: -1, y: 0 };
  Object.assign(S, { score: 40, bestScore: 90, timer: 75, speed: 85, gameOver: false, paused: false });
  snp.snpSaveState();
  const json = localStorage.getItem(KEY);

  snp.snpReset();
  assert.notEqual(S.score, 40);
  localStorage.setItem(KEY, json);
  $('snp-speed-select').value = '120';

  snp.snpLoadState();

  assert.deepEqual(S.snake, cells([[8, 3], [8, 4], [8, 5], [7, 5]]));
  assert.deepEqual(S.direction, { x: 0, y: -1 });
  assert.deepEqual(S.nextDirection, { x: -1, y: 0 });
  assert.deepEqual(S.food, { x: 12, y: 2 });
  assert.equal(S.score, 40);
  assert.equal(S.bestScore, 90);
  assert.equal(S.timer, 75);
  assert.equal(S.speed, 85);
  assert.equal($('snp-speed-select').value, '85');
  assert.equal(S.gameOver, false);
  assertWaiting('a reload waits for the first direction');
  snp.snpGameTick();
  assert.deepEqual(S.snake[0], { x: 8, y: 3 }, 'nothing moves before it');
  snp.snpSetDirection(-1, 0);
  assertRunning('the first direction resumes the restored game');
  snp.snpGameTick();
  assert.deepEqual(S.snake[0], { x: 7, y: 3 });
  assert.equal(S.score, 40);
});

test('snake: a finished game restored after a reload becomes a new waiting game', (t) => {
  // Lost: the head faces the wall it hit, so resuming it would crash again.
  fresh(t);
  place([[29, 10], [28, 10], [27, 10]], [1, 0], [20, 20]);
  Object.assign(S, { score: 50, bestScore: 80, timer: 42, speed: 85 });
  snp.snpGameTick();
  assert.equal(S.gameOver, true);
  assert.equal(saved().gameOver, true);
  $('snp-speed-select').value = '120';
  const random = randomSequence(t, [0.9, 0.9]);

  snp.snpLoadState();

  assert.deepEqual(S.snake, START);
  assert.deepEqual(S.direction, RIGHT);
  assert.deepEqual(S.food, { x: 27, y: 27 });
  assert.equal(S.score, 0);
  assert.equal(S.timer, 0);
  assert.equal(S.bestScore, 80, 'the best score is kept');
  assert.equal(S.speed, 85, 'the speed is kept');
  assert.equal($('snp-speed-select').value, '85');
  assert.equal(S.gameOver, false);
  assert.equal(hidden('snp-overlay'), true);
  assertWaiting('the new game waits');
  assert.equal(saved().gameOver, false);
  assert.deepEqual(saved().snake, START);
  snp.snpGameTick();
  assert.deepEqual(S.snake, START, 'and does not move before the first direction');

  // Won: same treatment.
  random.mock.restore();
  place([[5, 5], [4, 5], [3, 5]], [1, 0], [20, 20]);
  Object.assign(S, { score: 1490, bestScore: 1490, gameOver: true });
  snp.snpSaveState();
  snp.snpLoadState();
  assert.deepEqual(S.snake, START);
  assert.equal(S.score, 0);
  assert.equal(S.bestScore, 1490);
  assert.equal(S.gameOver, false);
  assertWaiting('a restored win also starts over');
});

test('snake: load falls back to defaults and survives a corrupt save', (t) => {
  fresh(t);
  localStorage.setItem(KEY, '{}');
  snp.snpLoadState();
  assert.deepEqual(S.snake, []);
  assert.deepEqual(S.direction, { x: 1, y: 0 });
  assert.deepEqual(S.food, { x: 10, y: 10 });
  assert.equal(S.score, 0);
  assert.equal(S.timer, 0);
  assert.equal(S.speed, 120);
  assert.equal($('snp-speed-select').value, '120');

  place([[5, 5], [4, 5]], [1, 0], [20, 20]);
  S.score = 30;
  const error = t.mock.method(console, 'error', () => {});
  localStorage.setItem(KEY, '{not json');
  snp.snpLoadState();
  assert.equal(error.mock.callCount(), 1);
  assert.equal(S.score, 30, 'state is left alone');
  assert.deepEqual(S.snake, cells([[5, 5], [4, 5]]));
});

test('snake: a fresh page load waits behind the start prompt instead of hitting the wall', (t) => {
  boot(t);

  assert.deepEqual(S.snake, START);
  assert.equal(S.gameOver, false);
  assert.equal(hidden('snp-overlay'), true);
  assertWaiting('fresh load');
  assert.equal(saved().paused, true);
  // Before the fix the snake set off at once and hit the right wall on its
  // 15th tick, 1.8 s after load at Normal speed.
  play(t, 5000);
  assert.deepEqual(S.snake, START);
  assert.equal(S.gameOver, false);
  assert.equal(S.timer, 0, 'the clock waits too');
  assert.equal($('snp-timer').textContent, '00:00');
});

test('snake: the first arrow key or WASD starts a waiting game, a reversal included', (t) => {
  boot(t);

  press('ArrowUp');
  assertRunning('ArrowUp');
  assert.equal(saved().paused, false);
  assert.equal(hidden('snp-toast'), true, 'starting shows no toast');
  play(t, 120);
  assert.deepEqual(S.snake[0], { x: 15, y: 14 });
  play(t, 1000);
  assert.equal(S.timer, 1, 'the clock runs once the game starts');

  const keys = [['w', UP], ['ArrowDown', DOWN], ['s', DOWN], ['ArrowRight', RIGHT], ['d', RIGHT]];
  for (const [key, dir] of keys) {
    fire($('snp-new-game'), 'click');
    assertWaiting('before ' + key);
    press(key);
    assertRunning(key);
    assert.deepEqual(S.nextDirection, dir, key);
  }

  // Left against the starting heading right is refused as a turn but still
  // starts the game, heading right.
  for (const key of ['ArrowLeft', 'a']) {
    fire($('snp-new-game'), 'click');
    press(key);
    assertRunning(key);
    assert.deepEqual(S.nextDirection, RIGHT, key);
  }
  play(t, 120);
  assert.deepEqual(S.snake[0], { x: 16, y: 15 });

  // Other keys do not start it.
  fire($('snp-new-game'), 'click');
  for (const key of ['W', 'x', ' ', 'Shift']) press(key);
  assertWaiting('non-direction keys');
});

test('snake: a tap on a touch direction button starts a waiting game', (t) => {
  boot(t);

  const buttons = [['snp-up', UP], ['snp-down', DOWN], ['snp-right', RIGHT], ['snp-left', RIGHT]];
  for (const [id, dir] of buttons) {
    fire($('snp-new-game'), 'click');
    assertWaiting('before ' + id);
    fire($(id), 'click');
    assertRunning(id);
    assert.deepEqual(S.nextDirection, dir, id);
  }
  play(t, 120);
  assert.deepEqual(S.snake[0], { x: 16, y: 15 });
});

test('snake: Pause/Resume and P start a waiting game; a manual pause still ignores steering', (t) => {
  boot(t);

  fire($('snp-pause-game'), 'click');
  assertRunning('Pause/Resume button');
  assert.equal(hidden('snp-toast'), true, 'starting shows no toast');
  play(t, 120);
  assert.deepEqual(S.snake[0], { x: 16, y: 15 });

  press('p');
  assert.equal(S.paused, true);
  assert.equal(S.waiting, false);
  assert.equal(hidden('snp-start-hint'), true, 'a manual pause shows no start prompt');
  assert.equal($('snp-pause-game').textContent, 'Resume');
  assert.equal($('snp-toast').textContent, 'Simulation paused');
  press('ArrowUp');
  assert.equal(S.paused, true, 'steering does not end a manual pause');
  play(t, 600);
  assert.deepEqual(S.snake[0], { x: 16, y: 15 });
  fire($('snp-pause-game'), 'click');
  assert.equal(S.paused, false);
  assert.equal($('snp-toast').textContent, 'Simulation resumed');
  play(t, 120);
  assert.deepEqual(S.snake[0], { x: 16, y: 14 });

  fire($('snp-new-game'), 'click');
  assertWaiting('New Game');
  press('p');
  assertRunning('P');
});

test('snake: New Game, Restart, Play Again and Enter all wait for the first direction', (t) => {
  boot(t);
  const starts = {
    'New Game': () => fire($('snp-new-game'), 'click'),
    Restart: () => fire($('snp-restart-game'), 'click'),
    Enter: () => press('Enter')
  };
  for (const [name, start] of Object.entries(starts)) {
    press('ArrowDown');
    play(t, 360);
    assert.deepEqual(S.snake[0], { x: 15, y: 18 }, name);
    S.score = 30;

    start();

    assert.deepEqual(S.snake, START, name);
    assert.equal(S.score, 0, name);
    assertWaiting(name);
    play(t, 3000);
    assert.deepEqual(S.snake, START, name + ' holds still');
    assert.equal(S.gameOver, false, name);
  }

  // Play Again after a crash: 14 tiles to the right wall, the 15th tick hits it.
  press('ArrowRight');
  play(t, 1800);
  assert.equal(S.gameOver, true);
  assert.equal(hidden('snp-overlay'), false);
  fire($('snp-overlay-button'), 'click');
  assert.equal(hidden('snp-overlay'), true);
  assert.deepEqual(S.snake, START);
  assertWaiting('Play Again');
  play(t, 3000);
  assert.deepEqual(S.snake, START);
  assert.equal(S.gameOver, false);
});

test('snake: a page loaded with a lost game saved shows a new game waiting, not a second crash', (t) => {
  const lost = {
    snake: cells([[29, 10], [28, 10], [27, 10]]),
    direction: RIGHT,
    nextDirection: RIGHT,
    food: { x: 20, y: 20 },
    score: 50,
    bestScore: 80,
    timer: 42,
    gameOver: true,
    paused: false,
    speed: 85
  };
  boot(t, lost);

  assert.deepEqual(S.snake, START);
  assert.equal(S.gameOver, false);
  assert.equal(hidden('snp-overlay'), true);
  assertWaiting('restored lost game');
  assert.equal($('snp-score').textContent, '0');
  assert.equal($('snp-best-score').textContent, '80');
  assert.equal($('snp-timer').textContent, '00:00');
  assert.equal(S.speed, 85);
  play(t, 5000);
  assert.equal(S.gameOver, false, 'no crash before the first direction');
  assert.deepEqual(S.snake, START);

  press('w');
  play(t, 85);
  assert.deepEqual(S.snake[0], { x: 15, y: 14 });
  assert.equal(S.gameOver, false);
});

test('snake: Enter on the Start button focused by a mouse click starts a new waiting game, not a run into the wall', (t) => {
  boot(t);
  const startButton = $('snp-pause-game');

  // As reproduced in a browser: Start clicked with the mouse (the button keeps
  // the focus), a crash into the right wall, then Enter. The game's Enter
  // starts a new waiting game; the browser's own Enter on the focused button
  // used to click Start too and send the new snake off into the wall again.
  fire(startButton, 'click');
  assertRunning('Start clicked');
  play(t, 1800);
  assert.equal(S.gameOver, true);

  const enter = press('Enter', { target: startButton });

  assert.equal(enter.defaultPrevented, true, 'Enter does not also click the focused button');
  assert.equal(S.gameOver, false);
  assert.equal(hidden('snp-overlay'), true);
  assert.deepEqual(S.snake, START);
  assertWaiting('after Enter');
  play(t, 3000);
  assert.deepEqual(S.snake, START, 'the new snake holds still');
  assert.equal(S.gameOver, false);
  assert.equal(S.timer, 0);

  // The same with any other button left focused: Enter only starts a new
  // waiting game and never also steers, starts or pauses it.
  for (const id of BUTTON_IDS) {
    press('ArrowDown');
    play(t, 240);
    assertRunning(id + ': running before Enter');
    const event = press('Enter', { target: $(id) });
    assert.equal(event.defaultPrevented, true, id);
    assert.deepEqual(S.snake, START, id);
    assertWaiting('Enter on a focused ' + id);
    play(t, 1200);
    assert.deepEqual(S.snake, START, id + ' holds still');
  }
});

test('snake: keys the game plays have their default action cancelled, other keys keep it', (t) => {
  boot(t);

  // Otherwise the arrows scroll the page while playing and Enter also clicks
  // a focused button.
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'p', 'Enter']) {
    assert.equal(press(key).defaultPrevented, true, key);
  }
  assertWaiting('Enter came last');

  for (const key of ['W', 'A', 'S', 'D', 'P', ' ', 'Tab', 'Escape', 'Backspace', 'x', 'Shift', 'F5', 'PageDown']) {
    assert.equal(press(key).defaultPrevented, false, JSON.stringify(key));
  }
  assertWaiting('keys the game does not play change nothing');

  // Space is not a game key, so it still works the focused button.
  const space = press(' ', { target: $('snp-pause-game') });
  assert.equal(space.defaultPrevented, false);
  assertRunning('Space on the focused Start button');
});

test('snake: Ctrl, Cmd and Alt key combinations are left to the browser', (t) => {
  boot(t);
  const modifiers = ['ctrlKey', 'metaKey', 'altKey'];

  for (const modifier of modifiers) {
    for (const key of ['ArrowUp', 'w', 'p', 'Enter']) {
      const event = press(key, { [modifier]: true });
      assert.equal(event.defaultPrevented, false, modifier + ' + ' + key);
    }
    assertWaiting(modifier + ' combinations do not start the game');
  }

  // Nor do they steer, pause or restart a running game.
  press('ArrowDown');
  play(t, 240);
  S.score = 30;
  for (const modifier of modifiers) {
    for (const key of ['ArrowLeft', 'a', 'p', 'Enter']) press(key, { [modifier]: true });
  }
  assertRunning('still running');
  assert.deepEqual(S.nextDirection, DOWN);
  assert.equal(S.score, 30, 'no new game');
  assert.deepEqual(S.snake[0], { x: 15, y: 17 });
});

test('snake: typing in a field outside the game does nothing to it', (t) => {
  boot(t);
  const editable = stubElement('div');
  editable.isContentEditable = true;
  const fields = {
    input: stubElement('input'),
    textarea: stubElement('textarea'),
    select: stubElement('select'),
    contenteditable: editable
  };
  const keys = ['w', 'a', 's', 'd', 'p', 'ArrowUp', 'ArrowDown', 'Enter'];

  for (const [name, target] of Object.entries(fields)) {
    for (const key of keys) {
      assert.equal(press(key, { target }).defaultPrevented, false, name + ' ' + key);
    }
    assertWaiting(name + ': the game still waits');
  }

  // A running game is not steered, paused or restarted from a field either.
  press('ArrowDown');
  S.score = 30;
  for (const target of Object.values(fields)) {
    for (const key of keys) press(key, { target });
  }
  assertRunning('still running');
  assert.deepEqual(S.nextDirection, DOWN);
  assert.equal(S.score, 30);

  // The game's own difficulty select is not such a field: it keeps the focus
  // after a mouse pick, and an arrow then steers instead of changing the speed.
  fire($('snp-new-game'), 'click');
  const arrow = press('ArrowUp', { target: $('snp-speed-select') });
  assert.equal(arrow.defaultPrevented, true);
  assertRunning('arrow on the difficulty select');
  assert.deepEqual(S.nextDirection, UP);
});

test('snake: a keydown without a key (Chrome autofill) is ignored', (t) => {
  boot(t);

  for (const key of [undefined, null, 13]) {
    assert.equal(press(key).defaultPrevented, false, String(key));
  }
  fire(document, 'keydown', {}); // a bare Event: no key and no preventDefault
  assertWaiting('nothing started');

  press('ArrowUp');
  S.score = 30;
  press(undefined);
  fire(document, 'keydown', {});
  assertRunning('nothing paused');
  assert.equal(S.score, 30);
});

test('snake: the Pause/Resume button aria-label follows its label', (t) => {
  boot(t);

  assert.deepEqual(pauseButton(), ['Start', 'Start game'], 'page load');
  fire($('snp-pause-game'), 'click');
  assert.deepEqual(pauseButton(), ['Pause', 'Pause game'], 'started');
  fire($('snp-pause-game'), 'click');
  assert.deepEqual(pauseButton(), ['Resume', 'Resume game'], 'paused by the button');
  press('p');
  assert.deepEqual(pauseButton(), ['Pause', 'Pause game'], 'resumed by P');
  press('p');
  assert.deepEqual(pauseButton(), ['Resume', 'Resume game'], 'paused by P');
  fire($('snp-restart-game'), 'click');
  assert.deepEqual(pauseButton(), ['Start', 'Start game'], 'Restart during a pause');
  press('d');
  assert.deepEqual(pauseButton(), ['Pause', 'Pause game'], 'started by a direction');
  play(t, 1800);
  assert.equal(S.gameOver, true);
  fire($('snp-overlay-button'), 'click');
  assert.deepEqual(pauseButton(), ['Start', 'Start game'], 'Play Again');

  // A reload of a running game: the restored game waits, and the label says so.
  press('w');
  assert.deepEqual(pauseButton(), ['Pause', 'Pause game']);
  snp.snpLoadState();
  assert.deepEqual(pauseButton(), ['Start', 'Start game'], 'restored game');
});
