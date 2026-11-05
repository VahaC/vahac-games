// tests/typing-speed-test.test.js
// Typing Speed Test (typing-speed-test/, prefix tst-).
//
// The page tests boot the real script.js the way a browser runs it
// (bootLikeBrowser with every element of index.html) and play through the
// listeners its init registered: input events on the textarea, clicks and key
// presses on the buttons, change on the select.  They read the result back from
// the page and from localStorage ('tst-state').  The clock is mocked: the 1 s
// countdown and the 2 s toast run on t.mock.timers, and performance.now moves
// with them one millisecond at a time, so every WPM below is exact.  The
// scoring and save-parsing functions are pure and are loaded with loadScript
// (under Node the start-up guard skips init).  The last tests read index.html,
// style.css and script.js themselves.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, resetStubs, createPage, bootLikeBrowser, readRepoFile, idsInHtml,
  htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, fire, pressKey, listenerCount
} = require('./_setup');

const SCRIPT = 'typing-speed-test/script.js';
const HTML = readRepoFile('typing-speed-test/index.html');
const CSS = readRepoFile('typing-speed-test/style.css');
const JS = readRepoFile(SCRIPT);
const STORAGE_KEY = 'tst-state';

// The sentence pools exactly as the game ships them.
const POOLS = {
  easy: [
    'Typing fast requires rhythm and consistency more than raw speed.',
    'Cyberpunk interfaces make keyboard training feel futuristic and immersive.'
  ],
  medium: [
    'Developers often improve productivity dramatically after mastering touch typing and keyboard shortcuts.',
    'Typing accuracy matters because excessive mistakes reduce effective words per minute performance.'
  ],
  hard: [
    'The futuristic terminal glowed intensely while holographic dashboards streamed complex diagnostics across the neon interface.',
    'Professional programmers frequently rely on mechanical keyboards, rapid command execution, and efficient typing habits.'
  ]
};

// With Math.random() at 0 a fresh page deals the first Medium sentence (103 characters).
const SENTENCE = POOLS.medium[0];

const ELEMENT_IDS = [
  'tst-difficulty', 'tst-new-game', 'tst-restart-game', 'tst-text-display', 'tst-input', 'tst-wpm',
  'tst-accuracy', 'tst-timer', 'tst-best', 'tst-result', 'tst-result-text', 'tst-toast'
];

const tst = loadScript(SCRIPT);

test.beforeEach(() => resetStubs());
test.afterEach(() => resetStubs());

// ── Helpers ─────────────────────────────────────────────────────────────────

const span = (cls, ch) => '<span class="' + cls + '">' + ch + '</span>';

// The page clock: setInterval / setTimeout run on t.mock.timers and
// performance.now moves with them 1 ms at a time, so a tick sees the time it
// fires at.  clock.at(ms) advances to ms after useClock was called.
function useClock(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let now = 50000;
  t.mock.method(performance, 'now', () => now);
  const clock = {
    elapsed: 0,
    advance(ms) {
      for (let i = 0; i < ms; i++) {
        now += 1;
        clock.elapsed += 1;
        t.mock.timers.tick(1);
      }
    },
    at(ms) {
      assert.ok(ms >= clock.elapsed, 'the clock only moves forward');
      clock.advance(ms - clock.elapsed);
    },
    // Moves performance.now only, as when a phone suspends the page and its timers.
    suspend(ms) {
      now += ms;
    }
  };
  return clock;
}

// Math.random() returns rnd.value (0 deals the first sentence of a pool).
function mockRandom(t, value) {
  const rnd = { value };
  t.mock.method(Math, 'random', () => rnd.value);
  return rnd;
}

// Spies on setInterval / clearInterval (after useClock, before the boot):
// running() is the number of intervals the game started and never cleared.
function trackIntervals(t) {
  const set = t.mock.method(globalThis, 'setInterval');
  const clear = t.mock.method(globalThis, 'clearInterval');
  return {
    started: () => set.mock.callCount(),
    running: () => set.mock.calls.filter((call) =>
      !clear.mock.calls.some((c) => c.arguments[0] === call.result)).length
  };
}

// What a player sees and does on a page: els by id, typing (one input event
// per call, like a keystroke, a deletion or a paste) and the visible values.
function pageView(els, boot) {
  const input = els['tst-input'];
  const hidden = (id) => els[id].classList.contains('tst-hidden');
  const view = {
    els,
    boot,
    type(value) {
      input.value = value;
      fire(input, 'input');
    },
    // Types text after what is already in the box, one input event per character.
    typeOn(text) {
      for (const ch of text) view.type(input.value + ch);
    },
    stats: () => ({
      wpm: els['tst-wpm'].textContent,
      accuracy: els['tst-accuracy'].textContent,
      time: els['tst-timer'].textContent,
      best: els['tst-best'].textContent
    }),
    result: () => (hidden('tst-result') ? null : els['tst-result-text'].textContent),
    toast: () => (hidden('tst-toast') ? null : els['tst-toast'].textContent),
    sentence: () => els['tst-text-display'].textContent,
    marks: () => els['tst-text-display'].innerHTML,
    saved: () => localStorage.getItem(STORAGE_KEY),
    locked: () => input.readOnly === true
  };
  return view;
}

// Boots the game like a browser page.  options.save is the raw 'tst-state'
// text already stored, options.readyState the document's state while the
// script runs, options.page another page to boot on.
function openPage(options = {}) {
  if (options.save !== undefined) localStorage.setItem(STORAGE_KEY, options.save);
  const boot = bootLikeBrowser(SCRIPT, options.page || htmlPageSpec(HTML), { readyState: options.readyState });
  return pageView(boot.els, boot);
}

const FRESH = { wpm: '0', accuracy: '100%', time: '60', best: '0' };

// ── Start-up ────────────────────────────────────────────────────────────────

