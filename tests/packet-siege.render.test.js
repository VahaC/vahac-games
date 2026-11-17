// tests/packet-siege.render.test.js
// The page-side parts of Packet Siege below the UI: the sprite art and its
// atlas, the renderer (a recording canvas checks what each sim state draws,
// where, in which order, and that drawing never changes the sim), the view of
// passing effects, the canvas helpers, the zone rules of levels 51-150 on
// the field and the tinted boss tiers.  The save format is in
// packet-siege.storage.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, readRepoFile } = require('./_setup');

const GAME = 'packet-siege';
const pks = loadScript(GAME + '/script.js');
const BUILD = require('../' + GAME + '/build.js');

const C = pks.pksConstants;
const SPRITES = pks.pksSprites;
const PALETTE = pks.pksPalette;
const ALL = pks.pksDefenders.map((d) => d.id);
const laneY = (l) => 20 + 32 * l;
const cellX = (c) => 24 + 32 * c;

// ── the atlas on a pixel-recording canvas ──────────────────────────────────

// A canvas for pksBuildAtlas that keeps the colour of every pixel filled.
function pixelCanvas(w, h) {
  const px = new Array(w * h).fill(null);
  const ctx = {
    fillStyle: '#000000',
    fillRect(x, y, rw, rh) {
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
        assert.ok(x + i >= 0 && x + i < w && y + j >= 0 && y + j < h, 'fill inside the atlas');
        px[(y + j) * w + x + i] = this.fillStyle;
      }
    }
  };
  return { width: w, height: h, px, getContext: (kind) => (kind === '2d' ? ctx : null) };
}

const ATLAS = pks.pksBuildAtlas(pixelCanvas);

// ── the recording context ──────────────────────────────────────────────────

const AT = new Map();
for (const set of ['frames', 'flash', 'slow']) {
  for (const [name, f] of Object.entries(ATLAS[set])) AT.set(f.x + ',' + f.y, { set, name });
}
for (const [hue, frames] of Object.entries(ATLAS.tints)) {
  for (const [name, f] of Object.entries(frames)) AT.set(f.x + ',' + f.y, { set: 'tint' + hue, name });
}

// A 2D context that records drawImage (resolved to the atlas set and sprite
// name) and fillRect, each with the globalAlpha and fillStyle of the call.
// Any other method is missing on purpose: the renderer uses only these two.
function recorder() {
  const calls = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '#000000',
    imageSmoothingEnabled: true,
    drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
      assert.equal(img, ATLAS.canvas, 'draws from the atlas');
      const hit = AT.get(sx + ',' + sy);
      assert.ok(hit, 'a frame of the atlas at ' + sx + ',' + sy);
      assert.ok(Number.isInteger(dx) && Number.isInteger(dy), 'whole pixels: ' + hit.name + ' at ' + dx + ',' + dy);
      calls.push({ op: 'draw', name: hit.name, set: hit.set, sw, sh, dx, dy, dw, dh, alpha: this.globalAlpha });
    },
    fillRect(x, y, w, h) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y), 'whole pixels: rect at ' + x + ',' + y);
      calls.push({ op: 'rect', color: this.fillStyle, x, y, w, h, alpha: this.globalAlpha });
    }
  };
  return { ctx, calls };
}

function render(sim, view) {
  const r = recorder();
  pks.pksRender(r.ctx, ATLAS, sim, view || pks.pksNewView());
  assert.equal(r.ctx.imageSmoothingEnabled, false);
  assert.equal(r.ctx.globalAlpha, 1, 'alpha restored');
  return r.calls;
}

const draws = (calls, name) => calls.filter((c) => c.op === 'draw' && c.name === name);
const at = (calls, x, y) => calls.filter((c) => c.op === 'draw' && c.dx === x && c.dy === y);
const rects = (calls, color) => calls.filter((c) => c.op === 'rect' && c.color === color);

// ── sims ───────────────────────────────────────────────────────────────────

function level(over) {
  return Object.assign({
    n: 7, zone: 1, zoneName: 'Test', name: 'Test', lanes: [0, 1, 2, 3, 4], blocked: [], fog: 0,
    trickle: false, startCycles: 100000, slots: 15, speed: 1, boss: 0,
    spawns: [{ t: 9999, lane: 0, type: 'bot' }], surges: [], duration: 600, budget: 1,
    unlock: null, intro: null, hint: null
  }, over);
}

function newSim(over) {
  return pks.pksNewSim(level(over), ALL);
}

function put(sim, type, lane, col) {
  const card = sim.cards.find((c) => c.id === type);
  card.left = 0;
  const r = pks.pksPlace(sim, type, lane, col);
  assert.equal(r.ok, true, type + ': ' + r.reason);
  return sim.defenders.find((d) => d.id === r.id);
}

const spawn = (sim, type, lane, x, tier) => pks.pksSpawnEnemy(sim, type, lane, x, tier || 0);

// ── sprites ────────────────────────────────────────────────────────────────

const ART_PARTS = BUILD.PARTS.filter((p) => /^sprites-/.test(p));

function expectedSize(name) {
  if (/^enm-titan-/.test(name)) return [32, 32];
  if (/^(def|enm)-/.test(name) || ['icon-decom', 'fx-freeze', 'fx-shield', 'fx-shield-break', 'fx-jam'].includes(name)) return [24, 24];
  if (/^boss\d?-/.test(name) || /^fx-aura-/.test(name) || name === 'fx-shield-boss') return [48, 48];
  if (/^(tile-|fx-boom|fx-surge|fx-splash|fx-arc|fx-shimmer|cursor)/.test(name) || name === 'fog') return [32, 32];
  if (['fx-pull', 'fx-knock', 'fx-restore', 'fx-wipe', 'fx-blink', 'fx-dark', 'fx-outage'].includes(name)) return [32, 32];
  if (name === 'shot-heavy') return [12, 8];
  if (/^rack-/.test(name)) return [24, 32];
  if (/^backdrop-/.test(name)) return [32, 20];
  if (name === 'fog-edge') return [16, 32];
  if (name === 'beam') return [32, 8];
  if (/^breaker-/.test(name)) return [8, 10];
  if (/^(shot-|icon-)/.test(name) || name === 'fx-hit' || name === 'fx-heal') return [8, 8];
  return null;
}

// Every name the renderer, the cards and the codex can ask for, derived from
// the tables.
function neededNames() {
  const names = [];
  for (const d of pks.pksDefenders) {
    names.push('def-' + d.id + '-0', 'def-' + d.id + '-1');
    if (['shooter', 'pulse', 'beam', 'sniper', 'mortar', 'knock', 'arc', 'pull', 'backup', 'decrypt'].includes(d.kind)) names.push('def-' + d.id + '-fire');
  }
  for (const e of pks.pksEnemies.map((r) => r.id).concat(['replica2', 'replica3'])) {
    for (const p of ['walk0', 'walk1', 'bite0', 'bite1']) names.push('enm-' + e + '-' + p);
  }
  for (const b of ['boss', 'boss2', 'boss3']) for (const p of ['walk0', 'walk1', 'cast0', 'cast1']) names.push(b + '-' + p);
  for (let z = 1; z <= 15; z++) names.push('tile-z' + z + '-a', 'tile-z' + z + '-b', 'backdrop-z' + z);
  names.push('shot-heavy', 'shot-shell', 'shot-decrypt', 'fx-splash0', 'fx-splash1', 'fx-splash2', 'fx-arc0', 'fx-arc1',
    'fx-pull', 'fx-knock', 'fx-restore', 'fx-wipe', 'fx-blink', 'fx-shield', 'fx-shield-break', 'fx-shield-boss',
    'fx-aura-amp', 'fx-aura-heal', 'fx-jam');
  names.push('shot-drop', 'shot-tar', 'shot-phish', 'shot-boss', 'beam', 'fx-hit', 'fx-heal', 'fx-freeze',
    'fx-boom0', 'fx-boom1', 'fx-boom2', 'fx-boom3', 'fx-surge0', 'fx-surge1', 'fx-surge2',
    'tile-tray', 'fog', 'fog-edge', 'rack-ok', 'rack-hit', 'breaker-armed', 'breaker-tripped',
    'icon-cycles', 'icon-star', 'icon-star-off', 'icon-lock', 'icon-surge', 'icon-decom', 'cursor', 'cursor-bad');
  return names;
}

test('packet-siege: the palette has at most 48 #rrggbb colours under one-character keys, the 32 of levels 1-50 first and unchanged', () => {
  const keys = Object.keys(PALETTE);
  assert.ok(keys.length > 0 && keys.length <= 48);
  assert.equal(keys.length, 47);
  assert.equal(keys.slice(0, 32).join(''), 'kKaAlNnwcCBbGgdyYorRPpmMhHeEvVuU');
  assert.deepEqual([PALETTE.k, PALETTE.c, PALETTE.U], ['#05080f', '#22d3ee', '#2d1b4e']);
  assert.equal(keys.slice(32).join(''), 'sStxfjqQZIFXiTJ');
  for (const k of keys) {
    assert.equal(k.length, 1);
    assert.notEqual(k, '.');
    assert.match(PALETTE[k], /^#[0-9a-f]{6}$/);
  }
});

test('packet-siege: every sprite has its declared size, rows of that width and only palette characters', () => {
  const names = Object.keys(SPRITES);
  assert.equal(names.length, 137 + 156);
  for (const name of names) {
    const s = SPRITES[name];
    assert.deepEqual(Object.keys(s), ['w', 'h', 'rows'], name);
    const want = expectedSize(name);
    assert.ok(want, name + ' has a known size class');
    assert.deepEqual([s.w, s.h], want, name);
    assert.equal(s.rows.length, s.h, name);
    s.rows.forEach((row, i) => {
      assert.equal(row.length, s.w, name + ' row ' + i);
      for (const ch of row) assert.ok(ch === '.' || Object.prototype.hasOwnProperty.call(PALETTE, ch), name + ' row ' + i + ': ' + ch);
    });
    assert.ok(s.rows.some((row) => /[^.]/.test(row)), name + ' is not empty');
  }
});

test('packet-siege: every name the renderer, cards and codex ask for exists; the art parts hold disjoint names', () => {
  for (const name of neededNames()) assert.ok(SPRITES[name], name);
  for (const id of ALL.concat(pks.pksEnemies.map((e) => e.id), ['boss', pks.pksDecom])) {
    assert.ok(SPRITES[pks.pksIconName(id)], id);
  }
  let count = 0;
  for (const part of ART_PARTS) {
    const text = readRepoFile(GAME + '/src/' + part + '.js');
    count += (text.match(/^ {2}'[a-z0-9-]+': \{ w: /gm) || []).length;
    assert.ok(text.split('\n').length < 900, part);
  }
  assert.ok(ART_PARTS.length >= 13);
  assert.equal(count, Object.keys(SPRITES).length, 'no name defined twice');
});

test('packet-siege: the atlas holds every sprite pixel for pixel, white and blue copies of every unit, nothing overlapping', () => {
  const W = ATLAS.canvas.width;
  const H = ATLAS.canvas.height;
  const px = ATLAS.canvas.px;
  const units = Object.keys(SPRITES).filter((n) => /^(def|enm|boss\d?)-/.test(n));
  // one canvas, power-of-two sides: 1024x1024 holds the 293 sprites and the unit copies
  assert.deepEqual([W, H], [1024, 1024]);
  for (const b of ['boss2', 'boss3']) {
    for (const p of ['walk0', 'walk1', 'cast0', 'cast1']) assert.ok(ATLAS.flash[b + '-' + p] && ATLAS.slow[b + '-' + p], b + '-' + p);
  }
  assert.ok(ATLAS.slow['enm-titan-walk0'] && ATLAS.flash['enm-replica3-bite1'] && ATLAS.slow['def-honeynet-1']);
  assert.equal(ATLAS.flash['fx-shield-boss'], undefined, 'effects have no unit copies');
  assert.deepEqual(Object.keys(ATLAS.frames).sort(), Object.keys(SPRITES).sort());
  assert.deepEqual(Object.keys(ATLAS.flash).sort(), units.sort());
  assert.deepEqual(Object.keys(ATLAS.slow).sort(), units.sort());
  const owner = new Array(W * H).fill(null);
  const sets = [['frames', ATLAS.frames], ['flash', ATLAS.flash], ['slow', ATLAS.slow]];
  for (const [hue, frames] of Object.entries(ATLAS.tints)) sets.push(['tint' + hue, frames]);
  for (const [set, frames] of sets) {
    for (const [name, f] of Object.entries(frames)) {
      const s = SPRITES[name];
      assert.deepEqual([f.w, f.h], [s.w, s.h], set + '.' + name);
      assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= W && f.y + f.h <= H, set + '.' + name + ' inside the canvas');
      for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
        const k = (f.y + j) * W + f.x + i;
        assert.equal(owner[k], null, set + '.' + name + ' overlaps ' + owner[k]);
        owner[k] = set + '.' + name;
        const ch = s.rows[j][i];
        const got = px[k];
        if (ch === '.') assert.equal(got, null, set + '.' + name + ' ' + i + ',' + j);
        else if (set === 'frames') assert.equal(got, PALETTE[ch]);
        else if (set === 'flash') assert.equal(got, '#ffffff');
        else if (set === 'slow') assert.match(got, /^rgb\(\d+,\d+,\d+\)$/);
        else assert.equal(got, pks.pksHueShift(PALETTE[ch], Number(set.slice(4))), set + '.' + name);
      }
    }
  }
  // the slowed copy is blue: blue above red for every colour
  for (const name of units) {
    const f = ATLAS.slow[name];
    for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
      const v = px[(f.y + j) * W + f.x + i];
      if (!v) continue;
      const [r, , b] = v.slice(4, -1).split(',').map(Number);
      assert.ok(b > r && b <= 255, name + ' ' + v);
    }
  }
});

// ── render: the field ──────────────────────────────────────────────────────

test('packet-siege: each zone draws its backdrop across the strip and its floor in a checker of its two tiles', () => {
  for (const n of [1, 11, 21, 31, 41]) {
    const sim = pks.pksNewSim(n, []);
    const z = sim.level.zone;
    const calls = render(sim);
    assert.deepEqual(draws(calls, 'backdrop-z' + z).map((c) => [c.dx, c.dy]), Array.from({ length: 10 }, (_, i) => [i * 32, 0]));
    const trays = sim.level.blocked;
    for (let l = 0; l < 5; l++) {
      for (let c = 0; c < 9; c++) {
        const tray = trays.some((b) => b.lane === l && b.col === c);
        const name = tray ? 'tile-tray' : 'tile-z' + z + ((c + l) % 2 ? '-b' : '-a');
        assert.equal(at(calls, cellX(c), laneY(l))[0].name, name, 'L' + n + ' ' + l + ',' + c);
      }
    }
    for (let other = 1; other <= 5; other++) {
      if (other !== z) assert.equal(draws(calls, 'tile-z' + other + '-a').length, 0);
    }
    // the dark right margin
    assert.deepEqual(rects(calls, PALETTE.k).find((r) => r.x === 312), { op: 'rect', color: PALETTE.k, x: 312, y: 20, w: 8, h: 160, alpha: 1 });
  }
});

test('packet-siege: cable trays are drawn on the blocked cells of a DMZ level', () => {
  const sim = pks.pksNewSim(11, []);
  assert.ok(sim.level.blocked.length >= 2);
  const calls = render(sim);
  assert.deepEqual(draws(calls, 'tile-tray').map((c) => [c.dx, c.dy]).sort(),
    sim.level.blocked.map((b) => [cellX(b.col), laneY(b.lane)]).sort());
});

