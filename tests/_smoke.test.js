// tests/_smoke.test.js
// Pins the test harness itself: tests/_setup.js loads and every browser stub a
// game relies on exists and behaves as documented there.  It also keeps
// `npm test` green before any game has tests of its own (tests/run.js exits 1
// when it finds no *.test.js files).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const setup = require('./_setup');
const {
  loadScript, stubElement, createStorage, flushAnimationFrames, resetStubs
} = setup;

test('setup: exports the helpers', () => {
  for (const fn of [loadScript, stubElement, createStorage, flushAnimationFrames, resetStubs]) {
    assert.equal(typeof fn, 'function');
  }
});

test('setup: loadScript resolves paths from the repo root', () => {
  assert.equal(loadScript('package.json').name, 'vahac-games');
});

test('setup: requestAnimationFrame queues without running, ids grow from 1', () => {
  resetStubs();
  const calls = [];
  const a = requestAnimationFrame((t) => calls.push(['a', t]));
  const b = requestAnimationFrame((t) => calls.push(['b', t]));
  assert.ok(a >= 1 && b > a);
  assert.deepEqual(calls, []);
  cancelAnimationFrame(a);
  cancelAnimationFrame(9999);
  assert.equal(flushAnimationFrames(16), 1);
  assert.deepEqual(calls, [['b', 16]]);
  assert.equal(flushAnimationFrames(), 0);
});

test('setup: frames requested during a flush wait for the next one', () => {
  resetStubs();
  let frames = 0;
  const loop = () => { frames++; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  assert.equal(flushAnimationFrames(), 1);
  assert.equal(flushAnimationFrames(), 1);
  assert.equal(frames, 2);
  resetStubs();
  assert.equal(flushAnimationFrames(), 0);
});

test('setup: performance.now returns a number', () => {
  assert.equal(typeof performance.now(), 'number');
  assert.equal(window.performance, performance);
});

test('setup: localStorage and sessionStorage are separate in-memory stores', () => {
  resetStubs();
  localStorage.setItem('tf8-best', 2048);
  assert.equal(localStorage.getItem('tf8-best'), '2048');
  assert.equal(localStorage.getItem('missing'), null);
  assert.equal(sessionStorage.getItem('tf8-best'), null);
  assert.equal(localStorage.length, 1);
  assert.equal(localStorage.key(0), 'tf8-best');
  assert.equal(localStorage.key(1), null);
  localStorage.removeItem('tf8-best');
  assert.equal(localStorage.length, 0);
  sessionStorage.setItem('x', '1');
  sessionStorage.clear();
  assert.equal(sessionStorage.length, 0);
  assert.equal(window.localStorage, localStorage);
  assert.equal(window.sessionStorage, sessionStorage);
  assert.notEqual(createStorage(), createStorage());
});

test('setup: resetStubs empties both storages', () => {
  localStorage.setItem('a', '1');
  sessionStorage.setItem('b', '2');
  resetStubs();
  assert.equal(localStorage.length + sessionStorage.length, 0);
});

test('setup: matchMedia never matches', () => {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  assert.equal(mq.matches, false);
  assert.equal(mq.media, '(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', () => {});
  mq.addListener(() => {});
  assert.equal(window.matchMedia, matchMedia);
});

test('setup: window and document accept event listeners', () => {
  for (const target of [window, document]) {
    assert.equal(typeof target.addEventListener, 'function');
    assert.equal(typeof target.removeEventListener, 'function');
    target.addEventListener('keydown', () => {});
    target.removeEventListener('keydown', () => {});
  }
  assert.equal(window.document, document);
  assert.equal(document.getElementById('anything'), null);
});

test('setup: element classList stays in sync with className', () => {
  const el = stubElement();
  el.classList.add('tf8-cell', 'tf8-new');
  assert.equal(el.className, 'tf8-cell tf8-new');
  assert.equal(el.classList.contains('tf8-new'), true);
  assert.equal(el.classList.toggle('tf8-new'), false);
  assert.equal(el.classList.toggle('tf8-merged', true), true);
  el.classList.remove('tf8-cell');
  assert.equal(el.className, 'tf8-merged');
  assert.equal(el.classList.length, 1);
});

test('setup: element style, dataset and attributes', () => {
  const el = stubElement();
  el.style.gridTemplateColumns = 'repeat(4, 1fr)';
  el.style.setProperty('--tf8-size', '4');
  assert.equal(el.style.getPropertyValue('--tf8-size'), '4');
  assert.deepEqual(Object.keys(el.style), ['gridTemplateColumns', '--tf8-size']);
  assert.equal(el.getAttribute('aria-label'), null);
  el.setAttribute('aria-label', 'Cell 1');
  el.setAttribute('data-row-index', 2);
  el.setAttribute('id', 'tf8-board');
  assert.equal(el.getAttribute('aria-label'), 'Cell 1');
  assert.equal(el.dataset.rowIndex, '2');
  assert.equal(el.id, 'tf8-board');
  el.removeAttribute('aria-label');
  assert.equal(el.hasAttribute('aria-label'), false);
});

test('setup: element children follow appendChild, removeChild and innerHTML', () => {
  const board = document.createElement('div');
  const cell = document.createElement('span');
  assert.equal(board.appendChild(cell), cell);
  assert.equal(board.children.length, 1);
  assert.equal(cell.parentElement, board);
  assert.equal(board.firstChild, cell);
  assert.equal(board.contains(cell), true);
  const other = stubElement();
  other.appendChild(cell);
  assert.equal(board.children.length, 0);
  assert.equal(other.lastChild, cell);
  cell.remove();
  assert.equal(other.children.length, 0);
  other.appendChild(stubElement());
  other.innerHTML = '';
  assert.equal(other.children.length, 0);
  assert.equal(other.querySelector('.x'), null);
  assert.deepEqual(other.querySelectorAll('.x'), []);
});

test('setup: element focus and getBoundingClientRect', () => {
  const el = stubElement();
  el.focus();
  assert.deepEqual(el.getBoundingClientRect(), {
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0
  });
  const canvas = document.createElement('canvas');
  assert.equal(canvas.getBoundingClientRect().width, 300);
  assert.equal(canvas.getBoundingClientRect().height, 150);
});

test('setup: canvas getContext("2d") is a no-op drawing context', () => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  assert.equal(canvas.getContext('2d'), ctx);
  assert.equal(ctx.canvas, canvas);
  ctx.fillStyle = '#22d3ee';
  ctx.clearRect(0, 0, 300, 150);
  ctx.beginPath();
  ctx.arc(10, 10, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(0, 0, 10, 10);
  ctx.fillText('Score', 0, 0);
  ctx.createLinearGradient(0, 0, 1, 1).addColorStop(0, '#000');
  assert.equal(ctx.fillStyle, '#22d3ee');
  assert.equal(ctx.measureText('Score').width, 0);
  assert.equal(ctx.getImageData(0, 0, 2, 2).data.length, 16);
  assert.equal(canvas.getContext('webgl'), null);
});

test('setup: Audio and AudioContext are silent', async () => {
  const sound = new Audio('beep.mp3');
  await sound.play();
  assert.equal(sound.paused, false);
  sound.pause();
  assert.equal(sound.paused, true);

  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.frequency.setValueAtTime(880, ac.currentTime).exponentialRampToValueAtTime(440, 0.1);
  gain.gain.linearRampToValueAtTime(0, 0.1);
  assert.equal(osc.connect(gain), gain);
  gain.connect(ac.destination);
  osc.start();
  osc.stop(0.1);
  await ac.suspend();
  assert.equal(ac.state, 'suspended');
  await ac.resume();
  assert.equal(ac.state, 'running');
});

test('setup: navigator.vibrate and clipboard exist', async () => {
  assert.equal(navigator.vibrate([30, 50, 30]), true);
  await navigator.clipboard.writeText('2048');
  assert.equal(window.navigator, navigator);
});

test('setup: setInterval and clearInterval are Node\'s own timers', async () => {
  assert.equal(window.setInterval, setInterval);
  assert.equal(window.clearInterval, clearInterval);
  let ticks = 0;
  await new Promise((resolve) => {
    const id = setInterval(() => {
      ticks++;
      if (ticks === 2) {
        clearInterval(id);
        resolve();
      }
    }, 1);
  });
  assert.equal(ticks, 2);
});

// ── Events, pages, browser boot and source checks ───────────────────────────

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  makeEventTarget, createEvent, keyEvent, touchEvent, fire, pressKey, swipe,
  listenersOf, listenerCount, createPage, loadWithPage, bootLikeBrowser,
  REPO_ROOT, readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety,
  cssRules, declsAt, focusElement, typeInto, setVisibility, blockStorage, useClock,
  seeded
} = setup;

