// ── ui: the frame: its layout on the page, fullscreen and maximised, the overlays in it ──
// Owns putting pksFrameLayout's boxes on the elements (pksLayoutFrame, run
// at start-up, when the frame's parent changes width, on a window resize and
// when the mode changes), the Fullscreen button and the F key (the
// Fullscreen API on the frame, with the webkit names; where the API is
// missing or refuses, the frame is maximised: fixed over the viewport with
// the page's scroll locked), bringing the frame into view, and the
// overlays that ask (leave a level in progress?) or explain (how to play).
// Uses ui-layout, ui-text and ui-page; inside function bodies also
// ui-level (pause, resume, start), ui-select and ui-screens.

// The frame's layout for the mode and the sizes now, on the elements.  The
// width comes from the frame's parent (#pks-holder); 0 (not laid out yet,
// hidden by the host page) keeps what there is.
function pksLayoutFrame() {
  var rt = pksRuntime;
  var width = rt.els.holder.clientWidth;
  if (!(width > 0) && rt.mode === 'page') return;
  var L = pksFrameLayout(rt.mode, width, window.innerWidth, window.innerHeight);
  var els = rt.els;
  rt.layout = L;
  els.frame.style.width = L.w + 'px';
  els.frame.style.height = L.h + 'px';
  if (rt.mode === 'page') els.holder.style.height = L.h + 'px';
  els.frame.classList.toggle('pks-frame--side', L.side);
  els.frame.classList.toggle('pks-frame--small', L.field.w < PKS_HUD_WIDE);
  els.hud.style.height = L.hud + 'px';
  els.hud.classList.toggle('pks-hud--two', L.hud === PKS_HUD_TWO);
  pksPlaceBox(els.field, L.field);
  pksPlaceBox(els.tray, L.tray);
  pksPlaceBox(els.cards, L.cards);
  pksPlaceBox(els.status, L.status);
  pksPlaceBox(els.rules, L.rules);
  els.rules.classList.toggle('pks-rules--big', L.rules.h >= PKS_RULES_BIG);
  pksCardColumns();
  els.paused.style.top = L.hud + 'px';
  els.confirm.style.top = L.hud + 'px';
  els.result.style.top = L.hud + 'px';
}

// The card grid's columns for the cards dealt: the layout's columns, or
// fewer, spread evenly, so a short hand sits centred in the tray (whose
// size stays the same).
function pksCardColumns() {
  var rt = pksRuntime;
  var L = rt.layout;
  var n = rt.cardEls.length;
  if (!L) return;
  var cols = n ? Math.ceil(n / Math.ceil(n / L.cols)) : L.cols;
  rt.els.cards.style.gridTemplateColumns = 'repeat(' + cols + ', ' + L.cardW + 'px)';
}

function pksPlaceBox(el, box) {
  el.style.left = box.x + 'px';
  el.style.top = box.y + 'px';
  el.style.width = box.w + 'px';
  el.style.height = box.h + 'px';
}

// Follows the width of the frame's parent: a ResizeObserver where the
// browser has one (an embedding page's column can change without the
// window), a window resize always (the viewport's height, fullscreen).
function pksWatchSize() {
  if (window.ResizeObserver) new window.ResizeObserver(pksLayoutFrame).observe(pksRuntime.els.holder);
  window.addEventListener('resize', pksLayoutFrame);
}

// After a screen change: the frame's top into view when it is above the
// viewport, or below it with the frame cut off (on the page only).
function pksRevealFrame() {
  var frame = pksRuntime.els.frame;
  var r = frame.getBoundingClientRect();
  if (pksRuntime.mode === 'page' && (r.top < 0 || (r.top > 0 && r.bottom > window.innerHeight))) frame.scrollIntoView(true);
}

// ── fullscreen and maximised ──

function pksFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

// A promise the Fullscreen API may return: its rejection goes to `failed`
// (the webkit methods return nothing and report by event).
function pksQuiet(result, failed) {
  if (result && typeof result.then === 'function') result.then(null, failed);
}

function pksNoop() {}

// The Fullscreen button and F: out of fullscreen or maximised, else into
// fullscreen, or maximised where the browser has no Fullscreen API.  A
// request that throws or is refused (its promise, or the error event)
// maximises too.
function pksToggleFullscreen() {
  var rt = pksRuntime;
  if (rt.mode === 'max') {
    pksSetMaximised(false);
  } else if (rt.mode === 'full') {
    pksQuiet((document.exitFullscreen || document.webkitExitFullscreen).call(document), pksNoop);
  } else {
    var frame = rt.els.frame;
    var request = frame.requestFullscreen || frame.webkitRequestFullscreen;
    if (!request) {
      pksSetMaximised(true);
      return;
    }
    try {
      pksQuiet(request.call(frame), pksFullscreenRefused);
    } catch (err) {
      pksSetMaximised(true);
    }
  }
}

// A refused request or a failed exit: maximised unless fullscreen is on
// after all.
function pksFullscreenRefused() {
  if (!pksFullscreenElement()) pksSetMaximised(true);
}

