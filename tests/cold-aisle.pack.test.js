// tests/cold-aisle.pack.test.js
// The art of Cold Aisle as the renderer gets it: build.js packs the ASCII
// maps of src/art-*.js into script.js and src/unpack-art.js restores them;
// every sprite decoded from the built file must equal its map in src/.  The
// names are the contract between the art and the code: every sprite the
// spec's Art section requires exists at its size, and every texture id the
// map can produce, every frame the enemies' state -> frame table can pick,
// every item, decor, projectile, effect and in-hand frame the renderer asks
// for is in the art.  The packing itself (numbers, runs, refusals) is tested
// with the build in cold-aisle.sim.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, readRepoFile } = require('./_setup');

const GAME = 'cold-aisle';
const JS = readRepoFile(GAME + '/script.js');
const cda = loadScript(GAME + '/script.js');
const BUILD = require('../' + GAME + '/build.js');
const ART_PARTS = BUILD.ART_PARTS;

// The decoder as src/ has it, in this realm (so deepEqual compares plain objects).
const UNPACK = new Function(readRepoFile(GAME + '/src/unpack-art.js').replace(/^CDA_API\..*$/gm, '') +
  '\nreturn cdaUnpackArt;')();

// The ASCII maps of an art part, evaluated straight from src/.
function sourceArt(part) {
  const text = readRepoFile(GAME + '/src/' + part + '.js');
  const name = /^var (CDA_ART_\w+) = \{$/m.exec(text)[1];
  return { name, art: new Function(text + '\nreturn ' + name + ';')() };
}

// The packed array of an art part as script.js holds it.
function builtPart(part) {
  const from = JS.indexOf('\n  // ── src/' + part + '.js ──\n');
  const section = JS.slice(from, JS.indexOf('\n  // ── src/', from + 1));
  const name = /^ {2}var (CDA_ART_\w+) = \[$/m.exec(section)[1];
  return { section, name, packed: new Function(section + '\nreturn ' + name + ';')() };
}

const ALL = {};
for (const part of ART_PARTS) Object.assign(ALL, sourceArt(part).art);
const T = cda.cdaTextures();

function size(name) {
  assert.ok(ALL[name], name + ' exists in the art');
  return ALL[name].w + 'x' + ALL[name].h;
}

const range = (prefix, names) => names.map((n) => prefix + n);

test('cold-aisle pack: the nine art parts are in ART_PARTS, and every sprite decoded from script.js is its ASCII map in src/', () => {
  assert.deepEqual(ART_PARTS.slice().sort(), ['art-decor', 'art-enemies', 'art-flats', 'art-fx', 'art-heavy-a', 'art-heavy-b',
    'art-items', 'art-walls', 'art-weapons']);
  let count = 0;
  for (const part of ART_PARTS) {
    const src = sourceArt(part);
    const built = builtPart(part);
    assert.equal(built.name, src.name, part);
    assert.doesNotMatch(built.section, /rows:/, part + ' holds no ASCII map');
    assert.deepEqual(UNPACK(built.packed), src.art, part + ' decodes to its source');
    count += Object.keys(src.art).length;
  }
  // the renderer's texture set holds them all, in the order of the parts
  assert.deepEqual(T.names, Object.keys(ALL));
  assert.equal(T.names.length, count);
  for (const name of T.names) {
    const s = ALL[name];
    assert.match(name, /^[a-z0-9-]+$/);
    assert.equal(T.w[T.id[name]], s.w, name);
    assert.equal(T.h[T.id[name]], s.h, name);
    for (const row of s.rows) assert.match(row, /^[.A-Za-z]+$/, name);
    for (const ch of s.rows.join('')) assert.ok(ch === '.' || ch in cda.CDA_PALETTE, name + ': ' + ch);
  }
});

test('cold-aisle pack: every sprite the spec\'s Art section requires exists at its size', () => {
  const want = {
    '32x32': ['wall-concrete', 'wall-panel', 'wall-pipes', 'wall-rack-a', 'wall-rack-b', 'wall-rack-c', 'wall-rack-rear',
      'wall-rack-infected0', 'wall-rack-infected1', 'wall-rack-clean', 'wall-terminal0', 'wall-terminal1', 'wall-secret', 'door',
      'door-blue', 'door-yellow', 'door-red', 'door-jamb', 'lift-locked', 'lift-open',
      'floor-tile', 'floor-grate', 'floor-concrete', 'floor-plate', 'ceil-panel', 'ceil-light', 'ceil-tray', 'ceil-pipes',
      'dc-cart', 'dc-chair', 'dc-spool', 'dc-crate', 'dc-extinguisher', 'dc-cone', 'dc-ladder', 'dc-lamp']
      .concat(range('enm-crawler-', ['walk0', 'walk1', 'atk0', 'atk1', 'hurt', 'die0', 'die1', 'dead']))
      .concat(range('enm-drone-', ['walk0', 'walk1', 'atk0', 'atk1', 'hurt', 'die0', 'die1', 'dead']))
      .concat(range('enm-turret-', ['idle', 'aim', 'atk0', 'hurt', 'die0', 'die1', 'dead'])),
    '32x64': ['dc-pillar'],
    '16x16': range('it-', ['cell', 'coil', 'coffee', 'medkit', 'vest', 'key-blue', 'key-yellow', 'key-red', 'patch', 'probe', 'degausser'])
      .concat(range('fx-', ['hit0', 'hit1', 'hit2', 'puff0', 'puff1', 'puff2', 'boom0', 'boom1', 'boom2', 'boom3'])),
    '8x8': range('ic-', ['health', 'armor', 'cell', 'coil', 'key-blue', 'key-yellow', 'key-red', 'patch', 'rack'])
      .concat(range('fx-', ['spark0', 'spark1', 'bolt0', 'bolt1', 'frost0', 'frost1'])),
    '48x48': range('enm-loader-', ['walk0', 'walk1', 'atk0', 'atk1', 'hurt', 'die0', 'die1', 'dead', 'tell']),
    '64x64': range('boss-chiller-', ['idle0', 'idle1', 'atk0', 'atk1', 'vent0', 'vent1', 'hurt', 'die0', 'die1', 'die2', 'dead']),
    '96x72': range('vw-driver-', ['idle', 'atk0', 'atk1']).concat(range('vw-probe-', ['idle', 'atk0', 'atk1']))
      .concat(range('vw-degausser-', ['idle', 'atk0', 'atk1', 'atk2']))
  };
  let n = 0;
  for (const [dims, names] of Object.entries(want)) {
    for (const name of names) {
      assert.equal(size(name), dims, name);
      n++;
    }
  }
  assert.equal(n, Object.keys(ALL).length, 'the art has nothing the spec does not name');
  // walls and flats are opaque and tile; the in-hand frames are bottom-aligned
  for (const name of want['32x32'].slice(0, 28)) assert.doesNotMatch(ALL[name].rows.join(''), /\./, name + ' is opaque');
});

test('cold-aisle pack: every texture the map can produce, and every sprite the tables name, is in the art', () => {
  const textures = new Set();
  for (const c of Object.values(cda.CDA_LEGEND)) if (c.tex) textures.add(c.tex);
  for (const [a, b] of Object.entries(cda.CDA_TEX_FRAMES)) textures.add(a).add(b);
  textures.add(cda.CDA_TEX_JAMB).add(cda.CDA_TEX_RACK_CLEAN).add(cda.CDA_TEX_LIFT_OPEN);
  for (const t of textures) assert.equal(size(t), '32x32', t);
  for (const t of cda.CDA_FLOORS.concat(cda.CDA_CEILS)) assert.equal(size(t), '32x32', t);
  for (const it of cda.CDA_ITEMS) assert.equal(size('it-' + it.id), '16x16', it.id);
  for (const d of cda.CDA_DECOR) assert.equal(size('dc-' + d.id), d.w + 'x' + d.h, d.id);
  for (const e of cda.CDA_ENEMIES) {
    const prefix = cda.CDA_FRAME_PREFIX[e.id];
    assert.equal(size(prefix + 'dead'), e.size + 'x' + e.size, e.id);
  }
  for (const t of cda.CDA_TOOLS) {
    assert.equal(size('vw-' + t.id + '-idle'), '96x72');
    for (const [frame] of cda.CDA_HAND[t.id]) assert.equal(size('vw-' + t.id + '-' + frame), '96x72', t.id + ' ' + frame);
  }
  for (const kind of ['spark', 'bolt', 'frost']) for (const f of [0, 1]) size('fx-' + kind + f);
  for (const fx of cda.CDA_FX) for (const name of fx.names) assert.equal(size(name), '16x16');
});

test('cold-aisle pack: the state -> frame table covers every state of every kind (the sim-enemies header) with frames in the art', () => {
  const states = {
    crawler: ['asleep', 'alert', 'chase', 'windup', 'attack', 'hurt', 'die', 'dead'],
    drone: ['asleep', 'alert', 'chase', 'windup', 'attack', 'hurt', 'die', 'dead'],
    turret: ['asleep', 'alert', 'chase', 'windup', 'attack', 'hurt', 'die', 'dead'],
    loader: ['asleep', 'alert', 'chase', 'windup', 'attack', 'hurt', 'stun', 'die', 'dead'],
    chiller: ['asleep', 'alert', 'idle', 'call', 'windup', 'attack', 'vent', 'hurt', 'die', 'dead']
  };
  assert.deepEqual(Object.keys(cda.CDA_FRAMES), cda.CDA_ENEMIES.map((e) => e.id));
  for (const [kind, list] of Object.entries(states)) {
    assert.deepEqual(Object.keys(cda.CDA_FRAMES[kind]).sort(), list.slice().sort(), kind);
    for (const s of list) {
      for (const f of cda.CDA_FRAMES[kind][s]) size(cda.CDA_FRAME_PREFIX[kind] + f);
    }
  }
  // the chiller's boss loop names only states the table has
  for (const s of cda.CDA_BOSS.loop) assert.ok(cda.CDA_FRAMES.chiller[s], s);
});

test('cold-aisle pack: cdaSpritePixels gives a sprite at full colour, row-major, 0 where transparent', () => {
  const rgb = (hex) => (0xff000000 | (parseInt(hex.slice(5, 7), 16) << 16) | (parseInt(hex.slice(3, 5), 16) << 8) | parseInt(hex.slice(1, 3), 16)) >>> 0;
  for (const name of ['ic-health', 'it-key-red', 'enm-loader-tell', 'door']) {
    const p = cda.cdaSpritePixels(name);
    const s = ALL[name];
    assert.equal(p.w, s.w);
    assert.equal(p.h, s.h);
    assert.ok(p.data instanceof Uint32Array);
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const ch = s.rows[y][x];
        assert.equal(p.data[y * s.w + x], ch === '.' ? 0 : rgb(cda.CDA_PALETTE[ch]), name + ' ' + x + ',' + y);
      }
    }
  }
  assert.equal(cda.cdaTextures(), T, 'built once');
});
