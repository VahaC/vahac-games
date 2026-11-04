// tests/_smoke.test.js
// Pins the test harness itself: tests/_setup.js loads and every browser stub a
// game relies on exists and behaves as documented there.  It also keeps
// `npm test` green before any game has tests of its own (tests/run.js exits 1
// when it finds no *.test.js files).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, stubElement, createStorage, flushAnimationFrames, resetStubs
} = require('./_setup');

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