test('typing: a ready page starts at once: a Medium sentence, 0 WPM, 100%, 60 s, best 0, controls bound', (t) => {
  useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  assert.equal(g.sentence(), SENTENCE);
  assert.ok(g.marks().startsWith(span('tst-char-current', 'D') + span('', 'e') + span('', 'v')));
  assert.equal(g.marks().split('<span ').length - 1, SENTENCE.length);
  assert.deepEqual(g.stats(), FRESH);
  assert.equal(g.result(), null);
  assert.equal(g.toast(), null);
  assert.equal(g.els['tst-difficulty'].value, 'medium');
  assert.equal(g.els['tst-input'].value, '');
  assert.equal(g.locked(), false);
  // The first visit stores the defaults.
  assert.equal(g.saved(), '{"bestWpm":0,"difficulty":"medium"}');

  // One listener per control and nothing on document or window.
  assert.equal(listenerCount(g.els['tst-new-game'], 'click'), 1);
  assert.equal(listenerCount(g.els['tst-restart-game'], 'click'), 1);
  assert.equal(listenerCount(g.els['tst-difficulty'], 'change'), 1);
  assert.equal(listenerCount(g.els['tst-input'], 'input'), 1);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
});

test('typing: while the document is still loading, init waits for DOMContentLoaded', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage({ readyState: 'loading' });

  assert.equal(g.marks(), '');
  assert.equal(g.saved(), null);
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(g.els['tst-input'], 'input'), 0);

  g.boot.ready();
  assert.equal(g.sentence(), SENTENCE);
  assert.equal(listenerCount(g.els['tst-input'], 'input'), 1);
  g.type('D');
  clock.at(1000);
  assert.equal(g.stats().time, '59');
});

test('typing: run from <head> before the markup exists, the game finds its elements at DOMContentLoaded', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  // The script runs while the page has none of the game's elements yet ...
  const boot = openPage({ readyState: 'loading', page: createPage({}) }).boot;
  // ... then the parser reaches the body and DOMContentLoaded fires.
  const page = createPage(htmlPageSpec(HTML)).install();
  boot.ready();

  const g = pageView(page.els, boot);
  assert.equal(g.sentence(), SENTENCE);
  assert.deepEqual(g.stats(), FRESH);
  g.type('D');
  clock.at(1000);
  assert.equal(g.stats().time, '59');
});

test('typing: loaded under Node the script exports its logic and runs nothing: no init, listeners or timers', (t) => {
  const timers = ['setInterval', 'setTimeout'].map((name) => t.mock.method(globalThis, name));
  const page = createPage(htmlPageSpec(HTML)).install();
  const exported = loadScript(SCRIPT);

  assert.equal(typeof exported.tstComputeStats, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['tst-text-display'].innerHTML, '');
  for (const id of ELEMENT_IDS) assert.equal(listenerCount(page.els[id]), 0, id);
  assert.equal(listenerCount(document), 0);
  assert.equal(localStorage.getItem(STORAGE_KEY), null);
  assert.deepEqual(timers.map((m) => m.mock.callCount()), [0, 0]);
});

test('typing: every id the script looks up exists in index.html, and the ids there are unique', (t) => {
  useClock(t);
  mockRandom(t, 0);
  const g = openPage();
  assert.deepEqual([...g.boot.page.requested].sort(), [...ELEMENT_IDS].sort());

  const ids = idsInHtml(HTML);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ELEMENT_IDS) assert.ok(ids.includes(id), id + ' is missing from index.html');
});

// ── Pure logic ──────────────────────────────────────────────────────────────

