// tests/packet-siege.test.js
// The page of Packet Siege: booted from the real index.html like a browser
// (and, where a test sets the game state, as a module whose pksInit runs on
// the same page), driven through its listeners with the animation frames
// run by the test: every screen and transition inside the one frame, whole
// levels won by pointer and by keyboard, a loss, every refusal the status
// line explains, the loadout, pause, the leave question, help, speed and the
// frame loop, the frame's layout (from its parent's width, fullscreen and
// maximised), saves, announcements, and the source and layout checks of the
// three shipped files.
//
// Level numbers (surges, start cycles, durations) are read from pksLevel,
// never written here: the level table is tuned elsewhere.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, keyEvent, focusElement, setVisibility, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt
} = require('./_setup');

const GAME = 'packet-siege';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);
const BUILD = require('../' + GAME + '/build.js');
const UI_PARTS = BUILD.PARTS.filter((part) => /^ui-/.test(part));
const UI = UI_PARTS.map((part) => readRepoFile(GAME + '/src/' + part + '.js')).join('\n');

const pks = loadScript(SCRIPT);
const SAVE_KEY = 'pks-state';
const L1 = pks.pksLevel(1);
const STEPS = (seconds) => Math.round(seconds * 60);

test.beforeEach(() => resetStubs());

// ── helpers ────────────────────────────────────────────────────────────────

// Where each sprite sits in the atlas (its layout depends only on the art),
// so a recording context can name what the game draws.
const ATLAS = pks.pksBuildAtlas((w, h) => ({ width: w, height: h, getContext: () => ({ fillRect() {} }) }));
const SPRITE_AT = new Map();
for (const set of ['frames', 'flash', 'slow']) {
  for (const [name, f] of Object.entries(ATLAS[set])) SPRITE_AT.set(f.x + ',' + f.y, name);
}
for (const frames of Object.values(ATLAS.tints)) {
  for (const [name, f] of Object.entries(frames)) SPRITE_AT.set(f.x + ',' + f.y, name);
}
const RUN_KEY = 'pks-run';

// A save as the storage part writes it, with fields changed.
function saveWith(over) {
  return Object.assign(pks.pksNewSave(), over);
}

// A save with levels 1..won won at `stars` stars.
function wonUpTo(won, stars = 3, over = {}) {
  const save = pks.pksNewSave();
  for (let n = 1; n <= won; n++) save.stars[n - 1] = stars;
  save.unlocked = Math.min(150, won + 1);
  return Object.assign(save, over);
}

// The first level of 51-150 whose rules include `name`.
const levelWith = (name) => {
  for (let n = 51; n <= 150; n++) if (pks.pksLevel(n).rules.names.includes(name)) return n;
  return 0;
};

// Animation frames run by the test: frame(ms) moves the time on and runs
// the frames asked for so far with it as their timestamp.
function makeClock(t) {
  let now = 1000;
  let frames = [];
  let next = 1;
  t.mock.method(globalThis, 'requestAnimationFrame', (callback) => {
    frames.push({ id: next, callback });
    return next++;
  });
  t.mock.method(globalThis, 'cancelAnimationFrame', (id) => {
    frames = frames.filter((frame) => frame.id !== id);
  });
  const clock = {
    frame(ms = 16) {
      now += ms;
      const batch = frames;
      frames = [];
      batch.forEach((frame) => frame.callback(now));
      return clock;
    },
    // Frames of 250 ms (the most a frame catches up) for `seconds`.
    run(seconds) {
      for (let i = 0; i < seconds * 4; i++) clock.frame(250);
      return clock;
    },
    // Frames of 250 ms until done() (at most `seconds` of them).
    until(done, seconds = 400) {
      for (let i = 0; i < seconds * 4 && !done(); i++) clock.frame(250);
      assert.ok(done(), 'the condition came true within ' + seconds + ' s');
      return clock;
    },
    stall(ms) {
      now += ms;
      return clock;
    },
    pending: () => frames.length,
    reload() {
      frames = [];
    }
  };
  return clock;
}

// What a player sees and does on a booted page.  The field's context records
// the sprites of the last frame (a frame starts with the zone backdrop).
function pageView(page) {
  const els = page.els;
  const canvas = els['pks-canvas'];
  const ctx = canvas.getContext('2d');
  let drawn = [];
  ctx.drawImage = (src, sx, sy, sw, sh, dx, dy) => {
    const name = SPRITE_AT.get(sx + ',' + sy);
    if (/^backdrop-/.test(name) && dx === 0) drawn = [];
    drawn.push({ name, x: dx, y: dy, alpha: ctx.globalAlpha });
  };
  const $ = (selector) => page.root.querySelector(selector);
  const center = (lane, col) => ({ clientX: 24 + col * 32 + 16, clientY: 20 + lane * 32 + 16 });
  const v = {
    page,
    els,
    canvas,
    $,
    $$: (selector) => page.root.querySelectorAll(selector),
    el: (name) => els['pks-' + name],
    text: (name) => els['pks-' + name].textContent,
    hidden: (name) => els['pks-' + name].classList.contains('pks-hidden'),
    // The screen on top: a full-frame screen or the result, else the level.
    screen() {
      const top = ['select', 'loadout', 'codex', 'result'].filter((name) => !v.hidden(name));
      return top.length ? top : ['play'].filter((name) => !v.hidden(name));
    },
    status: () => els['pks-status'].textContent,
    live: () => els['pks-live'].textContent,
    level: (n) => $('#pks-level-' + n),
    card: (id) => $('#pks-card-' + id),
    cards: () => v.$$('.pks-card').map((b) => b.id.slice('pks-card-'.length)),
    drawn: () => drawn,
    ghost: () => drawn.filter((d) => d.name === 'cursor' || d.name === 'cursor-bad').map((d) => d.name + '@' + d.x + ',' + d.y),
    click: (name) => els['pks-' + name].click(),
    frameStyle: () => [els['pks-frame'].style.width, els['pks-frame'].style.height],
    // Pointer events (when the page has them) or the mouse and click.
    move(lane, col) {
      fire(canvas, v.pointer ? 'pointermove' : 'mousemove', Object.assign({ pointerId: 1, pointerType: 'mouse' }, center(lane, col)));
    },
    tap(lane, col, props) {
      const at = Object.assign({ pointerId: 1, pointerType: 'mouse', button: 0 }, center(lane, col), props);
      if (v.pointer) {
        fire(canvas, 'pointerdown', at);
        fire(canvas, 'pointerup', at);
      } else {
        fire(canvas, 'click', at);
      }
    },
    press(key, props) {
      if (document.activeElement !== canvas) focusElement(canvas, { keyboard: true });
      return pressKey(key, Object.assign({ target: canvas }, props));
    },
    save: () => JSON.parse(localStorage.getItem(SAVE_KEY)),
    // The field gets the focus as a browser gives it (with its focus event:
    // the game's own focus() call has none in the stubs).
    focusField() {
      focusElement(document.body);
      focusElement(canvas, { keyboard: true });
    },
    // A card that is paid for and recharged.
    cardReady: (id) => !v.card(id).classList.contains('pks-card--poor') && (v.card(id).children[4].style.height || '0%') === '0%'
  };
  return v;
}

// A page from index.html whose frame's parent is `width` px wide.
function newPage(width) {
  const page = createPage(htmlPageSpec(HTML));
  page.els['pks-holder'].clientWidth = width;
  return page;
}

// The page as a browser loads it, after writing storage.  pointer: the
// browser has pointer events; width: the frame's parent's width (0: not
// laid out).
function openPage(t, { save, options, pointer, width = 0 } = {}) {
  const clock = makeClock(t);
  if (save !== undefined) localStorage.setItem(SAVE_KEY, typeof save === 'string' ? save : JSON.stringify(save));
  if (pointer) {
    window.PointerEvent = function PointerEvent() {};
    t.after(() => delete window.PointerEvent);
  }
  const page = newPage(width);
  const v = pageView(page);
  v.pointer = !!pointer;
  const b = bootLikeBrowser(SCRIPT, page, options);
  v.restore = b.restore;
  v.ready = b.ready;
  return { clock, v };
}

// A reload: the old page and its frames go away, storage stays.
function reload(t, clock, v, options) {
  clock.reload();
  v.restore();
  const page = newPage(0);
  const fresh = pageView(page);
  fresh.pointer = v.pointer;
  const b = bootLikeBrowser(SCRIPT, page, options);
  fresh.restore = b.restore;
  return fresh;
}

// A reload of a module page: the old page and its frames go away, storage
// stays, the new page's runtime is v.rt.
function reloadModule(t, clock, v) {
  clock.reload();
  v.restore();
  const page = newPage(0);
  const fresh = pageView(page);
  fresh.pointer = v.pointer;
  const loaded = loadWithPage(SCRIPT, page, { keep: true });
  loaded.exports.pksInit();
  fresh.g = loaded.exports;
  fresh.rt = loaded.exports.pksRuntime;
  fresh.restore = loaded.restore;
  return fresh;
}

// A page whose game state a test can reach: the script loaded as a module,
// its pksInit run on a page from index.html; v.rt is the live runtime.
function openModule(t, { save, pointer, width = 0 } = {}) {
  const clock = makeClock(t);
  if (save !== undefined) localStorage.setItem(SAVE_KEY, typeof save === 'string' ? save : JSON.stringify(save));
  if (pointer) {
    window.PointerEvent = function PointerEvent() {};
    t.after(() => delete window.PointerEvent);
  }
  const page = newPage(width);
  const v = pageView(page);
  v.pointer = !!pointer;
  const loaded = loadWithPage(SCRIPT, page, { keep: true });
  loaded.exports.pksInit();
  v.g = loaded.exports;
  v.rt = loaded.exports.pksRuntime;
  v.restore = loaded.restore;
  return { clock, v };
}

// The viewport's size for a test (window.innerWidth / innerHeight).
function viewport(t, w, h) {
  window.innerWidth = w;
  window.innerHeight = h;
  t.after(() => {
    delete window.innerWidth;
    delete window.innerHeight;
  });
}

// The page's scroll styles, given back after the test.
function keepScrollStyles(t) {
  const html = document.documentElement.style;
  const body = document.body.style;
  const before = [html.overflow, body.overflow];
  t.after(() => {
    html.overflow = before[0];
    body.overflow = before[1];
  });
}

// Ends the level being played on the next step: everything spawned and
// nothing left, with `tripped` breakers tripped.
function finish(v, tripped = 0) {
  const sim = v.rt.sim;
  sim.spawnIndex = sim.level.spawns.length;
  sim.enemies = [];
  sim.tripped = tripped;
}

// Lets the level's next step lose: an enemy at the rack of a tripped lane.
function breach(v, lane, type = 'bot') {
  const sim = v.rt.sim;
  sim.breakers[lane] = 'tripped';
  const e = pks.pksSpawnEnemy(sim, type, lane, 0.01, type === 'boss' ? 1 : 0);
  e.x = -0.5;
}

// Level 1, won by placing: two PSUs, then Firewalls and one more PSU, each as
// soon as its card is ready and paid for.  act(id, lane, col) places one.
const L1_PLAN = [['psu', 2, 0], ['psu', 2, 1], ['firewall', 2, 2], ['firewall', 2, 3], ['psu', 2, 4], ['firewall', 2, 5]];

function playPlan(clock, v, plan, act) {
  for (const [id, lane, col] of plan) {
    clock.until(() => v.cardReady(id), 120);
    act(id, lane, col);
  }
}

// ── start-up ───────────────────────────────────────────────────────────────

