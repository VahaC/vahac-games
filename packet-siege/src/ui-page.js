// ── ui: the page runtime, its elements, small DOM helpers, the save and the screens ──
// Owns pksRuntime (the one live state of the page), pksFind, the DOM
// helpers (pksMake, pksIcon, pksSetText ...), the save on the page (pksSave,
// the storage warning) and pksShow (which screen is on).  Uses core,
// sprites (pksBuildAtlas's atlas), render (pksDrawIcon), storage and
// ui-text; inside function bodies also the later ui parts.
//
// Every screen lives in the one frame (#pks-frame), at the frame's size:
// the level select, the loadout and the codex fill it (and scroll inside
// it); the level is the HUD, the field and the tray; the result, pause and
// leave-confirm overlays cover the level under its HUD, the help overlay
// the whole frame.
//
// The runtime:
//   els       the page elements (pksFind); null until pksInit ran
//   atlas     the sprite atlas, built once; ctx the field's 2D context
//   storage   window.localStorage, or null where reading it throws
//   state     the save (storage part) as the page keeps it
//   warned    the text of the storage warning last shown, or null (each text
//             shows once)
//   started   pksInit is done (screen changes may scroll the frame into view)
//   screen    'select' | 'loadout' | 'play' | 'result' | 'codex'
//   mode      'page' | 'full' (the Fullscreen API) | 'max' (the frame fixed
//             over the viewport where the API is missing or refuses)
//   layout    the frame's layout now (ui-layout); unlock the page's scroll
//             styles saved while maximised
//   confirm   { action: 'leave' | 'restart', paused } while the leave
//             question shows (paused: whether the level was paused before)
//   help      null, or where the help overlay opened: 'select' | 'pause'
//   newsEnd   the sim tick the news banner goes at (0: no news showing)
//   level     the level on the loadout, level and result screens (0 before)
//   loadout   pksLoadoutFor's result on the loadout screen; picks its
//             toggle buttons by defender id
//   cards     the defender ids of the level being played
//   sim, view the level being played and its view (render part)
//   paused    the level is paused (the overlay shows)
//   ending    seconds left of the beat between a level's end and its result
//   result    { win, rec, stars, tripped } or { win: false, lane, enemy, overtime } once over
//   selected  the card in hand (a defender id, PKS_DECOM) or null
//   aim       the cell the pointer or the keyboard cursor points at, or null
//   cursor    the keyboard cell cursor (null until an arrow or Enter)
//   focused   the field has the keyboard focus (the cursor shows)
//   aimText   what the status line last said about the aim, or null
//   armed     { defender id: true } for the traps of the level that armed
//   press     the pointer pressed on the field: { id, x, y }, or null
//   raf, last, acc  the frame loop: the frame asked for (0: none), the last
//             frame's time (-1: none yet), seconds not stepped yet
//   levelButtons, cardEls  the level select's buttons, the cards on screen
//   zone      the zone the level select shows; zoneTiles, zoneGroups its
//             15 tiles and level groups
//   run       the stored snapshot of a level in progress the level select
//             offers to resume (pksParseRun's result), or null
//   runOwn    this tab owns the snapshot slot for the level it plays;
//             runMine the snapshot text it wrote last (null: none yet);
//             runNext the sim tick of the next timed snapshot (storage part)
//   ruleEls   the HUD's rule badges: [{ name, el, clock, alert, text, say }]
//   splitSaid a boss split of this level was announced; upkeepSaid the
//             upkeep lines said in this run of charges not paid in full
//             ({ part, unpaid }); overtime the sim
//             said 'overtime' (the loss that follows is one); overtimeSaid
//             how many overtime marks were said (ui-rules)

var pksRuntime = {
  els: null, atlas: null, ctx: null, storage: null, state: null, warned: null, started: false,
  screen: 'select', mode: 'page', layout: null, unlock: null, confirm: null, help: null, newsEnd: 0,
  level: 0, loadout: null, picks: {}, cards: [], sim: null, view: null,
  paused: false, ending: 0, result: null, selected: null, aim: null, cursor: null,
  focused: false, aimText: null, press: null, raf: 0, last: -1, acc: 0, armed: {},
  levelButtons: [], cardEls: [], zone: 1, zoneTiles: [], zoneGroups: [],
  run: null, runOwn: false, runMine: null, runNext: 0, ruleEls: [],
  splitSaid: false, upkeepSaid: {}, overtime: false, overtimeSaid: 0
};

// The layers that fill the frame (the result is an overlay on 'play').
var PKS_LAYERS = ['select', 'loadout', 'play', 'codex'];

