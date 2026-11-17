// ── render-units: render, 2 of 3 parts: defenders, enemies, bosses, auras, beams, shots and shells ──
// Owns the drawing of every unit and projectile of a sim (pksDrawDefender,
// pksDrawArming, pksDrawAuras, pksDrawEnemy, pksDrawBeams, pksDrawShots,
// pksDrawShells); pksRender (render) calls them in its draw order.  Uses
// core, defenders (PKS_DEF), enemies (PKS_REACH), the art tables and
// primitives of render, and the atlas.  Never changes the sim.
//
// Anchors (x, y: the cell's or lane's top-left on the canvas; cx: an enemy's
// centre x in px):
//   defenders        (x+4, y+6); overlays fx-jam at the same anchor, the boost
//                    chevron (lime) at (x+27, y+3), right of the HP bar
//   enemies          (cx - w/2, y + 30 - h): 24x24 at (cx-12, y+6), the 32x32
//                    Kernel Panic at (cx-16, y-2), feet on the same line;
//                    fx-freeze and fx-shield at (cx-12, y+6); the shield bar
//                    (periwinkle on deep indigo) 16 wide at (cx-8, y+2); the
//                    Amplifier's cue, an orange chevron, at (cx+10, y+3); a
//                    Hydra's heal, an aqua plus, rising from (cx-12, y+8)
//   bosses           48x48 at (cx-24, y-16); fx-shield-boss there; HP bar 32
//                    wide at (cx-16, y-19), shield bar above it at y-24
//   auras            48x48 at (cx-24, y-6), alpha PKS_AURA_ALPHA
//   shots            centred on x, top at y+13 (8 px tall)
//   shells           centred on their flight point, from the lane's centre
//                    (y+17) up an arc PKS_SHELL_HEIGHT high; a dark shadow on
//                    the lane's feet line under them

var PKS_ARM_DX = 8;           // the arming bar of a trap: a cyan bar over its cell,
var PKS_ARM_DY = 9;           // below the HP bar (dy 1..4), above the shut chest;
var PKS_ARM_W = 16;           // it fills as the trap arms
var PKS_ARMED_LIFE = 30;      // steps of the full bar blinking once a trap is armed
// An Exploit leaps from contact (half a cell plus its reach right of the
// defender's centre) to a quarter cell left of the defender (pksContact).
var PKS_LEAP_SPAN = 0.5 + PKS_REACH + 0.25;
var PKS_LEAP_HEIGHT = 14;     // px at the top of the arc
var PKS_THROW_HEIGHT = 22;    // px at the top of a thrown Bot's flight
var PKS_KNOCK_HEIGHT = 6;     // px at the top of a knockback's hop
var PKS_SHELL_HEIGHT = 28;    // px at the top of a Batch Job shell's arc
var PKS_AURA_ALPHA = 0.4;
var PKS_BLINK_ALPHA = 0.5;    // a Glitch while it blinks
var PKS_AT = { x: 0, y: 0, alpha: 1 };  // pksEnemyAt's result (scratch, not state)

// A defender: idle frames by anim, the firing frame while fire runs, a trap
// shut while arming (or re-arming) and open once armed (its arming bar is
// drawn over the units, pksDrawArming), an instant blinking fast on its
// fuse; white while hit; blinking blue while being encrypted, faint blue
// with a lock while off; jammed: the fx-jam mark over it; boosted: a lime
// chevron; a small HP bar once damaged; a glint while a Patch Server
// repairs it.
function pksDrawDefender(ctx, atlas, sim, d) {
  var art = PKS_DEF_ART[d.type];
  var name;
  if (d.fire > 0 && art[2]) name = art[2];
  else if (d.kind === 'trap') name = art[d.state === 'armed' ? 1 : 0];
  else if (d.kind === 'instant') name = art[Math.floor(d.anim / 6) % 2];
  else name = art[Math.floor(d.anim / 30) % 2];
  var x = pksUnitX(d.col);
  var y = pksLaneY(d.lane);
  var set = d.flash > 0 ? atlas.flash : atlas.frames;
  if (d.off > 0) {
    ctx.globalAlpha = 0.55;
    pksBlit(ctx, atlas, atlas.slow, name, x + 4, y + 6);
    ctx.globalAlpha = 1;
    pksBlit(ctx, atlas, atlas.frames, 'icon-lock', x + 20, y + 4);
  } else {
    if (d.enc > 0 && Math.floor(d.enc / 8) % 2 === 0) set = atlas.slow;
    pksBlit(ctx, atlas, set, name, x + 4, y + 6);
    if (d.jammed) pksBlit(ctx, atlas, atlas.frames, 'fx-jam', x + 4, y + 6);
    if (d.boosted) pksChevron(ctx, PKS_PALETTE.s, x + 27, y + 3);
  }
  if (d.hp < d.maxHp) {
    pksHpBar(ctx, x + 8, y + 2, 16, d.hp / d.maxHp);
    if (d.healed === sim.tick) pksBlit(ctx, atlas, atlas.frames, 'fx-heal', x + 22, y + 12 - Math.floor(sim.tick % 24 / 3));
  }
}