test('packet-siege: a rack per lane with its breaker; lanes not in play are closed: no breaker, dimmed with their floor', () => {
  const sim = pks.pksNewSim(1, []);
  sim.breakers[2] = 'armed';
  let calls = render(sim);
  assert.equal(draws(calls, 'rack-ok').length, 5);
  assert.deepEqual(draws(calls, 'breaker-armed').map((c) => [c.dx, c.dy]), [[13, laneY(2) + 11]]);
  const dim = calls.filter((c) => c.op === 'rect' && c.alpha === 0.65);
  assert.deepEqual(dim.map((r) => [r.x, r.y, r.w, r.h, r.color]), [0, 1, 3, 4].map((l) => [0, laneY(l), 312, 32, PALETTE.k]));
  // the closed lanes keep their floor tiles under the shade
  assert.equal(at(calls, cellX(0), laneY(0))[0].name, 'tile-z1-a');
  assert.ok(calls.indexOf(dim[0]) > calls.indexOf(at(calls, cellX(8), laneY(4))[0]), 'the shade goes over the floor');
  // a tripped lane shows its hit rack and tripped breaker
  const all = newSim();
  all.breakers[3] = 'tripped';
  calls = render(all);
  assert.deepEqual(at(calls, 0, laneY(3)).map((c) => c.name), ['rack-hit']);
  assert.deepEqual(draws(calls, 'breaker-tripped').map((c) => [c.dx, c.dy]), [[13, laneY(3) + 11]]);
  assert.equal(draws(calls, 'breaker-armed').length, 4);
  assert.equal(calls.filter((c) => c.alpha === 0.65).length, 0);
});

test('packet-siege: fog covers the right columns with its edge; enemies under it are hidden, shots and effects are not', () => {
  const sim = pks.pksNewSim(31, ALL);
  assert.equal(sim.level.fog, 3);
  const hidden = spawn(sim, 'bot', 1, 6.5);
  spawn(sim, 'worm', 2, 5.8);
  spawn(sim, 'boss', 3, 7, 4);
  sim.shots.push({ id: 900, kind: 'drop', lane: 1, x: 7.5, from: 2, dir: 1, dmg: 20, slow: 0, owner: 1, done: false });
  const view = pks.pksNewView();
  pks.pksViewEvents(view, { events: [{ type: 'hit', id: hidden.id, shot: 900, kind: 'drop', lane: 1, x: 7.5, dmg: 20 }] });
  const calls = render(sim, view);
  assert.equal(draws(calls, 'fog').length, 15);
  for (let l = 0; l < 5; l++) {
    for (let c = 6; c < 9; c++) assert.equal(at(calls, cellX(c), laneY(l)).filter((d) => d.name === 'fog').length, 1);
    assert.deepEqual(at(calls, cellX(6) - 16, laneY(l)).map((d) => d.name), ['fog-edge']);
  }
  assert.equal(draws(calls, 'enm-bot-walk0').length, 0, 'under the fog');
  assert.equal(draws(calls, 'boss-walk0').length, 0, 'the boss too');
  assert.equal(draws(calls, 'enm-worm-walk0').length, 1, 'left of the fog');
  assert.deepEqual(draws(calls, 'shot-drop').map((c) => [c.dx, c.dy]), [[24 + 240 - 4, laneY(1) + 13]]);
  assert.equal(draws(calls, 'fx-hit').length, 1);
  assert.ok(calls.indexOf(draws(calls, 'fog')[0]) < calls.indexOf(draws(calls, 'enm-worm-walk0')[0]), 'units over the haze');
});

test('packet-siege: the strip shows how far the spawns have come, a marker per surge, dim once passed, blinking orange while announced', () => {
  const sim = newSim({ spawns: [1, 2, 3, 4].map((t) => ({ t, lane: 0, type: 'bot' })), surges: [2.5, 3.5] });
  const bar = (calls) => calls.filter((c) => c.op === 'rect' && c.y === 7 && c.x === 150 && c.h === 5);
  let calls = render(sim);
  assert.deepEqual(rects(calls, PALETTE.k).find((r) => r.x === 149), { op: 'rect', color: PALETTE.k, x: 149, y: 6, w: 152, h: 7, alpha: 1 });
  assert.deepEqual(bar(calls).map((r) => [r.color, r.w]), [[PALETTE.A, 150], [PALETTE.G, 0]]);
  assert.deepEqual(draws(calls, 'icon-surge').map((c) => [c.dx, c.dy, c.alpha]), [[150 + 75 - 4, 6, 1], [150 + 113 - 4, 6, 1]]);
  sim.spawnIndex = 1;
  sim.warned = 1;
  calls = render(sim);
  assert.deepEqual(bar(calls).map((r) => [r.color, r.w]), [[PALETTE.A, 150], [PALETTE.o, 38]]);
  assert.equal(draws(calls, 'icon-surge').length, 2, 'blink on');
  sim.tick = 8;
  calls = render(sim);
  assert.deepEqual(draws(calls, 'icon-surge').map((c) => c.dx), [259], 'the announced marker blinks off');
  sim.surged = 1;
  sim.spawnIndex = 4;
  calls = render(sim);
  assert.deepEqual(bar(calls).map((r) => [r.color, r.w]), [[PALETTE.A, 150], [PALETTE.G, 150]]);
  assert.deepEqual(draws(calls, 'icon-surge').map((c) => [c.dx, c.alpha]), [[221, 0.35], [259, 1]]);
  // no spawns at all: an empty bar, no division by zero
  const empty = newSim({ spawns: [], surges: [] });
  assert.deepEqual(bar(render(empty)).map((r) => r.w), [150, 0]);
});

// ── render: defenders ──────────────────────────────────────────────────────

test('packet-siege: every defender: idle frames by anim, its firing frame while fire runs, the trap and fuse frames', () => {
  const x = cellX(3) + 4;
  const y = laneY(1) + 6;
  for (const def of pks.pksDefenders) {
    const sim = newSim();
    const d = put(sim, def.id, 1, 3);
    const frame = () => at(render(sim), x, y).map((c) => c.name);
    if (def.kind === 'trap') {
      assert.deepEqual(frame(), ['def-' + def.id + '-0'], 'arming');
      d.state = 'armed';
      assert.deepEqual(frame(), ['def-' + def.id + '-1'], 'armed');
      d.anim = 30;
      assert.deepEqual(frame(), ['def-' + def.id + '-1']);
      continue;
    }
    if (def.kind === 'instant') {
      assert.deepEqual(frame(), ['def-' + def.id + '-0']);
      d.anim = 6;
      assert.deepEqual(frame(), ['def-' + def.id + '-1'], 'the fuse blinks fast');
      d.anim = 12;
      assert.deepEqual(frame(), ['def-' + def.id + '-0']);
      continue;
    }
    assert.deepEqual(frame(), ['def-' + def.id + '-0']);
    d.anim = 29;
    assert.deepEqual(frame(), ['def-' + def.id + '-0']);
    d.anim = 30;
    assert.deepEqual(frame(), ['def-' + def.id + '-1']);
    d.fire = 1;
    const fire = SPRITES['def-' + def.id + '-fire'] ? 'def-' + def.id + '-fire' : 'def-' + def.id + '-1';
    assert.deepEqual(frame(), [fire], def.id + ' firing');
  }
});

test('packet-siege: a hit defender flashes white; encryption blinks blue; off is faint blue with a lock; damage shows a bar, repair a glint', () => {
  const sim = newSim();
  const d = put(sim, 'firewall', 2, 4);
  const x = cellX(4);
  const y = laneY(2);
  const unit = () => at(render(sim), x + 4, y + 6).map((c) => [c.set, c.alpha]);
  assert.deepEqual(unit(), [['frames', 1]]);
  d.flash = 3;
  assert.deepEqual(unit(), [['flash', 1]]);
  d.flash = 0;
  d.enc = 16;
  assert.deepEqual(unit(), [['slow', 1]], 'encrypting: blue');
  d.enc = 8;
  assert.deepEqual(unit(), [['frames', 1]], 'encrypting: blink');
  d.enc = 0;
  d.off = 100;
  d.state = 'off';
  let calls = render(sim);
  assert.deepEqual(at(calls, x + 4, y + 6).map((c) => [c.set, c.alpha]), [['slow', 0.55]]);
  assert.deepEqual(at(calls, x + 20, y + 4).map((c) => [c.name, c.alpha]), [['icon-lock', 1]]);
  d.off = 0;
  // no bar at full HP
  assert.equal(render(sim).filter((c) => c.op === 'rect' && c.y === y + 1).length, 0);
  for (const [hp, color, w] of [[240, PALETTE.G, 13], [150, PALETTE.y, 8], [60, PALETTE.r, 3], [1, PALETTE.r, 1]]) {
    d.hp = hp;
    calls = render(sim);
    const bar = calls.filter((c) => c.op === 'rect' && c.x >= x + 7 && c.y >= y + 1 && c.y <= y + 2);
    assert.deepEqual(bar.map((r) => [r.color, r.x, r.y, r.w, r.h]), [[PALETTE.k, x + 7, y + 1, 18, 4], [color, x + 8, y + 2, w, 2]], 'hp ' + hp);
  }
  assert.equal(draws(calls, 'fx-heal').length, 0);
  d.healed = sim.tick;
  sim.tick = 6;
  d.healed = 6;
  calls = render(sim);
  assert.deepEqual(draws(calls, 'fx-heal').map((c) => [c.dx, c.dy]), [[x + 22, y + 12 - 2]]);
  d.hp = d.maxHp;
  assert.equal(draws(render(sim), 'fx-heal').length, 0, 'nothing to repair');
});

// The arming bar of the traps: every rect in the cell's band dy 8..11.
const TRAPS = pks.pksDefenders.filter((d) => d.kind === 'trap');

function armBar(calls, lane, col) {
  const x = cellX(col);
  const y = laneY(lane);
  return calls.filter((c) => c.op === 'rect' && c.x >= x + 7 && c.x <= x + 8 && c.y >= y + 8 && c.y <= y + 9)
    .map((r) => [r.color, r.x - x, r.y - y, r.w, r.h]);
}

test('packet-siege: a trap still arming carries a cyan bar that fills over its arming time (from the table), gone once armed', () => {
  assert.ok(TRAPS.length > 0);
  for (const def of TRAPS) {
    const full = Math.round(def.arm * C.RATE);
    const sim = newSim();
    const d = put(sim, def.id, 2, 4);
    assert.equal(d.t, full, 'placed with the whole arming time to run');
    const bar = (w) => [[PALETTE.k, 7, 8, 18, 4], [PALETTE.C, 8, 9, 16, 2], [PALETTE.c, 8, 9, w, 2]];
    for (const [left, w] of [[full, 0], [Math.round(full * 3 / 4), 4], [full / 2, 8], [Math.round(full / 4), 12], [1, 16]]) {
      d.t = left;
      assert.deepEqual(armBar(render(sim), 2, 4), bar(w), def.id + ': ' + left + ' steps left');
    }
    // through the sim: the bar grows step by step, then the trap arms and the bar is gone
    d.t = full;
    let last = -1;
    for (let i = 0; i < full - 1; i++) {
      pks.pksStep(sim);
      const w = armBar(render(sim), 2, 4)[2][3];
      assert.ok(w >= last, 'never shrinks');
      last = w;
    }
    assert.equal(last, 16);
    pks.pksStep(sim);
    assert.equal(d.state, 'armed');
    assert.deepEqual(armBar(render(sim), 2, 4), [], 'armed: no bar');
    assert.equal(at(render(sim), cellX(4) + 4, laneY(2) + 6)[0].name, 'def-' + def.id + '-1');
  }
  // the source never writes the arming time: it reads the table's arm
  const src = readRepoFile('packet-siege/src/render-units.js').match(/function pksDrawArming[\s\S]*?\n\}/)[0];
  assert.match(src, /PKS_DEF\[d\.type\]\.arm/);
  assert.doesNotMatch(src, /\b12\b/);
});

test('packet-siege: the arming bar and the HP bar both show on a bitten trap, apart; the arming bar is drawn over the enemy eating it', () => {
  const def = TRAPS[0];
  const sim = newSim();
  const d = put(sim, def.id, 1, 3);
  d.t = Math.round(def.arm * C.RATE / 2);
  d.hp = d.maxHp / 2;
  spawn(sim, 'bot', 1, 3.9);
  const calls = render(sim);
  const x = cellX(3);
  const y = laneY(1);
  const hp = calls.filter((c) => c.op === 'rect' && c.y >= y + 1 && c.y <= y + 2 && c.x >= x + 7 && c.x <= x + 8);
  const arm = calls.filter((c) => c.op === 'rect' && c.y >= y + 8 && c.y <= y + 9 && c.x >= x + 7 && c.x <= x + 8);
  assert.equal(hp.length, 2, 'the HP bar');
  assert.equal(arm.length, 3, 'the arming bar');
  const box = (r) => [r.x, r.y, r.x + r.w, r.y + r.h];
  for (const a of arm) {
    for (const h of hp) {
      const [ax0, ay0, ax1, ay1] = box(a);
      const [hx0, hy0, hx1, hy1] = box(h);
      assert.ok(ax1 <= hx0 || hx1 <= ax0 || ay1 <= hy0 || hy1 <= ay0, 'no overlap');
    }
  }
  for (const r of arm) assert.ok(![PALETTE.G, PALETTE.y, PALETTE.r].includes(r.color), 'not an HP colour: ' + r.color);
  const enemy = calls.findIndex((c) => c.op === 'draw' && /^enm-bot-/.test(c.name));
  assert.ok(enemy >= 0 && calls.indexOf(arm[0]) > enemy, 'over the enemy');
  // a non-trap never has one
  const wall = newSim();
  put(wall, 'proxy', 1, 3);
  assert.deepEqual(armBar(render(wall), 1, 3), []);
});

test('packet-siege: a trap that arms flashes its full bar white and cyan, fading, over its cell', () => {
  const ev = { type: 'armed', id: 1, lane: 3, col: 6 };
  const x = cellX(6) + 8;
  const y = laneY(3) + 9;
  const bar = (age) => fxAt(ev, age).filter((c) => c.op === 'rect').map((r) => [r.color, r.x, r.y, r.w, r.h, r.alpha]);
  assert.deepEqual(bar(0), [[PALETTE.k, x - 1, y - 1, 18, 4, 1], [PALETTE.w, x, y, 16, 2, 1]]);
  assert.deepEqual(bar(4).map((r) => r[0]), [PALETTE.k, PALETTE.c], 'blinks');
  assert.deepEqual(bar(8).map((r) => r[0]), [PALETTE.k, PALETTE.w]);
  const late = bar(24);
  assert.ok(Math.abs(late[0][5] - 0.4) < 1e-9, 'fading');
  assert.deepEqual(fxAt(ev, 30).filter((c) => c.op === 'rect'), [], 'gone at the end of its life');
  assert.deepEqual(draws(fxAt(ev, 0), 'fx-hit').map((c) => [c.dx, c.dy]), [[cellX(6) + 20, laneY(3) + 6]], 'with its spark');
});

// ── render: enemies ────────────────────────────────────────────────────────

