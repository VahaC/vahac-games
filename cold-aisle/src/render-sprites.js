// ── render-sprites: the billboards: enemies, items, decor, projectiles and effects ──
// Owns CDA_FRAMES, CDA_FRAME_PREFIX, CDA_SPRITE_MAX, CDA_SHOT_Z, CDA_HIT_Z,
// CDA_FX, CDA_SHOT_FLIP, cdaFrameIds, cdaEnemyFrame, cdaAddSprite and
// cdaDrawSprites.  Uses core, tables (CDA_DIE_TIME, CDA_ENEMY, CDA_SHOT),
// textures and
// render-walls (CDA_PROJ, CDA_HORIZON, cdaLevelAt); the view is made by
// render-view.
//
// The frame an enemy shows (the table in the header of sim-enemies):
// CDA_FRAMES[kind][state] lists the frames, CDA_FRAME_PREFIX[kind] + name is
// the sprite.  A state with two frames alternates them every CDA_ANIM_WALK
// steps of e.t (walk0 / walk1, idle0 / idle1, vent0 / vent1; the others list
// one frame twice); `die` splits cdaSteps(CDA_DIE_TIME) evenly between its
// frames; while flash > 0 (the chiller hit through its vents) the hurt
// frame shows, unless it is dead.
//
// Scale: every enemy, item, decor and projectile kind has its own drawn
// height in cells, `tall` in its table row (tables): the whole frame is
// drawn that tall, its width keeping the frame's proportion, so a crate is
// a crate and only the pillar, the ladder and the big machines come near
// the ceiling (one cell up).  Effects keep 32 sprite pixels a cell.
// Everything stands with its bottom row on the floor (a drone hovers
// because it is drawn high in its frame), except enemy projectiles
// (centred at CDA_SHOT_Z cells above the floor, chest height) and effects
// (centred at the height they were spawned at: a wall hit at eye level, a
// hit or a breaking machine at CDA_HIT_Z[kind], about the middle of the
// machine as drawn).
// A billboard is lit like the floor under it (its cell's zone, its depth);
// glowing texels keep their tier's minimum (textures).
//
// Every frame: the sprites are listed into the view's preallocated arrays
// (at most CDA_SPRITE_MAX), sorted far to near by depth (insertion sort on
// an index array), and drawn column by column, each column only where the
// sprite is nearer than the wall in view.zbuf.

var CDA_SPRITE_MAX = 1024;
var CDA_SHOT_Z = 0.42;
var CDA_SHOT_FLIP = 6;
var CDA_HIT_Z = { crawler: 0.18, drone: 0.58, turret: 0.7, loader: 0.5, chiller: 0.55 };
// Effects: their frames and life (seconds), by the index view.fxKind holds.
var CDA_FX = [
  { names: ['fx-puff0', 'fx-puff1', 'fx-puff2'], life: 0.2 },
  { names: ['fx-hit0', 'fx-hit1', 'fx-hit2'], life: 0.2 },
  { names: ['fx-boom0', 'fx-boom1', 'fx-boom2', 'fx-boom3'], life: 0.45 }
];
var CDA_FRAME_PREFIX = { crawler: 'enm-crawler-', drone: 'enm-drone-', turret: 'enm-turret-', loader: 'enm-loader-', chiller: 'boss-chiller-' };
var CDA_FRAMES = {
  crawler: { asleep: ['walk0', 'walk0'], alert: ['walk0', 'walk0'], chase: ['walk0', 'walk1'], windup: ['atk0', 'atk0'],
    attack: ['atk1', 'atk1'], hurt: ['hurt', 'hurt'], die: ['die0', 'die1'], dead: ['dead'] },
  drone: { asleep: ['walk0', 'walk0'], alert: ['walk0', 'walk0'], chase: ['walk0', 'walk1'], windup: ['atk0', 'atk0'],
    attack: ['atk1', 'atk1'], hurt: ['hurt', 'hurt'], die: ['die0', 'die1'], dead: ['dead'] },
  turret: { asleep: ['idle', 'idle'], alert: ['idle', 'idle'], chase: ['idle', 'idle'], windup: ['aim', 'aim'],
    attack: ['atk0', 'atk0'], hurt: ['hurt', 'hurt'], die: ['die0', 'die1'], dead: ['dead'] },
  loader: { asleep: ['walk0', 'walk0'], alert: ['walk0', 'walk0'], chase: ['walk0', 'walk1'], windup: ['tell', 'tell'],
    attack: ['walk0', 'walk1'], hurt: ['hurt', 'hurt'], stun: ['hurt', 'hurt'], die: ['die0', 'die1'], dead: ['dead'] },
  chiller: { asleep: ['idle0', 'idle1'], alert: ['idle0', 'idle1'], idle: ['idle0', 'idle1'], call: ['idle0', 'idle1'],
    windup: ['atk0', 'atk0'], attack: ['atk1', 'atk1'], vent: ['vent0', 'vent1'], hurt: ['hurt', 'hurt'],
    die: ['die0', 'die1', 'die2'], dead: ['dead'] }
};

