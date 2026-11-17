// ── render-fx: render, 3 of 3 parts: the view, its passing effects and the pointer ──
// Owns the view (pksNewView, pksViewEvents, pksViewStep), the effects each
// sim event starts (pksEventFx), their drawing (pksDrawFx) and the cursor and
// ghost (pksDrawPointer).  Uses core, defenders (PKS_DEF), the art tables and
// primitives of render, and the atlas.  The view is presentation only; the
// sim is never changed.
//
// An effect is { kind, x, y, age, life, lane, text, color, art, to, id, n,
// path } (age below 0: still waiting its delay).  Kinds:
//   spark, boom, puff, sweep, rack, glint, pip, ring, flash, place, armed,
//   edge     the effects of levels 1-50 (pip: a "+25" or, with an enemy id
//            in id and the stolen cycles in n, a red "-3", or with art
//            icon-upkeep an upkeep charge; flash: color, or cyan when none)
// The zone rules and the late bosses (pksRuleEventFx): an enemy emerging
// from a tunnel puffs on the exit; a crossover rings its cell; an upkeep
// charge rises as a crimson "-N" pip with icon-upkeep at the rack of lane 1
// (a white "0" when nothing could be taken);
// a boss's shield coming back flashes fx-shield-boss; a boss splitting
// flashes the field fuchsia and rings where it fell.
//   decal    sprite `art` at (x, y), fading: a wipe, a knock, a pull, a
//            restore, a blink, a shield breaking
//   splash   fx-splash0..2 over its life at (x, y)
//   trace    a Tracer's heavy shot: a crimson line from (x, y) to (to, y),
//            shot-heavy at its end for the first steps
//   arc      a Token Ring's bolt from its muzzle (x, the lane `lane`)
//            through the points of `path` ({id, lane, x} of the sim event):
//            flat along a lane, fx-arc0/1 from lane to lane

var PKS_HIT_DX = { drop: -14, tar: -14, decrypt: -14, phish: -4, volley: -4 };  // spark left of an enemy, on a defender
var PKS_STEAL_GROUP = 20;     // steps a Keylogger's "-N" pip keeps adding what it steals
var PKS_UPKEEP_X = 6;         // the upkeep pip: on the rack of lane 1, under the
var PKS_UPKEEP_Y = 26;        // trickle's pip on the strip

// ── the view ──

function pksNewView() {
  return { cursor: null, ghost: null, fx: [], tick: 0, ring: 0, events: null, seen: 0 };
}

// Ages every running effect by one step.
function pksViewStep(view) {
  view.tick++;
  for (var i = 0; i < view.fx.length; i++) {
    if (view.fx[i].age < view.fx[i].life) view.fx[i].age++;
  }
}

// Starts the effects of the sim events the view has not read yet.
function pksViewEvents(view, sim) {
  if (view.events !== sim.events) {
    view.events = sim.events;
    view.seen = 0;
  }
  for (var i = view.seen; i < sim.events.length; i++) pksEventFx(view, sim.events[i]);
  view.seen = sim.events.length;
}

// A new effect (a dead one reused; when all PKS_FX_MAX run, the next in
// turn is taken over).  delay: steps before it shows.
function pksAddFx(view, kind, x, y, life, delay) {
  var list = view.fx;
  var fx = null;
  for (var i = 0; i < list.length && !fx; i++) {
    if (list[i].age >= list[i].life) fx = list[i];
  }
  if (!fx && list.length < PKS_FX_MAX) {
    fx = {};
    list.push(fx);
  } else if (!fx) {
    fx = list[view.ring];
    view.ring = (view.ring + 1) % PKS_FX_MAX;
  }
  fx.kind = kind;
  fx.x = x;
  fx.y = y;
  fx.age = 0 - delay;
  fx.life = life;
  fx.lane = 0;
  fx.text = '';
  fx.color = '';
  fx.art = '';
  fx.to = 0;
  fx.id = 0;
  fx.n = 0;
  fx.path = null;
  return fx;
}

function pksDecal(view, art, x, y, life) {
  pksAddFx(view, 'decal', x, y, life, 0).art = art;
}

