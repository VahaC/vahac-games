// tests/hub.test.js
// The local index page (index.html at the repository root).  Its inline script
// runs in the stub DOM of tests/_setup.js through bootLikeBrowser, the way the
// browser runs it, and the tests drive it through the listeners it registers:
// typing in the search box, Escape, the '/' shortcut and the genre chips.  The
// page's GAMES and GROUPS are also checked against the game folders on disk,
// README.md and the prefix registry in css-template.md, and the inline <style>
// against the hub- prefix and the phone layout.
//
// Coverage: `npm run coverage` only takes */script.js, so measure the inline
// script with
//   node --test --experimental-test-coverage --test-coverage-include=index.html tests/hub.test.js
// (Node 22+; on Node 20 leave out --test-coverage-include, which it lacks).
// The tests should keep it at 100 % lines, branches and functions.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  REPO_ROOT, bootLikeBrowser, htmlPageSpec, idsInHtml, readRepoFile, resetStubs,
  fire, pressKey, listenerCount, cssRules, declsAt, embedSafety
} = require('./_setup');

const HTML = readRepoFile('index.html');
const STYLE = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1];
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(HTML)[1];
const MARKUP = HTML.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '');
const RULES = cssRules(STYLE);
const SPEC = htmlPageSpec(HTML);

// GAMES and GROUPS as the inline script declares them (README Notes tells
// contributors to edit these literals), as plain objects of this context.
function literal(name) {
  const m = new RegExp('var ' + name + ' = (\\[[\\s\\S]*?\\]);').exec(SCRIPT);
  assert.ok(m, 'the inline script declares var ' + name);
  return JSON.parse(JSON.stringify(vm.runInNewContext(m[1])));
}
const GAMES = literal('GAMES');
const GROUPS = literal('GROUPS');
const LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g.label]));

// ── helpers ──────────────────────────────────────────────────────────────────

// Boots index.html like a browser page.  options.source runs a variant of the
// page (see variant()), options.spec another page spec, options.readyState
// 'loading' waits for b.ready().  A variant of another length runs under a
// file name of its own (no such file exists): its code sits at other offsets
// than the real page's, and under the index.html name V8 would report its
// never-run functions as uncovered lines of index.html.  An equal-length edit
// inside a string keeps every offset, so it still counts for index.html.
const VARIANT_FILE = 'tests/hub-variant.html';

function boot(options = {}) {
  const sameOffsets = !options.source || options.source.length === HTML.length;
  return bootLikeBrowser(sameOffsets ? 'index.html' : VARIANT_FILE, options.spec || SPEC, {
    source: options.source || HTML,
    readyState: options.readyState,
    createMissing: options.createMissing
  });
}

// index.html with one edit; fails when the edit did not apply.
function variant(edit) {
  const out = edit(HTML);
  assert.notEqual(out, HTML, 'the variant edit applied to index.html');
  return out;
}

function withoutGame(folder) {
  return (html) => html.replace(new RegExp("\\n\\s*\\{\\s*name: '[^']*',\\s*folder: '" + folder + "',[\\s\\S]*?\\},"), '');
}

function withGroupOf(folder, key) {
  return (html) => html.replace(new RegExp("(folder: '" + folder + "',\\s*group: )'[^']*'"), "$1'" + key + "'");
}

function withExtraGroup(html) {
  return html.replace(/(\{ key: 'reflex', label: 'Reflex and Typing', color: '#22d3ee' \})/,
    (all) => all + ",\n      { key: 'extra', label: 'Extra', color: '#ffffff' }");
}

// location.protocol for the links; the harness location has none.
function setProtocol(protocol) {
  globalThis.location.protocol = protocol;
}

const $$ = (selector) => document.querySelectorAll(selector);
const ownText = (node) => node.childNodes.filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');

// The chips as 'Label count', with '*' on the pressed one.
function chips() {
  return $$('.hub-chip').map((button) => {
    const count = button.children.find((c) => c.className === 'hub-chip-n');
    return ownText(button) + ' ' + count.textContent + (button.getAttribute('aria-pressed') === 'true' ? '*' : '');
  });
}

// The listed games as 'genre: name, name' per section, in page order.
function listing() {
  return $$('.hub-section').map((section) => {
    const heading = section.children[0];
    const names = section.children[1].children.map((card) => card.children[0].children[0].textContent);
    return heading.id.replace(/^hub-group-/, '') + ': ' + names.join(', ');
  });
}

function shownNames() {
  return $$('.hub-card-link').map((a) => a.textContent);
}

function status(els) {
  return { count: els['hub-count'].textContent, empty: els['hub-empty'].hidden ? null : els['hub-empty'].textContent };
}

function search(els, text) {
  els['hub-search'].value = text;
  fire(els['hub-search'], 'input');
}

// True when two node lists hold the same node objects in the same order.
function sameNodes(a, b) {
  return a.length === b.length && a.every((node, i) => node === b[i]);
}

function chipButton(label) {
  const button = $$('.hub-chip').find((b) => ownText(b) === label);
  assert.ok(button, 'a chip labelled ' + label);
  return button;
}

// Node identity.  assert.equal would describe a failing stub node down to
// depth 1000 (its whole page through parentNode), which takes minutes.
function assertSame(actual, expected, message) {
  assert.ok(actual === expected, message || 'expected the same node');
}

// Records every change to the children of parent from now on, as a list of
// what happened.  Inserts and removals go through its methods (the stub's
// appendChild and insertBefore detach a node through the old parent's
// removeChild, so a move shows too), and every write to a current child's
// parentNode is logged as well, which catches clearing the parent through
// textContent or innerHTML, where no method is called.
function watchChildren(parent) {
  const log = [];
  for (const method of ['appendChild', 'insertBefore', 'removeChild']) {
    const original = parent[method];
    parent[method] = function (...args) {
      log.push(method);
      return original.apply(this, args);
    };
  }
  for (const child of parent.childNodes) {
    let value = child.parentNode;
    Object.defineProperty(child, 'parentNode', {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next) => {
        log.push('parentNode');
        value = next;
      }
    });
  }
  return log;
}