test('typing: three pools of two sentences, unchanged, longer as the difficulty rises', () => {
  assert.deepEqual(tst.tstTexts, POOLS);
  assert.deepEqual(Object.keys(tst.tstTexts), ['easy', 'medium', 'hard']);
  for (const pool of Object.values(POOLS)) {
    for (const sentence of pool) {
      // The display writes each character into innerHTML as it is.
      assert.doesNotMatch(sentence, /[<>&"]/);
      assert.match(sentence, /^[A-Z].*\.$/);
    }
  }
  const avg = (pool) => pool.reduce((sum, s) => sum + s.length, 0) / pool.length;
  assert.ok(avg(POOLS.easy) < avg(POOLS.medium));
  assert.ok(avg(POOLS.medium) < avg(POOLS.hard));
});

test('typing: tstIsDifficulty accepts only the three pool names', () => {
  for (const name of ['easy', 'medium', 'hard']) assert.equal(tst.tstIsDifficulty(name), true, name);
  const bad = ['', 'Easy', 'insane', '__proto__', 'constructor', 'toString', 'hasOwnProperty',
    null, undefined, 1, ['easy'], {}];
  for (const value of bad) assert.equal(tst.tstIsDifficulty(value), false, String(value));
});

test('typing: tstPickText picks a sentence of the pool with Math.random', (t) => {
  const rnd = mockRandom(t, 0);
  assert.equal(tst.tstPickText('hard'), POOLS.hard[0]);
  rnd.value = 0.4999;
  assert.equal(tst.tstPickText('hard'), POOLS.hard[0]);
  rnd.value = 0.5;
  assert.equal(tst.tstPickText('hard'), POOLS.hard[1]);
  rnd.value = 0.999999;
  assert.equal(tst.tstPickText('hard'), POOLS.hard[1]);
  assert.equal(tst.tstPickText('easy'), POOLS.easy[1]);
});

test('typing: tstCharClasses marks typed characters correct or wrong and the next one current', () => {
  const C = 'tst-char-correct';
  const W = 'tst-char-wrong';
  const N = 'tst-char-current';
  assert.deepEqual(tst.tstCharClasses('cat', ''), [N, '', '']);
  assert.deepEqual(tst.tstCharClasses('cat', 'c'), [C, N, '']);
  assert.deepEqual(tst.tstCharClasses('cat', 'cx'), [C, W, N]);
  assert.deepEqual(tst.tstCharClasses('cat', 'cat'), [C, C, C]);
  // Characters typed past the end of the text get no span (and no current one).
  assert.deepEqual(tst.tstCharClasses('cat', 'cats'), [C, C, C]);
  // Spaces are characters like any other.
  assert.deepEqual(tst.tstCharClasses('a b', 'a'), [C, N, '']);
  assert.deepEqual(tst.tstCharClasses('a b', 'ax'), [C, W, N]);
  assert.deepEqual(tst.tstCharClasses('a b', 'a  '), [C, C, W]);
  assert.deepEqual(tst.tstCharClasses('', 'x'), []);
});

test('typing: tstCountCorrect compares position by position and tstAccuracy is correct / typed', () => {
  assert.equal(tst.tstCountCorrect('cat', ''), 0);
  assert.equal(tst.tstCountCorrect('cat', 'cat'), 3);
  assert.equal(tst.tstCountCorrect('cat', 'cut'), 2);
  assert.equal(tst.tstCountCorrect('cat', 'act'), 1);
  assert.equal(tst.tstCountCorrect('cat', 'cats'), 3);
  assert.equal(tst.tstCountCorrect('cat', 'xcat'), 0);

  assert.equal(tst.tstAccuracy(0, 0), 100);
  assert.equal(tst.tstAccuracy(3, 3), 100);
  assert.equal(tst.tstAccuracy(2, 3), 67);
  assert.equal(tst.tstAccuracy(1, 3), 33);
  assert.equal(tst.tstAccuracy(0, 5), 0);
  assert.equal(tst.tstAccuracy(45, 50), 90);
  assert.equal(tst.tstAccuracy(103, 106), 97);
});

test('typing: tstWpm is correct characters / 5 per minute, never over less than one second', () => {
  assert.equal(tst.tstWpm(0, 0), 0);
  // One word in under a second counts as one word in one second.
  assert.equal(tst.tstWpm(5, 0), 60);
  assert.equal(tst.tstWpm(5, 999), 60);
  assert.equal(tst.tstWpm(5, 1000), 60);
  assert.equal(tst.tstWpm(5, 2000), 30);
  assert.equal(tst.tstWpm(5, 60000), 1);
  assert.equal(tst.tstWpm(50, 30000), 20);
  assert.equal(tst.tstWpm(103, 10000), 124);
  assert.equal(tst.tstWpm(103, 10500), 118);
  assert.equal(tst.tstWpm(103, 1), 1236);
  assert.equal(tst.tstWpm(30, 60000), 6);
  assert.equal(tst.tstWpm(3, 60000), 1);
  assert.equal(tst.tstWpm(1, 60000), 0);
});

test('typing: tstComputeStats gives the WPM and accuracy of what is typed', () => {
  assert.deepEqual(tst.tstComputeStats(SENTENCE, '', 0), { wpm: 0, accuracy: 100 });
  assert.deepEqual(tst.tstComputeStats(SENTENCE, SENTENCE.slice(0, 50), 30000), { wpm: 20, accuracy: 100 });
  // 45 right, 5 wrong: only the right ones count as words.
  assert.deepEqual(tst.tstComputeStats(SENTENCE, SENTENCE.slice(0, 45) + '#####', 30000), { wpm: 18, accuracy: 90 });
  // Typing past the end counts the extra characters as wrong.
  assert.deepEqual(tst.tstComputeStats(SENTENCE, SENTENCE + 'zzz', 60000), { wpm: 21, accuracy: 97 });
});

test('typing: tstParseSave keeps a valid save and falls back field by field, never throwing', () => {
  const cases = [
    // [raw 'tst-state' text, bestWpm, difficulty]
    [null, 0, 'medium'],
    [undefined, 0, 'medium'],
    ['', 0, 'medium'],
    ['{"bestWpm":87,"difficulty":"hard"}', 87, 'hard'],
    ['{"bestWpm":1236,"difficulty":"easy"}', 1236, 'easy'],
    ['{}', 0, 'medium'],
    ['{"bestWpm":42}', 42, 'medium'],
    ['{"difficulty":"easy"}', 0, 'easy'],
    ['{', 0, 'medium'],
    ['null', 0, 'medium'],
    ['[]', 0, 'medium'],
    ['"x"', 0, 'medium'],
    ['42', 0, 'medium'],
    ['true', 0, 'medium'],
    ['{"difficulty":"insane","bestWpm":30}', 30, 'medium'],
    ['{"difficulty":"__proto__"}', 0, 'medium'],
    ['{"difficulty":"constructor"}', 0, 'medium'],
    ['{"difficulty":null}', 0, 'medium'],
    ['{"difficulty":["easy"]}', 0, 'medium'],
    ['{"bestWpm":"abc","difficulty":"easy"}', 0, 'easy'],
    ['{"bestWpm":{}}', 0, 'medium'],
    ['{"bestWpm":[]}', 0, 'medium'],
    ['{"bestWpm":-5}', 0, 'medium'],
    ['{"bestWpm":1e999}', 0, 'medium'],
    ['{"bestWpm":"Infinity"}', 0, 'medium'],
    ['{"bestWpm":null}', 0, 'medium'],
    ['{"bestWpm":true}', 0, 'medium'],
    ['{"bestWpm":""}', 0, 'medium'],
    ['{"bestWpm":"  "}', 0, 'medium'],
    ['{"bestWpm":0}', 0, 'medium'],
    // A number stored as text still counts, as it always did; fractions are dropped.
    ['{"bestWpm":"50","difficulty":"hard"}', 50, 'hard'],
    ['{"bestWpm":12.7}', 12, 'medium']
  ];
  for (const [raw, bestWpm, difficulty] of cases) {
    assert.deepEqual(tst.tstParseSave(raw), { bestWpm, difficulty }, String(raw));
  }
});

// ── Saves ───────────────────────────────────────────────────────────────────

test('typing: a save written by the original version loads unchanged', (t) => {
  useClock(t);
  mockRandom(t, 0.5);
  // The exact text the first release wrote under 'tst-state'.
  const g = openPage({ save: '{"bestWpm":87,"difficulty":"hard"}' });
  assert.deepEqual(g.stats(), { wpm: '0', accuracy: '100%', time: '60', best: '87' });
  assert.equal(g.els['tst-difficulty'].value, 'hard');
  assert.equal(g.sentence(), POOLS.hard[1]);
  assert.ok(g.marks().startsWith(span('tst-char-current', 'P') + span('', 'r')));
  assert.equal(g.result(), null);
  assert.equal(g.saved(), '{"bestWpm":87,"difficulty":"hard"}');

  // A reload with a large best already stored (pastes once saved four figures).
  g.boot.restore();
  const again = openPage({ save: '{"bestWpm":1236,"difficulty":"easy"}' });
  assert.equal(again.stats().best, '1236');
  assert.equal(again.sentence(), POOLS.easy[1]);
  assert.equal(again.saved(), '{"bestWpm":1236,"difficulty":"easy"}');
});

test('typing: a corrupt or invalid save never breaks the page: each field falls back and the game still plays', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const cases = [
    // [stored text, best shown, difficulty used]
    ['{', '0', 'medium'],
    ['null', '0', 'medium'],
    ['[]', '0', 'medium'],
    ['"x"', '0', 'medium'],
    ['{"difficulty":"insane","bestWpm":30}', '30', 'medium'],
    ['{"difficulty":"__proto__"}', '0', 'medium'],
    ['{"difficulty":"constructor","bestWpm":5}', '5', 'medium'],
    ['{"difficulty":null}', '0', 'medium'],
    ['{"bestWpm":"abc","difficulty":"easy"}', '0', 'easy'],
    ['{"bestWpm":{}}', '0', 'medium'],
    ['{"bestWpm":-5}', '0', 'medium'],
    ['{"bestWpm":1e999}', '0', 'medium'],
    ['{"bestWpm":"50","difficulty":"hard"}', '50', 'hard']
  ];
  for (const [save, best, difficulty] of cases) {
    resetStubs();
    const g = openPage({ save });
    const sentence = POOLS[difficulty][0];
    assert.equal(g.stats().best, best, save);
    assert.equal(g.els['tst-difficulty'].value, difficulty, save);
    assert.equal(g.sentence(), sentence, save);
    // The cleaned-up values replace the bad save.
    assert.equal(g.saved(), JSON.stringify({ bestWpm: Number(best), difficulty }), save);

    // The controls work: the first keystroke is marked and starts the clock.
    g.type(sentence[0]);
    assert.ok(g.marks().startsWith(span('tst-char-correct', sentence[0])), save);
    clock.advance(1000);
    assert.equal(g.stats().time, '59', save);

    // A finished round beats the cleaned-up best (a pasted sentence: characters / 5 per second).
    g.els['tst-new-game'].click();
    g.type(sentence);
    const wpm = String(Math.round(sentence.length * 12));
    assert.equal(g.result(), 'Final WPM: ' + wpm + ' | Accuracy: 100%', save);
    assert.equal(g.stats().best, wpm, save);
    assert.equal(g.saved(), JSON.stringify({ bestWpm: Number(wpm), difficulty }), save);
  }
});

test('typing: blocked or full storage never stops the game; it plays on without saving', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);

  // Site data blocked: even reading window.localStorage throws.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('The operation is insecure.', 'SecurityError'); }
  });
  try {
    const g = openPage();
    assert.equal(g.sentence(), SENTENCE);
    assert.deepEqual(g.stats(), FRESH);
    g.type(SENTENCE);
    assert.equal(g.result(), 'Final WPM: 1236 | Accuracy: 100%');
    assert.equal(g.stats().best, '1236');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', descriptor);
  }

  // Reading fails.
  resetStubs();
  const getItem = t.mock.method(localStorage, 'getItem', () => { throw new Error('read failed'); });
  const reader = openPage();
  assert.equal(getItem.mock.callCount(), 1);
  assert.equal(reader.sentence(), SENTENCE);
  assert.deepEqual(reader.stats(), FRESH);
  reader.type(SENTENCE);
  assert.equal(reader.stats().best, '1236');
  getItem.mock.restore();
  assert.equal(reader.saved(), '{"bestWpm":1236,"difficulty":"medium"}');

  // Writing fails (quota): init still binds every control and the round still counts.
  resetStubs();
  const setItem = t.mock.method(localStorage, 'setItem', () => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });
  const writer = openPage();
  assert.ok(setItem.mock.callCount() >= 1);
  assert.equal(localStorage.length, 0);
  writer.type('D');
  clock.advance(1000);
  assert.equal(writer.stats().time, '59');
  writer.els['tst-restart-game'].click();
  assert.equal(writer.stats().time, '60');
  writer.type(SENTENCE);
  assert.equal(writer.stats().best, '1236');
  assert.equal(localStorage.length, 0);
});

