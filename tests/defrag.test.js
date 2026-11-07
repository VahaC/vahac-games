// tests/defrag.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, focusElement, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'defrag';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

// The pure functions (the start-up code does not run under Node).
const dfg = loadScript(SCRIPT);

const STATE_KEY = 'dfg-state';
const PROGRESS_KEY = 'dfg-progress';
const DAILY_KEY = 'dfg-daily';

// Local noon and 23:59 of 2026-11-06 (Daily #6), built in local time so the
// tests give the same day in every time zone.
const NOV6 = new Date(2026, 10, 6, 12, 0, 0).getTime();
const NOV6_LATE = new Date(2026, 10, 6, 23, 59, 0).getTime();
const KEY6 = '2026-11-06';
const KEY7 = '2026-11-07';

// The Daily of 2026-11-06, pinned: a change to the generator, the solver
// caps, the seed or the PRNG changes every visitor's Daily and has to show
// up here.
const DAILY6 = {
  files: [
    { ext: 'boot', name: 'boot.sys', size: 4, system: true },
    { ext: 'cfg', name: 'nginx.cfg', size: 4, system: false },
    { ext: 'txt', name: 'notes.txt', size: 5, system: false },
    { ext: 'log', name: 'syslog.log', size: 4, system: false },
    { ext: 'tar', name: 'backup.tar', size: 4, system: false },
    { ext: 'db', name: 'users.db', size: 4, system: false }
  ],
  sys: [-1, -1, 0, -1, -1, -1, -1, -1],
  capacity: 5,
  start: [[1, 5, 5, 5, 1], [1, 0, 0, 4], [0, 4], [2, 2, 2, 1], [3, 3, 3, 3, 5], [2, 2, 4, 0, 4], [], []],
  goal: [[1, 1, 1, 1], [5, 5, 5, 5], [0, 0, 0, 0], [2, 2, 2, 2, 2], [3, 3, 3, 3], [4, 4, 4, 4], [], []],
  steps: 16,
  least: 12,
  par: 12
};

// Level 1 and level 2, pinned the same way.  Level 1: users.db, backup.tar,
// photo.jpg and syslog.log, 4 blocks each, on 6 tracks of 4; 9 moves at
// least (par 9).
const LEVEL1_START = [[0, 0, 3], [3, 1], [1, 3], [2, 2, 3], [2, 2, 1, 0], [0, 1]];
const LEVEL1_PAR = 9;
const LEVEL2_START = [[0, 1], [0, 1, 3, 2], [3, 0], [3, 0, 3], [2, 2, 1], [1, 2]];

// Saves in the format the first published version writes: level 2 after
// three moves and one undo, with one hint; level 1 defragmented in 9 moves;
// Daily #6 after one move, with a streak of 2 from Daily #5.
const SAMPLE_STATE = '{"v":1,"view":"level","level":2,' +
  '"tracks":[[],[0,1,3,2],[3,0,0],[3,0,3],[2,2,1,1],[1,2]],"history":[[0,4,1],[0,2,1]],"moves":2,"undos":1,"hints":1}';
const SAMPLE_PROGRESS = '{"v":1,"highest":1,"moves":{"1":9}}';
const SAMPLE_DAILY = '{"v":1,"key":"2026-11-06","day":6,"status":"playing",' +
  '"tracks":[[1,5,5,5],[1,0,0,4],[0,4],[2,2,2,1,1],[3,3,3,3,5],[2,2,4,0,4],[],[]],"history":[[0,3,1]],' +
  '"moves":1,"undos":0,"hints":0,"streak":2,"lastWon":5}';

// Level 8 runs into a dead end after these four moves (0-based tracks).
const LEVEL8_DEAD = [[6, 1], [4, 2], [5, 2], [5, 0]];

test.beforeEach(() => resetStubs());

// ── An independent model of the rules ───────────────────────────────────────
//
// A board is { files: [{ size }], sys, capacity }; tracks[t] lists the
// blocks of track t bottom first, by file.  A reserved track's bottom block
// (sys[t] >= 0) never moves.

const low = (board, t) => (board.sys[t] >= 0 ? 1 : 0);
const top = (track) => track[track.length - 1];
const copy = (tracks) => tracks.map((track) => track.slice());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The movable blocks of one file on top of track t.
function runModel(board, tracks, t) {
  const track = tracks[t];
  let k = 0;
  while (k < track.length - low(board, t) && track[track.length - 1 - k] === top(track)) k++;
  return k;
}

// The blocks a move from a to b takes, or 0 when the rules forbid it.
function legalModel(board, tracks, a, b) {
  if (a === b) return 0;
  const k = runModel(board, tracks, a);
  if (k === 0) return 0;
  const file = top(tracks[a]);
  const to = tracks[b];
  if (board.sys[b] >= 0 && board.sys[b] !== file) return 0;
  if (to.length > 0 && top(to) !== file) return 0;
  return to.length + k <= board.capacity ? k : 0;
}

function moveModel(tracks, a, b, k) {
  const out = copy(tracks);
  out[b] = out[b].concat(out[a].slice(out[a].length - k));
  out[a] = out[a].slice(0, out[a].length - k);
  return out;
}

// Reverse moves by brute force: every way to take k blocks off b and put them
// on a whose forward move a -> b is legal, takes exactly those k blocks and
// gives tracks back.
function reverseModel(board, tracks) {
  const out = [];
  tracks.forEach((from, b) => {
    for (let k = 1; k <= from.length - low(board, b); k++) {
      tracks.forEach((onto, a) => {
        if (a === b || onto.length + k > board.capacity) return;
        const before = copy(tracks);
        before[a] = onto.concat(from.slice(from.length - k));
        before[b] = from.slice(0, from.length - k);
        if (legalModel(board, before, a, b) === k && same(moveModel(before, a, b, k), tracks)) out.push([b, a, k]);
      });
    }
  });
  return out;
}

// Runs of every file, and the solved test: each file in one run.
function runsOf(tracks) {
  const runs = {};
  for (const track of tracks) {
    track.forEach((file, i) => {
      if (i === 0 || track[i - 1] !== file) runs[file] = (runs[file] || 0) + 1;
    });
  }
  return runs;
}

const solvedModel = (board, tracks) => board.files.every((file, f) => runsOf(tracks)[f] === 1);
const extraModel = (board, tracks) => Object.values(runsOf(tracks)).reduce((sum, n) => sum + n - 1, 0);

// The fewest moves to a defragmented disk by breadth-first search over whole
// states (no canonical keys), or -1 when none can be reached.
function bfsMin(board, start, limit = 300000) {
  const seen = new Set([JSON.stringify(start)]);
  let level = [start];
  for (let depth = 0; level.length; depth++) {
    const next = [];
    for (const tracks of level) {
      if (solvedModel(board, tracks)) return depth;
      for (let a = 0; a < tracks.length; a++) {
        for (let b = 0; b < tracks.length; b++) {
          const k = legalModel(board, tracks, a, b);
          if (!k) continue;
          const after = moveModel(tracks, a, b, k);
          const key = JSON.stringify(after);
          if (seen.has(key)) continue;
          seen.add(key);
          assert.ok(seen.size < limit, 'the BFS stays small');
          next.push(after);
        }
      }
    }
    level = next;
  }
  return -1;
}

// Whether a route of at most depth moves defragments the disk: depth-first
// over whole states (no canonical keys, every legal move), cut only where
// the fragments left exceed the moves left (a move merges at most two runs)
// or a state was already searched with as many moves left.
function routeWithin(board, start, depth, limit = 1000000) {
  const searched = new Map();
  let nodes = 0;
  function search(tracks, left) {
    assert.ok(++nodes < limit, 'the search stays small');
    const h = extraModel(board, tracks);
    if (h === 0) return true;
    if (h > left) return false;
    const key = JSON.stringify(tracks);
    if (searched.has(key) && searched.get(key) >= left) return false;
    searched.set(key, left);
    for (let a = 0; a < tracks.length; a++) {
      for (let b = 0; b < tracks.length; b++) {
        const k = legalModel(board, tracks, a, b);
        if (k && search(moveModel(tracks, a, b, k), left - 1)) return true;
      }
    }
    return false;
  }
  return search(start, depth);
}

// Plays a path of moves under the model; every move must be legal.
function playModel(board, tracks, path, where) {
  let cur = tracks;
  for (const [a, b, k] of path) {
    assert.equal(legalModel(board, cur, a, b), k, where + ': move ' + JSON.stringify([a, b, k]));
    cur = moveModel(cur, a, b, k);
  }
  return cur;
}

// A random small board and a state of it: 3-5 tracks of 3-4 blocks, 2-3
// files of 2+ blocks, maybe one reserved track.
function randomCase(rnd) {
  const capacity = 3 + Math.floor(rnd() * 2);
  const count = 3 + Math.floor(rnd() * 3);
  const fileCount = 2 + Math.floor(rnd() * 2);
  const files = [];
  for (let f = 0; f < fileCount; f++) files.push({ size: 2 + Math.floor(rnd() * (capacity - 1)), name: 'f' + f, ext: 'f' + f });
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > count * capacity - 1) files[0].size = 2;
  const sys = new Array(count).fill(-1);
  const tracks = Array.from({ length: count }, () => []);
  if (rnd() < 0.5) {
    sys[0] = 0;
    tracks[0].push(0);
  }
  const blocks = [];
  files.forEach((file, f) => {
    for (let k = 0; k < file.size - (sys[0] === f ? 1 : 0); k++) blocks.push(f);
  });
  for (const file of blocks) {
    const open = tracks.map((track, t) => t).filter((t) => tracks[t].length < capacity);
    tracks[open[Math.floor(rnd() * open.length)]].push(file);
  }
  return { board: { files, sys, capacity }, tracks };
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

// ── Pages ────────────────────────────────────────────────────────────────────

// One mocked clock for timers, Date and performance.now().  reload() drops
// the timers of the page that goes away, as a real reload does.
function makeClock(t, when = NOV6) {
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
  for (const [key, value] of [[STATE_KEY, storage.state], [PROGRESS_KEY, storage.progress], [DAILY_KEY, storage.daily]]) {
    if (value !== undefined) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

const storedKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();

// What a player sees and does.
function pageView(b) {
  const els = b.els;
  const disk = els['dfg-disk'];
  const view = {
    els,
    disk,
    page: b.page,
    ready: b.ready,
    restore: b.restore,
    el: (name) => els['dfg-' + name],
    text: (name) => els['dfg-' + name].textContent,
    hidden: (name) => els['dfg-' + name].classList.contains('dfg-hidden'),
    tracks: () => disk.children,
    track: (t) => disk.children[t],
    has: (t, name) => disk.children[t].classList.contains(name),
    blocks: (t) => disk.children[t].children[1].children,
    tap: (t) => disk.children[t].click(),
    move(a, b) {
      view.tap(a);
      view.tap(b);
    },
    press(key, props) {
      focusElement(disk, { keyboard: true });
      return pressKey(key, Object.assign({ target: disk }, props));
    },
    click: (name) => els['dfg-' + name].click(),
    toast: () => (els['dfg-toast'].classList.contains('dfg-show') ? els['dfg-toast'].textContent : null),
    state: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    progress: () => JSON.parse(localStorage.getItem(PROGRESS_KEY)),
    daily: () => JSON.parse(localStorage.getItem(DAILY_KEY))
  };
  return view;
}

function boot(options) {
  return pageView(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options));
}

// The page as a browser loads it, after writing storage, with a mocked clock.
// Math.random is never used by the game: it throws.
function openPage(t, { when, storage, options } = {}) {
  const clock = makeClock(t, when);
  t.mock.method(Math, 'random', () => {
    throw new Error('the game never uses Math.random');
  });
  writeStorage(storage);
  return { clock, v: boot(options) };
}

// A reload: the old page and its timers go away, storage stays.
function reload(clock, v) {
  clock.reload();
  v.restore();
  return boot();
}

// Defragments the disk on screen by the solver's route, tapping each move.
// Returns the moves made.
function solveOnPage(v, board, tracks) {
  const route = dfg.dfgSolve(board, tracks, dfg.dfgLimits);
  assert.equal(route.status, 'solved');
  for (const [a, b] of route.path) v.move(a, b);
  return route.path.length;
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
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value).trim());
  assert.ok(m, 'a px length: ' + value);
  return Number(m[1]);
};

const rem = (value) => {
  const m = /^(\d+(?:\.\d+)?)rem$/.exec(String(value).trim());
  assert.ok(m, 'a rem length: ' + value);
  return Number(m[1]) * 16;
};

// The horizontal padding of a shorthand ('8px', '20px 12px', '0').
const sidePad = (value) => {
  const parts = String(value).trim().split(/\s+/);
  return parts[0] === '0' ? 0 : px(parts[1] || parts[0]);
};

// ── Files ────────────────────────────────────────────────────────────────────

test('defrag: every id the script looks up is in index.html once; ids, classes, CSS variables, keyframes, storage keys and exports are dfg- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'dfg-best', 'dfg-daily-button', 'dfg-disk', 'dfg-frag', 'dfg-frag-line', 'dfg-game', 'dfg-hint', 'dfg-hints',
    'dfg-meter-fill', 'dfg-mode', 'dfg-moves', 'dfg-next', 'dfg-note', 'dfg-par', 'dfg-prev', 'dfg-restart', 'dfg-share',
    'dfg-share-button', 'dfg-share-text', 'dfg-status', 'dfg-streak', 'dfg-toast', 'dfg-undo', 'dfg-warning'
  ]);
  assert.equal(ids.length, new Set(ids).size, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^dfg-/);

  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^dfg-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^dfg-/, selector);
    }
  }
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^dfg-/);
  for (const m of JS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^dfg-/);
  const keyframes = Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);
  assert.deepEqual(keyframes, ['dfg-blink', 'dfg-pulse']);
  for (const m of CSS.matchAll(/animation:\s*([\w-]+)/g)) assert.ok(m[1] === 'none' || keyframes.includes(m[1]), m[1]);
  assert.deepEqual([...new Set(Array.from(JS.matchAll(/'(dfg-(?:state|progress|daily))'/g), (m) => m[1]))].sort(), ['dfg-daily', 'dfg-progress', 'dfg-state']);
  // Every localStorage call goes through the two guarded helpers.
  assert.equal(JS.match(/localStorage\./g).length, 2);
  for (const name of Object.keys(dfg)) assert.match(name, /^dfg[A-Z]/);
});

test('defrag: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="dfg-wrapper" id="dfg-game"'));
  assert.deepEqual(embedSafety(embedded), []);
  const bg = CSS.match(/--dfg-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Defrag — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(|@font-face/, 'no network resources');
  }
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts)\b/, 'no network calls');
  assert.doesNotMatch(JS.replace(/\/\/[^\n]*/g, ''), /Math\.random/, 'every board comes from a seed');
  // Original names only: disk tracks and blocks, no tubes, balls or liquid.
  for (const text of [HTML, CSS, JS]) assert.doesNotMatch(text, /\b(tube|ball|bottle|liquid|water|potion|sort it)/i);
});

