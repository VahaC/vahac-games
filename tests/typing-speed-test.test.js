// tests/typing-speed-test.test.js
// Typing Speed Test (typing-speed-test/, prefix tst-).
//
// The game keeps its state in closures (tstState, tstElements) and every function writes
// straight to the DOM, so the tests drive it the way the page does: a fake DOM with the ids
// from index.html is installed before the script loads (tstElements is captured at load
// time), then the exported functions and the listeners tstBindEvents attaches are called.
// Timers are mocked, so the 60-second countdown runs instantly and never keeps Node alive.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScript, stubElement, resetStubs } = require('./_setup');

const GAME_DIR = path.join(__dirname, '..', 'typing-speed-test');
const STORAGE_KEY = 'tst-state';

// ── Fake DOM ────────────────────────────────────────────────────────────────

let dom = {};
const realGetElementById = document.getElementById;
document.getElementById = (id) => (Object.prototype.hasOwnProperty.call(dom, id) ? dom[id] : null);
test.after(() => { document.getElementById = realGetElementById; });

function fakeElement(tag, id, props) {
  const el = stubElement(tag);
  el.id = id;
  el.listeners = {};
  el.addEventListener = (type, fn) => { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  Object.assign(el, props || {});
  return el;
}

// Initial values mirror index.html (the selected <option>, the 0 / 100% / 60 placeholders
// and the tst-hidden classes).
function buildDom() {
  return {
    'tst-difficulty': fakeElement('select', 'tst-difficulty', { value: 'medium' }),
    'tst-new-game': fakeElement('button', 'tst-new-game'),
    'tst-restart-game': fakeElement('button', 'tst-restart-game'),
    'tst-text-display': fakeElement('div', 'tst-text-display'),
    'tst-input': fakeElement('textarea', 'tst-input'),
    'tst-wpm': fakeElement('span', 'tst-wpm', { textContent: '0' }),
    'tst-accuracy': fakeElement('span', 'tst-accuracy', { textContent: '100%' }),
    'tst-timer': fakeElement('span', 'tst-timer', { textContent: '60' }),
    'tst-best': fakeElement('span', 'tst-best', { textContent: '0' }),
    'tst-result': fakeElement('section', 'tst-result', { className: 'tst-result tst-hidden' }),
    'tst-result-text': fakeElement('p', 'tst-result-text'),
    'tst-toast': fakeElement('div', 'tst-toast', { className: 'tst-toast tst-hidden' })
  };
}

// Fresh DOM, empty storage and a freshly loaded script (new closures) for every test.
function boot() {
  resetStubs();
  dom = buildDom();
  return loadScript('typing-speed-test/script.js');
}

function fire(id, type) {
  (dom[id].listeners[type] || []).forEach((fn) => fn({ type: type, target: dom[id] }));
}

function typeInto(value) {
  dom['tst-input'].value = value;
  fire('tst-input', 'input');
}

const text = (id) => dom[id].textContent;
const isHidden = (id) => dom[id].classList.contains('tst-hidden');
const saved = () => JSON.parse(localStorage.getItem(STORAGE_KEY));
const expectedWpm = (correctChars, elapsedSeconds) =>
  Math.round((correctChars / 5) / ((elapsedSeconds || 1) / 60));

// ── Markup and data ─────────────────────────────────────────────────────────

test('typing: every id the script looks up exists in index.html', () => {
  const js = fs.readFileSync(path.join(GAME_DIR, 'script.js'), 'utf8');
  const html = fs.readFileSync(path.join(GAME_DIR, 'index.html'), 'utf8');
  const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(ids.length, 12);
  for (const id of ids) {
    assert.ok(html.includes('id="' + id + '"'), id + ' is missing from index.html');
    assert.ok(Object.prototype.hasOwnProperty.call(buildDom(), id), id + ' is missing from the fake DOM');
  }
  assert.ok(html.includes('<option value="medium" selected>'));
});

test('typing: opened on its own, the page has no margin and the wrapper background, kept out of the embed', () => {
  const css = fs.readFileSync(path.join(GAME_DIR, 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(GAME_DIR, 'index.html'), 'utf8');

  // Without this rule the body is transparent with the browser's 8px margin: light
  // text vanishes in a light browser theme and a white frame shows round the game.
  const bg = css.match(/--tst-bg:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));

  // build-embed copies the markup from the wrapper up to the first <script> only,
  // so the body rule never reaches WordPress.
  const embedded = html.slice(html.indexOf('<div class="tst-wrapper"'), html.indexOf('<script'));
  assert.equal(/<style/i.test(embedded), false, 'no <style> in the embedded markup');
});

test('typing: three difficulty pools of two sentences, longer as difficulty rises', () => {
  const tst = boot();
  assert.deepEqual(Object.keys(tst.tstTexts), ['easy', 'medium', 'hard']);
  const avg = (pool) => pool.reduce((sum, s) => sum + s.length, 0) / pool.length;
  for (const level of ['easy', 'medium', 'hard']) {
    const pool = tst.tstTexts[level];
    assert.equal(pool.length, 2);
    for (const sentence of pool) {
      // tstRenderText writes each character into innerHTML unescaped.
      assert.doesNotMatch(sentence, /[<>&"]/);
      assert.match(sentence, /^[A-Z].*\.$/);
    }
  }
  assert.ok(avg(tst.tstTexts.easy) < avg(tst.tstTexts.medium));
  assert.ok(avg(tst.tstTexts.medium) < avg(tst.tstTexts.hard));
});

// ── Text selection and rendering ────────────────────────────────────────────

test('typing: tstPickText picks from the current difficulty with Math.random', (t) => {
  const tst = boot();
  let roll = 0;
  t.mock.method(Math, 'random', () => roll);

  tst.tstState.difficulty = 'hard';
  tst.tstPickText();
  assert.equal(tst.tstState.text, tst.tstTexts.hard[0]);

  roll = 0.999;
  tst.tstPickText();
  assert.equal(tst.tstState.text, tst.tstTexts.hard[1]);

  roll = 0.5;
  tst.tstState.difficulty = 'easy';
  tst.tstPickText();
  assert.equal(tst.tstState.text, tst.tstTexts.easy[1]);
});

test('typing: tstRenderText marks typed characters correct or wrong and the next one current', () => {
  const tst = boot();
  const span = (cls, ch) => '<span class="' + cls + '">' + ch + '</span>';
  tst.tstState.text = 'cat';

  tst.tstRenderText('');
  assert.equal(dom['tst-text-display'].innerHTML, span('tst-char-current', 'c') + span('', 'a') + span('', 't'));

  tst.tstRenderText('cx');
  assert.equal(dom['tst-text-display'].innerHTML,
    span('tst-char-correct', 'c') + span('tst-char-wrong', 'a') + span('tst-char-current', 't'));

  // Characters typed past the end of the text are not rendered.
  tst.tstRenderText('cats');
  assert.equal(dom['tst-text-display'].innerHTML,
    span('tst-char-correct', 'c') + span('tst-char-correct', 'a') + span('tst-char-correct', 't'));
});

// ── Scoring ─────────────────────────────────────────────────────────────────

test('typing: WPM is correct characters / 5 per elapsed minute, accuracy is correct / typed', () => {
  const tst = boot();
  const sentence = tst.tstTexts.easy[0];
  tst.tstState.text = sentence;
  tst.tstState.timer = 30; // 30 s elapsed

  dom['tst-input'].value = sentence.slice(0, 50);
  tst.tstCalculateStats();
  assert.equal(text('tst-wpm'), '20');
  assert.equal(text('tst-wpm'), String(expectedWpm(50, 30)));
  assert.equal(text('tst-accuracy'), '100%');

  // 45 right, 5 wrong: only the right ones count as words.
  dom['tst-input'].value = sentence.slice(0, 45) + '#####';
  tst.tstCalculateStats();
  assert.equal(text('tst-wpm'), '18');
  assert.equal(text('tst-accuracy'), '90%');

  // Typing past the end of the text counts the extra characters as wrong.
  dom['tst-input'].value = sentence + 'zzz';
  tst.tstCalculateStats();
  assert.equal(text('tst-accuracy'), Math.round(sentence.length / (sentence.length + 3) * 100) + '%');
});

test('typing: before the first tick and in the first second, elapsed time counts as one second', () => {
  const tst = boot();
  tst.tstState.text = tst.tstTexts.medium[0];

  tst.tstState.timer = 60;
  dom['tst-input'].value = '';
  tst.tstCalculateStats();
  assert.equal(text('tst-wpm'), '0');
  assert.equal(text('tst-accuracy'), '100%');

  dom['tst-input'].value = tst.tstState.text.slice(0, 5); // one word
  tst.tstCalculateStats();
  assert.equal(text('tst-wpm'), '60');

  tst.tstState.timer = 59;
  tst.tstCalculateStats();
  assert.equal(text('tst-wpm'), '60');

  // After the clock has run out the divisor is the full minute.
  tst.tstState.timer = 0;
  tst.tstCalculateStats();
  assert.equal(text('tst-wpm'), '1');
});

test('typing: best WPM rises and is saved only when it is beaten', () => {
  const tst = boot();
  tst.tstState.text = tst.tstTexts.easy[0];
  tst.tstState.difficulty = 'easy';
  tst.tstState.timer = 30;

  dom['tst-input'].value = tst.tstState.text.slice(0, 50);
  tst.tstCalculateStats();
  assert.equal(tst.tstState.bestWpm, 20);
  assert.equal(text('tst-best'), '20');
  assert.deepEqual(saved(), { bestWpm: 20, difficulty: 'easy' });

  localStorage.removeItem(STORAGE_KEY);
  dom['tst-input'].value = tst.tstState.text.slice(0, 25);
  tst.tstCalculateStats();
  assert.equal(text('tst-wpm'), '10');
  assert.equal(tst.tstState.bestWpm, 20);
  assert.equal(text('tst-best'), '20');
  assert.equal(localStorage.getItem(STORAGE_KEY), null);
});

// ── Persistence ─────────────────────────────────────────────────────────────

test('typing: best WPM and difficulty round-trip through localStorage "tst-state"', () => {
  const tst = boot();
  tst.tstState.bestWpm = 87;
  tst.tstState.difficulty = 'hard';
  tst.tstSaveState();
  assert.equal(localStorage.getItem(STORAGE_KEY), '{"bestWpm":87,"difficulty":"hard"}');

  tst.tstState.bestWpm = 0;
  tst.tstState.difficulty = 'medium';
  tst.tstLoadState();
  assert.equal(tst.tstState.bestWpm, 87);
  assert.equal(tst.tstState.difficulty, 'hard');
  assert.equal(text('tst-best'), '87');
  assert.equal(dom['tst-difficulty'].value, 'hard');

  // Missing fields fall back to 0 and medium.
  localStorage.setItem(STORAGE_KEY, '{}');
  tst.tstLoadState();
  assert.equal(tst.tstState.bestWpm, 0);
  assert.equal(tst.tstState.difficulty, 'medium');

  // No saved state: nothing changes.
  localStorage.removeItem(STORAGE_KEY);
  tst.tstState.bestWpm = 5;
  tst.tstLoadState();
  assert.equal(tst.tstState.bestWpm, 5);
});

test('typing: tstInit restores the saved game, deals a text from that pool and binds the controls', (t) => {
  const tst = boot();
  t.mock.method(Math, 'random', () => 0);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ bestWpm: 42, difficulty: 'easy' }));

  tst.tstInit();
  assert.equal(text('tst-best'), '42');
  assert.equal(dom['tst-difficulty'].value, 'easy');
  assert.equal(tst.tstState.text, tst.tstTexts.easy[0]);
  assert.ok(dom['tst-text-display'].innerHTML.startsWith('<span class="tst-char-current">T</span>'));
  assert.equal(text('tst-timer'), '60');
  assert.equal(tst.tstState.started, false);
  assert.equal(isHidden('tst-result'), true);
  assert.deepEqual(saved(), { bestWpm: 42, difficulty: 'easy' });

  // New Game and Restart are the same action; the select resets too.
  assert.deepEqual(dom['tst-new-game'].listeners.click, [tst.tstResetGame]);
  assert.deepEqual(dom['tst-restart-game'].listeners.click, [tst.tstResetGame]);
  assert.deepEqual(dom['tst-difficulty'].listeners.change, [tst.tstResetGame]);
  assert.equal(dom['tst-input'].listeners.input.length, 1);
});

