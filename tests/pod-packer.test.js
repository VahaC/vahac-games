// tests/pod-packer.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, keyEvent, createEvent, focusElement, setVisibility, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'pod-packer';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

// The pure functions (the start-up code does not run under Node).
const pdp = loadScript(SCRIPT);

const STATE_KEY = 'pdp-state';
const PROGRESS_KEY = 'pdp-progress';
const MAX_LEVEL = 50;

// The rules each level turns on, as the README and the help describe them:
// [solution nodes, spare nodes, pods, anti-affinity replicas, gpu taint, pods on a draining node].
const LEVEL_TABLE = [
  [2, 1, 5, 0, false, 0], [2, 1, 5, 2, false, 0], [2, 1, 6, 0, true, 0], [2, 1, 6, 0, false, 2],
  [3, 1, 7, 2, true, 0], [3, 1, 8, 2, false, 2], [3, 1, 8, 0, true, 2], [3, 1, 9, 2, true, 2],
  [4, 0, 10, 3, true, 2], [4, 1, 10, 3, true, 3], [4, 1, 11, 3, true, 3], [4, 1, 12, 3, true, 3]
];
const tableRow = (number) => LEVEL_TABLE[Math.min(number, LEVEL_TABLE.length) - 1];

// Level 1 and level 4 as every visitor gets them, pinned: a change to the
// generator, the seeds or the PRNG changes every level (and breaks every
// saved placement) and has to show up here.
const node = (name, cpu, mem, taint = null, drain = false) => ({ name, cpu, mem, taint, drain });
const pod = (name, cpu, mem, extra = {}) => Object.assign({
  name, app: name.replace(/-\d+$/, ''), cpu, mem, anti: false, tolerates: null, needs: null
}, extra);
const LEVEL1 = {
  seed: 1653022489,
  nodes: [node('node-1', 6, 12), node('node-2', 4, 8), node('node-3', 6, 4)],
  pods: [pod('auth-1', 3, 3), pod('proxy-1', 3, 1), pod('backup-1', 2, 1), pod('cache-1', 1, 3), pod('metrics-1', 1, 4)],
  start: [-1, -1, -1, -1, -1],
  solution: [2, 2, 1, 1, 1]
};
const LEVEL4 = {
  seed: 1703355346,
  nodes: [node('node-1', 6, 16), node('node-2', 4, 8), node('node-3', 6, 12, null, true), node('node-4', 8, 12)],
  pods: [pod('cron-1', 2, 5), pod('api-1', 2, 3), pod('queue-1', 4, 7), pod('auth-1', 1, 3), pod('web-1', 1, 5), pod('metrics-1', 4, 5)],
  start: [-1, -1, 2, -1, 2, -1],
  solution: [0, 0, 3, 0, 0, 3]
};

// A pdp-state in the format the first published version writes: level 4,
// queue-1 evicted from the draining node-3 and run on node-4, then cron-1 run
// on node-1 (3 moves, 1 eviction).  The eviction from the draining node is
// final, so it is not on the undo history.
const SAMPLE_SAVE = '{"v":1,"level":4,"seed":1703355346,"place":[0,-1,3,-1,2,-1],' +
  '"history":[[2,-1,3],[0,-1,0]],"moves":3,"evictions":1}';
// A pdp-progress of the same version: levels 1 to 3 passed.
const SAMPLE_PROGRESS = '{"v":1,"highest":3,"levels":{"1":{"moves":5,"evictions":0},' +
  '"2":{"moves":7,"evictions":1},"3":{"moves":6,"evictions":0}}}';

test.beforeEach(() => resetStubs());

// ── An independent model of the rules ────────────────────────────────────────

const sum = (list) => list.reduce((a, b) => a + b, 0);
const drainOf = (lv) => lv.nodes.findIndex((n) => n.drain);
const onNode = (lv, place, j) => lv.pods.filter((p, i) => place[i] === j);

// Every broken rule of a placement, as text: resources, taints, the gpu node
// a pod needs, anti-affinity, and new pods on the draining node.
function violations(lv, place) {
  const out = [];
  lv.nodes.forEach((n, j) => {
    const here = onNode(lv, place, j);
    if (n.drain) {
      place.forEach((p, i) => { if (p === j && lv.start[i] !== j) out.push('new pod ' + lv.pods[i].name + ' on draining ' + n.name); });
      return;
    }
    if (sum(here.map((p) => p.cpu)) > n.cpu) out.push('cpu over on ' + n.name);
    if (sum(here.map((p) => p.mem)) > n.mem) out.push('memory over on ' + n.name);
    for (const p of here) {
      if (n.taint && p.tolerates !== n.taint) out.push(p.name + ' does not tolerate ' + n.taint);
      if (p.needs && n.taint !== p.needs) out.push(p.name + ' needs ' + p.needs);
    }
    for (let a = 0; a < here.length; a++) {
      for (let b = a + 1; b < here.length; b++) {
        if (here[a].app === here[b].app && here[a].anti && here[b].anti) out.push('replicas ' + here[a].name + ' and ' + here[b].name + ' share ' + n.name);
      }
    }
  });
  return out;
}

const usedNodes = (lv, place) => new Set(place.filter((p) => p !== -1 && !lv.nodes[p].drain)).size;

// Scheduled: every pod runs off the draining node, every rule kept.
const scheduled = (lv, place) => place.every((p) => p !== -1 && !lv.nodes[p].drain) && violations(lv, place).length === 0;

// The fewest nodes of any schedule, by trying every assignment of every pod
// to every node but the draining one.
function bruteMin(lv) {
  const nodes = lv.nodes.map((n, j) => j).filter((j) => !lv.nodes[j].drain);
  const digits = new Array(lv.pods.length).fill(0);
  let best = Infinity;
  for (let k = 0; k < nodes.length ** lv.pods.length; k++) {
    const place = digits.map((d) => nodes[d]);
    if (violations(lv, place).length === 0) best = Math.min(best, usedNodes(lv, place));
    for (let i = 0; i < digits.length && ++digits[i] === nodes.length; i++) digits[i] = 0;
  }
  return best;
}

// The fewest nodes of any schedule, by a search of its own for levels too big
// for bruteMin (9 to 12 pods): for m = 1, 2, ... every set of m usable nodes
// is tried; the pods, largest memory first, each go on a node of the set
// where the rules hold; an empty node identical to an earlier empty node of
// the set is skipped (the same schedule with two nodes swapped), and a branch
// stops when the pods left need more CPU or memory than the set has free.
// Returns { nodes, place } (place: a witness schedule) or throws past limit
// steps, so it never runs away.
function independentMin(lv, limit = 2e6) {
  const usable = lv.nodes.map((n, j) => j).filter((j) => !lv.nodes[j].drain);
  const order = lv.pods.map((p, i) => i).sort((a, b) => lv.pods[b].mem - lv.pods[a].mem || lv.pods[b].cpu - lv.pods[a].cpu || a - b);
  const restCpu = order.map((_, k) => sum(order.slice(k).map((i) => lv.pods[i].cpu))).concat(0);
  const restMem = order.map((_, k) => sum(order.slice(k).map((i) => lv.pods[i].mem))).concat(0);
  const same = (a, b) => a.cpu === b.cpu && a.mem === b.mem && a.taint === b.taint;
  let steps = 0;
  const sets = (m, from) => (m === 0 ? [[]] : usable.slice(from).flatMap((j, k) => sets(m - 1, from + k + 1).map((rest) => [j].concat(rest))));
  function schedule(set) {
    const cpu = set.map((j) => lv.nodes[j].cpu);
    const mem = set.map((j) => lv.nodes[j].mem);
    const here = set.map(() => []);
    const place = lv.pods.map(() => -1);
    function dfs(k) {
      if (++steps > limit) throw new Error('independentMin: more than ' + limit + ' steps on level ' + lv.number);
      if (k === order.length) return true;
      if (restCpu[k] > sum(cpu) || restMem[k] > sum(mem)) return false;
      const i = order[k];
      const p = lv.pods[i];
      for (let s = 0; s < set.length; s++) {
        const n = lv.nodes[set[s]];
        if (!here[s].length && set.some((j, s2) => s2 < s && !here[s2].length && same(lv.nodes[j], n))) continue;
        if (p.cpu > cpu[s] || p.mem > mem[s] || (n.taint && p.tolerates !== n.taint) || (p.needs && n.taint !== p.needs)) continue;
        if (p.anti && here[s].some((q) => q.anti && q.app === p.app)) continue;
        cpu[s] -= p.cpu;
        mem[s] -= p.mem;
        here[s].push(p);
        place[i] = set[s];
        if (dfs(k + 1)) return true;
        place[i] = -1;
        here[s].pop();
        cpu[s] += p.cpu;
        mem[s] += p.mem;
      }
      return false;
    }
    return dfs(0) ? place : null;
  }
  for (let m = 1; m <= usable.length; m++) {
    for (const set of sets(m, 0)) {
      const place = schedule(set);
      if (place) return { nodes: m, place, steps };
    }
  }
  return { nodes: Infinity, place: null, steps };
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

const levelOf = (number) => pdp.pdpBuildLevel(number, pdp.pdpLevelSeed(number));
const units = (halves) => (halves / 2).toFixed(1);

// A small hand-made level for exact refusal texts: node-1 4 CPU / 4 GiB,
// node-2 gpu-tainted, node-3 draining with old-1 on it.
function handLevel() {
  const lv = {
    number: 7,
    seed: 1,
    nodes: [node('node-1', 8, 8), node('node-2', 8, 8, 'gpu'), node('node-3', 4, 4, null, true)],
    pods: [
      pod('api-1', 3, 2, { anti: true }), pod('api-2', 3, 2, { anti: true }), pod('big-1', 6, 7),
      pod('ml-1', 2, 2, { tolerates: 'gpu', needs: 'gpu' }), pod('batch-1', 1, 1, { tolerates: 'gpu' }), pod('old-1', 2, 2)
    ],
    start: [-1, -1, -1, -1, -1, 2],
    solution: [0, 1, 0, 1, 1, 0],
    upper: 2,
    target: { nodes: 2, exact: true },
    minEvictions: 1,
    minMoves: 7
  };
  return lv;
}

// ── Pages ────────────────────────────────────────────────────────────────────

function enableTimers(t) {
  const enable = () => t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    enable();
  } catch (error) {
    t.mock.timers.reset(); // a second page in the same test
    enable();
  }
}

function writeStorage(storage = {}) {
  for (const [key, value] of [[STATE_KEY, storage.state], [PROGRESS_KEY, storage.progress]]) {
    if (value !== undefined) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

const storedKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();

// What a player sees and does.
function pageView(b) {
  const els = b.els;
  const board = els['pdp-board'];
  const v = {
    els,
    board,
    page: b.page,
    ready: b.ready,
    restore: b.restore,
    el: (name) => els['pdp-' + name],
    text: (name) => els['pdp-' + name].textContent,
    hidden: (name) => els['pdp-' + name].classList.contains('pdp-hidden'),
    pod: (i) => b.page.root.querySelector('#pdp-pod-' + i),
    nodes: () => els['pdp-nodes'].children,
    node: (j) => els['pdp-nodes'].children[j],
    queue: () => els['pdp-queue'].children.map((el) => Number(el.getAttribute('data-pod'))),
    podsOn: (j) => els['pdp-nodes'].children[j].children[3].children.map((el) => Number(el.getAttribute('data-pod'))),
    tapPod: (i) => v.pod(i).click(),
    tapNode: (j) => els['pdp-nodes'].children[j].click(),
    run(i, j) {
      v.tapPod(i);
      v.tapNode(j);
    },
    press(key, props) {
      if (document.activeElement !== board && !board.contains(document.activeElement)) focusElement(board, { keyboard: true });
      return pressKey(key, Object.assign({ target: document.activeElement }, props));
    },
    click: (name) => els['pdp-' + name].click(),
    choose(value) {
      els['pdp-level'].value = String(value);
      return fire(els['pdp-level'], 'change');
    },
    toast: () => (els['pdp-toast'].classList.contains('pdp-show') ? els['pdp-toast'].textContent : null),
    state: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    progress: () => JSON.parse(localStorage.getItem(PROGRESS_KEY)),
    options: () => els['pdp-level'].children.map((o) => [o.value, o.textContent]),
    meters: (j) => [1, 2].map((k) => els['pdp-nodes'].children[j].children[k].children[2].textContent)
  };
  return v;
}

function boot(options) {
  return pageView(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options));
}

// The page as a browser loads it, after writing storage, with mocked timers
// and a Math.random that the game must never call.
function openPage(t, { storage, options } = {}) {
  enableTimers(t);
  t.mock.method(Math, 'random', () => {
    throw new Error('Pod Packer never uses Math.random');
  });
  writeStorage(storage);
  return boot(options);
}

// A reload: the old page and its timers go away, storage stays.
function reload(t, v) {
  t.mock.timers.reset();
  enableTimers(t);
  v.restore();
  return boot();
}

// Plays a level's generated solution on the page: every pod on the
// draining node is tapped (evicted) and run on its solution node, every
// pending pod picked and run.  The minimum moves and evictions.
function solve(v, lv, order = lv.pods.map((p, i) => i)) {
  for (const i of order) {
    v.tapPod(i);
    v.tapNode(lv.solution[i]);
  }
}

// Every element of the page tree under node.
function walk(root, out = []) {
  for (const child of root.children || []) {
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

test('pod-packer: every id the script looks up is in index.html once; ids, classes, CSS variables, storage keys and exports are pdp- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'pdp-best', 'pdp-board', 'pdp-evictions', 'pdp-evictions-min', 'pdp-goal', 'pdp-hint', 'pdp-level',
    'pdp-moves', 'pdp-moves-min', 'pdp-next', 'pdp-nodes', 'pdp-nodes-target', 'pdp-nodes-used', 'pdp-pending-count',
    'pdp-queue', 'pdp-queue-empty', 'pdp-restart', 'pdp-rules', 'pdp-status', 'pdp-toast', 'pdp-undo', 'pdp-warning'
  ]);
  assert.equal(ids.length, new Set(ids).size, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^pdp-/);
  // Ids the script makes itself.
  assert.deepEqual(Array.from(JS.matchAll(/\.id = '([^']+)'/g), (m) => m[1]), ['pdp-pod-']);

  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^pdp-/);
  // Classes the script sets.
  const scripted = Array.from(JS.matchAll(/'(pdp-[\w-]+)/g), (m) => m[1]);
  assert.ok(scripted.length > 30);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^pdp-/, selector);
    }
  }
  // Custom properties (not the --modifier part of a class name).
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^pdp-/);
  for (const m of JS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^pdp-/);
  assert.deepEqual(Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g)), [], 'no animations to name');
  assert.deepEqual([...new Set(Array.from(JS.matchAll(/'(pdp-(?:state|progress))'/g), (m) => m[1]))].sort(), ['pdp-progress', 'pdp-state']);
  assert.deepEqual(Array.from(JS.matchAll(/localStorage\.(\w+)/g), (m) => m[1]).sort(), ['getItem', 'setItem'], 'storage only through the two guarded helpers');
  for (const name of Object.keys(pdp)) assert.match(name, /^pdp[A-Z]/);
  assert.doesNotMatch(JS, /window\.\w+\s*=/, 'nothing is put on window');
});

test('pod-packer: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="pdp-wrapper" id="pdp-game"'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');
  const bg = CSS.match(/--pdp-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Pod Packer — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  // One script, at the end of the body; no external resources at all.
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(/, 'no network resources');
    // Generic terms only: no orchestrator brand names.
    assert.doesNotMatch(text, /kubernetes|k8s|kubectl|nomad|openshift|docker|swarm/i);
  }
  const code = JS.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|Math\.random)\b/, 'no network calls, no Math.random');
});

