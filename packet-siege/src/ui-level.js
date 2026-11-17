// ── ui: a level on screen: start, resume, cards, HUD, placing, events, pause, speed, the frame loop ──
// Owns pksStartLevel and pksResumeRun, the cards and the HUD, what a tap or a
// key does on a cell, the sim events the page reacts to (met enemies,
// surges, breakers, win, loss), pause and speed, and the frame loop.  Uses
// core (PKS_STEP, PKS_MAX_FRAME), sim (pksNewSim, pksStep, pksCanPlace,
// pksPlace, pksRemove), render (the view, pksRender), storage
// (pksRecordWin, pksRecordMet, the snapshot), ui-text and ui-page; inside
// function bodies also ui-screens (pksShowResult) and ui-rules (the rule
// badges and the rules' events).
//
// The loop: requestAnimationFrame while the level screen is on and not
// paused, nothing otherwise.  A frame adds its time (at most PKS_MAX_FRAME)
// to an accumulator and runs a step slot per PKS_STEP of it: one sim step,
// or two at 2x speed (pksStep, pksViewStep, pksViewEvents and the page's
// own reading of the events for each).  Then it draws once.
//
// The snapshot of the level (pks-run, storage part): written on pause (the
// window losing the focus, a hidden tab, the leave or restart question), on pagehide
// and after each PKS_RUN_EVERY seconds of play (pksSnapshot, ui-page), while
// this tab owns the slot; dropped by any level's start (restart and Start
// over too) and by this level's win or loss.

// The Decommission tool's stand-in among the sim's cards: always ready, free.
var PKS_DECOM_CARD = { left: 0, recharge: 1, cost: 0 };

var PKS_EVENT_UI = {
  spawn: pksOnSpawn, surgeWarn: pksOnSurgeWarn, breaker: pksOnBreaker, win: pksOnWin, lose: pksOnLose,
  armed: pksOnArmed, destroyed: pksOnDestroyed
};

// Level n with the defender ids `cards`: a new sim and view, the cards, the
// HUD, the news, the loop running and the keys on the field.  Starting a
// level drops any saved level in progress (of this tab or another) and makes
// this tab the owner of the snapshot slot.
function pksStartLevel(n, cards) {
  var rt = pksRuntime;
  var lv = pksLevel(n);
  pksDropRun(rt.storage);
  rt.run = null;
  rt.runOwn = true;
  rt.runMine = null;
  pksBeginLevel(lv, cards, pksNewSim(lv, cards));
  pksSetStatus(pksStartText(lv, cards.length));
  var news = pksNewsLines(lv, rt.state, cards);
  for (var i = 0; i < news.length; i++) rt.els.news.appendChild(pksLine(news[i], 'pks-news-item'));
  rt.newsEnd = news.length ? pksSteps(PKS_NEWS_TIME) : 0;
  rt.els.news.classList.toggle('pks-news--off', !news.length);
  pksAnnounce(pksResultAnnouncement('Level ' + n + ', ' + lv.name, pksStartText(lv, cards.length), news));
  pksDrawFrame();
}

// A saved level in progress (pksParseRun's result) goes on where it was,
// paused: its sim as it was saved, a new view (effects in flight are not
// saved), the traps that had armed remembered.  This tab owns the snapshot
// slot from now on.
function pksResumeRun(run) {
  var rt = pksRuntime;
  var lv = run.sim.level;
  rt.run = null;
  rt.runOwn = true;
  rt.runMine = pksReadRun(rt.storage).text;
  pksBeginLevel(lv, run.cards, run.sim);
  for (var i = 0; i < run.sim.defenders.length; i++) {
    if (run.sim.defenders[i].kind === 'trap' && run.sim.defenders[i].state === 'armed') rt.armed[run.sim.defenders[i].id] = true;
  }
  rt.newsEnd = 0;
  rt.els.news.classList.add('pks-news--off');
  pksPause();
  var text = 'Level ' + lv.n + ', ' + lv.name + ', resumed at ' + pksClock(run.sim.time) + ': paused. Press Resume or P to go on.';
  pksSetStatus(text);
  pksAnnounce(text);
}

