// ── ui-loop: a level on the page: starting it, the "Click to play" gate, pause and resume, the frame loop, its end ──
// Owns CDA_SEED, cdaBeginLevel, cdaFreshSim (start and retry), cdaEngage,
// cdaPause / cdaResume / cdaResumeQuiet / cdaAutoPause, cdaAskLeave, cdaLive, cdaRunning,
// cdaUpdateLoop, cdaFrame, cdaTick, cdaDraw, cdaCalmView, cdaLevelOver and
// cdaRuntimeStart (cdaRuntime().startLevel).  Uses core, tables, map
// (cdaParseLevel), sim (cdaNewSim, cdaStep, cdaResult, cdaCarryFrom),
// levels (cdaLevelCarry), render-view and render-map, sfx (cdaSfxEvents,
// cdaSfxUnlock), storage, ui-text, ui-page, ui-hud, ui-input and ui-screens.
//
// Starting level n: cdaNewSim(cdaParseLevel(CDA_LEVELS[n]), cdaLevelCarry(n,
// carry), save.upgrades, seed), carry being what cdaCarryFrom gave when the
// player won level n-1 in this page load (the chain; starting any other
// level drops it), else null.  A retry or a restart makes a new sim from the
// same parsed level and carry (and the upgrades bought meanwhile).  The seed
// counts the levels started in this page load (CDA_SEED apart): the sim is
// deterministic, the page needs no randomness.
// The level then waits behind "Click to play": its button (a click or Enter
// is a user gesture) gives the canvas the keys and asks for the pointer
// lock (a refusal leaves the mouse turning without it: ui-input).  Resume
// (and P on the pause screen) does the same; Esc on the pause screen
// resumes without asking (cdaResumeQuiet: Esc is no user gesture to a
// browser).
// The loop runs while cdaRunning: the level screen, no gate, no overlay, a
// wide enough window, a visible tab.  Each animation frame adds its time (at
// most CDA_MAX_FRAME) to an accumulator and runs fixed steps of CDA_STEP:
// the input (ui-input), cdaStep, cdaViewStep, cdaSfxEvents, the message
// line and the page's own events (message, hurt); then one cdaRender with
// the interpolation alpha, the automap over it when Tab shows it, and
// putImageData.  The seconds stepped go into the save at a pause and at the
// level's end.  A win records the result (cdaRecordWin) and shows the
// results; a death counts in the save and shows the death screen.
// Reduced motion: the renderer has no switch of its own, so after each
// cdaViewStep the page takes the weapon bob and the pickup flash out of the
// view state and shortens the damage flash (cdaCalmView).

var CDA_SEED = 7919;
var CDA_CALM_HURT = 0.08;       // seconds of damage flash left with reduced motion

// Starts the level object `obj` standing for CDA_LEVELS[index] (-1: none)
// with `carry` (null: the kit).
function cdaBeginLevel(obj, index, carry) {
  var rt = CDA_RT;
  if (rt.chain && rt.chain.level !== index) rt.chain = null;
  var lv = cdaParseLevel(obj);
  rt.entry = { obj: obj, index: index };
  rt.lv = lv;
  rt.carryIn = index >= 0 ? cdaLevelCarry(index, carry) : carry || {
    tools: lv.kit.tools.slice(), ammo: { cell: lv.kit.ammo.cell, coil: lv.kit.ammo.coil }, health: CDA_PLAYER.health, armour: 0
  };
  cdaFreshSim();
}

// A new sim of the level being played (start, Retry, Restart level),
// waiting behind the gate.
function cdaFreshSim() {
  var rt = CDA_RT;
  var els = rt.els;
  rt.tries++;
  rt.sim = cdaNewSim(rt.lv, rt.carryIn, rt.save.upgrades, rt.tries * CDA_SEED);
  rt.view = cdaNewView();
  rt.map = false;
  rt.msgLeft = 0;
  rt.low = false;
  rt.lastBy = '';
  rt.hudAmmo = null;
  rt.acc = 0;
  rt.result = null;
  rt.rec = null;
  rt.gate = true;
  cdaReleaseInput();
  cdaSetText(els.msg, '');
  els.hud.classList.remove('cda-hud--low');
  els.stage.classList.remove('cda-stage--low');
  cdaDraw();
  cdaShow('play', els.gatePlay);
  cdaAnnounce(rt.lv.name + '. Click to play.');
}

// Click to play and Resume (their click `event`): the level runs, the
// canvas takes the keys, the pointer lock is asked for (a user gesture).
function cdaEngage(event) {
  cdaResumeQuiet();
  if (!CDA_RT.locked) cdaRequestLock(event.timeStamp);
}

function cdaResume(event) {
  cdaEngage(event);
}

