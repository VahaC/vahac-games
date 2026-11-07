// tests/regex-par.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage, makeEventTarget,
  createEvent, fire, pressKey, focusElement, typeInto, setVisibility, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'regex-par';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

// The pure functions (the start-up code does not run under Node).
const rxp = loadScript(SCRIPT);
const HOLES = rxp.rxpHoles;

const STATE_KEY = 'rxp-state';
const BEST_KEY = 'rxp-best';
const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime();
const COURSE_PAR = 264;

// What the harness has before any Worker stand-in goes in.
const ORIGINAL_WORKER = globalThis.Worker;
const ORIGINAL_CREATE_URL = URL.createObjectURL;

// The engine's own message for an invalid pattern (it differs a little
// between Node versions, so it is read here instead of written out).
function engineError(pattern) {
  try {
    new RegExp(pattern);
  } catch (error) {
    return error.message;
  }
  return null;
}

// A shortest known solution of every hole, kept here and not in the game:
// each one is at most its hole's par and also passes main-thread mode.
const REFERENCE = [
  '" 5',
  '^./5 ',
  'K.*d',
  't=[^0]',
  '[90]\\d%',
  'R .*/a',
  'l":"[ef]',
  'd u',
  'Fa|=1',
  '\\d[^/]*$',
  '^([\\da-f]{2}:?){6}$',
  'N.*:\\d{1,3} ',
  '^([01].|2[0-3]):[0-5].$',
  '^v\\d+\\.\\d+\\.\\d+(-\\w|$)',
  '^(10|172\\.(1[6-9]|2.|3[01])|192\\.168)\\.',
  '\\d{3}-(0[1-9]|1[0-2])-([0-2]\\d|3[01])',
  '^[a-z]+(\\(\\w+\\))?: ',
  '^[^g]{8}(-....){3}-.{12}$'
];

// An rxp-state in the format the first published version writes: hole 3
// on screen in round 3, drafts for holes 1-3, holes 1 and 2 on the card.
const SAMPLE_STATE = '{"v":1,"hole":2,"round":3,' +
  '"drafts":["\\" 5","^\\\\*/5 ","Kil","","","","","","","","","","","","","","",""],' +
  '"card":[3,6,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]}';
// An rxp-best of that version: the best of hole 1 and a best round.
const SAMPLE_BEST = '{"v":1,"holes":[{"pattern":"\\" 5","strokes":3},null,null,null,null,null,null,null,null,' +
  'null,null,null,null,null,null,null,null,null],"course":270}';

test.beforeEach(() => resetStubs());

// ── An independent model ─────────────────────────────────────────────────────

const linesOf = (hole) => hole.match.concat(hole.skip);

function modelSolves(pattern, hole) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (error) {
    return false;
  }
  return hole.match.every((line) => line.search(re) !== -1) && hole.skip.every((line) => line.search(re) === -1);
}

// The first match of every line as [start, end], null for none.
const modelSpans = (pattern, lines) => lines.map((line) => {
  const m = line.match(new RegExp(pattern));
  return m ? [m.index, m.index + m[0].length] : null;
});

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

const NAMES = { '-3': 'albatross', '-2': 'eagle', '-1': 'birdie', 0: 'par', 1: 'bogey', 2: 'double bogey', 3: 'triple bogey' };
const toPar = (n) => (n === 0 ? 'E' : (n > 0 ? '+' : '') + n);
const nameOf = (n) => NAMES[n] || (n < 0 ? n + ' under par' : n + ' over par');
const strokesText = (n) => n + (n === 1 ? ' stroke' : ' strokes');

// ── A Web Worker stand-in ────────────────────────────────────────────────────
//
// Runs the game's own worker source in a vm context of its own, as a real
// worker runs the Blob.  Nothing moves until the test calls settle(): every
// message the page posted runs (unless options.hang(message) says it hangs,
// as a runaway pattern would) and every reply is delivered as a message
// event.  options.throws: the constructor throws, as when a Content
// Security Policy blocks blob: workers (a number: from that construction
// on).

function installWorker(t, options = {}) {
  const created = [];
  const blobs = [];
  let constructions = 0;
  URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return 'blob:rxp-test/' + blobs.length;
  };
  class FakeWorker {
    constructor(url) {
      constructions++;
      const from = options.throws === true ? 1 : options.throws;
      if (from && constructions >= from) {
        const error = new Error('Refused to create a worker from ' + url + ' (worker-src)');
        error.name = 'SecurityError';
        throw error;
      }
      makeEventTarget(this);
      this.url = url;
      this.terminated = false;
      this.inbox = [];
      this.outbox = [];
      this.posted = [];
      this.hung = [];
      this.scope = { postMessage: (data) => this.outbox.push(structuredClone(data)), onmessage: null };
      vm.runInNewContext(rxp.rxpWorkerSource, { self: this.scope });
      created.push(this);
    }
    postMessage(data) {
      this.posted.push(structuredClone(data));
      this.inbox.push(structuredClone(data));
    }
    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = FakeWorker;
  t.after(() => {
    if (ORIGINAL_WORKER === undefined) delete globalThis.Worker;
    else globalThis.Worker = ORIGINAL_WORKER;
    URL.createObjectURL = ORIGINAL_CREATE_URL;
  });
  function settle() {
    for (let round = 0; round < 50; round++) {
      let moved = false;
      for (const worker of created) {
        if (worker.terminated) continue;
        while (worker.inbox.length) {
          const message = worker.inbox.shift();
          moved = true;
          if (options.hang && options.hang(message)) worker.hung.push(message);
          else worker.scope.onmessage({ data: message });
        }
        while (worker.outbox.length) {
          moved = true;
          worker.dispatchEvent(createEvent('message', { data: worker.outbox.shift() }));
        }
      }
      if (!moved) return;
    }
    throw new Error('the fake workers did not settle');
  }
  return {
    created,
    blobs,
    settle,
    current: () => created[created.length - 1],
    patterns: () => created.flatMap((w) => w.posted.map((m) => m.pattern))
  };
}

// ── Pages ────────────────────────────────────────────────────────────────────

// Mocked timers and Date.  reload() drops the timers of the page that goes
// away, as a real reload does.
function makeClock(t) {
  const enable = () => t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: NOW });
  try {
    enable();
  } catch (error) {
    t.mock.timers.reset();
    enable();
  }
  return {
    advance: (ms) => t.mock.timers.tick(ms),
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

function lineInfo(li) {
  const [mark, pre, hit, post] = li.children;
  return {
    cls: li.className,
    mark: mark.textContent,
    text: pre.textContent + hit.textContent + post.textContent,
    hit: hit.textContent,
    before: pre.textContent,
    empty: hit.className === 'rxp-hit rxp-hit--empty',
    label: li.getAttribute('aria-label')
  };
}

// What a player sees and does.
function pageView(b) {
  const els = b.els;
  const input = els['rxp-pattern'];
  const v = {
    els,
    page: b.page,
    ready: b.ready,
    restore: b.restore,
    input,
    el: (name) => els['rxp-' + name],
    text: (name) => els['rxp-' + name].textContent,
    hidden: (name) => els['rxp-' + name].classList.contains('rxp-hidden'),
    click: (name) => els['rxp-' + name].click(),
    type(value) {
      focusElement(input);
      return typeInto(input, value);
    },
    enter(props) {
      focusElement(input, { keyboard: true });
      return pressKey('Enter', Object.assign({ target: input }, props));
    },
    play(pattern) {
      v.type(pattern);
      return v.enter();
    },
    lines: () => els['rxp-match-list'].children.concat(els['rxp-skip-list'].children).map(lineInfo),
    cells: () => els['rxp-card'].children,
    cell: (i) => els['rxp-card'].children[i],
    score: (i) => els['rxp-card'].children[i].children[1].textContent,
    chips: () => els['rxp-chips'].children,
    chip: (text) => els['rxp-chips'].children.find((el) => el.textContent === text),
    toast: () => (els['rxp-toast'].classList.contains('rxp-show') ? els['rxp-toast'].textContent : null),
    toastKind: () => (/rxp-toast--(\w+)/.exec(els['rxp-toast'].className) || [null, 'success'])[1],
    state: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    best: () => JSON.parse(localStorage.getItem(BEST_KEY))
  };
  return v;
}

function boot(options) {
  return pageView(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options));
}

// The page as a browser loads it, after writing storage, with mocked
// timers; with worker options a Worker stand-in is installed first.
function openPage(t, { storage, worker, options } = {}) {
  const clock = makeClock(t);
  writeStorage(storage);
  const w = worker ? installWorker(t, worker === true ? {} : worker) : null;
  return { clock, w, v: boot(options) };
}

// A reload: the old page and its timers go away, storage stays.
function reload(clock, v) {
  clock.reload();
  v.restore();
  return boot();
}

// What the lists show for pattern on hole, by the model.
function expectedLines(hole, pattern) {
  return linesOf(hole).map((text, i) => {
    const want = i < hole.match.length;
    const m = text.match(new RegExp(pattern));
    const good = !!m === want;
    return {
      cls: 'rxp-line ' + (good ? 'rxp-line--ok' : 'rxp-line--bad'),
      mark: good ? '✓' : '✗',
      text,
      hit: m ? m[0] : '',
      before: m ? text.slice(0, m.index) : text,
      empty: !!m && m[0] === '',
      label: (want ? (m ? 'caught' : 'missed') : (m ? 'caught by mistake' : 'left alone')) + ': ' + text
    };
  });
}

function neutralLines(hole) {
  return linesOf(hole).map((text, i) => ({
    cls: 'rxp-line', mark: '·', text, hit: '', before: text, empty: false,
    label: (i < hole.match.length ? 'to catch' : 'to leave') + ': ' + text
  }));
}

// A card with the reference solutions' strokes on holes from..to-1.
function cardWith(from, to) {
  return HOLES.map((hole, i) => (i >= from && i < to ? REFERENCE[i].length : null));
}

function stateSave(extra) {
  return Object.assign({ v: 1, hole: 0, round: 1, drafts: HOLES.map(() => ''), card: HOLES.map(() => null) }, extra);
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

test('regex-par: every id the script looks up is in index.html once; ids, classes, CSS variables, keyframes, storage keys and exports are rxp- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'rxp-best-course', 'rxp-best-hole', 'rxp-card', 'rxp-chips', 'rxp-course', 'rxp-hole-number', 'rxp-hole-source',
    'rxp-hole-task', 'rxp-hole-title', 'rxp-live', 'rxp-match-count', 'rxp-match-list', 'rxp-new-round', 'rxp-next', 'rxp-par',
    'rxp-pattern', 'rxp-prev', 'rxp-sandbox', 'rxp-score', 'rxp-skip-count', 'rxp-skip-list', 'rxp-status',
    'rxp-strokes', 'rxp-submit', 'rxp-toast', 'rxp-warning'
  ]);
  assert.equal(ids.length, new Set(ids).size, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^rxp-/);

  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^rxp-/);
  for (const m of JS.matchAll(/'(rxp-[\w-]+)/g)) assert.match(m[1], /^rxp-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^rxp-/, selector);
    }
  }
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^rxp-/);
  const keyframes = Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);
  assert.ok(keyframes.length >= 1);
  for (const name of keyframes) assert.match(name, /^rxp-/);
  assert.deepEqual([...new Set(Array.from(JS.matchAll(/'(rxp-(?:state|best))'/g), (m) => m[1]))].sort(), [BEST_KEY, STATE_KEY]);
  assert.doesNotMatch(JS, /localStorage\.(getItem|setItem)\('(?!rxp-)/);
  for (const name of Object.keys(rxp)) assert.match(name, /^rxp[A-Z]/);
});

test('regex-par: the files embed safely, load nothing from outside, link to nothing, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  assert.deepEqual(embedSafety(rxp.rxpWorkerSource), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="rxp-wrapper"'));
  assert.deepEqual(embedSafety(embedded), []);
  const bg = CSS.match(/--rxp-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Regex Par — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(/, 'no network resources');
    assert.doesNotMatch(text, /regex\s*golf/i, 'never called Regex Golf');
  }
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts)\b/, 'no network calls');
  assert.doesNotMatch(rxp.rxpWorkerSource, /\b(fetch|XMLHttpRequest|WebSocket|importScripts)\b/);
  // No links at all; the Regex Tester is named in plain text only.
  assert.doesNotMatch(HTML, /<a\b/i);
  assert.match(embedded, /Regex Tester in the Tools section/);
});

