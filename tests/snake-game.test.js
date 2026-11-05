// tests/snake-game.test.js
// Cyber Snake (snake-game/, prefix snp-).
//
// Most tests start the game the way a page does: index.html's elements on a
// page (htmlPageSpec, wrapped in a .snp-wrapper div like the real markup), a
// fresh copy of script.js loaded and snpInit run, so every key, click and
// select change goes through the listeners the game registered itself
// (pressKey / el.click() / fire). setInterval and setTimeout are mocked, and
// play(t, ms) advances them one millisecond at a time and runs the animation
// frame the game asked for, like a browser tab in view. Math.random is
// mocked too: a fixed seeded sequence by default (the first food of a new
// game lands on (0,3)), or exact values where a test needs them. The canvas
// context records what is drawn.
//
// The tests named "(Bn)" are the regressions for the bugs fixed in the
// refactor. They only use what the original script also had (snpInit,
// snpState, the DOM, the save, the canvas), so they can be run against it.
// Further down: start-up in a browser (bootLikeBrowser), the pure game logic
// and save checks, and static checks of index.html, style.css and script.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resetStubs, flushAnimationFrames, stubElement, keyEvent, pressKey, fire, createEvent,
  listenerCount, createPage, loadWithPage, loadScript, bootLikeBrowser,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt
} = require('./_setup');

const GAME_DIR = 'snake-game/';
const SCRIPT = GAME_DIR + 'script.js';
const HTML = readRepoFile(GAME_DIR + 'index.html');
const CSS = readRepoFile(GAME_DIR + 'style.css');
const SOURCE = readRepoFile(SCRIPT);
const KEY = 'snp-snake-state';

const cells = (list) => list.map(([x, y]) => ({ x, y }));
const START = cells([[15, 15], [14, 15], [13, 15]]);
const UP = { x: 0, y: -1 };
const DOWN = { x: 0, y: 1 };
const LEFT = { x: -1, y: 0 };
const RIGHT = { x: 1, y: 0 };

// The ids snpInit looks up (all of them in index.html).
const GAME_IDS = [
  'snp-best-score', 'snp-down', 'snp-game-canvas', 'snp-left', 'snp-new-game',
  'snp-overlay', 'snp-overlay-button', 'snp-overlay-text', 'snp-overlay-title',
  'snp-pause-game', 'snp-restart-game', 'snp-right', 'snp-score', 'snp-speed-select',
  'snp-start-hint', 'snp-timer', 'snp-toast', 'snp-up'
];
const BUTTON_IDS = [
  'snp-new-game', 'snp-restart-game', 'snp-pause-game', 'snp-overlay-button',
  'snp-up', 'snp-down', 'snp-left', 'snp-right'
];

// A save as the original version wrote it mid-game (loop / timerLoop were
// its interval ids), and the one it wrote for a fresh page.
const BASELINE_SAVE = '{"snake":[{"x":8,"y":3},{"x":8,"y":4},{"x":8,"y":5},{"x":7,"y":5}],' +
  '"direction":{"x":0,"y":-1},"nextDirection":{"x":-1,"y":0},"food":{"x":12,"y":2},' +
  '"score":40,"bestScore":90,"timer":75,"gameOver":false,"paused":false,"waiting":false,' +
  '"speed":85,"loop":7,"timerLoop":8}';
const BASELINE_FRESH_SAVE = '{"snake":[{"x":15,"y":15},{"x":14,"y":15},{"x":13,"y":15}],' +
  '"direction":{"x":1,"y":0},"nextDirection":{"x":1,"y":0},"food":{"x":3,"y":6},' +
  '"score":0,"bestScore":120,"timer":0,"gameOver":false,"paused":true,"waiting":true,' +
  '"speed":120,"loop":null,"timerLoop":null}';

// A save in that format with the given fields.
function gameSave(fields) {
  return Object.assign({
    snake: START,
    direction: RIGHT,
    nextDirection: RIGHT,
    food: { x: 25, y: 25 },
    score: 0,
    bestScore: 0,
    timer: 0,
    gameOver: false,
    paused: true,
    waiting: true,
    speed: 120
  }, fields);
}

// A boustrophedon path over rows 0-4 (150 cells): a snake on the first 149
// with its head on (28,4) wins by eating food on the last cell (29,4).
function nearWinSnake() {
  const path = [];
  for (let y = 0; y < 5; y++) {
    for (let i = 0; i < 30; i++) path.push([y % 2 === 0 ? i : 29 - i, y]);
  }
  return cells(path.slice(0, 149).reverse());
}

// ── Harness for this file ───────────────────────────────────────────────────

// Math.random, mocked once per test: rng.reseed() starts a seeded sequence
// (every page load does, so its first food lands on (0,3)), rng.sequence(
// [...]) gives exact values (one call too many throws) and rng.left() says
// how many of them are still unused.
const randoms = new WeakMap();
function seeded() {
  let s = 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
function randomFor(t) {
  let rng = randoms.get(t);
  if (!rng) {
    let source = seeded();
    let values = [];
    t.mock.method(Math, 'random', () => source());
    rng = {
      reseed() {
        values = [];
        source = seeded();
      },
      sequence(list) {
        values = list.slice();
        source = () => {
          if (!values.length) throw new Error('Math.random called more often than expected');
          return values.shift();
        };
      },
      left: () => values.length
    };
    randoms.set(t, rng);
  }
  return rng;
}

// setInterval / setTimeout mocked; a second page load in the same test drops
// the first page's timers, as a reload does.
const timersOn = new WeakSet();
function mockTimers(t) {
  if (timersOn.has(t)) t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  timersOn.add(t);
}

// index.html's elements, inside a .snp-wrapper div as on the real page (the
// wrapper has no id, so htmlPageSpec leaves it out).
function gamePageSpec() {
  const spec = { 'snp-test-wrapper': { tagName: 'div', className: 'snp-wrapper' } };
  for (const [id, props] of Object.entries(htmlPageSpec(HTML))) {
    spec[id] = props.parent ? props : Object.assign({ parent: 'snp-test-wrapper' }, props);
  }
  return spec;
}

// Records the drawing calls on a canvas context, with the style in force.
function recordCanvas(ctx) {
  const calls = [];
  ctx.clearRect = (x, y, w, h) => calls.push(['clearRect', x, y, w, h]);
  ctx.fillRect = (x, y, w, h) => calls.push(['fillRect', ctx.fillStyle, x, y, w, h, ctx.shadowColor, ctx.shadowBlur]);
  ctx.beginPath = () => calls.push(['beginPath']);
  ctx.arc = (x, y, r, from, to) => calls.push(['arc', x, y, r, from, to]);
  ctx.fill = () => calls.push(['fill', ctx.fillStyle, ctx.shadowColor, ctx.shadowBlur]);
  return calls;
}

// The calls of the last full drawing of the board.
function lastFrame(draw) {
  return draw.slice(draw.map((call) => call[0]).lastIndexOf('clearRect'));
}

// The snake and the food as last drawn: segments are the 16 px squares.
function drawnSnake(draw) {
  return lastFrame(draw)
    .filter((call) => call[0] === 'fillRect' && call[4] === 16)
    .map(([, color, x, y]) => ({ x: (x - 2) / 20, y: (y - 2) / 20, color }));
}
function drawnFood(draw) {
  return lastFrame(draw)
    .filter((call) => call[0] === 'arc')
    .map(([, x, y]) => ({ x: (x - 10) / 20, y: (y - 10) / 20 }));
}
const drawnHead = (draw) => drawnSnake(draw)[0];

// A page about to load: storage holds options.save (an object) or
// options.raw (text), timers and Math.random are mocked (options.random:
// exact values), the page is installed and script.js loaded fresh.  Call
// game.init() to run snpInit (startGame does both).
function prepareGame(t, options = {}) {
  resetStubs();
  mockTimers(t);
  const rng = randomFor(t);
  if (options.random) rng.sequence(options.random);
  else rng.reseed();
  if (options.raw !== undefined) localStorage.setItem(KEY, options.raw);
  else if (options.save) localStorage.setItem(KEY, JSON.stringify(options.save));
  const page = createPage(gamePageSpec());
  const draw = recordCanvas(page.els['snp-game-canvas'].getContext('2d'));
  const { exports: snp } = loadWithPage(SCRIPT, page, { keep: true });
  return {
    snp,
    S: snp.snpState,
    els: page.els,
    page,
    draw,
    rng,
    init: () => snp.snpInit(),
    saved: () => JSON.parse(localStorage.getItem(KEY))
  };
}

function startGame(t, options) {
  const game = prepareGame(t, options);
  game.init();
  return game;
}

// A reload: a new page with what the old one saved.
function reload(t, options = {}) {
  return startGame(t, Object.assign({ raw: localStorage.getItem(KEY) }, options));
}

// Time passing in a tab in view: timers advance 1 ms at a time and the frame
// the game asked for runs right after.
function play(t, ms) {
  for (let i = 0; i < ms; i++) {
    t.mock.timers.tick(1);
    flushAnimationFrames();
  }
}

const hidden = (el) => el.classList.contains('snp-hidden');
const text = (game, id) => game.els[id].textContent;
const pauseButton = (game) => [text(game, 'snp-pause-game'), game.els['snp-pause-game'].getAttribute('aria-label')];
const click = (game, id) => game.els[id].click();
const scoreboard = (game) => [text(game, 'snp-score'), text(game, 'snp-best-score'), text(game, 'snp-timer')];

function chooseSpeed(game, value) {
  game.els['snp-speed-select'].value = value;
  fire(game.els['snp-speed-select'], 'change');
}

// A new or restored game holds still behind the start prompt.
function assertWaiting(game, label) {
  assert.equal(game.S.paused, true, label);
  assert.equal(game.S.waiting, true, label);
  assert.equal(hidden(game.els['snp-start-hint']), false, label);
  assert.deepEqual(pauseButton(game), ['Start', 'Start game'], label);
}

function assertRunning(game, label) {
  assert.equal(game.S.paused, false, label);
  assert.equal(game.S.waiting, false, label);
  assert.equal(hidden(game.els['snp-start-hint']), true, label);
  assert.deepEqual(pauseButton(game), ['Pause', 'Pause game'], label);
}

function assertOverlay(game, title, message) {
  assert.equal(hidden(game.els['snp-overlay']), false);
  assert.equal(text(game, 'snp-overlay-title'), title);
  assert.equal(text(game, 'snp-overlay-text'), message);
}

// ── Regressions for the bugs fixed in the refactor ──────────────────────────

test('snake: the toast never takes a tap meant for the touch arrows under it (B1)', () => {
  const rules = cssRules(CSS);
  for (const width of [320, 360, 375, 414, 768, 1280]) {
    assert.equal(declsAt(rules, '.snp-toast', width)['pointer-events'], 'none', width + 'px');
  }
});

test('snake: with site data blocked the game still starts and plays, without saving (B2)', (t) => {
  const game = prepareGame(t);
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: The operation is insecure.'); }
  });
  try {
    game.init();
    assertWaiting(game, 'a new game');
    assert.deepEqual(drawnSnake(game.draw).map(({ x, y }) => ({ x, y })), START);

    pressKey('ArrowUp');
    assertRunning(game, 'started');
    play(t, 240);
    assert.deepEqual(game.S.snake[0], { x: 15, y: 13 });
    assert.deepEqual(drawnHead(game.draw), { x: 15, y: 13, color: '#22d3ee' });

    pressKey('p');
    assert.equal(game.S.paused, true);
    click(game, 'snp-new-game');
    assertWaiting(game, 'New Game');
    chooseSpeed(game, '60');
    assert.equal(game.S.speed, 60);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', storage);
  }
});