test('packet-siege: loading the script under Node runs no init: no lookup, listener, frame or save', (t) => {
  const frames = t.mock.method(globalThis, 'requestAnimationFrame');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.pksInit, 'function');
  assert.equal(fresh.pksRuntime.els, null);
  assert.deepEqual(page.requested, []);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(frames.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('packet-siege: a first visit shows the level select in the frame: zone 1 and its ten levels, level 1 open, 149 locked, no stars, the loop off, nothing written, every listener bound once', (t) => {
  const { clock, v } = openPage(t);
  assert.deepEqual(v.screen(), ['select']);
  assert.equal(v.hidden('play'), true, 'no level behind the level select');
  assert.equal(v.hidden('warning'), true);
  assert.equal(v.hidden('run'), true, 'no level in progress to resume');
  assert.equal(v.text('total'), '0 of 450');
  const buttons = v.$$('.pks-level');
  assert.equal(buttons.length, 150);
  assert.deepEqual(buttons.map((b) => b.id), Array.from({ length: 150 }, (_, i) => 'pks-level-' + (i + 1)));
  assert.equal(v.level(1).disabled, false);
  assert.equal(v.level(1).getAttribute('aria-label'), 'Level 1, Power On: 0 of 3 stars');
  assert.equal(v.level(1).textContent, '1☆☆☆');
  for (let n = 2; n <= 150; n++) {
    assert.equal(v.level(n).disabled, true, n);
    assert.ok(v.level(n).classList.contains('pks-level--locked'));
  }
  assert.equal(v.level(2).getAttribute('aria-label'), 'Level 2, Blinking Lights: locked');
  assert.equal(v.level(10).getAttribute('aria-label'), 'Level 10, The Lurker (boss): locked');
  assert.deepEqual(v.$$('.pks-level--boss').map((b) => b.id), Array.from({ length: 15 }, (_, i) => 'pks-level-' + (i + 1) * 10));
  // Fifteen zone groups, each with its name and modifier on one line; only the first shows.
  assert.deepEqual(v.$$('.pks-zone-title').map((p) => p.textContent), pks.pksZones.map((z) => 'Zone ' + z.zone + ' · ' + z.name + ' — ' + z.desc));
  assert.equal(v.$$('.pks-zone-title')[1].textContent, 'Zone 2 · DMZ — Cable trays: some cells take nothing.');
  assert.deepEqual(v.$$('.pks-zone').map((g) => g.classList.contains('pks-hidden')), Array.from({ length: 15 }, (_, i) => i > 0));
  // The zone picker: fifteen tiles, zone 1 pressed and open, the rest locked.
  const tiles = v.$$('.pks-zone-tile');
  assert.deepEqual(tiles.map((b) => b.id), Array.from({ length: 15 }, (_, i) => 'pks-zone-' + (i + 1)));
  assert.deepEqual(tiles.map((b) => b.getAttribute('aria-pressed')), Array.from({ length: 15 }, (_, i) => String(i === 0)));
  assert.equal(tiles[0].getAttribute('aria-label'), 'Zone 1, Server closet: 0 of 30 stars');
  assert.equal(tiles[0].textContent, '1Server closet★ 0/30');
  assert.equal(tiles[5].getAttribute('aria-label'), 'Zone 6, Backbone: locked until level 51');
  assert.equal(tiles[5].textContent, '6Backbonefrom L51');
  assert.equal(v.$$('.pks-zone-tile--locked').length, 14);
  assert.equal(v.$$('.pks-zone-icon').length, 15);
  assert.equal(clock.pending(), 0, 'no loop off the level screen');
  assert.equal(localStorage.length, 0);
  assert.equal(v.text('speed'), '1x');
  assert.equal(v.text('full'), 'Fullscreen');
  assert.equal(v.text('select-full'), 'Fullscreen');
  for (const [name, type] of [['canvas', 'keydown'], ['canvas', 'keyup'], ['canvas', 'focus'], ['canvas', 'blur'], ['canvas', 'mousemove'],
    ['canvas', 'mouseleave'], ['canvas', 'click'], ['frame', 'keydown'], ['codex-open', 'click'], ['codex-back', 'click'], ['help-open', 'click'],
    ['select-full', 'click'], ['help-close', 'click'], ['warning-close', 'click'], ['loadout-start', 'click'], ['loadout-back', 'click'],
    ['pause', 'click'], ['speed', 'click'], ['levels', 'click'], ['full', 'click'], ['resume', 'click'], ['restart', 'click'],
    ['pause-help', 'click'], ['quit', 'click'], ['confirm-yes', 'click'], ['confirm-no', 'click'], ['next', 'click'], ['replay', 'click'],
    ['result-levels', 'click'], ['run-resume', 'click'], ['run-fresh', 'click']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(v.canvas, 'pointerdown'), 0, 'no pointer events in this browser');
  assert.equal(listenerCount(v.level(1), 'click'), 1);
  assert.equal(listenerCount(v.$('#pks-zone-7'), 'click'), 1);
  assert.equal(listenerCount(document), 5);
  for (const type of ['visibilitychange', 'fullscreenchange', 'webkitfullscreenchange', 'fullscreenerror', 'webkitfullscreenerror']) {
    assert.equal(listenerCount(document, type), 1, type);
  }
  assert.equal(listenerCount(window), 4);
  for (const type of ['blur', 'storage', 'resize', 'pagehide']) assert.equal(listenerCount(window, type), 1, type);
});

test('packet-siege: the level select for 150 levels: it opens on the zone of the furthest open level; a tile shows its zone\'s ten levels; stars per zone, the total of 450', (t) => {
  const save = wonUpTo(73, 2);
  save.stars[0] = 3;
  const { v } = openModule(t, { save });
  assert.equal(v.rt.zone, 8, 'level 74 is open: zone 8');
  const shown = () => v.$$('.pks-zone').map((g, i) => (g.classList.contains('pks-hidden') ? 0 : i + 1)).filter(Boolean);
  assert.deepEqual(shown(), [8]);
  assert.equal(v.$('#pks-zone-8').getAttribute('aria-pressed'), 'true');
  assert.equal(v.text('total'), (73 * 2 + 1) + ' of 450');
  assert.equal(v.$('#pks-zone-1').getAttribute('aria-label'), 'Zone 1, Server closet: 21 of 30 stars');
  assert.equal(v.$('#pks-zone-8').getAttribute('aria-label'), 'Zone 8, Power plant: 6 of 30 stars');
  assert.equal(v.$('#pks-zone-9').getAttribute('aria-label'), 'Zone 9, VPN tunnel: locked until level 81');
  assert.equal(v.level(74).disabled, false);
  assert.equal(v.level(75).disabled, true);
  // another zone, by its tile
  v.$('#pks-zone-15').click();
  assert.deepEqual(shown(), [15]);
  assert.equal(v.$('#pks-zone-15').getAttribute('aria-pressed'), 'true');
  assert.equal(v.$('#pks-zone-8').getAttribute('aria-pressed'), 'false');
  assert.equal(v.level(150).getAttribute('aria-label'), 'Level 150, The Architect (boss): locked');
  v.$('#pks-zone-2').click();
  assert.deepEqual(shown(), [2]);
  // back from a level: the zone of the level played
  v.$('#pks-zone-5').click();
  v.level(13).click();
  v.click('loadout-start');
  v.click('levels');
  v.click('confirm-yes');
  assert.deepEqual(shown(), [2]);
  assert.equal(v.$('#pks-zone-2').getAttribute('aria-pressed'), 'true');
});

test('packet-siege: while the page is still loading the game waits for DOMContentLoaded; pksInit runs once', (t) => {
  const { v } = openPage(t, { options: { readyState: 'loading' } });
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(v.$$('.pks-level').length, 0, 'nothing built yet');
  v.ready();
  assert.equal(v.$$('.pks-level').length, 150);
  resetStubs();
  const m = openModule(t, { pointer: true });
  m.v.g.pksInit();
  assert.equal(m.v.$$('.pks-level').length, 150, 'built once');
  assert.equal(m.v.$$('.pks-zone-tile').length, 15);
  assert.equal(listenerCount(m.v.canvas, 'keydown'), 1);
  for (const type of ['pointermove', 'pointerleave', 'pointerdown', 'pointerup', 'pointercancel']) assert.equal(listenerCount(m.v.canvas, type), 1, type);
  assert.equal(listenerCount(m.v.canvas, 'click'), 0);
  assert.equal(listenerCount(window, 'storage'), 1);
});

// ── a whole level ──────────────────────────────────────────────────────────

test('packet-siege: level 1 won with pointer events on the cards and the field: three stars, the Reverse Proxy, level 2 open and saved', (t) => {
  const { clock, v } = openPage(t, { pointer: true });
  v.level(1).click();
  assert.deepEqual(v.screen(), ['play'], 'no loadout with two defenders and five slots');
  assert.equal(document.activeElement, v.canvas);
  assert.equal(v.text('hud-level'), 'L1 · Power On');
  assert.equal(v.el('hud-level').getAttribute('title'), 'L1 · Power On');
  assert.equal(v.text('cycles'), String(L1.startCycles));
  assert.equal(v.text('surge'), 'Surge 0/' + L1.surges.length);
  assert.deepEqual(v.cards(), ['psu', 'firewall', 'decom']);
  assert.deepEqual(v.$$('.pks-card-name').map((s) => s.textContent), ['PSU', 'Firewall', 'Decom']);
  assert.deepEqual(v.$$('.pks-card-cost').map((s) => s.textContent), ['50', '100', 'free']);
  assert.deepEqual(v.$$('.pks-card-key').map((s) => s.textContent), ['1', '2', 'X']);
  assert.equal(v.card('firewall').getAttribute('aria-label'), 'Firewall, 100 cycles, key 2');
  assert.equal(v.card('decom').getAttribute('title'), 'Decommission (X)', 'the full name of a short label');
  assert.equal(v.status(), L1.hint);
  // The news banner over the field: the threat of the level and the two defenders, each with its icon.
  assert.equal(v.el('news').classList.contains('pks-news--off'), false);
  assert.deepEqual(v.$$('.pks-news-item').map((p) => p.textContent), [
    'New threat: Bot. A compromised host doing what it is told. Slow, steady, plentiful.',
    'New defender: PSU. Power supply: +25 cycles every 10 s.',
    'New defender: Firewall. Fires one packet every 1.5 s at the first enemy in its lane.'
  ]);
  assert.deepEqual(v.$$('.pks-news-item-detail').map((s) => s.textContent.slice(0, 13)), [' A compromise', ' Power supply', ' Fires one pa']);
  assert.equal(v.$$('.pks-news-item-icon').length, 3);
  assert.match(v.live(), /^Level 1, Power On\. Build PSUs first.*New threat: Bot\. A compromised host/);
  assert.equal(clock.pending(), 1, 'the loop runs');
  const act = (id, lane, col) => {
    v.card(id).click();
    assert.equal(v.card(id).getAttribute('aria-pressed'), 'true');
    v.move(lane, col);
    clock.frame(16);
    assert.ok(v.ghost().includes('cursor@' + (24 + col * 32) + ',' + (20 + lane * 32)), 'the ghost over the cell');
    v.tap(lane, col);
    assert.match(v.status(), new RegExp('placed: ' + pks.pksDefender[id].cost + ' cycles\\.$'));
    assert.equal(v.card(id).getAttribute('aria-pressed'), 'false', 'put down once placed');
    assert.equal(v.card(id).children[4].style.height, '100%', 'the recharge shade is full');
    assert.equal(v.el('news').classList.contains('pks-news--off'), true, 'the first placement ends the news');
  };
  playPlan(clock, v, L1_PLAN, act);
  clock.until(() => v.screen()[0] === 'result', L1.duration + 60);
  assert.equal(v.hidden('play'), false, 'the result over the frozen field');
  assert.equal(v.text('result-title'), 'Level 1 secured');
  assert.equal(v.text('result-text'), 'Breakers tripped: 0. Stars: 3 of 3.');
  assert.equal(v.$$('.pks-result-star').length, 3);
  assert.deepEqual(v.$$('.pks-unlock').map((p) => p.textContent), [
    'New defender: Reverse Proxy. A wall that soaks up bites and stops an Exploit\'s leap.',
    'Level 2, Blinking Lights, is open.'
  ]);
  assert.equal(v.hidden('next'), false);
  assert.equal(v.text('replay'), 'Replay');
  assert.equal(document.activeElement, v.el('next'));
  assert.match(v.live(), /^Level 1 secured\. Breakers tripped: 0\. Stars: 3 of 3\. New defender: Reverse Proxy\./);
  assert.equal(clock.pending(), 0, 'the loop stopped');
  const saved = v.save();
  assert.equal(saved.unlocked, 2);
  assert.equal(saved.stars[0], 3);
  assert.deepEqual(saved.met, ['bot']);
  // Next level: level 2 with the three defenders, its own news.
  v.click('next');
  assert.equal(v.hidden('result'), true);
  assert.equal(v.text('hud-level'), 'L2 · Blinking Lights');
  assert.deepEqual(v.cards(), ['psu', 'firewall', 'proxy', 'decom']);
  assert.deepEqual(v.$$('.pks-card-name').map((s) => s.textContent), ['PSU', 'Firewall', 'Proxy', 'Decom']);
  assert.equal(v.card('proxy').getAttribute('title'), 'Reverse Proxy (3)');
  assert.deepEqual(v.$$('.pks-news-item').map((p) => p.textContent.split('.')[0]), ['New threat: Script Kiddie', 'New defender: Reverse Proxy']);
});

test('packet-siege: level 1 won with the keyboard alone: number keys, arrows and Enter', (t) => {
  const { clock, v } = openPage(t);
  focusElement(v.level(1), { keyboard: true });
  pressKey('Enter');
  assert.deepEqual(v.screen(), ['play']);
  assert.equal(document.activeElement, v.canvas);
  v.focusField();
  clock.frame(16);
  assert.deepEqual(v.ghost(), [], 'no cursor before an arrow or Enter');
  let at = null;
  const act = (id, lane, col) => {
    v.press(id === 'psu' ? '1' : '2');
    if (!at) {
      v.press('ArrowRight');
      v.press('ArrowLeft');
      at = { lane: 2, col: 0 };
    }
    while (at.col < col) {
      v.press('ArrowRight');
      at.col++;
    }
    while (at.col > col) {
      v.press('ArrowLeft', { repeat: true });
      at.col--;
    }
    assert.ok(v.ghost().includes('cursor@' + (24 + col * 32) + ',' + (20 + lane * 32)), 'the ghost on the cursor');
    assert.equal(v.press('Enter').defaultPrevented, true);
    assert.match(v.status(), /placed/);
  };
  playPlan(clock, v, L1_PLAN, act);
  clock.until(() => v.screen()[0] === 'result', L1.duration + 60);
  assert.equal(v.text('result-title'), 'Level 1 secured');
  assert.equal(v.save().stars[0], 3);
});

test('packet-siege: a level with nothing placed is lost: the breaker trips, then a breach; after a beat the result offers Retry and Levels, no Next', (t) => {
  const { clock, v } = openPage(t);
  v.level(1).click();
  v.click('speed');
  assert.equal(v.text('speed'), '2x');
  clock.until(() => /^Breaker tripped/.test(v.status()), L1.duration);
  assert.equal(v.status(), 'Breaker tripped in lane 3: one more breach there ends the level.');
  assert.equal(v.live(), v.status());
  clock.until(() => /^Breach/.test(v.status()), L1.duration);
  assert.equal(v.status(), 'Breach in lane 3. Bot reached the rack after the lane\'s breaker had tripped.');
  // A beat of 1.2 s (counted from the frame that ended the level) before the result.
  assert.deepEqual(v.screen(), ['play']);
  clock.frame(250).frame(250).frame(250);
  assert.deepEqual(v.screen(), ['play']);
  clock.frame(250);
  assert.deepEqual(v.screen(), ['result']);
  assert.equal(v.text('result-title'), 'Breach in lane 3');
  assert.equal(v.text('result-text'), 'Bot reached the rack after the lane\'s breaker had tripped.');
  assert.equal(v.$$('.pks-result-star').length, 0);
  assert.equal(v.$$('.pks-unlock').length, 0);
  assert.equal(v.hidden('next'), true);
  assert.equal(v.text('replay'), 'Retry');
  assert.equal(document.activeElement, v.el('replay'));
  assert.equal(v.live(), 'Breach in lane 3. Bot reached the rack after the lane\'s breaker had tripped.');
  assert.deepEqual(v.save().stars, Array(150).fill(0), 'nothing won');
  assert.equal(localStorage.getItem(RUN_KEY), null, 'a lost level leaves nothing to resume');
  assert.deepEqual(v.save().met, ['bot']);
  assert.equal(v.save().speed, 2);
  v.click('replay');
  assert.deepEqual(v.screen(), ['play']);
  assert.equal(v.text('cycles'), String(L1.startCycles), 'a fresh level');
  assert.deepEqual(v.$$('.pks-news-item').map((p) => p.textContent.split('.')[0]), ['New defender: PSU', 'New defender: Firewall'], 'the Bot is met now');
});

// ── placing and its refusals ───────────────────────────────────────────────

test('packet-siege: the status line names the values of every refusal: recharge, cycles, a closed lane, a taken cell, a cable tray', (t) => {
  const { clock, v } = openPage(t, { pointer: true });
  v.level(1).click();
  // Nothing in hand: a tap says what to do, or what is there.
  v.tap(2, 0);
  assert.equal(v.status(), 'Pick a card first: tap one below the field or press its number.');
  fire(v.canvas, 'pointerleave');
  v.card('psu').click();
  assert.equal(v.status(), 'PSU (50 cycles): Power supply: +25 cycles every 10 s. Now pick a cell.');
  v.move(2, 0);
  clock.frame(16);
  assert.equal(v.status(), 'Place PSU here for 50 cycles');
  assert.deepEqual(v.ghost(), ['cursor@24,84']);
  assert.ok(v.drawn().some((d) => d.name === 'def-psu-0' && d.x === 28 && d.y === 90 && d.alpha === 0.6), 'the PSU at reduced alpha');
  v.move(0, 3);
  clock.frame(16);
  assert.equal(v.status(), 'Lane 1 is closed on this level (in play: 3)');
  assert.deepEqual(v.ghost(), ['cursor-bad@120,20']);
  v.tap(0, 3);
  assert.equal(v.status(), 'Lane 1 is closed on this level (in play: 3)', 'a refused tap says why');
  v.tap(2, 0);
  assert.equal(v.status(), 'PSU placed: 50 cycles.');
  v.tap(2, 0);
  assert.equal(v.status(), 'PSU: 300 of 300 HP', 'what is on a cell');
  // The same card again at once: recharging, with the seconds left.
  v.card('psu').click();
  v.move(2, 1);
  clock.frame(16);
  assert.equal(v.status(), 'PSU recharging: 5.0 s');
  clock.frame(250).frame(250);
  assert.equal(v.status(), 'PSU recharging: 4.5 s', 'counts down while held');
  // The Firewall costs more than is left.
  v.card('firewall').click();
  clock.frame(16);
  const left = L1.startCycles - 50;
  assert.equal(v.status(), left < 100 ? 'Not enough cycles: ' + left + ' of 100' : 'Place Firewall here for 100 cycles');
  assert.equal(v.card('firewall').classList.contains('pks-card--poor'), left < 100);
  assert.ok(!v.card('psu').classList.contains('pks-card--poor'));
  // A taken cell.
  clock.run(5);
  v.card('psu').click();
  v.move(2, 0);
  clock.frame(16);
  assert.equal(v.status(), 'Cell taken by PSU: decommission it first (X)');
  // The same card again puts it down.
  v.card('psu').click();
  assert.equal(v.status(), 'PSU put down.');
  clock.frame(16);
  assert.deepEqual(v.ghost(), []);
  // Decommission: over a defender, over nothing, a tap on each.
  fire(v.canvas, 'pointerleave');
  v.card('decom').click();
  assert.equal(v.status(), 'Decommission: pick a defender to remove. There is no refund.');
  v.move(2, 0);
  clock.frame(16);
  assert.equal(v.status(), 'Decommission PSU here (no refund)');
  v.move(2, 5);
  clock.frame(16);
  assert.equal(v.status(), 'Nothing to decommission here');
  assert.deepEqual(v.ghost(), ['cursor-bad@184,84']);
  v.tap(2, 5);
  assert.equal(v.status(), 'Nothing to decommission here');
  const cycles = v.text('cycles');
  v.tap(2, 0);
  assert.equal(v.status(), 'Decommissioned PSU.');
  assert.equal(v.text('cycles'), cycles, 'no refund');
  // The pointer leaving takes the ghost; a tap off the floor does nothing.
  fire(v.canvas, 'pointerleave');
  v.card('psu').click();
  assert.equal(v.status(), 'PSU (50 cycles): Power supply: +25 cycles every 10 s. Now pick a cell.');
  v.tap(2, -1);
  clock.frame(16);
  assert.equal(v.status(), 'PSU (50 cycles): Power supply: +25 cycles every 10 s. Now pick a cell.');
  assert.deepEqual(v.ghost(), []);
});

test('packet-siege: a cable tray takes nothing: the DMZ level says so', (t) => {
  const { clock, v } = openPage(t, { save: wonUpTo(10) });
  v.level(11).click();
  assert.deepEqual(v.screen(), ['loadout']);
  v.click('loadout-start');
  const tray = pks.pksLevel(11).blocked[0];
  v.card('firewall').click();
  v.move(tray.lane, tray.col);
  clock.frame(16);
  assert.equal(v.status(), 'Cable tray: nothing fits here');
  v.tap(tray.lane, tray.col);
  assert.equal(v.status(), 'Cable tray: nothing fits here');
});

test('packet-siege: pksRefusalText for each reason pksCanPlace gives the page', () => {
  const sim = pks.pksNewSim(2, ['psu', 'firewall']);
  assert.equal(pks.pksRefusalText(pks.pksCanPlace(sim, 'psu', 0, 0)), 'Lane 1 is closed on this level (in play: 2, 3, 4)');
  sim.cycles = 30;
  assert.equal(pks.pksRefusalText(pks.pksCanPlace(sim, 'psu', 1, 0)), 'Not enough cycles: 30 of 50');
  sim.cards[0].left = 61;
  assert.equal(pks.pksRefusalText(pks.pksCanPlace(sim, 'psu', 1, 0)), 'PSU recharging: 1.1 s');
});

test('packet-siege: a pointer press that moves (the page scrolling under a finger), another finger or another button is not a tap', (t) => {
  const { clock, v } = openModule(t, { pointer: true });
  v.level(1).click();
  v.card('psu').click();
  const at = { clientX: 40, clientY: 100, pointerId: 3, pointerType: 'touch', button: 0 };
  fire(v.canvas, 'pointerdown', at);
  fire(v.canvas, 'pointerup', Object.assign({}, at, { clientY: 130 }));
  assert.equal(v.rt.sim.defenders.length, 0, 'a drag');
  fire(v.canvas, 'pointerdown', at);
  fire(v.canvas, 'pointercancel', at);
  fire(v.canvas, 'pointerup', at);
  assert.equal(v.rt.sim.defenders.length, 0, 'cancelled');
  fire(v.canvas, 'pointerdown', at);
  fire(v.canvas, 'pointerup', Object.assign({}, at, { pointerId: 4 }));
  assert.equal(v.rt.sim.defenders.length, 0, 'another finger');
  fire(v.canvas, 'pointerdown', Object.assign({}, at, { button: 2 }));
  fire(v.canvas, 'pointerup', at);
  assert.equal(v.rt.sim.defenders.length, 0, 'the right button');
  fire(v.canvas, 'pointerdown', at);
  fire(v.canvas, 'pointerup', Object.assign({}, at, { clientX: 44, clientY: 104 }));
  assert.deepEqual(v.rt.sim.defenders.map((d) => [d.type, d.lane, d.col]), [['psu', 2, 0]], 'a tap with a little wobble');
  // A field shown at another size: the pointer maps through its box.
  v.canvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 960, height: 540 });
  v.rt.sim.cycles = 1000;
  clock.run(6);
  v.card('firewall').click();
  fire(v.canvas, 'pointermove', { clientX: 100 + (24 + 32 + 16) * 3, clientY: 50 + (20 + 2 * 32 + 16) * 3, pointerId: 1 });
  clock.frame(16);
  assert.deepEqual(v.rt.view.ghost, { card: 'firewall', lane: 2, col: 1, ok: true });
});

test('packet-siege: on a page column of 958 px (a fractional scale) the pointer finds the cell under it at the corners and on every border', (t) => {
  const { v } = openModule(t, { pointer: true, width: 958 });
  v.level(1).click();
  const L = v.rt.layout;
  assert.deepEqual([L.field.w, L.field.h], [958, 538]);
  assert.ok(L.scale % 1 !== 0, 'a fractional scale');
  v.canvas.getBoundingClientRect = () => ({ left: 21, top: 300 + L.hud, width: L.field.w, height: L.field.h });
  const aim = (x, y) => {
    fire(v.canvas, 'pointermove', { clientX: 21 + x, clientY: 300 + L.hud + y, pointerId: 1 });
    return v.rt.aim;
  };
  // Corners of the canvas and of the floor.
  assert.equal(aim(0, 0), null, 'the canvas\'s top left: the rack');
  assert.equal(aim(957, 537), null, 'its bottom right: the right margin');
  assert.deepEqual(aim(72, 60), { lane: 0, col: 0 }, 'the floor\'s first pixel');
  assert.deepEqual(aim(934, 537), { lane: 4, col: 8 }, 'the floor\'s last pixel');
  // The floor's edges: 24 and 312 logical px across (71.85 and 934.1 CSS px), 20 down (59.8).
  assert.equal(aim(71, 60), null);
  assert.equal(aim(935, 60), null);
  assert.equal(aim(72, 59), null);
  // Every border between two cells: the last CSS pixel of one, the first of the next.
  const s = 958 / 320;
  for (let c = 1; c < 9; c++) {
    const edge = (24 + 32 * c) * s;
    assert.deepEqual(aim(Math.ceil(edge) - 1, 200), { lane: 1, col: c - 1 }, 'left of column ' + c);
    assert.deepEqual(aim(Math.ceil(edge), 200), { lane: 1, col: c }, 'column ' + c);
  }
  const sy = 538 / 180;
  for (let l = 1; l < 5; l++) {
    const edge = (20 + 32 * l) * sy;
    assert.deepEqual(aim(500, Math.ceil(edge) - 1), { lane: l - 1, col: 4 }, 'above lane ' + l);
    assert.deepEqual(aim(500, Math.ceil(edge)), { lane: l, col: 4 }, 'lane ' + l);
  }
});

// ── keys ───────────────────────────────────────────────────────────────────

test('packet-siege: the keys: 1-8 by value or physical key, X and Delete, the cursor kept on the field, P and Esc pause, S the speed; held keys act once', (t) => {
  const { clock, v } = openModule(t);
  v.level(1).click();
  v.focusField();
  v.press('5');
  assert.equal(v.status(), 'No card 5 on this level: the cards are 1-2 and X.');
  v.press('ě', { code: 'Digit2' });
  assert.equal(v.rt.selected, 'firewall', 'Digit2 on another layout');
  v.press('x');
  assert.equal(v.rt.selected, 'decom');
  v.press('Delete');
  assert.equal(v.rt.selected, null, 'the same card again');
  v.press('Ч', { code: 'KeyX' });
  assert.equal(v.rt.selected, 'decom');
  v.press('2', { repeat: true });
  assert.equal(v.rt.selected, 'decom', 'a held number acts once');
  // The cursor starts on the middle lane in play at the rack and stays on the floor.
  v.press('ArrowUp');
  assert.deepEqual(v.rt.cursor, { lane: 1, col: 0 });
  for (let i = 0; i < 6; i++) v.press('ArrowUp', { repeat: true });
  v.press('ArrowLeft');
  assert.deepEqual(v.rt.cursor, { lane: 0, col: 0 });
  for (let i = 0; i < 12; i++) v.press('ArrowRight');
  for (let i = 0; i < 6; i++) v.press('ArrowDown');
  assert.deepEqual(v.rt.cursor, { lane: 4, col: 8 });
  assert.deepEqual(v.rt.view.cursor, { lane: 4, col: 8 }, 'shown while the field has the focus');
  focusElement(document.body);
  assert.equal(v.rt.view.cursor, null, 'hidden without the focus');
  focusElement(v.canvas);
  // P and Esc pause and resume (on the page); S changes the speed.
  v.press('p');
  assert.equal(v.rt.paused, true);
  v.press('s');
  assert.equal(v.rt.state.speed, 1, 'not while paused');
  v.press('1');
  assert.equal(v.rt.selected, 'decom', 'no card while paused');
  v.press('Escape');
  assert.equal(v.rt.paused, false);
  v.press('P', { code: 'KeyP' });
  v.press('з', { code: 'KeyP' });
  assert.equal(v.rt.paused, false);
  v.press('S');
  assert.equal(v.rt.state.speed, 2);
  assert.equal(v.status(), 'Speed 2x.');
  v.press('ы', { code: 'KeyS', repeat: true });
  assert.equal(v.rt.state.speed, 2, 'a held S acts once');
  v.press('ы', { code: 'KeyS' });
  assert.equal(v.rt.state.speed, 1, 'S by the physical key');
  clock.frame(16);
});

test('packet-siege: keys act only while the field has the focus, never scroll the page then, and leave modified and unknown keys alone', (t) => {
  const { v } = openModule(t);
  v.level(1).click();
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', ' ', 'Enter', '1', 'x', 's', 'S']) {
    assert.equal(v.press(key).defaultPrevented, true, key);
  }
  for (const props of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    assert.equal(v.press('ArrowRight', props).defaultPrevented, false, JSON.stringify(props));
  }
  const handled = keyEvent('1', { target: v.canvas });
  handled.preventDefault();
  v.canvas.dispatchEvent(handled);
  assert.equal(v.rt.selected, 'decom', 'a key a host handler already took is left alone');
  assert.equal(v.press('q').defaultPrevented, false);
  assert.equal(v.press(undefined).defaultPrevented, false);
  assert.equal(pks.pksKeyAction({ key: 'toString', code: 'constructor' }), null);
  assert.equal(pks.pksKeyAction({ key: 'q', code: 'KeyQ' }), null);
  assert.equal(pks.pksKeyAction({ key: 'f', code: 'KeyF' }), 'fullscreen');
  assert.equal(pks.pksKeyAction({ key: 'а', code: 'KeyF' }), 'fullscreen');
  assert.equal(pks.pksKeyAction({ key: 'Escape', code: 'Escape' }), 'escape');
  // Elsewhere on the page the keys are the page's.
  const field = v.page.add('host-field', 'input');
  focusElement(field);
  assert.equal(pressKey('ArrowLeft', { target: field }).defaultPrevented, false);
  assert.equal(pressKey(' ').defaultPrevented, false);
  assert.equal(pressKey('f', { target: field }).defaultPrevented, false, 'F outside the frame is the page\'s');
  assert.equal(v.rt.mode, 'page');
  assert.equal(v.rt.selected, 'decom');
});

test('packet-siege: a key the game takes stops at the field, so the host page\'s shortcuts never see it; other keys, modified keys and keys elsewhere reach them', (t) => {
  const { v } = openPage(t);
  v.level(1).click();
  const seen = [];
  document.addEventListener('keydown', (e) => seen.push('down ' + e.key));
  document.addEventListener('keyup', (e) => seen.push('up ' + e.key));
  for (const key of ['ArrowRight', '1', ' ', 'x', 's', 'p', 'p']) {
    v.press(key);
    v.canvas.dispatchEvent(keyEvent(key, { type: 'keyup' }));
  }
  assert.deepEqual(seen, [], 'none of the game\'s keys');
  v.press('q');
  v.canvas.dispatchEvent(keyEvent('q', { type: 'keyup' }));
  v.press('ArrowRight', { ctrlKey: true });
  v.canvas.dispatchEvent(keyEvent('ArrowRight', { type: 'keyup', ctrlKey: true }));
  assert.deepEqual(seen, ['down q', 'up q', 'down ArrowRight', 'up ArrowRight']);
  seen.length = 0;
  const field = v.page.add('host-field', 'input');
  focusElement(field);
  pressKey('p', { target: field });
  assert.deepEqual(seen, ['down p']);
});

test('packet-siege: a mouse click on a card or a HUD button hands the keys back to the field; a keyboard press keeps the focus on the button', (t) => {
  const { v } = openModule(t);
  v.level(1).click();
  focusElement(v.card('psu'), { keyboard: true });
  v.card('psu').dispatchEvent(keyEvent('Enter', { type: 'click', detail: 0 }));
  assert.equal(v.rt.selected, 'psu');
  assert.equal(document.activeElement, v.card('psu'));
  v.card('psu').click();
  assert.equal(v.rt.selected, null);
  assert.equal(document.activeElement, v.canvas);
  focusElement(v.el('speed'), { keyboard: true });
  v.el('speed').dispatchEvent(keyEvent('Enter', { type: 'click', detail: 0 }));
  assert.equal(document.activeElement, v.el('speed'));
  assert.equal(v.text('speed'), '2x');
  assert.equal(v.el('speed').getAttribute('aria-pressed'), 'true');
});

// ── pause, the leave question, help, speed, the loop ───────────────────────

