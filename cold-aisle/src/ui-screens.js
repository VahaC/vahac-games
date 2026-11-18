// ── ui-screens: title, level select, briefing, death, results, upgrades, the end of the episode, the settings ──
// Owns what each menu screen shows and its buttons: cdaShowTitle (its
// picture, CDA_TITLE_VIEW, and New game with its question),
// cdaBuildSelect / cdaRenderSelect / cdaShowSelect, cdaOpenBriefing,
// cdaShowDeath, cdaShowResults, cdaShowUpgrades / cdaBuy, cdaShowEnd,
// cdaRenderSettings, cdaSensInput, cdaToggleMute and cdaRefreshScreen.
// Uses core, tables, map (cdaParseLevel), sim (cdaNewSim), levels
// (CDA_LEVELS, cdaLevelCarry), render-view (cdaNewView, cdaRender), storage,
// sfx (cdaSfxUi, cdaSfxSetMute), ui-text and ui-page; inside function
// bodies also ui-hud (cdaSay) and ui-loop (cdaBeginLevel).
//
// Flow: title -> Continue: level select; New game: the briefing of level 1
// (after a question when it would erase progress); Help: the help overlay.
// Level select -> an open level: its briefing -> Start: the level.  Won:
// results -> Next level (its briefing), Upgrades, Levels; after the last
// level Next is Finish: the end of the episode.  Lost: death -> Retry (the
// same carry) or Levels.  Upgrades go back where they came from.
// A level not in CDA_LEVELS (cdaRuntime().startLevel without asLevel) has
// results with nothing recorded and no Next.

// The title picture's camera in level 1: down the cold aisle between the
// rack rows, the infected rack on the right (looked at with shot-like
// renders on 2026-11-18).  A level 1 whose cell there is not floor any more
// is seen from its start instead.
var CDA_TITLE_VIEW = { x: 11.8, y: 4.5, angle: Math.PI - 0.1 };

// Whether the save holds anything a new game would erase.
function cdaHasProgress(save) {
  if (save.deaths > 0 || save.playTime > 0) return true;
  for (var i = 0; i < save.best.length; i++) if (save.best[i]) return true;
  return false;
}

// ── title ──

function cdaRenderTitle() {
  cdaToggle(CDA_RT.els.cont, cdaHasProgress(CDA_RT.save));
}

function cdaShowTitle() {
  var els = CDA_RT.els;
  cdaRenderTitle();
  cdaShow('title', cdaHasProgress(CDA_RT.save) ? els.cont : els.newGame);
  cdaTitlePicture();
}

// The picture behind the title: one frame of level 1 from CDA_TITLE_VIEW,
// the tool in hand lowered out of sight (a switch half done), drawn once by
// cdaRender on the canvas (no loop runs on the title; the screen's
// translucent backdrop, cda-screen--over, darkens it).  The view is made
// once a page load, the sim each time the title shows.
function cdaTitlePicture() {
  var rt = CDA_RT;
  var v = CDA_TITLE_VIEW;
  if (!rt.title) rt.title = { view: cdaNewView() };
  var sim = cdaNewSim(cdaParseLevel(CDA_LEVELS[0]), cdaLevelCarry(0, null), {}, 1);
  var p = sim.player;
  var m = sim.map;
  if (v.x < m.w && m.kind[Math.floor(v.y) * m.w + Math.floor(v.x)] === 'floor') {
    p.x = p.px = v.x;
    p.y = p.py = v.y;
    p.angle = p.pangle = v.angle;
  }
  p.switchT = cdaSteps(CDA_PLAYER.switchTime) / 2;
  cdaRender(rt.title.view, sim, 1, rt.pixels);
  rt.ctx.putImageData(rt.image, 0, 0);
}

function cdaNewGameClick() {
  var save = CDA_RT.save;
  if (!cdaHasProgress(save)) {
    cdaStartNewGame();
    return;
  }
  var won = 0;
  for (var i = 0; i < save.best.length; i++) if (save.best[i]) won++;
  cdaAsk(CDA_UI.newGame + won + ' of ' + save.best.length + ' floors cleared, ' + cdaPatchesEarned(save) + ' patches earned, ' +
    save.deaths + ' deaths, ' + cdaFormatTime(save.playTime) + ' played.', 'Erase and start', cdaStartNewGame, CDA_RT.els.newGame);
}

