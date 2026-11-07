// tests/byte-catcher.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadScript, loadWithPage, bootLikeBrowser, createPage, resetStubs, blockStorage,
  fire, pressKey, focusElement, setVisibility, listenerCount,
  readRepoFile, idsInHtml, htmlPageSpec, embedMarkup, embedSafety, cssRules, declsAt, seeded
} = require('./_setup');

// The game under test: a folder under the repo root.
const GAME = 'byte-catcher';
const SCRIPT = GAME + '/script.js';
const HTML = readRepoFile(GAME + '/index.html');
const CSS = readRepoFile(GAME + '/style.css');
const JS = readRepoFile(SCRIPT);

// The pure functions (the start-up code does not run under Node).
const byc = loadScript(SCRIPT);

const STATE_KEY = 'byc-state';
const BEST_KEY = 'byc-best';
const MODES = ['bin', 'cidr', 'chmod'];

// A byc-state in the format the first published version writes: a CIDR run
// paused at 12.3 s with two packets queued (/26 selected, two octets of its
// mask picked so far), a score of 57 from three packets, one drop and one
// CRC error.
const SAMPLE_SAVE = '{"v":1,"mode":"cidr","status":"paused","t":12300,"seed":2654435769,"seq":6,"nextSpawn":2100,' +
  '"queue":[{"seq":4,"kind":"cidr","value":26,"ttl":9800,"life":21800},{"seq":5,"kind":"mask","value":20,"ttl":14500,"life":21500}],' +
  '"sel":4,"keys":[255,255],"bits":0,"score":57,"combo":2,"bestCombo":2,"forwarded":3,"drops":1,"misses":1}';

test.beforeEach(() => resetStubs());

// ── An independent model ────────────────────────────────────────────────────

const binModel = (n) => n.toString(2).padStart(8, '0');
const nibbles = (bits) => bits.slice(0, 4) + ' ' + bits.slice(4);
const maskOctets = (p) => {
  const bits = '1'.repeat(p) + '0'.repeat(32 - p);
  return [0, 1, 2, 3].map((i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2));
};
const maskModel = (p) => maskOctets(p).join('.');
const RWX_DIGITS = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
const octalModel = (v) => v.toString(8).padStart(3, '0');
const rwxModel = (v) => octalModel(v).split('').map((d) => RWX_DIGITS[Number(d)]).join('');
const hexModel = (v) => '0x' + v.toString(16).toUpperCase().padStart(2, '0');

const valueModel = (kind, v) => ({
  dec: 'DEC ' + v, hex: 'HEX ' + hexModel(v), cidr: '/' + v, mask: v <= 32 ? maskModel(v) : '', octal: octalModel(v), rwx: rwxModel(v)
})[kind];
const answerModel = (kind, v) => ({
  dec: nibbles(binModel(v)), hex: nibbles(binModel(v)), cidr: v <= 32 ? maskModel(v) : '', mask: '/' + v, octal: rwxModel(v), rwx: octalModel(v)
})[kind];
const RANGES = { dec: [1, 255], hex: [1, 255], cidr: [8, 30], mask: [8, 30], octal: [1, 511], rwx: [1, 511] };
const MODE_KINDS = { bin: ['dec', 'hex'], cidr: ['cidr', 'mask'], chmod: ['octal', 'rwx'] };

// The inputs that encode a packet: its bits as toggles, or the keys to type.
function answerInputs(packet) {
  const v = packet.value;
  if (packet.kind === 'dec' || packet.kind === 'hex' || packet.kind === 'octal') {
    const top = packet.kind === 'octal' ? 8 : 7;
    const bits = [];
    for (let k = top; k >= 0; k--) if (v & (1 << k)) bits.push({ type: 'toggle', bit: k });
    return bits;
  }
  if (packet.kind === 'cidr') return maskOctets(v).map((value) => ({ type: 'key', value }));
  const digits = packet.kind === 'mask' ? String(v).padStart(2, '0') : octalModel(v);
  return digits.split('').map((d) => ({ type: 'key', value: Number(d) }));
}

// The pace as the rules give it: straight lines through (0 min, start),
// (4 min, mid) and (10 min, floor), flat after, on whole 100 ms ticks.
const PACE = {
  bin: { ttl: [22000, 9000, 6000], spawn: [6500, 2000, 1400] },
  cidr: { ttl: [22000, 8000, 5000], spawn: [6500, 1700, 1100] },
  chmod: { ttl: [22000, 9000, 6000], spawn: [6500, 2000, 1400] }
};
const BENDS = [0, 240000, 600000];
function ramp(values, t) {
  const points = BENDS.map((at, i) => [at, values[i]]).concat([[Infinity, values[2]]]);
  const i = points.findIndex(([at]) => at > t) - 1;
  const [[t0, v0], [t1, v1]] = [points[i], points[i + 1]];
  const v = t1 === Infinity ? v0 : v0 + (v1 - v0) * (t - t0) / (t1 - t0);
  return Math.round(v / 100) * 100;
}

// ── Runs in the pure model ──────────────────────────────────────────────────

function running(mode, seed = 1) {
  const s = byc.bycNewRun(mode, seed);
  s.status = 'running';
  return s;
}

function steps(state, n, dt = 100) {
  let events = [];
  for (let i = 0; i < n; i++) {
    const out = byc.bycStep(state, dt, null);
    state = out.state;
    events = events.concat(out.events.map((e) => Object.assign({ t: state.t }, e)));
  }
  return { state, events };
}

function apply(state, inputs) {
  let events = [];
  for (const input of [].concat(inputs)) {
    const out = byc.bycStep(state, 0, input);
    state = out.state;
    events = events.concat(out.events);
  }
  return { state, events };
}

// A running run with exactly these packets (seq 1, 2 ...), the first selected.
function withQueue(mode, packets, extra) {
  const s = running(mode);
  s.queue = packets.map((p, i) => Object.assign({ seq: i + 1, ttl: 10000, life: 15000 }, p));
  s.seq = s.queue.length + 1;
  s.sel = s.queue.length ? s.queue[0].seq : null;
  s.t = 5000;
  s.nextSpawn = 4000;
  return Object.assign(s, extra);
}

// A player who needs think ms to read the selected packet plus per ms for
// each tap or key it takes (a Delete or Clear first when the entry is not
// empty), up to max ms of run time.
function bot(mode, seed, think, per, max) {
  let s = running(mode, seed);
  let busy = 0;
  let last = null;
  for (let t = 0; t < max && s.status === 'running'; t += 100) {
    if (s.sel !== last) {
      last = s.sel;
      busy = 0;
    }
    if (s.sel !== null) {
      const clear = s.bits ? [{ type: 'back' }] : s.keys.map(() => ({ type: 'back' }));
      const inputs = clear.concat(answerInputs(s.queue.find((p) => p.seq === s.sel)));
      if (busy >= think + per * inputs.length) {
        s = apply(s, inputs).state;
        last = s.sel;
        busy = 0;
      }
    }
    s = byc.bycStep(s, 100, null).state;
    busy += 100;
  }
  return s;
}

// A byc-state object of a paused Warm-up run, HEX 0xB6 selected.
function save(extra) {
  return Object.assign({
    v: 1, mode: 'bin', status: 'paused', t: 1000, seed: 7, seq: 2, nextSpawn: 3500,
    queue: [{ seq: 1, kind: 'hex', value: 0xB6, ttl: 9000, life: 15000 }], sel: 1, keys: [], bits: 0,
    score: 0, combo: 0, bestCombo: 0, forwarded: 0, drops: 0, misses: 0
  }, extra);
}

// ── Pages ────────────────────────────────────────────────────────────────────

// Mocked timers; advance(ms) moves in 100 ms steps, as the game's ticks
// chain one timeout after the other.  reload() drops the old page's timers.
function makeClock(t) {
  const enable = () => t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    enable();
  } catch (error) {
    t.mock.timers.reset();
    enable();
  }
  return {
    advance(ms) {
      for (let done = 0; done < ms; done += 100) t.mock.timers.tick(Math.min(100, ms - done));
    },
    reload() {
      t.mock.timers.reset();
      enable();
    }
  };
}