test('regex-par: script.js is one strict IIFE in ES5, and so is the worker program', () => {
  assert.match(JS, /^(\/\/[^\n]*\r?\n)*\r?\n?\(function \(\) \{\r?\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1);
  assert.equal(JS.match(/^\}\)\(\);/gm).length, 1);
  const code = JS
    .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  const es6 = [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['Promise', /\bPromise\b|\basync\b|\bawait\b/]
  ];
  for (const [name, re] of es6.concat([['double-quoted string', /"/]])) assert.doesNotMatch(code, re, name);
  for (const [name, re] of es6) assert.doesNotMatch(rxp.rxpWorkerSource, re, 'worker: ' + name);
});

test('regex-par: index.html has a monospace pattern box that keeps its keys, labelled buttons and live regions', () => {
  const spec = htmlPageSpec(HTML);
  const box = spec['rxp-pattern'];
  assert.equal(box.tagName, 'input');
  assert.equal(box.type, 'text');
  assert.deepEqual(
    ['maxlength', 'autocomplete', 'autocapitalize', 'autocorrect', 'spellcheck', 'enterkeyhint', 'aria-describedby'].map((name) => box.attributes[name]),
    ['200', 'off', 'off', 'off', 'false', 'go', 'rxp-status']);
  assert.match(HTML, /<label class="rxp-label" for="rxp-pattern">/);
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
    }
  }
  assert.equal(spec['rxp-status'].attributes['aria-live'], 'polite');
  assert.equal(spec['rxp-toast'].attributes['aria-live'], 'polite');
  assert.equal(spec['rxp-warning'].attributes.role, 'alert');
  assert.match(spec['rxp-warning'].className, /\brxp-hidden\b/);
  assert.equal(spec['rxp-match-list'].tagName, 'ul');
  assert.equal(spec['rxp-skip-list'].tagName, 'ul');
  assert.equal(spec['rxp-chips'].attributes.role, 'group');
  assert.equal(spec['rxp-card'].attributes.role, 'group');
  assert.equal(declsAt(cssRules(CSS), '.rxp-input', 1280)['font-family'], 'var(--rxp-font-mono)');
});

test('regex-par: from 320 to 1440 px nothing widens the page: 9 or 18 card columns of at least 28 px, stacked lists, lines and messages that wrap anywhere', () => {
  const rules = cssRules(CSS);
  for (let vw = 320; vw <= 1440; vw++) {
    const wrapper = declsAt(rules, '.rxp-wrapper', vw);
    const side = px(wrapper.padding.split(/\s+/)[1]);
    const available = Math.min(vw, px(wrapper['max-width'])) - 2 * side;
    assert.equal(declsAt(rules, '.rxp-wrapper *', vw)['box-sizing'], 'border-box');
    // The scorecard: equal columns that never grow past the width.
    const card = declsAt(rules, '.rxp-card', vw);
    const columns = /^repeat\((9|18), minmax\(0, 1fr\)\)$/.exec(card['grid-template-columns']);
    assert.ok(columns, vw + 'px: ' + card['grid-template-columns']);
    assert.equal(Number(columns[1]), vw <= 640 ? 9 : 18, vw + 'px');
    const n = Number(columns[1]);
    const cellWidth = (available - (n - 1) * px(card.gap)) / n;
    assert.ok(cellWidth >= 28, vw + 'px: card cells of ' + cellWidth + 'px');
    // A score such as +12 fits its cell (0.61em a character covers the widest common monospace fonts).
    const cell = declsAt(rules, '.rxp-card-cell', vw);
    assert.ok(3 * 0.61 * rem(declsAt(rules, '.rxp-card-score', vw)['font-size']) <= cellWidth - 2, vw + 'px: +12 fits');
    assert.equal(cell['min-width'], '0');
    assert.equal(cell['overflow-wrap'], 'anywhere');
    // The lists: two columns on wide screens, one on phones, never wider than the page.
    const lists = declsAt(rules, '.rxp-lists', vw)['grid-template-columns'];
    assert.equal(lists, vw <= 640 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', vw + 'px');
    // Long lines, patterns and messages wrap instead of widening the page.
    for (const selector of ['.rxp-line', '.rxp-status', '.rxp-best-hole', '.rxp-sandbox', '.rxp-hole-task', '.rxp-toast', '.rxp-warning', '.rxp-course', '.rxp-live']) {
      assert.equal(declsAt(rules, selector, vw)['overflow-wrap'], 'anywhere', vw + 'px ' + selector);
    }
    assert.equal(declsAt(rules, '.rxp-line', vw)['white-space'], 'pre-wrap', 'runs of spaces in df lines stay');
    // The pattern box shrinks with its row and keeps a 16px font (no iOS zoom on focus).
    const input = declsAt(rules, '.rxp-input', vw);
    assert.equal(input['min-width'], '0');
    assert.ok(rem(input['font-size']) >= 16);
    // A chip fits the tee box on its own line.
    const tee = declsAt(rules, '.rxp-tee', vw);
    const teeSide = px(tee.padding.split(/\s+/)[1] || tee.padding);
    const content = available - 2 * teeSide - 2;
    assert.ok(px(declsAt(rules, '.rxp-chip', vw)['min-width']) <= content, vw + 'px chip');
    // The three hole buttons share a phone row; on wider screens they fit as they are.
    const nav = declsAt(rules, '.rxp-nav .rxp-btn', vw);
    if (vw <= 640) {
      assert.deepEqual([nav.flex, nav['min-width'], nav['white-space']], ['1 1 0', '0', 'normal'], vw + 'px');
    } else {
      const btn = declsAt(rules, '.rxp-btn', vw);
      const pad = rem(btn.padding.split(/\s+/)[1]);
      const width = ['← Prev', 'Hole out', 'Next →'].reduce((sum, label) => sum + label.length * 0.6 * rem(btn['font-size']) + 2 * pad + 2, 0) + 2 * px(declsAt(rules, '.rxp-nav', vw).gap);
      assert.ok(width <= content, vw + 'px: hole buttons of ' + width + 'px in ' + content + 'px');
    }
  }
  // Two-line button content is stacked and centred both ways.
  const cell = declsAt(rules, '.rxp-card-cell', 320);
  assert.deepEqual([cell.display, cell['flex-direction'], cell['align-items'], cell['justify-content']], ['flex', 'column', 'center', 'center']);
  // The toast takes the phone's width instead of half of it.
  const toast = declsAt(rules, '.rxp-toast', 320);
  assert.equal(toast.width, 'max-content');
  assert.equal(toast['max-width'], 'calc(100vw - 32px)');
  // touch-action: manipulation on tap targets only, and none nowhere (no play area takes gestures).
  const touch = rules.filter((rule) => rule.decls['touch-action'] !== undefined);
  assert.deepEqual(touch.map((rule) => [rule.selectors, rule.decls['touch-action']]),
    [[['.rxp-btn'], 'manipulation'], [['.rxp-card-cell'], 'manipulation'], [['.rxp-chip'], 'manipulation']]);
  // Nothing is positioned absolutely inside a grid.
  assert.deepEqual(rules.filter((rule) => rule.decls.position === 'absolute'), []);
});

// WCAG contrast of two #rgb or #rrggbb colours.
function contrast(a, b) {
  const luminance = (hex) => {
    const full = hex.length === 4 ? '#' + [...hex.slice(1)].map((c) => c + c).join('') : hex;
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('regex-par: toasts show their kind, every text that carries information keeps 4.5:1 contrast, and the chips and the count sit just above the box', (t) => {
  const rules = cssRules(CSS);
  const palette = declsAt(rules, '.rxp-wrapper', 1280);
  const colour = (value) => {
    const m = /^var\((--rxp-[\w-]+)\)$/.exec(value);
    return m ? palette[m[1]] : value;
  };
  // Toasts: green for a holed hole, red for a refusal or a miss, blue for a note; white text on each.
  const toast = declsAt(rules, '.rxp-toast', 1280);
  assert.equal(toast.color, '#fff');
  for (const [selector, background] of [['.rxp-toast', toast.background], ['.rxp-toast--error', declsAt(rules, '.rxp-toast--error', 1280).background],
    ['.rxp-toast--info', declsAt(rules, '.rxp-toast--info', 1280).background]]) {
    assert.match(background, /^#[0-9a-f]{6}$/, selector);
    assert.ok(contrast(background, '#fff') >= 4.5, selector + ': ' + contrast(background, '#fff').toFixed(2));
  }
  // Small text on the lightest panel background (#1a2236).
  for (const selector of ['.rxp-sandbox', '.rxp-sandbox--starting', '.rxp-sandbox--main', '.rxp-sandbox--worker', '.rxp-card-num', '.rxp-hole-meta',
    '.rxp-live', '.rxp-count', '.rxp-status', '.rxp-status--error', '.rxp-line']) {
    const value = colour(declsAt(rules, selector, 1280).color);
    assert.ok(contrast(value, palette['--rxp-bg-card']) >= 4.5, selector + ' ' + value + ': ' + contrast(value, palette['--rxp-bg-card']).toFixed(2));
  }
  assert.equal(declsAt(rules, '.rxp-list--pending .rxp-line', 1280).opacity, '0.55');
  // On a phone the open keyboard covers what is below the box: the chips and the short count come first.
  const tee = HTML.slice(HTML.indexOf('class="rxp-tee"'), HTML.indexOf('class="rxp-lists"'));
  const at = (id) => tee.indexOf('id="' + id + '"');
  assert.ok(at('rxp-chips') > 0 && at('rxp-chips') < at('rxp-live') && at('rxp-live') < at('rxp-pattern'), 'label, chips, count, box');
  assert.equal(declsAt(rules, '.rxp-live', 320)['min-height'], '1.5em', 'the empty count keeps its line, so the box does not jump');

  const { clock, v } = openPage(t);
  v.enter();
  assert.deepEqual([v.toast(), v.toastKind(), v.el('toast').className],
    ['Type a pattern first: every character is one stroke.', 'error', 'rxp-toast rxp-show rxp-toast--error']);
  v.play('POST');
  assert.equal(v.toastKind(), 'error');
  v.play('(');
  assert.equal(v.toastKind(), 'error');
  v.play('" 5');
  assert.deepEqual([v.toastKind(), v.el('toast').className], ['success', 'rxp-toast rxp-show']);
  clock.advance(2500);
  assert.equal(v.el('toast').className, 'rxp-toast', 'it hides');
  v.click('new-round');
  assert.equal(v.toastKind(), 'info');
  v.click('new-round');
  assert.deepEqual([v.toast(), v.toastKind()], ['Round 2: a clean card. Hole 1, par 4.', 'info']);
});

// ── The course ───────────────────────────────────────────────────────────────

test('regex-par: the course has 18 holes of real log and config lines, each line at most 60 characters, the two lists consistent', () => {
  assert.equal(HOLES.length, 18);
  assert.equal(new Set(HOLES.map((h) => h.id)).size, 18);
  assert.equal(new Set(HOLES.map((h) => h.title)).size, 18);
  for (const hole of HOLES) {
    assert.deepEqual(Object.keys(hole), ['id', 'title', 'source', 'task', 'par', 'match', 'skip'], hole.id);
    assert.ok(Number.isInteger(hole.par) && hole.par >= 3, hole.id + ' par');
    assert.ok(hole.match.length >= 3 && hole.skip.length >= 4, hole.id + ' list sizes');
    const all = linesOf(hole);
    assert.equal(new Set(all).size, all.length, hole.id + ': no line twice, and none in both lists');
    for (const line of all) {
      assert.ok(line.length >= 4 && line.length <= 60, hole.id + ': ' + line.length + ' characters: ' + line);
      assert.equal(line, line.trim(), hole.id + ': no edge spaces');
    }
    assert.ok(hole.task.startsWith('Catch '), hole.id);
  }
  assert.equal(rxp.rxpCoursePar(), COURSE_PAR);
  assert.equal(HOLES.reduce((sum, h) => sum + h.par, 0), COURSE_PAR);
  // The course is pinned: a changed line, par or order shows up here.
  assert.equal(fnv1a(JSON.stringify(HOLES)), 302650779);
  assert.deepEqual(HOLES.map((h) => h.par), [4, 6, 5, 7, 7, 7, 8, 4, 5, 9, 19, 12, 24, 22, 40, 38, 19, 28]);
});

// Every hole's task read by plain code, without a pattern: true for a line
// the task asks to catch.
const HEX = '0123456789abcdef';
const isHex = (text, length) => text.length === length && [...text].every((c) => HEX.includes(c));
const isDigits = (text) => text.length > 0 && [...text].every((c) => c >= '0' && c <= '9');
const TASKS = {
  'nginx-5xx': (line) => Math.floor(Number(line.split('" ')[1].split(' ')[0]) / 100) === 5,
  'cron-five': (line) => !line.startsWith('#') && line.split(' ')[0] === '*/5',
  'oom-kill': (line) => line.includes('Killed process '),
  'slow-requests': (line) => Number(line.split('rt=')[1]) >= 1,
  'disk-full': (line) => parseInt(line.split(/ +/)[4], 10) >= 90,
  'api-errors': (line) => {
    const [, level, , path] = line.split(' ');
    return level === 'ERROR' && path.startsWith('/api/');
  },
  'json-levels': (line) => ['error', 'fatal'].includes(JSON.parse(line).level),
  'ssh-invalid': (line) => line.toLowerCase().includes('invalid user '),
  'failed-units': (line) => line.includes(': Failed ') || line.endsWith('status=1'),
  'pinned-images': (line) => {
    const ref = line.slice('image: '.length);
    const colon = ref.lastIndexOf(':');
    if (colon < ref.lastIndexOf('/') || colon === -1) return false;
    const tag = ref.slice(colon + 1).replace(/^v/, '');
    return tag[0] >= '0' && tag[0] <= '9';
  },
  'mac-address': (line) => {
    const parts = line.split(':');
    return parts.length === 6 && parts.every((part) => isHex(part, 2));
  },
  'low-ports': (line) => {
    const fields = line.split(' ');
    const local = fields[3];
    return fields[0] === 'LISTEN' && Number(local.slice(local.lastIndexOf(':') + 1)) < 1000;
  },
  'clock-times': (line) => {
    const parts = line.split(':');
    return parts.length === 2 && parts.every((part) => part.length === 2 && isDigits(part)) &&
      Number(parts[0]) <= 23 && Number(parts[1]) <= 59;
  },
  'release-tags': (line) => {
    if (line[0] !== 'v') return false;
    const dash = line.indexOf('-');
    const core = (dash === -1 ? line.slice(1) : line.slice(1, dash)).split('.');
    const pre = dash === -1 ? null : line.slice(dash + 1);
    return core.length === 3 && core.every(isDigits) &&
      (pre === null || (pre.length > 0 && pre.split('.').every((id) => id.length > 0 && /^[0-9A-Za-z]+$/.test(id))));
  },
  'private-ipv4': (line) => {
    const octets = line.split('.');
    if (octets.length !== 4 || !octets.every((o) => isDigits(o) && Number(o) <= 255)) return false;
    const [a, b] = octets.map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  },
  'iso-dates': (line) => {
    const parts = line.split('-');
    if (parts.length !== 3 || parts[0].length !== 4 || parts[1].length !== 2 || parts[2].length !== 2 || !parts.every(isDigits)) return false;
    const [month, day] = [Number(parts[1]), Number(parts[2])];
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  },
  'commit-style': (line) => {
    const colon = line.indexOf(': ');
    if (colon === -1) return false;
    const head = line.slice(0, colon);
    const open = head.indexOf('(');
    const type = open === -1 ? head : head.slice(0, open);
    const scope = open === -1 ? null : head.slice(open + 1, -1);
    const lower = type.length > 0 && [...type].every((c) => c >= 'a' && c <= 'z');
    return lower && (scope === null || (head.endsWith(')') && scope.length > 0)) && line.length > colon + 2;
  },
  'volume-uuids': (line) => {
    const groups = line.split('-');
    return groups.length === 5 && [8, 4, 4, 4, 12].every((length, i) => isHex(groups[i], length));
  }
};

test('regex-par: every Catch line meets its hole\'s task and no Leave line does, read by plain code without a pattern', () => {
  assert.deepEqual(Object.keys(TASKS), HOLES.map((hole) => hole.id));
  for (const hole of HOLES) {
    for (const line of hole.match) assert.equal(TASKS[hole.id](line), true, hole.id + ' Catch: ' + line);
    for (const line of hole.skip) assert.equal(TASKS[hole.id](line), false, hole.id + ' Leave: ' + line);
  }
  // The readings themselves tell the lines apart: a Catch line moved to Leave would fail above.
  assert.equal(TASKS['disk-full']('/dev/sdc1  932G  836G   96G  89% /mnt/old'), false);
  assert.equal(TASKS['slow-requests']('GET / 200 upstream=10.0.0.5:8080 rt=1.000'), true);
});

test('regex-par: every hole has a solution no longer than its par, which main-thread mode also accepts', () => {
  assert.equal(REFERENCE.length, HOLES.length);
  HOLES.forEach((hole, i) => {
    const pattern = REFERENCE[i];
    assert.ok(pattern.length <= hole.par, hole.id + ': ' + pattern.length + ' > par ' + hole.par);
    assert.equal(modelSolves(pattern, hole), true, hole.id + ': ' + pattern);
    assert.equal(rxp.rxpIsRisky(pattern), null, hole.id);
    const run = rxp.rxpRunMain(pattern, linesOf(hole));
    assert.equal(run.error, null, hole.id);
    assert.deepEqual(run.spans, modelSpans(pattern, linesOf(hole)), hole.id);
    assert.deepEqual(rxp.rxpScoreHole(hole, run.spans, pattern), {
      solved: true, missed: [], extra: [], strokes: pattern.length, toPar: pattern.length - hole.par
    }, hole.id);
  });
});

test('regex-par: no pattern of one or two characters holes any hole, so every par is earned', () => {
  HOLES.forEach((hole) => {
    const alphabet = [...new Set(linesOf(hole).join('') + '\\^$.*+?()[]{}|dwsDWSb')];
    let tried = 0;
    for (const a of alphabet) {
      assert.equal(modelSolves(a, hole), false, hole.id + ': /' + a + '/');
      tried++;
      for (const b of alphabet) {
        assert.equal(modelSolves(a + b, hole), false, hole.id + ': /' + a + b + '/');
        tried++;
      }
    }
    assert.equal(tried, alphabet.length * (alphabet.length + 1));
  });
});

// ── Patterns ─────────────────────────────────────────────────────────────────

test('regex-par: rxpQuantifierAt reads *, +, ?, {n}, {n,}, {n,m} and lazy forms, and a lone { is a character', () => {
  const q = (pattern, i = 1) => rxp.rxpQuantifierAt(pattern, i);
  assert.deepEqual(q('a*'), { length: 1, min: 0, max: Infinity });
  assert.deepEqual(q('a+?'), { length: 2, min: 1, max: Infinity });
  assert.deepEqual(q('a?'), { length: 1, min: 0, max: 1 });
  assert.deepEqual(q('a{3}'), { length: 3, min: 3, max: 3 });
  assert.deepEqual(q('a{1}'), { length: 3, min: 1, max: 1 });
  assert.deepEqual(q('a{2,}?'), { length: 5, min: 2, max: Infinity });
  assert.deepEqual(q('a{0,1}'), { length: 5, min: 0, max: 1 });
  assert.deepEqual(q('a{1,12}'), { length: 6, min: 1, max: 12 });
  assert.equal(q('a{x}'), null);
  assert.equal(q('a{,3}'), null);
  assert.equal(q('ab'), null);
  assert.equal(q('a', 1), null, 'past the end');
});

// ── A backtracking matcher that counts its steps ─────────────────────────────
//
// An independent model of what rxpBacktrack bounds: a parser for the part of
// the syntax the fuzz lists use (literals, ., classes, \d \w \s, groups,
// (?: (?= (?!, |, ^ $, and * + ? {n} {n,} {n,m} with a lazy ?) and a
// backtracking matcher that follows the standard (a repeat past the minimum
// that matches nothing fails) and counts one step per atom tried, per repeat
// tried and per alternative tried.  It explores every way (the line never
// matches as a whole), as a line that almost matches makes the engine do.

function modelParse(source) {
  let i = 0;
  const alt = () => {
    const branches = [seq()];
    while (source[i] === '|') {
      i++;
      branches.push(seq());
    }
    return branches.length === 1 ? branches[0] : { kind: 'alt', branches };
  };
  const seq = () => {
    const items = [];
    while (i < source.length && source[i] !== '|' && source[i] !== ')') items.push(term());
    return { kind: 'seq', items };
  };
  const term = () => {
    const atom = single();
    const m = /^(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})\??/.exec(source.slice(i));
    if (!m) return atom;
    i += m[0].length;
    let min;
    let max;
    if (m[1]) [min, max] = { '*': [0, Infinity], '+': [1, Infinity], '?': [0, 1] }[m[1]];
    else {
      min = Number(m[2]);
      max = m[3] ? (m[4] === '' ? Infinity : Number(m[4])) : min;
    }
    return { kind: 'rep', atom, min, max };
  };
  const single = () => {
    const c = source[i];
    if (c === '(') {
      const head = /^\((\?[:=!])?/.exec(source.slice(i))[0];
      i += head.length;
      const inner = alt();
      i++;
      return head === '(?=' || head === '(?!' ? { kind: 'look', negative: head === '(?!', inner } : inner;
    }
    if (c === '^' || c === '$') {
      i++;
      return { kind: c };
    }
    let text = c;
    if (c === '\\') text = source.slice(i, i + 2);
    else if (c === '[') text = source.slice(i, source.indexOf(']', i + 1) + 1);
    i += text.length;
    return { kind: 'char', re: new RegExp('^' + text + '$') };
  };
  return alt();
}

function modelSteps(source, line) {
  const tree = modelParse(source);
  let steps = 0;
  const match = (node, pos, next) => {
    switch (node.kind) {
      case 'char':
        steps++;
        return pos < line.length && node.re.test(line[pos]) ? next(pos + 1) : false;
      case '^':
        steps++;
        return pos === 0 ? next(pos) : false;
      case '$':
        steps++;
        return pos === line.length ? next(pos) : false;
      case 'look': {
        steps++;
        const found = match(node.inner, pos, () => true);
        return found !== node.negative ? next(pos) : false;
      }
      case 'seq': {
        const from = (k, at) => (k === node.items.length ? next(at) : match(node.items[k], at, (to) => from(k + 1, to)));
        return from(0, pos);
      }
      case 'alt':
        for (const branch of node.branches) {
          steps++;
          if (match(branch, pos, next)) return true;
        }
        return false;
      default: {
        const repeat = (count, at) => {
          if (count < node.max) {
            steps++;
            if (match(node.atom, at, (to) => (count >= node.min && to === at ? false : repeat(count + 1, to)))) return true;
          }
          return count >= node.min ? next(at) : false;
        };
        return repeat(0, pos);
      }
    }
  };
  for (let start = 0; start <= line.length; start++) match(tree, start, () => false);
  return steps;
}

// Random patterns of tokens, as compiled by the engine (the rest are dropped).
function randomPatterns(seed, tokens, count, maxTokens, maxLength = 60) {
  const random = seeded(seed);
  const out = [];
  for (let k = 0; k < count; k++) {
    let pattern = '';
    const n = 1 + Math.floor(random() * maxTokens);
    for (let j = 0; j < n; j++) pattern += tokens[Math.floor(random() * tokens.length)];
    pattern = pattern.slice(0, maxLength);
    if (engineError(pattern) === null) out.push(pattern);
  }
  return out;
}

// Patterns that froze the page with the first static check, and others like
// them: bounded or optional repeats, overlapping alternatives, runs of ? or
// {0,n}, nested and empty repeats.
const FREEZERS = [
  '(.?){20}~', '(.?){25}~', '(.?){60}~', '(.|.){1,60}~', '(.|..){1,30}~', '.{0,60}'.repeat(8) + '~', '.?'.repeat(28) + '~',
  '(a+)+', '(a|a)*', '^(a+)+$', '(\\d*)*x', '(\\d+\\.){3}x', '((ab)*)+', '(?:x{1,3})+?', '(?<word>\\w+)*',
  '(?=(a+)+)', '(GET|POST)+ /', '((a|b)c){3,}', '.*.*.*.*x', '.*.*.*~', '(.*){3}~', '(.+)+~', '(.{1,3}){20}~',
  '(?:){61}', '(){99999999}', '(?:.?.?){12}~', '\\d+\\.\\d+\\.\\d+|\\d+\\.\\d+\\.\\d+', '(?:\\1){0,60}'.repeat(4)
];

const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

test('regex-par: rxpBacktrack counts exactly the steps of a backtracking matcher on a line where every atom matches, and never fewer on real lines', () => {
  // Exact: patterns of . on a line of 60 characters (every . matches, the whole line never ends the search).
  const exact = randomPatterns(11, ['.', '(', ')', '(?:', '|', '?', '*', '+', '{0,3}', '{2}', '{1,}', '{2,4}', '??'], 16000, 12);
  let compared = 0;
  for (const pattern of exact) {
    const count = rxp.rxpBacktrack(pattern);
    if (count.why) continue;
    assert.equal(count.steps, modelSteps(pattern, 'x'.repeat(60)), pattern);
    compared++;
  }
  assert.ok(compared >= 300, compared + ' patterns compared');
  // A few by hand: one step per start for ., one more per start that has a character left for .., ^ once at the start.
  for (const [pattern, steps] of [['', 0], ['.', 61], ['..', 121], ['^.', 62], ['(.|.)', 244]]) {
    assert.deepEqual(rxp.rxpBacktrack(pattern), { steps, part: null, why: null }, pattern);
  }
  for (const pattern of ['.*', '(?:){60}', '^.*.*', '(.?){5}', '.{2,9}?.+']) {
    assert.equal(rxp.rxpBacktrack(pattern).steps, modelSteps(pattern, 'x'.repeat(60)), pattern);
  }
  // An upper bound: on the course's own lines, with literals, classes, anchors and lookaheads.
  const lines = HOLES.map((hole) => hole.match[0]).concat(['', '5', 'x'.repeat(60)]);
  const loose = randomPatterns(23, ['.', 'x', '5', '0', ' ', '\\d', '\\w', '[^ ]', '[05]', '(', ')', '(?:', '(?=', '(?!', '|', '?', '*', '+',
    '{0,3}', '{2}', '{1,}', '^', '$'], 3000, 10);
  let bounded = 0;
  for (const pattern of loose) {
    const count = rxp.rxpBacktrack(pattern);
    if (count.why) continue;
    for (const line of lines) assert.ok(modelSteps(pattern, line) <= count.steps, pattern + ' on ' + JSON.stringify(line));
    bounded++;
  }
  assert.ok(bounded >= 300, bounded + ' patterns bounded');
  // Every reference solution counts far below the limit.
  for (const pattern of REFERENCE) assert.ok(rxp.rxpBacktrack(pattern).steps <= 250000, pattern);
});

test('regex-par: rxpIsRisky refuses every pattern that could take more than 1,500,000 steps a line, names the part at fault and why, and passes the rest', () => {
  const refusal = (part, why, pattern) => 'Refused in main-thread mode: "' + part + '" ' + why + '. On a line that almost matches, the ' +
    'engine could take ' + thousands(rxp.rxpBacktrack(pattern).steps) + ' steps or more to give up, and main-thread mode takes up to ' +
    '1,500,000 a line, since only a Web Worker could stop a check that runs too long.';
  const nested = 'repeats a group that holds a quantifier of its own, a nested quantifier like (a+)+';
  const alternatives = 'repeats a group that holds alternatives (|), like (a|a)*';
  const chain = 'chains quantifiers that can take the same characters, like .*.*.*.* or (.?){20}';
  const branches = 'has alternatives that together try too many ways, like .*.*.*|.*.*.*';
  const cases = [
    ['(.?){20}~', '(.?){20}', nested],
    ['(.?){60}~', '(.?){60}', nested],
    ['(.|.){1,60}~', '(.|.){1,60}', alternatives],
    ['(.|..){1,30}~', '(.|..){1,30}', alternatives],
    ['.{0,60}'.repeat(8) + '~', '.{0,60}'.repeat(4), chain],
    ['.?'.repeat(28) + '~', '.?'.repeat(14), chain],
    ['.*.*.*~', '.*.*.*~', chain],
    ['(a+)+', '(a+)+', nested],
    ['^(a+)+$', '(a+)+', nested],
    ['(a|a)*', '(a|a)*', alternatives],
    ['(GET|POST)+ /', '(GET|POST)+', alternatives],
    ['(?<word>\\w+)*', '(?<word>\\w+)*', nested],
    ['(?=(a+)+)x', '(a+)+', nested],
    ['(?i:a*)*', '(?i:a*)*', nested],
    ['(\\w)\\1+\\1+\\1+\\1+', '(\\w)\\1+\\1+\\1+', chain],
    ['(?:\\1){0,60}'.repeat(4), '(?:\\1){0,60}'.repeat(4), chain],
    ['\\d+\\.\\d+\\.\\d+|\\d+\\.\\d+\\.\\d+', '\\d+\\.\\d+\\.\\d+|\\d+\\.\\d+\\.\\d+', branches]
  ];
  for (const [pattern, part, why] of cases) assert.equal(rxp.rxpIsRisky(pattern), refusal(part, why, pattern), pattern);
  for (const pattern of FREEZERS) assert.match(rxp.rxpIsRisky(pattern), /^Refused in main-thread mode: "/, pattern);
  // A part that matches nothing, repeated more than a line is long: the engine runs every repeat.
  for (const [pattern, part] of [['(?:){61}', '(?:){61}'], ['x(){99999999}', '(){99999999}'], ['(a?){61}', '(a?){61}'], ['(?=a){61}', '(?=a){61}']]) {
    assert.equal(rxp.rxpIsRisky(pattern), 'Refused in main-thread mode: "' + part + '" repeats a part that can match nothing more than 60 ' +
      'times. The engine runs every one of those repeats, and only a Web Worker could stop it.', pattern);
    assert.deepEqual(rxp.rxpBacktrack(pattern), { steps: Infinity, part, why: 'empty' });
  }
  // Within the limit: bounded repeats of few ways, a part that matches nothing up to 60 times, repeats that run out of line.
  for (const pattern of ['([\\da-f]{2}:?){6}', '(\\d{1,3}\\.){3}\\d+', '(a|b){5}', '(a|b)?c', '\\d+\\.\\d+\\.\\d+', '.*.*x', '(?:){60}',
    'a{70}', '(?:abc){0,}', 'a+b+(d)+', '(a?)*', '(?!a*){2}','(?:ab)+', '(a{2}){3}', '[(]+[)]*', '[\\](]+', '\\(a+\\)+', 'a{x}+', '\\k<abc', '\\k<a>+',
    '(?<a>x)\\k<a>', '(.)\\1+','\\12+', '\\0123', '\\08+', '\\x41+', '\\x4+', '\\u0041*', '\\u004*', '\\cJ+', '\\c1', '\\b\\B', '(?<=a)b', '(?<!a)b',
    '(?:\\b){0,}', '^a|^b', '^a|b', '|^a', '', 'a)+', '[abc', '(?<name', '(?i', '\\']) {
    assert.equal(rxp.rxpIsRisky(pattern), null, pattern);
  }
  // Escapes of one character count as one, a back reference as any length.
  assert.equal(rxp.rxpBacktrack('\\x41').steps, rxp.rxpBacktrack('.').steps);
  assert.equal(rxp.rxpBacktrack('\\u0041\\012\\cJ').steps, rxp.rxpBacktrack('...').steps);
  assert.equal(rxp.rxpBacktrack('\\1').steps, 61);
  assert.equal(rxp.rxpBacktrack('\\k<a>').steps, 61);
  // A pattern that starts with ^ in every alternative runs from the first character only.
  assert.equal(rxp.rxpBacktrack('^.*x').steps, modelSteps('^.*x', 'x'.repeat(60)));
  assert.ok(rxp.rxpBacktrack('^.*.*.*x').steps < 1500000, 'anchored, so allowed');
  assert.ok(rxp.rxpBacktrack('^.*.*.*x|.').steps > 1500000, 'one alternative not anchored');
});

test('regex-par: every pattern main-thread mode accepts runs over all 18 holes, and over lines where every atom matches, within the time limit (in a child process killed after 120 s)', () => {
  const tokens = ['.', '.?', '.*', '.+', 'x', '5', ' ', '\\d', '\\w', '[^ ]', '(', ')', '(?:', '(?=', '|', '{0,9}', '{2,5}', '{20}', '{1,}', '?',
    '*', '+', '~', '^', '$', '\\1'];
  const accepted = REFERENCE.concat(['([\\da-f]{2}:?){6}', '(\\d{1,3}\\.){3}\\d+', '\\d+\\.\\d+\\.\\d+', '.*.*~', '(.?){10}~', '.?'.repeat(12) + '~',
    '(.|.){1,9}~', '(?:){60}~', '^.*.*.*~', '(?:.{0,9}){4}~', '\\d+5+~', '(.)\\1+~']);
  // A second set made mostly of parts that can take the same characters, so many land near the limit.
  const close = randomPatterns(41, ['.?', '.*', '.+', '.{0,9}', '.{2,5}', '(', ')', '(?:', '|', ')?', ')+', '){0,9}', '){2,5}', '~', 'x'],
    6000, 20);
  const patterns = accepted.concat(FREEZERS, randomPatterns(37, tokens, 4000, 24), close);
  const child = [
    "const rxp = require(process.argv[1]);",
    "const holes = rxp.rxpHoles.map((hole) => hole.match.concat(hole.skip));",
    "const worst = [Array.from({ length: 15 }, () => '5'.repeat(60))];",
    "const time = (pattern, sets) => { let best = Infinity; for (let run = 0; run < 2; run++) { let slowest = 0;",
    "  for (const lines of sets) { const t0 = process.hrtime.bigint(); rxp.rxpRunMain(pattern, lines); slowest = Math.max(slowest, Number(process.hrtime.bigint() - t0) / 1e6); }",
    "  best = Math.min(best, slowest); } return best; };",
    "const out = JSON.parse(require('fs').readFileSync(0, 'utf8')).map((pattern) => {",
    "  const compiled = rxp.rxpCompileSafe(pattern, true);",
    "  return compiled.re ? { pattern, holes: time(pattern, holes), worst: time(pattern, worst) } : { pattern, refused: compiled.error };",
    "});",
    "process.stdout.write(JSON.stringify(out));"
  ].join('\n');
  const run = childProcess.spawnSync(process.execPath, ['-e', child, path.join(__dirname, '..', SCRIPT)], {
    input: JSON.stringify(patterns), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024
  });
  assert.equal(run.error, undefined, 'the child finished within 120 s');
  assert.equal(run.status, 0, run.stderr);
  const results = JSON.parse(run.stdout);
  assert.equal(results.length, patterns.length);
  const byPattern = new Map(results.map((r) => [r.pattern, r]));
  for (const pattern of accepted) assert.equal(byPattern.get(pattern).refused, undefined, pattern);
  for (const pattern of FREEZERS) assert.match(byPattern.get(pattern).refused, /^Refused in main-thread mode: /, pattern);
  const ran = results.filter((r) => r.refused === undefined);
  assert.ok(ran.length >= 300, ran.length + ' patterns ran');
  assert.ok(results.length - ran.length >= 60, (results.length - ran.length) + ' patterns refused');
  for (const r of ran) {
    assert.ok(rxp.rxpBacktrack(r.pattern).steps <= 1500000, r.pattern);
    assert.ok(r.holes < 250, r.pattern + ': ' + r.holes + ' ms on a hole');
    assert.ok(r.worst < 250, r.pattern + ': ' + r.worst + ' ms on 15 lines where every atom matches');
  }
});

test('regex-par: rxpCompileSafe and rxpRunMain keep to the limits and pass on the engine\'s own error text', () => {
  const long = 'a'.repeat(61);
  assert.deepEqual(rxp.rxpCompileSafe(long, true), { re: null, error: 'The pattern is 61 characters long: main-thread mode takes up to 60.' });
  assert.equal(rxp.rxpCompileSafe(long, false).error, null);
  assert.deepEqual(rxp.rxpCompileSafe('a'.repeat(201), false), { re: null, error: 'The pattern is 201 characters long: the game takes up to 200.' });
  assert.match(engineError('('), /^Invalid regular expression: \/\(\/: Unterminated group$/);
  assert.deepEqual(rxp.rxpCompileSafe('(', false), { re: null, error: engineError('(') });
  assert.deepEqual(rxp.rxpCompileSafe('a**', true), { re: null, error: engineError('a**') });
  assert.deepEqual(rxp.rxpCompileSafe('(a+)+', true), { re: null, error: rxp.rxpIsRisky('(a+)+') });
  assert.match(rxp.rxpCompileSafe('(a+)+', true).error, /^Refused in main-thread mode: "\(a\+\)\+"/);
  const loose = rxp.rxpCompileSafe('(a+)+', false);
  assert.equal(loose.error, null, 'worker mode leaves the timeout to stop it');
  assert.equal(loose.re.source, '(a+)+');
  assert.equal(rxp.rxpCompileSafe('[ab]c', true).re.flags, '', 'no flags');

  const lines = ['abc', 'xbz', 'nothing', ''];
  assert.deepEqual(rxp.rxpRunMain('b', lines), { error: null, spans: modelSpans('b', lines) });
  assert.deepEqual(rxp.rxpRunMain('^', lines).spans, [[0, 0], [0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(rxp.rxpRunMain('[', lines), { error: engineError('['), spans: null });
  assert.deepEqual(rxp.rxpRunMain('(x|y)+', lines).spans, null);
  const tooLong = 'L'.repeat(61);
  assert.deepEqual(rxp.rxpRunMain('L', ['ok', tooLong]), {
    error: 'A test line is 61 characters long: main-thread mode tests lines up to 60 ("' + 'L'.repeat(24) + '...").',
    spans: null
  });
});

test('regex-par: the worker program compiles and runs a pattern exactly as the main thread does, and sends the engine\'s error back', () => {
  const replies = [];
  const scope = { postMessage: (data) => replies.push(structuredClone(data)), onmessage: null };
  vm.runInNewContext(rxp.rxpWorkerSource, { self: scope });
  let id = 0;
  const run = (pattern, lines) => {
    scope.onmessage({ data: { id: ++id, pattern, lines } });
    return replies[replies.length - 1];
  };
  HOLES.forEach((hole, i) => {
    const literal = hole.match[0].slice(0, 5).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const pattern of [REFERENCE[i], '\\d', '^.{20}', 'x?', literal]) {
      const reply = run(pattern, linesOf(hole));
      assert.deepEqual(reply, { id, error: null, spans: rxp.rxpRunMain(pattern, linesOf(hole)).spans }, hole.id + ' ' + pattern);
      assert.deepEqual(rxp.rxpReadReply(reply, linesOf(hole)), { error: null, spans: modelSpans(pattern, linesOf(hole)) });
    }
  });
  assert.deepEqual(run('(?<x', ['a']), { id, error: engineError('(?<x'), spans: null });
  assert.deepEqual(run('a', []), { id, error: null, spans: [] });
  const broken = run('a', null);
  assert.equal(broken.spans, null);
  assert.match(broken.error, /null/);
  // A thrown value without a message is sent as text too.
  const odd = { postMessage: (data) => replies.push(structuredClone(data)), onmessage: null };
  vm.runInNewContext(rxp.rxpWorkerSource, { self: odd, RegExp: function () { throw 'no regex here'; } });
  odd.onmessage({ data: { id: 99, pattern: 'a', lines: ['a'] } });
  assert.deepEqual(replies[replies.length - 1], { id: 99, error: 'no regex here', spans: null });
});

test('regex-par: rxpReadReply takes a worker reply only when every span fits its line', () => {
  const lines = ['abcd', 'xy'];
  const bad = { error: 'The worker sent back a reply the game cannot read. Type the pattern again.', spans: null };
  assert.deepEqual(rxp.rxpReadReply({ error: 'boom', spans: [[0, 1]] }, lines), { error: 'boom', spans: null });
  assert.deepEqual(rxp.rxpReadReply({ error: null, spans: [[1, 3], null] }, lines), { error: null, spans: [[1, 3], null] });
  assert.deepEqual(rxp.rxpReadReply({ spans: [[4, 4], [0, 2]] }, lines), { error: null, spans: [[4, 4], [0, 2]] });
  for (const spans of [undefined, 'x', [[0, 1]], [[0, 1], null, null], [[0, 1], 'x'], [[0, 1], [0]], [[0, 1], [0, 1, 2]],
    [[0.5, 1], null], [[0, '1'], null], [[-1, 1], null], [[2, 1], null], [[0, 5], null], [null, [0, 3]]]) {
    assert.deepEqual(rxp.rxpReadReply({ error: null, spans }, lines), bad, JSON.stringify(spans));
  }
});

test('regex-par: rxpScoreHole, the score names, strokes to par and the course total follow golf', () => {
  const hole = HOLES[0];
  const lines = linesOf(hole);
  for (const pattern of ['" 5', '5\\d\\d', ' 50', 'POST', '" 5\\d\\d ']) {
    const spans = modelSpans(pattern, lines);
    const missed = hole.match.filter((line) => line.search(new RegExp(pattern)) === -1);
    const extra = hole.skip.filter((line) => line.search(new RegExp(pattern)) !== -1);
    assert.deepEqual(rxp.rxpScoreHole(hole, spans, pattern), {
      solved: missed.length === 0 && extra.length === 0, missed, extra, strokes: pattern.length, toPar: pattern.length - 4
    }, pattern);
  }
  for (let n = -6; n <= 8; n++) {
    assert.equal(rxp.rxpScoreName(n), nameOf(n), String(n));
    assert.equal(rxp.rxpFormatToPar(n), toPar(n));
  }
  assert.equal(rxp.rxpScoreName(-4), '-4 under par');
  assert.equal(rxp.rxpScoreName(4), '4 over par');
  const empty = HOLES.map(() => null);
  assert.deepEqual(rxp.rxpCourseTotal(empty), { holed: 0, strokes: 0, par: 0, toPar: 0, complete: false });
  const some = cardWith(0, 3);
  assert.deepEqual(rxp.rxpCourseTotal(some), { holed: 3, strokes: 12, par: 15, toPar: -3, complete: false });
  const full = HOLES.map((h, i) => h.par + (i % 3) - 1);
  assert.deepEqual(rxp.rxpCourseTotal(full), { holed: 18, strokes: COURSE_PAR, par: COURSE_PAR, toPar: 0, complete: true });
});

// ── Saves (pure) ─────────────────────────────────────────────────────────────

test('regex-par: rxpParseState reads the first version\'s save field for field, and every field falls back on its own', () => {
  const sample = rxp.rxpParseState(SAMPLE_STATE);
  assert.deepEqual(sample, {
    hole: 2,
    round: 3,
    drafts: ['" 5', '^\\*/5 ', 'Kil'].concat(new Array(15).fill('')),
    card: [3, 6].concat(new Array(16).fill(null))
  });
  const fresh = { hole: 0, round: 1, drafts: new Array(18).fill(''), card: new Array(18).fill(null) };
  for (const text of [null, '', '{', '[]', '"x"', '42', 'null', '{}']) assert.deepEqual(rxp.rxpParseState(text), fresh, String(text));
  const raw = JSON.parse(SAMPLE_STATE);
  const field = (patch) => rxp.rxpParseState(JSON.stringify(Object.assign({}, raw, patch)));
  for (const hole of [-1, 18, 1.5, '2', null]) assert.equal(field({ hole }).hole, 0, String(hole));
  assert.equal(field({ hole: 17 }).hole, 17);
  for (const round of [0, -3, 2.5, '3', null]) assert.equal(field({ round }).round, 1, String(round));
  assert.equal(field({ round: 99 }).round, 99);
  // Entry by entry: a bad draft or card entry falls back alone, a short list keeps its entries.
  const drafts = field({ drafts: ['ok', 7, null, 'x'.repeat(201), 'x'.repeat(200)] }).drafts;
  assert.deepEqual(drafts.slice(0, 6), ['ok', '', '', '', 'x'.repeat(200), '']);
  assert.equal(drafts.length, 18);
  assert.deepEqual(field({ drafts: 'abc' }).drafts, new Array(18).fill(''));
  const card = field({ card: [5, 0, -1, 2.5, '4', 201, 200, null] }).card;
  assert.deepEqual(card.slice(0, 9), [5, null, null, null, null, null, 200, null, null]);
  assert.deepEqual(field({ card: { 0: 4 } }).card, new Array(18).fill(null));
  // Longer lists are cut to the course.
  assert.equal(field({ drafts: new Array(30).fill('a') }).drafts.length, 18);
});

test('regex-par: rxpParseBest keeps a pattern only when its strokes match it, and a whole round total', () => {
  const sample = rxp.rxpParseBest(SAMPLE_BEST);
  assert.deepEqual(sample, { holes: [{ pattern: '" 5', strokes: 3 }].concat(new Array(17).fill(null)), course: 270 });
  const fresh = { holes: new Array(18).fill(null), course: null };
  for (const text of [null, '{', '[1]', 'true', '{}']) assert.deepEqual(rxp.rxpParseBest(text), fresh, String(text));
  const raw = JSON.parse(SAMPLE_BEST);
  const holeOf = (entry) => rxp.rxpParseBest(JSON.stringify(Object.assign({}, raw, { holes: [entry] }))).holes[0];
  assert.deepEqual(holeOf({ pattern: 'abc', strokes: 3, extra: 1 }), { pattern: 'abc', strokes: 3 });
  for (const entry of [{ pattern: 'abc', strokes: 4 }, { pattern: '', strokes: 0 }, { pattern: 7, strokes: 1 }, { strokes: 3 },
    { pattern: 'x'.repeat(201), strokes: 201 }, ['abc', 3], 'abc', null, { pattern: 'abc', strokes: '3' }]) {
    assert.equal(holeOf(entry), null, JSON.stringify(entry));
  }
  assert.deepEqual(rxp.rxpParseBest(JSON.stringify({ holes: 'x', course: 18 })), { holes: new Array(18).fill(null), course: 18 });
  for (const course of [17, 0, 270.5, '270', null, -1]) {
    assert.equal(rxp.rxpParseBest(JSON.stringify(Object.assign({}, raw, { course }))).course, null, String(course));
  }
  assert.equal(rxp.rxpParseBest(JSON.stringify(Object.assign({}, raw, { holes: null }))).course, 270, 'the total stands on its own');
});

test('regex-par: two tabs\' saves merge: a newer round wins, a holed hole stays on the card, and the shorter best always stays', () => {
  const s = (round, card, drafts, hole = 0) => ({ hole, round, card: HOLES.map((h, i) => (card[i] === undefined ? null : card[i])), drafts: HOLES.map((h, i) => drafts[i] || '') });
  const ours = s(2, [3, null, 5], ['a', 'b', 'c'], 1);
  // Same round: our card entries first, the stored ones fill the gaps; the stored drafts, but ours for the kept hole.
  const stored = s(2, [4, 6, null, 9], ['A', 'B', 'C', 'D'], 7);
  assert.deepEqual(rxp.rxpMergeState(stored, ours, 1), s(2, [3, 6, 5, 9], ['A', 'b', 'C', 'D'], 1));
  assert.deepEqual(rxp.rxpMergeState(stored, ours, null), s(2, [3, 6, 5, 9], ['A', 'B', 'C', 'D'], 1));
  // A newer stored round replaces ours as a whole (but the kept draft and our hole).
  const newer = s(3, [7], ['N'], 4);
  assert.deepEqual(rxp.rxpMergeState(newer, ours, 1), s(3, [7], ['N', 'b'], 1));
  assert.deepEqual(rxp.rxpMergeState(newer, ours, null), s(3, [7], ['N'], 1));
  // An older stored round loses as a whole.
  const older = s(1, [1, 1, 1, 1], ['o', 'o', 'o', 'o'], 9);
  assert.deepEqual(rxp.rxpMergeState(older, ours, 2), ours);

  const b = (holes, course) => ({ holes: HOLES.map((h, i) => (holes[i] ? { pattern: holes[i], strokes: holes[i].length } : null)), course });
  const mine = b(['abc', null, 'xyz', 'pq'], null);
  const theirs = b(['ab', 'qq', 'longer', 'rs'], 270);
  assert.deepEqual(rxp.rxpMergeBest(mine, theirs), b(['ab', 'qq', 'xyz', 'pq'], 270));
  assert.deepEqual(rxp.rxpMergeBest(theirs, mine), b(['ab', 'qq', 'xyz', 'rs'], 270), 'a tie keeps the first');
  assert.equal(rxp.rxpMergeBest(b([], 260), b([], 270)).course, 260);
  assert.equal(rxp.rxpMergeBest(b([], 280), b([], 270)).course, 270);
  assert.equal(rxp.rxpMergeBest(b([], 280), b([], null)).course, 280);
});

// ── The page ─────────────────────────────────────────────────────────────────

test('regex-par: loading the script under Node runs no init: no lookup, listener, worker, timer or save', (t) => {
  const w = installWorker(t);
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.rxpInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['rxp-card'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(w.created.length, 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('regex-par: a first visit shows hole 1, the 18-hole card, the chips and the neutral lists, says the sandbox mode and writes nothing', (t) => {
  const { v } = openPage(t);
  const hole = HOLES[0];
  assert.equal(v.text('hole-number'), 'Hole 1 of 18');
  assert.equal(v.text('hole-title'), 'Five hundreds');
  assert.equal(v.text('hole-source'), 'nginx access.log');
  assert.equal(v.text('hole-task'), hole.task);
  assert.equal(v.text('par'), 'Par 4');
  assert.equal(v.text('strokes'), '0 strokes');
  assert.equal(v.text('score'), '');
  assert.equal(v.text('best-hole'), 'Best: --');
  assert.equal(v.input.value, '');
  assert.deepEqual(v.lines(), neutralLines(hole));
  assert.equal(v.text('match-count'), '4 lines');
  assert.equal(v.text('skip-count'), '5 lines');
  assert.equal(v.text('status'), 'Type a pattern: it has to catch every line under Catch and none under Leave. Every character is a stroke.');
  assert.equal(v.el('status').className, 'rxp-status');
  assert.deepEqual([v.text('live'), v.el('live').className], ['', 'rxp-live'], 'no count before a pattern');
  // Without a Worker constructor (as here) the main thread runs the patterns, and says so.
  assert.equal(v.text('sandbox'), 'Sandbox: main thread, because the Web Worker is unavailable (this browser has no Web Worker). ' +
    'Patterns up to 60 characters; one that could take more than 1,500,000 steps on a line, such as (a+)+, (a|a)* or (.?){20}, is refused before it runs.');
  assert.equal(v.el('sandbox').className, 'rxp-sandbox rxp-sandbox--main');
  assert.equal(v.cells().length, 18);
  v.cells().forEach((cell, i) => {
    assert.equal(cell.tagName, 'BUTTON');
    assert.equal(cell.getAttribute('type'), 'button');
    assert.equal(cell.className, 'rxp-card-cell' + (i === 0 ? ' rxp-card-cell--current' : ''));
    assert.deepEqual(cell.children.map((el) => [el.className, el.textContent]), [['rxp-card-num', String(i + 1)], ['rxp-card-score', '·']]);
    assert.equal(cell.getAttribute('aria-label'), 'Hole ' + (i + 1) + ', par ' + HOLES[i].par + ': not holed');
    assert.equal(cell.getAttribute('aria-current'), i === 0 ? 'step' : null);
  });
  assert.deepEqual(v.chips().map((chip) => chip.textContent), ['\\d', '\\w', '.', '*', '+', '?', '[]', '()', '|', '^', '$', '{}']);
  for (const chip of v.chips()) {
    assert.equal(chip.className, 'rxp-chip');
    assert.equal(chip.getAttribute('type'), 'button');
    assert.equal(chip.getAttribute('aria-label'), 'Insert ' + chip.textContent);
  }
  assert.equal(v.el('prev').disabled, true);
  assert.equal(v.el('next').disabled, false);
  assert.equal(v.text('course'), 'Round 1: no hole holed yet. Course par 264.');
  assert.equal(v.text('best-course'), 'Best round: --');
  assert.equal(v.hidden('warning'), true);
  assert.equal(v.toast(), null);
  assert.deepEqual(storedKeys(), [], 'nothing is written before the player does something');
  // One listener per control; the pattern box is the only place keys are read.
  for (const [name, type] of [['pattern', 'input'], ['pattern', 'keydown'], ['chips', 'mousedown'], ['chips', 'click'], ['card', 'click'],
    ['prev', 'click'], ['next', 'click'], ['submit', 'click'], ['new-round', 'click']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(document), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(window), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  assert.equal(listenerCount(document.body), 0);
  for (const target of [document, window, document.body, v.page.root]) assert.equal(listenerCount(target, 'keydown'), 0);
});

test('regex-par: while the page is still loading the game waits for DOMContentLoaded', (t) => {
  const { v } = openPage(t, { storage: { state: SAMPLE_STATE }, options: { readyState: 'loading' } });
  assert.equal(v.cells().length, 0);
  assert.equal(v.text('status'), 'Loading the course...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(v.input, 'input'), 0);
  v.ready();
  assert.equal(v.cells().length, 18);
  assert.equal(v.text('hole-number'), 'Hole 3 of 18');
  assert.equal(v.input.value, 'Kil');
  assert.equal(listenerCount(v.input, 'input'), 1);
});

test('regex-par: init runs once: a second call binds and builds nothing twice', (t) => {
  makeClock(t);
  const { exports: fresh, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  fresh.rxpInit();
  fresh.rxpInit();
  assert.equal(els['rxp-card'].children.length, 18);
  assert.equal(els['rxp-chips'].children.length, 12);
  assert.equal(listenerCount(els['rxp-pattern'], 'input'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  assert.equal(fresh.rxpRuntime.els.pattern, els['rxp-pattern']);
});

test('regex-par: every line is coloured while typing, the match is marked, the strokes count and the draft is saved', (t) => {
  const { v } = openPage(t);
  const hole = HOLES[0];
  v.type('5\\d\\d');
  assert.deepEqual(v.lines(), expectedLines(hole, '5\\d\\d'));
  assert.equal(v.lines()[4].cls, 'rxp-line rxp-line--bad', 'the 200 with 5021 bytes is caught by mistake');
  assert.equal(v.lines()[4].hit, '502');
  assert.equal(v.text('match-count'), '4 of 4 caught');
  assert.equal(v.text('skip-count'), '3 of 5 left alone');
  assert.equal(v.text('status'), 'Caught 4 of 4 lines to catch; 2 of 5 lines to leave are caught too.');
  assert.equal(v.text('strokes'), '5 strokes');
  assert.equal(v.text('score'), '+1 bogey');
  assert.equal(v.state().drafts[0], '5\\d\\d');
  v.type('POST');
  assert.equal(v.text('status'), 'Caught 1 of 4 lines to catch.');
  assert.equal(v.text('match-count'), '1 of 4 caught');
  v.type('" 5');
  assert.deepEqual(v.lines(), expectedLines(hole, '" 5'));
  assert.equal(v.text('status'), 'All 9 lines pass in 3 strokes (-1, birdie). Press Enter or Hole out to score it.');
  assert.equal(v.el('status').className, 'rxp-status rxp-status--solved');
  assert.equal(v.text('score'), '-1 birdie');
  // A match of no characters still shows where it is.
  v.type('^');
  assert.ok(v.lines().every((line) => line.empty && line.hit === '' && line.before === ''));
  assert.deepEqual(v.lines(), expectedLines(hole, '^'));
  v.type('');
  assert.deepEqual(v.lines(), neutralLines(hole));
  assert.equal(v.text('strokes'), '0 strokes');
  assert.equal(v.text('score'), '');
  assert.equal(v.state().drafts[0], '');
});

test('regex-par: an invalid pattern shows the engine\'s error, leaves the lines neutral and never breaks the game', (t) => {
  const { v } = openPage(t);
  for (const pattern of ['(', 'a**', '[z-a]', '\\', '(?<1>x)']) {
    const error = engineError(pattern);
    assert.match(error, /^Invalid regular expression: /);
    v.type(pattern);
    assert.equal(v.text('status'), error, pattern);
    assert.equal(v.el('status').className, 'rxp-status rxp-status--error');
    assert.deepEqual(v.lines(), neutralLines(HOLES[0]));
    assert.equal(v.text('match-count'), '4 lines');
    v.enter();
    assert.equal(v.toast(), 'Not holed: ' + error);
  }
  v.type('" 5');
  assert.equal(v.el('status').className, 'rxp-status rxp-status--solved');
});

test('regex-par: main-thread mode refuses nested quantifiers, runs of optional parts and patterns over 60 characters while typing, naming them', (t) => {
  const { v } = openPage(t);
  v.type('(\\d+)+');
  assert.equal(v.text('status'), rxp.rxpIsRisky('(\\d+)+'));
  assert.match(v.text('status'), /^Refused in main-thread mode: "\(\\d\+\)\+" repeats a group that holds a quantifier of its own/);
  assert.equal(v.el('status').className, 'rxp-status rxp-status--error');
  assert.deepEqual(v.lines(), neutralLines(HOLES[0]));
  assert.equal(v.text('live'), 'error: see below');
  v.type('(GET|PUT)*');
  assert.match(v.text('status'), /^Refused in main-thread mode: "\(GET\|PUT\)\*" repeats a group that holds alternatives/);
  // The patterns that froze the page with the first check: refused as the last character goes in, before anything runs.
  const exec = t.mock.method(RegExp.prototype, 'exec');
  const freezers = ['(.?){20}~', '(.|.){1,60}~', '.?'.repeat(28) + '~', '.*.*.*.*5', '(?:){99999}'];
  for (const pattern of freezers) {
    v.type(pattern);
    assert.match(v.text('status'), /^Refused in main-thread mode: "/, pattern);
  }
  assert.equal(exec.mock.calls.filter((call) => freezers.includes(call.this.source)).length, 0, 'none of them ran');
  assert.ok(exec.mock.calls.length > 0, 'the check itself reads the pattern');
  exec.mock.restore();
  v.type('"'.repeat(61));
  assert.equal(v.text('status'), 'The pattern is 61 characters long: main-thread mode takes up to 60.');
  v.type('^(\\d{1,3}\\.){3}\\d+ .*" 5');
  assert.equal(v.el('status').className, 'rxp-status rxp-status--solved', 'a bounded repeat of few ways is fine');
  assert.equal(v.text('live'), '4/4 caught, 0/5 wrong');
  assert.equal(v.el('live').className, 'rxp-live rxp-live--solved');
});

test('regex-par: Enter holes out: the card, the hole\'s best, the toast; later the card stays and only a shorter pattern sets a best', (t) => {
  const { v } = openPage(t);
  v.type('" 5\\d');
  const ev = v.enter();
  assert.equal(ev.defaultPrevented, true);
  assert.equal(v.toast(), 'Hole 1 holed in 5 strokes: bogey (+1). New best for this hole.');
  assert.equal(v.score(0), '+1');
  assert.equal(v.cell(0).className, 'rxp-card-cell rxp-card-cell--over rxp-card-cell--current');
  assert.equal(v.cell(0).getAttribute('aria-label'), 'Hole 1, par 4: 5 strokes, +1');
  assert.equal(v.text('best-hole'), 'Best: /" 5\\d/ in 5 strokes (+1, bogey)');
  assert.equal(v.text('course'), 'Round 1: 1 of 18 holed, 5 strokes (+1).');
  assert.equal(v.text('status'), 'All 9 lines pass in 5 strokes (+1, bogey). On this round\'s card with 5 strokes; holing out again can still set a best.');
  assert.deepEqual(v.state().card.slice(0, 2), [5, null]);
  assert.deepEqual(v.best().holes[0], { pattern: '" 5\\d', strokes: 5 });
  // A longer pattern: on the card already, no best.
  v.play('" 5\\d\\d');
  assert.equal(v.toast(), 'Hole 1 is already on this round\'s card with 5 strokes.');
  assert.deepEqual(v.best().holes[0], { pattern: '" 5\\d', strokes: 5 });
  // A shorter one: a new best, the card stays.
  v.play('" 5');
  assert.equal(v.toast(), 'Hole 1 is already on this round\'s card with 5 strokes. New best: 3 strokes.');
  assert.equal(v.score(0), '+1');
  assert.equal(v.text('best-hole'), 'Best: /" 5/ in 3 strokes (-1, birdie)');
  assert.deepEqual(v.best(), { v: 1, holes: [{ pattern: '" 5', strokes: 3 }].concat(new Array(17).fill(null)), course: null });
  // The Hole out button does the same as Enter.
  v.click('next');
  v.type(REFERENCE[1]);
  v.click('submit');
  assert.equal(v.toast(), 'Hole 2 holed in 5 strokes: birdie (-1). New best for this hole.');
  assert.equal(v.cell(1).className, 'rxp-card-cell rxp-card-cell--under rxp-card-cell--current');
  v.click('next');
  v.play('Kille');
  assert.equal(v.toast(), 'Hole 3 holed in 5 strokes: par (E). New best for this hole.');
  assert.equal(v.cell(2).className, 'rxp-card-cell rxp-card-cell--par rxp-card-cell--current');
  assert.equal(v.score(2), 'E');
  assert.equal(v.text('course'), 'Round 1: 3 of 18 holed, 15 strokes (E).');
});

test('regex-par: a pattern that is not holed is refused with the first line at fault, and an empty box asks for a pattern', (t) => {
  const { v } = openPage(t);
  v.enter();
  assert.equal(v.toast(), 'Type a pattern first: every character is one stroke.');
  v.play('POST');
  assert.equal(v.toast(), 'Not holed: /POST/ misses "' + HOLES[0].match[0] + '" and 2 more to catch.');
  v.play('5\\d\\d');
  assert.equal(v.toast(), 'Not holed: /5\\d\\d/ also catches "' + HOLES[0].skip[0] + '" and 1 more to leave.');
  v.play('" 50[0-3]');
  assert.equal(v.toast(), 'Not holed: /" 50[0-3]/ misses "' + HOLES[0].match[3] + '".');
  v.play('"|2 5');
  assert.equal(v.toast(), 'Not holed: /"|2 5/ also catches "' + HOLES[0].skip[0] + '" and 4 more to leave.');
  v.play('" 5|5021');
  assert.equal(v.toast(), 'Not holed: /" 5|5021/ also catches "' + HOLES[0].skip[0] + '".');
  assert.equal(v.score(0), '·');
  assert.equal(localStorage.getItem(BEST_KEY), null);
});

test('regex-par: the pattern box owns its keys: only a plain Enter there holes out, and keys elsewhere on the page are never taken', (t) => {
  const { v } = openPage(t);
  v.type('" 5');
  for (const props of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    const ev = v.enter(props);
    assert.equal(ev.defaultPrevented, false, JSON.stringify(props));
    assert.equal(v.toast(), null, JSON.stringify(props));
  }
  // A key another listener already handled is left alone.
  const handled = createEvent('keydown', { key: 'Enter' });
  handled.preventDefault();
  v.input.dispatchEvent(handled);
  assert.equal(v.toast(), null);
  // A held Enter keeps the default prevented but holes out only once.
  const held = v.enter({ repeat: true });
  assert.equal(held.defaultPrevented, true);
  assert.equal(v.toast(), null);
  for (const key of ['a', 'ArrowLeft', 'Backspace', ' ', 'Home', 'Tab', 'Escape']) {
    assert.equal(pressKey(key, { target: v.input }).defaultPrevented, false, key);
  }
  // Keys typed on the host page: its field, the body, a button.
  const field = document.createElement('input');
  document.body.appendChild(field);
  for (const target of [field, document.body, v.el('next')]) {
    assert.equal(pressKey('Enter', { target }).defaultPrevented, false);
  }
  assert.equal(v.text('hole-number'), 'Hole 2 of 18', 'Enter on the focused Next button is the button\'s own click');
  assert.equal(v.score(0), '·', 'nothing was holed');
  v.click('prev');
  const ev = v.enter({ shiftKey: true });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(v.toast(), 'Hole 1 holed in 3 strokes: birdie (-1). New best for this hole.');
});

test('regex-par: Prev, Next and the card move between holes, each hole keeps its draft, and the ends stay put', (t) => {
  const { v } = openPage(t);
  v.type('" 5');
  v.click('next');
  assert.equal(v.text('hole-number'), 'Hole 2 of 18');
  assert.equal(v.text('hole-title'), 'Every five minutes');
  assert.equal(v.input.value, '');
  assert.deepEqual(v.lines(), neutralLines(HOLES[1]));
  assert.equal(v.state().hole, 1);
  assert.equal(v.cell(1).getAttribute('aria-current'), 'step');
  assert.equal(v.cell(0).getAttribute('aria-current'), null);
  v.type('^\\*');
  v.click('prev');
  assert.equal(v.input.value, '" 5');
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '" 5'), 'the draft is checked again');
  assert.equal(v.el('prev').disabled, true);
  fire(v.el('prev'), 'click');
  assert.equal(v.text('hole-number'), 'Hole 1 of 18', 'nothing before hole 1');
  // A tap on the number or score inside a card cell picks that hole.
  v.cell(17).children[0].click();
  assert.equal(v.text('hole-number'), 'Hole 18 of 18');
  assert.equal(v.text('par'), 'Par 28');
  assert.equal(v.el('next').disabled, true);
  fire(v.el('next'), 'click');
  assert.equal(v.text('hole-number'), 'Hole 18 of 18', 'nothing after hole 18');
  const saved = localStorage.getItem(STATE_KEY);
  v.cell(17).click();
  fire(v.el('card'), 'click');
  assert.equal(localStorage.getItem(STATE_KEY), saved, 'the current hole or the gaps between cells change nothing');
  v.cell(1).children[1].click();
  assert.equal(v.input.value, '^\\*');
  assert.deepEqual(v.state().drafts.slice(0, 3), ['" 5', '^\\*', '']);
});

test('regex-par: the chips insert their token at the caret, over a selection, and keep the focus in the pattern box', (t) => {
  const { v } = openPage(t);
  const input = v.input;
  // A field without a selection API: the token goes to the end.
  v.chip('\\d').click();
  assert.equal(input.value, '\\d');
  assert.equal(document.activeElement, input);
  assert.equal(v.state().drafts[0], '\\d');
  assert.equal(v.text('strokes'), '2 strokes');
  // With a caret and a selection, as in a browser.
  const caret = [];
  input.setSelectionRange = (start, end) => caret.push([start, end]);
  input.value = '" 9';
  input.selectionStart = 2;
  input.selectionEnd = 3;
  v.chip('[]').click();
  assert.equal(input.value, '" []');
  assert.deepEqual(caret, [[3, 3]], 'the caret goes inside the brackets');
  input.selectionStart = 3;
  input.selectionEnd = undefined;
  v.chip('{}').click();
  assert.equal(input.value, '" [{}]');
  assert.deepEqual(caret[1], [4, 4]);
  input.selectionStart = 0;
  input.selectionEnd = 0;
  v.chip('^').click();
  assert.equal(input.value, '^" [{}]');
  assert.equal(v.text('status'), 'Caught 0 of 4 lines to catch.', 'the inserted pattern is checked at once');
  assert.equal(v.state().drafts[0], '^" [{}]');
  // A press on a chip keeps the focus (and the phone keyboard) on the box; elsewhere in the row nothing is blocked.
  assert.equal(fire(v.chip('*'), 'mousedown').defaultPrevented, true);
  assert.equal(fire(v.el('chips'), 'mousedown').defaultPrevented, false);
  const before = input.value;
  fire(v.el('chips'), 'click');
  assert.equal(input.value, before, 'a click between chips inserts nothing');
  // Every chip inserts exactly its own text.
  for (const chip of v.chips()) {
    input.value = '';
    input.selectionStart = 0;
    input.selectionEnd = 0;
    chip.click();
    assert.equal(input.value, chip.textContent);
  }
});

test('regex-par: a chip types with the browser\'s insertText command so undo takes it back, falls back to setRangeText, and never types outside the box', (t) => {
  const { v } = openPage(t);
  const input = v.input;
  v.type('" 5');
  input.selectionStart = 3;
  input.selectionEnd = 3;
  // insertText edits the focused field and fires its input event, as a browser does.
  const commands = [];
  document.execCommand = (command, ui, text) => {
    commands.push([command, ui, text, document.activeElement === input]);
    const value = input.value;
    input.value = value.slice(0, input.selectionStart) + text + value.slice(input.selectionEnd);
    fire(input, 'input');
    return true;
  };
  const page = document;
  const harnessCommand = page.execCommand;
  t.after(() => { page.execCommand = harnessCommand; });
  const ranges = [];
  input.setRangeText = (text, start, end, mode) => {
    ranges.push([text, start, end, mode]);
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
  };
  const writes = t.mock.method(localStorage, 'setItem');
  v.chip('\\d').click();
  assert.deepEqual(commands, [['insertText', false, '\\d', true]]);
  assert.deepEqual(ranges, [], 'the command did the insert');
  assert.equal(input.value, '" 5\\d');
  assert.equal(v.state().drafts[0], '" 5\\d');
  assert.equal(writes.mock.callCount(), 1, 'the input event is handled once');
  assert.equal(v.text('strokes'), '5 strokes');
  // A browser where the command does nothing: setRangeText, then the input is handled here.
  document.execCommand = () => false;
  input.selectionStart = 0;
  input.selectionEnd = 0;
  v.chip('^').click();
  assert.deepEqual(ranges, [['^', 0, 0, 'end']]);
  assert.equal(v.state().drafts[0], '^" 5\\d');
  // The box did not get the focus (the host page kept it): no command, which would type into the host's field.
  const field = document.createElement('input');
  document.body.appendChild(field);
  const realFocus = input.focus;
  input.focus = () => {};
  focusElement(field);
  const used = [];
  document.execCommand = (command) => used.push(command);
  input.selectionStart = 6;
  input.selectionEnd = 6;
  v.chip('$').click();
  input.focus = realFocus;
  assert.deepEqual(used, []);
  assert.equal(field.value || '', '');
  assert.deepEqual(ranges[1], ['$', 6, 6, 'end']);
  assert.equal(v.state().drafts[0], '^" 5\\d$');
  // A chip over a selection of the same text changes nothing and saves nothing.
  const count = writes.mock.callCount();
  input.selectionStart = 6;
  input.selectionEnd = 7;
  v.chip('$').click();
  assert.equal(input.value, '^" 5\\d$');
  assert.equal(writes.mock.callCount(), count);
});

test('regex-par: a chip never takes the pattern past the box\'s 200 characters, so a reload keeps the whole draft', (t) => {
  const { clock, v } = openPage(t);
  const input = v.input;
  const long = '"'.repeat(199);
  v.type(long);
  input.selectionStart = 199;
  input.selectionEnd = 199;
  v.chip('\\d').click();
  assert.equal(input.value, long, 'nothing inserted');
  assert.equal(v.toast(), 'Not inserted: \\d would make the pattern 201 characters long, and the box takes up to 200.');
  assert.equal(v.toastKind(), 'error');
  assert.equal(v.state().drafts[0], long);
  // Over a selection the token takes the selected text's place, so it fits.
  input.selectionStart = 0;
  input.selectionEnd = 2;
  v.chip('\\w').click();
  assert.equal(input.value, '\\w' + '"'.repeat(197));
  input.selectionStart = 199;
  input.selectionEnd = 199;
  v.chip('.').click();
  assert.equal(input.value.length, 200);
  const again = reload(clock, v);
  assert.equal(again.input.value, '\\w' + '"'.repeat(197) + '.', 'a draft of 200 characters survives a reload');
});

test('regex-par: a full round with the reference solutions completes the card and records the best round; a worse one does not', (t) => {
  const { clock, v } = openPage(t);
  HOLES.forEach((hole, i) => {
    v.play(REFERENCE[i]);
    if (i < 17) {
      assert.match(v.toast(), new RegExp('^Hole ' + (i + 1) + ' holed in '), hole.id);
      v.click('next');
    }
  });
  const strokes = REFERENCE.reduce((sum, p) => sum + p.length, 0);
  assert.equal(strokes, 251);
  assert.equal(v.toast(), 'Hole 18 holed in 25 strokes: albatross (-3). New best for this hole. Round 1 complete: 251 strokes (-13), your best round.');
  assert.equal(v.text('course'), 'Round 1 complete: 251 strokes (-13, par 264).');
  assert.equal(v.text('best-course'), 'Best round: 251 strokes (-13)');
  assert.equal(v.best().course, 251);
  assert.deepEqual(v.best().holes.map((entry) => entry.pattern), REFERENCE);
  // A second round played one stroke worse on hole 1 is complete but no best.
  clock.advance(3000);
  v.click('new-round');
  v.click('new-round');
  HOLES.forEach((hole, i) => {
    v.play(i === 0 ? '" 5\\d' : REFERENCE[i]);
    if (i < 17) v.click('next');
  });
  assert.equal(v.toast(), 'Hole 18 holed in 25 strokes: albatross (-3). Round 2 complete: 253 strokes (-11).');
  assert.equal(v.best().course, 251);
  assert.equal(v.text('best-course'), 'Best round: 251 strokes (-13)');
});

test('regex-par: New round asks for a second press within 4 s, then clears the card and the drafts and keeps the bests', (t) => {
  const { clock, v } = openPage(t, { storage: { state: SAMPLE_STATE, best: SAMPLE_BEST } });
  assert.equal(v.text('best-course'), 'Best round: 270 strokes (+6)');
  v.click('new-round');
  assert.equal(v.toast(), 'Press New round again within 4 s to clear round 3: 2 holes on the card, 3 drafts. Your bests stay.');
  assert.equal(v.text('new-round'), 'Confirm new round');
  assert.equal(v.el('new-round').getAttribute('aria-label'), 'Press again to clear this round\'s card and drafts');
  clock.advance(4000);
  assert.equal(v.text('new-round'), 'New round', 'the second press has to come within 4 s');
  assert.equal(v.el('new-round').getAttribute('aria-label'), 'Start a new round with a clean card');
  v.click('new-round');
  clock.advance(3999);
  v.click('new-round');
  assert.equal(v.toast(), 'Round 4: a clean card. Hole 1, par 4.');
  assert.equal(v.text('new-round'), 'New round');
  assert.equal(v.text('hole-number'), 'Hole 1 of 18');
  assert.equal(v.input.value, '');
  assert.deepEqual(v.state(), stateSave({ round: 4 }));
  assert.equal(v.text('course'), 'Round 4: no hole holed yet. Course par 264.');
  assert.equal(v.text('best-hole'), 'Best: /" 5/ in 3 strokes (-1, birdie)');
  assert.equal(localStorage.getItem(BEST_KEY), SAMPLE_BEST, 'the bests stay as they were');
  clock.advance(10000);
  assert.equal(v.text('new-round'), 'New round', 'no timer left behind');
  // With nothing on the card and no drafts there is nothing to lose: at once.
  v.click('new-round');
  assert.equal(v.toast(), 'Round 5: a clean card. Hole 1, par 4.');
  // One holed hole, no drafts (all typed away): still asks.
  v.play('" 5');
  v.type('');
  v.click('new-round');
  assert.equal(v.toast(), 'Press New round again within 4 s to clear round 5: 1 hole on the card, 0 drafts. Your bests stay.');
});

test('regex-par: a newer toast keeps its full 2.5 s', (t) => {
  const { clock, v } = openPage(t);
  v.enter();
  clock.advance(2000);
  v.play('POST');
  clock.advance(2000);
  assert.match(v.toast(), /^Not holed: \/POST\//);
  clock.advance(499);
  assert.notEqual(v.toast(), null);
  clock.advance(1);
  assert.equal(v.toast(), null);
});

test('regex-par: every class the game puts on the page has a rule in style.css', (t) => {
  const seen = new Set();
  const collect = (v) => {
    for (const el of walk(v.page.root)) String(el.className || '').split(/\s+/).filter(Boolean).forEach((name) => seen.add(name));
  };
  const { v } = openPage(t, { storage: { state: SAMPLE_STATE } });
  collect(v);
  v.play('xyz');
  collect(v);
  v.play('K.*d|xyz');
  v.type('^');
  collect(v);
  v.type('(');
  collect(v);
  v.click('next');
  v.play('t=[1-9]');
  v.click('new-round');
  collect(v);
  v.restore();
  const worker = openPage(t, { worker: true }).v;
  worker.type('5');
  collect(worker);
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors).join(' ');
  for (const name of [...seen].sort()) {
    assert.match(name, /^rxp-/);
    assert.match(selectors, new RegExp('\\.' + name + '(?![\\w-])'), name);
  }
  for (const name of ['rxp-line--ok', 'rxp-line--bad', 'rxp-hit--empty', 'rxp-status--error', 'rxp-status--solved', 'rxp-card-cell--under',
    'rxp-card-cell--par', 'rxp-card-cell--over', 'rxp-card-cell--current', 'rxp-sandbox--main', 'rxp-sandbox--starting', 'rxp-chip', 'rxp-show',
    'rxp-toast--error', 'rxp-toast--info', 'rxp-live--error', 'rxp-live--solved', 'rxp-list--pending']) {
    assert.ok(seen.has(name), name + ' was seen on the page');
  }
});

// ── The worker sandbox ───────────────────────────────────────────────────────

test('regex-par: with a Web Worker every pattern runs in it: a test pattern first, then only the newest pattern waiting', (t) => {
  const { w, v } = openPage(t, { worker: true });
  assert.equal(w.created.length, 1);
  assert.equal(w.current().url, 'blob:rxp-test/1');
  assert.equal(v.text('sandbox'), 'Sandbox: starting the Web Worker...');
  assert.equal(v.el('sandbox').className, 'rxp-sandbox rxp-sandbox--starting');
  assert.deepEqual(w.current().posted, [{ id: 1, pattern: '^ok$', lines: ['ok'] }]);
  // Typed before the worker answered: the patterns wait, only the newest is kept.
  v.type('5');
  v.type('5\\d');
  assert.deepEqual(v.lines(), neutralLines(HOLES[0]));
  assert.equal(v.text('status'), 'Checking /5\\d/ ...');
  assert.equal(v.el('match-list').className, 'rxp-list rxp-list--pending');
  assert.equal(w.current().posted.length, 1);
  w.settle();
  assert.equal(v.el('match-list').className, 'rxp-list');
  assert.equal(v.el('skip-list').className, 'rxp-list');
  assert.equal(v.text('sandbox'), 'Sandbox: Web Worker. A check that runs longer than 300 ms is stopped, so no pattern can freeze the page.');
  assert.equal(v.el('sandbox').className, 'rxp-sandbox rxp-sandbox--worker');
  assert.deepEqual(w.patterns(), ['^ok$', '5\\d']);
  assert.deepEqual(w.current().posted[1], { id: 2, pattern: '5\\d', lines: linesOf(HOLES[0]) });
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '5\\d'));
  // While one check runs, typing keeps only the newest.
  const shown = v.text('status');
  assert.match(shown, /^Caught 4 of 4 lines to catch; \d of 5 lines to leave are caught too\.$/);
  v.type('"');
  v.type('" ');
  v.type('" 5');
  // Until the new result is in, the old colours stay dimmed and the status, counts and short count say a check runs.
  assert.notEqual(shown, 'Checking /" 5/ ...');
  assert.equal(v.text('status'), 'Checking /" 5/ ...');
  assert.equal(v.el('status').className, 'rxp-status');
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '5\\d'));
  assert.equal(v.el('match-list').className, 'rxp-list rxp-list--pending');
  assert.equal(v.el('skip-list').className, 'rxp-list rxp-list--pending');
  assert.deepEqual([v.text('match-count'), v.text('skip-count'), v.text('live')], ['checking...', 'checking...', 'checking...']);
  assert.equal(v.el('live').className, 'rxp-live');
  w.settle();
  assert.equal(v.el('match-list').className, 'rxp-list');
  assert.equal(v.text('live'), '4/4 caught, 0/5 wrong');
  assert.equal(v.text('match-count'), '4 of 4 caught');
  assert.deepEqual(w.patterns(), ['^ok$', '5\\d', '"', '" 5']);
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '" 5'));
  // Worker mode has no static check: the timeout guards it instead.
  v.type('(" 5)+');
  w.settle();
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '(" 5)+'));
  // A reply for a check that is not the one in flight, or no reply data, changes nothing.
  v.type('x');
  const current = w.current();
  current.dispatchEvent(createEvent('message', { data: { id: 1, error: null, spans: [[0, 2]] } }));
  current.dispatchEvent(createEvent('message', { data: null }));
  w.settle();
  current.dispatchEvent(createEvent('message', { data: { id: 2, error: 'late', spans: null } }));
  assert.equal(v.text('status'), 'Caught 0 of 4 lines to catch.');
  // Patterns over 200 characters are refused without a check.
  v.type('x'.repeat(201));
  assert.equal(v.text('status'), 'The pattern is 201 characters long: the game takes up to 200.');
  assert.equal(w.patterns().includes('x'.repeat(201)), false);
  // An empty box needs no check.
  const posted = w.patterns().length;
  v.type('');
  assert.equal(w.patterns().length, posted);
  assert.deepEqual(v.lines(), neutralLines(HOLES[0]));
});

test('regex-par: the worker is made from a Blob of the worker program, once', async (t) => {
  const { clock, w, v } = openPage(t, { worker: { hang: (m) => m.pattern === '(a+)+$' } });
  w.settle();
  v.type('(a+)+$');
  w.settle();
  clock.advance(300);
  assert.equal(w.created.length, 2, 'a fresh worker after the timeout');
  assert.equal(w.blobs.length, 1, 'from the same Blob URL');
  assert.equal(w.created[1].url, w.created[0].url);
  assert.equal(w.blobs[0].type, 'text/javascript');
  assert.equal(await w.blobs[0].text(), rxp.rxpWorkerSource);
});

test('regex-par: a check that runs past 300 ms is stopped: the worker is terminated, a fresh one takes over and the error names the pattern', (t) => {
  const { clock, w, v } = openPage(t, { worker: { hang: (m) => m.pattern === '(\\d+)+x' } });
  w.settle();
  v.type('(\\d+)+x');
  w.settle();
  const first = w.current();
  clock.advance(299);
  assert.equal(first.terminated, false);
  v.type('(\\d+)+x5');
  clock.advance(1);
  assert.equal(first.terminated, true);
  assert.equal(w.created.length, 2);
  // The timed-out pattern is no longer on screen; the newer one waits for the fresh worker's test pattern.
  assert.deepEqual(w.created[1].posted, [{ id: 3, pattern: '^ok$', lines: ['ok'] }]);
  w.settle();
  assert.deepEqual(w.created[1].posted[1], { id: 4, pattern: '(\\d+)+x5', lines: linesOf(HOLES[0]) });
  assert.equal(v.text('status'), 'Caught 0 of 4 lines to catch.');
  // On screen it shows as an error.
  v.type('(\\d+)+x');
  w.settle();
  clock.advance(300);
  assert.equal(v.text('status'), 'Stopped after 300 ms: /(\\d+)+x/ backtracks too long on these lines. ' +
    'Nested quantifiers like (a+)+ and repeated alternatives like (a|a)* try every way to split a line.');
  assert.equal(v.el('status').className, 'rxp-status rxp-status--error');
  assert.deepEqual(v.lines(), neutralLines(HOLES[0]));
  assert.equal(v.el('sandbox').className, 'rxp-sandbox rxp-sandbox--worker', 'still worker mode');
  assert.equal(w.created.length, 3);
  v.enter();
  assert.match(v.toast(), /^Not holed: Stopped after 300 ms: /);
  v.type('" 5');
  w.settle();
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '" 5'));
});

test('regex-par: Enter waits for the worker\'s check and then holes out; a check that lands on another hole scores nothing', (t) => {
  const { w, v } = openPage(t, { worker: true });
  w.settle();
  v.type('" 5');
  v.enter();
  assert.equal(v.toast(), 'Checking /" 5/ ... it is scored as soon as the check is in.', 'no result yet, and Enter says so');
  assert.equal(v.toastKind(), 'info');
  assert.equal(v.score(0), '·');
  w.settle();
  assert.equal(v.toast(), 'Hole 1 holed in 3 strokes: birdie (-1). New best for this hole.');
  assert.equal(v.toastKind(), 'success');
  // Enter with the check in flight, then a move to another hole: that check scores nothing, and its note goes.
  v.click('next');
  w.settle();
  v.type('^./5 ');
  v.enter();
  assert.match(v.toast(), /^Checking \/\^\.\/5 \/ \.\.\./);
  v.click('prev');
  assert.equal(v.toast(), null);
  w.settle();
  assert.equal(v.score(1), '·');
  assert.equal(v.toast(), null);
  // Enter on a pattern already checked holes out at once.
  v.click('next');
  w.settle();
  v.enter();
  assert.equal(v.toast(), 'Hole 2 holed in 5 strokes: birdie (-1). New best for this hole.');
});

test('regex-par: a worker the page refuses, or that fails or never answers, gives main-thread mode with the reason, and the waiting pattern runs there', (t) => {
  // The constructor throws (a CSP that blocks blob: workers).
  let { v } = openPage(t, { storage: { state: stateSave({ drafts: ['" 5'].concat(new Array(17).fill('')) }) }, worker: { throws: true } });
  assert.equal(v.text('sandbox'), 'Sandbox: main thread, because the Web Worker is unavailable (the page does not allow it: SecurityError: ' +
    'Refused to create a worker from blob:rxp-test/1 (worker-src)). Patterns up to 60 characters; one that could take more than 1,500,000 steps on a line, such as (a+)+, (a|a)* or (.?){20}, is refused before it runs.');
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '" 5'));
  v.restore();
  resetStubs();
  // An error event while it starts: the pattern typed meanwhile runs on the main thread.
  let w;
  ({ v, w } = openPage(t, { worker: true }));
  v.type('" 5');
  const ev = createEvent('error', { message: 'Refused to load blob:rxp-test/2 because it violates the Content Security Policy' });
  w.current().dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'kept out of the host page\'s console');
  assert.equal(w.current().terminated, true);
  assert.match(v.text('sandbox'), /\(the worker failed: Refused to load blob:rxp-test\/2 because it violates the Content Security Policy\)\./);
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '" 5'));
  v.type('(a+)+');
  assert.match(v.text('status'), /^Refused in main-thread mode/);
  v.restore();
  resetStubs();
  // An error event while a pattern is in flight, without a message: that pattern runs on the main thread.
  ({ v, w } = openPage(t, { worker: true }));
  w.settle();
  v.type('" 5');
  v.enter();
  w.current().dispatchEvent(createEvent('error'));
  assert.match(v.text('sandbox'), /\(the worker failed: error event\)\./);
  assert.equal(v.toast(), 'Hole 1 holed in 3 strokes: birdie (-1). New best for this hole.');
  v.restore();
  resetStubs();
  // The test pattern gets no answer within 2 s (a slow phone gets that long to start a worker).
  let clock;
  ({ v, w, clock } = openPage(t, { worker: { hang: () => true } }));
  v.type('" 5');
  clock.advance(1999);
  assert.equal(v.el('sandbox').className, 'rxp-sandbox rxp-sandbox--starting');
  clock.advance(1);
  assert.match(v.text('sandbox'), /\(it gave no answer within 2000 ms\)\./);
  assert.equal(w.current().terminated, true);
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '" 5'));
  v.restore();
  resetStubs();
  // The probe dies, nothing was waiting.
  ({ v, w, clock } = openPage(t, { worker: { hang: () => true } }));
  clock.advance(2000);
  assert.equal(v.el('sandbox').className, 'rxp-sandbox rxp-sandbox--main');
  assert.deepEqual(v.lines(), neutralLines(HOLES[0]));
  v.restore();
  resetStubs();
  // The fresh worker after a timeout never answers its test pattern.
  let silent = false;
  ({ v, w, clock } = openPage(t, { worker: { hang: (m) => m.pattern === '(5+)+' || (silent && m.pattern === '^ok$') } }));
  w.settle();
  v.type('(5+)+');
  w.settle();
  silent = true;
  clock.advance(300);
  v.type('" 5');
  w.settle();
  assert.equal(w.created.length, 2);
  assert.deepEqual(v.lines(), neutralLines(HOLES[0]), 'the pattern waits for the fresh worker');
  clock.advance(2000);
  assert.match(v.text('sandbox'), /\(it gave no answer within 2000 ms\)\./);
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '" 5'));
  v.restore();
  resetStubs();
  // After a timeout the page refuses the fresh worker.
  ({ v, w, clock } = openPage(t, { worker: { hang: (m) => m.pattern === '(5+)+', throws: 2 } }));
  w.settle();
  v.type('(5+)+');
  w.settle();
  v.type('" 5');
  clock.advance(300);
  assert.match(v.text('sandbox'), /\(the page does not allow it: SecurityError: /);
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '" 5'), 'the newest pattern runs on the main thread');
});

