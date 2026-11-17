// ── render-rules: render, 4 of 4 parts: the zone rules of levels 51-150 on the field ──
// Owns drawing every zone rule from the level's rules and the sim's rule
// clocks (pksDrawRuleTiles, pksDrawShimmers, pksDrawOutage, pksDrawDark),
// the boss tier's tinted frames (pksBossSet) and the light map of a blackout
// (pksLightMap).  pksRender (render) calls them in its draw order.  Uses
// core, defenders (PKS_DEF), zones (PKS_SHIMMER), enemies (PKS_BOSS_TIERS),
// the primitives of render and the atlas.  Never changes the sim; a level
// without rules (1-50) draws nothing here.
//
// What each rule looks like (anchors: the cell's top-left, x y):
//   express    tile-express over every cell of an express lane (chevrons
//              pointing to the rack: enemies run faster here)
//   hot, rails tile-hot / tile-rail instead of the floor tile of the cell
//   tunnels    tile-tunnel over the exit cell; while a shimmer counts down
//              there, fx-shimmer0..2 over it, one frame per third of
//              PKS_SHIMMER (drawn over the units: something is coming out)
//   cross      tile-cross-up or tile-cross-down over the cell (up when `to`
//              is the lane above)
//   outage     the lane going down: fx-outage over its nine cells blinking
//              (half alpha, on 8 steps, off 8) during the warning; down: over
//              them at full alpha.  Drawn over the lane's defenders and under
//              its enemies (the defenders stop; the enemies do not)
//   blackout   the reading of the sight rule (zones): in the dark a seeing
//              defender (PKS_SIGHT_KIND: lane shooters, Tracer, Batch Job,
//              Loopback, Token Ring, Decryptor) that can act (pksCanLook:
//              not offline, off or jammed) finds targets only in
//              (col + 0.5, col + 0.5 + sight] of its lane (a Scanner of its
//              lane and both neighbours).  The light shows exactly that, to
//              the half cell: in each lane the half cells from the rack to the
//              centre of its first seeing defender (behind the guns) and every
//              seeing defender's sight are lit; every other half cell of the
//              floor gets fx-dark (a full cell, or its 16 px half), over the
//              units and under shots and effects, so an enemy out of sight
//              shows only as a dotted shape and a lane with no seeing defender
//              is dark from the rack.  During the warning the cells that will
//              go dark blink at PKS_DARK_WARN alpha.
//   upkeep     no tile: a crimson "-N" pip (a white "0" when unpaid) with icon-upkeep at the rack of
//              lane 1 when it is charged (render-fx), and the HUD's badge
//   fog        level.fog columns (5 in the quantum lab), drawn by render
// Boss tiers: a tier row with a hue draws its walk and cast frames from
// atlas.tints[hue] (made once by pksBuildAtlas); white and blue stay as they
// are.

var PKS_SIGHT_KIND = { shooter: true, sniper: true, mortar: true, knock: true, arc: true, decrypt: true };
var PKS_HALVES = 2 * PKS_COLS;          // half cells in a lane
var PKS_LIT = [];                       // the light map: lane * PKS_HALVES + half (scratch)
var PKS_FIRST = [0, 0, 0, 0, 0];        // the first seeing defender's half per lane (scratch)
var PKS_DARK_WARN = 0.4;                // the warning's alpha
var PKS_OUTAGE_WARN = 0.5;
var PKS_SHIMMER_STEPS = pksSteps(PKS_SHIMMER);
var PKS_SHIMMER_ART = ['fx-shimmer0', 'fx-shimmer1', 'fx-shimmer2'];

// The rule tiles of the level, over its floor tiles.
function pksDrawRuleTiles(ctx, atlas, sim) {
  var R = sim.level.rules;
  if (!R) return;
  var F = atlas.frames;
  var i, c;
  for (i = 0; i < R.hot.length; i++) pksBlit(ctx, atlas, F, 'tile-hot', pksUnitX(R.hot[i].col), pksLaneY(R.hot[i].lane));
  for (i = 0; i < R.rails.length; i++) pksBlit(ctx, atlas, F, 'tile-rail', pksUnitX(R.rails[i].col), pksLaneY(R.rails[i].lane));
  for (i = 0; i < R.express.length; i++) {
    for (c = 0; c < PKS_COLS; c++) pksBlit(ctx, atlas, F, 'tile-express', pksUnitX(c), pksLaneY(R.express[i]));
  }
  for (i = 0; i < R.tunnels.length; i++) pksBlit(ctx, atlas, F, 'tile-tunnel', pksUnitX(R.tunnels[i].col), pksLaneY(R.tunnels[i].lane));
  for (i = 0; i < R.cross.length; i++) {
    var x = R.cross[i];
    pksBlit(ctx, atlas, F, x.to < x.lane ? 'tile-cross-up' : 'tile-cross-down', pksUnitX(x.col), pksLaneY(x.lane));
  }
}