test('snake: when saving starts failing mid-game the board keeps moving (B3)', (t) => {
  const game = startGame(t);
  pressKey('ArrowUp');
  play(t, 120);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 14 });
  const before = localStorage.getItem(KEY);
  t.mock.method(localStorage, 'setItem', () => { throw new Error('QuotaExceededError'); });

  play(t, 240);

  assert.deepEqual(game.S.snake[0], { x: 15, y: 12 });
  assert.deepEqual(drawnHead(game.draw), { x: 15, y: 12, color: '#22d3ee' });
  assert.equal(localStorage.getItem(KEY), before, 'nothing could be saved');
  pressKey('p');
  pressKey('p');
  chooseSpeed(game, '85');
  click(game, 'snp-new-game');
  assertWaiting(game, 'New Game');
});

test('snake: links, buttons and fields of the host page keep their keys (B4)', (t) => {
  const game = startGame(t, { save: gameSave({ score: 30, bestScore: 30 }) });
  const link = game.page.add('host-link', { tagName: 'a', attributes: { href: '#host' } });
  const hostButton = game.page.add('host-button', 'button');
  const hostClicks = [];
  hostButton.addEventListener('click', () => hostClicks.push('host'));
  const fields = ['input', 'textarea', 'select'].map((tag) => game.page.add('host-' + tag, tag));
  const editable = game.page.add('host-editable', { isContentEditable: true });

  for (const target of [link, hostButton, ...fields, editable]) {
    for (const key of ['Enter', 'ArrowUp', 'ArrowDown', 'w', 's', 'p']) {
      assert.equal(pressKey(key, { target }).defaultPrevented, false, target.id + ' ' + key);
    }
  }
  assertWaiting(game, 'nothing started the game');
  assert.equal(game.S.score, 30, 'no new game');
  assert.deepEqual(hostClicks, ['host'], 'Enter on the focused host button clicked it');

  // A running game is not steered, paused or restarted from them either.
  pressKey('ArrowDown');
  for (const target of [link, hostButton, ...fields, editable]) {
    for (const key of ['Enter', 'ArrowLeft', 'ArrowUp', 'a', 'p']) pressKey(key, { target });
  }
  assertRunning(game, 'still running');
  assert.deepEqual(game.S.nextDirection, DOWN);
  assert.equal(game.S.score, 30);

  // With nothing focused (the body) and on the game's own controls the keys
  // are the game's.
  assert.equal(pressKey('ArrowRight').defaultPrevented, true);
  assert.deepEqual(game.S.nextDirection, RIGHT);
  assert.equal(pressKey('ArrowUp', { target: game.els['snp-speed-select'] }).defaultPrevented, true);
  assert.deepEqual(game.S.nextDirection, UP);
  assert.equal(pressKey('p', { target: game.els['snp-up'] }).defaultPrevented, true);
  assert.equal(game.S.paused, true);

  // A host element that holds the game has the focus, as a theme's
  // tabindex="-1" content area does after a click on the board: the keys
  // are the game's. A link next to the game in that area keeps its keys.
  const content = game.page.add('host-content', { attributes: { tabindex: '-1' } });
  content.appendChild(game.els['snp-test-wrapper']);
  const innerLink = game.page.add('host-inner-link', { tagName: 'a', parent: 'host-content', attributes: { href: '#more' } });
  content.focus();
  assert.equal(pressKey('p').defaultPrevented, true, 'P on the focused content area');
  assertRunning(game, 'resumed');
  assert.equal(pressKey('ArrowDown').defaultPrevented, true, 'ArrowDown on the focused content area');
  assert.deepEqual(game.S.nextDirection, DOWN);
  for (const key of ['Enter', 'ArrowLeft', 'ArrowUp', 'a', 'p']) {
    assert.equal(pressKey(key, { target: innerLink }).defaultPrevented, false, 'host-inner-link ' + key);
  }
  assertRunning(game, 'the link next to the game changed nothing');
  assert.deepEqual(game.S.nextDirection, DOWN);
});

test('snake: a corrupt or partial save loads into a playable game (B5)', (t) => {
  const twoCells = cells([[5, 5], [4, 5]]);
  const cases = [
    { name: 'not JSON', raw: '{oops' },
    { name: 'null', raw: 'null' },
    { name: 'a number', raw: '42' },
    { name: 'an array', raw: '[1,2,3]' },
    { name: 'an empty object', raw: '{}' },
    { name: 'snake as text', save: { snake: 'abc', bestScore: 70, speed: 85 }, best: 70, speed: 85 },
    { name: 'empty cells', save: { snake: [{}, {}], gameOver: false } },
    { name: 'off the grid', save: { snake: cells([[40, 40], [39, 40]]), gameOver: false } },
    { name: 'a snake in pieces', save: { snake: cells([[5, 5], [9, 9]]), speed: 160 }, speed: 160 },
    { name: 'a 150-cell snake', save: gameSave({ snake: [{ x: 29, y: 4 }].concat(nearWinSnake()) }) },
    { name: 'diagonal direction', save: gameSave({ snake: twoCells, direction: { x: 1, y: 1 }, nextDirection: { x: 1, y: 1 } }), head: { x: 5, y: 5 } },
    { name: 'food off the grid', save: gameSave({ snake: twoCells, food: { x: 99, y: 99 } }), head: { x: 5, y: 5 } },
    { name: 'score as text', save: gameSave({ snake: twoCells, score: '50', bestScore: '50' }), head: { x: 5, y: 5 } },
    { name: 'timer as text', save: gameSave({ snake: twoCells, timer: '42' }), head: { x: 5, y: 5 } },
    { name: 'unknown speed', save: gameSave({ snake: twoCells, speed: 5 }), head: { x: 5, y: 5 } },
    { name: 'unknown speed, finished', save: gameSave({ speed: 5, gameOver: true }) }
  ];
  for (const c of cases) {
    const game = startGame(t, c.raw !== undefined ? { raw: c.raw } : { save: c.save });
    const head = c.head || { x: 15, y: 15 };
    assertWaiting(game, c.name);
    assert.deepEqual(game.S.snake[0], head, c.name);
    if (!c.head) assert.deepEqual(game.S.snake, START, c.name + ': a new snake');
    assert.deepEqual(scoreboard(game), ['0', String(c.best || 0), '00:00'], c.name);
    assert.equal(game.S.speed, c.speed || 120, c.name);
    assert.equal(game.els['snp-speed-select'].value, String(c.speed || 120), c.name);
    assert.equal(hidden(game.els['snp-overlay']), true, c.name);

    const speed = c.speed || 120;
    pressKey('ArrowDown');
    play(t, 9 * speed);

    assert.deepEqual(game.S.snake[0], { x: head.x, y: head.y + 9 }, c.name + ': nine tiles down');
    assert.equal(game.S.gameOver, false, c.name);
    const clock = '00:0' + Math.floor(9 * speed / 1000);
    assert.deepEqual(scoreboard(game), ['0', String(c.best || 0), clock], c.name);
    assert.equal(game.saved().speed, c.speed || 120, c.name);
  }
});

test('snake: a hidden tab does not pile up ticks; one frame runs one tick (B6)', (t) => {
  const game = startGame(t);
  pressKey('ArrowUp');

  // 1.6 s of interval fires with no animation frame, as in a hidden tab.
  t.mock.timers.tick(1600);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 15 });
  assert.equal(text(game, 'snp-timer'), '00:00', 'a frozen snake gains no time');

  assert.equal(flushAnimationFrames(), 1, 'one frame was waiting');
  assert.deepEqual(game.S.snake[0], { x: 15, y: 14 }, 'one tile, not thirteen');
  play(t, 120);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 13 });
});

test('snake: the timer counts the time the snake moves, to the tick (B7)', (t) => {
  const game = startGame(t);
  play(t, 900);
  pressKey('ArrowUp');

  play(t, 100);
  assert.equal(text(game, 'snp-timer'), '00:00', 'one tick (120 ms) after 900 ms of waiting');
  play(t, 800);
  assert.equal(game.S.snake[0].y, 7, 'eight ticks');
  assert.equal(text(game, 'snp-timer'), '00:00', '960 ms');
  play(t, 120);
  assert.equal(text(game, 'snp-timer'), '00:01', '1080 ms');
  assert.equal(game.saved().timer, 1);

  // A pause keeps the 80 ms already played; the clock stops meanwhile.
  pressKey('p');
  pressKey('ArrowRight');
  play(t, 5000);
  assert.equal(text(game, 'snp-timer'), '00:01');
  pressKey('p');
  play(t, 840);
  assert.equal(text(game, 'snp-timer'), '00:01', '1080 + 840 ms');
  play(t, 120);
  assert.equal(text(game, 'snp-timer'), '00:02', '1080 + 960 ms');
  assert.deepEqual(game.S.snake[0], { x: 23, y: 6 });
});

test('snake: New Game, Restart, Enter, Play Again and a restored save start the clock from zero (B7)', (t) => {
  // From a snake whose head is on (15,7), heading up, the 8th tick crashes.
  const nearTop = gameSave({ snake: cells([[15, 7], [15, 8], [15, 9]]), direction: UP, nextDirection: UP });
  const ways = [
    ['New Game', null, (game) => click(game, 'snp-new-game')],
    ['Restart', null, (game) => click(game, 'snp-restart-game')],
    ['Enter', null, () => pressKey('Enter')],
    ['Play Again', nearTop, (game) => click(game, 'snp-overlay-button')],
    ['snpLoadState', null, (game) => assert.equal(game.snp.snpLoadState(), true)]
  ];
  for (const [name, save, startOver] of ways) {
    const game = startGame(t, save ? { save } : {});
    pressKey('ArrowUp');
    play(t, 960); // 8 ticks: 960 ms played, not yet a second
    assert.equal(game.S.snake[0].y, save ? 0 : 7, name + ': 8 tiles up, or 7 and a crash');
    assert.equal(game.S.gameOver, Boolean(save), name);
    assert.equal(text(game, 'snp-timer'), '00:00', name);

    startOver(game);
    assertWaiting(game, name);
    pressKey('ArrowRight'); // room for 9 ticks from (15,15) and from the restored (15,7)
    play(t, 120);
    assert.equal(text(game, 'snp-timer'), '00:00', name + ': 120 ms of the new game, nothing carried over');
    assert.equal(game.saved().timer, 0, name);
    play(t, 840);
    assert.equal(text(game, 'snp-timer'), '00:00', name + ': 960 ms');
    play(t, 120);
    assert.equal(text(game, 'snp-timer'), '00:01', name + ': 1080 ms');
    assert.equal(game.saved().timer, 1, name);
  }
});