test('regex-par: without Blob or URL.createObjectURL there is no worker either', (t) => {
  for (const [name, take, put] of [
    ['Blob', () => { const old = globalThis.Blob; globalThis.Blob = undefined; return old; }, (old) => { globalThis.Blob = old; }],
    ['createObjectURL', () => { const old = URL.createObjectURL; URL.createObjectURL = undefined; return old; }, (old) => { URL.createObjectURL = old; }],
    ['URL', () => { const old = globalThis.URL; globalThis.URL = undefined; return old; }, (old) => { globalThis.URL = old; }]
  ]) {
    resetStubs();
    const clock = makeClock(t);
    const w = installWorker(t);
    const old = take();
    let v;
    try {
      v = boot();
    } finally {
      put(old);
    }
    assert.match(v.text('sandbox'), /\(this browser has no Web Worker\)/, name);
    assert.equal(w.created.length, 0, name);
    v.restore();
    clock.reload();
  }
});

test('regex-par: a reply the game cannot read shows as an error of its own', (t) => {
  const { w, v } = openPage(t, { worker: true });
  w.settle();
  v.type('" 5');
  const worker = w.current();
  worker.inbox.length = 0;
  worker.dispatchEvent(createEvent('message', { data: { id: 2, error: null, spans: [[0, 99]] } }));
  assert.equal(v.text('status'), 'The worker sent back a reply the game cannot read. Type the pattern again.');
  assert.equal(v.el('status').className, 'rxp-status rxp-status--error');
});

