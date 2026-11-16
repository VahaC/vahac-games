// tests/orphan-process.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, keyEvent, focusElement, setVisibility, listenerCount, seeded,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'orphan-process';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

// The pure functions (the start-up code does not run under Node).
const orp = loadScript(SCRIPT);

const SAVE_KEY = 'orp-state';

// The constants the spec pins, written out here so a change shows up as a
// failing test.
const T = 16;
const W = 480;
const H = 270;
const STEP = 1 / 120;
const HERO_W = 10;
const HERO_H = 14;
const RUN = 96;
const ACCEL_GROUND = 900;
const ACCEL_AIR = 600;
const GRAVITY = 900;
const MAX_FALL = 300;
const JUMP = 270;
const JUMP_CUT = 0.4;
const COYOTE = 0.08;
const BUFFER = 0.1;

const IDLE = Object.freeze({ left: false, right: false, jump: false, down: false, shoot: false, dash: false });

// The sprite names of the spec: the contract between the art and the code.
const SPRITE_NAMES = [
  'heroIdle1', 'heroIdle2', 'heroRun1', 'heroRun2', 'heroRun3', 'heroJump', 'heroFall', 'heroShoot', 'heroDash',
  'heroHurt', 'heroDead1', 'heroDead2',
  'bug1', 'bug2', 'zombie1', 'zombie2', 'daemon1', 'daemon2', 'daemonHurt', 'turret1', 'turret2', 'turretShot',
  'bossIdle', 'bossSweep1', 'bossSweep2', 'bossOpen', 'bossHurt', 'bossDead', 'tempFile',
  'signal1', 'signal2', 'spark1', 'spark2', 'spark3', 'dust1', 'dust2', 'reap1', 'reap2', 'reap3',
  'man', 'chip', 'module', 'capKill', 'capNice', 'ttyOff', 'ttyOn', 'switchOff', 'switchOn',
  'groundTop', 'ground', 'groundPlain', 'platform', 'spikes', 'cracked', 'doorTop', 'doorBottom', 'gate',
  'decor1', 'decor2', 'decor3', 'decor4',
  'tmpTop', 'tmp', 'tmpPlain', 'crate', 'crateTemp', 'crumble', 'crumble2', 'tmpDecor1', 'tmpDecor2', 'tmpDecor3'
];
const BOSS_NAMES = ['bossIdle', 'bossSweep1', 'bossSweep2', 'bossOpen', 'bossHurt', 'bossDead'];

// A save in the current format (v: 2; the game was never published with an
// older one): run k3x9q2 born at 1794000000000 ms, the tty of /tmp, nice 17
// with 12 XP, both capabilities, three items (fork(2) and both pedestals),
// the gate switch, the broken wall of ~, the end screen seen, three rooms,
// 12:34.5 of play and 3 deaths.
const SAMPLE_RUN = 'k3x9q2';
const SAMPLE_BORN = 1794000000000;
const SAMPLE_SAVE = '{"v":2,"run":"k3x9q2","born":1794000000000,"tty":"tmp:4,16","maxRss":6,"maxCpu":120,"xp":12,"nice":17,' +
  '"abilities":["kill","nice"],"collected":["man:fork","docs:9,5","arena:14,14"],"switches":["gate:38,7"],"walls":["home:4,16"],' +
  '"boss":false,"ended":true,"visited":["home","docs","tmp"],"time":754.5,"deaths":3}';
// The wall clock of the page tests (Date.now) at performance.now() 0.
const WALL = 1795000000000;

test.beforeEach(() => resetStubs());

// ── Labs: rooms made for one test ────────────────────────────────────────────

// Registers rooms (key -> def; title, area, map, exits and man default) for
// the length of test t, parsed fresh.
function withRooms(t, rooms) {
  for (const [key, def] of Object.entries(rooms)) {
    orp.orpRooms[key] = Object.assign({ title: '/lab', area: 'home', map: [9, 9], exits: {}, man: [] }, def);
    delete orp.orpRoomCache[key];
  }
  t.after(() => {
    for (const key of Object.keys(rooms)) {
      delete orp.orpRooms[key];
      delete orp.orpRoomCache[key];
    }
  });
}

// A room from its bottom lines (the last is the floor), walled, with air
// above up to 17 rows.
function lab(lines) {
  const w = lines[0].length;
  const rows = ['#'.repeat(w)];
  while (rows.length + lines.length < 17) rows.push('#' + '.'.repeat(w - 2) + '#');
  return rows.concat(lines);
}

// A game that starts in room 'lab' (rows) at its tty, with prog fields and
// more rooms as given.
function labSim(t, rows, options = {}) {
  withRooms(t, Object.assign({ lab: Object.assign({ rows }, options.def) }, options.rooms));
  const y = rows.findIndex((row) => row.includes('T'));
  const prog = Object.assign(orp.orpFreshProgress(), { tty: 'lab:' + rows[y].indexOf('T') + ',' + y }, options.prog);
  return orp.orpNewSim(prog);
}

// Steps with input held; returns the last state and every event on the way.
function run(sim, input, steps, events = []) {
  for (let i = 0; i < steps; i++) {
    sim = orp.orpStep(sim, Object.assign({}, IDLE, input));
    events.push(...sim.events);
  }
  return sim;
}

function runUntil(sim, input, done, max = 3000, events = []) {
  for (let i = 0; i < max && !done(sim); i++) {
    sim = orp.orpStep(sim, Object.assign({}, IDLE, input));
    events.push(...sim.events);
  }
  assert.ok(done(sim), 'the condition came true within ' + max + ' steps');
  return sim;
}

// The same state with fields changed (a copy; orpStep never needs it).
function edit(sim, fn) {
  const copy = JSON.parse(JSON.stringify(sim));
  fn(copy);
  return copy;
}

// Puts the hero at tile (cx, cy), feet on the tile's bottom, at rest.
function place(sim, cx, cy, extra) {
  return edit(sim, (s) => {
    Object.assign(s.hero, { x: cx * T + 3, y: (cy + 1) * T - HERO_H, vx: 0, vy: 0 }, extra);
  });
}

const settle = (sim) => run(sim, {}, 30);
const types = (events) => events.map((e) => e.type);
const messages = (events) => events.filter((e) => e.type === 'msg').map((e) => e.title);

// ── Files ────────────────────────────────────────────────────────────────────

test('orphan-process: every id the script looks up is in index.html once; ids, classes, CSS variables, keyframes, storage keys and exports are orp- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'orp-back-tty', 'orp-canvas', 'orp-continue', 'orp-end', 'orp-end-button', 'orp-end-stats', 'orp-focus', 'orp-focus-button',
    'orp-man-count', 'orp-man-list', 'orp-msg', 'orp-msg-text', 'orp-msg-title', 'orp-new', 'orp-paused', 'orp-resume',
    'orp-stage', 'orp-start', 'orp-toast', 'orp-warning'
  ]);
  assert.equal(ids.length, new Set(ids).size, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^orp-/);
  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  const madeClasses = Array.from(JS.matchAll(/className = '([^']+)'/g), (m) => m[1]);
  assert.ok(classes.length > 30);
  for (const name of classes.concat(madeClasses)) assert.match(name, /^orp-/);
  const rules = cssRules(CSS);
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/[.#]([\w-]+)/g)) assert.match(m[1], /^orp-/, selector);
    }
  }
  // Every class the page uses has a rule.
  const styled = new Set(rules.flatMap((rule) => rule.selectors.flatMap((s) => Array.from(s.matchAll(/\.([\w-]+)/g), (m) => m[1]))));
  for (const name of new Set(classes.concat(madeClasses, ['orp-show']))) assert.ok(styled.has(name), name + ' has a CSS rule');
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^orp-/);
  for (const m of JS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^orp-/);
  const keyframes = Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);
  assert.ok(keyframes.length >= 1);
  for (const name of keyframes) assert.match(name, /^orp-/);
  for (const m of CSS.matchAll(/animation(?:-name)?:\s*([\w-]+)/g)) assert.ok(m[1] === 'none' || keyframes.includes(m[1]), m[1]);
  assert.match(JS, /var ORP_SAVE_KEY = 'orp-state';/);
  assert.equal(JS.match(/localStorage\.\w+\(ORP_SAVE_KEY/g).length, 2, 'the one storage key');
  assert.deepEqual(Array.from(JS.matchAll(/localStorage\.\w+/g), (m) => m[0]).sort(), ['localStorage.getItem', 'localStorage.setItem']);
  for (const name of Object.keys(orp)) assert.match(name, /^orp[A-Z]/);
});

test('orphan-process: the files embed safely, load nothing from the network, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="orp-wrapper"'));
  assert.deepEqual(embedSafety(embedded), []);
  const bg = CSS.match(/--orp-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Orphan Process — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(|@font-face|data:image/, 'no network resources, no data URIs');
  }
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|Worker|Image)\b/, 'no network calls and no image files');
});

