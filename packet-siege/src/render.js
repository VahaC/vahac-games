// ── render: draws a sim on the 320x180 canvas, 1 of 3 parts: the frame, the field, the helpers ──
// Owns pksRender, the art lookup tables built once at load, the canvas
// helpers the page needs (pksCellAt, pksCellRect, pksDrawIcon, pksIconName),
// PKS_DECOM (the Decommission tool's card id) and the drawing
// primitives the other render parts share (pksBlit, pksRect, pksHpBar,
// pksDrawText).  The units are drawn by render-units, the view of passing
// effects (pksNewView, pksViewEvents, pksViewStep) and the pointer by
// render-fx.  Uses core (geometry, pksSteps), defenders (PKS_DEFENDERS,
// PKS_DEF), enemies (PKS_ENEMIES, PKS_BOSS_TIERS, PKS_SHIFT_TIME, PKS_REACH),
// enemies-late (PKS_SLIDE_TIME) and sprites (PKS_SPRITES, PKS_PALETTE, and
// the atlas pksBuildAtlas returns).
//
// pksRender only reads the sim.  Everything that is presentation only lives
// in a view the page owns, one per played level (pksNewView()):
//   cursor  { lane, col } or null: the keyboard cell cursor
//   ghost   { card, lane, col, ok } or null: the card under the pointer or
//           cursor (a defender id, or PKS_DECOM); ok false draws cursor-bad
//   fx      the passing effects (sparks, explosions, surge sweeps ...), a pool
//           of at most PKS_FX_MAX objects that are reused
//   tick    view steps so far
//   events, seen  the sim.events array last read and how much of it
// The frame loop of the page, for every sim step it runs (two per step slot
// at 2x speed):
//   pksStep(sim); pksViewStep(view); pksViewEvents(view, sim);
// and after pksPlace / pksRemove also pksViewEvents(view, sim) (they add
// events to the same array; nothing is read twice).  Then, once per frame:
//   pksRender(ctx, atlas, sim, view);
// The view only moves when the sim does, so a paused game freezes its effects.
//
// The order of a frame: the top strip; the floor (racks, tiles of the level's
// zone, trays, the zone rules' tiles, fog, closed lanes, the margin); the
// auras of Amplifiers and Hydras, faint, under every unit; lane by lane its
// defenders, an outage over them, then its big enemies (the 32x32 Kernel
// Panic), then the other enemies; the arming bars of traps; the bosses; tunnel
// shimmers; a blackout's darkness; beams; shots; Batch Job shells; effects;
// the pointer.  Fog hides enemies (and their auras) but no shot, shell or
// effect.  The zone rules are drawn by render-rules.
//
// Boss bodies: a boss tier row may carry `body` (1, 2 or 3: the art boss-*,
// boss2-*, boss3-*); without one, or with any other value, body 1.  A row
// with a `hue` is drawn from the atlas's copy tinted by it (pksBossSet).

var PKS_DECOM = 'decom';
var PKS_FX_MAX = 160;
var PKS_FLOOR_RIGHT = PKS_FIELD_X + PKS_COLS * PKS_CELL;  // 312: the 8 px margin starts here
var PKS_BAR_X = 150;          // the surge progress bar on the top strip
var PKS_BAR_Y = 7;
var PKS_BAR_W = 150;
var PKS_SHIFT_STEPS = pksSteps(PKS_SHIFT_TIME);
var PKS_SLIDE_STEPS = pksSteps(PKS_SLIDE_TIME);
var PKS_SHOT_ART = { drop: 'shot-drop', tar: 'shot-tar', phish: 'shot-phish', volley: 'shot-boss', decrypt: 'shot-decrypt' };
var PKS_BITE_STATES = { biting: true, throwing: true, casting: true };
var PKS_BOOM_ART = ['fx-boom0', 'fx-boom1', 'fx-boom2', 'fx-boom3'];
var PKS_SURGE_ART = ['fx-surge0', 'fx-surge1', 'fx-surge2'];
var PKS_SPLASH_ART = ['fx-splash0', 'fx-splash1', 'fx-splash2'];
var PKS_ARC_ART = ['fx-arc0', 'fx-arc1'];
var PKS_AURA_ART = { amplifier: 'fx-aura-amp', hydra: 'fx-aura-heal' };
var PKS_DEF_ART = pksDefArt();
var PKS_ENM_ART = pksEnemyArt();
// The boss bodies by a tier row's body - 1; the Replicator by generation.
var PKS_BOSS_ART = [PKS_ENM_ART.boss, pksPoses('boss2-', 'cast'), pksPoses('boss3-', 'cast')];
var PKS_GEN_ART = [null, PKS_ENM_ART.replicator, pksPoses('enm-replica2-', 'bite'), pksPoses('enm-replica3-', 'bite')];
// Enemies whose art is taller than a cell's 24x24 unit (the Kernel Panic).
var PKS_BIG_ENEMY = pksBigEnemies();
var PKS_TILE_ART = pksZoneArt('tile-z', ['-a', '-b']);
var PKS_BACKDROP_ART = pksZoneArt('backdrop-z', ['']);
// 3x5 glyphs for the "+25" and "-3" pips, row by row.
var PKS_GLYPHS = {
  '+': '000010111010000', '-': '000000111000000', '0': '111101101101111', '1': '010110010010111',
  '2': '111001111100111', '3': '111001111001111', '4': '101101111001001', '5': '111100111001111',
  '6': '111100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001111'
};