// ── A round ─────────────────────────────────────────────────────────────────

test('typing: the first keystroke starts the clock and every typed character is marked', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  clock.at(5000);
  assert.equal(g.stats().time, '60', 'the clock waits for the first keystroke');

  g.type('D');
  assert.ok(g.marks().startsWith(span('tst-char-correct', 'D') + span('tst-char-current', 'e') + span('', 'v')));
  // One correct character, counted over the one-second minimum.
  assert.deepEqual(g.stats(), { wpm: '12', accuracy: '100%', time: '60', best: '0' });

  g.type('Dx');
  assert.ok(g.marks().startsWith(span('tst-char-correct', 'D') + span('tst-char-wrong', 'e') + span('tst-char-current', 'v')));
  assert.deepEqual(g.stats(), { wpm: '12', accuracy: '50%', time: '60', best: '0' });

  clock.at(6000);
  assert.equal(g.stats().time, '59');
  clock.at(15000);
  assert.equal(g.stats().time, '50');

  // Two correct characters in 10 s.
  g.type('De');
  assert.deepEqual(g.stats(), { wpm: '2', accuracy: '100%', time: '50', best: '0' });
});

test('typing: finishing the text ends the round at once, scored over the real time taken', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const intervals = trackIntervals(t);
  const g = openPage();

  g.type('D');
  clock.at(10500);
  assert.equal(g.stats().time, '50');
  g.typeOn(SENTENCE.slice(1));

  // 103 correct characters in 10.5 s: 20.6 words / 0.175 min = 117.7.
  assert.equal(g.result(), 'Final WPM: 118 | Accuracy: 100%');
  assert.deepEqual(g.stats(), { wpm: '118', accuracy: '100%', time: '50', best: '118' });
  assert.equal(g.toast(), 'Session completed');
  assert.equal(g.saved(), '{"bestWpm":118,"difficulty":"medium"}');
  assert.equal(g.locked(), true);
  assert.equal(intervals.started(), 1);
  assert.equal(intervals.running(), 0);

  // The clock has stopped; the toast hides after 2 s.
  clock.advance(1999);
  assert.equal(g.toast(), 'Session completed');
  clock.advance(1);
  assert.equal(g.toast(), null);
  clock.advance(5000);
  assert.equal(g.stats().time, '50');
  assert.equal(g.result(), 'Final WPM: 118 | Accuracy: 100%');
  // The game stores nothing but its own key.
  assert.deepEqual([localStorage.length, localStorage.key(0)], [1, STORAGE_KEY]);
});

