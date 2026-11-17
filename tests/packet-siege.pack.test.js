// tests/packet-siege.pack.test.js
// The packed sprite art of Packet Siege: build.js (packArt, packPixels,
// packNumber) turns the ASCII maps of src/sprites-*.js into short strings in
// script.js, and src/unpack-art.js (pksUnpackArt) restores them at start-up.
// Every sprite decoded from the built file must equal its map in src/, and
// the encoder must round-trip the edge cases (empty and one-pixel sprites,
// runs longer than one copy, every palette character, rows repeated across
// sprites, numbers of every length).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadScript, readRepoFile, REPO_ROOT } = require('./_setup');

const GAME = 'packet-siege';
const JS = readRepoFile(GAME + '/script.js');
const pks = loadScript(GAME + '/script.js');
const BUILD = require('../' + GAME + '/build.js');
const ART_PARTS = BUILD.PARTS.filter((p) => /^sprites-/.test(p));

// The decoder as src/ has it, in this realm (so deepEqual compares plain objects).
const UNPACK = new Function(readRepoFile(GAME + '/src/unpack-art.js') +
  '\nreturn { art: pksUnpackArt, number: pksUnpackNumber, digits: PKS_PACK_DIGITS, ends: PKS_PACK_ENDS };')();

// The ASCII maps of an art part, evaluated straight from src/ (not through build.js).
function sourceArt(part) {
  const text = readRepoFile(GAME + '/src/' + part + '.js');
  const name = /^var (PKS_ART_\w+) = \{$/m.exec(text)[1];
  return { name, art: new Function(text + '\nreturn ' + name + ';')() };
}

// The packed array of an art part as script.js holds it.
function builtPart(part) {
  const from = JS.indexOf('\n  // ── src/' + part + '.js ──\n');
  const section = JS.slice(from, JS.indexOf('\n  // ── src/', from + 1));
  const name = /^ {2}var (PKS_ART_\w+) = \[$/m.exec(section)[1];
  return { section, name, packed: new Function(section + '\nreturn ' + name + ';')() };
}

// Packs sprites ({ name: { w, h, rows } }) with build.js and unpacks them with
// unpack-art; returns the packed strings after checking the round trip.
function roundTrip(art) {
  const names = Object.keys(art);
  const streams = BUILD.packPixels(names.map((n) => art[n].rows.join('')));
  const packed = names.map((n, i) => n + ' ' + art[n].w + ' ' + art[n].h + ' ' + streams[i]);
  assert.deepEqual(UNPACK.art(packed), art);
  return streams;
}

const sprite = (rows, w) => ({ w: w === undefined ? rows[0].length : w, h: rows.length, rows });

// A small deterministic generator for the fuzzed parts.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('packet-siege pack: every sprite decoded from the built script.js is the ASCII map of its source part, in the same order', () => {
  const expected = {};
  for (const part of ART_PARTS) {
    const src = sourceArt(part);
    const built = builtPart(part);
    assert.equal(built.name, src.name, part);
    assert.deepEqual(UNPACK.art(built.packed), src.art, part + ' decodes to its source');
    Object.assign(expected, src.art);
  }
  assert.deepEqual(Object.keys(pks.pksSprites), Object.keys(expected), 'the names in the order of the parts');
  assert.deepEqual(pks.pksSprites, expected);
  assert.equal(Object.keys(expected).length, 293);
});