// CDA_FRAMES as texture ids: { kind: { state: [ids] } }.
function cdaFrameIds(T) {
  var out = {};
  var kinds = Object.keys(CDA_FRAMES);
  for (var k = 0; k < kinds.length; k++) {
    var states = Object.keys(CDA_FRAMES[kinds[k]]);
    out[kinds[k]] = {};
    for (var s = 0; s < states.length; s++) {
      var names = CDA_FRAMES[kinds[k]][states[s]];
      var ids = [];
      for (var n = 0; n < names.length; n++) ids.push(T.id[CDA_FRAME_PREFIX[kinds[k]] + names[n]]);
      out[kinds[k]][states[s]] = ids;
    }
  }
  return out;
}

// The texture id enemy e shows (see the header).
function cdaEnemyFrame(view, e) {
  var fr = view.frames[e.kind];
  var list = fr[e.state];
  if (e.state === 'die') return list[Math.min(list.length - 1, Math.floor(e.t * list.length / view.dieSteps))];
  if (e.flash > 0 && e.state !== 'dead') return fr.hurt[0];
  return list[Math.floor(e.t / CDA_ANIM_WALK) % list.length];
}

// Lists sprite `id` standing at (x, y) with its bottom zb cells above the
// floor, k cells a texel.  Nothing behind the camera is listed.
function cdaAddSprite(view, id, x, y, zb, k) {
  var dx = x - view.cx;
  var dy = y - view.cy;
  var depth = view.dirX * dx + view.dirY * dy;
  if (depth < 0.05 || view.count >= CDA_SPRITE_MAX) return;
  var n = view.count++;
  view.sTex[n] = id;
  view.sDepth[n] = depth;
  view.sScreen[n] = CDA_W / 2 + CDA_PROJ * (view.dirX * dy - view.dirY * dx) / depth;
  view.sZ[n] = zb;
  view.sK[n] = k;
  view.sZone[n] = view.cellZone[((y | 0) & 63) * 64 + ((x | 0) & 63)];
}