test('defrag: script.js is one strict IIFE in ES5', () => {
  assert.match(JS, /^(\/\/[^\n]*\r?\n)*\r?\n?\(function \(\) \{\r?\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1);
  assert.equal(JS.match(/^\}\)\(\);/gm).length, 1);
  const code = JS
    .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['nullish coalescing', /\?\?/], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['double-quoted string', /"/], ['async', /\basync\b|\bawait\b/],
    ['Promise-only syntax', /new Promise|Promise\./], ['method shorthand', /^\s+(?!if\b|for\b|while\b|switch\b|catch\b|function\b)\w+\s*\([^)]*\)\s*\{/m]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('defrag: index.html has labelled buttons, a focusable disk inside the game and live status lines', () => {
  const spec = htmlPageSpec(HTML);
  assert.equal(spec['dfg-disk'].attributes.tabindex, '0');
  assert.equal(spec['dfg-disk'].attributes.role, 'group');
  assert.ok(Object.keys(spec).filter((id) => id !== 'dfg-game').every((id) => {
    for (let at = spec[id]; at; at = spec[at.parent]) if (at.parent === 'dfg-game') return true;
    return false;
  }), 'every element sits inside the game');
  assert.equal(spec['dfg-share-text'].readOnly, true);
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
    }
  }
  for (const id of ['dfg-status', 'dfg-note', 'dfg-toast']) assert.equal(spec[id].attributes['aria-live'], 'polite', id);
  assert.equal(spec['dfg-warning'].attributes.role, 'alert');
  for (const id of ['dfg-warning', 'dfg-share', 'dfg-note', 'dfg-share-text']) assert.match(spec[id].className, /\bdfg-hidden\b/, id);
});

test('defrag: from 320 to 1440 px the disk, the stats and the controls fit without widening the page; two shelves on phones', () => {
  const rules = cssRules(CSS);
  for (let vw = 320; vw <= 1440; vw++) {
    const wrapper = declsAt(rules, '.dfg-wrapper', vw);
    const available = Math.min(vw, px(wrapper['max-width'])) - 2 * sidePad(wrapper.padding);
    assert.equal(declsAt(rules, '.dfg-wrapper *', vw)['box-sizing'], 'border-box');
    const consoleBox = declsAt(rules, '.dfg-console', vw);
    const disk = declsAt(rules, '.dfg-disk', vw);
    const inner = available - 2 * sidePad(consoleBox.padding) - 2 * px(consoleBox.border.split(/\s+/)[0]) -
      2 * sidePad(disk.padding) - 2 * px(disk.border.split(/\s+/)[0]);
    // Columns shrink with the page (minmax(0, ...)), so nothing widens it.
    const columns = /^repeat\(var\(--dfg-(tracks|shelf)\), minmax\(0, (1fr|\d+px)\)\)$/.exec(disk['grid-template-columns']);
    assert.ok(columns, vw + 'px: ' + disk['grid-template-columns']);
    assert.equal(columns[1] === 'shelf', vw <= 640, vw + 'px: shelves on phones only');
    const track = declsAt(rules, '.dfg-track', vw);
    const block = declsAt(rules, '.dfg-block', vw);
    const font = rem(block['font-size']);
    for (let count = 5; count <= 9; count++) {
      const cols = columns[1] === 'shelf' ? dfg.dfgShelfColumns(count) : count;
      const width = Math.min(columns[2] === '1fr' ? Infinity : px(columns[2]), (inner - (cols - 1) * px(disk.gap)) / cols);
      const content = width - 2 * px(track.padding) - 2 * px(track.border.split(/\s+/)[0]);
      assert.ok(width >= 46, vw + 'px: ' + count + ' tracks of ' + width.toFixed(1) + 'px');
      // The widest label, 'boot' or 'swap' (0.61em a character covers common monospace fonts).
      assert.ok(4 * 0.61 * font <= content - 2, vw + 'px: a block label in ' + content + 'px');
    }
    assert.ok(dfg.dfgShelfColumns(9) <= 5);
    // Six stat cards in equal shrinking columns; values wrap instead of being cut off.
    const stats = declsAt(rules, '.dfg-stats', vw);
    assert.match(stats['grid-template-columns'], /^repeat\([36], minmax\(0, 1fr\)\)$/);
    const value = declsAt(rules, '.dfg-stat-value', vw);
    assert.equal(value['white-space'], 'normal');
    assert.equal(value['overflow-wrap'], 'anywhere');
    assert.equal(value.overflow, undefined);
    // Text that can grow wraps.
    for (const sel of ['.dfg-mode', '.dfg-status', '.dfg-note', '.dfg-frag-line', '.dfg-warning', '.dfg-toast', '.dfg-subtitle', '.dfg-track-num']) {
      assert.equal(declsAt(rules, sel, vw)['overflow-wrap'], 'anywhere', vw + 'px ' + sel);
    }
    assert.equal(declsAt(rules, '.dfg-mode', vw)['min-width'], '0');
  }
  // A track is a flex column (its number, then its slots from the bottom up), never a <button>.
  assert.equal(declsAt(rules, '.dfg-track', 320).display, 'flex');
  assert.equal(declsAt(rules, '.dfg-track', 320)['flex-direction'], 'column');
  assert.equal(declsAt(rules, '.dfg-slots', 320)['flex-direction'], 'column-reverse');
  assert.doesNotMatch(JS, /createElement\('button'\)/);
  // Tap targets keep double-tap zoom away; nothing blocks scrolling.
  const touch = rules.filter((rule) => rule.decls['touch-action'] !== undefined);
  assert.deepEqual(touch.map((rule) => [rule.selectors, rule.decls['touch-action']]), [[['.dfg-btn'], 'manipulation'], [['.dfg-disk'], 'manipulation']]);
  // The toast is as wide as its message, up to the screen less 16 px a side.
  const toast = declsAt(rules, '.dfg-toast', 320);
  assert.equal(toast.width, 'max-content');
  assert.equal(toast['max-width'], 'calc(100vw - 32px)');
  assert.equal(toast['pointer-events'], 'none');
  // The disk's shadows stay inside it, and so does its focus ring.
  assert.match(declsAt(rules, '.dfg-disk--solved', 320)['box-shadow'], /^inset .*, inset /);
  assert.equal(declsAt(rules, '.dfg-disk:focus-visible', 320)['outline-offset'], '-2px');
  // Reduced motion stops the animations.
  const calm = { matchMedia: (q) => /prefers-reduced-motion: reduce/.test(q) };
  assert.equal(declsAt(rules, '.dfg-track--hint-from', 1280, calm).animation, 'none');
  assert.equal(declsAt(rules, '.dfg-prompt::after', 1280, calm).animation, 'none');
});

test('defrag: small text keeps 4.5:1 against its background and the outline of a free slot 3:1 (track numbers, stat labels, toasts)', () => {
  const rules = cssRules(CSS);
  const root = declsAt(rules, '.dfg-wrapper', 1280);
  const resolve = (value) => String(value).replace(/var\((--dfg-[\w-]+)\)/g, (m, name) => root[name]);
  // Every colour in a value: #rrggbb or rgb(a)(); a background's alpha only darkens it on the darker page.
  const colours = (value) => Array.from(resolve(value).matchAll(/#([0-9a-f]{6})\b|rgba?\((\d+),\s*(\d+),\s*(\d+)/gi), (m) =>
    (m[1] ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [m[2], m[3], m[4]].map(Number)));
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const at = (selector, prop) => declsAt(rules, selector, 1280)[prop];
  for (const [what, fg, bg, min] of [
    ['track number', at('.dfg-track-num', 'color'), at('.dfg-track', 'background'), 4.5],
    ['stat label', at('.dfg-stat-label', 'color'), at('.dfg-stat', 'background'), 4.5],
    ['toast', at('.dfg-toast', 'color'), at('.dfg-toast', 'background'), 4.5],
    ['free slot outline', at('.dfg-slot', 'border'), at('.dfg-track', 'background'), 3]
  ]) {
    const [front] = colours(fg);
    const backs = colours(bg);
    assert.ok(front && backs.length, what);
    for (const back of backs) assert.ok(ratio(front, back) >= min, what + ': ' + ratio(front, back).toFixed(2) + ':1 on ' + back);
  }
});

// ── Rules ────────────────────────────────────────────────────────────────────

test('defrag: moves follow the rules on random disks: the whole top fragment, onto an empty track or the same file, if it fits and the track is not reserved', () => {
  const rnd = seeded(11);
  const codes = new Set();
  for (let round = 0; round < 400; round++) {
    const { board, tracks } = randomCase(rnd);
    for (let a = 0; a < tracks.length; a++) {
      assert.equal(dfg.dfgTopRun(board, tracks, a), runModel(board, tracks, a), 'top run');
      for (let b = 0; b < tracks.length; b++) {
        const k = legalModel(board, tracks, a, b);
        const error = dfg.dfgMoveError(board, tracks, a, b);
        assert.equal(error === null, k > 0, JSON.stringify([tracks, a, b]));
        if (error) codes.add(error.code);
        if (k) assert.deepEqual(dfg.dfgApplyMove(tracks, a, b, k), moveModel(tracks, a, b, k));
      }
    }
    const legal = [];
    for (let a = 0; a < tracks.length; a++) {
      for (let b = 0; b < tracks.length; b++) if (legalModel(board, tracks, a, b)) legal.push([a, b, legalModel(board, tracks, a, b)]);
    }
    assert.deepEqual(dfg.dfgLegalMoves(board, tracks), legal);
  }
  assert.deepEqual([...codes].sort(), ['empty', 'fixed', 'reserved', 'room', 'same', 'top']);
  // Exact refusals on a hand-made disk: track 1 reserved for file 0.
  const board = { files: [{ size: 3 }, { size: 2 }, { size: 2 }], sys: [0, -1, -1, -1], capacity: 3 };
  const tracks = [[0], [1, 2, 2], [0, 0], []];
  assert.deepEqual(dfg.dfgMoveError(board, tracks, 0, 3), { code: 'fixed', a: 0, file: 0 });
  assert.deepEqual(dfg.dfgMoveError(board, tracks, 3, 0), { code: 'empty', a: 3, file: -1 });
  assert.deepEqual(dfg.dfgMoveError(board, tracks, 1, 0), { code: 'reserved', a: 1, b: 0, file: 2, count: 2, other: 0 });
  assert.deepEqual(dfg.dfgMoveError(board, tracks, 1, 2), { code: 'top', a: 1, b: 2, file: 2, count: 2, other: 0 });
  assert.deepEqual(dfg.dfgMoveError(board, [[0, 1], [1, 1, 2], [0, 0], []], 1, 2), { code: 'top', a: 1, b: 2, file: 2, count: 1, other: 0 });
  assert.deepEqual(dfg.dfgMoveError(board, [[0], [1, 2, 2], [0, 0, 2], []], 1, 2), { code: 'room', a: 1, b: 2, file: 2, count: 2, room: 0 });
  assert.equal(dfg.dfgMoveError(board, tracks, 2, 0), null, 'the reserved track takes its own file onto its fixed block');
  assert.equal(dfg.dfgTopRun(board, [[0, 0, 0]], 0), 2, 'the fixed block never moves with its file');
  assert.deepEqual(dfg.dfgApplyMove(tracks, 2, 0, 2), [[0, 0, 0], [1, 2, 2], [], []]);
  assert.deepEqual(tracks, [[0], [1, 2, 2], [0, 0], []], 'the input is left alone');
});

test('defrag: reverse moves are exactly the moves that a legal forward move undoes', () => {
  const rnd = seeded(5);
  let total = 0;
  for (let round = 0; round < 500; round++) {
    const { board, tracks } = randomCase(rnd);
    const sort = (list) => list.map((m) => m.join(',')).sort();
    const mine = dfg.dfgReverseMoves(board, tracks);
    assert.deepEqual(sort(mine), sort(reverseModel(board, tracks)), JSON.stringify({ board, tracks }));
    total += mine.length;
    // Every one gives a predecessor whose forward move comes back here.
    for (const [b, a, k] of mine) {
      const before = dfg.dfgApplyMove(tracks, b, a, k);
      assert.equal(legalModel(board, before, a, b), k);
      assert.deepEqual(moveModel(before, a, b, k), tracks);
    }
  }
  assert.ok(total > 1000);
  // A disk where every top fragment sits on another file has no past at all.
  const board = { files: [{ size: 2 }, { size: 2 }], sys: [-1, -1, -1], capacity: 2 };
  assert.deepEqual(dfg.dfgReverseMoves(board, [[0, 1], [1, 0], []]), []);
});

test('defrag: fragments, fragmentation, the solved test and the state key', () => {
  const rnd = seeded(3);
  for (let round = 0; round < 300; round++) {
    const { board, tracks } = randomCase(rnd);
    assert.equal(dfg.dfgExtra(board, tracks), extraModel(board, tracks));
    assert.equal(dfg.dfgIsSolved(board, tracks), solvedModel(board, tracks));
    const most = board.files.reduce((s, f) => s + f.size - 1, 0);
    const frag = dfg.dfgFragmentation(board, tracks);
    assert.equal(frag, Math.ceil(100 * extraModel(board, tracks) / most));
    assert.equal(frag === 0, solvedModel(board, tracks), 'only a defragmented disk reads 0%');
    // Loose tracks may swap; reserved ones stay put.
    const loose = tracks.map((x, t) => t).filter((t) => board.sys[t] < 0);
    const swapped = copy(tracks);
    const [x, y] = [loose[0], loose[loose.length - 1]];
    [swapped[x], swapped[y]] = [swapped[y], swapped[x]];
    assert.equal(dfg.dfgKey(board, swapped), dfg.dfgKey(board, tracks));
  }
  const board = { files: [{ size: 2 }, { size: 3 }], sys: [0, -1, -1], capacity: 3 };
  assert.equal(dfg.dfgKey(board, [[0, 1], [1, 1], [0]]), 'ab#a|bb');
  assert.notEqual(dfg.dfgKey(board, [[0, 1], [1, 1], [0]]), dfg.dfgKey({ files: board.files, sys: [-1, -1, -1], capacity: 3 }, [[0, 1], [1, 1], [0]]));
  // Every block on its own: 100%.
  const spread = { files: [{ size: 2 }, { size: 2 }], sys: [-1, -1], capacity: 4 };
  assert.equal(dfg.dfgFragmentation(spread, [[0, 1, 0, 1], []]), 100);
  assert.equal(dfg.dfgFragmentation(spread, [[0, 0, 1], [1]]), 50);
  assert.equal(dfg.dfgFragmentation(spread, [[0, 0, 1, 1], []]), 0, 'two files may share a track, each in one run');
});

test('defrag: the solver\'s moves leave out only tracks swapping places, fewest fragments first', () => {
  const board = { files: [{ size: 2 }, { size: 2 }], sys: [-1, -1, -1, -1], capacity: 3 };
  const tracks = [[0, 1], [1, 0], [], []];
  const all = dfg.dfgLegalMoves(board, tracks);
  assert.deepEqual(all, [[0, 2, 1], [0, 3, 1], [1, 2, 1], [1, 3, 1]]);
  const kids = dfg.dfgChildren(board, tracks);
  assert.deepEqual(kids.map((c) => c.move), [[0, 2, 1], [1, 2, 1]], 'onto the first empty track only');
  assert.deepEqual(kids.map((c) => c.h), [2, 2]);
  // A whole track's single fragment onto an empty track only swaps tracks.
  const lone = [[0, 0], [1], [1], []];
  assert.deepEqual(dfg.dfgLegalMoves(board, lone), [[0, 3, 2], [1, 2, 1], [1, 3, 1], [2, 1, 1], [2, 3, 1]]);
  assert.deepEqual(dfg.dfgChildren(board, lone).map((c) => [c.move, c.h]), [[[1, 2, 1], 0], [[2, 1, 1], 0]]);
  // Ordered by the fragments left, then as generated.
  const mixed = [[0, 1], [1], [0], []];
  assert.deepEqual(dfg.dfgChildren(board, mixed).map((c) => c.h), [1, 1, 2]);
});

// ── Solver ───────────────────────────────────────────────────────────────────

test('defrag: the solver finds the shortest route by breadth-first search, or proves there is none', () => {
  const rnd = seeded(17);
  let solved = 0;
  let dead = 0;
  for (let round = 0; round < 250; round++) {
    const { board, tracks } = randomCase(rnd);
    const where = JSON.stringify({ board, tracks });
    const min = bfsMin(board, tracks);
    const ida = dfg.dfgIda(board, tracks, 200000, 200);
    const explore = dfg.dfgExplore(board, tracks, 200000);
    const solve = dfg.dfgSolve(board, tracks, { solve: 200000, search: 200000 });
    if (min === -1) {
      dead++;
      assert.equal(ida.status, 'dead', where);
      assert.equal(explore.status, 'dead', where);
      assert.deepEqual([solve.status, solve.path, solve.optimal], ['dead', null, false]);
      continue;
    }
    solved++;
    assert.equal(ida.status, 'solved', where);
    assert.equal(ida.path.length, min, where + ': the shortest route');
    assert.ok(solvedModel(board, playModel(board, tracks, ida.path, where)), where);
    assert.equal(explore.status, 'solved', where);
    assert.ok(explore.path.length >= min);
    assert.ok(solvedModel(board, playModel(board, tracks, explore.path, where)), where);
    assert.deepEqual([solve.status, solve.path.length, solve.optimal], ['solved', min, true]);
    assert.ok(dfg.dfgExtra(board, tracks) <= min, 'the fragments left never overestimate the moves');
  }
  assert.ok(solved > 100 && dead > 10, solved + ' solved, ' + dead + ' dead');
});

test('defrag: the solver\'s node caps: unknown with a lower bound, beyond a route length, and the full search behind the shortest one', () => {
  const board = dfg.dfgLevelBoard(4);
  const ida = dfg.dfgIda(board, board.start, 3, 200);
  assert.equal(ida.status, 'unknown');
  assert.equal(ida.nodes, 3);
  assert.equal(ida.lower, dfg.dfgExtra(board, board.start));
  const beyond = dfg.dfgIda(board, board.start, 200000, 4);
  assert.equal(beyond.status, 'beyond');
  assert.ok(beyond.lower > 4);
  assert.deepEqual(dfg.dfgExplore(board, board.start, 2), { status: 'unknown', nodes: 2 });
  // With the shortest-route search stopped at once the full search finds a route.
  const route = dfg.dfgSolve(board, board.start, { solve: 1, search: 50000 });
  assert.equal(route.status, 'solved');
  assert.equal(route.optimal, false);
  assert.ok(solvedModel(board, playModel(board, board.start, route.path, 'level 4')));
  // Both searches ran out: nodes counts the states of both.
  const both = dfg.dfgSolve(board, board.start, { solve: 3, search: 2 });
  assert.deepEqual(both, { status: 'unknown', path: null, optimal: false, nodes: 5 });
  assert.equal(dfg.dfgHintText(board, board.start, both), 'No hint: the search stopped after 5 states without a route. Undo a move and ask again.');
  // A solved disk needs no move.
  assert.deepEqual(dfg.dfgIda(board, board.goal, 10, 10), { status: 'solved', path: [], nodes: 1 });
  assert.deepEqual(dfg.dfgExplore(board, board.goal, 10), { status: 'solved', path: [], nodes: 1 });
});

// ── Boards ───────────────────────────────────────────────────────────────────

test('defrag: the level table grows from 4 files to 8 on 6 to 9 tracks, then repeats its last four rows', () => {
  let previous = 0;
  for (let level = 1; level <= 40; level++) {
    const c = dfg.dfgLevelConfig(level);
    assert.ok(c.files + c.free >= 6 && c.files + c.free <= 9, level + ': ' + (c.files + c.free) + ' tracks');
    assert.ok(c.files >= 4, level + ': ' + c.files + ' files');
    assert.ok(c.free >= 1 && c.free <= 2);
    assert.ok([4, 5].includes(c.capacity));
    assert.ok(c.system <= 2 && c.system < c.files);
    assert.ok(c.minMoves >= 4);
    if (level <= 12) assert.ok(c.files >= previous, 'files never fewer than the level before');
    previous = c.files;
    if (level > 16) assert.deepEqual(c, dfg.dfgLevelConfig(level - 4));
  }
  assert.deepEqual(dfg.dfgLevelConfig(1), { files: 4, free: 2, capacity: 4, mixed: false, system: 0, minMoves: 5, scramble: 24 });
  assert.equal(dfg.dfgLevelConfig(5).system, 1, 'system files from level 5');
  assert.equal(dfg.dfgLevelConfig(3).mixed, true, 'files of different sizes from level 3');
  assert.equal(dfg.dfgLevelConfig(14).files + dfg.dfgLevelConfig(14).free, 9);
  assert.deepEqual(dfg.dfgDailyConfig(), { files: 6, free: 2, capacity: 5, mixed: true, system: 1, minMoves: 12, scramble: 56 });
  assert.equal(dfg.dfgLevelConfig(999).files, dfg.dfgLevelConfig(15).files);
});

test('defrag: files: system files first, regular ones drawn from the list, mixed sizes never all the same', () => {
  const config = { files: 5, free: 2, capacity: 5, mixed: true, system: 2, minMoves: 5, scramble: 10 };
  const files = dfg.dfgMakeFiles(config, seeded(1));
  assert.deepEqual(files.slice(0, 2).map((f) => [f.name, f.system]), [['boot.sys', true], ['swap.sys', true]]);
  assert.ok(files.slice(2).every((f) => !f.system && /^[a-z]+\.(log|iso|db|jpg|txt|tar|mp4|cfg)$/.test(f.name)));
  assert.equal(new Set(files.map((f) => f.ext)).size, 5);
  for (const f of files) assert.ok(f.size >= 3 && f.size <= 5);
  // A source that draws only full files, or only files one under full, still mixes them.
  const full = dfg.dfgMakeFiles(config, () => 0).map((f) => f.size);
  assert.deepEqual(full, [5, 5, 5, 5, 4]);
  const under = dfg.dfgMakeFiles(config, () => 0.5).map((f) => f.size);
  assert.deepEqual(under, [4, 4, 4, 4, 5]);
  assert.deepEqual(dfg.dfgMakeFiles(Object.assign({}, config, { mixed: false }), () => 0).map((f) => f.size), [5, 5, 5, 5, 5]);
  const layout = dfg.dfgSolvedLayout(files, config);
  assert.deepEqual(layout.sys, [0, 1, -1, -1, -1, -1, -1]);
  assert.deepEqual(layout.tracks, files.map((f, i) => new Array(f.size).fill(i)).concat([[], []]));
});

test('defrag: levels 1-24 and Dailies are scrambled by legal reverse moves, need at least their minimum moves (checked by searches of the test\'s own), and par is a route', (t) => {
  t.mock.method(Math, 'random', () => {
    throw new Error('boards never use Math.random');
  });
  const boards = [];
  for (let level = 1; level <= 24; level++) boards.push(['level ' + level, dfg.dfgLevelConfig(level), dfg.dfgLevelBoard(level)]);
  for (const key of ['2026-11-01', KEY6, KEY7, '2027-03-28', '2026-12-31']) boards.push(['Daily ' + key, dfg.dfgDailyConfig(), dfg.dfgDailyBoard(key)]);
  for (const [where, config, board] of boards) {
    assert.equal(board.sys.length, config.files + config.free, where);
    assert.equal(board.files.length, config.files, where);
    assert.equal(board.files.filter((f) => f.system).length, config.system, where);
    assert.ok(board.sys.length <= 9);
    if (config.mixed) assert.ok(new Set(board.files.map((f) => f.size)).size > 1, where + ': files of different sizes');
    assert.deepEqual(dfg.dfgValidTracks(board.start, board), board.start, where + ': a state of the board');
    assert.ok(solvedModel(board, board.goal), where + ': the goal is defragmented');
    assert.deepEqual(dfg.dfgValidTracks(board.goal, board), board.goal);
    board.sys.forEach((file, t2) => {
      if (file >= 0) assert.equal(board.start[t2][0], file, where + ': the fixed block stays at the bottom');
    });
    assert.ok(!solvedModel(board, board.start), where + ': scrambled');
    assert.ok(board.least >= config.minMoves, where + ': needs ' + board.least + ' moves or more');
    assert.ok(board.par >= board.least && board.par <= board.steps, where + ': par ' + board.par);
    const route = dfg.dfgSolve(board, board.start, dfg.dfgLimits);
    assert.equal(route.status, 'solved', where);
    assert.equal(board.par, Math.min(route.path.length, board.steps), where);
    assert.ok(solvedModel(board, playModel(board, board.start, route.path, where)), where);
    assert.ok(dfg.dfgFragmentation(board, board.start) >= 30, where);
  }
  // Small levels checked by breadth-first search: the minimum really is that high, and par is it.
  for (let level = 1; level <= 6; level++) {
    const board = dfg.dfgLevelBoard(level);
    const min = bfsMin(board, board.start);
    assert.ok(min >= dfg.dfgLevelConfig(level).minMoves, 'level ' + level + ' needs ' + min);
    assert.equal(board.par, min, 'level ' + level + ': par is the shortest route');
    assert.ok(board.least <= min);
  }
  // Larger disks (8 and 9 tracks, one or two system files) and the Dailies,
  // checked by a search of the test's own: no route is shorter than the
  // fewest moves the solver proved, and par is a route.
  for (const [where, config, board] of boards.slice(6)) {
    assert.equal(routeWithin(board, board.start, board.least - 1), false, where + ': no route under ' + board.least + ' moves');
    assert.ok(board.least >= config.minMoves, where);
    assert.equal(routeWithin(board, board.start, board.par), true, where + ': a route of ' + board.par + ' moves');
  }
  assert.deepEqual(dfg.dfgLevelBoard(1).start, LEVEL1_START);
  assert.equal(dfg.dfgLevelBoard(1).par, LEVEL1_PAR);
  assert.deepEqual(dfg.dfgLevelBoard(2).start, LEVEL2_START);
  assert.equal(dfg.dfgLevelBoard(1), dfg.dfgLevelBoard(1), 'made once, then cached');
});

test('defrag: a scramble never steps straight back, stops where no reverse move is left, and generation keeps the hardest board when none reaches the minimum', () => {
  const board = { files: [{ size: 3 }, { size: 3 }], sys: [-1, -1, -1, -1], capacity: 4 };
  const solved = [[0, 0, 0], [1, 1, 1], [], []];
  let full = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const walk2 = dfg.dfgScramble(board, solved, 20, seeded(seed));
    assert.ok(walk2.moves.length >= 1 && walk2.moves.length <= 20);
    let cur = solved;
    walk2.moves.forEach((m, i) => {
      const prev = walk2.moves[i - 1];
      if (prev) assert.ok(!(m[0] === prev[1] && m[1] === prev[0] && m[2] === prev[2]), 'step ' + i + ' goes back');
      cur = dfg.dfgApplyMove(cur, m[0], m[1], m[2]);
    });
    assert.deepEqual(cur, walk2.tracks);
    // It stops early only where the one reverse move left would go straight back.
    const last = walk2.moves[walk2.moves.length - 1];
    if (walk2.moves.length < 20) {
      assert.deepEqual(dfg.dfgReverseMoves(board, cur).filter((m) => !(m[0] === last[1] && m[1] === last[0] && m[2] === last[2])), []);
    } else {
      full++;
    }
  }
  assert.ok(full > 0 && full < 30, full + ' walks ran all 20 steps');
  const stuck = dfg.dfgScramble({ files: [{ size: 2 }, { size: 2 }], sys: [-1, -1], capacity: 2 }, [[0, 0], [1, 1]], 10, seeded(1));
  assert.deepEqual(stuck, { tracks: [[0, 0], [1, 1]], moves: [] });
  // Search caps of one node: every try stops at its lower bound, the best is kept and par is the scramble.
  const config = dfg.dfgLevelConfig(4);
  const tiny = dfg.dfgGenerate(config, seeded(9), { solve: 1, search: 1, check: 1 });
  assert.equal(tiny.least, dfg.dfgExtra(tiny, tiny.start));
  assert.equal(tiny.par, tiny.steps);
  // A target no board reaches: the hardest of the tries is kept, with its shortest route as par.
  const hard = dfg.dfgGenerate(Object.assign({}, config, { minMoves: 60 }), seeded(9));
  assert.ok(hard.least < 60);
  assert.equal(hard.par, Math.min(hard.steps, bfsMin(hard, hard.start)));
  // A broken random source (always 0) still gives a scrambled, solvable board.
  const zero = dfg.dfgGenerate(dfg.dfgLevelConfig(2), () => 0);
  assert.ok(!solvedModel(zero, zero.start));
  assert.ok(bfsMin(zero, zero.start) > 0);
});

test('defrag: the board cache keeps at most 40 boards', () => {
  const fresh = loadScript(SCRIPT);
  const first = fresh.dfgDailyBoard('2027-01-01');
  assert.equal(fresh.dfgDailyBoard('2027-01-01'), first);
  // Any seed text makes a board: 39 more of them fill the cache.
  for (let d = 2; d <= 40; d++) fresh.dfgDailyBoard('2027-01-' + String(d).padStart(2, '0'));
  assert.equal(fresh.dfgDailyBoard('2027-01-01'), first, 'still cached with 40 boards');
  fresh.dfgDailyBoard('2027-02-01');
  const again = fresh.dfgDailyBoard('2027-01-01');
  assert.notEqual(again, first, 'the 41st board empties the cache');
  assert.deepEqual(again, first, 'and the board made again is the same');
});

// ── Daily ────────────────────────────────────────────────────────────────────

test('defrag: FNV-1a and mulberry32 match their reference values, and the Daily comes from "dfg:" + the date, pinned for 2026-11-06', (t) => {
  assert.equal(dfg.dfgHash(''), 0x811c9dc5);
  assert.equal(dfg.dfgHash('a'), 0xe40c292c);
  assert.equal(dfg.dfgHash('foobar'), 0xbf9cf968);
  for (const text of ['dfg:2026-11-01', 'dfg:' + KEY6, 'dfg:level:7']) assert.equal(dfg.dfgHash(text), fnv1a(text), text);
  for (const seed of [0, 1, 42, 0xffffffff, dfg.dfgHash('dfg:' + KEY6)]) {
    const mine = dfg.dfgMulberry32(seed);
    const reference = seeded(seed);
    for (let i = 0; i < 20; i++) assert.equal(mine(), reference(), 'seed ' + seed + ' draw ' + i);
  }
  t.mock.method(Math, 'random', () => {
    throw new Error('the Daily never uses Math.random');
  });
  const fresh = loadScript(SCRIPT);
  const daily = fresh.dfgDailyBoard(KEY6);
  assert.deepEqual(daily, fresh.dfgGenerate(fresh.dfgDailyConfig(), seeded(fnv1a('dfg:' + KEY6))));
  assert.deepEqual(daily, DAILY6);
  assert.equal(dfg.dfgFragmentation(daily, daily.start), 53);
  assert.notDeepEqual(fresh.dfgDailyBoard(KEY7).start, daily.start);
  // Levels come from "dfg:level:" + the number the same way.
  assert.deepEqual(fresh.dfgLevelBoard(3), fresh.dfgGenerate(fresh.dfgLevelConfig(3), seeded(fnv1a('dfg:level:3'))));
});

test('defrag: the day key is the local date and #1 is 2026-11-01, counted without a jump at daylight saving changes', () => {
  const info = (...args) => dfg.dfgDayInfo(new Date(...args));
  assert.deepEqual(info(2026, 10, 1, 0, 0, 1), { key: '2026-11-01', day: 1 });
  assert.deepEqual(info(2026, 10, 6, 0, 0, 0), { key: KEY6, day: 6 });
  assert.deepEqual(info(2026, 10, 6, 23, 59, 59), { key: KEY6, day: 6 });
  assert.deepEqual(info(2026, 9, 31, 12), { key: '2026-10-31', day: 0 });
  assert.deepEqual(info(2027, 0, 1, 12), { key: '2027-01-01', day: 62 });
  let previous = info(2026, 9, 1, 12).day;
  for (let k = 1; k < 200; k++) {
    for (const hour of [0, 12, 23]) {
      const today = info(2026, 9, 1 + k, hour);
      assert.equal(today.day, previous + 1, today.key + ' ' + hour + ':00');
      assert.equal(dfg.dfgKeyDay(today.key), today.day);
    }
    previous += 1;
  }
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-01', 'today', '', null, 20261106, '2026-11-06T00:00']) {
    assert.equal(dfg.dfgKeyDay(bad), null, String(bad));
  }
});