function writeStorage(storage = {}) {
  for (const [key, value] of [[STATE_KEY, storage.state], [BEST_KEY, storage.best]]) {
    if (value !== undefined) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

const withAttr = (list, name, value) => list.find((el) => el.getAttribute(name) === String(value));

// Every element of the page tree under node.
function walk(node, out = []) {
  for (const child of node.children || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

// What a player sees and does.
function pageView(b) {
  const els = b.els;
  const con = els['byc-console'];
  const kids = (name) => els['byc-' + name].children;
  return {
    els,
    page: b.page,
    ready: b.ready,
    restore: b.restore,
    con,
    el: (name) => els['byc-' + name],
    text: (name) => els['byc-' + name].textContent,
    hidden: (name) => els['byc-' + name].classList.contains('byc-hidden'),
    slots: () => kids('queue'),
    // A slot's four parts: seq, value, to, ttl.
    slot: (i) => kids('queue')[i].children[0].children.map((el) => el.textContent),
    fill: (i) => kids('queue')[i].children[1].children[0].style.width,
    bitKey: (bit) => withAttr(kids('bits'), 'data-bit', bit),
    permKey: (bit) => withAttr(kids('grid').filter((el) => el.tagName === 'BUTTON'), 'data-bit', bit),
    octetKey: (v) => withAttr(kids('octets'), 'data-value', v),
    digitKey: (d) => withAttr(kids('digits'), 'data-value', d),
    tapBits(value, top = 7) {
      for (let k = top; k >= 0; k--) {
        if (value & (1 << k)) (top === 8 ? this.permKey(k) : this.bitKey(k)).click();
      }
    },
    tapOctets: (list) => list.forEach((v) => withAttr(kids('octets'), 'data-value', v).click()),
    tapDigits: (list) => list.forEach((d) => withAttr(kids('digits'), 'data-value', d).click()),
    click: (name) => els['byc-' + name].click(),
    press(key, props) {
      focusElement(con, { keyboard: true });
      return pressKey(key, Object.assign({ target: con }, props));
    },
    chooseMode(value) {
      els['byc-mode'].value = value;
      return fire(els['byc-mode'], 'change');
    },
    toast: () => (els['byc-toast'].classList.contains('byc-show') ? els['byc-toast'].textContent : null),
    state: () => JSON.parse(localStorage.getItem(STATE_KEY)),
    best: () => JSON.parse(localStorage.getItem(BEST_KEY))
  };
}

function boot(options) {
  return pageView(bootLikeBrowser(SCRIPT, htmlPageSpec(HTML), options));
}

// The page as a browser loads it, after writing storage, with mocked timers
// and Math.random.
function openPage(t, { random = 1, storage, options } = {}) {
  const clock = makeClock(t);
  t.mock.method(Math, 'random', seeded(random));
  writeStorage(storage);
  return { clock, v: boot(options) };
}

// A reload: the old page and its timers go away, storage stays.
function reload(clock, v) {
  clock.reload();
  v.restore();
  return boot();
}

// The seed a fresh run gets from the first Math.random of seeded(random).
const firstSeed = (random) => Math.floor(seeded(random)() * 4294967296) >>> 0;

const px = (value) => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value).trim());
  assert.ok(m, 'a px length: ' + value);
  return Number(m[1]);
};

const rem = (value) => {
  const m = /^(\d+(?:\.\d+)?)rem$/.exec(String(value).trim());
  assert.ok(m, 'a rem length: ' + value);
  return Number(m[1]) * 16;
};

// The prompts the console can show: each kind's (with a long packet number),
// the longest wait for the next packet and the three idle ones.
const PROMPTS = Object.values(byc.bycKinds).map((kind) => '#9999: ' + kind.ask)
  .concat(['Queue empty: next packet in 6.5 s.'], Array.from(JS.matchAll(/^ {4}(?:ready|paused|over): '([^']+)'/gm), (m) => m[1]));

// WCAG contrast of two #rrggbb colours.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// ── Converters ───────────────────────────────────────────────────────────────

test('byte-catcher: bycToBin, the nibble text and bycHex match an independent conversion for every byte', () => {
  for (let n = 0; n < 256; n++) {
    assert.equal(byc.bycToBin(n), binModel(n));
    assert.equal(byc.bycByteText(n), nibbles(binModel(n)));
    assert.equal(byc.bycHex(n), hexModel(n));
  }
  assert.equal(byc.bycToBin(5, 9), '000000101');
  assert.equal(byc.bycToBin(488, 3), '111101000', 'a width never cuts digits off');
});

test('byte-catcher: every prefix length 0-32 turns into its dotted mask and back; nothing else is a mask', () => {
  for (let p = 0; p <= 32; p++) {
    assert.equal(byc.bycCidrToMask(p), maskModel(p), '/' + p);
    assert.equal(byc.bycMaskToCidr(maskModel(p)), p, maskModel(p));
  }
  // Every combination of the nine mask octets is a mask exactly when its 1 bits come first.
  const octets = byc.bycOctets;
  assert.deepEqual(octets, [255, 254, 252, 248, 240, 224, 192, 128, 0]);
  let masks = 0;
  for (const a of octets) for (const b of octets) for (const c of octets) for (const d of octets) {
    const bits = [a, b, c, d].map(binModel).join('');
    const expected = /^1*0*$/.test(bits) ? bits.split('1').length - 1 : null;
    if (expected !== null) masks++;
    assert.equal(byc.bycMaskToCidr([a, b, c, d].join('.')), expected, [a, b, c, d].join('.'));
  }
  assert.equal(masks, 33, 'one combination per prefix length');
  for (const bad of ['255.255.255', '255.255.255.0.0', '256.0.0.0', '255.300.0.0', '255.255.255.1', '0.0.0.255', 'abc', '', ' 255.0.0.0',
    '255.0.0.0 ', '255.255.0255.0', null, undefined]) {
    assert.equal(byc.bycMaskToCidr(bad), null, String(bad));
  }
});

test('byte-catcher: chmod modes convert between octal and rwx for all 512 modes', () => {
  for (let v = 0; v < 512; v++) {
    assert.equal(byc.bycOctal(v), octalModel(v));
    assert.equal(byc.bycOctalToRwx(v), rwxModel(v));
    assert.equal(byc.bycRwxToOctal(rwxModel(v)), octalModel(v));
  }
  assert.equal(byc.bycOctalToRwx(0o750), 'rwxr-x---');
  assert.equal(byc.bycRwxToOctal('rw-r--r--'), '644');
  for (const bad of ['rwxr-x--', 'rwxr-x---x', 'xwrr-x---', 'RWXR-X---', 'rwx rwx r', 'rwsr-xr-x', 750, null]) {
    assert.equal(byc.bycRwxToOctal(bad), null, String(bad));
  }
});

// ── Packets ──────────────────────────────────────────────────────────────────

test('byte-catcher: every packet kind has its mode, its panel, its label, its answer and its entry readout', () => {
  assert.deepEqual(Object.keys(byc.bycModes), MODES);
  for (const mode of MODES) assert.deepEqual(byc.bycModes[mode].kinds, MODE_KINDS[mode]);
  assert.deepEqual(MODES.map((mode) => byc.bycModes[mode].name), ['Warm-up', 'CIDR', 'chmod']);
  const cases = [
    ['dec', 182, 'bits', 'DEC 182', '1011 0110'],
    ['hex', 0xB6, 'bits', 'HEX 0xB6', '1011 0110'],
    ['cidr', 26, 'octets', '/26', '255.255.255.192'],
    ['mask', 26, 'digits', '255.255.255.192', '/26'],
    ['octal', 0o750, 'grid', '750', 'rwxr-x---'],
    ['rwx', 0o750, 'digits', 'rwxr-x---', '750']
  ];
  for (const [kind, value, panel, label, answer] of cases) {
    assert.equal(byc.bycPanelOf(kind), panel, kind);
    assert.equal(byc.bycValueText(kind, value), label, kind);
    assert.equal(byc.bycAnswerText(kind, value), answer, kind);
    const [min, max] = RANGES[kind];
    assert.deepEqual([byc.bycKinds[kind].min, byc.bycKinds[kind].max], [min, max], kind + ' range');
    for (let v = min; v <= max; v++) {
      assert.equal(byc.bycValueText(kind, v), valueModel(kind, v), kind + ' ' + v);
      assert.equal(byc.bycAnswerText(kind, v), answerModel(kind, v), kind + ' ' + v);
    }
  }
  const entry = (kind, keys, bits = 0) => byc.bycEntryText(kind, { keys, bits });
  assert.equal(entry('dec', []), '0000 0000');
  assert.equal(entry('hex', [], 5), '0000 0101');
  assert.equal(entry('octal', [], 0o640), 'rw-r-----');
  assert.equal(entry('cidr', []), '___.___.___.___');
  assert.equal(entry('cidr', [255, 255]), '255.255.___.___');
  assert.equal(entry('mask', []), '/__');
  assert.equal(entry('mask', [2]), '/2_');
  assert.equal(entry('rwx', [7, 5]), '75_');
});

test('byte-catcher: bycCheckMatch accepts exactly the entry that encodes the packet, in every mode', () => {
  const match = (kind, value, keys, bits = 0) => byc.bycCheckMatch({ kind, value }, { keys, bits });
  for (const kind of ['dec', 'hex']) {
    for (const value of [1, 0xB6, 255]) {
      for (let bits = 0; bits < 256; bits++) assert.equal(match(kind, value, [], bits), bits === value, kind + ' ' + value + ' ' + bits);
    }
  }
  for (const value of [0o750, 0o644, 0o777]) {
    for (let bits = 0; bits < 512; bits++) assert.equal(match('octal', value, [], bits), bits === value);
  }
  const octets = byc.bycOctets;
  for (const p of [8, 20, 26, 30]) {
    for (const a of octets) for (const b of octets) for (const c of octets) for (const d of octets) {
      assert.equal(match('cidr', p, [a, b, c, d]), [a, b, c, d].join('.') === maskModel(p));
    }
    assert.equal(match('cidr', p, maskOctets(p).slice(0, 3)), false, 'three octets are no mask');
  }
  assert.equal(match('mask', 26, [2, 6]), true);
  assert.equal(match('mask', 26, [2, 5]), false);
  assert.equal(match('mask', 26, []), false);
  assert.equal(match('mask', 8, [8]), true);
  assert.equal(match('mask', 8, [0, 8]), true, 'a leading zero is the same prefix');
  assert.equal(match('rwx', 0o750, [7, 5, 0]), true);
  assert.equal(match('rwx', 0o750, [7, 5]), false);
  assert.equal(match('rwx', 0o750, [7, 5, 1]), false);
  assert.equal(match('rwx', 0o640, [6, 4, 0]), true);
});

test('byte-catcher: a key that cannot be typed is refused naming it; a wrong entry says what it means', () => {
  const p = (kind, value) => ({ kind, value });
  assert.equal(byc.bycKeyError(p('cidr', 26), [255], 100), '100 is not a mask octet (255, 254, 252, 248, 240, 224, 192, 128, 0).');
  assert.equal(byc.bycKeyError(p('cidr', 26), [255], 192), '');
  assert.equal(byc.bycKeyError(p('mask', 26), [4], 5), '/45 is not a prefix length (0-32).');
  assert.equal(byc.bycKeyError(p('mask', 26), [3], 3), '/33 is not a prefix length (0-32).');
  assert.equal(byc.bycKeyError(p('mask', 26), [3], 2), '');
  assert.equal(byc.bycKeyError(p('mask', 26), [], 9), '');
  assert.equal(byc.bycKeyError(p('rwx', 0o750), [7], 8), '8 is not an octal digit (0-7).');
  assert.equal(byc.bycKeyError(p('rwx', 0o750), [7], 7), '');
  assert.equal(byc.bycMissText(p('cidr', 26), [255, 255, 255, 128]), '255.255.255.128 is /25, not /26');
  assert.equal(byc.bycMissText(p('cidr', 26), [255, 192, 255, 0]), '255.192.255.0 is not a subnet mask: its 1 bits have to come first');
  assert.equal(byc.bycMissText(p('mask', 26), [2, 4]), '/24 is 255.255.255.0, not 255.255.255.192');
  assert.equal(byc.bycMissText(p('mask', 20), [2]), '/2 is 192.0.0.0, not 255.255.240.0');
  assert.equal(byc.bycMissText(p('rwx', 0o750), [7, 5, 5]), '755 is rwxr-xr-x, not rwxr-x---');
});

// ── Pace and points ──────────────────────────────────────────────────────────

test('byte-catcher: TTLs and arrivals speed up quickly over four minutes and slowly up to ten, on whole ticks; points grow with the TTL left and the combo', () => {
  for (const mode of MODES) {
    for (let t = 0; t <= 900000; t += 1300) {
      assert.equal(byc.bycTtlAt(mode, t), ramp(PACE[mode].ttl, t), mode + ' ttl ' + t);
      assert.equal(byc.bycSpawnAt(mode, t), ramp(PACE[mode].spawn, t), mode + ' spawn ' + t);
    }
    for (let t = 100; t <= 900000; t += 100) {
      assert.ok(byc.bycSpawnAt(mode, t) <= byc.bycSpawnAt(mode, t - 100) && byc.bycTtlAt(mode, t) <= byc.bycTtlAt(mode, t - 100), mode + ' never slows down at ' + t);
    }
  }
  // At 0, 2, 4, 7, 10 and 16 minutes.
  const at = [0, 120000, 240000, 420000, 600000, 960000];
  assert.deepEqual(at.map((t) => byc.bycTtlAt('bin', t)), [22000, 15500, 9000, 7500, 6000, 6000]);
  assert.deepEqual(at.map((t) => byc.bycSpawnAt('bin', t)), [6500, 4300, 2000, 1700, 1400, 1400]);
  assert.deepEqual(at.map((t) => byc.bycTtlAt('cidr', t)), [22000, 15000, 8000, 6500, 5000, 5000]);
  assert.deepEqual(at.map((t) => byc.bycSpawnAt('cidr', t)), [6500, 4100, 1700, 1400, 1100, 1100]);
  assert.deepEqual(at.map((t) => byc.bycTtlAt('chmod', t)), [22000, 15500, 9000, 7500, 6000, 6000]);
  assert.deepEqual(at.map((t) => byc.bycSpawnAt('chmod', t)), [6500, 4300, 2000, 1700, 1400, 1400]);
  assert.deepEqual([239900, 240000, 240100, 599900].map((t) => byc.bycSpawnAt('cidr', t)), [1700, 1700, 1700, 1100]);
  assert.deepEqual([0, 4, 5, 9, 10, 14, 15, 100].map(byc.bycMultiplier), [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(byc.bycPoints(9800, 0), 20, '10 plus 9.8 s rounded up');
  assert.equal(byc.bycPoints(10000, 0), 20);
  assert.equal(byc.bycPoints(100, 5), 22, '(10 + 1) x2');
  assert.equal(byc.bycPoints(0, 20), 40);
});

// ── The model ────────────────────────────────────────────────────────────────

test('byte-catcher: bycStep is pure, a run gives the same packets from the same seed, and only a running run moves', () => {
  const s = running('cidr', 99);
  const copy = JSON.parse(JSON.stringify(s));
  const out = byc.bycStep(s, 100, { type: 'back' });
  assert.deepEqual(s, copy, 'the state passed in is left alone');
  assert.notEqual(out.state, s);
  assert.equal(out.state.t, 100);
  const a = steps(running('chmod', 5), 600);
  const b = steps(running('chmod', 5), 600);
  assert.deepEqual(a, b, 'the same seed, the same run');
  const c = steps(running('chmod', 6), 600);
  assert.notDeepEqual(c.state.queue, a.state.queue);
  for (const status of ['ready', 'paused', 'over']) {
    const r = byc.bycNewRun('bin', 1);
    r.status = status;
    const idle = byc.bycStep(r, 5000, null);
    assert.deepEqual(idle.state, r, status + ': no time passes');
    assert.deepEqual(idle.events, []);
  }
  const zero = byc.bycStep(running('bin'), 0, null);
  assert.deepEqual(zero.state, running('bin'), 'no time and no input change nothing');
  assert.deepEqual(byc.bycNewRun('bin', -1).seed, 4294967295, 'the seed is a uint32');
});

// The arrivals of the first minute, [run time, TTL], whatever the seed.
const ARRIVALS = {
  bin: [[100, 22000], [6500, 21600], [12900, 21300], [19200, 21000], [25300, 20600], [31300, 20300], [37200, 20000], [43000, 19700], [48700, 19400], [54300, 19100], [59800, 18800]],
  cidr: [[100, 22000], [6500, 21600], [12900, 21200], [19100, 20900], [25200, 20500], [31200, 20200], [37100, 19800], [42900, 19500], [48500, 19200], [54000, 18900], [59400, 18500]]
};
ARRIVALS.chmod = ARRIVALS.bin;

test('byte-catcher: packets arrive at once and then one interval apart, with the TTL of their moment, count down and drop when it runs out', () => {
  for (const mode of MODES) {
    // A player who forwards everything at once sees every arrival of the first minute.
    let s = running(mode, 11);
    const seen = [];
    for (let i = 0; i < 600; i++) {
      const out = byc.bycStep(s, 100, null);
      s = out.state;
      for (const e of out.events.filter((x) => x.type === 'spawn')) seen.push([s.t, e.packet.ttl]);
      if (s.sel !== null) s = apply(s, answerInputs(s.queue.find((p) => p.seq === s.sel))).state;
    }
    assert.deepEqual(seen, ARRIVALS[mode], mode);
    // Nobody answers: the same arrivals until the link goes down.
    const { state, events } = steps(running(mode, 11), 600);
    const arrivals = events.filter((e) => e.type === 'spawn' || (e.type === 'drop' && e.reason === 'full'));
    assert.ok(arrivals.length >= 3, mode);
    assert.deepEqual(arrivals.map((e) => [e.t, e.packet.ttl]), ARRIVALS[mode].slice(0, arrivals.length), mode);
    assert.deepEqual(arrivals.map((e) => e.packet.seq), arrivals.map((e, i) => i + 1));
    for (const e of arrivals) {
      assert.equal(e.packet.life, e.packet.ttl);
      assert.ok(MODE_KINDS[mode].includes(e.packet.kind), mode + ' ' + e.packet.kind);
    }
    // Each packet drops the tick its TTL runs out.
    for (const drop of events.filter((e) => e.type === 'drop' && e.reason === 'ttl')) {
      const born = arrivals.find((e) => e.packet.seq === drop.packet.seq);
      assert.equal(drop.t, born.t + born.packet.life, mode + ' #' + drop.packet.seq);
      assert.equal(drop.packet.ttl, 0);
    }
    assert.equal(state.status, 'over', 'nobody answers: the link goes down');
  }
  // TTLs count down by the time that passed.
  const s = steps(running('bin', 3), 11).state;
  assert.equal(s.queue[0].ttl, 22000 - 1000);
  assert.equal(s.nextSpawn, 5400);
  assert.equal(s.sel, 1, 'the first packet is selected as it arrives');
});

test('byte-catcher: an idle link goes down at 34.2 s in Warm-up and chmod and 34.1 s in CIDR; players of one speed last about as long in every mode', () => {
  const downAt = (mode) => {
    const { state, events } = steps(running(mode, 2), 1000);
    assert.equal(state.status, 'over');
    assert.equal(events.filter((e) => e.type === 'drop').length, 3);
    assert.equal(events.filter((e) => e.type === 'over').length, 1);
    return events.find((e) => e.type === 'over').t;
  };
  // The third packet's arrival plus its TTL.
  assert.equal(downAt('bin'), 12900 + 21300);
  assert.equal(downAt('cidr'), 12900 + 21200);
  assert.equal(downAt('chmod'), 12900 + 21300);
  // Players who need think ms per packet plus per ms per tap or key: the slower, the sooner the link goes down, in every
  // mode within the same band of minutes (a mask is 4 taps or 2 digits, a mode 3 digits or its bits on the grid, a byte its bits).
  const players = [
    { think: 400, per: 250, from: 540, to: 1020 },
    { think: 600, per: 300, from: 400, to: 520 },
    { think: 1000, per: 500, from: 200, to: 260 },
    { think: 1500, per: 700, from: 160, to: 230 }
  ];
  for (const { think, per, from, to } of players) {
    const means = MODES.map((mode) => {
      const ends = [1, 2, 3].map((seed) => {
        const s = bot(mode, seed, think, per, 1200000);
        assert.equal(s.status, 'over', mode + ' ' + think + '+' + per + ' seed ' + seed + ': the pace keeps rising up to ten minutes');
        assert.equal(s.misses, 0);
        assert.ok(s.t >= from * 1000 && s.t <= to * 1000, mode + ' ' + think + '+' + per + ' seed ' + seed + ' down at ' + s.t);
        return s.t;
      });
      return ends.reduce((a, b) => a + b) / ends.length;
    });
    assert.ok(Math.max(...means) / Math.min(...means) <= 1.25, think + '+' + per + ': mode means ' + means.map((m) => (m / 1000).toFixed(0) + ' s'));
  }
});

test('byte-catcher: new packets carry values in range: bytes 1-255, prefixes 8-30, modes with an owner digit 4-7', () => {
  for (const mode of MODES) {
    const seen = new Set();
    let s = running(mode, 21);
    for (let i = 0; i < 400; i++) {
      // Forward everything at once, so the queue never fills.
      const out = byc.bycStep(s, 100, null);
      s = out.state;
      for (const e of out.events.filter((x) => x.type === 'spawn')) {
        const [min, max] = RANGES[e.packet.kind];
        assert.ok(Number.isInteger(e.packet.value) && e.packet.value >= min && e.packet.value <= max, e.packet.kind + ' ' + e.packet.value);
        if (mode === 'chmod') assert.ok(e.packet.value >> 6 >= 4, 'owner digit of ' + octalModel(e.packet.value));
        seen.add(e.packet.kind);
        s = apply(s, answerInputs(s.queue.find((p) => p.seq === s.sel))).state;
      }
    }
    assert.deepEqual([...seen].sort(), MODE_KINDS[mode].slice().sort(), mode + ': both kinds come up');
    assert.equal(s.drops, 0);
  }
});

test('byte-catcher: a packet that arrives with five queued is a tail drop; the third drop takes the link down and leaves the rest at 0', () => {
  const five = [1, 2, 3, 4, 5].map((v) => ({ kind: 'dec', value: v, ttl: 20000, life: 20000 }));
  let { state, events } = steps(withQueue('bin', five, { nextSpawn: 100, combo: 4 }), 1);
  assert.deepEqual(events.map((e) => [e.type, e.reason, e.packet.seq, e.drops]), [['drop', 'full', 6, 1]]);
  assert.equal(state.queue.length, 5);
  assert.equal(state.seq, 7);
  assert.equal(state.combo, 0, 'a drop breaks the combo');
  // Two packets run out in the same tick at two drops: the first one ends the run.
  const ending = withQueue('bin', [{ kind: 'dec', value: 1, ttl: 100 }, { kind: 'dec', value: 2, ttl: 50 }, { kind: 'dec', value: 3 }], { drops: 2, nextSpawn: 100 });
  ({ state, events } = steps(ending, 1));
  assert.deepEqual(events.map((e) => e.type), ['drop', 'over']);
  assert.equal(events[0].packet.seq, 1);
  assert.equal(state.status, 'over');
  assert.equal(state.drops, 3);
  assert.deepEqual(state.queue.map((p) => [p.seq, p.ttl]), [[2, 0], [3, 9900]], 'nothing arrives after the link went down');
  assert.equal(state.seq, 4);
  // A run that is over takes no more input and no more time.
  const after = byc.bycStep(state, 100, { type: 'toggle', bit: 0 });
  assert.deepEqual(after.events, [{ type: 'refuse', text: 'Link down after 3 drops: press New run for another go.' }]);
  assert.deepEqual(after.state, state);
});

test('byte-catcher: the selection is the most urgent packet and stays until it leaves; Up, Down and a tap pick another, starting the entry over', () => {
  assert.equal(byc.bycUrgent([]), null);
  assert.equal(byc.bycUrgent([{ seq: 1, ttl: 5 }, { seq: 2, ttl: 3 }, { seq: 3, ttl: 3 }]), 2, 'the first of equals');
  let s = withQueue('bin', [{ kind: 'dec', value: 1, ttl: 9000 }, { kind: 'dec', value: 2, ttl: 5000 }, { kind: 'dec', value: 3, ttl: 7000 }]);
  s = apply(s, { type: 'toggle', bit: 7 }).state;
  assert.equal(s.bits, 128);
  let out = apply(s, { type: 'move', dir: 1 });
  assert.deepEqual([out.state.sel, out.state.bits, out.events], [2, 0, []]);
  out = apply(out.state, [{ type: 'move', dir: 1 }, { type: 'toggle', bit: 7 }, { type: 'move', dir: 1 }]);
  assert.deepEqual([out.state.sel, out.state.bits], [3, 128], 'the last packet keeps the selection and the entry');
  out = apply(out.state, [{ type: 'move', dir: -1 }, { type: 'select', seq: 1 }, { type: 'toggle', bit: 7 }, { type: 'select', seq: 1 }]);
  assert.deepEqual([out.state.sel, out.state.bits], [1, 128], 'a tap on the selected packet keeps its entry');
  out = apply(out.state, { type: 'select', seq: 9 });
  assert.deepEqual(out.events, [{ type: 'refuse', text: 'Packet #0009 is no longer in the queue.' }]);
  // Forwarding #1 (DEC 1) selects the most urgent of the rest.
  out = apply(out.state, [{ type: 'back' }, { type: 'toggle', bit: 0 }]);
  assert.equal(out.events[0].type, 'forward');
  assert.deepEqual([out.state.sel, out.state.bits], [2, 0]);
  // A drop of the selected packet moves the selection too, and a packet arriving in an empty queue is selected.
  s = withQueue('bin', [{ kind: 'dec', value: 9, ttl: 100 }, { kind: 'dec', value: 7, ttl: 8000 }], { nextSpawn: 5000 });
  s = apply(s, { type: 'toggle', bit: 3 }).state;
  s = steps(s, 1).state;
  assert.deepEqual([s.sel, s.bits], [2, 0]);
  s = withQueue('bin', [], { nextSpawn: 100 });
  assert.equal(s.sel, null);
  s = steps(s, 1).state;
  assert.equal(s.sel, 1);
});

test('byte-catcher: Warm-up toggles forward the packet the moment they match, scoring the TTL left times the combo', () => {
  let s = withQueue('bin', [{ kind: 'hex', value: 0xB6, ttl: 9800 }, { kind: 'dec', value: 200, ttl: 12000 }]);
  let out = apply(s, answerInputs({ kind: 'hex', value: 0xB6 }));
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.events[0], { type: 'forward', packet: { seq: 1, kind: 'hex', value: 0xB6, ttl: 9800, life: 15000 }, points: 20, mult: 1 });
  assert.deepEqual([out.state.score, out.state.combo, out.state.bestCombo, out.state.forwarded], [20, 1, 1, 1]);
  assert.deepEqual([out.state.sel, out.state.bits, out.state.queue.length], [2, 0, 1]);
  // Backspace clears the toggles; Enter and digits are refused, naming the packet and the entry.
  out = apply(out.state, [{ type: 'toggle', bit: 7 }, { type: 'toggle', bit: 0 }]);
  assert.equal(out.state.bits, 129);
  out = apply(out.state, { type: 'send' });
  assert.deepEqual(out.events, [{ type: 'refuse', text: '#0002 DEC 200 forwards by itself once the bit toggles match it: you have 1000 0001.' }]);
  out = apply(out.state, { type: 'key', value: 3 });
  assert.deepEqual(out.events, [{ type: 'refuse', text: '#0002 DEC 200 is encoded on the bit toggles.' }]);
  out = apply(out.state, { type: 'back' });
  assert.equal(out.state.bits, 0);
  // At five clean forwards in a row the points double; the best combo stays.
  s = withQueue('bin', [{ kind: 'dec', value: 3, ttl: 4100 }], { combo: 5, bestCombo: 9 });
  out = apply(s, answerInputs(s.queue[0]));
  assert.deepEqual([out.events[0].points, out.events[0].mult, out.state.combo, out.state.bestCombo], [30, 2, 6, 9]);
});

test('byte-catcher: CIDR: four mask octets send themselves; a short mask or nothing is refused; a wrong mask is a CRC error', () => {
  let s = withQueue('cidr', [{ kind: 'cidr', value: 26, ttl: 12000 }, { kind: 'mask', value: 20 }, { kind: 'mask', value: 8 }], { combo: 3 });
  let out = apply(s, [{ type: 'key', value: 255 }, { type: 'key', value: 255 }, { type: 'send' }]);
  assert.deepEqual(out.events, [{ type: 'refuse', text: 'Nothing to send yet: #0001 /26 needs 255.255.___.___ filled in.' }]);
  out = apply(out.state, { type: 'key', value: 100 });
  assert.equal(out.events[0].text, '100 is not a mask octet (255, 254, 252, 248, 240, 224, 192, 128, 0).');
  out = apply(out.state, { type: 'toggle', bit: 1 });
  assert.equal(out.events[0].text, '#0001 /26 is encoded on the mask octet pad.');
  out = apply(out.state, [{ type: 'key', value: 255 }, { type: 'key', value: 128 }]);
  assert.deepEqual(out.events, [{ type: 'miss', packet: s.queue[0], text: '255.255.255.128 is /25, not /26' }]);
  assert.deepEqual([out.state.keys, out.state.combo, out.state.misses, out.state.sel], [[], 0, 1, 1], 'the packet waits for another try');
  out = apply(out.state, maskOctets(26).map((value) => ({ type: 'key', value })));
  assert.equal(out.events[0].type, 'forward');
  assert.equal(out.events[0].points, 22);
  // 255.255.240.0 -> /20: two digits send themselves.
  assert.equal(out.state.sel, 2);
  out = apply(out.state, [{ type: 'send' }]);
  assert.deepEqual(out.events, [{ type: 'refuse', text: 'Nothing to send yet: #0002 255.255.240.0 needs /__ filled in.' }]);
  out = apply(out.state, [{ type: 'key', value: 4 }, { type: 'key', value: 5 }]);
  assert.deepEqual(out.events, [{ type: 'refuse', text: '/45 is not a prefix length (0-32).' }]);
  assert.deepEqual(out.state.keys, [4]);
  out = apply(out.state, [{ type: 'back' }, { type: 'key', value: 2 }, { type: 'key', value: 4 }]);
  assert.equal(out.events[0].text, '/24 is 255.255.255.0, not 255.255.240.0');
  out = apply(out.state, [{ type: 'key', value: 2 }, { type: 'key', value: 0 }]);
  assert.equal(out.events[0].type, 'forward');
  // A one-digit prefix goes with Send.
  out = apply(out.state, [{ type: 'key', value: 8 }, { type: 'send' }]);
  assert.equal(out.events[0].type, 'forward');
  assert.deepEqual([out.state.forwarded, out.state.misses, out.state.queue.length], [3, 2, 0]);
});

test('byte-catcher: chmod: the rwx grid forwards a mode once it matches, and three octal digits send themselves', () => {
  const s = withQueue('chmod', [{ kind: 'octal', value: 0o750 }, { kind: 'rwx', value: 0o640 }]);
  let out = apply(s, [{ type: 'toggle', bit: 8 }, { type: 'back' }]);
  assert.equal(out.state.bits, 0);
  out = apply(out.state, answerInputs(s.queue[0]));
  assert.equal(out.events[0].type, 'forward');
  assert.equal(out.state.sel, 2);
  out = apply(out.state, { type: 'key', value: 8 });
  assert.deepEqual(out.events, [{ type: 'refuse', text: '8 is not an octal digit (0-7).' }]);
  out = apply(out.state, [6, 4, 4].map((value) => ({ type: 'key', value })));
  assert.equal(out.events[0].text, '644 is rw-r--r--, not rw-r-----');
  out = apply(out.state, [{ type: 'key', value: 6 }, { type: 'key', value: 4 }, { type: 'back' }, { type: 'key', value: 4 }, { type: 'key', value: 0 }]);
  assert.deepEqual(out.events.map((e) => e.type), ['forward']);
  assert.deepEqual([out.state.forwarded, out.state.misses], [2, 1]);
});

test('byte-catcher: toggles forward the oldest queued packet on their panel that they match, keeping the selection; typed entries stay with the selected packet', () => {
  // Brute force: DEC 5 selected, then HEX 200, DEC 200 and HEX 37; the toggles reach every byte with one last tap.
  const queue = [{ kind: 'dec', value: 5 }, { kind: 'hex', value: 200 }, { kind: 'dec', value: 200 }, { kind: 'hex', value: 37 }];
  for (let b = 1; b < 256; b++) {
    const s = withQueue('bin', queue, { bits: b ^ 1 });
    const out = apply(s, { type: 'toggle', bit: 0 });
    const hit = queue.findIndex((p) => p.value === b);
    if (hit === -1) {
      assert.deepEqual([out.events, out.state.bits, out.state.queue.length], [[], b, 4], 'byte ' + b);
    } else {
      assert.deepEqual(out.events.map((e) => [e.type, e.packet.seq]), [['forward', hit + 1]], 'byte ' + b);
      assert.deepEqual([out.state.bits, out.state.sel, out.state.forwarded], [0, hit === 0 ? 2 : 1, 1], 'byte ' + b);
    }
  }
  // Setting 0xB6 while DEC 7 is selected forwards the HEX packet behind it, then the DEC one.
  let s = withQueue('bin', [{ kind: 'dec', value: 7 }, { kind: 'hex', value: 0xB6, ttl: 9800 }, { kind: 'dec', value: 0xB6 }]);
  let out = apply(s, answerInputs({ kind: 'hex', value: 0xB6 }));
  assert.deepEqual(out.events.map((e) => [e.type, e.packet.seq, e.points]), [['forward', 2, 20]]);
  assert.deepEqual([out.state.sel, out.state.bits, out.state.queue.map((p) => p.seq)], [1, 0, [1, 3]]);
  out = apply(out.state, answerInputs({ kind: 'dec', value: 0xB6 }));
  assert.deepEqual([out.events[0].packet.seq, out.state.combo, out.state.queue.map((p) => p.seq)], [3, 2, [1]]);
  // A pattern on the way can forward another byte first: the toggles clear and the selected packet waits.
  out = apply(withQueue('bin', [{ kind: 'dec', value: 160 }, { kind: 'dec', value: 128 }]), { type: 'toggle', bit: 7 });
  assert.deepEqual([out.events[0].packet.seq, out.state.sel, out.state.bits], [2, 1, 0]);
  // chmod: the grid forwards any octal mode it matches, never an rwx packet (that one is typed).
  s = withQueue('chmod', [{ kind: 'octal', value: 0o750 }, { kind: 'rwx', value: 0o644 }, { kind: 'octal', value: 0o644 }]);
  out = apply(s, answerInputs({ kind: 'octal', value: 0o644 }));
  assert.deepEqual([out.events.map((e) => e.packet.seq), out.state.sel, out.state.bits], [[3], 1, 0]);
  s = withQueue('chmod', [{ kind: 'rwx', value: 0o400 }, { kind: 'octal', value: 0o400 }]);
  out = apply(s, { type: 'toggle', bit: 8 });
  assert.deepEqual(out.events, [{ type: 'refuse', text: '#0001 r-------- is encoded on the digit pad.' }]);
  // A typed entry only ever goes to the selected packet.
  s = withQueue('cidr', [{ kind: 'mask', value: 20 }, { kind: 'mask', value: 24 }]);
  out = apply(s, [{ type: 'key', value: 2 }, { type: 'key', value: 4 }]);
  assert.deepEqual(out.events.map((e) => [e.type, e.packet.seq]), [['miss', 1]]);
});

test('byte-catcher: inputs need a running run with a packet selected, and say why not', () => {
  const ready = byc.bycNewRun('bin', 1);
  assert.equal(byc.bycStep(ready, 0, { type: 'back' }).events[0].text, 'The link is not up yet: press Start or P to open the ingress queue.');
  const paused = Object.assign(byc.bycNewRun('bin', 1), { status: 'paused', t: 83000 });
  assert.equal(byc.bycStep(paused, 0, { type: 'back' }).events[0].text, 'Paused at 1:23: press Resume or P to go on.');
  const empty = withQueue('bin', [], { nextSpawn: 2100 });
  assert.equal(byc.bycStep(empty, 0, { type: 'toggle', bit: 1 }).events[0].text, 'The queue is empty: the next packet arrives in 2.1 s.');
  assert.equal(byc.bycStep(empty, 0, { type: 'move', dir: 1 }).events[0].type, 'refuse');
});

test('byte-catcher: event lines name the packet, its value and what happened', () => {
  const packet = (seq, kind, value) => ({ seq, kind, value, ttl: 0, life: 15000 });
  assert.equal(byc.bycEventText({ type: 'forward', packet: packet(12, 'hex', 0xB6), points: 20, mult: 1 }), '#0012 HEX 0xB6 forwarded as 1011 0110: +20.');
  assert.equal(byc.bycEventText({ type: 'forward', packet: packet(13, 'rwx', 0o750), points: 66, mult: 3 }), '#0013 rwxr-x--- forwarded as 750: +66 (x3 combo).');
  assert.equal(byc.bycEventText({ type: 'drop', packet: packet(7, 'cidr', 26), reason: 'ttl', drops: 1 }), '#0007 /26 dropped: TTL expired; it was 255.255.255.192. Drops 1/3.');
  assert.equal(byc.bycEventText({ type: 'drop', packet: packet(10, 'octal', 0o750), reason: 'full', drops: 2 }), '#0010 750 dropped: the ingress queue is full (5/5). Drops 2/3.');
  assert.equal(byc.bycEventText({ type: 'miss', packet: packet(4, 'cidr', 26), text: '255.255.255.128 is /25, not /26' }), 'CRC error on #0004 /26: 255.255.255.128 is /25, not /26. Combo reset.');
  assert.equal(byc.bycEventText({ type: 'refuse', text: 'No.' }), 'No.');
  assert.equal(byc.bycEventText({ type: 'spawn', packet: packet(1, 'dec', 1) }), '');
  assert.equal(byc.bycEventText({ type: 'over' }), '');
  assert.equal(byc.bycEventText({ type: 'forward', packet: packet(12345, 'mask', 8), points: 11, mult: 1 }), '#12345 255.0.0.0 forwarded as /8: +11.');
  assert.equal(byc.bycSummary(Object.assign(byc.bycNewRun('bin', 1), { drops: 3, score: 340, forwarded: 12, bestCombo: 7, t: 65000 })),
    'Link down after 3 drops: score 340, 12 forwarded, best combo 7, up 1:05.');
  assert.deepEqual([0, 999, 59999, 61000, 3600000].map(byc.bycFormatTime), ['0:00', '0:00', '0:59', '1:01', '60:00']);
});

// ── Keys ─────────────────────────────────────────────────────────────────────

test('byte-catcher: keys map to inputs by their value, then by the physical key on other layouts', () => {
  const k = (panel, key, code = '') => byc.bycKeyInput({ key, code }, panel);
  for (const panel of ['bits', 'grid', 'octets', 'digits']) {
    assert.deepEqual(k(panel, 'Backspace'), { type: 'back' });
    assert.deepEqual(k(panel, 'Enter'), { type: 'send' });
    assert.deepEqual(k(panel, 'ArrowUp'), { type: 'move', dir: -1 });
    assert.deepEqual(k(panel, 'ArrowDown'), { type: 'move', dir: 1 });
    assert.deepEqual(k(panel, 'p'), { type: 'pause' });
    assert.deepEqual(k(panel, 'P'), { type: 'pause' });
    assert.deepEqual(k(panel, 'з', 'KeyP'), { type: 'pause' });
    assert.equal(k(panel, 'x'), null);
    assert.equal(k(panel, 'Tab'), null);
    assert.equal(byc.bycKeyInput({}, panel), null, 'a keydown without a key (autofill)');
  }
  // Bits: 1-8 and the home row from 128 down to 1.
  ['1', '2', '3', '4', '5', '6', '7', '8'].forEach((key, i) => assert.deepEqual(k('bits', key), { type: 'toggle', bit: 7 - i }));
  ['a', 's', 'd', 'f', 'j', 'k', 'l', ';'].forEach((key, i) => assert.deepEqual(k('bits', key), { type: 'toggle', bit: 7 - i }));
  assert.deepEqual(k('bits', 'L'), { type: 'toggle', bit: 1 });
  assert.deepEqual(k('bits', 'ф', 'KeyA'), { type: 'toggle', bit: 7 });
  assert.deepEqual(k('bits', 'ж', 'Semicolon'), { type: 'toggle', bit: 0 });
  assert.deepEqual(k('bits', '&', 'Digit1'), { type: 'toggle', bit: 7 }, 'AZERTY');
  assert.deepEqual(k('bits', 'End', 'Numpad3'), { type: 'toggle', bit: 5 }, 'the keypad without Num Lock');
  assert.equal(k('bits', '9'), null);
  assert.equal(k('bits', '0'), null);
  // The grid: 1-9 row by row, owner read first.
  for (let d = 1; d <= 9; d++) assert.deepEqual(k('grid', String(d)), { type: 'toggle', bit: 9 - d });
  assert.equal(k('grid', '0'), null);
  assert.equal(k('grid', 'a'), null);
  // Mask octets 1-9 from 255 down to 0, digits 0-9 as they are.
  byc.bycOctets.forEach((octet, i) => assert.deepEqual(k('octets', String(i + 1)), { type: 'key', value: octet }));
  assert.equal(k('octets', '0'), null);
  for (let d = 0; d <= 9; d++) assert.deepEqual(k('digits', String(d)), { type: 'key', value: d });
  assert.deepEqual(k('digits', 'à', 'Digit0'), { type: 'key', value: 0 });
  assert.equal(k('digits', 'a'), null);
});

// ── Saves ────────────────────────────────────────────────────────────────────

test('byte-catcher: bycParseState reads a save of the current format field for field, and bycSerialize writes it back byte for byte', () => {
  const state = byc.bycParseState(SAMPLE_SAVE, 1);
  const raw = JSON.parse(SAMPLE_SAVE);
  delete raw.v;
  assert.deepEqual(state, raw);
  assert.equal(JSON.stringify(byc.bycSerialize(state)), SAMPLE_SAVE);
  // A fresh run round-trips as well.
  const fresh = byc.bycNewRun('chmod', 5);
  assert.deepEqual(byc.bycParseState(JSON.stringify(byc.bycSerialize(fresh)), 9), fresh);
});

test('byte-catcher: bycParseState falls back field by field, and a damaged packet is left out alone', () => {
  const base = {
    v: 1, mode: 'bin', status: 'paused', t: 5000, seed: 123, seq: 4, nextSpawn: 2000,
    queue: [{ seq: 2, kind: 'dec', value: 182, ttl: 8000, life: 14800 }, { seq: 3, kind: 'hex', value: 15, ttl: 12000, life: 14700 }],
    sel: 3, keys: [], bits: 9, score: 40, combo: 2, bestCombo: 3, forwarded: 2, drops: 1, misses: 0
  };
  const parse = (extra) => byc.bycParseState(JSON.stringify(Object.assign({}, base, extra)), 999);
  const expected = Object.assign({}, base);
  delete expected.v;
  assert.deepEqual(parse({}), expected);
  const same = (extra, changes, name) => assert.deepEqual(parse(extra), Object.assign({}, expected, changes), name || JSON.stringify(extra));
  const P2 = base.queue[0];
  const P3 = base.queue[1];
  same({ mode: 'nope' }, {});
  same({ mode: 'cidr' }, { mode: 'cidr', queue: [], sel: null, bits: 0, nextSpawn: 2000 }, 'Warm-up packets are no CIDR packets');
  for (const seed of [-1, 4294967296, 1.5, '123', null]) same({ seed }, { seed: 999 });
  same({ seed: 4294967295 }, { seed: 4294967295 });
  same({ t: -1 }, { t: 0, status: 'ready' });
  same({ t: 'x' }, { t: 0, status: 'ready' });
  same({ seq: 1 }, { seq: 4 }, 'the next packet number is past the queue');
  same({ seq: 10 }, { seq: 10 });
  same({ seq: -3 }, { seq: 4 });
  same({ nextSpawn: 9000 }, { nextSpawn: 6400 }, 'too long a wait: the interval of the moment');
  same({ nextSpawn: 6501 }, { nextSpawn: 6400 });
  same({ nextSpawn: -5 }, { nextSpawn: 6400 });
  same({ nextSpawn: 6500 }, { nextSpawn: 6500 });
  same({ nextSpawn: undefined, t: 0 }, { nextSpawn: 0, t: 0, status: 'ready' }, 'a run that never ran gets its first packet at once');
  same({ queue: 'x' }, { queue: [], sel: null, bits: 0 });
  same({ queue: [null, 7, [], { seq: 1, kind: 'cidr', value: 26, ttl: 1, life: 2 }, P2, P3] }, {});
  for (const bad of [
    { kind: 'dec', value: 0 }, { kind: 'dec', value: 256 }, { kind: 'dec', value: 1.5 }, { kind: 'dec', value: '7' },
    { seq: 0 }, { seq: 1.5 }, { seq: 'a' }, { ttl: -1 }, { ttl: 14801 }, { ttl: '5' }, { life: 0 }, { life: 22001, ttl: 100 }, { life: 'x' }, { kind: 'toString' }
  ]) {
    same({ queue: [Object.assign({}, P2, { seq: 1 }, bad), P2, P3] }, {}, JSON.stringify(bad));
  }
  same({ queue: [P2, Object.assign({}, P3, { seq: 2 }), P3] }, {}, 'a repeated seq');
  const six = [1, 2, 3, 4, 5, 6].map((seq) => Object.assign({}, P2, { seq }));
  same({ queue: six, sel: 1, seq: 7 }, { queue: six.slice(0, 5), sel: 1, seq: 7, bits: 9 }, 'five slots at most');
  same({ queue: [Object.assign({}, P2, { ttl: 0 })] , sel: 2 }, { queue: [Object.assign({}, P2, { ttl: 0 })], sel: 2 });
  same({ sel: 2 }, { sel: 2 });
  same({ sel: 7 }, { sel: 2, bits: 0 }, 'a lost selection goes to the most urgent packet');
  same({ sel: '3' }, { sel: 2, bits: 0 });
  for (const bits of [256, -1, 1.5, '9']) same({ bits }, { bits: 0 });
  same({ bits: 255 }, { bits: 255 });
  same({ keys: [1] }, {}, 'toggles have no keys');
  same({ score: '40' }, { score: 0 });
  same({ forwarded: 2.5 }, { forwarded: 0 });
  same({ combo: 5 }, { combo: 5, bestCombo: 5 });
  same({ combo: -1 }, { combo: 0 });
  same({ misses: null }, { misses: 0 });
  same({ drops: 3 }, { drops: 3, status: 'over' });
  same({ drops: 9 }, { drops: 3, status: 'over' });
  same({ drops: -1 }, { drops: 0 });
  for (const status of ['running', 'over', 'ready', 'x']) same({ status }, {}, 'the status comes from the run: ' + status);
  // Typed keys are kept when they could have been typed for the selected packet.
  const keysOf = (kind, value, keys, bits) => {
    const packet = { seq: 1, kind, value, ttl: 9000, life: 20000 };
    return byc.bycParseState(JSON.stringify(Object.assign({}, base, { mode: kind === 'octal' || kind === 'rwx' ? 'chmod' : 'cidr', queue: [packet], sel: 1, keys, bits })), 1);
  };
  assert.deepEqual(keysOf('cidr', 26, [255, 255, 255]).keys, [255, 255, 255]);
  for (const keys of [[255, 255, 255, 255], [255, 7], ['255'], 'x', [255, -1]]) assert.deepEqual(keysOf('cidr', 26, keys).keys, [], JSON.stringify(keys));
  assert.equal(keysOf('cidr', 26, [], 5).bits, 0, 'a mask has no toggles');
  assert.deepEqual(keysOf('mask', 20, [3]).keys, [3]);
  for (const keys of [[3, 3], [12], [-1], [4, 5]]) assert.deepEqual(keysOf('mask', 20, keys).keys, [], JSON.stringify(keys));
  assert.deepEqual(keysOf('rwx', 0o750, [7, 5]).keys, [7, 5]);
  for (const keys of [[8], [7, 5, 0]]) assert.deepEqual(keysOf('rwx', 0o750, keys).keys, [], JSON.stringify(keys));
  assert.equal(keysOf('octal', 0o750, [], 511).bits, 511);
  assert.equal(keysOf('octal', 0o750, [], 512).bits, 0);
});

test('byte-catcher: a save that is not a JSON object gives a fresh ready Warm-up run on the seed given', () => {
  for (const text of [null, '', '{', '[]', '"x"', '42', 'null', 'true', '{}']) {
    assert.deepEqual(byc.bycParseState(text, 77), byc.bycNewRun('bin', 77), String(text));
  }
});

test('byte-catcher: bycParseBest keeps a score and a count per mode, each on its own, and bycMergeBest keeps the higher of each', () => {
  const zero = { score: 0, forwarded: 0 };
  assert.deepEqual(byc.bycParseBest(null), { bin: zero, cidr: zero, chmod: zero });
  assert.deepEqual(byc.bycParseBest('[1]'), { bin: zero, cidr: zero, chmod: zero });
  assert.deepEqual(byc.bycParseBest('{"bin":{"score":5,"forwarded":"x"},"cidr":7,"chmod":{"score":-1,"forwarded":3}}'),
    { bin: { score: 5, forwarded: 0 }, cidr: zero, chmod: { score: 0, forwarded: 3 } });
  const a = { bin: { score: 5, forwarded: 9 }, cidr: { score: 1, forwarded: 1 }, chmod: zero };
  const b = { bin: { score: 7, forwarded: 2 }, cidr: zero, chmod: { score: 4, forwarded: 0 } };
  assert.deepEqual(byc.bycMergeBest(a, b), { bin: { score: 7, forwarded: 9 }, cidr: { score: 1, forwarded: 1 }, chmod: { score: 4, forwarded: 0 } });
});

// ── The page ─────────────────────────────────────────────────────────────────

test('byte-catcher: loading the script under Node runs no init: no lookup, listener, timer or save', (t) => {
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const setIntervalSpy = t.mock.method(globalThis, 'setInterval');
  const page = createPage(htmlPageSpec(HTML)).install();
  const fresh = loadScript(SCRIPT);
  assert.equal(typeof fresh.bycInit, 'function');
  assert.deepEqual(page.requested, []);
  assert.equal(page.els['byc-queue'].children.length, 0);
  assert.equal(listenerCount(document), 0);
  assert.equal(listenerCount(window), 0);
  assert.equal(setTimeoutSpy.mock.callCount(), 0);
  assert.equal(setIntervalSpy.mock.callCount(), 0);
  assert.equal(localStorage.length, 0);
});

test('byte-catcher: a first visit shows Warm-up ready with an empty queue, builds the pads once and saves nothing', (t) => {
  const { clock, v } = openPage(t);
  assert.equal(v.text('status'), 'Warm-up is ready on eth0: press Start to bring the link up.');
  assert.equal(v.text('prompt'), 'eth0 is down: press Start.');
  assert.equal(v.text('entry'), '0000 0000');
  assert.equal(v.text('iface'), 'eth0 ingress · 0/5 queued · Warm-up');
  assert.equal(v.el('link').className, 'byc-link byc-link--idle');
  assert.equal(v.con.className, 'byc-console byc-console--ready');
  assert.deepEqual(['score', 'combo', 'forwarded', 'drops', 'uptime', 'best'].map(v.text), ['0', '0', '0', '0/3', '0:00', '0']);
  assert.equal(v.text('pause'), 'Start');
  assert.equal(v.el('pause').getAttribute('aria-label'), 'Start the run');
  assert.equal(v.el('pause').disabled, false);
  assert.equal(v.text('new'), 'New run');
  assert.equal(v.el('mode').value, 'bin');
  // Five empty slots.
  assert.equal(v.slots().length, 5);
  v.slots().forEach((slot, i) => {
    assert.equal(slot.tagName, 'BUTTON');
    assert.equal(slot.getAttribute('type'), 'button');
    assert.equal(slot.className, 'byc-slot byc-slot--empty');
    assert.equal(slot.disabled, true);
    assert.equal(slot.getAttribute('aria-label'), 'Queue slot ' + (i + 1) + ': empty');
    assert.deepEqual(v.slot(i), ['', 'idle', '', '']);
    assert.equal(v.fill(i), '0%');
  });
  // The pads: 8 bits, a 3x3 grid with its heads, 9 mask octets and 10 digits.
  const bits = v.el('bits').children;
  assert.deepEqual(bits.map((b) => b.children.map((s) => s.textContent)), [
    ['128', '1 A'], ['64', '2 S'], ['32', '3 D'], ['16', '4 F'], ['8', '5 J'], ['4', '6 K'], ['2', '7 L'], ['1', '8 ;']
  ]);
  for (const b of bits) {
    assert.equal(b.className, 'byc-key byc-key--bit');
    assert.equal(b.getAttribute('type'), 'button');
    assert.equal(b.getAttribute('aria-pressed'), 'false');
    assert.equal(b.getAttribute('aria-label'), 'Bit ' + b.children[0].textContent);
  }
  const grid = v.el('grid').children;
  assert.deepEqual(grid.map((el) => el.tagName === 'BUTTON' ? el.getAttribute('aria-label') + '=' + el.getAttribute('data-bit') : el.textContent), [
    'o', 'owner read=8', 'owner write=7', 'owner execute=6',
    'g', 'group read=5', 'group write=4', 'group execute=3',
    'o', 'other read=2', 'other write=1', 'other execute=0'
  ]);
  assert.deepEqual(grid.filter((el) => el.tagName === 'BUTTON').map((b) => b.children.map((s) => s.textContent).join(' ')),
    ['r 1', 'w 2', 'x 3', 'r 4', 'w 5', 'x 6', 'r 7', 'w 8', 'x 9']);
  assert.deepEqual(v.el('octets').children.map((b) => b.children.map((s) => s.textContent).join(' ')),
    ['255 1', '254 2', '252 3', '248 4', '240 5', '224 6', '192 7', '128 8', '0 9']);
  assert.deepEqual(v.el('digits').children.map((b) => b.getAttribute('data-value')), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
  assert.deepEqual(['bits', 'grid', 'octets', 'digits', 'send'].map(v.hidden), [false, true, true, true, true]);
  assert.equal(v.text('back'), 'Clear');
  assert.equal(v.el('back').getAttribute('aria-label'), 'Clear the toggles');
  assert.equal(v.hidden('warning'), true);
  assert.equal(v.toast(), null);
  // One listener per control; keys on the wrapper only; visibility on document; storage on window.
  for (const [name, type] of [['root', 'keydown'], ['queue', 'click'], ['bits', 'click'], ['grid', 'click'], ['octets', 'click'], ['digits', 'click'],
    ['back', 'click'], ['send', 'click'], ['pause', 'click'], ['new', 'click'], ['mode', 'change']]) {
    assert.equal(listenerCount(v.el(name), type), 1, name + ' ' + type);
  }
  assert.equal(listenerCount(v.el('root')), 1);
  assert.equal(listenerCount(v.con), 0);
  assert.equal(listenerCount(document), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(document.body), 0);
  assert.equal(listenerCount(window), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  clock.advance(5000);
  assert.equal(v.slots()[0].className, 'byc-slot byc-slot--empty', 'no packet before Start');
  assert.equal(localStorage.length, 0, 'a page that only looks writes nothing');
});

test('byte-catcher: while the page is still loading the game waits for DOMContentLoaded', (t) => {
  const { v } = openPage(t, { storage: { state: SAMPLE_SAVE }, options: { readyState: 'loading' } });
  assert.equal(v.slots().length, 0);
  assert.equal(v.text('status'), 'Booting the router...');
  assert.equal(listenerCount(document, 'DOMContentLoaded'), 1);
  assert.equal(listenerCount(v.el('root'), 'keydown'), 0);
  v.ready();
  assert.equal(v.slots().length, 5);
  assert.equal(v.text('score'), '57');
  assert.equal(listenerCount(v.el('root'), 'keydown'), 1);
});

test('byte-catcher: init runs once: a second call builds and binds nothing twice', (t) => {
  makeClock(t);
  t.mock.method(Math, 'random', seeded(1));
  const { exports: fresh, els } = loadWithPage(SCRIPT, htmlPageSpec(HTML), { keep: true });
  fresh.bycInit();
  fresh.bycInit();
  assert.equal(els['byc-queue'].children.length, 5);
  assert.equal(els['byc-bits'].children.length, 8);
  assert.equal(listenerCount(els['byc-root'], 'keydown'), 1);
  assert.equal(listenerCount(els['byc-pause'], 'click'), 1);
  assert.equal(listenerCount(document, 'visibilitychange'), 1);
  assert.equal(listenerCount(window, 'storage'), 1);
  assert.ok(fresh.bycRuntime.els.root === els['byc-root']);
});

test('byte-catcher: Start brings eth0 up: a packet arrives at once, its TTL counts down, and tapping its bits forwards it', (t) => {
  const { clock, v } = openPage(t, { random: 3 });
  const first = byc.bycStep(running('bin', firstSeed(3)), 100, null).events[0].packet;
  v.click('pause');
  assert.ok(document.activeElement === v.con, 'a click on Start hands the keys to the console');
  assert.equal(v.text('pause'), 'Pause');
  assert.equal(v.el('pause').getAttribute('aria-label'), 'Pause the run');
  assert.equal(v.text('status'), 'eth0 is up: encode the selected packet before its TTL runs out.');
  assert.equal(v.con.className, 'byc-console byc-console--running');
  assert.equal(v.el('link').className, 'byc-link byc-link--up');
  assert.deepEqual([v.state().status, v.state().t, v.state().queue], ['running', 0, []], 'saved as it starts');
  clock.advance(100);
  const label = valueModel(first.kind, first.value);
  assert.deepEqual(v.slot(0), ['#0001', label, '→ bits', '22.0 s']);
  assert.equal(v.slots()[0].className, 'byc-slot byc-slot--sel');
  assert.equal(v.slots()[0].getAttribute('aria-label'), 'Packet #0001, ' + label + ' to bits, TTL 22.0 s, selected');
  assert.equal(v.slots()[0].getAttribute('data-seq'), '1');
  assert.equal(v.slots()[0].disabled, false);
  assert.equal(v.fill(0), '100%');
  assert.equal(v.text('prompt'), '#0001: set the 8 bits');
  assert.equal(v.text('iface'), 'eth0 ingress · 1/5 queued · Warm-up');
  clock.advance(1000);
  assert.equal(v.slot(0)[3], '21.0 s');
  assert.equal(v.fill(0), '95%');
  assert.equal(v.text('uptime'), '0:01');
  assert.equal(v.state().t, 1000, 'saved every second');
  // The bits light up as they are tapped; the last one forwards the packet.
  const bits = answerInputs(first);
  bits.slice(0, -1).forEach((input) => v.bitKey(input.bit).click());
  for (const input of bits.slice(0, -1)) {
    assert.equal(v.bitKey(input.bit).className, 'byc-key byc-key--bit byc-key--on');
    assert.equal(v.bitKey(input.bit).getAttribute('aria-pressed'), 'true');
  }
  assert.equal(v.text('entry'), nibbles(binModel(bits.slice(0, -1).reduce((sum, input) => sum + (1 << input.bit), 0))));
  assert.equal(v.state().bits, first.value - (1 << bits[bits.length - 1].bit), 'each toggle is saved');
  v.bitKey(bits[bits.length - 1].bit).click();
  assert.equal(v.text('status'), '#0001 ' + label + ' forwarded as ' + nibbles(binModel(first.value)) + ': +31.');
  assert.deepEqual(['score', 'combo', 'forwarded'].map(v.text), ['31', '1', '1']);
  assert.equal(v.state().forwarded, 1);
  assert.equal(v.text('entry'), '0000 0000');
  assert.equal(v.el('bits').children.filter((b) => b.classList.contains('byc-key--on')).length, 0);
  assert.equal(v.text('prompt'), 'Queue empty: next packet in 5.4 s.');
  assert.equal(v.slots()[0].className, 'byc-slot byc-slot--empty');
  // A click between the keys of a pad is no key.
  v.el('bits').click();
  v.el('queue').click();
  assert.equal(v.text('prompt'), 'Queue empty: next packet in 5.4 s.');
});

test('byte-catcher: keys work only with the focus in the game: bits by number and home row, Backspace, Enter, P, held keys once', (t) => {
  const { clock, v } = openPage(t, { storage: { state: save({ queue: [{ seq: 1, kind: 'hex', value: 0xB6, ttl: 9000, life: 15000 }, { seq: 2, kind: 'dec', value: 3, ttl: 12000, life: 15000 }], seq: 3 }) } });
  // Keys typed into host-page fields, links, buttons or the page body never reach the game.
  const input = v.page.add('host-input', 'input');
  const link = v.page.add('host-link', 'a');
  const button = v.page.add('host-button', 'button');
  for (const target of [input, link, button, document.body]) {
    for (const key of ['p', '1', 'a', 'Backspace', 'ArrowDown']) assert.equal(pressKey(key, { target }).defaultPrevented, false, key);
  }
  assert.equal(v.text('pause'), 'Resume');
  // The mode select and fields inside the game keep their keys too.
  const inner = [v.el('mode'), v.page.add('inner-input', { tagName: 'input', parent: 'byc-root' }),
    v.page.add('inner-text', { tagName: 'textarea', parent: 'byc-root' }), v.page.add('inner-edit', { tagName: 'div', parent: 'byc-root', isContentEditable: true })];
  for (const target of inner) {
    focusElement(target);
    assert.equal(pressKey('p', { target }).defaultPrevented, false, target.tagName);
  }
  assert.equal(v.text('pause'), 'Resume');
  // P on the console resumes; a held P does nothing more.
  assert.equal(v.press('p').defaultPrevented, true);
  assert.equal(v.text('pause'), 'Pause');
  assert.equal(v.press('P', { repeat: true }).defaultPrevented, true);
  assert.equal(v.text('pause'), 'Pause');
  // 1 is 128, the home row and the physical keys too; a held key toggles once.
  v.press('1');
  v.press('2', { repeat: true });
  v.press('d');
  v.press('ж', { code: 'Semicolon' });
  assert.equal(v.state().bits, 128 + 32 + 1);
  assert.equal(v.text('entry'), '1010 0001');
  // Shortcuts, composing text and keys a page script handled stay with the browser.
  for (const props of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    for (const key of ['1', 'p', 'Backspace', 'ArrowDown']) assert.equal(v.press(key, props).defaultPrevented, false, key + ' ' + JSON.stringify(props));
  }
  const handled = (event) => event.preventDefault();
  document.addEventListener('keydown', handled, true);
  v.press('2');
  document.removeEventListener('keydown', handled, true);
  assert.equal(v.state().bits, 161);
  for (const key of ['x', 'Tab', ' ', '9']) assert.equal(v.press(key).defaultPrevented, false, key);
  assert.equal(v.press(undefined).defaultPrevented, false);
  // Enter tells why it is not needed; Backspace clears.
  assert.equal(v.press('Enter').defaultPrevented, true);
  assert.equal(v.text('status'), '#0001 HEX 0xB6 forwards by itself once the bit toggles match it: you have 1010 0001.');
  v.press('Backspace');
  assert.equal(v.text('entry'), '0000 0000');
  // On a focused game button Enter and Space are the button's, other keys the game's.
  const back = v.el('back');
  v.press('1');
  focusElement(back, { keyboard: true });
  assert.equal(pressKey('Enter', { target: back }).defaultPrevented, false);
  assert.equal(v.text('entry'), '0000 0000', 'Enter clicked the focused Clear button');
  focusElement(back, { keyboard: true });
  assert.equal(pressKey(' ', { target: back }).defaultPrevented, false);
  focusElement(back, { keyboard: true });
  assert.equal(pressKey('8', { target: back }).defaultPrevented, true);
  assert.equal(v.text('entry'), '0000 0001');
  fire(back, 'click', { detail: 0 });
  assert.ok(document.activeElement === v.con, 'Clear hands the keys to the console, also from the keyboard: the next packet may hide it');
  assert.equal(v.text('entry'), '0000 0000');
  // Start / Pause activated from the keyboard keeps the focus on the button; a pointer click hands it to the console.
  const pause = v.el('pause');
  focusElement(pause, { keyboard: true });
  fire(pause, 'click', { detail: 0 });
  assert.equal(v.text('pause'), 'Resume');
  fire(pause, 'click', { detail: 0 });
  assert.equal(v.text('pause'), 'Pause');
  assert.ok(document.activeElement === pause);
  pause.click();
  pause.click();
  assert.ok(document.activeElement === v.con);
  // Down picks the next packet (held, it repeats), Up the one before.
  v.press('ArrowDown');
  assert.equal(v.slots()[1].className, 'byc-slot byc-slot--sel');
  assert.equal(v.text('prompt'), '#0002: set the 8 bits');
  v.press('ArrowUp', { repeat: true });
  assert.equal(v.slots()[0].className, 'byc-slot byc-slot--sel');
  v.press('ArrowDown', { repeat: true });
  v.press('7');
  v.press('8');
  assert.equal(v.text('status'), '#0002 DEC 3 forwarded as 0000 0011: +22.');
  // P pauses; keys while paused say so.
  v.press('p');
  assert.equal(v.text('status'), 'Paused at 0:01: press Resume or P to go on.');
  clock.advance(1000);
  v.press('1');
  assert.equal(v.text('status'), 'Paused at 0:01: press Resume or P to go on.');
  assert.equal(listenerCount(v.el('root'), 'keydown'), 1);
});

test('byte-catcher: the help summary keeps Enter and every other key; Start and New run keep all but P; the arrows move only a running run from the console or a slot', (t) => {
  const queue = [{ seq: 1, kind: 'hex', value: 0xB6, ttl: 9000, life: 22000 }, { seq: 2, kind: 'dec', value: 7, ttl: 12000, life: 22000 }];
  const { v } = openPage(t, { storage: { state: save({ queue, seq: 3 }) } });
  // The real markup has a <details> with its summary inside the wrapper and outside the console.
  assert.match(embedMarkup(HTML), /<details class="byc-help">\s*<summary class="byc-help-title">How to play<\/summary>/);
  assert.ok(HTML.indexOf('<details') > HTML.indexOf('id="byc-status"'));
  const summary = v.page.add('help-summary', { tagName: 'summary', parent: 'byc-root' });
  const status = v.text('status');
  focusElement(summary, { keyboard: true });
  for (const key of ['Enter', ' ', '1', 'a', 'p', 'P', 'Backspace', 'ArrowDown', 'ArrowUp', '0']) {
    assert.equal(pressKey(key, { target: summary }).defaultPrevented, false, 'paused, summary ' + key);
  }
  assert.deepEqual([v.text('status'), v.text('pause')], [status, 'Resume'], 'Enter on the summary is no Send');
  // P on Start / Pause and on New run is the game's; nothing else there is.
  const pause = v.el('pause');
  const fresh = v.el('new');
  focusElement(pause, { keyboard: true });
  assert.equal(pressKey('p', { target: pause }).defaultPrevented, true);
  assert.equal(v.text('pause'), 'Pause');
  assert.ok(document.activeElement === pause, 'P leaves the focus where it was');
  for (const target of [summary, pause, fresh]) {
    focusElement(target, { keyboard: true });
    for (const key of ['1', 'a', 'Backspace', 'ArrowDown', 'ArrowUp', '0']) {
      assert.equal(pressKey(key, { target }).defaultPrevented, false, 'running, ' + target.tagName + ' ' + key);
    }
  }
  focusElement(summary, { keyboard: true });
  assert.equal(pressKey('Enter', { target: summary }).defaultPrevented, false);
  assert.equal(pressKey('p', { target: summary }).defaultPrevented, false);
  assert.deepEqual([v.state().bits, v.state().sel, v.text('pause')], [0, 1, 'Pause'], 'nothing reached the run');
  // On a pad key the arrows scroll the page; its digits are the game's.
  const bit = v.bitKey(7);
  focusElement(bit, { keyboard: true });
  assert.equal(pressKey('ArrowDown', { target: bit }).defaultPrevented, false);
  assert.equal(v.state().sel, 1);
  assert.equal(pressKey('8', { target: bit }).defaultPrevented, true);
  assert.equal(v.text('entry'), '0000 0001');
  // On a queue slot and on the console they pick another packet.
  const slot = v.slots()[0];
  focusElement(slot, { keyboard: true });
  assert.equal(pressKey('ArrowDown', { target: slot }).defaultPrevented, true);
  assert.equal(v.state().sel, 2);
  assert.equal(v.press('ArrowUp').defaultPrevented, true);
  assert.equal(v.state().sel, 1);
  // P on New run pauses; while paused (or ready) the arrows on the console are the page's again.
  focusElement(fresh, { keyboard: true });
  assert.equal(pressKey('P', { target: fresh }).defaultPrevented, true);
  assert.equal(v.text('pause'), 'Resume');
  const paused = v.text('status');
  assert.equal(v.press('ArrowDown').defaultPrevented, false);
  assert.equal(v.press('ArrowUp').defaultPrevented, false);
  assert.equal(v.text('status'), paused, 'no refusal for a page scroll');
  assert.equal(v.state().sel, 1);
  resetStubs();
  const ready = openPage(t).v;
  assert.equal(ready.press('ArrowDown').defaultPrevented, false, 'ready');
  assert.equal(ready.press('1').defaultPrevented, true, 'a game key on the console still says why it waits');
  assert.equal(ready.text('status'), 'The link is not up yet: press Start or P to open the ingress queue.');
});

test('byte-catcher: an input that changes nothing writes nothing: a held arrow at the end of the queue, Backspace on an empty entry, a refusal', (t) => {
  const queue = [{ seq: 1, kind: 'hex', value: 0xB6, ttl: 9000, life: 22000 }, { seq: 2, kind: 'dec', value: 7, ttl: 12000, life: 22000 }];
  const { v } = openPage(t, { storage: { state: save({ queue, seq: 3 }) } });
  v.click('pause');
  const setItem = t.mock.method(localStorage, 'setItem');
  const writes = () => setItem.mock.calls.filter((call) => call.arguments[0] === STATE_KEY).length;
  v.press('ArrowDown');
  assert.deepEqual([writes(), v.state().sel], [1, 2]);
  for (let i = 0; i < 30; i++) v.press('ArrowDown', { repeat: true });
  v.press('Backspace');
  v.press('Backspace');
  v.press('Enter');
  v.click('back');
  assert.equal(v.text('status'), '#0002 DEC 7 forwards by itself once the bit toggles match it: you have 0000 0000.');
  assert.equal(writes(), 1, 'nothing changed: nothing written');
  v.press('1');
  v.press('Backspace');
  assert.equal(writes(), 3);
  // Toggles that forward another packet are saved with the selection kept.
  v.tapBits(0xB6);
  assert.equal(v.text('status'), '#0001 HEX 0xB6 forwarded as 1011 0110: +19.');
  assert.deepEqual([v.state().sel, v.state().bits, v.state().queue.map((p) => p.seq)], [2, 0, [2]]);
  assert.equal(writes(), 3 + 5, 'one write for each of the five taps');
  assert.equal(v.slots()[0].className, 'byc-slot byc-slot--sel');
  assert.equal(v.text('prompt'), '#0002: set the 8 bits');
});

test('byte-catcher: CIDR on the page: mask octets from the pad, a prefix from the digits, Send and Delete, a tap to pick a packet', (t) => {
  const queue = [{ seq: 1, kind: 'cidr', value: 26, ttl: 20000, life: 22000 }, { seq: 2, kind: 'mask', value: 20, ttl: 21000, life: 22000 }];
  const { clock, v } = openPage(t, { storage: { state: save({ mode: 'cidr', queue, seq: 3, nextSpawn: 6000 }) } });
  assert.equal(v.el('mode').value, 'cidr');
  assert.deepEqual(['bits', 'grid', 'octets', 'digits', 'send'].map(v.hidden), [true, true, false, true, false]);
  assert.equal(v.text('back'), 'Delete');
  assert.equal(v.el('back').getAttribute('aria-label'), 'Delete the last key');
  assert.equal(v.text('prompt'), '#0001: pick the 4 mask octets');
  assert.deepEqual(v.slot(1), ['#0002', '255.255.240.0', '→ /len', '21.0 s']);
  assert.equal(v.text('status'), 'Run restored, paused at 0:01 (CIDR, score 0): press Resume or P to go on.');
  v.click('pause');
  assert.equal(v.text('status'), 'Resumed at 0:01.');
  v.tapOctets([255, 255]);
  assert.equal(v.text('entry'), '255.255.___.___');
  assert.ok(document.activeElement === v.con, 'a tap on a pad key hands the keys to the console');
  v.click('send');
  assert.equal(v.text('status'), 'Nothing to send yet: #0001 /26 needs 255.255.___.___ filled in.');
  v.click('back');
  assert.equal(v.text('entry'), '255.___.___.___');
  v.tapOctets([255, 255, 128]);
  assert.equal(v.text('status'), 'CRC error on #0001 /26: 255.255.255.128 is /25, not /26. Combo reset.');
  assert.equal(v.state().misses, 1);
  // Keys 1-9 pick the pad's octets.
  v.press('1');
  v.press('1');
  assert.equal(v.text('entry'), '255.255.___.___');
  // A tap on the other packet picks it and starts its entry over; the keys stay with the console.
  focusElement(v.slots()[1], { keyboard: true });
  fire(v.slots()[1].children[0].children[1], 'click', { detail: 0 });
  assert.ok(document.activeElement === v.con, 'a slot that is picked may empty out: the console keeps the keys');
  assert.equal(v.slots()[1].className, 'byc-slot byc-slot--sel');
  assert.deepEqual(['octets', 'digits'].map(v.hidden), [true, false]);
  assert.equal(v.text('entry'), '/__');
  assert.equal(v.text('prompt'), '#0002: type the prefix length');
  v.tapDigits([2]);
  assert.equal(v.text('entry'), '/2_');
  v.tapDigits([0]);
  assert.equal(v.text('status'), '#0002 255.255.240.0 forwarded as /20: +31.');
  // Back to the mask: four octets send themselves.
  assert.equal(v.text('prompt'), '#0001: pick the 4 mask octets');
  clock.advance(2000);
  v.press('1');
  v.press('1');
  v.press('1');
  v.press('7');
  assert.equal(v.text('status'), '#0001 /26 forwarded as 255.255.255.192: +28.');
  assert.deepEqual(['score', 'combo', 'forwarded'].map(v.text), ['59', '2', '2']);
  assert.equal(v.text('prompt'), 'Queue empty: next packet in 4.0 s.');
});

test('byte-catcher: chmod on the page: the rwx grid by taps and keys 1-9, the octal digits with 8 and 9 shut', (t) => {
  const queue = [{ seq: 1, kind: 'octal', value: 0o750, ttl: 20000, life: 22000 }, { seq: 2, kind: 'rwx', value: 0o640, ttl: 21000, life: 22000 }];
  const { v } = openPage(t, { storage: { state: save({ mode: 'chmod', queue, seq: 3, nextSpawn: 6000, combo: 4, bestCombo: 4 }) } });
  assert.equal(v.text('combo'), '4');
  v.click('pause');
  assert.deepEqual(['bits', 'grid', 'octets', 'digits', 'send'].map(v.hidden), [true, false, true, true, true]);
  assert.equal(v.text('entry'), '---------');
  v.permKey(8).click();
  v.press('2');
  assert.equal(v.text('entry'), 'rw-------');
  assert.equal(v.permKey(7).getAttribute('aria-pressed'), 'true');
  v.press('Backspace');
  v.tapBits(0o750, 8);
  assert.equal(v.text('status'), '#0001 750 forwarded as rwxr-x---: +30.');
  assert.equal(v.text('combo'), '5 x2', 'the next packet scores double');
  assert.deepEqual(['grid', 'digits'].map(v.hidden), [true, false]);
  assert.equal(v.text('prompt'), '#0002: type the octal mode');
  assert.deepEqual(v.el('digits').children.map((b) => b.disabled), [false, false, false, false, false, false, false, true, true, false]);
  v.press('8');
  assert.equal(v.text('status'), '8 is not an octal digit (0-7).');
  v.tapDigits([6, 4]);
  assert.equal(v.text('entry'), '64_');
  v.press('0');
  assert.equal(v.text('status'), '#0002 rw-r----- forwarded as 640: +62 (x2 combo).');
  assert.deepEqual(['score', 'combo'].map(v.text), ['92', '6 x2']);
  assert.deepEqual(v.el('digits').children.map((b) => b.disabled), new Array(10).fill(false), 'the digits open again for the next kind');
});

test('byte-catcher: the third drop takes the link down: summary, toast, best recorded once, controls shut until New run', (t) => {
  const queue = [{ seq: 1, kind: 'hex', value: 0xB6, ttl: 300, life: 15000 }];
  const { clock, v } = openPage(t, { storage: { state: save({ queue, drops: 2, score: 57, forwarded: 3, combo: 2, bestCombo: 4 }) } });
  assert.equal(v.el('link').className, 'byc-link byc-link--warn');
  v.click('pause');
  clock.advance(200);
  assert.equal(v.slots()[0].className, 'byc-slot byc-slot--sel byc-slot--low');
  assert.equal(v.fill(0), '1%');
  clock.advance(100);
  assert.equal(v.text('status'), '#0001 HEX 0xB6 dropped: TTL expired; it was 1011 0110. Drops 3/3. ' +
    'Link down after 3 drops: score 57, 3 forwarded, best combo 4, up 0:01.');
  assert.equal(v.toast(), 'Link down. New best for Warm-up: 57.');
  assert.deepEqual(v.best(), { bin: { score: 57, forwarded: 3 }, cidr: { score: 0, forwarded: 0 }, chmod: { score: 0, forwarded: 0 } });
  assert.deepEqual([v.state().status, v.state().drops, v.state().queue, v.state().t], ['over', 3, [], 1300]);
  assert.equal(v.text('best'), '57');
  assert.equal(v.text('drops'), '3/3');
  assert.equal(v.el('link').className, 'byc-link byc-link--down');
  assert.equal(v.con.className, 'byc-console byc-console--over');
  assert.equal(v.text('prompt'), 'Link down: press New run.');
  assert.equal(v.el('pause').disabled, true);
  assert.equal(v.el('pause').getAttribute('aria-label'), 'The link is down: press New run');
  const saved = localStorage.getItem(STATE_KEY);
  clock.advance(5000);
  assert.equal(localStorage.getItem(STATE_KEY), saved, 'the clock stopped');
  v.press('1');
  assert.equal(v.text('status'), 'Link down after 3 drops: press New run for another go.');
  v.text('status');
  v.press('p');
  assert.equal(v.text('status'), 'Link down after 3 drops: press New run for another go.');
  // A reload shows the result; New run starts at once, without a second press.
  const again = reload(clock, v);
  assert.equal(again.text('status'), 'Link down after 3 drops: score 57, 3 forwarded, best combo 4, up 0:01. Press New run for another go.');
  assert.equal(again.text('best'), '57');
  again.click('new');
  assert.equal(again.text('status'), 'eth0 is up: encode the selected packet before its TTL runs out.');
  assert.deepEqual([again.state().status, again.state().score, again.state().drops], ['running', 0, 0]);
  assert.equal(again.toast(), null);
  // A run that ends with a lower score keeps the best and says its score.
  writeStorage({ state: save({ queue, drops: 2, score: 9, forwarded: 9 }) });
  const third = reload(clock, again);
  third.click('pause');
  clock.advance(300);
  assert.equal(third.toast(), 'Link down. Score 9.');
  assert.deepEqual(third.best().bin, { score: 57, forwarded: 9 });
});

test('byte-catcher: Pause stops the run; a hidden tab pauses it and showing it again does not resume; no burst of ticks after', (t) => {
  const { clock, v } = openPage(t, { storage: { state: save() } });
  v.click('pause');
  clock.advance(500);
  assert.deepEqual([v.text('uptime'), v.slot(0)[3]], ['0:01', '8.5 s']);
  v.click('pause');
  assert.equal(v.text('status'), 'Paused at 0:01: press Resume or P to go on.');
  assert.equal(v.con.className, 'byc-console byc-console--paused');
  assert.deepEqual([v.state().status, v.state().t], ['paused', 1500]);
  clock.advance(3000);
  assert.equal(v.slot(0)[3], '8.5 s');
  v.click('pause');
  clock.advance(500);
  setVisibility('hidden', t);
  assert.equal(v.text('status'), 'Paused at 0:02 while the tab was hidden: press Resume or P to go on.');
  assert.deepEqual([v.state().status, v.state().t], ['paused', 2000], 'saved when hidden');
  const saved = localStorage.getItem(STATE_KEY);
  clock.advance(60000);
  setVisibility('visible', t);
  assert.equal(v.text('pause'), 'Resume', 'showing the tab again leaves it paused');
  setVisibility('hidden', t);
  setVisibility('visible', t);
  assert.equal(localStorage.getItem(STATE_KEY), saved, 'hiding a paused run writes nothing');
  assert.equal(v.slot(0)[3], '8.0 s');
  v.click('pause');
  clock.advance(100);
  assert.equal(v.slot(0)[3], '7.9 s', 'one tick per 100 ms, nothing piled up');
  assert.equal(v.text('uptime'), '0:02');
});

test('byte-catcher: a run survives a reload: it comes back paused with the same queue and goes on with the same packets', (t) => {
  const { clock, v } = openPage(t, { random: 5 });
  v.click('pause');
  clock.advance(5000);
  const shown = v.slots().map((slot, i) => v.slot(i));
  const saved = v.state();
  assert.equal(saved.t, 5000);
  const again = reload(clock, v);
  assert.equal(again.text('status'), 'Run restored, paused at 0:05 (Warm-up, score 0): press Resume or P to go on.');
  assert.deepEqual(again.slots().map((slot, i) => again.slot(i)), shown);
  assert.equal(again.text('pause'), 'Resume');
  clock.advance(3000);
  assert.deepEqual(again.slots().map((slot, i) => again.slot(i)), shown, 'paused until Resume');
  // The pure model from the save says what comes next.
  const model = steps(Object.assign(byc.bycParseState(JSON.stringify(saved), 0), { status: 'running' }), 60).state;
  again.click('pause');
  clock.advance(6000);
  assert.deepEqual(again.state().queue, model.queue);
  assert.deepEqual(again.slots().map((slot, i) => again.slot(i)[1]).filter((x) => x !== 'idle'), model.queue.map((p) => valueModel(p.kind, p.value)));
});

test('byte-catcher: New run during a run asks for a second press within 4 s; the run it ends still counts for Best', (t) => {
  const { clock, v } = openPage(t, { storage: { state: save({ score: 57, forwarded: 3 }) } });
  v.click('new');
  assert.equal(v.toast(), 'Press New run again within 4 s to end this run (score 57, 3 forwarded).');
  assert.equal(v.text('new'), 'End run?');
  assert.equal(v.el('new').getAttribute('aria-label'), 'Press again to end this run');
  assert.equal(v.state().score, 57);
  clock.advance(4000);
  assert.equal(v.text('new'), 'New run');
  v.click('new');
  clock.advance(1000);
  v.click('new');
  assert.equal(v.text('new'), 'New run');
  assert.deepEqual([v.state().status, v.state().score, v.state().t], ['running', 0, 0]);
  assert.deepEqual(v.best().bin, { score: 57, forwarded: 3 });
  clock.advance(4000);
  assert.equal(v.text('new'), 'New run', 'the old confirmation timer is gone');
  assert.equal(v.text('uptime'), '0:04');
});

test('byte-catcher: another mode applies at once to a run that has not started, else from the next run', (t) => {
  const { clock, v } = openPage(t);
  v.chooseMode('chmod');
  assert.equal(v.text('status'), 'chmod is ready on eth0: press Start to bring the link up.');
  assert.deepEqual([v.state().mode, v.state().status], ['chmod', 'ready']);
  assert.equal(v.text('iface'), 'eth0 ingress · 0/5 queued · chmod');
  assert.equal(v.hidden('grid'), false, 'the panel of the first chmod kind');
  v.click('pause');
  clock.advance(100);
  v.chooseMode('cidr');
  assert.equal(v.text('status'), 'CIDR applies from your next run: this run plays on in chmod. Press New run to switch now.');
  assert.equal(v.state().mode, 'chmod');
  v.click('new');
  v.click('new');
  assert.deepEqual([v.state().mode, v.state().status], ['cidr', 'running']);
  v.el('mode').value = 'nope';
  fire(v.el('mode'), 'change');
  assert.equal(v.text('status'), 'Warm-up applies from your next run: this run plays on in CIDR. Press New run to switch now.');
});

test('byte-catcher: a save in the current format loads as it was and is written back in the same format', (t) => {
  const { v } = openPage(t, { storage: { state: SAMPLE_SAVE, best: { cidr: { score: 300, forwarded: 20 } } } });
  assert.equal(v.text('status'), 'Run restored, paused at 0:12 (CIDR, score 57): press Resume or P to go on.');
  assert.deepEqual(v.slot(0), ['#0004', '/26', '→ mask', '9.8 s']);
  assert.deepEqual(v.slot(1), ['#0005', '255.255.240.0', '→ /len', '14.5 s']);
  assert.deepEqual([2, 3, 4].map((i) => v.slot(i)[1]), ['idle', 'idle', 'idle']);
  assert.equal(v.text('entry'), '255.255.___.___');
  assert.equal(v.text('prompt'), '#0004: pick the 4 mask octets');
  assert.deepEqual(['score', 'combo', 'forwarded', 'drops', 'uptime', 'best'].map(v.text), ['57', '2', '3', '1/3', '0:12', '300']);
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE, 'nothing is written while nothing changes');
  v.click('pause');
  assert.equal(localStorage.getItem(STATE_KEY), SAMPLE_SAVE.replace('"status":"paused"', '"status":"running"'));
  v.tapOctets([255, 192]);
  const written = v.state();
  assert.deepEqual(Object.keys(written), Object.keys(JSON.parse(SAMPLE_SAVE)));
  assert.deepEqual([written.score, written.combo, written.forwarded, written.sel, written.keys], [77, 3, 4, 5, []]);
});

test('byte-catcher: a corrupt or partial save never breaks the page: a playable run every time', (t) => {
  const texts = ['{', '[]', '"x"', '42', 'null', '{}', '{"mode":7}', '{"mode":"cidr","queue":"x","t":"y"}',
    '{"mode":"bin","t":-1,"queue":[null,1,{"seq":1}]}', '{"mode":"chmod","drops":99,"t":5}',
    '{"mode":"bin","t":5000,"queue":[{"seq":1,"kind":"hex","value":300,"ttl":1,"life":2}],"sel":1,"bits":"x"}',
    '{"mode":"cidr","t":900,"queue":[{"seq":3,"kind":"cidr","value":24,"ttl":500,"life":900}],"sel":3,"keys":[255,"x"]}'];
  for (const text of texts) {
    resetStubs();
    const { clock, v } = openPage(t, { storage: { state: text, best: '{' } });
    const parsed = byc.bycParseState(text, 0);
    if (text === '{' || text === '[]' || text === '"x"' || text === '42') {
      assert.equal(v.text('status'), 'The saved run could not be read (not a JSON object): a fresh Warm-up run is ready.', text);
    }
    assert.equal(v.text('best'), '0', text);
    if (parsed.status === 'over') v.click('new');
    else v.click('pause');
    clock.advance(parsed.status === 'paused' ? parsed.nextSpawn : 100);
    assert.notEqual(v.slots()[0].className, 'byc-slot byc-slot--empty', text + ': packets arrive');
    assert.equal(v.state().status, 'running', text);
  }
});

test('byte-catcher: blocked storage never stops the game, and the warning names each key and the error', (t) => {
  blockStorage('access', t);
  const { clock, v } = openPage(t);
  assert.equal(v.hidden('warning'), false);
  assert.equal(v.text('warning'), 'Storage refused byc-state (SecurityError) and byc-best (SecurityError): ' +
    'the run in progress and the best scores will not be kept after a reload.');
  v.click('pause');
  clock.advance(1100);
  assert.equal(v.text('uptime'), '0:01');
  assert.notEqual(v.slots()[0].className, 'byc-slot byc-slot--empty');
  v.click('pause');
  v.click('new');
  v.click('new');
  assert.equal(v.text('pause'), 'Pause');
});

test('byte-catcher: full storage still reads the saves; the game plays on, names the key, and never takes its own old save for another tab\'s', (t) => {
  writeStorage({ state: save({ queue: [{ seq: 1, kind: 'hex', value: 0xB6, ttl: 1500, life: 15000 }], drops: 2, score: 12, forwarded: 1 }) });
  const before = localStorage.getItem(STATE_KEY);
  blockStorage('full', t);
  const { clock, v } = openPage(t);
  assert.equal(v.text('score'), '12', 'the save is still read');
  assert.equal(v.hidden('warning'), true);
  v.click('pause');
  assert.equal(v.text('warning'), 'Storage refused byc-state (QuotaExceededError): the run in progress will not be kept after a reload.');
  clock.advance(1000);
  assert.equal(v.text('pause'), 'Pause', 'still running: the old save on disk is this tab\'s own');
  assert.equal(v.text('uptime'), '0:02');
  clock.advance(500);
  assert.equal(v.text('warning'), 'Storage refused byc-state (QuotaExceededError) and byc-best (QuotaExceededError): ' +
    'the run in progress and the best scores will not be kept after a reload.');
  assert.equal(v.toast(), 'Link down. New best for Warm-up: 12.');
  assert.equal(localStorage.getItem(STATE_KEY), before);
});

test('byte-catcher: a second tab takes over the run another tab saved, at once by the storage event or before its next write, and never writes over it', (t) => {
  const { clock, v } = openPage(t, { storage: { state: save() } });
  v.click('pause');
  clock.advance(1000);
  // Another tab saves its run: the storage event pauses this one and shows that run.
  const theirs = JSON.stringify(save({ t: 5000, score: 99, forwarded: 4 }));
  localStorage.setItem(STATE_KEY, theirs);
  fire(window, 'storage', { key: null });
  fire(window, 'storage', { key: 'other' });
  assert.equal(v.text('pause'), 'Pause', 'other keys change nothing');
  fire(window, 'storage', { key: STATE_KEY });
  const taken = 'Another tab saved a Warm-up run (score 99, up 0:05): it is shown here.';
  assert.equal(v.text('status'), taken);
  assert.equal(v.toast(), taken);
  assert.equal(v.text('pause'), 'Resume');
  assert.deepEqual(['score', 'uptime'].map(v.text), ['99', '0:05']);
  clock.advance(3000);
  assert.equal(localStorage.getItem(STATE_KEY), theirs, 'this tab wrote nothing over it');
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.text('pause'), 'Resume', 'the same text again is nothing new');
  // Resumed here, it is this tab's run again; a write the event missed is found before the next write.
  v.click('pause');
  clock.advance(500);
  const later = JSON.stringify(save({ mode: 'chmod', queue: [], sel: null, t: 9000, score: 150 }));
  localStorage.setItem(STATE_KEY, later);
  clock.advance(500);
  assert.equal(v.text('status'), 'Another tab saved a chmod run (score 150, up 0:09): it is shown here.');
  assert.equal(v.el('mode').value, 'chmod');
  assert.equal(localStorage.getItem(STATE_KEY), later);
  // A tab that is only looking follows quietly.
  const quiet = JSON.stringify(save({ score: 151, t: 9100 }));
  localStorage.setItem(STATE_KEY, quiet);
  fire(window, 'storage', { key: STATE_KEY });
  assert.equal(v.text('score'), '151');
  assert.equal(v.toast(), 'Another tab saved a chmod run (score 150, up 0:09): it is shown here.', 'no new toast while paused');
  // A tap on a key finds the newer run before it writes.
  v.click('pause');
  localStorage.setItem(STATE_KEY, JSON.stringify(save({ score: 152, t: 9200 })));
  v.bitKey(7).click();
  assert.equal(v.text('score'), '152');
  assert.equal(v.state().bits, 0, 'the tap made on the old run is not applied');
});

test('byte-catcher: a best another tab stored is merged in, at once by the storage event and again when a run ends', (t) => {
  const queue = [{ seq: 1, kind: 'hex', value: 0xB6, ttl: 300, life: 15000 }];
  const { clock, v } = openPage(t, { storage: { state: save({ queue, drops: 2, score: 57, forwarded: 30 }) } });
  localStorage.setItem(BEST_KEY, JSON.stringify({ bin: { score: 500, forwarded: 20 } }));
  fire(window, 'storage', { key: BEST_KEY });
  assert.equal(v.text('best'), '500');
  localStorage.setItem(BEST_KEY, JSON.stringify({ bin: { score: 600, forwarded: 1 }, cidr: { score: 5, forwarded: 5 } }));
  v.click('pause');
  clock.advance(300);
  assert.equal(v.toast(), 'Link down. Score 57.');
  assert.deepEqual(v.best(), { bin: { score: 600, forwarded: 30 }, cidr: { score: 5, forwarded: 5 }, chmod: { score: 0, forwarded: 0 } });
  assert.equal(v.text('best'), '600');
});

test('byte-catcher: a newer toast keeps its full 2 s', (t) => {
  const { clock, v } = openPage(t, { storage: { state: save() } });
  v.click('new');
  assert.notEqual(v.toast(), null);
  clock.advance(1500);
  localStorage.setItem(STATE_KEY, JSON.stringify(save({ score: 3 })));
  v.click('pause');
  assert.equal(v.toast(), 'Another tab saved a Warm-up run (score 3, up 0:01): it is shown here.');
  clock.advance(1900);
  assert.notEqual(v.toast(), null);
  clock.advance(100);
  assert.equal(v.toast(), null);
});

test('byte-catcher: every class the game puts on the page has a rule in style.css', (t) => {
  const seen = new Set();
  const collect = (v) => {
    for (const el of walk(v.page.root)) String(el.className || '').split(/\s+/).filter(Boolean).forEach((name) => seen.add(name));
  };
  const queue = [{ seq: 1, kind: 'octal', value: 0o750, ttl: 2000, life: 22000 }, { seq: 2, kind: 'rwx', value: 0o640, ttl: 21000, life: 22000 }];
  const { clock, v } = openPage(t, { storage: { state: save({ mode: 'chmod', queue, seq: 3, drops: 2 }) } });
  collect(v);
  v.click('pause');
  v.permKey(8).click();
  v.click('new');
  collect(v);
  v.press('ArrowDown');
  collect(v);
  clock.advance(2000);
  collect(v);
  v.chooseMode('cidr');
  collect(v);
  v.click('pause');
  clock.advance(100);
  collect(v);
  v.chooseMode('bin');
  v.click('new');
  v.click('new');
  v.press('1');
  collect(v);
  const selectors = cssRules(CSS).flatMap((rule) => rule.selectors).join(' ');
  for (const name of [...seen].sort()) {
    assert.match(name, /^byc-/);
    assert.match(selectors, new RegExp('\\.' + name + '(?![\\w-])'), name);
  }
  for (const name of ['byc-slot', 'byc-slot--empty', 'byc-slot--sel', 'byc-slot--low', 'byc-slot-line', 'byc-slot-seq', 'byc-slot-value', 'byc-slot-to',
    'byc-slot-ttl', 'byc-slot-bar', 'byc-slot-fill', 'byc-key', 'byc-key--bit', 'byc-key--perm', 'byc-key--octet', 'byc-key--digit', 'byc-key--on',
    'byc-grid-head', 'byc-pad-label', 'byc-pad-key', 'byc-link--idle', 'byc-link--up', 'byc-link--warn', 'byc-link--down',
    'byc-console--ready', 'byc-console--running', 'byc-console--paused', 'byc-console--over', 'byc-show', 'byc-hidden']) {
    assert.ok(seen.has(name), name + ' was seen on the page');
  }
});

// ── Files ────────────────────────────────────────────────────────────────────

test('byte-catcher: every id the script looks up is in index.html once; ids, classes, CSS variables, keyframes, storage keys and exports are byc- prefixed', () => {
  const ids = Array.from(JS.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'byc-back', 'byc-best', 'byc-bits', 'byc-combo', 'byc-console', 'byc-digits', 'byc-drops', 'byc-entry', 'byc-forwarded', 'byc-grid',
    'byc-iface', 'byc-link', 'byc-mode', 'byc-new', 'byc-octets', 'byc-pause', 'byc-prompt', 'byc-queue', 'byc-root', 'byc-score',
    'byc-send', 'byc-status', 'byc-toast', 'byc-uptime', 'byc-warning'
  ]);
  assert.equal(ids.length, new Set(ids).size, 'each element is looked up once');
  const htmlIds = idsInHtml(HTML);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'ids are unique');
  assert.deepEqual([...htmlIds].sort(), [...new Set(ids)].sort(), 'no id the script does not use');
  for (const id of htmlIds) assert.match(id, /^byc-/);
  const classes = Array.from(embedMarkup(HTML).matchAll(/class="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/));
  assert.ok(classes.length > 30);
  for (const name of classes) assert.match(name, /^byc-/);
  for (const m of JS.matchAll(/className = '([^']*)'|'(byc-[\w-]+)'/g)) {
    for (const name of (m[1] || m[2]).split(/\s+/).filter(Boolean)) assert.match(name, /^byc-/);
  }
  for (const rule of cssRules(CSS)) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(html|body)\b/, 'no bare html/body rule');
      for (const m of selector.matchAll(/\.([\w-]+)/g)) assert.match(m[1], /^byc-/, selector);
    }
  }
  for (const m of CSS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^byc-/);
  for (const m of JS.matchAll(/(?<![\w-])--([\w-]+)/g)) assert.match(m[1], /^byc-/);
  const keyframes = Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);
  assert.deepEqual(keyframes, ['byc-blink', 'byc-pulse']);
  for (const m of CSS.matchAll(/animation:\s*([\w-]+)/g)) {
    if (m[1] !== 'none') assert.ok(keyframes.includes(m[1]), m[1]);
  }
  assert.deepEqual([...new Set(Array.from(JS.matchAll(/'(byc-(?:state|best))'/g), (m) => m[1]))].sort(), ['byc-best', 'byc-state']);
  assert.doesNotMatch(JS, /localStorage\.(getItem|setItem)\(\s*'(?!byc-)/);
  for (const name of Object.keys(byc)) assert.match(name, /^byc[A-Z]/);
});