// The arming bar of every trap still arming, over the units (an enemy eating
// the trap never hides it): the share of the arming time gone, so it is full
// the step the trap arms.  The time is the defender table's arm, or, for a
// Honeynet re-arming after it went off, its rearm: it is re-arming when the
// steps it has stood (anim) and the steps left (t) add up to at least
// arm + rearm (while it first arms they add up to arm, plus any steps it was
// switched off).
function pksDrawArming(ctx, sim) {
  for (var i = 0; i < sim.defenders.length; i++) {
    var d = sim.defenders[i];
    if (d.kind !== 'trap' || d.t === 0) continue;
    var arm = pksSteps(PKS_DEF[d.type].arm);
    var rearm = pksSteps(PKS_DEF[d.type].rearm || 0);
    var total = rearm > 0 && d.anim + d.t >= arm + rearm ? rearm : arm;
    var x = pksUnitX(d.col) + PKS_ARM_DX;
    var y = pksLaneY(d.lane) + PKS_ARM_DY;
    pksRect(ctx, PKS_PALETTE.k, x - 1, y - 1, PKS_ARM_W + 2, 4);
    pksRect(ctx, PKS_PALETTE.C, x, y, PKS_ARM_W, 2);
    pksRect(ctx, PKS_PALETTE.c, x, y, Math.round(PKS_ARM_W * (1 - d.t / total)), 2);
  }
}

// Where an enemy is drawn, into PKS_AT: x its centre in px, y its lane's top
// (sliding between lanes on a lane change, arcing over a leap), alpha.  A
// knockback, a blink or a thrown Bot (move / moveFrom) slides from moveFrom
// to x over PKS_SLIDE_TIME: a knockback with a small hop, a throw in a high
// arc, a Glitch's blink flat and faint.
function pksEnemyAt(e) {
  var x = e.x;
  var y = pksLaneY(e.lane);
  var alpha = e.cloaked ? 0.35 : 1;
  if (e.shift > 0) y += (pksLaneY(e.from) - y) * e.shift / PKS_SHIFT_STEPS;
  if (e.state === 'leaping') {
    var t = (e.x - e.leapTo) / PKS_LEAP_SPAN;
    y -= PKS_LEAP_HEIGHT * 4 * t * (1 - t);
  }
  if (e.move > 0) {
    var s = e.move / PKS_SLIDE_STEPS;
    x += (e.moveFrom - e.x) * s;
    if (e.type === 'glitch') alpha = PKS_BLINK_ALPHA;
    else y -= (e.moveFrom > e.x ? PKS_THROW_HEIGHT : PKS_KNOCK_HEIGHT) * 4 * s * (1 - s);
  }
  PKS_AT.x = pksUnitX(x);
  PKS_AT.y = y;
  PKS_AT.alpha = alpha;
}

// The auras of Amplifiers and Hydras on the floor, faint, under every unit.
function pksDrawAuras(ctx, atlas, sim, fogX) {
  ctx.globalAlpha = PKS_AURA_ALPHA;
  for (var i = 0; i < sim.enemies.length; i++) {
    var e = sim.enemies[i];
    if (e.aura === 0 || !pksOwn(PKS_AURA_ART, e.type) || e.x > fogX) continue;
    pksEnemyAt(e);
    pksBlit(ctx, atlas, atlas.frames, PKS_AURA_ART[e.type], PKS_AT.x - 24, PKS_AT.y - 6);
  }
  ctx.globalAlpha = 1;
}

