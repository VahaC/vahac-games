// tests/cold-aisle.ui-source.test.js
// The source and layout checks of Cold Aisle's page: ids, classes, custom
// properties and storage under the cda- prefix, every id the script looks
// up present once in the markup, every class it uses styled, the three
// shipped files safe to embed and free of network resources, the UI parts
// (ES5, under 900 lines, their opening comments, the pure ones without the
// DOM), the markup's structure (one frame holds the game; real buttons with
// labels; a live region; the canvas's label lists the keys), and the CSS
// from 320 px up: the narrow-window notice below 720 px, nothing wider
// than a phone, the stage's pixelated canvas, reduced motion.
// The page itself is driven in tests/cold-aisle.ui-page.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt
} = require('./_setup');

const GAME = 'cold-aisle';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);
const BUILD = require('../' + GAME + '/build.js');
const UI_PARTS = BUILD.UI_PARTS.filter((part) => /^ui-/.test(part));
const UI = UI_PARTS.map((part) => readRepoFile(GAME + '/src/' + part + '.js')).join('\n');
const RULES = cssRules(CSS);
const cda = loadScript(SCRIPT);

// The ids cdaFind looks up, in its table's order.
const LOOKED_UP = (() => {
  const src = readRepoFile(GAME + '/src/ui-page.js');
  const at = src.indexOf('var ids = {');
  return Array.from(src.slice(at, src.indexOf('};', at)).matchAll(/'(cda-[\w-]+)'/g), (m) => m[1]);
})();

// The code of the UI parts without strings and comments.
const CODE = UI.replace(/'(?:[^'\\\n]|\\.)*'/g, '\'\'').replace(/\/\/[^\n]*/g, '');

const W = (selector) => '.cda-wrapper ' + selector;
const px = (value) => Number(/^(-?[\d.]+)px$/.exec(value)[1]);