// ── A whole round ───────────────────────────────────────────────────────────

test('typing: the first keystroke starts the clock and finishing the text ends the round at once', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const tst = boot();
  t.mock.method(Math, 'random', () => 0);
  tst.tstInit();
  const sentence = tst.tstTexts.medium[0];
  assert.equal(tst.tstState.text, sentence);

  typeInto(sentence[0]);
  assert.equal(tst.tstState.started, true);
  t.mock.timers.tick(10000);
  assert.equal(text('tst-timer'), '50');

  for (let i = 2; i <= sentence.length; i++) typeInto(sentence.slice(0, i));
  const wpm = String(expectedWpm(sentence.length, 10));
  assert.equal(text('tst-wpm'), wpm);
  assert.equal(isHidden('tst-result'), false);
  assert.equal(text('tst-result-text'), 'Final WPM: ' + wpm + ' | Accuracy: 100%');
  assert.equal(text('tst-toast'), 'Session completed');
  assert.equal(isHidden('tst-toast'), false);
  assert.deepEqual(saved(), { bestWpm: Number(wpm), difficulty: 'medium' });

  // The clock is stopped and the toast hides after two seconds.
  t.mock.timers.tick(5000);
  assert.equal(text('tst-timer'), '50');
  assert.equal(isHidden('tst-toast'), true);
});