const FULL_LISTING = [
  'puzzle: 2048 Game, Bitmap Decoder, Minesweeper Game, Patch Panel, Rack Reset, Sudoku Game',
  'word: Cyberpunk Wordle, Regex Par',
  'arcade: Bad Sector, On-Call Shift, Snake Game',
  'reflex: Byte Catcher, Reaction Time Test, Typing Speed Test',
  'memory: Defrag, Hash Cracker, Pod Packer, Port Knocker',
  'tabletop: Flip-Flop, Swap Space Solitaire',
  'sim: Lost in /var, Uptime Idle'
];
const ALL_CHIPS = ['All 22*', 'Puzzle 6', 'Word 2', 'Arcade 3', 'Reflex and Typing 3', 'Memory and Logic 4', 'Board and Cards 2',
  'Simulation 2'];

const savedProtocol = Object.getOwnPropertyDescriptor(globalThis.location, 'protocol');

test.beforeEach(() => resetStubs());

test.afterEach(() => {
  resetStubs();
  if (savedProtocol) Object.defineProperty(globalThis.location, 'protocol', savedProtocol);
  else delete globalThis.location.protocol;
});

// ── start-up ─────────────────────────────────────────────────────────────────

test('hub: boots in the browser with every id it looks up present in index.html', () => {
  const b = boot({ createMissing: true });
  const ids = idsInHtml(HTML);
  assert.deepEqual(b.page.missing, []);
  assert.deepEqual(b.page.requested.filter((id) => !ids.includes(id)), []);
  assert.deepEqual([...b.page.requested].sort(),
    ['hub-chips', 'hub-count', 'hub-empty', 'hub-footer', 'hub-list', 'hub-search', 'hub-stats']);
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 0);
  assert.equal(listenerCount(b.els['hub-search'], 'input'), 1);
  assert.equal(listenerCount(b.els['hub-search'], 'keydown'), 1);
  assert.deepEqual(Object.keys(b.exposed), [], 'nothing leaks onto window or the global object');
  assert.deepEqual(listing(), FULL_LISTING);
});

test('hub: waits for DOMContentLoaded only while the document is still loading', () => {
  const b = boot({ readyState: 'loading' });
  assert.equal(b.els['hub-list'].children.length, 0);
  assert.equal(b.els['hub-stats'].textContent, '');
  assert.equal(listenerCount(document, 'keydown'), 0);
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  b.ready();
  assert.deepEqual(listing(), FULL_LISTING);
  assert.equal(b.els['hub-stats'].textContent, '22 games in 7 genres');
  assert.equal(listenerCount(document, 'keydown'), 1);
  b.restore();

  // Once parsing is over DOMContentLoaded may already have fired: start at once.
  const late = boot({ readyState: 'interactive' });
  assert.deepEqual(listing(), FULL_LISTING);
  assert.equal(late.els['hub-stats'].textContent, '22 games in 7 genres');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 0);
  assert.equal(listenerCount(document, 'keydown'), 1);
});

test('hub: a reload starts from a clean page with one set of listeners', () => {
  const first = boot();
  chipButton('Puzzle').click();
  search(first.els, 'mine');
  assert.deepEqual(listing(), ['puzzle: Minesweeper Game']);
  first.restore();
  assert.equal(listenerCount(document, 'keydown'), 0);

  const second = boot();
  assert.equal(listenerCount(document, 'keydown'), 1);
  assert.deepEqual(listing(), FULL_LISTING);
  assert.deepEqual(chips(), ALL_CHIPS);
  assert.deepEqual(status(second.els), { count: '', empty: null });
  assert.equal(localStorage.length, 0, 'the hub stores nothing');
});

test('hub: a value already in the search box when the page starts filters the first render', () => {
  const spec = { ...SPEC, 'hub-search': { ...SPEC['hub-search'], value: '  snake ' } };
  const b = boot({ spec });
  assert.deepEqual(listing(), ['arcade: Snake Game']);
  assert.deepEqual(status(b.els), { count: '1 of 22', empty: null });
  assert.deepEqual(chips(), ['All 1*', 'Puzzle 0', 'Word 0', 'Arcade 1', 'Reflex and Typing 0', 'Memory and Logic 0', 'Board and Cards 0', 'Simulation 0']);
});

// ── header ───────────────────────────────────────────────────────────────────

test('hub: the header counts the games and genres; the placeholder and footer use the game count', () => {
  const { els } = boot();
  const stats = els['hub-stats'];
  assert.equal(stats.textContent, '22 games in 7 genres');
  assert.deepEqual(stats.children.map((c) => c.tagName + ':' + c.textContent), ['STRONG:22', 'STRONG:7']);
  assert.equal(els['hub-search'].placeholder, 'Search 22 games by name or genre  (press /)');
  assert.equal(els['hub-footer'].textContent, 'Local repository index page · 22 games');
});

test('hub: the counts follow the GAMES and GROUPS lists', () => {
  const source = variant((html) => withExtraGroup(withoutGame('bad-sector')(withoutGame('oncall-shift')(withoutGame('snake-game')(html)))));
  const { els } = boot({ source });
  assert.equal(els['hub-stats'].textContent, '19 games in 8 genres');
  assert.equal(els['hub-search'].placeholder, 'Search 19 games by name or genre  (press /)');
  assert.equal(els['hub-footer'].textContent, 'Local repository index page · 19 games');
  assert.deepEqual(chips(), ['All 19*', 'Puzzle 6', 'Word 2', 'Arcade 0', 'Reflex and Typing 3', 'Extra 0', 'Memory and Logic 4',
    'Board and Cards 2', 'Simulation 2']);
  assert.deepEqual(listing(), [FULL_LISTING[0], FULL_LISTING[1], FULL_LISTING[3], FULL_LISTING[4], FULL_LISTING[5], FULL_LISTING[6]]);
});

// ── list and cards ───────────────────────────────────────────────────────────

test('hub: the first render lists every game by genre in GROUPS order, sorted by name', () => {
  const { els } = boot();
  assert.deepEqual(listing(), FULL_LISTING);
  const sections = $$('.hub-section');
  assert.deepEqual(sections.map((s) => s.tagName), GROUPS.map(() => 'SECTION'));
  sections.forEach((section, i) => {
    const group = GROUPS[i];
    const [heading, grid] = section.children;
    assert.equal(section.getAttribute('aria-labelledby'), 'hub-group-' + group.key);
    assert.equal(heading.tagName, 'H2');
    assert.equal(heading.className, 'hub-section-head');
    assert.equal(heading.id, 'hub-group-' + group.key);
    const [dot, count] = heading.children;
    assert.equal(dot.className, 'hub-dot');
    assert.equal(dot.getAttribute('aria-hidden'), 'true');
    assert.equal(dot.style['--hub-group'], group.color);
    assert.equal(ownText(heading), group.label);
    assert.equal(count.className, 'hub-section-n');
    assert.equal(count.textContent, String(GAMES.filter((g) => g.group === group.key).length));
    assert.equal(grid.className, 'hub-grid');
  });
  assert.deepEqual(status(els), { count: '', empty: null });
  assert.equal(els['hub-empty'].hidden, true);
});