function pksEventFx(view, ev) {
  var x, y, i;
  switch (ev.type) {
    case 'hit':
      pksAddFx(view, 'spark', pksUnitX(ev.x) + PKS_HIT_DX[ev.kind], pksLaneY(ev.lane) + 12, 6, 0);
      break;
    case 'kill':
      if (ev.enemy === 'boss' || PKS_BIG_ENEMY[ev.enemy]) pksAddFx(view, 'boom', pksUnitX(ev.x) - 16, pksLaneY(ev.lane) - 8, 24, 0);
      else pksAddFx(view, 'puff', pksUnitX(ev.x) - 16, pksLaneY(ev.lane), 8, 0);
      break;
    case 'blast':
      pksBlastFx(view, ev);
      break;
    case 'pulse':
      pksAddFx(view, 'ring', pksUnitX(ev.col + 0.5), pksLaneY(ev.lane) + 16, 12, 0);
      break;
    case 'freeze':
      pksAddFx(view, 'flash', 0, 0, 24, 0);
      break;
    case 'breaker':
      pksAddFx(view, 'sweep', 0, pksLaneY(ev.lane), 36, 0).lane = ev.lane;
      pksAddFx(view, 'rack', 0, pksLaneY(ev.lane), 30, 0);
      break;
    case 'lose':
      pksAddFx(view, 'rack', 0, pksLaneY(ev.lane), 30, 0);
      break;
    case 'surgeWarn':
      pksAddFx(view, 'edge', PKS_FLOOR_RIGHT, 0, pksSteps(PKS_SURGE_WARN), 0).color = PKS_PALETTE.o;
      break;
    case 'surge':
      pksAddFx(view, 'edge', PKS_FLOOR_RIGHT, 0, 60, 0).color = PKS_PALETTE.r;
      break;
    case 'produce':
      pksAddFx(view, 'pip', pksUnitX(ev.col) + 6, pksLaneY(ev.lane) + 4, 40, 0).text = '+' + ev.amount;
      break;
    case 'trickle':
      pksAddFx(view, 'pip', 6, 10, 40, 0).text = '+' + ev.amount;
      break;
    case 'placed':
      pksAddFx(view, 'place', pksUnitX(ev.col), pksLaneY(ev.lane), 10, 0);
      break;
    case 'removed':
      pksAddFx(view, 'puff', pksUnitX(ev.col), pksLaneY(ev.lane), 8, 0);
      break;
    case 'destroyed':
      if (ev.why !== 'spent') pksAddFx(view, 'puff', pksUnitX(ev.col), pksLaneY(ev.lane), 8, 0);
      break;
    case 'armed':
      pksAddFx(view, 'spark', pksUnitX(ev.col) + 20, pksLaneY(ev.lane) + 6, 12, 0);
      pksAddFx(view, 'armed', pksUnitX(ev.col) + PKS_ARM_DX, pksLaneY(ev.lane) + PKS_ARM_DY, PKS_ARMED_LIFE, 0);
      break;
    case 'cleared':
      pksAddFx(view, 'glint', pksUnitX(ev.col) + 12, pksLaneY(ev.lane) + 4, 24, 0);
      break;
    case 'cloak':
      x = pksUnitX(ev.x);
      y = pksLaneY(ev.lane);
      if (ev.on) pksAddFx(view, 'puff', x - 16, y, 8, 0);
      else pksAddFx(view, 'spark', x - 4, y + 12, 10, 0);
      break;
    case 'morph':
      pksAddFx(view, 'puff', pksUnitX(ev.x) - 16, pksLaneY(ev.from), 8, 0);
      break;
    case 'summon':
      for (i = 0; i < 2; i++) pksAddFx(view, 'puff', pksUnitX(ev.x + 0.6 + i * 0.5) - 16, pksLaneY(ev.lane), 8, i * 3);
      break;
    default:
      pksLateEventFx(view, ev);
  }
}

