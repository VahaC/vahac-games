// ── ui-page: the page runtime, its elements, DOM helpers, the save on the page, screens, the frame's size, fullscreen, cdaInit ──
// Owns CDA_RT (the one live state of the page; cdaRuntime returns it),
// cdaFind, the DOM helpers (cdaSetText, cdaToggle, cdaFocus, cdaMake,
// cdaPaint), the save on the page (cdaStoreResult, cdaPersist,
// cdaEraseSave, the storage warning), cdaShow (which screen is on), the
// frame's size (cdaLayout), fullscreen, cdaInit and cdaRuntime.  Uses core,
// textures (cdaSpritePixels), levels, sfx, storage, ui-text and ui-layout;
// inside function bodies also ui-hud, ui-screens, ui-guide, ui-input and
// ui-loop.
//
// Everything that belongs to the game is in one frame (#cda-frame): the
// stage inside it is the view's size (320x180 times the scale) and holds
// the canvas, the HUD laid over the view, the "Click to play" overlay,
// every screen and overlay, and the storage warning.  The frame is what
// goes fullscreen (black around the centred stage).  The narrow-window
// notice and the How to play guide are outside it.
//
// The runtime:
//   els        the page elements (cdaFind); null until cdaInit ran
//   ctx, image, pixels   the canvas's 2D context, its ImageData and a
//              Uint32Array over the ImageData's bytes (cdaRender writes it)
//   save       the save (storage part) as the page keeps it; newer: the v of
//              a newer stored save (nothing is ever written then), else 0
//   warned     the storage warning has been shown (it shows once a page load)
//   screen     'title' | 'select' | 'briefing' | 'play' | 'pause' | 'death' |
//              'results' | 'upgrades' | 'end'
//   overlay    null | 'help' | 'confirm' (over the screen); back: the
//              element the overlay gives the focus back to; confirm: the
//              function Yes runs
//   gate       the "Click to play" overlay is up (the level waits for it)
//   mode       'page' | 'full'; scale the stage's scale; narrow the window
//              is narrower than CDA_NARROW (the notice shows, nothing runs)
//   reduced    the reader prefers reduced motion
//   locked     the canvas holds the pointer lock; lockRefused it was refused
//              since it was last held; askedAt, refusedAt the timeStamp of
//              the event that last asked for it and of the last refusal;
//              lockSaid the line about the mouse without the lock was said;
//              skipMove the next locked mousemove is dropped; edge radians a
//              second the unlocked pointer's edge zone turns (ui-input)
//   focused    the canvas has the keyboard focus
//   touched    the player has used the frame (a key, a click, the focus in
//              it): until then the game never moves the focus (cdaFocus), so
//              a page that holds the game keeps its own keys at load
//   down, stale  Enter and Space ({ 'Enter': bool, ' ': bool }) down in the
//              frame, and those that were down when the game last moved the
//              focus (ui-input)
//   dpr        the device pixel ratio the frame's scale was chosen for
//   title      the title's picture: { view } made once (cdaShowTitle)
//   pick       the level the briefing shows (index into CDA_LEVELS)
//   entry      the level being played: { obj (the raw level), index (into
//              CDA_LEVELS, or -1 for a level object that is not one) }
//   lv, carryIn  its parsed level and the carry it was entered with
//   chain      { level, carry }: what cdaCarryFrom gave when level-1 was won
//              in this page load (null: none)
//   tries      levels started in this page load (the seed)
//   sim, view  the level being played and its view (renderer)
//   keys       the held actions; mouseFire the left button is down; turnAcc
//              radians of mouse turn not stepped yet; weaponReq a slot asked
//              for (0: none); map the automap shows
//   raf, last, acc  the frame loop (ui-loop); playAcc seconds played not
//              yet added to the save
//   msgLeft    steps the HUD message stays; low the low-health state shown;
//              lastBy what last hurt the player; hudAmmo the ammo kind the
//              HUD's ammo icon shows (null: none drawn yet)
//   result, rec   the last level's cdaResult and cdaRecordWin (null for a
//              level that is not in CDA_LEVELS)
//   upgradesFrom  the screen the upgrades screen goes back to;
//              levelButtons the level select's buttons
//   startLevel(levelObject, carry, asLevel)  plays a level object (tests,
//              debugging); asLevel: the index it stands in for (its win is
//              recorded there), else it records nothing

