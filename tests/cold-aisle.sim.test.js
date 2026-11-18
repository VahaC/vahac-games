// tests/cold-aisle.sim.test.js
// Cold Aisle's foundation: the build of script.js from its parts, the
// source rules (ES5, one closure, names, no DOM / clock / randomness in the
// simulation parts), the palette and the art decoder, the start-up guard,
// and the simulation around the player: movement and collision, doors,
// Use (doors, secrets, racks, the lift), items, tools in hand, the carried
// state and upgrades, results, death, and determinism.  Enemies and combat
// are in cold-aisle.sim-enemies.test.js, the boss in
// cold-aisle.sim-boss.test.js, the level format in cold-aisle.map.test.js.
// Test levels are small maps written here; numbers come from the tables.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { loadScript, readRepoFile, embedSafety, bootLikeBrowser, REPO_ROOT } = require('./_setup');

const GAME = 'cold-aisle';
const SCRIPT = GAME + '/script.js';
const JS = readRepoFile(SCRIPT);
const cda = loadScript(SCRIPT);
const BUILD = require(path.join(REPO_ROOT, GAME, 'build.js'));

const P = cda.CDA_PLAYER;
const S = (seconds) => cda.cdaSteps(seconds);

// ── helpers ────────────────────────────────────────────────────────────────

function level(map, over) {
  return Object.assign({ name: 'Test', briefing: 'A test.', facing: 'E', map }, over);
}

const ARMED = () => ({ tools: ['driver', 'probe', 'degausser'], ammo: { cell: 120, coil: 30 }, health: 100, armour: 0 });

function newSim(map, opts) {
  const o = opts || {};
  const lv = cda.cdaParseLevel(level(map, o.level));
  return cda.cdaNewSim(lv, o.carry || cda.cdaCarryNew(), o.upgrades || {}, o.seed === undefined ? 1 : o.seed);
}

function input(over) {
  return Object.assign(cda.cdaInputNew(), over);
}

// Runs n steps (inp: an input, or a function (sim, i) -> input); returns every event.
function run(sim, n, inp) {
  const events = [];
  for (let i = 0; i < n; i++) {
    cda.cdaStep(sim, typeof inp === 'function' ? inp(sim, i) : inp || cda.cdaInputNew());
    for (const e of sim.events) events.push(e);
  }
  return events;
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-9);

// ── build and source ───────────────────────────────────────────────────────

test('cold-aisle: script.js is build() of src/ and PARTS names files of src/ (art files wait for their group)', () => {
  const built = BUILD.build();
  const disk = fs.readFileSync(path.join(REPO_ROOT, SCRIPT), 'utf8');
  assert.equal(disk.replace(/\r\n/g, '\n'), built, 'run node cold-aisle/build.js');
  assert.doesNotMatch(built, /\r/, 'LF only');
  assert.ok(built.endsWith('})();\n'), 'one trailing newline after the IIFE');
  const files = fs.readdirSync(path.join(REPO_ROOT, GAME, 'src')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
  for (const part of BUILD.PARTS) assert.ok(files.includes(part), part + ' exists in src/');
  for (const file of files) assert.ok(BUILD.PARTS.includes(file) || /^art-/.test(file), file + ' is in PARTS');
  assert.equal(new Set(BUILD.PARTS).size, BUILD.PARTS.length);
  assert.deepEqual(BUILD.PARTS, [].concat(BUILD.SIM_PARTS, BUILD.LEVEL_PARTS, BUILD.ART_PARTS, BUILD.RENDER_PARTS, BUILD.SFX_PARTS,
    BUILD.UI_PARTS, ['main']));
  assert.deepEqual(BUILD.SIM_PARTS, ['core', 'palette', 'unpack-art', 'tables', 'map', 'sim', 'sim-combat', 'sim-enemies', 'sim-boss']);
  for (const part of BUILD.ART_PARTS) assert.match(part, /^art-/);
  assert.ok(Buffer.byteLength(JS) < 260 * 1024, 'script.js under 260 KB');
});

test('cold-aisle: PARTS is the set of files in src/: every file is a part and every part a file', () => {
  const files = fs.readdirSync(path.join(REPO_ROOT, GAME, 'src')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
  assert.deepEqual([...BUILD.PARTS].sort(), files.sort());
  assert.equal(new Set(BUILD.PARTS).size, BUILD.PARTS.length);
  assert.equal(BUILD.PARTS[0], 'core');
  assert.equal(BUILD.PARTS[BUILD.PARTS.length - 1], 'main');
});

test('cold-aisle: build.js --check passes on the repo and fails, writing nothing, on a stale copy', () => {
  const ok = spawnSync(process.execPath, [path.join(REPO_ROOT, GAME, 'build.js'), '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-build-'));
  try {
    fs.copyFileSync(path.join(REPO_ROOT, GAME, 'build.js'), path.join(dir, 'build.js'));
    fs.mkdirSync(path.join(dir, 'src'));
    for (const part of BUILD.PARTS) fs.copyFileSync(path.join(REPO_ROOT, GAME, 'src', part + '.js'), path.join(dir, 'src', part + '.js'));
    fs.writeFileSync(path.join(dir, 'script.js'), 'stale\n');
    const stale = spawnSync(process.execPath, [path.join(dir, 'build.js'), '--check'], { encoding: 'utf8' });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /script\.js is stale: run `node cold-aisle\/build\.js`/);
    assert.equal(fs.readFileSync(path.join(dir, 'script.js'), 'utf8'), 'stale\n');
    fs.rmSync(path.join(dir, 'script.js'));
    assert.equal(spawnSync(process.execPath, [path.join(dir, 'build.js'), '--check']).status, 1, 'a missing script.js is stale too');
    assert.equal(spawnSync(process.execPath, [path.join(dir, 'build.js')]).status, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'script.js'), 'utf8'), BUILD.build());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cold-aisle: the header says the file is generated and names the parts; every part sits under its banner in PARTS order', () => {
  const lines = JS.split('\n');
  assert.equal(lines[0], '// Cold Aisle — script.js, GENERATED by cold-aisle/build.js: do not edit by hand.');
  assert.ok(JS.includes('// Parts, in order: ' + BUILD.PARTS.map((p) => 'src/' + p + '.js').join(', ') + '.'));
  assert.match(JS, /\n\/\/ Prefix: cda-\n\/\/ Dependencies: none\.\n/);
  let at = 0;
  for (const part of BUILD.PARTS) {
    const next = JS.indexOf('\n  // ── src/' + part + '.js ──\n', at);
    assert.ok(next > at, part + ' banner in order');
    at = next;
  }
});

