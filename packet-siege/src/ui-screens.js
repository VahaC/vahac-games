// ── ui: the screens around a level: loadout, result, codex ──
// Owns building and refreshing those three screens and their buttons'
// actions (the level select is ui-select).  Uses levels (PKS_ZONES,
// pksLevel, pksSlots), storage (pksLoadoutFor, pksHighestWon,
// pksOwnedDefenders), render (pksIconName), ui-text and ui-page; inside
// function bodies also ui-level (pksStartLevel).

// ── loadout ──

// The loadout screen for pksLoadoutFor's result: every owned defender as a
// toggle, grouped by what it does (PKS_ROLES), the last loadout picked.
function pksOpenLoadout(lo) {
  var rt = pksRuntime;
  var lv = pksLevel(rt.level);
  rt.loadout = lo;
  rt.picks = {};
  pksSetText(rt.els.loadoutTitle, 'Level ' + lv.n + ', ' + lv.name + ': pick ' + lo.slots + ' defenders');
  rt.els.loadoutList.textContent = '';
  for (var g = 0; g < PKS_ROLES.length; g++) {
    var list = null;
    for (var i = 0; i < lo.owned.length; i++) {
      var d = PKS_DEF[lo.owned[i]];
      if (PKS_ROLES[g][1].indexOf(d.kind) === -1) continue;
      if (!list) {
        rt.els.loadoutList.appendChild(pksMake('h3', 'pks-loadout-head', PKS_ROLES[g][0]));
        list = rt.els.loadoutList.appendChild(pksMake('div', 'pks-loadout-list'));
      }
      var b = pksButtonEl('pks-pick', 'pks-pick-' + d.id);
      b.appendChild(pksIcon(pksIconName(d.id), 'pks-card-icon'));
      var text = pksMake('span', 'pks-pick-text');
      text.appendChild(pksMake('span', 'pks-pick-name', d.name + ' · ' + d.cost));
      text.appendChild(pksMake('span', 'pks-pick-desc', d.desc));
      b.appendChild(text);
      b.addEventListener('click', pksPickClick(d.id));
      rt.picks[d.id] = b;
      list.appendChild(b);
    }
  }
  pksRenderLoadout(null);
  pksShow('loadout');
  pksFocus(rt.els.loadoutStart);
}

function pksPickClick(id) {
  return function () {
    pksTogglePick(id);
  };
}

// Picks or drops a defender; a full loadout says so instead of growing.
function pksTogglePick(id) {
  var lo = pksRuntime.loadout;
  var at = lo.pick.indexOf(id);
  var note = null;
  if (at !== -1) lo.pick.splice(at, 1);
  else if (lo.pick.length < lo.slots) lo.pick.push(id);
  else note = 'All ' + lo.slots + ' slots are taken: drop one first.';
  pksRenderLoadout(note);
}

function pksRenderLoadout(note) {
  var rt = pksRuntime;
  var lo = rt.loadout;
  for (var i = 0; i < lo.owned.length; i++) {
    rt.picks[lo.owned[i]].setAttribute('aria-pressed', String(lo.pick.indexOf(lo.owned[i]) !== -1));
  }
  pksSetText(rt.els.loadoutCount, note || 'Slots: ' + lo.pick.length + ' of ' + lo.slots);
  rt.els.loadoutStart.disabled = lo.pick.length !== lo.slots;
}

// Start: the picks in unlock order become the saved loadout and the cards.
function pksLoadoutStart() {
  var lo = pksRuntime.loadout;
  var cards = [];
  for (var i = 0; i < lo.owned.length; i++) {
    if (lo.pick.indexOf(lo.owned[i]) !== -1) cards.push(lo.owned[i]);
  }
  pksRuntime.state.loadout = cards;
  pksSave();
  pksStartLevel(pksRuntime.level, cards);
}

// ── result ──

