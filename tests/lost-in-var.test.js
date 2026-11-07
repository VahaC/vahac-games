// tests/lost-in-var.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const posix = require('node:path').posix;
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, focusElement, setVisibility, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'lost-in-var';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

// The pure functions (the start-up code does not run under Node).
const liv = loadScript(SCRIPT);
const [TUTORIAL, DISK, PORT] = liv.livCases;

const STATE_KEY = 'liv-state';
const PROGRESS_KEY = 'liv-progress';

// Friday 2026-11-06, 09:00 local time.  The game reads no clock; Date is
// mocked anyway so nothing depends on the day the tests run.
const NOV6 = new Date(2026, 10, 6, 9, 0, 0).getTime();

// A liv-state in the format the first published version writes: case 2 on
// screen in /var/tmp after 4 commands, one hint and a wrong kill; case 1
// half done; case 3 untouched.
const SAMPLE_STATE = '{"v":1,"case":"disk-full","sessions":{' +
  '"tutorial":{"cwd":"/var/log","killed":[],"done":[0,1,2],"history":["ls","cat welcome.txt","cd /var/log"],"commands":3,"hints":0},' +
  '"disk-full":{"cwd":"/var/tmp","killed":[2290],"done":[],"history":["df -h","cd /var/tmp","ls -lh","kill 2290"],"commands":4,"hints":1},' +
  '"port-clash":{"cwd":"/home/deploy","killed":[],"done":[],"history":[],"commands":0,"hints":0}}}';
// A liv-progress of the same version: the tutorial solved with 97 points.
const SAMPLE_PROGRESS = '{"v":1,"cases":{"tutorial":{"score":97,"commands":9,"hints":0}}}';

test.beforeEach(() => resetStubs());

// ── Helpers ──────────────────────────────────────────────────────────────────

const world = (data, cwd = data.home, killed = []) => ({ cwd, killed, done: [] });
const texts = (result) => result.out.map((item) => item.t);
const kinds = (result) => result.out.map((item) => item.k);

// One command function called directly: cmd('Ls', TUTORIAL, ['-l'], { cwd: '/' }).
function cmd(name, data, args, { cwd, killed, stdin = null } = {}) {
  return liv['livCmd' + name]({ data, world: world(data, cwd, killed), args, stdin });
}

// A small case of its own for corners the three real cases do not have: an
// unreadable file and folder the user owns, and a process with nothing to say
// when it stops.
const EDGE = {
  id: 'edge', title: 'Edge', host: 'edge-01', user: 'me', home: '/home/me', shellPid: 10, psPid: 99, time: 'Nov  6 00:00',
  motd: [], brief: '', goals: [{ text: 'stop 20', test: { killed: 20 } }], hints: [], par: 1, win: [],
  dirs: { '/home/me': { owner: 'me' }, '/locked': { owner: 'me', mode: 'd---------' } },
  files: { '/home/me/a.txt': { owner: 'me', lines: ['x'] }, '/home/me/secret': { owner: 'me', mode: '----------', lines: ['s'] } },
  procs: [{ pid: 10, user: 'me', cpu: 0, mem: 0, cmd: '-bash' }, { pid: 20, user: 'me', cpu: 1, mem: 1, cmd: 'quiet' }],
  mounts: [{ fs: 'disk', size: 1024, used: 0, mount: '/' }]
};

// ── Independent models ───────────────────────────────────────────────────────

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Paths: Node's own POSIX resolver after the ~ expansion bash does.
function resolveModel(cwd, home, input) {
  const expanded = input === '~' || input.startsWith('~/') ? home + input.slice(1) : input;
  return posix.resolve(cwd, expanded);
}

// ls -h / df -h sizes in exact integer arithmetic (BigInt): round up, one
// decimal below 10 of a unit.
function humanModel(bytes) {
  if (bytes < 1024) return String(bytes);
  const units = ['K', 'M', 'G', 'T'];
  const b = BigInt(bytes);
  let k = 0;
  let div = 1024n;
  while (k < 3 && b >= div * 1024n) {
    div *= 1024n;
    k++;
  }
  if (b * 10n < div * 100n) {
    const tenths = (b * 10n + div - 1n) / div;
    return tenths >= 100n ? '10' + units[k] : (Number(tenths) / 10).toFixed(1) + units[k];
  }
  const whole = (b + div - 1n) / div;
  return whole >= 1024n && k < 3 ? '1.0' + units[k + 1] : String(whole) + units[k];
}

// A shell word splitter written from the bash rules the game follows.
function parseModel(line) {
  const stages = [];
  let argv = [];
  let glob = [];
  let cur = null;
  let g = false;
  const flush = () => {
    if (cur !== null) {
      argv.push(cur);
      glob.push(g);
    }
    cur = null;
    g = false;
  };
  for (let i = 0; i < line.length;) {
    const c = line[i];
    if (c === '\'') {
      const end = line.indexOf('\'', i + 1);
      if (end < 0) return { error: 'bash: unexpected EOF while looking for matching `\'\'' };
      cur = (cur === null ? '' : cur) + line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && (line[j + 1] === '"' || line[j + 1] === '\\')) {
          s += line[j + 1];
          j += 2;
        } else {
          s += line[j++];
        }
      }
      if (j >= line.length) return { error: 'bash: unexpected EOF while looking for matching `"\'' };
      cur = (cur === null ? '' : cur) + s;
      i = j + 1;
    } else if (c === '\\') {
      cur = (cur === null ? '' : cur) + (i + 1 < line.length ? line[i + 1] : '');
      i += 2;
    } else if (c === ' ' || c === '\t') {
      flush();
      i++;
    } else if (c === '|') {
      flush();
      if (!argv.length) return { error: 'bash: syntax error near unexpected token `|\'' };
      stages.push({ argv, glob });
      argv = [];
      glob = [];
      i++;
    } else if (';&><`'.includes(c)) {
      return { error: 'bash: ' + c + ': not available here: one command per line, with | only into grep or tail' };
    } else {
      cur = (cur === null ? '' : cur) + c;
      g = g || c === '*' || c === '?';
      i++;
    }
  }
  flush();
  if (argv.length) stages.push({ argv, glob });
  else if (stages.length) return { error: 'bash: syntax error near unexpected token `|\'' };
  return { stages };
}

// The names below a folder of a case, straight from its data: { name, dir }.
function namesBelow(data, dir, killed = []) {
  const removed = new Set(data.procs.filter((p) => killed.includes(p.pid)).flatMap((p) => p.removes || []));
  const all = Object.keys(data.files).filter((p) => !removed.has(p)).concat(Object.keys(data.dirs));
  const prefix = dir === '/' ? '/' : dir + '/';
  const found = new Map();
  for (const path of all) {
    if (!path.startsWith(prefix) || path.length === prefix.length) continue;
    const rest = path.slice(prefix.length);
    const name = rest.split('/')[0];
    const isDir = rest.includes('/') || hasOwn(data.dirs, prefix + name);
    found.set(name, (found.get(name) || false) || isDir);
  }
  return [...found.keys()].sort().map((name) => ({ name, dir: found.get(name) }));
}

// Every folder of a case (listed ones and the ones its files imply).
function allDirs(data) {
  const dirs = new Set(['/']);
  for (const path of Object.keys(data.files).concat(Object.keys(data.dirs))) {
    const parts = path.split('/').filter(Boolean);
    const upto = hasOwn(data.dirs, path) ? parts.length : parts.length - 1;
    for (let i = 1; i <= upto; i++) dirs.add('/' + parts.slice(0, i).join('/'));
  }
  return [...dirs].sort();
}

// The points of a run.
const scoreModel = (par, commands, hints, mistakes) => Math.max(10, 100 - 3 * Math.max(0, commands - par) - 10 * hints - 25 * mistakes);

// ── Pages ────────────────────────────────────────────────────────────────────

function enableClock(t) {
  const go = () => t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: NOV6 });
  try {
    go();
  } catch (error) {
    t.mock.timers.reset(); // a second page in the same test
    go();
  }
}

function writeStorage(storage = {}) {
  for (const [key, value] of [[STATE_KEY, storage.state], [PROGRESS_KEY, storage.progress]]) {
    if (value !== undefined) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

// What a player sees and does.
function view(b) {
  const els = b.els;
  const input = els['liv-input'];
  return {
    els,
    input,
    page: b.page,
    ready: b.ready,
    restore: b.restore,
    el: (name) => els['liv-' + name],
    text: (name) => els['liv-' + name].textContent,
    hidden: (name) => els['liv-' + name].classList.contains('liv-hidden'),
    // Types a line into the command field and presses Enter there.
    type(line, props) {
      focusElement(input, { keyboard: true });
      input.value = line;
      return pressKey('Enter', Object.assign({ target: input }, props));
    },
    key(key, props) {
      focusElement(input, { keyboard: true });
      return pressKey(key, Object.assign({ target: input }, props));
    },
    click: (name) => els['liv-' + name].click(),
    screen: () => els['liv-screen'].children.map((el) => el.textContent),
    lines: () => els['liv-screen'].children.map((el) => [el.className, el.textContent]),
    chip: (label) => els['liv-chips'].children.find((el) => el.textContent === label),
    names: () => els['liv-names'].children.map((el) => el.textContent),
    tapName: (name) => els['liv-names'].children.find((el) => el.textContent === name).click(),
    cases: () => els['liv-cases'].children,
    goals: () => els['liv-goals'].children.map((li) => [li.className, li.children[1].textContent]),
    toast: () => (els['liv-toast'].classList.contains('liv-show') ? els['liv-toast'].textContent : null),
    state: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    progress: () => JSON.parse(localStorage.getItem(PROGRESS_KEY))
  };
}

function boot(options) {
  return view(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options));
}

// The page as a browser loads it, after writing storage, with mocked timers
// and Math.random.
function openPage(t, { storage, options } = {}) {
  enableClock(t);
  t.mock.method(Math, 'random', seeded(1));
  writeStorage(storage);
  return boot(options);
}

// A reload: the old page and its timers go away, storage stays.
function reload(t, v) {
  t.mock.timers.reset();
  enableClock(t);
  v.restore();
  return boot();
}

// Another tab wrote key: storage holds value and this tab gets the event.
function otherTab(key, value) {
  localStorage.setItem(key, value);
  return fire(window, 'storage', { key, newValue: value });
}

function stateWith(changes) {
  const state = JSON.parse(liv.livSerializeState(liv.livParseState(null)));
  for (const [id, session] of Object.entries(changes.sessions || {})) Object.assign(state.sessions[id], session);
  if (changes.case) state.case = changes.case;
  return JSON.stringify(state);
}

// Every element of the page tree under node.
function walk(node, out = []) {
  for (const child of node.children || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

// A CSS length in px (px, or rem at 16 px).
function len(value) {
  const m = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(String(value).trim());
  assert.ok(m, 'a px or rem length: ' + value);
  return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
}

// The left / right part of a padding shorthand, in px.
function sidePad(padding) {
  const parts = String(padding).trim().split(/\s+/);
  return len(parts.length > 1 ? parts[1] : parts[0]);
}

// ── Files ────────────────────────────────────────────────────────────────────

test('lost-in-var: every id the script looks up is in index.html once; ids, classes, CSS variables, storage keys and exports are liv- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'liv-brief', 'liv-case-title', 'liv-cases', 'liv-chips', 'liv-complete', 'liv-goals', 'liv-hint', 'liv-hints',
    'liv-hist-down', 'liv-hist-up', 'liv-input', 'liv-names', 'liv-names-row', 'liv-next', 'liv-prompt', 'liv-restart',
    'liv-run', 'liv-score', 'liv-screen', 'liv-status', 'liv-term-title', 'liv-toast', 'liv-warning'
  ]);
  assert.equal(ids.length, new Set(ids).size, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  for (const id of ids) assert.ok(htmlIds.includes(id), id);
  for (const id of htmlIds) assert.match(id, /^liv-/);

  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^liv-/);
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^liv-/, selector);
    }
  }
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)\s*:/g)) assert.match(m[1], /^liv-/);
  for (const m of CSS.matchAll(/var\(--([\w-]+)/g)) assert.match(m[1], /^liv-/);
  assert.doesNotMatch(JS, /setProperty|var\(--/, 'the script sets no CSS variables');
  for (const m of CSS.matchAll(/@keyframes\s+([\w-]+)/g)) assert.match(m[1], /^liv-/);
  // Storage: the two keys, and nothing else is ever written.
  assert.deepEqual([...new Set(Array.from(JS.matchAll(/'(liv-(?:state|progress))'/g), (m) => m[1]))].sort(), ['liv-progress', 'liv-state']);
  assert.deepEqual(Array.from(JS.matchAll(/localStorage\.(\w+)\(/g), (m) => m[1]).sort(), ['getItem', 'setItem']);
  // Every class name the script writes starts with liv-.
  for (const m of JS.matchAll(/'(liv-[\w-]*)'/g)) assert.match(m[1], /^liv-/);
  for (const name of Object.keys(liv)) assert.match(name, /^liv[A-Z]/);
});

test('lost-in-var: the files embed safely, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="liv-wrapper"'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');
  const bg = CSS.match(/--liv-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Lost in \/var — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  // One script, at the end of the body; no external resources at all.
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(|<a\b/i, 'no network resources or links');
  }
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|Math\.random)\b/, 'no network calls, nothing random');
});