test('pod-packer: script.js is one strict IIFE in ES5', () => {
  assert.match(JS, /^(\/\/[^\n]*\r?\n)*\r?\n?\(function \(\) \{\r?\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
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
    ['Promise', /\bPromise\b|\basync\b|\bawait\b/], ['ES2015+ library call', /\.(includes|find|findIndex|fill|from|assign|entries|values)\(/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('pod-packer: index.html has labelled controls, a focusable cluster and live regions', () => {
  const spec = htmlPageSpec(HTML);
  assert.equal(spec['pdp-board'].attributes.tabindex, '0');
  assert.equal(spec['pdp-board'].attributes.role, 'group');
  assert.equal(spec['pdp-board'].parent, 'pdp-game');
  assert.equal(spec['pdp-queue'].parent, 'pdp-board');
  assert.equal(spec['pdp-nodes'].parent, 'pdp-board');
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
    }
  }
  assert.equal(spec['pdp-level'].tagName, 'select');
  assert.equal(spec['pdp-status'].attributes['aria-live'], 'polite');
  assert.equal(spec['pdp-hint'].attributes['aria-live'], 'polite');
  assert.equal(spec['pdp-toast'].attributes['aria-live'], 'polite');
  assert.equal(spec['pdp-warning'].attributes.role, 'alert');
  assert.match(spec['pdp-warning'].className, /\bpdp-hidden\b/);
  assert.match(spec['pdp-next'].className, /\bpdp-hidden\b/);
  assert.match(HTML, /<label class="pdp-label" for="pdp-level">Level<\/label>/);
});

test('pod-packer: from 320 to 1440 px the cluster fits without widening the page: stats, CPU and RAM bars, pods and buttons', () => {
  const rules = cssRules(CSS);
  // The longest texts the game writes into fixed places.
  const longestMeter = '16.5/16.5 GiB';
  const longestPodLine = '6.5 CPU · 7.5 GiB';
  for (let vw = 320; vw <= 1440; vw++) {
    const wrapper = declsAt(rules, '.pdp-wrapper', vw);
    const side = px(wrapper.padding.split(/\s+/)[1]);
    const available = Math.min(vw, px(wrapper['max-width'])) - 2 * side;
    assert.equal(declsAt(rules, '.pdp-wrapper *', vw)['box-sizing'], 'border-box');
    assert.equal(wrapper['overflow-wrap'], 'anywhere', 'long words wrap instead of widening the page');

    // Stats: equal columns; every label word, value and minimum fits its card.
    const stats = declsAt(rules, '.pdp-stats', vw);
    const columns = Number(/^repeat\(([24]), minmax\(0, 1fr\)\)$/.exec(stats['grid-template-columns'])[1]);
    const stat = declsAt(rules, '.pdp-stat', vw);
    const [padY, padX] = stat.padding.split(/\s+/).map(px);
    assert.ok(padY >= 0);
    const card = (available - (columns - 1) * px(stats.gap)) / columns - 2 * padX - 2 * px(stat.border.split(/\s+/)[0]);
    const label = declsAt(rules, '.pdp-stat-label', vw);
    // Uppercase sans with letter spacing: 0.72em a letter covers the widest.
    for (const word of ['NODES', 'USED', 'EVICTIONS', 'MOVES', 'BEST']) {
      assert.ok(word.length * 0.72 * rem(label['font-size']) <= card, vw + 'px: ' + word + ' in ' + card + 'px');
    }
    const value = declsAt(rules, '.pdp-stat-value', vw);
    assert.equal(value['white-space'], 'normal');
    assert.ok('999'.length * 0.61 * rem(value['font-size']) <= card, vw + 'px: a three-digit value');
    const sub = declsAt(rules, '.pdp-stat-sub', vw);
    for (const word of ['target', 'evictions', '999']) assert.ok(word.length * 0.61 * rem(sub['font-size']) <= card, vw + 'px: ' + word);
    assert.equal(sub['white-space'], 'normal');

    // A node card: its bars keep at least 60 px next to the label and the longest value.
    const board = declsAt(rules, '.pdp-board', vw);
    const boardContent = available - 2 * px(board.padding) - 2 * px(board.border.split(/\s+/)[0]);
    const nodes = declsAt(rules, '.pdp-nodes', vw);
    const nodeColumns = Number((/^repeat\((\d), minmax\(0, 1fr\)\)$/.exec(nodes['grid-template-columns']) || [0, 1])[1]);
    if (nodeColumns === 1) assert.equal(nodes['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(nodeColumns, vw >= 720 ? 2 : 1, vw + 'px: node columns');
    const nodeDecls = declsAt(rules, '.pdp-node', vw);
    const nodeSide = px(nodeDecls.padding.split(/\s+/)[1]);
    const nodeContent = (boardContent - (nodeColumns - 1) * px(nodes.gap)) / nodeColumns - 2 * nodeSide - 2 * px(nodeDecls.border.split(/\s+/)[0]);
    const meter = declsAt(rules, '.pdp-meter', vw);
    const parts = /^([\d.]+rem) minmax\(0, 1fr\) ([\d.]+rem)$/.exec(meter['grid-template-columns']);
    assert.ok(parts, meter['grid-template-columns']);
    const bar = nodeContent - rem(parts[1]) - rem(parts[2]) - 2 * px(meter.gap);
    assert.ok(bar >= 60, vw + 'px: a bar of ' + bar + 'px');
    assert.ok(longestMeter.length * 0.61 * rem(meter['font-size']) <= rem(parts[2]), vw + 'px: ' + longestMeter);
    assert.ok('CPU'.length * 0.61 * rem(meter['font-size']) <= rem(parts[1]));
    assert.equal(declsAt(rules, '.pdp-meter-value', vw)['white-space'], 'nowrap');

    // A pod: its widest line fits the node card (and the queue, which is wider).
    const podDecls = declsAt(rules, '.pdp-pod', vw);
    const podWidth = longestPodLine.length * 0.61 * rem(podDecls['font-size']) + 2 * px(podDecls.padding.split(/\s+/)[1]) + 2;
    assert.ok(podWidth <= nodeContent, vw + 'px: a pod of ' + podWidth + 'px in ' + nodeContent + 'px');

    // Buttons keep one line and fit the column, even the widest.
    const btn = declsAt(rules, '.pdp-btn', vw);
    const btnSide = rem(btn.padding.split(/\s+/)[1]);
    for (const label2 of ['Next level: 50', 'Restart', 'Undo']) {
      assert.ok(label2.length * 0.62 * rem(btn['font-size']) + 2 * btnSide <= available, vw + 'px: ' + label2);
    }
  }
  // A pod is a button whose lines stack from the start (a button centres its content otherwise),
  // and its text wraps.
  const podRule = declsAt(rules, '.pdp-pod', 320);
  assert.equal(podRule.display, 'flex');
  assert.equal(podRule['flex-direction'], 'column');
  assert.equal(podRule['align-items'], 'flex-start');
  assert.equal(podRule['text-align'], 'left');
  assert.equal(podRule['white-space'], 'normal');
  assert.equal(podRule['max-width'], '100%');
  assert.equal(podRule['min-width'], '0');
  // The bars: the fill and the ghost of the picked pod are pinned inside a clipped track.
  assert.equal(declsAt(rules, '.pdp-bar', 320).position, 'relative');
  assert.equal(declsAt(rules, '.pdp-bar', 320).overflow, 'hidden');
  for (const sel of ['.pdp-bar-fill', '.pdp-bar-ghost']) {
    const d = declsAt(rules, sel, 320);
    assert.deepEqual([d.position, d.top, d.bottom, d.left], ['absolute', '0', '0', '0'], sel);
  }
  assert.equal(declsAt(rules, '.pdp-meter--cpu .pdp-bar-fill', 320).background, 'var(--pdp-cpu)');
  assert.equal(declsAt(rules, '.pdp-meter--mem .pdp-bar-fill', 320).background, 'var(--pdp-mem)');
  // Taps only: manipulation on every tap target, touch-action: none nowhere.
  const touch = rules.filter((rule) => rule.decls['touch-action'] !== undefined);
  assert.deepEqual(touch.map((rule) => [rule.selectors.join(', '), rule.decls['touch-action']]).sort(), [
    ['.pdp-btn', 'manipulation'], ['.pdp-node', 'manipulation'], ['.pdp-pod', 'manipulation'], ['.pdp-select', 'manipulation']
  ]);
  // The toast is as wide as its message and never wider than the screen.
  assert.equal(declsAt(rules, '.pdp-toast', 320).width, 'max-content');
  assert.equal(declsAt(rules, '.pdp-toast', 320)['max-width'], 'calc(100% - 32px)');
  assert.equal(declsAt(rules, '.pdp-toast', 320)['pointer-events'], 'none');
  assert.equal(declsAt(rules, '.pdp-hidden', 320).display, 'none');
  // The hint keeps room for its longest text, so the page does not jump while you pick pods:
  // three lines of a 320 px phone (0.61em a character), two on a desktop.
  const hint = (vw) => declsAt(rules, '.pdp-hint', vw);
  assert.equal(hint(320)['min-height'], '4.8em');
  assert.equal(hint(1280)['min-height'], '3.2em');
  assert.equal(declsAt(rules, '.pdp-wrapper', 320)['line-height'], '1.6');
  const perLine = Math.floor((320 - 2 * 12) / (0.61 * rem(hint(320)['font-size'])));
  for (const text of [
    'Tap a pending pod, then a node or a pod on it. Tap a running pod to evict it. Keys: arrows, 1-6, E, U.',
    'Picked metrics-1 (2.0 CPU, 2.5 GiB): fits node-1, node-2, node-3, node-4, node-5.',
    'Next level (or N) starts level 12. The level list replays any level you have reached.'
  ]) {
    const lines = [];
    for (const word of text.split(' ')) {
      if (lines.length && (lines[lines.length - 1] + ' ' + word).length <= perLine) lines[lines.length - 1] += ' ' + word;
      else lines.push(word);
    }
    assert.ok(lines.length <= 3, lines.length + ' lines: ' + JSON.stringify(lines));
  }
  assert.equal(declsAt(rules, '.pdp-board:focus-visible', 320)['outline-offset'], '-2px');
  assert.equal(declsAt(rules, '.pdp-bar-fill', 320, { matchMedia: (q) => /prefers-reduced-motion: reduce/.test(q) }).transition, 'none');
  // Touch screens: every pod is a 44 px tap target, its lines centred, and pods sit 8 px apart.
  const coarse = { matchMedia: (q) => q === '(pointer: coarse)' };
  for (const vw of [320, 375, 414, 1024]) {
    const touchPod = declsAt(rules, '.pdp-pod', vw, coarse);
    assert.deepEqual([touchPod['min-height'], touchPod['min-width'], touchPod['justify-content']], ['44px', '44px', 'center'], vw + 'px');
    assert.equal(declsAt(rules, '.pdp-node-pods', vw, coarse).gap, '8px');
    assert.equal(declsAt(rules, '.pdp-queue', vw, coarse).gap, '8px');
    assert.equal(declsAt(rules, '.pdp-pod', vw)['min-height'], undefined, 'a mouse keeps the compact pods');
  }
});

// WCAG contrast of two #rrggbb colours.
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('pod-packer: small texts keep a 4.5:1 contrast on the cards, and no node card is dimmed with opacity', () => {
  const rules = cssRules(CSS);
  const palette = declsAt(rules, '.pdp-wrapper', 320);
  const colour = (value) => {
    const m = /^var\((--pdp-[\w-]+)\)$/.exec(value);
    return m ? palette[m[1]] : value;
  };
  // The lightest background a small text sits on: the card colour.
  const card = palette['--pdp-bg-card'];
  assert.equal(card, '#1a2236');
  for (const sel of ['.pdp-stat-label', '.pdp-stat-sub', '.pdp-meter-label', '.pdp-meter-value', '.pdp-pod-size', '.pdp-queue-empty',
    '.pdp-footer', '.pdp-hint', '.pdp-rules', '.pdp-label', '.pdp-node-key']) {
    const c = colour(declsAt(rules, sel, 320).color);
    assert.match(c, /^#[0-9a-f]{6}$/, sel + ': ' + c);
    assert.ok(contrast(c, card) >= 4.5, sel + ': ' + c + ' on ' + card + ' is ' + contrast(c, card).toFixed(2) + ':1');
  }
  assert.ok(contrast(palette['--pdp-text-muted'], card) < 4.5, 'the muted colour is too faint for these texts');
  // A blocked node (while a pod is picked) is marked by its frame, never dimmed: its free CPU and RAM stay readable.
  for (const rule of rules) {
    if (rule.selectors.some((s) => /^\.pdp-node/.test(s))) assert.equal(rule.decls.opacity, undefined, rule.selectors.join(', '));
  }
  const blocked = declsAt(rules, '.pdp-node--blocked', 320);
  assert.match(blocked['border-color'], /^rgba\(239, 68, 68/);
  assert.match(blocked['box-shadow'], /^inset 4px 0 0 /);
});

// ── Random numbers and levels ────────────────────────────────────────────────

test('pod-packer: FNV-1a and mulberry32 match their reference values, and level N is seeded from "pdp:level-N"', () => {
  assert.equal(pdp.pdpHash(''), 0x811c9dc5);
  assert.equal(pdp.pdpHash('a'), 0xe40c292c);
  assert.equal(pdp.pdpHash('foobar'), 0xbf9cf968);
  for (const text of ['pdp:level-1', 'pdp:level-50', 'Pod Packer']) assert.equal(pdp.pdpHash(text), fnv1a(text), text);
  for (const seed of [0, 1, 42, 0xffffffff, pdp.pdpLevelSeed(3)]) {
    const mine = pdp.pdpMulberry32(seed);
    const reference = seeded(seed);
    for (let i = 0; i < 20; i++) assert.equal(mine(), reference(), 'seed ' + seed + ' draw ' + i);
  }
  for (let n = 1; n <= MAX_LEVEL; n++) assert.equal(pdp.pdpLevelSeed(n), fnv1a('pdp:level-' + n));
  assert.equal(LEVEL1.seed, fnv1a('pdp:level-1'));
  assert.equal(LEVEL4.seed, fnv1a('pdp:level-4'));
});

test('pod-packer: pdpCut splits a total into whole parts of at least 1, every split equally likely; pdpShuffle permutes', () => {
  const rnd = seeded(11);
  for (let total = 1; total <= 16; total++) {
    for (let parts = 1; parts <= Math.min(total, 4); parts++) {
      const cut = pdp.pdpCut(total, parts, rnd);
      assert.equal(cut.length, parts);
      assert.equal(sum(cut), total);
      assert.ok(cut.every((x) => Number.isInteger(x) && x >= 1), JSON.stringify(cut));
    }
  }
  // 6 into 3 parts has C(5, 2) = 10 splits; 3000 draws see each about 300 times.
  const counts = new Map();
  for (let k = 0; k < 3000; k++) {
    const key = pdp.pdpCut(6, 3, rnd).join(',');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  assert.equal(counts.size, 10);
  for (const [key, count] of counts) assert.ok(count > 220 && count < 380, key + ' ' + count);
  assert.deepEqual(pdp.pdpCut(5, 1, rnd), [5]);
  // A stuck source still splits (every loop is bounded).
  assert.deepEqual(pdp.pdpCut(5, 3, () => 0), [1, 1, 3]);
  const shuffled = pdp.pdpShuffle([1, 2, 3, 4, 5], rnd);
  assert.deepEqual([...shuffled].sort(), [1, 2, 3, 4, 5]);
  const list = [1, 2, 3];
  pdp.pdpShuffle(list, rnd);
  assert.deepEqual(list, [1, 2, 3], 'the input is left alone');
});

test('pod-packer: levels 1 and 4 are pinned: the same nodes, pods, start and solution for every visitor', (t) => {
  t.mock.method(Math, 'random', () => {
    throw new Error('a level never uses Math.random');
  });
  for (const [number, pinned] of [[1, LEVEL1], [4, LEVEL4]]) {
    const lv = levelOf(number);
    assert.equal(lv.number, number);
    assert.equal(lv.seed, pinned.seed);
    assert.deepEqual(lv.nodes, pinned.nodes, 'level ' + number + ' nodes');
    assert.deepEqual(lv.pods, pinned.pods, 'level ' + number + ' pods');
    assert.deepEqual(lv.start, pinned.start);
    assert.deepEqual(lv.solution, pinned.solution);
    assert.deepEqual(lv.target, { nodes: 2, exact: true });
    assert.deepEqual(levelOf(number), lv, 'the same every time');
  }
  assert.equal(levelOf(4).minEvictions, 2);
  assert.equal(levelOf(4).minMoves, 8);
  assert.deepEqual(levelOf(1).nodes.map((n) => n.name), ['node-1', 'node-2', 'node-3']);
  assert.notDeepEqual(levelOf(2).pods, levelOf(1).pods);
});

test('pod-packer: on 40 seeds per level, levels 1 to 14 turn on their rules and the generated solution keeps every one of them (independent checker)', (t) => {
  t.mock.method(Math, 'random', () => {
    throw new Error('a level never uses Math.random');
  });
  let maxMeter = 0;
  let maxPodLine = 0;
  for (let number = 1; number <= 14; number++) {
    const [k, spare, pods, anti, taint, drain] = tableRow(number);
    assert.deepEqual(pdp.pdpLevelSpec(number), { k, spare, pods, anti, taint, drain });
    for (let s = 0; s < 40; s++) {
      const seed = (s * 2654435761 + number) >>> 0;
      const where = 'level ' + number + ' seed ' + seed;
      const lv = pdp.pdpBuildLevel(number, seed);
      assert.deepEqual(Object.keys(lv).sort(), ['minEvictions', 'minMoves', 'nodes', 'number', 'pods', 'seed', 'solution', 'start', 'target', 'upper']);
      assert.equal(lv.nodes.length, k + spare + (drain ? 1 : 0), where);
      assert.ok(lv.nodes.length <= 6, where + ': keys 1-6 reach every node');
      assert.deepEqual(lv.nodes.map((n) => n.name), lv.nodes.map((n, j) => 'node-' + (j + 1)));
      assert.equal(lv.pods.length, pods, where);
      assert.equal(lv.upper, k);
      // The generated solution: every pod scheduled within k nodes, every rule kept, every node of it full.
      assert.deepEqual(violations(lv, lv.solution), [], where);
      assert.equal(scheduled(lv, lv.solution), true, where);
      assert.equal(usedNodes(lv, lv.solution), k, where);
      for (const j of new Set(lv.solution)) {
        assert.equal(sum(onNode(lv, lv.solution, j).map((p) => p.cpu)), lv.nodes[j].cpu, where + ': cpu of ' + lv.nodes[j].name + ' is full');
        assert.equal(sum(onNode(lv, lv.solution, j).map((p) => p.mem)), lv.nodes[j].mem, where + ': memory full');
        assert.ok(onNode(lv, lv.solution, j).length >= 2 && onNode(lv, lv.solution, j).length <= 4, where);
      }
      // Sizes: nodes of 2, 3, 4 or 6 CPU and 2, 4, 6 or 8 GiB (the draining node holds its pods); pods of at least 0.5.
      for (const n of lv.nodes) {
        if (!n.drain) {
          assert.ok([4, 6, 8, 12].includes(n.cpu) && [4, 8, 12, 16].includes(n.mem), where + ': ' + JSON.stringify(n));
        }
        maxMeter = Math.max(maxMeter, (units(n.cpu) + '/' + units(n.cpu) + ' CPU').length, (units(n.mem) + '/' + units(n.mem) + ' GiB').length);
      }
      for (const p of lv.pods) {
        assert.ok(Number.isInteger(p.cpu) && p.cpu >= 1 && Number.isInteger(p.mem) && p.mem >= 1, where);
        assert.match(p.name, /^[a-z]+-[1-3]$/);
        maxPodLine = Math.max(maxPodLine, (units(p.cpu) + ' CPU · ' + units(p.mem) + ' GiB').length, pdp.pdpPodTags(p).length);
      }
      // Anti-affinity: anti identical replicas named app-1..app-n; every other app once.
      const replicas = lv.pods.filter((p) => p.anti);
      assert.equal(replicas.length, anti, where);
      assert.equal(new Set(replicas.map((p) => p.app)).size, anti ? 1 : 0);
      assert.equal(new Set(replicas.map((p) => p.cpu + ':' + p.mem)).size, anti ? 1 : 0, where + ': replicas are identical');
      assert.deepEqual(replicas.map((p) => p.name).sort(), replicas.map((p, i) => p.app + '-' + (i + 1)));
      const apps = lv.pods.filter((p) => !p.anti).map((p) => p.app);
      assert.equal(new Set(apps).size, apps.length, where + ': one pod per other app');
      // Taint: one gpu node, one ml pod that needs it, tolerations only for the pods of that node.
      const tainted = lv.nodes.filter((n) => n.taint !== null);
      assert.deepEqual(tainted.map((n) => n.taint), taint ? ['gpu'] : [], where);
      assert.deepEqual(lv.pods.filter((p) => p.needs).map((p) => [p.name, p.needs, p.tolerates]), taint ? [['ml-1', 'gpu', 'gpu']] : []);
      lv.pods.forEach((p, i) => {
        assert.equal(p.tolerates !== null, taint && lv.nodes[lv.solution[i]].taint === 'gpu', where + ': ' + p.name);
      });
      // Drain: its pods start there, of distinct apps, none needing gpu, and it holds them.
      const d = drainOf(lv);
      assert.equal(d !== -1, drain > 0, where);
      assert.deepEqual(lv.start.filter((x) => x !== -1).length, drain);
      if (d !== -1) {
        const held = onNode(lv, lv.start, d);
        assert.ok(lv.start.every((x) => x === -1 || x === d));
        assert.equal(new Set(held.map((p) => p.app)).size, held.length);
        assert.ok(held.every((p) => p.needs === null));
        assert.equal(lv.nodes[d].cpu, 2 * Math.ceil(sum(held.map((p) => p.cpu)) / 2));
        assert.equal(lv.nodes[d].mem, 2 * Math.ceil(sum(held.map((p) => p.mem)) / 2));
        assert.equal(lv.solution.includes(d), false);
      } else {
        assert.ok(lv.start.every((x) => x === -1));
      }
      assert.deepEqual(violations(lv, lv.start), [], where + ': the start breaks no rule');
      assert.equal(lv.minEvictions, drain);
      assert.equal(lv.minMoves, pods + drain);
      // The target: exact, never above the generator's k, and as good as the generated solution.
      assert.equal(lv.target.exact, true, where);
      assert.ok(lv.target.nodes <= k && lv.target.nodes >= 1, where);
    }
  }
  assert.ok(maxMeter <= '16.5/16.5 GiB'.length, 'the longest bar value the layout test allows: ' + maxMeter);
  assert.ok(maxPodLine <= '6.5 CPU · 7.5 GiB'.length, 'the longest pod line the layout test allows: ' + maxPodLine);
  // A stuck random source still builds a level that can be scheduled.
  for (let number = 1; number <= 12; number++) {
    const lv = pdp.pdpGenerate(number, () => 0);
    assert.equal(scheduled(lv, lv.solution), true, 'stuck source, level ' + number);
  }
  assert.deepEqual(pdp.pdpLevelSpec(50), pdp.pdpLevelSpec(12), 'levels past the table repeat its last row');
});

test('pod-packer: the target is the exact minimum of nodes, checked against a brute force over every assignment', () => {
  let below = 0;
  let checked = 0;
  for (let number = 1; number <= 8; number++) {
    for (let s = 0; s < (number <= 4 ? 25 : 6); s++) {
      const lv = pdp.pdpBuildLevel(number, (s * 40503 + number * 7) >>> 0);
      if (lv.pods.length > 8) continue;
      const min = bruteMin(lv);
      assert.equal(lv.target.nodes, min, 'level ' + number + ' seed ' + lv.seed);
      assert.equal(pdp.pdpMinNodes(lv, lv.upper, 1e7).nodes, min);
      if (min < lv.upper) below++;
      checked++;
    }
  }
  assert.ok(checked >= 100, checked + ' levels checked');
  assert.ok(below >= 1, 'a spare node sometimes beats the generated solution');
  // A level where a big spare node holds everything: the target drops to one node.
  const lv = handLevel();
  lv.nodes.push(node('node-4', 24, 24));
  lv.start = lv.start.map(() => -1);
  lv.pods = lv.pods.map((p) => Object.assign({}, p, { needs: null, tolerates: null, anti: false }));
  assert.equal(bruteMin(lv), 1);
  assert.deepEqual(pdp.pdpMinNodes(lv, 3, 1e6), { nodes: 1, exact: true });
  // Out of steps: the upper bound comes back, marked as not exact (a par).
  const big = levelOf(12);
  assert.deepEqual(pdp.pdpMinNodes(big, big.upper, 5), { nodes: big.upper, exact: false });
  // The independent search agrees with the brute force where both run.
  for (let number = 1; number <= 4; number++) {
    const small = levelOf(number);
    assert.equal(independentMin(small).nodes, bruteMin(small), 'level ' + number);
  }
});

test('pod-packer: all 50 real levels keep every rule in their generated solution, and each target is the exact minimum (an independent search)', () => {
  for (let number = 1; number <= MAX_LEVEL; number++) {
    const lv = levelOf(number);
    const where = 'level ' + number;
    assert.equal(lv.pods.length, tableRow(number)[2], where);
    assert.deepEqual(violations(lv, lv.solution), [], where);
    assert.equal(scheduled(lv, lv.solution), true, where);
    assert.deepEqual(violations(lv, lv.start), [], where + ': the start breaks no rule');
    assert.equal(lv.target.exact, true, where + ': the search finished within its budget');
    const min = independentMin(lv);
    assert.equal(lv.target.nodes, min.nodes, where + ': the target is the independent minimum');
    // The witness is a real schedule on that many nodes.
    assert.equal(scheduled(lv, min.place), true, where);
    assert.equal(usedNodes(lv, min.place), min.nodes, where);
  }
});

test('pod-packer: on 10 to 12 pods the search finds the minimum from a loose bound, also where it beats the generator\'s node count (an independent search)', () => {
  // From level 9 on, three replicas (no toleration) need three non-gpu nodes and ml-1 the gpu node, so the
  // minimum is the generator's 4 on every real level.  To catch a pruning bug that would miss better schedules,
  // the search also runs on the same levels with those rules lifted (and one node grown to 8 CPU / 12 GiB),
  // where fewer nodes often do, starting from every usable node as its bound instead of the generator's count.
  let below = 0;
  let checked = 0;
  for (let number = 9; number <= 14; number++) {
    for (let s = 0; s < 30; s++) {
      const lv = pdp.pdpBuildLevel(number, (s * 2246822519 + number * 101) >>> 0);
      const where = 'level ' + number + ' seed ' + lv.seed;
      assert.ok(lv.pods.length >= 10 && lv.pods.length <= 12, where);
      const usable = lv.nodes.filter((n) => !n.drain).length;
      assert.deepEqual(lv.target, { nodes: 4, exact: true }, where);
      const free = Object.assign({}, lv, {
        pods: lv.pods.map((p) => Object.assign({}, p, { anti: false, tolerates: null, needs: null })),
        nodes: lv.nodes.map((n) => Object.assign({}, n, { taint: null }))
      });
      const grown = Object.assign({}, free, { nodes: free.nodes.map((n) => Object.assign({}, n)) });
      Object.assign(grown.nodes.find((n) => !n.drain), { cpu: 16, mem: 24 });
      for (const [name, g] of [['as generated', lv], ['rules lifted', free], ['a node grown', grown]]) {
        const min = independentMin(g);
        assert.deepEqual(pdp.pdpMinNodes(g, usable, 1e6), { nodes: min.nodes, exact: true }, where + ', ' + name);
        assert.equal(scheduled(g, min.place), true, where + ', ' + name);
        if (min.nodes < lv.upper) below++;
        checked++;
      }
    }
  }
  assert.equal(checked, 540);
  assert.ok(below >= 100, below + ' of ' + checked + ' levels need fewer nodes than the generator used');
});

// ── Rules, moves and texts ───────────────────────────────────────────────────

test('pod-packer: refusals name the rule and the values, and agree with the independent checker', () => {
  const lv = handLevel();
  const empty = lv.start.slice();
  const refuse = (place, p, n) => pdp.pdpRefusal(lv, place, p, n);
  assert.equal(refuse(empty, 0, 2), 'node-3 is draining: it accepts no new pods.');
  assert.equal(refuse(empty, 0, 1), 'Taint gpu on node-2: pod api-1 has no toleration for it.');
  assert.equal(refuse(empty, 3, 0), 'Node selector: pod ml-1 needs a gpu node, and node-1 has no gpu.');
  assert.equal(refuse(empty, 3, 1), '');
  assert.equal(refuse(empty, 4, 1), '', 'a toleration lets a pod onto the tainted node');
  assert.equal(refuse(empty, 4, 0), '', 'and anywhere else');
  assert.equal(refuse([0, -1, -1, -1, -1, 2], 1, 0), 'Anti-affinity: pod api-2 cannot share node-1 with api-1 (app api).');
  // node-1 has 4.0 CPU / 4.0 GiB; big-1 takes 3.0 / 3.5.
  assert.equal(refuse([-1, -1, 0, -1, -1, 2], 0, 0), 'Insufficient cpu and memory: pod api-1 needs 1.5 CPU and 1.0 GiB, node-1 has 1.0 CPU and 0.5 GiB free.');
  assert.equal(refuse([-1, -1, 0, -1, 0, 2], 3, 1), '');
  lv.pods[4] = pod('batch-1', 1, 1, { tolerates: 'gpu' });
  assert.equal(refuse([-1, -1, 0, -1, -1, 2], 4, 0), '', 'exactly the room left');
  lv.pods.push(pod('tiny-1', 2, 1));
  lv.start.push(-1);
  assert.equal(refuse([-1, -1, 0, -1, -1, 2, -1], 6, 0), '', 'room for exactly 1.0 CPU and 0.5 GiB');
  lv.pods[6] = pod('tiny-1', 3, 1);
  assert.equal(refuse([-1, -1, 0, -1, -1, 2, -1], 6, 0), 'Insufficient cpu: pod tiny-1 needs 1.5 CPU, node-1 has 1.0 CPU free.');
  lv.pods[6] = pod('tiny-1', 1, 2);
  assert.equal(refuse([-1, -1, 0, -1, -1, 2, -1], 6, 0), 'Insufficient memory: pod tiny-1 needs 1.0 GiB, node-1 has 0.5 GiB free.');
  // The pod itself never counts against its own node.
  assert.equal(refuse([-1, -1, -1, -1, -1, 2, 0], 6, 0), '');

  // On random reachable placements of generated levels the game refuses exactly what the checker forbids.
  const rnd = seeded(5);
  for (let number = 1; number <= 12; number++) {
    const g = levelOf(number);
    let place = g.start.slice();
    for (let step = 0; step < 30; step++) {
      for (let i = 0; i < g.pods.length; i++) {
        if (place[i] !== -1) continue;
        for (let j = 0; j < g.nodes.length; j++) {
          const trial = place.slice();
          trial[i] = j;
          // The draining node takes nothing, not even a pod it held before.
          const allowed = !g.nodes[j].drain && violations(g, trial).length === 0;
          assert.equal(pdp.pdpRefusal(g, place, i, j) === '', allowed, 'level ' + number + ' pod ' + i + ' node ' + j);
        }
      }
      // A random legal step: evict something, or run a pending pod where it fits.
      const i = Math.floor(rnd() * g.pods.length);
      if (place[i] !== -1) place[i] = -1;
      else {
        const fits = g.nodes.map((n, j) => j).filter((j) => pdp.pdpRefusal(g, place, i, j) === '');
        if (fits.length) place[i] = fits[Math.floor(rnd() * fits.length)];
      }
      assert.deepEqual(violations(g, place), []);
      place = place.slice();
    }
  }
});

test('pod-packer: pdpApplyMove places, evicts and undoes on a copy, counting moves and evictions; undo counts like the opposite move', () => {
  const lv = levelOf(4);
  const game = pdp.pdpNewGame(lv);
  assert.deepEqual(game, { level: lv, place: lv.start, history: [], moves: 0, evictions: 0 });
  assert.notEqual(game.place, lv.start, 'a copy of the start');
  // Evict queue-1 from the draining node-3, run it on node-4.
  let r = pdp.pdpApplyMove(game, { type: 'evict', pod: 2 });
  assert.equal(r.error, '');
  assert.deepEqual(game.place, lv.start, 'the input is left alone');
  assert.deepEqual(r.game.place, [-1, -1, -1, -1, 2, -1]);
  assert.deepEqual([r.game.moves, r.game.evictions, r.game.history], [1, 1, []], 'an eviction from the draining node is final: not on the history');
  r = pdp.pdpApplyMove(r.game, { type: 'place', pod: 2, node: 3 });
  assert.deepEqual([r.game.place[2], r.game.moves, r.game.evictions], [3, 2, 1]);
  assert.deepEqual(r.game.history, [[2, -1, 3]]);
  // Refusals leave the game as it was.
  const before = r.game;
  for (const [move, error] of [
    [{ type: 'place', pod: 2, node: 0 }, 'Pod queue-1 already runs on node-4: evict it first (E, or tap it).'],
    [{ type: 'evict', pod: 0 }, 'Pod cron-1 is pending: there is nothing to evict.'],
    [{ type: 'place', pod: 0, node: 2 }, 'node-3 is draining: it accepts no new pods.'],
    // node-2 has 2.0 CPU / 4.0 GiB; queue-1 asks for 2.0 / 3.5 and runs on node-4 already, metrics-1 asks for 2.0 / 2.5.
    [{ type: 'place', pod: 5, node: 1 }, ''],
    [{ type: 'place', pod: 0, node: 1 }, '']
  ]) {
    const out = pdp.pdpApplyMove(before, move);
    assert.equal(out.error, error, JSON.stringify(move));
    if (error) assert.equal(out.game, before);
    else assert.notEqual(out.game, before);
  }
  // auth-1 (0.5 CPU, 1.5 GiB) on node-2 leaves 1.5 CPU and 2.5 GiB: enough memory for metrics-1, not enough CPU.
  const half = pdp.pdpApplyMove(before, { type: 'place', pod: 3, node: 1 }).game;
  assert.equal(pdp.pdpApplyMove(half, { type: 'place', pod: 5, node: 1 }).error,
    'Insufficient cpu: pod metrics-1 needs 2.0 CPU, node-2 has 1.5 CPU free.');
  // Undo of a placement is an eviction; the eviction from the draining node before it is not undone.
  r = pdp.pdpApplyMove(before, { type: 'undo' });
  assert.deepEqual([r.error, r.game.place[2], r.game.moves, r.game.evictions, r.game.history], ['', -1, 3, 2, []]);
  const nothing = pdp.pdpApplyMove(r.game, { type: 'undo' });
  assert.equal(nothing.error, 'Nothing to undo on level 4.');
  assert.equal(nothing.game, r.game);
  // Older actions stay in reach past a final eviction: cron-1 on node-1, then queue-1 off the draining node.
  let older = pdp.pdpApplyMove(pdp.pdpNewGame(lv), { type: 'place', pod: 0, node: 0 }).game;
  older = pdp.pdpApplyMove(older, { type: 'evict', pod: 2 }).game;
  assert.deepEqual(older.history, [[0, -1, 0]]);
  older = pdp.pdpApplyMove(older, { type: 'undo' }).game;
  assert.deepEqual([older.place, older.history, older.moves, older.evictions], [[-1, -1, -1, -1, 2, -1], [], 3, 2]);
  // On random play every entry left on the history can be undone, down to an empty history.
  const rnd = seeded(9);
  for (const number of [4, 8, 10, 12]) {
    const g0 = levelOf(number);
    let g = pdp.pdpNewGame(g0);
    for (let step = 0; step < 60; step++) {
      const i = Math.floor(rnd() * g0.pods.length);
      const move = g.place[i] !== -1 ? { type: 'evict', pod: i } : { type: 'place', pod: i, node: Math.floor(rnd() * g0.nodes.length) };
      const out = pdp.pdpApplyMove(g, move);
      if (!out.error && !pdp.pdpIsPassed(out.game)) g = out.game;
    }
    assert.equal(pdp.pdpHistoryValid(g0, g.place, g.history), true, 'level ' + number);
    assert.ok(g.history.length >= 10, 'level ' + number + ': a long history');
    // (An undo that happens to pass the level ends the walk: a passed level takes no more moves.)
    for (let k = g.history.length; k > 0 && !pdp.pdpIsPassed(g); k--) {
      const out = pdp.pdpApplyMove(g, { type: 'undo' });
      assert.equal(out.error, '', 'level ' + number + ': undo ' + k);
      assert.deepEqual(violations(g0, out.game.place), []);
      g = out.game;
    }
    assert.ok(g.history.length === 0 || pdp.pdpIsPassed(g), 'level ' + number);
  }
  // Undo of an eviction from a plain node puts the pod back.
  let g = pdp.pdpApplyMove(pdp.pdpNewGame(lv), { type: 'place', pod: 0, node: 0 }).game;
  g = pdp.pdpApplyMove(g, { type: 'evict', pod: 0 }).game;
  r = pdp.pdpApplyMove(g, { type: 'undo' });
  assert.deepEqual([r.error, r.game.place[0], r.game.moves, r.game.evictions], ['', 0, 3, 1]);
  assert.deepEqual(r.game.history, [[0, -1, 0]]);
  assert.equal(pdp.pdpApplyMove(pdp.pdpNewGame(lv), { type: 'undo' }).error, 'Nothing to undo on level 4.');
  // The history keeps the last 200 actions.
  g = pdp.pdpNewGame(lv);
  for (let k = 0; k < 150; k++) {
    g = pdp.pdpApplyMove(g, { type: 'place', pod: 0, node: 0 }).game;
    g = pdp.pdpApplyMove(g, { type: 'evict', pod: 0 }).game;
  }
  assert.equal(g.history.length, 200);
  assert.equal(g.moves, 300);
  assert.equal(g.evictions, 150);
  assert.deepEqual(g.history[0], [0, -1, 0]);
  // A passed level takes no more moves.
  let won = pdp.pdpNewGame(lv);
  lv.pods.forEach((p, i) => {
    if (won.place[i] !== -1) won = pdp.pdpApplyMove(won, { type: 'evict', pod: i }).game;
    won = pdp.pdpApplyMove(won, { type: 'place', pod: i, node: lv.solution[i] }).game;
  });
  assert.equal(pdp.pdpIsPassed(won), true);
  assert.deepEqual([won.moves, won.evictions], [lv.minMoves, lv.minEvictions]);
  for (const move of [{ type: 'undo' }, { type: 'evict', pod: 0 }]) {
    assert.equal(pdp.pdpApplyMove(won, move).error, 'Level 4 is scheduled: start level 5 with Next level, or restart it to play it again.');
  }
  assert.equal(pdp.pdpApplyMove(Object.assign({}, won, { level: Object.assign({}, lv, { number: 50 }) }), { type: 'undo' }).error,
    'Level 50 is scheduled: restart it to play it again.');
});

test('pod-packer: a level is passed when every pod runs off the draining node within the target, and the texts say how far it is', () => {
  const lv = levelOf(4);
  const game = (place, moves = 0, evictions = 0) => ({ level: lv, place, history: [], moves, evictions });
  assert.equal(pdp.pdpIsPassed(game(lv.start)), false);
  assert.equal(pdp.pdpStatusText(game(lv.start)), 'Schedule every pod on at most 2 nodes: 4 pods pending, node-3 still runs 2 pods to move.');
  assert.equal(pdp.pdpStatusText(game([0, 0, 2, 0, 2, 3])), 'Schedule every pod on at most 2 nodes: 0 pods pending, node-3 still runs 2 pods to move.');
  assert.equal(pdp.pdpStatusText(game([0, 0, -1, 0, 0, 3])), 'Schedule every pod on at most 2 nodes: 1 pod pending.');
  // Every pod runs, but on three nodes.
  const spread = [0, 1, 3, 0, 0, 3];
  assert.deepEqual(violations(lv, spread), []);
  assert.equal(pdp.pdpUsedNodes(lv, spread), 3);
  assert.equal(pdp.pdpIsPassed(game(spread)), false);
  assert.equal(pdp.pdpStatusText(game(spread)), 'All 6 pods run, but on 3 nodes (target 2). Free a node to pass: evict its pods and fit them elsewhere.');
  assert.equal(pdp.pdpIsPassed(game(lv.solution)), true);
  assert.equal(pdp.pdpStatusText(game(lv.solution, 8, 2)), 'Level 4 scheduled: 6 pods on 2 nodes (target 2), 2 evictions (min 2), 8 moves (min 8). Optimal schedule.');
  assert.equal(pdp.pdpResultText(game(lv.solution, 11, 3)), 'Level 4 scheduled: 6 pods on 2 nodes (target 2), 3 evictions (min 2), 11 moves (min 8).');
  assert.equal(pdp.pdpResultText(game(lv.solution, 8, 3)), 'Level 4 scheduled: 6 pods on 2 nodes (target 2), 3 evictions (min 2), 8 moves (min 8).');
  // Usage per node.
  assert.deepEqual(pdp.pdpUsage(lv, lv.solution, 0), { cpu: 6, mem: 16, pods: 4 });
  assert.deepEqual(pdp.pdpUsage(lv, lv.solution, 1), { cpu: 0, mem: 0, pods: 0 });
  // A level without a draining node, and one whose target is a par.
  const one = levelOf(1);
  assert.equal(pdp.pdpStatusText({ level: one, place: one.start, history: [], moves: 0, evictions: 0 }), 'Schedule every pod on at most 2 nodes: 5 pods pending.');
  assert.equal(pdp.pdpIsPassed({ level: one, place: one.solution, history: [], moves: 1, evictions: 1 }), true);
  assert.equal(pdp.pdpResultText({ level: one, place: one.solution, history: [], moves: 1, evictions: 1 }),
    'Level 1 scheduled: 5 pods on 2 nodes (target 2), 1 eviction (min 0), 1 move (min 5).');
  const par = Object.assign({}, one, { target: { nodes: 2, exact: false } });
  assert.equal(pdp.pdpGoalText(one), 'Level 1: run all 5 pods on at most 2 nodes (the exact minimum).');
  assert.equal(pdp.pdpGoalText(par), 'Level 1: run all 5 pods on at most 2 nodes (a par: fewer may be possible).');
  assert.match(pdp.pdpResultText({ level: par, place: one.solution, history: [], moves: 5, evictions: 0 }), /on 2 nodes \(par 2\)/);
  assert.equal(pdp.pdpGoalText(Object.assign({}, one, { target: { nodes: 1, exact: true } })), 'Level 1: run all 5 pods on at most 1 node (the exact minimum).');
});

test('pod-packer: the rules lines, pod tags, units and the screen order of pods', () => {
  assert.deepEqual(pdp.pdpRuleLines(levelOf(1)), ['Resources: a pod runs only on a node with enough CPU and memory left.']);
  const lv = handLevel();
  assert.deepEqual(pdp.pdpRuleLines(lv), [
    'Resources: a pod runs only on a node with enough CPU and memory left.',
    'Anti-affinity: the 2 replicas of api (api-1, api-2) never share a node.',
    'Taint gpu on node-2: only pods that tolerate gpu run there, and ml-1 needs it.',
    'Drain node-3: it takes no new pods; evict its 1 pod and run them elsewhere (Undo cannot put a pod back on it).'
  ]);
  assert.deepEqual(pdp.pdpRuleLines(levelOf(10)).map((line) => line.split(':')[0]), ['Resources', 'Anti-affinity', 'Taint gpu on ' + levelOf(10).nodes.find((n) => n.taint).name, 'Drain ' + levelOf(10).nodes.find((n) => n.drain).name]);
  assert.deepEqual(lv.pods.map(pdp.pdpPodTags), ['anti-affinity', 'anti-affinity', '', 'needs gpu', 'tolerates gpu', '']);
  assert.equal(pdp.pdpPodTags(pod('x-1', 1, 1, { anti: true, tolerates: 'gpu' })), 'anti-affinity · tolerates gpu');
  assert.deepEqual([1, 2, 3, 15, 24].map(pdp.pdpUnits), ['0.5', '1.0', '1.5', '7.5', '12.0']);
  // The queue first, then node by node, each in pod order.
  assert.deepEqual(pdp.pdpVisualOrder({ level: lv, place: [1, -1, 0, -1, 1, 2] }), [1, 3, 2, 0, 4, 5]);
});

test('pod-packer: keys map to actions by their value, then by the physical key on other layouts', () => {
  const action = (key, props) => pdp.pdpKeyAction(keyEvent(key, props));
  assert.deepEqual(['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'e', 'E', 'u', 'U', 'n', 'N', 'Escape'].map((k) => action(k)), [
    { type: 'prev' }, { type: 'prev' }, { type: 'next' }, { type: 'next' }, { type: 'evict' }, { type: 'evict' },
    { type: 'undo' }, { type: 'undo' }, { type: 'advance' }, { type: 'advance' }, { type: 'clear' }
  ]);
  assert.deepEqual(['1', '2', '3', '4', '5', '6'].map((k) => action(k)), [0, 1, 2, 3, 4, 5].map((n) => ({ type: 'node', node: n })));
  assert.equal(action('7'), null);
  assert.equal(action('0'), null);
  // AZERTY digits need Shift, so the physical key counts; so does the keypad.
  assert.deepEqual(action('&', { code: 'Digit1' }), { type: 'node', node: 0 });
  assert.deepEqual(action('End', { code: 'Numpad6' }), { type: 'node', node: 5 });
  assert.equal(action('x', { code: 'Digit7' }), null);
  assert.deepEqual(action('у', { code: 'KeyE' }), { type: 'evict' });
  assert.deepEqual(action('г', { code: 'KeyU' }), { type: 'undo' });
  assert.deepEqual(action('т', { code: 'KeyN' }), { type: 'advance' });
  assert.equal(action('ф', { code: 'KeyA' }), null);
  assert.equal(action('Tab'), null);
  assert.equal(pdp.pdpKeyAction(keyEvent(undefined)), null, 'an autofill keydown has no key');
  assert.equal(pdp.pdpKeyAction(createEvent('keydown', { key: 'x' })), null, 'no code at all');
});

// ── Saves (pure) ─────────────────────────────────────────────────────────────

test('pod-packer: pdpParseState reads a save of the current format field for field, and writes it back the same', () => {
  const game = pdp.pdpParseState(SAMPLE_SAVE, 1);
  assert.equal(game.level.number, 4);
  assert.equal(game.level.seed, LEVEL4.seed);
  assert.deepEqual(game.level.pods, LEVEL4.pods);
  assert.deepEqual(game.place, [0, -1, 3, -1, 2, -1]);
  assert.deepEqual(game.history, [[2, -1, 3], [0, -1, 0]]);
  assert.equal(game.moves, 3);
  assert.equal(game.evictions, 1);
  assert.equal(JSON.stringify(pdp.pdpSerializeState(game)), SAMPLE_SAVE);
  assert.deepEqual(Object.keys(pdp.pdpSerializeState(game)), ['v', 'level', 'seed', 'place', 'history', 'moves', 'evictions']);
  // The parsed arrays are copies.
  const raw = JSON.parse(SAMPLE_SAVE);
  const parsedFromObject = pdp.pdpParseState(JSON.stringify(raw), 1);
  parsedFromObject.history[0][0] = 9;
  assert.equal(raw.history[0][0], 2);
  // Another seed builds that board (a save from a later version that varies them still loads).
  const other = pdp.pdpParseState(JSON.stringify({ level: 4, seed: 12345 }), 1);
  assert.equal(other.level.seed, 12345);
  assert.deepEqual(other.level, pdp.pdpBuildLevel(4, 12345));
});

test('pod-packer: pdpParseState falls back field by field', () => {
  const good = () => JSON.parse(SAMPLE_SAVE);
  const parse = (fn, fallback = 1) => {
    const save = good();
    fn(save);
    return pdp.pdpParseState(JSON.stringify(save), fallback);
  };
  const lv4 = levelOf(4);
  // The level.
  for (const bad of [0, 51, 2.5, '4', null, -1]) {
    const p = parse((s) => { s.level = bad; }, 3);
    assert.equal(p.level.number, 3, 'level ' + bad);
    assert.equal(p.level.seed, pdp.pdpLevelSeed(3), 'its own seed: the saved one belongs to another level only by chance');
  }
  assert.equal(parse((s) => { s.level = 50; delete s.seed; }).level.number, 50);
  // The seed.
  for (const bad of [-1, 1.5, '1703355346', 4294967296, null]) assert.equal(parse((s) => { s.seed = bad; }).level.seed, LEVEL4.seed, 'seed ' + bad);
  assert.equal(parse((s) => { s.seed = 4294967295; }).level.seed, 4294967295);
  // The placement: kept when it keeps the rules, else the level's start (and the history that led to it goes too).
  for (const [name, place] of [
    ['not a list', 'x'], ['too short', [0, -1, 3]], ['a text node', [0, -1, '3', -1, 2, -1]], ['a node off the level', [0, -1, 4, -1, 2, -1]],
    ['below the queue', [0, -2, 3, -1, 2, -1]], ['a fraction', [0, -1, 3.5, -1, 2, -1]],
    ['a new pod on the draining node', [2, -1, 3, -1, 2, -1]], ['too much on node-2', [1, 1, 1, -1, 2, -1]]
  ]) {
    const p = parse((s) => { s.place = place; });
    assert.deepEqual(p.place, lv4.start, name);
    assert.deepEqual(p.history, [], name + ': the history no longer leads anywhere');
    assert.equal(p.moves, 3, name + ': the counters stay');
    assert.equal(p.evictions, 1);
  }
  assert.deepEqual(parse((s) => { s.place = lv4.solution; s.history = []; }).place, lv4.solution);
  // The history on its own.
  for (const [name, history] of [
    ['not a list', {}], ['an entry that is no triple', [[2, -1], [0, -1, 0]]], ['a text pod', [[2, -1, 3], ['0', -1, 0]]],
    ['a pod off the level', [[2, -1, 3], [6, -1, 0]]], ['a negative pod', [[-1, 2, -1], [2, -1, 3], [0, -1, 0]]],
    ['a node off the level', [[2, 9, -1], [2, -1, 3], [0, -1, 0]]], ['a target off the level', [[2, -1, 9], [0, -1, 0]]],
    ['node to node', [[2, 2, 3], [0, -1, 0]]], ['queue to queue', [[2, -1, -1], [2, -1, 3], [0, -1, 0]]],
    ['not leading to the placement', [[2, -1, 3], [0, -1, 1]]], ['too long', new Array(201).fill([0, -1, 0])],
    // Undo can never put a pod back on the draining node (the old shape of this history).
    ['an eviction from the draining node', [[2, 2, -1], [2, -1, 3], [0, -1, 0]]],
    // Undoing the oldest entry would run metrics-1 (2.0 CPU) next to queue-1 (2.0 CPU) on node-1 (3.0 CPU).
    ['an undo that breaks a rule', [[5, 0, -1], [2, 0, -1], [2, -1, 3], [0, -1, 0]]]
  ]) {
    const p = parse((s) => { s.history = history; });
    assert.deepEqual(p.history, [], name);
    assert.deepEqual(p.place, [0, -1, 3, -1, 2, -1], name + ': the placement stays');
  }
  assert.deepEqual(parse((s) => { s.history = s.history.slice(1); }).history, [[0, -1, 0]], 'a history cut at its limit still leads to the placement');
  // Two entries for queue-1 on node-1 and back that can be undone are kept.
  assert.deepEqual(parse((s) => { s.history = [[2, -1, 0], [2, 0, -1], [2, -1, 3], [0, -1, 0]]; }).history, [[2, -1, 0], [2, 0, -1], [2, -1, 3], [0, -1, 0]]);
  // The counters.
  for (const bad of [-1, 1.5, '3', null, Infinity]) {
    assert.equal(parse((s) => { s.moves = bad; }).moves, 0, 'moves ' + bad);
    assert.equal(parse((s) => { s.evictions = bad; }).evictions, 0, 'evictions ' + bad);
  }
  // Nothing usable at all: the fallback level, fresh.
  for (const text of [null, '', '{', '[]', '7', 'null', '"x"', '{}']) {
    const p = pdp.pdpParseState(text, 2);
    assert.equal(p.level.number, 2, String(text));
    assert.deepEqual(p.place, levelOf(2).start);
    assert.deepEqual([p.history, p.moves, p.evictions], [[], 0, 0]);
  }
  // pdpPlacementValid and pdpHistoryValid on their own.
  assert.equal(pdp.pdpPlacementValid(lv4, lv4.start), true);
  assert.equal(pdp.pdpPlacementValid(lv4, [0, 0, 2, 0, 0, 3]), true, 'a pod still on the draining node it started on');
  assert.equal(pdp.pdpPlacementValid(lv4, [2, 0, 2, 0, 0, 3]), false, 'a new pod on the draining node');
  assert.equal(pdp.pdpHistoryValid(lv4, lv4.start, []), true);
  assert.equal(pdp.pdpHistoryValid(lv4, lv4.start, null), false);
});

test('pod-packer: pdpParseProgress keeps the highest level and each level\'s best moves and evictions, each on its own', () => {
  assert.deepEqual(pdp.pdpParseProgress(SAMPLE_PROGRESS), {
    highest: 3, levels: { 1: { moves: 5, evictions: 0 }, 2: { moves: 7, evictions: 1 }, 3: { moves: 6, evictions: 0 } }
  });
  for (const text of [null, '', '{', '[]', '7', 'null']) assert.deepEqual(pdp.pdpParseProgress(text), { highest: 0, levels: {} }, String(text));
  const parsed = pdp.pdpParseProgress(JSON.stringify({
    highest: 2,
    levels: { 1: { moves: 5, evictions: -1 }, 2: 'x', 3: { moves: 1.5, evictions: '2' }, 4: { evictions: 2 }, 51: { moves: 1, evictions: 1 }, x: { moves: 1 }, 0: { moves: 1 } }
  }));
  assert.deepEqual(parsed, { highest: 4, levels: { 1: { moves: 5, evictions: null }, 4: { moves: null, evictions: 2 } } }, 'the highest record raises highest');
  for (const bad of [-1, 51, 2.5, '9']) assert.equal(pdp.pdpParseProgress(JSON.stringify({ highest: bad })).highest, 0, 'highest ' + bad);
  assert.equal(pdp.pdpParseProgress(JSON.stringify({ highest: 50, levels: [] })).highest, 50);
  assert.deepEqual(pdp.pdpParseProgress(JSON.stringify({ levels: Object.create(null) })), { highest: 0, levels: {} });
  // Two tabs' records merge level by level and field by field, keeping the lower of each and the higher level.
  const a = pdp.pdpParseProgress(SAMPLE_PROGRESS);
  const b = { highest: 5, levels: { 2: { moves: 9, evictions: 0 }, 3: { moves: null, evictions: 2 }, 5: { moves: 12, evictions: 3 } } };
  const merged = pdp.pdpMergeProgress(a, b);
  assert.deepEqual(merged, {
    highest: 5,
    levels: { 1: { moves: 5, evictions: 0 }, 2: { moves: 7, evictions: 0 }, 3: { moves: 6, evictions: 0 }, 5: { moves: 12, evictions: 3 } }
  });
  assert.deepEqual(pdp.pdpMergeProgress(b, a), merged, 'in either order');
  assert.notEqual(merged.levels[1], a.levels[1], 'copies');
  // Recording a pass.
  let r = pdp.pdpRecord(a, 4, 9, 2);
  assert.deepEqual([r.better, r.progress.highest, r.progress.levels[4]], [true, 4, { moves: 9, evictions: 2 }]);
  r = pdp.pdpRecord(r.progress, 4, 10, 2);
  assert.deepEqual([r.better, r.progress.levels[4]], [false, { moves: 9, evictions: 2 }]);
  r = pdp.pdpRecord(r.progress, 4, 12, 1);
  assert.deepEqual([r.better, r.progress.levels[4]], [true, { moves: 9, evictions: 1 }], 'fewer evictions is better too');
  r = pdp.pdpRecord(r.progress, 2, 8, 1);
  assert.deepEqual([r.better, r.progress.highest, r.progress.levels[2]], [false, 4, { moves: 7, evictions: 1 }], 'replaying a lower level keeps highest');
  r = pdp.pdpRecord({ highest: 1, levels: { 1: { moves: null, evictions: 3 } } }, 1, 6, 4);
  assert.deepEqual([r.better, r.progress.levels[1]], [true, { moves: 6, evictions: 3 }]);
  r = pdp.pdpRecord({ highest: 1, levels: { 1: { moves: 6, evictions: null } } }, 1, 7, 0);
  assert.deepEqual([r.better, r.progress.levels[1]], [true, { moves: 6, evictions: 0 }]);
  assert.deepEqual(a.levels[4], undefined, 'the input is left alone');
  // The best text.
  assert.equal(pdp.pdpBestText(undefined), '--');
  assert.equal(pdp.pdpBestText({ moves: 9, evictions: 2 }), '9 / 2');
  assert.equal(pdp.pdpBestText({ moves: null, evictions: 2 }), '-- / 2');
  assert.equal(pdp.pdpBestText({ moves: 9, evictions: null }), '9 / --');
});

test('pod-packer: the storage warning names every key that failed, what it holds and the error', () => {
  assert.equal(pdp.pdpStorageWarning({}), '');
  assert.equal(pdp.pdpStorageWarning({ 'pdp-state': 'QuotaExceededError' }),
    'Browser storage refused pdp-state (QuotaExceededError): the level in progress will not be kept after a reload.');
  assert.equal(pdp.pdpStorageWarning({ 'pdp-progress': 'SecurityError', 'pdp-state': 'SecurityError' }),
    'Browser storage refused pdp-state and pdp-progress (SecurityError): the level in progress and your passed levels and best scores will not be kept after a reload.');
  assert.equal(pdp.pdpStorageWarning({ 'pdp-progress': 'QuotaExceededError', 'pdp-state': 'SecurityError' }),
    'Browser storage refused pdp-state and pdp-progress (SecurityError, QuotaExceededError): the level in progress and your passed levels and best scores will not be kept after a reload.');
});

// ── The page ─────────────────────────────────────────────────────────────────

test('pod-packer: loading the script under Node runs no init: no lookup, listener, timer or save', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.pdpInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['pdp-nodes'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('pod-packer: a first visit shows level 1: its goal, rules, nodes with CPU and RAM bars, the queue and the score, and saves it', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const v = openPage(t);
  const lv = levelOf(1);
  assert.deepEqual(storedKeys(), [STATE_KEY]);
  assert.equal(localStorage.getItem(STATE_KEY), '{"v":1,"level":1,"seed":1653022489,"place":[-1,-1,-1,-1,-1],"history":[],"moves":0,"evictions":0}');
  assert.equal(v.text('goal'), 'Level 1: run all 5 pods on at most 2 nodes (the exact minimum).');
  assert.deepEqual(v.el('rules').children.map((li) => [li.className, li.textContent]), [['pdp-rule', 'Resources: a pod runs only on a node with enough CPU and memory left.']]);
  assert.equal(v.text('status'), 'Schedule every pod on at most 2 nodes: 5 pods pending.');
  assert.equal(v.text('hint'), 'Tap a pending pod, then a node or a pod on it. Tap a running pod to evict it. Keys: arrows, 1-3, E, U.');
  assert.deepEqual(['nodes-used', 'nodes-target', 'evictions', 'evictions-min', 'moves', 'moves-min', 'best', 'pending-count'].map(v.text),
    ['0', 'target 2', '0', 'min 0', '0', 'min 5', '--', '5']);
  assert.equal(v.hidden('queue-empty'), true);
  assert.equal(v.hidden('next'), true);
  assert.equal(v.hidden('warning'), true);
  assert.equal(v.el('undo').disabled, true);
  assert.deepEqual(v.options(), [['1', 'Level 1']]);
  assert.equal(v.el('level').value, '1');
  assert.equal(v.toast(), null);
  // Nodes: key, name, two meters and an empty pod list each.
  assert.equal(v.nodes().length, 3);
  v.nodes().forEach((el, j) => {
    const n = lv.nodes[j];
    assert.equal(el.className, 'pdp-node pdp-node--empty');
    assert.equal(el.getAttribute('data-node'), String(j));
    assert.equal(el.getAttribute('role'), 'group');
    assert.equal(el.getAttribute('aria-label'), n.name + ' (key ' + (j + 1) + '): 0.0 of ' + units(n.cpu) + ' CPU and 0.0 of ' + units(n.mem) + ' GiB used, 0 pods');
    const [head, cpu, mem, pods] = el.children;
    assert.deepEqual(head.children.map((c) => [c.className, c.textContent]), [['pdp-node-key', String(j + 1)], ['pdp-node-name', n.name]]);
    assert.deepEqual([cpu.className, mem.className], ['pdp-meter pdp-meter--cpu', 'pdp-meter pdp-meter--mem']);
    assert.deepEqual(cpu.children.map((c) => c.className), ['pdp-meter-label', 'pdp-bar', 'pdp-meter-value']);
    assert.deepEqual(cpu.children[1].children.map((c) => c.className), ['pdp-bar-fill', 'pdp-bar-ghost pdp-hidden']);
    assert.equal(cpu.children[1].children[0].style.width, '0%');
    assert.deepEqual(v.meters(j), ['0.0/' + units(n.cpu) + ' CPU', '0.0/' + units(n.mem) + ' GiB']);
    assert.equal(pods.className, 'pdp-node-pods');
    assert.equal(pods.children.length, 0);
  });
  // Pods: one button each in the queue, in pod order, out of the Tab order.
  assert.deepEqual(v.queue(), [0, 1, 2, 3, 4]);
  lv.pods.forEach((p, i) => {
    const el = v.pod(i);
    assert.equal(el.tagName, 'BUTTON');
    assert.equal(el.getAttribute('type'), 'button');
    assert.equal(el.getAttribute('tabindex'), '-1');
    assert.equal(el.id, 'pdp-pod-' + i);
    assert.equal(el.className, 'pdp-pod');
    assert.equal(el.getAttribute('aria-pressed'), 'false');
    assert.equal(el.getAttribute('aria-label'), 'pod ' + p.name + ': ' + units(p.cpu) + ' CPU, ' + units(p.mem) + ' GiB, pending');
    assert.deepEqual(el.children.map((c) => [c.className, c.textContent]), [['pdp-pod-name', p.name], ['pdp-pod-size', units(p.cpu) + ' CPU · ' + units(p.mem) + ' GiB']]);
  });
  // One listener per control; keys and taps on the board only (not the wrapper), only storage on window.
  for (const [name, type] of [['board', 'keydown'], ['board', 'click'], ['level', 'change'], ['undo', 'click'], ['restart', 'click'], ['next', 'click']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(v.el('game')), 0);
  assert.equal(listenerCount(v.board), 2);
  assert.equal(listenerCount(document), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(document.body), 0);
  assert.equal(listenerCount(window), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  assert.equal(setIntervalSpy.mock.callCount(), 0, 'nothing runs on a clock');
});

test('pod-packer: while the page is still loading the game waits for DOMContentLoaded', (t) => {
  const v = openPage(t, { storage: { state: SAMPLE_SAVE }, options: { readyState: 'loading' } });
  assert.equal(v.nodes().length, 0);
  assert.equal(v.text('status'), 'Starting the scheduler...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(v.board, 'click'), 0);
  v.ready();
  assert.equal(v.nodes().length, 4);
  assert.equal(v.text('moves'), '3');
  assert.equal(listenerCount(v.board, 'click'), 1);
});

test('pod-packer: init runs once: a second call binds nothing twice', (t) => {
  enableTimers(t);
  const { exports: fresh, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  fresh.pdpInit();
  const saved = localStorage.getItem(STATE_KEY);
  fresh.pdpInit();
  assert.equal(localStorage.getItem(STATE_KEY), saved);
  assert.equal(listenerCount(els['pdp-board'], 'click'), 1);
  assert.equal(listenerCount(els['pdp-board'], 'keydown'), 1);
  assert.equal(listenerCount(els['pdp-game']), 0);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(fresh.pdpRuntime.els.board, els['pdp-board']);
});

test('pod-packer: tap a pod then a node runs it; the picked pod shows where it fits; a refusal names the values; a tap on a running pod runs the picked pod on its node, or with nothing picked evicts it', (t) => {
  const v = openPage(t);
  const lv = levelOf(1);
  // node-3 has 3.0 CPU / 2.0 GiB.  Pick metrics-1 (0.5 CPU, 2.0 GiB).
  v.tapPod(4);
  assert.equal(v.pod(4).className, 'pdp-pod pdp-pod--selected');
  assert.equal(v.pod(4).getAttribute('aria-pressed'), 'true');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-4');
  assert.equal(v.board.className, 'pdp-board pdp-board--picking');
  assert.equal(v.text('hint'), 'Picked metrics-1 (0.5 CPU, 2.0 GiB): fits node-1, node-2, node-3.');
  assert.deepEqual(v.nodes().map((el) => el.className), ['pdp-node pdp-node--empty pdp-node--fits', 'pdp-node pdp-node--empty pdp-node--fits', 'pdp-node pdp-node--empty pdp-node--fits']);
  // The ghost of the picked pod on each bar.
  const ghost = v.node(2).children[2].children[1].children[1];
  assert.equal(ghost.className, 'pdp-bar-ghost');
  assert.deepEqual([ghost.style.left, ghost.style.width], ['0%', '100%']);
  // Tap it again: unpicked.
  v.tapPod(4);
  assert.equal(v.pod(4).className, 'pdp-pod');
  assert.equal(v.board.getAttribute('aria-activedescendant'), null);
  assert.equal(v.board.className, 'pdp-board');
  // Run it on node-3: it moves there, the bars and counters follow, the move is saved.
  v.run(4, 2);
  assert.deepEqual(v.podsOn(2), [4]);
  assert.deepEqual(v.queue(), [0, 1, 2, 3]);
  assert.equal(v.pod(4).getAttribute('aria-label'), 'pod metrics-1: 0.5 CPU, 2.0 GiB, on node-3');
  assert.deepEqual(v.meters(2), ['0.5/3.0 CPU', '2.0/2.0 GiB']);
  const memFill = v.node(2).children[2].children[1].children[0];
  assert.deepEqual([memFill.className, memFill.style.width], ['pdp-bar-fill pdp-bar-fill--full', '100%']);
  assert.equal(v.node(2).children[1].children[1].children[0].style.width, (100 / 6) + '%');
  assert.equal(v.node(2).className, 'pdp-node');
  assert.deepEqual([v.text('moves'), v.text('nodes-used'), v.text('pending-count')], ['1', '1', '4']);
  assert.deepEqual(v.state().place, [-1, -1, -1, -1, 2]);
  assert.deepEqual(v.state().history, [[4, -1, 2]]);
  assert.equal(v.el('undo').disabled, false);
  assert.equal(v.board.className, 'pdp-board', 'nothing picked after a placement');
  // Pick cache-1 (0.5 CPU, 1.5 GiB): node-3 has no memory left.
  v.tapPod(3);
  assert.equal(v.text('hint'), 'Picked cache-1 (0.5 CPU, 1.5 GiB): fits node-1, node-2.');
  assert.equal(v.node(2).className, 'pdp-node pdp-node--blocked');
  const over = v.node(2).children[2].children[1].children[1];
  assert.equal(over.className, 'pdp-bar-ghost pdp-bar-ghost--over');
  assert.deepEqual([over.style.left, over.style.width], ['100%', '0%']);
  v.tapNode(2);
  assert.equal(v.toast(), 'Insufficient memory: pod cache-1 needs 1.5 GiB, node-3 has 0.0 GiB free.');
  assert.equal(v.state().moves, 1, 'a refusal is no move');
  assert.equal(v.pod(3).className, 'pdp-pod pdp-pod--selected', 'the pod stays picked');
  // While cache-1 is picked, a tap on metrics-1 (running on node-3) is a tap on node-3: refused the same way,
  // and metrics-1 is not evicted (pods cover much of a node card on a phone).
  v.tapPod(4);
  assert.equal(v.toast(), 'Insufficient memory: pod cache-1 needs 1.5 GiB, node-3 has 0.0 GiB free.');
  assert.deepEqual(v.podsOn(2), [4]);
  assert.deepEqual([v.state().moves, v.state().evictions], [1, 0]);
  assert.equal(v.pod(3).className, 'pdp-pod pdp-pod--selected', 'cache-1 stays picked');
  // Tap cache-1 again to put it down: now a tap on a pod that runs evicts it, and it stays picked for the next node.
  v.tapPod(3);
  v.tapPod(4);
  assert.deepEqual(v.queue(), [0, 1, 2, 3, 4]);
  assert.equal(v.pod(4).className, 'pdp-pod pdp-pod--selected');
  assert.deepEqual([v.text('moves'), v.text('evictions')], ['2', '1']);
  assert.deepEqual(v.state().history, [[4, -1, 2], [4, 2, -1]]);
  v.tapNode(0);
  assert.deepEqual(v.podsOn(0), [4]);
  // A tap on a node with nothing picked, on a pod inside a node card, and on the board's own padding.
  v.tapNode(1);
  assert.equal(v.toast(), 'No pod picked: tap a pending pod first (or pick one with the arrow keys), then a node.');
  v.pod(4).children[0].click();
  assert.deepEqual(v.queue(), [0, 1, 2, 3, 4], 'a tap on the name inside a pod counts as a tap on the pod');
  v.node(1).children[0].children[1].click();
  assert.deepEqual(v.podsOn(1), [4], 'a tap on a node card\'s name counts as a tap on the node');
  let moves = v.state().moves;
  v.board.click();
  v.el('queue').click();
  assert.equal(v.state().moves, moves);
  // Pick cache-1 and tap metrics-1 on node-2 (or the name inside it): cache-1 runs on node-2, metrics-1 stays.
  v.tapPod(3);
  v.pod(4).children[1].click();
  assert.deepEqual(v.podsOn(1), [3, 4]);
  assert.deepEqual(v.state().history.slice(-1), [[3, -1, 1]]);
  assert.deepEqual([v.state().moves, v.text('evictions')], [moves + 1, '2']);
  assert.equal(v.board.className, 'pdp-board', 'nothing picked after the placement');
  assert.equal(v.toast(), 'No pod picked: tap a pending pod first (or pick one with the arrow keys), then a node.', 'no toast of its own');
  // With a running pod picked (by the arrow keys), a tap on another running pod evicts that one instead.
  moves = v.state().moves;
  focusElement(v.board, { keyboard: true });
  for (let k = 0; k < 4; k++) pressKey('ArrowRight', { target: v.board });
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-3');
  v.tapPod(4);
  assert.deepEqual([v.queue().includes(4), v.state().moves, v.text('evictions')], [true, moves + 1, '3']);
  assert.equal(v.pod(4).className, 'pdp-pod pdp-pod--selected');
  // A pod that fits nowhere now: cache-1 fills node-3's memory, backup-1 and proxy-1 + metrics-1
  // leave node-2 and node-1 short of CPU for auth-1 (1.5 CPU).
  v.tapNode(0);
  v.tapPod(3);
  v.tapNode(2);
  v.run(2, 1);
  v.run(1, 0);
  v.tapPod(0);
  assert.equal(v.text('hint'), 'Picked auth-1 (1.5 CPU, 1.5 GiB): fits no node now: evict a pod first.');
  assert.deepEqual(v.nodes().map((el) => /pdp-node--(fits|blocked)/.exec(el.className)[1]), ['blocked', 'blocked', 'blocked']);
  assert.equal(lv.pods.length, 5);
});

test('pod-packer: anti-affinity, taints, the gpu node selector and the draining node refuse on the page, naming the rule', (t) => {
  // Level 2: two backup replicas never share a node.
  let v = openPage(t, { storage: { state: { level: 2 } } });
  assert.equal(v.text('goal'), 'Level 2: run all 5 pods on at most 2 nodes (the exact minimum).');
  assert.deepEqual(v.el('rules').children.map((li) => li.textContent)[1], 'Anti-affinity: the 2 replicas of backup (backup-1, backup-2) never share a node.');
  assert.equal(v.pod(3).className, 'pdp-pod pdp-pod--anti');
  assert.deepEqual(v.pod(3).children.map((c) => c.textContent), ['backup-1', '3.0 CPU · 2.5 GiB', 'anti-affinity']);
  v.run(3, 1);
  v.run(4, 1);
  assert.equal(v.toast(), 'Anti-affinity: pod backup-2 cannot share node-2 with backup-1 (app backup).');
  assert.equal(v.text('hint'), 'Picked backup-2 (3.0 CPU, 2.5 GiB): fits node-1, node-3.');

  // Level 3: the gpu node takes only tolerating pods, and ml-1 runs nowhere else.
  resetStubs();
  v = openPage(t, { storage: { state: { level: 3 } } });
  assert.match(v.el('rules').children[1].textContent, /^Taint gpu on node-1: only pods that tolerate gpu run there, and ml-1 needs it\.$/);
  assert.deepEqual(v.node(0).children[0].children.map((c) => [c.className, c.textContent]),
    [['pdp-node-key', '1'], ['pdp-node-name', 'node-1'], ['pdp-tag pdp-tag--taint', 'taint gpu']]);
  assert.equal(v.node(0).className, 'pdp-node pdp-node--taint pdp-node--empty');
  assert.match(v.node(0).getAttribute('aria-label'), /, 0 pods, taint gpu$/);
  assert.equal(v.pod(0).className, 'pdp-pod pdp-pod--gpu');
  assert.equal(v.pod(1).className, 'pdp-pod pdp-pod--tolerates');
  assert.equal(v.pod(0).getAttribute('aria-label'), 'pod ml-1: 0.5 CPU, 3.5 GiB, needs gpu, pending');
  v.run(0, 1);
  assert.equal(v.toast(), 'Node selector: pod ml-1 needs a gpu node, and node-2 has no gpu.');
  v.tapNode(0);
  assert.deepEqual(v.podsOn(0), [0]);
  v.run(4, 0);
  assert.equal(v.toast(), 'Taint gpu on node-1: pod metrics-1 has no toleration for it.');

  // Level 4: node-3 is draining; its pods show stranded, it takes nothing.
  resetStubs();
  v = openPage(t, { storage: { state: { level: 4 } } });
  assert.equal(v.text('status'), 'Schedule every pod on at most 2 nodes: 4 pods pending, node-3 still runs 2 pods to move.');
  assert.equal(v.node(2).className, 'pdp-node pdp-node--drain');
  assert.match(v.node(2).getAttribute('aria-label'), /, 2 pods, draining$/);
  assert.equal(v.node(2).children[0].children[2].textContent, 'draining');
  assert.deepEqual(v.podsOn(2), [2, 4]);
  assert.equal(v.pod(2).className, 'pdp-pod pdp-pod--stranded');
  assert.deepEqual([v.text('evictions-min'), v.text('moves-min')], ['min 2', 'min 8']);
  v.run(0, 2);
  assert.equal(v.toast(), 'node-3 is draining: it accepts no new pods.');
  assert.equal(v.node(2).className, 'pdp-node pdp-node--drain pdp-node--blocked');
  const drainGhost = v.node(2).children[1].children[1].children[1];
  assert.equal(drainGhost.className, 'pdp-bar-ghost pdp-hidden', 'no ghost on the draining node');
  // Evicting from it: a tap.
  v.tapPod(0);
  v.tapPod(2);
  assert.equal(v.pod(2).className, 'pdp-pod pdp-pod--selected');
  assert.equal(v.text('status'), 'Schedule every pod on at most 2 nodes: 5 pods pending, node-3 still runs 1 pod to move.');
  // That eviction is final (the rules say so): Undo has nothing to take back, and is off.
  assert.equal(v.el('rules').children[1].textContent, 'Drain node-3: it takes no new pods; evict its 2 pods and run them elsewhere (Undo cannot put a pod back on it).');
  assert.deepEqual(v.state().history, []);
  assert.equal(v.el('undo').disabled, true);
  v.press('u');
  assert.equal(v.toast(), 'Nothing to undo on level 4.');
  assert.deepEqual([v.state().evictions, v.state().moves], [1, 1]);
  // Run it on node-4, run cron-1 on node-1, undo both: Undo is off again, never stuck on a refusal.
  v.tapNode(3);
  v.run(0, 0);
  assert.deepEqual(v.state().history, [[2, -1, 3], [0, -1, 0]]);
  v.click('undo');
  v.click('undo');
  assert.deepEqual(v.state().place, [-1, -1, -1, -1, 2, -1]);
  assert.equal(v.el('undo').disabled, true);
});

test('pod-packer: scheduling the level passes it: the result, a toast, the record, a frozen board and the next level', (t) => {
  const v = openPage(t);
  const lv = levelOf(1);
  solve(v, lv);
  assert.equal(v.text('status'), 'Level 1 scheduled: 5 pods on 2 nodes (target 2), 0 evictions (min 0), 5 moves (min 5). Optimal schedule.');
  assert.equal(v.toast(), 'Level 1 scheduled in 5 moves with 0 evictions: a new best.');
  assert.equal(v.text('hint'), 'Next level (or N) starts level 2. The level list replays any level you have reached.');
  assert.equal(v.board.className, 'pdp-board pdp-board--passed');
  assert.equal(v.text('best'), '5 / 0');
  assert.equal(v.hidden('queue-empty'), false);
  assert.equal(v.text('pending-count'), '0');
  assert.equal(v.hidden('next'), false);
  assert.equal(v.text('next'), 'Next level: 2');
  assert.equal(v.el('next').getAttribute('aria-label'), 'Start level 2');
  assert.equal(v.el('undo').disabled, true);
  assert.equal(localStorage.getItem(PROGRESS_KEY), '{"v":1,"highest":1,"levels":{"1":{"moves":5,"evictions":0}}}');
  assert.deepEqual(v.options(), [['1', 'Level 1 ✓'], ['2', 'Level 2']]);
  // Frozen: taps and keys only say so.
  const state = localStorage.getItem(STATE_KEY);
  v.tapPod(0);
  assert.equal(v.toast(), 'Level 1 is scheduled: start level 2 with Next level, or restart it to play it again.');
  v.tapNode(0);
  v.press('u');
  v.press('e');
  assert.equal(localStorage.getItem(STATE_KEY), state);
  // N starts the next level.
  v.press('n');
  assert.equal(v.state().level, 2);
  assert.equal(v.text('goal'), 'Level 2: run all 5 pods on at most 2 nodes (the exact minimum).');
  assert.equal(v.hidden('next'), true);
  assert.equal(v.el('level').value, '2');
  assert.equal(v.toast(), 'Level 1 is scheduled: start level 2 with Next level, or restart it to play it again.', 'no toast of its own');
  // N does nothing on a level not passed yet (and leaves the key to the page).
  assert.equal(v.press('n').defaultPrevented, false);
  assert.equal(v.state().level, 2);
  // Replaying level 1 with more moves keeps the best; the Next button climbs too.
  v.choose(1);
  assert.equal(v.state().level, 1);
  v.run(0, 0);
  v.tapPod(0);
  v.tapNode(lv.solution[0]);
  solve(v, lv, [1, 2, 3, 4]);
  assert.equal(v.text('status'), 'Level 1 scheduled: 5 pods on 2 nodes (target 2), 1 eviction (min 0), 7 moves (min 5).');
  assert.equal(v.toast(), 'Level 1 scheduled in 7 moves with 1 eviction.');
  assert.equal(v.text('best'), '5 / 0');
  assert.deepEqual(v.progress().levels['1'], { moves: 5, evictions: 0 });
  v.click('next');
  assert.equal(v.state().level, 2);
  // Level 4 with its draining node, solved at the minimum.
  v.choose(2);
  solve(v, levelOf(2));
  v.click('next');
  solve(v, levelOf(3));
  v.click('next');
  assert.deepEqual(v.options().map((o) => o[1]), ['Level 1 ✓', 'Level 2 ✓', 'Level 3 ✓', 'Level 4']);
  solve(v, levelOf(4));
  assert.equal(v.text('status'), 'Level 4 scheduled: 6 pods on 2 nodes (target 2), 2 evictions (min 2), 8 moves (min 8). Optimal schedule.');
  assert.equal(v.progress().highest, 4);
});

test('pod-packer: every pod running on too many nodes does not pass, and the status says why', (t) => {
  const v = openPage(t, { storage: { state: { level: 4 } } });
  // Spread over node-1, node-2 and node-4.
  v.tapPod(2);
  v.tapNode(3);
  v.tapPod(4);
  v.tapNode(0);
  v.run(0, 0);
  v.run(1, 1);
  v.run(3, 0);
  v.run(5, 3);
  assert.equal(v.text('status'), 'All 6 pods run, but on 3 nodes (target 2). Free a node to pass: evict its pods and fit them elsewhere.');
  assert.equal(v.text('nodes-used'), '3');
  assert.equal(v.hidden('next'), true);
  assert.equal(localStorage.getItem(PROGRESS_KEY), null);
  // Move api-1 from node-2 to node-1: passed.
  v.tapPod(1);
  v.tapNode(0);
  assert.match(v.text('status'), /^Level 4 scheduled: 6 pods on 2 nodes \(target 2\), 3 evictions \(min 2\), 10 moves \(min 8\)\.$/);
});

test('pod-packer: Undo and U take back the last action and count like doing its opposite', (t) => {
  const v = openPage(t);
  v.run(0, 0);
  v.run(1, 0);
  assert.deepEqual([v.text('moves'), v.text('evictions')], ['2', '0']);
  v.click('undo');
  assert.deepEqual(v.queue(), [1, 2, 3, 4]);
  assert.deepEqual([v.text('moves'), v.text('evictions')], ['3', '1'], 'undoing a placement is an eviction and a move');
  v.press('u');
  assert.deepEqual(v.queue(), [0, 1, 2, 3, 4]);
  assert.deepEqual(v.state().history, []);
  assert.equal(v.el('undo').disabled, true);
  v.press('u');
  assert.equal(v.toast(), 'Nothing to undo on level 1.');
  // Undo of an eviction runs the pod again where it was.
  v.run(2, 1);
  v.tapPod(2);
  v.click('undo');
  assert.deepEqual(v.podsOn(1), [2]);
  assert.deepEqual([v.text('moves'), v.text('evictions')], ['7', '3']);
  assert.equal(v.board.className, 'pdp-board', 'undo clears the pick');
});

test('pod-packer: keys work only with the focus on the cluster (not the game\'s own buttons): arrows pick, 1-6 run, E evicts, Escape clears', (t) => {
  const v = openPage(t);
  // Arrows walk the pods in screen order and wrap round; they stop the page from scrolling.
  let ev = v.press('ArrowRight');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-0');
  v.press('ArrowDown');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-1');
  v.press('ArrowLeft');
  v.press('ArrowUp');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-4', 'back past the first pod to the last');
  v.press('Escape');
  assert.equal(v.board.getAttribute('aria-activedescendant'), null);
  assert.equal(v.press('Escape').defaultPrevented, false, 'Escape with nothing picked is left to the page');
  v.press('ArrowLeft');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-4', 'from nothing, Left picks the last pod');
  // 1-6 run the picked pod on that node; held arrows repeat, held digits do not.
  v.press('3');
  assert.deepEqual(v.podsOn(2), [4]);
  v.press('ArrowRight', { repeat: true });
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-0');
  ev = v.press('1', { repeat: true });
  assert.equal(ev.defaultPrevented, true, 'a held digit is swallowed');
  assert.deepEqual(v.podsOn(0), []);
  v.press('1');
  assert.deepEqual(v.podsOn(0), [0]);
  // A key for a node the level lacks, a digit with nothing picked, a digit on a running pod.
  v.press('ArrowRight');
  v.press('6');
  assert.equal(v.toast(), 'There is no node-6: level 1 has 3 nodes.');
  v.press('Escape');
  v.press('2');
  assert.equal(v.toast(), 'No pod picked: tap a pending pod first (or pick one with the arrow keys), then a node.');
  // The order: queue (1, 2, 3), node-1 (0), node-3 (4).
  for (let k = 0; k < 4; k++) v.press('ArrowRight');
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-0');
  v.press('2');
  assert.equal(v.toast(), 'Pod auth-1 already runs on node-1: evict it first (E, or tap it).');
  assert.equal(v.text('hint'), 'Picked auth-1 on node-1: press E or tap it to evict it.');
  v.press('e');
  assert.deepEqual(v.podsOn(0), []);
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-0', 'still picked after E');
  v.press('E');
  assert.equal(v.toast(), 'Pod auth-1 is pending: there is nothing to evict.');
  v.press('Escape');
  v.press('e');
  assert.equal(v.toast(), 'No pod picked: pick a running pod with the arrow keys, then press E.');
  // Non-Latin layouts and AZERTY digits by the physical key.
  v.press('ArrowRight');
  v.press('&', { code: 'Digit1' });
  assert.deepEqual(v.podsOn(0), [0]);
  v.press('г', { code: 'KeyU' });
  assert.deepEqual(v.podsOn(0), []);
  const moves = v.state().moves;
  // Ctrl / Alt / Meta combinations, composing, keys handled already and unknown keys are left alone.
  v.press('ArrowRight');
  for (const props of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    ev = v.press('1', props);
    assert.equal(ev.defaultPrevented, false, JSON.stringify(props));
  }
  const handled = keyEvent('1', { target: v.board });
  handled.preventDefault();
  v.board.dispatchEvent(handled);
  assert.equal(v.press('x').defaultPrevented, false);
  assert.equal(v.press(undefined).defaultPrevented, false, 'an autofill keydown');
  assert.equal(v.state().moves, moves);
  // The level select keeps its own keys (arrows change the level there).
  focusElement(v.el('level'), { keyboard: true });
  assert.equal(pressKey('ArrowDown', { target: v.el('level') }).defaultPrevented, false);
  assert.equal(pressKey('1', { target: v.el('level') }).defaultPrevented, false);
  // A field inside the cluster, and an editable element, keep theirs too.
  const field = v.page.add('pdp-extra-field', { tagName: 'input', parent: 'pdp-board' });
  assert.equal(pressKey('1', { target: field }).defaultPrevented, false);
  const editable = v.page.add('pdp-extra-editable', { tagName: 'div', parent: 'pdp-board', isContentEditable: true });
  assert.equal(pressKey('1', { target: editable }).defaultPrevented, false);
  // Keys typed elsewhere on the host page never reach the game.
  const host = v.page.add('host-search', 'input');
  focusElement(host, { keyboard: true });
  for (const key of ['1', 'ArrowDown', 'e', 'u']) assert.equal(pressKey(key, { target: host }).defaultPrevented, false, key);
  const hostButton = v.page.add('host-button', 'button');
  assert.equal(pressKey('ArrowDown', { target: hostButton }).defaultPrevented, false);
  assert.equal(pressKey('ArrowDown', { target: document.body }).defaultPrevented, false, 'the page body scrolls');
  assert.equal(v.state().moves, moves);
  // The game's own buttons, its help summary and the rest of its wrapper keep their keys too: a mouse user who
  // clicked Restart and presses ArrowDown scrolls the page, and nothing is picked or run.
  const summary = v.page.add('pdp-extra-summary', { tagName: 'summary', parent: 'pdp-game' });
  for (const target of [v.el('restart'), v.el('undo'), summary, v.el('game'), v.el('status')]) {
    focusElement(target, { keyboard: true });
    for (const key of ['ArrowDown', 'ArrowUp', '1', 'e', 'u', 'Escape']) {
      assert.equal(pressKey(key, { target }).defaultPrevented, false, target.id + ' ' + key);
    }
  }
  assert.equal(v.state().moves, moves);
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-0', 'the pick is unchanged');
  // Back on the cluster, the keys act again.
  focusElement(v.board, { keyboard: true });
  assert.equal(pressKey('1', { target: v.board }).defaultPrevented, true);
  assert.equal(v.state().moves, moves + 1);
});

test('pod-packer: a pod that has the focus keeps it when it moves to a node or back', (t) => {
  const v = openPage(t);
  focusElement(v.pod(2), { keyboard: true });
  pressKey('ArrowRight', { target: v.pod(2) });
  pressKey('ArrowRight', { target: v.pod(2) });
  pressKey('ArrowRight', { target: v.pod(2) });
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-2');
  pressKey('2', { target: v.pod(2) });
  assert.deepEqual(v.podsOn(1), [2]);
  assert.equal(document.activeElement, v.pod(2), 'the moved pod keeps the focus, so the next key still reaches the game');
  pressKey('ArrowLeft', { target: v.pod(2) });
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-2', 'the last pod on screen');
  pressKey('e', { target: v.pod(2) });
  assert.deepEqual(v.queue(), [0, 1, 2, 3, 4], 'back in its place in the queue');
  assert.equal(document.activeElement, v.pod(2));
  // A pod that moves without the focus leaves the focus where it was.
  focusElement(v.board, { keyboard: true });
  v.run(4, 0);
  v.run(3, 0);
  assert.deepEqual(v.podsOn(0), [3, 4], 'in pod order inside a node');
  assert.equal(document.activeElement, v.board);
  // A mouse user clicked a pod (it took the focus), passes the level and presses N: the old pods go away
  // with the old level, and the board takes the focus, so the keys keep reaching the game.
  v.click('restart');
  focusElement(v.pod(0));
  solve(v, levelOf(1));
  assert.match(v.text('status'), /^Level 1 scheduled/);
  assert.equal(document.activeElement, v.pod(0), 'the focused pod kept the focus on its way to a node');
  const oldPod = v.pod(0);
  assert.equal(pressKey('n', { target: oldPod }).defaultPrevented, true);
  assert.equal(v.state().level, 2);
  assert.notEqual(v.pod(0), oldPod, 'a new level, new pod buttons');
  assert.equal(document.activeElement, v.board);
  assert.equal(pressKey('ArrowRight', { target: document.activeElement }).defaultPrevented, true);
  assert.equal(v.board.getAttribute('aria-activedescendant'), 'pdp-pod-0');
  // A level the other tab started comes in the same way.
  focusElement(v.pod(0));
  localStorage.setItem(STATE_KEY, JSON.stringify({ level: 3 }));
  fire(window, 'storage', { key: STATE_KEY });
  assert.match(v.text('goal'), /^Level 3:/);
  assert.equal(document.activeElement, v.board);
  // A rebuild while the focus is elsewhere on the page leaves it there.
  const host = v.page.add('host-link', 'a');
  focusElement(host);
  v.choose(1);
  assert.equal(document.activeElement, host);
});

test('pod-packer: Restart and the level list start a level over, naming an unfinished attempt they drop', (t) => {
  const v = openPage(t, { storage: { progress: SAMPLE_PROGRESS } });
  assert.equal(v.state().level, 4, 'a first visit with progress opens the level after the highest passed');
  assert.deepEqual(v.options(), [['1', 'Level 1 ✓'], ['2', 'Level 2 ✓'], ['3', 'Level 3 ✓'], ['4', 'Level 4']]);
  v.click('restart');
  assert.equal(v.toast(), 'Level 4 restarted from its start.');
  v.tapPod(2);
  v.tapNode(3);
  v.click('restart');
  assert.equal(v.toast(), 'Level 4 restarted from its start. Your level 4 attempt (2 moves) was dropped.');
  assert.deepEqual(v.state(), { v: 1, level: 4, seed: LEVEL4.seed, place: LEVEL4.start, history: [], moves: 0, evictions: 0 });
  v.run(0, 0);
  v.choose(2);
  assert.equal(v.toast(), 'Level 2 started. Your level 4 attempt (1 move) was dropped.');
  assert.equal(v.state().level, 2);
  assert.equal(v.text('best'), '7 / 1');
  v.choose(3);
  assert.equal(v.toast(), 'Level 2 started. Your level 4 attempt (1 move) was dropped.', 'nothing dropped: no new toast');
  assert.equal(v.text('best'), '6 / 0');
  // A value that is no level changes nothing.
  v.choose('x');
  assert.equal(v.state().level, 3);
  // A level beyond the highest passed (from a save) is listed too.
  resetStubs();
  const w = openPage(t, { storage: { state: { level: 9 } } });
  assert.equal(w.options().length, 9);
  assert.equal(w.el('level').value, '9');
  assert.equal(w.text('nodes-target'), 'target 4');
  assert.equal(w.nodes().length, 5);
});

test('pod-packer: the last level offers no next one', (t) => {
  const lv = levelOf(50);
  const place = lv.solution;
  const v = openPage(t, { storage: { state: { level: 50, place, history: [], moves: lv.minMoves, evictions: lv.minEvictions } } });
  assert.match(v.text('status'), /^Level 50 scheduled: /);
  assert.equal(v.hidden('next'), true);
  assert.equal(v.text('hint'), 'That was the last level. The level list replays any level.');
  assert.equal(v.press('n').defaultPrevented, false);
  assert.equal(v.options().length, 50);
});

test('pod-packer: a toast keeps its full time, and a newer one gets its own', (t) => {
  const v = openPage(t);
  v.tapNode(0);
  assert.ok(v.toast());
  t.mock.timers.tick(2000);
  v.press('6');
  assert.equal(v.toast(), 'There is no node-6: level 1 has 3 nodes.');
  t.mock.timers.tick(2000);
  assert.equal(v.toast(), 'There is no node-6: level 1 has 3 nodes.', 'the first toast\'s timer does not hide the second');
  t.mock.timers.tick(600);
  assert.equal(v.toast(), null);
});

test('pod-packer: nothing runs on a clock: a hidden tab changes nothing and writes nothing', (t) => {
  const v = openPage(t);
  v.run(0, 0);
  const state = localStorage.getItem(STATE_KEY);
  setVisibility('hidden', t);
  t.mock.timers.tick(60000);
  setVisibility('visible', t);
  assert.equal(localStorage.getItem(STATE_KEY), state);
  assert.equal(v.toast(), null, 'shown again with nothing new from other tabs: no toast');
});

// ── Saves on the page ────────────────────────────────────────────────────────

test('pod-packer: saves in the current format load as they were and are written back in the same format', (t) => {
  const v = openPage(t, { storage: { state: SAMPLE_SAVE, progress: SAMPLE_PROGRESS } });
  assert.deepEqual(v.podsOn(0), [0]);
  assert.deepEqual(v.podsOn(3), [2]);
  assert.deepEqual(v.podsOn(2), [4]);
  assert.deepEqual([v.text('moves'), v.text('evictions'), v.text('nodes-used')], ['3', '1', '2']);
  assert.equal(v.el('undo').disabled, false);
  // Nothing changed yet: the saves on disk are the same text.
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE);
  assert.equal(localStorage.getItem(PROGRESS_KEY), SAMPLE_PROGRESS);
  v.click('undo');
  assert.equal(localStorage.getItem(STATE_KEY), '{"v":1,"level":4,"seed":1703355346,"place":[-1,-1,3,-1,2,-1],"history":[[2,-1,3]],"moves":4,"evictions":2}');
  // Passing writes the progress in the same format, merged.
  solve(v, levelOf(4), [0, 1, 3, 4, 5]);
  assert.equal(localStorage.getItem(PROGRESS_KEY), '{"v":1,"highest":4,"levels":{"1":{"moves":5,"evictions":0},"2":{"moves":7,"evictions":1},"3":{"moves":6,"evictions":0},"4":{"moves":10,"evictions":3}}}');
});

test('pod-packer: a level in progress survives a reload: placement, history, counters and the progress', (t) => {
  const v = openPage(t);
  solve(v, levelOf(1));
  v.click('next');
  v.run(0, 1);
  v.run(1, 2);
  v.tapPod(1);
  const snapshot = v.state();
  const drawn = v.nodes().map((el) => el.getAttribute('aria-label'));
  const again = reload(t, v);
  assert.deepEqual(again.state(), snapshot);
  assert.deepEqual(again.nodes().map((el) => el.getAttribute('aria-label')), drawn);
  assert.deepEqual([again.text('moves'), again.text('evictions')], ['3', '1']);
  assert.equal(again.board.getAttribute('aria-activedescendant'), null, 'the pick is not saved');
  assert.deepEqual(again.options(), [['1', 'Level 1 ✓'], ['2', 'Level 2']]);
  again.click('undo');
  assert.deepEqual(again.podsOn(2), [1]);
});

test('pod-packer: a corrupt or unplayable save never breaks the page: a fresh, playable level instead', (t) => {
  const saves = {
    'empty text': '', 'broken JSON': '{"level":', 'null': 'null', 'a number': '42', 'an array': '[]', 'an empty object': '{}',
    'a level out of range': '{"level":99}', 'a placement over capacity': '{"level":1,"place":[0,0,0,0,0]}',
    'a placement of the wrong length': '{"level":1,"place":[0]}', 'a history that leads nowhere': '{"level":1,"place":[-1,-1,-1,-1,-1],"history":[[0,-1,0]]}'
  };
  for (const [name, text] of Object.entries(saves)) {
    resetStubs();
    const v = openPage(t, { storage: { state: text, progress: '{' } });
    assert.equal(v.state().level, 1, name);
    assert.deepEqual(v.state().place, [-1, -1, -1, -1, -1], name);
    assert.deepEqual(v.state().history, [], name);
    assert.equal(v.text('best'), '--', name);
    assert.equal(v.hidden('warning'), true, name);
    v.run(0, 0);
    assert.equal(v.state().moves, 1, name + ': playable');
  }
});

test('pod-packer: blocked storage never stops the game, and the warning names the keys and the error', (t) => {
  blockStorage('access', t);
  const v = openPage(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Browser storage refused pdp-state and pdp-progress (SecurityError): the level in progress and your passed levels and best scores will not be kept after a reload.');
  assert.equal(v.nodes().length, 3);
  solve(v, levelOf(1));
  assert.match(v.text('status'), /^Level 1 scheduled/);
  assert.equal(v.toast(), 'Level 1 scheduled in 5 moves with 0 evictions: a new best.');
  assert.deepEqual(v.options(), [['1', 'Level 1 ✓'], ['2', 'Level 2']]);
  v.click('next');
  v.run(0, 0);
  assert.equal(v.text('moves'), '1');
  fire(window, 'storage', { key: STATE_KEY });
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.equal(v.text('moves'), '1', 'nothing comes in from a store that cannot be read');
});

test('pod-packer: full storage still reads the saves; the game plays on, warns naming the key, and never rolls back to the older save', (t) => {
  writeStorage({ state: SAMPLE_SAVE });
  blockStorage('full', t);
  const v = openPage(t);
  assert.equal(v.text('moves'), '3', 'the save is still read');
  assert.equal(v.hidden('warning'), true, 'nothing written yet');
  v.click('undo');
  assert.equal(v.text('warning'), 'Browser storage refused pdp-state (QuotaExceededError): the level in progress will not be kept after a reload.');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE);
  // The older text on disk is no other tab's newer game: the next moves play on.
  v.click('undo');
  assert.equal(v.text('moves'), '5');
  assert.equal(v.toast(), null);
  solve(v, levelOf(4), [0, 1, 2, 3, 4, 5].filter((i) => i !== 4 && i !== 2).concat([2, 4]));
  assert.match(v.text('status'), /^Level 4 scheduled/);
  assert.equal(v.text('warning'), 'Browser storage refused pdp-state and pdp-progress (QuotaExceededError): the level in progress and your passed levels and best scores will not be kept after a reload.');
});

// ── Second tabs ──────────────────────────────────────────────────────────────

test('pod-packer: a second tab takes over the game another tab saved: at the storage event, when shown again, and before an action (which is dropped)', (t) => {
  const v = openPage(t);
  v.run(0, 0);
  // The other tab plays on from there.
  const theirs = JSON.stringify({ v: 1, level: 1, seed: LEVEL1.seed, place: [0, 2, -1, -1, -1], history: [[0, -1, 0], [1, -1, 2]], moves: 2, evictions: 0 });
  localStorage.setItem(STATE_KEY, theirs);
  fire(window, 'storage', { key: PROGRESS_KEY });
  assert.deepEqual(v.podsOn(2), [], 'an event for another key brings no game');
  fire(window, 'storage', { key: STATE_KEY });
  assert.deepEqual(v.podsOn(2), [1]);
  assert.equal(v.toast(), 'Another tab changed the game: level 1 is shown here as that tab left it (2 moves).');
  assert.equal(localStorage.getItem(STATE_KEY), theirs, 'taken over, not written back');
  fire(window, 'storage', { key: STATE_KEY });
  fire(window, 'storage', { key: 'other' });
  // A tap meant for the old board: the newer game comes in and the tap is dropped.
  const third = JSON.stringify({ v: 1, level: 1, seed: LEVEL1.seed, place: [0, 2, 1, -1, -1], history: [[0, -1, 0], [1, -1, 2], [2, -1, 1]], moves: 3, evictions: 0 });
  localStorage.setItem(STATE_KEY, third);
  v.tapPod(3);
  assert.deepEqual(v.podsOn(1), [2]);
  assert.equal(v.board.getAttribute('aria-activedescendant'), null, 'the tap picked nothing');
  assert.equal(v.toast(), 'Another tab changed the game: level 1 is shown here as that tab left it (3 moves).');
  // The same with a key, and when the tab is shown again (the other tab moved to level 2).
  localStorage.setItem(STATE_KEY, JSON.stringify({ level: 2 }));
  v.press('ArrowRight');
  v.press('1');
  assert.equal(v.text('goal'), 'Level 2: run all 5 pods on at most 2 nodes (the exact minimum).');
  assert.deepEqual(v.podsOn(0), []);
  localStorage.setItem(STATE_KEY, JSON.stringify({ level: 3 }));
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.match(v.text('goal'), /^Level 3:/);
  assert.deepEqual(v.options().length, 3);
  // Then this tab's own moves are written as usual.
  v.run(0, 0);
  assert.equal(v.state().level, 3);
  assert.equal(v.state().moves, 1);
  // A store emptied by another tab brings nothing.
  localStorage.removeItem(STATE_KEY);
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.text('moves'), '1');
});

test('pod-packer: Restart, Next level, the level list and the arrows take over another tab\'s newer game first and write nothing over it', (t) => {
  // This tab sat frozen in the background (no storage event) while another tab played on.
  const v = openPage(t);
  v.run(0, 0);
  const theirs = JSON.stringify({ v: 1, level: 6, seed: pdp.pdpLevelSeed(6), place: levelOf(6).start, history: [], moves: 4, evictions: 0 });
  localStorage.setItem(STATE_KEY, theirs);
  v.click('restart');
  assert.equal(localStorage.getItem(STATE_KEY), theirs, 'Restart wrote no fresh level over it');
  assert.match(v.text('goal'), /^Level 6:/);
  assert.equal(v.text('moves'), '4');
  assert.equal(v.toast(), 'Another tab changed the game: level 6 is shown here as that tab left it (4 moves).');
  // A second Restart is meant for this game: level 6 starts over, naming the attempt it drops.
  v.click('restart');
  assert.equal(v.toast(), 'Level 6 restarted from its start. Your level 6 attempt (4 moves) was dropped.');
  assert.deepEqual([v.state().level, v.state().moves], [6, 0]);
  // The level list.
  const second = JSON.stringify({ v: 1, level: 2, seed: pdp.pdpLevelSeed(2), place: levelOf(2).start, history: [], moves: 2, evictions: 1 });
  localStorage.setItem(STATE_KEY, second);
  v.choose(5);
  assert.equal(localStorage.getItem(STATE_KEY), second, 'the level list wrote no level 5 over it');
  assert.match(v.text('goal'), /^Level 2:/);
  assert.equal(v.el('level').value, '2', 'the list shows the game taken over');
  assert.equal(v.toast(), 'Another tab changed the game: level 2 is shown here as that tab left it (2 moves).');
  v.choose(5);
  assert.equal(v.state().level, 5);
  assert.equal(v.toast(), 'Level 5 started. Your level 2 attempt (2 moves) was dropped.');
  // The arrows: the step is dropped, nothing is picked on the board that went away.
  localStorage.setItem(STATE_KEY, JSON.stringify({ level: 3 }));
  assert.equal(v.press('ArrowRight').defaultPrevented, true);
  assert.match(v.text('goal'), /^Level 3:/);
  assert.equal(v.board.getAttribute('aria-activedescendant'), null);
  // Next level (the button and N): the other tab's game comes in first.
  solve(v, levelOf(3));
  assert.match(v.text('status'), /^Level 3 scheduled/);
  const fifth = JSON.stringify({ v: 1, level: 5, seed: pdp.pdpLevelSeed(5), place: levelOf(5).start, history: [], moves: 0, evictions: 0 });
  localStorage.setItem(STATE_KEY, fifth);
  v.click('next');
  assert.match(v.text('goal'), /^Level 5:/);
  assert.equal(localStorage.getItem(STATE_KEY), fifth);
  solve(v, levelOf(5));
  assert.match(v.text('status'), /^Level 5 scheduled/);
  localStorage.setItem(STATE_KEY, JSON.stringify({ level: 9 }));
  assert.equal(v.press('n').defaultPrevented, true);
  assert.match(v.text('goal'), /^Level 9:/, 'not level 6');
  assert.equal(localStorage.getItem(STATE_KEY), JSON.stringify({ level: 9 }));
});

test('pod-packer: the storage warning goes away once a later write of that key works again', (t) => {
  const v = openPage(t);
  let restore = blockStorage('full');
  v.run(0, 0);
  assert.equal(v.text('warning'), 'Browser storage refused pdp-state (QuotaExceededError): the level in progress will not be kept after a reload.');
  restore();
  v.run(1, 0);
  assert.equal(v.hidden('warning'), true, 'pdp-state is saved again');
  assert.equal(v.text('warning'), '');
  assert.equal(v.state().moves, 2);
  // Both keys fail on a pass; each write that works again takes only its own key off.
  v.click('restart');
  restore = blockStorage('full');
  solve(v, levelOf(1));
  assert.equal(v.text('warning'), 'Browser storage refused pdp-state and pdp-progress (QuotaExceededError): the level in progress and your passed levels and best scores will not be kept after a reload.');
  restore();
  v.click('restart');
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Browser storage refused pdp-progress (QuotaExceededError): your passed levels and best scores will not be kept after a reload.');
  solve(v, levelOf(1));
  assert.equal(v.hidden('warning'), true);
  assert.deepEqual(v.progress().levels, { 1: { moves: 5, evictions: 0 } });
  // A read that works (full storage still reads) takes nothing off.
  restore = blockStorage('full');
  v.click('restart');
  fire(window, 'storage', { key: STATE_KEY });
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.equal(v.text('warning'), 'Browser storage refused pdp-state (QuotaExceededError): the level in progress will not be kept after a reload.');
  restore();
});

test('pod-packer: no tab erases another tab\'s progress: passes merge, and the storage event brings the other tab\'s in', (t) => {
  const v = openPage(t);
  // Meanwhile another tab passes levels 1 to 3, level 1 in fewer evictions than this tab will.
  localStorage.setItem(PROGRESS_KEY, '{"v":1,"highest":3,"levels":{"1":{"moves":9,"evictions":0},"3":{"moves":6,"evictions":0}}}');
  v.run(0, 0);
  v.tapPod(0);
  v.tapNode(LEVEL1.solution[0]);
  solve(v, levelOf(1), [1, 2, 3, 4]);
  assert.equal(v.toast(), 'Level 1 scheduled in 7 moves with 1 eviction: a new best.', 'fewer moves than the other tab\'s');
  assert.equal(localStorage.getItem(PROGRESS_KEY), '{"v":1,"highest":3,"levels":{"1":{"moves":7,"evictions":0},"3":{"moves":6,"evictions":0}}}');
  assert.deepEqual(v.options(), [['1', 'Level 1 ✓'], ['2', 'Level 2'], ['3', 'Level 3 ✓'], ['4', 'Level 4']]);
  // The other tab passes level 2: the event brings it in; a repeat of the event changes nothing.
  localStorage.setItem(PROGRESS_KEY, '{"v":1,"highest":3,"levels":{"2":{"moves":5,"evictions":0}}}');
  fire(window, 'storage', { key: PROGRESS_KEY });
  assert.deepEqual(v.options().map((o) => o[1]), ['Level 1 ✓', 'Level 2 ✓', 'Level 3 ✓', 'Level 4']);
  fire(window, 'storage', { key: PROGRESS_KEY });
  v.choose(2);
  assert.equal(v.text('best'), '5 / 0');
  // This tab's next pass writes everything it knows back.
  v.choose(1);
  solve(v, levelOf(1));
  assert.deepEqual(v.progress().levels, { 1: { moves: 5, evictions: 0 }, 2: { moves: 5, evictions: 0 }, 3: { moves: 6, evictions: 0 } });
  // A tab shown again merges what came in while it was hidden.
  localStorage.setItem(PROGRESS_KEY, '{"v":1,"highest":6,"levels":{"6":{"moves":20,"evictions":2}}}');
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.equal(v.options().length, 7);
});

test('pod-packer: every class the game puts on the page has a rule in style.css', (t) => {
  const seen = new Set();
  const collect = (v) => {
    for (const el of walk(v.page.root)) String(el.className || '').split(/\s+/).filter(Boolean).forEach((name) => seen.add(name));
  };
  const v = openPage(t, { storage: { state: { level: 10 } } });
  collect(v);
  const lv = levelOf(10);
  v.tapPod(lv.start.indexOf(-1));
  collect(v);
  v.press('Escape');
  v.tapPod(lv.pods.findIndex((p, i) => lv.start[i] !== -1));
  collect(v);
  v.choose(1);
  v.run(4, 2);
  v.tapPod(3);
  collect(v);
  v.press('Escape');
  v.tapPod(4);
  v.tapNode(LEVEL1.solution[4]);
  solve(v, levelOf(1), [0, 1, 2, 3]);
  assert.match(v.text('status'), /^Level 1 scheduled/);
  collect(v);
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors).join(' ');
  for (const name of [...seen].sort()) {
    assert.match(name, /^pdp-/);
    assert.match(selectors, new RegExp('\\.' + name + '(?![\\w-])'), name);
  }
  for (const name of ['pdp-node--drain', 'pdp-node--taint', 'pdp-node--empty', 'pdp-node--fits', 'pdp-node--blocked', 'pdp-tag--taint', 'pdp-tag--drain',
    'pdp-pod--selected', 'pdp-pod--anti', 'pdp-pod--gpu', 'pdp-pod--tolerates', 'pdp-pod--stranded', 'pdp-bar-fill--full', 'pdp-bar-ghost--over',
    'pdp-board--passed', 'pdp-board--picking', 'pdp-meter--cpu', 'pdp-meter--mem', 'pdp-option', 'pdp-rule', 'pdp-pod-tags', 'pdp-btn--next']) {
    assert.ok(seen.has(name), name + ' was seen on the page');
  }
});
