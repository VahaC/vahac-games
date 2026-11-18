// ── render-view: the view state, cdaViewStep, cdaRender: camera, tool in hand, flashes, the Use bar ──
// Owns CDA_HAND, CDA_HAND_X, CDA_HAND_Y, CDA_BOB_RATE, CDA_HURT_TIME,
// CDA_PICK_TIME, CDA_BAR, cdaNewView, cdaViewStep, cdaRender and their
// helpers.  Uses core, tables (CDA_PLAYER, CDA_TOOLS, CDA_ITEMS, CDA_DECOR,
// CDA_SHOTS, CDA_DIE_TIME), map, textures, render-walls and render-sprites.
//
// cdaNewView() makes everything a frame needs (grids, depth buffer, sprite
// lists, the effect pool, light table): cdaRender allocates nothing.
// cdaViewStep(view, sim) runs once after every cdaStep: it reads sim.events
// (effects for `wall`, `hit`, `die` and a projectile's `shotEnd` on a wall;
// the damage flash on `hurt`, the pickup flash on `pickup`), ages the
// effects, follows the tool in hand (to lower the old one during a switch)
// and the weapon bob (its phase grows with the distance walked, its size
// eases in while the player moves and out when it stops).
// cdaRender(view, sim, alpha, pixels) draws one 320x180 frame, the camera
// (and enemies, projectiles, doors) interpolated between the last two steps
// (alpha 0: the step before, 1: the last one).  It only reads sim.
//
// The tool in hand: vw-<tool>-idle, or the attack frame CDA_HAND[tool] picks
// by fireT as a share of the tool's cooldown (the first entry whose limit
// the share is below), drawn bottom-centre (CDA_HAND_X, CDA_HAND_Y) plus the
// bob.  During a switch (switchT counting down from the switch time) the old
// tool goes down in the first half and the new one comes up in the second.
// It is lit like the floor at the player's feet.
// The Use bar (CDA_BAR) shows the rack reboot's progress while one runs.
// The flashes tint the whole frame: red when hurt, warm white on a pickup,
// fading over CDA_HURT_TIME / CDA_PICK_TIME.

var CDA_HAND_X = 112;
var CDA_HAND_Y = 108;
var CDA_BOB_RATE = 3.3;
var CDA_HURT_TIME = 0.25;
var CDA_PICK_TIME = 0.2;
var CDA_FX_SLOTS = 32;
var CDA_BAR = { x: 120, y: 96, w: 80, h: 5 };
var CDA_HAND = {
  driver: [['atk1', 0.3], ['atk0', 0.6]],
  probe: [['atk0', 0.3], ['atk1', 0.65]],
  degausser: [['atk1', 0.22], ['atk2', 0.5], ['idle', 0.75], ['atk0', 1]]
};