// Fixture scripts live in a temp folder (absolute paths resolve as they are),
// so these tests never depend on a game's own files.
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'vahac-games-smoke-'));
test.after(() => fs.rmSync(FIXTURES, { recursive: true, force: true }));
function fixture(name, source) {
  const file = path.join(FIXTURES, name);
  fs.writeFileSync(file, source);
  return file;
}

// A game-shaped script: looks its element up while it loads, exposes its
// state on window and starts behind the usual readyState / module guard.
const GAME_SOURCE = [
  '(function () {',
  '  \'use strict\';',
  '  var board = document.getElementById(\'fix-board\');',
  '  var state = { keys: [], inits: 0 };',
  '  function onKey(event) {',
  '    state.keys.push(event.key);',
  '    if (event.key === \'ArrowUp\') event.preventDefault();',
  '  }',
  '  function init() {',
  '    state.inits++;',
  '    document.addEventListener(\'keydown\', onKey);',
  '    document.getElementById(\'fix-new\').addEventListener(\'click\', function () { board.textContent = \'new\'; });',
  '  }',
  '  window.fixState = state;',
  '  if (document.readyState === \'loading\') {',
  '    document.addEventListener(\'DOMContentLoaded\', init);',
  '  } else if (typeof module === \'undefined\' || !module.exports) {',
  '    init();',
  '  }',
  '  if (typeof module !== \'undefined\' && module.exports) {',
  '    module.exports = { board: board, state: state, init: init };',
  '  }',
  '})();',
  ''
].join('\n');
const GAME_PAGE = { 'fix-board': 'div', 'fix-new': 'button' };

test('setup: exports the new helpers', () => {
  for (const fn of [
    makeEventTarget, createEvent, keyEvent, touchEvent, fire, pressKey, swipe, listenersOf,
    listenerCount, createPage, loadWithPage, bootLikeBrowser, readRepoFile, idsInHtml,
    htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, focusElement, typeInto,
    setVisibility, blockStorage, useClock, seeded
  ]) {
    assert.equal(typeof fn, 'function');
  }
  assert.equal(REPO_ROOT, path.join(__dirname, '..'));
});

test('setup: listeners run in order with the event, this = the target; duplicates are ignored', () => {
  resetStubs();
  const el = stubElement('button');
  const calls = [];
  const a = function (e) { calls.push(['a', e.type, this === el, e.target === el, e.currentTarget === el]); };
  const b = (e) => calls.push(['b', e.detail]);
  el.addEventListener('click', a);
  el.addEventListener('click', b);
  el.addEventListener('click', a); // exact duplicate: ignored
  const handler = { handleEvent(e) { calls.push(['object', e.type]); } };
  el.addEventListener('click', handler);
  el.addEventListener('click', null);
  const event = { type: 'click', detail: 7 };
  assert.equal(el.dispatchEvent(event), true);
  assert.deepEqual(calls, [['a', 'click', true, true, true], ['b', 7], ['object', 'click']]);
  assert.equal(event.currentTarget, null);
  assert.equal(event.defaultPrevented, false);
  assert.equal(typeof event.preventDefault, 'function');

  calls.length = 0;
  el.removeEventListener('click', a);
  el.removeEventListener('click', () => {}); // unknown: ignored
  el.removeEventListener('keydown', b);      // other type: ignored
  el.dispatchEvent({ type: 'click' });
  assert.deepEqual(calls.map((c) => c[0]), ['b', 'object']);
  assert.throws(() => el.dispatchEvent('click'), TypeError);
});

test('setup: capture is part of a listener\'s identity; once and signal remove it', () => {
  resetStubs();
  const el = stubElement();
  const calls = [];
  const fn = (e) => calls.push(e.type);
  el.addEventListener('x', fn);
  el.addEventListener('x', fn, true);
  el.addEventListener('x', fn, { capture: true }); // duplicate of the capture one
  assert.equal(listenerCount(el, 'x'), 2);
  el.removeEventListener('x', fn, { capture: true });
  assert.deepEqual(listenersOf(el, 'x').map((l) => l.capture), [false]);

  const once = () => calls.push('once');
  el.addEventListener('y', once, { once: true, passive: true });
  assert.deepEqual(listenersOf(el, 'y'), [{ type: 'y', listener: once, capture: false, once: true, passive: true }]);
  el.dispatchEvent({ type: 'y' });
  el.dispatchEvent({ type: 'y' });
  assert.deepEqual(calls, ['once']);

  const controller = new AbortController();
  el.addEventListener('z', fn, { signal: controller.signal });
  assert.equal(listenerCount(el, 'z'), 1);
  controller.abort();
  assert.equal(listenerCount(el, 'z'), 0);
  el.addEventListener('z', fn, { signal: controller.signal }); // already aborted
  assert.equal(listenerCount(el, 'z'), 0);
  assert.equal(listenerCount(el), 1);
});

test('setup: preventDefault and the return value of dispatchEvent', () => {
  resetStubs();
  const el = stubElement();
  el.addEventListener('keydown', (e) => e.preventDefault());
  const plain = { type: 'keydown' };
  assert.equal(el.dispatchEvent(plain), false);
  assert.equal(plain.defaultPrevented, true);
  assert.equal(el.dispatchEvent(createEvent('keydown', { cancelable: false })), true);

  // A test's own preventDefault is kept (it sets its own flag).
  const own = { type: 'keydown', prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(el.dispatchEvent(own), true);
  assert.equal(own.prevented, true);

  // A native Event works too: target is filled in, its own preventDefault runs.
  const native = new Event('keydown', { cancelable: true });
  assert.equal(el.dispatchEvent(native), false);
  assert.equal(native.defaultPrevented, true);
  assert.equal(native.target, el);

  // A target that is already set is kept.
  const preset = { type: 'keydown', target: document.body };
  el.dispatchEvent(preset);
  assert.equal(preset.target, document.body);
});

test('setup: listeners added or removed during a dispatch', () => {
  resetStubs();
  const el = stubElement();
  const calls = [];
  const late = () => calls.push('late');
  const second = () => calls.push('second');
  el.addEventListener('x', () => {
    calls.push('first');
    el.addEventListener('x', late);
    el.removeEventListener('x', second);
  });
  el.addEventListener('x', second);
  el.dispatchEvent({ type: 'x' });
  assert.deepEqual(calls, ['first']);
  el.dispatchEvent({ type: 'x' });
  assert.deepEqual(calls, ['first', 'first', 'late']);
});

test('setup: events travel capture, target, bubble through the page to document and window', () => {
  resetStubs();
  const page = createPage({ 'fix-panel': 'div', 'fix-btn': { tagName: 'button', parent: 'fix-panel' } }).install();
  const btn = page.els['fix-btn'];
  const panel = page.els['fix-panel'];
  const order = [];
  const log = (name) => (e) => order.push(name + ':' + (e.currentTarget === e.target ? 'self' : 'up'));
  window.addEventListener('click', log('window-capture'), true);
  document.addEventListener('click', log('document-capture'), true);
  panel.addEventListener('click', log('panel-capture'), true);
  btn.addEventListener('click', log('btn'));
  btn.addEventListener('click', log('btn-capture'), true);
  panel.addEventListener('click', log('panel'));
  document.body.addEventListener('click', log('body'));
  document.addEventListener('click', log('document'));
  window.addEventListener('click', log('window'));
  btn.click();
  assert.deepEqual(order, [
    'window-capture:up', 'document-capture:up', 'panel-capture:up', 'btn-capture:self',
    'btn:self', 'panel:up', 'body:up', 'document:up', 'window:up'
  ]);

  // A non-bubbling event still goes through the capture phase.
  order.length = 0;
  btn.dispatchEvent(createEvent('click', { bubbles: false }));
  assert.deepEqual(order, ['window-capture:up', 'document-capture:up', 'panel-capture:up', 'btn-capture:self', 'btn:self']);

  // A detached element does not reach document.
  order.length = 0;
  const loose = stubElement('button');
  loose.addEventListener('click', log('loose'));
  loose.click();
  assert.deepEqual(order, ['loose:self']);
  page.restore();
});

test('setup: stopPropagation ends after the current node, stopImmediatePropagation at once', () => {
  resetStubs();
  const page = createPage(['fix-a']).install();
  const a = page.els['fix-a'];
  const calls = [];
  a.addEventListener('click', (e) => { calls.push('a1'); e.stopPropagation(); });
  a.addEventListener('click', () => calls.push('a2'));
  document.addEventListener('click', () => calls.push('document'));
  a.click();
  assert.deepEqual(calls, ['a1', 'a2']);

  calls.length = 0;
  const b = page.add('fix-b', 'div');
  b.addEventListener('click', (e) => { calls.push('b1'); e.stopImmediatePropagation(); });
  b.addEventListener('click', () => calls.push('b2'));
  b.click();
  assert.deepEqual(calls, ['b1']);

  // An event's own stopPropagation still runs and still stops the dispatch.
  calls.length = 0;
  const own = { type: 'click', bubbles: true, stopped: 0, stopPropagation() { this.stopped++; } };
  a.dispatchEvent(own);
  assert.equal(own.stopped, 1);
  assert.deepEqual(calls, ['a1', 'a2']);
  assert.equal(Object.prototype.hasOwnProperty.call(own, 'stopPropagation'), true);

  // A native Event's stopPropagation is the prototype's again afterwards.
  const native = new Event('click', { bubbles: true });
  a.dispatchEvent(native);
  assert.equal(Object.prototype.hasOwnProperty.call(native, 'stopPropagation'), false);
  page.restore();
});

test('setup: click() dispatches a bubbling click unless disabled; focus moves activeElement', () => {
  resetStubs();
  const btn = stubElement('button');
  const events = [];
  btn.addEventListener('click', (e) => events.push(e));
  btn.click();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'click');
  assert.equal(events[0].bubbles, true);
  assert.equal(events[0].cancelable, true);
  assert.equal(events[0].button, 0);
  btn.disabled = true;
  btn.click();
  assert.equal(events.length, 1);

  assert.equal(document.activeElement, document.body);
  btn.focus();
  assert.equal(document.activeElement, document.body, 'a disabled element takes no focus');
  btn.disabled = false;
  btn.focus();
  assert.equal(document.activeElement, btn);
  stubElement().blur(); // not focused: nothing changes
  assert.equal(document.activeElement, btn);
  btn.blur();
  assert.equal(document.activeElement, document.body);
  btn.focus();
  resetStubs();
  assert.equal(document.activeElement, document.body);
});