// fullscreenchange (and the webkit one): the mode follows the browser.
function pksHandleFullscreen() {
  var rt = pksRuntime;
  if (pksFullscreenElement() === rt.els.frame) rt.mode = 'full';
  else if (rt.mode === 'full') rt.mode = 'page';
  pksRenderFull();
  pksLayoutFrame();
}

// Maximised on or off: the frame fixed over the viewport, the page's
// scroll locked (and given back as it was).
function pksSetMaximised(on) {
  var rt = pksRuntime;
  if (on === (rt.mode === 'max')) return;
  var html = document.documentElement.style;
  var body = document.body.style;
  if (on) {
    rt.unlock = { html: html.overflow, body: body.overflow };
    html.overflow = 'hidden';
    body.overflow = 'hidden';
  } else {
    html.overflow = rt.unlock.html;
    body.overflow = rt.unlock.body;
  }
  rt.mode = on ? 'max' : 'page';
  rt.els.frame.classList.toggle('pks-frame--max', on);
  pksRenderFull();
  pksLayoutFrame();
}

function pksRenderFull() {
  var els = pksRuntime.els;
  var on = pksRuntime.mode !== 'page';
  var buttons = [els.full, els.selectFull];
  for (var i = 0; i < buttons.length; i++) {
    pksSetText(buttons[i], pksFullText(on));
    buttons[i].setAttribute('aria-pressed', String(on));
  }
}

// Esc: pauses on the page; maximised it leaves that (as the browser's Esc
// leaves fullscreen, which it handles itself: then Esc does nothing more).
function pksEscape() {
  var mode = pksRuntime.mode;
  if (mode === 'page') pksTogglePause();
  else if (mode === 'max') pksSetMaximised(false);
}

// Keys anywhere in the frame but the field (which takes its own): F
// toggles fullscreen, Esc leaves maximised.
function pksHandleFrameKey(event) {
  var action = pksOwnKey(event);
  if (event.defaultPrevented || event.repeat) return;
  if (action === 'fullscreen') {
    event.preventDefault();
    pksToggleFullscreen();
  } else if (action === 'escape' && pksRuntime.mode === 'max') {
    event.preventDefault();
    pksSetMaximised(false);
  }
}

// ── overlays: the leave question and the help ──

// Levels or Restart while a level is in progress (not over, not on its
// result): the level pauses and the question shows; else it goes at once.
// Either question saves the level first (it pauses, and a hidden tab while
// it shows finds the level paused already and saves nothing more); when
// leaving and that worked, the question says it can be resumed ('keep'),
// else that its progress is lost.  The Yes button's accessible name follows
// the question.
function pksAskLeave(action) {
  var rt = pksRuntime;
  if (rt.screen !== 'play' || rt.sim.status !== 'playing') {
    pksLeave(action);
    return;
  }
  if (pksSnapshot() && action === 'leave') action = 'keep';
  rt.confirm = { action: action, paused: rt.paused };
  rt.paused = true;
  pksRenderPause();
  pksUpdateLoop();
  pksSetText(rt.els.confirmText, PKS_LEAVE_TEXT[action]);
  pksSetText(rt.els.confirmYes, PKS_LEAVE_YES[action]);
  rt.els.confirmYes.setAttribute('aria-label', PKS_LEAVE_LABEL[action]);
  pksToggle(rt.els.confirm, true);
  pksFocus(rt.els.confirmNo);
}

function pksLeave(action) {
  if (action === 'restart') pksRestart();
  else pksToSelect();
}

function pksConfirmYes() {
  var action = pksRuntime.confirm.action;
  pksCloseOverlays();
  pksLeave(action);
}

function pksAskLevels() {
  pksAskLeave('leave');
}

function pksAskRestart() {
  pksAskLeave('restart');
}

// Stay: back to the pause overlay when the level was paused, else on.
function pksConfirmNo() {
  var rt = pksRuntime;
  var paused = rt.confirm.paused;
  pksCloseOverlays();
  if (paused) {
    pksRenderPause();
    pksFocus(rt.els.resume);
  } else {
    pksResume();
  }
}

// How to play, over the whole frame, from the level select or the pause
// overlay; Close goes back to the button that opened it.
function pksOpenHelp(from) {
  var rt = pksRuntime;
  rt.help = from;
  pksRenderPause();
  pksToggle(rt.els.help, true);
  pksFocus(rt.els.helpClose);
}

function pksHelpFromSelect() {
  pksOpenHelp('select');
}

function pksHelpFromPause() {
  pksOpenHelp('pause');
}

function pksCloseHelp() {
  var rt = pksRuntime;
  var from = rt.help;
  pksCloseOverlays();
  if (from === 'pause') {
    pksRenderPause();
    pksFocus(rt.els.pauseHelp);
  } else {
    pksFocus(rt.els.helpOpen);
  }
}

function pksCloseOverlays() {
  var rt = pksRuntime;
  rt.confirm = null;
  rt.help = null;
  pksToggle(rt.els.confirm, false);
  pksToggle(rt.els.help, false);
}