test('byte-catcher: the files embed safely, load nothing from outside, and the standalone page keeps its body rule out of the embed', () => {
  assert.deepEqual(embedSafety(JS), []);
  assert.deepEqual(embedSafety(CSS), []);
  const embedded = embedMarkup(HTML);
  assert.ok(embedded.startsWith('<div class="byc-wrapper" id="byc-root"'));
  assert.deepEqual(embedSafety(embedded), []);
  assert.ok(!/^\s*(html|body)\b[^{]*\{/m.test(CSS), 'no bare html/body rule');
  const bg = CSS.match(/--byc-bg-primary:\s*(#[0-9a-fA-F]{3,6})/)[1];
  assert.equal(bg, '#0a0f1e');
  const rule = '<style>body { margin: 0; background: ' + bg + '; }</style>';
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  assert.ok(head.includes(rule), 'index.html <head> sets the page background');
  assert.ok(head.indexOf('<link rel="stylesheet" href="style.css">') < head.indexOf(rule));
  assert.doesNotMatch(embedded, /<style/i);
  assert.match(head, /<title>Byte Catcher — Logs from VahaC<\/title>/);
  assert.match(head, /<meta name="description" content="[^"]{80,}">/);
  assert.deepEqual(Array.from(HTML.matchAll(/<script\b[^>]*>/g), (m) => m[0]), ['<script src="script.js">']);
  assert.match(HTML, /<script src="script\.js"><\/script>\s*<\/body>/);
  for (const text of [HTML, CSS, JS]) {
    assert.doesNotMatch(text, /https?:\/\/|@import|url\(|<a\b/i, 'no network resources and no links');
  }
  assert.doesNotMatch(JS, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|Worker)\b/, 'no network calls');
  assert.doesNotMatch(JS, /performance\.now|new Date|Date\.now/, 'the run is timed by its own ticks');
  // Plain-text mentions of the calculators only.
  assert.match(HTML, /Subnet Calculator and the chmod Calculator/);
});

test('byte-catcher: script.js is one strict IIFE in ES5', () => {
  assert.match(JS, /^(\/\/[^\n]*\r?\n)*\r?\n?\(function \(\) \{\r?\n {2}'use strict';/);
  assert.match(JS.trimEnd(), /\n\}\)\(\);$/);
  assert.equal(JS.match(/^\(function \(\) \{/gm).length, 1);
  assert.equal(JS.match(/^\}\)\(\);/gm).length, 1);
  const code = JS
    .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  for (const [name, re] of [
    ['let', /\blet\s/], ['const', /\bconst\s/], ['arrow function', /=>/], ['class', /\bclass\s+\w/],
    ['template literal', /`/], ['optional chaining', /\?\./], ['nullish coalescing', /\?\?/], ['spread or rest', /\.\.\./],
    ['module syntax', /^\s*(import|export)\b/m], ['for...of', /\bfor\s*\([^)]*\sof\s/], ['async', /\basync\b|\bawait\b/],
    ['default parameter', /function\s*\w*\([^)]*=/], ['double-quoted string', /"/], ['Promise', /\bPromise\b/],
    ['newer methods', /\.(includes|find|findIndex|fill|padStart|padEnd|repeat|startsWith|endsWith|assign|entries|values)\(/]
  ]) {
    assert.doesNotMatch(code, re, name);
  }
});

test('byte-catcher: index.html has the three modes, a focusable console and labelled controls', () => {
  const spec = htmlPageSpec(HTML);
  assert.deepEqual(Array.from(HTML.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g), (m) => [m[1], m[2]]), [
    ['bin', 'Warm-up: DEC and HEX to bits'], ['cidr', 'CIDR: prefix length and mask'], ['chmod', 'chmod: rwx and octal']
  ]);
  assert.equal(spec['byc-console'].attributes.tabindex, '0');
  assert.equal(spec['byc-console'].attributes.role, 'group');
  assert.ok(spec['byc-console'].attributes['aria-label']);
  assert.equal(spec['byc-console'].parent, 'byc-root');
  for (const [id, props] of Object.entries(spec)) {
    if (props.tagName === 'button') {
      assert.equal(props.attributes.type, 'button', id);
      assert.ok(props.attributes['aria-label'], id + ' has an aria-label');
    }
  }
  for (const id of ['byc-queue', 'byc-bits', 'byc-grid', 'byc-octets', 'byc-digits']) {
    assert.equal(spec[id].attributes.role, 'group', id);
    assert.ok(spec[id].attributes['aria-label'], id);
    assert.equal(spec[id].parent, 'byc-console', id);
  }
  assert.equal(spec['byc-status'].attributes['aria-live'], 'polite');
  assert.equal((spec['byc-prompt'].attributes || {})['aria-live'], undefined, 'the prompt counts down every tick: no live region');
  assert.doesNotMatch(embedMarkup(HTML), /<main\b/, 'the host page has its own main');
  assert.equal(spec['byc-toast'].attributes['aria-live'], 'polite');
  assert.equal(spec['byc-warning'].attributes.role, 'alert');
  assert.match(spec['byc-warning'].className, /\bbyc-hidden\b/);
  assert.equal(spec['byc-mode'].tagName, 'select');
  assert.match(HTML, /<label class="byc-label" for="byc-mode">/);
});

test('byte-catcher: from 320 to 414 px (and on desktop) the console fits without widening the page or scrolling inside it', () => {
  const rules = cssRules(CSS);
  const lines = (decls, prop) => decls[prop] === undefined ? 0 : px(decls[prop]);
  assert.equal(PROMPTS.length, 10);
  assert.ok(PROMPTS.includes('Paused: press Resume or P.'));
  for (const vw of [...Array.from({ length: 95 }, (_, i) => 320 + i), 479, 480, 640, 641, 1024, 1440]) {
    const wrapper = declsAt(rules, '.byc-wrapper', vw);
    const side = px(wrapper.padding.split(/\s+/)[1]);
    const available = Math.min(vw, px(wrapper['max-width'])) - 2 * side;
    assert.equal(declsAt(rules, '.byc-wrapper *', vw)['box-sizing'], 'border-box');
    const con = declsAt(rules, '.byc-console', vw);
    const conWidth = Math.min(available, px(con['max-width']));
    const content = conWidth - 2 * px(con.padding) - 2 * px(con.border.split(/\s+/)[0]);
    // Every pad: equal columns of keys at least 44 px wide.
    const keyHeight = px(wrapper['--byc-key-height']);
    assert.ok(keyHeight >= 44, vw + 'px: keys ' + keyHeight + 'px tall');
    assert.equal(declsAt(rules, '.byc-key', vw).height, 'var(--byc-key-height)');
    for (const [pad, columns, fixed] of [['bits', vw < 480 ? 4 : 8, 0], ['grid', 3, 28], ['octets', 3, 0], ['digits', 5, 0]]) {
      const decls = declsAt(rules, '.byc-pad--' + pad, vw);
      const expected = (fixed ? fixed + 'px ' : '') + 'repeat(' + columns + ', minmax(0, 1fr))';
      assert.equal(decls['grid-template-columns'], expected, vw + 'px ' + pad);
      const gap = px(declsAt(rules, '.byc-pad', vw).gap);
      const cells = columns + (fixed ? 1 : 0);
      const key = (content - fixed - (cells - 1) * gap) / columns;
      assert.ok(key >= 44, vw + 'px: ' + pad + ' keys of ' + key.toFixed(1) + 'px');
    }
    // A queue slot keeps one line: seq, the longest value, the target where it shows, and the TTL.
    const slot = declsAt(rules, '.byc-slot', vw);
    const slotContent = content - 2 * px(slot.padding.split(/\s+/)[1]) - 2 * px(slot.border.split(/\s+/)[0]);
    const char = 0.61 * rem(slot['font-size']);
    const shown = ['#9999', '255.255.255.252', '→ octal', '22.0 s'].filter((text, i) => i !== 2 || declsAt(rules, '.byc-slot-to', vw).display !== 'none');
    const line = declsAt(rules, '.byc-slot-line', vw);
    const width = shown.join('').length * char + (shown.length - 1) * px(line.gap);
    assert.ok(width <= slotContent, vw + 'px: a slot line of ' + width.toFixed(1) + 'px in ' + slotContent.toFixed(1) + 'px');
    assert.equal(declsAt(rules, '.byc-slot-value', vw)['overflow-wrap'], 'anywhere', 'a longer value would wrap, never widen the page');
    assert.equal(line['flex-wrap'], 'wrap');
    assert.equal(line['white-space'], undefined);
    // The entry readout and the stat cards.
    const entry = declsAt(rules, '.byc-entry', vw);
    const entryChar = 0.61 * rem(entry['font-size']) + 0.06 * rem(entry['font-size']);
    assert.ok(15 * entryChar <= content - 2 * px(entry.padding.split(/\s+/)[1]) - 2, vw + 'px: 255.255.255.___ fits the entry');
    const stats = declsAt(rules, '.byc-stats', vw);
    const columns = Number(/^repeat\(([36]), minmax\(0, 1fr\)\)$/.exec(stats['grid-template-columns'])[1]);
    const card = (available - (columns - 1) * px(stats.gap)) / columns;
    const stat = declsAt(rules, '.byc-stat', vw);
    const cardContent = card - 2 * px(stat.padding.split(/\s+/)[1]) - 2 * px(stat.border.split(/\s+/)[0]);
    const value = declsAt(rules, '.byc-stat-value', vw);
    assert.ok('15 x4'.length * 0.61 * rem(value['font-size']) <= cardContent, vw + 'px: a combo fits its card');
    assert.equal(value['overflow-wrap'], 'anywhere');
    const label = declsAt(rules, '.byc-stat-label', vw);
    assert.ok('FORWARDED'.length * (0.61 + 0.05) * rem(label['font-size']) <= cardContent, vw + 'px: the longest stat label fits');
    // The interface line and every prompt keep to one line (a wrapped one grows the row instead of running over the queue).
    const iface = declsAt(rules, '.byc-iface-row', vw);
    assert.equal(iface.height, undefined, 'no fixed height on the interface row');
    const ifaceFont = rem(declsAt(rules, '.byc-iface-row', vw)['font-size']);
    assert.ok('eth0 ingress · 5/5 queued · Warm-up'.length * 0.61 * ifaceFont + px(declsAt(rules, '.byc-link', vw).width) + px(iface.gap) <= content,
      vw + 'px: the interface line fits');
    const prompt = declsAt(rules, '.byc-prompt', vw);
    for (const text of PROMPTS) {
      assert.ok(text.length * 0.61 * rem(prompt['font-size']) <= content, vw + 'px: one line for ' + text);
    }
    // Queue slots are tap targets as tall as the pad keys.
    const slotHeight = px(declsAt(rules, '.byc-wrapper', vw)['--byc-slot-height']);
    assert.equal(slot['min-height'], 'var(--byc-slot-height)');
    assert.ok(slotHeight >= 44, vw + 'px: slots ' + slotHeight + 'px tall');
    // A pad key's label and the key that presses it fit its height.
    const keyPad = px(declsAt(rules, '.byc-key', vw).padding);
    for (const kind of ['bit', 'perm', 'octet', 'digit']) {
      const label = rem(declsAt(rules, '.byc-key--' + kind + ' .byc-pad-label', vw)['font-size']);
      const hint = rem(declsAt(rules, '.byc-pad-key', vw)['font-size']);
      assert.ok((label + hint) * Number(declsAt(rules, '.byc-key', vw)['line-height']) + 2 * keyPad + 2 <= keyHeight, vw + 'px: ' + kind + ' key content');
    }
    // On phones the console with its tallest pad (the rwx grid or the mask octets: three rows of keys) and two lines of
    // the status line under it fits a 568 px tall screen, so the reason for a drop or a CRC error is in view while playing.
    if (vw <= 414) {
      const queue = declsAt(rules, '.byc-queue', vw);
      const grid = declsAt(rules, '.byc-pad--grid', vw);
      const actions = declsAt(rules, '.byc-actions', vw);
      const btn = declsAt(rules, '.byc-btn', vw);
      const status = declsAt(rules, '.byc-status', vw);
      assert.equal(grid['grid-template-rows'], undefined, 'no row of column heads: each key shows its r, w or x');
      assert.equal(grid['grid-auto-rows'], 'var(--byc-key-height)');
      // A slot's own content (one line, the gap, the bar) fits its height.
      assert.ok(rem(slot['font-size']) * Number(slot['line-height']) + px(slot.gap) + px(declsAt(rules, '.byc-slot-bar', vw).height) +
        2 * px(slot.padding.split(/\s+/)[0]) + 2 <= slotHeight, vw + 'px: the slot content fits ' + slotHeight + 'px');
      const padGap = px(declsAt(rules, '.byc-pad', vw).gap);
      const statusLines = parseFloat(status['min-height']);
      assert.equal(status['min-height'], '2.6em');
      assert.equal(Number(status['line-height']), 1.3);
      assert.ok(statusLines >= 2 * Number(status['line-height']), 'two status lines are kept');
      const height = 2 * px(con.padding) + 2 + px(iface['min-height']) + lines(iface, 'margin-bottom') +
        5 * slotHeight + 4 * px(queue.gap) +
        px(prompt.margin.split(/\s+/)[0]) + parseFloat(prompt['min-height']) * rem(prompt['font-size']) +
        px(entry.margin.split(/\s+/)[0]) + px(entry.height) + px(entry.margin.split(/\s+/)[2]) +
        3 * keyHeight + 2 * padGap +
        px(actions['margin-top']) + 2 * rem(btn.padding.split(/\s+/)[0]) + rem(btn['font-size']) * 1.6 +
        px(status.margin.split(/\s+/)[0]) + statusLines * rem(status['font-size']);
      assert.ok(height <= 568, vw + 'px: the console is ' + height.toFixed(1) + 'px tall');    }
  }
  // The status line is the console's last child, and the old panel under the console holds only the storage warning.
  const spec = htmlPageSpec(HTML);
  assert.equal(spec['byc-status'].parent, 'byc-console');
  assert.ok(HTML.indexOf('id="byc-status"') > HTML.indexOf('id="byc-send"'));
  assert.equal(spec['byc-warning'].parent, 'byc-root');
  // The key a pad key answers to reads at 4.5:1 or more, on a key and on a lit key.
  const colors = declsAt(rules, '.byc-wrapper', 320);
  const color = (value) => (/^var\((--[\w-]+)\)$/.test(value) ? colors[value.slice(4, -1)] : value);
  const hint = color(declsAt(rules, '.byc-pad-key', 320).color);
  const litHint = color(declsAt(rules, '.byc-key--on .byc-pad-key', 320).color);
  assert.ok(contrast(hint, color(declsAt(rules, '.byc-key', 320).background)) >= 4.5, 'hint on a key: ' + hint);
  assert.ok(contrast(litHint, color(declsAt(rules, '.byc-key--on', 320).background)) >= 4.5, 'hint on a lit key: ' + litHint);
  assert.ok(contrast(color('var(--byc-text-muted)'), color(declsAt(rules, '.byc-key', 320).background)) < 4.5, 'the muted grey is too faint for it');
  // Nothing inside the game scrolls, nothing is positioned absolutely, and the toast stays inside the screen.
  for (const rule of rules) {
    for (const prop of ['overflow', 'overflow-x', 'overflow-y']) assert.equal(rule.decls[prop], undefined, rule.selectors.join(', ') + ' ' + prop);
    if (rule.decls.position !== undefined) assert.deepEqual([rule.selectors, rule.decls.position], [['.byc-toast'], 'fixed']);
  }
  assert.equal(declsAt(rules, '.byc-toast', 320)['max-width'], 'calc(100vw - 32px)');
  // Buttons with two lines of content lay them out as flex columns, aligned explicitly.
  for (const selector of ['.byc-slot', '.byc-key']) {
    const decls = declsAt(rules, selector, 320);
    assert.equal(decls.display, 'flex', selector);
    assert.equal(decls['flex-direction'], 'column', selector);
    assert.ok(decls['align-items'] && decls['justify-content'], selector);
  }
  // Tap targets keep double-tap zoom away; nothing blocks scrolling or pinch zoom.
  const touch = rules.filter((rule) => rule.decls['touch-action'] !== undefined);
  assert.deepEqual(touch.map((rule) => [rule.selectors.join(', '), rule.decls['touch-action']]),
    [['.byc-btn', 'manipulation'], ['.byc-slot', 'manipulation'], ['.byc-key', 'manipulation']]);
  // Long texts wrap instead of widening the page.
  for (const selector of ['.byc-prompt', '.byc-entry', '.byc-status', '.byc-warning', '.byc-iface', '.byc-toast']) {
    assert.equal(declsAt(rules, selector, 320)['overflow-wrap'], 'anywhere', selector);
  }
  assert.equal(declsAt(rules, '.byc-select', 320).width, '100%');
  assert.equal(declsAt(rules, '.byc-select', 320)['min-width'], '0');
  assert.equal(declsAt(rules, '.byc-wrapper', 320)['line-height'], '1.6');
  assert.equal(declsAt(rules, '.byc-btn--action', 320)['min-width'], '0');
});