test('setup: createEvent fills browser defaults per type, props win', () => {
  const click = createEvent('click', { clientX: 5 });
  assert.equal(click.type, 'click');
  assert.equal(click.bubbles, true);
  assert.equal(click.cancelable, true);
  assert.equal(click.defaultPrevented, false);
  assert.equal(click.isTrusted, false);
  assert.equal(click.target, null);
  assert.equal(click.clientX, 5);
  click.preventDefault();
  assert.equal(click.defaultPrevented, true);
  click.stopPropagation(); // outside a dispatch: harmless
  click.stopImmediatePropagation();

  const input = createEvent('input');
  assert.equal(input.bubbles, true);
  assert.equal(input.cancelable, false);
  input.preventDefault();
  assert.equal(input.defaultPrevented, false);

  assert.equal(createEvent('focus').bubbles, false);
  assert.equal(createEvent('resize').cancelable, false);
  assert.equal(createEvent('custom').bubbles, false);
  assert.equal(createEvent('custom').cancelable, true);
  assert.equal(createEvent('DOMContentLoaded').bubbles, true);
  assert.equal(createEvent('click', { bubbles: false }).bubbles, false);
});

test('setup: keyEvent sets key, code, keyCode and no modifiers', () => {
  const left = keyEvent('ArrowLeft');
  assert.equal(left.type, 'keydown');
  assert.equal(left.key, 'ArrowLeft');
  assert.equal(left.code, 'ArrowLeft');
  assert.equal(left.keyCode, 37);
  assert.equal(left.which, 37);
  assert.equal(left.bubbles, true);
  assert.equal(left.cancelable, true);
  assert.equal(left.repeat, false);
  for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) assert.equal(left[mod], false);
  const codes = [['a', 'KeyA', 65], ['Z', 'KeyZ', 90], ['7', 'Digit7', 55], [' ', 'Space', 32],
    ['Enter', 'Enter', 13], ['Escape', 'Escape', 27], ['Backspace', 'Backspace', 8],
    ['Shift', 'ShiftLeft', 16], ['F5', 'F5', 116], ['-', 'Minus', 189], ['é', '', 0]];
  for (const [key, code, keyCode] of codes) {
    assert.deepEqual([keyEvent(key).code, keyEvent(key).keyCode], [code, keyCode], key);
  }
  assert.equal(keyEvent('A').shiftKey, false);
  const up = keyEvent('w', { type: 'keyup', ctrlKey: true });
  assert.equal(up.type, 'keyup');
  assert.equal(up.ctrlKey, true);
  const autofill = keyEvent(undefined);
  assert.equal(autofill.key, undefined);
  assert.equal(autofill.code, '');
});

test('setup: touchEvent builds touches, targetTouches and changedTouches', () => {
  const start = touchEvent('touchstart', [10, 20]);
  assert.equal(start.bubbles, true);
  assert.equal(start.cancelable, true);
  assert.equal(start.touches.length, 1);
  assert.equal(start.touches[0].clientX, 10);
  assert.equal(start.touches[0].clientY, 20);
  assert.equal(start.touches[0].pageY, 20);
  assert.equal(start.touches[0].identifier, 0);
  assert.equal(start.targetTouches, start.touches);
  assert.equal(start.changedTouches, start.touches);
  const end = touchEvent('touchend', { clientX: 30, clientY: 40 });
  assert.deepEqual(end.touches, []);
  assert.deepEqual(end.targetTouches, []);
  assert.equal(end.changedTouches[0].clientX, 30);
  const two = touchEvent('touchmove', [[1, 2], { clientX: 3, clientY: 4, force: 0.5 }]);
  assert.deepEqual(two.touches.map((t) => [t.identifier, t.clientX, t.force]), [[0, 1, undefined], [1, 3, 0.5]]);
  assert.equal(touchEvent('touchcancel', []).cancelable, false);
  assert.deepEqual(touchEvent('touchstart').touches, []);
});

test('setup: fire, swipe and pressKey dispatch through the registry', () => {
  resetStubs();
  const page = createPage({ 'fix-sel': 'select', 'fix-go': 'button', 'fix-board': 'div' }).install();
  const changes = [];
  page.els['fix-sel'].addEventListener('change', (e) => changes.push(e.target.id));
  const changed = fire(page.els['fix-sel'], 'change', { detail: 1 });
  assert.deepEqual(changes, ['fix-sel']);
  assert.equal(changed.detail, 1);

  const touches = [];
  ['touchstart', 'touchmove', 'touchend'].forEach((type) => {
    page.els['fix-board'].addEventListener(type, (e) => touches.push([e.type, e.changedTouches[0].clientX]));
  });
  const s = swipe(page.els['fix-board'], [100, 50], [200, 60]);
  assert.deepEqual(touches, [['touchstart', 100], ['touchmove', 200], ['touchend', 200]]);
  assert.equal(s.end.touches.length, 0);

  // pressKey: on document.body by default, bubbling to document and window.
  const keys = [];
  document.addEventListener('keydown', (e) => {
    keys.push([e.key, e.target === document.body ? 'body' : e.target.id]);
    if (e.key === 'ArrowUp') e.preventDefault();
  });
  window.addEventListener('keydown', (e) => keys.push(['window', e.key]));
  assert.equal(pressKey('ArrowUp').defaultPrevented, true);
  assert.equal(pressKey('ArrowDown').defaultPrevented, false);
  assert.deepEqual(keys, [['ArrowUp', 'body'], ['window', 'ArrowUp'], ['ArrowDown', 'body'], ['window', 'ArrowDown']]);

  // Enter / Space on the focused button click it, unless a listener prevented it.
  const clicks = [];
  page.els['fix-go'].addEventListener('click', () => clicks.push('go'));
  page.els['fix-go'].focus();
  keys.length = 0;
  pressKey('Enter');
  pressKey(' ');
  pressKey('a');
  assert.deepEqual(clicks, ['go', 'go']);
  assert.deepEqual(keys.filter((k) => k[0] !== 'window'), [['Enter', 'fix-go'], [' ', 'fix-go'], ['a', 'fix-go']]);
  page.els['fix-go'].addEventListener('keydown', (e) => e.preventDefault());
  pressKey('Enter');
  assert.deepEqual(clicks, ['go', 'go']);
  // An explicit target wins over the focus.
  keys.length = 0;
  pressKey('x', { target: page.els['fix-board'] });
  assert.deepEqual(keys[0], ['x', 'fix-board']);
  page.restore();
});

