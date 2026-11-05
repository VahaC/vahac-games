// tests/patch-panel.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, keyEvent, focusElement, setVisibility, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'patch-panel';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

// The pure functions (the start-up code does not run under Node).
const ppn = loadScript(SCRIPT);

const STATE_KEY = 'ppn-state';
const BEST_KEY = 'ppn-best';
const DAILY_KEY = 'ppn-daily';
const CONFIGS = ['5', '7', '9', '5w', '7w', '9w'];
// The rim looks a scrambled, turned and solved 5x5 wrap board of seeded(1) shows
// ('open' and 'storm' have boards of their own).
const SEEN_LOOKS = ['idle', 'link', 'loose', 'up'];

// Local noon and 23:59 of 2026-11-05 (Daily #5), built in local time so the
// tests give the same day in every time zone.
const NOV5 = new Date(2026, 10, 5, 12, 0, 0).getTime();
const NOV5_LATE = new Date(2026, 10, 5, 23, 59, 0).getTime();
const KEY5 = '2026-11-05';
const KEY6 = '2026-11-06';

// The Daily of 2026-11-05, pinned: a change to the generator, the seed or
// the PRNG changes every visitor's Daily and has to show up here.
const DAILY5_MASKS = [2, 14, 10, 14, 10, 8, 4, 4, 7, 8, 1, 2, 14, 9, 3, 11, 14, 14, 10, 11, 8, 6, 12, 1, 5, 2, 12, 4, 5, 7, 8, 7, 10, 11, 9, 5, 3, 14, 11, 10, 14, 8, 1, 2, 11, 10, 8, 3, 8];
const DAILY5_START = [2, 1, 0, 3, 0, 1, 0, 0, 3, 0, 0, 2, 3, 2, 1, 2, 1, 0, 1, 2, 0, 2, 3, 2, 1, 0, 0, 0, 1, 0, 0, 0, 3, 0, 1, 2, 3, 2, 2, 1, 3, 1, 1, 2, 3, 0, 0, 0, 2];

// A ppn-state in the format the first published version writes: a 5x5 board
// with two tiles turned away from their scramble, two locks, 7 rotations and
// 12.345 s on the clock, scored (no practice run, no replay).
const SAMPLE_SAVE = '{"v":1,"view":"free","n":5,"wrap":false,' +
  '"masks":[2,14,8,6,8,4,7,8,7,12,3,11,14,13,1,6,10,13,3,12,1,2,11,8,1],' +
  '"start":[1,0,0,3,2,0,0,3,1,3,1,1,0,0,2,2,0,2,0,1,2,3,2,0,1],' +
  '"turns":[3,0,0,3,2,0,0,3,1,3,1,1,1,0,2,2,0,2,0,1,2,3,2,0,1],' +
  '"locks":[0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],' +
  '"moves":7,"elapsed":12345,"practice":null,"replay":false}';

test.beforeEach(() => resetStubs());

// ── An independent model of the board ───────────────────────────────────────
//
// Directions 0..3 are north, east, south, west; a tile is the set of
// directions it links, bit d of its mask.

const DR = [-1, 0, 1, 0];
const DC = [0, 1, 0, -1];
const dirsOf = (mask) => [0, 1, 2, 3].filter((d) => mask & (1 << d));
const maskOf = (dirs) => dirs.reduce((m, d) => m | (1 << d), 0);
const turn = (mask, k) => maskOf(dirsOf(mask).map((d) => (((d + k) % 4) + 4) % 4));
const centre = (n) => Math.floor(n / 2) * n + Math.floor(n / 2);

function period(mask) {
  if (turn(mask, 1) === mask) return 1;
  return turn(mask, 2) === mask ? 2 : 4;
}

function step(n, wrap, i, d) {
  let r = Math.floor(i / n) + DR[d];
  let c = (i % n) + DC[d];
  if (wrap) {
    r = (r + n) % n;
    c = (c + n) % n;
  } else if (r < 0 || c < 0 || r >= n || c >= n) {
    return -1;
  }
  return r * n + c;
}

const current = (masks, turns) => masks.map((m, i) => turn(m, turns[i]));

// Answered links as edges [i, j] (i < j), and the unanswered ends.
function linksOf(cur, n, wrap) {
  const edges = new Map();
  const open = [];
  cur.forEach((mask, i) => {
    for (const d of dirsOf(mask)) {
      const j = step(n, wrap, i, d);
      if (j !== -1 && dirsOf(cur[j]).includes((d + 2) % 4)) edges.set(Math.min(i, j) + '-' + Math.max(i, j), [Math.min(i, j), Math.max(i, j)]);
      else open.push({ index: i, dir: 1 << d });
    }
  });
  return { edges: [...edges.values()], open };
}

function reach(edges, from) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift();
    for (const [a, b] of edges) {
      const other = a === at ? b : b === at ? a : -1;
      if (other !== -1 && !seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return seen;
}

function solvedModel(cur, n, wrap) {
  const { edges, open } = linksOf(cur, n, wrap);
  return open.length === 0 && edges.length === n * n - 1 && reach(edges, centre(n)).size === n * n;
}

// Cells on a cycle: the ends of every link whose ends stay connected without it.
function cycleCells(cur, n, wrap) {
  const { edges } = linksOf(cur, n, wrap);
  const out = new Set();
  edges.forEach(([a, b], k) => {
    if (reach(edges.filter((e, x) => x !== k), a).has(b)) {
      out.add(a);
      out.add(b);
    }
  });
  return out;
}

// Steps from the switch over answered links, -1 for a cell it does not reach.
function distances(cur, n, wrap) {
  const { edges } = linksOf(cur, n, wrap);
  const dist = new Array(n * n).fill(-1);
  dist[centre(n)] = 0;
  const queue = [centre(n)];
  while (queue.length) {
    const at = queue.shift();
    for (const [a, b] of edges) {
      const other = a === at ? b : b === at ? a : -1;
      if (other !== -1 && dist[other] === -1) {
        dist[other] = dist[at] + 1;
        queue.push(other);
      }
    }
  }
  return dist;
}

// Uplinks (one per cell) are right when each reached cell's uplink is an
// answered link one step closer to the switch, the switch has -1 and an
// unreached cell null.  (On a loop either way round is right.)
function checkUplinks(uplinks, cur, n, wrap, where) {
  const dist = distances(cur, n, wrap);
  const { edges } = linksOf(cur, n, wrap);
  uplinks.forEach((dir, i) => {
    if (dist[i] === -1) return assert.equal(dir, null, where + ': cell ' + i + ' is not reached');
    if (i === centre(n)) return assert.equal(dir, -1, where + ': the switch');
    const j = step(n, wrap, i, dir);
    assert.ok(edges.some(([a, b]) => a === Math.min(i, j) && b === Math.max(i, j)), where + ': the uplink of ' + i + ' is an answered link');
    assert.equal(dist[j], dist[i] - 1, where + ': the uplink of ' + i + ' leads one step closer');
  });
}

const targetModel = (masks, start) => masks.reduce((sum, m, i) => sum + (period(m) - start[i] % period(m)) % period(m), 0);

// Builds link bits from [cell, direction] pairs (both ends get their bit).
function fromLinks(n, wrap, pairs) {
  const masks = new Array(n * n).fill(0);
  for (const [i, d] of pairs) {
    masks[i] |= 1 << d;
    masks[step(n, wrap, i, d)] |= 1 << ((d + 2) % 4);
  }
  return masks;
}

// A 5x5 snake through every cell: each row joined left to right, the rows
// joined at alternate ends.  Straights, corners and two end devices.
const SNAKE = fromLinks(5, false, [
  ...[0, 1, 2, 3, 4].flatMap((r) => [0, 1, 2, 3].map((c) => [r * 5 + c, 1])),
  [4, 2], [5, 2], [14, 2], [15, 2]
]);

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

// A ppn-state object for a board from ppnGenerate.
function boardSave(board, extra) {
  return Object.assign({
    v: 1, view: 'free', n: board.n, wrap: board.wrap, masks: board.masks, start: board.start,
    turns: board.start.slice(), locks: board.masks.map(() => 0), moves: 0, elapsed: 0, practice: null, replay: false
  }, extra);
}

const tapsToSolve = (masks, turns) => masks.map((m, i) => (period(m) - turns[i] % period(m)) % period(m));

// ── Pages ────────────────────────────────────────────────────────────────────

// One mocked clock for timers, Date and performance.now().  reload() drops
// the timers of the page that goes away, as a real reload does.
function makeClock(t, when = NOV5) {
  let wall = when;
  let perf = 1000;
  const enable = () => t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: wall });
  try {
    enable();
  } catch (error) {
    t.mock.timers.reset(); // a second page in the same test
    enable();
  }
  t.mock.method(performance, 'now', () => perf);
  return {
    advance(ms) {
      perf += ms;
      wall += ms;
      t.mock.timers.tick(ms);
    },
    reload() {
      t.mock.timers.reset();
      enable();
    }
  };
}

function writeStorage(storage = {}) {
  for (const [key, value] of [[STATE_KEY, storage.state], [BEST_KEY, storage.best], [DAILY_KEY, storage.daily]]) {
    if (value !== undefined) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

const storedKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();

// What a player sees and does.
function pageView(b) {
  const els = b.els;
  const board = els['ppn-board'];
  return {
    els,
    board,
    page: b.page,
    ready: b.ready,
    restore: b.restore,
    el: (name) => els['ppn-' + name],
    text: (name) => els['ppn-' + name].textContent,
    hidden: (name) => els['ppn-' + name].classList.contains('ppn-hidden'),
    // The tiles only: a wrap board adds its rim marks after them.
    tiles: () => board.children.filter((el) => el.classList.contains('ppn-tile')),
    rim: () => board.children.filter((el) => el.classList.contains('ppn-rim')),
    tile: (i) => board.children[i],
    tap: (i) => board.children[i].click(),
    rightClick: (i) => fire(board.children[i], 'contextmenu'),
    has: (i, name) => board.children[i].classList.contains(name),
    angle: (i) => Number(/^rotate\((-?\d+)deg\)$/.exec(board.children[i].children[0].style.transform)[1]),
    press(key, props) {
      focusElement(board, { keyboard: true });
      return pressKey(key, Object.assign({ target: board }, props));
    },
    click: (name) => els['ppn-' + name].click(),
    choose(value) {
      els['ppn-config'].value = value;
      return fire(els['ppn-config'], 'change');
    },
    toast: () => (els['ppn-toast'].classList.contains('ppn-show') ? els['ppn-toast'].textContent : null),
    state: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    daily: () => JSON.parse(localStorage.getItem(DAILY_KEY)),
    best: () => JSON.parse(localStorage.getItem(BEST_KEY))
  };
}

function boot(options) {
  return pageView(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options));
}

// The page as a browser loads it, after writing storage, with a mocked clock
// and Math.random.
function openPage(t, { when, random = 1, storage, options } = {}) {
  const clock = makeClock(t, when);
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

// Taps every tile back to the generated orientation, in index order, with
// an optional pause (ms) after the first tap.  Returns the taps.
function solve(v, clock, masks, turns, pause = 0) {
  let taps = 0;
  tapsToSolve(masks, turns).forEach((count, i) => {
    for (let k = 0; k < count; k++) {
      v.tap(i);
      if (taps++ === 0 && pause) clock.advance(pause);
    }
  });
  return taps;
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

// Words laid out as a browser wraps text at spaces: as many on a line as fit width characters.
function wrapWords(text, width) {
  const lines = [];
  for (const word of text.split(' ')) {
    const joined = lines.length ? lines[lines.length - 1] + ' ' + word : word;
    if (lines.length && joined.length <= width) lines[lines.length - 1] = joined;
    else lines.push(word);
  }
  return lines;
}

// ── Files ────────────────────────────────────────────────────────────────────

test('patch-panel: every id the script looks up is in index.html once; ids, classes, CSS variables, keyframes, storage keys and exports are ppn- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'ppn-best', 'ppn-board', 'ppn-config', 'ppn-daily-button', 'ppn-hint', 'ppn-lock-mode', 'ppn-mode',
    'ppn-moves', 'ppn-new-game', 'ppn-next', 'ppn-ports', 'ppn-restart', 'ppn-share', 'ppn-share-button',
    'ppn-share-text', 'ppn-status', 'ppn-streak', 'ppn-target', 'ppn-time', 'ppn-toast', 'ppn-warning',
    'ppn-wrap-note'
  ]);
  assert.equal(ids.length, new Set(ids).size, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^ppn-/);

  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^ppn-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^ppn-/, selector);
    }
  }
  // Custom properties (not the --modifier part of a class name).
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^ppn-/);
  for (const m of JS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^ppn-/);
  const keyframes = Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);
  assert.ok(keyframes.length >= 4);
  for (const name of keyframes) assert.match(name, /^ppn-/);
  assert.deepEqual([...new Set(Array.from(JS.matchAll(/'(ppn-(?:state|best|daily))'/g), (m) => m[1]))].sort(), ['ppn-best', 'ppn-daily', 'ppn-state']);
  for (const name of Object.keys(ppn)) assert.match(name, /^ppn[A-Z]/);
});

test('patch-panel: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="ppn-wrapper"'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');
  const bg = CSS.match(/--ppn-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Patch Panel — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  // One script, at the end of the body; no external resources at all.
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(/, 'no network resources');
  }
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource)\b/, 'no network calls');
});

test('patch-panel: script.js is one strict IIFE in ES5', () => {
  assert.match(JS, /^(\/\/[^\n]*\r?\n)*\r?\n?\(function \(\) \{\r?\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  // One IIFE: one function at the start of a line, closed once at the end
  // (callbacks such as masks.map(function () { ... }) are indented).
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1);
  assert.equal(JS.match(/^\}\)\(\);/gm).length, 1);
  const code = JS
    .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['double-quoted string', /"/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('patch-panel: index.html offers the six boards, a focusable board and labelled controls', () => {
  const spec = htmlPageSpec(HTML);
  assert.deepEqual(Array.from(HTML.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g), (m) => [m[1], m[2]]), [
    ['5', '5x5'], ['7', '7x7'], ['9', '9x9'],
    ['5w', '5x5 wrap (edges join)'], ['7w', '7x7 wrap (edges join)'], ['9w', '9x9 wrap (edges join)']
  ]);
  assert.equal(spec['ppn-board'].attributes.tabindex, '0');
  assert.equal(spec['ppn-board'].attributes.role, 'group');
  assert.equal(spec['ppn-lock-mode'].attributes['aria-pressed'], 'false');
  assert.equal(spec['ppn-share-text'].readOnly, true);
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
    }
  }
  assert.equal(spec['ppn-status'].attributes['aria-live'], 'polite');
  assert.equal(spec['ppn-toast'].attributes['aria-live'], 'polite');
  assert.equal(spec['ppn-warning'].attributes.role, 'alert');
  assert.match(spec['ppn-warning'].className, /\bppn-hidden\b/);
  assert.match(spec['ppn-share'].className, /\bppn-hidden\b/);
});

