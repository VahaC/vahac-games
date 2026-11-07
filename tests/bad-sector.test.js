// tests/bad-sector.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, keyEvent, focusElement, setVisibility, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'bad-sector';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

// The pure functions (the start-up code does not run under Node).
const bds = loadScript(SCRIPT);

const STATE_KEY = 'bds-state';
const BEST_KEY = 'bds-best';
const DAILY_KEY = 'bds-daily';

// The geometry and rules as the game describes them, written out here so a
// change to one of them shows up as a failing test.
const W = 360;
const H = 480;
const COLS = 10;
const ROWS = 8;
const CELLS = 80;
const GRID_X = 15;
const GRID_Y = 64;
const CELL_W = 33;
const CELL_H = 16;
const RO = 9;
const PADDLE_Y = 424;
const PADDLE_H = 10;
const R = 5;
const MAX_SPEED = 460;
const STEP = 1 / 120;
const DROP_W = 44;
const DROP_H = 14;
// A monospace glyph is about 0.6 em wide; 0.62 leaves a little slack.
const MONO = 0.62;

// Local noon and 23:59:30 of 2026-11-06 (Daily #6), in local time so the
// tests give the same day in every time zone.
const NOV6 = new Date(2026, 10, 6, 12, 0, 0).getTime();
const NOV6_LATE = new Date(2026, 10, 6, 23, 59, 30).getTime();
const KEY5 = '2026-11-05';
const KEY6 = '2026-11-06';
const KEY7 = '2026-11-07';

// The Daily disk of 2026-11-06, pinned: a change to the generator, the seed
// or the PRNG changes every visitor's Daily and has to show up here.
const DAILY6_GRID = [
  0, 33, 33, 33, 22, 22, 9, 22, 133, 11,
  11, 11, 11, 11, 0, 0, 0, 0, 0, 11,
  22, 33, 33, 11, 11, 11, 211, 0, 33, 22,
  11, 11, 11, 0, 0, 9, 0, 11, 11, 11,
  33, 322, 0, 0, 22, 333, 22, 33, 22, 11,
  9, 11, 111, 11, 11, 33, 22, 33, 33, 22,
  9, 0, 11, 11, 11, 11, 0, 0, 0, 11,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0
];

// A grid with the given cells (index -> code), the rest free.
function gridWith(cells) {
  const grid = new Array(CELLS).fill(0);
  for (const [index, code] of Object.entries(cells)) grid[index] = code;
  return grid;
}

// A launch from the middle of the carriage first meets cell 72 (track 7,
// column 2); cell 9 (top right) is never on the head's first paths.
const FIRST_HIT = 72;
const FAR_CELL = 9;

// A bds-state in the format the first published version writes: track 2,
// 14 of 38 sectors left (plain, bad, read-only and bonus sectors), 340 points,
// one head lost, 4.5 s of ECC left, the heads at 251 units a second and the
// carriage at 150 with the head waiting on it.
const SAMPLE_GRID = gridWith({
  0: 11, 1: 11, 2: 22, 3: 21, 4: 9, 6: 133, 7: 11, 8: 232, 9: 311,
  11: 33, 12: 32, 13: 31, 14: 9, 15: 11, 16: 11, 19: 11, 30: 9, 39: 9
});
const SAMPLE_SAVE = '{"v":1,"view":"free","level":2,"phase":"serve","practice":null,"score":340,"lives":2,' +
  '"total":38,"grid":[' + SAMPLE_GRID.join(',') + '],"ecc":4.5,"slow":0,"speed":251,"paddle":150,"balls":[],"drops":[]}';

// The same game with two heads in flight (RAID1) and an ECC bonus falling.
const SAMPLE_FLIGHT = '{"v":1,"view":"free","level":2,"phase":"play","practice":null,"score":340,"lives":2,' +
  '"total":38,"grid":[' + SAMPLE_GRID.join(',') + '],"ecc":4.5,"slow":1.25,"speed":251,"paddle":150,' +
  '"balls":[[100.5,300.25,120,-220.5],[259.5,300.25,-120,-220.5]],"drops":[[200,250.5,2]]}';

// A bds-daily of the same version: Daily #6 under way, 120 points, the head
// waiting on the carriage at 120, a streak of 2 from yesterday.
const SAMPLE_DAILY_GRID = DAILY6_GRID.map((code, i) => (i === 1 ? 32 : i === 9 ? 0 : code));
const SAMPLE_DAILY = '{"v":1,"key":"2026-11-06","day":6,"status":"playing","score":120,"lives":3,"total":50,' +
  '"grid":[' + SAMPLE_DAILY_GRID.join(',') + '],"ecc":0,"slow":0,"speed":281,"paddle":120,"balls":[],"drops":[],' +
  '"streak":2,"lastWon":5}';

test.beforeEach(() => resetStubs());

// ── An independent model ─────────────────────────────────────────────────────

const rectOf = (i) => ({ x: GRID_X + (i % COLS) * CELL_W + 1, y: GRID_Y + Math.floor(i / COLS) * CELL_H + 1, w: CELL_W - 2, h: CELL_H - 2 });
const isSector = (code) => code > 0 && code !== RO;
const countSectors = (grid) => grid.filter(isSector).length;

// Whether a circle of radius R at (x, y) overlaps rect.
function overlaps(x, y, rect) {
  const dx = x - Math.min(Math.max(x, rect.x), rect.x + rect.w);
  const dy = y - Math.min(Math.max(y, rect.y), rect.y + rect.h);
  return dx * dx + dy * dy < R * R;
}

// The cells a head can reach: from every cell on the rim of the grid, over
// cells that are not read-only (written with a queue and a Set).
function reachableModel(grid) {
  const seen = new Set();
  const queue = [];
  for (let i = 0; i < CELLS; i++) {
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    if ((r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1) && grid[i] !== RO) {
      seen.add(i);
      queue.push(i);
    }
  }
  while (queue.length) {
    const at = queue.shift();
    const r = Math.floor(at / COLS);
    const c = at % COLS;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      const j = nr * COLS + nc;
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && !seen.has(j) && grid[j] !== RO) {
        seen.add(j);
        queue.push(j);
      }
    }
  }
  return seen;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

const speedOf = (ball) => Math.hypot(ball.vx, ball.vy);
const near = (a, b, what, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, what + ': ' + a + ' instead of ' + b);
const input = (extra) => Object.assign({ move: 0, target: null, launch: false }, extra);

// A sim in play with the given heads.
function playing(grid, balls, extra) {
  return Object.assign(bds.bdsNewSim(1, grid, 0, 3), { phase: 'play', balls }, extra);
}

// ── Pages ────────────────────────────────────────────────────────────────────

// One mocked clock for timers, Date, performance.now() and animation frames
// (a frame every 16 ms, with the time as its timestamp).  reload() drops the
// timers and frames of the page that goes away, as a real reload does.
function makeClock(t, when = NOV6) {
  let wall = when;
  let perf = 1000;
  let frames = [];
  let nextFrame = 1;
  const enable = () => t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: wall });
  try {
    enable();
  } catch (error) {
    t.mock.timers.reset(); // a second page in the same test
    enable();
  }
  t.mock.method(performance, 'now', () => perf);
  t.mock.method(globalThis, 'requestAnimationFrame', (callback) => {
    frames.push({ id: nextFrame, callback });
    return nextFrame++;
  });
  t.mock.method(globalThis, 'cancelAnimationFrame', (id) => {
    frames = frames.filter((frame) => frame.id !== id);
  });
  const clock = {
    flush() {
      const batch = frames;
      frames = [];
      batch.forEach((frame) => frame.callback(perf));
    },
    advance(ms) {
      for (let i = 0; i < ms; i++) {
        perf++;
        wall++;
        t.mock.timers.tick(1);
        if (perf % 16 === 0) clock.flush();
      }
      return clock;
    },
    // Time passing with no frame at all (a frozen or throttled tab).
    stall(ms) {
      perf += ms;
      wall += ms;
      t.mock.timers.tick(ms);
      return clock;
    },
    pending: () => frames.length,
    reload() {
      frames = [];
      t.mock.timers.reset();
      enable();
    }
  };
  return clock;
}

function writeStorage(storage = {}) {
  for (const [key, value] of [[STATE_KEY, storage.state], [BEST_KEY, storage.best], [DAILY_KEY, storage.daily]]) {
    if (value !== undefined) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

const storedKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();

// A bds-state object for a free game.
function stateSave(extra) {
  return Object.assign({ v: 1, view: 'free', level: 1, phase: 'serve', practice: null, score: 0, lives: 3, total: 1, grid: gridWith({ [FIRST_HIT]: 11 }), ecc: 0, slow: 0 }, extra);
}

// A bds-daily object for a Daily.
function dailySave(extra) {
  return Object.assign({ v: 1, key: KEY6, day: 6, status: 'playing', score: 0, lives: 3, total: 50, grid: gridWith({ [FIRST_HIT]: 11 }), ecc: 0, slow: 0, streak: 0, lastWon: null }, extra);
}

// What a player sees and does.  The canvas context records what the last
// drawing showed: the carriage, the heads, the falling bonuses and the texts.
function pageView(b) {
  const els = b.els;
  const canvas = els['bds-canvas'];
  const ctx = canvas.getContext('2d');
  let drawn = [];
  ctx.setTransform = () => { drawn = []; };
  ctx.fillRect = (x, y, w, h) => drawn.push({ kind: 'rect', x, y, w, h, style: ctx.fillStyle });
  ctx.arc = (x, y, r) => drawn.push({ kind: 'arc', x, y, r });
  ctx.fillText = (text, x, y) => drawn.push({ kind: 'text', text, x, y, font: ctx.font });
  // Monospace widths, so a text that has to fit can be checked.
  ctx.measureText = (text) => ({ width: text.length * MONO * Number(/(\d+)px/.exec(ctx.font)[1]) });
  const v = {
    els,
    canvas,
    page: b.page,
    ready: b.ready,
    restore: b.restore,
    el: (name) => els['bds-' + name],
    text: (name) => els['bds-' + name].textContent,
    hidden: (name) => els['bds-' + name].classList.contains('bds-hidden'),
    drawn: () => drawn,
    paddle() {
      const rect = drawn.filter((d) => d.kind === 'rect' && d.y === PADDLE_Y && d.h === PADDLE_H).pop();
      return { x: rect.x + rect.w / 2, w: rect.w };
    },
    balls: () => drawn.filter((d) => d.kind === 'arc' && d.r === R).map((d) => ({ x: d.x, y: d.y })),
    drops: () => drawn.filter((d) => d.kind === 'rect' && d.w === DROP_W && d.h === DROP_H),
    texts: () => drawn.filter((d) => d.kind === 'text').map((d) => d.text),
    press(key, props) {
      focusElement(canvas, { keyboard: true });
      return pressKey(key, Object.assign({ target: canvas }, props));
    },
    release: (key, props) => canvas.dispatchEvent(keyEvent(key, Object.assign({ type: 'keyup' }, props))),
    pointer: (type, props) => fire(canvas, type, Object.assign({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 360, clientY: 600 }, props)),
    mouseTo: (x) => fire(canvas, 'pointermove', { pointerId: 1, pointerType: 'mouse', clientX: x * 2, clientY: 600 }),
    tap(x = 180, kind = 'touch') {
      v.pointer('pointerdown', { pointerType: kind, clientX: x * 2 });
      v.pointer('pointerup', { pointerType: kind, clientX: x * 2 });
    },
    click: (name) => els['bds-' + name].click(),
    toast: () => (els['bds-toast'].classList.contains('bds-show') ? els['bds-toast'].textContent : null),
    state: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    daily: () => JSON.parse(localStorage.getItem(DAILY_KEY)),
    best: () => JSON.parse(localStorage.getItem(BEST_KEY))
  };
  return v;
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

// A reload: the old page, its timers and frames go away, storage stays.
function reload(clock, v) {
  clock.reload();
  v.restore();
  return boot();
}

// Plays with the mouse for up to ms: the carriage goes under the lowest
// falling head (a little off centre, so it does not bounce straight up), or
// under the lowest bonus while no head falls low.  dodge: the carriage keeps
// away from the heads instead.  Stops early once until() holds.
function play(v, clock, ms, { dodge = false, until = () => false } = {}) {
  let last = [];
  for (let spent = 0; spent < ms && !until(); spent += 16) {
    const balls = v.balls();
    const falling = balls.filter((ball, i) => last[i] && ball.y > last[i].y && ball.y > 250).sort((a, b) => b.y - a.y);
    const drops = v.drops();
    if (dodge && balls.length) {
      v.mouseTo(balls[0].x > W / 2 ? 30 : W - 30);
    } else if (!dodge && falling.length) {
      v.mouseTo(falling[0].x + 10);
    } else if (!dodge && drops.length) {
      v.mouseTo(drops[0].x + DROP_W / 2);
    }
    last = balls;
    clock.advance(16);
  }
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

test('bad-sector: every id the script looks up is in index.html once; ids, classes, CSS variables, keyframes, storage keys and exports are bds- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'bds-best', 'bds-canvas', 'bds-daily-button', 'bds-effects', 'bds-level', 'bds-mode', 'bds-new', 'bds-next',
    'bds-overlay', 'bds-overlay-text', 'bds-pause', 'bds-practice', 'bds-score', 'bds-sectors', 'bds-share',
    'bds-share-button', 'bds-share-text', 'bds-smart', 'bds-stage', 'bds-status', 'bds-streak', 'bds-toast', 'bds-warning'
  ]);
  assert.equal(ids.length, new Set(ids).size, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^bds-/);

  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^bds-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^bds-/, selector);
    }
  }
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^bds-/);
  for (const m of JS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^bds-/);
  const keyframes = Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);
  assert.ok(keyframes.length >= 1);
  for (const name of keyframes) assert.match(name, /^bds-/);
  for (const m of CSS.matchAll(/animation(?:-name)?:\s*([\w-]+)/g)) assert.ok(m[1] === 'none' || keyframes.includes(m[1]), m[1]);
  assert.deepEqual([...new Set(Array.from(JS.matchAll(/'(bds-(?:state|best|daily))'/g), (m) => m[1]))].sort(), [BEST_KEY, DAILY_KEY, STATE_KEY]);
  assert.deepEqual(Array.from(JS.matchAll(/localStorage\.\w+/g), (m) => m[0]).sort(), ['localStorage.getItem', 'localStorage.setItem']);
  for (const name of Object.keys(bds)) assert.match(name, /^bds[A-Z]/);
  // The geometry the tests write out is the game's.
  assert.deepEqual(bds.bdsConstants, {
    W, H, COLS, ROWS, CELLS, GRID_X, GRID_Y, CELL_W, CELL_H, RO, PADDLE_Y, PADDLE_H, PADDLE_W: 64, PADDLE_WIDE: 96,
    PADDLE_SPEED: 420, BALL_R: R, MAX_SPEED, STEP, SCALE: 2, DROP_W, DROP_H
  });
});

test('bad-sector: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="bds-wrapper"'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');
  const bg = CSS.match(/--bds-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Bad Sector — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  // One script, at the end of the body; no external resources and no network at all.
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(|@font-face/, 'no network resources');
  }
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|Worker)\b/, 'no network calls');
  // Original names only: no commercial brick-breaker title anywhere.
  for (const text of [HTML, CSS, JS]) assert.doesNotMatch(text, /arkanoid|breakout|dx-ball|bricks? n balls|ricochet/i);
});