test('hub: cards are sorted by name within a genre, ignoring case, whatever the GAMES order', () => {
  // The real names happen to be in folder order already; a lower-case name
  // would sort last by code point and stay put without any sorting.
  const source = variant((html) => html.replace("name: 'Sudoku Game'", "name: 'arrow Sudoku'"));
  boot({ source });
  assert.deepEqual(listing()[0], 'puzzle: 2048 Game, arrow Sudoku, Bitmap Decoder, Minesweeper Game, Patch Panel, Rack Reset');
});

test('hub: each card links its game, carries its genre colour and shows its description', () => {
  boot();
  const cards = $$('.hub-card');
  assert.equal(cards.length, GAMES.length);
  for (const game of GAMES) {
    const card = cards.find((c) => c.children[0].children[0].textContent === game.name);
    assert.ok(card, 'a card for ' + game.name);
    assert.equal(card.tagName, 'ARTICLE');
    assert.equal(card.parentNode.parentNode.children[0].id, 'hub-group-' + game.group);
    const [title, desc] = card.children;
    assert.equal(title.tagName + '.' + title.className, 'H3.hub-card-title');
    const link = title.children[0];
    assert.equal(link.tagName + '.' + link.className, 'A.hub-card-link');
    assert.equal(link.href, game.folder + '/');
    assert.equal(desc.tagName + '.' + desc.className, 'P.hub-card-desc');
    assert.equal(desc.textContent, game.description);
    assert.equal(card.style['--hub-group'], GROUPS.find((g) => g.key === game.group).color);
  }
});

test('hub: card links end in folder/ over http and https', () => {
  for (const protocol of ['http:', 'https:']) {
    setProtocol(protocol);
    boot();
    assert.deepEqual($$('.hub-card-link').map((a) => a.href), [
      '2048-game/', 'bitmap-decoder/', 'minesweeper/', 'patch-panel/', 'rack-reset/', 'sudoku/', 'wordle-game/',
      'regex-par/', 'bad-sector/', 'oncall-shift/', 'snake-game/', 'byte-catcher/', 'reaction-time/',
      'typing-speed-test/', 'defrag/', 'hash-cracker/', 'pod-packer/', 'port-knocker/', 'flip-flop/',
      'swap-space-solitaire/', 'lost-in-var/', 'uptime-idle/'
    ], protocol);
    resetStubs();
  }
});

test('hub: card links open folder/index.html when the page is opened from disk (file://)', () => {
  setProtocol('file:');
  const { els } = boot();
  assert.deepEqual($$('.hub-card-link').map((a) => a.href), [
    '2048-game/index.html', 'bitmap-decoder/index.html', 'minesweeper/index.html', 'patch-panel/index.html',
    'rack-reset/index.html', 'sudoku/index.html', 'wordle-game/index.html', 'regex-par/index.html',
    'bad-sector/index.html', 'oncall-shift/index.html', 'snake-game/index.html', 'byte-catcher/index.html',
    'reaction-time/index.html', 'typing-speed-test/index.html', 'defrag/index.html', 'hash-cracker/index.html',
    'pod-packer/index.html', 'port-knocker/index.html', 'flip-flop/index.html', 'swap-space-solitaire/index.html',
    'lost-in-var/index.html', 'uptime-idle/index.html'
  ]);
  chipButton('Arcade').click();
  search(els, 'snake');
  assert.deepEqual($$('.hub-card-link').map((a) => a.href), ['snake-game/index.html'], 'links built on re-render too');
});

test('hub: the full description is the link tooltip, which the link overlay lets show over the whole card (B3)', () => {
  // .hub-card-link::after covers the whole card, so the pointer is always over
  // the link: a title on the clamped paragraph is never reached, one on the
  // link is.  A title on the article would show too, but it would become the
  // card's accessible name, so screen readers would name each card by its
  // description; on the link it is only the link's accessible description.
  boot();
  const cards = $$('.hub-card');
  assert.equal(cards.length, GAMES.length);
  for (const card of cards) {
    const [heading, desc] = card.children;
    const link = heading.children[0];
    assert.equal(link.title, desc.textContent, link.textContent);
    assert.ok(!card.title, 'no title on the article, which would name the card');
    assert.ok(!heading.title, 'no title on the heading');
    assert.ok(!desc.title, 'no unreachable title on the paragraph');
    assert.ok(!card.getAttribute('aria-label') && !card.getAttribute('aria-labelledby'), 'the card stays unnamed');
  }
  const overlay = declsAt(RULES, '.hub-card-link::after', 1280);
  assert.equal(overlay.position, 'absolute');
  assert.equal(overlay.inset, '0');
  assert.equal(declsAt(RULES, '.hub-card', 1280).position, 'relative');
});

// ── search ───────────────────────────────────────────────────────────────────

test('hub: search ignores case and matches names, descriptions and genre labels', () => {
  const { els } = boot();
  search(els, 'REFLEX');
  assert.deepEqual(listing(), ['reflex: Byte Catcher, Reaction Time Test, Typing Speed Test']);
  assert.deepEqual(status(els), { count: '3 of 22', empty: null });

  search(els, 'Snake');
  assert.deepEqual(listing(), ['arcade: Snake Game']);
  assert.deepEqual(chips(), ['All 1*', 'Puzzle 0', 'Word 0', 'Arcade 1', 'Reflex and Typing 0', 'Memory and Logic 0', 'Board and Cards 0', 'Simulation 0']);

  search(els, 'undo');
  assert.deepEqual(shownNames(), ['2048 Game', 'Flip-Flop'], 'a word only in the descriptions');
  search(els, 'arcade');
  assert.deepEqual(shownNames(), ['Bad Sector', 'On-Call Shift', 'Snake Game'], 'a word only in the genre label');
  search(els, 'mine swe');
  assert.deepEqual(shownNames(), ['Minesweeper Game'], 'parts of words match');
  search(els, '(.*)');
  assert.deepEqual(shownNames(), [], 'the query is plain text, not a pattern');
});