test('patch-panel: from 320 to 1440 px every board fits without widening the page, with tiles of at least 30 px; no stat is cut off and the board draws inside its scroll box', () => {
  const rules = cssRules(CSS);
  for (let vw = 320; vw <= 1440; vw++) {
    const wrapper = declsAt(rules, '.ppn-wrapper', vw);
    const side = px(wrapper.padding.split(/\s+/)[1]);
    const available = Math.min(vw, px(wrapper['max-width'])) - 2 * side;
    const rack = declsAt(rules, '.ppn-rack', vw);
    const rackSide = rack.padding === '0' ? 0 : px(rack.padding.split(/\s+/)[1]);
    const rackBorder = rack.border === 'none' ? 0 : px(rack.border.split(/\s+/)[0]);
    const board = declsAt(rules, '.ppn-board', vw);
    const tile = declsAt(rules, '.ppn-tile', vw);
    assert.equal(tile.width, 'var(--ppn-tile)');
    assert.equal(tile.height, 'var(--ppn-tile)');
    assert.equal(declsAt(rules, '.ppn-wrapper *', vw)['box-sizing'], 'border-box');
    assert.equal(board.width, 'max-content');
    assert.equal(board.margin, '0 auto');
    // A wrap board may keep more padding for its rim marks: every board has to fit with it.
    const padding = Math.max(px(board.padding), px(declsAt(rules, '.ppn-board--wrap', vw).padding || board.padding));
    for (const n of [5, 7, 9]) {
      const size = px(declsAt(rules, '.ppn-board--n' + n, vw)['--ppn-tile']);
      const width = n * size + (n - 1) * px(board.gap) + 2 * padding +
        2 * px(board.border.split(/\s+/)[0]) + 2 * rackSide + 2 * rackBorder;
      assert.ok(width <= available, vw + 'px: a ' + n + 'x' + n + ' board of ' + width + 'px in ' + available + 'px');
      assert.ok(size >= 30, vw + 'px: ' + n + 'x' + n + ' tiles of ' + size + 'px');
    }
    // Six stat cards share the width in equal columns (three rows of two on phones would not fit 320px).
    const stats = declsAt(rules, '.ppn-stats', vw);
    const columns = /^repeat\(([36]), minmax\(0, 1fr\)\)$/.exec(stats['grid-template-columns']);
    assert.ok(columns, vw + 'px: ' + stats['grid-template-columns']);
    // The widest best ('59:59 / 999') wraps after the slash, every line fits its card (0.61em a
    // character covers the widest common monospace fonts) and nothing is cut off with an ellipsis.
    const stat = declsAt(rules, '.ppn-stat', vw);
    const value = declsAt(rules, '.ppn-stat-value', vw);
    const card = (available - (Number(columns[1]) - 1) * px(stats.gap)) / Number(columns[1]);
    const content = card - 2 * px(stat.padding.split(/\s+/)[1]) - 2 * px(stat.border.split(/\s+/)[0]);
    const char = 0.61 * rem(value['font-size']);
    assert.equal(value['white-space'], 'normal');
    assert.equal(value['text-overflow'], undefined);
    assert.equal(value.overflow, undefined);
    const lines = wrapWords('59:59 / 999', Math.floor(content / char));
    assert.ok(lines.length <= 2 && lines.every((line) => line.length * char <= content), vw + 'px: ' + JSON.stringify(lines) + ' in ' + content + 'px');
  }
  // The board's scroll container clips whatever is drawn outside the board, so the board's
  // shadows (the win glow and its animation included) are inset and its focus ring sits inside.
  const layers = (shadow) => shadow.split(/,(?![^(]*\))/).map((layer) => layer.trim());
  let shadows = 0;
  for (const rule of rules.filter((r) => r.keyframes === 'ppn-converge' || r.selectors.some((s) => /^\.ppn-board(--[\w-]+)?(:[\w-]+)?$/.test(s)))) {
    for (const layer of rule.decls['box-shadow'] ? layers(rule.decls['box-shadow']) : []) {
      shadows++;
      assert.match(layer, /^inset /, rule.selectors.join(', ') + ': ' + layer);
    }
    if (rule.decls['outline-offset'] !== undefined) assert.ok(parseFloat(rule.decls['outline-offset']) <= 0, rule.selectors.join(', '));
  }
  assert.equal(shadows, 5, 'the board, the solved board (two) and the converge animation (two)');
  assert.equal(declsAt(rules, '.ppn-board:focus-visible', 320)['outline-offset'], '-2px');
  // A host column narrower than the screen scrolls the board's own container, never the page.
  assert.equal(declsAt(rules, '.ppn-board-wrap', 320)['overflow-x'], 'auto');
  // Only the board takes touch gestures, and it keeps scrolling and zooming.
  const touch = cssRules(CSS).filter((rule) => rule.decls['touch-action'] !== undefined);
  assert.deepEqual(touch.map((rule) => [rule.selectors, rule.decls['touch-action']]), [[['.ppn-board'], 'manipulation']]);
  // The rim marks of a wrap board sit in the board's padding beside their cell (1 px out), at every
  // width, and never take a tap.
  for (let vw = 320; vw <= 1440; vw++) {
    const board = declsAt(rules, '.ppn-board', vw);
    const padding = declsAt(rules, '.ppn-board--wrap', vw).padding || board.padding;
    // Each mark touches its cell from outside and ends short of the border (and the focus ring on it).
    assert.ok(px(board['--ppn-rim-len']) < px(padding), vw + 'px: a ' + board['--ppn-rim-len'] + ' mark in ' + padding + ' of padding');
    assert.ok(px(board['--ppn-rim-len']) >= (vw < 360 ? 4 : 5), vw + 'px: marks long enough to see');
    for (const [side, along, across, at] of [['w', 'width', 'height', 'top'], ['e', 'width', 'height', 'top'], ['n', 'height', 'width', 'left'], ['s', 'height', 'width', 'left']]) {
      const mark = declsAt(rules, '.ppn-rim--' + side, vw);
      assert.equal(mark[along], 'var(--ppn-rim-len)', vw + 'px ' + side);
      assert.equal(mark[across], '4px', vw + 'px ' + side);
      assert.equal(mark[at], '50%', vw + 'px ' + side);
      assert.equal(mark[at === 'top' ? 'margin-top' : 'margin-left'], '-2px', vw + 'px ' + side + ': centred on its row or column');
    }
  }
  assert.equal(declsAt(rules, '.ppn-board', 320).position, 'relative');
  assert.equal(declsAt(rules, '.ppn-rim', 320).position, 'absolute');
  assert.equal(declsAt(rules, '.ppn-rim', 320)['pointer-events'], 'none');
  assert.deepEqual(['w', 'e', 'n', 's'].map((side) => {
    const decls = declsAt(rules, '.ppn-rim--' + side, 320);
    return ['right', 'left', 'bottom', 'top'].filter((p) => decls[p] === '100%')[0];
  }), ['right', 'left', 'bottom', 'top']);
  // On phones a wrap board keeps two lines for the hint, the most a rim tile's hint takes.
  assert.equal(declsAt(rules, '.ppn-hint--wrap', 320)['min-height'], '3.2em');
  assert.equal(declsAt(rules, '.ppn-wrapper', 320)['line-height'], '1.6');
  // The desktop look: 64 / 56 / 48 px tiles, rack ears.
  assert.deepEqual([5, 7, 9].map((n) => declsAt(rules, '.ppn-board--n' + n, 1280)['--ppn-tile']), ['64px', '56px', '48px']);
  assert.deepEqual([5, 7, 9].map((n) => declsAt(rules, '.ppn-board--n' + n, 320)['--ppn-tile']), ['52px', '40px', '30px']);
});

test('patch-panel: packets run in along the uplink and out along the other cables, on one beat from tile to tile', () => {
  const all = cssRules(CSS);
  const plain = all.filter((rule) => rule.media === '' && rule.keyframes === '');
  // What applies to an arm with these classes: the rules of class-only
  // selectors it matches, by specificity, then in source order.
  const applied = (classes) => {
    const hits = [];
    plain.forEach((rule, order) => {
      for (const sel of rule.selectors) {
        const parts = sel.split('.').slice(1);
        if (/^(\.[\w-]+)+$/.test(sel) && parts.every((name) => classes.includes(name))) hits.push({ weight: parts.length, order, decls: rule.decls });
      }
    });
    const out = {};
    hits.sort((a, b) => a.weight - b.weight || a.order - b.order).forEach(({ decls }) => {
      for (const [prop, value] of Object.entries(decls)) {
        if (prop !== 'animation') {
          out[prop] = value;
          continue;
        }
        const parts = value.split(/\s+/);
        const times = parts.filter((p) => /^-?[\d.]+s$/.test(p));
        Object.assign(out, {
          'animation-name': parts.find((p) => /^ppn-/.test(p)),
          'animation-duration': times[0],
          'animation-delay': times[1] || '0s',
          'animation-direction': parts.find((p) => /^(normal|reverse|alternate|alternate-reverse)$/.test(p)) || 'normal'
        });
      }
    });
    return out;
  };
  const frames = (name) => {
    const at = (sel) => all.find((r) => r.keyframes === name && r.selectors[0] === sel).decls['background-position'].split(/\s+/).map(parseFloat);
    return { from: at('from'), to: at('to') };
  };
  // Where the peak of an arm's light is at time t (s), from its hub (0) to its tip (1).
  const light = (classes, t) => {
    const d = applied(classes);
    const { from, to } = frames(d['animation-name']);
    const axis = from[0] !== to[0] ? 0 : 1;
    const size = parseFloat(d['background-size'].split(/\s+/)[axis]) / 100;
    const period = parseFloat(d['animation-duration']);
    const f = ((((t - parseFloat(d['animation-delay'])) / period) % 1) + 1) % 1;
    const progress = d['animation-direction'] === 'reverse' ? 1 - f : f;
    const position = (from[axis] + (to[axis] - from[axis]) * progress) / 100;
    // A background of size times the arm at this position has its middle here, from the top or left edge.
    const x = (1 - size) * position + size / 2;
    // The tip is at the tile edge the arm is pinned to.
    const [first, last] = axis === 1 ? ['top', 'bottom'] : ['left', 'right'];
    assert.notEqual(d[first] === undefined, d[last] === undefined, classes.join(' ') + ' is pinned to one edge');
    return d[first] !== undefined ? 1 - x : x;
  };
  const T = 1.6;
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, what + ': ' + a + ' instead of ' + b);
  for (const dir of ['n', 'e', 's', 'w']) {
    const out = ['ppn-arm', 'ppn-arm-' + dir];
    const uplink = out.concat('ppn-arm--uplink');
    assert.equal(applied(out)['animation-duration'], T + 's');
    assert.equal(applied(uplink)['animation-name'], applied(out)['animation-name'], 'the uplink only shifts the beat');
    // Out from the hub a quarter into the beat, to the tip at three quarters.
    near(light(out, T / 4), 0, dir + ' out');
    near(light(out, T / 2), 0.5, dir + ' out');
    near(light(out, (3 * T) / 4), 1, dir + ' out');
    // In along the uplink from the tip at three quarters, to the hub a quarter into the next beat.
    near(light(uplink, (3 * T) / 4), 1, dir + ' in');
    near(light(uplink, T), 0.5, dir + ' in');
    near(light(uplink, (5 * T) / 4), 0, dir + ' in');
  }
  // So the light reaches the next tile's uplink tip just as it leaves an
  // outgoing tip, and leaves the hub just as it arrives there.  The state
  // classes never set or stop an animation, so a tile that lights up joins
  // the beat instead of restarting it; only lit tiles show the light.
  for (const rule of plain) {
    if (rule.selectors.some((s) => /ppn-arm/.test(s) && /--(up|open|uplink|storm)\b/.test(s))) {
      assert.equal(rule.decls.animation, undefined, rule.selectors.join(', '));
      assert.equal(rule.decls['animation-name'], undefined, rule.selectors.join(', '));
    }
  }
  for (const dir of ['n', 'e', 's', 'w']) {
    assert.match(declsAt(all, '.ppn-tile--up .ppn-arm-' + dir, 1280)['background-image'], /^linear-gradient\(\d+deg, .* 50%, .*\)$/);
    assert.equal(declsAt(all, '.ppn-arm-' + dir, 1280)['background-image'], undefined, 'no light on a dark tile');
  }
  assert.equal(declsAt(all, '.ppn-tile--up .ppn-arm--open', 1280)['background-image'], 'none');
  assert.equal(declsAt(all, '.ppn-arm', 1280, { matchMedia: (q) => /prefers-reduced-motion: reduce/.test(q) }).animation, 'none');
});

// ── Tiles and boards ─────────────────────────────────────────────────────────

test('patch-panel: ppnRotateMask turns link bits clockwise (negative turns go back), with the symmetry periods and link counts', () => {
  for (let mask = 0; mask < 16; mask++) {
    for (let k = -9; k <= 9; k++) assert.equal(ppn.ppnRotateMask(mask, k), turn(mask, k), mask + ' by ' + k);
    assert.equal(ppn.ppnPeriod(mask), period(mask), 'period of ' + mask);
    assert.equal(ppn.ppnLinkCount(mask), dirsOf(mask).length);
  }
  assert.equal(ppn.ppnRotateMask(1, 1), 2, 'north turns east');
  assert.equal(ppn.ppnRotateMask(8, 1), 1, 'west turns north');
  assert.equal(ppn.ppnRotateMask(3, -1), 9, 'a north-east corner turned back points north-west');
  assert.deepEqual([0, 15, 5, 10, 1, 3, 7].map(ppn.ppnPeriod), [1, 1, 2, 2, 4, 4, 4]);
  assert.deepEqual([5, 7, 9].map(ppn.ppnCenter), [12, 24, 40]);
});

test('patch-panel: ppnNeighbour stops at the edges, or wraps round them like a torus', () => {
  for (const n of [5, 7, 9]) {
    for (const wrap of [false, true]) {
      for (let i = 0; i < n * n; i++) {
        for (let d = 0; d < 4; d++) assert.equal(ppn.ppnNeighbour(i, d, n, wrap), step(n, wrap, i, d), [n, wrap, i, d].join(' '));
      }
    }
  }
  assert.deepEqual([0, 1, 2, 3].map((d) => ppn.ppnNeighbour(0, d, 5, false)), [-1, 1, 5, -1]);
  assert.deepEqual([0, 1, 2, 3].map((d) => ppn.ppnNeighbour(0, d, 5, true)), [20, 1, 5, 4]);
  assert.deepEqual([0, 1, 2, 3].map((d) => ppn.ppnNeighbour(24, d, 5, true)), [19, 20, 4, 23]);
});

// The rim crossings of a wrap board by the model: per row its west and east
// tiles, then per column its north and south tiles, and whether each one's
// cable points across the rim.
function crossingsModel(cur, n) {
  const out = [];
  for (let r = 0; r < n; r++) out.push({ axis: 'row', line: r, a: r * n, b: r * n + n - 1, da: 3, db: 1 });
  for (let c = 0; c < n; c++) out.push({ axis: 'col', line: c, a: c, b: (n - 1) * n + c, da: 0, db: 2 });
  return out.map(({ da, db, ...x }) => ({ ...x, aOut: dirsOf(cur[x.a]).includes(da), bOut: dirsOf(cur[x.b]).includes(db) }));
}

// How the mark at one end of a crossing should look, by the model: like the
// tile beside it (red in a loop, green when reached from the switch and in no
// loop), cyan where cables meet beside a dark tile; an unanswered cable is
// amber beside a live tile and grey otherwise; faint where no cable crosses.
function rimLookModel(crossing, end, up, loop) {
  const tile = crossing[end];
  const live = up.has(tile) && !loop.has(tile);
  if (crossing.aOut && crossing.bOut) return loop.has(tile) ? 'storm' : live ? 'up' : 'link';
  if (crossing[end + 'Out']) return live ? 'open' : 'loose';
  return 'idle';
}

// Every rim mark's look on the page, and the model's.
function rimLooks(v, n) {
  const s = v.state();
  const cur = current(s.masks, s.turns);
  const up = reach(linksOf(cur, n, true).edges, centre(n));
  const loop = cycleCells(cur, n, true);
  return {
    page: v.rim().map((m) => /\bppn-rim--(storm|up|link|open|loose|idle)\b/.exec(m.className)[1]),
    model: crossingsModel(cur, n).flatMap((c) => [rimLookModel(c, 'a', up, loop), rimLookModel(c, 'b', up, loop)])
  };
}