test('packet-siege: the window losing the focus or a hidden tab pauses; the overlay resumes, restarts or leaves (asking first)', (t) => {
  const { clock, v } = openPage(t);
  fire(window, 'blur');
  setVisibility('hidden', t);
  assert.deepEqual(v.screen(), ['select'], 'nothing to pause on the level select');
  setVisibility('visible', t);
  v.level(1).click();
  clock.run(2);
  const cycles = v.text('cycles');
  fire(window, 'blur');
  assert.equal(v.hidden('paused'), false);
  assert.equal(v.text('pause'), 'Resume');
  assert.equal(v.el('pause').getAttribute('aria-pressed'), 'true');
  assert.equal(v.live(), 'Paused.');
  assert.equal(clock.pending(), 0, 'the loop stopped');
  fire(window, 'blur');
  setVisibility('hidden', t);
  assert.equal(clock.pending(), 0);
  setVisibility('visible', t);
  assert.equal(v.hidden('paused'), false, 'shown again it waits');
  v.click('resume');
  assert.equal(v.hidden('paused'), true);
  assert.equal(v.text('pause'), 'Pause');
  assert.equal(v.status(), 'Resumed.');
  assert.equal(document.activeElement, v.canvas);
  assert.equal(clock.pending(), 1);
  clock.stall(5000).frame(16);
  assert.equal(v.text('cycles'), cycles, 'the paused time is not caught up');
  setVisibility('hidden', t);
  assert.equal(v.hidden('paused'), false);
  // The HUD button pauses and resumes; Restart asks, then starts the same cards afresh.
  v.click('pause');
  assert.equal(v.hidden('paused'), true);
  v.click('pause');
  v.click('restart');
  assert.equal(v.hidden('confirm'), false);
  assert.equal(v.hidden('paused'), true, 'the question stands in for the pause overlay');
  assert.equal(v.text('confirm-text'), 'Restart this level? Progress in it is lost.');
  assert.equal(v.text('confirm-yes'), 'Restart');
  v.click('confirm-yes');
  assert.equal(v.hidden('confirm'), true);
  assert.equal(v.hidden('paused'), true);
  assert.equal(v.text('pause'), 'Pause');
  assert.equal(v.text('surge'), 'Surge 0/' + L1.surges.length);
  assert.equal(clock.pending(), 1);
  v.click('pause');
  v.click('quit');
  assert.equal(v.text('confirm-text'), 'Leave this level? It is saved: Resume on the level select picks it up again.');
  assert.equal(v.text('confirm-yes'), 'Leave');
  v.click('confirm-yes');
  assert.deepEqual(v.screen(), ['select']);
  assert.equal(document.activeElement, v.el('run-resume'), 'the level in progress is offered');
  assert.equal(clock.pending(), 0);
  v.level(1).click();
  assert.equal(localStorage.getItem(RUN_KEY), null, 'starting a level drops the saved one');
  // with storage that refuses the snapshot, leaving says what it costs
  const setItem = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === RUN_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return setItem.call(localStorage, key, value);
  };
  t.after(() => { localStorage.setItem = setItem; });
  v.click('levels');
  assert.equal(v.text('confirm-text'), 'Leave this level? Progress in it is lost.');
  v.click('confirm-yes');
  assert.deepEqual(v.screen(), ['select']);
  assert.equal(v.hidden('run'), true);
  assert.equal(document.activeElement, v.level(1));
  assert.equal(clock.pending(), 0);
});

test('packet-siege: leaving a level in progress asks once in the frame; Stay goes back to where the level was', (t) => {
  const { clock, v } = openModule(t);
  v.level(1).click();
  clock.frame(16).run(1);
  const tick = v.rt.sim.tick;
  // From the HUD while the level runs: it pauses under the question; Stay runs it on.
  v.click('levels');
  assert.equal(v.hidden('confirm'), false);
  assert.equal(v.el('confirm').getAttribute('role'), 'alertdialog');
  assert.equal(v.rt.paused, true);
  assert.equal(v.hidden('paused'), true);
  assert.equal(clock.pending(), 0, 'the level waits for the answer');
  assert.equal(document.activeElement, v.el('confirm-no'), 'the safe answer has the focus');
  assert.deepEqual(v.screen(), ['play']);
  v.click('confirm-no');
  assert.equal(v.hidden('confirm'), true);
  assert.equal(v.rt.paused, false);
  assert.equal(clock.pending(), 1);
  clock.frame(16).frame(1000 / 60);
  assert.equal(v.rt.sim.tick, tick + 1, 'nothing was restarted');
  // From the pause overlay: Stay brings the pause overlay back.
  v.click('pause');
  v.click('quit');
  assert.equal(v.hidden('paused'), true);
  v.click('confirm-no');
  assert.equal(v.hidden('paused'), false);
  assert.equal(v.rt.paused, true);
  assert.equal(document.activeElement, v.el('resume'));
  // The HUD's Pause button while the question shows resumes and closes it.
  v.click('levels');
  assert.equal(v.hidden('confirm'), false);
  v.click('pause');
  assert.equal(v.hidden('confirm'), true);
  assert.equal(v.rt.paused, false);
  // Once the level is over there is nothing to lose: Levels and Replay act at once.
  finish(v);
  clock.frame(16).frame(1000 / 60);
  assert.equal(v.rt.sim.status, 'won');
  v.click('levels');
  assert.deepEqual(v.screen(), ['select'], 'in the beat after a win');
  v.level(1).click();
  finish(v);
  clock.frame(16).frame(1000 / 60).run(2);
  assert.deepEqual(v.screen(), ['result']);
  v.click('levels');
  assert.equal(v.hidden('confirm'), true);
  assert.deepEqual(v.screen(), ['select'], 'from the result');
  assert.doesNotMatch(UI, /window\.confirm|\bconfirm\(/, 'no browser dialog');
});

test('packet-siege: How to play is an overlay in the frame, from the level select and from the pause overlay', (t) => {
  const { v } = openModule(t);
  assert.equal(v.hidden('help'), true);
  v.click('help-open');
  assert.equal(v.hidden('help'), false);
  assert.equal(v.el('help').getAttribute('role'), 'dialog');
  assert.equal(document.activeElement, v.el('help-close'));
  assert.deepEqual(v.screen(), ['select'], 'over the level select');
  v.click('help-close');
  assert.equal(v.hidden('help'), true);
  assert.equal(document.activeElement, v.el('help-open'));
  v.level(1).click();
  v.click('pause');
  v.click('pause-help');
  assert.equal(v.hidden('help'), false);
  assert.equal(v.hidden('paused'), true, 'the help stands in for the pause overlay');
  assert.equal(v.rt.paused, true);
  fire(window, 'blur');
  assert.equal(v.hidden('paused'), true);
  v.click('help-close');
  assert.equal(v.hidden('paused'), false, 'back to the pause overlay');
  assert.equal(document.activeElement, v.el('pause-help'));
  // Its text names no number a level can change (start cycles, the trickle).
  const help = HTML.slice(HTML.indexOf('id="pks-help"'), HTML.indexOf('id="pks-help-close"'));
  assert.match(help, /S switches between 1x and 2x speed, F toggles fullscreen/);
  assert.match(help, /P pauses \(Esc too, outside fullscreen\)/);
  assert.doesNotMatch(help, /start with \d|\b100\b|\b25\b|every 10 s/);
  assert.doesNotMatch(readRepoFile(GAME + '/src/ui-text.js').match(/function pksStartText[\s\S]*?\n\}/)[0], /\b100\b|cycles/);
});

test('packet-siege: a step slot is one sim step at 1x and two at 2x; a frame catches up 0.25 s at most; the speed is saved', (t) => {
  const { clock, v } = openModule(t);
  v.level(1).click();
  clock.frame(16);
  assert.equal(v.rt.sim.tick, 0, 'the first frame only takes the time');
  clock.frame(1000 / 60);
  assert.equal(v.rt.sim.tick, 1);
  clock.frame(250);
  assert.equal(v.rt.sim.tick, 16);
  clock.stall(5000).frame(16);
  assert.equal(v.rt.sim.tick, 31, 'a stalled tab catches up 15 steps');
  clock.frame(0);
  assert.equal(v.rt.sim.tick, 31);
  v.click('speed');
  assert.equal(v.save().speed, 2);
  clock.frame(1000 / 60);
  assert.equal(v.rt.sim.tick, 33);
  clock.frame(250);
  assert.equal(v.rt.sim.tick, 63);
  v.click('speed');
  assert.equal(v.save().speed, 1);
  assert.equal(v.text('speed'), '1x');
  assert.equal(v.el('speed').getAttribute('title'), 'Game speed, 1x or 2x (S)');
});

test('packet-siege: a surge is announced 3 s ahead in the HUD, the status line and the live region', (t) => {
  const { clock, v } = openModule(t);
  v.level(1).click();
  const at = L1.surges[0];
  const total = L1.surges.length;
  v.rt.sim.spawnIndex = L1.spawns.filter((s) => s.t < at - 3).length;
  v.rt.sim.tick = STEPS(at - 3) - 2;
  clock.frame(16).frame(1000 / 60);
  assert.equal(v.text('surge'), 'Surge 0/' + total);
  clock.frame(1000 / 60);
  assert.equal(v.text('surge'), 'Surge incoming!');
  assert.ok(v.el('surge').classList.contains('pks-hud-surge--warn'));
  assert.equal(v.status(), 'Surge 1 of ' + total + ' in 3 s: get ready.');
  assert.equal(v.live(), 'Surge 1 of ' + total + ' in 3 s: get ready.');
  clock.run(3.25);
  assert.equal(v.text('surge'), 'Surge 1/' + total);
  assert.ok(!v.el('surge').classList.contains('pks-hud-surge--warn'));
});

test('packet-siege: after a win the result waits a beat; nothing pauses or takes input then; the result names the best only when it is higher', (t) => {
  const { clock, v } = openModule(t);
  v.level(1).click();
  v.card('psu').click();
  clock.frame(16);
  finish(v, 1);
  clock.frame(1000 / 60);
  assert.equal(v.rt.sim.status, 'won');
  assert.equal(v.status(), 'Level 1 secured with 2 of 3 stars.');
  assert.equal(v.live(), 'Level 1 secured with 2 of 3 stars.');
  assert.equal(v.rt.selected, null);
  assert.equal(v.save().stars[0], 2, 'saved at once');
  fire(window, 'blur');
  assert.equal(v.rt.paused, false, 'no pause in the beat');
  v.press('p');
  v.card('psu').click();
  v.tap(2, 0);
  assert.equal(v.rt.selected, null);
  assert.equal(v.rt.sim.defenders.length, 0);
  clock.frame(250).frame(250).frame(250).frame(250);
  assert.deepEqual(v.screen(), ['play']);
  clock.frame(250);
  assert.deepEqual(v.screen(), ['result']);
  assert.equal(v.$$('.pks-result-star').length, 3);
  assert.equal(v.text('result-text'), 'Breakers tripped: 1. Stars: 2 of 3.');
  // Replay and win again with as many stars: no word about the best.
  v.click('replay');
  finish(v, 1);
  clock.frame(16).frame(1000 / 60).run(2);
  assert.equal(v.text('result-text'), 'Breakers tripped: 1. Stars: 2 of 3.', 'the best equals this run');
  // With fewer stars: the best stays and is named.
  v.click('replay');
  finish(v, 3);
  clock.frame(16).frame(1000 / 60).run(2);
  assert.equal(v.text('result-text'), 'Breakers tripped: 3. Stars: 1 of 3. Your best here stays 2 of 3.');
  assert.deepEqual(v.$$('.pks-unlock').map((p) => p.textContent), [], 'nothing new');
  v.click('result-levels');
  assert.equal(v.level(1).getAttribute('aria-label'), 'Level 1, Power On: 2 of 3 stars');
  assert.equal(v.level(1).textContent, '1★★☆');
  assert.equal(v.text('total'), '2 of 450');
  // Leaving in the beat: the result never shows.
  v.level(1).click();
  finish(v);
  clock.frame(16).frame(1000 / 60);
  v.click('levels');
  clock.run(2);
  assert.deepEqual(v.screen(), ['select']);
});

test('packet-siege: winning level 10 opens a sixth slot and the IDS; winning level 50 opens level 51 and brings the Canary; a boss breach names the APT', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(9, 3, { loadout: ['psu', 'firewall', 'proxy', 'tarpit', 'nullroute'] }) });
  v.level(10).click();
  assert.deepEqual(v.screen(), ['loadout']);
  v.click('loadout-start');
  finish(v);
  clock.frame(16).frame(1000 / 60).run(2);
  assert.deepEqual(v.$$('.pks-unlock').map((p) => p.textContent.split('.')[0]), ['New defender: IDS', 'Loadout slots: 6 from level 11', 'Level 11, Edge Router, is open']);
  assert.equal(v.$$('.pks-unlock-icon').length, 1);
  resetStubs();
  const last = openModule(t, { save: wonUpTo(49) });
  last.v.level(50).click();
  last.v.click('loadout-start');
  breach(last.v, 2, 'boss');
  last.clock.frame(16).frame(1000 / 60).run(2);
  assert.equal(last.v.text('result-text'), 'APT boss reached the rack after the lane\'s breaker had tripped.');
  last.v.click('replay');
  last.v.click('loadout-start');
  finish(last.v);
  last.clock.frame(16).frame(1000 / 60).run(2);
  assert.equal(last.v.text('result-title'), 'Level 50 secured');
  assert.deepEqual(last.v.$$('.pks-unlock').map((p) => p.textContent), [
    'New defender: Canary. ' + pks.pksDefender.canary.desc,
    'Level 51, ' + pks.pksLevel(51).name + ', is open.'
  ]);
  assert.equal(last.v.$$('.pks-unlock-icon').length, 1, 'the Canary\'s card');
  assert.equal(last.v.hidden('next'), false, 'level 51 is next');
  assert.equal(document.activeElement, last.v.el('next'));
  assert.equal(last.v.save().stars[49], 3);
  assert.equal(last.v.save().unlocked, 51);
  assert.equal(pks.pksHighestWon(last.v.save()), 50);
  last.v.click('next');
  assert.deepEqual(last.v.screen(), ['loadout']);
  const canary = last.v.$('#pks-pick-canary');
  assert.equal(canary.getAttribute('aria-pressed'), 'false', 'the last loadout fills the eight slots');
  last.v.$('#pks-pick-' + last.v.rt.loadout.pick[0]).click();
  canary.click();
  last.v.click('loadout-start');
  assert.equal(last.v.text('hud-level'), 'L51 · ' + pks.pksLevel(51).name);
  assert.ok(last.v.rt.cards.includes('canary'));
  assert.ok(last.v.$$('.pks-news-item').some((p) => /^New defender: Canary\./.test(p.textContent)));
  assert.ok(last.v.$$('.pks-news-item').some((p) => p.textContent === 'Zone rule: Express. Enemies in the marked lanes (' +
    pks.pksLevel(51).rules.express.map((l) => l + 1).join(', ') + ') move ' + Math.round((pks.pksConstants.EXPRESS - 1) * 100) + ' % faster.'));
});

test('packet-siege: winning level 70 opens a ninth slot, level 110 a tenth; winning level 150 completes the campaign with no next level', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(69) });
  v.level(70).click();
  v.click('loadout-start');
  finish(v);
  clock.frame(16).frame(1000 / 60).run(2);
  assert.ok(v.$$('.pks-unlock').map((p) => p.textContent).includes('Loadout slots: 9 from level 71.'));
  resetStubs();
  const ten = openModule(t, { save: wonUpTo(109) });
  ten.v.level(110).click();
  ten.v.click('loadout-start');
  finish(ten.v);
  ten.clock.frame(16).frame(1000 / 60).run(2);
  const lines = ten.v.$$('.pks-unlock').map((p) => p.textContent.split('.')[0]);
  assert.deepEqual(lines, ['New defender: Scrubber', 'Loadout slots: 10 from level 111', 'Level 111, ' + pks.pksLevel(111).name + ', is open']);
  resetStubs();
  const last = openModule(t, { save: wonUpTo(149) });
  last.v.level(150).click();
  assert.equal(last.v.text('loadout-title'), 'Level 150, ' + pks.pksLevel(150).name + ': pick 10 defenders');
  last.v.click('loadout-start');
  assert.equal(last.v.cards().length, 11, 'ten cards and Decommission');
  finish(last.v);
  last.clock.frame(16).frame(1000 / 60).run(2);
  assert.equal(last.v.text('result-title'), 'Level 150 secured');
  assert.deepEqual(last.v.$$('.pks-unlock').map((p) => p.textContent), ['Campaign complete: the core holds. Replay any level for more stars.']);
  assert.equal(last.v.hidden('next'), true, 'no level 151');
  assert.equal(document.activeElement, last.v.el('replay'));
  assert.equal(pks.pksHighestWon(last.v.save()), 150);
  assert.equal(last.v.save().unlocked, 150);
});

test('packet-siege: without pointer events the mouse moves the ghost and a click (a mouse click or a tap) places', (t) => {
  const { clock, v } = openPage(t);
  v.level(1).click();
  v.card('psu').click();
  v.move(2, 3);
  clock.frame(16);
  assert.deepEqual(v.ghost(), ['cursor@120,84']);
  fire(v.canvas, 'mouseleave');
  clock.frame(16);
  assert.deepEqual(v.ghost(), []);
  focusElement(v.el('speed'));
  v.tap(2, 3);
  assert.equal(v.status(), 'PSU placed: 50 cycles.');
  assert.equal(document.activeElement, v.canvas, 'the field takes the keys');
});

test('packet-siege: the news banner goes after its time of play or the first placement, and moves off the top lanes while they are aimed at', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(3, 3, { met: ['bot', 'kiddie'] }) });
  const news = v.el('news');
  v.level(4).click();
  assert.equal(news.classList.contains('pks-news--off'), false);
  assert.match(news.textContent, /^New threat: Worm\./);
  v.rt.aim = { lane: 0, col: 3 };
  clock.frame(16);
  assert.ok(news.classList.contains('pks-news--low'), 'aiming at lane 1: the banner at the bottom');
  v.rt.aim = { lane: 3, col: 3 };
  clock.frame(16);
  assert.ok(!news.classList.contains('pks-news--low'));
  v.rt.aim = null;
  clock.frame(16);
  assert.ok(!news.classList.contains('pks-news--low'));
  // Paused time does not count; the play time does.
  v.click('pause');
  clock.stall(20000).frame(16);
  assert.equal(news.classList.contains('pks-news--off'), false);
  v.click('pause');
  clock.frame(16).run(10);
  assert.equal(news.classList.contains('pks-news--off'), true, 'gone after its seconds of play');
  assert.equal(v.rt.newsEnd, 0);
  // A restart shows it again; a level without news has none showing.
  v.click('pause');
  v.click('restart');
  v.click('confirm-yes');
  assert.equal(news.classList.contains('pks-news--off'), false);
  assert.equal(v.rt.newsEnd, STEPS(10));
  v.click('levels');
  v.click('confirm-yes');
  v.level(1).click();
  assert.equal(news.classList.contains('pks-news--off'), true, 'the Bot is met and no defender is new');
  assert.equal(v.rt.newsEnd, 0);
});

// ── the loadout ────────────────────────────────────────────────────────────

test('packet-siege: the loadout screen comes exactly when the player owns more defenders than the level has slots', (t) => {
  // Owned after the highest level won, and the slots of each level.
  const cases = [[0, 1, false], [3, 4, false], [5, 6, false], [8, 9, true], [8, 1, true], [10, 11, true], [30, 31, true], [44, 45, true]];
  for (const [won, n, loadout] of cases) {
    resetStubs();
    const { v } = openPage(t, { save: wonUpTo(won) });
    v.level(n).click();
    assert.deepEqual(v.screen(), [loadout ? 'loadout' : 'play'], 'won ' + won + ', level ' + n);
    const owned = pks.pksUnlockedDefenders(won).length;
    assert.equal(loadout, owned > pks.pksSlots(n));
    v.restore();
  }
});

test('packet-siege: the loadout: owned defenders as toggles with cost and description, the last loadout picked, Start only with every slot filled', (t) => {
  const { clock, v } = openPage(t, { save: wonUpTo(10, 3, { loadout: ['ids', 'psu', 'firewall'] }) });
  v.level(11).click();
  assert.equal(v.text('loadout-title'), 'Level 11, Edge Router: pick 6 defenders');
  const picks = () => v.$$('.pks-pick').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.id.slice('pks-pick-'.length));
  assert.deepEqual(v.$$('.pks-pick').map((b) => b.id), ['psu', 'firewall', 'tarpit', 'ids', 'proxy', 'honeypot', 'nullroute'].map((id) => 'pks-pick-' + id), 'grouped by what they do');
  assert.deepEqual(v.$$('.pks-loadout-head').map((h) => h.textContent), ['Cycles', 'Shooters', 'Walls and traps', 'Instants']);
  assert.equal(v.$$('.pks-loadout-list').length, 4);
  assert.equal(v.$('#pks-pick-tarpit').textContent, 'Tarpit · 175Shoots like a Firewall; a hit slows the target to half speed.');
  assert.deepEqual(picks().sort(), ['firewall', 'honeypot', 'ids', 'nullroute', 'psu', 'tarpit'], 'the last loadout, filled up with the newest');
  assert.equal(v.text('loadout-count'), 'Slots: 6 of 6');
  assert.equal(v.el('loadout-start').disabled, false);
  assert.equal(document.activeElement, v.el('loadout-start'));
  v.$('#pks-pick-proxy').click();
  assert.equal(v.text('loadout-count'), 'All 6 slots are taken: drop one first.');
  assert.deepEqual(picks().length, 6);
  v.$('#pks-pick-honeypot').click();
  assert.equal(v.text('loadout-count'), 'Slots: 5 of 6');
  assert.equal(v.el('loadout-start').disabled, true);
  v.$('#pks-pick-proxy').click();
  assert.equal(v.el('loadout-start').disabled, false);
  v.click('loadout-start');
  assert.deepEqual(v.cards(), ['psu', 'firewall', 'proxy', 'tarpit', 'nullroute', 'ids', 'decom'], 'in unlock order');
  assert.deepEqual(v.$$('.pks-card-name').map((s) => s.textContent), ['PSU', 'Firewall', 'Proxy', 'Tarpit', 'Null Route', 'IDS', 'Decom']);
  assert.deepEqual(v.save().loadout, ['psu', 'firewall', 'proxy', 'tarpit', 'nullroute', 'ids']);
  // Back from the loadout, and the same loadout next time.
  v.click('levels');
  v.click('confirm-yes');
  v.level(11).click();
  assert.deepEqual(picks().sort(), ['firewall', 'ids', 'nullroute', 'proxy', 'psu', 'tarpit']);
  v.click('loadout-back');
  assert.deepEqual(v.screen(), ['select']);
  assert.equal(document.activeElement, v.el('run-resume'), 'the level left is offered to resume');
  assert.equal(clock.pending(), 0);
});

