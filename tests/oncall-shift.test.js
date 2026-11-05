// tests/oncall-shift.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, focusElement, setVisibility, listenerCount, readRepoFile, idsInHtml, htmlPageSpec,
  embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'oncall-shift';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

const STATE_KEY = 'ocs-state';
const BEST_KEY = 'ocs-best';
const HISTORY_KEY = 'ocs-history';
const TICK = 100;
const SHIFT = 180000;
const PENALTY = 1500;
const NAMES = ['dns-1', 'lb-1', 'web-1', 'web-2', 'api-1', 'api-2', 'worker-1', 'backup-1', 'db-1', 'db-2', 'cache-1', 'queue-1'];
const IDX = Object.fromEntries(NAMES.map((name, i) => [name, i]));
const ACTIONS = ['cleanup', 'restart', 'scale', 'renew'];
// Who depends on whom (an independent copy of the rack's wiring).
const UPSTREAM = {
  'lb-1': ['dns-1'], 'web-1': ['db-1'], 'web-2': ['db-2'], 'api-1': ['db-1', 'cache-1'],
  'api-2': ['db-2', 'cache-1'], 'worker-1': ['queue-1'], 'backup-1': ['db-1', 'db-2']
};
const LEVELS = {
  easy: { spawnStart: 3800, spawnEnd: 1500, slaStart: 11000, slaEnd: 7000, cascadeMs: 4000 },
  normal: { spawnStart: 2800, spawnEnd: 1200, slaStart: 8000, slaEnd: 6000, cascadeMs: 3000 },
  hard: { spawnStart: 2200, spawnEnd: 700, slaStart: 6500, slaEnd: 4000, cascadeMs: 2000 }
};

const READY = 'Pager is quiet. Press Start shift (or Space on the rack) to begin the 22:00 to 06:00 shift.';
const STARTED = 'Shift started: the pager is live. Keep the rack green.';
const PAUSED = 'Paused. Press Resume or Space on the rack to continue.';
const PAUSED_HIDDEN = 'Paused while the tab was hidden. Press Resume or Space on the rack to continue.';
const NO_HISTORY = 'No finished shifts yet: your last 5 postmortems show up here.';
// The overlay promises Space only with the rack focused: on a fresh page Space scrolls the host page.
const OVERLAY_READY = 'Tap here or press Start shift to begin (Space works once the rack has the focus).';
const OVERLAY_PAUSED = 'Tap here or press Resume to continue (Space works once the rack has the focus).';

// A save written by this version (v1) of the game, captured mid-shift: 22:56
// on Normal, shift #3. dns-1 took a wrong action, db-1 breached and came
// back after a cascade hit web-1 and api-1, db-2 and backup-1 are down,
// api-1 still has its "lost db-1" alert, queue-1 a full disk, and web-2 and
// api-2 wait for their db-2 cascade at 21900.
const SAVE_V1 =
  '{"v":1,"level":"normal","shiftNo":3,"t":21000,"nextSpawn":21700,"servers":[' +
  '{"st":"ok","kind":null,"from":null,"left":0,"sla":0,"since":0,"outage":0,"down":1500,"cascadeAt":null,"cascadeFrom":null},' +
  '{"st":"ok","kind":null,"from":null,"left":0,"sla":0,"since":0,"outage":0,"down":0,"cascadeAt":null,"cascadeFrom":null},' +
  '{"st":"ok","kind":null,"from":null,"left":0,"sla":0,"since":0,"outage":0,"down":0,"cascadeAt":null,"cascadeFrom":null},' +
  '{"st":"ok","kind":null,"from":null,"left":0,"sla":0,"since":0,"outage":0,"down":0,"cascadeAt":21900,"cascadeFrom":9},' +
  '{"st":"alert","kind":"restart","from":8,"left":3400,"sla":7700,"since":16700,"outage":0,"down":0,"cascadeAt":null,"cascadeFrom":null},' +
  '{"st":"ok","kind":null,"from":null,"left":0,"sla":0,"since":0,"outage":0,"down":0,"cascadeAt":21900,"cascadeFrom":9},' +
  '{"st":"ok","kind":null,"from":null,"left":0,"sla":0,"since":0,"outage":0,"down":0,"cascadeAt":null,"cascadeFrom":null},' +
  '{"st":"down","kind":"restart","from":null,"left":0,"sla":7800,"since":13000,"outage":200,"down":200,"cascadeAt":null,"cascadeFrom":null},' +
  '{"st":"ok","kind":null,"from":null,"left":0,"sla":0,"since":0,"outage":0,"down":3300,"cascadeAt":null,"cascadeFrom":null},' +
  '{"st":"down","kind":"cleanup","from":null,"left":0,"sla":7800,"since":11100,"outage":2100,"down":2100,"cascadeAt":null,"cascadeFrom":null},' +
  '{"st":"ok","kind":null,"from":null,"left":0,"sla":0,"since":0,"outage":0,"down":0,"cascadeAt":null,"cascadeFrom":null},' +
  '{"st":"alert","kind":"cleanup","from":null,"left":6500,"sla":7700,"since":19800,"outage":0,"down":0,"cascadeAt":null,"cascadeFrom":null}],' +
  '"stats":{"incidents":10,"fixed":6,"restored":1,"breaches":3,"wrong":1,"cascades":2,"fixMs":5300,"worstMs":3300,"worst":8},' +
  '"log":[[0,-1,"start",null,0],[2000,0,"alert","renew",0],[2500,0,"wrong","cleanup",1500],[2500,0,"fix","renew",500],' +
  '[5800,8,"alert","restart",0],[8300,5,"alert","restart",0],[10000,5,"fix","restart",1700],[11100,9,"alert","cleanup",0],' +
  '[13000,7,"alert","restart",0],[13700,8,"breach","restart",7900],[15000,3,"alert","restart",0],[15000,3,"fix","restart",0],' +
  '[16700,2,"cascade","restart",8],[16700,4,"cascade","restart",8],[17000,8,"restore","restart",3300],[17500,2,"fix","restart",800],' +
  '[17700,2,"alert","renew",0],[18900,9,"breach","cleanup",7800],[19800,11,"alert","cleanup",0],[20000,2,"fix","renew",2300],' +
  '[20800,7,"breach","restart",7800]]}';

test.beforeEach(() => resetStubs());

// ── An independent model ────────────────────────────────────────────────────

// The shift clock: 8 game hours from 22:00 over 180 s, 0.16 game s per ms.
function clockAt(t) {
  const minutes = 22 * 60 + Math.floor(t * 0.16 / 60);
  return String(Math.floor(minutes / 60) % 24).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

function uptimeOf(downMs, t) {
  return t === 0 ? 100 : Math.max(0, 100 * (1 - downMs / (12 * t)));
}

const lerp = (a, b, f) => a + (b - a) * f;

function blank() {
  return { st: 'ok', kind: null, from: null, left: 0, sla: 0, since: 0, outage: 0, down: 0, cascadeAt: null, cascadeFrom: null };
}

// A shift as the save holds it: servers by name get their fields on top of
// a healthy server; no incident is due for a minute unless nextSpawn says so.
function shift({ level = 'normal', shiftNo = 1, t = 0, nextSpawn, servers = {}, stats = {}, log } = {}) {
  const list = NAMES.map(() => blank());
  for (const [name, fields] of Object.entries(servers)) Object.assign(list[IDX[name]], fields);
  return {
    v: 1, level, shiftNo, t,
    nextSpawn: nextSpawn === undefined ? t + 60000 : nextSpawn,
    servers: list,
    stats: { incidents: 0, fixed: 0, restored: 0, breaches: 0, wrong: 0, cascades: 0, fixMs: 0, worstMs: 0, worst: -1, ...stats },
    log: log || [[0, -1, 'start', null, 0]]
  };
}

const alertOf = (kind, left, since, extra) => ({ ...blank(), st: 'alert', kind, left, sla: 8000, since, ...extra });
const downOf = (kind, outage, since, extra) => ({ ...blank(), st: 'down', kind, sla: 8000, since, outage, down: outage, ...extra });

// 23:20 on Normal: four open incidents and one server down for 2 s.
function scenario(extra) {
  return shift({
    t: 30000,
    servers: {
      'lb-1': alertOf('renew', 5000, 27000),
      'web-1': alertOf('cleanup', 6000, 28000),
      'api-2': alertOf('scale', 7000, 29000),
      'db-1': alertOf('restart', 3000, 25000),
      'worker-1': downOf('cleanup', 2000, 20000)
    },
    stats: { incidents: 5, breaches: 1 },
    ...extra
  });
}

// An always-correct bot: every reactMs it fixes the most urgent server (a
// down one first, then the least SLA left).
function botShift(ocs, level, seed, reactMs) {
  const rnd = seeded(seed);
  const state = ocs.ocsNewShift(level, 1);
  const marks = {};
  let next = reactMs;
  while (state.t < SHIFT) {
    ocs.ocsStep(state, null, rnd);
    if (state.t === 30000) marks.sixth = ocs.ocsUptime(state);
    if (state.t === 60000) marks.third = ocs.ocsUptime(state);
    if (!reactMs || state.t < next || state.t >= SHIFT) continue;
    let target = -1;
    let urgency = Infinity;
    state.servers.forEach((s, i) => {
      const key = s.st === 'down' ? -1 : s.left;
      if (s.st !== 'ok' && key < urgency) {
        urgency = key;
        target = i;
      }
    });
    if (target === -1) continue;
    const result = ocs.ocsStep(state, { server: target, action: state.servers[target].kind }, rnd).result;
    assert.ok(result === 'fix' || result === 'restore', result);
    next = state.t + reactMs;
  }
  return { uptime: ocs.ocsUptime(state), state, ...marks };
}

// A human-paced player: the same pick as the bot, but every fix takes 0.9 to
// 1.6 s, switching to another action costs 0.3 s more, and 5% of the picks
// are a wrong action. The player's own draws come from a second sequence, so
// the shift's incidents stay the bot's.
function humanShift(ocs, level, seed) {
  const rnd = seeded(seed);
  const me = seeded(seed * 7919 + 1);
  const state = ocs.ocsNewShift(level, 1);
  let next = 900;
  let armed = null;
  while (state.t < SHIFT) {
    ocs.ocsStep(state, null, rnd);
    if (state.t < next || state.t >= SHIFT) continue;
    let target = -1;
    let urgency = Infinity;
    state.servers.forEach((s, i) => {
      const key = s.st === 'down' ? -1 : s.left;
      if (s.st !== 'ok' && key < urgency) {
        urgency = key;
        target = i;
      }
    });
    if (target === -1) continue;
    const kind = state.servers[target].kind;
    const action = me() < 0.05 ? ACTIONS.filter((a) => a !== kind)[Math.floor(me() * 3)] : kind;
    const result = ocs.ocsStep(state, { server: target, action }, rnd).result;
    assert.ok(action === kind ? result === 'fix' || result === 'restore' : result === 'wrong', action + ' on ' + kind + ': ' + result);
    next = state.t + 900 + me() * 700 + (armed !== action ? 300 : 0);
    armed = action;
  }
  return ocs.ocsUptime(state);
}

// ── Pages ────────────────────────────────────────────────────────────────────

function fakeTimers(t) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
}

function writeStorage(storage) {
  for (const [key, value] of Object.entries(storage || {})) {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

// What a player sees and does.
function pageView(els, extra) {
  const rack = els['ocs-rack'];
  const view = {
    els,
    rack,
    tiles: () => rack.children,
    tile: (name) => rack.children[IDX[name]],
    tileText: (name) => {
      const tile = rack.children[IDX[name]];
      return [tile.children[1].textContent, tile.children[2].textContent];
    },
    text: (id) => els[id].textContent,
    status: () => els['ocs-status'].textContent,
    phase: () => ({ 'Start shift': 'ready', Pause: 'running', Resume: 'paused', 'Shift over': 'over' })[els['ocs-pause'].textContent],
    saved: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    act: (action) => els['ocs-act-' + action],
    choose: (action) => els['ocs-act-' + action].click(),
    tap: (name) => rack.children[IDX[name]].click(),
    toggle: () => els['ocs-pause'].click(),
    feed: () => els['ocs-feed'].children.map((li) => li.textContent),
    history: () => els['ocs-history'].children.map((li) => li.textContent),
    toastVisible: () => els['ocs-toast'].classList.contains('ocs-show')
  };
  return Object.assign(view, extra);
}

function bootPage(storage, options) {
  writeStorage(storage);
  const b = bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options);
  return pageView(b.els, { page: b.page, ready: b.ready, restore: b.restore });
}

// The page as a browser loads it: index.html's elements and script.js run as
// a classic script, after writing storage. Math.random is a fixed sequence.
function openPage(t, storage, options) {
  fakeTimers(t);
  if (!Math.random.mock) t.mock.method(Math, 'random', seeded(7));
  return bootPage(storage, options);
}

// A reload: the old page and its timers go away, storage stays.
function reload(t, page) {
  page.restore();
  fakeTimers(t);
  return bootPage();
}

// The script as a module on the page with init run by hand.
function openModule(t, storage) {
  fakeTimers(t);
  writeStorage(storage);
  const { exports: ocs, els, page } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  ocs.ocsInit();
  return pageView(els, { ocs, page });
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const px = (value) => {
  const m = /^(-?\d+(?:\.\d+)?)(px|rem)$/.exec(String(value).trim());
  assert.ok(m, 'a px or rem length: ' + value);
  return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
};

// ── Files ────────────────────────────────────────────────────────────────────

test('oncall-shift: every id the script looks up exists once in index.html, and ids, classes, CSS variables, keys and exports are ocs- prefixed', () => {
  const ids = Array.from(JS.matchAll(/document\.getElementById\('([^']+)'\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'ocs-act-cleanup', 'ocs-act-renew', 'ocs-act-restart', 'ocs-act-scale', 'ocs-best', 'ocs-clock',
    'ocs-feed', 'ocs-history', 'ocs-level', 'ocs-new', 'ocs-open', 'ocs-overlay', 'ocs-overlay-text',
    'ocs-overlay-title', 'ocs-pause', 'ocs-pm-copy', 'ocs-pm-grade', 'ocs-pm-log', 'ocs-pm-new', 'ocs-pm-note',
    'ocs-pm-stats', 'ocs-pm-uptime', 'ocs-postmortem', 'ocs-progress', 'ocs-progress-fill', 'ocs-rack',
    'ocs-root', 'ocs-share', 'ocs-status', 'ocs-toast', 'ocs-uptime', 'ocs-warning'
  ]);
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^ocs-/);
  assert.match(JS, /tile\.id = 'ocs-srv-' \+ i;/);

  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 40);
  for (const name of classes) assert.match(name, /^ocs-/);
  for (const m of JS.matchAll(/className = '([^']*)'/g)) for (const name of m[1].split(/\s+/).filter(Boolean)) assert.match(name, /^ocs-/);
  for (const m of JS.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g)) assert.match(m[1], /^ocs-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^ocs-/, selector);
    }
  }
  for (const m of CSS.matchAll(/--([\w-]+)/g)) assert.match(m[1], /^ocs-/);
  for (const m of CSS.matchAll(/@keyframes\s+([\w-]+)/g)) assert.match(m[1], /^ocs-/);
  for (const m of JS.matchAll(/--([\w-]+)/g)) assert.match(m[1], /^ocs-/);

  // Storage goes through the three prefixed keys only.
  assert.deepEqual(Array.from(JS.matchAll(/localStorage\.(\w+)\((\w+)/g), (m) => m[1] + ' ' + m[2]), ['getItem key', 'setItem key']);
  assert.deepEqual(Array.from(JS.matchAll(/var OCS_\w+_KEY = '([^']+)';/g), (m) => m[1]), [STATE_KEY, BEST_KEY, HISTORY_KEY]);
  const ocs = loadScript(SCRIPT);
  for (const name of Object.keys(ocs)) assert.match(name, /^ocs[A-Z]/);
});

