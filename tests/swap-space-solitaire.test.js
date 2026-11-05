// tests/swap-space-solitaire.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs,
  fire, pressKey, listenerCount, focusElement, setVisibility, blockStorage,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'swap-space-solitaire';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);
// A module copy for the pure functions (page tests boot their own copy).
const swp = loadScript(SCRIPT);

const STATE_KEY = 'swp-state';
const STATS_KEY = 'swp-stats';
const DAILY_KEY = 'swp-daily';
const APIS = ['setInterval', 'setTimeout', 'Date'];
// Local noon of 2026-11-05, the day of Daily #5.
const NOON = new Date(2026, 10, 5, 12, 0, 0).getTime();
const TODAY = '2026-11-05';
const HOUR = 3600000;

test.beforeEach(() => resetStubs());

// ── Cards, an independent model of the rules ────────────────────────────────

const SUITS = 'SHDC';
const RANKS = 'A23456789TJQK';
const GLYPHS = ['♠︎', '♥︎', '♦︎', '♣︎'];
const SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANK_NAMES = ['ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];
const DISKS = ['/dev/sda', '/dev/sdb', '/dev/sdc', '/dev/sdd'];

// 'TH' -> the 10 of hearts as the game numbers it: suit * 13 + rank - 1.
function C(code) {
  const rank = RANKS.indexOf(code[0]);
  const suit = SUITS.indexOf(code[1]);
  assert.ok(code.length === 2 && rank >= 0 && suit >= 0, 'a card code: ' + code);
  return suit * 13 + rank;
}
const suitOf = (card) => Math.floor(card / 13);
const rankOf = (card) => card % 13 + 1;
const isRed = (card) => suitOf(card) === 1 || suitOf(card) === 2;
const face = (card) => (rankOf(card) === 10 ? '10' : RANKS[card % 13]) + GLYPHS[suitOf(card)];
const nameOf = (card) => RANK_NAMES[card % 13] + ' of ' + SUIT_NAMES[suitOf(card)];
const fits = (card, onto) => rankOf(card) === rankOf(onto) - 1 && isRed(card) !== isRed(onto);
const DECK = Array.from({ length: 52 }, (_, i) => i);

// FNV-1a 32 with BigInt arithmetic.
function fnv1a(text) {
  let hash = 0x811c9dc5n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x01000193n) & 0xffffffffn;
  }
  return Number(hash);
}

// The deal as the rules describe it: Fisher-Yates over 0..51 driven by
// mulberry32 (the harness's seeded), dealt round the 8 cascades.
function modelDeal(seed) {
  const random = seeded(seed);
  const deck = DECK.slice();
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const cascades = Array.from({ length: 8 }, () => []);
  deck.forEach((card, k) => cascades[k % 8].push(card));
  return { cascades, slots: [null, null, null, null], disks: [0, 0, 0, 0] };
}

const copy = (board) => JSON.parse(JSON.stringify(board));

// The top n cards of a position (positions: 0-7 cascades, 8-11 swap slots,
// 12-15 disks), or null.
function modelCards(board, pos, n) {
  if (pos < 8) {
    const cascade = board.cascades[pos];
    return n >= 1 && n <= cascade.length ? cascade.slice(cascade.length - n) : null;
  }
  if (n !== 1) return null;
  if (pos < 12) return board.slots[pos - 8] === null ? null : [board.slots[pos - 8]];
  const count = board.disks[pos - 12];
  return count ? [(pos - 12) * 13 + count - 1] : null;
}

function modelLegal(board, src, dst, n) {
  if (src >= 12 || src === dst) return false;
  const cards = modelCards(board, src, n);
  if (!cards) return false;
  for (let i = 1; i < cards.length; i++) if (!fits(cards[i], cards[i - 1])) return false;
  const base = cards[0];
  if (dst >= 12) return n === 1 && suitOf(base) === dst - 12 && board.disks[dst - 12] === rankOf(base) - 1;
  if (dst >= 8) return n === 1 && board.slots[dst - 8] === null;
  const target = board.cascades[dst];
  if (target.length && !fits(base, target[target.length - 1])) return false;
  const free = board.slots.filter((card) => card === null).length;
  const empty = board.cascades.filter((cascade, i) => cascade.length === 0 && i !== dst).length;
  return n <= (free + 1) * 2 ** empty;
}

function modelApply(board, [src, dst, n]) {
  const next = copy(board);
  const cards = modelCards(next, src, n);
  if (src < 8) next.cascades[src].splice(-n, n);
  else if (src < 12) next.slots[src - 8] = null;
  else next.disks[src - 12]--;
  if (dst < 8) next.cascades[dst].push(...cards);
  else if (dst < 12) next.slots[dst - 8] = cards[0];
  else next.disks[dst - 12]++;
  return next;
}

// Safe: no card could ever be put on it, because both lower cards of the
// other colour are on their disks (aces and twos always).
function modelSafe(board, card) {
  if (rankOf(card) <= 2) return true;
  return [0, 1, 2, 3].every((suit) => (suit === 1 || suit === 2) === isRed(card) || board.disks[suit] >= rankOf(card) - 1);
}

function modelAuto(board) {
  const moves = [];
  let current = board;
  for (;;) {
    let found = null;
    for (let pos = 0; pos < 12 && !found; pos++) {
      const cards = modelCards(current, pos, 1);
      if (cards && modelLegal(current, pos, 12 + suitOf(cards[0]), 1) && modelSafe(current, cards[0])) {
        found = [pos, 12 + suitOf(cards[0]), 1];
      }
    }
    if (!found) return moves;
    moves.push(found);
    current = modelApply(current, found);
  }
}

const applyAll = (board, moves) => moves.reduce(modelApply, board);

// A board from card codes: cascades (top card last), swap slots and disk
// counts; the cards not listed go, in deck order, under the listed cards of
// cascade fill (with no fill every card must be listed).
function makeBoard({ cascades = [], slots = [], disks = [0, 0, 0, 0], fill = null } = {}) {
  const board = {
    cascades: Array.from({ length: 8 }, (_, i) => (cascades[i] || []).map(C)),
    slots: [0, 1, 2, 3].map((i) => (slots[i] ? C(slots[i]) : null)),
    disks: disks.slice()
  };
  const used = [];
  disks.forEach((count, suit) => { for (let r = 0; r < count; r++) used.push(suit * 13 + r); });
  used.push(...board.cascades.flat(), ...board.slots.filter((card) => card !== null));
  assert.equal(new Set(used).size, used.length, 'makeBoard: no card twice');
  const rest = DECK.filter((card) => !used.includes(card));
  if (fill === null) assert.equal(rest.length, 0, 'makeBoard: every card placed');
  else board.cascades[fill] = rest.concat(board.cascades[fill]);
  return board;
}

// Board A: 9♠ on A♥ in cascade 1 (K♣ under them), 10♥ on Q♦ in cascade 2, 2♥
// alone in cascade 3, 5♦ in 4, 7♣ on 8♦ in 5, cascade 6 empty, K♥ in 7, and
// the other 40 cards under 6♠ in cascade 8.  Nothing is safe to flush yet.
const BOARD_A = () => makeBoard({
  cascades: [['KC', 'AH', '9S'], ['QD', 'TH'], ['2H'], ['5D'], ['8D', '7C'], [], ['KH'], ['6S']],
  fill: 7
});

// Two cards to go: K♦ and K♣; K♦ to its disk flushes K♣ and wins.
const NEAR_WON = () => makeBoard({ cascades: [['KD'], ['KC']], disks: [13, 13, 12, 12] });

// Every cascade has a black top on a black card, three kings sit in the swap
// slots and K♣ on cascade 8: moving K♣ to the last slot leaves no move at all.
const PRE_DEADLOCK = () => makeBoard({
  cascades: [['AS', '2S'], ['TS', '3S'], ['JS', '4S'], ['QS', '5S'], ['AC', '6S'], ['2C', '7S'], ['3C', '8S'], ['4C', '9S', 'KC']],
  slots: ['KH', 'KD', 'KS'],
  fill: 0
});

// ── Saves and pages ─────────────────────────────────────────────────────────

const DAILY_SEED = fnv1a('swp:' + TODAY);

function gameOf(board, extra = {}) {
  return {
    kind: 'deal', deal: 777, seed: 777, board, history: [], moves: 0, undos: 0,
    elapsed: 0, started: false, counted: false, over: null, ...extra
  };
}

const dealSave = (board, extra, mode = 'deal') => ({ v: 1, mode, game: gameOf(board, extra) });

function dailySave(board, extra = {}, record = {}) {
  return {
    v: 1, day: TODAY, number: 5, result: null, score: null,
    game: gameOf(board, { kind: 'daily', deal: 5, seed: DAILY_SEED, ...extra }),
    streak: 0, best: 0, lastWon: null, ...record
  };
}

function writeStorage({ state, stats, daily } = {}) {
  for (const [key, value] of [[STATE_KEY, state], [STATS_KEY, stats], [DAILY_KEY, daily]]) {
    if (value !== undefined) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

// Timers and Date mocked from now (local noon of Daily #5 by default), and
// performance.now() following the mocked Date.  A second call in a test
// drops the first page's timers, as a reload does, and keeps the time.
const timed = new WeakSet();
function useTime(t, now) {
  if (timed.has(t)) {
    const at = now === undefined ? Date.now() : now;
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: APIS, now: at });
    return;
  }
  t.mock.timers.enable({ apis: APIS, now: now === undefined ? NOON : now });
  t.mock.method(performance, 'now', () => Date.now() - NOON);
  timed.add(t);
}

const cardFromName = (label) => {
  const m = /^(\w+) of (\w+)/.exec(label);
  return SUIT_NAMES.indexOf(m[2]) * 13 + RANK_NAMES.indexOf(m[1]);
};

// What a player sees and does on the booted page.
function view(b) {
  const els = b.els;
  const table = els['swp-table'];
  const page = {
    els,
    table,
    page: b.page,
    ready: b.ready,
    restore: b.restore,
    text: (id) => els[id].textContent,
    status: () => els['swp-status'].textContent,
    column: (i) => table.children[1].children[i],
    cards: (i) => page.column(i).children.filter((el) => el.getAttribute('data-index') !== null),
    top: (i) => page.cards(i)[page.cards(i).length - 1],
    slot: (i) => table.children[0].children[i],
    disk: (i) => table.children[0].children[4 + i],
    // depth 1 is the top card, 2 the one under it ...
    tap: (i, depth = 1) => page.cards(i)[page.cards(i).length - depth].click(),
    tapEmpty: (i) => page.column(i).children[0].click(),
    tapSlot: (i) => page.slot(i).click(),
    tapDisk: (i) => page.disk(i).click(),
    click: (id) => els[id].click(),
    saved: (key) => JSON.parse(localStorage.getItem(key)),
    state: () => page.saved(STATE_KEY),
    stats: () => page.saved(STATS_KEY),
    daily: () => page.saved(DAILY_KEY),
    game: () => (page.state().mode === 'daily' ? page.daily().game : page.state().game),
    hidden: (id) => els[id].classList.contains('swp-hidden'),
    toast: () => (els['swp-toast'].classList.contains('swp-show') ? els['swp-toast'].textContent : null),
    selected: () => table.querySelectorAll('.swp-selected').map((el) => el.getAttribute('aria-label')),
    targets: () => [...new Set(table.querySelectorAll('.swp-target').map((el) => Number(el.getAttribute('data-pos'))))].sort((a, b) => a - b),
    numbers: () => ['swp-faults', 'swp-time', 'swp-won', 'swp-streak', 'swp-best', 'swp-daily-streak'].map((id) => els[id].textContent),
    // The board as drawn, read back from the aria-labels.
    shown: () => {
      const board = { cascades: [], slots: [], disks: [] };
      for (let i = 0; i < 8; i++) board.cascades.push(page.cards(i).map((el) => cardFromName(el.getAttribute('aria-label'))));
      for (let i = 0; i < 4; i++) {
        const slot = page.slot(i).getAttribute('aria-label').split(': ')[1];
        board.slots.push(slot === 'empty' ? null : cardFromName(slot));
        const disk = page.disk(i).getAttribute('aria-label').split(': ')[1];
        board.disks.push(disk === 'empty' ? 0 : rankOf(cardFromName(disk)));
      }
      return board;
    }
  };
  return page;
}

function boot(storage, options = {}) {
  writeStorage(storage);
  return view(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), { readyState: options.readyState }));
}

// The page as a browser loads it, after writing storage.
function openPage(t, storage, options = {}) {
  useTime(t, options.now);
  return boot(storage, options);
}

// A reload: the old page goes away (pagehide, as browsers fire it), then its
// timers; storage and time stay.
function reload(t, page, options = {}) {
  const at = Date.now();
  fire(window, 'pagehide');
  page.restore();
  useTime(t, options.now === undefined ? at : options.now);
  return boot(undefined, options);
}

// The live intervals the game holds: call after useTime (mock.timers.enable
// replaces setInterval) and boot with boot(), in a test that does not reload.
function trackIntervals(t) {
  const live = new Set();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (fn, ms) => {
    const id = realSet(fn, ms);
    live.add(id);
    return id;
  });
  t.mock.method(globalThis, 'clearInterval', (id) => {
    live.delete(id);
    return realClear(id);
  });
  return live;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
// Element identity without a diff: assert.equal on two element stubs would
// print (and diff) the whole page tree when it fails.
const same = (actual, expected, message) => assert.ok(actual === expected, message || 'the same element');
const px = (value) => {
  const m = /^(-?\d+(?:\.\d+)?)(px|rem|em)$/.exec(String(value).trim());
  assert.ok(m, 'a length: ' + value);
  return Number(m[1]) * (m[2] === 'px' ? 1 : 16);
};

// ── Files ────────────────────────────────────────────────────────────────────