test('patch-panel: a wrap board\'s rim: a crossing per row and column, how each end looks, the tiles across and the hint', () => {
  for (const n of [5, 7, 9]) {
    const rnd = seeded(n);
    for (let round = 0; round < 20; round++) {
      const cur = Array.from({ length: n * n }, () => Math.floor(rnd() * 16));
      const crossings = ppn.ppnWrapCrossings(cur, n, true);
      assert.deepEqual(crossings, crossingsModel(cur, n));
      // Each crossing joins two tiles that are neighbours only across the rim.
      for (const c of crossings) {
        const d = c.axis === 'row' ? 3 : 0;
        assert.equal(step(n, true, c.a, d), c.b);
        assert.equal(step(n, false, c.a, d), -1);
      }
      assert.deepEqual(ppn.ppnWrapCrossings(cur, n, false), []);
    }
  }
  // Every look of both ends: (a's cable out, b's cable out, end, its tile live, its tile in a loop).
  // A live tile is never in a loop, so (live, loop) runs over the three real tile states.
  const looks = {};
  for (const aOut of [false, true]) {
    for (const bOut of [false, true]) {
      for (const end of ['a', 'b']) {
        for (const [live, loop] of [[false, false], [true, false], [false, true]]) {
          looks[[+aOut, +bOut, end, live ? 'live' : loop ? 'loop' : 'dark'].join(' ')] = ppn.ppnCrossingLook({ aOut, bOut }, end, live, loop);
        }
      }
    }
  }
  assert.deepEqual(looks, {
    '0 0 a dark': 'idle', '0 0 a live': 'idle', '0 0 a loop': 'idle', '0 0 b dark': 'idle', '0 0 b live': 'idle', '0 0 b loop': 'idle',
    '0 1 a dark': 'idle', '0 1 a live': 'idle', '0 1 a loop': 'idle', '0 1 b dark': 'loose', '0 1 b live': 'open', '0 1 b loop': 'loose',
    '1 0 a dark': 'loose', '1 0 a live': 'open', '1 0 a loop': 'loose', '1 0 b dark': 'idle', '1 0 b live': 'idle', '1 0 b loop': 'idle',
    '1 1 a dark': 'link', '1 1 a live': 'up', '1 1 a loop': 'storm', '1 1 b dark': 'link', '1 1 b live': 'up', '1 1 b loop': 'storm'
  });
  // The tiles across the rim: the wrap neighbours that are not neighbours without wrap, row first.
  for (const n of [5, 7, 9]) {
    for (let i = 0; i < n * n; i++) {
      const across = [3, 1, 0, 2].filter((d) => step(n, false, i, d) === -1).map((d) => step(n, true, i, d));
      assert.deepEqual(ppn.ppnWrapTwins(i, n, true), across, n + ' ' + i);
      assert.deepEqual(ppn.ppnWrapTwins(i, n, false), []);
    }
  }
  assert.deepEqual(ppn.ppnWrapTwins(0, 5, true), [4, 20]);
  assert.deepEqual(ppn.ppnWrapTwins(12, 5, true), []);
  // The hint names where each rim edge of a tile continues.
  assert.equal(ppn.ppnWrapHint(0, 5, true), ' · wraps W→E1, N→A5');
  assert.equal(ppn.ppnWrapHint(24, 5, true), ' · wraps E→A5, S→E1');
  assert.equal(ppn.ppnWrapHint(10, 5, true), ' · wraps W→E3');
  assert.equal(ppn.ppnWrapHint(71, 9, true), ' · wraps E→A8');
  assert.equal(ppn.ppnWrapHint(2, 7, true), ' · wraps N→C7');
  // The longest hint (a locked corner device of a 9x9 board) fits two lines of a 320px phone.
  const longest = 'A1 access point: mask 0x8 (W), locked' + ppn.ppnWrapHint(0, 9, true);
  assert.ok(longest.length <= 2 * 38, longest.length + ' characters: ' + longest);
  assert.equal(ppn.ppnWrapHint(12, 5, true), '');
  assert.equal(ppn.ppnWrapHint(0, 5, false), '');
});