test('defrag: the streak lasts while the last win is today or yesterday; the share line; which of two tabs\' Daily records wins', () => {
  assert.equal(dfg.dfgLiveStreak({ streak: 4, lastWon: 6 }, 6), 4);
  assert.equal(dfg.dfgLiveStreak({ streak: 4, lastWon: 5 }, 6), 4);
  assert.equal(dfg.dfgLiveStreak({ streak: 4, lastWon: 4 }, 6), 0);
  assert.equal(dfg.dfgLiveStreak({ streak: 4, lastWon: null }, 6), 0);
  const result = (moves, undos, hints) => ({ moves, undos, hints });
  assert.equal(dfg.dfgShareText(6, 64, result(14, 0, 0), 13), 'Defrag #6 fragmentation 64% → 0% in 14 moves (par ≤ 13)');
  assert.equal(dfg.dfgShareText(7, 50, result(1, 0, 1), 1), 'Defrag #7 fragmentation 50% → 0% in 1 move (par ≤ 1), 1 hint');
  assert.equal(dfg.dfgShareText(7, 50, result(9, 0, 3), 8), 'Defrag #7 fragmentation 50% → 0% in 9 moves (par ≤ 8), 3 hints');
  // The moves are net of undos, so the undos are named: trying routes and undoing them shows.
  assert.equal(dfg.dfgShareText(6, 53, result(12, 1, 0), 12), 'Defrag #6 fragmentation 53% → 0% in 12 moves (par ≤ 12), 1 undo');
  assert.equal(dfg.dfgShareText(6, 53, result(12, 7, 2), 12), 'Defrag #6 fragmentation 53% → 0% in 12 moves (par ≤ 12), 7 undos, 2 hints');
  const rec = (key, day, status, moves, undos, hints = 0) => ({ key, day, status, game: key ? { moves, undos, hints } : null });
  const none = rec(null, 0, 'playing');
  assert.equal(dfg.dfgIsNewerDaily(none, rec(KEY6, 6, 'playing', 1, 0), 6), false, 'no record');
  assert.equal(dfg.dfgIsNewerDaily(rec(KEY6, 6, 'playing', 0, 0), none, 6), true, 'ours has none');
  assert.equal(dfg.dfgIsNewerDaily(rec(KEY7, 7, 'playing', 0, 0), none, 6), false, 'from after today');
  assert.equal(dfg.dfgIsNewerDaily(rec(KEY6, 6, 'playing', 0, 0), rec('2026-11-05', 5, 'won', 9, 0), 6), true, 'a later Daily');
  assert.equal(dfg.dfgIsNewerDaily(rec('2026-11-05', 5, 'won', 9, 0), rec(KEY6, 6, 'playing', 0, 0), 6), false, 'an earlier one');
  assert.equal(dfg.dfgIsNewerDaily(rec(KEY6, 6, 'won', 9, 0), rec(KEY6, 6, 'playing', 20, 3), 6), true, 'defragmented');
  assert.equal(dfg.dfgIsNewerDaily(rec(KEY6, 6, 'playing', 20, 3), rec(KEY6, 6, 'won', 9, 0), 6), false);
  // Further along: every move, undo and hint is one step (moves + 2 x undos + hints).
  assert.equal(dfg.dfgIsNewerDaily(rec(KEY6, 6, 'playing', 3, 1), rec(KEY6, 6, 'playing', 4, 0), 6), true, '5 steps over 4');
  assert.equal(dfg.dfgIsNewerDaily(rec(KEY6, 6, 'playing', 4, 0), rec(KEY6, 6, 'playing', 2, 1), 6), false, 'as many steps');
  assert.equal(dfg.dfgIsNewerDaily(rec(KEY6, 6, 'playing', 2, 0, 1), rec(KEY6, 6, 'playing', 2, 0, 0), 6), true, 'a hint is a step');
  assert.equal(dfg.dfgIsNewerDaily(rec(KEY6, 6, 'playing', 2, 0, 0), rec(KEY6, 6, 'playing', 2, 0, 1), 6), false);
  // The steps of a game against a model: one per action, whatever the mix.
  const rnd = seeded(23);
  for (let round = 0; round < 200; round++) {
    const game = { moves: 0, undos: 0, hints: 0 };
    let actions = 0;
    for (let i = 0; i < 30; i++) {
      const pick = rnd();
      if (pick < 0.5) game.moves++;
      else if (pick < 0.75 && game.moves > 0) { game.moves--; game.undos++; }
      else game.hints++;
      actions++;
      assert.equal(dfg.dfgSteps(game), actions);
    }
  }
});