test('swap space solitaire: every id the script looks up exists once in index.html, and ids, classes, custom properties, keys and exports carry the swp prefix', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  assert.equal(ids.length, 24);
  assert.deepEqual([...ids].sort(), [...htmlIds].sort(), 'the script looks up every id of the page, and only those');
  for (const id of htmlIds) assert.match(id, /^swp-/);

  const markupClasses = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  const scriptClasses = Array.from(JS.matchAll(/'(swp-[\w-]+)'/g), (m) => m[1]);
  assert.ok(markupClasses.length > 30);
  for (const name of markupClasses) assert.match(name, /^swp-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^swp-/, selector);
    }
  }
  for (const m of CSS.matchAll(/@keyframes\s+([\w-]+)/g)) assert.match(m[1], /^swp-/);
  // Custom properties (a BEM modifier such as .swp-btn--secondary is a class).
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^swp-/);
  for (const m of JS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^swp-/);
  // Storage keys and exported names.
  assert.deepEqual(scriptClasses.filter((name) => /^swp-(state|stats|daily)$/.test(name)).sort(), ['swp-daily', 'swp-state', 'swp-stats']);
  assert.doesNotMatch(JS, /localStorage\.(getItem|setItem)\(\s*'/, 'keys come from the SWP_*_KEY constants');
  for (const name of Object.keys(swp)) assert.match(name, /^swp[A-Z]/);
  // No other program's name: the deals belong to this game only.
  assert.doesNotMatch(JS + CSS + HTML, /free\s*cell/i);
  // Deal numbers are said to be this game's own, never another program's,
  // and no deal is claimed to be solvable.
  assert.match(JS, /match no\s+(\/\/\s+)?other program's deals/);
  assert.match(JS, /not guaranteed to\s+(\/\/\s+)?be solvable/);
  assert.match(HTML, /Nearly every deal can be solved, but none is guaranteed\./);
});

test('swap space solitaire: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="swp-wrapper"'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');
  const bg = CSS.match(/--swp-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.match(head, /<title>Swap Space Solitaire — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  // No network, no libraries, no AI: nothing fetched or loaded from elsewhere.
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|eval)\b|new Function/);
  assert.doesNotMatch(HTML + CSS, /https?:\/\/|@import|url\(/);
});

test('swap space solitaire: script.js is one strict IIFE in ES5', () => {
  assert.match(JS, /^(\/\/[^\n]*\r?\n)*\r?\n?\(function \(\) \{\r?\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1, 'one IIFE at the top level');
  assert.equal(JS.match(/^\}\)\(\);/gm).length, 1);
  const code = JS
    .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['exponent operator', /\*\*/], ['double-quoted string', /"/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('swap space solitaire: eight cascades fit every width from 320 px with readable corners, and nothing else forces a sideways scroll', () => {
  const rules = cssRules(CSS);
  const pct = (value) => {
    const m = /^(-?\d+(?:\.\d+)?)%$/.exec(String(value).trim());
    assert.ok(m, 'a percentage: ' + value);
    return Number(m[1]) / 100;
  };
  assert.equal(declsAt(rules, '.swp-row', 320)['grid-template-columns'], 'repeat(8, minmax(0, 1fr))');
  assert.equal(declsAt(rules, '.swp-cascade > .swp-card + .swp-card', 320)['margin-top'], 'var(--swp-fan)');
  assert.equal(declsAt(rules, '.swp-cascade.swp-long > .swp-card + .swp-card', 320)['margin-top'], 'var(--swp-fan-long)');
  for (let vw = 320; vw <= 1280; vw++) {
    const wrapper = declsAt(rules, '.swp-wrapper', vw);
    const table = declsAt(rules, '.swp-table', vw);
    const card = declsAt(rules, '.swp-card', vw);
    const label = declsAt(rules, '.swp-slot-label', vw);
    assert.deepEqual(card, declsAt(rules, '.swp-slot', vw), 'slots and cards share one size');
    assert.equal(card.width, '100%');
    assert.equal(card['aspect-ratio'], '5 / 7');
    // Cards are buttons, which centre their content vertically unless they
    // are flex boxes: the corner must start at the top, inside the strip.
    assert.equal(card.display, 'flex', vw + 'px: a card is a flex box');
    assert.equal(card['flex-direction'], 'column');
    assert.equal(card['justify-content'], 'flex-start', vw + 'px: the corner starts at the top');
    assert.equal(declsAt(rules, '.swp-wrapper *', vw)['box-sizing'], 'border-box');
    const padX = px(wrapper.padding.split(/\s+/)[1]);
    const inner = Math.min(vw, px(wrapper['max-width'])) - 2 * padX;
    const tableInner = Math.min(inner, px(table['max-width'])) - 2 * px(table.padding) - 2 * px(table.border.split(/\s+/)[0]);
    const width = (tableInner - 7 * px(wrapper['--swp-gap'])) / 8;
    const height = width * 7 / 5;
    const [padTop, padSide] = card.padding.split(/\s+/).map(px).concat([]);
    const side = padSide === undefined ? padTop : padSide;
    const corner = px(wrapper['--swp-corner']);
    assert.ok(width >= 32, vw + 'px: cards of ' + width.toFixed(1) + 'px');
    // "10♥" (3 monospace characters of about 0.62em) and "swap0" fit across.
    assert.ok(3 * 0.62 * corner + 2 * side <= width, vw + 'px: the corner fits');
    assert.ok(5 * 0.62 * px(label['font-size']) + 2 * side <= width, vw + 'px: the slot name fits');
    // A covered card shows (1.4 + fan) x its width: room for its corner.
    for (const fan of ['--swp-fan', '--swp-fan-long']) {
      const strip = height + pct(wrapper[fan]) * width;
      assert.ok(strip >= corner + padTop, vw + 'px ' + fan + ': a ' + strip.toFixed(1) + 'px strip for a ' + corner + 'px corner');
    }
  }
  for (const vw of [320, 360, 375, 390, 414]) {
    for (const selector of ['.swp-header', '.swp-toolbar', '.swp-controls']) {
      assert.equal(declsAt(rules, selector, vw)['flex-wrap'], 'wrap', selector);
    }
    assert.equal(declsAt(rules, '.swp-stats', vw)['grid-template-columns'], 'repeat(3, minmax(0, 1fr))');
    for (const selector of ['.swp-status', '.swp-deal-label', '.swp-warning', '.swp-toast']) {
      assert.equal(declsAt(rules, selector, vw)['overflow-wrap'], 'anywhere', selector);
    }
    assert.equal(declsAt(rules, '.swp-toast', vw)['max-width'], 'calc(100vw - 32px)');
    assert.equal(declsAt(rules, '.swp-share-field', vw).width, '100%');
    assert.ok(px(declsAt(rules, '.swp-input', vw).width) <= 160);
  }
  // Taps only: the table turns off double-tap zoom but never blocks scrolling.
  assert.equal(declsAt(rules, '.swp-table', 320)['touch-action'], 'manipulation');
  assert.doesNotMatch(CSS, /touch-action:\s*none/);
  assert.equal(declsAt(rules, '.swp-hidden', 320).display, 'none');
});

// ── Cards and deals ─────────────────────────────────────────────────────────

test('swap space solitaire: the shuffle runs on mulberry32, and the daily seed is 32-bit FNV-1a', () => {
  for (const seed of [0, 1, 777, 12345, 999999, 0xffffffff]) {
    const mine = swp.swpMulberry32(seed);
    const reference = seeded(seed);
    for (let i = 0; i < 40; i++) assert.equal(mine(), reference(), 'seed ' + seed + ' draw ' + i);
  }
  assert.equal(swp.swpHash(''), 0x811c9dc5);
  assert.equal(swp.swpHash('a'), 0xe40c292c);
  assert.equal(swp.swpHash('foobar'), 0xbf9cf968);
  for (const text of ['swp:2026-11-05', 'swp:2026-11-06', 'swp:2027-01-01', 'x'.repeat(200)]) {
    assert.equal(swp.swpHash(text), fnv1a(text), text.slice(0, 20));
  }
  assert.equal(swp.swpDailySeed(TODAY), fnv1a('swp:2026-11-05'));
});

test('swap space solitaire: a deal is a Fisher-Yates shuffle dealt round the cascades, 7-7-7-7-6-6-6-6, the same for the same number', (t) => {
  t.mock.method(Math, 'random', () => { throw new Error('a deal never uses Math.random'); });
  let flushedAtStart = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const board = swp.swpDeal(seed);
    assert.deepEqual(board, modelDeal(seed), 'seed ' + seed);
    assert.deepEqual(board.cascades.map((cascade) => cascade.length), [7, 7, 7, 7, 6, 6, 6, 6]);
    assert.deepEqual(board.cascades.flat().sort((a, b) => a - b), DECK);
    const start = swp.swpStartBoard(seed);
    assert.deepEqual(start, applyAll(modelDeal(seed), modelAuto(modelDeal(seed))), 'start of ' + seed);
    if (start.disks.some(Boolean)) flushedAtStart++;
  }
  assert.ok(flushedAtStart > 0, 'some deals start with an exposed ace already on its disk');
  assert.deepEqual(swp.swpDeal(48213), swp.swpDeal(48213));
  assert.notDeepEqual(swp.swpDeal(48213), swp.swpDeal(48214));
  const game = swp.swpNewGame('deal', 48213, 48213);
  assert.deepEqual(game, {
    kind: 'deal', deal: 48213, seed: 48213, board: swp.swpStartBoard(48213), history: [], moves: 0,
    undos: 0, elapsed: 0, started: false, counted: false, over: null
  });
});

test('swap space solitaire: cards: text with text-style suits, names, colours, and runs down in alternating colours', () => {
  assert.equal(swp.swpCardText(C('TH')), '10♥︎');
  assert.equal(swp.swpCardText(C('AS')), 'A♠︎');
  assert.equal(swp.swpCardText(C('KC')), 'K♣︎');
  assert.equal(swp.swpCardText(C('QD')), 'Q♦︎');
  for (const card of DECK) {
    assert.equal(swp.swpCardText(card), face(card));
    assert.equal(swp.swpCardName(card), nameOf(card));
  }
  assert.equal(swp.swpCardName(C('JD')), 'jack of diamonds');
  for (const card of DECK) {
    for (const onto of DECK) assert.equal(swp.swpFits(card, onto), fits(card, onto));
  }
  assert.equal(swp.swpRunLength([]), 0);
  assert.equal(swp.swpRunLength([C('9S')]), 1);
  assert.equal(swp.swpRunLength(['KC', '9S', '8H', '7C'].map(C)), 3);
  assert.equal(swp.swpRunLength(['TD', '9S', '8H', '7C', '6D'].map(C)), 5);
  assert.equal(swp.swpRunLength(['9S', '8S'].map(C)), 1, 'same colour');
  assert.equal(swp.swpRunLength(['9S', '7H'].map(C)), 1, 'a rank skipped');
  assert.equal(swp.swpRunLength(['7H', '8S'].map(C)), 1, 'going up');
});

// ── Rules ────────────────────────────────────────────────────────────────────

test('swap space solitaire: canMove agrees with an independent model of the rules on positions reached by random legal moves', () => {
  const random = seeded(2026);
  let states = 0;
  let multi = 0;
  let toEmpty = 0;
  let deadlocks = 0;
  for (let seed = 1; seed <= 8; seed++) {
    let board = swp.swpDeal(seed * 7919);
    for (let step = 0; step < 32; step++) {
      const legal = [];
      for (let src = 0; src < 16; src++) {
        for (let dst = 0; dst < 16; dst++) {
          for (let n = src < 12 ? 1 : 0; n <= (src < 12 ? 13 : 1); n++) {
            const expected = modelLegal(board, src, dst, n);
            assert.equal(swp.swpCanMove(board, src, dst, n), expected, JSON.stringify({ seed, step, src, dst, n }));
            if (expected) legal.push([src, dst, n]);
          }
        }
      }
      states++;
      assert.equal(swp.swpHasMoves(board), legal.length > 0);
      assert.deepEqual(swp.swpAutoMoves(board), modelAuto(board));
      // Random play can paint itself into a corner: that walk ends there.
      if (!legal.length) {
        deadlocks++;
        break;
      }
      // Prefer moves that change something interesting: runs, and moves that
      // empty a cascade or fill an empty one.
      const interesting = legal.filter(([src, dst, n]) => n > 1 || (src < 8 && board.cascades[src].length === n) ||
        (dst < 8 && !board.cascades[dst].length));
      const pick = interesting.length && random() < 0.6 ? interesting : legal;
      const move = pick[Math.floor(random() * pick.length)];
      if (move[2] > 1) multi++;
      if (move[1] < 8 && !board.cascades[move[1]].length) toEmpty++;
      const before = JSON.stringify(board);
      const next = swp.swpApplyMove(board, move);
      assert.equal(JSON.stringify(board), before, 'applyMove leaves its input alone');
      assert.deepEqual(next, modelApply(board, move));
      board = next;
    }
  }
  assert.ok(states >= 200, states + ' positions');
  assert.ok(deadlocks >= 1, 'a random walk met a real deadlock');
  assert.ok(multi >= 5, multi + ' run moves');
  assert.ok(toEmpty >= 5, toEmpty + ' moves to an empty cascade');
});

test('swap space solitaire: a run moves only while n <= (free swap slots + 1) x 2^(empty cascades), an empty destination not counted', () => {
  // free slots k and empty cascades e (cascades 0-1 hold cards, 2-7 are
  // filled from the top down until e of them are empty).
  for (let free = 0; free <= 4; free++) {
    for (let empty = 0; empty <= 5; empty++) {
      const board = makeBoard({ cascades: [['KC'], ['QD']], fill: 1 });
      const pool = board.cascades[1].splice(0, board.cascades[1].length - 1);
      for (let i = 2; i < 8 - empty; i++) board.cascades[i].push(pool.pop());
      for (let i = 0; i < 4 - free; i++) board.slots[i] = pool.pop();
      board.cascades[1] = pool.concat(board.cascades[1]);
      const expect = (free + 1) * 2 ** empty;
      assert.equal(swp.swpMaxMovable(board, 0), expect, free + ' free, ' + empty + ' empty');
      if (empty) assert.equal(swp.swpMaxMovable(board, 7), (free + 1) * 2 ** (empty - 1), 'an empty destination does not count');
      for (const dst of [8, 11, 12, 15]) assert.equal(swp.swpMaxMovable(board, dst), 1);
    }
  }
  // 4 free slots and 1 other empty cascade: a 10-card run fits, an 11-card one would not.
  const run = makeBoard({ cascades: [['KC', 'QH', 'JS', 'TH', '9S', '8H', '7S', '6H', '5S', '4H', '3S'], [], ['KH']], fill: 7 });
  run.cascades[3] = [run.cascades[7].shift()];
  run.cascades[4] = [run.cascades[7].shift()];
  run.cascades[5] = [run.cascades[7].shift()];
  run.cascades[6] = [run.cascades[7].shift()];
  assert.equal(swp.swpMaxMovable(run, 1), 5);
  assert.equal(swp.swpMaxMovable(run, 2), 10);
  assert.equal(swp.swpCanMove(run, 0, 1, 5), true);
  assert.equal(swp.swpCanMove(run, 0, 1, 6), false);
  assert.deepEqual(swp.swpMoveError(run, 0, 1, 6), { code: 'space', n: 6, max: 5, space: { free: 4, empty: 0 } });
});

test('swap space solitaire: every refused move names the reason and the cards involved', () => {
  const board = makeBoard({
    cascades: [['KC', 'AH', '9S'], ['QD', 'TH'], ['8D', '7C'], ['5D'], ['3H'], ['AD'], [], ['9H', '8S']],
    slots: ['4C', null, 'QS'],
    disks: [3, 0, 0, 1],
    fill: 1
  });
  const cases = [
    [[12, 0, 1], { code: 'disk-source', pos: 12 }, 'Cards on /dev/sda stay on disk.'],
    [[0, 0, 1], { code: 'same', pos: 0 }, 'The cards are already on cascade 1.'],
    [[6, 1, 1], { code: 'missing', pos: 6, n: 1 }, 'cascade 7 has no card to move.'],
    [[9, 1, 1], { code: 'missing', pos: 9, n: 1 }, 'swap1 has no card to move.'],
    [[0, 6, 2], { code: 'not-run', card: C('AH') }, 'A♥︎ cannot move: the cards on it are not a run down in alternating colours.'],
    [[2, 9, 2], { code: 'one-card', pos: 9, n: 2 }, 'swap1 takes one card at a time, not 2.'],
    [[2, 13, 2], { code: 'one-card', pos: 13, n: 2 }, '/dev/sdb takes one card at a time, not 2.'],
    [[0, 8, 1], { code: 'slot-full', pos: 8, card: C('4C') }, 'swap0 already holds 4♣︎.'],
    [[4, 13, 1], { code: 'disk-order', card: C('3H'), pos: 13, need: C('AH') }, '3♥︎ cannot go to /dev/sdb yet: it needs A♥︎ first.'],
    [[4, 12, 1], { code: 'disk-suit', card: C('3H'), pos: 12 }, '/dev/sda takes spades only, not 3♥︎.'],
    [[3, 0, 1], { code: 'stack', card: C('5D'), onto: C('9S') }, '5♦︎ does not go on 9♠︎: 9♠︎ takes a red 8.'],
    [[0, 3, 1], { code: 'stack', card: C('9S'), onto: C('5D') }, '9♠︎ does not go on 5♦︎: 5♦︎ takes a black 4.'],
    [[0, 5, 1], { code: 'stack', card: C('9S'), onto: C('AD') }, '9♠︎ does not go on A♦︎: nothing goes on an ace in a cascade.'],
    [[2, 6, 2], null, ''],
    [[0, 9, 1], null, ''],
    [[10, 6, 1], null, ''],
    [[8, 4, 1], { code: 'stack', card: C('4C'), onto: C('3H') }, '4♣︎ does not go on 3♥︎: 3♥︎ takes a black 2.']
  ];
  for (const [[src, dst, n], error, text] of cases) {
    assert.deepEqual(swp.swpMoveError(board, src, dst, n), error, src + '>' + dst + ' x' + n);
    assert.equal(swp.swpCanMove(board, src, dst, n), error === null);
    if (error) assert.equal(swp.swpErrorText(error), text);
  }
  // The space message names the free slots, the empty cascades and the limit.
  assert.equal(swp.swpErrorText({ code: 'space', n: 5, max: 2, space: { free: 1, empty: 0 } }),
    'Not enough swap space for 5 cards: (1 free swap slot + 1) × 2^0 (0 empty cascades) = 2.');
  assert.equal(swp.swpErrorText({ code: 'space', n: 9, max: 8, space: { free: 3, empty: 1 } }),
    'Not enough swap space for 9 cards: (3 free swap slots + 1) × 2^1 (1 empty cascade) = 8.');
});

test('swap space solitaire: only cards no longer needed are flushed: aces and twos, else a card whose lower cards of the other colour are on disk', () => {
  const disks = makeBoard({ disks: [2, 2, 1, 4], fill: 0 });
  assert.equal(swp.swpIsSafe(disks, C('AH')), true);
  assert.equal(swp.swpIsSafe(disks, C('2D')), true);
  assert.equal(swp.swpIsSafe(disks, C('3S')), false, 'diamonds only reach the ace');
  assert.equal(swp.swpIsSafe(disks, C('3H')), true, 'both black suits reach 2');
  assert.equal(swp.swpIsSafe(disks, C('3C')), false);
  assert.equal(swp.swpIsSafe(disks, C('5C')), false, 'clubs are ahead, but the red suits are not');
  for (const card of DECK) assert.equal(swp.swpIsSafe(disks, card), modelSafe(disks, card), nameOf(card));

  // A chain: 3♠ and 3♥ go, 3♦ from a swap slot, then 4♠ once both reds reach 3.
  const chain = makeBoard({
    cascades: [['4S', '3S'], ['5D', '3H'], ['KC'], ['4H']],
    slots: ['3D'],
    disks: [2, 2, 2, 2],
    fill: 2
  });
  const moves = swp.swpAutoMoves(chain);
  assert.deepEqual(moves, modelAuto(chain));
  assert.deepEqual(moves.slice(0, 4), [[0, 12, 1], [1, 13, 1], [8, 14, 1], [0, 12, 1]]);
  assert.deepEqual(swp.swpApplyMoves(chain, moves), applyAll(chain, moves));
  // An unsafe card that could go is left for the player.
  const unsafe = makeBoard({ cascades: [['3S']], disks: [2, 2, 1, 2], fill: 1 });
  assert.equal(swp.swpCanMove(unsafe, 0, 12, 1), true);
  assert.deepEqual(swp.swpAutoMoves(unsafe), []);
  // A board with nothing on top that fits stays as it is.
  assert.deepEqual(swp.swpAutoMoves(BOARD_A()), []);
});

test('swap space solitaire: the win, a deadlock, and how many cards a picked cascade sends', () => {
  const won = makeBoard({ disks: [13, 13, 13, 13] });
  assert.equal(swp.swpIsWon(won), true);
  assert.equal(swp.swpIsWon(NEAR_WON()), false);
  assert.equal(swp.swpHasMoves(won), false);
  const before = PRE_DEADLOCK();
  assert.equal(swp.swpHasMoves(before), true);
  const stuck = swp.swpApplyMove(before, [7, 11, 1]);
  assert.equal(swp.swpHasMoves(stuck), false);
  for (let src = 0; src < 16; src++) {
    for (let dst = 0; dst < 16; dst++) {
      for (let n = 1; n <= 13; n++) assert.equal(modelLegal(stuck, src, dst, n), false);
    }
  }

  // Resolve: a cascade with cards takes the one card of the run that fits;
  // an empty one what was picked, or for a key pick as much as fits.
  const board = makeBoard({
    cascades: [['KC', 'TD', '9S', '8H', '7C'], ['JS'], ['9C'], [], ['QH'], ['2C'], ['8D'], ['KH']],
    slots: ['5H', '5S'],
    fill: 4
  });
  assert.equal(swp.swpResolveCount(board, 0, 1, null), 4, 'J♠ takes 10♦ and what lies on it');
  assert.equal(swp.swpResolveCount(board, 0, 1, 1), 4, 'whatever card was tapped');
  assert.equal(swp.swpResolveCount(board, 0, 2, null), 2, '9♣ takes 8♥ and the 7♣ on it');
  assert.equal(swp.swpResolveCount(board, 0, 6, null), 1, '8♦ takes the 7♣ alone');
  assert.equal(swp.swpResolveCount(board, 0, 5, null), 1, 'nothing fits on 2♣: the top card, refused');
  assert.equal(swp.swpResolveCount(board, 0, 5, 3), 3, 'nothing fits: the tapped cards, refused');
  // Cascade 4 is the only empty one, and 2 swap slots are free: (2 + 1) x 2^0.
  assert.equal(swp.swpMaxMovable(board, 3), 3);
  assert.equal(swp.swpResolveCount(board, 0, 3, null), 3, 'to an empty cascade: as many of the run as the swap space allows');
  assert.equal(swp.swpResolveCount(board, 0, 3, 2), 2, 'or the cards tapped');
  assert.equal(swp.swpResolveCount(board, 0, 9, null), 1);
  assert.equal(swp.swpResolveCount(board, 0, 12, 3), 3);
  assert.equal(swp.swpResolveCount(board, 8, 1, null), 1);
});

// ── Texts, days and saves (pure) ─────────────────────────────────────────────

test('swap space solitaire: time as m:ss, share lines, scores and typed deal numbers', () => {
  assert.equal(swp.swpFormatTime(0), '0:00');
  assert.equal(swp.swpFormatTime(999), '0:00');
  assert.equal(swp.swpFormatTime(65000), '1:05');
  assert.equal(swp.swpFormatTime(4503000), '75:03');
  assert.equal(swp.swpShareText('#5', 'won', { moves: 87, elapsed: 252000, undos: 0, cards: 52 }), 'Swap Space Solitaire #5 4:12 87 page faults');
  assert.equal(swp.swpShareText('#5', 'won', { moves: 1, elapsed: 7000, undos: 1, cards: 52 }), 'Swap Space Solitaire #5 0:07 1 page fault 1 undo');
  assert.equal(swp.swpShareText('deal 48213', 'won', { moves: 90, elapsed: 61000, undos: 3, cards: 52 }), 'Swap Space Solitaire deal 48213 1:01 90 page faults 3 undos');
  assert.equal(swp.swpShareText('#6', 'lost', { moves: 40, elapsed: 125000, undos: 2, cards: 38 }), 'Swap Space Solitaire #6 gave up 2:05 38/52 cards');
  const game = swp.swpNewGame('deal', 9, 9);
  Object.assign(game, { moves: 4, elapsed: 1234.7, undos: 2 });
  assert.deepEqual(swp.swpScoreOf(game), { moves: 4, elapsed: 1234, undos: 2, cards: game.board.disks.reduce((a, b) => a + b, 0) });
  for (const [text, number] of [['48213', 48213], ['#48213', 48213], [' # 7 ', 7], ['999999', 999999], ['000001', 1]]) {
    assert.equal(swp.swpParseDealNumber(text), number, text);
  }
  for (const text of ['', '0', '#0', '1000000', '12a', 'abc', '1.5', '-3', '1 2', undefined, null]) {
    assert.equal(swp.swpParseDealNumber(text), null, String(text));
  }
});

test('swap space solitaire: day keys are local dates, daily numbers count UTC days from 2026-11-01 (#1) and never skip at a clock change', () => {
  assert.equal(swp.swpDayKey(new Date(2026, 10, 5, 0, 0, 1)), '2026-11-05');
  assert.equal(swp.swpDayKey(new Date(2026, 10, 5, 23, 59, 59)), '2026-11-05');
  assert.equal(swp.swpDayKey(new Date(2027, 0, 9, 12)), '2027-01-09');
  assert.equal(swp.swpDailyNumber('2026-11-01'), 1);
  assert.equal(swp.swpDailyNumber('2026-11-05'), 5);
  assert.equal(swp.swpDailyNumber('2026-12-01'), 31);
  assert.equal(swp.swpDailyNumber('2027-03-29'), 149);
  assert.equal(swp.swpDailyNumber('2026-10-31'), 0);
  for (let i = 0; i < 400; i++) {
    const key = swp.swpDayKey(new Date(2026, 10, 1 + i, 12));
    assert.equal(swp.swpDailyNumber(key), i + 1, key);
    const late = swp.swpDayKey(new Date(2026, 10, 1 + i, 23, 30));
    assert.equal(late, key);
  }
  assert.equal(swp.swpDayUtc('2026-11-05'), Date.UTC(2026, 10, 5));
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-11-31', '26-11-05', '2026-11-5', '0099-01-01', ' 2026-11-05', 20261105, null, undefined, {}]) {
    assert.equal(swp.swpDayUtc(bad), null, String(bad));
  }
  assert.equal(swp.swpDayUtc('2028-02-29'), Date.UTC(2028, 1, 29));
  // The daily streak as of a day: it holds while the last win is today's or yesterday's.
  assert.equal(swp.swpDailyStreak(null, 5), 0);
  assert.equal(swp.swpDailyStreak({ lastWon: null, streak: 4 }, 5), 0);
  assert.equal(swp.swpDailyStreak({ lastWon: 5, streak: 4 }, 5), 4);
  assert.equal(swp.swpDailyStreak({ lastWon: 4, streak: 4 }, 5), 4);
  assert.equal(swp.swpDailyStreak({ lastWon: 3, streak: 4 }, 5), 0);
});