test('packet-siege pack: script.js holds each art part as its opening line and one \'name w h pixels\' string per sprite, in the alphabet', () => {
  const pixels = new RegExp('^[A-Za-z.' + BUILD.PACK_DIGITS.replace(/[\]\-^\\]/g, '\\$&') + ']*$');
  for (const part of ART_PARTS) {
    const head = readRepoFile(GAME + '/src/' + part + '.js').split('\n')[0];
    const { section, packed } = builtPart(part);
    const src = sourceArt(part).art;
    assert.ok(section.includes('\n\n  ' + head + '\n  var '), part + ' keeps its opening line');
    assert.doesNotMatch(section, /rows:|\{ w: /, part + ' holds no ASCII map');
    assert.deepEqual(packed.map((s) => s.split(' ').slice(0, 3).join(' ')), Object.keys(src).map((n) => n + ' ' + src[n].w + ' ' + src[n].h), part);
    for (const s of packed) {
      const f = s.split(' ');
      assert.equal(f.length, 4, s.slice(0, 40));
      assert.match(f[3], pixels, f[0]);
    }
  }
  // the source parts are about 300 KB of maps; packed they are a small share of the file
  const art = ART_PARTS.map((p) => builtPart(p).section.length).reduce((a, b) => a + b, 0);
  assert.ok(art < 45000, art + ' characters of packed art');
});