test('packet-siege: the loadout with all 27 defenders: every one in its group, ten slots on the last levels, the newest preselected', (t) => {
  const { v } = openModule(t, { save: wonUpTo(149) });
  v.level(150).click();
  const ids = v.$$('.pks-pick').map((b) => b.id.slice('pks-pick-'.length));
  assert.deepEqual(ids.slice().sort(), pks.pksDefenders.map((d) => d.id).sort(), 'all 27, once each');
  assert.equal(ids.length, 27);
  assert.deepEqual(v.$$('.pks-loadout-head').map((h) => h.textContent), ['Cycles', 'Shooters', 'Walls and traps', 'Support', 'Instants']);
  assert.equal(v.text('loadout-count'), 'Slots: 10 of 10');
  const picked = v.$$('.pks-pick').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.id.slice(9));
  assert.deepEqual(picked.sort(), pks.pksUnlockedDefenders(149).slice(-10).sort());
});

// ── the codex ──────────────────────────────────────────────────────────────

test('packet-siege: the codex: owned defenders and met threats with icon, numbers and a line; the rest as silhouettes with the level that reveals them', (t) => {
  const { v } = openPage(t, { save: wonUpTo(3, 3, { met: ['bot', 'kiddie', 'boss'] }) });
  v.click('codex-open');
  assert.deepEqual(v.screen(), ['codex']);
  assert.equal(document.activeElement, v.el('codex-back'));
  const rows = (name) => v.el(name).children.map((row) => row.children[1].children.map((s) => s.textContent).join(' | '));
  const defenders = rows('codex-defenders');
  assert.equal(defenders.length, 27);
  assert.deepEqual(defenders.slice(0, 5), [
    'PSU | Cost 50 · recharge 5 s · HP 300 | Power supply: +25 cycles every 10 s.',
    'Firewall | Cost 100 · recharge 5 s · HP 300 | Fires one packet every 1.5 s at the first enemy in its lane.',
    'Reverse Proxy | Cost 50 · recharge 20 s · HP 2400 | A wall that soaks up bites and stops an Exploit\'s leap.',
    'Honeypot | Cost 25 · recharge 20 s · HP 300 | Arms in 12 s, then blows up the first enemy to touch it (900).',
    '? | Unlocked by winning level 5.'
  ]);
  assert.equal(defenders[14], '? | Unlocked by winning level 44.');
  assert.equal(defenders[15], '? | Unlocked by winning level 50.', 'the Canary');
  assert.equal(defenders[26], '? | Unlocked by winning level ' + pks.pksDefender.honeynet.unlock + '.');
  const threats = rows('codex-enemies');
  assert.equal(threats.length, 25);
  assert.deepEqual(threats.slice(0, 3), [
    'Bot | HP 200 · speed 0.2 · bite 100/s | A compromised host doing what it is told. Slow, steady, plentiful.',
    'Script Kiddie | HP 140 · speed 0.42 · bite 100/s | Runs other people\'s tools at twice the pace of a Bot.',
    '? | First seen on level 4.'
  ]);
  assert.equal(threats[24], '? | First seen on level ' + pks.pksEnemy.glitch.first + '.');
  const bosses = rows('codex-bosses');
  assert.equal(bosses.length, 15);
  assert.deepEqual(bosses.slice(0, 2), ['? | Faced on level 10.', '? | Faced on level 20.']);
  const zones = rows('codex-zones');
  assert.equal(zones.length, 15);
  assert.equal(zones[0], 'Zone 1 · Server closet | Levels 1-10 | ' + pks.pksZones[0].desc);
  assert.equal(zones[9], '? | Reached at level 91.');
  assert.equal(v.$$('.pks-entry--locked').length, 23 + 23 + 15 + 14);
  assert.equal(v.$$('.pks-entry-icon').length, 27 + 25 + 15 + 15);
  v.click('codex-back');
  assert.deepEqual(v.screen(), ['select']);
  assert.equal(document.activeElement, v.el('codex-open'), 'no level played yet: back on the Codex button');
});

test('packet-siege: the codex late in the campaign: every boss tier in its own colours with its numbers, every zone with its rule', (t) => {
  const { v } = openModule(t, { save: wonUpTo(149, 3, { met: pks.pksEnemies.map((e) => e.id).concat(['boss']) }) });
  v.click('codex-open');
  const rows = (name) => v.el(name).children.map((row) => row.children[1].children.map((s) => s.textContent).join(' | '));
  const bosses = rows('codex-bosses');
  assert.ok(pks.pksBossTiers.some((b) => b.twin), 'a twin tier to show');
  pks.pksBossTiers.forEach((b, i) => {
    // a twin tier's hp is the pair's: the codex shows each one's half, as the sim spawns them
    const hp = b.twin ? b.hp / 2 + ' each' : b.hp;
    if (b.twin) {
      const sim = pks.pksNewSim(b.level, ['psu']);
      assert.equal(pks.pksSpawnEnemy(sim, 'boss', 1, 9, b.tier).maxHp, b.hp / 2);
    }
    assert.equal(bosses[i], b.name + ' | HP ' + hp + ' · speed ' + b.speed + ' · bite ' + b.bite + '/s' + (b.twin ? ' · two of them' : '') + ' | ' + b.desc +
      (i === 0 ? ' Instants do capped damage to every boss.' : ''));
  });
  const zones = rows('codex-zones');
  pks.pksZones.forEach((z, i) => assert.equal(zones[i], 'Zone ' + z.zone + ' · ' + z.name + ' | Levels ' + (i * 10 + 1) + '-' + (i * 10 + 10) + ' | ' + z.desc));
  assert.equal(v.$$('.pks-entry--locked').length, 0);
  assert.equal(rows('codex-enemies').length, 25);
});

// ── saves ──────────────────────────────────────────────────────────────────

test('packet-siege: a reload returns to the level select with the progress saved; a level just started and never paused leaves nothing to resume', (t) => {
  const { clock, v } = openModule(t);
  v.level(1).click();
  finish(v);
  clock.frame(16).frame(1000 / 60).run(2);
  v.click('next');
  v.click('speed');
  const again = reload(t, clock, v);
  assert.deepEqual(again.screen(), ['select']);
  assert.equal(again.text('total'), '3 of 450');
  assert.equal(again.level(2).disabled, false);
  assert.equal(again.level(3).disabled, true);
  assert.equal(again.text('speed'), '2x', 'the speed is remembered');
  assert.equal(again.hidden('run'), true);
  assert.equal(localStorage.getItem(SAVE_KEY), '{"v":1,"unlocked":2,"stars":[3' + ',0'.repeat(149) + '],"loadout":[],"speed":2,"met":[]}');
});

// ── the zone rules on the page ─────────────────────────────────────────────

test('packet-siege: a level with a blackout: its badge over the field names the rule, counts down, warns in the live region, and the field goes dark', (t) => {
  const n = levelWith('blackout');
  const lv = pks.pksLevel(n);
  const rule = lv.rules.blackout;
  const { clock, v } = openModule(t, { save: wonUpTo(n - 1), width: 640 });
  v.level(n).click();
  v.click('loadout-start');
  assert.equal(v.hidden('rules'), false);
  const badges = v.$$('.pks-rule');
  assert.equal(badges.length, lv.rules.names.length);
  const b = badges[0];
  const text = pks.pksRuleText('blackout', lv);
  assert.equal(text, 'Blackout: every ' + rule.every + ' s the lights fail for ' + rule.length + ' s (' + rule.warn + ' s warning): shooters then see only ' +
    rule.sight + ' cells ahead, and only what they see stays lit.');
  assert.equal(b.getAttribute('title'), text);
  assert.equal(b.type, 'button');
  assert.equal(b.children[1].textContent, 'Blackout');
  const clockText = () => b.children[2].textContent;
  clock.frame(16);
  assert.equal(clockText(), rule.every + 's', 'the first blackout in every s');
  // the accessible name carries the countdown in words; the badge is no live region
  assert.equal(b.getAttribute('aria-label'), text + ' Now: the lights go out in ' + rule.every + ' s.');
  assert.equal(b.getAttribute('title'), text);
  assert.equal(b.getAttribute('aria-live'), null);
  assert.equal(v.el('rules').getAttribute('aria-live'), null);
  // placed over the canvas's strip: 2x here, names shown
  const box = ['left', 'top', 'width', 'height'].map((p) => v.el('rules').style[p]).join(' ');
  assert.equal(box, '60px 0px 236px 40px');
  assert.ok(v.el('rules').classList.contains('pks-rules--big'));
  // a tap says the rule's line; the pause overlay lists it
  b.click();
  assert.equal(v.status(), text);
  assert.deepEqual(v.$$('.pks-paused-rule').map((li) => li.textContent), [text]);
  assert.equal(v.hidden('paused-rules'), false);
  // the warning: in the status line and the live region, the badge amber
  const sim = v.rt.sim;
  sim.blackout.t = 1;
  clock.frame(1000 / 60);
  assert.equal(sim.blackout.state, 'warn');
  const warn = 'Lights out in ' + rule.warn + ' s for ' + rule.length + ' s: shooters will see only ' + rule.sight + ' cells ahead.';
  assert.equal(v.status(), warn);
  assert.equal(v.live(), warn);
  assert.ok(b.classList.contains('pks-rule--alert'));
  assert.equal(clockText(), Math.ceil(sim.blackout.t / 60) + 's');
  // dark: the status line says so, the badge counts to the light, the field is dark
  sim.blackout.t = 1;
  clock.frame(1000 / 60);
  assert.equal(sim.blackout.state, 'dark');
  assert.equal(v.status(), 'Lights out: shooters see only ' + rule.sight + ' cells ahead for ' + rule.length + ' s.');
  assert.equal(v.live(), warn, 'the live region only for the warning');
  assert.match(clockText(), /^lit \d+s$/);
  assert.equal(b.getAttribute('aria-label'), text + ' Now: dark, the lights come back in ' + clockText().slice(4, -1) + ' s.');
  assert.ok(v.drawn().some((d) => d.name === 'fx-dark'));
  sim.blackout.t = 1;
  clock.frame(1000 / 60);
  assert.equal(v.status(), 'The lights are back on.');
  assert.ok(!b.classList.contains('pks-rule--alert'));
  // a phone-sized frame: the row is the strip's 20 px, icons and clocks only
  v.el('holder').clientWidth = 320;
  fire(window, 'resize');
  assert.ok(!v.el('rules').classList.contains('pks-rules--big'));
  assert.equal(v.el('rules').style.height, '20px');
  // levels 1-50 have no badges
  v.click('levels');
  v.click('confirm-yes');
  v.level(1).click();
  v.click('loadout-start');
  assert.equal(v.hidden('rules'), true);
  assert.equal(v.$$('.pks-rule').length, 0);
  assert.equal(v.hidden('paused-rules'), true);
});

test('packet-siege: a rolling outage warns of its lane, then the badge counts it back; upkeep shows what is due and when; a tunnel exit refuses a card', (t) => {
  const n = levelWith('outage');
  const lv = pks.pksLevel(n);
  const rule = lv.rules.outage;
  const { clock, v } = openModule(t, { save: wonUpTo(n - 1) });
  v.level(n).click();
  v.click('loadout-start');
  const b = v.$$('.pks-rule')[0];
  clock.frame(16);
  assert.equal(b.children[2].textContent, 'L' + (rule.order[0] + 1) + ' ' + rule.every + 's');
  const otext = pks.pksRuleText('outage', lv);
  const secs = () => /(\d+)s$/.exec(b.children[2].textContent)[1];
  assert.equal(b.getAttribute('aria-label'), otext + ' Now: lane ' + (rule.order[0] + 1) + ' goes offline in ' + rule.every + ' s.');
  const sim = v.rt.sim;
  sim.outage.t = 1;
  clock.frame(1000 / 60);
  const lane = sim.outage.lane;
  const warn = 'Lane ' + (lane + 1) + ' goes offline in ' + rule.warn + ' s for ' + rule.length + ' s: its defenders will stop.';
  assert.equal(v.live(), warn);
  assert.equal(v.status(), warn);
  assert.ok(b.classList.contains('pks-rule--alert'));
  assert.equal(b.getAttribute('aria-label'), otext + ' Now: lane ' + (lane + 1) + ' goes offline in ' + secs() + ' s.');
  sim.outage.t = 1;
  clock.frame(1000 / 60);
  assert.equal(v.status(), 'Lane ' + (lane + 1) + ' is offline for ' + rule.length + ' s: its defenders do nothing.');
  assert.match(b.children[2].textContent, new RegExp('^L' + (lane + 1) + ' off \\d+s$'));
  assert.equal(b.getAttribute('aria-label'), otext + ' Now: lane ' + (lane + 1) + ' is offline, back in ' + secs() + ' s.');
  assert.ok(v.drawn().some((d) => d.name === 'fx-outage'));
  sim.outage.t = 1;
  clock.frame(1000 / 60);
  assert.equal(v.status(), 'Lane ' + (lane + 1) + ' is back online.');
  // upkeep
  resetStubs();
  const u = levelWith('upkeep');
  const up = openModule(t, { save: wonUpTo(u - 1) });
  up.v.level(u).click();
  up.v.click('loadout-start');
  const ub = up.v.$$('.pks-rule')[0];
  const cost = pks.pksLevel(u).rules.upkeep.cost;
  up.clock.frame(16);
  assert.match(ub.children[2].textContent, /^-0 \d+s$/);
  up.v.rt.sim.cycles = 1000;
  up.v.card(up.v.rt.cards.find((id) => pks.pksDefender[id].kind !== 'instant')).click();
  up.v.tap(0, 0);
  up.clock.frame(16);
  assert.match(ub.children[2].textContent, new RegExp('^-' + cost + ' \\d+s$'));
  assert.ok(!ub.classList.contains('pks-rule--alert'));
  const utext = pks.pksRuleText('upkeep', pks.pksLevel(u));
  const usecs = () => /(\d+)s$/.exec(ub.children[2].textContent)[1];
  const cyc = (n) => n + (n === 1 ? ' cycle' : ' cycles');
  assert.equal(ub.getAttribute('aria-label'), utext + ' Now: ' + cyc(cost) + ' due in ' + usecs() + ' s.');
  up.v.rt.sim.cycles = 0;
  up.clock.frame(16);
  assert.ok(ub.classList.contains('pks-rule--alert'), 'the cycles do not cover it');
  assert.equal(ub.getAttribute('aria-label'), utext + ' Now: ' + cyc(cost) + ' due in ' + usecs() + ' s, more than you have.');
  // a paid charge says nothing (the pip and the badge show it); one not paid
  // in full says so in the status line, never the live region, each case once
  // per run of such charges; the unpaid one says what the sim does: nothing is
  // switched off and the debt is never collected
  const usim = up.v.rt.sim;
  const MARK = 'status before the charge';
  const charge = (cycles, defenders) => {
    usim.cycles = cycles;
    while (usim.defenders.length < defenders) {
      const id = up.v.rt.cards.find((c) => !['instant', 'trap', 'gen'].includes(pks.pksDefender[c].kind));
      const card = usim.cards.find((c) => c.id === id);
      card.left = 0;
      const keep = usim.cycles;
      usim.cycles = 1e6;
      assert.ok(pks.pksPlace(usim, id, usim.defenders.length, 8).ok);
      usim.cycles = keep;
    }
    up.v.el('live').textContent = '';
    up.v.el('status').textContent = MARK;
    usim.trickleT = 1e6;
    usim.upkeep.t = 1;
    up.clock.frame(1000 / 60);
    assert.equal(up.v.el('live').textContent, '');
    return up.v.status();
  };
  const due = 3 * cost;
  const part = 'Upkeep: ' + (due - 1) + ' of ' + cyc(due) + ' paid, all you had. Nothing is switched off and the rest is never collected.';
  const unpaid = 'Upkeep of ' + cyc(due) + ' not paid: you had no cycles. Nothing is switched off and the rest is never collected.';
  assert.equal(charge(1000, 3), MARK, 'paid: the status line is left alone');
  assert.equal(usim.cycles, 1000 - due);
  assert.equal(charge(due - 1, 3), part);
  assert.equal(usim.cycles, 0);
  assert.equal(charge(due - 1, 3), MARK, 'the same case again in the run: not repeated');
  assert.equal(charge(0, 3), unpaid, 'the other case: said once');
  assert.equal(usim.defenders.length, 3, 'nothing was switched off');
  assert.equal(usim.upkeep.last, 0);
  assert.equal(charge(0, 3), MARK, 'a broke player hears it once');
  assert.equal(charge(0, 3), MARK);
  assert.equal(charge(1000, 3), MARK, 'a paid charge ends the run');
  assert.equal(charge(0, 3), unpaid, 'and the next unpaid one is said again');
  assert.equal(charge(due - 1, 3), part);
  // a tunnel exit refuses a card
  resetStubs();
  const tn = levelWith('tunnels');
  const tun = openModule(t, { save: wonUpTo(tn - 1), pointer: true });
  tun.v.level(tn).click();
  tun.v.click('loadout-start');
  const exit = pks.pksLevel(tn).rules.tunnels[0];
  tun.v.rt.sim.cycles = 1000;
  tun.v.card(tun.v.rt.cards[0]).click();
  tun.v.move(exit.lane, exit.col);
  tun.clock.frame(16);
  assert.equal(tun.v.status(), 'Tunnel exit: enemies come out here, so nothing can stand on it');
  assert.deepEqual(tun.v.ghost(), ['cursor-bad@' + (24 + exit.col * 32) + ',' + (20 + exit.lane * 32)]);
  tun.v.tap(exit.lane, exit.col);
  assert.equal(tun.v.rt.sim.defenders.length, 0);
  assert.equal(pks.pksRefusalText({ reason: 'tunnel' }), 'Tunnel exit: enemies come out here, so nothing can stand on it');
});

// A late level n started on a module page (through the loadout when it asks).
function openLate(t, n, opts = {}) {
  const r = openModule(t, Object.assign({ save: wonUpTo(n - 1) }, opts));
  r.v.level(n).click();
  if (!r.v.hidden('loadout')) r.v.click('loadout-start');
  return r;
}

// The level being played set to `left` seconds before overtime: every spawn
// and surge out, the field emptied but for one Bot far from the rack.
function nearOvertime(v, left) {
  const sim = v.rt.sim;
  const lv = sim.level;
  sim.spawnIndex = lv.spawns.length;
  sim.warned = sim.surged = lv.surges.length;
  sim.enemies = [];
  sim.tick = STEPS(lv.duration + pks.pksConstants.OVERTIME - left);
  sim.time = sim.tick / 60;
  return pks.pksSpawnEnemy(sim, 'bot', 2, 8.5, 0);
}

// Frames of 250 ms for `seconds` with the Bot held where it is; returns the
// overtime announcements made (the live region cleared before each frame).
function holdBot(v, clock, bot, seconds) {
  const said = [];
  for (let i = 0; i < seconds * 4; i++) {
    bot.x = 8.5;
    v.el('live').textContent = '';
    clock.frame(250);
    if (/^Overtime in/.test(v.live())) said.push(v.live());
  }
  return said;
}

const overtimeWarn = (s) => 'Overtime in ' + s + ' s: clear every enemy by then, or the one nearest the rack breaks through and the level is lost.';

test('packet-siege: overtime on a late level: the HUD counts down its last 60 s, the live region says it at 60 s and 10 s only, and the loss has its own result', (t) => {
  const n = 51;
  const lv = pks.pksLevel(n);
  const OT = pks.pksConstants.OVERTIME;
  const { clock, v } = openLate(t, n);
  const bot = nearOvertime(v, 75);
  clock.frame(16);
  assert.deepEqual(lv.rules.names, ['express']);
  assert.equal(v.$$('.pks-rule')[0].getAttribute('aria-label'), pks.pksRuleText('express', lv), 'a rule without a clock: its line alone');
  assert.equal(v.text('surge'), 'Surge ' + lv.surges.length + '/' + lv.surges.length, 'no countdown yet');
  assert.equal(v.el('surge').getAttribute('title'), null);
  const said = holdBot(v, clock, bot, 25);
  assert.deepEqual(said, [overtimeWarn(60)]);
  const left = lv.duration + OT - v.rt.sim.time;
  assert.ok(left > 49 && left < 51, String(left));
  assert.equal(v.text('surge'), 'Overtime ' + Math.ceil(left) + 's');
  assert.ok(v.el('surge').classList.contains('pks-hud-surge--warn'));
  assert.equal(v.el('surge').getAttribute('title'), overtimeWarn(Math.ceil(left)), 'its text twin');
  assert.equal(v.status(), overtimeWarn(60));
  // the rest: one more announcement at 10 s, then the Bot breaks through
  said.push(...holdBot(v, clock, bot, 52));
  assert.deepEqual(said, [overtimeWarn(60), overtimeWarn(10)], 'two announcements, no more');
  assert.equal(v.rt.sim.status, 'lost');
  assert.equal(v.rt.sim.breakers[2], 'armed', 'no breaker tripped');
  const title = 'Overtime: the level is lost';
  const text = 'The level ran ' + pks.pksClock(OT) + ' past its end with enemies still on the floor, so the ' + pks.pksEnemy.bot.name +
    ' nearest the rack broke through in lane 3.';
  assert.equal(text, 'The level ran 5:00 past its end with enemies still on the floor, so the Bot nearest the rack broke through in lane 3.');
  clock.run(2);
  assert.deepEqual(v.screen(), ['result']);
  assert.equal(v.text('result-title'), title);
  assert.equal(v.text('result-text'), text);
  assert.equal(v.text('replay'), 'Retry');
  assert.equal(v.status(), title + '. ' + text, 'said when it happened');
  // a breach on a late level is still a breach (the flag is the level's own)
  v.click('replay');
  if (!v.hidden('loadout')) v.click('loadout-start');
  breach(v, 1);
  clock.frame(16).frame(1000 / 60).run(2);
  assert.equal(v.text('result-title'), 'Breach in lane 2');
  // levels 1-50 never count down nor lose to overtime
  v.click('result-levels');
  v.level(1).click();
  if (!v.hidden('loadout')) v.click('loadout-start');
  const early = nearOvertime(v, 30);
  holdBot(v, clock, early, 40);
  assert.equal(v.rt.sim.status, 'playing');
  assert.match(v.text('surge'), /^Surge /);
});

test('packet-siege: a level resumed inside its last minute counts on and says only the marks still ahead', (t) => {
  const n = 51;
  const { clock, v } = openLate(t, n);
  const bot = nearOvertime(v, 35);
  clock.frame(16);
  assert.equal(v.text('surge'), 'Overtime 35s');
  v.click('pause');
  const again = reloadModule(t, clock, v);
  again.click('run-resume');
  again.click('resume');
  const held = again.rt.sim.enemies.find((e) => e.id === bot.id);
  assert.deepEqual(holdBot(again, clock, held, 30), [overtimeWarn(10)]);
});