test('typing: the countdown ends the round at 0 with the WPM of the last keystroke', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const tst = boot();
  tst.tstInit();

  typeInto(tst.tstState.text[0]);
  assert.equal(text('tst-wpm'), String(expectedWpm(1, 0)));

  t.mock.timers.tick(59000);
  assert.equal(text('tst-timer'), '1');
  assert.equal(isHidden('tst-result'), true);

  t.mock.timers.tick(1000);
  assert.equal(text('tst-timer'), '0');
  assert.equal(isHidden('tst-result'), false);
  // WPM is only recomputed on input, so the result shows the value from the first keystroke.
  assert.equal(text('tst-result-text'), 'Final WPM: 12 | Accuracy: 100%');

  t.mock.timers.tick(3000);
  assert.equal(text('tst-timer'), '0');
  assert.equal(tst.tstState.timer, 0);
  assert.equal(isHidden('tst-toast'), true);
});

test('typing: changing difficulty mid-round stops the clock, resets the board and saves the choice', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const tst = boot();
  t.mock.method(Math, 'random', () => 0.9);
  tst.tstInit();

  typeInto(tst.tstState.text[0] + '#');
  t.mock.timers.tick(5000);
  assert.equal(text('tst-timer'), '55');
  assert.equal(text('tst-accuracy'), '50%');

  dom['tst-difficulty'].value = 'hard';
  fire('tst-difficulty', 'change');
  assert.equal(tst.tstState.started, false);
  assert.equal(tst.tstState.timer, 60);
  assert.equal(tst.tstState.text, tst.tstTexts.hard[1]);
  assert.equal(dom['tst-input'].value, '');
  assert.equal(text('tst-timer'), '60');
  assert.equal(text('tst-wpm'), '0');
  assert.equal(text('tst-accuracy'), '100%');
  assert.equal(saved().difficulty, 'hard');

  t.mock.timers.tick(3000);
  assert.equal(text('tst-timer'), '60');

  // Restart after a finished round hides the result again.
  tst.tstFinishGame();
  assert.equal(isHidden('tst-result'), false);
  fire('tst-restart-game', 'click');
  assert.equal(isHidden('tst-result'), true);
});

test('typing: tstShowToast shows the message and hides it after 2 seconds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tst = boot();

  tst.tstShowToast('Hello');
  assert.equal(text('tst-toast'), 'Hello');
  assert.equal(isHidden('tst-toast'), false);
  t.mock.timers.tick(1999);
  assert.equal(isHidden('tst-toast'), false);
  t.mock.timers.tick(1);
  assert.equal(isHidden('tst-toast'), true);
});
