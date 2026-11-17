// ── sprites: the palette, the sprite table and the atlas builder ──
// Owns PKS_PALETTE, PKS_SPRITES (joined from the art parts sprites-support,
// sprites-shooters, sprites-early, sprites-late, sprites-floor, sprites-fx and
// the expansion's sprites-150-def, -150-enm-a, -150-enm-b, -150-boss,
// -150-floor-a, -150-floor-b, -150-fx), pksBuildAtlas, pksBossBody and
// pksHueShift.  Uses those art parts, packed by build.js, through
// pksUnpackArt (unpack-art), and of the sim only the boss tier rows
// (enemies: PKS_BOSS_TIERS, their body and hue) for the tinted boss copies.
// The palette holds at most 48 colours: the 32
// of levels 1-50, then the expansion's 15.
//
// Every sprite is { w, h, rows }: one character per pixel, '.' transparent, any other
// character a key of PKS_PALETTE. Units are 24x24 (the Kernel Panic 32x32, the boss
// bodies 48x48) and stand on the bottom row minus one; defenders face right, enemies
// face left.
//
// Sizes and anchors the renderer relies on:
//   def-*, enm-*, icon-decom   24x24, drawn at cell (x+4, y+6) so the feet sit 2 px above the cell bottom
//   boss-*, boss2-*, boss3-*  48x48, drawn at (cx-24, y-16) over its lane (cx: the unit's centre x)
//   enm-titan-*               32x32, drawn at (cx-16, y-2): its feet on a 24x24 unit's feet line
//   enm-replica2-*, -replica3-*  24x24 like any enemy (the Replicator's generations 2 and 3)
//   tile-*, fog, cursor*      32x32, one floor cell; fog is an opaque haze drawn over each fogged cell
//   fog-edge                  16x32, drawn just left of the first fogged column (fades in left to right)
//   fx-boom0..3, fx-surge0..2 32x32 centred on the cell; fx-surge tiles horizontally along a lane
//   beam                      32x8, tiles horizontally from the inspector to the right edge
//   fx-freeze                 24x24 overlay on a unit; fx-hit, fx-heal, shot-*, icon-* 8x8
//   rack-ok / rack-hit        24x32 per lane at (0, 20 + lane * 32)
//   breaker-armed / -tripped  8x10 drawn on the rack at (13, 11) inside the lane's rack segment
//   backdrop-z1..15           32x20, tiled across the top strip
// The expansion's (levels 51-150):
//   tile-z6..15-a/b, tile-hot, tile-rail          32x32 opaque floor cells at (x, y)
//   tile-express, tile-tunnel, tile-cross-up/-down 32x32 overlays over the floor tile at (x, y)
//   fx-shimmer0..2            32x32 over a tunnel cell, cycled during its warning
//   fx-dark, fx-outage        32x32 per cell at (x, y), dithered (alpha 1)
//   fx-aura-amp, fx-aura-heal 48x48 centred on the unit: (cx-24, y-6)
//   fx-shield, fx-shield-break, fx-jam   24x24 over a unit, at the unit's anchor
//   fx-shield-boss            48x48 over a boss, at the boss's anchor
//   fx-splash0..2, fx-pull, fx-knock, fx-restore, fx-wipe, fx-blink   32x32 centred on the
//                             cell or the unit: (cx-16, y)
//   fx-arc0/1                 32x32, its bolt from (16, 0) to (16, 31): at (cx-16, y+17) it joins
//                             the centre of lane y to the centre of the lane below
//   shot-heavy 12x8, shot-shell, shot-decrypt, icon-upkeep 8x8   centred on the flight point
//
// pksBuildAtlas(makeCanvas) rasterises every sprite once and returns
//   { canvas, frames: { name: { x, y, w, h } }, flash: { ... }, slow: { ... },
//     tints: { hue: { name: { x, y, w, h } } } }
// frames holds every sprite in its palette colours; flash (all opaque pixels white) and
// slow (a blue-tinted copy) hold only unit sprites (def-*, enm-*, boss-*, boss2-*,
// boss3-*); tints holds, for every boss tier row with a hue (degrees, not 0), the four
// frames of its body (body 1, 2 or 3: boss-, boss2-, boss3-; any other body 1) with
// every saturated palette colour turned by that hue (pksHueShift; greys stay), made
// here once so no frame ever does pixel work. All of them point into the one canvas,
// PKS_ATLAS_W (1024) wide and as tall as the next power of two that holds the
// shelves. Draw with
//   var f = atlas.frames[name];          // or atlas.flash[name] / atlas.slow[name]
//   ctx.drawImage(atlas.canvas, f.x, f.y, f.w, f.h, dx, dy, f.w, f.h);
// makeCanvas(w, h) must return an object with getContext('2d') supporting fillStyle and fillRect.