test('setup: makeEventTarget turns any object into an event target', () => {
  resetStubs();
  const mq = makeEventTarget(matchMedia('(prefers-color-scheme: dark)'));
  const seen = [];
  const on = mq.addEventListener;
  on('change', (e) => seen.push(e.matches)); // a detached call still works
  assert.equal(mq.dispatchEvent(createEvent('change', { matches: true })), true);
  assert.deepEqual(seen, [true]);
});

test('setup: resetStubs drops document, window and body listeners, and leaves own methods alone', () => {
  resetStubs();
  const calls = [];
  document.addEventListener('keydown', () => calls.push('document'));
  window.addEventListener('resize', () => calls.push('window'));
  document.body.addEventListener('click', () => calls.push('body'));
  const el = stubElement();
  el.addEventListener('click', () => calls.push('el'));
  resetStubs();
  document.dispatchEvent(keyEvent('a'));
  window.dispatchEvent(createEvent('resize'));
  document.body.click();
  el.click();
  assert.deepEqual(calls, ['el']);

  // Recorders a test installs itself keep working and survive resetStubs.
  const realAdd = document.addEventListener;
  const recorded = [];
  document.addEventListener = (type) => recorded.push(type);
  try {
    document.addEventListener('keydown', () => {});
    resetStubs();
    document.addEventListener('keyup', () => {});
    assert.deepEqual(recorded, ['keydown', 'keyup']);
    assert.equal(listenerCount(document), 0);
  } finally {
    document.addEventListener = realAdd;
  }
  const realGet = document.getElementById;
  const mine = () => 'mine';
  document.getElementById = mine;
  try {
    resetStubs();
    assert.equal(document.getElementById, mine);
  } finally {
    document.getElementById = realGet;
  }
});

test('setup: text nodes go into childNodes only and count in textContent', () => {
  const p = stubElement('p');
  const b = stubElement('b');
  b.textContent = '7';
  const text = document.createTextNode(' games');
  assert.equal(text.nodeType, 3);
  assert.equal(text.data, ' games');
  p.appendChild(b);
  p.appendChild(text);
  assert.deepEqual(p.children, [b]);
  assert.deepEqual(p.childNodes, [b, text]);
  assert.equal(text.parentNode, p);
  assert.equal(p.textContent, '7 games');
  text.nodeValue = ' genres';
  assert.equal(p.textContent, '7 genres');
  p.insertBefore(document.createTextNode('All: '), b);
  assert.equal(p.textContent, 'All: 7 genres');
  assert.deepEqual(p.children, [b]);
  text.remove();
  p.removeChild(text); // not a child any more: ignored
  assert.deepEqual(p.children, [b]);
  assert.equal(p.textContent, 'All: 7');

  // textContent replaces the children; innerHTML is not parsed, but its text
  // (tags removed) becomes the element's own text.
  p.textContent = 'a < b';
  assert.equal(p.childNodes.length, 0);
  assert.equal(p.textContent, 'a < b');
  assert.equal(p.innerHTML, 'a &lt; b');
  p.innerHTML = '<span class="x">Hi</span> &amp; bye';
  assert.equal(p.innerHTML, '<span class="x">Hi</span> &amp; bye');
  assert.equal(p.textContent, 'Hi & bye');
  p.innerHTML = '';
  assert.equal(p.textContent, '');
});

test('setup: createPage builds stubs from ids, tag names or props', () => {
  resetStubs();
  const fromIds = createPage(['fix-a', 'fix-b']);
  assert.deepEqual(Object.keys(fromIds.els), ['fix-a', 'fix-b']);
  assert.equal(fromIds.els['fix-a'].tagName, 'DIV');
  assert.equal(fromIds.els['fix-a'].id, 'fix-a');
  assert.equal(fromIds.installed, false);

  const page = createPage({
    'fix-canvas': 'canvas',
    'fix-panel': { tagName: 'section', className: 'fix-panel fix-hidden', hidden: true },
    'fix-btn': {
      tag: 'button', parent: 'fix-panel', textContent: 'Go', disabled: true,
      attributes: { 'aria-label': 'Start', 'data-level': '2' }, style: 'display: none; --fix-size: 4'
    },
    'fix-sel': { tagName: 'select', value: 'hard', dataset: { mode: 'x' } }
  });
  const { els } = page;
  assert.equal(els['fix-canvas'].tagName, 'CANVAS');
  assert.equal(els['fix-canvas'].width, 300);
  assert.equal(els['fix-panel'].tagName, 'SECTION');
  assert.equal(els['fix-panel'].classList.contains('fix-hidden'), true);
  assert.equal(els['fix-panel'].hidden, true);
  assert.equal(els['fix-btn'].parentNode, els['fix-panel']);
  assert.equal(els['fix-panel'].parentNode, page.root);
  assert.equal(els['fix-btn'].textContent, 'Go');
  assert.equal(els['fix-btn'].disabled, true);
  assert.equal(els['fix-btn'].getAttribute('aria-label'), 'Start');
  assert.equal(els['fix-btn'].dataset.level, '2');
  assert.equal(els['fix-btn'].style.display, 'none');
  assert.equal(els['fix-btn'].style['--fix-size'], '4');
  assert.equal(els['fix-sel'].value, 'hard');
  assert.equal(els['fix-sel'].dataset.mode, 'x');
  assert.equal(page.get('fix-btn'), els['fix-btn']);
  assert.equal(page.get('nope'), null);
  assert.equal(page.add('fix-late', { tagName: 'span', parent: 'fix-panel' }).parentNode, els['fix-panel']);
  assert.throws(() => createPage({ x: { parent: 'missing' } }), /unknown parent "missing"/);
  assert.throws(() => createPage('fix-a'), TypeError);
});

test('setup: an installed page answers getElementById and #id selectors, restore undoes it', () => {
  resetStubs();
  const page = createPage({ 'fix-a': 'div', 'fix-b': 'span' });
  assert.equal(page.install(), page);
  assert.equal(page.installed, true);
  assert.equal(page.install(), page); // no-op while installed
  assert.equal(document.getElementById('fix-a'), page.els['fix-a']);
  assert.equal(document.getElementById('nope'), null);
  assert.equal(document.querySelector('#fix-b'), page.els['fix-b']);
  assert.equal(document.querySelector(' #fix-a '), page.els['fix-a']);
  assert.equal(document.querySelector('.fix-a'), null);
  assert.deepEqual(document.querySelectorAll('#fix-b'), [page.els['fix-b']]);
  assert.deepEqual(document.querySelectorAll('#nope'), []);
  assert.deepEqual(page.requested, ['fix-a', 'nope', 'fix-b']);

  // Simple selectors match the page tree, elements a game appended included.
  const cell = document.createElement('input');
  cell.className = 'fix-cell fix-given';
  page.els['fix-a'].appendChild(cell);
  const other = document.createElement('span');
  other.className = 'fix-cell';
  page.els['fix-a'].appendChild(other);
  assert.deepEqual(document.querySelectorAll('.fix-cell'), [cell, other]);
  assert.deepEqual(document.querySelectorAll('input.fix-cell.fix-given'), [cell]);
  assert.deepEqual(document.querySelectorAll('span'), [other, page.els['fix-b']]); // document order
  assert.deepEqual(document.querySelectorAll('div, input'), [page.els['fix-a'], cell]);
  assert.equal(document.querySelector('.fix-cell'), cell);
  assert.equal(document.querySelector('.fix-none'), null);
  assert.equal(document.querySelectorAll('*').length, 4);
  // Attribute selectors read attributes and dataset.
  assert.deepEqual(document.querySelectorAll('[data-x]'), []);
  other.dataset.x = '1';
  assert.deepEqual(document.querySelectorAll('[data-x]'), [other]);
  assert.equal(document.querySelector('span[data-x="1"]'), other);
  // Anything else goes to the previous lookup (the stub's null / []).
  assert.equal(document.querySelector('#fix-a .fix-cell'), null);
  assert.deepEqual(document.querySelectorAll('.fix-cell:first-child'), []);
  assert.equal(page.root.parentNode, document.body);

  const lookup = document.getElementById;
  assert.equal(page.restore(), page);
  assert.equal(page.restore(), page); // idempotent
  assert.equal(page.installed, false);
  assert.equal(document.getElementById('fix-a'), null);
  assert.equal(page.root.parentNode, null);
  // A stale copy of the page's lookup (put back by t.mock, say) forwards to the original.
  assert.equal(lookup('fix-a'), null);

  const lenient = createPage(['fix-a'], { createMissing: true }).install();
  const made = document.getElementById('fix-extra');
  assert.equal(made.tagName, 'DIV');
  assert.equal(made.id, 'fix-extra');
  assert.equal(document.getElementById('fix-extra'), made);
  assert.deepEqual(lenient.missing, ['fix-extra']);
  resetStubs(); // restores the page too
  assert.equal(lenient.installed, false);
  assert.equal(document.getElementById('fix-a'), null);
});