test('bad-sector: script.js is one strict IIFE in ES5', () => {
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
    ['newer methods', /(?<!ctx)\.(padStart|padEnd|includes|find|findIndex|flat|flatMap|fill|assign|entries|values)\(/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('bad-sector: index.html has a focusable, labelled platter, labelled buttons and live regions', () => {
  const spec = htmlPageSpec(HTML);
  assert.equal(spec['bds-canvas'].tagName, 'canvas');
  assert.equal(spec['bds-canvas'].width, 720);
  assert.equal(spec['bds-canvas'].height, 960);
  assert.equal(spec['bds-canvas'].attributes.tabindex, '0');
  assert.match(spec['bds-canvas'].attributes['aria-label'], /Left and Right or A and D move the carriage, Space launches, P pauses/);
  assert.equal(spec['bds-canvas'].parent, 'bds-stage');
  assert.equal(spec['bds-overlay'].parent, 'bds-stage');
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
      assert.notEqual(props.parent, 'bds-stage', id + ' is outside the stage, so it keeps its own keys');
    }
  }
  assert.equal(spec['bds-pause'].attributes['aria-pressed'], 'false');
  assert.equal(spec['bds-share-text'].readOnly, true);
  assert.equal(spec['bds-status'].attributes['aria-live'], 'polite');
  assert.equal(spec['bds-toast'].attributes['aria-live'], 'polite');
  assert.equal(spec['bds-warning'].attributes.role, 'alert');
  for (const id of ['bds-warning', 'bds-share', 'bds-next', 'bds-practice', 'bds-share-text']) assert.match(spec[id].className, /\bbds-hidden\b/, id);
});

// The platter's width for a viewport, as style.css lays it out: the column
// less the wrapper's side padding, the drive box's padding and border, at
// most --bds-platter-fit for the viewport height vh (432 px, or what keeps
// the 3:4 canvas within vh less 64 px, but never below 150 px).
const LAYOUT_RULES = cssRules(CSS);
function platterAt(vw, vh) {
  const at = (selector) => declsAt(LAYOUT_RULES, selector, vw);
  const wrapper = at('.bds-wrapper');
  const side = px(wrapper.padding.split(/\s+/)[1]);
  const available = Math.min(vw, px(wrapper['max-width'])) - 2 * side;
  const fit = Math.min(px(wrapper['--bds-platter-max']), Math.max(150, (vh - 64) * 0.75));
  const drive = at('.bds-drive');
  const driveWidth = Math.min(available, fit + 18);
  const width = Math.min(driveWidth - 2 * px(drive.padding) - 2 * px(drive.border.split(/\s+/)[0]), fit);
  return { available, width, height: (width * 4) / 3 };
}

test('bad-sector: from 320 to 1440 px the platter fits without widening the page, keeps its 3:4 shape, and nothing wraps out of its box', () => {
  const rules = LAYOUT_RULES;
  const at = (selector, vw) => declsAt(rules, selector, vw);
  // The platter is at most 432 px wide and never taller than the viewport less 64 px.
  assert.equal(at('.bds-wrapper', 320)['--bds-platter-fit'], 'min(var(--bds-platter-max), max(150px, calc((100vh - 64px) * 0.75)))');
  for (let vw = 320; vw <= 1440; vw++) {
    const { available, width: canvasWidth } = platterAt(vw, 900);
    assert.equal(at('.bds-wrapper *', vw)['box-sizing'], 'border-box');
    // The drive box is at most its max width and never wider than the column.
    const drive = at('.bds-drive', vw);
    assert.equal(drive.width, '100%');
    assert.equal(drive['max-width'], 'calc(var(--bds-platter-fit) + 18px)');
    assert.equal(at('.bds-stage', vw)['max-width'], 'var(--bds-platter-fit)');
    assert.ok(canvasWidth >= 280 || vw >= 360, vw + 'px: a platter of ' + canvasWidth + 'px');
    assert.ok(canvasWidth > 0 && canvasWidth <= available, vw + 'px');
    // Six stat cards in equal columns; values wrap instead of widening a card.
    const columns = /^repeat\(([36]), minmax\(0, 1fr\)\)$/.exec(at('.bds-stats', vw)['grid-template-columns']);
    assert.ok(columns, vw + 'px');
    assert.equal(Number(columns[1]), vw <= 640 ? 3 : 6);
    const card = (available - (Number(columns[1]) - 1) * px(at('.bds-stats', vw).gap)) / Number(columns[1]);
    const stat = at('.bds-stat', vw);
    const content = card - 2 * px(stat.padding.split(/\s+/)[1]) - 2;
    const char = 0.61 * rem(at('.bds-stat-value', vw)['font-size']);
    // '50/50' (the sectors) fits on one line.  A long Best such as '99999 / T99' wraps at its spaces: each
    // of its words fits, so it never has to break inside a number; anything longer wraps anywhere.
    assert.ok('50/50'.length * char <= content, vw + 'px: ' + content);
    for (const word of '99999 / T999'.split(' ')) assert.ok(word.length * char <= content, vw + 'px: ' + word + ' in ' + content);
    assert.equal(at('.bds-stat-value', vw)['white-space'], 'normal');
    assert.equal(at('.bds-stat-value', vw)['overflow-wrap'], 'anywhere');
    assert.equal(at('.bds-stat', vw)['min-width'], '0');
    // Two buttons share a phone row: 'Confirm new disk' in the header, Pause and 'Confirm practice' below the platter.
    if (vw <= 640) {
      for (const [row, longest] of [['.bds-header-actions', 'Confirm new disk'], ['.bds-controls', 'Confirm practice']]) {
        const btn = at(row + ' .bds-btn', vw);
        assert.equal(btn.flex, '1 1 0');
        assert.equal(btn['min-width'], '0');
        const width = (available - px(at(row, vw).gap)) / 2;
        const label = longest.length * 0.55 * rem(at('.bds-btn', vw)['font-size']);
        assert.ok(label + 2 * rem(btn['padding-left']) <= width, vw + 'px: ' + label + ' in ' + width);
      }
    }
  }
  // Landscape phones and short windows: the whole platter, sectors and carriage, fits the viewport height
  // less 64 px; portrait phones keep the full column width.
  for (const [vw, vh] of [[568, 320], [640, 360], [667, 375], [740, 360], [844, 390], [915, 412], [1024, 600]]) {
    const p = platterAt(vw, vh);
    assert.ok(p.height <= vh - 64 + 1e-9, vw + 'x' + vh + ': a platter ' + p.height + 'px tall');
    assert.ok(p.width >= 192, vw + 'x' + vh + ': ' + p.width + 'px wide');
  }
  assert.equal(platterAt(320, 568).width, 294);
  assert.equal(platterAt(414, 896).width, 414 - 2 * 12 - 2 * 8 - 2);
  assert.equal(platterAt(1440, 900).width, 432);
  assert.equal(platterAt(1440, 200).width, 150, 'never below 150 px');
  // The canvas scales with its column and keeps the shape its 720x960 pixels give it.
  assert.deepEqual([at('.bds-canvas', 320).width, at('.bds-canvas', 320).height, at('.bds-canvas', 320).display], ['100%', 'auto', 'block']);
  assert.equal(at('.bds-stage', 320).position, 'relative');
  assert.equal(at('.bds-stage', 320).display, undefined, 'the stage is no grid, so the overlay needs no grid lines');
  const overlay = at('.bds-overlay', 320);
  assert.deepEqual([overlay.position, overlay.top, overlay.right, overlay.bottom, overlay.left], ['absolute', '0', '0', '0', '0']);
  assert.equal(overlay['pointer-events'], 'none', 'a tap on the message reaches the canvas');
  // The message is in a flex column with explicit alignment and wraps anywhere.
  assert.deepEqual([overlay.display, overlay['flex-direction'], overlay['align-items'], overlay['justify-content']], ['flex', 'column', 'center', 'center']);
  assert.equal(at('.bds-overlay-text', 320)['overflow-wrap'], 'anywhere');
  for (const selector of ['.bds-status', '.bds-warning', '.bds-mode', '.bds-effects', '.bds-toast']) assert.equal(at(selector, 320)['overflow-wrap'], 'anywhere', selector);
  // The toast is centred between both edges, so it can use the whole phone width.
  const toast = at('.bds-toast', 320);
  assert.deepEqual([toast.left, toast.right, toast.width, toast.margin, toast.transform], ['16px', '16px', 'fit-content', '0 auto', 'translateY(100px)']);
  // Only the canvas takes touch gestures; buttons drop the double-tap zoom only.
  const touch = rules.filter((rule) => rule.decls['touch-action'] !== undefined);
  assert.deepEqual(touch.map((rule) => [rule.selectors, rule.decls['touch-action']]), [[['.bds-btn'], 'manipulation'], [['.bds-canvas'], 'none']]);
  // The focus ring of the canvas is drawn inside it.
  assert.equal(at('.bds-canvas:focus-visible', 320)['outline-offset'], '-2px');
  assert.equal(at('.bds-hidden', 320).display, 'none !important');
  assert.equal(declsAt(rules, '.bds-toast.bds-show', 320, { matchMedia: (q) => /prefers-reduced-motion/.test(q) }).animation, 'none');
});

// ── Grid and tracks ──────────────────────────────────────────────────────────

test('bad-sector: a cell is one integer: free, read-only, or a sector with its bonus, hits and hits left', () => {
  assert.equal(bds.bdsCell(2, 3, 1), 231);
  for (let code = -2; code <= 420; code++) {
    const power = Math.floor(code / 100);
    const max = Math.floor(code / 10) % 10;
    const hp = code % 10;
    const valid = code === 0 || code === RO || (code > 0 && power <= 3 && max >= 1 && max <= 3 && hp >= 1 && hp <= max);
    assert.equal(bds.bdsValidCell(code), valid, String(code));
  }
  for (const bad of [1.5, '11', null, undefined, NaN, Infinity, [], {}]) assert.equal(bds.bdsValidCell(bad), false, String(bad));
  assert.equal(bds.bdsIsSector(0), false);
  assert.equal(bds.bdsIsSector(RO), false);
  assert.equal(bds.bdsIsSector(11), true);
  assert.equal(bds.bdsCountSectors(SAMPLE_GRID), 14);
  for (let i = 0; i < CELLS; i++) assert.deepEqual(bds.bdsCellRect(i), rectOf(i), 'cell ' + i);
  assert.equal(bds.bdsLba(1, 0), 0x10000);
  assert.equal(bds.bdsLba(3, 72), 3 * 65536 + 7 * 1024 + 2 * 64);
  assert.equal(bds.bdsLbaText(1, 72), 'LBA 0x011C80');
  assert.equal(bds.bdsLbaText(300, 79), 'LBA 0x12C1E40', 'never cut short');
  assert.deepEqual(bds.bdsNeighbours(0), [1, 10]);
  assert.deepEqual(bds.bdsNeighbours(79), [69, 78]);
  assert.deepEqual(bds.bdsNeighbours(45), [35, 46, 55, 44]);
});

test('bad-sector: pruning drops exactly the sectors walled in by read-only ones (checked against a flood fill on 500 random grids)', () => {
  const rnd = seeded(11);
  for (let k = 0; k < 500; k++) {
    const grid = Array.from({ length: CELLS }, () => {
      const r = rnd();
      return r < 0.35 ? RO : r < 0.5 ? 0 : 11 + 10 * Math.floor(rnd() * 3);
    }).map((code) => (code > 11 ? code + Math.floor(code / 10) - 2 : code));
    const reach = reachableModel(grid);
    const pruned = bds.bdsPrune(grid);
    pruned.forEach((code, i) => assert.equal(code, grid[i] === RO || reach.has(i) ? grid[i] : 0, 'grid ' + k + ' cell ' + i));
  }
  // A plain sector boxed in by four read-only ones in the middle is gone; one on the rim stays.
  const boxed = gridWith({ 34: RO, 54: RO, 43: RO, 45: RO, 44: 11, 0: 11 });
  assert.deepEqual(bds.bdsPrune(boxed), gridWith({ 34: RO, 54: RO, 43: RO, 45: RO, 0: 11 }));
});

test('bad-sector: tracks are fragmented disks: only their rows, valid cells, at least 12 reachable sectors, harder with the level and reproducible', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map(bds.bdsLevelRows), [5, 5, 6, 6, 7, 7, 8, 8, 8]);
  for (const [level, ro, bad] of [[1, 0.06, 0.17], [3, 0.1, 0.27], [5, 0.14, 0.37], [20, 0.14, 0.45]]) {
    near(bds.bdsLevelOdds(level).ro, ro, 'read-only odds of ' + level);
    near(bds.bdsLevelOdds(level).bad, bad, 'bad odds of ' + level);
  }
  const kinds = { ro: 0, bad: 0, ok: 0, power: 0, free: 0 };
  for (let seed = 1; seed <= 240; seed++) {
    const level = 1 + (seed % 9);
    const rows = bds.bdsLevelRows(level);
    const grid = bds.bdsGenerateGrid(level, rows, seeded(seed));
    assert.deepEqual(bds.bdsGenerateGrid(level, rows, seeded(seed)), grid, 'the same draw from the same seed');
    assert.equal(grid.length, CELLS);
    assert.ok(countSectors(grid) >= 12, 'seed ' + seed);
    const reach = reachableModel(grid);
    grid.forEach((code, i) => {
      assert.ok(bds.bdsValidCell(code), 'seed ' + seed + ' cell ' + i);
      if (Math.floor(i / COLS) >= rows) assert.equal(code, 0, 'seed ' + seed + ': nothing below row ' + rows);
      if (isSector(code)) assert.ok(reach.has(i), 'seed ' + seed + ': cell ' + i + ' can be reached');
      if (code === RO) kinds.ro++;
      else if (code === 0) kinds.free++;
      else if (Math.floor(code / 10) % 10 > 1) kinds.bad++;
      else kinds.ok++;
      if (code > 100 && code !== RO) kinds.power++;
    });
    // Bad sectors start with all their hits.
    for (const code of grid.filter(isSector)) assert.equal(code % 10, Math.floor(code / 10) % 10);
  }
  for (const [kind, count] of Object.entries(kinds)) assert.ok(count > 100, kind + ': ' + count);
  // A random source stuck at 0 only draws free cells: after 20 poor draws every cell of the rows is a plain sector.
  let calls = 0;
  const stuck = bds.bdsGenerateGrid(1, 5, () => { calls++; return 0; });
  assert.deepEqual(stuck, new Array(CELLS).fill(0).map((_, i) => (i < 50 ? 11 : 0)));
  assert.equal(calls, 20 * 50, 'twenty draws of 50 free cells, then no more');
});

// ── Physics ──────────────────────────────────────────────────────────────────

test('bad-sector: bdsStep is pure: the state it gets stays as it was, and a cleared or failed track does not move', () => {
  const sim = playing(SAMPLE_GRID, [{ x: 100, y: 300, vx: 120, vy: -200 }], { drops: [{ x: 50, y: 200, p: 2 }], flashes: [{ x: 1, y: 2, lba: 'LBA 0x0', t: 0.5 }], ecc: 3 });
  const before = JSON.stringify(sim);
  const next = bds.bdsStep(sim, input({ move: 1 }), STEP);
  assert.equal(JSON.stringify(sim), before);
  assert.notEqual(next.balls[0], sim.balls[0]);
  assert.ok(next.balls[0].y < 300);
  for (const phase of ['cleared', 'over']) {
    const done = Object.assign(bds.bdsNewSim(2, SAMPLE_GRID, 50, 1), { phase });
    const after = bds.bdsStep(done, input({ move: 1, launch: true }), STEP);
    assert.deepEqual(after, done, phase);
    assert.notEqual(after, done);
    // Only the last LBA flashes go on fading, and then they are gone.
    const flashing = Object.assign({}, done, { flashes: [{ x: 1, y: 2, lba: 'LBA 0x0', t: 0.5 }] });
    const fading = bds.bdsStep(flashing, input({ move: 1, launch: true }), 0.25);
    assert.deepEqual(fading, Object.assign({}, done, { flashes: [{ x: 1, y: 2, lba: 'LBA 0x0', t: 0.25 }] }), phase);
    assert.equal(flashing.flashes[0].t, 0.5, 'the flash it got is left as it was');
    assert.deepEqual(bds.bdsStep(fading, input(), 0.25).flashes, []);
  }
  assert.deepEqual(bds.bdsNewSim(3, SAMPLE_GRID, 7, 2), {
    level: 3, score: 7, lives: 2, total: 14, grid: SAMPLE_GRID, phase: 'serve', paddleX: 180, balls: [], speed: 260,
    drops: [], ecc: 0, slow: 0, flashes: [], events: []
  });
  assert.deepEqual([1, 2, 10, 15, 16, 100].map(bds.bdsLevelSpeed), [230, 245, 365, 440, 455, 460]);
});