// Esc on the pause screen resumes without asking for the lock: browsers do
// not count Esc as a user gesture and would refuse; a click on the view
// asks for it then.
function cdaResumeQuiet() {
  var rt = CDA_RT;
  cdaSfxUnlock();
  rt.gate = false;
  cdaShow('play', rt.els.canvas);
  rt.focused = document.activeElement === rt.els.canvas;
}

// P, Esc, a lost focus or lock, a hidden tab, a narrow window: the pause
// screen (from the level or its gate); the time played is saved.  Only
// ever called on the level screen (the live canvas's keys, Esc on the gate,
// cdaAutoPause).
function cdaPause() {
  var rt = CDA_RT;
  cdaReleaseInput();
  rt.gate = false;
  cdaFlushPlay();
  cdaShow('pause', rt.els.resume);
}

// Pauses only a level that is on (not one behind its gate or an overlay).
function cdaAutoPause() {
  if (cdaLive()) cdaPause();
}

function cdaAskLeave() {
  cdaAsk(CDA_UI.leave, 'Leave', cdaShowSelect, CDA_RT.els.pauseLevels);
}

// ── the loop ──

// The level is on screen and engaged.
function cdaLive() {
  var rt = CDA_RT;
  return rt.screen === 'play' && !rt.gate && !rt.overlay;
}

// ... and may run: a wide enough window, a visible tab.
function cdaRunning() {
  return cdaLive() && !CDA_RT.narrow && !document.hidden;
}

function cdaUpdateLoop() {
  var rt = CDA_RT;
  var run = cdaRunning();
  if (run && !rt.raf) {
    rt.last = -1;
    rt.raf = requestAnimationFrame(cdaFrame);
  } else if (!run && rt.raf) {
    cancelAnimationFrame(rt.raf);
    rt.raf = 0;
  }
}

function cdaFrame(ts) {
  var rt = CDA_RT;
  var dt = rt.last < 0 ? 0 : Math.min(CDA_MAX_FRAME, Math.max(0, (ts - rt.last) / 1000));
  rt.raf = 0;
  rt.last = ts;
  rt.acc += dt;
  while (rt.acc >= CDA_STEP - 1e-9 && rt.sim.status === 'playing') {
    rt.acc -= CDA_STEP;
    cdaTick();
  }
  cdaDraw();
  if (rt.sim.status !== 'playing') cdaLevelOver();
  else rt.raf = requestAnimationFrame(cdaFrame);
}

// One step of the level and what its events mean for the page.
function cdaTick() {
  var rt = CDA_RT;
  var sim = rt.sim;
  cdaStep(sim, cdaReadInput());
  cdaViewStep(rt.view, sim);
  if (rt.reduced) cdaCalmView(rt.view);
  cdaSfxEvents(sim.events, sim);
  rt.playAcc += CDA_STEP;
  cdaMessageStep();
  for (var i = 0; i < sim.events.length; i++) {
    var ev = sim.events[i];
    if (ev.type === 'message') cdaSay(ev.text);
    else if (ev.type === 'hurt') rt.lastBy = ev.by;
  }
}

// Reduced motion: no weapon bob, no pickup flash, a short damage flash.
function cdaCalmView(view) {
  view.bobAmp = 0;
  view.pick = 0;
  view.hurt = Math.min(view.hurt, cdaSteps(CDA_CALM_HURT));
}

// One frame on the canvas (the automap over it when shown) and the HUD.
function cdaDraw() {
  var rt = CDA_RT;
  cdaRender(rt.view, rt.sim, Math.min(1, rt.acc / CDA_STEP), rt.pixels);
  if (rt.map) cdaRenderMap(rt.view, rt.sim, rt.pixels);
  rt.ctx.putImageData(rt.image, 0, 0);
  cdaRenderHud();
}

// The level ended: a death counts and offers Retry; a win is recorded (a
// level of the episode), hands its carry to the next level and shows the
// results.  The save is written either way.
function cdaLevelOver() {
  var rt = CDA_RT;
  var sim = rt.sim;
  cdaReleaseInput();
  cdaAddPlayTime(rt.save, rt.playAcc);
  rt.playAcc = 0;
  if (sim.status === 'dead') {
    cdaRecordDeath(rt.save);
    cdaPersist();
    cdaShowDeath();
    return;
  }
  var index = rt.entry.index;
  rt.result = cdaResult(sim);
  rt.rec = index >= 0 ? cdaRecordWin(rt.save, index + 1, rt.result) : null;
  rt.chain = index >= 0 ? { level: index + 1, carry: cdaCarryFrom(sim) } : null;
  cdaPersist();
  cdaShowResults();
}

// cdaRuntime().startLevel(levelObject, carry, asLevel).
function cdaRuntimeStart(obj, carry, asLevel) {
  cdaBeginLevel(obj, typeof asLevel === 'number' ? asLevel : -1, carry || null);
}

CDA_RT.startLevel = cdaRuntimeStart;

CDA_API.CDA_SEED = CDA_SEED;
CDA_API.cdaRunning = cdaRunning;