test('defrag: keys map to actions by their value, then by the physical key', () => {
  const action = (key, code) => dfg.dfgKeyAction({ key, code });
  assert.deepEqual(['1', '5', '9', 'u', 'U', 'h', 'r', 'n', 'N', 'Escape'].map((k) => action(k, '')),
    ['track1', 'track5', 'track9', 'undo', 'undo', 'hint', 'restart', 'next', 'next', 'cancel']);
  assert.equal(action('&', 'Digit1'), 'track1', 'AZERTY');
  assert.equal(action('End', 'Numpad3'), 'track3', 'the keypad without Num Lock');
  assert.equal(action('г', 'KeyU'), 'undo');
  assert.equal(action('р', 'KeyH'), 'hint');
  assert.equal(action('к', 'KeyR'), 'restart');
  assert.equal(action('т', 'KeyN'), 'next');
  for (const [key, code] of [['0', 'Digit0'], ['x', 'KeyX'], [' ', 'Space'], ['Enter', 'Enter'], ['ArrowLeft', 'ArrowLeft']]) {
    assert.equal(action(key, code), null, key);
  }
  assert.equal(dfg.dfgKeyAction({ code: 'KeyU' }), null, 'a keydown without a key (autofill)');
});

// ── Saves ────────────────────────────────────────────────────────────────────

test('defrag: tracks, histories and replays are checked against the board', () => {
  const board = dfg.dfgLevelBoard(2);
  const state = JSON.parse(SAMPLE_STATE);
  assert.deepEqual(dfg.dfgValidTracks(state.tracks, board), state.tracks);
  assert.equal(dfg.dfgHistoryFits(board, state.tracks, state.history), true);
  assert.deepEqual(dfg.dfgReplay(board, state.history), state.tracks);
  for (const [name, tracks] of Object.entries({
    'not a list': 'x',
    'a track short': state.tracks.slice(1),
    'a track not a list': [5].concat(state.tracks.slice(1)),
    'an overfull track': [[0, 0, 0, 0, 1]].concat(state.tracks.slice(1)),
    'a foreign file': [[9]].concat(state.tracks.slice(1)),
    'a fraction': [[0.5]].concat(state.tracks.slice(1)),
    'a block lost': [[]].concat(state.tracks.slice(1, 5), [[1]]),
    'a block too many': [[1]].concat(state.tracks.slice(1))
  })) {
    assert.equal(dfg.dfgValidTracks(tracks, board), null, name);
  }
  // A reserved track must keep its own file at the bottom.
  const sysBoard = dfg.dfgLevelBoard(5);
  const at = sysBoard.sys.findIndex((f) => f >= 0);
  const moved = copy(sysBoard.start);
  moved[at] = moved[at].slice().reverse();
  assert.notEqual(moved[at][0], sysBoard.sys[at]);
  assert.equal(dfg.dfgValidTracks(moved, sysBoard), null);
  // Histories that do not lead to the tracks.
  assert.equal(dfg.dfgHistoryFits(board, state.tracks, [[0, 4, 1]]), false, 'does not start at the start');
  assert.equal(dfg.dfgHistoryFits(board, state.tracks, [[0, 4, 1], [0, 2, 2]]), false, 'more blocks than are on top');
  assert.equal(dfg.dfgHistoryFits(board, state.tracks, [[0, 4, 1], [1, 2, 1]]), false, 'the blocks would not fit back');
  assert.equal(dfg.dfgHistoryFits(board, [[0, 1], [0, 1, 3], [3, 0], [3, 0, 3, 2], [2, 2, 1], [1, 2]], [[1, 3, 1]]), false, 'an illegal move');
  assert.equal(dfg.dfgReplay(board, [[2, 0, 1]]), null, 'an illegal move');
  assert.equal(dfg.dfgReplay(board, [[0, 4, 2]]), null, 'more blocks than the fragment');
  // A history cut at 500 moves need not reach the start.
  const loop = [];
  let cur = board.start;
  while (loop.length < 500) {
    const [a, b, k] = dfg.dfgLegalMoves(board, cur)[0];
    loop.push([a, b, k]);
    cur = dfg.dfgApplyMove(cur, a, b, k);
  }
  assert.equal(dfg.dfgHistoryFits(board, cur, loop), true);
  assert.equal(dfg.dfgHistoryFits(board, cur, loop.slice(1)), false);
});

test('defrag: dfgParseState reads a save of the current format and falls back field by field', () => {
  const parsed = dfg.dfgParseState(SAMPLE_STATE, 1);
  const raw = JSON.parse(SAMPLE_STATE);
  assert.equal(parsed.view, 'level');
  assert.equal(parsed.level, 2);
  assert.deepEqual([parsed.game.kind, parsed.game.id], ['level', 2]);
  assert.deepEqual(parsed.game.tracks, raw.tracks);
  assert.deepEqual(parsed.game.history, raw.history);
  assert.deepEqual([parsed.game.moves, parsed.game.undos, parsed.game.hints, parsed.game.solved], [2, 1, 1, false]);
  assert.equal(parsed.game.board, dfg.dfgLevelBoard(2));
  const with_ = (extra) => JSON.stringify(Object.assign({}, raw, extra));
  const game = (extra, highest = 1) => dfg.dfgParseState(with_(extra), highest).game;
  // Tracks: damaged ones are rebuilt from the history, else the start.
  assert.deepEqual(game({ tracks: 'x' }).tracks, raw.tracks);
  assert.deepEqual(game({ tracks: 'x' }).history, raw.history);
  assert.deepEqual(game({ tracks: 'x', history: [[2, 0, 1]] }).tracks, LEVEL2_START);
  assert.deepEqual(game({ tracks: 'x', history: [[2, 0, 1]] }).history, []);
  assert.deepEqual(game({ tracks: 'x', history: null }).tracks, LEVEL2_START);
  // The history: kept only when it leads to the tracks.
  assert.deepEqual(game({ history: [[0, 4, 1]] }).history, []);
  assert.deepEqual(game({ history: [[0, 4, 1]] }).tracks, raw.tracks, 'the tracks stay');
  for (const history of [5, [[0, 4]], [[0, 4, 0]], [[0, 9, 1]], [[-1, 4, 1]], [[0, 4, 1.5]], [[0, '4', 1]], new Array(501).fill([0, 4, 1])]) {
    assert.deepEqual(game({ history }).history, [], JSON.stringify(history).slice(0, 40));
  }
  // Counts.
  assert.equal(game({ moves: -1 }).moves, 2, 'the history length');
  assert.equal(game({ moves: 'many' }).moves, 2);
  // Moves below the history's own two moves cannot be: the history's length.
  assert.equal(game({ moves: 0 }).moves, 2);
  assert.equal(game({ moves: 1 }).moves, 2);
  assert.equal(game({ moves: 7 }).moves, 7, 'more moves than the history holds: kept');
  assert.equal(game({ moves: 0, history: [[0, 4, 1]] }).moves, 0, 'a history that does not fit is dropped, so 0 stays');
  assert.equal(game({ undos: 1.5 }).undos, 0);
  assert.equal(game({ hints: null }).hints, 0);
  // The level: only an open one; otherwise the next to play, fresh.
  assert.equal(dfg.dfgParseState(SAMPLE_STATE, 0).level, 1, 'level 2 is not open before level 1 is done');
  assert.deepEqual(dfg.dfgParseState(SAMPLE_STATE, 0).game.tracks, LEVEL1_START);
  assert.equal(dfg.dfgParseState(with_({ level: 0 }), 3).level, 4);
  assert.equal(dfg.dfgParseState(with_({ level: '2' }), 3).level, 4);
  assert.equal(dfg.dfgParseState(with_({ level: 1000 }), 999).level, 999);
  assert.equal(dfg.dfgParseState(with_({ view: 'daily' }), 1).view, 'daily');
  assert.equal(dfg.dfgParseState(with_({ view: 'other' }), 1).view, 'level');
  for (const text of [null, '', '{', '[]', '"x"', '42', 'null']) {
    const fresh = dfg.dfgParseState(text, 0);
    assert.deepEqual([fresh.view, fresh.level, fresh.game.moves, fresh.game.history], ['level', 1, 0, []], String(text));
    assert.deepEqual(fresh.game.tracks, LEVEL1_START);
  }
  // A solved save stays solved.
  const done = dfg.dfgParseState(JSON.stringify({ level: 1, tracks: dfg.dfgLevelBoard(1).goal, moves: 6 }), 0).game;
  assert.equal(done.solved, true);
});

test('defrag: dfgParseProgress and dfgMergeProgress keep the highest level and the fewest moves per level, each on its own', () => {
  assert.deepEqual(dfg.dfgParseProgress(SAMPLE_PROGRESS), { highest: 1, moves: { 1: 9 } });
  assert.deepEqual(dfg.dfgParseProgress(JSON.stringify({ highest: 3, moves: { 1: 6, 2: -1, 3: 'x', x: 4, '04': 5, 0: 2, 1000: 3, 999: 8 } })),
    { highest: 3, moves: { 1: 6, 999: 8 } });
  assert.deepEqual(dfg.dfgParseProgress(JSON.stringify({ highest: -2, moves: [] })), { highest: 0, moves: {} });
  assert.deepEqual(dfg.dfgParseProgress(JSON.stringify({ highest: 5000 })), { highest: 999, moves: {} });
  for (const text of [null, '{', '[1]', '7']) assert.deepEqual(dfg.dfgParseProgress(text), { highest: 0, moves: {} });
  const a = { highest: 4, moves: { 1: 6, 2: 12 } };
  const b = { highest: 2, moves: { 2: 10, 3: 9 } };
  assert.deepEqual(dfg.dfgMergeProgress(a, b), { highest: 4, moves: { 1: 6, 2: 10, 3: 9 } });
  assert.deepEqual(dfg.dfgMergeProgress(b, a), { highest: 4, moves: { 1: 6, 2: 10, 3: 9 } });
});