test('packet-siege: every enemy: walk frames by anim, bite frames while biting, throwing or casting, centred on its x', () => {
  for (const def of pks.pksEnemies) {
    const sim = newSim();
    const e = spawn(sim, def.id, 2, 5.3);
    // 24x24 at (cx-12, y+6); the 32x32 Kernel Panic at (cx-16, y-2): feet on the same line
    const size = SPRITES['enm-' + def.id + '-walk0'].w;
    assert.equal(size, def.id === 'titan' ? 32 : 24, def.id);
    const x = Math.round(24 + 5.3 * 32 - size / 2);
    const y = laneY(2) + 30 - size;
    e.shield = 0;   // the Payload's shield overlay has its own test
    const frame = () => at(render(sim), x, y).map((c) => c.name);
    assert.deepEqual(frame(), ['enm-' + def.id + '-walk0']);
    e.anim = 12;
    assert.deepEqual(frame(), ['enm-' + def.id + '-walk1']);
    for (const state of ['biting', 'throwing', 'casting']) {
      e.state = state;
      e.anim = 0;
      assert.deepEqual(frame(), ['enm-' + def.id + '-bite0'], state);
      e.anim = 13;
      assert.deepEqual(frame(), ['enm-' + def.id + '-bite1'], state);
    }
    e.state = 'leaping';
    e.leapTo = 5.3;
    assert.deepEqual(frame(), ['enm-' + def.id + '-walk1'], 'a leap shows the walk frames');
  }
});

test('packet-siege: an enemy flashes white when hit, turns blue when slowed, wears ice when frozen and is faint when cloaked', () => {
  const sim = newSim();
  const e = spawn(sim, 'kiddie', 3, 4);
  const x = 24 + 128 - 12;
  const y = laneY(3) + 6;
  const unit = () => at(render(sim), x, y).map((c) => [c.name, c.set, c.alpha]);
  assert.deepEqual(unit(), [['enm-kiddie-walk0', 'frames', 1]]);
  e.slow = 10;
  assert.deepEqual(unit(), [['enm-kiddie-walk0', 'slow', 1]]);
  e.flash = 2;
  assert.deepEqual(unit(), [['enm-kiddie-walk0', 'flash', 1]], 'the flash wins');
  e.flash = 0;
  e.slow = 0;
  e.frozen = 50;
  e.state = 'frozen';
  assert.deepEqual(unit(), [['enm-kiddie-walk0', 'frames', 1], ['fx-freeze', 'frames', 1]]);
  e.frozen = 0;
  e.cloaked = true;
  assert.deepEqual(unit(), [['enm-kiddie-walk0', 'frames', 0.35]]);
});

test('packet-siege: a lane change slides the enemy between its lanes; a leap arcs it over the defender', () => {
  const sim = newSim();
  const e = spawn(sim, 'polymorph', 3, 6);
  const x = 24 + 192 - 12;
  e.from = 2;
  e.shift = 30;
  assert.equal(draws(render(sim), 'enm-polymorph-walk0')[0].dy, laneY(2) + 6, 'starts on the old lane');
  e.shift = 15;
  assert.equal(draws(render(sim), 'enm-polymorph-walk0')[0].dy, laneY(3) + 6 - 16, 'half way');
  e.shift = 0;
  assert.deepEqual(draws(render(sim), 'enm-polymorph-walk0').map((c) => [c.dx, c.dy]), [[x, laneY(3) + 6]]);
  // a leap from contact (col 3) to a quarter cell left of the defender
  const ex = spawn(sim, 'exploit', 1, 4.2);
  ex.state = 'leaping';
  ex.leapTo = 2.75;
  const span = 0.5 + C.REACH + 0.25;
  for (const xx of [4.2, 3.6, 3.475, 3.0, 2.75]) {
    ex.x = xx;
    const t = (xx - 2.75) / span;
    const want = Math.round(laneY(1) + 6 - 14 * 4 * t * (1 - t));
    assert.equal(draws(render(sim), 'enm-exploit-walk0')[0].dy, want, 'x ' + xx);
  }
  ex.x = 3.475;
  assert.equal(draws(render(sim), 'enm-exploit-walk0')[0].dy, laneY(1) + 6 - 14, 'the top of the arc');
});

test('packet-siege: the boss: 48x48 walk and cast frames over its lane, white, blue, frozen, cloaked, and an HP bar', () => {
  const sim = newSim();
  const b = spawn(sim, 'boss', 2, 5, 3);
  const cx = 24 + 160;
  const top = laneY(2) - 16;
  const body = () => at(render(sim), cx - 24, top).map((c) => [c.name, c.set, c.alpha, c.sw]);
  assert.deepEqual(body(), [['boss-walk0', 'frames', 1, 48]]);
  b.anim = 12;
  assert.deepEqual(body(), [['boss-walk1', 'frames', 1, 48]]);
  b.cast = 10;
  assert.deepEqual(body(), [['boss-cast1', 'frames', 1, 48]]);
  b.anim = 0;
  assert.deepEqual(body(), [['boss-cast0', 'frames', 1, 48]]);
  b.cast = 0;
  b.state = 'biting';
  assert.deepEqual(body(), [['boss-walk0', 'frames', 1, 48]], 'the boss bites in its walk frames');
  b.flash = 1;
  assert.deepEqual(body(), [['boss-walk0', 'flash', 1, 48]]);
  b.flash = 0;
  b.slow = 5;
  assert.deepEqual(body(), [['boss-walk0', 'slow', 1, 48]]);
  b.slow = 0;
  b.cloaked = true;
  assert.deepEqual(body(), [['boss-walk0', 'frames', 0.35, 48]]);
  b.cloaked = false;
  b.frozen = 30;
  let calls = render(sim);
  assert.deepEqual(draws(calls, 'fx-freeze').map((c) => [c.dx, c.dy]), [[cx - 12, laneY(2) + 2]]);
  b.hp = b.maxHp * 0.75;
  calls = render(sim);
  const bar = calls.filter((c) => c.op === 'rect' && c.y >= top - 4 && c.y <= top - 3);
  assert.deepEqual(bar.map((r) => [r.color, r.x, r.y, r.w, r.h, r.alpha]), [
    [PALETTE.k, cx - 17, top - 4, 34, 4, 1], [PALETTE.G, cx - 16, top - 3, 24, 2, 1]
  ]);
});

// ── render: shots, beams, draw order ───────────────────────────────────────

test('packet-siege: every shot kind is drawn at its x on its lane; a Packet Inspector beams to the floor edge while firing', () => {
  const sim = newSim();
  const kinds = { drop: 'shot-drop', tar: 'shot-tar', phish: 'shot-phish', volley: 'shot-boss' };
  Object.keys(kinds).forEach((kind, i) => {
    sim.shots.push({ id: 800 + i, kind, lane: i, x: 2.3 + i, from: 2, dir: 1, dmg: 20, slow: 0, owner: 1, done: false });
  });
  let calls = render(sim);
  Object.keys(kinds).forEach((kind, i) => {
    assert.deepEqual(draws(calls, kinds[kind]).map((c) => [c.dx, c.dy]), [[Math.round(24 + (2.3 + i) * 32 - 4), laneY(i) + 13]], kind);
  });
  const d = put(sim, 'inspector', 4, 1);
  assert.equal(draws(render(sim), 'beam').length, 0, 'no beam while idle');
  d.fire = 15;
  calls = render(sim);
  const beam = draws(calls, 'beam');
  const x0 = cellX(1) + 28;
  assert.deepEqual(beam.map((c) => [c.dx, c.dy, c.sw, c.dw, c.alpha]), [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
    const w = Math.min(32, 312 - (x0 + k * 32));
    return [x0 + k * 32, laneY(4) + 11, w, w, 1];
  }));
  assert.equal(beam[beam.length - 1].dx + beam[beam.length - 1].sw, 312, 'clipped at the margin');
  d.fire = 4;
  assert.equal(draws(render(sim), 'beam')[0].alpha, 0.5, 'fading out');
});

test('packet-siege: draw order: strip, floor, then lane by lane defenders and enemies, the boss over its neighbours, beams, shots, effects, cursor', () => {
  const sim = newSim();
  put(sim, 'proxy', 0, 4);
  put(sim, 'firewall', 1, 2);
  const ins = put(sim, 'inspector', 2, 0);
  ins.fire = 10;
  spawn(sim, 'bot', 0, 5);
  spawn(sim, 'worm', 1, 6);
  const mover = spawn(sim, 'kiddie', 2, 6);
  mover.from = 1;
  mover.shift = 20;
  spawn(sim, 'boss', 1, 7, 1);
  sim.shots.push({ id: 900, kind: 'drop', lane: 1, x: 3, from: 2.7, dir: 1, dmg: 20, slow: 0, owner: 2, done: false });
  const view = pks.pksNewView();
  pks.pksViewEvents(view, { events: [{ type: 'kill', id: 5, enemy: 'bot', lane: 3, x: 4, by: 'shot' }] });
  view.cursor = { lane: 4, col: 4 };
  const calls = render(sim, view);
  const first = (name) => calls.findIndex((c) => c.name === name);
  const order = ['backdrop-z1', 'icon-surge', 'rack-ok', 'tile-z1-a', 'def-proxy-0', 'enm-bot-walk0', 'def-firewall-0',
    'enm-worm-walk0', 'enm-kiddie-walk0', 'def-inspector-fire', 'boss-walk0', 'beam', 'shot-drop', 'fx-boom2', 'cursor'];
  const seen = order.map(first).filter((i, k) => order[k] !== 'icon-surge');
  for (const i of seen) assert.ok(i >= 0);
  assert.deepEqual(seen.slice().sort((a, b) => a - b), seen, order.join(' < '));
  assert.equal(calls[calls.length - 1].name, 'cursor');
});

// ── the view and its effects ───────────────────────────────────────────────

test('packet-siege: a new view, ageing by step, and events read once however often the page asks', () => {
  const view = pks.pksNewView();
  assert.deepEqual(view, { cursor: null, ghost: null, fx: [], tick: 0, ring: 0, events: null, seen: 0 });
  const sim = newSim();
  put(sim, 'psu', 0, 0);
  pks.pksViewEvents(view, sim);
  pks.pksViewEvents(view, sim);
  assert.deepEqual(view.fx.map((f) => f.kind), ['place'], 'read once');
  put(sim, 'psu', 1, 0);
  pks.pksViewEvents(view, sim);
  assert.equal(view.fx.filter((f) => f.kind === 'place').length, 2, 'what pksPlace adds later is read too');
  for (let i = 0; i < 9; i++) pks.pksViewStep(view);
  assert.deepEqual(view.fx.map((f) => f.age), [9, 9]);
  assert.equal(view.tick, 9);
  pks.pksViewStep(view);
  pks.pksViewStep(view);
  assert.deepEqual(view.fx.map((f) => f.age), [10, 10], 'a finished effect stops ageing');
  pks.pksStep(sim);
  pks.pksViewEvents(view, sim);
  assert.equal(view.seen, sim.events.length, 'a new step starts a new batch');
  // finished effects are reused before the pool grows
  pks.pksViewEvents(view, { events: [{ type: 'placed', id: 1, def: 'psu', lane: 2, col: 0, cost: 50 }] });
  assert.equal(view.fx.length, 2);
  assert.deepEqual([view.fx[0].kind, view.fx[0].age, view.fx[0].y], ['place', 0, laneY(2)]);
});

test('packet-siege: the effect pool holds at most pksFxMax; past that the oldest slots are taken in turn', () => {
  const view = pks.pksNewView();
  const many = Array.from({ length: pks.pksFxMax + 3 }, (_, i) => ({ type: 'placed', id: i, def: 'psu', lane: i % 5, col: i % 9, cost: 50 }));
  pks.pksViewEvents(view, { events: many });
  assert.equal(view.fx.length, pks.pksFxMax);
  assert.equal(view.ring, 3);
  assert.deepEqual([view.fx[0].x, view.fx[0].y], [cellX((pks.pksFxMax) % 9), laneY(pks.pksFxMax % 5)]);
  assert.deepEqual([view.fx[3].x, view.fx[3].y], [cellX(3), laneY(3)], 'untouched');
});

// Every event type and the effects it starts: [kind, x, y, life, delay].
const FX_CASES = [
  [{ type: 'hit', id: 1, shot: 2, kind: 'drop', lane: 1, x: 5, dmg: 20 }, [['spark', 24 + 160 - 14, laneY(1) + 12, 6, 0]]],
  [{ type: 'hit', id: 1, shot: 2, kind: 'tar', lane: 1, x: 5, dmg: 20 }, [['spark', 24 + 160 - 14, laneY(1) + 12, 6, 0]]],
  [{ type: 'hit', id: 1, shot: 2, kind: 'phish', lane: 2, x: 3.5, dmg: 40 }, [['spark', 24 + 112 - 4, laneY(2) + 12, 6, 0]]],
  [{ type: 'hit', id: 1, shot: 2, kind: 'volley', lane: 2, x: 3.5, dmg: 60 }, [['spark', 24 + 112 - 4, laneY(2) + 12, 6, 0]]],
  [{ type: 'kill', id: 1, enemy: 'bot', lane: 3, x: 4, by: 'shot' }, [['puff', 24 + 128 - 16, laneY(3), 8, 0]]],
  [{ type: 'kill', id: 1, enemy: 'boss', lane: 3, x: 4, by: 'shot' }, [['boom', 24 + 128 - 16, laneY(3) - 8, 24, 0]]],
  [{ type: 'blast', id: 1, def: 'honeypot', lane: 2, col: 5 }, [['boom', cellX(5), laneY(2), 16, 0]]],
  [{ type: 'blast', id: 1, def: 'nullroute', lane: 0, col: 0 }, [
    ['boom', cellX(0), laneY(0), 16, 0], ['boom', cellX(1), laneY(0), 16, 2],
    ['boom', cellX(0), laneY(1), 16, 2], ['boom', cellX(1), laneY(1), 16, 0]]],
  [{ type: 'blast', id: 1, def: 'failover', lane: 4, col: 2 }, Array.from({ length: 9 }, (_, c) => ['boom', cellX(c), laneY(4), 16, c * 2])],
  [{ type: 'pulse', id: 1, def: 'limiter', lane: 2, col: 3 }, [['ring', 24 + 112, laneY(2) + 16, 12, 0]]],
  [{ type: 'freeze', id: 1, def: 'quarantine', lane: 2, col: 3 }, [['flash', 0, 0, 24, 0]]],
  [{ type: 'breaker', lane: 3 }, [['sweep', 0, laneY(3), 36, 0], ['rack', 0, laneY(3), 30, 0]]],
  [{ type: 'lose', lane: 1, id: 4, enemy: 'bot' }, [['rack', 0, laneY(1), 30, 0]]],
  [{ type: 'surgeWarn', index: 0, at: 40 }, [['edge', 312, 0, 180, 0]]],
  [{ type: 'surge', index: 0 }, [['edge', 312, 0, 60, 0]]],
  [{ type: 'produce', id: 1, lane: 2, col: 0, amount: 25 }, [['pip', cellX(0) + 6, laneY(2) + 4, 40, 0]]],
  [{ type: 'trickle', amount: 25 }, [['pip', 6, 10, 40, 0]]],
  [{ type: 'placed', id: 1, def: 'psu', lane: 1, col: 1, cost: 50 }, [['place', cellX(1), laneY(1), 10, 0]]],
  [{ type: 'removed', id: 1, def: 'psu', lane: 1, col: 1 }, [['puff', cellX(1), laneY(1), 8, 0]]],
  [{ type: 'destroyed', id: 1, def: 'psu', lane: 1, col: 1, why: 'eaten' }, [['puff', cellX(1), laneY(1), 8, 0]]],
  [{ type: 'destroyed', id: 1, def: 'waf', lane: 1, col: 1, why: 'crushed' }, [['puff', cellX(1), laneY(1), 8, 0]]],
  [{ type: 'destroyed', id: 1, def: 'firewall', lane: 1, col: 1, why: 'shot' }, [['puff', cellX(1), laneY(1), 8, 0]]],
  [{ type: 'destroyed', id: 1, def: 'nullroute', lane: 1, col: 1, why: 'spent' }, []],
  [{ type: 'armed', id: 1, lane: 0, col: 2 }, [['spark', cellX(2) + 20, laneY(0) + 6, 12, 0], ['armed', cellX(2) + 8, laneY(0) + 9, 30, 0]]],
  [{ type: 'cleared', id: 1, lane: 0, col: 2 }, [['glint', cellX(2) + 12, laneY(0) + 4, 24, 0]]],
  [{ type: 'cloak', id: 1, lane: 2, x: 6, on: true }, [['puff', 24 + 192 - 16, laneY(2), 8, 0]]],
  [{ type: 'cloak', id: 1, lane: 2, x: 6, on: false }, [['spark', 24 + 192 - 4, laneY(2) + 12, 10, 0]]],
  [{ type: 'morph', id: 1, from: 1, lane: 2, x: 5 }, [['puff', 24 + 160 - 16, laneY(1), 8, 0]]],
  [{ type: 'summon', id: 1, lane: 2, x: 6 }, [['puff', 24 + (6 + 0.6) * 32 - 16, laneY(2), 8, 0], ['puff', 24 + (6 + 0.6 + 0.5) * 32 - 16, laneY(2), 8, 3]]],
  [{ type: 'spawn', id: 1, enemy: 'bot', lane: 2, x: 9.6 }, []],
  [{ type: 'shot', id: 1, kind: 'drop', owner: 2, lane: 2, x: 1.7 }, []],
  [{ type: 'beam', id: 1, def: 'inspector', lane: 2, col: 1 }, []],
  [{ type: 'encrypt', id: 1, by: 2, lane: 2, col: 1 }, []],
  [{ type: 'disabled', id: 1, lane: 2, col: 1 }, []],
  [{ type: 'leap', id: 1, lane: 2, x: 3.2, to: 1.75 }, []],
  [{ type: 'win', stars: 3 }, []],
  [{ type: 'unlock', def: 'proxy' }, []]
];