function pksFind() {
  var ids = {
    live: 'pks-live', holder: 'pks-holder', frame: 'pks-frame',
    warning: 'pks-warning', warningText: 'pks-warning-text', warningClose: 'pks-warning-close',
    select: 'pks-select', total: 'pks-total', codexOpen: 'pks-codex-open', helpOpen: 'pks-help-open',
    selectFull: 'pks-select-full', selectBody: 'pks-select-body', zones: 'pks-zones', zoneTiles: 'pks-zone-tiles',
    run: 'pks-run', runText: 'pks-run-text', runResume: 'pks-run-resume', runFresh: 'pks-run-fresh',
    rules: 'pks-rules', pausedRules: 'pks-paused-rules',
    codexBosses: 'pks-codex-bosses', codexZones: 'pks-codex-zones',
    loadout: 'pks-loadout', loadoutTitle: 'pks-loadout-title', loadoutCount: 'pks-loadout-count',
    loadoutList: 'pks-loadout-list', loadoutStart: 'pks-loadout-start', loadoutBack: 'pks-loadout-back',
    play: 'pks-play', hud: 'pks-hud', hudLevel: 'pks-hud-level', cyclesIcon: 'pks-cycles-icon', cycles: 'pks-cycles',
    surge: 'pks-surge', pause: 'pks-pause', speed: 'pks-speed', levels: 'pks-levels', full: 'pks-full',
    field: 'pks-field', canvas: 'pks-canvas', news: 'pks-news', tray: 'pks-tray', cards: 'pks-cards',
    status: 'pks-status', paused: 'pks-paused', resume: 'pks-resume', restart: 'pks-restart',
    pauseHelp: 'pks-pause-help', quit: 'pks-quit',
    confirm: 'pks-confirm', confirmText: 'pks-confirm-text', confirmNo: 'pks-confirm-no', confirmYes: 'pks-confirm-yes',
    result: 'pks-result', resultTitle: 'pks-result-title', resultStars: 'pks-result-stars',
    resultText: 'pks-result-text', resultUnlocks: 'pks-result-unlocks', next: 'pks-next',
    replay: 'pks-replay', resultLevels: 'pks-result-levels',
    codex: 'pks-codex', codexDefenders: 'pks-codex-defenders', codexEnemies: 'pks-codex-enemies',
    codexBack: 'pks-codex-back', help: 'pks-help', helpClose: 'pks-help-close'
  };
  var els = {};
  var names = Object.keys(ids);
  for (var i = 0; i < names.length; i++) els[names[i]] = document.getElementById(ids[names[i]]);
  return els;
}