test('defrag: dfgParseDaily keeps the attempt, its result and the streak, each field on its own', () => {
  const daily = dfg.dfgParseDaily(SAMPLE_DAILY);
  const raw = JSON.parse(SAMPLE_DAILY);
  assert.deepEqual([daily.key, daily.day, daily.status, daily.streak, daily.lastWon], [KEY6, 6, 'playing', 2, 5]);
  assert.deepEqual([daily.game.kind, daily.game.id], ['daily', KEY6]);
  assert.deepEqual(daily.game.tracks, raw.tracks);
  assert.deepEqual(daily.game.history, raw.history);
  assert.equal(daily.game.board, dfg.dfgDailyBoard(KEY6));
  const parse = (extra) => dfg.dfgParseDaily(JSON.stringify(Object.assign({}, raw, extra)));
  // No valid key: no attempt, the streak stays.
  for (const key of ['2026-02-30', 'x', null, 6]) {
    const none = parse({ key });
    assert.deepEqual([none.key, none.day, none.game, none.streak, none.lastWon], [null, 0, null, 2, 5], String(key));
  }
  assert.deepEqual([parse({ streak: -1 }).streak, parse({ lastWon: 'x' }).lastWon, parse({ lastWon: 4.5 }).lastWon], [0, null, null]);
  assert.equal(parse({ status: 'lost' }).status, 'playing');
  // The day comes from the key, never the saved number.
  assert.equal(parse({ day: 99 }).day, 6);
  // A win that is not defragmented shows the board's goal; a defragmented attempt still playing starts over.
  const won = parse({ status: 'won' });
  assert.deepEqual([won.status, won.game.solved, won.game.tracks, won.game.history], ['won', true, DAILY6.goal, []]);
  const tooEarly = parse({ tracks: DAILY6.goal, history: [] });
  assert.deepEqual([tooEarly.status, tooEarly.game.solved, tooEarly.game.tracks], ['playing', false, DAILY6.start]);
  const real = parse({ status: 'won', tracks: [[1, 1, 1, 1], [5, 5, 5, 5], [0, 0, 0, 0], [2, 2, 2, 2, 2], [3, 3, 3, 3], [], [4, 4, 4, 4], []], history: [], moves: 15 });
  assert.deepEqual([real.status, real.game.moves, real.game.tracks[6]], ['won', 15, [4, 4, 4, 4]]);
  for (const text of [null, '{', '[]', '0']) {
    assert.deepEqual(dfg.dfgParseDaily(text), { key: null, day: 0, status: 'playing', game: null, streak: 0, lastWon: null });
  }
});

// ── Texts ────────────────────────────────────────────────────────────────────

test('defrag: refusals, hints, dead ends and the storage warning name their values', () => {
  const board = DAILY6;
  const err = (tracks, a, b) => dfg.dfgErrorText(board, dfg.dfgMoveError(board, tracks, a, b));
  assert.equal(err(DAILY6.start, 6, 0), 'Track 7 is empty: nothing to move.');
  assert.equal(err([[1, 5, 5, 5, 1], [1, 0, 0, 4], [0], [2, 2, 2, 1], [3, 3, 3, 3, 5], [2, 2, 4, 0, 4], [4], []], 2, 0),
    'Track 3 holds only the fixed boot.sys block: it never moves.');
  assert.equal(err(DAILY6.start, 0, 2), 'Track 3 is reserved for boot.sys: it takes no nginx.cfg blocks.');
  assert.equal(err(DAILY6.start, 1, 0), 'Track 1 ends with nginx.cfg: the backup.tar fragment on track 2 (1 block) goes only onto backup.tar or an empty track.');
  assert.equal(err([[1, 5, 5, 5, 1], [1, 0, 0, 4], [0, 4], [2, 2, 2, 1], [3, 3, 3, 3, 5], [2, 2, 0], [4, 4], []], 6, 1),
    'Track 2 has room for 1 block: the backup.tar fragment on track 7 (2 blocks) does not fit, and a fragment never splits.');
  const tracks = DAILY6.start;
  assert.equal(dfg.dfgHintText(board, tracks, { status: 'solved', path: [[0, 3, 1], [4, 6, 1]], optimal: true }),
    'Hint: move nginx.cfg (1 block) from track 1 to track 4; 2 moves to go.');
  assert.equal(dfg.dfgHintText(board, tracks, { status: 'solved', path: [[4, 6, 1]], optimal: false }),
    'Hint: move users.db (1 block) from track 5 to track 7; a route of 1 move is left.');
  assert.equal(dfg.dfgHintText(board, tracks, { status: 'dead', nodes: 7 }),
    'No hint: no move sequence defragments the disk from here (7 states checked). Undo with U.');
  // The states both searches looked at (up to 20000 + 8000), not the cap of the second.
  assert.equal(dfg.dfgHintText(board, tracks, { status: 'unknown', nodes: 28000 }),
    'No hint: the search stopped after 28000 states without a route. Undo a move and ask again.');
  // Dead ends: a stuck disk, how far back a way out is, or that none is in reach.
  const small = { files: [{ size: 2 }, { size: 2 }], sys: [-1, -1, -1], capacity: 2 };
  const stuck = [[0, 1], [1, 0], [0, 1]];
  const deadText = 'Dead end: no move sequence defragments the disk from here (1 state checked). ';
  assert.equal(dfg.dfgDeadEndText({ board: small, tracks: [[0, 1], [1, 0], []], history: [] }, 100), '');
  // (A board of three tracks with a third file so the stuck disk is legal.)
  const three = { files: [{ size: 2 }, { size: 2 }, { size: 2 }], sys: [-1, -1, -1], capacity: 2 };
  assert.equal(dfg.dfgDeadEndText({ board: three, tracks: [[0, 1], [1, 2], [2, 0]], history: [] }, 100), deadText + 'Restart (R): there is no move to undo.');
  assert.equal(dfg.dfgDeadEndText({ board: small, tracks: stuck, history: [[2, 1, 1]] }, 100), deadText + 'Undo more than 1 move (U), or Restart (R).');
  // Level 8 after its four moves: one undo gives a way out.
  const b8 = dfg.dfgLevelBoard(8);
  let cur = b8.start;
  const history = [];
  for (const [a, b] of LEVEL8_DEAD) {
    const k = dfg.dfgTopRun(b8, cur, a);
    history.push([a, b, k]);
    cur = dfg.dfgApplyMove(cur, a, b, k);
  }
  assert.equal(dfg.dfgLegalMoves(b8, cur).length, 0, 'no move left at all');
  assert.equal(dfg.dfgDeadEndText({ board: b8, tracks: cur, history }, 2500), deadText + 'Undo 1 move (U).');
  assert.equal(dfg.dfgDeadEndText({ board: b8, tracks: cur, history }, 1), deadText + 'Undo at least 1 move (U).');
  // Storage.
  assert.equal(dfg.dfgStorageWarning({ 'dfg-state': 'QuotaExceededError' }),
    'Storage is blocked or full (QuotaExceededError): dfg-state is not saved on this page. The game plays on.');
  assert.equal(dfg.dfgStorageWarning({ 'dfg-state': 'SecurityError', 'dfg-daily': 'SecurityError', 'dfg-progress': 'QuotaExceededError' }),
    'Storage is blocked or full (SecurityError, QuotaExceededError): dfg-daily, dfg-progress, dfg-state are not saved on this page. The game plays on.');
});

// ── The page ─────────────────────────────────────────────────────────────────