test('snake: the ticks that eat, win or crash count toward the clock too (B7)', (t) => {
  // Eating on every tick: food on (15,14), and each new one on the next cell
  // up, for nine ticks from (15,15).
  let game = startGame(t, { save: gameSave({ food: { x: 15, y: 14 } }) });
  const nextFoods = [];
  for (let y = 13; y >= 6; y--) nextFoods.push(0.5, (y + 0.5) / 30);
  game.rng.sequence(nextFoods.concat([0.9, 0.9])); // the last new food: (27,27)
  pressKey('ArrowUp');
  play(t, 960);
  assert.deepEqual(scoreboard(game), ['80', '80', '00:00'], 'eight ticks, eight energy nodes');
  play(t, 120);
  assert.deepEqual(scoreboard(game), ['90', '90', '00:01'], 'the ninth eats too: 1080 ms');
  assert.equal(game.S.snake.length, 12);
  assert.equal(game.rng.left(), 0, 'nine foods eaten');
  assert.equal(game.saved().timer, 1);

  // The winning tick: nine ticks down from the near-win head (28,4); the
  // ninth eats the food on (28,13) and makes 150 cells at 1080 ms.
  game = startGame(t, { save: gameSave({ snake: nearWinSnake(), food: { x: 28, y: 13 }, score: 1480, bestScore: 1480 }) });
  game.rng.sequence([0.5, 0.5]); // the new food: (15,15)
  pressKey('ArrowDown');
  play(t, 960);
  assert.equal(game.S.gameOver, false);
  assert.deepEqual(scoreboard(game), ['1480', '1480', '00:00'], 'eight ticks');
  play(t, 120);
  assertOverlay(game, 'Grid Dominated', 'You reached maximum snake length.');
  assert.deepEqual(scoreboard(game), ['1490', '1490', '00:01'], 'the winning tick is counted');
  assert.equal(game.saved().timer, 1);

  // The crashing tick: eight tiles to the right wall from (21,15); the ninth
  // tick hits it. The snake was moving during that tick too, so it counts.
  game = startGame(t, { save: gameSave({ snake: cells([[21, 15], [20, 15], [19, 15]]) }) });
  pressKey('ArrowRight');
  play(t, 960);
  assert.deepEqual(game.S.snake[0], { x: 29, y: 15 });
  assert.equal(text(game, 'snp-timer'), '00:00', 'eight ticks');
  play(t, 120);
  assertOverlay(game, 'System Failure', 'Snake crashed into the cyber grid.');
  assert.equal(text(game, 'snp-timer'), '00:01', 'the crashing tick is counted');
  assert.equal(game.saved().timer, 1);
  play(t, 3000);
  assert.equal(text(game, 'snp-timer'), '00:01', 'and nothing after it');
});

test('snake: the winning move shows the last +10 and draws the head on the last cell (B8)', (t) => {
  const game = startGame(t, {
    save: gameSave({ snake: nearWinSnake(), food: { x: 29, y: 4 }, score: 1480, bestScore: 1480 })
  });
  game.rng.sequence([0.5, 0.5]); // the new food: (15,15)
  pressKey('ArrowRight');

  play(t, 120);

  assert.equal(game.S.gameOver, true);
  assertOverlay(game, 'Grid Dominated', 'You reached maximum snake length.');
  assert.deepEqual(scoreboard(game), ['1490', '1490', '00:00']);
  assert.equal(game.saved().score, 1490);
  assert.equal(game.saved().bestScore, 1490);
  assert.equal(game.saved().snake.length, 150);
  assert.equal(game.saved().gameOver, true);
  const drawn = drawnSnake(game.draw);
  assert.equal(drawn.length, 150);
  assert.deepEqual(drawn[0], { x: 29, y: 4, color: '#22d3ee' });
  assert.equal(text(game, 'snp-toast'), 'Energy node acquired +10');

  // The game is over: time, P, Pause and the arrows change nothing.
  pressKey('p');
  click(game, 'snp-pause-game');
  pressKey('ArrowDown');
  click(game, 'snp-down');
  play(t, 2000);
  assert.equal(game.S.paused, false);
  assert.deepEqual(pauseButton(game), ['Pause', 'Pause game']);
  assert.deepEqual(game.S.snake[0], { x: 29, y: 4 });
  assert.deepEqual(scoreboard(game), ['1490', '1490', '00:00']);
});

test('snake: WASD and P work with Caps Lock and on other keyboard layouts (B9)', (t) => {
  const game = startGame(t);
  const layouts = [
    ['W', {}, UP], // Caps Lock
    ['ц', { code: 'KeyW' }, UP], // Ukrainian layout
    ['і', { code: 'KeyS' }, DOWN],
    ['в', { code: 'KeyD' }, RIGHT],
    ['z', { code: 'KeyW' }, UP], // AZERTY: the key where QWERTY has W
    // Latin layouts play the letter on the key, not its QWERTY position.
    ['d', { code: 'KeyW' }, RIGHT], // Workman: D sits where QWERTY has W
    ['s', { code: 'KeyD' }, DOWN], // Colemak: S sits where QWERTY has D
    ['S', { shiftKey: true }, DOWN]
  ];
  for (const [key, props, direction] of layouts) {
    click(game, 'snp-new-game');
    assert.equal(pressKey(key, props).defaultPrevented, true, key);
    assertRunning(game, key + ' starts the game');
    assert.deepEqual(game.S.nextDirection, direction, key);
  }
  assert.equal(pressKey('ф', { code: 'KeyA' }).defaultPrevented, true, 'A on a Ukrainian layout is played');
  assert.deepEqual(game.S.nextDirection, DOWN, 'left would reverse the heading (right), so down stays');

  pressKey('з', { code: 'KeyP' });
  assert.equal(game.S.paused, true, 'P on a Ukrainian layout pauses');
  pressKey('P');
  assert.equal(game.S.paused, false, 'P with Caps Lock resumes');
});

test('snake: holding P or Enter acts once (B10)', (t) => {
  const game = startGame(t, { save: gameSave({ score: 30, bestScore: 30 }) });
  pressKey('ArrowUp');

  assert.equal(pressKey('p', { repeat: true }).defaultPrevented, true);
  assertRunning(game, 'a repeat alone does not pause');
  pressKey('p');
  for (let i = 0; i < 4; i++) pressKey('p', { repeat: true });
  assert.equal(game.S.paused, true, 'paused once, held down');
  assert.deepEqual(pauseButton(game), ['Resume', 'Resume game']);

  assert.equal(pressKey('Enter', { repeat: true }).defaultPrevented, true);
  assert.equal(game.S.score, 30, 'no new game from a repeat');
  pressKey('ArrowDown', { repeat: true });
  assert.deepEqual(game.S.nextDirection, DOWN, 'held arrows still steer');
});

test('snake: the touch arrows show on phones and on any touch screen, not on desktop (B12)', () => {
  const rules = cssRules(CSS);
  const touch = { matchMedia: (query) => /\(hover:\s*none\)/.test(query) && /\(pointer:\s*coarse\)/.test(query) };
  const controls = (width, options) => declsAt(rules, '.snp-mobile-controls', width, options);

  for (const width of [320, 360, 375, 414, 768]) assert.equal(controls(width).display, 'flex', width + 'px');
  for (const width of [769, 1024, 1280, 1920]) assert.equal(controls(width).display, 'none', width + 'px desktop');
  for (const width of [667, 844, 1024, 1180, 1366]) {
    const decls = controls(width, touch);
    assert.equal(decls.display, 'flex', width + 'px touch screen');
    assert.equal(decls['flex-direction'], 'column');
    assert.equal(decls['align-items'], 'center');
    assert.equal(decls.gap, '12px');
  }
});

// ── Page load ───────────────────────────────────────────────────────────────

test('snake: a fresh page load draws a new snake waiting behind the start prompt', (t) => {
  const game = startGame(t);

  assert.deepEqual(game.S.snake, START);
  assert.deepEqual(game.S.direction, RIGHT);
  assert.deepEqual(game.S.nextDirection, RIGHT);
  assert.deepEqual(game.S.food, { x: 0, y: 3 });
  assert.equal(game.S.gameOver, false);
  assert.equal(game.S.speed, 120);
  assertWaiting(game, 'fresh load');
  assert.equal(hidden(game.els['snp-overlay']), true);
  assert.equal(hidden(game.els['snp-toast']), true);
  assert.deepEqual(scoreboard(game), ['0', '0', '00:00']);
  assert.deepEqual(game.saved(), gameSave({ food: { x: 0, y: 3 } }), 'saved in the original format');

  // The board: a 30x30 checkerboard of 20 px tiles, the food, then one 16 px
  // square per segment with the head in cyan, all glowing; glow off after.
  const frame = lastFrame(game.draw);
  assert.deepEqual(frame[0], ['clearRect', 0, 0, 600, 600]);
  const tiles = frame.filter((call) => call[0] === 'fillRect' && call[4] === 20);
  assert.equal(tiles.length, 900);
  assert.deepEqual(tiles[0].slice(1, 6), ['#0f172a', 0, 0, 20, 20]);
  assert.deepEqual(tiles[1].slice(1, 6), ['#111c34', 0, 20, 20, 20]);
  assert.deepEqual(tiles[30].slice(1, 6), ['#111c34', 20, 0, 20, 20]);
  assert.deepEqual(tiles[899].slice(1, 6), ['#0f172a', 580, 580, 20, 20]);
  assert.deepEqual(frame.slice(901, 904), [
    ['beginPath'],
    ['arc', 10, 70, 8, 0, Math.PI * 2],
    ['fill', '#f59e0b', '#f59e0b', 18]
  ]);
  assert.deepEqual(frame.slice(904), [
    ['fillRect', '#22d3ee', 302, 302, 16, 16, '#22d3ee', 12],
    ['fillRect', '#3b82f6', 282, 302, 16, 16, '#22d3ee', 12],
    ['fillRect', '#3b82f6', 262, 302, 16, 16, '#22d3ee', 12]
  ]);
  assert.equal(game.els['snp-game-canvas'].getContext('2d').shadowBlur, 0);

  // Before the fix that added the prompt the snake set off at once and hit
  // the right wall 1.8 s after load.
  play(t, 5000);
  assert.deepEqual(game.S.snake, START);
  assert.equal(game.S.gameOver, false);
  assert.equal(text(game, 'snp-timer'), '00:00', 'the clock waits too');
});