// ── Saves on the page ────────────────────────────────────────────────────────

test('regex-par: saves in the current format load as they were and are written back in the same format', (t) => {
  const { v } = openPage(t, { storage: { state: SAMPLE_STATE, best: SAMPLE_BEST } });
  assert.equal(v.text('hole-number'), 'Hole 3 of 18');
  assert.equal(v.input.value, 'Kil');
  assert.equal(v.text('strokes'), '3 strokes');
  assert.equal(v.score(0), '-1');
  assert.equal(v.score(1), 'E');
  assert.equal(v.text('course'), 'Round 3: 2 of 18 holed, 9 strokes (-1).');
  assert.equal(v.text('best-course'), 'Best round: 270 strokes (+6)');
  assert.equal(v.text('status'), 'Caught 3 of 3 lines to catch; 1 of 5 lines to leave are caught too.');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE, 'nothing written yet');
  assert.equal(localStorage.getItem(BEST_KEY), SAMPLE_BEST);
  // The samples are exactly what the game writes for these values.
  assert.equal(JSON.stringify(JSON.parse(SAMPLE_STATE)), SAMPLE_STATE);
  assert.equal(JSON.stringify(JSON.parse(SAMPLE_BEST)), SAMPLE_BEST);
  v.type('Kille');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE.replace('"Kil"', '"Kille"'));
  v.enter();
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE.replace('"Kil"', '"Kille"').replace('[3,6,null', '[3,6,5'));
  assert.equal(localStorage.getItem(BEST_KEY), '{"v":1,"holes":[{"pattern":"\\" 5","strokes":3},null,{"pattern":"Kille","strokes":5},' +
    'null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],"course":270}');
});