test('lost-in-var: script.js is one strict IIFE in ES5', () => {
  assert.match(JS, /^(\/\/[^\n]*\r?\n)*\r?\n?\(function \(\) \{\r?\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1);
  assert.equal(JS.match(/^\}\)\(\);/gm).length, 1);
  const code = JS
    .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['double-quoted string', /"/],
    ['ES2015+ library calls', /\.(includes|startsWith|endsWith|padStart|padEnd|repeat|find|findIndex|assign)\(|Object\.(assign|entries|values)\b|Array\.from\b|Number\.isInteger\b/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('lost-in-var: index.html has a labelled command field, a terminal log, labelled buttons and the status regions', () => {
  const spec = htmlPageSpec(HTML);
  const field = spec['liv-input'].attributes;
  assert.equal(spec['liv-input'].tagName, 'input');
  assert.equal(field.type, 'text');
  assert.equal(field.maxlength, '300');
  assert.equal(field.autocomplete, 'off');
  assert.equal(field.autocapitalize, 'none');
  assert.equal(field.autocorrect, 'off');
  assert.equal(field.spellcheck, 'false');
  assert.equal(field['aria-label'], 'Shell command');
  assert.equal(spec['liv-prompt'].tagName, 'label');
  assert.equal(spec['liv-prompt'].attributes.for, 'liv-input');
  assert.equal(spec['liv-screen'].attributes.role, 'log');
  assert.equal(spec['liv-screen'].attributes.tabindex, '0', 'keyboard users can scroll the terminal');
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
    }
  }
  assert.equal(spec['liv-status'].attributes['aria-live'], 'polite');
  assert.equal(spec['liv-toast'].attributes['aria-live'], 'polite');
  assert.equal(spec['liv-warning'].attributes.role, 'alert');
  for (const id of ['liv-warning', 'liv-next', 'liv-names-row', 'liv-hints']) assert.match(spec[id].className, /\bliv-hidden\b/, id);
  assert.equal(spec['liv-names'].parent, 'liv-names-row');
});

test('lost-in-var: from 320 to 1440 px nothing widens the page: cases, keys and chips share the width, long lines wrap, and the field keeps 16 px', () => {
  const rules = cssRules(CSS);
  const labels = ['↑', '↓', 'Tab', 'Run ↵'];
  assert.deepEqual(['liv-hist-up', 'liv-hist-down', 'liv-complete', 'liv-run'].map((id) => htmlPageSpec(HTML)[id].textContent), labels);
  const words = LIVE_WORDS();
  for (let vw = 320; vw <= 1440; vw++) {
    const wrapper = declsAt(rules, '.liv-wrapper', vw);
    const side = sidePad(wrapper.padding);
    const available = Math.min(vw, len(wrapper['max-width'])) - 2 * side;
    assert.equal(declsAt(rules, '.liv-wrapper *', vw)['box-sizing'], 'border-box');

    // Three case buttons in equal columns that may shrink; their lines stack from the top.
    const cases = declsAt(rules, '.liv-cases', vw);
    assert.equal(cases['grid-template-columns'], 'repeat(3, minmax(0, 1fr))');
    const button = declsAt(rules, '.liv-case-btn', vw);
    assert.deepEqual([button.display, button['flex-direction'], button['align-items'], button['justify-content'], button['min-width']],
      ['flex', 'column', 'flex-start', 'flex-start', '0']);
    const content = (available - 2 * len(cases.gap)) / 3 - 2 * sidePad(button.padding) - 2;
    for (const [selector, list] of [['.liv-case-name', words.names], ['.liv-case-meta', words.metas], ['.liv-case-num', ['CASE 3']]]) {
      const decls = declsAt(rules, selector, vw);
      const char = 0.62 * len(decls['font-size']);
      for (const word of list) assert.ok(word.length * char <= content, vw + 'px: "' + word + '" in a ' + content + 'px case button');
      assert.equal(decls['max-width'], '100%', selector);
    }
    assert.equal(declsAt(rules, '.liv-case-name', vw)['overflow-wrap'], 'anywhere');
    assert.equal(declsAt(rules, '.liv-case-meta', vw)['overflow-wrap'], 'anywhere');

    // Four shell keys in equal columns, each label inside its key.
    const keys = declsAt(rules, '.liv-keys', vw);
    assert.equal(keys['grid-template-columns'], 'repeat(4, minmax(0, 1fr))');
    const key = Object.assign({}, declsAt(rules, '.liv-btn', vw), declsAt(rules, '.liv-btn--key', vw));
    assert.equal(key['min-width'], '0');
    const keyContent = (available - 3 * len(keys.gap)) / 4 - 2 * len(key.padding) - 2;
    for (const label of labels) assert.ok(label.length * 0.62 * len(key['font-size']) <= keyContent, vw + 'px: ' + label);
    assert.ok(len(key['min-height']) >= 44, 'keys are big enough to tap');

    // The terminal wraps its lines and never scrolls sideways.
    const line = declsAt(rules, '.liv-line', vw);
    assert.equal(line['white-space'], 'pre-wrap');
    assert.equal(line['overflow-wrap'], 'anywhere');
    assert.equal(declsAt(rules, '.liv-screen', vw)['overflow-x'], 'hidden');
    assert.equal(declsAt(rules, '.liv-terminal', vw)['min-width'], '0');
    // The prompt wraps above the field when both do not fit; the field keeps 16 px (iOS zooms into smaller ones).
    const row = declsAt(rules, '.liv-input-row', vw);
    assert.equal(row['flex-wrap'], 'wrap');
    const field = declsAt(rules, '.liv-input', vw);
    assert.ok(len(field['font-size']) >= 16, vw + 'px: field font ' + field['font-size']);
    assert.equal(field['min-width'], '0');
    assert.ok(len(field.flex.split(/\s+/)[2]) <= available - 2 * sidePad(row.padding) - 2, vw + 'px: the field fits its row');
    const prompt = declsAt(rules, '.liv-prompt', vw);
    assert.deepEqual([prompt['max-width'], prompt['min-width'], prompt['overflow-wrap']], ['100%', '0', 'anywhere']);

    // Chips wrap in their rows, and a long name wraps inside its chip.
    for (const selector of ['.liv-chips', '.liv-names', '.liv-names-row', '.liv-brief-actions', '.liv-goal', '.liv-hint-item']) {
      assert.equal(declsAt(rules, selector, vw)['flex-wrap'], 'wrap', selector);
    }
    const chip = declsAt(rules, '.liv-chip', vw);
    assert.deepEqual([chip['max-width'], chip['white-space'], chip['overflow-wrap']], ['100%', 'normal', 'anywhere']);
    assert.ok(len(chip['min-height']) >= 36);
    assert.equal(declsAt(rules, '.liv-brief-actions .liv-btn', vw)['white-space'], 'normal');
    assert.equal(declsAt(rules, '.liv-btn', vw)['max-width'], '100%');
    for (const selector of ['.liv-goal-text', '.liv-hint-text']) assert.equal(declsAt(rules, selector, vw)['min-width'], '0');
    for (const selector of ['.liv-status', '.liv-warning', '.liv-score', '.liv-brief-text', '.liv-case-title', '.liv-term-title', '.liv-toast']) {
      assert.equal(declsAt(rules, selector, vw)['overflow-wrap'], 'anywhere', selector);
    }
  }
  assert.equal(declsAt(rules, '.liv-input', 320)['font-size'], '16px', 'in px, so a host page with a small root font cannot shrink it');
  // .liv-hidden comes after every rule that gives an element it hides a display, so it wins.
  const hiddenAt = rules.findIndex((rule) => rule.selectors.includes('.liv-hidden'));
  assert.equal(rules[hiddenAt].decls.display, 'none');
  rules.forEach((rule, i) => {
    if (rule.decls.display && rule.selectors.some((s) => ['.liv-names-row', '.liv-warning', '.liv-hints', '.liv-btn', '.liv-btn--next'].includes(s))) {
      assert.ok(i < hiddenAt, rule.selectors.join(', ') + ' comes before .liv-hidden');
    }
  });
  assert.equal(declsAt(rules, '.liv-toast', 320)['max-width'], 'calc(100vw - 32px)');
  assert.equal(declsAt(rules, '.liv-wrapper', 320).padding, '16px 8px');
  assert.equal(declsAt(rules, '.liv-wrapper', 1280).padding, '32px 16px');
  // Taps never zoom the page; no element takes the page's own gestures.
  const touch = rules.filter((rule) => rule.decls['touch-action'] !== undefined);
  assert.deepEqual(touch.map((rule) => [rule.selectors, rule.decls['touch-action']]),
    [[['.liv-btn'], 'manipulation'], [['.liv-case-btn'], 'manipulation'], [['.liv-chip'], 'manipulation']]);
});

// The words a case button can show, for the layout check.
function LIVE_WORDS() {
  const names = liv.livCases.flatMap((data) => data.title.split(' '));
  const metas = ['Solved:', '100', 'points', 'In', 'progress:', '99999', 'commands', 'New'];
  return { names, metas };
}

// The WCAG 2 relative luminance of #rgb or #rrggbb, and the contrast ratio of two colours.
function luminance(hex) {
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('lost-in-var: small text keeps a 4.5:1 contrast: labels on the cards and the page, the terminal, and white on the green keys, buttons and toast', () => {
  assert.equal(contrast('#64748b', '#1a2236').toFixed(1), '3.3', 'the model: the old muted grey on a card');
  assert.equal(contrast('#fff', '#10b981').toFixed(1), '2.5', 'the model: white on the light green');
  const rules = cssRules(CSS);
  const tokens = declsAt(rules, '.liv-wrapper', 1280);
  const solid = (value) => {
    const m = /^var\((--liv-[\w-]+)\)$/.exec(String(value).trim());
    const hex = m ? tokens[m[1]] : String(value).trim();
    assert.match(String(hex), /^#([0-9a-f]{3}|[0-9a-f]{6})$/i, 'a solid colour: ' + value);
    return hex;
  };
  const get = (selector, prop, hover) => declsAt(rules, selector, 1280, hover ? { matchMedia: () => true } : undefined)[prop];
  // The page text sits on see-through cards over darker blues: the card colour is its lightest backdrop.
  const card = 'var(--liv-bg-card)';
  const onCard = ['.liv-case-num', '.liv-case-meta', '.liv-goal-mark', '.liv-goal--done .liv-goal-text', '.liv-hint-text', '.liv-score',
    '.liv-brief-text', '.liv-names-label', '.liv-footer', '.liv-status', '.liv-warning', '.liv-subtitle', '.liv-term-title', '.liv-btn--secondary'];
  const pairs = onCard.map((selector) => [selector, get(selector, 'color'), card]).concat([
    ['.liv-case-num on its button', get('.liv-case-num', 'color'), get('.liv-case-btn', 'background')],
    ['.liv-chip--name', get('.liv-chip--name', 'color'), get('.liv-chip', 'background')],
    ['.liv-chip--example', get('.liv-chip--example', 'color'), get('.liv-chip', 'background')],
    ['.liv-input::placeholder', get('.liv-input::placeholder', 'color'), get('.liv-input', 'background')],
    ['.liv-prompt', get('.liv-prompt', 'color'), get('.liv-input-row', 'background')],
    ['.liv-btn--key', get('.liv-btn', 'color'), get('.liv-btn--key', 'background')],
    ['.liv-btn--run', get('.liv-btn', 'color'), get('.liv-btn--run', 'background')],
    ['.liv-btn--next', get('.liv-btn', 'color'), get('.liv-btn--next', 'background')],
    ['.liv-btn--run:hover', get('.liv-btn', 'color'), get('.liv-btn--run:hover', 'background', true)],
    ['.liv-btn--next:hover', get('.liv-btn', 'color'), get('.liv-btn--next:hover', 'background', true)],
    ['.liv-btn', get('.liv-btn', 'color'), get('.liv-btn', 'background')],
    ['.liv-btn:hover', get('.liv-btn', 'color'), get('.liv-btn:hover', 'background', true)],
    ['.liv-toast', get('.liv-toast', 'color'), get('.liv-toast', 'background')]
  ], ['--out', '--err', '--sys', '--win', '--cmd'].map((kind) => ['.liv-line' + kind, get('.liv-line' + kind, 'color'), get('.liv-terminal', 'background')]));
  for (const [name, fg, bg] of pairs) {
    const ratio = contrast(solid(fg), solid(bg));
    assert.ok(ratio >= 4.5, name + ': ' + ratio.toFixed(2) + ':1');
  }
  assert.doesNotMatch(CSS, /var\(--liv-text-muted\)/, 'the muted grey is not used for text');
  assert.doesNotMatch(CSS, /gradient\([^)]*--liv-accent-green/, 'no white text on a gradient into the light green');
});

// ── Pure logic: parser, paths, sizes ─────────────────────────────────────────

test('lost-in-var: livParse splits words, quotes, escapes and pipes like bash, checked against an independent splitter on 3000 seeded lines', () => {
  assert.deepEqual(liv.livParse(''), { stages: [] });
  assert.deepEqual(liv.livParse('   '), { stages: [] });
  assert.deepEqual(liv.livParse('grep -i "No space" /var/log/*.log | tail -n 2'), {
    stages: [
      { argv: ['grep', '-i', 'No space', '/var/log/*.log'], glob: [false, false, false, true] },
      { argv: ['tail', '-n', '2'], glob: [false, false, false] }
    ]
  });
  assert.deepEqual(liv.livParse('cat \'a b\' c\\ d "e\\"f\\\\g\\n" \'\' x"y"z'), {
    stages: [{ argv: ['cat', 'a b', 'c d', 'e"f\\g\\n', '', 'xyz'], glob: [false, false, false, false, false, false] }]
  });
  assert.deepEqual(liv.livParse('ls\t-l'), { stages: [{ argv: ['ls', '-l'], glob: [false, false] }] });
  assert.deepEqual(liv.livParse('ls x\\'), { stages: [{ argv: ['ls', 'x'], glob: [false, false] }] }, 'a trailing backslash adds nothing');
  assert.deepEqual(liv.livParse('cat "*" \'?\' \\*'), { stages: [{ argv: ['cat', '*', '?', '*'], glob: [false, false, false, false] }] }, 'quoted wildcards stay literal');
  for (const line of ['| grep x', 'ps aux |', 'ps aux | | grep x', 'ps||grep']) {
    assert.deepEqual(liv.livParse(line), { error: 'bash: syntax error near unexpected token `|\'' }, line);
  }
  assert.deepEqual(liv.livParse('cat "abc'), { error: 'bash: unexpected EOF while looking for matching `"\'' });
  assert.deepEqual(liv.livParse('cat \'abc'), { error: 'bash: unexpected EOF while looking for matching `\'\'' });
  for (const c of [';', '&', '>', '<', '`']) {
    assert.deepEqual(liv.livParse('ls ' + c + ' x'), { error: 'bash: ' + c + ': not available here: one command per line, with | only into grep or tail' });
    assert.deepEqual(liv.livParse('echo "' + c + '"').stages[0].argv, ['echo', c], 'quoted ' + c + ' is text');
  }
  const random = seeded(42);
  const alphabet = ['a', 'b', ' ', '\t', '|', '\'', '"', '\\', '*', '?', ';', '-'];
  for (let n = 0; n < 3000; n++) {
    let line = '';
    const length = Math.floor(random() * 10);
    for (let i = 0; i < length; i++) line += alphabet[Math.floor(random() * alphabet.length)];
    assert.deepEqual(liv.livParse(line), parseModel(line), JSON.stringify(line));
  }
});

test('lost-in-var: livResolve follows ~, . and .. like a POSIX resolver, and the prompt shows the home folder as ~', () => {
  const random = seeded(7);
  const parts = ['a', 'b', '..', '.', '', '~', 'log'];
  for (let n = 0; n < 2000; n++) {
    const segments = Array.from({ length: Math.floor(random() * 5) }, () => parts[Math.floor(random() * parts.length)]);
    let input = segments.join('/');
    if (random() < 0.3) input = '/' + input;
    if (random() < 0.2) input = '~' + (input.startsWith('/') ? input : '/' + input);
    const cwd = ['/', '/var/log', '/home/ops'][n % 3];
    assert.equal(liv.livResolve(cwd, '/home/ops', input), resolveModel(cwd, '/home/ops', input), cwd + ' ' + JSON.stringify(input));
  }
  assert.equal(liv.livResolve('/var/log', '/home/ops', ''), '/var/log');
  assert.equal(liv.livResolve('/var', '/home/ops', '~'), '/home/ops');
  assert.equal(liv.livResolve('/var', '/home/ops', '~x'), '/var/~x', '~x is a plain name');
  assert.equal(liv.livPrompt(TUTORIAL, '/home/ops'), 'ops@training-01:~$');
  assert.equal(liv.livPrompt(TUTORIAL, '/home/ops/notes'), 'ops@training-01:~/notes$');
  assert.equal(liv.livPrompt(TUTORIAL, '/home/opsx'), 'ops@training-01:/home/opsx$');
  assert.equal(liv.livPrompt(PORT, '/var/log'), 'deploy@app-03:/var/log$');
});

test('lost-in-var: sizes round up like ls -h and df -h, checked in exact integer arithmetic', () => {
  const fixed = [0, 1, 1023, 1024, 1025, 1229, 4096, 10239, 10240, 10241, 1048575, 1048576, 1048577, 2202009,
    18253611008, 42949672960, 6656360448, 1024 ** 4 - 1, 1024 ** 4, 1024 ** 5 - 1, 1024 ** 5, 1024 ** 5 * 3];
  for (const bytes of fixed) assert.equal(liv.livHumanSize(bytes), humanModel(bytes), String(bytes));
  const random = seeded(3);
  for (let n = 0; n < 5000; n++) {
    const bytes = Math.floor(random() * 2 ** Math.floor(random() * 40));
    assert.equal(liv.livHumanSize(bytes), humanModel(bytes), String(bytes));
  }
  assert.deepEqual([1024, 1229, 10239, 1048575, 18253611008, 1024 ** 5].map(liv.livHumanSize), ['1.0K', '1.3K', '10K', '1.0M', '17G', '1024T']);
});

test('lost-in-var: livTable aligns columns left or right and leaves a left-aligned last column unpadded', () => {
  assert.deepEqual(liv.livTable([['a', 1, 'x'], ['bbb', 22, 'yy']], ['l', 'r', 'l']), ['a    1 x', 'bbb 22 yy']);
  assert.deepEqual(liv.livTable([['a', 1], ['bbb', 22]], ['l', 'r']), ['a    1', 'bbb 22']);
  assert.deepEqual(liv.livTable([], ['l']), []);
});

test('lost-in-var: livOptions reads combined flags, values (-n 5, -n5), -- and a lone -, and names the bad option', () => {
  assert.deepEqual(liv.livOptions('ls', ['-la', 'x', '-h', '-'], 'lah', ''), { flags: { l: true, a: true, h: true }, values: {}, operands: ['x', '-'], error: null });
  assert.deepEqual(liv.livOptions('tail', ['-n', '5', 'f'], 'f', 'n'), { flags: {}, values: { n: '5' }, operands: ['f'], error: null });
  assert.deepEqual(liv.livOptions('tail', ['-fn3'], 'f', 'n'), { flags: { f: true }, values: { n: '3' }, operands: [], error: null });
  assert.deepEqual(liv.livOptions('ls', ['-l', '--', '-a', 'b'], 'lah', ''), { flags: { l: true }, values: {}, operands: ['-a', 'b'], error: null });
  assert.equal(liv.livOptions('tail', ['x', '-n'], 'f', 'n').error, 'tail: option requires an argument -- \'n\'');
  assert.equal(liv.livOptions('ls', ['-lz'], 'lah', '').error, 'ls: invalid option -- \'z\'');
  assert.equal(liv.livOptions('ls', ['--all'], 'lah', '').error, 'ls: unrecognized option \'--all\'');
});

// ── Pure logic: the file system ──────────────────────────────────────────────

test('lost-in-var: every folder of every case lists exactly the names its data holds, folders marked with /', () => {
  for (const data of liv.livCases.concat([EDGE])) {
    for (const dir of allDirs(data)) {
      const entry = liv.livEntry(data, world(data), dir);
      assert.equal(entry.kind, 'dir', data.id + ' ' + dir);
      const model = namesBelow(data, dir);
      assert.deepEqual(liv.livChildren(data, world(data), dir), model.map((item) => item.name), data.id + ' ' + dir);
      const access = liv.livAccess(data, world(data), dir);
      const readable = !access.error && entry.mode[entry.owner === data.user ? 1 : 7] === 'r';
      const listing = cmd('Ls', data, ['-a', dir]);
      if (!readable) {
        assert.equal(listing.status, 2, data.id + ' ' + dir);
        continue;
      }
      const shown = model.map((item) => item.name + (item.dir ? '/' : ''));
      assert.deepEqual(texts(listing), ['./  ../' + (shown.length ? '  ' + shown.join('  ') : '')], data.id + ' ' + dir);
      assert.deepEqual(listing.names, shown.map((name) => (dir.endsWith('/') ? dir : dir + '/') + name));
    }
  }
});

test('lost-in-var: entries carry owner, mode, date and size; a file grows when its writer is killed, and a spool goes with its process', () => {
  const welcome = liv.livEntry(TUTORIAL, world(TUTORIAL), '/home/ops/welcome.txt');
  const lines = TUTORIAL.files['/home/ops/welcome.txt'].lines;
  assert.deepEqual(welcome, {
    kind: 'file', path: '/home/ops/welcome.txt', owner: 'ops', mode: '-rw-r--r--', time: 'Nov  6 08:00',
    size: lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0), lines
  });
  const hostname = liv.livEntry(TUTORIAL, world(TUTORIAL), '/etc/hostname');
  assert.deepEqual([hostname.owner, hostname.mode, hostname.size], ['root', '-rw-r--r--', 12]);
  assert.deepEqual(liv.livEntry(TUTORIAL, world(TUTORIAL), '/'), { kind: 'dir', path: '/', owner: 'root', mode: 'drwxr-xr-x', time: 'Nov  6 08:00', size: 4096, lines: [] });
  assert.equal(liv.livEntry(TUTORIAL, world(TUTORIAL), '/root').mode, 'drwx------');
  assert.equal(liv.livEntry(TUTORIAL, world(TUTORIAL), '/var').kind, 'dir', 'a folder its files imply');
  assert.equal(liv.livEntry(TUTORIAL, world(TUTORIAL), '/nope'), null);
  const beeper = (killed) => liv.livEntry(TUTORIAL, world(TUTORIAL, '/', killed), '/var/log/beeper.log').lines;
  assert.deepEqual(beeper([3141]), beeper([]).concat(['08:00:12 beeper 1.0 got SIGTERM: bye']));
  const spool = '/var/tmp/export-2231.spool';
  assert.equal(liv.livEntry(DISK, world(DISK), spool).size, 18253611008);
  assert.equal(liv.livEntry(DISK, world(DISK, '/', [2290]), spool).time, 'Nov  6 08:41', 'another kill leaves it');
  assert.equal(liv.livEntry(DISK, world(DISK, '/', [2231]), spool), null);
  assert.deepEqual(liv.livChildren(DISK, world(DISK, '/', [2231]), '/var/tmp'), ['apt-cache.bin']);
  // Access: every folder on the way must exist, be a folder and be readable.
  const access = (data, path) => liv.livAccess(data, world(data), path).error;
  assert.equal(access(TUTORIAL, '/nope/x'), 'missing');
  assert.equal(access(TUTORIAL, '/etc/hostname/x'), 'notdir');
  assert.equal(access(TUTORIAL, '/root/x'), 'denied');
  assert.equal(access(TUTORIAL, '/etc/nope'), 'missing');
  assert.equal(access(TUTORIAL, '/root'), null, 'the folder itself is there, only its content is closed');
  assert.equal(access(EDGE, '/locked/x'), 'denied', 'an owner without the read bit is shut out too');
  // Mounts: the one with the longest mount point holds a path; kills free space.
  const mounts = liv.livMounts(DISK, world(DISK));
  assert.deepEqual(['/', '/var/tmp', '/boot/efi', '/boot/efi/x', '/run/php', '/runx'].map((path) => liv.livMountOf(mounts, path).mount),
    ['/', '/', '/boot/efi', '/boot/efi', '/run', '/']);
  assert.equal(liv.livMounts(DISK, world(DISK, '/', [2231]))[0].used, 42949672960 - 18253611008);
  assert.equal(liv.livMounts(DISK, world(DISK, '/', [2290]))[0].used, 42949672960);
  assert.deepEqual(liv.livMounts(DISK, world(DISK, '/', [2231])).slice(1), DISK.mounts.slice(1));
  assert.deepEqual(liv.livProcesses(DISK, world(DISK, '/', [2231, 2290])).map((p) => p.pid), [1, 488, 512, 1020, 1022, 1190, 1544]);
});

test('lost-in-var: * and ? match names in the last part of a word, dot names only on request; no match, a wildcard folder or a closed folder keep the word', () => {
  const g = (word, cwd = '/var/log') => liv.livGlob(TUTORIAL, world(TUTORIAL, cwd), word);
  assert.deepEqual(g('*.log'), ['auth.log', 'beeper.log']);
  assert.deepEqual(g('*'), ['auth.log', 'beeper.log', 'syslog']);
  assert.deepEqual(g('/var/log/s?slog'), ['/var/log/syslog']);
  assert.deepEqual(g('../log/b*'), ['../log/beeper.log']);
  assert.deepEqual(g('*', '/home/ops'), ['todo.txt', 'welcome.txt'], 'no dot names');
  assert.deepEqual(g('.*', '/home/ops'), ['.profile']);
  assert.deepEqual(g('*.txt.'), ['*.txt.'], 'no match keeps the word');
  assert.deepEqual(g('/v*/log/*'), ['/v*/log/*'], 'a wildcard in a folder is not expanded');
  assert.deepEqual(g('/root/*'), ['/root/*'], 'a closed folder is not read');
  assert.deepEqual(g('/nope/*'), ['/nope/*']);
  assert.deepEqual(g('(a)+[b]'), ['(a)+[b]'], 'regular expression characters are plain');
  // Through a whole line: expanded words become operands, quoted ones do not.
  assert.deepEqual(texts(liv.livRun(TUTORIAL, world(TUTORIAL, '/var/log'), 'grep -c x *.log')), ['grep: invalid option -- \'c\'', 'Try \'help grep\' for more information.']);
  assert.deepEqual(texts(liv.livRun(TUTORIAL, world(TUTORIAL, '/home/ops'), 'cat *.txt')),
    TUTORIAL.files['/home/ops/todo.txt'].lines.concat(TUTORIAL.files['/home/ops/welcome.txt'].lines));
  assert.deepEqual(texts(liv.livRun(TUTORIAL, world(TUTORIAL, '/home/ops'), 'cat "*.txt"')), ['cat: *.txt: No such file or directory']);
});

// ── Pure logic: the commands ─────────────────────────────────────────────────

test('lost-in-var: ls lists folders and names files, with -l, -a and -h; errors name the path', () => {
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, [])), ['todo.txt  welcome.txt']);
  assert.deepEqual(cmd('Ls', TUTORIAL, []).names, ['todo.txt', 'welcome.txt']);
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['/'])), ['etc/  home/  root/  run/  tmp/  var/']);
  assert.deepEqual(cmd('Ls', TUTORIAL, ['/var/']).names, ['/var/log/']);
  assert.deepEqual(cmd('Ls', TUTORIAL, ['../ops']).names, ['../ops/todo.txt', '../ops/welcome.txt']);
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['-la'])), [
    'drwxr-xr-x 2 ops  ops  4096 Nov  6 08:00 .',
    'drwxr-xr-x 2 root root 4096 Nov  6 08:00 ..',
    '-rw-r--r-- 1 ops  ops    32 Nov  6 08:00 .profile',
    '-rw-r--r-- 1 ops  ops    49 Nov  6 08:00 todo.txt',
    '-rw-r--r-- 1 ops  ops   377 Nov  6 08:00 welcome.txt'
  ]);
  assert.deepEqual(texts(cmd('Ls', DISK, ['-lh', '/var/tmp'])), [
    '-rw-r--r-- 1 root root 2.1M Nov  6 03:10 apt-cache.bin',
    '-rw-r--r-- 1 ops  ops   17G Nov  6 08:41 export-2231.spool'
  ]);
  assert.deepEqual(texts(cmd('Ls', DISK, ['-l', '/var/tmp/export-2231.spool'])), ['-rw-r--r-- 1 ops ops 18253611008 Nov  6 08:41 /var/tmp/export-2231.spool']);
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['welcome.txt'])), ['welcome.txt']);
  assert.deepEqual(cmd('Ls', TUTORIAL, ['welcome.txt']).names, ['welcome.txt']);
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['-h'])), ['todo.txt  welcome.txt'], '-h alone changes nothing');
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['/tmp'])), [], 'an empty folder prints nothing');
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['-l', '/tmp'])), []);
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['/var', 'todo.txt', '/etc'])), ['/var:', 'log/', 'todo.txt', '', '/etc:', 'hostname  motd']);
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['/tmp', '/var'])), ['/tmp:', '', '/var:', 'log/']);
  const missing = cmd('Ls', TUTORIAL, ['nope', '/var']);
  assert.deepEqual([kinds(missing), texts(missing), missing.status], [['err', 'out', 'out'], ['ls: cannot access \'nope\': No such file or directory', '/var:', 'log/'], 2], 'no blank line before the first header');
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['/root'])), ['ls: cannot open directory \'/root\': Permission denied']);
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['/root/x'])), ['ls: cannot access \'/root/x\': Permission denied']);
  assert.deepEqual(texts(cmd('Ls', TUTORIAL, ['/etc/hostname/x'])), ['ls: cannot access \'/etc/hostname/x\': Not a directory']);
  for (const [args, first] of [[['-x'], 'ls: invalid option -- \'x\''], [['--all'], 'ls: unrecognized option \'--all\'']]) {
    const bad = cmd('Ls', TUTORIAL, args);
    assert.deepEqual([texts(bad), bad.status], [[first, 'Try \'help ls\' for more information.'], 2]);
  }
});