test('setup: a page installed under a t.mock of getElementById comes undone cleanly', (t) => {
  resetStubs();
  const page = createPage(['fix-a']).install();
  t.mock.method(document, 'getElementById', () => 'mocked');
  page.restore(); // the mock is in place: left alone
  assert.equal(document.getElementById('fix-a'), 'mocked');
  t.mock.restoreAll(); // puts the page's lookup back, which now forwards
  assert.equal(document.getElementById('fix-a'), null);
  page.install();
  assert.equal(document.getElementById('fix-a'), page.els['fix-a']);
  page.restore();
  assert.equal(document.getElementById('fix-a'), null);
});

test('setup: loadWithPage loads a script with its page installed, keep leaves it', () => {
  resetStubs();
  const file = fixture('load-game.js', GAME_SOURCE);
  const first = loadWithPage(file, GAME_PAGE);
  assert.equal(first.exports.board, first.els['fix-board']);
  assert.equal(first.exports.state.inits, 0, 'module exists: init is skipped');
  assert.equal(first.page.installed, false);
  assert.equal(document.getElementById('fix-board'), null);
  assert.equal(typeof first.restore, 'function');

  const kept = loadWithPage(file, GAME_PAGE, { keep: true });
  assert.notEqual(kept.exports.state, first.exports.state, 'a fresh copy');
  assert.equal(document.getElementById('fix-new'), kept.els['fix-new']);
  kept.exports.init();
  kept.els['fix-new'].click();
  assert.equal(kept.els['fix-board'].textContent, 'new');
  pressKey('ArrowLeft');
  assert.deepEqual(kept.exports.state.keys, ['ArrowLeft']);
  kept.restore();
  assert.equal(document.getElementById('fix-new'), null);

  // A page passed in is used as is; one already installed stays installed.
  const page = createPage(GAME_PAGE).install();
  const reused = loadWithPage(file, page);
  assert.equal(reused.els, page.els);
  assert.equal(page.installed, true);
  resetStubs();

  const broken = fixture('load-broken.js', 'document.getElementById("fix-board").x = 1; throw new Error("boom");');
  assert.throws(() => loadWithPage(broken, GAME_PAGE, { keep: true }), /boom/);
  assert.equal(document.getElementById('fix-board'), null);
});

test('setup: bootLikeBrowser runs the browser start-up and exposes window names', () => {
  resetStubs();
  delete window.fixState; // left by the loadWithPage test (the script sets it in both modes)
  const file = fixture('boot-game.js', GAME_SOURCE);
  const b = bootLikeBrowser(file, GAME_PAGE);
  assert.equal(b.window, window);
  assert.equal(b.document, document);
  assert.equal(window.fixState.inits, 1, 'no module in scope: init ran');
  assert.deepEqual(Object.keys(b.exposed), ['fixState']);
  assert.equal(b.exposed.fixState, window.fixState);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(pressKey('ArrowUp').defaultPrevented, true);
  b.els['fix-new'].click();
  assert.equal(b.els['fix-board'].textContent, 'new');
  assert.deepEqual(b.page.requested, ['fix-board', 'fix-new']);
  const state = window.fixState;

  // restore is a page unload: page, listeners and window names go.
  b.restore();
  b.restore();
  assert.equal(window.fixState, undefined);
  assert.equal(listenerCount(document, 'keydown'), 0);
  assert.equal(document.getElementById('fix-board'), null);
  pressKey('ArrowLeft');
  assert.deepEqual(state.keys, ['ArrowUp']);

  // A name that existed before the boot gets its old value back.
  window.fixState = 'from an earlier loadScript';
  const again = bootLikeBrowser(file, GAME_PAGE);
  assert.equal(again.exposed.fixState.inits, 1);
  again.restore();
  assert.equal(window.fixState, 'from an earlier loadScript');
  delete window.fixState;
});

test('setup: bootLikeBrowser with readyState loading waits for ready()', () => {
  resetStubs();
  delete window.fixState;
  const file = fixture('boot-loading.js', GAME_SOURCE);
  const order = [];
  window.addEventListener('DOMContentLoaded', () => order.push('window DOMContentLoaded ' + document.readyState));
  window.addEventListener('load', () => order.push('load ' + document.readyState));
  const b = bootLikeBrowser(file, GAME_PAGE, { readyState: 'loading' });
  assert.equal(document.readyState, 'loading');
  assert.equal(window.fixState.inits, 0);
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  b.ready();
  assert.equal(window.fixState.inits, 1);
  assert.equal(document.readyState, 'complete');
  assert.deepEqual(order, ['window DOMContentLoaded interactive', 'load complete']);
  resetStubs(); // undoes the boot as well
  assert.equal(document.readyState, 'complete');
  assert.equal(window.fixState, undefined);
  assert.equal(listenerCount(document), 0);
  assert.equal(document.getElementById('fix-board'), null);
});

test('setup: bootLikeBrowser keeps the readyState it found, reports errors at the file', () => {
  resetStubs();
  delete window.fixState;
  document.readyState = 'interactive';
  try {
    const b = bootLikeBrowser(fixture('boot-interactive.js', GAME_SOURCE), GAME_PAGE);
    assert.equal(window.fixState.inits, 1);
    b.restore();
    assert.equal(document.readyState, 'interactive');
  } finally {
    document.readyState = 'complete';
  }

  const file = fixture('boot-throws.js', 'window.fixLeft = 1;\nvar fixTop = 2;\n\nnull.boom();\n');
  let error;
  try {
    bootLikeBrowser(file, GAME_PAGE);
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof TypeError);
  assert.ok(error.stack.includes(file + ':4'), error.stack);
  assert.equal(window.fixLeft, undefined, 'restored after the throw');
  assert.equal(globalThis.fixTop, undefined);
  assert.equal(document.getElementById('fix-board'), null);

  // options.source runs other text under the file's name.
  const src = bootLikeBrowser(file, ['fix-board'], { source: 'window.fixFromSource = document.getElementById("fix-board").id;' });
  assert.equal(window.fixFromSource, 'fix-board');
  src.restore();
  assert.equal(window.fixFromSource, undefined);
});

test('setup: bootLikeBrowser runs the inline scripts of an HTML file at their own lines', () => {
  resetStubs();
  const html = [
    '<!doctype html>',
    '<html><head><script src="other.js"></script>',
    '<script type="application/json">{"not": "run"}</script></head>',
    '<body><p id="fix-out"></p>',
    '<script>',
    '  document.getElementById("fix-out").textContent = "first";',
    '</script>',
    '<script>window.fixSecond = document.getElementById("fix-out").textContent + " second";</script>',
    '<script>',
    '',
    '  null.fixLineEleven();',
    '</script>',
    '</body></html>'
  ].join('\n');
  const file = fixture('page.html', html);
  let error;
  try {
    bootLikeBrowser(file, htmlPageSpec(html));
  } catch (e) {
    error = e;
  }
  assert.ok(error.stack.includes(file + ':11'), error.stack);

  const ok = fixture('page-ok.html', html.replace('  null.fixLineEleven();', ''));
  const b = bootLikeBrowser(ok, htmlPageSpec(html));
  assert.equal(b.els['fix-out'].textContent, 'first');
  assert.equal(window.fixSecond, 'first second');
  b.restore();
});

