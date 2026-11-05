// Snake Game — script.js
// Prefix: snp-
// Dependencies: none.
//
// Canvas Snake on a 30x30 grid (20 px tiles on the 600x600 #snp-game-canvas).
//
// Flow: a new game (page load, New Game, Restart, Play Again, Enter) and a
// restored save wait behind the #snp-start-hint prompt (state.waiting) and
// begin on the first direction key, touch arrow, P or the Start button. A
// manual pause (P or Pause) is only ended by P or Resume; steering while
// paused just sets the next turn.
//
// Loop: one setInterval at the difficulty's tick length asks for an animation
// frame and the frame runs one tick. At most one frame is pending at a time,
// so a hidden tab (throttled intervals, no frames) never queues up ticks that
// would all run at once when it comes back.
//
// Clock: the timer counts the time the snake has been moving. Every tick adds
// its length in ms, the one that eats, wins or crashes included; the display
// and the save show whole seconds.
//
// Saves: the game is saved to localStorage under 'snp-snake-state' after every
// tick, start, pause, new game and speed change, in the original format (the
// fields of snpState; timer in whole seconds). Loading checks every field
// (snpParseSave): a finished game or a save without a usable snake becomes a
// new game that keeps a valid best score and speed, and a running or paused
// game comes back waiting. Storage that throws (site data blocked, quota
// full) never stops the game: it just plays without saving.
//
// Keys: arrows / WASD steer, P pauses, Enter starts a new game. Letters are
// read by the key value in any case (Caps Lock works, and on Latin layouts
// such as Colemak or Dvorak the keys labelled W A S D P play); a key whose
// value is no game key falls back to its physical key (event.code), so
// Cyrillic and other non-Latin layouts still play. The game only takes a key
// when nothing on the host page has the focus, or the focus is on one of its
// own controls or on a host element that holds the game, and a key it plays
// has its default action cancelled: Enter never also clicks the focused
// button and the arrows never scroll the page. Ctrl / Cmd / Alt combinations
// stay with the browser.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser snpInit runs on DOMContentLoaded, or
// at once when the page has already loaded. snpInit looks the elements up.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var SAVE_KEY = 'snp-snake-state';
  var WRAPPER_CLASS = 'snp-wrapper';
  var HIDDEN_CLASS = 'snp-hidden';

  var TILE_COUNT = 30;
  var TILE_PX = 20;
  var WIN_LENGTH = 150;
  var POINTS_PER_FOOD = 10;
  // Tick lengths in ms, as the difficulty select offers them.
  var SPEEDS = [160, 120, 85, 60];
  var DEFAULT_SPEED = 120;
  var TOAST_MS = 2200;

  var DIRECTIONS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };

  // A new snake: head first, heading right.
  var START_SNAKE = [
    { x: 15, y: 15 },
    { x: 14, y: 15 },
    { x: 13, y: 15 }
  ];
  var START_DIRECTION = DIRECTIONS.right;

  var COLORS = {
    tileEven: '#0f172a',
    tileOdd: '#111c34',
    head: '#22d3ee',
    body: '#3b82f6',
    snakeGlow: '#22d3ee',
    food: '#f59e0b'
  };
  var SNAKE_GLOW_BLUR = 12;
  var FOOD_GLOW_BLUR = 18;
  var FOOD_RADIUS = 8;
  // Gap between a snake segment and the edge of its tile.
  var SEGMENT_INSET = 2;

  var TEXT = {
    crashTitle: 'System Failure',
    crashText: 'Snake crashed into the cyber grid.',
    winTitle: 'Grid Dominated',
    winText: 'You reached maximum snake length.',
    foodEaten: 'Energy node acquired +10',
    paused: 'Simulation paused',
    resumed: 'Simulation resumed'
  };

  // Physical keys (KeyboardEvent.code), read only when the key value is not
  // a game key, so non-Latin layouts still play (the W key types 'ц' on a
  // Ukrainian layout) while Latin layouts keep the letters their keys show
  // (on Colemak the key labelled S has the code KeyD and still steers down).
  var CODE_ACTIONS = {
    KeyW: 'up',
    KeyA: 'left',
    KeyS: 'down',
    KeyD: 'right',
    KeyP: 'pause'
  };

  // Key values (KeyboardEvent.key, lower-cased so Caps Lock plays), read
  // first.
  var KEY_ACTIONS = {
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
    w: 'up',
    a: 'left',
    s: 'down',
    d: 'right',
    p: 'pause',
    enter: 'new'
  };

  // The on-screen arrows (ids in index.html) and the direction each steers.
  var DIRECTION_BUTTONS = {
    'snp-up': 'up',
    'snp-down': 'down',
    'snp-left': 'left',
    'snp-right': 'right'
  };

  // ── State ─────────────────────────────────────────────────────────────────

  // The game, exactly as it is saved (see snpSaveState).
  var snpState = {
    snake: [],
    direction: { x: 1, y: 0 },
    nextDirection: { x: 1, y: 0 },
    food: { x: 10, y: 10 },
    score: 0,
    bestScore: 0,
    timer: 0,
    gameOver: false,
    paused: false,
    waiting: false,
    speed: DEFAULT_SPEED
  };

  // Runtime only, never saved.
  var ui = null;            // the elements, looked up by snpInit
  var loopId = null;        // the game interval
  var framePending = false; // a tick frame was requested and has not run yet
  var clockRemainderMs = 0; // moving time not yet counted as a whole second
  var toastTimer = null;

  // ── Game logic (no DOM) ───────────────────────────────────────────────────

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function snpCopyCell(cell) {
    return { x: cell.x, y: cell.y };
  }

  function snpSameCell(a, b) {
    return a.x === b.x && a.y === b.y;
  }

  function snpStartSnake() {
    return START_SNAKE.map(snpCopyCell);
  }

  function snpNextHead(head, direction) {
    return { x: head.x + direction.x, y: head.y + direction.y };
  }

  function snpIsWall(cell) {
    return cell.x < 0 || cell.y < 0 || cell.x >= TILE_COUNT || cell.y >= TILE_COUNT;
  }

  function snpOccupies(snake, cell) {
    for (var i = 0; i < snake.length; i++) {
      if (snpSameCell(snake[i], cell)) {
        return true;
      }
    }
    return false;
  }

  // Every segment counts, the tail included, although the tail would move
  // away on this tick (the original rules).
  function snpHitsBody(snake, head) {
    return snpOccupies(snake, head);
  }

  function snpIsReversal(direction, turn) {
    return turn.x === -direction.x && turn.y === -direction.y;
  }

  // A random free cell: draws x then y from random() until the cell is off
  // the snake.
  function snpPickFood(snake, random) {
    var cell;

    do {
      cell = {
        x: Math.floor(random() * TILE_COUNT),
        y: Math.floor(random() * TILE_COUNT)
      };
    } while (snpOccupies(snake, cell));

    return cell;
  }

  // One move of the game: the queued turn takes effect and the head moves a
  // tile. Returns 'crash' (into a wall or the body; the snake stays put),
  // 'move', 'eat' (grown by one, +10, new food) or 'win' (grown to
  // WIN_LENGTH by eating).
  function snpStep(state, random) {
    state.direction = state.nextDirection;

    var head = snpNextHead(state.snake[0], state.direction);

    if (snpIsWall(head) || snpHitsBody(state.snake, head)) {
      return 'crash';
    }

    state.snake.unshift(head);

    if (!snpSameCell(head, state.food)) {
      state.snake.pop();
      return 'move';
    }

    state.score += POINTS_PER_FOOD;
    state.bestScore = Math.max(state.bestScore, state.score);
    state.food = snpPickFood(state.snake, random);

    return state.snake.length >= WIN_LENGTH ? 'win' : 'eat';
  }

  // 'up' / 'down' / 'left' / 'right' / 'pause' / 'new' for a keydown, or null.
  // A keydown without a key (Chrome autofill sends those) is null.
  function snpKeyAction(event) {
    if (typeof event.key !== 'string') {
      return null;
    }

    var key = event.key.toLowerCase();

    if (hasOwn(KEY_ACTIONS, key)) {
      return KEY_ACTIONS[key];
    }

    if (typeof event.code === 'string' && hasOwn(CODE_ACTIONS, event.code)) {
      return CODE_ACTIONS[event.code];
    }

    return null;
  }

  function snpPad2(number) {
    return number < 10 ? '0' + number : String(number);
  }

  // Whole seconds as MM:SS; minutes keep counting past 59 (61:05).
  function snpFormatTime(seconds) {
    return snpPad2(Math.floor(seconds / 60)) + ':' + snpPad2(seconds % 60);
  }

  // ── Save checks (no DOM) ──────────────────────────────────────────────────

  // A finite, non-negative whole number.
  function snpIsCount(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value;
  }

  function snpIsCell(value) {
    return !!value && typeof value === 'object' &&
      snpIsCount(value.x) && snpIsCount(value.y) &&
      value.x < TILE_COUNT && value.y < TILE_COUNT;
  }

  function snpIsDirection(value) {
    return !!value && typeof value === 'object' && (
      (value.x === 0 && (value.y === 1 || value.y === -1)) ||
      (value.y === 0 && (value.x === 1 || value.x === -1))
    );
  }

  function snpIsSpeed(value) {
    return SPEEDS.indexOf(value) !== -1;
  }

  // A snake that can play on: 1 to WIN_LENGTH - 1 cells on the grid, no cell
  // twice, each segment one tile from the next.
  function snpIsSnake(value) {
    var seen = {};

    if (!Array.isArray(value) || value.length < 1 || value.length >= WIN_LENGTH) {
      return false;
    }

    for (var i = 0; i < value.length; i++) {
      var cell = value[i];

      if (!snpIsCell(cell) || seen[cell.x + ',' + cell.y]) {
        return false;
      }

      if (i > 0 && Math.abs(cell.x - value[i - 1].x) + Math.abs(cell.y - value[i - 1].y) !== 1) {
        return false;
      }

      seen[cell.x + ',' + cell.y] = true;
    }

    return true;
  }

  // The saved text, checked field by field. Returns null when it is no save
  // at all (missing, not JSON, not an object), else
  //   { bestScore, speed, game }
  // bestScore: a whole number >= 0 and >= the saved score (else 0 / score);
  // speed: one of SPEEDS, or null; game: null when the game cannot go on
  // (gameOver set to anything truthy, as the original read it, or no usable
  // snake), else { snake, direction, nextDirection, food, score, timer }.
  // In game the direction is the way the head points (head minus neck; the
  // saved one, or right, for a one-cell snake), a queued turn that is not a
  // direction or reverses it becomes the direction, food off the grid or on
  // the snake is drawn again with random, and a broken score or timer is 0.
  function snpParseSave(raw, random) {
    var data;

    if (typeof raw !== 'string') {
      return null;
    }

    try {
      data = JSON.parse(raw);
    } catch (error) {
      return null;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }

    var score = snpIsCount(data.score) ? data.score : 0;
    var result = {
      bestScore: Math.max(snpIsCount(data.bestScore) ? data.bestScore : 0, score),
      speed: snpIsSpeed(data.speed) ? data.speed : null,
      game: null
    };

    if (data.gameOver || !snpIsSnake(data.snake)) {
      return result;
    }

    var snake = data.snake.map(snpCopyCell);
    var direction;

    if (snake.length > 1) {
      direction = { x: snake[0].x - snake[1].x, y: snake[0].y - snake[1].y };
    } else {
      direction = snpCopyCell(snpIsDirection(data.direction) ? data.direction : START_DIRECTION);
    }

    var turnOk = snpIsDirection(data.nextDirection) && !snpIsReversal(direction, data.nextDirection);
    var foodOk = snpIsCell(data.food) && !snpOccupies(snake, data.food);

    result.game = {
      snake: snake,
      direction: direction,
      nextDirection: snpCopyCell(turnOk ? data.nextDirection : direction),
      food: foodOk ? snpCopyCell(data.food) : snpPickFood(snake, random),
      score: score,
      timer: snpIsCount(data.timer) ? data.timer : 0
    };

    return result;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  // Storage access never throws: blocked site data makes even reading
  // localStorage throw, and a full quota makes setItem throw.
  function snpStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function snpStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      // Blocked or full: play on without saving.
    }
  }

  function snpSaveState() {
    snpStorageSet(SAVE_KEY, JSON.stringify(snpState));
  }

  // Restores the saved game (see snpParseSave) as a waiting game, or starts a
  // new one when the save's game cannot go on. Returns false when there is no
  // save to read, and leaves the game alone then.
  function snpLoadState() {
    var saved = snpParseSave(snpStorageGet(SAVE_KEY), Math.random);

    if (!saved) {
      return false;
    }

    snpState.bestScore = saved.bestScore;

    if (saved.speed !== null) {
      ui.difficulty.value = String(saved.speed);
    }

    if (!saved.game) {
      snpReset();
      return true;
    }

    snpState.snake = saved.game.snake;
    snpState.direction = saved.game.direction;
    snpState.nextDirection = saved.game.nextDirection;
    snpState.food = saved.game.food;
    snpState.score = saved.game.score;
    snpState.timer = saved.game.timer;
    snpState.gameOver = false;
    snpState.speed = snpSelectedSpeed();
    clockRemainderMs = 0;

    snpWaitForStart();
    return true;
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  // The difficulty select's tick length (Normal if it holds anything else).
  function snpSelectedSpeed() {
    var speed = parseInt(ui.difficulty.value, 10);

    return snpIsSpeed(speed) ? speed : DEFAULT_SPEED;
  }

  function snpReset() {
    snpState.snake = snpStartSnake();
    snpState.direction = snpCopyCell(START_DIRECTION);
    snpState.nextDirection = snpCopyCell(START_DIRECTION);
    snpState.score = 0;
    snpState.timer = 0;
    snpState.gameOver = false;
    snpState.speed = snpSelectedSpeed();
    snpState.food = snpPickFood(snpState.snake, Math.random);
    clockRemainderMs = 0;

    snpHideOverlay();
    snpWaitForStart();
    snpUpdateUi();
    snpSaveState();
  }

  function snpHandleNewGame() {
    snpReset();
    snpRender();
  }

  // Hold the game still (paused) behind the start prompt until the first
  // direction, P or the Start button (see snpStartPlay).
  function snpWaitForStart() {
    snpState.paused = true;
    snpState.waiting = true;
    snpSetPauseLabel('Start');
    ui.startHint.classList.remove(HIDDEN_CLASS);
  }

  function snpStartPlay() {
    snpState.paused = false;
    snpState.waiting = false;
    snpSetPauseLabel('Pause');
    ui.startHint.classList.add(HIDDEN_CLASS);
    snpSaveState();
  }

  function snpTogglePause() {
    if (snpState.gameOver) {
      return;
    }

    if (snpState.waiting) {
      snpStartPlay();
      return;
    }

    snpState.paused = !snpState.paused;
    snpSetPauseLabel(snpState.paused ? 'Resume' : 'Pause');
    snpShowToast(snpState.paused ? TEXT.paused : TEXT.resumed);
    snpSaveState();
  }

  // Queues a turn for the next tick unless it reverses the heading in force.
  // Any direction starts a waiting game, a refused reversal included.
  function snpSetDirection(direction) {
    if (!snpIsReversal(snpState.direction, direction)) {
      snpState.nextDirection = snpCopyCell(direction);
    }

    if (snpState.waiting) {
      snpStartPlay();
    }
  }

  function snpGameTick() {
    if (snpState.gameOver || snpState.paused) {
      return;
    }

    var outcome = snpStep(snpState, Math.random);

    snpCountTick();

    if (outcome === 'eat' || outcome === 'win') {
      snpShowToast(TEXT.foodEaten);
    }

    if (outcome === 'crash') {
      snpEndGame(TEXT.crashTitle, TEXT.crashText);
    } else if (outcome === 'win') {
      snpEndGame(TEXT.winTitle, TEXT.winText);
    }

    // Draw before saving, so the board keeps up even if saving fails.
    snpUpdateUi();
    snpRender();
    snpSaveState();
  }

  // The clock counts moving time: each tick adds its length, the one that
  // eats, wins or crashes included (snpGameTick counts it before the outcome).
  function snpCountTick() {
    clockRemainderMs += snpState.speed;

    while (clockRemainderMs >= 1000) {
      clockRemainderMs -= 1000;
      snpState.timer += 1;
    }
  }

  function snpEndGame(title, text) {
    snpState.gameOver = true;
    ui.overlayTitle.textContent = title;
    ui.overlayText.textContent = text;
    ui.overlay.classList.remove(HIDDEN_CLASS);
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  function snpRestartLoop() {
    clearInterval(loopId);
    loopId = setInterval(snpRequestTick, snpState.speed);
  }

  function snpRequestTick() {
    if (framePending) {
      return;
    }

    framePending = true;
    requestAnimationFrame(snpRunTick);
  }

  function snpRunTick() {
    framePending = false;
    snpGameTick();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function snpRender() {
    var context = ui.context;

    context.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
    snpDrawGrid(context);
    snpDrawFood(context, snpState.food);
    snpDrawSnake(context, snpState.snake);
  }

  function snpDrawGrid(context) {
    for (var x = 0; x < TILE_COUNT; x++) {
      for (var y = 0; y < TILE_COUNT; y++) {
        context.fillStyle = (x + y) % 2 === 0 ? COLORS.tileEven : COLORS.tileOdd;
        context.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
      }
    }
  }

  function snpDrawFood(context, food) {
    context.fillStyle = COLORS.food;
    context.shadowColor = COLORS.food;
    context.shadowBlur = FOOD_GLOW_BLUR;

    context.beginPath();
    context.arc(
      food.x * TILE_PX + TILE_PX / 2,
      food.y * TILE_PX + TILE_PX / 2,
      FOOD_RADIUS,
      0,
      Math.PI * 2
    );
    context.fill();

    context.shadowBlur = 0;
  }

  function snpDrawSnake(context, snake) {
    var size = TILE_PX - 2 * SEGMENT_INSET;

    context.shadowColor = COLORS.snakeGlow;
    context.shadowBlur = SNAKE_GLOW_BLUR;

    for (var i = 0; i < snake.length; i++) {
      context.fillStyle = i === 0 ? COLORS.head : COLORS.body;
      context.fillRect(
        snake[i].x * TILE_PX + SEGMENT_INSET,
        snake[i].y * TILE_PX + SEGMENT_INSET,
        size,
        size
      );
    }

    context.shadowBlur = 0;
  }

  // ── Page UI ───────────────────────────────────────────────────────────────

  function snpUpdateUi() {
    ui.score.textContent = String(snpState.score);
    ui.bestScore.textContent = String(snpState.bestScore);
    ui.timer.textContent = snpFormatTime(snpState.timer);
  }

  // The Pause/Resume button reads Start, Pause or Resume; its aria-label
  // ("Start game", "Pause game", "Resume game") follows the visible text.
  function snpSetPauseLabel(label) {
    ui.pause.textContent = label;
    ui.pause.setAttribute('aria-label', label + ' game');
  }

  function snpHideOverlay() {
    ui.overlay.classList.add(HIDDEN_CLASS);
  }

  function snpShowToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.remove(HIDDEN_CLASS);

    clearTimeout(toastTimer);
    toastTimer = setTimeout(snpHideToast, TOAST_MS);
  }

  function snpHideToast() {
    ui.toast.classList.add(HIDDEN_CLASS);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  function snpIsInsideGame(node) {
    for (; node; node = node.parentNode) {
      if (node.classList && node.classList.contains(WRAPPER_CLASS)) {
        return true;
      }
    }
    return false;
  }

  // Whether node is an ancestor of the game, such as a theme's content area
  // with tabindex="-1" (a skip-link target), which takes the focus when the
  // board is clicked.
  function snpHoldsGame(node) {
    for (var parent = ui.canvas.parentNode; parent; parent = parent.parentNode) {
      if (parent === node) {
        return true;
      }
    }
    return false;
  }

  // Whether a key pressed on target is the game's: nothing has the focus (the
  // page body), the focus is on one of the game's own controls inside
  // .snp-wrapper, or on a host element that holds the game. Links, buttons
  // and fields of the host page never hold the game, so they keep their keys.
  // The game's difficulty select is one of its controls: after a mouse pick
  // it keeps the focus, and an arrow then steers instead of also changing the
  // difficulty.
  function snpOwnsKeyTarget(target) {
    return !target || target === document || target === document.body ||
      target === document.documentElement || snpIsInsideGame(target) ||
      snpHoldsGame(target);
  }

  // Physical keyboard (see the header). Held-down P and Enter act once; held
  // arrows keep steering, which is harmless.
  function snpHandleKeydown(event) {
    var action = snpKeyAction(event);

    if (!action || event.ctrlKey || event.metaKey || event.altKey || !snpOwnsKeyTarget(event.target)) {
      return;
    }

    event.preventDefault();

    if (hasOwn(DIRECTIONS, action)) {
      snpSetDirection(DIRECTIONS[action]);
    } else if (event.repeat) {
      return;
    } else if (action === 'pause') {
      snpTogglePause();
    } else {
      snpHandleNewGame();
    }
  }

  function snpHandleSpeedChange() {
    snpState.speed = snpSelectedSpeed();
    snpRestartLoop();
    snpSaveState();
  }

  function snpDirectionButtonHandler(name) {
    return function () {
      snpSetDirection(DIRECTIONS[name]);
    };
  }

  function snpBindEvents() {
    document.addEventListener('keydown', snpHandleKeydown);

    ui.newGame.addEventListener('click', snpHandleNewGame);
    ui.restart.addEventListener('click', snpHandleNewGame);
    ui.overlayButton.addEventListener('click', snpHandleNewGame);
    ui.pause.addEventListener('click', snpTogglePause);
    ui.difficulty.addEventListener('change', snpHandleSpeedChange);

    Object.keys(DIRECTION_BUTTONS).forEach(function (id) {
      document.getElementById(id).addEventListener('click', snpDirectionButtonHandler(DIRECTION_BUTTONS[id]));
    });
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function snpFindElements() {
    var canvas = document.getElementById('snp-game-canvas');

    return {
      canvas: canvas,
      context: canvas.getContext('2d'),
      score: document.getElementById('snp-score'),
      bestScore: document.getElementById('snp-best-score'),
      timer: document.getElementById('snp-timer'),
      newGame: document.getElementById('snp-new-game'),
      restart: document.getElementById('snp-restart-game'),
      pause: document.getElementById('snp-pause-game'),
      difficulty: document.getElementById('snp-speed-select'),
      startHint: document.getElementById('snp-start-hint'),
      overlay: document.getElementById('snp-overlay'),
      overlayTitle: document.getElementById('snp-overlay-title'),
      overlayText: document.getElementById('snp-overlay-text'),
      overlayButton: document.getElementById('snp-overlay-button'),
      toast: document.getElementById('snp-toast')
    };
  }

  // Runs once; a second call changes nothing.
  function snpInit() {
    if (ui) {
      return;
    }

    ui = snpFindElements();
    snpBindEvents();

    if (!snpLoadState()) {
      snpReset();
    }

    snpRestartLoop();
    snpUpdateUi();
    snpRender();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      snpState: snpState,
      snpInit: snpInit,
      snpReset: snpReset,
      snpGameTick: snpGameTick,
      snpSetDirection: snpSetDirection,
      snpTogglePause: snpTogglePause,
      snpHandleKeydown: snpHandleKeydown,
      snpSaveState: snpSaveState,
      snpLoadState: snpLoadState,
      snpFormatTime: snpFormatTime,
      snpStartSnake: snpStartSnake,
      snpNextHead: snpNextHead,
      snpIsWall: snpIsWall,
      snpHitsBody: snpHitsBody,
      snpIsReversal: snpIsReversal,
      snpPickFood: snpPickFood,
      snpStep: snpStep,
      snpKeyAction: snpKeyAction,
      snpParseSave: snpParseSave
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', snpInit);
  } else {
    snpInit();
  }
})();