test('snake: every element the game uses is looked up once, in index.html, at init', (t) => {
  const game = prepareGame(t);
  assert.deepEqual(game.page.requested, [], 'loading looks nothing up');
  game.init();
  assert.deepEqual(game.page.requested.slice().sort(), GAME_IDS);
  assert.deepEqual(game.page.missing, []);

  const ids = idsInHtml(HTML);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const id of GAME_IDS) assert.ok(ids.includes(id), id);
});

test('snake: init runs once: a second call binds, starts and resets nothing', (t) => {
  const game = prepareGame(t, { save: gameSave({ score: 30, bestScore: 30 }) });
  const mockedSetInterval = globalThis.setInterval;
  const mockedClearInterval = globalThis.clearInterval;
  const live = new Set();
  let started = 0;
  globalThis.setInterval = (fn, ms) => {
    const id = mockedSetInterval(fn, ms);
    started++;
    live.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    live.delete(id);
    return mockedClearInterval(id);
  };
  try {
    game.init();
    assert.equal(started, 1);
    assert.equal(live.size, 1);

    // New games and speed changes keep one loop and one listener each.
    for (let round = 0; round < 3; round++) {
      click(game, 'snp-new-game');
      click(game, 'snp-restart-game');
      pressKey('Enter');
      chooseSpeed(game, round === 1 ? '85' : '120');
      pressKey('ArrowRight');
      play(t, 1800);
      assert.equal(game.S.gameOver, true, 'crashed into the right wall');
      click(game, 'snp-overlay-button');
      assert.equal(live.size, 1, 'round ' + round);
    }
    assert.equal(listenerCount(document, 'keydown'), 1);
    for (const id of BUTTON_IDS) assert.equal(listenerCount(game.els[id], 'click'), 1, id);
    assert.equal(listenerCount(game.els['snp-speed-select'], 'change'), 1);

    game.S.score = 30;
    const before = started;
    game.init();
    assert.equal(started, before, 'no second loop');
    assert.equal(live.size, 1);
    assert.equal(game.S.score, 30, 'no reset');
    assert.equal(listenerCount(document, 'keydown'), 1);
    for (const id of BUTTON_IDS) assert.equal(listenerCount(game.els[id], 'click'), 1, id);

    // One tick per period, so no second loop runs anywhere.
    pressKey('ArrowRight');
    play(t, 1200);
    assert.deepEqual(game.S.snake[0], { x: 25, y: 15 });
  } finally {
    globalThis.setInterval = mockedSetInterval;
    globalThis.clearInterval = mockedClearInterval;
  }
});

// ── Playing ─────────────────────────────────────────────────────────────────

test('snake: a tick moves the head one tile, drops the tail and redraws the board', (t) => {
  const game = startGame(t, { save: gameSave({ snake: cells([[5, 5], [4, 5], [3, 5]]), food: { x: 20, y: 20 } }) });
  pressKey('ArrowRight');

  play(t, 119);
  assert.deepEqual(game.S.snake[0], { x: 5, y: 5 }, 'not before 120 ms');
  play(t, 1);

  assert.deepEqual(game.S.snake, cells([[6, 5], [5, 5], [4, 5]]));
  assert.equal(game.S.score, 0);
  assert.deepEqual(game.saved().snake, game.S.snake);
  const frame = lastFrame(game.draw);
  assert.equal(frame.filter((call) => call[0] === 'fillRect').length, 900 + 3);
  assert.deepEqual(drawnSnake(game.draw), [
    { x: 6, y: 5, color: '#22d3ee' },
    { x: 5, y: 5, color: '#3b82f6' },
    { x: 4, y: 5, color: '#3b82f6' }
  ]);
  assert.deepEqual(drawnFood(game.draw), [{ x: 20, y: 20 }]);
});

test('snake: eating grows the snake, scores 10, moves the food to a free cell and toasts', (t) => {
  const game = startGame(t, { save: gameSave({ snake: cells([[5, 5], [4, 5], [3, 5]]), food: { x: 6, y: 5 } }) });
  game.rng.sequence([0.9, 0.9]);
  pressKey('ArrowRight');

  play(t, 120);

  assert.deepEqual(game.S.snake, cells([[6, 5], [5, 5], [4, 5], [3, 5]]));
  assert.deepEqual(game.S.food, { x: 27, y: 27 });
  assert.deepEqual(scoreboard(game), ['10', '10', '00:00']);
  assert.equal(game.saved().score, 10);
  assert.deepEqual(game.saved().food, { x: 27, y: 27 });
  assert.deepEqual(drawnFood(game.draw), [{ x: 27, y: 27 }]);
  assert.equal(text(game, 'snp-toast'), 'Energy node acquired +10');
  assert.equal(hidden(game.els['snp-toast']), false);
  t.mock.timers.tick(2199);
  assert.equal(hidden(game.els['snp-toast']), false);
  t.mock.timers.tick(1);
  assert.equal(hidden(game.els['snp-toast']), true);
});

test('snake: the best score only goes up', (t) => {
  const game = startGame(t, { save: gameSave({ snake: cells([[5, 5], [4, 5]]), food: { x: 6, y: 5 }, bestScore: 50 }) });
  pressKey('ArrowRight');
  play(t, 120);
  assert.deepEqual(scoreboard(game), ['10', '50', '00:00']);
  assert.equal(game.saved().bestScore, 50);
});

test('snake: a second toast within 2.2 s restarts the hide timer', (t) => {
  const game = startGame(t, { save: gameSave({ snake: cells([[5, 5], [4, 5]]), food: { x: 6, y: 5 } }) });
  pressKey('ArrowRight');
  play(t, 120);
  assert.equal(text(game, 'snp-toast'), 'Energy node acquired +10');
  play(t, 1000);
  pressKey('p');
  assert.equal(text(game, 'snp-toast'), 'Simulation paused');
  t.mock.timers.tick(2199);
  assert.equal(hidden(game.els['snp-toast']), false, '3.3 s after the first toast');
  t.mock.timers.tick(1);
  assert.equal(hidden(game.els['snp-toast']), true);
});

test('snake: hitting any wall ends the game and stops everything', (t) => {
  const walls = [
    { snake: [[29, 10], [28, 10]], key: 'ArrowRight' },
    { snake: [[0, 10], [1, 10]], key: 'ArrowLeft' },
    { snake: [[10, 0], [10, 1]], key: 'ArrowUp' },
    { snake: [[10, 29], [10, 28]], key: 'ArrowDown' }
  ];
  for (const wall of walls) {
    const game = startGame(t, { save: gameSave({ snake: cells(wall.snake), food: { x: 20, y: 20 }, score: 20, bestScore: 20 }) });
    pressKey(wall.key);

    play(t, 120);

    assert.equal(game.S.gameOver, true, wall.key);
    assert.deepEqual(game.S.snake, cells(wall.snake), 'the crashing head is not added');
    assertOverlay(game, 'System Failure', 'Snake crashed into the cyber grid.');
    assert.equal(game.saved().gameOver, true);
    assert.deepEqual(drawnHead(game.draw), { x: wall.snake[0][0], y: wall.snake[0][1], color: '#22d3ee' });

    pressKey('p');
    click(game, 'snp-pause-game');
    play(t, 2000);
    assert.deepEqual(game.S.snake, cells(wall.snake), 'a finished game no longer moves');
    assert.deepEqual(pauseButton(game), ['Pause', 'Pause game'], 'and cannot be paused');
    assert.deepEqual(scoreboard(game), ['20', '20', '00:00']);
  }
});

test('snake: running into its own body ends the game, the tail cell included', (t) => {
  // Head (5,5) heading left turns down into the body segment at (5,6).
  let game = startGame(t, { save: gameSave({ snake: cells([[5, 5], [6, 5], [6, 6], [5, 6], [4, 6]]) }) });
  pressKey('ArrowDown');
  play(t, 120);
  assert.equal(game.S.gameOver, true);
  assertOverlay(game, 'System Failure', 'Snake crashed into the cyber grid.');

  // A 2x2 loop: the tail (5,6) would move away on this tick, but the
  // original rules count it as a collision anyway.
  game = startGame(t, { save: gameSave({ snake: cells([[5, 5], [6, 5], [6, 6], [5, 6]]) }) });
  pressKey('ArrowDown');
  play(t, 120);
  assert.equal(game.S.gameOver, true);
});

test('snake: turns wait for the next tick, cannot reverse, and the last one in a tick wins', (t) => {
  const game = startGame(t, { save: gameSave({ snake: cells([[5, 5], [4, 5], [3, 5]]), food: { x: 20, y: 20 } }) });
  pressKey('ArrowRight');

  pressKey('ArrowLeft');
  assert.deepEqual(game.S.nextDirection, RIGHT, 'left reverses right');
  pressKey('ArrowUp');
  assert.deepEqual(game.S.nextDirection, UP);
  assert.deepEqual(game.S.direction, RIGHT, 'not before the tick');
  // Still checked against the heading in force, so up-then-left in one tick
  // cannot fold the snake back onto itself.
  pressKey('ArrowLeft');
  assert.deepEqual(game.S.nextDirection, UP);

  play(t, 120);
  assert.deepEqual(game.S.direction, UP);
  assert.deepEqual(game.S.snake[0], { x: 5, y: 4 });

  // Two turns in one tick: the second replaces the first.
  pressKey('ArrowRight');
  pressKey('ArrowLeft');
  play(t, 120);
  assert.deepEqual(game.S.snake[0], { x: 4, y: 4 });
  assert.equal(game.S.gameOver, false);
});

test('snake: pause freezes the snake and the clock; steering while paused only queues a turn', (t) => {
  const game = startGame(t);
  click(game, 'snp-pause-game');
  assertRunning(game, 'Start starts');
  assert.equal(hidden(game.els['snp-toast']), true, 'starting shows no toast');
  play(t, 120);
  assert.deepEqual(game.S.snake[0], { x: 16, y: 15 });

  pressKey('p');
  assert.equal(game.S.paused, true);
  assert.equal(game.S.waiting, false);
  assert.equal(hidden(game.els['snp-start-hint']), true, 'a manual pause shows no start prompt');
  assert.deepEqual(pauseButton(game), ['Resume', 'Resume game']);
  assert.equal(text(game, 'snp-toast'), 'Simulation paused');
  assert.equal(game.saved().paused, true);
  pressKey('ArrowUp');
  click(game, 'snp-down');
  assert.equal(game.S.paused, true, 'steering does not end a manual pause');
  assert.deepEqual(game.S.nextDirection, DOWN);
  play(t, 2000);
  assert.deepEqual(game.S.snake[0], { x: 16, y: 15 });
  assert.equal(text(game, 'snp-timer'), '00:00');

  click(game, 'snp-pause-game');
  assertRunning(game, 'resumed');
  assert.equal(text(game, 'snp-toast'), 'Simulation resumed');
  assert.equal(game.saved().paused, false);
  play(t, 120);
  assert.deepEqual(game.S.snake[0], { x: 16, y: 16 });
});