// What a level start and a resume share: the runtime, the cards, the HUD
// and its rules, the level screen with the keys on the field.
function pksBeginLevel(lv, cards, sim) {
  var rt = pksRuntime;
  rt.level = lv.n;
  rt.cards = cards;
  rt.sim = sim;
  rt.view = pksNewView();
  rt.paused = false;
  rt.ending = 0;
  rt.result = null;
  rt.selected = null;
  rt.aim = null;
  rt.cursor = null;
  rt.aimText = null;
  rt.press = null;
  rt.acc = 0;
  rt.armed = {};
  rt.runNext = sim.tick + pksSteps(PKS_RUN_EVERY);
  pksBuildCards();
  pksBuildRules(lv);
  pksSetText(rt.els.hudLevel, pksLevelTitle(lv));
  rt.els.hudLevel.setAttribute('title', pksLevelTitle(lv));
  rt.els.news.textContent = '';
  rt.els.news.classList.remove('pks-news--low');
  pksShow('play');
  pksRenderPause();
  pksFocus(rt.els.canvas);
}

// ── cards ──

function pksBuildCards() {
  var rt = pksRuntime;
  var ids = rt.cards.concat([PKS_DECOM]);
  rt.els.cards.textContent = '';
  rt.cardEls = [];
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var key = i < rt.cards.length ? pksCardKey(i) : 'X';
    var b = pksButtonEl('pks-card', 'pks-card-' + id);
    b.setAttribute('aria-label', PKS_CARD_LABELS[id] + ', key ' + key);
    b.setAttribute('title', PKS_CARD_NAMES[id] + PKS_CARD_ARMS[id] + ' (' + key + ')');
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(pksMake('span', 'pks-card-key', key));
    b.appendChild(pksIcon(pksIconName(id), 'pks-card-icon'));
    b.appendChild(pksMake('span', 'pks-card-name', PKS_CARD_SHORTS[id]));
    b.appendChild(pksMake('span', 'pks-card-cost', PKS_CARD_COSTS[id]));
    var shade = pksMake('span', 'pks-card-shade');
    b.appendChild(shade);
    b.addEventListener('click', pksGameButton(pksCardAction(id)));
    rt.els.cards.appendChild(b);
    rt.cardEls.push({ id: id, el: b, shade: shade, height: '0%', poor: false, pressed: false });
  }
  pksCardColumns();
}

function pksCardAction(id) {
  return function () {
    pksSelect(id);
  };
}

// A button of the level screen: a mouse or touch click hands the keys back
// to the field; a keyboard press (detail 0) leaves the focus where it is.
function pksGameButton(action) {
  return function (event) {
    if (event.detail > 0) pksFocus(pksRuntime.els.canvas);
    action();
  };
}

// The recharge shade, the unaffordable look and the card in hand.
function pksUpdateCards() {
  var rt = pksRuntime;
  var sim = rt.sim;
  for (var i = 0; i < rt.cardEls.length; i++) {
    var c = rt.cardEls[i];
    var card = sim.cards[i] || PKS_DECOM_CARD;
    var height = Math.ceil(card.left * 100 / card.recharge) + '%';
    var poor = sim.cycles < card.cost;
    var pressed = rt.selected === c.id;
    if (height !== c.height) {
      c.height = height;
      c.shade.style.height = height;
    }
    if (poor !== c.poor) {
      c.poor = poor;
      c.el.classList.toggle('pks-card--poor', poor);
    }
    if (pressed !== c.pressed) {
      c.pressed = pressed;
      c.el.setAttribute('aria-pressed', String(pressed));
    }
  }
}

// Whether the level takes input now (not paused, not over).
function pksAccepting() {
  return pksRuntime.sim.status === 'playing' && !pksRuntime.paused;
}

// A card picked (a tap, 1-8, X): in hand, or put down when it was already.
function pksSelect(id) {
  var rt = pksRuntime;
  if (!pksAccepting()) return;
  rt.selected = rt.selected === id ? null : id;
  rt.aimText = null;
  pksSetStatus(rt.selected ? PKS_CARD_HINTS[id] : PKS_CARD_NAMES[id] + ' put down.');
  pksDrawFrame();
}

// ── a cell: aiming and acting ──

function pksOccupantAt(lane, col) {
  var list = pksRuntime.sim.defenders;
  for (var i = 0; i < list.length; i++) {
    if (list[i].lane === lane && list[i].col === col) return list[i];
  }
  return null;
}