var PKS_PALETTE = {
  k: '#05080f',
  K: '#0d1424',
  a: '#141c2e',
  A: '#1f2a40',
  l: '#34466b',
  N: '#5b6b85',
  n: '#9aa8bd',
  w: '#eef3fa',
  c: '#22d3ee',
  C: '#0e7490',
  B: '#3b82f6',
  b: '#1e3a8a',
  G: '#4ade80',
  g: '#16a34a',
  d: '#0b5d3b',
  y: '#fbbf24',
  Y: '#b45309',
  o: '#f97316',
  r: '#ef4444',
  R: '#991b1b',
  P: '#a78bfa',
  p: '#6d28d9',
  m: '#f472b6',
  M: '#9d174d',
  h: '#10261f',
  H: '#1a3a2f',
  e: '#2a1a10',
  E: '#4a2c17',
  v: '#0c2532',
  V: '#17405a',
  u: '#1a1030',
  U: '#2d1b4e',
  // the expansion's 15 (levels 51-150)
  s: '#a3e635',  // lime: Keylogger shell, Signature DB bands, power-rail glow
  S: '#3f6212',  // dark lime: lime shading, power-plant floor lines
  t: '#2dd4bf',  // aqua: Hydra, Loopback arrow, heal aura, crossover arrows
  x: '#e11d48',  // crimson: Tracer scope and shot, Logic Bomb timer, Air Gap stripes, Glitch split, root zone
  f: '#e879f9',  // fuchsia: Jammer, Sinkhole swirl, tunnel portal, Glitch split
  j: '#d6a36a',  // tan: Batch Job bands and shell, Amplifier trim, coil copper, Honeynet comb, splash
  q: '#818cf8',  // periwinkle: Encrypted Payload and its shield, Token Ring, Decryptor code
  Q: '#1b1946',  // deep indigo: Backbone floor (zone 6), Payload shading
  Z: '#28241f',  // graphite: Storage array floor (zone 7)
  I: '#1f2510',  // dark olive: Power plant floor (zone 8)
  F: '#2e0e33',  // plum: VPN tunnel floor (zone 9), fuchsia shading
  X: '#2b0a12',  // wine: Root floor (zone 15), outage stripes, hot cell base
  i: '#0c2c29',  // dark teal: Cross-connect floor (zone 11)
  T: '#2e3238',  // steel grey: Mainframe raised floor (zone 13)
  J: '#2d2846'   // dusk grey: Metered cloud floor (zone 12), Honeynet frame
};

// Every sprite of the art parts, by name (the parts hold disjoint names),
// unpacked once at start-up.
var PKS_SPRITES = pksJoinArt([PKS_ART_SUPPORT, PKS_ART_SHOOTERS, PKS_ART_EARLY, PKS_ART_LATE, PKS_ART_FLOOR, PKS_ART_FX,
  PKS_ART_150_DEF, PKS_ART_150_ENM_A, PKS_ART_150_ENM_B, PKS_ART_150_BOSS, PKS_ART_150_FLOOR_A, PKS_ART_150_FLOOR_B,
  PKS_ART_150_FX]);
var PKS_ATLAS_W = 1024;
var PKS_UNIT_ART = /^(def|enm|boss\d?)-/;
var PKS_BOSS_BODIES = ['boss-', 'boss2-', 'boss3-'];
var PKS_BOSS_POSES = ['walk0', 'walk1', 'cast0', 'cast1'];
var PKS_TINT_FLOOR = 0.45;    // colours at most this saturated keep their hue

// The body prefix of a boss tier row (body 1 when it has none or another).
function pksBossBody(row) {
  return PKS_BOSS_BODIES[(row && row.body) - 1] || PKS_BOSS_BODIES[0];
}

// #rrggbb with its hue turned by `deg` degrees; greys and dull colours stay.
function pksHueShift(hex, deg) {
  var rgb = [1, 3, 5].map(function (i) { return parseInt(hex.substr(i, 2), 16) / 255; });
  var max = Math.max(rgb[0], rgb[1], rgb[2]);
  var min = Math.min(rgb[0], rgb[1], rgb[2]);
  var l = (max + min) / 2;
  var d = max - min;
  var s = d / (1 - Math.abs(2 * l - 1));
  if (!(s > PKS_TINT_FLOOR)) return hex;
  var h = max === rgb[0] ? (rgb[1] - rgb[2]) / d + 6 : max === rgb[1] ? (rgb[2] - rgb[0]) / d + 2 : (rgb[0] - rgb[1]) / d + 4;
  h = (h * 60 + deg) % 360;
  var c = (1 - Math.abs(2 * l - 1)) * s;
  var x = c * (1 - Math.abs(h / 60 % 2 - 1));
  var k = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60)];
  var out = '#';
  for (var i = 0; i < 3; i++) out += ('0' + Math.round((k[i] + l - c / 2) * 255).toString(16)).slice(-2);
  return out;
}