test('lost-in-var: cd and pwd move through the tree; errors name the path and leave the folder', () => {
  const cd = (args, cwd) => cmd('Cd', TUTORIAL, args, { cwd });
  assert.equal(cd([], '/var').world.cwd, '/home/ops');
  assert.equal(cd(['~'], '/var').world.cwd, '/home/ops');
  assert.equal(cd(['..'], '/var/log').world.cwd, '/var');
  assert.equal(cd(['/var/log/'], '/').world.cwd, '/var/log');
  assert.equal(cd(['../..'], '/var/log').world.cwd, '/');
  assert.deepEqual(cd(['log'], '/var'), { out: [], status: 0, world: { cwd: '/var/log', killed: [], done: [] } });
  for (const [args, error] of [
    [['nope'], 'bash: cd: nope: No such file or directory'],
    [['welcome.txt'], 'bash: cd: welcome.txt: Not a directory'],
    [['/root'], 'bash: cd: /root: Permission denied'],
    [['/etc/hostname/x'], 'bash: cd: /etc/hostname/x: Not a directory'],
    [['a', 'b'], 'bash: cd: too many arguments']
  ]) {
    const result = cd(args, '/home/ops');
    assert.deepEqual([texts(result), result.status, result.world], [[error], 1, undefined], error);
  }
  assert.deepEqual(cmd('Pwd', TUTORIAL, ['ignored'], { cwd: '/var/log' }), { out: [{ k: 'out', t: '/var/log' }], status: 0 });
});

test('lost-in-var: cat prints files one after another; errors name the file', () => {
  const result = cmd('Cat', TUTORIAL, ['todo.txt', 'nope', '/etc/hostname']);
  assert.deepEqual(texts(result), ['1. read welcome.txt', '2. stop the beeper', '3. coffee', 'cat: nope: No such file or directory', 'training-01']);
  assert.deepEqual([result.status, result.reads], [1, ['/home/ops/todo.txt', '/etc/hostname']]);
  assert.deepEqual(cmd('Cat', TUTORIAL, ['todo.txt']).status, 0);
  for (const [args, error] of [
    [['/var'], 'cat: /var: Is a directory'],
    [['/var/log/auth.log'], 'cat: /var/log/auth.log: Permission denied'],
    [['/root/x'], 'cat: /root/x: Permission denied'],
    [['/etc/hostname/x'], 'cat: /etc/hostname/x: Not a directory'],
    [[], 'cat: name a file to print: this shell cannot read from the keyboard']
  ]) {
    assert.deepEqual(texts(cmd('Cat', TUTORIAL, args)), [error], error);
  }
  assert.deepEqual(texts(cmd('Cat', EDGE, ['secret'])), ['cat: secret: Permission denied'], 'the owner needs the read bit too');
  assert.deepEqual(texts(cmd('Cat', TUTORIAL, ['-n', 'todo.txt'])), ['cat: invalid option -- \'n\'', 'Try \'help cat\' for more information.']);
});

test('lost-in-var: tail prints the last 10 lines, or -n N (-nN, -N), of files or a pipe; -f and bad counts are refused by name', () => {
  const log = TUTORIAL.files['/var/log/beeper.log'].lines;
  const tail = (args, stdin = null) => cmd('Tail', TUTORIAL, args, { cwd: '/var/log', stdin });
  assert.deepEqual(texts(tail(['beeper.log'])), log.slice(-10));
  for (const args of [['-n', '3', 'beeper.log'], ['-n3', 'beeper.log'], ['-3', 'beeper.log'], ['beeper.log', '-n', '3']]) {
    assert.deepEqual(texts(tail(args)), log.slice(-3), args.join(' '));
  }
  assert.deepEqual(texts(tail(['-n', '0', 'beeper.log'])), []);
  assert.deepEqual(texts(tail(['-n', '99', 'beeper.log'])), log);
  assert.deepEqual(tail(['beeper.log']).reads, ['/var/log/beeper.log']);
  assert.deepEqual(texts(tail(['-n', '1', 'beeper.log', 'syslog'])), ['==> beeper.log <==', log[11], '', '==> syslog <==', 'Nov  6 08:00:00 training-01 beeper[3141]: started by ops']);
  assert.deepEqual(texts(tail(['-n', '1', 'nope', 'syslog'])), ['tail: cannot open \'nope\' for reading: No such file or directory', '==> syslog <==', 'Nov  6 08:00:00 training-01 beeper[3141]: started by ops']);
  assert.deepEqual(texts(tail(['-n', '2'], ['a', 'b', 'c'])), ['b', 'c']);
  assert.deepEqual(tail([], ['a']).status, 0);
  for (const [args, error] of [
    [[], 'tail: name a file: this shell cannot read from the keyboard'],
    [['-f', 'beeper.log'], 'tail: -f would follow the file forever; this shell prints the last lines once, so leave out -f'],
    [['-n', 'x', 'beeper.log'], 'tail: invalid number of lines: \'x\''],
    [['/var'], 'tail: error reading \'/var\': Is a directory'],
    [['auth.log'], 'tail: cannot open \'auth.log\' for reading: Permission denied']
  ]) {
    const result = tail(args);
    assert.deepEqual([texts(result), result.status], [[error], 1], error);
  }
  assert.deepEqual(texts(tail(['-q', 'beeper.log'])), ['tail: invalid option -- \'q\'', 'Try \'help tail\' for more information.']);
  assert.deepEqual(texts(tail(['-n'])), ['tail: option requires an argument -- \'n\'', 'Try \'help tail\' for more information.']);
});

test('lost-in-var: grep finds plain text with -i, -n, -v and -r, labels lines from several files, and exits 0, 1 or 2', () => {
  const grep = (args, opts = {}) => cmd('Grep', TUTORIAL, args, Object.assign({ cwd: '/var/log' }, opts));
  let result = grep(['pid', 'beeper.log']);
  assert.deepEqual([texts(result), result.status, result.reads], [['08:00:00 beeper 1.0 starting (pid 3141)'], 0, ['/var/log/beeper.log']]);
  assert.deepEqual(texts(grep(['-in', 'WARNING', 'beeper.log'])), ['5:08:00:04 warning: volume at 11']);
  assert.deepEqual(texts(grep(['WARNING', 'beeper.log'])), [], 'case counts without -i');
  assert.equal(grep(['WARNING', 'beeper.log']).status, 1);
  assert.deepEqual(grep(['WARNING', 'beeper.log']).reads, []);
  assert.deepEqual(texts(grep(['-v', 'BEEP', 'beeper.log'])), TUTORIAL.files['/var/log/beeper.log'].lines.filter((line) => !line.includes('BEEP')));
  assert.deepEqual(texts(grep(['3141', 'beeper.log', 'syslog'])), ['beeper.log:08:00:00 beeper 1.0 starting (pid 3141)', 'syslog:Nov  6 08:00:00 training-01 beeper[3141]: started by ops']);
  result = grep(['3141', 'nope', 'syslog']);
  assert.deepEqual([texts(result), result.status], [['grep: nope: No such file or directory', 'syslog:Nov  6 08:00:00 training-01 beeper[3141]: started by ops'], 2]);
  assert.deepEqual(texts(grep(['x', '/var'])), ['grep: /var: Is a directory']);
  assert.deepEqual(texts(grep(['x', 'auth.log'])), ['grep: auth.log: Permission denied']);
  // -r: every file below the folders named, or below the current one.
  result = grep(['-r', 'training-01', '/var']);
  assert.deepEqual([texts(result), result.status], [[
    'grep: /var/log/auth.log: Permission denied',
    '/var/log/syslog:Nov  6 07:58:12 training-01 sshd[530]: session opened for user ops',
    '/var/log/syslog:Nov  6 08:00:00 training-01 beeper[3141]: started by ops'
  ], 2]);
  assert.deepEqual(texts(grep(['-r', 'coffee'], { cwd: '/home' })), ['ops/todo.txt:3. coffee']);
  assert.deepEqual(texts(grep(['-r', 'coffee', '/'])), ['/home/ops/todo.txt:3. coffee', 'grep: /root: Permission denied', 'grep: /var/log/auth.log: Permission denied'],
    'in path order; a closed folder is named once and not entered');
  // A folder the user cannot read: named with Permission denied, exit status 2, at the top or found on the way.
  const grepDisk = (args) => cmd('Grep', DISK, args, { cwd: '/var' });
  result = grepDisk(['-r', 'x', '/root']);
  assert.deepEqual([texts(result), kinds(result), result.status], [['grep: /root: Permission denied'], ['err'], 2]);
  result = grepDisk(['-r', 'nginx', 'lib']);
  assert.deepEqual([texts(result), result.status], [['grep: lib/nginx/body: Permission denied'], 2]);
  assert.deepEqual(texts(cmd('Grep', EDGE, ['-r', 'x', '/'])), ['/home/me/a.txt:x', 'grep: /home/me/secret: Permission denied', 'grep: /locked: Permission denied']);
  assert.deepEqual(texts(cmd('Grep', EDGE, ['x', '/locked'])), ['grep: /locked: Is a directory'], 'without -r a folder is still just a folder');
  assert.deepEqual(texts(grep(['-r', 'coffee', '../../home/'])), ['../../home/ops/todo.txt:3. coffee']);
  assert.deepEqual(texts(grep(['-r', 'pid', 'beeper.log'])), ['beeper.log:08:00:00 beeper 1.0 starting (pid 3141)'], 'a file under -r keeps its name');
  assert.deepEqual(texts(grep(['-r', 'x', 'nope'])), ['grep: nope: No such file or directory']);
  // A pipe, and the refusals.
  assert.deepEqual(texts(grep(['b'], { stdin: ['a', 'b', 'ab'] })), ['b', 'ab']);
  assert.equal(grep(['z'], { stdin: ['a'] }).status, 1);
  assert.deepEqual(grep(['x']), { out: [{ k: 'err', t: 'grep: name a file to search: this shell cannot read from the keyboard' }], status: 2 });
  assert.deepEqual(texts(grep([])), ['Usage: grep [OPTION]... PATTERNS [FILE]...', 'Try \'help grep\' for more information.']);
  assert.deepEqual(texts(grep(['-E', 'x', 'beeper.log'])), ['grep: invalid option -- \'E\'', 'Try \'help grep\' for more information.']);
});