function cdaNewView() {
  var T = cdaTextures();
  var n = CDA_SPRITE_MAX;
  var view = {
    tex: T, cx: 0, cy: 0, ca: 0, dirX: 1, dirY: 0, plX: 0, plY: 1,
    camX: new Float64Array(CDA_W), rowDist: new Float64Array(CDA_H - CDA_HORIZON),
    zbuf: new Float64Array(CDA_W), wallTop: new Int16Array(CDA_W), wallBot: new Int16Array(CDA_W),
    cellKind: new Uint8Array(4096), cellTex: new Int16Array(4096), cellAlt: new Int16Array(4096), cellSplit: new Uint8Array(4096),
    cellZone: new Uint8Array(4096), cellOpen: new Float64Array(4096),
    zones: 0, zFloor: new Int32Array(16), zCeil: new Int32Array(16), zLight: new Uint8Array(16), rowLvl: new Int32Array(16),
    lightTab: new Uint8Array(4 * CDA_LIGHT_BUCKETS), flashFor: -1,
    anim: new Int16Array(T.names.length), jambId: T.id[CDA_TEX_JAMB], cleanId: T.id[CDA_TEX_RACK_CLEAN],
    wallDefault: T.id['wall-concrete'], frames: cdaFrameIds(T), dieSteps: cdaSteps(CDA_DIE_TIME),
    itemTex: {}, itemK: {}, decorTex: {}, decorK: {}, shotTex: {}, hand: {},
    count: 0, order: new Int32Array(n), sTex: new Int16Array(n), sDepth: new Float64Array(n), sScreen: new Float64Array(n),
    sZ: new Float64Array(n), sK: new Float64Array(n), sZone: new Uint8Array(n),
    fxKind: new Int8Array(CDA_FX_SLOTS), fxAge: new Int32Array(CDA_FX_SLOTS), fxX: new Float64Array(CDA_FX_SLOTS),
    fxY: new Float64Array(CDA_FX_SLOTS), fxZ: new Float64Array(CDA_FX_SLOTS), fxNext: 0, fxIds: [], fxLife: [],
    tool: 'driver', prevTool: 'driver', handDrop: 0, bobPhase: 0, bobAmp: 0, hurt: 0, pick: 0
  };
  var i;
  for (i = 0; i < CDA_W; i++) view.camX[i] = 2 * (i + 0.5) / CDA_W - 1;
  for (i = 0; i < view.rowDist.length; i++) view.rowDist[i] = CDA_PROJ * 0.5 / (i + 0.5);
  for (i = 0; i < T.names.length; i++) view.anim[i] = i;
  var frames = Object.keys(CDA_TEX_FRAMES);
  for (i = 0; i < frames.length; i++) view.anim[T.id[frames[i]]] = T.id[CDA_TEX_FRAMES[frames[i]]];
  // itemK, decorK: cells a texel (the row's tall over the sprite's height)
  for (i = 0; i < CDA_ITEMS.length; i++) {
    var it = T.id['it-' + CDA_ITEMS[i].id];
    view.itemTex[CDA_ITEMS[i].id] = it;
    view.itemK[CDA_ITEMS[i].id] = CDA_ITEMS[i].tall / T.h[it];
  }
  for (i = 0; i < CDA_DECOR.length; i++) {
    var dc = T.id['dc-' + CDA_DECOR[i].id];
    view.decorTex[CDA_DECOR[i].id] = dc;
    view.decorK[CDA_DECOR[i].id] = CDA_DECOR[i].tall / T.h[dc];
  }
  for (i = 0; i < CDA_SHOTS.length; i++) {
    var sh = CDA_SHOTS[i].id;
    view.shotTex[sh] = [T.id['fx-' + sh + '0'], T.id['fx-' + sh + '1']];
  }
  for (i = 0; i < CDA_FX.length; i++) {
    var ids = [];
    for (var f = 0; f < CDA_FX[i].names.length; f++) ids.push(T.id[CDA_FX[i].names[f]]);
    view.fxIds.push(ids);
    view.fxLife.push(cdaSteps(CDA_FX[i].life));
  }
  for (i = 0; i < CDA_FX_SLOTS; i++) view.fxKind[i] = -1;
  for (i = 0; i < CDA_TOOLS.length; i++) {
    var tool = CDA_TOOLS[i].id;
    var list = CDA_HAND[tool];
    var h = { idle: T.id['vw-' + tool + '-idle'], frames: [], limits: [] };
    for (f = 0; f < list.length; f++) {
      h.frames.push(T.id['vw-' + tool + '-' + list[f][0]]);
      h.limits.push(list[f][1]);
    }
    view.hand[tool] = h;
  }
  return view;
}

// Starts effect `kind` (an index of CDA_FX) at (x, y), z cells above the
// floor, in the next slot of the pool (the oldest goes when it is full).
function cdaSpawnFx(view, kind, x, y, z) {
  var i = view.fxNext;
  view.fxNext = (i + 1) % CDA_FX_SLOTS;
  view.fxKind[i] = kind;
  view.fxAge[i] = 0;
  view.fxX[i] = x;
  view.fxY[i] = y;
  view.fxZ[i] = z;
}

function cdaViewStep(view, sim) {
  var p = sim.player;
  var i;
  for (i = 0; i < CDA_FX_SLOTS; i++) {
    if (view.fxKind[i] < 0) continue;
    view.fxAge[i]++;
    if (view.fxAge[i] >= view.fxLife[view.fxKind[i]]) view.fxKind[i] = -1;
  }
  var walked = cdaDist(p.px, p.py, p.x, p.y);
  view.bobPhase += walked * CDA_BOB_RATE;
  view.bobAmp = walked > 0 ? Math.min(1, view.bobAmp + 0.04) : Math.max(0, view.bobAmp - 0.04);
  if (view.hurt > 0) view.hurt--;
  if (view.pick > 0) view.pick--;
  if (p.tool !== view.tool) {
    view.prevTool = view.tool;
    view.tool = p.tool;
  }
  for (i = 0; i < sim.events.length; i++) {
    var ev = sim.events[i];
    if (ev.type === 'wall') {
      // a little toward the player, so the wall does not hide half of it
      var d = cdaDist(p.x, p.y, ev.x, ev.y);
      cdaSpawnFx(view, 0, ev.x + (p.x - ev.x) * 0.08 / d, ev.y + (p.y - ev.y) * 0.08 / d, 0.5);
    } else if (ev.type === 'hit') {
      cdaSpawnFx(view, 1, ev.x, ev.y, CDA_HIT_Z[ev.kind]);
    } else if (ev.type === 'die') {
      cdaSpawnFx(view, 2, ev.x, ev.y, CDA_HIT_Z[ev.kind]);
    } else if (ev.type === 'shotEnd' && ev.hit === 'wall') {
      cdaSpawnFx(view, 0, ev.x, ev.y, CDA_SHOT_Z);
    } else if (ev.type === 'hurt') {
      view.hurt = cdaSteps(CDA_HURT_TIME);
    } else if (ev.type === 'pickup') {
      view.pick = cdaSteps(CDA_PICK_TIME);
    }
  }
}