function pksNewCanvas(w, h) {
  var c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// An element with a class and, when given, its text.
function pksMake(tag, className, text) {
  var el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

function pksButtonEl(className, id) {
  var b = pksMake('button', className);
  b.type = 'button';
  b.id = id;
  return b;
}

// A canvas the size of sprite `name` with the sprite on it (CSS sizes it);
// `names` may be a list (a rule's icon: pksRuleIcon), drawn one over the
// other, each centred on the first.
function pksIcon(names, className) {
  var list = [].concat(names);
  var F = pksRuntime.atlas.frames;
  var f = F[list[0]];
  var c = pksNewCanvas(f.w, f.h);
  var ctx = c.getContext('2d');
  c.className = className;
  c.setAttribute('aria-hidden', 'true');
  for (var i = 0; i < list.length; i++) {
    pksDrawIcon(ctx, pksRuntime.atlas, list[i], (f.w - F[list[i]].w) / 2, (f.h - F[list[i]].h) / 2, 1);
  }
  return c;
}

// The frames of boss tier `tier` (1-based) as an icon, in its tint.
function pksBossIcon(tier, className) {
  var name = pksBossArt(tier)[0];
  var set = pksBossSet(pksRuntime.atlas, tier, name);
  var f = set[name];
  var c = pksNewCanvas(f.w, f.h);
  c.className = className;
  c.setAttribute('aria-hidden', 'true');
  var ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pksRuntime.atlas.canvas, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  return c;
}

// The same as a dark silhouette: what the codex shows of what is not known.
function pksSilhouette(name, className) {
  var c = pksIcon(name, className);
  var ctx = c.getContext('2d');
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#2a3a5c';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

function pksSetText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function pksToggle(el, show) {
  el.classList.toggle('pks-hidden', !show);
}

function pksSetStatus(text) {
  pksSetText(pksRuntime.els.status, text);
}

// Says text in the live region (surges, breakers, unlocks, the result).
function pksAnnounce(text) {
  pksRuntime.els.live.textContent = text;
}

// Focus without the page jumping (a phone, an embedding page).
function pksFocus(el) {
  el.focus({ preventScroll: true });
}

// ── the save ──

// window.localStorage, or null where touching it throws (blocked site data).
function pksStorage() {
  try {
    return window.localStorage;
  } catch (err) {
    return null;
  }
}

// A read or write result of the storage part: a failure (blocked or full
// storage, a save of a newer version there) shows the warning, quietly,
// once per text, and the game goes on.
function pksStorageResult(r) {
  if (r.ok) return;
  var text = pksStorageWarning(r);
  if (pksRuntime.warned === text) return;
  pksRuntime.warned = text;
  pksSetText(pksRuntime.els.warningText, text);
  pksToggle(pksRuntime.els.warning, true);
}

// OK on the warning: it goes (the game said it once).
function pksHideWarning() {
  pksToggle(pksRuntime.els.warning, false);
}

// Writes the save (merged with a second tab's progress, which it adopts).
function pksSave() {
  var r = pksWriteSave(pksRuntime.storage, pksRuntime.state);
  pksRuntime.state = r.state;
  pksStorageResult(r);
}

// Another tab wrote the save (its progress joins this one's) or the
// snapshot (the level select's offer follows it).
function pksHandleStorage(event) {
  if (event.key === PKS_SAVE_KEY) {
    var read = pksReadSave(pksRuntime.storage);
    pksRuntime.state = pksMergeSaves(pksRuntime.state, read.state);
    pksStorageResult(read);
  } else if (event.key === PKS_RUN_KEY) {
    pksLoadRun();
  } else {
    return;
  }
  pksRenderSelect();
}

// ── the snapshot of a level in progress (storage part) ──

// The stored snapshot as the level select offers it: a sound one of a level
// that is open; anything else stored there is dropped, quietly, but a
// snapshot of a newer version stays where it is and the warning says so.
function pksLoadRun() {
  var rt = pksRuntime;
  var r = pksReadRun(rt.storage);
  rt.run = r.run && r.run.n <= rt.state.unlocked ? r.run : null;
  if (r.newer) pksStorageResult({ ok: false, newer: r.newer, key: PKS_RUN_KEY });
  else if (r.text !== null && !rt.run) pksDropRun(rt.storage, r.text);
}

// The level being played into the snapshot, while this tab owns it and the
// level is on; a tab that finds another tab's snapshot there stops.
// Returns whether the snapshot now holds the level.
function pksSnapshot() {
  var rt = pksRuntime;
  if (!rt.runOwn || rt.screen !== 'play' || rt.sim.status !== 'playing') return false;
  var text = pksRunText(rt.sim, rt.cards);
  var r = pksPutRun(rt.storage, text, rt.runMine);
  rt.runNext = rt.sim.tick + pksSteps(PKS_RUN_EVERY);
  if (r.ok) rt.runMine = text;
  if (r.lost) rt.runOwn = false;
  return r.ok;
}

// The level is over (won or lost): its snapshot goes, if it is still ours.
function pksEndRun() {
  var rt = pksRuntime;
  if (rt.runOwn) pksDropRun(rt.storage, rt.runMine);
  rt.runOwn = false;
}

// ── screens ──

// Shows one screen in the frame (the result over the level it ends); the
// leave question and the help close; the frame loop runs only on the level
// screen; after start-up the frame's top comes into view when it is not.
function pksShow(name) {
  var rt = pksRuntime;
  var layer = name === 'result' ? 'play' : name;
  rt.screen = name;
  pksCloseOverlays();
  for (var i = 0; i < PKS_LAYERS.length; i++) pksToggle(rt.els[PKS_LAYERS[i]], PKS_LAYERS[i] === layer);
  pksToggle(rt.els.result, name === 'result');
  pksUpdateLoop();
  if (rt.started) pksRevealFrame();
}

// Level n was picked (select, Next, Replay, Retry): the loadout screen when
// the player owns more defenders than the level has slots, else the level.
function pksChooseLevel(n) {
  var lo = pksLoadoutFor(pksRuntime.state, n);
  pksRuntime.level = n;
  if (lo.choose) pksOpenLoadout(lo);
  else pksStartLevel(n, lo.pick);
}

// Builds the page once: the atlas, the level select, the save, the
// listeners, the frame's layout.  A second call does nothing.
function pksInit() {
  var rt = pksRuntime;
  if (rt.els) return;
  rt.els = pksFind();
  rt.atlas = pksBuildAtlas(pksNewCanvas);
  rt.ctx = rt.els.canvas.getContext('2d');
  rt.storage = pksStorage();
  var read = pksReadSave(rt.storage);
  rt.state = read.state;
  pksStorageResult(read);
  pksLoadRun();
  pksDrawIcon(rt.els.cyclesIcon.getContext('2d'), rt.atlas, 'icon-cycles', 0, 0, 1);
  pksBuildSelect();
  rt.zone = pksHomeZone();
  pksRenderSelect();
  pksRenderSpeed();
  pksRenderFull();
  pksBind();
  pksLayoutFrame();
  pksShow('select');
  rt.started = true;
}