// Per defender: [idle frame 0, idle frame 1, firing frame or null].
function pksDefArt() {
  var art = {};
  for (var i = 0; i < PKS_DEFENDERS.length; i++) {
    var id = PKS_DEFENDERS[i].id;
    var fire = 'def-' + id + '-fire';
    art[id] = ['def-' + id + '-0', 'def-' + id + '-1', pksOwn(PKS_SPRITES, fire) ? fire : null];
  }
  return art;
}

// Per enemy (and 'boss'): [walk0, walk1, bite0, bite1] (cast0/cast1 for the boss).
function pksEnemyArt() {
  var art = { boss: pksPoses('boss-', 'cast') };
  for (var i = 0; i < PKS_ENEMIES.length; i++) art[PKS_ENEMIES[i].id] = pksPoses('enm-' + PKS_ENEMIES[i].id + '-', 'bite');
  return art;
}

function pksPoses(prefix, act) {
  return [prefix + 'walk0', prefix + 'walk1', prefix + act + '0', prefix + act + '1'];
}

function pksBigEnemies() {
  var big = {};
  for (var i = 0; i < PKS_ENEMIES.length; i++) {
    if (PKS_SPRITES[PKS_ENM_ART[PKS_ENEMIES[i].id][0]].h > 24) big[PKS_ENEMIES[i].id] = true;
  }
  return big;
}

// [zone 1 names, zone 2 names, ...] for every zone the art has, each a name
// per suffix.
function pksZoneArt(prefix, suffixes) {
  var out = [];
  for (var z = 1; pksOwn(PKS_SPRITES, prefix + z + suffixes[0]); z++) {
    var names = [];
    for (var i = 0; i < suffixes.length; i++) names.push(prefix + z + suffixes[i]);
    out.push(names);
  }
  return out;
}

// A zone's names; a zone without art (none today) falls back to zone 1's.
function pksZoneNames(table, zone) {
  return table[zone - 1] || table[0];
}

// The frames of a boss tier: by the row's body (1 by default).
function pksBossArt(tier) {
  var row = PKS_BOSS_TIERS[tier - 1];
  var body = row && row.body ? row.body : 1;
  return PKS_BOSS_ART[body - 1] || PKS_BOSS_ART[0];
}

function pksOwn(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// ── geometry helpers for the page ──

// The cell under a canvas point in logical pixels (0..320, 0..180), or null
// off the floor (the rack, the strip, the right margin, outside).
function pksCellAt(px, py) {
  var col = Math.floor((px - PKS_FIELD_X) / PKS_CELL);
  var lane = Math.floor((py - PKS_FIELD_Y) / PKS_CELL);
  if (!(col >= 0 && col < PKS_COLS && lane >= 0 && lane < PKS_LANES)) return null;
  return { lane: lane, col: col };
}

// A cell's rectangle in logical pixels.
function pksCellRect(lane, col) {
  return { x: PKS_FIELD_X + col * PKS_CELL, y: PKS_FIELD_Y + lane * PKS_CELL, w: PKS_CELL, h: PKS_CELL };
}

// The sprite that stands for a card or a codex entry: a defender id, an
// enemy id, 'boss' or PKS_DECOM; null for anything else.
function pksIconName(id) {
  if (id === PKS_DECOM) return 'icon-decom';
  if (pksOwn(PKS_DEF_ART, id)) return PKS_DEF_ART[id][0];
  if (pksOwn(PKS_ENM_ART, id)) return PKS_ENM_ART[id][0];
  return null;
}

// Paints sprite `name` at (x, y) at a whole or fractional scale on any 2D
// context (card buttons, the codex).  Returns false for an unknown name.
function pksDrawIcon(ctx, atlas, name, x, y, scale) {
  if (!pksOwn(atlas.frames, name)) return false;
  var f = atlas.frames[name];
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(atlas.canvas, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), f.w * scale, f.h * scale);
  return true;
}