// The ghost of the card in hand on the aimed cell, and what the status line
// says about it (once per change).
function pksAimGhost() {
  var rt = pksRuntime;
  var aim = rt.aim;
  rt.view.cursor = rt.focused ? rt.cursor : null;
  if (!rt.selected || !aim || !pksAccepting()) {
    rt.view.ghost = null;
    rt.aimText = null;
    return;
  }
  var occupant = pksOccupantAt(aim.lane, aim.col);
  var r = rt.selected === PKS_DECOM ? { ok: !!occupant, reason: 'empty' } : pksCanPlace(rt.sim, rt.selected, aim.lane, aim.col);
  rt.view.ghost = { card: rt.selected, lane: aim.lane, col: aim.col, ok: r.ok };
  var text = pksAimStatus(r, occupant);
  if (text !== rt.aimText) {
    rt.aimText = text;
    pksSetStatus(text);
  }
}

function pksAimStatus(r, occupant) {
  if (r.ok) return pksAimText(pksRuntime.selected, occupant && occupant.type, r.cost);
  if (r.reason === 'empty') return 'Nothing to decommission here';
  return pksRefusalText(r);
}

// A tap or Enter on a cell: place the card in hand, decommission, or say
// what is there.
function pksActAt(lane, col) {
  var rt = pksRuntime;
  var sim = rt.sim;
  var r;
  rt.aim = { lane: lane, col: col };
  if (!pksAccepting()) return;
  if (!rt.selected) {
    var d = pksOccupantAt(lane, col);
    pksSetStatus(d ? PKS_CARD_NAMES[d.type] + ': ' + Math.ceil(d.hp) + ' of ' + d.maxHp + ' HP' : 'Pick a card first: tap one below the field or press its number.');
    return;
  }
  if (rt.selected === PKS_DECOM) {
    r = pksRemove(sim, lane, col);
    pksSetStatus(r.ok ? 'Decommissioned ' + PKS_CARD_NAMES[r.def] + '.' : 'Nothing to decommission here');
  } else {
    r = pksPlace(sim, rt.selected, lane, col);
    pksSetStatus(r.ok ? pksPlacedText(rt.selected, r.cost) : pksRefusalText(r));
  }
  if (r.ok) {
    pksViewEvents(rt.view, sim);
    rt.selected = null;
    pksHideNews();
  }
  rt.aimText = null;
  pksDrawFrame();
}

// ── sim events ──

function pksHandleEvents(events) {
  for (var i = 0; i < events.length; i++) {
    var fn = PKS_EVENT_UI[events[i].type] || PKS_RULE_EVENT_UI[events[i].type];
    if (fn) fn(events[i]);
  }
}

// A spawn of an enemy not met before: met, and saved at once (leaving the
// level or closing the tab keeps it for the codex).
function pksOnSpawn(ev) {
  var r = pksRecordMet(pksRuntime.state, ev.enemy);
  pksRuntime.state = r.state;
  if (r.added) pksSave();
}

// A trap armed: remembered, so its end can tell eaten-before-armed apart.
function pksOnArmed(ev) {
  pksRuntime.armed[ev.id] = true;
}

// A defender that arms after placing, eaten before it ever armed: the status
// line says so (not the live region: it is the field's news, not a turn).
function pksOnDestroyed(ev) {
  if (ev.why === 'eaten' && PKS_DEF[ev.def].arm && !pksRuntime.armed[ev.id]) pksSetStatus(pksEatenUnarmedText(ev.def));
}

function pksOnSurgeWarn(ev) {
  var text = pksSurgeWarnText(ev, pksRuntime.sim.level.surges.length);
  pksSetStatus(text);
  pksAnnounce(text);
}

function pksOnBreaker(ev) {
  var text = pksBreakerText(ev);
  pksSetStatus(text);
  pksAnnounce(text);
}

// The level is won: the win is saved at once (a reload during the beat
// keeps it), the result follows after the beat.  The snapshot goes first,
// so a nearly full storage has its room for the save.
function pksOnWin(ev) {
  var rt = pksRuntime;
  var rec = pksRecordWin(rt.state, rt.level, ev.stars);
  rt.state = rec.state;
  pksEndRun();
  pksSave();
  pksEnd({ win: true, rec: rec, stars: ev.stars, tripped: rt.sim.tripped }, 'Level ' + rt.level + ' secured with ' + ev.stars + ' of 3 stars.');
}

// A breach, or overtime when the sim said 'overtime' just before (ui-rules).
function pksOnLose(ev) {
  var res = { win: false, lane: ev.lane, enemy: ev.enemy, overtime: pksRuntime.overtime };
  pksEndRun();
  pksSave();
  pksEnd(res, pksLossTitle(res) + '. ' + pksLossText(res));
}