test('swap space solitaire: a saved board loads only with every card exactly once', () => {
  const good = BOARD_A();
  const parsed = swp.swpParseBoard(good);
  assert.deepEqual(parsed, good);
  assert.notEqual(parsed.cascades[0], good.cascades[0], 'a copy');
  assert.deepEqual(swp.swpParseBoard(NEAR_WON()), NEAR_WON());
  assert.deepEqual(swp.swpParseBoard(makeBoard({ disks: [13, 13, 13, 13] })), makeBoard({ disks: [13, 13, 13, 13] }));
  const edit = (fn) => {
    const board = BOARD_A();
    fn(board);
    return board;
  };
  const broken = {
    'null': null,
    'an array': [],
    'a string': 'board',
    'no cascades': edit((b) => { delete b.cascades; }),
    'seven cascades': edit((b) => { b.cascades.pop(); }),
    'a cascade that is not a list': edit((b) => { b.cascades[5] = {}; }),
    'a card as text': edit((b) => { b.cascades[0][0] = '51'; }),
    'a card of 52': edit((b) => { b.cascades[0][0] = 52; }),
    'a card of -1': edit((b) => { b.cascades[0][0] = -1; }),
    'a card of 1.5': edit((b) => { b.cascades[0][0] = 1.5; }),
    'a card twice': edit((b) => { b.cascades[5] = [b.cascades[0][2]]; }),
    'a card missing': edit((b) => { b.cascades[0].pop(); }),
    'three swap slots': edit((b) => { b.slots.pop(); }),
    'a swap slot holding text': edit((b) => { b.slots[0] = 'AS'; }),
    'a swap slot repeating a card': edit((b) => { b.slots[1] = b.cascades[6][0]; }),
    'no disks': edit((b) => { b.disks = null; }),
    'five disks': edit((b) => { b.disks.push(0); }),
    'a disk of 14': edit((b) => { b.disks[0] = 14; }),
    'a disk of -1': edit((b) => { b.disks[0] = -1; }),
    'a disk as text': edit((b) => { b.disks[0] = '0'; }),
    'a card on its disk and in a cascade': edit((b) => { b.disks[1] = 1; })
  };
  for (const [name, board] of Object.entries(broken)) assert.equal(swp.swpParseBoard(board), null, name);
});

test('swap space solitaire: a saved undo history is kept only while every step can be undone in turn', () => {
  const start = BOARD_A();
  const m1 = [[0, 1, 1], [0, 13, 1], [2, 13, 1]];
  const m2 = [[4, 8, 1]];
  const now = applyAll(applyAll(start, m1), m2);
  assert.deepEqual(swp.swpParseHistory([m1, m2], now), [m1, m2]);
  const out = swp.swpParseHistory([m1, m2], now);
  assert.notEqual(out[0], m1, 'a copy');
  assert.deepEqual(swp.swpParseHistory([], now), []);
  // Two groups that do not touch the same cards may be read in either order.
  assert.deepEqual(swp.swpParseHistory([m2, m1], now), [m2, m1]);
  for (const [name, history] of Object.entries({
    'not a list': { 0: m1 },
    'a group that is not a list': [m1, 'x'],
    'an empty group': [m1, []],
    'a move of two numbers': [m1, [[4, 8]]],
    'a move as text': [m1, ['4,8,1']],
    'a move from a disk': [m1, [[13, 8, 1]]],
    'a move to position 16': [m1, [[4, 16, 1]]],
    'a move onto itself': [m1, [[4, 4, 1]]],
    'a move of 0 cards': [m1, [[4, 8, 0]]],
    'a move of 14 cards': [m1, [[4, 5, 14]]],
    'two cards to a swap slot': [m1, [[4, 8, 2]]],
    'a fractional position': [m1, [[4.5, 8, 1]]],
    'steps that do not match the board': [m1, m1],
    // Undone, 6♠ would go back onto 5♦; played forward it could never have
    // gone from there onto Q♣.
    'a move the rules never allowed': [[[3, 7, 1]]],
    'a card taken back into a full swap slot': [[[8, 5, 1]]]
  })) {
    const board = name === 'a card taken back into a full swap slot' ? makeBoard({ cascades: [[], [], [], [], [], ['4C']], slots: ['5D'], fill: 0 }) : now;
    assert.deepEqual(swp.swpParseHistory(history, board), [], name);
  }
  // Only the newest 500 groups are kept.
  const card = makeBoard({ cascades: [[], [], [], []], slots: ['KC'], fill: 0 });
  const groups = Array.from({ length: 600 }, (_, k) => ((599 - k) % 2 === 0 ? [[3, 8, 1]] : [[8, 3, 1]]));
  const kept = swp.swpParseHistory(groups, card);
  assert.equal(kept.length, 500);
  assert.deepEqual(kept, groups.slice(100));
});

test('swap space solitaire: a saved game is read field by field', () => {
  const board = BOARD_A();
  const raw = gameOf(board, { moves: 3, undos: 1, elapsed: 4500.5, started: true, counted: true, history: [[[4, 8, 1]]] });
  raw.board = applyAll(board, [[4, 8, 1]]);
  const game = swp.swpParseGame(raw, ['deal'], 777, 777);
  assert.deepEqual(game, { ...raw, history: [[[4, 8, 1]]] });
  assert.equal(swp.swpParseGame(raw, ['daily', 'practice'], 777, 777), null, 'another kind');
  assert.equal(swp.swpParseGame(null, ['deal'], 1, 1), null);
  assert.equal(swp.swpParseGame([], ['deal'], 1, 1), null);
  // The deal and seed come from the caller, never from the save.
  assert.equal(swp.swpParseGame({ ...raw, deal: 5, seed: 9 }, ['deal'], 777, 777).seed, 777);
  // A broken board is dealt again from the seed, as by Restart.
  const fresh = swp.swpParseGame({ ...raw, board: { cascades: [] } }, ['deal'], 4242, 4242);
  assert.deepEqual(fresh.board, swp.swpStartBoard(4242));
  assert.deepEqual([fresh.moves, fresh.history, fresh.undos, fresh.elapsed, fresh.started, fresh.counted], [0, [], 1, 4500.5, true, true]);
  // Odd numbers become 0; missing flags follow the moves.
  const odd = swp.swpParseGame({ ...raw, moves: '3', undos: -1, elapsed: 'x', started: 'yes', counted: 1 }, ['deal'], 777, 777);
  assert.deepEqual([odd.moves, odd.undos, odd.elapsed, odd.started, odd.counted], [0, 0, 0, false, false]);
  for (const elapsed of [-1, NaN, Infinity, null, '100']) {
    assert.equal(swp.swpParseGame({ ...raw, elapsed }, ['deal'], 777, 777).elapsed, 0, String(elapsed));
  }
  const unflagged = swp.swpParseGame({ ...raw, started: undefined, counted: undefined }, ['deal'], 777, 777);
  assert.deepEqual([unflagged.started, unflagged.counted], [true, true]);
  // A practice game never counts in the stats.
  assert.equal(swp.swpParseGame({ ...raw, kind: 'practice' }, ['practice'], 5, 5).counted, false);
  // The result follows the board: a full set of disks is won whatever the save says.
  const won = makeBoard({ disks: [13, 13, 13, 13] });
  assert.equal(swp.swpParseGame({ ...raw, board: won, history: [], over: null }, ['deal'], 777, 777).over, 'won');
  assert.equal(swp.swpParseGame({ ...raw, over: 'lost' }, ['deal'], 777, 777).over, 'lost');
  assert.equal(swp.swpParseGame({ ...raw, over: 'won' }, ['deal'], 777, 777).over, null);
  assert.equal(swp.swpParseGame({ ...raw, history: 'x' }, ['deal'], 777, 777).history.length, 0);
});