test('lost-in-var: ps shows this terminal, ps aux every process in id order; the killed are gone, and options it lacks are refused by name', () => {
  assert.deepEqual(texts(cmd('Ps', TUTORIAL, [])), [' PID TTY   TIME     CMD', '1001 pts/0 00:00:00 bash', '1188 pts/0 00:00:00 ps']);
  const full = cmd('Ps', TUTORIAL, ['aux']);
  assert.deepEqual(texts(full), [
    'USER  PID %CPU %MEM COMMAND',
    'root    1  0.0  0.1 /sbin/init',
    'root  412  0.0  0.0 /usr/sbin/cron -f',
    'root  530  0.0  0.1 /usr/sbin/sshd -D',
    'ops  1001  0.0  0.1 -bash',
    'ops  1188  0.0  0.1 ps aux',
    'ops  3141  2.0  0.1 /usr/local/bin/beeper --every 1s --volume 11'
  ]);
  assert.deepEqual(full.names, ['1', '412', '530', '3141'], 'every id but the shell');
  for (const arg of ['-aux', 'ax', '-ef', '-e']) assert.equal(texts(cmd('Ps', TUTORIAL, [arg])).length, 7, arg);
  for (const arg of ['-f', '-efx', 'e']) assert.equal(cmd('Ps', TUTORIAL, [arg]).status, 1, arg);
  assert.equal(texts(cmd('Ps', TUTORIAL, ['aux'], { killed: [3141] })).some((line) => line.includes('beeper')), false);
  for (const args of [['-l'], ['a', 'x']]) {
    assert.deepEqual(cmd('Ps', TUTORIAL, args), { out: [{ k: 'err', t: 'ps: unsupported option \'' + args.join(' ') + '\': this shell knows ps and ps aux' }], status: 1 });
  }
  // Every row of every case: the user, the id, CPU and memory with one decimal, the command.
  for (const data of liv.livCases) {
    const rows = texts(cmd('Ps', data, ['aux'])).slice(1).map((line) => line.trim().split(/\s+/));
    const model = data.procs.map((p) => [p.user, String(p.pid), p.cpu.toFixed(1), p.mem.toFixed(1), p.cmd])
      .concat([[data.user, String(data.psPid), '0.0', '0.1', 'ps aux']]).sort((a, b) => a[1] - b[1]);
    assert.deepEqual(rows.map((r) => r.slice(0, 4).concat(r.slice(4).join(' '))), model, data.id);
  }
});

test('lost-in-var: df shows every file system, or the one that holds a path, in 1K blocks or with -h; a kill frees its space', () => {
  assert.deepEqual(texts(cmd('Df', DISK, ['-h'])), [
    'Filesystem Size Used Avail Use% Mounted on',
    '/dev/sda1   40G  40G     0 100% /',
    '/dev/sda15 124M 6.2M  118M   5% /boot/efi',
    'tmpfs      2.0G 1.3M  2.0G   1% /run'
  ]);
  assert.deepEqual(texts(cmd('Df', DISK, ['-h'], { killed: [2231] }))[1], '/dev/sda1   40G  23G   17G  58% /');
  assert.deepEqual(texts(cmd('Df', TUTORIAL, [])), [
    'Filesystem 1K-blocks    Used Available Use% Mounted on',
    '/dev/sda1   20971520 6500352  14471168  31% /',
    'tmpfs        1048576    1280   1047296   1% /run'
  ]);
  assert.deepEqual(cmd('Df', DISK, ['-h']).names, ['/', '/boot/efi', '/run']);
  const one = cmd('Df', DISK, ['-h', '/var/log', '/etc', 'nope']);
  assert.deepEqual([texts(one), one.status, one.names], [['df: nope: No such file or directory', 'Filesystem Size Used Avail Use% Mounted on', '/dev/sda1   40G  40G     0 100% /'], 1, ['/']]);
  assert.deepEqual(cmd('Df', DISK, ['nope']), { out: [{ k: 'err', t: 'df: nope: No such file or directory' }], status: 1, names: [] });
  assert.deepEqual(texts(cmd('Df', DISK, ['-i'])), ['df: invalid option -- \'i\'', 'Try \'help df\' for more information.']);
  // Use% and the sizes of every file system of every case, against the model.
  for (const data of liv.livCases) {
    const rows = texts(cmd('Df', data, ['-h'])).slice(1).map((line) => line.trim().split(/\s+/));
    assert.deepEqual(rows, data.mounts.map((m) => [m.fs, humanModel(m.size), humanModel(m.used), humanModel(m.size - m.used),
      Math.ceil(m.used * 100 / m.size) + '%', m.mount]), data.id);
  }
});

test('lost-in-var: kill stops the user\'s own processes by id with an optional signal; every refusal names the id or signal', () => {
  let result = cmd('Kill', TUTORIAL, ['3141']);
  assert.deepEqual(result, {
    out: [{ k: 'sys', t: '[monitor] beeper (pid 3141) stopped. Silence on training-01.' }],
    status: 0,
    world: { cwd: '/home/ops', killed: [3141], done: [] }
  });
  for (const signal of ['-9', '-15', '-KILL', '-term', '-SIGTERM', '-HUP', '-1', '-2', '-INT', '-sigkill', '-SIGHUP', '-SIGINT']) {
    assert.deepEqual(cmd('Kill', TUTORIAL, [signal, '3141']).world.killed, [3141], signal);
  }
  assert.deepEqual(cmd('Kill', TUTORIAL, ['-7', '3141']), { out: [{ k: 'err', t: 'bash: kill: 7: invalid signal specification' }], status: 1 });
  assert.deepEqual(texts(cmd('Kill', TUTORIAL, ['-SIG9', '3141'])), ['bash: kill: SIG9: invalid signal specification'], 'SIG goes before a name only');
  const usage = { out: [{ k: 'err', t: 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]' }], status: 2 };
  for (const args of [[], ['-9'], ['-s', 'TERM'], ['-n', '9']]) assert.deepEqual(cmd('Kill', TUTORIAL, args), usage, args.join(' '));
  // Every form the usage offers works: -s sigspec, -n signum, -sigspec and kill -l [sigspec].
  for (const args of [['-s', 'TERM', '3141'], ['-s', 'sigkill', '3141'], ['-n', '9', '3141'], ['-n', 'HUP', '3141'], ['-s', '15', '3141']]) {
    assert.deepEqual(cmd('Kill', TUTORIAL, args).world.killed, [3141], args.join(' '));
  }
  for (const flag of ['-s', '-n']) {
    assert.deepEqual(cmd('Kill', TUTORIAL, [flag]), { out: [{ k: 'err', t: 'bash: kill: ' + flag + ': option requires an argument' }], status: 2 });
  }
  assert.deepEqual(cmd('Kill', TUTORIAL, ['-s', 'STOP', '3141']), { out: [{ k: 'err', t: 'bash: kill: STOP: invalid signal specification' }], status: 1 });
  assert.deepEqual(cmd('Kill', TUTORIAL, ['-l']), { out: [{ k: 'out', t: '1) SIGHUP  2) SIGINT  9) SIGKILL  15) SIGTERM' }], status: 0 });
  result = cmd('Kill', TUTORIAL, ['-l', '9', 'TERM', 'sighup', '7', 'SIG', '2']);
  assert.deepEqual([texts(result), kinds(result), result.status, result.world], [
    ['KILL', '15', '1', 'bash: kill: 7: invalid signal specification', 'bash: kill: SIG: invalid signal specification', 'INT'],
    ['out', 'out', 'out', 'err', 'err', 'out'], 1, undefined], 'kill -l names signals and stops nothing');  result = cmd('Kill', TUTORIAL, ['beeper', '-', '42', '1', '1001', '3141', '3141']);
  assert.deepEqual([texts(result), kinds(result), result.status, result.world.killed], [[
    'bash: kill: beeper: arguments must be process or job IDs',
    'bash: kill: -: arguments must be process or job IDs',
    'bash: kill: (42) - No such process',
    'bash: kill: (1) - Operation not permitted',
    '# 1001 is your own shell (-bash): killing it would only log you out, so it keeps running.',
    '[monitor] beeper (pid 3141) stopped. Silence on training-01.',
    'bash: kill: (3141) - No such process'
  ], ['err', 'err', 'err', 'err', 'sys', 'sys', 'err'], 1, [3141]]);
  assert.deepEqual(texts(cmd('Kill', TUTORIAL, ['3141'], { killed: [3141] })), ['bash: kill: (3141) - No such process']);
  assert.deepEqual(cmd('Kill', EDGE, ['20']), { out: [], status: 0, world: { cwd: '/home/me', killed: [20], done: [] } }, 'kill prints nothing itself');
  assert.deepEqual(texts(cmd('Kill', DISK, ['1022'])), ['bash: kill: (1022) - Operation not permitted']);
});

test('lost-in-var: help lists the commands and the flags of one; clear asks to clear; unknown commands, rm and sudo answer like a shell', () => {
  assert.deepEqual(texts(cmd('Help', TUTORIAL, [])), liv.livHelpAll);
  assert.ok(liv.livHelpAll.every((line) => !/rm -|sudo/.test(line)));
  for (const name of liv.livCommandNames) assert.deepEqual(texts(cmd('Help', TUTORIAL, [name])), liv.livHelp[name], name);
  assert.deepEqual(Object.keys(liv.livHelp).sort(), liv.livCommandNames);
  assert.deepEqual(cmd('Help', TUTORIAL, ['rm']), { out: [{ k: 'err', t: 'bash: help: no help topics match \'rm\'. Type help alone for the list.' }], status: 1 });
  assert.deepEqual(cmd('Clear', TUTORIAL, []), { out: [], status: 0, clear: true });
  for (const name of ['rm', 'rmdir', 'shred', 'truncate', 'unlink']) {
    assert.deepEqual(liv.livUnknown(TUTORIAL, name), { out: [{ k: 'err', t: 'bash: ' + name + ': command not found' },
      { k: 'sys', t: '# Deleting files is not your call on this shift: find the cause and stop it.' }], status: 127 });
  }
  assert.deepEqual(liv.livUnknown(PORT, 'sudo'), { out: [{ k: 'err', t: 'deploy is not in the sudoers file.  This incident will be reported.' }], status: 1 });
  assert.deepEqual(liv.livUnknown(TUTORIAL, 'top'), { out: [{ k: 'err', t: 'bash: top: command not found' },
    { k: 'sys', t: '# This shell knows: cat cd clear df grep help kill ls ps pwd tail. Type help for their flags.' }], status: 127 });
});

// ── Pure logic: lines, goals, completion, history, score ─────────────────────

test('lost-in-var: livRun pipes output into grep and tail, shows earlier errors, counts what it should, and offers names for the chips', () => {
  const w = world(TUTORIAL, '/var/log');
  let result = liv.livRun(TUTORIAL, w, 'ps aux | grep beeper');
  assert.deepEqual([texts(result), result.status, result.counted, result.names], [
    ['ops  3141  2.0  0.1 /usr/local/bin/beeper --every 1s --volume 11'], 0, true, ['3141', '/usr/local/bin/beeper']]);
  result = liv.livRun(TUTORIAL, w, 'cat nope beeper.log | grep -n pid | tail -n 1');
  assert.deepEqual([texts(result), kinds(result), result.status], [['cat: nope: No such file or directory', '1:08:00:00 beeper 1.0 starting (pid 3141)'], ['err', 'out'], 0]);
  result = liv.livRun(TUTORIAL, w, 'cat beeper.log | grep nothing');
  assert.deepEqual([texts(result), result.status], [[], 1]);
  for (const line of ['ps aux | cat', 'ls | kill 1']) {
    result = liv.livRun(TUTORIAL, w, line);
    assert.deepEqual([texts(result), result.status, result.counted, result.world], [
      ['bash: ' + line.split('| ')[1].split(' ')[0] + ': cannot read a pipe here: only grep and tail can'], 2, true, w], line);
  }
  result = liv.livRun(TUTORIAL, w, 'cat "x');
  assert.deepEqual([kinds(result), result.status, result.counted], [['err'], 2, true]);
  assert.deepEqual(liv.livRun(TUTORIAL, w, '   '), { world: w, out: [], names: [], clear: false, counted: false, status: 0 });
  assert.equal(liv.livRun(TUTORIAL, w, 'help').counted, false);
  assert.equal(liv.livRun(TUTORIAL, w, 'clear | help').counted, true, 'a pipe error counts');
  assert.equal(liv.livRun(TUTORIAL, w, 'help | grep ls').counted, true, 'grep counts');
  assert.deepEqual(liv.livRun(TUTORIAL, w, 'clear'), { world: { cwd: '/var/log', killed: [], done: [2] }, out: [], names: [], clear: true, counted: false, status: 0 },
    'any command run in /var/log meets the step that goes there');
  assert.equal(liv.livRun(TUTORIAL, w, 'clear | grep x').clear, false);
  result = liv.livRun(TUTORIAL, w, 'nmap localhost');
  assert.deepEqual([result.status, result.counted, result.names], [127, true, []]);
  // The world: cd and kill change it, every other command leaves it.
  assert.equal(liv.livRun(TUTORIAL, w, 'cd ..').world.cwd, '/var');
  assert.deepEqual(liv.livRun(TUTORIAL, w, 'kill 3141 | grep x').world.killed, [3141], 'a kill in a pipeline still stops the process');
  // As in bash every command of a pipeline runs in a subshell: a cd there leaves this shell where it was.
  result = liv.livRun(TUTORIAL, w, 'cd .. | grep x');
  assert.deepEqual([texts(result), kinds(result), result.status, result.world.cwd],
    [['# cd ran in a subshell of the pipeline, so this shell stays in /var/log.'], ['sys'], 1, '/var/log']);
  assert.deepEqual(texts(liv.livRun(TUTORIAL, w, 'cd /etc | tail hostname')), ['# cd ran in a subshell of the pipeline, so this shell stays in /var/log.',
    'tail: cannot open \'hostname\' for reading: No such file or directory'], 'the next command of the pipeline still runs in /var/log');
  assert.deepEqual(texts(liv.livRun(TUTORIAL, w, 'cd /root | grep x')), ['bash: cd: /root: Permission denied'], 'a cd that fails needs no note');
  assert.deepEqual(liv.livRun(TUTORIAL, world(TUTORIAL), 'cd /var/log | grep x').world, world(TUTORIAL), 'so it meets no step that goes there');
  assert.notEqual(liv.livRun(TUTORIAL, w, 'pwd').world, w, 'a copy, never the same object');
  assert.deepEqual(w, world(TUTORIAL, '/var/log'), 'the input world is left alone');
  // Names: from ls, ps and df as they list them, else from the text (paths, pid N), at most 12.
  assert.deepEqual(liv.livRun(DISK, world(DISK), 'tail -n 2 /var/log/shop/export.log').names, []);
  assert.deepEqual(liv.livRun(DISK, world(DISK), 'cat /var/log/shop/export.log').names, ['2231', '/var/tmp/export-2231.spool']);
  assert.equal(liv.livRun(DISK, world(DISK), 'ls -a / /etc /var /var/log /var/log/nginx /var/log/shop /var/tmp').names.length, 12);
});

test('lost-in-var: livNamesIn picks process ids, absolute paths and "pid N" from text, never dates, URLs or a trailing dot', () => {
  assert.deepEqual(liv.livNamesIn([
    'ops      2231 38.5  1.9 /opt/shop/bin/export --debug --loop',
    'It writes to /var/log/beeper.log. Then (see /etc/app/app.env) or "/tmp/a b",x=/srv/x',
    '2026/11/06 03:10:44 redis://127.0.0.1:6379/0 at 0.0.0.0:8080 pid 3107 and pid 3107',
    'a lone / and /var/'
  ]), ['2231', '/opt/shop/bin/export', '/var/log/beeper.log', '/etc/app/app.env', '/tmp/a', '/srv/x', '3107', '/var/']);
  assert.equal(liv.livNamesIn(Array.from({ length: 20 }, (_, i) => '/f' + i)).length, 12);
});

test('lost-in-var: goals are met by a command that succeeds, by a file read, by the lines shown on screen (pipes too), by the folder reached or by a kill', () => {
  const step = (w, line) => liv.livRun(TUTORIAL, w, line).world;
  let w = world(TUTORIAL);
  // Misses first: a failing ls, cat of another file, a tail or grep that shows other lines, ps without every process, a cd in a pipeline.
  for (const line of ['ls nope', 'cat todo.txt', 'grep zzz /var/log/beeper.log', 'ps', 'tail nope', 'cd /var', 'kill 1',
    'tail -n 0 /var/log/beeper.log', 'grep BEEP /var/log/beeper.log', 'tail -n 3 /var/log/beeper.log | grep BEEP',
    'cat /var/log/beeper.log | grep -v pid | grep pid', 'ps aux | grep beeper', 'ps aux | tail -n 2', 'cd /var/log | grep x',
    'cat /var/log/beeper.log', 'grep -n pid /var/log/syslog', 'ps "/sbin/init"']) {
    w = step(w, line);
    assert.deepEqual(w.done, [], line);
  }
  // Every form that shows what a step asks for meets it, piped or not.
  for (const [line, goal] of [['tail -n 3 /var/log/beeper.log', 3], ['cat /var/log/beeper.log | tail -n 3', 3], ['tail /var/log/beeper.log', 3],
    ['grep pid /var/log/beeper.log', 4], ['cat /var/log/beeper.log | grep pid', 4], ['grep -rn pid /var/log', 4],
    ['ps aux', 6], ['ps ax', 6], ['ps -ef', 6], ['ps -e', 6], ['ps aux | grep init', 6]]) {
    assert.deepEqual(step(world(TUTORIAL), line).done, [goal], line);
  }
  w = step(w, 'cd /home/ops');
  const expected = [];
  TUTORIAL.goals.forEach((goal, i) => {
    assert.equal(liv.livCheckWin(TUTORIAL, w), false);
    w = step(w, goal.example);
    expected.push(i);
    assert.deepEqual(w.done, expected, goal.example);
  });
  assert.equal(liv.livCheckWin(TUTORIAL, w), true);
  // Out of order; a goal once met stays met, and a kill does not undo what was seen.
  w = world(TUTORIAL);
  w = step(w, 'kill 3141');
  w = step(w, 'ps aux');
  w = step(w, 'cat /var/log/beeper.log | grep pid');
  w = step(w, 'df /');
  w = step(w, 'cd /var/log');
  w = step(w, 'cd /');
  w = step(w, 'tail -n 3 /var/log/beeper.log');
  assert.deepEqual(w.done, [2, 3, 4, 5, 6, 7]);
  // An incident: the kill alone closes nothing; the evidence on screen does, before or after it.
  const disk = (lines) => lines.reduce((acc, line) => liv.livRun(DISK, acc, line).world, world(DISK));
  assert.equal(liv.livCheckWin(DISK, world(DISK)), false);
  assert.deepEqual(disk(['kill 2231']).done, [2]);
  assert.equal(liv.livCheckWin(DISK, disk(['kill 2231'])), false);
  assert.deepEqual(disk(['grep "No space left" /var/log/nginx/error.log']).done, [0]);
  assert.deepEqual(disk(['cat /var/log/shop/export.log | grep loop']).done, [1]);
  assert.deepEqual(disk(['cat "No space left on device"', 'help grep', 'ls /var/tmp']).done, [], 'errors, help and listings are not evidence');
  assert.equal(liv.livCheckWin(DISK, disk(['kill 2231', 'tail /var/log/shop/export.log', 'tail -n 3 /var/log/nginx/error.log'])), true);
});

test('lost-in-var: Tab completes commands and names in every folder of every case, checked against the case data', () => {
  const complete = (line, data = TUTORIAL, cwd = data.home) => liv.livComplete(data, world(data, cwd), line);
  assert.deepEqual(complete('c'), { line: 'c', options: ['cat', 'cd', 'clear'], miss: null });
  assert.deepEqual(complete('ca'), { line: 'cat ', options: [], miss: null });
  assert.deepEqual(complete(''), { line: '', options: liv.livCommandNames, miss: null });
  assert.deepEqual(complete('ps aux | gr'), { line: 'ps aux | grep ', options: [], miss: null });
  assert.deepEqual(complete('ps aux |t'), { line: 'ps aux |tail ', options: [], miss: null }, 'a word glued to | is a command too');
  assert.deepEqual(complete('ps aux |zz'), { line: 'ps aux |zz', options: [], miss: 'No command starts with \'zz\'. Type help for the list.' });
  assert.deepEqual(complete('zz'), { line: 'zz', options: [], miss: 'No command starts with \'zz\'. Type help for the list.' });
  assert.deepEqual(complete('cat w'), { line: 'cat welcome.txt ', options: [], miss: null });
  assert.deepEqual(complete('cat '), { line: 'cat ', options: ['todo.txt', 'welcome.txt'], miss: null });
  assert.deepEqual(complete('cat .'), { line: 'cat .profile ', options: [], miss: null });
  assert.deepEqual(complete('cd /v'), { line: 'cd /var/', options: [], miss: null });
  assert.deepEqual(complete('cd ~/t'), { line: 'cd ~/todo.txt ', options: [], miss: null });
  assert.deepEqual(complete('ls /r'), { line: 'ls /r', options: ['root/', 'run/'], miss: null });
  assert.deepEqual(complete('cat zz'), { line: 'cat zz', options: [], miss: 'Nothing in /home/ops starts with \'zz\'.' });
  assert.deepEqual(complete('cat /root/'), { line: 'cat /root/', options: [], miss: 'Nothing in /root starts with \'\'.' }, 'a closed folder offers nothing');
  assert.deepEqual(complete('cat /var/tmp/e', DISK), { line: 'cat /var/tmp/export-2231.spool ', options: [], miss: null });
  assert.deepEqual(liv.livComplete(DISK, world(DISK, '/', [2231]), 'cat /var/tmp/e').options, [], 'the removed spool is gone');
  // Brute force: every prefix of every name in every open folder.
  for (const data of liv.livCases) {
    for (const dir of allDirs(data)) {
      if (!liv.livAccess(data, world(data), dir).error && cmd('Ls', data, [dir]).status === 0) {
        const below = namesBelow(data, dir);
        for (const { name } of below) {
          for (let k = 0; k <= name.length; k++) {
            const prefix = name.slice(0, k);
            const typedDir = dir === '/' ? '/' : dir + '/';
            const wanted = below.filter((item) => item.name.startsWith(prefix) && (!item.name.startsWith('.') || prefix.startsWith('.')))
              .map((item) => item.name + (item.dir ? '/' : ''));
            const got = liv.livComplete(data, world(data), 'cat ' + typedDir + prefix);
            if (wanted.length === 1) {
              assert.equal(got.line, 'cat ' + typedDir + wanted[0] + (wanted[0].endsWith('/') ? '' : ' '));
            } else if (wanted.length > 1) {
              assert.deepEqual(got.options, wanted, data.id + ' ' + typedDir + prefix);
              const common = wanted.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); });
              assert.equal(got.line, 'cat ' + typedDir + common);
            } else {
              assert.equal(got.line, 'cat ' + typedDir + prefix, 'a dot name is offered only after a dot');
            }
          }
        }
      }
    }
  }
});