test('cold-aisle ui source: every id the script looks up is in index.html once; ids, classes, custom properties and the storage key are cda- prefixed', () => {
  assert.equal(new Set(LOOKED_UP).size, LOOKED_UP.length, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of LOOKED_UP) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^cda-/);
  // the rest are the guide's numbers and sprites, the HUD's icons and the
  // labels the markup points at
  const rest = htmlIds.filter((id) => !LOOKED_UP.includes(id));
  for (const id of rest) assert.match(id, /^cda-(num|spr)-|^cda-(health|armour|racks)-icon$|^cda-guide$/, id);
  assert.doesNotMatch(UI, /getElementById\((?!ids\[)/, 'cdaFind is the one lookup by id');
  assert.deepEqual(Array.from(new Set(Array.from(UI.matchAll(/'(cda-[\w-]+-)' \+/g), (m) => m[1]))).sort(), ['cda-buy-', 'cda-level-']);
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^cda-/);
  assert.deepEqual(Array.from(UI.matchAll(/'(--[\w-]+)'/g), (m) => m[1]), ['--cda-scale'], 'the one custom property the script sets');
  assert.doesNotMatch(CODE, /localStorage\b/, 'only the storage part touches it (a new game is a save of a higher epoch)');
  assert.match(JS, /var CDA_SAVE_KEY = 'cda-state';/);
  for (const name of Object.keys(cda)) assert.match(name, /^(cda[A-Z]|CDA_)/, name);
  for (const rule of RULES) {
    for (const selector of rule.selectors) {
      if (rule.keyframes) continue;
      assert.match(selector, /^\.cda-wrapper\b/, selector + ' sits under the wrapper');
      for (const m of selector.matchAll(/[.#]([\w-]+)/g)) assert.match(m[1], /^cda-/, selector);
    }
  }
  for (const m of CSS.matchAll(/@keyframes\s+([\w-]+)/g)) assert.match(m[1], /^cda-/);
});

test('cold-aisle ui source: every class in the markup and every class the script gives an element has a CSS rule', () => {
  const styled = new Set(RULES.flatMap((rule) => rule.selectors.flatMap((s) => Array.from(s.matchAll(/\.([\w-]+)/g), (m) => m[1]))));
  const used = new Set();
  for (const m of embedMarkup(HTML).matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => used.add(c));
  for (const m of UI.matchAll(/(?:cdaMake\('\w+', |cdaButton\()'([^']+)'/g)) m[1].split(/\s+/).forEach((c) => used.add(c));
  for (const m of UI.matchAll(/classList\.(?:toggle|add|remove|contains)\('([^']+)'/g)) used.add(m[1]);
  for (const name of ['cda-hidden', 'cda-level', 'cda-level-name', 'cda-level-stats', 'cda-level--locked', 'cda-level--won', 'cda-stat',
    'cda-upgrade', 'cda-upgrade-why', 'cda-buy', 'cda-guide-upgrade', 'cda-hud--low', 'cda-stage--low', 'cda-badge--off', 'cda-frame--full']) {
    assert.ok(used.has(name), name + ' is used');
  }
  for (const name of used) {
    assert.match(name, /^cda-/);
    if (name === 'cda-buy') continue;
    assert.ok(styled.has(name), name + ' has a CSS rule');
  }
});

test('cold-aisle ui source: the three files embed safely, load nothing from the network, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="cda-wrapper"'));
  assert.ok(embedded.includes('id="cda-guide"'), 'the whole game and its guide are in the wrapper');
  assert.deepEqual(embedSafety(embedded), []);
  const bg = CSS.match(/--cda-bg-primary:\s*(#[0-9a-fA-F]{6})/)[1];
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Cold Aisle — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{120,}">/);
  assert.match(head, /<meta name="viewport" content="width=device-width, initial-scale=1.0">/);
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(|@font-face|data:image/, 'no network resources, no data URIs');
  }
  assert.doesNotMatch(UI, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|Worker|Image)\b/);
  assert.doesNotMatch(UI, /innerHTML/, 'text goes in as text');
  assert.ok(Buffer.byteLength(JS) < 260 * 1024, 'script.js under 260 KB: ' + Buffer.byteLength(JS));
});

test('cold-aisle ui source: the UI parts follow storage in build.js, each under 900 lines with its opening comment, in ES5 with cda names; the pure ones touch no DOM', () => {
  assert.deepEqual(BUILD.UI_PARTS, ['storage', 'ui-text', 'ui-layout', 'ui-page', 'ui-hud', 'ui-screens', 'ui-guide', 'ui-input', 'ui-loop']);
  assert.deepEqual(BUILD.PARTS.slice(-BUILD.UI_PARTS.length - 1), BUILD.UI_PARTS.concat(['main']));
  for (const part of UI_PARTS) {
    const text = readRepoFile(GAME + '/src/' + part + '.js');
    assert.ok(text.split('\n').length < 900, part);
    assert.match(text, new RegExp('^// ── ' + part + ': [^\\n]+ ──\\n// (Owns|Uses) '), part);
    assert.match(text, /\nCDA_API\.\w+ = \w+;\n$/, part + ' registers on CDA_API at its end');
    for (const m of text.matchAll(/^function (\w+)/gm)) assert.match(m[1], /^cda[A-Z]/, part + ': ' + m[1]);
    for (const m of text.matchAll(/^var (\w+)/gm)) assert.match(m[1], /^CDA_[A-Z_]+$/, part + ': ' + m[1]);
  }
  for (const part of ['ui-text', 'ui-layout']) {
    assert.doesNotMatch(readRepoFile(GAME + '/src/' + part + '.js').replace(/'(?:[^'\\\n]|\\.)*'/g, '\'\'').replace(/\/\/[^\n]*/g, ''),
      /\bdocument\b|\bwindow\b|requestAnimationFrame/, part + ' is pure');
  }
  assert.match(JS, /\} else if \(document\.readyState === 'loading'\) \{\n\s+document\.addEventListener\('DOMContentLoaded', cdaInit\);\n\s+\} else \{\n\s+cdaInit\(\);\n\s+\}/);
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/], ['template literal', /`/],
    ['double-quoted string', /"/], ['spread or rest', /\.\.\./], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['newer methods', /\.(padStart|padEnd|includes|find|findIndex|flat|flatMap|fill|assign|entries|values|repeat|startsWith|endsWith|append|prepend|replaceChildren)\(/],
    ['Math.random', /Math\.random/], ['timers and clocks', /setTimeout|setInterval|Date\b|performance\./]
  ]) {
    assert.doesNotMatch(CODE, re, name);
  }
});

test('cold-aisle ui source: index.html: one frame holds the game; outside it only the title, the narrow notice and the guide', () => {
  const spec = htmlPageSpec(HTML);
  const inside = (id, top) => {
    for (let at = spec[id].parent; at; at = spec[at].parent) if (at === top) return true;
    return false;
  };
  assert.equal(spec['cda-frame'].parent, 'cda-holder');
  assert.equal(spec['cda-stage'].parent, 'cda-frame');
  for (const id of Object.keys(spec)) {
    if (['cda-narrow', 'cda-holder', 'cda-frame', 'cda-guide'].includes(id)) continue;
    assert.ok(inside(id, 'cda-frame') || inside(id, 'cda-guide'), id + ' is in the frame or the guide');
  }
  for (const id of ['cda-canvas', 'cda-hud', 'cda-live', 'cda-gate', 'cda-title-screen', 'cda-select', 'cda-briefing', 'cda-pause', 'cda-death',
    'cda-results', 'cda-upgrades', 'cda-end', 'cda-help', 'cda-confirm', 'cda-warning']) {
    assert.equal(spec[id].parent, 'cda-stage', id + ' is laid over the view');
  }
  // the live region is never inside a screen or the HUD, which hide: it sits on the stage itself
  assert.equal(spec['cda-live'].parent, 'cda-stage');
  assert.equal(spec['cda-live'].attributes['aria-live'], 'polite');
  assert.equal(spec['cda-guide'].tagName, 'details');
  assert.equal(spec['cda-guide'].attributes.open, '', 'the guide is open by default');
  const canvas = spec['cda-canvas'];
  assert.deepEqual([canvas.width, canvas.height], [320, 180]);
  assert.equal(canvas.attributes.tabindex, '-1', 'in the tab order only while the level is live (the script sets it)');
  assert.equal(canvas.attributes.role, 'application');
  for (const key of ['W and S', 'Up and Down', 'A and D', 'Left and Right', 'mouse', 'J or Enter', 'E or Space', '1 to 3', 'wheel', 'Tab', 'P or Esc', 'F', 'M']) {
    assert.ok(canvas.attributes['aria-label'].includes(key), key);
  }
  assert.doesNotMatch(canvas.attributes['aria-label'], /Ctrl/);
  const buttons = Array.from(HTML.matchAll(/<button\b[^>]*>/g), (m) => m[0]);
  assert.ok(buttons.length >= 25);
  for (const b of buttons) {
    assert.match(b, /type="button"/, b);
    assert.match(b, /aria-label="[^"]+"/, b);
  }
  assert.equal(spec['cda-narrow'].textContent, 'Cold Aisle needs a keyboard, a mouse and a window at least 720 px wide.');
  // every screen starts hidden; the script shows the title
  for (const id of ['cda-hud', 'cda-gate', 'cda-title-screen', 'cda-select', 'cda-pause', 'cda-help', 'cda-confirm', 'cda-warning']) {
    assert.match(spec[id].className, /\bcda-hidden\b/, id);
  }
  assert.equal(spec['cda-sens'].attributes.min, '0.25');
  assert.equal(spec['cda-sens'].attributes.max, '3');
});

test('cold-aisle ui source: below 720 px the notice replaces the game and the guide stays; from 320 px up nothing is wider than the column', () => {
  for (const [vw, narrow] of [[320, true], [375, true], [719, true], [720, false], [1280, false]]) {
    assert.equal(declsAt(RULES, W('.cda-narrow'), vw).display, narrow ? 'block' : 'none', vw + ' px: the notice');
    assert.equal(declsAt(RULES, W('.cda-holder'), vw).display, narrow ? 'none' : undefined, vw + ' px: the game');
    assert.equal(declsAt(RULES, W('.cda-guide'), vw).display, undefined, vw + ' px: the guide shows');
  }
  assert.equal(declsAt(RULES, '.cda-wrapper', 320).padding, '20px 12px');
  assert.equal(declsAt(RULES, '.cda-wrapper', 1280)['max-width'], '1000px');
  assert.equal(declsAt(RULES, '.cda-wrapper', 320)['overflow-wrap'], 'break-word');
  // outside the stage (hidden below 720 px) no rule asks for more than a
  // 320 px window's column (296 px)
  for (const rule of RULES) {
    if (rule.keyframes || rule.minWidth > 320 || rule.maxWidth < 320) continue;
    for (const selector of rule.selectors) {
      for (const prop of ['width', 'min-width', 'flex-basis']) {
        const value = rule.decls[prop];
        if (!value || !/^\d+px$/.test(value)) continue;
        const stage = /cda-(stage|frame|hud|icon|msg|screen|overlay|panel|level|upgrade|warning|canvas)/.test(selector);
        if (stage) continue;
        assert.ok(px(value) <= 296, selector + ' ' + prop + ' ' + value);
      }
    }
  }
  assert.equal(declsAt(RULES, W('.cda-guide-keys'), 320)['table-layout'], 'fixed');
  assert.equal(declsAt(RULES, W('.cda-guide-text'), 320)['min-width'], '0');
});

test('cold-aisle ui source: the stage: a pixelated canvas filling it, screens and overlays over it that scroll inside, sizes that follow --cda-scale, black in fullscreen', () => {
  const canvas = declsAt(RULES, W('.cda-canvas'), 1280);
  assert.deepEqual([canvas.display, canvas.width, canvas.height, canvas['image-rendering']], ['block', '100%', '100%', 'pixelated']);
  const stage = declsAt(RULES, W('.cda-stage'), 1280);
  assert.deepEqual([stage.position, stage.overflow, stage['--cda-scale']], ['relative', 'hidden', '3']);
  assert.match(stage['font-size'], /var\(--cda-scale\)/);
  assert.equal(stage['max-width'], undefined, 'no cap: the script\'s width fills the column');
  assert.equal(declsAt(RULES, W('.cda-frame--full .cda-stage'), 1280)['max-width'], undefined);
  const holder = declsAt(RULES, W('.cda-holder'), 1280);
  assert.deepEqual([holder['min-width'], holder.contain], ['0', 'inline-size'], 'the stage\'s pixel width never holds a host grid or flex column open');
  for (const selector of ['.cda-screen', '.cda-overlay', '.cda-hud']) {
    const d = declsAt(RULES, W(selector), 1280);
    assert.deepEqual([d.position, d.left, d.top, d.right, d.bottom], ['absolute', '0', '0', '0', '0'], selector + ' fills the stage');
  }
  assert.equal(declsAt(RULES, W('.cda-screen'), 1280)['overflow-y'], 'auto');
  assert.equal(declsAt(RULES, W('.cda-hud'), 1280)['pointer-events'], 'none', 'the HUD never takes a click');
  assert.match(declsAt(RULES, W('.cda-icon'), 1280).width, /var\(--cda-scale\)/);
  assert.equal(declsAt(RULES, W('.cda-icon'), 1280)['image-rendering'], 'pixelated');
  assert.equal(declsAt(RULES, W('.cda-guide-sprite'), 1280)['image-rendering'], 'pixelated');
  assert.equal(declsAt(RULES, W('.cda-frame--full'), 1280).background, '#000');
  assert.equal(declsAt(RULES, W('.cda-frame:fullscreen'), 1280).background, '#000');
  assert.equal(declsAt(RULES, W('.cda-hidden'), 1280).display, 'none !important');
  assert.ok(declsAt(RULES, W('.cda-hud--low .cda-hud-health'), 1280).animation, 'low health pulses');
});

test('cold-aisle ui source: a host theme\'s button and heading styles never reach the game; the cursor hides over a live level', () => {
  const reset = { 'text-transform': 'none', 'letter-spacing': 'normal', 'text-shadow': 'none' };
  for (const selector of ['.cda-btn', '.cda-level', '.cda-screen-title', '.cda-guide-heading']) {
    const d = declsAt(RULES, W(selector), 1280);
    for (const [prop, want] of Object.entries(reset)) assert.equal(d[prop], want, selector + ' ' + prop);
    for (const prop of ['margin', 'line-height', 'font-weight']) assert.ok(d[prop] !== undefined, selector + ' sets ' + prop);
  }
  for (const selector of ['.cda-btn', '.cda-level']) {
    const d = declsAt(RULES, W(selector), 1280);
    assert.deepEqual([d.margin, d['min-height'], d['box-shadow']], ['0', '0', 'none'], selector);
  }
  assert.equal(declsAt(RULES, W('.cda-title'), 1280)['text-transform'], 'none');
  assert.equal(declsAt(RULES, W('.cda-stage--live'), 1280).cursor, 'none');
});

// The live host's theme rules that reach elements inside the game (measured
// on the WordPress page; the button states are assumed, their declarations
// could not be listed).
const THEME_RULES = [
  { selector: '.entry-content h2::before', props: ['content'] },
  { selector: '.entry-content h3::before', props: ['content'] },
  { selector: '.entry-content ul li::before', props: ['content'] },
  { selector: 'label::before', props: ['content'] },
  { selector: 'label', props: ['display', 'font-size', 'color', 'margin-bottom', 'letter-spacing'] },
  { selector: 'h1, h2, h3, h4, h5, h6', props: ['font-family', 'font-weight', 'color', 'line-height', 'letter-spacing'] },
  { selector: 'h1', props: ['font-size'] },
  { selector: 'h2', props: ['font-size'] },
  { selector: 'h3', props: ['font-size'] },
  { selector: '.entry-content h2', props: ['margin-top', 'margin-bottom', 'font-size'] },
  { selector: '.entry-content h3', props: ['margin-top', 'margin-bottom', 'font-size'] },
  { selector: 'p', props: ['margin-bottom', 'color'] },
  { selector: 'p:last-child', props: ['margin-bottom'] },
  { selector: 'strong, b', props: ['color', 'font-weight'] },
  { selector: 'ul, ol', props: ['list-style'] },
  { selector: '.entry-content ul, .entry-content ol', props: ['padding-left', 'margin-bottom'] },
  { selector: '.entry-content li', props: ['color', 'margin-bottom'] },
  { selector: 'table', props: ['width', 'border-collapse', 'margin-bottom', 'font-size'] },
  { selector: 'th', props: ['background', 'color', 'font-weight', 'padding', 'text-align', 'border-bottom'] },
  { selector: 'td', props: ['padding', 'border-bottom', 'color'] },
  { selector: '.button, button, input[type="submit"]', props: ['background', 'border', 'color', 'font-family', 'font-size', 'padding', 'transition'] },
  { selector: 'button:hover, button:focus, button:active', props: ['background', 'border-color', 'color', 'box-shadow', 'transform', 'outline'] }
];

// The shorthands that also set a longhand.
const SHORTHANDS = {
  'margin-top': ['margin'], 'margin-bottom': ['margin'], 'padding-left': ['padding'], 'border-bottom': ['border'],
  'border-color': ['border'], 'list-style': [], background: []
};

// [ids, classes, types] of one selector (:not counts its argument).
const specificity = (selector) => {
  const s = selector.replace(/:not\(([^)]*)\)/g, ' $1');
  return [
    (s.match(/#[\w-]+/g) || []).length,
    (s.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g) || []).length,
    (s.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) || []).length + (s.match(/::[\w-]+/g) || []).length
  ];
};
const above = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

// Every element of the embedded markup and every element the script makes:
// its tag, classes, the classes of its ancestors and its type attribute.
const GAME_ELEMENTS = (() => {
  const out = [];
  const stack = [];
  for (const m of embedMarkup(HTML).matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/g)) {
    if (m[1]) {
      while (stack.length && stack.pop().tag !== m[2]) { /* unwind */ }
      continue;
    }
    const classes = ((/class="([^"]*)"/.exec(m[3]) || [])[1] || '').split(/\s+/).filter(Boolean);
    const el = { tag: m[2], classes, ancestors: stack.flatMap((a) => a.classes).reverse(), type: (/type="([^"]*)"/.exec(m[3]) || [])[1] };
    out.push(el);
    if (!/^(input|img|br|hr|meta|link|source|wbr)$/.test(m[2])) stack.push(el);
  }
  for (const m of UI.matchAll(/cdaMake\('(\w+)', '([^']*)'/g)) out.push({ tag: m[1], classes: m[2].split(/\s+/), ancestors: [], type: undefined });
  for (const m of UI.matchAll(/cdaButton\('([^']*)'/g)) out.push({ tag: 'button', classes: m[1].split(/\s+/), ancestors: [], type: 'button' });
  return out;
})();

// Does a theme selector's subject (its last compound, pseudo-element and
// state pseudo-classes dropped) match the element?
const subjectMatches = (selector, el) => {
  const subject = selector.trim().split(/\s+/).pop().replace(/::?[\w-]+/g, '');
  const tag = (/^[a-z][\w-]*/i.exec(subject) || [])[0];
  if (tag && tag !== el.tag) return false;
  for (const m of subject.matchAll(/\.([\w-]+)/g)) if (!el.classes.includes(m[1])) return false;
  for (const m of subject.matchAll(/\[type="([^"]+)"\]/g)) if (el.type !== m[1]) return false;
  return Boolean(tag) || /\./.test(subject);
};

test('cold-aisle ui source: the host theme: every theme rule that reaches a game element loses to the game\'s own value, and its ::before text is gone', () => {
  // the theme's ::before / ::after text is reset under the wrapper, except
  // on the elements whose pseudo-element the game draws itself
  const own = new Set();
  for (const rule of RULES) {
    for (const s of rule.selectors) {
      const m = /^\.cda-wrapper \.(cda-[\w-]+)::(before|after)$/.exec(s);
      if (m && rule.decls.content !== undefined && rule.decls.content !== 'none') own.add(m[1]);
    }
  }
  assert.deepEqual(Array.from(own), ['cda-stage--low'], 'the game\'s own pseudo-element content');
  const resets = RULES.filter((r) => r.decls.content === 'none' && !r.media).flatMap((r) => r.selectors);
  for (const pseudo of ['before', 'after']) {
    const reset = resets.find((s) => new RegExp('^\\.cda-wrapper (\\*|:not\\(([^)]*)\\))::' + pseudo + '$').test(s));
    assert.ok(reset, '::' + pseudo + ' content is reset under the wrapper');
    const kept = Array.from(reset.matchAll(/\.(cda-[\w-]+)/g), (m) => m[1]).slice(1);
    assert.deepEqual(kept.sort(), Array.from(own).sort(), reset + ' spares exactly the game\'s own');
    for (const theme of THEME_RULES.filter((t) => t.props.includes('content'))) {
      assert.ok(above(specificity(reset), specificity(theme.selector)), reset + ' beats ' + theme.selector);
    }
  }
  // every other property: some rule of the game's for that element declares it, more specific than the theme
  let checked = 0;
  for (const theme of THEME_RULES) {
    const props = theme.props.filter((p) => p !== 'content');
    if (!props.length) continue;
    for (const themeSelector of theme.selector.split(',').map((s) => s.trim())) {
      const themeSpec = specificity(themeSelector);
      for (const el of GAME_ELEMENTS.filter((e) => subjectMatches(themeSelector, e))) {
        const candidates = el.classes.map((c) => W('.' + c)).concat(el.ancestors.map((a) => W('.' + a + ' ' + el.tag)));
        for (const prop of props) {
          const names = [prop].concat(SHORTHANDS[prop] || []);
          const winning = candidates.filter((s) => names.some((n) => declsAt(RULES, s, 1280)[n] !== undefined) && above(specificity(s), themeSpec));
          assert.ok(winning.length, themeSelector + ' { ' + prop + ' } reaches <' + el.tag + ' class="' + el.classes.join(' ') + '">');
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 100, 'the fixture reached the game\'s elements: ' + checked);
});

test('cold-aisle ui source: inside a 1000 px wrapper with the host\'s 1 px border the stage still gets 960 px (the crisp 3x scale it snaps to)', () => {
  const d = declsAt(RULES, '.cda-wrapper', 1280);
  assert.equal(d['box-sizing'], 'border-box');
  const sides = d.padding.split(/\s+/).map(px);
  const [right, left] = [sides[1] !== undefined ? sides[1] : sides[0], sides[3] !== undefined ? sides[3] : (sides[1] !== undefined ? sides[1] : sides[0])];
  const inner = px(d['max-width']) - 2 * 1 - left - right;
  assert.ok(inner >= 960, 'inner width ' + inner + ' px');
});

test('cold-aisle ui source: reduced motion stops the screens\' fade, the low-health pulse and the buttons\' transitions', () => {
  const reduce = { matchMedia: (q) => /prefers-reduced-motion: reduce/.test(q) };
  for (const selector of ['.cda-screen', '.cda-overlay', '.cda-hud--low .cda-hud-health']) {
    assert.ok(declsAt(RULES, W(selector), 1280).animation !== 'none', selector + ' moves by default');
    assert.equal(declsAt(RULES, W(selector), 1280, reduce).animation, 'none', selector);
  }
  assert.equal(declsAt(RULES, W('.cda-btn'), 1280, reduce).transition, 'none');
});
