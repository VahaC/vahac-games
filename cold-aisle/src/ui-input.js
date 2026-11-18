// ── ui-input: keys, the mouse, pointer lock, focus and visibility, binding every listener ──
// Owns CDA_KEYS, CDA_CODES, CDA_HELD, CDA_PRESS, CDA_MOUSE_BASE,
// CDA_MOUSE_SPIKE, CDA_EDGE_ZONE, CDA_LOCK_RETRY, the key and mouse
// handlers, cdaReadInput (the sim's input for one step), cdaNextSlot (the
// wheel), pointer lock (cdaRequestLock, cdaReleaseLock), cdaReleaseInput
// and cdaBind.  Uses core, tables (CDA_PLAYER, CDA_TOOLS, CDA_TOOL), sfx
// (cdaSfxUnlock, cdaSfxUi), ui-text and ui-page; inside function bodies
// also ui-hud, ui-screens and ui-loop.
//
// Keys by the physical key: event.code names the action (CDA_CODES), so
// WASD, E, J, F, M, P and the digits sit in the same place on every layout
// (Dvorak, Colemak, AZERTY, Ukrainian).  A key whose code the game does not
// use is not the game's, whatever letter the layout puts there (Colemak's
// physical R types 'p' and does not pause).  Only an event without a code
// (some remote and virtual keyboards) is read by event.key (CDA_KEYS).
// The game's keys act on the canvas only while the level is live (cdaLive:
// the level screen, no gate, no overlay): there every key the game takes
// neither scrolls the page nor moves the focus (Tab is the map) nor reaches
// the host page.  The canvas is in the tab order only then (tabindex 0,
// else -1, set by cdaShow); a canvas that has the focus on any other screen
// lets every key through to the frame, so Tab leaves it and Esc goes back.
// Ctrl, Alt and Meta combinations are never the game's (fire is never Ctrl:
// Ctrl+W closes the tab).  Elsewhere in the frame (the menu buttons) F is
// fullscreen, M mute, P resumes a paused level and Esc goes back (closes an
// overlay, resumes, leaves a briefing or the upgrades); outside the frame
// every key is the page's.
// Keys already down: the frame tracks Enter and Space (CDA_PRESS, the keys
// that press a focused button).  When the game moves the focus (cdaFocus)
// the ones down then are stale: their auto-repeat and their release are
// cancelled, so Enter held to fire or Space held to use never presses Retry
// or Next on the screen the level's end brings up.  A fresh press (no
// repeat) is a press again.
// Held actions (move, strafe, turn, fire, use) stay down until their keyup
// and are let go when the canvas or the window loses the focus or the level
// pauses, so nobody keeps walking.
// The mouse turns the view by movementX (CDA_MOUSE_BASE radians a pixel
// times the saved sensitivity, one event's movement clamped to
// CDA_MOUSE_SPIKE px, as browsers send spikes), gathered between steps and
// consumed by the next step; the left button fires; the wheel switches
// tools.  Two modes:
//   with Pointer Lock (asked for by Click to play, Resume and a click on the
//     view): every movement turns; the first movement after the lock
//     changes is dropped (browsers send a jump with it).  Losing the lock
//     pauses (the browser's Esc gives the mouse back).
//   without it (not asked yet, refused, or no API: browsers refuse often,
//     Chrome for about a second after the user's Esc, embedded browsers
//     always): while the level runs and the pointer is over the stage, its
//     movement turns the same way, the cursor is hidden over the stage
//     (cda-stage--live), and as the cursor stops at the stage's edge, a
//     pointer resting in the outer CDA_EDGE_ZONE of the width on either side
//     keeps turning toward that side (rt.edge, radians a second: 0 at the
//     zone's inner edge up to CDA_PLAYER.turn at the stage's edge) until it
//     moves back or leaves the stage.  The lock taken turns this off.
// A left click on the view while the level runs and the lock is not held
// asks for the lock again, unless the last refusal was less than
// CDA_LOCK_RETRY ms before it (by the events' timeStamp).  Once the lock has
// been refused since it was last held, or where the API is missing, the
// same click also fires; before any refusal it only takes the lock.  The
// game says once a page load that the mouse turns without the lock.