// The tinted jobs: every (hue, body frame) the boss tiers ask for, once, each
// with the palette turned by its hue.
function pksTintJobs(atlas, jobs) {
  var maps = {};
  var seen = {};
  var keys = Object.keys(PKS_PALETTE);
  for (var t = 0; t < PKS_BOSS_TIERS.length; t++) {
    var hue = PKS_BOSS_TIERS[t].hue;
    if (!hue) continue;
    if (!maps[hue]) {
      maps[hue] = {};
      atlas.tints[hue] = {};
      for (var k = 0; k < keys.length; k++) maps[hue][keys[k]] = pksHueShift(PKS_PALETTE[keys[k]], hue);
    }
    var prefix = pksBossBody(PKS_BOSS_TIERS[t]);
    for (var p = 0; p < PKS_BOSS_POSES.length; p++) {
      var name = prefix + PKS_BOSS_POSES[p];
      seen[hue + name] = seen[hue + name] || jobs[jobs.push({ into: atlas.tints[hue], map: maps[hue], name: name }) - 1];
    }
  }
}

function pksJoinArt(parts) {
  var all = {};
  for (var i = 0; i < parts.length; i++) {
    var art = pksUnpackArt(parts[i]);
    var names = Object.keys(art);
    for (var j = 0; j < names.length; j++) all[names[j]] = art[names[j]];
  }
  return all;
}

// Rasterises every sprite into one canvas (shelf packing, PKS_ATLAS_W wide, 1 px gaps,
// the height rounded up to a power of two) and returns { canvas, frames, flash, slow };
// see the header comment for how to draw.
function pksBuildAtlas(makeCanvas) {
  var WIDTH = PKS_ATLAS_W;
  var names = Object.keys(PKS_SPRITES);
  var keys = Object.keys(PKS_PALETTE);
  var flash = {};
  var slow = {};
  var atlas = { canvas: null, frames: {}, flash: {}, slow: {}, tints: {} };
  var jobs = [];
  var i, j, c;
  for (i = 0; i < keys.length; i++) {
    var hex = PKS_PALETTE[keys[i]];
    var lum = parseInt(hex.substr(1, 2), 16) * 0.3 + parseInt(hex.substr(3, 2), 16) * 0.59 +
      parseInt(hex.substr(5, 2), 16) * 0.11;
    flash[keys[i]] = '#ffffff';
    slow[keys[i]] = 'rgb(' + Math.round(20 + lum * 0.45) + ',' + Math.round(50 + lum * 0.65) + ',' +
      Math.min(255, Math.round(110 + lum * 0.6)) + ')';
  }
  for (i = 0; i < names.length; i++) jobs.push({ into: atlas.frames, map: PKS_PALETTE, name: names[i] });
  for (i = 0; i < names.length; i++) {
    if (PKS_UNIT_ART.test(names[i])) {
      jobs.push({ into: atlas.flash, map: flash, name: names[i] });
      jobs.push({ into: atlas.slow, map: slow, name: names[i] });
    }
  }
  pksTintJobs(atlas, jobs);
  var x = 0, y = 0, rowH = 0;
  for (i = 0; i < jobs.length; i++) {
    var sp = PKS_SPRITES[jobs[i].name];
    if (x + sp.w > WIDTH) {
      x = 0;
      y += rowH + 1;
      rowH = 0;
    }
    jobs[i].into[jobs[i].name] = { x: x, y: y, w: sp.w, h: sp.h };
    x += sp.w + 1;
    rowH = Math.max(rowH, sp.h);
  }
  var height = 1;
  while (height < y + rowH) height *= 2;
  atlas.canvas = makeCanvas(WIDTH, height);
  var ctx = atlas.canvas.getContext('2d');
  for (i = 0; i < jobs.length; i++) {
    var rows = PKS_SPRITES[jobs[i].name].rows;
    var map = jobs[i].map;
    var at = jobs[i].into[jobs[i].name];
    for (j = 0; j < rows.length; j++) {
      var row = rows[j];
      var start = 0;
      for (c = 1; c <= row.length; c++) {
        if (c === row.length || row.charAt(c) !== row.charAt(start)) {
          if (row.charAt(start) !== '.') {
            ctx.fillStyle = map[row.charAt(start)];
            ctx.fillRect(at.x + start, at.y + j, c - start, 1);
          }
          start = c;
        }
      }
    }
  }
  return atlas;
}
