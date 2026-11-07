// tests/uptime-idle.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  createEvent, fire, pressKey, focusElement, setVisibility, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'uptime-idle';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

// The pure functions (the start-up code does not run under Node).
const upi = loadScript(SCRIPT);

const STATE_KEY = 'upi-state';
const STATS_KEY = 'upi-stats';
const MAX = Number.MAX_SAFE_INTEGER;
const SECOND = 1000;
const MINUTE = 60000;
const HOUR = 3600000;
const CAP = 8 * HOUR;
const TICK = 250;
// Local noon of 2026-11-06, built in local time.
const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime();

// The shop, pinned: a change to a price, an income or a watt changes the
// pacing and has to show up here (and in the simulations below).
const TABLE = {
  dns: { kind: 'service', name: 'DNS filter', base: 6, income: 0.5, watts: 15 },
  backup: { kind: 'service', name: 'Backup server', base: 150, income: 5, watts: 150 },
  photos: { kind: 'service', name: 'Photo archive', base: 4500, income: 50, watts: 1500 },
  media: { kind: 'service', name: 'Media server', base: 135000, income: 500, watts: 15000 },
  build: { kind: 'service', name: 'Build farm', base: 4000000, income: 5000, watts: 150000 },
  minipc: { kind: 'hardware', name: 'Mini PC', base: 100, slots: 3, watts: 15 },
  nas: { kind: 'hardware', name: 'NAS', base: 1500, slots: 4, watts: 50 },
  virt: { kind: 'hardware', name: 'Virtualization node', base: 20000, slots: 10, watts: 300 },
  rack: { kind: 'hardware', name: 'Server rack', base: 20000, units: 16, watts: 100 },
  raid: { kind: 'upgrade', name: 'RAID mirror', levels: [1500], needs: 'nas' },
  ups: { kind: 'upgrade', name: 'UPS', levels: [4000] },
  cooling: { kind: 'upgrade', name: 'Cooling', levels: [800, 20000, 300000] }
};
const IDS = Object.keys(TABLE);
const SERVICES = IDS.filter((id) => TABLE[id].kind === 'service');
const BOXES = ['minipc', 'nas', 'virt'];
const PUE = [1.6, 1.4, 1.25, 1.1];
const LAPTOP_SLOTS = 2;
const LAPTOP_WATTS = 20;
const DESK = 8;
const RACK_UNITS = 16;
const KWH_PRICE = 4;
const PRESTIGE_MIN = 300e6;
const EVENT_CHANCE = 1 / 360;

// A upi-state in the format the first published version writes: a small lab
// with 12 DNS filters, 4 backup servers, 5 mini PCs and the first cooling
// level, 1234.5 cr, a session goal under way, saved at NOW.
const SAMPLE_SAVE = '{"v":1,"credits":1234.5,' +
  '"owned":{"dns":12,"backup":4,"photos":0,"media":0,"build":0,"minipc":5,"nas":0,"virt":0,"rack":0,"raid":0,"ups":0,"cooling":1},' +
  '"event":null,"boost":0,"points":0,"runEarned":5678.25,"runMs":754000,"downMs":15000,"incidents":3,' +
  '"goal":{"target":1100,"progress":250.5,"reward":540},"goalsDone":4,"seed":123456789,"savedAt":' + NOW + '}';
const SAMPLE_STATS = '{"v":1,"totalEarned":98765.5,"prestiges":2}';

test.beforeEach(() => resetStubs());

// ── An independent model of the economy ────────────────────────────────────

const ownedOf = (extra) => Object.assign({ dns: 1, backup: 0, photos: 0, media: 0, build: 0, minipc: 0, nas: 0, virt: 0, rack: 0, raid: 0, ups: 0, cooling: 0 }, extra);

function costModel(id, n) {
  const item = TABLE[id];
  if (item.levels) return n < item.levels.length ? item.levels[n] : Infinity;
  return n >= 150 ? Infinity : Math.ceil(item.base * 1.15 ** n - 1e-7);
}

function slotsModel(o) {
  return {
    total: LAPTOP_SLOTS + BOXES.reduce((sum, id) => sum + o[id] * TABLE[id].slots, 0),
    used: SERVICES.reduce((sum, id) => sum + o[id], 0)
  };
}

function placesModel(o) {
  return { total: DESK + o.rack * RACK_UNITS, used: BOXES.reduce((sum, id) => sum + o[id], 0) };
}

const wattsModel = (o) => LAPTOP_WATTS + IDS.filter((id) => TABLE[id].watts).reduce((sum, id) => sum + o[id] * TABLE[id].watts, 0);

// The Homelab Power Cost Calculator formula: kWh = watts x hours / 1000,
// cost = kWh x price; here one second bills one hour, and the watts go
// through the PUE of the cooling.
const powerModel = (g) => (g.event && g.event.type === 'outage' ? 0 : wattsModel(g.owned) * PUE[g.owned.cooling] * 1 / 1000 * KWH_PRICE);

function grossModel(g) {
  if (g.event && g.event.type === 'outage') return 0;
  const base = SERVICES.reduce((sum, id) => sum + g.owned[id] * TABLE[id].income, 0);
  return base * (1 + 0.02 * g.points) * (g.boost > 0 ? 1.5 : 1) * (g.event && g.event.type === 'disk' ? 0.5 : 1);
}

const netModel = (g) => grossModel(g) - powerModel(g);

// A model state: a fresh lab unless extra says otherwise.
function game(extra = {}) {
  return Object.assign({
    credits: 0, event: null, boost: 0, points: 0, runEarned: 0, runMs: 0, downMs: 0, incidents: 0,
    goal: { target: 60, progress: 0, reward: 24 }, goalsDone: 0, seed: 1
  }, extra, { owned: ownedOf(extra.owned) });
}

// A upi-state save object (key order of the format), NOW as its time.
function saveOf(extra = {}) {
  const g = game(extra);
  return {
    v: 1, credits: g.credits, owned: g.owned, event: g.event, boost: g.boost, points: g.points, runEarned: g.runEarned,
    runMs: g.runMs, downMs: g.downMs, incidents: g.incidents, goal: g.goal, goalsDone: g.goalsDone, seed: g.seed,
    savedAt: extra.savedAt === undefined ? NOW : extra.savedAt
  };
}

// The first seed whose first draw starts an incident and whose second picks
// kind (rolls below 0.4 fail a disk, below 0.7 cut the power, else a kernel
// update), so a page with that seed past the first minute gets it on its first tick.
function seedFor(kind) {
  for (let s = 1; s < 100000; s++) {
    const rnd = upi.upiMulberry32(s);
    if (rnd() >= EVENT_CHANCE) continue;
    const k = rnd();
    if ((kind === 'disk' && k < 0.4) || (kind === 'outage' && k >= 0.4 && k < 0.7) || (kind === 'kernel' && k >= 0.7)) return s;
  }
  throw new Error('no seed for ' + kind);
}

// A seed with no incident in its first n draws.
function quietSeed(n) {
  for (let s = 1; s < 100000; s++) {
    const rnd = upi.upiMulberry32(s);
    let quiet = true;
    for (let i = 0; i < n && quiet; i++) quiet = rnd() >= EVENT_CHANCE;
    if (quiet) return s;
  }
  throw new Error('no quiet seed');
}

// What the page does on n ticks: a tick, then a roll for an incident.
function ticksOf(g, n) {
  const rnd = upi.upiMulberry32(g.seed);
  for (let i = 0; i < n; i++) {
    g = upi.upiTick(g, TICK);
    const roll = upi.upiApplyEvent(g, rnd);
    if (roll) g = roll.state;
  }
  return Object.assign(g, { seed: rnd.seed() });
}

// ── A player for the pacing simulations ─────────────────────────────────────
//
// Buys whatever pays itself back first: a service (with the slot it needs
// from the cheapest hardware per slot, or the rack when the desk is full),
// or the next cooling level; buys the RAID mirror and the UPS once they cost
// less than two minutes of income; replaces disks and reboots react ms after
// an incident; looks at the shop every `every` seconds.

function botChoice(g) {
  const o = g.owned;
  const cost = (id) => costModel(id, o[id]);
  const net = netModel(g);
  for (const id of ['raid', 'ups']) {
    if (o[id] === 0 && (id !== 'raid' || o.nas > 0) && cost(id) < net * 120) return g.credits >= cost(id) ? id : null;
  }
  const slots = slotsModel(o);
  const places = placesModel(o);
  let box = null;
  let perSlot = Infinity;
  for (const id of BOXES) {
    const per = cost(id) / TABLE[id].slots;
    if (per < perSlot) {
      perSlot = per;
      box = id;
    }
  }
  let action = null;
  let best = Infinity;
  const mult = 1 + 0.02 * g.points;
  const pue = PUE[o.cooling];
  for (const id of SERVICES) {
    const gain = TABLE[id].income * mult - TABLE[id].watts * pue * KWH_PRICE / 1000;
    let eff = cost(id);
    let act = id;
    if (slots.used >= slots.total) {
      if (places.used < places.total) {
        eff += perSlot;
        act = box;
      } else {
        eff += perSlot + cost('rack') / (RACK_UNITS * TABLE[box].slots);
        act = 'rack';
      }
    }
    if (eff / gain < best) {
      best = eff / gain;
      action = act;
    }
  }
  if (o.cooling < 3 && cost('cooling') / (wattsModel(o) * (PUE[o.cooling] - PUE[o.cooling + 1]) * KWH_PRICE / 1000) < best) action = 'cooling';
  return g.credits >= cost(action) ? action : null;
}

function play(seed, minutes, { every = 1, react = 5000, points = 0, buy = true } = {}) {
  let g = upi.upiFreshGame(seed, points);
  const rnd = upi.upiMulberry32(seed);
  const marks = {};
  const goals = [];
  const shares = [];
  let goalStart = 0;
  let waited = 0;
  for (let i = 1; i <= minutes * 240; i++) {
    const ms = i * TICK;
    g = upi.upiTick(g, TICK);
    const roll = upi.upiApplyEvent(g, rnd);
    if (roll) g = roll.state;
    if (g.event && g.event.type !== 'outage') {
      waited += TICK;
      if (waited >= react) {
        g = upi.upiResolve(g);
        waited = 0;
      }
    } else {
      waited = 0;
    }
    if (g.goalsDone > goals.length) {
      goals.push(ms - goalStart);
      goalStart = ms;
    }
    if (buy && i % (every * 4) === 0) {
      for (let k = 0; k < 20; k++) {
        const id = botChoice(g);
        if (!id) break;
        const result = upi.upiBuy(g, id);
        assert.ok(result.ok, result.reason);
        g = result.state;
        if (marks[id] === undefined) marks[id] = ms;
        if (marks.first === undefined) marks.first = ms;
      }
    }
    if (marks.migrate === undefined && upi.upiPrestige(g).ok) marks.migrate = ms;
    // The power bill's share of the income without incidents, once a minute.
    if (i % 240 === 0) shares.push(powerModel(Object.assign({}, g, { event: null })) / grossModel(Object.assign({}, g, { event: null, boost: 0 })));
  }
  return { g, marks, goals, shares };
}

// ── Pages ────────────────────────────────────────────────────────────────────

// One mocked clock for timers and Date.now, per test (Date.now is mocked once
// per test, so restoring it at the end of the test always brings the real
// one back).  advance(ms) runs the timers in steps of at most one tick, each
// step seeing its own wall time as in a browser (Node's mock timers would show
// every callback of one tick() call the end time, which looks like a gap).
// jump(ms) moves the wall clock alone, no timer fires: a clock set forwards
// or back, or a computer that slept with the tab open.  reset(gap) is a reload
// gap ms later: the old page's timers go away, as a real reload drops them.
const walls = new WeakMap();

function makeClock(t, when = NOW) {
  let wall = walls.get(t);
  if (!wall) {
    wall = { ms: when };
    walls.set(t, wall);
    t.mock.method(Date, 'now', () => wall.ms);
  }
  wall.ms = when;
  const enable = () => t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    enable();
  } catch (error) {
    t.mock.timers.reset(); // a second page in the same test
    enable();
  }
  return {
    now: () => wall.ms,
    advance(ms) {
      for (let left = ms; left > 0; left -= TICK) {
        const step = Math.min(TICK, left);
        wall.ms += step;
        t.mock.timers.tick(step);
      }
    },
    jump(ms) {
      wall.ms += ms;
    },
    reset(gap = 0) {
      wall.ms += gap;
      t.mock.timers.reset();
      enable();
    }
  };
}

function writeStorage({ state, stats } = {}) {
  if (state !== undefined) localStorage.setItem(STATE_KEY, typeof state === 'string' ? state : JSON.stringify(state));
  if (stats !== undefined) localStorage.setItem(STATS_KEY, typeof stats === 'string' ? stats : JSON.stringify(stats));
}

// What a player sees and does.
function pageView(b) {
  const els = b.els;
  const root = els['upi-root'];
  const item = (id) => root.querySelector('#upi-item-' + id);
  return {
    els,
    root,
    page: b.page,
    ready: b.ready,
    restore: b.restore,
    el: (name) => els['upi-' + name],
    text: (name) => els['upi-' + name].textContent,
    hidden: (name) => els['upi-' + name].classList.contains('upi-hidden'),
    item,
    buy: (id) => item(id).click(),
    // A key pressed with the focus on a shop button (inside the game).
    press(key, props) {
      focusElement(item('dns'), { keyboard: true });
      return pressKey(key, Object.assign({ target: item('dns') }, props));
    },
    toast: () => (els['upi-toast'].classList.contains('upi-show') ? els['upi-toast'].textContent : null),
    log: () => els['upi-log'].children.map((li) => li.textContent),
    state: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    stats: () => JSON.parse(localStorage.getItem(STATS_KEY))
  };
}

function boot(options) {
  return pageView(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options));
}

// The page as a browser loads it, after writing storage, with a mocked clock
// and Math.random.
function openPage(t, { when, random = 1, state, stats, options } = {}) {
  const clock = makeClock(t, when);
  t.mock.method(Math, 'random', seeded(random));
  writeStorage({ state, stats });
  return { clock, v: boot(options) };
}

// A reload gap ms later: the old page and its timers go away, storage stays.
function reload(clock, v, gap = 0) {
  v.restore();
  clock.reset(gap);
  return boot();
}

// Another tab's write: the text lands in storage and the storage event fires here.
function otherTabWrites(key, text) {
  localStorage.setItem(key, text);
  return fire(window, 'storage', { key, newValue: text });
}

const storedKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();

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

test('uptime-idle: every id the script looks up is in index.html once; ids, classes, CSS variables, keyframes, storage keys and exports are upi- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'upi-breakdown', 'upi-credits', 'upi-goal-bar', 'upi-goal-fill', 'upi-goal-progress', 'upi-goal-reward', 'upi-goal-text',
    'upi-hardware', 'upi-incident', 'upi-incident-action', 'upi-incident-text', 'upi-lifetime', 'upi-log', 'upi-migrate',
    'upi-migrate-text', 'upi-mult', 'upi-net', 'upi-places', 'upi-power', 'upi-root', 'upi-services', 'upi-slots', 'upi-toast',
    'upi-upgrades', 'upi-uptime', 'upi-warning', 'upi-welcome'
  ]);
  assert.equal(ids.length, new Set(ids).size, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^upi-/);
  // The ids and classes the script makes itself.
  assert.match(JS, /button\.id = 'upi-item-' \+ item\.id;/);
  for (const m of JS.matchAll(/className = '([^']+)'/g)) for (const name of m[1].split(/\s+/)) assert.match(name, /^upi-/, name);
  for (const m of JS.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g)) assert.match(m[1], /^upi-/, m[1]);
  for (const m of JS.matchAll(/upiMakeSpan\('([^']+)'/g)) assert.match(m[1], /^upi-/, m[1]);

  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 40);
  for (const name of classes) assert.match(name, /^upi-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^upi-/, selector);
    }
  }
  // Custom properties (not the --modifier part of a class name).
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^upi-/);
  for (const m of JS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^upi-/);
  const keyframes = Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);
  assert.deepEqual(keyframes, ['upi-blink']);
  for (const m of CSS.matchAll(/animation:\s*([\w-]+)/g)) assert.ok(m[1] === 'none' || keyframes.includes(m[1]), m[1]);
  assert.deepEqual([...new Set(Array.from(JS.matchAll(/'(upi-(?:state|stats))'/g), (m) => m[1]))].sort(), [STATE_KEY, STATS_KEY]);
  assert.doesNotMatch(JS, /(?:local|session)Storage\.(?:get|set|remove)Item\(\s*'(?!upi-)/, 'no storage key without the prefix');
  for (const name of Object.keys(upi)) assert.match(name, /^(upi[A-Z]|UPI_)/);
});