test('typing: when the clock reaches 0 the round ends, scored over the full 60 seconds', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const intervals = trackIntervals(t);
  const g = openPage();

  g.typeOn(SENTENCE.slice(0, 20));
  clock.at(10000);
  g.typeOn(SENTENCE.slice(20, 30));
  clock.at(59000);
  assert.equal(g.stats().time, '1');
  assert.equal(g.result(), null);

  clock.at(60000);
  // 30 correct characters in 60 s: 6 words a minute.
  assert.equal(g.result(), 'Final WPM: 6 | Accuracy: 100%');
  assert.deepEqual(g.stats(), { wpm: '6', accuracy: '100%', time: '0', best: '6' });
  assert.equal(g.toast(), 'Session completed');
  assert.equal(g.locked(), true);
  assert.equal(g.saved(), '{"bestWpm":6,"difficulty":"medium"}');
  assert.equal(intervals.running(), 0);

  // Nothing moves afterwards: the timer stays at 0 and the toast goes after 2 s.
  clock.at(63000);
  assert.equal(g.stats().time, '0');
  assert.equal(g.toast(), null);
  assert.equal(g.result(), 'Final WPM: 6 | Accuracy: 100%');
});

test('typing: a time-up score divides by exactly 60 seconds, not 59 or 61', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  // 102 of the 103 characters: one short of finishing, so only the clock can end it.
  g.type('D');
  clock.at(30000);
  g.typeOn(SENTENCE.slice(1, 102));
  clock.at(59000);
  // Live, at the last tick: 20.4 words over 59 s is 20.7.
  assert.deepEqual(g.stats(), { wpm: '21', accuracy: '100%', time: '1', best: '0' });
  assert.equal(g.result(), null);

  clock.at(60000);
  // 20.4 words over 60 s is 20 (over 59 s it would be 21).
  assert.equal(g.result(), 'Final WPM: 20 | Accuracy: 100%');
  assert.deepEqual(g.stats(), { wpm: '20', accuracy: '100%', time: '0', best: '20' });
  assert.equal(g.saved(), '{"bestWpm":20,"difficulty":"medium"}');

  // 98 characters: 19.6 words over 60 s is 20 (over 61 s it would be 19).
  g.els['tst-new-game'].click();
  g.type('D');
  clock.at(90000);
  g.typeOn(SENTENCE.slice(1, 98));
  clock.at(120000);
  assert.equal(g.result(), 'Final WPM: 20 | Accuracy: 100%');
  assert.deepEqual(g.stats(), { wpm: '20', accuracy: '100%', time: '0', best: '20' });
});

test('typing: a round that runs out with typos reports their accuracy and scores only the correct characters', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  // 20 correct characters, 5 wrong ones in their places, then 25 more correct.
  g.typeOn(SENTENCE.slice(0, 20));
  clock.at(10000);
  g.typeOn('#####');
  g.typeOn(SENTENCE.slice(25, 50));
  assert.ok(g.marks().includes(span('tst-char-correct', SENTENCE[19]) + span('tst-char-wrong', SENTENCE[20])));
  assert.ok(g.marks().includes(span('tst-char-wrong', SENTENCE[24]) + span('tst-char-correct', SENTENCE[25])));
  // Live, after a tick: 45 correct characters of 50 typed, over 30 s.
  clock.at(30000);
  assert.deepEqual(g.stats(), { wpm: '18', accuracy: '90%', time: '30', best: '0' });

  clock.at(60000);
  // 45 correct characters in 60 s: 9 words a minute (all 50 would be 10).
  assert.equal(g.result(), 'Final WPM: 9 | Accuracy: 90%');
  assert.deepEqual(g.stats(), { wpm: '9', accuracy: '90%', time: '0', best: '9' });
  assert.equal(g.saved(), '{"bestWpm":9,"difficulty":"medium"}');
  assert.equal(g.locked(), true);
});

test('typing: the live WPM is recomputed every second, so it falls while you pause', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  g.typeOn(SENTENCE.slice(0, 10));
  assert.equal(g.stats().wpm, '120');
  clock.at(1000);
  assert.equal(g.stats().wpm, '120');
  clock.at(2000);
  assert.equal(g.stats().wpm, '60');
  clock.at(4000);
  assert.deepEqual(g.stats(), { wpm: '30', accuracy: '100%', time: '56', best: '0' });
  // 15 correct characters in 4.5 s.
  clock.at(4500);
  g.typeOn(SENTENCE.slice(10, 15));
  assert.equal(g.stats().wpm, '40');
});

test('typing: after the page was suspended mid-round, WPM is never worked out over more than 60 seconds', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  g.type('D');
  clock.at(5000);
  // 90 s pass with the page asleep: no tick ran, the clock still shows 55.
  clock.suspend(90000);
  g.typeOn(SENTENCE.slice(1, 11));
  // 11 correct characters over the 60-second cap (over 95 s it would be 1).
  assert.deepEqual(g.stats(), { wpm: '2', accuracy: '100%', time: '55', best: '0' });
  g.typeOn(SENTENCE.slice(11));
  // 103 characters over 60 s (over 95 s it would be 13).
  assert.equal(g.result(), 'Final WPM: 21 | Accuracy: 100%');
  assert.equal(g.stats().best, '21');
});

