// tests/reaction-time.source.test.js
// Reaction Time Test (reaction-time/, prefix rxt): the markup, the stylesheet
// and the source text.  Ids the script looks up, the rxt prefix everywhere,
// block-comment safety for the WordPress embed, ES5 style and the start-up
// guard, and the phone layout (320-414 px).  The game's behaviour is tested in
// reaction-time.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resetStubs, bootLikeBrowser, readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety,
  cssRules, declsAt
} = require('./_setup');

const SCRIPT = 'reaction-time/script.js';
const KEY = 'rxt-reaction-state';
const HTML = readRepoFile('reaction-time/index.html');
const CSS = readRepoFile('reaction-time/style.css');
const JS = readRepoFile(SCRIPT);
const IDS = [
  'rxt-board', 'rxt-board-label', 'rxt-board-hint', 'rxt-current-reaction', 'rxt-best-reaction',
  'rxt-average-reaction', 'rxt-attempts', 'rxt-timer', 'rxt-difficulty', 'rxt-new-game',
  'rxt-restart-game', 'rxt-action-trigger', 'rxt-toast', 'rxt-overlay', 'rxt-overlay-title',
  'rxt-overlay-text', 'rxt-overlay-button', 'rxt-status-pill'
];

// script.js split into its code (comments dropped, every string literal
// emptied) and the contents of its string literals.
function scanSource(src) {
  let code = '';
  const strings = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      code += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      code += ' ';
    } else if (c === '\'' || c === '"') {
      let j = i + 1;
      while (src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      strings.push(src.slice(i + 1, j));
      code += c + c;
      i = j;
    } else {
      code += c;
    }
  }
  return { code, strings };
}

test.beforeEach(() => {
  resetStubs();
});

test('reaction: index.html has every element the script looks up, with unique prefixed ids', () => {
  const ids = idsInHtml(HTML);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  ids.forEach((id) => assert.match(id, /^rxt-/));
  // The game booted like a browser asks only for ids the markup has.
  const b = bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), { createMissing: true });
  assert.deepEqual(b.page.missing, [], 'no id the script asks for is missing');
  assert.deepEqual(b.page.requested.slice().sort(), IDS.slice().sort());
  assert.ok(HTML.indexOf('<div class="rxt-wrapper"') < HTML.indexOf('<script src="script.js"></script>'));
});

test('reaction: the embedded sources are block-comment safe and touch no bare html/body', () => {
  // build-embed copies style.css, script.js and the markup from the wrapper up to
  // the <script> tag into one <!-- wp:vahac/tool-embed --> block comment.
  const markup = embedMarkup(HTML);
  assert.ok(markup.startsWith('<div class="rxt-wrapper"'));
  assert.ok(markup.includes('id="rxt-overlay-button"'), 'the whole game markup is embedded');
  assert.deepEqual(embedSafety(CSS), []);
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(markup), []);
  assert.equal(/<style|<script/i.test(markup), false, 'no <style> or <script> inside the embedded markup');
  cssRules(CSS).forEach((rule) => rule.selectors.forEach((sel) => {
    assert.equal(/^(html|body|:root)\b/.test(sel), false, sel + ' would style the host page');
  }));
});