test('oncall-shift: a standalone page like the others, whose files embed safely and keep the body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="ocs-wrapper" id="ocs-root">'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.doesNotMatch(embedded, /<style|<script|<link/i);
  assert.equal((HTML.match(/class="ocs-wrapper"/g) || []).length, 1, 'one wrapper');

  assert.match(HTML, /<title>On-Call Shift — Logs from VahaC<\/title>/);
  assert.match(HTML, /<meta name="description" content="[^"]{80,}">/);
  const bg = CSS.match(/--ocs-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.match(HTML, /<script src="script\.js"><\/script>\n<\/body>/);
  // Nothing from the network: no external URL in any of the three files.
  for (const text of [HTML, CSS, JS]) assert.doesNotMatch(text, /https?:\/\/|@import|url\(/);
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource)\b/);
});

test('oncall-shift: script.js is one strict IIFE in ES5', () => {
  assert.match(JS, /^(\/\/[^\n]*\r?\n)*\r?\n?\(function \(\) \{\r?\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1);
  const code = JS
    .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['exponent', /\*\*/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
  // The start-up guard: exports under Node, init on DOMContentLoaded or at once.
  assert.match(JS, /if \(typeof module !== 'undefined' && module\.exports\) \{\n {4}module\.exports = \{/);
  assert.match(JS, /\} else if \(document\.readyState === 'loading'\) \{\n {4}document\.addEventListener\('DOMContentLoaded', ocsInit\);\n {2}\} else \{\n {4}ocsInit\(\);\n {2}\}\n\}\)\(\);/);
});

test('oncall-shift: from 320 to 414 px the rack, the actions and the HUD fit without sideways scrolling, and the play area never blocks page scrolling', () => {
  const rules = cssRules(CSS);
  const sides = (value) => {
    const parts = String(value).split(/\s+/).map(px);
    return parts.length === 1 ? parts[0] : parts[1];
  };
  const resolve = (value, wrapper) => {
    const m = /^var\((--[\w-]+)\)$/.exec(String(value).trim());
    return m ? wrapper[m[1]] : value;
  };
  const charsFit = (chars, fontPx, width, where) => assert.ok(chars * 0.6 * fontPx <= width, where + ': ' + chars + ' chars at ' + fontPx + 'px in ' + width + 'px');
  const longestTileText = Math.max(...NAMES.map((n) => n.length), 'DISK 97%'.length, 'NO CACHE'.length, 'NO QUEUE'.length);
  assert.equal(longestTileText, 8);

  for (let vw = 320; vw <= 414; vw++) {
    const wrapper = declsAt(rules, '.ocs-wrapper', vw);
    const content = vw - 2 * sides(wrapper.padding);
    assert.ok(content >= 296, vw + 'px');
    // The rack: four equal columns that can shrink below their content.
    const rack = declsAt(rules, '.ocs-rack', vw);
    assert.equal(rack['grid-template-columns'], 'repeat(4, minmax(0, 1fr))');
    const tileWidth = (content - 2 - 2 * px(resolve(rack.padding, wrapper)) - 3 * px(resolve(rack.gap, wrapper))) / 4;
    const tile = declsAt(rules, '.ocs-tile', vw);
    assert.equal(tile['min-width'], '0');
    const inner = tileWidth - 2 - 2 * px(resolve(tile.padding, wrapper));
    charsFit(longestTileText, px(resolve(tile['font-size'], wrapper)), inner, vw + 'px tile');
    for (const part of ['.ocs-tile-name', '.ocs-tile-state', '.ocs-tile-timer']) {
      assert.equal(declsAt(rules, part, vw)['text-overflow'], 'ellipsis', part);
    }
    // The four action buttons.
    const actions = declsAt(rules, '.ocs-actions', vw);
    assert.equal(actions['grid-template-columns'], 'repeat(4, minmax(0, 1fr))');
    const act = declsAt(rules, '.ocs-act', vw);
    const actInner = (content - 3 * px(actions.gap)) / 4 - 2 - 2 * sides(act.padding);
    charsFit('cleanup'.length, px(declsAt(rules, '.ocs-act-name', vw)['font-size']), actInner, vw + 'px action');
    charsFit('leak, lost'.length, px(declsAt(rules, '.ocs-act-hint', vw)['font-size']), actInner, vw + 'px hint');
    // The HUD: two columns on phones, '99.999%' fits a card.
    const hud = declsAt(rules, '.ocs-hud', vw);
    assert.equal(hud['grid-template-columns'], 'repeat(2, minmax(0, 1fr))');
    const stat = declsAt(rules, '.ocs-stat', vw);
    const statInner = (content - px(hud.gap)) / 2 - 2 - 2 * sides(stat.padding);
    charsFit('99.999%'.length, px(declsAt(rules, '.ocs-stat-value', vw)['font-size']), statInner, vw + 'px stat');
    // Nothing has a fixed width wider than the phone.
    for (const r of rules) {
      for (const prop of ['width', 'min-width', 'flex-basis']) {
        const m = /^(\d+(?:\.\d+)?)px$/.exec(r.decls[prop] || '');
        if (m && vw >= r.minWidth && vw <= r.maxWidth) assert.ok(Number(m[1]) <= content, r.selectors.join() + ' ' + prop);
      }
    }
  }
  assert.equal(declsAt(rules, '.ocs-controls', 320)['flex-wrap'], 'wrap');
  assert.equal(declsAt(rules, '.ocs-pm-log', 320)['overflow-y'], 'auto');
  for (const part of ['.ocs-feed-line', '.ocs-pm-line', '.ocs-history-line', '.ocs-status', '.ocs-pm-stats', '.ocs-warning']) {
    assert.equal(declsAt(rules, part, 320)['overflow-wrap'], 'anywhere', part);
  }
  assert.equal(declsAt(rules, '.ocs-toast', 320)['max-width'], 'calc(100vw - 32px)');
  // Desktop: four HUD cards in a row.
  assert.equal(declsAt(rules, '.ocs-hud', 1280)['grid-template-columns'], 'repeat(4, minmax(0, 1fr))');
  // Taps never wait for a double-tap zoom, and nothing blocks the page's scrolling.
  assert.doesNotMatch(CSS, /touch-action:\s*none/);
  for (const part of ['.ocs-tile', '.ocs-act', '.ocs-btn', '.ocs-overlay']) assert.equal(declsAt(rules, part, 375)['touch-action'], 'manipulation', part);
  // hidden elements stay hidden whatever display their class gives them.
  assert.equal(declsAt(rules, '.ocs-wrapper [hidden]', 375).display, 'none');
});

test('oncall-shift: the 3x4 rack with its timers and the action bar fit a 320 px tall screen: landscape phones get compact tiles', () => {
  const rules = cssRules(CSS);
  const SHORT = '(max-height: 420px)';
  assert.ok(rules.some((r) => r.media === SHORT), 'a block for short screens');
  const short = { matchMedia: (media) => media === SHORT };
  // A length in px: rem counts 16 px, em the given font size, a bare 0 is 0.
  const len = (value, emPx) => {
    if (String(value).trim() === '0') return 0;
    const m = /^(\d+(?:\.\d+)?)em$/.exec(String(value).trim());
    return m ? Number(m[1]) * emPx : px(value);
  };
  const oneBorder = (decls, where) => {
    assert.match(decls.border, /^1px solid /, where);
    return 2;
  };
  // What the declared sizes add up to at a viewport width: the rack's height
  // (three rows of tiles), its margin and the action bar's height, plus the
  // longest tile text and action label against their room.
  const measure = (vw, options) => {
    const at = (selector) => declsAt(rules, selector, vw, options);
    const wrapper = at('.ocs-wrapper');
    const resolve = (value) => {
      const m = /^var\((--[\w-]+)\)$/.exec(String(value).trim());
      return m ? wrapper[m[1]] : value;
    };
    const tile = at('.ocs-tile');
    const font = px(resolve(tile['font-size']));
    const line = font * Number(tile['line-height']);
    const pad = px(resolve(tile.padding));
    const gap = px(tile.gap);
    const head = Math.max(px(at('.ocs-tile-led').height), line);
    const timer = Math.max(line, len(at('.ocs-tile-timer')['min-height'] || '0', font));
    const content = oneBorder(tile, '.ocs-tile') + 2 * pad + head + line + timer + px(at('.ocs-tile-bar').height) + 3 * gap;
    const tileHeight = Math.max(len(tile['min-height'], font), content);
    const rack = at('.ocs-rack');
    const rackHeight = 3 * tileHeight + 2 * px(resolve(rack.gap)) + 2 * px(resolve(rack.padding)) + oneBorder(rack, '.ocs-rack');
    const act = at('.ocs-act');
    const actLine = Number(act['line-height']);
    const actPad = String(act.padding).split(/\s+/).map(px);
    const labels = ['.ocs-act-key', '.ocs-act-name', '.ocs-act-hint']
      .filter((part) => at(part).display !== 'none')
      .map((part) => px(at(part)['font-size']) * actLine);
    const actHeight = oneBorder(act, '.ocs-act') + 2 * actPad[0] + labels.reduce((a, b) => a + b, 0);
    const total = rackHeight + px(at('.ocs-rack-wrap')['margin-bottom']) + actHeight;
    // Widths: '99.999%'-style checks as in the 320-414 px test.
    const wrapPad = String(wrapper.padding).split(/\s+/).map(px);
    const room = Math.min(vw, 860) - 2 * (wrapPad[1] === undefined ? wrapPad[0] : wrapPad[1]);
    const tileInner = (room - 2 - 2 * px(resolve(rack.padding)) - 3 * px(resolve(rack.gap))) / 4 - 2 - 2 * pad;
    const actInner = (room - 3 * px(at('.ocs-actions').gap)) / 4 - 2 - 2 * (actPad[1] === undefined ? actPad[0] : actPad[1]);
    return { total, tileHeight, actHeight, labels: labels.length, tileFits: 8 * 0.6 * font <= tileInner,
      actFits: 'cleanup'.length * 0.6 * px(at('.ocs-act-name')['font-size']) <= actInner &&
        'leak, lost'.length * 0.6 * px(at('.ocs-act-hint')['font-size']) <= actInner };
  };
  // Portrait phones (320-414 px wide, taller than 420 px): all three label lines, under 320 px.
  for (let vw = 320; vw <= 414; vw++) {
    const m = measure(vw);
    assert.equal(m.labels, 3, vw + 'px');
    assert.ok(m.total <= 320, vw + 'px portrait: ' + m.total.toFixed(1));
  }
  // The review's sums before this block: 568x320 needed about 349 px, 667x375 about 363 px.
  assert.ok(measure(568).total > 340 && measure(667).total > 355, 'the full-size layout is too tall for a landscape phone');
  // A screen at most 420 px tall (a landscape phone, any width): the key
  // digit line goes, the tiles shrink to their content, and the rack plus
  // the action bar stay under 270 px, leaving room for the browser's bars.
  for (let vw = 320; vw <= 1280; vw++) {
    const m = measure(vw, short);
    assert.equal(m.labels, 2, vw + 'px');
    assert.ok(m.total <= 270, vw + 'px short: ' + m.total.toFixed(1));
    assert.ok(m.tileHeight >= 44 && m.actHeight >= 40, vw + 'px: tiles and actions stay big enough to tap');
    assert.ok(m.tileFits && m.actFits, vw + 'px: tile text and action labels still fit');
  }
  assert.equal(declsAt(rules, '.ocs-act-key', 568, short).display, 'none');
  assert.equal(declsAt(rules, '.ocs-act-key', 568).display, undefined, 'tall screens keep the key digits');
});

// ── The shift model ─────────────────────────────────────────────────────────

test('oncall-shift: the rack has twelve generic services wired into cascades, four actions and three levels', () => {
  const ocs = loadScript(SCRIPT);
  assert.deepEqual(ocs.ocsServers.map((s) => s.name), NAMES);
  for (const server of ocs.ocsServers) {
    assert.match(server.name, /^(dns|lb|web|api|worker|backup|db|cache|queue)-\d$/, 'generic names, no brands');
    assert.ok(server.kinds.length >= 2);
    for (const kind of server.kinds) assert.ok(ACTIONS.includes(kind), kind);
    assert.deepEqual(server.upstream.map((i) => NAMES[i]), UPSTREAM[server.name] || []);
    for (const i of server.upstream) assert.deepEqual(ocs.ocsServers[i].upstream, [], 'an upstream is a root, so cascades never loop');
  }
  assert.deepEqual(ocs.ocsActions, ACTIONS);
  assert.deepEqual(Object.keys(ocs.ocsKinds), ACTIONS);
  // Every action is needed somewhere on the rack.
  for (const action of ACTIONS) assert.ok(ocs.ocsServers.some((s) => s.kinds.includes(action)), action);
  for (const [level, cfg] of Object.entries(LEVELS)) {
    assert.deepEqual({ ...ocs.ocsLevels[level], label: undefined }, { ...cfg, label: undefined }, level);
  }
  assert.deepEqual(ocs.ocsConfig, { tickMs: TICK, shiftMs: SHIFT, penaltyMs: PENALTY, firstSpawnMs: 2000, logMax: 600, historyMax: 5, toastMs: 2200, cols: 4 });
});

test('oncall-shift: a new shift starts at 22:00 with a healthy rack, and an unknown level is Normal', () => {
  const ocs = loadScript(SCRIPT);
  const fresh = ocs.ocsNewShift('hard', 4);
  assert.deepEqual(fresh, { ...shift({ level: 'hard', shiftNo: 4, nextSpawn: 2000 }) });
  assert.notEqual(fresh.servers[0], fresh.servers[1], 'every server is its own object');
  for (const level of ['insane', 'toString', undefined, ['easy']]) assert.equal(ocs.ocsNewShift(level, 1).level, 'normal', String(level));
  assert.equal(ocs.ocsIsOver ? 1 : 0, 0, 'internal helpers stay private');
  assert.equal(ocs.ocsUptime(fresh), 100);
  assert.equal(ocs.ocsDowntime(fresh), 0);
});

test('oncall-shift: incidents come faster and SLAs get shorter through the shift, in whole ticks', () => {
  const ocs = loadScript(SCRIPT);
  for (const [level, cfg] of Object.entries(LEVELS)) {
    assert.equal(ocs.ocsSpawnInterval(level, 0), cfg.spawnStart);
    assert.equal(ocs.ocsSpawnInterval(level, SHIFT), cfg.spawnEnd);
    assert.equal(ocs.ocsSpawnInterval(level, SHIFT * 2), cfg.spawnEnd, 'clamped after the end');
    assert.equal(ocs.ocsSlaFor(level, 0), cfg.slaStart);
    assert.equal(ocs.ocsSlaFor(level, SHIFT), cfg.slaEnd);
    let lastSpawn = Infinity;
    let lastSla = Infinity;
    for (let t = 0; t <= SHIFT; t += 6000) {
      const spawn = ocs.ocsSpawnInterval(level, t);
      const sla = ocs.ocsSlaFor(level, t);
      assert.ok(Math.abs(spawn - lerp(cfg.spawnStart, cfg.spawnEnd, t / SHIFT)) < 1e-9, level + ' ' + t);
      assert.equal(sla, Math.round(lerp(cfg.slaStart, cfg.slaEnd, t / SHIFT) / TICK) * TICK);
      assert.equal(sla % TICK, 0);
      assert.ok(spawn <= lastSpawn && sla <= lastSla);
      lastSpawn = spawn;
      lastSla = sla;
    }
  }
  // Harder levels are harder at every moment.
  for (let t = 0; t <= SHIFT; t += 30000) {
    assert.ok(ocs.ocsSlaFor('easy', t) > ocs.ocsSlaFor('normal', t) && ocs.ocsSlaFor('normal', t) > ocs.ocsSlaFor('hard', t));
    assert.ok(ocs.ocsSpawnInterval('easy', t) > ocs.ocsSpawnInterval('normal', t));
    assert.ok(ocs.ocsSpawnInterval('normal', t) > ocs.ocsSpawnInterval('hard', t));
  }
});

test('oncall-shift: the first incident comes at 2 s from three draws: the server, its kind and the next delay', () => {
  const ocs = loadScript(SCRIPT);
  const draws = [];
  const rnd = (value) => () => {
    draws.push(value);
    return value;
  };
  const state = ocs.ocsNewShift('normal', 1);
  let events = [];
  for (let k = 0; k < 19; k++) events = events.concat(ocs.ocsTick(state, () => assert.fail('no draw before 2 s')));
  assert.deepEqual(events, []);
  assert.equal(state.t, 1900);

  // 0.5 of 12 free servers is worker-1; 0 of its kinds is cleanup; 0.5 makes
  // the delay exactly the mean.
  const values = [0.5, 0, 0.5];
  events = ocs.ocsTick(state, () => rnd(values[draws.length])());
  assert.deepEqual(draws, [0.5, 0, 0.5]);
  assert.deepEqual(events, [[2000, IDX['worker-1'], 'alert', 'cleanup', 0]]);
  const sla = Math.round(lerp(LEVELS.normal.slaStart, LEVELS.normal.slaEnd, 2000 / SHIFT) / TICK) * TICK;
  assert.deepEqual(state.servers[IDX['worker-1']], { ...blank(), st: 'alert', kind: 'cleanup', left: sla, sla, since: 2000 });
  assert.equal(state.nextSpawn, 2000 + Math.round(lerp(LEVELS.normal.spawnStart, LEVELS.normal.spawnEnd, 2000 / SHIFT) / TICK) * TICK);
  assert.equal(state.stats.incidents, 1);
  assert.deepEqual(state.log.at(-1), events[0]);

  // A draw of exactly 1 still picks the last free server and kind; the
  // shortest delay is one tick.
  const second = ocs.ocsNewShift('hard', 1);
  second.t = 1900;
  ocs.ocsTick(second, () => 1);
  assert.equal(second.servers[11].st, 'alert');
  assert.equal(second.servers[11].kind, 'scale');
  const third = ocs.ocsNewShift('normal', 1);
  third.t = 1900;
  third.nextSpawn = 2000;
  ocs.ocsTick(third, () => 0);
  assert.equal(third.servers[0].kind, 'renew');
  assert.equal(third.nextSpawn, 2000 + Math.round(lerp(LEVELS.normal.spawnStart, LEVELS.normal.spawnEnd, 2000 / SHIFT) * 0.6 / TICK) * TICK);
  third.nextSpawn = third.t;
  for (const s of third.servers) Object.assign(s, { st: 'down', kind: 'restart' });
  const before = third.stats.incidents;
  ocs.ocsTick(third, () => 0);
  assert.equal(third.stats.incidents, before, 'no free server: nothing new, the next one is rescheduled');
  assert.ok(third.nextSpawn > third.t);
});

test('oncall-shift: an SLA runs out to the tick, then the server is down and counts 100 ms of downtime per tick', () => {
  const ocs = loadScript(SCRIPT);
  const state = shift({ t: 10000, servers: { 'cache-1': alertOf('scale', 500, 8000) } });
  const none = () => assert.fail('no draw');
  for (let k = 0; k < 4; k++) assert.deepEqual(ocs.ocsTick(state, none), []);
  assert.equal(state.servers[10].left, 100);
  assert.deepEqual(ocs.ocsTick(state, none), [[10500, 10, 'breach', 'scale', 8000]]);
  assert.deepEqual(state.servers[10], { ...blank(), st: 'down', kind: 'scale', left: 0, sla: 8000, since: 8000, outage: 0, down: 0 });
  assert.equal(state.stats.breaches, 1);
  // cache-1 has no upstream; api-1 and api-2 depend on it and wait 3 s.
  for (const name of ['api-1', 'api-2']) {
    assert.deepEqual([state.servers[IDX[name]].cascadeAt, state.servers[IDX[name]].cascadeFrom], [13500, 10], name);
  }
  for (let k = 0; k < 30; k++) ocs.ocsTick(state, none);
  assert.equal(state.servers[10].down, 3000);
  assert.equal(state.servers[10].outage, 3000);
  assert.equal(ocs.ocsDowntime(state), 3000);
  assert.equal(ocs.ocsUptime(state), uptimeOf(3000, 13500), 'a cascade alert is no downtime yet');
  assert.deepEqual([state.servers[IDX['api-1']].st, state.servers[IDX['api-1']].from], ['alert', 10]);
});

test('oncall-shift: a down database alerts its dependents after the cascade delay, until it is fixed', () => {
  const ocs = loadScript(SCRIPT);
  const none = () => assert.fail('no draw');
  const db1 = IDX['db-1'];
  const state = shift({ t: 40000, servers: { 'db-1': alertOf('cleanup', 100, 32000), 'api-1': alertOf('scale', 7000, 39000) } });
  assert.deepEqual(ocs.ocsTick(state, none).map((e) => e[2]), ['breach']);
  // web-1 and backup-1 are healthy and wait 3 s; api-1 already has an incident.
  assert.equal(state.servers[IDX['web-1']].cascadeAt, 43100);
  assert.equal(state.servers[IDX['backup-1']].cascadeAt, 43100);
  assert.equal(state.servers[IDX['api-1']].cascadeAt, null);
  for (let k = 0; k < 29; k++) assert.deepEqual(ocs.ocsTick(state, none), []);
  const events = ocs.ocsTick(state, none);
  assert.deepEqual(events, [[43100, IDX['web-1'], 'cascade', 'restart', db1], [43100, IDX['backup-1'], 'cascade', 'restart', db1]]);
  assert.equal(state.servers[IDX['web-1']].from, db1);
  assert.equal(state.stats.cascades, 2);
  assert.equal(state.stats.incidents, 2);

  // Restarting web-1 while db-1 is still down only buys time: a new alert
  // comes 3 s later.
  assert.equal(ocs.ocsApply(state, IDX['web-1'], 'restart').result, 'fix');
  ocs.ocsTick(state, none);
  assert.equal(state.servers[IDX['web-1']].cascadeAt, 43200 + 3000);
  // Fixing db-1 first cancels what is pending and nothing comes back.
  assert.equal(ocs.ocsApply(state, db1, 'cleanup').result, 'restore');
  assert.equal(state.servers[IDX['web-1']].cascadeAt, null);
  for (let k = 0; k < 50; k++) ocs.ocsTick(state, none);
  assert.equal(state.servers[IDX['web-1']].st, 'ok');
  assert.equal(state.servers[IDX['backup-1']].st, 'alert', 'an alert that already came stays until it is fixed');

  // api-1 has two upstreams: with db-1 fixed and cache-1 down, a new alert comes from cache-1.
  const both = shift({ t: 50000, servers: { 'db-1': downOf('cleanup', 1000, 40000), 'cache-1': downOf('restart', 1000, 40000) } });
  ocs.ocsTick(both, none);
  assert.equal(both.servers[IDX['api-1']].cascadeFrom, db1);
  ocs.ocsApply(both, db1, 'cleanup');
  ocs.ocsTick(both, none);
  assert.equal(both.servers[IDX['api-1']].cascadeFrom, IDX['cache-1']);
  assert.equal(both.servers[IDX['api-1']].cascadeAt, 50200 + 3000);
});

test('oncall-shift: the right action fixes or restores, a wrong one costs 1.5 s of downtime, a healthy server is left alone', () => {
  const ocs = loadScript(SCRIPT);
  const state = scenario();
  const before = JSON.stringify(state);
  assert.deepEqual(ocs.ocsApply(state, IDX['cache-1'], 'restart'), { result: 'healthy', entry: null });
  for (const [i, action] of [[-1, 'restart'], [12, 'restart'], [1.5, 'renew'], ['1', 'renew'], [1, 'reboot'], [1, null]]) {
    assert.deepEqual(ocs.ocsApply(state, i, action), { result: 'invalid', entry: null }, String(i) + ' ' + action);
  }
  assert.equal(JSON.stringify(state), before, 'nothing changed');

  // restart does not help a full disk.
  const web1 = IDX['web-1'];
  assert.deepEqual(ocs.ocsApply(state, web1, 'restart'), { result: 'wrong', entry: [30000, web1, 'wrong', 'restart', PENALTY] });
  assert.equal(state.servers[web1].down, PENALTY);
  assert.equal(state.servers[web1].st, 'alert', 'the incident stays');
  assert.equal(state.stats.wrong, 1);
  assert.equal(ocs.ocsDowntime(state), 2000 + PENALTY);

  assert.deepEqual(ocs.ocsApply(state, web1, 'cleanup'), { result: 'fix', entry: [30000, web1, 'fix', 'cleanup', 2000] });
  assert.deepEqual(state.servers[web1], { ...blank(), down: PENALTY }, 'healthy again, its downtime kept');
  assert.equal(state.stats.fixed, 1);
  assert.equal(state.stats.fixMs, 2000);

  const worker = IDX['worker-1'];
  assert.deepEqual(ocs.ocsApply(state, worker, 'cleanup'), { result: 'restore', entry: [30000, worker, 'restore', 'cleanup', 2000] });
  assert.equal(state.servers[worker].down, 2000);
  assert.deepEqual([state.stats.fixed, state.stats.restored, state.stats.worstMs, state.stats.worst], [2, 1, 2000, worker]);
  assert.deepEqual(state.log.slice(1).map((e) => e[2]), ['wrong', 'fix', 'restore']);

  // A shorter outage later does not replace the longest one.
  const db2 = IDX['db-2'];
  state.servers[db2] = downOf('cleanup', 500, 29000);
  ocs.ocsApply(state, db2, 'cleanup');
  assert.deepEqual([state.stats.worstMs, state.stats.worst], [2000, worker]);

  // After the end nothing applies.
  state.t = SHIFT;
  assert.deepEqual(ocs.ocsApply(state, IDX['lb-1'], 'renew'), { result: 'over', entry: null });
});

test('oncall-shift: ocsStep runs a tick for no input and applies an action otherwise, and the last tick ends the shift', () => {
  const ocs = loadScript(SCRIPT);
  const state = shift({ t: SHIFT - 200, servers: { 'lb-1': alertOf('renew', 5000, SHIFT - 200) } });
  assert.deepEqual(ocs.ocsStep(state, { server: IDX['lb-1'], action: 'renew' }), { result: 'fix', events: [[SHIFT - 200, 1, 'fix', 'renew', 0]] });
  assert.deepEqual(ocs.ocsStep(state, { server: IDX['lb-1'], action: 'renew' }), { result: 'healthy', events: [] });
  assert.deepEqual(ocs.ocsStep(state, null, Math.random), { result: 'tick', events: [] });
  const last = ocs.ocsStep(state, undefined, Math.random);
  assert.equal(last.result, 'end');
  assert.deepEqual(last.events.at(-1), [SHIFT, -1, 'end', null, 0]);
  assert.equal(state.t, SHIFT);
  const frozen = JSON.stringify(state);
  assert.deepEqual(ocs.ocsStep(state, null, Math.random), { result: 'tick', events: [] });
  assert.deepEqual(ocs.ocsStep(state, { server: 0, action: 'renew' }), { result: 'over', events: [] });
  assert.equal(JSON.stringify(state), frozen);

  // The log keeps the newest 600 entries.
  const full = scenario();
  full.log = Array.from({ length: 600 }, (_, k) => [k * 10, 2, 'alert', 'cleanup', 0]);
  ocs.ocsStep(full, { server: IDX['lb-1'], action: 'scale' });
  assert.equal(full.log.length, 600);
  assert.deepEqual(full.log[0], [10, 2, 'alert', 'cleanup', 0]);
  assert.deepEqual(full.log.at(-1), [30000, 1, 'wrong', 'scale', PENALTY]);
});

test('oncall-shift: balance: an always-correct bot keeps a Normal shift at 99.9% or better, an idle player is below 99% after 30 s', () => {
  const ocs = loadScript(SCRIPT);
  for (let seed = 1; seed <= 6; seed++) {
    const bot = botShift(ocs, 'normal', seed, 1000);
    assert.ok(bot.uptime >= 99.9, 'seed ' + seed + ': ' + bot.uptime);
    assert.ok(bot.state.stats.incidents >= 90, 'seed ' + seed + ': a busy night, ' + bot.state.stats.incidents + ' incidents');
    // The night gets busier: more incidents in the second half.
    const alerts = bot.state.log.filter((e) => e[2] === 'alert');
    const early = alerts.filter((e) => e[0] < SHIFT / 2).length;
    assert.ok(alerts.length - early > early * 1.4, 'seed ' + seed + ': ' + early + ' then ' + (alerts.length - early));

    const idle = botShift(ocs, 'normal', seed, 0);
    assert.ok(idle.sixth < 99, 'seed ' + seed + ' at 30 s: ' + idle.sixth);
    assert.ok(idle.third < 75, 'seed ' + seed + ' at 60 s: ' + idle.third);
    assert.ok(idle.uptime < 50, 'seed ' + seed + ' at the end: ' + idle.uptime);
    assert.equal(ocs.ocsGrade(idle.uptime).name, 'no nines');
    assert.ok(idle.state.stats.cascades > 0, 'idle servers take their dependents down');
  }
  // A slower bot (2 s per fix) separates the levels.
  const slow = (level) => [1, 2, 3].map((seed) => botShift(ocs, level, seed, 2000).uptime);
  const easy = slow('easy');
  const normal = slow('normal');
  const hard = slow('hard');
  for (let k = 0; k < 3; k++) {
    assert.ok(easy[k] >= 99.9, 'easy ' + easy[k]);
    assert.ok(normal[k] < easy[k] && normal[k] > 85, 'normal ' + normal[k]);
    assert.ok(hard[k] < normal[k], 'hard ' + hard[k]);
  }
});

test('oncall-shift: balance: Normal, the default, has no cliff: 1.5 s per fix keeps two nines, and so do most human-paced shifts', () => {
  const ocs = loadScript(SCRIPT);
  // Before the retune (spawnEnd 900, slaEnd 5000) a 1.5 s bot ended most
  // Normal shifts at one nine, and a human-paced player nearly every one.
  for (let seed = 1; seed <= 6; seed++) {
    const bot = botShift(ocs, 'normal', seed, 1500);
    assert.ok(bot.uptime >= 99, 'seed ' + seed + ': ' + bot.uptime);
  }
  const seeds = Array.from({ length: 10 }, (_, k) => k + 1);
  const twoNines = (level) => seeds.filter((seed) => humanShift(ocs, level, seed) >= 99).length;
  assert.equal(twoNines('easy'), 10);
  const normal = twoNines('normal');
  assert.ok(normal >= 8, 'normal: ' + normal + ' of 10');
  // Hard stays the level for fast hands: the same player never reaches one nine.
  assert.ok(seeds.every((seed) => humanShift(ocs, 'hard', seed) < 90));
});

test('oncall-shift: a shift is reproducible from its random numbers, and ticks use only the rnd they are given', (t) => {
  const ocs = loadScript(SCRIPT);
  t.mock.method(Math, 'random', () => assert.fail('Math.random is never called by the model'));
  const a = botShift(ocs, 'hard', 42, 1200);
  const b = botShift(ocs, 'hard', 42, 1200);
  assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
  assert.notEqual(JSON.stringify(botShift(ocs, 'hard', 43, 1200).state), JSON.stringify(a.state));
  // The saved shape is JSON all the way down.
  assert.deepEqual(JSON.parse(JSON.stringify(a.state)), a.state);
});

test('oncall-shift: uptime is downtime over 12 servers and the time so far, shown rounded down and graded in nines', () => {
  const ocs = loadScript(SCRIPT);
  const state = scenario();
  assert.equal(ocs.ocsUptime(state), uptimeOf(2000, 30000));
  state.servers[0].down = 1e9;
  assert.equal(ocs.ocsUptime(state), 0, 'never below 0');
  state.t = 0;
  assert.equal(ocs.ocsUptime(state), 100);

  for (const [uptime, text, grade] of [
    [100, '100%', 'five nines'], [99.9999, '99.999%', 'five nines'], [99.999, '99.999%', 'five nines'],
    [99.99899, '99.998%', 'four nines'], [99.99, '99.99%', 'four nines'], [99.95, '99.95%', 'three nines'],
    [99.9, '99.9%', 'three nines'], [99.89999, '99.899%', 'two nines'], [99.5, '99.5%', 'two nines'],
    [99, '99%', 'two nines'], [98.9999, '98.999%', 'one nine'], [90, '90%', 'one nine'],
    [89.9, '89.9%', 'no nines'], [12.3456, '12.345%', 'no nines'], [0, '0%', 'no nines']
  ]) {
    assert.equal(ocs.ocsFormatUptime(uptime), text, String(uptime));
    assert.equal(ocs.ocsGrade(uptime).name, grade, String(uptime));
  }
  assert.equal(ocs.ocsFloorUptime(99.95), 99.95);
  assert.deepEqual(ocs.ocsGrades.map((g) => g.nines), [5, 4, 3, 2, 1, 0]);
  for (const g of ocs.ocsGrades) assert.ok(g.note.length > 20, g.name);
  // One wrong action on an otherwise clean shift keeps three nines; a second one costs the third.
  assert.equal(ocs.ocsGrade(uptimeOf(PENALTY, SHIFT)).name, 'three nines');
  assert.equal(ocs.ocsGrade(uptimeOf(2 * PENALTY, SHIFT)).name, 'two nines');
});

test('oncall-shift: the shift clock runs 22:00 to 06:00 and durations read in shift time', () => {
  const ocs = loadScript(SCRIPT);
  for (const t of [0, 374, 375, 1000, 21000, 45000, 45374, 90000, 179999, SHIFT]) assert.equal(ocs.ocsClockText(t), clockAt(t), String(t));
  assert.equal(ocs.ocsClockText(0), '22:00');
  assert.equal(ocs.ocsClockText(45000), '00:00');
  assert.equal(ocs.ocsClockText(90000), '02:00');
  assert.equal(ocs.ocsClockText(SHIFT), '06:00');
  for (const [ms, text] of [[0, '0 s'], [100, '16 s'], [300, '48 s'], [375, '1 min'], [PENALTY, '4 min'], [8000, '21 min'], [22500, '1 h 0 min'], [30000, '1 h 20 min'], [SHIFT, '8 h 0 min']]) {
    assert.equal(ocs.ocsFormatDuration(ms), text, String(ms));
  }
});

test('oncall-shift: the cursor moves on the 4x3 rack and stops at its edges', () => {
  const ocs = loadScript(SCRIPT);
  const cases = [
    [0, 'left', 0], [0, 'up', 0], [0, 'right', 1], [0, 'down', 4], [3, 'right', 3], [3, 'down', 7],
    [5, 'up', 1], [5, 'left', 4], [8, 'down', 8], [11, 'right', 11], [11, 'down', 11], [11, 'up', 7], [9, 'left', 8]
  ];
  for (const [from, dir, to] of cases) assert.equal(ocs.ocsMoveIndex(from, dir), to, from + ' ' + dir);
  for (let i = 0; i < 12; i++) {
    for (const dir of ['left', 'right', 'up', 'down']) {
      const to = ocs.ocsMoveIndex(i, dir);
      assert.ok(to >= 0 && to < 12);
      assert.ok(Math.abs((to % 4) - (i % 4)) + Math.abs(Math.floor(to / 4) - Math.floor(i / 4)) <= 1);
    }
  }
});

test('oncall-shift: tiles show OK, the incident tag with the SLA minutes left, or DOWN with the minutes down', () => {
  const ocs = loadScript(SCRIPT);
  assert.deepEqual(ocs.ocsTileView(blank(), 0), { text: 'OK', timer: '', fill: 0, label: 'dns-1: healthy' });
  assert.deepEqual(ocs.ocsTileView(alertOf('cleanup', 6000, 0), IDX['db-1']), {
    text: 'DISK 97%', timer: '16m', fill: 75, label: 'db-1: disk 97% full, 16 min of SLA left'
  });
  assert.deepEqual(ocs.ocsTileView(alertOf('restart', 100, 0, { from: IDX['cache-1'] }), IDX['api-1']), {
    text: 'NO CACHE', timer: '1m', fill: 1.3, label: 'api-1: lost connection to cache-1, 1 min of SLA left'
  });
  assert.deepEqual(ocs.ocsTileView(downOf('scale', 2300, 0), IDX['web-2']), {
    text: 'DOWN', timer: '6m', fill: 100, label: 'web-2: DOWN, CPU pinned at 100%, down for 6 min'
  });
  assert.equal(ocs.ocsTileView(alertOf('renew', 8000, 0), 1).text, 'CERT EXP');
  assert.equal(ocs.ocsTileView(alertOf('scale', 8000, 0), 1).text, 'CPU 100%');
  assert.equal(ocs.ocsTileView(alertOf('restart', 8000, 0), 1).text, 'MEM LEAK');
  for (const [up, tag] of [['dns-1', 'NO DNS'], ['db-2', 'NO DB'], ['queue-1', 'NO QUEUE']]) {
    assert.equal(ocs.ocsTileView(alertOf('restart', 8000, 0, { from: IDX[up] }), 1).text, tag);
  }
});

test('oncall-shift: every log entry reads as a postmortem line, and breaches and cascades make the status line', () => {
  const ocs = loadScript(SCRIPT);
  const lines = [
    [[0, -1, 'start', null, 0], '22:00 shift started, the pager is live'],
    [[SHIFT, -1, 'end', null, 0], '06:00 shift over, pager handed to the day team'],
    [[2000, 0, 'alert', 'renew', 0], '22:05 ALERT dns-1: TLS certificate expires in 2 h'],
    [[16700, 2, 'cascade', 'restart', 8], '22:44 ALERT web-1: lost connection to db-1'],
    [[13700, 8, 'breach', 'restart', 7900], '22:36 DOWN db-1: SLA of 21 min breached'],
    [[20000, 2, 'fix', 'renew', 2300], '22:53 FIXED web-1: renew in 6 min'],
    [[17000, 8, 'restore', 'restart', 3300], '22:45 RESTORED db-1: restart after 9 min down'],
    [[2500, 0, 'wrong', 'cleanup', PENALTY], '22:06 WRONG dns-1: cleanup did not help, +4 min downtime']
  ];
  for (const [entry, line] of lines) {
    assert.equal(ocs.ocsLogLine(entry), line);
    assert.ok(line.startsWith(clockAt(entry[0])));
  }
  assert.equal(ocs.ocsEventsMessage([]), '');
  assert.equal(ocs.ocsEventsMessage([[1, 0, 'alert', 'renew', 0], [1, -1, 'end', null, 0]]), '');
  assert.equal(ocs.ocsEventsMessage([[1, 8, 'breach', 'restart', 7900]]), 'SLA breached: db-1 is DOWN. Use restart to bring it back.');
  assert.equal(ocs.ocsEventsMessage([[1, 8, 'breach', 'restart', 7900], [1, 2, 'cascade', 'restart', 8], [1, 3, 'alert', 'scale', 0]]),
    'Cascade: db-1 is down, so web-1 lost its connection.');
});

test('oncall-shift: the postmortem sums up the shift and carries its whole timeline', () => {
  const ocs = loadScript(SCRIPT);
  const state = ocs.ocsParseSave(SAVE_V1);
  let report = ocs.ocsReport(state);
  assert.equal(report.uptime, 97.182);
  assert.equal(report.uptimeText, '97.182%');
  assert.equal(report.grade.name, 'one nine');
  assert.equal(report.summary, [
    '10 incidents (2 cascades)', '6 fixed, mean time to fix 3 min', '3 SLA breaches', '1 wrong actions',
    '4 open at handover', 'total downtime 19 min', 'longest outage db-1, 9 min'
  ].join(' · '));
  assert.deepEqual(report.lines, state.log.map(ocs.ocsLogLine));
  assert.equal(report.text, ['On-Call Shift #3 (Normal) postmortem', 'Uptime 97.182% (one nine)', report.summary, 'Timeline:'].concat(report.lines).join('\n'));

  // A server still down at handover can hold the longest outage.
  state.servers[IDX['db-2']].outage = 9000;
  assert.match(ocs.ocsReport(state).summary, /longest outage db-2, 24 min$/);
  // A perfect, quiet shift.
  report = ocs.ocsReport(Object.assign(ocs.ocsNewShift('easy', 9), { t: SHIFT }));
  assert.equal(report.summary, '0 incidents (0 cascades) · 0 fixed · 0 SLA breaches · 0 wrong actions · 0 open at handover · total downtime 0 s');
  assert.equal(report.grade.name, 'five nines');
  assert.ok(report.text.startsWith('On-Call Shift #9 (Easy) postmortem\nUptime 100% (five nines)'));
});

// ── Saves (pure) ─────────────────────────────────────────────────────────────

test('oncall-shift: a save in the current format parses to the same shift and serialises back byte for byte', () => {
  const ocs = loadScript(SCRIPT);
  const state = ocs.ocsParseSave(SAVE_V1);
  assert.equal(JSON.stringify(state), SAVE_V1);
  assert.deepEqual(Object.keys(state), ['v', 'level', 'shiftNo', 't', 'nextSpawn', 'servers', 'stats', 'log']);
  assert.deepEqual(Object.keys(state.servers[0]), Object.keys(blank()));
  // What a fresh shift saves parses back unchanged too.
  const fresh = ocs.ocsNewShift('easy', 2);
  assert.deepEqual(ocs.ocsParseSave(JSON.stringify(fresh)), fresh);
  for (const text of [null, '', '{', 'null', '42', '"x"', 'true', '[]', '[{"t":5}]']) assert.equal(ocs.ocsParseSave(text), null, String(text));
});

test('oncall-shift: parsing a save falls back field by field', () => {
  const ocs = loadScript(SCRIPT);
  const parse = (fields) => ocs.ocsParseSave(JSON.stringify({ ...JSON.parse(SAVE_V1), ...fields }));
  const base = JSON.parse(SAVE_V1);

  assert.deepEqual(ocs.ocsParseSave('{}'), ocs.ocsNewShift('normal', 1), 'an empty object is a fresh shift');
  for (const level of ['insane', 'toString', 7, null]) assert.equal(parse({ level }).level, 'normal', String(level));
  assert.equal(parse({ level: 'hard' }).level, 'hard');
  for (const [t, want] of [[-5, 0], ['21000', 0], [null, 0], [SHIFT + 1, 0], [12345, 12300], [SHIFT, SHIFT]]) assert.equal(parse({ t }).t, want, String(t));
  assert.equal(ocs.ocsParseSave(SAVE_V1.replace('"t":21000', '"t":1e999')).t, 0);
  for (const [n, want] of [[0, 1], [-3, 1], [2.7, 2], ['x', 1], [12, 12]]) assert.equal(parse({ shiftNo: n }).shiftNo, want, String(n));
  for (const [next, want] of [[21000, 23000], [20000, 23000], [81001, 23000], ['22000', 23000], [21750, 21800], [81000, 81000]]) {
    assert.equal(parse({ nextSpawn: next }).nextSpawn, want, String(next));
  }
  // A server list of the wrong size or type: a healthy rack.
  for (const servers of [null, {}, base.servers.slice(1), base.servers.concat([blank()])]) {
    assert.deepEqual(parse({ servers }).servers, NAMES.map(blank));
  }
  // Server fields.
  const server = (i, raw) => {
    const servers = NAMES.map(() => blank());
    servers[i] = raw;
    return parse({ servers }).servers[i];
  };
  const api1 = IDX['api-1'];
  const sla = Math.round(lerp(LEVELS.normal.slaStart, LEVELS.normal.slaEnd, 21000 / SHIFT) / TICK) * TICK;
  assert.deepEqual(server(api1, null), blank());
  assert.deepEqual(server(api1, 5), blank());
  assert.deepEqual(server(api1, { st: 'alert', kind: 'nuke', down: 700 }), { ...blank(), down: 700 }, 'an unknown kind leaves it healthy');
  assert.deepEqual(server(api1, { st: 'burning', kind: 'scale' }), blank());
  assert.deepEqual(server(api1, { st: 'alert', kind: 'scale', from: 3, left: 99999, sla: 99999, since: 25000, down: -4 }),
    { ...blank(), st: 'alert', kind: 'scale', left: sla, sla, since: 21000 }, 'odd timers get the SLA of the moment');
  assert.deepEqual(server(api1, { st: 'alert', kind: 'restart', from: 10, left: 1250, sla: 6000, since: 20000, down: 300.7 }),
    { ...blank(), st: 'alert', kind: 'restart', from: 10, left: 1300, sla: 6000, since: 20000, down: 300 });
  assert.deepEqual(server(api1, { st: 'alert', kind: 'restart', left: 0, sla: 'x' }), { ...blank(), st: 'alert', kind: 'restart', left: sla, sla, since: 21000 });
  assert.deepEqual(server(api1, { st: 'down', kind: 'cleanup', left: 400, sla: 7000, outage: 5000, down: 3000, since: 1000 }),
    { ...blank(), st: 'down', kind: 'cleanup', sla: 7000, outage: 3000, down: 3000, since: 1000 }, 'an outage never longer than the downtime');
  assert.deepEqual(server(api1, { st: 'down', kind: 'cleanup', outage: 'x', down: 3000 }), { ...blank(), st: 'down', kind: 'cleanup', sla, down: 3000, since: 21000 });
  // Pending cascades: only from an upstream, within the next minute.
  assert.deepEqual(server(api1, { cascadeAt: 22000, cascadeFrom: 8 }), { ...blank(), cascadeAt: 22000, cascadeFrom: 8 });
  assert.deepEqual(server(api1, { cascadeAt: 22000, cascadeFrom: 9 }), blank());
  assert.deepEqual(server(api1, { cascadeAt: 20000, cascadeFrom: 8 }), blank());
  assert.deepEqual(server(api1, { cascadeAt: 81001, cascadeFrom: 8 }), blank());
  assert.deepEqual(server(api1, { cascadeAt: '22000', cascadeFrom: 8 }), blank());
  assert.equal(server(api1, { st: 'alert', kind: 'scale', left: 100, cascadeAt: 22000, cascadeFrom: 8 }).cascadeAt, null);

  // Stats: whole numbers of at least 0; the worst server needs an outage.
  assert.deepEqual(parse({ stats: null }).stats, { incidents: 0, fixed: 0, restored: 0, breaches: 0, wrong: 0, cascades: 0, fixMs: 0, worstMs: 0, worst: -1 });
  assert.deepEqual(parse({ stats: { incidents: 3.9, fixed: -2, wrong: '4', worstMs: 0, worst: 3 } }).stats,
    { incidents: 3, fixed: 0, restored: 0, breaches: 0, wrong: 0, cascades: 0, fixMs: 0, worstMs: 0, worst: -1 });
  assert.equal(parse({ stats: { worstMs: 900, worst: 12 } }).stats.worst, -1);
  assert.equal(parse({ stats: { worstMs: 900, worst: 4 } }).stats.worst, 4);

  // Log entries: broken ones are dropped, the newest 600 kept.
  const log = [
    [0, -1, 'start', null, 0], [1, 3, 'start', null, 0], [2, 2, 'alert', 'cleanup', 0], [3, 2, 'alert', 'nuke', 0],
    [4, 12, 'fix', 'scale', 5], [5, 2, 'cascade', 'restart', 8], [6, 2, 'cascade', 'restart', 9], [7, 2, 'party', 'scale', 0],
    [8, 2, 'fix', 'scale', -1], [9, 2, 'fix', 'scale'], [SHIFT + 1, 2, 'fix', 'scale', 0], 'x', null, [10, 2, 'wrong', 'renew', 1500],
    [11, 2, 'breach', 'scale', 7000], [12, 2, 'restore', 'scale', 300], [SHIFT, -1, 'end', null, 0], [13, '2', 'fix', 'scale', 0]
  ];
  assert.deepEqual(parse({ log }).log.map((e) => e[0]), [0, 2, 5, 10, 11, 12, SHIFT]);
  assert.deepEqual(parse({ log: 'x' }).log, [[0, -1, 'start', null, 0]]);
  assert.deepEqual(parse({ log: [] }).log, []);
  const long = Array.from({ length: 650 }, (_, k) => [k, 2, 'alert', 'scale', 0]);
  const kept = parse({ log: long }).log;
  assert.equal(kept.length, 600);
  assert.equal(kept[0][0], 50);
});

test('oncall-shift: best uptimes and the history fall back entry by entry', () => {
  const ocs = loadScript(SCRIPT);
  const none = { easy: null, normal: null, hard: null };
  for (const text of [null, '', 'x', '5', 'null', '"normal"', '[99]']) assert.deepEqual(ocs.ocsParseBest(text), none, String(text));
  assert.deepEqual(ocs.ocsParseBest('{"normal":99.95,"easy":"99","hard":120,"insane":100}'), { easy: null, normal: 99.95, hard: null });
  assert.deepEqual(ocs.ocsParseBest('{"easy":99.99999,"hard":0}'), { easy: 99.999, normal: null, hard: 0 });

  for (const text of [null, '', 'x', '{}', '5', '"a"']) assert.deepEqual(ocs.ocsParseHistory(text), [], String(text));
  const entry = (n, extra) => ({ n, level: 'normal', uptime: 99.5, incidents: 90, breaches: 2, wrong: 1, ...extra });
  assert.deepEqual(ocs.ocsParseHistory(JSON.stringify([
    entry(1), null, 7, entry(0), entry(2, { level: 'insane' }), entry(3, { uptime: 101 }), entry(4, { uptime: '99' }),
    entry(5, { incidents: -1, breaches: 'x', wrong: 2.5, uptime: 99.12345, extra: true })
  ])), [entry(1), { n: 5, level: 'normal', uptime: 99.123, incidents: 0, breaches: 0, wrong: 2 }]);
  const seven = Array.from({ length: 7 }, (_, k) => entry(k + 1));
  assert.deepEqual(ocs.ocsParseHistory(JSON.stringify(seven)).map((e) => e.n), [3, 4, 5, 6, 7]);
  assert.equal(ocs.ocsHistoryLine(entry(12, { level: 'hard', uptime: 99.95 })), '#12 Hard: 99.95% (three nines), 90 incidents, 2 breaches, 1 wrong actions');
});

test('oncall-shift: keys map to the game by key value, digits also by their physical key', () => {
  const ocs = loadScript(SCRIPT);
  const key = (k, code) => ocs.ocsKeyAction({ key: k, code });
  assert.equal(key(' ', 'Space'), 'pause');
  assert.equal(key('Spacebar'), 'pause');
  assert.equal(key('Enter', 'NumpadEnter'), 'apply');
  assert.equal(key('Escape'), 'escape');
  assert.deepEqual(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map((k) => key(k)), ['left', 'right', 'up', 'down']);
  assert.deepEqual(['1', '2', '3', '4'].map((k) => key(k, 'Digit' + k)), ACTIONS);
  assert.equal(key('&', 'Digit1'), 'cleanup', 'AZERTY');
  assert.equal(key('"', 'Digit3'), 'scale');
  assert.equal(key('4', 'Numpad4'), 'renew');
  assert.equal(key('End', 'Numpad1'), 'cleanup', 'keypad without Num Lock');
  for (const [k, code] of [['5', 'Digit5'], ['0', 'Digit0'], ['a', 'KeyA'], ['1', undefined], ['Tab', 'Tab'], ['x', 'Digit12']]) {
    assert.equal(key(k, code), k === '1' ? 'cleanup' : null, k + ' ' + code);
  }
  assert.equal(key(undefined, undefined), null, 'an autofill keydown has no key');
});

// ── The page ─────────────────────────────────────────────────────────────────

test('oncall-shift: loading the script under Node runs no init: no lookup, no listener, no timer, no storage', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const ocs = loadScript(SCRIPT);
  assert.equal(typeof ocs.ocsInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['ocs-rack'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('oncall-shift: a first visit shows a healthy rack of 12 tiles waiting for Start, saved at once, with every listener once', (t) => {
  const page = openPage(t);
  assert.equal(page.tiles().length, 12);
  page.tiles().forEach((tile, i) => {
    assert.equal(tile.tagName, 'BUTTON');
    assert.equal(tile.type, 'button');
    assert.equal(tile.id, 'ocs-srv-' + i);
    assert.equal(tile.getAttribute('tabindex'), '-1', 'the rack takes the Tab stop, not every tile');
    assert.equal(tile.getAttribute('data-server'), String(i));
    assert.equal(tile.className, 'ocs-tile ocs-tile-ok' + (i === 0 ? ' ocs-tile-cursor' : ''));
    assert.equal(tile.getAttribute('aria-label'), NAMES[i] + ': healthy');
    assert.equal(tile.textContent, NAMES[i] + 'OK');
    assert.equal(tile.children[3].children[0].style.width, '0%');
  });
  assert.equal(page.rack.getAttribute('aria-activedescendant'), 'ocs-srv-0');
  assert.equal(page.phase(), 'ready');
  assert.equal(page.els['ocs-overlay'].hidden, false);
  assert.equal(page.text('ocs-overlay-title'), 'Ready');
  assert.equal(page.text('ocs-overlay-text'), OVERLAY_READY);
  assert.ok(HTML.includes('<span id="ocs-overlay-text" class="ocs-overlay-text">' + OVERLAY_READY + '</span>'), 'the page loads with the same text');
  assert.equal(page.status(), READY);
  assert.deepEqual(['ocs-clock', 'ocs-uptime', 'ocs-open', 'ocs-best'].map(page.text), ['22:00', '100%', '0', '--']);
  assert.equal(page.els['ocs-uptime'].className, 'ocs-stat-value ocs-nines-5');
  assert.equal(page.els['ocs-progress-fill'].style.width, '0%');
  assert.equal(page.els['ocs-progress'].getAttribute('aria-valuenow'), '0');
  assert.equal(page.els['ocs-postmortem'].hidden, true);
  assert.equal(page.els['ocs-warning'].hidden, true);
  assert.deepEqual(page.feed(), ['22:00 shift started, the pager is live']);
  assert.deepEqual(page.history(), [NO_HISTORY]);
  assert.equal(page.els['ocs-level'].value, 'normal');
  for (const action of ACTIONS) assert.equal(page.act(action).getAttribute('aria-pressed'), 'false');
  // Saved at once; best and history wait for a finished shift.
  assert.equal(localStorage.getItem(STATE_KEY), JSON.stringify(shift({ nextSpawn: 2000 })));
  assert.equal(localStorage.length, 1);
  // One listener per control, keydown and visibilitychange on the document, pagehide on window.
  for (const id of ['ocs-new', 'ocs-pause', 'ocs-overlay', 'ocs-rack', 'ocs-pm-new', 'ocs-pm-copy', ...ACTIONS.map((a) => 'ocs-act-' + a)]) {
    assert.equal(listenerCount(page.els[id], 'click'), 1, id);
  }
  assert.equal(listenerCount(page.els['ocs-level'], 'change'), 1);
  assert.equal(listenerCount(document), 2);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(window), 1);
  assert.equal(listenerCount(window, 'pagehide'), 1);
  for (const type of ['touchstart', 'touchmove', 'touchend', 'wheel', 'scroll']) {
    assert.equal(listenerCount(document, type) + listenerCount(window, type) + listenerCount(page.rack, type), 0, type);
  }
  // No clock before Start.
  t.mock.timers.tick(10000);
  assert.equal(page.text('ocs-clock'), '22:00');
  assert.equal(page.saved().t, 0);
});

test('oncall-shift: while the page is still loading, the game waits for DOMContentLoaded', (t) => {
  const page = openPage(t, { [STATE_KEY]: SAVE_V1 }, { readyState: 'loading' });
  assert.equal(page.tiles().length, 0);
  assert.equal(page.text('ocs-clock'), '22:00');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(document, 'keydown'), 0);
  page.ready();
  assert.equal(page.tiles().length, 12);
  assert.equal(page.text('ocs-clock'), '22:56');
  assert.equal(listenerCount(document, 'keydown'), 1);
});

test('oncall-shift: init runs once, and a stray tick while paused changes nothing', (t) => {
  const page = openModule(t, { [STATE_KEY]: SAVE_V1 });
  page.ocs.ocsInit();
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(page.rack, 'click'), 1);
  assert.equal(page.tiles().length, 12);
  const before = JSON.stringify(page.ocs.ocsGetState());
  page.ocs.ocsOnTick();
  assert.equal(JSON.stringify(page.ocs.ocsGetState()), before);
  assert.equal(page.ocs.ocsRuntime.phase, 'paused');
});

test('oncall-shift: Start runs the shift one tick per 100 ms: the clock, the progress, the first incident and a save every second', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const page = openPage(t);
  page.toggle();
  assert.equal(page.phase(), 'running');
  assert.equal(page.status(), STARTED);
  assert.equal(page.els['ocs-overlay'].hidden, true);
  assert.equal(page.toastVisible(), true);
  assert.equal(page.text('ocs-toast'), 'Shift started');
  t.mock.timers.tick(999);
  assert.equal(page.saved().t, 0, 'the next save is due at 1 s');
  t.mock.timers.tick(1);
  assert.equal(page.saved().t, 1000);
  assert.equal(page.text('ocs-clock'), clockAt(1000));
  t.mock.timers.tick(1000);
  // Math.random 0: dns-1 gets a certificate to renew.
  assert.equal(page.tile('dns-1').className, 'ocs-tile ocs-tile-alert ocs-kind-renew ocs-tile-cursor');
  assert.deepEqual(page.tileText('dns-1'), ['CERT EXP', '22m']);
  assert.equal(page.text('ocs-open'), '1');
  assert.deepEqual(page.feed(), ['22:00 shift started, the pager is live', '22:05 ALERT dns-1: TLS certificate expires in 2 h']);
  t.mock.timers.tick(1000);
  const sla = Math.round(lerp(LEVELS.normal.slaStart, LEVELS.normal.slaEnd, 2000 / SHIFT) / TICK) * TICK;
  assert.equal(page.tile('dns-1').children[3].children[0].style.width, Math.round(1000 * (sla - 1000) / sla) / 10 + '%');
  t.mock.timers.tick(60000);
  assert.equal(page.text('ocs-clock'), clockAt(63000));
  assert.equal(page.els['ocs-progress-fill'].style.width, '35%');
  assert.equal(page.els['ocs-progress'].getAttribute('aria-valuenow'), '35');
  assert.ok(Number(page.text('ocs-uptime').replace('%', '')) < 99, 'an idle player is losing nines');
  assert.match(page.status(), /^(SLA breached: [\w-]+ is DOWN\. Use \w+ to bring it back\.|Cascade: [\w-]+ is down, so [\w-]+ lost its connection\.)$/);
  assert.equal(page.saved().t, 63000);
});

test('oncall-shift: tap an action, then servers: the action stays armed; a second tap on it disarms', (t) => {
  const page = openPage(t, { [STATE_KEY]: scenario() });
  page.toggle();
  page.choose('cleanup');
  assert.equal(page.act('cleanup').getAttribute('aria-pressed'), 'true');
  assert.ok(page.act('cleanup').classList.contains('ocs-act-armed'));
  assert.equal(page.status(), 'Armed: cleanup. Tap a server, or press Enter on the rack, to apply it.');
  page.tap('web-1');
  assert.equal(page.status(), 'Fixed: cleanup on web-1 worked in 5 min.');
  assert.equal(page.tile('web-1').className, 'ocs-tile ocs-tile-ok ocs-tile-cursor');
  assert.equal(page.saved().servers[IDX['web-1']].st, 'ok', 'saved at once');
  page.tap('worker-1');
  assert.equal(page.status(), 'worker-1 is back up after 5 min down.');
  assert.equal(page.act('cleanup').getAttribute('aria-pressed'), 'true', 'still armed');
  page.tap('cache-1');
  assert.equal(page.status(), 'cache-1 is healthy: nothing to cleanup.');
  assert.equal(page.saved().stats.wrong, 0, 'a healthy server costs nothing');
  page.choose('restart');
  assert.equal(page.act('cleanup').getAttribute('aria-pressed'), 'false');
  assert.equal(page.act('restart').getAttribute('aria-pressed'), 'true');
  page.choose('restart');
  assert.equal(page.act('restart').getAttribute('aria-pressed'), 'false');
  assert.equal(page.status(), 'No action armed.');
  assert.equal(page.text('ocs-open'), '3');
  assert.equal(page.text('ocs-uptime'), '99.444%');
});

test('oncall-shift: tap a server, then its action; a second tap on the server lets it go', (t) => {
  const page = openPage(t, { [STATE_KEY]: scenario() });
  page.toggle();
  page.tap('db-1');
  assert.equal(page.tile('db-1').className, 'ocs-tile ocs-tile-alert ocs-kind-restart ocs-tile-cursor ocs-tile-picked');
  assert.equal(page.status(), 'db-1 picked: choose an action (1 to 4) for it.');
  page.tap('db-1');
  assert.equal(page.tile('db-1').className, 'ocs-tile ocs-tile-alert ocs-kind-restart ocs-tile-cursor');
  assert.equal(page.status(), 'Selection cleared.');
  page.tap('db-1');
  page.choose('restart');
  assert.equal(page.status(), 'Fixed: restart on db-1 worked in 13 min.');
  assert.equal(page.tile('db-1').className, 'ocs-tile ocs-tile-ok ocs-tile-cursor');
  for (const action of ACTIONS) assert.equal(page.act(action).getAttribute('aria-pressed'), 'false', 'nothing stays armed');
  // A picked server takes the next action, wrong or right.
  page.tap('api-2');
  page.choose('renew');
  assert.equal(page.status(), 'Wrong action: renew does not fix "CPU pinned at 100%" on api-2, +4 min downtime.');
  assert.equal(page.tile('api-2').className, 'ocs-tile ocs-tile-alert ocs-kind-scale ocs-tile-cursor');
  assert.equal(page.saved().servers[IDX['api-2']].down, PENALTY);
  assert.equal(page.text('ocs-uptime'), '99.027%');
  assert.deepEqual(page.feed().slice(-2), ['23:20 FIXED db-1: restart in 13 min', '23:20 WRONG api-2: renew did not help, +4 min downtime']);
});

test('oncall-shift: keyboard on the rack: 1-4 arm, the arrows move, Enter applies, Space pauses, Escape clears', (t) => {
  const page = openPage(t, { [STATE_KEY]: scenario() });
  page.rack.focus();
  let ev = pressKey(' ');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(page.phase(), 'running');
  assert.equal(page.status(), 'Back on call: the shift continues.');
  ev = pressKey('1');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(page.act('cleanup').getAttribute('aria-pressed'), 'true');
  pressKey('1');
  assert.equal(page.act('cleanup').getAttribute('aria-pressed'), 'true', 'a key always arms');
  pressKey('ArrowRight');
  ev = pressKey('ArrowRight', { repeat: true });
  assert.equal(ev.defaultPrevented, true, 'arrows never scroll the page while the rack has the focus');
  assert.equal(page.rack.getAttribute('aria-activedescendant'), 'ocs-srv-2');
  assert.ok(page.tile('web-1').classList.contains('ocs-tile-cursor'));
  assert.ok(!page.tile('dns-1').classList.contains('ocs-tile-cursor'));
  ev = pressKey('Enter');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(page.status(), 'Fixed: cleanup on web-1 worked in 5 min.');
  pressKey('ArrowDown');
  pressKey('ArrowDown');
  pressKey('ArrowLeft');
  assert.equal(page.rack.getAttribute('aria-activedescendant'), 'ocs-srv-9');
  pressKey('ArrowLeft');
  pressKey('3');
  pressKey('Enter');
  assert.equal(page.status(), 'Wrong action: scale does not fix "memory leak eating RAM" on db-1, +4 min downtime.');
  pressKey('Enter', { repeat: true });
  assert.equal(page.saved().stats.wrong, 1, 'a held Enter acts once');
  pressKey('&', { code: 'Digit2' });
  pressKey('Enter');
  assert.equal(page.status(), 'Fixed: restart on db-1 worked in 13 min.');
  pressKey('Escape');
  assert.equal(page.status(), 'Selection cleared.');
  for (const action of ACTIONS) assert.equal(page.act(action).getAttribute('aria-pressed'), 'false');
  pressKey('Enter');
  assert.equal(page.status(), 'Choose an action first: 1 cleanup, 2 restart, 3 scale, 4 renew.');
  pressKey(' ', { repeat: true });
  assert.equal(page.phase(), 'running', 'a held Space does not toggle');
  pressKey(' ');
  assert.equal(page.phase(), 'paused');
  assert.equal(page.status(), PAUSED);
  assert.equal(page.text('ocs-overlay-title'), 'Paused');
  assert.equal(page.text('ocs-overlay-text'), OVERLAY_PAUSED);
  // Paused: an action can be armed, but nothing is applied.
  pressKey('4');
  pressKey('ArrowUp');
  pressKey('ArrowUp');
  pressKey('ArrowRight');
  pressKey('Enter');
  assert.equal(page.status(), 'The shift is paused: press Resume or Space first.');
  assert.equal(page.tile('lb-1').className, 'ocs-tile ocs-tile-alert ocs-kind-renew ocs-tile-cursor');
  // Keys on a tile inside the rack count as the rack's.
  ev = pressKey(' ', { target: page.tile('lb-1') });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(page.phase(), 'running');
  pressKey('Enter', { target: page.tile('lb-1') });
  assert.equal(page.status(), 'Fixed: renew on lb-1 worked in 8 min.');
});

test('oncall-shift: keys outside the game, in its fields, with Ctrl, Alt or Cmd or already handled, and arrows on its buttons are left alone', (t) => {
  const page = openPage(t, { [STATE_KEY]: scenario() });
  page.toggle();
  // The player then clicks somewhere else on the host page: nothing in the game has the focus.
  page.rack.blur();
  assert.equal(document.activeElement, document.body);
  const hostInput = page.page.add('host-input', 'input');
  const hostButton = page.page.add('host-button', 'button');
  const hostLink = page.page.add('host-link', { tagName: 'a', attributes: { href: '#' } });
  let hostClicks = 0;
  hostButton.addEventListener('click', () => { hostClicks++; });
  const untouched = (ev, what) => {
    assert.equal(ev.defaultPrevented, false, what);
    for (const action of ACTIONS) assert.equal(page.act(action).getAttribute('aria-pressed'), 'false', what);
    assert.equal(page.phase(), 'running', what);
    assert.equal(page.rack.getAttribute('aria-activedescendant'), 'ocs-srv-0', what);
  };
  // Nothing focused (the page body) is not "in the game".
  for (const key of ['1', ' ', 'Enter', 'ArrowDown', 'Escape']) untouched(pressKey(key), 'body ' + key);
  for (const target of [hostInput, hostButton, hostLink]) {
    for (const key of ['2', ' ', 'Enter', 'ArrowRight']) untouched(pressKey(key, { target }), target.tagName + ' ' + key);
  }
  assert.equal(hostClicks, 2, 'the host button keeps its own Enter and Space');
  page.rack.focus();
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
    for (const key of ['1', ' ', 'ArrowDown']) untouched(pressKey(key, { [mod]: true }), mod + ' ' + key);
  }
  untouched(pressKey('1', { isComposing: true }), 'composing');
  // A key a page script already handled (its capture listener ran first).
  const handled = (event) => event.preventDefault();
  document.addEventListener('keydown', handled, true);
  for (const key of ['1', ' ', 'ArrowDown']) {
    assert.equal(pressKey(key).defaultPrevented, true);
    untouched({ defaultPrevented: false }, 'handled ' + key);
  }
  document.removeEventListener('keydown', handled, true);
  untouched(pressKey('x'), 'not a game key');
  // The game's own select and text field keep their keys.
  untouched(pressKey('ArrowDown', { target: page.els['ocs-level'] }), 'select');
  untouched(pressKey('1', { target: page.els['ocs-share'] }), 'share field');
  // A focused game button keeps Enter, Space and the arrows (they scroll the
  // page); digits and Escape still play.
  assert.equal(pressKey(' ', { target: page.els['ocs-pause'] }).defaultPrevented, false);
  assert.equal(page.phase(), 'paused', 'Space clicked the Pause button, once');
  assert.equal(pressKey('Enter', { target: page.els['ocs-pause'] }).defaultPrevented, false);
  assert.equal(page.phase(), 'running');
  assert.equal(pressKey('2', { target: page.els['ocs-new'] }).defaultPrevented, true);
  assert.equal(page.act('restart').getAttribute('aria-pressed'), 'true');
  for (const target of [page.act('scale'), page.els['ocs-new'], page.els['ocs-pause'], page.els['ocs-pm-copy']]) {
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']) {
      assert.equal(pressKey(key, { target }).defaultPrevented, false, target.id + ' ' + key);
    }
  }
  assert.equal(page.rack.getAttribute('aria-activedescendant'), 'ocs-srv-0', 'the cursor moves only on the rack');
  assert.equal(pressKey('Escape', { target: page.els['ocs-new'] }).defaultPrevented, true);
  assert.equal(page.act('restart').getAttribute('aria-pressed'), 'false');
  assert.equal(page.status(), 'Selection cleared.');
});

