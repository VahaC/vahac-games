// tests/rack-reset.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, focusElement, setVisibility, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'rack-reset';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

// The pure functions (the start-up code does not run under Node).
const rkr = loadScript(SCRIPT);

const STATE_KEY = 'rkr-state';
const BEST_KEY = 'rkr-best';

// The rack models: key, toggle mask, name.  The stencils in words: cross,
// diagonal X, a row of three, an H, a hook, the full block.
const MODELS = [
  ['272', 0x272, 'cross'], ['525', 0x525, 'X-link'], ['070', 0x070, 'row bus'],
  ['575', 0x575, 'H-frame'], ['632', 0x632, 'hook'], ['777', 0x777, 'block']
];
const SIZES = [3, 4, 5, 6];
const maskOf = (model) => MODELS.find((m) => m[0] === model)[1];

// The null-space dimension of every offered model and size, pinned: 2^k
// candidates are checked for the minimum, so a model or size whose k grows
// has to show up here.
const NULLITY = {
  272: [0, 4, 2, 0],
  525: [0, 4, 4, 0],
  '070': [0, 0, 5, 0],
  575: [0, 4, 1, 6],
  632: [2, 0, 2, 1],
  777: [0, 0, 9, 0]
};

// The first 5x5 cross rack of seeded(1), pinned: a change to the generator
// or its use of the random source shows up here.
const SEED1_START = ['01110', '01000', '00010', '01100', '10011'];
const SEED1_PAR = 10;

// An rkr-state in the format the first published version writes: that rack
// with C3 and A1 pressed (rows as 0 / 1 strings, the history for undo),
// revision 7, scored.
const SAMPLE_SAVE = '{"v":1,"rev":7,"model":"272","size":5,' +
  '"start":["01110","01000","00010","01100","10011"],' +
  '"grid":["10110","11100","01100","01000","10011"],' +
  '"moves":2,"history":[12,0],"hinted":false,"replay":false}';

// The rkr-best the first published version writes after one scored reset of
// the 5x5 cross on par: every offered model and size, in the order of the
// selects, as { over, wins }.
const SAMPLE_BEST = '{"272-3":{"over":null,"wins":0},"272-4":{"over":null,"wins":0},' +
  '"272-5":{"over":0,"wins":1},"272-6":{"over":null,"wins":0},' +
  '"525-3":{"over":null,"wins":0},"525-4":{"over":null,"wins":0},"525-5":{"over":null,"wins":0},"525-6":{"over":null,"wins":0},' +
  '"070-3":{"over":null,"wins":0},"070-4":{"over":null,"wins":0},"070-5":{"over":null,"wins":0},"070-6":{"over":null,"wins":0},' +
  '"575-3":{"over":null,"wins":0},"575-4":{"over":null,"wins":0},"575-5":{"over":null,"wins":0},"575-6":{"over":null,"wins":0},' +
  '"632-3":{"over":null,"wins":0},"632-4":{"over":null,"wins":0},"632-5":{"over":null,"wins":0},"632-6":{"over":null,"wins":0},' +
  '"777-3":{"over":null,"wins":0},"777-4":{"over":null,"wins":0},"777-5":{"over":null,"wins":0},"777-6":{"over":null,"wins":0}}';

// The fewest presses a dealt rack needs, per size: no rack one or two
// presses of the stencil reset.
const PAR_FLOOR = { 3: 3, 4: 4, 5: 4, 6: 4 };

test.beforeEach(() => resetStubs());

// ── An independent model of the rack ───────────────────────────────────────
//
// A mask is three hex digits, the top row first; in a digit 4 is the left
// cell, 2 the centre, 1 the right one.

function stencil(mask) {
  const digits = mask.toString(16).padStart(3, '0');
  const out = [];
  for (let r = 0; r < 3; r++) {
    const d = parseInt(digits[r], 16);
    for (let c = 0; c < 3; c++) if (d & (4 >> c)) out.push([r - 1, c - 1]);
  }
  return out;
}

function flips(n, mask, i) {
  const r = Math.floor(i / n);
  const c = i % n;
  return stencil(mask)
    .map(([dr, dc]) => [r + dr, c + dc])
    .filter(([y, x]) => y >= 0 && x >= 0 && y < n && x < n)
    .map(([y, x]) => y * n + x)
    .sort((a, b) => a - b);
}

const pressModel = (grid, n, mask, i) => {
  const out = grid.slice();
  for (const j of flips(n, mask, i)) out[j] ^= 1;
  return out;
};
const applyAll = (grid, n, mask, presses) => presses.reduce((g, i) => pressModel(g, n, mask, i), grid);
const zeros = (n) => new Array(n * n).fill(0);
const rowsOf = (grid, n) => Array.from({ length: n }, (_, r) => grid.slice(r * n, r * n + n).join(''));
const gridOf = (rows) => rows.join('').split('').map(Number);
const lit = (grid) => grid.filter((v) => v === 1).length;
const popcount = (big) => big.toString(2).split('').filter((b) => b === '1').length;

// The flips of a press as a BigInt bit set, and grids as bit sets.
const pressBits = (n, mask, i) => flips(n, mask, i).reduce((acc, j) => acc | (1n << BigInt(j)), 0n);
const gridBits = (grid) => grid.reduce((acc, v, i) => (v ? acc | (1n << BigInt(i)) : acc), 0n);
const bitsGrid = (bits, n) => Array.from({ length: n * n }, (_, i) => Number((bits >> BigInt(i)) & 1n));

// Over GF(2), with BigInt rows: the equation of LED i holds bit j when a
// press on j flips i.  Returns the rank, a basis of the null space (sets of
// presses that change nothing) and a solver for one grid.
function linearModel(n, mask) {
  const total = n * n;
  const presses = Array.from({ length: total }, (_, j) => pressBits(n, mask, j));
  const eq = Array.from({ length: total }, (_, i) => presses.reduce((acc, p, j) => ((p >> BigInt(i)) & 1n ? acc | (1n << BigInt(j)) : acc), 0n));
  const rows = eq.slice();
  const pivots = [];
  for (let col = 0; col < total; col++) {
    const bit = 1n << BigInt(col);
    const at = rows.findIndex((row, k) => k >= pivots.length && (row & bit));
    if (at === -1) continue;
    const r = pivots.length;
    [rows[r], rows[at]] = [rows[at], rows[r]];
    for (let k = 0; k < total; k++) if (k !== r && (rows[k] & bit)) rows[k] ^= rows[r];
    pivots.push(col);
  }
  const basis = [];
  for (let f = 0; f < total; f++) {
    if (pivots.includes(f)) continue;
    let v = 1n << BigInt(f);
    pivots.forEach((col, r) => { if ((rows[r] >> BigInt(f)) & 1n) v |= 1n << BigInt(col); });
    basis.push(v);
  }
  const effect = (set) => presses.reduce((acc, p, j) => ((set >> BigInt(j)) & 1n ? acc ^ p : acc), 0n);
  return { rank: pivots.length, basis, presses, effect };
}

// The fewest presses for a grid: every press set x with effect(x) = grid is
// one known solution plus a null-space combination, so all of them are tried.
function minimumByNullSpace(model, grid, solution) {
  let best = Infinity;
  const k = model.basis.length;
  for (let m = 0; m < 2 ** k; m++) {
    let x = solution;
    model.basis.forEach((v, b) => { if ((m >> b) & 1) x ^= v; });
    best = Math.min(best, popcount(x));
  }
  return best;
}

// Brute force over every press set of a small rack (Gray code, so each step
// adds or drops one press): the fewest presses per reachable grid, 255 for a
// grid no presses reach.
function bruteTable(n, mask) {
  const total = n * n;
  const press = Array.from({ length: total }, (_, j) => flips(n, mask, j).reduce((acc, i) => acc | (1 << i), 0));
  const table = new Uint8Array(1 << total).fill(255);
  let grid = 0;
  let weight = 0;
  table[0] = 0;
  const on = new Uint8Array(total);
  for (let m = 1; m < 1 << total; m++) {
    const bit = 31 - Math.clz32(m & -m);
    on[bit] ^= 1;
    weight += on[bit] ? 1 : -1;
    grid ^= press[bit];
    if (weight < table[grid]) table[grid] = weight;
  }
  return table;
}

const intGrid = (value, n) => Array.from({ length: n * n }, (_, i) => (value >> i) & 1);

// ── Pages ────────────────────────────────────────────────────────────────────

// Mocked timers (the toast is the only one); reload() drops the timers of
// the page that goes away, as a real reload does.
function makeClock(t) {
  const enable = () => t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    enable();
  } catch (error) {
    t.mock.timers.reset(); // a second page in the same test
    enable();
  }
  return {
    advance(ms) {
      t.mock.timers.tick(ms);
    },
    reload() {
      t.mock.timers.reset();
      enable();
    }
  };
}

function writeStorage(storage = {}) {
  for (const [key, value] of [[STATE_KEY, storage.state], [BEST_KEY, storage.best]]) {
    if (value !== undefined) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

const storedKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();

// What a player sees and does.
function pageView(b) {
  const els = b.els;
  const board = els['rkr-board'];
  const leds = () => board.children.filter((el) => el.classList.contains('rkr-led'));
  const view = {
    els,
    board,
    page: b.page,
    exposed: b.exposed,
    ready: b.ready,
    restore: b.restore,
    el: (name) => els['rkr-' + name],
    text: (name) => els['rkr-' + name].textContent,
    hidden: (name) => els['rkr-' + name].classList.contains('rkr-hidden'),
    leds,
    regs: () => board.children.filter((el) => el.classList.contains('rkr-reg')),
    led: (i) => leds()[i],
    has: (i, name) => leds()[i].classList.contains(name),
    tap: (i) => leds()[i].click(),
    press(key, props) {
      focusElement(board, { keyboard: true });
      return pressKey(key, Object.assign({ target: board }, props));
    },
    click: (name) => els['rkr-' + name].click(),
    choose(model, size) {
      if (model !== undefined) {
        els['rkr-model'].value = model;
        fire(els['rkr-model'], 'change');
      }
      if (size !== undefined) {
        els['rkr-size'].value = String(size);
        fire(els['rkr-size'], 'change');
      }
    },
    toast: () => (els['rkr-toast'].classList.contains('rkr-show') ? els['rkr-toast'].textContent : null),
    state: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    best: () => JSON.parse(localStorage.getItem(BEST_KEY)),
    // The rack on screen as the save has it.
    grid: () => gridOf(view.state().grid),
    cursor: () => board.getAttribute('aria-activedescendant'),
    // Presses the fewest LEDs that reset the rack on screen (from the
    // solver), plus extra pairs of presses on LED 0 first.  Reads the page,
    // not storage, so it works with storage blocked.  Returns the presses.
    solve(extraPairs = 0) {
      const grid = leds().map((led) => (led.classList.contains('rkr-led--on') ? 1 : 0));
      const presses = rkr.rkrMinPresses(grid, Math.sqrt(grid.length), maskOf(els['rkr-model'].value));
      for (let k = 0; k < extraPairs * 2; k++) view.tap(0);
      presses.forEach((i) => view.tap(i));
      return presses.length + extraPairs * 2;
    }
  };
  return view;
}

function boot(options) {
  return pageView(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options));
}

// The page as a browser loads it, after writing storage, with mocked timers
// and Math.random.
function openPage(t, { random = 1, storage, options } = {}) {
  const clock = makeClock(t);
  t.mock.method(Math, 'random', seeded(random));
  writeStorage(storage);
  return { clock, v: boot(options) };
}

// A reload: the old page and its timers go away, storage stays.
function reload(clock, v) {
  clock.reload();
  v.restore();
  return boot();
}

// A save object for a rack.
function saveOf(model, size, start, extra) {
  return Object.assign({
    v: 1, rev: 1, model, size, start: rowsOf(start, size), grid: rowsOf(start, size),
    moves: 0, history: [], hinted: false, replay: false
  }, extra);
}

// Every element of the page tree under node.
function walk(node, out = []) {
  for (const child of node.children || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

const px = (value) => {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(String(value).trim());
  assert.ok(m, 'a px length: ' + value);
  return Number(m[1]);
};

const rem = (value) => {
  const m = /^(\d+(?:\.\d+)?)rem$/.exec(String(value).trim());
  assert.ok(m, 'a rem length: ' + value);
  return Number(m[1]) * 16;
};

// ── Files ────────────────────────────────────────────────────────────────────

test('rack-reset: every id the script looks up is in index.html once; ids, classes, CSS variables, keyframes, storage keys and exports are rkr- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'rkr-best', 'rkr-board', 'rkr-cleared', 'rkr-hint', 'rkr-hint-button', 'rkr-lit', 'rkr-mask-grid',
    'rkr-mask-hex', 'rkr-mode', 'rkr-model', 'rkr-moves', 'rkr-new-game', 'rkr-par', 'rkr-restart', 'rkr-size',
    'rkr-solver', 'rkr-status', 'rkr-toast', 'rkr-undo', 'rkr-warning'
  ]);
  assert.equal(ids.length, new Set(ids).size, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^rkr-/);
  // The ids the script builds itself.
  assert.deepEqual(Array.from(JS.matchAll(/\.id = '([^']+)'/g), (m) => m[1]), ['rkr-led-']);

  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^rkr-/);
  // Every class name the script sets.
  for (const m of JS.matchAll(/className = '([^']*)'/g)) assert.match(m[1], /^rkr-/);
  for (const m of JS.matchAll(/classList\.(?:add|remove|toggle)\('([^']*)'/g)) assert.match(m[1], /^rkr-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^rkr-/, selector);
    }
  }
  // Custom properties (not the --modifier part of a class name).
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^rkr-/);
  for (const m of JS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^rkr-/);
  const keyframes = Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);
  assert.deepEqual(keyframes, ['rkr-hint-pulse']);
  for (const m of CSS.matchAll(/animation:\s*([\w-]+)/g)) assert.ok(m[1] === 'none' || keyframes.includes(m[1]), m[1]);
  assert.deepEqual([...new Set(Array.from(JS.matchAll(/'(rkr-(?:state|best))'/g), (m) => m[1]))].sort(), ['rkr-best', 'rkr-state']);
  assert.equal((JS.match(/localStorage\./g) || []).length, 2, 'storage is reached only through the two guarded helpers');
  for (const name of Object.keys(rkr)) assert.match(name, /^rkr[A-Z]/);
});