test('swap space solitaire: swp-state, swp-stats and swp-daily are read field by field', () => {
  const game = gameOf(BOARD_A(), { deal: 31337, seed: 31337 });
  assert.deepEqual(swp.swpParseState(JSON.stringify({ v: 1, mode: 'deal', game })), { mode: 'deal', deal: { ...game } });
  assert.equal(swp.swpParseState(JSON.stringify({ mode: 'daily', game })).mode, 'daily');
  assert.equal(swp.swpParseState(JSON.stringify({ mode: 'other', game })).mode, 'deal');
  for (const text of [null, '', '{', 'null', '[]', '5', '"x"']) assert.equal(swp.swpParseState(text), null, String(text));
  for (const deal of [0, 1000000, 1.5, '5', null]) {
    assert.deepEqual(swp.swpParseState(JSON.stringify({ mode: 'deal', game: { ...game, deal } })), { mode: 'deal', deal: null }, String(deal));
  }
  assert.deepEqual(swp.swpParseState(JSON.stringify({ mode: 'deal', game: 'x' })), { mode: 'deal', deal: null });
  assert.deepEqual(swp.swpParseState(JSON.stringify({ mode: 'deal', game: { ...game, kind: 'daily' } })), { mode: 'deal', deal: null });

  assert.deepEqual(swp.swpParseStats(JSON.stringify({ played: 9, won: 4, streak: 2, best: 3 })), { played: 9, won: 4, streak: 2, best: 3 });
  assert.deepEqual(swp.swpParseStats(null), { played: 0, won: 0, streak: 0, best: 0 });
  assert.deepEqual(swp.swpParseStats('[1]'), { played: 0, won: 0, streak: 0, best: 0 });
  assert.deepEqual(swp.swpParseStats(JSON.stringify({ played: -1, won: 3, streak: 'x', best: 1.5 })), { played: 3, won: 3, streak: 0, best: 0 });
  assert.deepEqual(swp.swpParseStats(JSON.stringify({ played: 2, won: 1, streak: 7, best: 0 })), { played: 2, won: 1, streak: 1, best: 1 });

  const near = dailySave(NEAR_WON(), { started: true, counted: true, moves: 9 }, { streak: 2, best: 4, lastWon: 4 });
  const daily = swp.swpParseDaily(JSON.stringify({ ...near, number: 99 }));
  assert.equal(daily.number, 5, 'the number comes from the day');
  assert.equal(daily.game.seed, DAILY_SEED, 'so does the seed');
  assert.deepEqual([daily.day, daily.result, daily.score, daily.streak, daily.best, daily.lastWon], [TODAY, null, null, 2, 4, 4]);
  for (const text of [null, '', '{', '[]', '7']) assert.equal(swp.swpParseDaily(text), null, String(text));
  // A broken day keeps only the streak fields.
  const noDay = swp.swpParseDaily(JSON.stringify({ ...near, day: '2026-02-30', streak: 3, best: 1, lastWon: 'x' }));
  assert.deepEqual(noDay, { day: null, number: 0, result: null, score: null, game: null, streak: 3, best: 3, lastWon: null });
  // A daily game's own end decides the result; a saved result alone does not.
  const won = makeBoard({ disks: [13, 13, 13, 13] });
  const wonDay = swp.swpParseDaily(JSON.stringify(dailySave(won, { moves: 80, elapsed: 90000, undos: 2, started: true, counted: true }, { result: null })));
  assert.equal(wonDay.result, 'won');
  assert.deepEqual(wonDay.score, { moves: 80, elapsed: 90000, undos: 2, cards: 52 });
  const gaveUp = swp.swpParseDaily(JSON.stringify(dailySave(BOARD_A(), { over: 'lost', moves: 3 }, { result: 'won' })));
  assert.equal(gaveUp.result, 'lost');
  assert.equal(swp.swpParseDaily(JSON.stringify(dailySave(BOARD_A(), {}, { result: 'won' }))).result, null);
  // A practice game means the day was played: a result is kept, or lost.
  const practice = dailySave(BOARD_A(), { kind: 'practice' }, { result: 'won', score: { moves: 70, elapsed: '9', undos: 1, cards: 60 } });
  const practiced = swp.swpParseDaily(JSON.stringify(practice));
  assert.equal(practiced.result, 'won');
  assert.deepEqual(practiced.score, { moves: 70, elapsed: 0, undos: 1, cards: 52 });
  assert.equal(practiced.game.counted, false);
  assert.equal(swp.swpParseDaily(JSON.stringify({ ...practice, result: 'x' })).result, 'lost');
  assert.deepEqual(swp.swpParseDaily(JSON.stringify({ ...practice, score: 'x' })).score, { moves: 0, elapsed: 0, undos: 0, cards: 0 });
  // A broken game is dealt again: a practice once the day has a result.
  const brokenDone = swp.swpParseDaily(JSON.stringify({ ...near, result: 'lost', game: 'x' }));
  assert.deepEqual([brokenDone.game.kind, brokenDone.result], ['practice', 'lost']);
  assert.deepEqual(brokenDone.game.board, swp.swpStartBoard(DAILY_SEED));
  const brokenOpen = swp.swpParseDaily(JSON.stringify({ ...near, game: null }));
  assert.deepEqual([brokenOpen.game.kind, brokenOpen.result, brokenOpen.game.started], ['daily', null, false]);
});

// ── The page ─────────────────────────────────────────────────────────────────

test('swap space solitaire: loading the script under Node runs no init: no lookup, no listener, no timer', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.swpInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['swp-table'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('swap space solitaire: a first visit deals a random numbered deal, draws the table, saves at once and binds every control once', (t) => {
  const random = t.mock.method(Math, 'random', () => 0.5);
  const page = openPage(t);
  assert.equal(random.mock.callCount(), 1);
  assert.equal(page.text('swp-label'), 'Deal #500000');
  assert.equal(page.status(), 'Deal #500000: tap a card, then tap where it goes. Flush all 52 cards to /dev/sda-sdd.');
  assert.deepEqual(page.shown(), swp.swpStartBoard(500000));
  assert.deepEqual(page.numbers(), ['0', '0:00', '0/0', '0', '0', '0']);
  assert.deepEqual(page.state(), { v: 1, mode: 'deal', game: swp.swpNewGame('deal', 500000, 500000) });
  assert.deepEqual(page.stats(), { played: 0, won: 0, streak: 0, best: 0 });
  assert.equal(localStorage.getItem(DAILY_KEY), null, 'no daily attempt until the Daily tab');
  // The table: 4 swap slots and 4 disks over 8 cascades of card buttons.
  assert.equal(page.table.children.length, 2);
  assert.deepEqual(page.table.children[0].children.map((el) => el.getAttribute('aria-label')), [
    'swap0 (key Q): empty', 'swap1 (key W): empty', 'swap2 (key E): empty', 'swap3 (key R): empty',
    ...[0, 1, 2, 3].map((s) => {
      const count = swp.swpStartBoard(500000).disks[s];
      return DISKS[s] + ' (' + SUIT_NAMES[s] + ', key F): ' + (count ? nameOf(s * 13 + count - 1) : 'empty');
    })
  ]);
  assert.deepEqual(page.slot(0).children.map((el) => el.textContent), ['swap0', 'Q']);
  assert.equal(page.disk(1).children[0].textContent, 'sdb');
  const card = page.top(0);
  const top = swp.swpStartBoard(500000).cascades[0].slice(-1)[0];
  assert.equal(card.tagName, 'BUTTON');
  assert.equal(card.type, 'button');
  assert.equal(card.className, 'swp-card ' + (isRed(top) ? 'swp-red' : 'swp-black'));
  assert.equal(card.textContent, face(top) + GLYPHS[suitOf(top)]);
  assert.equal(card.getAttribute('aria-label'), nameOf(top) + ', cascade 1');
  // Buttons: Undo and Restart wait for a move, Share and Practice for a result.
  assert.equal(page.els['swp-undo'].disabled, true);
  assert.equal(page.els['swp-restart'].disabled, true);
  assert.equal(page.els['swp-give-up'].disabled, false);
  assert.equal(page.hidden('swp-share'), true);
  assert.equal(page.hidden('swp-practice'), true);
  assert.equal(page.hidden('swp-deal-controls'), false);
  assert.equal(page.hidden('swp-warning'), true);
  assert.equal(page.els['swp-tab-deals'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.els['swp-tab-daily'].getAttribute('aria-pressed'), 'false');
  assert.equal(page.toast(), null);
  for (const id of ['swp-table', 'swp-tab-deals', 'swp-tab-daily', 'swp-new-deal', 'swp-play-deal', 'swp-undo', 'swp-restart', 'swp-give-up', 'swp-share', 'swp-practice']) {
    assert.equal(listenerCount(page.els[id], 'click'), 1, id);
  }
  assert.equal(listenerCount(page.els['swp-deal-input'], 'keydown'), 1);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(window, 'pagehide'), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  assert.equal(listenerCount(window), 2);
  // No clock before the first move.
  t.mock.timers.tick(5000);
  assert.equal(page.text('swp-time'), '0:00');
});

test('swap space solitaire: while the page is still loading the game waits for DOMContentLoaded, and init runs once', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A()) }, { readyState: 'loading' });
  assert.equal(page.table.children.length, 0);
  assert.equal(page.status(), 'Loading the deal...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(document, 'keydown'), 0);
  page.ready();
  assert.deepEqual(page.shown(), BOARD_A());
  assert.equal(listenerCount(document, 'keydown'), 1);

  resetStubs();
  writeStorage({ state: dealSave(BOARD_A()) });
  const { exports: mod, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  mod.swpInit();
  mod.swpInit();
  assert.equal(els['swp-table'].children.length, 2, 'the table is built once');
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(els['swp-table'], 'click'), 1);
  assert.equal(mod.swpState.deal.deal, 777);
});

test('swap space solitaire: a card and a target: two taps move it, safe cards flush after it, and the move is counted and saved', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A()) });
  page.tap(0);
  assert.equal(page.status(), 'Selected 9♠︎ in cascade 1: tap where it goes.');
  assert.deepEqual(page.selected(), ['9 of spades, cascade 1, selected']);
  assert.deepEqual(page.targets(), [1, 5, 8, 9, 10, 11], 'onto 10♥, the empty cascade, every free swap slot');
  assert.equal(page.top(0).classList.contains('swp-selected'), true);
  assert.equal(page.column(1).classList.contains('swp-target'), true);
  assert.equal(page.slot(0).classList.contains('swp-target'), true);
  assert.equal(page.state().game.moves, 0, 'picking is no move');

  page.tap(1);
  const expected = applyAll(BOARD_A(), [[0, 1, 1], [0, 13, 1], [2, 13, 1]]);
  assert.equal(page.status(), 'Moved 9♠︎ to cascade 2. 2 cards flushed to disk.');
  assert.deepEqual(page.shown(), expected);
  assert.deepEqual(page.selected(), []);
  assert.deepEqual(page.targets(), []);
  const game = page.state().game;
  assert.deepEqual(game.board, expected);
  assert.deepEqual(game.history, [[[0, 1, 1], [0, 13, 1], [2, 13, 1]]]);
  assert.deepEqual([game.moves, game.started, game.counted, game.over], [1, true, true, null]);
  assert.deepEqual(page.stats(), { played: 1, won: 0, streak: 0, best: 0 });
  assert.deepEqual(page.numbers().slice(0, 3), ['1', '0:00', '0/1']);
  assert.equal(page.els['swp-undo'].disabled, false);
  assert.equal(page.els['swp-restart'].disabled, false);
  assert.equal(page.disk(1).getAttribute('aria-label'), '/dev/sdb (hearts, key F): 2 of hearts');
  assert.equal(page.disk(1).className, 'swp-slot swp-disk swp-card swp-red');
  assert.equal(page.column(2).children[0].className, 'swp-slot swp-empty');
  assert.equal(page.column(2).children[0].getAttribute('aria-label'), 'Cascade 3 (key 3): empty');

  // A run of two onto a matching card: 7♣ on 8♦ goes onto 9♠ with the 8.
  page.tap(4, 2);
  assert.equal(page.status(), 'Selected 8♦︎ and the 1 card on it in cascade 5: tap where it goes.');
  assert.deepEqual(page.selected(), ['8 of diamonds, cascade 5, selected', '7 of clubs, cascade 5, selected']);
  page.tap(1);
  assert.equal(page.status(), 'Moved 8♦︎ and the 1 card on it to cascade 2.');
  assert.deepEqual(page.shown().cascades[1].slice(-4), ['QD', 'TH', '9S', '8D'].map(C).concat([C('7C')]).slice(-4));
  assert.equal(page.state().game.moves, 2);
});

test('swap space solitaire: tapping the picked card again sends it to its disk, else to the first free swap slot, else says why not', (t) => {
  const board = makeBoard({ cascades: [['AS'], ['7H'], ['5C', '4D'], ['3C', '9D', '8C']], fill: 7 });
  const page = openPage(t, { state: dealSave(board) });
  page.tap(0);
  page.tap(0);
  assert.equal(page.status(), 'Moved A♠︎ to /dev/sda.');
  assert.equal(page.shown().disks[0], 1);
  // The free area of the picked card's cascade counts as the card.
  page.tap(1);
  page.column(1).click();
  assert.equal(page.status(), 'Moved 7♥︎ to swap0.');
  assert.equal(page.shown().slots[0], C('7H'));
  // From a swap slot only the disk is tried.
  page.tapSlot(0);
  assert.equal(page.status(), 'Selected 7♥︎ in swap0: tap where it goes.');
  page.tapSlot(0);
  assert.equal(page.status(), '7♥︎ cannot go to /dev/sdb yet: it needs A♥︎ first.');
  assert.equal(page.shown().slots[0], C('7H'));
  // A picked run tapped again is put down.
  page.tap(3, 2);
  page.tap(3, 2);
  assert.equal(page.status(), 'Selection cleared.');
  assert.deepEqual(page.selected(), []);
  // With every slot full the card stays and the status says so.
  page.tap(2);
  page.tap(2);
  page.tap(3);
  page.tap(3);
  page.tap(2);
  page.tap(2);
  assert.deepEqual(page.shown().slots, ['7H', '4D', '8C', '5C'].map(C));
  page.tap(3);
  page.tap(3);
  assert.equal(page.status(), '9♦︎ cannot go to /dev/sdc yet: it needs A♦︎ first. All 4 swap slots are full.');
  assert.equal(page.state().game.moves, 5, 'A♠, 7♥, 4♦, 8♣, 5♣');
});