test('hub: every word of a search must match; extra whitespace is ignored', () => {
  const { els } = boot();
  search(els, '  puzzle   board ');
  assert.deepEqual(listing(), ['puzzle: 2048 Game, Bitmap Decoder, Minesweeper Game, Patch Panel']);
  assert.deepEqual(status(els), { count: '4 of 22', empty: null });
  assert.deepEqual(chips(), ['All 4*', 'Puzzle 4', 'Word 0', 'Arcade 0', 'Reflex and Typing 0', 'Memory and Logic 0', 'Board and Cards 0', 'Simulation 0']);
  search(els, 'puzzle board hard');
  assert.deepEqual(shownNames(), ['Minesweeper Game']);
  search(els, ' \t ');
  assert.deepEqual(listing(), FULL_LISTING);
  assert.deepEqual(status(els), { count: '', empty: null });
});

test('hub: a search without a match shows the empty message; clearing the box brings the list back', () => {
  const { els } = boot();
  search(els, 'zzz');
  assert.deepEqual(listing(), []);
  assert.equal(els['hub-list'].children.length, 0);
  assert.deepEqual(status(els), { count: '0 of 22', empty: 'No game matches “zzz”.' });
  assert.deepEqual(chips(), ['All 0*', 'Puzzle 0', 'Word 0', 'Arcade 0', 'Reflex and Typing 0', 'Memory and Logic 0', 'Board and Cards 0', 'Simulation 0']);
  search(els, ' zzz  ');
  assert.equal(status(els).empty, 'No game matches “zzz”.', 'the message shows the trimmed query');
  search(els, '');
  assert.deepEqual(listing(), FULL_LISTING);
  assert.deepEqual(status(els), { count: '', empty: null });
  assert.deepEqual(chips(), ALL_CHIPS);
});

// The empty message and its ancestors, as the markup nests them.
const EMPTY_CHAIN = [
  { tag: 'p', id: 'hub-empty', classes: ['hub-empty'] },
  { tag: 'main', id: '', classes: ['hub-wrapper'] },
  { tag: 'body', id: '', classes: [] },
  { tag: 'html', id: '', classes: [] }
];

// Open elements left between two points of the markup (0: siblings).
function depthBetween(html, from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start !== -1 && end !== -1, from + ' comes before ' + to);
  let depth = 0;
  for (const m of html.slice(start + from.length, end).matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/g)) {
    if (/^(input|br|img|hr|meta|link)$/.test(m[2])) continue;
    depth += m[1] ? -1 : 1;
  }
  return depth;
}

// Whether a selector could apply to the element: its last compound is
// compared by tag, classes and id; anything else in it (attributes, pseudo
// classes) is assumed to match, so the answer errs on the side of yes.  With
// states (e.g. ['hover']) the element itself is meant: a pseudo-element
// selector does not match, nor does a user-action pseudo-class that is not
// among the states.
const USER_ACTIONS = ['hover', 'focus', 'focus-visible', 'focus-within', 'active'];