function cdaStartNewGame() {
  cdaEraseSave();
  cdaOpenBriefing(0);
}

// ── level select ──

function cdaBuildSelect() {
  var rt = CDA_RT;
  rt.levelButtons = [];
  for (var i = 0; i < CDA_LEVELS.length; i++) {
    var b = cdaButton('cda-level', 'cda-level-' + (i + 1), '', '');
    b.appendChild(cdaMake('span', 'cda-level-name', (i + 1) + '. ' + CDA_LEVELS[i].name));
    b.appendChild(cdaMake('span', 'cda-level-stats', ''));
    b.addEventListener('click', cdaLevelClick(i));
    rt.els.levels.appendChild(b);
    rt.levelButtons.push(b);
  }
}

function cdaLevelClick(i) {
  return function () {
    cdaOpenBriefing(i);
  };
}

// The stats line of level i on the level select.
function cdaLevelStats(save, i) {
  var best = save.best[i];
  if (i >= save.unlocked) return CDA_UI.locked;
  if (!best) return CDA_UI.notWon;
  return 'Best ' + cdaFormatTime(best.time) + ' · enemies ' + best.kills + '/' + best.enemies + ' · secrets ' + best.secrets + '/' +
    best.secretsTotal;
}

function cdaRenderSelect() {
  var rt = CDA_RT;
  var save = rt.save;
  for (var i = 0; i < rt.levelButtons.length; i++) {
    var b = rt.levelButtons[i];
    var stats = cdaLevelStats(save, i);
    b.disabled = i >= save.unlocked;
    b.classList.toggle('cda-level--locked', b.disabled);
    b.classList.toggle('cda-level--won', !!save.best[i]);
    cdaSetText(b.children[1], stats);
    b.setAttribute('aria-label', 'Level ' + (i + 1) + ', ' + CDA_LEVELS[i].name + ': ' + stats);
  }
  cdaSetText(rt.els.balance, String(cdaPatchBalance(save)));
}

function cdaShowSelect() {
  var rt = CDA_RT;
  cdaRenderSelect();
  cdaShow('select', rt.levelButtons[Math.min(rt.save.unlocked, rt.levelButtons.length) - 1]);
}

// ── briefing ──

// The carry level i would be entered with now (the chain when it is that level's).
function cdaChainCarry(i) {
  var chain = CDA_RT.chain;
  return chain && chain.level === i ? chain.carry : null;
}

function cdaOpenBriefing(i) {
  var rt = CDA_RT;
  var els = rt.els;
  var chained = cdaChainCarry(i);
  var carry = cdaLevelCarry(i, chained);
  rt.pick = i;
  cdaSetText(els.briefName, 'Level ' + (i + 1) + ': ' + CDA_LEVELS[i].name);
  cdaSetText(els.briefText, CDA_LEVELS[i].briefing);
  cdaSetText(els.briefKit, cdaKitText(carry) + (chained ? '; ' + chained.health + ' health, ' + chained.armour + ' armour' : ''));
  cdaShow('briefing', els.briefStart);
}

function cdaBriefStart() {
  var i = CDA_RT.pick;
  cdaBeginLevel(CDA_LEVELS[i], i, cdaChainCarry(i));
}

// ── death ──

function cdaShowDeath() {
  var rt = CDA_RT;
  cdaSetText(rt.els.deathText, cdaDeathLine(rt.lastBy));
  cdaSetText(rt.els.deathCount, 'Deaths so far: ' + rt.save.deaths + '.');
  cdaShow('death', rt.els.retry);
}

// ── results ──

function cdaListItem(list, text) {
  list.appendChild(cdaMake('li', 'cda-stat', text));
}