// The texture id of the tool in hand and how far (pixels) it is lowered.
function cdaHandFrame(view, sim) {
  var p = sim.player;
  var s = p.switchT / cdaSteps(CDA_PLAYER.switchTime);
  view.handDrop = Math.round((1 - Math.abs(2 * s - 1)) * 72);
  if (s > 0.5) return view.hand[view.prevTool].idle;
  var h = view.hand[p.tool];
  var share = p.fireT / sim.tools[p.tool].cooldown;
  for (var i = 0; i < h.limits.length; i++) if (share < h.limits[i]) return h.frames[i];
  return h.idle;
}

function cdaDrawHand(view, sim, pixels) {
  var T = view.tex;
  var id = cdaHandFrame(view, sim);
  var w = T.w[id];
  var h = T.h[id];
  var x0 = CDA_HAND_X + Math.round(Math.sin(view.bobPhase) * 6 * view.bobAmp);
  var y0 = CDA_HAND_Y + Math.round(Math.abs(Math.cos(view.bobPhase)) * 5 * view.bobAmp) + view.handDrop;
  var zone = view.cellZone[((view.cy | 0) & 63) * 64 + ((view.cx | 0) & 63)];
  var lvl = cdaLevelAt(view, zone, 0.5) * 256;
  var rows = Math.min(h, CDA_H - y0);
  for (var x = 0; x < w; x++) {
    var col = T.off[id] + x * h;
    for (var y = 0, o = y0 * CDA_W + x0 + x; y < rows; y++, o += CDA_W) {
      var t = T.atlas[col + y];
      if (t) pixels[o] = T.shade[lvl + t];
    }
  }
}

function cdaFillRect(pixels, x, y, w, h, colour) {
  for (var j = y; j < y + h; j++) for (var i = x; i < x + w; i++) pixels[j * CDA_W + i] = colour;
}

// The reboot's progress bar while Use is held on a rack.
function cdaDrawUseBar(view, sim, pixels) {
  if (sim.reboot < 0) return;
  var pal = view.tex.pal;
  var ix = view.tex.index;
  var b = CDA_BAR;
  cdaFillRect(pixels, b.x - 1, b.y - 1, b.w + 2, b.h + 2, pal[ix.k]);
  cdaFillRect(pixels, b.x, b.y, b.w, b.h, pal[ix.K]);
  cdaFillRect(pixels, b.x, b.y, Math.round(b.w * sim.racks[sim.reboot].progress), b.h, pal[ix.G]);
}

// Mixes the whole frame toward (r, g, b) by share a (0..1).
function cdaTint(pixels, r, g, b, a) {
  var k = Math.round(a * 256);
  var keep = 256 - k;
  var add = 0xff000000 | (((b * k) >> 8) << 16) | (((g * k) >> 8) << 8) | ((r * k) >> 8);
  for (var i = 0; i < pixels.length; i++) {
    var c = pixels[i];
    pixels[i] = (add + ((((c >> 16) & 255) * keep >> 8) << 16) + ((((c >> 8) & 255) * keep >> 8) << 8) + (((c & 255) * keep) >> 8)) | 0;
  }
}

function cdaRender(view, sim, alpha, pixels) {
  var p = sim.player;
  view.cx = p.px + (p.x - p.px) * alpha;
  view.cy = p.py + (p.y - p.py) * alpha;
  view.ca = p.pangle + (p.angle - p.pangle) * alpha;
  var t = Math.tan(CDA_FOV / 2);
  view.dirX = Math.cos(view.ca);
  view.dirY = Math.sin(view.ca);
  view.plX = -view.dirY * t;
  view.plY = view.dirX * t;
  if (view.flashFor !== p.flashlight) cdaLightTable(view, p.flashlight);
  cdaViewCells(view, sim, alpha);
  cdaCastWalls(view, pixels);
  cdaDrawFlats(view, pixels);
  cdaDrawSprites(view, sim, alpha, pixels);
  cdaDrawHand(view, sim, pixels);
  cdaDrawUseBar(view, sim, pixels);
  if (view.hurt > 0) cdaTint(pixels, 239, 40, 40, 0.45 * view.hurt / cdaSteps(CDA_HURT_TIME));
  if (view.pick > 0) cdaTint(pixels, 255, 236, 180, 0.3 * view.pick / cdaSteps(CDA_PICK_TIME));
}

CDA_API.CDA_HAND = CDA_HAND;
CDA_API.CDA_HAND_X = CDA_HAND_X;
CDA_API.CDA_HAND_Y = CDA_HAND_Y;
CDA_API.CDA_BAR = CDA_BAR;
CDA_API.CDA_HURT_TIME = CDA_HURT_TIME;
CDA_API.CDA_PICK_TIME = CDA_PICK_TIME;
CDA_API.cdaNewView = cdaNewView;
CDA_API.cdaViewStep = cdaViewStep;
CDA_API.cdaRender = cdaRender;
CDA_API.cdaHandFrame = cdaHandFrame;