test('orphan-process: script.js is one strict IIFE in ES5 with the start-up guard', () => {
  assert.match(JS, /^(\/\/[^\n]*\n)*\n?\(function \(\) \{\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1);
  assert.equal(JS.match(/^\}\)\(\);/gm).length, 1);
  assert.match(JS, /if \(typeof module !== 'undefined' && module\.exports\) \{[\s\S]*\} else if \(document\.readyState === 'loading'\) \{\n\s+document\.addEventListener\('DOMContentLoaded', orpInit\);\n\s+\} else \{\n\s+orpInit\(\);/);
  const code = JS
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['nullish coalescing', /\?\?/], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['double-quoted string', /"/], ['async', /\basync\b|\bawait\b/],
    ['newer methods', /(?<!ctx)\.(padStart|padEnd|includes|find|findIndex|flat|flatMap|fill|assign|entries|values|repeat|startsWith|endsWith)\(/],
    ['Object.assign', /Object\.assign/], ['Array.from', /Array\.from/], ['Math.hypot / sign / trunc', /Math\.(hypot|sign|trunc)/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('orphan-process: index.html has a focusable, labelled canvas of 480x270, labelled buttons and the overlays in the stage', () => {
  const spec = htmlPageSpec(HTML);
  const canvas = spec['orp-canvas'];
  assert.equal(canvas.tagName, 'canvas');
  assert.deepEqual([canvas.width, canvas.height], [W, H]);
  assert.equal(canvas.attributes.tabindex, '0');
  assert.match(canvas.attributes['aria-label'], /arrows or A and D move, Up, W or Space jumps/);
  for (const id of ['orp-canvas', 'orp-msg', 'orp-start', 'orp-focus', 'orp-paused', 'orp-end']) assert.equal(spec[id].parent, 'orp-stage', id);
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
    }
  }
  assert.equal(spec['orp-continue'].disabled, true, 'Continue waits for a save');
  const back = spec['orp-back-tty'];
  assert.deepEqual([back.tagName, back.className, back.textContent], ['button', 'orp-btn orp-btn--secondary', 'Back to last tty']);
  assert.equal(back.attributes['aria-label'], 'Restart at the last tty, keeping everything collected');
  assert.equal(HTML.split('id="orp-back-tty"').length, 2, 'once');
  assert.ok(HTML.indexOf('id="orp-back-tty"') > HTML.indexOf('id="orp-resume"') && HTML.indexOf('id="orp-back-tty"') < HTML.indexOf('id="orp-end"'), 'in the pause overlay, after Resume');
  for (const id of ['orp-msg', 'orp-focus', 'orp-paused', 'orp-end', 'orp-warning']) assert.match(spec[id].className, /\borp-hidden\b/, id);
  assert.equal(spec['orp-start'].className, 'orp-overlay', 'the title screen shows first');
  assert.equal(spec['orp-msg'].attributes['aria-live'], 'polite');
  assert.equal(spec['orp-toast'].attributes['aria-live'], 'polite');
  assert.equal(spec['orp-warning'].attributes.role, 'alert');
  assert.equal(spec['orp-narrow'].textContent, 'Orphan Process needs a keyboard and a window at least 720 px wide.');
  assert.match(HTML, /To be continued: \/var\/log/);
});

// The canvas width for a viewport, as style.css lays it out.
const LAYOUT = cssRules(CSS);
const px = (value) => {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(String(value).trim());
  assert.ok(m, 'a px length: ' + value);
  return Number(m[1]);
};

test('orphan-process: from 320 to 1440 px nothing widens the page: the canvas is 960 px when there is room and scales down to the wrapper, and narrower windows get the notice', () => {
  const at = (selector, vw) => declsAt(LAYOUT, selector, vw);
  for (let vw = 320; vw <= 1440; vw++) {
    const wrapper = at('.orp-wrapper', vw);
    const side = px(wrapper.padding.split(/\s+/)[1]);
    const available = Math.min(vw, px(wrapper['max-width'])) - 2 * side;
    assert.ok(available > 0 && available <= vw, vw + 'px');
    assert.equal(at('.orp-wrapper *', vw)['box-sizing'], 'border-box');
    const narrow = vw < 720;
    assert.equal(at('.orp-game', vw).display, narrow ? 'none' : undefined, vw + 'px: the game');
    assert.equal(at('.orp-narrow', vw).display, narrow ? 'block' : 'none', vw + 'px: the notice');
    if (!narrow) {
      const stage = at('.orp-stage', vw);
      assert.equal(stage.width, '100%');
      const width = Math.min(available, px(stage['max-width']));
      assert.ok(width <= available);
      assert.equal(width, vw >= 1000 ? 960 : vw - 2 * side, vw + 'px');
    }
    assert.equal(at('.orp-narrow', vw)['overflow-wrap'], 'anywhere');
    // The title fits the column (a monospace glyph is about 0.6 em).
    const title = 'Orphan Process'.length * 0.62 * 16 * Number(/([\d.]+)rem/.exec(at('.orp-title', vw)['font-size'])[1]);
    assert.ok(title <= available, vw + 'px: the title is ' + title + 'px in ' + available);
  }
  assert.equal(px(declsAt(LAYOUT, '.orp-wrapper', 1440)['max-width']), 1000);
  const canvas = declsAt(LAYOUT, '.orp-canvas', 1280);
  assert.deepEqual([canvas.width, canvas.height, canvas.display, canvas['image-rendering']], ['100%', 'auto', 'block', 'pixelated']);
  assert.equal(declsAt(LAYOUT, '.orp-stage', 1280).position, 'relative');
  assert.equal(declsAt(LAYOUT, '.orp-stage', 1280).border, undefined, 'no border narrows the canvas');
  const overlay = declsAt(LAYOUT, '.orp-overlay', 1280);
  assert.deepEqual([overlay.position, overlay.top, overlay.right, overlay.bottom, overlay.left], ['absolute', '0', '0', '0', '0']);
  assert.equal(declsAt(LAYOUT, '.orp-overlay--focus', 1280)['pointer-events'], 'none', 'a click beside Click to play reaches the canvas');
  assert.equal(declsAt(LAYOUT, '.orp-overlay--focus .orp-btn', 1280)['pointer-events'], 'auto');
  assert.equal(declsAt(LAYOUT, '.orp-hidden', 320).display, 'none !important');
  const toast = declsAt(LAYOUT, '.orp-toast', 320);
  assert.deepEqual([toast.left, toast.right, toast.width, toast.margin], ['16px', '16px', 'fit-content', '0 auto']);
  assert.equal(declsAt(LAYOUT, '.orp-toast.orp-show', 320, { matchMedia: (q) => /prefers-reduced-motion/.test(q) }).animation, 'none');
  // Fullscreen: the script sizes the canvas inline; the stylesheet must not
  // pin it back to its 480 x 270 intrinsic size or let flex shrink it.
  const full = declsAt(LAYOUT, '.orp-stage:fullscreen .orp-canvas', 1280);
  assert.deepEqual([full.width, full.height, full.flex, full['max-width'], full['max-height']], [undefined, undefined, 'none', '100%', '100%']);
  assert.deepEqual([declsAt(LAYOUT, '.orp-stage:fullscreen', 1280).display, declsAt(LAYOUT, '.orp-stage:fullscreen', 1280)['justify-content']], ['flex', 'center']);
  // The guide: a row of sprites with its text wrapping beside them.  The widest row (the boss) leaves room for
  // text from 320 px up, the guide never hides with the game, and the key table wraps inside its columns.
  for (let vw = 320; vw <= 1440; vw++) {
    const at = (selector) => declsAt(LAYOUT, selector, vw);
    const wrapper = at('.orp-wrapper');
    const inner = Math.min(vw, px(wrapper['max-width'])) - 2 * px(wrapper.padding.split(/\s+/)[1]) -
      2 * px(at('.orp-help').padding.split(/\s+/)[1]) - 2;
    assert.deepEqual([at('.orp-guide-item').display, at('.orp-guide-pics').flex, at('.orp-guide-text')['min-width']], ['flex', 'none', '0'], vw + 'px');
    const boss = 2 * px(at('.orp-guide-sprite--boss').width) + px(at('.orp-guide-pics').gap) + px(at('.orp-guide-item').gap);
    assert.ok(inner - boss >= 100, vw + 'px: ' + (inner - boss) + 'px of text beside the boss');
    assert.equal(at('.orp-help').display, undefined, vw + 'px: the guide shows');
  }
  assert.deepEqual([px(declsAt(LAYOUT, '.orp-guide-sprite', 320).width), px(declsAt(LAYOUT, '.orp-guide-sprite', 320).height)], [32, 32]);
  assert.deepEqual([px(declsAt(LAYOUT, '.orp-guide-sprite--boss', 320).width), px(declsAt(LAYOUT, '.orp-guide-sprite--boss', 320).height)], [64, 64]);
  assert.equal(declsAt(LAYOUT, '.orp-guide-sprite', 320)['image-rendering'], 'pixelated');
  const keys = declsAt(LAYOUT, '.orp-guide-keys', 320);
  assert.deepEqual([keys.width, keys['table-layout']], ['100%', 'fixed']);
  assert.equal(declsAt(LAYOUT, '.orp-guide-keys td', 320)['overflow-wrap'], 'anywhere');
});

// ── The guide ────────────────────────────────────────────────────────────────

// The guide's text with the tags taken out and entities decoded, one space
// between words.
const GUIDE_HTML = HTML.slice(HTML.indexOf('<details id="orp-guide"'), HTML.indexOf('</details>'));
const GUIDE = GUIDE_HTML.replace(/<[^>]+>/g, ' ').replace(/&#8217;/g, '’').replace(/&#8220;/g, '“')
  .replace(/&#8221;/g, '”').replace(/\s+/g, ' ');
const GUIDE_SPRITES = Object.entries(htmlPageSpec(HTML)).filter(([, props]) => props.attributes && props.attributes['data-orp-sprite']);

test('orphan-process: the guide is open under the game (also on a narrow window) with every sprite it names, at its size, the two states of a thing side by side', () => {
  const spec = htmlPageSpec(HTML);
  assert.equal(spec['orp-guide'].tagName, 'details');
  assert.ok('open' in spec['orp-guide'].attributes, 'open by default');
  assert.equal(spec['orp-guide'].parent, undefined, 'outside the game, so the narrow notice does not hide it');
  assert.ok(HTML.indexOf('id="orp-guide"') > HTML.indexOf('</main>'));
  assert.ok(GUIDE_SPRITES.length >= 25);
  for (const [id, props] of GUIDE_SPRITES) {
    const name = props.attributes['data-orp-sprite'];
    assert.ok(orp.orpSprites[name], name + ' is a sprite');
    assert.equal(id, 'orp-guide-' + name);
    assert.equal(props.tagName, 'canvas');
    assert.equal(props.attributes['aria-hidden'], 'true', 'decoration only');
    const size = orp.orpSprites[name].length;
    assert.deepEqual([props.width, props.height], [size, size], name);
    assert.equal(props.className, size === 32 ? 'orp-guide-sprite orp-guide-sprite--boss' : 'orp-guide-sprite', name);
  }
  // Two states of one thing sit in one row.
  const rows = Array.from(GUIDE_HTML.matchAll(/<span class="orp-guide-pics">(.*?)<\/span>/g), (m) => Array.from(m[1].matchAll(/data-orp-sprite="([^"]+)"/g), (n) => n[1]).join(' '));
  for (const pair of ['capKill signal1', 'capNice heroDash', 'ttyOff ttyOn', 'switchOff switchOn gate', 'doorTop doorBottom', 'crate crateTemp', 'crumble crumble2', 'turret1 turretShot', 'bossIdle bossOpen']) {
    assert.ok(rows.includes(pair), pair);
  }
  for (const heading of ['Goal', 'Controls', 'The top bar, left to right', 'Capabilities', 'Things in the world', 'Enemies', 'The boss, tmpfiles.d', 'Levels and XP', 'Map, pause and saving', 'Secrets']) {
    assert.ok(GUIDE_HTML.includes('<h3 class="orp-guide-heading">' + heading + '</h3>'), heading);
  }
});

test('orphan-process: booting the page draws each guide sprite once from the atlas; a canvas naming no sprite stays blank', (t) => {
  makeClock(t);
  const made = watchCanvases(t);
  const page = createPage(htmlPageSpec(HTML));
  page.add('orp-guide-nope', { tagName: 'canvas', attributes: { 'data-orp-sprite': 'nope' } });
  const drawn = new Map();
  for (const [id] of GUIDE_SPRITES.concat([['orp-guide-nope']])) {
    const ctx = page.els[id].getContext('2d');
    drawn.set(id, []);
    ctx.drawImage = (src, sx, sy, sw, sh, dx, dy, dw, dh) => drawn.get(id).push({ src, name: SPRITE_AT.get(sx + ',' + sy), sw, sh, dx, dy, dw, dh });
  }
  const loaded = loadWithPage(SCRIPT, page, { keep: true });
  t.after(loaded.restore);
  loaded.exports.orpInit();
  for (const [id, props] of GUIDE_SPRITES) {
    const name = props.attributes['data-orp-sprite'];
    const size = orp.orpSprites[name].length;
    assert.deepEqual(drawn.get(id), [{ src: made[0], name, sw: size, sh: size, dx: 0, dy: 0, dw: size, dh: size }], id);
  }
  assert.deepEqual(drawn.get('orp-guide-nope'), []);
});

test('orphan-process: every number in the guide is the game\'s own: costs, cooldowns, distances, HP and XP, the sweep, crumbling tiles, the boss and the level rule', () => {
  const C = orp.orpConstants;
  const K = orp.orpKinds;
  const has = (text) => assert.ok(GUIDE.includes(text), 'the guide says: ' + text);
  // The top bar.
  has(`You start with ${C.START_RSS} chips.`);
  has(`you blink for ${C.INVULN} s and cannot be hurt`);
  has(`A signal costs ${C.SIGNAL_COST} CPU and a dash ${C.DASH_COST} CPU. It refills by ${C.CPU_REGEN} a second, up to its maximum (${C.START_CPU} at the start).`);
  has(`You start at nice ${C.START_NICE} and go one down with every level.`);
  has(`out of ${orp.orpMan.length}.`);
  has(`The bar empties over ${C.SWEEP_EVERY} seconds; in its last ${C.SWEEP_WARN} s the temporary crates blink, then they vanish for ${C.SWEEP_GONE} s`);
  // The capabilities.
  has(`sends a signal straight ahead for ${C.SIGNAL_RANGE / C.TILE} tiles. It costs ${C.SIGNAL_COST} CPU, and you can send one every ${C.SIGNAL_COOLDOWN} s.`);
  has(`C or K dashes ${C.DASH_SPEED * C.DASH_TIME / C.TILE} tiles in ${C.DASH_TIME} s`);
  has(`It costs ${C.DASH_COST} CPU, and the next dash can start ${C.DASH_COOLDOWN} s after the last one started.`);
  has(`crosses a gap of ${C.DASH_SPEED * C.DASH_TIME / C.TILE + 1} tiles`);
  // The world.
  has(`gives ${C.MAN_XP} XP and one true sentence about Linux. There are ${orp.orpMan.length};`);
  has(`Every ${['', '', '', 'third'][C.DROP_EVERY]} enemy you defeat drops one.`);
  has(`falls ${C.CRUMBLE_DELAY} s after you land on it and comes back ${C.CRUMBLE_BACK} s later.`);
  // The enemies.
  has(`Bug: ${K.bug.hp} HP, ${K.bug.xp} XP.`);
  has(`${K.daemon.hp} HP, ${K.daemon.xp} XP. Stands still and, every ${C.DAEMON_SPAWN} s while you are near, spawns a zombie, at most ${C.ZOMBIE_MAX} alive at once.`);
  has(`when you are within ${C.ZOMBIE_RANGE / C.TILE} tiles`);
  has(`it is reaped for ${K.zombie.xp} XP.`);
  has(`${K.turret.hp} HP, ${K.turret.xp} XP. Faces you and fires a slow straight shot every ${C.TURRET_EVERY} s`);
  // The boss.
  has(`until you are ${C.BOSS_WAKE / C.TILE} tiles in.`);
  has(`It has ${C.BOSS_HP} HP in three phases of ${C.BOSS_HP / C.BOSS_PHASES.length}`);
  assert.equal(C.BOSS_PHASES.length, 3);
  has(`the crates vanish for ${C.BOSS_GONE} s`);
  has(`the others ${C.FILE_SPACING} columns apart`);
  has(`Core open for ${C.BOSS_CORE} s: shoot it. Only the open core takes damage, at most one hit every ${C.BOSS_HIT_EVERY} s.`);
  has(`it rages for ${C.BOSS_RAGE} s.`);
  has(`Winning gives ${K.boss.xp} XP`);
  has(`taking it ends the episode ${C.END_DELAY} s later.`);
  // The level rule, against orpXpNeeded and a real level-up message.
  const first = orp.orpXpNeeded(C.START_NICE);
  const more = orp.orpXpNeeded(C.START_NICE - 1) - first;
  has(`The first level needs ${first} XP, and each next one ${more} more than the one before.`);
  assert.equal(orp.orpXpNeeded(C.START_NICE - 2) - orp.orpXpNeeded(C.START_NICE - 1), more);
  has(`Every level adds ${C.LEVEL_CPU} max CPU; every second level also adds 1 max RSS and refills RSS.`);
  const sim = orp.orpNewSim(Object.assign(orp.orpFreshProgress(), { xp: first - C.MAN_XP }));
  const bump = orp.orpStep(edit(sim, (s) => { s.ents = [{ type: 'man', id: 'man:fork', x: s.hero.x, y: s.hero.y, w: 10, h: 12, t: 0, face: 1 }]; }), IDLE);
  const level = bump.events.find((e) => e.type === 'msg' && /^nice /.test(e.title));
  has(`“${level.title}: ${level.text}”`);
  // Keys that need a capability.
  has('Until you own a capability, its keys only show “Operation not permitted”.');
});

// ── Sprites ──────────────────────────────────────────────────────────────────

test('orphan-process: the sprites are one delimited block of ASCII maps with one palette, every spec name at its size and nothing else', () => {
  assert.equal(JS.match(/\/\/ SPRITES BEGIN/g).length, 1);
  assert.equal(JS.match(/\/\/ SPRITES END/g).length, 1);
  const block = JS.slice(JS.indexOf('// SPRITES BEGIN'), JS.indexOf('// SPRITES END'));
  assert.match(block, /var ORP_PALETTE = \{/);
  assert.match(block, /var ORP_SPRITES = \{/);
  assert.doesNotMatch(block, /function|=>/, 'only data in the block');
  assert.deepEqual(Object.keys(orp.orpSprites).sort(), [...SPRITE_NAMES].sort());
  for (const [key, colour] of Object.entries(orp.orpPalette)) {
    assert.equal(key.length, 1, key);
    assert.notEqual(key, '.');
    assert.match(colour, /^#[0-9a-f]{6}$/, key);
  }
  assert.equal(orp.orpPalette.k, '#05080f', 'the dark outline');
  for (const name of SPRITE_NAMES) {
    const rows = orp.orpSprites[name];
    const size = BOSS_NAMES.includes(name) ? 32 : 16;
    assert.equal(rows.length, size, name);
    for (const row of rows) {
      assert.equal(row.length, size, name);
      for (const ch of row) assert.ok(ch === '.' || orp.orpPalette[ch], name + ': colour ' + ch);
    }
  }
});

// A canvas factory that keeps what putImageData wrote, so the atlas can be read.
function capturingCanvases(t) {
  const made = [];
  const original = document.createElement;
  t.mock.method(document, 'createElement', (tag) => {
    const el = original(tag);
    if (tag === 'canvas') {
      const ctx = el.getContext('2d');
      ctx.putImageData = (data) => { el.pixels = data; };
      made.push(el);
    }
    return el;
  });
  return made;
}

test('orphan-process: the atlas holds every sprite once in its own cell, pixel for pixel, and its mirrored copy flips each one in place', (t) => {
  const made = capturingCanvases(t);
  const art = orp.orpBuildAtlas();
  assert.equal(made.length, 2);
  const [image, flip] = made;
  assert.equal(art.image, image);
  assert.equal(art.flip, flip);
  assert.equal(image.width, 256);
  const cells = Object.entries(art.map);
  assert.deepEqual(cells.map(([name]) => name).sort(), [...SPRITE_NAMES].sort());
  for (const [name, cell] of cells) {
    assert.ok(cell.x + cell.w <= 256 && cell.y + cell.h <= image.height, name + ' inside the atlas');
    for (const [other, o] of cells) {
      if (other !== name) assert.ok(!(cell.x < o.x + o.w && o.x < cell.x + cell.w && cell.y < o.y + o.h && o.y < cell.y + cell.h), name + ' / ' + other);
    }
  }
  const pixel = (canvas, x, y) => Array.from(canvas.pixels.data.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (const name of ['heroRun1', 'bossOpen', 'signal1', 'switchOn']) {
    const cell = art.map[name];
    orp.orpSprites[name].forEach((row, j) => {
      for (let i = 0; i < cell.w; i++) {
        const ch = row[i];
        const want = ch === '.' ? [0, 0, 0, 0] : rgb(orp.orpPalette[ch]).concat(255);
        assert.deepEqual(pixel(image, cell.x + i, cell.y + j), want, name + ' ' + i + ',' + j);
        assert.deepEqual(pixel(flip, cell.x + cell.w - 1 - i, cell.y + j), want, name + ' mirrored');
      }
    });
  }
});

// ── Physics ──────────────────────────────────────────────────────────────────

test('orphan-process: the physics constants are the spec\'s, and the level design budget follows from them: a step up of 2 tiles and a gap of 3', () => {
  const c = orp.orpConstants;
  assert.deepEqual(
    [c.W, c.H, c.TILE, c.STEP, c.MAX_FRAME_MS, c.HERO_W, c.HERO_H, c.RUN, c.ACCEL_GROUND, c.ACCEL_AIR, c.GRAVITY, c.MAX_FALL, c.JUMP_SPEED, c.JUMP_CUT, c.COYOTE, c.BUFFER],
    [W, H, T, STEP, 250, HERO_W, HERO_H, RUN, ACCEL_GROUND, ACCEL_AIR, GRAVITY, MAX_FALL, JUMP, JUMP_CUT, COYOTE, BUFFER]
  );
  assert.deepEqual([c.INVULN, c.START_RSS, c.START_CPU, c.CPU_REGEN, c.START_NICE], [1, 5, 100, 20, 19]);
  assert.deepEqual([c.SIGNAL_SPEED, c.SIGNAL_RANGE, c.SIGNAL_COST, c.SIGNAL_COOLDOWN], [240, 8 * T, 10, 0.25]);
  assert.deepEqual([c.DASH_TIME, c.DASH_SPEED * c.DASH_TIME, c.DASH_COST, c.DASH_COOLDOWN], [0.2, 4 * T, 30, 0.5]);
  assert.deepEqual([c.CRUMBLE_DELAY, c.CRUMBLE_BACK, c.SWEEP_EVERY, c.SWEEP_GONE, c.ZOMBIE_RANGE, c.ZOMBIE_MAX, c.TURRET_EVERY],
    [0.4, 3, 20, 3, 8 * T, 3, 2]);
  // The apex of a full jump and the distance covered at full speed while in the air.
  const apex = JUMP * JUMP / (2 * GRAVITY);
  const air = 2 * JUMP / GRAVITY * RUN;
  assert.equal(apex, 40.5);
  assert.equal(Math.floor(apex / T), STEP_UP);
  assert.equal(Math.floor(air / T), GAP);
});

const STEP_UP = 2;
const GAP = 3;


// A walled room 32 wide with a floor at row 16 (the hero stands at row 15)
// and its tty at column 3.
const FLAT = ['#..T...........................#', '################################'];
const FLOOR_Y = 16 * T - HERO_H;

// Runs right from where the hero is, holds jump from x on, and stops once it
// is back on the ground.
function jumpFrom(sim, x, max = 400) {
  sim = runUntil(sim, { right: true }, (s) => s.hero.x >= x, max);
  sim = run(sim, { right: true, jump: true }, 2);
  return runUntil(sim, { right: true, jump: true }, (s) => s.hero.ground, max);
}

test('orphan-process: a full jump rises about 40 px, letting go early keeps 40 % of the upward speed, and a fall never passes 300 px/s', (t) => {
  const sim = settle(labSim(t, lab(FLAT)));
  assert.equal(sim.hero.ground, true);
  assert.equal(sim.hero.y, FLOOR_Y, 'feet on the floor');
  let held = run(sim, { jump: true }, 1);
  assert.equal(held.hero.vy, -JUMP + GRAVITY * STEP);
  let top = held.hero.y;
  for (let i = 0; i < 60; i++) {
    held = run(held, { jump: true }, 1);
    top = Math.min(top, held.hero.y);
  }
  const rise = FLOOR_Y - top;
  assert.ok(rise > 38 && rise <= 40.5, 'apex ' + rise);
  // Let go after three steps: the upward speed drops to 40 %, once.
  let cut = run(sim, { jump: true }, 3);
  const before = cut.hero.vy;
  cut = run(cut, {}, 1);
  assert.ok(Math.abs(cut.hero.vy - (before * JUMP_CUT + GRAVITY * STEP)) < 1e-9);
  let low = cut.hero.y;
  for (let i = 0; i < 40; i++) {
    cut = run(cut, {}, 1);
    low = Math.min(low, cut.hero.y);
  }
  assert.ok(FLOOR_Y - low < 12, 'a short hop: ' + (FLOOR_Y - low));
  // A long fall in a tall room: never faster than 300 px/s.
  const shaft = ['#'.repeat(32)].concat(Array.from({ length: 40 }, () => '#' + '.'.repeat(30) + '#'), ['#..T...........................#', '#'.repeat(32)]);
  withRooms(t, { shaft: { rows: shaft } });
  let fall = orp.orpNewSim(Object.assign(orp.orpFreshProgress(), { tty: 'shaft:3,41' }));
  fall = run(place(fall, 10, 2), {}, 150);
  assert.equal(fall.hero.vy, MAX_FALL);
  assert.equal(fall.hero.ground, false);
});

test('orphan-process: running reaches 96 px/s with 900 px/s2 on the ground and 600 in the air, and stops the same way', (t) => {
  let sim = settle(labSim(t, lab(FLAT)));
  sim = run(sim, { right: true }, 12);
  assert.ok(Math.abs(sim.hero.vx - ACCEL_GROUND * 12 * STEP) < 1e-9);
  assert.equal(sim.hero.face, 1);
  sim = run(sim, { right: true }, 60);
  assert.equal(sim.hero.vx, RUN);
  const x = sim.hero.x;
  sim = run(sim, { right: true }, 120);
  assert.ok(Math.abs(sim.hero.x - x - RUN) < 1e-6, 'one second at 96 px/s');
  sim = run(sim, {}, 6);
  assert.ok(Math.abs(sim.hero.vx - (RUN - ACCEL_GROUND * 6 * STEP)) < 1e-9);
  sim = run(sim, { left: true }, 60);
  assert.equal(sim.hero.vx, -RUN);
  assert.equal(sim.hero.face, -1);
  // In the air the hero changes speed more slowly.
  let air = run(settle(sim), { jump: true }, 2);
  assert.equal(air.hero.ground, false);
  air = run(air, { jump: true, right: true }, 6);
  assert.ok(Math.abs(air.hero.vx - ACCEL_AIR * 6 * STEP) < 1e-9);
});

test('orphan-process: coyote time allows a jump 0.08 s after leaving a ledge, and the jump buffer one pressed 0.1 s before landing', (t) => {
  const rows = lab(['#..T...........................#', '##########.....................#', '################################']);
  const ledge = place(settle(labSim(t, rows)), 8, 14);
  const off = runUntil(settle(ledge), { right: true }, (s) => !s.hero.ground);
  let late = run(off, { right: true }, Math.round(0.06 / STEP));
  late = run(late, { right: true, jump: true }, 1);
  assert.ok(late.hero.vy < -200, 'jumped within coyote time');
  let tooLate = run(off, { right: true }, Math.round(0.1 / STEP));
  tooLate = run(tooLate, { right: true, jump: true }, 1);
  assert.ok(tooLate.hero.vy > 0, 'too late: still falling');
  // A jump pressed just before landing fires on landing.
  const high = place(settle(labSim(t, lab(FLAT))), 10, 10);
  const falling = runUntil(high, {}, (s) => s.hero.y > FLOOR_Y - 18);
  let buffered = run(falling, { jump: true }, 1);
  buffered = runUntil(buffered, { jump: true }, (s) => s.hero.vy < 0, 30);
  assert.ok(buffered.hero.y > FLOOR_Y - 6, 'it jumped from the floor');
  let early = runUntil(high, {}, (s) => s.hero.y > FLOOR_Y - 50);
  early = run(early, { jump: true }, 1);
  early = run(early, {}, 40);
  assert.equal(early.hero.ground, true, 'pressed too early: no jump on landing');
  // Holding the jump key does not jump again.
  const held = run(settle(labSim(t, lab(FLAT))), { jump: true }, 120);
  assert.equal(held.hero.ground, true);
});

test('orphan-process: from a run the hero clears a 2-tile step and a 3-tile gap, but not a 3-tile step', (t) => {
  const step2 = lab(['#..T...........................#', '#.........##....................#', '#.........##....................#', '################################']);
  let sim = jumpFrom(place(settle(labSim(t, step2)), 2, 15), 7 * T);
  assert.equal(sim.hero.y, 14 * T - HERO_H, 'on top of the 2-tile step');
  const step3 = lab(['#..T...........................#', '#.........##....................#', '#.........##....................#', '#.........##....................#', '################################']);
  sim = jumpFrom(place(settle(labSim(t, step3)), 2, 15), 7 * T);
  assert.equal(sim.hero.y, FLOOR_Y, 'a 3-tile step stops it');
  assert.ok(sim.hero.x < 10 * T);
  const gap3 = lab(['#..T...........................#', '##########...###################', '################################']);
  sim = settle(labSim(t, gap3));
  sim = jumpFrom(place(sim, 2, 14), 9 * T + 2);
  assert.equal(sim.hero.y, 15 * T - HERO_H, 'landed beyond the gap, not in it');
  assert.ok(sim.hero.x > 13 * T - HERO_W);
});

test('orphan-process: one-way platforms are landed on from above, jumped through from below, and Down + jump drops through them', (t) => {
  const rows = lab(['#..T...........................#', '#...............................#', '#..........=====................#', '#...............................#', '################################']);
  let sim = settle(place(settle(labSim(t, rows)), 12, 15));
  sim = run(sim, { jump: true }, 40);
  sim = settle(sim);
  assert.equal(sim.hero.y, 14 * T - HERO_H, 'standing on the platform');
  const down = run(sim, { down: true }, 20);
  assert.equal(down.hero.y, sim.hero.y, 'Down alone does nothing');
  let drop = run(sim, { down: true, jump: true }, 2);
  drop = run(drop, {}, 40);
  assert.equal(drop.hero.y, FLOOR_Y, 'dropped back to the floor');
  const solid = run(drop, { down: true, jump: true }, 2);
  assert.ok(solid.hero.vy < 0, 'on solid ground Down + jump is a jump');
  // Under a solid ceiling the jump stops at it.
  const low = lab(['#..T...........................#', '#..........#####...............#', '#...............................#', '################################']);
  let bump = settle(place(settle(labSim(t, low)), 12, 15));
  const top = [];
  bump = run(bump, { jump: true }, 1);
  for (let i = 0; i < 20; i++) {
    bump = run(bump, { jump: true }, 1);
    top.push(bump.hero.y);
  }
  assert.ok(Math.min(...top) >= 15 * T && Math.min(...top) < 15 * T + 1, 'the head stops at the ceiling: ' + Math.min(...top));
  assert.ok(top[5] > top[0], 'and it falls back at once');
});

test('orphan-process: orpStep is pure: the state it gets is left as it was', (t) => {
  const sim = settle(labSim(t, lab(FLAT)));
  const before = JSON.stringify(sim);
  const next = orp.orpStep(sim, Object.assign({}, IDLE, { right: true, jump: true }));
  assert.equal(JSON.stringify(sim), before);
  assert.notEqual(next.hero, sim.hero);
  assert.ok(next.hero.x > sim.hero.x);
});

// ── Damage, death, stats ─────────────────────────────────────────────────────

test('orphan-process: a hit costs 1 RSS, knocks the hero away and makes it blink for 1 s; spikes also send it back to the last safe ground', (t) => {
  const rows = lab(['#..T...........................#', '##########^^^###################', '################################']);
  let sim = run(place(settle(labSim(t, rows)), 8, 14), {}, 30);
  assert.deepEqual([sim.hero.safeX, sim.hero.safeY], [8 * T + 3, 15 * T - HERO_H], 'safe ground');
  const events = [];
  sim = runUntil(sim, { right: true }, (s) => s.rss < 5, 200, events);
  assert.ok(types(events).includes('hurt'));
  assert.equal(sim.rss, 4);
  // Back where it last stood: the edge of the ledge.
  assert.equal(sim.hero.y, 15 * T - HERO_H);
  assert.ok(sim.hero.x > 9 * T - HERO_W && sim.hero.x < 10 * T, String(sim.hero.x));
  assert.deepEqual([sim.hero.vx, sim.hero.vy], [0, 0]);
  assert.ok(sim.hero.inv > 0.99);
  // While it blinks, spikes still send it back but cost nothing.
  let again = sim;
  let returns = 0;
  for (let i = 0; i < 90; i++) {
    const next = run(again, { right: true }, 1);
    if (next.hero.x < again.hero.x - 2) returns++;
    again = next;
  }
  assert.ok(returns >= 1, 'sent back again');
  assert.equal(again.rss, 4);
  // An enemy's touch knocks the hero away from it, without control for a moment.
  const bugRoom = lab(['#..T.......b...................#', '################################']);
  const hit = runUntil(settle(labSim(t, bugRoom)), { right: true }, (s) => s.rss < 5, 600);
  assert.ok(hit.hero.vx < 0 && hit.hero.vy < 0, 'knocked back up and away');
  assert.ok(hit.hero.knock > 0);
  assert.ok(run(hit, { right: true }, 10).hero.vx < 0, 'no control while knocked back');
});

test('orphan-process: at RSS 0 the process is killed and restarts at the last tty with full RSS, keeping what it collected', (t) => {
  const rows = lab(['#..T......m.....b...............#', '################################']);
  let sim = settle(place(labSim(t, rows, { def: { man: ['init'] }, prog: { maxRss: 6 } }), 6, 15));
  sim = edit(sim, (s) => { s.rss = 1; });
  const events = [];
  sim = runUntil(sim, { right: true }, (s) => s.mode === 'dead', 900, events);
  assert.deepEqual(messages(events), ['init(1)']);
  assert.ok(types(events).includes('death'));
  assert.equal(sim.prog.deaths, 1);
  assert.equal(sim.rss, 0);
  // Nothing moves while it is dead; then it restarts at the tty.
  const dead = run(sim, { right: true }, 60);
  assert.equal(dead.hero.x, sim.hero.x);
  assert.equal(dead.mode, 'dead');
  const back = runUntil(sim, {}, (s) => s.mode === 'play', 200, events);
  assert.ok(types(events).includes('respawn'));
  assert.equal(back.rss, 6);
  assert.equal(back.hero.x, 3 * T + 3);
  assert.deepEqual(back.prog.collected, ['man:init']);
  assert.ok(!back.ents.some((e) => e.type === 'man'), 'a collected page stays collected');
  assert.ok(back.ents.some((e) => e.type === 'bug'), 'enemies are back');
});

test('orphan-process: CPU refills 20 a second up to its maximum', (t) => {
  let sim = settle(labSim(t, lab(FLAT)));
  sim = run(edit(sim, (s) => { s.cpu = 10; }), {}, 120);
  assert.ok(Math.abs(sim.cpu - 30) < 1e-6);
  sim = run(sim, {}, 600);
  assert.equal(sim.cpu, 100);
});

test('orphan-process: XP lowers nice one level at a time: +10 max CPU each, +1 max RSS and a refill every second level', (t) => {
  assert.deepEqual([19, 18, 17, 12].map(orp.orpXpNeeded), [20, 30, 40, 90]);
  // Seven levels (nice 12) take 20 + 30 + ... + 80 = 350 XP: twelve man pages and about 30 enemies.
  let total = 0;
  for (let nice = 19; nice > 12; nice--) total += orp.orpXpNeeded(nice);
  assert.equal(total, 350);
  const rows = lab(['#..T..mmmm......................#', '################################']);
  let sim = settle(labSim(t, rows, { def: { man: ['kill', 'nice', 'ps', 'top'] } }));
  sim = edit(place(sim, 5, 15), (s) => { s.prog.xp = 15; s.rss = 2; });
  const events = [];
  sim = run(sim, { right: true }, 120, events);
  // 15 + 10 = 25: nice 18 (5 left); +10: 15; +10: 25; +10: 35 = nice 17 (5 left).
  assert.equal(sim.prog.nice, 17);
  assert.equal(sim.prog.xp, 5);
  assert.equal(sim.prog.maxCpu, 120);
  assert.equal(sim.prog.maxRss, 6);
  assert.equal(sim.rss, 6, 'refilled at the second level');
  assert.deepEqual(messages(events).filter((m) => /^nice -?\d+$/.test(m)), ['nice 18', 'nice 17']);
  assert.ok(events.some((e) => e.text === 'Max CPU 110.'));
  assert.ok(events.some((e) => e.text === 'Max CPU 120, max RSS 6, RSS refilled.'));
  // nice stops at -20, max CPU at 1000 and max RSS at 20.
  const room = lab(['#..T.m..........................#', '################################']);
  let last = settle(labSim(t, room, { def: { man: ['proc'] }, prog: { nice: -19, xp: 100000, maxRss: 20, maxCpu: 995 } }));
  last = run(last, { right: true }, 60);
  assert.equal(last.prog.nice, -20);
  assert.equal(last.prog.maxCpu, 1000);
  assert.equal(last.prog.maxRss, 20);
});

// ── Abilities ────────────────────────────────────────────────────────────────

test('orphan-process: kill sends a signal at 240 px/s for 8 tiles for 10 CPU with a 0.25 s cooldown, only with the capability', (t) => {
  const rows = lab(['#..T...........................#', '################################']);
  let sim = settle(labSim(t, rows));
  let none = run(sim, { shoot: true }, 1);
  assert.equal(none.sigs.length, 0, 'no capability, no signal');
  assert.equal(none.cpu, 100);
  sim = settle(labSim(t, rows, { prog: { abilities: ['kill'] } }));
  const shot = run(sim, { shoot: true }, 1);
  assert.equal(shot.sigs.length, 1);
  assert.equal(shot.cpu, 90);
  assert.equal(shot.sigs[0].x, sim.hero.x + HERO_W + 240 * STEP, 'from the hero\'s front, one step on');
  assert.equal(orp.orpHeroSprite(shot), 'heroShoot');
  // Held, it fires once; pressed again within the cooldown, not at all; after it, again.
  let held = run(shot, { shoot: true }, 20);
  assert.equal(held.sigs.length, 1);
  let quick = run(run(shot, {}, 10), { shoot: true }, 1);
  assert.equal(quick.sigs.length, 1, 'cooldown');
  quick = run(run(quick, {}, 20), { shoot: true }, 1);
  assert.equal(quick.sigs.length, 2, 'after 0.25 s');
  // It flies 8 tiles, then fades without a spark.
  let flight = shot;
  let steps = 1;
  while (flight.sigs.length) {
    flight = run(flight, {}, 1);
    steps++;
  }
  assert.equal(steps, Math.ceil(8 * T / (240 * STEP)));
  assert.equal(flight.fx.length, 0);
  // Facing left it leaves to the left; with less than 10 CPU nothing fires.
  const left = run(run(sim, { left: true }, 2), { left: true, shoot: true }, 1);
  assert.ok(left.sigs[0].vx < 0 && left.sigs[0].x < left.hero.x);
  const tired = run(edit(sim, (s) => { s.cpu = 9; }), { shoot: true }, 1);
  assert.equal(tired.sigs.length, 0);
});

test('orphan-process: a signal stops at walls with a spark, kills a bug for 5 XP, and turns a switch on for good, which opens the room\'s gates', (t) => {
  const rows = lab(['#..T.....b..#..s...G....#......#', '################################']);
  let sim = settle(labSim(t, rows, { prog: { abilities: ['kill'] } }));
  assert.equal(orp.orpSolid(sim, 19, 15), true, 'the gate is shut');
  assert.deepEqual([orp.orpTileSprite(sim, 15, 15), orp.orpTileSprite(sim, 19, 15)], ['switchOff', 'gate']);
  const events = [];
  sim = run(sim, { shoot: true }, 1, events);
  sim = runUntil(sim, {}, (s) => !s.ents.some((e) => e.type === 'bug'), 120, events);
  assert.equal(sim.prog.xp, 5);
  assert.ok(types(events).includes('save'));
  assert.ok(sim.fx.some((f) => f.k === 'spark'));
  // The next one stops at the wall at column 12.
  sim = run(run(sim, {}, 40), { shoot: true }, 1);
  sim = runUntil(sim, {}, (s) => s.sigs.length === 0, 120);
  assert.ok(sim.fx.some((f) => f.k === 'spark' && f.x > 10 * T && f.x < 12 * T));
  // Beyond the wall: the switch.
  let beyond = place(sim, 13, 15);
  beyond = edit(beyond, (s) => { s.hero.x = 13 * T + 3; s.hero.y = 15 * T - HERO_H - 32; });
  beyond = settle(place(beyond, 14, 15));
  const flips = [];
  beyond = run(beyond, { shoot: true }, 1, flips);
  beyond = runUntil(beyond, {}, (s) => s.sigs.length === 0, 60, flips);
  assert.deepEqual(beyond.prog.switches, ['lab:15,15']);
  assert.deepEqual(messages(flips), ['Switch on']);
  assert.equal(orp.orpSolid(beyond, 19, 15), false, 'the gate is open');
  assert.equal(orp.orpTileSprite(beyond, 15, 15), 'switchOn');
  assert.equal(orp.orpTileSprite(beyond, 19, 15), '');
  // Hit again it stays on, with no new message.
  const twice = [];
  beyond = run(run(beyond, {}, 40), { shoot: true }, 1, twice);
  beyond = runUntil(beyond, {}, (s) => s.sigs.length === 0, 60, twice);
  assert.deepEqual(beyond.prog.switches, ['lab:15,15']);
  assert.deepEqual(messages(twice), []);
});

test('orphan-process: nice dashes 4 tiles in 0.2 s without gravity for 30 CPU, breaks cracked walls for good, and stops at solid ones', (t) => {
  const rows = lab(['#..T.............x.......#.....#', '################################']);
  let sim = settle(labSim(t, rows));
  assert.equal(run(sim, { dash: true }, 1).hero.dash, 0, 'no capability, no dash');
  sim = settle(labSim(t, rows, { prog: { abilities: ['nice'] } }));
  let dash = run(sim, { dash: true }, 1);
  assert.equal(dash.cpu, 70);
  assert.equal(orp.orpHeroSprite(dash), 'heroDash');
  dash = run(dash, { dash: true }, 23);
  assert.ok(Math.abs(dash.hero.x - sim.hero.x - 4 * T) < 1e-6, '4 tiles in 0.2 s: ' + (dash.hero.x - sim.hero.x));
  assert.equal(dash.hero.y, sim.hero.y, 'no gravity');
  // The cooldown is 0.5 s from the start of the dash.
  assert.equal(run(dash, { dash: false }, 1).hero.dash, 0);
  let again = run(run(dash, {}, 30), { dash: true }, 1);
  assert.equal(again.hero.dash, 0, 'still cooling down');
  again = run(run(again, {}, 30), { dash: true }, 1);
  assert.ok(again.hero.dash > 0);
  // Not enough CPU: no dash.
  assert.equal(run(edit(sim, (s) => { s.cpu = 29; }), { dash: true }, 1).hero.dash, 0);
  // Into the cracked wall at column 17: it breaks and is saved; the dash goes on.
  const events = [];
  let wall = place(sim, 13, 15);
  wall = run(wall, { right: true }, 1);
  wall = run(wall, { right: true, dash: true }, 24, events);
  assert.deepEqual(wall.prog.walls, ['lab:17,15']);
  assert.ok(types(events).includes('save'));
  assert.ok(wall.hero.x > 17 * T);
  assert.equal(orp.orpTileSprite(wall, 17, 15), '');
  // Walking into a cracked wall does nothing; a dash into solid ground stops at it.
  const walk = run(place(sim, 15, 15), { right: true }, 60);
  assert.ok(walk.hero.x <= 17 * T - HERO_W);
  assert.equal(orp.orpTileSprite(walk, 17, 15), 'cracked');
  let solid = place(sim, 22, 15);
  solid = run(solid, { right: true, dash: true }, 2);
  solid = runUntil(solid, { right: true }, (s) => s.hero.dash === 0, 30);
  assert.equal(solid.hero.x, 25 * T - HERO_W, 'stopped at the wall');
});

test('orphan-process: a jump and a dash cross a 5-tile gap that a jump alone cannot', (t) => {
  const rows = lab(['#..T...........................#', '##########.....##################', '################################']);
  rows[15] = '##########.....#################';
  const start = settle(labSim(t, rows, { prog: { abilities: ['nice'] } }));
  const jumpOnly = jumpFrom(place(start, 2, 14), 9 * T + 2);
  assert.equal(jumpOnly.hero.y, 16 * T - HERO_H, 'fell into the gap');
  let both = runUntil(place(start, 2, 14), { right: true }, (s) => s.hero.x >= 9 * T + 2, 400);
  both = run(both, { right: true, jump: true }, 12);
  both = run(both, { right: true, jump: true, dash: true }, 1);
  both = runUntil(both, { right: true }, (s) => s.hero.ground, 200);
  assert.equal(both.hero.y, 15 * T - HERO_H, 'landed beyond the gap');
});

// The dash capability keeps its id nice (saves, code, sprite) but the player
// reads it as renice, so it is never taken for the nice level on the HUD.
test('orphan-process: the player reads the dash capability as renice and the shot as the kill capability; the nice level keeps its name', () => {
  assert.ok(HTML.includes('<tr><td>X or J</td><td>Send a signal. Needs the kill capability.</td></tr>'), 'the key table');
  assert.ok(HTML.includes('<tr><td>C or K</td><td>Dash. Needs the renice capability.</td></tr>'), 'the key table');
  assert.ok(HTML.includes('It is not the dash: the dash is the renice capability.'), 'NICE in the top bar is the level');
  assert.ok(HTML.includes('send kill signals, dash with renice,'), 'the page description');
  assert.ok(!/have nice|with nice|take nice/.test(HTML + JS), 'nowhere is the dash called nice');
  assert.equal(orp.orpMan.find((page) => page.key === 'nice').text, 'nice runs a program with an adjusted niceness, from -20 (most favourable) to 19 (least).');
});

// What a key without its capability does: one refusal per fresh press, and
// nothing else.  Without the press the state is the same but for the events.
function withoutEvents(sim) {
  const copy = JSON.parse(JSON.stringify(sim));
  delete copy.events;
  return copy;
}

test('orphan-process: X or J without kill, and C or K without renice, say so once per press (not while held) and change nothing else', (t) => {
  const rows = lab(['#..T.....b.....x...............#', '################################']);
  const sim = settle(labSim(t, rows));
  const cases = [
    ['shoot', 'kill: Operation not permitted', 'You do not have the kill capability yet.'],
    ['dash', 'renice: Operation not permitted', 'You do not have the renice capability yet.']
  ];
  for (const [key, title, text] of cases) {
    const events = [];
    let pressed = run(sim, { [key]: true }, 1, events);
    assert.deepEqual(events.filter((e) => e.type === 'msg'), [{ type: 'msg', title, text }], key);
    pressed = run(pressed, { [key]: true }, 60, events);
    assert.deepEqual(messages(events), [title], key + ' held: once');
    pressed = run(pressed, {}, 1, events);
    pressed = run(pressed, { [key]: true }, 1, events);
    assert.deepEqual(messages(events), [title, title], key + ' pressed again: again');
    // Apart from the message, the same game as without the presses: no CPU, no cooldown, no signal, no dash.
    const after = run(pressed, {}, 1);
    const still = run(sim, {}, 64);
    assert.deepEqual(withoutEvents(after), withoutEvents(still), key);
    assert.equal(after.cpu, 100);
  }
  // Both at once: both refusals, kill first.
  const both = [];
  run(sim, { shoot: true, dash: true }, 1, both);
  assert.deepEqual(messages(both), ['kill: Operation not permitted', 'renice: Operation not permitted']);
  // In mid-air and during a knock-back the press is still refused the same way.
  const air = [];
  run(edit(sim, (s) => { s.hero.knock = 0.1; s.hero.ground = false; }), { shoot: true, dash: true }, 1, air);
  assert.deepEqual(messages(air), ['kill: Operation not permitted', 'renice: Operation not permitted']);
});

test('orphan-process: with the capability a failed signal or dash (cooldown, too little CPU) stays silent', (t) => {
  const rows = lab(['#..T...........................#', '################################']);
  const sim = settle(labSim(t, rows, { prog: { abilities: ['kill', 'nice'] } }));
  const events = [];
  let s = run(sim, { shoot: true, dash: true }, 1, events);
  assert.equal(s.sigs.length, 1);
  assert.ok(s.hero.dash > 0);
  s = run(s, {}, 1, events);
  s = run(s, { shoot: true, dash: true }, 1, events);
  run(edit(sim, (x) => { x.cpu = 5; }), { shoot: true, dash: true }, 1, events);
  run(edit(sim, (x) => { x.hero.knock = 0.1; }), { shoot: true, dash: true }, 1, events);
  assert.deepEqual(messages(events), []);
  // Only one of them owned: only the other is refused.
  const one = [];
  run(settle(labSim(t, rows, { prog: { abilities: ['kill'] } })), { shoot: true, dash: true }, 1, one);
  assert.deepEqual(messages(one), ['renice: Operation not permitted']);
});

// ── Enemies ──────────────────────────────────────────────────────────────────

test('orphan-process: a bug walks the floor at 30 px/s and turns at walls and ledges', (t) => {
  const rows = lab(['#...........b..................#', '#..........#########...........#', '#..............................#', '#..............................#', '#..T.............b.......#.....#', '################################']);
  let sim = edit(settle(labSim(t, rows)), (s) => { s.hero.inv = 1e9; });
  const bugs = () => sim.ents.filter((e) => e.type === 'bug');
  const start = bugs()[1].x;
  sim = run(sim, {}, 120);
  assert.ok(Math.abs(start - bugs()[1].x - 30) < 0.5, 'one second at 30 px/s: ' + (start - bugs()[1].x));
  const seen = bugs().map(() => ({ min: Infinity, max: -Infinity }));
  for (let i = 0; i < 2400; i++) {
    sim = run(sim, {}, 1);
    bugs().forEach((b, n) => {
      seen[n].min = Math.min(seen[n].min, b.x);
      seen[n].max = Math.max(seen[n].max, b.x);
    });
  }
  // The bug on the island (columns 11-19) stays on it; the one on the floor turns at the walls.
  const island = seen.find((s) => s.max < 21 * T);
  assert.ok(island.min >= 11 * T - 1 && island.max <= 20 * T - 12, JSON.stringify(island));
  assert.ok(island.max - island.min > 5 * T, 'it walks to both ends');
  const floor = seen.find((s) => s !== island);
  assert.ok(floor.min >= T && floor.max <= 26 * T - 12, JSON.stringify(floor));
  assert.equal(orp.orpKinds.bug.look(sim, { t: 0 }), 'bug1');
  assert.equal(orp.orpKinds.bug.look(sim, { t: 0.25 }), 'bug2');
});

test('orphan-process: a leaky daemon spawns up to 3 zombies while the hero is near; zombies float toward the hero through walls, and signals pass through them', (t) => {
  const rows = lab(['#..T................#.....L....#', '################################']);
  let sim = settle(labSim(t, rows, { prog: { abilities: ['kill'] } }));
  const zombies = (s) => s.ents.filter((e) => e.type === 'zombie');
  // Far away (more than 12 tiles): nothing.
  sim = run(sim, {}, 600);
  assert.equal(zombies(sim).length, 0);
  // Near: one zombie after the first second, then one every 3 s, never more than 3.
  let near = place(sim, 16, 15);
  near = edit(near, (s) => { s.ents.find((e) => e.type === 'daemon').cd = 0.5; s.hero.inv = 1e9; });
  near = run(near, {}, 120);
  assert.equal(zombies(near).length, 1);
  assert.equal(zombies(near)[0].parent, 'lab:26,15');
  near = run(near, {}, 360);
  assert.equal(zombies(near).length, 2);
  near = run(near, {}, 1200);
  assert.equal(zombies(near).length, 3);
  // They float toward the hero, through the wall at column 20.
  near = run(edit(near, (s) => { s.hero.x = 19 * T + 3; }), {}, 400);
  const closing = zombies(near).map((z) => z.x);
  assert.ok(closing.every((x) => x < 22 * T), 'through the wall: ' + closing);
  // A zombie touching the hero hurts it.
  const touch = edit(near, (s) => { s.hero.inv = 0; });
  const hurt = runUntil(touch, {}, (s) => s.rss < 5, 600);
  assert.equal(hurt.rss, 4);
  // Out of range (8 tiles) a zombie stays where it is.
  const far = edit(near, (s) => { s.hero.x = 3 * T; });
  const z0 = zombies(far)[0];
  const later = run(far, {}, 60);
  const z1 = later.ents.find((e) => e.id === z0.id);
  assert.ok(Math.abs(z1.x - z0.x) < 1e-9 || Math.hypot(z0.x - 3 * T, z0.y - far.hero.y) < 8 * T);
  // A signal passes through zombies (they cannot be killed).
  const zombie = { id: 'z', type: 'zombie', x: 8 * T, y: 15 * T - 13, w: 12, h: 13, vx: 0, vy: 0, hp: 0, face: -1, t: 0, flash: 0, cd: 0, parent: 'none' };
  let lane = settle(place(sim, 4, 15));
  lane = edit(lane, (s) => { s.ents.push(zombie); s.hero.inv = 1e9; });
  lane = run(lane, { shoot: true }, 1);
  lane = run(lane, {}, 45);
  assert.ok(lane.sigs.length === 1 && lane.sigs[0].x > 10 * T, 'through the zombie');
  assert.ok(lane.ents.some((e) => e.id === 'z'));
  // A zombie on the hero's left turns right toward it.
  const behind = run(edit(lane, (s) => { s.ents = [Object.assign({}, zombie, { x: 1 * T + 2 })]; }), {}, 2);
  assert.equal(behind.ents[0].face, 1);
});

test('orphan-process: killing a daemon (3 hits) reaps all its zombies for XP; every third defeat drops a chip that heals 1 RSS', (t) => {
  const rows = lab(['#..T................L...........#', '################################']);
  let sim = settle(labSim(t, rows, { prog: { abilities: ['kill'] } }));
  sim = edit(place(sim, 12, 15), (s) => { s.hero.inv = 1e9; });
  sim = run(sim, {}, 120 * 7.5);
  assert.equal(sim.ents.filter((e) => e.type === 'zombie').length, 3);
  // Push the zombies away so they do not touch the hero, then three signals.
  sim = edit(sim, (s) => { s.ents.filter((e) => e.type === 'zombie').forEach((z, i) => { z.x = 25 * T + i * 12; z.y = 9 * T; }); s.hero.x = 12 * T + 3; s.hero.face = 1; s.kills = 2; s.rss = 3; s.hero.inv = 0; });
  const events = [];
  for (let i = 0; i < 3; i++) {
    sim = run(run(sim, {}, 31, events), { shoot: true }, 1, events);
    sim = runUntil(sim, {}, (s) => s.sigs.length === 0, 120, events);
    const daemon = sim.ents.find((e) => e.type === 'daemon');
    if (i < 2) {
      assert.equal(daemon.hp, 2 - i);
      assert.equal(orp.orpKinds.daemon.look(sim, daemon), 'daemonHurt');
    }
  }
  assert.ok(!sim.ents.some((e) => e.type === 'daemon' || e.type === 'zombie'), 'the daemon and its zombies are gone');
  assert.equal(sim.prog.xp + orp.orpXpNeeded(19), 15 + 3 * 2, 'nice 18: 15 for the daemon, 2 for each zombie');
  assert.equal(sim.prog.nice, 18);
  assert.ok(sim.fx.some((f) => f.k === 'reap'));
  // The third defeat dropped a chip; walking into it heals 1.
  const chip = sim.ents.find((e) => e.type === 'chip');
  assert.ok(chip && chip.id.startsWith('drop#'));
  sim = runUntil(sim, { right: true }, (s) => !s.ents.some((e) => e.type === 'chip'), 300);
  assert.equal(sim.rss, 4);
  assert.ok(!sim.prog.collected.includes(chip.id), 'a dropped chip is not a collectible');
  assert.equal(orp.orpKinds.daemon.look(sim, { t: 0, flash: 0 }), 'daemon1');
});

test('orphan-process: a lockfile turret fires a slow straight shot toward the hero every 2 s; shots stop at walls and hurt; 2 hits destroy it', (t) => {
  const rows = lab(['#..T.....#...........K..........#', '################################']);
  rows[15] = '#..T.....#...........K.........#';
  let sim = settle(labSim(t, rows, { prog: { abilities: ['kill'] } }));
  const shots = (s) => s.ents.filter((e) => e.type === 'shot');
  const turret = (s) => s.ents.find((e) => e.type === 'turret');
  assert.equal(orp.orpKinds.turret.look(sim, turret(sim)), 'turret1');
  sim = run(sim, {}, 80);
  assert.equal(shots(sim).length, 0);
  assert.equal(orp.orpKinds.turret.look(sim, turret(sim)), 'turret2', 'about to fire');
  sim = run(sim, {}, 12);
  assert.equal(shots(sim).length, 1);
  assert.equal(shots(sim)[0].vx, -80, 'toward the hero on its left');
  sim = run(sim, {}, 240);
  assert.equal(shots(sim).length, 2, 'every 2 s');
  // A shot stops at the wall at column 9.
  sim = runUntil(sim, {}, (s) => shots(s).length === 1 && shots(s)[0].x > 15 * T, 600);
  // Toward the hero on its right.
  let right = place(sim, 27, 15);
  right = runUntil(right, {}, (s) => shots(s).some((e) => e.vx > 0), 300);
  // A shot that reaches the hero hurts it and vanishes.
  const hit = runUntil(right, {}, (s) => s.rss < 5, 300);
  assert.ok(!shots(hit).some((e) => e.vx > 0));
  // Two signals destroy it.
  let fight = edit(place(sim, 14, 15), (s) => { s.hero.inv = 1e9; });
  fight = run(fight, { shoot: true }, 1);
  fight = runUntil(fight, {}, (s) => s.sigs.length === 0, 120);
  assert.equal(turret(fight).hp, 1);
  assert.equal(orp.orpKinds.turret.look(fight, Object.assign({}, turret(fight), { flash: 0.1, cd: 1 })), 'turret2');
  fight = run(run(fight, {}, 31), { shoot: true }, 1);
  fight = runUntil(fight, {}, (s) => s.sigs.length === 0, 120);
  assert.equal(turret(fight), undefined);
  assert.equal(fight.prog.xp, 10);
  // A shot lives at most 6 s.
  const lone = { id: 's', type: 'shot', x: 12 * T, y: 9 * T, w: 6, h: 6, vx: 0, vy: 0, hp: 0, face: 1, t: 0, flash: 0, cd: 0, parent: '' };
  const aged = run(edit(fight, (s) => { s.ents = [lone]; }), {}, 6 * 120 + 2);
  assert.equal(aged.ents.length, 0);
  assert.equal(orp.orpKinds.shot.look(), 'turretShot');
});

// ── Hazards ──────────────────────────────────────────────────────────────────

test('orphan-process: a crumbling tile falls 0.4 s after the hero lands on it and comes back after 3 s, but not into the hero', (t) => {
  const rows = lab(['#..T...........................#', '##########%%%###################', '#.........^^^..................#', '################################']);
  rows[16] = '################################';
  let sim = settle(labSim(t, rows));
  sim = settle(place(sim, 11, 13));
  assert.ok(sim.crumble['11,14'], 'the tile under the hero is going');
  assert.equal(orp.orpTileSprite(sim, 11, 14), 'crumble2');
  assert.equal(orp.orpTileSprite(sim, 10, 14), 'crumble');
  sim = edit(sim, (s) => { s.crumble['11,14'].t = 0; });
  sim = run(sim, {}, Math.round(0.4 / STEP) - 1);
  assert.equal(orp.orpSolid(sim, 11, 14), true);
  sim = run(sim, {}, 2);
  assert.equal(orp.orpSolid(sim, 11, 14), false);
  assert.equal(orp.orpTileSprite(sim, 11, 14), '');
  // The hero falls onto the spikes and is sent back; the tile returns after 3 s.
  sim = run(sim, {}, 3 * 120 + 2);
  assert.equal(orp.orpSolid(sim, 11, 14), true);
  // A hero standing in its place keeps it away until it leaves.
  const rows2 = rows.slice();
  rows2[10] = '#...................%..........#';
  rows2[11] = '#...................#..........#';
  withRooms(t, { cave: { rows: rows2 } });
  let cave = orp.orpNewSim(Object.assign(orp.orpFreshProgress(), { tty: 'cave:3,13' }));
  cave = edit(cave, (s) => { s.crumble = { '20,10': { x: 20, y: 10, t: 2.9, down: true } }; s.hero.x = 20 * T + 3; s.hero.y = 10 * T; s.hero.vy = 0; });
  cave = run(cave, {}, 1);
  cave = edit(cave, (s) => { s.hero.x = 20 * T + 3; s.hero.y = 10 * T; s.hero.vy = 0; });
  cave = run(cave, {}, 20);
  assert.ok(cave.crumble['20,10'], 'not back while the hero is in its place');
});

test('orphan-process: in /tmp the cleanup sweep deletes every temporary crate for 3 s every 20 s, after they blink for 1 s; a crate that comes back lifts the hero onto it, or onto its pile', (t) => {
  const rows = lab(['#..T...........................#', '########ttttt###################', '#.......................#########', '################################']);
  let sim = settle(labSim(t, rows, { def: { area: 'tmp' } }));
  assert.equal(sim.sweep > 0, true);
  sim = place(sim, 10, 13);
  sim = settle(edit(sim, (s) => { s.sweep = 0; }));
  const events = [];
  sim = run(sim, {}, Math.round(19 / STEP) - 32, events);
  assert.equal(sim.warn, false);
  assert.equal(orp.orpTileSprite(sim, 10, 14), 'crateTemp');
  // The last second they blink (the HUD bar counts down too).
  const looks = new Set();
  for (let i = 0; i < 120; i++) {
    sim = run(sim, {}, 1, events);
    looks.add(orp.orpTileSprite(sim, 10, 14));
  }
  assert.equal(sim.warn, true);
  assert.deepEqual([...looks].sort(), ['', 'crateTemp']);
  assert.equal(sim.swept, false);
  sim = run(sim, {}, 3, events);
  assert.equal(sim.warn, false);
  assert.equal(sim.swept, true);
  assert.deepEqual(events.filter((e) => e.type === 'sweep'), [{ gone: true, type: 'sweep' }]);
  assert.equal(orp.orpSolid(sim, 10, 14), false);
  assert.equal(orp.orpTileSprite(sim, 10, 14), '');
  sim = run(sim, {}, 60);
  assert.equal(sim.hero.y, 16 * T - HERO_H, 'fell through to the floor below');
  // Back after 3 s, with the hero inside one: it stands on top.
  sim = run(sim, {}, Math.round(3 / STEP) - 63, events);
  assert.equal(sim.swept, true);
  sim = edit(sim, (s) => { s.hero.y = 14 * T + 4; s.hero.vy = 0; });
  sim = run(sim, {}, 4, events);
  assert.equal(sim.swept, false);
  assert.deepEqual(events.filter((e) => e.type === 'sweep').map((e) => e.gone), [true, false]);
  assert.equal(sim.hero.y, 14 * T - HERO_H, 'lifted onto the crate that came back');
  // In /home there is no sweep.
  const home = run(settle(labSim(t, rows)), {}, Math.round(25 / STEP));
  assert.equal(home.sweep, 0);
  assert.equal(home.swept, false);
  // Inside the lower crate of a pile when they come back: on top of the pile.
  const pile = lab(['#.........t.....................#', '#..T......t.....................#', '################################']);
  let piled = settle(labSim(t, pile, { def: { area: 'tmp' } }));
  piled = edit(piled, (s) => { s.sweep = 22.9; s.swept = true; s.hero.x = 10 * T + 3; s.hero.y = 16 * T - HERO_H; s.hero.vy = 0; });
  piled = runUntil(piled, {}, (s) => !s.swept, 30);
  assert.equal(piled.hero.y, 14 * T - HERO_H);
});

test('orphan-process: the r-- door is solid and says Permission denied at most every 2 s; the end trigger ends the episode', (t) => {
  const rows = lab(['#..T.......D...........E.......#', '#..........D....................#', '################################']);
  rows[14] = '#..........D....................#';
  rows[15] = '#..T.......D...........E........#';
  let sim = settle(labSim(t, rows));
  assert.equal(orp.orpTileSprite(sim, 11, 14), 'doorTop');
  assert.equal(orp.orpTileSprite(sim, 11, 15), 'doorBottom');
  const events = [];
  sim = run(sim, { right: true }, 240, events);
  assert.deepEqual(messages(events), ['Permission denied']);
  assert.equal(sim.hero.x, 11 * T - HERO_W, 'the door holds');
  sim = run(sim, { right: true }, 240, events);
  assert.deepEqual(messages(events), ['Permission denied', 'Permission denied']);
  // The end trigger.
  let end = place(sim, 20, 15);
  const ends = [];
  end = runUntil(end, { right: true }, (s) => s.mode === 'end', 200, ends);
  assert.deepEqual(types(ends).slice(-2), ['end', 'save']);
  const frozen = run(end, { left: true }, 30);
  assert.equal(frozen.hero.x, end.hero.x);
  assert.equal(frozen.mode, 'end');
});

// ── Pickups and checkpoints ──────────────────────────────────────────────────

test('orphan-process: man pages, memory modules and both capability pedestals are collected for good with their messages; chips heal 1 RSS', (t) => {
  const rows = lab(['#..T.m.h.M.k.n.h................#', '################################']);
  rows[15] = '#..T.m.h.M.k.n.h...............#';
  // The nice pedestal is only there once the boss is down.
  assert.ok(!settle(labSim(t, rows, { def: { man: ['signal'] } })).ents.some((e) => e.type === 'capNice'));
  let sim = settle(labSim(t, rows, { def: { man: ['signal'] }, prog: { boss: true } }));
  sim = edit(place(sim, 4, 15), (s) => { s.rss = 3; });
  const events = [];
  sim = run(sim, { right: true }, 300, events);
  assert.deepEqual(messages(events), ['signal(7)', 'Memory module', 'Capability: kill', 'Capability: renice']);
  assert.equal(events.find((e) => e.title === 'signal(7)').text, 'SIGKILL and SIGSTOP cannot be caught, blocked or ignored.');
  assert.equal(events.find((e) => e.title === 'Capability: renice').text, 'C or K dashes 4 tiles: 30 CPU, no gravity, and it breaks cracked walls.');
  assert.deepEqual(sim.prog.collected, ['man:signal', 'lab:9,15', 'lab:11,15', 'lab:13,15']);
  assert.deepEqual(sim.prog.abilities, ['kill', 'nice']);
  assert.equal(sim.prog.maxRss, 6);
  assert.equal(sim.rss, 6, '3 + chip + module + chip');
  assert.equal(sim.prog.xp, 10);
  assert.equal(sim.ents.filter((e) => e.type !== 'tty').length, 0);
  assert.ok(sim.endT > 0 && sim.mode === 'play', 'nice ends the episode a moment later');
  // Chips never heal past the maximum.
  const full = edit(place(settle(labSim(t, rows, { def: { man: ['signal'] } })), 6, 15), (s) => { s.rss = 5; });
  assert.equal(run(full, { right: true }, 20).rss, 5);
});

test('orphan-process: a tty saves, refills RSS and lights up; touching it again with full RSS does nothing', (t) => {
  const rows = lab(['#..T..............T.............#', '################################']);
  rows[15] = '#..T..............T............#';
  let sim = settle(labSim(t, rows));
  assert.equal(orp.orpKinds.tty.look(sim, sim.ents[0]), 'ttyOn');
  assert.equal(orp.orpKinds.tty.look(sim, sim.ents[1]), 'ttyOff');
  sim = edit(sim, (s) => { s.rss = 2; });
  const events = [];
  sim = run(sim, {}, 2, events);
  assert.equal(sim.rss, 5, 'the same tty refills');
  assert.deepEqual(types(events), ['save']);
  sim = edit(sim, (s) => { s.rss = 2; });
  events.length = 0;
  sim = runUntil(sim, { right: true }, (s) => s.prog.tty === 'lab:18,15', 400, events);
  assert.deepEqual(messages(events), ['tty']);
  assert.equal(sim.rss, 5);
  events.length = 0;
  sim = run(sim, { right: true }, 20, events);
  assert.deepEqual(events, []);
});

// ── Rooms ────────────────────────────────────────────────────────────────────

const LEGEND = '.#=^%xctGDsE@TmhMknbLKB';
const ENTITY_LETTERS = { b: 'bug', L: 'daemon', K: 'turret', T: 'tty', m: 'man', h: 'chip', M: 'module', k: 'capKill', n: 'capNice', B: 'boss' };

test('orphan-process: a room map reads by the legend: entity letters and exit digits become air, exits know their edge, items and ids follow the tiles', (t) => {
  withRooms(t, { north: { rows: ['##1##', '#@.T#', '#.mk#', '2.M.#', '#####'], man: ['top'] } });
  const data = orp.orpParseRoom('north', orp.orpRooms.north);
  assert.deepEqual(data.tiles, ['##.##', '#...#', '#...#', '....#', '#####']);
  assert.deepEqual([data.w, data.h, data.start], [5, 5, [1, 1]]);
  assert.deepEqual(data.spawns, [
    { type: 'tty', x: 3, y: 1, id: 'north:3,1' },
    { type: 'man', x: 2, y: 2, id: 'man:top' },
    { type: 'capKill', x: 3, y: 2, id: 'north:3,2' },
    { type: 'module', x: 2, y: 3, id: 'north:2,3' }
  ]);
  assert.deepEqual(data.items, ['man:top', 'north:3,2', 'north:2,3']);
  assert.deepEqual(data.ttys, ['north:3,1']);
  assert.deepEqual(data.exits['1'], { edge: 'north', x: 2, y: 0, cells: [[2, 0]] });
  assert.equal(data.exits['2'].edge, 'west');
  withRooms(t, { edges: { rows: ['#####', '#.s.1', '#.x.#', '#.G.#', '##3##'] } });
  const edges = orp.orpParseRoom('edges', orp.orpRooms.edges);
  assert.deepEqual([edges.exits['1'].edge, edges.exits['3'].edge], ['east', 'south']);
  assert.deepEqual([edges.switches, edges.walls], [['edges:2,1'], ['edges:2,2']]);
  // Outside the map, a lookup reads the nearest edge tile.
  assert.equal(orp.orpTile('edges', -3, 1), '#');
  assert.equal(orp.orpTile('edges', 9, 1), '.', 'beyond an exit opening: air');
  assert.equal(orp.orpTile('edges', 2, 40), '.');
});

// The rooms of episode 1 in the order of the game (a side room after the
// room it opens from), the way through without the side rooms, and the
// rooms of /home.
const WORLD = ['home', 'config', 'cache', 'ssh', 'docs', 'downloads', 'bin', 'gate', 'tmp', 'tmpx', 'x11', 'sysd', 'sess', 'ttyr', 'arena'];
const ROUTE = ['home', 'config', 'cache', 'docs', 'downloads', 'gate', 'tmp', 'tmpx', 'x11', 'sysd', 'ttyr', 'arena'];
const HOME = WORLD.slice(0, 8);

// Every tile of room key that is one of chars: [{ ch, x, y }].
function lettersOf(key, chars) {
  const out = [];
  orp.orpRooms[key].rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (chars.includes(ch)) out.push({ ch, x, y });
  }));
  return out;
}

test('orphan-process: the world is well formed: 15 rooms bigger than a screen (the arena\'s fight one screen), closed edges, exits that match both ways, map boxes apart, every legend letter used', () => {
  assert.deepEqual(Object.keys(orp.orpRooms), WORLD);
  const used = new Set();
  const manKeys = [];
  const mapAt = new Set();
  for (const key of WORLD) {
    const def = orp.orpRooms[key];
    const rows = def.rows;
    const w = rows[0].length;
    const h = rows.length;
    assert.ok(w >= W / T && h >= Math.ceil(H / T) && w <= 90 && h <= 45, key + ' is ' + w + 'x' + h);
    if (key === 'arena') {
      assert.equal((def.arena[1] - def.arena[0] + 3) * T, W, 'the fight, walls included, is one screen wide');
      assert.equal(h, Math.ceil(H / T), 'and one screen high');
    } else {
      assert.ok(w >= 40 || h >= 25, key + ' is bigger than a screen');
    }
    rows.forEach((row, y) => {
      assert.equal(row.length, w, key);
      [...row].forEach((ch, x) => {
        assert.ok(LEGEND.includes(ch) || /[1-9]/.test(ch), key + ': ' + ch);
        used.add(ch);
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) assert.match(ch, /[#1-9]/, key + ' edge ' + x + ',' + y);
      });
    });
    assert.ok(orp.orpAreas[def.area], key + ': area');
    assert.equal(def.area, HOME.includes(key) ? 'home' : 'tmp', key);
    assert.match(def.title, new RegExp('^/' + def.area));
    assert.equal(rows.join('').split('m').length - 1, def.man.length, key + ': one key per man page');
    manKeys.push(...def.man);
    const [col, row, cols = 1, high = 1] = def.map;
    for (let c = col; c < col + cols; c++) {
      for (let r = row; r < row + high; r++) {
        assert.ok(!mapAt.has(c + ',' + r), key + ': its own map cell ' + c + ',' + r);
        mapAt.add(c + ',' + r);
      }
    }
    assert.ok(20 + (col + cols) * 64 - 8 <= W && 48 + (row + high) * 36 - 8 < H - 36, key + ': its box fits the map screen');
    const data = orp.orpRoom(key);
    for (const [digit, [to, back]] of Object.entries(def.exits)) {
      const other = orp.orpRoom(to);
      assert.ok(other.exits[back], key + ' ' + digit + ' -> ' + to + ' ' + back);
      assert.deepEqual(orp.orpRooms[to].exits[back], [key, digit], 'leads back');
      assert.equal(other.exits[back].cells.length, data.exits[digit].cells.length, 'openings of one length');
      const pair = [data.exits[digit].edge, other.exits[back].edge].sort().join('-');
      assert.ok(pair === 'east-west' || pair === 'north-south', pair);
    }
    assert.deepEqual(Object.keys(data.exits).sort(), Object.keys(def.exits).sort(), key + ': every opening is linked');
  }
  assert.equal(new Set(manKeys).size, 12, 'each of the 12 man pages once');
  assert.deepEqual([...manKeys].sort(), orp.orpMan.map((page) => page.key).sort());
  for (const ch of LEGEND) assert.ok(used.has(ch), 'the world uses ' + ch);
  const count = (ch) => WORLD.reduce((n, key) => n + lettersOf(key, ch).length, 0);
  assert.deepEqual(['@', 'k', 'n', 'B', 'E', 'M', 'm', 's', 'D'].map(count), [1, 1, 1, 1, 1, 2, 12, 1, 2]);
  assert.deepEqual(lettersOf('docs', 'k').length + lettersOf('arena', 'nBE').length + lettersOf('ssh', 'D').length, 6,
    'kill in Documents, the boss, nice and the way onward in the arena, the r-- door in .ssh');
  assert.deepEqual([lettersOf('bin', 'M').length, lettersOf('sess', 'M').length], [1, 1], 'a memory module in .local/bin and one in sess_');
  assert.equal(orp.orpMan.length, 12);
  assert.deepEqual(orp.orpMan.map((page) => page.title), ['kill(1)', 'nice(1)', 'ps(1)', 'tmpfiles.d(5)', 'chmod(1)', 'tty(4)',
    'fork(2)', 'signal(7)', 'init(1)', 'proc(5)', 'nohup(1)', 'top(1)']);
  for (const [letter, type] of Object.entries(ENTITY_LETTERS)) assert.equal(orp.orpSpawns[letter], type);
});

// A movement model of the level design budget, independent of the engine:
// from a standing cell the hero rises 0, 1 or 2 cells, moves sideways at that
// height (at most 3 cells to land higher, 4 to land level or lower; with nice,
// 3 more for a dash), then falls straight down.  Spikes end a fall; one-way
// platforms carry from above and are passed going up or dropped through;
// cracked walls count as air once nice is held, gates once their room's
// switch was hit; temporary crates count as solid unless state.swept, and
// crumbling tiles unless state.crumbled (they hold long enough to cross).  A
// switch is hit from a cell in its row within 8 cells with kill.  Touching
// an exit opening leads to the matching cell of the other room (unless
// stayIn).  Returns the standing cells (each with the cells it moves to in
// one go, out, and whether that move touches an exit, a tty or the start,
// free), every cell touched, whether an exit was reached and the entries
// (room:x,y where the hero comes in through an exit).
function solidIn(state, key, x, y) {
  const rows = orp.orpRooms[key].rows;
  const ch = rows[Math.min(Math.max(y, 0), rows.length - 1)][Math.min(Math.max(x, 0), rows[0].length - 1)];
  if (ch === 'x') return !state.abilities.has('nice');
  if (ch === 'G') return !state.switches.has(key);
  if (ch === 't') return !state.swept;
  if (ch === '%') return !state.crumbled;
  return '#cD'.includes(ch);
}

function walkWorld(state, startKey, startX, startY, stayIn) {
  const nodes = new Map();
  const entries = new Set();
  let left = false;
  const touched = new Map(Object.keys(orp.orpRooms).map((key) => [key, new Set()]));
  const queue = [];
  const raw = (key, x, y) => {
    const rows = orp.orpRooms[key].rows;
    return rows[Math.min(Math.max(y, 0), rows.length - 1)][Math.min(Math.max(x, 0), rows[0].length - 1)];
  };
  const kind = (key, x, y) => {
    const ch = raw(key, x, y);
    if (ch === '=') return 'platform';
    if (ch === '^') return 'spike';
    return solidIn(state, key, x, y) ? 'solid' : 'air';
  };
  const inside = (key, x, y) => x >= 0 && y >= 0 && x < orp.orpRooms[key].rows[0].length && y < orp.orpRooms[key].rows.length;
  const clear = (key, x, y) => inside(key, x, y) && (kind(key, x, y) === 'air' || kind(key, x, y) === 'platform');
  const support = (key, x, y) => kind(key, x, y + 1) === 'solid' || kind(key, x, y + 1) === 'platform';
  let current = null;
  function touch(key, x, y) {
    const rows = orp.orpRooms[key].rows;
    if (x < 0 || y < 0 || x >= rows[0].length || y >= rows.length) return;
    const cell = x + ',' + y;
    const ch = raw(key, x, y);
    if (current && /[1-9T@]/.test(ch)) current.free = true;
    if (touched.get(key).has(cell)) return;
    touched.get(key).add(cell);
    if (!/[1-9]/.test(ch)) return;
    left = true;
    if (stayIn) return;
    const [to, back] = orp.orpRooms[key].exits[ch];
    const from = orp.orpRoom(key).exits[ch].cells;
    const target = orp.orpRoom(to);
    const [tx, ty] = target.exits[back].cells[from.findIndex(([ex, ey]) => ex === x && ey === y)];
    const arrive = [tx === 0 ? 1 : tx === target.w - 1 ? tx - 1 : tx, ty === 0 ? 1 : ty];
    entries.add(to + ':' + arrive);
    add(to, fall(to, arrive[0], arrive[1]));
  }
  function fall(key, x, y) {
    for (let at = y; at < orp.orpRooms[key].rows.length; at++) {
      if (!clear(key, x, at)) return null;
      touch(key, x, at);
      if (support(key, x, at)) return [x, at];
    }
    return null;
  }
  function add(key, cell) {
    if (!cell) return;
    const id = key + ':' + cell;
    if (current) current.out.add(id);
    if (nodes.has(id)) return;
    nodes.set(id, { id, key, x: cell[0], y: cell[1], out: new Set(), free: false });
    queue.push(nodes.get(id));
  }
  add(startKey, fall(startKey, startX, startY));
  while (queue.length) {
    current = queue.shift();
    const { key, x, y } = current;
    touch(key, x, y);
    if (kind(key, x, y + 1) === 'platform') add(key, fall(key, x, y + 1));
    for (let h = 0; h <= 2; h++) {
      if (h > 0 && !clear(key, x, y - h)) break;
      touch(key, x, y - h);
      for (const dir of [-1, 1]) {
        for (let d = 1; d <= (state.abilities.has('nice') ? 7 : 4); d++) {
          const cx = x + dir * d;
          if (!clear(key, cx, y - h)) break;
          touch(key, cx, y - h);
          const land = fall(key, cx, y - h);
          if (land && d <= (land[1] < y ? 3 : 4) + (state.abilities.has('nice') ? 3 : 0)) add(key, land);
        }
      }
    }
    if (state.abilities.has('kill')) {
      for (const dir of [-1, 1]) {
        for (let d = 1; d <= 8 && kind(key, x + dir * d, y) !== 'solid'; d++) {
          if (raw(key, x + dir * d, y) === 's') state.hits.add(key);
        }
      }
    }
  }
  return { nodes, touched, left, entries };
}

const START = orp.orpRoom('home').start;

// Walks the world from the start, picking up capabilities and hitting
// switches, until nothing new opens up.  Returns the last walk and the order
// in which the capabilities and switches came.
function walkToFixpoint() {
  const state = { abilities: new Set(), switches: new Set(), hits: new Set() };
  const order = [];
  for (;;) {
    const walk = walkWorld(state, 'home', START[0], START[1]);
    let changed = false;
    for (const key of WORLD) {
      orp.orpRoom(key).spawns.forEach((s) => {
        const ability = { capKill: 'kill', capNice: 'nice' }[s.type];
        if (ability && walk.touched.get(key).has(s.x + ',' + s.y) && !state.abilities.has(ability)) {
          state.abilities.add(ability);
          order.push(ability);
          changed = true;
        }
      });
    }
    for (const key of state.hits) {
      if (!state.switches.has(key)) {
        state.switches.add(key);
        order.push('switch ' + key);
        changed = true;
      }
    }
    if (!changed) return { walk, order, state };
  }
}

// The standing cells of a walk from which no way leads to an exit, a tty or
// the start: the walk's moves followed backwards from the free cells.
function traps(walk) {
  const back = new Map();
  for (const node of walk.nodes.values()) {
    for (const to of node.out) back.set(to, (back.get(to) || []).concat(node.id));
  }
  const queue = [...walk.nodes.values()].filter((node) => node.free).map((node) => node.id);
  const safe = new Set(queue);
  while (queue.length) {
    for (const from of back.get(queue.shift()) || []) {
      if (!safe.has(from)) {
        safe.add(from);
        queue.push(from);
      }
    }
  }
  return [...walk.nodes.values()].filter((node) => !safe.has(node.id)).map((node) => node.id);
}

// Whether a hero standing at node gets out of its room (an exit) or back to
// a tty or the start, with the world as state has it.  A node inside a
// temporary crate that came back stands on top of the pile (orpUnstick).
function escapes(state, node) {
  let y = node.y;
  while (y > 0 && solidIn(state, node.key, node.x, y)) y--;
  const from = walkWorld(state, node.key, node.x, y, true);
  return from.left || [...from.nodes.values()].some((cell) => cell.free);
}

const walkAt = (abilities, switches) => walkWorld({ abilities: new Set(abilities), switches: new Set(switches), hits: new Set() }, 'home', START[0], START[1]);
const roomsOf = (walk) => [...new Set([...walk.nodes.values()].map((node) => node.key))].sort();

test('orphan-process: the room validator: every room, item and tty is reached within the design budget, kill before the gate switch and nice last, and no pit is a trap, not even while crates or crumbling tiles are away', () => {
  const { walk, order, state } = walkToFixpoint();
  assert.deepEqual(order, ['kill', 'switch gate', 'nice']);
  assert.deepEqual(roomsOf(walk), [...WORLD].sort());
  for (const key of WORLD) {
    for (const { ch, x, y } of lettersOf(key, 'mMknhTEB')) assert.ok(walk.touched.get(key).has(x + ',' + y), key + ': ' + ch + ' at ' + x + ',' + y + ' is reachable');
  }
  // From every standing cell the hero can get back to an exit, a tty or the start of its room.
  assert.deepEqual(traps(walk), []);
  // Falling in while the sweep has the crates away, or through a crumbling tile, is no trap either:
  // from every cell reached then, the way out exists once the tiles are back.
  for (const away of ['swept', 'crumbled']) {
    const during = walkWorld(Object.assign({}, state, { [away]: true }), 'home', START[0], START[1]);
    for (const node of during.nodes.values()) {
      if (walk.nodes.has(node.key + ':' + node.x + ',' + node.y)) continue;
      assert.ok(escapes(state, node), away + ': ' + node.key + ' ' + node.x + ',' + node.y + ' is not a trap once the tiles are back');
    }
  }
  // (Those walks do go somewhere new: down through the crate stairs of /tmp, and onto the spikes under tmp.XXXX's bridge.)
  const swept = walkWorld(Object.assign({}, state, { swept: true }), 'home', START[0], START[1]);
  assert.ok(swept.nodes.has('tmp:25,16') && !walk.nodes.has('tmp:25,16'));
  const crumbled = walkWorld(Object.assign({}, state, { crumbled: true }), 'home', START[0], START[1]);
  assert.ok(crumbled.touched.get('tmpx').has('18,17') && !walk.touched.get('tmpx').has('18,17'));
});

// Exits a room is not meant to be left by: .local/bin's opening in its
// ceiling is the arena's shortcut dropping in (checked one way below).
const ONE_WAY = ['bin 2'];
// What the room-by-room check may find and leave for the owner to decide:
// none since 2026-11-16 (the gate to /tmp got a ladder by its west wall up
// to the opening to Downloads, .X11-unix a platform east of its middle
// block).  A new gap fails the test until it is fixed or listed here.
const KNOWN_GAPS = [];
test('orphan-process: the room validator, room by room: with every ability, from every way into a room (each exit it is entered by, each tty, the start) every exit and every item of that room is reached', () => {
  const all = { abilities: new Set(['kill', 'nice']), switches: new Set(['gate']), hits: new Set() };
  const world = walkWorld(all, 'home', START[0], START[1]);
  const entries = [...world.entries].map((id) => {
    const [key, cell] = id.split(':');
    return { key, x: Number(cell.split(',')[0]), y: Number(cell.split(',')[1]), how: 'entered at ' + cell };
  });
  for (const key of WORLD) {
    for (const { ch, x, y } of lettersOf(key, 'T@')) entries.push({ key, x, y, how: (ch === 'T' ? 'the tty at ' : 'the start at ') + x + ',' + y });
  }
  // Every opening of every room is a way in (but the one-way drop's other end).
  for (const key of WORLD) {
    for (const [digit, [to, back]] of Object.entries(orp.orpRooms[key].exits)) {
      if (ONE_WAY.includes(to + ' ' + back)) continue;
      assert.ok(entries.some((e) => e.key === key && orp.orpRoom(key).exits[digit].cells.some(([ex, ey]) => Math.abs(ex - e.x) <= 1 && Math.abs(ey - e.y) <= 1)),
        key + ' is entered through its opening ' + digit);
    }
  }
  const failures = [];
  for (const entry of entries) {
    const walk = walkWorld(all, entry.key, entry.x, entry.y, true);
    const touched = walk.touched.get(entry.key);
    for (const digit of Object.keys(orp.orpRooms[entry.key].exits)) {
      if (ONE_WAY.includes(entry.key + ' ' + digit)) continue;
      if (!orp.orpRoom(entry.key).exits[digit].cells.some(([x, y]) => touched.has(x + ',' + y))) failures.push(entry.key + ' ' + entry.how + ': exit ' + digit);
    }
    for (const { ch, x, y } of lettersOf(entry.key, 'mMknhTEB')) {
      if (!touched.has(x + ',' + y)) failures.push(entry.key + ' ' + entry.how + ': ' + ch + ' at ' + x + ',' + y);
    }
  }
  assert.deepEqual(failures, KNOWN_GAPS, 'nothing but the known gaps (a fixed one leaves this list too)');
  assert.ok(entries.length > 30, entries.length + ' ways in');
  // The one-way drop is one way indeed: from inside .local/bin its ceiling opening is out of reach.
  const bin = walkWorld(all, 'bin', 1, 20, true);
  assert.ok(!lettersOf('bin', '2').some(({ x, y }) => bin.touched.get('bin').has(x + ',' + y)));
});

test('orphan-process: the abilities open the world in order: no /tmp before the switch, which needs kill, and nice opens exactly the two secrets of /home, the shortcut and the way onward', () => {
  // Before kill only /home: the switch needs a signal.
  assert.deepEqual(roomsOf(walkAt([], [])), [...HOME].sort());
  assert.deepEqual(roomsOf(walkAt(['kill'], [])), [...HOME].sort());
  const before = walkAt(['kill'], ['gate']);
  assert.deepEqual(roomsOf(before), [...WORLD].sort());
  const after = walkAt(['kill', 'nice'], ['gate']);
  const opened = [];
  for (const key of WORLD) {
    for (const { ch, x, y } of lettersOf(key, 'mMknhTE')) {
      const cell = x + ',' + y;
      if (after.touched.get(key).has(cell) && !before.touched.get(key).has(cell)) opened.push(key + ' ' + ch);
    }
  }
  assert.deepEqual(opened.sort(), ['arena E', 'bin M', 'home m'], 'the way onward, the module of .local/bin and init(1) in ~');
  assert.deepEqual(orp.orpRoom('home').spawns.find((s) => s.type === 'man' && s.x === 2).id, 'man:init');
  // The cracked walls: one in ~ and one in .local/bin, two in the arena.
  assert.deepEqual(WORLD.filter((key) => lettersOf(key, 'x').length).map((key) => key + ' ' + lettersOf(key, 'x').length), ['home 1', 'bin 1', 'arena 2']);
  // The shortcut: from the arena floor the dash leads down into .local/bin; without nice the arena's floor exit stays shut.
  const exit = lettersOf('arena', '3');
  const fight = { abilities: new Set(['kill']), switches: new Set(['gate']), hits: new Set() };
  const shut = walkWorld(fight, 'arena', 5, 14, true);
  assert.ok(!exit.some(({ x, y }) => shut.touched.get('arena').has(x + ',' + y)));
  const open = walkWorld(Object.assign({}, fight, { abilities: new Set(['kill', 'nice']) }), 'arena', 5, 14, true);
  assert.ok(exit.every(({ x, y }) => open.touched.get('arena').has(x + ',' + y)));
  assert.deepEqual(orp.orpRooms.arena.exits['3'], ['bin', '2']);
  // .local/bin's opening in its ceiling is one way: it cannot be reached from below.
  const below = walkWorld(Object.assign({}, fight, { abilities: new Set(['kill', 'nice']) }), 'bin', 1, 20, true);
  assert.ok(!lettersOf('bin', '2').some(({ x, y }) => below.touched.get('bin').has(x + ',' + y)));
});

test('orphan-process: along the way a tty comes every two or three rooms, the first in ~ and one in the room before the arena', () => {
  ROUTE.slice(0, -1).forEach((key, i) => {
    assert.ok(Object.values(orp.orpRooms[key].exits).some(([to]) => to === ROUTE[i + 1]), key + ' leads to ' + ROUTE[i + 1]);
  });
  const at = ROUTE.map((key, i) => (orp.orpRoom(key).ttys.length ? i : -1)).filter((i) => i >= 0);
  assert.equal(at[0], 0);
  assert.equal(at[at.length - 1], ROUTE.indexOf('arena') - 1);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] <= 3, ROUTE[at[i - 1]] + ' to ' + ROUTE[at[i]]);
  assert.equal(orp.orpRoom('arena').ttys.length, 0);
});

test('orphan-process: a thorough first run reaches nice 12 or 13 by the boss', () => {
  const kinds = orp.orpKinds;
  // XP from every enemy of keys once, reaping zombies of each daemon.
  const enemies = (keys, zombies) => keys.reduce((sum, key) => sum + orp.orpRoom(key).spawns.reduce((n, s) => {
    if (s.type === 'daemon') return n + kinds.daemon.xp + zombies * kinds.zombie.xp;
    return n + (kinds[s.type].target && s.type !== 'boss' ? kinds[s.type].xp : 0);
  }, 0), 0);
  const pages = 10 * (12 - 1);
  const niceAt = (xp) => {
    let nice = 19;
    while (xp >= orp.orpXpNeeded(nice)) xp -= orp.orpXpNeeded(nice--);
    return nice;
  };
  const fromKill = WORLD.slice(WORLD.indexOf('docs'), WORLD.indexOf('arena'));
  const least = niceAt(enemies(fromKill, 0) + pages);
  const most = niceAt(enemies(WORLD, 3) + pages);
  assert.ok(least >= 12 && least <= 13 && most >= 12 && most <= 13, 'nice ' + least + ' to ' + most);
});

test('orphan-process: an exit leads to the matching place of the linked room, just inside its edge, keeping the height in the opening', () => {
  let sim = orp.orpNewSim(orp.orpFreshProgress());
  assert.equal(sim.room, 'home');
  assert.deepEqual(sim.prog.visited, ['home']);
  sim = place(sim, 47, 8);
  const events = [];
  sim = runUntil(sim, { right: true }, (s) => s.room === 'config', 200, events);
  assert.deepEqual(types(events).filter((type) => type !== 'msg'), ['save', 'room']);
  assert.equal(sim.hero.x, T + 2);
  assert.equal(sim.hero.y, 9 * T - HERO_H, 'the same height in the opening');
  assert.deepEqual(sim.prog.visited, ['home', 'config']);
  assert.ok(sim.ents.some((e) => e.type === 'bug'));
  // Back west: just inside the east edge of ~, and the visit is not new.
  const back = [];
  sim = runUntil(sim, { left: true }, (s) => s.room === 'home', 200, back);
  assert.equal(sim.hero.x, 49 * T - 2 - HERO_W);
  assert.deepEqual(types(back), ['room']);
  // Through the open gate into /tmp: a new area starts the sweep from zero.
  let tmp = orp.orpNewSim(Object.assign(orp.orpFreshProgress(), { tty: 'gate:44,16', switches: ['gate:38,7'] }));
  tmp = edit(tmp, (s) => { s.sweep = 7; });
  tmp = runUntil(tmp, { right: true }, (s) => s.room === 'tmp', 200);
  assert.equal(tmp.area, 'tmp');
  assert.ok(tmp.sweep < 0.1);
  // Into the arena from tty1: the same area, but there the sweep is the boss's, from zero.
  let arena = orp.orpNewSim(Object.assign(orp.orpFreshProgress(), { tty: 'ttyr:37,14' }));
  arena = edit(arena, (s) => { s.sweep = 7; });
  arena = runUntil(arena, { right: true }, (s) => s.room === 'arena', 200);
  assert.equal(arena.sweep, 0);
  assert.equal(run(arena, {}, 120).sweep, 0, 'no sweep of its own');
});

test('orphan-process: openings in a floor and a ceiling: falling through lands in the room below, coming up through one gives a jump\'s speed', (t) => {
  const upper = lab(['#..T...........................#', '########1#######################']);
  const lower = ['########1#######################'].concat(Array.from({ length: 13 }, () => '#..............................#'), ['#..............................#', '#..............................#', '################################']);
  lower[2] = '#......====.....................#';
  withRooms(t, { lab: { rows: upper, exits: { 1: ['under', '1'] } }, under: { rows: lower, exits: { 1: ['lab', '1'] } } });
  let sim = orp.orpNewSim(Object.assign(orp.orpFreshProgress(), { tty: 'lab:3,15' }));
  sim = settle(place(sim, 6, 15));
  sim = runUntil(sim, { right: true }, (s) => s.hero.x >= 8 * T + 2, 200);
  sim = runUntil(sim, {}, (s) => s.room === 'under', 200);
  assert.equal(sim.hero.y, 2, 'just inside the top edge');
  assert.ok(sim.hero.x >= 8 * T && sim.hero.x <= 9 * T);
  // It lands on the platform under the opening; a jump goes back up through it.
  sim = settle(sim);
  assert.equal(sim.hero.y, 2 * T - HERO_H);
  sim = runUntil(sim, { jump: true }, (s) => s.room === 'lab', 120);
  assert.equal(sim.hero.y, 16 * T - 2 - HERO_H);
  assert.ok(sim.hero.vy <= -JUMP, 'it comes up with a jump\'s speed');
});

test('orphan-process: the camera follows the hero a little ahead of it and stays inside the room', (t) => {
  const wide = ['#'.repeat(80)].concat(Array.from({ length: 22 }, () => '#' + '.'.repeat(78) + '#'), ['#..T' + '.'.repeat(75) + '#', '#'.repeat(80)]);
  withRooms(t, { wide: { rows: wide } });
  let sim = orp.orpNewSim(Object.assign(orp.orpFreshProgress(), { tty: 'wide:3,23' }));
  assert.deepEqual(sim.cam, { x: 0, y: 25 * T - H }, 'clamped to the bottom left on entry');
  sim = run(place(sim, 40, 23), {}, 600);
  assert.ok(Math.abs(sim.cam.x - (40 * T + 3 + HERO_W / 2 + 24 - W / 2)) < 0.5, 'centred, 24 px ahead: ' + sim.cam.x);
  sim = run(sim, { left: true }, 2);
  sim = run(sim, {}, 600);
  assert.ok(sim.cam.x < 40 * T + 8 - W / 2, 'looking left now');
  sim = run(place(sim, 77, 23), {}, 600);
  assert.ok(Math.abs(sim.cam.x - (80 * T - W)) < 0.5, 'clamped to the right edge');
  sim = run(place(sim, 40, 3), {}, 2);
  assert.ok(sim.cam.y < 25 * T - H, 'it follows upward');
});

// ── The boss ─────────────────────────────────────────────────────────────────

// tty1's tty: the last one before the arena.
const TTY1 = orp.orpRoom('ttyr').ttys[0];
const PHASES = orp.orpConstants.BOSS_PHASES;
// The arena's one-way platforms (first and last column, row 13) and the
// boss's x at the left and the right end of the floor.
const PERCHES = [[3, 7], [12, 17], [22, 26]];
const ENDS = [T + 2, 29 * T - 2 - 26];
const bossOf = (sim) => sim.ents.find((e) => e.type === 'boss');

// A game whose last tty is tty1's, with the hero just inside the arena.
function arenaSim(prog = {}) {
  const sim = orp.orpNewSim(Object.assign(orp.orpFreshProgress(), { tty: TTY1, abilities: ['kill'] }, prog));
  return runUntil(place(sim, 37, 14), { right: true }, (s) => s.room === 'arena', 200);
}

// Steps with input(sim, i) until done(sim) or max steps; returns the last
// state, every event and each change of the boss's state with its time.
function fight(sim, input, done, max) {
  const events = [];
  const log = [];
  let last = '';
  for (let i = 0; i < max && !done(sim); i++) {
    sim = orp.orpStep(sim, Object.assign({}, IDLE, input(sim, i)));
    events.push(...sim.events);
    const boss = bossOf(sim);
    const state = boss ? boss.state : 'none';
    if (state !== last) log.push({ state, t: sim.t, x: boss ? boss.x : 0, hp: boss ? boss.hp : 0 });
    last = state;
  }
  return { sim, events, log };
}

// How long each state of a log lasted (the last one is open).
const spans = (log) => log.slice(0, -1).map((entry, i) => [entry.state, log[i + 1].t - entry.t]);
const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 2.5 * STEP, what + ': ' + a + ' vs ' + b);

test('orphan-process: the tmp cleaner sleeps until the hero comes in, then loops: a wind-up, a sweep to the other end, blinking crates, the crates gone while temp files hang and fall, the core open for 2 s', () => {
  let sim = arenaSim();
  let boss = bossOf(sim);
  assert.deepEqual([boss.state, boss.x, boss.hp, boss.w, boss.h], ['sleep', ENDS[1], 12, 26, 28]);
  assert.ok(!sim.ents.some((e) => e.type === 'capNice'), 'no nice pedestal while it lives');
  // Asleep while the hero stays by the door; the camera keeps to the arena's screen.
  sim = run(sim, {}, 120);
  assert.equal(bossOf(sim).state, 'sleep');
  assert.equal(orp.orpTileSprite(sim, 9, 13), 'crateTemp');
  let woke = fight(sim, () => ({ right: true }), (s) => bossOf(s).state === 'intro', 600);
  assert.ok(woke.sim.hero.x + HERO_W / 2 > ENDS[0] + 5 * T);
  assert.equal(run(place(woke.sim, 27, 14), { right: true }, 60).cam.x, 0);
  // The hero waits on the middle platform, out of reach of the sweep (it may take a file).
  sim = edit(place(woke.sim, 14, 12), (s) => { s.prog.maxRss = 20; s.rss = 20; });
  const seen = { warn: new Set(), sweep: [] };
  const { sim: after, events, log } = fight(sim, () => ({}), (s) => s.t > woke.sim.t + 13, 2000);
  assert.deepEqual(log.map((entry) => entry.state).slice(0, 7), ['intro', 'windup', 'sweep', 'warn', 'files', 'core', 'windup']);
  const took = spans(log);
  const p = PHASES[0];
  near(took[1][1], p.windup, 'wind-up');
  near(took[2][1], (ENDS[1] - ENDS[0]) / p.speed, 'sweep');
  near(took[3][1], p.warn, 'warning');
  near(took[4][1], orp.orpConstants.BOSS_GONE, 'crates gone');
  near(took[5][1], orp.orpConstants.BOSS_CORE, 'core open');
  assert.deepEqual([log[3].x, log[6].x], [ENDS[0], ENDS[0]], 'it swept to the left end and stays there');
  assert.deepEqual(events.filter((e) => e.type === 'sweep').map((e) => e.gone), [true, false]);
  assert.ok(after.rss > 0);
  // The steps again, looked at one by one.
  let s = sim;
  let fileT = null;
  while (bossOf(s).state !== 'core') {
    const before = bossOf(s);
    s = orp.orpStep(s, IDLE);
    const b = bossOf(s);
    if (b.state === 'windup') assert.equal(b.face, -1, 'it faces where it will sweep');
    if (b.state === 'sweep') {
      assert.ok(b.x <= before.x);
      seen.sweep.push(b.x);
    }
    if (b.state === 'warn') {
      assert.equal(s.warn, true);
      seen.warn.add(orp.orpTileSprite(s, 9, 13));
    }
    if (b.state === 'files' && before.state === 'warn') {
      fileT = s.t;
      assert.equal(s.swept, true);
      assert.equal(orp.orpSolid(s, 9, 13), false);
      const files = s.ents.filter((e) => e.type === 'file');
      // One over the hero (column 14), the others 5 columns apart.
      assert.deepEqual(files.map((f) => Math.floor(f.x / T)), [14, 19, 9]);
      assert.ok(files.every((f) => f.y === T), 'hanging under the ceiling');
      assert.deepEqual(files.map((f) => f.cd), [p.hang, p.hang + 0.15, p.hang + 0.3]);
    }
    if (b.state === 'files' && fileT !== null) {
      for (const f of s.ents.filter((e) => e.type === 'file')) {
        if (s.t - fileT < f.cd - STEP) assert.equal(f.y, T, 'a file hangs for its time first');
      }
      assert.ok(Math.abs(s.sweep - (20 + 3 * (s.t - fileT) / orp.orpConstants.BOSS_GONE)) < 0.05, 'the HUD bar drains');
    }
  }
  assert.deepEqual([...seen.warn].sort(), ['', 'crateTemp'], 'the crates blink before they go');
  assert.ok(seen.sweep.length > 100);
  assert.equal(s.ents.filter((e) => e.type === 'file').length, 0, 'every file has landed before the core opens');
  assert.equal(s.swept, false);
  assert.equal(s.sweep, 0);
  assert.equal(orp.orpSolid(s, 9, 13), true, 'the crates are back');
  // Next it sweeps back to the right.
  const back = fight(s, () => ({}), (x) => bossOf(x).state === 'sweep', 600);
  assert.equal(bossOf(back.sim).dir, 1);
});

test('orphan-process: temp files hang, then fall at the speed of their phase and stop on a platform or the floor; one that reaches the hero hurts and is gone', () => {
  let sim = edit(place(arenaSim(), 19, 14), (s) => {
    s.prog.maxRss = 20;
    s.rss = 20;
    Object.assign(bossOf(s), { x: ENDS[0], state: 'warn', timer: 0 });
  });
  sim = runUntil(sim, {}, (s) => bossOf(s).state === 'files', 200);
  const files = (s) => s.ents.filter((e) => e.type === 'file');
  // Over the hero (column 19), then 5 columns right and left of it (over the platforms).
  assert.deepEqual(files(sim).map((f) => Math.floor(f.x / T)), [19, 24, 14]);
  const first = files(sim)[0].id;
  sim = runUntil(sim, {}, (s) => files(s)[0].y > T, 200);
  const y0 = files(sim)[0].y;
  sim = run(sim, {}, 10);
  assert.ok(Math.abs(files(sim)[0].y - y0 - 10 * PHASES[0].fall * STEP) < 1e-6, 'at the speed of the phase');
  const events = [];
  sim = runUntil(sim, {}, (s) => !s.ents.some((e) => e.id === first), 400, events);
  assert.ok(types(events).includes('hurt'), 'the one over the hero hit it');
  assert.equal(sim.rss, 19);
  // The others stop on the platforms, each with a puff of dust.
  const puffs = [];
  while (files(sim).length) {
    sim = orp.orpStep(sim, IDLE);
    puffs.push(...sim.fx.filter((f) => f.k === 'dust' && Math.abs(f.t - STEP) < 1e-9).map((f) => f.y));
  }
  assert.deepEqual(puffs, [12 * T, 12 * T]);
  // A file in the open lands on the floor.
  let open = edit(sim, (s) => {
    s.ents.push({ id: 'f', type: 'file', x: 10 * T + 3, y: T, w: 10, h: 12, vx: 0, vy: 140, hp: 0, face: -1, t: 0, flash: 0, cd: 0, parent: '' });
  });
  open = runUntil(open, {}, (s) => !s.ents.some((e) => e.id === 'f'), 400);
  assert.ok(open.fx.some((f) => f.k === 'dust' && f.y === 14 * T));
});

test('orphan-process: only the open core takes a hit, at most one every 0.7 s; the hit that ends a phase closes it for a 1 s rage, and the boss hurts on contact', () => {
  const sim = arenaSim();
  // The boss at the left end in a given state, the hero 4 tiles away facing it.
  const at = (state, extra) => edit(place(sim, 5, 14, { face: -1 }), (s) => { Object.assign(bossOf(s), { x: ENDS[0], state, timer: 0, cd: 0 }, extra); });
  for (const state of ['intro', 'windup', 'warn', 'files', 'rage']) {
    let s = run(at(state), { shoot: true }, 1);
    assert.equal(s.sigs.length, 1);
    s = run(s, {}, 30);
    assert.equal(s.sigs.length, 0, state + ': the signal stops at it');
    assert.equal(bossOf(s).hp, 12, state + ': no damage');
  }
  let s = runUntil(run(at('core'), { shoot: true }, 1), {}, (x) => bossOf(x).hp === 11, 40);
  assert.equal(orp.orpKinds.boss.look(s, bossOf(s)), 'bossHurt');
  // Again within 0.7 s: it glances off; after it, a hit.
  s = run(run(s, {}, 10), { shoot: true }, 1);
  s = run(s, {}, 20);
  assert.equal(bossOf(s).hp, 11);
  s = run(run(s, {}, 50), { shoot: true }, 1);
  s = run(s, {}, 20);
  assert.equal(bossOf(s).hp, 10);
  assert.equal(bossOf(s).state, 'core');
  // The fourth hit of a phase closes the core: a second of rage, then the next wind-up.
  let last = run(at('core', { hp: 9 }), { shoot: true }, 1);
  last = runUntil(last, {}, (x) => bossOf(x).hp === 8, 40);
  assert.equal(bossOf(last).state, 'rage');
  const rage = fight(last, () => ({}), (x) => bossOf(x).state === 'windup', 400);
  near(rage.sim.t - last.t, orp.orpConstants.BOSS_RAGE, 'rage');
  // Touching it hurts, whatever its state.
  const touch = run(edit(at('files'), (x) => { x.hero.x = ENDS[0] + 20; }), {}, 2);
  assert.equal(touch.rss, 4);
});

test('orphan-process: each phase of the boss is faster: a shorter wind-up, a faster sweep, more and faster files, a shorter loop', () => {
  const loops = [12, 8, 4].map((hp) => {
    let sim = edit(place(arenaSim({ maxRss: 20 }), 14, 12), (s) => {
      s.rss = 20;
      Object.assign(bossOf(s), { x: ENDS[0], state: 'core', timer: 2, hp });
    });
    let files = 0;
    const { log } = fight(sim, (s) => {
      files = Math.max(files, s.ents.filter((e) => e.type === 'file').length);
      return {};
    }, (s) => s.t > sim.t + 14, 2000);
    const took = spans(log);
    return { windup: took[0][1], sweep: took[1][1], loop: log[5].t - log[0].t, files, states: log.map((e) => e.state).slice(0, 6).join() };
  });
  for (const l of loops) assert.equal(l.states, 'windup,sweep,warn,files,core,windup');
  assert.deepEqual(loops.map((l) => l.files), [3, 4, 5]);
  for (let i = 1; i < 3; i++) {
    for (const what of ['windup', 'sweep', 'loop']) assert.ok(loops[i][what] < loops[i - 1][what], what + ' of phase ' + (i + 1));
  }
  assert.ok(PHASES[2].fall > PHASES[1].fall && PHASES[1].fall > PHASES[0].fall);
  // Every attack is announced: a wind-up of at least 0.5 s, a warning of at least 0.4 s, files hanging at least 0.5 s.
  for (const p of PHASES) assert.ok(p.windup >= 0.5 && p.warn >= 0.4 && p.hang >= 0.5);
});

// A scripted player: at every wind-up it hops onto the nearest platform
// (above the sweep); otherwise it goes to the floor under the corner
// platform next to the boss, out of the way of every file it sees coming,
// faces the boss and fires while the core is open.
function bossBot(sim, i, mem) {
  const hero = sim.hero;
  const hx = hero.x + HERO_W / 2;
  const boss = bossOf(sim);
  if (!boss) return {};
  const input = {};
  const go = (x, slack) => {
    if (hx < x - slack) input.right = true;
    else if (hx > x + slack) input.left = true;
  };
  const up = hero.y + HERO_H <= 13 * T;
  if (['intro', 'windup', 'sweep'].includes(boss.state)) {
    if (up && hero.ground) return {};
    if (mem.jump > 0) {
      mem.jump -= 1;
      input.jump = true;
    }
    const perch = PERCHES.map(([a, b]) => (a + b + 1) * T / 2).sort((a, b) => Math.abs(a - hx) - Math.abs(b - hx))[0];
    go(perch, 4);
    if (Math.abs(hx - perch) < 24 && hero.ground && !mem.jump) {
      mem.jump = 30;
      input.jump = true;
    }
    return input;
  }
  mem.jump = 0;
  if (up && hero.ground) return { down: true, jump: i % 2 === 1 };
  const left = boss.x < W / 2;
  const spot = left ? 5.5 * T : 23.5 * T;
  const sheltered = PERCHES.some(([a, b]) => Math.floor((hx - 5) / T) >= a && Math.floor((hx + 5) / T) <= b);
  const threat = sim.ents.find((e) => e.type === 'file' && Math.abs(e.x + 5 - hx) < 16 && e.y + e.h < hero.y && !sheltered);
  if (threat) {
    if (hx > threat.x + 5) input.right = true;
    else input.left = true;
    return input;
  }
  go(spot, 2);
  if (Math.abs(hx - spot) <= 2) {
    const face = left ? -1 : 1;
    if (hero.face !== face) input[face < 0 ? 'left' : 'right'] = true;
    else if (boss.state === 'core' && i % 2) input.shoot = true;
  }
  return input;
}

test('orphan-process: a scripted player beats the tmp cleaner without dying: nice drops, the shortcut is open and the episode ends', () => {
  const mem = {};
  let sim = arenaSim();
  const fought = fight(sim, (s, i) => bossBot(s, i, mem), (s) => s.prog.boss || s.mode !== 'play', 120 * 150);
  sim = fought.sim;
  assert.equal(sim.prog.boss, true, 'won');
  assert.equal(sim.prog.deaths, 0);
  assert.equal(sim.mode, 'play');
  assert.ok(sim.t < 150);
  // Six openings of the core at the least: at most three hits each, and a phase's last hit closes it.
  assert.ok(fought.log.filter((e) => e.state === 'core').length >= 6);
  assert.deepEqual(fought.log.filter((e) => e.state === 'rage').map((e) => e.hp), [8, 4]);
  assert.deepEqual(messages(fought.events).slice(-1), ['tmpfiles.d stopped']);
  assert.equal(fought.events.filter((e) => e.type === 'msg').pop().text, 'The cleaner is down and left the renice capability behind.');
  assert.ok(types(fought.events.slice(-3)).includes('save'));
  // The wreck smokes for a moment where it stood; the nice pedestal is in the middle of the arena.
  assert.ok(sim.ents.some((e) => e.type === 'wreck'));
  assert.equal(orp.orpKinds.wreck.look(sim, sim.ents.find((e) => e.type === 'wreck')), 'bossDead');
  const pedestal = sim.ents.find((e) => e.type === 'capNice');
  assert.equal(pedestal.id, 'arena:14,14');
  sim = run(sim, {}, 200);
  assert.ok(!sim.ents.some((e) => e.type === 'wreck'));
  // Taking nice: the capability, and the end-of-episode screen 2.5 s later.
  const events = [];
  sim = runUntil(place(sim, 11, 14), { right: true }, (s) => s.prog.abilities.includes('nice'), 600, events);
  assert.deepEqual(messages(events).slice(-1), ['Capability: renice']);
  const taken = sim.t;
  assert.equal(sim.prog.ended, false);
  sim = runUntil(sim, {}, (s) => s.mode === 'end', 400, events);
  near(sim.t - taken, orp.orpConstants.END_DELAY, 'the end');
  assert.deepEqual(types(events).slice(-2), ['end', 'save']);
  assert.equal(sim.prog.ended, true, 'the save says the end screen was shown');
});

test('orphan-process: a hero that stands still loses to the sweeps, and a killed process restarts the fight from tty1', () => {
  let sim = place(arenaSim(), 14, 14);
  const hits = [];
  let prev = null;
  const { sim: dead, log } = fight(sim, (s) => {
    if (prev && s.rss < prev.rss) hits.push(bossOf(prev).state);
    prev = s;
    return {};
  }, (s) => s.mode === 'dead', 120 * 90);
  assert.equal(dead.mode, 'dead');
  assert.equal(dead.prog.deaths, 1);
  assert.ok(hits.length >= 4 && hits.every((state) => state === 'sweep'), hits.join());
  assert.ok(log.length > 10);
  // Back at tty1 with full RSS; through the door the boss sleeps again with all its HP.
  sim = runUntil(dead, {}, (s) => s.mode === 'play', 300);
  assert.equal(sim.room, 'ttyr');
  assert.equal(sim.rss, 5);
  sim = runUntil(place(sim, 37, 14), { right: true }, (s) => s.room === 'arena', 200);
  assert.deepEqual([bossOf(sim).state, bossOf(sim).hp, bossOf(sim).x], ['sleep', 12, ENDS[1]]);
});

test('orphan-process: from waking until it is down a gate shuts the arena\'s door, far from the hero; the door is no hiding place and the fight cannot be walked out of; a death opens it again', () => {
  let sim = arenaSim();
  assert.equal(sim.shut, false);
  for (const y of [13, 14]) assert.deepEqual([orp.orpSolid(sim, 0, y), orp.orpTileSprite(sim, 0, y)], [false, ''], 'open while it sleeps');
  const woke = runUntil(sim, { right: true }, (s) => s.shut, 600);
  assert.equal(bossOf(woke).state, 'intro');
  assert.ok(woke.hero.x >= 5 * T, 'the hero is 4 tiles clear of the gate as it shuts: ' + woke.hero.x);
  for (const y of [13, 14]) assert.deepEqual([orp.orpSolid(woke, 0, y), orp.orpTileSprite(woke, 0, y)], [true, 'gate'], 'shut, row ' + y);
  for (const x of [30, 31, 32]) assert.equal(orp.orpSolid(woke, x, 16), false, 'the shortcut below, off the fight\'s screen, is not gated');
  // Back to the door: the hero stops at the gate inside the arena, and is hit there within a loop.
  const events = [];
  let back = runUntil(woke, { left: true }, (s) => s.hero.x === T && s.hero.ground, 240, events);
  back = runUntil(back, { left: true }, (s) => events.some((e) => e.type === 'hurt'), 120 * 12, events);
  assert.equal(back.room, 'arena');
  assert.ok(back.hero.x >= T - 0.001, 'never in the opening: ' + back.hero.x);
  // Down: the gate opens and the way back to tty1 is free.
  let won = edit(place(woke, 6, 14, { face: -1 }), (s) => { Object.assign(bossOf(s), { x: ENDS[0], state: 'core', timer: 0, cd: 0, hp: 1 }); });
  won = runUntil(run(won, { shoot: true }, 1), {}, (s) => s.prog.boss, 60);
  assert.deepEqual([won.shut, orp.orpSolid(won, 0, 14), orp.orpTileSprite(won, 0, 14)], [false, false, '']);
  assert.equal(runUntil(won, { left: true }, (s) => s.room !== 'arena', 300).room, 'ttyr');
  // Killed in the fight: shut while the process dies, open again from tty1 on.
  let dead = edit(woke, (s) => { s.rss = 1; s.hero.inv = 0; s.hero.x = bossOf(s).x + 4; });
  dead = runUntil(dead, {}, (s) => s.mode === 'dead', 10);
  assert.equal(dead.shut, true);
  dead = runUntil(dead, {}, (s) => s.mode === 'play', 300);
  assert.equal(dead.room, 'ttyr');
  const again = runUntil(place(dead, 37, 14), { right: true }, (s) => s.room === 'arena', 200);
  assert.deepEqual([again.shut, bossOf(again).state, orp.orpSolid(again, 0, 14)], [false, 'sleep', false]);
});

test('orphan-process: in every phase of the boss, a hero that stands still (and shoots) on any floor column of the arena is hit within one loop, whichever end the boss starts from', () => {
  const start = arenaSim({ maxRss: 20 });
  const misses = [];
  for (const hp of [12, 8, 4]) {
    for (const end of ENDS) {
      for (let col = 1; col <= 28; col++) {
        let sim = edit(place(start, col, 14), (s) => {
          s.rss = 20;
          s.shut = true;
          Object.assign(bossOf(s), { x: end, state: 'core', timer: 2, hp });
        });
        let files = false;
        let hit = false;
        for (let i = 0; i < 120 * 20 && !hit; i++) {
          sim = orp.orpStep(sim, Object.assign({}, IDLE, { shoot: i % 2 === 1 }));
          hit = sim.events.some((e) => e.type === 'hurt' || e.type === 'death');
          const state = bossOf(sim).state;
          files = files || state === 'files';
          if (files && state === 'core') break;
        }
        if (!hit) misses.push('hp ' + hp + ', from x ' + end + ', column ' + col);
        assert.ok(sim.hero.x + HERO_W / 2 >= T, 'the hero stays inside the gate');
      }
    }
  }
  assert.deepEqual(misses, []);
});

test('orphan-process: the boss\'s deleted crates never follow the hero out: a death while they are gone, or leaving the arena, restarts the sweep', () => {
  // Killed while the boss has the crates away: tty1 has its crates and a fresh sweep.
  let sim = edit(arenaSim(), (s) => { s.shut = true; Object.assign(bossOf(s), { x: ENDS[0], state: 'warn', timer: 1 }); });
  sim = runUntil(sim, {}, (s) => s.swept, 200);
  assert.equal(bossOf(sim).state, 'files');
  sim = edit(sim, (s) => { s.rss = 1; s.hero.inv = 0; s.hero.x = bossOf(s).x + 4; });
  sim = runUntil(sim, {}, (s) => s.mode === 'dead', 10);
  assert.equal(sim.swept, true);
  sim = runUntil(sim, {}, (s) => s.mode === 'play', 300);
  assert.equal(sim.room, 'ttyr');
  assert.deepEqual([sim.swept, sim.sweep], [false, 0]);
  assert.equal(orp.orpSolid(sim, 30, 13), true, 'tty1\'s crates are there');
  // Leaving the arena with the crates away (the gate is open: no fight on): the next room's sweep starts over.
  let out = edit(arenaSim(), (s) => { s.swept = true; s.sweep = 21.5; });
  out = runUntil(out, { left: true }, (s) => s.room === 'ttyr', 300);
  assert.equal(out.swept, false);
  assert.ok(out.sweep < 0.1, 'sweep ' + out.sweep);
});

test('orphan-process: once the boss is down the arena stays quiet and its screen scrolls; the dash breaks through to the shortcut down to .local/bin and to the way onward', () => {
  const prog = { boss: true, abilities: ['kill', 'nice'] };
  let sim = arenaSim(prog);
  assert.ok(!bossOf(sim));
  assert.ok(sim.ents.some((e) => e.type === 'capNice'));
  assert.ok(!arenaSim(Object.assign({ collected: ['arena:14,14'] }, prog)).ents.some((e) => e.type === 'capNice'));
  sim = run(sim, {}, 120);
  assert.equal(sim.sweep, 0);
  // The shortcut: a dash along the floor breaks the lower wall and the hero drops into .local/bin.
  let down = run(place(sim, 26, 14, { face: 1 }), {}, 2);
  down = runUntil(down, { right: true, dash: true }, (s) => s.room === 'bin', 300);
  assert.deepEqual(down.prog.walls, ['arena:29,14']);
  assert.ok(down.hero.x >= 28 * T && down.hero.x < 31 * T, 'under the opening of .local/bin');
  assert.ok(down.hero.y < 3 * T);
  assert.ok(runUntil(down, {}, (s) => s.hero.ground, 300).hero.y === 21 * T - HERO_H, 'down on its floor');
  // The way onward: a dash from the right platform breaks the upper wall into the end trigger.
  let on = run(place(sim, 25, 12, { face: 1 }), {}, 2);
  on = runUntil(on, { right: true, dash: true }, (s) => s.mode === 'end', 300);
  assert.ok(on.prog.walls.includes('arena:29,12'));
  assert.ok(on.cam.x > 0, 'the camera follows past the fight\'s screen');
});

// ── What is drawn ────────────────────────────────────────────────────────────

test('orphan-process: the hero\'s sprite follows its state', (t) => {
  let sim = settle(labSim(t, lab(FLAT)));
  const look = (fn) => orp.orpHeroSprite(edit(sim, fn));
  assert.equal(look((s) => { s.t = 0; }), 'heroIdle1');
  assert.equal(look((s) => { s.t = 1.9; }), 'heroIdle2');
  assert.equal(look((s) => { s.hero.vx = 50; s.t = 0.15; }), 'heroRun2');
  assert.equal(look((s) => { s.hero.vx = -50; s.t = 0.25; }), 'heroRun3');
  assert.equal(look((s) => { s.hero.ground = false; s.hero.vy = -10; }), 'heroJump');
  assert.equal(look((s) => { s.hero.ground = false; s.hero.vy = 10; }), 'heroFall');
  assert.equal(look((s) => { s.hero.shootT = 0.1; }), 'heroShoot');
  assert.equal(look((s) => { s.hero.dash = 0.1; s.hero.shootT = 0.1; }), 'heroDash');
  assert.equal(look((s) => { s.hero.knock = 0.1; s.hero.dash = 0.1; }), 'heroHurt');
  assert.equal(look((s) => { s.mode = 'dead'; s.deadT = 0.1; }), 'heroDead1');
  assert.equal(look((s) => { s.mode = 'dead'; s.deadT = 0.4; }), 'heroDead2');
});

test('orphan-process: tiles draw with their area\'s set: the top of the ground, two inner variants, and decorations above some top tiles', (t) => {
  const rows = lab(['#..T...........................#', '################################', '################################']);
  const home = settle(labSim(t, rows));
  assert.equal(orp.orpTileSprite(home, 5, 15), 'groundTop');
  const inner = new Set();
  for (let x = 0; x < 32; x++) inner.add(orp.orpTileSprite(home, x, 16));
  assert.deepEqual([...inner].sort(), ['ground', 'groundPlain']);
  assert.equal(orp.orpTileSprite(home, 5, 10), '', 'air');
  const decor = new Set();
  for (let x = 1; x < 31; x++) decor.add(orp.orpDecor(home, x, 14));
  assert.ok(decor.has(''));
  assert.ok([...decor].some((name) => /^decor[1-4]$/.test(name)), [...decor].join());
  assert.equal(orp.orpDecor(home, 5, 10), '', 'only right above the ground');
  assert.equal(orp.orpDecor(home, 0, 14), '', 'never in a wall');
  const tmp = settle(labSim(t, rows, { def: { area: 'tmp' } }));
  assert.equal(orp.orpTileSprite(tmp, 5, 15), 'tmpTop');
  const tmpDecor = new Set();
  for (let x = 1; x < 31; x++) tmpDecor.add(orp.orpDecor(tmp, x, 14));
  assert.ok([...tmpDecor].some((name) => /^tmpDecor[1-3]$/.test(name)));
  const crates = settle(labSim(t, lab(['#..T...=^c......................#', '################################'])));
  assert.deepEqual([7, 8, 9].map((x) => orp.orpTileSprite(crates, x, 15)), ['platform', 'spikes', 'crate']);
  // Every sprite an area names exists.
  for (const area of Object.values(orp.orpAreas)) {
    for (const name of [area.top, area.inner, area.plain].concat(area.decor)) assert.ok(orp.orpSprites[name], name);
  }
});

// ── Saves (pure) ─────────────────────────────────────────────────────────────

test('orphan-process: orpParseSave reads a save of the current version field for field, and orpSerialize writes it back byte for byte', () => {
  const prog = orp.orpParseSave(SAMPLE_SAVE);
  assert.deepEqual(prog, {
    run: SAMPLE_RUN, born: SAMPLE_BORN, tty: 'tmp:4,16', maxRss: 6, maxCpu: 120, xp: 12, nice: 17, abilities: ['kill', 'nice'],
    collected: ['man:fork', 'docs:9,5', 'arena:14,14'], switches: ['gate:38,7'], walls: ['home:4,16'], boss: false, ended: true,
    visited: ['home', 'docs', 'tmp'], time: 754.5, deaths: 3
  });
  assert.equal(JSON.stringify(orp.orpSerialize(prog)), SAMPLE_SAVE);
  assert.deepEqual(orp.orpFreshProgress(), {
    run: '', born: 0, tty: '', maxRss: 5, maxCpu: 100, xp: 0, nice: 19, abilities: [], collected: [], switches: [], walls: [], boss: false,
    ended: false, visited: [], time: 0, deaths: 0
  });
  // A save resumes at its tty with full RSS and CPU, and the hero's position is not part of it.
  const sim = orp.orpNewSim(prog);
  assert.deepEqual([sim.room, sim.hero.x, sim.hero.y, sim.rss, sim.cpu], ['tmp', 4 * T + 3, 17 * T - HERO_H, 6, 120]);
  assert.ok(!('x' in orp.orpSerialize(sim.prog)));
});

test('orphan-process: orpParseSave falls back field by field and returns null for no save at all', () => {
  for (const text of [null, '', 'not json', '[]', '5', 'null', 'true', '"text"']) assert.equal(orp.orpParseSave(text), null, String(text));
  // Any version but the current one is no save (older ones come from development builds).
  for (const v of [undefined, 1, 3, '2', 2.5]) {
    assert.equal(orp.orpParseSave(JSON.stringify(Object.assign(JSON.parse(SAMPLE_SAVE), { v }))), null, 'v ' + v);
  }
  assert.equal(orp.orpParseSave('{}'), null);
  assert.deepEqual(orp.orpParseSave('{"v":2}'), orp.orpFreshProgress());
  const base = JSON.parse(SAMPLE_SAVE);
  const good = orp.orpParseSave(SAMPLE_SAVE);
  const fresh = orp.orpFreshProgress();
  const cases = {
    run: ['', 'K3X9Q2', 'a'.repeat(17), 'k3-9q2', 5, null],
    born: [-1, '1794000000000', null, Infinity],
    tty: ['home:0,0', 'nowhere:1,1', 5, null],
    maxRss: [4, 21, 5.5, '6', null],
    maxCpu: [99, 1001, 100.5, '120'],
    xp: [-1, 1.5, '12', 1e7],
    nice: [20, -21, 17.5, '17'],
    time: [-1, '754', null, Infinity],
    deaths: [-1, 2.5, '3']
  };
  for (const [field, values] of Object.entries(cases)) {
    for (const value of values) {
      const prog = orp.orpParseSave(JSON.stringify(Object.assign({}, base, { [field]: value })).replace('null', value === Infinity ? '1e999' : 'null'));
      assert.deepEqual(prog[field], fresh[field], field + ' = ' + value);
      for (const other of Object.keys(good)) if (other !== field) assert.deepEqual(prog[other], good[other], field + ' leaves ' + other);
    }
  }
  // Lists keep only known ids, once each, in their order; anything else is an empty list.
  const lists = orp.orpParseSave(JSON.stringify(Object.assign({}, base, {
    tty: 'home:11,16',
    abilities: ['nice', 'setuid', 'nice', 7], collected: ['arena:14,14', 'man:fork', 'man:nope', 'docs:9,5', 'man:fork'],
    switches: 'gate:38,7', walls: [['home:4,16']], visited: ['tmp', 'var', 'home', 'tmp'], boss: 'yes', ended: 1
  })));
  assert.deepEqual(lists.abilities, ['nice']);
  assert.deepEqual(lists.collected, ['arena:14,14', 'man:fork', 'docs:9,5']);
  assert.deepEqual([lists.switches, lists.walls, lists.visited, lists.boss, lists.ended], [[], [], ['tmp', 'home'], false, false]);
  assert.equal(orp.orpParseSave(JSON.stringify(Object.assign({}, base, { boss: true }))).boss, true);
  assert.equal(orp.orpParseSave(JSON.stringify(Object.assign({}, base, { ended: false }))).ended, false);
});

test('orphan-process: a save is repaired on load: a tty that is not in the world restarts at the start, and a tty past the gate turns the gate switch on', () => {
  const base = JSON.parse(SAMPLE_SAVE);
  const parse = (fields) => orp.orpParseSave(JSON.stringify(Object.assign({}, base, fields)));
  // A tty of a room that does not exist (a development build's test room): the new-game start in ~.
  const lost = parse({ tty: 'lab:3,15' });
  assert.equal(lost.tty, '');
  assert.deepEqual(orp.orpNewSim(lost).room, 'home');
  // A tty in /tmp with no gate switch: the switch is turned on, so the way back to /home is open.
  for (const tty of ['tmp:4,16', 'x11:64,18', 'ttyr:22,14']) {
    const prog = parse({ tty, switches: [] });
    assert.deepEqual(prog.switches, ['gate:38,7'], tty);
    const sim = orp.orpNewSim(prog);
    assert.equal(orp.orpSolid(Object.assign({}, sim, { room: 'gate' }), 42, 15), false, tty + ': the gate is open');
  }
  assert.deepEqual(parse({ tty: 'tmp:4,16', switches: ['gate:38,7', 'gate:38,7'] }).switches, ['gate:38,7'], 'once');
  // A tty in /home leaves the switches as they are.
  for (const tty of ['home:11,16', 'downloads:4,23', '']) assert.deepEqual(parse({ tty, switches: [] }).switches, [], tty || 'no tty');
});

test('orphan-process: of two saves the run New game made later wins (the larger id on a tie); within one run, more play time', () => {
  const p = (run, born, time) => Object.assign(orp.orpFreshProgress(), { run, born, time });
  assert.equal(orp.orpWins(p('b', 2, 1), p('a', 1, 999)), true, 'a later run, with less play time');
  assert.equal(orp.orpWins(p('a', 1, 999), p('b', 2, 1)), false);
  assert.equal(orp.orpWins(p('b', 1, 0), p('a', 1, 9)), true, 'born at once: the larger id');
  assert.equal(orp.orpWins(p('a', 1, 9), p('b', 1, 0)), false);
  assert.equal(orp.orpWins(p('a', 1, 10), p('a', 1, 9)), true, 'one run: more play time');
  assert.equal(orp.orpWins(p('a', 1, 9), p('a', 1, 9)), false, 'not the same');
});

test('orphan-process: completion counts visited rooms and collected items; m:ss and h:mm:ss times', () => {
  const prog = orp.orpFreshProgress();
  assert.equal(orp.orpCompletion(prog), 0);
  // 15 rooms + 16 items (12 man pages, 2 modules, 2 capabilities): 31.
  assert.equal(orp.orpKnownIds().items.length, 16);
  prog.visited = ['home', 'config', 'cache', 'docs', 'ssh'];
  prog.collected = ['man:fork', 'man:proc', 'man:top', 'man:chmod', 'docs:9,5', 'drop#1'];
  assert.equal(orp.orpCompletion(prog), Math.floor(100 * 10 / 31));
  prog.visited = WORLD.slice();
  prog.collected = orp.orpKnownIds().items;
  assert.equal(orp.orpCompletion(prog), 100);
  assert.deepEqual([0, 9.9, 61, 754.5, 3599, 3600, 3661, 36000].map(orp.orpFormatTime), ['0:00', '0:09', '1:01', '12:34', '59:59', '1:00:00', '1:01:01', '10:00:00']);
});

test('orphan-process: keys map to actions by their value, then by the physical key on other layouts', () => {
  const action = (key, code) => orp.orpKeyAction({ key, code });
  assert.deepEqual(['ArrowLeft', 'a', 'A', 'ArrowRight', 'd', 'ArrowUp', 'w', ' ', 'ArrowDown', 's', 'x', 'J', 'c', 'k', 'm', 'p', 'Escape', 'f', 'Enter'].map((k) => action(k, '')),
    ['left', 'left', 'left', 'right', 'right', 'jump', 'jump', 'jump', 'down', 'down', 'shoot', 'shoot', 'dash', 'dash', 'map', 'pause', 'pause', 'fullscreen', 'confirm']);
  assert.equal(action('ф', 'KeyA'), 'left');
  assert.equal(action('ч', 'KeyX'), 'shoot');
  assert.equal(action('q', 'KeyQ'), null);
  assert.equal(action(undefined, 'KeyA'), null);
  assert.equal(action('toString', 'constructor'), null);
});

// ── Pages ────────────────────────────────────────────────────────────────────

// Where each sprite sits in the atlas (the layout depends only on the art).
const ATLAS = orp.orpBuildAtlas().map;
const SPRITE_AT = new Map(Object.entries(ATLAS).map(([name, cell]) => [cell.x + ',' + cell.y, name]));

// One mocked clock for timers, performance.now(), the wall clock (Date.now,
// WALL + performance.now()) and animation frames (a frame every 16 ms with
// the time as its timestamp), and a seeded Math.random.  reload() drops the
// timers and frames of the page that goes away.
function makeClock(t) {
  let perf = 1000;
  let frames = [];
  let nextFrame = 1;
  const enable = () => t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    enable();
  } catch (error) {
    t.mock.timers.reset();
    enable();
  }
  t.mock.method(performance, 'now', () => perf);
  t.mock.method(Date, 'now', () => WALL + perf);
  t.mock.method(Math, 'random', seeded(7));
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
        t.mock.timers.tick(1);
        if (perf % 16 === 0) clock.flush();
      }
      return clock;
    },
    // A frame at time ts (any number: a display's own rate), timers left
    // alone.
    frameAt(ts) {
      perf = ts;
      clock.flush();
      return clock;
    },
    now: () => perf,
    // Time passing with no frame at all (a frozen or throttled tab).
    stall(ms) {
      perf += ms;
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

// The canvases the game makes, in order: the atlas, its mirror, the /home and
// /tmp backdrops.
function watchCanvases(t) {
  const made = [];
  const original = document.createElement;
  t.mock.method(document, 'createElement', (tag) => {
    const el = original(tag);
    if (tag === 'canvas') made.push(el);
    return el;
  });
  return made;
}

// What a player sees and does.  The canvas context records the last drawing:
// sprites by name, backdrops and rectangles.
function pageView(els, made, restore, page) {
  const canvas = els['orp-canvas'];
  const ctx = canvas.getContext('2d');
  let drawn = [];
  ctx.setTransform = () => { drawn = []; };
  ctx.drawImage = (src, sx, sy, sw, sh, dx, dy) => {
    if (sw === undefined) drawn.push({ kind: 'backdrop', area: made.indexOf(src) === 2 ? 'home' : 'tmp', x: sx });
    else drawn.push({ kind: 'sprite', name: SPRITE_AT.get(sx + ',' + sy), flip: src === made[1], x: dx, y: dy });
  };
  ctx.fillRect = (x, y, w, h) => drawn.push({ kind: 'rect', x, y, w, h, style: ctx.fillStyle });
  const v = {
    els,
    canvas,
    page,
    restore,
    el: (name) => els['orp-' + name],
    text: (name) => els['orp-' + name].textContent,
    hidden: (name) => els['orp-' + name].classList.contains('orp-hidden'),
    drawn: () => drawn,
    sprites: () => drawn.filter((d) => d.kind === 'sprite'),
    hero: () => drawn.filter((d) => d.kind === 'sprite' && /^hero/.test(d.name)).pop(),
    chips: (colour) => drawn.filter((d) => d.kind === 'rect' && d.w === 5 && d.h === 7 && d.y === 4 && d.style === colour).length,
    press(key, props) {
      if (document.activeElement !== canvas) focusElement(canvas, { keyboard: true });
      return pressKey(key, Object.assign({ target: canvas }, props));
    },
    release: (key) => canvas.dispatchEvent(keyEvent(key, { type: 'keyup' })),
    click: (name) => els['orp-' + name].click(),
    toast: () => (els['orp-toast'].classList.contains('orp-show') ? els['orp-toast'].textContent : null),
    message: () => (els['orp-msg'].classList.contains('orp-hidden') ? null : els['orp-msg-title'].textContent + ': ' + els['orp-msg-text'].textContent),
    save: () => JSON.parse(localStorage.getItem(SAVE_KEY))
  };
  return v;
}

function boot(t, options) {
  const made = watchCanvases(t);
  const page = createPage(htmlPageSpec(HTML));
  const v = pageView(page.els, made, null, page);
  const b = bootLikeBrowser(SCRIPT, page, options);
  v.restore = b.restore;
  v.ready = b.ready;
  return v;
}

// The page as a browser loads it, after writing storage, with a mocked clock.
function openPage(t, { save, options } = {}) {
  const clock = makeClock(t);
  if (save !== undefined) localStorage.setItem(SAVE_KEY, typeof save === 'string' ? save : JSON.stringify(save));
  return { clock, v: boot(t, options) };
}

// A reload: the old page, its timers and frames go away, storage stays.
function reload(t, clock, v) {
  clock.reload();
  v.restore();
  return boot(t);
}

// A page whose game state a test can set: the script loaded as a module (its
// exports reach the running game), its init run on a page from index.html.
function openModule(t, save) {
  const clock = makeClock(t);
  if (save !== undefined) localStorage.setItem(SAVE_KEY, typeof save === 'string' ? save : JSON.stringify(save));
  const made = watchCanvases(t);
  const page = createPage(htmlPageSpec(HTML));
  const v = pageView(page.els, made, null, page);
  const loaded = loadWithPage(SCRIPT, page, { keep: true });
  loaded.exports.orpInit();
  v.restore = loaded.restore;
  v.g = loaded.exports;
  v.rt = loaded.exports.orpRuntime;
  // Puts a game state on screen (playing, focused) and draws it.
  v.show = (sim, screen = 'play') => {
    v.rt.sim = sim;
    v.rt.screen = screen;
    if (document.activeElement === v.canvas) fire(v.canvas, 'focus');
    else focusElement(v.canvas);
    return v;
  };
  return { clock, v };
}

function startNewGame(v) {
  v.click('new');
  assert.equal(document.activeElement, v.canvas, 'the canvas has the keys');
}

test('orphan-process: loading the script under Node runs no init: no lookup, listener, timer, frame or save', (t) => {
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const frameSpy = t.mock.method(globalThis, 'requestAnimationFrame');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.orpInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(frameSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('orphan-process: a first visit shows the title with Continue off, builds the art once, writes nothing and binds every listener once', (t) => {
  const { clock, v } = openPage(t);
  assert.equal(v.hidden('start'), false);
  for (const name of ['paused', 'end', 'focus', 'msg', 'warning']) assert.equal(v.hidden(name), true, name);
  assert.equal(v.el('continue').disabled, true);
  assert.equal(v.text('new'), 'New game');
  assert.equal(localStorage.length, 0);
  assert.equal(clock.pending(), 0, 'no loop on the title screen');
  assert.deepEqual(v.drawn().map((d) => d.kind + ':' + d.area + ':' + d.x), ['backdrop:home:0', 'backdrop:home:480']);
  for (const [name, type] of [['canvas', 'keydown'], ['canvas', 'keyup'], ['canvas', 'focus'], ['canvas', 'blur'], ['new', 'click'],
    ['continue', 'click'], ['focus-button', 'click'], ['resume', 'click'], ['end-button', 'click']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(document), 2);
  for (const type of ['visibilitychange', 'fullscreenchange']) assert.equal(listenerCount(document, type), 1, type);
  assert.equal(listenerCount(window), 3);
  for (const type of ['resize', 'storage', 'pagehide']) assert.equal(listenerCount(window, type), 1, type);
  assert.equal(listenerCount(v.el('stage')), 0, 'keys go to the canvas only, so the overlay buttons keep theirs');
});

test('orphan-process: while the page is still loading the game waits for DOMContentLoaded, and init runs once', (t) => {
  const { v } = openPage(t, { save: SAMPLE_SAVE, options: { readyState: 'loading' } });
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(v.canvas, 'keydown'), 0);
  assert.equal(v.el('continue').disabled, true, 'nothing ran yet');
  v.ready();
  assert.equal(v.el('continue').disabled, false);
  assert.equal(listenerCount(v.canvas, 'keydown'), 1);
  resetStubs();
  makeClock(t);
  const { exports: fresh, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  fresh.orpInit();
  fresh.orpInit();
  assert.equal(listenerCount(els['orp-canvas'], 'keydown'), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
});

test('orphan-process: New game starts at once without a save: the canvas has the keys, the loop runs, the HUD shows and the first room is saved', (t) => {
  const { clock, v } = openPage(t);
  startNewGame(v);
  assert.equal(v.hidden('start'), true);
  assert.equal(v.hidden('focus'), true);
  assert.equal(clock.pending(), 1);
  // A new run: a 6-digit id and the wall-clock time New game was pressed (performance.now() 1000).
  const saved = v.save();
  assert.match(saved.run, /^[0-9a-z]{6}$/);
  assert.equal(localStorage.getItem(SAVE_KEY), JSON.stringify({
    v: 2, run: saved.run, born: WALL + 1000, tty: '', maxRss: 5, maxCpu: 100, xp: 0, nice: 19, abilities: [], collected: [], switches: [],
    walls: [], boss: false, ended: false, visited: ['home'], time: 0, deaths: 0
  }));
  clock.advance(32);
  assert.equal(v.hero().name, 'heroIdle1');
  // Standing on the floor of ~ (row 16), the camera at the bottom of the 20-row room.
  assert.equal(v.hero().y, 17 * T - HERO_H - 2 - (20 * T - H));
  assert.equal(v.chips('#f472b6'), 5, 'five RSS chips');
  assert.ok(v.sprites().some((d) => d.name === 'ttyOff'), 'the tty is not lit before it is touched');
  assert.ok(v.sprites().some((d) => d.name === 'groundTop'));
  assert.ok(v.drawn().some((d) => d.kind === 'backdrop' && d.area === 'home'));
});

test('orphan-process: keys work only while the canvas has the focus: they move the hero, never scroll the page, and leave Ctrl/Alt/Meta alone', (t) => {
  const { clock, v } = openPage(t);
  startNewGame(v);
  clock.advance(64);
  const x0 = v.hero().x;
  // Arrows and Space are the game's while it has the focus.
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', ' ']) {
    assert.equal(v.press(key).defaultPrevented, true, key);
    v.release(key);
  }
  // Modifiers, composing, handled and unknown keys are left alone.
  for (const props of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    assert.equal(v.press('ArrowRight', props).defaultPrevented, false, JSON.stringify(props));
  }
  const handled = keyEvent('ArrowRight', { target: v.canvas });
  handled.preventDefault();
  v.canvas.dispatchEvent(handled);
  assert.equal(v.press('q').defaultPrevented, false);
  assert.equal(v.press(undefined).defaultPrevented, false);
  clock.advance(200);
  assert.ok(Math.abs(v.hero().x - x0) < 1, 'nothing moved the hero');
  // A held key moves it until its keyup.
  v.press('d');
  clock.advance(500);
  const moved = v.hero().x;
  assert.ok(moved > x0 + 20, 'moved right: ' + (moved - x0));
  v.release('D');
  v.release('Shift');
  // Elsewhere on the page the keys stay with the page, and the hero stands still.
  const field = v.page.add('host-field', 'input');
  focusElement(field);
  assert.equal(v.hidden('focus'), false, 'Click to play shows');
  assert.equal(clock.pending(), 0, 'the game stands still');
  assert.equal(pressKey('ArrowLeft', { target: field }).defaultPrevented, false);
  assert.equal(pressKey(' ').defaultPrevented, false);
  // Click to play gives the keys back.
  v.click('focus-button');
  assert.equal(document.activeElement, v.canvas);
  assert.equal(v.hidden('focus'), true);
  assert.equal(clock.pending(), 1);
});

test('orphan-process: losing the focus lets go of held keys and saves; a click on the canvas itself resumes', (t) => {
  const { clock, v } = openPage(t);
  startNewGame(v);
  v.press('ArrowRight');
  clock.advance(300);
  localStorage.removeItem(SAVE_KEY);
  focusElement(document.body);
  fire(v.canvas, 'blur');
  assert.ok(v.save().time > 0.2, 'saved with its play time');
  const x = v.hero().x;
  clock.advance(300);
  assert.equal(v.hero().x, x, 'frozen');
  fire(v.canvas, 'focus');
  clock.advance(300);
  const stopped = v.hero().x;
  assert.ok(stopped - x < 8, 'it only slows down to a stop');
  clock.advance(300);
  assert.equal(v.hero().x, stopped, 'the right key was let go');
});

test('orphan-process: P and Esc pause and resume; the pause screen lists the man pages found; a hidden tab pauses and stays paused', (t) => {
  const { clock, v } = openPage(t, { save: SAMPLE_SAVE });
  v.click('continue');
  clock.advance(48);
  v.press('p');
  assert.equal(v.hidden('paused'), false);
  assert.equal(clock.pending(), 0);
  assert.equal(v.text('man-count'), 'Man pages found: 1 of 12.');
  assert.deepEqual(v.el('man-list').children.map((li) => li.textContent), ['fork(2) fork() creates a new process by duplicating the calling one; the child gets its own PID.']);
  assert.equal(v.el('man-list').children[0].children[0].className, 'orp-man-name');
  v.press('p', { repeat: true });
  assert.equal(v.hidden('paused'), false, 'a held P acts once');
  v.press('Escape');
  assert.equal(v.hidden('paused'), true);
  assert.equal(clock.pending(), 1);
  v.press('Escape');
  v.click('resume');
  assert.equal(v.hidden('paused'), true);
  assert.equal(document.activeElement, v.canvas);
  // A hidden tab pauses and saves; shown again it waits on the pause screen.
  localStorage.removeItem(SAVE_KEY);
  setVisibility('hidden', t);
  assert.equal(v.hidden('paused'), false);
  assert.ok(v.save());
  setVisibility('visible', t);
  assert.equal(v.hidden('paused'), false);
  assert.equal(clock.pending(), 0);
  // Hidden while paused, nothing changes; shown in play, the loop goes on.
  setVisibility('hidden', t);
  v.click('resume');
  assert.equal(clock.pending(), 0, 'no frames in a hidden tab');
  setVisibility('visible', t);
  assert.equal(clock.pending(), 1);
});

test('orphan-process: M opens the map over a stopped game and closes it; P from the map pauses', (t) => {
  const { clock, v } = openPage(t, { save: SAMPLE_SAVE });
  v.click('continue');
  clock.advance(48);
  v.press('m');
  assert.equal(clock.pending(), 0);
  const texts = v.drawn().filter((d) => d.kind === 'rect');
  assert.ok(texts.some((d) => d.w === 56 && d.h === 28 && d.style === '#e2e8f0'), 'the current room is marked');
  assert.ok(texts.some((d) => d.w === 54 && d.h === 26 && d.style === '#111827'), 'an unvisited room is dark');
  assert.ok(texts.some((d) => d.w === 54 && d.h === 26 && d.style === '#7c2d12'), 'a visited /tmp room is lit');
  assert.equal(v.sprites().length, 0, 'no world behind the map');
  v.press('m');
  assert.equal(clock.pending(), 1);
  clock.advance(32);
  assert.ok(v.hero());
  v.press('m');
  v.press('p');
  assert.equal(v.hidden('paused'), false);
  v.press('m');
  assert.equal(v.hidden('paused'), false, 'no map from the pause screen');
});

test('orphan-process: F toggles fullscreen on the stage where the browser has the API, and is silently ignored where not', (t) => {
  const { v } = openPage(t);
  startNewGame(v);
  v.press('f');
  const stage = v.el('stage');
  const requests = [];
  stage.requestFullscreen = () => {
    requests.push('request');
    return Promise.reject(new Error('denied'));
  };
  v.press('f');
  document.fullscreenElement = stage;
  t.after(() => { delete document.fullscreenElement; delete document.exitFullscreen; });
  v.press('f');
  document.exitFullscreen = () => {
    requests.push('exit');
  };
  v.press('f');
  delete document.fullscreenElement;
  stage.requestFullscreen = () => {
    requests.push('old');
  };
  v.press('f');
  assert.deepEqual(requests, ['request', 'exit', 'old']);
});

test('orphan-process: fullscreen sizes the canvas to the largest whole multiple of 480 x 270, follows a resize and leaves no size behind', (t) => {
  const { v } = openModule(t);
  const size = v.g.orpFullscreenSize;
  assert.deepEqual(size(1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(size(2560, 1440), { width: 2400, height: 1350 });
  assert.deepEqual(size(3840, 2160), { width: 3840, height: 2160 });
  assert.deepEqual(size(1366, 768), { width: 960, height: 540 });
  assert.deepEqual(size(1080, 1920), { width: 960, height: 540 }, 'a portrait screen: limited by the width');
  assert.deepEqual(size(479, 1000), { width: 479, height: 269 }, 'below x1 the largest 16:9 that fits');
  assert.deepEqual(size(400, 180), { width: 320, height: 180 });
  const stage = v.el('stage');
  const style = v.canvas.style;
  t.after(() => { delete document.fullscreenElement; });
  stage.clientWidth = 1920;
  stage.clientHeight = 1080;
  document.fullscreenElement = stage;
  fire(document, 'fullscreenchange');
  assert.deepEqual([style.width, style.height], ['1920px', '1080px'], 'not the 480 px intrinsic size');
  stage.clientWidth = 2560;
  stage.clientHeight = 1440;
  fire(window, 'resize');
  assert.deepEqual([style.width, style.height], ['2400px', '1350px']);
  // Another element in fullscreen is not the stage: no size.
  document.fullscreenElement = v.canvas;
  fire(window, 'resize');
  assert.deepEqual([style.width, style.height], ['', '']);
  document.fullscreenElement = stage;
  fire(document, 'fullscreenchange');
  delete document.fullscreenElement;
  fire(document, 'fullscreenchange');
  assert.deepEqual([style.width, style.height], ['', ''], 'back to the page size');
  fire(window, 'resize');
  assert.deepEqual([style.width, style.height], ['', '']);
});

test('orphan-process: a man page shows its name and sentence in the message box; Enter closes it, or 4.5 s', (t) => {
  const { clock, v } = openModule(t);
  const sim = v.g.orpNewSim(v.g.orpFreshProgress());
  v.show(edit(sim, (s) => { s.hero.x = 39 * T + 3; s.hero.y = 7 * T - HERO_H; }));
  clock.advance(48);
  assert.equal(v.message(), 'fork(2): fork() creates a new process by duplicating the calling one; the child gets its own PID.');
  assert.equal(v.save().collected[0], 'man:fork');
  v.press('Enter');
  assert.equal(v.message(), null);
  v.press('Enter', { repeat: true });
  v.rt.sim = edit(v.rt.sim, (s) => { s.hero.x = 11 * T + 3; s.hero.y = 17 * T - HERO_H; s.hero.vy = 0; });
  clock.advance(48);
  assert.equal(v.message(), 'tty: Checkpoint saved: a killed process restarts here with full RSS.');
  assert.equal(v.save().tty, 'home:11,16');
  assert.ok(v.sprites().some((d) => d.name === 'ttyOn'));
  clock.advance(4400);
  assert.notEqual(v.message(), null);
  clock.advance(200);
  assert.equal(v.message(), null, 'gone after 4.5 s');
});

test('orphan-process: the drawing shows signals, effects, every entity, the blinking hero, the room banner, the /tmp sweep bar and the death flash', (t) => {
  const { v } = openModule(t);
  const g = v.g;
  const prog = Object.assign(g.orpFreshProgress(), { tty: 'tmp:4,16', abilities: ['kill', 'nice'], switches: ['gate:38,7'] });
  let sim = g.orpNewSim(prog);
  v.show(sim, 'pause');
  const banner = v.drawn().filter((d) => d.kind === 'rect' && d.y >= 23 && d.y < 28 && d.style === '#e2e8f0');
  assert.ok(banner.length > 10, 'the room title under the HUD');
  assert.ok(v.drawn().some((d) => d.kind === 'backdrop' && d.area === 'tmp'));
  // The sweep bar: amber while counting down, red while the crates are gone.
  const bar = (style) => v.drawn().filter((d) => d.kind === 'rect' && d.h === 5 && d.y === 5 && d.style === style);
  assert.equal(bar('#f59e0b').length, 1);
  v.show(edit(sim, (s) => { s.swept = true; s.sweep = 21.5; s.roomT = 9; }), 'pause');
  assert.deepEqual(bar('#ef4444').map((d) => d.w), [15], 'half of the 3 s left');
  assert.ok(!v.drawn().some((d) => d.kind === 'rect' && d.y >= 23 && d.y < 28 && d.style === '#e2e8f0'), 'the banner is gone');
  assert.ok(!v.sprites().some((d) => d.name === 'crateTemp'), 'no temporary crates while swept');
  // Entities, a signal and an effect.
  const ent = (type, x, y, extra) => Object.assign({ id: type, type, x, y, w: 12, h: 12, vx: 0, vy: 0, hp: 1, face: -1, t: 0, flash: 0, cd: 1, parent: '' }, extra);
  sim = edit(sim, (s) => {
    s.ents = [ent('bug', 60, 200), ent('daemon', 80, 200), ent('zombie', 100, 200), ent('turret', 120, 200, { face: 1 }), ent('shot', 140, 200),
      ent('man', 160, 200), ent('chip', 180, 200), ent('module', 200, 200), ent('capKill', 220, 200), ent('capNice', 240, 200), ent('tty', 260, 200, { id: 'tmp:4,16' })];
    s.sigs = [{ x: 90, y: 210, w: 10, h: 4, vx: -240, dist: 0 }];
    s.fx = [{ k: 'spark', x: 10, y: 10, t: 0.1 }, { k: 'reap', x: 10, y: 10, t: 0.4 }, { k: 'dust', x: 10, y: 10, t: 0 }];
    s.roomT = 9;
  });
  v.show(sim, 'pause');
  const names = v.sprites().map((d) => d.name);
  for (const name of ['bug1', 'daemon1', 'zombie1', 'turret1', 'turretShot', 'man', 'chip', 'module', 'capKill', 'capNice', 'ttyOn', 'signal1', 'spark2', 'reap3', 'dust1']) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(v.sprites().find((d) => d.name === 'signal1').flip, true, 'a signal flying left is mirrored');
  assert.equal(v.sprites().find((d) => d.name === 'turret1').flip, false);
  assert.equal(v.sprites().find((d) => d.name === 'bug1').flip, true);
  // The hero blinks while invulnerable: drawn on odd tenths only.
  v.show(edit(sim, (s) => { s.hero.inv = 0.55; }), 'pause');
  assert.ok(v.hero());
  v.show(edit(sim, (s) => { s.hero.inv = 0.45; }), 'pause');
  assert.equal(v.hero(), undefined);
  // The death flash, with the hero drawn dead.
  v.show(edit(sim, (s) => { s.mode = 'dead'; s.deadT = 0.4; s.hero.inv = 1; s.rss = 0; }), 'pause');
  assert.equal(v.hero().name, 'heroDead2');
  assert.ok(v.drawn().some((d) => d.kind === 'rect' && d.w === W && d.h === H && d.style === 'rgba(239, 68, 68, 0.300)'));
  assert.equal(v.chips('#f472b6'), 0);
  assert.equal(v.chips('#3b1030'), 5);
  // Unknown characters in the pixel font are blanks; known ones are drawn.
  const pixels = [];
  const ctx = { fillRect: (x, y) => pixels.push(x + ',' + y) };
  assert.equal(g.orpText(ctx, '?', 0, 0, '#fff'), 4);
  assert.equal(pixels.length, 0);
  g.orpText(ctx, 'i', 0, 0, '#fff');
  assert.equal(pixels.length, '111010010010111'.split('1').length - 1);
});

test('orphan-process: the boss draws by its state, mirrored to face the hero, with its HP bar at the bottom once awake; temp files and its wreck draw too', (t) => {
  const { v } = openModule(t);
  const g = v.g;
  const sim = g.orpNewSim(Object.assign(g.orpFreshProgress(), { tty: 'arena:5,14', abilities: ['kill'] }));
  const boss = (s) => s.ents.find((e) => e.type === 'boss');
  const bar = () => v.drawn().filter((d) => d.kind === 'rect' && d.y === H - 15 && d.h === 5);
  const drawnBoss = () => v.sprites().find((d) => /^boss/.test(d.name));
  v.show(sim, 'pause');
  assert.equal(drawnBoss().name, 'bossIdle');
  assert.equal(bar().length, 0, 'no bar while it sleeps');
  const looks = { intro: 'bossIdle', windup: 'bossSweep1', sweep: 'bossSweep1', warn: 'bossIdle', files: 'bossIdle', core: 'bossOpen', rage: 'bossHurt' };
  for (const [state, name] of Object.entries(looks)) {
    v.show(edit(sim, (s) => { Object.assign(boss(s), { state, timer: 0, hp: 9 }); s.roomT = 9; }), 'pause');
    assert.equal(drawnBoss().name, name, state);
  }
  // 9 of 12 HP, in the boss's pink, behind its name.
  assert.deepEqual(bar().map((d) => [d.w, d.style]), [[182, '#3b1030'], [Math.round(182 * 9 / 12), '#f472b6']]);
  assert.ok(v.drawn().some((d) => d.kind === 'rect' && d.w === 240 && d.y === H - 19), 'the panel');
  // Facing the hero on its left it is mirrored; a hit flashes it.
  v.show(edit(sim, (s) => { Object.assign(boss(s), { state: 'core', face: 1 }); }), 'pause');
  assert.equal(drawnBoss().flip, false);
  v.show(edit(sim, (s) => { Object.assign(boss(s), { state: 'core', face: -1, flash: 0.1 }); }), 'pause');
  assert.deepEqual([drawnBoss().name, drawnBoss().flip], ['bossHurt', true]);
  v.show(edit(sim, (s) => {
    s.ents.push(Object.assign({}, boss(s), { id: 'wreck', type: 'wreck' }), { id: 'f', type: 'file', x: 100, y: 16, w: 10, h: 12, vx: 0, vy: 0, hp: 0, face: -1, t: 0, flash: 0, cd: 1, parent: '' });
  }), 'pause');
  const names = v.sprites().map((d) => d.name);
  assert.ok(names.includes('bossDead') && names.includes('tempFile'));
});

test('orphan-process: the map lays out the 15 rooms by area, /home above /tmp, the two shafts as tall boxes, each visited room lit with its name', (t) => {
  const { v } = openModule(t);
  const g = v.g;
  const all = g.orpNewSim(Object.assign(g.orpFreshProgress(), { tty: TTY1, visited: WORLD.slice() }));
  v.show(all, 'map');
  const rects = v.drawn().filter((d) => d.kind === 'rect');
  const outer = rects.filter((d) => d.w % 64 === 56 && d.h % 36 === 28);
  assert.equal(outer.length, 15);
  assert.deepEqual(outer.filter((d) => d.h === 64).map((d) => [d.x, d.y]), [[20 + 2 * 64, 48], [20 + 3 * 64, 48 + 3 * 36]], '.cache and systemd-private');
  assert.deepEqual(outer.filter((d) => d.style === '#e2e8f0').map((d) => [d.x, d.y]), [[20 + 4 * 64, 48 + 3 * 36]], 'tty1 is the current room');
  assert.equal(outer.filter((d) => d.style === '#34d399').length, 8, 'the /home rooms in green');
  assert.equal(outer.filter((d) => d.style === '#f59e0b').length, 6, 'and /tmp in amber');
  // Every lit box has its name in it (the labels of .local/bin, the gate and systemd-private included).
  for (const box of outer) {
    assert.ok(rects.some((d) => d.w === 1 && d.x > box.x && d.x < box.x + box.w && d.y > box.y && d.y < box.y + box.h), box.x + ',' + box.y);
  }
  assert.equal(orp.orpRooms.sysd.label, 'systemd-priv');
});

test('orphan-process: the end trigger shows the episode screen with time, deaths, man pages and completion; Enter or the button goes back to the title', (t) => {
  const { clock, v } = openModule(t);
  const g = v.g;
  const prog = Object.assign(g.orpFreshProgress(), {
    tty: 'tmp:4,16', abilities: ['kill', 'nice'], collected: ['man:fork', 'man:tmpfiles'], visited: ['home', 'docs', 'tmp'], boss: true,
    time: 125.5, deaths: 2
  });
  let sim = g.orpNewSim(prog);
  // The way onward, behind the arena's upper cracked wall.
  sim = edit(sim, (s) => { s.room = 'arena'; s.area = 'tmp'; s.ents = []; s.hero.x = 31 * T + 3; s.hero.y = 13 * T - HERO_H; s.prog.visited.push('arena'); });
  v.show(sim);
  clock.advance(100);
  assert.equal(v.hidden('end'), false);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(v.el('end-stats').children.map((li) => li.textContent), ['Time 2:05', 'Deaths 2', 'Man pages 2 of 12', 'Completion ' + Math.floor(100 * 6 / 31) + ' %']);
  assert.equal(v.save().time > 125.5, true, 'saved at the end');
  v.press('Enter');
  assert.equal(v.hidden('start'), false);
  assert.equal(v.el('continue').disabled, false);
  v.show(sim);
  clock.advance(100);
  v.click('end-button');
  assert.equal(v.hidden('start'), false);
  assert.equal(v.rt.sim, null);
});

test('orphan-process: Continue resumes a saved game at its tty; a game survives a reload with everything it collected', (t) => {
  const { clock, v } = openPage(t, { save: SAMPLE_SAVE });
  assert.equal(v.el('continue').disabled, false);
  v.click('continue');
  clock.advance(48);
  assert.ok(v.drawn().some((d) => d.kind === 'backdrop' && d.area === 'tmp'), 'at the tty of /tmp');
  assert.equal(v.chips('#f472b6'), 6, 'full RSS of 6');
  assert.ok(!v.sprites().some((d) => d.name === 'capNice'), 'a collected pedestal stays empty');
  // A save in the current format is written back byte for byte (with the time played since).
  v.press('p');
  const saved = v.save();
  assert.ok(saved.time > 754.5);
  assert.equal(JSON.stringify(Object.assign(saved, { time: 754.5 })), SAMPLE_SAVE);
  const again = reload(t, clock, v);
  assert.equal(again.el('continue').disabled, false);
  again.click('continue');
  clock.advance(48);
  again.press('p');
  assert.equal(again.text('man-count'), 'Man pages found: 1 of 12.');
  // Leaving the page saves too.
  localStorage.removeItem(SAVE_KEY);
  fire(window, 'pagehide');
  assert.ok(again.save());
});

test('orphan-process: a corrupt or partial save never breaks the page: Continue is off for no save, and a partial one falls back field by field', (t) => {
  for (const text of ['not json', '[1,2]', 'null', '7', SAMPLE_SAVE.replace('"v":2', '"v":1')]) {
    const { v } = openPage(t, { save: text });
    assert.equal(v.el('continue').disabled, true, text);
    resetStubs();
  }
  const { clock, v } = openPage(t, { save: '{"v":2,"tty":"nowhere:1,1","maxRss":"lots","abilities":["kill"],"visited":["home","docs"]}' });
  v.click('continue');
  clock.advance(48);
  assert.ok(v.drawn().some((d) => d.kind === 'backdrop' && d.area === 'home'), 'back at the start of ~');
  assert.equal(v.chips('#f472b6'), 5);
  v.press('p');
  assert.deepEqual(v.save().abilities, ['kill']);
  assert.deepEqual(v.save().visited, ['home', 'docs']);
  // A save that vanished before Continue: Continue turns off.
  const second = reload(t, clock, v);
  localStorage.removeItem(SAVE_KEY);
  second.click('continue');
  assert.equal(second.el('continue').disabled, true);
  assert.equal(second.hidden('start'), false);
});

test('orphan-process: New game over a save asks for a second press within 4 s, naming what would be lost', (t) => {
  const { clock, v } = openPage(t, { save: SAMPLE_SAVE });
  v.click('new');
  assert.equal(v.hidden('start'), false);
  assert.equal(v.text('new'), 'Confirm new game');
  assert.equal(v.toast(), 'Press New game again within 4 s to replace your saved game (nice 17, 12:34 of play).');
  clock.advance(3000);
  assert.equal(v.toast(), null, 'the toast goes after 3 s');
  clock.advance(1000);
  assert.equal(v.text('new'), 'New game', 'the confirmation ran out');
  v.click('new');
  v.click('new');
  assert.equal(v.hidden('start'), true);
  assert.equal(v.save().nice, 19, 'a fresh game replaced the save');
  assert.deepEqual(v.save().visited, ['home']);
  // Continue after a confirmation drops it.
  const again = reload(t, clock, v);
  again.click('new');
  again.click('continue');
  assert.equal(again.text('new'), 'New game');
});

test('orphan-process: blocked storage never stops the game, and the warning names the key; full storage still reads the save', (t) => {
  blockStorage('access', t);
  const { clock, v } = openPage(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Storage is blocked or full (SecurityError): orp-state is not saved on this page. The game plays on, but a reload starts from the title again.');
  startNewGame(v);
  clock.advance(500);
  assert.ok(v.hero());
  v.press('p');
  assert.equal(v.hidden('paused'), false);
  resetStubs();
  localStorage.setItem(SAVE_KEY, SAMPLE_SAVE);
  blockStorage('full', t);
  const full = openPage(t);
  assert.equal(full.v.hidden('warning'), true, 'reading works');
  assert.equal(full.v.el('continue').disabled, false);
  full.v.click('continue');
  full.v.press('p');
  assert.equal(full.v.text('warning'), 'Storage is blocked or full (QuotaExceededError): orp-state is not saved on this page. The game plays on, but a reload starts from the title again.');
  full.v.press('p');
  full.v.press('p');
  assert.equal(localStorage.getItem(SAVE_KEY), SAMPLE_SAVE, 'the old save is still there');
});

test('orphan-process: a save from a tab that played further is taken over instead of overwritten, at a save and through the storage event', (t) => {
  const { clock, v } = openPage(t, { save: SAMPLE_SAVE });
  v.click('continue');
  clock.advance(48);
  // Another tab saves 20 more minutes of play: this tab's next save takes it over.
  const newer = Object.assign(JSON.parse(SAMPLE_SAVE), { time: 2000, nice: 15, tty: 'home:11,16' });
  localStorage.setItem(SAVE_KEY, JSON.stringify(newer));
  v.press('p');
  assert.equal(v.toast(), 'Another tab played further (33:20 of play): this tab continues from its last tty.');
  assert.deepEqual(v.save(), Object.assign({ v: 1 }, newer), 'not overwritten');
  v.press('p');
  clock.advance(48);
  assert.ok(v.drawn().some((d) => d.kind === 'backdrop' && d.area === 'home'), 'now at the other tab\'s tty');
  // Through the storage event.
  localStorage.setItem(SAVE_KEY, JSON.stringify(Object.assign({}, newer, { time: 3000 })));
  fire(window, 'storage', { key: SAVE_KEY });
  assert.equal(v.toast(), 'Another tab played further (50:00 of play): this tab continues from its last tty.');
  // An older save from another tab is overwritten by this one.
  localStorage.setItem(SAVE_KEY, JSON.stringify(Object.assign({}, newer, { time: 5 })));
  fire(window, 'storage', { key: SAVE_KEY });
  fire(window, 'storage', { key: 'other' });
  v.press('p');
  assert.ok(v.save().time >= 3000);
  // On the title screen the event only turns Continue on or off.
  const title = reload(t, clock, v);
  localStorage.removeItem(SAVE_KEY);
  fire(window, 'storage', { key: SAVE_KEY });
  assert.equal(title.el('continue').disabled, true);
  localStorage.setItem(SAVE_KEY, SAMPLE_SAVE);
  fire(window, 'storage', { key: SAVE_KEY });
  assert.equal(title.el('continue').disabled, false);
});

test('orphan-process: the loop steps at 120 Hz, and a frame after a stall catches up 0.25 s at most', (t) => {
  const { clock, v } = openPage(t);
  startNewGame(v);
  clock.advance(48);
  v.press('ArrowRight');
  clock.advance(1000);
  const x = v.hero().x;
  // A second without frames: the next frame moves the hero at most 0.25 s at 96 px/s.
  clock.stall(1000).flush();
  const jump = v.hero().x - x;
  assert.ok(jump > 0 && jump <= 96 * 0.25 + 0.5, 'caught up at most 0.25 s: ' + jump);
  // A frame with no time passed steps nothing.
  const still = v.hero().x;
  clock.flush();
  clock.flush();
  assert.equal(v.hero().x, still);
});

test('orphan-process: each New game is a run with its own id and birth: a tab on an older run stops writing once another tab starts a new game, and a newer run overwrites an older one with more play time', (t) => {
  const { clock, v } = openPage(t, { save: SAMPLE_SAVE });
  v.click('continue');
  clock.advance(48);
  // Another tab presses New game (a later run) and plays 5 s: far less than this tab's 12:34.
  const other = Object.assign(JSON.parse(SAMPLE_SAVE), {
    run: 'zz0001', born: SAMPLE_BORN + 60000, tty: '', nice: 19, xp: 0, abilities: [], collected: [], switches: [], walls: [],
    ended: false, visited: ['home'], time: 5, deaths: 0
  });
  localStorage.setItem(SAVE_KEY, JSON.stringify(other));
  v.press('p');
  assert.equal(v.toast(), 'Another tab started a new game: this tab no longer saves. Reload the page to play that one.');
  assert.deepEqual(v.save(), other, 'not overwritten');
  assert.equal(v.text('man-count'), 'Man pages found: 1 of 12.', 'this tab plays on with its own game');
  clock.advance(3000);
  v.press('p');
  clock.advance(500);
  v.press('p');
  fire(window, 'storage', { key: SAVE_KEY });
  assert.equal(v.toast(), null, 'said once');
  assert.deepEqual(v.save(), other, 'still not overwritten');
  // Reloaded, Continue plays the other tab's game.
  const again = reload(t, clock, v);
  again.click('continue');
  clock.advance(48);
  again.press('p');
  assert.equal(again.text('man-count'), 'Man pages found: 0 of 12.');
  assert.equal(again.save().run, 'zz0001');
  // A New game here (born now, after both) overwrites an older run's save, even one with more play time.
  const fresh = reload(t, clock, v);
  fresh.click('new');
  fresh.click('new');
  clock.advance(48);
  const mine = fresh.save();
  assert.ok(mine.born > other.born && mine.run !== 'zz0001');
  clock.advance(3000);
  localStorage.setItem(SAVE_KEY, SAMPLE_SAVE);
  fresh.press('p');
  assert.equal(fresh.toast(), null);
  assert.equal(fresh.save().run, mine.run, 'overwritten');
});

test('orphan-process: a message that comes while another shows waits its turn: a man page that levels up keeps its full 4.5 s, then the level shows; the same message is never repeated', (t) => {
  const { clock, v } = openModule(t);
  const sim = v.g.orpNewSim(Object.assign(v.g.orpFreshProgress(), { xp: 10 }));
  v.show(edit(sim, (s) => { s.hero.x = 39 * T + 3; s.hero.y = 7 * T - HERO_H; }));
  clock.advance(48);
  const fork = 'fork(2): fork() creates a new process by duplicating the calling one; the child gets its own PID.';
  assert.equal(v.message(), fork);
  assert.equal(v.rt.sim.prog.nice, 18, 'the page gave a level');
  clock.advance(4400);
  assert.equal(v.message(), fork, 'the man page keeps its full time');
  clock.advance(200);
  assert.equal(v.message(), 'nice 18: Max CPU 110.');
  v.press('Enter');
  assert.equal(v.message(), null);
  // At the r-- door the refusal comes every 2 s: it shows once, it does not queue up behind itself.
  v.show(edit(v.rt.sim, (s) => { s.room = 'ssh'; s.ents = []; s.hero.x = 40 * T - HERO_W - 0.5; s.hero.y = 15 * T - HERO_H; s.hero.vy = 0; }));
  clock.advance(2500);
  assert.equal(v.message(), 'Permission denied: This door is r-- for you: it needs setuid, which no process here has yet.');
  assert.deepEqual(v.rt.messages, []);
  // Back to the title, nothing is left waiting.
  v.show(edit(sim, (s) => { s.hero.x = 39 * T + 3; s.hero.y = 7 * T - HERO_H; }));
  clock.advance(48);
  assert.equal(v.message(), 'Permission denied: This door is r-- for you: it needs setuid, which no process here has yet.');
  assert.deepEqual(v.rt.messages.map((m) => m.title), ['fork(2)', 'nice 18']);
  v.click('end-button');
  assert.deepEqual([v.message(), v.rt.messages.length], [null, 0]);
});

test('orphan-process: on the page a capability key without the capability shows its refusal once: held or pressed again while it shows, it does not queue up', (t) => {
  const { clock, v } = openModule(t);
  v.show(v.g.orpNewSim(v.g.orpFreshProgress()));
  clock.advance(500);
  assert.equal(v.message(), null);
  const kill = 'kill: Operation not permitted: You do not have the kill capability yet.';
  const renice = 'renice: Operation not permitted: You do not have the renice capability yet.';
  v.press('x');
  clock.advance(48);
  assert.equal(v.message(), kill);
  clock.advance(1000);
  v.release('x');
  clock.advance(48);
  v.press('j');
  clock.advance(48);
  v.release('j');
  v.press('x');
  clock.advance(48);
  v.release('x');
  assert.equal(v.message(), kill);
  assert.deepEqual(v.rt.messages, [], 'the same refusal never waits behind itself');
  // The dash's refusal waits its turn, once.
  v.press('c');
  clock.advance(48);
  v.release('c');
  v.press('k');
  clock.advance(48);
  v.release('k');
  assert.deepEqual(v.rt.messages.map((m) => m.title), ['renice: Operation not permitted']);
  v.press('Enter');
  assert.equal(v.message(), renice);
  assert.equal(v.rt.sim.cpu, 100, 'no CPU spent');
  assert.equal(v.rt.sim.sigs.length, 0);
});

// Back to last tty from the pause screen: what a reload and Continue do.
test('orphan-process: Back to last tty in the pause screen leaves the boss fight for tty1 with full RSS, not as a death; the arena is fresh again and the save keeps all but play time', (t) => {
  const { clock, v } = openModule(t);
  let sim = runUntil(arenaSim(), { right: true }, (s) => s.shut, 600);
  sim = edit(sim, (s) => { Object.assign(bossOf(s), { hp: 7, state: 'files' }); s.swept = true; s.rss = 2; s.prog.deaths = 2; s.prog.time = 300; });
  v.show(sim);
  clock.advance(48);
  v.press('p');
  assert.equal(v.rt.screen, 'pause');
  assert.equal(v.hidden('paused'), false);
  const before = v.save();
  assert.equal(before.tty, TTY1);
  v.rt.messages.push({ title: 'queued', text: 'a message left waiting' });
  v.rt.keys.right = true;
  v.click('back-tty');
  const back = v.rt.sim;
  assert.equal(v.rt.screen, 'play');
  assert.equal(v.hidden('paused'), true);
  assert.equal(document.activeElement, v.canvas, 'the canvas has the keys');
  assert.deepEqual([back.room, back.mode, back.rss, back.cpu, back.prog.deaths], ['ttyr', 'play', back.prog.maxRss, back.prog.maxCpu, 2]);
  assert.deepEqual(back.hero, orp.orpNewSim(back.prog).hero, 'standing at tty1');
  assert.deepEqual([v.message(), v.rt.messages.length], [null, 0]);
  assert.ok(Object.values(v.rt.keys).every((held) => !held), 'no key carries over');
  const after = v.save();
  assert.ok(after.time >= before.time);
  assert.deepEqual(Object.assign({}, after, { time: 0 }), Object.assign({}, before, { time: 0 }));
  // It runs on, without a death flash, and the play time counts on from where it was.
  clock.advance(1000);
  assert.equal(v.rt.sim.mode, 'play');
  assert.equal(v.rt.sim.prog.deaths, 2);
  assert.ok(v.rt.sim.prog.time > 300.9 && v.rt.sim.prog.time < 301.1, String(v.rt.sim.prog.time));
  // Into the arena again: the gate open, the boss asleep with full HP, the crates back.
  const again = runUntil(place(v.rt.sim, 37, 14), { right: true }, (s) => s.room === 'arena', 200);
  assert.deepEqual([again.shut, orp.orpSolid(again, 0, 14), again.swept], [false, false, false]);
  assert.deepEqual([bossOf(again).state, bossOf(again).hp], ['sleep', orp.orpConstants.BOSS_HP]);
});

test('orphan-process: Back to last tty with no tty touched yet goes to the new-game start, from any room, like Continue', (t) => {
  const { clock, v } = openModule(t);
  const fresh = v.g.orpFreshProgress();
  const sim = edit(place(v.g.orpNewSim(Object.assign({}, fresh, { tty: TTY1 })), 37, 14), (s) => { s.prog.tty = ''; s.rss = 1; });
  v.show(sim);
  clock.advance(48);
  assert.deepEqual([v.rt.sim.room, v.rt.sim.prog.tty], ['ttyr', ''], 'away from the start, no tty touched');
  v.press('Escape');
  assert.equal(v.rt.screen, 'pause');
  v.click('back-tty');
  const start = orp.orpNewSim(fresh);
  assert.deepEqual([v.rt.sim.room, v.rt.sim.hero, v.rt.sim.rss, v.rt.screen], ['home', start.hero, fresh.maxRss, 'play']);
  assert.equal(v.rt.sim.prog.deaths, 0);
  // Continue after a reload lands on the same spot.
  const again = reload(t, clock, v);
  again.click('continue');
  clock.advance(16);
  assert.equal(again.save().tty, '');
});

test('orphan-process: a message counts its 4.5 s only while the game runs: paused, on the map, in a hidden tab or without the focus it waits, and so does the one queued behind it; Enter still closes it', (t) => {
  const { clock, v } = openModule(t);
  const sim = v.g.orpNewSim(Object.assign(v.g.orpFreshProgress(), { xp: 10 }));
  v.show(edit(sim, (s) => { s.hero.x = 39 * T + 3; s.hero.y = 7 * T - HERO_H; }));
  clock.advance(48);
  const fork = 'fork(2): fork() creates a new process by duplicating the calling one; the child gets its own PID.';
  assert.equal(v.message(), fork);
  const stands = (why) => {
    clock.advance(10000);
    assert.equal(v.message(), fork, why);
    assert.deepEqual(v.rt.messages.map((m) => m.title), ['nice 18'], why + ': the level waits behind it');
  };
  clock.advance(1000);
  v.press('p');
  stands('paused');
  v.press('p');
  clock.advance(1000);
  v.press('m');
  stands('on the map');
  v.press('m');
  clock.advance(1000);
  setVisibility('hidden', t);
  stands('in a hidden tab');
  setVisibility('visible', t);
  v.click('resume');
  clock.advance(1000);
  focusElement(document.body);
  fire(v.canvas, 'blur');
  stands('without the focus');
  focusElement(v.canvas);
  // 4.45 s of play so far (less the frames a restarted loop forgets).
  clock.advance(400);
  assert.equal(v.message(), fork, 'the man page keeps its full time of play');
  clock.advance(400);
  assert.equal(v.message(), 'nice 18: Max CPU 110.');
  v.press('Enter');
  assert.deepEqual([v.message(), v.rt.messages.length], [null, 0]);
});

test('orphan-process: a reload between taking nice and its end screen still shows the end screen, once: the save says when it was shown', (t) => {
  const { clock, v } = openModule(t);
  v.show(place(arenaSim({ boss: true }), 14, 14));
  clock.advance(48);
  assert.deepEqual(v.save().abilities, ['kill', 'nice']);
  assert.equal(v.save().ended, false);
  assert.equal(v.hidden('end'), true, 'the end screen comes 2.5 s later');
  // Reloaded within those 2.5 s: Continue shows the end screen first, and saves that it did.
  const again = reload(t, clock, v);
  again.click('continue');
  assert.equal(again.hidden('end'), false);
  assert.equal(again.el('end-stats').children.length, 4);
  assert.equal(again.save().ended, true);
  assert.equal(document.activeElement, again.canvas, 'Enter closes it');
  again.press('Enter');
  assert.equal(again.hidden('start'), false);
  // Then Continue plays on with the dash.
  again.click('continue');
  clock.advance(48);
  assert.deepEqual([again.hidden('end'), again.hidden('start')], [true, true]);
  assert.ok(again.hero());
});

test('orphan-process: Continue is offered only when it resumes a game: with blocked storage the game is kept in memory and Continue resumes it within the page load; with full storage the newer game in memory wins over the stored one', (t) => {
  // To the end screen and back to the title.
  const toTitle = (v, clock) => {
    v.show(edit(v.rt.sim, (s) => { s.room = 'arena'; s.area = 'tmp'; s.ents = []; s.hero.x = 31 * T + 3; s.hero.y = 13 * T - HERO_H; }));
    clock.advance(100);
    assert.equal(v.hidden('end'), false);
    v.press('Enter');
    assert.equal(v.hidden('start'), false);
  };
  blockStorage('access', t);
  const { clock, v } = openModule(t);
  assert.equal(v.el('continue').disabled, true, 'nothing to resume');
  startNewGame(v);
  clock.advance(500);
  const run = v.rt.sim.prog.run;
  toTitle(v, clock);
  assert.equal(v.el('continue').disabled, false);
  v.click('continue');
  assert.equal(v.rt.screen, 'play');
  assert.equal(v.rt.sim.prog.run, run, 'the game of this page load');
  assert.ok(v.rt.sim.prog.time > 0.4);
  // Full storage: the save there is read, but the game played since lives in memory and wins.
  resetStubs();
  localStorage.setItem(SAVE_KEY, SAMPLE_SAVE);
  blockStorage('full', t);
  const full = openModule(t);
  full.v.click('continue');
  full.clock.advance(500);
  toTitle(full.v, full.clock);
  assert.equal(localStorage.getItem(SAVE_KEY), SAMPLE_SAVE, 'nothing was written');
  full.v.click('continue');
  assert.ok(full.v.rt.sim.prog.time > 754.5, 'the game in memory: ' + full.v.rt.sim.prog.time);
});

test('orphan-process: nothing in the HUD overlaps or leaves the 480 px screen at any value: 5 to 26 max RSS (chips up to 14, then rss/max and a bar), nice 19 to -20, every man page, any PID, in /home and /tmp', (t) => {
  const allMan = orp.orpMan.map((page) => 'man:' + page.key);
  const prog = (extra) => Object.assign(orp.orpFreshProgress(), extra);
  const problems = [];
  for (const area of ['home', 'tmp']) {
    for (let maxRss = 5; maxRss <= 26; maxRss++) {
      for (const nice of [19, 10, 9, 0, -9, -20]) {
        for (const collected of [[], allMan]) {
          for (const deaths of [0, 9, 99999, 1e6]) {
            const items = Object.entries(orp.orpHudLayout({ area, prog: prog({ maxRss, nice, collected, deaths }) }))
              .map(([name, box]) => Object.assign({ name }, box)).sort((a, b) => a.x - b.x);
            const at = area + ', max RSS ' + maxRss + ', nice ' + nice + ', ' + collected.length + ' man, ' + deaths + ' deaths: ';
            assert.equal(items.length, area === 'tmp' ? 11 : 9);
            items.forEach((box, i) => {
              if (box.x < 0 || box.x + box.w > W) problems.push(at + box.name + ' leaves the screen');
              if (i > 0 && items[i - 1].x + items[i - 1].w > box.x) problems.push(at + items[i - 1].name + ' overlaps ' + box.name);
            });
          }
        }
      }
    }
  }
  assert.deepEqual(problems, []);
  // Up to 14 the chips keep their place; the PID sits 12 px before the area.
  const five = orp.orpHudLayout({ area: 'tmp', prog: prog({}) });
  assert.deepEqual([five.rss, five.cpu, five.sweep, five.pid, five.area], [{ x: 19, w: 33 }, { x: 74, w: 40 }, { x: 264, w: 30 }, { x: 416, w: 32 }, { x: 460, w: 16 }]);
  // Drawn: every HUD pixel sits in its part's box, chips and the compact form alike.
  const { v } = openModule(t);
  for (const [area, maxRss, rss] of [['tmp', 26, 7], ['tmp', 15, 15], ['home', 14, 3], ['home', 5, 0]]) {
    const sim = edit(v.g.orpNewSim(prog({ tty: area === 'tmp' ? 'tmp:4,16' : '', maxRss, nice: -20, collected: allMan, deaths: 1e6 })), (s) => {
      s.rss = rss;
      s.roomT = 9;
    });
    v.show(sim, 'pause');
    const boxes = Object.values(v.g.orpHudLayout(sim));
    const hud = v.drawn().filter((d) => d.kind === 'rect' && d.y < 15 && !(d.x === 0 && d.w === W));
    assert.ok(hud.length > 100);
    for (const d of hud) assert.ok(boxes.some((b) => d.x >= b.x && d.x + d.w <= b.x + b.w), area + ' ' + maxRss + ': ' + JSON.stringify(d));
    const compact = maxRss > 14;
    assert.equal(v.chips('#f472b6') + v.chips('#3b1030'), compact ? 0 : maxRss, maxRss + ' chips');
    if (compact) {
      const rssBox = v.g.orpHudLayout(sim).rss;
      const bar = hud.filter((d) => d.h === 5 && d.y === 5 && d.style === '#f472b6' && d.x === rssBox.x + 24);
      assert.deepEqual(bar.map((d) => d.w), [Math.round(70 * rss / maxRss)], 'the RSS bar');
    }
  }
});

// The display rates a player may have.
const RATES = [60, 120, 144, 165];

// Plays frames at hz from the clock's time on (the canvas holding the
// right key), checking each render leaves the states alone, and returns
// what measure() read after each of the last n frames.
function framesAt(v, clock, hz, n, measure) {
  const t0 = clock.now();
  const out = [];
  const t1 = v.rt.sim.t;
  for (let i = 1; i <= n + 4; i++) {
    clock.frameAt(t0 + i * 1000 / hz);
    const states = JSON.stringify([v.rt.prev, v.rt.sim]);
    v.g.orpRender();
    assert.equal(JSON.stringify([v.rt.prev, v.rt.sim]), states, 'drawing leaves the states alone');
    if (i > 4) out.push(measure());
  }
  // (The first frame starts the clock of a loop that just started.)
  assert.ok(Math.abs(v.rt.sim.t - t1 - (n + 3) / hz) < 2 / 120, 'the game ran at 120 steps a second: ' + (v.rt.sim.t - t1));
  return out;
}

const deltas = (list) => list.slice(1).map((x, i) => x - list[i]);

test('orphan-process: at 60, 120, 144 and 165 Hz a hero running at constant speed moves on screen by the same amount every frame, to a screen pixel, with the camera standing or following', (t) => {
  const { clock, v } = openModule(t);
  v.canvas.clientWidth = 960;
  const g = v.g;
  for (const hz of RATES) {
    // The camera stands at the left end of ~: the hero crosses the screen at 96 px/s.
    const still = edit(g.orpNewSim(g.orpFreshProgress()), (s) => { s.hero.x = 5 * T + 3; s.hero.vx = RUN; s.ents = []; });
    v.show(still);
    v.press('ArrowRight');
    const xs = framesAt(v, clock, hz, 60, () => v.hero().x);
    assert.equal(v.rt.sim.cam.x, 0, 'the camera stood');
    for (const d of deltas(xs)) assert.ok(Math.abs(d - RUN / hz) <= 0.5 + 1e-9, hz + ' Hz: the hero moved ' + d + ' px in a frame, not ' + (RUN / hz).toFixed(3));
    assert.ok(Math.max(...deltas(xs)) - Math.min(...deltas(xs)) <= 0.5 + 1e-9, hz + ' Hz: ' + deltas(xs).join());
    for (const x of xs) assert.equal(Math.round(x * 2), x * 2, 'on a screen pixel (half a game pixel)');
    v.release('ArrowRight');
    // The camera follows along the long middle floor of Downloads (warmed up so it keeps pace): the hero stays put on
    // screen, the floor scrolls by the same amount every frame.
    let follow = edit(g.orpNewSim(Object.assign(g.orpFreshProgress(), { tty: 'downloads:4,23' })), (s) => {
      s.ents = [];
      s.hero.x = 14 * T + 3;
      s.hero.y = 18 * T - HERO_H;
      s.hero.vx = RUN;
    });
    follow = run(follow, { right: true }, 180);
    assert.equal(follow.hero.y, 18 * T - HERO_H);
    v.show(follow);
    v.press('ArrowRight');
    const floorY = 18 * T - follow.cam.y;
    const seen = framesAt(v, clock, hz, 60, () => [v.hero().x, Math.min(...v.sprites().filter((d) => d.name === 'groundTop' && d.y === floorY).map((d) => d.x))]);
    const hero = deltas(seen.map((p) => p[0]));
    const floor = deltas(seen.map((p) => p[1])).map((d) => (d > 8 ? d - 16 : d));
    for (const d of hero) assert.ok(Math.abs(d) <= 0.5 + 1e-9, hz + ' Hz: the hero on screen moved ' + d);
    for (const d of floor) assert.ok(Math.abs(d + RUN / hz) <= 0.5 + 1e-9, hz + ' Hz: the floor scrolled ' + d + ' px in a frame');
    assert.ok(v.rt.sim.cam.x > follow.cam.x + 30, 'the camera followed');
    v.release('ArrowRight');
  }
});

test('orphan-process: the canvas draws at the scale it is shown at: 960 x 540 at 2, the fullscreen multiple, 480 x 270 when narrower, following resizes and fullscreen in and out, with crisp tiles and text', (t) => {
  const { v } = openModule(t);
  const g = v.g;
  const ctx = v.canvas.getContext('2d');
  const transforms = [];
  const reset = ctx.setTransform;
  ctx.setTransform = (...args) => {
    transforms.push(args);
    reset(...args);
  };
  const size = () => [v.canvas.width, v.canvas.height];
  assert.deepEqual(size(), [W, H], 'not laid out: 1');
  v.canvas.clientWidth = 960;
  fire(window, 'resize');
  assert.deepEqual(size(), [960, 540]);
  assert.deepEqual(transforms.pop(), [2, 0, 0, 2, 0, 0]);
  assert.equal(ctx.imageSmoothingEnabled, false);
  v.canvas.clientWidth = 959;
  fire(window, 'resize');
  assert.deepEqual(size(), [W, H], 'a narrower wrapper: 1');
  t.after(() => { delete document.fullscreenElement; });
  const stage = v.el('stage');
  for (const [w, h, want] of [[1920, 1080, [1920, 1080]], [2560, 1440, [2400, 1350]], [1366, 768, [960, 540]], [400, 300, [W, H]]]) {
    stage.clientWidth = w;
    stage.clientHeight = h;
    document.fullscreenElement = stage;
    fire(document, 'fullscreenchange');
    assert.deepEqual(size(), want, w + 'x' + h);
    assert.deepEqual(transforms.pop(), [want[0] / W, 0, 0, want[0] / W, 0, 0]);
  }
  v.canvas.clientWidth = 960;
  delete document.fullscreenElement;
  fire(document, 'fullscreenchange');
  assert.deepEqual(size(), [960, 540], 'out of fullscreen');
  // Moving things and the camera sit on screen pixels; tiles, the HUD and text on whole game pixels' multiples of them.
  stage.clientWidth = 1920;
  stage.clientHeight = 1080;
  document.fullscreenElement = stage;
  const sim = edit(g.orpNewSim(Object.assign(g.orpFreshProgress(), { tty: 'downloads:4,23' })), (s) => {
    s.hero.x = 20 * T + 3.37;
    s.cam.x = 101.13;
    s.cam.y = 146.6;
  });
  v.show(sim, 'pause');
  assert.deepEqual(size(), [1920, 1080]);
  const sprites = v.sprites();
  assert.ok(sprites.length > 100);
  for (const d of sprites) assert.deepEqual([Math.round(d.x * 4), Math.round(d.y * 4)], [d.x * 4, d.y * 4], d.name + ' on a screen pixel');
  // The camera snaps first (so the tiles stay on screen pixels), then the hero against it.
  assert.equal(v.hero().x, Math.round((20 * T + 0.37 - Math.round(101.13 * 4) / 4) * 4) / 4);
  for (const d of v.drawn().filter((r) => r.kind === 'rect')) assert.deepEqual([Math.round(d.x), Math.round(d.y)], [d.x, d.y], 'HUD and text on game pixels');
  const backdrop = v.drawn().filter((d) => d.kind === 'backdrop').map((d) => d.x);
  assert.deepEqual(backdrop, [-Math.floor(101.13 * 0.3 * 4) / 4, W - Math.floor(101.13 * 0.3 * 4) / 4], 'the far skyline in screen pixels');
});

test('orphan-process: a frame draws between the last two steps without touching them, and never across a jump: a room change, a respawn, the return after spikes, or a thing that was not there before', (t) => {
  const between = orp.orpBetween;
  const sim = orp.orpNewSim(orp.orpFreshProgress());
  const a = run(edit(sim, (s) => { s.hero.vx = RUN; }), { right: true }, 2);
  const b = orp.orpStep(a, Object.assign({}, IDLE, { right: true }));
  const frozen = JSON.stringify([a, b]);
  const mid = between(a, b, 0.25);
  assert.equal(JSON.stringify([a, b]), frozen, 'both states are left alone');
  assert.ok(Math.abs(mid.hero.x - (a.hero.x + (b.hero.x - a.hero.x) * 0.25)) < 1e-9);
  assert.deepEqual([mid.cam.x, mid.prog, mid.room], [a.cam.x + (b.cam.x - a.cam.x) * 0.25, b.prog, b.room]);
  assert.equal(between(null, b, 0.5), b, 'no step yet');
  const moved = edit(b, (s) => { s.room = 'config'; });
  assert.equal(between(a, moved, 0.5), moved, 'a room change');
  const dead = edit(b, (s) => { s.mode = 'dead'; });
  assert.equal(between(a, dead, 0.5), dead, 'death and respawn');
  // Spikes send the hero back to safe ground: it is drawn there at once.
  const spiky = labSim(t, lab(['#..T...^^^......................#', '#################################']));
  let s1 = run(place(spiky, 5, 15, { vx: RUN }), { right: true }, 1);
  let s2 = orp.orpStep(s1, Object.assign({}, IDLE, { right: true }));
  while (s2.hero.warp === s1.hero.warp) {
    s1 = s2;
    s2 = orp.orpStep(s1, Object.assign({}, IDLE, { right: true }));
  }
  assert.equal(s2.hero.warp, 1);
  const back = between(s1, s2, 0.5);
  assert.deepEqual([back.hero.x, back.hero.y], [s2.hero.x, s2.hero.y]);
  // Entities by id: one that moved is in between, a new one is where it is; signals fly straight, a new one from where it was fired.
  const ent = (id, x) => ({ id, type: 'bug', x, y: 100, w: 12, h: 8, vx: 0, vy: 0, hp: 1, face: 1, t: 0, flash: 0, cd: 0, parent: '' });
  const sig = (x, dist) => ({ x, y: 50, w: 10, h: 4, vx: 240, dist });
  const p = edit(b, (s) => { s.ents = [ent('old', 100)]; s.sigs = []; });
  const q = edit(b, (s) => { s.ents = [ent('old', 104), ent('new', 300)]; s.sigs = [sig(200, 2), sig(100, 40)]; });
  const view = between(p, q, 0.5);
  assert.deepEqual(view.ents.map((e) => e.x), [102, 300]);
  assert.equal(view.ents[1], q.ents[1]);
  assert.deepEqual(view.sigs.map((s) => s.x), [200, 100 - 1]);
  assert.equal(view.sigs[0], q.sigs[0]);
});

test('orphan-process: a key the game takes stops at the canvas, so the host page\'s shortcuts never see it; other keys, modified keys and every key outside the game reach them', (t) => {
  const { v } = openPage(t);
  const seen = [];
  document.addEventListener('keydown', (e) => seen.push('down ' + e.key));
  document.addEventListener('keyup', (e) => seen.push('up ' + e.key));
  startNewGame(v);
  for (const key of ['ArrowRight', 'a', ' ', 'ArrowDown', 'x', 'k', 'Enter', 'f', 'm', 'm']) {
    v.press(key);
    v.release(key);
  }
  v.press('m', { repeat: true });
  assert.deepEqual(seen, [], 'none of the game\'s keys');
  v.press('q');
  v.release('q');
  v.press('ArrowRight', { ctrlKey: true });
  v.canvas.dispatchEvent(keyEvent('ArrowRight', { type: 'keyup', ctrlKey: true }));
  assert.deepEqual(seen, ['down q', 'up q', 'down ArrowRight', 'up ArrowRight']);
  // Outside the game every key is the page's.
  seen.length = 0;
  const field = v.page.add('host-field', 'input');
  focusElement(field);
  pressKey('ArrowLeft', { target: field });
  pressKey('p', { target: field });
  assert.deepEqual(seen, ['down ArrowLeft', 'down p']);
});