function cdaShowResults() {
  var rt = CDA_RT;
  var els = rt.els;
  var r = rt.result;
  var rec = rt.rec;
  cdaSetText(els.resultsTitle, 'Floor cleared: ' + rt.lv.name);
  els.resultsList.textContent = '';
  cdaListItem(els.resultsList, 'Time ' + cdaFormatTime(r.time) + (rec ? ' (best ' + cdaFormatTime(rec.best.time) + ')' : ''));
  cdaListItem(els.resultsList, 'Enemies destroyed ' + r.kills + ' of ' + r.enemies);
  cdaListItem(els.resultsList, 'Secrets ' + r.secrets + ' of ' + r.secretsTotal);
  cdaListItem(els.resultsList, 'Patches earned ' + r.patches);
  els.resultsNew.textContent = '';
  if (!rec) {
    cdaListItem(els.resultsNew, 'A level outside the episode: nothing is recorded.');
  } else {
    if (rec.first) cdaListItem(els.resultsNew, 'First clear of this floor.');
    else if (rec.newTime) cdaListItem(els.resultsNew, 'New best time.');
    cdaListItem(els.resultsNew, rec.patches > 0 ? '+' + rec.patches + ' patches to spend: you have ' + cdaPatchBalance(rt.save) + '.'
      : 'No new patches: an earlier run here earned as many.');
    if (rec.unlocked) cdaListItem(els.resultsNew, 'Level ' + rec.unlocked + ' is open: ' + CDA_LEVELS[rec.unlocked - 1].name + '.');
  }
  cdaToggle(els.next, !!rec);
  var finished = !!rec && rec.finished;
  cdaSetText(els.next, finished ? 'Finish' : 'Next level');
  els.next.setAttribute('aria-label', finished ? 'The end of the episode' : 'The next level\'s briefing');
  cdaAnnounce(els.resultsTitle.textContent);
  cdaShow('results', rec ? els.next : els.resultsUpgrades);
}

function cdaNextClick() {
  var rt = CDA_RT;
  if (rt.rec.finished) cdaShowEnd();
  else cdaOpenBriefing(rt.entry.index + 1);
}

// ── upgrades ──

function cdaShowUpgrades(from) {
  CDA_RT.upgradesFrom = from;
  cdaRenderUpgrades();
  cdaShow('upgrades', cdaUpgradeFocus(''));
}

function cdaUpgradesFromSelect() {
  cdaShowUpgrades('select');
}

function cdaUpgradesFromResults() {
  cdaShowUpgrades('results');
}

// The button to focus on the upgrades screen: Buy of line `id` when it can
// still be bought, else the first that can, else Back.
function cdaUpgradeFocus(id) {
  var els = CDA_RT.els;
  var list = els.upgList.querySelectorAll('.cda-buy');
  var first = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].disabled) continue;
    if (list[i].id === 'cda-buy-' + id) return list[i];
    first = first || list[i];
  }
  return first || els.upgBack;
}

function cdaRenderUpgrades() {
  var rt = CDA_RT;
  var els = rt.els;
  els.upgList.textContent = '';
  for (var i = 0; i < CDA_UPGRADES.length; i++) {
    var u = cdaUpgradeState(rt.save, CDA_UPGRADES[i].id);
    var li = cdaMake('li', 'cda-upgrade', '');
    var text = cdaMake('span', 'cda-upgrade-text', '');
    text.appendChild(cdaMake('strong', 'cda-upgrade-name', u.name + ' · tier ' + u.tiers + ' of ' + u.top));
    text.appendChild(cdaMake('span', 'cda-upgrade-line', 'Now: ' + u.now + '.'));
    text.appendChild(cdaMake('span', 'cda-upgrade-line', u.next ? 'Next: ' + u.next + ', ' + u.cost + ' patches.' : u.why + '.'));
    if (u.next && !u.can) text.appendChild(cdaMake('span', 'cda-upgrade-why', u.why + '.'));
    li.appendChild(text);
    var b = cdaButton('cda-btn cda-btn--small cda-buy', 'cda-buy-' + u.id, 'Buy',
      u.can ? 'Buy ' + u.name + ' tier ' + (u.tiers + 1) + ' for ' + u.cost + ' patches' : u.name + ': ' + u.why);
    b.disabled = !u.can;
    b.addEventListener('click', cdaBuyClick(u.id));
    li.appendChild(b);
    els.upgList.appendChild(li);
  }
  cdaSetText(els.upgBalance, String(cdaPatchBalance(rt.save)));
}