test('swap space solitaire: a refused move says why with the cards involved, and a tap on another card picks that card instead', (t) => {
  const board = makeBoard({
    cascades: [['KC', 'AH', '9S'], ['QD', 'TH'], ['2H'], ['5D'], ['8D', '7C'], [], ['KH'], ['6S']],
    slots: [null, '3S'],
    fill: 7
  });
  const page = openPage(t, { state: dealSave(board) });
  const before = localStorage.getItem(STATE_KEY);
  // Nothing picked: disks, empty slots and empty cascades only explain.
  page.tapDisk(0);
  assert.equal(page.status(), 'Cards on /dev/sda stay on disk.');
  page.tapSlot(0);
  assert.equal(page.status(), 'swap0 is empty: pick a card to move first.');
  page.tapEmpty(5);
  assert.equal(page.status(), 'cascade 6 is empty: pick a card to move first.');
  page.tap(0, 2);
  assert.equal(page.status(), 'A♥︎ is buried: only the run on top of cascade 1 can move.');
  assert.deepEqual(page.selected(), []);

  // 9♠ onto 5♦: refused, and 5♦ is picked instead.
  page.tap(0);
  page.tap(3);
  assert.equal(page.status(), '9♠︎ does not go on 5♦︎: 5♦︎ takes a black 4. Selected 5♦︎ in cascade 4: tap where it goes.');
  assert.deepEqual(page.selected(), ['5 of diamonds, cascade 4, selected']);
  // 5♦ onto the full swap1: refused, and 3♠ there is picked.
  page.tapSlot(1);
  assert.equal(page.status(), 'swap1 already holds 3♠︎. Selected 3♠︎ in swap1: tap where it goes.');
  // Any disk means the card's own one: 3♠ needs A♠ first.
  page.tapDisk(2);
  assert.equal(page.status(), '3♠︎ cannot go to /dev/sda yet: it needs A♠︎ first.');
  assert.deepEqual(page.selected(), ['swap1 (key W): 3 of spades'], 'a disk cannot be picked: the pick stays');
  // A run onto a swap slot: one card at a time.
  page.tap(4, 2);
  page.tapSlot(2);
  assert.equal(page.status(), 'swap2 takes one card at a time, not 2.');
  assert.deepEqual(page.selected().length, 2);
  // Tapping a cascade's free area below its cards moves there too.
  page.column(6).click();
  assert.equal(page.status(), '8♦︎ does not go on K♥︎: K♥︎ takes a black Q. Selected K♥︎ in cascade 7: tap where it goes.');
  page.table.click();
  assert.deepEqual(page.selected(), ['king of hearts, cascade 7, selected'], 'the table padding changes nothing');
  assert.equal(localStorage.getItem(STATE_KEY), before, 'nothing moved, nothing saved');
});

test('swap space solitaire: run moves follow the swap space, and the tapped card decides how many go to an empty cascade', (t) => {
  // 9♠ 8♥ 7♣ 6♦ on Q♣ in cascade 1, 10♦ in cascade 2, cascade 3 empty, three
  // swap slots full.
  const board = makeBoard({
    cascades: [['QC', '9S', '8H', '7C', '6D'], ['TD'], [], ['KS'], ['KH'], ['KD'], ['QH'], ['QS']],
    slots: ['JC', 'JH', 'JD'],
    fill: 7
  });
  const page = openPage(t, { state: dealSave(board) });
  // (1 free + 1) x 2^0 (the empty destination does not count) = 2.
  page.tap(0, 4);
  page.tapEmpty(2);
  assert.equal(page.status(), 'Not enough swap space for 4 cards: (1 free swap slot + 1) × 2^0 (0 empty cascades) = 2.');
  assert.equal(page.selected().length, 4, 'the pick stays for another target');
  // Onto 10♦ the whole run needs (1 + 1) x 2^1 = 4: it goes.
  assert.deepEqual(page.targets(), [1], 'a run never goes to a swap slot');
  page.tap(1);
  assert.equal(page.status(), 'Moved 9♠︎ and the 3 cards on it to cascade 2.');
  assert.deepEqual(page.shown().cascades[1].slice(-5), ['TD', '9S', '8H', '7C', '6D'].map(C));
  // Two tapped cards go to the empty cascade.
  page.tap(1, 2);
  page.tapEmpty(2);
  assert.equal(page.status(), 'Moved 7♣︎ and the 1 card on it to cascade 3.');
  assert.deepEqual(page.shown().cascades[2], ['7C', '6D'].map(C));
  assert.deepEqual(page.state().game.history.map((group) => group[0]), [[0, 1, 4], [1, 2, 2]]);
});

test('swap space solitaire: keys while the focus is in the game: 1-8 cascades, Q W E R slots, F the disk, U and Ctrl+Z undo, Escape cancels', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A()) });
  const before = localStorage.getItem(STATE_KEY);
  // Keys on the page body, a host field or a host button are not the game's.
  const hostInput = page.page.add('host-input', 'input');
  const hostButton = page.page.add('host-button', 'button');
  for (const target of [document.body, hostInput, hostButton]) {
    const event = pressKey('1', { target });
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(page.selected(), []);
  focusElement(page.table, { keyboard: true });
  // Modifiers, held keys, composing, handled keys and the game's own fields.
  for (const props of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }]) {
    assert.equal(pressKey('1', props).defaultPrevented, false, JSON.stringify(props));
  }
  const handled = (event) => event.preventDefault();
  document.addEventListener('keydown', handled, true);
  pressKey('1');
  document.removeEventListener('keydown', handled, true);
  focusElement(page.els['swp-deal-input']);
  assert.equal(pressKey('1').defaultPrevented, false, 'digits typed into the deal number');
  const editable = page.page.add('swp-test-editable', { parent: 'swp-wrapper', isContentEditable: true });
  assert.equal(pressKey('1', { target: editable }).defaultPrevented, false);
  focusElement(page.table, { keyboard: true });
  assert.equal(pressKey('9').defaultPrevented, false);
  assert.equal(pressKey('Escape').defaultPrevented, false, 'Escape with nothing picked is left alone');
  assert.equal(pressKey(undefined).defaultPrevented, false, 'an autofill keydown');
  assert.deepEqual(page.selected(), []);
  assert.equal(localStorage.getItem(STATE_KEY), before);

  // 1 picks cascade 1's run, 2 drops it on cascade 2.
  assert.equal(pressKey('1').defaultPrevented, true);
  assert.equal(page.status(), 'Selected 9♠︎ in cascade 1: tap where it goes.');
  assert.equal(pressKey('Escape').defaultPrevented, true);
  assert.equal(page.status(), 'Selection cleared.');
  pressKey('1');
  pressKey('2');
  assert.deepEqual(page.state().game.history, [[[0, 1, 1], [0, 13, 1], [2, 13, 1]]]);
  // U undoes, Ctrl+Z and Cmd+Z too; Ctrl+Shift+Z (redo) is left alone.
  assert.equal(pressKey('u').defaultPrevented, true);
  assert.deepEqual(page.shown(), BOARD_A());
  pressKey('1');
  pressKey('2');
  assert.equal(pressKey('z', { ctrlKey: true }).defaultPrevented, true);
  assert.deepEqual(page.shown(), BOARD_A());
  pressKey('1');
  pressKey('2');
  assert.equal(pressKey('z', { metaKey: true, shiftKey: true }).defaultPrevented, false);
  assert.equal(pressKey('z').defaultPrevented, false, 'a plain z is nothing');
  assert.equal(pressKey('Z', { metaKey: true }).defaultPrevented, true);
  assert.deepEqual(page.shown(), BOARD_A());
  // Q W E R are the swap slots: 5 to swap0 with Q, back with Q then 4.
  pressKey('5');
  pressKey('q');
  assert.equal(page.shown().slots[0], C('7C'));
  pressKey('Q');
  pressKey('6');
  assert.equal(page.status(), 'Moved 7♣︎ to cascade 6.');
  // Other layouts: the key position counts (Cyrillic й is Q, AZERTY & is 1).
  pressKey('й', { code: 'KeyQ' });
  assert.equal(page.status(), 'swap0 is empty: pick a card to move first.');
  pressKey('&', { code: 'Digit1' });
  assert.equal(page.status(), 'Selected 9♠︎ in cascade 1: tap where it goes.');
  // The same cascade key again sends the top card away (here to swap0).
  pressKey('1');
  assert.equal(page.status(), 'Moved 9♠︎ to swap0. 2 cards flushed to disk.');
  // F: the picked card to its disk.
  pressKey('f');
  assert.equal(page.status(), 'Pick a card first: 1-8 for a cascade, Q W E R for a swap slot, then F sends it to its disk.');
  pressKey('4');
  pressKey('f');
  assert.equal(page.status(), '5♦︎ cannot go to /dev/sdc yet: it needs A♦︎ first.');
  pressKey('Escape');
  pressKey('а', { code: 'KeyF' });
  assert.equal(page.status(), 'Pick a card first: 1-8 for a cascade, Q W E R for a swap slot, then F sends it to its disk.');
  pressKey('г', { code: 'KeyU' });
  assert.equal(page.shown().slots[0], null, 'U on a Cyrillic layout undid the move to swap0');
});

test('swap space solitaire: Tab stops on the table once, not on its cards and slots; a click gives the table the focus when it was outside the game, and a rebuilt cascade gives the focus back', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A()) });
  // The Tab stops of the embed in page order: enabled controls not hidden
  // and not taken out with tabindex -1, and elements given tabindex >= 0.
  const wrapper = page.els['swp-wrapper'];
  const tabStops = () => [wrapper, ...wrapper.querySelectorAll('*')].filter((el) => {
    const tab = el.getAttribute('tabindex');
    if (tab === '-1' || el.disabled || (tab === null && !/^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|A)$/.test(el.tagName))) return false;
    for (let node = el; node && node.classList; node = node.parentElement) if (node.classList.contains('swp-hidden')) return false;
    return true;
  }).map((el) => el.id || el.tagName);
  // The page stub builds the elements with an id; in the markup only the
  // How to play summary adds one more stop.
  assert.deepEqual(tabStops(), ['swp-tab-deals', 'swp-tab-daily', 'swp-new-deal', 'swp-deal-input', 'swp-play-deal', 'swp-give-up', 'swp-table']);
  const markup = embedMarkup(HTML);
  assert.equal((markup.match(/<summary\b/g) || []).length, 1);
  assert.equal((markup.match(/<(button|input|select|textarea|a)\b(?![^>]*\bid=)[^>]*>/g) || []).length, 0, 'every other control has an id');
  // 52 cards, 4 swap slots, 4 disks and the empty cascade 6 are buttons, all out of the Tab order.
  const buttons = page.table.querySelectorAll('button');
  assert.equal(buttons.length, 61);
  assert.ok(buttons.every((el) => el.getAttribute('tabindex') === '-1'));
  page.tap(0);
  page.tapSlot(0);
  assert.ok(page.table.querySelectorAll('button').every((el) => el.getAttribute('tabindex') === '-1'), 'rebuilt cascades too');
  assert.deepEqual(tabStops(), ['swp-tab-deals', 'swp-tab-daily', 'swp-new-deal', 'swp-deal-input', 'swp-play-deal', 'swp-undo', 'swp-restart', 'swp-give-up', 'swp-table']);
  page.click('swp-undo');
  page.table.blur();
  assert.deepEqual(page.shown(), BOARD_A());
  same(document.activeElement, document.body);
  const focus = t.mock.method(page.table, 'focus');
  page.tap(4);
  same(document.activeElement, page.table, 'Safari never focuses a clicked button: the table takes the keys');
  assert.deepEqual(focus.mock.calls.map((call) => call.arguments), [[{ preventScroll: true }]], 'without scrolling the host page');
  page.els['swp-give-up'].focus();
  page.tap(3);
  same(document.activeElement, page.els['swp-give-up'], 'a focus already inside the game stays');
  pressKey('Escape', { target: page.els['swp-give-up'] });

  // Enter on a focused card clicks it; the rebuilt card gets the focus back.
  focusElement(page.top(4), { keyboard: true });
  pressKey('Enter');
  assert.equal(page.status(), 'Selected 7♣︎ in cascade 5: tap where it goes.');
  same(document.activeElement, page.top(4));
  assert.equal(document.activeElement.getAttribute('data-index'), String(page.cards(4).length - 1));
  // Enter again sends it to swap0: the card is gone, the table keeps the focus.
  pressKey('Enter');
  assert.equal(page.status(), 'Moved 7♣︎ to swap0.');
  same(document.activeElement, page.table);
  assert.deepEqual(focus.mock.calls.at(-1).arguments, [{ preventScroll: true }]);
  // A focused swap slot is never rebuilt, so it keeps the focus.
  focusElement(page.slot(0), { keyboard: true });
  pressKey('Enter');
  same(document.activeElement, page.slot(0));
  assert.equal(page.status(), 'Selected 7♣︎ in swap0: tap where it goes.');
});

test('swap space solitaire: Undo takes back the move and the cards flushed after it, and the history keeps the last 500 moves', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A()) });
  // The button waits for a move; the U key says why.
  assert.equal(page.els['swp-undo'].disabled, true);
  focusElement(page.table);
  pressKey('u');
  assert.equal(page.status(), 'Nothing to undo yet.');
  page.tap(0);
  page.tap(1);
  page.click('swp-undo');
  assert.equal(page.status(), 'Undid the last move and the 2 cards flushed after it: 0 page faults.');
  assert.deepEqual(page.shown(), BOARD_A());
  const game = page.state().game;
  assert.deepEqual([game.moves, game.undos, game.history, game.started], [0, 1, [], true]);
  assert.equal(page.els['swp-undo'].disabled, true);
  page.tap(4);
  page.tapSlot(3);
  page.click('swp-undo');
  assert.equal(page.status(), 'Undid the last move: 0 page faults.');

  // 600 moves of K♣ between cascade 4 and swap0 in the save: 500 come back.
  resetStubs();
  const card = makeBoard({ cascades: [[], [], [], []], slots: ['KC'], fill: 0 });
  const groups = Array.from({ length: 600 }, (_, k) => ((599 - k) % 2 === 0 ? [[3, 8, 1]] : [[8, 3, 1]]));
  const long = openPage(t, { state: dealSave(card, { history: groups, moves: 600, started: true, counted: true }) });
  assert.equal(long.state().game.history.length, 500);
  long.tapSlot(0);
  long.tapEmpty(3);
  assert.equal(long.state().game.history.length, 500, 'the oldest move is dropped');
  assert.equal(long.state().game.moves, 601);
  for (let i = 0; i < 500; i++) long.click('swp-undo');
  assert.equal(long.state().game.moves, 101);
  assert.equal(long.els['swp-undo'].disabled, true);
  focusElement(long.table);
  pressKey('u');
  assert.equal(long.status(), 'Nothing left to undo: the undo history keeps the last 500 moves.');
  assert.equal(long.state().game.moves, 101);
});