test('regex-par: a round in progress survives a reload: hole, drafts, card, bests', (t) => {
  const { clock, v } = openPage(t);
  v.play('" 5');
  v.click('next');
  v.type('^./5');
  v.cell(9).click();
  v.type('\\d[^/]');
  const snapshot = [localStorage.getItem(STATE_KEY), localStorage.getItem(BEST_KEY)];
  const again = reload(clock, v);
  assert.equal(again.text('hole-number'), 'Hole 10 of 18');
  assert.equal(again.input.value, '\\d[^/]');
  assert.deepEqual(again.lines(), expectedLines(HOLES[9], '\\d[^/]'));
  assert.equal(again.score(0), '-1');
  again.cell(1).click();
  assert.equal(again.input.value, '^./5');
  assert.equal(again.text('best-hole'), 'Best: --');
  again.cell(0).click();
  assert.equal(again.text('best-hole'), 'Best: /" 5/ in 3 strokes (-1, birdie)');
  assert.equal(localStorage.getItem(BEST_KEY), snapshot[1]);
});

test('regex-par: a corrupt or partial save never breaks the page: what is readable stays, the rest starts fresh', (t) => {
  const corrupt = {
    'not JSON': '{"hole":',
    'an array': '[1,2,3]',
    'a string': '"rxp"',
    'wrong types': '{"hole":"5","round":"x","drafts":"abc","card":{"0":3}}',
    'out of range': '{"hole":42,"round":-2,"drafts":[1,2],"card":[0,-5,999]}',
    'nulls': '{"hole":null,"round":null,"drafts":null,"card":null}'
  };
  for (const [name, text] of Object.entries(corrupt)) {
    resetStubs();
    const { v } = openPage(t, { storage: { state: text, best: '{"holes":[{"pattern":"x","strokes":9}],"course":"best"}' } });
    assert.equal(v.text('hole-number'), 'Hole 1 of 18', name);
    assert.equal(v.input.value, '', name);
    assert.equal(v.text('course'), 'Round 1: no hole holed yet. Course par 264.', name);
    assert.equal(v.text('best-hole'), 'Best: --', name);
    assert.equal(v.text('best-course'), 'Best round: --', name);
    v.play('" 5');
    assert.equal(v.score(0), '-1', name);
    assert.deepEqual(v.state().card.slice(0, 2), [3, null], name);
    v.restore();
  }
  // A partial save keeps what it has.
  resetStubs();
  const { v } = openPage(t, { storage: { state: '{"hole":4,"drafts":["a",null,"c"]}' } });
  assert.equal(v.text('hole-number'), 'Hole 5 of 18');
  v.cell(2).click();
  assert.equal(v.input.value, 'c');
  assert.equal(v.state().round, 1);
});