var CDA_RT = {
  els: null, ctx: null, image: null, pixels: null, save: null, newer: 0, warned: false,
  screen: 'title', overlay: null, back: null, confirm: null, gate: false,
  mode: 'page', scale: 1, narrow: false, reduced: false,
  locked: false, lockRefused: false, askedAt: 0, refusedAt: -Infinity, lockSaid: false, skipMove: false, edge: 0,
  focused: false, touched: false, down: { 'Enter': false, ' ': false }, stale: { 'Enter': false, ' ': false }, dpr: 1, title: null,
  pick: 0, entry: null, lv: null, carryIn: null, chain: null, tries: 0, sim: null, view: null,
  keys: {}, mouseFire: false, turnAcc: 0, weaponReq: 0, map: false,
  raf: 0, last: -1, acc: 0, playAcc: 0, msgLeft: 0, low: false, lastBy: '', hudAmmo: null,
  result: null, rec: null, upgradesFrom: 'select', levelButtons: [], startLevel: null
};

// The screens with an element of their own ('play' is the view itself).
var CDA_SCREENS = ['title', 'select', 'briefing', 'pause', 'death', 'results', 'upgrades', 'end'];
var CDA_HUD_SCREENS = { play: true, pause: true, death: true };

function cdaFind() {
  var ids = {
    narrow: 'cda-narrow', holder: 'cda-holder', frame: 'cda-frame', stage: 'cda-stage', canvas: 'cda-canvas',
    hud: 'cda-hud', msg: 'cda-msg', health: 'cda-health', armour: 'cda-armour', tool: 'cda-tool',
    ammoIcon: 'cda-ammo-icon', ammo: 'cda-ammo', badgeBlue: 'cda-badge-blue', badgeYellow: 'cda-badge-yellow',
    badgeRed: 'cda-badge-red', badges: 'cda-badges', racks: 'cda-racks', live: 'cda-live',
    gate: 'cda-gate', gatePlay: 'cda-gate-play',
    title: 'cda-title-screen', cont: 'cda-continue', newGame: 'cda-new', helpOpen: 'cda-help-open',
    select: 'cda-select', balance: 'cda-balance', levels: 'cda-levels', selectUpgrades: 'cda-select-upgrades',
    selectBack: 'cda-select-back',
    briefing: 'cda-briefing', briefName: 'cda-brief-name', briefText: 'cda-brief-text', briefKit: 'cda-brief-kit',
    briefStart: 'cda-brief-start', briefBack: 'cda-brief-back',
    pause: 'cda-pause', resume: 'cda-resume', restart: 'cda-restart', pauseHelp: 'cda-pause-help',
    pauseLevels: 'cda-pause-levels', sens: 'cda-sens', sensValue: 'cda-sens-value', mute: 'cda-mute',
    death: 'cda-death', deathText: 'cda-death-text', deathCount: 'cda-death-count', retry: 'cda-retry',
    deathLevels: 'cda-death-levels',
    results: 'cda-results', resultsTitle: 'cda-results-title', resultsList: 'cda-results-list',
    resultsNew: 'cda-results-new', next: 'cda-next', resultsUpgrades: 'cda-results-upgrades',
    resultsLevels: 'cda-results-levels',
    upgrades: 'cda-upgrades', upgBalance: 'cda-upg-balance', upgList: 'cda-upg-list', upgBack: 'cda-upg-back',
    end: 'cda-end', endList: 'cda-end-list', endLevels: 'cda-end-levels', endHome: 'cda-end-home',
    help: 'cda-help', helpClose: 'cda-help-close',
    confirmBox: 'cda-confirm', confirmText: 'cda-confirm-text', confirmYes: 'cda-confirm-yes', confirmNo: 'cda-confirm-no',
    warning: 'cda-warning', warningText: 'cda-warning-text', warningClose: 'cda-warning-close',
    guideUpgrades: 'cda-guide-upgrades'
  };
  var els = {};
  var names = Object.keys(ids);
  for (var i = 0; i < names.length; i++) els[names[i]] = document.getElementById(ids[names[i]]);
  return els;
}

// ── DOM helpers ──

function cdaSetText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function cdaToggle(el, show) {
  el.classList.toggle('cda-hidden', !show);
}

// Focus without the page jumping; only once the player has used the frame
// (rt.touched).  Enter and Space down now are stale from here (ui-input).
function cdaFocus(el) {
  var rt = CDA_RT;
  if (!rt.touched) return;
  rt.stale = { 'Enter': rt.down.Enter, ' ': rt.down[' '] };
  el.focus({ preventScroll: true });
}