test('swap space solitaire: Restart asks for a second press, then goes back to the deal\'s first layout, counts the moves as undone and keeps the clock running', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A(), { deal: 4242, seed: 4242, undos: 1 }) });
  assert.equal(page.els['swp-restart'].disabled, true, 'nothing to restart before the first move');
  page.tap(0);
  page.tap(1);
  page.tap(4);
  page.tapSlot(0);
  t.mock.timers.tick(3000);
  // It cannot be undone, so the first press only asks, naming what is lost.
  const ask = 'Press Restart again to go back to the first layout of Deal #4242 (2 moves will count as undone).';
  const played = page.shown();
  page.click('swp-restart');
  assert.equal(page.status(), ask);
  assert.equal(page.toast(), ask);
  assert.deepEqual(page.shown(), played, 'nothing changes on the first press');
  assert.equal(page.state().game.moves, 2);
  // The question lapses after 4 s; Undo (next to it) cancels it too.
  t.mock.timers.tick(4000);
  assert.equal(page.status(), 'Deal #4242 in progress: 2 page faults so far.');
  page.click('swp-restart');
  page.click('swp-undo');
  page.click('swp-restart');
  assert.equal(page.status(), 'Press Restart again to go back to the first layout of Deal #4242 (1 move will count as undone).');
  assert.equal(page.state().game.moves, 1, 'the press after Undo asked again');
  page.tap(4);
  page.tapSlot(0);
  page.click('swp-restart');
  page.click('swp-restart');
  assert.equal(page.status(), 'Restarted Deal #4242 from its first layout: 2 moves counted as undone; the clock keeps running.');
  assert.deepEqual(page.shown(), swp.swpStartBoard(4242));
  const game = page.state().game;
  // 1 undo saved + the Undo press + the 2 moves Restart took back.
  assert.deepEqual([game.moves, game.undos, game.history, game.started, game.counted, game.elapsed], [0, 4, [], true, true, 7000]);
  assert.equal(page.els['swp-restart'].disabled, true);
  t.mock.timers.tick(2000);
  assert.equal(page.text('swp-time'), '0:09');
  // A save whose history was trimmed away can still restart.
  resetStubs();
  const trimmed = openPage(t, { state: dealSave(BOARD_A(), { moves: 700, started: true, counted: true }) });
  assert.equal(trimmed.els['swp-restart'].disabled, false);
  trimmed.click('swp-restart');
  assert.equal(trimmed.status(), 'Press Restart again to go back to the first layout of Deal #777 (700 moves will count as undone).');
  trimmed.click('swp-restart');
  assert.deepEqual(trimmed.shown(), swp.swpStartBoard(777));
});

test('swap space solitaire: the last card to disk wins: stats, toast, a frozen board, and the same after a reload', (t) => {
  const page = openPage(t, {
    state: dealSave(NEAR_WON(), { moves: 9, elapsed: 65000, started: true, counted: true }),
    stats: { played: 4, won: 2, streak: 1, best: 3 }
  });
  assert.equal(page.status(), 'Deal #777 in progress: 9 page faults so far.');
  t.mock.timers.tick(2000);
  page.tap(0);
  page.tap(0);
  assert.equal(page.status(), 'Deal #777 cleared: all 52 cards flushed to disk in 1:07 with 10 page faults.');
  assert.equal(page.toast(), 'Deal #777 cleared!');
  assert.deepEqual(page.shown().disks, [13, 13, 13, 13]);
  assert.equal(page.table.classList.contains('swp-won'), true);
  assert.deepEqual(page.stats(), { played: 4, won: 3, streak: 2, best: 3 });
  assert.deepEqual(page.numbers(), ['10', '1:07', '3/4', '2', '3', '0']);
  const game = page.state().game;
  assert.deepEqual([game.over, game.moves, game.elapsed], ['won', 10, 67000]);
  assert.equal(page.els['swp-undo'].disabled, true);
  assert.equal(page.els['swp-restart'].disabled, true);
  assert.equal(page.els['swp-give-up'].disabled, true);
  assert.equal(page.hidden('swp-share'), false);
  assert.equal(page.hidden('swp-practice'), true);
  // The clock has stopped; nothing moves any more.
  t.mock.timers.tick(5000);
  assert.equal(page.text('swp-time'), '1:07');
  const over = page.status();
  focusElement(page.table);
  for (const act of [() => page.tapDisk(0), () => page.tapEmpty(1), () => pressKey('u'), () => pressKey('f'), () => pressKey('3')]) {
    page.els['swp-status'].textContent = '';
    act();
    assert.equal(page.status(), over);
  }
  assert.deepEqual(page.selected(), [], 'nothing can be picked');
  assert.equal(page.state().game.moves, 10);
  t.mock.timers.tick(2200);
  assert.equal(page.toast(), null);

  const again = reload(t, page);
  assert.equal(again.status(), over);
  assert.equal(again.table.classList.contains('swp-won'), true);
  assert.equal(again.text('swp-time'), '1:07');
  assert.equal(again.hidden('swp-share'), false);
  t.mock.timers.tick(3000);
  assert.equal(again.text('swp-time'), '1:07');
});

test('swap space solitaire: Give Up asks for a second press, then ends the game as a loss', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A()), stats: { played: 3, won: 2, streak: 2, best: 2 } });
  page.click('swp-give-up');
  assert.equal(page.status(), 'Press Give Up again to end Deal #777 as a loss.');
  assert.equal(page.toast(), 'Press Give Up again to end Deal #777 as a loss.');
  assert.equal(page.state().game.over, null);
  // The question lapses after 4 s.
  t.mock.timers.tick(4000);
  assert.equal(page.status(), 'Deal #777: tap a card, then tap where it goes. Flush all 52 cards to /dev/sda-sdd.');
  page.click('swp-give-up');
  page.tap(0);
  page.click('swp-give-up');
  assert.equal(page.state().game.over, null, 'a tap in between asks again');
  page.click('swp-give-up');
  assert.equal(page.status(), 'Deal #777 given up with 0 of 52 cards on disk.');
  assert.equal(page.state().game.over, 'lost');
  assert.deepEqual(page.stats(), { played: 4, won: 2, streak: 0, best: 2 });
  assert.equal(page.els['swp-give-up'].disabled, true);
  assert.equal(page.hidden('swp-share'), false);
  // Given up before any move: counted as played once.
  page.click('swp-new-deal');
  assert.equal(page.stats().played, 4);
});

test('swap space solitaire: New Deal and Play: a deal in play asks for a second press and then counts as a loss', (t) => {
  const random = t.mock.method(Math, 'random', () => 0.25);
  const page = openPage(t, { state: dealSave(BOARD_A()), stats: { played: 5, won: 3, streak: 3, best: 3 } });
  // An untouched deal is replaced at once.
  page.click('swp-new-deal');
  assert.equal(page.text('swp-label'), 'Deal #250000');
  assert.deepEqual(page.shown(), swp.swpStartBoard(250000));
  assert.deepEqual(page.stats(), { played: 5, won: 3, streak: 3, best: 3 });
  // A deal in play: the first press asks.
  page.tap(0);
  page.tap(0);
  assert.equal(page.stats().played, 6);
  page.click('swp-new-deal');
  assert.equal(page.status(), 'Deal #250000 is in progress: press New Deal again to abandon it (it counts as a loss).');
  assert.equal(page.text('swp-label'), 'Deal #250000');
  random.mock.mockImplementation(() => 0.75);
  page.click('swp-new-deal');
  assert.equal(page.text('swp-label'), 'Deal #750000');
  assert.deepEqual(page.stats(), { played: 6, won: 3, streak: 0, best: 3 });

  // Play: a typed number, also with Enter in the field.
  page.els['swp-deal-input'].value = '#12345';
  page.click('swp-play-deal');
  assert.equal(page.text('swp-label'), 'Deal #12345');
  assert.equal(page.els['swp-deal-input'].value, '');
  assert.deepEqual(page.shown(), swp.swpStartBoard(12345));
  for (const bad of ['abc', '0', '1000000', '   ']) {
    page.els['swp-deal-input'].value = bad;
    page.click('swp-play-deal');
    assert.equal(page.status(), 'Deal numbers are whole numbers from 1 to 999999: "' + bad.trim() + '" is not one.');
    assert.equal(page.text('swp-label'), 'Deal #12345');
  }
  page.els['swp-deal-input'].value = '42';
  assert.equal(pressKey('4', { target: page.els['swp-deal-input'] }).defaultPrevented, false);
  assert.equal(pressKey('Enter', { target: page.els['swp-deal-input'], isComposing: true }).defaultPrevented, false);
  assert.equal(page.text('swp-label'), 'Deal #12345');
  assert.equal(pressKey('Enter', { target: page.els['swp-deal-input'] }).defaultPrevented, true);
  assert.equal(page.text('swp-label'), 'Deal #42');
  // Play while a deal is in play keeps the typed number until it starts.
  page.tap(0, 1);
  page.tap(0, 1);
  page.els['swp-deal-input'].value = '43';
  page.click('swp-play-deal');
  assert.equal(page.status(), 'Deal #42 is in progress: press Play again to abandon it (it counts as a loss).');
  assert.equal(page.els['swp-deal-input'].value, '43');
  page.click('swp-play-deal');
  assert.equal(page.text('swp-label'), 'Deal #43');
  // The same number is the same deal after a reload, for everyone.
  const again = reload(t, page);
  assert.deepEqual(again.shown(), swp.swpStartBoard(43));
});

test('swap space solitaire: the clock starts with the first move, pauses while the tab is hidden, stops at the end and never runs twice', (t) => {
  useTime(t);
  const live = trackIntervals(t);
  const page = boot({ state: dealSave(BOARD_A()) });
  assert.equal(live.size, 0, 'no clock before the first move');
  t.mock.timers.tick(10000);
  page.tap(0);
  page.tap(1);
  assert.equal(live.size, 1);
  const setItem = t.mock.method(localStorage, 'setItem');
  t.mock.timers.tick(3000);
  assert.equal(page.text('swp-time'), '0:03');
  assert.equal(setItem.mock.callCount(), 0, 'a tick shows the time and never writes the saves');
  assert.equal(page.state().game.elapsed, 0);
  setVisibility('hidden', t);
  assert.equal(live.size, 0);
  assert.equal(page.state().game.elapsed, 3000, 'hiding the tab saves the time');
  t.mock.timers.tick(60000);
  setVisibility('visible', t);
  assert.equal(live.size, 1);
  t.mock.timers.tick(2500);
  assert.equal(page.text('swp-time'), '0:05');
  fire(window, 'pagehide');
  assert.equal(page.state().game.elapsed, 5500, 'the page going away saves the time to the millisecond');
  // Moves, undo and restart keep one clock.
  page.tap(4);
  page.tapSlot(0);
  page.click('swp-undo');
  page.tap(4);
  page.tapSlot(0);
  page.click('swp-restart');
  page.click('swp-restart');
  assert.deepEqual(page.shown(), swp.swpStartBoard(777));
  assert.equal(live.size, 1);
  // The Daily tab has its own clock; this one pauses meanwhile.
  page.click('swp-tab-daily');
  assert.equal(live.size, 0);
  t.mock.timers.tick(7000);
  page.click('swp-tab-deals');
  assert.equal(live.size, 1);
  assert.equal(page.text('swp-time'), '0:05');
  // A new deal stops the old clock until its own first move.
  page.click('swp-new-deal');
  page.click('swp-new-deal');
  assert.equal(live.size, 0);
  assert.equal(page.text('swp-time'), '0:00');
  t.mock.timers.tick(5000);
  assert.equal(page.text('swp-time'), '0:00');
});