function couldMatch(selector, el, states) {
  const compound = selector.split(/\s*[>+~]\s*|\s+/).pop();
  if (states) {
    if (/::|:(before|after|first-line|first-letter)\b/i.test(compound)) return false;
    const pseudo = [...compound.replace(/\[[^\]]*\]/g, '').matchAll(/:([a-z-]+)/gi)].map((m) => m[1].toLowerCase());
    if (pseudo.some((name) => USER_ACTIONS.includes(name) && !states.includes(name))) return false;
  }
  const last = compound
    .replace(/::?[a-z-]+(\([^)]*\))?/gi, '').replace(/\[[^\]]*\]/g, '');
  const m = /^([a-z][a-z0-9]*|\*)?((?:[.#][\w-]+)*)$/i.exec(last);
  if (!m) return true;
  if (m[1] && m[1] !== '*' && m[1].toLowerCase() !== el.tag) return false;
  return (m[2].match(/[.#][\w-]+/g) || []).every((part) =>
    part[0] === '.' ? el.classes.includes(part.slice(1)) : el.id === part.slice(1));
}

// A white-space or text-wrap value that stops lines from wrapping (pre-wrap,
// pre-line and break-spaces still wrap).
const NO_WRAP = /(^|\s)(nowrap|pre)(?![\w-])/;

test('hub: a long query without spaces wraps inside the empty message instead of widening the page (B2)', () => {
  const { els } = boot();
  const query = 'x'.repeat(80);
  search(els, query);
  assert.equal(status(els).empty, 'No game matches “' + query + '”.');
  for (const width of [320, 375, 414, 1280]) {
    assert.equal(declsAt(RULES, '.hub-empty', width)['overflow-wrap'], 'anywhere', width + ' px');
  }
  // Nothing may switch the wrapping off again: white-space and text-wrap are
  // inherited, so no rule that could reach the message or one of its
  // ancestors may set nowrap or pre, and none may reset its overflow-wrap.
  assert.equal(depthBetween(HTML, '<body>', '<main class="hub-wrapper">'), 0, 'main sits right in body');
  assert.equal(depthBetween(HTML, '<main class="hub-wrapper">', '<p class="hub-empty" id="hub-empty" hidden>'), 0,
    'the message sits right in main');
  for (const rule of RULES) {
    if (rule.keyframes) continue;
    const where = rule.selectors.join(', ');
    const chain = EMPTY_CHAIN.filter((el) => rule.selectors.some((s) => couldMatch(s, el)));
    if (!chain.length) continue;
    for (const prop of ['white-space', 'text-wrap', 'text-wrap-mode']) {
      assert.doesNotMatch(rule.decls[prop] || '', NO_WRAP, where + ' ' + prop);
    }
    if (chain.includes(EMPTY_CHAIN[0])) {
      for (const prop of ['overflow-wrap', 'word-wrap']) {
        assert.doesNotMatch(rule.decls[prop] || '', /\bnormal\b/, where + ' ' + prop);
      }
    }
  }
  // The scan sees the rules that do stop wrapping, elsewhere on the page.
  const noWrap = RULES.filter((rule) => NO_WRAP.test(rule.decls['white-space'] || '')).map((rule) => rule.selectors.join());
  assert.deepEqual(noWrap, ['.hub-sr', '.hub-count']);
  assert.doesNotMatch('pre-wrap', NO_WRAP);
  assert.match('pre !important', NO_WRAP);
  assert.equal(couldMatch('.hub-sr', EMPTY_CHAIN[0]), false, 'the matcher tells rules apart');
  assert.equal(couldMatch('.hub-wrapper *', EMPTY_CHAIN[0]), true);
  assert.equal(couldMatch('p.hub-empty', EMPTY_CHAIN[0]), true);
  assert.equal(couldMatch('main', EMPTY_CHAIN[1]), true);
  assert.equal(couldMatch('div', EMPTY_CHAIN[1]), false);
});

// ── Escape ───────────────────────────────────────────────────────────────────

test('hub: Escape in the search box clears the query and keeps the chosen genre', () => {
  const { els } = boot();
  chipButton('Puzzle').click();
  els['hub-search'].focus();
  search(els, 'zzz');
  assert.deepEqual(status(els), { count: '0 of 22', empty: 'No game matches “zzz” in this genre.' });
  pressKey('Escape');
  assert.equal(els['hub-search'].value, '');
  assert.deepEqual(listing(), [FULL_LISTING[0]]);
  assert.deepEqual(status(els), { count: '6 of 22', empty: null });
  assert.deepEqual(chips(), ['All 22', 'Puzzle 6*', 'Word 2', 'Arcade 3', 'Reflex and Typing 3', 'Memory and Logic 4', 'Board and Cards 2',
    'Simulation 2']);
  assertSame(document.activeElement, els['hub-search']);
});

test('hub: Escape in an empty box and other keys in the box leave the list as it is', () => {
  const { els } = boot();
  els['hub-search'].focus();
  const before = els['hub-list'].children[0];
  pressKey('Escape');
  assertSame(els['hub-list'].children[0], before, 'no re-render for an empty box');

  search(els, 'snake');
  const filtered = els['hub-list'].children[0];
  for (const key of ['Enter', 'a', 'Backspace']) {
    const event = pressKey(key);
    assert.equal(event.defaultPrevented, false, key);
  }
  assert.equal(els['hub-search'].value, 'snake');
  assertSame(els['hub-list'].children[0], filtered, 'other keys do not re-render');
  assert.deepEqual(shownNames(), ['Snake Game']);

  search(els, '   ');
  pressKey('Escape');
  assert.equal(els['hub-search'].value, '', 'a whitespace-only box is cleared too');
  assert.deepEqual(listing(), FULL_LISTING);
});

// ── '/' shortcut ─────────────────────────────────────────────────────────────

test('hub: / focuses the search box from the page, a chip or a card link', () => {
  const { els } = boot();
  const searchBox = els['hub-search'];
  for (const focus of [document.body, chipButton('Word'), $$('.hub-card-link')[2]]) {
    if (focus === document.body) searchBox.blur();
    else focus.focus();
    const event = pressKey('/');
    assert.equal(event.defaultPrevented, true, 'the / is not typed into the box');
    assertSame(document.activeElement, searchBox);
    searchBox.blur();
  }
  document.activeElement = null;
  assert.equal(pressKey('/', { target: document.body }).defaultPrevented, true, 'no focused element');
  assertSame(document.activeElement, searchBox);
});

test('hub: / with Ctrl, Meta or Alt is left to the browser; Shift+/ still focuses the search', () => {
  const { els } = boot();
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    const event = pressKey('/', { [modifier]: true });
    assert.equal(event.defaultPrevented, false, modifier);
    assertSame(document.activeElement, document.body, modifier);
  }
  // On a German keyboard '/' is Shift+7.
  assert.equal(pressKey('/', { shiftKey: true }).defaultPrevented, true);
  assertSame(document.activeElement, els['hub-search']);
});

test('hub: / types normally in the search box and in other form fields; other keys are ignored', () => {
  const b = boot();
  b.els['hub-search'].focus();
  assert.equal(pressKey('/').defaultPrevented, false, 'in the search box');
  for (const tag of ['input', 'textarea', 'select']) {
    const field = document.createElement(tag);
    b.page.root.appendChild(field);
    field.focus();
    assert.equal(pressKey('/').defaultPrevented, false, tag);
    assertSame(document.activeElement, field, tag);
  }
  document.activeElement = document.body;
  for (const key of ['?', 'a', 'Escape', 'Enter']) {
    assert.equal(pressKey(key).defaultPrevented, false, key);
    assertSame(document.activeElement, document.body, key);
  }
});

// ── genre chips ──────────────────────────────────────────────────────────────

test('hub: the genre chips are All plus one per genre with its count; only genres have a dot', () => {
  boot();
  assert.deepEqual(chips(), ALL_CHIPS);
  const buttons = $$('.hub-chip');
  assert.equal(buttons[0].parentNode.id, 'hub-chips');
  for (const button of buttons) {
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.type, 'button');
  }
  assert.deepEqual(buttons[0].children.map((c) => c.className), ['hub-chip-n']);
  buttons.slice(1).forEach((button, i) => {
    const [dot, count] = button.children;
    assert.equal(dot.className, 'hub-dot');
    assert.equal(dot.getAttribute('aria-hidden'), 'true');
    assert.equal(dot.style['--hub-group'], GROUPS[i].color);
    assert.equal(count.className, 'hub-chip-n');
  });
});

test('hub: a genre chip shows only its genre; clicking it again or All returns to every genre', () => {
  const { els } = boot();
  chipButton('Puzzle').click();
  assert.deepEqual(listing(), [FULL_LISTING[0]]);
  assert.deepEqual(chips(), ['All 22', 'Puzzle 6*', 'Word 2', 'Arcade 3', 'Reflex and Typing 3', 'Memory and Logic 4', 'Board and Cards 2',
    'Simulation 2']);
  assert.deepEqual(status(els), { count: '6 of 22', empty: null });

  chipButton('Puzzle').click();
  assert.deepEqual(listing(), FULL_LISTING);
  assert.deepEqual(chips(), ALL_CHIPS);
  assert.deepEqual(status(els), { count: '', empty: null });

  chipButton('Word').click();
  assert.deepEqual(listing(), [FULL_LISTING[1]]);
  chipButton('Reflex and Typing').click();
  assert.deepEqual(listing(), [FULL_LISTING[3]]);
  assert.deepEqual(chips(), ['All 22', 'Puzzle 6', 'Word 2', 'Arcade 3', 'Reflex and Typing 3*', 'Memory and Logic 4', 'Board and Cards 2',
    'Simulation 2']);
  assert.equal(status(els).count, '3 of 22');

  chipButton('All').click();
  assert.deepEqual(listing(), FULL_LISTING);
  assert.deepEqual(chips(), ALL_CHIPS);
  chipButton('All').click();
  assert.deepEqual(chips(), ALL_CHIPS, 'All stays on when clicked again');
});

test('hub: activating a chip from the keyboard keeps the same button in place and focused (B1)', () => {
  const { els } = boot();
  const row = els['hub-chips'];
  const before = $$('.hub-chip');
  // A browser moves the focus to body as soon as the focused button leaves the
  // page, even when it is put straight back.  The stub keeps
  // document.activeElement when a node is detached, so the focus checks below
  // cannot see that; the chip row is watched for any detach, move or insert.
  const changes = watchChildren(row);
  const puzzle = chipButton('Puzzle');
  puzzle.focus();
  pressKey('Enter');
  assert.deepEqual(listing(), [FULL_LISTING[0]]);
  assert.deepEqual(changes, [], 'Enter leaves the chip row as it is');
  assertSame(puzzle.parentNode, row, 'the activated chip is still in the chip row');
  assert.ok(sameNodes($$('.hub-chip'), before), 'the chips are updated, not rebuilt');
  assertSame(document.activeElement, puzzle);
  assert.equal(puzzle.getAttribute('aria-pressed'), 'true');

  pressKey('Enter');
  assert.deepEqual(listing(), FULL_LISTING, 'a second Enter on the same chip goes back to All');
  assert.equal(puzzle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(changes, [], 'a second Enter leaves the chip row as it is');

  const word = chipButton('Word');
  word.focus();
  pressKey(' ');
  assert.deepEqual(listing(), [FULL_LISTING[1]]);
  assert.deepEqual(changes, [], 'Space leaves the chip row as it is');
  assertSame(word.parentNode, row);
  assertSame(document.activeElement, word);

  search(els, 'snake');
  assert.deepEqual(changes, [], 'a search leaves the chip row as it is');
  assert.ok(sameNodes($$('.hub-chip'), before), 'a search updates the counts in place');
  assert.deepEqual(chips(), ['All 1', 'Puzzle 0', 'Word 0*', 'Arcade 1', 'Reflex and Typing 0', 'Memory and Logic 0', 'Board and Cards 0', 'Simulation 0']);

  // The watch does see a chip put back where it was, and the row being cleared.
  row.appendChild(row.lastChild);
  assert.deepEqual(changes, ['appendChild', 'removeChild', 'parentNode', 'parentNode']);
  row.textContent = '';
  assert.deepEqual(changes.slice(4), before.map(() => 'parentNode'));
});

test('hub: a genre without a match for the search says so; the chip counts point to the right genre', () => {
  const { els } = boot();
  search(els, 'snake');
  chipButton('Puzzle').click();
  assert.deepEqual(listing(), []);
  assert.deepEqual(status(els), { count: '0 of 22', empty: 'No game matches “snake” in this genre.' });
  assert.deepEqual(chips(), ['All 1', 'Puzzle 0*', 'Word 0', 'Arcade 1', 'Reflex and Typing 0', 'Memory and Logic 0', 'Board and Cards 0', 'Simulation 0']);
  chipButton('Arcade').click();
  assert.deepEqual(listing(), ['arcade: Snake Game']);
  assert.deepEqual(status(els), { count: '1 of 22', empty: null });
});

test('hub: a genre without games gets a 0 chip, and choosing it shows the empty message', () => {
  // The wording without a query is pinned as it is; a dedicated text is a
  // proposal for Vasyl.
  const { els } = boot({ source: variant(withExtraGroup) });
  assert.deepEqual(chips(), ALL_CHIPS.slice(0, 5).concat('Extra 0', ALL_CHIPS.slice(5)));
  assert.deepEqual(listing(), FULL_LISTING, 'no section for an empty genre');
  chipButton('Extra').click();
  assert.deepEqual(listing(), []);
  assert.deepEqual(status(els), { count: '0 of 22', empty: 'No game matches “” in this genre.' });
});

// ── data checks ──────────────────────────────────────────────────────────────

test('hub: a game in a genre GROUPS lacks stops the page with an error naming the folder', () => {
  for (const key of ['nope', 'toString']) {
    const source = variant(withGroupOf('wordle-game', key));
    assert.throws(() => boot({ source }), new RegExp('Unknown group "' + key + '" for wordle-game'));
    assertSame(document.getElementById('hub-list'), null, 'the failed boot is undone');
    assert.equal(listenerCount(document, 'keydown'), 0);
  }
});

test('hub: GAMES lists every game folder on disk once, in folder order, each with its three files', () => {
  const onDisk = fs.readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'tests' && d.name !== 'node_modules')
    .filter((d) => fs.existsSync(path.join(REPO_ROOT, d.name, 'index.html')))
    .map((d) => d.name)
    .sort();
  const folders = GAMES.map((g) => g.folder);
  assert.deepEqual(folders, onDisk);
  assert.deepEqual(folders, [...folders].sort(), 'GAMES is in folder order');
  for (const folder of folders) {
    for (const file of ['index.html', 'style.css', 'script.js']) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, folder, file)), folder + '/' + file);
    }
  }
});