var CDA_KEYS = {
  w: 'forward', arrowup: 'forward', s: 'back', arrowdown: 'back', a: 'left', d: 'right',
  arrowleft: 'turnLeft', arrowright: 'turnRight', j: 'fire', enter: 'fire', e: 'use', ' ': 'use',
  '1': 'tool', '2': 'tool', '3': 'tool', tab: 'map', p: 'pause', escape: 'escape', f: 'fullscreen', m: 'mute'
};
// The physical keys (see the header).
var CDA_CODES = {
  KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', KeyD: 'right',
  ArrowLeft: 'turnLeft', ArrowRight: 'turnRight', KeyJ: 'fire', Enter: 'fire', NumpadEnter: 'fire', KeyE: 'use', Space: 'use',
  Digit1: 'tool', Digit2: 'tool', Digit3: 'tool', Numpad1: 'tool', Numpad2: 'tool', Numpad3: 'tool',
  Tab: 'map', KeyP: 'pause', Escape: 'escape', KeyF: 'fullscreen', KeyM: 'mute'
};
var CDA_HELD = { forward: true, back: true, left: true, right: true, turnLeft: true, turnRight: true, fire: true, use: true };
// The keys that press a focused button, by event.key.
var CDA_PRESS = { Enter: true, ' ': true };
var CDA_MOUSE_BASE = 0.0022;
var CDA_MOUSE_SPIKE = 250;      // px: the most one mousemove may turn
var CDA_EDGE_ZONE = 0.15;       // share of the stage's width on each side that keeps turning
var CDA_LOCK_RETRY = 1500;      // ms after a refusal before a click asks for the lock again