test('lost-in-var: the history steps through older lines and back to the line being typed; repeats and old lines are dropped', () => {
  const history = ['ls', 'pwd', 'ps aux'];
  let move = liv.livHistoryMove(history, 3, '', 'draft', -1);
  assert.deepEqual(move, { pos: 2, draft: 'draft', text: 'ps aux' });
  move = liv.livHistoryMove(history, move.pos, move.draft, move.text, -1);
  assert.deepEqual(move, { pos: 1, draft: 'draft', text: 'pwd' });
  move = liv.livHistoryMove(history, 0, 'draft', 'ls', -1);
  assert.deepEqual(move, { pos: 0, draft: 'draft', text: 'ls' }, 'the oldest line stays');
  move = liv.livHistoryMove(history, 2, 'draft', 'ps aux', 1);
  assert.deepEqual(move, { pos: 3, draft: 'draft', text: 'draft' });
  move = liv.livHistoryMove(history, 3, 'old', 'typing', 1);
  assert.deepEqual(move, { pos: 3, draft: 'typing', text: 'typing' }, 'down at the bottom keeps what is typed');
  assert.deepEqual(liv.livHistoryMove([], 99, '', 'x', -1), { pos: 0, draft: 'x', text: 'x' });
  assert.deepEqual(liv.livRemember(['ls'], 'ls'), ['ls']);
  assert.deepEqual(liv.livRemember(['ls'], 'pwd'), ['ls', 'pwd']);
  const long = Array.from({ length: 100 }, (_, i) => 'echo ' + i);
  assert.deepEqual(liv.livRemember(long, 'last'), long.slice(1).concat(['last']));
  assert.deepEqual(['', 'cat ', 'cat', 'cat\t'].map((line) => liv.livJoinInput(line, 'x')), ['x', 'cat x', 'cat x', 'cat\tx']);
});

test('lost-in-var: the score is 100 minus 3 per command over par, 10 per hint and 25 per wrong kill, at least 10', () => {
  for (const data of liv.livCases) {
    for (let commands = 0; commands < 60; commands += 7) {
      for (let hints = 0; hints <= data.hints.length; hints++) {
        for (let mistakes = 0; mistakes < 3; mistakes++) {
          assert.equal(liv.livScore(data, commands, hints, mistakes), scoreModel(data.par, commands, hints, mistakes));
        }
      }
    }
  }
  assert.equal(liv.livScore(DISK, 6, 0, 0), 100);
  assert.equal(liv.livScore(DISK, 200, 3, 2), 10);
  assert.equal(liv.livMistakes(DISK, world(DISK, '/', [2290, 2231])), 1);
  assert.equal(liv.livMistakes(PORT, world(PORT, '/', [3110])), 1);
  assert.equal(liv.livMistakes(TUTORIAL, world(TUTORIAL, '/', [3141])), 0);
});

test('lost-in-var: the cases are consistent data: every goal, hint and example works on a fresh server, and no text teaches deleting', () => {
  for (const data of liv.livCases) {
    const pids = data.procs.map((p) => p.pid);
    assert.equal(new Set(pids).size, pids.length, data.id + ': unique ids');
    assert.ok(!pids.includes(data.psPid), data.id + ': ps has an id of its own');
    assert.equal(data.procs.find((p) => p.pid === data.shellPid).user, data.user, data.id + ': the shell is the user\'s');
    assert.equal(liv.livCmdCd({ data, world: world(data, '/'), args: [data.home], stdin: null }).status, 0, data.id + ': home opens');
    assert.ok(data.mounts.some((m) => m.mount === '/'), data.id + ': a root file system');
    for (const m of data.mounts) assert.equal(liv.livEntry(data, world(data), m.mount).kind, 'dir', data.id + ' ' + m.mount);
    for (const p of data.procs) {
      if (p.frees) assert.ok(data.mounts.some((m) => m.mount === p.frees.mount));
      for (const path of p.removes || []) assert.ok(hasOwn(data.files, path));
      if (p.keep) assert.equal(p.user, data.user, 'a wrong kill must be possible to make');
    }
    for (const [path, file] of Object.entries(data.files)) {
      if (file.afterKill) assert.ok(pids.includes(file.afterKill.pid), path);
      assert.ok(Array.isArray(file.lines), path);
    }
    // Hints and examples all run on a fresh server, and no text teaches deleting.
    for (const item of data.goals.concat(data.hints).filter((x) => x.example)) {
      const result = liv.livRun(data, world(data, item.example.startsWith('tail -n 3') || item.example.startsWith('grep pid') ? '/var/log' : data.home), item.example);
      assert.equal(result.status, 0, data.id + ': ' + item.example);
    }
    const allText = JSON.stringify(data);
    assert.doesNotMatch(allText, /\brm -|rm -rf|sudo /, data.id);
    // The cause is the user's own process, the last goal of the case.
    const cause = data.goals[data.goals.length - 1].test.killed;
    assert.equal(data.procs.find((p) => p.pid === cause).user, data.user, data.id);
    assert.equal(data.goals.filter((g) => hasOwn(g.test, 'killed')).length, 1, data.id);
    for (const goal of data.goals) {
      assert.deepEqual(Object.keys(goal.test).filter((k) => !['killed', 'cwd', 'run', 'read', 'saw'].includes(k)), [], data.id + ': ' + goal.text);
    }
  }
  assert.deepEqual(liv.livCases.map((data) => data.id), ['tutorial', 'disk-full', 'port-clash']);
  assert.deepEqual(TUTORIAL.hints, [], 'the tutorial teaches through its steps');
  assert.deepEqual([DISK, PORT].map((data) => data.hints.length), [3, 3]);
  const taught = TUTORIAL.goals.map((g) => g.example.split(' ')[0]).sort();
  assert.deepEqual(taught, ['cat', 'cd', 'df', 'grep', 'kill', 'ls', 'ps', 'tail']);
  // The chips type commands this shell knows.
  for (const chip of liv.livChips) {
    const text = (chip.fill !== undefined ? chip.fill : chip.add).trim().replace(/^\| /, '');
    assert.ok(liv.livCommandNames.includes(text.split(' ')[0]), chip.label);
  }
});

// The single lines a player types to look around a case: print or tail one
// file, list one folder, ps aux, df -h, pwd, or kill one of the user's own
// processes.
function lookAroundLines(data) {
  const kills = data.procs.filter((p) => p.user === data.user && p.pid !== data.shellPid).map((p) => 'kill ' + p.pid);
  return Object.keys(data.files).flatMap((path) => ['cat ' + path, 'tail ' + path, 'tail -n 3 ' + path])
    .concat(allDirs(data).map((dir) => 'ls -la ' + dir), ['ps aux', 'df -h', 'pwd'], kills);
}

// The fewest of those lines that close the case, breadth first over the
// distinct worlds a run reaches, or null within maxDepth lines.
function shortestWin(data, lines, maxDepth) {
  const keyOf = (w) => JSON.stringify([w.cwd, w.killed.slice().sort(), w.done]);
  let frontier = [world(data)];
  const seen = new Set(frontier.map(keyOf));
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = [];
    for (const w of frontier) {
      for (const line of lines) {
        const after = liv.livRun(data, w, line).world;
        if (liv.livCheckWin(data, after)) return depth;
        const key = keyOf(after);
        if (!seen.has(key)) {
          seen.add(key);
          next.push(after);
        }
      }
    }
    frontier = next;
  }
  return null;
}

const runAll = (data, lines, start = world(data)) => lines.reduce((acc, line) => liv.livRun(data, acc, line).world, start);

test('lost-in-var: no incident closes on a guess: the shortest win shows the evidence of two logs and kills the cause (3 commands), the hinted path closes within par, and the order is free', () => {
  for (const data of [DISK, PORT]) {
    const lines = lookAroundLines(data);
    assert.ok(lines.length > 40, data.id + ': ' + lines.length + ' lines to try');
    assert.equal(shortestWin(data, lines, 3), 3, data.id + ': no run of 1 or 2 of these lines closes the case');
    // A guess from the process list: ps aux, df -h and every kill the user can make, in either order, closes nothing.
    const own = data.procs.filter((p) => p.user === data.user && p.pid !== data.shellPid).map((p) => p.pid);
    assert.equal(own.length, 2, data.id + ': the cause and one process that is not');
    for (const order of [own, own.slice().reverse()]) {
      const w = runAll(data, ['ps aux', 'df -h'].concat(order.map((pid) => 'kill ' + pid)));
      assert.equal(liv.livCheckWin(data, w), false, data.id + ' ' + order.join(' '));
      assert.deepEqual(w.done, [2], data.id + ': only the kill goal');
    }
    // The path the hints lead along, then the kill: within par.
    const cause = data.goals[data.goals.length - 1].test.killed;
    const path = data.hints.map((h) => h.example).concat(['kill ' + cause]);
    assert.equal(liv.livCheckWin(data, runAll(data, path)), true, data.id);
    assert.ok(path.length <= data.par, data.id + ': ' + path.length + ' commands within par ' + data.par);
    // The evidence stays readable after the kill, so killing first never leaves a case that cannot close.
    const killed = world(data, data.home, [cause]);
    data.goals.forEach((goal, i) => {
      if (!goal.test.saw) return;
      const readers = Object.keys(data.files).filter((file) => liv.livRun(data, killed, 'cat ' + file).world.done.includes(i));
      assert.ok(readers.length >= 1, data.id + ': ' + goal.text);
    });
    assert.equal(liv.livCheckWin(data, runAll(data, ['kill ' + cause].concat(data.hints.map((h) => h.example)))), true, data.id + ': kill first');
  }
  // The tutorial: its examples in order close it in exactly par.
  const steps = TUTORIAL.goals.map((g) => g.example);
  assert.equal(steps.length, TUTORIAL.par);
  assert.equal(liv.livCheckWin(TUTORIAL, runAll(TUTORIAL, steps)), true);
  assert.equal(liv.livCheckWin(TUTORIAL, runAll(TUTORIAL, steps.slice(0, -1))), false);
});

// ── Pure logic: saves ────────────────────────────────────────────────────────

test('lost-in-var: livParseState reads a save of the current format field for field', () => {
  const state = liv.livParseState(SAMPLE_STATE);
  assert.equal(state.caseId, 'disk-full');
  assert.deepEqual(state.sessions, JSON.parse(SAMPLE_STATE).sessions);
  assert.equal(liv.livSerializeState(state), SAMPLE_STATE);
  const fresh = liv.livParseState(null);
  assert.equal(fresh.caseId, 'tutorial');
  for (const data of liv.livCases) assert.deepEqual(fresh.sessions[data.id], { cwd: data.home, killed: [], done: [], history: [], commands: 0, hints: 0 });
  assert.equal(liv.livSerializeState(fresh), '{"v":1,"case":"tutorial","sessions":{' +
    '"tutorial":{"cwd":"/home/ops","killed":[],"done":[],"history":[],"commands":0,"hints":0},' +
    '"disk-full":{"cwd":"/home/ops","killed":[],"done":[],"history":[],"commands":0,"hints":0},' +
    '"port-clash":{"cwd":"/home/deploy","killed":[],"done":[],"history":[],"commands":0,"hints":0}}}');
});