test('bad-sector: the carriage follows the keys at 420 units a second or the pointer at once, inside the walls, and carries the waiting head', () => {
  let sim = bds.bdsNewSim(1, SAMPLE_GRID, 0, 3);
  sim = bds.bdsStep(sim, input({ move: 1 }), 0.1);
  near(sim.paddleX, 180 + 42, 'right');
  sim = bds.bdsStep(sim, input({ move: -1 }), 0.05);
  near(sim.paddleX, 222 - 21, 'left');
  sim = bds.bdsStep(sim, input({ target: 5, move: 1 }), STEP);
  assert.equal(sim.paddleX, 32, 'the pointer wins over the keys, stopped by the wall');
  sim = bds.bdsStep(sim, input({ target: 1000 }), STEP);
  assert.equal(sim.paddleX, 328);
  sim = bds.bdsStep(Object.assign(sim, { ecc: 2 }), input({ target: 1000 }), STEP);
  assert.equal(sim.paddleX, 312, 'a wide carriage stops sooner');
  assert.equal(bds.bdsPaddleWidth(sim), 96);
  assert.equal(sim.ecc, 2, 'bonuses wait while the head waits');
  assert.equal(sim.phase, 'serve');
  assert.deepEqual(sim.balls, []);
  // The launch: 20 degrees off the vertical toward the wider side, at the track's speed.
  for (const [x, dir] of [[100, 1], [180, -1], [300, -1]]) {
    const launched = bds.bdsStep(Object.assign(bds.bdsNewSim(2, SAMPLE_GRID, 0, 3), { paddleX: x }), input({ launch: true }), STEP);
    assert.equal(launched.phase, 'play');
    assert.deepEqual(launched.events, [{ type: 'launch' }]);
    const ball = launched.balls[0];
    assert.equal(ball.x, x);
    assert.equal(ball.y, PADDLE_Y - R - 1);
    near(speedOf(ball), 245, 'speed');
    near(Math.atan2(ball.vx, -ball.vy), dir * Math.PI / 9, 'angle');
  }
});

test('bad-sector: heads bounce off the walls and the top, and leave the bottom', () => {
  const wall = (ball) => bds.bdsStep(playing(SAMPLE_GRID, [ball]), input(), STEP).balls[0];
  // Each moves 2.6 units in two sub-steps: the first meets the wall, the second moves away from it.
  let ball = wall({ x: 6, y: 300, vx: -300, vy: -100 });
  near(ball.x, R + 300 / 240, 'left wall');
  assert.ok(ball.vx > 0);
  ball = wall({ x: 354, y: 300, vx: 300, vy: 100 });
  near(ball.x, W - R - 300 / 240, 'right wall');
  assert.ok(ball.vx < 0);
  ball = wall({ x: 200, y: 6, vx: 30, vy: -300 });
  near(ball.y, R + 300 / 240, 'top');
  assert.ok(ball.vy > 0);
  near(speedOf(ball), Math.hypot(30, 300), 'walls keep the speed', 1e-6);
  // A head below the field is lost; another one still in play keeps the drive going.
  const two = bds.bdsStep(playing(SAMPLE_GRID, [{ x: 20, y: 484, vx: 0, vy: 300 }, { x: 200, y: 300, vx: 0, vy: -200 }]), input(), STEP);
  assert.equal(two.balls.length, 1);
  assert.equal(two.lives, 3);
  assert.equal(two.phase, 'play');
});

test('bad-sector: the carriage sends a head back up at an angle set by where it lands, up to 60 degrees at the ends', () => {
  // Past the ends (rel beyond 1) the head meets the carriage's corner: still 60 degrees.
  for (let rel = -1.0625; rel <= 1.0625; rel += 0.0625) {
    const x = 180 + rel * 32;
    const sim = playing(SAMPLE_GRID, [{ x, y: PADDLE_Y - R + 2, vx: 0, vy: 300 }], { paddleX: 180 });
    const next = bds.bdsStep(sim, input({ target: 180 }), 0.001);
    const ball = next.balls[0];
    const expected = Math.max(-1, Math.min(1, rel)) * Math.PI / 3;
    near(Math.atan2(ball.vx, -ball.vy), expected, 'rel ' + rel, 1e-9);
    near(speedOf(ball), 300, 'speed', 1e-9);
    assert.ok(ball.y <= PADDLE_Y - R, 'above the carriage');
    assert.deepEqual(next.events.map((e) => e.type), ['paddle']);
  }
  // Moving up, or beside it, the head passes.
  const up = bds.bdsStep(playing(SAMPLE_GRID, [{ x: 180, y: PADDLE_Y + 2, vx: 0, vy: -300 }]), input({ target: 180 }), 0.001);
  assert.ok(up.balls[0].vy < 0);
  const beside = bds.bdsStep(playing(SAMPLE_GRID, [{ x: 260, y: PADDLE_Y + 2, vx: 0, vy: 300 }]), input({ target: 180 }), 0.001);
  assert.ok(beside.balls[0].vy > 0);
  assert.deepEqual(beside.events, []);
});

test('bad-sector: a head bounces off a sector along the axis it overlaps least (y on a tie)', () => {
  const rect = { x: 100, y: 100, w: 31, h: 14 };
  const cases = [
    [{ x: 98, y: 107, vx: 50, vy: 10 }, { x: 98 - 3, vx: -50, vy: 10 }],
    [{ x: 133, y: 107, vx: -50, vy: 10 }, { x: 133 + 3, vx: 50, vy: 10 }],
    [{ x: 115, y: 97, vx: 10, vy: 50 }, { y: 97 - 2, vx: 10, vy: -50 }],
    [{ x: 115, y: 117, vx: 10, vy: -50 }, { y: 117 + 2, vx: 10, vy: 50 }],
    [{ x: 97, y: 97, vx: 10, vy: 10 }, { y: 95, vx: 10, vy: -10 }]
  ];
  for (const [ball, want] of cases) {
    const out = Object.assign({}, ball);
    bds.bdsReflect(out, rect);
    for (const [key, value] of Object.entries(want)) near(out[key], value, JSON.stringify(ball) + ' ' + key);
  }
});

// The first cell a head moving in a straight line touches, in steps of
// 0.01 units, ignoring walls and the carriage (-1 when it touches none), and
// the first it overlaps by at least 0.2 units.  Sub-steps of 2.5 units may
// miss a graze shallower than that (a chord of 2.5 units of a circle of
// radius 5 is 0.16 deep), but never a real hit.
function firstTouch(grid, ball, distance) {
  const speed = speedOf(ball);
  const out = { any: -1, deep: -1 };
  const deepR = R - 0.2;
  for (let d = 0; d <= distance && out.deep === -1; d += 0.01) {
    const x = ball.x + (ball.vx / speed) * d;
    const y = ball.y + (ball.vy / speed) * d;
    for (let i = 0; i < CELLS; i++) {
      if (!grid[i]) continue;
      const rect = rectOf(i);
      if (out.any === -1 && overlaps(x, y, rect)) out.any = i;
      const dx = x - Math.min(Math.max(x, rect.x), rect.x + rect.w);
      const dy = y - Math.min(Math.max(y, rect.y), rect.y + rect.h);
      if (dx * dx + dy * dy < deepR * deepR) out.deep = i;
    }
  }
  return out;
}

test('bad-sector: a head at the speed cap never passes through a sector, even in a step 14 times as long as the page\'s (checked against a fine-stepped model)', () => {
  // Every second sector of track 7: a head overlaps one sector at a time.
  const grid = gridWith({ 70: 11, 72: 11, 74: 11, 76: 11, 78: 11 });
  const dt = 0.12;
  let tunnelling = 0;
  let hits = 0;
  for (let x = 60; x <= 300; x += 3.7) {
    for (let deg = -40; deg <= 40; deg += 8) {
      const a = (deg * Math.PI) / 180;
      const ball = { x, y: 230, vx: MAX_SPEED * Math.sin(a), vy: -MAX_SPEED * Math.cos(a) };
      const touch = firstTouch(grid, ball, MAX_SPEED * dt);
      const expected = touch.deep;
      const next = bds.bdsStep(playing(grid, [Object.assign({}, ball)]), input(), dt);
      const broken = next.events.filter((e) => e.type === 'break').map((e) => e.index);
      if (expected !== -1) assert.deepEqual(broken, [expected], 'x ' + x + ' at ' + deg + ' degrees');
      else assert.ok(broken.length === 0 || (broken.length === 1 && broken[0] === touch.any), 'x ' + x + ' at ' + deg + ': at most a graze');
      for (let i = 0; i < CELLS; i++) {
        if (grid[i]) assert.ok(!overlaps(next.balls[0].x, next.balls[0].y, rectOf(i)) || next.grid[i] === 0, 'never left inside a sector');
      }
      if (expected !== -1) {
        hits++;
        // One plain step of the same length would have jumped over the sector.
        const jumped = { x: ball.x + ball.vx * dt, y: ball.y + ball.vy * dt };
        if (!grid.some((code, i) => code && overlaps(jumped.x, jumped.y, rectOf(i)))) tunnelling++;
      }
    }
  }
  assert.ok(hits > 100, hits + ' hits');
  assert.ok(tunnelling > 25, 'the step is long enough to tunnel without sub-steps (' + tunnelling + ')');
  // A head far over the cap is slowed to it first.
  const fast = bds.bdsStep(playing(gridWith({ [FAR_CELL]: 11 }), [{ x: 180, y: 300, vx: 30000, vy: -40000 }]), input(), STEP);
  near(speedOf(fast.balls[0]), MAX_SPEED, 'cap', 1e-6);
  near(fast.balls[0].y, 300 - MAX_SPEED * 0.8 * STEP, 'moved at the cap', 1e-6);
  // A huge dt is cut into at most 256 sub-steps.
  // A huge dt is cut into at most 256 sub-steps: 1000 units in steps of about 3.9, between the side walls.
  const long = bds.bdsStep(playing(gridWith({ [FAR_CELL]: 11 }), [{ x: 180, y: 300, vx: 100, vy: -0.001 }]), input(), 10);
  assert.equal(long.balls.length, 1);
  assert.ok(long.balls[0].x >= R && long.balls[0].x <= W - R);
});

test('bad-sector: hits wear sectors down: points, LBA flashes, bonus drops, read-only sectors and a little speed per hit', () => {
  const hitFrom = (code, extra) => bds.bdsStep(playing(gridWith({ 45: code, 0: 11 }),[{ x: 15 + 5 * 33 + 16.5, y: 64 + 4 * 16 + 15 + R + 1, vx: 0, vy: -240 }], extra), input(), STEP);
  // A bad sector of 3 loses one hit: 5 points.
  let s = hitFrom(33);
  assert.equal(s.grid[45], 32);
  assert.equal(s.score, 5);
  assert.deepEqual(s.events, [{ type: 'hit', index: 45 }]);
  assert.equal(s.speed, 232);
  near(speedOf(s.balls[0]), 232, 'the head speeds up');
  assert.ok(s.balls[0].vy > 0, 'and bounces down');
  // A plain sector breaks: 10 points, its LBA flashes.
  s = hitFrom(11);
  assert.equal(s.grid[45], 0);
  assert.equal(s.score, 10);
  assert.deepEqual(s.events, [{ type: 'break', index: 45, power: '' }]);
  assert.deepEqual(s.flashes, [{ x: rectOf(45).x + 15.5, y: rectOf(45).y + 7, lba: 'LBA 0x011140', t: 0.9 }]);
  assert.deepEqual(s.drops, []);
  // The last hit of a bad sector with a bonus: 10 points a hit it took, and the bonus drops.
  s = hitFrom(321);
  assert.equal(s.score, 20);
  assert.deepEqual(s.drops, [{ x: rectOf(45).x + 15.5, y: rectOf(45).y + 7, p: 3 }]);
  assert.equal(s.events[0].power, 'slow');
  // A read-only sector only bounces the head.
  s = hitFrom(RO);
  assert.equal(s.grid[45], RO);
  assert.equal(s.score, 0);
  assert.equal(s.speed, 230);
  assert.deepEqual(s.events, [{ type: 'ro', index: 45 }]);
  assert.ok(s.balls[0].vy > 0);
  // The speed never passes the cap.
  s = hitFrom(11, { speed: 459 });
  assert.equal(s.speed, MAX_SPEED);
  // Of two sectors the head touches, the nearer one is hit.
  const two = bds.bdsStep(playing(gridWith({ 44: 11, 45: 11 }), [{ x: 15 + 5 * 33 + 6, y: 64 + 4 * 16 + 15 + R + 1, vx: 0, vy: -240 }]), input(), STEP);
  assert.deepEqual(two.events.map((e) => e.index), [45]);
  // Flashes fade out in 0.9 s.
  let flash = playing(gridWith({ 9: 11 }), [{ x: 180, y: 300, vx: 0, vy: -100 }], { flashes: [{ x: 1, y: 1, lba: 'x', t: 0.9 }] });
  for (let i = 0; i < 107; i++) flash = bds.bdsStep(flash, input(), STEP);
  assert.equal(flash.flashes.length, 1);
  flash = bds.bdsStep(bds.bdsStep(flash, input(), STEP), input(), STEP);
  assert.deepEqual(flash.flashes, []);
});