test('typing: after the time is up the round is locked until a new game', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  g.type('D');
  clock.at(59000);
  g.typeOn(SENTENCE.slice(1, 10));
  clock.at(60000);
  // 10 correct characters in 60 s.
  const final = 'Final WPM: 2 | Accuracy: 100%';
  const after = { wpm: '2', accuracy: '100%', time: '0', best: '2' };
  assert.equal(g.result(), final);
  assert.deepEqual(g.stats(), after);
  assert.equal(g.locked(), true);
  const marks = g.marks();
  clock.at(62000);
  assert.equal(g.toast(), null);

  // The textarea is read-only now; input that still arrives changes nothing:
  // no stats, no best, no marks, no second finish or toast.
  g.typeOn(SENTENCE.slice(10, 100));
  g.type(SENTENCE.slice(0, 10) + 'xyz');
  g.type(SENTENCE);
  assert.deepEqual(g.stats(), after);
  assert.equal(g.marks(), marks);
  assert.equal(g.result(), final);
  assert.equal(g.toast(), null);
  assert.equal(g.saved(), '{"bestWpm":2,"difficulty":"medium"}');
  clock.at(70000);
  assert.equal(g.stats().time, '0');

  // New Game unlocks a fresh round.
  g.els['tst-new-game'].click();
  assert.equal(g.locked(), false);
  assert.deepEqual(g.stats(), { wpm: '0', accuracy: '100%', time: '60', best: '2' });
  assert.equal(g.result(), null);
  g.type('D');
  clock.at(71000);
  assert.equal(g.stats().time, '59');
});

test('typing: a finished text is locked too: more typing changes nothing and shows no second toast', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  g.type('D');
  clock.at(10000);
  g.typeOn(SENTENCE.slice(1));
  const after = { wpm: '124', accuracy: '100%', time: '50', best: '124' };
  assert.deepEqual(g.stats(), after);
  const marks = g.marks();

  clock.at(11500);
  g.type(SENTENCE + 'xyz');
  assert.deepEqual(g.stats(), after);
  assert.equal(g.marks(), marks);
  clock.at(11999);
  assert.equal(g.toast(), 'Session completed');
  clock.at(12000);
  assert.equal(g.toast(), null);

  // The complete text again finishes nothing a second time.
  g.type(SENTENCE);
  assert.deepEqual(g.stats(), after);
  assert.equal(g.toast(), null);
  assert.equal(g.result(), 'Final WPM: 124 | Accuracy: 100%');
  clock.at(14000);
  assert.equal(g.toast(), null);
});

test('typing: the best WPM comes only from a finished round, never from a fast first keystroke', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  // 20 characters in the first 0.3 s.
  for (let i = 1; i <= 20; i++) {
    g.type(SENTENCE.slice(0, i));
    clock.advance(15);
  }
  assert.equal(g.stats().wpm, '240', 'the live WPM counts the minimum second');
  assert.equal(g.stats().best, '0');
  assert.equal(g.saved(), '{"bestWpm":0,"difficulty":"medium"}');

  clock.at(60000);
  // 20 correct characters in 60 s.
  assert.equal(g.result(), 'Final WPM: 4 | Accuracy: 100%');
  assert.equal(g.stats().best, '4');
  assert.equal(g.saved(), '{"bestWpm":4,"difficulty":"medium"}');

  // A worse round leaves the best alone: one keystroke in a whole minute is 0 WPM.
  g.els['tst-new-game'].click();
  g.type('D');
  clock.at(120000);
  assert.equal(g.result(), 'Final WPM: 0 | Accuracy: 100%');
  assert.deepEqual(g.stats(), { wpm: '0', accuracy: '100%', time: '0', best: '4' });
  assert.equal(g.saved(), '{"bestWpm":4,"difficulty":"medium"}');

  // A better one replaces it: the text in 20 s.
  g.els['tst-new-game'].click();
  g.type('D');
  clock.at(140000);
  g.typeOn(SENTENCE.slice(1));
  assert.equal(g.result(), 'Final WPM: 62 | Accuracy: 100%');
  assert.equal(g.stats().best, '62');
  assert.equal(g.saved(), '{"bestWpm":62,"difficulty":"medium"}');
});

test('typing: the countdown never passes 0, even if the cleared interval keeps firing', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  // clearInterval does nothing here, as on Node 20's mocked timers for an
  // interval cleared from its own callback: the round's interval keeps firing.
  t.mock.method(globalThis, 'clearInterval', () => {});
  const g = openPage();

  g.type('D');
  clock.at(60000);
  assert.equal(g.stats().time, '0');
  assert.notEqual(g.result(), null);
  clock.at(65000);
  assert.equal(g.stats().time, '0');
  assert.equal(g.toast(), null, 'the toast is not shown again');
  assert.equal(g.result(), 'Final WPM: 0 | Accuracy: 100%');

  // In the next round only its own interval ticks: one second per second.
  g.els['tst-new-game'].click();
  g.type('D');
  clock.at(68000);
  assert.equal(g.stats().time, '57');
});