test('defrag: loading the script under Node runs no init: no lookup, listener, timer or save', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.dfgInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['dfg-disk'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('defrag: a first visit shows level 1, its stats and status, and saves it; listeners are bound once', (t) => {
  const { v } = openPage(t);
  const board = dfg.dfgLevelBoard(1);
  assert.deepEqual(storedKeys(), [STATE_KEY], 'no Daily attempt before the Daily is opened');
  assert.equal(localStorage.getItem(STATE_KEY), '{"v":1,"view":"level","level":1,"tracks":' + JSON.stringify(LEVEL1_START) + ',"history":[],"moves":0,"undos":0,"hints":0}');
  assert.equal(v.tracks().length, 6);
  assert.equal(v.disk.className, 'dfg-disk');
  assert.equal(v.disk.style.getPropertyValue('--dfg-tracks'), '6');
  assert.equal(v.disk.style.getPropertyValue('--dfg-shelf'), '3');
  // The disk names its keys; a track is a picture its label reads out, never a button that cannot be focused.
  assert.equal(v.disk.getAttribute('aria-label'), 'Disk with 6 tracks of 4 blocks. Keys: 1 to 6 pick up the top fragment of a track and write it onto another, ' +
    'U undo, H hint, R restart, N next level, Escape puts it back.');
  LEVEL1_START.forEach((track, i) => {
    const el = v.track(i);
    assert.equal(el.className, 'dfg-track');
    assert.equal(el.getAttribute('data-track'), String(i));
    assert.equal(el.getAttribute('role'), 'img');
    assert.equal(el.getAttribute('tabindex'), null);
    assert.equal(el.children[0].className, 'dfg-track-num');
    assert.equal(el.children[0].textContent, String(i + 1));
    assert.deepEqual(v.blocks(i).map((b) => [b.className, b.textContent]),
      [0, 1, 2, 3].map((s) => (s < track.length ? ['dfg-block dfg-type-' + board.files[track[s]].ext, board.files[track[s]].ext] : ['dfg-slot', ''])));
  });
  assert.equal(v.track(0).getAttribute('aria-label'), 'Track 1: users.db x2, syslog.log x1; 1 free');
  assert.equal(v.track(4).getAttribute('aria-label'), 'Track 5: photo.jpg x2, backup.tar x1, users.db x1; 0 free');
  assert.equal(v.text('mode'), 'Level 1 · 4 files · 6 tracks of 4');
  assert.equal(v.text('frag'), '75%');
  assert.equal(v.text('frag-line'), 'fragmentation 75% → 75%');
  assert.equal(v.el('meter-fill').style.width, '75%');
  assert.equal(v.text('moves'), '0');
  assert.equal(v.text('par'), '≤ 9');
  assert.equal(v.text('best'), '--');
  assert.equal(v.text('hints'), '0');
  assert.equal(v.text('streak'), '0');
  assert.equal(v.text('status'), 'Fragmentation 75%: 9 fragments to merge. Tap a track to pick up its top fragment.');
  assert.equal(v.text('daily-button'), 'Daily #6');
  assert.equal(v.el('daily-button').getAttribute('aria-label'), 'Open Daily #6');
  assert.equal(v.el('prev').disabled, true);
  assert.equal(v.el('next').disabled, true);
  assert.equal(v.text('restart'), 'Restart');
  assert.deepEqual(['note', 'warning', 'share'].map(v.hidden), [true, true, true]);
  assert.equal(v.toast(), null);
  // One listener per control; keys on the game only; only storage on window.
  for (const [name, type] of [['game', 'keydown'], ['disk', 'click'], ['undo', 'click'], ['hint', 'click'], ['restart', 'click'],
    ['prev', 'click'], ['next', 'click'], ['daily-button', 'click'], ['share-button', 'click']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(v.disk), 1);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(document.body), 0);
  assert.equal(listenerCount(window), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
});

test('defrag: while the page is still loading the game waits for DOMContentLoaded', (t) => {
  const { v } = openPage(t, { storage: { state: SAMPLE_STATE, progress: SAMPLE_PROGRESS }, options: { readyState: 'loading' } });
  assert.equal(v.tracks().length, 0);
  assert.equal(v.text('status'), 'Mounting the disk...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(v.disk, 'click'), 0);
  v.ready();
  assert.equal(v.tracks().length, 6);
  assert.equal(v.text('moves'), '2');
  assert.equal(listenerCount(v.disk, 'click'), 1);
});

test('defrag: init runs once: a second call binds nothing twice', (t) => {
  makeClock(t);
  const { exports: fresh, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  fresh.dfgInit();
  const saved = localStorage.getItem(STATE_KEY);
  fresh.dfgInit();
  assert.equal(localStorage.getItem(STATE_KEY), saved);
  assert.equal(listenerCount(els['dfg-disk'], 'click'), 1);
  assert.equal(listenerCount(els['dfg-game'], 'keydown'), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  assert.equal(fresh.dfgRuntime.els.disk, els['dfg-disk']);
});

test('defrag: a tap picks up the top fragment, a tap on another track writes it there, and refusals name the tracks and the file', (t) => {
  const { v } = openPage(t);
  // Track 1's top fragment: one syslog.log block.
  v.tap(0);
  assert.equal(v.has(0, 'dfg-track--selected'), true);
  assert.deepEqual(v.blocks(0).map((b) => /dfg-block--lift/.test(b.className)), [false, false, true, false]);
  assert.deepEqual(v.tracks().map((el, i) => (el.classList.contains('dfg-track--target') ? i : -1)).filter((i) => i >= 0), [2, 3]);
  assert.equal(v.text('status'), 'Track 1: the syslog.log fragment (1 block) is picked up. Tap a track to write it there, or the same track to put it back.');
  // The same track puts it back.
  v.tap(0);
  assert.equal(v.has(0, 'dfg-track--selected'), false);
  assert.equal(v.text('moves'), '0');
  // A refused move: the toast names both tracks and the file; nothing moves or is saved.
  const before = localStorage.getItem(STATE_KEY);
  v.move(0, 1);
  assert.equal(v.toast(), 'Track 2 ends with backup.tar: the syslog.log fragment on track 1 (1 block) goes only onto syslog.log or an empty track.');
  assert.equal(v.has(0, 'dfg-track--selected'), false);
  assert.equal(localStorage.getItem(STATE_KEY), before);
  // A legal one: onto the same file.
  v.move(0, 2);
  assert.deepEqual(v.state().tracks, [[0, 0], [3, 1], [1, 3, 3], [2, 2, 3], [2, 2, 1, 0], [0, 1]]);
  assert.deepEqual(v.state().history, [[0, 2, 1]]);
  assert.equal(v.state().moves, 1);
  assert.equal(v.text('moves'), '1');
  assert.equal(v.text('frag'), '67%');
  assert.equal(v.text('frag-line'), 'fragmentation 75% → 67%');
  assert.equal(v.toast(), 'Track 2 ends with backup.tar: the syslog.log fragment on track 1 (1 block) goes only onto syslog.log or an empty track.', 'the old toast runs its time');
  // A tap on a block inside a track counts as a tap on the track; the disk's own padding is no track.
  v.blocks(1)[0].click();
  assert.equal(v.has(1, 'dfg-track--selected'), true);
  v.disk.click();
  assert.equal(v.has(1, 'dfg-track--selected'), true);
  // backup.tar onto track 6, which ends with backup.tar: legal.
  v.tap(5);
  assert.deepEqual(v.state().tracks[5], [0, 1, 1]);
  // Room: track 5 is full and ends with users.db, the file on top of track 1.
  v.move(0, 4);
  assert.equal(v.toast(), 'Track 5 has room for 0 blocks: the users.db fragment on track 1 (2 blocks) does not fit, and a fragment never splits.');
});

test('defrag: a reserved track takes only its own file, its fixed block never moves, and an empty track has nothing to move', (t) => {
  const { v } = openPage(t, { storage: { progress: { highest: 7 }, state: { level: 8 } } });
  const board = dfg.dfgLevelBoard(8);
  assert.deepEqual(board.sys, [-1, -1, -1, -1, -1, -1, -1, 0]);
  assert.equal(v.tracks().length, 8);
  assert.equal(v.disk.style.getPropertyValue('--dfg-shelf'), '4');
  assert.equal(v.has(7, 'dfg-track--sys'), true);
  assert.equal(v.track(7).children[0].textContent, '8 boot');
  assert.equal(v.blocks(7)[0].className, 'dfg-block dfg-type-boot dfg-block--sys');
  assert.equal(v.track(7).getAttribute('aria-label'), 'Track 8, reserved for boot.sys: boot.sys x1 (fixed block at the bottom), demo.mp4 x2; 2 free');
  v.tap(1);
  assert.equal(v.toast(), 'Track 2 is empty: nothing to move.');
  assert.equal(v.has(1, 'dfg-track--selected'), false);
  v.move(0, 7);
  assert.equal(v.toast(), 'Track 8 is reserved for boot.sys: it takes no demo.mp4 blocks.');
  // Move demo.mp4 off track 8 onto an empty track: then only the fixed block is left.
  v.move(7, 1);
  assert.deepEqual(v.state().tracks[7], [0]);
  v.tap(7);
  assert.equal(v.toast(), 'Track 8 holds only the fixed boot.sys block: it never moves.');
  // A loose boot.sys block elsewhere (track 4, under others) goes back onto its fixed block once it is on top.
  assert.deepEqual(v.state().tracks[3], [1, 0, 3, 4]);
  v.move(3, 1);
  v.move(3, 2);
  v.move(3, 7);
  assert.deepEqual(v.state().tracks[7], [0, 0]);
  assert.equal(v.track(7).getAttribute('aria-label'), 'Track 8, reserved for boot.sys: boot.sys x2 (fixed block at the bottom); 3 free');
});

test('defrag: keys work only while the focus is inside the game: 1-9, U, H, R, N and Escape', (t) => {
  const { v } = openPage(t);
  let ev = v.press('1');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(v.has(0, 'dfg-track--selected'), true);
  ev = v.press('Escape');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(v.has(0, 'dfg-track--selected'), false);
  assert.equal(v.press('Escape').defaultPrevented, false, 'Escape with nothing picked up stays with the page');
  v.press('1');
  v.press('3');
  assert.equal(v.state().moves, 1);
  // AZERTY digits and the keypad by their code.
  v.press('é', { code: 'Digit2' });
  v.press('PageDown', { code: 'Numpad6' });
  assert.equal(v.state().moves, 2);
  assert.deepEqual(v.state().history[1], [1, 5, 1]);
  // A track the disk does not have.
  v.press('9');
  assert.equal(v.toast(), 'There is no track 9: this disk has 6 tracks.');
  // U undoes, also on a non-Latin layout.
  v.press('u');
  assert.equal(v.state().moves, 1);
  v.press('г', { code: 'KeyU' });
  assert.equal(v.state().moves, 0);
  assert.equal(v.state().undos, 2);
  // Held keys act once.
  v.press('1');
  assert.equal(v.press('2', { repeat: true }).defaultPrevented, true);
  assert.equal(v.has(0, 'dfg-track--selected'), true, 'a held key does not act again');
  v.press('Escape');
  v.press('h');
  assert.equal(v.state().hints, 1);
  v.press('h', { repeat: true });
  assert.equal(v.state().hints, 1);
  // Shortcuts, composing text, keys a page script handled and other keys stay with the browser.
  const before = localStorage.getItem(STATE_KEY);
  for (const props of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    for (const key of ['1', 'u', 'h', 'r', 'n']) assert.equal(v.press(key, props).defaultPrevented, false, key + ' ' + JSON.stringify(props));
  }
  for (const key of ['x', 'Tab', ' ', 'Enter', '0', undefined]) assert.equal(v.press(key).defaultPrevented, false, String(key));
  const handled = (event) => event.preventDefault();
  v.el('game').addEventListener('keydown', handled, true);
  v.press('1');
  v.el('game').removeEventListener('keydown', handled, true);
  assert.equal(v.has(0, 'dfg-track--selected'), false);
  // Keys typed into host-page fields, links and buttons never reach the game; nor the game's own result field.
  const input = v.page.add('host-input', 'input');
  const link = v.page.add('host-link', 'a');
  const button = v.page.add('host-button', 'button');
  const area = v.page.add('host-area', 'textarea');
  for (const target of [input, link, button, area, document.body, v.el('share-text')]) {
    for (const key of ['1', 'u', 'h', 'r', 'n']) assert.equal(pressKey(key, { target }).defaultPrevented, false);
  }
  const editable = v.page.add('dfg-editable', 'div');
  v.el('game').appendChild(editable);
  editable.isContentEditable = true;
  assert.equal(pressKey('1', { target: editable }).defaultPrevented, false);
  assert.equal(localStorage.getItem(STATE_KEY), before);
  // On a game button the keys work (the focus is inside the game), and Enter still clicks it.
  assert.equal(pressKey('1', { target: v.el('undo') }).defaultPrevented, true);
  assert.equal(v.has(0, 'dfg-track--selected'), true);
  pressKey('Enter', { target: v.el('undo') });
  assert.equal(v.state().moves, 0);
  assert.equal(v.toast(), 'Nothing to undo: the disk is at its first state.');
  assert.equal(listenerCount(v.el('game'), 'keydown'), 1);
});

test('defrag: a mouse click on a game button moves the focus to the disk, so Space or Enter never repeats it; a hint on the same disk counts once', (t) => {
  const { v } = openPage(t);
  v.click('daily-button');
  assert.equal(document.activeElement, v.disk, 'the focus left the Daily button');
  v.click('hint');
  assert.equal(v.daily().hints, 1);
  assert.equal(document.activeElement, v.disk);
  // Space to scroll down to the note: the page scrolls, no button is clicked again.
  for (const key of [' ', 'Enter']) {
    assert.equal(pressKey(key).defaultPrevented, false, JSON.stringify(key));
  }
  assert.equal(v.daily().hints, 1, 'no second hint is charged');
  // H again on the same disk shows the same move and costs nothing; after a move it counts again.
  const note = v.text('note');
  v.press('h');
  assert.equal(v.text('note'), note);
  assert.equal(v.daily().hints, 1);
  v.tap(2);
  v.press('h');
  assert.equal(v.daily().hints, 1, 'picking up a fragment changes no block');
  assert.equal(v.has(2, 'dfg-track--selected'), false);
  v.move(0, 3);
  v.press('h');
  assert.equal(v.daily().hints, 2);
  // Undo and Restart by mouse: one undo, and Restart's question is not answered by a stray Space.
  v.click('undo');
  assert.equal(document.activeElement, v.disk);
  pressKey(' ');
  assert.deepEqual([v.daily().moves, v.daily().undos], [0, 1]);
  v.click('daily-button');
  v.move(0, 2);
  v.click('restart');
  pressKey(' ');
  assert.equal(v.state().moves, 1, 'Space did not answer the Restart question');
  // Keyboard activation (a click with detail 0) leaves the focus on the button.
  const undo = v.el('undo');
  undo.focus();
  fire(undo, 'click', { detail: 0 });
  assert.equal(document.activeElement, undo);
  assert.equal(v.state().moves, 0);
});

test('defrag: Undo takes the last move back, any number of times, and says when there is nothing left', (t) => {
  const { v } = openPage(t);
  v.click('undo');
  assert.equal(v.toast(), 'Nothing to undo: the disk is at its first state.');
  assert.equal(v.state().undos, 0);
  v.move(0, 2);
  v.move(1, 5);
  v.tap(2);
  v.click('undo');
  assert.equal(v.has(2, 'dfg-track--selected'), false, 'undo puts a picked fragment back too');
  assert.deepEqual(v.state().tracks, [[0, 0], [3, 1], [1, 3, 3], [2, 2, 3], [2, 2, 1, 0], [0, 1]]);
  assert.deepEqual([v.state().moves, v.state().undos, v.state().history.length], [1, 1, 1]);
  v.click('undo');
  assert.deepEqual(v.state().tracks, LEVEL1_START);
  assert.deepEqual([v.state().moves, v.state().undos], [0, 2]);
  assert.equal(v.text('moves'), '0');
});

test('defrag: the hint shows the solver\'s next move and counts; the dead-end warning says how many moves to undo', (t) => {
  const { v } = openPage(t, { storage: { progress: { highest: 7 }, state: { level: 8 } } });
  const board = dfg.dfgLevelBoard(8);
  v.click('hint');
  const route = dfg.dfgSolve(board, board.start, dfg.dfgLimits);
  const [a, b, k] = route.path[0];
  assert.equal(v.text('note'), 'Hint: move ' + board.files[board.start[a][board.start[a].length - 1]].name + ' (' + k + ' block' + (k === 1 ? '' : 's') +
    ') from track ' + (a + 1) + ' to track ' + (b + 1) + '; ' + route.path.length + ' moves to go.');
  assert.equal(v.el('note').className, 'dfg-note dfg-note--hint');
  assert.equal(v.has(a, 'dfg-track--hint-from'), true);
  assert.equal(v.has(b, 'dfg-track--hint-to'), true);
  assert.equal(v.text('hints'), '1');
  assert.equal(v.state().hints, 1);
  // The hint goes with the next move.
  for (const [x, y] of LEVEL8_DEAD.slice(0, 3)) v.move(x, y);
  assert.equal(v.hidden('note'), true);
  assert.equal(v.tracks().some((el) => /hint/.test(el.className)), false);
  v.move(...LEVEL8_DEAD[3]);
  assert.equal(v.text('note'), 'Dead end: no move sequence defragments the disk from here (1 state checked). Undo 1 move (U).');
  assert.equal(v.el('note').className, 'dfg-note dfg-note--dead');
  // A hint from the dead end says so too, and is not counted.
  v.click('hint');
  assert.equal(v.text('note'), 'No hint: no move sequence defragments the disk from here (1 state checked). Undo with U.');
  assert.equal(v.state().hints, 1);
  // One undo leads out of it, so the warning goes.
  v.click('undo');
  assert.equal(v.hidden('note'), true);
  assert.equal(v.state().moves, 3);
});

test('defrag: defragmenting a level wins: status, toast, best, the next level, a frozen disk, and a reload keeps it', (t) => {
  const { clock, v } = openPage(t);
  const board = dfg.dfgLevelBoard(1);
  const moves = solveOnPage(v, board, LEVEL1_START);
  assert.equal(moves, LEVEL1_PAR);
  assert.equal(v.text('status'), 'Defragmented: level 1 in 9 moves (par ≤ 9), fragmentation 75% → 0%.');
  assert.equal(v.toast(), 'Level 1 defragmented in 9 moves: new best!');
  assert.match(v.disk.className, /\bdfg-disk--solved\b/);
  assert.equal(v.text('frag'), '0%');
  assert.equal(v.text('best'), '9');
  assert.deepEqual(v.progress(), { v: 1, highest: 1, moves: { 1: 9 } });
  assert.equal(localStorage.getItem(PROGRESS_KEY), SAMPLE_PROGRESS);
  assert.equal(v.el('next').disabled, false);
  assert.match(v.el('next').className, /\bdfg-btn--go\b/);
  // A defragmented disk takes no more moves, undos or hints.
  v.tap(0);
  assert.equal(v.toast(), 'Level 1 is defragmented: Restart or Next level.');
  v.click('undo');
  v.click('hint');
  assert.equal(v.state().moves, 9);
  // A reload shows it again.
  const again = reload(clock, v);
  assert.equal(again.text('status'), 'Defragmented: level 1 in 9 moves (par ≤ 9), fragmentation 75% → 0%.');
  assert.equal(again.el('next').disabled, false);
  // Restart replays it at once (nothing to lose) and a slower run keeps the best.
  again.click('restart');
  assert.deepEqual(again.state().tracks, LEVEL1_START);
  again.move(0, 3);
  again.click('undo');
  solveOnPage(again, board, LEVEL1_START);
  assert.equal(again.state().moves, 9);
  assert.equal(again.toast(), 'Level 1 defragmented in 9 moves.');
  assert.deepEqual(again.progress().moves, { 1: 9 });
  // N goes to level 2 at once (level 1 is defragmented, nothing is lost), Prev back to level 1.
  again.press('n');
  assert.equal(again.text('mode'), 'Level 2 · 4 files · 6 tracks of 4');
  assert.deepEqual(again.state().tracks, LEVEL2_START);
  assert.equal(again.el('next').disabled, true, 'level 3 opens once level 2 is done');
  again.press('n');
  assert.equal(again.toast(), 'Level 3 opens once level 2 is defragmented.');
  again.click('prev');
  assert.equal(again.state().level, 1);
  assert.equal(again.el('prev').disabled, true);
});

test('defrag: Restart asks for a second press within 3 s when moves would be lost, and so do Prev, Next and N when leaving a level with moves made', (t) => {
  const { clock, v } = openPage(t, { storage: { progress: { highest: 3 } } });
  assert.equal(v.state().level, 4, 'the next level to play');
  v.click('prev');
  assert.equal(v.toast(), null, 'nothing left behind');
  assert.equal(v.state().level, 3);
  const board = dfg.dfgLevelBoard(3);
  const [a, b] = dfg.dfgLegalMoves(board, board.start)[0];
  v.move(a, b);
  v.click('restart');
  assert.equal(v.toast(), 'Press Restart again within 3 s to throw away 1 move on level 3.');
  assert.equal(v.state().moves, 1);
  clock.advance(3000);
  v.press('r');
  assert.equal(v.state().moves, 1, 'too late: asked again');
  clock.advance(1000);
  v.press('r');
  assert.equal(v.state().moves, 0);
  assert.deepEqual(v.state().tracks, board.start);
  // A move in between disarms it.
  v.move(a, b);
  v.click('restart');
  v.click('undo');
  v.move(a, b);
  v.click('restart');
  assert.equal(v.state().moves, 1);
  // Leaving a level with moves made (here a replay of a level already defragmented) asks the same way.
  clock.advance(3000);
  v.click('next');
  assert.equal(v.toast(), 'Press Next again within 3 s to leave level 3 and throw away its 1 move (the level starts over when you come back).');
  assert.deepEqual([v.state().level, v.state().moves], [3, 1]);
  // Another action's press is no confirmation: Prev asks for itself, and so does Restart after it.
  v.click('prev');
  assert.equal(v.toast(), 'Press Prev again within 3 s to leave level 3 and throw away its 1 move (the level starts over when you come back).');
  v.click('restart');
  assert.equal(v.toast(), 'Press Restart again within 3 s to throw away 1 move on level 3.');
  assert.deepEqual([v.state().level, v.state().moves], [3, 1]);
  // Too late, or a move in between, asks again.
  v.press('n');
  clock.advance(3000);
  v.press('n');
  assert.equal(v.state().level, 3);
  v.click('undo');
  v.move(a, b);
  v.press('n');
  assert.equal(v.state().level, 3);
  // The N key and the Next button are one action: the second press leaves.
  clock.advance(2999);
  v.click('next');
  assert.equal(v.state().level, 4);
  assert.equal(v.state().moves, 0);
  assert.equal(v.el('next').disabled, true);
  v.press('n');
  assert.equal(v.toast(), 'Level 5 opens once level 4 is defragmented.');
  // Prev with moves made asks too; the second press leaves.
  const b4 = dfg.dfgLevelBoard(4);
  const [c, d] = dfg.dfgLegalMoves(b4, b4.start)[0];
  v.move(c, d);
  v.click('prev');
  assert.equal(v.state().level, 4);
  v.click('prev');
  assert.deepEqual([v.state().level, v.state().moves], [3, 0]);
});

test('defrag: the last level has no next one, and Prev does nothing on level 1 or in the Daily', (t) => {
  const { v } = openPage(t, { storage: { progress: { highest: 999 }, state: { level: 999 } } });
  assert.equal(v.state().level, 999);
  assert.equal(v.el('next').disabled, true);
  v.press('n');
  assert.equal(v.toast(), 'Level 999 is the last level.');
  v.click('daily-button');
  v.el('prev').disabled = false;
  v.click('prev');
  assert.equal(v.state().level, 999);
  v.press('n');
  assert.equal(v.toast(), 'Next level works in level play: Daily #6 is on screen.');
});

test('defrag: every class the game puts on the page has a rule in style.css', (t) => {
  const seen = new Set();
  const collect = (v) => {
    for (const el of walk(v.page.root)) String(el.className || '').split(/\s+/).filter(Boolean).forEach((name) => seen.add(name));
  };
  const { v } = openPage(t, { storage: { progress: { highest: 13 }, state: { level: 14 } } });
  v.click('hint');
  collect(v);
  v.tap(0);
  collect(v);
  v.click('restart');
  resetStubs();
  const second = openPage(t).v;
  solveOnPage(second, dfg.dfgLevelBoard(1), LEVEL1_START);
  collect(second);
  second.click('daily-button');
  collect(second);
  resetStubs();
  const third = openPage(t, { storage: { progress: { highest: 7 }, state: { level: 8 } } }).v;
  for (const [x, y] of LEVEL8_DEAD) third.move(x, y);
  collect(third);
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors).join(' ');
  for (const name of [...seen].sort()) {
    assert.match(name, /^dfg-/);
    assert.match(selectors, new RegExp('\\.' + name + '(?![\\w-])'), name);
  }
  for (const name of ['dfg-track--selected', 'dfg-track--target', 'dfg-track--hint-from', 'dfg-track--hint-to', 'dfg-track--sys',
    'dfg-block--lift', 'dfg-block--sys', 'dfg-disk--solved','dfg-btn--go', 'dfg-note--hint', 'dfg-note--dead', 'dfg-slot']) {
    assert.ok(seen.has(name), name + ' was seen on the page');
  }
  // Every file type has a colour.
  for (const type of ['log', 'iso', 'db', 'jpg', 'txt', 'tar', 'mp4', 'cfg', 'boot', 'swap']) {
    assert.ok(declsAt(cssRules(CSS), '.dfg-type-' + type, 1280)['background-color'], type);
  }
});

test('defrag: a newer toast keeps its full 2.2 s', (t) => {
  const { clock, v } = openPage(t);
  v.click('undo');
  assert.notEqual(v.toast(), null);
  clock.advance(1500);
  v.tap(3);
  v.tap(1);
  assert.match(v.toast(), /^Track 2 ends with/);
  clock.advance(2199);
  assert.notEqual(v.toast(), null);
  clock.advance(1);
  assert.equal(v.toast(), null);
});

// ── Daily on the page ────────────────────────────────────────────────────────

test('defrag: opening the Daily writes the attempt at once, shows today\'s disk and keeps the level aside', (t) => {
  const { clock, v } = openPage(t);
  v.move(0, 2);
  v.click('daily-button');
  assert.equal(localStorage.getItem(DAILY_KEY), '{"v":1,"key":"2026-11-06","day":6,"status":"playing","tracks":' + JSON.stringify(DAILY6.start) +
    ',"history":[],"moves":0,"undos":0,"hints":0,"streak":0,"lastWon":null}');
  assert.equal(v.state().view, 'daily');
  assert.equal(v.state().moves, 1, 'the level game is kept');
  assert.equal(v.tracks().length, 8);
  assert.equal(v.text('mode'), 'Daily #6 · 2026-11-06 · 6 files · 8 tracks of 5');
  assert.equal(v.text('daily-button'), 'Levels');
  assert.equal(v.el('daily-button').getAttribute('aria-label'), 'Back to the numbered levels');
  assert.equal(v.text('par'), '≤ 12');
  assert.equal(v.text('frag-line'), 'fragmentation 53% → 53%');
  assert.equal(v.text('best'), '--');
  assert.deepEqual([v.el('prev').disabled, v.el('next').disabled], [true, true]);
  // Moves go to the attempt.
  v.move(0, 3);
  assert.equal(localStorage.getItem(DAILY_KEY), SAMPLE_DAILY.replace('"streak":2,"lastWon":5', '"streak":0,"lastWon":null'));
  // A Daily in progress cannot be restarted.
  v.click('restart');
  assert.equal(v.toast(), 'Daily #6 is one scored attempt and cannot be restarted (1 move so far). Undo with U.');
  // Back to the levels and back again: both as they were; a reload opens the Daily again.
  v.click('daily-button');
  assert.equal(v.state().view, 'level');
  assert.equal(v.text('moves'), '1');
  v.click('daily-button');
  assert.equal(v.text('moves'), '1');
  const again = reload(clock, v);
  assert.equal(again.text('mode'), 'Daily #6 · 2026-11-06 · 6 files · 8 tracks of 5');
  assert.equal(again.daily().moves, 1);
});

test('defrag: defragmenting the Daily records the result once: streak, share line and an unscored practice run', async (t) => {
  const { clock, v } = openPage(t, { storage: { daily: { key: '2026-11-05', status: 'won', streak: 2, lastWon: 5 } } });
  assert.equal(v.text('streak'), '2');
  v.click('daily-button');
  assert.equal(v.daily().streak, 2);
  v.click('hint');
  const moves = solveOnPage(v, DAILY6, DAILY6.start);
  assert.equal(moves, 12);
  const record = v.daily();
  assert.deepEqual([record.status, record.moves, record.hints, record.streak, record.lastWon], ['won', 12, 1, 3, 6]);
  assert.equal(v.text('status'), 'Daily #6 defragmented in 12 moves (par ≤ 12), 1 hint. Streak 3.');
  assert.equal(v.toast(), 'Daily #6 defragmented in 12 moves. Streak 3.');
  assert.equal(v.text('streak'), '3');
  assert.equal(v.hidden('share'), false);
  assert.equal(v.text('restart'), 'Practice');
  assert.equal(v.el('restart').getAttribute('aria-label'), 'Practice this Daily disk, not scored');
  assert.equal(localStorage.getItem(PROGRESS_KEY), null, 'the Daily is no level');
  v.tap(0);
  assert.equal(v.toast(), 'Daily #6 is defragmented: Practice replays it.');

  const write = t.mock.method(navigator.clipboard, 'writeText', () => Promise.resolve());
  v.click('share-button');
  await new Promise((resolve) => setImmediate(resolve));
  const line = 'Defrag #6 fragmentation 53% → 0% in 12 moves (par ≤ 12), 1 hint';
  assert.deepEqual(write.mock.calls.map((call) => call.arguments), [[line]]);
  assert.equal(v.toast(), 'Copied: ' + line);

  // In level play the Daily button shows today's is done.
  v.click('daily-button');
  assert.equal(v.text('daily-button'), 'Daily #6 ✓');
  assert.equal(v.hidden('share'), true);
  v.click('daily-button');

  // Practice: the same disk, unscored and never saved.
  const saved = localStorage.getItem(DAILY_KEY);
  v.click('restart');
  assert.equal(v.toast(), 'Practice run of Daily #6: not scored, not saved.');
  assert.equal(v.text('mode'), 'Practice of Daily #6 · 2026-11-06 · 6 files · 8 tracks of 5');
  assert.equal(v.text('restart'), 'Restart');
  assert.equal(v.hidden('share'), true);
  v.move(0, 3);
  v.click('restart');
  assert.equal(v.toast(), 'Press Restart again within 3 s to throw away 1 move on the practice run of Daily #6.');
  v.click('restart');
  assert.equal(v.text('moves'), '0');
  solveOnPage(v, DAILY6, DAILY6.start);
  assert.equal(v.text('status'), 'Defragmented: the practice run of Daily #6 in 12 moves (par ≤ 12), fragmentation 53% → 0%. Practice run, not scored.');
  assert.equal(v.toast(), 'The practice run of Daily #6 defragmented in 12 moves: not scored.');
  v.tap(0);
  assert.equal(v.toast(), 'The practice run of Daily #6 is defragmented: Restart replays it.');
  assert.equal(localStorage.getItem(DAILY_KEY), saved);
  // A reload shows the result again, with no way to play it for a score.
  const again = reload(clock, v);
  assert.equal(again.text('status'), 'Daily #6 defragmented in 12 moves (par ≤ 12), 1 hint. Streak 3.');
  again.click('undo');
  assert.equal(again.daily().moves, 12);
});

test('defrag: the streak starts over after a missed day', (t) => {
  const { v } = openPage(t, { storage: { daily: { key: '2026-11-04', status: 'won', streak: 5, lastWon: 4 } } });
  assert.equal(v.text('streak'), '0');
  v.click('daily-button');
  assert.equal(v.daily().streak, 0);
  solveOnPage(v, DAILY6, DAILY6.start);
  assert.equal(v.daily().streak, 1);
  assert.equal(v.text('status'), 'Daily #6 defragmented in 12 moves (par ≤ 12). Streak 1.');
});

test('defrag: a Daily left open across midnight finishes as the day it started; the next one starts after it', (t) => {
  const { clock, v } = openPage(t, { when: NOV6_LATE });
  v.click('daily-button');
  v.move(0, 3);
  clock.advance(2 * 60000);
  assert.equal(dfg.dfgDayInfo(new Date()).key, KEY7, 'the clock has passed midnight');
  solveOnPage(v, DAILY6, v.daily().tracks);
  const record = v.daily();
  assert.deepEqual([record.key, record.status, record.lastWon, record.streak], [KEY6, 'won', 6, 1]);
  assert.match(v.text('status'), /^Daily #6 defragmented/);
  assert.equal(v.text('streak'), '1', 'yesterday\'s win keeps the streak today');
  v.click('daily-button');
  assert.equal(v.text('daily-button'), 'Daily #7', 'today\'s Daily is a new one');
  v.click('daily-button');
  assert.deepEqual([v.daily().key, v.daily().status, v.daily().streak], [KEY7, 'playing', 1]);
  assert.equal(v.text('mode'), 'Daily #7 · 2026-11-07 · 6 files · 8 tracks of 5');
  // Reload on the Daily of another day starts today's.
  resetStubs();
  const later = openPage(t, { when: NOV6 + 86400000, storage: { state: { view: 'daily' }, daily: record } });
  assert.equal(later.v.daily().key, KEY7);
  assert.deepEqual(later.v.daily().tracks, dfg.dfgDailyBoard(KEY7).start);
});

test('defrag: without a clipboard, or when it refuses, the share line is shown selected for copying by hand', async (t) => {
  const finished = { v: 1, key: KEY6, status: 'won', tracks: DAILY6.goal, history: [], moves: 21, undos: 2, hints: 0, streak: 2, lastWon: 6 };
  const line = 'Defrag #6 fragmentation 53% → 0% in 21 moves (par ≤ 12), 2 undos';
  const real = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  t.after(() => Object.defineProperty(navigator, 'clipboard', real));
  for (const clipboard of [undefined, {}, { writeText: () => Promise.reject(new Error('denied')) }]) {
    resetStubs();
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true, writable: true });
    const { v } = openPage(t, { storage: { state: { view: 'daily' }, daily: finished } });
    assert.equal(v.text('status'), 'Daily #6 defragmented in 21 moves (par ≤ 12), 2 undos. Streak 2.');
    assert.equal(v.hidden('share-text'), true);
    v.click('share-button');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(v.hidden('share-text'), false, JSON.stringify(clipboard));
    assert.equal(v.el('share-text').value, line);
    assert.equal(document.activeElement, v.el('share-text'));
    assert.equal(v.toast(), 'The clipboard is not available: copy the selected result below.');
  }
});

// ── Second tabs ──────────────────────────────────────────────────────────────

test('defrag: on the Daily a second tab takes over the other tab\'s newer record at a tap, an undo, a hint or the storage event', (t) => {
  const { v } = openPage(t);
  v.click('daily-button');
  v.move(0, 3);
  const mine = v.daily();
  // The other tab plays on from there: one more move.
  const theirs = Object.assign({}, mine, { tracks: dfg.dfgApplyMove(mine.tracks, 4, 6, 1), history: mine.history.concat([[4, 6, 1]]), moves: 2 });
  localStorage.setItem(DAILY_KEY, JSON.stringify(theirs));
  // A tap here, made on the old disk, shows the other tab's attempt instead of being played.
  v.tap(2);
  assert.deepEqual(v.daily(), theirs);
  assert.equal(v.has(2, 'dfg-track--selected'), false);
  assert.equal(v.text('moves'), '2');
  assert.deepEqual(v.blocks(6).map((b) => b.textContent), ['db', '', '', '', ''], 'the disk as the other tab left it');
  assert.equal(v.toast(), 'Another tab saved Daily #6 (2 moves): it is shown here.');
  // The next tap is played: users.db onto the empty track 8.
  v.move(6, 7);
  assert.equal(v.daily().moves, 3);
  // An undo reads the record again first: meanwhile the other tab undid twice.
  const third = Object.assign({}, v.daily(), { tracks: mine.tracks, history: mine.history, moves: 1, undos: 2 });
  localStorage.setItem(DAILY_KEY, JSON.stringify(third));
  v.click('undo');
  assert.deepEqual(v.daily(), third, 'taken over, not undone once more');
  // So does a hint: the other tab took one, and undid the last move.
  localStorage.setItem(DAILY_KEY, JSON.stringify(Object.assign({}, third, { hints: 1, undos: 3, moves: 0, tracks: DAILY6.start, history: [] })));
  v.click('hint');
  assert.equal(v.daily().hints, 1, 'the hint was not counted twice');
  assert.equal(v.hidden('note'), true);
  // A storage event for another key changes nothing; one for the Daily takes the newer record over.
  const solved = Object.assign({}, v.daily(), { status: 'won', tracks: DAILY6.goal, history: [], moves: 12, streak: 1, lastWon: 6 });
  localStorage.setItem(DAILY_KEY, JSON.stringify(solved));
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.text('moves'), '0');
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(v.toast(), 'Another tab defragmented Daily #6 (12 moves): it is shown here.');
  assert.equal(v.text('status'), 'Daily #6 defragmented in 12 moves (par ≤ 12), 3 undos, 1 hint. Streak 1.');
  fire(window, 'storage', { key: DAILY_KEY });
  // An older record never comes back over it.
  localStorage.setItem(DAILY_KEY, JSON.stringify(mine));
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(v.text('status'), 'Daily #6 defragmented in 12 moves (par ≤ 12), 3 undos, 1 hint. Streak 1.');
  v.click('daily-button');
  assert.deepEqual(JSON.parse(localStorage.getItem(DAILY_KEY)), mine, 'this tab writes no Daily over it while it shows the levels');
});

test('defrag: a hint taken in another tab is never erased: a record that differs only in its hints is further along', (t) => {
  const { v } = openPage(t);
  v.click('daily-button');
  v.move(0, 3);
  // The other tab pressed H on the same disk: moves and undos as here, one hint more.
  const theirs = Object.assign(v.daily(), { hints: 1 });
  localStorage.setItem(DAILY_KEY, JSON.stringify(theirs));
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(v.text('hints'), '1');
  assert.equal(v.toast(), 'Another tab saved Daily #6 (1 move): it is shown here.');
  // A move here keeps the hint, and so does the share line once it is defragmented.
  v.move(4, 6);
  assert.deepEqual([v.daily().moves, v.daily().hints], [2, 1]);
  solveOnPage(v, DAILY6, v.daily().tracks);
  assert.match(v.text('status'), /, 1 hint\. Streak 1\.$/);
});

test('defrag: a level game another tab saved further along is taken over at a tap, through the storage event and before every write; an older one or another level is not', (t) => {
  const { v } = openPage(t);
  const board = dfg.dfgLevelBoard(1);
  const route = dfg.dfgSolve(board, LEVEL1_START, dfg.dfgLimits).path;
  // The other tab's game of level 1: the first moves of the route, as it saves them.
  const theirs = (n, extra) => {
    const history = route.slice(0, n);
    return JSON.stringify(Object.assign({ v: 1, view: 'level', level: 1, tracks: playModel(board, LEVEL1_START, history, 'theirs'), history,
      moves: n, undos: 0, hints: 0 }, extra));
  };
  // A tap here, made on the old disk, shows the other tab's game instead of being played.
  localStorage.setItem(STATE_KEY, theirs(3));
  v.tap(0);
  assert.equal(localStorage.getItem(STATE_KEY), theirs(3), 'not written over');
  assert.equal(v.text('moves'), '3');
  assert.equal(v.has(0, 'dfg-track--selected'), false);
  assert.equal(v.toast(), 'Another tab saved level 1 (3 moves): it is shown here.');
  // The next tap plays on from there.
  v.move(route[3][0], route[3][1]);
  assert.equal(v.state().moves, 4);
  // The storage event: a game further along comes in at once; an older one never does, and is written over.
  localStorage.setItem(STATE_KEY, theirs(5));
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.text('moves'), '5');
  localStorage.setItem(STATE_KEY, theirs(2, { undos: 1 }));
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.text('moves'), '5');
  v.click('hint');
  assert.deepEqual([v.state().moves, v.state().hints], [5, 1], 'this tab\'s game, written over the older one');
  // A hint-only change in the other tab is further along too.
  localStorage.setItem(STATE_KEY, JSON.stringify(Object.assign(v.state(), { hints: 2 })));
  v.click('undo');
  assert.deepEqual([v.state().moves, v.state().hints], [5, 2], 'taken over, not undone');
  // Restart and leaving the level read it again first: the press made on the old disk does nothing.
  localStorage.setItem(STATE_KEY, theirs(6, { hints: 2 }));
  v.click('restart');
  assert.equal(v.state().moves, 6);
  // (Level 2 opens: the other tab defragmented level 1 in another game.)
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ v: 1, highest: 1, moves: { 1: 9 } }));
  fire(window, 'storage', { key: PROGRESS_KEY });
  localStorage.setItem(STATE_KEY, theirs(7, { hints: 2 }));
  v.press('n');
  assert.deepEqual([v.state().level, v.state().moves], [1, 7]);
  assert.equal(v.toast(), 'Another tab saved level 1 (7 moves): it is shown here.');
  // The other tab on another level: its game is no game of this level, so this tab plays on.
  localStorage.setItem(STATE_KEY, JSON.stringify(Object.assign(JSON.parse(SAMPLE_STATE), { moves: 40 })));
  fire(window, 'storage', { key: STATE_KEY });
  assert.match(v.text('mode'), /^Level 1 /);
  assert.equal(v.text('moves'), '7');
  v.move(route[7][0], route[7][1]);
  assert.deepEqual([v.state().level, v.state().moves], [1, 8]);
});