test('bad-sector: bonuses fall to the carriage: RAID1 mirrors the head (or pays 50 with two), ECC widens the carriage for 12 s, SLOW-SEEK slows the heads to 60 % for 10 s', () => {
  const catching = (p, balls, extra) => bds.bdsStep(playing(gridWith({ 9: 11 }), balls, Object.assign({ drops: [{ x: 180, y: PADDLE_Y - 5, p }] }, extra)), input({ target: 180 }), STEP);
  const head = { x: 100, y: 200, vx: 120, vy: -200 };
  let s = catching(1, [Object.assign({}, head)]);
  assert.equal(s.score, 25);
  assert.deepEqual(s.drops, []);
  assert.equal(s.balls.length, 2);
  const [a, b] = s.balls;
  near(b.x, W - a.x, 'mirrored x', 1e-6);
  near(b.y, a.y, 'same y', 1e-6);
  near(b.vx, -a.vx, 'mirrored vx');
  near(b.vy, a.vy, 'same vy');
  assert.deepEqual(s.events, [{ type: 'power', power: 'raid' }]);
  s = catching(1, [Object.assign({}, head), Object.assign({}, head, { x: 260 })]);
  assert.equal(s.balls.length, 2);
  assert.equal(s.score, 75, 'two heads already: 25 + 50 points');
  // The mirrored spot has to be open space the heads reach; otherwise the mirror starts from the head's own spot.
  const cx = (i) => rectOf(i).x + 15.5;
  const cy = (i) => rectOf(i).y + 7;
  const raidAt = (x, y, cells) => {
    const ball = { x, y, vx: 120, vy: -200 };
    const grid = gridWith(Object.assign({ 9: 11 }, cells));
    const next = bds.bdsStep(playing(grid, [ball], { drops: [{ x: 180, y: PADDLE_Y - 5, p: 1 }] }), input({ target: 180 }), STEP);
    assert.equal(next.balls.length, 2);
    const [one, two] = next.balls;
    near(two.vx, -one.vx, 'mirrored vx');
    near(two.y, one.y, 'same y', 1e-6);
    return one.x + two.x;
  };
  const raidIn = (cells, i) => raidAt(cx(i), cy(i), cells);
  // Beside the grid, above it and below it the mirrored spot is open space.
  for (const [x, y] of [[10, 300], [350, 300], [100, 40], [100, 200]]) near(raidAt(x, y, {}), W, x + ',' + y, 1e-6);
  near(raidIn({}, 5), W, 'a cell on the rim', 1e-6);
  // Cell 37's mirror is cell 32: free and reached from the rim, so the mirror goes there.
  near(raidIn({}, 37), W, 'mirrored across the field', 1e-6);
  near(raidIn({ 31: 11, 33: 11 }, 37), W, 'next to sectors, but touching none', 1e-6);
  // A sector at the mirrored spot: the mirror would start inside it.
  near(raidIn({ 32: 11 }, 37), 2 * cx(37), 'from the head\'s own spot', 1e-6);
  near(raidIn({ 32: RO }, 37), 2 * cx(37), 'nor inside a read-only one', 1e-6);
  // A free cell walled in by four read-only sectors: a mirror there could never get out.
  const pocket = { 22: RO, 31: RO, 33: RO, 42: RO };
  assert.equal(bds.bdsReachable(gridWith(pocket))[32], false);
  near(raidIn(pocket, 37), 2 * cx(37), 'never into a pocket', 1e-6);
  // Without the pocket's last wall the cell is reached again.
  near(raidIn({ 22: RO, 31: RO, 33: RO }, 37), W, 'an open pocket is fine', 1e-6);
  // With the pocket on the track, 30 s of play never puts a head into it (it would bounce there for ever).
  let raid = playing(gridWith(Object.assign({ 9: 11 }, pocket)), [{ x: cx(37), y: cy(37), vx: 120, vy: -200 }], { drops: [{ x: 180, y: PADDLE_Y - 5, p: 1 }] });
  const slot = { x: rectOf(32).x - 1, y: rectOf(32).y - 1 };
  for (let i = 0; i < 30 * 120 && raid.phase === 'play'; i++) {
    raid = bds.bdsStep(raid, input({ target: raid.balls.length ? raid.balls[raid.balls.length - 1].x : 180 }), STEP);
    for (const ball of raid.balls) {
      assert.ok(!(ball.x > slot.x && ball.x < slot.x + CELL_W && ball.y > slot.y && ball.y < slot.y + CELL_H), 'step ' + i + ': a head in the pocket');
    }
  }
  s = catching(2, [Object.assign({}, head)]);
  assert.equal(s.ecc, 12);
  assert.equal(bds.bdsPaddleWidth(s), 96);
  s = catching(3, [Object.assign({}, head)]);
  assert.equal(s.slow, 10);
  const slowStep = bds.bdsStep(s, input(), STEP);
  near(slowStep.balls[0].y - s.balls[0].y, -200 * 0.6 * STEP, 'slowed', 1e-9);
  // Bonuses wear off in play.
  let wide = playing(gridWith({ 9: 11 }), [{ x: 180, y: 200, vx: 0, vy: -1 }], { ecc: 0.02, slow: 0.02 });
  wide = bds.bdsStep(bds.bdsStep(bds.bdsStep(wide, input(), STEP), input(), STEP), input(), STEP);
  assert.deepEqual([wide.ecc, wide.slow, bds.bdsPaddleWidth(wide)], [0, 0, 64]);
  // A bonus beside the carriage falls on at 110 units a second, and is gone below the field.
  let missed = playing(gridWith({ 9: 11 }), [{ x: 180, y: 200, vx: 0, vy: -1 }], { drops: [{ x: 20, y: 400, p: 2 }] });
  missed = bds.bdsStep(missed, input({ target: 300 }), 0.1);
  assert.deepEqual(missed.drops, [{ x: 20, y: 411, p: 2 }]);
  for (let i = 0; i < 6; i++) missed = bds.bdsStep(missed, input({ target: 300 }), 0.1);
  assert.equal(missed.drops.length, 1, 'still falling at y ' + missed.drops[0].y);
  missed = bds.bdsStep(missed, input({ target: 300 }), 0.1);
  assert.deepEqual(missed.drops, []);
  assert.equal(missed.ecc, 0);
});

test('bad-sector: a lost head reallocates a sector, the third fails the drive, and the last sector clears the track with 100 points a track', () => {
  const falling = (lives) => playing(gridWith({ 9: 11 }), [{ x: 20, y: 484, vx: 0, vy: 300 }], { lives, ecc: 5, slow: 5, speed: 400, drops: [{ x: 50, y: 300, p: 1 }] });
  let s = bds.bdsStep(falling(3), input({ target: 300 }), STEP);
  assert.deepEqual([s.lives, s.phase, s.ecc, s.slow, s.speed, s.drops, s.balls], [2, 'serve', 0, 0, 230, [], []]);
  assert.deepEqual(s.events, [{ type: 'lost', lives: 2 }]);
  s = bds.bdsStep(falling(1), input({ target: 300 }), STEP);
  assert.deepEqual([s.lives, s.phase], [0, 'over']);
  assert.deepEqual(s.events, [{ type: 'lost', lives: 0 }, { type: 'over' }]);
  // The last sector: cleared, the heads and bonuses gone.
  const last = playing(gridWith({ 45: 11, 0: RO }), [{ x: 15 + 5 * 33 + 16.5, y: 64 + 4 * 16 + 15 + R + 1, vx: 0, vy: -240 }], { level: 3, drops: [{ x: 50, y: 300, p: 1 }] });
  s = bds.bdsStep(last, input(), STEP);
  assert.deepEqual([s.phase, s.score, s.balls, s.drops], ['cleared', 10 + 300, [], []]);
  assert.deepEqual(s.events.map((e) => e.type), ['break', 'clear']);
  assert.equal(s.events[1].bonus, 300);
  // The last broken sector's LBA flash fades out over the cleared track.
  assert.equal(s.flashes.length, 1);
});

// ── Daily ────────────────────────────────────────────────────────────────────

test('bad-sector: FNV-1a and mulberry32 match their reference values, and the Daily disk of 2026-11-06 is pinned', () => {
  for (const text of ['', 'a', 'bds:2026-11-06', 'bds:2027-02-28', 'ÿ€']) assert.equal(bds.bdsHash(text), fnv1a(text), text);
  assert.equal(bds.bdsHash(''), 0x811c9dc5);
  assert.equal(bds.bdsHash('a'), 0xe40c292c);
  const mine = bds.bdsMulberry32(42);
  const ref = seeded(42);
  for (let i = 0; i < 50; i++) assert.equal(mine(), ref());
  assert.deepEqual(bds.bdsDailyGrid(KEY6), DAILY6_GRID);
  assert.deepEqual(bds.bdsDailyGrid(KEY6), bds.bdsGenerateGrid(4, 7, seeded(fnv1a('bds:' + KEY6))));
  assert.equal(countSectors(DAILY6_GRID), 50);
  assert.notDeepEqual(bds.bdsDailyGrid(KEY7), DAILY6_GRID);
});

test('bad-sector: the day key is the local date and #1 is 2026-11-01, counted without a jump at daylight saving changes', () => {
  assert.deepEqual(bds.bdsDayInfo(new Date(2026, 10, 1, 0, 0, 1)), { key: '2026-11-01', day: 1 });
  assert.deepEqual(bds.bdsDayInfo(new Date(2026, 10, 6, 23, 59)), { key: KEY6, day: 6 });
  assert.deepEqual(bds.bdsDayInfo(new Date(2027, 0, 9, 8)), { key: '2027-01-09', day: 70 });
  let previous = null;
  for (let d = 0; d < 400; d++) {
    const info = bds.bdsDayInfo(new Date(2026, 10, 1 + d, 12));
    if (previous) assert.equal(info.day, previous + 1, info.key);
    previous = info.day;
    assert.equal(bds.bdsKeyDay(info.key), info.day);
  }
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-01', 'x', '', null, 20261106]) assert.equal(bds.bdsKeyDay(bad), null, String(bad));
});

test('bad-sector: the streak lasts while the last clear is today or yesterday, and the share line names the result', () => {
  assert.equal(bds.bdsLiveStreak({ streak: 4, lastWon: 6 }, 6), 4);
  assert.equal(bds.bdsLiveStreak({ streak: 4, lastWon: 5 }, 6), 4);
  assert.equal(bds.bdsLiveStreak({ streak: 4, lastWon: 4 }, 6), 0);
  assert.equal(bds.bdsLiveStreak({ streak: 4, lastWon: null }, 6), 0);
  const won = Object.assign(bds.bdsNewSim(4, gridWith({}), 1280, 2), { total: 50 });
  assert.equal(bds.bdsShareText({ day: 6, status: 'won', sim: won }), 'Bad Sector Daily #6: surface scan complete, 1280 points, SMART realloc 1/3');
  const lost = Object.assign(bds.bdsNewSim(4, gridWith({ 1: 11, 2: 22, 3: RO }), 820, 0), { total: 50 });
  assert.equal(bds.bdsScanned(lost), 96);
  assert.equal(bds.bdsShareText({ day: 9, status: 'lost', sim: lost }), 'Bad Sector Daily #9: drive failure at 96% scanned, 820 points');
  assert.equal(bds.bdsScanned(Object.assign(bds.bdsNewSim(4, gridWith({ 1: 11 }), 0, 0), { total: 3 })), 66, 'rounded down');
});

test('bad-sector: of two tabs\' Daily records the later Daily up to today, the finished one or the attempt further along wins', () => {
  const rec = (key, day, status, score, lives) => ({ key, day, status, sim: key === null ? null : { score, lives } });
  const none = rec(null, 0, 'playing');
  assert.equal(bds.bdsIsNewerDaily(none, rec(KEY6, 6, 'playing', 0, 3), 6), false);
  assert.equal(bds.bdsIsNewerDaily(rec('2026-11-09', 9, 'playing', 0, 3), rec(KEY6, 6, 'playing', 0, 3), 6), false, 'from after today');
  assert.equal(bds.bdsIsNewerDaily(rec(KEY6, 6, 'playing', 0, 3), none, 6), true);
  assert.equal(bds.bdsIsNewerDaily(rec(KEY6, 6, 'playing', 0, 3), rec(KEY5, 5, 'won', 900, 3), 6), true);
  assert.equal(bds.bdsIsNewerDaily(rec(KEY5, 5, 'won', 900, 3), rec(KEY6, 6, 'playing', 0, 3), 6), false);
  assert.equal(bds.bdsIsNewerDaily(rec(KEY6, 6, 'lost', 10, 0), rec(KEY6, 6, 'playing', 500, 3), 6), true);
  assert.equal(bds.bdsIsNewerDaily(rec(KEY6, 6, 'playing', 900, 3), rec(KEY6, 6, 'won', 500, 3), 6), false);
  assert.equal(bds.bdsIsNewerDaily(rec(KEY6, 6, 'won', 900, 3), rec(KEY6, 6, 'lost', 500, 0), 6), false, 'two results: ours stands');
  assert.equal(bds.bdsIsNewerDaily(rec(KEY6, 6, 'playing', 300, 3), rec(KEY6, 6, 'playing', 200, 3), 6), true);
  assert.equal(bds.bdsIsNewerDaily(rec(KEY6, 6, 'playing', 100, 3), rec(KEY6, 6, 'playing', 200, 3), 6), false);
  assert.equal(bds.bdsIsNewerDaily(rec(KEY6, 6, 'playing', 200, 2), rec(KEY6, 6, 'playing', 200, 3), 6), true);
  assert.equal(bds.bdsIsNewerDaily(rec(KEY6, 6, 'playing', 200, 3), rec(KEY6, 6, 'playing', 200, 3), 6), false);
});

test('bad-sector: keys map to actions by their value, then by the physical key on other layouts', () => {
  const action = (key, code) => bds.bdsKeyAction(keyEvent(key, code ? { code } : {}));
  assert.deepEqual(['ArrowLeft', 'a', 'A', 'ArrowRight', 'd', 'D', ' ', 'p', 'P'].map((k) => action(k)),
    ['left', 'left', 'left', 'right', 'right', 'right', 'action', 'pause', 'pause']);
  assert.equal(action('ф', 'KeyA'), 'left');
  assert.equal(action('в', 'KeyD'), 'right');
  assert.equal(action('з', 'KeyP'), 'pause');
  assert.equal(action('Spacebar', 'Space'), 'action');
  assert.equal(action('ArrowUp'), null);
  assert.equal(action('Enter'), null);
  assert.equal(bds.bdsKeyAction(keyEvent(undefined)), null, 'an autofill keydown without a key');
});

// ── Saves (pure) ─────────────────────────────────────────────────────────────

test('bad-sector: bdsParseState reads a save of the current format field for field', () => {
  const parsed = bds.bdsParseState(SAMPLE_SAVE);
  assert.deepEqual(Object.assign({}, parsed, { sim: null }), { view: 'free', practice: null, level: 2, score: 340, lives: 2, sim: null });
  assert.deepEqual(parsed.sim, Object.assign(bds.bdsNewSim(2, SAMPLE_GRID, 340, 2), { total: 38, ecc: 4.5, speed: 251, paddleX: 150 }));
  const daily = bds.bdsParseState(JSON.stringify(Object.assign(JSON.parse(SAMPLE_SAVE), { view: 'daily', practice: 6, phase: 'cleared', slow: 2.25 })));
  assert.deepEqual([daily.view, daily.practice, daily.sim.phase, daily.sim.slow], ['daily', 6, 'cleared', 2.25]);
  // Heads in flight, their speed, the carriage and the falling bonuses come back as they were.
  assert.deepEqual(bds.bdsParseState(SAMPLE_FLIGHT).sim, Object.assign(bds.bdsNewSim(2, SAMPLE_GRID, 340, 2), {
    total: 38, ecc: 4.5, slow: 1.25, speed: 251, paddleX: 150, phase: 'play',
    balls: [{ x: 100.5, y: 300.25, vx: 120, vy: -220.5 }, { x: 259.5, y: 300.25, vx: -120, vy: -220.5 }],
    drops: [{ x: 200, y: 250.5, p: 2 }]
  }));
});