test('oncall-shift: after a mouse click on Start shift, Pause or Resume the keys play on the rack, not on that button', (t) => {
  const page = openPage(t, { [STATE_KEY]: scenario() });
  const pause = page.els['ocs-pause'];
  assert.equal(pause.textContent, 'Resume');
  // Chrome and Edge focus a clicked button, so before the fix Enter and
  // Space clicked Pause again instead of reaching the rack.
  focusElement(pause);
  pause.click();
  assert.equal(page.phase(), 'running');
  assert.equal(document.activeElement, page.rack);
  pressKey('ArrowRight');
  assert.equal(pressKey('4').defaultPrevented, true);
  const enter = pressKey('Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(page.phase(), 'running', 'Enter applied the action, it did not pause');
  assert.equal(page.status(), 'Fixed: renew on lb-1 worked in 8 min.');
  assert.equal(document.activeElement, page.rack);
  // Pause by mouse: Space on the rack resumes.
  focusElement(pause);
  pause.click();
  assert.equal(page.phase(), 'paused');
  assert.equal(document.activeElement, page.rack);
  assert.equal(pressKey(' ').defaultPrevented, true);
  assert.equal(page.phase(), 'running');
  // Safari and Firefox on macOS give a clicked button no focus at all; the
  // click still hands the keys to the rack.
  page.rack.blur();
  pause.click();
  assert.equal(page.phase(), 'paused');
  assert.equal(document.activeElement, page.rack);
  assert.equal(pressKey(' ').defaultPrevented, true);
  assert.equal(page.phase(), 'running');
  // From the keyboard (Tab to the button, then Enter: a click with detail 0)
  // the focus stays on the button, which keeps its own Enter.
  focusElement(pause, { keyboard: true });
  fire(pause, 'click', { detail: 0 });
  assert.equal(page.phase(), 'paused');
  assert.equal(document.activeElement, pause);
});

test('oncall-shift: a mouse or touch click hands the keys to the rack; a keyboard-activated button keeps the focus', (t) => {
  const page = openPage(t, { [STATE_KEY]: scenario() });
  page.els['ocs-overlay'].click();
  assert.equal(page.phase(), 'running');
  assert.equal(document.activeElement, page.rack);
  page.els['ocs-pause'].focus();
  page.choose('scale');
  assert.equal(document.activeElement, page.rack);
  page.act('renew').focus();
  fire(page.act('renew'), 'click', { detail: 0 });
  assert.equal(document.activeElement, page.act('renew'));
  assert.equal(page.act('renew').getAttribute('aria-pressed'), 'true');
  // A tap on a tile's inner text still finds its tile; the rack's own padding does nothing.
  page.els['ocs-new'].focus();
  fire(page.tile('lb-1').children[1], 'click', { detail: 1 });
  assert.equal(document.activeElement, page.rack);
  assert.equal(page.status(), 'Fixed: renew on lb-1 worked in 8 min.');
  page.els['ocs-new'].focus();
  const statusBefore = page.status();
  page.rack.click();
  assert.equal(page.status(), statusBefore);
  assert.equal(document.activeElement, page.els['ocs-new']);
  page.els['ocs-new'].click();
  assert.equal(document.activeElement, page.rack, 'New Shift hands the keys to the rack');
  // Taps are clicks: the tiles are buttons and no touch handler holds the page.
  assert.equal(listenerCount(page.rack, 'touchstart') + listenerCount(document, 'touchstart'), 0);
});

test('oncall-shift: pause, the overlay and resume: no tick while paused and none piled up afterwards', (t) => {
  const page = openPage(t);
  assert.equal(page.els['ocs-pause'].textContent, 'Start shift');
  page.els['ocs-overlay'].click();
  assert.equal(page.els['ocs-pause'].textContent, 'Pause');
  t.mock.timers.tick(1200);
  // A stray click that still reaches the hidden overlay (a fast double tap)
  // neither restarts the clock nor says "Resumed".
  page.els['ocs-overlay'].click();
  assert.equal(page.status(), STARTED);
  assert.equal(page.text('ocs-toast'), 'Shift started');
  t.mock.timers.tick(300);
  page.toggle();
  assert.equal(page.els['ocs-pause'].textContent, 'Resume');
  assert.equal(page.status(), PAUSED);
  assert.equal(page.els['ocs-overlay'].hidden, false);
  assert.equal(page.saved().t, 1500, 'saved on pause');
  t.mock.timers.tick(30000);
  assert.equal(page.saved().t, 1500);
  assert.equal(page.text('ocs-clock'), clockAt(1500));
  page.els['ocs-overlay'].click();
  t.mock.timers.tick(1000);
  page.toggle();
  assert.equal(page.saved().t, 2500, 'exactly 1 s more, nothing caught up');
  page.toggle();
  t.mock.timers.tick(500);
  page.toggle();
  assert.equal(page.saved().t, 3000);
});

test('oncall-shift: a hidden tab pauses the shift, and coming back leaves it paused', (t) => {
  const page = openPage(t);
  setVisibility('hidden', t);
  assert.equal(page.phase(), 'ready', 'a shift that has not started stays ready');
  setVisibility('visible', t);
  page.toggle();
  t.mock.timers.tick(2000);
  setVisibility('hidden', t);
  assert.equal(page.phase(), 'paused');
  assert.equal(page.status(), PAUSED_HIDDEN);
  assert.equal(page.saved().t, 2000);
  t.mock.timers.tick(60000);
  setVisibility('visible', t);
  assert.equal(page.phase(), 'paused');
  assert.equal(page.saved().t, 2000);
  assert.equal(page.text('ocs-clock'), clockAt(2000));
  page.toggle();
  t.mock.timers.tick(300);
  fire(window, 'pagehide');
  assert.equal(page.saved().t, 2300, 'pagehide saves the running shift');
});

test('oncall-shift: a reload brings the shift back paused, exactly as it was, and it plays on from there', (t) => {
  t.mock.method(Math, 'random', () => 0);
  let page = openPage(t, { [STATE_KEY]: SAVE_V1 });
  assert.equal(localStorage.getItem(STATE_KEY), SAVE_V1, 'written back byte for byte');
  assert.equal(page.phase(), 'paused');
  assert.equal(page.status(), 'Shift restored, paused at 22:56. Press Resume or Space on the rack to continue.');
  assert.deepEqual(['ocs-clock', 'ocs-uptime', 'ocs-open'].map(page.text), ['22:56', '97.182%', '4']);
  assert.equal(page.els['ocs-uptime'].className, 'ocs-stat-value ocs-nines-1');
  assert.equal(page.els['ocs-progress-fill'].style.width, '11.7%');
  assert.deepEqual(page.tileText('api-1'), ['NO DB', '10m']);
  assert.equal(page.tile('api-1').children[3].children[0].style.width, '44.2%');
  assert.deepEqual(page.tileText('backup-1'), ['DOWN', '0m']);
  assert.deepEqual(page.tileText('db-2'), ['DOWN', '5m']);
  assert.equal(page.tile('db-2').className, 'ocs-tile ocs-tile-down ocs-kind-cleanup');
  assert.deepEqual(page.tileText('queue-1'), ['DISK 97%', '18m']);
  assert.deepEqual(page.feed(), [
    '22:50 DOWN db-2: SLA of 21 min breached', '22:52 ALERT queue-1: disk 97% full',
    '22:53 FIXED web-1: renew in 6 min', '22:55 DOWN backup-1: SLA of 21 min breached'
  ]);
  // Play on: dns-1 gets an incident at 21.7 s, db-2's cascade hits web-2 and api-2 at 21.9 s.
  page.toggle();
  t.mock.timers.tick(900);
  assert.equal(page.tile('dns-1').className, 'ocs-tile ocs-tile-alert ocs-kind-renew ocs-tile-cursor');
  assert.deepEqual(page.tileText('web-2'), ['NO DB', '21m']);
  assert.deepEqual(page.tileText('api-2'), ['NO DB', '21m']);
  assert.equal(page.status(), 'Cascade: db-2 is down, so api-2 lost its connection.');
  page.choose('cleanup');
  page.tap('db-2');
  assert.equal(page.status(), 'db-2 is back up after 8 min down.');
  page.choose('restart');
  page.tap('web-2');
  page.tap('api-2');
  t.mock.timers.tick(5000);
  page.toggle();
  assert.deepEqual(page.saved().log.filter((e) => e[2] === 'cascade' && e[0] > 21900), [], 'no new cascade once db-2 is back');
  assert.equal(page.saved().t, 26900);

  // Reload mid-shift: the same state, paused, one set of listeners.
  const saved = localStorage.getItem(STATE_KEY);
  page = reload(t, page);
  assert.equal(localStorage.getItem(STATE_KEY), saved);
  assert.equal(page.phase(), 'paused');
  assert.equal(page.text('ocs-clock'), clockAt(JSON.parse(saved).t));
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(window, 'pagehide'), 1);
  t.mock.timers.tick(5000);
  assert.equal(localStorage.getItem(STATE_KEY), saved, 'nothing runs before Resume');
});

