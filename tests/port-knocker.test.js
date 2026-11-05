// tests/port-knocker.test.js
// Port Knocker (port-knocker/, prefix pkn-).
//
// The pure logic is loaded with loadScript and checked against models
// written here (expected orders, the show timeline, FNV-1a and the Daily
// numbers). The page is booted like a browser from the real index.html
// (bootLikeBrowser) and driven through the listeners the game registers:
// clicks on ports and buttons, keys, select changes, visibilitychange.
// setTimeout, setInterval and Date come from t.mock.timers, performance.now
// from a mock that moves with them (one millisecond at a time), Math.random
// is seeded, so nothing waits on the real clock and every run is the same.
// Unless a test says otherwise the date is 2026-11-05 12:00 local time:
// Daily #5, a Reverse Daily (target 8 knocks) on 6 ports.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, bootLikeBrowser, createPage, resetStubs, fire, pressKey, touchEvent, focusElement,
  setVisibility, blockStorage, seeded, listenerCount, readRepoFile, idsInHtml, htmlPageSpec,
  embedMarkup, embedSafety, cssRules, declsAt
} = require('./_setup');

const GAME = 'port-knocker';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);
const RULES = cssRules(CSS);

const STATE = 'pkn-state';
const BEST = 'pkn-best';
const DAILY = 'pkn-daily';
const SOUND = 'pkn-sound';
const PORT_NUMBERS = [22, 80, 443, 3306, 53, 8080, 5432, 6379, 8096];
const SERVICES = ['ssh', 'http', 'https', 'mysql', 'dns', 'proxy', 'postgres', 'redis', 'jellyfin'];
const TIMER_APIS = ['setTimeout', 'setInterval', 'Date'];

// Local wall-clock times (the Daily follows the local calendar date).
const at = (y, m, d, h = 12, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s).getTime();
const NOV5 = at(2026, 11, 5);

const STORAGE_NOTE = 'progress, best scores and the Daily result will not be saved.';

test.beforeEach(() => resetStubs());

// ── Independent models ──────────────────────────────────────────────────────

// The knocks owed for a shown sequence.
function owed(seq, mode) {
  const out = [];
  if (mode === 'reverse') {
    for (let i = seq.length - 1; i >= 0; i--) out.push(seq[i]);
  } else {
    for (let i = 0; i < seq.length; i += mode === 'stride' ? 2 : 1) out.push(seq[i]);
  }
  return out;
}

// FNV-1a 32 bit, written out with BigInt arithmetic.
function fnv1a(text) {
  let hash = 0x811c9dc5n;
  for (const ch of text) {
    hash ^= BigInt(ch.charCodeAt(0));
    hash = (hash * 0x01000193n) % 0x100000000n;
  }
  return Number(hash);
}

// The extension rule: rnd picks one of the ports other than the last one,
// in index order.
function extendModel(seq, rnd, size) {
  const last = seq.length ? seq[seq.length - 1] : -1;
  const choices = [];
  for (let p = 0; p < size; p++) if (p !== last) choices.push(p);
  return [...seq, choices[Math.floor(rnd() * choices.length)]];
}

// A day's sequence: the harness's mulberry32 (seeded) on the FNV-1a seed.
function dailyModel(day, length, size = 6) {
  const rnd = seeded(fnv1a('pkn:' + day));
  let seq = [];
  while (seq.length < length) seq = extendModel(seq, rnd, size);
  return seq;
}

// Daily numbers by counting calendar days from 2026-11-01 (#1).
function dailyNumberModel(day) {
  const [y, m, d] = day.split('-').map(Number);
  let n = 1;
  const cursor = new Date(Date.UTC(2026, 10, 1));
  const end = new Date(Date.UTC(y, m - 1, d));
  const step = end >= cursor ? 1 : -1;
  while (cursor.getTime() !== end.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + step);
    n += step;
  }
  return n;
}

const DAILY_MODES = ['forward', 'reverse', 'stride'];
const TARGETS = { forward: 10, reverse: 8, stride: 12 };
const MODE_LABEL = { forward: 'Forward', reverse: 'Reverse', stride: 'Stride' };

// ── Pages ────────────────────────────────────────────────────────────────────

// One clock per test: t.mock.timers (setTimeout, setInterval, Date) and a
// performance.now that moves with it. A second call in the same test is a
// reload: the old page's timers go, the date goes on (or jumps to when).
const clocks = new WeakMap();
function clockFor(t, when) {
  let clock = clocks.get(t);
  if (clock) {
    const now = when === undefined ? Date.now() : when;
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: TIMER_APIS, now });
    return clock;
  }
  let perf = 1000;
  t.mock.timers.enable({ apis: TIMER_APIS, now: when === undefined ? NOV5 : when });
  t.mock.method(performance, 'now', () => perf);
  clock = {
    advance(ms) {
      for (let i = 0; i < ms; i++) {
        perf += 1;
        t.mock.timers.tick(1);
      }
    },
    perf: () => perf
  };
  clocks.set(t, clock);
  return clock;
}

// Math.random, seeded once per test; a later page load with a seed of its
// own (another player) starts that seed's sequence.
const randoms = new WeakMap();
function mockRandom(t, seed) {
  const mock = randoms.get(t);
  if (!mock) randoms.set(t, t.mock.method(Math, 'random', seeded(seed === undefined ? 1 : seed)));
  else if (seed !== undefined) mock.mock.mockImplementation(seeded(seed));
}

function writeStorage(values) {
  for (const [key, value] of Object.entries(values || {})) {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

// The page as a browser loads it, after writing storage.
function openPage(t, { storage, when, readyState, seed } = {}) {
  const clock = clockFor(t, when);
  mockRandom(t, seed);
  writeStorage(storage);
  const b = bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), { readyState });
  return view(b, clock);
}

// A reload: the page goes, storage stays.
function reload(t, page, options = {}) {
  page.restore();
  return openPage(t, options);
}

function view(b, clock) {
  const els = b.els;
  const v = {
    els,
    clock,
    page: b.page,
    ready: b.ready,
    restore: b.restore,
    el: (name) => els['pkn-' + name],
    text: (name) => els['pkn-' + name].textContent,
    ports: () => els['pkn-panel'].children,
    marked: (cls) => v.ports().map((p, i) => (p.classList.contains(cls) ? i : -1)).filter((i) => i >= 0),
    lit: () => v.marked('pkn-port-lit'),
    tap: (i) => v.ports()[i].click(),
    tapAll: (list) => list.forEach((i) => v.tap(i)),
    click: (name) => els['pkn-' + name].click(),
    choose: (name, value) => {
      els['pkn-' + name].value = String(value);
      return fire(els['pkn-' + name], 'change');
    },
    saved: (key = STATE) => JSON.parse(localStorage.getItem(key)),
    label: () => els['pkn-start'].textContent,
    toastOn: () => els['pkn-toast'].classList.contains('pkn-show'),
    shown: (name) => !els['pkn-' + name].classList.contains('pkn-hidden'),
    dots: () => els['pkn-progress'].children.map((d) => (d.classList.contains('pkn-dot-on') ? 1 : 0)),
    // Runs the show to its end, recording each port as it lights up and
    // each log line.
    watch(limit = 30000) {
      const flashed = [];
      const logs = [];
      let before = [];
      for (let i = 0; i < limit && v.label() !== 'Knock!'; i++) {
        clock.advance(1);
        const now = v.lit();
        for (const p of now) if (!before.includes(p)) flashed.push(p);
        before = now;
        const log = els['pkn-log'].textContent;
        if (log && logs[logs.length - 1] !== log) logs.push(log);
      }
      assert.equal(v.label(), 'Knock!', 'the show ended and the input began');
      return { flashed, logs };
    },
    // Watches the show and knocks back what it owes.
    playRound() {
      v.watch();
      const s = v.saved();
      v.tapAll(owed(s.sequence, s.mode));
      return s;
    }
  };
  return v;
}

const fresh = (extra) => Object.assign({ v: 1, kind: 'practice', mode: 'forward', size: 4, sequence: [0, 1, 2], round: 1, result: 'playing', day: null }, extra);
const record = (extra) => Object.assign({ day: '2026-11-05', number: 5, status: 'playing', score: 0, streak: 0, lastWin: 0 }, extra);

// ── Files ────────────────────────────────────────────────────────────────────