test('bad-sector: bdsParseState falls back field by field, and a save with nothing left to play asks for a fresh track', () => {
  const base = JSON.parse(SAMPLE_SAVE);
  const with_ = (extra) => bds.bdsParseState(JSON.stringify(Object.assign({}, base, extra)));
  assert.equal(with_({ level: 0 }).level, 1);
  assert.equal(with_({ level: 1.5 }).level, 1);
  assert.equal(with_({ level: 1000 }).level, 1);
  assert.equal(with_({ level: 999 }).sim.level, 999);
  assert.equal(with_({ score: -1 }).sim.score, 0);
  assert.equal(with_({ score: '340' }).score, 0);
  assert.equal(with_({ lives: 4 }).sim.lives, 3);
  assert.equal(with_({ lives: 'x' }).lives, 3);
  assert.equal(with_({ total: 13 }).sim.total, 14, 'never below the sectors left');
  assert.equal(with_({ total: 'x' }).sim.total, 14);
  assert.equal(with_({ ecc: 13 }).sim.ecc, 0);
  assert.equal(with_({ ecc: -1 }).sim.ecc, 0);
  assert.equal(with_({ slow: 11 }).sim.slow, 0);
  assert.equal(with_({ slow: '2' }).sim.slow, 0);
  assert.equal(with_({ practice: 0 }).practice, null);
  assert.equal(with_({ practice: 'x' }).practice, null);
  assert.equal(with_({ view: 'other' }).view, 'free');
  assert.equal(with_({ phase: 'play' }).sim.phase, 'serve', 'in flight with no head: the head waits on the carriage');
  assert.equal(with_({ phase: 'over' }).sim.phase, 'serve', 'no failed drive while lives are left');
  // The speed: from the track's own (245 on track 2) to the cap, else the track's.
  for (const [speed, want] of [[245, 245], [460, 460], [244, 245], [461, 245], ['300', 245], [NaN, 245]]) assert.equal(with_({ speed }).sim.speed, want, String(speed));
  // The carriage: inside the walls for its width (96 with ECC), else in the middle.
  for (const [paddle, want] of [[200, 200], [0, 48], [360, 312], [-1, 180], [361, 180], ['9', 180]]) assert.equal(with_({ paddle }).sim.paddleX, want, String(paddle));
  assert.equal(with_({ paddle: 0, ecc: 0 }).sim.paddleX, 32);
  // Heads and bonuses in flight, each checked on its own; at most two heads.
  const flight = JSON.parse(SAMPLE_FLIGHT);
  const fly = (extra) => bds.bdsParseState(JSON.stringify(Object.assign({}, flight, extra))).sim;
  const head = [100, 300, 120, -220];
  assert.deepEqual(fly({ balls: [head, [1, 2, 3], [400, 300, 1, 1], [100, -1, 1, 1], [100, 486, 1, 1], [100, 300, 0, 0], [100, 300, 'x', 1], [100, 300, 1, null], 'x', [9, 9, 9, 9], [8, 8, 8, 8]] }).balls,
    [{ x: 100, y: 300, vx: 120, vy: -220 }, { x: 9, y: 9, vx: 9, vy: 9 }]);
  assert.deepEqual(fly({ balls: [[100, 485, 0, 5]] }).balls, [{ x: 100, y: 485, vx: 0, vy: 5 }], 'just below the field');
  assert.deepEqual(fly({ drops: [[1, 2, 1], [1, 2, 3], [1, 2, 0], [1, 2, 4], [1, 2, 1.5], [-1, 2, 1], [1, 488, 1], [1, 2], 7] }).drops,
    [{ x: 1, y: 2, p: 1 }, { x: 1, y: 2, p: 3 }]);
  assert.deepEqual(fly({ drops: 'x' }).drops, []);
  // In flight with no valid head the head waits on the carriage, and no bonus falls.
  for (const balls of [[], 'x', [[1, 2, 3]], undefined]) {
    const waiting = fly({ balls });
    assert.deepEqual([waiting.phase, waiting.balls, waiting.drops], ['serve', [], []], JSON.stringify(balls));
  }
  // Waiting, finished or failed, a save's heads and bonuses are ignored.
  for (const [extra, phase] of [[{ phase: 'serve' }, 'serve'], [{ phase: 'cleared' }, 'cleared'], [{ lives: 0 }, 'over']]) {
    const still = fly(extra);
    assert.deepEqual([still.phase, still.balls, still.drops], [phase, [], []], phase);
  }
  // Nothing left to break: a fresh track, whatever was in flight.
  assert.equal(fly({ grid: gridWith({ 3: RO }) }), null);
  // A damaged cell is a free cell; the rest of the grid stays.
  const grid = SAMPLE_GRID.slice();
  grid[0] = 45;
  grid[1] = 'x';
  assert.deepEqual(with_({ grid }).sim.grid, SAMPLE_GRID.map((c, i) => (i < 2 ? 0 : c)));
  // No lives: a failed drive, shown as it ended (an empty grid when its grid is damaged).
  const over = with_({ lives: 0, grid: null });
  assert.deepEqual([over.sim.phase, over.sim.lives, countSectors(over.sim.grid)], ['over', 0, 0]);
  assert.equal(with_({ lives: 0 }).sim.phase, 'over');
  // A cleared track waits for the next one, whatever its grid.
  const cleared = with_({ phase: 'cleared', grid: 'x' });
  assert.deepEqual([cleared.sim.phase, cleared.sim.grid], ['cleared', new Array(CELLS).fill(0)]);
  // Nothing left to break in a track under way: no sim, the level, score and lives for a fresh one.
  for (const g of [null, [], new Array(79).fill(11), gridWith({ 3: RO }), 'x']) {
    const fresh = with_({ grid: g });
    assert.deepEqual(fresh, { view: 'free', practice: null, level: 2, score: 340, lives: 2, sim: null }, JSON.stringify(g));
  }
  for (const text of [null, '', '{', '[]', '42', 'null', '"x"', '[1,2]']) {
    assert.deepEqual(bds.bdsParseState(text), { view: 'free', practice: null, level: 1, score: 0, lives: 3, sim: null }, String(text));
  }
});

test('bad-sector: bdsParseDaily keeps the attempt, its result and the streak, each field on its own', () => {
  const daily = bds.bdsParseDaily(SAMPLE_DAILY);
  assert.deepEqual(Object.assign({}, daily, { sim: null }), { key: KEY6, day: 6, status: 'playing', sim: null, streak: 2, lastWon: 5 });
  assert.deepEqual(daily.sim, Object.assign(bds.bdsNewSim(4, SAMPLE_DAILY_GRID, 120, 3), { total: 50, speed: 281, paddleX: 120 }));
  const base = JSON.parse(SAMPLE_DAILY);
  const with_ = (extra) => bds.bdsParseDaily(JSON.stringify(Object.assign({}, base, extra)));
  // A head in flight in the attempt stays in flight; on a result it is ignored.
  const flying = with_({ balls: [[100, 300, 50, -200]], drops: [[60, 200, 3]], speed: 300 });
  assert.deepEqual([flying.sim.phase, flying.sim.balls, flying.sim.drops, flying.sim.speed], ['play', [{ x: 100, y: 300, vx: 50, vy: -200 }], [{ x: 60, y: 200, p: 3 }], 300]);
  assert.equal(with_({ balls: [[100, 300, 50, -200]], status: 'won' }).sim.phase, 'cleared');
  assert.deepEqual(with_({ balls: [[100, 300, 50, -200]], status: 'lost' }).sim.balls, []);
  assert.equal(with_({ speed: 274 }).sim.speed, 275, 'the Daily track\'s own speed at least');
  // A grid dealt again from the date starts the head on the carriage.
  assert.deepEqual([with_({ balls: [[100, 300, 50, -200]], grid: null }).sim.phase, with_({ balls: [[100, 300, 50, -200]], grid: null }).sim.balls], ['serve', []]);
  // Without a valid key there is no attempt, but the streak stays.
  for (const key of [undefined, '2026-02-30', 'today', 7]) {
    assert.deepEqual(with_({ key }), { key: null, day: 0, status: 'playing', sim: null, streak: 2, lastWon: 5 }, String(key));
  }
  assert.equal(with_({ streak: -1 }).streak, 0);
  assert.equal(with_({ lastWon: 'x' }).lastWon, null);
  assert.equal(with_({ day: 99 }).day, 6, 'the number comes from the key');
  assert.equal(with_({ status: 'x' }).status, 'playing');
  // An attempt under way with a damaged or emptied grid starts from the day's track again.
  for (const grid of [null, gridWith({ 0: RO })]) {
    const again = with_({ grid });
    assert.deepEqual(again.sim.grid, DAILY6_GRID);
    assert.equal(again.sim.score, 120, 'the score falls back on its own');
  }
  // A result shows as it ended.
  const won = with_({ status: 'won', grid: gridWith({ 0: RO }), lives: 2 });
  assert.deepEqual([won.status, won.sim.phase, won.sim.lives, won.sim.grid], ['won', 'cleared', 2, gridWith({ 0: RO })]);
  const lost = with_({ status: 'lost', grid: 'x', lives: 2 });
  assert.deepEqual([lost.sim.phase, lost.sim.lives, lost.sim.grid], ['over', 0, new Array(CELLS).fill(0)]);
  for (const text of [null, '{', '[]', '5']) assert.deepEqual(bds.bdsParseDaily(text), { key: null, day: 0, status: 'playing', sim: null, streak: 0, lastWon: null });
});

test('bad-sector: bdsParseBest keeps a score and a track, each on its own, and two tabs\' bests merge', () => {
  assert.deepEqual(bds.bdsParseBest('{"score":1280,"level":4}'), { score: 1280, level: 4 });
  assert.deepEqual(bds.bdsParseBest('{"score":-5,"level":4}'), { score: 0, level: 4 });
  assert.deepEqual(bds.bdsParseBest('{"score":12,"level":1000}'), { score: 12, level: 0 });
  assert.deepEqual(bds.bdsParseBest('{"score":12,"level":-1}'), { score: 12, level: 0 });
  for (const text of [null, '{', '[1]', '"x"']) assert.deepEqual(bds.bdsParseBest(text), { score: 0, level: 0 });
  assert.deepEqual(bds.bdsMergeBest({ score: 10, level: 5 }, { score: 30, level: 2 }), { score: 30, level: 5 });
  assert.deepEqual(bds.bdsParseGrid(SAMPLE_GRID), SAMPLE_GRID);
  assert.equal(bds.bdsParseGrid({ length: 80 }), null);
});

// ── The page ─────────────────────────────────────────────────────────────────