test('typing: New Game and Restart, by click or key, stop the clock and deal a fresh round without stacking listeners', (t) => {
  const clock = useClock(t);
  const rnd = mockRandom(t, 0);
  const intervals = trackIntervals(t);
  const g = openPage();

  g.type('D#');
  clock.at(5000);
  // One correct character in 5 s.
  assert.deepEqual(g.stats(), { wpm: '2', accuracy: '50%', time: '55', best: '0' });

  rnd.value = 0.9;
  g.els['tst-new-game'].click();
  assert.equal(g.sentence(), POOLS.medium[1]);
  assert.ok(g.marks().startsWith(span('tst-char-current', 'T')));
  assert.deepEqual(g.stats(), FRESH);
  assert.equal(g.els['tst-input'].value, '');
  assert.equal(intervals.running(), 0);
  clock.at(8000);
  assert.equal(g.stats().time, '60', 'no tick from the old round');

  // Restart is the same action: a new random sentence.
  g.type('T');
  clock.at(9000);
  assert.equal(g.stats().time, '59');
  rnd.value = 0;
  g.els['tst-restart-game'].click();
  assert.equal(g.sentence(), SENTENCE);
  assert.deepEqual(g.stats(), FRESH);

  // Keyboard: Enter on the focused New Game button, Space on Restart.
  g.type('D');
  clock.at(10000);
  assert.equal(g.stats().time, '59');
  g.els['tst-new-game'].focus();
  pressKey('Enter');
  assert.deepEqual(g.stats(), FRESH);
  assert.equal(g.els['tst-input'].value, '');

  g.type('D');
  clock.at(11000);
  g.els['tst-restart-game'].focus();
  pressKey(' ');
  assert.deepEqual(g.stats(), FRESH);
  clock.at(14000);
  assert.equal(g.stats().time, '60');

  assert.equal(intervals.started(), 4);
  assert.equal(intervals.running(), 0);
  assert.equal(listenerCount(g.els['tst-new-game'], 'click'), 1);
  assert.equal(listenerCount(g.els['tst-restart-game'], 'click'), 1);
  assert.equal(listenerCount(g.els['tst-difficulty'], 'change'), 1);
  assert.equal(listenerCount(g.els['tst-input'], 'input'), 1);
  assert.equal(g.saved(), '{"bestWpm":0,"difficulty":"medium"}');
});

test('typing: changing difficulty mid-round resets the board on the new pool and saves the choice', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0.9);
  const intervals = trackIntervals(t);
  const g = openPage();
  assert.equal(g.sentence(), POOLS.medium[1]);

  g.type('T#');
  clock.at(5000);
  assert.equal(g.stats().time, '55');
  assert.equal(g.stats().accuracy, '50%');

  g.els['tst-difficulty'].value = 'hard';
  fire(g.els['tst-difficulty'], 'change');
  assert.equal(g.sentence(), POOLS.hard[1]);
  assert.deepEqual(g.stats(), FRESH);
  assert.equal(g.els['tst-input'].value, '');
  assert.equal(g.saved(), '{"bestWpm":0,"difficulty":"hard"}');
  assert.equal(intervals.running(), 0);
  clock.at(8000);
  assert.equal(g.stats().time, '60');

  // Restart after a finished round hides the result and the toast again.
  g.type(POOLS.hard[1]);
  assert.equal(g.result(), 'Final WPM: 1428 | Accuracy: 100%');
  g.els['tst-restart-game'].click();
  assert.equal(g.result(), null);
  assert.equal(g.toast(), null);

  // A value that names no pool (no such option exists) keeps the current difficulty.
  g.els['tst-difficulty'].value = 'insane';
  fire(g.els['tst-difficulty'], 'change');
  assert.equal(g.sentence(), POOLS.hard[1]);
  assert.equal(g.saved(), '{"bestWpm":1428,"difficulty":"hard"}');
});

test('typing: a pasted sentence starts and ends the round in one input event and leaves no clock running', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const intervals = trackIntervals(t);
  const g = openPage();

  g.type(SENTENCE);
  // 103 characters counted over the one-second minimum.
  assert.equal(g.result(), 'Final WPM: 1236 | Accuracy: 100%');
  assert.equal(g.stats().best, '1236');
  assert.equal(g.toast(), 'Session completed');
  assert.equal(intervals.started(), 1);
  assert.equal(intervals.running(), 0);
  clock.at(3000);
  assert.equal(g.stats().time, '60');
});

test('typing: deleting everything mid-round puts accuracy back to 100% and WPM to 0 while the clock runs on', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  g.type('Dex');
  assert.equal(g.stats().accuracy, '67%');
  clock.at(2000);
  g.type('');
  assert.deepEqual(g.stats(), { wpm: '0', accuracy: '100%', time: '58', best: '0' });
  assert.ok(g.marks().startsWith(span('tst-char-current', 'D') + span('', 'e')));
  clock.at(3000);
  assert.equal(g.stats().time, '57');
  assert.equal(g.result(), null);
});

test('typing: extra characters past the end are wrong and a wrong character blocks completion', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  g.type('D');
  clock.at(10000);
  const typo = SENTENCE.slice(0, 50) + '#' + SENTENCE.slice(51);
  g.type(typo);
  assert.equal(g.result(), null);
  assert.equal(g.stats().accuracy, '99%');
  assert.ok(g.marks().includes(span('tst-char-correct', SENTENCE[49]) + span('tst-char-wrong', SENTENCE[50])));
  assert.equal(g.marks().includes('tst-char-current'), false);

  g.type(SENTENCE + 'zz');
  assert.equal(g.result(), null);
  assert.equal(g.stats().accuracy, '98%');
  assert.equal(g.marks(), [...SENTENCE].map((ch) => span('tst-char-correct', ch)).join(''));

  g.type(SENTENCE);
  assert.equal(g.result(), 'Final WPM: 124 | Accuracy: 100%');
});

test('typing: New Game hides the toast and a later toast stays its full two seconds', (t) => {
  const clock = useClock(t);
  mockRandom(t, 0);
  const g = openPage();

  g.type(SENTENCE);
  assert.equal(g.toast(), 'Session completed');
  clock.at(500);
  g.els['tst-new-game'].click();
  assert.equal(g.toast(), null, 'the finished round takes its toast with it');

  clock.at(1500);
  g.type(SENTENCE);
  assert.equal(g.toast(), 'Session completed');
  // The first toast's timer would have fired at 2 s.
  clock.at(2000);
  assert.equal(g.toast(), 'Session completed');
  clock.at(3499);
  assert.equal(g.toast(), 'Session completed');
  clock.at(3500);
  assert.equal(g.toast(), null);
});

// ── Markup, stylesheet and source ───────────────────────────────────────────