test('defrag: opening the Daily or going back to the levels writes dfg-state only after taking over the other tab\'s level game', (t) => {
  const { v } = openPage(t);
  const board = dfg.dfgLevelBoard(1);
  const [a, b, k] = dfg.dfgLegalMoves(board, LEVEL1_START)[0];
  const theirs = { v: 1, view: 'level', level: 1, tracks: dfg.dfgApplyMove(LEVEL1_START, a, b, k), history: [[a, b, k]], moves: 1, undos: 0, hints: 0 };
  // The Daily on screen: taken over in silence, written with the view of this tab.
  localStorage.setItem(STATE_KEY, JSON.stringify(theirs));
  v.click('daily-button');
  assert.deepEqual(v.state(), Object.assign({}, theirs, { view: 'daily' }));
  assert.equal(v.toast(), null);
  assert.match(v.text('mode'), /^Daily #6 /);
  // Back to the levels: their next move comes in, with a toast, and the view is written.
  const more = Object.assign({}, theirs, { undos: 1, moves: 0, tracks: LEVEL1_START, history: [] });
  localStorage.setItem(STATE_KEY, JSON.stringify(more));
  v.click('daily-button');
  assert.deepEqual(v.state(), more);
  assert.equal(v.toast(), 'Another tab saved level 1 (0 moves): it is shown here.');
  assert.equal(v.text('moves'), '0');
});

test('defrag: a level game another tab writes between the check and the write is taken over, never written over', (t) => {
  const { v } = openPage(t);
  const board = dfg.dfgLevelBoard(1);
  const route = dfg.dfgSolve(board, LEVEL1_START, dfg.dfgLimits).path;
  const history = route.slice(0, 2);
  const theirs = JSON.stringify({ v: 1, view: 'level', level: 1, tracks: playModel(board, LEVEL1_START, history, 'theirs'), history, moves: 2, undos: 0, hints: 0 });
  // Both taps read dfg-state first (nothing new yet); the other tab writes before the move is saved.
  const real = localStorage.getItem;
  let reads = 0;
  t.mock.method(localStorage, 'getItem', function (key) {
    if (key === STATE_KEY && ++reads === 3) localStorage.setItem(STATE_KEY, theirs);
    return real.call(localStorage, key);
  });
  v.move(route[0][0], route[0][1]);
  assert.equal(reads, 3);
  assert.equal(localStorage.getItem(STATE_KEY), theirs, 'the other tab\'s game stays');
  assert.equal(v.text('moves'), '2');
  assert.equal(v.toast(), 'Another tab saved level 1 (2 moves): it is shown here.');
});

test('defrag: a Daily record another tab writes between the check and the write is taken over, never written over', (t) => {
  const { v } = openPage(t);
  v.click('daily-button');
  v.move(0, 3);
  // The other tab: one more move after an undo and a redo of its own (4 steps, the undo here makes 2).
  const theirs = Object.assign(v.daily(), { tracks: dfg.dfgApplyMove(v.daily().tracks, 4, 6, 1), moves: 2, undos: 1, history: [[0, 3, 1], [4, 6, 1]] });
  const text = JSON.stringify(theirs);
  // The undo reads dfg-daily first (nothing new yet); the other tab writes before the undo is saved.
  const real = localStorage.getItem;
  let reads = 0;
  t.mock.method(localStorage, 'getItem', function (key) {
    if (key === DAILY_KEY && ++reads === 2) localStorage.setItem(DAILY_KEY, text);
    return real.call(localStorage, key);
  });
  v.click('undo');
  assert.equal(reads, 2);
  assert.equal(localStorage.getItem(DAILY_KEY), text, 'the other tab\'s record stays');
  assert.equal(v.text('moves'), '2');
  assert.equal(v.toast(), 'Another tab saved Daily #6 (2 moves): it is shown here.');
});

test('defrag: opening the Daily resumes the attempt another tab began; a record from after today never blocks today\'s; level play stays on screen', (t) => {
  const { v } = openPage(t);
  localStorage.setItem(DAILY_KEY, SAMPLE_DAILY);
  v.click('daily-button');
  assert.equal(localStorage.getItem(DAILY_KEY), SAMPLE_DAILY, 'no second attempt begins');
  assert.equal(v.text('moves'), '1');
  assert.equal(v.toast(), null, 'opening it needs no toast');
  resetStubs();
  const future = JSON.stringify(Object.assign(JSON.parse(SAMPLE_DAILY), { key: '2026-11-09' }));
  const later = openPage(t, { storage: { daily: future } }).v;
  later.click('daily-button');
  assert.equal(later.daily().key, KEY6);
  assert.equal(later.daily().moves, 0);
  localStorage.setItem(DAILY_KEY, future);
  fire(window, 'storage', { key: DAILY_KEY });
  assert.match(later.text('mode'), /^Daily #6 /);
  later.move(0, 3);
  assert.equal(later.daily().key, KEY6);
  // In level play another tab's Daily win shows on the button only.
  resetStubs();
  const fresh = openPage(t).v;
  localStorage.setItem(DAILY_KEY, JSON.stringify({ key: KEY6, status: 'won', tracks: DAILY6.goal, moves: 14, streak: 1, lastWon: 6 }));
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(fresh.text('daily-button'), 'Daily #6 ✓');
  assert.equal(fresh.text('streak'), '1');
  assert.match(fresh.text('mode'), /^Level 1 /);
  assert.equal(fresh.toast(), null);
});

test('defrag: a second tab never erases another tab\'s progress: merged before every write and through the storage event', (t) => {
  const { v } = openPage(t);
  // Meanwhile another tab defragments levels 1 to 4.
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ v: 1, highest: 4, moves: { 1: 5, 2: 11, 3: 6, 4: 10 } }));
  fire(window, 'storage', { key: PROGRESS_KEY });
  assert.equal(v.el('next').disabled, false, 'level 2 is open now');
  assert.equal(v.text('best'), '5');
  solveOnPage(v, dfg.dfgLevelBoard(1), LEVEL1_START);
  assert.equal(v.toast(), 'Level 1 defragmented in 9 moves.');
  assert.deepEqual(v.progress(), { v: 1, highest: 4, moves: { 1: 5, 2: 11, 3: 6, 4: 10 } });
  // A storage event for the state key changes nothing.
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.text('best'), '5');
});