test('bad-sector: loading the script under Node runs no init: no lookup, listener, timer, frame or save', (t) => {
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const frameSpy = t.mock.method(globalThis, 'requestAnimationFrame');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.bdsInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(frameSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('bad-sector: a first visit shows track 1 with the head on the carriage, its stats, saves it and binds every listener once', (t) => {
  const { clock, v } = openPage(t);
  assert.deepEqual(storedKeys(), [STATE_KEY], 'no Daily attempt before the Daily is opened');
  const grid = bds.bdsGenerateGrid(1, 5, seeded(1));
  assert.equal(localStorage.getItem(STATE_KEY), JSON.stringify({ v: 1, view: 'free', level: 1, phase: 'serve', practice: null, score: 0, lives: 3, total: countSectors(grid), grid, ecc: 0, slow: 0, speed: 230, paddle: 180, balls: [], drops: [] }));
  assert.equal(v.text('score'), '0');
  assert.equal(v.text('level'), '1');
  assert.equal(v.text('sectors'), countSectors(grid) + '/' + countSectors(grid));
  assert.equal(v.text('smart'), '0/3');
  assert.equal(v.text('best'), '--');
  assert.equal(v.text('streak'), '0');
  assert.equal(v.text('mode'), 'Free scan · track 1');
  assert.equal(v.text('effects'), 'No bonus active');
  assert.equal(v.text('status'), 'Press Space or tap the platter to launch the read head.');
  assert.equal(v.text('overlay-text'), v.text('status'));
  assert.equal(v.hidden('overlay'), false);
  assert.equal(v.text('daily-button'), 'Daily #6');
  assert.equal(v.el('daily-button').getAttribute('aria-label'), 'Open Daily disk #6');
  assert.equal(v.text('new'), 'New disk');
  assert.equal(v.text('pause'), 'Pause');
  assert.equal(v.el('pause').disabled, false);
  for (const name of ['next', 'practice', 'share', 'warning']) assert.equal(v.hidden(name), true, name);
  assert.equal(clock.pending(), 1, 'the loop runs: the carriage moves while the head waits');
  // The drawing: the platter, every sector, the carriage in the middle with the head on it.
  clock.advance(32);
  assert.deepEqual(v.paddle(), { x: 180, w: 64 });
  assert.deepEqual(v.balls(), [{ x: 180, y: PADDLE_Y - R - 1 }]);
  assert.ok(v.texts().includes('PLATTER 0 · SIDE A · UNROLLED'));
  assert.ok(v.drawn().some((d) => d.kind === 'rect' && d.x === rectOf(grid.indexOf(11)).x && d.y === rectOf(grid.indexOf(11)).y));
  // Listeners: keys on the stage only, pointers on the canvas, one per button, and the window's three.
  for (const [name, type] of [['stage', 'keydown'], ['stage', 'keyup'], ['stage', 'focusout'], ['canvas', 'pointerdown'], ['canvas', 'pointermove'],
    ['canvas', 'pointerup'], ['canvas', 'pointercancel'], ['new', 'click'], ['daily-button', 'click'], ['pause', 'click'], ['next', 'click'],
    ['practice', 'click'], ['share-button', 'click']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(document), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(document.body), 0);
  assert.equal(listenerCount(window), 3);
  for (const type of ['storage', 'pagehide', 'blur']) assert.equal(listenerCount(window, type), 1, type);
});

test('bad-sector: while the page is still loading the game waits for DOMContentLoaded, and init runs once', (t) => {
  const { v } = openPage(t, { storage: { state: SAMPLE_SAVE }, options: { readyState: 'loading' } });
  assert.equal(v.text('status'), 'Spinning up the platter...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(v.canvas, 'pointerdown'), 0);
  v.ready();
  assert.equal(v.text('score'), '340');
  assert.equal(listenerCount(v.canvas, 'pointerdown'), 1);

  resetStubs();
  makeClock(t);
  const { exports: fresh, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  fresh.bdsInit();
  const saved = localStorage.getItem(STATE_KEY);
  fresh.bdsInit();
  assert.equal(localStorage.getItem(STATE_KEY), saved);
  assert.equal(listenerCount(els['bds-stage'], 'keydown'), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  assert.equal(fresh.bdsRuntime.els.canvas, els['bds-canvas']);
  assert.equal(fresh.bdsState.view, 'free');
});

test('bad-sector: keys work only while the platter has the focus: Left / Right or A / D move, Space launches once, P pauses', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ grid: gridWith({ [FAR_CELL]: 11 }) }) } });
  // Not focused: the keys stay with the page.
  let ev = pressKey('ArrowRight');
  assert.equal(ev.defaultPrevented, false);
  clock.advance(200);
  assert.equal(v.paddle().x, 180);
  // A field and a button of the host page, and the game's own buttons, keep their keys.
  const field = v.page.add('host-field', 'input');
  focusElement(field);
  assert.equal(pressKey('ArrowRight', { target: field }).defaultPrevented, false);
  assert.equal(pressKey(' ', { target: field }).defaultPrevented, false);
  focusElement(v.el('daily-button'), { keyboard: true });
  assert.equal(pressKey('ArrowLeft').defaultPrevented, false);
  clock.advance(100);
  assert.equal(v.paddle().x, 180);
  // Focused: a held arrow moves the carriage at 420 units a second until its keyup.
  ev = v.press('ArrowRight');
  assert.equal(ev.defaultPrevented, true);
  clock.advance(100);
  const moved = v.paddle().x;
  assert.ok(moved > 205 && moved < 230, String(moved));
  v.press('ArrowRight', { repeat: true });
  clock.advance(100);
  assert.ok(v.paddle().x > moved + 30);
  v.release('ArrowRight');
  const stopped = v.paddle().x;
  clock.advance(100);
  assert.equal(v.paddle().x, stopped);
  v.press('a');
  clock.advance(50);
  assert.ok(v.paddle().x < stopped);
  v.release('A');
  v.release('ArrowUp');
  // Ctrl / Alt / Cmd combinations, composing, handled and autofill keys are left alone.
  for (const props of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    ev = v.press('d', props);
    assert.equal(ev.defaultPrevented, false, JSON.stringify(props));
  }
  const handled = keyEvent(' ', { target: v.canvas });
  handled.preventDefault();
  v.canvas.dispatchEvent(handled);
  assert.equal(v.press(undefined).defaultPrevented, false);
  assert.equal(v.press('Enter').defaultPrevented, false);
  const here = v.paddle().x;
  clock.advance(100);
  assert.equal(v.paddle().x, here, 'none of them moved the carriage');
  assert.equal(v.balls()[0].y, PADDLE_Y - R - 1, 'nor launched');
  // Space launches, once for a held key.
  v.press(' ');
  clock.advance(32);
  const flying = v.balls()[0];
  assert.ok(flying.y < PADDLE_Y - R - 1);
  assert.equal(v.hidden('overlay'), true);
  assert.equal(v.text('status'), 'Scanning track 1.');
  v.press(' ', { repeat: true });
  // P pauses (a held P does nothing more), P again resumes.
  v.press('p');
  assert.equal(v.text('pause'), 'Resume');
  assert.equal(v.el('pause').getAttribute('aria-pressed'), 'true');
  assert.equal(v.text('status'), 'Paused. Press P or Space, or tap the platter, to resume.');
  v.press('P', { repeat: true });
  assert.equal(v.text('pause'), 'Resume');
  const frozen = v.balls()[0];
  clock.advance(500);
  assert.deepEqual(v.balls()[0], frozen);
  v.press('p');
  assert.equal(v.text('pause'), 'Pause');
  // A held key is let go when the platter or the window loses the focus.
  v.press('ArrowLeft');
  fire(v.canvas, 'focusout');
  const left = v.paddle().x;
  clock.advance(100);
  assert.equal(v.paddle().x, left);
  v.press('ArrowLeft');
  fire(window, 'blur');
  clock.advance(100);
  assert.equal(v.paddle().x, left);
});

test('bad-sector: the carriage follows the mouse; a finger drags it by its own movement from anywhere; a tap launches, a drag does not', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ grid: gridWith({ [FAR_CELL]: 11 }) }) } });
  v.mouseTo(100);
  clock.advance(32);
  assert.equal(v.paddle().x, 100);
  v.mouseTo(1000);
  clock.advance(32);
  assert.equal(v.paddle().x, 328, 'stopped by the wall');
  // The keys take over from the mouse.
  v.press('ArrowLeft');
  clock.advance(50);
  v.release('ArrowLeft');
  assert.ok(v.paddle().x < 328);
  v.mouseTo(200);
  clock.advance(32);
  // A finger touching down in the spindle strip, far from the carriage, moves it by as much as it moves.
  v.pointer('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 600, clientY: 920 });
  assert.equal(document.activeElement, v.canvas, 'a press gives the platter the focus');
  v.pointer('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 560, clientY: 922 });
  clock.advance(32);
  assert.equal(v.paddle().x, 180);
  // A second finger is ignored.
  v.pointer('pointerdown', { pointerType: 'touch', pointerId: 8, clientX: 100 });
  v.pointer('pointermove', { pointerType: 'touch', pointerId: 8, clientX: 10 });
  v.pointer('pointerup', { pointerType: 'touch', pointerId: 8, clientX: 10 });
  clock.advance(32);
  assert.equal(v.paddle().x, 180);
  v.pointer('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 700, clientY: 920 });
  clock.advance(32);
  assert.equal(v.paddle().x, 250, 'from 200 where it touched down, 50 units on');
  v.pointer('pointerup', { pointerType: 'touch', pointerId: 7, clientX: 700, clientY: 920 });
  clock.advance(32);
  assert.equal(v.balls()[0].y, PADDLE_Y - R - 1, 'the drag launched nothing');
  // Dragged into a wall and back, the carriage turns as soon as the finger does (no dead zone).
  const drag = (clientX) => {
    v.pointer('pointermove', { pointerType: 'touch', pointerId: 10, clientX, clientY: 920 });
    clock.advance(32);
    return v.paddle().x;
  };
  v.pointer('pointerdown', { pointerType: 'touch', pointerId: 10, clientX: 400, clientY: 920 });
  assert.equal(drag(1000), 328, '300 units on from 250: stopped by the right wall');
  assert.equal(drag(800), 228, '100 units back');
  assert.equal(drag(-600), 32, 'the left wall');
  assert.equal(drag(-560), 52, '20 units back');
  v.pointer('pointerup', { pointerType: 'touch', pointerId: 10, clientX: -560, clientY: 920 });
  assert.equal(v.balls()[0].y, PADDLE_Y - R - 1, 'no drag launched anything');
  // A cancelled touch and a right-click do nothing.
  v.pointer('pointerdown', { pointerType: 'touch', pointerId: 9 });
  v.pointer('pointercancel', { pointerType: 'touch', pointerId: 9 });
  v.pointer('pointerup', { pointerType: 'touch', pointerId: 9 });
  v.pointer('pointerdown', { button: 2 });
  v.pointer('pointerup', { button: 2 });
  clock.advance(32);
  assert.equal(v.balls()[0].y, PADDLE_Y - R - 1);
  // A mouse press released outside the canvas is replaced by the next press of the mouse.
  v.pointer('pointerdown', { pointerId: 1 });
  v.pointer('pointerdown', { pointerId: 1, clientX: 400 });
  v.pointer('pointerup', { pointerId: 1, clientX: 404 });
  clock.advance(32);
  assert.ok(v.balls()[0].y < PADDLE_Y - R - 1, 'a click launches');
  // A tap while it flies does nothing; a tap on a paused game resumes it.
  v.tap();
  v.click('pause');
  assert.equal(v.text('pause'), 'Resume');
  v.tap(100, 'pen');
  assert.equal(v.text('pause'), 'Pause');
});

test('bad-sector: Pause and a hidden tab stop the loop and save; resuming never runs the time it stood', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ grid: gridWith({ [FAR_CELL]: 11 }), score: 50 }) } });
  v.press(' ');
  clock.advance(500);
  // The Pause button, clicked with the mouse, hands the keys back to the platter.
  focusElement(v.el('pause'));
  fire(v.el('pause'), 'click', { detail: 1 });
  assert.equal(document.activeElement, v.canvas);
  assert.equal(clock.pending(), 0, 'no frame while paused');
  assert.equal(v.hidden('overlay'), false);
  const at = v.balls()[0];
  clock.advance(10000);
  // Activated from the keyboard, it keeps the focus.
  // (A browser's click from Enter or Space has detail 0; the stub's click() says 1.)
  focusElement(v.el('pause'), { keyboard: true });
  fire(v.el('pause'), 'click', { detail: 0 });
  assert.equal(document.activeElement, v.el('pause'));
  assert.equal(v.text('pause'), 'Pause');
  clock.advance(16);
  assert.deepEqual(v.balls()[0], at, 'the first frame after a resume steps nothing');
  clock.advance(16);
  const step = Math.hypot(v.balls()[0].x - at.x, v.balls()[0].y - at.y);
  assert.ok(step > 0 && step < 230 * 0.04, 'one frame of movement, not ten seconds: ' + step);
  // A frame after a second without frames catches up 100 ms at most.
  const before = v.balls()[0];
  clock.stall(1000).flush();
  const jump = Math.hypot(v.balls()[0].x - before.x, v.balls()[0].y - before.y);
  assert.ok(jump > 230 * 0.08 && jump <= 240 * 0.1 + 1, 'at most 100 ms of movement: ' + jump);
  // A hidden tab pauses and saves; shown again it stays paused until resumed.
  localStorage.removeItem(STATE_KEY);
  setVisibility('hidden', t);
  assert.equal(v.state().score, 50, 'saved when hidden');
  assert.equal(clock.pending(), 0);
  assert.equal(v.text('status'), 'Paused while the tab was hidden. Press P or Space, or tap the platter, to resume.');
  setVisibility('visible', t);
  assert.equal(clock.pending(), 0);
  assert.equal(v.text('pause'), 'Resume');
  v.press(' ');
  assert.equal(clock.pending(), 1);
  assert.equal(v.text('status'), 'Scanning track 1.');
  // Hidden while paused by hand, it stays a plain pause.
  v.press('p');
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.equal(v.text('status'), 'Paused. Press P or Space, or tap the platter, to resume.');
  // Reopened in a background tab with the head in flight, the game shows it paused where it was and stays
  // paused once the tab is shown.
  setVisibility('hidden', t);
  const saved = v.state();
  assert.equal(saved.balls.length, 1);
  const background = reload(clock, v);
  assert.equal(clock.pending(), 0);
  assert.equal(background.text('status'), 'Paused. Press P or Space, or tap the platter, to resume.');
  setVisibility('visible', t);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(background.state().balls, saved.balls);
  background.press(' ');
  assert.equal(clock.pending(), 1);
  // Leaving the page saves the game.
  localStorage.removeItem(STATE_KEY);
  fire(window, 'pagehide');
  assert.equal(background.state().score, 50);
  // With the head on the carriage, a page opened in a background tab waits for the tab to be shown, then runs.
  resetStubs();
  setVisibility('hidden', t);
  const waiting = openPage(t, { storage: { state: stateSave() } });
  assert.equal(waiting.clock.pending(), 0);
  assert.equal(waiting.v.text('status'), 'Press Space or tap the platter to launch the read head.');
  setVisibility('visible', t);
  assert.equal(waiting.clock.pending(), 1);
});

test('bad-sector: breaking the last sector completes the surface scan: bonus, best, the next track by button, Space or tap, and a reload keeps it', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ grid: gridWith({ [FIRST_HIT]: 11 }), total: 20, score: 40 }) } });
  v.press(' ');
  play(v, clock, 3000, { until: () => v.text('sectors') === '0/20' });
  assert.ok(v.texts().some((text) => text === 'LBA 0x011C80'), 'the broken sector flashes its LBA');
  assert.equal(v.text('score'), String(40 + 10 + 100));
  assert.equal(v.toast(), 'Surface scan complete: track 1 clean, +100 points, a new best!');
  assert.equal(v.text('status'), 'Surface scan complete: track 1 is clean. Press Space or tap the platter for track 2.');
  assert.deepEqual(v.best(), { score: 150, level: 1 });
  assert.equal(v.text('best'), '150 / T1');
  assert.equal(v.state().phase, 'cleared');
  assert.equal(v.hidden('next'), false);
  assert.equal(v.el('pause').disabled, true);
  // The LBA flash of the last sector fades out over the message (it never freezes there), then the loop stands.
  assert.equal(clock.pending(), 1, 'the last flash fades out');
  clock.advance(1000);
  assert.ok(!v.texts().includes('LBA 0x011C80'), 'the flash is gone');
  assert.equal(clock.pending(), 0, 'the loop stands');
  v.press('p');
  assert.equal(v.text('pause'), 'Pause', 'nothing to pause');
  const again = reload(clock, v);
  assert.equal(again.text('status'), 'Surface scan complete: track 1 is clean. Press Space or tap the platter for track 2.');
  again.click('next');
  assert.equal(again.text('level'), '2');
  assert.equal(again.text('score'), '150');
  assert.equal(again.state().level, 2);
  assert.equal(again.state().phase, 'serve');
  assert.equal(again.hidden('next'), true);
  assert.equal(again.text('mode'), 'Free scan · track 2');
  assert.equal(clock.pending(), 1);
  // Space and a tap open the next track too.
  resetStubs();
  const space = openPage(t, { storage: { state: stateSave({ phase: 'cleared', level: 4 }) } }).v;
  space.press(' ');
  assert.equal(space.state().level, 5);
  resetStubs();
  const tap = openPage(t, { storage: { state: stateSave({ phase: 'cleared', level: 4 }) } }).v;
  tap.tap();
  assert.equal(tap.state().level, 5);
});

test('bad-sector: a lost head shows on the SMART readout, the third fails the drive, and New disk starts over', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ grid: gridWith({ [FAR_CELL]: 11 }), score: 0 }), best: { score: 500, level: 3 } } });
  v.press(' ');
  play(v, clock, 8000, { dodge: true, until: () => v.text('smart') === '1/3' });
  assert.equal(v.toast(), 'Head lost: SMART Reallocated_Sector_Ct is 1 of 3. Press Space or tap to launch the next head.');
  assert.equal(v.state().lives, 2);
  assert.equal(v.text('status'), 'Press Space or tap the platter to launch the read head.');
  for (const lost of ['2/3', '3/3']) {
    v.press(' ');
    play(v, clock, 12000, { dodge: true, until: () => v.text('smart') === lost });
    assert.equal(v.text('smart'), lost);
  }
  assert.equal(v.toast(), 'Drive failure on track 1: 0 points.');
  assert.equal(v.text('status'), 'Drive failure: SMART threshold exceeded on track 1 with 0 points. New disk starts a fresh scan.');
  assert.deepEqual(v.best(), { score: 500, level: 3 }, 'the stored best stands');
  assert.equal(v.state().lives, 0);
  assert.equal(v.el('pause').disabled, true);
  assert.equal(clock.pending(), 0);
  v.press(' ');
  assert.equal(v.toast(), 'The drive failed on track 1 (0 points): New disk starts a fresh scan.');
  // A reload shows the failed drive; New disk needs no confirmation.
  const again = reload(clock, v);
  assert.equal(again.text('smart'), '3/3');
  again.click('new');
  assert.equal(again.text('smart'), '0/3');
  assert.equal(again.state().lives, 3);
  assert.equal(again.text('status'), 'Press Space or tap the platter to launch the read head.');
});

test('bad-sector: New disk drops a free scan under way only on a second press within 4 s, naming it', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ level: 3, score: 420, grid: SAMPLE_GRID, total: 30 }) } });
  v.click('new');
  assert.equal(v.toast(), 'Press New disk again within 4 s to drop your free scan (track 3, 420 points).');
  assert.equal(v.text('new'), 'Confirm new disk');
  assert.equal(v.state().score, 420);
  clock.advance(3000);
  assert.ok(v.toast(), 'the toast stays as long as the offer');
  clock.advance(1001);
  assert.equal(v.text('new'), 'New disk');
  assert.equal(v.toast(), null);
  v.click('new');
  clock.advance(2000);
  v.click('new');
  assert.equal(v.state().score, 0);
  assert.equal(v.state().level, 1);
  assert.equal(v.text('new'), 'New disk');
  clock.advance(5000);
  assert.equal(v.text('new'), 'New disk', 'no stale timer');
  // A disk with no points yet is replaced at once.
  v.click('new');
  assert.equal(v.text('new'), 'New disk');
});

test('bad-sector: bonuses on the page: a caught RAID1, ECC or SLOW-SEEK shows its toast and its time left', (t) => {
  for (const [power, toast, effect] of [
    [1, 'RAID1: a mirrored second head.', /^RAID1 mirror/],
    [2, 'ECC: a wide carriage for 12 s.', /^ECC 1[0-2] s$/],
    [3, 'SLOW-SEEK: the heads at 60 % speed for 10 s.', /^SLOW-SEEK (9|10) s$/]
  ]) {
    resetStubs();
    const { clock, v } = openPage(t, { storage: { state: stateSave({ grid: gridWith({ [FIRST_HIT]: power * 100 + 11, [FAR_CELL]: 11, 0: 11 }), total: 3 }) } });
    v.press(' ');
    play(v, clock, 8000, { until: () => v.toast() === toast });
    assert.equal(v.toast(), toast, 'power ' + power);
    assert.match(v.text('effects'), effect);
    assert.equal(v.state().score, 10 + 25, 'saved with the catch');
    if (power === 2) assert.equal(v.paddle().w, 96);
  }
});

test('bad-sector: every class the game puts on the page has a rule in style.css', (t) => {
  const seen = new Set();
  const collect = (v) => {
    for (const el of walk(v.page.root)) String(el.className || '').split(/\s+/).filter(Boolean).forEach((name) => seen.add(name));
  };
  const { v } = openPage(t, { storage: { state: stateSave({ phase: 'cleared' }), daily: dailySave({ status: 'won' }) } });
  v.click('new');
  collect(v);
  v.click('daily-button');
  v.el('share-text').classList.remove('bds-hidden');
  v.el('warning').classList.remove('bds-hidden');
  collect(v);
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors).join(' ');
  for (const name of [...seen].sort()) {
    assert.match(name, /^bds-/);
    assert.match(selectors, new RegExp('\\.' + name + '(?![\\w-])'), name);
  }
  for (const name of ['bds-btn--next', 'bds-btn--daily', 'bds-btn--secondary', 'bds-share-text', 'bds-overlay-text']) assert.ok(seen.has(name), name);
});