test('snake: New Game resets the snake, score and clock, keeps the best score and takes the speed', (t) => {
  const game = startGame(t, { save: gameSave({ snake: cells([[5, 5], [4, 5]]), score: 70, bestScore: 120, timer: 99 }) });
  pressKey('ArrowDown');
  play(t, 240);
  chooseSpeed(game, '85');
  game.rng.sequence([0.5, 0.5, 0.1, 0.2]); // (15,15) is on the new snake, (3,6) is free

  click(game, 'snp-new-game');

  assert.deepEqual(game.S.snake, START);
  assert.deepEqual(game.S.direction, RIGHT);
  assert.deepEqual(game.S.nextDirection, RIGHT);
  assert.deepEqual(game.S.food, { x: 3, y: 6 });
  assert.equal(game.rng.left(), 0, 'two draws for the food');
  assert.equal(game.S.gameOver, false);
  assert.equal(game.S.speed, 85);
  assertWaiting(game, 'a new game waits');
  assert.deepEqual(scoreboard(game), ['0', '120', '00:00']);
  assert.deepEqual(game.saved(), gameSave({ food: { x: 3, y: 6 }, bestScore: 120, speed: 85 }));
  assert.deepEqual(drawnSnake(game.draw).map(({ x, y }) => ({ x, y })), START);
  assert.deepEqual(drawnFood(game.draw), [{ x: 3, y: 6 }]);
});

test('snake: New Game, Restart, Play Again and Enter all start a new game that waits', (t) => {
  const game = startGame(t);
  const starts = {
    'New Game': () => click(game, 'snp-new-game'),
    Restart: () => click(game, 'snp-restart-game'),
    Enter: () => pressKey('Enter')
  };
  for (const [name, start] of Object.entries(starts)) {
    pressKey('ArrowDown');
    play(t, 360);
    assert.deepEqual(game.S.snake[0], { x: 15, y: 18 }, name);
    start();
    assert.deepEqual(game.S.snake, START, name);
    assert.equal(text(game, 'snp-score'), '0', name);
    assert.equal(text(game, 'snp-timer'), '00:00', name);
    assertWaiting(game, name);
    play(t, 3000);
    assert.deepEqual(game.S.snake, START, name + ' holds still');
  }

  // Play Again after a crash: 14 tiles to the right wall, the 15th tick hits it.
  pressKey('ArrowRight');
  play(t, 1800);
  assert.equal(game.S.gameOver, true);
  click(game, 'snp-overlay-button');
  assert.equal(hidden(game.els['snp-overlay']), true);
  assert.deepEqual(game.S.snake, START);
  assertWaiting(game, 'Play Again');
  play(t, 3000);
  assert.deepEqual(game.S.snake, START);
  assert.equal(game.S.gameOver, false);
});

// ── Speed and clock ─────────────────────────────────────────────────────────

test('snake: a speed change takes effect at once, is saved and never resets the game', (t) => {
  const game = startGame(t);
  chooseSpeed(game, '60');
  assert.equal(game.S.speed, 60);
  assert.equal(game.saved().speed, 60);
  assertWaiting(game, 'still waiting');

  pressKey('ArrowDown');
  play(t, 60);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 16 }, 'Insane: a tile per 60 ms');
  play(t, 120);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 18 });

  // Mid-period: the next tick comes a whole new period after the change.
  play(t, 30);
  chooseSpeed(game, '160');
  play(t, 159);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 18 });
  play(t, 1);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 19 });
  assert.equal(game.S.snake.length, 3, 'same game');
  assert.equal(game.saved().speed, 160);

  // While paused it stays paused; after a resume it runs at the new speed.
  pressKey('p');
  chooseSpeed(game, '85');
  assert.deepEqual(pauseButton(game), ['Resume', 'Resume game']);
  play(t, 500);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 19 });
  pressKey('p');
  play(t, 85);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 20 });

  // After a crash it is kept for the next game.
  play(t, 10 * 85);
  assert.equal(game.S.gameOver, true, 'hit the bottom wall');
  chooseSpeed(game, '60');
  assert.equal(game.saved().speed, 60);
  assert.equal(game.S.gameOver, true);
  click(game, 'snp-overlay-button');
  assert.equal(game.S.speed, 60);

  // A select holding no speed at all (no option picked) means Normal.
  chooseSpeed(game, '');
  assert.equal(game.S.speed, 120);
  game.els['snp-speed-select'].value = 'fast';
  click(game, 'snp-new-game');
  assert.equal(game.saved().speed, 120);
});

test('snake: the clock stops at a crash and formats past an hour', (t) => {
  let game = startGame(t, { save: gameSave({ timer: 3599 }) });
  assert.equal(text(game, 'snp-timer'), '59:59');
  pressKey('ArrowRight');
  play(t, 960);
  assert.equal(text(game, 'snp-timer'), '59:59', 'eight ticks');
  play(t, 120);
  assert.equal(text(game, 'snp-timer'), '60:00', 'nine ticks: 1080 ms');
  assert.equal(game.saved().timer, 3600, 'saved in whole seconds');
  play(t, 720);
  assert.equal(game.S.gameOver, true, 'the 15th tick hits the wall');
  play(t, 3000);
  assert.equal(text(game, 'snp-timer'), '60:00');

  game = startGame(t, { save: gameSave({ timer: 6004, snake: cells([[1, 1], [0, 1]]), speed: 60 }) });
  pressKey('ArrowDown');
  play(t, 1020);
  assert.equal(text(game, 'snp-timer'), '100:05', 'seventeen ticks of 60 ms');
});

// ── Saves ───────────────────────────────────────────────────────────────────

test('snake: a save written by the original version loads into a waiting game with every field kept', (t) => {
  const game = startGame(t, { raw: BASELINE_SAVE });

  assert.deepEqual(game.S.snake, cells([[8, 3], [8, 4], [8, 5], [7, 5]]));
  assert.deepEqual(game.S.direction, UP);
  assert.deepEqual(game.S.nextDirection, LEFT);
  assert.deepEqual(game.S.food, { x: 12, y: 2 });
  assert.equal(game.S.speed, 85);
  assert.equal(game.els['snp-speed-select'].value, '85');
  assert.deepEqual(scoreboard(game), ['40', '90', '01:15']);
  assertWaiting(game, 'a running game comes back waiting');
  assert.deepEqual(drawnSnake(game.draw).map(({ x, y }) => ({ x, y })), game.S.snake);
  assert.deepEqual(drawnFood(game.draw), [{ x: 12, y: 2 }]);

  play(t, 1000);
  assert.deepEqual(game.S.snake[0], { x: 8, y: 3 }, 'nothing moves before the first direction');
  pressKey('ArrowLeft');
  assertRunning(game, 'the first direction resumes it');
  play(t, 85);
  assert.deepEqual(game.S.snake[0], { x: 7, y: 3 });
  assert.equal(game.S.score, 40);

  // What it saves now, the original version reads: the same fields and types.
  const saved = game.saved();
  assert.deepEqual(Object.keys(saved).sort(), [
    'bestScore', 'direction', 'food', 'gameOver', 'nextDirection', 'paused', 'score',
    'snake', 'speed', 'timer', 'waiting'
  ]);
  assert.deepEqual(saved.snake, cells([[7, 3], [8, 3], [8, 4], [8, 5]]));
  assert.deepEqual([saved.score, saved.bestScore, saved.timer, saved.speed], [40, 90, 75, 85]);
  assert.deepEqual([saved.gameOver, saved.paused, saved.waiting], [false, false, false]);
});

test('snake: the original fresh-page save (loop ids null) loads as it was', (t) => {
  const game = startGame(t, { raw: BASELINE_FRESH_SAVE });
  assert.deepEqual(game.S.snake, START);
  assert.deepEqual(game.S.food, { x: 3, y: 6 });
  assert.deepEqual(scoreboard(game), ['0', '120', '00:00']);
  assertWaiting(game, 'fresh save');
});

test('snake: a reload brings back a running or paused game, waiting, with score, clock and speed', (t) => {
  let game = startGame(t);
  chooseSpeed(game, '85');
  pressKey('ArrowDown');
  play(t, 85 * 13);
  assert.equal(text(game, 'snp-timer'), '00:01');
  const snake = game.S.snake.slice();

  game = reload(t);
  assert.deepEqual(game.S.snake, snake);
  assert.equal(game.S.speed, 85);
  assert.equal(text(game, 'snp-timer'), '00:01');
  assertWaiting(game, 'a reload of a running game');
  assert.deepEqual(game.S.direction, DOWN);

  pressKey('ArrowRight');
  pressKey('p');
  assert.equal(game.saved().paused, true);
  game = reload(t);
  assertWaiting(game, 'a reload of a paused game');
  assert.deepEqual(game.S.nextDirection, RIGHT, 'the queued turn is kept');
});

test('snake: a finished game restored after a reload becomes a new game that waits', (t) => {
  // Lost: the head faces the wall it hit, so resuming it would crash again.
  let game = startGame(t, { save: gameSave({ snake: cells([[29, 10], [28, 10], [27, 10]]), score: 50, bestScore: 80, timer: 42, speed: 85 }) });
  pressKey('ArrowRight');
  play(t, 85);
  assert.equal(game.saved().gameOver, true);

  game = reload(t, { random: [0.9, 0.9] });
  assert.deepEqual(game.S.snake, START);
  assert.deepEqual(game.S.direction, RIGHT);
  assert.deepEqual(game.S.food, { x: 27, y: 27 });
  assert.deepEqual(scoreboard(game), ['0', '80', '00:00']);
  assert.equal(game.S.speed, 85, 'the speed is kept');
  assert.equal(game.els['snp-speed-select'].value, '85');
  assert.equal(game.S.gameOver, false);
  assert.equal(hidden(game.els['snp-overlay']), true);
  assertWaiting(game, 'the new game waits');
  assert.equal(game.saved().gameOver, false);
  assert.deepEqual(game.saved().snake, START);
  play(t, 3000);
  assert.deepEqual(game.S.snake, START, 'and holds still');

  // Won: the same.
  game = startGame(t, { save: gameSave({ score: 1490, bestScore: 1490, gameOver: true }) });
  assert.deepEqual(game.S.snake, START);
  assert.deepEqual(scoreboard(game), ['0', '1490', '00:00']);
  assertWaiting(game, 'a restored win also starts over');
});

