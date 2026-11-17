// ── core: the field, the step, timing constants, small helpers, the RNG ──
// Owns the numbers every other part shares: the canvas and field geometry,
// the fixed step, the economy constants, and mulberry32.  Uses no earlier
// part.
//
// Units: positions are in cells (lane 0..4 from the top, x from 0 at the rack
// edge to 9 at the right edge of the floor); every timer in the sim counts
// steps (60 a second); table values are in seconds and converted with
// pksSteps().

var PKS_W = 320;              // canvas, logical pixels
var PKS_H = 180;
var PKS_FIELD_X = 24;         // left edge of the floor (the rack is 0..24)
var PKS_FIELD_Y = 20;         // top edge of the floor (the strip above it)
var PKS_CELL = 32;            // one cell, pixels
var PKS_COLS = 9;
var PKS_LANES = 5;
var PKS_RATE = 60;            // steps a second
var PKS_STEP = 1 / PKS_RATE;  // seconds a step
var PKS_MAX_FRAME = 0.25;     // most seconds a frame may catch up
var PKS_SPAWN_X = 9.6;        // where enemies appear (just right of the floor)
var PKS_FLOOR_END = 9;        // enemies right of this are not on the floor yet
var PKS_SHOT_SPEED = 6;       // cells a second
var PKS_SHOT_END = 10;        // a shot past this x is gone
var PKS_BODY = 0.3;           // half the width of an enemy, cells
var PKS_REACH = 0.7;          // an enemy bites a defender whose centre is this close
var PKS_START_CYCLES = 100;
var PKS_TRICKLE = 25;         // passive cycles ...
var PKS_TRICKLE_EVERY = 10;   // ... every this many seconds
var PKS_SURGE_WARN = 3;       // seconds a surge is announced ahead
var PKS_FLASH = 8;            // steps of the white hit flash
var PKS_FIRE_ANIM = 15;       // steps a shooter shows its firing frame
var PKS_BOSS_CAP = 300;       // most damage one instant effect does to the boss
var PKS_BOSS_FREEZE = 1;      // seconds a freeze holds the boss
var PKS_BOSS_PUSH = 4;        // where a breaker throws the boss back to
var PKS_BOSS_BREAKER = 0.2;   // share of its HP a breaker takes from the boss

// Seconds to whole steps.
function pksSteps(seconds) {
  return Math.round(seconds * PKS_RATE);
}

// mulberry32 on a holder ({ rng: <int32> }), so the state of a sim's
// generator lives in the sim itself and a snapshot of the sim restores it.
function pksRand(holder) {
  holder.rng = (holder.rng + 0x6D2B79F5) | 0;
  var x = holder.rng;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

// A whole number in 0..n-1.
function pksRandInt(holder, n) {
  return Math.floor(pksRand(holder) * n);
}

// A table (an array of rows with an id) as a map id -> row.
function pksIndex(rows) {
  var map = {};
  for (var i = 0; i < rows.length; i++) map[rows[i].id] = rows[i];
  return map;
}

// Round to one decimal (spawn times, displayed seconds).
function pksTenth(value) {
  return Math.round(value * 10) / 10;
}