test('bad-sector: every text on the platter is at least 9 px on a 320 px phone, the LBA flash stays on the platter, and the labels fit their boxes', (t) => {
  const scale = platterAt(320, 568).width / W;
  const sizeOf = (font) => Number(/^(?:bold )?(\d+)px monospace$/.exec(font)[1]);
  const widthOf = (d) => d.text.length * MONO * sizeOf(d.font);
  const texts = (v) => {
    const out = v.drawn().filter((d) => d.kind === 'text');
    for (const d of out) assert.ok(sizeOf(d.font) * scale >= 9, d.text + ' in ' + d.font + ' is ' + sizeOf(d.font) * scale + ' px');
    return out;
  };
  // Every kind of sector, and the three bonuses falling.
  const save = JSON.parse(SAMPLE_FLIGHT);
  save.drops = [[60, 250, 1], [180, 250, 2], [300, 250, 3]];
  const { v } = openPage(t, { storage: { state: save } });
  setVisibility('visible', t);
  const drawn = texts(v);
  for (const text of ['PLATTER 0 · SIDE A · UNROLLED', 'SPINDLE · drag here to move the carriage', 'RO', '+000', '+240']) {
    assert.ok(drawn.some((d) => d.text === text), text);
  }
  for (const d of drawn) assert.ok(widthOf(d) <= W - 8, d.text + ' fits the platter');
  // Capsule labels inside their 44 units, with 2 units each side.
  const labels = drawn.filter((d) => ['RAID1', 'ECC', 'SLOW'].includes(d.text));
  assert.deepEqual(labels.map((d) => d.text).sort(), ['ECC', 'RAID1', 'SLOW']);
  for (const d of labels) assert.ok(widthOf(d) + 4 <= DROP_W, d.text + ': ' + widthOf(d));
  assert.equal(v.drops().length, 3);
  // The LBA tails on bad sectors fit between the hit dots (4 units) and the bonus bar (4 units); the ruler offsets fit a column.
  const tails = drawn.filter((d) => /^[0-9A-F]{3}$/.test(d.text) && d.text !== 'ECC');
  assert.equal(tails.length, 7, 'the seven bad sectors of the sample');
  for (const d of tails) assert.ok(widthOf(d) <= CELL_W - 2 - 8, d.text + ': ' + widthOf(d));
  for (const d of drawn.filter((x) => /^\+[0-9A-F]{3}$/.test(x.text))) assert.ok(widthOf(d) <= CELL_W - 2, d.text);
  // A sector on the left edge breaks: its LBA flash moves in far enough to show whole.
  resetStubs();
  const edge = openPage(t, { storage: { state: stateSave({ phase: 'play', grid: gridWith({ 70: 11, [FAR_CELL]: 11 }), total: 2, balls: [[31.5, 205, 0, -230]] }) } });
  edge.v.press(' ');
  edge.clock.advance(100);
  const flash = texts(edge.v).find((d) => d.text === 'LBA 0x011C00');
  assert.ok(flash, 'the flash of cell 70');
  assert.equal(flash.font, 'bold 14px monospace');
  near(flash.x, widthOf(flash) / 2 + 2, 'moved in from ' + (rectOf(70).x + 15.5));
  assert.ok(flash.x - widthOf(flash) / 2 >= 0);
});

// ── Daily on the page ────────────────────────────────────────────────────────

test('bad-sector: opening the Daily writes the attempt at once, shows today\'s disk and keeps the free scan aside', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ score: 30, grid: gridWith({ [FAR_CELL]: 11 }) }) } });
  v.press(' ');
  clock.advance(300);
  focusElement(v.el('daily-button'));
  fire(v.el('daily-button'), 'click', { detail: 1 });
  assert.equal(document.activeElement, v.canvas);
  assert.equal(localStorage.getItem(DAILY_KEY), JSON.stringify({ v: 1, key: KEY6, day: 6, status: 'playing', score: 0, lives: 3, total: 50, grid: DAILY6_GRID, ecc: 0, slow: 0, speed: 275, paddle: 180, balls: [], drops: [], streak: 0, lastWon: null }));
  assert.equal(v.state().view, 'daily');
  assert.deepEqual([v.state().phase, v.state().balls.length], ['play', 1], 'the free head in flight is kept in flight');
  assert.equal(v.state().score, 30);
  assert.equal(v.text('mode'), 'Daily disk #6 · ' + KEY6);
  assert.equal(v.text('level'), 'Daily');
  assert.equal(v.text('sectors'), '50/50');
  assert.equal(v.text('daily-button'), 'Free scan');
  assert.equal(v.el('daily-button').getAttribute('aria-label'), 'Back to the free scan');
  assert.equal(v.text('status'), 'Press Space or tap the platter to launch the read head.');
  v.press(' ');
  clock.advance(100);
  assert.equal(v.text('status'), 'Scanning Daily disk #6.');
  // Back to the free scan and to the Daily again: each game paused with its head where it was.
  v.click('daily-button');
  assert.equal(v.text('mode'), 'Free scan · track 1');
  assert.equal(v.text('score'), '30');
  assert.equal(v.text('status'), 'Paused. Press P or Space, or tap the platter, to resume.');
  v.click('daily-button');
  assert.equal(v.daily().key, KEY6);
  assert.equal(v.daily().balls.length, 1);
  assert.equal(v.text('status'), 'Paused. Press P or Space, or tap the platter, to resume.');
  // A reload on the Daily resumes it.
  const again = reload(clock, v);
  assert.equal(again.text('mode'), 'Daily disk #6 · ' + KEY6);
  assert.deepEqual(again.daily().grid, DAILY6_GRID);
  // A save of the current format resumes as it was and is written back unchanged.
  resetStubs();
  const sample = openPage(t, { storage: { state: stateSave({ view: 'daily' }), daily: SAMPLE_DAILY } }).v;
  assert.equal(localStorage.getItem(DAILY_KEY), SAMPLE_DAILY);
  assert.equal(sample.text('score'), '120');
  assert.equal(sample.text('sectors'), '49/50');
  assert.equal(sample.text('streak'), '2');
});

test('bad-sector: a head about to be lost stays lost: Free scan and back, New disk and a reload keep it in flight, paused where it was', (t) => {
  const { clock, v } = openPage(t, { storage: {
    state: stateSave({ view: 'daily', score: 30, grid: gridWith({ [FAR_CELL]: 11 }) }),
    daily: dailySave({ grid: gridWith({ [FAR_CELL]: 11, 0: 22 }), total: 2 })
  } });
  v.press(' ');
  clock.advance(300);
  // The head heads down past a carriage that keeps away from it.
  play(v, clock, 8000, { dodge: true, until: () => v.balls()[0].y > 380 });
  const at = v.balls()[0];
  assert.ok(at.y > 380 && at.y < PADDLE_Y, JSON.stringify(at));
  assert.equal(v.text('smart'), '0/3');
  const away = v.paddle().x;
  v.press('p');
  const where = () => ({ ball: v.balls()[0], paddle: v.paddle().x, smart: v.text('smart'), status: v.text('status') });
  const frozen = { ball: at, paddle: away, smart: '0/3', status: 'Paused. Press P or Space, or tap the platter, to resume.' };
  assert.deepEqual(where(), frozen);
  // Free scan and Daily #6 again: still in flight, still paused, nothing given back.
  v.click('daily-button');
  assert.equal(v.text('mode'), 'Free scan · track 1');
  v.click('daily-button');
  assert.deepEqual(where(), frozen);
  // New disk from the Daily view (twice, for the free scan of 30 points), then the Daily again.
  v.click('new');
  v.click('new');
  assert.equal(v.text('mode'), 'Free scan · track 1');
  v.click('daily-button');
  assert.deepEqual(where(), frozen);
  // Not even a reload, paused or not: the page leaves with the head in flight and comes back with it.
  v.press('p');
  clock.advance(16);
  fire(window, 'pagehide');
  const saved = v.daily();
  assert.equal(saved.balls.length, 1);
  let again = reload(clock, v);
  assert.equal(again.text('status'), frozen.status);
  setVisibility('visible', t);
  assert.deepEqual(again.balls(), [{ x: saved.balls[0][0], y: saved.balls[0][1] }]);
  assert.equal(again.paddle().x, saved.paddle);
  assert.equal(again.text('smart'), '0/3');
  // Resumed, the head goes on down and is lost: SMART counts it.
  again.press(' ');
  play(again, clock, 3000, { dodge: true, until: () => again.text('smart') === '1/3' });
  assert.equal(again.text('smart'), '1/3');
  assert.equal(again.daily().lives, 2);
  assert.equal(again.text('status'), 'Press Space or tap the platter to launch the read head.');
  // The free scan the same way: a head in flight there survives the Daily button twice.
  again.click('daily-button');
  again.press(' ');
  clock.advance(500);
  again.press('p');
  const free = again.balls()[0];
  again.click('daily-button');
  again.click('daily-button');
  assert.deepEqual(again.balls()[0], free);
  assert.equal(again.text('status'), frozen.status);
  // Another tab's attempt further along, saved with its head in flight, is shown paused too.
  again.click('daily-button');
  const theirs = dailySave({ score: 900, lives: 2, grid: gridWith({ [FAR_CELL]: 11, 0: 22 }), total: 2, balls: [[100, 300, 60, -200]] });
  localStorage.setItem(DAILY_KEY, JSON.stringify(theirs));
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(again.text('score'), '900');
  assert.equal(again.text('status'), frozen.status);
  assert.deepEqual(again.balls(), [{ x: 100, y: 300 }]);
  assert.equal(clock.pending(), 0);
});

test('bad-sector: clearing the Daily records it once: streak, share line, Practice, and a reload shows the result', async (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ view: 'daily', score: 70, grid: gridWith({ [FAR_CELL]: 11 }) }), daily: dailySave({ streak: 3, lastWon: 5, score: 200, total: 50 }) } });
  v.press(' ');
  play(v, clock, 3000, { until: () => v.daily().status !== 'playing' });
  const record = v.daily();
  assert.equal(record.status, 'won');
  assert.equal(record.score, 200 + 10 + 400);
  assert.deepEqual([record.streak, record.lastWon], [4, 6]);
  assert.equal(v.toast(), 'Surface scan complete: Daily disk #6, 610 points.');
  assert.equal(v.text('status'), 'Surface scan complete: Daily disk #6 is clean, 610 points, SMART realloc 0/3. Streak 4.');
  assert.equal(v.text('streak'), '4');
  assert.equal(localStorage.getItem(BEST_KEY), null, 'the Daily sets no free best');
  assert.equal(v.hidden('share'), false);
  assert.equal(v.hidden('practice'), false);
  assert.equal(v.hidden('next'), true);
  v.press(' ');
  assert.equal(v.toast(), 'Daily disk #6 is cleared (610 points): Practice replays it, unscored.');
  const write = t.mock.method(navigator.clipboard, 'writeText', () => Promise.resolve());
  v.click('share-button');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(write.mock.calls.map((call) => call.arguments), [['Bad Sector Daily #6: surface scan complete, 610 points, SMART realloc 0/3']]);
  assert.equal(v.toast(), 'Copied: Bad Sector Daily #6: surface scan complete, 610 points, SMART realloc 0/3');
  // In the free scan the Daily button shows today's is done.
  v.click('daily-button');
  assert.equal(v.text('daily-button'), 'Daily #6 ✓');
  v.click('daily-button');
  // A reload shows the result, never a second scored attempt.
  const again = reload(clock, v);
  assert.equal(again.text('status'), 'Surface scan complete: Daily disk #6 is clean, 610 points, SMART realloc 0/3. Streak 4.');
  assert.equal(clock.pending(), 0);
  // Practice drops a scored free scan under way only on a second press within 4 s, as New disk does.
  again.click('practice');
  assert.equal(again.toast(), 'Press Practice again within 4 s to drop your free scan (track 1, 70 points).');
  assert.equal(again.text('practice'), 'Confirm practice');
  assert.equal(again.state().practice, null);
  clock.advance(3000);
  assert.ok(again.toast(), 'the toast stays as long as the offer');
  clock.advance(1001);
  assert.equal(again.text('practice'), 'Practice');
  assert.equal(again.toast(), null);
  // New disk pressed in between asks for itself; neither press replaces anything.
  again.click('practice');
  again.click('new');
  assert.deepEqual([again.text('practice'), again.text('new')], ['Practice', 'Confirm new disk']);
  assert.equal(again.text('mode'), 'Daily disk #6 · ' + KEY6);
  assert.equal(again.state().practice, null);
  again.click('practice');
  assert.deepEqual([again.text('practice'), again.text('new')], ['Confirm practice', 'New disk']);
  // The second press: today's disk in the free scan, unscored (the toast names the free scan it replaced).
  again.click('practice');
  assert.equal(again.toast(), 'Practice run of Daily disk #6: not scored. Your free scan (track 1, 70 points) was replaced.');
  assert.equal(again.text('practice'), 'Practice');
  assert.equal(again.state().practice, 6);
  assert.deepEqual(again.state().grid, DAILY6_GRID);
  assert.equal(again.text('mode'), 'Practice of Daily disk #6 · not scored');
  assert.equal(again.daily().score, 610);
  // Practice outside a finished Daily does nothing.
  again.click('practice');
  assert.equal(again.state().practice, 6);
  // A practice run, cleared, offers no next track and sets no best.
  resetStubs();
  const practice = openPage(t, { storage: { state: stateSave({ practice: 6, level: 4 }) } });
  practice.v.press(' ');
  play(practice.v, practice.clock, 3000, { until: () => practice.v.state().phase === 'cleared' });
  assert.equal(practice.v.toast(), 'Surface scan complete: track 4 clean, +400 points.');
  assert.equal(practice.v.text('status'), 'Surface scan complete: practice run of Daily disk #6, not scored.');
  assert.equal(practice.v.hidden('next'), true);
  assert.equal(localStorage.getItem(BEST_KEY), null);
  practice.v.press(' ');
  assert.equal(practice.v.toast(), 'This practice run of Daily disk #6 is over: New disk deals a scored disk.');
  practice.v.click('new');
  assert.equal(practice.v.state().practice, null);
});

test('bad-sector: a failed Daily ends the streak, shares how far the scan got, and a failed practice run is not scored', async (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ view: 'daily' }), daily: dailySave({ lives: 1, total: 20, score: 300, grid: gridWith({ [FAR_CELL]: 11, 0: 22 }), streak: 5, lastWon: 5 }) } });
  v.press(' ');
  play(v, clock, 8000, { dodge: true, until: () => v.daily().status !== 'playing' });
  assert.equal(v.daily().status, 'lost');
  assert.equal(v.daily().streak, 0);
  assert.equal(v.toast(), 'Drive failure on Daily disk #6: 300 points.');
  assert.equal(v.text('status'), 'Drive failure on Daily disk #6 at 90% scanned, 300 points. Practice replays it, unscored.');
  assert.equal(v.text('streak'), '0');
  v.click('daily-button');
  assert.equal(v.text('daily-button'), 'Daily #6 ✗');
  v.click('daily-button');
  v.press(' ');
  assert.equal(v.toast(), 'Daily disk #6 is lost (300 points): Practice replays it, unscored.');
  // Without a clipboard, or when it refuses, the line is shown selected for copying by hand.
  const real = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  t.after(() => Object.defineProperty(navigator, 'clipboard', real));
  for (const clipboard of [undefined, {}, { writeText: () => Promise.reject(new Error('denied')) }]) {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true, writable: true });
    v.el('share-text').classList.add('bds-hidden');
    v.click('share-button');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(v.hidden('share-text'), false, JSON.stringify(clipboard));
    assert.equal(v.el('share-text').value, 'Bad Sector Daily #6: drive failure at 90% scanned, 300 points');
    assert.equal(document.activeElement, v.el('share-text'));
    assert.equal(v.toast(), 'The clipboard is not available: copy the selected result below.');
  }
  // A practice run that fails says so and sets no best.
  resetStubs();
  const run = openPage(t, { storage: { state: stateSave({ practice: 6, lives: 1, grid: gridWith({ [FAR_CELL]: 11 }) }) } });
  run.v.press(' ');
  play(run.v, run.clock, 8000, { dodge: true, until: () => run.v.text('smart') === '3/3' });
  assert.equal(run.v.toast(), 'Drive failure on track 1: 0 points.');
  assert.equal(run.v.text('status'), 'Drive failure: SMART threshold exceeded on track 1 with 0 points. Practice run, not scored.');
  assert.equal(localStorage.getItem(BEST_KEY), null);
  run.v.press(' ');
  assert.equal(run.v.toast(), 'This practice run of Daily disk #6 is over: New disk deals a scored disk.');
});