test('snake: snpLoadState leaves the game alone when there is no readable save', (t) => {
  const game = startGame(t);
  pressKey('ArrowDown');
  play(t, 240);
  const snake = game.S.snake.slice();
  for (const raw of [null, '{not json', 'null', '7']) {
    if (raw === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, raw);
    assert.equal(game.snp.snpLoadState(), false, String(raw));
    assert.deepEqual(game.S.snake, snake);
    assertRunning(game, String(raw));
  }
  localStorage.setItem(KEY, JSON.stringify(gameSave({ score: 20, bestScore: 20 })));
  assert.equal(game.snp.snpLoadState(), true);
  assert.deepEqual(game.S.snake, START);
  assertWaiting(game, 'a readable save is restored');
});

// ── Keyboard and touch ──────────────────────────────────────────────────────

test('snake: the first arrow key or WASD starts a waiting game, a reversal included', (t) => {
  const game = startGame(t);
  pressKey('ArrowUp');
  assertRunning(game, 'ArrowUp');
  assert.equal(game.saved().paused, false);
  assert.equal(hidden(game.els['snp-toast']), true, 'starting shows no toast');
  play(t, 120);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 14 });

  for (const [key, direction] of [['w', UP], ['ArrowDown', DOWN], ['s', DOWN], ['ArrowRight', RIGHT], ['d', RIGHT]]) {
    click(game, 'snp-new-game');
    assertWaiting(game, 'before ' + key);
    pressKey(key);
    assertRunning(game, key);
    assert.deepEqual(game.S.nextDirection, direction, key);
  }

  // Left against the starting heading is refused as a turn but still starts
  // the game, heading right.
  for (const key of ['ArrowLeft', 'a']) {
    click(game, 'snp-new-game');
    pressKey(key);
    assertRunning(game, key);
    assert.deepEqual(game.S.nextDirection, RIGHT, key);
  }
  play(t, 120);
  assert.deepEqual(game.S.snake[0], { x: 16, y: 15 });

  click(game, 'snp-new-game');
  for (const key of ['x', ' ', 'Shift', 'Tab', '1']) pressKey(key);
  assertWaiting(game, 'other keys do not start it');
});

test('snake: a tap on a touch arrow starts a waiting game and steers a running one', (t) => {
  const game = startGame(t);
  for (const [id, direction] of [['snp-up', UP], ['snp-down', DOWN], ['snp-right', RIGHT], ['snp-left', RIGHT]]) {
    click(game, 'snp-new-game');
    assertWaiting(game, 'before ' + id);
    click(game, id);
    assertRunning(game, id);
    assert.deepEqual(game.S.nextDirection, direction, id);
  }
  play(t, 120);
  assert.deepEqual(game.S.snake[0], { x: 16, y: 15 });
  click(game, 'snp-up');
  play(t, 120);
  click(game, 'snp-left');
  play(t, 120);
  assert.deepEqual(game.S.snake[0], { x: 15, y: 14 });

  // After a crash a tap does not start anything.
  click(game, 'snp-up');
  play(t, 14 * 120 + 120);
  assert.equal(game.S.gameOver, true);
  click(game, 'snp-down');
  play(t, 500);
  assert.equal(game.S.gameOver, true);
  assert.equal(hidden(game.els['snp-overlay']), false);
});

test('snake: keys the game plays have their default action cancelled, other keys keep it', (t) => {
  const game = startGame(t);
  // Otherwise the arrows scroll the page while playing and Enter also clicks
  // a focused button.
  const played = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D', 'p', 'P', 'Enter'];
  for (const key of played) assert.equal(pressKey(key).defaultPrevented, true, key);
  assertWaiting(game, 'Enter came last');

  for (const key of [' ', 'Tab', 'Escape', 'Backspace', 'x', 'Shift', 'F5', 'PageDown', 'Home', '1']) {
    assert.equal(pressKey(key).defaultPrevented, false, JSON.stringify(key));
  }
  assertWaiting(game, 'keys the game does not play change nothing');

  // Space is not a game key, so it still works the focused button.
  const space = pressKey(' ', { target: game.els['snp-pause-game'] });
  assert.equal(space.defaultPrevented, false);
  assertRunning(game, 'Space on the focused Start button');
});

test('snake: Enter on a button the mouse left focused starts a new game, it never clicks it', (t) => {
  const game = startGame(t);
  const startButton = game.els['snp-pause-game'];
  // As reproduced in a browser: Start clicked with the mouse (it keeps the
  // focus), a crash into the right wall, then Enter. The browser's own Enter
  // on the focused button used to click Start too and send the new snake
  // off into the wall again.
  startButton.focus();
  startButton.click();
  play(t, 1800);
  assert.equal(game.S.gameOver, true);

  const enter = pressKey('Enter');
  assert.equal(enter.target, startButton);
  assert.equal(enter.defaultPrevented, true, 'Enter does not also click the focused button');
  assert.equal(hidden(game.els['snp-overlay']), true);
  assert.deepEqual(game.S.snake, START);
  assertWaiting(game, 'after Enter');
  play(t, 3000);
  assert.deepEqual(game.S.snake, START, 'the new snake holds still');
  assert.equal(text(game, 'snp-timer'), '00:00');

  // The same with any other button left focused.
  for (const id of BUTTON_IDS) {
    pressKey('ArrowDown', { target: document.body });
    play(t, 240);
    assertRunning(game, id + ': running before Enter');
    game.els[id].focus();
    assert.equal(pressKey('Enter').defaultPrevented, true, id);
    assert.deepEqual(game.S.snake, START, id);
    assertWaiting(game, 'Enter on a focused ' + id);
    play(t, 1200);
    assert.deepEqual(game.S.snake, START, id + ' holds still');
  }
});

test('snake: Ctrl, Cmd and Alt key combinations are left to the browser', (t) => {
  const game = startGame(t);
  const modifiers = ['ctrlKey', 'metaKey', 'altKey'];
  for (const modifier of modifiers) {
    for (const key of ['ArrowUp', 'w', 'p', 'Enter']) {
      assert.equal(pressKey(key, { [modifier]: true }).defaultPrevented, false, modifier + ' + ' + key);
    }
    assertWaiting(game, modifier + ' combinations do not start the game');
  }

  pressKey('ArrowDown');
  play(t, 240);
  game.S.score = 30;
  for (const modifier of modifiers) {
    for (const key of ['ArrowLeft', 'a', 'p', 'Enter']) pressKey(key, { [modifier]: true });
  }
  assertRunning(game, 'still running');
  assert.deepEqual(game.S.nextDirection, DOWN);
  assert.equal(game.S.score, 30, 'no new game');
  assert.deepEqual(game.S.snake[0], { x: 15, y: 17 });
});

test('snake: keys with nothing focused reach the game whatever the event target', (t) => {
  const game = startGame(t);
  document.dispatchEvent(keyEvent('ArrowUp'));
  assertRunning(game, 'a keydown on document');
  assert.deepEqual(game.S.nextDirection, UP);

  const html = stubElement('html');
  document.documentElement = html;
  try {
    const event = keyEvent('ArrowRight', { target: html });
    game.snp.snpHandleKeydown(event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(game.S.nextDirection, RIGHT, 'a keydown on <html>');
  } finally {
    delete document.documentElement;
  }

  const bare = keyEvent('ArrowLeft');
  bare.target = null;
  game.snp.snpHandleKeydown(bare);
  assert.equal(bare.defaultPrevented, true, 'no target at all');
});

test('snake: a keydown without a key (Chrome autofill) is ignored', (t) => {
  const game = startGame(t);
  for (const key of [undefined, null]) assert.equal(pressKey(key).defaultPrevented, false, String(key));
  assert.equal(pressKey(undefined, { code: 'KeyW' }).defaultPrevented, false, 'a code alone is not enough');
  document.body.dispatchEvent(createEvent('keydown'));
  assertWaiting(game, 'nothing started');

  pressKey('ArrowUp');
  game.S.score = 30;
  pressKey(undefined);
  assertRunning(game, 'nothing paused');
  assert.equal(game.S.score, 30);
});

test('snake: the Pause/Resume button aria-label follows its label', (t) => {
  const game = startGame(t);
  assert.deepEqual(pauseButton(game), ['Start', 'Start game'], 'page load');
  click(game, 'snp-pause-game');
  assert.deepEqual(pauseButton(game), ['Pause', 'Pause game'], 'started');
  click(game, 'snp-pause-game');
  assert.deepEqual(pauseButton(game), ['Resume', 'Resume game'], 'paused by the button');
  pressKey('p');
  assert.deepEqual(pauseButton(game), ['Pause', 'Pause game'], 'resumed by P');
  pressKey('p');
  assert.deepEqual(pauseButton(game), ['Resume', 'Resume game'], 'paused by P');
  click(game, 'snp-restart-game');
  assert.deepEqual(pauseButton(game), ['Start', 'Start game'], 'Restart during a pause');
  pressKey('d');
  assert.deepEqual(pauseButton(game), ['Pause', 'Pause game'], 'started by a direction');
  play(t, 1800);
  assert.equal(game.S.gameOver, true);
  click(game, 'snp-overlay-button');
  assert.deepEqual(pauseButton(game), ['Start', 'Start game'], 'Play Again');
});

// ── Start-up ────────────────────────────────────────────────────────────────

test('snake: loading under Node only exports the game: no listener, timer, frame or save', (t) => {
  resetStubs();
  const spies = ['setInterval', 'setTimeout', 'requestAnimationFrame'].map((name) => t.mock.method(globalThis, name));
  for (const readyState of ['complete', 'loading']) {
    document.readyState = readyState;
    try {
      const snp = loadScript(SCRIPT);
      assert.equal(typeof snp.snpInit, 'function', readyState);
      assert.deepEqual(snp.snpState.snake, [], 'no game yet');
    } finally {
      document.readyState = 'complete';
    }
  }
  assert.equal(listenerCount(document), 0, 'not even DOMContentLoaded while loading');
  assert.equal(listenerCount(window), 0);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
  assert.equal(flushAnimationFrames(), 0);
  assert.equal(localStorage.length, 0);
});

function bootGame(t, options = {}) {
  resetStubs();
  mockTimers(t);
  randomFor(t).reseed();
  const page = createPage(gamePageSpec());
  const draw = recordCanvas(page.els['snp-game-canvas'].getContext('2d'));
  const boot = bootLikeBrowser(SCRIPT, page, { readyState: options.readyState });
  return { boot, els: page.els, page, draw, saved: () => JSON.parse(localStorage.getItem(KEY)) };
}

test('snake: in a browser the game starts at once on a page that has loaded', (t) => {
  const game = bootGame(t);
  assert.deepEqual(game.boot.exposed, {}, 'nothing leaks onto window');
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(hidden(game.els['snp-start-hint']), false);
  assert.deepEqual(pauseButton(game), ['Start', 'Start game']);
  assert.deepEqual(game.saved().snake, START);
  assert.equal(game.saved().waiting, true);
  assert.deepEqual(drawnSnake(game.draw).map(({ x, y }) => ({ x, y })), START);

  pressKey('ArrowUp');
  play(t, 120);
  assert.deepEqual(game.saved().snake[0], { x: 15, y: 14 });
  assert.deepEqual(drawnHead(game.draw), { x: 15, y: 14, color: '#22d3ee' });
});

test('snake: in a browser a page still loading starts the game on DOMContentLoaded', (t) => {
  const game = bootGame(t, { readyState: 'loading' });
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(document, 'keydown'), 0);
  assert.equal(game.draw.length, 0);
  assert.equal(localStorage.getItem(KEY), null);
  assert.equal(hidden(game.els['snp-start-hint']), true);

  game.boot.ready();

  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(hidden(game.els['snp-start-hint']), false);
  assert.deepEqual(game.saved().snake, START);
  assert.deepEqual(drawnSnake(game.draw).map(({ x, y }) => ({ x, y })), START);
});