test('typing: opened on its own, the page has no margin and the wrapper background, kept out of the embed', () => {
  // Without this rule the body is transparent with the browser's 8px margin: light
  // text vanishes in a light browser theme and a white frame shows round the game.
  const bg = CSS.match(/--tst-bg:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
});

test('typing: script.js, style.css and the embedded markup are safe inside the WordPress block', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const markup = embedMarkup(HTML);
  assert.ok(markup.startsWith('<div class="tst-wrapper">'));
  assert.ok(markup.includes('id="tst-toast"'), 'the whole game is inside the embedded part');
  assert.deepEqual(embedSafety(markup), []);
  // build-embed copies the markup from the wrapper up to the first <script> only.
  assert.doesNotMatch(markup, /<style|<script/i);
});

test('typing: every class, id, CSS variable and the storage key carry the tst- prefix', () => {
  const markup = embedMarkup(HTML);
  for (const id of idsInHtml(markup)) assert.match(id, /^tst-/, id);
  const classes = [...markup.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  assert.ok(classes.length > 20);
  for (const name of classes) assert.match(name, /^tst-/, name);

  // Every rule of style.css is scoped to tst- classes; no ids, no bare elements.
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.match(selector, /^\.tst-/, selector);
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^tst-/, selector);
      assert.doesNotMatch(selector, /#/, selector);
    }
  }
  const variables = [...CSS.matchAll(/--[\w-]+/g)].map((m) => m[0]);
  assert.ok(variables.length > 10);
  for (const name of variables) assert.match(name, /^--tst-/, name);

  // Every kebab-case string in script.js (class names, ids, the storage key) is tst-.
  const names = [...JS.matchAll(/'([a-z]+(?:-[a-z]+)+)'/g)].map((m) => m[1]);
  assert.ok(names.includes(STORAGE_KEY));
  for (const id of ELEMENT_IDS) assert.ok(names.includes(id), id);
  for (const name of names) assert.match(name, /^tst-/, name);
});

// script.js with comments and string literals blanked out (the sentences hold
// words such as "rely"), for the style checks below.
function codeOnly(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      out += ' ';
    } else if (c === '\'' || c === '"') {
      let j = i + 1;
      while (src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += '""';
      i = j;
    } else {
      out += c;
    }
  }
  return out;
}

test('typing: script.js is one strict IIFE in ES5 style', () => {
  assert.match(JS, /^(\/\/.*\n)*\(function \(\) \{\n {2}'use strict';\n/);
  assert.ok(JS.trimEnd().endsWith('})();'));
  assert.equal(JS.match(/^\(function/gm).length, 1);

  const code = codeOnly(JS);
  assert.ok(code.includes('function tstInit'), 'codeOnly keeps the code');
  assert.doesNotMatch(code, /=>/, 'no arrow functions');
  assert.doesNotMatch(code, /\b(let|const|class|async|await|import|export|yield)\b/, 'no ES2015+ keywords');
  assert.doesNotMatch(code, /`/, 'no template literals');
  assert.doesNotMatch(code, /\?\.|\?\?/, 'no optional chaining or nullish coalescing');
  assert.doesNotMatch(code, /\.\.\./, 'no spread or rest');
  assert.doesNotMatch(code, /\bfor\s*\([^)]*\bof\b/, 'no for...of');
  // Every line is indented with two spaces per level.
  for (const line of JS.split('\n')) assert.match(line, /^( {2})*\S|^$/, JSON.stringify(line));
});

test('typing: the difficulty select offers the three pools, with Medium selected', () => {
  const select = /<select id="tst-difficulty"[^>]*>([\s\S]*?)<\/select>/.exec(HTML)[1];
  const options = [...select.matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)];
  assert.deepEqual(options.map((o) => o[1]), Object.keys(POOLS));
  assert.deepEqual(options.map((o) => o[3]), ['Easy', 'Medium', 'Hard']);
  assert.deepEqual(options.filter((o) => o[2]).map((o) => o[1]), ['medium']);
  assert.equal(htmlPageSpec(HTML)['tst-difficulty'].value, 'medium');
});

test('typing: on phones the layout stacks into one column and the controls go full width', () => {
  const rules = cssRules(CSS);
  const at = (selector, vw) => declsAt(rules, selector, vw);

  assert.equal(at('.tst-main', 1280)['grid-template-columns'], '1fr 280px');
  assert.equal(at('.tst-main', 769)['grid-template-columns'], '1fr 280px');
  for (const vw of [768, 414, 375, 320]) assert.equal(at('.tst-main', vw)['grid-template-columns'], '1fr', vw);

  assert.equal(at('.tst-toolbar', 641)['flex-direction'], undefined);
  assert.equal(at('.tst-button', 641).width, undefined);
  for (const vw of [640, 414, 375, 320]) {
    assert.equal(at('.tst-toolbar', vw)['flex-direction'], 'column', vw);
    assert.equal(at('.tst-toolbar-group', vw).width, '100%', vw);
    assert.equal(at('.tst-button', vw).width, '100%', vw);
    assert.equal(at('.tst-select', vw).width, '100%', vw);
    assert.equal(at('.tst-title', vw)['font-size'], '32px', vw);
  }

  assert.equal(at('.tst-wrapper', 401).padding, '24px');
  assert.equal(at('.tst-text-display', 401)['font-size'], '20px');
  for (const vw of [400, 375, 320]) {
    assert.equal(at('.tst-wrapper', vw).padding, '16px', vw);
    assert.equal(at('.tst-text-display', vw)['font-size'], '18px', vw);
  }
  assert.equal(at('.tst-input', 320).width, '100%');
  assert.equal(at('.tst-wrapper *', 320)['box-sizing'], 'border-box');

  // No fixed width wider than the narrowest phone anywhere in the stylesheet.
  for (const rule of rules) {
    for (const [prop, value] of Object.entries(rule.decls)) {
      const px = /^(?:min-|max-)?width$/.test(prop) && /^(\d+)px$/.exec(value);
      if (px) assert.ok(Number(px[1]) <= 320, rule.selectors + ' ' + prop + ': ' + value);
    }
  }
});