function pksLaneY(lane) {
  return PKS_FIELD_Y + lane * PKS_CELL;
}

function pksUnitX(x) {
  return PKS_FIELD_X + x * PKS_CELL;
}

// ── drawing primitives ──

function pksBlit(ctx, atlas, set, name, x, y) {
  var f = set[name];
  ctx.drawImage(atlas.canvas, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), f.w, f.h);
}

function pksRect(ctx, color, x, y, w, h) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

// An HP bar: a dark frame, the fill green, yellow at half, red at a quarter.
function pksHpBar(ctx, x, y, w, share) {
  pksRect(ctx, PKS_PALETTE.k, x - 1, y - 1, w + 2, 4);
  var color = PKS_PALETTE.r;
  if (share > 0.5) color = PKS_PALETTE.G;
  else if (share > 0.25) color = PKS_PALETTE.y;
  pksRect(ctx, color, x, y, Math.max(1, Math.round(w * share)), 2);
}

// A shield bar, unlike an HP bar: a dark frame, a deep indigo track the full
// width and a periwinkle fill.
function pksShieldBar(ctx, x, y, w, share) {
  pksRect(ctx, PKS_PALETTE.k, x - 1, y - 1, w + 2, 4);
  pksRect(ctx, PKS_PALETTE.Q, x, y, w, 2);
  pksRect(ctx, PKS_PALETTE.q, x, y, Math.max(1, Math.round(w * share)), 2);
}

// A small up-chevron of colour `color` with its tip at (x, y): the boost cue
// of a defender, the Amplifier's cue on an enemy.
function pksChevron(ctx, color, x, y) {
  pksRect(ctx, color, x, y, 1, 1);
  pksRect(ctx, color, x - 1, y + 1, 3, 1);
}

// Text from PKS_GLYPHS (digits, + and -), in `color` (yellow by default) on
// a 1 px dark shadow.
function pksDrawText(ctx, text, x, y, color) {
  x = Math.round(x);
  y = Math.round(y);
  for (var pass = 0; pass < 2; pass++) {
    ctx.fillStyle = pass === 0 ? PKS_PALETTE.k : color || PKS_PALETTE.y;
    for (var c = 0; c < text.length; c++) {
      var glyph = PKS_GLYPHS[text.charAt(c)];
      for (var i = 0; i < 15; i++) {
        if (glyph.charAt(i) === '1') ctx.fillRect(x + c * 4 + i % 3 + 1 - pass, y + Math.floor(i / 3) + 1 - pass, 1, 1);
      }
    }
  }
}

// ── the frame ──

// One frame of the sim on a 320x180 context.  Never changes the sim.
function pksRender(ctx, atlas, sim, view) {
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  pksDrawStrip(ctx, atlas, sim);
  pksDrawFloor(ctx, atlas, sim);
  var fogX = sim.level.fog > 0 ? PKS_COLS - sim.level.fog : PKS_SHOT_END;
  var i, e;
  pksDrawAuras(ctx, atlas, sim, fogX);
  var down = pksOutageLane(sim);
  for (var lane = 0; lane < PKS_LANES; lane++) {
    for (i = 0; i < sim.defenders.length; i++) {
      if (sim.defenders[i].lane === lane) pksDrawDefender(ctx, atlas, sim, sim.defenders[i]);
    }
    if (lane === down) pksDrawOutage(ctx, atlas, sim, lane);
    for (var big = 1; big >= 0; big--) {
      for (i = 0; i < sim.enemies.length; i++) {
        e = sim.enemies[i];
        if (e.tier === 0 && pksDrawLane(e) === lane && e.x <= fogX && (PKS_BIG_ENEMY[e.type] ? 1 : 0) === big) {
          pksDrawEnemy(ctx, atlas, sim, e);
        }
      }
    }
  }
  pksDrawArming(ctx, sim);
  for (i = 0; i < sim.enemies.length; i++) {
    if (sim.enemies[i].tier > 0 && sim.enemies[i].x <= fogX) pksDrawEnemy(ctx, atlas, sim, sim.enemies[i]);
  }
  pksDrawShimmers(ctx, atlas, sim);
  pksDrawDark(ctx, atlas, sim);
  pksDrawBeams(ctx, atlas, sim);
  pksDrawShots(ctx, atlas, sim);
  pksDrawShells(ctx, atlas, sim);
  for (i = 0; i < view.fx.length; i++) {
    if (view.fx[i].age >= 0 && view.fx[i].age < view.fx[i].life) pksDrawFx(ctx, atlas, sim, view.fx[i]);
  }
  pksDrawPointer(ctx, atlas, view);
  ctx.globalAlpha = 1;
}