test('setup: readRepoFile reads from the repo root; package.json has the test and coverage scripts', () => {
  const pkg = JSON.parse(readRepoFile('package.json'));
  assert.equal(pkg.scripts.test, 'node tests/run.js');
  assert.equal(pkg.scripts.coverage, 'node tests/run.js --coverage');
  assert.deepEqual(Object.keys(pkg).filter((k) => /dependencies/i.test(k)), []);
  const runner = readRepoFile('tests/run.js');
  assert.match(runner, /COVERAGE_MIN = \[22, 10, 0\]/);
  assert.match(runner, /coverageIncludeGlobs = COVERAGE_GLOBS/);
  assert.match(runner, /COVERAGE_GLOBS = \['\*\/script\.js'\]/);
  // npm run coverage fails below these floors; plain npm test has none.
  assert.match(runner, /COVERAGE_THRESHOLDS = \{ lineCoverage: 100, branchCoverage: 100, functionCoverage: 100 \}/);
  assert.match(runner, /if \(coverage\) \{[^}]*Object\.assign\(options, COVERAGE_THRESHOLDS\);/);
});

test('setup: readRepoFile turns CRLF line endings into LF (Windows checkouts)', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vahac-crlf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'script.js');
  fs.writeFileSync(file, "(function () {\r\n  'use strict';\r\n})();\r\n");
  assert.equal(readRepoFile(file), "(function () {\n  'use strict';\n})();\n");
});

const SAMPLE_HTML = [
  '<!doctype html><html><head><style>#not-an-id { color: red; }</style></head><body>',
  '<!-- <div id="commented"></div> -->',
  '<div class="fix-wrapper" id="fix-wrap">',
  '  <h1 id="fix-title" class="fix-title">Mines &amp; more</h1>',
  '  <canvas id="fix-canvas" width="600" height="400"></canvas>',
  '  <section id="fix-panel" hidden><div><button id="fix-go" type="button" disabled aria-label="Go now" data-level="2">Go</button></div></section>',
  '  <select id="fix-level"><option value="easy">Easy</option><option value="hard" selected>Hard</option></select>',
  '  <select id="fix-speed"><option>Slow</option><option>Fast</option></select>',
  '  <input id="fix-name" value="Ann" readonly>',
  '  <textarea id="fix-text">typed</textarea>',
  '  <p id="fix-rich">a <b>b</b></p>',
  '  <span id="fix-styled" style="display: none; --fix-x: 2"></span>',
  '  <p id="fix-title">duplicate</p>',
  '</div>',
  '<script src="script.js"></script>',
  '<script>var s = \'<div id="in-script"></div>\';</script>',
  '</body></html>'
].join('\n');

test('setup: idsInHtml lists the markup ids in order, duplicates kept', () => {
  assert.deepEqual(idsInHtml(SAMPLE_HTML), [
    'fix-wrap', 'fix-title', 'fix-canvas', 'fix-panel', 'fix-go', 'fix-level', 'fix-speed',
    'fix-name', 'fix-text', 'fix-rich', 'fix-styled', 'fix-title'
  ]);
  assert.deepEqual(idsInHtml('<a data-id="x" id=\'y\'><b id=z></b>'), ['y', 'z']);
});

test('setup: htmlPageSpec mirrors tags, nesting, classes, text and form values', () => {
  const spec = htmlPageSpec(SAMPLE_HTML);
  assert.deepEqual(spec['fix-wrap'], { tagName: 'div', className: 'fix-wrapper' });
  assert.deepEqual(spec['fix-title'], { tagName: 'h1', parent: 'fix-wrap', className: 'fix-title', textContent: 'Mines & more' });
  assert.deepEqual(spec['fix-canvas'], {
    tagName: 'canvas', parent: 'fix-wrap', width: 600, height: 400, attributes: { width: '600', height: '400' }
  });
  assert.equal(spec['fix-panel'].hidden, true);
  assert.deepEqual(spec['fix-go'], {
    tagName: 'button', parent: 'fix-panel', type: 'button', disabled: true, textContent: 'Go',
    attributes: { type: 'button', disabled: '', 'aria-label': 'Go now', 'data-level': '2' }
  });
  assert.equal(spec['fix-level'].value, 'hard');
  assert.equal(spec['fix-speed'].value, 'Slow');
  assert.equal(spec['fix-name'].value, 'Ann');
  assert.equal(spec['fix-name'].readOnly, true);
  assert.equal(spec['fix-text'].value, 'typed');
  assert.equal(spec['fix-rich'].textContent, undefined, 'mixed content is left to the game');
  assert.deepEqual(spec['fix-styled'].style, { display: 'none', '--fix-x': '2' });
  assert.equal(spec.commented, undefined);
  assert.equal(spec['in-script'], undefined);

  const page = createPage(spec);
  assert.equal(page.els['fix-go'].parentNode, page.els['fix-panel']);
  assert.equal(page.els['fix-wrap'].contains(page.els['fix-go']), true);
  assert.equal(page.els['fix-go'].getAttribute('aria-label'), 'Go now');
  assert.equal(page.els['fix-go'].dataset.level, '2');
  assert.equal(page.els['fix-canvas'].getBoundingClientRect().width, 600);
  assert.equal(page.els['fix-title'].textContent, 'Mines & more');
});

test('setup: embedMarkup and embedSafety find what would break the WordPress block', () => {
  const markup = embedMarkup(SAMPLE_HTML);
  assert.ok(markup.startsWith('<div class="fix-wrapper" id="fix-wrap">'));
  assert.ok(markup.endsWith('</div>\n'));
  assert.equal(embedMarkup('<div class="other">'), '');
  assert.deepEqual(embedSafety(markup), []);
  assert.deepEqual(embedSafety('var a = 1;\n/* x */'), []);
  const found = embedSafety('ok\nif (a<!--b) {}\n// -->\n"</SCRIPT>"');
  assert.deepEqual(found.map((f) => [f.token, f.line, f.column]), [['<!--', 2, 6], ['-->', 3, 4], ['</script', 4, 2]]);
  assert.equal(found[0].index, 8);
  assert.match(found[2].excerpt, /<\/SCRIPT>/);
});

test('setup: cssRules reads rules, media, supports and keyframes', () => {
  const css = `
    /* a { color: red } */
    @charset "utf-8";
    .fix-a, .fix-b  .fix-c { color: red; background: url("data:image/png;base64,AA==") ; color : blue }
    :is(.fix-x, .fix-y) > p { margin: 0 !important }
    @media (max-width: 480px) {
      .fix-a { padding: 8px; }
      @media (min-width: 30em) { .fix-a { padding: 9px; } }
    }
    @media (prefers-reduced-motion: reduce) { .fix-a { transition: none; } }
    @media (width >= 600px) and (width <= 900px) { .fix-a { gap: 2px; } }
    @supports (display: grid) { .fix-a { display: grid; } }
    @keyframes fix-pop { from { opacity: 0; } 50% { opacity: .5; } }
    @font-face { font-family: X; src: url(x.woff); }
    .fix-a { content: "{"; }
  `;
  const rules = cssRules(css);
  assert.deepEqual(rules[0], {
    selectors: ['.fix-a', '.fix-b .fix-c'],
    decls: { color: 'blue', background: 'url("data:image/png;base64,AA==")' },
    media: '', maxWidth: Infinity, minWidth: 0, supports: '', keyframes: ''
  });
  assert.deepEqual(rules[1].selectors, [':is(.fix-x, .fix-y) > p']);
  assert.equal(rules[1].decls.margin, '0 !important');
  assert.deepEqual([rules[2].media, rules[2].maxWidth, rules[2].minWidth], ['(max-width: 480px)', 480, 0]);
  assert.deepEqual([rules[3].media, rules[3].maxWidth, rules[3].minWidth], ['(max-width: 480px) and (min-width: 30em)', 480, 480]);
  assert.equal(rules[4].media, '(prefers-reduced-motion: reduce)');
  assert.deepEqual([rules[5].minWidth, rules[5].maxWidth], [600, 900]);
  assert.equal(rules[6].supports, '(display: grid)');
  assert.deepEqual(rules.filter((r) => r.keyframes).map((r) => [r.keyframes, r.selectors[0]]), [['fix-pop', 'from'], ['fix-pop', '50%']]);
  assert.equal(rules.some((r) => r.selectors.includes('@font-face')), false);
  assert.equal(rules[rules.length - 1].decls.content, '"{"');
  assert.equal(rules.length, 10);
});