test('oncall-shift: the end of the shift shows the postmortem, records the best and the history once, freezes the rack and gives the keys back to the page', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const near = shift({
    t: SHIFT - 1000,
    nextSpawn: SHIFT + 5000,
    shiftNo: 7,
    servers: {
      'lb-1': alertOf('renew', 5000, SHIFT - 4000),
      'web-1': alertOf('cleanup', 6000, SHIFT - 2000),
      'api-2': alertOf('scale', 7000, SHIFT - 1000),
      'db-1': alertOf('restart', 300, SHIFT - 7700),
      'worker-1': downOf('cleanup', 2000, SHIFT - 12000)
    },
    stats: { incidents: 5, breaches: 1 },
    log: [[0, -1, 'start', null, 0], [SHIFT - 4000, IDX['lb-1'], 'alert', 'renew', 0]]
  });
  let page = openPage(t, { [STATE_KEY]: near });
  page.toggle();
  page.choose('renew');
  page.tap('lb-1');
  t.mock.timers.tick(999);
  assert.equal(page.phase(), 'running');
  t.mock.timers.tick(1);
  assert.equal(page.phase(), 'over');
  assert.equal(page.els['ocs-pause'].disabled, true);
  assert.equal(page.els['ocs-overlay'].hidden, true);
  assert.equal(page.text('ocs-clock'), '06:00');
  assert.equal(page.els['ocs-postmortem'].hidden, false);
  // worker-1 was down for 3 s, db-1 breached at 179.3 s and stayed down 0.7 s.
  const uptime = Math.floor(uptimeOf(3000 + 700, SHIFT) * 1000) / 1000;
  assert.equal(uptime, 99.828);
  assert.equal(page.text('ocs-pm-uptime'), uptime + '%');
  assert.equal(page.text('ocs-pm-grade'), 'two nines');
  assert.equal(page.els['ocs-pm-grade'].className, 'ocs-pm-grade ocs-nines-2');
  assert.equal(page.text('ocs-pm-note'), 'Rough night: some pages were missed and users noticed.');
  assert.match(page.text('ocs-pm-stats'), /^5 incidents \(0 cascades\) · 1 fixed, mean time to fix 8 min · 2 SLA breaches · 0 wrong actions · 4 open at handover · total downtime 10 min · longest outage worker-1, 8 min$/);
  const lines = page.els['ocs-pm-log'].children;
  assert.deepEqual(lines.map((li) => li.textContent), [
    '22:00 shift started, the pager is live', '05:49 ALERT lb-1: TLS certificate expires in 2 h',
    '05:57 FIXED lb-1: renew in 8 min', '05:58 DOWN db-1: SLA of 21 min breached', '06:00 shift over, pager handed to the day team'
  ]);
  assert.deepEqual(lines.map((li) => li.className.split(' ')[1]), ['ocs-log-start', 'ocs-log-alert', 'ocs-log-fix', 'ocs-log-breach', 'ocs-log-end']);
  assert.equal(page.status(), 'Shift over: ' + uptime + '% uptime (two nines). The postmortem is below.');
  assert.equal(page.text('ocs-toast'), 'Shift over: ' + uptime + '%, a new best');
  assert.deepEqual(JSON.parse(localStorage.getItem(BEST_KEY)), { easy: null, normal: uptime, hard: null });
  assert.deepEqual(JSON.parse(localStorage.getItem(HISTORY_KEY)), [{ n: 7, level: 'normal', uptime, incidents: 5, breaches: 2, wrong: 0 }]);
  assert.deepEqual(page.history(), ['#7 Normal: ' + uptime + '% (two nines), 5 incidents, 2 breaches, 0 wrong actions']);
  assert.equal(page.text('ocs-best'), uptime + '%');
  assert.equal(page.saved().t, SHIFT);

  // Frozen: no tick, no action, no key; the armed renew is let go.
  for (const action of ACTIONS) assert.equal(page.act(action).getAttribute('aria-pressed'), 'false', action);
  const frozen = localStorage.getItem(STATE_KEY);
  t.mock.timers.tick(5000);
  page.tap('db-1');
  assert.equal(page.status(), 'The shift is over: start a New Shift.');
  assert.ok(!page.tile('db-1').classList.contains('ocs-tile-picked'));
  page.choose('restart');
  assert.equal(page.act('restart').getAttribute('aria-pressed'), 'false');
  // Every key is the page's again, so Space and the arrows scroll down to the postmortem.
  page.rack.focus();
  const cursor = page.rack.getAttribute('aria-activedescendant');
  for (const key of [' ', '3', 'Enter', 'ArrowDown', 'ArrowRight', 'Escape']) {
    assert.equal(pressKey(key).defaultPrevented, false, key);
  }
  assert.equal(pressKey('ArrowDown', { target: page.els['ocs-pm-new'] }).defaultPrevented, false);
  assert.equal(page.phase(), 'over');
  assert.equal(page.act('scale').getAttribute('aria-pressed'), 'false');
  assert.equal(page.rack.getAttribute('aria-activedescendant'), cursor, 'no cursor moves on the frozen rack');
  assert.equal(page.status(), 'The shift is over: start a New Shift.');
  page.els['ocs-pause'].click();
  page.els['ocs-overlay'].click();
  assert.equal(page.phase(), 'over', 'neither the disabled Pause nor a stray click on the hidden overlay restarts the clock');
  assert.equal(localStorage.getItem(STATE_KEY), frozen);

  // Copy the postmortem.
  const writes = [];
  t.mock.method(navigator.clipboard, 'writeText', (text) => {
    writes.push(text);
    return Promise.resolve();
  });
  page.els['ocs-pm-copy'].click();
  await flush();
  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith('On-Call Shift #7 (Normal) postmortem\nUptime ' + uptime + '% (two nines)\n5 incidents'));
  assert.ok(writes[0].endsWith('\nTimeline:\n' + lines.map((li) => li.textContent).join('\n')));
  assert.equal(page.text('ocs-toast'), 'Postmortem copied to the clipboard.');

  // A reload shows the same postmortem and records nothing twice.
  page = reload(t, page);
  assert.equal(page.phase(), 'over');
  assert.equal(page.status(), 'Shift over: ' + uptime + '% uptime. The postmortem is below.');
  assert.equal(page.els['ocs-postmortem'].hidden, false);
  assert.equal(page.els['ocs-pm-log'].children.length, 5);
  assert.equal(JSON.parse(localStorage.getItem(HISTORY_KEY)).length, 1);

  // New Shift from the postmortem: shift #8 runs at once.
  page.els['ocs-pm-new'].click();
  assert.equal(page.phase(), 'running');
  assert.equal(page.els['ocs-postmortem'].hidden, true);
  assert.equal(page.saved().shiftNo, 8);
  assert.equal(page.text('ocs-clock'), '22:00');
  assert.equal(page.text('ocs-best'), uptime + '%');
});