// ── Game logic and save checks (no DOM) ─────────────────────────────────────

let pureModule = null;
const pure = () => pureModule || (pureModule = loadScript(SCRIPT));

test('snake: snpStartSnake, snpNextHead, snpIsWall and snpIsReversal', () => {
  const snp = pure();
  const snake = snp.snpStartSnake();
  assert.deepEqual(snake, START);
  snake[0].x = 99;
  assert.deepEqual(snp.snpStartSnake(), START, 'a fresh copy every time');

  assert.deepEqual(snp.snpNextHead({ x: 5, y: 5 }, UP), { x: 5, y: 4 });
  assert.deepEqual(snp.snpNextHead({ x: 5, y: 5 }, LEFT), { x: 4, y: 5 });
  for (const cell of [[-1, 0], [0, -1], [30, 0], [0, 30], [30, 30]]) {
    assert.equal(snp.snpIsWall({ x: cell[0], y: cell[1] }), true, String(cell));
  }
  for (const cell of [[0, 0], [29, 0], [0, 29], [29, 29], [15, 15]]) {
    assert.equal(snp.snpIsWall({ x: cell[0], y: cell[1] }), false, String(cell));
  }
  assert.equal(snp.snpIsReversal(RIGHT, LEFT), true);
  assert.equal(snp.snpIsReversal(UP, DOWN), true);
  assert.equal(snp.snpIsReversal(RIGHT, UP), false);
  assert.equal(snp.snpIsReversal(RIGHT, RIGHT), false);
});

test('snake: snpHitsBody counts every segment, the tail included', () => {
  const snp = pure();
  const snake = cells([[5, 5], [6, 5], [6, 6], [5, 6]]);
  assert.equal(snp.snpHitsBody(snake, { x: 5, y: 6 }), true, 'the tail');
  assert.equal(snp.snpHitsBody(snake, { x: 6, y: 6 }), true);
  assert.equal(snp.snpHitsBody(snake, { x: 4, y: 5 }), false);
});

test('snake: snpPickFood draws x then y until the cell is free', () => {
  const snp = pure();
  const values = [0.5, 0.5, 0.1, 0.2];
  const random = () => values.shift();
  assert.deepEqual(snp.snpPickFood(START, random), { x: 3, y: 6 }, '(15,15) is taken');
  assert.equal(values.length, 0);
  assert.deepEqual(snp.snpPickFood([], () => 0.9999), { x: 29, y: 29 });

  const free = { x: 17, y: 23 };
  const full = [];
  for (let x = 0; x < 30; x++) {
    for (let y = 0; y < 30; y++) if (x !== free.x || y !== free.y) full.push({ x, y });
  }
  assert.deepEqual(snp.snpPickFood(full, seeded()), free);
});

test('snake: snpStep moves, eats, crashes and wins', () => {
  const snp = pure();
  const state = (snake, food, extra) => Object.assign({
    snake: cells(snake), direction: RIGHT, nextDirection: RIGHT, food, score: 0, bestScore: 0
  }, extra);
  const never = () => { throw new Error('no food drawn'); };

  let s = state([[5, 5], [4, 5], [3, 5]], { x: 20, y: 20 });
  assert.equal(snp.snpStep(s, never), 'move');
  assert.deepEqual(s.snake, cells([[6, 5], [5, 5], [4, 5]]));

  s = state([[5, 5], [4, 5], [3, 5]], { x: 20, y: 20 }, { nextDirection: UP });
  assert.equal(snp.snpStep(s, never), 'move');
  assert.deepEqual(s.direction, UP, 'the queued turn takes effect');
  assert.deepEqual(s.snake[0], { x: 5, y: 4 });

  s = state([[5, 5], [4, 5], [3, 5]], { x: 6, y: 5 }, { score: 40, bestScore: 40 });
  assert.equal(snp.snpStep(s, () => 0.9), 'eat');
  assert.deepEqual(s.snake, cells([[6, 5], [5, 5], [4, 5], [3, 5]]));
  assert.deepEqual([s.score, s.bestScore], [50, 50]);
  assert.deepEqual(s.food, { x: 27, y: 27 });

  s = state([[5, 5], [4, 5]], { x: 6, y: 5 }, { bestScore: 90 });
  snp.snpStep(s, () => 0.9);
  assert.deepEqual([s.score, s.bestScore], [10, 90]);

  for (const [snake, direction] of [[[[29, 3], [28, 3]], RIGHT], [[[0, 3], [1, 3]], LEFT], [[[3, 0], [3, 1]], UP], [[[3, 29], [3, 28]], DOWN]]) {
    s = state(snake, { x: 20, y: 20 }, { direction, nextDirection: direction });
    assert.equal(snp.snpStep(s, never), 'crash', JSON.stringify(direction));
    assert.deepEqual(s.snake, cells(snake), 'nothing moves');
  }
  s = state([[5, 5], [6, 5], [6, 6], [5, 6]], { x: 20, y: 20 }, { direction: LEFT, nextDirection: DOWN });
  assert.equal(snp.snpStep(s, never), 'crash');
  assert.deepEqual(s.direction, DOWN);

  s = state([], { x: 29, y: 4 }, { snake: nearWinSnake(), score: 1460, bestScore: 1460 });
  assert.equal(snp.snpStep(s, () => 0.5), 'win');
  assert.equal(s.snake.length, 150);
  assert.equal(s.score, 1470);

  s = state([], { x: 28, y: 4 }, { snake: nearWinSnake().slice(1) });
  assert.equal(snp.snpStep(s, () => 0.5), 'eat', '149 segments do not win');
});

test('snake: snpKeyAction reads the key value first, then the physical key', () => {
  const snp = pure();
  const action = (key, props) => snp.snpKeyAction(keyEvent(key, props));
  const table = [
    ['ArrowUp', {}, 'up'], ['ArrowDown', {}, 'down'], ['ArrowLeft', {}, 'left'], ['ArrowRight', {}, 'right'],
    ['ArrowUp', { code: 'Numpad8' }, 'up'],
    ['w', {}, 'up'], ['a', {}, 'left'], ['s', {}, 'down'], ['d', {}, 'right'], ['p', {}, 'pause'],
    ['W', {}, 'up'], ['A', {}, 'left'], ['S', {}, 'down'], ['D', {}, 'right'], ['P', {}, 'pause'],
    // Non-Latin layouts: the key value is no game key, so the physical key decides.
    ['ц', { code: 'KeyW' }, 'up'], ['ф', { code: 'KeyA' }, 'left'], ['і', { code: 'KeyS' }, 'down'],
    ['в', { code: 'KeyD' }, 'right'], ['з', { code: 'KeyP' }, 'pause'],
    // Latin layouts: a game letter wins over the position it has on QWERTY.
    ['s', { code: 'KeyD' }, 'down'], ['d', { code: 'KeyG' }, 'right'], ['p', { code: 'KeyR' }, 'pause'], // Colemak
    ['S', { code: 'KeyD' }, 'down'], // Colemak with Caps Lock
    ['d', { code: 'KeyW' }, 'right'], ['w', { code: 'KeyR' }, 'up'], ['p', { code: 'KeyO' }, 'pause'], // Workman
    ['w', { code: 'KeyComma' }, 'up'], ['s', { code: 'KeySemicolon' }, 'down'], ['d', { code: 'KeyH' }, 'right'], // Dvorak
    // AZERTY: Z sits where W is, Q where A is; the printed W and A still work.
    ['z', { code: 'KeyW' }, 'up'], ['w', { code: 'KeyZ' }, 'up'], ['q', { code: 'KeyA' }, 'left'], ['a', { code: 'KeyQ' }, 'left'],
    ['w', { code: '' }, 'up'], ['p', { code: undefined }, 'pause'],
    ['Enter', {}, 'new'], ['Enter', { code: 'NumpadEnter' }, 'new'],
    [' ', {}, null], ['x', {}, null], ['Shift', {}, null], ['Tab', {}, null], ['Escape', {}, null],
    ['F5', {}, null], ['8', { code: 'Numpad8' }, null], ['constructor', {}, null], ['toString', {}, null],
    [undefined, {}, null], [undefined, { code: 'KeyW' }, null]
  ];
  for (const [key, props, expected] of table) {
    assert.equal(action(key, props), expected, JSON.stringify([key, props]));
  }
  assert.equal(snp.snpKeyAction({ key: 13 }), null, 'a key that is not text');
});

test('snake: snpFormatTime pads minutes and seconds', () => {
  const snp = pure();
  assert.equal(snp.snpFormatTime(0), '00:00');
  assert.equal(snp.snpFormatTime(9), '00:09');
  assert.equal(snp.snpFormatTime(59), '00:59');
  assert.equal(snp.snpFormatTime(61), '01:01');
  assert.equal(snp.snpFormatTime(600), '10:00');
  assert.equal(snp.snpFormatTime(3600), '60:00');
  assert.equal(snp.snpFormatTime(6005), '100:05');
});

test('snake: snpParseSave turns away what is not a save', () => {
  const snp = pure();
  for (const raw of [undefined, null, 42, '', '{oops', 'null', '42', '"snake"', 'true', '[]', '[1,2,3]']) {
    assert.equal(snp.snpParseSave(raw, Math.random), null, JSON.stringify(raw));
  }
  assert.deepEqual(snp.snpParseSave('{}', Math.random), { bestScore: 0, speed: null, game: null });
});

test('snake: snpParseSave keeps every field of a good save', () => {
  const snp = pure();
  const never = () => { throw new Error('no food drawn'); };
  assert.deepEqual(snp.snpParseSave(BASELINE_SAVE, never), {
    bestScore: 90,
    speed: 85,
    game: {
      snake: cells([[8, 3], [8, 4], [8, 5], [7, 5]]),
      direction: UP,
      nextDirection: LEFT,
      food: { x: 12, y: 2 },
      score: 40,
      timer: 75
    }
  });
  for (const speed of [160, 120, 85, 60]) {
    assert.equal(snp.snpParseSave(JSON.stringify(gameSave({ speed })), never).speed, speed);
  }
  const one = snp.snpParseSave(JSON.stringify(gameSave({ snake: [{ x: 0, y: 0 }], direction: DOWN, nextDirection: RIGHT })), never);
  assert.deepEqual([one.game.direction, one.game.nextDirection], [DOWN, RIGHT], 'a one-cell snake keeps its heading');
});