test('uptime-idle: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="upi-wrapper" id="upi-root" tabindex="-1">'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');
  const bg = CSS.match(/--upi-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Uptime Idle — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  // One script, at the end of the body; no external resources and no network at all.
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(|<a\s/i, 'no network resources and no links');
  }
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts)\b/, 'no network calls');
  // The power formula is named in plain text only.
  assert.match(HTML, /the Homelab Power Cost Calculator uses/);
  assert.match(JS, /the formula of the\n\/\/ Homelab Power Cost Calculator/);
});

test('uptime-idle: script.js is one strict IIFE in ES5, and reads the clock and Math.random in one place each', () => {
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
    ['Promise', /\bPromise\b|\basync\b|\bawait\b/], ['includes', /\.includes\(/], ['Number.', /\bNumber\.\w/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
  assert.equal(code.match(/\bDate\b/g).length, 1, 'Date only in upiNow');
  assert.match(JS, /function upiNow\(\) \{\n {4}return Date\.now\(\);\n {2}\}/);
  assert.equal(code.match(/Math\.random/g).length, 1, 'Math.random only seeds a fresh game');
  assert.match(JS, /upiParseState\(text, Math\.floor\(Math\.random\(\) \* 4294967296\)\)/);
  // The model section uses no DOM, no clock and no Math.random.
  const model = JS.slice(JS.indexOf('// ── Economy model'), JS.indexOf('// ── Saves')).replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(model, /document|window|localStorage|Date|Math\.random|setTimeout|setInterval/);
});

test('uptime-idle: index.html labels every control, and its help text matches the rules', () => {
  const spec = htmlPageSpec(HTML);
  assert.equal(spec['upi-root'].attributes.tabindex, '-1');
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
      // The accessible name starts with the visible text, so a speech user can say what they see (the script keeps it so).
      assert.ok(props.attributes['aria-label'].startsWith(props.textContent), id + ': ' + props.attributes['aria-label']);
    }
  }
  assert.equal(spec['upi-incident-action'].attributes['aria-label'], 'Nothing to do');
  assert.equal(spec['upi-toast'].attributes['aria-live'], 'polite');
  assert.equal(spec['upi-log'].attributes['aria-live'], 'polite');
  // The incident line counts down every second, so it is not a live region: the log announces each incident once.
  assert.equal(spec['upi-incident-text'].attributes, undefined);
  assert.equal(spec['upi-warning'].attributes.role, 'alert');
  assert.equal(spec['upi-welcome'].attributes.role, 'status');
  assert.equal(spec['upi-goal-bar'].attributes.role, 'progressbar');
  for (const id of ['upi-warning', 'upi-welcome', 'upi-incident-action']) assert.match(spec[id].className, /\bupi-hidden\b/, id);
  for (const text of ['the desk holds 8 machines', 'the desk holds 8.', 'A server rack holds 16 more', 'costs 15% more', 'up to 8 hours',
    '4 cr per kWh', '300.0M cr earned in a run', '+2% income each', 'about 3 minutes of income', 'a bonus of 90 seconds', '1 to 9 buy',
    'for 30 s', '+50% income for 60 s']) {
    assert.ok(HTML.includes(text), text);
  }
  assert.equal(upi.UPI_PRESTIGE_MIN, PRESTIGE_MIN);
  assert.equal(upi.upiFormat(PRESTIGE_MIN), '300.0M');
  assert.equal(upi.UPI_OFFLINE_CAP_MS, CAP);
  assert.equal(upi.UPI_TICK_MS, TICK);
});

test('uptime-idle: from 320 to 1440 px nothing widens the page: stat cards, shop items and long numbers wrap inside their grid cells', () => {
  const rules = cssRules(CSS);
  for (let vw = 320; vw <= 1440; vw++) {
    const wrapper = declsAt(rules, '.upi-wrapper', vw);
    const side = px(wrapper.padding.split(/\s+/)[1]);
    const available = Math.min(vw, px(wrapper['max-width'])) - 2 * side;
    assert.equal(wrapper['box-sizing'], 'border-box');
    assert.equal(wrapper['overflow-wrap'], 'anywhere');
    assert.equal(declsAt(rules, '.upi-wrapper *', vw)['box-sizing'], 'border-box');
    // Stats: equal minmax(0, 1fr) columns; the big cards span more of them.
    const stats = declsAt(rules, '.upi-stats', vw);
    const columns = /^repeat\((\d+), minmax\(0, 1fr\)\)$/.exec(stats['grid-template-columns']);
    assert.ok(columns, vw + 'px: ' + stats['grid-template-columns']);
    const n = Number(columns[1]);
    const gap = px(stats.gap);
    const column = (available - (n - 1) * gap) / n;
    const spanOf = (selector) => Number(/^span (\d+)$/.exec(declsAt(rules, selector, vw)['grid-column'])[1]);
    // Two big cards share a row, the five small ones fill whole rows or less.
    assert.equal(spanOf('.upi-stat--wide') * 2, n);
    assert.equal(n % spanOf('.upi-stat'), 0);
    const stat = declsAt(rules, '.upi-stat', vw);
    assert.equal(stat['min-width'], '0');
    const inner = (span) => span * column + (span - 1) * gap - 2 * px(stat.padding.split(/\s+/)[1]) - 2;
    const value = declsAt(rules, '.upi-stat-value', vw);
    assert.equal(value['white-space'], 'normal');
    assert.equal(value['overflow-wrap'], 'anywhere');
    assert.equal(value.overflow, undefined);
    assert.equal(value['text-overflow'], undefined);
    // 0.61em a character covers the widest common monospace fonts; the widest values wrap at their spaces.
    const fits = (text, span, size) => {
      const char = 0.61 * rem(size);
      const lines = wrapWords(text, Math.floor(inner(span) / char));
      return lines.every((line) => line.length * char <= inner(span));
    };
    const big = declsAt(rules, '.upi-stat-value--big', vw)['font-size'];
    for (const text of ['9.0Q cr', '+120.0k cr/s', '-1.2k cr/s']) assert.ok(fits(text, spanOf('.upi-stat--wide'), big), vw + 'px: ' + text);
    for (const text of ['22.5 MW', '99.99%', '750/2552', '450/2408', '×1.26']) assert.ok(fits(text, spanOf('.upi-stat'), value['font-size']), vw + 'px: ' + text);
    // Shop: equal columns of buttons whose content stacks from the top and wraps.
    const items = declsAt(rules, '.upi-items', vw);
    assert.match(items['grid-template-columns'], /^repeat\([23], minmax\(0, 1fr\)\)$/, vw + 'px');
    const item = declsAt(rules, '.upi-item', vw);
    assert.deepEqual([item.display, item['flex-direction'], item['align-items'], item['justify-content'], item['text-align'], item['min-width'],
      item['white-space'], item['overflow-wrap']], ['flex', 'column', 'stretch', 'flex-start', 'left', '0', 'normal', 'anywhere'], vw + 'px');
    assert.equal(declsAt(rules, '.upi-item-name', vw)['min-width'], '0');
    assert.equal(declsAt(rules, '.upi-item-top', vw)['min-width'], '0');
    const cell = (available - (Number(/\d+/.exec(items['grid-template-columns'])[0]) - 1) * px(items.gap)) / Number(/\d+/.exec(items['grid-template-columns'])[0]);
    assert.ok(cell >= 130, vw + 'px: shop cells of ' + cell + 'px');
    assert.equal(declsAt(rules, '.upi-incident-text', vw)['min-width'], '0');
  }
  // Nothing has a fixed width that could pass a 320 px phone.
  for (const rule of rules) {
    for (const prop of ['width', 'min-width']) {
      const value = rule.decls[prop];
      if (value && /px$/.test(value)) assert.ok(px(value) <= 300, rule.selectors.join(', ') + ' ' + prop + ': ' + value);
    }
  }
  // The toast is as wide as its message, up to the screen less 1rem a side.
  const toast = declsAt(rules, '.upi-toast', 320);
  assert.equal(toast.width, 'max-content');
  assert.equal(toast['max-width'], 'calc(100% - 2rem)');
  assert.equal(toast['pointer-events'], 'none');
  // Tap targets keep the page from zooming on a double tap; nothing blocks scrolling.
  const touch = rules.filter((r) => r.decls['touch-action'] !== undefined);
  assert.deepEqual(touch.map((r) => [r.selectors.join(', '), r.decls['touch-action']]), [
    ['.upi-btn', 'manipulation'], ['.upi-item', 'manipulation'], ['.upi-help-title', 'manipulation']
  ]);
  assert.deepEqual([3, 2].map((cols, i) => declsAt(rules, '.upi-items', [1024, 375][i])['grid-template-columns']),
    ['repeat(3, minmax(0, 1fr))', 'repeat(2, minmax(0, 1fr))']);
});

// WCAG relative luminance and contrast ratio of #rrggbb colors.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('uptime-idle: the coloured buttons keep their text at 4.5:1 or more, hovered or not, at every stop of their gradients', () => {
  const rules = cssRules(CSS);
  const vars = declsAt(rules, '.upi-wrapper', 375);
  const resolve = (value) => String(value).replace(/var\((--upi-[\w-]+)\)/g, (m, name) => vars[name]);
  const short = (hex) => (hex.length === 4 ? '#' + hex.slice(1).split('').map((c) => c + c).join('') : hex).toLowerCase();
  // Each state's rules in cascade order (later and more specific last), as the browser applies them.
  const states = {
    incident: ['.upi-btn', '.upi-btn--incident'],
    'incident hovered': ['.upi-btn', '.upi-btn--incident', '.upi-btn:hover', '.upi-btn--incident:hover'],
    'migrate hovered': ['.upi-btn', '.upi-btn--migrate', '.upi-btn:hover', '.upi-btn--migrate:hover'],
    ready: ['.upi-btn', '.upi-btn--migrate', '.upi-btn--ready'],
    'ready hovered': ['.upi-btn', '.upi-btn--migrate', '.upi-btn--ready', '.upi-btn:hover', '.upi-btn--migrate:hover', '.upi-btn--ready:hover'],
    armed: ['.upi-btn', '.upi-btn--migrate', '.upi-btn--ready', '.upi-btn--armed'],
    'armed hovered': ['.upi-btn', '.upi-btn--migrate', '.upi-btn--ready', '.upi-btn--armed', '.upi-btn:hover', '.upi-btn--migrate:hover',
      '.upi-btn--ready:hover', '.upi-btn--armed:hover']
  };
  for (const [state, selectors] of Object.entries(states)) {
    const decls = Object.assign({}, ...selectors.map((s) => declsAt(rules, s, 375)));
    const text = short(resolve(decls.color));
    const stops = Array.from(resolve(decls.background).matchAll(/#[0-9a-fA-F]{3,6}\b/g), (m) => short(m[0]));
    assert.ok(stops.length >= 1, state + ': ' + decls.background);
    for (const stop of stops) assert.ok(contrast(text, stop) >= 4.5, state + ': ' + text + ' on ' + stop + ' is ' + contrast(text, stop).toFixed(2) + ':1');
  }
  // The incident button's text is dark, as the armed button's.
  assert.equal(declsAt(rules, '.upi-btn--incident', 375).color, '#111827');
  assert.ok(contrast('#ffffff', '#f59e0b') < 4.5, 'white on amber, as it was, failed');
});

// ── Numbers, prices and the PRNG ────────────────────────────────────────────