// The result of the level that just ended, after its beat.
function pksShowResult() {
  var rt = pksRuntime;
  var els = rt.els;
  var res = rt.result;
  var title, text, lines;
  els.resultStars.textContent = '';
  els.resultUnlocks.textContent = '';
  if (res.win) {
    title = 'Level ' + rt.level + ' secured';
    text = pksWinText(res.rec, res.stars, res.tripped);
    lines = pksUnlockLines(res.rec);
    for (var s = 1; s <= 3; s++) {
      els.resultStars.appendChild(pksIcon(s <= res.stars ? 'icon-star' : 'icon-star-off', 'pks-result-star'));
    }
  } else {
    title = pksLossTitle(res);
    text = pksLossText(res);
    lines = [];
  }
  for (var i = 0; i < lines.length; i++) els.resultUnlocks.appendChild(pksLine(lines[i], 'pks-unlock'));
  pksSetText(els.resultTitle, title);
  pksSetText(els.resultText, text);
  pksSetText(els.replay, res.win ? 'Replay' : 'Retry');
  pksToggle(els.next, res.win && rt.level < PKS_LEVELS);
  pksAnnounce(pksResultAnnouncement(title, text, lines));
  pksShow('result');
  pksFocus(els.next.classList.contains('pks-hidden') ? els.replay : els.next);
}

// A line with its icon (or none) and its detail (or none): a result's
// unlocks, a level's news.
function pksLine(line, className) {
  var row = pksMake('p', className);
  if (line.icon) row.appendChild(pksIcon(line.icon, className + '-icon'));
  var text = pksMake('span', className + '-text', line.text);
  if (line.detail) text.appendChild(pksMake('span', className + '-detail', ' ' + line.detail));
  row.appendChild(text);
  return row;
}

// ── codex ──

// Every defender, threat, boss tier and zone: what is owned, met or open in
// full, the rest as a silhouette with the level that reveals it.  A boss
// tier is known once its level is open, a zone once its first level is.
function pksOpenCodex() {
  var rt = pksRuntime;
  var els = rt.els;
  var owned = pksOwnedDefenders(rt.state);
  var i;
  els.codexDefenders.textContent = '';
  els.codexEnemies.textContent = '';
  els.codexBosses.textContent = '';
  els.codexZones.textContent = '';
  var known;
  for (i = 0; i < PKS_DEFENDERS.length; i++) {
    var d = PKS_DEFENDERS[i];
    known = owned.indexOf(d.id) !== -1;
    els.codexDefenders.appendChild(pksEntry(pksPic(pksIconName(d.id), known), known, d.name, pksDefenderStats(d), d.desc,
      'Unlocked by winning level ' + d.unlock + '.'));
  }
  for (i = 0; i < PKS_CODEX_ENEMIES.length; i++) {
    var e = PKS_CODEX_ENEMIES[i];
    known = rt.state.met.indexOf(e.id) !== -1;
    els.codexEnemies.appendChild(pksEntry(pksPic(pksIconName(e.id), known), known, e.name, e.stats, e.desc,
      'First seen on level ' + e.first + '.'));
  }
  for (i = 0; i < PKS_CODEX_BOSSES.length; i++) {
    var b = PKS_CODEX_BOSSES[i];
    known = b.level <= rt.state.unlocked;
    els.codexBosses.appendChild(pksEntry(known ? pksBossIcon(b.tier, 'pks-entry-icon') : pksPic(pksIconName('boss'), false), known,
      b.name, b.stats, b.desc, 'Faced on level ' + b.level + '.'));
  }
  for (i = 0; i < PKS_ZONES.length; i++) {
    var z = PKS_ZONES[i];
    known = z.zone * 10 - 9 <= rt.state.unlocked;
    els.codexZones.appendChild(pksEntry(pksPic(pksZoneIcon(z.zone), known), known, pksZoneLine(z), pksZoneLevels(z),
      z.desc, 'Reached at level ' + (z.zone * 10 - 9) + '.'));
  }
  pksShow('codex');
  pksFocus(els.codexBack);
}

// The picture of a codex entry: the icon when known, else its silhouette.
function pksPic(icon, known) {
  return known ? pksIcon(icon, 'pks-entry-icon') : pksSilhouette(icon, 'pks-entry-icon');
}

function pksEntry(icon, known, name, stats, desc, reveal) {
  var row = pksMake('div', known ? 'pks-entry' : 'pks-entry pks-entry--locked');
  var pic = pksMake('span', 'pks-entry-pic');
  pic.appendChild(icon);
  row.appendChild(pic);
  var text = pksMake('span', 'pks-entry-text');
  text.appendChild(pksMake('span', 'pks-entry-name', known ? name : '?'));
  if (known) text.appendChild(pksMake('span', 'pks-entry-stats', stats));
  text.appendChild(pksMake('span', 'pks-entry-desc', known ? desc : reveal));
  row.appendChild(text);
  return row;
}