test('oncall-shift: a worse shift keeps the best, the history keeps the last 5 newest first, and Best follows the level', (t) => {
  const old = [1, 2, 3, 4, 5].map((n) => ({ n, level: n % 2 ? 'easy' : 'hard', uptime: 99 + n / 10, incidents: 80 + n, breaches: 5 - n, wrong: 0 }));
  const near = shift({ t: SHIFT - 100, shiftNo: 6, servers: { 'db-1': downOf('cleanup', 9000, 1000) } });
  const page = openPage(t, { [STATE_KEY]: near, [BEST_KEY]: { normal: 99.999, hard: 99.5 }, [HISTORY_KEY]: old });
  assert.equal(page.text('ocs-best'), '99.999%');
  page.toggle();
  t.mock.timers.tick(100);
  assert.equal(page.phase(), 'over');
  assert.equal(page.text('ocs-toast'), 'Shift over: 99.578%');
  assert.deepEqual(JSON.parse(localStorage.getItem(BEST_KEY)), { normal: 99.999, hard: 99.5 }, 'not written');
  assert.equal(page.text('ocs-best'), '99.999%');
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY));
  assert.deepEqual(history.map((h) => h.n), [2, 3, 4, 5, 6]);
  assert.equal(page.history().length, 5);
  assert.ok(page.history()[0].startsWith('#6 Normal: 99.578% (two nines)'));
  assert.ok(page.history()[4].startsWith('#2 Hard: 99.2% (two nines)'));
  assert.equal(page.els['ocs-history'].children[0].className, 'ocs-history-line ocs-nines-2');
  // A level change gets a fresh shift of that level ready, and Best follows it.
  page.els['ocs-level'].value = 'hard';
  fire(page.els['ocs-level'], 'change');
  assert.equal(page.phase(), 'ready');
  assert.equal(page.status(), READY);
  assert.equal(page.saved().level, 'hard');
  assert.equal(page.saved().shiftNo, 7);
  assert.equal(page.text('ocs-best'), '99.5%');
  page.els['ocs-level'].value = 'easy';
  fire(page.els['ocs-level'], 'change');
  assert.equal(page.text('ocs-best'), '--');
  page.els['ocs-level'].value = 'nightmare';
  fire(page.els['ocs-level'], 'change');
  assert.equal(page.saved().level, 'normal', 'an unknown level is Normal');
  assert.equal(page.els['ocs-level'].value, 'normal');
});