test('swap space solitaire: the Daily tab begins the day\'s attempt at once, the same deal for everyone, and a reload resumes it', (t) => {
  const random = t.mock.method(Math, 'random', () => 0.1);
  const page = openPage(t);
  random.mock.mockImplementation(() => { throw new Error('the daily never uses Math.random'); });
  page.click('swp-tab-daily');
  assert.equal(page.text('swp-label'), 'Daily #5 · 2026-11-05');
  assert.equal(page.status(), 'Daily #5: tap a card, then tap where it goes. Flush all 52 cards to /dev/sda-sdd.');
  assert.deepEqual(page.shown(), swp.swpStartBoard(DAILY_SEED));
  assert.equal(page.hidden('swp-deal-controls'), true);
  assert.equal(page.els['swp-tab-daily'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.els['swp-tab-daily'].classList.contains('swp-tab-active'), true);
  assert.equal(page.els['swp-tab-deals'].classList.contains('swp-tab-active'), false);
  assert.equal(page.state().mode, 'daily');
  assert.deepEqual(page.daily(), {
    v: 1, day: TODAY, number: 5, result: null, score: null,
    game: swp.swpNewGame('daily', 5, DAILY_SEED), streak: 0, best: 0, lastWon: null
  });
  // Pressed again the same day it changes nothing.
  page.click('swp-tab-daily');
  assert.deepEqual(page.daily().game, swp.swpNewGame('daily', 5, DAILY_SEED));
  // A move, a reload: the attempt resumes on the Daily tab.
  page.tap(0);
  page.tapSlot(0);
  t.mock.timers.tick(4000);
  const board = page.shown();
  const again = reload(t, page, { now: NOON + HOUR });
  assert.equal(again.text('swp-label'), 'Daily #5 · 2026-11-05');
  assert.deepEqual(again.shown(), board);
  assert.equal(again.status(), 'Daily #5 in progress: 1 page fault so far.');
  assert.equal(again.text('swp-time'), '0:04');
  assert.equal(again.stats().played, 1);
  // The deals tab still holds its deal.
  again.click('swp-tab-deals');
  assert.equal(again.text('swp-label'), 'Deal #100000');
  assert.equal(again.status(), 'Deal #100000: tap a card, then tap where it goes. Flush all 52 cards to /dev/sda-sdd.');
});

test('swap space solitaire: a won daily is scored once: result, daily streak, Share and an unscored Practice', (t) => {
  const page = openPage(t, {
    state: dealSave(BOARD_A(), {}, 'daily'),
    daily: dailySave(NEAR_WON(), { moves: 30, elapsed: 120000, undos: 1, started: true, counted: true }, { streak: 2, best: 2, lastWon: 4 }),
    stats: { played: 1, won: 0, streak: 0, best: 0 }
  });
  assert.equal(page.text('swp-daily-streak'), '2');
  page.tap(1);
  page.tap(1);
  assert.equal(page.status(), 'Daily #5 cleared: all 52 cards flushed to disk in 2:00 with 31 page faults. Daily #6 opens at midnight: press Daily then to play it. Practice replays this deal unscored.');
  const record = page.daily();
  assert.deepEqual([record.result, record.score, record.streak, record.best, record.lastWon], ['won', { moves: 31, elapsed: 120000, undos: 1, cards: 52 }, 3, 3, 5]);
  assert.deepEqual(page.stats(), { played: 1, won: 1, streak: 1, best: 1 });
  assert.equal(page.text('swp-daily-streak'), '3');
  assert.equal(page.els['swp-daily-streak'].getAttribute('title'), 'Best daily streak: 3');
  assert.equal(page.hidden('swp-share'), false);
  assert.equal(page.hidden('swp-practice'), false);
  // Pressing Daily again the same day keeps the result: no second attempt.
  page.click('swp-tab-daily');
  assert.equal(page.daily().result, 'won');
  assert.equal(page.daily().game.over, 'won');
  // Practice: the same deal, not scored.
  page.click('swp-practice');
  assert.equal(page.text('swp-label'), 'Daily #5 practice · 2026-11-05 (not scored)');
  assert.equal(page.status(), 'Daily #5 practice (not scored): tap a card, then tap where it goes. Flush all 52 cards to /dev/sda-sdd.');
  assert.deepEqual(page.shown(), swp.swpStartBoard(DAILY_SEED));
  page.tap(0);
  page.tapSlot(0);
  page.click('swp-give-up');
  page.click('swp-give-up');
  assert.match(page.status(), /^Daily #5 practice given up with \d+ of 52 cards on disk\. Daily #6 opens at midnight/);
  assert.deepEqual(page.stats(), { played: 1, won: 1, streak: 1, best: 1 }, 'practice is never counted');
  assert.deepEqual([page.daily().result, page.daily().streak], ['won', 3]);
  page.click('swp-practice');
  assert.equal(page.daily().game.over, null, 'a fresh practice');
  // The Practice button does nothing on the Deals tab.
  page.click('swp-tab-deals');
  page.click('swp-practice');
  assert.equal(page.state().mode, 'deal');
  // A reload shows the day's result and practice again.
  const again = reload(t, page);
  again.click('swp-tab-daily');
  assert.equal(again.daily().result, 'won');
  assert.equal(again.daily().game.kind, 'practice');
  assert.equal(again.hidden('swp-share'), false);
});

test('swap space solitaire: the daily streak counts consecutive daily numbers won; a missed or lost day puts it at 0', (t) => {
  // #3 was the last win: #4 was missed, so today starts from 0 and a win makes 1.
  let page = openPage(t, { state: dealSave(BOARD_A(), {}, 'daily'), daily: dailySave(NEAR_WON(), {}, { streak: 6, best: 6, lastWon: 3 }) });
  assert.equal(page.text('swp-daily-streak'), '0');
  page.tap(0);
  page.tap(0);
  assert.deepEqual([page.daily().streak, page.daily().best, page.daily().lastWon], [1, 6, 5]);
  assert.equal(page.text('swp-daily-streak'), '1');
  // The next day the streak still shows on the Deals tab, the day after it is gone.
  page = reload(t, page, { now: NOON + 24 * HOUR });
  page.click('swp-tab-deals');
  assert.equal(page.text('swp-daily-streak'), '1');
  page = reload(t, page, { now: NOON + 48 * HOUR });
  assert.equal(page.text('swp-daily-streak'), '0');
  // A day given up: streak 0, best kept, the share line says so.
  resetStubs();
  page = openPage(t, { state: dealSave(BOARD_A(), {}, 'daily'), daily: dailySave(BOARD_A(), {}, { streak: 4, best: 4, lastWon: 4 }) }, { now: NOON });
  page.click('swp-give-up');
  page.click('swp-give-up');
  assert.deepEqual([page.daily().result, page.daily().streak, page.daily().best, page.daily().lastWon], ['lost', 0, 4, 4]);
  assert.equal(page.text('swp-daily-streak'), '0');
  assert.deepEqual(page.daily().score, { moves: 0, elapsed: 0, undos: 0, cards: 0 });
  assert.equal(page.status(), 'Daily #5 given up with 0 of 52 cards on disk. Daily #6 opens at midnight: press Daily then to play it. Practice replays this deal unscored.');
});

test('swap space solitaire: a daily left open across midnight finishes as the day it started; the next one begins on Daily or a reload', (t) => {
  const late = new Date(2026, 10, 5, 23, 59, 0).getTime();
  const page = openPage(t, {
    state: dealSave(BOARD_A(), {}, 'daily'),
    daily: dailySave(NEAR_WON(), { moves: 4, started: true, counted: true }, { streak: 1, best: 1, lastWon: 4 })
  }, { now: late });
  assert.equal(page.text('swp-label'), 'Daily #5 · 2026-11-05');
  t.mock.timers.tick(2 * 60000);
  assert.equal(page.text('swp-label'), 'Daily #5 · 2026-11-05', 'still #5 after midnight');
  assert.equal(page.text('swp-time'), '2:00');
  page.tap(0);
  page.tap(0);
  assert.deepEqual([page.daily().day, page.daily().result, page.daily().lastWon, page.daily().streak], [TODAY, 'won', 5, 2]);
  assert.equal(page.text('swp-daily-streak'), '2', 'won yesterday: the streak stands today');
  // The next daily is open already, and the status says how to start it.
  assert.equal(page.status(), 'Daily #5 cleared: all 52 cards flushed to disk in 2:00 with 5 page faults. Daily #6 is open now: press Daily to play it. Practice replays this deal unscored.');
  assert.equal(page.text('swp-label'), 'Daily #5 · 2026-11-05');
  // Daily (New Daily) now opens #6.
  page.click('swp-tab-daily');
  assert.equal(page.text('swp-label'), 'Daily #6 · 2026-11-06');
  assert.deepEqual(page.shown(), swp.swpStartBoard(fnv1a('swp:2026-11-06')));
  assert.deepEqual([page.daily().day, page.daily().number, page.daily().result, page.daily().streak, page.daily().lastWon], ['2026-11-06', 6, null, 2, 5]);

  // An attempt left unfinished: the reload after midnight begins the new day,
  // and the abandoned attempt breaks the win streak.
  resetStubs();
  const open = openPage(t, {
    state: dealSave(BOARD_A(), {}, 'daily'),
    daily: dailySave(BOARD_A(), { moves: 2, started: true, counted: true }, { streak: 1, best: 1, lastWon: 4 }),
    stats: { played: 3, won: 3, streak: 3, best: 3 }
  }, { now: late + 5 * 60000 });
  assert.equal(open.text('swp-label'), 'Daily #6 · 2026-11-06');
  assert.deepEqual(open.stats(), { played: 3, won: 3, streak: 0, best: 3 });
  assert.equal(open.text('swp-daily-streak'), '0');
});

test('swap space solitaire: Share copies one plain line, and shows it in a field to copy when the clipboard is missing or refuses', async (t) => {
  const writes = [];
  t.mock.method(navigator.clipboard, 'writeText', (text) => {
    writes.push(text);
    return Promise.resolve();
  });
  const page = openPage(t, { state: dealSave(NEAR_WON(), { moves: 9, elapsed: 65000, undos: 2, started: true, counted: true }) });
  page.click('swp-share');
  assert.equal(page.status(), 'Nothing to share yet: finish Deal #777 first.');
  page.tap(0);
  page.tap(0);
  page.click('swp-share');
  await flush();
  assert.deepEqual(writes, ['Swap Space Solitaire deal 777 1:05 10 page faults 2 undos']);
  assert.equal(page.toast(), 'Result copied');
  assert.equal(page.status(), 'Copied to the clipboard: Swap Space Solitaire deal 777 1:05 10 page faults 2 undos');
  assert.equal(page.hidden('swp-share-field'), true);

  // Refused: the line shows selected in a read-only field.
  navigator.clipboard.writeText.mock.mockImplementation(() => Promise.reject(new Error('denied')));
  page.click('swp-share');
  await flush();
  const field = page.els['swp-share-field'];
  assert.equal(page.hidden('swp-share-field'), false);
  assert.equal(field.value, 'Swap Space Solitaire deal 777 1:05 10 page faults 2 undos');
  assert.equal(field.readOnly, true);
  same(document.activeElement, field);
  assert.equal(page.status(), 'Copy the result yourself (the clipboard refused it): Swap Space Solitaire deal 777 1:05 10 page faults 2 undos');
  // Keys typed in the field are not the game's.
  assert.equal(pressKey('u', { target: field }).defaultPrevented, false);
  // Throwing at once, or no clipboard at all.
  navigator.clipboard.writeText.mock.mockImplementation(() => { throw new Error('not allowed'); });
  page.click('swp-tab-deals');
  assert.equal(page.hidden('swp-share-field'), true, 'any other control hides the field');
  page.click('swp-share');
  assert.equal(page.hidden('swp-share-field'), false);
  const saved = navigator.clipboard;
  t.after(() => { navigator.clipboard = saved; });
  for (const missing of [undefined, {}]) {
    navigator.clipboard = missing;
    page.els['swp-status'].textContent = '';
    page.click('swp-share');
    assert.equal(page.status(), 'Copy the result yourself (the clipboard is not available here): Swap Space Solitaire deal 777 1:05 10 page faults 2 undos');
  }
  navigator.clipboard = saved;

  // On the Daily tab Share copies the day's scored line, also after practice.
  resetStubs();
  navigator.clipboard.writeText.mock.mockImplementation((text) => {
    writes.push(text);
    return Promise.resolve();
  });
  const daily = openPage(t, {
    state: dealSave(BOARD_A(), {}, 'daily'),
    daily: dailySave(NEAR_WON(), { moves: 30, elapsed: 61000, started: true, counted: true })
  });
  daily.click('swp-share');
  assert.equal(daily.status(), 'Nothing to share yet: finish Daily #5 first.');
  daily.tap(1);
  daily.tap(1);
  daily.click('swp-practice');
  daily.click('swp-share');
  await flush();
  assert.equal(writes.at(-1), 'Swap Space Solitaire #5 1:01 31 page faults');
});

test('swap space solitaire: a deadlock is reported when no card can move', (t) => {
  const page = openPage(t, { state: dealSave(PRE_DEADLOCK()) });
  page.tap(7);
  page.tap(7);
  assert.equal(page.status(), 'Moved K♣︎ to swap3. Deadlock: no card can move. Undo (U) or Give Up.');
  const again = reload(t, page);
  assert.equal(again.status(), 'Deadlock: no card can move in Deal #777. Undo (U) or Give Up.');
  again.click('swp-undo');
  assert.equal(again.shown().slots[3], null);
});

test('swap space solitaire: a game survives a reload: board, undo history, counts, clock, tab and stats', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A()), stats: { played: 7, won: 5, streak: 1, best: 4 } });
  page.tap(0);
  page.tap(1);
  page.tap(4);
  page.tapSlot(2);
  t.mock.timers.tick(12500);
  const board = page.shown();
  const saved = page.state();
  assert.equal(saved.game.elapsed, 0, 'the clock is saved with moves, not on its ticks');
  const again = reload(t, page);
  assert.deepEqual(again.shown(), board);
  assert.deepEqual(again.state(), { ...saved, game: { ...saved.game, elapsed: 12500 } }, 'the time came with the pagehide save');
  assert.deepEqual(again.numbers(), ['2', '0:12', '5/8', '1', '4', '0']);
  t.mock.timers.tick(1000);
  assert.equal(again.text('swp-time'), '0:13', 'the clock resumes');
  again.click('swp-undo');
  again.click('swp-undo');
  assert.deepEqual(again.shown(), BOARD_A());
  assert.equal(again.state().game.undos, 2);
});

test('swap space solitaire: a save in the current format loads and is written back byte for byte', (t) => {
  // Captured from the first version: Deal #48213 after 9♣... one move to swap0.
  const game = swp.swpNewGame('deal', 48213, 48213);
  const top = game.board.cascades[0].slice(-1)[0];
  game.board = swp.swpApplyMove(game.board, [0, 8, 1]);
  Object.assign(game, { history: [[[0, 8, 1]]], moves: 1, undos: 0, elapsed: 4200, started: true, counted: true });
  const text = '{"v":1,"mode":"deal","game":' + JSON.stringify(game) + '}';
  assert.match(text, /^\{"v":1,"mode":"deal","game":\{"kind":"deal","deal":48213,"seed":48213,"board":\{"cascades":\[\[\d/);
  assert.match(text, /"slots":\[\d+,null,null,null\],"disks":\[\d+,\d+,\d+,\d+\]\},"history":\[\[\[0,8,1\]\]\],"moves":1,"undos":0,"elapsed":4200,"started":true,"counted":true,"over":null\}\}$/);
  const stats = '{"played":1,"won":0,"streak":0,"best":0}';
  const page = openPage(t, { state: text, stats });
  assert.equal(localStorage.getItem(STATE_KEY), text);
  assert.equal(localStorage.getItem(STATS_KEY), stats);
  assert.equal(page.shown().slots[0], top);
  assert.equal(page.text('swp-time'), '0:04');
  page.click('swp-undo');
  assert.deepEqual(page.shown(), swp.swpStartBoard(48213));
});

test('swap space solitaire: corrupt or partial saves never break the page', (t) => {
  const states = ['', '{', 'null', '[]', '42', '"x"', '{}', '{"mode":"daily"}', '{"game":{"kind":"deal","deal":0}}',
    '{"game":{"kind":"deal","deal":12,"board":{"cascades":[]}}}', '{"game":{"kind":"deal","deal":12,"board":7,"history":[[[99]]]}}'];
  for (const state of states) {
    resetStubs();
    t.mock.method(Math, 'random', () => 0.5);
    const page = openPage(t, { state, stats: '{"played":"x"}', daily: '{"day":5}' });
    assert.equal(page.table.children.length, 2, state);
    const label = page.text('swp-label');
    assert.match(label, /^(Deal #500000|Deal #12|Daily #5 · 2026-11-05)$/, state);
    page.tap(0);
    page.tapSlot(0);
    assert.equal(page.game().moves, 1, state);
    assert.deepEqual(page.stats(), { played: 1, won: 0, streak: 0, best: 0 }, state);
    t.mock.restoreAll();
  }
  // A broken daily day with streak fields: the streak survives, the day starts fresh.
  resetStubs();
  const page = openPage(t, { state: '{"mode":"daily"}', daily: '{"day":"x","streak":2,"best":5,"lastWon":4}' });
  assert.equal(page.text('swp-label'), 'Daily #5 · 2026-11-05');
  assert.deepEqual([page.daily().streak, page.daily().best, page.daily().lastWon], [2, 5, 4]);
  assert.equal(page.text('swp-daily-streak'), '2');
});

test('swap space solitaire: blocked or full storage never stops the game, and a warning names what is not saved', (t) => {
  blockStorage('access', t);
  t.mock.method(Math, 'random', () => 0.5);
  const page = openPage(t);
  assert.equal(page.hidden('swp-warning'), false);
  assert.equal(page.text('swp-warning'), 'Browser storage is blocked: progress, stats and the daily attempt will not be saved (swp-state, swp-stats, swp-daily).');
  page.tap(0);
  page.tapSlot(0);
  assert.equal(page.text('swp-faults'), '1');
  page.click('swp-tab-daily');
  assert.equal(page.text('swp-label'), 'Daily #5 · 2026-11-05');
  t.mock.timers.tick(3000);

  // Full: the save is read, nothing new is written, the warning says full.
  resetStubs();
  writeStorage({ state: dealSave(BOARD_A()) });
  blockStorage('full', t);
  const full = openPage(t);
  assert.deepEqual(full.shown(), BOARD_A());
  assert.equal(full.text('swp-warning'), 'Browser storage is full: progress, stats and the daily attempt are not being saved (swp-state, swp-stats, swp-daily).');
  full.tap(0);
  full.tap(1);
  assert.equal(full.state().game.moves, 0, 'the old save stays');
  assert.equal(full.text('swp-faults'), '1');

  // Reading fails but writing works: blocked, said once.
  resetStubs();
  blockStorage('getItem', t);
  const reads = openPage(t);
  assert.match(reads.text('swp-warning'), /^Browser storage is blocked/);
  reads.click('swp-new-deal');
  assert.match(reads.text('swp-warning'), /^Browser storage is blocked/);
});

// ── Other tabs ──────────────────────────────────────────────────────────────
//
// Another open tab of the game writes straight into the storage, with no
// event (a hidden or throttled tab may get none); storageEvent(key) is the
// event browsers send the other tabs after a write.

const storageEvent = (key) => fire(window, 'storage', { key, storageArea: localStorage });
const OTHER = 'Progress saved in another tab of the game is shown here now. ';
const WON_BOARD = () => makeBoard({ disks: [13, 13, 13, 13] });

test('swap space solitaire: two tabs\' stats merge count by count, and a daily record is behind when it is of an earlier daily or lacks the result of the same one', () => {
  const s = (played, won, streak, best) => ({ played, won, streak, best });
  // Played, won and best only grow, so the larger wins; the streak is the
  // copy's with more games, the other tab's on a tie.
  assert.deepEqual(swp.swpMergeStats(s(6, 5, 3, 3), s(5, 4, 1, 4)), s(6, 5, 3, 4));
  assert.deepEqual(swp.swpMergeStats(s(5, 4, 1, 4), s(6, 5, 0, 4)), s(6, 5, 0, 4));
  assert.deepEqual(swp.swpMergeStats(s(6, 5, 3, 3), s(6, 5, 0, 3)), s(6, 5, 0, 3), 'a loss in the other tab');
  assert.deepEqual(swp.swpMergeStats(s(2, 1, 1, 1), s(2, 2, 2, 2)), s(2, 2, 2, 2), 'a win in the other tab');
  const rec = (number, result) => ({ number, result });
  for (const [mine, theirs, behind, why] of [
    [null, null, false, 'no record on either side'],
    [null, rec(5, null), false, 'this tab never opened a daily'],
    [rec(5, null), null, true, 'the other save is gone or unreadable'],
    [rec(5, 'won'), rec(4, 'won'), true, 'an earlier daily'],
    [rec(5, null), rec(0, null), true, 'a broken day is number 0'],
    [rec(5, null), rec(6, null), false, 'a later daily'],
    [rec(5, 'won'), rec(5, null), true, 'the same daily without the win'],
    [rec(5, 'lost'), rec(5, null), true, 'the same daily without the loss'],
    [rec(5, null), rec(5, null), false, 'the same daily, in play on both sides'],
    [rec(5, null), rec(5, 'won'), false, 'the other tab finished it'],
    [rec(5, 'won'), rec(5, 'won'), false, 'finished on both sides']
  ]) {
    assert.equal(swp.swpDailyBehind(mine, theirs), behind, why);
  }
  assert.equal(swp.swpParseDaily('{"day":"x","streak":2}').number, 0);
});

test('swap space solitaire: a daily another tab won while this one was hidden is taken over when it is shown again, and is never scored twice', (t) => {
  const page = openPage(t, {
    state: dealSave(BOARD_A(), {}, 'daily'),
    daily: dailySave(NEAR_WON(), { moves: 9, elapsed: 60000, started: true, counted: true }),
    stats: { played: 1, won: 0, streak: 0, best: 0 }
  });
  assert.equal(page.status(), 'Daily #5 in progress: 9 page faults so far.');
  setVisibility('hidden', t);
  // Meanwhile the other tab resumes Daily #5 from the save and wins it.
  const record = page.daily();
  const won = {
    ...record, result: 'won', score: { moves: 10, elapsed: 61000, undos: 0, cards: 52 }, streak: 1, best: 1, lastWon: 5,
    game: { ...record.game, board: WON_BOARD(), moves: 10, elapsed: 61000, over: 'won' }
  };
  const theirs = { daily: JSON.stringify(won), stats: JSON.stringify({ played: 1, won: 1, streak: 1, best: 1 }) };
  writeStorage(theirs);
  t.mock.timers.tick(30000);
  const setItem = t.mock.method(localStorage, 'setItem');
  setVisibility('visible', t);
  assert.equal(setItem.mock.callCount(), 0, 'this tab writes nothing of its older copy');
  assert.equal(localStorage.getItem(DAILY_KEY), theirs.daily);
  assert.equal(localStorage.getItem(STATS_KEY), theirs.stats);
  const cleared = 'Daily #5 cleared: all 52 cards flushed to disk in 1:01 with 10 page faults. Daily #6 opens at midnight: press Daily then to play it. Practice replays this deal unscored.';
  assert.equal(page.status(), OTHER + cleared);
  assert.equal(page.toast(), 'Synced with another tab');
  assert.deepEqual(page.shown().disks, [13, 13, 13, 13]);
  assert.deepEqual(page.numbers(), ['10', '1:01', '1/1', '1', '1', '1']);
  assert.equal(page.els['swp-give-up'].disabled, true);
  assert.equal(page.hidden('swp-share'), false);
  assert.equal(page.hidden('swp-practice'), false);
  // The day stays finished: a tap only shows the result, Daily keeps it,
  // and the page going away writes it as it is.
  page.tapDisk(0);
  assert.equal(page.status(), cleared);
  page.click('swp-tab-daily');
  fire(window, 'pagehide');
  assert.deepEqual([page.daily().result, page.daily().score, page.daily().streak, page.daily().lastWon], ['won', won.score, 1, 5]);
  assert.deepEqual(page.stats(), { played: 1, won: 1, streak: 1, best: 1 });
  const again = reload(t, page);
  assert.equal(again.status(), cleared);
  assert.equal(again.text('swp-daily-streak'), '1');
});

test('swap space solitaire: a tab hidden or closed after another tab saved takes that save over instead of writing its own over it', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A(), { moves: 3, started: true, counted: true }), stats: { played: 2, won: 1, streak: 1, best: 1 } });
  t.mock.timers.tick(5000);
  // The other tab plays 7♣ to swap0 in the same deal; this tab gets no
  // event and is hidden next.
  const moved = swp.swpApplyMove(BOARD_A(), [4, 8, 1]);
  const theirs = { moves: 4, elapsed: 9000, started: true, counted: true, history: [[[4, 8, 1]]] };
  writeStorage({ state: dealSave(moved, theirs) });
  setVisibility('hidden', t);
  assert.deepEqual(page.state().game, gameOf(moved, theirs), 'its move and its clock, not this tab\'s 5 s');
  assert.equal(page.shown().slots[0], C('7C'));
  assert.equal(page.status(), OTHER + 'Deal #777 in progress: 4 page faults so far.');
  // Still hidden: the other tab wins the deal, then this tab is closed.
  const done = { moves: 60, elapsed: 120000, started: true, counted: true, over: 'won' };
  writeStorage({ state: dealSave(WON_BOARD(), done), stats: { played: 2, won: 2, streak: 2, best: 2 } });
  fire(window, 'pagehide');
  assert.deepEqual(page.state(), { v: 1, mode: 'deal', game: gameOf(WON_BOARD(), done) });
  assert.deepEqual(page.stats(), { played: 2, won: 2, streak: 2, best: 2 });
  const again = reload(t, page);
  assert.equal(again.status(), 'Deal #777 cleared: all 52 cards flushed to disk in 2:00 with 60 page faults.');
  assert.equal(again.text('swp-won'), '2/2');
});