function cdaBuyClick(id) {
  return function () {
    cdaBuy(id);
  };
}

// Buys the next tier of line id when the balance pays for it (the save is
// written); a refusal only sounds.  The screen is drawn again either way.
function cdaBuy(id) {
  if (cdaBuyUpgrade(CDA_RT.save, id)) {
    cdaSfxUi('buy');
    cdaPersist();
  } else {
    cdaSfxUi('refuse');
  }
  cdaRenderUpgrades();
  cdaFocus(cdaUpgradeFocus(id));
}

function cdaUpgradesBack() {
  var rt = CDA_RT;
  if (rt.upgradesFrom === 'results') cdaShow('results', rt.els.resultsUpgrades);
  else cdaShowSelect();
}

// ── the end of the episode ──

function cdaShowEnd() {
  var rt = CDA_RT;
  var save = rt.save;
  var els = rt.els;
  var t = { won: 0, time: 0, timed: true, kills: 0, enemies: 0, secrets: 0, secretsTotal: 0 };
  for (var i = 0; i < save.best.length; i++) {
    var b = save.best[i];
    if (!b) continue;
    t.won++;
    if (b.time === null) t.timed = false;
    else t.time += b.time;
    t.kills += b.kills;
    t.enemies += b.enemies;
    t.secrets += b.secrets;
    t.secretsTotal += b.secretsTotal;
  }
  cdaMarkEnded(save);
  cdaPersist();
  els.endList.textContent = '';
  cdaListItem(els.endList, 'Floors cleared ' + t.won + ' of ' + save.best.length);
  cdaListItem(els.endList, 'Best times added up ' + cdaFormatTime(t.timed ? t.time : null));
  cdaListItem(els.endList, 'Enemies destroyed ' + t.kills + ' of ' + t.enemies);
  cdaListItem(els.endList, 'Secrets ' + t.secrets + ' of ' + t.secretsTotal);
  cdaListItem(els.endList, 'Patches earned ' + cdaPatchesEarned(save));
  cdaListItem(els.endList, 'Deaths ' + save.deaths);
  cdaListItem(els.endList, 'Time played ' + cdaFormatTime(save.playTime));
  cdaAnnounce('Episode 1 complete. ' + CDA_UI.toBeContinued);
  cdaShow('end', els.endLevels);
}

// ── settings: mouse sensitivity and mute ──

function cdaRenderSettings() {
  var rt = CDA_RT;
  var s = rt.save.settings;
  rt.els.sens.value = String(s.sens);
  cdaSetText(rt.els.sensValue, cdaNum(s.sens));
  cdaSetText(rt.els.mute, s.mute ? 'Sound: off' : 'Sound: on');
  rt.els.mute.setAttribute('aria-pressed', String(s.mute));
}

// The slider moves: the sensitivity applies at once; it is saved when the
// slider is let go (change).
function cdaSensInput() {
  var rt = CDA_RT;
  cdaSetSens(rt.save, Number(rt.els.sens.value));
  cdaSetText(rt.els.sensValue, cdaNum(rt.save.settings.sens));
}

function cdaSensChange() {
  cdaSensInput();
  cdaPersist();
}

// M and the Sound button: mute on or off, applied and saved.
function cdaToggleMute() {
  var rt = CDA_RT;
  var on = !rt.save.settings.mute;
  cdaSetMute(rt.save, on);
  cdaSfxSetMute(on);
  cdaRenderSettings();
  cdaPersist();
  if (rt.sim && rt.screen === 'play') cdaSay(on ? CDA_UI.soundOff : CDA_UI.soundOn);
}

// Another tab changed the save: the screen showing it is drawn again.
function cdaRefreshScreen() {
  var screen = CDA_RT.screen;
  if (screen === 'title') cdaRenderTitle();
  else if (screen === 'select') cdaRenderSelect();
  else if (screen === 'upgrades') cdaRenderUpgrades();
}

CDA_API.cdaHasProgress = cdaHasProgress;
CDA_API.cdaLevelStats = cdaLevelStats;
