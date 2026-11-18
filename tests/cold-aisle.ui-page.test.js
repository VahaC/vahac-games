// tests/cold-aisle.ui-page.test.js
// The page of Cold Aisle: booted from the real index.html like a browser
// (main's two start-up branches) and as a module whose cdaInit runs on the
// same page (to reach the runtime), driven through its listeners with the
// animation frames run by the test: every screen and transition inside the
// one frame, a small test level won through real input (walk, a door, a
// rack rebooted by holding Use, the lift) and lost, each key and the mouse
// mapped to the sim's input, pointer lock granted, refused and missing,
// pauses (blur, hidden tab, lost lock, narrow window) that let go of held
// keys, the frame's scale on the page and in fullscreen, the HUD following
// the sim, results, upgrades, the end of the episode, the save (written,
// merged, blocked, full, newer), New game, mute and sensitivity, reduced
// motion, and the guide's numbers against the tables.
// The source and layout checks of the three shipped files are in
// tests/cold-aisle.ui-source.test.js.
//
// Levels are read from CDA_LEVELS (names, counts, kits) and never played
// here: anything played to an end is a small level object of this file,
// started through cdaRuntime().startLevel.  Numbers come from the tables.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, keyEvent, focusElement, setVisibility, listenerCount, readRepoFile, htmlPageSpec, makeEventTarget
} = require('./_setup');

const GAME = 'cold-aisle';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const cda = loadScript(SCRIPT);
const SAVE_KEY = 'cda-state';
const LEVELS = cda.CDA_LEVELS.length;
const STEP = cda.CDA_STEP;

test.beforeEach(() => resetStubs());

// ── helpers ────────────────────────────────────────────────────────────────

// A corridor: the start, a plain door, an infected rack at the east end and
// the lift south of the cell before it.
const TINY = { name: 'Test Room', briefing: 'A room for tests.', facing: 'E', map: ['#########', '#@.+...X#', '######L##', '#########'] };
// A crawler two cells ahead.
const TRAP = { name: 'Test Trap', briefing: 'A crawler.', facing: 'E', map: ['#######', '#@.s..#', '#######'] };
// An empty room (nothing to do; the lift opens at once).
const ROOM = { name: 'Test Hall', briefing: 'Empty.', facing: 'E', map: ['######', '#@...#', '#....#', '###L##'] };
const ARMED = () => ({ tools: ['driver', 'probe', 'degausser'], ammo: { cell: 50, coil: 10 }, health: 100, armour: 0 });

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
    frame(ms = 50) {
      now += ms;
      const batch = frames;
      frames = [];
      batch.forEach((frame) => frame.callback(now));
      return clock;
    },
    // Frames of `ms` for `seconds`.
    run(seconds, ms = 50) {
      for (let i = 0; i < Math.round(seconds * 1000 / ms); i++) clock.frame(ms);
      return clock;
    },
    pending: () => frames.length
  };
  return clock;
}

// A save as the storage part writes it, levels 1..n won with `patches` each.
function wonUpTo(n, patches = 5, over = {}) {
  const save = cda.cdaNewSave(LEVELS);
  for (let i = 0; i < n; i++) save.best[i] = { time: 100 + i, kills: 3, enemies: 4, secrets: 1, secretsTotal: 2, patches };
  save.unlocked = Math.min(LEVELS, n + 1);
  return Object.assign(save, over);
}

// What a player sees and does on a page.
function pageView(page, g) {
  const els = page.els;
  const canvas = els['cda-canvas'];
  const v = {
    page, els, g, canvas,
    rt: g ? g.cdaRuntime() : null,
    el: (n) => els['cda-' + n],
    text: (n) => els['cda-' + n].textContent,
    hidden: (n) => els['cda-' + n].classList.contains('cda-hidden'),
    click: (n) => els['cda-' + n].click(),
    $: (sel) => page.root.querySelector(sel),
    $$: (sel) => page.root.querySelectorAll(sel),
    level: (n) => page.root.querySelector('#cda-level-' + n),
    buy: (id) => page.root.querySelector('#cda-buy-' + id),
    // The screens that show (the HUD and the gate apart).
    shown: () => ['title-screen', 'select', 'briefing', 'pause', 'death', 'results', 'upgrades', 'end', 'help', 'confirm', 'gate']
      .filter((n) => !v.hidden(n)),
    down: (key, props) => pressKey(key, Object.assign({ target: canvas }, props)),
    up(key, props) {
      const e = keyEvent(key, Object.assign({ type: 'keyup' }, props));
      canvas.dispatchEvent(e);
      return e;
    },
    // A key held for `seconds` of frames.
    hold(key, seconds) {
      v.down(key);
      v.clock.run(seconds);
      v.up(key);
      return v;
    },
    // A key pressed for one frame of steps.
    tap(key) {
      return v.hold(key, 0.05);
    },
    // A key pressed on whatever has the focus in the frame (a button).
    menuKey: (key, props) => pressKey(key, Object.assign({ target: document.activeElement }, props)),
    save: () => JSON.parse(localStorage.getItem(SAVE_KEY)),
    sim: () => v.rt.sim,
    // Starts a level object and clicks into it.
    play(obj, carry, asLevel) {
      v.rt.startLevel(obj, carry, asLevel);
      v.click('gate-play');
      v.clock.frame(16);
      return v;
    }
  };
  return v;
}

function newPage(width) {
  const page = createPage(htmlPageSpec(HTML));
  page.els['cda-holder'].clientWidth = width;
  return page;
}

function store(save) {
  if (save !== undefined) localStorage.setItem(SAVE_KEY, typeof save === 'string' ? save : JSON.stringify(save));
}

// The script as a module, its cdaInit run on a page from index.html; v.rt
// is the live runtime.
function openModule(t, { save, width = 960 } = {}) {
  const clock = makeClock(t);
  store(save);
  const page = newPage(width);
  const loaded = loadWithPage(SCRIPT, page, { keep: true });
  loaded.exports.cdaInit();
  const v = pageView(page, loaded.exports);
  v.clock = clock;
  return v;
}

// The page as a browser loads it.
function openPage(t, { save, width = 960, options } = {}) {
  const clock = makeClock(t);
  store(save);
  const page = newPage(width);
  const v = pageView(page, null);
  const b = bootLikeBrowser(SCRIPT, page, options);
  v.ready = b.ready;
  v.clock = clock;
  return v;
}

// Pointer Lock that the browser grants (and gives back on exitPointerLock).
function grantLock(t, v) {
  v.canvas.requestPointerLock = () => {
    document.pointerLockElement = v.canvas;
    fire(document, 'pointerlockchange');
  };
  document.exitPointerLock = () => {
    document.pointerLockElement = null;
    fire(document, 'pointerlockchange');
  };
  t.after(() => {
    delete document.pointerLockElement;
    delete document.exitPointerLock;
  });
}