// The tunnel exits about to release an enemy.
function pksDrawShimmers(ctx, atlas, sim) {
  for (var i = 0; i < sim.shimmers.length; i++) {
    var sh = sim.shimmers[i];
    var frame = Math.min(2, Math.max(0, Math.floor((PKS_SHIMMER_STEPS - sh.t) * 3 / PKS_SHIMMER_STEPS)));
    pksBlit(ctx, atlas, atlas.frames, PKS_SHIMMER_ART[frame], pksUnitX(sh.col), pksLaneY(sh.lane));
  }
}

// The lane of an outage being warned of or down, or -1.
function pksOutageLane(sim) {
  return sim.outage && sim.outage.state !== 'clear' ? sim.outage.lane : -1;
}

// fx-outage over the lane: blinking while warned, full while down.
function pksDrawOutage(ctx, atlas, sim, lane) {
  if (sim.outage.state === 'warn') {
    if (Math.floor(sim.tick / 8) % 2 === 1) return;
    ctx.globalAlpha = PKS_OUTAGE_WARN;
  }
  for (var c = 0; c < PKS_COLS; c++) pksBlit(ctx, atlas, atlas.frames, 'fx-outage', pksUnitX(c), pksLaneY(lane));
  ctx.globalAlpha = 1;
}

// Whether a seeing defender looks for targets at all, as the sim lets it
// (defenders, defenders-late): not in a lane that is offline, not while a
// Ransomware has it off, not while jammed (the sim jams only the shooter
// kinds: a Loopback near a Jammer still throws, and stays lit).  One that
// cannot act lights nothing.
function pksCanLook(sim, d) {
  if (d.off > 0 || d.jammed) return false;
  return !(pksOutageLane(sim) === d.lane && sim.outage.state === 'down');
}

// Fills PKS_LIT for a sight of `sight` cells (see the header).
function pksLightMap(sim, sight) {
  var reach = Math.round(2 * sight);
  var i, l, h;
  for (i = 0; i < PKS_LANES * PKS_HALVES; i++) PKS_LIT[i] = false;
  for (l = 0; l < PKS_LANES; l++) PKS_FIRST[l] = -1;
  for (i = 0; i < sim.defenders.length; i++) {
    var d = sim.defenders[i];
    var def = PKS_DEF[d.type];
    if (d.hp <= 0 || !PKS_SIGHT_KIND[def.kind] || !pksCanLook(sim, d)) continue;
    var spread = def.spread || 0;
    var from = 2 * d.col + 1;
    for (l = Math.max(0, d.lane - spread); l <= Math.min(PKS_LANES - 1, d.lane + spread); l++) {
      if (PKS_FIRST[l] < 0 || from < PKS_FIRST[l]) PKS_FIRST[l] = from;
      for (h = from; h < Math.min(PKS_HALVES, from + reach); h++) PKS_LIT[l * PKS_HALVES + h] = true;
    }
  }
  for (l = 0; l < PKS_LANES; l++) {
    for (h = 0; h < PKS_FIRST[l]; h++) PKS_LIT[l * PKS_HALVES + h] = true;
  }
}

// The blackout: its warning (blinking) or its darkness, over the units.
function pksDrawDark(ctx, atlas, sim) {
  var b = sim.blackout;
  if (!b || b.state === 'clear') return;
  if (b.state === 'warn') {
    if (Math.floor(sim.tick / 8) % 2 === 1) return;
    ctx.globalAlpha = PKS_DARK_WARN;
  }
  pksLightMap(sim, sim.level.rules.blackout.sight);
  var f = atlas.frames['fx-dark'];
  for (var l = 0; l < PKS_LANES; l++) {
    for (var c = 0; c < PKS_COLS; c++) {
      var left = !PKS_LIT[l * PKS_HALVES + 2 * c];
      var right = !PKS_LIT[l * PKS_HALVES + 2 * c + 1];
      var x = pksUnitX(c);
      var w = left && right ? PKS_CELL : PKS_CELL / 2;
      if (!left && right) x += PKS_CELL / 2;
      if (left || right) ctx.drawImage(atlas.canvas, f.x, f.y, w, f.h, x, pksLaneY(l), w, f.h);
    }
  }
  ctx.globalAlpha = 1;
}

// The atlas set a boss of `tier` is drawn from in its own colours: its
// tier's tinted copy when the row has a hue the atlas holds, else frames.
function pksBossSet(atlas, tier, name) {
  var row = PKS_BOSS_TIERS[tier - 1];
  var tint = row && row.hue ? atlas.tints[row.hue] : null;
  return tint && tint[name] ? tint : atlas.frames;
}