test('rack-reset: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="rkr-wrapper"'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');
  const bg = CSS.match(/--rkr-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Rack Reset — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  // One script, at the end of the body; no external resources at all.
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(/, 'no network resources');
  }
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts)\b/, 'no network calls');
  // An own name and look: no word of the electronic toy this mechanic is known from.
  for (const text of [HTML, CSS, JS]) assert.doesNotMatch(text, /lights\s*out/i);
});

test('rack-reset: script.js is one strict IIFE in ES5', () => {
  assert.match(JS, /^(\/\/[^\n]*\r?\n)*\r?\n?\(function \(\) \{\r?\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  // One IIFE: one function at the start of a line, closed once at the end
  // (callbacks such as grid.filter(function (v) { ... }) are indented).
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1);
  assert.equal(JS.match(/^\}\)\(\);/gm).length, 1);
  const code = JS
    .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['double-quoted string', /"/],
    ['exponent operator', /\*\*/], ['async or await', /\b(async|await)\b/], ['Promise', /\bPromise\b/],
    ['BigInt', /\b\d+n\b|BigInt/], ['block comment', /\/\*/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
  assert.doesNotMatch(JS, /Math\.random\(\)/, 'Math.random is only passed to the generator, never called in the game logic');
});

test('rack-reset: index.html offers the six rack models and four sizes, a focusable board and labelled controls', () => {
  const spec = htmlPageSpec(HTML);
  assert.deepEqual(Array.from(HTML.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g), (m) => [m[1], m[2]]), [
    ...MODELS.map(([key, , name]) => [key, 'RK-' + key + ' ' + name]),
    ['3', '3x3'], ['4', '4x4'], ['5', '5x5'], ['6', '6x6']
  ]);
  assert.deepEqual(rkr.rkrModels.map((m) => [m.key, m.mask, m.name]), MODELS);
  assert.deepEqual(rkr.rkrSizes, SIZES);
  assert.equal(spec['rkr-model'].value, '272');
  assert.equal(spec['rkr-size'].value, '5');
  assert.equal(spec['rkr-board'].attributes.tabindex, '0');
  assert.equal(spec['rkr-board'].attributes.role, 'group');
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
    }
  }
  assert.equal(spec['rkr-status'].attributes['aria-live'], 'polite');
  assert.equal(spec['rkr-hint'].attributes['aria-live'], 'polite');
  assert.equal(spec['rkr-toast'].attributes['aria-live'], 'polite');
  assert.equal(spec['rkr-warning'].attributes.role, 'alert');
  assert.match(spec['rkr-warning'].className, /\brkr-hidden\b/);
  assert.equal(spec['rkr-mask-grid'].attributes['aria-hidden'], 'true');
  // The help names every key the board takes.
  for (const key of ['arrows', 'Space or Enter', 'H hint', 'U undo', 'R restart', 'N new game']) assert.ok(HTML.includes(key), key);
});

test('rack-reset: from 320 to 1440 px every rack fits without widening the page, LEDs are at least 36 px and registers, stats and the model select fit', () => {
  const rules = cssRules(CSS);
  for (let vw = 320; vw <= 1440; vw++) {
    const wrapper = declsAt(rules, '.rkr-wrapper', vw);
    const side = px(wrapper.padding.split(/\s+/)[1]);
    const available = Math.min(vw, px(wrapper['max-width'])) - 2 * side;
    const panel = declsAt(rules, '.rkr-panel', vw);
    const panelSide = panel.padding === '0' ? 0 : px(panel.padding.split(/\s+/)[1]);
    const panelBorder = panel.border === 'none' ? 0 : px(panel.border.split(/\s+/)[0]);
    const board = declsAt(rules, '.rkr-board', vw);
    const led = declsAt(rules, '.rkr-led', vw);
    const reg = declsAt(rules, '.rkr-reg', vw);
    assert.equal(led.width, 'var(--rkr-led)');
    assert.equal(led.height, 'var(--rkr-led)');
    assert.equal(reg.width, 'var(--rkr-reg)');
    assert.equal(declsAt(rules, '.rkr-wrapper *', vw)['box-sizing'], 'border-box');
    assert.equal(board.width, 'max-content');
    assert.equal(board.margin, '0 auto');
    const regWidth = px(board['--rkr-reg']);
    // The widest register ('0x3F' on six LEDs) fits its column (0.61em a
    // character covers the widest common monospace fonts).
    assert.ok(4 * 0.61 * px(reg['font-size']) <= regWidth, vw + 'px: a register of ' + regWidth + 'px');
    for (const n of SIZES) {
      const size = px(declsAt(rules, '.rkr-board--n' + n, vw)['--rkr-led']);
      // n LED columns and the register column: n gaps.
      const width = n * size + n * px(board.gap) + regWidth + 2 * px(board.padding) +
        2 * px(board.border.split(/\s+/)[0]) + 2 * panelSide + 2 * panelBorder;
      assert.ok(width <= available, vw + 'px: a ' + n + 'x' + n + ' rack of ' + width + 'px in ' + available + 'px');
      assert.ok(size >= 36, vw + 'px: ' + n + 'x' + n + ' LEDs of ' + size + 'px');
    }
    // Six stat cards in equal columns; the widest value ('36/36') fits a card and never is cut off.
    const stats = declsAt(rules, '.rkr-stats', vw);
    const columns = /^repeat\(([36]), minmax\(0, 1fr\)\)$/.exec(stats['grid-template-columns']);
    assert.ok(columns, vw + 'px: ' + stats['grid-template-columns']);
    const stat = declsAt(rules, '.rkr-stat', vw);
    const value = declsAt(rules, '.rkr-stat-value', vw);
    const card = (available - (Number(columns[1]) - 1) * px(stats.gap)) / Number(columns[1]);
    const content = card - 2 * px(stat.padding.split(/\s+/)[1]) - 2 * px(stat.border.split(/\s+/)[0]);
    assert.ok(5 * 0.61 * rem(value['font-size']) <= content, vw + 'px: a stat of ' + content + 'px');
    assert.equal(value['white-space'], 'normal');
    assert.equal(value['overflow-wrap'], 'anywhere');
    assert.equal(value['text-overflow'], undefined);
    // On phones the model select takes two thirds of the row and its longest option fits.
    if (vw <= 640) {
      const controls = declsAt(rules, '.rkr-controls', vw);
      assert.equal(controls['grid-template-columns'], 'minmax(0, 2fr) minmax(0, 1fr)');
      const select = declsAt(rules, '.rkr-select', vw);
      assert.equal(select['min-width'], '0');
      assert.equal(select.width, '100%');
      const column = (available - px(controls.gap)) * 2 / 3;
      const longest = Math.max(...MODELS.map(([key, , name]) => ('RK-' + key + ' ' + name).length));
      const needed = longest * 0.61 * rem(select['font-size']) + 2 * rem(select.padding.split(/\s+/)[1]) + 24 + 2;
      assert.ok(needed <= column, vw + 'px: the model select needs ' + needed + 'px of ' + column + 'px');
    }
  }
  // Long words and numbers wrap instead of widening the page.
  for (const selector of ['.rkr-mode', '.rkr-status', '.rkr-hint', '.rkr-solver', '.rkr-warning', '.rkr-toast', '.rkr-subtitle', '.rkr-help-list']) {
    assert.equal(declsAt(rules, selector, 320)['overflow-wrap'], 'anywhere', selector);
    assert.notEqual(declsAt(rules, selector, 320)['white-space'], 'nowrap', selector);
  }
  // The toast is as wide as its message up to the screen less 16px a side
  // (an auto width at left: 50% would only get the right half of a phone).
  for (const vw of [320, 414, 1440]) {
    const toast = declsAt(rules, '.rkr-toast', vw);
    assert.equal(toast.position, 'fixed');
    assert.equal(toast.left, '50%');
    assert.equal(toast.width, 'max-content', vw + 'px');
    assert.equal(toast['max-width'], 'calc(100vw - 32px)');
    assert.match(toast.transform, /^translateX\(-50%\)/);
  }
  // The board's scroll container clips what is drawn outside it, so the
  // board's shadows are inset and its focus ring sits inside.
  for (const rule of rules.filter((r) => r.selectors.some((s) => /^\.rkr-board(--[\w-]+)?(:[\w-]+)?$/.test(s)))) {
    for (const layer of rule.decls['box-shadow'] ? rule.decls['box-shadow'].split(/,(?![^(]*\))/) : []) {
      assert.match(layer.trim(), /^inset /, rule.selectors.join(', '));
    }
    if (rule.decls['outline-offset'] !== undefined) assert.ok(parseFloat(rule.decls['outline-offset']) <= 0, rule.selectors.join(', '));
  }
  assert.equal(declsAt(rules, '.rkr-board-wrap', 320)['overflow-x'], 'auto');
  // Tap targets keep scrolling and pinch zoom but drop the double-tap delay; nothing takes every gesture.
  const touch = rules.filter((rule) => rule.decls['touch-action'] !== undefined);
  assert.deepEqual(touch.map((rule) => [rule.selectors, rule.decls['touch-action']]), [
    [['.rkr-btn'], 'manipulation'], [['.rkr-select'], 'manipulation'], [['.rkr-board'], 'manipulation']
  ]);
  // The board is an ordinary grid flow: nothing in it is positioned on its own except the lamp in its bezel.
  assert.equal(declsAt(rules, '.rkr-led', 320).position, 'relative');
  assert.equal(declsAt(rules, '.rkr-led::after', 320).position, 'absolute');
  assert.equal(declsAt(rules, '.rkr-reg', 320).position, undefined);
  // The desktop look.
  assert.deepEqual(SIZES.map((n) => declsAt(rules, '.rkr-board--n' + n, 1280)['--rkr-led']), ['72px', '64px', '56px', '50px']);
  assert.deepEqual(SIZES.map((n) => declsAt(rules, '.rkr-board--n' + n, 320)['--rkr-led']), ['62px', '52px', '42px', '36px']);
});

