// tests/bitmap-decoder.test.js
// Bitmap Decoder (bitmap-decoder/, prefix bmd-): a nonogram whose clues are
// run-length encoding, with a daily icon from a built-in library and Endless
// boards made from noise.
//
// The pure logic is checked against independent reasoning: run lengths and
// the line solver against brute force over every placement, every library
// icon solved by line logic alone, the daily rule (day number, FNV-1a,
// mulberry32, the icon cycle) against a reference written here.  The page is
// booted like a browser from the real index.html (bootLikeBrowser) with
// setInterval, setTimeout and Date mocked (performance.now follows Date), and
// driven through its own listeners: pointer events on the grid (the grid's
// rect is 30 px per cell), keys on the focused grid, clicks.  Then saves,
// reloads, corrupt and blocked storage, the clock, the share line, and the
// source checks (ids, prefix, ES5, embed safety, phone layout).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, focusElement, setVisibility, listenerCount, seeded,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt
} = require('./_setup');

const GAME = 'bitmap-decoder';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);
const BMD = loadScript(SCRIPT);
const ICONS = BMD.bmdIcons;

const STATE_KEY = 'bmd-state';
const BEST_KEY = 'bmd-best';
const DAILY_KEY = 'bmd-daily';
const CELL_PX = 30;
const APIS = ['setInterval', 'setTimeout', 'Date'];
// 2026-11-05 10:00 local time: Daily #5.
const DAY5 = new Date(2026, 10, 5, 10, 0, 0).getTime();
const HOUR = 3600000;

test.beforeEach(() => resetStubs());

// ── Independent references ──────────────────────────────────────────────────

const EPOCH = Date.UTC(2026, 10, 1);

// Run lengths of 1s.
function refClues(line) {
  return line.map((v) => (v === 1 ? '1' : '0')).join('').split(/0+/).filter(Boolean).map((run) => run.length);
}

// Every line of length n whose runs are clue.
function placements(clue, n) {
  const out = [];
  for (let bits = 0; bits < 1 << n; bits++) {
    const line = [];
    for (let i = n - 1; i >= 0; i--) line.push((bits >> i) & 1);
    if (refClues(line).join(',') === clue.join(',')) out.push(line);
  }
  return out;
}

// What brute force deduces: the cells equal in every placement consistent
// with the known cells (-1 unknown), or null when none is.
function refSolveLine(clue, known) {
  const fits = placements(clue, known.length).filter((line) => line.every((v, i) => known[i] === -1 || known[i] === v));
  if (!fits.length) return null;
  return known.map((v, i) => (fits.every((line) => line[i] === fits[0][i]) ? fits[0][i] : v));
}

function decodeHex(hex) {
  const rows = hex.split(' ');
  return rows.map((h) => parseInt(h, 16).toString(2).padStart(rows.length, '0').split('').map(Number));
}

function columns(grid) {
  return grid[0].map((_, c) => grid.map((row) => row[c]));
}

function fnv(text) {
  let hash = 0x811c9dc5;
  for (const ch of text) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function keyOfDay(n) {
  return new Date(EPOCH + (n - 1) * 86400000).toISOString().slice(0, 10);
}

// The daily rule written out again: cycles of count days; each day draws,
// with mulberry32(FNV-1a('bmd:' + day key)), one icon its cycle has not shown,
// never the previous day's.
function refDailyIcons(days, count) {
  const picks = [];
  let pool = [];
  let prev = -1;
  for (let d = 1; d <= days; d++) {
    if (!pool.length) pool = Array.from({ length: count }, (_, i) => i);
    const choices = pool.length > 1 ? pool.filter((i) => i !== prev) : pool;
    const pick = choices[Math.floor(seeded(fnv('bmd:' + keyOfDay(d)))() * choices.length)];
    pool.splice(pool.indexOf(pick), 1);
    picks.push(pick);
    prev = pick;
  }
  return picks;
}

const DAILY_PICKS = refDailyIcons(400, ICONS.length);
const dailyIcon = (day) => ICONS[DAILY_PICKS[day - 1]];
const dailySolution = (day) => decodeHex(dailyIcon(day).hex);

// The [row, col] cells of a 0 / 1 grid that hold value, in reading order.
const cellsOf = (grid, value = 1) => grid.flatMap((row, r) => row.flatMap((v, c) => (v === value ? [[r, c]] : [])));
const rowsText = (grid, value = 1) => grid.map((row) => row.map((v) => (v === value ? '1' : '0')).join(''));
const zeros = (n) => Array.from({ length: n }, () => '0'.repeat(n));
// bmd-best with no best time for any size.
const NO_BEST = { 5: null, 10: null, 15: null, 20: null, 25: null, 30: null };

// ── Pages ───────────────────────────────────────────────────────────────────

function enableClock(t, now) {
  try {
    t.mock.timers.enable({ apis: APIS, now });
  } catch (error) {
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: APIS, now });
  }
  if (!t.bmdPerformance) {
    t.mock.method(globalThis.performance, 'now', () => Date.now() - DAY5 + 50000);
    t.bmdPerformance = true;
  }
}

function writeStorage(storage) {
  for (const [key, value] of Object.entries(storage || {})) {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

function compactScreen(t) {
  t.mock.method(window, 'matchMedia', (query) => ({ matches: query === '(max-width: 600px)', media: query }));
}

// A screen width px wide: every (max-width: N px) query with N >= width matches.
function screenOf(t, width) {
  t.mock.method(window, 'matchMedia', (query) => {
    const m = /^\(max-width: (\d+)px\)$/.exec(query);
    return { matches: Boolean(m) && width <= Number(m[1]), media: query };
  });
}

const read = (key) => JSON.parse(localStorage.getItem(key));

// What a player sees and does.
function pageView(b) {
  const els = b.els;
  const grid = els['bmd-grid'];
  grid.getBoundingClientRect = () => {
    const n = grid.children.length * CELL_PX;
    return { x: 0, y: 0, left: 0, top: 0, right: n, bottom: n, width: n, height: n };
  };
  const view = {
    els,
    grid,
    restore: b.restore,
    ready: b.ready,
    page: b.page,
    text: (id) => els[id].textContent,
    size: () => grid.children.length,
    cell: (r, c) => grid.children[r].children[c],
    stateAt: (r, c) => {
      const cls = view.cell(r, c).className;
      return cls.includes('bmd-cell--fill') ? '#' : cls.includes('bmd-cell--mark') ? 'x' : '.';
    },
    picture: () => grid.children.map((row, r) => row.children.map((_, c) => view.stateAt(r, c)).join('')),
    point: (type, r, c, props) => fire(grid, type, {
      pointerId: 1, pointerType: 'mouse', button: type === 'pointerdown' ? 0 : -1,
      clientX: c * CELL_PX + CELL_PX / 2, clientY: r * CELL_PX + CELL_PX / 2, ...props
    }),
    tap: (r, c, props) => {
      const down = view.point('pointerdown', r, c, props);
      view.point('pointerup', r, c, props);
      return down;
    },
    drag: (path, props) => {
      view.point('pointerdown', path[0][0], path[0][1], props);
      for (const [r, c] of path.slice(1)) view.point('pointermove', r, c, props);
      view.point('pointerup', path[path.length - 1][0], path[path.length - 1][1], props);
    },
    key: (key, props) => pressKey(key, { target: grid, ...props }),
    toast: () => els['bmd-toast'].textContent,
    toastVisible: () => els['bmd-toast'].classList.contains('bmd-toast--show'),
    clueRow: (r) => els['bmd-row-clues'].children[r],
    clueCol: (c) => els['bmd-col-clues'].children[c],
    // Taps every filled cell of solution but the last `except` ones.
    solve: (solution, except = 0) => {
      const cells = cellsOf(solution);
      cells.slice(0, cells.length - except).forEach(([r, c]) => view.tap(r, c));
    },
    tapLast: (solution) => view.tap(...cellsOf(solution).pop()),
    endlessSolution: () => read(STATE_KEY).endless.solution.map((row) => row.split('').map(Number))
  };
  return view;
}

// The page as a browser loads it, after writing storage, at a mocked time.
function openPage(t, options = {}) {
  enableClock(t, options.now === undefined ? DAY5 : options.now);
  if (options.compact) compactScreen(t);
  if (options.width) screenOf(t, options.width);
  writeStorage(options.storage);
  return pageView(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), { readyState: options.readyState }));
}

// A reload: the old page and its timers go away, storage and the time stay.
function reload(t, view, now) {
  view.restore();
  return openPage(t, { now: now === undefined ? Date.now() : now });
}

// A 2x2-free 5x5 solution used for Endless saves.
const PLUS = ['00100', '01110', '11111', '01110', '00100'];

function endlessSave(fields = {}) {
  return {
    v: 1, mode: 'endless', size: 10, rules: 'easy', tool: 'fill',
    endless: {
      id: 'e5-test', name: 'Bitmap TEST', size: 5, rules: 'easy', solution: PLUS,
      fills: zeros(5), marks: zeros(5), mistakes: 0, elapsed: 0, status: 'playing', practice: false, ...fields
    }
  };
}

function dailySave(fields = {}) {
  return {
    v: 1, day: 5, icon: dailyIcon(5).id, rules: 'easy', fills: zeros(10), marks: zeros(10),
    mistakes: 0, elapsed: 0, status: 'playing', streak: 0, lastWon: null, maxStreak: 0, ...fields
  };
}

// A CSS length in px (rem and em count 16 px).
const px = (value) => {
  const m = /^(\d+(?:\.\d+)?)(px|rem|em)$/.exec(String(value).trim());
  assert.ok(m, 'a length: ' + value);
  return Number(m[1]) * (m[2] === 'px' ? 1 : 16);
};

// ── Files ───────────────────────────────────────────────────────────────────

test('bitmap: every id the script looks up exists once in index.html; ids, classes, variables, keys and exports are bmd- prefixed', () => {
  const ids = Array.from(JS.matchAll(/: '(bmd-[\w-]+)'/g), (m) => m[1]).filter((id) => !/^bmd-(state|best|daily)$/.test(id));
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  assert.ok(ids.length >= 28);
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^bmd-/);
  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^bmd-/);
  for (const m of JS.matchAll(/className = '([^']*)'/g)) for (const name of m[1].split(/\s+/).filter(Boolean)) assert.match(name, /^bmd-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/);
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^bmd-/, selector);
    }
  }
  // Custom properties: a '--' that is not inside a class name such as bmd-cell--fill.
  const customProps = (text) => Array.from(text.matchAll(/(?<![\w-])--([\w-]+)/g), (m) => m[1]);
  assert.ok(customProps(CSS).length > 20);
  for (const name of customProps(CSS)) assert.match(name, /^bmd-/);
  for (const name of customProps(JS)) assert.match(name, /^bmd-/);
  for (const m of CSS.matchAll(/@keyframes\s+([\w-]+)/g)) assert.match(m[1], /^bmd-/);
  assert.deepEqual([...JS.matchAll(/_KEY = '([^']+)'/g)].map((m) => m[1]).sort(), [BEST_KEY, DAILY_KEY, STATE_KEY]);
  for (const name of Object.keys(BMD)) assert.match(name, /^bmd[A-Z]/);
  // The grid is the only element that takes keys (tabindex), and the only one without touch scrolling.
  assert.deepEqual([...HTML.matchAll(/tabindex="0"[^>]*/g)].length, 1);
  assert.match(HTML, /id="bmd-grid"[^>]*tabindex="0"/);
});