test('bad-sector: the streak grows on consecutive days and starts over after a missed one', (t) => {
  const yesterday = dailySave({ key: KEY5, day: 5, status: 'won', streak: 3, lastWon: 5 });
  let { clock, v } = openPage(t, { storage: { daily: yesterday } });
  assert.equal(v.text('streak'), '3');
  assert.equal(v.text('daily-button'), 'Daily #6');
  v.click('daily-button');
  assert.equal(v.daily().streak, 3);
  assert.deepEqual(v.daily().grid, DAILY6_GRID);
  resetStubs();
  ({ clock, v } = openPage(t, { storage: { daily: Object.assign({}, yesterday, { key: '2026-11-04', day: 4, lastWon: 4 }) } }));
  assert.equal(v.text('streak'), '0', 'a missed day');
  v.click('daily-button');
  assert.equal(v.daily().streak, 0);
  // Cleared after a missed day: the streak starts at 1.
  resetStubs();
  ({ clock, v } = openPage(t, { storage: { state: stateSave({ view: 'daily' }), daily: dailySave({ streak: 2, lastWon: 4 }) } }));
  v.press(' ');
  play(v, clock, 3000, { until: () => v.daily().status !== 'playing' });
  assert.deepEqual([v.daily().status, v.daily().streak, v.daily().lastWon], ['won', 1, 6]);
});

test('bad-sector: a Daily left open across midnight finishes as the day it started; the next one starts after', (t) => {
  const { clock, v } = openPage(t, { when: NOV6_LATE, storage: { state: stateSave({ view: 'daily' }), daily: dailySave({ streak: 1, lastWon: 5 }) } });
  clock.advance(60000);
  assert.equal(bds.bdsDayInfo(new Date()).key, KEY7, 'the clock has passed midnight');
  v.press(' ');
  play(v, clock, 3000, { until: () => v.daily().status !== 'playing' });
  const record = v.daily();
  assert.deepEqual([record.key, record.status, record.lastWon, record.streak], [KEY6, 'won', 6, 2]);
  assert.match(v.text('status'), /^Surface scan complete: Daily disk #6 is clean/);
  assert.equal(v.text('streak'), '2', 'yesterday\'s clear keeps the streak today');
  v.click('daily-button');
  assert.equal(v.text('daily-button'), 'Daily #7', 'today\'s Daily is a new one');
  v.click('daily-button');
  assert.equal(v.daily().key, KEY7);
  assert.equal(v.daily().status, 'playing');
  assert.equal(v.daily().streak, 2);
  assert.deepEqual(v.daily().grid, bds.bdsDailyGrid(KEY7));
});

test('bad-sector: at local midnight a page standing still shows the new day\'s Daily button and streak', (t) => {
  const label = (v) => [v.text('daily-button'), v.text('streak')];
  // Yesterday's Daily won: the streak lasts today and is gone tomorrow.
  const { clock, v } = openPage(t, { when: NOV6_LATE, storage: { state: stateSave({ phase: 'cleared' }), daily: dailySave({ key: KEY5, day: 5, status: 'won', streak: 3, lastWon: 5 }) } });
  assert.equal(clock.pending(), 0, 'the loop stands');
  assert.deepEqual(label(v), ['Daily #6', '3']);
  clock.stall(30000);
  assert.deepEqual(label(v), ['Daily #6', '3'], 'midnight itself: the render is due 50 ms later');
  clock.stall(100);
  assert.deepEqual(label(v), ['Daily #7', '0'], 'a missed Daily ends the streak');
  clock.stall(86400000);
  assert.equal(v.text('daily-button'), 'Daily #8', 'and again the next night');
  // Today's Daily cleared: its mark goes at midnight, the streak stays.
  resetStubs();
  const done = openPage(t, { when: NOV6_LATE, storage: { state: stateSave({ phase: 'cleared' }), daily: dailySave({ status: 'won', streak: 2, lastWon: 6 }) } });
  assert.deepEqual(label(done.v), ['Daily #6 ✓', '2']);
  done.clock.stall(30100);
  assert.deepEqual(label(done.v), ['Daily #7', '2']);
});

test('bad-sector: a second tab takes over the other tab\'s newer Daily at a save, through the storage event, and when opening it; an older or future one never wins', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ view: 'daily' }), daily: dailySave({ grid: gridWith({ [FIRST_HIT]: 22, [FAR_CELL]: 11 }), total: 2 }) } });
  v.press(' ');
  clock.advance(200);
  // The other tab played further: 300 points.
  const theirs = dailySave({ score: 300, lives: 2, grid: gridWith({ [FAR_CELL]: 11, 0: 11 }), total: 9 });
  localStorage.setItem(DAILY_KEY, JSON.stringify(theirs));
  // The next save here (the hit on the bad sector) takes theirs over instead.
  play(v, clock, 3000, { until: () => v.text('score') === '300' });
  assert.deepEqual(v.daily(), theirs);
  assert.equal(v.toast(), 'Another tab saved Daily disk #6 (300 points, SMART realloc 1/3): it is shown here.');
  assert.equal(v.text('status'), 'Press Space or tap the platter to launch the read head.');
  // The storage event: the other tab cleared it.
  const cleared = Object.assign({}, theirs, { status: 'won', score: 900, grid: gridWith({}), streak: 1, lastWon: 6 });
  localStorage.setItem(DAILY_KEY, JSON.stringify(cleared));
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.text('score'), '300', 'an event for another key changes nothing');
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(v.toast(), 'Another tab cleared Daily disk #6 (900 points, SMART realloc 1/3): it is shown here.');
  assert.equal(v.text('streak'), '1');
  assert.equal(clock.pending(), 0);
  // An older record afterwards is ignored, and so is the same text again.
  localStorage.setItem(DAILY_KEY, JSON.stringify(theirs));
  fire(window, 'storage', { key: DAILY_KEY });
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(v.text('score'), '900');
  v.click('daily-button');
  v.click('daily-button');
  assert.equal(JSON.parse(localStorage.getItem(DAILY_KEY)).status, 'won', 'the win is written back as it came');
  // Opening the Daily in a tab that had none resumes the attempt another tab began, with no toast.
  resetStubs();
  const fresh = openPage(t);
  localStorage.setItem(DAILY_KEY, SAMPLE_DAILY);
  fresh.v.click('daily-button');
  assert.equal(fresh.v.text('score'), '120');
  assert.equal(fresh.v.toast(), null);
  assert.equal(localStorage.getItem(DAILY_KEY), SAMPLE_DAILY);
  // A record from after today never blocks today's attempt.
  resetStubs();
  const future = JSON.stringify(dailySave({ key: '2026-11-09', day: 9, score: 5000 }));
  const later = openPage(t, { storage: { daily: future } }).v;
  later.click('daily-button');
  assert.equal(later.daily().key, KEY6);
  localStorage.setItem(DAILY_KEY, future);
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(later.text('mode'), 'Daily disk #6 · ' + KEY6);
  // A free scan on screen takes the other tab's record quietly.
  resetStubs();
  const quiet = openPage(t).v;
  localStorage.setItem(DAILY_KEY, JSON.stringify(cleared));
  fire(window, 'storage', { key: DAILY_KEY });
  assert.equal(quiet.text('daily-button'), 'Daily #6 ✓');
  assert.equal(quiet.toast(), null);
});

test('bad-sector: bests from two tabs merge: a storage event shows the other tab\'s, and a new result never erases it', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ score: 20, level: 2 }), best: { score: 100, level: 5 } } });
  assert.equal(v.text('best'), '100 / T5');
  localStorage.setItem(BEST_KEY, JSON.stringify({ score: 900, level: 3 }));
  fire(window, 'storage', { key: BEST_KEY });
  assert.equal(v.text('best'), '900 / T5');
  localStorage.setItem(BEST_KEY, JSON.stringify({ score: 950, level: 7 }));
  v.press(' ');
  play(v, clock, 3000, { until: () => v.state().phase === 'cleared' });
  assert.equal(v.toast(), 'Surface scan complete: track 2 clean, +200 points.');
  assert.deepEqual(v.best(), { score: 950, level: 7 });
  localStorage.setItem(BEST_KEY, '{');
  fire(window, 'storage', { key: BEST_KEY });
  assert.equal(v.text('best'), '950 / T7');
});

// ── Saves on the page ────────────────────────────────────────────────────────

test('bad-sector: a save in the current format loads as it was and is written back byte for byte', (t) => {
  const { clock, v } = openPage(t, { storage: { state: SAMPLE_SAVE } });
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE);
  assert.equal(v.text('score'), '340');
  assert.equal(v.text('level'), '2');
  assert.equal(v.text('sectors'), '14/38');
  assert.equal(v.text('smart'), '1/3');
  assert.equal(v.text('effects'), 'ECC 5 s');
  clock.advance(32);
  assert.deepEqual(v.paddle(), { x: 150, w: 96 }, 'the carriage where it was, wide with ECC');
  // Every kind of sector is drawn: read-only stripes, bad sectors with their LBA, bonus marks.
  assert.ok(v.texts().includes('RO'));
  assert.ok(v.texts().includes('080'), 'the LBA tail of the bad sector at cell 2 (0x020080)');
  assert.ok(v.drawn().some((d) => d.kind === 'rect' && d.style === '#a78bfa'), 'a SLOW-SEEK mark');
  // A save with SLOW-SEEK running shows it.
  resetStubs();
  const slow = openPage(t, { storage: { state: SAMPLE_SAVE.replace('"slow":0', '"slow":2.5') } }).v;
  assert.equal(slow.text('effects'), 'ECC 5 s · SLOW-SEEK 3 s');
  // A save with two heads in flight and a bonus falling: written back byte for byte, shown paused where it was.
  resetStubs();
  const flight = openPage(t, { storage: { state: SAMPLE_FLIGHT } });
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_FLIGHT);
  assert.equal(flight.v.text('status'), 'Paused. Press P or Space, or tap the platter, to resume.');
  assert.equal(flight.v.text('effects'), 'RAID1 mirror · ECC 5 s · SLOW-SEEK 2 s');
  assert.equal(flight.v.text('pause'), 'Resume');
  assert.equal(flight.clock.pending(), 0);
  setVisibility('visible', t);
  assert.deepEqual(flight.v.balls(), [{ x: 100.5, y: 300.25 }, { x: 259.5, y: 300.25 }]);
  assert.deepEqual(flight.v.drops().map((d) => [d.x + DROP_W / 2, d.y + DROP_H / 2]), [[200, 250.5]]);
  assert.deepEqual(flight.v.paddle(), { x: 150, w: 96 });
});

test('bad-sector: a game survives a reload: track, sectors, score, lives, bonuses and the head in flight, paused where it was', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ grid: gridWith({ [FIRST_HIT]: 33, [FAR_CELL]: 11 }), total: 2, ecc: 8 }) } });
  v.press(' ');
  play(v, clock, 3000, { until: () => v.text('score') !== '0' });
  const snapshot = v.state();
  assert.equal(snapshot.grid[FIRST_HIT], 32);
  assert.deepEqual([snapshot.phase, snapshot.balls.length, snapshot.speed], ['play', 1, 232], 'saved with the hit, in flight');
  const again = reload(clock, v);
  assert.deepEqual(again.state(), snapshot);
  assert.equal(again.text('score'), '5');
  assert.equal(again.text('status'), 'Paused. Press P or Space, or tap the platter, to resume.');
  // Resumed, the head goes on from where it was, never from the carriage.
  again.press(' ');
  clock.advance(48);
  const [x, y] = snapshot.balls[0];
  const ball = again.balls()[0];
  assert.ok(Math.hypot(ball.x - x, ball.y - y) < 232 * 0.06, JSON.stringify(ball) + ' from ' + x + ',' + y);
  assert.ok(ball.y < PADDLE_Y - 40, 'not back on the carriage');
});

test('bad-sector: a corrupt or partial save never breaks the page: a fresh, playable track instead', (t) => {
  const saves = [
    '{', '[]', 'null', '42', '"x"', JSON.stringify({ grid: 'x' }), JSON.stringify({ level: 3, grid: [] }),
    JSON.stringify(stateSave({ grid: gridWith({ 0: RO }) })), JSON.stringify(stateSave({ lives: -1, score: 'x', level: 'x', grid: null })),
    JSON.stringify({ v: 9, view: 'nope', phase: 7 })
  ];
  for (const text of saves) {
    resetStubs();
    const { clock, v } = openPage(t, { storage: { state: text, best: '{', daily: '[' } });
    const parsed = bds.bdsParseState(text);
    assert.equal(v.text('level'), String(parsed.level), text);
    assert.equal(v.text('best'), '--', text);
    assert.ok(countSectors(v.state().grid) >= 12, text + ': a fresh track');
    v.press(' ');
    clock.advance(100);
    assert.equal(v.text('status'), 'Scanning track ' + parsed.level + '.', text);
    v.click('daily-button');
    assert.equal(v.daily().key, KEY6, text);
  }
  // A broken Daily save on the Daily view opens a fresh attempt, keeping the streak.
  resetStubs();
  const broken = openPage(t, { storage: { state: { view: 'daily' }, daily: { key: 'nope', streak: 6, lastWon: 5 } } }).v;
  assert.equal(broken.daily().key, KEY6);
  assert.equal(broken.daily().streak, 6);
});

test('bad-sector: blocked storage never stops the game, and the warning names every key not saved', (t) => {
  blockStorage('access', t);
  const { clock, v } = openPage(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Storage is blocked or full (SecurityError): bds-best, bds-daily, bds-state are not saved on this page. The game plays on.');
  v.press(' ');
  clock.advance(500);
  assert.equal(v.text('status'), 'Scanning track 1.');
  v.click('daily-button');
  assert.equal(v.text('sectors'), '50/50');
  v.click('daily-button');
  assert.equal(v.text('mode'), 'Free scan · track 1');
});

test('bad-sector: full storage still reads the saves; the game plays on and names the key once', (t) => {
  writeStorage({ state: SAMPLE_SAVE });
  blockStorage('full', t);
  const { clock, v } = openPage(t);
  assert.equal(v.text('score'), '340', 'the save is still read');
  assert.equal(v.text('warning'), 'Storage is blocked or full (QuotaExceededError): bds-state is not saved on this page. The game plays on.');
  v.el('warning').textContent = 'seen';
  v.press('p');
  v.press('p');
  clock.advance(100);
  assert.equal(v.text('warning'), 'seen', 'warned once per key');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE);
});

test('bad-sector: a newer toast keeps its full 2.2 s', (t) => {
  const { clock, v } = openPage(t, { storage: { state: stateSave({ lives: 0 }) } });
  v.press(' ');
  clock.advance(2000);
  v.press(' ');
  clock.advance(2100);
  assert.ok(v.toast(), 'still shown 2.1 s after the second one');
  clock.advance(101);
  assert.equal(v.toast(), null);
});