test('swap space solitaire: a storage event shows the other tab\'s newer game at once, keeps this tab\'s view and one clock, and writes nothing back', (t) => {
  useTime(t);
  const live = trackIntervals(t);
  const page = boot({ state: dealSave(BOARD_A(), { moves: 1, started: true, counted: true }), stats: { played: 3, won: 1, streak: 1, best: 1 } });
  assert.equal(live.size, 1);
  t.mock.timers.tick(4000);
  page.tap(0);
  page.click('swp-give-up');
  const ask = 'Press Give Up again to end Deal #777 as a loss.';
  assert.equal(page.status(), ask);
  // The other tab plays 7♣ to swap0 there and shows its Daily tab.
  const moved = swp.swpApplyMove(BOARD_A(), [4, 8, 1]);
  const theirs = JSON.stringify(dealSave(moved, { moves: 2, elapsed: 9000, started: true, counted: true, history: [[[4, 8, 1]]] }, 'daily'));
  localStorage.setItem(STATE_KEY, theirs);
  const setItem = t.mock.method(localStorage, 'setItem');
  storageEvent(STATE_KEY);
  assert.equal(setItem.mock.callCount(), 0, 'taking a newer save over writes nothing');
  assert.equal(localStorage.getItem(STATE_KEY), theirs);
  assert.equal(page.shown().slots[0], C('7C'));
  assert.deepEqual(page.selected(), [], 'the pick was on the old board');
  assert.equal(page.status(), OTHER + 'Deal #777 in progress: 2 page faults so far.');
  assert.equal(page.toast(), 'Synced with another tab');
  assert.equal(page.text('swp-label'), 'Deal #777', 'this tab stays on Deals');
  assert.equal(page.els['swp-tab-deals'].getAttribute('aria-pressed'), 'true');
  assert.equal(page.text('swp-time'), '0:09');
  assert.equal(live.size, 1, 'one clock, now for the game taken over');
  t.mock.timers.tick(1000);
  assert.equal(page.text('swp-time'), '0:10');
  // The question was asked on the old board: Give Up asks again.
  page.click('swp-give-up');
  assert.equal(page.status(), ask);
  assert.equal(page.state().game.over, null);
  // Another key of the site, or an event with nothing new, changes nothing.
  localStorage.setItem('wrd-state', '{}');
  storageEvent('wrd-state');
  storageEvent(STATE_KEY);
  assert.equal(page.status(), ask);
  // The site data is cleared: this tab writes its game and stats back, on
  // the tab it shows; no daily was ever opened here.
  localStorage.clear();
  storageEvent(null);
  assert.deepEqual(page.state(), { v: 1, mode: 'deal', game: gameOf(moved, { moves: 2, elapsed: 10000, started: true, counted: true, history: [[[4, 8, 1]]] }) });
  assert.deepEqual(page.stats(), { played: 3, won: 1, streak: 1, best: 1 });
  assert.equal(localStorage.getItem(DAILY_KEY), null);
  assert.equal(page.status(), ask, 'nothing changed on the table');
  assert.equal(live.size, 1);
});

test('swap space solitaire: a tap, key or button that finds a newer save of another tab only takes it over, and the next one plays', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A()) });
  const step1 = swp.swpApplyMove(BOARD_A(), [4, 8, 1]);
  const step2 = swp.swpApplyMove(step1, [3, 9, 1]);
  const other = (board, history) => dealSave(board, { moves: history.length, started: true, counted: true, history });
  // A tap.
  writeStorage({ state: other(step1, [[[4, 8, 1]]]) });
  page.tap(0);
  assert.deepEqual(page.selected(), []);
  assert.equal(page.status(), OTHER + 'Deal #777 in progress: 1 page fault so far.');
  assert.deepEqual(page.shown(), step1);
  page.tap(0);
  assert.equal(page.status(), 'Selected 9♠︎ in cascade 1: tap where it goes.');
  // A key: 2 would drop 9♠ on 10♥.
  writeStorage({ stats: { played: 9, won: 4, streak: 0, best: 3 } });
  focusElement(page.table, { keyboard: true });
  assert.equal(pressKey('2').defaultPrevented, true);
  assert.deepEqual(page.shown(), step1);
  assert.deepEqual(page.selected(), []);
  assert.equal(page.text('swp-won'), '4/9');
  // A button.
  writeStorage({ state: other(step2, [[[4, 8, 1]], [[3, 9, 1]]]) });
  page.click('swp-undo');
  assert.deepEqual(page.shown(), step2, 'Undo was meant for the board before');
  page.click('swp-undo');
  assert.deepEqual(page.shown(), step1);
  assert.equal(page.state().game.moves, 1);
  // Enter in the deal number field.
  writeStorage({ stats: { played: 10, won: 4, streak: 0, best: 3 } });
  const input = page.els['swp-deal-input'];
  input.value = '42';
  assert.equal(pressKey('Enter', { target: input }).defaultPrevented, true);
  assert.equal(page.text('swp-label'), 'Deal #777');
  assert.equal(page.text('swp-won'), '4/10');
  pressKey('Enter', { target: input });
  assert.equal(page.status(), 'Deal #777 is in progress: press Play again to abandon it (it counts as a loss).');
});

test('swap space solitaire: another tab\'s save that is behind this one never wins: this tab\'s copy stays and is written back', (t) => {
  const page = openPage(t, {
    state: dealSave(BOARD_A(), {}, 'daily'),
    daily: dailySave(NEAR_WON(), { moves: 30, started: true, counted: true }, { streak: 2, best: 2, lastWon: 4 }),
    stats: { played: 6, won: 4, streak: 2, best: 3 }
  });
  page.tap(1);
  page.tap(1);
  const over = page.status();
  assert.match(over, /^Daily #5 cleared/);
  assert.deepEqual(page.stats(), { played: 6, won: 5, streak: 3, best: 3 });
  const mine = { state: localStorage.getItem(STATE_KEY), daily: localStorage.getItem(DAILY_KEY) };
  // A tab left open since before the win writes its copy of the day (no
  // result), an older day, a broken day, an unreadable record.
  const stale = dailySave(NEAR_WON(), { moves: 30, started: true, counted: true }, { streak: 2, best: 2, lastWon: 4 });
  for (const record of [stale, { ...dailySave(BOARD_A()), day: '2026-11-04', number: 4 }, '{"day":"x"}', '{']) {
    writeStorage({ daily: record });
    storageEvent(DAILY_KEY);
    assert.equal(localStorage.getItem(DAILY_KEY), mine.daily, JSON.stringify(record));
    assert.equal(page.status(), over, 'nothing changed here');
  }
  // Its stats, with fewer games: merged count by count and written back.
  writeStorage({ stats: { played: 5, won: 4, streak: 1, best: 4 } });
  storageEvent(STATS_KEY);
  assert.deepEqual(page.stats(), { played: 6, won: 5, streak: 3, best: 4 });
  assert.equal(page.text('swp-best'), '4');
  assert.equal(page.status(), OTHER + over);
  // A swp-state without a playable deal, an unreadable one, none at all.
  for (const text of ['{"v":1,"mode":"deal","game":null}', '{', null]) {
    if (text === null) localStorage.removeItem(STATE_KEY);
    else localStorage.setItem(STATE_KEY, text);
    storageEvent(STATE_KEY);
    assert.equal(localStorage.getItem(STATE_KEY), mine.state, String(text));
  }
  // A later day does win: past midnight a tab opened today begins Daily #6,
  // and this one, still on #5, shows it.
  t.mock.timers.tick(13 * HOUR);
  const seed6 = fnv1a('swp:2026-11-06');
  writeStorage({ daily: { v: 1, day: '2026-11-06', number: 6, result: null, score: null, game: swp.swpNewGame('daily', 6, seed6), streak: 3, best: 3, lastWon: 5 } });
  storageEvent(DAILY_KEY);
  assert.equal(page.text('swp-label'), 'Daily #6 · 2026-11-06');
  assert.deepEqual(page.shown(), swp.swpStartBoard(seed6));
  assert.equal(page.status(), OTHER + 'Daily #6: tap a card, then tap where it goes. Flush all 52 cards to /dev/sda-sdd.');
  assert.equal(page.text('swp-daily-streak'), '3');
});

test('swap space solitaire: a toast shown within the time of another stays its full 2.2 s, and listeners never stack up', (t) => {
  const page = openPage(t, { state: dealSave(BOARD_A()) });
  page.click('swp-give-up');
  t.mock.timers.tick(1000);
  page.click('swp-new-deal');
  page.tap(0);
  page.tap(0);
  page.click('swp-new-deal');
  assert.match(page.toast(), /is in progress: press New Deal again/);
  t.mock.timers.tick(1200);
  assert.notEqual(page.toast(), null, 'the first toast\'s time is up, not the second\'s');
  t.mock.timers.tick(999);
  assert.notEqual(page.toast(), null);
  t.mock.timers.tick(1);
  assert.equal(page.toast(), null);
  for (let i = 0; i < 3; i++) {
    page.click('swp-tab-daily');
    page.click('swp-tab-deals');
    page.click('swp-new-deal');
    page.click('swp-new-deal');
    page.click('swp-restart');
    page.click('swp-undo');
  }
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(window, 'pagehide'), 1);
  assert.equal(listenerCount(page.table, 'click'), 1);
  const again = reload(t, page);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(again.table, 'click'), 1);
});

test('swap space solitaire: every class the page draws has a rule in style.css, red suits and long cascades included', (t) => {
  const selectors = new Set(cssRules(CSS).flatMap((rule) => rule.selectors));
  const covered = (name) => [...selectors].some((selector) => new RegExp('\\.' + name + '(?![\\w-])').test(selector));
  const seen = new Set();
  const collect = (page) => {
    for (const el of [page.table, ...page.table.querySelectorAll('*'), ...Object.values(page.els)]) {
      for (const name of String(el.className).split(/\s+/).filter(Boolean)) seen.add(name);
    }
  };
  const page = openPage(t, { state: dealSave(BOARD_A()) });
  page.tap(4, 2);
  collect(page);
  page.tap(0);
  page.tapSlot(0);
  collect(page);
  assert.ok(page.column(7).classList.contains('swp-long'), 'a cascade of more than 12 cards packs tighter');
  page.click('swp-tab-daily');
  collect(page);
  resetStubs();
  const won = openPage(t, { state: dealSave(NEAR_WON()) });
  won.tap(0);
  won.tap(0);
  collect(won);
  for (const name of ['swp-red', 'swp-black', 'swp-selected', 'swp-target', 'swp-empty', 'swp-long', 'swp-won', 'swp-disk', 'swp-swap', 'swp-card', 'swp-slot', 'swp-tab-active', 'swp-hidden']) {
    assert.ok(seen.has(name), name + ' drawn');
  }
  for (const name of seen) assert.ok(covered(name), name);
});