test('bitmap: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="bmd-wrapper"'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.doesNotMatch(embedded, /<style/i);
  const bg = CSS.match(/--bmd-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes('<title>Bitmap Decoder — Logs from VahaC</title>'));
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.match(HTML, /<script src="script.js"><\/script>\s*<\/body>/);
  // No network: no URL in the script, no external resource in the page.
  assert.doesNotMatch(JS, /https?:|fetch\(|XMLHttpRequest|WebSocket|import\(/);
  assert.doesNotMatch(HTML.replace(/<a [^>]*>/g, ''), /(src|href)="(https?:)?\/\//);
});

test('bitmap: script.js is one strict IIFE in ES5 with the start-up guard', () => {
  assert.match(JS, /^(\/\/[^\n]*\n)*\n?\(function \(\) \{\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/\(function \(\) \{/g).length, 1);
  assert.match(JS, /if \(typeof module !== 'undefined' && module\.exports\) \{[\s\S]*\} else if \(document\.readyState === 'loading'\) \{\n\s+document\.addEventListener\('DOMContentLoaded', bmdInit\);\n\s+\} else \{\n\s+bmdInit\(\);/);
  const code = JS.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['double-quoted string', /"/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
  // No AI or remote service of any kind: the opponent-free game is all local code.
  assert.doesNotMatch(JS, /\b(openai|anthropic|llm|gpt|api[_-]?key)\b/i);
});

test('bitmap: from 320 px up a 10x10 and a 5x5 board fit beside their widest clues, and 15x15 scrolls inside its panel', () => {
  const rules = cssRules(CSS);
  for (let vw = 320; vw <= 1280; vw += vw < 420 ? 1 : 20) {
    const wrapper = declsAt(rules, '.bmd-wrapper', vw);
    const panel = declsAt(rules, '.bmd-panel', vw);
    const pad = px(wrapper.padding.split(/\s+/)[1]);
    const available = Math.min(vw, 860) - 2 * pad - 2 * px(panel.padding) - 2;
    assert.equal(panel['overflow-x'], 'auto');
    assert.equal(panel['max-width'], '100%');
    const num = px(wrapper['--bmd-num']);
    const gap = px(wrapper['--bmd-num-gap']);
    const cluePad = px(wrapper['--bmd-clue-pad']);
    // The widest row clue: ceil(size / 2) single digits ("1 1 1 1 1" on 10 cells).
    for (const size of [5, 10]) {
      const runs = Math.ceil(size / 2);
      const width = runs * num + (runs - 1) * gap + cluePad + size * px(wrapper['--bmd-cell-' + size]) + 4;
      assert.ok(width <= available, vw + 'px: a ' + size + 'x' + size + ' board of ' + width + 'px in ' + available + 'px');
    }
    assert.ok(px(wrapper['--bmd-cell-10']) >= 21, vw + 'px');
  }
  // Cells and clue boxes share one size variable per board size.
  for (const size of [5, 10, 15]) assert.equal(declsAt(rules, '.bmd-board--s' + size, 375)['--bmd-cell'], 'var(--bmd-cell-' + size + ')');
  assert.equal(declsAt(rules, '.bmd-cell', 375).width, 'var(--bmd-cell)');
  assert.equal(declsAt(rules, '.bmd-clue--col', 375).width, 'var(--bmd-cell)');
  assert.equal(declsAt(rules, '.bmd-clue--row', 375).height, 'var(--bmd-cell)');
  assert.equal(declsAt(rules, '.bmd-wrapper *', 375)['box-sizing'], 'border-box');
  // Only the grid stops touch scrolling; hidden panels stay hidden.
  const noTouch = rules.filter((rule) => rule.decls['touch-action'] === 'none').flatMap((rule) => rule.selectors);
  assert.deepEqual(noTouch, ['.bmd-grid']);
  for (const selector of ['.bmd-decode[hidden]', '.bmd-warning[hidden]', '.bmd-share-field[hidden]']) {
    assert.equal(declsAt(rules, selector, 375).display, 'none', selector);
  }
  assert.equal(declsAt(rules, '.bmd-stats', 320)['grid-template-columns'], 'repeat(2, minmax(0, 1fr))');
  assert.equal(declsAt(rules, '.bmd-toast', 320)['max-width'], 'calc(100vw - 2rem)');
});

test('bitmap: from the narrowest screen that offers it up to 1280 px, a 20x20, 25x25 or 30x30 board fits beside its widest clue', () => {
  const rules = cssRules(CSS);
  // The narrowest screen of each big size: one px past the query that turns it off.
  const minScreen = {};
  for (const limit of BMD.bmdScreenLimits) minScreen[limit.size] = Number(/^\(max-width: (\d+)px\)$/.exec(limit.query)[1]) + 1;
  assert.deepEqual(minScreen, { 15: 601, 20: 768, 25: 1024, 30: 1280 });
  for (const size of [20, 25, 30]) {
    // The widest row clue of 120 generated boards (and of the library icons it falls back to).
    let widest = [];
    for (let seed = 1; seed <= 120; seed++) {
      const grid = BMD.bmdGenerate(size, seeded(seed * 7 + size), 200).solution;
      for (const line of grid.concat(columns(grid))) if (refClues(line).length > widest.length) widest = refClues(line);
    }
    assert.ok(widest.length >= 6 && widest.length <= size / 2, size + ': ' + widest.join(' '));
    for (let vw = minScreen[size]; vw <= 1280; vw += 16) {
      const wrapper = declsAt(rules, '.bmd-wrapper', vw);
      const wide = declsAt(rules, '.bmd-wrapper:has(.bmd-board--s' + size + ')', vw)['max-width'];
      const panel = declsAt(rules, '.bmd-panel', vw);
      const pad = px(wrapper.padding.split(/\s+/)[1]);
      const available = Math.min(vw, px(wide || wrapper['max-width'])) - 2 * pad - 2 * px(panel.padding) - 2;
      const font = px(wrapper['--bmd-num-font']);
      const num = px(wrapper['--bmd-num']);
      // A mono digit is at most 0.62 em wide: a two-digit run may be wider than the box.
      const numbers = widest.reduce((sum, run) => sum + Math.max(num, String(run).length * 0.62 * font), 0);
      const clue = numbers + (widest.length - 1) * px(wrapper['--bmd-num-gap']) + px(wrapper['--bmd-clue-pad']);
      // A slack of 3 more numbers for a board wider than any of the 120.
      const width = clue + 3 * (num + px(wrapper['--bmd-num-gap'])) + size * px(wrapper['--bmd-cell-' + size]) + 4;
      assert.ok(width <= available, vw + 'px: a ' + size + 'x' + size + ' board of ' + Math.round(width) + 'px in ' + available + 'px');
    }
    assert.equal(declsAt(rules, '.bmd-board--s' + size, 1280)['--bmd-cell'], 'var(--bmd-cell-' + size + ')');
    // A column clue box holds two digits.
    assert.ok(px(declsAt(rules, '.bmd-wrapper', 1280)['--bmd-cell-' + size]) >= 24);
  }
  // Only 25x25 and 30x30 widen the page, to 1280 px; the narrower boards keep the 860 px column.
  assert.equal(declsAt(rules, '.bmd-wrapper', 1280)['max-width'], '860px');
  for (const size of [5, 10, 15, 20]) assert.equal(declsAt(rules, '.bmd-wrapper:has(.bmd-board--s' + size + ')', 1280)['max-width'], undefined);
  for (const size of [25, 30]) assert.equal(declsAt(rules, '.bmd-wrapper:has(.bmd-board--s' + size + ')', 1280)['max-width'], '1280px');
});

// ── Clues and the line solver ───────────────────────────────────────────────

test('bitmap: bmdCluesOf is the run-length encoding of every 10-cell line; marks and empties both end a run', () => {
  for (let bits = 0; bits < 1024; bits++) {
    const line = Array.from({ length: 10 }, (_, i) => (bits >> (9 - i)) & 1);
    assert.deepEqual(BMD.bmdCluesOf(line), refClues(line), line.join(''));
  }
  assert.deepEqual(BMD.bmdCluesOf([0, 0, 0]), []);
  assert.deepEqual(BMD.bmdCluesOf([1, 2, 1, 1, 0, 1]), [1, 2, 1]);
});

test('bitmap: bmdSolveLine deduces exactly what brute force over every placement deduces', () => {
  const n = 6;
  let checked = 0;
  const seen = new Set();
  for (let bits = 0; bits < 1 << n; bits++) {
    const solution = Array.from({ length: n }, (_, i) => (bits >> (n - 1 - i)) & 1);
    const clue = refClues(solution);
    if (seen.has(clue.join(','))) continue;
    seen.add(clue.join(','));
    for (let k = 0; k < 729; k++) {
      const known = [];
      for (let i = 0, x = k; i < n; i++, x = Math.floor(x / 3)) known.push((x % 3) - 1);
      assert.deepEqual(BMD.bmdSolveLine(clue, known), refSolveLine(clue, known), clue + ' / ' + known);
      checked++;
    }
  }
  assert.ok(checked > 10000);
  assert.deepEqual(BMD.bmdSolveLine([3], [-1, -1, -1, -1, -1]), [-1, -1, 1, -1, -1]);
  assert.deepEqual(BMD.bmdSolveLine([], [-1, -1, -1]), [0, 0, 0]);
  assert.equal(BMD.bmdSolveLine([4], [-1, -1, -1]), null);
  assert.equal(BMD.bmdSolveLine([1], [1, 0, 1]), null);
});

test('bitmap: bmdSolveGrid solves a unique puzzle, stops on an ambiguous one and refuses contradicting clues', () => {
  const plus = PLUS.map((row) => row.split('').map(Number));
  const solved = BMD.bmdSolveGrid(plus.map(refClues), columns(plus).map(refClues));
  assert.deepEqual(solved, { grid: plus, solved: true });
  // Two diagonals share their clues: line logic cannot choose.
  assert.deepEqual(BMD.bmdSolveGrid([[1], [1]], [[1], [1]]), { grid: [[-1, -1], [-1, -1]], solved: false });
  assert.equal(BMD.bmdSolveGrid([[2], [2]], [[1], [1]]), null);
  assert.equal(BMD.bmdSolveGrid([[3]], [[1], [1]]), null, 'a row longer than the grid');
  // bmdIsSolved compares runs, so any grid with the clues wins, marks counting as empty.
  const rows = [[1], [1]];
  assert.equal(BMD.bmdIsSolved([[1, 0], [0, 1]], rows, rows), true);
  assert.equal(BMD.bmdIsSolved([[0, 1], [1, 0]], rows, rows), true);
  assert.equal(BMD.bmdIsSolved([[1, 2], [2, 1]], rows, rows), true);
  assert.equal(BMD.bmdIsSolved([[1, 1], [0, 0]], [[2], []], rows), true);
  assert.equal(BMD.bmdIsSolved([[1, 1], [0, 0]], [[2], []], [[2], []]), false);
  assert.equal(BMD.bmdIsSolved([[1, 0], [0, 0]], rows, rows), false);
});

// ── The icon library ────────────────────────────────────────────────────────

test('bitmap: the library holds at least 30 distinct 10x10 icons, each solved by line logic alone (so with one solution)', () => {
  assert.ok(ICONS.length >= 30, ICONS.length + ' icons');
  const pictures = new Set();
  const names = new Set();
  for (const icon of ICONS) {
    assert.match(icon.hex, /^([0-3][0-9a-f]{2} ){9}[0-3][0-9a-f]{2}$/, icon.id);
    assert.equal(icon.id, icon.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    const grid = BMD.bmdDecodeIcon(icon.hex);
    assert.deepEqual(grid, decodeHex(icon.hex), icon.id);
    assert.deepEqual(grid.map(BMD.bmdRowHex).join(' '), icon.hex.toUpperCase());
    const filled = grid.flat().filter(Boolean).length;
    assert.ok(filled >= 20 && filled <= 80, icon.id + ' has ' + filled + ' filled cells');
    const result = BMD.bmdSolveGrid(grid.map(refClues), columns(grid).map(refClues));
    assert.deepEqual(result, { grid, solved: true }, icon.id + ' is line-solvable');
    pictures.add(icon.hex);
    names.add(icon.name);
  }
  assert.equal(pictures.size, ICONS.length);
  assert.equal(names.size, ICONS.length);
  // The 5x5 fallback picture of Endless is line-solvable too.
  const mini = BMD.bmdDecodeIcon(BMD.bmdMiniIcon.hex);
  assert.equal(mini.length, 5);
  assert.equal(BMD.bmdSolveGrid(mini.map(refClues), columns(mini).map(refClues)).solved, true);
});

test('bitmap: bmdDecodeIcon refuses malformed hex; bmdFitIcon centres an icon on a larger board', () => {
  assert.equal(BMD.bmdDecodeIcon('0a 1f 1f 0e 04').length, 5);
  assert.equal(BMD.bmdDecodeIcon('0a 1f 1f 0e 4'), null, 'a short row');
  assert.equal(BMD.bmdDecodeIcon('0a 1f 1g 0e 04'), null, 'not hex');
  assert.equal(BMD.bmdDecodeIcon('0a 1f 20 0e 04'), null, 'more bits than the size');
  assert.equal(BMD.bmdDecodeIcon(' 0A  1F 1F 0E 04 ').length, 5, 'spaces and capitals');
  const fitted = BMD.bmdFitIcon(ICONS[0], 15);
  assert.equal(fitted.length, 15);
  const art = decodeHex(ICONS[0].hex);
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const inside = r >= 2 && r < 12 && c >= 2 && c < 12;
      assert.equal(fitted[r][c], inside ? art[r - 2][c - 2] : 0, r + ',' + c);
    }
  }
  assert.deepEqual(BMD.bmdFitIcon(ICONS[3], 10), decodeHex(ICONS[3].hex));
});

// ── Generation ──────────────────────────────────────────────────────────────

test('bitmap: Endless boards are noise smoothed by the 3x3 majority rule, never mirrored', () => {
  // An independent noise grid: the same draws, the same rules.
  function refNoise(size, rnd) {
    const g = Array.from({ length: size }, () => Array.from({ length: size }, () => (rnd() < 0.55 ? 1 : 0)));
    return g.map((row, r) => row.map((v, c) => {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) n += (g[r + dr] || [])[c + dc] || 0;
      return n >= 5 ? 1 : n <= 3 ? 0 : v;
    }));
  }
  const symmetric = (grid) => grid.every((row) => row.join('') === row.slice().reverse().join(''));
  for (let seed = 1; seed <= 40; seed++) {
    for (const size of [5, 10, 15, 20, 25, 30]) {
      assert.deepEqual(BMD.bmdNoiseGrid(size, seeded(seed * 31 + size)), refNoise(size, seeded(seed * 31 + size)), seed + '/' + size);
    }
  }
  // Only half of a mirrored board would need solving: from 10x10 up no
  // generated board comes out symmetric (on 5x5 one now and then is, by chance).
  for (const size of [10, 15, 20, 25, 30]) {
    for (let seed = 1; seed <= 60; seed++) {
      const made = BMD.bmdGenerate(size, seeded(seed * 97 + size), 200);
      assert.equal(made.icon, null, size + '/' + seed + ' is noise');
      assert.equal(symmetric(made.solution), false, size + '/' + seed + ' is not mirrored');
    }
  }
});

test('bitmap: bmdGenerate returns fair, line-solvable boards of every size, reproducible from the PRNG, with a library fallback', () => {
  for (const size of [5, 10, 15, 20, 25, 30]) {
    for (let seed = 1; seed <= 25; seed++) {
      const made = BMD.bmdGenerate(size, seeded(seed), 200);
      assert.equal(made.icon, null);
      assert.ok(made.attempts >= 1 && made.attempts <= 200);
      const grid = made.solution;
      assert.equal(grid.length, size);
      const density = grid.flat().filter(Boolean).length / (size * size);
      assert.ok(density >= 0.3 && density <= 0.75, size + '/' + seed + ': density ' + density);
      assert.equal(BMD.bmdSolveGrid(grid.map(refClues), columns(grid).map(refClues)).solved, true);
      assert.equal(BMD.bmdIsFair(grid), true);
      assert.deepEqual(BMD.bmdGenerate(size, seeded(seed), 200), made, 'same PRNG, same board');
    }
  }
  // A board that fails is drawn again: all-empty and all-full noise are unfair.
  assert.equal(BMD.bmdIsFair(Array.from({ length: 5 }, () => [0, 0, 0, 0, 0])), false);
  assert.equal(BMD.bmdIsFair(Array.from({ length: 5 }, () => [1, 1, 1, 1, 1])), false);
  assert.equal(BMD.bmdIsFair([[1, 0], [0, 1]]), false, 'two diagonals: not unique');
  // Out of attempts: a library icon picked by the PRNG, centred; the mini heart on 5x5.
  const ten = BMD.bmdGenerate(10, () => 0.999, 0);
  assert.equal(ten.icon, ICONS[ICONS.length - 1]);
  assert.deepEqual(ten.solution, decodeHex(ten.icon.hex));
  assert.equal(ten.attempts, 0);
  const fifteen = BMD.bmdGenerate(15, () => 0, 0);
  assert.equal(fifteen.icon, ICONS[0]);
  assert.deepEqual(fifteen.solution, BMD.bmdFitIcon(ICONS[0], 15));
  // On 30x30 the 10x10 icon sits in the middle, and line logic still solves it.
  const thirty = BMD.bmdGenerate(30, () => 0, 0);
  assert.deepEqual(thirty.solution, BMD.bmdFitIcon(ICONS[0], 30));
  assert.deepEqual(thirty.solution[10], [...Array(10).fill(0), ...decodeHex(ICONS[0].hex)[0], ...Array(10).fill(0)]);
  assert.equal(BMD.bmdIsFair(thirty.solution), false, 'too sparse for noise');
  assert.equal(BMD.bmdSolveGrid(thirty.solution.map(refClues), columns(thirty.solution).map(refClues)).solved, true);
  const five = BMD.bmdGenerate(5, () => 0, 0);
  assert.equal(five.icon, BMD.bmdMiniIcon);
  assert.deepEqual(five.solution, decodeHex(BMD.bmdMiniIcon.hex));
});

// ── The daily rule ──────────────────────────────────────────────────────────

test('bitmap: the daily number counts local calendar days from 2026-11-01 (#1), across DST changes', () => {
  assert.equal(BMD.bmdDayNumber(new Date(2026, 10, 1, 0, 0, 0)), 1);
  assert.equal(BMD.bmdDayNumber(new Date(2026, 10, 1, 23, 59, 59)), 1);
  assert.equal(BMD.bmdDayNumber(new Date(2026, 10, 2, 0, 0, 0)), 2);
  assert.equal(BMD.bmdDayNumber(new Date(2026, 10, 5, 10)), 5);
  assert.equal(BMD.bmdDayNumber(new Date(2026, 9, 31, 12)), 0);
  assert.equal(BMD.bmdDayKey(new Date(2026, 10, 5, 23, 30)), '2026-11-05');
  assert.equal(BMD.bmdDayKey(new Date(2027, 0, 9, 0, 1)), '2027-01-09');
  // Every day of two years, DST switches included, is one more than the day before.
  for (let i = 0; i < 730; i++) {
    const noon = new Date(2026, 10, 1 + i, 12);
    assert.equal(BMD.bmdDayNumber(noon), i + 1, BMD.bmdDayKey(noon));
    assert.equal(BMD.bmdDayKeyOf(i + 1), BMD.bmdDayKey(noon));
  }
  assert.equal(BMD.bmdDayKeyOf(0), '2026-10-31');
});

test('bitmap: FNV-1a and mulberry32 match their published definitions', () => {
  assert.equal(BMD.bmdFnv1a(''), 0x811c9dc5);
  assert.equal(BMD.bmdFnv1a('a'), 0xe40c292c);
  assert.equal(BMD.bmdFnv1a('foobar'), 0xbf9cf968);
  assert.equal(BMD.bmdFnv1a('bmd:2026-11-05'), fnv('bmd:2026-11-05'));
  for (const seed of [0, 1, 42, 0xdeadbeef]) {
    const ours = BMD.bmdMulberry32(seed);
    const ref = seeded(seed);
    for (let i = 0; i < 50; i++) assert.equal(ours(), ref());
  }
});

test('bitmap: the icon of the day follows the daily rule: every icon once per cycle, never the same two days running', () => {
  const count = ICONS.length;
  for (let day = 1; day <= 400; day += day < 120 ? 1 : 7) {
    assert.equal(BMD.bmdDailyIconIndex(day, count), DAILY_PICKS[day - 1], 'day ' + day);
  }
  for (let cycle = 0; cycle < 7; cycle++) {
    const picks = DAILY_PICKS.slice(cycle * count, (cycle + 1) * count);
    if (picks.length === count) assert.equal(new Set(picks).size, count, 'cycle ' + cycle);
  }
  for (let day = 2; day <= 400; day++) assert.notEqual(DAILY_PICKS[day - 1], DAILY_PICKS[day - 2], 'day ' + day);
  // Day 1 is the first draw of its own PRNG over the full library.
  assert.equal(DAILY_PICKS[0], Math.floor(seeded(fnv('bmd:2026-11-01'))() * count));
  // Days before #1 (a clock set back) and absurd days take a plain draw at once.
  assert.equal(BMD.bmdDailyIconIndex(0, count), Math.floor(seeded(fnv('bmd:2026-10-31'))() * count));
  assert.equal(BMD.bmdDailyIconIndex(-3, count), Math.floor(seeded(fnv('bmd:' + keyOfDay(-3)))() * count));
  const far = BMD.bmdDailyIconIndex(1e9, count);
  assert.ok(far >= 0 && far < count);
  assert.equal(BMD.bmdDailyIconIndex(2, 2), 1 - BMD.bmdDailyIconIndex(1, 2));
});

test('bitmap: time, streak, countdown, share line, hex dump and ASCII art', () => {
  assert.equal(BMD.bmdFormatTime(0), '0:00');
  assert.equal(BMD.bmdFormatTime(102999), '1:42');
  assert.equal(BMD.bmdFormatTime(3723000), '1:02:03');
  const record = (lastWon, streak) => ({ lastWon, streak });
  assert.equal(BMD.bmdStreakAsOf(record(5, 3), 5), 3);
  assert.equal(BMD.bmdStreakAsOf(record(4, 3), 5), 3);
  assert.equal(BMD.bmdStreakAsOf(record(3, 3), 5), 0, 'a missed day');
  assert.equal(BMD.bmdStreakAsOf(record(null, 3), 5), 0);
  assert.equal(BMD.bmdUntilMidnight(new Date(2026, 10, 5, 10, 0)), '14h 0m');
  assert.equal(BMD.bmdUntilMidnight(new Date(2026, 10, 5, 23, 58, 30)), '0h 2m');
  assert.equal(BMD.bmdMsUntilMidnight(new Date(2026, 10, 5, 23, 58, 30)), 90000);
  // The wait ends on the next local midnight, also across the DST changes of Europe and the US.
  for (const [m, d] of [[2, 8], [2, 29], [9, 25], [10, 1], [10, 5]]) {
    for (const hour of [0, 1, 2, 3, 12, 23]) {
      const now = new Date(2026, m, d, hour, 30);
      const ms = BMD.bmdMsUntilMidnight(now);
      const at = new Date(now.getTime() + ms);
      assert.deepEqual([at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()], [new Date(2026, m, d + 1).getDate(), 0, 0, 0], m + '/' + d + ' ' + hour);
      assert.ok(ms > 0 && ms <= 25 * HOUR, m + '/' + d + ' ' + hour);
    }
  }

  const game = { kind: 'daily', day: 5, size: 10, status: 'won', elapsed: 102000, rules: 'easy', mistakes: 1 };
  assert.equal(BMD.bmdShareText(game), 'Bitmap Decoder #5 10x10 1:42 Easy 1 mistake');
  assert.equal(BMD.bmdShareText({ ...game, mistakes: 0 }), 'Bitmap Decoder #5 10x10 1:42 Easy 0 mistakes');
  assert.equal(BMD.bmdShareText({ ...game, rules: 'hard', mistakes: 0 }), 'Bitmap Decoder #5 10x10 1:42 Hard');
  assert.equal(BMD.bmdShareText({ ...game, status: 'lost', mistakes: 3 }), 'Bitmap Decoder #5 10x10 failed 1:42 Easy 3 mistakes');
  assert.equal(BMD.bmdShareText({ ...game, kind: 'endless', size: 15 }), 'Bitmap Decoder Endless 15x15 1:42 Easy 1 mistake');
  assert.equal(BMD.bmdShareText({ ...game, kind: 'endless', practice: true }), 'Bitmap Decoder Endless 10x10 1:42 Easy 1 mistake practice');

  const mug = decodeHex(ICONS.find((icon) => icon.id === 'coffee-mug').hex);
  const dump = BMD.bmdHexDump(mug).split('\n');
  assert.equal(dump[0], 'ROW  HEX    BITS');
  assert.equal(dump[1], '00   0x090  0010010000');
  assert.equal(dump[5], '04   0x3FC  1111111100');
  assert.equal(dump.length, 11);
  assert.equal(BMD.bmdAsciiArt(mug).split('\n')[9], '.######...');
  const five = BMD.bmdHexDump(decodeHex(BMD.bmdMiniIcon.hex)).split('\n');
  assert.deepEqual(five.slice(0, 2), ['ROW  HEX   BITS', '00   0x0A  01010']);
  assert.equal(BMD.bmdHexDump(BMD.bmdFitIcon(ICONS[0], 15)).split('\n')[0], 'ROW  HEX     BITS');
  // 30 bits a row: eight hex digits.
  const wide = BMD.bmdHexDump(BMD.bmdFitIcon(ICONS[0], 30)).split('\n');
  assert.equal(wide[0], 'ROW  HEX         BITS');
  assert.equal(wide[11], '10   0x000FFC00  ' + '0'.repeat(10) + '1'.repeat(10) + '0'.repeat(10));
  assert.equal(wide.length, 31);
  assert.equal(BMD.bmdAsciiArt(BMD.bmdFitIcon(ICONS[0], 30)).split('\n')[10], '.'.repeat(10) + '#'.repeat(10) + '.'.repeat(10));
});

// ── Game rules ──────────────────────────────────────────────────────────────

test('bitmap: a tap or drag paints the tool onto empty cells, or clears the state it started on', () => {
  const [EMPTY, FILL, MARK] = [0, 1, 2];
  assert.deepEqual(BMD.bmdPaintAction(EMPTY, FILL), { from: EMPTY, to: FILL });
  assert.deepEqual(BMD.bmdPaintAction(EMPTY, MARK), { from: EMPTY, to: MARK });
  assert.deepEqual(BMD.bmdPaintAction(FILL, FILL), { from: FILL, to: EMPTY });
  assert.deepEqual(BMD.bmdPaintAction(FILL, MARK), { from: FILL, to: EMPTY });
  assert.deepEqual(BMD.bmdPaintAction(MARK, FILL), { from: MARK, to: EMPTY });
  assert.deepEqual(BMD.bmdSegment({ row: 2, col: 1 }, { row: 2, col: 4 }).map((c) => [c.row, c.col]), [[2, 1], [2, 2], [2, 3], [2, 4]]);
  assert.deepEqual(BMD.bmdSegment({ row: 3, col: 0 }, { row: 1, col: 0 }).map((c) => [c.row, c.col]), [[3, 0], [2, 0], [1, 0]]);
  assert.deepEqual(BMD.bmdSegment({ row: 1, col: 1 }, { row: 1, col: 1 }).map((c) => [c.row, c.col]), [[1, 1]]);
  assert.deepEqual(BMD.bmdSegment({ row: 0, col: 5 }, { row: 2, col: 5 }).map((c) => [c.row, c.col]), [[0, 5], [1, 5], [2, 5]]);
  assert.deepEqual(BMD.bmdSegment({ row: 0, col: 3 }, { row: 0, col: 2 }).map((c) => [c.row, c.col]), [[0, 3], [0, 2]]);
});

test('bitmap: Easy rules turn a wrong move into the truth and count it; the third mistake loses; Hard checks only the clues', () => {
  const solution = PLUS.map((row) => row.split('').map(Number));
  const easy = BMD.bmdMakeGame({ kind: 'endless', id: 'x', name: 'Plus', rules: 'easy', solution });
  assert.deepEqual(easy.rowClues, [[1], [3], [5], [3], [1]]);
  assert.equal(BMD.bmdHasMoves(easy), false, 'a fresh puzzle has no moves');
  assert.equal(BMD.bmdApplyCell(easy, 0, 2, 1), 'set');
  assert.equal(BMD.bmdHasMoves(easy), true, 'a set cell is a move');
  assert.equal(BMD.bmdApplyCell(easy, 0, 2, 1), 'same', 'nothing to change');
  assert.equal(BMD.bmdApplyCell(easy, 0, 0, 1), 'mistake', 'a wrong fill');
  assert.equal(easy.cells[0][0], 2, 'shown as a mark');
  assert.equal(BMD.bmdApplyCell(easy, 2, 2, 2), 'mistake', 'a wrong mark');
  assert.equal(easy.cells[2][2], 1, 'shown as a fill');
  assert.equal(BMD.bmdApplyCell(easy, 0, 4, 2), 'set', 'a right mark');
  assert.equal(BMD.bmdApplyCell(easy, 0, 2, 0), 'set', 'clearing is never a mistake');
  assert.equal(easy.mistakes, 2);
  // A board cleared after a mistake (a Daily keeps its mistakes) still has moves.
  const cleared = { ...easy, cells: easy.cells.map((row) => row.map(() => 0)) };
  assert.equal(BMD.bmdHasMoves(cleared), true);
  assert.equal(BMD.bmdHasMoves({ ...cleared, mistakes: 0 }), false);
  assert.equal(BMD.bmdApplyCell(easy, 4, 4, 1), 'lost');
  assert.equal(easy.status, 'lost');
  assert.equal(BMD.bmdApplyCell(easy, 1, 1, 1), 'same', 'game over');

  const hard = BMD.bmdMakeGame({ kind: 'endless', id: 'x', name: 'Plus', rules: 'hard', solution });
  assert.equal(BMD.bmdApplyCell(hard, 0, 0, 1), 'set');
  assert.equal(BMD.bmdApplyCell(hard, 2, 2, 2), 'set');
  assert.equal(hard.mistakes, 0);
  hard.cells = solution.map((row) => row.slice());
  hard.cells[2][2] = 0;
  assert.equal(BMD.bmdApplyCell(hard, 2, 2, 1), 'won');

  // A grid that matches the clues wins even where it differs from the stored solution.
  const diagonal = BMD.bmdMakeGame({ kind: 'endless', id: 'd', name: 'D', rules: 'hard', solution: [[1, 0], [0, 1]] });
  BMD.bmdApplyCell(diagonal, 0, 1, 1);
  assert.equal(BMD.bmdApplyCell(diagonal, 1, 0, 1), 'won');
});

test('bitmap: Easy allows more mistakes on bigger boards (3 up to 10x10, 10 on 30x30); Relaxed checks every move with no limit', () => {
  assert.deepEqual(BMD.bmdMistakeLimits, { 5: 3, 10: 3, 15: 5, 20: 6, 25: 8, 30: 10 });
  const solution = BMD.bmdFitIcon(ICONS[0], 30);
  const wrong = cellsOf(solution, 0);
  const easy = BMD.bmdMakeGame({ kind: 'endless', id: 'x', name: 'Rack', rules: 'easy', solution });
  for (let i = 0; i < 9; i++) assert.equal(BMD.bmdApplyCell(easy, ...wrong[i], 1), 'mistake', 'mistake ' + (i + 1));
  assert.equal(easy.status, 'playing');
  assert.equal(BMD.bmdApplyCell(easy, ...wrong[9], 1), 'lost', 'the tenth');

  const relaxed = BMD.bmdMakeGame({ kind: 'endless', id: 'x', name: 'Rack', rules: 'relaxed', solution });
  for (let i = 0; i < 40; i++) assert.equal(BMD.bmdApplyCell(relaxed, ...wrong[i], i % 2 ? 2 : 1), i % 2 ? 'set' : 'mistake');
  assert.equal(relaxed.mistakes, 20, 'a wrong fill counts, a right mark does not');
  assert.equal(relaxed.cells[wrong[0][0]][wrong[0][1]], 2, 'a wrong fill shows the truth');
  assert.equal(BMD.bmdApplyCell(relaxed, 10, 10, 2), 'mistake', 'a wrong mark too');
  assert.equal(relaxed.status, 'playing');
  const filled = cellsOf(solution).filter(([r, c]) => relaxed.cells[r][c] !== 1);
  filled.slice(0, -1).forEach(([r, c]) => assert.equal(BMD.bmdApplyCell(relaxed, r, c, 1), 'set'));
  assert.equal(BMD.bmdApplyCell(relaxed, ...filled[filled.length - 1], 1), 'won');
  assert.equal(relaxed.mistakes, 21);
  assert.equal(BMD.bmdShareText({ ...relaxed, elapsed: 102000 }), 'Bitmap Decoder Endless 30x30 1:42 Relaxed 21 mistakes');

  // Saves: Relaxed keeps any count, Easy is capped at its size's limit (and lost there); unknown rules are Easy.
  const save = (rules, mistakes) => JSON.stringify({ endless: { size: 30, rules, solution: rowsText(solution), fills: zeros(30), marks: zeros(30), mistakes } });
  const keep = BMD.bmdParseState(save('relaxed', 42)).endless;
  assert.deepEqual([keep.rules, keep.mistakes, keep.status], ['relaxed', 42, 'playing']);
  const capped = BMD.bmdParseState(save('easy', 42)).endless;
  assert.deepEqual([capped.rules, capped.mistakes, capped.status], ['easy', 10, 'lost']);
  assert.equal(BMD.bmdParseState(JSON.stringify({ rules: 'relaxed' })).rules, 'relaxed');
  assert.equal(BMD.bmdParseState(JSON.stringify({ rules: 'medium' })).rules, 'easy');
});

// ── Saves (pure) ────────────────────────────────────────────────────────────

test('bitmap: bmdParseState falls back field by field and keeps a playable Endless game', () => {
  const fresh = { mode: 'daily', size: 10, rules: 'easy', tool: 'fill', endless: null };
  for (const text of [null, '', '{', 'null', '42', '"x"', '[]', '{}']) assert.deepEqual(BMD.bmdParseState(text), fresh, String(text));
  assert.deepEqual(
    BMD.bmdParseState(JSON.stringify({ mode: 'endless', size: 15, rules: 'hard', tool: 'mark' })),
    { mode: 'endless', size: 15, rules: 'hard', tool: 'mark', endless: null }
  );
  assert.deepEqual(
    BMD.bmdParseState(JSON.stringify({ mode: 'arcade', size: 12, rules: 'insane', tool: 'erase' })),
    fresh
  );
  const saved = endlessSave({ fills: ['00100', '01100', '00000', '00000', '00000'], marks: ['10000', '00000', '00000', '00000', '00001'], mistakes: 2, elapsed: 61234.7 });
  const game = BMD.bmdParseState(JSON.stringify(saved)).endless;
  assert.equal(game.size, 5);
  assert.equal(game.id, 'e5-test');
  assert.equal(game.name, 'Bitmap TEST');
  assert.deepEqual(game.cells[0], [2, 0, 1, 0, 0]);
  assert.deepEqual(game.cells[4], [0, 0, 0, 0, 2]);
  assert.equal(game.mistakes, 2);
  assert.equal(game.elapsed, 61234);
  assert.equal(game.status, 'playing');
  assert.equal(BMD.bmdHasMoves(game), true);
  assert.deepEqual(BMD.bmdSerializeGame(game), { ...saved.endless, elapsed: 61234 });
  // Fields that fall back alone.
  const odd = BMD.bmdParseState(JSON.stringify(endlessSave({ id: '', name: 'x'.repeat(65), rules: 7, fills: 'nope', marks: ['1'], mistakes: -1, elapsed: '9' }))).endless;
  assert.deepEqual([odd.id, odd.name, odd.rules, odd.mistakes, odd.elapsed, BMD.bmdHasMoves(odd)], ['endless', 'Unnamed bitmap', 'easy', 0, 0, false]);
  // Time alone is no move: the clock runs from the moment a puzzle is shown.
  assert.equal(BMD.bmdHasMoves(BMD.bmdParseState(JSON.stringify(endlessSave({ elapsed: 9000 }))).endless), false);
  assert.deepEqual(odd.cells, Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]));
  const both = BMD.bmdParseState(JSON.stringify(endlessSave({ fills: ['10000', ...zeros(5).slice(1)], marks: ['10000', ...zeros(5).slice(1)] }))).endless;
  assert.equal(both.cells[0][0], 1, 'filled wins over marked');
  const capped = BMD.bmdParseState(JSON.stringify(endlessSave({ mistakes: 7.5 }))).endless;
  assert.deepEqual([capped.mistakes, capped.status], [3, 'lost']);
  const hard = BMD.bmdParseState(JSON.stringify(endlessSave({ rules: 'hard', mistakes: 2 }))).endless;
  assert.equal(hard.mistakes, 0, 'Hard counts no mistakes');
  const won = BMD.bmdParseState(JSON.stringify(endlessSave({ fills: PLUS, status: 'playing' }))).endless;
  assert.equal(won.status, 'won', 'the status follows the grid');
  // Unplayable Endless games are dropped (the settings stay).
  for (const [name, endless] of Object.entries({
    'not an object': 'x',
    'an unknown size': { ...endlessSave().endless, size: 6 },
    'a size as text': { ...endlessSave().endless, size: '5' },
    'no solution': { ...endlessSave().endless, solution: null },
    'a short solution': { ...endlessSave().endless, solution: PLUS.slice(1) },
    'a long row': { ...endlessSave().endless, solution: [...PLUS.slice(1), '001000'] },
    'a row of other digits': { ...endlessSave().endless, solution: [...PLUS.slice(1), '00200'] },
    'a row that is a number': { ...endlessSave().endless, solution: [...PLUS.slice(1), 100] },
    'an empty picture': { ...endlessSave().endless, solution: zeros(5) }
  })) {
    const parsed = BMD.bmdParseState(JSON.stringify({ mode: 'endless', size: 5, endless }));
    assert.equal(parsed.endless, null, name);
    assert.equal(parsed.mode, 'endless', name);
  }
});

test('bitmap: bmdParseDaily keeps the streak field by field and restores the attempt of its day', () => {
  assert.deepEqual(BMD.bmdParseDaily(null), { streak: 0, lastWon: null, maxStreak: 0, attempt: null });
  assert.deepEqual(BMD.bmdParseDaily('{"streak":4,"lastWon":9,"maxStreak":2}'), { streak: 4, lastWon: 9, maxStreak: 4, attempt: null });
  assert.deepEqual(BMD.bmdParseDaily('{"streak":-1,"lastWon":9.5,"maxStreak":"7","day":"5"}'), { streak: 0, lastWon: null, maxStreak: 0, attempt: null });
  const record = BMD.bmdParseDaily(JSON.stringify(dailySave({ fills: rowsText(dailySolution(5)), streak: 2, lastWon: 4, maxStreak: 6, elapsed: 5000 })));
  assert.deepEqual([record.streak, record.lastWon, record.maxStreak], [2, 4, 6]);
  const attempt = record.attempt;
  assert.equal(attempt.kind, 'daily');
  assert.equal(attempt.day, 5);
  assert.equal(attempt.id, dailyIcon(5).id);
  assert.equal(attempt.status, 'won');
  // The icon comes from the saved id, else from the day.
  const other = ICONS.find((icon) => icon.id !== dailyIcon(5).id);
  assert.equal(BMD.bmdParseDaily(JSON.stringify(dailySave({ icon: other.id }))).attempt.name, other.name);
  assert.equal(BMD.bmdParseDaily(JSON.stringify(dailySave({ icon: 'no-such-icon' }))).attempt.name, dailyIcon(5).name);
  assert.equal(BMD.bmdParseDaily(JSON.stringify(dailySave({ day: 1e9, icon: 1 }))).attempt.size, 10);

  assert.deepEqual(BMD.bmdParseBest(null), NO_BEST);
  assert.deepEqual(BMD.bmdParseBest('{"5":1234.9,"10":-1,"15":"77","30":5000}'), { ...NO_BEST, 5: 1234, 30: 5000 });
  assert.deepEqual(BMD.bmdParseBest('{"10":1e999}'), NO_BEST);
});

// ── The page ────────────────────────────────────────────────────────────────

test('bitmap: loading the script under Node runs no init: no lookup, no listener, no timer, no storage', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const bmd = loadScript(SCRIPT);
  assert.equal(typeof bmd.bmdInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['bmd-grid'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('bitmap: a first visit opens Daily #5 with its hidden icon, writes the attempt at once and binds every listener once', (t) => {
  const page = openPage(t);
  const solution = dailySolution(5);
  assert.equal(page.size(), 10);
  assert.equal(page.grid.children[0].getAttribute('role'), 'row');
  assert.equal(page.cell(3, 4).id, 'bmd-cell-3-4');
  assert.equal(page.cell(3, 4).getAttribute('role'), 'gridcell');
  assert.equal(page.cell(3, 4).getAttribute('aria-label'), 'Row 4, column 5: empty');
  assert.equal(page.grid.style.gridTemplateColumns, 'repeat(10, var(--bmd-cell))');
  assert.equal(page.els['bmd-board'].className, 'bmd-board bmd-board--s10');
  assert.equal(page.picture().join(''), '.'.repeat(100));
  // The clues are the run lengths of the icon of the day.
  solution.forEach((row, r) => {
    const numbers = page.clueRow(r).children.map((span) => Number(span.textContent));
    assert.deepEqual(numbers, refClues(row).length ? refClues(row) : [0], 'row ' + r);
  });
  columns(solution).forEach((col, c) => {
    const numbers = page.clueCol(c).children.map((span) => Number(span.textContent));
    assert.deepEqual(numbers, refClues(col).length ? refClues(col) : [0], 'col ' + c);
  });
  assert.equal(page.text('bmd-puzzle'), 'Daily #5 · 10x10 · Easy · icon hidden until decoded');
  assert.match(page.text('bmd-status'), /^Decoding: \d+\/10 rows and \d+\/10 columns match their RLE\.$/);
  assert.equal(page.text('bmd-time'), '0:00');
  assert.equal(page.text('bmd-mistakes'), '0/3');
  assert.equal(page.text('bmd-best-time'), '--');
  assert.equal(page.text('bmd-streak'), '0 (max 0)');
  assert.equal(page.text('bmd-new-game'), 'New Daily');
  assert.equal(page.els['bmd-tab-daily'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.els['bmd-tab-endless'].getAttribute('aria-pressed'), 'false');
  assert.equal(page.els['bmd-size'].disabled, true);
  assert.equal(page.els['bmd-size'].value, '10');
  assert.equal(page.els['bmd-size-15'].disabled, false);
  assert.equal(page.els['bmd-decode'].hidden, true);
  assert.equal(page.els['bmd-warning'].hidden, true);
  assert.equal(page.text('bmd-decode-name'), '?', 'the name stays hidden');
  assert.equal(page.grid.getAttribute('aria-activedescendant'), 'bmd-cell-0-0');
  // The attempt is in storage before the first move.
  assert.deepEqual(read(DAILY_KEY), dailySave());
  assert.deepEqual(read(STATE_KEY), { v: 1, mode: 'daily', size: 10, rules: 'easy', tool: 'fill', endless: null });
  // Listeners: one per control, the grid's own, one on document and one on window.
  for (const id of ['bmd-tab-daily', 'bmd-tab-endless', 'bmd-new-game', 'bmd-restart', 'bmd-tool-fill', 'bmd-tool-mark', 'bmd-share']) {
    assert.equal(listenerCount(page.els[id], 'click'), 1, id);
  }
  assert.equal(listenerCount(page.els['bmd-size'], 'change'), 1);
  assert.equal(listenerCount(page.els['bmd-rules'], 'change'), 1);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'contextmenu', 'keydown']) {
    assert.equal(listenerCount(page.grid, type), 1, type);
  }
  assert.equal(listenerCount(document), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(window), 3);
  assert.equal(listenerCount(window, 'pagehide'), 1);
  assert.equal(listenerCount(window, 'pageshow'), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  // The clock runs from the moment the puzzle is on show: reading the clues counts.
  t.mock.timers.tick(5000);
  assert.equal(page.text('bmd-time'), '0:05');
  assert.equal(page.picture().join(''), '.'.repeat(100));
});

test('bitmap: while the page is still loading the game waits for DOMContentLoaded; init runs only once', (t) => {
  const page = openPage(t, { readyState: 'loading' });
  assert.equal(page.size(), 0);
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(localStorage.length, 0);
  page.ready();
  assert.equal(page.size(), 10);
  assert.notEqual(localStorage.getItem(DAILY_KEY), null);

  resetStubs();
  enableClock(t, DAY5);
  const { exports: bmd, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  bmd.bmdInit();
  bmd.bmdInit();
  assert.equal(listenerCount(els['bmd-grid'], 'pointerdown'), 1);
  assert.equal(listenerCount(els['bmd-new-game'], 'click'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(els['bmd-grid'].children.length, 10);
});

test('bitmap: a tap fills, the Mark tool and the right button mark, and a tap on a filled or marked cell clears it', (t) => {
  const page = openPage(t, { storage: { [STATE_KEY]: { mode: 'daily', rules: 'hard' } } });
  const solution = dailySolution(5);
  const [fr, fc] = [solution.findIndex((row) => row.includes(1)), 0];
  const filledCol = solution[fr].indexOf(1);
  page.tap(fr, filledCol);
  assert.equal(page.stateAt(fr, filledCol), '#');
  assert.equal(page.cell(fr, filledCol).getAttribute('aria-label'), 'Row ' + (fr + 1) + ', column ' + (filledCol + 1) + ': filled');
  assert.equal(read(DAILY_KEY).fills[fr][filledCol], '1');
  page.tap(fr, filledCol);
  assert.equal(page.stateAt(fr, filledCol), '.');

  page.els['bmd-tool-mark'].click();
  assert.equal(page.els['bmd-tool-mark'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.els['bmd-tool-fill'].getAttribute('aria-pressed'), 'false');
  assert.equal(read(STATE_KEY).tool, 'mark');
  page.tap(9, 9);
  assert.equal(page.stateAt(9, 9), 'x');
  page.tap(9, 9);
  assert.equal(page.stateAt(9, 9), '.');
  page.els['bmd-tool-fill'].click();
  // The right button marks whatever the tool, and the browser menu stays shut.
  page.tap(8, fc, { button: 2 });
  assert.equal(page.stateAt(8, fc), 'x');
  assert.equal(fire(page.grid, 'contextmenu').defaultPrevented, true);
  // A fill tap on a mark clears it (and paints nothing else).
  page.tap(8, fc);
  assert.equal(page.stateAt(8, fc), '.');
  // Other buttons (middle, back) do nothing.
  page.tap(7, 7, { button: 1 });
  assert.equal(page.stateAt(7, 7), '.');
  // Outside the grid: left, right, above and below.
  for (const [x, y] of [[-5, 10], [300, 10], [10, -5], [10, 300]]) {
    fire(page.grid, 'pointerdown', { pointerId: 1, button: 0, clientX: x, clientY: y });
  }
  assert.equal(page.picture().join('').replace(/\./g, ''), '');
  // A browser's grid has a 2 px border: its rect is 304 px, the cells start at 2 px.
  page.grid.clientLeft = 2;
  page.grid.clientTop = 2;
  page.grid.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 304, bottom: 304, width: 304, height: 304 });
  fire(page.grid, 'pointerdown', { pointerId: 1, button: 2, clientX: 1, clientY: 150 });
  fire(page.grid, 'pointerdown', { pointerId: 1, button: 2, clientX: 150, clientY: 303 });
  assert.equal(page.picture().join('').replace(/\./g, ''), '', 'the border is not a cell');
  fire(page.grid, 'pointerdown', { pointerId: 1, button: 2, clientX: 2 + 9 * 30 + 1, clientY: 2 + 30 - 1 });
  fire(page.grid, 'pointerup', { pointerId: 1 });
  assert.equal(page.stateAt(0, 9), 'x', 'the last column ends at 302 px');
});

test('bitmap: a drag paints a straight run along its first direction and stops on cells in another state', (t) => {
  t.mock.method(Math, 'random', () => 0.25);
  const page = openPage(t, { storage: { [STATE_KEY]: { mode: 'endless', size: 10, rules: 'hard' } } });
  assert.equal(localStorage.getItem(DAILY_KEY), null, 'no Daily attempt before its tab is shown');
  const capture = [];
  page.grid.setPointerCapture = (id) => capture.push(id);
  page.tap(0, 5, { button: 2 });
  // Right along row 0 (wandering onto row 1 keeps to row 0), across the mark at (0, 5).
  page.drag([[0, 2], [0, 3], [1, 4], [0, 7]], { pointerId: 7 });
  assert.equal(page.picture()[0], '..###x##..');
  assert.equal(page.picture()[1], '..........');
  assert.deepEqual(capture, [1, 7]);
  assert.equal(page.grid.getAttribute('aria-activedescendant'), 'bmd-cell-0-7', 'the cursor follows the drag');
  // Down column 9 from row 2, a fast move skipping rows still paints them.
  page.drag([[2, 9], [6, 9]]);
  assert.deepEqual(page.picture().slice(2, 8).map((row) => row[9]), ['#', '#', '#', '#', '#', '.']);
  // A diagonal first move takes the longer axis (rows here).
  page.drag([[3, 0], [6, 1]]);
  assert.deepEqual(page.picture().slice(2, 8).map((row) => row[0]), ['.', '#', '#', '#', '#', '.']);
  // A drag that starts on a filled cell clears filled cells only.
  page.drag([[0, 3], [0, 9]]);
  assert.equal(page.picture()[0], '..#..x....');
  // Moves from another pointer, before any press, or after the release do nothing.
  page.point('pointermove', 9, 9, { pointerId: 99 });
  page.point('pointerdown', 9, 0, { pointerId: 3 });
  page.point('pointermove', 9, 0, { pointerId: 3 });
  page.point('pointermove', 9, 1, { pointerId: 4 });
  page.point('pointerup', 9, 1, { pointerId: 4 });
  page.point('pointermove', 9, 2, { pointerId: 3 });
  page.point('pointermove', 50, 2, { pointerId: 3 }); // far below: clamped onto (9, 2), where it already is
  page.point('pointercancel', 9, 2, { pointerId: 3 });
  page.point('pointermove', 9, 4, { pointerId: 3 });
  assert.equal(page.picture()[9], '###.......');
  // A drag that overshoots an edge paints up to that edge.
  page.drag([[7, 6], [7, 40]]);
  assert.equal(page.picture()[7], '......####');
  page.drag([[6, 3], [6, -4]]);
  assert.equal(page.picture()[6], '####.....#');
  // A finger drags like the mouse; with the Mark tool it marks the run.
  page.els['bmd-tool-mark'].click();
  page.drag([[5, 4], [5, 6]], { pointerType: 'touch', pointerId: 21 });
  assert.equal(page.picture()[5], '#...xxx..#');
  page.els['bmd-tool-fill'].click();
  // A pointer the browser cannot capture still paints.
  page.grid.setPointerCapture = () => { throw new DOMException('No active pointer', 'NotFoundError'); };
  page.drag([[8, 0], [8, 2]]);
  assert.equal(page.picture()[8], '###.......');
  // A clearing drag that runs onto empty cells clears nothing more; the cursor still follows.
  page.drag([[8, 2], [8, 4]]);
  assert.equal(page.picture()[8], '##........');
  assert.equal(page.grid.getAttribute('aria-activedescendant'), 'bmd-cell-8-4');
});

test('bitmap: Easy mistakes show the truth, end the drag and name the cell; the third one loses and reveals the icon', (t) => {
  const page = openPage(t);
  const solution = dailySolution(5);
  const errors = () => page.grid.children.flatMap((row) => row.children).filter((cell) => cell.className.includes('bmd-cell--error'));
  // A drag from a filled cell over a wrong one: the wrong cell turns into a
  // mark, counts one mistake and ends the drag before the cell after it.
  const [r0, c0] = cellsOf(solution).find(([r, c]) => c < 8 && solution[r][c + 1] === 0);
  page.drag([[r0, c0], [r0, c0 + 2], [r0, c0 + 3]]);
  assert.equal(page.picture()[r0].slice(c0, c0 + 4), '#x..');
  assert.deepEqual(errors(), [page.cell(r0, c0 + 1)]);
  assert.equal(page.toast(), 'Mistake 1/3: row ' + (r0 + 1) + ', column ' + (c0 + 2) + ' is not part of the bitmap.');
  assert.equal(page.text('bmd-mistakes'), '1/3');
  // Restart clears the board but the scored attempt keeps its mistakes and clock.
  page.els['bmd-restart'].click();
  assert.equal(page.toast(), 'Board cleared: Daily #5 keeps its clock (0:00) and mistakes (1/3).');
  assert.equal(page.picture().join(''), '.'.repeat(100));
  assert.equal(page.text('bmd-mistakes'), '1/3');
  const empties = cellsOf(solution, 0);
  const filled = cellsOf(solution);
  // A wrong mark shows the fill.
  const [r1, c1] = filled[0];
  page.els['bmd-tool-mark'].click();
  page.tap(r1, c1);
  assert.equal(page.stateAt(r1, c1), '#');
  assert.equal(page.toast(), 'Mistake 2/3: row ' + (r1 + 1) + ', column ' + (c1 + 1) + ' is part of the bitmap.');
  assert.equal(read(DAILY_KEY).mistakes, 2);
  // The next right move clears the flash.
  const [r2, c2] = empties[1];
  page.tap(r2, c2);
  assert.equal(page.stateAt(r2, c2), 'x');
  assert.deepEqual(errors(), []);
  page.els['bmd-tool-fill'].click();
  const [r3, c3] = empties[2];
  page.tap(r3, c3);
  assert.deepEqual(errors(), [page.cell(r3, c3)]);
  assert.equal(page.text('bmd-mistakes'), '3/3');
  assert.equal(page.toast(), 'Decode failed: 3/3 mistakes. It was ' + dailyIcon(5).name + '.');
  assert.equal(page.text('bmd-status'), 'Decode failed after 3 mistakes. The bitmap was ' + dailyIcon(5).name + '.');
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--lost');
  assert.ok(page.cell(...filled[1]).className.includes('bmd-cell--reveal'));
  assert.ok(!page.cell(r1, c1).className.includes('bmd-cell--reveal'), 'a filled cell is not revealed again');
  assert.equal(page.els['bmd-decode'].hidden, false);
  assert.equal(page.text('bmd-decode-name'), dailyIcon(5).name);
  assert.equal(page.text('bmd-decode-label'), 'Decode failed. It was:');
  assert.equal(page.els['bmd-decode'].className, 'bmd-decode bmd-decode--lost');
  assert.equal(page.els['bmd-restart'].disabled, true, 'the scored attempt cannot be restarted');
  const saved = read(DAILY_KEY);
  assert.deepEqual([saved.status, saved.mistakes, saved.streak, saved.lastWon], ['lost', 3, 0, null]);
  // Frozen: taps and keys change nothing.
  const before = page.picture();
  page.tap(...filled[2]);
  page.drag([filled[3], [filled[3][0], 9]]);
  page.grid.focus();
  page.key(' ');
  page.key('x');
  assert.deepEqual(page.picture(), before);
  assert.equal(read(DAILY_KEY).status, 'lost');
  // A reload shows the loss as it ended.
  const again = reload(t, page);
  assert.equal(again.grid.className, 'bmd-grid bmd-grid--lost');
  assert.deepEqual(again.picture(), before);
  assert.equal(again.text('bmd-status'), 'Decode failed after 3 mistakes. The bitmap was ' + dailyIcon(5).name + '.');
});

test('bitmap: solving the daily decodes it: hex dump, ASCII art, name, best time, streak and a frozen board after a reload', (t) => {
  const page = openPage(t, { storage: { [DAILY_KEY]: { streak: 3, lastWon: 4, maxStreak: 3 } } });
  const solution = dailySolution(5);
  assert.equal(page.text('bmd-streak'), '3 (max 3)');
  page.solve(solution, 1);
  t.mock.timers.tick(61000);
  assert.equal(page.text('bmd-time'), '1:01');
  assert.equal(page.els['bmd-decode'].hidden, true);
  page.tapLast(solution);
  const name = dailyIcon(5).name;
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');
  assert.equal(page.text('bmd-status'), 'Decoded ' + name + ' in 1:01 with 0 mistakes.');
  assert.equal(page.toast(), 'Decoded ' + name + ' in 1:01: a new best for 10x10!');
  assert.equal(page.text('bmd-puzzle'), 'Daily #5 · 10x10 · Easy · ' + name);
  assert.equal(page.els['bmd-decode'].hidden, false);
  assert.equal(page.text('bmd-decode-name'), name);
  assert.equal(page.text('bmd-decode-label'), 'Decoded:');
  assert.equal(page.els['bmd-decode'].className, 'bmd-decode');
  assert.equal(page.text('bmd-hex'), BMD.bmdHexDump(solution));
  assert.equal(page.text('bmd-ascii'), solution.map((row) => row.map((v) => (v ? '#' : '.')).join('')).join('\n'));
  assert.equal(page.text('bmd-stream'), 'stream ' + dailyIcon(5).hex.toUpperCase());
  assert.equal(page.text('bmd-best-time'), '1:01');
  assert.equal(page.text('bmd-streak'), '4 (max 4)');
  assert.equal(page.els['bmd-restart'].disabled, true);
  for (let r = 0; r < 10; r++) assert.ok(page.clueRow(r).className.includes('bmd-clue--done'), 'row clue ' + r);
  for (let c = 0; c < 10; c++) assert.ok(page.clueCol(c).className.includes('bmd-clue--done'), 'col clue ' + c);
  assert.deepEqual(read(BEST_KEY), { ...NO_BEST, 10: 61000 });
  const saved = read(DAILY_KEY);
  assert.deepEqual([saved.status, saved.elapsed, saved.streak, saved.lastWon, saved.maxStreak], ['won', 61000, 4, 5, 4]);
  // The clock has stopped; New Daily on the same day explains when the next one comes.
  t.mock.timers.tick(5000);
  assert.equal(page.text('bmd-time'), '1:01');
  page.els['bmd-new-game'].click();
  assert.equal(page.toast(), 'Daily #5 is finished: Daily #6 unlocks in 13h 59m.');
  assert.equal(read(DAILY_KEY).day, 5);

  const again = reload(t, page);
  assert.equal(again.grid.className, 'bmd-grid bmd-grid--won');
  assert.equal(again.text('bmd-decode-name'), name);
  assert.equal(again.text('bmd-time'), '1:01');
  assert.equal(again.text('bmd-streak'), '4 (max 4)');
  again.tap(0, 0);
  again.tap(9, 9, { button: 2 });
  assert.equal(again.picture().join(''), rowsText(solution).join('').replace(/1/g, '#').replace(/0/g, '.'));
  t.mock.timers.tick(3000);
  assert.equal(again.text('bmd-time'), '1:01');
});

test('bitmap: the streak continues from yesterday, restarts after a gap, shows 0 after a missed day and keeps its maximum; only a faster win is a best', (t) => {
  // The Daily of day 5 won in 0:30, with a streak and best times saved before.
  const won = (storage, best) => {
    resetStubs();
    const page = openPage(t, { storage: { [DAILY_KEY]: storage, [BEST_KEY]: best } });
    page.solve(dailySolution(5), 1);
    t.mock.timers.tick(30000);
    page.tapLast(dailySolution(5));
    return { saved: read(DAILY_KEY), best: read(BEST_KEY), toast: page.toast(), shown: page.text('bmd-best-time') };
  };
  const name = dailyIcon(5).name;
  const slower = won({ streak: 2, lastWon: 4, maxStreak: 9 }, { 10: 20000 });
  assert.deepEqual([slower.saved.streak, slower.saved.maxStreak], [3, 9]);
  assert.equal(slower.toast, 'Decoded ' + name + ' in 0:30.');
  assert.deepEqual(slower.best, { 10: 20000 }, 'a slower win leaves the best alone');
  assert.equal(slower.shown, '0:20');
  const faster = won({ streak: 2, lastWon: 3, maxStreak: 2 }, { 5: 7000, 10: 40000 });
  assert.deepEqual([faster.saved.streak, faster.saved.maxStreak], [1, 2]);
  assert.equal(faster.toast, 'Decoded ' + name + ' in 0:30: a new best for 10x10!');
  assert.deepEqual(faster.best, { ...NO_BEST, 5: 7000, 10: 30000 });
  assert.equal(faster.shown, '0:30');
  resetStubs();
  const missed = openPage(t, { storage: { [DAILY_KEY]: { streak: 6, lastWon: 3, maxStreak: 6 } } });
  assert.equal(missed.text('bmd-streak'), '0 (max 6)');
});

test('bitmap: a daily left open across midnight finishes as the day it started; New Daily or a reload starts the next one', (t) => {
  const page = openPage(t, { now: DAY5 + 13 * HOUR + 50 * 60000 }); // 23:50 on the 5th
  const solution = dailySolution(5);
  page.solve(solution, 1);
  t.mock.timers.tick(20 * 60000); // 00:10 on the 6th
  assert.match(page.text('bmd-status'), /Daily #6 is ready: press New Daily\.$/);
  assert.equal(page.text('bmd-time'), '20:00', 'the clock runs on past midnight');
  page.tapLast(solution);
  let saved = read(DAILY_KEY);
  assert.deepEqual([saved.day, saved.status, saved.lastWon, saved.streak, saved.elapsed], [5, 'won', 5, 1, 20 * 60000]);
  assert.match(page.text('bmd-status'), /^Decoded .* Daily #6 is ready: press New Daily\.$/);
  assert.equal(page.text('bmd-streak'), '1 (max 1)', 'won yesterday: the streak holds today');
  page.els['bmd-new-game'].click();
  saved = read(DAILY_KEY);
  assert.deepEqual([saved.day, saved.icon, saved.status, saved.streak, saved.lastWon], [6, dailyIcon(6).id, 'playing', 1, 5]);
  assert.equal(page.text('bmd-puzzle'), 'Daily #6 · 10x10 · Easy · icon hidden until decoded');
  assert.equal(page.text('bmd-time'), '0:00');
  assert.equal(page.els['bmd-decode'].hidden, true);
  page.els['bmd-new-game'].click();
  assert.equal(page.toast(), 'Daily #6 is in progress: Daily #7 unlocks in 23h 50m.');

  // An unfinished day 5 found by a reload on day 6 is replaced by day 6.
  resetStubs();
  const partial = rowsText(solution).map((row, r) => (r ? '0'.repeat(10) : row));
  const next = openPage(t, { now: DAY5 + 24 * HOUR, storage: { [DAILY_KEY]: dailySave({ fills: partial, elapsed: 9000, streak: 2, lastWon: 4 }) } });
  assert.equal(next.text('bmd-puzzle'), 'Daily #6 · 10x10 · Easy · icon hidden until decoded');
  assert.equal(next.text('bmd-time'), '0:00');
  assert.equal(next.picture().join(''), '.'.repeat(100));
  assert.equal(next.text('bmd-streak'), '0 (max 2)', 'day 5 was missed');
  assert.deepEqual([read(DAILY_KEY).day, read(DAILY_KEY).streak, read(DAILY_KEY).maxStreak], [6, 2, 2]);
  // So is a finished one, and the streak it won carries on.
  resetStubs();
  const after = openPage(t, { now: DAY5 + 24 * HOUR, storage: { [DAILY_KEY]: dailySave({ fills: rowsText(solution), status: 'won', streak: 3, lastWon: 5, maxStreak: 3 }) } });
  assert.equal(after.text('bmd-puzzle'), 'Daily #6 · 10x10 · Easy · icon hidden until decoded');
  assert.equal(after.text('bmd-streak'), '3 (max 3)');
});

test('bitmap: Endless makes a fresh puzzle per New Game and size, keeps the Daily aside, and Restart starts a played puzzle over as practice', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const page = openPage(t);
  page.tap(0, 0);
  page.els['bmd-tab-endless'].click();
  assert.equal(page.els['bmd-tab-endless'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.text('bmd-new-game'), 'New Game');
  assert.equal(page.els['bmd-size'].disabled, false);
  assert.equal(page.size(), 10);
  const state = read(STATE_KEY);
  assert.equal(state.mode, 'endless');
  assert.equal(state.endless.id, 'e10-80000000');
  assert.equal(state.endless.name, 'Bitmap 80000000');
  assert.equal(page.text('bmd-puzzle'), 'Endless · 10x10 · Easy · puzzle e10-80000000');
  assert.deepEqual(state.endless.solution, rowsText(BMD.bmdGenerate(10, BMD.bmdMulberry32(0x80000000), 200).solution));
  assert.equal(page.text('bmd-streak'), '0 (max 0)');

  page.els['bmd-size'].value = '5';
  fire(page.els['bmd-size'], 'change');
  assert.equal(page.size(), 5);
  assert.equal(page.els['bmd-board'].className, 'bmd-board bmd-board--s5');
  assert.equal(read(STATE_KEY).size, 5);
  const solution = page.endlessSolution();
  // The new board's clock runs from the moment it is shown.
  t.mock.timers.tick(3000);
  page.solve(solution, 1);
  t.mock.timers.tick(1000);
  page.tapLast(solution);
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');
  assert.equal(page.toast(), 'Decoded Bitmap 80000000 in 0:04: a new best for 5x5!');
  assert.equal(read(BEST_KEY)[5], 4000);
  // A restarted puzzle is practice: its clues were on show, so no best time.
  assert.equal(page.els['bmd-restart'].disabled, false);
  page.els['bmd-restart'].click();
  assert.equal(page.toast(), 'Board cleared for practice: the clock starts over, and a restarted puzzle sets no best time.');
  assert.equal(page.grid.className, 'bmd-grid');
  assert.equal(page.picture().join('').replace(/\./g, ''), '');
  assert.equal(page.text('bmd-time'), '0:00');
  assert.equal(page.text('bmd-puzzle'), 'Endless · 5x5 · Easy · puzzle e5-80000000 · practice');
  assert.equal(read(STATE_KEY).endless.practice, true);
  page.solve(solution);
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');
  assert.equal(page.toast(), 'Decoded Bitmap 80000000 in 0:00 (practice: no best time).');
  assert.equal(page.text('bmd-status'), 'Decoded Bitmap 80000000 in 0:00 with 0 mistakes.');
  assert.equal(read(BEST_KEY)[5], 4000);
  assert.equal(page.text('bmd-best-time'), '0:04');
  page.els['bmd-restart'].click();
  assert.equal(page.grid.className, 'bmd-grid');
  // A reload keeps the practice mark; New Game drops it.
  const again = reload(t, page);
  assert.match(again.text('bmd-puzzle'), / · practice$/);
  again.els['bmd-new-game'].click();
  assert.doesNotMatch(again.text('bmd-puzzle'), /practice/);
  assert.equal(read(STATE_KEY).endless.practice, false);
  // Even before a move: the clock ran while the clues were on show.
  t.mock.timers.tick(9000);
  again.els['bmd-restart'].click();
  assert.equal(again.text('bmd-time'), '0:00');
  assert.equal(read(STATE_KEY).endless.practice, true);

  page.els['bmd-size'].value = '15';
  fire(page.els['bmd-size'], 'change');
  assert.equal(page.size(), 15);
  page.els['bmd-new-game'].click();
  assert.equal(page.size(), 15);
  assert.equal(read(STATE_KEY).endless.size, 15);
  // The Daily attempt waits on its own tab.
  page.els['bmd-tab-daily'].click();
  assert.equal(page.size(), 10);
  assert.equal(page.stateAt(0, 0), dailySolution(5)[0][0] ? '#' : 'x');
});

test('bitmap: Endless falls back to a library icon when generation runs out of attempts', (t) => {
  enableClock(t, DAY5);
  writeStorage({ [STATE_KEY]: { mode: 'endless', size: 10 } });
  t.mock.method(Math, 'random', () => 0);
  const { exports: bmd, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  bmd.bmdTuning.attempts = 0;
  bmd.bmdInit();
  // Seed 0 (Math.random 0): the first draw of mulberry32(0) picks the icon.
  const icon = ICONS[Math.floor(seeded(0)() * ICONS.length)];
  const game = bmd.bmdGames.endless;
  assert.deepEqual(game.solution, decodeHex(icon.hex));
  assert.equal(game.id, 'e10-00000000');
  assert.equal(game.name, icon.name);
  // The puzzle line does not give the picture away.
  assert.equal(els['bmd-puzzle'].textContent, 'Endless · 10x10 · Easy · puzzle e10-00000000');
  assert.doesNotMatch(els['bmd-puzzle'].textContent, new RegExp(icon.id + '|' + icon.name));
});

test('bitmap: new rules switch a puzzle with no moves at once, else from the next puzzle; Hard counts no mistakes and checks only the finished grid', (t) => {
  t.mock.method(Math, 'random', () => 0.75);
  const page = openPage(t, { storage: { [STATE_KEY]: { mode: 'endless', size: 5 } } });
  const setRules = (value) => {
    page.els['bmd-rules'].value = value;
    fire(page.els['bmd-rules'], 'change');
  };
  // A puzzle with a move keeps its rules.
  page.tap(...cellsOf(page.endlessSolution())[0]);
  setRules('hard');
  assert.equal(page.toast(), 'Hard rules apply from the next puzzle; this one stays Easy (it has moves).');
  assert.equal(read(STATE_KEY).rules, 'hard');
  assert.equal(read(STATE_KEY).endless.rules, 'easy');
  assert.equal(page.text('bmd-mistakes'), '0/3');
  page.els['bmd-new-game'].click();
  assert.equal(page.text('bmd-mistakes'), 'off');
  assert.match(page.text('bmd-puzzle'), /· Hard ·/);
  // A puzzle with no move yet takes new rules at once; its clock runs on.
  t.mock.timers.tick(2000);
  setRules('easy');
  assert.equal(page.toast(), 'Easy rules apply to this puzzle now: it has no moves yet.');
  assert.equal(page.text('bmd-mistakes'), '0/3');
  assert.match(page.text('bmd-puzzle'), /· Easy ·/);
  assert.equal(page.text('bmd-time'), '0:02');
  assert.deepEqual([read(STATE_KEY).rules, read(STATE_KEY).endless.rules], ['easy', 'easy']);
  setRules('hard');
  assert.equal(read(STATE_KEY).endless.rules, 'hard');
  assert.equal(page.text('bmd-mistakes'), 'off');
  const solution = page.endlessSolution();
  // Wrong cells stay as placed.
  const wrong = cellsOf(solution, 0);
  page.tap(...wrong[0]);
  assert.equal(page.stateAt(...wrong[0]), '#');
  assert.equal(page.text('bmd-mistakes'), 'off');
  page.solve(solution);
  assert.equal(page.grid.className, 'bmd-grid', 'a wrong cell blocks the win');
  page.tap(...wrong[0]);
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');
  assert.match(page.text('bmd-status'), /^Decoded Bitmap [0-9A-F]{8} in 0:02\.$/);
  // Choosing the rules of the puzzle on show says nothing.
  page.els['bmd-toast'].textContent = '';
  setRules('hard');
  assert.equal(page.toast(), '');
  // The Daily starts with the chosen rules and keeps them on Restart.
  page.els['bmd-tab-daily'].click();
  assert.equal(page.text('bmd-mistakes'), 'off');
  assert.equal(read(DAILY_KEY).rules, 'hard');
  page.tap(0, 0);
  page.els['bmd-restart'].click();
  assert.equal(page.toast(), 'Board cleared: Daily #5 keeps its clock (0:00).');
  // A cleared board with no mistake counted has no moves again, so the attempt can switch.
  setRules('easy');
  assert.equal(page.toast(), 'Easy rules apply to this puzzle now: it has no moves yet.');
  assert.equal(read(DAILY_KEY).rules, 'easy');
  assert.equal(page.text('bmd-mistakes'), '0/3');
  // A mistake stays a move after Restart: the attempt keeps Easy.
  page.tap(...cellsOf(dailySolution(5), 0)[0]);
  assert.equal(page.text('bmd-mistakes'), '1/3');
  page.els['bmd-restart'].click();
  setRules('hard');
  assert.equal(page.toast(), 'Hard rules apply from the next puzzle; this one stays Easy (it has moves).');
  assert.equal(read(DAILY_KEY).rules, 'easy');
  assert.equal(page.text('bmd-mistakes'), '1/3');

  // A first visit's Daily, written at once, can still be played on Hard before the first move.
  resetStubs();
  const first = openPage(t);
  assert.equal(read(DAILY_KEY).rules, 'easy');
  first.els['bmd-rules'].value = 'hard';
  fire(first.els['bmd-rules'], 'change');
  assert.equal(first.text('bmd-puzzle'), 'Daily #5 · 10x10 · Hard · icon hidden until decoded');
  assert.deepEqual([read(DAILY_KEY).rules, read(STATE_KEY).rules], ['hard', 'hard']);
});

test('bitmap: Relaxed counts mistakes with no limit and sets no best time; a played Endless puzzle can drop its limit, a Daily cannot', (t) => {
  t.mock.method(Math, 'random', () => 0.4);
  const page = openPage(t, { width: 1280, storage: { [STATE_KEY]: { mode: 'endless', size: 10 } } });
  const setRules = (value) => {
    page.els['bmd-rules'].value = value;
    fire(page.els['bmd-rules'], 'change');
  };
  const rulesHtml = HTML.slice(HTML.indexOf('<select id="bmd-rules"'), HTML.indexOf('</select>', HTML.indexOf('<select id="bmd-rules"')));
  assert.deepEqual([...rulesHtml.matchAll(/<option[^>]* value="(\w+)">([^<]+)</g)].map((m) => m[1] + ': ' + m[2]),
    ['easy: Easy: 3 mistakes', 'relaxed: Relaxed: no limit', 'hard: Hard: no checks']);
  const easyLabel = () => page.els['bmd-rules-easy'].textContent;
  assert.equal(easyLabel(), 'Easy: 3 mistakes');
  // The Easy option names the limit of the board on show.
  page.els['bmd-size'].value = '30';
  fire(page.els['bmd-size'], 'change');
  assert.equal(easyLabel(), 'Easy: 10 mistakes');
  assert.equal(page.text('bmd-mistakes'), '0/10');
  const solution = page.endlessSolution();
  const wrong = cellsOf(solution, 0);
  page.tap(...wrong[0]);
  page.tap(...wrong[1]);
  assert.equal(page.text('bmd-mistakes'), '2/10');
  assert.match(page.toast(), /^Mistake 2\/10: row \d+, column \d+ is not part of the bitmap\.$/);
  // Two mistakes in, the limit comes off at once.
  setRules('relaxed');
  assert.equal(page.toast(), 'No mistake limit on this puzzle now: it goes on with 2 mistakes and sets no best time.');
  assert.equal(page.text('bmd-mistakes'), '2');
  assert.match(page.text('bmd-puzzle'), /^Endless · 30x30 · Relaxed · /);
  assert.deepEqual([read(STATE_KEY).rules, read(STATE_KEY).endless.rules, read(STATE_KEY).endless.mistakes], ['relaxed', 'relaxed', 2]);
  for (let i = 2; i < 14; i++) page.tap(...wrong[i]);
  assert.equal(page.text('bmd-mistakes'), '14');
  assert.match(page.toast(), /^Mistake 14: row \d+, column \d+ is not part of the bitmap\.$/);
  assert.equal(page.grid.className, 'bmd-grid');
  page.solve(solution);
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');
  assert.match(page.text('bmd-status'), /^Decoded Bitmap [0-9A-F]{8} in 0:00 with 14 mistakes\.$/);
  assert.match(page.toast(), /\(no mistake limit: no best time\)\.$/);
  assert.equal((read(BEST_KEY) || {})[30], undefined, 'no best time written');
  assert.equal(page.text('bmd-best-time'), '--');
  // A finished puzzle keeps its rules.
  setRules('easy');
  assert.equal(page.toast(), 'Easy rules apply from the next puzzle; this one stays Relaxed (it has moves).');

  // A lost puzzle stays lost: 15x15 allows 5 mistakes.
  page.els['bmd-size'].value = '15';
  fire(page.els['bmd-size'], 'change');
  const fifteen = page.endlessSolution();
  cellsOf(fifteen, 0).slice(0, 5).forEach(([r, c]) => page.tap(r, c));
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--lost');
  assert.match(page.toast(), /^Decode failed: 5\/5 mistakes\. It was Bitmap [0-9A-F]{8}\.$/);
  assert.match(page.text('bmd-status'), /^Decode failed after 5 mistakes\. The bitmap was Bitmap [0-9A-F]{8}\.$/);
  setRules('relaxed');
  assert.equal(page.toast(), 'Relaxed rules apply from the next puzzle; this one stays Easy (it has moves).');

  // A scored Daily keeps its limit once it has a move.
  page.els['bmd-tab-daily'].click();
  setRules('easy');
  page.tap(...cellsOf(dailySolution(5), 0)[0]);
  setRules('relaxed');
  assert.equal(page.toast(), 'Relaxed rules apply from the next puzzle; this one stays Easy (it has moves).');
  assert.equal(page.text('bmd-mistakes'), '1/3');
  assert.equal(read(DAILY_KEY).rules, 'easy');

  // A Daily started on Relaxed counts its mistakes and keeps them on Restart.
  resetStubs();
  const daily = openPage(t, { storage: { [STATE_KEY]: { rules: 'relaxed' } } });
  assert.equal(daily.text('bmd-puzzle'), 'Daily #5 · 10x10 · Relaxed · icon hidden until decoded');
  daily.tap(...cellsOf(dailySolution(5), 0)[0]);
  assert.equal(daily.text('bmd-mistakes'), '1');
  daily.els['bmd-restart'].click();
  assert.equal(daily.toast(), 'Board cleared: Daily #5 keeps its clock (0:00) and mistakes (1).');
  daily.solve(dailySolution(5));
  assert.equal(daily.grid.className, 'bmd-grid bmd-grid--won');
  assert.equal(read(DAILY_KEY).streak, 1, 'a Relaxed Daily keeps the streak');
  assert.equal((read(BEST_KEY) || {})[10], undefined, 'but sets no best time');
});

test('bitmap: keys on the focused grid move the cursor, fill and mark; shortcuts, repeats and other keys stay with the browser', (t) => {
  const page = openPage(t, { storage: { [STATE_KEY]: { rules: 'hard' } } });
  focusElement(page.grid, { keyboard: true });
  let event = page.key('ArrowRight');
  assert.equal(event.defaultPrevented, true);
  page.key('ArrowDown');
  page.key('ArrowDown');
  assert.equal(page.grid.getAttribute('aria-activedescendant'), 'bmd-cell-2-1');
  assert.ok(page.cell(2, 1).className.includes('bmd-cell--cursor'));
  assert.ok(page.clueRow(2).className.includes('bmd-clue--active'));
  assert.ok(page.clueCol(1).className.includes('bmd-clue--active'));
  page.key(' ');
  assert.equal(page.stateAt(2, 1), '#');
  page.key('Enter');
  assert.equal(page.stateAt(2, 1), '.');
  page.key('x');
  assert.equal(page.stateAt(2, 1), 'x');
  page.key('X');
  assert.equal(page.stateAt(2, 1), '.');
  page.key('ч', { code: 'KeyX' }); // X on a Ukrainian layout
  assert.equal(page.stateAt(2, 1), 'x');
  page.key('x', { repeat: true });
  assert.equal(page.stateAt(2, 1), 'x', 'a held key acts once');
  for (const mod of ['ctrlKey', 'altKey', 'metaKey', 'isComposing']) {
    event = page.key('x', { [mod]: true });
    assert.equal(event.defaultPrevented, false, mod);
    assert.equal(page.stateAt(2, 1), 'x', mod);
    assert.equal(page.key('ArrowLeft', { [mod]: true }).defaultPrevented, false);
  }
  assert.equal(page.key('Tab').defaultPrevented, false);
  assert.equal(page.key('a').defaultPrevented, false);
  assert.equal(page.key(undefined).defaultPrevented, false);
  // The cursor stops at the edges.
  for (let i = 0; i < 12; i++) {
    page.key('ArrowUp');
    page.key('ArrowLeft');
  }
  assert.equal(page.grid.getAttribute('aria-activedescendant'), 'bmd-cell-0-0');
  for (let i = 0; i < 12; i++) {
    page.key('ArrowDown');
    page.key('ArrowRight');
  }
  assert.equal(page.grid.getAttribute('aria-activedescendant'), 'bmd-cell-9-9');
  // Keys typed elsewhere on the page never reach the game.
  const input = page.page.add('host-input', 'input');
  assert.equal(pressKey(' ', { target: input }).defaultPrevented, false);
  assert.equal(pressKey('ArrowUp', { target: document.body }).defaultPrevented, false);
  assert.equal(pressKey('x', { target: page.els['bmd-new-game'] }).defaultPrevented, false);
  assert.equal(page.stateAt(9, 9), '.');
});

test('bitmap: the clock runs from the moment a puzzle is shown, one second per second, pauses in a hidden tab and switches with the tab', (t) => {
  const page = openPage(t);
  t.mock.timers.tick(3000);
  assert.equal(page.text('bmd-time'), '0:03', 'no move needed');
  assert.equal(read(DAILY_KEY).elapsed, 0, 'the running time is not written every second');
  setVisibility('hidden', t);
  assert.equal(read(DAILY_KEY).elapsed, 3000, 'hiding the tab writes it');
  t.mock.timers.tick(60000);
  setVisibility('visible', t);
  assert.equal(page.text('bmd-time'), '0:03');
  t.mock.timers.tick(1000);
  assert.equal(page.text('bmd-time'), '0:04');
  // pagehide writes the running time.
  t.mock.timers.tick(500);
  fire(window, 'pagehide');
  assert.equal(read(DAILY_KEY).elapsed, 4500);
  // The Endless tab has its own clock; the Daily one waits.
  t.mock.method(Math, 'random', () => 0.1);
  page.els['bmd-tab-endless'].click();
  assert.equal(page.text('bmd-time'), '0:00');
  t.mock.timers.tick(5000);
  assert.equal(page.text('bmd-time'), '0:05');
  page.tap(4, 4);
  t.mock.timers.tick(4000);
  assert.equal(page.text('bmd-time'), '0:09');
  page.els['bmd-tab-daily'].click();
  assert.equal(page.text('bmd-time'), '0:04');
  t.mock.timers.tick(2000);
  assert.equal(page.text('bmd-time'), '0:06');
  page.els['bmd-tab-daily'].click(); // the tab on show: still one clock
  t.mock.timers.tick(1000);
  assert.equal(page.text('bmd-time'), '0:07');
  page.els['bmd-tab-endless'].click();
  assert.equal(page.text('bmd-time'), '0:09');
  // New Game and Restart never leave a second clock behind.
  page.els['bmd-new-game'].click();
  page.tap(1, 1);
  page.els['bmd-restart'].click();
  page.tap(1, 1);
  page.els['bmd-new-game'].click();
  page.tap(1, 1);
  t.mock.timers.tick(3000);
  assert.equal(page.text('bmd-time'), '0:03');
  fire(window, 'pagehide');
  assert.equal(read(STATE_KEY).endless.elapsed, 3000);
  // A page that starts hidden (a background tab) starts its clock when it is shown.
  resetStubs();
  setVisibility('hidden', t);
  const background = openPage(t);
  t.mock.timers.tick(7000);
  assert.equal(background.text('bmd-time'), '0:00');
  setVisibility('visible', t);
  t.mock.timers.tick(2000);
  assert.equal(background.text('bmd-time'), '0:02');
});

test('bitmap: a reload brings back both games, the tab, the tool, the rules and the running clock', (t) => {
  t.mock.method(Math, 'random', () => 0.3);
  const page = openPage(t);
  const fillAt = cellsOf(dailySolution(5))[0];
  const markAt = cellsOf(dailySolution(5), 0)[0];
  page.tap(...fillAt);
  page.tap(...markAt, { button: 2 });
  t.mock.timers.tick(7000);
  page.els['bmd-tab-endless'].click();
  page.els['bmd-tool-mark'].click();
  page.els['bmd-rules'].value = 'hard';
  fire(page.els['bmd-rules'], 'change');
  page.tap(2, 2);
  t.mock.timers.tick(3000);
  const daily = page.els['bmd-tab-daily'];
  const pictureEndless = page.picture();
  fire(window, 'pagehide'); // what the browser does before a reload
  const savedState = read(STATE_KEY);

  const again = reload(t, page);
  assert.deepEqual(read(STATE_KEY), savedState);
  assert.equal(again.els['bmd-tab-endless'].getAttribute('aria-pressed'), 'true');
  assert.equal(again.els['bmd-tool-mark'].getAttribute('aria-pressed'), 'true');
  assert.equal(again.els['bmd-rules'].value, 'hard');
  assert.deepEqual(again.picture(), pictureEndless);
  assert.equal(again.text('bmd-time'), '0:03');
  t.mock.timers.tick(1000);
  assert.equal(again.text('bmd-time'), '0:04');
  again.els['bmd-tab-daily'].click();
  assert.equal(again.text('bmd-time'), '0:07');
  assert.equal(again.stateAt(...fillAt), '#');
  assert.equal(again.stateAt(...markAt), 'x');
  assert.equal(again.text('bmd-mistakes'), '0/3');
  assert.notEqual(daily, again.els['bmd-tab-daily']);
});

test('bitmap: another tab\'s saves are taken over, so a tab shown again never writes its older copy back', (t) => {
  t.mock.method(Math, 'random', () => 0.4);
  const page = openPage(t);
  const solution = dailySolution(5);
  const name = dailyIcon(5).name;
  page.tap(...cellsOf(solution)[0]);
  t.mock.timers.tick(5000);
  // Other keys are none of the game's business: the clock runs on.
  fire(window, 'storage', { key: 'other-app' });
  t.mock.timers.tick(1000);
  assert.equal(page.text('bmd-time'), '0:06');
  // The other tab solved Daily #5 in 0:30.
  const won = dailySave({ fills: rowsText(solution), status: 'won', elapsed: 30000, streak: 1, lastWon: 5, maxStreak: 1 });
  writeStorage({ [DAILY_KEY]: won, [BEST_KEY]: { 5: null, 10: 30000, 15: null } });
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');
  assert.equal(page.text('bmd-time'), '0:30');
  assert.equal(page.text('bmd-streak'), '1 (max 1)');
  assert.equal(page.text('bmd-best-time'), '0:30');
  assert.equal(page.text('bmd-decode-name'), name);
  // This tab's clock has stopped, and hiding and showing it writes the win back as it is.
  t.mock.timers.tick(5000);
  assert.equal(page.text('bmd-time'), '0:30');
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.deepEqual(read(DAILY_KEY), won);
  // A save of an older day (a tab left open since yesterday) leaves this attempt and its streak alone.
  writeStorage({ [DAILY_KEY]: dailySave({ day: 4, icon: dailyIcon(4).id, streak: 7, lastWon: 3, maxStreak: 7 }) });
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(page.text('bmd-puzzle'), 'Daily #5 · 10x10 · Easy · ' + name);
  assert.equal(page.text('bmd-streak'), '1 (max 1)');
  fire(window, 'pagehide');
  assert.deepEqual(read(DAILY_KEY), won, 'the next save puts this tab\'s day back');
  // Cleared storage (key null): the games stay, the settings and best times start over.
  page.els['bmd-tool-mark'].click();
  localStorage.clear();
  fire(window, 'storage', { key: null });
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');
  assert.equal(page.text('bmd-streak'), '1 (max 1)');
  assert.equal(page.els['bmd-tool-fill'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.text('bmd-best-time'), '--');
  // The other tab's settings and Endless puzzle come over; this tab keeps showing the Daily.
  writeStorage({ [STATE_KEY]: { ...endlessSave({ fills: ['00100', ...zeros(5).slice(1)] }), size: 5, rules: 'hard', tool: 'mark' } });
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(page.els['bmd-tab-daily'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.els['bmd-rules'].value, 'hard');
  assert.equal(page.els['bmd-tool-mark'].getAttribute('aria-pressed'), 'true');
  page.els['bmd-tab-endless'].click();
  assert.equal(page.text('bmd-puzzle'), 'Endless · 5x5 · Easy · puzzle e5-test');
  assert.equal(page.stateAt(0, 2), '#');
  // A save without an Endless puzzle keeps this tab's.
  writeStorage({ [STATE_KEY]: { mode: 'daily', size: 5 } });
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(page.els['bmd-tab-endless'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.text('bmd-puzzle'), 'Endless · 5x5 · Easy · puzzle e5-test');
  assert.equal(page.stateAt(0, 2), '#');

  // A tab that never showed the Daily takes the record over, and its Daily tab shows that attempt.
  resetStubs();
  const endlessTab = openPage(t, { storage: { [STATE_KEY]: endlessSave() } });
  assert.equal(localStorage.getItem(DAILY_KEY), null);
  writeStorage({ [DAILY_KEY]: won });
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(endlessTab.text('bmd-streak'), '1 (max 1)');
  assert.equal(endlessTab.size(), 5);
  endlessTab.els['bmd-tab-daily'].click();
  assert.equal(endlessTab.grid.className, 'bmd-grid bmd-grid--won');
  assert.equal(endlessTab.text('bmd-time'), '0:30');
});

test('bitmap: a page shown again (a tab switch, the back/forward cache) reads the saves back before writing, so a Daily won elsewhere stays won', (t) => {
  const page = openPage(t, { storage: { [DAILY_KEY]: { streak: 2, lastWon: 4, maxStreak: 2 } } });
  const solution = dailySolution(5);
  const name = dailyIcon(5).name;
  page.tap(...cellsOf(solution)[0]);
  t.mock.timers.tick(5000);
  setVisibility('hidden', t);
  assert.equal(read(DAILY_KEY).elapsed, 5000);
  // Meanwhile another load of the game wins Daily #5; no storage event reaches this page.
  const won = dailySave({ fills: rowsText(solution), status: 'won', elapsed: 30000, streak: 3, lastWon: 5, maxStreak: 3 });
  const best = { 5: null, 10: 30000, 15: null };
  writeStorage({ [DAILY_KEY]: won, [BEST_KEY]: best });
  t.mock.timers.tick(60000);
  setVisibility('visible', t);
  assert.deepEqual(read(DAILY_KEY), won, 'the older attempt is not written back');
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');
  assert.equal(page.text('bmd-time'), '0:30');
  assert.equal(page.text('bmd-streak'), '3 (max 3)');
  assert.equal(page.text('bmd-best-time'), '0:30');
  assert.equal(page.text('bmd-decode-name'), name);
  assert.equal(page.els['bmd-restart'].disabled, true);
  // The won attempt cannot be finished again for a new time or best.
  page.tap(...cellsOf(solution, 0)[0]);
  t.mock.timers.tick(3000);
  assert.equal(page.text('bmd-time'), '0:30');
  setVisibility('hidden', t);
  fire(window, 'pagehide');
  assert.deepEqual(read(DAILY_KEY), won);
  assert.deepEqual(read(BEST_KEY), best);

  // The back/forward cache: a page that comes back (pageshow, persisted) takes over what was saved while it was away.
  resetStubs();
  const cached = openPage(t);
  cached.tap(...cellsOf(solution)[0]);
  t.mock.timers.tick(4000);
  fire(window, 'pagehide', { persisted: true });
  writeStorage({ [DAILY_KEY]: won, [STATE_KEY]: { ...read(STATE_KEY), tool: 'mark' } });
  fire(window, 'pageshow', { persisted: false }); // a first load has just read the saves
  assert.equal(cached.grid.className, 'bmd-grid');
  assert.equal(cached.els['bmd-tool-fill'].getAttribute('aria-pressed'), 'true');
  fire(window, 'pageshow', { persisted: true });
  assert.equal(cached.grid.className, 'bmd-grid bmd-grid--won');
  assert.equal(cached.text('bmd-streak'), '3 (max 3)');
  assert.equal(cached.els['bmd-tool-mark'].getAttribute('aria-pressed'), 'true');
  fire(window, 'pagehide');
  assert.deepEqual(read(DAILY_KEY), won);

  // While this tab cannot write, storage holds an older copy than the tab: it is not read back.
  resetStubs();
  writeStorage({ [DAILY_KEY]: dailySave({ elapsed: 9000 }) });
  blockStorage('full', t);
  const full = openPage(t);
  assert.match(full.text('bmd-warning'), /\(QuotaExceededError\)/);
  const at = cellsOf(solution)[0];
  full.tap(...at);
  t.mock.timers.tick(2000);
  setVisibility('hidden', t);
  t.mock.timers.tick(5000);
  setVisibility('visible', t);
  assert.equal(full.stateAt(...at), '#', 'the move this tab could not save stays');
  assert.equal(full.text('bmd-time'), '0:11');
  t.mock.timers.tick(1000);
  assert.equal(full.text('bmd-time'), '0:12', 'and its clock runs on');
  fire(window, 'pageshow', { persisted: true });
  assert.equal(full.stateAt(...at), '#');
});

// The pending timeouts longer than an hour (the midnight re-render), tracked
// through setTimeout / clearTimeout; call the returned stop() before the test ends.
function trackLongTimeouts(t) {
  const live = new Set();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const setMock = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    const id = set((...a) => { live.delete(id); fn(...a); }, ms, ...args);
    if (ms > HOUR) live.add(id);
    return id;
  });
  const clearMock = t.mock.method(globalThis, 'clearTimeout', (id) => { live.delete(id); clear(id); });
  live.stop = () => { setMock.mock.restore(); clearMock.mock.restore(); };
  return live;
}

test('bitmap: a finished Daily left open shows the new day at midnight: the next Daily, and the streak as of today', (t) => {
  // openPage would enable the mocked timers again over the tracker: boot by hand.
  enableClock(t, DAY5 + 13 * HOUR); // 23:00 on the 5th
  const timers = trackLongTimeouts(t);
  writeStorage({ [DAILY_KEY]: { streak: 3, lastWon: 4, maxStreak: 3 } });
  const page = pageView(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML)));
  const solution = dailySolution(5);
  page.solve(solution);
  const decoded = 'Decoded ' + dailyIcon(5).name + ' in 0:00 with 0 mistakes.';
  assert.equal(page.text('bmd-status'), decoded);
  assert.equal(page.text('bmd-streak'), '4 (max 4)');
  assert.equal(timers.size, 1, 'one midnight timeout');
  t.mock.timers.tick(HOUR); // midnight
  assert.equal(page.text('bmd-status'), decoded);
  t.mock.timers.tick(1000); // a second past it
  assert.equal(page.text('bmd-status'), decoded + ' Daily #6 is ready: press New Daily.');
  assert.equal(page.text('bmd-streak'), '4 (max 4)', 'won yesterday: the streak holds today');
  assert.equal(timers.size, 1, 'set again for the next midnight');
  // A day without a win: the next midnight shows the streak as 0.
  t.mock.timers.tick(24 * HOUR);
  assert.equal(page.text('bmd-status'), decoded + ' Daily #7 is ready: press New Daily.');
  assert.equal(page.text('bmd-streak'), '0 (max 4)');
  assert.equal(read(DAILY_KEY).streak, 4, 'the saved record is shown as of today, not rewritten');
  // Hiding and showing the page, New Daily and Restart never add a second one.
  for (let i = 0; i < 3; i++) {
    setVisibility('hidden', t);
    setVisibility('visible', t);
    fire(window, 'pageshow', { persisted: true });
  }
  page.els['bmd-new-game'].click();
  page.els['bmd-restart'].click();
  assert.equal(page.text('bmd-puzzle'), 'Daily #7 · 10x10 · Easy · icon hidden until decoded');
  assert.equal(timers.size, 1);
  timers.stop();
});

test('bitmap: corrupt, partial or foreign saves never break the page', (t) => {
  const broken = ['', '{', 'null', '[]', '"x"', '42', 'true', '{"mode":{}}', '{"endless":[]}', '{"endless":{"size":10}}'];
  for (const text of broken) {
    for (const key of [STATE_KEY, DAILY_KEY, BEST_KEY]) {
      resetStubs();
      const page = openPage(t, { storage: { [key]: text } });
      assert.equal(page.size(), 10, key + ' ' + text);
      assert.equal(page.text('bmd-puzzle'), 'Daily #5 · 10x10 · Easy · icon hidden until decoded', key + ' ' + text);
      page.tap(0, 0);
      assert.notEqual(page.stateAt(0, 0), '.', key + ' ' + text);
    }
  }
  // A save of another day's icon with a bad picture keeps the streak and starts today.
  resetStubs();
  const page = openPage(t, { storage: { [DAILY_KEY]: { day: 'five', streak: 2, lastWon: 4, maxStreak: 2, fills: 7 } } });
  assert.equal(page.text('bmd-streak'), '2 (max 2)');
  assert.equal(read(DAILY_KEY).day, 5);
  // A partial Endless save keeps its picture and falls back on the rest.
  resetStubs();
  const partial = openPage(t, { storage: { [STATE_KEY]: { mode: 'endless', size: 99, endless: { size: 5, solution: PLUS, fills: ['11111'] } } } });
  assert.equal(partial.size(), 5);
  assert.equal(partial.picture().join(''), '.'.repeat(25));
  assert.equal(partial.text('bmd-puzzle'), 'Endless · 5x5 · Easy · puzzle endless');
  // The size follows the saved puzzle, not the unknown size 99: the choice shows 5x5 and New Game makes one.
  assert.equal(partial.els['bmd-size'].value, '5');
  t.mock.method(Math, 'random', () => 0.9);
  partial.els['bmd-new-game'].click();
  assert.equal(partial.size(), 5);
  assert.equal(read(STATE_KEY).size, 5);
});

test('bitmap: blocked or full storage still plays, with a warning that names the error', (t) => {
  blockStorage('access', t);
  let page = openPage(t);
  assert.equal(page.els['bmd-warning'].hidden, false);
  assert.equal(page.text('bmd-warning'), 'Storage is blocked or full (SecurityError): progress will not be saved after a reload.');
  page.tap(0, 0);
  assert.notEqual(page.stateAt(0, 0), '.');
  t.mock.timers.tick(2000);
  assert.equal(page.text('bmd-time'), '0:02');

  resetStubs();
  blockStorage('full', t);
  page = openPage(t, { storage: {} });
  assert.match(page.text('bmd-warning'), /\(QuotaExceededError\)/);
  page.solve(dailySolution(5));
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');

  resetStubs();
  t.mock.method(localStorage, 'getItem', () => { throw new Error('denied'); });
  page = openPage(t);
  assert.equal(page.text('bmd-warning'), 'Storage is blocked or full (Error): progress will not be saved after a reload.');
  assert.equal(page.size(), 10);
});

test('bitmap: Copy result writes the share line, and shows it selected when the clipboard is missing or refuses', async (t) => {
  const page = openPage(t, { storage: { [STATE_KEY]: { rules: 'hard' } } });
  const writes = [];
  t.mock.method(navigator.clipboard, 'writeText', (text) => { writes.push(text); return Promise.resolve(); });
  page.els['bmd-share'].click(); // still playing: nothing to share
  assert.deepEqual(writes, []);
  page.tap(0, 0);
  t.mock.timers.tick(42000);
  page.solve(dailySolution(5).map((row, r) => row.map((v, c) => (r === 0 && c === 0 ? 0 : v))));
  if (dailySolution(5)[0][0] === 0) page.tap(0, 0);
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');
  page.els['bmd-share'].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ['Bitmap Decoder #5 10x10 0:42 Hard']);
  assert.equal(page.toast(), 'Copied: Bitmap Decoder #5 10x10 0:42 Hard');
  assert.equal(page.els['bmd-share-field'].hidden, true);

  navigator.clipboard.writeText.mock.mockImplementation(() => Promise.reject(new Error('denied')));
  page.els['bmd-share'].click();
  await new Promise((resolve) => setImmediate(resolve));
  const field = page.els['bmd-share-field'];
  assert.equal(field.hidden, false);
  assert.equal(field.value, 'Bitmap Decoder #5 10x10 0:42 Hard');
  assert.equal(document.activeElement, field);
  assert.equal(page.toast(), 'Clipboard unavailable: copy the selected result below.');

  const clipboard = navigator.clipboard;
  t.after(() => { navigator.clipboard = clipboard; });
  navigator.clipboard = undefined;
  field.hidden = true;
  page.els['bmd-share'].click();
  assert.equal(field.hidden, false);
});

test('bitmap: a newer toast keeps its full 2.2 s, and a new puzzle hides the old toast', (t) => {
  const page = openPage(t);
  page.els['bmd-new-game'].click();
  assert.equal(page.toastVisible(), true);
  t.mock.timers.tick(1500);
  page.els['bmd-new-game'].click();
  t.mock.timers.tick(2199);
  assert.equal(page.toastVisible(), true);
  t.mock.timers.tick(1);
  assert.equal(page.toastVisible(), false);
  page.els['bmd-rules'].value = 'hard';
  fire(page.els['bmd-rules'], 'change');
  assert.equal(page.toastVisible(), true);
  t.mock.method(Math, 'random', () => 0.6);
  page.els['bmd-tab-endless'].click();
  page.els['bmd-new-game'].click();
  assert.equal(page.toastVisible(), false);
});

test('bitmap: phones keep 15x15 out of the size choice but still finish a saved 15x15 puzzle', (t) => {
  const solution = BMD.bmdFitIcon(ICONS[1], 15);
  const saved = {
    mode: 'endless', size: 15, rules: 'easy', tool: 'fill',
    endless: { id: 'big', name: 'Big', size: 15, rules: 'easy', solution: rowsText(solution), fills: rowsText(solution).map((row, r) => (r === 2 ? '0'.repeat(15) : row)), marks: [], mistakes: 0, elapsed: 1000, status: 'playing' }
  };
  t.mock.method(Math, 'random', () => 0.2);
  const page = openPage(t, { compact: true, storage: { [STATE_KEY]: saved } });
  assert.equal(page.els['bmd-size-15'].disabled, true);
  assert.equal(page.els['bmd-size-15'].textContent, '15x15 (screens over 600 px)', 'the option says why');
  assert.equal(page.els['bmd-size'].value, '15', 'the choice shows the board on show');
  assert.equal(page.size(), 15);
  solution[2].forEach((v, c) => { if (v) page.tap(2, c); });
  assert.equal(page.grid.className, 'bmd-grid bmd-grid--won');
  page.els['bmd-new-game'].click();
  assert.equal(page.size(), 10, 'New Game makes 10x10 on a phone');
  assert.equal(page.els['bmd-size'].value, '10');
  // Choosing 10x10 over a saved 15x15 board is a change: it starts a 10x10 board.
  resetStubs();
  const again = openPage(t, { compact: true, storage: { [STATE_KEY]: saved } });
  assert.equal(again.els['bmd-size'].value, '15');
  again.els['bmd-size'].value = '10';
  fire(again.els['bmd-size'], 'change');
  assert.equal(again.size(), 10);
  assert.deepEqual([read(STATE_KEY).size, read(STATE_KEY).endless.size], [10, 10]);

  // A phone with a 10x10 choice keeps it.
  resetStubs();
  const small = openPage(t, { compact: true, storage: { [STATE_KEY]: { mode: 'endless', size: 5 } } });
  assert.equal(small.size(), 5);
  // Without matchMedia (very old browsers) the page is treated as a desktop.
  resetStubs();
  const matchMedia = window.matchMedia;
  t.after(() => { window.matchMedia = matchMedia; });
  window.matchMedia = undefined;
  const old = openPage(t, { storage: { [STATE_KEY]: { mode: 'endless', size: 15 } } });
  assert.equal(old.size(), 15);
  assert.equal(old.els['bmd-size-15'].disabled, false);
  assert.equal(old.els['bmd-size-15'].textContent, '15x15');
});

test('bitmap: 20x20 needs a 768 px screen, 25x25 1024 px and 30x30 1280 px; a narrower one still finishes a saved big board', (t) => {
  const option = (page, size) => page.els['bmd-size-' + size];
  const offered = (page) => [15, 20, 25, 30].filter((size) => !option(page, size).disabled);
  for (const [width, sizes] of [[1280, [15, 20, 25, 30]], [1279, [15, 20, 25]], [1024, [15, 20, 25]], [1023, [15, 20]], [768, [15, 20]], [767, [15]], [601, [15]], [600, []]]) {
    resetStubs();
    const page = openPage(t, { width, storage: { [STATE_KEY]: { mode: 'endless', size: 5 } } });
    assert.deepEqual(offered(page), sizes, width + ' px');
  }
  // The disabled options say why.
  const tablet = openPage(t, { width: 1024 });
  assert.equal(option(tablet, 25).textContent, '25x25');
  assert.equal(option(tablet, 30).textContent, '30x30 (screens 1280 px and wider)');
  resetStubs();
  const narrow = openPage(t, { width: 700 });
  assert.deepEqual([20, 25, 30].map((size) => option(narrow, size).textContent),
    ['20x20 (screens 768 px and wider)', '25x25 (screens 1024 px and wider)', '30x30 (screens 1280 px and wider)']);

  // A 1280 px screen plays 30x30: 900 cells, eight hex digits a row once decoded, a best time of its own.
  resetStubs();
  t.mock.method(Math, 'random', () => 0.3);
  const desk = openPage(t, { width: 1280, storage: { [STATE_KEY]: { mode: 'endless', size: 10 } } });
  desk.els['bmd-size'].value = '30';
  fire(desk.els['bmd-size'], 'change');
  assert.equal(desk.size(), 30);
  assert.equal(desk.els['bmd-board'].className, 'bmd-board bmd-board--s30');
  assert.equal(desk.grid.style.gridTemplateColumns, 'repeat(30, var(--bmd-cell))');
  assert.equal(read(STATE_KEY).endless.size, 30);
  const solution = desk.endlessSolution();
  assert.equal(solution.length, 30);
  desk.solve(solution);
  assert.equal(desk.grid.className, 'bmd-grid bmd-grid--won');
  assert.match(desk.text('bmd-hex').split('\n')[1], /^00 {3}0x[0-9A-F]{8} {2}[01]{30}$/);
  assert.equal(read(BEST_KEY)[30], read(STATE_KEY).endless.elapsed);

  // A saved 30x30 puzzle on a 1024 px screen: still on show and playable, New Game makes 25x25.
  const saved = read(STATE_KEY);
  saved.endless.fills = zeros(30);
  saved.endless.status = 'playing';
  resetStubs();
  writeStorage({ [STATE_KEY]: saved });
  const smaller = openPage(t, { width: 1024 });
  assert.equal(smaller.size(), 30);
  assert.equal(smaller.els['bmd-size'].value, '30');
  assert.equal(option(smaller, 30).disabled, true);
  smaller.solve(solution);
  assert.equal(smaller.grid.className, 'bmd-grid bmd-grid--won');
  smaller.els['bmd-new-game'].click();
  assert.equal(smaller.size(), 25, 'the largest size the screen offers');
  assert.equal(read(STATE_KEY).size, 25);
});