// The effects of the expansion's events (jam and lob have none: a jammed
// shooter and a shell in the air are drawn from the sim).
function pksLateEventFx(view, ev) {
  var fx, i;
  switch (ev.type) {
    case 'steal':
      pksStealFx(view, ev);
      break;
    case 'detonate':
      pksBoomArea(view, ev.lane, ev.col);
      break;
    case 'wipe':
      pksDecal(view, 'fx-wipe', pksUnitX(ev.col), pksLaneY(ev.lane), 18);
      break;
    case 'release':
      pksAddFx(view, 'puff', pksUnitX(ev.x) - 16, pksLaneY(ev.lane), 8, 0);
      break;
    case 'throw':
      pksAddFx(view, 'spark', pksUnitX(ev.x) - 4, pksLaneY(ev.lane) + 6, 8, 0);
      break;
    case 'split':
      for (i = 0; i < 2; i++) pksAddFx(view, 'puff', pksUnitX(ev.x + i * 0.4) - 16, pksLaneY(ev.lane), 8, i * 3);
      break;
    case 'shieldBreak':
      pksDecal(view, 'fx-shield-break', pksUnitX(ev.x) - 12, pksLaneY(ev.lane) + 6, 14);
      break;
    case 'blink':
      pksDecal(view, 'fx-blink', pksUnitX(ev.x) - 16, pksLaneY(ev.lane), 12);
      break;
    case 'trace':
      fx = pksAddFx(view, 'trace', pksUnitX(ev.col) + 27, pksLaneY(ev.lane) + 17, 10, 0);
      fx.to = Math.round(pksUnitX(ev.x)) - 6;
      pksAddFx(view, 'spark', pksUnitX(ev.x) - 14, pksLaneY(ev.lane) + 12, 6, 0);
      break;
    case 'splash':
      pksAddFx(view, 'splash', pksUnitX(ev.x) - 16, pksLaneY(ev.lane), 15, 0);
      break;
    case 'knock':
      pksDecal(view, 'fx-knock', pksUnitX(ev.from) - 16, pksLaneY(ev.lane), 12);
      break;
    case 'arc':
      fx = pksAddFx(view, 'arc', pksUnitX(ev.col) + 27, pksLaneY(ev.lane) + 17, 10, 0);
      fx.lane = ev.lane;
      fx.path = ev.path;
      for (i = 0; i < ev.path.length; i++) pksAddFx(view, 'spark', pksUnitX(ev.path[i].x) - 4, pksLaneY(ev.path[i].lane) + 12, 8, 0);
      break;
    case 'pull':
      pksDecal(view, 'fx-pull', pksUnitX(ev.x) - 16, pksLaneY(ev.from), 16);
      break;
    case 'reflect':
      pksAddFx(view, 'spark', pksUnitX(ev.x) - 4, pksLaneY(ev.lane) + 12, 8, 0);
      break;
    case 'restore':
      pksDecal(view, 'fx-restore', pksUnitX(ev.col), pksLaneY(ev.lane), 20);
      break;
    case 'scrub':
      pksAddFx(view, 'flash', 0, 0, 16, 0).color = PKS_PALETTE.w;
      pksAddFx(view, 'ring', pksUnitX(ev.col + 0.5), pksLaneY(ev.lane) + 16, 12, 0);
      break;
    default:
      pksRuleEventFx(view, ev);
  }
}

// The effects of the zone rules' and the late bosses' events (shimmer,
// blackout and outage have none: they are drawn from the sim's state).
function pksRuleEventFx(view, ev) {
  var fx;
  switch (ev.type) {
    case 'emerge':
      pksAddFx(view, 'puff', pksUnitX(ev.col), pksLaneY(ev.lane), 8, 0);
      break;
    case 'cross':
      pksAddFx(view, 'ring', pksUnitX(ev.col + 0.5), pksLaneY(ev.from) + 16, 12, 0);
      break;
    case 'upkeep':
      // an unpaid charge takes nothing: a white "0", not a crimson "-0"
      fx = pksAddFx(view, 'pip', PKS_UPKEEP_X, PKS_UPKEEP_Y, 40, 0);
      fx.text = ev.amount ? '-' + ev.amount : '0';
      fx.color = ev.amount ? PKS_PALETTE.x : PKS_PALETTE.w;
      fx.art = 'icon-upkeep';
      break;
    case 'shieldUp':
      pksDecal(view, 'fx-shield-boss', pksUnitX(ev.x) - 24, pksLaneY(ev.lane) - 16, 20);
      break;
    case 'bossSplit':
      pksAddFx(view, 'flash', 0, 0, 12, 0).color = PKS_PALETTE.f;
      pksAddFx(view, 'ring', pksUnitX(ev.x), pksLaneY(ev.lane) + 16, 16, 0);
      break;
  }
}

// A Keylogger's theft: a red "-N" pip over it; what it steals within
// PKS_STEAL_GROUP steps of the pip's start adds to the same pip.
function pksStealFx(view, ev) {
  for (var i = 0; i < view.fx.length; i++) {
    var f = view.fx[i];
    if (f.kind === 'pip' && f.id === ev.id && f.age >= 0 && f.age < PKS_STEAL_GROUP) {
      f.n += ev.amount;
      f.text = '-' + f.n;
      return;
    }
  }
  var fx = pksAddFx(view, 'pip', pksUnitX(ev.x) - 4, pksLaneY(ev.lane) + 2, 30, 0);
  fx.id = ev.id;
  fx.n = ev.amount;
  fx.text = '-' + ev.amount;
  fx.color = PKS_PALETTE.x;
}