// ── Masks and racks ──────────────────────────────────────────────────────────

test('rack-reset: masks read as three hex digits; a press flips the stencil clipped at the edges, twice is nothing and order never matters', (t) => {
  assert.deepEqual(MODELS.map(([, mask]) => rkr.rkrMaskHex(mask)), ['0x272', '0x525', '0x070', '0x575', '0x632', '0x777']);
  assert.equal(rkr.rkrMaskHex(0x002), '0x002');
  for (const [key, mask] of MODELS) {
    assert.deepEqual(rkr.rkrMaskOffsets(mask), stencil(mask), key);
    assert.ok(stencil(mask).some(([r, c]) => r === 0 && c === 0), key + ' holds its centre');
    for (const n of SIZES) {
      for (let i = 0; i < n * n; i++) assert.deepEqual(rkr.rkrToggled(n, i, mask), flips(n, mask, i), key + ' ' + n + 'x' + n + ' ' + i);
    }
  }
  // Hand-checked: the cross in a corner and in the middle, the hook (top left, top, centre, right, bottom).
  assert.deepEqual(rkr.rkrToggled(5, 0, 0x272), [0, 1, 5]);
  assert.deepEqual(rkr.rkrToggled(5, 12, 0x272), [7, 11, 12, 13, 17]);
  assert.deepEqual(rkr.rkrToggled(3, 4, 0x632), [0, 1, 4, 5, 7]);
  assert.deepEqual(rkr.rkrToggled(3, 4, 0x777), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  t.mock.method(Math, 'random', seeded(3));
  for (const [key, mask] of MODELS) {
    const n = 5;
    const grid = Array.from({ length: 25 }, () => (Math.random() < 0.5 ? 1 : 0));
    const once = rkr.rkrPress(grid, n, 7, mask);
    assert.deepEqual(once, pressModel(grid, n, mask, 7), key);
    assert.notDeepEqual(once, grid);
    assert.deepEqual(rkr.rkrPress(once, n, 7, mask), grid, key + ': a second press undoes the first');
    assert.deepEqual(rkr.rkrPress(rkr.rkrPress(grid, n, 3, mask), n, 21, mask), rkr.rkrPress(rkr.rkrPress(grid, n, 21, mask), n, 3, mask));
    assert.equal(grid.length, 25, 'the input is left alone');
  }
  assert.equal(rkr.rkrIsSolved(zeros(4)), true);
  assert.equal(rkr.rkrIsSolved([0, 0, 1, 0]), false);
});

test('rack-reset: the null space of every offered model and size has the pinned dimension, at most 12, checked against an independent rank', () => {
  assert.equal(rkr.rkrMaxNullity, 12);
  let largest = 0;
  for (const [key, mask] of MODELS) {
    SIZES.forEach((n, s) => {
      const model = linearModel(n, mask);
      const k = rkr.rkrNullity(n, mask);
      assert.equal(k, n * n - model.rank, key + ' ' + n + 'x' + n + ': rank');
      assert.equal(k, NULLITY[key][s], key + ' ' + n + 'x' + n + ': pinned');
      assert.ok(2 ** k <= 4096, key + ' ' + n + 'x' + n + ': ' + 2 ** k + ' candidates');
      largest = Math.max(largest, k);
      // The game's basis: each vector changes nothing, and together they are independent.
      const sol = rkr.rkrSolveGF2(zeros(n), n, mask);
      assert.equal(sol.rank, model.rank);
      assert.equal(sol.basis.length, k);
      for (const v of sol.basis) assert.equal(model.effect(gridBits(v)), 0n, key + ' ' + n + 'x' + n + ': a null vector');
      const span = new Set();
      for (let m = 0; m < 2 ** k; m++) span.add(sol.basis.reduce((acc, v, b) => ((m >> b) & 1 ? acc ^ gridBits(v) : acc), 0n).toString());
      assert.equal(span.size, 2 ** k, key + ' ' + n + 'x' + n + ': independent');
      assert.deepEqual(sol.x, zeros(n), 'the all-off rack needs no press');
    });
  }
  assert.equal(largest, 9, 'the block on 5x5: 512 candidates');
  // The game names a combination it never offers rather than enumerating it.
  assert.equal(rkr.rkrNullity(4, 0x000), 16);
  assert.throws(() => rkr.rkrMinPresses(zeros(4), 4, 0x000), { message: 'rkrMinPresses: the null space of mask 0x000 on 4x4 has dimension 16, more than 12' });
});

test('rack-reset: rkrMinPresses matches brute force on every 3x3 rack and on sampled 4x4 racks, and finds no presses where none reach', (t) => {
  t.mock.method(Math, 'random', seeded(11));
  for (const [key, mask] of MODELS) {
    for (const n of [3, 4]) {
      const table = bruteTable(n, mask);
      const values = n === 3 ? Array.from({ length: 512 }, (_, v) => v) : Array.from({ length: 300 }, () => Math.floor(Math.random() * 65536));
      if (n === 4) {
        // Reachable 4x4 racks too, as the game deals them.
        for (let s = 0; s < 100; s++) values.push(gridBitsNumber(rkr.rkrGenerate(4, mask, seeded(s))));
      }
      let reachable = 0;
      for (const value of values) {
        const grid = intGrid(value, n);
        const presses = rkr.rkrMinPresses(grid, n, mask);
        if (table[value] === 255) {
          assert.equal(presses, null, key + ' ' + n + 'x' + n + ' ' + value + ' cannot be reset');
          assert.equal(rkr.rkrSolveGF2(grid, n, mask), null);
          continue;
        }
        reachable++;
        assert.equal(presses.length, table[value], key + ' ' + n + 'x' + n + ' ' + value);
        assert.deepEqual(applyAll(grid, n, mask, presses), zeros(n), key + ' ' + n + 'x' + n + ' ' + value + ' is reset');
        assert.deepEqual(presses, presses.slice().sort((a, b) => a - b), 'in index order, each once');
        assert.equal(new Set(presses).size, presses.length);
      }
      const k = NULLITY[key][SIZES.indexOf(n)];
      if (n === 3) assert.equal(reachable, 2 ** (9 - k), key + ': every reachable 3x3 rack was checked');
      else assert.ok(reachable >= 100, key + ' 4x4: ' + reachable + ' reachable racks');
    }
  }
});

function gridBitsNumber(grid) {
  return grid.reduce((acc, v, i) => acc | (v << i), 0);
}

test('rack-reset: on 240 seeded racks of every model and size the solver\'s answer resets the rack and is the minimum over the null space', () => {
  for (const [key, mask] of MODELS) {
    for (const n of SIZES) {
      const model = linearModel(n, mask);
      for (let s = 0; s < 10; s++) {
        const grid = rkr.rkrGenerate(n, mask, seeded(1000 + s));
        assert.ok(lit(grid) > 0, 'never an empty rack');
        const sol = rkr.rkrSolveGF2(grid, n, mask);
        assert.deepEqual(applyAll(grid, n, mask, sol.x.flatMap((v, i) => (v ? [i] : []))), zeros(n), 'the particular solution resets it');
        const presses = rkr.rkrMinPresses(grid, n, mask);
        assert.deepEqual(applyAll(grid, n, mask, presses), zeros(n), key + ' ' + n + 'x' + n + ' seed ' + s);
        const set = presses.reduce((acc, i) => acc | (1n << BigInt(i)), 0n);
        assert.equal(model.effect(set), gridBits(grid));
        assert.equal(presses.length, minimumByNullSpace(model, grid, set), key + ' ' + n + 'x' + n + ' seed ' + s + ': the minimum');
      }
    }
  }
  // The block on 5x5 has the largest null space: every rack of it walks the
  // same 2^9 = 512 candidates, far below the 4096 the solver allows.
  for (let s = 0; s < 50; s++) {
    const grid = rkr.rkrGenerate(5, 0x777, seeded(s));
    assert.equal(2 ** rkr.rkrSolveGF2(grid, 5, 0x777).basis.length, 512);
  }
});

// The fewest presses for a grid by the independent model.
function modelPar(n, mask, grid) {
  const model = linearModel(n, mask);
  const presses = rkr.rkrMinPresses(grid, n, mask);
  return minimumByNullSpace(model, grid, presses.reduce((acc, i) => acc | (1n << BigInt(i)), 0n));
}

test('rack-reset: a rack is dealt by presses of chance 1/2 from all-off, drawn again when they cancel out or reset below the par floor, and the first 5x5 cross of seeded(1) is pinned', () => {
  assert.deepEqual(rkr.rkrParFloor, PAR_FLOOR);
  assert.equal(rkr.rkrGenerateTries, 20);
  // One draw per LED and a press below 0.5, checked against the model: the
  // rack is the last 16 draws, and every draw before was empty or too easy.
  for (const [key, mask] of MODELS) {
    const draws = [];
    const rnd = seeded(5);
    const grid = rkr.rkrGenerate(4, mask, () => {
      const x = rnd();
      draws.push(x);
      return x;
    });
    assert.equal(draws.length % 16, 0, key);
    const racks = [];
    for (let at = 0; at < draws.length; at += 16) {
      racks.push(applyAll(zeros(4), 4, mask, draws.slice(at, at + 16).flatMap((x, i) => (x < 0.5 ? [i] : []))));
    }
    assert.deepEqual(grid, racks[racks.length - 1], key);
    assert.ok(modelPar(4, mask, grid) >= 4, key);
    for (const early of racks.slice(0, -1)) assert.ok(lit(early) === 0 || bruteTable(4, mask)[gridBitsNumber(early)] < 4, key);
  }
  assert.deepEqual(rowsOf(rkr.rkrGenerate(5, 0x272, seeded(1)), 5), SEED1_START);
  assert.equal(rkr.rkrMinPresses(gridOf(SEED1_START), 5, 0x272).length, SEED1_PAR);
  // Presses that cancel out (here a null vector of the 4x4 cross) are drawn
  // again, and so is a rack one press resets (LED 15 alone); then A1 to D1.
  const nullVector = rkr.rkrSolveGF2(zeros(4), 4, 0x272).basis[0];
  const press = (set) => Array.from({ length: 16 }, (_, i) => (set.includes(i) ? 0.1 : 0.9));
  const script = nullVector.map((v) => (v ? 0.1 : 0.9)).concat(press([15]), press([0, 1, 2, 3]));
  let at = 0;
  const again = rkr.rkrGenerate(4, 0x272, () => script[at++]);
  assert.equal(at, 48);
  assert.deepEqual(again, applyAll(zeros(4), 4, 0x272, [0, 1, 2, 3]));
  assert.equal(bruteTable(4, 0x272)[gridBitsNumber(again)], 4);
  // A random source that never presses: after 20 empty draws the LEDs are
  // pressed in index order until the par reaches the floor.
  let calls = 0;
  const stuck = rkr.rkrGenerate(6, 0x632, () => {
    calls++;
    return 0.9;
  });
  assert.equal(calls, 720);
  assert.deepEqual(stuck, applyAll(zeros(6), 6, 0x632, [0, 1, 2, 3]));
  assert.equal(modelPar(6, 0x632, stuck), 4);
});

test('rack-reset: every offered model and size deals racks at or above its par floor, also from a broken random source', () => {
  for (const [key, mask] of MODELS) {
    for (const n of SIZES) {
      const floor = PAR_FLOOR[n];
      const table = n <= 4 ? bruteTable(n, mask) : null;
      const par = (grid) => (table ? table[gridBitsNumber(grid)] : modelPar(n, mask, grid));
      // The hook on 3x3 resets in 4 presses at most: the floor of 3 leaves it a puzzle.
      for (let s = 0; s < (n <= 4 ? 60 : 15); s++) {
        const grid = rkr.rkrGenerate(n, mask, seeded(500 + s));
        assert.ok(par(grid) >= floor, key + ' ' + n + 'x' + n + ' seed ' + s + ': par ' + par(grid));
      }
      // The fallback: the first run of presses A1, B1, ... whose par reaches the floor.
      const fallback = rkr.rkrGenerate(n, mask, () => 0.9);
      let grid = zeros(n);
      let count = 0;
      while (par(grid) < floor) {
        assert.ok(count < n * n, key + ' ' + n + 'x' + n + ': the fallback reaches the floor');
        grid = pressModel(grid, n, mask, count++);
      }
      assert.deepEqual(fallback, grid, key + ' ' + n + 'x' + n);
    }
  }
});

test('rack-reset: registers read each row in hex, the left LED highest; LED names, the cursor, row strings and the config', () => {
  const grid = gridOf(['11111', '00001', '10000', '00000', '01011']);
  assert.deepEqual([0, 1, 2, 3, 4].map((r) => rkr.rkrRowHex(grid, 5, r)), ['0x1F', '0x01', '0x10', '0x00', '0x0B']);
  assert.deepEqual([0, 1, 2].map((r) => rkr.rkrRowHex(gridOf(['101', '000', '111']), 3, r)), ['0x5', '0x0', '0x7']);
  assert.equal(rkr.rkrRowHex(gridOf(['1011', '0000', '0000', '0000']), 4, 0), '0xB');
  assert.equal(rkr.rkrRowHex(gridOf(['111111', ...new Array(5).fill('000000')]), 6, 0), '0x3F');
  assert.deepEqual([0, 4, 12, 24, 35].map((i) => rkr.rkrCellName(i, i === 35 ? 6 : 5)), ['A1', 'E1', 'C3', 'E5', 'F6']);
  assert.equal(rkr.rkrStep(12, 5, [-1, 0]), 7);
  assert.equal(rkr.rkrStep(12, 5, [0, 1]), 13);
  assert.equal(rkr.rkrStep(0, 5, [-1, 0]), 0, 'the cursor stops at the top');
  assert.equal(rkr.rkrStep(0, 5, [0, -1]), 0);
  assert.equal(rkr.rkrStep(24, 5, [1, 0]), 24);
  assert.equal(rkr.rkrStep(24, 5, [0, 1]), 24);
  assert.deepEqual(rkr.rkrGridRows(grid, 5), ['11111', '00001', '10000', '00000', '01011']);
  assert.deepEqual(rkr.rkrRowsGrid(['101', '000', '111'], 3), [1, 0, 1, 0, 0, 0, 1, 1, 1]);
  for (const bad of [null, '101000111', ['101', '000'], ['101', '000', '1110'], ['101', '000', '12a'], ['101', '000', 7], ['101', '000', '']]) {
    assert.equal(rkr.rkrRowsGrid(bad, 3), null, JSON.stringify(bad));
  }
  assert.deepEqual(rkr.rkrConfigOf('632', '4'), { model: '632', size: 4 });
  assert.deepEqual(rkr.rkrConfigOf('999', '9'), { model: '272', size: 5 });
  assert.deepEqual(rkr.rkrConfigOf(undefined, undefined), { model: '272', size: 5 });
  assert.deepEqual(rkr.rkrCombos(), MODELS.flatMap(([key]) => SIZES.map((n) => key + '-' + n)));
});

test('rack-reset: keys map to actions by their value, then by the physical key only on layouts whose letters are not Latin', () => {
  const action = (key, code) => rkr.rkrKeyAction({ key, code });
  assert.deepEqual(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter', 'h', 'H', 'u', 'U', 'r', 'R', 'n', 'N'].map((k) => action(k, '')),
    ['up', 'down', 'left', 'right', 'press', 'press', 'hint', 'hint', 'undo', 'undo', 'restart', 'restart', 'new', 'new']);
  assert.deepEqual([['р', 'KeyH'], ['г', 'KeyU'], ['к', 'KeyR'], ['т', 'KeyN'], ['Т', 'KeyN']].map(([k, c]) => action(k, c)), ['hint', 'undo', 'restart', 'new', 'new']);
  // Dvorak: KeyN types b, KeyR p, KeyU g, KeyH d; none of those is a game key.
  for (const [k, c] of [['b', 'KeyN'], ['B', 'KeyN'], ['p', 'KeyR'], ['g', 'KeyU'], ['d', 'KeyH']]) assert.equal(action(k, c), null, k + ' on ' + c);
  // Named keys that are no letter never fall back either.
  for (const k of ['Unidentified', 'Process', 'Dead']) assert.equal(action(k, 'KeyN'), null, k);
  // A Cyrillic letter on a key that is no game key.
  assert.equal(action('ф', 'KeyA'), null);
  assert.equal(action('x', 'KeyX'), null);
  assert.equal(action('Tab', 'Tab'), null);
  assert.equal(action(undefined, 'KeyH'), null, 'an autofill keydown has no key');
});

// ── Saves (pure) ─────────────────────────────────────────────────────────────

test('rack-reset: rkrParseState reads a save of the current format field for field', () => {
  const parsed = rkr.rkrParseState(SAMPLE_SAVE);
  assert.equal(parsed.model, '272');
  assert.equal(parsed.size, 5);
  const game = parsed.game;
  assert.deepEqual(Object.keys(game).sort(), ['grid', 'hinted', 'history', 'model', 'moves', 'par', 'replay', 'rev', 'size', 'solved', 'start']);
  assert.equal(game.rev, 7);
  assert.equal(game.model, '272');
  assert.equal(game.size, 5);
  assert.deepEqual(game.start, gridOf(SEED1_START));
  assert.deepEqual(game.grid, applyAll(gridOf(SEED1_START), 5, 0x272, [12, 0]));
  assert.equal(game.moves, 2);
  assert.deepEqual(game.history, [12, 0]);
  assert.equal(game.hinted, false);
  assert.equal(game.replay, false);
  assert.equal(game.par, SEED1_PAR);
  assert.equal(game.solved, false);
  // A reset rack, hinted and a replay.
  const done = rkr.rkrParseState(JSON.stringify(saveOf('777', 3, gridOf(['100', '000', '000']), { grid: ['000', '000', '000'], moves: 4, history: [0, 1, 3, 4], hinted: true, replay: true, rev: 3 }))).game;
  assert.equal(done.solved, true);
  assert.equal(done.par, bruteTable(3, 0x777)[1], 'par from the start, by brute force');
  assert.equal(done.hinted, true);
  assert.equal(done.replay, true);
});

test('rack-reset: rkrParseState falls back field by field', () => {
  const base = JSON.parse(SAMPLE_SAVE);
  const start = gridOf(SEED1_START);
  const replayed = applyAll(start, 5, 0x272, [12, 0]);
  const parse = (extra) => rkr.rkrParseState(JSON.stringify(Object.assign({}, base, extra))).game;
  // A bad history is dropped; the grid, which differs from the start, is kept.
  for (const history of ['12,0', null, [12, -1], [12, 25], [12, 1.5], ['12'], new Array(501).fill(0)]) {
    const game = parse({ history });
    assert.deepEqual(game.history, [], JSON.stringify(history).slice(0, 30));
    assert.deepEqual(game.grid, replayed);
    assert.equal(game.moves, 2);
  }
  assert.deepEqual(parse({ history: new Array(500).fill(3), grid: SEED1_START, moves: 600 }).history.length, 500, 'a full history of 500 is kept');
  // A grid that is no grid falls back to the start with the history replayed, moves to its length.
  for (const grid of [undefined, null, ['10110'], ['10110', '11100', '01100', '01000', '1001'], ['10110', '11100', '01100', '01000', '10012'], 'x']) {
    const game = parse({ grid, moves: 9 });
    assert.deepEqual(game.grid, replayed, JSON.stringify(grid));
    assert.equal(game.moves, 2);
    assert.deepEqual(game.history, [12, 0]);
  }
  // A grid the solver can reset but that the history does not explain, with
  // as many moves as the history: kept, history dropped.
  const otherGrid = rowsOf(pressModel(start, 5, 0x272, 6), 5);
  const other = parse({ grid: otherGrid, moves: 2 });
  assert.deepEqual(other.grid, pressModel(start, 5, 0x272, 6));
  assert.deepEqual(other.history, []);
  assert.equal(other.moves, 2);
  // With more moves than the history, the cap dropped the oldest presses:
  // grid and history are both kept, so Undo still takes the kept ones back.
  const capped = parse({ grid: otherGrid, moves: 5 });
  assert.deepEqual(capped.grid, pressModel(start, 5, 0x272, 6));
  assert.deepEqual(capped.history, [12, 0]);
  assert.equal(capped.moves, 5);
  // Moves: a count no lower than the history, else the history's length.
  for (const moves of [-1, 1.5, '3', null, 1]) assert.equal(parse({ moves }).moves, 2, JSON.stringify(moves));
  assert.equal(parse({ moves: 40 }).moves, 40);
  // Flags only when true, the revision only as a count.
  assert.equal(parse({ hinted: 'true' }).hinted, false);
  assert.equal(parse({ replay: 1 }).replay, false);
  for (const rev of [-2, 'x', 2.5, null]) assert.equal(parse({ rev }).rev, 0);
  // A 4x4 cross grid that no presses reset falls back to the replay.
  const s4 = rkr.rkrGenerate(4, 0x272, seeded(2));
  const save4 = saveOf('272', 4, s4, { grid: ['1000', '0000', '0000', '0000'], history: [5], moves: 1 });
  assert.equal(rkr.rkrSolveGF2(gridOf(save4.grid), 4, 0x272), null);
  const game4 = rkr.rkrParseState(JSON.stringify(save4)).game;
  assert.deepEqual(game4.grid, pressModel(s4, 4, 0x272, 5));
  assert.deepEqual(game4.history, [5]);
});

test('rack-reset: rkrParseState finds no game in saves that cannot be played, and keeps the model and size they asked for', () => {
  const base = JSON.parse(SAMPLE_SAVE);
  const cases = {
    'not JSON': ['{"v":1,', '272', 5],
    null: ['null', '272', 5],
    array: ['[1,2]', '272', 5],
    number: ['42', '272', 5],
    'empty object': ['{}', '272', 5],
    'unknown model': [Object.assign({}, base, { model: '999' }), '272', 5],
    'model as a number': [Object.assign({}, base, { model: 272 }), '272', 5],
    'unknown size': [Object.assign({}, base, { size: 7 }), '272', 5],
    'size as text': [Object.assign({}, base, { size: '5' }), '272', 5],
    'start of another size': [Object.assign({}, base, { model: '777', size: 4 }), '777', 4],
    'start missing': [Object.assign({}, base, { model: '525', start: undefined }), '525', 5],
    'start all off': [Object.assign({}, base, { start: ['00000', '00000', '00000', '00000', '00000'] }), '272', 5],
    'start no presses reset': [saveOf('272', 4, gridOf(['1000', '0000', '0000', '0000'])), '272', 4]
  };
  for (const [name, [save, model, size]] of Object.entries(cases)) {
    const parsed = rkr.rkrParseState(typeof save === 'string' ? save : JSON.stringify(save));
    assert.equal(parsed.game, null, name);
    assert.equal(parsed.model, model, name);
    assert.equal(parsed.size, size, name);
  }
  assert.deepEqual(rkr.rkrParseState(null), { model: '272', size: 5, game: null });
});

test('rack-reset: rkrParseBest reads an rkr-best of the current format field for field', () => {
  const best = rkr.rkrParseBest(SAMPLE_BEST);
  assert.deepEqual(Object.keys(best), rkr.rkrCombos());
  for (const key of rkr.rkrCombos()) {
    assert.deepEqual(Object.keys(best[key]), ['over', 'wins'], key);
    assert.equal(best[key].over, key === '272-5' ? 0 : null, key);
    assert.equal(best[key].wins, key === '272-5' ? 1 : 0, key);
  }
  assert.equal(JSON.stringify(best), SAMPLE_BEST, 'written back as the same text');
});

test('rack-reset: rkrParseBest keeps the fewest presses over par and the resets per model and size, each on its own; rkrMergeBest keeps the better of two tabs', () => {
  const empty = rkr.rkrParseBest(null);
  assert.deepEqual(Object.keys(empty), rkr.rkrCombos());
  for (const key of rkr.rkrCombos()) assert.deepEqual(empty[key], { over: null, wins: 0 });
  const best = rkr.rkrParseBest(JSON.stringify({
    '272-5': { over: 2, wins: 7 }, '525-3': { over: 0, wins: 1 }, '070-6': { over: -1, wins: 3 }, '575-4': { over: 1.5, wins: -2 },
    '632-5': { over: '1', wins: '4' }, '777-6': 'x', '999-5': { over: 0, wins: 9 }
  }));
  assert.deepEqual(best['272-5'], { over: 2, wins: 7 });
  assert.deepEqual(best['525-3'], { over: 0, wins: 1 });
  assert.deepEqual(best['070-6'], { over: null, wins: 3 });
  assert.deepEqual(best['575-4'], { over: null, wins: 0 });
  assert.deepEqual(best['632-5'], { over: null, wins: 0 });
  assert.deepEqual(best['777-6'], { over: null, wins: 0 });
  assert.equal(best['999-5'], undefined, 'unknown entries are dropped');
  for (const text of ['{', '[]', '7', 'null']) assert.deepEqual(rkr.rkrParseBest(text), empty, text);
  const a = rkr.rkrParseBest(JSON.stringify({ '272-5': { over: 3, wins: 2 }, '272-4': { over: 1, wins: 1 }, '272-3': { over: 0, wins: 5 } }));
  const b = rkr.rkrParseBest(JSON.stringify({ '272-5': { over: 1, wins: 4 }, '272-4': { over: 2, wins: 0 }, '525-5': { over: 6, wins: 1 } }));
  const merged = rkr.rkrMergeBest(a, b);
  assert.deepEqual(merged['272-5'], { over: 1, wins: 4 });
  assert.deepEqual(merged['272-4'], { over: 1, wins: 1 });
  assert.deepEqual(merged['272-3'], { over: 0, wins: 5 });
  assert.deepEqual(merged['525-5'], { over: 6, wins: 1 });
  assert.deepEqual(merged['777-6'], { over: null, wins: 0 });
  assert.deepEqual(rkr.rkrMergeBest(b, a), merged);
});

// ── The page ─────────────────────────────────────────────────────────────────

test('rack-reset: loading the script under Node runs no init: no lookup, listener, timer or save', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.rkrInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['rkr-board'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('rack-reset: a first visit shows a 5x5 cross rack with its registers, stats, mask and solver line, and saves it', (t) => {
  const { v } = openPage(t);
  const start = gridOf(SEED1_START);
  assert.deepEqual(storedKeys(), [STATE_KEY]);
  assert.equal(localStorage.getItem(STATE_KEY), JSON.stringify(saveOf('272', 5, start)));
  // Five LEDs then the row's register, five times.
  assert.deepEqual(v.board.children.map((el) => el.classList.contains('rkr-reg') ? 'R' : 'L').join(''), 'LLLLLR'.repeat(5));
  assert.equal(v.board.style.gridTemplateColumns, 'repeat(5, var(--rkr-led)) var(--rkr-reg)');
  assert.equal(v.board.className, 'rkr-board rkr-board--n5');
  assert.equal(v.cursor(), 'rkr-led-12');
  v.leds().forEach((led, i) => {
    assert.equal(led.id, 'rkr-led-' + i);
    assert.equal(led.getAttribute('data-index'), String(i));
    assert.equal(led.getAttribute('role'), 'button');
    assert.equal(led.className, 'rkr-led' + (start[i] ? ' rkr-led--on' : '') + (i === 12 ? ' rkr-led--cursor' : ''), 'LED ' + i);
    assert.equal(led.getAttribute('aria-label'), 'ABCDE'[i % 5] + (Math.floor(i / 5) + 1) + (start[i] ? ' alarm on' : ' clear'));
  });
  assert.deepEqual(v.regs().map((reg) => reg.textContent), ['0x0E', '0x08', '0x02', '0x0C', '0x13']);
  assert.ok(v.regs().every((reg) => reg.className === 'rkr-reg' && reg.getAttribute('aria-hidden') === 'true'));
  assert.equal(v.text('mask-hex'), '0x272');
  assert.equal(v.text('lit'), lit(start) + '/25');
  assert.equal(v.text('moves'), '0');
  assert.equal(v.text('par'), String(SEED1_PAR));
  assert.equal(v.text('best'), '--');
  assert.equal(v.text('cleared'), '0');
  assert.equal(v.text('mode'), 'RK-272 cross · 5x5 · mask 0x272');
  assert.equal(v.text('status'), lit(start) + ' of 25 alarms lit. A press flips the LEDs under mask 0x272 around it.');
  assert.equal(v.text('solver'), 'GF(2) solver: rank 23 of 25, null space dimension 2, 4 candidates for the minimum.');
  assert.equal(v.text('hint'), '');
  assert.equal(v.board.getAttribute('aria-label'), 'Rack RK-272 5x5: ' + lit(start) + ' of 25 alarms lit');
  // The mask preview: the cross, its middle the LED pressed.
  assert.deepEqual(v.el('mask-grid').children.map((cell) => cell.className), [
    'rkr-mask-cell', 'rkr-mask-cell rkr-mask-cell--on', 'rkr-mask-cell',
    'rkr-mask-cell rkr-mask-cell--on', 'rkr-mask-cell rkr-mask-cell--on rkr-mask-cell--self', 'rkr-mask-cell rkr-mask-cell--on',
    'rkr-mask-cell', 'rkr-mask-cell rkr-mask-cell--on', 'rkr-mask-cell'
  ]);
  assert.equal(v.el('model').value, '272');
  assert.equal(v.el('size').value, '5');
  assert.equal(v.hidden('warning'), true);
  assert.equal(v.toast(), null);
  // One listener per control; storage and pageshow on window; keys only on the board.
  for (const [name, type] of [['board', 'click'], ['board', 'keydown'], ['new-game', 'click'], ['restart', 'click'], ['undo', 'click'],
    ['hint-button', 'click'], ['model', 'change'], ['size', 'change']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(v.board), 2);
  assert.equal(listenerCount(document), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(document.body), 0);
  assert.equal(listenerCount(window), 2);
  assert.equal(listenerCount(window, 'storage'), 1);
  assert.equal(listenerCount(window, 'pageshow'), 1);
  assert.deepEqual(Object.keys(v.exposed), [], 'the IIFE leaves no global behind on the host page');
});

test('rack-reset: while the page is still loading the game waits for DOMContentLoaded', (t) => {
  const { v } = openPage(t, { storage: { state: SAMPLE_SAVE }, options: { readyState: 'loading' } });
  assert.equal(v.leds().length, 0);
  assert.equal(v.text('status'), 'Powering up the rack...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(v.board, 'click'), 0);
  v.ready();
  assert.equal(v.leds().length, 25);
  assert.equal(v.text('moves'), '2');
  assert.equal(listenerCount(v.board, 'click'), 1);
});

test('rack-reset: init runs once: a second call binds nothing twice', (t) => {
  makeClock(t);
  t.mock.method(Math, 'random', seeded(1));
  const { exports: fresh, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  fresh.rkrInit();
  const saved = localStorage.getItem(STATE_KEY);
  fresh.rkrInit();
  assert.equal(localStorage.getItem(STATE_KEY), saved);
  assert.equal(listenerCount(els['rkr-board'], 'click'), 1);
  assert.equal(listenerCount(els['rkr-board'], 'keydown'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  assert.equal(els['rkr-mask-grid'].children.length, 9);
  assert.equal(fresh.rkrRuntime.els.board, els['rkr-board']);
});

test('rack-reset: a tap presses an LED: the mask flips it and its neighbours, the registers follow, and the press is saved', (t) => {
  const { v } = openPage(t);
  let grid = gridOf(SEED1_START);
  v.tap(0);
  grid = pressModel(grid, 5, 0x272, 0);
  assert.deepEqual(v.grid(), grid);
  assert.deepEqual(v.leds().map((led) => (led.classList.contains('rkr-led--on') ? 1 : 0)), grid);
  assert.deepEqual(v.regs().map((reg) => reg.textContent), rowsOf(grid, 5).map((row) => '0x' + parseInt(row, 2).toString(16).toUpperCase().padStart(2, '0')));
  assert.deepEqual(v.state().history, [0]);
  assert.equal(v.state().moves, 1);
  assert.equal(v.state().rev, 2);
  assert.equal(v.text('moves'), '1');
  assert.equal(v.text('lit'), lit(grid) + '/25');
  assert.equal(v.cursor(), 'rkr-led-0', 'the tapped LED takes the cursor');
  v.tap(12);
  grid = pressModel(grid, 5, 0x272, 12);
  assert.deepEqual(v.grid(), grid);
  assert.deepEqual(v.state().history, [0, 12]);
  assert.equal(v.state().rev, 3);
  // A register and the board's padding are no LED.
  v.regs()[2].click();
  v.board.click();
  assert.deepEqual(v.state().history, [0, 12]);
  // A row of all-off LEDs shows its register in green.
  const zeroRows = rowsOf(grid, 5).map((row) => /^0+$/.test(row));
  v.regs().forEach((reg, r) => assert.equal(reg.classList.contains('rkr-reg--zero'), zeroRows[r]));
});

test('rack-reset: keys work only while the board has the focus: arrows, Space / Enter, H, U, R and N', (t) => {
  const { v } = openPage(t);
  const start = gridOf(SEED1_START);
  let ev = v.press('ArrowUp');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(v.cursor(), 'rkr-led-7');
  assert.equal(v.has(7, 'rkr-led--cursor'), true);
  assert.equal(v.has(12, 'rkr-led--cursor'), false);
  assert.match(v.board.className, /\brkr-board--keys\b/);
  for (let k = 0; k < 5; k++) v.press('ArrowLeft');
  for (let k = 0; k < 5; k++) v.press('ArrowUp', { repeat: true });
  assert.equal(v.cursor(), 'rkr-led-0', 'the cursor stops at the edges; held arrows repeat');
  v.press('ArrowDown');
  v.press('ArrowRight');
  v.press('ArrowLeft');
  v.press('ArrowUp');
  ev = v.press(' ');
  assert.equal(ev.defaultPrevented, true, 'Space never scrolls the page from the board');
  assert.deepEqual(v.state().history, [0]);
  v.press('Enter');
  assert.deepEqual(v.state().history, [0, 0]);
  assert.deepEqual(v.grid(), start, 'two presses cancel out');
  v.press('u');
  assert.deepEqual(v.state().history, [0]);
  // A held key acts once.
  ev = v.press('u', { repeat: true });
  assert.equal(ev.defaultPrevented, true);
  ev = v.press(' ', { repeat: true });
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(v.state().history, [0]);
  v.press('г', { code: 'KeyU' });
  assert.deepEqual(v.state().history, []);
  v.press('r');
  assert.equal(v.toast(), 'Rack RK-272 5x5 is already at its first state (0 presses).');
  v.press('h');
  assert.match(v.text('hint'), /^Hint: press C1\./);
  assert.equal(v.cursor(), 'rkr-led-2', 'the hint takes the cursor');
  v.press(' ');
  assert.deepEqual(v.state().history, [2]);
  v.press('к', { code: 'KeyR' });
  assert.deepEqual(v.state().history, []);
  assert.equal(v.toast(), 'Rack RK-272 5x5 restarted (par 10). Hint used: not scored.');
  v.press('р', { code: 'KeyH' });
  assert.match(v.text('hint'), /^Hint: press C1\./);

  // Shortcuts, composing text, keys a page script handled and other keys stay with the browser.
  const before = localStorage.getItem(STATE_KEY);
  for (const props of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    for (const key of [' ', 'ArrowRight', 'n', 'r', 'h', 'u']) {
      assert.equal(v.press(key, props).defaultPrevented, false, key + ' ' + JSON.stringify(props));
    }
  }
  assert.equal(v.press('x').defaultPrevented, false);
  assert.equal(v.press('Tab').defaultPrevented, false);
  assert.equal(v.press(undefined).defaultPrevented, false);
  const handled = (event) => event.preventDefault();
  document.addEventListener('keydown', handled, true);
  v.press(' ');
  v.press('n');
  document.removeEventListener('keydown', handled, true);
  // Keys typed into host-page fields, links, buttons and selects never reach the board.
  for (const [id, tag] of [['host-input', 'input'], ['host-link', 'a'], ['host-button', 'button'], ['host-select', 'select']]) {
    const target = v.page.add(id, tag);
    for (const key of ['ArrowLeft', ' ', 'Enter', 'h', 'u', 'r', 'n']) assert.equal(pressKey(key, { target }).defaultPrevented, false, id + ' ' + key);
  }
  for (const key of ['ArrowLeft', ' ', 'n']) assert.equal(pressKey(key, { target: document.body }).defaultPrevented, false);
  // The game's own controls keep their keys too: Enter on New Game is a click, not a press on the rack.
  assert.equal(pressKey('ArrowLeft', { target: v.el('model') }).defaultPrevented, false);
  assert.equal(localStorage.getItem(STATE_KEY), before);
  assert.equal(v.cursor(), 'rkr-led-2');

  // A tap hides the keyboard cursor again; N with presses on the rack asks
  // first, a held N never confirms, and a second N deals a new rack of the
  // same model and size.
  v.tap(4);
  assert.doesNotMatch(v.board.className, /rkr-board--keys/);
  const old = v.state().start;
  v.press('n');
  assert.equal(v.toast(), 'Rack RK-272 5x5 has 1 press on it: press New Game or N within 4 s to throw it away and deal a new RK-272 5x5 rack.');
  assert.deepEqual(v.state().start, old);
  v.press('n', { repeat: true });
  assert.deepEqual(v.state().start, old);
  v.press('n');
  assert.notDeepEqual(v.state().start, old);
  assert.equal(v.state().moves, 0);
  assert.equal(v.state().hinted, false);
  assert.equal(v.cursor(), 'rkr-led-12');
  v.choose('777', 3);
  v.press('т', { code: 'KeyN' });
  assert.equal(v.state().model, '777');
  assert.equal(v.state().size, 3);
  assert.equal(listenerCount(v.board, 'keydown'), 1);
});

test('rack-reset: resetting the rack wins: status, toast, best over par, a frozen rack, a reload keeps it, and Restart gives an unscored replay', (t) => {
  const { clock, v } = openPage(t);
  const presses = v.solve();
  assert.equal(presses, SEED1_PAR);
  assert.equal(v.toast(), 'Rack reset in 10 presses (par 10, on par): new best for RK-272 5x5!');
  assert.equal(v.text('status'), 'Rack reset: all 25 alarms cleared in 10 presses (par 10, on par). New Game deals the next rack.');
  assert.match(v.board.className, /\brkr-board--solved\b/);
  assert.equal(v.text('best'), 'par');
  assert.equal(v.text('cleared'), '1');
  assert.equal(v.text('lit'), '0/25');
  assert.ok(v.regs().every((reg) => reg.textContent === '0x00' && reg.classList.contains('rkr-reg--zero')));
  assert.equal(localStorage.getItem(BEST_KEY), SAMPLE_BEST, 'rkr-best in the format of the first published version');
  // The reset rack takes no press, undo or hint, and says why with its numbers.
  const frozen = localStorage.getItem(STATE_KEY);
  for (const act of [() => v.tap(3), () => v.click('undo'), () => v.click('hint-button'), () => v.press('h')]) {
    act();
    assert.equal(v.toast(), 'Rack RK-272 5x5 is already reset in 10 presses: Restart replays it, New Game deals the next one.');
  }
  assert.equal(localStorage.getItem(STATE_KEY), frozen);
  // A reload shows the result again.
  const again = reload(clock, v);
  assert.equal(again.text('status'), 'Rack reset: all 25 alarms cleared in 10 presses (par 10, on par). New Game deals the next rack.');
  assert.match(again.board.className, /\brkr-board--solved\b/);
  assert.equal(again.text('best'), 'par');
  // Restart: the same rack again, as a replay that is not scored.
  again.click('restart');
  assert.equal(again.toast(), 'Rack RK-272 5x5 restarted (par 10). Replay: not scored.');
  assert.deepEqual(again.grid(), gridOf(SEED1_START));
  assert.equal(again.state().replay, true);
  assert.match(again.text('status'), / Replay: not scored\.$/);
  again.solve(1);
  assert.equal(again.toast(), 'Rack reset in 12 presses (par 10, +2): not scored.');
  assert.equal(again.text('status'), 'Rack reset: all 25 alarms cleared in 12 presses (par 10, +2). Replay: not scored. New Game deals the next rack.');
  assert.deepEqual(again.best()['272-5'], { over: 0, wins: 1 });
  // A scored rack that does not beat the best counts as cleared.
  again.click('new-game');
  assert.equal(again.state().replay, false);
  const par = Number(again.text('par'));
  again.solve(2);
  assert.equal(again.toast(), 'Rack reset in ' + (par + 4) + ' presses (par ' + par + ', +4).');
  assert.deepEqual(again.best()['272-5'], { over: 0, wins: 2 });
  assert.equal(again.text('cleared'), '2');
});

test('rack-reset: best keeps the fewest presses over par for each model and size on its own', (t) => {
  const { v } = openPage(t);
  v.choose('525', 3);
  const par = Number(v.text('par'));
  v.solve(1);
  assert.equal(v.toast(), 'Rack reset in ' + (par + 2) + ' presses (par ' + par + ', +2): new best for RK-525 3x3!');
  assert.equal(v.text('best'), '+2');
  v.click('new-game');
  assert.equal(v.text('best'), '+2', 'the best stays with the model and size');
  v.choose(undefined, 4);
  assert.equal(v.text('best'), '--');
  assert.equal(v.text('cleared'), '0');
  v.choose(undefined, 3);
  v.solve();
  assert.equal(v.text('best'), 'par');
  assert.deepEqual(v.best()['525-3'], { over: 0, wins: 2 });
  assert.deepEqual(v.best()['525-4'], { over: null, wins: 0 });
});

test('rack-reset: Hint shows one LED of a fewest-press reset from where the rack is, takes the cursor, and the rack is no longer scored', (t) => {
  const { v } = openPage(t);
  v.click('hint-button');
  assert.equal(v.text('hint'), 'Hint: press C1. From here the rack resets in 10 presses.');
  assert.equal(v.has(2, 'rkr-led--hint'), true);
  assert.equal(v.cursor(), 'rkr-led-2');
  assert.equal(v.state().hinted, true);
  assert.match(v.text('status'), / Hint used: not scored\.$/);
  v.tap(0);
  assert.equal(v.text('hint'), '', 'a press clears the hint');
  assert.equal(v.leds().some((led) => led.classList.contains('rkr-led--hint')), false);
  v.click('hint-button');
  const left = rkr.rkrMinPresses(v.grid(), 5, 0x272);
  assert.equal(v.text('hint'), 'Hint: press ' + rkr.rkrCellName(left[0], 5) + '. From here the rack resets in ' + left.length + ' presses.');
  const model = linearModel(5, 0x272);
  assert.equal(left.length, minimumByNullSpace(model, v.grid(), left.reduce((acc, i) => acc | (1n << BigInt(i)), 0n)), 'the minimum from the rack as it is now');
  v.click('undo');
  assert.equal(v.text('hint'), '', 'undo clears it too');
  // Hints all the way down: one press left reads "1 press".
  for (let k = 0; k < 9; k++) {
    v.click('hint-button');
    v.tap(Number(v.cursor().slice(8)));
  }
  v.click('hint-button');
  assert.ok(v.text('hint').endsWith('the rack resets in 1 press.'), v.text('hint'));
  v.tap(Number(v.cursor().slice(8)));
  assert.equal(v.toast(), 'Rack reset in 10 presses (par 10, on par): not scored.');
  assert.equal(v.text('best'), '--');
  assert.equal(localStorage.getItem(BEST_KEY), null, 'an unscored reset writes no best');
  // New Game deals a scored rack again.
  v.click('new-game');
  assert.equal(v.state().hinted, false);
  assert.doesNotMatch(v.text('status'), /Hint used/);
});

test('rack-reset: Undo takes back presses one by one down to the first state, then says there is nothing to undo', (t) => {
  const { v } = openPage(t);
  const start = gridOf(SEED1_START);
  v.tap(0);
  v.tap(6);
  v.tap(18);
  v.click('undo');
  assert.deepEqual(v.grid(), applyAll(start, 5, 0x272, [0, 6]));
  assert.deepEqual(v.state().history, [0, 6]);
  assert.equal(v.text('moves'), '2');
  assert.equal(v.cursor(), 'rkr-led-18', 'the cursor shows the LED taken back');
  v.click('undo');
  v.click('undo');
  assert.deepEqual(v.grid(), start);
  assert.equal(v.state().moves, 0);
  v.click('undo');
  assert.equal(v.toast(), 'Nothing to undo: 0 presses on this rack.');
  assert.equal(v.state().moves, 0);
});

test('rack-reset: the undo history keeps the last 500 presses; older ones count but cannot be taken back, also after a reload', (t) => {
  const { clock, v: first } = openPage(t);
  for (let k = 0; k < 501; k++) first.tap(k % 2 ? 6 : 0);
  assert.equal(first.state().moves, 501);
  assert.equal(first.state().history.length, 500);
  assert.equal(first.state().history[0], 6, 'the oldest press was dropped');
  // A reload keeps the grid and the 500 presses Undo can take back.
  let v = reload(clock, first);
  assert.equal(v.text('moves'), '501');
  assert.deepEqual(v.leds().map((led) => (led.classList.contains('rkr-led--on') ? 1 : 0)), v.grid());
  v.click('undo');
  assert.equal(v.state().history.length, 499);
  assert.equal(v.state().moves, 500);
  // And again with fewer than 500 presses left in the history.
  v = reload(clock, v);
  assert.equal(v.state().history.length, 499);
  for (let k = 0; k < 499; k++) v.click('undo');
  assert.equal(v.state().moves, 1);
  assert.deepEqual(v.grid(), pressModel(gridOf(SEED1_START), 5, 0x272, 0));
  v.click('undo');
  assert.equal(v.toast(), 'Nothing more to undo: only the last 500 presses are kept (1 press on the rack).');
  // Restart still goes back to the first state.
  v.click('restart');
  assert.deepEqual(v.grid(), gridOf(SEED1_START));
  assert.equal(v.toast(), 'Rack RK-272 5x5 restarted (par 10).');
  v.click('restart');
  assert.equal(v.toast(), 'Rack RK-272 5x5 is already at its first state (0 presses).');
});

test('rack-reset: the model and size selects and New Game deal racks of every model and size, each with its own mask, par and solver line', (t) => {
  const { v } = openPage(t, { random: 9 });
  for (const [key, mask, name] of MODELS) {
    SIZES.forEach((n, s) => {
      v.choose(key, n);
      const state = v.state();
      assert.equal(state.model, key);
      assert.equal(state.size, n);
      const start = gridOf(state.start);
      assert.ok(lit(start) > 0);
      const model = linearModel(n, mask);
      const sol = rkr.rkrSolveGF2(start, n, mask);
      assert.equal(v.text('par'), String(minimumByNullSpace(model, start, gridBits(sol.x))), key + ' ' + n + 'x' + n);
      assert.equal(v.leds().length, n * n);
      assert.equal(v.regs().length, n);
      assert.equal(v.board.className, 'rkr-board rkr-board--n' + n);
      assert.equal(v.cursor(), 'rkr-led-' + (Math.floor(n / 2) * n + Math.floor(n / 2)));
      assert.equal(v.text('mode'), 'RK-' + key + ' ' + name + ' · ' + n + 'x' + n + ' · mask 0x' + key);
      assert.equal(v.text('mask-hex'), '0x' + key);
      const k = NULLITY[key][s];
      assert.equal(v.text('solver'), 'GF(2) solver: rank ' + (n * n - k) + ' of ' + n * n + ', null space dimension ' + k + ', ' + 2 ** k +
        (k === 0 ? ' candidate' : ' candidates') + ' for the minimum.');
      const on = stencil(mask).map(([dr, dc]) => (dr + 1) * 3 + dc + 1);
      assert.deepEqual(v.el('mask-grid').children.map((cell) => cell.classList.contains('rkr-mask-cell--on')), [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => on.includes(i)));
    });
  }
  // New Game takes the selects; an unknown value falls back to the default.
  v.el('model').value = 'zzz';
  v.el('size').value = '12';
  v.click('new-game');
  assert.equal(v.state().model, '272');
  assert.equal(v.state().size, 5);
  assert.equal(v.el('model').value, '272', 'the selects follow the rack on screen');
  assert.equal(v.el('size').value, '5');
});

test('rack-reset: a newer toast keeps its full 2 s', (t) => {
  const { clock, v } = openPage(t);
  v.click('restart');
  assert.notEqual(v.toast(), null);
  clock.advance(1500);
  v.click('undo');
  assert.equal(v.toast(), 'Nothing to undo: 0 presses on this rack.');
  clock.advance(1999);
  assert.notEqual(v.toast(), null);
  clock.advance(1);
  assert.equal(v.toast(), null);
});

test('rack-reset: a new rack, a new model or size and Restart take the toast about the rack before off at once', (t) => {
  const { clock, v } = openPage(t);
  v.solve();
  assert.match(v.toast(), /new best for RK-272 5x5!$/);
  clock.advance(500);
  v.choose('777', 3);
  assert.equal(v.toast(), null, 'the 5x5 toast is gone with its rack');
  assert.equal(v.el('toast').classList.contains('rkr-show'), false);
  // Its old timer is gone too: a toast shown now keeps its full 2 s.
  v.click('undo');
  clock.advance(1999);
  assert.equal(v.toast(), 'Nothing to undo: 0 presses on this rack.');
  clock.advance(1);
  assert.equal(v.toast(), null);
  // New Game and N after a reset.
  v.solve();
  assert.notEqual(v.toast(), null);
  v.click('new-game');
  assert.equal(v.toast(), null);
  v.solve();
  v.press('n');
  assert.equal(v.toast(), null);
  // Restart replaces the toast with its own, with the full time.
  v.solve();
  clock.advance(1500);
  v.click('restart');
  assert.equal(v.toast(), 'Rack RK-777 3x3 restarted (par ' + v.text('par') + '). Replay: not scored.');
  assert.equal(v.el('toast').classList.contains('rkr-toast--warn'), false, 'a result is green');
  clock.advance(1999);
  assert.notEqual(v.toast(), null);
  clock.advance(1);
  assert.equal(v.toast(), null);
});

test('rack-reset: with presses on the rack, a select or one New Game never throws it away; a second New Game or N within 4 s does', (t) => {
  const { clock, v } = openPage(t);
  const start = v.state().start;
  v.tap(0);
  v.tap(6);
  const kept = localStorage.getItem(STATE_KEY);
  // A select (or an arrow key on it, which fires change at once) only chooses the next rack.
  v.choose(undefined, 6);
  assert.equal(localStorage.getItem(STATE_KEY), kept);
  assert.equal(v.leds().length, 25);
  assert.equal(v.el('size').value, '6', 'the select keeps its choice');
  assert.equal(v.text('mode'), 'RK-272 cross · 5x5 · mask 0x272', 'the rack in play is still shown');
  assert.equal(v.toast(), 'Rack RK-272 5x5 has 2 presses on it: press New Game or N within 4 s to throw it away and deal a new RK-272 6x6 rack.');
  assert.equal(v.el('toast').classList.contains('rkr-toast--warn'), true);
  v.choose('777');
  v.choose(undefined, 4);
  v.choose(undefined, 3);
  assert.equal(localStorage.getItem(STATE_KEY), kept, 'arrow after arrow: still the same rack');
  assert.equal(v.toast(), 'Rack RK-272 5x5 has 2 presses on it: press New Game or N within 4 s to throw it away and deal a new RK-777 3x3 rack.');
  // The rack keeps playing and the selects keep their choice.
  v.tap(12);
  assert.equal(v.state().moves, 3);
  assert.equal(v.el('model').value, '777');
  assert.equal(v.el('size').value, '3');
  // The armed confirmation belonged to the rack before that press: New Game asks again.
  v.click('new-game');
  assert.equal(v.toast(), 'Rack RK-272 5x5 has 3 presses on it: press New Game or N within 4 s to throw it away and deal a new RK-777 3x3 rack.');
  assert.equal(v.state().model, '272');
  // The toast stays for the whole 4 s; after them the confirmation is gone.
  clock.advance(3999);
  assert.notEqual(v.toast(), null);
  clock.advance(1);
  assert.equal(v.toast(), null);
  v.click('new-game');
  assert.equal(v.state().model, '272', 'too late: it asks again');
  clock.advance(3000);
  v.click('new-game');
  assert.equal(v.state().model, '777');
  assert.equal(v.state().size, 3);
  assert.equal(v.state().moves, 0);
  assert.equal(v.toast(), null);
  // Choosing the rack in play again drops the choice without a word.
  v.tap(0);
  v.choose('525');
  assert.equal(v.el('model').value, '525');
  v.choose('777');
  assert.equal(v.el('model').value, '777');
  assert.equal(v.state().model, '777');
  assert.equal(v.toast(), null, 'the old prompt is gone');
  // A select armed the confirmation: one N then deals its choice.
  v.choose(undefined, 4);
  v.press('n');
  assert.equal(v.state().size, 4);
  assert.notDeepEqual(v.state().start, start);
  // A select with no presses on the rack deals at once, as does a reset rack.
  v.choose('070');
  assert.equal(v.state().model, '070');
  v.solve();
  v.choose(undefined, 5);
  assert.equal(v.state().size, 5);
});

test('rack-reset: after a click or a tap on Undo, Hint, Restart or New Game the keys go to the board, not to that button', (t) => {
  const { v } = openPage(t);
  for (const name of ['undo', 'hint-button', 'restart', 'new-game']) {
    focusElement(v.el(name));
    v.click(name);
    assert.equal(document.activeElement, v.board, name);
  }
  // Undo clicked, then Space: one press on the LED under the cursor, not a second undo.
  v.tap(0);
  v.tap(6);
  v.click('undo');
  assert.deepEqual(v.state().history, [0]);
  assert.equal(v.cursor(), 'rkr-led-6');
  pressKey(' ');
  assert.deepEqual(v.state().history, [0, 6]);
  // Enter or Space on a focused button (a click with detail 0) leaves the focus there.
  for (const name of ['undo', 'hint-button', 'restart', 'new-game']) {
    focusElement(v.el(name), { keyboard: true });
    fire(v.el(name), 'click', { detail: 0 });
    assert.equal(document.activeElement, v.el(name), name);
  }
});

test('rack-reset: small text and the toast keep at least 4.5:1 contrast', () => {
  const rules = cssRules(CSS);
  const root = declsAt(rules, '.rkr-wrapper', 1280);
  const color = (value) => {
    const m = /^var\((--rkr-[\w-]+)\)$/.exec(value);
    return m ? root[m[1]] : value;
  };
  const luminance = (hex) => {
    const c = hex.length === 4 ? hex.slice(1).split('').map((d) => d + d) : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
    const [r, g, b] = c.map((d) => {
      const s = parseInt(d, 16) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [luminance(color(a)), luminance(color(b))].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const toast = declsAt(rules, '.rkr-toast', 320);
  assert.ok(ratio(toast.color, toast.background) >= 4.5, 'the green toast: ' + ratio(toast.color, toast.background));
  const warn = declsAt(rules, '.rkr-toast--warn', 320);
  assert.ok(ratio(warn.color, warn.background) >= 4.5, 'the amber toast: ' + ratio(warn.color, warn.background));
  // Labels, the solver line and the footer on the card and the dark panel.
  for (const selector of ['.rkr-stat-label', '.rkr-solver', '.rkr-footer']) {
    const fg = declsAt(rules, selector, 320).color;
    assert.equal(fg, 'var(--rkr-text-secondary)', selector);
    for (const bg of ['--rkr-bg-card', '--rkr-bg-primary', '--rkr-bg-secondary']) assert.ok(ratio(fg, root[bg]) >= 4.5, selector + ' on ' + bg);
  }
  // A cleared register: full green on the panel, no opacity.
  const zero = declsAt(rules, '.rkr-reg--zero', 320);
  assert.equal(zero.opacity, undefined);
  assert.ok(ratio(zero.color, '#070a14') >= 4.5);
  assert.doesNotMatch(CSS, /color: var\(--rkr-text-muted\)/, 'the muted grey is too dark for text here');
});

test('rack-reset: every class the game puts on the page has a rule in style.css', (t) => {
  const seen = new Set();
  const collect = (v) => {
    for (const el of walk(v.page.root)) String(el.className || '').split(/\s+/).filter(Boolean).forEach((name) => seen.add(name));
  };
  const { v } = openPage(t);
  v.press('ArrowUp');
  v.click('hint-button');
  collect(v);
  v.solve();
  collect(v);
  v.click('undo');
  assert.ok(v.el('toast').classList.contains('rkr-toast--warn'), 'a refusal is amber');
  collect(v);
  for (const n of SIZES) {
    v.choose('632', n);
    collect(v);
  }
  blockStorage('full', t);
  v.click('new-game');
  collect(v);
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors).join(' ');
  for (const name of [...seen].sort()) {
    assert.match(name, /^rkr-/);
    assert.match(selectors, new RegExp('\\.' + name + '(?![\\w-])'), name);
  }
  for (const name of ['rkr-led--on', 'rkr-led--cursor', 'rkr-led--hint', 'rkr-board--keys', 'rkr-board--solved', 'rkr-reg--zero',
    'rkr-mask-cell--on', 'rkr-mask-cell--self', 'rkr-board--n3', 'rkr-board--n4', 'rkr-board--n5', 'rkr-board--n6', 'rkr-show',
    'rkr-btn--hint', 'rkr-warning', 'rkr-toast--warn']) {
    assert.ok(seen.has(name), name + ' was seen on the page');
  }
});

// ── Second tabs ──────────────────────────────────────────────────────────────

test('rack-reset: another tab\'s newer game is taken over through the storage event; older ones and other keys change nothing', (t) => {
  const { v } = openPage(t);
  v.tap(24);
  assert.equal(v.cursor(), 'rkr-led-24');
  // The other tab deals a 3x3 X-link rack with a newer revision.
  const theirs = saveOf('525', 3, rkr.rkrGenerate(3, 0x525, seeded(4)), { rev: 30 });
  localStorage.setItem(STATE_KEY, JSON.stringify(theirs));
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.leds().length, 9);
  assert.equal(v.text('mode'), 'RK-525 X-link · 3x3 · mask 0x525');
  assert.equal(v.el('model').value, '525');
  assert.equal(v.el('size').value, '3');
  assert.equal(v.cursor(), 'rkr-led-4', 'a cursor off the smaller rack goes to its middle');
  assert.equal(v.toast(), 'Another tab saved a newer game (RK-525 3x3, 0 presses): it is shown here.');
  assert.equal(localStorage.getItem(STATE_KEY), JSON.stringify(theirs), 'taking it over writes nothing');
  // Its next press here is played on that rack, one revision above it.
  v.tap(1);
  assert.equal(v.state().rev, 31);
  assert.deepEqual(v.grid(), pressModel(gridOf(theirs.start), 3, 0x525, 1));
  // An older or broken save, and events for other keys, change nothing.
  const mine = localStorage.getItem(STATE_KEY);
  localStorage.setItem(STATE_KEY, JSON.stringify(Object.assign({}, theirs, { rev: 5 })));
  fire(window, 'storage', { key: STATE_KEY });
  localStorage.setItem(STATE_KEY, '{');
  fire(window, 'storage', { key: STATE_KEY });
  fire(window, 'storage', { key: null });
  fire(window, 'storage', { key: 'ppn-state' });
  assert.equal(v.leds().length, 9);
  assert.deepEqual(gridOf(JSON.parse(mine).grid), v.leds().map((led) => (led.classList.contains('rkr-led--on') ? 1 : 0)));
  // A best another tab stored shows at once.
  localStorage.setItem(BEST_KEY, JSON.stringify({ '525-3': { over: 3, wins: 5 } }));
  fire(window, 'storage', { key: BEST_KEY });
  assert.equal(v.text('best'), '+3');
  assert.equal(v.text('cleared'), '5');
});

test('rack-reset: a press, Undo, Hint or Restart made on a rack another tab has moved on from takes that tab\'s game over instead', (t) => {
  const { v } = openPage(t);
  v.tap(0);
  const step = (record, index) => Object.assign({}, record, {
    rev: record.rev + 1, grid: rowsOf(pressModel(gridOf(record.grid), 5, 0x272, index), 5),
    history: record.history.concat(index), moves: record.moves + 1
  });
  // The other tab pressed C3; this tab's tap on E5 was made on the old rack.
  let theirs = step(v.state(), 12);
  localStorage.setItem(STATE_KEY, JSON.stringify(theirs));
  v.tap(24);
  assert.deepEqual(v.state(), theirs, 'the stale tap is not played');
  assert.equal(v.text('moves'), '2');
  assert.equal(v.cursor(), 'rkr-led-24', 'the cursor stays where it was on a rack of the same size');
  assert.equal(v.toast(), 'Another tab saved a newer game (RK-272 5x5, 2 presses): it is shown here.');
  v.tap(24);
  assert.equal(v.state().moves, 3);
  for (const act of [() => v.click('undo'), () => v.click('hint-button'), () => v.click('restart'), () => v.press(' ')]) {
    theirs = step(v.state(), 6);
    localStorage.setItem(STATE_KEY, JSON.stringify(theirs));
    act();
    assert.deepEqual(v.state(), theirs);
    assert.equal(v.text('hint'), '');
  }
  // New Game never deals over a newer game: it takes that game over first;
  // a select does the same.  Then New Game asks, and a second one deals, one
  // revision above the save on disk.
  const newer = Object.assign({}, theirs, { rev: 90 });
  localStorage.setItem(STATE_KEY, JSON.stringify(newer));
  v.click('new-game');
  assert.deepEqual(v.state(), newer);
  assert.equal(v.toast(), 'Another tab saved a newer game (RK-272 5x5, ' + newer.moves + ' presses): it is shown here.');
  const newest = Object.assign({}, newer, { rev: 95 });
  localStorage.setItem(STATE_KEY, JSON.stringify(newest));
  v.choose('777');
  assert.deepEqual(v.state(), newest);
  assert.equal(v.el('model').value, '272', 'the select shows the game taken over');
  v.click('new-game');
  assert.match(v.toast(), /^Rack RK-272 5x5 has \d+ presses on it: press New Game or N within 4 s/);
  v.click('new-game');
  assert.equal(v.state().rev, 96);
  assert.equal(v.state().moves, 0);
});

test('rack-reset: a tab shown again, or a page restored from the back/forward cache, reads both saves again', (t) => {
  const { v } = openPage(t);
  const theirs = Object.assign({}, v.state(), { rev: 9, grid: rowsOf(pressModel(gridOf(SEED1_START), 5, 0x272, 3), 5), history: [3], moves: 1 });
  setVisibility('hidden', t);
  localStorage.setItem(STATE_KEY, JSON.stringify(theirs));
  localStorage.setItem(BEST_KEY, JSON.stringify({ '272-5': { over: 1, wins: 2 } }));
  setVisibility('hidden', t);
  assert.equal(v.text('moves'), '0', 'a hidden tab reads nothing');
  setVisibility('visible', t);
  assert.equal(v.text('moves'), '1');
  assert.equal(v.text('best'), '+1');
  assert.equal(v.toast(), 'Another tab saved a newer game (RK-272 5x5, 1 press): it is shown here.');
  // pageshow with nothing newer only shows the merged best.
  localStorage.setItem(BEST_KEY, JSON.stringify({ '272-5': { over: 0, wins: 1 } }));
  fire(window, 'pageshow', { persisted: true });
  assert.equal(v.text('best'), 'par');
  assert.equal(v.text('cleared'), '2', 'the higher count of the two tabs');
  assert.equal(v.text('moves'), '1');
});

test('rack-reset: a reset merges the best another tab stored, so neither tab erases the other\'s', (t) => {
  const { v } = openPage(t);
  localStorage.setItem(BEST_KEY, JSON.stringify({ '272-5': { over: 4, wins: 3 }, '777-6': { over: 2, wins: 1 } }));
  v.solve();
  assert.deepEqual(v.best()['272-5'], { over: 0, wins: 4 });
  assert.deepEqual(v.best()['777-6'], { over: 2, wins: 1 });
  v.click('new-game');
  localStorage.setItem(BEST_KEY, JSON.stringify({ '272-5': { over: 0, wins: 9 } }));
  v.solve(1);
  assert.match(v.toast(), /\(par \d+, \+2\)\.$/, 'not a new best');
  assert.deepEqual(v.best()['272-5'], { over: 0, wins: 10 });
  assert.deepEqual(v.best()['777-6'], { over: 2, wins: 1 }, 'what this tab knew is kept as well');
});

// ── Saves on the page ────────────────────────────────────────────────────────

test('rack-reset: a save in the current format loads as it was and is written back in the same format', (t) => {
  const { v } = openPage(t, { storage: { state: SAMPLE_SAVE } });
  const raw = JSON.parse(SAMPLE_SAVE);
  assert.equal(v.text('moves'), '2');
  assert.equal(v.text('par'), '10');
  assert.deepEqual(v.leds().map((led) => (led.classList.contains('rkr-led--on') ? 1 : 0)), gridOf(raw.grid));
  assert.deepEqual(v.regs().map((reg) => reg.textContent), ['0x16', '0x1C', '0x0C', '0x08', '0x13']);
  assert.equal(v.cursor(), 'rkr-led-12');
  // Nothing changed yet: the save on disk is the same text.
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE);
  v.click('undo');
  const written = v.state();
  assert.deepEqual(Object.keys(written), Object.keys(raw));
  assert.equal(localStorage.getItem(STATE_KEY), JSON.stringify(Object.assign({}, raw, {
    rev: 8, grid: rowsOf(pressModel(gridOf(SEED1_START), 5, 0x272, 12), 5), moves: 1, history: [12]
  })));
});

test('rack-reset: a rack in progress survives a reload: model, size, LEDs, presses, history, hint flag and best', (t) => {
  const { clock, v } = openPage(t, { random: 7 });
  v.choose('575', 4);
  v.tap(3);
  v.tap(10);
  v.click('hint-button');
  const snapshot = v.state();
  const drawn = v.leds().map((led) => led.className.replace(/ rkr-led--(cursor|hint)/g, ''));
  const again = reload(clock, v);
  assert.deepEqual(again.state(), snapshot);
  assert.equal(again.el('model').value, '575');
  assert.equal(again.el('size').value, '4');
  assert.deepEqual(again.leds().map((led) => led.className.replace(/ rkr-led--cursor/g, '')), drawn);
  assert.equal(again.text('moves'), '2');
  assert.equal(again.text('hint'), '', 'the hint mark itself is not saved');
  assert.match(again.text('status'), / Hint used: not scored\.$/);
  again.click('undo');
  assert.deepEqual(again.state().history, [3]);
});

test('rack-reset: a corrupt or unplayable save never breaks the page: a fresh, playable rack instead', (t) => {
  const base = JSON.parse(SAMPLE_SAVE);
  const saves = {
    'not JSON': '{"v":1,',
    array: '[]',
    'unknown model': JSON.stringify(Object.assign({}, base, { model: 'abc' })),
    'size 9': JSON.stringify(Object.assign({}, base, { size: 9 })),
    'start of another size': JSON.stringify(Object.assign({}, base, { model: '070', size: 3 })),
    'start all off': JSON.stringify(Object.assign({}, base, { model: '632', size: 4, start: ['0000', '0000', '0000', '0000'] })),
    'start no presses reset': JSON.stringify(saveOf('525', 4, gridOf(['1000', '0000', '0000', '0000'])))
  };
  for (const [name, text] of Object.entries(saves)) {
    resetStubs();
    const { v } = openPage(t, { storage: { state: text, best: '{' } });
    const parsed = rkr.rkrParseState(text);
    const n = parsed.size;
    assert.equal(v.leds().length, n * n, name);
    assert.equal(v.state().model, parsed.model, name);
    assert.equal(v.text('moves'), '0', name);
    assert.equal(v.text('best'), '--', name);
    assert.ok(lit(v.grid()) > 0, name);
    assert.notEqual(rkr.rkrMinPresses(v.grid(), n, maskOf(parsed.model)), null, name + ': a rack the solver resets');
    v.tap(0);
    assert.equal(v.state().moves, 1, name);
  }
});

test('rack-reset: blocked storage never stops the game, and the warning names the keys and the error', (t) => {
  blockStorage('access', t);
  const { v } = openPage(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Storage is blocked (SecurityError): rkr-best, rkr-state not saved. The rack still plays, but a reload deals ' +
    'a new rack and shows no bests. Allow site data for this site in the browser settings to keep them.');
  assert.equal(v.leds().length, 25);
  v.tap(0);
  v.click('hint-button');
  v.click('undo');
  assert.equal(v.text('moves'), '0');
  v.choose('070', 6);
  assert.equal(v.leds().length, 36);
  v.solve();
  assert.match(v.text('status'), /^Rack reset: all 36 alarms cleared/);
  setVisibility('visible', t);
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.leds().length, 36);
});

test('rack-reset: full storage still reads the saves; the game plays on and names each key it could not write once', (t) => {
  writeStorage({ state: SAMPLE_SAVE });
  blockStorage('full', t);
  const { clock, v } = openPage(t);
  assert.equal(v.text('moves'), '2', 'the save is still read');
  assert.equal(v.hidden('warning'), true, 'nothing failed yet');
  v.tap(1);
  assert.equal(v.text('warning'), 'Storage is full (QuotaExceededError): rkr-state not saved. The rack still plays, but a reload goes ' +
    'back to what was saved last. Free some storage for this site (its site data in the browser settings) to save again.');
  v.el('warning').textContent = 'seen';
  v.tap(1);
  assert.equal(v.text('warning'), 'seen', 'warned once for rkr-state');
  assert.equal(v.text('moves'), '4');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE);
  // A save that failed never makes the old one on disk look newer.
  v.tap(2);
  assert.equal(v.text('moves'), '5');
  v.solve();
  assert.equal(v.text('warning'), 'Storage is full (QuotaExceededError): rkr-state, rkr-best not saved. The rack still plays, but a reload goes ' +
    'back to what was saved last. Free some storage for this site (its site data in the browser settings) to save again.');
  assert.match(v.text('status'), /^Rack reset: all 25 alarms cleared/);
  assert.equal(v.text('best'), '+' + (Number(v.text('moves')) - SEED1_PAR), 'the best is kept on the page');
  assert.equal(localStorage.getItem(BEST_KEY), null);
  // What the warning promises: a reload goes back to the 2-press rack on disk.
  const again = reload(clock, v);
  assert.equal(again.text('moves'), '2');
  assert.equal(again.text('best'), '--');
});