test('hub: games and genres are complete and unique, and each game page is titled with its name', () => {
  assert.deepEqual(GAMES.map((g) => Object.keys(g).join()), GAMES.map(() => 'name,folder,group,description'));
  assert.deepEqual(GROUPS.map((g) => Object.keys(g).join()), GROUPS.map(() => 'key,label,color'));
  const names = GAMES.map((g) => g.name);
  assert.equal(new Set(names).size, names.length, 'unique names');
  for (const game of GAMES) {
    assert.ok(game.name.trim() && game.description.trim(), game.folder + ' has a name and a description');
    assert.ok(LABEL[game.group], game.folder + ' is in a known genre');
    const title = /<title>([^<]*)<\/title>/.exec(readRepoFile(game.folder + '/index.html'))[1];
    assert.ok(title.startsWith(game.name), game.folder + ' title "' + title + '" starts with ' + game.name);
  }
  assert.equal(new Set(GROUPS.map((g) => g.key)).size, GROUPS.length, 'unique genre keys');
  assert.equal(new Set(GROUPS.map((g) => g.label)).size, GROUPS.length, 'unique genre labels');
  assert.ok(!LABEL.all, '"all" is the All chip, not a genre');
  for (const group of GROUPS) {
    assert.match(group.color, /^#[0-9a-f]{6}$/i, group.key);
    assert.ok(GAMES.some((g) => g.group === group.key), group.key + ' has a game');
  }
});

test('hub: README Repository Structure lists each game under its genre, in GROUPS order', () => {
  const readme = readRepoFile('README.md');
  const start = readme.indexOf('## Repository Structure');
  const end = readme.indexOf('### Other files', start);
  assert.ok(start !== -1 && end !== -1, 'README has the Repository Structure section');
  const headings = [];
  const genreOf = {};
  for (const line of readme.slice(start, end).split(/\r?\n/)) {
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) headings.push(heading[1]);
    const item = /^- `([^`]+)\/`/.exec(line);
    if (item) genreOf[item[1]] = headings[headings.length - 1];
  }
  assert.deepEqual(headings, GROUPS.map((g) => g.label));
  assert.deepEqual(genreOf, Object.fromEntries(GAMES.map((g) => [g.folder, LABEL[g.group]])));
});

test('hub: README Game Overview and the css-template.md prefix registry name the same games', () => {
  const overview = [...readRepoFile('README.md').matchAll(/^### \d+\) (.+?)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual([...overview].sort(), GAMES.map((g) => g.name).sort());
  const registry = [...readRepoFile('css-template.md').matchAll(/^\|\s*`[a-z0-9]+`\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)\/`\s*\|/gm)]
    .map((m) => m[1] + ' -> ' + m[2]);
  assert.deepEqual(registry.sort(), GAMES.map((g) => g.name + ' -> ' + g.folder).sort());
});