test('lost-in-var: a session save falls back field by field', () => {
  const parse = (raw, data = DISK) => liv.livParseSession(data, raw);
  const base = { cwd: '/var/tmp', killed: [2290], done: [], history: ['ls'], commands: 4, hints: 1 };
  assert.deepEqual(parse(base), base);
  const fresh = liv.livFreshSession(DISK);
  for (const raw of [null, undefined, 7, 'x', [], true]) assert.deepEqual(parse(raw), fresh, JSON.stringify(raw));
  const field = (changes) => parse(Object.assign({}, base, changes));
  // killed: the user's own processes of the case, once, never the shell or someone else's.
  assert.deepEqual(field({ killed: [2290, 2290, 1544, 1022, 9999, '2231', 2231] }).killed, [2290, 2231]);
  assert.deepEqual(field({ killed: 'x' }).killed, []);
  // cwd: a normalised folder the user can open.
  for (const cwd of ['/var/tmp/', 'var/tmp', '/var/../var/tmp', '/root', '/nope', '/etc/hostname', 7, null, '~']) {
    assert.equal(field({ cwd }).cwd, '/home/ops', JSON.stringify(cwd));
  }
  assert.equal(field({ cwd: '/' }).cwd, '/');
  // done: goal numbers of the case, once; a kill that meets a goal marks it.
  assert.deepEqual(parse({ done: [0, 0, 1, -1, 0.5, '0'] }, TUTORIAL).done, [0, 1]);
  assert.deepEqual(parse({ done: [7, 3] }, TUTORIAL).done, [3, 7], 'kept in order');
  assert.deepEqual(parse({ done: 'x', killed: [3141] }, TUTORIAL).done, [7]);
  assert.deepEqual(parse({ cwd: '/var/log' }, TUTORIAL).done, [2], 'the folder reached meets its goal');
  assert.deepEqual(field({ done: [3, 1] }).done, [1], 'case 2 has three goals');
  assert.deepEqual(field({ done: [0, 1], killed: [2231] }).done, [0, 1, 2], 'the evidence seen and the kill');
  // history: strings of up to 300 characters, the last 100.
  assert.deepEqual(field({ history: ['ls', '', 7, null, 'x'.repeat(301), 'x'.repeat(300), 'pwd'] }).history, ['ls', 'x'.repeat(300), 'pwd']);
  assert.deepEqual(field({ history: Array.from({ length: 130 }, (_, i) => 'l' + i) }).history, Array.from({ length: 100 }, (_, i) => 'l' + (i + 30)));
  assert.deepEqual(field({ history: {} }).history, []);
  // commands: a whole count up to 99999, else the history length; hints: up to the case's hints, else 0.
  for (const commands of [-1, 1.5, '4', null, 100000, NaN, Infinity]) assert.equal(field({ commands, history: ['a', 'b'] }).commands, 2, String(commands));
  assert.equal(field({ commands: 99999 }).commands, 99999);
  for (const hints of [-1, 4, '1', 1.5, null]) assert.equal(field({ hints }).hints, 0, String(hints));
  assert.equal(field({ hints: 3 }).hints, 3);
  assert.equal(parse({ hints: 1 }, TUTORIAL).hints, 0, 'the tutorial has no hints');
});

test('lost-in-var: liv-state with an unknown case, no sessions or foreign fields keeps what it can', () => {
  const parse = (value) => liv.livParseState(typeof value === 'string' ? value : JSON.stringify(value));
  for (const text of ['{', '[]', 'null', '7', '"x"', '', 'undefined']) {
    const state = liv.livParseState(text);
    assert.equal(state.caseId, 'tutorial', text);
    assert.deepEqual(state.sessions, liv.livParseState(null).sessions, text);
  }
  assert.equal(parse({ case: 'nope' }).caseId, 'tutorial');
  assert.equal(parse({ case: 'port-clash' }).caseId, 'port-clash');
  assert.equal(parse({ case: ['port-clash'] }).caseId, 'tutorial');
  assert.deepEqual(parse({ case: 'disk-full', sessions: [] }).sessions, liv.livParseState(null).sessions);
  const mixed = parse({ v: 9, case: 'disk-full', extra: 1, sessions: { 'disk-full': { cwd: '/var', commands: 2 }, other: { cwd: '/' } } });
  assert.deepEqual(mixed.sessions['disk-full'], { cwd: '/var', killed: [], done: [], history: [], commands: 2, hints: 0 });
  assert.deepEqual(Object.keys(mixed.sessions), ['tutorial', 'disk-full', 'port-clash']);
});

test('lost-in-var: liv-progress keeps a score from 10 to 100 per case, each count on its own, and merges two tabs by the higher score', () => {
  assert.deepEqual(liv.livParseProgress(SAMPLE_PROGRESS), { tutorial: { score: 97, commands: 9, hints: 0 } });
  assert.equal(liv.livSerializeProgress(liv.livParseProgress(SAMPLE_PROGRESS)), SAMPLE_PROGRESS);
  for (const text of [null, '{', '[]', '{"cases":[]}', '{"cases":7}', '{"cases":{"tutorial":7}}', '{"cases":{"tutorial":{"score":5}}}',
    '{"cases":{"tutorial":{"score":101}}}', '{"cases":{"tutorial":{"score":"90"}}}', '{"cases":{"nope":{"score":90}}}']) {
    assert.deepEqual(liv.livParseProgress(text), {}, String(text));
  }
  assert.deepEqual(liv.livParseProgress('{"cases":{"disk-full":{"score":10,"commands":-1,"hints":4},"port-clash":{"score":100,"commands":3,"hints":3}}}'),
    { 'disk-full': { score: 10, commands: null, hints: null }, 'port-clash': { score: 100, commands: 3, hints: 3 } });
  assert.deepEqual(liv.livParseProgress('{"cases":{"tutorial":{"score":90,"hints":1}}}'), { tutorial: { score: 90, commands: null, hints: null } });
  const a = { tutorial: { score: 80, commands: 9, hints: 0 }, 'disk-full': { score: 50, commands: 9, hints: 1 } };
  const b = { tutorial: { score: 90, commands: 8, hints: 0 }, 'disk-full': { score: 50, commands: 7, hints: 0 }, 'port-clash': { score: 60, commands: 9, hints: 1 } };
  const merged = liv.livMergeProgress(a, b);
  assert.deepEqual(merged, { tutorial: b.tutorial, 'disk-full': a['disk-full'], 'port-clash': b['port-clash'] });
  assert.equal(merged['disk-full'], a['disk-full'], 'a tie keeps the first');
  assert.deepEqual(liv.livMergeProgress({}, {}), {});
  assert.deepEqual(liv.livMergeProgress(a, {}), a);
  assert.equal(liv.livSerializeProgress(merged), '{"v":1,"cases":{"tutorial":{"score":90,"commands":8,"hints":0},' +
    '"disk-full":{"score":50,"commands":9,"hints":1},"port-clash":{"score":60,"commands":9,"hints":1}}}');
});

test('lost-in-var: the storage warning names every key that failed and what it holds', () => {
  assert.equal(liv.livStorageWarning({}), '');
  assert.equal(liv.livStorageWarning({ 'liv-state': 'blocked', 'liv-progress': 'blocked' }),
    'Browser storage is blocked: liv-state and liv-progress cannot be read or saved, so your sessions and your points will not be kept after a reload.');
  assert.equal(liv.livStorageWarning({ 'liv-state': 'full' }),
    'Browser storage is full: liv-state was not saved, so a reload loses the latest changes to your sessions.');
  assert.equal(liv.livStorageWarning({ 'liv-state': 'full', 'liv-progress': 'full' }),
    'Browser storage is full: liv-state and liv-progress were not saved, so a reload loses the latest changes to your sessions and your points.');
  assert.equal(liv.livStorageWarning({ 'liv-state': 'full', 'liv-progress': 'blocked' }),
    'Browser storage is blocked: liv-progress cannot be read or saved, so your points will not be kept after a reload. ' +
    'Browser storage is full: liv-state was not saved, so a reload loses the latest changes to your sessions.');
});

// ── The page ─────────────────────────────────────────────────────────────────