function pksEnd(result, text) {
  var rt = pksRuntime;
  rt.result = result;
  rt.ending = PKS_END_BEAT;
  rt.selected = null;
  pksSetStatus(text);
  pksAnnounce(text);
}

// ── pause and speed ──

function pksPause() {
  var rt = pksRuntime;
  if (rt.screen !== 'play' || rt.paused || rt.sim.status !== 'playing') return;
  rt.paused = true;
  pksRenderPause();
  pksAnnounce('Paused.');
  pksUpdateLoop();
  pksSnapshot();
  pksDrawFrame();
}

function pksResume() {
  var rt = pksRuntime;
  rt.paused = false;
  pksCloseOverlays();
  pksRenderPause();
  pksSetStatus('Resumed.');
  pksUpdateLoop();
  pksFocus(rt.els.canvas);
}

function pksTogglePause() {
  if (pksRuntime.paused) pksResume();
  else pksPause();
}

// The pause overlay shows while paused, unless the leave question or the
// help stands in its place.
function pksRenderPause() {
  var rt = pksRuntime;
  var els = rt.els;
  pksToggle(els.paused, rt.paused && !rt.confirm && !rt.help);
  pksSetText(els.pause, pksRuntime.paused ? 'Resume' : 'Pause');
  els.pause.setAttribute('aria-pressed', String(pksRuntime.paused));
}

// 1x / 2x, remembered in the save.
function pksToggleSpeed() {
  pksRuntime.state.speed = 3 - pksRuntime.state.speed;
  pksSave();
  pksRenderSpeed();
  pksSetStatus('Speed ' + pksRuntime.state.speed + 'x.');
}

function pksRenderSpeed() {
  var speed = pksRuntime.state.speed;
  pksSetText(pksRuntime.els.speed, speed + 'x');
  pksRuntime.els.speed.setAttribute('aria-pressed', String(speed === 2));
}

// ── the frame loop ──

function pksUpdateLoop() {
  var rt = pksRuntime;
  var want = rt.screen === 'play' && !rt.paused;
  if (want && !rt.raf) {
    rt.last = -1;
    rt.raf = requestAnimationFrame(pksFrame);
  } else if (!want && rt.raf) {
    cancelAnimationFrame(rt.raf);
    rt.raf = 0;
  }
}

function pksFrame(ts) {
  var rt = pksRuntime;
  var dt = rt.last < 0 ? 0 : Math.min(PKS_MAX_FRAME, (ts - rt.last) / 1000);
  rt.raf = 0;
  rt.last = ts;
  rt.acc += dt;
  while (rt.acc >= PKS_STEP - 1e-9) {
    rt.acc -= PKS_STEP;
    pksStepSlot();
  }
  if (rt.result) {
    rt.ending -= dt;
    if (rt.ending <= 0) {
      pksShowResult();
      return;
    }
  }
  pksDrawFrame();
  rt.raf = requestAnimationFrame(pksFrame);
}

// One step slot: one sim step, two at 2x.
function pksStepSlot() {
  var rt = pksRuntime;
  for (var i = 0; i < rt.state.speed; i++) {
    pksStep(rt.sim);
    pksViewStep(rt.view);
    pksViewEvents(rt.view, rt.sim);
    pksHandleEvents(rt.sim.events);
  }
  if (rt.sim.tick >= rt.runNext) pksSnapshot();
}

// The news banner goes after PKS_NEWS_TIME of play or with the first
// placement; while it shows it keeps off the lanes aimed at (over the top
// lanes it moves to the bottom of the field).
function pksHideNews() {
  pksRuntime.newsEnd = 0;
  pksRuntime.els.news.classList.add('pks-news--off');
}

function pksUpdateNews() {
  var rt = pksRuntime;
  if (!rt.newsEnd) return;
  if (rt.sim.tick >= rt.newsEnd) pksHideNews();
  else rt.els.news.classList.toggle('pks-news--low', !!rt.aim && rt.aim.lane < 2);
}

// The field, the HUD and the cards as they are now.
function pksDrawFrame() {
  var rt = pksRuntime;
  pksUpdateNews();
  pksAimGhost();
  pksRender(rt.ctx, rt.atlas, rt.sim, rt.view);
  pksSetText(rt.els.cycles, String(rt.sim.cycles));
  pksSetText(rt.els.surge, pksSurgeText(rt.sim));
  rt.els.surge.classList.toggle('pks-hud-surge--warn', rt.sim.warned > rt.sim.surged);
  pksUpdateCards();
  pksUpdateRules();
}