// An enemy (or a boss): walk / bite (or cast) frames by anim, white while
// hit, blue while slowed, the ice overlay while frozen, faint while
// cloaked; a Replicator by its generation; the shield overlay and bar while
// it has a shield; the Amplifier's cue while amped; a Hydra's plus the step
// it was mended.  A boss is 48x48, its body from its tier row, in its tier's
// tint (pksBossSet, render-rules) unless white or blue, and carries an HP
// bar.
function pksDrawEnemy(ctx, atlas, sim, e) {
  var frame = Math.floor(e.anim / 12) % 2;
  pksEnemyAt(e);
  var cx = PKS_AT.x;
  var y = PKS_AT.y;
  var set = atlas.frames;
  if (e.flash > 0) set = atlas.flash;
  else if (e.slow > 0) set = atlas.slow;
  ctx.globalAlpha = PKS_AT.alpha;
  if (e.tier > 0) {
    var body = pksBossArt(e.tier)[(e.cast > 0 ? 2 : 0) + frame];
    pksBlit(ctx, atlas, set === atlas.frames ? pksBossSet(atlas, e.tier, body) : set, body, cx - 24, y - 16);
    if (e.shield > 0) pksBlit(ctx, atlas, atlas.frames, 'fx-shield-boss', cx - 24, y - 16);
    if (e.frozen > 0) pksBlit(ctx, atlas, atlas.frames, 'fx-freeze', cx - 12, y + 2);
    ctx.globalAlpha = 1;
    pksHpBar(ctx, cx - 16, y - 19, 32, e.hp / e.maxHp);
    if (e.shield > 0) pksShieldBar(ctx, cx - 16, y - 24, 32, e.shield / e.maxShield);
    if (e.amped) pksChevron(ctx, PKS_PALETTE.o, cx + 19, y - 21);
    return;
  }
  var art = e.gen > 1 ? PKS_GEN_ART[e.gen] : PKS_ENM_ART[e.type];
  var name = art[(PKS_BITE_STATES[e.state] ? 2 : 0) + frame];
  var sp = PKS_SPRITES[name];
  pksBlit(ctx, atlas, set, name, cx - sp.w / 2, y + 30 - sp.h);
  if (e.frozen > 0) pksBlit(ctx, atlas, atlas.frames, 'fx-freeze', cx - 12, y + 6);
  if (e.shield > 0) pksBlit(ctx, atlas, atlas.frames, 'fx-shield', cx - 12, y + 6);
  ctx.globalAlpha = 1;
  if (e.shield > 0) pksShieldBar(ctx, cx - 8, y + 2, 16, e.shield / e.maxShield);
  if (e.amped) pksChevron(ctx, PKS_PALETTE.o, cx + 10, y + 3);
  if (e.mended === sim.tick) {
    var py = y + 8 - Math.floor(sim.tick % 24 / 4);
    pksRect(ctx, PKS_PALETTE.t, cx - 12, py + 1, 3, 1);
    pksRect(ctx, PKS_PALETTE.t, cx - 11, py, 1, 3);
  }
}

// A Packet Inspector's beam, from its muzzle to the right edge of the
// floor, while its firing frame runs.
function pksDrawBeams(ctx, atlas, sim) {
  var f = atlas.frames.beam;
  for (var i = 0; i < sim.defenders.length; i++) {
    var d = sim.defenders[i];
    if (d.kind !== 'beam' || d.fire === 0) continue;
    ctx.globalAlpha = Math.min(1, d.fire / 8);
    var y = pksLaneY(d.lane) + 11;
    for (var x = pksUnitX(d.col) + 28; x < PKS_FLOOR_RIGHT; x += f.w) {
      var w = Math.min(f.w, PKS_FLOOR_RIGHT - x);
      ctx.drawImage(atlas.canvas, f.x, f.y, w, f.h, x, y, w, f.h);
    }
  }
  ctx.globalAlpha = 1;
}

// Every shot, centred on its x, on its lane (a Decryptor's too; a shot an
// Air Gap sent back keeps its sprite).
function pksDrawShots(ctx, atlas, sim) {
  for (var i = 0; i < sim.shots.length; i++) {
    var s = sim.shots[i];
    var name = PKS_SHOT_ART[s.kind];
    pksBlit(ctx, atlas, atlas.frames, name, pksUnitX(s.x) - PKS_SPRITES[name].w / 2, pksLaneY(s.lane) + 13);
  }
}

// Batch Job shells in the air: from the mortar's centre to where they land,
// along an arc, with a shadow on the lane that follows them.
function pksDrawShells(ctx, atlas, sim) {
  for (var i = 0; i < sim.shells.length; i++) {
    var s = sim.shells[i];
    var p = 1 - s.t / s.flight;
    var x = pksUnitX(s.from + (s.to - s.from) * p);
    var y = pksLaneY(s.lane);
    ctx.globalAlpha = 0.45;
    pksRect(ctx, PKS_PALETTE.k, x - 3, y + 27, 6, 2);
    ctx.globalAlpha = 1;
    pksBlit(ctx, atlas, atlas.frames, 'shot-shell', x - 4, y + 13 - PKS_SHELL_HEIGHT * 4 * p * (1 - p));
  }
}
