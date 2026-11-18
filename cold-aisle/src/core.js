// ── core: shared constants, the fixed step, the RNG, small helpers and CDA_API ──
// Owns CDA_API (every part registers what tests and later parts need on it),
// the screen and step constants, the engine constants that are not balance
// (balance lives in tables), mulberry32 and a few helpers.  Uses no earlier
// part.
//
// Units: positions are in cells (x to the right, y down the rows of the
// map); angles are radians, 0 facing +x (east), PI / 2 facing +y (south), so
// a direction is (cos a, sin a).  Every timer in the sim counts steps
// (CDA_RATE a second); table values are in seconds and converted with
// cdaSteps().

var CDA_API = {};

var CDA_W = 320;              // framebuffer, pixels
var CDA_H = 180;
var CDA_RATE = 120;           // steps a second
var CDA_STEP = 1 / CDA_RATE;  // seconds a step
var CDA_MAX_FRAME = 0.25;     // most seconds a frame may catch up
var CDA_MAX_SIZE = 64;        // most cells a level is wide or high
var CDA_FOV = 80 * Math.PI / 180;   // horizontal field of view: the sim marks seen cells with it
var CDA_DOOR_PASS = 0.85;     // a door lets bodies through (and stops nothing) from this openness on
var CDA_SHOT_RADIUS = 0.1;    // an enemy projectile's radius, cells
var CDA_SEEN_EVERY = 4;       // steps between two automap sweeps
var CDA_SEEN_RAYS = 40;       // rays of one sweep, spread over CDA_FOV
var CDA_SEEN_RANGE = 24;      // cells a sweep reaches
var CDA_ANIM_WALK = 18;       // steps an enemy shows each walk frame (walk0, walk1, walk0 ...)

// Seconds to whole steps.
function cdaSteps(seconds) {
  return Math.round(seconds * CDA_RATE);
}

// mulberry32 on a holder ({ rng: <int32> }), so the state of a sim's
// generator lives in the sim itself and a snapshot of the sim restores it.
function cdaRand(holder) {
  holder.rng = (holder.rng + 0x6D2B79F5) | 0;
  var x = holder.rng;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

// A table (an array of rows with an id) as a map id -> row.
function cdaIndex(rows) {
  var map = {};
  for (var i = 0; i < rows.length; i++) map[rows[i].id] = rows[i];
  return map;
}

function cdaDist(ax, ay, bx, by) {
  var dx = bx - ax;
  var dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

// The angle from (ax, ay) toward (bx, by).
function cdaAngleTo(ax, ay, bx, by) {
  return Math.atan2(by - ay, bx - ax);
}

// a - b wrapped into -PI..PI: how far to turn from b to face a.
function cdaAngleDiff(a, b) {
  var d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

CDA_API.CDA_W = CDA_W;
CDA_API.CDA_H = CDA_H;
CDA_API.CDA_RATE = CDA_RATE;
CDA_API.CDA_STEP = CDA_STEP;
CDA_API.CDA_MAX_FRAME = CDA_MAX_FRAME;
CDA_API.CDA_MAX_SIZE = CDA_MAX_SIZE;
CDA_API.CDA_FOV = CDA_FOV;
CDA_API.CDA_DOOR_PASS = CDA_DOOR_PASS;
CDA_API.CDA_SHOT_RADIUS = CDA_SHOT_RADIUS;
CDA_API.CDA_ANIM_WALK = CDA_ANIM_WALK;
CDA_API.cdaSteps = cdaSteps;
CDA_API.cdaRand = cdaRand;
CDA_API.cdaIndex = cdaIndex;
CDA_API.cdaDist = cdaDist;
CDA_API.cdaAngleTo = cdaAngleTo;
CDA_API.cdaAngleDiff = cdaAngleDiff;