test('lost-in-var: loading the script under Node runs no init: no lookup, listener, timer or save', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.livInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['liv-chips'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('lost-in-var: a first visit shows case 1 with its steps, the motd, the chips and the keys, binds every listener once and saves nothing', (t) => {
  const v = openPage(t);
  assert.equal(localStorage.length, 0, 'nothing is written before the first command');
  assert.equal(v.text('case-title'), 'Case 1: First shift');
  assert.equal(v.text('brief'), TUTORIAL.brief);
  assert.equal(v.text('term-title'), 'ops@training-01');
  assert.equal(v.text('prompt'), 'ops@training-01:~$');
  assert.deepEqual(v.lines(), TUTORIAL.motd.map((line) => ['liv-line liv-line--sys', line]));
  assert.deepEqual(v.goals(), TUTORIAL.goals.map((goal, i) => ['liv-goal' + (i === 0 ? ' liv-goal--next' : ''), goal.text]));
  const goal = v.el('goals').children[0];
  assert.equal(goal.children[0].textContent, '[ ]');
  assert.deepEqual([goal.children[2].className, goal.children[2].textContent, goal.children[2].getAttribute('data-fill'), goal.children[2].getAttribute('aria-label'), goal.children[2].getAttribute('type')],
    ['liv-chip liv-chip--example', 'ls', 'ls', 'Type ls', 'button']);
  assert.equal(v.text('score'), '0 commands (par 8) · hints 0/0 · 0 wrong kills');
  assert.equal(v.text('hint'), 'No hints here');
  assert.equal(v.el('hint').disabled, true);
  assert.equal(v.text('restart'), 'Restart case');
  assert.equal(v.hidden('next'), true);
  assert.equal(v.hidden('hints'), true);
  assert.equal(v.hidden('names-row'), true);
  assert.equal(v.hidden('warning'), true);
  assert.equal(v.toast(), null);
  assert.equal(v.text('status'), 'Type a command and press Enter, or tap the chips under the terminal. help lists the commands.');
  assert.deepEqual(v.cases().map((b) => [b.className, b.getAttribute('data-case'), b.getAttribute('aria-pressed'), b.getAttribute('type'),
    b.children.map((c) => c.className + ':' + c.textContent).join('|'), b.getAttribute('aria-label')]), [
    ['liv-case-btn', 'tutorial', 'true', 'button', 'liv-case-num:Case 1|liv-case-name:First shift|liv-case-meta:New', 'Case 1: First shift, New'],
    ['liv-case-btn', 'disk-full', 'false', 'button', 'liv-case-num:Case 2|liv-case-name:No space left|liv-case-meta:New', 'Case 2: No space left, New'],
    ['liv-case-btn', 'port-clash', 'false', 'button', 'liv-case-num:Case 3|liv-case-name:Address in use|liv-case-meta:New', 'Case 3: Address in use, New']
  ]);
  assert.deepEqual(v.el('chips').children.map((c) => [c.textContent, c.getAttribute('data-fill'), c.getAttribute('data-add'), c.getAttribute('aria-label')]),
    liv.livChips.map((chip) => [chip.label, chip.fill === undefined ? null : chip.fill, chip.add === undefined ? null : chip.add, (chip.fill === undefined ? 'Add ' : 'Type ') + chip.label]));
  // One listener per control, the storage event on window, and no key listener outside the command field.
  for (const [name, type] of [['input', 'keydown'], ['run', 'click'], ['complete', 'click'], ['hist-up', 'click'], ['hist-down', 'click'],
    ['hint', 'click'], ['restart', 'click'], ['next', 'click'], ['cases', 'click'], ['chips', 'click'], ['names', 'click'], ['goals', 'click'], ['hints', 'click'],
    ['chips', 'pointerdown'], ['names', 'pointerdown'], ['goals', 'pointerdown'], ['hints', 'pointerdown']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(document.body), 0);
  assert.equal(listenerCount(window), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
});

test('lost-in-var: while the page is still loading the game waits for DOMContentLoaded', (t) => {
  const v = openPage(t, { storage: { state: SAMPLE_STATE }, options: { readyState: 'loading' } });
  assert.equal(v.text('status'), 'Connecting...');
  assert.equal(v.el('chips').children.length, 0);
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(v.input, 'keydown'), 0);
  v.ready();
  assert.equal(v.text('prompt'), 'ops@web-01:/var/tmp$');
  assert.equal(listenerCount(v.input, 'keydown'), 1);
});

test('lost-in-var: init runs once: a second call binds nothing twice', (t) => {
  enableClock(t);
  const { exports: fresh, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  fresh.livInit();
  fresh.livInit();
  assert.equal(els['liv-chips'].children.length, liv.livChips.length);
  assert.equal(els['liv-cases'].children.length, 3);
  assert.equal(listenerCount(els['liv-input'], 'keydown'), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  assert.equal(fresh.livRuntime.els.input, els['liv-input']);
});

test('lost-in-var: the tutorial on the page: each step typed with Enter ticks its goal, and the last closes the case with 100 points', (t) => {
  const v = openPage(t);
  TUTORIAL.goals.forEach((goal, i) => {
    assert.match(v.goals()[i][0], /liv-goal--next/);
    const ev = v.type(goal.example);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(v.input.value, '', 'the field is emptied');
    assert.equal(v.goals()[i][0], 'liv-goal liv-goal--done');
    assert.equal(v.el('goals').children[i].children[0].textContent, '[x]');
    assert.equal(v.el('goals').children[i].children.length, 2, 'a done step offers no chip');
  });
  const screen = v.screen();
  assert.ok(screen.includes('ops@training-01:~$ ls'));
  assert.ok(screen.includes('todo.txt  welcome.txt'));
  assert.ok(screen.includes('ops@training-01:/var/log$ kill 3141'), 'the prompt follows cd');
  assert.deepEqual(v.lines().slice(-4), [
    ['liv-line liv-line--sys', '[monitor] beeper (pid 3141) stopped. Silence on training-01.'],
    ['liv-line liv-line--win', 'Case closed: training-01 is quiet again.'],
    ['liv-line liv-line--win', TUTORIAL.win[1]],
    ['liv-line liv-line--sys', '# Score: 100 points: 8 commands (par 8), 0 hints, 0 wrong kills.']
  ]);
  assert.equal(v.text('status'), 'Case closed with 100 points: 8 commands (par 8), 0 hints, 0 wrong kills. New record.');
  assert.equal(v.toast(), 'Case closed: 100 points');
  assert.equal(localStorage.getItem(PROGRESS_KEY), '{"v":1,"cases":{"tutorial":{"score":100,"commands":8,"hints":0}}}');
  assert.equal(v.text('score'), 'Solved: 100 points · 8 commands (par 8) · hints 0/0 · 0 wrong kills · record 100');
  assert.equal(v.hidden('next'), false);
  assert.equal(v.text('next'), 'Next case: No space left');
  assert.equal(v.cases()[0].className, 'liv-case-btn liv-case-btn--solved');
  assert.equal(v.cases()[0].children[2].textContent, 'Solved: 100 points');
  const state = v.state().sessions.tutorial;
  assert.deepEqual(state, { cwd: '/var/log', killed: [3141], done: [0, 1, 2, 3, 4, 5, 6, 7], history: TUTORIAL.goals.map((g) => g.example), commands: 8, hints: 0 });
  // A closed case keeps its score: later commands still run but count nothing.
  v.type('ls');
  v.type('nope');
  assert.equal(v.state().sessions.tutorial.commands, 8);
  assert.equal(v.screen().slice(-2)[0], 'bash: nope: command not found');
  assert.equal(localStorage.getItem(PROGRESS_KEY), '{"v":1,"cases":{"tutorial":{"score":100,"commands":8,"hints":0}}}');
  // Next opens case 2.
  v.click('next');
  assert.equal(v.text('case-title'), 'Case 2: No space left');
  assert.equal(v.text('status'), 'Now on case 2 (No space left), logged in to web-01 as ops.');
  assert.deepEqual(v.screen(), DISK.motd);
  assert.equal(v.state().case, 'disk-full');
});

test('lost-in-var: the command field owns its keys: Enter once, Up / Down through the history, Tab only with text; modifiers and other keys pass', (t) => {
  const v = openPage(t);
  const input = v.input;
  v.type('pwd');
  assert.deepEqual(v.screen().slice(-2), ['ops@training-01:~$ pwd', '/home/ops']);
  // A held Enter acts once.
  let ev = v.type('ls', { repeat: true });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(input.value, 'ls', 'not run');
  // Shortcuts, composing text and keys a page script handled stay with the browser.
  for (const props of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    for (const key of ['Enter', 'ArrowUp', 'Tab']) {
      ev = v.key(key, props);
      assert.equal(ev.defaultPrevented, false, key + ' ' + JSON.stringify(props));
      assert.equal(input.value, 'ls');
    }
  }
  const handled = (event) => event.preventDefault();
  document.addEventListener('keydown', handled, true);
  v.key('Enter');
  document.removeEventListener('keydown', handled, true);
  assert.equal(input.value, 'ls');
  assert.equal(v.key('a').defaultPrevented, false);
  assert.equal(v.key(undefined).defaultPrevented, false);
  // History: Up from a draft, Down back to it; Shift+Up selects text instead.
  v.type('cd /var');
  input.value = 'draft';
  assert.equal(v.key('ArrowUp').defaultPrevented, true);
  assert.equal(input.value, 'cd /var');
  v.key('ArrowUp', { repeat: true });
  assert.equal(input.value, 'pwd');
  v.key('ArrowUp');
  assert.equal(input.value, 'pwd', 'the oldest line stays');
  v.key('ArrowDown');
  assert.equal(input.value, 'cd /var');
  v.key('ArrowDown');
  assert.equal(input.value, 'draft');
  assert.equal(v.key('ArrowUp', { shiftKey: true }).defaultPrevented, false);
  assert.equal(input.value, 'draft');
  // Tab: on an empty field and with Shift it moves the focus on; with text it completes.
  input.value = '';
  assert.equal(v.key('Tab').defaultPrevented, false);
  input.value = 'cat l';
  assert.equal(v.key('Tab').defaultPrevented, true);
  assert.equal(input.value, 'cat log/');
  assert.equal(v.key('Tab', { shiftKey: true }).defaultPrevented, false);
  input.value = 'cat l';
  assert.equal(v.key('Tab', { repeat: true }).defaultPrevented, true, 'a held Tab never leaves the field');
  assert.equal(input.value, 'cat l');
  input.value = 'c';
  v.key('Tab');
  assert.deepEqual(v.screen().slice(-2), ['ops@training-01:/var$ c', 'cat  cd  clear']);
  input.value = 'cat q';
  v.key('Tab');
  assert.equal(v.toast(), 'Nothing in /var starts with \'q\'.');
  assert.equal(v.state().sessions.tutorial.commands, 2, 'completion counts nothing');
  // Keys typed into host-page fields, links and buttons never reach the game.
  const before = v.screen().length;
  input.value = 'pwd';
  for (const tag of ['input', 'a', 'button', 'textarea', 'select']) {
    const host = v.page.add('host-' + tag, tag);
    focusElement(host);
    for (const key of ['Enter', 'ArrowUp', 'Tab']) assert.equal(pressKey(key, { target: host }).defaultPrevented, false, tag + ' ' + key);
  }
  assert.equal(pressKey('Enter', { target: document.body }).defaultPrevented, false);
  assert.equal(v.screen().length, before);
  assert.equal(input.value, 'pwd');
});

test('lost-in-var: on a phone a case is solved by taps alone: command chips, names from the output, and the Run key', (t) => {
  const v = openPage(t);
  v.cases()[1].click();
  // A tap: the finger's pointerdown, then the click.  The focus never moves to the field, so no on-screen keyboard opens.
  const tap = (el) => {
    fire(el, 'pointerdown', { pointerType: 'touch' });
    el.click();
    assert.notEqual(document.activeElement, v.input, 'a tap leaves the focus alone');
  };
  const tapChip = (label) => tap(v.chip(label));
  const tapName = (name) => tap(v.el('names').children.find((el) => el.textContent === name));
  const run = () => v.click('run');
  tapChip('df -h');
  assert.equal(v.input.value, 'df -h');
  run();
  assert.deepEqual(v.names(), ['/', '/boot/efi', '/run']);
  assert.equal(v.hidden('names-row'), false);
  tapChip('cd');
  assert.equal(v.input.value, 'cd ');
  tapName('/');
  run();
  assert.equal(v.text('prompt'), 'ops@web-01:/$');
  tapChip('ls');
  run();
  assert.deepEqual(v.names(), ['boot/', 'etc/', 'home/', 'opt/', 'root/', 'run/', 'tmp/', 'var/']);
  tapChip('cd');
  tapName('var/');
  run();
  tapChip('ls');
  run();
  assert.deepEqual(v.names(), ['lib/', 'log/', 'tmp/']);
  tapChip('cd');
  tapName('tmp/');
  run();
  tapChip('ls -lah');
  run();
  assert.deepEqual(v.names(), ['apt-cache.bin', 'export-2231.spool']);
  assert.ok(v.screen().includes('-rw-r--r-- 1 ops  ops   17G Nov  6 08:41 export-2231.spool'));
  tapChip('ps aux');
  tapChip('| grep');
  assert.equal(v.input.value, 'ps aux | grep ');
  v.input.value = '';
  tapChip('ps aux');
  run();
  assert.deepEqual(v.names(), ['1', '488', '512', '1020', '1022', '1190', '2231', '2290']);
  // The logs, by names from listings: two folders in one ls, then two logs in one tail.
  tapChip('cd ..');
  run();
  tapChip('ls');
  run();
  tapChip('ls');
  tapName('log/');
  run();
  assert.deepEqual(v.names(), ['log/auth.log', 'log/nginx/', 'log/shop/']);
  tapChip('ls');
  tapName('log/nginx/');
  tapName('log/shop/');
  assert.equal(v.input.value, 'ls log/nginx/ log/shop/');
  run();
  tapChip('tail');
  tapName('log/nginx/error.log');
  tapName('log/shop/export.log');
  run();
  assert.deepEqual(v.goals().map((g) => g[0]), ['liv-goal liv-goal--done', 'liv-goal liv-goal--done', 'liv-goal liv-goal--next']);
  tapChip('kill');
  tapName('2231');
  assert.equal(v.input.value, 'kill 2231');
  run();
  assert.equal(v.text('status'), 'Case closed with ' + scoreModel(6, 14, 0, 0) + ' points: 14 commands (par 6), 0 hints, 0 wrong kills. New record.');
  assert.equal(v.progress().cases['disk-full'].score, 76);
  // The names row empties after a command that names nothing; a tap beside the chips does nothing.
  tapChip('cd');
  run();
  assert.equal(v.hidden('names-row'), true);
  assert.deepEqual(v.names(), []);
  v.input.value = 'x';
  tap(v.el('chips'));
  v.el('names').click();
  v.el('goals').click();
  v.el('cases').click();
  assert.equal(v.input.value, 'x');
  assert.equal(v.text('case-title'), 'Case 2: No space left');
});

test('lost-in-var: a chip clicked with a mouse or the keyboard hands the focus back to the command field, so Enter runs the line; a tap leaves the focus alone', (t) => {
  const v = openPage(t);
  // Mouse: the button takes the focus on mousedown, the click gives it back to the field.
  const ps = v.chip('ps aux');
  fire(ps, 'pointerdown', { pointerType: 'mouse' });
  focusElement(ps);
  ps.click();
  assert.equal(document.activeElement, v.input);
  assert.equal(v.input.value, 'ps aux');
  pressKey('Enter');
  assert.deepEqual(v.screen().slice(-1), ['ops  3141  2.0  0.1 /usr/local/bin/beeper --every 1s --volume 11'], 'Enter right after the chip ran it');
  assert.equal(v.input.value, '');
  // Keyboard: Tab to a chip and press Enter on it; the next Enter runs the line.
  const df = v.chip('df -h');
  focusElement(df, { keyboard: true });
  pressKey('Enter');
  assert.equal(document.activeElement, v.input);
  assert.equal(v.input.value, 'df -h');
  pressKey('Enter');
  assert.deepEqual(v.screen().slice(-1), ['tmpfs      1.0G 1.3M 1023M   1% /run']);
  // A click that carries its pointer type (as in Chrome), and a tap whose click does not (as in Safari): the focus stays on the chip.
  const ls = v.chip('ls');
  focusElement(ls);
  fire(ls, 'click', { pointerType: 'touch', detail: 1 });
  assert.equal(document.activeElement, ls);
  assert.equal(v.input.value, 'ls');
  fire(v.chip('pwd'), 'pointerdown', { pointerType: 'touch' });
  v.chip('pwd').click();
  assert.equal(document.activeElement, ls);
  assert.equal(v.input.value, 'pwd');
  // The tap is forgotten after its click: a pen or a later click without a pointerdown focuses the field again.
  v.chip('cd ..').click();
  assert.equal(document.activeElement, v.input);
  focusElement(ls);
  fire(ls, 'pointerdown', { pointerType: 'pen' });
  ls.click();
  assert.equal(document.activeElement, v.input);
  // Names and the example chips of the steps behave the same.
  v.type('ls');
  const name = v.el('names').children[0];
  focusElement(name);
  name.click();
  assert.equal(document.activeElement, v.input);
  assert.equal(v.input.value, 'todo.txt');
  const example = v.el('goals').children[1].children[2];
  focusElement(example);
  example.click();
  assert.equal(document.activeElement, v.input);
  assert.equal(v.input.value, 'cat welcome.txt');
});

test('lost-in-var: the arrow and Tab keys on screen browse the history and complete; a chip never overfills the line', (t) => {
  const v = openPage(t);
  v.type('ls');
  v.type('pwd');
  v.input.value = 'cat w';
  v.click('hist-up');
  assert.equal(v.input.value, 'pwd');
  v.click('hist-up');
  assert.equal(v.input.value, 'ls');
  v.click('hist-down');
  v.click('hist-down');
  assert.equal(v.input.value, 'cat w');
  v.click('complete');
  assert.equal(v.input.value, 'cat welcome.txt ');
  v.input.value = '';
  v.click('complete');
  assert.deepEqual(v.screen().slice(-1), [liv.livCommandNames.join('  ')], 'on an empty line the Tab key lists the commands');
  v.input.value = 'zz';
  v.click('complete');
  assert.equal(v.toast(), 'No command starts with \'zz\'. Type help for the list.');
  // A chip that would push the line past 300 characters is refused, naming the limit.
  v.type('ls');
  v.input.value = 'x'.repeat(290);
  v.tapName('welcome.txt');
  assert.equal(v.toast(), 'The command line holds at most 300 characters: run it or clear it first.');
  assert.equal(v.input.value, 'x'.repeat(290));
  v.input.value = 'x'.repeat(280);
  v.tapName('welcome.txt');
  assert.equal(v.input.value, 'x'.repeat(280) + ' welcome.txt');
  // An empty line echoes the prompt and counts nothing.
  v.input.value = '  ';
  v.click('run');
  assert.deepEqual(v.screen().slice(-1), ['ops@training-01:~$']);
  assert.equal(v.state().sessions.tutorial.commands, 3);
});

test('lost-in-var: hints cost 10 points each, show in the terminal and the brief with a chip that types their example', (t) => {
  const v = openPage(t);
  v.cases()[1].click();
  assert.equal(v.text('hint'), 'Hint 1/3 (-10)');
  assert.equal(v.el('hint').disabled, false);
  DISK.hints.forEach((hint, i) => {
    v.click('hint');
    assert.deepEqual(v.lines().slice(-1), [['liv-line liv-line--sys', '# Hint ' + (i + 1) + '/3 (-10 points): ' + hint.text]]);
    assert.equal(v.text('status'), 'Hint ' + (i + 1) + ' of case 2 (No space left) shown: it costs 10 points when you close the case.');
    const item = v.el('hints').children[i];
    assert.deepEqual([item.className, item.children[0].className, item.children[0].textContent], ['liv-hint-item', 'liv-hint-text', 'Hint ' + (i + 1) + ': ' + hint.text]);
    item.children[1].click();
    assert.equal(v.input.value, hint.example);
  });
  assert.equal(v.hidden('hints'), false);
  assert.equal(v.text('hint'), 'No hints left');
  assert.equal(v.el('hint').disabled, true);
  assert.equal(v.state().sessions['disk-full'].hints, 3);
  assert.equal(v.state().sessions['disk-full'].commands, 0, 'hints are not commands');
  assert.equal(v.text('score'), '0 commands (par 6) · hints 3/3 · 0 wrong kills');
  // Restart keeps the hints seen and their cost: without commands it needs no second press, and nothing about the hints is lost.
  v.click('restart');
  assert.equal(v.text('status'), 'Restarted case 2 (No space left) on a fresh copy of web-01, and the hints you saw (3) still cost 10 points each.');
  assert.deepEqual(v.screen().slice(-1), ['# Case restarted on a fresh copy of web-01, and the hints you saw (3) still cost 10 points each.']);
  assert.equal(v.el('hints').children.length, 3);
  assert.equal(v.text('hint'), 'No hints left');
  assert.equal(v.state().sessions['disk-full'].hints, 3);
  for (const hint of DISK.hints) v.type(hint.example);
  v.type('kill 2231');
  assert.equal(v.text('status'), 'Case closed with 70 points: 4 commands (par 6), 3 hints, 0 wrong kills. New record.');
  // A replay after the win still pays for them.
  v.click('restart');
  v.type('tail -n 3 /var/log/nginx/error.log');
  v.type('cat /var/log/shop/export.log');
  v.type('kill 2231');
  assert.equal(v.text('status'), 'Case closed with 70 points: 3 commands (par 6), 3 hints, 0 wrong kills. Your record stays 70 points.');
  assert.equal(v.progress().cases['disk-full'].score, 70);
  // Case 3: one hint, a command, Restart with its second press; the hint is still charged after a reload.
  v.cases()[2].click();
  v.click('hint');
  v.type('pwd');
  v.click('restart');
  assert.equal(v.text('status'), 'Restart case 3 (Address in use)? Press Restart again within 4 s to drop its 1 command, and the hints you saw (1) still cost 10 points each.');
  v.click('restart');
  assert.deepEqual(v.state().sessions['port-clash'], { cwd: '/home/deploy', killed: [], done: [], history: [], commands: 0, hints: 1 });
  const again = reload(t, v);
  assert.equal(again.text('hint'), 'Hint 2/3 (-10)');
  for (const line of ['tail /var/log/app/release-42.log', 'grep 8080 /var/log/app/release-41.log', 'kill 3107']) again.type(line);
  assert.equal(again.text('status'), 'Case closed with 90 points: 3 commands (par 6), 1 hint, 0 wrong kills. New record.');
});

test('lost-in-var: killing the wrong process costs 25 points; the best score of a case is kept across replays', (t) => {
  const v = openPage(t);
  v.cases()[2].click();
  v.type('kill 3110');
  assert.deepEqual(v.screen().slice(-1), [PORT.procs.find((p) => p.pid === 3110).onKill[0]]);
  assert.equal(v.text('score'), '1 command (par 6) · hints 0/3 · 1 wrong kill');
  v.type('kill 4410');
  assert.deepEqual(v.screen().slice(-1), ['bash: kill: (4410) - Operation not permitted']);
  v.type('tail /var/log/app/release-42.log');
  v.type('grep 8080 /var/log/app/release-41.log');
  assert.deepEqual(v.goals().map((g) => g[0]), ['liv-goal liv-goal--done', 'liv-goal liv-goal--done', 'liv-goal liv-goal--next']);
  v.type('kill 3107');
  assert.equal(v.text('status'), 'Case closed with 75 points: 5 commands (par 6), 0 hints, 1 wrong kill. New record.');
  assert.ok(v.screen().includes('[monitor] launcher.js: release 42 bound 0.0.0.0:8080, health check 200 OK.'));
  v.type('tail -n 2 /var/log/app/release-42.log');
  assert.deepEqual(v.screen().slice(-2), ['09:40:03 server.js 42 listening on 0.0.0.0:8080', '09:40:04 health check /healthz: 200 OK']);
  // A closed case restarts at once; a better run raises the record, a worse one keeps it.  The kill may come first.
  v.click('restart');
  assert.equal(v.text('status'), 'Restarted case 3 (Address in use) on a fresh copy of app-03.');
  v.type('kill 3107');
  assert.equal(v.hidden('next'), true, 'stopped, but the evidence is still missing');
  assert.equal(v.text('score'), '1 command (par 6) · hints 0/3 · 0 wrong kills · record 75');
  v.type('grep -r EADDRINUSE /var/log/app');
  v.type('cat /var/log/app/deploy.log');
  assert.equal(v.text('status'), 'Case closed with 100 points: 3 commands (par 6), 0 hints, 0 wrong kills. New record.');
  v.click('restart');
  v.type('kill 3110');
  v.type('tail /var/log/app/release-42.log');
  v.type('grep 8080 /var/log/app/release-41.log');
  v.type('kill 3107');
  assert.equal(v.text('status'), 'Case closed with 75 points: 4 commands (par 6), 0 hints, 1 wrong kill. Your record stays 100 points.');
  assert.equal(v.progress().cases['port-clash'].score, 100);
  assert.equal(v.text('score'), 'Solved: 75 points · 4 commands (par 6) · hints 0/3 · 1 wrong kill · record 100');
  // The last case offers no next case, and its hidden button does nothing.
  assert.equal(v.hidden('next'), true);
  assert.equal(v.text('next'), 'Next case');
  v.click('next');
  assert.equal(v.text('case-title'), 'Case 3: Address in use');
});

test('lost-in-var: Restart needs a second press within 4 s once a case has commands, and starts the server over', (t) => {
  const v = openPage(t);
  v.type('cd /var/log');
  v.click('restart');
  assert.equal(v.text('restart'), 'Press again to restart');
  assert.equal(v.text('status'), 'Restart case 1 (First shift)? Press Restart again within 4 s to drop its 1 command.');
  assert.equal(v.state().sessions.tutorial.commands, 1, 'nothing lost yet');
  t.mock.timers.tick(4000);
  assert.equal(v.text('restart'), 'Restart case');
  assert.equal(v.text('status'), 'Restart cancelled: case 1 (First shift) goes on.');
  v.click('restart');
  t.mock.timers.tick(3999);
  v.click('restart');
  assert.equal(v.text('restart'), 'Restart case');
  assert.deepEqual(v.state().sessions.tutorial, liv.livFreshSession(TUTORIAL));
  assert.deepEqual(v.screen(), TUTORIAL.motd.concat(['# Case restarted on a fresh copy of training-01.']));
  assert.equal(v.text('prompt'), 'ops@training-01:~$');
  assert.equal(v.goals()[2][0], 'liv-goal');
  t.mock.timers.tick(5000);
  assert.equal(v.text('status'), 'Restarted case 1 (First shift) on a fresh copy of training-01.', 'the old confirmation timer is gone');
  // Without commands it restarts at once; switching cases drops a pending confirmation.
  v.click('restart');
  assert.equal(v.text('status'), 'Restarted case 1 (First shift) on a fresh copy of training-01.');
  v.type('ls');
  v.click('restart');
  v.cases()[1].click();
  v.cases()[0].click();
  assert.equal(v.text('restart'), 'Restart case');
  v.click('restart');
  assert.equal(v.text('restart'), 'Press again to restart', 'a new first press');
});

test('lost-in-var: every case keeps its own session, screen and history; the case buttons show the progress', (t) => {
  const v = openPage(t);
  v.type('cd /var/log');
  v.type('ls');
  v.cases()[2].click();
  assert.equal(v.text('prompt'), 'deploy@app-03:~$');
  assert.deepEqual(v.screen(), PORT.motd);
  assert.deepEqual(v.cases().map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  assert.equal(v.cases()[0].children[2].textContent, 'In progress: 2 commands');
  v.type('pwd');
  v.key('ArrowUp');
  assert.equal(v.input.value, 'pwd', 'the history of case 3');
  v.cases()[0].click();
  assert.equal(v.input.value, '', 'switching clears the field');
  assert.equal(v.text('prompt'), 'ops@training-01:/var/log$');
  assert.deepEqual(v.screen().slice(-2), ['ops@training-01:/var/log$ ls', 'auth.log  beeper.log  syslog']);
  v.key('ArrowUp');
  assert.equal(v.input.value, 'ls');
  assert.equal(v.cases()[2].children[2].textContent, 'In progress: 1 command');
  assert.equal(v.cases()[2].getAttribute('aria-label'), 'Case 3: Address in use, In progress: 1 command');
  assert.equal(v.state().case, 'tutorial');
  // Selecting the case on screen again just repeats its status.
  v.cases()[0].children[1].click();
  assert.equal(v.text('status'), 'Now on case 1 (First shift), logged in to training-01 as ops.');
});

test('lost-in-var: help and clear are free; clear empties the screen, and the screen keeps its last 400 lines', (t) => {
  const v = openPage(t);
  v.type('help');
  assert.deepEqual(v.screen().slice(-liv.livHelpAll.length), liv.livHelpAll);
  v.type('help kill');
  v.type('clear');
  assert.deepEqual(v.screen(), []);
  assert.equal(v.state().sessions.tutorial.commands, 0);
  for (let i = 0; i < 40; i++) v.type(i % 2 ? 'help' : 'help grep');
  const screen = v.screen();
  assert.equal(screen.length, 400);
  assert.equal(v.el('screen').children.length, 400);
  assert.equal(screen[399], liv.livHelpAll[liv.livHelpAll.length - 1]);
  assert.deepEqual(v.state().sessions.tutorial.history.slice(0, 4), ['help', 'help kill', 'clear', 'help grep']);
  assert.equal(v.state().sessions.tutorial.history.length, 43, 'help and clear are in the history, though they count nothing');
  assert.equal(v.state().sessions.tutorial.commands, 0);
});

test('lost-in-var: nothing runs in the background: a hidden tab writes and changes nothing, and no timer is left behind', (t) => {
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const v = openPage(t, { storage: { state: SAMPLE_STATE } });
  setVisibility('hidden', t);
  t.mock.timers.tick(60000);
  setVisibility('visible', t);
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE);
  assert.equal(v.screen().length, DISK.motd.length + 1);
  assert.equal(setIntervalSpy.mock.callCount(), 0, 'no clock at all');
  v.type('pwd');
  assert.deepEqual(v.screen().slice(-1), ['/var/tmp']);
});

test('lost-in-var: a newer toast keeps its full 2 s', (t) => {
  const v = openPage(t);
  v.input.value = 'zz';
  v.click('complete');
  assert.notEqual(v.toast(), null);
  t.mock.timers.tick(1500);
  v.input.value = 'qq';
  v.click('complete');
  t.mock.timers.tick(1999);
  assert.equal(v.toast(), 'No command starts with \'qq\'. Type help for the list.');
  t.mock.timers.tick(1);
  assert.equal(v.toast(), null);
});

test('lost-in-var: every class the game puts on the page has a rule in style.css', (t) => {
  const seen = new Set();
  const collect = (v) => {
    for (const el of walk(v.page.root)) String(el.className || '').split(/\s+/).filter(Boolean).forEach((name) => seen.add(name));
  };
  const v = openPage(t);
  v.type('ls');
  v.type('nope');
  collect(v);
  TUTORIAL.goals.forEach((goal) => v.type(goal.example));
  collect(v);
  v.cases()[1].click();
  v.click('hint');
  v.type('ps aux');
  v.input.value = 'zz';
  v.click('complete');
  collect(v);
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors).join(' ');
  for (const name of [...seen].sort()) {
    assert.match(name, /^liv-/);
    assert.match(selectors, new RegExp('\\.' + name + '(?![\\w-])'), name);
  }
  for (const name of ['liv-line--cmd', 'liv-line--out', 'liv-line--err', 'liv-line--sys', 'liv-line--win', 'liv-goal--done', 'liv-goal--next',
    'liv-chip--name', 'liv-chip--example', 'liv-case-btn--solved', 'liv-hint-item', 'liv-hint-text', 'liv-show', 'liv-case-meta']) {
    assert.ok(seen.has(name), name + ' was seen on the page');
  }
});

// ── Saves on the page ────────────────────────────────────────────────────────

test('lost-in-var: a save in the current format loads as it was and is written back in the same format', (t) => {
  const v = openPage(t, { storage: { state: SAMPLE_STATE, progress: SAMPLE_PROGRESS } });
  assert.equal(v.text('case-title'), 'Case 2: No space left');
  assert.equal(v.text('prompt'), 'ops@web-01:/var/tmp$');
  assert.deepEqual(v.screen(), DISK.motd.concat(['# Session restored: 4 commands so far, in /var/tmp. Up brings back your history.']));
  assert.equal(v.text('score'), '4 commands (par 6) · hints 1/3 · 1 wrong kill');
  assert.equal(v.el('hints').children.length, 1);
  assert.equal(v.text('hint'), 'Hint 2/3 (-10)');
  assert.deepEqual(v.cases().map((b) => b.children[2].textContent), ['Solved: 97 points', 'In progress: 4 commands', 'New']);
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE, 'loading writes nothing');
  v.key('ArrowUp');
  assert.equal(v.input.value, 'kill 2290');
  v.type('ps aux');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE.replace('"kill 2290"],"commands":4', '"kill 2290","ps aux"],"commands":5'));
  assert.equal(localStorage.getItem(PROGRESS_KEY), SAMPLE_PROGRESS);
  v.type('kill 2231');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE.replace('"killed":[2290],"done":[]', '"killed":[2290,2231],"done":[2]')
    .replace('"kill 2290"],"commands":4', '"kill 2290","ps aux","kill 2231"],"commands":6'));
  assert.equal(localStorage.getItem(PROGRESS_KEY), SAMPLE_PROGRESS, 'stopped, but not closed without the evidence');
  v.type('tail /var/log/nginx/error.log');
  v.type('tail /var/log/shop/export.log');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE.replace('"killed":[2290],"done":[]', '"killed":[2290,2231],"done":[0,1,2]')
    .replace('"kill 2290"],"commands":4', '"kill 2290","ps aux","kill 2231","tail /var/log/nginx/error.log","tail /var/log/shop/export.log"],"commands":8'));
  assert.equal(localStorage.getItem(PROGRESS_KEY), '{"v":1,"cases":{"tutorial":{"score":97,"commands":9,"hints":0},"disk-full":{"score":59,"commands":8,"hints":1}}}');
});