// Every event type the sim parts can emit, read from their source: the
// `type` of each pksEmit(sim, { type: ... }) (every quoted name in it, so a
// conditional type counts both).
const SIM_PARTS = BUILD.PARTS.slice(0, BUILD.PARTS.indexOf('bosses') + 1);
function simEventTypes() {
  const types = new Set();
  for (const part of SIM_PARTS) {
    const src = readRepoFile(GAME + '/src/' + part + '.js');
    for (const m of src.matchAll(/pksEmit\(sim, \{ type: ([^,]+),/g)) {
      for (const q of m[1].matchAll(/'(\w+)'/g)) types.add(q[1]);
    }
  }
  return types;
}

// The event types render-fx starts an effect for (the cases of pksEventFx,
// pksLateEventFx and pksRuleEventFx).
function fxEventTypes() {
  const src = readRepoFile(GAME + '/src/render-fx.js');
  const types = new Set();
  for (const fn of ['pksEventFx', 'pksLateEventFx', 'pksRuleEventFx']) {
    const from = src.indexOf('\nfunction ' + fn + '(');
    const body = src.slice(from, src.indexOf('\n}\n', from));
    for (const m of body.matchAll(/case '(\w+)':/g)) types.add(m[1]);
  }
  return types;
}

// Events neither the page nor the view reacts to, each with why.
const IGNORED_EVENTS = {
  shot: 'the shot itself is drawn from sim.shots while it flies',
  beam: 'drawn from the Packet Inspector\'s firing state',
  encrypt: 'the defender blinks blue from its own state (enc)',
  disabled: 'drawn as off (faint blue with a lock) from its state',
  leap: 'the leap arc is drawn from the enemy\'s state',
  unlock: 'the result screen names unlocks from pksRecordWin',
  jam: 'the jam mark is drawn from d.jammed',
  lob: 'the shell is drawn from sim.shells while it flies',
  shimmer: 'the shimmer is drawn from sim.shimmers'
};

test('packet-siege: every event the sim parts can emit is handled by the page, starts an effect, or is ignored on purpose', () => {
  const emitted = simEventTypes();
  assert.ok(emitted.size > 50 && emitted.has('overtime') && emitted.has('pulse') && emitted.has('bossSplit'), [...emitted].join(' '));
  assert.ok(!emitted.has('boss'), 'spawn rows are not events');
  const page = new Set(Object.keys(pks.pksEventUi).concat(Object.keys(pks.pksRuleEventUi)));
  const fx = fxEventTypes();
  for (const t of emitted) {
    const handled = page.has(t) || fx.has(t);
    assert.ok(handled !== Object.prototype.hasOwnProperty.call(IGNORED_EVENTS, t),
      t + (handled ? ' is handled: take it off IGNORED_EVENTS' : ' is neither handled by the page nor drawn as an effect, nor in IGNORED_EVENTS'));
  }
  for (const t of Object.keys(IGNORED_EVENTS).concat([...page], [...fx])) assert.ok(emitted.has(t), t + ' is an event the sim emits');
  // the effect cases below cover every event of levels 1-50 and its fx
  const types = new Set(FX_CASES.map((c) => c[0].type));
  for (const t of ['spawn', 'shot', 'hit', 'kill', 'placed', 'removed', 'destroyed', 'produce', 'trickle', 'armed', 'pulse', 'beam',
    'blast', 'freeze', 'encrypt', 'disabled', 'cleared', 'leap', 'morph', 'summon', 'cloak', 'surgeWarn', 'surge', 'breaker', 'lose', 'win', 'unlock']) {
    assert.ok(types.has(t), t + ' is covered');
  }
});

test('packet-siege: every sim event starts its effect at the right place (or none)', () => {
  for (const [ev, want] of FX_CASES) {
    const view = pks.pksNewView();
    pks.pksViewEvents(view, { events: [ev] });
    assert.deepEqual(view.fx.map((f) => [f.kind, f.x, f.y, f.life, 0 - f.age]), want, JSON.stringify(ev));
  }
  const pip = pks.pksNewView();
  pks.pksViewEvents(pip, { events: [{ type: 'produce', id: 1, lane: 2, col: 0, amount: 50 }, { type: 'surgeWarn', index: 0, at: 9 }, { type: 'surge', index: 0 }] });
  assert.deepEqual(pip.fx.map((f) => [f.text, f.color]), [['+50', ''], ['', PALETTE.o], ['', PALETTE.r]]);
  const sweep = pks.pksNewView();
  pks.pksViewEvents(sweep, { events: [{ type: 'breaker', lane: 4 }] });
  assert.equal(sweep.fx[0].lane, 4);
});

// The calls one effect adds at a given age (effects are drawn after
// everything of the sim, so they are the tail of the frame).
function fxAt(ev, age, sim) {
  const s = sim || newSim();
  const view = pks.pksNewView();
  pks.pksViewEvents(view, { events: [ev] });
  for (let i = 0; i < age; i++) pks.pksViewStep(view);
  const base = render(s);
  const calls = render(s, view);
  assert.deepEqual(calls.slice(0, base.length), base);
  return calls.slice(base.length);
}

test('packet-siege: effects animate over their life and vanish: booms, puffs, sparks, glints, pips, rings, flashes, place marks', () => {
  const boom = { type: 'blast', id: 1, def: 'honeypot', lane: 2, col: 5 };
  assert.deepEqual([0, 3, 4, 8, 12, 15].map((a) => fxAt(boom, a).map((c) => c.name)), [['fx-boom0'], ['fx-boom0'], ['fx-boom1'], ['fx-boom2'], ['fx-boom3'], ['fx-boom3']]);
  assert.deepEqual(fxAt(boom, 16), [], 'gone at the end of its life');
  const failover = { type: 'blast', id: 1, def: 'failover', lane: 0, col: 3 };
  assert.deepEqual(fxAt(failover, 0).map((c) => c.dx), [cellX(0)], 'a delayed boom waits its turn');
  assert.deepEqual(fxAt(failover, 2).map((c) => c.dx), [cellX(0), cellX(1)]);
  const kill = { type: 'kill', id: 1, enemy: 'bot', lane: 3, x: 4, by: 'shot' };
  assert.deepEqual(fxAt(kill, 0).map((c) => [c.name, c.alpha, c.dx, c.dy]), [['fx-boom2', 0.7, 24 + 128 - 16, laneY(3)]]);
  assert.deepEqual(fxAt(kill, 4).map((c) => c.name), ['fx-boom3']);
  const hit = { type: 'hit', id: 1, shot: 2, kind: 'drop', lane: 1, x: 5, dmg: 20 };
  assert.deepEqual(fxAt(hit, 5).map((c) => [c.name, c.dx, c.dy]), [['fx-hit', 24 + 160 - 14, laneY(1) + 12]]);
  const glint = { type: 'cleared', id: 1, lane: 0, col: 2 };
  assert.deepEqual(fxAt(glint, 12).map((c) => [c.name, c.dy, c.alpha]), [['fx-heal', laneY(0) + 4 - 4, 0.5]]);
  const place = { type: 'placed', id: 1, def: 'psu', lane: 4, col: 4, cost: 50 };
  assert.deepEqual(fxAt(place, 5).map((c) => [c.name, c.dx, c.dy, c.alpha]), [['cursor', cellX(4), laneY(4), 0.5]]);
  const ring = fxAt({ type: 'pulse', id: 1, def: 'limiter', lane: 2, col: 3 }, 6);
  const cx = 24 + 112;
  const cy = laneY(2) + 16;
  assert.deepEqual(ring.map((r) => [r.color, r.x, r.y, r.w, r.h, r.alpha]), [
    [PALETTE.c, cx - 32, cy - 32, 64, 1, 0.5], [PALETTE.c, cx - 32, cy + 31, 64, 1, 0.5],
    [PALETTE.c, cx - 32, cy - 32, 1, 64, 0.5], [PALETTE.c, cx + 31, cy - 32, 1, 64, 0.5]
  ]);
  const flash = fxAt({ type: 'freeze', id: 1, def: 'quarantine', lane: 2, col: 3 }, 12);
  assert.deepEqual(flash.map((r) => [r.color, r.x, r.y, r.w, r.h, r.alpha]), [[PALETTE.c, 24, 20, 288, 160, 0.2]]);
});

test('packet-siege: a "+25" pip rises with the cycles icon and its digits in yellow on a dark shadow', () => {
  const calls = fxAt({ type: 'produce', id: 1, lane: 1, col: 2, amount: 25 }, 8);
  const x = cellX(2) + 6;
  const y = laneY(1) + 4 - 2;
  assert.deepEqual(draws(calls, 'icon-cycles').map((c) => [c.dx, c.dy, c.alpha]), [[x, y, 1]]);
  const dark = calls.filter((c) => c.op === 'rect' && c.color === PALETTE.k);
  const lit = calls.filter((c) => c.op === 'rect' && c.color === PALETTE.y);
  assert.equal(lit.length, 5 + 11 + 11, 'the pixels of + 2 5');
  assert.equal(dark.length, lit.length);
  for (const p of lit.concat(dark)) assert.deepEqual([p.w, p.h], [1, 1]);
  assert.deepEqual(lit.slice(0, 2).map((p) => [p.x, p.y]), [[x + 10 + 1, y + 2 + 1], [x + 10, y + 2 + 2]], 'the + of the text');
  assert.deepEqual([dark[0].x, dark[0].y], [x + 10 + 2, y + 2 + 2], 'the shadow sits one pixel down and right');
  assert.ok(Math.abs(fxAt({ type: 'produce', id: 1, lane: 1, col: 2, amount: 25 }, 36)[0].alpha - 0.3) < 1e-9, 'fading at the end');
});

test('packet-siege: a tripped breaker sweeps a surge along its lane and blinks the rack; surge warnings flash the right edge of lanes in play', () => {
  const ev = { type: 'breaker', lane: 2 };
  const surge = (calls) => calls.filter((c) => /^fx-surge/.test(c.name || ''));
  const blink = (calls) => calls.filter((c) => c.op === 'rect' && c.color === PALETTE.w);
  let calls = fxAt(ev, 0);
  assert.deepEqual(surge(calls).map((c) => [c.name, c.dx, c.dy, c.alpha]), [['fx-surge0', cellX(0), laneY(2), 1]]);
  assert.deepEqual(blink(calls).map((r) => [r.x, r.y, r.w, r.h, r.alpha]), [[0, laneY(2), 24, 32, 0.6]]);
  calls = fxAt(ev, 5);
  assert.deepEqual(surge(calls).map((c) => c.name), ['fx-surge2', 'fx-surge0', 'fx-surge1']);
  assert.equal(blink(calls).length, 0, 'the rack blinks');
  calls = fxAt(ev, 27);
  assert.equal(surge(calls).length, 9, 'the whole lane');
  assert.equal(surge(calls)[0].alpha, 0.5, 'fading');
  assert.equal(fxAt(ev, 36).length, 0);
  // warnings: the margin of every lane in play
  const one = pks.pksNewSim(1, []);
  const warn = { type: 'surgeWarn', index: 0, at: 40 };
  calls = fxAt(warn, 0, one);
  assert.deepEqual(calls.map((r) => [r.color, r.x, r.y, r.w, r.h, r.alpha]), [[PALETTE.o, 314, laneY(2) + 6, 4, 20, 1]]);
  assert.equal(fxAt(warn, 10, one).length, 0, 'blinking');
  assert.equal(fxAt(warn, 20, newSim()).length, 5);
  assert.deepEqual(fxAt({ type: 'surge', index: 0 }, 49, one).map((r) => [r.color, r.alpha]), [[PALETTE.r, Math.min(1, (1 - 49 / 60) * 4)]]);
});

// ── cursor and ghost ───────────────────────────────────────────────────────

test('packet-siege: the cell cursor; the ghost of the card at reduced alpha with cursor or cursor-bad; the Decommission ghost', () => {
  const sim = newSim();
  const view = pks.pksNewView();
  const base = render(sim).length;
  const tail = () => render(sim, view).slice(base).map((c) => [c.name, c.dx, c.dy, c.alpha]);
  assert.deepEqual(tail(), [], 'nothing by default');
  view.cursor = { lane: 1, col: 2 };
  assert.deepEqual(tail(), [['cursor', cellX(2), laneY(1), 1]]);
  view.ghost = { card: 'firewall', lane: 1, col: 2, ok: true };
  assert.deepEqual(tail(), [['def-firewall-0', cellX(2) + 4, laneY(1) + 6, 0.6], ['cursor', cellX(2), laneY(1), 1]], 'one cursor where both are');
  view.ghost = { card: 'proxy', lane: 3, col: 7, ok: false };
  assert.deepEqual(tail(), [['cursor', cellX(2), laneY(1), 1], ['def-proxy-0', cellX(7) + 4, laneY(3) + 6, 0.3], ['cursor-bad', cellX(7), laneY(3), 1]]);
  view.cursor = null;
  view.ghost = { card: pks.pksDecom, lane: 0, col: 0, ok: true };
  assert.deepEqual(tail(), [['icon-decom', cellX(0) + 4, laneY(0) + 6, 0.6], ['cursor', cellX(0), laneY(0), 1]]);
  view.ghost = { card: 'nonsense', lane: 0, col: 1, ok: false };
  const calls = render(sim, view);
  assert.deepEqual(calls.slice(-1).map((c) => [c.name, c.dx]), [['cursor-bad', cellX(1)]], 'an unknown card shows only the refusal');
  assert.equal(calls.filter((c) => c.alpha === 0.3).length, 0);
});

// ── helpers ────────────────────────────────────────────────────────────────

test('packet-siege: canvas point to cell and back, icon names', () => {
  assert.deepEqual(pks.pksCellAt(24, 20), { lane: 0, col: 0 });
  assert.deepEqual(pks.pksCellAt(311.9, 179.9), { lane: 4, col: 8 });
  assert.deepEqual(pks.pksCellAt(24 + 32 * 3 + 5, 20 + 32 * 2 + 31), { lane: 2, col: 3 });
  for (const [x, y] of [[23.9, 50], [312, 50], [100, 19.9], [100, 180], [-5, -5], [NaN, 50], [50, NaN], [Infinity, 50]]) {
    assert.equal(pks.pksCellAt(x, y), null, x + ',' + y);
  }
  for (let l = 0; l < 5; l++) {
    for (let c = 0; c < 9; c++) {
      const r = pks.pksCellRect(l, c);
      assert.deepEqual(r, { x: cellX(c), y: laneY(l), w: 32, h: 32 });
      assert.deepEqual(pks.pksCellAt(r.x + 16, r.y + 16), { lane: l, col: c });
    }
  }
  assert.equal(pks.pksIconName('ids'), 'def-ids-0');
  assert.equal(pks.pksIconName('worm'), 'enm-worm-walk0');
  assert.equal(pks.pksIconName('boss'), 'boss-walk0');
  assert.equal(pks.pksIconName(pks.pksDecom), 'icon-decom');
  for (const bad of ['nope', 'constructor', '__proto__', 'toString', undefined]) assert.equal(pks.pksIconName(bad), null, String(bad));
});

test('packet-siege: pksDrawIcon paints a sprite at a scale on any context; an unknown name draws nothing', () => {
  const r = recorder();
  assert.equal(pks.pksDrawIcon(r.ctx, ATLAS, 'def-scanner-0', 2.4, 3.6, 2), true);
  assert.equal(r.ctx.imageSmoothingEnabled, false);
  assert.deepEqual(r.calls.map((c) => [c.name, c.dx, c.dy, c.sw, c.dw, c.dh]), [['def-scanner-0', 2, 4, 24, 48, 48]]);
  pks.pksDrawIcon(r.ctx, ATLAS, 'icon-star', 0, 0, 1.5);
  assert.deepEqual([r.calls[1].dw, r.calls[1].dh], [12, 12]);
  assert.equal(pks.pksDrawIcon(r.ctx, ATLAS, 'nope', 0, 0, 1), false);
  assert.equal(pks.pksDrawIcon(r.ctx, ATLAS, 'constructor', 0, 0, 1), false);
  assert.equal(r.calls.length, 2);
});

// ── the expansion (levels 51-150): units, states, projectiles ──────────────

const SLIDE = Math.round(C.SLIDE_TIME * C.RATE);
const ex = (x) => 24 + x * 32;   // an enemy's centre x in px

test('packet-siege: zones 6-15 draw their own backdrop and floor checker; a zone without art falls back to zone 1', () => {
  for (let z = 6; z <= 15; z++) {
    const calls = render(newSim({ zone: z }));
    assert.equal(draws(calls, 'backdrop-z' + z).length, 10, 'zone ' + z);
    assert.equal(at(calls, cellX(0), laneY(0))[0].name, 'tile-z' + z + '-a');
    assert.equal(at(calls, cellX(1), laneY(0))[0].name, 'tile-z' + z + '-b');
  }
  const none = render(newSim({ zone: 16 }));
  assert.equal(draws(none, 'backdrop-z1').length, 10);
  assert.equal(at(none, cellX(0), laneY(0))[0].name, 'tile-z1-a');
});

test('packet-siege: a jammed shooter wears the jam mark, a boosted one a lime chevron; neither while it is off', () => {
  const sim = newSim();
  const d = put(sim, 'tracer', 1, 3);
  const x = cellX(3);
  const y = laneY(1);
  const lime = (calls) => rects(calls, PALETTE.s).map((r) => [r.x, r.y, r.w, r.h]);
  let calls = render(sim);
  assert.equal(draws(calls, 'fx-jam').length, 0);
  assert.deepEqual(lime(calls), []);
  d.jammed = true;
  calls = render(sim);
  assert.deepEqual(draws(calls, 'fx-jam').map((c) => [c.dx, c.dy]), [[x + 4, y + 6]]);
  assert.ok(calls.indexOf(draws(calls, 'fx-jam')[0]) > calls.indexOf(at(calls, x + 4, y + 6)[0]), 'over the defender');
  d.jammed = false;
  d.boosted = true;
  assert.deepEqual(lime(render(sim)), [[x + 27, y + 3, 1, 1], [x + 26, y + 4, 3, 1]]);
  d.jammed = true;
  d.off = 50;
  calls = render(sim);
  assert.deepEqual([draws(calls, 'fx-jam').length, lime(calls).length, draws(calls, 'icon-lock').length], [0, 0, 1]);
});

test('packet-siege: a Honeynet re-arming after it went off carries the arming bar over its rearm time, in the sim too', () => {
  const def = pks.pksDefender.honeynet;
  const arm = Math.round(def.arm * C.RATE);
  const rearm = Math.round(def.rearm * C.RATE);
  const sim = newSim();
  const d = put(sim, 'honeynet', 2, 4);
  const width = () => (armBar(render(sim), 2, 4)[2] || [])[3];
  // re-arming: anim + t reach arm + rearm
  d.anim = arm + 40;
  d.t = rearm;
  assert.equal(width(), 0);
  d.t = rearm / 2;
  d.anim = arm + 40 + rearm / 2;
  assert.equal(width(), 8);
  // first arming, even after time switched off (anim + t below arm + rearm): over arm
  d.anim = 300;
  d.t = arm / 2;
  assert.equal(width(), 8);
  // through the sim: armed, a Bot sets it off, the bar fills over the rearm time, then it arms again
  d.anim = arm;
  d.t = 0;
  d.state = 'armed';
  spawn(sim, 'bot', 2, 4.9);
  let blew = false;
  for (let i = 0; i < 120 && !blew; i++) {
    pks.pksStep(sim);
    blew = sim.events.some((e) => e.type === 'blast');
  }
  assert.ok(blew, 'it went off');
  assert.equal(d.state, 'arming');
  assert.equal(width(), 0);
  let last = 0;
  while (d.t > 1) {
    pks.pksStep(sim);
    const w = width();
    assert.ok(w >= last, 'never shrinks');
    last = w;
  }
  assert.equal(last, 16);
  pks.pksStep(sim);
  assert.equal(d.state, 'armed');
  assert.deepEqual(armBar(render(sim), 2, 4), []);
});

test('packet-siege: the Replicator draws its generation: replicator, replica2, replica3 frames', () => {
  const sim = newSim();
  const e = spawn(sim, 'replicator', 1, 4);
  const frame = () => at(render(sim), ex(4) - 12, laneY(1) + 6).map((c) => c.name);
  assert.equal(e.gen, 1);
  assert.deepEqual(frame(), ['enm-replicator-walk0']);
  e.gen = 2;
  assert.deepEqual(frame(), ['enm-replica2-walk0']);
  e.anim = 12;
  e.state = 'biting';
  assert.deepEqual(frame(), ['enm-replica2-bite1']);
  e.gen = 3;
  assert.deepEqual(frame(), ['enm-replica3-bite1']);
  e.state = 'walking';
  e.slow = 5;
  assert.deepEqual(at(render(sim), ex(4) - 12, laneY(1) + 6).map((c) => [c.name, c.set]), [['enm-replica3-walk1', 'slow']]);
});

test('packet-siege: a shield shows its overlay and a periwinkle shield bar (not an HP bar) while it holds; the boss\'s sits above its HP bar', () => {
  const sim = newSim();
  const e = spawn(sim, 'payload', 3, 5);
  const cx = ex(5);
  const y = laneY(3);
  const bar = (calls) => calls.filter((c) => c.op === 'rect' && c.y >= y + 1 && c.y <= y + 2).map((r) => [r.color, r.x, r.y, r.w, r.h]);
  assert.equal(e.shield, 600);
  let calls = render(sim);
  assert.deepEqual(at(calls, cx - 12, y + 6).map((c) => c.name), ['enm-payload-walk0', 'fx-shield']);
  assert.deepEqual(bar(calls), [[PALETTE.k, cx - 9, y + 1, 18, 4], [PALETTE.Q, cx - 8, y + 2, 16, 2], [PALETTE.q, cx - 8, y + 2, 16, 2]]);
  e.shield = 150;
  e.flash = 2;
  calls = render(sim);
  assert.deepEqual(at(calls, cx - 12, y + 6).map((c) => [c.name, c.set]), [['enm-payload-walk0', 'flash'], ['fx-shield', 'frames']]);
  assert.deepEqual(bar(calls)[2], [PALETTE.q, cx - 8, y + 2, 4, 2]);
  for (const r of bar(calls)) assert.ok(![PALETTE.G, PALETTE.y, PALETTE.r].includes(r[0]), 'not an HP colour');
  e.shield = 1;
  assert.equal(bar(render(sim))[2][3], 1, 'a sliver stays visible');
  e.shield = 0;
  calls = render(sim);
  assert.deepEqual(at(calls, cx - 12, y + 6).map((c) => c.name), ['enm-payload-walk0']);
  assert.deepEqual(bar(calls), [], 'no bar once broken');
  // a boss with a shield (later tiers): its overlay and a bar above the HP bar, apart
  const b = spawn(sim, 'boss', 1, 6, 2);
  b.shield = 300;
  b.maxShield = 600;
  b.hp = b.maxHp / 2;
  calls = render(sim);
  const bx = ex(6);
  const top = laneY(1) - 16;
  assert.deepEqual(at(calls, bx - 24, top).map((c) => c.name), ['boss-walk0', 'fx-shield-boss']);
  const bossBars = calls.filter((c) => c.op === 'rect' && c.x >= bx - 17 && c.x <= bx - 16 && c.y < top);
  assert.deepEqual(bossBars.map((r) => [r.color, r.x, r.y, r.w, r.h]), [
    [PALETTE.k, bx - 17, top - 4, 34, 4], [PALETTE.y, bx - 16, top - 3, 16, 2],
    [PALETTE.k, bx - 17, top - 9, 34, 4], [PALETTE.Q, bx - 16, top - 8, 32, 2], [PALETTE.q, bx - 16, top - 8, 16, 2]
  ]);
});

test('packet-siege: Amplifier and Hydra auras are drawn faint under every unit, centred on them; none for a Jammer, off the floor or under fog', () => {
  const sim = newSim();
  put(sim, 'proxy', 0, 0);
  const amp = spawn(sim, 'amplifier', 2, 5);
  const hy = spawn(sim, 'hydra', 3, 3.5);
  const jam = spawn(sim, 'jammer', 1, 4);
  spawn(sim, 'bot', 2, 5.6);
  amp.aura = 1.5;
  hy.aura = 1.5;
  jam.aura = 2;
  let calls = render(sim);
  const auras = calls.filter((c) => /^fx-aura-/.test(c.name || ''));
  assert.deepEqual(auras.map((c) => [c.name, c.dx, c.dy, c.alpha]), [
    ['fx-aura-amp', ex(5) - 24, laneY(2) - 6, 0.4], ['fx-aura-heal', Math.round(ex(3.5) - 24), laneY(3) - 6, 0.4]
  ]);
  const firstUnit = calls.findIndex((c) => /^(def|enm)-/.test(c.name || ''));
  const lastFloor = calls.map((c) => /^tile-/.test(c.name || '')).lastIndexOf(true);
  for (const a of auras) assert.ok(calls.indexOf(a) > lastFloor && calls.indexOf(a) < firstUnit, 'between the floor and the units');
  amp.aura = 0;
  assert.equal(draws(render(sim), 'fx-aura-amp').length, 0, 'aura 0: frozen or off the floor');
  // under the fog: hidden with its enemy
  const fog = newSim({ fog: 3 });
  const far = spawn(fog, 'hydra', 2, 7);
  far.aura = 1.5;
  assert.equal(draws(render(fog), 'fx-aura-heal').length, 0);
  far.x = 5.5;
  assert.equal(draws(render(fog), 'fx-aura-heal').length, 1);
});

test('packet-siege: an amped enemy wears a small orange chevron, a mended one an aqua plus the step a Hydra healed it', () => {
  const sim = newSim();
  const e = spawn(sim, 'bot', 2, 4);
  const cx = ex(4);
  const y = laneY(2);
  const orange = (calls) => rects(calls, PALETTE.o).map((r) => [r.x, r.y, r.w, r.h]);
  const aqua = (calls) => rects(calls, PALETTE.t).map((r) => [r.x, r.y, r.w, r.h]);
  assert.deepEqual([orange(render(sim)), aqua(render(sim))], [[], []]);
  e.amped = true;
  assert.deepEqual(orange(render(sim)), [[cx + 10, y + 3, 1, 1], [cx + 9, y + 4, 3, 1]]);
  e.amped = false;
  sim.tick = 8;
  e.mended = 7;
  assert.deepEqual(aqua(render(sim)), [], 'healed a step ago');
  e.mended = 8;
  assert.deepEqual(aqua(render(sim)), [[cx - 12, y + 7, 3, 1], [cx - 11, y + 6, 1, 3]], 'rising: 2 px at tick 8');
  const b = spawn(sim, 'boss', 0, 6, 1);
  b.amped = true;
  assert.deepEqual(orange(render(sim)), [[ex(6) + 19, laneY(0) - 21, 1, 1], [ex(6) + 18, laneY(0) - 20, 3, 1]]);
});

test('packet-siege: the Kernel Panic: 32x32 on the feet line, behind the small enemies of its lane, over its defenders, under the next lane and the boss', () => {
  const sim = newSim();
  put(sim, 'proxy', 2, 3);
  const bot = spawn(sim, 'bot', 2, 5.1);
  const t = spawn(sim, 'titan', 2, 4.4);
  spawn(sim, 'kiddie', 3, 4.5);
  spawn(sim, 'boss', 1, 5, 1);
  t.state = 'biting';
  let calls = render(sim);
  const idx = (name) => calls.findIndex((c) => c.name === name);
  const tx = Math.round(ex(4.4) - 16);
  assert.deepEqual(draws(calls, 'enm-titan-bite0').map((c) => [c.dx, c.dy, c.sw, c.sh]), [[tx, laneY(2) - 2, 32, 32]]);
  assert.ok(idx('def-proxy-0') < idx('enm-titan-bite0'), 'over its lane\'s defender');
  assert.ok(idx('enm-titan-bite0') < idx('enm-bot-walk0'), 'behind the Bot spawned before it');
  assert.ok(idx('enm-bot-walk0') < idx('enm-kiddie-walk0'), 'the next lane over it');
  assert.ok(idx('enm-kiddie-walk0') < idx('boss-walk0'), 'the boss over all');
  assert.equal(bot.tier, 0);
  t.frozen = 10;
  t.flash = 1;
  calls = render(sim);
  assert.deepEqual(draws(calls, 'enm-titan-bite0').map((c) => c.set), ['flash']);
  assert.deepEqual(draws(calls, 'fx-freeze').map((c) => [c.dx, c.dy]), [[Math.round(ex(4.4) - 12), laneY(2) + 6]]);
  // the kill of a Kernel Panic booms like the boss's
  const view = pks.pksNewView();
  pks.pksViewEvents(view, { events: [{ type: 'kill', id: t.id, enemy: 'titan', lane: 2, x: 4, by: 'shot' }] });
  assert.deepEqual(view.fx.map((f) => [f.kind, f.x, f.y, f.life]), [['boom', ex(4) - 16, laneY(2) - 8, 24]]);
});

test('packet-siege: slides: a knockback hops right, a thrown Bot arcs high toward the rack, a Glitch blinks flat and faint', () => {
  const sim = newSim();
  const k = spawn(sim, 'kiddie', 1, 5);
  const b = spawn(sim, 'bot', 3, 2);
  const g = spawn(sim, 'glitch', 4, 4);
  const pos = (e, name) => draws(render(sim), name).map((c) => [c.dx, c.dy, c.alpha])[0];
  k.moveFrom = 3;
  k.move = SLIDE;
  assert.deepEqual(pos(k, 'enm-kiddie-walk0'), [ex(3) - 12, laneY(1) + 6, 1], 'starts where it was');
  k.move = SLIDE / 2;
  assert.deepEqual(pos(k, 'enm-kiddie-walk0'), [ex(4) - 12, laneY(1) + 6 - 6, 1], 'half way, at the top of its hop');
  k.move = 0;
  assert.deepEqual(pos(k, 'enm-kiddie-walk0'), [ex(5) - 12, laneY(1) + 6, 1]);
  b.moveFrom = 5;
  b.move = SLIDE / 2;
  assert.deepEqual(pos(b, 'enm-bot-walk0'), [ex(3.5) - 12, laneY(3) + 6 - 22, 1], 'thrown: the top of a high arc');
  b.move = SLIDE;
  assert.deepEqual(pos(b, 'enm-bot-walk0'), [ex(5) - 12, laneY(3) + 6, 1]);
  g.moveFrom = 5;
  g.move = SLIDE / 2;
  assert.deepEqual(pos(g, 'enm-glitch-walk0'), [ex(4.5) - 12, laneY(4) + 6, 0.5], 'a blink: flat, faint');
  g.cloaked = true;
  g.move = 0;
  assert.deepEqual(pos(g, 'enm-glitch-walk0'), [ex(4) - 12, laneY(4) + 6, 0.35]);
});

test('packet-siege: a boss tier row\'s body picks boss, boss2 or boss3 frames; no body, an unknown body or no row: body 1', () => {
  const tiers = pks.pksBossTiers;
  const sim = newSim();
  const b = spawn(sim, 'boss', 2, 5, 2);
  const body = () => at(render(sim), ex(5) - 24, laneY(2) - 16)[0].name;
  const saved = tiers[1].body;
  try {
    assert.equal(body(), 'boss-walk0');
    tiers[1].body = 2;
    assert.equal(body(), 'boss2-walk0');
    b.cast = 5;
    assert.equal(body(), 'boss2-cast0');
    tiers[1].body = 3;
    b.anim = 12;
    assert.equal(body(), 'boss3-cast1');
    b.cast = 0;
    b.slow = 4;
    assert.deepEqual(at(render(sim), ex(5) - 24, laneY(2) - 16).map((c) => [c.name, c.set]), [['boss3-walk1', 'slow']]);
    tiers[1].body = 7;
    assert.equal(body(), 'boss-walk1');
    tiers[1].body = 1;
    assert.equal(body(), 'boss-walk1');
    b.tier = tiers.length + 5;
    assert.equal(body(), 'boss-walk1', 'no row');
  } finally {
    if (saved === undefined) delete tiers[1].body;
    else tiers[1].body = saved;
  }
});

test('packet-siege: a Decryptor shot is drawn like a shot; Batch Job shells arc from the mortar to where they land, their shadow on the lane', () => {
  const sim = newSim();
  sim.shots.push({ id: 800, kind: 'decrypt', lane: 2, x: 3.5, from: 1.7, dir: 1, dmg: 30, slow: 0, owner: 1, done: false });
  assert.deepEqual(draws(render(sim), 'shot-decrypt').map((c) => [c.dx, c.dy]), [[ex(3.5) - 4, laneY(2) + 13]]);
  sim.shells.push({ id: 801, owner: 1, lane: 3, from: 1.5, to: 5.5, t: 60, flight: 60, dmg: 60, splash: 1, done: false });
  const shell = () => {
    const calls = render(sim);
    const s = draws(calls, 'shot-shell')[0];
    const shadow = calls.filter((c) => c.op === 'rect' && c.alpha === 0.45);
    assert.ok(calls.indexOf(shadow[0]) < calls.indexOf(s), 'the shadow under the shell');
    return [s.dx, s.dy, shadow.map((r) => [r.color, r.x, r.y, r.w, r.h])];
  };
  assert.deepEqual(shell(), [ex(1.5) - 4, laneY(3) + 13, [[PALETTE.k, ex(1.5) - 3, laneY(3) + 27, 6, 2]]], 'leaving the mortar');
  sim.shells[0].t = 30;
  assert.deepEqual(shell(), [ex(3.5) - 4, laneY(3) + 13 - 28, [[PALETTE.k, ex(3.5) - 3, laneY(3) + 27, 6, 2]]], 'the top of the arc');
  sim.shells[0].t = 1;
  const [x, y] = shell();
  assert.equal(x, Math.round(ex(1.5 + 4 * 59 / 60) - 4));
  assert.ok(y >= laneY(3) + 13 - 2, 'landing');
});

// Every expansion event and the effects it starts: [kind, x, y, life, delay].
const FX_CASES_150 = [
  [{ type: 'steal', id: 7, lane: 3, x: 5.2, amount: 1 }, [['pip', ex(5.2) - 4, laneY(3) + 2, 30, 0]]],
  [{ type: 'detonate', id: 7, lane: 0, x: 0.6, col: 0, dmg: 300 }, [
    ['boom', cellX(0), laneY(0), 16, 0], ['boom', cellX(1), laneY(0), 16, 2],
    ['boom', cellX(0), laneY(1), 16, 2], ['boom', cellX(1), laneY(1), 16, 0]]],
  [{ type: 'wipe', id: 3, def: 'proxy', by: 7, lane: 1, col: 1 }, [['decal', cellX(1), laneY(1), 18, 0]]],
  [{ type: 'release', id: 7, lane: 2, x: 6, child: 8 }, [['puff', ex(6) - 16, laneY(2), 8, 0]]],
  [{ type: 'throw', id: 7, lane: 2, x: 6, to: 3, child: 8 }, [['spark', ex(6) - 4, laneY(2) + 6, 8, 0]]],
  [{ type: 'split', id: 7, lane: 2, x: 5, gen: 2, children: [8, 9] }, [['puff', ex(5) - 16, laneY(2), 8, 0], ['puff', ex(5.4) - 16, laneY(2), 8, 3]]],
  [{ type: 'shieldBreak', id: 7, lane: 2, x: 5, by: 'shot' }, [['decal', ex(5) - 12, laneY(2) + 6, 14, 0]]],
  [{ type: 'blink', id: 7, lane: 2, x: 5, to: 4 }, [['decal', ex(5) - 16, laneY(2), 12, 0]]],
  [{ type: 'trace', id: 1, def: 'tracer', lane: 0, col: 1, target: 7, x: 6.2, dmg: 150 }, [
    ['trace', cellX(1) + 27, laneY(0) + 17, 10, 0], ['spark', ex(6.2) - 14, laneY(0) + 12, 6, 0]]],
  [{ type: 'splash', id: 9, owner: 1, lane: 4, x: 6.8, radius: 1 }, [['splash', ex(6.8) - 16, laneY(4), 15, 0]]],
  [{ type: 'knock', id: 1, def: 'loopback', target: 7, lane: 0, from: 3, to: 5 }, [['decal', ex(3) - 16, laneY(0), 12, 0]]],
  [{ type: 'arc', id: 1, def: 'tokenring', lane: 2, col: 1, dmg: 30, path: [{ id: 7, lane: 2, x: 4 }, { id: 8, lane: 1, x: 5 }] }, [
    ['arc', cellX(1) + 27, laneY(2) + 17, 10, 0], ['spark', ex(4) - 4, laneY(2) + 12, 8, 0], ['spark', ex(5) - 4, laneY(1) + 12, 8, 0]]],
  [{ type: 'pull', id: 1, def: 'sinkhole', target: 7, from: 1, lane: 2, x: 3.6 }, [['decal', ex(3.6) - 16, laneY(1), 16, 0]]],
  [{ type: 'reflect', id: 9, by: 1, lane: 2, x: 4, owner: 7 }, [['spark', ex(4) - 4, laneY(2) + 12, 8, 0]]],
  [{ type: 'restore', id: 5, by: 1, old: 4, def: 'firewall', lane: 4, col: 2 }, [['decal', cellX(2), laneY(4), 20, 0]]],
  [{ type: 'scrub', id: 1, def: 'scrubber', lane: 1, col: 6 }, [['flash', 0, 0, 16, 0], ['ring', ex(6.5), laneY(1) + 16, 12, 0]]],
  [{ type: 'hit', id: 7, shot: 9, kind: 'decrypt', lane: 1, x: 5, dmg: 60 }, [['spark', ex(5) - 14, laneY(1) + 12, 6, 0]]],
  [{ type: 'blast', id: 1, def: 'honeynet', lane: 2, col: 5 }, [['boom', cellX(5), laneY(2), 16, 0]]],
  [{ type: 'jam', id: 1, lane: 2, col: 1, on: true }, []],
  [{ type: 'lob', id: 1, def: 'batch', lane: 2, col: 1, shell: 9, to: 5, flight: 60 }, []]
];

test('packet-siege: every expansion event starts its effect at the right place (or none)', () => {
  for (const t of ['steal', 'detonate', 'wipe', 'release', 'throw', 'split', 'shieldBreak', 'blink', 'jam', 'trace', 'lob', 'splash',
    'knock', 'arc', 'pull', 'reflect', 'restore', 'scrub']) {
    assert.ok(FX_CASES_150.some((c) => c[0].type === t), t + ' is covered');
  }
  for (const [ev, want] of FX_CASES_150) {
    const view = pks.pksNewView();
    pks.pksViewEvents(view, { events: [ev] });
    assert.deepEqual(view.fx.map((f) => [f.kind, f.x, f.y, f.life, 0 - f.age]), want, JSON.stringify(ev));
  }
  const arts = (ev) => { const v = pks.pksNewView(); pks.pksViewEvents(v, { events: [ev] }); return v.fx[0].art; };
  assert.deepEqual(['wipe', 'shieldBreak', 'blink', 'knock', 'pull', 'restore'].map((t) => arts(FX_CASES_150.find((c) => c[0].type === t)[0])),
    ['fx-wipe', 'fx-shield-break', 'fx-blink', 'fx-knock', 'fx-pull', 'fx-restore']);
});

test('packet-siege: a Keylogger\'s theft rises as a red "-N" pip that adds up what it steals for a while, one pip per Keylogger', () => {
  const view = pks.pksNewView();
  const steal = (id) => pks.pksViewEvents(view, { events: [{ type: 'steal', id, lane: 1, x: 4, amount: 1 }] });
  steal(7);
  for (let i = 0; i < 6; i++) pks.pksViewStep(view);
  steal(7);
  steal(8);
  assert.deepEqual(view.fx.map((f) => [f.text, f.color, f.n]), [['-2', PALETTE.x, 2], ['-1', PALETTE.x, 1]]);
  for (let i = 0; i < 14; i++) pks.pksViewStep(view);
  steal(7);
  assert.deepEqual(view.fx.map((f) => f.text), ['-2', '-1', '-1'], 'a new pip after PKS_STEAL_GROUP steps');
  // drawn: the cycles icon and the digits in crimson on a dark shadow
  const calls = fxAt({ type: 'steal', id: 7, lane: 1, x: 4, amount: 3 }, 0);
  assert.deepEqual(draws(calls, 'icon-cycles').map((c) => [c.dx, c.dy]), [[ex(4) - 4, laneY(1) + 2]]);
  const lit = rects(calls, PALETTE.x);
  assert.equal(lit.length, 3 + 11, 'the pixels of - 3');
  assert.deepEqual([lit[0].x, lit[0].y], [ex(4) - 4 + 10, laneY(1) + 4 + 2], 'the - of the text');
  assert.equal(rects(calls, PALETTE.k).length, lit.length);
  // a produce pip is still yellow
  assert.ok(rects(fxAt({ type: 'produce', id: 1, lane: 1, col: 2, amount: 25 }, 0), PALETTE.y).length > 0);
});

test('packet-siege: expansion effects animate and vanish: decals fade, splashes run three frames, the trace, the scrub flash', () => {
  const wipe = { type: 'wipe', id: 3, def: 'proxy', by: 7, lane: 1, col: 1 };
  assert.deepEqual(fxAt(wipe, 0).map((c) => [c.name, c.dx, c.dy, c.alpha]), [['fx-wipe', cellX(1), laneY(1), 1]]);
  assert.ok(Math.abs(fxAt(wipe, 15)[0].alpha - (1 - 15 / 18) * 2) < 1e-9, 'fading');
  assert.deepEqual(fxAt(wipe, 18), []);
  const splash = { type: 'splash', id: 9, owner: 1, lane: 4, x: 6, radius: 1 };
  assert.deepEqual([0, 4, 5, 9, 10, 14].map((a) => fxAt(splash, a).map((c) => c.name)),
    [['fx-splash0'], ['fx-splash0'], ['fx-splash1'], ['fx-splash1'], ['fx-splash2'], ['fx-splash2']]);
  assert.deepEqual(fxAt(splash, 0).map((c) => [c.dx, c.dy]), [[ex(6) - 16, laneY(4)]]);
  const trace = { type: 'trace', id: 1, def: 'tracer', lane: 0, col: 1, target: 7, x: 6, dmg: 150 };
  const x0 = cellX(1) + 27;
  const x1 = ex(6) - 6;
  const y = laneY(0) + 17;
  let calls = fxAt(trace, 0);
  assert.deepEqual(calls.filter((c) => c.op === 'rect').map((r) => [r.color, r.x, r.y, r.w, r.h]),
    [[PALETTE.x, x0, y, x1 - x0, 1], [PALETTE.w, x0, y - 1, x1 - x0, 1]]);
  assert.deepEqual(draws(calls, 'shot-heavy').map((c) => [c.dx, c.dy, c.sw]), [[x1 - 6, y - 4, 12]]);
  calls = fxAt(trace, 4);
  assert.deepEqual(calls.filter((c) => c.op === 'rect' || c.name === 'shot-heavy').map((c) => [c.color, c.alpha]), [[PALETTE.x, 0.6]], 'the line fades alone');
  // a target close in front: the line never has a negative width
  const near = fxAt({ type: 'trace', id: 1, def: 'tracer', lane: 0, col: 1, target: 7, x: 1.6, dmg: 150 }, 0);
  assert.deepEqual(near.filter((c) => c.op === 'rect').map((r) => r.w), [1, 1]);
  const scrub = fxAt({ type: 'scrub', id: 1, def: 'scrubber', lane: 1, col: 6 }, 8);
  assert.deepEqual(scrub[0], { op: 'rect', color: PALETTE.w, x: 24, y: 20, w: 288, h: 160, alpha: 0.2 });
});

// The bolt rects and arc sprites of an arc effect at a given age.
function arcCalls(ev, age) {
  const calls = fxAt(ev, age);
  return {
    bolts: calls.filter((c) => c.op === 'rect'),
    arcs: calls.filter((c) => /^fx-arc/.test(c.name || '')).map((c) => [c.name, c.dx, c.dy])
  };
}

test('packet-siege: a Token Ring arc runs flat along a lane and joins lanes with fx-arc, down at the point, up at the start', () => {
  // its own lane, then down a lane, then down another
  const down = { type: 'arc', id: 1, def: 'tokenring', lane: 1, col: 1, dmg: 30, path: [{ id: 7, lane: 1, x: 3.5 }, { id: 8, lane: 2, x: 4.5 }, { id: 9, lane: 3, x: 5.25 }] };
  let r = arcCalls(down, 0);
  assert.deepEqual(r.arcs, [['fx-arc0', ex(4.5) - 16, laneY(1) + 17], ['fx-arc0', ex(5.25) - 16, laneY(2) + 17]]);
  const ys = [...new Set(r.bolts.map((b) => b.y))].sort((a, b) => a - b);
  assert.deepEqual(ys, [laneY(1) + 16, laneY(1) + 17, laneY(1) + 18, laneY(2) + 16, laneY(2) + 17, laneY(2) + 18], 'flat at the centres of lanes 1 and 2');
  const lane1 = r.bolts.filter((b) => b.y >= laneY(1) + 16 && b.y <= laneY(1) + 18);
  assert.equal(Math.min(...lane1.map((b) => b.x)), cellX(1) + 27);
  assert.equal(Math.max(...lane1.map((b) => b.x + b.w)), ex(4.5));
  for (const b of r.bolts) assert.ok(b.w >= 1 && b.w <= 4 && b.h === 1);
  assert.deepEqual([...new Set(r.bolts.map((b) => b.color))].sort(), [PALETTE.q, PALETTE.w].sort());
  // it flickers: the other sprite and the zigzag flipped two steps later
  const later = arcCalls(down, 2);
  assert.deepEqual(later.arcs.map((a) => a[0]), ['fx-arc1', 'fx-arc1']);
  assert.notDeepEqual(later.bolts.map((b) => b.y), r.bolts.map((b) => b.y));
  // up a lane: the sprite at the start's x, from the upper lane's centre
  const up = { type: 'arc', id: 1, def: 'tokenring', lane: 3, col: 0, dmg: 30, path: [{ id: 7, lane: 3, x: 2 }, { id: 8, lane: 2, x: 3 }] };
  r = arcCalls(up, 0);
  assert.deepEqual(r.arcs, [['fx-arc0', ex(2) - 16, laneY(2) + 17]]);
  // two lanes in one jump: a sprite per lane crossed
  const far = { type: 'arc', id: 1, def: 'tokenring', lane: 0, col: 0, dmg: 30, path: [{ id: 7, lane: 0, x: 2 }, { id: 8, lane: 2, x: 3 }] };
  assert.deepEqual(arcCalls(far, 0).arcs, [['fx-arc0', ex(3) - 16, laneY(0) + 17], ['fx-arc0', ex(3) - 16, laneY(1) + 17]]);
  // fading out
  assert.ok(arcCalls(down, 9).bolts.every((b) => Math.abs(b.alpha - 0.2) < 1e-9));
  assert.deepEqual(fxAt(down, 10), []);
});

// A sim with every unit of the expansion in its states, shells and shots.
function expansionSim() {
  const sim = newSim({ zone: 12 });
  const ids = ['canary', 'tracer', 'batch', 'loopback', 'tokenring', 'sigdb', 'sinkhole', 'airgap', 'backup', 'scrubber', 'decryptor', 'honeynet'];
  ids.forEach((id, i) => {
    const d = put(sim, id, i % 5, Math.floor(i / 5));
    d.fire = i % 2 ? 4 : 0;
    d.jammed = i % 3 === 0;
    d.boosted = i % 4 === 1;
    if (i === 6) d.hp = 100;
  });
  const enemies = ['keylogger', 'logicbomb', 'amplifier', 'wiper', 'hive', 'hydra', 'payload', 'jammer', 'replicator', 'dropper', 'titan', 'glitch'];
  enemies.forEach((id, i) => {
    const e = spawn(sim, id, i % 5, 4 + (i % 4) * 1.1);
    e.state = i % 3 === 0 ? 'biting' : 'walking';
    e.aura = ['amplifier', 'hydra', 'jammer'].includes(id) ? 1.5 : 0;
    e.amped = i % 2 === 0;
    e.mended = i % 5 === 1 ? sim.tick : -1;
    if (id === 'replicator') e.gen = 3;
    if (id === 'glitch' || id === 'wiper') {
      e.moveFrom = e.x + 1;
      e.move = 5;
    }
  });
  spawn(sim, 'boss', 2, 8, 3).shield = 0;
  sim.shells.push({ id: 900, owner: 1, lane: 2, from: 1.5, to: 6, t: 20, flight: 60, dmg: 60, splash: 1, done: false });
  sim.shots.push({ id: 901, kind: 'decrypt', lane: 0, x: 3, from: 2, dir: 1, dmg: 30, slow: 0, owner: 1, done: false });
  return sim;
}

test('packet-siege: pksRender leaves a sim with every expansion unit, state, shell and effect deeply unchanged, in a few hundred draws', () => {
  const sim = expansionSim();
  const view = pks.pksNewView();
  pks.pksViewEvents(view, { events: FX_CASES_150.map((c) => c[0]) });
  for (let i = 0; i < 3; i++) pks.pksViewStep(view);
  const before = JSON.stringify(sim);
  const evBefore = JSON.stringify(FX_CASES_150);
  const calls = render(sim, view);
  assert.equal(JSON.stringify(sim), before);
  assert.equal(JSON.stringify(FX_CASES_150), evBefore, 'nor the events the view read');
  assert.ok(calls.length < 600, calls.length + ' calls');
  const names = new Set(calls.filter((c) => c.op === 'draw').map((c) => c.name));
  for (const n of ['fx-jam', 'fx-shield', 'fx-aura-amp', 'fx-aura-heal', 'enm-titan-walk0', 'enm-replica3-walk0', 'shot-shell', 'shot-decrypt',
    'fx-wipe', 'fx-splash0', 'fx-arc1', 'shot-heavy']) assert.ok(names.has(n), n);
  // played on: the real step with these units, a frame each step, the sim the same after each frame
  for (let i = 0; i < 90; i++) {
    pks.pksStep(sim);
    pks.pksViewStep(view);
    pks.pksViewEvents(view, sim);
    const s = JSON.stringify(sim);
    render(sim, view);
    assert.equal(JSON.stringify(sim), s, 'step ' + i);
  }
});

// ── whole levels ───────────────────────────────────────────────────────────

// A simple scripted player: generators, then shooters lane by lane, walls in
// front of the leading enemy, instants on crowds.
function playLevel(n, onStep) {
  const owned = pks.pksUnlockedDefenders(n - 1);
  const slots = pks.pksSlots(n);
  const sim = pks.pksNewSim(n, owned.length > slots ? ['psu', 'firewall'].concat(owned.slice(2 - slots)) : owned);
  const plan = [];
  for (const col of [0, 2, 1, 3, 4]) for (const l of sim.level.lanes) plan.push([col === 0 || col === 1 ? 'psu' : 'firewall', l, col]);
  const extras = ['ids', 'tarpit', 'scanner', 'inspector', 'limiter', 'patch', 'ups', 'waf', 'honeypot', 'proxy'];
  let next = 0;
  while (sim.status === 'playing') {
    assert.ok(sim.tick < 60 * (sim.level.duration + 120), 'L' + n + ' ends');
    if (sim.tick % 30 === 0) {
      if (next < plan.length) {
        const r = pks.pksPlace(sim, plan[next][0], plan[next][1], plan[next][2]);
        if (r.ok || r.reason === 'blocked' || r.reason === 'occupied') next++;
      }
      const lead = sim.enemies.filter((e) => e.x < 6).sort((a, b) => a.x - b.x)[0];
      if (lead) {
        for (const id of ['nullroute', 'failover', 'quarantine']) pks.pksPlace(sim, id, lead.lane, Math.max(0, Math.floor(lead.x) - 1));
        for (const id of extras) pks.pksPlace(sim, id, lead.lane, 5);
      }
    }
    onStep(sim);
  }
  return sim;
}

test('packet-siege: rendering never changes the sim: whole levels played and drawn step by step, every name drawn known', () => {
  for (const n of [4, 10, 12, 40]) {
    const view = pks.pksNewView();
    const kinds = new Set();
    let frames = 0;
    const sim = playLevel(n, (s) => {
      pks.pksViewEvents(view, s);
      pks.pksStep(s);
      pks.pksViewStep(view);
      pks.pksViewEvents(view, s);
      for (const f of view.fx) if (f.age < f.life) kinds.add(f.kind);
      // A frame every 4 steps; every 8th one (and the last) also proves the
      // sim is the same after it (whole levels are minutes long).
      if (s.tick % 4 === 0 || s.status !== 'playing') {
        const check = s.tick % 32 === 0 || s.status !== 'playing';
        const before = check ? JSON.stringify(s) : null;
        render(s, view);
        frames++;
        if (check) assert.equal(JSON.stringify(s), before, 'L' + n + ' tick ' + s.tick);
      }
    });
    assert.notEqual(sim.status, 'playing');
    assert.ok(frames > 100);
    assert.ok(kinds.has('spark') && kinds.has('puff') && kinds.has('place'), 'L' + n + ': ' + [...kinds].join(' '));
  }
});

// ── the zone rules of levels 51-150 and the boss tiers 6-15 ────────────────

// The first level of 51-150 whose rules include `name`.
const levelWith = (name) => {
  for (let n = 51; n <= 150; n++) if (pks.pksLevel(n).rules.names.includes(name)) return n;
  return 0;
};
const RULE_TILES = ['tile-express', 'tile-hot', 'tile-rail', 'tile-tunnel', 'tile-cross-up', 'tile-cross-down'];

test('packet-siege: the rule tiles of a level: express lanes, hot cells, power rails, tunnel exits and crossover arrows over its floor, under the fog', () => {
  const cell = (calls, name) => draws(calls, name).map((c) => [c.dx, c.dy]).sort();
  const cells = (list) => list.map((p) => [cellX(p.col), laneY(p.lane)]).sort();
  for (const name of ['express', 'hot', 'rails', 'tunnels', 'cross']) {
    const n = levelWith(name);
    const sim = pks.pksNewSim(n, []);
    const R = sim.level.rules;
    const calls = render(sim);
    const floorEnd = calls.indexOf(at(calls, cellX(8), laneY(4))[0]);
    if (name === 'express') {
      assert.ok(R.express.length >= 1);
      assert.deepEqual(cell(calls, 'tile-express'), R.express.flatMap((l) => Array.from({ length: 9 }, (_, c) => [cellX(c), laneY(l)])).sort());
    }
    if (name === 'hot') assert.deepEqual(cell(calls, 'tile-hot'), cells(R.hot));
    if (name === 'rails') assert.deepEqual(cell(calls, 'tile-rail'), cells(R.rails));
    if (name === 'tunnels') assert.deepEqual(cell(calls, 'tile-tunnel'), cells(R.tunnels));
    if (name === 'cross') {
      assert.deepEqual(cell(calls, 'tile-cross-up'), cells(R.cross.filter((x) => x.to < x.lane)));
      assert.deepEqual(cell(calls, 'tile-cross-down'), cells(R.cross.filter((x) => x.to > x.lane)));
      assert.ok(R.cross.length >= 2);
    }
    // over the floor tile of their cell, before the units and the margin
    for (const d of calls.filter((c) => RULE_TILES.includes(c.name))) {
      const i = calls.indexOf(d);
      assert.ok(i > floorEnd, name + ': over the floor');
      assert.ok(at(calls.slice(0, i), d.dx, d.dy).some((c) => /^tile-z\d+-[ab]$/.test(c.name)), name + ': its cell\'s floor first');
    }
  }
  // the quantum lab: express lanes under five columns of fog
  const lab = pks.pksNewSim(levelWith('fog'), []);
  assert.equal(lab.level.fog, C.LATE_FOG);
  const calls = render(lab);
  assert.equal(draws(calls, 'fog').length, 5 * C.LATE_FOG);
  assert.ok(calls.indexOf(draws(calls, 'tile-express')[0]) < calls.indexOf(draws(calls, 'fog')[0]), 'the marks under the fog');
  // levels 1-50 draw none of it
  for (const n of [1, 25, 50]) assert.equal(render(pks.pksNewSim(n, [])).filter((c) => RULE_TILES.includes(c.name)).length, 0);
});

test('packet-siege: a tunnel exit shimmers through its frames while an enemy is on its way out, over the units', () => {
  const n = levelWith('tunnels');
  const sim = pks.pksNewSim(n, ALL);
  const t = sim.level.rules.tunnels[0];
  const steps = Math.round(C.SHIMMER * C.RATE);
  const e = spawn(sim, 'bot', t.lane, t.col + 0.5);
  sim.shimmers.push({ id: 900, lane: t.lane, col: t.col, enemy: 'bot', t: steps });
  const frame = () => {
    const calls = render(sim);
    return calls.filter((c) => /^fx-shimmer/.test(c.name || '')).map((c) => [c.name, c.dx, c.dy]);
  };
  assert.deepEqual(frame(), [['fx-shimmer0', cellX(t.col), laneY(t.lane)]]);
  sim.shimmers[0].t = Math.ceil(steps * 2 / 3) - 1;
  assert.deepEqual(frame().map((f) => f[0]), ['fx-shimmer1']);
  sim.shimmers[0].t = 1;
  assert.deepEqual(frame().map((f) => f[0]), ['fx-shimmer2']);
  sim.shimmers[0].t = steps + 5;
  assert.deepEqual(frame().map((f) => f[0]), ['fx-shimmer0'], 'clamped');
  const calls = render(sim);
  assert.ok(calls.indexOf(draws(calls, 'fx-shimmer0')[0]) > calls.indexOf(draws(calls, 'enm-bot-walk0')[0]), 'over the enemy on the exit');
  assert.equal(e.tier, 0);
  sim.shimmers.length = 0;
  assert.equal(frame().length, 0);
});

test('packet-siege: a rolling outage: the lane blinks during its warning, then wears fx-outage over its defenders and under its enemies', () => {
  const n = levelWith('outage');
  const sim = pks.pksNewSim(n, ALL);
  sim.cycles = 1e6;
  put(sim, 'firewall', 2, 1);
  put(sim, 'psu', 3, 0);
  spawn(sim, 'bot', 2, 5);
  const lane2 = (calls) => draws(calls, 'fx-outage').map((c) => [c.dx, c.dy, c.alpha]);
  assert.equal(sim.outage.state, 'clear');
  assert.deepEqual(lane2(render(sim)), [], 'nothing while clear');
  Object.assign(sim.outage, { state: 'warn', lane: 2 });
  sim.tick = 16;
  assert.deepEqual(lane2(render(sim)), Array.from({ length: 9 }, (_, c) => [cellX(c), laneY(2), 0.5]), 'the warning, half bright');
  sim.tick = 8;
  assert.deepEqual(lane2(render(sim)), [], 'blinking');
  sim.outage.state = 'down';
  const calls = render(sim);
  assert.deepEqual(lane2(calls), Array.from({ length: 9 }, (_, c) => [cellX(c), laneY(2), 1]), 'down: full');
  const first = calls.indexOf(draws(calls, 'fx-outage')[0]);
  assert.ok(first > calls.findIndex((c) => c.name === 'def-firewall-0'), 'over its defenders');
  assert.ok(first < calls.findIndex((c) => c.name === 'enm-bot-walk0'), 'under its enemies');
  assert.ok(first < calls.findIndex((c) => c.name === 'def-psu-0'), 'under the next lane');
});

test('packet-siege: a blackout darkens every half cell no seeing defender sees: lit behind the first gun and over each one\'s sight, a blinking warning first', () => {
  const n = levelWith('blackout');
  const sim = pks.pksNewSim(n, ALL);
  const sight = sim.level.rules.blackout.sight;
  assert.equal(sight, C.BLACKOUT_SIGHT);
  sim.cycles = 1e6;
  put(sim, 'firewall', 1, 1);
  put(sim, 'scanner', 3, 2);
  put(sim, 'tracer', 2, 6);
  put(sim, 'psu', 0, 0);
  put(sim, 'proxy', 4, 7);
  put(sim, 'firewall', 0, 3).hp = 0;
  spawn(sim, 'bot', 0, 5);
  const dark = (calls) => draws(calls, 'fx-dark').map((c) => [c.dx, c.dy, c.sw, c.alpha]);
  assert.deepEqual(dark(render(sim)), [], 'clear: no darkness');
  // the expected darkness: the half cells left unlit, as full or half cells
  const expect = (lit, alpha) => {
    const out = [];
    for (let l = 0; l < 5; l++) {
      for (let c = 0; c < 9; c++) {
        const left = !lit[l].includes(2 * c);
        const right = !lit[l].includes(2 * c + 1);
        if (left && right) out.push([cellX(c), laneY(l), 32, alpha]);
        else if (left) out.push([cellX(c), laneY(l), 16, alpha]);
        else if (right) out.push([cellX(c) + 16, laneY(l), 16, alpha]);
      }
    }
    return out;
  };
  const range = (a, b) => Array.from({ length: Math.max(0, Math.min(18, b) - a) }, (_, i) => a + i);
  const reach = 2 * sight;
  const lit = [
    [],                                          // lane 1: a PSU (no sight) and a dead Firewall
    range(0, 3 + reach),                         // lane 2: a Firewall at column 2
    range(0, 5 + reach).concat(range(13, 13 + reach)), // lane 3: the Scanner next door, and a Tracer at column 7
    range(0, 5 + reach),                         // lane 4: the Scanner
    range(0, 5 + reach)                          // lane 5: the Scanner next door (the Proxy has no sight)
  ];
  sim.blackout.state = 'dark';
  let calls = render(sim);
  assert.deepEqual(dark(calls), expect(lit, 1));
  assert.ok(dark(calls).some((d) => d[2] === 16), 'half cells where the sight ends mid-cell');
  assert.equal(dark(calls).filter((d) => d[1] === laneY(0)).length, 9, 'a lane with no seeing defender is dark from the rack');
  // over the units, under shots and effects
  sim.shots.push({ id: 900, kind: 'drop', lane: 0, x: 5, from: 2, dir: 1, dmg: 20, slow: 0, owner: 1, done: false });
  calls = render(sim);
  const firstDark = calls.findIndex((c) => c.name === 'fx-dark');
  assert.ok(firstDark > calls.findIndex((c) => c.name === 'enm-bot-walk0'));
  assert.ok(firstDark < calls.findIndex((c) => c.name === 'shot-drop'));
  // the warning: the same cells, faint, blinking
  sim.blackout.state = 'warn';
  sim.tick = 0;
  assert.deepEqual(dark(render(sim)), expect(lit, 0.4));
  sim.tick = 8;
  assert.deepEqual(dark(render(sim)), []);
  // levels 1-50 never go dark
  assert.equal(draws(render(pks.pksNewSim(10, ALL)), 'fx-dark').length, 0);
});

test('packet-siege: in a blackout a defender lights its sight only while the sim lets it look and shoot: not offline, off or jammed', () => {
  const n = levelWith('blackout');
  const fresh = () => {
    const sim = pks.pksNewSim(n, ALL);
    sim.cycles = 1e6;
    sim.spawnIndex = sim.level.spawns.length;
    sim.blackout.state = 'dark';
    sim.blackout.t = 600;
    return sim;
  };
  // the dark draws over a lane: 9 when it is dark from the rack
  const darkIn = (sim, lane) => draws(render(sim), 'fx-dark').filter((c) => c.dy === laneY(lane)).length;
  // what the sim does in one step with a Bot inside its sight
  const shoots = (sim, d) => {
    spawn(sim, 'bot', d.lane, d.col + 2.5);
    pks.pksStep(sim);
    return sim.events.some((e) => e.type === 'shot' && e.owner === d.id);
  };
  const down = (lane, state) => ({ state, lane, next: lane, t: 600, count: 1 });
  const cases = [
    ['working', () => {}, true],
    ['off (Ransomware)', (sim, d) => { d.off = 600; }, false],
    ['its lane offline', (sim) => { sim.outage = down(1, 'down'); }, false],
    ['another lane offline', (sim) => { sim.outage = down(2, 'down'); }, true],
    ['its lane warned of an outage', (sim) => { sim.outage = down(1, 'warn'); }, true]
  ];
  for (const [what, set, acts] of cases) {
    const sim = fresh();
    const fw = put(sim, 'firewall', 1, 1);
    set(sim, fw);
    assert.equal(darkIn(sim, 1) < 9, acts, what + ': lit');
    assert.equal(shoots(sim, fw), acts, what + ': shoots');
  }
  // jammed: the sim sets it at the start of a step (a Jammer's aura), and a
  // jammed shooter does not fire even at the Jammer in its sight
  const sim = fresh();
  const fw = put(sim, 'firewall', 1, 1);
  const lb = put(sim, 'loopback', 3, 1);
  spawn(sim, 'jammer', 1, 2.5);
  spawn(sim, 'jammer', 3, 2.5);
  pks.pksStep(sim);
  assert.equal(fw.jammed, true);
  assert.ok(!sim.events.some((e) => e.type === 'shot' && e.owner === fw.id), 'jammed: no shot');
  assert.equal(darkIn(sim, 1), 9, 'a jammed shooter lights nothing');
  assert.equal(lb.jammed, false, 'a Loopback is no shooter kind: never jammed');
  assert.ok(darkIn(sim, 3) < 9, 'and it stays lit');
});

test('packet-siege: boss tiers with a hue are drawn from their tinted copy; white and blue stay; the ten late bosses all look different', () => {
  const tiers = pks.pksBossTiers;
  const hues = [...new Set(tiers.filter((t) => t.hue).map((t) => t.hue))].sort((a, b) => a - b);
  assert.deepEqual(Object.keys(ATLAS.tints).map(Number).sort((a, b) => a - b), hues);
  for (const t of tiers.filter((r) => r.hue)) {
    const prefix = ['boss-', 'boss2-', 'boss3-'][(t.body || 1) - 1];
    for (const p of ['walk0', 'walk1', 'cast0', 'cast1']) assert.ok(ATLAS.tints[t.hue][prefix + p], t.tier + ' ' + prefix + p);
  }
  const looks = new Set();
  for (const t of tiers) {
    const sim = newSim();
    const b = spawn(sim, 'boss', 2, 5, t.tier);
    const body = () => at(render(sim), ex(5) - 24, laneY(2) - 16).map((c) => c.set + ':' + c.name)[0];
    const look = body();
    if (t.tier > 5) looks.add(look);
    assert.equal(look.split(':')[0], t.hue ? 'tint' + t.hue : 'frames', 'tier ' + t.tier);
    b.flash = 1;
    assert.match(body(), /^flash:/);
    b.flash = 0;
    b.slow = 5;
    assert.match(body(), /^slow:/);
  }
  assert.equal(looks.size, 10, [...looks].join(' '));
  // the hue shift: saturated colours turn, greys and dull ones stay
  assert.equal(pks.pksHueShift('#ff0000', 120), '#00ff00');
  assert.equal(pks.pksHueShift('#ff0000', 240), '#0000ff');
  assert.equal(pks.pksHueShift('#00ff00', 120), '#0000ff');
  assert.equal(pks.pksHueShift('#0000ff', 120), '#ff0000');
  for (const hex of ['#808080', '#000000', '#ffffff', '#5b6b85']) assert.equal(pks.pksHueShift(hex, 90), hex, hex);
  // a boss tier row without a hue in the atlas falls back to its own colours
  const saved = tiers[7].hue;
  try {
    tiers[7].hue = 33;
    const sim = newSim();
    spawn(sim, 'boss', 2, 5, 8);
    assert.equal(at(render(sim), ex(5) - 24, laneY(2) - 16)[0].set, 'frames');
  } finally {
    tiers[7].hue = saved;
  }
  // a tier with a hue and no body is tinted in body 1
  const body = tiers[8].body;
  try {
    delete tiers[8].body;
    const atlas = pks.pksBuildAtlas((w, h) => ({ width: w, height: h, getContext: () => ({ fillRect() {} }) }));
    assert.ok(atlas.tints[tiers[8].hue]['boss-walk0']);
  } finally {
    tiers[8].body = body;
  }
});

// Every zone-rule and late-boss event and the effects it starts.
const FX_CASES_RULES = [
  [{ type: 'emerge', id: 7, shimmer: 6, enemy: 'bot', lane: 3, col: 6, x: 6.5 }, [['puff', cellX(6), laneY(3), 8, 0]]],
  [{ type: 'cross', id: 7, from: 1, lane: 2, col: 4, x: 4.4 }, [['ring', ex(4.5), laneY(1) + 16, 12, 0]]],
  [{ type: 'upkeep', amount: 9, due: 12 }, [['pip', 6, 26, 40, 0]]],
  [{ type: 'shieldUp', id: 7, lane: 2, x: 6, shield: 1500 }, [['decal', ex(6) - 24, laneY(2) - 16, 20, 0]]],
  [{ type: 'bossSplit', id: 7, lane: 2, x: 5, children: [8, 9] }, [['flash', 0, 0, 12, 0], ['ring', ex(5), laneY(2) + 16, 16, 0]]],
  [{ type: 'shimmer', id: 6, lane: 3, col: 6, enemy: 'bot', at: 40 }, []],
  [{ type: 'blackoutWarn', at: 50, length: 10 }, []],
  [{ type: 'blackout', on: true }, []],
  [{ type: 'outageWarn', lane: 2, at: 45, length: 8 }, []],
  [{ type: 'outage', lane: 2, on: true }, []]
];

test('packet-siege: the zone rules\' and late bosses\' events start their effects: an emerging enemy puffs, a crossover rings, upkeep rises as a pip, shields and splits flash', () => {
  for (const [ev, want] of FX_CASES_RULES) {
    const view = pks.pksNewView();
    pks.pksViewEvents(view, { events: [ev] });
    assert.deepEqual(view.fx.map((f) => [f.kind, f.x, f.y, f.life, 0 - f.age]), want, JSON.stringify(ev));
  }
  const calls = fxAt(FX_CASES_RULES[2][0], 0);
  assert.deepEqual(draws(calls, 'icon-upkeep').map((c) => [c.dx, c.dy]), [[6, 26]]);
  assert.equal(draws(calls, 'icon-cycles').length, 0);
  assert.equal(rects(calls, PALETTE.x).length, 3 + 12, 'the pixels of - 9 in crimson');
  // an unpaid charge (the sim takes nothing at 0 cycles): a white "0", no crimson minus
  const unpaid = pks.pksNewView();
  pks.pksViewEvents(unpaid, { events: [{ type: 'upkeep', amount: 0, due: 4 }] });
  assert.deepEqual(unpaid.fx.map((f) => [f.kind, f.text, f.color, f.art]), [['pip', '0', PALETTE.w, 'icon-upkeep']]);
  const zero = fxAt({ type: 'upkeep', amount: 0, due: 4 }, 0);
  assert.equal(rects(zero, PALETTE.x).length, 0, 'nothing crimson');
  assert.equal(rects(zero, PALETTE.w).length, 12, 'the pixels of 0 in white');
  const shield = fxAt(FX_CASES_RULES[3][0], 0);
  assert.deepEqual(shield.map((c) => [c.name, c.dx, c.dy]), [['fx-shield-boss', ex(6) - 24, laneY(2) - 16]]);
  const split = fxAt(FX_CASES_RULES[4][0], 0);
  assert.equal(split[0].color, PALETTE.f);
});

// Level n played (a few defenders, plenty of cycles) for `seconds`, a frame
// drawn every 4 steps and the sim proven unchanged by every 8th.
function playDrawn(n, seconds) {
  const sim = pks.pksNewSim(n, ['psu', 'firewall', 'proxy', 'ids', 'scanner', 'tracer', 'batch', 'tokenring', 'decryptor', 'honeynet']);
  sim.cycles = 1e6;
  for (let lane = 0; lane < 5; lane++) {
    for (const [id, col] of [['firewall', 0], ['scanner', 1], ['tracer', 2], ['proxy', 4]]) {
      sim.cards.find((c) => c.id === id).left = 0;
      pks.pksPlace(sim, id, lane, col);
    }
  }
  const view = pks.pksNewView();
  const names = new Set();
  while (sim.status === 'playing' && sim.tick < seconds * C.RATE) {
    pks.pksStep(sim);
    pks.pksViewStep(view);
    pks.pksViewEvents(view, sim);
    if (sim.tick % 4 === 0) {
      const before = sim.tick % 32 === 0 ? JSON.stringify(sim) : null;
      for (const c of render(sim, view)) if (c.name) names.add(c.name);
      if (before) assert.equal(JSON.stringify(sim), before, 'L' + n + ' tick ' + sim.tick);
    }
  }
  return names;
}

test('packet-siege: rendering never changes the sim on the late levels either, with every rule at work', () => {
  const blackout = pks.pksLevel(levelWith('blackout')).rules.blackout;
  const outage = pks.pksLevel(levelWith('outage')).rules.outage;
  const drawn = new Set();
  const tunnels = pks.pksLevel(levelWith('tunnels'));
  const firstOut = tunnels.spawns.find((s) => s.tunnel).t + C.SHIMMER;
  for (const [n, seconds] of [[levelWith('blackout'), blackout.every + blackout.length / 2], [levelWith('outage'), outage.every + outage.length / 2],
    [tunnels.n, firstOut + 1], [144, outage.every + 1], [143, 60]]) {
    for (const name of playDrawn(n, seconds)) drawn.add(name);
  }
  for (const name of ['fx-dark', 'fx-outage', 'tile-tunnel', 'fx-shimmer0', 'tile-cross-up', 'icon-upkeep']) assert.ok(drawn.has(name), name);
});

test('packet-siege: a frame costs a few hundred draws and no allocation of strings per unit', () => {
  const sim = pks.pksNewSim(25, ALL);
  sim.cycles = 1e6;
  for (let l = 0; l < 5; l++) for (let c = 0; c < 6; c++) put(sim, ALL[(l + c) % ALL.length], l, c);
  for (let i = 0; i < 25; i++) spawn(sim, pks.pksEnemies[i % 13].id, i % 5, 6 + (i % 4) * 0.5);
  const calls = render(sim);
  assert.ok(calls.length < 400, calls.length + ' calls');
  for (const part of ['render', 'render-units', 'render-fx', 'render-rules']) {
    const src = readRepoFile(GAME + '/src/' + part + '.js');
    assert.doesNotMatch(src, /getImageData|putImageData|createImageData/);
    // names are looked up from tables built once, not concatenated per frame
    const body = part === 'render' ? src.slice(src.indexOf('function pksRender(')) : src;
    assert.doesNotMatch(body, /'(def|enm|boss\d?|fx|fx-boom|fx-surge|fx-splash|fx-arc|fx-aura|fx-shimmer|tile|tile-z|backdrop-z|shot)-?' \+/, part);
    assert.ok(src.split('\n').length < 900, part);
  }
  assert.deepEqual(BUILD.PARTS.filter((p) => /^render/.test(p)), ['render', 'render-units', 'render-fx', 'render-rules']);
});

test('packet-siege: the page-side parts keep to the rules: no DOM, clock or randomness in sprites and render', () => {
  for (const part of ['unpack-art', 'sprites', 'render', 'render-units', 'render-fx', 'render-rules']) {
    const code = readRepoFile(GAME + '/src/' + part + '.js').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /\bdocument\b|\bwindow\b|localStorage|Math\.random|Date\b|performance\./, part);
  }
});