function cdaOwn(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// The action of a key by its physical key; by its value only when the event
// has no code (see the header); or null.
function cdaKeyAction(event) {
  var code = event.code;
  if (typeof code === 'string' && code !== '' && code !== 'Unidentified') return cdaOwn(CDA_CODES, code) ? CDA_CODES[code] : null;
  if (typeof event.key !== 'string') return null;
  var key = event.key.toLowerCase();
  return cdaOwn(CDA_KEYS, key) ? CDA_KEYS[key] : null;
}

// The action of a key the game takes: none with Ctrl, Alt or Meta or while composing.
function cdaOwnKey(event) {
  var action = cdaKeyAction(event);
  return action && !(event.ctrlKey || event.altKey || event.metaKey || event.isComposing) ? action : null;
}

// The keys' one-shot commands on the canvas.
var CDA_COMMANDS = {
  tool: cdaKeyTool, map: cdaToggleMap, pause: cdaPause, escape: cdaPause, fullscreen: cdaToggleFullscreen, mute: cdaToggleMute
};

// The slot of a tool key: from its code (Digit2, Numpad2), else its value.
function cdaKeyTool(event) {
  CDA_RT.weaponReq = Number((/[1-3]$/.exec(event.code) || /[1-3]$/.exec(event.key))[0]);
}

function cdaToggleMap() {
  CDA_RT.map = !CDA_RT.map;
}

// Keys on the canvas: the game's only while the level is live.
function cdaHandleKeydown(event) {
  var action = cdaOwnKey(event);
  if (!action || event.defaultPrevented || !cdaLive()) return;
  event.preventDefault();
  event.stopPropagation();
  cdaSfxUnlock();
  if (CDA_HELD[action]) CDA_RT.keys[action] = true;
  else if (!event.repeat) CDA_COMMANDS[action](event);
}

function cdaHandleKeyup(event) {
  var action = cdaKeyAction(event);
  if (action && CDA_HELD[action]) CDA_RT.keys[action] = false;
  if (cdaOwnKey(event) && cdaLive()) event.stopPropagation();
}

// Esc on the menus: back.  Returns whether it did something.
function cdaEscape() {
  var rt = CDA_RT;
  var screen = rt.screen;
  if (rt.overlay) cdaOverlayBack();
  else if (screen === 'pause') cdaResumeQuiet();
  else if (screen === 'play') cdaPause();
  else if (screen === 'briefing') cdaShowSelect();
  else if (screen === 'select') cdaShowTitle();
  else if (screen === 'upgrades') cdaUpgradesBack();
  else return false;
  return true;
}

// Keys in the frame that the live canvas did not take (see the header).
function cdaHandleFrameKey(event) {
  var rt = CDA_RT;
  if (event.defaultPrevented) return;
  cdaSfxUnlock();
  var action = cdaOwnKey(event);
  if (!action || event.repeat) return;
  var done = true;
  if (action === 'fullscreen') cdaToggleFullscreen();
  else if (action === 'mute') cdaToggleMute();
  else if (action === 'escape') done = cdaEscape();
  else if (action === 'pause' && rt.screen === 'pause' && !rt.overlay) cdaResume(event);
  else done = false;
  if (done) event.preventDefault();
}

// Every key down in the frame, before anyone else sees it: the player has
// used the frame (the game may move the focus from now on); a stale Enter
// or Space repeating is cancelled (see the header).
function cdaTrackKeyDown(event) {
  var rt = CDA_RT;
  var key = event.key;
  rt.touched = true;
  if (!cdaOwn(CDA_PRESS, key)) return;
  if (event.repeat && rt.stale[key]) event.preventDefault();
  else rt.stale[key] = false;
  rt.down[key] = true;
}

function cdaTrackKeyUp(event) {
  var rt = CDA_RT;
  var key = event.key;
  if (!cdaOwn(CDA_PRESS, key)) return;
  if (rt.stale[key]) event.preventDefault();
  rt.stale[key] = false;
  rt.down[key] = false;
}

// A pointer or the focus in the frame: the player has used it.
function cdaTouch() {
  CDA_RT.touched = true;
}

// A click in the frame: sound may start; a menu button (or anything inside
// one, such as a level's name) clicks.
function cdaHandleFrameClick(event) {
  cdaSfxUnlock();
  var b = event.target.closest('button');
  if (b && !b.classList.contains('cda-buy')) cdaSfxUi('click');
}

// ── the mouse ──

function cdaHandleMouseDown(event) {
  var rt = CDA_RT;
  cdaSfxUnlock();
  if (event.button !== 0 || !cdaRunning()) return;
  event.preventDefault();
  if (rt.locked) {
    rt.mouseFire = true;
    return;
  }
  var api = !!rt.els.canvas.requestPointerLock;
  var fire = rt.lockRefused || !api;
  if (api && !(event.timeStamp - rt.refusedAt < CDA_LOCK_RETRY)) cdaRequestLock(event.timeStamp);
  if (fire) rt.mouseFire = true;
}

function cdaHandleMouseUp(event) {
  if (event.button === 0) CDA_RT.mouseFire = false;
}

// dx pixels of mouse movement into the next step's turn.
function cdaMouseTurn(dx) {
  var rt = CDA_RT;
  var d = Math.max(-CDA_MOUSE_SPIKE, Math.min(CDA_MOUSE_SPIKE, dx || 0));
  rt.turnAcc += d * CDA_MOUSE_BASE * rt.save.settings.sens;
}

function cdaHandleMouseMove(event) {
  var rt = CDA_RT;
  if (!cdaRunning()) return;
  if (rt.locked) {
    if (rt.skipMove) rt.skipMove = false;
    else cdaMouseTurn(event.movementX);
    return;
  }
  var r = rt.els.stage.getBoundingClientRect();
  var x = event.clientX - r.left;
  var y = event.clientY - r.top;
  if (!(x >= 0 && x < r.width && y >= 0 && y < r.height)) {
    rt.edge = 0;
    return;
  }
  cdaMouseTurn(event.movementX);
  var zone = r.width * CDA_EDGE_ZONE;
  var turn = CDA_PLAYER.turn;
  rt.edge = x < zone ? -turn * (zone - x) / zone : x > r.width - zone ? turn * (x - r.width + zone) / zone : 0;
}

// The pointer left the stage: the edge stops turning.
function cdaHandleMouseLeave() {
  CDA_RT.edge = 0;
}

// The slot of the next (dir 1) or previous (-1) tool the player owns.
function cdaNextSlot(p, dir) {
  var order = [];
  for (var i = 0; i < CDA_TOOLS.length; i++) if (p.tools.indexOf(CDA_TOOLS[i].id) >= 0) order.push(CDA_TOOLS[i].slot);
  var at = order.indexOf(CDA_TOOL[p.tool].slot);
  return order[(at + dir + order.length) % order.length];
}

function cdaHandleWheel(event) {
  var rt = CDA_RT;
  if (!cdaRunning()) return;
  event.preventDefault();
  if (event.deltaY) rt.weaponReq = cdaNextSlot(rt.sim.player, event.deltaY > 0 ? 1 : -1);
}

// ── pointer lock ──

// Asks for the lock; `stamp` is the timeStamp of the event that asked (a
// refusal without an event of its own counts from it).
function cdaRequestLock(stamp) {
  var rt = CDA_RT;
  var canvas = rt.els.canvas;
  if (!canvas.requestPointerLock) {
    cdaLockNote(CDA_UI.noLock);
    return;
  }
  rt.askedAt = stamp;
  try {
    var r = canvas.requestPointerLock();
    if (r && typeof r.then === 'function') r.then(null, cdaLockError);
  } catch (err) {
    cdaLockError();
  }
}

// The lock was refused (a pointerlockerror event, a rejected or throwing
// request): when, by the event's timeStamp or else the asking one's.
function cdaLockError(event) {
  var rt = CDA_RT;
  if (rt.locked) return;
  rt.lockRefused = true;
  rt.refusedAt = event && typeof event.timeStamp === 'number' ? event.timeStamp : rt.askedAt;
  cdaLockNote(CDA_UI.lockRefused);
}

// Says, once a page load, how the mouse works without the lock.
function cdaLockNote(text) {
  var rt = CDA_RT;
  if (rt.lockSaid) return;
  rt.lockSaid = true;
  cdaSay(text);
}

function cdaHandleLockChange() {
  var rt = CDA_RT;
  var was = rt.locked;
  rt.locked = document.pointerLockElement === rt.els.canvas;
  rt.skipMove = true;
  if (rt.locked) {
    rt.lockRefused = false;
    rt.edge = 0;
  } else if (was) {
    cdaAutoPause();
  }
}

function cdaReleaseLock() {
  if (CDA_RT.locked && document.exitPointerLock) document.exitPointerLock();
}

// ── focus and visibility ──

// Every held action let go, the mouse's turn, the edge's turn and a tool
// request dropped.
function cdaReleaseInput() {
  var rt = CDA_RT;
  rt.keys = {};
  rt.mouseFire = false;
  rt.turnAcc = 0;
  rt.edge = 0;
  rt.weaponReq = 0;
}

function cdaHandleFocus() {
  CDA_RT.focused = true;
}

function cdaHandleBlur() {
  CDA_RT.focused = false;
  cdaReleaseInput();
  cdaAutoPause();
}

function cdaHandleVisibility() {
  if (document.hidden) {
    cdaReleaseInput();
    cdaAutoPause();
  } else {
    cdaUpdateLoop();
  }
}

function cdaHandlePageHide() {
  if (CDA_RT.playAcc > 0) cdaFlushPlay();
}

// ── the sim's input ──

// The input for one step: the held keys, the mouse's turn since the last
// step (consumed), the edge's turn for one step, a tool request (consumed).
function cdaReadInput() {
  var rt = CDA_RT;
  var k = rt.keys;
  var input = {
    move: (+!!k.forward) - (+!!k.back),
    strafe: (+!!k.right) - (+!!k.left),
    turn: ((+!!k.turnRight) - (+!!k.turnLeft)) * CDA_PLAYER.turn * CDA_STEP + rt.turnAcc + rt.edge * CDA_STEP,
    fire: !!k.fire || rt.mouseFire,
    use: !!k.use,
    weapon: rt.weaponReq
  };
  rt.turnAcc = 0;
  rt.weaponReq = 0;
  return input;
}

// ── binding ──

function cdaOn(el, type, fn) {
  el.addEventListener(type, fn);
}

function cdaBind() {
  var els = CDA_RT.els;
  var canvas = els.canvas;
  cdaOn(canvas, 'keydown', cdaHandleKeydown);
  cdaOn(canvas, 'keyup', cdaHandleKeyup);
  cdaOn(canvas, 'focus', cdaHandleFocus);
  cdaOn(canvas, 'blur', cdaHandleBlur);
  cdaOn(canvas, 'mousedown', cdaHandleMouseDown);
  canvas.addEventListener('wheel', cdaHandleWheel, { passive: false });
  cdaOn(els.stage, 'mouseleave', cdaHandleMouseLeave);
  els.frame.addEventListener('keydown', cdaTrackKeyDown, true);
  els.frame.addEventListener('keyup', cdaTrackKeyUp, true);
  els.frame.addEventListener('mousedown', cdaTouch, true);
  els.frame.addEventListener('click', cdaTouch, true);
  els.frame.addEventListener('focusin', cdaTouch, true);
  cdaOn(els.frame, 'keydown', cdaHandleFrameKey);
  cdaOn(els.frame, 'click', cdaHandleFrameClick);
  var clicks = [
    [els.gatePlay, cdaEngage], [els.cont, cdaShowSelect], [els.newGame, cdaNewGameClick], [els.helpOpen, cdaOpenHelp],
    [els.selectUpgrades, cdaUpgradesFromSelect], [els.selectBack, cdaShowTitle], [els.briefStart, cdaBriefStart],
    [els.briefBack, cdaShowSelect], [els.resume, cdaResume], [els.restart, cdaFreshSim], [els.pauseHelp, cdaOpenHelp],
    [els.pauseLevels, cdaAskLeave], [els.mute, cdaToggleMute], [els.retry, cdaFreshSim], [els.deathLevels, cdaShowSelect],
    [els.next, cdaNextClick], [els.resultsUpgrades, cdaUpgradesFromResults], [els.resultsLevels, cdaShowSelect],
    [els.upgBack, cdaUpgradesBack], [els.endLevels, cdaShowSelect], [els.endHome, cdaShowTitle],
    [els.helpClose, cdaOverlayBack], [els.confirmNo, cdaOverlayBack], [els.confirmYes, cdaConfirmYes],
    [els.warningClose, cdaHideWarning]
  ];
  for (var i = 0; i < clicks.length; i++) cdaOn(clicks[i][0], 'click', clicks[i][1]);
  cdaOn(els.sens, 'input', cdaSensInput);
  cdaOn(els.sens, 'change', cdaSensChange);
  cdaOn(document, 'mouseup', cdaHandleMouseUp);
  cdaOn(document, 'mousemove', cdaHandleMouseMove);
  cdaOn(document, 'pointerlockchange', cdaHandleLockChange);
  cdaOn(document, 'pointerlockerror', cdaLockError);
  cdaOn(document, 'visibilitychange', cdaHandleVisibility);
  cdaOn(window, 'blur', cdaHandleBlur);
  cdaOn(window, 'storage', cdaHandleStorage);
  cdaOn(window, 'pagehide', cdaHandlePageHide);
  cdaWatchSize();
}

CDA_API.CDA_KEYS = CDA_KEYS;
CDA_API.CDA_CODES = CDA_CODES;
CDA_API.CDA_MOUSE_BASE = CDA_MOUSE_BASE;
CDA_API.CDA_MOUSE_SPIKE = CDA_MOUSE_SPIKE;
CDA_API.CDA_EDGE_ZONE = CDA_EDGE_ZONE;
CDA_API.CDA_LOCK_RETRY = CDA_LOCK_RETRY;
CDA_API.cdaKeyAction = cdaKeyAction;
CDA_API.cdaNextSlot = cdaNextSlot;
CDA_API.cdaReadInput = cdaReadInput;