test('patch-panel: links, open ends, the switch\'s network, loops and the win on hand-made boards', () => {
  const zeros = new Array(25).fill(0);
  // The snake is one solved tree, with or without wrap (no cable crosses an edge).
  assert.equal(solvedModel(SNAKE, 5, false), true);
  assert.equal(ppn.ppnIsSolved(SNAKE, 5, false), true);
  assert.equal(ppn.ppnIsSolved(SNAKE, 5, true), true);
  assert.deepEqual(ppn.ppnOpenEnds(SNAKE, 5, false), []);
  assert.equal(ppn.ppnConnectedSet(SNAKE, 5, false).every(Boolean), true);
  assert.equal(ppn.ppnHasLoop(SNAKE, 5, false), false);
  assert.deepEqual(ppn.ppnLoopCells(SNAKE, 5, false), new Array(25).fill(false));
  assert.deepEqual([0, 1, 4, 9, 12, 24].map((i) => ppn.ppnShape(SNAKE[i], i, 5)), ['server', 'straight', 'corner', 'corner', 'switch', 'access point']);

  // The first end device turned south: it and its old neighbour now dangle.
  const turned = current(SNAKE, [1].concat(new Array(24).fill(0)));
  assert.deepEqual(ppn.ppnOpenEnds(turned, 5, false), linksOf(turned, 5, false).open);
  assert.deepEqual(ppn.ppnOpenEnds(turned, 5, false), [{ index: 0, dir: 4 }, { index: 1, dir: 8 }]);
  const reached = ppn.ppnConnectedSet(turned, 5, false);
  assert.deepEqual(reached, turned.map((m, i) => reach(linksOf(turned, 5, false).edges, 12).has(i)));
  assert.equal(reached.filter(Boolean).length, 24);
  assert.equal(ppn.ppnIsSolved(turned, 5, false), false);

  // A ring of four corners with a tail: the ring is the loop, the tail is not.
  const ring = fromLinks(5, false, [[0, 1], [0, 2], [1, 2], [5, 1], [6, 1]]);
  const loop = ppn.ppnLoopCells(ring, 5, false);
  assert.deepEqual(loop.map((x, i) => (x ? i : -1)).filter((i) => i !== -1), [0, 1, 5, 6]);
  assert.deepEqual([...cycleCells(ring, 5, false)].sort((a, b) => a - b), [0, 1, 5, 6]);
  assert.equal(ppn.ppnHasLoop(ring, 5, false), true);
  assert.equal(ppn.ppnIsSolved(ring, 5, false), false);
  assert.deepEqual(ppn.ppnConnectedSet(ring, 5, false), zeros.map((x, i) => i === 12), 'the switch alone, an empty tile');

  // A row of straights: a path without wrap (open at both edges), a loop round the torus with it.
  const row = zeros.map((x, i) => (i >= 10 && i < 15 ? 10 : 0));
  assert.deepEqual(ppn.ppnOpenEnds(row, 5, false), [{ index: 10, dir: 8 }, { index: 14, dir: 2 }]);
  assert.equal(ppn.ppnHasLoop(row, 5, false), false);
  assert.deepEqual(ppn.ppnOpenEnds(row, 5, true), []);
  assert.equal(ppn.ppnHasLoop(row, 5, true), true);
  assert.deepEqual(ppn.ppnLoopCells(row, 5, true).map((x, i) => (x ? i : -1)).filter((i) => i !== -1), [10, 11, 12, 13, 14]);
  assert.equal(ppn.ppnConnectedSet(row, 5, true).filter(Boolean).length, 5);

  // Two loops joined by a cable: the cable between them belongs to the storm too.
  const twin = fromLinks(5, false, [[0, 1], [0, 2], [1, 2], [5, 1], [6, 1], [7, 1], [3, 1], [3, 2], [4, 2], [8, 1]]);
  const twinLoop = ppn.ppnLoopCells(twin, 5, false).map((x, i) => (x ? i : -1)).filter((i) => i !== -1);
  assert.deepEqual(twinLoop, [0, 1, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([...cycleCells(twin, 5, false)].sort((a, b) => a - b), [0, 1, 3, 4, 5, 6, 8, 9]);

  // Shapes of the other tiles, and port names.
  assert.equal(ppn.ppnShape(7, 0, 5), 'tee');
  assert.equal(ppn.ppnShape(15, 0, 5), 'cross');
  assert.deepEqual([0, 4, 12, 20, 24, 80].map((i) => ppn.ppnCellName(i, i === 80 ? 9 : 5)), ['A1', 'E1', 'C3', 'A5', 'E5', 'I9']);
  // End devices come in diagonal stripes (column + row), so every size mixes all three.
  assert.deepEqual([0, 1, 2, 5, 6].map((i) => ppn.ppnShape(1, i, 5)), ['server', 'NAS', 'access point', 'NAS', 'access point']);
  for (const n of [5, 7, 9]) {
    for (let col = 0; col < 3; col++) {
      const kinds = new Set([0, 1, 2].map((row) => ppn.ppnShape(1, row * n + col, n)));
      assert.equal(kinds.size, 3, n + 'x' + n + ' column ' + col + ' has all three devices');
    }
  }

  // Uplinks: the switch has none, a reached tile points back toward it, an unreached tile has none.
  const up = ppn.ppnUplinks(turned, 5, false);
  assert.equal(up[12], -1);
  assert.equal(up[0], null, 'the turned server is cut off');
  assert.equal(up[1], 1, 'A1\'s neighbour hangs on from the east');
  assert.equal(up[11], 1, 'the switch\'s west neighbour points east to it');
  assert.equal(up[13], 3, 'the switch\'s east neighbour points west to it');
  checkUplinks(up, turned, 5, false, 'the turned snake');
  checkUplinks(ppn.ppnUplinks(ring, 5, false), ring, 5, false, 'the ring');
  checkUplinks(ppn.ppnUplinks(row, 5, true), row, 5, true, 'the row round the torus');
});

test('patch-panel: generated boards are spanning trees from the switch with at most three links a tile, scrambled and never solved', (t) => {
  t.mock.method(Math, 'random', () => {
    throw new Error('a board drawn with its own random source never touches Math.random');
  });
  for (const n of [5, 7, 9]) {
    for (const wrap of [false, true]) {
      for (let seed = 1; seed <= 40; seed++) {
        const where = n + 'x' + n + (wrap ? ' wrap' : '') + ' seed ' + seed;
        const board = ppn.ppnGenerate(n, seeded(seed * 31 + n), wrap);
        assert.deepEqual(Object.keys(board), ['n', 'wrap', 'masks', 'start'], where);
        assert.equal(board.n, n);
        assert.equal(board.wrap, wrap);
        assert.equal(board.masks.length, n * n);
        for (const mask of board.masks) {
          assert.ok(Number.isInteger(mask) && mask >= 1 && mask <= 15, where + ': mask ' + mask);
          assert.ok(dirsOf(mask).length <= 3, where + ': no tile above three links');
        }
        assert.equal(solvedModel(board.masks, n, wrap), true, where + ': the generated orientation is one tree');
        for (const turnCount of board.start) assert.ok([0, 1, 2, 3].includes(turnCount), where);
        const cur = current(board.masks, board.start);
        assert.equal(solvedModel(cur, n, wrap), false, where + ': the scramble is not solved');
        assert.equal(ppn.ppnIsSolved(cur, n, wrap), false, where);
        assert.equal(ppn.ppnTargetOf(board.masks, board.start), targetModel(board.masks, board.start), where);
        // The board functions agree with the model on the scrambled board.
        const links = linksOf(cur, n, wrap);
        assert.deepEqual(ppn.ppnOpenEnds(cur, n, wrap), links.open, where);
        const reached = reach(links.edges, centre(n));
        assert.deepEqual(ppn.ppnConnectedSet(cur, n, wrap), cur.map((m, i) => reached.has(i)), where);
        checkUplinks(ppn.ppnUplinks(cur, n, wrap), cur, n, wrap, where);
        const loop = ppn.ppnLoopCells(cur, n, wrap);
        for (const i of cycleCells(cur, n, wrap)) assert.equal(loop[i], true, where + ': cell ' + i + ' is on a cycle');
        loop.forEach((inLoop, i) => {
          if (!inLoop) return;
          const inside = links.edges.filter(([a, b]) => (a === i && loop[b]) || (b === i && loop[a])).length;
          assert.ok(inside >= 2, where + ': a storm cell has two storm links');
        });
        assert.equal(ppn.ppnHasLoop(cur, n, wrap), cycleCells(cur, n, wrap).size > 0, where);
      }
    }
  }
  // The same draws give the same board; other draws another one.
  assert.deepEqual(ppn.ppnGenerate(7, seeded(9), true), ppn.ppnGenerate(7, seeded(9), true));
  assert.notDeepEqual(ppn.ppnGenerate(7, seeded(9), true).masks, ppn.ppnGenerate(7, seeded(10), true).masks);
});

test('patch-panel: a random source that only ever scrambles back to the solution gets one end device turned', () => {
  let draws = 0;
  const board = ppn.ppnGenerate(5, () => { draws++; return 0; }, false);
  assert.equal(draws, 24 + 10 * 25, 'one draw per link, then ten scrambles of 25 tiles');
  assert.equal(solvedModel(board.masks, 5, false), true);
  const leaf = board.masks.findIndex((m) => dirsOf(m).length === 1);
  assert.deepEqual(board.start, board.masks.map((m, i) => (i === leaf ? 1 : 0)));
  assert.equal(ppn.ppnIsSolved(current(board.masks, board.start), 5, false), false);
  assert.equal(ppn.ppnTargetOf(board.masks, board.start), 3);
});

test('patch-panel: the target counts clockwise taps back to the generated board, a straight\'s half turn included', () => {
  // A straight 1, 2 or 3 turns away needs 1, 0 and 1 taps; a corner 3, 2, 1; a cross none.
  assert.equal(ppn.ppnTargetOf([5, 5, 5, 3, 3, 3, 15, 7], [1, 2, 3, 1, 2, 3, 3, 0]), 1 + 0 + 1 + 3 + 2 + 1 + 0 + 0);
  assert.equal(ppn.ppnTargetOf(SNAKE, new Array(25).fill(0)), 0);
  assert.equal(ppn.ppnTargetOf(DAILY5_MASKS, DAILY5_START), targetModel(DAILY5_MASKS, DAILY5_START));
});

// ── Daily ────────────────────────────────────────────────────────────────────

test('patch-panel: FNV-1a and mulberry32 match their reference values, and the Daily board comes from "ppn:" + the date', (t) => {
  assert.equal(ppn.ppnHash(''), 0x811c9dc5);
  assert.equal(ppn.ppnHash('a'), 0xe40c292c);
  assert.equal(ppn.ppnHash('foobar'), 0xbf9cf968);
  for (const text of ['ppn:2026-11-01', 'ppn:' + KEY5, 'Patch Panel']) assert.equal(ppn.ppnHash(text), fnv1a(text), text);
  for (const seed of [0, 1, 42, 0xffffffff, ppn.ppnHash('ppn:' + KEY5)]) {
    const mine = ppn.ppnMulberry32(seed);
    const reference = seeded(seed);
    for (let i = 0; i < 20; i++) assert.equal(mine(), reference(), 'seed ' + seed + ' draw ' + i);
  }
  t.mock.method(Math, 'random', () => {
    throw new Error('the Daily never uses Math.random');
  });
  const daily = ppn.ppnDailyBoard(KEY5);
  assert.deepEqual(daily, ppn.ppnGenerate(7, seeded(fnv1a('ppn:' + KEY5)), false));
  assert.deepEqual(daily.masks, DAILY5_MASKS);
  assert.deepEqual(daily.start, DAILY5_START);
  assert.equal(ppn.ppnTargetOf(daily.masks, daily.start), 55);
  assert.deepEqual(ppn.ppnDailyBoard(KEY5), daily, 'the same for every visitor');
  assert.notDeepEqual(ppn.ppnDailyBoard(KEY6).masks, daily.masks);
  assert.equal(daily.wrap, false);
});

test('patch-panel: the day key is the local date and #1 is 2026-11-01, counted without a jump at daylight saving changes', () => {
  const info = (...args) => ppn.ppnDayInfo(new Date(...args));
  assert.deepEqual(info(2026, 10, 1, 0, 0, 1), { key: '2026-11-01', day: 1 });
  assert.deepEqual(info(2026, 10, 5, 0, 0, 0), { key: KEY5, day: 5 });
  assert.deepEqual(info(2026, 10, 5, 23, 59, 59), { key: KEY5, day: 5 });
  assert.deepEqual(info(2026, 10, 6, 0, 0, 0), { key: KEY6, day: 6 });
  assert.deepEqual(info(2026, 9, 31, 12), { key: '2026-10-31', day: 0 });
  assert.deepEqual(info(2027, 0, 1, 12), { key: '2027-01-01', day: 62 });
  assert.deepEqual(info(2028, 1, 29, 12), { key: '2028-02-29', day: 486 });
  // Every local day from October to April (both daylight saving changes in
  // Europe and America) is one number after the day before.
  let previous = info(2026, 9, 1, 12).day;
  for (let k = 1; k < 200; k++) {
    for (const hour of [0, 12, 23]) {
      const today = info(2026, 9, 1 + k, hour);
      assert.equal(today.day, previous + 1, today.key + ' ' + hour + ':00');
      assert.equal(ppn.ppnKeyDay(today.key), today.day);
    }
    previous += 1;
  }
  // Keys read back from a save.
  assert.equal(ppn.ppnKeyDay('2026-11-01'), 1);
  assert.equal(ppn.ppnKeyDay('2028-02-29'), 486);
  for (const bad of ['2026-11-31', '2026-13-01', '2026-02-29', '2026-00-10', '2026-11-00', '0050-01-01', '2026-1-05', ' 2026-11-05', '2026-11-05T00', '', 20261105, null, undefined, {}]) {
    assert.equal(ppn.ppnKeyDay(bad), null, JSON.stringify(bad));
  }
});

test('patch-panel: the streak lasts while the last win is today or yesterday, the time reads m:ss and the share line', () => {
  const live = (streak, lastWon, today) => ppn.ppnLiveStreak({ streak, lastWon }, today);
  assert.equal(live(3, 5, 5), 3);
  assert.equal(live(3, 4, 5), 3);
  assert.equal(live(3, 3, 5), 0, 'a missed day');
  assert.equal(live(3, 6, 5), 0, 'a win from the future (a clock set back)');
  assert.equal(live(3, null, 5), 0);
  assert.deepEqual([0, 9, 59, 60, 102, 3599, 3665].map(ppn.ppnFormatTime), ['0:00', '0:09', '0:59', '1:00', '1:42', '59:59', '61:05']);
  assert.equal(ppn.ppnShareText(5, 7, 102, 31, 24), 'Patch Panel #5 7x7 1:42 31 rotations (target 24)');
  assert.equal(ppn.ppnShareText(128, 7, 59, 1, 2), 'Patch Panel #128 7x7 0:59 1 rotation (target 2)');
});

test('patch-panel: of two tabs\' Daily records the later Daily up to today, the solved one or the attempt further along wins', () => {
  const rec = (key, status, moves, elapsed) => ({ key, day: key === null ? 0 : ppn.ppnKeyDay(key), status, game: key === null ? null : { moves, elapsed } });
  const ours = rec(KEY5, 'playing', 10, 60000);
  const newer = (stored, mine = ours, elapsed = 60000, today = 5) => ppn.ppnIsNewerDaily(stored, mine, elapsed, today);
  assert.equal(newer(rec(null, 'playing')), false, 'nothing stored');
  assert.equal(newer(rec('2026-11-04', 'won', 99, 999999)), false, 'yesterday\'s');
  assert.equal(newer(rec(KEY6, 'playing', 0, 0)), false, 'from after today: a clock set back');
  assert.equal(newer(rec(KEY6, 'playing', 0, 0), ours, 60000, 6), true, 'tomorrow\'s, once it is today');
  assert.equal(newer(rec('2026-11-04', 'won', 1, 1), rec(null, 'playing')), true, 'any Daily up to today beats none');
  assert.equal(newer(rec(KEY5, 'won', 1, 1)), true, 'the same Daily solved');
  assert.equal(newer(rec(KEY5, 'playing', 99, 999999), rec(KEY5, 'won', 5, 5)), false, 'ours is solved');
  assert.equal(newer(rec(KEY5, 'playing', 11, 1000)), true, 'more rotations');
  assert.equal(newer(rec(KEY5, 'playing', 9, 999999)), false, 'fewer rotations');
  assert.equal(newer(rec(KEY5, 'playing', 10, 60001)), true, 'as many rotations and more time');
  assert.equal(newer(rec(KEY5, 'playing', 10, 60000)), false, 'the same');
  assert.equal(newer(rec(KEY5, 'playing', 10, 61000), ours, 62000), false, 'our clock has run on further');
});

test('patch-panel: keys map to actions by their value, then by the physical key on other layouts', () => {
  const action = (key, code) => ppn.ppnKeyAction(keyEvent(key, code ? { code } : {}));
  assert.deepEqual(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter', 'q', 'Q', 'l', 'L', 'n', 'N'].map((k) => action(k)),
    ['up', 'down', 'left', 'right', 'rotate', 'rotate', 'back', 'back', 'lock', 'lock', 'new', 'new']);
  assert.equal(action('й', 'KeyQ'), 'back');
  assert.equal(action('д', 'KeyL'), 'lock');
  assert.equal(action('т', 'KeyN'), 'new');
  assert.equal(action('x'), null);
  assert.equal(action('Tab'), null);
  assert.equal(action('ф', 'KeyA'), null);
  assert.equal(ppn.ppnKeyAction(keyEvent(undefined)), null, 'an autofill keydown has no key');
  assert.deepEqual(CONFIGS.map(ppn.ppnConfigOf), [
    { n: 5, wrap: false }, { n: 7, wrap: false }, { n: 9, wrap: false },
    { n: 5, wrap: true }, { n: 7, wrap: true }, { n: 9, wrap: true }
  ]);
  assert.deepEqual(ppn.ppnConfigOf('11w'), { n: 5, wrap: true });
  assert.deepEqual(ppn.ppnConfigOf('x'), { n: 5, wrap: false });
});

// ── Saves (pure) ─────────────────────────────────────────────────────────────

test('patch-panel: ppnParseState reads a save of the current format field for field', () => {
  const parsed = ppn.ppnParseState(SAMPLE_SAVE);
  const raw = JSON.parse(SAMPLE_SAVE);
  assert.equal(parsed.view, 'free');
  assert.equal(parsed.n, 5);
  assert.equal(parsed.wrap, false);
  assert.deepEqual(parsed.game, {
    n: 5, wrap: false, masks: raw.masks, start: raw.start, turns: raw.turns, locks: raw.locks,
    moves: 7, elapsed: 12345, practice: null, replay: false, solved: false
  });
  assert.equal(ppn.ppnParseState(SAMPLE_SAVE.replace('"replay":false', '"replay":true')).game.replay, true);
  const solvedSave = boardSave(ppn.ppnGenerate(9, seeded(4), true), { view: 'daily', practice: 12, moves: 40, elapsed: 99000 });
  solvedSave.turns = solvedSave.masks.map(() => 0);
  const solved = ppn.ppnParseState(JSON.stringify(solvedSave));
  assert.equal(solved.view, 'daily');
  assert.equal(solved.n, 9);
  assert.equal(solved.wrap, true);
  assert.equal(solved.game.solved, true);
  assert.equal(solved.game.practice, 12);
  assert.equal(solved.game.moves, 40);
  // The parsed arrays are copies.
  solved.game.turns[0] = 3;
  assert.equal(solvedSave.turns[0], 0);
});

test('patch-panel: ppnParseState falls back field by field', () => {
  const board = ppn.ppnGenerate(7, seeded(5), false);
  // A deep copy every time, so an edit (masks.pop()) never reaches the board.
  const good = () => JSON.parse(JSON.stringify(boardSave(board, { turns: board.start.map((x, i) => (i === 3 ? (x + 1) % 4 : x)), locks: board.masks.map((m, i) => (i === 8 ? 1 : 0)), moves: 9, elapsed: 4321, practice: 3 })));
  const parse = (fn) => {
    const save = good();
    fn(save);
    return ppn.ppnParseState(JSON.stringify(save));
  };
  const base = parse(() => {});
  assert.equal(base.game.moves, 9);

  let p = parse((s) => { delete s.start; });
  assert.deepEqual(p.game.start, good().turns, 'no start: the turns are the start');
  assert.notEqual(p.game.start, p.game.turns);
  p = parse((s) => { s.turns = 'x'; });
  assert.deepEqual(p.game.turns, board.start, 'no turns: the board is at its start');
  p.game.turns[0] = 9;
  assert.notEqual(p.game.start[0], 9, 'turns and start are separate arrays');
  for (const locks of ['x', [1, 0], new Array(49).fill(2), new Array(49).fill('1'), new Array(49).fill(true)]) {
    assert.deepEqual(parse((s) => { s.locks = locks; }).game.locks, new Array(49).fill(0));
  }
  for (const bad of [-1, 1.5, '9', null, Infinity]) {
    assert.equal(parse((s) => { s.moves = bad; }).game.moves, 0, 'moves ' + bad);
    assert.equal(parse((s) => { s.elapsed = bad; }).game.elapsed, 0, 'elapsed ' + bad);
  }
  assert.equal(parse((s) => { s.practice = '3'; }).game.practice, null);
  assert.equal(parse((s) => { s.practice = 1.5; }).game.practice, null);
  assert.equal(parse((s) => { s.practice = -2; }).game.practice, -2, 'a Daily before #1 (a clock set back) is still a number');
  for (const replay of [undefined, 'true', 1, null]) {
    assert.equal(parse((s) => { s.replay = replay; }).game.replay, false, 'replay ' + replay + ': a scored game');
  }
  for (const n of [undefined, '7', 6, null]) assert.equal(parse((s) => { s.n = n; }).n, 7, 'n from the masks: ' + n);
  assert.equal(parse((s) => { s.n = 9; }).game, null, 'n that does not match the masks');
  assert.equal(parse((s) => { s.n = 9; }).n, 9);
  assert.equal(parse((s) => { delete s.n; s.masks = 'x'; }).n, 5, 'neither: the default size');
  assert.equal(parse((s) => { delete s.n; s.masks.pop(); }).n, 5);
  assert.equal(parse((s) => { s.view = 'Daily'; }).view, 'free');
  // A missing or broken wrap flag is worked out from the board.
  assert.equal(parse((s) => { delete s.wrap; }).game.wrap, false);
  const wrapped = boardSave(ppn.ppnGenerate(5, seeded(25), true));
  assert.equal(ppn.ppnParseState(JSON.stringify(Object.assign({}, wrapped, { wrap: 'yes' }))).game.wrap, true);
  assert.equal(ppn.ppnParseState(JSON.stringify(Object.assign({}, wrapped, { wrap: false }))).game, null, 'a wrap board without wrap leaves cables open');
  assert.equal(ppn.ppnParseState(JSON.stringify(Object.assign({}, wrapped, { masks: 'x', wrap: true }))).wrap, true, 'the board asked for');
  assert.equal(ppn.ppnParseState(JSON.stringify(Object.assign({}, wrapped, { masks: 'x', wrap: 1 }))).wrap, false);
});

// Saves that hold no playable game, as stored text, by what is wrong with them.
function corruptStates() {
  const good = boardSave(ppn.ppnGenerate(5, seeded(3), false));
  const edit = (fn) => {
    const save = JSON.parse(JSON.stringify(good));
    fn(save);
    return JSON.stringify(save);
  };
  return {
    'empty text': '',
    'broken JSON': '{"masks":',
    'null': 'null',
    'a number': '42',
    'a string': '"x"',
    'an array': '[]',
    'an empty object': '{}',
    'no masks': edit((s) => { delete s.masks; }),
    'masks of the wrong length': edit((s) => { s.masks.pop(); }),
    'a mask that is text': edit((s) => { s.masks[3] = String(s.masks[3]); }),
    'a tile without links': edit((s) => { s.masks[3] = 0; }),
    'a mask above 15': edit((s) => { s.masks[3] = 16; }),
    'a fractional mask': edit((s) => { s.masks[3] += 0.5; }),
    'masks that are not a tree': edit((s) => { s.masks = s.masks.map(() => 15); }),
    'a cable off the board': edit((s) => { s.masks[0] |= 1; }),
    'a cable off the board and no wrap flag': edit((s) => { s.masks[0] |= 1; delete s.wrap; }),
    'neither turns nor start': edit((s) => { delete s.turns; delete s.start; }),
    'turns and start out of range': edit((s) => { s.turns[0] = 4; s.start[0] = -1; }),
    'a wrap board marked without wrap': JSON.stringify(boardSave(ppn.ppnGenerate(5, seeded(25), true), { wrap: false }))
  };
}

test('patch-panel: ppnParseState finds no game in saves that cannot be played', () => {
  for (const [name, text] of Object.entries(corruptStates())) {
    const parsed = ppn.ppnParseState(text);
    assert.equal(parsed.game, null, name);
    assert.ok([5, 7, 9].includes(parsed.n), name);
  }
  assert.equal(ppn.ppnParseState(null).game, null, 'no save at all');
  assert.deepEqual(ppn.ppnParseState(null), { view: 'free', n: 5, wrap: false, game: null });
});

test('patch-panel: ppnParseDaily keeps the attempt, its result and the streak, each field on its own', () => {
  const board = ppn.ppnDailyBoard(KEY5);
  const zeros = new Array(49).fill(0);
  const save = (extra) => JSON.stringify(Object.assign({
    v: 1, key: KEY5, day: 5, status: 'playing', turns: board.start, locks: zeros, moves: 3, elapsed: 7000, time: 0, streak: 2, lastWon: 4
  }, extra));
  const playing = ppn.ppnParseDaily(save());
  assert.equal(playing.key, KEY5);
  assert.equal(playing.day, 5);
  assert.equal(playing.status, 'playing');
  assert.deepEqual(playing.game, {
    n: 7, wrap: false, masks: board.masks, start: board.start, turns: board.start, locks: zeros,
    moves: 3, elapsed: 7000, practice: null, replay: false, solved: false
  });
  assert.equal(ppn.ppnParseDaily(save({ replay: true, practice: 4 })).game.replay, false, 'the Daily attempt is always scored');
  assert.equal(playing.streak, 2);
  assert.equal(playing.lastWon, 4);
  assert.equal(ppn.ppnParseDaily(save({ day: 99 })).day, 5, 'the number comes from the key');

  // A finished attempt: its time, or the clock when the time is broken; the
  // solution on screen when its turns are not solved.
  const won = ppn.ppnParseDaily(save({ status: 'won', turns: zeros, time: 102, moves: 31 }));
  assert.equal(won.status, 'won');
  assert.equal(won.time, 102);
  assert.equal(won.game.solved, true);
  assert.equal(ppn.ppnParseDaily(save({ status: 'won', time: 'x' })).time, 7);
  const unsolved = ppn.ppnParseDaily(save({ status: 'won' }));
  assert.deepEqual(unsolved.game.turns, zeros);
  assert.equal(unsolved.game.solved, true);
  // An unfinished attempt whose turns are solved goes back to its scramble.
  const odd = ppn.ppnParseDaily(save({ turns: zeros }));
  assert.equal(odd.status, 'playing');
  assert.deepEqual(odd.game.turns, board.start);
  assert.equal(odd.game.solved, false);
  assert.equal(ppn.ppnParseDaily(save({ status: 'lost' })).status, 'playing');
  assert.deepEqual(ppn.ppnParseDaily(save({ turns: [1, 2] })).game.turns, board.start);
  assert.equal(ppn.ppnParseDaily(save({ moves: -1, elapsed: 'x' })).game.moves, 0);

  // Without a valid key there is no attempt, but the streak stays.
  for (const key of [undefined, '2026-11-31', 5, null]) {
    const none = ppn.ppnParseDaily(save({ key }));
    assert.deepEqual(none, { key: null, day: 0, status: 'playing', game: null, time: 0, streak: 2, lastWon: 4 }, String(key));
  }
  for (const text of [null, '', '{', '[]', '7', 'null']) {
    assert.deepEqual(ppn.ppnParseDaily(text), { key: null, day: 0, status: 'playing', game: null, time: 0, streak: 0, lastWon: null }, String(text));
  }
  const broken = ppn.ppnParseDaily(save({ streak: -1, lastWon: 'x' }));
  assert.equal(broken.streak, 0);
  assert.equal(broken.lastWon, null);
  assert.equal(ppn.ppnParseDaily(save({ lastWon: 2.5 })).lastWon, null);
  assert.equal(ppn.ppnParseDaily(save({ lastWon: -3 })).lastWon, -3);
});

test('patch-panel: ppnParseBest keeps a whole-second time and a rotation count per board, each on its own', () => {
  const none = { time: null, moves: null };
  assert.deepEqual(ppn.ppnParseBest(null), Object.fromEntries(CONFIGS.map((k) => [k, none])));
  assert.deepEqual(ppn.ppnParseBest('[1]'), Object.fromEntries(CONFIGS.map((k) => [k, none])));
  const parsed = ppn.ppnParseBest(JSON.stringify({ 5: { time: 42, moves: 30 }, 7: { time: -1, moves: 12 }, 9: 'x', '5w': { time: 61.5, moves: '9' }, '9w': { time: 0, moves: 0 }, x: { time: 1 } }));
  assert.deepEqual(parsed, {
    5: { time: 42, moves: 30 }, 7: { time: null, moves: 12 }, 9: none, '5w': none, '7w': none, '9w': { time: 0, moves: 0 }
  });
  // Two tabs' records merge board by board and field by field, keeping the lower of each.
  const other = ppn.ppnParseBest(JSON.stringify({ 5: { time: 50, moves: 20 }, 7: { time: 8 }, 9: { time: 5, moves: 9 }, '9w': { time: 0, moves: 3 } }));
  const merged = ppn.ppnMergeBest(parsed, other);
  assert.deepEqual(merged, {
    5: { time: 42, moves: 20 }, 7: { time: 8, moves: 12 }, 9: { time: 5, moves: 9 }, '5w': none, '7w': none, '9w': { time: 0, moves: 0 }
  });
  assert.deepEqual(ppn.ppnMergeBest(other, parsed), merged, 'in either order');
});

// ── The page ─────────────────────────────────────────────────────────────────

test('patch-panel: loading the script under Node runs no init: no lookup, listener, timer or save', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.ppnInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['ppn-board'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('patch-panel: a first visit shows a 5x5 board around the switch, its stats and status, and saves it', (t) => {
  const { clock, v } = openPage(t);
  const board = ppn.ppnGenerate(5, seeded(1), false);
  assert.deepEqual(storedKeys(), [STATE_KEY], 'no Daily attempt before the Daily is opened');
  const saved = v.state();
  assert.deepEqual(saved, boardSave(board));
  assert.equal(v.tiles().length, 25);
  assert.equal(v.board.style.gridTemplateColumns, 'repeat(5, var(--ppn-tile))');
  assert.equal(v.board.className, 'ppn-board ppn-board--n5');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-12');

  const cur = current(board.masks, board.start);
  const links = linksOf(cur, 5, false);
  const up = reach(links.edges, 12);
  assert.equal(cycleCells(cur, 5, false).size, 0);
  // Without a loop each lit tile has one link one step closer to the switch: its uplink.
  const dist = distances(cur, 5, false);
  const uplinkOf = (i) => [0, 1, 2, 3].find((d) => (cur[i] & (1 << d)) && dist[step(5, false, i, d)] === dist[i] - 1 &&
    links.edges.some(([a, b]) => a === Math.min(i, step(5, false, i, d)) && b === Math.max(i, step(5, false, i, d))));
  let uplinkArms = 0;
  v.tiles().forEach((tile, i) => {
    assert.equal(tile.id, 'ppn-tile-' + i);
    assert.equal(tile.getAttribute('data-index'), String(i));
    assert.equal(tile.getAttribute('role'), 'button');
    assert.equal(tile.className, 'ppn-tile' + (up.has(i) ? ' ppn-tile--up' : '') + (i === 12 ? ' ppn-tile--cursor' : ''), 'tile ' + i);
    const shape = ppn.ppnShape(board.masks[i], i, 5);
    assert.equal(tile.getAttribute('aria-label'), ppn.ppnCellName(i, 5) + ' ' + shape + ', ' + (up.has(i) ? 'link up' : 'link down'));
    // The cable layer: one arm per generated link and a hub, turned by the scramble.
    // An arm is open when nobody answers it now, and the uplink when it now points back toward the switch.
    const cable = tile.children[0];
    assert.equal(cable.className, 'ppn-cable');
    assert.equal(cable.style.transform, 'rotate(' + board.start[i] * 90 + 'deg)');
    const uplink = up.has(i) && i !== 12 ? uplinkOf(i) : undefined;
    assert.deepEqual(cable.children.map((el) => el.className),
      dirsOf(board.masks[i]).map((d) => {
        const now = (d + board.start[i]) % 4;
        const open = links.open.some((end) => end.index === i && end.dir === 1 << now);
        return 'ppn-arm ' + ['ppn-arm-n', 'ppn-arm-e', 'ppn-arm-s', 'ppn-arm-w'][d] + (open ? ' ppn-arm--open' : '') + (now === uplink ? ' ppn-arm--uplink' : '');
      }).concat('ppn-hub'), 'tile ' + i);
    uplinkArms += cable.children.filter((el) => /ppn-arm--uplink/.test(el.className)).length;
    // The switch and the end devices sit on top, upright.
    const node = tile.children[1];
    if (i === 12) assert.equal(node.className, 'ppn-node ppn-node-switch');
    else if (dirsOf(board.masks[i]).length === 1) assert.equal(node.className, 'ppn-node ppn-node-' + { server: 'server', NAS: 'nas', 'access point': 'ap' }[shape]);
    else assert.equal(node, undefined);
  });
  assert.equal(uplinkArms, up.size - 1, 'one uplink per lit tile but the switch');

  assert.equal(v.text('ports'), up.size + '/25');
  assert.equal(v.text('moves'), '0');
  assert.equal(v.text('target'), String(targetModel(board.masks, board.start)));
  assert.equal(v.text('time'), '0:00');
  assert.equal(v.text('best'), '--');
  assert.equal(v.text('streak'), '0');
  assert.equal(v.text('mode'), 'Free play · 5x5');
  assert.equal(v.text('status'), 'Ports up ' + up.size + '/25, open cable ends: ' + links.open.length + '.');
  const hex = cur[12].toString(16).toUpperCase();
  assert.equal(v.text('hint'), 'C3 switch: mask 0x' + hex + ' (' + dirsOf(cur[12]).map((d) => 'NESW'[d]).join(' ') + ')');
  assert.equal(v.text('daily-button'), 'Daily #5');
  assert.equal(v.el('daily-button').getAttribute('aria-label'), 'Open Daily #5');
  assert.equal(v.text('restart'), 'Restart');
  assert.equal(v.text('lock-mode'), 'Lock mode: off');
  assert.equal(v.el('lock-mode').getAttribute('aria-pressed'), 'false');
  assert.equal(v.el('config').value, '5');
  assert.equal(v.hidden('share'), true);
  assert.equal(v.hidden('next'), true);
  assert.equal(v.hidden('warning'), true);
  assert.equal(v.toast(), null);
  assert.equal(v.board.getAttribute('aria-label'), 'Patch panel 5x5: ' + up.size + ' of 25 ports up');

  // One listener per control; only storage on window; keys only on the board.
  for (const [name, type] of [['board', 'pointerdown'], ['board', 'click'], ['board', 'contextmenu'], ['board', 'keydown'], ['new-game', 'click'], ['restart', 'click'],
    ['config', 'change'], ['daily-button', 'click'], ['lock-mode', 'click'], ['share-button', 'click'], ['next', 'click']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(document), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(document.body), 0);
  assert.equal(listenerCount(window), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  clock.advance(5000);
  assert.equal(v.text('time'), '0:00', 'no clock before the first rotation');
});

test('patch-panel: while the page is still loading the game waits for DOMContentLoaded', (t) => {
  const { v } = openPage(t, { storage: { state: SAMPLE_SAVE }, options: { readyState: 'loading' } });
  assert.equal(v.tiles().length, 0);
  assert.equal(v.text('status'), 'Booting the rack...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(v.board, 'click'), 0);
  v.ready();
  assert.equal(v.tiles().length, 25);
  assert.equal(v.text('moves'), '7');
  assert.equal(listenerCount(v.board, 'click'), 1);
});

test('patch-panel: init runs once: a second call binds nothing twice', (t) => {
  makeClock(t);
  const { exports: fresh, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  fresh.ppnInit();
  const saved = localStorage.getItem(STATE_KEY);
  fresh.ppnInit();
  assert.equal(localStorage.getItem(STATE_KEY), saved);
  assert.equal(listenerCount(els['ppn-board'], 'click'), 1);
  assert.equal(listenerCount(els['ppn-board'], 'keydown'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(fresh.ppnRuntime.els.board, els['ppn-board']);
});

test('patch-panel: a tap turns a tile clockwise, counts a rotation, animates the short way round and saves', (t) => {
  const { v } = openPage(t);
  const start = v.state().turns;
  v.tap(0);
  assert.equal(v.state().turns[0], (start[0] + 1) % 4);
  assert.equal(v.state().moves, 1);
  assert.equal(v.text('moves'), '1');
  assert.equal(v.angle(0), (start[0] + 1) * 90);
  for (let k = 0; k < 3; k++) v.tap(0);
  assert.equal(v.state().turns[0], start[0], 'four taps bring it round');
  assert.equal(v.angle(0), (start[0] + 4) * 90, 'the cable layer keeps turning clockwise instead of spinning back');
  assert.equal(v.state().moves, 4);
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-0', 'the tapped tile takes the cursor');
  assert.match(v.text('hint'), /^A1 /);
  // A tap on a cable inside the tile counts as a tap on the tile.
  v.tile(6).children[0].children[0].click();
  assert.equal(v.state().moves, 5);
  assert.equal(v.state().turns[6], (start[6] + 1) % 4);
  // The board's own padding is no tile.
  v.board.click();
  assert.equal(v.state().moves, 5);
  assert.equal(fire(v.board, 'contextmenu').defaultPrevented, false, 'the menu stays on the padding');
});

test('patch-panel: a right-click or Lock mode locks a tile, and a locked tile refuses to turn, naming itself', (t) => {
  const { v } = openPage(t);
  const ev = v.rightClick(3);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(v.has(3, 'ppn-tile--locked'), true);
  assert.deepEqual(v.state().locks, v.state().masks.map((m, i) => (i === 3 ? 1 : 0)));
  assert.match(v.tile(3).getAttribute('aria-label'), /, locked$/);
  assert.match(v.text('hint'), /^D1 .*, locked$/);
  v.tap(3);
  assert.equal(v.state().moves, 0);
  assert.equal(v.toast(), 'D1 is locked: unlock it with L, a right-click or Lock mode.');
  v.rightClick(3);
  assert.equal(v.has(3, 'ppn-tile--locked'), false);
  assert.equal(v.state().locks[3], 0);

  // Lock mode: taps lock instead of turning, the button says so.
  v.click('lock-mode');
  assert.equal(v.text('lock-mode'), 'Lock mode: on');
  assert.equal(v.el('lock-mode').getAttribute('aria-pressed'), 'true');
  assert.match(v.board.className, /\bppn-board--lockmode\b/);
  v.tap(7);
  v.tap(8);
  v.tap(8);
  assert.equal(v.state().moves, 0);
  assert.deepEqual(v.state().locks.map((x, i) => (x ? i : -1)).filter((i) => i !== -1), [7]);
  v.click('lock-mode');
  assert.equal(v.text('lock-mode'), 'Lock mode: off');
  assert.doesNotMatch(v.board.className, /lockmode/);
  v.tap(8);
  assert.equal(v.state().moves, 1);

  // A long press of a finger (Android follows it with a contextmenu) keeps the menu away but locks
  // nothing; a tap still turns.  A right-click of a mouse or a pen locks.
  fire(v.tile(2), 'pointerdown', { pointerType: 'touch' });
  assert.equal(v.rightClick(2).defaultPrevented, true);
  assert.equal(v.state().locks[2], 0);
  assert.equal(v.has(2, 'ppn-tile--locked'), false);
  fire(v.tile(2), 'pointerdown', { pointerType: 'touch' });
  v.tap(2);
  assert.equal(v.state().moves, 2);
  fire(v.tile(2), 'pointerdown', { pointerType: 'mouse' });
  v.rightClick(2);
  assert.equal(v.state().locks[2], 1, 'a mouse right-click locks');
  fire(v.tile(2), 'pointerdown', { pointerType: 'pen' });
  v.rightClick(2);
  assert.equal(v.state().locks[2], 0, 'a pen right-click unlocks');
});

test('patch-panel: keys work only while the board has the focus: arrows, Space / Enter, Q, L and N', (t) => {
  const { v } = openPage(t);
  const start = v.state().turns;
  let ev = v.press('ArrowUp');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-7');
  assert.equal(v.has(7, 'ppn-tile--cursor'), true);
  assert.equal(v.has(12, 'ppn-tile--cursor'), false);
  assert.match(v.board.className, /\bppn-board--keys\b/);
  for (let k = 0; k < 5; k++) v.press('ArrowLeft');
  for (let k = 0; k < 5; k++) v.press('ArrowUp', { repeat: true });
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-0', 'the cursor stops at the edges; held arrows repeat');
  v.press('ArrowDown');
  v.press('ArrowRight');
  v.press('ArrowLeft');
  v.press('ArrowUp');
  ev = v.press(' ');
  assert.equal(ev.defaultPrevented, true, 'Space never scrolls the page from the board');
  v.press('Enter');
  v.press('q');
  assert.equal(v.state().turns[0], (start[0] + 1) % 4);
  assert.equal(v.state().moves, 3);
  v.press('й', { code: 'KeyQ' });
  assert.equal(v.state().turns[0], start[0]);
  assert.equal(v.state().moves, 4);
  // A held Space or L acts once.
  ev = v.press(' ', { repeat: true });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(v.state().moves, 4);
  v.press('l');
  assert.equal(v.state().locks[0], 1);
  v.press('L', { repeat: true });
  assert.equal(v.state().locks[0], 1);
  v.press(' ');
  assert.equal(v.toast(), 'A1 is locked: unlock it with L, a right-click or Lock mode.');
  v.press('д', { code: 'KeyL' });
  assert.equal(v.state().locks[0], 0);

  // Shortcuts, composing text, keys a page script handled and other keys stay with the browser.
  const before = localStorage.getItem(STATE_KEY);
  for (const props of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    for (const key of [' ', 'ArrowRight', 'n', 'l']) {
      assert.equal(v.press(key, props).defaultPrevented, false, key + ' ' + JSON.stringify(props));
    }
  }
  assert.equal(v.press('x').defaultPrevented, false);
  assert.equal(v.press('Tab').defaultPrevented, false);
  assert.equal(v.press(undefined).defaultPrevented, false);
  const handled = (event) => event.preventDefault();
  document.addEventListener('keydown', handled, true);
  v.press(' ');
  document.removeEventListener('keydown', handled, true);
  // Keys typed into host-page fields, links and buttons never reach the board.
  const input = v.page.add('host-input', 'input');
  const link = v.page.add('host-link', 'a');
  const button = v.page.add('host-button', 'button');
  for (const target of [input, link, button, document.body]) {
    for (const key of ['ArrowLeft', ' ', 'q', 'n']) assert.equal(pressKey(key, { target }).defaultPrevented, false);
  }
  assert.equal(localStorage.getItem(STATE_KEY), before);
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-0');

  // A tap hides the keyboard cursor again; N starts a new board of the chosen size.
  v.tap(4);
  assert.doesNotMatch(v.board.className, /ppn-board--keys/);
  const masks = v.state().masks;
  v.press('n');
  assert.notDeepEqual(v.state().masks, masks);
  assert.equal(v.state().moves, 0);
  assert.equal(v.tiles().length, 25);
  v.choose('7');
  v.press('т', { code: 'KeyN' });
  assert.equal(v.state().n, 7);
  assert.equal(listenerCount(v.board, 'keydown'), 1);
});

test('patch-panel: on a wrap board the cursor wraps round the edges like the cables', (t) => {
  const { v } = openPage(t);
  v.choose('5w');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-12');
  for (let k = 0; k < 3; k++) v.press('ArrowUp');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-22');
  v.press('ArrowRight');
  v.press('ArrowRight');
  v.press('ArrowRight');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-20');
  assert.match(v.board.className, /\bppn-board--wrap\b/);
  assert.equal(v.text('mode'), 'Free play · 5x5 wrap');
});

test('patch-panel: a wrap board marks each crossing of its rim, outlines the tile across from the cursor and explains the wrap', (t) => {
  const { v, clock } = openPage(t);
  const n = 5;
  const twins = () => v.tiles().map((tile, i) => (tile.classList.contains('ppn-tile--twin') ? i : -1)).filter((i) => i !== -1);
  const hintKeepsTwoLines = () => v.el('hint').classList.contains('ppn-hint--wrap');
  // A board without wrap: no rim, no note, no outline.
  assert.deepEqual(v.rim(), []);
  assert.equal(v.hidden('wrap-note'), true);
  assert.equal(hintKeepsTwoLines(), false);
  v.tap(0);
  assert.deepEqual(twins(), []);
  assert.doesNotMatch(v.text('hint'), /wraps/);

  v.choose('5w');
  assert.equal(v.hidden('wrap-note'), false);
  assert.equal(hintKeepsTwoLines(), true);
  assert.match(v.text('wrap-note'), /opposite edges join/);
  assert.match(v.text('wrap-note'), /faint where no cable crosses/);
  const rim = v.rim();
  assert.equal(rim.length, 4 * n);
  assert.equal(v.board.children.length, n * n + 4 * n);
  assert.deepEqual(v.board.children.slice(n * n), rim, 'the marks come after the tiles, whose indexes stay');
  // Each mark sits on its tile's grid cell (both lines given) on the side of its rim, hidden from screen readers.
  const cell = (i) => (Math.floor(i / n) + 1) + ' / ' + (Math.floor(i / n) + 2) + ' | ' + (i % n + 1) + ' / ' + (i % n + 2);
  const expected = crossingsModel(new Array(n * n).fill(0), n).flatMap((c) => c.axis === 'row' ?
    ['w ' + cell(c.a), 'e ' + cell(c.b)] : ['n ' + cell(c.a), 's ' + cell(c.b)]);
  assert.deepEqual(rim.map((m) => /\bppn-rim--([wens])\b/.exec(m.className)[1] + ' ' + m.style.gridRow + ' | ' + m.style.gridColumn), expected);
  for (const mark of rim) assert.equal(mark.getAttribute('aria-hidden'), 'true');

  // The looks follow the cables after every tap: turn the rim tiles round, then solve the board.
  const seen = new Set();
  const check = (label) => {
    const { page, model } = rimLooks(v, n);
    assert.deepEqual(page, model, label);
    model.forEach((look) => seen.add(look));
  };
  check('scrambled');
  for (const i of [0, 4, 10, 14, 20, 24, 2, 22]) {
    for (let k = 0; k < 4; k++) {
      v.tap(i);
      check('tile ' + i + ' turn ' + k);
    }
  }
  const s = v.state();
  solve(v, clock, s.masks, s.turns);
  assert.match(v.board.className, /\bppn-board--solved\b/);
  check('solved');
  assert.deepEqual([...seen].sort(), SEEN_LOOKS);

  // A rim tile and the tile across the rim from it share a dashed outline, and the hint says where the edge goes.
  v.click('new-game');
  v.tap(10);
  assert.deepEqual(twins(), [10, 14]);
  assert.match(v.text('hint'), /^A3 .* · wraps W→E3$/);
  v.tap(0);
  assert.deepEqual(twins(), [0, 4, 20]);
  assert.match(v.text('hint'), / · wraps W→E1, N→A5$/);
  v.tap(12);
  assert.deepEqual(twins(), []);
  assert.doesNotMatch(v.text('hint'), /wraps/);
  v.press('ArrowDown');
  v.press('ArrowDown');
  v.press('ArrowDown');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-2', 'the cursor wrapped round to C1');
  assert.deepEqual(twins(), [2, 22], 'C1 and C5 across the rim from it are outlined');

  // Back to a board without wrap: the rim and the note go.
  v.choose('7');
  assert.deepEqual(v.rim(), []);
  assert.equal(v.tiles().length, 49);
  assert.equal(v.hidden('wrap-note'), true);
  assert.equal(hintKeepsTwoLines(), false);
});

test('patch-panel: a loop closed across the rim shows red on the rim beside its red tiles, never green', (t) => {
  // The 5x5 wrap board of seeded(12) with C1 turned twice and D1 three times: the loop
  // C1-D1-D5-D4-D3-C3-C2 runs through the D1/D5 crossing, and C1 also links across to C5,
  // which stays on the switch's network.
  const board = ppn.ppnGenerate(5, seeded(12), true);
  const turns = new Array(25).fill(0);
  turns[2] = 2;
  turns[3] = 3;
  const save = { v: 1, view: 'free', n: 5, wrap: true, masks: board.masks, start: board.start, turns,
    locks: new Array(25).fill(0), moves: 5, elapsed: 1000, practice: null, replay: false };
  const { v } = openPage(t, { storage: { state: save } });
  assert.match(v.text('status'), /^Broadcast storm: a loop runs through 7 tiles\./);
  const { page, model } = rimLooks(v, 5);
  assert.deepEqual(page, model);
  const look = (side, line) => /\bppn-rim--(\w+)$/.exec(v.rim().find((m) =>
    m.classList.contains('ppn-rim--' + side) && m.style.gridColumn === line + ' / ' + (line + 1)).className)[1];
  // D1 / D5 (column 4): both tiles are in the loop, so both ends are red, as the tiles are.
  assert.equal(v.has(3, 'ppn-tile--storm') && v.has(23, 'ppn-tile--storm'), true);
  assert.deepEqual([look('n', 4), look('s', 4)], ['storm', 'storm']);
  // C1 / C5 (column 3): C1 is in the loop and C5 is live, so each end takes its own tile's colour.
  assert.equal(v.has(2, 'ppn-tile--storm') && v.has(22, 'ppn-tile--up'), true);
  assert.deepEqual([look('n', 3), look('s', 3)], ['storm', 'up']);
  assert.equal(page.filter((l) => l === 'up').length, 3, 'green only beside live tiles');
});

test('patch-panel: a live cable whose partner across the rim turned away shows amber on the rim, like an open end inside', (t) => {
  // The solved 5x5 wrap board of seeded(12) with A2 turned once: A2 no longer points west, and
  // E2, still on the switch's network, points east across the rim with nobody answering.
  const board = ppn.ppnGenerate(5, seeded(12), true);
  const turns = new Array(25).fill(0);
  turns[5] = 1;
  const save = { v: 1, view: 'free', n: 5, wrap: true, masks: board.masks, start: board.start, turns,
    locks: new Array(25).fill(0), moves: 1, elapsed: 1000, practice: null, replay: false };
  const { v } = openPage(t, { storage: { state: save } });
  const { page, model } = rimLooks(v, 5);
  assert.deepEqual(page, model);
  const east2 = v.rim().find((m) => m.classList.contains('ppn-rim--e') && m.style.gridRow === '2 / 3');
  assert.match(east2.className, /\bppn-rim--open\b/);
  assert.equal(v.has(9, 'ppn-tile--up'), true);
  assert.equal(v.tile(9).children[0].children.some((arm) => /\bppn-arm--open\b/.test(arm.className)), true,
    'E2\'s own arm is amber too');
  assert.deepEqual(page.filter((l) => l === 'open'), ['open']);
});

test('patch-panel: solving the board wins: status, toast, best time and rotations, a frozen board, and a reload keeps it', (t) => {
  const { clock, v } = openPage(t);
  const { masks, turns } = v.state();
  const taps = solve(v, clock, masks, turns, 61000);
  assert.equal(taps, targetModel(masks, turns));
  const saved = v.state();
  assert.equal(saved.moves, taps);
  assert.equal(solvedModel(current(saved.masks, saved.turns), 5, false), true);
  assert.equal(saved.elapsed, 61000);
  assert.equal(v.text('status'), 'Network converged: all 25 ports up in 1:01 with ' + taps + ' rotations (target ' + taps + '). Next rung: 7x7.');
  assert.equal(v.toast(), 'All 25 ports up: new best!');
  assert.deepEqual(v.best()['5'], { time: 61, moves: taps });
  assert.equal(v.text('best'), '1:01 / ' + taps);
  assert.equal(v.text('ports'), '25/25');
  assert.match(v.board.className, /\bppn-board--solved\b/);
  for (const tile of v.tiles()) assert.match(tile.className, /\bppn-tile--up\b/);
  assert.equal(v.tiles().flatMap((tile) => tile.children[0].children).filter((el) => /ppn-arm--open/.test(el.className)).length, 0);

  // Frozen: no turn, no lock (the menu is still kept away), the clock stopped.
  v.tap(0);
  v.press(' ');
  assert.equal(v.rightClick(1).defaultPrevented, true);
  v.press('l');
  assert.equal(v.state().moves, taps);
  assert.deepEqual(v.state().locks, new Array(25).fill(0));
  clock.advance(5000);
  assert.equal(v.text('time'), '1:01');

  const again = reload(clock, v);
  assert.equal(again.text('status'), v.text('status'));
  assert.equal(again.hidden('next'), false);
  assert.equal(again.text('next'), 'Next rung: 7x7');
  assert.match(again.board.className, /\bppn-board--solved\b/);
  assert.equal(again.text('time'), '1:01');
  again.tap(0);
  assert.equal(again.state().moves, taps);
  clock.advance(3000);
  assert.equal(again.text('time'), '1:01');
});

test('patch-panel: best keeps the fastest time and the fewest rotations of each board separately', (t) => {
  const { clock, v } = openPage(t, { storage: { best: { 5: { time: 30, moves: 999 }, 7: { time: 5, moves: 5 } } } });
  assert.equal(v.text('best'), '0:30 / 999');
  let { masks, turns } = v.state();
  const taps = solve(v, clock, masks, turns, 40000);
  assert.deepEqual(v.best()['5'], { time: 30, moves: taps }, 'fewer rotations, slower');
  assert.equal(v.toast(), 'All 25 ports up: new best!');
  // Another board, slower and with more rotations (full turns of A1 on top): no record.
  v.click('new-game');
  ({ masks, turns } = v.state());
  const padding = 4 * Math.max(0, Math.ceil((taps + 1 - targetModel(masks, turns)) / 4));
  for (let k = 0; k < padding; k++) v.tap(0);
  assert.ok(solve(v, clock, masks, turns, 50000) + padding > taps);
  assert.deepEqual(v.best()['5'], { time: 30, moves: taps });
  assert.equal(v.toast(), 'All 25 ports up.');
  // A third board, faster: a new best time.
  v.click('new-game');
  ({ masks, turns } = v.state());
  const fast = solve(v, clock, masks, turns, 10000);
  assert.deepEqual(v.best()['5'], { time: 10, moves: Math.min(taps, fast) });
  assert.equal(v.toast(), 'All 25 ports up: new best!');
  assert.deepEqual(v.best()['7'], { time: 5, moves: 5 }, 'other boards keep theirs');
  v.choose('7');
  assert.equal(v.text('best'), '0:05 / 5');
  v.choose('9');
  assert.equal(v.text('best'), '--');
});

test('patch-panel: a best with only a time or only a rotation count shows the other as --', (t) => {
  for (const [best, text] of [[{ time: 42 }, '0:42 / --'], [{ moves: 30 }, '-- / 30'], [{ time: 'x', moves: -1 }, '--']]) {
    resetStubs();
    const { v } = openPage(t, { storage: { best: { 5: best } } });
    assert.equal(v.text('best'), text);
  }
});

test('patch-panel: the board select, New Game and N start new boards of every size, with or without wrap', (t) => {
  const { v } = openPage(t);
  for (const value of CONFIGS) {
    const { n, wrap } = ppn.ppnConfigOf(value);
    v.choose(value);
    assert.equal(v.tiles().length, n * n, value);
    assert.equal(v.state().n, n);
    assert.equal(v.state().wrap, wrap);
    assert.equal(solvedModel(v.state().masks, n, wrap), true);
    assert.equal(v.board.className, 'ppn-board ppn-board--n' + n + (wrap ? ' ppn-board--wrap' : ''));
    assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-' + centre(n));
    assert.equal(v.text('mode'), 'Free play · ' + n + 'x' + n + (wrap ? ' wrap' : ''));
  }
  // New Game reads the select, even without a change event.
  v.el('config').value = '7';
  v.click('new-game');
  assert.equal(v.state().n, 7);
  assert.equal(v.state().wrap, false);
  const masks = v.state().masks;
  v.click('new-game');
  assert.notDeepEqual(v.state().masks, masks);
  for (let k = 0; k < 3; k++) {
    v.click('new-game');
    v.choose('9w');
    v.press('n');
  }
  assert.equal(listenerCount(v.board, 'click'), 1);
  assert.equal(listenerCount(v.board, 'keydown'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
});

test('patch-panel: Restart puts the same board back to its scramble; once a tile was turned the run is a replay that sets no best', (t) => {
  const { clock, v } = openPage(t);
  const first = v.state();
  // Nothing turned yet: the same scored board, the lock cleared, no toast.
  v.rightClick(9);
  v.click('restart');
  assert.deepEqual(v.state(), boardSave(first));
  assert.equal(v.toast(), null);
  assert.equal(v.text('mode'), 'Free play · 5x5');

  // Tiles turned (the board is known now): a replay, said in the toast, the mode and the status.
  v.tap(0);
  v.tap(5);
  v.rightClick(9);
  clock.advance(4000);
  v.click('restart');
  assert.deepEqual(v.state(), boardSave(first, { replay: true }));
  assert.equal(v.text('time'), '0:00');
  assert.equal(v.text('moves'), '0');
  assert.equal(v.has(9, 'ppn-tile--locked'), false);
  assert.equal(v.angle(0), first.start[0] * 90);
  assert.equal(v.toast(), 'Replay of this 5x5 board: not scored. New Game deals a scored one.');
  assert.equal(v.text('mode'), 'Replay · 5x5');
  assert.match(v.text('status'), /^Ports up \d+\/25, open cable ends: \d+\. Replay, not scored\.$/);
  clock.advance(3000);
  assert.equal(v.text('time'), '0:00', 'the clock waits for the next rotation');

  // Replayed from memory in 2 s: no best, but the ladder is still offered.
  const taps = solve(v, clock, first.masks, first.start, 2000);
  assert.equal(v.toast(), 'All 25 ports up.');
  assert.equal(v.best(), null, 'ppn-best is not even written');
  assert.equal(v.text('best'), '--');
  assert.equal(v.text('status'), 'Network converged: all 25 ports up in 0:02 with ' + taps + ' rotations (target ' + taps + '). Replay, not scored. Next rung: 7x7.');
  assert.equal(v.hidden('next'), false);

  // A reload keeps it a replay, and so does a Restart of the solved replay.
  const again = reload(clock, v);
  assert.equal(again.text('mode'), 'Replay · 5x5');
  again.click('restart');
  assert.equal(again.state().replay, true);
  solve(again, clock, first.masks, first.start);
  assert.equal(again.best(), null);
  // New Game deals a scored board again.
  again.click('new-game');
  assert.equal(again.state().replay, false);
  assert.equal(again.text('mode'), 'Free play · 5x5');
  const next = again.state();
  const won = solve(again, clock, next.masks, next.turns, 1000);
  assert.deepEqual(again.best()['5'], { time: 1, moves: won });
});

test('patch-panel: a win offers the next rung of the ladder, 5x5 to 9x9 and then the same with wrap', (t) => {
  assert.deepEqual(CONFIGS.map((value) => {
    const { n, wrap } = ppn.ppnConfigOf(value);
    return ppn.ppnNextRung(n, wrap);
  }), [{ n: 7, wrap: false }, { n: 9, wrap: false }, { n: 5, wrap: true }, { n: 7, wrap: true }, { n: 9, wrap: true }, null]);

  const { clock, v } = openPage(t);
  const { masks, turns } = v.state();
  solve(v, clock, masks, turns);
  assert.equal(v.hidden('next'), false);
  assert.equal(v.text('next'), 'Next rung: 7x7');
  assert.equal(v.el('next').getAttribute('aria-label'), 'Start a new 7x7 board, the next rung of the ladder');
  v.click('next');
  assert.equal(v.tiles().length, 49);
  assert.equal(v.state().n, 7);
  assert.equal(v.state().wrap, false);
  assert.equal(v.state().moves, 0);
  assert.equal(v.state().masks.length, 49);
  assert.equal(v.el('config').value, '7', 'the select follows, so New Game stays on the new rung');
  assert.equal(v.hidden('next'), true, 'not before this board is solved');
  assert.match(v.text('status'), /^Ports up /);

  // The top rung: no button, and a click on the hidden one does nothing.
  resetStubs();
  const top = ppn.ppnGenerate(9, seeded(8), true);
  const page = openPage(t, { storage: { state: boardSave(top, { turns: top.masks.map(() => 0), moves: 90, elapsed: 300000 }) } }).v;
  assert.equal(page.text('status'), 'Network converged: all 81 ports up in 5:00 with 90 rotations (target ' + targetModel(top.masks, top.start) + '). Top rung of the ladder.');
  assert.equal(page.hidden('next'), true);
  page.click('next');
  assert.deepEqual(page.state().masks, top.masks);
  assert.equal(page.tiles().length, 81);
});

test('patch-panel: the clock starts with the first rotation, stops in a hidden tab and after a reload, and never runs twice', (t) => {
  const { clock, v } = openPage(t);
  clock.advance(5000);
  v.tap(0);
  clock.advance(3000);
  assert.equal(v.text('time'), '0:03');
  assert.equal(v.state().elapsed, 3000, 'saved every second');
  v.tap(1);
  clock.advance(2000);
  assert.equal(v.text('time'), '0:05', 'one second per second');
  setVisibility('hidden', t);
  assert.equal(v.state().elapsed, 5000, 'saved when hidden');
  clock.advance(60000);
  setVisibility('visible', t);
  assert.equal(v.text('time'), '0:05');
  clock.advance(1000);
  assert.equal(v.text('time'), '0:06');

  const again = reload(clock, v);
  assert.equal(again.text('time'), '0:06');
  assert.match(again.text('status'), / Clock paused: it runs again with your next rotation\.$/);
  clock.advance(10000);
  assert.equal(again.text('time'), '0:06');
  again.tap(2);
  assert.doesNotMatch(again.text('status'), /Clock paused/);
  clock.advance(1000);
  assert.equal(again.text('time'), '0:07');
  // New Game stops the old clock; a tab hidden and shown with no clock running starts none.
  again.click('new-game');
  clock.advance(5000);
  assert.equal(again.text('time'), '0:00');
  setVisibility('hidden', t);
  setVisibility('visible', t);
  clock.advance(3000);
  assert.equal(again.text('time'), '0:00');
  assert.equal(again.state().elapsed, 0);
});

test('patch-panel: a newer toast keeps its full 2 s', (t) => {
  const { clock, v } = openPage(t);
  v.rightClick(0);
  v.tap(0);
  assert.notEqual(v.toast(), null);
  clock.advance(1500);
  v.tap(0);
  clock.advance(1999);
  assert.notEqual(v.toast(), null);
  clock.advance(1);
  assert.equal(v.toast(), null);
});

test('patch-panel: a loop lights up red as a broadcast storm, and dangling cables of the live network turn amber', (t) => {
  const board = ppn.ppnGenerate(5, seeded(25), true);
  const { v } = openPage(t, { storage: { state: boardSave(board) } });
  const cur = current(board.masks, board.start);
  const loop = [...cycleCells(cur, 5, true)].sort((a, b) => a - b);
  assert.equal(loop.length, 4);
  const storm = v.tiles().map((tile, i) => (tile.classList.contains('ppn-tile--storm') ? i : -1)).filter((i) => i !== -1);
  assert.deepEqual(storm, loop);
  for (const i of loop) {
    assert.match(v.tile(i).getAttribute('aria-label'), /, broadcast storm$/);
    assert.equal(v.has(i, 'ppn-tile--up'), false);
  }
  assert.equal(v.text('status'), 'Broadcast storm: a loop runs through 4 tiles. Turn one of the red tiles to break it.');
  const links = linksOf(cur, 5, true);
  const up = [...reach(links.edges, 12)].filter((i) => !loop.includes(i));
  assert.equal(v.text('ports'), up.length + '/25');
  // Each unanswered cable of a lit tile is marked on its arm, in the cable layer's own orientation.
  let marked = 0;
  v.tiles().forEach((tile, i) => {
    const arms = tile.children[0].children.slice(0, -1);
    dirsOf(board.masks[i]).forEach((d, k) => {
      const shown = turn(1 << d, board.start[i]);
      const open = links.open.some((end) => end.index === i && end.dir === shown);
      assert.equal(/ppn-arm--open/.test(arms[k].className), open, 'tile ' + i + ' arm ' + d);
      if (open && up.includes(i)) marked++;
    });
  });
  assert.ok(marked > 0, 'the live network has a dangling cable');
});

test('patch-panel: every class the game puts on the page has a rule in style.css', (t) => {
  const seen = new Set();
  const collect = (v) => {
    for (const el of walk(v.page.root)) String(el.className || '').split(/\s+/).filter(Boolean).forEach((name) => seen.add(name));
  };
  const { clock, v } = openPage(t, { storage: { state: boardSave(ppn.ppnGenerate(5, seeded(25), true)) } });
  v.rightClick(0);
  v.click('lock-mode');
  v.press('ArrowUp');
  collect(v);
  v.click('lock-mode');
  v.click('restart');
  const { masks, turns } = v.state();
  solve(v, clock, masks, turns);
  collect(v);
  for (const value of CONFIGS) {
    v.choose(value);
    collect(v);
  }
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors).join(' ');
  for (const name of [...seen].sort()) {
    assert.match(name, /^ppn-/);
    assert.match(selectors, new RegExp('\\.' + name + '(?![\\w-])'), name);
  }
  for (const name of ['ppn-tile--storm', 'ppn-tile--locked', 'ppn-tile--cursor', 'ppn-board--lockmode', 'ppn-board--keys',
    'ppn-board--solved', 'ppn-board--wrap', 'ppn-arm--open', 'ppn-arm--uplink', 'ppn-btn--next', 'ppn-node-switch', 'ppn-node-server', 'ppn-node-nas', 'ppn-node-ap',
    'ppn-board--n5', 'ppn-board--n7', 'ppn-board--n9']) {
    assert.ok(seen.has(name), name + ' was seen on the page');
  }
});

// ── Daily on the page ────────────────────────────────────────────────────────

test('patch-panel: opening the Daily writes the attempt at once, shows today\'s 7x7 and keeps the free game aside', (t) => {
  const { clock, v } = openPage(t);
  const free = v.state();
  v.click('daily-button');
  assert.deepEqual(v.daily(), {
    v: 1, key: KEY5, day: 5, status: 'playing', turns: DAILY5_START, locks: new Array(49).fill(0),
    moves: 0, elapsed: 0, time: 0, streak: 0, lastWon: null
  });
  assert.equal(v.state().view, 'daily');
  assert.deepEqual(v.state().masks, free.masks, 'the free game is kept');
  assert.equal(v.tiles().length, 49);
  assert.equal(v.text('mode'), 'Daily #5 · 7x7 · ' + KEY5);
  assert.equal(v.text('daily-button'), 'Free Play');
  assert.equal(v.el('daily-button').getAttribute('aria-label'), 'Back to free play');
  assert.equal(v.text('target'), '55');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'ppn-tile-24');
  v.tiles().forEach((tile, i) => assert.equal(v.angle(i), DAILY5_START[i] * 90));

  // Rotations and the clock go to the attempt.
  v.tap(0);
  clock.advance(3000);
  assert.equal(v.daily().moves, 1);
  assert.equal(v.daily().elapsed, 3000);
  assert.equal(v.state().moves, 0);
  // Back to free play: the clock of the attempt stops, the free game comes back.
  v.click('daily-button');
  assert.equal(v.state().view, 'free');
  assert.equal(v.tiles().length, 25);
  assert.equal(v.text('daily-button'), 'Daily #5');
  assert.equal(v.el('config').value, '5');
  v.tap(1);
  clock.advance(2000);
  assert.equal(v.state().elapsed, 2000);
  assert.equal(v.daily().elapsed, 3000, 'the attempt\'s clock stood while the free game ran');
  // The attempt resumes as it was.
  v.click('daily-button');
  assert.equal(v.text('moves'), '1');
  assert.equal(v.text('time'), '0:03');
  assert.equal(v.daily().turns[0], (DAILY5_START[0] + 1) % 4);
  // And after a reload, which opens the Daily again.
  const again = reload(clock, v);
  assert.equal(again.tiles().length, 49);
  assert.equal(again.text('mode'), 'Daily #5 · 7x7 · ' + KEY5);
  assert.equal(again.daily().moves, 1);
  assert.equal(again.text('time'), '0:03');
});

test('patch-panel: a Daily in progress cannot be restarted, and New Game leaves it waiting, naming the free game it replaces', (t) => {
  const { clock, v } = openPage(t);
  v.tap(3);
  clock.advance(65000);
  v.click('daily-button');
  v.tap(5);
  const attempt = v.daily();
  v.click('restart');
  assert.equal(v.toast(), 'Daily #5 is one scored attempt and cannot be restarted (rotations so far: 1).');
  assert.deepEqual(v.daily(), attempt);
  v.click('new-game');
  assert.equal(v.toast(), 'New 5x5 board. Your 5x5 game set aside (1 rotation, 1:05) was replaced.');
  assert.equal(v.state().view, 'free');
  assert.equal(v.state().moves, 0);
  assert.equal(v.tiles().length, 25);
  assert.deepEqual(v.daily(), attempt);
  v.press('n');
  v.choose('9');
  v.click('daily-button');
  assert.equal(v.text('moves'), '1');
  assert.deepEqual(v.daily().turns, attempt.turns);
});

test('patch-panel: solving the Daily records the result once: time, rotations, streak, share line and a practice run', async (t) => {
  const { clock, v } = openPage(t);
  v.click('daily-button');
  const taps = solve(v, clock, DAILY5_MASKS, DAILY5_START, 101000);
  assert.equal(taps, 55);
  const record = v.daily();
  assert.equal(record.status, 'won');
  assert.equal(record.time, 101);
  assert.equal(record.moves, 55);
  assert.equal(record.streak, 1);
  assert.equal(record.lastWon, 5);
  assert.equal(v.text('status'), 'Daily #5 solved in 1:41 with 55 rotations (target 55). Streak 1.');
  assert.equal(v.text('streak'), '1');
  assert.equal(v.toast(), 'All 49 ports up: new best!');
  assert.deepEqual(v.best()['7'], { time: 101, moves: 55 });
  assert.equal(v.hidden('share'), false);
  assert.equal(v.hidden('next'), true, 'the Daily is no rung of the ladder');
  assert.equal(v.text('restart'), 'Practice');
  assert.equal(v.el('restart').getAttribute('aria-label'), 'Practice this Daily board, not scored');

  const write = t.mock.method(navigator.clipboard, 'writeText', () => Promise.resolve());
  v.click('share-button');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(write.mock.calls.map((call) => call.arguments), [['Patch Panel #5 7x7 1:41 55 rotations (target 55)']]);
  assert.equal(v.toast(), 'Copied: Patch Panel #5 7x7 1:41 55 rotations (target 55)');

  // In free play the Daily button shows today's is done.
  v.click('daily-button');
  assert.equal(v.text('daily-button'), 'Daily #5 ✓');
  assert.equal(v.hidden('share'), true);
  v.click('daily-button');

  // A reload shows the result again, with no way to play it for a score.
  const again = reload(clock, v);
  assert.equal(again.text('status'), 'Daily #5 solved in 1:41 with 55 rotations (target 55). Streak 1.');
  assert.match(again.board.className, /\bppn-board--solved\b/);
  again.tap(0);
  assert.equal(again.daily().moves, 55);

  // Practice: the same board in free play, unscored, in place of the free game set aside (the toast names it).
  again.click('daily-button');
  again.tap(0);
  again.tap(1);
  clock.advance(42000);
  again.click('daily-button');
  again.click('restart');
  assert.equal(again.toast(), 'Practice run of Daily #5: not scored. Your 5x5 game set aside (2 rotations, 0:42) was replaced.');
  assert.equal(again.state().view, 'free');
  assert.equal(again.state().practice, 5);
  assert.deepEqual(again.state().masks, DAILY5_MASKS);
  assert.equal(again.text('mode'), 'Practice of Daily #5 · 7x7');
  again.click('restart');
  assert.equal(again.toast(), 'Practice run of Daily #5: not scored.');
  solve(again, clock, DAILY5_MASKS, DAILY5_START, 5000);
  assert.equal(again.text('status'), 'Network converged: all 49 ports up in 0:05 with 55 rotations (target 55). Practice run, not scored.');
  assert.equal(again.toast(), 'All 49 ports up.');
  assert.equal(again.hidden('next'), true, 'a practice run climbs no ladder');
  assert.deepEqual(again.best()['7'], { time: 101, moves: 55 }, 'a practice run sets no best');
  assert.equal(again.daily().time, 101);
});

test('patch-panel: the streak grows on consecutive days and starts over after a missed one', (t) => {
  const yesterday = { v: 1, key: '2026-11-04', day: 4, status: 'won', moves: 40, elapsed: 90000, time: 90, streak: 3, lastWon: 4 };
  let { clock, v } = openPage(t, { storage: { daily: yesterday } });
  assert.equal(v.text('streak'), '3');
  assert.equal(v.text('daily-button'), 'Daily #5');
  v.click('daily-button');
  assert.equal(v.daily().streak, 3);
  solve(v, clock, DAILY5_MASKS, DAILY5_START);
  assert.equal(v.daily().streak, 4);
  assert.equal(v.text('streak'), '4');

  resetStubs();
  ({ clock, v } = openPage(t, { storage: { daily: Object.assign({}, yesterday, { key: '2026-11-03', day: 3, lastWon: 3 }) } }));
  assert.equal(v.text('streak'), '0', 'a missed day');
  v.click('daily-button');
  assert.equal(v.daily().streak, 0);
  solve(v, clock, DAILY5_MASKS, DAILY5_START);
  assert.equal(v.daily().streak, 1);
});

test('patch-panel: a Daily left open across midnight finishes as the day it started; the next one starts on reload', (t) => {
  const { clock, v } = openPage(t, { when: NOV5_LATE });
  v.click('daily-button');
  v.tap(0);
  clock.advance(2 * 60000);
  assert.equal(ppn.ppnDayInfo(new Date()).key, KEY6, 'the clock has passed midnight');
  solve(v, clock, DAILY5_MASKS, v.daily().turns);
  const record = v.daily();
  assert.equal(record.key, KEY5);
  assert.equal(record.status, 'won');
  assert.equal(record.lastWon, 5);
  assert.equal(record.streak, 1);
  assert.match(v.text('status'), /^Daily #5 solved/);
  assert.equal(v.text('streak'), '1', 'yesterday\'s win keeps the streak today');
  v.click('daily-button');
  assert.equal(v.text('daily-button'), 'Daily #6', 'today\'s Daily is a new one');
  v.click('daily-button');
  assert.equal(v.daily().key, KEY6);
  assert.equal(v.daily().status, 'playing');
  assert.equal(v.daily().streak, 1);
  assert.equal(v.text('mode'), 'Daily #6 · 7x7 · ' + KEY6);

  // Reload on the Daily of another day starts today's.
  resetStubs();
  const later = openPage(t, { when: NOV5 + 86400000, storage: { state: { view: 'daily' }, daily: record } });
  assert.equal(later.v.daily().key, KEY6);
  assert.equal(later.v.daily().moves, 0);
  assert.deepEqual(later.v.daily().turns, ppn.ppnDailyBoard(KEY6).start);
});

test('patch-panel: without a clipboard, or when it refuses, the share line is shown selected for copying by hand', async (t) => {
  const finished = { v: 1, key: KEY5, day: 5, status: 'won', moves: 31, elapsed: 102000, time: 102, streak: 2, lastWon: 5 };
  const line = 'Patch Panel #5 7x7 1:42 31 rotations (target 55)';
  const real = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  t.after(() => Object.defineProperty(navigator, 'clipboard', real));
  for (const clipboard of [undefined, {}, { writeText: () => Promise.reject(new Error('denied')) }]) {
    resetStubs();
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true, writable: true });
    const { v } = openPage(t, { storage: { state: { view: 'daily' }, daily: finished } });
    assert.equal(v.text('status'), 'Daily #5 solved in 1:42 with 31 rotations (target 55). Streak 2.');
    assert.equal(v.hidden('share-text'), true);
    v.click('share-button');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(v.hidden('share-text'), false, JSON.stringify(clipboard));
    assert.equal(v.el('share-text').value, line);
    assert.equal(document.activeElement, v.el('share-text'));
    assert.equal(v.toast(), 'The clipboard is not available: copy the selected result below.');
  }
});

test('patch-panel: the Daily clock runs while its attempt is on screen in a visible tab, from the moment it opens', (t) => {
  const { clock, v } = openPage(t);
  v.click('daily-button');
  clock.advance(5000);
  assert.equal(v.text('time'), '0:05', 'time spent looking at the board counts, no rotation needed');
  assert.equal(v.daily().elapsed, 5000);
  assert.equal(v.daily().moves, 0);
  setVisibility('hidden', t);
  assert.equal(v.daily().elapsed, 5000, 'saved when hidden');
  clock.advance(60000);
  setVisibility('visible', t);
  clock.advance(2000);
  assert.equal(v.text('time'), '0:07', 'shown again, it runs on without a rotation');
  // Free Play stops it, the Daily button starts it again.
  v.click('daily-button');
  clock.advance(30000);
  assert.equal(v.daily().elapsed, 7000);
  v.click('daily-button');
  clock.advance(1000);
  assert.equal(v.text('time'), '0:08');
  assert.doesNotMatch(v.text('status'), /Clock paused/);
  // A reload runs it on at once.
  const again = reload(clock, v);
  clock.advance(2000);
  assert.equal(again.text('time'), '0:10');
  assert.equal(again.daily().elapsed, 10000);
  // A page opened in a background tab keeps it standing until the tab is shown.
  setVisibility('hidden', t);
  const background = reload(clock, again);
  clock.advance(4000);
  assert.equal(background.text('time'), '0:10');
  setVisibility('visible', t);
  clock.advance(1000);
  assert.equal(background.text('time'), '0:11');
  // Solved, it stands for good.
  solve(background, clock, DAILY5_MASKS, background.daily().turns);
  assert.equal(background.daily().time, 11);
  setVisibility('hidden', t);
  setVisibility('visible', t);
  clock.advance(5000);
  assert.equal(background.text('time'), '0:11');
});

test('patch-panel: a second tab never writes over another tab\'s Daily or best: free play, its clock and hiding it write only ppn-state', (t) => {
  const yesterday = { v: 1, key: '2026-11-04', day: 4, status: 'won', moves: 40, elapsed: 90000, time: 90, streak: 3, lastWon: 4 };
  const { clock, v } = openPage(t, { storage: { daily: yesterday } });
  // Meanwhile another tab solves Daily #5 and sets a 7x7 best.
  const won = JSON.stringify({ v: 1, key: KEY5, day: 5, status: 'won', turns: new Array(49).fill(0), locks: new Array(49).fill(0), moves: 60, elapsed: 120000, time: 120, streak: 4, lastWon: 5 });
  localStorage.setItem(DAILY_KEY, won);
  localStorage.setItem(BEST_KEY, JSON.stringify({ 7: { time: 120, moves: 60 } }));
  // Here: free-play taps and a lock, the clock ticking, the tab hidden and shown again.
  v.tap(0);
  clock.advance(3000);
  v.rightClick(1);
  setVisibility('hidden', t);
  assert.equal(v.state().elapsed, 3000, 'hiding saves the free game whose clock ran');
  setVisibility('visible', t);
  clock.advance(1000);
  v.click('new-game');
  const state = localStorage.getItem(STATE_KEY);
  setVisibility('hidden', t);
  assert.equal(localStorage.getItem(STATE_KEY), state, 'a tab hidden with no clock running writes nothing at all');
  setVisibility('visible', t);
  assert.equal(localStorage.getItem(DAILY_KEY), won, 'the other tab\'s Daily win stays as it was written');
  // A win here keeps the other tab's best.
  const { masks, turns } = v.state();
  const taps = solve(v, clock, masks, turns, 9000);
  assert.deepEqual(v.best()['5'], { time: 9, moves: taps });
  assert.deepEqual(v.best()['7'], { time: 120, moves: 60 });
  // Opening the Daily shows that win instead of a second scored attempt, and so does a reload.
  v.click('daily-button');
  assert.equal(v.text('status'), 'Daily #5 solved in 2:00 with 60 rotations (target 55). Streak 4.');
  assert.equal(v.text('best'), '2:00 / 60');
  v.click('restart');
  assert.equal(v.toast(), 'Practice run of Daily #5: not scored.', 'the solved free game set aside loses nothing');
  assert.equal(localStorage.getItem(DAILY_KEY), won);
  const again = reload(clock, v);
  again.click('daily-button');
  assert.equal(again.text('status'), 'Daily #5 solved in 2:00 with 60 rotations (target 55). Streak 4.');
  assert.equal(localStorage.getItem(DAILY_KEY), won);
});

test('patch-panel: on the Daily a second tab takes over the other tab\'s newer record at a tap, a tick or the storage event', (t) => {
  const { clock, v } = openPage(t);
  v.click('daily-button');
  v.tap(0);
  clock.advance(2000);
  const mine = v.daily();
  // The other tab plays on from there: three more rotations, ten seconds more.
  const theirs = Object.assign({}, mine, { turns: mine.turns.map((x, i) => (i >= 1 && i <= 3 ? (x + 1) % 4 : x)), moves: 4, elapsed: 12000 });
  localStorage.setItem(DAILY_KEY, JSON.stringify(theirs));
  // A tap here, made on the old board, shows the other tab's attempt instead of being played.
  v.tap(5);
  assert.deepEqual(v.daily(), theirs);
  assert.equal(v.text('moves'), '4');
  assert.equal(v.text('time'), '0:12');
  for (const i of [1, 2, 3, 5]) assert.equal(v.angle(i), theirs.turns[i] * 90, 'tile ' + i + ' as the other tab left it');
  assert.equal(v.toast(), 'Another tab saved Daily #5 (4 rotations, 0:12): it is shown here.');
  // The clock runs on from the other tab's time, and the next tap is played.
  clock.advance(1000);
  assert.equal(v.daily().elapsed, 13000);
  v.tap(5);
  assert.equal(v.daily().moves, 5);
  // The other tab plays on again: a lock here is not applied to the old board either.
  const step = (record, moves, elapsed) => Object.assign({}, record, { turns: record.turns.map((x, i) => (i === 6 ? (x + 1) % 4 : x)), moves, elapsed });
  const third = step(v.daily(), 6, 20000);
  localStorage.setItem(DAILY_KEY, JSON.stringify(third));
  v.rightClick(10);
  assert.equal(v.has(10, 'ppn-tile--locked'), false);
  assert.deepEqual(v.daily(), third);
  assert.equal(v.toast(), 'Another tab saved Daily #5 (6 rotations, 0:20): it is shown here.');
  // And at a tick the record on disk is read again before it is written.
  const fourth = step(third, 7, 25000);
  localStorage.setItem(DAILY_KEY, JSON.stringify(fourth));
  clock.advance(1000);
  assert.equal(v.text('moves'), '7');
  assert.equal(v.toast(), 'Another tab saved Daily #5 (7 rotations, 0:25): it is shown here.');
  clock.advance(1000);
  assert.equal(v.daily().elapsed, 26000, 'then this tab\'s clock writes on from there');
  // While this tab is hidden the other one solves it and the storage event tells this one.
  setVisibility('hidden', t);
  const solved = Object.assign({}, v.daily(), { status: 'won', turns: new Array(49).fill(0), moves: 50, elapsed: 70000, time: 70, streak: 1, lastWon: 5 });
  localStorage.setItem(DAILY_KEY, JSON.stringify(solved));
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.text('moves'), '7', 'an event for another key changes nothing');
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(v.toast(), 'Another tab solved Daily #5 (50 rotations, 1:10): it is shown here.');
  setVisibility('visible', t);
  assert.equal(v.text('status'), 'Daily #5 solved in 1:10 with 50 rotations (target 55). Streak 1.');
  assert.equal(v.text('streak'), '1');
  clock.advance(5000);
  assert.equal(v.text('time'), '1:10', 'the solved Daily\'s clock stands');
  v.tap(0);
  v.click('daily-button');
  assert.deepEqual(v.daily(), solved, 'leaving it writes the win back as it came');
});

test('patch-panel: opening the Daily resumes the attempt another tab began; a record from after today never blocks today\'s', (t) => {
  const { v } = openPage(t);
  // Another tab began Daily #5 after this page loaded and turned seven tiles.
  const board = ppn.ppnDailyBoard(KEY5);
  const theirs = { v: 1, key: KEY5, day: 5, status: 'playing', turns: board.start.map((x, i) => (i < 7 ? (x + 1) % 4 : x)), locks: new Array(49).fill(0), moves: 7, elapsed: 30000, time: 0, streak: 0, lastWon: null };
  localStorage.setItem(DAILY_KEY, JSON.stringify(theirs));
  v.click('daily-button');
  assert.deepEqual(v.daily(), theirs, 'no second attempt begins');
  assert.equal(v.text('moves'), '7');
  assert.equal(v.text('time'), '0:30');
  assert.equal(v.toast(), null, 'opening it needs no toast');

  // A record from after today (the clock was set back): today's attempt begins over it, and
  // neither the storage event nor a tap brings it back.
  resetStubs();
  const future = JSON.stringify(Object.assign({}, theirs, { key: '2026-11-09', day: 9 }));
  const later = openPage(t, { storage: { daily: future } }).v;
  later.click('daily-button');
  assert.equal(later.daily().key, KEY5);
  assert.equal(later.daily().moves, 0);
  localStorage.setItem(DAILY_KEY, future);
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(later.text('mode'), 'Daily #5 · 7x7 · ' + KEY5);
  later.tap(0);
  assert.equal(later.daily().key, KEY5);
  assert.equal(later.daily().moves, 1);

  // A tab with no Daily record at all takes the other tab's at once: free play stays on screen.
  resetStubs();
  const fresh = openPage(t).v;
  localStorage.setItem(DAILY_KEY, JSON.stringify(Object.assign({}, theirs, { status: 'won', turns: new Array(49).fill(0), time: 30, streak: 1, lastWon: 5 })));
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(fresh.text('daily-button'), 'Daily #5 ✓');
  assert.equal(fresh.text('streak'), '1');
  assert.equal(fresh.text('mode'), 'Free play · 5x5');
  assert.equal(fresh.toast(), null);
});

// ── Saves on the page ────────────────────────────────────────────────────────

test('patch-panel: a save in the current format loads as it was and is written back in the same format', (t) => {
  const { clock, v } = openPage(t, { storage: { state: SAMPLE_SAVE } });
  const raw = JSON.parse(SAMPLE_SAVE);
  assert.equal(v.text('moves'), '7');
  assert.equal(v.text('time'), '0:12');
  assert.equal(v.text('target'), String(targetModel(raw.masks, raw.start)));
  v.tiles().forEach((tile, i) => {
    assert.equal(v.angle(i), raw.turns[i] * 90);
    assert.equal(v.has(i, 'ppn-tile--locked'), raw.locks[i] === 1);
  });
  assert.match(v.text('status'), / Clock paused: it runs again with your next rotation\.$/);
  // Nothing changed yet: the save on disk is the same text.
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE);
  v.tap(1);
  clock.advance(1000);
  const written = v.state();
  assert.deepEqual(Object.keys(written), Object.keys(raw));
  assert.deepEqual(written, Object.assign({}, raw, { turns: raw.turns.map((x, i) => (i === 1 ? (x + 1) % 4 : x)), moves: 8, elapsed: 13345 }));
});

test('patch-panel: a game in progress survives a reload: board, turns, locks, rotations and clock', (t) => {
  const { clock, v } = openPage(t, { random: 7 });
  v.choose('7w');
  v.tap(3);
  v.tap(3);
  v.rightClick(10);
  clock.advance(2500);
  const snapshot = v.state();
  const drawn = v.tiles().map((tile, i) => [tile.className, v.angle(i) % 360]);
  const again = reload(clock, v);
  assert.deepEqual(again.state(), snapshot);
  assert.equal(again.el('config').value, '7w');
  assert.deepEqual(again.tiles().map((tile, i) => [tile.className.replace(' ppn-tile--cursor', ''), again.angle(i) % 360]),
    drawn.map(([name, angle]) => [name.replace(' ppn-tile--cursor', ''), angle]));
  assert.equal(again.text('time'), '0:02');
  assert.equal(again.text('moves'), '2');
});

test('patch-panel: a corrupt or unplayable save never breaks the page: a fresh, playable board instead', (t) => {
  for (const [name, text] of Object.entries(corruptStates())) {
    resetStubs();
    const { v } = openPage(t, { storage: { state: text, best: '{', daily: '[' } });
    const parsed = ppn.ppnParseState(text);
    assert.equal(v.tiles().length, parsed.n * parsed.n, name);
    assert.equal(v.text('moves'), '0', name);
    assert.equal(v.text('best'), '--', name);
    assert.equal(solvedModel(v.state().masks, parsed.n, parsed.wrap), true, name + ': a fresh board replaces the save');
    v.tap(0);
    assert.equal(v.state().moves, 1, name);
    v.click('daily-button');
    assert.equal(v.daily().key, KEY5, name);
  }
});

test('patch-panel: a 9x9 board loaded solved shows its result, and a broken Daily save opens a fresh attempt', (t) => {
  const board = ppn.ppnGenerate(9, seeded(2), false);
  const { v } = openPage(t, { storage: { state: boardSave(board, { turns: board.masks.map(() => 0), moves: 70, elapsed: 125000 }), daily: { key: 'nope', streak: 6, lastWon: 4 } } });
  assert.equal(v.text('status'), 'Network converged: all 81 ports up in 2:05 with 70 rotations (target ' + targetModel(board.masks, board.start) + '). Next rung: 5x5 wrap.');
  assert.equal(v.text('next'), 'Next rung: 5x5 wrap', 'after 9x9 the ladder goes on with wrap');
  assert.equal(v.text('streak'), '6');
  assert.deepEqual(storedKeys(), [DAILY_KEY, STATE_KEY]);
  assert.equal(JSON.parse(localStorage.getItem(DAILY_KEY)).key, 'nope', 'a Daily save without an attempt is left until one begins');
  v.click('daily-button');
  assert.equal(v.daily().key, KEY5);
  assert.equal(v.daily().streak, 6, 'yesterday\'s win keeps the streak');
});

test('patch-panel: blocked storage never stops the game, and the warning names the error', (t) => {
  blockStorage('access', t);
  const { clock, v } = openPage(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Storage is blocked or full (SecurityError): progress on this page will not be saved.');
  assert.equal(v.tiles().length, 25);
  v.tap(0);
  v.rightClick(1);
  clock.advance(2000);
  assert.equal(v.text('moves'), '1');
  assert.equal(v.text('time'), '0:02');
  v.click('daily-button');
  assert.equal(v.tiles().length, 49);
  v.click('daily-button');
  v.choose('9w');
  assert.equal(v.tiles().length, 81);
});

test('patch-panel: full storage still reads the saves; the game plays on and warns once', (t) => {
  writeStorage({ state: SAMPLE_SAVE });
  blockStorage('full', t);
  const { clock, v } = openPage(t);
  assert.equal(v.text('moves'), '7', 'the save is still read');
  assert.equal(v.text('warning'), 'Storage is blocked or full (QuotaExceededError): progress on this page will not be saved.');
  v.el('warning').textContent = 'seen';
  v.tap(0);
  clock.advance(3000);
  assert.equal(v.text('moves'), '8');
  assert.equal(v.text('warning'), 'seen', 'warned once');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE);
});