test('hub: the rendered page matches GAMES and GROUPS exactly', () => {
  boot();
  const rendered = $$('.hub-card').map((card) => {
    const link = card.children[0].children[0];
    return {
      name: link.textContent,
      folder: link.href.replace(/\/$/, ''),
      group: card.parentNode.parentNode.children[0].id.replace(/^hub-group-/, ''),
      description: card.children[1].textContent
    };
  });
  const byName = (a, b) => a.name.localeCompare(b.name);
  assert.deepEqual([...rendered].sort(byName), [...GAMES].sort(byName));
  assert.deepEqual(chips().slice(1).map((c) => c.replace(/ \d+$/, '')), GROUPS.map((g) => g.label));
});

// ── static checks ────────────────────────────────────────────────────────────

test('hub: genre colours use the prefixed --hub-group variable (B4)', () => {
  const css = STYLE.replace(/\/\*[\s\S]*?\*\//g, '');
  const cssVars = [...new Set(css.match(/--[A-Za-z][\w-]*/g))];
  const scriptVars = [...new Set([...SCRIPT.matchAll(/'(--[\w-]+)'/g)].map((m) => m[1]))];
  assert.deepEqual(cssVars.filter((name) => !name.startsWith('--hub-')), [], 'CSS custom properties');
  assert.deepEqual(scriptVars, ['--hub-group'], 'the variable the script sets');
  assert.equal(declsAt(RULES, '.hub-dot', 1280).background, 'var(--hub-group, var(--hub-text-muted))');
  assert.equal(declsAt(RULES, '.hub-card', 1280)['border-left'], '3px solid var(--hub-group, var(--hub-border))');
  assert.equal(declsAt(RULES, '.hub-card:hover', 1280)['border-left-color'], 'var(--hub-group, var(--hub-border))');

  boot();
  for (const node of $$('.hub-card, .hub-dot')) {
    assert.deepEqual(Object.keys(node.style), ['--hub-group']);
  }
});

// Selector specificity as [ids, classes, types] (no :is/:where/:not, which
// the page does not use).
function specificity(selector) {
  const pseudoElements = (selector.match(/::[\w-]+/g) || []).length;
  const rest = selector.replace(/::[\w-]+/g, '');
  const ids = (rest.match(/#[\w-]+/g) || []).length;
  const classes = (rest.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g) || []).length;
  const types = (rest.replace(/\[[^\]]*\]|[.#:][\w-]+(\([^)]*\))?/g, ' ').match(/(^|[\s>+~])[a-z][a-z0-9]*/gi) || []).length;
  return [ids, classes, types + pseudoElements];
}

// Compares two ranks element by element, the first difference deciding.
function compareRanks(a, b) {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i === -1 ? 0 : a[i] - b[i];
}

// The value the inline style sheet gives prop on an element in the given
// states at a viewport width: !important first, then the most specific
// selector, then the later rule.  Only the last compound of a selector is
// compared (see couldMatch), and media queries other than widths count as
// matching, so every rule that might compete does.
function cascaded(prop, el, width, states = []) {
  let best = null;
  RULES.forEach((rule, order) => {
    const value = rule.decls[prop];
    if (value === undefined || rule.keyframes || width > rule.maxWidth || width < rule.minWidth) return;
    const important = /!important\s*$/.test(value) ? 1 : 0;
    for (const selector of rule.selectors.filter((s) => couldMatch(s, el, states))) {
      const rank = [important, ...specificity(selector), order];
      if (!best || compareRanks(rank, best.rank) > 0) best = { rank, value: value.replace(/\s*!important\s*$/, '') };
    }
  });
  return best && best.value;
}

test('hub: the byline links keep their own colours over the generic link colour', () => {
  // .hub-wrapper a { color: inherit } would give them the muted colour of the
  // byline; the .hub-text-link rules have to win, by !important or by a more
  // specific selector.
  const textLink = { tag: 'a', id: '', classes: ['hub-text-link'] };
  assert.equal([...MARKUP.matchAll(/<a class="hub-text-link" href="https:\/\/vahac\.com\/[^"]*">/g)].length, 2);
  for (const width of [320, 375, 1280]) {
    assert.equal(cascaded('color', textLink, width), 'var(--hub-text-secondary)', width + ' px');
    assert.equal(cascaded('color', textLink, width, ['focus', 'focus-visible']), 'var(--hub-text-secondary)', width + ' px, focus');
    assert.equal(cascaded('color', textLink, width, ['hover']), 'var(--hub-accent-cyan)', width + ' px, hover');
  }
  // Self-checks of the helpers.
  const plainLink = { tag: 'a', id: '', classes: [] };
  assert.equal(cascaded('color', plainLink, 1280), 'inherit', 'any other link takes the colour around it');
  assert.equal(cascaded('color', { tag: 'button', id: '', classes: ['hub-chip'] }, 1280, ['hover']), 'var(--hub-text-primary)');
  assert.equal(couldMatch('.hub-search::placeholder', { tag: 'input', id: 'hub-search', classes: ['hub-search'] }, []), false);
  assert.deepEqual(specificity('.hub-wrapper a'), [0, 1, 1]);
  assert.deepEqual(specificity('.hub-wrapper .hub-text-link:hover'), [0, 3, 0]);
  assert.deepEqual(specificity('.hub-chip[aria-pressed="true"]'), [0, 2, 0]);
  assert.deepEqual(specificity('#hub-empty'), [1, 0, 0]);
  assert.deepEqual(specificity('.hub-search::placeholder'), [0, 1, 1]);
});

test('hub: ids are unique and every class and id carries the hub- prefix', () => {
  const ids = idsInHtml(HTML);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.deepEqual(ids.filter((id) => !id.startsWith('hub-')), []);
  const markupClasses = [...MARKUP.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  assert.ok(markupClasses.length > 10);
  assert.deepEqual(markupClasses.filter((c) => !c.startsWith('hub-')), [], 'classes in the markup');
  const selectorNames = RULES.flatMap((rule) => rule.selectors)
    .flatMap((selector) => selector.replace(/\[[^\]]*\]/g, '').match(/[.#][A-Za-z_][\w-]*/g) || []);
  assert.deepEqual(selectorNames.filter((name) => !name.slice(1).startsWith('hub-')), [], 'classes and ids in the CSS');

  const { els } = boot();
  search(els, 'puzzle');
  const rendered = $$('*').filter((node) => node.className || node.id);
  assert.ok(rendered.length > 30);
  for (const node of rendered) {
    for (const name of String(node.className).split(/\s+/).filter(Boolean)) {
      assert.ok(name.startsWith('hub-'), 'class ' + name);
    }
    if (node.id) assert.ok(node.id.startsWith('hub-'), 'id ' + node.id);
  }
});

test('hub: the inline script stays one strict ES5 IIFE that stores nothing and is safe inline', () => {
  assert.equal([...HTML.matchAll(/<script\b/g)].length, 1, 'one script block');
  assert.match(SCRIPT, /^\s*\(function \(\) \{\n\s*'use strict';\n/);
  assert.match(SCRIPT, /\n\s*\}\)\(\);\s*$/);
  const code = SCRIPT
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  for (const [what, pattern] of [
    ['arrow functions', /=>/], ['let', /\blet\b/], ['const', /\bconst\b/], ['template literals', /`/],
    ['classes', /\bclass\b/], ['optional chaining', /\?\./], ['spread', /\.\.\./],
    ['modules', /\b(import|export)\b/], ['storage', /\b(localStorage|sessionStorage|indexedDB)\b/],
    ['globals on window', /\bwindow\./]
  ]) {
    assert.doesNotMatch(code, pattern, what);
  }
  assert.deepEqual(embedSafety(SCRIPT), []);
  assert.deepEqual(embedSafety(STYLE), []);
});

test('hub: the phone layout stacks the cards, scrolls the chips sideways and never widens the page', () => {
  assert.match(HTML, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  for (const width of [320, 375, 414]) {
    assert.equal(declsAt(RULES, '.hub-grid', width)['grid-template-columns'], 'minmax(0, 1fr)', width + ' px');
    const chipRow = declsAt(RULES, '.hub-chips', width);
    assert.equal(chipRow['flex-wrap'], 'nowrap');
    assert.equal(chipRow['overflow-x'], 'auto');
    assert.equal(declsAt(RULES, '.hub-chip', width)['flex-shrink'], '0');
    assert.equal(declsAt(RULES, '.hub-wrapper', width).padding, '1rem 0.75rem 2rem');
  }
  assert.equal(declsAt(RULES, '.hub-grid', 1024)['grid-template-columns'], 'repeat(auto-fill, minmax(280px, 1fr))');
  assert.equal(declsAt(RULES, '.hub-chips', 1024)['flex-wrap'], 'wrap');
  assert.equal(declsAt(RULES, '.hub-chips', 1024)['overflow-x'], undefined);
  assert.equal(declsAt(RULES, '.hub-search', 320)['min-width'], '0');
  assert.equal(declsAt(RULES, '.hub-card', 320)['min-width'], '0');
  assert.equal(declsAt(RULES, '.hub-wrapper', 1280)['max-width'], '1180px');
  // 320 px minus the 0.75rem side padding leaves 296 px: nothing may ask for more.
  for (const rule of RULES) {
    if (rule.minWidth > 320 || rule.maxWidth < 320 || /prefers|hover|print/.test(rule.media)) continue;
    for (const prop of ['width', 'min-width', 'flex-basis']) {
      const px = /^(\d+(?:\.\d+)?)px$/.exec(rule.decls[prop] || '');
      if (px) assert.ok(Number(px[1]) <= 296, rule.selectors.join() + ' ' + prop + ' ' + rule.decls[prop]);
    }
  }
  assert.equal(declsAt(RULES, '.hub-empty', 320).display, undefined, 'the hidden attribute keeps working');
});

test('hub: the search box is labelled and the page explains itself without JavaScript', () => {
  assert.match(MARKUP, /<label class="hub-sr" for="hub-search">Search games<\/label>/);
  assert.equal(SPEC['hub-search'].type, 'search');
  assert.equal(SPEC['hub-search'].attributes.autocomplete, 'off');
  assert.equal(SPEC['hub-count'].attributes['aria-live'], 'polite');
  assert.equal(SPEC['hub-chips'].tagName, 'nav');
  assert.equal(SPEC['hub-chips'].attributes['aria-label'], 'Filter by genre');
  assert.equal(SPEC['hub-empty'].hidden, true);
  assert.match(MARKUP, /<noscript>\s*<p class="hub-noscript">This index is built with JavaScript\./);
});