test('oncall-shift: a level change mid-shift waits for New Shift, and only a shift whose clock ran takes a number', (t) => {
  const page = openPage(t, { [STATE_KEY]: scenario({ shiftNo: 3 }) });
  const level = page.els['ocs-level'];
  const pick = (value) => {
    level.value = value;
    fire(level, 'change');
  };
  // Paused at 23:20: the shift stays as it was, and the status says what happens instead.
  const before = localStorage.getItem(STATE_KEY);
  pick('hard');
  assert.equal(page.phase(), 'paused');
  assert.equal(page.status(), 'Hard applies from your next shift: shift #3 plays on at Normal. Press New Shift to switch to Hard now.');
  assert.equal(page.text('ocs-toast'), 'Next shift: Hard');
  assert.equal(localStorage.getItem(STATE_KEY), before);
  assert.deepEqual(['ocs-clock', 'ocs-open'].map(page.text), ['23:20', '5']);
  assert.equal(level.value, 'hard', 'the select shows the level of the next shift');
  // Running: the shift plays on at Normal.
  page.toggle();
  t.mock.timers.tick(1000);
  pick('easy');
  assert.equal(page.phase(), 'running');
  assert.equal(page.status(), 'Easy applies from your next shift: shift #3 plays on at Normal. Press New Shift to switch to Easy now.');
  t.mock.timers.tick(1000);
  assert.equal(page.saved().t, 32000);
  assert.equal(page.saved().level, 'normal');
  assert.equal(page.saved().shiftNo, 3);
  pick('normal');
  assert.equal(page.status(), 'Normal again: shift #3 plays on at Normal, and so will the next one.');
  assert.equal(page.text('ocs-toast'), 'Next shift: Normal');
  // New Shift takes the select's level and the next number.
  level.value = 'hard';
  page.els['ocs-new'].click();
  assert.deepEqual([page.phase(), page.saved().level, page.saved().shiftNo, page.saved().t], ['running', 'hard', 4, 0]);
  // Before its first tick a shift has not run: a level change replaces it at
  // once, still running, under the same number.
  pick('easy');
  assert.deepEqual([page.phase(), page.saved().level, page.saved().shiftNo], ['running', 'easy', 4]);
  assert.equal(page.status(), STARTED);
  t.mock.timers.tick(500);
  assert.equal(page.text('ocs-clock'), clockAt(500));

  // A fresh page: Start has not been pressed, so every change replaces the ready shift and keeps #1.
  resetStubs();
  const fresh = openPage(t);
  fresh.els['ocs-level'].value = 'hard';
  fire(fresh.els['ocs-level'], 'change');
  assert.deepEqual([fresh.phase(), fresh.saved().level, fresh.saved().shiftNo], ['ready', 'hard', 1]);
  assert.equal(fresh.status(), READY);
  fresh.els['ocs-level'].value = 'easy';
  fire(fresh.els['ocs-level'], 'change');
  assert.deepEqual([fresh.phase(), fresh.saved().level, fresh.saved().shiftNo], ['ready', 'easy', 1]);
  // Paused before the first tick: still not run, still replaced.
  fresh.toggle();
  fresh.toggle();
  assert.equal(fresh.phase(), 'paused');
  fresh.els['ocs-level'].value = 'normal';
  fire(fresh.els['ocs-level'], 'change');
  assert.deepEqual([fresh.phase(), fresh.saved().level, fresh.saved().shiftNo], ['ready', 'normal', 1]);
});