test('regex-par: blocked storage never stops the game, and the warning names the keys it cannot save', (t) => {
  blockStorage('access', t);
  const { v } = openPage(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Storage is blocked or full (SecurityError): rxp-best and rxp-state are not saved, so a reload starts over. The game itself goes on.');
  v.play('" 5');
  assert.equal(v.score(0), '-1');
  v.click('next');
  v.type('^./5 ');
  v.click('prev');
  assert.equal(v.input.value, '" 5');
  assert.equal(v.text('best-hole'), 'Best: /" 5/ in 3 strokes (-1, birdie)');
});

test('regex-par: full storage still reads the saves, names the key that failed, and loses no draft when moving between holes', (t) => {
  writeStorage({ state: SAMPLE_STATE });
  blockStorage('full', t);
  const { v } = openPage(t);
  assert.equal(v.input.value, 'Kil', 'the save is still read');
  assert.equal(v.hidden('warning'), true, 'nothing failed yet');
  v.type('Kille');
  assert.equal(v.text('warning'), 'Storage is blocked or full (QuotaExceededError): rxp-state is not saved, so a reload starts over. The game itself goes on.');
  v.click('next');
  v.type('t=[^0]');
  v.click('prev');
  assert.equal(v.input.value, 'Kille', 'the unsaved draft stays in this tab');
  v.enter();
  assert.equal(v.text('warning'), 'Storage is blocked or full (QuotaExceededError): rxp-state and rxp-best are not saved, so a reload starts over. The game itself goes on.');
  v.click('next');
  assert.equal(v.input.value, 't=[^0]');
  assert.equal(v.score(2), 'E');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE);
});