test('packet-siege: a late boss\'s shield coming back and its split have a status line; only the first split of a level is announced', (t) => {
  const tier = pks.pksBossTiers.find((b) => b.split > 0 && b.shieldEvery > 0);
  const { clock, v } = openLate(t, tier.level);
  const sim = v.rt.sim;
  assert.equal(sim.level.boss, tier.tier);
  const boss = pks.pksSpawnEnemy(sim, 'boss', 2, 8.5, tier.tier);
  boss.shield = 1;
  boss.t = 1;
  v.el('live').textContent = '';
  clock.frame(16).frame(1000 / 60);
  assert.equal(v.status(), 'The boss\'s shield is back: ' + boss.maxShield + ' shield HP to break.');
  assert.equal(v.live(), '', 'the status line only');
  const split = 'The boss split in two: each copy has ' + tier.split + ' HP and no shield.';
  const kill = (lane, x) => {
    const b = pks.pksSpawnEnemy(sim, 'boss', lane, x, tier.tier);
    b.hp = 0;
    b.shield = 0;
    // a Firewall's shot finishes it: the sim kills it and it splits
    sim.shots.push({ id: sim.nextId++, kind: 'drop', lane, x: x - 0.2, from: x - 0.5, dir: 1, dmg: 1, slow: 0, owner: 0, done: false });
    b.hp = 0.5;
    v.el('live').textContent = '';
    clock.frame(1000 / 60);
  };
  kill(3, 8.5);
  assert.equal(v.status(), split);
  assert.equal(v.live(), split, 'the first split is announced');
  kill(0, 7);
  assert.equal(v.status(), split);
  assert.equal(v.live(), '', 'later ones are not');
});

test('packet-siege: every zone rule has a one-line text with the level\'s own numbers and a clock where it keeps time', () => {
  for (const name of Object.keys(pks.pksRuleNames)) {
    const n = levelWith(name);
    const lv = pks.pksLevel(n);
    const text = pks.pksRuleText(name, lv);
    assert.ok(text.startsWith(pks.pksRuleNames[name] + ': '), text);
    assert.ok(text.length < 200, text);
    const sim = pks.pksNewSim(lv, []);
    const c = pks.pksRuleClock(name, sim);
    assert.equal(c.text === '', !['blackout', 'outage', 'upkeep'].includes(name), name);
  }
  const lv = pks.pksLevel(levelWith('express'));
  assert.equal(pks.pksRuleText('express', lv), 'Express: enemies in the marked lanes (' + lv.rules.express.map((l) => l + 1).join(', ') + ') move ' +
    Math.round((pks.pksConstants.EXPRESS - 1) * 100) + ' % faster.');
  const rails = pks.pksLevel(levelWith('rails'));
  assert.match(pks.pksRuleText('rails', rails), /No passive cycles\.$/);
  assert.match(pks.pksRuleText('rails', Object.assign({}, rails, { trickle: true })), /% faster\.$/, 'a rail level with a trickle says nothing of it');
  const tunnels = pks.pksLevel(levelWith('tunnels'));
  assert.match(pks.pksRuleText('tunnels', tunnels), new RegExp('column ' + (pks.pksConstants.TUNNEL_COL + 1)));
  const two = Object.assign({}, tunnels, { rules: Object.assign({}, tunnels.rules, { tunnels: [{ lane: 0, col: 6, every: 3 }, { lane: 3, col: 6, every: 3 }] }) });
  assert.match(pks.pksRuleText('tunnels', two), /^Tunnels: one of every 3 enemies of lanes 1, 4 comes out of the exit at column 7 after/);
  assert.match(pks.pksRuleText('tunnels', tunnels), /enemies of lane \d comes out/);
  const upkeep = pks.pksLevel(levelWith('upkeep'));
  assert.match(pks.pksRuleText('upkeep', upkeep), new RegExp('each defender costs ' + upkeep.rules.upkeep.cost + ' cycle'));
  const pricey = Object.assign({}, upkeep, { rules: Object.assign({}, upkeep.rules, { upkeep: { cost: 2, every: 12 } }) });
  assert.match(pks.pksRuleText('upkeep', pricey), /costs 2 cycles;/);
  assert.equal(pks.pksClock(0), '0:00');
  assert.equal(pks.pksClock(754.9), '12:34');
});

test('packet-siege: the 9 and 0 keys pick the ninth and tenth cards on a level with ten', (t) => {
  const { v } = openModule(t, { save: wonUpTo(120) });
  v.level(121).click();
  v.click('loadout-start');
  assert.equal(v.cards().length, 11);
  assert.deepEqual(v.$$('.pks-card-key').map((s) => s.textContent), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'X']);
  v.focusField();
  v.press('9');
  assert.equal(v.rt.selected, v.rt.cards[8]);
  v.press('0');
  assert.equal(v.rt.selected, v.rt.cards[9]);
  v.press('ю', { code: 'Digit0' });
  assert.equal(v.rt.selected, null, 'the same card again');
  v.press('ю', { code: 'Digit9' });
  assert.equal(v.rt.selected, v.rt.cards[8]);
  assert.equal(v.card(v.rt.cards[9]).getAttribute('aria-label'), pks.pksDefender[v.rt.cards[9]].name + ', ' + pks.pksDefender[v.rt.cards[9]].cost + ' cycles, key 0');
  assert.match(v.live(), /Pick a card \(1-9, 0 or tap it\)/, 'the start line names the keys');
  // a level with fewer cards says which keys there are
  v.click('levels');
  v.click('confirm-yes');
  v.level(1).click();
  v.click('loadout-start');
  v.focusField();
  v.press('0');
  assert.equal(v.status(), 'No card 0 on this level: the cards are 1-5 and X.');
  v.press('9');
  assert.equal(v.status(), 'No card 9 on this level: the cards are 1-5 and X.');
});

test('packet-siege: the classes of the late game\'s screens have CSS rules: zone tiles, the resume offer, rule badges, loadout groups', (t) => {
  viewport(t, 1280, 800);
  const n = levelWith('blackout');
  const { clock, v } = openModule(t, { save: wonUpTo(n - 1), width: 960 });
  const seen = new Set();
  const collect = () => {
    const walk = (node) => {
      for (const name of String(node.className || '').split(/\s+/).filter(Boolean)) seen.add(name);
      (node.children || []).forEach(walk);
    };
    walk(v.page.root);
  };
  v.level(n).click();
  collect();
  v.click('loadout-start');
  v.rt.sim.blackout.t = 1;
  clock.frame(16).frame(1000 / 60);
  v.click('pause');
  collect();
  v.click('levels');
  v.click('confirm-yes');
  collect();
  v.click('codex-open');
  collect();
  const styled = new Set(cssRules(CSS).flatMap((rule) => rule.selectors.flatMap((s) => Array.from(s.matchAll(/\.([\w-]+)/g), (m) => m[1]))));
  for (const name of ['pks-zone-tile', 'pks-zone-tile--locked', 'pks-zone-icon', 'pks-zone-num', 'pks-zone-tname', 'pks-zone-stars', 'pks-run',
    'pks-run-text', 'pks-rules', 'pks-rules--big', 'pks-rule', 'pks-rule--alert', 'pks-rule-icon', 'pks-rule-name',
    'pks-rule-clock', 'pks-paused-rules', 'pks-paused-rule', 'pks-loadout-groups', 'pks-loadout-head', 'pks-loadout-list', 'pks-zone-tiles']) {
    assert.ok(seen.has(name), name + ' is used');
  }
  for (const name of seen) assert.ok(styled.has(name), name + ' has a CSS rule');
});

// ── a level in progress: the snapshot pks-run ─────────────────────────────

test('packet-siege: a level in progress is saved on pause, a hidden tab, leaving the page and every 30 s of play; starting, restarting, winning or losing drops it', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(12) });
  const writes = [];
  const setItem = localStorage.setItem;
  localStorage.setItem = function (key, value) {
    if (key === RUN_KEY) writes.push(JSON.parse(value).sim.tick);
    return setItem.call(this, key, value);
  };
  t.after(() => { localStorage.setItem = setItem; });
  v.level(12).click();
  v.click('loadout-start');
  clock.frame(16).run(5);
  assert.deepEqual(writes, [], 'nothing in the first seconds');
  // every 30 s of play
  clock.until(() => writes.length === 1, 30);
  assert.equal(writes[0], pks.pksRunEvery * 60);
  assert.equal(JSON.parse(localStorage.getItem(RUN_KEY)).n, 12);
  // on pause (the window losing the focus too) and when the tab is hidden
  clock.run(2);
  fire(window, 'blur');
  assert.equal(writes.length, 2);
  assert.equal(writes[1], v.rt.sim.tick);
  v.click('resume');
  clock.frame(16).run(1);
  setVisibility('hidden', t);
  assert.equal(writes.length, 3);
  setVisibility('visible', t);
  v.click('resume');
  clock.frame(16).run(1);
  // leaving the page
  fire(window, 'pagehide');
  assert.equal(writes.length, 4);
  assert.equal(writes[3], v.rt.sim.tick);
  // not on the level select (the level left is saved already), not after the level ended
  v.click('levels');
  assert.equal(writes.length, 5, 'the leave question saves it first');
  v.click('confirm-yes');
  fire(window, 'pagehide');
  assert.equal(writes.length, 5);
  // Start over: the level afresh, the snapshot dropped
  v.click('run-fresh');
  assert.deepEqual(v.screen(), ['loadout']);
  assert.ok(localStorage.getItem(RUN_KEY), 'kept while the loadout shows');
  v.click('loadout-start');
  assert.equal(localStorage.getItem(RUN_KEY), null);
  assert.equal(v.rt.sim.tick, 0);
  // restart drops it
  v.click('pause');
  assert.ok(localStorage.getItem(RUN_KEY));
  v.click('restart');
  v.click('confirm-yes');
  assert.equal(localStorage.getItem(RUN_KEY), null);
  // a win drops it
  v.click('pause');
  v.click('resume');
  finish(v);
  clock.frame(16).frame(1000 / 60);
  assert.equal(v.rt.sim.status, 'won');
  assert.equal(localStorage.getItem(RUN_KEY), null);
  fire(window, 'pagehide');
  assert.equal(localStorage.getItem(RUN_KEY), null, 'nothing to save after the end');
  clock.run(2);
  v.click('result-levels');
  assert.equal(v.hidden('run'), true);
});

test('packet-siege: the restart question saves the level too, so a tab hidden under it keeps the time played', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(12) });
  v.level(12).click();
  v.click('loadout-start');
  clock.frame(16).run(25);
  assert.equal(localStorage.getItem(RUN_KEY), null, 'no timed snapshot yet');
  const tick = v.rt.sim.tick;
  v.click('pause');
  // the pause's snapshot gone (as if never written): the question writes its own
  localStorage.removeItem(RUN_KEY);
  v.rt.runMine = null;
  v.click('restart');
  assert.equal(v.text('confirm-text'), 'Restart this level? Progress in it is lost.');
  setVisibility('hidden', t);
  const run = pks.pksParseRun(localStorage.getItem(RUN_KEY));
  assert.ok(run, 'saved by the question');
  assert.equal(run.sim.tick, tick, 'all the time played');
  setVisibility('visible', t);
  v.click('confirm-no');
  assert.equal(v.hidden('paused'), false);
});

test('packet-siege: the Yes of the leave question and the resume offer\'s buttons are named after what they show', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(12) });
  v.level(12).click();
  v.click('loadout-start');
  clock.frame(16).run(1);
  const yes = () => [v.text('confirm-yes'), v.el('confirm-yes').getAttribute('aria-label')];
  v.click('restart');
  assert.deepEqual(yes(), ['Restart', 'Restart the level; its progress is lost']);
  v.click('confirm-no');
  v.click('levels');
  assert.equal(v.text('confirm-text'), 'Leave this level? It is saved: Resume on the level select picks it up again.');
  assert.deepEqual(yes(), ['Leave', 'Leave the level; it stays saved to resume']);
  v.click('confirm-yes');
  for (const name of ['run-resume', 'run-fresh']) {
    const label = v.el(name).getAttribute('aria-label');
    assert.ok(label.startsWith(v.text(name)), label + ' starts with ' + v.text(name));
  }
  assert.equal(v.el('run-resume').getAttribute('aria-label'), 'Resume level 12 where it was');
  assert.equal(v.el('run-fresh').getAttribute('aria-label'), 'Start level 12 over from its beginning');
  // with storage that refuses the snapshot the question says the progress is lost, and so does the button
  v.click('run-fresh');
  v.click('loadout-start');
  const setItem = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === RUN_KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return setItem.call(localStorage, key, value);
  };
  t.after(() => { localStorage.setItem = setItem; });
  v.click('levels');
  assert.deepEqual(yes(), ['Leave', 'Leave the level; its progress is lost']);
  assert.equal(HTML.match(/id="pks-confirm-yes"[^>]*aria-label="([^"]+)"/)[1], 'Leave the level; its progress is lost', 'the markup starts as the plain leave');
});

test('packet-siege: a win or a loss drops the snapshot before it saves, so a nearly full storage still takes the save', (t) => {
  for (const end of ['win', 'loss']) {
    resetStubs();
    const { clock, v } = openModule(t, { save: wonUpTo(12) });
    v.level(12).click();
    v.click('loadout-start');
    clock.frame(16).run(1);
    v.click('pause');
    v.click('resume');
    assert.ok(localStorage.getItem(RUN_KEY));
    // room for the save only once the snapshot is gone
    const setItem = localStorage.setItem;
    localStorage.setItem = function (key, value) {
      if (key === SAVE_KEY && localStorage.getItem(RUN_KEY) !== null) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
    t.after(() => { localStorage.setItem = setItem; });
    if (end === 'win') finish(v);
    else breach(v, 2);
    clock.frame(16).frame(1000 / 60);
    assert.equal(localStorage.getItem(RUN_KEY), null, end);
    assert.equal(v.hidden('warning'), true, end + ': nothing refused');
    if (end === 'win') assert.equal(v.save().stars[11], 3, 'the win is saved');
    localStorage.setItem = setItem;
  }
});

test('packet-siege: one snapshot for every tab: a level started in another tab owns it, this tab plays on without touching it; the offer follows the storage event', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(30) });
  v.level(31).click();
  v.click('loadout-start');
  clock.frame(16).run(2);
  v.click('pause');
  const mine = localStorage.getItem(RUN_KEY);
  assert.ok(mine);
  v.click('resume');
  // another tab starts level 5 and pauses it
  const other = pks.pksRunText(pks.pksNewSim(5, ['psu', 'firewall', 'proxy', 'honeypot', 'tarpit']), ['psu', 'firewall', 'proxy', 'honeypot', 'tarpit']);
  localStorage.setItem(RUN_KEY, other);
  fire(window, 'storage', { key: RUN_KEY });
  clock.run(1);
  v.click('pause');
  assert.equal(localStorage.getItem(RUN_KEY), other, 'never overwritten');
  assert.equal(v.rt.runOwn, false, 'this tab lost the slot');
  v.click('resume');
  clock.until(() => v.rt.sim.tick >= v.rt.runNext + 60, 40);
  assert.equal(localStorage.getItem(RUN_KEY), other, 'no timed snapshot either');
  // this tab's loss does not drop the other tab's level
  breach(v, 2);
  clock.frame(16).frame(1000 / 60);
  assert.equal(v.rt.sim.status, 'lost');
  assert.equal(localStorage.getItem(RUN_KEY), other);
  clock.run(2);
  v.click('result-levels');
  assert.equal(v.hidden('run'), false, 'the other tab\'s level is offered here too');
  assert.equal(v.text('run-resume'), 'Resume level 5');
  // the other tab drops it: the offer goes
  localStorage.removeItem(RUN_KEY);
  fire(window, 'storage', { key: RUN_KEY });
  assert.equal(v.hidden('run'), true);
  fire(window, 'storage', { key: 'unrelated' });
  assert.equal(v.hidden('run'), true);
});

test('packet-siege: a snapshot that is not sound, of a level not open or from blocked storage is dropped quietly; the game goes on', (t) => {
  for (const text of ['{oops', '{"v":1,"n":3}', 'null']) {
    resetStubs();
    localStorage.setItem(RUN_KEY, text);
    const { v } = openPage(t);
    assert.equal(v.hidden('run'), true, text);
    assert.equal(v.hidden('warning'), true);
    assert.equal(localStorage.getItem(RUN_KEY), null, 'dropped: ' + text);
    v.restore();
  }
  // a sound snapshot of a level this save has not opened
  resetStubs();
  const sim = pks.pksNewSim(40, ['psu', 'firewall']);
  localStorage.setItem(RUN_KEY, pks.pksRunText(sim, ['psu', 'firewall']));
  const locked = openPage(t, { save: wonUpTo(5) });
  assert.equal(locked.v.hidden('run'), true);
  assert.equal(localStorage.getItem(RUN_KEY), null);
  locked.v.restore();
  // a stale one (other level tables) the same
  resetStubs();
  const raw = JSON.parse(pks.pksRunText(sim, ['psu', 'firewall']));
  raw.hash = '00000000';
  localStorage.setItem(RUN_KEY, JSON.stringify(raw));
  const stale = openPage(t, { save: wonUpTo(45) });
  assert.equal(stale.v.hidden('run'), true);
  assert.equal(localStorage.getItem(RUN_KEY), null);
  stale.v.restore();
  // blocked storage: no offer, no snapshot, the level plays and pauses
  resetStubs();
  blockStorage('access', t);
  const blocked = openModule(t);
  assert.equal(blocked.v.hidden('run'), true);
  blocked.v.level(1).click();
  blocked.clock.frame(16).run(1);
  blocked.v.click('pause');
  blocked.v.click('levels');
  assert.equal(blocked.v.text('confirm-text'), 'Leave this level? Progress in it is lost.');
  blocked.v.click('confirm-yes');
  assert.deepEqual(blocked.v.screen(), ['select']);
});

// Plays the level on the page until done() (frames of 250 ms at 2x speed),
// a defence placed first: plenty of cycles, shooters and a wall per lane.
function holdOn(v, clock, done, seconds) {
  const sim = v.rt.sim;
  sim.cycles = 1e6;
  for (let lane = 0; lane < 5; lane++) {
    for (const [id, col] of [['firewall', 0], ['ids', 1], ['scanner', 2], ['proxy', 4]]) {
      const card = sim.cards.find((c) => c.id === id);
      if (!card) continue;
      card.left = 0;
      pks.pksPlace(sim, id, lane, col);
    }
  }
  clock.until(done, seconds);
}

test('packet-siege: a late level with its rules running survives a reload: Resume restores it, paused, and it plays on exactly like the original', (t) => {
  const n = levelWith('blackout');
  const rule = pks.pksLevel(n).rules.blackout;
  const loadout = ['psu', 'firewall', 'proxy', 'honeypot', 'ids', 'scanner', 'tracer', 'batch', 'tokenring'].slice(0, pks.pksSlots(n));
  const { clock, v } = openModule(t, { save: wonUpTo(n - 1, 3, { loadout }) });
  v.level(n).click();
  v.click('loadout-start');
  const cards = v.rt.cards.slice();
  assert.ok(cards.includes('honeypot'));
  v.click('speed');
  v.rt.sim.cards.find((c) => c.id === 'honeypot').left = 0;
  v.rt.sim.cycles = 1000;
  pks.pksPlace(v.rt.sim, 'honeypot', 0, 3);
  holdOn(v, clock, () => v.rt.sim.blackout.state === 'dark', rule.every + rule.warn);
  const trap = v.rt.sim.defenders.find((d) => d.type === 'honeypot');
  assert.equal(trap && trap.state, 'armed', 'a trap armed before the save');
  // pausing saves it; the copy that stays here plays on as the reference
  v.click('pause');
  const saved = localStorage.getItem(RUN_KEY);
  assert.ok(saved);
  const reference = pks.pksParseRun(saved).sim;
  assert.equal(reference.blackout.state, 'dark');
  const again = reloadModule(t, clock, v);
  assert.deepEqual(again.screen(), ['select']);
  assert.equal(again.hidden('run'), false);
  assert.equal(again.text('run-text'), 'Level ' + n + ', ' + pks.pksLevel(n).name + ': in progress, ' + pks.pksClock(reference.time) + ' played.');
  assert.equal(again.text('run-resume'), 'Resume level ' + n);
  assert.equal(again.text('run-fresh'), 'Start level ' + n + ' over');
  assert.equal(again.$('#pks-zone-' + Math.ceil(n / 10)).getAttribute('aria-pressed'), 'true');
  // the resumed level: the same sim, paused, its cards and rules
  again.click('run-resume');
  assert.deepEqual(again.screen(), ['play']);
  assert.equal(again.rt.paused, true, 'it waits for Resume');
  assert.equal(again.hidden('paused'), false);
  assert.equal(again.status(), 'Level ' + n + ', ' + pks.pksLevel(n).name + ', resumed at ' + pks.pksClock(reference.time) + ': paused. Press Resume or P to go on.');
  assert.equal(again.live(), again.status());
  assert.deepEqual(again.cards(), cards.concat(['decom']));
  assert.equal(again.$$('.pks-rule').length, pks.pksLevel(n).rules.names.length);
  assert.equal(again.$$('.pks-paused-rule').length, pks.pksLevel(n).rules.names.length);
  assert.equal(pks.pksRunText(again.rt.sim, cards), pks.pksRunText(reference, cards), 'the same state');
  assert.deepEqual(again.rt.armed, { [trap.id]: true }, 'the armed trap is remembered');
  assert.equal(localStorage.getItem(RUN_KEY), saved, 'still saved, now owned by this page');
  // it plays on like the original, step for step
  again.click('resume');
  const start = again.rt.sim.tick;
  for (let f = 0; f < 40; f++) {
    clock.frame(250);
    while (reference.tick < again.rt.sim.tick) pks.pksStep(reference);
    assert.equal(pks.pksRunText(again.rt.sim, cards), pks.pksRunText(reference, cards), 'frame ' + f);
  }
  assert.ok(again.rt.sim.tick > start + 600, 'it ran on');
  // winning it drops the snapshot
  finish(again);
  clock.frame(16).frame(1000 / 60);
  assert.equal(again.rt.sim.status, 'won');
  assert.equal(localStorage.getItem(RUN_KEY), null);
});