test('oncall-shift: New Shift starts over at once without stacking intervals or listeners', (t) => {
  const page = openPage(t, { [STATE_KEY]: scenario({ shiftNo: 4 }) });
  page.toggle();
  page.tap('db-1');
  for (let k = 0; k < 3; k++) page.els['ocs-new'].click();
  assert.equal(page.phase(), 'running');
  // #4 had run to 23:20, so its successor is #5; the clocks of the next two
  // never ran (no tick between the clicks), so they keep #5.
  assert.equal(page.saved().shiftNo, 5);
  assert.equal(page.status(), STARTED);
  assert.equal(page.tile('db-1').className, 'ocs-tile ocs-tile-ok ocs-tile-cursor', 'the pick is gone with the old shift, the cursor stays');
  t.mock.timers.tick(1000);
  assert.equal(page.saved().t, 1000, 'one interval: one tick per 100 ms');
  page.els['ocs-level'].value = 'easy';
  page.els['ocs-new'].click();
  assert.equal(page.saved().level, 'easy');
  assert.equal(page.saved().shiftNo, 6);
  t.mock.timers.tick(1000);
  page.toggle();
  assert.equal(page.saved().t, 1000);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(page.rack, 'click'), 1);
  assert.equal(page.tiles().length, 12, 'the tiles are built once');
});