test('cold-aisle: every part is a fragment of the one closure: an opening comment, no IIFE or exports, under 900 lines', () => {
  for (const part of BUILD.PARTS) {
    const text = readRepoFile(GAME + '/src/' + part + '.js');
    assert.match(text, /^\/\/ ── [a-z][a-z-]*: .* ──\n/, part + ' opens with what it owns');
    assert.doesNotMatch(text, /\(function \(\) \{/, part + ' has no IIFE');
    assert.ok(text.split('\n').length < 900, part + ' stays under 900 lines');
    if (part !== 'main') assert.doesNotMatch(text, /module\.exports/, part + ' exports nothing');
    assert.doesNotMatch(text, /'use strict'/, part + ' leaves strict mode to the build');
  }
});

test('cold-aisle: script.js is one strict IIFE in ES5, embeds safely, and the simulation parts have no DOM, clock or randomness', () => {
  assert.match(JS, /^(\/\/[^\n]*\n)*\n?\(function \(\) \{\n {2}'use strict';/);
  assert.equal(JS.match(/\(function \(\) \{/g).length, 1, 'no inner IIFE');
  assert.equal(JS.match(/^\}\)\(\);/gm).length, 1);
  assert.match(JS, /if \(typeof module !== 'undefined' && module\.exports\) \{\n\s+module\.exports = CDA_API;/);
  const code = JS.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['nullish coalescing', /\?\?/], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['double-quoted string', /"/], ['async', /\basync\b|\bawait\b/],
    ['newer methods', /\.(padStart|padEnd|includes|find|findIndex|flat|flatMap|fill|assign|entries|values|repeat|startsWith|endsWith)\(/],
    ['Object.assign', /Object\.assign/], ['Array.from', /Array\.from/], ['Math.hypot / sign / trunc', /Math\.(hypot|sign|trunc)/],
    ['Math.random', /Math\.random/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
  assert.ok(BUILD.SIM_PARTS.length >= 9);
  for (const part of BUILD.SIM_PARTS) {
    const src = readRepoFile(GAME + '/src/' + part + '.js').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
    for (const [name, re] of [
      ['clock', /\bDate\b|\bperformance\b|setTimeout|setInterval|requestAnimationFrame/],
      ['DOM', /\bdocument\b|\bwindow\b|localStorage/],
      ['randomness', /Math\.random/]
    ]) {
      assert.doesNotMatch(src, re, part + ': ' + name);
    }
  }
  assert.deepEqual(embedSafety(JS), []);
});

test('cold-aisle: every export, top-level function and top-level variable is cda-named', () => {
  for (const key of Object.keys(cda)) assert.match(key, /^(cda[A-Z]\w*|CDA_[A-Z0-9_]+)$/, key);
  const fns = Array.from(JS.matchAll(/^ {2}function (\w+)/gm), (m) => m[1]);
  const vars = Array.from(JS.matchAll(/^ {2}var (\w+)/gm), (m) => m[1]);
  assert.ok(fns.length > 60 && vars.length > 30);
  for (const name of fns) assert.match(name, /^cda[A-Z]/, name);
  for (const name of vars) assert.match(name, /^CDA_[A-Z0-9_]+$/, name);
});

test('cold-aisle: the build packs art parts, unpack-art restores them exactly, and the build refuses broken art and unsafe text', () => {
  const art = [
    '// ── art-test: two sprites ──',
    'var CDA_ART_TEST = {',
    '  \'a-1\': { w: 4, h: 2, rows: [\'kkkk\', \'k..k\'] },',
    '  \'b\': { w: 3, h: 3, rows: [\'kkk\', \'k.k\', \'kkk\'] }',
    '};'
  ].join('\n');
  const packed = BUILD.packArt(art, 'art-test');
  assert.match(packed, /^\/\/ ── art-test: two sprites ──\nvar CDA_ART_TEST = \[\n {2}'a-1 4 2 /);
  const parts = vm.runInNewContext(packed + '\n;CDA_ART_TEST', {});
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(plain(cda.cdaUnpackArt(parts)), plain(vm.runInNewContext(art + '\n;CDA_ART_TEST', {})));
  // a long run takes a copy with a number past the first digit
  const long = 'k'.repeat(40) + 'w'.repeat(900);
  const [stream] = BUILD.packPixels([long]);
  assert.equal(cda.cdaUnpackArt(['x 940 1 ' + stream]).x.rows[0], long);
  assert.equal(cda.cdaUnpackNumber({ s: BUILD.packNumber(1234), i: 0 }), 1234);
  assert.throws(() => BUILD.packArt('// ── art-x: none ──\nvar X = {};', 'art-x'), /no `var CDA_ART_\.\.\. = \{` line/);
  assert.throws(() => BUILD.packArt(art.replace('\'b\'', '\'B\''), 'art-test'), /sprite name "B"/);
  assert.throws(() => BUILD.packArt(art.replace('w: 3, h: 3', 'w: 3, h: 2'), 'art-test'), /b is not 3x2/);
  assert.throws(() => BUILD.packArt(art.replace('\'k.k\'', '\'k7k\''), 'art-test'), /b has the pixel "7"/);
  assert.equal(BUILD.stripComments('// ── x: y ──\n// gone\ncode(); // kept\n  // gone too\nvar s = \'a\\\n// kept\';'),
    '// ── x: y ──\ncode(); // kept\nvar s = \'a\\\n// kept\';');
  const sources = {};
  for (const part of BUILD.PARTS) sources[part] = readRepoFile(GAME + '/src/' + part + '.js');
  assert.equal(BUILD.assemble(sources), JS);
  sources.core += '\n// </script>';
  assert.throws(() => BUILD.assemble(sources), /script\.js would contain "<\/script"/);
});

test('cold-aisle: CDA_PALETTE is Packet Siege\'s palette, the same letters and colours', () => {
  const pks = loadScript('packet-siege/script.js');
  assert.deepEqual(cda.CDA_PALETTE, pks.pksPalette);
  for (const [k, v] of Object.entries(cda.CDA_PALETTE)) {
    assert.match(k, /^[A-Za-z]$/);
    assert.match(v, /^#[0-9a-f]{6}$/);
  }
});

test('cold-aisle: in a browser, cdaInit runs once the document is parsed (skipped once the page part declares cdaInit)', (t) => {
  if (/\n {2}function cdaInit\(/.test(JS)) {
    t.skip('the page part owns cdaInit and its start-up tests');
    return;
  }
  let calls = 0;
  globalThis.cdaInit = () => { calls++; };
  try {
    const now = bootLikeBrowser(SCRIPT, []);
    assert.equal(calls, 1, 'a parsed document starts at once');
    now.restore();
    const later = bootLikeBrowser(SCRIPT, [], { readyState: 'loading' });
    assert.equal(calls, 1, 'not before DOMContentLoaded');
    later.ready();
    assert.equal(calls, 2);
    later.restore();
  } finally {
    delete globalThis.cdaInit;
  }
});

// ── core and tables ────────────────────────────────────────────────────────

test('cold-aisle: the constants, the fixed step and the helpers', () => {
  assert.deepEqual([cda.CDA_W, cda.CDA_H, cda.CDA_RATE, cda.CDA_MAX_FRAME, cda.CDA_MAX_SIZE], [320, 180, 120, 0.25, 64]);
  assert.equal(cda.CDA_STEP, 1 / 120);
  assert.equal(cda.cdaSteps(1.5), 180);
  assert.equal(cda.cdaDist(0, 0, 3, 4), 5);
  assert.equal(cda.cdaAngleTo(0, 0, 0, 1), Math.PI / 2);
  assert.ok(near(cda.cdaAngleDiff(0.5, 0), 0.5));
  assert.ok(near(cda.cdaAngleDiff(2 * Math.PI - 0.1, 0), -0.1));
  assert.ok(near(cda.cdaAngleDiff(0, 2 * Math.PI - 0.1), 0.1));
  const a = { rng: 7 };
  const b = { rng: 7 };
  const seq = [cda.cdaRand(a), cda.cdaRand(a), cda.cdaRand(a)];
  assert.deepEqual(seq, [cda.cdaRand(b), cda.cdaRand(b), cda.cdaRand(b)]);
  for (const v of seq) assert.ok(v >= 0 && v < 1);
  assert.equal(cda.cdaText('lift', { n: 2 }), 'The lift is locked: 2 infected rack(s) left');
});

test('cold-aisle: the tables hold the spec\'s ids, every id names its sprites, and the upgrade lines are six of three tiers', () => {
  assert.deepEqual(cda.CDA_TOOLS.map((t) => [t.id, t.slot]), [['driver', 1], ['probe', 2], ['degausser', 3]]);
  assert.deepEqual(cda.CDA_ENEMIES.map((e) => e.id), ['crawler', 'drone', 'turret', 'loader', 'chiller']);
  assert.deepEqual(cda.CDA_ITEMS.map((e) => e.id), ['cell', 'coil', 'coffee', 'medkit', 'vest', 'key-blue', 'key-yellow', 'key-red',
    'patch', 'probe', 'degausser']);
  assert.deepEqual(cda.CDA_DECOR.map((e) => e.id), ['cart', 'chair', 'spool', 'crate', 'extinguisher', 'cone', 'ladder', 'lamp', 'pillar']);
  for (const d of cda.CDA_DECOR) assert.equal(d.solid, d.radius > 0, d.id);
  assert.equal(cda.CDA_DEC.pillar.h, 64);
  assert.equal(cda.CDA_UPGRADES.length, 6);
  for (const u of cda.CDA_UPGRADES) assert.equal(u.costs.length, 3);
  for (const t of cda.CDA_TOOLS) if (t.ammo) assert.ok(cda.CDA_ITEMS.some((i) => i.ammo === t.ammo && !i.tool), t.ammo);
  for (const ph of cda.CDA_BOSS.phases) {
    assert.equal(ph.bolts % 2, 1, 'odd fans: the middle bolt flies at the player');
    for (const s of cda.CDA_BOSS.loop) assert.ok(ph[s] > 0, s);
  }
  for (const k of Object.keys(cda.CDA_TEXT)) assert.equal(typeof cda.cdaText(k, { item: 'X', n: 1 }), 'string');
});

// ── a new sim, carried state and upgrades ──────────────────────────────────

test('cold-aisle: a new sim starts the player as carried, raised to the entry health and capped; the last tool is in hand', () => {
  const box = ['#####', '#@..#', '#####'];
  const fresh = cda.cdaCarryNew();
  assert.deepEqual(fresh, { tools: ['driver'], ammo: { cell: 0, coil: 0 }, health: P.health, armour: 0 });
  const sim = newSim(box, { carry: fresh });
  assert.equal(sim.status, 'playing');
  assert.equal(sim.player.health, P.health);
  assert.equal(sim.player.tool, 'driver');
  assert.deepEqual(sim.events, []);
  const low = newSim(box, { carry: { tools: ['driver', 'probe'], ammo: { cell: 9999, coil: 9999 }, health: 1, armour: 9999 } });
  assert.equal(low.player.health, P.entryHealth);
  assert.equal(low.player.tool, 'probe');
  assert.deepEqual(low.player.ammo, { cell: cda.CDA_TOOL.probe.cap, coil: cda.CDA_TOOL.degausser.cap });
  assert.equal(low.player.armour, P.armourMax);
  const high = newSim(box, { carry: Object.assign(ARMED(), { health: 9999 }) });
  assert.equal(high.player.health, high.player.maxHealth);
  assert.deepEqual(JSON.parse(JSON.stringify(high)), high, 'plain data');
  // what a level hands to the next
  high.player.ammo.cell = 7;
  high.player.health = 33;
  high.player.armour = 12;
  const out = cda.cdaCarryFrom(high);
  assert.deepEqual(out, { tools: ['driver', 'probe', 'degausser'], ammo: { cell: 7, coil: cda.CDA_TOOL.degausser.cap }, health: 33, armour: 12 });
  out.tools.push('x');
  assert.equal(high.player.tools.length, 3, 'a copy');
});

test('cold-aisle: upgrades apply when a sim is made: health, cell capacity, probe damage and speed, degausser rays, flashlight', () => {
  const U = cda.CDA_UPGRADE;
  const all = { health: 3, cells: 2, probeDamage: 1, probeSpeed: 3, rays: 2, flashlight: 1 };
  const sim = newSim(['#####', '#@..#', '#####'], { upgrades: all, carry: Object.assign(ARMED(), { health: 999 }) });
  const T = cda.CDA_TOOL;
  assert.equal(sim.player.maxHealth, P.health + 3 * U.health.step);
  assert.equal(sim.player.health, sim.player.maxHealth);
  assert.equal(sim.player.caps.cell, T.probe.cap + 2 * U.cells.step);
  assert.equal(sim.tools.probe.damage, T.probe.damage + U.probeDamage.step);
  assert.equal(sim.tools.probe.cooldown, S(T.probe.cooldown * (1 - 3 * U.probeSpeed.step)));
  assert.equal(sim.tools.degausser.rays, T.degausser.rays + 2 * U.rays.step);
  assert.equal(sim.player.flashlight, P.flashlight + U.flashlight.step);
  assert.equal(cda.cdaUpgradeBonus({}, 'health'), 0);
  const none = newSim(['#####', '#@..#', '#####']);
  assert.equal(none.tools.probe.cooldown, S(T.probe.cooldown));
  assert.equal(none.tools.driver.cooldown, S(T.driver.cooldown));
});

// ── the player ─────────────────────────────────────────────────────────────

test('cold-aisle: the player moves at its speed, turns by the input, strafes right, keeps the last step for interpolation', () => {
  const sim = newSim(['############', '#..........#', '#....@.....#', '#..........#', '############']);
  const p = sim.player;
  const x0 = p.x;
  run(sim, cda.CDA_RATE, input({ move: 1 }));
  assert.ok(near(p.x - x0, P.speed, 1e-6), 'one second forward');
  assert.ok(near(p.px, p.x - P.speed * cda.CDA_STEP, 1e-9));
  const y0 = p.y;
  run(sim, 30, input({ strafe: 1 }));
  assert.ok(near(p.y - y0, P.speed * 30 * cda.CDA_STEP, 1e-6), 'strafe right is +y facing east');
  run(sim, 1, input({ turn: 0.25 }));
  assert.equal(p.angle, 0.25);
  assert.equal(p.pangle, 0);
  // diagonal input is no faster
  const sx = p.x;
  const sy = p.y;
  run(sim, 1, input({ move: 1, strafe: 1 }));
  assert.ok(near(cda.cdaDist(sx, sy, p.x, p.y), P.speed * cda.CDA_STEP, 1e-9));
});

test('cold-aisle: walls stop the player at its radius and it slides along them; solid decor and enemies stop it, chairs do not', () => {
  const sim = newSim(['#######', '#@.n.x#', '#.....#', '#######']);
  const p = sim.player;
  run(sim, 240, input({ move: 1 }));
  assert.ok(p.x < 5.5 - cda.CDA_DEC.crate.radius - p.radius + 1e-9, 'stopped by the crate');
  assert.ok(p.x > 4.5, 'walked through the chair');
  // into the north wall at a slant: slides east
  const sim2 = newSim(['#######', '#.....#', '#@....#', '#######']);
  const q = sim2.player;
  q.angle = -0.6;
  run(sim2, 120, input({ move: 1 }));
  assert.ok(near(q.y, 1 + q.radius, 0.05) && q.y >= 1 + q.radius, 'against the wall');
  assert.ok(q.x > 1.5 + 0.9 * P.speed * Math.cos(0.6), 'slid along it at its speed along the wall');
  // an enemy body: blocked moving in, free to move out of an overlap
  const sim3 = newSim(['#######', '#@.t..#', '#######']);
  const e = sim3.enemies[0];
  assert.equal(cda.cdaMove(sim3, sim3.player, 1.6, 0), true, 'into the turret');
  assert.ok(sim3.player.x < e.x - e.radius - sim3.player.radius + 1e-9);
  sim3.player.x = e.x - 0.3;
  assert.equal(cda.cdaMove(sim3, sim3.player, -0.1, 0), false, 'out of an overlap');
  assert.equal(cda.cdaHitsBodies(sim3, e, e.x - 0.05, e.y), true, 'the enemy is stopped by the player too');
  e.hp = 0;
  assert.equal(cda.cdaHitsBodies(sim3, sim3.player, e.x, e.y), false, 'a corpse stops nothing');
});

test('cold-aisle: tools: a number key switches to an owned tool, the switch blocks firing a moment, unowned slots do nothing', () => {
  const sim = newSim(['#######', '#@....#', '#######'], { carry: { tools: ['driver', 'probe'], ammo: { cell: 10, coil: 5 }, health: 100, armour: 0 } });
  const p = sim.player;
  assert.equal(p.tool, 'probe');
  let ev = run(sim, 1, input({ weapon: 1 }));
  assert.deepEqual(ofType(ev, 'switch'), [{ type: 'switch', tool: 'driver', auto: false }]);
  assert.equal(p.switchT, S(P.switchTime));
  assert.equal(ofType(run(sim, 1, input({ weapon: 1 })), 'switch').length, 0, 'already in hand');
  assert.equal(ofType(run(sim, 1, input({ weapon: 3 })), 'switch').length, 0, 'not owned');
  ev = run(sim, S(P.switchTime) - 3, input({ fire: true }));
  assert.equal(ofType(ev, 'shot').length, 0, 'lowered while switching');
  ev = run(sim, 1, input({ fire: true }));
  assert.equal(ofType(ev, 'shot').length, 1);
  assert.equal(p.fireT, 0);
  run(sim, 5);
  assert.equal(p.fireT, 5);
});

// ── doors ──────────────────────────────────────────────────────────────────

test('cold-aisle: Use opens a door in reach; it slides open, stays while someone stands in it, then closes by itself', () => {
  const sim = newSim(['#######', '#@.+..#', '#######']);
  const d = sim.doors[0];
  const p = sim.player;
  assert.equal(ofType(run(sim, 1, input({ use: true })), 'door').length, 0, 'out of reach');
  p.x = 2.5;
  run(sim, 1);
  let ev = run(sim, 1, input({ use: true }));
  assert.deepEqual(ofType(ev, 'door'), [{ type: 'door', cell: d.cell, x: 3.5, y: 1.5, kind: 'plain', open: true, by: 'player' }]);
  assert.equal(d.state, 'opening');
  assert.equal(d.popen, 0);
  assert.equal(d.open, 1 / S(cda.CDA_DOOR_OPEN_TIME));
  assert.equal(ofType(run(sim, 3, input({ use: true })), 'door').length, 0, 'held Use acts once');
  run(sim, S(cda.CDA_DOOR_OPEN_TIME));
  assert.equal(d.state, 'open');
  assert.equal(d.open, 1);
  // stand in it: it stays open
  run(sim, 20, input({ move: 1 }));
  assert.equal(cda.cdaCellOf(sim, p.x, p.y), d.cell);
  run(sim, S(cda.CDA_DOOR_STAY) + 10);
  assert.equal(d.state, 'open');
  p.x = 4 + p.radius + 0.05;
  ev = run(sim, S(cda.CDA_DOOR_STAY));
  assert.deepEqual(ofType(ev, 'door').map((e) => [e.open, e.by]), [[false, 'time']]);
  assert.equal(d.state, 'closing');
  // stepping back in while it closes (and is still open enough) opens it again
  ev = run(sim, 5, input({ move: -1 }));
  assert.deepEqual(ofType(ev, 'door').map((e) => [e.open, e.by]), [[true, 'body']]);
  run(sim, 30, input({ move: 1 }));
  run(sim, S(cda.CDA_DOOR_STAY) + S(cda.CDA_DOOR_OPEN_TIME) * 2 + 2);
  assert.equal(d.state, 'closed');
  assert.equal(d.open, 0);
  assert.equal(cda.cdaSolid(sim, d.cell), true);
});

test('cold-aisle: a locked door refuses Use without its badge and names it; picking up the badge opens it', () => {
  const sim = newSim(['#########', '#....#..#', '#@.B.b..#', '#....#..#', '#########']);
  const p = sim.player;
  p.x = 4.5;
  let ev = run(sim, 1, input({ use: true }));
  assert.deepEqual(ofType(ev, 'doorLocked'), [{ type: 'doorLocked', cell: sim.doors[0].cell, x: 5.5, y: 2.5, badge: 'blue' }]);
  assert.deepEqual(ofType(ev, 'message'), [{ type: 'message', text: 'Blue badge needed' }]);
  assert.equal(sim.doors[0].state, 'closed');
  p.x = 2.5;
  ev = run(sim, 40, input({ move: 1 }));
  assert.deepEqual(ofType(ev, 'pickup').map((e) => e.item), ['key-blue']);
  assert.equal(p.badges.blue, true);
  p.x = 4.5;
  run(sim, 1);
  ev = run(sim, 1, input({ use: true }));
  assert.deepEqual(ofType(ev, 'door').map((e) => [e.kind, e.by]), [['blue', 'player']]);
});

// ── Use: secrets, racks, the lift ──────────────────────────────────────────

test('cold-aisle: a secret wall opens for good on Use and counts in the stats', () => {
  const sim = newSim(['#####', '#@$*#', '#####']);
  assert.equal(sim.stats.secretsTotal, 1);
  const ev = run(sim, 1, input({ use: true }));
  assert.deepEqual(ofType(ev, 'secret'), [{ type: 'secret', cell: 7, x: 2.5, y: 1.5 }]);
  assert.equal(ofType(ev, 'message')[0].text, cda.CDA_TEXT.secret);
  assert.equal(sim.map.kind[7], 'floor');
  assert.equal(sim.map.tex[7], '');
  assert.equal(sim.stats.secrets, 1);
  run(sim, 60, input({ move: 1 }));
  assert.equal(sim.stats.patches, 1, 'the patch behind it');
});

test('cold-aisle: a rack reboots while Use is held on it; letting go or looking away interrupts; the last one opens the lift', () => {
  const sim = newSim(['#####', '#X.X#', '#.@.#', '#.L.#', '#####'], { level: { facing: 'N' } });
  const p = sim.player;
  p.y = 1.5;
  p.x = 1.5 + 0.8;
  p.angle = Math.PI;
  const total = S(P.reboot);
  assert.equal(sim.liftOpen, false);
  assert.equal(sim.map.tex[2 * 5 + 2 + 5], 'lift-locked');
  let ev = run(sim, 10, input({ use: true }));
  assert.deepEqual(ofType(ev, 'rebootStart'), [{ type: 'rebootStart', rack: 0, cell: 6, x: 1.5, y: 1.5 }]);
  assert.equal(sim.reboot, 0);
  assert.equal(sim.racks[0].progress, 10 / total);
  ev = run(sim, 1);
  assert.deepEqual(ofType(ev, 'rebootStop'), [{ type: 'rebootStop', rack: 0, cell: 6, x: 1.5, y: 1.5 }]);
  assert.equal(sim.racks[0].progress, 0);
  run(sim, 10, input({ use: true }));
  ev = run(sim, 1, input({ use: true, turn: Math.PI }));
  assert.equal(ofType(ev, 'rebootStop').length, 1, 'turned to face the other rack');
  assert.equal(ofType(ev, 'rebootStart').length, 1);
  ev = run(sim, total - 1, input({ use: true }));
  assert.deepEqual(ofType(ev, 'rebootDone'), [{ type: 'rebootDone', rack: 1, cell: 8, x: 3.5, y: 1.5, left: 1 }]);
  assert.equal(sim.map.tex[8], cda.CDA_TEX_RACK_CLEAN);
  assert.equal(sim.racks[1].state, 'clean');
  assert.equal(sim.reboot, -1);
  assert.equal(ofType(run(sim, 10, input({ use: true })), 'rebootStart').length, 0, 'a clean rack does nothing');
  // the lift is still locked
  p.x = 2.5;
  p.y = 2.5;
  p.angle = Math.PI / 2;
  run(sim, 1);
  ev = run(sim, 1, input({ use: true }));
  assert.deepEqual(ofType(ev, 'liftLocked'), [{ type: 'liftLocked', left: 1 }]);
  assert.equal(ofType(ev, 'message')[0].text, cda.cdaText('lift', { n: 1 }));
  p.y = 1.5;
  p.angle = Math.PI;
  run(sim, 1);
  ev = run(sim, total, input({ use: true }));
  assert.equal(ofType(ev, 'liftOpen').length, 1);
  assert.equal(ofType(ev, 'message').map((m) => m.text).join('|'), cda.CDA_TEXT.rebooted + '|' + cda.CDA_TEXT.open);
  assert.equal(sim.map.tex[2 * 5 + 2 + 5], cda.CDA_TEX_LIFT_OPEN);
  p.y = 2.5;
  p.angle = Math.PI / 2;
  run(sim, 1);
  ev = run(sim, 1, input({ use: true }));
  assert.deepEqual(ofType(ev, 'win'), [{ type: 'win' }]);
  assert.equal(sim.status, 'won');
  const tick = sim.tick;
  assert.deepEqual(run(sim, 5, input({ move: 1 })), [], 'a finished level stands still');
  assert.equal(sim.tick, tick);
  const r = cda.cdaResult(sim);
  assert.deepEqual(r, { won: true, time: tick * cda.CDA_STEP, kills: 0, enemies: 0, secrets: 0, secretsTotal: 0,
    patches: cda.CDA_REWARDS.finish });
});

test('cold-aisle: a level without racks or a boss starts with the lift open; with a chiller alive the lift says so', () => {
  const open = newSim(['#####', '#@L.#', '#####']);
  assert.equal(open.liftOpen, true);
  assert.equal(open.map.tex[7], cda.CDA_TEX_LIFT_OPEN);
  const boss = newSim(['#########', '#@L.....#', '#.......#', '#......Z#', '#########']);
  assert.equal(boss.liftOpen, false);
  const ev = run(boss, 1, input({ use: true }));
  assert.equal(ofType(ev, 'message')[0].text, cda.CDA_TEXT.boss);
  boss.enemies[0].hp = 0;
  cda.cdaLiftCheck(boss);
  assert.equal(boss.liftOpen, true);
});

// ── items ──────────────────────────────────────────────────────────────────

test('cold-aisle: items give what their row says and stay on the floor when they would do nothing', () => {
  const sim = newSim(['##############', '#@cofmvRPPG**#', '##############'], {
    carry: { tools: ['driver'], ammo: { cell: 0, coil: 0 }, health: 100, armour: 0 } });
  const p = sim.player;
  p.health = 60;
  p.armour = 90;
  p.ammo.cell = p.caps.cell - 5;
  const ev = run(sim, 400, input({ move: 1 }));
  const I = cda.CDA_ITEM;
  const got = ofType(ev, 'pickup').map((e) => e.item);
  assert.deepEqual(got, ['cell', 'coil', 'coffee', 'medkit', 'vest', 'key-red', 'probe', 'degausser', 'patch', 'patch']);
  assert.equal(p.ammo.cell, p.caps.cell, 'cells up to the cap; the second probe brought nothing new');
  assert.equal(p.ammo.coil, I.coil.amount + I.degausser.amount);
  assert.equal(p.health, Math.min(p.maxHealth, 60 + I.coffee.health + I.medkit.health));
  assert.equal(p.armour, P.armourMax);
  assert.equal(p.badges.red, true);
  assert.deepEqual(p.tools, ['driver', 'probe', 'degausser']);
  assert.equal(p.tool, 'degausser', 'a new tool comes into hand');
  assert.deepEqual(ofType(ev, 'switch').map((e) => e.tool), ['probe', 'degausser']);
  assert.equal(sim.stats.patches, 2);
  assert.deepEqual(sim.items.filter((i) => !i.taken).map((i) => i.kind), ['probe'], 'the second probe stays');
  assert.deepEqual(ofType(ev, 'message').slice(0, 2).map((m) => m.text), [I.cell.name, I.coil.name]);
  // full health, full armour, a badge held, an owned tool with full ammo: all stay
  const full = newSim(['#########', '#@fvBBP.#', '#########'], { carry: { tools: ['driver', 'probe'], ammo: { cell: 999, coil: 0 }, health: 100, armour: 100 } });
  const ev2 = run(full, 300, input({ move: 1 }));
  assert.deepEqual(ofType(ev2, 'pickup').map((e) => e.item), ['key-blue']);
  // the probe owned but short of cells: it gives its cells and no switch
  const refill = newSim(['######', '#@P..#', '######'], { carry: { tools: ['driver', 'probe'], ammo: { cell: 0, coil: 0 }, health: 100, armour: 0 } });
  const ev3 = run(refill, 100, input({ move: 1 }));
  assert.equal(refill.player.ammo.cell, I.probe.amount);
  assert.equal(ofType(ev3, 'switch').length, 0);
});

// ── death, results, determinism ────────────────────────────────────────────

test('cold-aisle: health 0 ends the level as dead; the result earns only picked patches', () => {
  const sim = newSim(['#####', '#@..#', '#####']);
  sim.stats.patches = 2;
  sim.stats.kills = 5;
  cda.cdaHurtPlayer(sim, 1000, 2, 1, 'crawler');
  assert.equal(sim.status, 'dead');
  assert.equal(sim.player.health, 0);
  assert.deepEqual(ofType(sim.events, 'death'), [{ type: 'death' }]);
  cda.cdaHurtPlayer(sim, 10, 2, 1, 'crawler');
  assert.equal(ofType(sim.events, 'death').length, 1, 'once');
  assert.deepEqual(run(sim, 3), []);
  const r = cda.cdaResult(sim);
  assert.equal(r.won, false);
  assert.equal(r.patches, 2);
  sim.status = 'won';
  sim.stats.secrets = 1;
  const R = cda.CDA_REWARDS;
  assert.equal(cda.cdaResult(sim).patches, R.finish + 5 * R.kill + R.secret + 2);
});

// A level with every kind of enemy, doors, items and a rack.
const ARENA = [
  '##################',
  '#@.......+.....d.#',
  '#........#.......#',
  '#..c...d.#...s...#',
  '#######+##...t...#',
  '#X....l..#.......#',
  '#........#..s....#',
  '##################'
];

// A scripted run: it walks, turns, fires and uses on a fixed timetable.
function scripted(sim, steps) {
  return run(sim, steps, (s, i) => input({
    move: i % 300 < 200 ? 1 : -0.5, strafe: i % 170 < 60 ? 1 : 0, turn: i % 97 < 10 ? 0.03 : -0.004,
    fire: i % 50 < 20, use: i % 80 === 0, weapon: i % 400 === 0 ? 2 : 0
  }));
}

const hash = (sim) => crypto.createHash('sha256').update(JSON.stringify(sim)).digest('hex');

test('cold-aisle: the sim is deterministic: same level, seed and inputs give the same state; a JSON copy plays on identically', () => {
  const a = newSim(ARENA, { carry: ARMED(), seed: 42 });
  const b = newSim(ARENA, { carry: ARMED(), seed: 42 });
  const evA = scripted(a, 1500);
  const evB = scripted(b, 1500);
  assert.equal(hash(a), hash(b));
  assert.deepEqual(evA, evB);
  assert.ok(ofType(evA, 'shot').length > 10 && ofType(evA, 'wake').length > 0, 'the run did things');
  const copy = JSON.parse(JSON.stringify(a));
  scripted(a, 600);
  scripted(copy, 600);
  assert.equal(hash(copy), hash(a));
  const c = newSim(ARENA, { carry: ARMED(), seed: 43 });
  scripted(c, 2100);
  assert.notEqual(hash(c), hash(a), 'the seed matters (the drone strafes)');
});

test('cold-aisle: the automap marks cells the player has seen as it looks around', () => {
  const sim = newSim(ARENA);
  const seen = () => sim.map.seen.reduce((s, v) => s + v, 0);
  const before = seen();
  assert.ok(before > 0);
  assert.equal(sim.map.seen[5 * 18 + 1], 0, 'the rack room is out of sight');
  run(sim, 200, input({ turn: 0.05 }));
  assert.ok(seen() > before);
});