test('snake: snpParseSave drops a finished game or a broken snake but keeps best score and speed', () => {
  const snp = pure();
  const broken = [
    'abc', {}, [], null, 42, [{}, {}], cells([[40, 40], [39, 40]]), [{ x: -1, y: 0 }],
    [{ x: 1.5, y: 0 }], [{ x: '1', y: 0 }], [{ x: 5, y: null }], [null],
    cells([[5, 5], [6, 5], [5, 5]]), cells([[5, 5], [7, 5]]), cells([[5, 5], [6, 6]]),
    // 150 joined-up cells: the length of a won game, which never plays on.
    [{ x: 29, y: 4 }].concat(nearWinSnake())
  ];
  for (const snake of broken) {
    const parsed = snp.snpParseSave(JSON.stringify(gameSave({ snake, bestScore: 70, speed: 60 })), Math.random);
    assert.deepEqual(parsed, { bestScore: 70, speed: 60, game: null }, JSON.stringify(snake).slice(0, 60));
  }
  // One cell shorter (149) still plays on, so the cap sits exactly at 150.
  const longest = snp.snpParseSave(JSON.stringify(gameSave({ snake: nearWinSnake(), bestScore: 70, speed: 60 })), Math.random);
  assert.notEqual(longest.game, null, 'a 149-cell snake plays on');
  assert.deepEqual(longest.game.snake, nearWinSnake());
  assert.deepEqual(
    snp.snpParseSave(JSON.stringify(gameSave({ gameOver: true, score: 90, bestScore: 80, speed: 160 })), Math.random),
    { bestScore: 90, speed: 160, game: null },
    'finished; the best score is at least the score'
  );
  // Like the original, any truthy gameOver counts as finished; a falsy or
  // missing one plays on.
  for (const gameOver of [1, 'true', 'yes', {}]) {
    assert.equal(snp.snpParseSave(JSON.stringify(gameSave({ gameOver })), Math.random).game, null, String(gameOver));
  }
  for (const gameOver of [false, 0, '', null, undefined]) {
    assert.notEqual(snp.snpParseSave(JSON.stringify(gameSave({ gameOver })), Math.random).game, null, String(gameOver));
  }
});

test('snake: snpParseSave repairs directions, food, numbers and speed', () => {
  const snp = pure();
  const parse = (fields, random = () => { throw new Error('no food drawn'); }) =>
    snp.snpParseSave(JSON.stringify(gameSave(Object.assign({ snake: cells([[5, 5], [4, 5]]), food: { x: 20, y: 20 } }, fields))), random);

  // The heading is where the head points; a bad queued turn is the heading.
  for (const direction of ['up', { x: 1, y: 1 }, { x: 0, y: 0 }, LEFT, UP, null]) {
    assert.deepEqual(parse({ direction }).game.direction, RIGHT, JSON.stringify(direction));
  }
  for (const nextDirection of [LEFT, 'up', { x: 2, y: 0 }, { x: 1, y: 1 }, null]) {
    assert.deepEqual(parse({ nextDirection }).game.nextDirection, RIGHT, JSON.stringify(nextDirection));
  }
  assert.deepEqual(parse({ nextDirection: UP }).game.nextDirection, UP);
  assert.deepEqual(
    snp.snpParseSave(JSON.stringify(gameSave({ snake: [{ x: 3, y: 3 }], direction: 'up' })), Math.random).game.direction,
    RIGHT,
    'a one-cell snake with no heading heads right'
  );

  for (const food of [{ x: 99, y: 99 }, { x: 5, y: 5 }, { x: 4, y: 5 }, { x: 1.5, y: 2 }, 'x', null]) {
    const values = [0.5, 0.5];
    assert.deepEqual(parse({ food }, () => values.shift()).game.food, { x: 15, y: 15 }, JSON.stringify(food));
  }

  const numbers = parse({ score: '50', bestScore: -10, timer: '42' });
  assert.deepEqual([numbers.game.score, numbers.bestScore, numbers.game.timer], [0, 0, 0]);
  const fractions = parse({ score: 1.5, bestScore: 2.5, timer: 3.7 });
  assert.deepEqual([fractions.game.score, fractions.bestScore, fractions.game.timer], [0, 0, 0]);
  assert.equal(parse({ score: 60, bestScore: 40 }).bestScore, 60, 'the best score is at least the score');
  assert.equal(parse({ timer: 75 }).game.timer, 75);

  for (const speed of [5, '85', 100, null, 0]) assert.equal(parse({ speed }).speed, null, JSON.stringify(speed));
});

// ── Static checks: index.html, style.css, script.js ─────────────────────────

function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '\'\'');
}

test('snake: script.js is one strict IIFE in ES5 syntax', () => {
  const code = codeOnly(SOURCE).trim();
  assert.ok(code.startsWith('(function () {'), 'starts with the IIFE');
  assert.ok(code.endsWith('})();'), 'ends with it');
  assert.equal(SOURCE.match(/'use strict';/g).length, 1);
  const forbidden = {
    'arrow function': /=>/,
    let: /\blet\b/,
    const: /\bconst\b/,
    class: /\bclass\b/,
    'template literal': /`/,
    'optional chaining': /\?\./,
    spread: /\.\.\./,
    'module syntax': /\b(import|export)\b/,
    async: /\b(async|await)\b/
  };
  for (const [name, pattern] of Object.entries(forbidden)) {
    assert.doesNotMatch(code, pattern, name);
  }
});

test('snake: every id, class, CSS variable and the storage key is snp-prefixed', (t) => {
  const markup = embedMarkup(HTML);
  for (const id of idsInHtml(HTML)) assert.match(id, /^snp-/, id);
  const classes = [...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  assert.ok(classes.length > 40);
  for (const name of classes) assert.match(name, /^snp-/, name);

  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.match(selector, /^\.snp-/, selector);
      for (const name of selector.match(/\.[\w-]+/g)) assert.match(name, /^\.snp-/, selector);
    }
  }
  for (const name of CSS.match(/--[\w-]+/g)) assert.match(name, /^--snp-/, name);
  for (const literal of SOURCE.match(/'snp-[\w-]+'/g)) {
    const name = literal.slice(1, -1);
    assert.ok(idsInHtml(HTML).includes(name) || classes.includes(name) || name === KEY, name);
  }

  const game = startGame(t);
  pressKey('ArrowUp');
  play(t, 120);
  pressKey('p');
  assert.equal(localStorage.length, 1);
  assert.equal(localStorage.key(0), KEY, 'the only storage key');
  assert.equal(game.S.paused, true);
});

test('snake: script, stylesheet and markup are safe inside the WordPress embed', () => {
  const markup = embedMarkup(HTML);
  assert.ok(markup.startsWith('<div class="snp-wrapper">'));
  assert.deepEqual(embedSafety(SOURCE), []);
  assert.deepEqual(embedSafety(CSS), []);
  assert.deepEqual(embedSafety(markup), []);
  for (const id of idsInHtml(HTML)) assert.ok(markup.includes('id="' + id + '"'), id + ' is in the embedded markup');
});

test('snake: index.html offers the documented speeds, controls and board', () => {
  const spec = htmlPageSpec(HTML);
  const select = HTML.slice(HTML.indexOf('<select'), HTML.indexOf('</select>'));
  const options = [...select.matchAll(/<option value="(\d+)"( selected)?>([^<]+)<\/option>/g)]
    .map((m) => [m[1], m[3], Boolean(m[2])]);
  assert.deepEqual(options, [['160', 'Easy', false], ['120', 'Normal', true], ['85', 'Hard', false], ['60', 'Insane', false]]);
  assert.equal(spec['snp-speed-select'].value, '120');
  assert.equal(spec['snp-game-canvas'].width, 600);
  assert.equal(spec['snp-game-canvas'].height, 600);
  assert.equal(spec['snp-pause-game'].attributes['aria-label'], 'Start game');
  assert.equal(spec['snp-start-hint'].attributes.role, 'status');
  for (const id of ['snp-start-hint', 'snp-overlay', 'snp-toast']) {
    assert.ok(spec[id].className.split(' ').includes('snp-hidden'), id + ' starts hidden');
  }
  const arrows = { 'snp-up': 'Move up', 'snp-left': 'Move left', 'snp-down': 'Move down', 'snp-right': 'Move right' };
  for (const [id, label] of Object.entries(arrows)) {
    assert.equal(spec[id].tagName, 'button');
    assert.equal(spec[id].attributes['aria-label'], label);
  }
  assert.match(HTML, /Press an arrow key, WASD or tap a direction to start/);
});

test('snake: the stylesheet hides with .snp-hidden and keeps the start prompt out of the way', () => {
  const rules = cssRules(CSS);
  for (const width of [320, 1280]) {
    assert.equal(declsAt(rules, '.snp-hidden', width).display, 'none');
    const hint = declsAt(rules, '.snp-start-hint', width);
    assert.equal(hint.display, undefined, 'sets no display, so .snp-hidden hides it');
    assert.equal(hint['pointer-events'], 'none');
  }
  assert.equal(declsAt(rules, '.snp-start-hint', 400).width, 'calc(100% - 40px)');
  assert.equal(declsAt(rules, '.snp-start-hint', 401).width, 'calc(100% - 72px)');
});

test('snake: phones (320-414px) get one column, full-width controls and arrows that fit', () => {
  const rules = cssRules(CSS);
  for (const width of [320, 360, 375, 414]) {
    const at = (selector) => declsAt(rules, selector, width);
    assert.equal(at('.snp-main')['grid-template-columns'], '1fr', width);
    assert.equal(at('.snp-toolbar')['flex-direction'], 'column');
    assert.equal(at('.snp-button').width, '100%');
    assert.equal(at('.snp-select').width, '100%');
    assert.equal(at('.snp-wrapper').padding, '14px');
    assert.equal(at('.snp-game-canvas').width, '100%');
    assert.equal(at('.snp-game-canvas')['max-width'], '100%');
    const button = parseInt(at('.snp-mobile-button').width, 10);
    assert.equal(button, width <= 400 ? 58 : 64);
    const gap = parseInt(at('.snp-mobile-middle').gap, 10);
    assert.ok(3 * button + 2 * gap <= width - 2 * 14, width + 'px: the row of three arrows fits');
    assert.ok(parseInt(at('.snp-status-card')['min-width'], 10) <= width - 2 * 14);
    assert.equal(at('.snp-header-top')['flex-wrap'], 'wrap');
    assert.equal(at('.snp-status-panel')['flex-wrap'], 'wrap');
  }
  assert.equal(declsAt(rules, '.snp-main', 1280)['grid-template-columns'], '1fr 320px');
  assert.equal(declsAt(rules, '.snp-wrapper', 1280).padding, '24px');
});