// An element with a class and, when given, its text.
function cdaMake(tag, className, text) {
  var el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

function cdaButton(className, id, text, label) {
  var b = cdaMake('button', className, text);
  b.type = 'button';
  b.id = id;
  b.setAttribute('aria-label', label);
  return b;
}

// Sprite `name` drawn into `canvas` at its own size (CSS scales it).
function cdaPaint(canvas, name) {
  var s = cdaSpritePixels(name);
  canvas.width = s.w;
  canvas.height = s.h;
  var ctx = canvas.getContext('2d');
  var img = ctx.createImageData(s.w, s.h);
  new Uint32Array(img.data.buffer).set(s.data);
  ctx.putImageData(img, 0, 0);
}

// Says text in the live region.
function cdaAnnounce(text) {
  CDA_RT.els.live.textContent = text;
}

// ── the save ──

// A read or write result of the storage part: a failure shows the warning
// line once a page load (dismissible); the game goes on.
function cdaStoreResult(r) {
  var rt = CDA_RT;
  if (r.ok || rt.warned) return;
  rt.warned = true;
  cdaSetText(rt.els.warningText, cdaStorageText(r));
  cdaToggle(rt.els.warning, true);
}

function cdaHideWarning() {
  cdaToggle(CDA_RT.els.warning, false);
}

// Writes the save (merged with what another tab stored, which it adopts).
function cdaPersist() {
  cdaStoreResult(cdaWriteSave(CDA_RT.save));
}

// The seconds played since the last flush go into the save, which is written.
function cdaFlushPlay() {
  var rt = CDA_RT;
  cdaAddPlayTime(rt.save, rt.playAcc);
  rt.playAcc = 0;
  cdaPersist();
}

// New game: a fresh save keeping the settings, of an epoch above both this
// tab's and the stored one, so it wins outright over every older save
// (another tab's included) instead of being merged with it (storage).  When
// the write fails, or the stored save is of a newer version (never
// touched), the fresh save stays in memory only.
function cdaEraseSave() {
  var rt = CDA_RT;
  var fresh = cdaNewSave(CDA_LEVELS.length);
  fresh.settings = { sens: rt.save.settings.sens, mute: rt.save.settings.mute };
  fresh.epoch = Math.max(rt.save.epoch, cdaReadSave(CDA_LEVELS.length).state.epoch) + 1;
  rt.save = fresh;
  rt.chain = null;
  if (rt.newer) return;
  cdaPersist();
}

// Another tab wrote the save: its progress joins this one's (or, after a
// New game there, replaces it).
function cdaHandleStorage(event) {
  var rt = CDA_RT;
  if (event.key !== CDA_SAVE_KEY) return;
  rt.save = cdaMergeSaves(rt.save, cdaReadSave(CDA_LEVELS.length).state);
  cdaRefreshScreen();
}

// ── screens ──

// Shows one screen in the frame (the overlays close); the HUD shows under
// the level's screens; the canvas is in the tab order and hides the cursor
// only while the level is live; the loop follows; `focus` gets the keyboard
// focus.
function cdaShow(name, focus) {
  var rt = CDA_RT;
  rt.screen = name;
  cdaCloseOverlay();
  var els = rt.els;
  var live = cdaLive();
  for (var i = 0; i < CDA_SCREENS.length; i++) cdaToggle(els[CDA_SCREENS[i]], CDA_SCREENS[i] === name);
  cdaToggle(els.hud, !!CDA_HUD_SCREENS[name]);
  cdaToggle(els.gate, name === 'play' && rt.gate);
  els.canvas.tabIndex = live ? 0 : -1;
  els.stage.classList.toggle('cda-stage--live', live);
  if (name !== 'play') cdaReleaseLock();
  cdaUpdateLoop();
  if (focus) cdaFocus(focus);
}

// An overlay over the screen: 'help' or 'confirm'; `back` gets the focus
// when it closes.
function cdaOpenOverlay(name, back, focus) {
  var rt = CDA_RT;
  rt.overlay = name;
  rt.back = back;
  cdaToggle(rt.els.help, name === 'help');
  cdaToggle(rt.els.confirmBox, name === 'confirm');
  cdaReleaseInput();
  cdaUpdateLoop();
  cdaFocus(focus);
}

function cdaCloseOverlay() {
  var rt = CDA_RT;
  rt.overlay = null;
  rt.confirm = null;
  cdaToggle(rt.els.help, false);
  cdaToggle(rt.els.confirmBox, false);
}

// Closes the overlay and gives the focus back to what opened it.
function cdaOverlayBack() {
  var back = CDA_RT.back;
  cdaCloseOverlay();
  cdaUpdateLoop();
  cdaFocus(back);
}

// Help, from the title or the pause screen: Close goes back to its button.
function cdaOpenHelp() {
  var els = CDA_RT.els;
  cdaOpenOverlay('help', CDA_RT.screen === 'pause' ? els.pauseHelp : els.helpOpen, els.helpClose);
}

// A yes / no question: `text`, `yes` the label of the Yes button, `run` what
// Yes does, `back` the button that asked.  No (and Esc) go back to it.
function cdaAsk(text, yes, run, back) {
  var rt = CDA_RT;
  cdaSetText(rt.els.confirmText, text);
  cdaSetText(rt.els.confirmYes, yes);
  rt.els.confirmYes.setAttribute('aria-label', yes);
  cdaOpenOverlay('confirm', back, rt.els.confirmNo);
  rt.confirm = run;
}

function cdaConfirmYes() {
  var run = CDA_RT.confirm;
  cdaCloseOverlay();
  run();
}

// ── the frame's size and fullscreen ──

// The stage's size for the mode, the sizes and the device pixel ratio now
// (ui-layout); the narrow state.  On the page the width comes from the
// frame's parent (#cda-holder), which the stage fills (or a whole device
// pixel scale just under it): 0 (not laid out, hidden by the host page)
// keeps what there is.  The scale (rt.scale, --cda-scale) is the stage's
// width / 320.
function cdaLayout() {
  var rt = CDA_RT;
  var els = rt.els;
  rt.narrow = window.innerWidth > 0 && window.innerWidth < CDA_NARROW;
  if (rt.narrow) cdaAutoPause();
  rt.mode = document.fullscreenElement === els.frame ? 'full' : 'page';
  els.frame.classList.toggle('cda-frame--full', rt.mode === 'full');
  rt.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  var scale;
  if (rt.mode === 'full') {
    scale = cdaFullScale(window.innerWidth, window.innerHeight, rt.dpr);
  } else {
    var width = els.holder.clientWidth;
    if (!(width > 0)) return;
    scale = cdaPageScale(width, rt.dpr);
  }
  var size = cdaStageSize(scale, rt.dpr);
  rt.scale = size.w / CDA_W;
  els.stage.style.width = size.w + 'px';
  els.stage.style.height = size.h + 'px';
  els.stage.style.setProperty('--cda-scale', String(rt.scale));
}

function cdaWatchSize() {
  if (window.ResizeObserver) new window.ResizeObserver(cdaLayout).observe(CDA_RT.els.holder);
  window.addEventListener('resize', cdaLayout);
  document.addEventListener('fullscreenchange', cdaLayout);
  cdaWatchRatio();
}

// A change of the device pixel ratio (browser zoom, a window moved to
// another screen) lays the frame out again: a query for the ratio now
// fires once when it stops matching, and the next one is set up then.
// Browsers without matchMedia still lay out again on their resize event.
function cdaWatchRatio() {
  if (!window.matchMedia) return;
  var dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  var query = window.matchMedia('(resolution: ' + dpr + 'dppx)');
  if (query.addEventListener) query.addEventListener('change', cdaRatioChange, { once: true });
}

function cdaRatioChange() {
  cdaLayout();
  cdaWatchRatio();
}

function cdaNoop() {}

// A promise an API may return: its rejection is ignored.
function cdaQuiet(result) {
  if (result && typeof result.then === 'function') result.then(null, cdaNoop);
}

// F: the frame in and out of fullscreen; nothing where the API is missing.
function cdaToggleFullscreen() {
  var frame = CDA_RT.els.frame;
  if (document.fullscreenElement) {
    if (document.exitFullscreen) cdaQuiet(document.exitFullscreen());
  } else if (frame.requestFullscreen) {
    cdaQuiet(frame.requestFullscreen());
  }
}

// ── start-up ──

function cdaReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Builds the page once: the elements, the save, the HUD icons, the guide,
// the level select, the listeners, the frame's size, the title.  A second
// call does nothing.
function cdaInit() {
  var rt = CDA_RT;
  if (rt.els) return;
  rt.els = cdaFind();
  rt.ctx = rt.els.canvas.getContext('2d');
  rt.image = rt.ctx.createImageData(CDA_W, CDA_H);
  rt.pixels = new Uint32Array(rt.image.data.buffer);
  var read = cdaReadSave(CDA_LEVELS.length);
  rt.save = read.state;
  rt.newer = read.newer;
  cdaStoreResult(read);
  rt.reduced = cdaReducedMotion();
  cdaSfxSetMute(rt.save.settings.mute);
  cdaBuildHud();
  cdaBuildGuide();
  cdaBuildSelect();
  cdaRenderSettings();
  cdaBind();
  cdaLayout();
  cdaShowTitle();
}

function cdaRuntime() {
  return CDA_RT;
}

CDA_API.CDA_RT = CDA_RT;
CDA_API.cdaInit = cdaInit;
CDA_API.cdaRuntime = cdaRuntime;
CDA_API.cdaFind = cdaFind;
