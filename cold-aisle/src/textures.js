// ── textures: the art as palette-index textures, the glow tiers, the shade table and cdaSpritePixels ──
// Owns cdaTextures (the texture set, built once on first use), CDA_SHADES,
// CDA_TIER_MIN, CDA_FOG, CDA_GLOW and cdaSpritePixels.  Uses core, palette,
// unpack-art and every art part (CDA_ART_*).
//
// The texture set (cdaTextures()):
//   names [sprite names in the order of the art parts], id { name -> index },
//   w[], h[] (pixels), off[] (where a sprite starts in atlas),
//   atlas  Uint8Array: every sprite's texels one after another, column-major
//          (texel u, v of sprite i is atlas[off[i] + u * h[i] + v]), so the
//          renderer walks a wall or billboard column in order;
//   shade  Uint32Array(CDA_SHADES * 256): the colour (little-endian ABGR,
//          opaque) of texel t at light level l is shade[l * 256 + t];
//   pal    Uint32Array(64): the full-bright colour of each palette index;
//   index  { letter -> palette index }.
// A texel is 0 where transparent, else a palette index (1 + the letter's place
// in CDA_PALETTE, below 64) plus 64 * its glow tier:
//   tier 0  plain: lit by the light level it is drawn at;
//   tier 1  glows: never darker than level CDA_TIER_MIN[1] (lamps, ceiling
//           lights, screens and LEDs, enemy eyes, projectiles and effects);
//   tier 2  faint: never darker than CDA_TIER_MIN[2] (enemy bodies and the
//           infected racks, so a machine within sight range never vanishes
//           in a dark zone);
//   tier 3  dim: never darker than CDA_TIER_MIN[3] (the lift's doors, so
//           the exit reads down a long dark corridor; its frame, its red /
//           green sign and its LEDs glow in tier 1, so it also stands out
//           against lit concrete 8-12 cells away: checked in shot.js frames
//           2026-11-18).
// CDA_GLOW names the tiers per sprite-name prefix (the first match wins).
// Level 15 is the art's own colour; lower levels mix it toward CDA_FOG, a
// cold near-black, never pure black; level 0 is CDA_FOG itself.

var CDA_SHADES = 16;
var CDA_TIER_MIN = [0, 13, 4, 8];
var CDA_TIERS = CDA_TIER_MIN.length;
var CDA_FOG = [4, 6, 11];
// [prefix, letters drawn in tier 1 ('*': all), the tier of its other opaque texels]
var CDA_GLOW = [
  ['ceil-light', 'wn', 0],
  ['dc-lamp', 'wy', 0],
  ['wall-rack-infected', 'rmw', 2],
  ['wall-rack-clean', 'Gg', 0],
  ['wall-rack-', 'Gc', 0],
  ['wall-terminal', 'cGw', 0],
  ['lift-', 'rRGgnNwy', 3],
  ['door', 'Gg', 0],
  ['enm-', 'rR', 2],
  ['boss-', 'rRoyc', 2],
  ['fx-', '*', 0]
];
var CDA_TEXSET = null;

// The glow tier of letter ch in sprite name.
function cdaGlowTier(name, ch) {
  for (var g = 0; g < CDA_GLOW.length; g++) {
    if (name.indexOf(CDA_GLOW[g][0]) !== 0) continue;
    if (CDA_GLOW[g][1] === '*' || CDA_GLOW[g][1].indexOf(ch) >= 0) return 1;
    return CDA_GLOW[g][2];
  }
  return 0;
}

// A '#rrggbb' colour mixed toward CDA_FOG: share 1 is the colour, 0 the fog.
function cdaShadeColour(hex, share) {
  var c = 0xff000000;
  for (var k = 0; k < 3; k++) {
    var v = parseInt(hex.substr(1 + k * 2, 2), 16);
    c |= Math.round(CDA_FOG[k] + (v - CDA_FOG[k]) * share) << (k * 8);
  }
  return c >>> 0;
}

function cdaTextures() {
  if (CDA_TEXSET) return CDA_TEXSET;
  var parts = [CDA_ART_WALLS, CDA_ART_FLATS, CDA_ART_DECOR, CDA_ART_ITEMS, CDA_ART_ENEMIES, CDA_ART_HEAVY_A, CDA_ART_HEAVY_B,
    CDA_ART_WEAPONS, CDA_ART_FX];
  var letters = Object.keys(CDA_PALETTE);
  var index = {};
  var T = { index: index, names: [], id: {}, w: [], h: [], off: [], atlas: null, shade: new Uint32Array(CDA_SHADES * 256), pal: new Uint32Array(64) };
  var art = {};
  var total = 0;
  for (var p = 0; p < parts.length; p++) {
    var part = cdaUnpackArt(parts[p]);
    var keys = Object.keys(part);
    for (var k = 0; k < keys.length; k++) {
      art[keys[k]] = part[keys[k]];
      T.id[keys[k]] = T.names.length;
      T.names.push(keys[k]);
      T.w.push(part[keys[k]].w);
      T.h.push(part[keys[k]].h);
      T.off.push(total);
      total += part[keys[k]].w * part[keys[k]].h;
    }
  }
  for (var i = 0; i < letters.length; i++) {
    index[letters[i]] = i + 1;
    T.pal[i + 1] = cdaShadeColour(CDA_PALETTE[letters[i]], 1);
    for (var l = 0; l < CDA_SHADES; l++) {
      for (var t = 0; t < CDA_TIERS; t++) {
        var level = Math.max(l, CDA_TIER_MIN[t]);
        T.shade[l * 256 + t * 64 + i + 1] = cdaShadeColour(CDA_PALETTE[letters[i]], Math.pow(level / (CDA_SHADES - 1), 1.2));
      }
    }
  }
  T.atlas = new Uint8Array(total);
  for (var s = 0; s < T.names.length; s++) {
    var a = art[T.names[s]];
    for (var y = 0; y < a.h; y++) {
      for (var x = 0; x < a.w; x++) {
        var ch = a.rows[y].charAt(x);
        if (ch !== '.') T.atlas[T.off[s] + x * a.h + y] = index[ch] + 64 * cdaGlowTier(T.names[s], ch);
      }
    }
  }
  CDA_TEXSET = T;
  return T;
}

// Sprite `name` at full brightness for the HUD and the guide:
// { w, h, data: Uint32Array(w * h) } row-major, ABGR, 0 where transparent.
function cdaSpritePixels(name) {
  var T = cdaTextures();
  var s = T.id[name];
  var w = T.w[s];
  var h = T.h[s];
  var data = new Uint32Array(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) data[y * w + x] = T.pal[T.atlas[T.off[s] + x * h + y] & 63];
  }
  return { w: w, h: h, data: data };
}

CDA_API.CDA_SHADES = CDA_SHADES;
CDA_API.CDA_TIER_MIN = CDA_TIER_MIN;
CDA_API.CDA_TIERS = CDA_TIERS;
CDA_API.CDA_FOG = CDA_FOG;
CDA_API.CDA_GLOW = CDA_GLOW;
CDA_API.cdaTextures = cdaTextures;
CDA_API.cdaSpritePixels = cdaSpritePixels;