test('uptime-idle: numbers read 512 / 1.2k / 3.4M / 5.6B / 7.8T / 9.0Q, cut down and never rounded up', () => {
  for (const [value, text] of [
    [0, '0'], [0.5, '0.5'], [0.276, '0.27'], [0.08, '0.08'], [0.004, '0'], [-0.004, '0'], [7, '7'], [12.34, '12.3'], [12, '12'], [99.99, '99.9'], [100.7, '100'], [999.99, '999'],
    [1000, '1.0k'], [1234, '1.2k'], [1299.99, '1.2k'], [999999, '999.9k'], [1e6, '1.0M'], [3.45e6, '3.4M'], [5.67e9, '5.6B'],
    [7.89e12, '7.8T'], [MAX, '9.0Q'], [-1234, '-1.2k'], [-0.25, '-0.25'], [-5, '-5'], [NaN, '0'], [Infinity, '0'], ['12', '0']
  ]) {
    assert.equal(upi.upiFormat(value), text, String(value));
  }
  // Against a model: the shown value never exceeds the real one and is within one step of it.
  const random = seeded(3);
  const units = [[1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k'], [1, '']];
  for (let i = 0; i < 2000; i++) {
    const value = Math.floor(10 ** (random() * 16));
    const text = upi.upiFormat(value);
    const m = /^(\d+(?:\.\d)?)([kMBTQ]?)$/.exec(text);
    assert.ok(m, text);
    const unit = units.find((u) => u[1] === m[2])[0];
    const shown = Number(m[1]) * unit;
    const step = m[2] ? unit / 10 : 1;
    assert.ok(shown <= value * (1 + 1e-12) && value - shown < step * (1 + 1e-9), value + ' -> ' + text);
    assert.ok(m[2] === '' ? value < 1000 : Number(m[1]) >= 1 && Number(m[1]) < 1000, value + ' -> ' + text);
  }
  for (const [ms, text] of [[0, '0s'], [59999, '59s'], [60000, '1m 00s'], [185000, '3m 05s'], [3599999, '59m 59s'], [HOUR, '1h 00m'],
    [2 * HOUR + 5 * MINUTE, '2h 05m'], [CAP, '8h 00m'], [86399999, '23h 59m'], [3 * 86400000 + 4 * HOUR, '3d 04h'], [-5000, '0s'], [NaN, '0s']]) {
    assert.equal(upi.upiFormatDuration(ms), text, String(ms));
  }
  for (const [watts, text] of [[35, '35 W'], [999, '999 W'], [1000, '1.0 kW'], [15000, '15.0 kW'], [22.5e6, '22.5 MW'], [3.45e9, '3.4 GW']]) {
    assert.equal(upi.upiFormatWatts(watts), text, String(watts));
  }
  assert.deepEqual([137, 60, 0.276 * 180, 1100, 99.5, 0, -3].map(upi.upiNiceCeil), [140, 60, 50, 1100, 100, 0, 0]);
});

test('uptime-idle: prices grow as base x 1.15^n rounded up, upgrades have one price per level, and nothing costs past Number.MAX_SAFE_INTEGER', () => {
  assert.deepEqual(upi.UPI_ITEMS.map((item) => item.id), IDS);
  for (const item of upi.UPI_ITEMS) {
    const expected = Object.assign({ id: item.id }, TABLE[item.id]);
    assert.deepEqual(item, expected, item.id);
    assert.equal(upi.upiItem(item.id), item);
  }
  assert.equal(upi.upiItem('laptop'), null, 'the old laptop is not sold');
  const cost = (id, n) => upi.upiCostOf(upi.upiItem(id), n);
  assert.deepEqual([cost('dns', 0), cost('dns', 1), cost('dns', 10), cost('minipc', 1), cost('rack', 1), cost('rack', 2), cost('virt', 10)],
    [6, 7, 25, 115, 23000, 26450, 80912]);
  for (const id of IDS) {
    for (let n = 0; n <= 151; n++) {
      const value = cost(id, n);
      assert.equal(value, costModel(id, n), id + ' #' + n);
      if (value === Infinity) continue;
      assert.ok(Number.isSafeInteger(value) && value < MAX, id + ' #' + n);
      if (!TABLE[id].levels) assert.ok(value >= TABLE[id].base * 1.15 ** n * (1 - 1e-12) && value < TABLE[id].base * 1.15 ** n + 1, id + ' #' + n);
    }
  }
  assert.equal(cost('dns', 150), Infinity, 'sold out at 150');
  assert.deepEqual([0, 1, 2, 3].map((n) => cost('cooling', n)), [800, 20000, 300000, Infinity]);
  assert.deepEqual([0, 1].map((n) => cost('raid', n)), [1500, Infinity]);
});

test('uptime-idle: mulberry32 matches the reference and carries its position in seed()', () => {
  const ours = upi.upiMulberry32(7);
  const reference = seeded(7);
  for (let i = 0; i < 1000; i++) assert.equal(ours(), reference());
  const a = upi.upiMulberry32(99);
  a();
  a();
  const b = upi.upiMulberry32(a.seed());
  const c = seeded(99);
  c();
  c();
  for (let i = 0; i < 10; i++) assert.equal(b(), c());
  assert.equal(upi.upiMulberry32(7)(), 0.011704753153026104);
});

// ── The economy ──────────────────────────────────────────────────────────────

test('uptime-idle: slots, places, watts and the power bill follow the Homelab Power Cost Calculator formula', (t) => {
  const random = seeded(11);
  for (let i = 0; i < 300; i++) {
    const owned = {};
    for (const id of IDS) owned[id] = TABLE[id].levels ? Math.floor(random() * (TABLE[id].levels.length + 1)) : Math.floor(random() * 40);
    const kinds = [null, { type: 'disk', left: 0 }, { type: 'outage', left: 5000 }, { type: 'kernel', left: 5000 }];
    const g = game({ owned, points: Math.floor(random() * 50), boost: random() < 0.3 ? 30000 : 0, event: kinds[Math.floor(random() * 4)] });
    const slots = slotsModel(g.owned);
    const places = placesModel(g.owned);
    assert.deepEqual(upi.upiSlots(g), { total: slots.total, used: slots.used, free: Math.max(0, slots.total - slots.used) });
    assert.deepEqual(upi.upiPlaces(g), { total: places.total, used: places.used, free: Math.max(0, places.total - places.used) });
    assert.equal(upi.upiWatts(g), wattsModel(g.owned));
    assert.equal(upi.upiPue(g), PUE[g.owned.cooling]);
    assert.ok(Math.abs(upi.upiPowerRate(g) - powerModel(g)) < 1e-9, 'power ' + i);
    assert.ok(Math.abs(upi.upiGrossRate(g) - grossModel(g)) <= Math.abs(grossModel(g)) * 1e-12, 'gross ' + i);
    assert.ok(Math.abs(upi.upiNetRate(g) - netModel(g)) < 1e-6, 'net ' + i);
    assert.equal(upi.upiMultiplier(g), 1 + 0.02 * g.points);
  }
  // The start: the laptop (20 W) and one DNS filter (15 W) at PUE 1.6: 35 W x 1.6 x 1 h x 4 cr / 1000.
  const start = upi.upiFreshGame(5, 0);
  assert.ok(Math.abs(upi.upiPowerRate(start) - 0.224) < 1e-12);
  assert.ok(Math.abs(upi.upiNetRate(start) - 0.276) < 1e-12);
  assert.deepEqual(start.owned, ownedOf());
  assert.deepEqual(start.goal, { target: 60, progress: 0, reward: 20 + 4 });
  // The most a lab can earn (150 of each service, a billion rack points, a kernel boost) stays far below MAX_SAFE_INTEGER a second.
  const huge = game({ owned: Object.fromEntries(SERVICES.map((id) => [id, 150])), points: 1e9, boost: 1 });
  assert.equal(upi.upiGrossRate(huge), grossModel(huge));
  assert.ok(upi.upiGrossRate(huge) < 3e13);
  t.mock.method(Math, 'random', () => {
    throw new Error('the model never calls Math.random');
  });
  upi.upiTick(huge, TICK);
});

test('uptime-idle: a tick adds a fixed step of the net income, never below 0 or past MAX_SAFE_INTEGER, and leaves its input alone', () => {
  const g = game({ owned: { dns: 10, backup: 3, minipc: 4 }, credits: 50, goal: { target: 1000, progress: 10, reward: 30 } });
  const copy = JSON.parse(JSON.stringify(g));
  const next = upi.upiTick(g, TICK);
  assert.deepEqual(g, copy, 'the input state is not changed');
  const gain = netModel(g) * 0.25;
  assert.ok(Math.abs(next.credits - (50 + gain)) < 1e-9);
  assert.ok(Math.abs(next.runEarned - gain) < 1e-9);
  assert.ok(Math.abs(next.goal.progress - (10 + gain)) < 1e-9);
  assert.equal(next.runMs, 250);
  assert.equal(next.downMs, 0);
  // 240 ticks are one minute of income.
  let m = g;
  for (let i = 0; i < 240; i++) m = upi.upiTick(m, TICK);
  assert.ok(Math.abs(m.credits - (50 + netModel(g) * 60)) < 1e-6);
  // A lab that costs more than it earns runs down to 0, not below, and earns nothing.  (Play never builds one: upiBuy
  // refuses the machine that would, and upiParseState repairs a damaged save that holds one; see the tests below.)
  const losing = game({ owned: { dns: 1, virt: 8 }, credits: 1 });
  assert.ok(netModel(losing) < 0);
  let l = losing;
  for (let i = 0; i < 40; i++) l = upi.upiTick(l, TICK);
  assert.equal(l.credits, 0);
  assert.equal(l.runEarned, 0);
  assert.equal(l.goal.progress, 0);
  // Credits stop at Number.MAX_SAFE_INTEGER.
  const rich = upi.upiTick(game({ owned: { build: 150 }, points: 1000, credits: MAX - 1, runEarned: MAX - 1 }), TICK);
  assert.equal(rich.credits, MAX);
  assert.equal(rich.runEarned, MAX);
  // Timed incidents and the boost run down; a failed disk waits and counts as downtime.
  const outage = upi.upiTick(game({ event: { type: 'outage', left: 300 }, boost: 100 }), TICK);
  assert.deepEqual([outage.event, outage.boost, outage.downMs, outage.credits], [{ type: 'outage', left: 50 }, 0, 250, 0]);
  assert.equal(upi.upiTick(outage, TICK).event, null, 'the power is back');
  const disk = upi.upiTick(game({ event: { type: 'disk', left: 0 } }), TICK);
  assert.deepEqual([disk.event, disk.downMs], [{ type: 'disk', left: 0 }, 250]);
  const kernel = upi.upiTick(game({ event: { type: 'kernel', left: 250 } }), TICK);
  assert.deepEqual([kernel.event, kernel.downMs], [null, 0], 'an unanswered kernel offer runs out');
  assert.equal(upi.upiUptime(game()), 1);
  assert.equal(upi.upiUptime(game({ runMs: 1000, downMs: 250 })), 0.75);
});

test('uptime-idle: a finished session goal pays its reward and sets the next one from the income: about 3 minutes of it', () => {
  const g = game({ owned: { dns: 20, backup: 10, minipc: 8 }, credits: 0, goal: { target: 10, progress: 9.9, reward: 77 }, goalsDone: 2 });
  const next = upi.upiTick(g, TICK);
  const net = netModel(g);
  assert.equal(next.goalsDone, 3);
  assert.ok(Math.abs(next.credits - (net * 0.25 + 77)) < 1e-9, 'the reward is paid');
  assert.ok(Math.abs(next.runEarned - (net * 0.25 + 77)) < 1e-9, 'and counts as earned');
  assert.deepEqual(next.goal, { target: upi.upiNiceCeil(net * 180), progress: 0, reward: Math.floor(net * 90) });
  // A poor lab still gets a goal of at least 60 cr and a reward of at least 20.
  assert.deepEqual(upi.upiNewGoal(game({ owned: { dns: 0 } })), { target: 60, progress: 0, reward: 20 });
  assert.deepEqual(upi.upiNewGoal(game({ owned: { dns: 1, virt: 8 } })), { target: 60, progress: 0, reward: 20 });
});

test('uptime-idle: offline progress counts the calm net income for at most 8 h; a clock set backwards or far forwards gives nothing negative or runaway', () => {
  const g = game({ owned: { dns: 30, backup: 10, minipc: 12 }, credits: 100, runMs: 5000, goal: { target: 500, progress: 5, reward: 50 } });
  const rate = netModel(g);
  for (const [elapsed, counted] of [[0, 0], [-5000, 0], [-30 * 86400000, 0], [NaN, 0], [Infinity, 0], [MINUTE, MINUTE], [2 * HOUR, 2 * HOUR],
    [CAP, CAP], [CAP + 1, CAP], [400 * 86400000, CAP], [1e300, CAP]]) {
    assert.equal(upi.upiOfflineCounted(elapsed), counted, String(elapsed));
    const gain = upi.upiOfflineGain(g, elapsed);
    assert.ok(Math.abs(gain - rate * counted / 1000) < 1e-6, String(elapsed));
    assert.ok(gain >= 0 && gain <= rate * CAP / 1000 + 1e-6);
    const back = upi.upiApplyOffline(g, elapsed);
    assert.ok(Math.abs(back.credits - (100 + gain)) < 1e-6);
    assert.equal(back.runMs, 5000 + counted);
    assert.deepEqual(back.goal, g.goal, 'offline time is not a session');
  }
  // An outage or a boost is over by the time you come back; a failed disk waits (and halves the income).
  for (const [extra, calm] of [
    [{ event: { type: 'outage', left: 20000 } }, netModel(g)],
    [{ event: { type: 'kernel', left: 20000 } }, netModel(g)],
    [{ boost: 30000 }, netModel(g)],
    [{ event: { type: 'disk', left: 0 } }, netModel(Object.assign({}, g, { event: { type: 'disk', left: 0 } }))]
  ]) {
    const s = Object.assign({}, g, extra);
    assert.ok(Math.abs(upi.upiCalmRate(s) - calm) < 1e-9, JSON.stringify(extra));
    assert.ok(Math.abs(upi.upiOfflineGain(s, HOUR) - calm * 3600) < 1e-6);
  }
  const outage = upi.upiApplyOffline(Object.assign({}, g, { event: { type: 'outage', left: 20000 }, boost: 50000 }), 10000);
  assert.deepEqual([outage.event, outage.boost], [{ type: 'outage', left: 10000 }, 40000]);
  const over = upi.upiApplyOffline(Object.assign({}, g, { event: { type: 'kernel', left: 20000 }, boost: 50000 }), HOUR);
  assert.deepEqual([over.event, over.boost], [null, 0]);
  const disk = upi.upiApplyOffline(Object.assign({}, g, { event: { type: 'disk', left: 0 } }), HOUR);
  assert.deepEqual([disk.event, disk.downMs], [{ type: 'disk', left: 0 }, HOUR]);
  // A lab that loses money earns nothing offline (and loses nothing).
  const losing = game({ owned: { dns: 1, virt: 8 }, credits: 40 });
  assert.equal(upi.upiOfflineGain(losing, HOUR), 0);
  assert.equal(upi.upiApplyOffline(losing, HOUR).credits, 40);
  // Never past Number.MAX_SAFE_INTEGER.
  const rich = game({ owned: { build: 150 }, points: 1e6, credits: MAX - 10 });
  assert.equal(upi.upiOfflineGain(rich, CAP), 10);
  assert.equal(upi.upiApplyOffline(rich, CAP).credits, MAX);
});

test('uptime-idle: the welcome-back line names the time away, the time counted and the 8 h cap', () => {
  assert.equal(upi.upiWelcomeText(59999, 5), '');
  assert.equal(upi.upiWelcomeText(-59999, 0), '');
  assert.equal(upi.upiWelcomeText(NaN, 0), '');
  assert.equal(upi.upiWelcomeText(2 * HOUR + 13 * MINUTE, 4567), 'While you were away: 2h 13m (all of it counted, the cap is 8h 00m): +4.5k cr.');
  assert.equal(upi.upiWelcomeText(3 * 86400000 + 4 * HOUR, 1.2e6), 'While you were away: 3d 04h (8h 00m counted, the cap is 8h 00m): +1.2M cr.');
  assert.equal(upi.upiWelcomeText(-(2 * HOUR + 5 * MINUTE), 0),
    'The clock is 2h 05m behind the last save: no time is counted until it catches up (offline progress counts up to 8h 00m).');
  assert.match(upi.upiWelcomeText(-MINUTE, 0), /^The clock is 1m 00s behind/);
});

test('uptime-idle: incidents come only from the PRNG passed in, after the first minute and one at a time; RAID and a UPS absorb theirs', () => {
  const draws = (values) => {
    const list = values.slice();
    return () => {
      assert.ok(list.length, 'no more draws than planned');
      return list.shift();
    };
  };
  const g = game({ runMs: MINUTE });
  assert.equal(upi.upiApplyEvent(game({ runMs: MINUTE - 1 }), draws([])), null, 'no roll in the first minute of a run');
  assert.equal(upi.upiApplyEvent(Object.assign({}, g, { event: { type: 'disk', left: 0 } }), draws([])), null, 'no roll during an incident');
  assert.equal(upi.upiApplyEvent(g, draws([EVENT_CHANCE])), null);
  for (const [roll, kind, event] of [
    [0, 'disk', { type: 'disk', left: 0 }], [0.399, 'disk', { type: 'disk', left: 0 }],
    [0.4, 'outage', { type: 'outage', left: 30000 }], [0.699, 'outage', { type: 'outage', left: 30000 }],
    [0.7, 'kernel', { type: 'kernel', left: 60000 }], [0.999, 'kernel', { type: 'kernel', left: 60000 }]
  ]) {
    const result = upi.upiApplyEvent(g, draws([EVENT_CHANCE - 1e-9, roll]));
    assert.equal(result.kind, kind);
    assert.deepEqual(result.state.event, event);
    assert.equal(result.state.incidents, 1);
    assert.equal(g.event, null, 'the input state is not changed');
  }
  const safe = game({ runMs: MINUTE, owned: { nas: 1, raid: 1, ups: 1 } });
  for (const [roll, kind] of [[0.1, 'disk-raid'], [0.5, 'outage-ups'], [0.9, 'kernel']]) {
    const result = upi.upiApplyEvent(safe, draws([0, roll]));
    assert.equal(result.kind, kind);
    assert.equal(result.state.event === null, kind !== 'kernel');
    assert.equal(result.state.incidents, 1);
  }
  // One roll a tick at 1/360: an incident every 90 s of play on average (360000 rolls are 25 hours: about 1000).
  const rnd = upi.upiMulberry32(2026);
  let count = 0;
  for (let i = 0; i < 360000; i++) if (upi.upiApplyEvent(g, rnd)) count++;
  assert.ok(count > 900 && count < 1100, count + ' incidents in 360000 rolls');
});

test('uptime-idle: Replace disk and Reboot resolve their incidents; an outage has no action', () => {
  const disk = upi.upiResolve(game({ event: { type: 'disk', left: 0 } }));
  assert.deepEqual([disk.event, disk.boost], [null, 0]);
  const kernel = upi.upiResolve(game({ event: { type: 'kernel', left: 1000 } }));
  assert.deepEqual([kernel.event, kernel.boost], [null, 60000]);
  assert.equal(upi.upiResolve(game({ event: { type: 'outage', left: 1000 } })), null);
  assert.equal(upi.upiResolve(game()), null);
});

test('uptime-idle: buying takes the price and adds the item; a refusal names the values that stop it', () => {
  const g = game({ credits: 1000, owned: { dns: 1 } });
  const result = upi.upiBuy(g, 'minipc');
  assert.deepEqual([result.ok, result.cost, result.reason], [true, 100, '']);
  assert.equal(result.state.credits, 900);
  assert.equal(result.state.owned.minipc, 1);
  assert.equal(g.owned.minipc, 0, 'the input state is not changed');
  const refuse = (state, id) => {
    const r = upi.upiBuy(state, id);
    assert.equal(r.ok, false);
    assert.equal(r.state, state);
    return r.reason;
  };
  assert.equal(refuse(g, 'laptop'), 'There is no item called laptop in the shop.');
  assert.equal(refuse(game({ credits: 1e9, owned: { dns: 2 } }), 'backup'), 'No free slot for a Backup server: 2/2 slots used. Buy hardware first.');
  assert.equal(refuse(game({ credits: 1e9, owned: { dns: 10, minipc: 8 } }), 'nas'),
    'No room for a NAS: 8/8 places used (the desk holds 8, each rack 16). Buy a Server rack first.');
  assert.equal(upi.upiBuy(game({ credits: 1e9, owned: { dns: 10, minipc: 8 } }), 'rack').ok, true, 'a rack needs no place');
  assert.equal(refuse(game({ credits: 1e9 }), 'raid'), 'RAID mirror needs a NAS: you own 0.');
  assert.equal(refuse(game({ credits: 1e9, owned: { nas: 1, raid: 1 } }), 'raid'), 'RAID mirror is already installed.');
  assert.equal(refuse(game({ credits: 1e9, owned: { cooling: 3 } }), 'cooling'), 'Cooling is already installed at its last level (3/3).');
  assert.equal(refuse(game({ credits: MAX, owned: { minipc: 150 } }), 'minipc'), 'Mini PC is sold out: 150 of 150 owned.');
  assert.equal(refuse(game({ credits: 96.4 }), 'minipc'), 'Mini PC costs 100 cr; you have 96.4 cr (4 cr short, about 14s at 0.27 cr/s).');
  assert.equal(refuse(game({ credits: 3, owned: { dns: 1, virt: 1 } }), 'dns'), 'DNS filter costs 7 cr; you have 3 cr (4 cr short, and the net income is -1.6 cr/s).');
  // The next level of an upgrade.
  const cooled = upi.upiBuy(game({ credits: 20800, owned: { cooling: 1 } }), 'cooling');
  assert.deepEqual([cooled.ok, cooled.cost, cooled.state.owned.cooling, cooled.state.credits], [true, 20000, 2, 800]);
});

// The steady net income (no incident, no boost) of a model lab with owned.
const steadyModel = (g, owned) => netModel(Object.assign({}, g, { event: null, boost: 0, owned: owned || g.owned }));

test('uptime-idle: a machine that would bring the net income to 0 or below is refused, naming the values, so no purchase can lock the lab', () => {
  const refuse = (state, id) => {
    const r = upi.upiBuy(state, id);
    assert.equal(r.ok, false);
    return r.reason;
  };
  // The natural route: one DNS filter and mini PCs.  Two still earn, the third would not; saving up for it would never end.
  let g = game({ credits: 878 });
  for (let i = 0; i < 2; i++) g = upi.upiBuy(g, 'minipc').state;
  assert.ok(Math.abs(netModel(g) - 0.084) < 1e-9);
  const text = 'A Mini PC would bring the net income to -0.01 cr/s (income 0.5, power bill 0.51 cr/s without incidents): buy a service first.';
  assert.equal(refuse(g, 'minipc'), text);
  assert.equal(refuse(game({ credits: 0, owned: { minipc: 2 } }), 'minipc'), text, 'named before the price');
  // The rule looks at the lab without incidents: a failed disk, an outage or a boost changes nothing.
  for (const extra of [{ event: { type: 'disk', left: 0 } }, { event: { type: 'outage', left: 5000 } }, { boost: 30000 }]) {
    assert.equal(refuse(Object.assign({}, g, extra), 'minipc'), text, JSON.stringify(extra));
  }
  const disk = game({ credits: 1000, owned: { minipc: 1 }, event: { type: 'disk', left: 0 } });
  assert.ok(netModel(upi.upiBuy(disk, 'minipc').state) < 0, 'with the disk failed it loses money for now');
  assert.equal(upi.upiBuy(disk, 'minipc').ok, true, 'but a new disk makes it earn again');
  // A service always earns more than its power, so it is never refused for it; after one the mini PC is fine again.
  g = upi.upiBuy(g, 'dns').state;
  assert.equal(upi.upiBuy(g, 'minipc').ok, true);
  assert.match(refuse(game({ credits: 1e5, owned: { dns: 2, minipc: 3 } }), 'rack'), /^A Server rack would bring the net income to -0\.\d+ cr\/s/);
  assert.match(refuse(game({ credits: 1e5, owned: { dns: 2 } }), 'virt'), /^A Virtualization node would bring/);
  assert.match(refuse(game({ credits: 1e5, owned: { dns: 1 } }), 'nas'), /^A NAS would bring the net income to -0\.04 cr\/s/);
  // Against a model: in random labs that earn, packed with machines up to the edge, a machine is refused for its power
  // exactly when the steady net income after it is 0 or below.
  const random = seeded(17);
  const MACHINES = ['minipc', 'nas', 'virt', 'rack'];
  let refused = 0;
  let allowed = 0;
  for (let i = 0; i < 400; i++) {
    const owned = {};
    for (const id of IDS) owned[id] = TABLE[id].levels ? Math.floor(random() * (TABLE[id].levels.length + 1)) : (TABLE[id].kind === 'service' ? Math.floor(random() ** 3 * 4) : 0);
    owned.dns = Math.max(1, owned.dns);
    const lab = game({ owned, credits: 1e12, points: Math.floor(random() * 20) });
    for (let k = 0; k < 3000; k++) {
      const id = MACHINES[Math.floor(random() * 4)];
      if (lab.owned[id] >= 149) continue;
      const more =Object.assign({}, lab.owned, { [id]: lab.owned[id] + 1 });
      if (steadyModel(lab, more) <= 0) break;
      lab.owned = more;
    }
    assert.ok(steadyModel(lab) > 0);
    for (const id of MACHINES) {
      const after = steadyModel(lab, Object.assign({}, lab.owned, { [id]: lab.owned[id] + 1 }));
      const roomless = TABLE[id].slots && placesModel(lab.owned).used >= placesModel(lab.owned).total;
      const reason = upi.upiBuy(lab, id).reason;
      assert.equal(/ would bring the net income to /.test(reason), !roomless && after <= 0, id + ' in ' + JSON.stringify(lab.owned) + ': ' + reason);
      if (!roomless && after <= 0) refused++;
      else allowed++;
    }
  }
  assert.ok(refused > 300 && allowed > 300, refused + ' refusals and ' + allowed + ' others checked');
  // A player who buys whatever the shop lets them, at random, never ends up with a lab that cannot earn.
  let p = upi.upiFreshGame(3, 0);
  p.credits = 1e15;
  for (let i = 0; i < 3000; i++) {
    const result = upi.upiBuy(p, IDS[Math.floor(random() * IDS.length)]);
    if (result.ok) p = result.state;
    assert.ok(steadyModel(p) > 0, 'step ' + i + ': ' + JSON.stringify(p.owned));
  }
});

test('uptime-idle: a damaged save whose lab cannot earn is repaired: its DNS filter comes back, then machines power off, most watts first, until it earns', () => {
  const parse = (owned, extra) => upi.upiParseState(JSON.stringify(saveOf(Object.assign({ owned }, extra))), 1).game;
  assert.deepEqual(parse({ dns: 1, virt: 8 }).owned, ownedOf(), 'the reviewer\'s lab: 1 DNS filter and 8 virtualization nodes');
  assert.deepEqual(parse({ dns: 1, minipc: 6 }).owned, ownedOf({ minipc: 2 }));
  assert.deepEqual(parse({ dns: 30, virt: 8 }).owned, ownedOf({ dns: 30, virt: 6 }));
  assert.deepEqual(parse({ dns: 0, minipc: 3 }).owned, ownedOf({ minipc: 2 }), 'no service at all: the DNS filter first');
  assert.deepEqual(parse({ dns: 0 }).owned, ownedOf());
  assert.deepEqual(parse({ dns: 1, virt: 2, rack: 3, nas: 2, minipc: 5, raid: 1, cooling: 1 }).owned, ownedOf({ minipc: 3, raid: 1, cooling: 1 }));
  // The goal of a repaired lab is sized from what it earns after the repair.
  const fixed = parse({ dns: 30, virt: 8 }, { goal: null });
  assert.deepEqual(fixed.goal, upi.upiNewGoal(fixed));
  // A lab that earns is left as it is, also with a failed disk that makes it lose money for now.
  assert.deepEqual(upi.upiParseState(SAMPLE_SAVE, 1).game.owned, JSON.parse(SAMPLE_SAVE).owned);
  const disk = parse({ minipc: 1, dns: 1 }, { event: { type: 'disk', left: 0 } });
  assert.deepEqual(disk.owned, ownedOf({ minipc: 1 }));
  assert.ok(netModel(disk) < 0 && steadyModel(disk) > 0);
  // Against a model, in random damaged labs: services and upgrades stay (a missing service gets the DNS filter), the lab
  // earns, and only as many machines as needed went, most watts first (putting the last one back loses money again).
  const random = seeded(23);
  const ORDER = ['virt', 'rack', 'nas', 'minipc'];
  let repaired = 0;
  for (let i = 0; i < 400; i++) {
    const owned = {};
    for (const id of IDS) owned[id] = TABLE[id].levels ? Math.floor(random() * (TABLE[id].levels.length + 1)) : Math.floor(random() ** (TABLE[id].kind === 'service' ? 4 : 1) * (TABLE[id].kind === 'service' ? 3 : 30));
    const before = game({ owned, points: Math.floor(random() * 5) });
    const after = upi.upiParseState(JSON.stringify(saveOf({ owned, points: before.points })), 1).game;
    assert.ok(steadyModel(after) > 0, JSON.stringify(owned));
    if (steadyModel(before) > 0) {
      assert.deepEqual(after.owned, before.owned);
      continue;
    }
    repaired++;
    const noService = SERVICES.every((id) => owned[id] === 0);
    for (const id of IDS) {
      if (ORDER.includes(id)) assert.ok(after.owned[id] <= owned[id], id);
      else assert.equal(after.owned[id], id === 'dns' && noService ? 1 : owned[id], id);
    }
    const last = ORDER.filter((id) => after.owned[id] < owned[id]).pop();
    if (last) {
      assert.ok(ORDER.slice(0, ORDER.indexOf(last)).every((id) => after.owned[id] === 0), 'most watts first: ' + JSON.stringify(after.owned));
      assert.ok(steadyModel(after, Object.assign({}, after.owned, { [last]: after.owned[last] + 1 })) <= 0, 'no machine more than needed');
    }
  }
  assert.ok(repaired > 100, repaired + ' labs repaired');
});

test('uptime-idle: migrating needs a server rack and 300.0M cr earned in the run; the run\'s earnings become rack points for good', () => {
  assert.equal(upi.upiPrestige(game()).reason, 'Migrating needs a Server rack (you own 0) and 300.0M cr earned in this run (0 so far).');
  assert.equal(upi.upiPrestige(game({ owned: { rack: 1 }, runEarned: 2.5e8 })).reason, 'Migrating needs 300.0M cr earned in this run (250.0M so far).');
  assert.equal(upi.upiPrestige(game({ runEarned: 4e8 })).reason, 'Migrating needs a Server rack (you own 0).');
  for (const [earned, points] of [[2.99e8, 0], [3e8, 10], [4.32e8, 12], [1.2e9, 20], [MAX, 54794]]) {
    assert.equal(upi.upiPrestigePoints(game({ runEarned: earned })), points, String(earned));
  }
  const ready = game({ owned: { rack: 2, build: 40, dns: 100 }, runEarned: 6.75e8, points: 7, credits: 1e8, goalsDone: 30, incidents: 12, seed: 42 });
  const result = upi.upiPrestige(ready);
  assert.deepEqual([result.ok, result.gained, result.reason], [true, 15, '']);
  assert.deepEqual(result.state, Object.assign(upi.upiFreshGame(42, 22), { seed: 42 }));
  assert.equal(result.state.points, 22);
  assert.equal(upi.upiMultiplier(result.state), 1.44);
  assert.equal(upi.upiPrestige(game({ owned: { rack: 1 }, runEarned: MAX, points: 1e9 })).state.points, 1e9, 'points stop at 1e9');
});

// ── Pacing, pinned by simulation ────────────────────────────────────────────

test('uptime-idle: pacing: the first purchase within 30 s, the first rack within about 20 minutes, a migration within about 2 hours', () => {
  for (const seed of [1, 2, 3]) {
    const { marks, goals, g, shares } = play(seed, 150);
    assert.ok(marks.first <= 30 * SECOND, seed + ': first purchase at ' + marks.first / 1000 + ' s');
    assert.ok(marks.rack >= 8 * MINUTE && marks.rack <= 20 * MINUTE, seed + ': first rack at ' + marks.rack / MINUTE + ' min');
    assert.ok(marks.migrate >= 90 * MINUTE && marks.migrate <= 150 * MINUTE, seed + ': migration ready at ' + marks.migrate / MINUTE + ' min');
    // Every session goal of the first two hours takes 5 minutes or less, most of them 3 or less.
    const early = goals.slice(0, goals.findIndex((x, i) => goals.slice(0, i + 1).reduce((a, b) => a + b, 0) > 120 * MINUTE));
    assert.ok(early.length >= 30, seed + ': ' + early.length + ' goals');
    assert.ok(early.every((ms) => ms <= 5 * MINUTE), seed + ': ' + Math.max(...early) / 1000 + ' s');
    assert.ok(early.filter((ms) => ms <= 3 * MINUTE).length >= early.length * 0.6, seed);
    assert.ok(g.credits <= MAX && Number.isFinite(g.credits));
    // The power bill is a real share of the income at every stage: checked once a minute, from about a third of the
    // income at the start (the laptop's own watts) down to an eighth once the cooling is done; it never vanishes or dominates.
    assert.equal(shares.length, 150);
    shares.forEach((share, minute) => assert.ok(share > 0.1 && share < 0.4, seed + ': power ' + share + ' at minute ' + (minute + 1)));
    assert.ok(shares[0] > 0.3 && shares[149] < 0.15, seed + ': the cooling upgrades lower the share');
    assert.ok(upi.upiPowerRate(g) / upi.upiGrossRate(g) > 0.1);
  }
  // A player who looks every 10 s and answers incidents after 20 s keeps the same pace.
  const slow = play(4, 150, { every: 10, react: 20000 });
  slow.shares.forEach((share, minute) => assert.ok(share > 0.1 && share < 0.4, 'slow player: power ' + share + ' at minute ' + (minute + 1)));
  assert.ok(slow.marks.first <= 30 * SECOND);
  assert.ok(slow.marks.rack <= 20 * MINUTE, 'slow player: rack at ' + slow.marks.rack / MINUTE);
  assert.ok(slow.marks.migrate <= 150 * MINUTE, 'slow player: migration at ' + slow.marks.migrate / MINUTE);
  // A second run with the rack points of the first one is faster.
  const second = play(1, 60, { points: 13 });
  const first = play(1, 60);
  assert.ok(second.g.runEarned > first.g.runEarned * 1.2);
});

test('uptime-idle: an idle player gets the first goal done in under 5 minutes and never overflows Number.MAX_SAFE_INTEGER', () => {
  const idle = play(5, 10, { buy: false });
  assert.ok(idle.goals[0] <= 5 * MINUTE, 'first goal after ' + idle.goals[0] / 1000 + ' s');
  // Ten years of coming back every 8 hours (and more) to a lab nobody touches.
  let g = upi.upiFreshGame(5, 0);
  for (let i = 0; i < 3 * 365 * 10; i++) g = upi.upiApplyOffline(g, i % 2 ? CAP : 400 * 86400000);
  assert.ok(Math.abs(g.credits - 0.276 * 8 * 3600 * 3 * 365 * 10) < 1, 'idle: ' + g.credits);
  assert.equal(g.runMs, CAP * 3 * 365 * 10);
  // A lab with everything sold out and a billion rack points stops at MAX_SAFE_INTEGER, and so does everything it counts.
  const owned = Object.fromEntries(IDS.map((id) => [id, TABLE[id].levels ? TABLE[id].levels.length : 150]));
  let full = game({ owned, points: 1e9 });
  for (let i = 0; i < 40; i++) {
    full = upi.upiApplyOffline(full, CAP);
    full = upi.upiTick(full, TICK);
  }
  for (const key of ['credits', 'runEarned']) assert.equal(full[key], MAX, key);
  assert.ok(Number.isSafeInteger(full.runMs));
  assert.ok(full.goal.target <= MAX * 1.01 && Number.isFinite(full.goal.target));
});

// ── Saves ────────────────────────────────────────────────────────────────────

test('uptime-idle: upiParseState reads a save of the current format field for field, and upiSerializeState writes it back byte for byte', () => {
  const parsed = upi.upiParseState(SAMPLE_SAVE, 1);
  const raw = JSON.parse(SAMPLE_SAVE);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.savedAt, NOW);
  assert.deepEqual(parsed.game, {
    credits: 1234.5, owned: raw.owned, event: null, boost: 0, points: 0, runEarned: 5678.25, runMs: 754000, downMs: 15000,
    incidents: 3, goal: raw.goal, goalsDone: 4, seed: 123456789
  });
  assert.equal(upi.upiSerializeState(parsed.game, NOW), SAMPLE_SAVE);
  const withEvent = saveOf({ event: { type: 'outage', left: 12000 }, boost: 3000, points: 5 });
  assert.deepEqual(upi.upiParseState(JSON.stringify(withEvent), 1).game.event, { type: 'outage', left: 12000 });
  assert.equal(upi.upiSerializeState(upi.upiParseState(JSON.stringify(withEvent), 1).game, NOW), JSON.stringify(withEvent));
});

test('uptime-idle: upiParseState falls back field by field: a damaged field never takes the others with it', () => {
  const good = JSON.parse(SAMPLE_SAVE);
  const fresh = upi.upiParseState(SAMPLE_SAVE, 1).game;
  const cases = [
    ['credits', 'lots', { credits: 0 }], ['credits', -5, { credits: 0 }], ['credits', 1e300, { credits: MAX }], ['credits', null, { credits: 0 }],
    ['boost', 60001, { boost: 0 }], ['boost', -1, { boost: 0 }], ['boost', 1234, { boost: 1234 }],
    ['points', 1.5, { points: 0 }], ['points', 2e9, { points: 0 }], ['points', 12, { points: 12 }],
    ['runEarned', 'x', { runEarned: 0 }], ['runMs', -1, { runMs: 0, downMs: 0 }], ['downMs', 1e9, { downMs: 754000 }], ['downMs', 'x', { downMs: 0 }],
    ['incidents', -2, { incidents: 0 }], ['goalsDone', 'x', { goalsDone: 0 }],
    ['seed', -1, { seed: 77 }], ['seed', 4294967296, { seed: 77 }], ['seed', 1.5, { seed: 77 }], ['seed', 4294967295, { seed: 4294967295 }],
    ['event', { type: 'disk', left: 0 }, { event: { type: 'disk', left: 0 } }], ['event', { type: 'disk', left: 5 }, { event: null }],
    ['event', { type: 'outage', left: 0 }, { event: null }], ['event', { type: 'outage', left: 30001 }, { event: null }],
    ['event', { type: 'kernel', left: 59000 }, { event: { type: 'kernel', left: 59000 } }], ['event', { type: 'fire', left: 5 }, { event: null }],
    ['event', { type: 'kernel', left: 'x' }, { event: null }], ['event', [1], { event: null }], ['event', 'disk', { event: null }],
    ['goal', { target: 500, progress: 600, reward: 9 }, { goal: { target: 500, progress: 500, reward: 9 } }],
    ['goal', { target: 500, progress: -1, reward: 'x' }, { goal: { target: 500, progress: 0, reward: 20 } }],
    ['goal', { target: 500 }, { goal: { target: 500, progress: 0, reward: 20 } }]
  ];
  for (const [field, value, expected] of cases) {
    const data = Object.assign({}, good, { [field]: value });
    const parsed = upi.upiParseState(JSON.stringify(data), 77);
    assert.equal(parsed.ok, true, field);
    assert.deepEqual(parsed.game, Object.assign({}, fresh, expected), field + ' = ' + JSON.stringify(value));
  }
  // A goal that cannot be read is replaced by a new one sized from the lab.
  for (const value of [null, { target: 0, progress: 0, reward: 1 }, { target: 'x' }, { target: 1e300 }, []]) {
    const parsed = upi.upiParseState(JSON.stringify(Object.assign({}, good, { goal: value })), 77);
    assert.deepEqual(parsed.game.goal, upi.upiNewGoal(parsed.game), JSON.stringify(value));
  }
  // Each count on its own; a missing or broken one falls back to the start (one DNS filter, nothing else).
  for (const id of IDS) {
    for (const value of [-1, 1.5, 'x', null, TABLE[id].levels ? TABLE[id].levels.length + 1 : 151]) {
      const owned = Object.assign({}, good.owned, { [id]: value });
      const parsed = upi.upiParseState(JSON.stringify(Object.assign({}, good, { owned })), 77);
      assert.deepEqual(parsed.game.owned, Object.assign({}, good.owned, { [id]: id === 'dns' ? 1 : 0 }), id + ' = ' + value);
    }
  }
  assert.deepEqual(upi.upiParseState(JSON.stringify(Object.assign({}, good, { owned: [3] })), 77).game.owned, ownedOf());
  // savedAt: a count of ms, else no offline time at all.
  for (const value of [-1, 'x', 1.5, null]) assert.equal(upi.upiParseState(JSON.stringify(Object.assign({}, good, { savedAt: value })), 77).savedAt, null);
});

test('uptime-idle: a text that holds no save at all parses as a fresh lab with the fallback seed', () => {
  for (const text of [null, '', '{', 'null', '[]', '"save"', '42', 'true', '[{"credits":5}]']) {
    const parsed = upi.upiParseState(text, 99);
    assert.equal(parsed.ok, false, String(text));
    assert.equal(parsed.savedAt, null);
    assert.deepEqual(parsed.game, upi.upiFreshGame(99, 0), String(text));
  }
  assert.equal(upi.upiParseState('{}', 99).ok, true, 'an empty object is a save whose every field falls back');
  assert.deepEqual(upi.upiParseState('{}', 99).game, upi.upiFreshGame(99, 0));
});

test('uptime-idle: upi-stats keeps the lifetime earnings and migrations field by field, and two tabs merge to the higher values', () => {
  assert.deepEqual(upi.upiParseStats(SAMPLE_STATS), { totalEarned: 98765.5, prestiges: 2 });
  assert.deepEqual(upi.upiParseStats('{"totalEarned":-1,"prestiges":3}'), { totalEarned: 0, prestiges: 3 });
  assert.deepEqual(upi.upiParseStats('{"totalEarned":12,"prestiges":1.5}'), { totalEarned: 12, prestiges: 0 });
  assert.deepEqual(upi.upiParseStats('{"totalEarned":1e300}'), { totalEarned: MAX, prestiges: 0 });
  for (const text of [null, '{', '[]', '7']) assert.deepEqual(upi.upiParseStats(text), { totalEarned: 0, prestiges: 0 });
  assert.deepEqual(upi.upiMergeStats({ totalEarned: 5, prestiges: 3 }, { totalEarned: 9, prestiges: 1 }), { totalEarned: 9, prestiges: 3 });
});

test('uptime-idle: keys 1-9 map to the nine services and hardware items by value, or by the physical key without Shift', () => {
  for (let d = 1; d <= 9; d++) assert.equal(upi.upiKeySlot({ key: String(d), code: 'Digit' + d }), d - 1);
  assert.equal(upi.upiKeySlot({ key: '&', code: 'Digit1', shiftKey: false }), 0, 'AZERTY top row');
  assert.equal(upi.upiKeySlot({ key: '!', code: 'Digit1', shiftKey: true }), -1, 'Shift+1 is !');
  for (const event of [{ key: '0', code: 'Digit0' }, { key: 'a', code: 'KeyA' }, { key: 'End', code: 'Numpad1' }, { key: undefined, code: undefined }, {}]) {
    assert.equal(upi.upiKeySlot(event), -1, JSON.stringify(event));
  }
  assert.equal(upi.upiKeySlot({ key: '7', code: 'Numpad7' }), 6, 'the keypad with Num Lock on');
});

// ── The page ─────────────────────────────────────────────────────────────────

test('uptime-idle: loading the script under Node runs no init: no lookup, listener, timer or save', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.upiInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['upi-services'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('uptime-idle: a first visit boots the old laptop, shows the lab and its shop, saves both keys and ticks every 250 ms', (t) => {
  const { clock, v } = openPage(t);
  const seed = Math.floor(seeded(1)() * 4294967296);
  assert.deepEqual(storedKeys(), [STATE_KEY, STATS_KEY]);
  assert.deepEqual(v.state(), saveOf({ seed, goal: { target: 60, progress: 0, reward: 24 } }));
  assert.deepEqual(v.stats(), { v: 1, totalEarned: 0, prestiges: 0 });
  assert.equal(v.text('credits'), '0 cr');
  assert.equal(v.text('net'), '+0.27 cr/s');
  assert.equal(v.text('power'), '35 W');
  assert.equal(v.text('uptime'), '100%');
  assert.equal(v.text('slots'), '1/2');
  assert.equal(v.text('places'), '0/8');
  assert.equal(v.text('mult'), '×1.00');
  assert.equal(v.text('breakdown'), 'Income 0.5 cr/s, power bill 0.22 cr/s: 35 W × PUE 1.6 × 4 cr per kWh, each second of play billed as one hour.');
  assert.equal(v.text('goal-text'), 'Earn 60 cr');
  assert.equal(v.text('goal-reward'), 'Reward +24 cr');
  assert.equal(v.text('goal-progress'), '0 / 60 cr · 0%');
  assert.equal(v.text('incident-text'), 'All systems nominal. Incidents: 0.');
  assert.equal(v.hidden('incident-action'), true);
  assert.equal(v.text('migrate-text'), 'Migrating needs a Server rack (you own 0) and 300.0M cr earned in this run (0 so far). Rack points now: 0 (×1.00 income).');
  assert.equal(v.text('migrate'), 'Migrate to a new rack');
  assert.equal(v.text('lifetime'), 'Lifetime: 0 cr earned, 0 migrations.');
  assert.deepEqual(v.log(), ['[0:00:00] Old laptop booted under the desk: DNS filter running.']);
  assert.equal(v.hidden('welcome'), true);
  assert.equal(v.hidden('warning'), true);
  assert.equal(v.toast(), null);
  // The shop: services, hardware and upgrades, each a button with its key, name, count, effect and price.
  assert.deepEqual(v.el('services').children.map((b) => b.id), SERVICES.map((id) => 'upi-item-' + id));
  assert.deepEqual(v.el('hardware').children.map((b) => b.id), ['upi-item-minipc', 'upi-item-nas', 'upi-item-virt', 'upi-item-rack']);
  assert.deepEqual(v.el('upgrades').children.map((b) => b.id), ['upi-item-raid', 'upi-item-ups', 'upi-item-cooling']);
  const dns = v.item('dns');
  assert.equal(dns.tagName, 'BUTTON');
  assert.equal(dns.type, 'button');
  assert.equal(dns.getAttribute('data-item'), 'dns');
  assert.deepEqual(dns.children[0].children.map((s) => [s.className, s.textContent]),
    [['upi-item-key', '1'], ['upi-item-name', 'DNS filter'], ['upi-item-owned', '×1']]);
  assert.deepEqual(dns.children.slice(1).map((s) => [s.className, s.textContent]),
    [['upi-item-effect', '+0.5 cr/s · 1 slot · 15 W'], ['upi-item-cost', '7 cr']]);
  assert.equal(dns.getAttribute('aria-label'), 'Key 1: DNS filter, buy for 7 cr; you own 1; +0.5 cr/s · 1 slot · 15 W');
  assert.equal(dns.className, 'upi-item upi-item--short');
  const labels = IDS.map((id) => v.item(id).getAttribute('aria-label'));
  assert.deepEqual(labels.slice(5), [
    'Key 6: Mini PC, buy for 100 cr; you own 0; +3 slots · 1 place · 15 W',
    'Key 7: NAS, buy for 1.5k cr; you own 0; +4 slots · 1 place · 50 W',
    'Key 8: Virtualization node, buy for 20.0k cr; you own 0; +10 slots · 1 place · 300 W',
    'Key 9: Server rack, buy for 20.0k cr; you own 0; +16 places · 100 W',
    'RAID mirror, buy for 1.5k cr; not installed; A failed disk costs nothing',
    'UPS, buy for 4.0k cr; not installed; An outage costs nothing',
    'Cooling, buy for 800 cr; level 0 of 3; PUE 1.6 → 1.4'
  ]);
  assert.equal(v.item('photos').children[1].textContent, '+50 cr/s · 1 slot · 1.5 kW');
  assert.equal(v.item('raid').className, 'upi-item upi-item--blocked', 'RAID waits for a NAS');
  assert.equal(v.item('raid').children[0].children.length, 2, 'no key badge past 9');
  // Listeners: one each, keys only on the game, storage on window.
  for (const [name, type] of [['root', 'keydown'], ['services', 'click'], ['hardware', 'click'], ['upgrades', 'click'], ['incident-action', 'click'], ['migrate', 'click']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(document), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(document.body), 0);
  assert.equal(listenerCount(window), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  // Ticks every 250 ms; saves every 5 s, not every tick.
  const writes = t.mock.method(localStorage, 'setItem');
  clock.advance(250);
  assert.equal(v.text('goal-progress'), '0.06 / 60 cr · 0%');
  clock.advance(4500);
  assert.equal(writes.mock.callCount(), 0, 'no save in the first 19 ticks');
  clock.advance(250);
  assert.deepEqual(writes.mock.calls.map((c) => c.arguments[0]), [STATE_KEY, STATS_KEY]);
  assert.equal(v.state().runMs, 5000);
  assert.ok(Math.abs(v.state().credits - 0.276 * 5) < 1e-9);
  assert.equal(v.text('goal-progress'), '1.3 / 60 cr · 2%');
  assert.equal(v.el('goal-fill').style.width, '2%');
  assert.equal(v.el('goal-bar').getAttribute('aria-valuenow'), '2');
  clock.advance(5000);
  assert.equal(writes.mock.callCount(), 4);
});

test('uptime-idle: while the page is still loading the game waits for DOMContentLoaded', (t) => {
  const { v } = openPage(t, { state: SAMPLE_SAVE, options: { readyState: 'loading' } });
  assert.equal(v.el('services').children.length, 0);
  assert.equal(v.text('breakdown'), 'Booting the laptop...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(v.root, 'keydown'), 0);
  v.ready();
  assert.equal(v.el('services').children.length, 5);
  assert.equal(v.text('credits'), '1.2k cr');
  assert.equal(listenerCount(v.root, 'keydown'), 1);
});

test('uptime-idle: init runs once: a second call binds nothing twice and starts no second clock', (t) => {
  makeClock(t);
  t.mock.method(Math, 'random', seeded(1));
  const { exports: fresh, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  fresh.upiInit();
  const saved = localStorage.getItem(STATE_KEY);
  const interval = fresh.upiRuntime.interval;
  fresh.upiInit();
  assert.equal(localStorage.getItem(STATE_KEY), saved);
  assert.equal(fresh.upiRuntime.interval, interval);
  assert.equal(els['upi-services'].children.length, 5);
  assert.equal(listenerCount(els['upi-root'], 'keydown'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(fresh.upiState.game.owned.dns, 1);
  setVisibility('hidden', t);
  assert.equal(fresh.upiRuntime.interval, null);
});

test('uptime-idle: a tap buys through the shop\'s listener, saves at once and logs it; a refusal names its values in a toast', (t) => {
  const { clock, v } = openPage(t);
  clock.advance(25 * SECOND);
  assert.equal(v.item('dns').className, 'upi-item upi-item--short', '6.9 cr of 7');
  clock.advance(1 * SECOND);
  assert.equal(v.item('dns').className, 'upi-item', 'affordable');
  v.buy('dns');
  assert.equal(v.state().owned.dns, 2, 'saved at once');
  assert.equal(v.text('slots'), '2/2');
  assert.equal(v.item('dns').children[0].children[2].textContent, '×2');
  assert.equal(v.item('dns').children[2].textContent, '8 cr', 'the third costs 6 x 1.15^2, rounded up');
  assert.equal(v.log()[1], '[0:00:26] Bought DNS filter #2 for 7 cr.');
  assert.equal(v.item('backup').className, 'upi-item upi-item--blocked', 'no free slot');
  v.buy('backup');
  assert.equal(v.toast(), 'No free slot for a Backup server: 2/2 slots used. Buy hardware first.');
  v.buy('minipc');
  assert.equal(v.toast(), 'Mini PC costs 100 cr; you have 0.17 cr (100 cr short, about 2m 27s at 0.68 cr/s).');
  assert.equal(v.state().owned.minipc, 0);
  // A click on the list's own padding, or on a span inside a button.
  fire(v.el('services'), 'click');
  assert.equal(v.state().owned.dns, 2);
  v.restore();
  resetStubs();
  const quiet = quietSeed(400);
  const p = openPage(t, { state: saveOf({ seed: quiet, credits: 2000 }) });
  p.v.item('minipc').children[0].children[1].click();
  assert.equal(p.v.state().owned.minipc, 1, 'a tap on the name inside the button buys it');
  assert.equal(p.v.text('slots'), '1/5');
  assert.equal(p.v.text('places'), '1/8');
  p.v.buy('cooling');
  assert.equal(p.v.state().owned.cooling, 1);
  assert.match(p.v.log().at(-1), /^\[0:00:00\] Bought Cooling level 1 for 800 cr\.$/);
  assert.equal(p.v.item('cooling').children[1].textContent, 'PUE 1.4 → 1.25');
  // The log keeps the latest 8 lines.
  for (let i = 0; i < 4; i++) p.v.buy('dns');
  for (let i = 0; i < 5; i++) p.v.buy('minipc');
  const log = p.v.log();
  assert.equal(log.length, 8);
  assert.equal(log[0], '[0:00:00] Bought DNS filter #3 for 8 cr.', 'of 11 lines the 3 oldest went');
  assert.equal(log.at(-1), '[0:00:00] Bought Mini PC #6 for ' + costModel('minipc', 5) + ' cr.');
  assert.ok(!log.some((line) => /Old laptop booted/.test(line)), 'the oldest line went');
});

test('uptime-idle: keys 1-9 buy only while the focus is inside the game; host-page fields, modifiers, held keys and other keys are left alone', (t) => {
  const quiet = quietSeed(2000);
  const { v } = openPage(t, { state: saveOf({ credits: 1e6, seed: quiet, owned: { dns: 1, minipc: 2 } }) });
  // Tab to a shop button and press 1 / 6: a DNS filter and a mini PC.
  let ev = v.press('1');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(v.state().owned.dns, 2);
  v.press('6');
  assert.equal(v.state().owned.minipc, 3);
  // The focus on the game itself (a click on its background) works too.
  focusElement(v.root);
  pressKey('2', { target: v.root });
  assert.equal(v.state().owned.backup, 1);
  // AZERTY: the 1 key without Shift types &.
  v.press('&', { code: 'Digit1' });
  assert.equal(v.state().owned.dns, 3);
  // Left alone: Ctrl/Alt/Meta, a key held down (but still kept from the page), Shift+1, 0, letters, handled keys, composing.
  for (const props of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    ev = v.press('1', props);
    assert.equal(ev.defaultPrevented, false, JSON.stringify(props));
  }
  ev = v.press('1', { repeat: true });
  assert.equal(ev.defaultPrevented, true, 'a held digit does not reach the page either');
  for (const [key, props] of [['!', { code: 'Digit1', shiftKey: true }], ['0', {}], ['a', {}], ['ArrowDown', {}], ['End', { code: 'Numpad1' }]]) {
    ev = v.press(key, props);
    assert.equal(ev.defaultPrevented, false, key);
  }
  const handled = createEvent('keydown', { key: '1', code: 'Digit1' });
  handled.preventDefault();
  v.item('dns').dispatchEvent(handled);
  assert.equal(v.state().owned.dns, 3, 'none of these bought anything');
  // Enter and Space on a focused shop button are the browser's own click: the game leaves them to the button.
  ev = v.press('Enter');
  assert.equal(ev.defaultPrevented, false);
  ev = v.press(' ');
  assert.equal(ev.defaultPrevented, false);
  assert.equal(v.state().owned.dns, 5, 'each pressed the DNS filter button once');
  // Outside the game: the page body and a host-page field.
  document.activeElement = document.body;
  pressKey('1');
  const host = v.page.add('host-search', { tagName: 'input' });
  focusElement(host);
  ev = pressKey('1', { target: host });
  assert.equal(ev.defaultPrevented, false);
  // A field inside the game (an extension or the host may add one) keeps its digits.
  const field = v.page.add('upi-test-field', { tagName: 'input', parent: 'upi-root' });
  focusElement(field);
  ev = pressKey('1', { target: field });
  assert.equal(ev.defaultPrevented, false);
  assert.equal(v.state().owned.dns, 5, 'nothing typed outside the game bought anything');
  assert.equal(v.state().owned.backup, 1);
  // A key whose item cannot be bought shows the refusal.
  v.press('9');
  assert.equal(v.state().owned.rack, 1);
  v.press('5');
  assert.match(v.toast(), /^Build farm costs 4\.0M cr; you have \d+\.\dk cr/);
});

test('uptime-idle: a held Enter or Space on a game button clicks it once: no stream of purchases, and no migration from one long press', (t) => {
  const quiet = quietSeed(4000);
  const { clock, v } = openPage(t, {
    state: saveOf({ seed: quiet, runMs: HOUR, credits: 5e7, runEarned: 4.32e8, owned: { dns: 50, minipc: 8, virt: 10, rack: 1, build: 2 } })
  });
  assert.equal(v.text('slots'), '52/126', 'room for many more');
  const dns = v.item('dns');
  focusElement(dns, { keyboard: true });
  // The first keydown is the button's own click; the auto-repeats are stopped and buy nothing.
  let ev = pressKey('Enter', { target: dns });
  assert.equal(ev.defaultPrevented, false);
  assert.equal(v.state().owned.dns, 51);
  for (let i = 0; i < 30; i++) {
    ev = pressKey('Enter', { target: dns, repeat: true });
    assert.equal(ev.defaultPrevented, true);
  }
  for (let i = 0; i < 5; i++) pressKey(' ', { target: dns, repeat: true });
  assert.equal(v.state().owned.dns, 51, 'one press, one DNS filter');
  // Even with a modifier held, a repeat clicks nothing.
  assert.equal(pressKey('Enter', { target: dns, repeat: true, shiftKey: true }).defaultPrevented, true);
  assert.equal(v.state().owned.dns, 51);
  // Held Enter on Migrate: the first press arms it, the repeats do not confirm.
  const migrate = v.el('migrate');
  focusElement(migrate, { keyboard: true });
  pressKey('Enter', { target: migrate });
  assert.equal(v.text('migrate'), 'Press again to migrate');
  for (let i = 0; i < 15; i++) {
    clock.advance(33);
    assert.equal(pressKey('Enter', { target: migrate, repeat: true }).defaultPrevented, true);
  }
  assert.equal(v.state().points, 0, 'not migrated');
  assert.equal(v.text('migrate'), 'Press again to migrate', 'still armed');
  // A held Enter in a field inside the game is not a button press: it is left to the field.
  const field = v.page.add('upi-test-field', { tagName: 'input', parent: 'upi-root' });
  assert.equal(pressKey('Enter', { target: field, repeat: true }).defaultPrevented, false);
  // A fresh Enter after letting go confirms it.
  pressKey('Enter', { target: migrate });
  assert.equal(v.state().points, 12);
});

test('uptime-idle: a double click or double tap on Migrate is one press: the confirmation needs a second press at least 400 ms later', (t) => {
  const quiet = quietSeed(4000);
  const { clock, v } = openPage(t, {
    state: saveOf({ seed: quiet, runMs: HOUR, credits: 5e7, runEarned: 4.32e8, owned: { dns: 50, minipc: 8, rack: 1, build: 2 } })
  });
  v.el('migrate').click();
  clock.advance(100);
  v.el('migrate').click();
  assert.equal(v.state().points, 0, 'the second click of a double click is ignored');
  assert.equal(v.text('migrate'), 'Press again to migrate');
  clock.advance(299);
  v.el('migrate').click();
  assert.equal(v.state().points, 0, '399 ms after arming');
  clock.advance(1);
  v.el('migrate').click();
  assert.equal(v.state().points, 12, '400 ms after arming');
  // The 4 s window still counts from the first press.
  v.restore();
  resetStubs();
  const p = openPage(t, { state: saveOf({ seed: quiet, runMs: HOUR, credits: 5e7, runEarned: 4.32e8, owned: { dns: 50, minipc: 8, rack: 1, build: 2 } }) });
  p.v.el('migrate').click();
  p.clock.advance(200);
  p.v.el('migrate').click();
  p.clock.advance(3800);
  assert.equal(p.v.text('migrate'), 'Migrate to a new rack');
});

test('uptime-idle: on the page a machine that would eat all the income is refused with its values and shown blocked, and a damaged save that cannot earn loads as a lab that does', (t) => {
  const quiet = quietSeed(4000);
  const { clock, v } = openPage(t, { state: saveOf({ seed: quiet, credits: 878 }) });
  v.press('6');
  v.press('6');
  assert.equal(v.state().owned.minipc, 2);
  assert.equal(v.text('net'), '+0.08 cr/s');
  assert.equal(v.item('minipc').className, 'upi-item upi-item--blocked');
  v.press('6');
  assert.equal(v.toast(), 'A Mini PC would bring the net income to -0.01 cr/s (income 0.5, power bill 0.51 cr/s without incidents): buy a service first.');
  assert.equal(v.state().owned.minipc, 2);
  for (const id of ['nas', 'virt', 'rack']) assert.equal(v.item(id).className, 'upi-item upi-item--blocked', id);
  // A service first, and the mini PC can be had again.
  v.press('1');
  assert.equal(v.item('minipc').className, 'upi-item');
  v.press('6');
  assert.equal(v.state().owned.minipc, 3);
  assert.ok(netModel(game({ owned: v.state().owned })) > 0);
  clock.advance(10 * SECOND);
  v.restore();
  // The lab the review found locked: 1 DNS filter, 6 mini PCs, 0 cr, -0.30 cr/s.  Loaded, 4 mini PCs are powered off,
  // it earns +0.08 cr/s, and in 90 s it buys a second DNS filter.
  resetStubs();
  const p = openPage(t, { state: saveOf({ seed: quiet, credits: 0, owned: { dns: 1, minipc: 6 } }) });
  assert.equal(p.v.text('places'), '2/8');
  assert.equal(p.v.text('net'), '+0.08 cr/s');
  assert.equal(p.v.state().owned.minipc, 2, 'the repaired lab is saved');
  p.clock.advance(90 * SECOND);
  p.v.buy('dns');
  assert.equal(p.v.state().owned.dns, 2, 'it buys its way out');
  assert.ok(p.v.state().credits < 1);
});

test('uptime-idle: the incident button and the armed Migrate button say what they do in their accessible names', (t) => {
  const { clock, v } = openPage(t, { state: saveOf({ seed: seedFor('disk'), runMs: MINUTE, owned: { dns: 10, minipc: 3 } }) });
  const label = (name) => v.el(name).getAttribute('aria-label');
  assert.equal(label('incident-action'), 'Nothing to do');
  clock.advance(TICK);
  assert.equal(label('incident-action'), 'Replace disk: income is halved until then');
  assert.ok(label('incident-action').startsWith(v.text('incident-action')), 'the name starts with the visible text');
  v.el('incident-action').click();
  assert.equal(label('incident-action'), 'Nothing to do');
  v.restore();
  resetStubs();
  const k = openPage(t, { state: saveOf({ seed: seedFor('kernel'), runMs: MINUTE, owned: { dns: 2 } }) });
  k.clock.advance(TICK);
  assert.equal(k.v.el('incident-action').getAttribute('aria-label'), 'Reboot: +50% income for 60 s, offer open for 60 s');
  k.clock.advance(10 * SECOND);
  assert.equal(k.v.el('incident-action').getAttribute('aria-label'), 'Reboot: +50% income for 60 s, offer open for 50 s');
  k.v.restore();
  resetStubs();
  const quiet = quietSeed(4000);
  const m = openPage(t, { state: saveOf({ seed: quiet, runMs: HOUR, credits: 5e7, runEarned: 4.32e8, owned: { dns: 50, minipc: 8, rack: 1, build: 2 } }) });
  const migrate = m.v.el('migrate');
  assert.equal(migrate.getAttribute('aria-label'), 'Migrate to a new rack: start over with a permanent income bonus');
  migrate.click();
  assert.equal(migrate.getAttribute('aria-label'), 'Press again to migrate: the run starts over for +12 rack points');
  assert.ok(migrate.getAttribute('aria-label').startsWith(migrate.textContent));
  m.clock.advance(4000);
  assert.equal(migrate.getAttribute('aria-label'), 'Migrate to a new rack: start over with a permanent income bonus');
});

test('uptime-idle: incidents on the page: a failed disk waits for Replace disk, Reboot takes the kernel boost, an outage counts down and ends', (t) => {
  // A disk fails on the first tick.
  const { clock, v } = openPage(t, { state: saveOf({ seed: seedFor('disk'), runMs: MINUTE, owned: { dns: 10, minipc: 3 } }) });
  clock.advance(250);
  assert.equal(v.text('incident-text'), 'Disk failure: income is halved until the disk is replaced. A RAID mirror makes this harmless.');
  assert.equal(v.el('incident').className, 'upi-incident upi-incident--disk');
  assert.equal(v.hidden('incident-action'), false);
  assert.equal(v.text('incident-action'), 'Replace disk');
  assert.equal(v.log().at(-1), '[0:01:00] A disk failed: income halved until it is replaced.');
  assert.equal(v.text('net'), '+' + upi.upiFormat(netModel(game({ owned: { dns: 10, minipc: 3 }, event: { type: 'disk', left: 0 } }))) + ' cr/s');
  clock.advance(10 * SECOND);
  assert.equal(v.text('uptime'), Math.floor((1 - 10000 / 70250) * 10000) / 100 + '%');
  v.el('incident-action').click();
  assert.equal(v.state().event, null, 'saved at once');
  assert.equal(v.log().at(-1), '[0:01:10] Disk replaced: income is back to full.');
  assert.equal(v.hidden('incident-action'), true);
  assert.equal(v.el('incident').className, 'upi-incident');
  v.el('incident-action').click();
  assert.equal(v.toast(), null, 'nothing to do, nothing said');
  v.restore();

  // A kernel update: Reboot within 60 s for +50% for 60 s.
  resetStubs();
  const k = openPage(t, { state: saveOf({ seed: seedFor('kernel'), runMs: MINUTE, owned: { dns: 2 } }) });
  k.clock.advance(250);
  assert.equal(k.v.text('incident-text'), 'Kernel update available for 60 s: reboot for +50% income for 60 s.');
  assert.equal(k.v.text('incident-action'), 'Reboot');
  assert.equal(k.v.el('incident').className, 'upi-incident upi-incident--kernel');
  k.v.el('incident-action').click();
  assert.equal(k.v.text('incident-text'), 'New kernel: +50% income for 60 s.');
  assert.equal(k.v.log().at(-1), '[0:01:00] Rebooted into the new kernel: +50% income for 60 s.');
  assert.equal(k.v.state().boost, 60000);
  assert.equal(k.v.text('breakdown').split(',')[0], 'Income 1.5 cr/s');
  k.clock.advance(60 * SECOND);
  assert.equal(k.v.text('breakdown').split(',')[0], 'Income 1 cr/s');
  k.v.restore();

  // An unanswered offer runs out.
  resetStubs();
  const late = openPage(t, { state: saveOf({ seed: seedFor('kernel'), runMs: MINUTE }) });
  late.clock.advance(250 + 60 * SECOND);
  assert.ok(late.v.log().includes('[0:02:00] The kernel update offer ran out.'), late.v.log().join('\n'));
  late.v.restore();

  // A power outage: no income and no bill for 30 s.
  resetStubs();
  const o = openPage(t, { state: saveOf({ seed: seedFor('outage'), runMs: MINUTE, credits: 10 }) });
  o.clock.advance(250);
  assert.equal(o.v.text('incident-text'), 'Power outage: no income for 30 s. A UPS rides these out.');
  assert.equal(o.v.hidden('incident-action'), true);
  assert.equal(o.v.text('net'), '+0 cr/s');
  assert.equal(o.v.el('incident').className, 'upi-incident upi-incident--outage');
  o.clock.advance(10 * SECOND);
  assert.equal(o.v.text('incident-text'), 'Power outage: no income for 20 s. A UPS rides these out.');
  o.clock.advance(20 * SECOND);
  assert.equal(o.v.log().at(-1), '[0:01:30] Power is back.');
  assert.equal(o.v.text('incident-text'), 'All systems nominal. Incidents: 1.');
  o.v.restore();

  // With a RAID mirror and a UPS the same incidents only make a log line.
  for (const [kind, line] of [['disk', 'A disk failed; the RAID mirror rebuilt it. Nothing lost.'], ['outage', 'Power outage; the UPS carried the load. Nothing lost.']]) {
    resetStubs();
    const s = openPage(t, { state: saveOf({ seed: seedFor(kind), runMs: MINUTE, owned: { nas: 1, raid: 1, ups: 1 } }) });
    s.clock.advance(250);
    assert.equal(s.v.log().at(-1), '[0:01:00] ' + line);
    assert.equal(s.v.text('incident-text'), 'All systems nominal. Incidents: 1.');
    s.v.restore();
  }
});

test('uptime-idle: the session goal shows its progress; reaching it pays the reward with a toast and a log line and sets the next goal', (t) => {
  const quiet = quietSeed(400);
  const { clock, v } = openPage(t, { state: saveOf({ seed: quiet, runMs: MINUTE, credits: 5, owned: { dns: 2 }, goal: { target: 10, progress: 7.5, reward: 33 } }) });
  assert.equal(v.text('goal-progress'), '7.5 / 10 cr · 75%');
  assert.equal(v.el('goal-fill').style.width, '75%');
  const net = netModel(game({ owned: { dns: 2 } }));
  const ticks = Math.ceil(2.5 / (net / 4));
  clock.advance(ticks * TICK);
  assert.equal(v.toast(), 'Session goal reached: +33 cr');
  assert.equal(v.log().at(-1), '[0:01:' + String((ticks - 1) * TICK / 1000 | 0).padStart(2, '0') + '] Session goal reached: +33 cr. Next: Earn ' +
    upi.upiFormat(upi.upiNiceCeil(Math.max(60, net * 180))) + ' cr.');
  const next = { target: upi.upiNiceCeil(Math.max(60, net * 180)), reward: Math.max(20, Math.floor(net * 90)) };
  assert.equal(next.target, 130);
  assert.equal(v.text('goal-text'), 'Earn 130 cr');
  assert.equal(v.text('goal-reward'), 'Reward +' + next.reward + ' cr');
  assert.equal(v.text('goal-progress'), '0 / 130 cr · 0%');
  assert.ok(Math.abs(Number(v.text('credits').split(' ')[0]) - Math.floor(5 + ticks * net / 4 + 33)) <= 1);
});

test('uptime-idle: a newer toast keeps its full 2.5 s', (t) => {
  const { clock, v } = openPage(t);
  v.buy('cooling');
  assert.match(v.toast(), /^Cooling costs/);
  clock.advance(2000);
  v.buy('ups');
  clock.advance(2499);
  assert.match(v.toast(), /^UPS costs/);
  clock.advance(1);
  assert.equal(v.toast(), null);
});

test('uptime-idle: migrating asks for a second press within 4 s, then starts over with the rack points; too early it names what is missing', (t) => {
  const quiet = quietSeed(400);
  const { clock, v } = openPage(t, {
    state: saveOf({ seed: quiet, runMs: HOUR, credits: 5e7, runEarned: 4.32e8, points: 3, goalsDone: 20, owned: { dns: 50, minipc: 8, rack: 1, build: 2 } }),
    stats: SAMPLE_STATS
  });
  assert.equal(v.text('migrate-text'), 'Ready: migrating adds 12 rack points (×1.06 → ×1.30 income); everything else starts over.');
  assert.equal(v.el('migrate').className, 'upi-btn upi-btn--migrate upi-btn--ready');
  v.el('migrate').click();
  assert.equal(v.text('migrate'), 'Press again to migrate');
  assert.match(v.el('migrate').className, /upi-btn--armed/);
  assert.equal(v.toast(), 'Press again within 4 s to migrate: +12 rack points, everything else starts over.');
  clock.advance(4000);
  assert.equal(v.text('migrate'), 'Migrate to a new rack', 'the confirmation runs out after 4 s');
  assert.doesNotMatch(v.el('migrate').className, /upi-btn--armed/);
  v.el('migrate').click();
  clock.advance(3000);
  v.el('migrate').click();
  const state = v.state();
  assert.equal(state.points, 15);
  assert.deepEqual(state.owned, ownedOf());
  assert.equal(state.credits, 0);
  assert.equal(state.runEarned, 0);
  assert.equal(state.goalsDone, 0);
  assert.equal(v.stats().prestiges, 3);
  assert.equal(v.text('mult'), '×1.30');
  assert.equal(v.text('lifetime').split(', ')[1], '3 migrations.');
  assert.equal(v.toast(), 'Migrated: ×1.30 income');
  assert.match(v.log().at(-1), /\] Migrated to a new rack: \+12 rack points, ×1\.30 income from now on\.$/);
  assert.equal(v.item('dns').children[1].textContent, '+0.65 cr/s · 1 slot · 15 W');
  // Too early now: the refusal names both values, and the button is not armed.
  v.el('migrate').click();
  assert.equal(v.toast(), 'Migrating needs a Server rack (you own 0) and 300.0M cr earned in this run (0 so far).');
  assert.equal(v.text('migrate'), 'Migrate to a new rack');
  clock.advance(10000);
  // One migration earlier on the page: '1 migration'.
  v.restore();
  resetStubs();
  const one = openPage(t, { stats: { v: 1, totalEarned: 5, prestiges: 1 } });
  assert.equal(one.v.text('lifetime'), 'Lifetime: 5 cr earned, 1 migration.');
});

test('uptime-idle: a hidden tab stops ticking and saves; shown again the time away counts in one sum, with the welcome line after a minute', (t) => {
  const quiet = quietSeed(2000);
  const { clock, v } = openPage(t, { state: saveOf({ seed: quiet, owned: { dns: 10, minipc: 3 } }) });
  const rate = netModel(game({ owned: { dns: 10, minipc: 3 } }));
  clock.advance(10 * SECOND);
  setVisibility('hidden', t);
  const hidden = v.state();
  assert.equal(hidden.runMs, 10000, 'saved as it was hidden');
  assert.equal(hidden.savedAt, NOW + 10000);
  const writes = t.mock.method(localStorage, 'setItem');
  clock.advance(2 * HOUR);
  assert.equal(writes.mock.callCount(), 0, 'nothing runs in a hidden tab');
  setVisibility('hidden', t);
  assert.equal(writes.mock.callCount(), 0, 'a second hidden event saves nothing');
  setVisibility('visible', t);
  const shown = v.state();
  assert.equal(shown.runMs, 10000 + 2 * HOUR, 'the hidden time counted at once');
  assert.ok(Math.abs(shown.credits - (hidden.credits + rate * 7200)) < 1e-6);
  assert.equal(v.text('welcome'), 'While you were away: 2h 00m (all of it counted, the cap is 8h 00m): +' + upi.upiFormat(rate * 7200) + ' cr.');
  assert.equal(v.hidden('welcome'), false);
  assert.equal(v.log().at(-1), '[2:00:10] ' + v.text('welcome'));
  // No burst: the next tick adds one tick.
  const before = v.state().credits;
  clock.advance(5000);
  assert.ok(Math.abs(v.state().credits - (before + rate * 5)) < 1e-6);
  setVisibility('visible', t);
  assert.equal(v.state().runMs, 10000 + 2 * HOUR + 5000, 'a second visible event changes nothing');
  // A short hide counts too, without a line.
  setVisibility('hidden', t);
  clock.advance(30 * SECOND);
  setVisibility('visible', t);
  assert.equal(v.state().runMs, 10000 + 2 * HOUR + 35000);
  assert.equal(v.hidden('welcome'), true);
});

test('uptime-idle: a page opened in a hidden tab starts ticking when it is shown, with the hidden time counted', (t) => {
  const quiet = quietSeed(400);
  writeStorage({ state: saveOf({ seed: quiet }) });
  document.hidden = true;
  document.visibilityState = 'hidden';
  const { clock, v } = openPage(t);
  clock.advance(10 * MINUTE);
  assert.equal(v.state().runMs, 0);
  setVisibility('visible', t);
  assert.equal(v.state().runMs, 10 * MINUTE);
  assert.match(v.text('welcome'), /^While you were away: 10m 00s/);
  clock.advance(1000);
  assert.equal(v.text('goal-progress').split(' ')[0], upi.upiFormat(netModel(game()) * 1));
});

test('uptime-idle: a reload keeps the lab and counts the time away; the cap is 8 h and a clock set back counts nothing', (t) => {
  const quiet = quietSeed(4000);
  const { clock, v } = openPage(t, { state: saveOf({ seed: quiet, credits: 500, owned: { dns: 8, minipc: 3 } }) });
  const rate = netModel(game({ owned: { dns: 8, minipc: 3 } }));
  clock.advance(5000);
  v.buy('dns');
  const snapshot = v.state();
  // Ten seconds later: counted, no line.
  let again = reload(clock, v, 10 * SECOND);
  assert.equal(again.state().runMs, snapshot.runMs + 10000);
  assert.equal(again.state().owned.dns, 9);
  assert.equal(again.hidden('welcome'), true);
  assert.deepEqual(again.log(), [], 'the log is per visit');
  // Three days later: 8 hours counted.
  const before = again.state();
  const rate9 = netModel(game({ owned: { dns: 9, minipc: 3 } }));
  assert.ok(rate9 > rate);
  again = reload(clock, again, 3 * 86400000);
  assert.ok(Math.abs(again.state().credits - (before.credits + rate9 * CAP / 1000)) < 1e-6);
  assert.equal(again.text('welcome'), 'While you were away: 3d 00h (8h 00m counted, the cap is 8h 00m): +' + upi.upiFormat(rate9 * CAP / 1000) + ' cr.');
  assert.equal(again.state().savedAt, clock.now());
  // The clock set back by a day: nothing counted, and the save keeps the latest time seen, not the earlier one.
  const credits = again.state().credits;
  const mark = clock.now();
  again = reload(clock, again, -86400000);
  assert.equal(again.state().credits, credits);
  assert.equal(again.text('welcome'), 'The clock is 1d 00h behind the last save: no time is counted until it catches up (offline progress counts up to 8h 00m).');
  assert.equal(again.state().savedAt, mark);
  // Playing on with the clock behind: the ticks count as always, and the next saves still carry the mark.
  clock.advance(5000);
  assert.ok(Math.abs(again.state().credits - (credits + rate9 * 5)) < 1e-6);
  assert.equal(again.state().savedAt, mark);
});

test('uptime-idle: a clock set forwards and back again pays the 8 h cap once, not on every round trip, through reloads or a hidden tab', (t) => {
  const quiet = quietSeed(4000);
  const owned = { dns: 8, minipc: 3 };
  const rate = netModel(game({ owned }));
  const { clock, v } = openPage(t, { state: saveOf({ seed: quiet, owned }) });
  const start = v.state().credits;
  // Forwards 8 h and reload: 8 h counted.
  let page = reload(clock, v, CAP);
  assert.ok(Math.abs(page.state().credits - (start + rate * CAP / 1000)) < 1e-6);
  const paid = page.state().credits;
  assert.equal(page.state().savedAt, NOW + CAP);
  // Back 8 h and reload: nothing, and the save keeps the mark.
  page = reload(clock, page, -CAP);
  assert.equal(page.state().credits, paid);
  assert.match(page.text('welcome'), /^The clock is 8h 00m behind the last save/);
  assert.equal(page.state().savedAt, NOW + CAP);
  // Forwards 8 h again: the clock is only back at the mark, so nothing beyond the real time (none) counts.
  page = reload(clock, page, CAP);
  assert.equal(page.state().credits, paid, 'the second forward jump pays nothing');
  assert.equal(page.hidden('welcome'), true);
  assert.equal(page.state().savedAt, NOW + CAP);
  // Real time from here counts again.
  page = reload(clock, page, 10 * MINUTE);
  assert.ok(Math.abs(page.state().credits - (paid + rate * 600)) < 1e-6);
  assert.equal(page.state().savedAt, NOW + CAP + 10 * MINUTE);
  // The same round trip with a hidden tab instead of reloads.
  const base = page.state();
  setVisibility('hidden', t);
  clock.jump(CAP);
  setVisibility('visible', t);
  assert.ok(Math.abs(page.state().credits - (base.credits + rate * CAP / 1000)) < 1e-6, 'the first jump counts, like real time away');
  const shown = page.state().credits;
  setVisibility('hidden', t);
  clock.jump(-CAP);
  setVisibility('visible', t);
  assert.equal(page.state().credits, shown);
  assert.match(page.text('welcome'), /^The clock is 8h 00m behind the last save: no time is counted/);
  setVisibility('hidden', t);
  clock.jump(CAP);
  setVisibility('visible', t);
  assert.equal(page.state().credits, shown, 'and the second one nothing');
  assert.equal(page.state().runMs, base.runMs + CAP);
  // Five round trips through reloads earn what one does.
  const five = page.state().credits;
  for (let i = 0; i < 5; i++) {
    page = reload(clock, page, -CAP);
    page = reload(clock, page, CAP);
  }
  assert.equal(page.state().credits, five);
});

test('uptime-idle: a visible tab whose computer slept counts the gap at its next tick, in one sum and with the welcome line; a clock set back while it runs counts nothing', (t) => {
  const quiet = quietSeed(4000);
  const owned = { dns: 8, minipc: 3 };
  const rate = netModel(game({ owned }));
  const { clock, v } = openPage(t, { state: saveOf({ seed: quiet, owned }) });
  clock.advance(5000);
  const before = v.state();
  // The lid closes for 6 hours: no timer fires and no visibilitychange comes.
  clock.jump(6 * HOUR);
  const writes = t.mock.method(localStorage, 'setItem');
  clock.advance(TICK);
  assert.equal(v.text('welcome'), 'While you were away: 6h 00m (all of it counted, the cap is 8h 00m): +' + upi.upiFormat(rate * 6 * 3600) + ' cr.');
  assert.equal(v.log().at(-1), '[6:00:05] ' + v.text('welcome'));
  assert.deepEqual(writes.mock.calls.map((c) => c.arguments[0]), [STATE_KEY, STATS_KEY], 'saved at once');
  writes.mock.restore();
  const woke = v.state();
  assert.ok(Math.abs(woke.credits - (before.credits + rate * (6 * 3600 + 0.25))) < 1e-6, 'the gap and one tick, no replayed ticks');
  assert.equal(woke.runMs, before.runMs + 6 * HOUR + TICK);
  assert.equal(woke.savedAt, NOW + 5000 + 6 * HOUR + TICK);
  // A night longer than the cap counts the cap.
  clock.jump(20 * HOUR);
  clock.advance(TICK);
  assert.match(v.text('welcome'), /^While you were away: 20h 00m \(8h 00m counted, the cap is 8h 00m\)/);
  // A short stall of 3 s counts without a line; ticks a little late (under 2 s) are just ticks.
  const stalled = v.state();
  clock.jump(3000);
  clock.advance(TICK);
  assert.equal(v.state().runMs, stalled.runMs + 3250);
  assert.equal(v.hidden('welcome'), true);
  const late = v.state();
  clock.jump(1500);
  clock.advance(5000);
  assert.equal(v.state().runMs, late.runMs + 5000, 'no gap counted for a tick 1.75 s late');
  // The clock set back an hour while the game runs: the ticks go on as always, nothing extra counts, no line.
  const back = v.state();
  clock.jump(-HOUR);
  clock.advance(5000);
  assert.equal(v.state().runMs, back.runMs + 5000);
  assert.ok(Math.abs(v.state().credits - (back.credits + rate * 5)) < 1e-6);
  assert.equal(v.state().savedAt, back.savedAt, 'the save keeps the mark while the clock is behind it');
  assert.equal(v.hidden('welcome'), true);
});

test('uptime-idle: a save in the current format loads as it was and is written back in the same format', (t) => {
  const { clock, v } = openPage(t, { state: SAMPLE_SAVE, stats: SAMPLE_STATS });
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE, 'nothing changed yet: the same text');
  assert.equal(localStorage.getItem(STATS_KEY), SAMPLE_STATS);
  assert.equal(v.text('credits'), '1.2k cr');
  assert.equal(v.text('slots'), '16/17');
  assert.equal(v.text('places'), '5/8');
  assert.equal(v.text('goal-progress'), '250 / 1.1k cr · 22%', '250.5 cr shows as 250');
  assert.equal(v.text('uptime'), Math.floor((1 - 15000 / 754000) * 10000) / 100 + '%');
  assert.equal(v.text('lifetime'), 'Lifetime: 98.7k cr earned, 2 migrations.');
  assert.equal(v.text('incident-text'), 'All systems nominal. Incidents: 3.');
  clock.advance(5000);
  const raw = JSON.parse(SAMPLE_SAVE);
  const written = v.state();
  assert.deepEqual(Object.keys(written), Object.keys(raw));
  assert.deepEqual(Object.keys(written.owned), Object.keys(raw.owned));
  const expected = ticksOf(upi.upiParseState(SAMPLE_SAVE, 1).game, 20);
  assert.equal(localStorage.getItem(STATE_KEY), upi.upiSerializeState(expected, NOW + 5000));
  assert.deepEqual(Object.keys(v.stats()), ['v', 'totalEarned', 'prestiges']);
  assert.ok(Math.abs(v.stats().totalEarned - (98765.5 + expected.runEarned - 5678.25)) < 1e-6);
});

test('uptime-idle: a corrupt or partial save never breaks the page: a fresh or partly kept, playable lab instead', (t) => {
  for (const text of ['{', '[]', 'null', '"x"', '{"credits":"lots","owned":"all"}', '{"owned":{"dns":-4},"goal":{},"event":{"type":"meteor"}}']) {
    resetStubs();
    const { clock, v } = openPage(t, { state: text, stats: '{' });
    assert.equal(v.text('slots'), '1/2', text);
    assert.equal(v.text('lifetime'), 'Lifetime: 0 cr earned, 0 migrations.', text);
    clock.advance(30 * SECOND);
    v.buy('dns');
    assert.equal(v.state().owned.dns, 2, text);
    v.restore();
  }
  // A partial save keeps what it can: the credits and the DNS filters stay, the broken goal is replaced.
  resetStubs();
  const { v } = openPage(t, { state: '{"credits":250,"owned":{"dns":3,"minipc":"two"},"goal":"soon","savedAt":"yesterday"}' });
  assert.equal(v.text('credits'), '250 cr');
  assert.equal(v.text('slots'), '3/2');
  assert.equal(v.text('places'), '0/8');
  assert.equal(v.hidden('welcome'), true, 'no time counted without a save time');
  assert.equal(v.text('goal-text'), 'Earn ' + upi.upiFormat(upi.upiNiceCeil(netModel(game({ owned: { dns: 3 } })) * 180)) + ' cr');
  assert.equal(v.item('dns').className, 'upi-item upi-item--blocked', 'more services than slots: they run, but no new one');
  v.buy('minipc');
  assert.equal(v.state().owned.minipc, 1);
});

test('uptime-idle: blocked storage never stops the game, and the warning names the keys and the error', (t) => {
  blockStorage('access', t);
  const { clock, v } = openPage(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Storage is blocked (SecurityError): upi-stats and upi-state cannot be read or saved, so progress here will not survive a reload.');
  clock.advance(30 * SECOND);
  v.buy('dns');
  assert.equal(v.text('slots'), '2/2');
  setVisibility('hidden', t);
  clock.advance(HOUR);
  setVisibility('visible', t);
  assert.match(v.text('welcome'), /^While you were away: 1h 00m/, 'the hidden time counts without storage');
  clock.advance(10 * SECOND);
  assert.match(v.text('credits'), /^\d/);
});

test('uptime-idle: full storage still reads the saves; the game plays on, warns once and never rolls back to the old save', (t) => {
  const quiet = quietSeed(4000);
  writeStorage({ state: saveOf({ seed: quiet, credits: 1000 }), stats: SAMPLE_STATS });
  blockStorage('full', t);
  const { clock, v } = openPage(t);
  assert.equal(v.text('credits'), '1.0k cr', 'the save is still read');
  assert.equal(v.text('warning'), 'Storage is full (QuotaExceededError): upi-state and upi-stats could not be saved, so progress here will not survive a reload.');
  v.el('warning').textContent = 'seen';
  v.buy('minipc');
  clock.advance(10 * SECOND);
  assert.equal(v.text('slots'), '1/5', 'the purchase stays although its save failed');
  assert.equal(v.text('warning'), 'seen', 'warned once');
  assert.equal(JSON.parse(localStorage.getItem(STATE_KEY)).credits, 1000);
});

test('uptime-idle: a second tab never writes over another tab\'s newer save: it takes it over at the storage event, before a purchase and before its own save', (t) => {
  const quiet = quietSeed(2000);
  const { clock, v } = openPage(t, { state: saveOf({ seed: quiet, credits: 300, owned: { dns: 1 } }), stats: SAMPLE_STATS });
  clock.advance(2000);
  // Another tab bought two mini PCs and saved: the storage event brings it here.
  const other = JSON.stringify(saveOf({ seed: quiet, credits: 77, owned: { dns: 1, minipc: 2 }, runMs: 9000, savedAt: NOW + 1000 }));
  localStorage.setItem(STATE_KEY, other);
  const writes = t.mock.method(localStorage, 'setItem');
  fire(window, 'storage', { key: STATE_KEY, newValue: other });
  assert.equal(v.text('slots'), '1/8');
  assert.equal(v.toast(), 'Another tab saved newer progress: it is shown here.');
  assert.equal(writes.mock.callCount(), 0, 'taking over writes nothing back');
  assert.equal(v.text('credits'), upi.upiFormat(77 + netModel(game({ owned: { minipc: 2 } }))) + ' cr', 'plus the second since that tab saved');
  // The next own save writes this tab's progress on top of it.
  writes.mock.restore();
  clock.advance(5000);
  assert.equal(v.state().owned.minipc, 2);
  assert.equal(v.state().runMs, 9000 + 1000 + 3000, 'that tab\'s run, the second until the event, and the 3 s to this tab\'s next 5 s save');
  // Another tab's save that arrives without an event is found before a purchase: the purchase applies to it.
  localStorage.setItem(STATE_KEY, JSON.stringify(saveOf({ seed: quiet, credits: 5000, owned: { dns: 4, minipc: 3 }, savedAt: clock.now() })));
  v.buy('nas');
  assert.deepEqual([v.state().owned.minipc, v.state().owned.nas], [3, 1]);
  // ... and before a periodic save.
  localStorage.setItem(STATE_KEY, JSON.stringify(saveOf({ seed: quiet, credits: 9, owned: { dns: 4, minipc: 3, nas: 1 }, savedAt: clock.now() })));
  clock.advance(5000);
  assert.equal(v.text('slots'), '4/15');
  // A damaged text from elsewhere is not taken over, and storage events for other keys change nothing.
  const mine = localStorage.getItem(STATE_KEY);
  otherTabWrites(STATE_KEY, '{oops');
  assert.equal(v.text('slots'), '4/15');
  fire(window, 'storage', { key: 'ppn-state', newValue: '{}' });
  fire(window, 'storage', { key: null, newValue: null });
  clock.advance(5000);
  assert.notEqual(localStorage.getItem(STATE_KEY), mine, 'this tab saves over the damaged text');
  // Lifetime stats merge to the higher values, never down.
  otherTabWrites(STATS_KEY, '{"v":1,"totalEarned":5e6,"prestiges":1}');
  assert.equal(v.text('lifetime'), 'Lifetime: 5.0M cr earned, 2 migrations.');
  otherTabWrites(STATS_KEY, null);
  clock.advance(5000);
  assert.ok(v.stats().totalEarned >= 5e6);
  assert.equal(v.stats().prestiges, 2);
  // A save without a time is taken over as it is.
  otherTabWrites(STATE_KEY, JSON.stringify(Object.assign(saveOf({ seed: quiet, credits: 42 }), { savedAt: null })));
  assert.equal(v.text('credits'), '42 cr');
});

test('uptime-idle: two open tabs take over each other\'s routine saves silently; only a purchase or a migration there brings a toast and cancels a pending migrate', (t) => {
  const quiet = quietSeed(4000);
  const owned = { dns: 50, minipc: 8, rack: 1, build: 2 };
  const { clock, v } = openPage(t, { state: saveOf({ seed: quiet, runMs: HOUR, credits: 5e7, runEarned: 4.32e8, owned }) });
  v.el('migrate').click();
  assert.equal(v.text('migrate'), 'Press again to migrate');
  clock.advance(5000);
  assert.equal(v.toast(), null, 'the arming toast is gone');
  // The other tab's routine save: the same lab, a few seconds of ticks further.
  const routine = JSON.stringify(saveOf({ seed: quiet, runMs: HOUR + 7000, credits: 5.1e7, runEarned: 4.33e8, owned, savedAt: clock.now() }));
  otherTabWrites(STATE_KEY, routine);
  assert.equal(v.toast(), null, 'no toast for a routine save');
  assert.equal(v.text('credits'), '51.0M cr', 'taken over all the same');
  // Arm again: a routine save that comes in meanwhile keeps the confirmation.
  v.el('migrate').click();
  clock.advance(1000);
  otherTabWrites(STATE_KEY, JSON.stringify(saveOf({ seed: quiet, runMs: HOUR + 9000, credits: 5.2e7, runEarned: 4.34e8, owned, savedAt: clock.now() })));
  assert.equal(v.text('migrate'), 'Press again to migrate', 'still armed');
  // The other tab bought a DNS filter: a toast, and the pending migrate is cancelled.
  otherTabWrites(STATE_KEY, JSON.stringify(saveOf({ seed: quiet, runMs: HOUR + 9000, credits: 5.2e7, runEarned: 4.34e8, owned: Object.assign({}, owned, { dns: 51 }), savedAt: clock.now() })));
  assert.equal(v.toast(), 'Another tab saved newer progress: it is shown here.');
  assert.equal(v.text('migrate'), 'Migrate to a new rack');
  // The other tab migrated (the points changed): a toast too.
  clock.advance(3000);
  otherTabWrites(STATE_KEY, JSON.stringify(saveOf({ seed: quiet, points: 12, savedAt: clock.now() })));
  assert.equal(v.toast(), 'Another tab saved newer progress: it is shown here.');
  assert.equal(v.text('mult'), '×1.24');
  // A save from a tab whose mark is ahead of this tab's clock raises this tab's mark: its next save carries that time.
  clock.advance(3000);
  otherTabWrites(STATE_KEY, JSON.stringify(saveOf({ seed: quiet, points: 12, savedAt: clock.now() + HOUR })));
  clock.advance(5000);
  assert.equal(v.state().savedAt, clock.now() - 5000 + HOUR);
});

test('uptime-idle: a tab shown again takes over the save another tab wrote meanwhile, counting the time since that tab saved', (t) => {
  const quiet = quietSeed(4000);
  const { clock, v } = openPage(t, { state: saveOf({ seed: quiet }) });
  clock.advance(5000);
  setVisibility('hidden', t);
  clock.advance(HOUR);
  // Meanwhile another tab played on and saved 10 minutes ago.
  const other = saveOf({ seed: quiet, credits: 2000, owned: { dns: 6, minipc: 2 }, runMs: 40 * MINUTE, savedAt: clock.now() - 10 * MINUTE });
  localStorage.setItem(STATE_KEY, JSON.stringify(other));
  localStorage.setItem(STATS_KEY, '{"v":1,"totalEarned":3000,"prestiges":0}');
  setVisibility('visible', t);
  const rate = netModel(game({ owned: { dns: 6, minipc: 2 } }));
  assert.ok(Math.abs(v.state().credits - (2000 + rate * 600)) < 1e-6);
  assert.equal(v.state().runMs, 50 * MINUTE);
  assert.equal(v.text('welcome'), 'While you were away: 10m 00s (all of it counted, the cap is 8h 00m): +' + upi.upiFormat(rate * 600) + ' cr.');
  assert.ok(v.stats().totalEarned >= 3000 + rate * 600 - 1e-6);
  // A save another tab wrote without a time: taken over, no time counted.
  setVisibility('hidden', t);
  localStorage.setItem(STATE_KEY, JSON.stringify(Object.assign(saveOf({ seed: quiet, credits: 11 }), { savedAt: 'x' })));
  clock.advance(HOUR);
  setVisibility('visible', t);
  assert.equal(v.text('credits'), '11 cr');
  assert.equal(v.hidden('welcome'), true);
  // A hidden tab that takes over another tab's save through the storage event counts its time away from then on, once.
  setVisibility('hidden', t);
  clock.advance(10 * MINUTE);
  const third = saveOf({ seed: quiet, credits: 500, owned: { dns: 4 }, runMs: HOUR, savedAt: clock.now() - MINUTE });
  otherTabWrites(STATE_KEY, JSON.stringify(third));
  clock.advance(20 * MINUTE);
  setVisibility('visible', t);
  const rate4 = netModel(game({ owned: { dns: 4 } }));
  assert.ok(Math.abs(v.state().credits - (500 + rate4 * 21 * 60)) < 1e-6, 'the minute before the takeover and the 20 after it, nothing twice');
  assert.equal(v.state().runMs, HOUR + 21 * MINUTE);
  assert.match(v.text('welcome'), /^While you were away: 20m 00s /);
});

test('uptime-idle: every class the game puts on the page has a rule in style.css', (t) => {
  const seen = new Set();
  const collect = (v) => {
    for (const el of walk(v.page.root)) String(el.className || '').split(/\s+/).filter(Boolean).forEach((name) => seen.add(name));
  };
  // A lab that loses money while its disk is failed (it earns without the incident), with installed upgrades and sold-out,
  // short and blocked items.
  const owned = { dns: 150, minipc: 150, rack: 60, cooling: 3 };
  assert.ok(steadyModel(game({ owned })) > 0 && netModel(game({ owned, event: { type: 'disk', left: 0 } })) < 0);
  const { clock, v } = openPage(t, { state: saveOf({ seed: seedFor('disk'), runMs: MINUTE, credits: 5, owned }) });
  clock.advance(250);
  assert.match(v.text('net'), /^-/);
  v.buy('nas');
  collect(v);
  v.restore();
  for (const [kind, extra] of [['outage', {}], ['kernel', {}], ['disk', { owned: { dns: 60, virt: 8, nas: 1, raid: 1, rack: 2 }, runEarned: 4e8 }]]) {
    resetStubs();
    writeStorage({ state: saveOf(Object.assign({ seed: seedFor(kind), runMs: MINUTE }, extra)) });
    blockStorage('full', t);
    const p = openPage(t);
    p.clock.advance(250);
    p.v.el('migrate').click();
    collect(p.v);
    p.v.restore();
  }
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors).join(' ');
  for (const name of [...seen].sort()) {
    assert.match(name, /^upi-/);
    assert.match(selectors, new RegExp('\\.' + name + '(?![\\w-])'), name);
  }
  for (const name of ['upi-item--short', 'upi-item--blocked', 'upi-item--done', 'upi-incident--disk', 'upi-incident--outage', 'upi-incident--kernel',
    'upi-btn--ready', 'upi-btn--armed', 'upi-stat-value--bad', 'upi-show', 'upi-log-line', 'upi-item-key', 'upi-item-name', 'upi-item-owned',
    'upi-item-effect', 'upi-item-cost', 'upi-item-top']) {
    assert.ok(seen.has(name), name + ' was seen on the page');
  }
});