test('reaction: opened on its own, the page has no margin and the wrapper background', () => {
  // Without this rule the body is transparent with the browser's 8px margin.
  const bg = CSS.match(/--rxt-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
});

test('reaction: every class, id, custom property, keyframes name and storage key carries the rxt prefix', () => {
  const htmlClasses = Array.from(HTML.matchAll(/class="([^"]*)"/g), (m) => m[1].split(/\s+/)).flat().filter(Boolean);
  htmlClasses.forEach((name) => assert.match(name, /^rxt-/, 'class ' + name));

  const rules = cssRules(CSS);
  const cssClasses = new Set();
  rules.filter((r) => !r.keyframes).forEach((rule) => rule.selectors.forEach((sel) => {
    const tokens = Array.from(sel.matchAll(/([.#])(-?[_a-zA-Z][\w-]*)/g));
    assert.ok(tokens.length > 0, sel + ' is scoped by an rxt class');
    tokens.forEach((m) => {
      assert.match(m[2], /^rxt-/, 'selector ' + sel);
      if (m[1] === '.') cssClasses.add(m[2]);
    });
  }));
  (CSS.match(/--[\w-]+/g) || []).forEach((name) => assert.match(name, /^--rxt-/));
  const keyframes = Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);
  assert.deepEqual(keyframes, ['rxt-shake']);
  assert.equal(declsAt(rules, '.rxt-board-failed', 1024).animation, 'rxt-shake 0.3s ease');

  // Every rxt- string in script.js is an element id, a stylesheet class or the save key.
  const ids = new Set(idsInHtml(HTML));
  const used = scanSource(JS).strings.filter((s) => s.startsWith('rxt'));
  assert.ok(used.includes(KEY));
  used.forEach((s) => {
    assert.ok(ids.has(s) || cssClasses.has(s) || s === KEY, s + ' is neither an id, a class nor the save key');
  });
  ['rxt-board-idle', 'rxt-board-waiting', 'rxt-board-active', 'rxt-board-failed', 'rxt-toast-visible', 'rxt-overlay-visible']
    .forEach((name) => assert.ok(cssClasses.has(name) && used.includes(name), name + ' is styled and toggled'));
});

test('reaction: script.js is one strict ES5 IIFE behind the start-up guard', () => {
  const code = scanSource(JS).code.trim();
  assert.ok(code.startsWith('(function () {'), 'one IIFE');
  assert.ok(code.endsWith('})();'));
  assert.ok(JS.includes('\'use strict\';'));
  for (const [what, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow functions', /=>/], ['classes', /\bclass\s/],
    ['template literals', /`/], ['optional chaining', /\?\./], ['spread', /\.\.\./], ['modules', /\b(import|export)\s/]
  ]) {
    assert.equal(re.test(code), false, 'script.js uses ' + what);
  }
  // build-embed.js only rewrites the start-up when this text is missing.
  assert.ok(JS.includes('document.readyState === \'loading\''));
  assert.ok(JS.includes('typeof module !== \'undefined\' && module.exports'));
});

test('reaction: phones 320-414 px get full-width controls, one column and a tighter wrapper', () => {
  const rules = cssRules(CSS);
  for (const vw of [320, 375, 414]) {
    assert.equal(declsAt(rules, '.rxt-button', vw).width, '100%', vw + ' button');
    assert.equal(declsAt(rules, '.rxt-select', vw).width, '100%', vw + ' select');
    assert.equal(declsAt(rules, '.rxt-main', vw)['grid-template-columns'], '1fr', vw + ' one column');
    assert.equal(declsAt(rules, '.rxt-board', vw)['min-height'], '360px');
    assert.equal(declsAt(rules, '.rxt-toolbar', vw)['flex-direction'], 'column');
  }
  assert.equal(declsAt(rules, '.rxt-wrapper', 320).padding, '14px');
  assert.equal(declsAt(rules, '.rxt-wrapper', 375).padding, '14px');
  assert.equal(declsAt(rules, '.rxt-wrapper', 414).padding, '24px');
  assert.equal(declsAt(rules, '.rxt-main', 1024)['grid-template-columns'], '1.7fr 1fr', 'two columns on desktop');
  assert.equal(declsAt(rules, '.rxt-button', 1024).width, undefined);
  assert.equal(declsAt(rules, '.rxt-overlay-card', 320).width, 'min(100%, 420px)');
  rules.forEach((rule) => ['width', 'min-width', 'flex-basis'].forEach((prop) => {
    const m = /^([\d.]+)px$/.exec(rule.decls[prop] || '');
    assert.ok(!m || Number(m[1]) <= 320, rule.selectors.join(', ') + ' ' + prop + ' is wider than a 320 px phone');
  }));
  assert.ok(CSS.endsWith('\n'), 'style.css ends with a newline');
});