test('port-knocker: every id the script looks up exists once in index.html; ids, classes, custom properties, storage keys and exports are pkn- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\('([^']+)'\)/g), (m) => m[1]);
  assert.equal(ids.length, 30);
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^pkn-/);

  const markupClasses = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(markupClasses.length > 30);
  for (const name of markupClasses) assert.match(name, /^pkn-/);
  const selectors = new Set();
  for (const rule of RULES) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) {
        assert.match(m[1], /^pkn-/, selector);
        selectors.add(m[1]);
      }
    }
  }
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^pkn-/);
  const jsProps = Array.from(JS.matchAll(/setProperty\('--([\w-]+)'/g), (m) => m[1]);
  assert.deepEqual(jsProps.sort(), ['pkn-cols', 'pkn-window-delay', 'pkn-window-ms']);
  for (const m of JS.matchAll(/var\(--([\w-]+)/g)) assert.match(m[1], /^pkn-/);
  for (const m of CSS.matchAll(/@keyframes\s+([\w-]+)/g)) assert.match(m[1], /^pkn-/);

  // Every class the script sets has a rule; 'pkn-out-' + kind for each kind.
  const literals = Array.from(JS.matchAll(/'(pkn-[a-z0-9-]+)'/g), (m) => m[1]);
  const keys = [STATE, BEST, DAILY, SOUND];
  for (const name of new Set(literals)) {
    if (htmlIds.includes(name) || keys.includes(name)) continue;
    if (name.endsWith('-')) {
      for (const kind of ['ok', 'err', 'warn']) assert.ok(selectors.has(name + kind), name + kind);
    } else {
      assert.ok(selectors.has(name), 'a CSS rule for .' + name);
    }
  }
  for (const name of markupClasses) assert.ok(selectors.has(name), 'a CSS rule for .' + name);

  // Storage keys and Node exports.
  const stored = Array.from(JS.matchAll(/var PKN_\w+_KEY = '([^']+)'/g), (m) => m[1]);
  assert.deepEqual(stored.sort(), [BEST, DAILY, SOUND, STATE]);
  assert.doesNotMatch(JS.replace(/localStorage\.(getItem|setItem)\(key/g, ''), /localStorage\.\w+\(/, 'storage goes through the guarded helpers');
  const pkn = loadScript(SCRIPT);
  assert.ok(Object.keys(pkn).length > 20);
  for (const name of Object.keys(pkn)) assert.match(name, /^pkn[A-Z]/);
});

test('port-knocker: index.html is a standalone page like the other games, and the files embed safely', () => {
  assert.match(HTML, /^<!DOCTYPE html>\n<html lang="en">/);
  assert.ok(HTML.includes('<title>Port Knocker — Logs from VahaC</title>'));
  assert.match(HTML, /<meta name="description" content="Port Knocker: [^"]{60,}">/);
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  const rule = '<style>body { margin: 0; background: #0a0f1e; }</style>';
  assert.ok(head.includes(rule), 'the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.equal(declsAt(RULES, '.pkn-wrapper', 1280)['--pkn-bg-primary'], '#0a0f1e');
  assert.equal((HTML.match(/class="pkn-wrapper"/g) || []).length, 1, 'one wrapper');
  assert.match(HTML, /<script src="script\.js"><\/script>\n<\/body>\n<\/html>\n$/);
  assert.doesNotMatch(HTML, /https?:\/\//, 'no external resources');
  assert.doesNotMatch(CSS, /@import|url\(/, 'no external fonts or images');
  assert.doesNotMatch(JS, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//, 'no network');

  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="pkn-wrapper" id="pkn-game">'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.doesNotMatch(embedded, /<style/i);

  // The settings offer the three modes and the three panel sizes.
  const options = (id) => Array.from(HTML.slice(HTML.indexOf('id="' + id + '"')).split('</select>')[0].matchAll(/value="([^"]+)"/g), (m) => m[1]);
  assert.deepEqual(options('pkn-mode'), ['forward', 'reverse', 'stride']);
  assert.deepEqual(options('pkn-size'), ['4', '6', '9']);
  // The play area takes the focus; the result card starts hidden.
  const spec = htmlPageSpec(HTML);
  assert.equal(spec['pkn-stage'].attributes.tabindex, '0');
  assert.match(spec['pkn-stage'].attributes['aria-label'], /Keys 1 to 9/);
  assert.match(spec['pkn-result'].className, /pkn-hidden/);
  assert.equal(spec['pkn-share-text'].readOnly, true);
  assert.equal(spec['pkn-sound'].attributes['aria-pressed'], 'false');
  // The Daily button's name follows its state (set by the script), so the
  // page carries no fixed one that would hide "Resume" or "done".
  assert.equal(spec['pkn-daily'].attributes['aria-label'], undefined);
});

test('port-knocker: script.js is one strict IIFE in ES5 behind the start-up guard', () => {
  assert.match(JS, /^(\/\/[^\n]*\n)*\n?\(function \(\) \{\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1);
  assert.match(JS, /if \(typeof module !== 'undefined' && module\.exports\) \{[\s\S]*\} else if \(document\.readyState === 'loading'\) \{\n\s*document\.addEventListener\('DOMContentLoaded', pknInit\);\n\s*\} else \{\n\s*pknInit\(\);/);
  const code = JS.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['nullish', /\?\?/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
  assert.doesNotMatch(JS.slice(JS.indexOf('// ── Daily (pure)'), JS.indexOf('// ── Save parsing')), /Math\.random/, 'Daily content never uses Math.random');
});

test('port-knocker: phones 320-414 px fit a 3-column panel of big ports, full-width controls and no fixed widths that overflow', () => {
  const px = (value) => {
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value).trim());
    assert.ok(m, 'a px length: ' + value);
    return Number(m[1]);
  };
  const sides = (value) => {
    const parts = String(value).trim().split(/\s+/).map(px);
    return parts.length === 1 ? parts[0] : parts[1];
  };
  for (let vw = 320; vw <= 414; vw++) {
    const wrapper = declsAt(RULES, '.pkn-wrapper', vw);
    const stage = declsAt(RULES, '.pkn-stage', vw);
    const face = declsAt(RULES, '.pkn-faceplate', vw);
    const panel = declsAt(RULES, '.pkn-panel', vw);
    const port = declsAt(RULES, '.pkn-port', vw);
    const jack = declsAt(RULES, '.pkn-jack', vw);
    assert.equal(declsAt(RULES, '.pkn-wrapper *', vw)['box-sizing'], 'border-box');
    const border = (decls) => px(decls.border.split(/\s+/)[0]);
    const content = vw - 2 * sides(wrapper.padding);
    const inner = content - 2 * px(stage.padding) - 2 * border(stage) - 2 * px(face.padding) - 2 * border(face);
    for (const cols of [2, 3]) {
      const width = (inner - (cols - 1) * px(panel.gap)) / cols;
      assert.ok(width >= 70, vw + 'px: ' + cols + ' columns of ' + width.toFixed(1) + 'px ports');
      const room = width - 2 * sides(port.padding) - 2 * border(port);
      assert.ok(px(jack.width) + 2 * px(jack.border.split(/\s+/)[0]) <= room, vw + 'px: the jack fits its port');
    }
    assert.ok(px(port['min-height']) >= 88, vw + 'px: tall ports');
    assert.equal(port['min-width'], '0');
    assert.equal(panel['grid-template-columns'], 'repeat(var(--pkn-cols, 2), minmax(0, 1fr))');
    assert.equal(declsAt(RULES, '.pkn-stats', vw)['grid-template-columns'], 'repeat(2, minmax(0, 1fr))');
    assert.equal(declsAt(RULES, '.pkn-actions', vw)['grid-template-columns'], 'repeat(2, minmax(0, 1fr))');
    assert.equal(declsAt(RULES, '.pkn-select', vw).width, '100%');
    assert.equal(declsAt(RULES, '.pkn-btn--start', vw).width, '100%');
    assert.equal(declsAt(RULES, '.pkn-btn--start', vw)['min-width'], '0');
    for (const sel of ['.pkn-console', '.pkn-status', '.pkn-note', '.pkn-result-title', '.pkn-toast']) {
      assert.equal(declsAt(RULES, sel, vw)['overflow-wrap'], 'anywhere', sel);
    }
    // No rule gives anything a fixed width wider than the content box.
    for (const rule of RULES) {
      for (const sel of rule.selectors) {
        const decls = declsAt(RULES, sel, vw);
        for (const prop of ['width', 'min-width']) {
          const m = /^(\d+(?:\.\d+)?)px$/.exec(decls[prop] || '');
          if (m) assert.ok(Number(m[1]) <= content, vw + 'px: ' + sel + ' ' + prop + ' ' + decls[prop]);
        }
      }
    }
  }
  assert.equal(declsAt(RULES, '.pkn-toast', 320)['max-width'], 'calc(100vw - 32px)');
  assert.equal(declsAt(RULES, '.pkn-toast', 320)['pointer-events'], 'none');
  // Page scrolling is never blocked: only the panel sets touch-action, to
  // manipulation (no double-tap zoom delay), and nothing sets none.
  const touch = RULES.filter((rule) => rule.decls['touch-action']);
  assert.deepEqual(touch.map((rule) => [rule.selectors.join(), rule.decls['touch-action']]), [['.pkn-panel', 'manipulation']]);
  assert.equal(declsAt(RULES, '.pkn-wrapper', 1280)['max-width'], '860px');
  assert.equal(declsAt(RULES, '.pkn-panel', 1280)['max-width'], 'calc(var(--pkn-cols, 2) * 150px)');
  assert.equal(declsAt(RULES, '.pkn-hidden', 320).display, 'none');
});

// ── Pure logic ───────────────────────────────────────────────────────────────

test('port-knocker: pknExtendSequence adds one port drawn from rnd, never the last one, and leaves the input alone', () => {
  const pkn = loadScript(SCRIPT);
  const seq = [1, 2];
  const next = pkn.pknExtendSequence(seq, () => 0, 4);
  assert.deepEqual(seq, [1, 2]);
  assert.deepEqual(next, [1, 2, 0]);
  for (const size of [4, 6, 9]) {
    // The first knock can be any port.
    for (let k = 0; k < size; k++) {
      assert.deepEqual(pkn.pknExtendSequence([], () => (k + 0.5) / size, size), [k], size + ' first ' + k);
    }
    // Later knocks: the other ports in index order.
    for (let last = 0; last < size; last++) {
      for (let k = 0; k < size - 1; k++) {
        const rnd = () => (k + 0.5) / (size - 1);
        assert.deepEqual(pkn.pknExtendSequence([last], rnd, size), extendModel([last], rnd, size), size + ' after ' + last);
      }
      // A draw just below 1 still lands on a real port.
      const top = pkn.pknExtendSequence([last], () => 0.9999999999, size)[1];
      assert.equal(top, last === size - 1 ? size - 2 : size - 1);
    }
  }
  // A long seeded run: in range, never twice in a row, every port used.
  const rnd = seeded(42);
  let long = [];
  for (let i = 0; i < 3000; i++) long = pkn.pknExtendSequence(long, rnd, 9);
  assert.equal(long.length, 3000);
  for (let i = 0; i < long.length; i++) {
    assert.ok(long[i] >= 0 && long[i] < 9 && long[i] % 1 === 0);
    if (i) assert.notEqual(long[i], long[i - 1]);
  }
  assert.equal(new Set(long).size, 9);
});

test('port-knocker: pknExpectedOrder gives Forward as shown, Reverse backwards and Stride every second knock', () => {
  const pkn = loadScript(SCRIPT);
  assert.deepEqual(pkn.pknExpectedOrder([0, 1, 2, 3, 4], 'forward'), [0, 1, 2, 3, 4]);
  assert.deepEqual(pkn.pknExpectedOrder([0, 1, 2, 3, 4], 'reverse'), [4, 3, 2, 1, 0]);
  assert.deepEqual(pkn.pknExpectedOrder([0, 1, 2, 3, 4], 'stride'), [0, 2, 4]);
  assert.deepEqual(pkn.pknExpectedOrder([5, 1, 7, 2], 'stride'), [5, 7]);
  const rnd = seeded(9);
  for (let n = 0; n < 200; n++) {
    let seq = [];
    const length = 3 + (n % 15);
    while (seq.length < length) seq = extendModel(seq, rnd, 9);
    const copy = seq.slice();
    for (const mode of DAILY_MODES) {
      const out = pkn.pknExpectedOrder(seq, mode);
      assert.deepEqual(out, owed(seq, mode), mode + ' ' + seq);
      assert.notEqual(out, seq, 'a new array');
    }
    assert.deepEqual(seq, copy, 'the sequence is left alone');
  }
});

test('port-knocker: pknCheckInput says ok, done or wrong for each knock; scores, rounds, the pace and the log line', () => {
  const pkn = loadScript(SCRIPT);
  const expected = [2, 0, 3];
  assert.equal(pkn.pknCheckInput(expected, [], 2), 'ok');
  assert.equal(pkn.pknCheckInput(expected, [2], 0), 'ok');
  assert.equal(pkn.pknCheckInput(expected, [2, 0], 3), 'done');
  assert.equal(pkn.pknCheckInput(expected, [], 0), 'wrong');
  assert.equal(pkn.pknCheckInput(expected, [2, 0], 2), 'wrong');
  assert.equal(pkn.pknCheckInput(expected, [2, 0, 3], 3), 'wrong', 'a knock past the end');
  assert.equal(pkn.pknCheckInput([1], [], 1), 'done');

  // The longest repeated sequence: a passed round counts its length, a failed
  // one the round before, and a failed first round (3 knocks) scores 0.
  assert.equal(pkn.pknScoreFor(3, true), 3);
  assert.equal(pkn.pknScoreFor(3, false), 0);
  assert.equal(pkn.pknScoreFor(4, false), 3);
  assert.equal(pkn.pknScoreFor(9, false), 8);
  assert.equal(pkn.pknScoreFor(9, true), 9);
  assert.deepEqual([3, 4, 10].map(pkn.pknRoundFor), [1, 2, 8]);

  // 600 ms in round 1, 35 ms less each round, never below 250 ms.
  const pace = [600, 565, 530, 495, 460, 425, 390, 355, 320, 285, 250, 250, 250];
  assert.deepEqual(pace.map((ms, i) => pkn.pknIntervalFor(i + 1)), pace);
  assert.equal(pkn.pknIntervalFor(100), 250);

  // The log line: nothing before round 5, then 2 knocks, one more every
  // second round, always leaving two to flash.
  assert.deepEqual([1, 2, 3, 4].map((r) => pkn.pknLogCountFor(r, r + 2)), [0, 0, 0, 0]);
  assert.deepEqual([5, 6, 7, 8, 9, 10, 11].map((r) => pkn.pknLogCountFor(r, r + 2)), [2, 2, 3, 3, 4, 4, 5]);
  assert.equal(pkn.pknLogCountFor(5, 4), 2);
  assert.equal(pkn.pknLogCountFor(5, 3), 1);
  for (let r = 5; r < 60; r++) assert.ok(r + 2 - pkn.pknLogCountFor(r, r + 2) >= 2);
});

test('port-knocker: pknShowSteps times the show: lead-in, the log line from round 5, then each flash at the round\'s pace', () => {
  const pkn = loadScript(SCRIPT);
  // Round 1: 600 ms apart, lit for 360 ms, after a 500 ms lead-in; the input
  // begins 200 ms after the last flash.
  assert.deepEqual(pkn.pknShowSteps([3, 1, 2]), [
    { at: 500, type: 'on', port: 3, index: 0 },
    { at: 860, type: 'off', port: 3, index: 0 },
    { at: 1100, type: 'on', port: 1, index: 1 },
    { at: 1460, type: 'off', port: 1, index: 1 },
    { at: 1700, type: 'on', port: 2, index: 2 },
    { at: 2060, type: 'off', port: 2, index: 2 },
    { at: 2260, type: 'end' }
  ]);
  // Round 5 (7 knocks): the first 2 in the log line for 900 + 2 x 450 ms,
  // a 300 ms gap, then 5 flashes 460 ms apart, lit for 276 ms.
  assert.deepEqual(pkn.pknShowSteps([0, 1, 2, 3, 0, 1, 2]), [
    { at: 500, type: 'log', ports: [0, 1] },
    { at: 2300, type: 'unlog' },
    { at: 2600, type: 'on', port: 2, index: 2 },
    { at: 2876, type: 'off', port: 2, index: 2 },
    { at: 3060, type: 'on', port: 3, index: 3 },
    { at: 3336, type: 'off', port: 3, index: 3 },
    { at: 3520, type: 'on', port: 0, index: 4 },
    { at: 3796, type: 'off', port: 0, index: 4 },
    { at: 3980, type: 'on', port: 1, index: 5 },
    { at: 4256, type: 'off', port: 1, index: 5 },
    { at: 4440, type: 'on', port: 2, index: 6 },
    { at: 4716, type: 'off', port: 2, index: 6 },
    { at: 4916, type: 'end' }
  ]);
  // Every round up to 40: in time order, a dark gap between flashes, the
  // flashed knocks are the sequence after the logged ones.
  const rnd = seeded(5);
  let seq = [];
  while (seq.length < 3) seq = extendModel(seq, rnd, 6);
  for (let round = 1; round <= 40; round++, seq = extendModel(seq, rnd, 6)) {
    const steps = pkn.pknShowSteps(seq);
    const logged = pkn.pknLogCountFor(round, seq.length);
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i].at > steps[i - 1].at, 'round ' + round);
    assert.deepEqual(steps.filter((s) => s.type === 'on').map((s) => s.port), seq.slice(logged));
    const log = steps.find((s) => s.type === 'log');
    assert.deepEqual(log ? log.ports : [], seq.slice(0, logged));
    assert.equal(steps[steps.length - 1].type, 'end');
    const ons = steps.filter((s) => s.type === 'on');
    for (let i = 1; i < ons.length; i++) assert.equal(ons[i].at - ons[i - 1].at, pkn.pknIntervalFor(round));
  }
});

test('port-knocker: digits pick ports in reading order, with 9 ports like a numeric keypad, also by physical key', () => {
  const pkn = loadScript(SCRIPT);
  const key = (k, code) => ({ key: k, code: code === undefined ? (/^[0-9]$/.test(k) ? 'Digit' + k : '') : code });
  for (const size of [4, 6]) {
    for (let d = 1; d <= 9; d++) assert.equal(pkn.pknKeyToPort(key(String(d)), size), d <= size ? d - 1 : null, size + ' ' + d);
  }
  // 7 8 9 / 4 5 6 / 1 2 3 over the 3x3 panel.
  const grid = [7, 8, 9, 4, 5, 6, 1, 2, 3];
  grid.forEach((d, index) => {
    assert.equal(pkn.pknKeyToPort(key(String(d)), 9), index, 'digit ' + d);
    assert.equal(pkn.pknKeyLabel(index, 9), String(d));
    assert.equal(pkn.pknKeyToPort(key('End', 'Numpad' + d), 9), index, 'keypad without Num Lock');
  });
  for (let i = 0; i < 6; i++) assert.equal(pkn.pknKeyLabel(i, 6), String(i + 1));
  // AZERTY: the 1 key types '&' and still knocks; the key value wins.
  assert.equal(pkn.pknKeyToPort(key('&', 'Digit1'), 4), 0);
  assert.equal(pkn.pknKeyToPort(key('2', 'Digit5'), 4), 1);
  assert.equal(pkn.pknKeyToPort(key('3', 'Numpad3'), 4), 2);
  for (const k of [key('0'), key('a', 'KeyA'), key('Enter', 'Enter'), key(' ', 'Space'), { key: undefined, code: undefined }, key('10', ''), key('Digit1', 'KeyQ')]) {
    assert.equal(pkn.pknKeyToPort(k, 9), null, JSON.stringify(k));
  }
});

test('port-knocker: the Daily rule: local day key, #1 on 2026-11-01 counted DST-safe, FNV-1a and mulberry32 seeds, the day\'s sequence and mode', () => {
  const pkn = loadScript(SCRIPT);
  assert.equal(pkn.pknDayKey(new Date(2026, 10, 5, 23, 59)), '2026-11-05');
  assert.equal(pkn.pknDayKey(new Date(2026, 0, 9, 0, 0)), '2026-01-09');
  assert.equal(pkn.pknDayKey(new Date(2027, 11, 31, 12)), '2027-12-31');
  assert.equal(pkn.pknDailyNumber('2026-11-01'), 1);
  assert.equal(pkn.pknDailyNumber('2026-11-05'), 5);
  assert.equal(pkn.pknDailyNumber('2026-10-31'), 0);
  for (const day of ['2026-12-01', '2027-03-28', '2027-03-29', '2027-10-31', '2027-11-01', '2028-02-29', '2030-06-15']) {
    assert.equal(pkn.pknDailyNumber(day), dailyNumberModel(day), day);
  }
  for (const ok of ['2026-11-05', '2028-02-29', '1999-12-31']) assert.equal(pkn.pknIsDayKey(ok), true, ok);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-1-5', '20261105', ' 2026-11-05', '0099-01-01', 20261105, null, undefined, {}]) {
    assert.equal(pkn.pknIsDayKey(bad), false, String(bad));
  }

  // FNV-1a test vectors and the model.
  assert.equal(pkn.pknFnv1a(''), 0x811c9dc5);
  assert.equal(pkn.pknFnv1a('a'), 0xe40c292c);
  assert.equal(pkn.pknFnv1a('foobar'), 0xbf9cf968);
  for (const text of ['pkn:2026-11-05', 'pkn:2026-11-06', 'ppl:2026-11-05']) assert.equal(pkn.pknFnv1a(text), fnv1a(text));
  // mulberry32 is the harness's seeded().
  for (const seed of [0, 1, 0xdeadbeef, fnv1a('pkn:2026-11-05')]) {
    const a = pkn.pknMulberry32(seed);
    const b = seeded(seed);
    for (let i = 0; i < 50; i++) assert.equal(a(), b(), 'seed ' + seed);
  }
  // The day's sequence: the model, the same on every call, a prefix of a
  // longer one, another day another sequence.
  const nov5 = pkn.pknDailySequence('2026-11-05', 12, 6);
  assert.deepEqual(nov5, dailyModel('2026-11-05', 12));
  assert.deepEqual(pkn.pknDailySequence('2026-11-05', 12, 6), nov5);
  assert.deepEqual(pkn.pknDailySequence('2026-11-05', 4, 6), nov5.slice(0, 4));
  assert.notDeepEqual(pkn.pknDailySequence('2026-11-06', 12, 6), nov5);
  // Forward, Reverse, Stride in turn on 6 ports, each with its target.
  for (let n = -4; n <= 12; n++) {
    const mode = DAILY_MODES[((n - 1) % 3 + 3) % 3];
    assert.deepEqual(pkn.pknDailyConfig(n), { mode, size: 6, target: TARGETS[mode] }, '#' + n);
  }
  assert.equal(pkn.pknDailyConfig(5).mode, 'reverse');
});

test('port-knocker: the streak lives while the last win is today\'s or yesterday\'s Daily, and the share line names the result', () => {
  const pkn = loadScript(SCRIPT);
  assert.equal(pkn.pknStreakFor(null, 5), 0);
  assert.equal(pkn.pknStreakFor({ streak: 3, lastWin: 5 }, 5), 3);
  assert.equal(pkn.pknStreakFor({ streak: 3, lastWin: 4 }, 5), 3);
  assert.equal(pkn.pknStreakFor({ streak: 3, lastWin: 3 }, 5), 0, 'a missed day');
  assert.equal(pkn.pknStreakFor({ streak: 3, lastWin: 0 }, 1), 0, 'no win yet');
  assert.equal(pkn.pknShareText(record({ status: 'won', score: 8 })), 'Port Knocker #5 Reverse 6 ports seq 8/8, ssh: connection established');
  assert.equal(pkn.pknShareText(record({ day: '2026-11-06', number: 6, status: 'lost', score: 4 })), 'Port Knocker #6 Stride 6 ports seq 4/12, connection refused');
  assert.equal(pkn.pknShareText(record({ day: '2026-11-04', number: 4, status: 'lost', score: 0 })), 'Port Knocker #4 Forward 6 ports seq 0/10, connection refused');
  // The share line names the score as a sequence length, never as knocks
  // (a Stride Daily of 12 is won with 6 knocks).
  assert.doesNotMatch(pkn.pknShareText(record({ day: '2026-11-06', number: 6, status: 'won', score: 12 })), /knock/);
});

test('port-knocker: pknLaterDaily keeps the record of the later day, the stored one on the same day, and counts a dayless one as the oldest', () => {
  const pkn = loadScript(SCRIPT);
  const nov3 = record({ day: '2026-11-03', number: 3 });
  const nov4 = record({ day: '2026-11-04', number: 4 });
  const nov4b = record({ day: '2026-11-04', number: 4, score: 6 });
  const dayless = record({ day: null, number: 0, streak: 2, lastWin: 4 });
  const dayless2 = record({ day: null, number: 0 });
  // [stored, memory] -> the one that counts.
  const cases = [
    [null, null, null],
    [null, nov3, nov3],
    [nov3, null, nov3],
    [nov4, nov3, nov4],
    [nov3, nov4, nov4],
    [nov4b, nov4, nov4b],
    [dayless, nov3, nov3],
    [nov3, dayless, nov3],
    [dayless, dayless2, dayless],
    [null, dayless, dayless]
  ];
  for (const [stored, memory, want] of cases) {
    assert.equal(pkn.pknLaterDaily(stored, memory), want, JSON.stringify([stored && stored.day, memory && memory.day]));
  }
});

test('port-knocker: pknParseState falls back field by field and refuses what is no save', () => {
  const pkn = loadScript(SCRIPT);
  const parse = (value) => pkn.pknParseState(typeof value === 'string' ? value : JSON.stringify(value));
  const good = { kind: 'practice', mode: 'reverse', size: 6, sequence: [5, 0, 3, 1], result: 'playing', day: null };
  assert.deepEqual(parse(fresh(good)), good);
  for (const text of ['', '{', 'null', '42', '"x"', 'true', '[]', '[1,2,3]']) assert.equal(parse(text), null, text);
  assert.equal(pkn.pknParseState(null), null);
  const base = () => fresh({ mode: 'stride', size: 9, sequence: [8, 0, 4, 2] });
  const field = (extra) => parse(Object.assign(base(), extra));
  assert.deepEqual(parse({}), { kind: 'practice', mode: 'forward', size: 4, sequence: null, result: 'playing', day: null });
  for (const mode of ['insane', ['stride'], 'toString', 7, null]) assert.equal(field({ mode }).mode, 'forward', String(mode));
  for (const size of [5, '6', 0, null, 9.5]) {
    const out = field({ size });
    assert.equal(out.size, 4, String(size));
    assert.equal(out.sequence, null, 'ports 8 and 4 do not exist on 4 ports');
  }
  for (const sequence of [null, 'x', {}, [0, 1], [0, 1, 9], [0, 1, -1], [0, 1, 1.5], [0, '1', 2], [0, null, 2], Array(201).fill(0)]) {
    const out = field({ sequence });
    assert.equal(out.sequence, null, JSON.stringify(sequence).slice(0, 40));
    assert.equal(out.mode, 'stride', 'the other fields stay');
    assert.equal(out.size, 9);
  }
  assert.deepEqual(field({ sequence: Array(200).fill(1) }).sequence.length, 200);
  for (const result of ['won', 'bogus', null]) assert.equal(field({ result }).result, 'playing', String(result));
  assert.equal(field({ result: 'lost' }).result, 'lost');
  // A Daily or replay needs a real day; anything else is practice.
  assert.deepEqual(field({ kind: 'daily', day: '2026-11-05' }), { kind: 'daily', mode: 'stride', size: 9, sequence: [8, 0, 4, 2], result: 'playing', day: '2026-11-05' });
  assert.equal(field({ kind: 'replay', day: '2026-11-04', result: 'won' }).result, 'won');
  for (const extra of [{ kind: 'daily' }, { kind: 'daily', day: '2026-02-30' }, { kind: 'replay', day: 5 }, { kind: 'weird', day: '2026-11-05' }, { kind: ['daily'], day: '2026-11-05' }]) {
    const out = field(extra);
    assert.equal(out.kind, 'practice', JSON.stringify(extra));
    assert.equal(out.day, null);
  }
  // The stored copy is not shared.
  const text = JSON.stringify(base());
  const a = pkn.pknParseState(text);
  a.sequence.push(1);
  assert.deepEqual(pkn.pknParseState(text).sequence, [8, 0, 4, 2]);
});

test('port-knocker: pknParseBest keeps whole positive lengths of known keys; pknParseDaily falls back field by field', () => {
  const pkn = loadScript(SCRIPT);
  assert.deepEqual(pkn.pknParseBest(JSON.stringify({ 'forward-4': 7, 'reverse-6': -1, 'stride-9': 2.5, 'bogus-4': 9, 'forward-6': '5', 'reverse-9': 12, 'stride-4': 0 })), { 'forward-4': 7, 'reverse-9': 12 });
  for (const text of [null, '', '{', '[]', '5', 'null']) assert.deepEqual(pkn.pknParseBest(text), {}, String(text));

  const parse = (value) => pkn.pknParseDaily(typeof value === 'string' ? value : JSON.stringify(value));
  assert.deepEqual(parse(record({ status: 'won', score: 8, streak: 2, lastWin: 5 })), record({ status: 'won', score: 8, streak: 2, lastWin: 5 }));
  for (const text of [null, '', '{', '[]', '7', 'null', '"x"']) assert.equal(parse(text), null, String(text));
  // The number always comes from the day.
  assert.equal(parse(record({ number: 99 })).number, 5);
  // An unknown status counts as lost: no second scored attempt.
  for (const status of ['bogus', null, 7, 'toString']) assert.equal(parse(record({ status })).status, 'lost', String(status));
  // Scores: whole and capped at the target (one below while playing).
  assert.equal(parse(record({ status: 'won', score: 50 })).score, 8);
  assert.equal(parse(record({ status: 'playing', score: 50 })).score, 7);
  for (const score of [-1, 2.5, '3', null]) assert.equal(parse(record({ score })).score, 0, String(score));
  for (const streak of [-1, 2.5, '3', null]) assert.equal(parse(record({ streak })).streak, 0, String(streak));
  for (const lastWin of [-1, 2.5, '3', null]) assert.equal(parse(record({ lastWin })).lastWin, 0, String(lastWin));
  // A record without a readable day matches no day but keeps its streak.
  assert.deepEqual(parse(record({ day: '2026-02-30', score: 5, streak: 4, lastWin: 4 })), { day: null, number: 0, status: 'playing', score: 0, streak: 4, lastWin: 4 });
});

// ── The page ─────────────────────────────────────────────────────────────────

test('port-knocker: loading the script under Node runs no init: no lookup, listener, timer or save', (t) => {
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const pkn = loadScript(SCRIPT);
  assert.equal(typeof pkn.pknInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['pkn-panel'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('port-knocker: a first visit waits for Start on a 2x2 panel, with listeners registered once and nothing playing by itself', (t) => {
  const page = openPage(t);
  assert.equal(page.ports().length, 4);
  assert.equal(page.el('panel').style['--pkn-cols'], '2');
  page.ports().forEach((port, i) => {
    assert.equal(port.tagName, 'BUTTON');
    assert.equal(port.type, 'button');
    assert.equal(port.className, 'pkn-port');
    assert.equal(port.getAttribute('data-port'), String(i));
    assert.equal(port.getAttribute('tabindex'), '-1');
    assert.equal(port.getAttribute('aria-label'), 'Port ' + PORT_NUMBERS[i] + ' (' + SERVICES[i] + '), key ' + (i + 1));
    assert.deepEqual(port.children.map((c) => c.className), ['pkn-led', 'pkn-jack', 'pkn-port-num', 'pkn-port-svc', 'pkn-key']);
    assert.equal(port.children[1].children[0].className, 'pkn-pins');
    assert.deepEqual(port.children.slice(2).map((c) => c.textContent), [String(PORT_NUMBERS[i]), SERVICES[i], String(i + 1)]);
  });
  assert.equal(page.text('status'), 'Round 1 (sequence 3): watch the panel, then knock it back. Press Start or Enter.');
  assert.equal(page.label(), 'Start');
  assert.equal(page.el('start').disabled, false);
  assert.deepEqual(['round', 'longest', 'best', 'streak'].map(page.text), ['1', '0', '--', '0']);
  assert.equal(page.text('command'), '$ knock --fifo homelab.lan');
  assert.equal(page.text('output'), 'knockd: listening on homelab.lan');
  assert.equal(page.text('hint'), 'Forward (FIFO): knock the ports in the order they flashed.');
  assert.equal(page.text('daily'), 'Daily #5');
  assert.equal(page.text('sound'), 'Sound: off');
  assert.deepEqual(page.dots(), [0, 0, 0]);
  assert.equal(page.el('mode').value, 'forward');
  assert.equal(page.el('size').value, '4');
  assert.equal(page.shown('note'), false);
  assert.equal(page.shown('result'), false);
  // The fresh game is saved at once, in the current format.
  const saved = localStorage.getItem(STATE);
  const seq = page.saved().sequence;
  assert.equal(saved, '{"v":1,"kind":"practice","mode":"forward","size":4,"sequence":' + JSON.stringify(seq) + ',"round":1,"result":"playing","day":null}');
  assert.deepEqual(seq, (() => { const r = seeded(1); let s = []; while (s.length < 3) s = extendModel(s, r, 4); return s; })());
  assert.equal(localStorage.length, 1, 'only pkn-state: no Daily attempt, best or sound yet');
  // One listener per control, keydown and visibilitychange on the document.
  for (const id of ['start', 'new-game', 'restart', 'daily', 'sound', 'share', 'replay', 'result-close']) {
    assert.equal(listenerCount(page.el(id), 'click'), 1, id);
  }
  assert.equal(listenerCount(page.el('panel'), 'click'), 1);
  assert.equal(listenerCount(page.el('mode'), 'change'), 1);
  assert.equal(listenerCount(page.el('size'), 'change'), 1);
  assert.equal(listenerCount(document), 2);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(window), 0);
  for (const port of page.ports()) assert.equal(listenerCount(port), 0, 'the panel listens for its ports');
  // Nothing plays until Start.
  page.clock.advance(10000);
  assert.deepEqual(page.lit(), []);
  assert.equal(page.label(), 'Start');
});

test('port-knocker: while the page is still loading the game waits for DOMContentLoaded; init twice binds nothing twice', (t) => {
  const page = openPage(t, { readyState: 'loading', storage: { [STATE]: fresh({ sequence: [3, 2, 1] }) } });
  assert.equal(page.ports().length, 0);
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(document, 'keydown'), 0);
  page.ready();
  assert.equal(page.ports().length, 4);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(page.text('status'), 'Round 1 (sequence 3) is waiting. Press Start or Enter to replay the show.');

  resetStubs();
  clockFor(t);
  createPage(htmlPageSpec(HTML)).install();
  const pkn = loadScript(SCRIPT);
  pkn.pknInit();
  pkn.pknInit();
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(document.getElementById('pkn-panel'), 'click'), 1);
  assert.equal(document.getElementById('pkn-panel').children.length, 4);
});

test('port-knocker: Start plays the show at its pace, ignores knocks meanwhile, then a right repeat opens the firewall and the next round adds a knock', (t) => {
  const page = openPage(t);
  const seq = page.saved().sequence;
  focusElement(page.el('new-game'));
  page.click('start');
  assert.equal(document.activeElement, page.el('stage'), 'the keys go to the play area');
  assert.equal(page.label(), 'Watch...');
  assert.equal(page.el('start').disabled, true);
  assert.equal(page.text('status'), 'Watch the panel: round 1, sequence 3.');
  assert.equal(page.text('output'), 'knockd: replaying knock sequence');
  const lit = [];
  const times = [];
  for (let ms = 1; ms <= 2260; ms++) {
    page.clock.advance(1);
    const now = page.lit();
    if (now.join() !== (lit.length ? lit[lit.length - 1] : '')) {
      lit.push(now.join());
      times.push(ms);
    }
    if (ms === 1000) {
      // Knocks during the show change nothing.
      page.tap(seq[0]);
      assert.deepEqual(page.marked('pkn-port-hit'), []);
      assert.equal(pressKey('2', { target: page.el('stage') }).defaultPrevented, true);
      assert.equal(page.label(), 'Watch...');
    }
    if (ms === 2259) assert.equal(page.label(), 'Watch...');
  }
  assert.deepEqual(lit, [String(seq[0]), '', String(seq[1]), '', String(seq[2]), '']);
  assert.deepEqual(times, [500, 860, 1100, 1460, 1700, 2060]);
  assert.equal(page.label(), 'Knock!');
  assert.equal(page.text('status'), 'Your turn: knock the 3 ports in order.');
  assert.equal(page.text('output'), 'knockd: waiting for the first knock');

  page.tap(seq[0]);
  assert.deepEqual(page.marked('pkn-port-hit'), [seq[0]]);
  assert.deepEqual(page.dots(), [1, 0, 0]);
  assert.equal(page.text('output'), 'knockd: stage 1/3 ok');
  page.clock.advance(180);
  assert.deepEqual(page.marked('pkn-port-hit'), [], 'the knock flash goes out');
  page.clock.advance(320);
  page.tap(seq[1]);
  page.clock.advance(250);
  page.tap(seq[2]);
  assert.equal(page.text('output'), 'ssh: connection established (3 knocks in 0.75 s)');
  assert.ok(page.el('output').classList.contains('pkn-out-ok'));
  assert.ok(page.el('panel').classList.contains('pkn-panel-up'));
  assert.equal(page.label(), 'Connected');
  assert.deepEqual(page.dots(), [1, 1, 1, 1], 'the next round owes 4');
  assert.equal(page.text('status'), 'Access granted: sequence 3. Round 2 (sequence 4) starts in a moment.');
  assert.deepEqual(['round', 'longest', 'best'].map(page.text), ['2', '3', '3']);
  assert.equal(page.text('toast'), 'New best: sequence 3 (Forward, 4 ports)');
  assert.deepEqual(page.saved(BEST), { 'forward-4': 3 });
  const next = page.saved();
  assert.equal(next.round, 2);
  assert.deepEqual(next.sequence.slice(0, 3), seq);
  assert.equal(next.sequence.length, 4);
  assert.notEqual(next.sequence[3], seq[2]);

  // The next show starts on its own 1.4 s later, at round 2's pace.
  page.clock.advance(1399);
  assert.equal(page.label(), 'Connected');
  page.clock.advance(1);
  assert.equal(page.label(), 'Watch...');
  assert.equal(page.el('panel').classList.contains('pkn-panel-up'), false);
  page.clock.advance(500);
  assert.deepEqual(page.lit(), [next.sequence[0]]);
  page.clock.advance(338);
  assert.deepEqual(page.lit(), [next.sequence[0]]);
  page.clock.advance(1);
  assert.deepEqual(page.lit(), [], 'lit for 339 ms');
  page.clock.advance(225);
  assert.deepEqual(page.lit(), []);
  page.clock.advance(1);
  assert.deepEqual(page.lit(), [next.sequence[1]], '565 ms apart');
  page.watch();
  page.tapAll(next.sequence);
  assert.equal(page.text('longest'), '4');
  assert.equal(page.saved().sequence.length, 5);
});

test('port-knocker: a wrong knock refuses the connection, marks both ports, keeps the best and Enter starts a new run', (t) => {
  const page = openPage(t, { storage: { [BEST]: { 'forward-4': 6 } } });
  page.click('start');
  page.playRound();
  page.clock.advance(1400);
  page.watch();
  const seq = page.saved().sequence;
  const wrong = [0, 1, 2, 3].find((p) => p !== seq[1]);
  page.tap(seq[0]);
  page.tap(wrong);
  assert.equal(page.text('output'), 'ssh: connect to host homelab.lan port 22: Connection refused');
  assert.ok(page.el('output').classList.contains('pkn-out-err'));
  assert.ok(page.el('panel').classList.contains('pkn-panel-down'));
  assert.deepEqual(page.marked('pkn-port-bad'), [wrong]);
  assert.deepEqual(page.marked('pkn-port-want'), [seq[1]]);
  // The log line shows the whole sequence the round wanted.
  assert.equal(page.text('log'), '[knockd] expected ' + seq.map((p) => PORT_NUMBERS[p]).join(' '));
  assert.ok(page.el('log').classList.contains('pkn-log-on'));
  assert.equal(page.text('status'), 'Connection refused: you knocked ' + PORT_NUMBERS[wrong] + ', the sequence wanted ' +
    PORT_NUMBERS[seq[1]] + ' (knock 2 of 4). Longest: sequence 3. Press Start or Enter for a new run.');
  assert.equal(page.label(), 'Try again');
  assert.deepEqual(['round', 'longest', 'best'].map(page.text), ['2', '3', '6']);
  assert.deepEqual(page.saved(), fresh({ sequence: seq, round: 2, result: 'lost' }));
  assert.equal(page.toastOn(), false, 'no new best');
  // Knocks after the end change nothing; the window is off.
  page.tap(seq[1]);
  page.clock.advance(5000);
  assert.equal(page.saved().result, 'lost');
  assert.equal(page.label(), 'Try again');

  focusElement(page.el('stage'), { keyboard: true });
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.equal(page.label(), 'Watch...');
  assert.deepEqual(page.marked('pkn-port-bad'), []);
  assert.deepEqual(page.marked('pkn-port-want'), []);
  assert.equal(page.text('log'), '', 'the new show clears the log line');
  assert.equal(page.el('log').classList.contains('pkn-log-on'), false);
  const run = page.saved();
  assert.equal(run.round, 1);
  assert.equal(run.result, 'playing');
  assert.deepEqual(page.watch().flashed, run.sequence);
});

test('port-knocker: Reverse is knocked backwards and Stride every second knock; the selects start a waiting game', (t) => {
  const page = openPage(t);
  page.choose('mode', 'reverse');
  assert.equal(page.label(), 'Start');
  assert.equal(page.text('command'), '$ knock --lifo homelab.lan');
  assert.equal(page.text('hint'), 'Reverse (LIFO): knock them backwards, the last flash first, like popping a stack.');
  page.clock.advance(5000);
  assert.deepEqual(page.lit(), [], 'a select change does not start the show');
  page.click('start');
  const shown = page.watch().flashed;
  assert.equal(page.text('status'), 'Your turn: knock the 3 ports backwards, the last one first.');
  page.tapAll(shown.slice().reverse());
  assert.equal(page.text('longest'), '3');
  assert.deepEqual(page.saved(BEST), { 'reverse-4': 3 });
  page.clock.advance(1400);
  const four = page.watch().flashed;
  assert.equal(four.length, 4);
  page.tapAll(four.slice().reverse());
  assert.equal(page.saved().sequence.length, 5);

  page.choose('size', 9);
  page.choose('mode', 'stride');
  assert.equal(page.ports().length, 9);
  assert.equal(page.el('panel').style['--pkn-cols'], '3');
  assert.equal(page.text('command'), '$ knock --stride=2 homelab.lan');
  page.click('start');
  const stride = page.watch().flashed;
  assert.equal(page.text('status'), 'Your turn: knock every second port, 2 of the 3.');
  assert.deepEqual(page.dots(), [0, 0]);
  page.tap(stride[0]);
  page.tap(stride[2]);
  assert.equal(page.text('output'), 'ssh: connection established (2 knocks in 0.00 s)');
  // Knocks are what was entered (2); the score is the sequence length (3).
  assert.equal(page.text('status'), 'Access granted: sequence 3. Round 2 (sequence 4) starts in a moment.');
  assert.equal(page.text('toast'), 'New best: sequence 3 (Stride, 9 ports)');
  assert.deepEqual(page.saved(BEST), { 'reverse-4': 4, 'stride-9': 3 });
  page.clock.advance(1400);
  const next = page.watch().flashed;
  page.tap(next[0]);
  page.tap(next[1]);
  assert.equal(page.label(), 'Try again', 'Stride skips the second knock');
  assert.equal(page.text('log'), '[knockd] expected ' + PORT_NUMBERS[next[0]] + ' ' + PORT_NUMBERS[next[2]]);
});

test('port-knocker: the knock window drops the knocks after 3 s without one, and runs only between knocks', (t) => {
  const page = openPage(t);
  page.click('start');
  page.watch();
  const seq = page.saved().sequence;
  page.clock.advance(60000);
  assert.equal(page.label(), 'Knock!', 'no window before the first knock');
  page.tap(seq[0]);
  const fill = page.el('window-fill');
  assert.ok(fill.classList.contains('pkn-window-run'));
  assert.equal(fill.style['--pkn-window-ms'], '3000ms');
  assert.equal(fill.style['--pkn-window-delay'], '0ms');
  page.clock.advance(2999);
  page.tap(seq[1]); // just in time: the window starts again
  page.clock.advance(2999);
  assert.deepEqual(page.dots(), [1, 1, 0]);
  page.clock.advance(1);
  assert.deepEqual(page.dots(), [0, 0, 0]);
  assert.equal(fill.classList.contains('pkn-window-run'), false);
  assert.equal(page.text('output'), 'knockd: sequence timeout (3 s), state reset');
  assert.ok(page.el('output').classList.contains('pkn-out-warn'));
  assert.equal(page.text('status'), 'Knock window closed: more than 3 s after port ' + PORT_NUMBERS[seq[1]] +
    '. The sequence reset: start again from the first knock.');
  assert.equal(page.label(), 'Knock!', 'still the same round, no new show');
  assert.deepEqual(page.lit(), []);
  // The third knock alone is now a wrong first knock; the whole sequence again works.
  page.tapAll(seq);
  assert.equal(page.label(), 'Connected');
  assert.equal(page.saved().sequence.length, 4);
});

test('port-knocker: from round 5 the first knocks are a log line, then the panel flashes the rest', (t) => {
  const seq = [0, 1, 2, 3, 0, 1, 2];
  const page = openPage(t, { storage: { [STATE]: fresh({ sequence: seq, round: 5 }) } });
  assert.deepEqual(['round', 'longest'].map(page.text), ['5', '6']);
  page.click('start');
  assert.equal(page.text('status'), 'Watch the panel: round 5, sequence 7, the first 2 in the log line.');
  page.clock.advance(500);
  assert.equal(page.text('log'), '[knockd] seq 22 80 ...');
  assert.ok(page.el('log').classList.contains('pkn-log-on'));
  assert.deepEqual(page.lit(), []);
  page.clock.advance(1799);
  assert.equal(page.text('log'), '[knockd] seq 22 80 ...');
  page.clock.advance(1);
  assert.equal(page.text('log'), '');
  assert.equal(page.el('log').classList.contains('pkn-log-on'), false);
  const seen = page.watch();
  assert.deepEqual(seen.flashed, [2, 3, 0, 1, 2]);
  page.tapAll(seq);
  assert.equal(page.text('longest'), '7');
  // Round 9 (11 knocks) logs 4.
  resetStubs();
  const long = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2];
  const later = reload(t, page, { storage: { [STATE]: fresh({ sequence: long, round: 9 }) } });
  later.click('start');
  const shown = later.watch();
  assert.deepEqual(shown.logs, ['[knockd] seq 22 80 443 3306 ...']);
  assert.deepEqual(shown.flashed, long.slice(4));
});

test('port-knocker: with 9 ports the keys follow the keypad, with 6 the panel is 3 x 2', (t) => {
  const page = openPage(t, { storage: { [STATE]: fresh({ size: 9, sequence: [0, 4, 8] }) } });
  assert.equal(page.el('panel').style['--pkn-cols'], '3');
  assert.deepEqual(page.ports().map((p) => p.children[4].textContent), ['7', '8', '9', '4', '5', '6', '1', '2', '3']);
  assert.equal(page.ports()[6].getAttribute('aria-label'), 'Port 5432 (postgres), key 1');
  focusElement(page.el('stage'));
  pressKey('Enter');
  page.watch();
  for (const key of ['7', '5']) assert.equal(pressKey(key).defaultPrevented, true);
  assert.deepEqual(page.dots(), [1, 1, 0]);
  pressKey('End', { code: 'Numpad3' }); // the keypad's 3 without Num Lock
  assert.equal(page.label(), 'Connected');

  page.choose('size', 6);
  assert.equal(page.ports().length, 6);
  assert.deepEqual(page.ports().map((p) => p.children[4].textContent), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(page.ports().map((p) => p.children[2].textContent), ['22', '80', '443', '3306', '53', '8080']);
  page.click('start');
  page.watch();
  const seq = page.saved().sequence;
  for (const p of seq) pressKey(String(p + 1));
  assert.equal(page.label(), 'Connected');
  // A digit with no port on this panel is no game key.
  page.clock.advance(1400);
  page.watch();
  assert.equal(pressKey('8').defaultPrevented, false);
  assert.equal(pressKey('9', { code: 'Digit9' }).defaultPrevented, false);
  assert.deepEqual(page.dots().filter(Boolean), []);
});

test('port-knocker: keys are the game\'s only with the focus inside it, never in its selects, never with modifiers', (t) => {
  const page = openPage(t);
  const seq = page.saved().sequence;
  const hostInput = page.page.add('host-input', 'input');
  const hostLink = page.page.add('host-link', { tagName: 'a', attributes: { href: '#x' } });
  const hostButton = page.page.add('host-button', 'button');
  let hostClicks = 0;
  hostButton.addEventListener('click', () => hostClicks++);
  // Nothing focused (the body) and host-page elements: the page keeps every key.
  for (const target of [document.body, hostInput, hostLink, hostButton]) {
    for (const key of ['1', '2', 'Enter', ' ']) {
      assert.equal(pressKey(key, { target }).defaultPrevented, false, (target.id || 'body') + ' ' + JSON.stringify(key));
    }
  }
  assert.equal(hostClicks, 2, 'Enter and Space still click the host button');
  assert.equal(page.label(), 'Start');

  // The play area: Enter starts, digits and Space are taken during the show.
  const stage = page.el('stage');
  focusElement(stage, { keyboard: true });
  assert.equal(pressKey('Enter', { repeat: true }).defaultPrevented, true, 'a held Enter is swallowed');
  assert.equal(page.label(), 'Start', 'but acts once only when pressed');
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.equal(page.label(), 'Watch...');
  assert.equal(pressKey(' ').defaultPrevented, true, 'Space never scrolls the page from the game');
  assert.equal(pressKey('x').defaultPrevented, false);
  page.watch();
  // Modifiers, composing text, keys already handled: left alone.
  for (const props of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    assert.equal(pressKey(String(seq[0] + 1), props).defaultPrevented, false, JSON.stringify(props));
  }
  const handled = (event) => event.preventDefault();
  document.addEventListener('keydown', handled, true);
  pressKey(String(seq[0] + 1));
  document.removeEventListener('keydown', handled, true);
  assert.deepEqual(page.dots(), [0, 0, 0]);
  // The game's selects keep digits and Enter.
  for (const id of ['mode', 'size']) {
    assert.equal(pressKey(String(seq[0] + 1), { target: page.el(id) }).defaultPrevented, false, id);
    assert.equal(pressKey('Enter', { target: page.el(id) }).defaultPrevented, false, id);
  }
  // A held digit knocks once.
  assert.equal(pressKey(String(seq[0] + 1)).defaultPrevented, true);
  assert.equal(pressKey(String(seq[0] + 1), { repeat: true }).defaultPrevented, true);
  assert.deepEqual(page.dots(), [1, 0, 0]);
  // Digits work on the game's own buttons too; Enter there is the button's.
  pressKey(String(seq[1] + 1), { target: page.el('restart') });
  assert.deepEqual(page.dots(), [1, 1, 0]);
  const sound = page.el('sound');
  focusElement(sound);
  assert.equal(pressKey('Enter').defaultPrevented, false);
  assert.equal(page.text('sound'), 'Sound: on', 'Enter clicked the focused Sound button');
  assert.deepEqual(page.dots(), [1, 1, 0], 'and did not touch the round');
  // Enter or Space on a port is the game's (no native click on the port).
  page.tap(seq[2]);
  assert.equal(page.label(), 'Connected');
  page.clock.advance(1400);
  page.watch();
  const port = page.ports()[0];
  focusElement(port);
  assert.equal(pressKey('Enter').defaultPrevented, true);
  assert.deepEqual(page.dots(), [0, 0, 0, 0], 'Enter on a port is no knock');
});

test('port-knocker: a port clicked while the focus is outside hands it to the play area; taps are plain clicks and never block scrolling', (t) => {
  const page = openPage(t);
  page.click('start');
  page.watch();
  const seq = page.saved().sequence;
  const hostInput = page.page.add('host-input', 'input');
  hostInput.focus();
  const start = touchEvent('touchstart', [40, 40]);
  page.ports()[seq[0]].dispatchEvent(start);
  const end = touchEvent('touchend', [40, 40]);
  page.ports()[seq[0]].dispatchEvent(end);
  assert.equal(start.defaultPrevented, false);
  assert.equal(end.defaultPrevented, false);
  assert.deepEqual(page.dots(), [0, 0, 0], 'touches alone do nothing: the click that follows knocks');
  page.tap(seq[0]);
  assert.equal(document.activeElement, page.el('stage'));
  assert.deepEqual(page.dots(), [1, 0, 0]);
  // With the focus already in the game it stays where it is.
  focusElement(page.el('restart'));
  page.tap(seq[1]);
  assert.equal(document.activeElement, page.el('restart'));
  // A click on the panel between ports is nothing.
  page.el('panel').click();
  assert.deepEqual(page.dots(), [1, 1, 0]);
  // A click on a port's inner part counts as the port.
  page.ports()[seq[2]].children[2].click();
  assert.equal(page.label(), 'Connected');
});

test('port-knocker: New Game, Restart and the selects stop what runs, never stack listeners or timers, and follow the selects', (t) => {
  const page = openPage(t);
  page.click('start');
  page.clock.advance(700);
  assert.equal(page.lit().length, 1);
  page.choose('size', 6);
  assert.deepEqual(page.lit(), [], 'the old show stops');
  assert.equal(page.label(), 'Start');
  page.clock.advance(10000);
  assert.deepEqual(page.lit(), [], 'no stray flash from the old show');
  assert.equal(page.saved().size, 6);

  page.choose('mode', 'stride');
  page.click('new-game');
  assert.equal(document.activeElement, page.el('stage'));
  assert.equal(page.label(), 'Watch...', 'New Game starts its show');
  assert.deepEqual([page.saved().mode, page.saved().size], ['stride', 6]);
  page.watch();
  const seq = page.saved().sequence;
  page.tap(seq[0]);
  page.click('restart');
  assert.equal(page.label(), 'Watch...');
  assert.equal(page.el('window-fill').classList.contains('pkn-window-run'), false, 'the window stops');
  const restarted = page.saved();
  assert.deepEqual([restarted.mode, restarted.size, restarted.round], ['stride', 6, 1]);
  assert.deepEqual(page.watch().flashed, restarted.sequence);
  page.clock.advance(10000);
  assert.equal(page.label(), 'Knock!', 'no timeout from the old window');

  for (let i = 0; i < 4; i++) {
    page.click('new-game');
    page.click('restart');
    page.choose('mode', DAILY_MODES[i % 3]);
    page.click('start');
  }
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(page.el('panel'), 'click'), 1);
  assert.equal(listenerCount(page.el('start'), 'click'), 1);
  const last = page.saved();
  assert.deepEqual(page.watch().flashed, last.sequence, 'one show plays');
  assert.equal(page.ports().length, 6, 'the ports were built once per size');
});

test('port-knocker: a reload brings the round back waiting, with its sequence; the show replays only on Start', (t) => {
  const page = openPage(t, { storage: { [STATE]: fresh({ size: 6, mode: 'reverse', sequence: [0, 1, 2] }) } });
  page.click('start');
  page.playRound();
  page.clock.advance(1400);
  page.watch();
  const saved = page.saved();
  assert.equal(saved.round, 2);
  page.tap(owed(saved.sequence, 'reverse')[0]);

  const again = reload(t, page);
  assert.deepEqual(again.saved(), saved);
  assert.equal(again.label(), 'Replay show');
  assert.equal(again.text('status'), 'Round 2 (sequence 4) is waiting. Press Start or Enter to replay the show.');
  assert.deepEqual(['round', 'longest', 'best'].map(again.text), ['2', '3', '3']);
  assert.deepEqual([again.el('mode').value, again.el('size').value], ['reverse', '6']);
  assert.deepEqual(again.dots(), [0, 0, 0, 0]);
  again.clock.advance(20000);
  assert.deepEqual(again.lit(), [], 'no show by itself');
  again.click('start');
  assert.deepEqual(again.watch().flashed, saved.sequence);
  again.tapAll(owed(saved.sequence, 'reverse'));
  assert.equal(again.text('longest'), '4');

  // A lost run comes back lost.
  again.clock.advance(1400);
  again.watch();
  const s = again.saved().sequence;
  again.tap(s[0] === s[s.length - 1] ? (s[0] + 1) % 6 : s[0]);
  const lost = reload(t, again);
  assert.equal(lost.label(), 'Try again');
  assert.equal(lost.text('status'), 'The last run ended at sequence 4. Press Start or Enter for a new run.');
  lost.click('start');
  assert.equal(lost.saved().round, 1);
  assert.equal(lost.saved().mode, 'reverse');
});

test('port-knocker: a hidden tab pauses the show and the pause before the next round; the knock window keeps its time left', (t) => {
  const page = openPage(t);
  page.click('start');
  page.clock.advance(600);
  assert.equal(page.lit().length, 1);
  setVisibility('hidden', t);
  assert.deepEqual(page.lit(), []);
  assert.equal(page.label(), 'Replay show');
  assert.equal(page.text('output'), 'knockd: paused');
  assert.equal(page.text('status'), 'Paused while the tab was hidden. Press Start or Enter to replay round 1.');
  page.clock.advance(10000);
  assert.deepEqual(page.lit(), []);
  setVisibility('visible', t);
  page.clock.advance(5000);
  assert.equal(page.label(), 'Replay show', 'coming back does not start the show');
  page.click('start');
  const seq = page.saved().sequence;
  assert.deepEqual(page.watch().flashed, seq);

  // The knock window: hidden 1 s into it, its 2 s left come back with the tab.
  page.tap(seq[0]);
  page.clock.advance(1000);
  setVisibility('hidden', t);
  assert.equal(page.el('window-fill').classList.contains('pkn-window-run'), false);
  page.clock.advance(20000);
  assert.deepEqual(page.dots(), [1, 0, 0]);
  setVisibility('visible', t);
  assert.equal(page.el('window-fill').style['--pkn-window-delay'], '-1000ms');
  page.clock.advance(1999);
  assert.deepEqual(page.dots(), [1, 0, 0]);
  page.clock.advance(1);
  assert.deepEqual(page.dots(), [0, 0, 0]);
  // Hidden before the first knock, or while idle: nothing to pause.
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.equal(page.label(), 'Knock!');
  page.tapAll(seq);
  // The pause before round 2: the show waits for Start.
  assert.equal(page.label(), 'Connected');
  page.clock.advance(700);
  setVisibility('hidden', t);
  page.clock.advance(5000);
  setVisibility('visible', t);
  assert.equal(page.label(), 'Replay show');
  assert.equal(page.text('status'), 'Paused while the tab was hidden. Press Start or Enter to replay round 2.');
  assert.deepEqual(page.lit(), []);
  page.click('start');
  assert.equal(page.watch().flashed.length, 4);
  page.click('new-game');
  setVisibility('hidden', t);
  setVisibility('visible', t);
  page.click('restart');
  page.clock.advance(10);
  setVisibility('hidden', t);
  assert.equal(page.label(), 'Replay show');
});

test('port-knocker: corrupt or unreadable saves give a playable game; partial ones keep the fields that are good', (t) => {
  const broken = ['', '{', 'null', '42', '"x"', '[]', 'true', '{"sequence":"0,1,2"}', '{"mode":"insane","size":"x"}',
    JSON.stringify(fresh({ sequence: [0, 1, 7] })), JSON.stringify(fresh({ sequence: [0, 1] }))];
  for (const text of broken) {
    resetStubs();
    const page = openPage(t, { storage: { [STATE]: text, [BEST]: '{"forward-4":"x"}', [DAILY]: '{oops', [SOUND]: 'loud' } });
    assert.equal(page.ports().length, 4, text);
    assert.equal(page.label(), 'Start', text);
    assert.equal(page.text('status'), 'Round 1 (sequence 3): watch the panel, then knock it back. Press Start or Enter.', text);
    assert.deepEqual(['round', 'best', 'streak'].map(page.text), ['1', '--', '0'], text);
    assert.equal(page.text('sound'), 'Sound: off');
    assert.equal(page.saved().sequence.length, 3, text + ': a fresh sequence is saved');
    assert.equal(page.saved().kind, 'practice');
    page.click('start');
    page.playRound();
    assert.equal(page.label(), 'Connected', text);
  }
  // Partial: mode and size stay, the broken sequence is drawn again.
  resetStubs();
  const partial = openPage(t, { storage: { [STATE]: { mode: 'reverse', size: 9 } } });
  assert.deepEqual([partial.el('mode').value, partial.el('size').value, partial.ports().length], ['reverse', '9', 9]);
  assert.deepEqual(Object.keys(partial.saved()), ['v', 'kind', 'mode', 'size', 'sequence', 'round', 'result', 'day']);
  assert.equal(partial.saved().sequence.length, 3);
  // A good sequence with a wrong round: the sequence decides.
  const odd = reload(t, partial, { storage: { [STATE]: fresh({ sequence: [3, 2, 1, 0, 3], round: 99, mode: 7 }) } });
  assert.equal(odd.text('round'), '3');
  assert.equal(odd.el('mode').value, 'forward');
  // A save from the first version of this game, byte for byte.
  const first = '{"v":1,"kind":"practice","mode":"stride","size":6,"sequence":[5,2,0,4],"round":2,"result":"playing","day":null}';
  const v1 = reload(t, odd, { storage: { [STATE]: first } });
  assert.deepEqual(['round', 'longest'].map(v1.text), ['2', '3']);
  v1.click('start');
  assert.deepEqual(v1.watch().flashed, [5, 2, 0, 4]);
  v1.tap(5);
  v1.tap(0);
  assert.equal(localStorage.getItem(STATE).startsWith('{"v":1,"kind":"practice","mode":"stride","size":6,"sequence":[5,2,0,4,'), true);
});

test('port-knocker: blocked or full storage never stops the game and the note says what is lost', (t) => {
  blockStorage('access', t);
  let page = openPage(t);
  assert.equal(page.shown('note'), true);
  assert.equal(page.text('note'), 'Storage is blocked (SecurityError): ' + STORAGE_NOTE);
  assert.equal(page.ports().length, 4);
  page.click('start');
  page.tapAll(page.watch().flashed);
  assert.equal(page.text('best'), '3', 'the best is kept in memory');
  page.clock.advance(1400);
  page.tapAll(page.watch().flashed);
  assert.equal(page.text('best'), '4');
  // The Daily plays from memory, once.
  page.click('daily');
  assert.equal(page.label(), 'Watch...');
  page.watch();
  page.click('new-game');
  assert.equal(page.text('daily'), 'Resume Daily #5');
  page.click('daily');
  assert.equal(page.text('command'), '$ knock --lifo daily-5.homelab.lan');
  page.restore();

  resetStubs();
  writeStorage({ [BEST]: { 'forward-4': 5 } });
  blockStorage('full', t);
  page = openPage(t);
  assert.equal(page.text('best'), '5', 'reading still works');
  assert.equal(page.text('note'), 'Storage is full (QuotaExceededError): ' + STORAGE_NOTE);
  page.click('start');
  page.tapAll(page.watch().flashed);
  assert.equal(page.label(), 'Connected');
  page.restore();

  resetStubs();
  t.mock.method(localStorage, 'setItem', () => { throw {}; });
  page = openPage(t);
  assert.equal(page.text('note'), 'Storage is blocked (Error): ' + STORAGE_NOTE);
});

test('port-knocker: the best is kept per mode and panel size, never lowered, and merged with what another tab saved', (t) => {
  const page = openPage(t, { storage: { [BEST]: { 'forward-6': 5, 'forward-4': 'x', 'bogus-4': 9 } } });
  assert.equal(page.text('best'), '--');
  page.click('start');
  page.playRound();
  assert.equal(page.text('toast'), 'New best: sequence 3 (Forward, 4 ports)');
  assert.deepEqual(page.saved(BEST), { 'forward-6': 5, 'forward-4': 3 });
  page.choose('size', 6);
  assert.equal(page.text('best'), '5');
  page.click('start');
  page.playRound();
  assert.equal(page.text('best'), '5', 'a shorter run keeps the best');
  assert.deepEqual(page.saved(BEST), { 'forward-6': 5, 'forward-4': 3 });
  // Another tab raised forward-4 meanwhile: the higher value stays.
  localStorage.setItem(BEST, JSON.stringify({ 'forward-6': 5, 'forward-4': 9 }));
  page.choose('size', 4);
  page.click('start');
  page.playRound();
  assert.deepEqual(page.saved(BEST), { 'forward-6': 5, 'forward-4': 9 });
  assert.equal(page.text('best'), '9');
});

test('port-knocker: a newer toast keeps its full 2.2 s', (t) => {
  const page = openPage(t);
  page.click('daily');
  page.click('restart');
  assert.equal(page.text('toast'), 'Restart is off during Daily #5: it has one scored attempt. New Game switches to practice.');
  assert.equal(page.toastOn(), true);
  page.clock.advance(1000);
  page.click('restart');
  page.clock.advance(2199);
  assert.equal(page.toastOn(), true, 'the first toast\'s time is up, not the second\'s');
  page.clock.advance(1);
  assert.equal(page.toastOn(), false);
});

// ── Daily ────────────────────────────────────────────────────────────────────

test('port-knocker: the Daily records its attempt before the first show and plays the day\'s sequence, the same for every player', (t) => {
  const page = openPage(t);
  const writes = [];
  const realSet = localStorage.setItem;
  t.mock.method(localStorage, 'setItem', function (key, value) {
    writes.push([key, page.lit().length]);
    return realSet.call(this, key, value);
  });
  page.click('daily');
  assert.deepEqual(writes, [[DAILY, 0], [STATE, 0]], 'the attempt mark comes first, before any flash');
  assert.equal(localStorage.getItem(DAILY), '{"day":"2026-11-05","number":5,"status":"playing","score":0,"streak":0,"lastWin":0}');
  assert.deepEqual(page.saved(), { v: 1, kind: 'daily', mode: 'reverse', size: 6, sequence: dailyModel('2026-11-05', 3), round: 1, result: 'playing', day: '2026-11-05' });
  assert.equal(page.text('command'), '$ knock --lifo daily-5.homelab.lan');
  assert.deepEqual([page.el('mode').value, page.el('size').value, page.ports().length], ['reverse', '6', 6]);
  assert.equal(page.text('daily'), 'Daily #5');
  const first = page.watch().flashed;
  assert.deepEqual(first, dailyModel('2026-11-05', 3));
  // Restart refuses: one scored attempt.
  page.click('restart');
  assert.equal(page.label(), 'Knock!');
  assert.equal(page.text('toast'), 'Restart is off during Daily #5: it has one scored attempt. New Game switches to practice.');
  // The Daily button on the running Daily changes nothing.
  page.click('daily');
  assert.equal(page.label(), 'Knock!');
  page.tapAll(first.slice().reverse());
  assert.deepEqual(page.saved(DAILY), record({ score: 3 }));
  page.clock.advance(1400);
  assert.deepEqual(page.watch().flashed, dailyModel('2026-11-05', 4));

  // Another player (another Math.random) gets the same Daily; another day another one.
  page.restore();
  resetStubs();
  const other = openPage(t, { seed: 777 });
  other.click('daily');
  assert.deepEqual(other.watch().flashed, first);
  other.restore();
  resetStubs();
  const tomorrow = openPage(t, { when: at(2026, 11, 6, 8) });
  assert.equal(tomorrow.text('daily'), 'Daily #6');
  tomorrow.click('daily');
  assert.equal(tomorrow.text('command'), '$ knock --stride=2 daily-6.homelab.lan');
  assert.equal(tomorrow.text('hint'), 'Stride: knock only every second port, the 1st, 3rd, 5th and so on.');
  assert.deepEqual(tomorrow.watch().flashed, dailyModel('2026-11-06', 3));
  assert.notDeepEqual(dailyModel('2026-11-06', 3), first);
});

test('port-knocker: a reload resumes the Daily at the round it reached; a finished Daily shows its result and is never scored again', (t) => {
  const page = openPage(t);
  page.click('daily');
  page.playRound();
  page.clock.advance(1400);
  page.watch();
  const again = reload(t, page);
  assert.equal(again.label(), 'Replay show');
  assert.equal(again.text('status'), 'Daily #5 resumed. Round 2 (sequence 4) is waiting. Press Start or Enter to replay the show.');
  assert.equal(again.text('round'), '2');
  again.clock.advance(10000);
  assert.deepEqual(again.lit(), []);
  focusElement(again.el('stage'));
  pressKey(' ');
  const shown = again.watch().flashed;
  assert.deepEqual(shown, dailyModel('2026-11-05', 4));
  // A wrong first knock ends the Daily.
  const wrong = (shown[3] + 1) % 6;
  again.tap(wrong);
  assert.deepEqual(again.saved(DAILY), record({ status: 'lost', score: 3 }));
  assert.equal(again.saved().result, 'lost');
  assert.equal(again.text('log'), '[knockd] expected ' + shown.slice().reverse().map((p) => PORT_NUMBERS[p]).join(' '), 'in the order owed');
  assert.equal(again.text('status'), 'Connection refused: you knocked ' + PORT_NUMBERS[wrong] + ', the sequence wanted ' +
    PORT_NUMBERS[shown[3]] + ' (knock 1 of 4). Longest: sequence 3. Daily #5 is over at sequence 3 of 8. Streak reset to 0.');
  assert.equal(again.shown('result'), true);
  assert.equal(again.text('result-title'), 'Daily #5: connection refused');
  assert.equal(again.text('result-text'), 'Reverse, 6 ports: sequence 3 of 8. Streak: 0. One scored attempt a day; a new Daily starts at midnight.');
  assert.equal(again.text('daily'), 'Daily #5 done');
  assert.equal(again.label(), 'Daily result');
  again.click('result-close');
  assert.equal(again.shown('result'), false);
  assert.equal(document.activeElement, again.el('stage'));
  pressKey('Enter');
  assert.equal(again.shown('result'), true, 'Enter shows the result again');
  again.click('result-close');
  const before = localStorage.getItem(DAILY);
  again.click('daily');
  assert.equal(again.shown('result'), true);
  assert.equal(localStorage.getItem(DAILY), before, 'no second attempt');
  assert.equal(again.label(), 'Daily result');
  again.click('restart');
  assert.equal(again.label(), 'Daily result', 'Restart refuses on a finished Daily too');

  // After a reload the result is shown on the page, without taking the focus.
  focusElement(again.el('new-game'));
  const finished = reload(t, again);
  assert.equal(finished.shown('result'), true);
  assert.equal(finished.text('status'), 'Daily #5 is finished: sequence 3 of 8. A new Daily starts at midnight.');
  assert.equal(finished.label(), 'Daily result');
  assert.equal(finished.text('daily'), 'Daily #5 done');
  assert.equal(document.activeElement, document.body);
  finished.click('result-close');
  finished.click('start');
  assert.equal(finished.shown('result'), true);
  // New Game leaves the finished Daily for practice without a toast.
  finished.click('new-game');
  assert.equal(finished.toastOn(), false);
  assert.equal(finished.saved().kind, 'practice');
  finished.click('daily');
  assert.equal(finished.shown('result'), true);
  assert.equal(finished.saved().kind, 'practice', 'the result card, not the Daily again');
});

test('port-knocker: a won Daily extends the streak; a lost or missed day resets it; Share copies the result line', async (t) => {
  // Yesterday (#4) won with a streak of 2; today's attempt is at its last round.
  const page = openPage(t, { storage: { [DAILY]: record({ score: 7, streak: 2, lastWin: 4 }) } });
  assert.equal(page.text('streak'), '2');
  assert.equal(page.text('daily'), 'Resume Daily #5');
  page.click('daily');
  assert.equal(page.saved().sequence.length, 8);
  assert.equal(page.text('round'), '6');
  page.playRound();
  assert.deepEqual(page.saved(DAILY), record({ status: 'won', score: 8, streak: 3, lastWin: 5 }));
  assert.equal(page.saved().result, 'won');
  assert.equal(page.text('status'), 'Daily #5 complete: sequence 8 of 8, streak 3.');
  assert.equal(page.text('result-title'), 'Daily #5: ssh: connection established');
  assert.equal(page.text('result-text'), 'Reverse, 6 ports: sequence 8 of 8. Streak: 3. One scored attempt a day; a new Daily starts at midnight.');
  assert.deepEqual(['streak', 'longest'].map(page.text), ['3', '8']);
  page.clock.advance(5000);
  assert.equal(page.label(), 'Daily result', 'no next round after the target');

  const copied = [];
  const clip = t.mock.method(navigator.clipboard, 'writeText', (text) => {
    copied.push(text);
    return Promise.resolve();
  });
  page.click('share');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(copied, ['Port Knocker #5 Reverse 6 ports seq 8/8, ssh: connection established']);
  assert.equal(page.text('toast'), 'Copied: Port Knocker #5 Reverse 6 ports seq 8/8, ssh: connection established');
  assert.equal(page.shown('share-text'), false);

  // The clipboard refuses: the line is selected in the read-only field.
  clip.mock.mockImplementation(() => Promise.reject(new Error('denied')));
  page.click('share');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(page.shown('share-text'), true);
  assert.equal(page.el('share-text').value, 'Port Knocker #5 Reverse 6 ports seq 8/8, ssh: connection established');
  assert.equal(document.activeElement, page.el('share-text'));
  assert.equal(page.text('toast'), 'Clipboard unavailable: the result is selected in the field below.');
  // No clipboard at all.
  page.el('share-text').value = '';
  const realClipboard = navigator.clipboard;
  navigator.clipboard = undefined;
  t.after(() => { navigator.clipboard = realClipboard; });
  page.click('share');
  assert.equal(page.el('share-text').value, 'Port Knocker #5 Reverse 6 ports seq 8/8, ssh: connection established');
  navigator.clipboard = { writeText: 'not a function' };
  page.el('share-text').value = '';
  page.click('share');
  assert.equal(page.el('share-text').value.length > 0, true);
  navigator.clipboard = realClipboard;
  // Reopening the result card hides the old field.
  page.click('result-close');
  page.click('daily');
  assert.equal(page.shown('share-text'), false);

  // A reload the same day shows the won Daily at its full length.
  const same = reload(t, page);
  assert.equal(same.shown('result'), true);
  assert.deepEqual(['round', 'longest', 'streak'].map(same.text), ['6', '8', '3']);
  assert.equal(same.text('status'), 'Daily #5 is finished: sequence 8 of 8. A new Daily starts at midnight.');
  assert.equal(same.label(), 'Daily result');

  // Tomorrow the streak still shows; after a missed day it is 0.
  const tomorrow = reload(t, same, { when: at(2026, 11, 6) });
  assert.equal(tomorrow.text('streak'), '3');
  const missed = reload(t, tomorrow, { when: at(2026, 11, 7) });
  assert.equal(missed.text('streak'), '0');
  // A new win after the gap starts again at 1 (Daily #7 is Forward, target 10).
  missed.restore();
  localStorage.setItem(DAILY, JSON.stringify(record({ day: '2026-11-07', number: 7, score: 9, streak: 3, lastWin: 5 })));
  const comeback = openPage(t);
  comeback.click('daily');
  comeback.playRound();
  assert.deepEqual(comeback.saved(DAILY), record({ day: '2026-11-07', number: 7, status: 'won', score: 10, streak: 1, lastWin: 7 }));
  // A loss today resets a living streak.
  comeback.restore();
  localStorage.setItem(DAILY, JSON.stringify(record({ day: '2026-11-07', number: 7, status: 'won', score: 10, streak: 4, lastWin: 7 })));
  const loser = openPage(t, { when: at(2026, 11, 8) });
  assert.equal(loser.text('streak'), '4');
  loser.click('daily');
  assert.deepEqual(loser.saved(DAILY), record({ day: '2026-11-08', number: 8, streak: 4, lastWin: 7 }));
  const seq = loser.watch().flashed;
  loser.tap((seq[2] + 1) % 6);
  assert.deepEqual(loser.saved(DAILY), record({ day: '2026-11-08', number: 8, status: 'lost', score: 0, streak: 0, lastWin: 7 }));
  assert.equal(loser.text('streak'), '0');
});

test('port-knocker: a Daily left open across midnight finishes for the day it began; the next Daily starts after that', (t) => {
  const page = openPage(t, { when: at(2026, 11, 5, 23, 59, 58) });
  page.click('daily');
  const shown = page.watch().flashed;
  assert.equal(page.text('daily'), 'Daily #6', 'the label follows the new day');
  page.tapAll(shown.slice().reverse());
  assert.deepEqual(page.saved(DAILY), record({ score: 3 }));
  assert.equal(page.text('command'), '$ knock --lifo daily-5.homelab.lan');
  page.clock.advance(1400);
  assert.deepEqual(page.watch().flashed, dailyModel('2026-11-05', 4), 'still Daily #5');
  page.tap((dailyModel('2026-11-05', 4)[3] + 1) % 6);
  assert.equal(page.saved(DAILY).day, '2026-11-05');
  assert.equal(page.saved(DAILY).status, 'lost');
  page.click('result-close');
  // Daily now begins #6 (Stride).
  page.click('daily');
  assert.equal(page.saved(DAILY).day, '2026-11-06');
  assert.equal(page.saved(DAILY).status, 'playing');
  assert.equal(page.saved().mode, 'stride');

  // Another tab began #7 meanwhile: this tab's #6 never overwrites it.
  page.watch();
  localStorage.setItem(DAILY, JSON.stringify(record({ day: '2026-11-07', number: 7 })));
  const s = page.saved().sequence;
  page.tapAll(owed(s, 'stride'));
  assert.equal(page.saved(DAILY).day, '2026-11-07');
  // And a Daily still running from yesterday when Daily is pressed today is
  // given up for today's.
  page.restore();
  localStorage.setItem(DAILY, JSON.stringify(record({ day: '2026-11-08', number: 8, score: 4, streak: 2, lastWin: 7 })));
  const late = openPage(t, { when: at(2026, 11, 8, 23, 59, 59) });
  late.click('daily');
  late.clock.advance(2000);
  late.click('new-game');
  late.click('daily');
  assert.equal(late.saved(DAILY).day, '2026-11-09');
  assert.deepEqual(late.saved(DAILY), record({ day: '2026-11-09', number: 9, streak: 0, lastWin: 7 }));
});

test('port-knocker: a Daily begun before midnight and left after it ends as lost; the Daily button then begins or shows today\'s', (t) => {
  // #5 (Reverse) begun at 23:59:58 after a won #4 (streak 2); its first round
  // is passed after midnight, then New Game leaves it.
  const page = openPage(t, { when: at(2026, 11, 5, 23, 59, 58), storage: { [DAILY]: record({ day: '2026-11-04', number: 4, status: 'won', score: 10, streak: 2, lastWin: 4 }) } });
  assert.equal(page.text('streak'), '2');
  page.click('daily');
  page.playRound();
  assert.deepEqual(page.saved(DAILY), record({ score: 3, streak: 2, lastWin: 4 }));
  page.click('new-game');
  assert.equal(page.text('toast'), 'Daily #5 ended at round 2: it began before midnight, and today is Daily #6.');
  assert.deepEqual(page.saved(DAILY), record({ status: 'lost', score: 3, streak: 0, lastWin: 4 }));
  assert.deepEqual([page.saved().kind, page.text('daily'), page.text('streak')], ['practice', 'Daily #6', '0']);
  page.click('daily');
  assert.deepEqual(page.saved(DAILY), record({ day: '2026-11-06', number: 6, streak: 0, lastWin: 4 }));
  assert.equal(page.saved().mode, 'stride');

  // The Daily button pressed while #6 still runs after its midnight: #6
  // ends, and #7 begins at once.
  const late = reload(t, page, { when: at(2026, 11, 6, 23, 59, 58) });
  assert.equal(late.label(), 'Replay show');
  late.click('start');
  late.watch();
  late.click('daily');
  assert.equal(late.text('toast'), 'Daily #6 ended at round 1: it began before midnight, and today is Daily #7.');
  assert.deepEqual(late.saved(DAILY), record({ day: '2026-11-07', number: 7, streak: 0, lastWin: 4 }));
  assert.deepEqual([late.saved().kind, late.saved().day, late.label()], ['daily', '2026-11-07', 'Watch...']);

  // Another tab finished #8 meanwhile: its result shows, a practice game
  // takes the screen, and the old #7 can write nothing into #8.
  const other = reload(t, late, { when: at(2026, 11, 7, 23, 59, 58) });
  other.click('start');
  other.watch();
  const won = record({ day: '2026-11-08', number: 8, status: 'won', score: 8, streak: 1, lastWin: 8 });
  localStorage.setItem(DAILY, JSON.stringify(won));
  other.click('daily');
  assert.equal(other.text('toast'), 'Daily #7 ended at round 1: it began before midnight, and today is Daily #8.');
  assert.equal(other.shown('result'), true);
  assert.equal(other.text('result-title'), 'Daily #8: ssh: connection established');
  assert.deepEqual([other.saved().kind, other.label(), other.text('daily'), other.text('streak')], ['practice', 'Start', 'Daily #8 done', '1']);
  other.click('start');
  other.playRound();
  assert.equal(other.label(), 'Connected');
  assert.deepEqual(other.saved(DAILY), won);
});

test('port-knocker: a Daily left unfinished on an earlier day counts as lost after a reload, and today\'s can begin', (t) => {
  const page = openPage(t, { storage: {
    [DAILY]: record({ day: '2026-11-04', number: 4, score: 5, streak: 3, lastWin: 3 }),
    [STATE]: { v: 1, kind: 'daily', mode: 'forward', size: 6, sequence: dailyModel('2026-11-04', 6), round: 4, result: 'playing', day: '2026-11-04' }
  } });
  assert.deepEqual(page.saved(DAILY), record({ day: '2026-11-04', number: 4, status: 'lost', score: 5, streak: 0, lastWin: 3 }));
  assert.equal(page.saved().kind, 'practice', 'a fresh practice game');
  assert.deepEqual([page.saved().mode, page.saved().size], ['forward', 6]);
  assert.equal(page.label(), 'Start');
  assert.equal(page.text('streak'), '0');
  page.click('daily');
  assert.deepEqual(page.saved(DAILY), record({ lastWin: 3 }));
  // A Daily state whose record is gone (cleared storage) is practice too.
  page.restore();
  localStorage.removeItem(DAILY);
  localStorage.setItem(STATE, JSON.stringify({ v: 1, kind: 'daily', mode: 'reverse', size: 6, sequence: [0, 1, 2], round: 1, result: 'playing', day: '2026-11-05' }));
  const cleared = openPage(t);
  assert.equal(cleared.saved().kind, 'practice');
  assert.equal(cleared.text('daily'), 'Daily #5');
  // A today's record with an unreadable status is a used attempt.
  cleared.restore();
  localStorage.setItem(DAILY, JSON.stringify(record({ status: 'hacked', score: 4 })));
  const damaged = openPage(t);
  assert.equal(damaged.text('daily'), 'Daily #5 done');
  damaged.click('daily');
  assert.equal(damaged.shown('result'), true);
  assert.equal(damaged.text('result-title'), 'Daily #5: connection refused');
});

test('port-knocker: New Game leaves a running Daily for practice, and the Daily button resumes it at the same round', (t) => {
  const page = openPage(t);
  page.click('daily');
  page.playRound();
  page.clock.advance(1400);
  page.click('new-game');
  assert.equal(page.text('toast'), 'Daily #5 paused at round 2: the Daily button resumes it.');
  assert.equal(page.saved().kind, 'practice');
  assert.deepEqual([page.saved().mode, page.saved().size], ['reverse', 6], 'practice takes what the selects show');
  assert.equal(page.text('daily'), 'Resume Daily #5');
  assert.equal(page.el('daily').getAttribute('aria-label'), 'Resume Daily #5 at the round it reached', 'the name says it can be resumed');
  assert.equal(page.text('command'), '$ knock --lifo homelab.lan');
  page.watch();
  page.click('daily');
  assert.equal(page.label(), 'Watch...');
  assert.equal(page.text('round'), '2');
  assert.deepEqual(page.watch().flashed, dailyModel('2026-11-05', 4));
  assert.equal(page.text('daily'), 'Daily #5');
  assert.equal(page.el('daily').getAttribute('aria-label'), 'Daily #5: today\'s sequence, on the panel now');
  // A select change leaves it too; another tab played on: its record wins.
  page.choose('size', 4);
  assert.equal(page.text('toast'), 'Daily #5 paused at round 2: the Daily button resumes it.');
  assert.deepEqual([page.saved().kind, page.saved().size, page.label()], ['practice', 4, 'Start']);
  localStorage.setItem(DAILY, JSON.stringify(record({ score: 5 })));
  page.click('daily');
  assert.equal(page.text('round'), '4');
});

test('port-knocker: a Daily lost or won in another tab stands: a stale tab takes that result at its next round and never writes over it', (t) => {
  // (a) Two tabs play the same attempt; the other one loses it at 3, then
  // this one passes round 2.
  const yesterday = record({ day: '2026-11-04', number: 4, status: 'won', score: 10, streak: 2, lastWin: 4 });
  const page = openPage(t, { storage: { [DAILY]: yesterday } });
  assert.equal(page.el('daily').getAttribute('aria-label'), 'Daily #5: play today\'s sequence, one scored attempt');
  page.click('daily');
  page.playRound();
  page.clock.advance(1400);
  page.watch();
  assert.deepEqual(page.saved(BEST), { 'reverse-6': 3 });
  const lost = JSON.stringify(record({ status: 'lost', score: 3, streak: 0, lastWin: 4 }));
  localStorage.setItem(DAILY, lost);
  const s = page.saved();
  page.tapAll(owed(s.sequence, s.mode));
  assert.equal(localStorage.getItem(DAILY), lost, 'the loss stands: no second scored attempt');
  assert.deepEqual(page.saved(BEST), { 'reverse-6': 3 }, 'a round after the end scores nothing');
  assert.equal(page.text('toast'), 'Daily #5 was finished in another tab: lost at sequence 3 of 8.');
  assert.equal(page.text('status'), 'Daily #5 was finished in another tab: lost at sequence 3 of 8, streak 0. A new Daily starts at midnight.');
  assert.equal(page.shown('result'), true);
  assert.equal(page.text('result-title'), 'Daily #5: connection refused');
  assert.equal(page.text('result-text'), 'Reverse, 6 ports: sequence 3 of 8. Streak: 0. One scored attempt a day; a new Daily starts at midnight.');
  assert.deepEqual(['daily', 'streak', 'longest', 'round', 'output'].map(page.text),
    ['Daily #5 done', '0', '3', '2', 'knockd: listening on homelab.lan']);
  assert.equal(page.el('daily').getAttribute('aria-label'), 'Daily #5 done: show the result');
  assert.equal(page.label(), 'Daily result');
  assert.deepEqual(page.saved(), { v: 1, kind: 'daily', mode: 'reverse', size: 6, sequence: dailyModel('2026-11-05', 4), round: 2, result: 'lost', day: '2026-11-05' });
  page.clock.advance(5000);
  assert.deepEqual([page.label(), page.lit()], ['Daily result', []], 'no next round runs');
  page.click('result-close');
  page.click('daily');
  assert.deepEqual([page.shown('result'), localStorage.getItem(DAILY)], [true, lost]);
  const again = reload(t, page);
  assert.equal(again.text('status'), 'Daily #5 is finished: sequence 3 of 8. A new Daily starts at midnight.');

  // (b) The other tab won it (streak 3); one miss here must not wipe that.
  again.restore();
  resetStubs();
  const stale = openPage(t, { storage: { [DAILY]: yesterday } });
  stale.click('daily');
  stale.playRound();
  stale.clock.advance(1400);
  const shown = stale.watch().flashed;
  const won = JSON.stringify(record({ status: 'won', score: 8, streak: 3, lastWin: 5 }));
  localStorage.setItem(DAILY, won);
  stale.tap((shown[3] + 1) % 6);
  assert.equal(localStorage.getItem(DAILY), won, 'the win and its streak stay');
  assert.equal(stale.text('toast'), 'Daily #5 was finished in another tab: won at sequence 8 of 8.');
  assert.equal(stale.text('result-title'), 'Daily #5: ssh: connection established');
  assert.deepEqual(['streak', 'longest', 'round', 'log'].map(stale.text), ['3', '8', '6', '']);
  assert.deepEqual([stale.marked('pkn-port-bad'), stale.marked('pkn-port-want')], [[], []], 'no refused knock is marked');
  assert.equal(stale.saved().result, 'won');
});

test('port-knocker: the Daily button, the next round, Start after a pause and leaving the Daily each check for a result another tab stored', (t) => {
  const three = JSON.stringify(record({ status: 'lost', score: 3 }));
  // The Daily button in the middle of a round.
  const page = openPage(t);
  page.click('daily');
  page.watch();
  const zero = JSON.stringify(record({ status: 'lost', score: 0 }));
  localStorage.setItem(DAILY, zero);
  page.click('daily');
  assert.deepEqual([page.label(), page.shown('result'), localStorage.getItem(DAILY)], ['Daily result', true, zero]);
  assert.equal(page.text('toast'), 'Daily #5 was finished in another tab: lost at sequence 0 of 8.');
  assert.deepEqual(['round', 'longest'].map(page.text), ['1', '0']);

  // The pause before the next round.
  page.restore();
  resetStubs();
  const pause = openPage(t);
  pause.click('daily');
  pause.playRound();
  assert.equal(pause.label(), 'Connected');
  localStorage.setItem(DAILY, three);
  pause.clock.advance(1400);
  assert.deepEqual([pause.label(), pause.lit(), localStorage.getItem(DAILY)], ['Daily result', [], three]);
  pause.clock.advance(3000);
  assert.deepEqual(pause.lit(), [], 'no show runs');

  // Start on a show paused by a hidden tab.
  pause.restore();
  resetStubs();
  const hidden = openPage(t);
  hidden.click('daily');
  hidden.clock.advance(100);
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.equal(hidden.label(), 'Replay show');
  localStorage.setItem(DAILY, three);
  hidden.click('start');
  assert.deepEqual([hidden.label(), hidden.shown('result'), hidden.lit()], ['Daily result', true, []]);

  // New Game on it: the toast names the other tab's result, nothing is written.
  hidden.restore();
  resetStubs();
  const leave = openPage(t);
  leave.click('daily');
  leave.watch();
  localStorage.setItem(DAILY, three);
  leave.click('new-game');
  assert.equal(leave.text('toast'), 'Daily #5 was finished in another tab: lost at sequence 3 of 8.');
  assert.deepEqual([leave.saved().kind, localStorage.getItem(DAILY), leave.text('daily')], ['practice', three, 'Daily #5 done']);

  // A Daily begun before midnight that the other tab won: leaving it after
  // midnight never ends it as lost, and the next Daily keeps the streak.
  leave.restore();
  resetStubs();
  const late = openPage(t, { when: at(2026, 11, 5, 23, 59, 58), storage: { [DAILY]: record({ day: '2026-11-04', number: 4, status: 'won', score: 10, streak: 2, lastWin: 4 }) } });
  late.click('daily');
  late.watch();
  assert.equal(late.text('daily'), 'Daily #6');
  const won = JSON.stringify(record({ status: 'won', score: 8, streak: 3, lastWin: 5 }));
  localStorage.setItem(DAILY, won);
  late.click('new-game');
  assert.equal(late.text('toast'), 'Daily #5 was finished in another tab: won at sequence 8 of 8.');
  assert.equal(localStorage.getItem(DAILY), won, 'not ended as lost over the win');
  late.click('daily');
  assert.deepEqual(late.saved(DAILY), record({ day: '2026-11-06', number: 6, streak: 3, lastWin: 5 }));
});

test('port-knocker: the Daily button builds a new Daily on the later record, so one another tab stored since the load keeps its streak', (t) => {
  // This tab loads on 2026-11-04 at 23:59:59 with #3 won (streak 4); another
  // tab then wins #4 (streak 5); after midnight this tab begins #5.
  const page = openPage(t, { when: at(2026, 11, 4, 23, 59, 59), storage: { [DAILY]: record({ day: '2026-11-03', number: 3, status: 'won', score: 12, streak: 4, lastWin: 3 }) } });
  assert.equal(page.text('streak'), '4');
  localStorage.setItem(DAILY, JSON.stringify(record({ day: '2026-11-04', number: 4, status: 'won', score: 10, streak: 5, lastWin: 4 })));
  page.clock.advance(2000);
  page.click('daily');
  assert.deepEqual(page.saved(DAILY), record({ streak: 5, lastWin: 4 }));
  assert.equal(page.text('streak'), '5');
  for (let round = 0; round < 6; round++) {
    if (round) page.clock.advance(1400);
    page.playRound();
  }
  assert.deepEqual(page.saved(DAILY), record({ status: 'won', score: 8, streak: 6, lastWin: 5 }));
  assert.equal(page.text('status'), 'Daily #5 complete: sequence 8 of 8, streak 6.');
  assert.equal(page.text('streak'), '6');
});

test('port-knocker: a finished Daily can be replayed unscored: same sequence, no record, no best', (t) => {
  const page = openPage(t, { storage: { [DAILY]: record({ score: 7 }), [BEST]: { 'reverse-6': 2 } } });
  page.click('daily');
  page.playRound();
  const daily = localStorage.getItem(DAILY);
  const best = localStorage.getItem(BEST);
  page.click('replay');
  assert.equal(page.shown('result'), false);
  assert.equal(document.activeElement, page.el('stage'));
  assert.equal(page.text('command'), '$ knock --lifo daily-5.homelab.lan   # unscored replay');
  assert.deepEqual(page.saved(), { v: 1, kind: 'replay', mode: 'reverse', size: 6, sequence: dailyModel('2026-11-05', 3), round: 1, result: 'playing', day: '2026-11-05' });
  page.playRound();
  page.clock.advance(1400);
  assert.deepEqual(page.watch().flashed, dailyModel('2026-11-05', 4));
  assert.equal(localStorage.getItem(DAILY), daily);
  assert.equal(localStorage.getItem(BEST), best);
  assert.equal(page.toastOn(), false);
  // Restart replays it from round 1; a reload restores it.
  page.click('restart');
  assert.equal(page.saved().round, 1);
  page.playRound();
  page.clock.advance(1400);
  const again = reload(t, page);
  assert.equal(again.text('command'), '$ knock --lifo daily-5.homelab.lan   # unscored replay');
  assert.equal(again.label(), 'Replay show');
  assert.deepEqual(again.saved().sequence, dailyModel('2026-11-05', 4));
  // Its last round ends it; Start plays it again; a miss ends it too.
  again.restore();
  localStorage.setItem(STATE, JSON.stringify({ v: 1, kind: 'replay', mode: 'forward', size: 4, sequence: [0, 0, 0, 0, 0, 0, 0, 0], round: 6, result: 'playing', day: '2026-11-05' }));
  const last = openPage(t);
  assert.deepEqual(last.saved().sequence, [0, 0, 0, 0, 0, 0, 0, 0], 'the save is not rewritten at load');
  assert.equal(last.ports().length, 6);
  last.click('start');
  const seq = dailyModel('2026-11-05', 8);
  const seen = last.watch();
  assert.deepEqual(seen.logs, ['[knockd] seq ' + seq.slice(0, 2).map((p) => PORT_NUMBERS[p]).join(' ') + ' ...']);
  assert.deepEqual(seen.flashed, seq.slice(2));
  last.tapAll(seq.slice().reverse());
  assert.equal(last.text('status'), 'Unscored replay of Daily #5 complete: sequence 8. Press Start to play it again.');
  assert.equal(last.saved().result, 'won');
  assert.equal(last.label(), 'Try again');
  assert.equal(last.shown('result'), false);
  assert.equal(localStorage.getItem(DAILY), daily);
  last.click('start');
  assert.equal(last.saved().round, 1);
  assert.equal(last.saved().kind, 'replay');
  last.watch();
  last.tap((last.saved().sequence[2] + 1) % 6);
  assert.equal(last.label(), 'Try again');
  pressKey('Enter', { target: last.el('stage') });
  assert.equal(last.saved().kind, 'replay');
  assert.equal(last.label(), 'Watch...');
});

test('port-knocker: sound is off by default and optional: a toggle saves it, WebAudio plays tones, and a browser without it says so', (t) => {
  const made = [];
  const RealAudio = window.AudioContext;
  const RealWebkit = window.webkitAudioContext;
  t.after(() => {
    window.AudioContext = RealAudio;
    window.webkitAudioContext = RealWebkit;
  });
  class SpyAudio extends RealAudio {
    constructor() {
      super();
      this.state = 'suspended';
      this.oscillators = [];
      this.resumed = 0;
      made.push(this);
    }
    createOscillator() {
      const osc = super.createOscillator();
      this.oscillators.push(osc);
      return osc;
    }
    resume() {
      this.resumed++;
      return super.resume();
    }
  }
  window.AudioContext = SpyAudio;
  const page = openPage(t);
  page.click('start');
  page.playRound();
  assert.equal(made.length, 0, 'no audio context while the sound is off');
  assert.equal(localStorage.getItem(SOUND), null);

  page.click('sound');
  assert.equal(page.text('sound'), 'Sound: on');
  assert.equal(page.el('sound').getAttribute('aria-pressed'), 'true');
  assert.equal(page.el('sound').getAttribute('aria-label'), 'Sound on: turn the sound off');
  assert.equal(localStorage.getItem(SOUND), 'on');
  assert.equal(made.length, 1);
  assert.equal(made[0].resumed, 1, 'the click lets the suspended context play');
  page.clock.advance(1400);
  page.watch();
  const tones = made[0].oscillators;
  assert.deepEqual(tones.map((o) => [o.type, o.frequency.value]), page.saved().sequence.map((p) => ['triangle', [262, 294, 330, 392][p]]));
  const seq = page.saved().sequence;
  page.tap(seq[0]);
  page.tap((seq[1] + 1) % 4);
  assert.deepEqual(tones.slice(-2).map((o) => o.type), ['triangle', 'sawtooth']);
  made[0].state = 'running';
  page.click('start');
  assert.equal(made[0].resumed, 1, 'a running context is not resumed');
  page.watch();
  page.tapAll(page.saved().sequence);
  assert.equal(tones[tones.length - 1].type, 'sine', 'the success chime');

  // A broken audio stack only costs the sound.
  made[0].createOscillator = () => { throw new Error('audio device lost'); };
  page.clock.advance(1400);
  page.watch();
  page.tapAll(page.saved().sequence);
  assert.equal(page.label(), 'Connected');

  delete made[0].createOscillator;
  page.click('sound');
  assert.equal(localStorage.getItem(SOUND), 'off');
  assert.equal(page.el('sound').getAttribute('aria-label'), 'Sound off: turn the sound on');
  const count = tones.length;
  page.clock.advance(1400);
  page.watch();
  assert.equal(tones.length, count);

  // A reload keeps the choice; a context that cannot be made is silence.
  page.click('sound');
  window.AudioContext = function () { throw new Error('too many contexts'); };
  const reloaded = reload(t, page);
  assert.equal(reloaded.text('sound'), 'Sound: on');
  reloaded.click('start');
  reloaded.playRound();
  assert.equal(reloaded.label(), 'Connected');

  // Only the prefixed webkitAudioContext: it is used.
  window.AudioContext = undefined;
  window.webkitAudioContext = SpyAudio;
  const webkit = reload(t, reloaded);
  webkit.click('start');
  webkit.watch();
  assert.ok(made.length >= 2);
  assert.ok(made[made.length - 1].oscillators.length >= 3);

  // No Web Audio at all: the saved "on" is ignored and the toggle refuses.
  window.webkitAudioContext = undefined;
  const silent = reload(t, webkit);
  assert.equal(silent.text('sound'), 'Sound: off');
  silent.click('sound');
  assert.equal(silent.text('sound'), 'Sound: off');
  assert.equal(silent.text('toast'), 'Sound is not available: this browser has no Web Audio (AudioContext).');
  window.AudioContext = SpyAudio;
  let last = silent;
  for (const value of ['ON', 'true', '1', 'yes']) {
    last.restore();
    localStorage.setItem(SOUND, value);
    last = openPage(t);
    assert.equal(last.text('sound'), 'Sound: off', value);
  }
});