test('packet-siege: a Honeypot says it arms after placing (card title, aim, placed line) and, eaten before it armed, the status line says so once', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(3, 3, { met: ['bot', 'kiddie', 'worm'] }) });
  const hp = pks.pksDefender.honeypot;
  v.level(4).click();
  const key = v.rt.cards.indexOf('honeypot') + 1;
  assert.ok(key > 0, 'the Honeypot is on the level');
  assert.equal(v.card('honeypot').getAttribute('title'), 'Honeypot, arms in ' + hp.arm + ' s (' + key + ')');
  assert.equal(v.card('psu').getAttribute('title'), 'PSU (' + (v.rt.cards.indexOf('psu') + 1) + ')', 'no arming: as before');
  v.rt.sim.cycles = 10000;
  v.card('honeypot').click();
  v.move(2, 4);
  clock.frame(16);
  assert.equal(v.status(), 'Place Honeypot here for ' + hp.cost + ' cycles (arms in ' + hp.arm + ' s)');
  const liveBefore = v.live();
  v.tap(2, 4);
  assert.equal(v.status(), 'Honeypot placed: ' + hp.cost + ' cycles. Arms in ' + hp.arm + ' s — enemies can eat it until then.');
  v.card('psu').click();
  v.tap(3, 0);
  assert.equal(v.status(), 'PSU placed: ' + pks.pksDefender.psu.cost + ' cycles.', 'other defenders as before');
  // A Bot at the trap with almost no HP left: eaten while arming.
  const sim = v.rt.sim;
  const trap = sim.defenders.find((d) => d.type === 'honeypot');
  trap.hp = 0.01;
  pks.pksSpawnEnemy(sim, 'bot', 2, 4.9, 0);
  clock.frame(16).until(() => !sim.defenders.includes(trap), 5);
  assert.equal(trap.state, 'arming');
  assert.equal(v.status(), 'Honeypot eaten before it armed.');
  assert.equal(v.live(), liveBefore, 'the status line only, not the live region');
  // A PSU eaten says nothing of the kind.
  v.rt.selected = null;
  const psu = sim.defenders.find((d) => d.type === 'psu');
  psu.hp = 0.01;
  v.click('speed');
  v.click('speed');
  pks.pksSpawnEnemy(sim, 'bot', 3, 0.9, 0);
  clock.until(() => !sim.defenders.includes(psu), 5);
  assert.notEqual(v.status(), 'PSU eaten before it armed.');
  assert.equal(v.status(), 'Speed 1x.');
});

test('packet-siege: a Honeypot that armed and then went off (Ransomware) and was eaten is not called eaten before it armed', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(3, 3, { met: ['bot', 'kiddie', 'worm'] }) });
  v.level(4).click();
  const sim = v.rt.sim;
  sim.cycles = 10000;
  v.card('honeypot').click();
  v.tap(1, 2);
  const trap = sim.defenders.find((d) => d.type === 'honeypot');
  clock.frame(16).until(() => trap.state === 'armed', pks.pksDefender.honeypot.arm + 2);
  assert.equal(v.rt.armed[trap.id], true);
  v.click('speed');
  v.click('speed');
  trap.off = 100000;
  trap.hp = 0.01;
  pks.pksSpawnEnemy(sim, 'bot', 1, 2.9, 0);
  clock.until(() => !sim.defenders.includes(trap), 5);
  assert.equal(v.status(), 'Speed 1x.', 'nothing said');
  // A restart forgets which traps armed.
  v.click('pause');
  v.click('restart');
  v.click('confirm-yes');
  assert.deepEqual(v.rt.armed, {});
});

test('packet-siege: an enemy met in a level that is never finished is saved at once, so the codex knows it after leaving and a reload', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(3, 3, { met: ['bot', 'kiddie'] }) });
  const lv = pks.pksLevel(4);
  v.level(4).click();
  const first = lv.spawns.findIndex((s) => s.type === lv.intro);
  v.rt.sim.spawnIndex = first;
  v.rt.sim.tick = STEPS(lv.spawns[first].t) - 1;
  const writes = t.mock.method(localStorage, 'setItem');
  const saves = () => writes.mock.calls.filter((c) => c.arguments[0] === SAVE_KEY).length;
  clock.frame(16).frame(250);
  assert.deepEqual(v.save().met, ['bot', 'kiddie', lv.intro], 'saved when it was met');
  assert.equal(saves(), 1);
  clock.frame(250).frame(250);
  assert.equal(saves(), 1, 'once: an enemy met before is not saved again');
  v.click('levels');
  v.click('confirm-yes');
  const again = reload(t, clock, v);
  again.click('codex-open');
  const row = again.el('codex-enemies').children[2];
  assert.equal(row.children[1].children[0].textContent, pks.pksEnemy[lv.intro].name);
});

test('packet-siege: a save of a newer version is never written over: the page plays on in memory and says so, at start-up and from another tab', (t) => {
  const newer = '{"v":2,"unlocked":9,"stars":"elsewhere"}';
  const warning = (v2) => 'This browser holds data of a newer version of the game (pks-state version ' + v2 +
    ') that this page cannot read. It is left as it is: progress is not being saved in this tab.';
  const { clock, v } = openModule(t, { save: newer });
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning-text'), warning(2));
  assert.equal(v.level(2).disabled, true, 'read as a new save');
  // a won level, the speed, a met enemy: kept on the page, nothing written
  v.level(1).click();
  v.click('speed');
  finish(v);
  clock.frame(16).frame(1000 / 60).run(2);
  assert.equal(v.text('result-title'), 'Level 1 secured');
  assert.equal(localStorage.getItem(SAVE_KEY), newer, 'the newer save is untouched');
  v.click('result-levels');
  assert.equal(v.level(2).disabled, false, 'progress kept in memory');
  v.click('warning-close');
  assert.equal(v.hidden('warning'), true);
  // the same warning is not shown again
  v.level(2).click();
  assert.equal(v.hidden('warning'), true);
  assert.equal(localStorage.getItem(SAVE_KEY), newer);
  // another tab (a newer build) writes v 3 over a save this page could read: the warning says so at once
  resetStubs();
  const other = openModule(t, { save: wonUpTo(3) });
  assert.equal(other.v.hidden('warning'), true);
  localStorage.setItem(SAVE_KEY, '{"v":3,"unlocked":150}');
  fire(window, 'storage', { key: SAVE_KEY });
  assert.equal(other.v.hidden('warning'), false);
  assert.equal(other.v.text('warning-text'), warning(3));
  assert.equal(other.v.level(4).disabled, false, 'this tab keeps its own progress');
  other.v.level(4).click();
  other.v.click('speed');
  assert.equal(localStorage.getItem(SAVE_KEY), '{"v":3,"unlocked":150}', 'and never writes over the newer save');
});

test('packet-siege: a snapshot of a newer version is not offered, dropped or written over, at start-up and from another tab', (t) => {
  const newer = '{"v":2,"n":3,"sim":"elsewhere"}';
  const warning = (v2) => 'This browser holds data of a newer version of the game (pks-run version ' + v2 +
    ') that this page cannot read. It is left as it is: a level in progress is not being saved in this tab.';
  localStorage.setItem(RUN_KEY, newer);
  const { clock, v } = openModule(t, { save: wonUpTo(12) });
  assert.equal(v.hidden('run'), true, 'not offered');
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning-text'), warning(2));
  assert.equal(localStorage.getItem(RUN_KEY), newer, 'not dropped at start-up');
  // a level started here: the newer snapshot stays, and this tab writes none
  v.level(12).click();
  v.click('loadout-start');
  assert.equal(localStorage.getItem(RUN_KEY), newer, 'not dropped by the start');
  clock.frame(16).run(31);
  v.click('pause');
  setVisibility('hidden', t);
  fire(window, 'pagehide');
  assert.equal(localStorage.getItem(RUN_KEY), newer, 'never written over');
  assert.equal(v.rt.runOwn, false);
  setVisibility('visible', t);
  v.click('levels');
  assert.equal(v.text('confirm-text'), 'Leave this level? Progress in it is lost.');
  v.click('confirm-yes');
  assert.equal(v.hidden('run'), true);
  assert.equal(localStorage.getItem(RUN_KEY), newer);
  // another tab (a newer build) writes v 3 over this tab's own snapshot: the offer goes, the warning says so
  resetStubs();
  const other = openModule(t, { save: wonUpTo(12) });
  other.v.level(12).click();
  other.v.click('loadout-start');
  other.clock.frame(16).run(1);
  other.v.click('pause');
  other.v.click('levels');
  other.v.click('confirm-yes');
  assert.equal(other.v.hidden('run'), false, 'its own level offered');
  assert.equal(other.v.hidden('warning'), true);
  localStorage.setItem(RUN_KEY, '{"v":3}');
  fire(window, 'storage', { key: RUN_KEY });
  assert.equal(other.v.hidden('run'), true);
  assert.equal(other.v.text('warning-text'), warning(3));
  assert.equal(localStorage.getItem(RUN_KEY), '{"v":3}', 'kept');
  other.v.level(5).click();
  if (!other.v.hidden('loadout')) other.v.click('loadout-start');
  other.v.click('pause');
  assert.equal(localStorage.getItem(RUN_KEY), '{"v":3}', 'no snapshot from this tab');
});

test('packet-siege: a corrupt or foreign save starts fresh, field by field, and never breaks the page', (t) => {
  for (const save of ['{oops', 'null', '{"v":0,"unlocked":9}', '{"v":"2","unlocked":9}', '{"v":1.5,"unlocked":9}', JSON.stringify({ v: 1, unlocked: 'x', stars: [3, 9, 2], speed: 3, loadout: ['psu', 'nope'], met: ['bot', 'ghost'] })]) {
    resetStubs();
    const { v } = openPage(t, { save });
    assert.deepEqual(v.screen(), ['select']);
    assert.equal(v.hidden('warning'), true);
    v.level(1).click();
    assert.deepEqual(v.screen(), ['play']);
    v.restore();
  }
  const { v } = openPage(t, { save: JSON.stringify({ v: 1, unlocked: 'x', stars: [3, 9, 2], speed: 3 }) });
  assert.equal(v.text('total'), '5 of 450');
  assert.equal(v.level(4).disabled, false, 'stars on level 3 open level 4');
  assert.equal(v.text('speed'), '1x');
});

test('packet-siege: blocked storage never stops the game: a quiet warning in the frame names the error and the key; OK hides it; full storage still reads the save', (t) => {
  blockStorage('access', t);
  const { clock, v } = openModule(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning-text'), 'Storage is blocked or full (TypeError): pks-state is not saved on this page. The game plays on, but a reload starts from your last saved progress.');
  v.click('warning-close');
  assert.equal(v.hidden('warning'), true);
  v.level(1).click();
  finish(v);
  clock.frame(16).frame(1000 / 60).run(2);
  assert.equal(v.text('result-title'), 'Level 1 secured');
  assert.equal(v.hidden('warning'), true, 'said once');
  v.click('result-levels');
  assert.equal(v.level(2).disabled, false, 'progress kept on the page');
  resetStubs();
  localStorage.setItem(SAVE_KEY, JSON.stringify(wonUpTo(2)));
  blockStorage('full', t);
  const full = openPage(t);
  assert.equal(full.v.hidden('warning'), true, 'reading works');
  assert.equal(full.v.level(3).disabled, false);
  full.v.level(3).click();
  full.v.click('speed');
  assert.equal(full.v.text('warning-text'), 'Storage is blocked or full (QuotaExceededError): pks-state is not saved on this page. The game plays on, but a reload starts from your last saved progress.');
  full.v.click('speed');
  assert.equal(full.v.text('speed'), '1x');
  assert.equal(localStorage.getItem(SAVE_KEY), JSON.stringify(wonUpTo(2)), 'the old save is still there');
});

test('packet-siege: a second tab\'s progress is merged: through the storage event and at the next write', (t) => {
  const { clock, v } = openModule(t);
  const other = wonUpTo(4, 2, { met: ['bot', 'worm'] });
  localStorage.setItem(SAVE_KEY, JSON.stringify(other));
  fire(window, 'storage', { key: 'other-key' });
  assert.equal(v.level(2).disabled, true);
  fire(window, 'storage', { key: SAVE_KEY });
  assert.equal(v.level(5).disabled, false);
  assert.equal(v.text('total'), '8 of 450');
  // This tab wins level 1 with three stars; the other tab meanwhile won level 5.
  localStorage.setItem(SAVE_KEY, JSON.stringify(wonUpTo(5, 2, { met: ['kiddie'] })));
  v.level(1).click();
  finish(v);
  clock.frame(16).frame(1000 / 60).run(2);
  const saved = v.save();
  assert.deepEqual(saved.stars.slice(0, 6), [3, 2, 2, 2, 2, 0]);
  assert.equal(saved.unlocked, 6);
  assert.deepEqual(saved.met, ['bot', 'kiddie', 'worm']);
});

// ── the frame: layout, fullscreen, maximised ───────────────────────────────

// Every box of a layout inside its frame, the cards and the status line in
// the tray band (or the status under the field beside it), nothing over the
// field.
function assertLayoutSound(L, where) {
  const inside = (b, name) => {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= L.w && b.y + b.h <= L.h, where + ': ' + name + ' inside the frame');
  };
  const apart = (a, b, name) => {
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, where + ': ' + name + ' apart');
  };
  for (const name of ['field', 'tray', 'cards', 'status']) inside(L[name], name);
  assert.ok(L.field.y >= L.hud, where + ': the field under the HUD');
  apart(L.field, L.cards, 'field and cards');
  apart(L.field, L.status, 'field and status');
  apart(L.cards, L.status, 'cards and status');
  apart(L.field, L.tray, 'field and tray');
  assert.ok(L.cols * L.cardW + (L.cols - 1) * 3 <= L.cards.w, where + ': the card columns fit the grid');
  const cards = pks.pksSlots(150) + 1;
  assert.equal(cards, 11);
  const rows = Math.ceil(cards / L.cols);
  assert.ok(rows * 56 + (rows - 1) * 3 <= L.cards.h, where + ': eleven cards fit the grid');
  assert.equal(L.status.h, L.lines * 16 + 6);
  // the rule badges' row: over the canvas's top strip, from the trickle's pip to the surge bar
  const s = L.field.w / 320;
  assert.deepEqual(L.rules, { x: Math.round(30 * s), y: 0, w: Math.floor(118 * s), h: Math.floor(20 * s) }, where + ': the rule row');
}

test('packet-siege: the field\'s scale comes from the frame\'s parent width: a whole multiple when it is at least 80 % of the width, else the width itself, never above 3x; the HUD, cards and status as wide as the field', () => {
  const cases = [
    [1600, 3, 960], [1280, 3, 960], [1200, 3, 960], [961, 3, 960], [960, 3, 960], [959, 959 / 320, 959], [958, 958 / 320, 958], [900, 900 / 320, 900],
    [801, 801 / 320, 801], [800, 2, 640], [760, 2, 640], [700, 2, 640], [640, 2, 640], [639, 639 / 320, 639],
    [401, 401 / 320, 401], [400, 1, 320], [320, 1, 320], [300, 300 / 320, 300]
  ];
  for (const [width, scale, fieldW] of cases) {
    const L = pks.pksPageLayout(width);
    assert.equal(L.scale, scale, width + ' px');
    assert.equal(pks.pksPageScale(width), scale, width + ' px');
    assert.deepEqual([L.field.w, L.field.h], [fieldW, Math.floor(180 * scale)], width + ' px');
    assert.ok(L.w <= width, width + ' px: the frame fits the width it is given');
    assert.ok(L.w >= width * 0.8 || L.w === 960, width + ' px: no more than a fifth of the width left empty');
    assert.equal(L.w, L.field.w, 'the frame is as wide as the field');
    assert.deepEqual([L.field.x, L.field.y], [0, L.hud]);
    assert.deepEqual([L.tray.x, L.tray.w], [0, L.w]);
    assert.deepEqual([L.cards.x, L.cards.w, L.status.x, L.status.w], [3, L.w - 6, 3, L.w - 6]);
    assert.equal(L.tray.y, L.field.y + L.field.h, 'the tray right under the field');
    assert.equal(L.tray.y + L.tray.h, L.h, 'and to the bottom of the frame');
    assert.equal(L.hud, L.w >= 560 ? 52 : 78, 'one HUD row from 560 px, two below');
    assert.equal(L.fit, false);
    assertLayoutSound(L, width + ' px');
  }
  assert.equal(pks.pksPageScale(0), 0.1, 'never nothing');
  assert.deepEqual(pks.pksFrameLayout('page', 960, 0, 0), pks.pksPageLayout(960), 'an unknown viewport changes nothing');
  assert.deepEqual(pks.pksFrameLayout('page', 960, 1600, 900), pks.pksPageLayout(960));
  assert.deepEqual(pks.pksFrameLayout('page', 320, 320, 480), pks.pksPageLayout(320), 'a portrait viewport keeps the page layout');
});

test('packet-siege: on the page the frame takes its size from its parent through a ResizeObserver: an embedding column narrower than the window gets a whole multiple', (t) => {
  const observers = [];
  window.ResizeObserver = function (callback) {
    this.callback = callback;
    this.targets = [];
    observers.push(this);
  };
  window.ResizeObserver.prototype.observe = function (el) {
    this.targets.push(el);
  };
  t.after(() => delete window.ResizeObserver);
  const { v } = openModule(t, { width: 760 });
  const holder = v.el('holder');
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].targets, [holder]);
  const L = pks.pksPageLayout(760);
  assert.deepEqual(v.frameStyle(), ['640px', L.h + 'px'], 'a 760 px column: 2x, not 2.375x');
  assert.equal(holder.style.height, L.h + 'px');
  const box = (name) => ['left', 'top', 'width', 'height'].map((p) => v.el(name).style[p]).join(' ');
  assert.equal(box('field'), '0px 52px 640px 360px');
  assert.equal(box('cards'), '3px ' + L.cards.y + 'px 634px ' + L.cards.h + 'px');
  assert.equal(box('status'), '3px ' + L.status.y + 'px 634px ' + L.status.h + 'px');
  assert.equal(box('tray'), '0px ' + L.tray.y + 'px 640px ' + L.tray.h + 'px');
  assert.equal(v.el('cards').style.gridTemplateColumns, 'repeat(' + L.cols + ', ' + L.cardW + 'px)');
  assert.equal(v.el('hud').style.height, '52px');
  assert.ok(!v.el('hud').classList.contains('pks-hud--two'));
  for (const name of ['paused', 'confirm', 'result']) assert.equal(v.el(name).style.top, '52px', name + ' under the HUD');
  assert.ok(!v.el('frame').classList.contains('pks-frame--small'));
  // A column a little narrower than 960 px (a host's 958 px column): the field fills it at a fraction.
  holder.clientWidth = 958;
  observers[0].callback([]);
  const F = pks.pksPageLayout(958);
  assert.deepEqual(v.frameStyle(), ['958px', F.h + 'px'], 'a 958 px column: 958 px, not 640');
  assert.equal(box('field'), '0px 52px 958px 538px');
  assert.equal(box('cards'), '3px ' + F.cards.y + 'px 952px ' + F.cards.h + 'px');
  assert.equal(box('status'), '3px ' + F.status.y + 'px 952px ' + F.status.h + 'px');
  assert.equal(box('tray'), '0px ' + F.tray.y + 'px 958px ' + F.tray.h + 'px');
  assert.equal(box('rules'), F.rules.x + 'px 0px ' + F.rules.w + 'px ' + F.rules.h + 'px');
  assert.deepEqual([F.rules.x, F.rules.w, F.rules.h], [90, 353, 59], 'the rule row scaled by 958 / 320');
  assert.equal(v.el('cards').style.gridTemplateColumns, 'repeat(' + F.cols + ', ' + F.cardW + 'px)');
  assert.ok(F.cols * F.cardW + (F.cols - 1) * 3 <= 952, 'the cards fit the tray');
  assert.equal(v.el('hud').style.height, '52px');
  assert.equal(v.canvas.width, 320, 'the canvas keeps its 320x180 pixels: the browser scales it');
  assert.equal(v.canvas.height, 180);
  for (const [width, frame] of [[960, '960px'], [958, '958px'], [900, '900px'], [700, '640px'], [640, '640px'], [639, '639px'], [400, '320px'], [320, '320px'], [300, '300px']]) {
    holder.clientWidth = width;
    observers[0].callback([]);
    assert.equal(v.frameStyle()[0], frame, width + ' px');
  }
  assert.equal(v.el('hud').style.height, '78px', 'a narrow frame: two HUD rows');
  assert.ok(v.el('hud').classList.contains('pks-hud--two'));
  assert.ok(v.el('frame').classList.contains('pks-frame--small'));
  // A parent not laid out (0 px, hidden by the host page) keeps the last layout.
  holder.clientWidth = 0;
  observers[0].callback([]);
  assert.equal(v.frameStyle()[0], '300px');
});

test('packet-siege: without a ResizeObserver a window resize lays the frame out; a short landscape viewport gets the frame at its height', (t) => {
  const { v } = openModule(t, { width: 960 });
  assert.equal(v.frameStyle()[0], '960px');
  v.el('holder').clientWidth = 640;
  fire(window, 'resize');
  assert.equal(v.frameStyle()[0], '640px');
  viewport(t, 667, 375);
  v.el('holder').clientWidth = 667;
  fire(window, 'resize');
  const L = pks.pksFitLayout(667, 375);
  assert.deepEqual(v.frameStyle(), ['667px', '375px']);
  assert.ok(v.el('frame').classList.contains('pks-frame--side'), 'the cards beside the field');
  assert.equal(v.el('field').style.width, L.field.w + 'px');
  assert.equal(v.el('cards').style.gridTemplateColumns, 'repeat(' + L.cols + ', ' + L.cardW + 'px)');
});

test('packet-siege: the frame keeps its size from screen to screen: level select, loadout, level, pause, result, codex and back', (t) => {
  const { clock, v } = openModule(t, { save: wonUpTo(12), width: 640 });
  const size = v.frameStyle();
  const holder = v.el('holder').style.height;
  const same = (where) => {
    assert.deepEqual(v.frameStyle(), size, where);
    assert.equal(v.el('holder').style.height, holder, where);
  };
  v.level(13).click();
  same('loadout');
  v.click('loadout-start');
  same('level');
  v.click('pause');
  same('pause');
  v.click('resume');
  finish(v);
  clock.frame(16).frame(1000 / 60).run(2);
  assert.deepEqual(v.screen(), ['result']);
  same('result');
  v.click('result-levels');
  same('level select');
  v.click('codex-open');
  same('codex');
  v.click('codex-back');
  v.level(1).click();
  v.click('loadout-start');
  assert.equal(v.cards().length, pks.pksSlots(1) + 1, 'five defenders and Decommission');
  const L = pks.pksPageLayout(640);
  assert.equal(L.cols, 6, 'eleven cards in two rows of six');
  assert.equal(v.el('cards').style.gridTemplateColumns, 'repeat(6, ' + L.cardW + 'px)', 'a short hand is centred: as many columns as cards');
  same('a level with fewer cards: the tray holds room for every card a level can have');
  v.el('holder').clientWidth = 320;
  fire(window, 'resize');
  assert.equal(v.el('cards').style.gridTemplateColumns, 'repeat(3, ' + pks.pksPageLayout(320).cardW + 'px)', 'two rows of three on a phone');
});

