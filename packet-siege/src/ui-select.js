// ── ui: the level select: 15 zone tiles, the ten levels of one zone, the offer to resume ──
// Owns building and refreshing the level select (pksBuildSelect,
// pksRenderSelect, pksSelectZone, pksToSelect, pksHomeZone) and the offer of
// a saved level in progress (Resume, or start it over).  Uses levels
// (PKS_ZONES, PKS_LEVELS, PKS_LEVEL_ROWS), storage, ui-text and ui-page;
// inside function bodies also ui-level (pksResumeRun) and ui-page
// (pksChooseLevel).
//
// The screen: the stars total in the head; in the body, when a level in
// progress is saved, a panel offering "Resume level N" (with the time played)
// next to starting it over; the zone picker (15 tiles: the zone's number and
// rule icon, its name on wide frames, its stars n/30 or the level that opens
// it, the one shown pressed); under it the selected zone's line (name and
// rule) and its ten level buttons (boss levels marked).  It opens on the
// zone of the furthest unlocked level, or of the level last played.  Every
// level button exists from the start (the other zones' groups are hidden),
// so the frame keeps its size and the body scrolls inside it.

// The zone tiles and the fifteen groups of ten level buttons, once.
function pksBuildSelect() {
  var rt = pksRuntime;
  for (var z = 0; z < PKS_ZONES.length; z++) {
    var zone = PKS_ZONES[z];
    var tile = pksButtonEl('pks-zone-tile', 'pks-zone-' + zone.zone);
    tile.appendChild(pksIcon(pksZoneIcon(zone.zone), 'pks-zone-icon'));
    tile.appendChild(pksMake('span', 'pks-zone-num', String(zone.zone)));
    tile.appendChild(pksMake('span', 'pks-zone-tname', zone.name));
    tile.appendChild(pksMake('span', 'pks-zone-stars'));
    tile.setAttribute('title', pksZoneLine(zone));
    tile.addEventListener('click', pksZoneClick(zone.zone));
    rt.zoneTiles.push(tile);
    rt.els.zoneTiles.appendChild(tile);
    var group = pksMake('section', 'pks-zone');
    var title = pksMake('p', 'pks-zone-title');
    title.appendChild(pksMake('span', 'pks-zone-name', pksZoneLine(zone)));
    title.appendChild(document.createTextNode(' — ' + zone.desc));
    group.appendChild(title);
    var grid = pksMake('div', 'pks-level-grid');
    for (var n = z * 10 + 1; n <= z * 10 + 10; n++) {
      var b = pksButtonEl(n % 10 === 0 ? 'pks-level pks-level--boss' : 'pks-level', 'pks-level-' + n);
      b.appendChild(pksMake('span', 'pks-level-num', String(n)));
      var stars = pksMake('span', 'pks-level-stars');
      stars.appendChild(pksMake('span', 'pks-star'));
      stars.appendChild(pksMake('span', 'pks-star-off'));
      b.appendChild(stars);
      b.appendChild(pksIcon('icon-lock', 'pks-level-lock'));
      b.addEventListener('click', pksLevelClick(n));
      rt.levelButtons.push(b);
      grid.appendChild(b);
    }
    group.appendChild(grid);
    rt.zoneGroups.push(group);
    rt.els.zones.appendChild(group);
  }
}

function pksLevelClick(n) {
  return function () {
    pksChooseLevel(n);
  };
}

function pksZoneClick(zone) {
  return function () {
    pksSelectZone(zone);
  };
}

// The zone of the furthest level open.
function pksHomeZone() {
  return Math.ceil(pksRuntime.state.unlocked / 10);
}

// Shows zone `zone`'s levels.
function pksSelectZone(zone) {
  pksRuntime.zone = zone;
  pksRenderSelect();
}

// Stars, locks, the zone picker, the shown group, the total and the offer to
// resume, from the save and the snapshot.
function pksRenderSelect() {
  var rt = pksRuntime;
  var total = 0;
  var zoneStars = 0;
  for (var n = 1; n <= PKS_LEVELS; n++) {
    var b = rt.levelButtons[n - 1];
    var stars = rt.state.stars[n - 1];
    var open = n <= rt.state.unlocked;
    var glyphs = pksStarGlyphs(stars);
    total += stars;
    zoneStars += stars;
    b.disabled = !open;
    b.classList.toggle('pks-level--locked', !open);
    b.setAttribute('aria-label', pksLevelLabel({ n: n, name: PKS_LEVEL_ROWS[n - 1][0] }, stars, open));
    pksSetText(b.children[1].children[0], glyphs[0]);
    pksSetText(b.children[1].children[1], glyphs[1]);
    if (n % 10 === 0) {
      pksRenderZoneTile(n / 10, zoneStars);
      zoneStars = 0;
    }
  }
  pksSetText(rt.els.total, total + ' of ' + PKS_LEVELS * 3);
  pksRenderRun();
}

function pksRenderZoneTile(zone, stars) {
  var rt = pksRuntime;
  var z = PKS_ZONES[zone - 1];
  var tile = rt.zoneTiles[zone - 1];
  var open = zone * 10 - 9 <= rt.state.unlocked;
  tile.classList.toggle('pks-zone-tile--locked', !open);
  tile.setAttribute('aria-pressed', String(zone === rt.zone));
  tile.setAttribute('aria-label', pksZoneTileLabel(z, stars, open));
  pksSetText(tile.children[3], pksZoneTileText(z, stars, open));
  pksToggle(rt.zoneGroups[zone - 1], zone === rt.zone);
}

// The offer to resume the saved level in progress, when there is one.
function pksRenderRun() {
  var rt = pksRuntime;
  var run = rt.run;
  pksToggle(rt.els.run, !!run);
  if (!run) return;
  pksSetText(rt.els.runText, pksRunLine(run));
  pksSetText(rt.els.runResume, 'Resume level ' + run.n);
  pksSetText(rt.els.runFresh, 'Start level ' + run.n + ' over');
  // the accessible names start with the visible text and name the level too
  rt.els.runResume.setAttribute('aria-label', 'Resume level ' + run.n + ' where it was');
  rt.els.runFresh.setAttribute('aria-label', 'Start level ' + run.n + ' over from its beginning');
}

// Resume: the saved level goes on where it was.
function pksRunResume() {
  pksResumeRun(pksRuntime.run);
}

// Start over: the saved level's own start (the loadout first when it asks).
function pksRunFresh() {
  pksChooseLevel(pksRuntime.run.n);
}

// The level select, on the zone of the level last played (the home zone
// when none was), the focus on Resume when a level in progress is offered,
// else on the level last played (the Codex button when none was), scrolled
// to it inside the frame.
function pksToSelect() {
  var rt = pksRuntime;
  pksLoadRun();
  rt.zone = rt.level ? Math.ceil(rt.level / 10) : pksHomeZone();
  pksRenderSelect();
  pksShow('select');
  var target = rt.run ? rt.els.runResume : rt.level ? rt.levelButtons[rt.level - 1] : rt.els.codexOpen;
  var body = rt.els.selectBody;
  var y = target.offsetTop - body.clientHeight / 2;
  body.scrollTop = y > 0 ? y : 0;
  pksFocus(target);
}