function viewport(t, w, h) {
  window.innerWidth = w;
  window.innerHeight = h;
  t.after(() => {
    delete window.innerWidth;
    delete window.innerHeight;
  });
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// The focus is on el (compared by identity: a failing deepEqual of two
// element stubs would print the whole page).
function focusIs(el, msg) {
  const at = document.activeElement;
  assert.ok(at === el, (msg || 'focus') + ': ' + (at && at.id) + ' instead of ' + (el && el.id));
}

// ── start-up ───────────────────────────────────────────────────────────────

test('cold-aisle page: loading the script under Node runs no init: no listener, frame or save', (t) => {
  const frames = t.mock.method(globalThis, 'requestAnimationFrame');
  createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.cdaInit, 'function');
  assert.equal(fresh.cdaRuntime().els, null);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(frames.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('cold-aisle page: in a browser with the document parsed, the title shows at once: New game only on a first visit, nothing written', (t) => {
  const v = openPage(t);
  assert.deepEqual(v.shown(), ['title-screen']);
  assert.equal(v.hidden('continue'), true, 'no progress: no Continue');
  focusIs(document.body, 'the page keeps its focus at load');
  assert.equal(v.hidden('hud'), true);
  assert.equal(v.hidden('warning'), true);
  assert.equal(v.$$('.cda-level').length, LEVELS);
  assert.equal(localStorage.length, 0);
  assert.equal(v.clock.pending(), 0, 'no loop on the title');
  assert.equal(listenerCount(v.canvas, 'keydown'), 1);
  assert.equal(listenerCount(document, 'pointerlockchange'), 1);
  assert.equal(listenerCount(window, 'blur'), 1);
});

test('cold-aisle page: while the document is still loading the page waits for DOMContentLoaded; cdaInit runs once', (t) => {
  const v = openPage(t, { save: wonUpTo(1), options: { readyState: 'loading' } });
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(v.$$('.cda-level').length, 0, 'nothing built yet');
  v.ready();
  assert.deepEqual(v.shown(), ['title-screen']);
  assert.equal(v.hidden('continue'), false, 'progress: Continue');
  focusIs(document.body, 'no focus moved at load');
  resetStubs();
  const m = openModule(t);
  m.g.cdaInit();
  assert.equal(m.$$('.cda-level').length, LEVELS, 'built once');
  assert.equal(listenerCount(m.canvas, 'keydown'), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
});

test('cold-aisle page: cdaRuntime exposes the screen, the sim, the save and startLevel', (t) => {
  const v = openModule(t);
  const rt = v.g.cdaRuntime();
  assert.equal(rt, v.g.CDA_RT);
  assert.equal(rt.screen, 'title');
  assert.equal(rt.sim, null);
  assert.equal(rt.save.v, cda.CDA_SAVE_V);
  assert.equal(typeof rt.startLevel, 'function');
  rt.startLevel(TINY);
  assert.equal(rt.screen, 'play');
  assert.equal(rt.sim.name, 'Test Room');
  assert.deepEqual(rt.sim.player.tools, ['driver'], 'the level\'s kit (none given: the driver)');
  rt.startLevel(TINY, ARMED());
  assert.deepEqual(rt.sim.player.tools, ['driver', 'probe', 'degausser']);
  assert.equal(rt.entry.index, -1);
});

// ── a whole level through real input ──────────────────────────────────────

test('cold-aisle page: a small level won through real input: walk, open a door, reboot the rack by holding Use, turn with the mouse, take the lift', (t) => {
  const v = openModule(t);
  grantLock(t, v);
  v.rt.startLevel(TINY, null, 0);
  assert.deepEqual(v.shown(), ['gate']);
  focusIs(document.body, 'nobody has used the frame yet: the focus stays');
  assert.equal(v.clock.pending(), 0, 'nothing runs behind the gate');
  assert.equal(v.hidden('hud'), false);
  assert.equal(v.text('racks'), '0/1');
  v.click('gate-play');
  assert.deepEqual(v.shown(), []);
  focusIs(v.canvas);
  assert.equal(v.rt.locked, true);
  assert.equal(v.clock.pending(), 1);
  const p = v.sim().player;
  v.hold('w', 1);
  assert.ok(p.x > 2.7 && p.x < 3, 'stopped at the closed door: ' + p.x);
  v.tap('e');
  v.clock.run(0.6);
  assert.equal(v.sim().doors[0].state, 'open');
  v.hold('ArrowUp', 1.5);
  assert.ok(p.x > 6.7, 'through the door, at the rack: ' + p.x);
  v.down('e');
  v.clock.run(0.75);
  assert.ok(v.sim().racks[0].progress > 0.3, 'the reboot runs while Use is held');
  v.clock.run(0.85);
  v.up('e');
  assert.equal(v.sim().racks[0].state, 'clean');
  assert.equal(v.text('racks'), '1/1');
  assert.equal(v.text('msg'), 'Lift unlocked');
  assert.equal(v.text('live'), 'Lift unlocked');
  // a quarter turn to the right with the mouse, at the saved sensitivity 1
  // (the first movement after the lock is dropped; one movement turns at most CDA_MOUSE_SPIKE px)
  fire(document, 'mousemove', { movementX: 999 });
  for (let i = 0; i < 4; i++) fire(document, 'mousemove', { movementX: (Math.PI / 8) / cda.CDA_MOUSE_BASE });
  v.clock.frame(50);
  assert.ok(near(p.angle, Math.PI / 2, 1e-6), 'facing the lift: ' + p.angle);
  v.tap('e');
  assert.equal(v.sim().status, 'won');
  assert.deepEqual(v.shown(), ['results']);
  assert.equal(v.rt.screen, 'results');
  assert.equal(document.pointerLockElement, null, 'the mouse is given back');
  assert.equal(v.text('results-title'), 'Floor cleared: Test Room');
  const items = v.el('results-list').children.map((li) => li.textContent);
  assert.match(items[0], /^Time 0:0\d \(best 0:0\d\)$/);
  assert.equal(items[1], 'Enemies destroyed 0 of 0');
  assert.equal(items[2], 'Secrets 0 of 0');
  assert.equal(items[3], 'Patches earned ' + cda.CDA_REWARDS.finish);
  const news = v.el('results-new').children.map((li) => li.textContent);
  assert.deepEqual(news, ['First clear of this floor.', '+' + cda.CDA_REWARDS.finish + ' patches to spend: you have ' + cda.CDA_REWARDS.finish + '.',
    'Level 2 is open: ' + cda.CDA_LEVELS[1].name + '.']);
  const saved = v.save();
  assert.equal(saved.unlocked, 2);
  assert.equal(saved.best[0].patches, cda.CDA_REWARDS.finish);
  assert.ok(saved.playTime > 3, 'the time played is saved: ' + saved.playTime);
  focusIs(v.el('next'));
  // Next: the briefing of level 2 with what this level handed on
  v.click('next');
  assert.deepEqual(v.shown(), ['briefing']);
  assert.equal(v.text('brief-name'), 'Level 2: ' + cda.CDA_LEVELS[1].name);
  assert.equal(v.text('brief-text'), cda.CDA_LEVELS[1].briefing);
  const carry = cda.cdaLevelCarry(1, v.rt.chain.carry);
  assert.equal(v.text('brief-kit'), cda.cdaKitText(carry) + '; ' + p.health + ' health, ' + p.armour + ' armour');
});

test('cold-aisle page: a level lost: the death screen names what did it, counts the death in the save; Retry restarts with the same carry, Levels leaves', (t) => {
  const v = openModule(t);
  v.play(TRAP, ARMED());
  v.sim().player.health = 1;
  v.sim().player.armour = 0;
  v.clock.run(4);
  assert.equal(v.sim().status, 'dead');
  assert.deepEqual(v.shown(), ['death']);
  assert.equal(v.text('death-text'), 'Taken offline by a floor scrubber.');
  assert.equal(v.text('death-count'), 'Deaths so far: 1.');
  assert.equal(v.save().deaths, 1);
  focusIs(v.el('retry'));
  const before = v.rt.carryIn;
  v.click('retry');
  assert.deepEqual(v.shown(), ['gate']);
  assert.equal(v.rt.carryIn, before);
  assert.deepEqual(v.sim().player.tools, ['driver', 'probe', 'degausser']);
  assert.equal(v.sim().player.health, 100, 'a fresh sim');
  v.click('gate-play');
  v.rt.sim.player.health = 1;
  v.clock.run(4);
  v.click('death-levels');
  assert.deepEqual(v.shown(), ['select']);
  assert.equal(v.save().deaths, 2);
});

test('cold-aisle page: the death line names a drone for a spark, the chiller for frost, and says something plain without a killer', () => {
  assert.equal(cda.cdaDeathLine('spark'), 'Taken offline by an inventory drone.');
  assert.equal(cda.cdaDeathLine('bolt'), 'Taken offline by a camera turret.');
  assert.equal(cda.cdaDeathLine('frost'), 'Taken offline by the chiller.');
  assert.equal(cda.cdaDeathLine('loader'), 'Taken offline by a pallet loader.');
  assert.equal(cda.cdaDeathLine(''), 'The night shift ends here for now.');
});

// ── keys and the mouse ─────────────────────────────────────────────────────

test('cold-aisle page: every key of the spec\'s table is the input the sim receives; Ctrl, Alt and Meta combinations are not the game\'s', (t) => {
  const v = openModule(t);
  v.play(ROOM, ARMED());
  const read = () => v.g.cdaReadInput();
  const turn = cda.CDA_PLAYER.turn * STEP;
  const cases = [
    ['w', { move: 1 }], ['ArrowUp', { move: 1 }], ['s', { move: -1 }], ['ArrowDown', { move: -1 }],
    ['a', { strafe: -1 }], ['d', { strafe: 1 }], ['ArrowLeft', { turn: -turn }], ['ArrowRight', { turn: turn }],
    ['j', { fire: true }], ['Enter', { fire: true }], ['e', { use: true }], [' ', { use: true }]
  ];
  for (const [key, want] of cases) {
    const ev = v.down(key);
    assert.equal(ev.defaultPrevented, true, key + ' is the game\'s');
    assert.deepEqual(read(), Object.assign({ move: 0, strafe: 0, turn: 0, fire: false, use: false, weapon: 0 }, want), key);
    v.up(key);
    assert.deepEqual(read(), { move: 0, strafe: 0, turn: 0, fire: false, use: false, weapon: 0 }, key + ' let go');
  }
  // the physical key on another layout
  v.down('ц', { code: 'KeyW' });
  assert.equal(read().move, 1);
  v.up('ц', { code: 'KeyW' });
  // W and A together, S and W cancel
  v.down('w');
  v.down('a');
  assert.deepEqual(read(), { move: 1, strafe: -1, turn: 0, fire: false, use: false, weapon: 0 });
  v.down('s');
  assert.equal(read().move, 0);
  v.up('w');
  v.up('a');
  v.up('s');
  // 1-3 ask for a tool once
  for (const n of [1, 2, 3]) {
    v.down(String(n));
    assert.equal(read().weapon, n);
    assert.equal(read().weapon, 0, 'consumed by the step that reads it');
  }
  v.down('ä', { code: 'Digit2' });
  assert.equal(read().weapon, 2);
  // Ctrl+W, Alt and Meta, an autofill keydown, composing: not the game's
  for (const props of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    const ev = v.down('w', props);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(read().move, 0);
  }
  assert.equal(v.down(undefined).defaultPrevented, false);
  assert.equal(v.down('x').defaultPrevented, false, 'a key the game does not use');
  const handled = keyEvent('w');
  handled.preventDefault();
  v.canvas.dispatchEvent(handled);
  assert.equal(read().move, 0, 'a key someone else handled');
  // a repeat of a command does nothing more; a held key's repeat keeps it down
  v.down('Tab');
  assert.equal(v.rt.map, true, 'Tab shows the map');
  v.down('Tab', { repeat: true });
  assert.equal(v.rt.map, true);
  v.down('Tab');
  assert.equal(v.rt.map, false, 'and hides it');
  v.down('w', { repeat: true });
  assert.equal(read().move, 1);
  v.up('w');
  const up = v.up('x');
  assert.equal(up.defaultPrevented, false);
});

test('cold-aisle page: the keyboard turns at the table\'s rate; held keys move the player in the sim; Tab draws the automap', (t) => {
  const v = openModule(t);
  v.play(ROOM, ARMED());
  const p = v.sim().player;
  const a0 = p.angle;
  const ticks0 = v.sim().tick;
  v.down('ArrowRight');
  v.clock.run(0.5);
  v.up('ArrowRight');
  const steps = v.sim().tick - ticks0;
  assert.ok(near(p.angle - a0, steps * cda.CDA_PLAYER.turn * STEP, 1e-9));
  const plain = Array.from(v.rt.pixels);
  v.down('Tab');
  v.clock.frame(50);
  assert.equal(v.rt.map, true);
  assert.notDeepEqual(Array.from(v.rt.pixels), plain, 'the automap is drawn over the view');
  const mapped = Array.from(v.rt.pixels);
  v.down('Tab');
  v.clock.frame(50);
  assert.notDeepEqual(Array.from(v.rt.pixels), mapped);
});

test('cold-aisle page: the mouse: the left button fires while it is held, the wheel switches tools both ways, movement turns by the sensitivity', (t) => {
  const v = openModule(t);
  grantLock(t, v);
  v.play(ROOM, ARMED());
  const read = () => v.g.cdaReadInput();
  fire(v.canvas, 'mousedown', { button: 0 });
  assert.equal(read().fire, true);
  fire(document, 'mouseup', { button: 2 });
  assert.equal(read().fire, true, 'another button let go');
  fire(document, 'mouseup', { button: 0 });
  assert.equal(read().fire, false);
  const right = fire(v.canvas, 'mousedown', { button: 2 });
  assert.equal(right.defaultPrevented, false);
  assert.equal(read().fire, false);
  // the tool in hand is the degausser (the last carried): the wheel goes round
  assert.equal(v.sim().player.tool, 'degausser');
  const wheel = fire(v.canvas, 'wheel', { deltaY: 100 });
  assert.equal(wheel.defaultPrevented, true);
  assert.equal(read().weapon, 1, 'next after 3: 1');
  fire(v.canvas, 'wheel', { deltaY: -100 });
  assert.equal(read().weapon, 2, 'previous before 3: 2');
  fire(v.canvas, 'wheel', { deltaY: 0 });
  assert.equal(read().weapon, 0);
  fire(v.canvas, 'wheel', { deltaY: 100 });
  v.clock.run(0.5);
  assert.equal(v.sim().player.tool, 'driver');
  // movement at sensitivity 2
  v.rt.save.settings.sens = 2;
  fire(document, 'mousemove', { movementX: 900 });
  assert.equal(read().turn, 0, 'the first movement after the lock changed is dropped');
  fire(document, 'mousemove', { movementX: 100 });
  fire(document, 'mousemove', {});
  assert.ok(near(read().turn, 100 * cda.CDA_MOUSE_BASE * 2));
  assert.equal(read().turn, 0, 'consumed by one step');
  assert.equal(cda.cdaNextSlot({ tools: ['driver'], tool: 'driver' }, 1), 1);
  assert.equal(cda.cdaNextSlot({ tools: ['driver', 'probe'], tool: 'driver' }, -1), 2);
});

test('cold-aisle page: outside a running level the mouse and the wheel do nothing; the mouse turns only with the lock', (t) => {
  const v = openModule(t);
  v.rt.startLevel(ROOM, ARMED());
  const down = fire(v.canvas, 'mousedown', { button: 0 });
  assert.equal(down.defaultPrevented, false);
  assert.equal(fire(v.canvas, 'wheel', { deltaY: 100 }).defaultPrevented, false);
  fire(document, 'mousemove', { movementX: 50 });
  assert.deepEqual(v.g.cdaReadInput(), { move: 0, strafe: 0, turn: 0, fire: false, use: false, weapon: 0 });
});

// ── pointer lock ───────────────────────────────────────────────────────────

test('cold-aisle page: pointer lock granted: Click to play asks for it; a click on the view without it asks again and does not fire; losing it pauses', (t) => {
  const v = openModule(t);
  let asked = 0;
  grantLock(t, v);
  const grant = v.canvas.requestPointerLock;
  v.canvas.requestPointerLock = () => {
    asked++;
    grant();
  };
  v.play(ROOM, ARMED());
  assert.equal(asked, 1);
  assert.equal(v.rt.locked, true);
  assert.equal(v.text('msg'), '', 'nothing to say');
  // the browser takes it away (its Esc): the level pauses
  v.down('w');
  document.pointerLockElement = null;
  fire(document, 'pointerlockchange');
  assert.deepEqual(v.shown(), ['pause']);
  assert.deepEqual(v.rt.keys, {}, 'held keys let go');
  fire(document, 'pointerlockchange');
  assert.deepEqual(v.shown(), ['pause'], 'a change that was no loss');
  // Esc on the pause screen resumes without asking (no user gesture to a
  // browser); a click on the view asks then
  v.menuKey('Escape');
  assert.deepEqual(v.shown(), []);
  assert.equal(asked, 1);
  assert.equal(v.rt.locked, false);
  fire(v.canvas, 'mousedown', { button: 0 });
  assert.equal(asked, 2);
  assert.equal(v.rt.locked, true);
  v.down('p');
  // Resume asks again
  v.click('resume');
  assert.equal(asked, 3);
  assert.deepEqual(v.shown(), []);
  // lost while running without a pause (another change): the view asks on a click
  v.canvas.requestPointerLock = () => { asked++; };
  v.rt.locked = false;
  const down = fire(v.canvas, 'mousedown', { button: 0 });
  assert.equal(asked, 4);
  assert.equal(down.defaultPrevented, true);
  assert.equal(v.g.cdaReadInput().fire, false, 'that click does not fire');
  // a browser without exitPointerLock keeps the lock over the pause screen:
  // Resume then asks for nothing
  delete document.exitPointerLock;
  v.rt.locked = true;
  v.down('p');
  assert.equal(v.rt.locked, true);
  v.click('resume');
  assert.equal(asked, 4);
});

test('cold-aisle page: pointer lock refused (an error event, a rejected promise, a throw): the game plays on the keyboard and says so once; the mouse button fires', async (t) => {
  const v = openModule(t);
  v.canvas.requestPointerLock = () => { fire(document, 'pointerlockerror'); };
  v.play(ROOM, ARMED());
  assert.equal(v.rt.lockRefused, true);
  assert.equal(v.text('msg'), cda.CDA_UI.lockRefused);
  assert.equal(v.text('live'), cda.CDA_UI.lockRefused);
  assert.deepEqual(v.shown(), [], 'the level runs');
  fire(v.canvas, 'mousedown', { button: 0 });
  assert.equal(v.g.cdaReadInput().fire, true, 'the left button fires without the lock');
  fire(document, 'mouseup', { button: 0 });
  v.clock.run(4);
  assert.equal(v.text('msg'), '', 'the line goes after its time');
  // a rejected promise: said no more
  v.down('p');
  v.canvas.requestPointerLock = () => Promise.reject(new Error('no'));
  v.click('resume');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(v.rt.lockRefused, true);
  assert.equal(v.text('msg'), '', 'said once a page load');
  // a request that throws
  v.down('p');
  v.rt.lockRefused = false;
  v.canvas.requestPointerLock = () => { throw new Error('no'); };
  v.click('resume');
  assert.equal(v.rt.lockRefused, true);
  // an error event while the lock is held changes nothing
  v.rt.locked = true;
  v.rt.lockRefused = false;
  fire(document, 'pointerlockerror');
  assert.equal(v.rt.lockRefused, false);
  // a promise that resolves is fine
  v.rt.locked = false;
  v.down('p');
  v.canvas.requestPointerLock = () => Promise.resolve();
  v.click('resume');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(v.rt.lockRefused, false);
});

test('cold-aisle page: without Pointer Lock the game plays on the keyboard alone, says so once, and the left button fires', (t) => {
  const v = openModule(t);
  assert.equal(v.canvas.requestPointerLock, undefined);
  v.play(ROOM, ARMED());
  assert.equal(v.text('msg'), cda.CDA_UI.noLock);
  fire(v.canvas, 'mousedown', { button: 0 });
  assert.equal(v.g.cdaReadInput().fire, true);
  v.down('p');
  v.click('resume');
  v.clock.run(4);
  assert.equal(v.text('msg'), '', 'not said again');
  assert.deepEqual(v.shown(), []);
  // leaving a level without a lock calls nothing
  v.down('Escape');
  assert.deepEqual(v.shown(), ['pause']);
});

// ── pauses ─────────────────────────────────────────────────────────────────

test('cold-aisle page: the window losing the focus, the canvas losing it and a hidden tab pause and let go of held keys; a pause stops the loop and saves the time played', (t) => {
  const v = openModule(t);
  v.play(ROOM, ARMED());
  v.down('w');
  v.down('j');
  fire(v.canvas, 'mousedown', { button: 0 });
  v.clock.run(0.5);
  fire(window, 'blur');
  assert.deepEqual(v.shown(), ['pause']);
  assert.deepEqual(v.rt.keys, {});
  assert.equal(v.rt.mouseFire, false);
  assert.equal(v.clock.pending(), 0, 'the loop stops');
  assert.ok(v.save().playTime >= 0.5 - 1e-9, 'the time played is saved: ' + v.save().playTime);
  focusIs(v.el('resume'));
  const x = v.sim().player.x;
  v.clock.run(1);
  assert.equal(v.sim().player.x, x, 'nothing moves while paused');
  v.click('resume');
  assert.equal(v.clock.pending(), 1);
  // the canvas losing the focus (a click elsewhere on the page)
  v.down('w');
  focusElement(document.body);
  focusElement(v.el('select-back'));
  assert.deepEqual(v.shown(), ['pause']);
  assert.deepEqual(v.rt.keys, {});
  v.click('resume');
  // a hidden tab
  v.down('d');
  setVisibility('hidden', t);
  assert.deepEqual(v.shown(), ['pause']);
  assert.deepEqual(v.rt.keys, {});
  setVisibility('visible', t);
  assert.deepEqual(v.shown(), ['pause'], 'shown again it waits for Resume');
  assert.equal(v.clock.pending(), 0);
  v.click('resume');
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.deepEqual(v.shown(), ['pause']);
  // the focus coming back to the canvas is recorded
  focusElement(v.canvas);
  assert.equal(v.rt.focused, true);
});

test('cold-aisle page: P and Esc pause from the canvas; on the pause screen P and Esc resume, the gate pauses on Esc; a blur on the gate or a menu changes nothing', (t) => {
  const v = openModule(t);
  v.rt.startLevel(ROOM, ARMED());
  fire(window, 'blur');
  assert.deepEqual(v.shown(), ['gate'], 'behind the gate nothing runs to pause');
  focusElement(v.el('gate-play'), { keyboard: true });
  const esc = v.menuKey('Escape');
  assert.equal(esc.defaultPrevented, true);
  assert.deepEqual(v.shown(), ['pause'], 'Esc on the gate pauses');
  v.menuKey('p');
  assert.deepEqual(v.shown(), []);
  v.down('p');
  assert.deepEqual(v.shown(), ['pause']);
  v.menuKey('Escape');
  assert.deepEqual(v.shown(), []);
  v.down('Escape');
  assert.deepEqual(v.shown(), ['pause']);
  v.down('p', { repeat: true });
  v.menuKey('p', { repeat: true });
  assert.deepEqual(v.shown(), ['pause'], 'a repeat does nothing');
  // P is no key on the menus
  v.click('pause-levels');
  v.click('confirm-yes');
  assert.deepEqual(v.shown(), ['select']);
  assert.equal(v.menuKey('p').defaultPrevented, false);
  assert.equal(v.menuKey('x').defaultPrevented, false);
  fire(window, 'blur');
  assert.deepEqual(v.shown(), ['select']);
  // P on the canvas off the level does nothing
  v.down('p');
  assert.deepEqual(v.shown(), ['select']);
});

test('cold-aisle page: a window narrower than 720 px pauses a running level; widening it shows the game again, paused', (t) => {
  const v = openModule(t);
  viewport(t, 1280, 800);
  fire(window, 'resize');
  v.play(ROOM, ARMED());
  window.innerWidth = 719;
  fire(window, 'resize');
  assert.equal(v.rt.narrow, true);
  assert.deepEqual(v.shown(), ['pause']);
  assert.equal(v.clock.pending(), 0);
  window.innerWidth = 720;
  fire(window, 'resize');
  assert.equal(v.rt.narrow, false);
  assert.deepEqual(v.shown(), ['pause']);
  v.click('resume');
  assert.equal(v.clock.pending(), 1);
  window.innerWidth = 320;
  fire(window, 'resize');
  assert.deepEqual(v.shown(), ['pause']);
});

// ── the frame ──────────────────────────────────────────────────────────────

test('cold-aisle page: the stage fills the frame\'s parent\'s width, snapping to a whole factor that covers 96 % of it, with no upper cap; --cda-scale is the width / 320', (t) => {
  const v = openModule(t, { width: 1000 });
  const stage = v.el('stage');
  const size = () => [stage.style.width, stage.style.height, stage.style['--cda-scale']];
  assert.deepEqual(size(), ['960px', '540px', '3'], '1000 px: 3x is 96 %');
  assert.equal(cda.CDA_SNAP, 0.96);
  for (const [width, want] of [[966, ['960px', '540px', '3']], [960, ['960px', '540px', '3']],
    [958, ['958px', '538px', String(958 / 320)]], [900, ['900px', '506px', String(900 / 320)]], [680, ['680px', '382px', String(680 / 320)]],
    [640, ['640px', '360px', '2']], [639, ['639px', '359px', String(639 / 320)]], [320, ['320px', '180px', '1']],
    [300, ['300px', '168px', String(300 / 320)]], [1280, ['1280px', '720px', '4']], [1300, ['1280px', '720px', '4']],
    [1400, ['1400px', '787px', String(1400 / 320)]], [2000, ['1920px', '1080px', '6']], [2100, ['2100px', '1181px', String(2100 / 320)]]]) {
    v.el('holder').clientWidth = width;
    fire(window, 'resize');
    assert.deepEqual(size(), want, width + ' px');
  }
  v.el('holder').clientWidth = 966;
  fire(window, 'resize');
  v.el('holder').clientWidth = 0;
  fire(window, 'resize');
  assert.deepEqual(size(), ['960px', '540px', '3'], 'not laid out: kept');
  assert.equal(cda.cdaPageScale(0), 1);
  assert.equal(cda.cdaPageScale(NaN), 1);
  assert.equal(cda.cdaFullScale(0, 0), 1);
});

test('cold-aisle page: with a ResizeObserver the frame follows its parent\'s width without a window resize', (t) => {
  let observed = null;
  let callback = null;
  window.ResizeObserver = function (fn) {
    callback = fn;
    this.observe = (el) => { observed = el; };
  };
  t.after(() => delete window.ResizeObserver);
  const v = openModule(t, { width: 960 });
  assert.equal(observed, v.el('holder'));
  v.el('holder').clientWidth = 700;
  callback();
  assert.equal(v.el('stage').style.width, '700px');
});

test('cold-aisle page: F asks for fullscreen on the frame and leaves it; in fullscreen the stage is the largest 16:9 that fits (a whole factor when it covers 96 %), centred on black', (t) => {
  const v = openModule(t);
  viewport(t, 1920, 1080);
  const frame = v.el('frame');
  let requested = 0;
  let exited = 0;
  frame.requestFullscreen = () => {
    requested++;
    document.fullscreenElement = frame;
    fire(document, 'fullscreenchange');
    return Promise.resolve();
  };
  document.exitFullscreen = () => {
    exited++;
    document.fullscreenElement = null;
    fire(document, 'fullscreenchange');
    return Promise.reject(new Error('quiet'));
  };
  t.after(() => {
    delete document.fullscreenElement;
    delete document.exitFullscreen;
  });
  v.play(ROOM, ARMED());
  v.down('f');
  assert.equal(requested, 1);
  assert.equal(v.rt.mode, 'full');
  assert.equal(frame.classList.contains('cda-frame--full'), true);
  assert.deepEqual([v.el('stage').style.width, v.el('stage').style.height, v.el('stage').style['--cda-scale']], ['1920px', '1080px', '6']);
  window.innerWidth = 2560;
  window.innerHeight = 1080;
  fire(window, 'resize');
  assert.deepEqual([v.el('stage').style.width, v.el('stage').style.height], ['1920px', '1080px'], 'limited by the height');
  window.innerWidth = 1366;
  window.innerHeight = 768;
  fire(window, 'resize');
  assert.deepEqual([v.el('stage').style.width, v.el('stage').style.height], ['1365px', '768px'], '4x is only 94 %: the fit');
  window.innerWidth = 1300;
  window.innerHeight = 1000;
  fire(window, 'resize');
  assert.deepEqual([v.el('stage').style.width, v.el('stage').style.height], ['1280px', '720px'], '4x is 98 %: snapped');
  window.innerWidth = 300;
  window.innerHeight = 150;
  fire(window, 'resize');
  assert.equal(v.el('stage').style['--cda-scale'], String(266 / 320), 'below 1x: the fit, the width whole pixels');
  assert.deepEqual(v.shown(), ['pause'], 'a 300 px screen is narrow');
  v.menuKey('f');
  assert.equal(exited, 1);
  assert.equal(v.rt.mode, 'page');
  assert.equal(v.el('stage').style.width, '960px');
  // F from a menu button; without the API nothing happens
  delete frame.requestFullscreen;
  v.menuKey('f');
  assert.equal(v.rt.mode, 'page');
  document.fullscreenElement = frame;
  delete document.exitFullscreen;
  v.menuKey('f');
  assert.equal(exited, 1);
});

// ── the HUD ────────────────────────────────────────────────────────────────

test('cold-aisle page: the HUD follows the sim: health, armour, the tool and its ammo with its icon, badges, racks, and low health is obvious', (t) => {
  const v = openModule(t);
  v.play(TINY, { tools: ['driver', 'probe'], ammo: { cell: 30, coil: 0 }, health: 100, armour: 0 });
  const p = v.sim().player;
  assert.equal(v.text('health'), '100');
  assert.equal(v.text('armour'), '0');
  assert.equal(v.text('tool'), 'Tone probe');
  assert.equal(v.text('ammo'), '30');
  assert.equal(v.hidden('ammo-icon'), false);
  assert.equal(v.text('badges'), 'No badges');
  assert.equal(v.text('racks'), '0/1');
  p.armour = 50;
  p.ammo.cell = 12;
  p.badges.blue = true;
  p.badges.red = true;
  v.clock.frame(50);
  assert.equal(v.text('armour'), '50');
  assert.equal(v.text('ammo'), '12');
  assert.equal(v.el('badge-blue').classList.contains('cda-badge--off'), false);
  assert.equal(v.el('badge-yellow').classList.contains('cda-badge--off'), true);
  assert.equal(v.text('badges'), 'Badges: blue, red');
  v.down('1');
  v.clock.run(0.5);
  assert.equal(v.text('tool'), 'Screwdriver');
  assert.equal(v.text('ammo'), '–');
  assert.equal(v.hidden('ammo-icon'), true);
  // low health
  const limit = p.maxHealth * v.g.CDA_LOW_SHARE;
  p.health = limit;
  v.clock.frame(50);
  assert.equal(v.el('hud').classList.contains('cda-hud--low'), true);
  assert.equal(v.el('stage').classList.contains('cda-stage--low'), true);
  assert.equal(v.text('live'), 'Health low: ' + Math.ceil(limit));
  p.health = limit + 1;
  v.clock.frame(50);
  assert.equal(v.el('hud').classList.contains('cda-hud--low'), false);
  p.health = 5;
  v.clock.frame(50);
  assert.equal(v.el('stage').classList.contains('cda-stage--low'), true);
  // a restart clears it
  v.down('p');
  v.click('restart');
  assert.equal(v.el('stage').classList.contains('cda-stage--low'), false);
  assert.equal(v.el('hud').classList.contains('cda-hud--low'), false);
  // the HUD's icons are the game's own sprites
  for (const id of ['health-icon', 'armour-icon', 'badge-blue', 'badge-yellow', 'badge-red', 'racks-icon', 'ammo-icon']) {
    assert.deepEqual([v.el(id).width, v.el(id).height], [8, 8], id);
  }
});

test('cold-aisle page: the message line takes the sim\'s lines (a pickup, a locked door, the locked lift), mirrors them in the live region and clears after its time', (t) => {
  const v = openModule(t);
  const LOCKED = { name: 'Test Locks', briefing: 'x', facing: 'E', map: ['#######', '#@c.b.#', '###L###', '#######'] };
  v.play(LOCKED, ARMED());
  v.hold('w', 0.4);
  assert.equal(v.text('msg'), cda.CDA_ITEM.cell.name);
  assert.equal(v.text('live'), cda.CDA_ITEM.cell.name);
  v.hold('w', 1);
  v.tap('e');
  assert.equal(v.text('msg'), cda.cdaText('locked', { item: cda.CDA_ITEM['key-blue'].name }));
  v.clock.run(cda.CDA_MSG_TIME + 0.2);
  assert.equal(v.text('msg'), '');
  assert.equal(v.text('live'), cda.cdaText('locked', { item: cda.CDA_ITEM['key-blue'].name }), 'the live region keeps the last line');
});

test('cold-aisle page: reduced motion takes the weapon bob and the pickup flash out of the view and shortens the damage flash; the CSS stops its animations', (t) => {
  const saved = window.matchMedia;
  window.matchMedia = (q) => ({ matches: /prefers-reduced-motion: reduce/.test(q) });
  t.after(() => { window.matchMedia = saved; });
  const v = openModule(t);
  assert.equal(v.rt.reduced, true);
  v.play(TRAP, ARMED());
  v.down('w');
  v.clock.run(0.4);
  assert.equal(v.rt.view.bobAmp, 0);
  v.clock.run(2);
  assert.ok(v.rt.view.hurt <= cda.cdaSteps(0.08));
  window.matchMedia = undefined;
  resetStubs();
  const w = openModule(t);
  assert.equal(w.rt.reduced, false);
  w.play(ROOM, ARMED());
  w.down('w');
  w.clock.run(0.4);
  assert.ok(w.rt.view.bobAmp > 0, 'without the preference the bob is there');
});

// ── screens ────────────────────────────────────────────────────────────────

test('cold-aisle page: the level select: every level by name, the locked ones locked, each won one with its best time, enemies and secrets; the balance; Esc goes back', (t) => {
  const save = wonUpTo(2, 4);
  save.best[1].time = null;
  const v = openModule(t, { save });
  v.click('continue');
  assert.deepEqual(v.shown(), ['select']);
  focusIs(v.level(3), 'the highest open level');
  for (let n = 1; n <= LEVELS; n++) {
    const b = v.level(n);
    assert.equal(b.children[0].textContent, n + '. ' + cda.CDA_LEVELS[n - 1].name);
    assert.equal(b.disabled, n > 3, 'level ' + n);
    assert.equal(b.classList.contains('cda-level--locked'), n > 3);
  }
  assert.equal(v.level(1).children[1].textContent, 'Best 1:40 · enemies 3/4 · secrets 1/2');
  assert.equal(v.level(2).children[1].textContent, 'Best – · enemies 3/4 · secrets 1/2', 'an unreadable time is a dash');
  assert.equal(v.level(3).children[1].textContent, cda.CDA_UI.notWon);
  assert.equal(v.level(4).children[1].textContent, cda.CDA_UI.locked);
  assert.equal(v.level(1).getAttribute('aria-label'), 'Level 1, ' + cda.CDA_LEVELS[0].name + ': Best 1:40 · enemies 3/4 · secrets 1/2');
  assert.equal(v.text('balance'), '8');
  v.menuKey('Escape');
  assert.deepEqual(v.shown(), ['title-screen']);
  v.click('continue');
  v.level(2).click();
  assert.deepEqual(v.shown(), ['briefing']);
  assert.equal(v.text('brief-kit'), cda.cdaKitText(cda.cdaLevelCarry(1, null)), 'no chain: the kit');
  v.menuKey('Escape');
  assert.deepEqual(v.shown(), ['select']);
  v.click('select-back');
  assert.deepEqual(v.shown(), ['title-screen']);
  const all = openModule(t, { save: wonUpTo(LEVELS) });
  all.click('continue');
  focusIs(all.level(LEVELS), 'every level open: the last');
});

test('cold-aisle page: the briefing starts its level from CDA_LEVELS with the level\'s carry and the bought upgrades', (t) => {
  const v = openModule(t, { save: wonUpTo(3, 10, { upgrades: { health: 1 } }) });
  v.click('continue');
  v.level(3).click();
  assert.equal(v.text('brief-name'), 'Level 3: ' + cda.CDA_LEVELS[2].name);
  v.click('brief-start');
  assert.deepEqual(v.shown(), ['gate']);
  assert.equal(v.rt.entry.obj, v.g.CDA_LEVELS[2]);
  assert.equal(v.rt.entry.index, 2);
  assert.deepEqual(v.rt.carryIn, cda.cdaLevelCarry(2, null));
  assert.equal(v.sim().name, cda.CDA_LEVELS[2].name);
  assert.equal(v.sim().player.maxHealth, cda.CDA_PLAYER.health + cda.CDA_UPGRADE.health.step);
  assert.equal(v.rt.tries, 1);
  assert.equal(v.sim().rng, v.g.CDA_SEED, 'the seed counts the starts');
});

test('cold-aisle page: the carry: a win hands its state to the next level only; starting another level drops it', (t) => {
  const v = openModule(t, { save: wonUpTo(3) });
  v.play(ROOM, ARMED(), 1);
  v.down('s');
  v.clock.frame(50);
  v.up('s');
  // win at once: the lift is open in an empty room
  v.sim().status = 'won';
  v.clock.frame(50);
  assert.deepEqual(v.shown(), ['results']);
  assert.equal(v.rt.chain.level, 2);
  assert.deepEqual(v.rt.chain.carry.tools, ['driver', 'probe', 'degausser']);
  v.click('next');
  assert.equal(v.text('brief-name'), 'Level 3: ' + cda.CDA_LEVELS[2].name);
  v.click('brief-start');
  assert.deepEqual(v.rt.carryIn, cda.cdaLevelCarry(2, v.rt.chain.carry));
  assert.deepEqual(v.rt.carryIn.tools.slice(0, 3), ['driver', 'probe', 'degausser']);
  v.down('p');
  v.click('pause-levels');
  v.click('confirm-yes');
  v.level(1).click();
  v.click('brief-start');
  assert.equal(v.rt.chain, null, 'another level drops it');
  assert.deepEqual(v.rt.carryIn, cda.cdaLevelCarry(0, null));
});

test('cold-aisle page: pause: Restart level, Help over it, Levels with a "leave this level?" question; No goes back to the pause screen', (t) => {
  const v = openModule(t);
  v.play(ROOM, ARMED());
  v.hold('w', 0.3);
  v.down('p');
  const sim = v.sim();
  v.click('restart');
  assert.notEqual(v.sim(), sim, 'a new sim');
  assert.deepEqual(v.shown(), ['gate']);
  v.click('gate-play');
  v.down('p');
  v.click('pause-help');
  assert.deepEqual(v.shown(), ['pause', 'help']);
  focusIs(v.el('help-close'));
  v.menuKey('Escape');
  assert.deepEqual(v.shown(), ['pause']);
  focusIs(v.el('pause-help'));
  v.click('pause-levels');
  assert.deepEqual(v.shown(), ['pause', 'confirm']);
  assert.equal(v.text('confirm-text'), cda.CDA_UI.leave);
  assert.equal(v.text('confirm-yes'), 'Leave');
  focusIs(v.el('confirm-no'));
  v.click('confirm-no');
  assert.deepEqual(v.shown(), ['pause']);
  focusIs(v.el('pause-levels'));
  v.click('pause-levels');
  v.menuKey('Escape');
  assert.deepEqual(v.shown(), ['pause'], 'Esc is No');
  v.click('pause-levels');
  v.click('confirm-yes');
  assert.deepEqual(v.shown(), ['select']);
  assert.equal(v.hidden('hud'), true);
});

test('cold-aisle page: the title\'s Help is an overlay in the frame; Close and Esc give the focus back', (t) => {
  const v = openModule(t);
  v.click('help-open');
  assert.deepEqual(v.shown(), ['title-screen', 'help']);
  v.click('help-close');
  assert.deepEqual(v.shown(), ['title-screen']);
  focusIs(v.el('help-open'));
  assert.equal(v.menuKey('Escape').defaultPrevented, false, 'Esc on the title has nowhere to go');
});

test('cold-aisle page: New game: at once without progress; with progress a question that names what it erases; No keeps it, Yes erases it but keeps the settings', (t) => {
  const fresh = openModule(t);
  fresh.click('new');
  assert.deepEqual(fresh.shown(), ['briefing']);
  assert.equal(fresh.text('brief-name'), 'Level 1: ' + cda.CDA_LEVELS[0].name);
  resetStubs();
  const v = openModule(t, { save: wonUpTo(2, 5, { deaths: 3, playTime: 75, settings: { sens: 2, mute: true }, upgrades: { health: 1 } }) });
  v.click('new');
  assert.deepEqual(v.shown(), ['title-screen', 'confirm']);
  assert.equal(v.text('confirm-text'), cda.CDA_UI.newGame + '2 of ' + LEVELS + ' floors cleared, 10 patches earned, 3 deaths, 1:15 played.');
  assert.equal(v.text('confirm-yes'), 'Erase and start');
  v.click('confirm-no');
  assert.deepEqual(v.shown(), ['title-screen']);
  focusIs(v.el('new'));
  assert.equal(v.save().unlocked, 3);
  v.click('new');
  v.click('confirm-yes');
  assert.deepEqual(v.shown(), ['briefing']);
  const saved = v.save();
  assert.equal(saved.unlocked, 1);
  assert.deepEqual(saved.best, new Array(LEVELS).fill(null));
  assert.deepEqual(saved.upgrades, {});
  assert.equal(saved.deaths, 0);
  assert.deepEqual(saved.settings, { sens: 2, mute: true });
  v.menuKey('Escape');
  v.menuKey('Escape');
  assert.equal(v.hidden('continue'), true, 'nothing left to continue');
});

test('cold-aisle page: results of a level outside the episode record nothing and offer no Next', (t) => {
  const v = openModule(t);
  v.play(ROOM, ARMED());
  v.sim().status = 'won';
  v.clock.frame(50);
  assert.deepEqual(v.shown(), ['results']);
  assert.equal(v.hidden('next'), true);
  assert.deepEqual(v.el('results-new').children.map((li) => li.textContent), ['A level outside the episode: nothing is recorded.']);
  assert.equal(v.el('results-list').children[0].textContent.indexOf('best'), -1);
  focusIs(v.el('results-upgrades'));
  assert.equal(v.rt.chain, null);
  assert.equal(v.save().unlocked, 1);
  v.click('results-levels');
  assert.deepEqual(v.shown(), ['select']);
});

test('cold-aisle page: a replayed level: a new best time is named; no new patches when an earlier win earned as many', (t) => {
  const save = wonUpTo(2, 50);
  save.best[0].time = 1000;
  const v = openModule(t, { save });
  v.play(ROOM, ARMED(), 0);
  v.clock.run(0.2);
  v.sim().status = 'won';
  v.clock.frame(50);
  assert.deepEqual(v.el('results-new').children.map((li) => li.textContent),
    ['New best time.', 'No new patches: an earlier run here earned as many.']);
  resetStubs();
  const w = openModule(t, { save: wonUpTo(2, 50) });
  w.play(ROOM, ARMED(), 0);
  w.sim().tick = 100000;
  w.sim().status = 'won';
  w.clock.frame(50);
  assert.deepEqual(w.el('results-new').children.map((li) => li.textContent), ['No new patches: an earlier run here earned as many.']);
});

test('cold-aisle page: upgrades: the six lines with tier, effect and cost; Buy spends patches and saves; what cannot be bought is disabled with the reason', (t) => {
  const v = openModule(t, { save: wonUpTo(1, 9, { upgrades: { rays: 3 } }) });
  // 9 earned; rays 3 tiers cost 16 > 9: the repair drops tiers it cannot pay
  assert.ok(cda.cdaPatchesSpent(v.rt.save) <= 9);
  v.rt.save.best[1] = { time: 100, kills: 0, enemies: 0, secrets: 0, secretsTotal: 0, patches: 20 };
  v.rt.save.upgrades = { rays: 3 };
  v.click('continue');
  v.click('select-upgrades');
  assert.deepEqual(v.shown(), ['upgrades']);
  const balance = cda.cdaPatchBalance(v.rt.save);
  assert.equal(v.text('upg-balance'), String(balance));
  const rows = v.el('upg-list').children;
  assert.equal(rows.length, cda.CDA_UPGRADES.length);
  for (let i = 0; i < rows.length; i++) {
    const line = cda.CDA_UPGRADES[i];
    assert.match(rows[i].children[0].children[0].textContent, new RegExp('^' + line.name + ' · tier \\d of ' + line.costs.length + '$'));
  }
  const rays = cda.CDA_UPGRADES.findIndex((l) => l.id === 'rays');
  assert.equal(rows[rays].children[0].children[2].textContent, cda.CDA_UI.topTier + '.');
  assert.equal(v.buy('rays').disabled, true);
  assert.equal(v.buy('rays').getAttribute('aria-label'), 'Degausser ray: ' + cda.CDA_UI.topTier);
  assert.equal(v.buy('health').disabled, false);
  focusIs(v.buy('health'), 'the first that can be bought');
  assert.equal(v.buy('health').getAttribute('aria-label'), 'Buy Max health tier 1 for ' + cda.CDA_UPGRADE.health.costs[0] + ' patches');
  assert.equal(rows[0].children[0].children[1].textContent, 'Now: none yet.');
  assert.equal(rows[0].children[0].children[2].textContent, 'Next: ' + cda.cdaUpgradeEffect('health', 1) + ', ' + cda.CDA_UPGRADE.health.costs[0] + ' patches.');
  v.buy('health').click();
  assert.equal(v.rt.save.upgrades.health, 1);
  assert.equal(v.save().upgrades.health, 1, 'saved');
  assert.equal(v.text('upg-balance'), String(balance - cda.CDA_UPGRADE.health.costs[0]));
  focusIs(v.buy('health'), 'the focus stays on the line');
  assert.equal(v.el('upg-list').children[0].children[0].children[1].textContent, 'Now: ' + cda.cdaUpgradeEffect('health', 1) + '.');
  // spend down until nothing can be bought
  while (!v.buy('health').disabled || !v.buy('cells').disabled) (v.buy('health').disabled ? v.buy('cells') : v.buy('health')).click();
  for (const line of cda.CDA_UPGRADES) {
    const b = v.buy(line.id);
    if (line.id === 'rays') continue;
    assert.equal(b.disabled, true, line.id);
  }
  const why = v.$$('.cda-upgrade-why');
  assert.ok(why.length > 0);
  assert.match(why[0].textContent, /^Needs \d+ patches, you have \d+\.$/);
  focusIs(v.el('upg-back'), 'nothing to buy: Back');
  // a refused buy (the button pressed by something else) changes nothing
  const before = JSON.stringify(v.rt.save.upgrades);
  const stored = localStorage.getItem(SAVE_KEY);
  fire(v.buy('probeDamage'), 'click');
  assert.equal(JSON.stringify(v.rt.save.upgrades), before);
  assert.equal(localStorage.getItem(SAVE_KEY), stored, 'nothing written');
  v.menuKey('Escape');
  assert.deepEqual(v.shown(), ['select']);
});

test('cold-aisle page: upgrades from the results go back to the results; the next sim gets them', (t) => {
  const v = openModule(t, { save: wonUpTo(1, 20) });
  v.play(ROOM, ARMED(), 1);
  v.sim().status = 'won';
  v.clock.frame(50);
  v.click('results-upgrades');
  v.buy('health').click();
  v.click('upg-back');
  assert.deepEqual(v.shown(), ['results']);
  focusIs(v.el('results-upgrades'));
  v.click('next');
  v.click('brief-start');
  assert.equal(v.sim().player.maxHealth, cda.CDA_PLAYER.health + cda.CDA_UPGRADE.health.step);
});

test('cold-aisle page: winning the last level: Finish leads to the end of the episode with the totals and "to be continued"; the save marks it', (t) => {
  const v = openModule(t, { save: wonUpTo(LEVELS - 1, 5, { deaths: 4, playTime: 3725 }) });
  v.play(ROOM, ARMED(), LEVELS - 1);
  v.clock.run(0.2);
  v.sim().status = 'won';
  v.clock.frame(50);
  assert.equal(v.text('next'), 'Finish');
  assert.equal(v.el('next').getAttribute('aria-label'), 'The end of the episode');
  v.click('next');
  assert.deepEqual(v.shown(), ['end']);
  const items = v.el('end-list').children.map((li) => li.textContent);
  const times = v.rt.save.best.reduce((sum, b) => sum + b.time, 0);
  assert.deepEqual(items, [
    'Floors cleared ' + LEVELS + ' of ' + LEVELS,
    'Best times added up ' + cda.cdaFormatTime(times),
    'Enemies destroyed ' + (3 * (LEVELS - 1)) + ' of ' + (4 * (LEVELS - 1)),
    'Secrets ' + (LEVELS - 1) + ' of ' + (2 * (LEVELS - 1)),
    'Patches earned ' + cda.cdaPatchesEarned(v.rt.save),
    'Deaths 4',
    'Time played ' + cda.cdaFormatTime(v.rt.save.playTime)
  ]);
  assert.match(v.text('live'), /to be continued/i);
  assert.equal(v.save().ended, true);
  focusIs(v.el('end-levels'));
  v.click('end-home');
  assert.deepEqual(v.shown(), ['title-screen']);
  // an unreadable best time makes the sum a dash; a floor never cleared counts nothing
  v.rt.save.best[0].time = null;
  v.rt.save.best[1] = null;
  v.g.CDA_RT.rec = { finished: true };
  v.click('continue');
  v.rt.screen = 'results';
  v.click('next');
  assert.equal(v.el('end-list').children[0].textContent, 'Floors cleared ' + (LEVELS - 1) + ' of ' + LEVELS);
  assert.equal(v.el('end-list').children[1].textContent, 'Best times added up –');
  v.click('end-levels');
  assert.deepEqual(v.shown(), ['select']);
});

// ── settings ───────────────────────────────────────────────────────────────

test('cold-aisle page: mute: M in the level and the Sound button on the pause screen; applied, said and saved', (t) => {
  const v = openModule(t);
  focusElement(v.el('new'), { keyboard: true });
  v.menuKey('m');
  assert.equal(v.save().settings.mute, true, 'M on the title, before any level');
  v.menuKey('m');
  assert.equal(v.save().settings.mute, false);
  v.play(ROOM, ARMED());
  v.down('m');
  v.down('m');
  assert.equal(v.text('msg'), cda.CDA_UI.soundOn);
  assert.equal(v.text('mute'), 'Sound: on');
  v.down('m');
  assert.equal(v.rt.save.settings.mute, true);
  assert.equal(v.save().settings.mute, true);
  assert.equal(v.text('msg'), cda.CDA_UI.soundOff);
  assert.equal(v.text('mute'), 'Sound: off');
  assert.equal(v.el('mute').getAttribute('aria-pressed'), 'true');
  v.down('p');
  v.click('mute');
  assert.equal(v.save().settings.mute, false);
  assert.equal(v.text('msg'), cda.CDA_UI.soundOff, 'not said off the level');
  v.menuKey('m');
  assert.equal(v.save().settings.mute, true, 'M on the menus too');
  resetStubs();
  const w = openModule(t, { save: { v: 1, settings: { sens: 1, mute: true } } });
  assert.equal(w.text('mute'), 'Sound: off', 'the saved setting');
});

test('cold-aisle page: the sensitivity slider (0.25 to 3) applies at once and is saved when let go', (t) => {
  const v = openModule(t, { save: { v: 1, settings: { sens: 1.5, mute: false } } });
  assert.equal(v.el('sens').value, '1.5');
  assert.equal(v.text('sens-value'), '1.5');
  assert.equal(v.el('sens').getAttribute('min'), String(cda.CDA_SENS_MIN));
  assert.equal(v.el('sens').getAttribute('max'), String(cda.CDA_SENS_MAX));
  v.el('sens').value = '2.25';
  fire(v.el('sens'), 'input');
  assert.equal(v.rt.save.settings.sens, 2.25);
  assert.equal(v.text('sens-value'), '2.25');
  assert.equal(v.save().settings.sens, 1.5, 'not yet saved');
  fire(v.el('sens'), 'change');
  assert.equal(v.save().settings.sens, 2.25);
  v.el('sens').value = '9';
  fire(v.el('sens'), 'input');
  assert.equal(v.rt.save.settings.sens, cda.CDA_SENS_MAX);
});

// ── the save ───────────────────────────────────────────────────────────────

test('cold-aisle page: blocked storage never stops the game: one warning line names the error and the fix; OK hides it; it is not shown again', (t) => {
  blockStorage('access', t);
  const v = openModule(t);
  assert.equal(v.hidden('warning'), false);
  assert.match(v.text('warning-text'), /SecurityError/);
  assert.match(v.text('warning-text'), /Allow site data/);
  v.click('warning-close');
  assert.equal(v.hidden('warning'), true);
  v.play(ROOM, ARMED(), 0);
  v.sim().status = 'won';
  v.clock.frame(50);
  assert.deepEqual(v.shown(), ['results']);
  assert.equal(v.hidden('warning'), true, 'said once');
  assert.equal(v.rt.save.unlocked, 2, 'the game goes on in memory');
});

test('cold-aisle page: full storage reads the save and warns at the first write; New game over blocked removal still starts', (t) => {
  store(wonUpTo(1));
  blockStorage('full', t);
  const v = openModule(t);
  assert.equal(v.hidden('warning'), true);
  assert.equal(v.rt.save.unlocked, 2);
  v.play(ROOM, ARMED(), 1);
  v.sim().status = 'won';
  v.clock.frame(50);
  assert.equal(v.hidden('warning'), false);
  assert.match(v.text('warning-text'), /QuotaExceededError/);
  resetStubs();
  store(wonUpTo(1));
  blockStorage(['removeItem', 'setItem'], t);
  const w = openModule(t);
  w.click('new');
  w.click('confirm-yes');
  assert.deepEqual(w.shown(), ['briefing']);
  assert.equal(w.rt.save.unlocked, 1);
  assert.equal(w.hidden('warning'), false);
  assert.equal(cda.cdaStorageText({ ok: false, error: null, newer: 0 }).indexOf('an unknown error') > 0, true);
});

test('cold-aisle page: a save of a newer version is never written over or erased: the page plays on in memory and says so', (t) => {
  const newer = JSON.stringify({ v: 7, unlocked: 9 });
  store(newer);
  const v = openModule(t);
  assert.equal(v.hidden('warning'), false);
  assert.match(v.text('warning-text'), /version 7, newer than this page \(version 1\)/);
  assert.equal(v.rt.save.unlocked, 1);
  v.play(ROOM, ARMED(), 0);
  v.sim().status = 'won';
  v.clock.frame(50);
  assert.equal(localStorage.getItem(SAVE_KEY), newer);
  v.click('results-levels');
  v.click('select-back');
  v.click('new');
  v.click('confirm-yes');
  assert.equal(localStorage.getItem(SAVE_KEY), newer, 'New game does not erase it');
});

test('cold-aisle page: a second tab\'s progress is merged: at the next write and through the storage event, which redraws the screen', (t) => {
  const v = openModule(t, { save: wonUpTo(1) });
  v.click('continue');
  assert.equal(v.level(3).disabled, true);
  store(wonUpTo(3, 6));
  fire(window, 'storage', { key: 'other' });
  assert.equal(v.level(3).disabled, true, 'another key');
  fire(window, 'storage', { key: SAVE_KEY });
  assert.equal(v.level(3).disabled, false);
  assert.equal(v.text('balance'), '18');
  v.click('select-upgrades');
  store(wonUpTo(4, 6));
  fire(window, 'storage', { key: SAVE_KEY });
  assert.equal(v.text('upg-balance'), '24');
  v.click('upg-back');
  v.click('select-back');
  store(wonUpTo(4, 6, { deaths: 2 }));
  fire(window, 'storage', { key: SAVE_KEY });
  assert.equal(v.rt.save.deaths, 2);
  v.click('continue');
  v.level(1).click();
  fire(window, 'storage', { key: SAVE_KEY });
  assert.deepEqual(v.shown(), ['briefing']);
  // the write merges too
  store(wonUpTo(5, 6));
  v.click('brief-start');
  v.click('gate-play');
  v.down('p');
  assert.equal(v.save().unlocked, 6);
  assert.equal(v.rt.save.unlocked, 6);
});

test('cold-aisle page: leaving the page saves the time played of a running level; nothing when there is none', (t) => {
  const v = openModule(t);
  fire(window, 'pagehide');
  assert.equal(localStorage.length, 0);
  v.play(ROOM, ARMED());
  v.clock.run(1);
  fire(window, 'pagehide');
  assert.ok(v.save().playTime >= 1 - 1e-9);
});

// ── the frame's keys and clicks ────────────────────────────────────────────

test('cold-aisle page: the menus take Tab, Enter and Space as the browser does; a click in the frame clicks, a Buy click does not', (t) => {
  const v = openModule(t, { save: wonUpTo(1, 10) });
  focusElement(v.el('continue'), { keyboard: true });
  const tab = v.menuKey('Tab');
  assert.equal(tab.defaultPrevented, false, 'Tab moves the focus on the menus');
  v.menuKey('Enter');
  assert.deepEqual(v.shown(), ['select'], 'Enter clicks the focused Continue');
  const handled = keyEvent('f', { target: v.level(1) });
  handled.preventDefault();
  v.level(1).dispatchEvent(handled);
  assert.equal(v.rt.mode, 'page');
  fire(v.el('stage'), 'click');
  v.click('select-upgrades');
  v.buy('health').click();
  assert.equal(v.rt.save.upgrades.health, 1);
});

// ── the guide ──────────────────────────────────────────────────────────────

test('cold-aisle page: the guide: every number is filled from the tables at start-up, every sprite drawn at its size, the upgrade lines written from CDA_UPGRADES', (t) => {
  const v = openModule(t);
  const spans = v.$$('[data-cda-num]');
  assert.ok(spans.length >= 45, spans.length + ' numbers');
  const keys = spans.map((s) => s.getAttribute('data-cda-num'));
  assert.deepEqual(new Set(keys), new Set(Object.keys(cda.CDA_GUIDE_NUMBERS)), 'the markup and the table name the same numbers');
  for (const s of spans) assert.equal(s.textContent, cda.cdaGuideNumber(s.getAttribute('data-cda-num')));
  const T = cda.CDA_TOOL;
  const E = cda.CDA_ENEMY;
  const I = cda.CDA_ITEM;
  const P = cda.CDA_PLAYER;
  const want = {
    levels: LEVELS, health: P.health, 'entry-health': P.entryHealth, 'armour-max': P.armourMax, 'armour-share': P.armourShare * 100,
    speed: P.speed, turn: Math.round(P.turn * 180 / Math.PI), reboot: P.reboot, flashlight: P.flashlight,
    'driver-damage': T.driver.damage, 'driver-reach': T.driver.reach, 'driver-rate': T.driver.cooldown,
    'probe-damage': T.probe.damage, 'probe-rate': T.probe.cooldown, 'probe-cap': T.probe.cap,
    'degausser-rays': T.degausser.rays, 'degausser-damage': T.degausser.damage, 'degausser-fan': Math.round(T.degausser.fan * 180 / Math.PI),
    'degausser-falloff': T.degausser.falloff, 'degausser-rate': T.degausser.cooldown, 'degausser-cap': T.degausser.cap,
    'crawler-hp': E.crawler.hp, 'crawler-damage': E.crawler.damage, 'crawler-windup': E.crawler.windup,
    'drone-hp': E.drone.hp, 'drone-damage': E.drone.damage, 'drone-windup': E.drone.windup,
    'turret-hp': E.turret.hp, 'turret-damage': E.turret.damage, 'turret-burst': E.turret.burst, 'turret-windup': E.turret.windup,
    'loader-hp': E.loader.hp, 'loader-damage': E.loader.damage, 'loader-windup': E.loader.windup, 'loader-stun': E.loader.stun,
    'chiller-hp': E.chiller.hp, 'chiller-called': cda.CDA_BOSS.maxCalled,
    'cell-amount': I.cell.amount, 'coil-amount': I.coil.amount, 'coffee-health': I.coffee.health, 'medkit-health': I.medkit.health,
    'vest-armour': I.vest.armour, 'probe-amount': I.probe.amount, 'degausser-amount': I.degausser.amount,
    'reward-finish': cda.CDA_REWARDS.finish, 'reward-kill': cda.CDA_REWARDS.kill, 'reward-secret': cda.CDA_REWARDS.secret,
    'upgrade-lines': cda.CDA_UPGRADES.length
  };
  for (const [key, value] of Object.entries(want)) assert.equal(cda.cdaGuideNumber(key), String(value), key);
  assert.equal(cda.cdaGuideNumber('nope'), '–');
  const sprites = v.$$('[data-cda-sprite]');
  assert.ok(sprites.length >= 30, sprites.length + ' sprites');
  for (const c of sprites) {
    const s = cda.cdaSpritePixels(c.getAttribute('data-cda-sprite'));
    assert.deepEqual([c.width, c.height], [s.w, s.h], c.id);
  }
  const lines = v.el('guide-upgrades').children;
  assert.equal(lines.length, cda.CDA_UPGRADES.length);
  for (let i = 0; i < lines.length; i++) {
    const u = cda.CDA_UPGRADES[i];
    assert.equal(lines[i].textContent, u.name + ': ' + cda.cdaUpgradeEffect(u.id, 1) + ' a tier, ' + u.costs.length + ' tiers for ' + u.costs.join(' / ') + ' patches.');
  }
});

// ── words ──────────────────────────────────────────────────────────────────

test('cold-aisle page: times, kits and upgrade effects in words', () => {
  assert.equal(cda.cdaFormatTime(null), '–');
  assert.equal(cda.cdaFormatTime(NaN), '–');
  assert.equal(cda.cdaFormatTime(-1), '–');
  assert.equal(cda.cdaFormatTime(0), '0:00');
  assert.equal(cda.cdaFormatTime(59.9), '0:59');
  assert.equal(cda.cdaFormatTime(312.5), '5:12');
  assert.equal(cda.cdaFormatTime(3725), '1:02:05');
  assert.equal(cda.cdaFormatTime(4800), '1:20:00');
  assert.equal(cda.cdaKitText({ tools: ['driver'], ammo: { cell: 0, coil: 0 } }), 'Screwdriver');
  assert.equal(cda.cdaKitText({ tools: ['driver', 'probe', 'degausser'], ammo: { cell: 40, coil: 8 } }), 'Screwdriver, Tone probe, Degausser; 40 cells, 8 coils');
  const step = (id) => cda.CDA_UPGRADE[id].step;
  assert.equal(cda.cdaUpgradeEffect('health', 2), '+' + 2 * step('health') + ' max health');
  assert.equal(cda.cdaUpgradeEffect('cells', 1), '+' + step('cells') + ' cell capacity');
  assert.equal(cda.cdaUpgradeEffect('probeDamage', 3), '+' + 3 * step('probeDamage') + ' probe damage');
  assert.equal(cda.cdaUpgradeEffect('probeSpeed', 2), 'probe cooldown -' + cda.cdaNum(2 * step('probeSpeed') * 100) + ' %');
  assert.equal(cda.cdaUpgradeEffect('rays', 1 / step('rays')), '+1 degausser ray');
  assert.equal(cda.cdaUpgradeEffect('rays', 2 / step('rays')), '+2 degausser rays');
  assert.equal(cda.cdaUpgradeEffect('flashlight', 1), '+' + step('flashlight') + ' tiles of flashlight');
  assert.equal(cda.cdaNum(1 / 3), '0.33');
});

// ── the mouse without the lock, and around it ──────────────────────────────

// The stage laid out at (100, 50), 960x540 (the stubs lay nothing out).
function layStage(v) {
  v.el('stage').getBoundingClientRect = () => ({ left: 100, top: 50, width: 960, height: 540, right: 1060, bottom: 590 });
}

const move = (props) => fire(document, 'mousemove', props);

test('cold-aisle page: without the lock the mouse turns the view over the stage at the locked sensitivity; the edges keep turning, rising to the keyboard rate; leaving stops it', (t) => {
  const v = openModule(t);
  layStage(v);
  v.play(ROOM, ARMED());
  const read = () => v.g.cdaReadInput();
  const base = cda.CDA_MOUSE_BASE;
  const turn = cda.CDA_PLAYER.turn;
  assert.equal(v.rt.locked, false);
  assert.equal(v.el('stage').classList.contains('cda-stage--live'), true, 'the cursor is hidden over the view');
  // movement over the middle of the stage turns as under the lock
  v.rt.save.settings.sens = 1.5;
  move({ clientX: 580, clientY: 300, movementX: 40 });
  move({ clientX: 570, clientY: 300, movementX: -10 });
  assert.ok(near(read().turn, 30 * base * 1.5));
  move({ clientX: 580, clientY: 300, movementX: 1000 });
  assert.ok(near(read().turn, cda.CDA_MOUSE_SPIKE * base * 1.5), 'a spike is clamped');
  move({ clientX: 580, clientY: 300 });
  assert.equal(read().turn, 0, 'no movementX, no turn');
  // outside the stage: nothing
  for (const [x, y] of [[50, 300], [1060, 300], [580, 20], [580, 590]]) {
    move({ clientX: x, clientY: y, movementX: 40 });
    assert.equal(read().turn, 0, x + ',' + y);
  }
  // the left edge zone: 0 at its inner edge, the keyboard rate at the stage's edge
  const zone = 960 * cda.CDA_EDGE_ZONE;
  move({ clientX: 100 + zone, clientY: 300 });
  assert.equal(read().turn, 0, 'the inner edge of the zone');
  move({ clientX: 100 + zone / 2, clientY: 300 });
  assert.ok(near(read().turn, -turn / 2 * STEP));
  assert.ok(near(read().turn, -turn / 2 * STEP), 'it keeps turning while the pointer rests');
  move({ clientX: 100, clientY: 300 });
  assert.ok(near(read().turn, -turn * STEP), 'the full keyboard rate at the edge');
  // the right one
  move({ clientX: 1059, clientY: 300 });
  assert.ok(near(read().turn, turn * (zone - 1) / zone * STEP));
  // played: the view turns by the frames' steps
  const p = v.sim().player;
  const a0 = p.angle;
  const ticks = v.sim().tick;
  v.clock.run(0.5);
  assert.ok(near(p.angle - a0, (v.sim().tick - ticks) * turn * (zone - 1) / zone * STEP, 1e-9), 'turned right while resting');
  // leaving the stage stops it
  fire(v.el('stage'), 'mouseleave');
  assert.equal(read().turn, 0);
  move({ clientX: 1059, clientY: 300 });
  move({ clientX: 1100, clientY: 300 });
  assert.equal(read().turn, 0, 'out over the page');
  // a pause lets it go
  move({ clientX: 100, clientY: 300 });
  v.down('p');
  assert.equal(v.rt.edge, 0);
  assert.equal(v.el('stage').classList.contains('cda-stage--live'), false);
});

test('cold-aisle page: a refused lock leaves mouse look and fire working; a click asks again only 1.5 s after the refusal; a granted lock switches the unlocked turning off', async (t) => {
  const v = openModule(t);
  layStage(v);
  let asked = 0;
  v.canvas.requestPointerLock = () => {
    asked++;
    fire(document, 'pointerlockerror', { timeStamp: 1000 });
  };
  t.after(() => delete document.pointerLockElement);
  v.play(ROOM, ARMED());
  assert.equal(asked, 1);
  assert.equal(v.rt.lockRefused, true);
  assert.equal(v.text('msg'), cda.CDA_UI.lockRefused);
  assert.match(cda.CDA_UI.lockRefused, /still turns the view inside the frame/);
  assert.match(cda.CDA_UI.lockRefused, /click the view to capture it again/);
  const read = () => v.g.cdaReadInput();
  move({ clientX: 580, clientY: 300, movementX: 50 });
  assert.ok(near(read().turn, 50 * cda.CDA_MOUSE_BASE), 'the mouse still turns');
  // 1 s after the refusal: no new request, but the click fires
  const early = fire(v.canvas, 'mousedown', { button: 0, timeStamp: 2000 });
  assert.equal(early.defaultPrevented, true);
  assert.equal(asked, 1, 'not asked again before 1.5 s');
  assert.equal(read().fire, true, 'the left button fires without the lock');
  fire(document, 'mouseup', { button: 0 });
  // 1.5 s after: asked again (refused again) and fired
  fire(v.canvas, 'mousedown', { button: 0, timeStamp: 2500 });
  assert.equal(asked, 2);
  assert.equal(read().fire, true);
  fire(document, 'mouseup', { button: 0 });
  // a refusal without an event of its own counts from the click that asked
  v.canvas.requestPointerLock = () => {
    asked++;
    return Promise.reject(new Error('no'));
  };
  fire(v.canvas, 'mousedown', { button: 0, timeStamp: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(v.rt.refusedAt, 5000);
  fire(v.canvas, 'mousedown', { button: 0, timeStamp: 6000 });
  assert.equal(asked, 3, 'not before 6500');
  fire(document, 'mouseup', { button: 0 });
  // now the browser grants it: the unlocked turning goes off
  v.canvas.requestPointerLock = () => {
    asked++;
    document.pointerLockElement = v.canvas;
    fire(document, 'pointerlockchange');
  };
  move({ clientX: 100, clientY: 300 });
  assert.ok(v.rt.edge < 0, 'resting at the left edge');
  fire(v.canvas, 'mousedown', { button: 0, timeStamp: 7000 });
  assert.equal(asked, 4);
  assert.equal(v.rt.locked, true);
  assert.equal(v.rt.lockRefused, false);
  assert.equal(v.rt.edge, 0);
  fire(document, 'mouseup', { button: 0 });
  read();
  move({ clientX: 100, clientY: 300, movementX: 30 });
  assert.equal(read().turn, 0, 'the first movement under the lock is dropped');
  move({ clientX: 100, clientY: 300, movementX: 30 });
  assert.ok(near(read().turn, 30 * cda.CDA_MOUSE_BASE), 'only the movement turns, no edge');
  // the lock lost (Esc) and the level resumed by Esc: never refused since, so a click only takes it
  document.pointerLockElement = null;
  fire(document, 'pointerlockchange');
  assert.deepEqual(v.shown(), ['pause']);
  v.menuKey('Escape');
  assert.deepEqual(v.shown(), []);
  fire(v.canvas, 'mousedown', { button: 0, timeStamp: 7100 });
  assert.equal(asked, 5);
  assert.equal(v.rt.locked, true);
  assert.equal(read().fire, false, 'that click took the lock and did not fire');
});

test('cold-aisle page: without the Pointer Lock API the mouse turns the view and fires, said once; under the lock a spike is clamped both ways', (t) => {
  const v = openModule(t);
  layStage(v);
  v.play(ROOM, ARMED());
  assert.equal(v.text('msg'), cda.CDA_UI.noLock);
  assert.match(cda.CDA_UI.noLock, /turns the view/);
  move({ clientX: 580, clientY: 300, movementX: -20 });
  fire(v.canvas, 'mousedown', { button: 0 });
  const input = v.g.cdaReadInput();
  assert.ok(near(input.turn, -20 * cda.CDA_MOUSE_BASE));
  assert.equal(input.fire, true);
  resetStubs();
  const w = openModule(t);
  grantLock(t, w);
  w.play(ROOM, ARMED());
  move({ movementX: 5 });
  move({ movementX: 4000 });
  assert.ok(near(w.g.cdaReadInput().turn, cda.CDA_MOUSE_SPIKE * cda.CDA_MOUSE_BASE));
  move({ movementX: -4000 });
  assert.ok(near(w.g.cdaReadInput().turn, -cda.CDA_MOUSE_SPIKE * cda.CDA_MOUSE_BASE));
});

// ── keys: the trap, held keys, physical keys ───────────────────────────────

test('cold-aisle page: the canvas is in the tab order only while the level is live; behind a menu it lets Tab and Esc through and never shows the map', (t) => {
  const v = openModule(t, { save: wonUpTo(1) });
  assert.equal(v.canvas.tabIndex, -1, 'the title');
  v.rt.startLevel(ROOM, ARMED());
  assert.equal(v.canvas.tabIndex, -1, 'behind the gate');
  v.click('gate-play');
  assert.equal(v.canvas.tabIndex, 0, 'live');
  v.down('p');
  assert.equal(v.canvas.tabIndex, -1, 'paused');
  v.click('pause-levels');
  v.click('confirm-yes');
  assert.deepEqual(v.shown(), ['select']);
  // a keyboard user lands on the canvas behind the level select
  focusElement(v.canvas, { keyboard: true });
  const tab = v.down('Tab');
  assert.equal(tab.defaultPrevented, false, 'Tab moves on');
  assert.equal(v.rt.map, false, 'no map from a menu');
  assert.equal(v.down('w').defaultPrevented, false);
  assert.deepEqual(v.rt.keys, {});
  const esc = v.down('Escape');
  assert.equal(esc.defaultPrevented, true);
  assert.deepEqual(v.shown(), ['title-screen'], 'Esc goes back as on the menu');
  assert.equal(v.up('Escape').defaultPrevented, false);
});

test('cold-aisle page: Enter or Space held when a level ends never press the button the new screen focuses; a fresh press does', (t) => {
  const v = openModule(t);
  v.play(ROOM, ARMED());
  v.down('Enter');
  v.clock.frame(50);
  v.sim().status = 'dead';
  v.clock.frame(50);
  assert.deepEqual(v.shown(), ['death']);
  const retry = v.el('retry');
  focusIs(retry);
  // the auto-repeat of the held Enter on Retry
  const rep = pressKey('Enter', { target: retry, repeat: true });
  assert.equal(rep.defaultPrevented, true);
  assert.deepEqual(v.shown(), ['death'], 'the death screen stays');
  const up = keyEvent('Enter', { type: 'keyup', target: retry });
  retry.dispatchEvent(up);
  assert.equal(up.defaultPrevented, true, 'its release is cancelled too');
  // a fresh press
  pressKey('Enter', { target: retry });
  assert.deepEqual(v.shown(), ['gate']);
  const upEnter = keyEvent('Enter', { type: 'keyup', target: v.el('gate-play') });
  v.el('gate-play').dispatchEvent(upEnter);
  // Space held to use when the level is won: its repeat and release on Next do nothing
  v.click('gate-play');
  v.down(' ');
  v.sim().status = 'won';
  v.clock.frame(50);
  assert.deepEqual(v.shown(), ['results']);
  const next = document.activeElement;
  assert.equal(pressKey(' ', { target: next, repeat: true }).defaultPrevented, true);
  assert.deepEqual(v.shown(), ['results']);
  const spaceUp = keyEvent(' ', { type: 'keyup', target: next });
  next.dispatchEvent(spaceUp);
  assert.equal(spaceUp.defaultPrevented, true);
  // released: the next Space is the browser's again (nothing cancelled)
  const again = keyEvent(' ', { type: 'keyup', target: next });
  next.dispatchEvent(again);
  assert.equal(again.defaultPrevented, false);
});

test('cold-aisle page: the game takes no focus at load; the first key, click or focus in the frame lets it move the focus', (t) => {
  const v = openModule(t);
  focusIs(document.body);
  v.click('help-open');
  focusIs(v.el('help-close'), 'a click counts');
  resetStubs();
  const w = openModule(t);
  fire(w.el('stage'), 'mousedown', { button: 0 });
  w.g.cdaRuntime().startLevel(ROOM, ARMED());
  focusIs(w.el('gate-play'), 'a mouse button counts');
  resetStubs();
  const k = openModule(t);
  pressKey('x', { target: k.el('frame') });
  k.g.cdaRuntime().startLevel(ROOM, ARMED());
  focusIs(k.el('gate-play'), 'a key in the frame counts');
});

test('cold-aisle page: keys by their physical place: Dvorak, Colemak and Ukrainian as the browser sends them; the value only without a code', (t) => {
  const act = (key, code) => cda.cdaKeyAction({ key, code });
  // Dvorak: physical E types '.', D types 'e', W types ',', P types 'l', F types 'u'
  assert.equal(act('.', 'KeyE'), 'use');
  assert.equal(act('e', 'KeyD'), 'right', 'Dvorak e is strafe right, not use');
  assert.equal(act(',', 'KeyW'), 'forward');
  assert.equal(act('l', 'KeyP'), 'pause');
  assert.equal(act('u', 'KeyF'), 'fullscreen');
  assert.equal(act('e', 'Period'), null, 'the key that types e elsewhere does nothing');
  // Colemak: physical E types 'f', F types 't', R types 'p', G types 'd', K types 'e'
  assert.equal(act('f', 'KeyE'), 'use', 'Colemak physical E is use, not fullscreen');
  assert.equal(act('t', 'KeyF'), 'fullscreen');
  assert.equal(act('p', 'KeyR'), null, 'physical R does not pause');
  assert.equal(act('d', 'KeyG'), null);
  assert.equal(act('e', 'KeyK'), null);
  // Ukrainian (ЙЦУКЕН)
  for (const [key, code, want] of [['ц', 'KeyW', 'forward'], ['ф', 'KeyA', 'left'], ['і', 'KeyS', 'back'], ['в', 'KeyD', 'right'],
    ['у', 'KeyE', 'use'], ['о', 'KeyJ', 'fire'], ['а', 'KeyF', 'fullscreen'], ['ь', 'KeyM', 'mute'], ['з', 'KeyP', 'pause'], ['1', 'Digit1', 'tool']]) {
    assert.equal(act(key, code), want, key);
  }
  // named keys and the numpad by code; the value only when there is no code
  assert.equal(act('Enter', 'NumpadEnter'), 'fire');
  assert.equal(act(' ', 'Space'), 'use');
  assert.equal(act('W', undefined), 'forward');
  assert.equal(act('e', ''), 'use');
  assert.equal(act('Tab', 'Unidentified'), 'map');
  assert.equal(act('x', ''), null);
  assert.equal(act(undefined, ''), null);
  // through the page: the tool's number from its code, else its value
  const v = openModule(t);
  v.play(ROOM, ARMED());
  v.down('.', { code: 'KeyE' });
  assert.equal(v.g.cdaReadInput().use, true);
  v.up('.', { code: 'KeyE' });
  v.down('2', { code: 'Numpad2' });
  assert.equal(v.g.cdaReadInput().weapon, 2);
  v.down('3', { code: '' });
  assert.equal(v.g.cdaReadInput().weapon, 3);
  assert.equal(v.down('p', { code: 'KeyR' }).defaultPrevented, false);
  assert.deepEqual(v.shown(), []);
});

// ── the frame's scale by device pixels ─────────────────────────────────────

test('cold-aisle page: at 125 %, 150 % and 200 % scaling the stage fills the width on whole device pixels, a whole factor only when it covers 96 %; fullscreen; a ratio change lays out again', (t) => {
  const queries = [];
  const saved = window.matchMedia;
  window.matchMedia = (q) => {
    const m = makeEventTarget({ matches: false, media: q });
    queries.push(m);
    return m;
  };
  window.devicePixelRatio = 1.25;
  t.after(() => {
    window.matchMedia = saved;
    delete window.devicePixelRatio;
  });
  const v = openModule(t, { width: 1000 });
  const stage = v.el('stage');
  const size = () => [stage.style.width, stage.style.height, stage.style['--cda-scale']];
  assert.deepEqual(size(), ['1000px', 703 / 1.25 + 'px', String(1000 / 320)], '3x would be 768 px: the full width, 703 device px high');
  const last = queries[queries.length - 1];
  assert.equal(last.media, '(resolution: 1.25dppx)');
  window.devicePixelRatio = 1.5;
  fire(last, 'change');
  assert.deepEqual(size(), ['1000px', '562px', String(1000 / 320)], 'the full width at 150 %, 843 device px high');
  assert.equal(queries[queries.length - 1].media, '(resolution: 1.5dppx)', 'watched again');
  window.devicePixelRatio = 2;
  fire(window, 'resize');
  assert.deepEqual(size(), ['960px', '540px', '3'], '6 device px a game pixel is 96 % of 1000 px');
  // the site's 966 px column: the width rounded down to whole device pixels
  window.devicePixelRatio = 1.25;
  v.el('holder').clientWidth = 966;
  fire(window, 'resize');
  assert.deepEqual(size(), [1207 / 1.25 + 'px', 679 / 1.25 + 'px', String(1207 / 1.25 / 320)], '1207 x 679 device px');
  window.devicePixelRatio = 1.5;
  fire(window, 'resize');
  assert.deepEqual(size(), ['966px', 815 / 1.5 + 'px', String(966 / 320)], '4 device px a game pixel would be 88 %');
  window.devicePixelRatio = 1.25;
  v.el('holder').clientWidth = 400;
  fire(window, 'resize');
  assert.deepEqual(size(), ['400px', 281 / 1.25 + 'px', '1.25'], 'the height a whole 281 device px');
  assert.equal(cda.cdaPageScale(966, 1.25), 966 / 320);
  assert.equal(cda.cdaPageScale(966), 3, 'no ratio: 1');
  assert.equal(cda.cdaFullScale(1920, 1080, 1.25), 6, 'a 2400x1350 screen: 7 device px a game pixel would be 93 %');
  assert.equal(cda.cdaFullScale(1536, 864, 1.25), 4.8, 'a 1920x1080 screen at 125 %: 6 device px a game pixel');
  assert.deepEqual(cda.cdaStageSize(4.8, 1.25), { w: 1536, h: 864 });
  assert.equal(cda.cdaFullScale(300, 150, 2), 150 / 180, 'one device pixel is 60 % of the fit: the fit');
  // a matchMedia result without listeners: nothing is watched
  window.matchMedia = () => ({ matches: false });
  resetStubs();
  const w = openModule(t);
  assert.equal(w.rt.dpr, 1.25);
});

// ── the save between tabs, the click sound, the title picture ──────────────

test('cold-aisle page: New game in another tab is not undone here: its higher epoch replaces this tab\'s progress, and this tab\'s New game wins over the other\'s', (t) => {
  const v = openModule(t, { save: wonUpTo(3) });
  assert.equal(v.hidden('continue'), false);
  const erased = cda.cdaNewSave(LEVELS);
  erased.epoch = 1;
  store(erased);
  fire(window, 'storage', { key: SAVE_KEY });
  assert.equal(v.rt.save.unlocked, 1);
  assert.equal(v.hidden('continue'), true, 'the title follows the erase');
  // a later write here keeps the erase
  v.play(ROOM, ARMED(), 0);
  v.sim().status = 'won';
  v.clock.frame(50);
  assert.equal(v.save().epoch, 1);
  assert.equal(v.save().unlocked, 2);
  // this tab's New game over a stored save of a higher epoch still wins
  const other = wonUpTo(5);
  other.epoch = 4;
  store(other);
  v.click('results-levels');
  v.click('select-back');
  v.click('new');
  v.click('confirm-yes');
  assert.equal(v.save().epoch, 5);
  assert.equal(v.save().unlocked, 1);
});

test('cold-aisle page: a click anywhere on a level button (its name or stats) clicks; the stage itself does not', (t) => {
  const v = openModule(t, { save: wonUpTo(1) });
  const sfx = v.g.CDA_SFX;
  v.click('continue');
  fire(v.level(1).children[0], 'click');
  assert.equal(sfx.last.length, 1, 'the click on the name sounds');
  assert.deepEqual(v.shown(), ['briefing']);
  v.click('brief-back');
  sfx.last = [];
  fire(v.el('stage'), 'click');
  assert.equal(sfx.last.length, 0);
});

test('cold-aisle page: the title shows a picture of level 1 drawn once (no loop), without the tool in hand; a level 1 without the view cell is seen from its start', (t) => {
  const v = openModule(t, { save: wonUpTo(1) });
  const px = v.rt.pixels;
  const lit = Array.from(px).filter((c) => (c & 0xffffff) !== 0).length;
  assert.ok(lit > px.length * 0.9, 'a whole picture: ' + lit);
  assert.equal(v.clock.pending(), 0, 'no loop on the title');
  const titleFrame = Array.from(px);
  const view = v.rt.title.view;
  v.play(ROOM, ARMED());
  v.clock.frame(50);
  v.down('p');
  v.click('pause-levels');
  v.click('confirm-yes');
  v.click('select-back');
  assert.deepEqual(Array.from(v.rt.pixels), titleFrame, 'the same picture again');
  assert.equal(v.rt.title.view, view, 'its view is made once');
  // the same frame through cdaRender with the hand lowered
  const sim = cda.cdaNewSim(cda.cdaParseLevel(cda.CDA_LEVELS[0]), cda.cdaLevelCarry(0, null), {}, 1);
  const p = sim.player;
  p.x = p.px = 11.8;
  p.y = p.py = 4.5;
  p.angle = p.pangle = Math.PI - 0.1;
  p.switchT = cda.cdaSteps(cda.CDA_PLAYER.switchTime) / 2;
  const mine = new Uint32Array(cda.CDA_W * cda.CDA_H);
  cda.cdaRender(cda.cdaNewView(), sim, 1, mine);
  assert.deepEqual(Array.from(mine), titleFrame);
  p.switchT = 0;
  cda.cdaRender(cda.cdaNewView(), sim, 1, mine);
  assert.notDeepEqual(Array.from(mine), titleFrame, 'with the hand up the frame differs');
  // a level 1 without that cell: seen from its start
  const levels = v.g.CDA_LEVELS;
  const real = levels[0];
  t.after(() => { levels[0] = real; });
  const WIDE = { name: 'Wide', briefing: 'x', facing: 'E', map: ['#############', '#@..........#', '#...........#', '#...........#', '#..........##', '#############'] };
  for (const obj of [TINY, WIDE]) {
    levels[0] = obj;
    v.click('continue');
    v.click('select-back');
    const s = cda.cdaNewSim(cda.cdaParseLevel(obj), cda.cdaLevelCarry(0, null), {}, 1);
    s.player.switchT = cda.cdaSteps(cda.CDA_PLAYER.switchTime) / 2;
    const want = new Uint32Array(cda.CDA_W * cda.CDA_H);
    cda.cdaRender(cda.cdaNewView(), s, 1, want);
    assert.deepEqual(Array.from(v.rt.pixels), Array.from(want), obj.name);
  }
});