// Lists every billboard of sim at interpolation alpha.
function cdaListSprites(view, sim, alpha) {
  var T = view.tex;
  var i;
  view.count = 0;
  for (i = 0; i < sim.decor.length; i++) {
    var dc = sim.decor[i];
    cdaAddSprite(view, view.decorTex[dc.kind], dc.x, dc.y, 0, view.decorK[dc.kind]);
  }
  for (i = 0; i < sim.items.length; i++) {
    var it = sim.items[i];
    if (!it.taken) cdaAddSprite(view, view.itemTex[it.kind], it.x, it.y, 0, view.itemK[it.kind]);
  }
  for (i = 0; i < sim.enemies.length; i++) {
    var e = sim.enemies[i];
    var id = cdaEnemyFrame(view, e);
    cdaAddSprite(view, id, e.px + (e.x - e.px) * alpha, e.py + (e.y - e.py) * alpha, 0, CDA_ENEMY[e.kind].tall / T.h[id]);
  }
  var flip = (sim.tick / CDA_SHOT_FLIP) & 1;
  for (i = 0; i < sim.shots.length; i++) {
    var s = sim.shots[i];
    var sid = view.shotTex[s.kind][flip];
    var tall = CDA_SHOT[s.kind].tall;
    cdaAddSprite(view, sid, s.px + (s.x - s.px) * alpha, s.py + (s.y - s.py) * alpha, CDA_SHOT_Z - tall / 2, tall / T.h[sid]);
  }
  for (i = 0; i < view.fxKind.length; i++) {
    var f = view.fxKind[i];
    if (f < 0) continue;
    var ids = view.fxIds[f];
    var fid = ids[Math.floor(view.fxAge[i] * ids.length / view.fxLife[f])];
    cdaAddSprite(view, fid, view.fxX[i], view.fxY[i], view.fxZ[i] - T.h[fid] / 64, 1 / 32);
  }
}

// Sorts the listed sprites far to near into view.order.
function cdaSortSprites(view) {
  var order = view.order;
  var depth = view.sDepth;
  for (var i = 0; i < view.count; i++) {
    var j = i;
    while (j > 0 && depth[order[j - 1]] < depth[i]) {
      order[j] = order[j - 1];
      j--;
    }
    order[j] = i;
  }
}

function cdaDrawSprite(view, n, pixels) {
  var T = view.tex;
  var atlas = T.atlas;
  var shade = T.shade;
  var zbuf = view.zbuf;
  var id = view.sTex[n];
  var depth = view.sDepth[n];
  var w = T.w[id];
  var h = T.h[id];
  var cellPx = CDA_PROJ / depth;
  var width = w * view.sK[n] * cellPx;
  var height = h * view.sK[n] * cellPx;
  var top = CDA_HORIZON + (0.5 - view.sZ[n]) * cellPx - height;
  var left = view.sScreen[n] - width / 2;
  var x0 = Math.max(0, Math.ceil(left - 0.5));
  var x1 = Math.min(CDA_W, Math.ceil(left + width - 0.5));
  var y0 = Math.max(0, Math.ceil(top - 0.5));
  var y1 = Math.min(CDA_H, Math.ceil(top + height - 0.5));
  var uStep = (w * 65536 / width) | 0;
  var vStep = (h * 65536 / height) | 0;
  var u = ((x0 + 0.5 - left) * w * 65536 / width) | 0;
  var v0 = ((y0 + 0.5 - top) * h * 65536 / height) | 0;
  var lvl = cdaLevelAt(view, view.sZone[n], depth) * 256;
  for (var x = x0; x < x1; x++, u += uStep) {
    if (depth >= zbuf[x]) continue;
    var col = T.off[id] + (u >> 16) * h;
    for (var y = y0, v = v0, o = y0 * CDA_W + x; y < y1; y++, v += vStep, o += CDA_W) {
      var t = atlas[col + (v >> 16)];
      if (t) pixels[o] = shade[lvl + t];
    }
  }
}

function cdaDrawSprites(view, sim, alpha, pixels) {
  cdaListSprites(view, sim, alpha);
  cdaSortSprites(view);
  for (var i = 0; i < view.count; i++) cdaDrawSprite(view, view.order[i], pixels);
}

CDA_API.CDA_FRAMES = CDA_FRAMES;
CDA_API.CDA_FRAME_PREFIX = CDA_FRAME_PREFIX;
CDA_API.CDA_FX = CDA_FX;
CDA_API.CDA_HIT_Z = CDA_HIT_Z;
CDA_API.CDA_SHOT_Z = CDA_SHOT_Z;
CDA_API.CDA_SPRITE_MAX = CDA_SPRITE_MAX;
CDA_API.cdaEnemyFrame = cdaEnemyFrame;