test('setup: declsAt merges the rules that apply at a viewport width', () => {
  const rules = cssRules(`
    .fix-a { padding: 16px; color: red; }
    @media (max-width: 480px) { .fix-a { padding: 8px; } }
    @media (min-width: 1000px) { .fix-a { padding: 24px; } }
    @media (prefers-reduced-motion: reduce) { .fix-a { color: gray; } }
    @media screen and (max-width: 360px) { .fix-a  { color: blue; } }
    @keyframes fix-a { from { padding: 0; } }
    .fix-b { padding: 1px; }
  `);
  assert.deepEqual(declsAt(rules, '.fix-a', 320), { padding: '8px', color: 'blue' });
  assert.deepEqual(declsAt(rules, '.fix-a', 480), { padding: '8px', color: 'red' });
  assert.deepEqual(declsAt(rules, '.fix-a', 768), { padding: '16px', color: 'red' });
  assert.deepEqual(declsAt(rules, '.fix-a', 1280), { padding: '24px', color: 'red' });
  const reduced = { matchMedia: (media) => media === '(prefers-reduced-motion: reduce)' };
  assert.deepEqual(declsAt(rules, ' .fix-a ', 768, reduced), { padding: '16px', color: 'gray' });
  assert.deepEqual(declsAt(rules, '.fix-c', 768), {});
});