test('lost-in-var: a session survives a reload: case, folder, kills, history, counts, the screen note and the progress', (t) => {
  let v = openPage(t);
  v.cases()[1].click();
  v.type('cd /var/log/shop');
  v.type('cat export.log');
  v.click('hint');
  v.type('kill 2290');
  const snapshot = localStorage.getItem(STATE_KEY);
  v = reload(t, v);
  assert.equal(localStorage.getItem(STATE_KEY), snapshot);
  assert.equal(v.text('prompt'), 'ops@web-01:/var/log/shop$');
  assert.deepEqual(v.screen().slice(-1), ['# Session restored: 3 commands so far, in /var/log/shop. Up brings back your history.']);
  assert.equal(v.text('score'), '3 commands (par 6) · hints 1/3 · 1 wrong kill');
  v.key('ArrowUp');
  assert.equal(v.input.value, 'kill 2290');
  assert.deepEqual(v.goals().map((g) => g[0]), ['liv-goal liv-goal--next', 'liv-goal liv-goal--done', 'liv-goal'], 'the evidence seen before the reload');
  v.type('ps aux');
  assert.equal(v.screen().some((line) => line.includes('tail -f')), false, 'the killed process stays gone');
  v.type('tail ../nginx/error.log');
  v.type('kill 2231');
  v = reload(t, v);
  assert.equal(v.text('status'), 'Case closed with 65 points. Pick another case, or Restart case to play it again.');
  assert.equal(v.text('score'), 'Solved: 65 points · 6 commands (par 6) · hints 1/3 · 1 wrong kill · record 65');
  assert.equal(v.hidden('next'), false);
  assert.equal(v.el('hint').disabled, true);
});

test('lost-in-var: a corrupt or partial save never breaks the page: what is wrong starts fresh, the rest is kept', (t) => {
  const corrupt = ['{', '[]', 'null', '"x"', '{"case":7}', '{"sessions":7}', '{"sessions":{"tutorial":7}}',
    '{"case":"tutorial","sessions":{"tutorial":{"cwd":"/root","killed":"x","done":{},"history":7,"commands":"9","hints":-1}}}'];
  for (const text of corrupt) {
    resetStubs();
    const v = openPage(t, { storage: { state: text, progress: '{"cases":{"tutorial":{"score":"x"}}}' } });
    assert.equal(v.text('prompt'), 'ops@training-01:~$', text);
    assert.deepEqual(v.screen(), TUTORIAL.motd, text);
    assert.equal(v.cases()[0].children[2].textContent, 'New', text);
    v.type('ls');
    assert.equal(v.state().sessions.tutorial.commands, 1, text);
    assert.deepEqual(v.state().sessions.tutorial.done, [0], text);
  }
  // One bad field: only it falls back.
  resetStubs();
  const v = openPage(t, { storage: { state: stateWith({ case: 'disk-full', sessions: { 'disk-full': { cwd: '/root', killed: [2231], done: [0, 1], history: ['ls'], commands: 'x' } } }) } });
  assert.equal(v.text('prompt'), 'ops@web-01:~$');
  assert.equal(v.text('score'), 'Solved: 100 points · 1 command (par 6) · hints 0/3 · 0 wrong kills');
});

test('lost-in-var: blocked storage never stops the game, and the warning names both keys', (t) => {
  blockStorage('access', t);
  const v = openPage(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Browser storage is blocked: liv-state and liv-progress cannot be read or saved, so your sessions and your points will not be kept after a reload.');
  TUTORIAL.goals.forEach((goal) => v.type(goal.example));
  assert.equal(v.text('status'), 'Case closed with 100 points: 8 commands (par 8), 0 hints, 0 wrong kills. New record.');
  v.click('next');
  v.click('hint');
  v.click('restart');
  assert.equal(v.text('case-title'), 'Case 2: No space left');
});

test('lost-in-var: full storage still reads the saves; the game plays on, never takes its own unsaved state for another tab\'s, and names each key', (t) => {
  writeStorage({ state: SAMPLE_STATE });
  blockStorage('full', t);
  const v = openPage(t);
  assert.equal(v.text('prompt'), 'ops@web-01:/var/tmp$', 'the save is still read');
  assert.equal(v.hidden('warning'), true, 'no warning before a write fails');
  v.type('pwd');
  assert.equal(v.text('warning'), 'Browser storage is full: liv-state was not saved, so a reload loses the latest changes to your sessions.');
  v.type('cd /');
  v.type('pwd');
  assert.equal(v.text('score'), '7 commands (par 6) · hints 1/3 · 1 wrong kill', 'the commands of this tab stand');
  assert.deepEqual(v.screen().slice(-1), ['/']);
  v.type('tail /var/log/nginx/error.log');
  v.type('tail /var/log/shop/export.log');
  assert.equal(v.text('warning'), 'Browser storage is full: liv-state was not saved, so a reload loses the latest changes to your sessions.');
  v.type('kill 2231');
  assert.equal(v.text('warning'), 'Browser storage is full: liv-state and liv-progress were not saved, so a reload loses the latest changes to your sessions and your points.');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_STATE);
  assert.equal(localStorage.getItem(PROGRESS_KEY), null);
});

// ── Second tabs ──────────────────────────────────────────────────────────────

test('lost-in-var: another tab\'s session is taken over through the storage event, and before a command when the event was missed', (t) => {
  const v = openPage(t);
  v.type('ls');
  // The other tab moved on in case 1.
  otherTab(STATE_KEY, stateWith({ sessions: { tutorial: { cwd: '/var/log', done: [0, 1, 2], history: ['ls', 'cat welcome.txt', 'cd /var/log'], commands: 3 } } }));
  assert.deepEqual(v.screen().slice(-1), ['# Another tab changed this case: 3 commands so far, now in /var/log.']);
  assert.equal(v.text('prompt'), 'ops@training-01:/var/log$');
  assert.deepEqual(v.goals().slice(0, 4).map((g) => g[0]), ['liv-goal liv-goal--done', 'liv-goal liv-goal--done', 'liv-goal liv-goal--done', 'liv-goal liv-goal--next']);
  v.key('ArrowUp');
  assert.equal(v.input.value, 'cd /var/log', 'the history came along');
  // The same text again, or another key, changes nothing.
  const lines = v.screen().length;
  fire(window, 'storage', { key: STATE_KEY });
  fire(window, 'storage', { key: 'other-key' });
  fire(window, 'storage', { key: null });
  assert.equal(v.screen().length, lines);
  // Another case changed: taken over without a note here.
  otherTab(STATE_KEY, stateWith({ sessions: { tutorial: { cwd: '/var/log', done: [0, 1, 2], history: ['ls', 'cat welcome.txt', 'cd /var/log'], commands: 3 }, 'port-clash': { commands: 5, history: ['ls'] } } }));
  assert.equal(v.screen().length, lines);
  assert.equal(v.cases()[2].children[2].textContent, 'In progress: 5 commands');
  // A write the event never brought is found before the next command runs on it.
  localStorage.setItem(STATE_KEY, stateWith({ sessions: { tutorial: { cwd: '/tmp', history: ['cd /tmp'], commands: 9 } } }));
  v.type('pwd');
  assert.deepEqual(v.screen().slice(-3), ['# Another tab changed this case: 9 commands so far, now in /tmp.', 'ops@training-01:/tmp$ pwd', '/tmp']);
  assert.equal(v.state().sessions.tutorial.commands, 10);
  // Storage emptied by the other tab: this tab keeps its own.
  localStorage.removeItem(STATE_KEY);
  fire(window, 'storage', { key: STATE_KEY, newValue: null });
  assert.equal(v.text('prompt'), 'ops@training-01:/tmp$');
});

test('lost-in-var: another tab\'s change to a case not on screen leaves a note in that case\'s terminal, shown when this tab switches to it', (t) => {
  const v = openPage(t);
  v.cases()[2].click();
  v.type('pwd');
  v.cases()[0].click();
  const other = v.state();
  other.sessions['port-clash'] = { cwd: '/var/log/app', killed: [3107], done: [2], history: ['pwd', 'cd /var/log/app', 'kill 3107'], commands: 3, hints: 0 };
  otherTab(STATE_KEY, JSON.stringify(other));
  assert.deepEqual(v.screen(), TUTORIAL.motd, 'the case on screen did not change, so no note here');
  assert.equal(v.cases()[2].children[2].textContent, 'In progress: 3 commands');
  v.cases()[2].click();
  assert.deepEqual(v.screen().slice(-3), ['deploy@app-03:~$ pwd', '/home/deploy', '# Another tab changed this case: 3 commands so far, now in /var/log/app.']);
  assert.equal(v.text('prompt'), 'deploy@app-03:/var/log/app$');
  assert.deepEqual(v.goals().map((g) => g[0])[2], 'liv-goal liv-goal--done');
  // A case this tab never opened has no terminal yet: it opens with its motd and the restored note.
  const later = v.state();
  later.sessions['disk-full'] = { cwd: '/var/tmp', killed: [], done: [], history: ['cd /var/tmp'], commands: 1, hints: 0 };
  otherTab(STATE_KEY, JSON.stringify(later));
  v.cases()[1].click();
  assert.deepEqual(v.screen(), DISK.motd.concat(['# Session restored: 1 command so far, in /var/tmp. Up brings back your history.']));
});

test('lost-in-var: a case another tab closed shows closed here, and a hint used up there is not shown twice', (t) => {
  const v = openPage(t);
  v.cases()[1].click();
  v.click('hint');
  v.click('hint');
  localStorage.setItem(STATE_KEY, stateWith({ case: 'disk-full', sessions: { 'disk-full': { hints: 3, commands: 1, history: ['ls'] } } }));
  v.click('hint');
  assert.equal(v.text('hint'), 'No hints left');
  assert.equal(v.el('hints').children.length, 3, 'the hints the other tab showed');
  assert.equal(v.screen().filter((line) => line.startsWith('# Hint 3/3')).length, 0, 'no third hint shown here');
  assert.equal(JSON.parse(localStorage.getItem(STATE_KEY)).sessions['disk-full'].hints, 3);
  // The other tab closes the case.
  otherTab(STATE_KEY, stateWith({ case: 'disk-full', sessions: { 'disk-full': { hints: 3, commands: 2, killed: [2231], done: [0, 1], history: ['ls', 'kill 2231'] } } }));
  assert.equal(v.text('score'), 'Solved: 70 points · 2 commands (par 6) · hints 3/3 · 0 wrong kills');
  assert.equal(v.hidden('next'), false);
  v.type('ls');
  assert.equal(v.state().sessions['disk-full'].commands, 2, 'closed elsewhere, so nothing counts here');
});

test('lost-in-var: scores from two tabs merge: a better one from the other tab shows at once and is never written over', (t) => {
  const v = openPage(t);
  otherTab(PROGRESS_KEY, '{"v":1,"cases":{"tutorial":{"score":100,"commands":8,"hints":0}}}');
  assert.equal(v.cases()[0].children[2].textContent, 'Solved: 100 points');
  assert.equal(v.text('score'), '0 commands (par 8) · hints 0/0 · 0 wrong kills · record 100');
  // This tab solves it worse; meanwhile the other tab also solved case 3.
  localStorage.setItem(PROGRESS_KEY, '{"v":1,"cases":{"tutorial":{"score":100,"commands":8,"hints":0},"port-clash":{"score":88,"commands":10,"hints":0}}}');
  v.type('nope');
  TUTORIAL.goals.forEach((goal) => v.type(goal.example));
  assert.equal(v.text('status'), 'Case closed with 97 points: 9 commands (par 8), 0 hints, 0 wrong kills. Your record stays 100 points.');
  assert.equal(localStorage.getItem(PROGRESS_KEY), '{"v":1,"cases":{"tutorial":{"score":100,"commands":8,"hints":0},"port-clash":{"score":88,"commands":10,"hints":0}}}');
  // A worse score arriving from the other tab never lowers the record.
  otherTab(PROGRESS_KEY, '{"v":1,"cases":{"tutorial":{"score":40,"commands":30,"hints":0}}}');
  assert.equal(v.cases()[0].children[2].textContent, 'Solved: 100 points');
  assert.equal(v.cases()[2].children[2].textContent, 'Solved: 88 points');
});