test('packet-siege: changing screens brings the frame\'s top into view when it is above the viewport or cut off below it; start-up and fullscreen never scroll', (t) => {
  viewport(t, 667, 375);
  const page = newPage(667);
  const frame = page.els['pks-frame'];
  let rect = { top: 300, bottom: 1000 };
  let scrolls = 0;
  frame.getBoundingClientRect = () => rect;
  frame.scrollIntoView = (alignTop) => {
    assert.equal(alignTop, true);
    scrolls++;
  };
  makeClock(t);
  const v = pageView(page);
  const loaded = loadWithPage(SCRIPT, page, { keep: true });
  loaded.exports.pksInit();
  v.rt = loaded.exports.pksRuntime;
  assert.equal(scrolls, 0, 'not at start-up: the game may sit far down a post');
  v.level(1).click();
  assert.equal(scrolls, 1, 'below a header that pushes the frame down');
  rect = { top: 0, bottom: 375 };
  v.click('levels');
  v.click('confirm-yes');
  assert.equal(scrolls, 1, 'in view: no scroll');
  rect = { top: 0, bottom: 900 };
  v.level(1).click();
  assert.equal(scrolls, 1, 'its top in view, taller than the viewport: no scroll');
  rect = { top: -120, bottom: 255 };
  v.click('levels');
  v.click('confirm-yes');
  assert.equal(scrolls, 2, 'scrolled past its top');
  // A target far down the list: the list scrolls to it inside the frame (the
  // level left is saved, so its Resume button is the target).
  v.level(1).click();
  v.el('run-resume').offsetTop = 900;
  v.el('select-body').clientHeight = 400;
  v.click('levels');
  v.click('confirm-yes');
  assert.equal(v.el('select-body').scrollTop, 700);
  assert.equal(document.activeElement, v.el('run-resume'));
  v.el('run-resume').offsetTop = 0;
  v.level(1).click();
  v.click('levels');
  v.click('confirm-yes');
  assert.equal(v.el('select-body').scrollTop, 0);
  // with nothing saved, the level last played
  v.level(1).click();
  v.level(1).offsetTop = 900;
  v.rt.runOwn = false;
  finish(v);
  v.rt.sim.status = 'lost';
  v.click('levels');
  assert.equal(document.activeElement, v.level(1));
  assert.equal(v.el('select-body').scrollTop, 700);
  // Maximised there is nothing to scroll to.
  keepScrollStyles(t);
  rect = { top: -50, bottom: 300 };
  const before = scrolls;
  v.click('select-full');
  v.click('codex-open');
  assert.equal(scrolls, before);
  v.click('codex-back');
  v.click('select-full');
});

test('packet-siege: Fullscreen asks the browser to put the frame in fullscreen; the change events switch the button and lay the frame out over the screen; a level runs on throughout', async (t) => {
  viewport(t, 1600, 900);
  const { clock, v } = openModule(t, { width: 960 });
  const frame = v.el('frame');
  const requested = [];
  const exits = [];
  frame.requestFullscreen = function () {
    requested.push(this);
    return Promise.resolve();
  };
  document.exitFullscreen = function () {
    exits.push(this);
    return Promise.resolve();
  };
  t.after(() => {
    delete document.exitFullscreen;
    delete document.fullscreenElement;
  });
  v.level(1).click();
  clock.frame(16).frame(1000 / 60);
  const tick = v.rt.sim.tick;
  v.click('full');
  assert.deepEqual(requested, [frame], 'the frame, not the canvas or the page');
  assert.equal(v.rt.mode, 'page', 'until the browser says so');
  document.fullscreenElement = frame;
  fire(document, 'fullscreenchange');
  assert.equal(v.rt.mode, 'full');
  assert.equal(v.text('full'), 'Exit full');
  assert.equal(v.el('full').getAttribute('aria-pressed'), 'true');
  assert.equal(v.text('select-full'), 'Exit full');
  const L = pks.pksFitLayout(1600, 900);
  assert.deepEqual(v.frameStyle(), ['1600px', '900px']);
  assert.equal(v.el('field').style.width, L.field.w + 'px');
  assert.equal(L.field.w, 1280, 'a whole multiple: 4x');
  assert.equal(v.el('holder').style.height, pks.pksPageLayout(960).h + 'px', 'the page keeps the frame\'s place');
  assert.equal(document.activeElement, v.canvas, 'a mouse click hands the keys back to the field');
  clock.frame(1000 / 60);
  assert.equal(v.rt.sim.tick, tick + 1, 'nothing restarted, nothing paused');
  // Esc in fullscreen is the browser's: it pauses nothing.
  v.press('Escape');
  assert.equal(v.rt.paused, false);
  // The button leaves; the browser's change event (from Esc too) puts the page layout back.
  v.click('full');
  assert.deepEqual(exits, [document]);
  delete document.fullscreenElement;
  fire(document, 'fullscreenchange');
  assert.equal(v.rt.mode, 'page');
  assert.equal(v.text('full'), 'Fullscreen');
  assert.equal(v.el('full').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(v.frameStyle(), ['960px', pks.pksPageLayout(960).h + 'px']);
  assert.equal(clock.pending(), 1, 'the level still runs');
  // Another element's fullscreen is not the frame's.
  document.fullscreenElement = v.canvas;
  fire(document, 'fullscreenchange');
  assert.equal(v.rt.mode, 'page');
  delete document.fullscreenElement;
  // F on the field does the same as the button.
  v.press('f');
  assert.equal(requested.length, 2);
  await Promise.resolve();
  assert.equal(v.rt.mode, 'page', 'a granted request changes nothing by itself');
});

test('packet-siege: the webkit Fullscreen API works the same', (t) => {
  viewport(t, 1280, 720);
  const { v } = openModule(t, { width: 960 });
  const frame = v.el('frame');
  let requests = 0;
  let exits = 0;
  frame.webkitRequestFullscreen = () => {
    requests++;
  };
  document.webkitExitFullscreen = () => {
    exits++;
  };
  t.after(() => {
    delete document.webkitExitFullscreen;
    delete document.webkitFullscreenElement;
  });
  v.click('select-full');
  assert.equal(requests, 1);
  document.webkitFullscreenElement = frame;
  fire(document, 'webkitfullscreenchange');
  assert.equal(v.rt.mode, 'full');
  assert.deepEqual(v.frameStyle(), ['1280px', '720px']);
  v.click('select-full');
  assert.equal(exits, 1);
  delete document.webkitFullscreenElement;
  fire(document, 'webkitfullscreenchange');
  assert.equal(v.rt.mode, 'page');
});

test('packet-siege: without the Fullscreen API, or when it throws or refuses, the frame is maximised over the viewport with the page\'s scroll locked, and the same button leaves', async (t) => {
  viewport(t, 844, 390);
  keepScrollStyles(t);
  document.documentElement.style.overflow = 'scroll';
  document.body.style.overflow = '';
  const { clock, v } = openModule(t, { width: 804 });
  const frame = v.el('frame');
  const page = v.frameStyle();
  v.level(1).click();
  clock.frame(16);
  // No API (an iPhone): maximised at once.
  v.click('full');
  assert.equal(v.rt.mode, 'max');
  assert.ok(frame.classList.contains('pks-frame--max'));
  assert.equal(document.documentElement.style.overflow, 'hidden');
  assert.equal(document.body.style.overflow, 'hidden');
  assert.equal(v.text('full'), 'Exit full');
  const L = pks.pksFitLayout(844, 390);
  assert.deepEqual(v.frameStyle(), ['844px', '390px']);
  assert.equal(v.el('field').style.width, L.field.w + 'px');
  assert.equal(clock.pending(), 1, 'the level runs on');
  // A resize while maximised follows the viewport.
  viewport(t, 390, 844);
  fire(window, 'resize');
  assert.deepEqual(v.frameStyle(), ['390px', '844px']);
  viewport(t, 844, 390);
  fire(window, 'resize');
  // Leaving gives the page its scroll back as it was.
  v.click('full');
  assert.equal(v.rt.mode, 'page');
  assert.ok(!frame.classList.contains('pks-frame--max'));
  assert.equal(document.documentElement.style.overflow, 'scroll');
  assert.equal(document.body.style.overflow, '');
  assert.equal(v.text('full'), 'Fullscreen');
  assert.deepEqual(v.frameStyle(), page);
  // A request that throws (an embed without permission in an old browser).
  frame.requestFullscreen = () => {
    throw new TypeError('not allowed');
  };
  v.click('full');
  assert.equal(v.rt.mode, 'max');
  v.click('full');
  // A request whose promise is refused.
  frame.requestFullscreen = () => Promise.reject(new TypeError('Permissions check failed'));
  v.click('full');
  assert.equal(v.rt.mode, 'page', 'until the refusal arrives');
  await new Promise(setImmediate);
  assert.equal(v.rt.mode, 'max');
  v.click('full');
  // The error event (the webkit way), twice: maximised once.
  frame.requestFullscreen = () => undefined;
  v.click('full');
  fire(document, 'webkitfullscreenerror');
  fire(document, 'fullscreenerror');
  assert.equal(v.rt.mode, 'max');
  assert.equal(document.documentElement.style.overflow, 'hidden');
  v.click('full');
  assert.equal(document.documentElement.style.overflow, 'scroll', 'given back once, as it was');
  // A refusal that comes while fullscreen is on after all changes nothing.
  document.fullscreenElement = frame;
  t.after(() => delete document.fullscreenElement);
  fire(document, 'fullscreenerror');
  assert.equal(v.rt.mode, 'page');
  // Leaving fullscreen whose exit is refused stays quiet.
  fire(document, 'fullscreenchange');
  assert.equal(v.rt.mode, 'full');
  document.exitFullscreen = () => Promise.reject(new TypeError('not in fullscreen'));
  t.after(() => delete document.exitFullscreen);
  v.click('full');
  await new Promise(setImmediate);
  assert.equal(v.rt.mode, 'full');
});

test('packet-siege: F toggles fullscreen from the field and from any button in the frame; Esc pauses on the page, leaves maximised, and does nothing more in fullscreen; P always pauses', (t) => {
  viewport(t, 1024, 768);
  keepScrollStyles(t);
  const { clock, v } = openModule(t, { width: 960 });
  // On the level select: F on a focused button maximises (no API here); Esc leaves.
  focusElement(v.el('codex-open'), { keyboard: true });
  assert.equal(pressKey('f', { target: v.el('codex-open') }).defaultPrevented, true);
  assert.equal(v.rt.mode, 'max');
  assert.equal(pressKey('f', { target: v.el('codex-open'), repeat: true }).defaultPrevented, false, 'a held F acts once');
  assert.equal(pressKey('Escape', { target: v.el('codex-open') }).defaultPrevented, true);
  assert.equal(v.rt.mode, 'page');
  assert.equal(pressKey('Escape', { target: v.el('codex-open') }).defaultPrevented, false, 'on the page Esc on a button is the page\'s');
  assert.equal(pressKey('f', { target: v.el('codex-open'), ctrlKey: true }).defaultPrevented, false);
  assert.equal(pressKey('q', { target: v.el('codex-open') }).defaultPrevented, false);
  const taken = keyEvent('f', { target: v.el('codex-open') });
  taken.preventDefault();
  v.el('codex-open').dispatchEvent(taken);
  assert.equal(v.rt.mode, 'page', 'a key the host page took is left alone');
  // In a level: Esc pauses on the page.
  v.level(1).click();
  clock.frame(16);
  v.press('Escape');
  assert.equal(v.rt.paused, true);
  v.press('Escape');
  assert.equal(v.rt.paused, false);
  // F works while paused, too; maximised, Esc leaves maximised and does not pause.
  v.press('p');
  v.press('f');
  assert.equal(v.rt.mode, 'max');
  v.press('p');
  assert.equal(v.rt.paused, false, 'P resumes maximised');
  v.press('Escape');
  assert.equal(v.rt.mode, 'page');
  assert.equal(v.rt.paused, false, 'Esc only left maximised');
  // In real fullscreen Esc is the browser's.
  v.rt.mode = 'full';
  v.press('Escape');
  assert.equal(v.rt.paused, false);
  assert.equal(v.rt.mode, 'full');
  v.press('p');
  assert.equal(v.rt.paused, true, 'P pauses in fullscreen');
  v.rt.mode = 'page';
  assert.match(v.canvas.getAttribute('aria-label'), /P pauses, S changes the speed, F toggles fullscreen/);
});

// ── source checks ──────────────────────────────────────────────────────────

// The ids pksFind looks up, from its table in ui-page.js.
const LOOKED_UP = (() => {
  const src = readRepoFile(GAME + '/src/ui-page.js');
  const table = src.slice(src.indexOf('var ids = {'), src.indexOf('};', src.indexOf('var ids = {')));
  return Array.from(table.matchAll(/'(pks-[\w-]+)'/g), (m) => m[1]);
})();

test('packet-siege: every id the script looks up is in index.html once; ids, classes, CSS variables, the storage key and exports are pks- prefixed', () => {
  assert.equal(new Set(LOOKED_UP).size, LOOKED_UP.length, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of LOOKED_UP) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^pks-/);
  assert.deepEqual(htmlIds.filter((id) => !LOOKED_UP.includes(id)), ['pks-codex-title', 'pks-help-title'], 'only headings dialogs are labelled by');
  assert.doesNotMatch(JS, /getElementById\((?!ids\[)/, 'pksFind is the one lookup');
  // Ids the script gives what it builds.
  assert.deepEqual(Array.from(UI.matchAll(/'(pks-[\w-]+-)' \+/g), (m) => m[1]).sort(), ['pks-card-', 'pks-level-', 'pks-pick-', 'pks-zone-']);
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^pks-/);
  assert.doesNotMatch(UI, /'--/, 'the script sets no custom property');
  assert.equal(UI.replace(/\/\/[^\n]*/g, '').match(/localStorage\b/g).length, 1, 'touched in one place');
  assert.match(JS, /return window\.localStorage;/);
  assert.match(JS, /var PKS_SAVE_KEY = 'pks-state';/);
  assert.match(JS, /var PKS_RUN_KEY = 'pks-run';/);
  for (const name of Object.keys(pks)) assert.match(name, /^pks[A-Z]/);
  const rules = cssRules(CSS);
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      assert.match(selector, /^\.pks-wrapper\b/, selector + ' sits under the wrapper');
      for (const m of selector.matchAll(/[.#]([\w-]+)/g)) assert.match(m[1], /^pks-/, selector);
    }
  }
});

test('packet-siege: every class in the markup and every class the script gives an element has a CSS rule', (t) => {
  viewport(t, 667, 375);
  keepScrollStyles(t);
  const { clock, v } = openModule(t, { save: wonUpTo(9, 3, { met: ['bot'] }), width: 320 });
  const seen = new Set();
  const collect = () => {
    const walk = (node) => {
      for (const name of String(node.className || '').split(/\s+/).filter(Boolean)) seen.add(name);
      (node.children || []).forEach(walk);
    };
    walk(v.page.root);
  };
  collect();
  v.click('codex-open');
  collect();
  v.click('codex-back');
  v.level(10).click();
  collect();
  v.click('loadout-start');
  v.rt.sim.cycles = 0;
  v.rt.sim.warned = 1;
  v.rt.aim = { lane: 0, col: 0 };
  clock.frame(16).frame(16);
  fire(window, 'blur');
  collect();
  v.click('resume');
  v.el('holder').clientWidth = 667;
  fire(window, 'resize');
  v.click('full');
  collect();
  v.click('full');
  finish(v);
  clock.frame(16).frame(1000 / 60).run(2);
  collect();
  v.click('next');
  v.click('loadout-start');
  v.rt.aim = { lane: 0, col: 0 };
  clock.frame(16);
  collect();
  const markup = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  for (const name of markup) seen.add(name);
  const styled = new Set(cssRules(CSS).flatMap((rule) => rule.selectors.flatMap((s) => Array.from(s.matchAll(/\.([\w-]+)/g), (m) => m[1]))));
  for (const name of ['pks-hidden', 'pks-card--poor', 'pks-hud-surge--warn', 'pks-level--locked', 'pks-level--boss', 'pks-entry--locked',
    'pks-news-item-icon', 'pks-news-item-detail', 'pks-news--low', 'pks-news--off', 'pks-unlock-icon', 'pks-result-star', 'pks-pick',
    'pks-entry-icon', 'pks-frame--max', 'pks-frame--side', 'pks-frame--small', 'pks-hud--two', 'pks-overlay--body']) {
    assert.ok(seen.has(name), name + ' is used');
  }
  assert.ok(seen.size > 70, seen.size + ' classes');
  for (const name of seen) {
    assert.match(name, /^pks-/);
    assert.ok(styled.has(name), name + ' has a CSS rule');
  }
});

test('packet-siege: the three files embed safely, load nothing from the network, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="pks-wrapper"'));
  assert.ok(embedded.includes('id="pks-codex-back"'), 'the whole game is in the wrapper');
  assert.deepEqual(embedSafety(embedded), []);
  const bg = CSS.match(/--pks-bg-primary:\s*(#[0-9a-fA-F]{6})/)[1];
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Packet Siege — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{120,}">/);
  assert.match(head, /<meta name="viewport" content="width=device-width, initial-scale=1.0">/);
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(|@font-face|data:image/, 'no network resources, no data URIs');
  }
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|Worker|Image)\b/);
  assert.doesNotMatch(UI, /innerHTML/, 'text goes in as text');
});