// ── Second tabs ──────────────────────────────────────────────────────────────

test('regex-par: another tab\'s drafts, card and bests come in through the storage event, and the draft on screen is checked again', (t) => {
  const { v } = openPage(t);
  v.type('POST');
  // The other tab typed on this hole and holed hole 2.
  const other = stateSave({ hole: 1, drafts: ['" 5', '^./5 '].concat(new Array(16).fill('')), card: [null, 5].concat(new Array(16).fill(null)) });
  localStorage.setItem(STATE_KEY, JSON.stringify(other));
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.input.value, '" 5');
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '" 5'));
  assert.equal(v.score(1), '-1');
  assert.equal(v.text('hole-number'), 'Hole 1 of 18', 'this tab stays on its hole');
  // A best from the other tab.
  localStorage.setItem(BEST_KEY, JSON.stringify({ v: 1, holes: [{ pattern: '" 5', strokes: 3 }], course: 251 }));
  fire(window, 'storage', { key: BEST_KEY });
  assert.equal(v.text('best-hole'), 'Best: /" 5/ in 3 strokes (-1, birdie)');
  assert.equal(v.text('best-course'), 'Best round: 251 strokes (-13)');
  // Other keys, the same text again, or a save that changes nothing here are ignored.
  const status = v.text('status');
  fire(window, 'storage', { key: 'ppn-state' });
  fire(window, 'storage', { key: null });
  fire(window, 'storage', { key: STATE_KEY });
  localStorage.setItem(STATE_KEY, JSON.stringify(Object.assign({}, other, { hole: 7 })));
  fire(window, 'storage', { key: STATE_KEY });
  localStorage.setItem(BEST_KEY, JSON.stringify({ v: 1, holes: [{ pattern: '" 5|x', strokes: 5 }], course: 300 }));
  fire(window, 'storage', { key: BEST_KEY });
  assert.equal(v.text('status'), status);
  assert.equal(v.text('best-course'), 'Best round: 251 strokes (-13)', 'a worse best never wins');
  // A change that leaves the draft on screen alone just redraws.
  localStorage.setItem(STATE_KEY, JSON.stringify(Object.assign({}, other, { card: [null, 5, 4].concat(new Array(15).fill(null)) })));
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.score(2), '-1');
  assert.equal(v.input.value, '" 5');
});