test('packet-siege pack: the alphabet has no quote, backslash, space, angle bracket or pixel character; build.js and unpack-art agree on it', () => {
  const D = BUILD.PACK_DIGITS;
  assert.equal(UNPACK.digits, D);
  assert.equal(new Set(D).size, D.length);
  assert.equal(D.length, 35);
  assert.equal(UNPACK.ends, 25);
  assert.doesNotMatch(D, /[A-Za-z.'"`\\\s<>]/);
  for (const k of Object.keys(pks.pksPalette)) assert.ok(!D.includes(k), k);
});

test('packet-siege pack: numbers of every length round-trip; 25 values take one digit, 250 two, 2500 three', () => {
  const values = [];
  for (let v = 0; v < 3000; v++) values.push(v);
  values.push(24999, 25000, 249999, 250000, 1e6, 2304, 46 * 48);
  for (const v of values) {
    const s = BUILD.packNumber(v);
    const r = { s: s + 'k', i: 0 };
    assert.equal(UNPACK.number(r), v, s);
    assert.equal(r.i, s.length, 'reads exactly the number: ' + s);
  }
  assert.deepEqual([0, 24, 25, 249, 250, 2499, 2500, 24999, 25000].map((v) => BUILD.packNumber(v).length), [1, 1, 2, 2, 3, 3, 4, 4, 5]);
});

test('packet-siege pack: edge cases round-trip: no sprites, empty and transparent rows, one pixel, long runs', () => {
  assert.deepEqual(BUILD.packPixels([]), []);
  assert.deepEqual(UNPACK.art([]), {});
  // a zero-width sprite has empty rows and an empty stream
  assert.deepEqual(roundTrip({ 'zero': sprite(['', '', ''], 0), 'dot': sprite(['k']) }), ['', 'k']);
  // one pixel, a pixel then a transparent row, a one-pixel-wide column
  roundTrip({ 'one': sprite(['.']), 'two': sprite(['w', '.']), 'col': sprite(['k', 'k', 'k', 'w', 'k']) });
  roundTrip({ 'blank': sprite(['........', '........', '........']), 'edge': sprite(['k.......', '........', '.......k']) });
  // runs far longer than one copy (the 48x48 boss size, all one colour), and
  // the same run again in the next sprite
  const solid = sprite(Array.from({ length: 48 }, () => 'k'.repeat(48)));
  const streams = roundTrip({ 'solid': solid, 'again': solid, 'dots': sprite(Array.from({ length: 48 }, () => '.'.repeat(48))) });
  // 2304 pixels: a pixel, then copies of at most 384 (four characters each)
  assert.ok(streams[0].length <= 1 + 6 * 4 && streams[1].length <= 6 * 4, streams.join(' | '));
  // a run of every length from 1 to 60 in a row of its own
  const runs = {};
  for (let n = 1; n <= 60; n++) runs['run' + n] = sprite(['y'.repeat(n) + '.'.repeat(60 - n)]);
  roundTrip(runs);
});

test('packet-siege pack: every palette character and transparency round-trip, alone, in runs and mixed', () => {
  const keys = Object.keys(pks.pksPalette).concat(['.']);
  assert.equal(keys.length, 48);
  const all = keys.join('');
  const art = { 'mixed': sprite([all, all.split('').reverse().join(''), all]) };
  for (const k of keys) art['solid-' + (k === '.' ? 'dot' : k + (k === k.toUpperCase() ? 'u' : 'l'))] = sprite([k, k + k, k.repeat(3)].map((r) => (r + '....').slice(0, 4)));
  roundTrip(art);
});

test('packet-siege pack: rows repeated across sprites come back as copies reaching into the earlier sprite', () => {
  const rows = ['..kkkk..', '.kwwwwk.', 'kwnccnwk', 'kwccccwk', '.kwwwwk.', '..kkkk..'];
  const streams = roundTrip({ 'first': sprite(rows), 'same': sprite(rows), 'shifted': sprite(rows.slice(2).concat(rows.slice(0, 2))), 'flipped': sprite(rows.slice().reverse()) });
  assert.match(streams[1], /^[^A-Za-z.]+$/, 'the same sprite again is copies only: ' + streams[1]);
  assert.ok(streams[1].length <= 4, 'one copy: ' + streams[1]);
  assert.ok(streams[2].length < 8 && streams[3].length < streams[0].length, streams.join(' | '));
});

test('packet-siege pack: fuzzed parts round-trip, and packing is deterministic', () => {
  const next = rng(20261117);
  for (let t = 0; t < 120; t++) {
    const colours = 'kKaAlNnwcC.'.slice(0, 1 + Math.floor(next() * 11));
    const art = {};
    const count = 1 + Math.floor(next() * 5);
    for (let s = 0; s < count; s++) {
      const w = Math.floor(next() * 40);
      const h = 1 + Math.floor(next() * 12);
      const rows = [];
      for (let y = 0; y < h; y++) {
        // copy the row above now and then, else random runs
        if (y && next() < 0.3) {
          rows.push(rows[y - 1]);
          continue;
        }
        let row = '';
        while (row.length < w) row += colours[Math.floor(next() * colours.length)].repeat(1 + Math.floor(next() * 6));
        rows.push(row.slice(0, w));
      }
      art['s' + t + '-' + s] = sprite(rows, w);
    }
    roundTrip(art);
  }
  const pixels = ART_PARTS.slice(0, 2).map((p) => Object.values(sourceArt(p).art).map((s) => s.rows.join('')));
  for (const part of pixels) assert.deepEqual(BUILD.packPixels(part), BUILD.packPixels(part));
});

test('packet-siege pack: packArt refuses what it cannot pack faithfully', () => {
  const part = (body) => '// ── art: test ──\n\nvar PKS_ART_TEST = {\n' + body + '\n};\n';
  const ok = part("  'a-1': { w: 2, h: 1, rows: ['k.'] }");
  assert.equal(BUILD.packArt(ok, 'sprites-test'), "// ── art: test ──\nvar PKS_ART_TEST = [\n  'a-1 2 1 k.'\n];");
  const bad = [
    ['// no art here\n', /no `var PKS_ART_\.\.\. = \{` line/],
    [part("  'Big Name': { w: 1, h: 1, rows: ['k'] }"), /sprite name "Big Name"/],
    [part("  'a': { w: 2, h: 1, rows: ['k'] }"), /a is not 2x1/],
    [part("  'a': { w: 1, h: 2, rows: ['k'] }"), /a is not 1x2/],
    [part("  'a': { w: 1, h: 1, rows: 'k' }"), /a is not 1x1/],
    [part("  'a': { w: 1, h: 1, rows: [1] }"), /a is not 1x1/],
    [part("  'a': { w: 2, h: 1, rows: ['k1'] }"), /a has the pixel "1"/],
    [part("  'a': { w: 2, h: 1, rows: ['k<'] }"), /a has the pixel "<"/],
    [part("  'a': { w: 2, h: 1, rows: ['k '] }"), /a has the pixel " "/]
  ];
  for (const [text, message] of bad) assert.throws(() => BUILD.packArt(text, 'sprites-test'), message);
});

test('packet-siege pack: build.js strips full-line comments only: code, trailing comments and a // inside a string or a regex survive', () => {
  const part = [
    '// ── test: what this part owns ──',
    '// a comment line',
    'var a = \'http://example.com\';  // a trailing comment stays',
    '  // an indented comment line',
    '\t// a tab-indented one',
    'var r = /\\/\\/+/g;',
    'var s = \'one \\',
    '// still the string\';',
    'var u = \'//\' + \'x\'; var w = 1 / 2 // 3',
    '',
    'function f() {',
    '    // inside a body',
    '  return a + \'//\';',
    '}'
  ].join('\n');
  const out = BUILD.stripComments(part);
  assert.equal(out, [
    '// ── test: what this part owns ──',
    'var a = \'http://example.com\';  // a trailing comment stays',
    'var r = /\\/\\/+/g;',
    'var s = \'one \\',
    '// still the string\';',
    'var u = \'//\' + \'x\'; var w = 1 / 2 // 3',
    '',
    'function f() {',
    '  return a + \'//\';',
    '}'
  ].join('\n'));
  const run = new Function(out + '\nreturn { a: a, r: r.source, s: s, u: u, w: w, f: f() };')();
  assert.deepEqual(run, { a: 'http://example.com', r: '\\/\\/+', s: 'one // still the string', u: '//x', w: 0.5, f: 'http://example.com//' });
  // the whole build: every code line of every part in order, no comment line but each part's first
  const built = BUILD.build();
  assert.equal(built, BUILD.build(), 'deterministic');
  let at = 0;
  for (const p of BUILD.PARTS.filter((name) => !/^sprites-/.test(name))) {
    const lines = readRepoFile(GAME + '/src/' + p + '.js').replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
    const from = built.indexOf('\n  // ── src/' + p + '.js ──\n', at);
    assert.ok(from >= at, p);
    const section = built.slice(from, built.indexOf('\n  // ── src/', from + 1) + 1 || undefined);
    assert.ok(section.includes('\n\n  ' + lines[0] + '\n'), p + ' keeps its opening line');
    const kept = lines.slice(1).filter((l) => !/^\s*\/\//.test(l)).map((l) => (l ? '  ' + l : '')).join('\n');
    assert.ok(section.includes(kept), p + ': every code line, in order, indented as before');
    assert.equal(section.split('\n').filter((l) => /^\s*\/\//.test(l)).length, 2, p + ': only the banner and the opening line are comments');
    at = from;
  }
  assert.match(built, /\n\/\/ Full-line comments are stripped here \(each part keeps its opening line\):\n\/\/ the readable source, every comment included, is packet-siege\/src\/\*\.js\.\n/);
  assert.ok(Buffer.byteLength(built) < 300000, Buffer.byteLength(built) + ' bytes');
});

test('packet-siege pack: build.js throws instead of writing a script.js that would end its script block or open a comment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pks-pack-'));
  try {
    fs.copyFileSync(path.join(REPO_ROOT, GAME, 'build.js'), path.join(dir, 'build.js'));
    fs.mkdirSync(path.join(dir, 'src'));
    for (const part of BUILD.PARTS) fs.copyFileSync(path.join(REPO_ROOT, GAME, 'src', part + '.js'), path.join(dir, 'src', part + '.js'));
    for (const token of ['-->', '<!--', '</SCRIPT']) {
      fs.appendFileSync(path.join(dir, 'src', 'main.js'), '\n// ' + token + '\n');
      const r = spawnSync(process.execPath, [path.join(dir, 'build.js')], { encoding: 'utf8' });
      assert.notEqual(r.status, 0, token);
      assert.match(r.stderr, new RegExp('script\\.js would contain "' + token.replace('/', '\\/') + '"', 'i'));
      assert.equal(fs.existsSync(path.join(dir, 'script.js')), false, 'nothing written');
      fs.copyFileSync(path.join(REPO_ROOT, GAME, 'src', 'main.js'), path.join(dir, 'src', 'main.js'));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