test('packet-siege: the UI parts are fragments of the closure under 900 lines, split by responsibility, in ES5 with pks names', () => {
  assert.deepEqual(UI_PARTS, ['ui-text', 'ui-layout', 'ui-page', 'ui-frame', 'ui-select', 'ui-screens', 'ui-level', 'ui-rules', 'ui-input']);
  assert.deepEqual(BUILD.PARTS.slice(-10), UI_PARTS.concat(['main']));
  for (const part of UI_PARTS.concat(['main'])) {
    const text = readRepoFile(GAME + '/src/' + part + '.js');
    assert.ok(text.split('\n').length < 900, part);
    assert.match(text, /^\/\/ ── (ui|main): /, part);
  }
  for (const part of ['ui-text', 'ui-layout']) {
    assert.doesNotMatch(readRepoFile(GAME + '/src/' + part + '.js').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, ''),
      /\bdocument\b|\bwindow\b|requestAnimationFrame/, part + ' is pure');
  }
  assert.match(JS, /\} else if \(document\.readyState === 'loading'\) \{\n\s+document\.addEventListener\('DOMContentLoaded', pksInit\);\n\s+\} else \{\n\s+pksInit\(\);\n\s+\}/);
  const code = UI.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/], ['template literal', /`/],
    ['double-quoted string', /"/], ['spread or rest', /\.\.\./], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['newer methods', /\.(padStart|padEnd|includes|find|findIndex|flat|flatMap|fill|assign|entries|values|repeat|startsWith|endsWith|closest|append|prepend|replaceChildren)\(/],
    ['Math.random', /Math\.random/], ['timers', /setTimeout|setInterval|Date\b|performance\./]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('packet-siege: index.html: one frame holds the whole game; outside it only the title, the description, the live region and the footer', () => {
  const spec = htmlPageSpec(HTML);
  const inFrame = (id) => {
    for (let at = spec[id].parent; at; at = spec[at].parent) if (at === 'pks-frame') return true;
    return false;
  };
  assert.equal(spec['pks-frame'].parent, 'pks-holder');
  assert.equal(spec['pks-holder'].parent, undefined);
  for (const id of Object.keys(spec)) {
    if (['pks-live', 'pks-holder', 'pks-frame'].includes(id)) continue;
    assert.ok(inFrame(id), id + ' is in the frame');
  }
  // The level: HUD, field, tray, cards, status and its overlays, in the level layer.
  for (const id of ['pks-hud', 'pks-field', 'pks-tray', 'pks-cards', 'pks-status', 'pks-paused', 'pks-confirm', 'pks-result']) {
    assert.equal(spec[id].parent, 'pks-play', id);
  }
  for (const id of ['pks-pause', 'pks-speed', 'pks-levels', 'pks-full']) assert.equal(spec[id].parent, 'pks-hud', id);
  assert.equal(spec['pks-canvas'].parent, 'pks-field');
  assert.equal(spec['pks-news'].parent, 'pks-field', 'the news is a banner over the field');
  for (const id of ['pks-play', 'pks-select', 'pks-loadout', 'pks-codex', 'pks-help', 'pks-warning']) assert.equal(spec[id].parent, 'pks-frame', id);
  const outside = embedMarkup(HTML).replace(/<div id="pks-holder"[\s\S]*<\/div>\s*<\/div>\s*<footer/, '<footer');
  assert.deepEqual(Array.from(outside.matchAll(/<(\w+)[\s>]/g), (m) => m[1]), ['div', 'header', 'h1', 'p', 'div', 'footer']);
  assert.doesNotMatch(HTML, /<details/, 'the help is not a details box under the game');
});

test('packet-siege: index.html: an application canvas whose label lists the keys, a group of cards, real buttons with labels, a live region', () => {
  const spec = htmlPageSpec(HTML);
  const canvas = spec['pks-canvas'];
  assert.equal(canvas.tagName, 'canvas');
  assert.deepEqual([canvas.width, canvas.height], [320, 180]);
  assert.equal(canvas.attributes.tabindex, '0');
  assert.equal(canvas.attributes.role, 'application', 'not img: screen readers hand it the arrows, Space and Enter');
  assert.match(canvas.attributes['aria-label'], /1 to 9 and 0 pick a card, the arrows move the cell cursor, Enter or Space places, X picks Decommission, P pauses, S changes the speed, F toggles fullscreen/);
  assert.equal(spec['pks-cards'].attributes.role, 'group', 'a labelled group, not a plain div');
  assert.equal(spec['pks-cards'].attributes['aria-label'], 'Cards');
  assert.equal(spec['pks-frame'].attributes.role, 'region');
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
    }
  }
  for (const [id, key] of [['pks-pause', 'P'], ['pks-speed', 'S'], ['pks-full', 'F'], ['pks-select-full', 'F']]) {
    assert.ok(spec[id].attributes.title.endsWith('(' + key + ')'), id + ' names its key');
  }
  assert.equal(spec['pks-live'].attributes['aria-live'], 'polite');
  assert.equal(spec['pks-live'].className, 'pks-sr');
  assert.equal(spec['pks-warning'].attributes.role, 'alert');
  assert.equal(spec['pks-loadout-start'].disabled, true);
  for (const id of ['pks-loadout', 'pks-play', 'pks-result', 'pks-codex', 'pks-paused', 'pks-confirm', 'pks-help', 'pks-warning']) {
    assert.match(spec[id].className, /\bpks-hidden\b/, id);
  }
  assert.match(spec['pks-news'].className, /\bpks-news--off\b/);
  assert.doesNotMatch(spec['pks-select'].className, /pks-hidden/, 'the level select first');
  assert.match(HTML, /<p class="pks-rotate">Turn your phone sideways and press Fullscreen for the biggest field\.<\/p>/);
  // Every control the script builds is a real button.
  assert.doesNotMatch(UI, /pksMake\('(div|span)', 'pks-(card|level|pick|zone-tile|rule)'\)/);
  assert.equal((UI.match(/pksButtonEl\(/g) || []).length, 5);
  assert.match(UI, /pksMake\('button', 'pks-rule'\)/, 'the rule badges are buttons');
  assert.equal(spec['pks-rules'].attributes.role, 'group');
  assert.match(spec['pks-zone-tiles'].attributes['aria-label'], /Zones/);
});

// ── contrast and layout ────────────────────────────────────────────────────

// The WCAG 2 relative luminance of #rrggbb, and the contrast ratio of two colours.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const RULES = cssRules(CSS);
const W = (selector) => '.pks-wrapper ' + selector;

test('packet-siege: text keeps a 4.5:1 contrast on its background: buttons, cards, levels, the HUD, status, overlays, codex and help', () => {
  const tokens = declsAt(RULES, '.pks-wrapper', 1280);
  const solid = (value) => {
    const m = /^var\((--pks-[\w-]+)\)$/.exec(String(value).trim());
    const hex = m ? tokens[m[1]] : String(value).trim();
    assert.match(String(hex), /^#[0-9a-f]{6}$/i, 'a solid colour: ' + value);
    return hex;
  };
  const get = (selector, prop, hover) => declsAt(RULES, selector, 1280, hover ? { matchMedia: () => true } : undefined)[prop];
  const page = get('.pks-wrapper', 'background');
  const frame = get(W('.pks-frame'), 'background');
  const bar = get(W('.pks-hud'), 'background');
  const panel = get(W('.pks-panel'), 'background');
  const card = 'var(--pks-bg-card)';
  const text = get('.pks-wrapper', 'color');
  assert.equal(get(W('.pks-tray'), 'background'), bar, 'the tray and the HUD are one bar colour');
  assert.equal(get(W('.pks-screen-head'), 'background'), bar);
  const pairs = [
    ['page text', text, page],
    ['.pks-subtitle', get(W('.pks-subtitle'), 'color'), page],
    ['.pks-footer', get(W('.pks-footer'), 'color'), page],
    ['frame text', get(W('.pks-frame'), 'color'), frame],
    ['.pks-total', get(W('.pks-total'), 'color'), bar],
    ['.pks-total span', get(W('.pks-total span'), 'color'), bar],
    ['.pks-zone-title', get(W('.pks-zone-title'), 'color'), frame],
    ['.pks-rotate', get(W('.pks-rotate'), 'color'), frame],
    ['.pks-hud', get(W('.pks-frame'), 'color'), bar],
    ['.pks-hud-cycles', get(W('.pks-hud-cycles'), 'color'), bar],
    ['.pks-hud-surge', get(W('.pks-hud-surge'), 'color'), bar],
    ['.pks-hud-surge--warn', get(W('.pks-hud-surge--warn'), 'color'), bar],
    ['.pks-btn', get(W('.pks-btn'), 'color'), get(W('.pks-btn'), 'background')],
    ['.pks-btn:hover', get(W('.pks-btn'), 'color'), get(W('.pks-btn:hover'), 'background', true)],
    ['.pks-btn:disabled', get(W('.pks-btn:disabled'), 'color'), get(W('.pks-btn:disabled'), 'background')],
    ['.pks-btn--secondary', get(W('.pks-btn--secondary'), 'color'), get(W('.pks-btn--secondary'), 'background')],
    ['.pks-btn--secondary:hover', get(W('.pks-btn--secondary'), 'color'), get(W('.pks-btn--secondary:hover'), 'background', true)],
    ['.pks-level', get(W('.pks-level'), 'color'), get(W('.pks-level'), 'background')],
    ['.pks-star', get(W('.pks-star'), 'color'), get(W('.pks-level'), 'background')],
    ['.pks-star-off', get(W('.pks-star-off'), 'color'), get(W('.pks-level'), 'background')],
    ['.pks-level--locked', get(W('.pks-level--locked'), 'color'), get(W('.pks-level--locked'), 'background')],
    ['.pks-loadout-count', get(W('.pks-loadout-count'), 'color'), bar],
    ['.pks-pick', get(W('.pks-pick'), 'color'), get(W('.pks-pick'), 'background')],
    ['.pks-pick-desc', get(W('.pks-pick-desc'), 'color'), get(W('.pks-pick'), 'background')],
    ['picked .pks-pick-desc', get(W('.pks-pick[aria-pressed="true"] .pks-pick-desc'), 'color'), get(W('.pks-pick[aria-pressed="true"]'), 'background')],
    ['.pks-card', get(W('.pks-card'), 'color'), get(W('.pks-card'), 'background')],
    ['.pks-card in hand', get(W('.pks-card'), 'color'), get(W('.pks-card[aria-pressed="true"]'), 'background')],
    ['.pks-card-cost', get(W('.pks-card-cost'), 'color'), card],
    ['.pks-card-cost in hand', get(W('.pks-card-cost'), 'color'), get(W('.pks-card[aria-pressed="true"]'), 'background')],
    ['.pks-card--poor .pks-card-cost', get(W('.pks-card--poor .pks-card-cost'), 'color'), card],
    ['.pks-card-key', get(W('.pks-card-key'), 'color'), card],
    ['.pks-status on the tray', get(W('.pks-status'), 'color'), bar],
    ['.pks-status beside it, on the frame', get(W('.pks-status'), 'color'), frame],
    // The news banner is 94 % opaque bg-secondary over the field: judged on its solid base.
    ['.pks-news', get(W('.pks-frame'), 'color'), 'var(--pks-bg-secondary)'],
    ['.pks-news-item-detail', get(W('.pks-news-item-detail'), 'color'), 'var(--pks-bg-secondary)'],
    ['.pks-warning', get(W('.pks-warning'), 'color'), get(W('.pks-warning'), 'background')],
    ['.pks-overlay-title', get(W('.pks-overlay-title'), 'color'), panel],
    ['.pks-screen-title', get(W('.pks-screen-title'), 'color'), panel],
    ['.pks-result-text', get(W('.pks-result-text'), 'color'), panel],
    ['.pks-unlock', get(W('.pks-frame'), 'color'), get(W('.pks-unlock'), 'background')],
    ['.pks-entry', get(W('.pks-frame'), 'color'), get(W('.pks-entry'), 'background')],
    ['.pks-entry-stats', get(W('.pks-entry-stats'), 'color'), get(W('.pks-entry'), 'background')],
    ['.pks-entry-desc', get(W('.pks-entry-desc'), 'color'), get(W('.pks-entry'), 'background')],
    ['.pks-entry--locked .pks-entry-name', get(W('.pks-entry--locked .pks-entry-name'), 'color'), get(W('.pks-entry'), 'background')],
    ['.pks-codex-head', get(W('.pks-codex-head'), 'color'), frame],
    ['.pks-help-list', get(W('.pks-help-list'), 'color'), panel],
    ['.pks-zone-tile', get(W('.pks-zone-tile'), 'color'), get(W('.pks-zone-tile'), 'background')],
    ['.pks-zone-stars', get(W('.pks-zone-stars'), 'color'), get(W('.pks-zone-tile'), 'background')],
    ['pressed .pks-zone-stars', get(W('.pks-zone-stars'), 'color'), get(W('.pks-zone-tile[aria-pressed="true"]'), 'background')],
    ['.pks-zone-tile--locked', get(W('.pks-zone-tile--locked'), 'color'), get(W('.pks-zone-tile--locked'), 'background')],
    ['.pks-run-text', get(W('.pks-run-text'), 'color'), get(W('.pks-run'), 'background')],
    ['.pks-loadout-head', get(W('.pks-loadout-head'), 'color'), frame],
    ['.pks-paused-rules', get(W('.pks-paused-rules'), 'color'), panel],
    // the badges are 88 % opaque bg-primary over the canvas: judged on their solid base
    ['.pks-rule', get(W('.pks-rule'), 'color'), 'var(--pks-bg-primary)'],
    ['.pks-rule--alert', get(W('.pks-rule--alert'), 'color'), 'var(--pks-bg-primary)']
  ];
  for (const [name, fg, bg] of pairs) {
    const ratio = contrast(solid(fg), solid(bg));
    assert.ok(ratio >= 4.5, name + ': ' + ratio.toFixed(2) + ':1');
  }
  assert.ok(contrast('#ffffff', '#3b82f6') < 4.5, 'the template blue is too light for white text, so the buttons use a darker one');
  assert.doesNotMatch(CSS, /color: var\(--pks-text-muted\)/, 'the muted grey is not used for text');
  // Visible focus rings on every control and the field.
  assert.equal(get('.pks-wrapper button:focus-visible', 'outline'), '2px solid var(--pks-accent-cyan)');
  assert.equal(get(W('.pks-canvas:focus-visible'), 'outline'), '2px solid var(--pks-accent-cyan)');
});

const px = (value) => {
  const m = /^(-?\d+(?:\.\d+)?)px$|^(0)$/.exec(String(value).trim());
  assert.ok(m, 'a px length: ' + value);
  return Number(m[1] || m[2]);
};

// The frame's parent at a viewport width: the wrapper's column (its max
// width less its side padding).
function holderWidth(vw) {
  const wrapper = declsAt(RULES, '.pks-wrapper', vw);
  const side = px(wrapper.padding.split(/\s+/)[1] || wrapper.padding.split(/\s+/)[0]);
  return Math.min(vw, px(wrapper['max-width'])) - 2 * side;
}

test('packet-siege: from 320 to 1440 px: the field at 960x540 from a 992 px window, else a whole multiple or the whole column (1:1 on a 320 px phone); the frame never wider than its column', () => {
  for (let vw = 320; vw <= 1440; vw++) {
    const column = holderWidth(vw);
    const L = pks.pksPageLayout(column);
    assert.ok(L.w <= column, vw + ' px: the frame fits its column');
    if (vw >= 992) assert.equal(L.w, 960, vw + ' px: 3x');
    else assert.ok(L.w % 320 === 0 ? L.w >= column * 0.8 : L.w === column, vw + ' px: a ' + L.w + ' px field in a ' + column + ' px column');
  }
  assert.equal(holderWidth(320), 320, 'no side padding on a phone');
  assert.equal(holderWidth(679), 679);
  assert.equal(holderWidth(680), 648, '16 px each side from 680 px');
  assert.equal(holderWidth(1000), 968, 'a host up to 8 px narrower still gets 3x');
  assert.equal(pks.pksPageLayout(holderWidth(991)).w, 959);
  assert.equal(pks.pksPageLayout(holderWidth(990)).w, 958);
  assert.equal(pks.pksPageLayout(holderWidth(800)).w, 640, 'a 768 px column: 2x');
  assert.equal(pks.pksPageLayout(holderWidth(640)).w, 640);
  assert.equal(pks.pksPageLayout(holderWidth(639)).w, 639);
  const frame = declsAt(RULES, W('.pks-frame'), 1280);
  assert.deepEqual([frame.position, frame.overflow, frame.margin], ['relative', 'hidden', '0 auto']);
  assert.match(frame['box-shadow'], /^0 0 0 1px var\(--pks-border\)/, 'one border drawn as a shadow: it takes no width from the field');
  assert.equal(declsAt(RULES, W('.pks-frame'), 1280).border, undefined);
  const max = declsAt(RULES, W('.pks-frame--max'), 375);
  assert.deepEqual([max.position, max.left, max.top, max['z-index']], ['fixed', '0', '0', '2147483000']);
  for (const selector of ['.pks-play', '.pks-screen', '.pks-overlay']) {
    const d = declsAt(RULES, W(selector), 1280);
    assert.deepEqual([d.position, d.left, d.top, d.right, d.bottom], ['absolute', '0', '0', '0', '0'], selector + ' fills the frame');
  }
  for (const selector of ['.pks-hud', '.pks-field', '.pks-tray', '.pks-cards', '.pks-status']) {
    assert.equal(declsAt(RULES, W(selector), 1280).position, 'absolute', selector + ' sits where the layout puts it');
  }
  assert.equal(declsAt(RULES, W('.pks-screen-body'), 320)['overflow-y'], 'auto', 'tall screens scroll inside the frame');
  assert.equal(declsAt(RULES, W('.pks-overlay'), 320)['overflow-y'], 'auto');
  const canvas = declsAt(RULES, W('.pks-canvas'), 1280);
  assert.deepEqual([canvas.display, canvas.width, canvas.height, canvas['image-rendering'], canvas['touch-action']], ['block', '100%', '100%', 'pixelated', 'manipulation']);
  assert.equal(declsAt(RULES, W('.pks-hidden'), 320).display, 'none !important');
  assert.equal(declsAt(RULES, '.pks-wrapper', 320)['overflow-wrap'], 'break-word');
  // Grids inside the frame never ask for more than a 300 px frame less its padding.
  for (const [selector, min] of [['.pks-level-grid', 52], ['.pks-loadout-list', 220], ['.pks-codex-list', 260]]) {
    assert.equal(declsAt(RULES, W(selector), 320)['grid-template-columns'], 'repeat(auto-fill, minmax(' + min + 'px, 1fr))');
    assert.ok(min <= 300 - 2 * 12, selector);
  }
  // Touch targets.
  for (const [selector, prop] of [['.pks-btn', 'min-height'], ['.pks-btn', 'min-width'], ['.pks-level', 'min-height'], ['.pks-pick', 'min-height'], ['.pks-card', 'height']]) {
    assert.ok(px(declsAt(RULES, W(selector), 320)[prop]) >= 44, selector + ' ' + prop);
  }
  assert.equal(px(declsAt(RULES, W('.pks-card'), 320).height), 56, 'the layout\'s card height');
  // A narrow portrait screen shows the line about turning the phone and Fullscreen; a touch screen hides the card keys.
  const portrait = { matchMedia: (q) => /orientation: portrait/.test(q) };
  assert.equal(declsAt(RULES, W('.pks-rotate'), 1280).display, 'none');
  assert.equal(declsAt(RULES, W('.pks-rotate'), 414, portrait).display, 'block');
  assert.equal(declsAt(RULES, W('.pks-rotate'), 600, portrait).display, 'none');
  assert.equal(declsAt(RULES, W('.pks-card-key'), 414, { matchMedia: (q) => /hover: none/.test(q) }).display, 'none');
});

// The widest a label of n characters can be: monospace fonts are 0.6 em
// wide (Consolas 0.55, Cascadia 0.59), so 0.61 em a character is safe.
const labelWidth = (text, fontPx) => text.length * 61 * fontPx / 100;

test('packet-siege: every card label fits its card on one line at 320 and 375 px, on landscape phones and in fullscreen, for 8 cards and Decommission: no broken word, no ellipsis', () => {
  const name = declsAt(RULES, W('.pks-card-name'), 320);
  const cardCss = declsAt(RULES, W('.pks-card'), 320);
  const fontPx = px(name['font-size']);
  assert.equal(name['white-space'], 'nowrap');
  assert.match(name['font-family'], /^var\(--pks-font-mono\)/);
  assert.equal(name['overflow-wrap'], undefined, 'no mid-word breaks');
  assert.equal(name['text-overflow'], undefined, 'no ellipsis');
  assert.doesNotMatch(CSS, /overflow-wrap: anywhere/);
  const chrome = 2 * px(cardCss.padding) + 2 * px(cardCss.border.split(' ')[0]);
  const labels = Object.entries(pks.pksCardShorts);
  assert.equal(labels.length, pks.pksDefenders.length + 1, 'every defender and Decommission');
  for (const [id, label] of labels) {
    assert.ok(label.length <= 10, id + ': ' + label);
    const full = id === 'decom' ? 'Decommission' : pks.pksDefender[id].name;
    assert.equal(label === full || full.length > 10, true, id + ': short labels only for long names');
  }
  const layouts = [
    ['320 px', pks.pksFrameLayout('page', holderWidth(320), 320, 640)],
    ['375 px', pks.pksFrameLayout('page', holderWidth(375), 375, 667)],
    ['300 px', pks.pksFrameLayout('page', 300, 300, 600)],
    ['640 px', pks.pksFrameLayout('page', 640, 768, 1024)],
    ['960 px', pks.pksFrameLayout('page', 960, 1600, 900)],
    ['568x320 landscape', pks.pksFrameLayout('page', holderWidth(568), 568, 320)],
    ['667x375 landscape', pks.pksFrameLayout('page', holderWidth(667), 667, 375)],
    ['844x390 landscape', pks.pksFrameLayout('page', holderWidth(844), 844, 390)],
    ['844x390 fullscreen', pks.pksFrameLayout('full', 0, 844, 390)],
    ['375x667 maximised', pks.pksFrameLayout('max', 0, 375, 667)],
    ['1920x1080 fullscreen', pks.pksFrameLayout('full', 0, 1920, 1080)]
  ];
  for (const [where, L] of layouts) {
    const inner = L.cardW - chrome;
    for (const [id, label] of labels) {
      assert.ok(labelWidth(label, fontPx) <= inner, where + ': ' + label + ' (' + labelWidth(label, fontPx).toFixed(1) + ' px) in a ' + inner + ' px card (' + id + ')');
    }
  }
  // The check can fail: the full names would not fit a phone's cards.
  const phone = layouts[0][1];
  assert.ok(labelWidth('Decommission', fontPx) > phone.cardW - chrome || labelWidth('Packet Inspector', fontPx) > phone.cardW - chrome);
  assert.ok(labelWidth('Packet Inspector', fontPx) > pks.pksFitLayout(667, 375).cardW - chrome, 'nor the landscape side column');
});

test('packet-siege: landscape phones (568x320, 667x375, 740x360, 844x390, 932x430): with everything above the frame scrolled away, the HUD, the field and every card are on screen together', () => {
  for (const [vw, vh] of [[568, 320], [667, 375], [740, 360], [844, 390], [932, 430]]) {
    const column = holderWidth(vw);
    const L = pks.pksFrameLayout('page', column, vw, vh);
    assert.equal(L.fit, true, vw + 'x' + vh + ': the frame takes the viewport\'s height');
    assert.equal(L.h, vh);
    assert.equal(L.w, column);
    assertLayoutSound(L, vw + 'x' + vh);
    assert.ok(L.field.w >= 320, vw + 'x' + vh + ': a field of ' + L.field.w + ' px');
    // What is above the frame (the title and the description) scrolls away when a level starts (see the reveal test).
    const full = pks.pksFrameLayout('full', 0, vw, vh);
    assert.ok(full.field.w >= L.field.w, vw + 'x' + vh + ': fullscreen is at least as big');
  }
  // The side tray only when it makes the field clearly bigger: not on a desktop window.
  assert.equal(pks.pksFitLayout(960, 650).side, false);
  assert.equal(pks.pksFitLayout(1600, 900).side, false);
  assert.equal(pks.pksFitLayout(667, 375).side, true);
  // Whole multiples when close to the fit, else the fit.
  assert.equal(pks.pksFitScale(1280, 720), 4);
  assert.equal(pks.pksFitScale(1300, 760), 4);
  assert.equal(pks.pksFitScale(560, 300), 300 / 180);
  assert.equal(pks.pksFitScale(200, 100), 100 / 180);
  assert.equal(pks.pksFitScale(-50, -50), 0.1, 'never nothing');
});

// The specificity of a simple selector as [ids, classes / attributes /
// pseudo-classes, elements].
function specificity(selector) {
  const s = selector.replace(/::[\w-]+/g, ' ');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(\([^)]*\))?/g) || []).length;
  const elements = (s.replace(/\[[^\]]+\]|[.#:][\w-]+(\([^)]*\))?/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/g) || []).length;
  return [ids, classes, elements];
}

const beats = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

test('packet-siege: a host page\'s bare element rules (button { text-transform: uppercase } ...) stop at the wrapper; the game\'s own rules outrank them', () => {
  assert.deepEqual(specificity('.pks-wrapper button'), [0, 1, 1]);
  assert.deepEqual(specificity('.pks-wrapper .pks-btn:hover'), [0, 3, 0]);
  const reset = RULES.find((rule) => rule.selectors.includes('.pks-wrapper button') && rule.selectors.includes('.pks-wrapper h2'));
  assert.ok(reset, 'one reset rule for the elements the game uses');
  for (const element of ['button', 'h1', 'h2', 'h3', 'p', 'ul', 'li', 'canvas']) assert.ok(reset.selectors.includes('.pks-wrapper ' + element), element);
  assert.deepEqual(reset.decls, {
    margin: '0', 'text-transform': 'none', 'letter-spacing': 'normal', 'font-family': 'inherit', 'line-height': 'inherit',
    'box-shadow': 'none', 'min-width': '0', 'min-height': '0'
  });
  // The reset beats a host's element rules, even with a class in front (.entry-content button is 0,1,1: equal, and the
  // game's sheet comes later); the game's own component rules beat the reset and such host rules.
  for (const host of ['button', 'h2', 'p', 'li']) assert.ok(beats(specificity(reset.selectors[0]), specificity(host)), host);
  for (const selector of [W('.pks-btn'), W('.pks-card'), W('.pks-level'), W('.pks-pick'), W('.pks-card-name')]) {
    assert.ok(beats(specificity(selector), specificity('.entry-content button')), selector);
    const d = declsAt(RULES, selector, 1280);
    for (const prop of ['font-family', 'line-height']) assert.ok(d[prop], selector + ' sets ' + prop);
  }
  for (const selector of [W('.pks-btn'), W('.pks-card'), W('.pks-level'), W('.pks-pick')]) {
    const d = declsAt(RULES, selector, 1280);
    for (const prop of ['text-transform', 'letter-spacing', 'box-shadow', 'margin', 'min-height']) assert.ok(d[prop] !== undefined, selector + ' sets ' + prop);
  }
  // Nothing outside the wrapper is styled.
  for (const rule of RULES) for (const selector of rule.selectors) assert.match(selector, /^\.pks-wrapper(\b|$)/);
});