// A Null Route: booms over the 3x3; a Failover: booms along its lane, one
// column after the other; a Honeypot or Honeynet: one boom on its cell.
function pksBlastFx(view, ev) {
  var effect = PKS_DEF[ev.def].effect;
  var c;
  if (effect === 'blast') {
    pksBoomArea(view, ev.lane, ev.col);
  } else if (effect === 'lane') {
    for (c = 0; c < PKS_COLS; c++) pksAddFx(view, 'boom', pksUnitX(c), pksLaneY(ev.lane), 16, c * 2);
  } else {
    pksAddFx(view, 'boom', pksUnitX(ev.col), pksLaneY(ev.lane), 16, 0);
  }
}

// Booms over the cells of the 3x3 around (lane, col) on the floor (a Null
// Route, a Logic Bomb).
function pksBoomArea(view, lane, col) {
  for (var l = Math.max(0, lane - 1); l <= Math.min(PKS_LANES - 1, lane + 1); l++) {
    for (var c = Math.max(0, col - 1); c <= Math.min(PKS_COLS - 1, col + 1); c++) {
      pksAddFx(view, 'boom', pksUnitX(c), pksLaneY(l), 16, (l + c) % 2 * 2);
    }
  }
}

// ── drawing ──

function pksDrawFx(ctx, atlas, sim, fx) {
  var F = atlas.frames;
  var fade = 1 - fx.age / fx.life;
  var i;
  switch (fx.kind) {
    case 'spark':
      pksBlit(ctx, atlas, F, 'fx-hit', fx.x, fx.y);
      break;
    case 'boom':
      pksBlit(ctx, atlas, F, PKS_BOOM_ART[Math.floor(fx.age * 4 / fx.life)], fx.x, fx.y);
      break;
    case 'puff':
      ctx.globalAlpha = 0.7;
      pksBlit(ctx, atlas, F, PKS_BOOM_ART[2 + Math.floor(fx.age * 2 / fx.life)], fx.x, fx.y);
      break;
    case 'sweep':
      ctx.globalAlpha = Math.min(1, fade * 2);
      for (i = 0; i < Math.min(PKS_COLS, Math.floor(fx.age / 2) + 1); i++) {
        pksBlit(ctx, atlas, F, PKS_SURGE_ART[(fx.age + i) % 3], pksUnitX(i), fx.y);
      }
      break;
    case 'rack':
      if (Math.floor(fx.age / 4) % 2 === 0) {
        ctx.globalAlpha = 0.6;
        pksRect(ctx, PKS_PALETTE.w, 0, fx.y, PKS_FIELD_X, PKS_CELL);
      }
      break;
    case 'glint':
      ctx.globalAlpha = fade;
      pksBlit(ctx, atlas, F, 'fx-heal', fx.x, fx.y - fx.age / 3);
      break;
    case 'pip':
      ctx.globalAlpha = Math.min(1, fade * 3);
      pksBlit(ctx, atlas, F, fx.art || 'icon-cycles', fx.x, fx.y - fx.age / 4);
      pksDrawText(ctx, fx.text, fx.x + 10, fx.y + 2 - fx.age / 4, fx.color);
      break;
    case 'ring':
      var half = 16 + Math.round(32 * fx.age / fx.life);
      ctx.globalAlpha = fade;
      pksRect(ctx, PKS_PALETTE.c, fx.x - half, fx.y - half, half * 2, 1);
      pksRect(ctx, PKS_PALETTE.c, fx.x - half, fx.y + half - 1, half * 2, 1);
      pksRect(ctx, PKS_PALETTE.c, fx.x - half, fx.y - half, 1, half * 2);
      pksRect(ctx, PKS_PALETTE.c, fx.x + half - 1, fx.y - half, 1, half * 2);
      break;
    case 'flash':
      ctx.globalAlpha = 0.4 * fade;
      pksRect(ctx, fx.color || PKS_PALETTE.c, PKS_FIELD_X, PKS_FIELD_Y, PKS_COLS * PKS_CELL, PKS_LANES * PKS_CELL);
      break;
    case 'place':
      ctx.globalAlpha = fade;
      pksBlit(ctx, atlas, F, 'cursor', fx.x, fx.y);
      break;
    case 'armed':
      ctx.globalAlpha = Math.min(1, fade * 2);
      pksRect(ctx, PKS_PALETTE.k, fx.x - 1, fx.y - 1, PKS_ARM_W + 2, 4);
      pksRect(ctx, Math.floor(fx.age / 4) % 2 === 0 ? PKS_PALETTE.w : PKS_PALETTE.c, fx.x, fx.y, PKS_ARM_W, 2);
      break;
    case 'edge':
      if (Math.floor(fx.age / 10) % 2 === 0) {
        ctx.globalAlpha = Math.min(1, fade * 4);
        for (i = 0; i < PKS_LANES; i++) {
          if (sim.breakers[i] !== 'off') pksRect(ctx, fx.color, fx.x + 2, pksLaneY(i) + 6, 4, PKS_CELL - 12);
        }
      }
      break;
    default:
      pksDrawLateFx(ctx, atlas, fx, fade);
  }
  ctx.globalAlpha = 1;
}