test('regex-par: before every write the save is read again, so another tab\'s card, drafts and newer round are never written over', (t) => {
  const { v } = openPage(t);
  v.type('" 5');
  // Another tab holed hole 3 (no storage event yet, as for a tab in the back/forward cache).
  const theirs = stateSave({ hole: 2, drafts: ['" 5', '', 'Kille'].concat(new Array(15).fill('')), card: [null, null, 5].concat(new Array(15).fill(null)) });
  localStorage.setItem(STATE_KEY, JSON.stringify(theirs));
  v.type('" 5\\d');
  assert.deepEqual(v.state().card.slice(0, 3), [null, null, 5]);
  assert.equal(v.score(2), 'E', 'the card on screen shows what came in');
  assert.deepEqual(v.state().drafts.slice(0, 3), ['" 5\\d', '', 'Kille']);
  // Another tab holed this hole first: ours does not replace it on the card.
  localStorage.setItem(STATE_KEY, JSON.stringify(Object.assign(v.state(), { card: [9, null, 5].concat(new Array(15).fill(null)) })));
  v.enter();
  assert.equal(v.toast(), 'Hole 1 is already on this round\'s card with 9 strokes. New best: 5 strokes.');
  assert.equal(v.state().card[0], 9);
  // Another tab's shorter best stays the best.
  localStorage.setItem(BEST_KEY, JSON.stringify({ v: 1, holes: [{ pattern: '" 5', strokes: 3 }], course: null }));
  v.enter();
  assert.equal(v.toast(), 'Hole 1 is already on this round\'s card with 9 strokes.');
  assert.deepEqual(v.best().holes[0], { pattern: '" 5', strokes: 3 });
  // Another tab started round 2; New round here makes it round 3, never a second round 2.
  localStorage.setItem(STATE_KEY, JSON.stringify(stateSave({ round: 2, hole: 0, drafts: ['abc'].concat(new Array(17).fill('')) })));
  v.click('new-round');
  assert.equal(v.input.value, 'abc', 'the other tab\'s round is taken over first');
  v.click('new-round');
  assert.equal(v.state().round, 3);
  assert.equal(v.toast(), 'Round 3: a clean card. Hole 1, par 4.');
  // Moving to another hole reads that hole's draft as the other tab left it.
  localStorage.setItem(STATE_KEY, JSON.stringify(stateSave({ round: 3, drafts: ['', 'from the other tab'].concat(new Array(16).fill('')) })));
  v.click('next');
  assert.equal(v.input.value, 'from the other tab');
});

test('regex-par: a tab shown again reads the saves back; a hidden tab writes and reads nothing', (t) => {
  const { v } = openPage(t);
  v.type('POST');
  const read = t.mock.method(localStorage, 'getItem');
  setVisibility('hidden', t);
  assert.equal(read.mock.callCount(), 0);
  localStorage.setItem(STATE_KEY, JSON.stringify(stateSave({ drafts: ['" 5'].concat(new Array(17).fill('')), card: [3].concat(new Array(17).fill(null)) })));
  localStorage.setItem(BEST_KEY, JSON.stringify({ v: 1, holes: [{ pattern: '" 5', strokes: 3 }], course: null }));
  setVisibility('visible', t);
  assert.equal(v.input.value, '" 5');
  assert.equal(v.score(0), '-1');
  assert.equal(v.text('best-hole'), 'Best: /" 5/ in 3 strokes (-1, birdie)');
  assert.deepEqual(v.lines(), expectedLines(HOLES[0], '" 5'));
  const writes = t.mock.method(localStorage, 'setItem');
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.equal(writes.mock.callCount(), 0, 'nothing new: nothing written');
});
