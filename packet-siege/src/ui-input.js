// ── ui: input: pointer and touch on the field, the keys, focus, pause on blur, binding ──
// Owns the keyboard map, the pointer handlers (pointer events, or mouse
// and click where the browser has none), focus and visibility handling and
// pksBind, which adds every listener once.  Uses core (PKS_W, PKS_H, the
// grid), render (pksCellAt, PKS_DECOM), ui-page, ui-frame, ui-screens and
// ui-level.
//
// The game's keys act while the field (the canvas) has the focus: there
// they neither scroll the page nor reach the host page's own shortcuts.
// Elsewhere in the frame only F (fullscreen) and Esc (leave maximised) act
// (ui-frame); outside the frame every key is the page's.
// Esc pauses only on the page: in fullscreen the browser's Esc leaves
// fullscreen, and maximised Esc leaves that, as the browser's would.

var PKS_KEYS = {
  '1': 'card', '2': 'card', '3': 'card', '4': 'card', '5': 'card', '6': 'card', '7': 'card', '8': 'card', '9': 'card',
  '0': 'card', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  enter: 'place', ' ': 'place', x: 'decom', delete: 'decom', p: 'pause', escape: 'escape', s: 'speed',
  f: 'fullscreen'
};
// The physical keys, for other keyboard layouts.
var PKS_CODES = {
  Digit1: 'card', Digit2: 'card', Digit3: 'card', Digit4: 'card', Digit5: 'card', Digit6: 'card', Digit7: 'card',
  Digit8: 'card', Digit9: 'card', Digit0: 'card', KeyX: 'decom', KeyP: 'pause', KeyS: 'speed', KeyF: 'fullscreen'
};
var PKS_MOVES = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
var PKS_KEY_COMMANDS = {
  card: pksKeyCard, up: pksKeyMove, down: pksKeyMove, left: pksKeyMove, right: pksKeyMove,
  place: pksKeyPlace, decom: pksKeyDecom, pause: pksTogglePause, escape: pksEscape, speed: pksToggleSpeed,
  fullscreen: pksToggleFullscreen
};
// The keys that act while the level takes no input (paused, over).
var PKS_KEYS_ALWAYS = { pause: true, escape: true, fullscreen: true };
var PKS_TAP_SLOP = 10;        // px a press may move and still be a tap
// The fullscreen change events (each with its error twin), plain and webkit.
var PKS_FULLSCREEN_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'];

// The action of a key by its value, then by the physical key; or null.
function pksKeyAction(event) {
  if (typeof event.key !== 'string') return null;
  var key = event.key.toLowerCase();
  if (pksOwn(PKS_KEYS, key)) return PKS_KEYS[key];
  return pksOwn(PKS_CODES, event.code) ? PKS_CODES[event.code] : null;
}

// The action of a key the game takes: none with Ctrl, Alt or Meta or while
// composing.
function pksOwnKey(event) {
  var action = pksKeyAction(event);
  return action && !(event.ctrlKey || event.altKey || event.metaKey || event.isComposing) ? action : null;
}

function pksHandleKeydown(event) {
  var action = pksOwnKey(event);
  if (!action || event.defaultPrevented) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat && !PKS_MOVES[action]) return;
  if (PKS_KEYS_ALWAYS[action] || pksAccepting()) PKS_KEY_COMMANDS[action](event);
}

function pksHandleKeyup(event) {
  if (pksOwnKey(event)) event.stopPropagation();
}

// 1-9 and 0: the card of that key (0 the tenth).
function pksKeyCard(event) {
  var digit = /^[0-9]$/.exec(event.key) || /[0-9]$/.exec(event.code);
  var index = (Number(digit[0]) + 9) % 10;
  var cards = pksRuntime.sim.cards;
  if (index < cards.length) pksSelect(cards[index].id);
  else pksSetStatus('No card ' + digit[0] + ' on this level: the cards are ' + pksKeysText(cards.length) + ' and X.');
}

function pksKeyDecom() {
  pksSelect(PKS_DECOM);
}

// The keyboard cursor, on the middle lane in play at the rack the first
// time.
function pksCursor() {
  var rt = pksRuntime;
  if (!rt.cursor) {
    var lanes = rt.sim.level.lanes;
    rt.cursor = { lane: lanes[Math.floor(lanes.length / 2)], col: 0 };
  }
  return rt.cursor;
}

function pksKeyMove(event) {
  var rt = pksRuntime;
  var c = pksCursor();
  var move = PKS_MOVES[pksKeyAction(event)];
  c.lane = Math.max(0, Math.min(PKS_LANES - 1, c.lane + move[0]));
  c.col = Math.max(0, Math.min(PKS_COLS - 1, c.col + move[1]));
  rt.aim = { lane: c.lane, col: c.col };
  pksDrawFrame();
}

function pksKeyPlace() {
  var c = pksCursor();
  pksActAt(c.lane, c.col);
}

// ── pointer ──

// The cell under a pointer event, or null off the floor.
function pksPointerCell(event) {
  var rect = pksRuntime.els.canvas.getBoundingClientRect();
  return pksCellAt((event.clientX - rect.left) * PKS_W / rect.width, (event.clientY - rect.top) * PKS_H / rect.height);
}