// The expansion's effect kinds: decal, splash, trace, arc.
function pksDrawLateFx(ctx, atlas, fx, fade) {
  switch (fx.kind) {
    case 'decal':
      ctx.globalAlpha = Math.min(1, fade * 2);
      pksBlit(ctx, atlas, atlas.frames, fx.art, fx.x, fx.y);
      break;
    case 'splash':
      pksBlit(ctx, atlas, atlas.frames, PKS_SPLASH_ART[Math.floor(fx.age * 3 / fx.life)], fx.x, fx.y);
      break;
    case 'trace':
      ctx.globalAlpha = fade;
      pksRect(ctx, PKS_PALETTE.x, fx.x, fx.y, Math.max(1, fx.to - fx.x), 1);
      if (fx.age < 4) {
        pksRect(ctx, PKS_PALETTE.w, fx.x, fx.y - 1, Math.max(1, fx.to - fx.x), 1);
        pksBlit(ctx, atlas, atlas.frames, 'shot-heavy', fx.to - 6, fx.y - 4);
      }
      break;
    case 'arc':
      ctx.globalAlpha = Math.min(1, fade * 2);
      pksDrawArc(ctx, atlas, fx, Math.floor(fx.age / 2) % 2);
      break;
  }
}

// A Token Ring's bolt: from its muzzle to each point of its path in turn.
// Along a lane it runs flat at the lane's centre; to a point in another lane
// it turns there: fx-arc joins the centres of two lanes (one sprite per lane
// crossed), at the point's x going down, at the start's x going up.
function pksDrawArc(ctx, atlas, fx, phase) {
  var ax = fx.x;
  var al = fx.lane;
  for (var i = 0; i < fx.path.length; i++) {
    var bx = Math.round(pksUnitX(fx.path[i].x));
    var bl = fx.path[i].lane;
    var flat = bl > al ? al : bl;
    pksBolt(ctx, ax, bx, pksLaneY(flat) + 17, phase);
    var vx = bl > al ? bx : ax;
    for (var l = Math.min(al, bl); l < Math.max(al, bl); l++) {
      pksBlit(ctx, atlas, atlas.frames, PKS_ARC_ART[phase], vx - 16, pksLaneY(l) + 17);
    }
    ax = bx;
    al = bl;
  }
}

// A flat bolt between x0 and x1 at y: a white core with a periwinkle edge
// that zigzags a pixel every 4 px, flipping with the phase.
function pksBolt(ctx, x0, x1, y, phase) {
  var a = Math.min(x0, x1);
  var b = Math.max(x0, x1);
  for (var px = a, k = phase; px < b; px += 4, k++) {
    var w = Math.min(4, b - px);
    var dy = k % 2;
    pksRect(ctx, PKS_PALETTE.q, px, y - 1 + dy, w, 1);
    pksRect(ctx, PKS_PALETTE.w, px, y + dy, w, 1);
  }
}

// The cell cursor (unless the ghost sits on it), then the ghost: the card's
// sprite at reduced alpha with the cursor, or cursor-bad where it cannot go.
function pksDrawPointer(ctx, atlas, view) {
  var c = view.cursor;
  var g = view.ghost;
  if (c && !(g && g.lane === c.lane && g.col === c.col)) {
    pksBlit(ctx, atlas, atlas.frames, 'cursor', pksUnitX(c.col), pksLaneY(c.lane));
  }
  if (!g) return;
  var x = pksUnitX(g.col);
  var y = pksLaneY(g.lane);
  var name = pksIconName(g.card);
  if (name) {
    ctx.globalAlpha = g.ok ? 0.6 : 0.3;
    pksBlit(ctx, atlas, atlas.frames, name, x + 4, y + 6);
    ctx.globalAlpha = 1;
  }
  pksBlit(ctx, atlas, atlas.frames, g.ok ? 'cursor' : 'cursor-bad', x, y);
}