// The top strip: the zone's backdrop, the surge progress bar (how far the
// level's spawns have come) with a marker per surge; while a surge is
// announced the bar turns orange and its marker blinks.
function pksDrawStrip(ctx, atlas, sim) {
  var lv = sim.level;
  var backdrop = pksZoneNames(PKS_BACKDROP_ART, lv.zone)[0];
  var x, i;
  for (x = 0; x < PKS_W; x += PKS_CELL) pksBlit(ctx, atlas, atlas.frames, backdrop, x, 0);
  var total = Math.max(1, lv.spawns.length);
  var warn = sim.warned > sim.surged;
  pksRect(ctx, PKS_PALETTE.k, PKS_BAR_X - 1, PKS_BAR_Y - 1, PKS_BAR_W + 2, 7);
  pksRect(ctx, PKS_PALETTE.A, PKS_BAR_X, PKS_BAR_Y, PKS_BAR_W, 5);
  pksRect(ctx, warn ? PKS_PALETTE.o : PKS_PALETTE.G, PKS_BAR_X, PKS_BAR_Y, Math.round(PKS_BAR_W * sim.spawnIndex / total), 5);
  var blinkOn = Math.floor(sim.tick / 8) % 2 === 0;
  var before = 0;
  for (i = 0; i < lv.surges.length; i++) {
    while (before < lv.spawns.length && lv.spawns[before].t < lv.surges[i]) before++;
    if (i < sim.surged) ctx.globalAlpha = 0.35;
    else if (i < sim.warned && !blinkOn) continue;
    pksBlit(ctx, atlas, atlas.frames, 'icon-surge', PKS_BAR_X + Math.round(PKS_BAR_W * before / total) - 4, PKS_BAR_Y - 1);
    ctx.globalAlpha = 1;
  }
}

// Racks and breakers, floor tiles in the zone's checker, trays, the rule
// tiles of zones 6-15 (render-rules), the fog, lanes not in play dimmed, the
// right margin.
function pksDrawFloor(ctx, atlas, sim) {
  var lv = sim.level;
  var tiles = pksZoneNames(PKS_TILE_ART, lv.zone);
  var lane, col, i, y;
  for (lane = 0; lane < PKS_LANES; lane++) {
    y = pksLaneY(lane);
    var state = sim.breakers[lane];
    pksBlit(ctx, atlas, atlas.frames, state === 'tripped' ? 'rack-hit' : 'rack-ok', 0, y);
    if (state !== 'off') pksBlit(ctx, atlas, atlas.frames, state === 'armed' ? 'breaker-armed' : 'breaker-tripped', 13, y + 11);
    for (col = 0; col < PKS_COLS; col++) {
      var tray = false;
      for (i = 0; i < lv.blocked.length; i++) {
        if (lv.blocked[i].lane === lane && lv.blocked[i].col === col) tray = true;
      }
      pksBlit(ctx, atlas, atlas.frames, tray ? 'tile-tray' : tiles[(col + lane) % 2], pksUnitX(col), y);
    }
  }
  pksDrawRuleTiles(ctx, atlas, sim);
  if (lv.fog > 0) {
    var first = PKS_COLS - lv.fog;
    for (lane = 0; lane < PKS_LANES; lane++) {
      y = pksLaneY(lane);
      pksBlit(ctx, atlas, atlas.frames, 'fog-edge', pksUnitX(first) - 16, y);
      for (col = first; col < PKS_COLS; col++) pksBlit(ctx, atlas, atlas.frames, 'fog', pksUnitX(col), y);
    }
  }
  ctx.globalAlpha = 0.65;
  for (lane = 0; lane < PKS_LANES; lane++) {
    if (sim.breakers[lane] === 'off') pksRect(ctx, PKS_PALETTE.k, 0, pksLaneY(lane), PKS_FLOOR_RIGHT, PKS_CELL);
  }
  ctx.globalAlpha = 1;
  pksRect(ctx, PKS_PALETTE.k, PKS_FLOOR_RIGHT, PKS_FIELD_Y, PKS_W - PKS_FLOOR_RIGHT, PKS_H - PKS_FIELD_Y);
}

// The lane a unit is drawn with: during a lane change the one it is
// nearer to, so the draw order stays right.
function pksDrawLane(e) {
  return e.shift * 2 > PKS_SHIFT_STEPS ? e.from : e.lane;
}