// ── Saves on the page ────────────────────────────────────────────────────────

test('defrag: saves in the current format load as they were and are written back in the same format', (t) => {
  const { v } = openPage(t, { storage: { state: SAMPLE_STATE, progress: SAMPLE_PROGRESS, daily: SAMPLE_DAILY } });
  assert.equal(v.text('mode'), 'Level 2 · 4 files · 6 tracks of 4');
  assert.equal(v.text('moves'), '2');
  assert.equal(v.text('hints'), '1');
  assert.equal(v.text('streak'), '2');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE);
  assert.equal(localStorage.getItem(PROGRESS_KEY), SAMPLE_PROGRESS);
  assert.equal(localStorage.getItem(DAILY_KEY), SAMPLE_DAILY);
  v.click('undo');
  const written = v.state();
  assert.deepEqual(Object.keys(written), Object.keys(JSON.parse(SAMPLE_STATE)));
  assert.deepEqual(written, Object.assign(JSON.parse(SAMPLE_STATE), {
    tracks: [[0], [0, 1, 3, 2], [3, 0], [3, 0, 3], [2, 2, 1, 1], [1, 2]], history: [[0, 4, 1]], moves: 1, undos: 2
  }));
  v.click('undo');
  assert.deepEqual(v.state().tracks, LEVEL2_START);
  // The Daily sample resumes as it was.
  v.click('daily-button');
  assert.equal(localStorage.getItem(DAILY_KEY), SAMPLE_DAILY);
  assert.equal(v.text('moves'), '1');
  v.click('undo');
  assert.deepEqual(v.daily().tracks, DAILY6.start);
  assert.deepEqual(Object.keys(v.daily()), Object.keys(JSON.parse(SAMPLE_DAILY)));
});

test('defrag: a save whose move count is below its own history counts the history: the counter never goes below 0 and the best is the real count', (t) => {
  const damaged = SAMPLE_STATE.replace('"moves":2', '"moves":0');
  assert.notEqual(damaged, SAMPLE_STATE);
  const { v } = openPage(t, { storage: { state: damaged, progress: SAMPLE_PROGRESS, daily: SAMPLE_DAILY.replace('"moves":1', '"moves":0') } });
  assert.equal(v.text('moves'), '2');
  assert.equal(v.state().moves, 2, 'written back repaired');
  v.click('undo');
  v.click('undo');
  assert.equal(v.text('moves'), '0');
  assert.deepEqual(v.state().tracks, LEVEL2_START);
  const board = dfg.dfgLevelBoard(2);
  const moves = solveOnPage(v, board, LEVEL2_START);
  assert.equal(v.progress().moves[2], moves);
  assert.ok(moves >= bfsMin(board, LEVEL2_START), 'never below the fewest moves there are');
  // The Daily the same way.
  v.click('daily-button');
  assert.equal(v.text('moves'), '1');
  v.click('undo');
  assert.equal(v.text('moves'), '0');
  assert.deepEqual([v.daily().moves, v.daily().undos], [0, 1]);
});

test('defrag: a game in progress survives a reload: tracks, history, moves, undos and hints', (t) => {
  const { clock, v } = openPage(t, { storage: { progress: { highest: 4 } } });
  v.click('prev');
  v.click('hint');
  const board = dfg.dfgLevelBoard(4);
  const legal = dfg.dfgLegalMoves(board, board.start);
  v.move(legal[0][0], legal[0][1]);
  v.move(legal[0][1], legal[0][0]);
  v.click('undo');
  const snapshot = v.state();
  const drawn = v.tracks().map((el) => el.getAttribute('aria-label'));
  const again = reload(clock, v);
  assert.deepEqual(again.state(), snapshot);
  assert.deepEqual(again.tracks().map((el) => el.getAttribute('aria-label')), drawn);
  assert.equal(again.text('moves'), String(snapshot.moves));
  again.click('undo');
  assert.deepEqual(again.state().tracks, board.start, 'undo still works after the reload');
});

test('defrag: corrupt or partial saves never break the page: a playable disk instead', (t) => {
  const cases = {
    'not JSON': ['{', '{', '{'],
    'wrong types': ['[1,2]', '"x"', '42'],
    'empty objects': ['{}', '{}', '{}'],
    'nulls': ['null', 'null', 'null'],
    'tracks of another level': [JSON.stringify({ level: 1, tracks: LEVEL2_START, history: [[9, 9, 9]], moves: -3 }), '{"highest":"x"}', '{"key":"2026-11-06","tracks":5,"status":"won"}'],
    'a locked level': [JSON.stringify({ level: 30, tracks: [] }), '{"highest":2,"moves":{"1":"6"}}', '{"key":"2026-13-40","streak":"x"}']
  };
  for (const [name, [state, progress, daily]] of Object.entries(cases)) {
    resetStubs();
    const { v } = openPage(t, { storage: { state, progress, daily } });
    const parsed = dfg.dfgParseState(state, dfg.dfgParseProgress(progress).highest);
    assert.equal(v.state().level, parsed.level, name);
    assert.equal(v.tracks().length, dfg.dfgLevelBoard(parsed.level).sys.length, name);
    assert.ok(dfg.dfgValidTracks(v.state().tracks, dfg.dfgLevelBoard(parsed.level)), name);
    const [a, b] = dfg.dfgLegalMoves(dfg.dfgLevelBoard(parsed.level), v.state().tracks)[0];
    v.move(a, b);
    assert.equal(v.state().history.length >= 1, true, name);
    v.click('daily-button');
    assert.equal(v.daily().key, KEY6, name);
  }
});

test('defrag: blocked storage never stops the game, and the warning names the keys', (t) => {
  blockStorage('access', t);
  const { v } = openPage(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Storage is blocked or full (SecurityError): dfg-daily, dfg-progress, dfg-state are not saved on this page. The game plays on.');
  assert.equal(v.tracks().length, 6);
  solveOnPage(v, dfg.dfgLevelBoard(1), LEVEL1_START);
  assert.equal(v.toast(), 'Level 1 defragmented in 9 moves: new best!');
  assert.equal(v.el('next').disabled, false, 'the progress lives on in the page');
  v.click('next');
  assert.match(v.text('mode'), /^Level 2 /);
  v.click('daily-button');
  assert.equal(v.tracks().length, 8);
  v.move(0, 3);
  assert.equal(v.text('moves'), '1');
});

test('defrag: full storage still reads the saves; the game plays on and the warning names each key that failed', (t) => {
  writeStorage({ state: SAMPLE_STATE, progress: SAMPLE_PROGRESS });
  blockStorage('full', t);
  const { v } = openPage(t);
  assert.equal(v.text('moves'), '2', 'the save is still read');
  assert.equal(v.text('warning'), 'Storage is blocked or full (QuotaExceededError): dfg-state is not saved on this page. The game plays on.');
  v.click('undo');
  assert.equal(v.text('moves'), '1');
  // The save still stored is this tab's own older game, never another tab's: a restart stays a restart.
  v.click('restart');
  v.click('restart');
  assert.equal(v.text('moves'), '0');
  assert.doesNotMatch(String(v.toast()), /Another tab/);
  v.click('daily-button');
  v.click('daily-button');
  assert.equal(v.text('moves'), '0');
  v.click('daily-button');
  assert.equal(v.text('warning'), 'Storage is blocked or full (QuotaExceededError): dfg-daily, dfg-state are not saved on this page. The game plays on.');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE);
  assert.equal(localStorage.getItem(DAILY_KEY), null);
});

test('defrag: the undo history keeps the last 500 moves; older moves cannot be undone', (t) => {
  const { v } = openPage(t);
  // Level 1 has no empty track: four moves empty track 3, then syslog.log x3 goes back and forth between tracks 2 and 3.
  for (const [a, b] of [[0, 2], [1, 5], [2, 1], [2, 5]]) v.move(a, b);
  assert.deepEqual(v.state().tracks.slice(1, 3), [[3, 3, 3], []]);
  for (let i = 0; i < 249; i++) {
    v.move(1, 2);
    v.move(2, 1);
  }
  assert.equal(v.state().history.length, 500);
  assert.equal(v.state().moves, 502);
  for (let i = 0; i < 500; i++) v.click('undo');
  assert.equal(v.state().moves, 2);
  v.click('undo');
  assert.equal(v.toast(), 'Nothing to undo: the undo history keeps the last 500 moves.');
});