// The pointer over the field: the ghost follows it.
function pksHandleMove(event) {
  pksRuntime.aim = pksPointerCell(event);
}

function pksHandleLeave() {
  pksRuntime.aim = null;
}

// A press: the main button or a finger; the field takes the keys.
function pksHandleDown(event) {
  if (event.button > 0) return;
  pksRuntime.press = { id: event.pointerId, x: event.clientX, y: event.clientY };
  pksFocus(pksRuntime.els.canvas);
}

// A press let go where it began is a tap; a drag (the page scrolling under a
// finger) is not.
function pksHandleUp(event) {
  var press = pksRuntime.press;
  pksRuntime.press = null;
  if (!press || press.id !== event.pointerId) return;
  if (Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y) > PKS_TAP_SLOP) return;
  pksTap(event);
}

function pksHandleCancel() {
  pksRuntime.press = null;
}

// Without pointer events: a click is the tap.
function pksHandleClick(event) {
  pksFocus(pksRuntime.els.canvas);
  pksTap(event);
}

function pksTap(event) {
  var cell = pksPointerCell(event);
  pksRuntime.aim = cell;
  if (cell) pksActAt(cell.lane, cell.col);
}

// ── focus and visibility ──

function pksHandleFocus() {
  pksRuntime.focused = true;
  pksDrawFrame();
}

function pksHandleBlur() {
  pksRuntime.focused = false;
  pksDrawFrame();
}

// A hidden tab pauses the level (and so saves it); shown again it waits for
// Resume.  Leaving the page (pagehide) saves it too.
function pksHandleVisibility() {
  if (document.hidden) pksPause();
}

// ── binding ──

function pksBind() {
  var els = pksRuntime.els;
  var canvas = els.canvas;
  canvas.addEventListener('keydown', pksHandleKeydown);
  canvas.addEventListener('keyup', pksHandleKeyup);
  canvas.addEventListener('focus', pksHandleFocus);
  canvas.addEventListener('blur', pksHandleBlur);
  if (window.PointerEvent) {
    canvas.addEventListener('pointermove', pksHandleMove);
    canvas.addEventListener('pointerleave', pksHandleLeave);
    canvas.addEventListener('pointerdown', pksHandleDown);
    canvas.addEventListener('pointerup', pksHandleUp);
    canvas.addEventListener('pointercancel', pksHandleCancel);
  } else {
    canvas.addEventListener('mousemove', pksHandleMove);
    canvas.addEventListener('mouseleave', pksHandleLeave);
    canvas.addEventListener('click', pksHandleClick);
  }
  els.frame.addEventListener('keydown', pksHandleFrameKey);
  els.codexOpen.addEventListener('click', pksOpenCodex);
  els.codexBack.addEventListener('click', pksToSelect);
  els.helpOpen.addEventListener('click', pksHelpFromSelect);
  els.selectFull.addEventListener('click', pksToggleFullscreen);
  els.helpClose.addEventListener('click', pksCloseHelp);
  els.warningClose.addEventListener('click', pksHideWarning);
  els.loadoutStart.addEventListener('click', pksLoadoutStart);
  els.loadoutBack.addEventListener('click', pksToSelect);
  els.pause.addEventListener('click', pksGameButton(pksTogglePause));
  els.speed.addEventListener('click', pksGameButton(pksToggleSpeed));
  els.levels.addEventListener('click', pksAskLevels);
  els.full.addEventListener('click', pksGameButton(pksToggleFullscreen));
  els.resume.addEventListener('click', pksResume);
  els.restart.addEventListener('click', pksAskRestart);
  els.pauseHelp.addEventListener('click', pksHelpFromPause);
  els.quit.addEventListener('click', pksAskLevels);
  els.confirmYes.addEventListener('click', pksConfirmYes);
  els.confirmNo.addEventListener('click', pksConfirmNo);
  els.next.addEventListener('click', pksNextLevel);
  els.replay.addEventListener('click', pksReplay);
  els.resultLevels.addEventListener('click', pksToSelect);
  els.runResume.addEventListener('click', pksRunResume);
  els.runFresh.addEventListener('click', pksRunFresh);
  document.addEventListener('visibilitychange', pksHandleVisibility);
  for (var i = 0; i < PKS_FULLSCREEN_EVENTS.length; i++) {
    document.addEventListener(PKS_FULLSCREEN_EVENTS[i], pksHandleFullscreen);
    document.addEventListener(PKS_FULLSCREEN_EVENTS[i].replace('change', 'error'), pksFullscreenRefused);
  }
  window.addEventListener('blur', pksPause);
  window.addEventListener('storage', pksHandleStorage);
  window.addEventListener('pagehide', pksSnapshot);
  pksWatchSize();
}

function pksRestart() {
  pksStartLevel(pksRuntime.level, pksRuntime.cards);
}

function pksNextLevel() {
  pksChooseLevel(pksRuntime.level + 1);
}

function pksReplay() {
  pksChooseLevel(pksRuntime.level);
}