test('oncall-shift: a toast shown within 2.2 s of another stays up its full 2.2 s', (t) => {
  const page = openPage(t);
  page.toggle();
  assert.equal(page.toastVisible(), true);
  t.mock.timers.tick(1500);
  page.toggle();
  assert.equal(page.text('ocs-toast'), 'Paused');
  t.mock.timers.tick(700);
  assert.equal(page.toastVisible(), true, 'the first toast\'s time is up, not the second\'s');
  t.mock.timers.tick(1499);
  assert.equal(page.toastVisible(), true);
  t.mock.timers.tick(1);
  assert.equal(page.toastVisible(), false);
});

test('oncall-shift: without a working clipboard the postmortem is selected in a read-only field', async (t) => {
  const done = scenario({ t: SHIFT, nextSpawn: SHIFT + 100 });
  let page = openPage(t, { [STATE_KEY]: done });
  assert.equal(page.phase(), 'over');
  t.mock.method(navigator.clipboard, 'writeText', () => Promise.reject(new Error('NotAllowedError')));
  page.els['ocs-pm-copy'].click();
  await flush();
  const share = page.els['ocs-share'];
  assert.equal(share.hidden, false);
  assert.equal(share.readOnly, true);
  assert.ok(share.value.startsWith('On-Call Shift #1 (Normal) postmortem\nUptime '));
  assert.equal(document.activeElement, share);
  assert.equal(page.status(), 'Clipboard unavailable: the postmortem is selected in the field below, copy it with Ctrl+C (Cmd+C on a Mac).');
  page.els['ocs-pm-new'].click();
  assert.equal(share.hidden, true, 'a new shift hides it');

  // No clipboard API at all (an http page).
  const real = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  t.after(() => Object.defineProperty(navigator, 'clipboard', real));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  resetStubs();
  page = openPage(t, { [STATE_KEY]: done });
  page.els['ocs-pm-copy'].click();
  assert.equal(page.els['ocs-share'].hidden, false);
  assert.ok(page.els['ocs-share'].value.startsWith('On-Call Shift #1 (Normal) postmortem\n'));
  assert.equal(document.activeElement, page.els['ocs-share']);
});

test('oncall-shift: blocked or full storage shows a warning naming the error, and the game plays on', (t) => {
  blockStorage('access', t);
  let page = openPage(t);
  assert.equal(page.els['ocs-warning'].hidden, false);
  assert.equal(page.text('ocs-warning'), 'Storage is blocked (SecurityError): this shift, the best uptime and the history will not be saved.');
  page.toggle();
  t.mock.timers.tick(3000);
  assert.equal(page.text('ocs-clock'), clockAt(3000));
  page.choose('renew');
  page.tap('dns-1');
  resetStubs();

  // Full storage: the saved shift still loads, nothing new is written.
  localStorage.setItem(STATE_KEY, SAVE_V1);
  blockStorage('full', t);
  page = openPage(t);
  assert.equal(page.text('ocs-clock'), '22:56');
  assert.equal(page.text('ocs-warning'), 'Storage is full (QuotaExceededError): this shift, the best uptime and the history will not be saved.');
  page.toggle();
  t.mock.timers.tick(2000);
  assert.equal(localStorage.getItem(STATE_KEY), SAVE_V1);
  resetStubs();

  // A failure without an error name, reported once.
  t.mock.method(localStorage, 'setItem', () => { throw 'denied'; });
  page = openPage(t);
  assert.equal(page.text('ocs-warning'), 'Storage is blocked (Error): this shift, the best uptime and the history will not be saved.');
  page.els['ocs-warning'].textContent = 'seen';
  page.toggle();
  t.mock.timers.tick(2000);
  assert.equal(page.text('ocs-warning'), 'seen', 'one warning, not one per save');
});

test('oncall-shift: a corrupt save never breaks the page: a fresh shift is ready and the status says why', (t) => {
  for (const text of ['', '{', 'null', '42', '"x"', 'true', '[]', '[1,2]']) {
    resetStubs();
    const page = openPage(t, { [STATE_KEY]: text, [BEST_KEY]: 'garbage', [HISTORY_KEY]: '{"n":1}' });
    assert.equal(page.tiles().length, 12, JSON.stringify(text));
    assert.equal(page.phase(), 'ready', JSON.stringify(text));
    assert.equal(page.status(), 'The saved shift could not be read (not a JSON object): a fresh shift is ready.', JSON.stringify(text));
    assert.equal(page.text('ocs-best'), '--');
    assert.deepEqual(page.history(), [NO_HISTORY]);
    assert.equal(localStorage.getItem(STATE_KEY), JSON.stringify(shift({ nextSpawn: 2000 })), 'replaced by the fresh shift');
    page.toggle();
    t.mock.timers.tick(2500);
    assert.equal(page.text('ocs-open'), '1', JSON.stringify(text));
  }
  // A partial save keeps what is usable.
  resetStubs();
  const page = openPage(t, { [STATE_KEY]: '{"t":30000,"level":"hard","servers":"x","log":[]}' });
  assert.equal(page.phase(), 'paused');
  assert.equal(page.text('ocs-clock'), '23:20');
  assert.equal(page.saved().level, 'hard');
  assert.deepEqual(page.feed(), [], 'an empty log draws an empty feed');
  assert.equal(page.text('ocs-open'), '0');
  page.toggle();
  t.mock.timers.tick(2000);
  assert.equal(page.text('ocs-open'), '1', 'the next incident comes 2 s after the restored clock');
  // A save at 22:00 opens ready, not paused.
  resetStubs();
  const fresh = openPage(t, { [STATE_KEY]: { level: 'easy' } });
  assert.equal(fresh.phase(), 'ready');
  assert.equal(fresh.status(), READY);
  assert.equal(fresh.els['ocs-level'].value, 'easy');
});

test('oncall-shift: every class the page draws has a rule in style.css', (t) => {
  const page = openPage(t, { [STATE_KEY]: SAVE_V1 });
  page.toggle();
  page.tap('queue-1');
  t.mock.timers.tick(1000);
  const selectors = new Set(cssRules(CSS).flatMap((rule) => rule.selectors).flatMap((s) => Array.from(s.matchAll(/\.([\w-]+)/g), (m) => m[1])));
  const drawn = new Set();
  const walk = (node) => {
    String(node.className || '').split(/\s+/).filter(Boolean).forEach((name) => drawn.add(name));
    (node.children || []).forEach(walk);
  };
  walk(page.els['ocs-root']);
  for (const m of embedMarkup(HTML).matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((name) => drawn.add(name));
  for (const extra of ['ocs-show', 'ocs-act-armed', 'ocs-tile-cursor', 'ocs-tile-picked', 'ocs-tile-alert', 'ocs-tile-down', 'ocs-tile-ok',
    'ocs-nines-0', 'ocs-nines-1', 'ocs-nines-2', 'ocs-nines-3', 'ocs-nines-4', 'ocs-nines-5', 'ocs-history-empty', 'ocs-history-line',
    'ocs-pm-line', 'ocs-feed-line', ...['start', 'end', 'alert', 'cascade', 'breach', 'fix', 'restore', 'wrong'].map((c) => 'ocs-log-' + c),
    ...ACTIONS.map((a) => 'ocs-kind-' + a)]) drawn.add(extra);
  for (const name of drawn) assert.ok(selectors.has(name), name);
  assert.ok(drawn.has('ocs-tile-picked'));
  assert.ok(drawn.has('ocs-tile-down'));
});