test('setup: cssRules matches the parser tests/2048-game.test.js had on the real stylesheet', () => {
  // The old parser: media N for "@media (max-width: Npx)", Infinity outside.
  function oldRules(css) {
    const rules = [];
    const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{|([^{}]+)\{([^{}]*)\}|\}/g;
    let media = Infinity;
    let m;
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    while ((m = re.exec(css))) {
      if (m[1]) media = Number(m[1]);
      else if (m[2] !== undefined) {
        const decls = {};
        for (const d of m[3].split(';')) {
          const i = d.indexOf(':');
          if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        }
        rules.push({ media, selectors: m[2].split(',').map((s) => s.trim()), decls });
      } else media = Infinity;
    }
    return rules;
  }
  const css = readRepoFile('2048-game/style.css');
  const simple = !/@(?!media\s*\(max-width:\s*\d+px\))/.test(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  if (!simple) return; // the stylesheet grew other at-rules: the old parser no longer applies
  assert.deepEqual(
    cssRules(css).map((r) => ({ media: r.maxWidth, selectors: r.selectors, decls: r.decls })),
    oldRules(css).map((r) => ({ media: r.media, selectors: r.selectors.map((s) => s.replace(/\s+/g, ' ')), decls: r.decls }))
  );
});

// ── Helpers added with the refactor of every game ───────────────────────────

test('setup: document has an html element holding body; events on it reach document', () => {
  resetStubs();
  const html = document.documentElement;
  assert.equal(html.tagName, 'HTML');
  assert.equal(document.body.parentNode, html);
  const page = createPage({ 'fix-btn': 'button' }).install();
  const order = [];
  html.addEventListener('keydown', () => order.push('html'));
  document.addEventListener('keydown', () => order.push('document'));
  window.addEventListener('keydown', () => order.push('window'));
  pressKey('a', { target: page.els['fix-btn'] });
  assert.deepEqual(order, ['html', 'document', 'window']);
  order.length = 0;
  html.dispatchEvent(keyEvent('b'));
  assert.deepEqual(order, ['html', 'document', 'window'], 'a key on <html> reaches document');

  // A test may replace or delete it; resetStubs puts the default back.
  document.documentElement = stubElement('html');
  resetStubs();
  assert.equal(document.documentElement, html);
  assert.equal(listenerCount(html), 0, 'resetStubs drops its listeners');
  delete document.documentElement;
  resetStubs();
  assert.equal(document.documentElement, html);
  assert.equal(document.body.parentNode, html);
});

test('setup: setVisibility changes visibilityState and hidden and fires a bubbling visibilitychange', () => {
  resetStubs();
  assert.equal(document.visibilityState, 'visible');
  assert.equal(document.hidden, false);
  const seen = [];
  document.addEventListener('visibilitychange', (e) => seen.push(['document', document.visibilityState, e.bubbles]));
  window.addEventListener('visibilitychange', () => seen.push(['window', document.hidden]));
  const event = setVisibility('hidden');
  assert.equal(event.type, 'visibilitychange');
  assert.equal(event.cancelable, false);
  assert.deepEqual(seen, [['document', 'hidden', true], ['window', true]]);

  // With a test context the defaults come back after that test.
  const after = [];
  setVisibility('hidden', { after: (fn) => after.push(fn) });
  assert.equal(after.length, 1);
  after[0]();
  assert.equal(document.visibilityState, 'visible');
  assert.equal(document.hidden, false);
  setVisibility('hidden');
  resetStubs();
  assert.equal(document.visibilityState, 'visible');
  assert.equal(document.hidden, false);
});

test('setup: taking the focused element out of the page puts the focus back on body', () => {
  resetStubs();
  const page = createPage({
    'fix-list': 'div',
    'fix-a': { tagName: 'button', parent: 'fix-list' },
    'fix-b': { tagName: 'button', parent: 'fix-list' },
    'fix-other': 'div'
  }).install();
  const { 'fix-list': list, 'fix-a': a, 'fix-b': b, 'fix-other': other } = page.els;
  a.focus();
  list.removeChild(b);
  assert.equal(document.activeElement, a, 'another element leaving keeps the focus');
  list.removeChild(a);
  assert.equal(document.activeElement, document.body, 'removeChild');
  list.appendChild(a);
  a.focus();
  other.appendChild(a);
  assert.equal(document.activeElement, document.body, 'a move to another parent');
  a.focus();
  other.appendChild(a);
  assert.equal(document.activeElement, document.body, 'appended again to the same parent');
  a.focus();
  other.remove();
  assert.equal(document.activeElement, document.body, 'an ancestor removed');
  page.root.appendChild(other);
  a.focus();
  other.innerHTML = '';
  assert.equal(document.activeElement, document.body, 'innerHTML replaced');
  list.appendChild(a);
  a.focus();
  list.textContent = 'gone';
  assert.equal(document.activeElement, document.body, 'textContent replaced');
  page.restore();
});

test('setup: element querySelector, matches and closest read simple selectors', () => {
  resetStubs();
  const page = createPage({
    'fix-board': { tagName: 'div', className: 'fix-board' },
    'fix-row': { tagName: 'div', parent: 'fix-board', attributes: { role: 'row', 'aria-label': 'Row one' } },
    'fix-cell': { tagName: 'button', parent: 'fix-row', className: 'fix-cell fix-open', attributes: { 'data-col': '3' } },
    'fix-box': { tagName: 'input', parent: 'fix-board', type: 'checkbox' }
  }).install();
  const { 'fix-board': board, 'fix-row': row, 'fix-cell': cell, 'fix-box': box } = page.els;
  cell.dataset.row = '0'; // set the way a game sets it, not as an attribute
  assert.equal(board.querySelector('button'), cell);
  assert.deepEqual(board.querySelectorAll('.fix-cell, input'), [cell, box]);
  assert.equal(board.querySelector(`[data-row="0"][data-col='3']`), cell);
  assert.equal(board.querySelector('[data-row=1]'), null);
  assert.equal(row.querySelector('input'), null, 'descendants only');
  assert.equal(cell.matches('button.fix-open#fix-cell'), true);
  assert.equal(cell.matches('[role]'), false);
  assert.equal(row.matches('[role=row]'), true);
  assert.equal(row.matches('[aria-label^="Row"]'), true);
  assert.equal(row.matches('[aria-label$="one"]'), true);
  assert.equal(row.matches('[aria-label*="w o"]'), true);
  assert.equal(row.matches('[aria-label~="one"]'), true);
  assert.equal(row.matches('[aria-label~=""]'), false);
  assert.equal(cell.matches('[class|="fix"]'), true);
  assert.equal(cell.closest('[role="row"]'), row);
  assert.equal(cell.closest('.fix-board'), board);
  assert.equal(cell.closest('.fix-cell'), cell, 'closest starts at the element itself');
  assert.equal(cell.closest('section'), null);

  assert.equal(box.matches(':checked'), false);
  box.checked = true;
  assert.equal(box.matches('input:checked'), true);
  cell.disabled = true;
  assert.equal(cell.matches(':disabled'), true);
  assert.equal(cell.matches(':enabled'), false);
  cell.disabled = false;
  cell.focus();
  assert.equal(cell.matches(':focus'), true);
  assert.equal(cell.matches(':focus-visible'), false, 'focus() is not keyboard focus');
  assert.equal(row.matches(':focus-within'), true);
  assert.equal(box.matches(':focus-within'), false);

  // What it cannot read gives what the stubs always gave.
  for (const selector of ['.fix-board .fix-cell', 'div > button', ':first-child', 'button:not(.x)', '::before', '']) {
    assert.equal(cell.matches(selector), false, selector);
    assert.equal(cell.closest(selector), null, selector);
    assert.equal(board.querySelector(selector), null, selector);
    assert.deepEqual(board.querySelectorAll(selector), [], selector);
  }
  page.restore();
});

test('setup: focusElement fires blur, focusout, focus and focusin; keyboard focus is :focus-visible', () => {
  resetStubs();
  const page = createPage({ 'fix-a': 'button', 'fix-b': 'button' }).install();
  const { 'fix-a': a, 'fix-b': b } = page.els;
  const name = (el) => (el ? (el === document.body ? 'body' : el.id) : null);
  const log = [];
  for (const type of ['blur', 'focusout', 'focus', 'focusin']) {
    document.addEventListener(type, (e) => log.push([type, name(e.target), name(e.relatedTarget), name(document.activeElement), e.bubbles]), true);
  }
  assert.equal(focusElement(a, { keyboard: true }), true);
  assert.deepEqual(log, [['focus', 'fix-a', null, 'fix-a', false], ['focusin', 'fix-a', null, 'fix-a', true]]);
  assert.equal(a.matches(':focus-visible'), true);
  log.length = 0;
  assert.equal(focusElement(a), false, 'already focused: nothing fires');
  assert.deepEqual(log, []);
  assert.equal(focusElement(b), true);
  assert.deepEqual(log, [
    ['blur', 'fix-a', 'fix-b', 'body', false], ['focusout', 'fix-a', 'fix-b', 'body', true],
    ['focus', 'fix-b', 'fix-a', 'fix-b', false], ['focusin', 'fix-b', 'fix-a', 'fix-b', true]
  ]);
  assert.equal(a.matches(':focus-visible'), false);
  assert.equal(b.matches(':focus-visible'), false, 'a mouse click or a tap');

  focusElement(a, { keyboard: true });
  a.focus();
  assert.equal(a.matches(':focus-visible'), true, 'focus() on the focused element keeps it');
  b.focus();
  a.focus();
  assert.equal(a.matches(':focus-visible'), false, 'focus() from elsewhere is not keyboard focus');
  focusElement(b, { keyboard: true });
  b.blur();
  assert.equal(document.activeElement, document.body);
  b.focus();
  assert.equal(b.matches(':focus-visible'), false, 'blur() ends keyboard focus');
  a.disabled = true;
  assert.equal(focusElement(a), false, 'a disabled element takes no focus');
  assert.equal(document.activeElement, b);
  page.restore();
});

test('setup: typeInto sets the value and fires input, and refuses disabled or read-only fields', () => {
  resetStubs();
  const page = createPage({ 'fix-form': 'form', 'fix-field': { tagName: 'input', parent: 'fix-form' } }).install();
  const field = page.els['fix-field'];
  const seen = [];
  document.addEventListener('input', (e) => seen.push([e.target.value, e.inputType, e.data, e.bubbles]));
  assert.equal(typeInto(field, 7).type, 'input');
  assert.equal(field.value, '7');
  typeInto(field, '');
  typeInto(field, 'x', { inputType: 'insertFromPaste' });
  assert.deepEqual(seen, [['7', 'insertText', '7', true], ['', 'deleteContentBackward', null, true], ['x', 'insertFromPaste', 'x', true]]);
  field.disabled = true;
  assert.throws(() => typeInto(field, '1'), /#fix-field is disabled/);
  field.disabled = false;
  field.readOnly = true;
  assert.throws(() => typeInto(field, '1'), /#fix-field is read-only/);
  assert.equal(field.value, 'x', 'a refused field keeps its value');
  assert.throws(() => typeInto(null, '1'), TypeError);
  page.restore();
});

test('setup: blockStorage makes localStorage fail like a browser until restore', (t) => {
  resetStubs();
  localStorage.setItem('fix-key', 'kept');
  const restore = blockStorage();
  for (const read of [() => localStorage, () => window.localStorage]) {
    assert.throws(read, (e) => e instanceof DOMException && e.name === 'SecurityError');
  }
  restore();
  restore();
  assert.equal(localStorage.getItem('fix-key'), 'kept');
  assert.equal(window.localStorage, localStorage);

  blockStorage('full');
  assert.throws(() => localStorage.setItem('fix-key', 'new'), (e) => e instanceof DOMException && e.name === 'QuotaExceededError');
  assert.equal(localStorage.getItem('fix-key'), 'kept', 'reads still work');
  resetStubs(); // undoes the block, then empties the storage
  blockStorage();
  resetStubs(); // also with access blocked
  localStorage.setItem('fix-key', 'again');
  assert.equal(localStorage.getItem('fix-key'), 'again');

  assert.throws(() => blockStorage(['getItem', 'nope']), TypeError);
  assert.equal(localStorage.getItem('fix-key'), 'again', 'an unknown kind blocks nothing');
  blockStorage(['getItem', 'removeItem'], t);
  assert.throws(() => localStorage.getItem('fix-key'), (e) => e.name === 'SecurityError');
  assert.throws(() => localStorage.removeItem('fix-key'), (e) => e.name === 'SecurityError');
  localStorage.setItem('fix-key', 'set still works');
  // t.after undoes this block when the test ends: the next test reads the key.
});

test('setup: blockStorage given a test context is undone after that test', () => {
  assert.equal(localStorage.getItem('fix-key'), 'set still works');
  resetStubs();
});

test('setup: useClock moves timers, performance.now and animation frames together', (t) => {
  resetStubs();
  t.mock.timers.enable({ apis: ['setTimeout'] }); // already enabled: useClock starts it again
  const clock = useClock(t, { now: 1000, frames: true });
  const log = [];
  setTimeout(() => log.push(['timeout', performance.now()]), 5);
  const id = setInterval(() => log.push(['interval', performance.now()]), 4);
  requestAnimationFrame((ts) => log.push(['frame', ts]));
  assert.equal(clock.now(), 1000);
  clock.advance(1);
  assert.deepEqual(log, [['frame', 1001]]);
  assert.equal(clock.at(8), clock);
  clearInterval(id);
  assert.deepEqual(log, [['frame', 1001], ['interval', 1004], ['timeout', 1005], ['interval', 1008]]);
  assert.equal(clock.elapsed(), 8);
  assert.throws(() => clock.at(7), /behind the clock/);
  clock.advance(10);
  assert.equal(log.length, 4, 'nothing else was due');
});

test('setup: seeded gives the same numbers in [0, 1) for the same seed', () => {
  const take = (random) => Array.from({ length: 20 }, () => random());
  const first = take(seeded(42));
  assert.deepEqual(take(seeded(42)), first);
  assert.notDeepEqual(take(seeded(43)), first);
  for (const x of first) assert.ok(x >= 0 && x < 1);
  // The mulberry32 sequence the game tests were written against.
  const one = seeded(1);
  assert.equal(one(), 0.6270739405881613);
  assert.equal(one(), 0.002735721180215478);
});

