// Byte Catcher — script.js
// Prefix: byc-
// Dependencies: none.
//
// A router interface terminal.  Packets arrive in the ingress queue of eth0,
// each with a value to encode and a TTL that counts down.  The player encodes
// the selected packet on the console: a match forwards it (points, and a
// combo for a clean streak).  A packet whose TTL runs out, or one that
// arrives while all five queue slots are taken (a tail drop), is dropped;
// after three drops the link goes down and the run ends.
//
// Modes, and how each packet kind is encoded:
//   bin    Warm-up: DEC 182 or HEX 0xB6 -> the 8 bit toggles 128..1.
//   cidr   /26 -> the four octets of the dotted mask, picked on the mask
//          octet pad (255 254 252 248 240 224 192 128 0); 255.255.255.192
//          -> the prefix length, typed on the digit pad.
//   chmod  750 -> the 3x3 rwx grid (owner, group, other by read, write,
//          execute); rwxr-x--- -> the octal mode, typed on the digit pad.
// Toggles forward a packet the moment they match: the oldest queued packet
// encoded on the same toggles (any DEC or HEX byte in Warm-up, any octal
// mode on the rwx grid), not only the selected one.  A typed entry belongs
// to the selected packet and is sent when it is complete (2 digits of a
// prefix, 3 of a mode, 4 octets) or with Enter / Send; a wrong one is a CRC
// error that resets the combo, and its message names what was sent and what
// that means.  The status line at the foot of the console shows it, so it
// stays in view with the pads on a phone.
//
// Model: bycStep(state, dt, input) is pure and returns { state, events }
// with a new state (the one passed in is left alone).  input (optional) is
// applied first, then dt ms pass: every TTL counts down, expired packets are
// dropped and at most one new packet arrives.  Packets come from a
// mulberry32 generator whose state (seed) is part of the run, so a run is
// reproducible and a reload goes on with the same packets.  The TTL and the
// time between packets shrink quickly over the first four minutes of a run,
// then slowly up to ten minutes, and stay there.
//
// Clock: one tick of BYC_TICK_MS per timeout, each scheduling the next, so a
// slowed-down tab never runs a burst of piled-up ticks.  The run pauses when
// the tab is hidden, and a reload brings it back paused.
//
// Keys, only while the focus is on the console or one of its keys: bits 1-8
// or A S D F J K L ; (also by physical key on other layouts), rwx grid 1-9,
// mask octets 1-9, digits 0-9, Enter sends, Backspace deletes or clears, P
// pauses, and Up / Down pick another packet while the run is going (from the
// console or a queue slot; on a pad key or with no run going they scroll the
// page).  P also works on Start / Pause and New run.  Enter and Space on a
// focused button stay with that button; Ctrl / Alt / Cmd combinations, held
// keys (Up / Down repeat), the mode select, the help and everything outside
// the game keep their keys.
//
// Saves: byc-state (the run: mode, queue, entry, score, combo, clock and
// generator) and byc-best (best score and most packets forwarded per mode).
// Every field falls back on its own, and a damaged save gives a fresh run.
// Storage that is blocked or full never stops the game; a warning names the
// key that failed.
//
// Tabs: byc-state is read again before every write.  When another tab wrote
// it since, that run is taken over (paused) instead of being written over;
// the storage event does the same at once.  byc-best is merged with the
// stored record before it is written, so no tab erases another one's best.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser bycInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var BYC_STATE_KEY = 'byc-state';
  var BYC_BEST_KEY = 'byc-best';
  var BYC_SAVE_VERSION = 1;

  var BYC_TICK_MS = 100;
  var BYC_SAVE_TICKS = 10;
  var BYC_TOAST_MS = 2000;
  var BYC_CONFIRM_MS = 4000;
  var BYC_RAMP_MS = 240000;
  var BYC_FLOOR_MS = 600000;

  var BYC_QUEUE_CAP = 5;
  var BYC_DROP_LIMIT = 3;
  var BYC_BASE_POINTS = 10;
  var BYC_COMBO_STEP = 5;
  var BYC_MAX_MULT = 4;
  var BYC_LOW_TTL = 0.3;
  var BYC_SEED_RANGE = 4294967296;

  // The octets a subnet mask can have, in the order of the mask octet pad.
  var BYC_OCTETS = [255, 254, 252, 248, 240, 224, 192, 128, 0];

  // ttl and spawn: [at the start, after BYC_RAMP_MS, from BYC_FLOOR_MS on]
  // in ms.  The floors follow the taps a packet needs on average (about 4
  // for a byte; 5 on the rwx grid or 3 octal digits in chmod; 4 octets or 2
  // prefix digits in CIDR), so a player of a given speed lasts about as
  // long in every mode (the test runs such players).
  var BYC_MODE_IDS = ['bin', 'cidr', 'chmod'];
  var BYC_MODES = {
    bin: { name: 'Warm-up', kinds: ['dec', 'hex'], ttl: [22000, 9000, 6000], spawn: [6500, 2000, 1400] },
    cidr: { name: 'CIDR', kinds: ['cidr', 'mask'], ttl: [22000, 8000, 5000], spawn: [6500, 1700, 1100] },
    chmod: { name: 'chmod', kinds: ['octal', 'rwx'], ttl: [22000, 9000, 6000], spawn: [6500, 2000, 1400] }
  };

  // Per packet kind: the input panel, the range of its value, the width of a
  // typed entry (0 for toggles), what it is encoded to and the prompt.
  var BYC_KINDS = {
    dec: { panel: 'bits', min: 1, max: 255, width: 0, to: 'bits', ask: 'set the 8 bits' },
    hex: { panel: 'bits', min: 1, max: 255, width: 0, to: 'bits', ask: 'set the 8 bits' },
    cidr: { panel: 'octets', min: 8, max: 30, width: 4, to: 'mask', ask: 'pick the 4 mask octets' },
    mask: { panel: 'digits', min: 8, max: 30, width: 2, to: '/len', ask: 'type the prefix length' },
    octal: { panel: 'grid', min: 1, max: 511, width: 0, to: 'rwx', ask: 'set the rwx grid' },
    rwx: { panel: 'digits', min: 1, max: 511, width: 3, to: 'octal', ask: 'type the octal mode' }
  };

  var BYC_PANELS = ['bits', 'grid', 'octets', 'digits'];
  var BYC_PANEL_NAMES = {
    bits: 'the bit toggles',
    grid: 'the rwx grid',
    octets: 'the mask octet pad',
    digits: 'the digit pad'
  };
  var BYC_PANEL_MAX = { bits: 255, grid: 511 };

  // Bit keys from the left (128) to the right (1): 1-8, or the home row.
  var BYC_BIT_LETTERS = ['a', 's', 'd', 'f', 'j', 'k', 'l', ';'];
  var BYC_BIT_CODES = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'];
  var BYC_GRID_ROWS = ['owner', 'group', 'other'];
  var BYC_GRID_COLS = ['read', 'write', 'execute'];
  var BYC_RWX = 'rwx';
  var BYC_DIGIT_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

  var BYC_SAVED = [
    { key: BYC_STATE_KEY, what: 'the run in progress' },
    { key: BYC_BEST_KEY, what: 'the best scores' }
  ];

  var BYC_PAUSE_BUTTON = {
    ready: ['Start', 'Start the run'],
    running: ['Pause', 'Pause the run'],
    paused: ['Resume', 'Resume the run'],
    over: ['Start', 'The link is down: press New run']
  };
  // The prompt keeps to one line on a 320 px phone (the test measures it).
  var BYC_IDLE_PROMPTS = {
    ready: 'eth0 is down: press Start.',
    paused: 'Paused: press Resume or P.',
    over: 'Link down: press New run.'
  };

  // ── State ─────────────────────────────────────────────────────────────────

  // state: the run (see bycNewRun).  best: per mode (bycParseBest).
  // timer: the pending tick timeout, null while the clock stands.
  // stateText: the byc-state text this tab last read or wrote, so a run
  // another tab saved since stands out.  failed: storage key -> error name.
  var bycRuntime = {
    els: null,
    state: null,
    best: null,
    timer: null,
    ticks: 0,
    toastTimeout: null,
    confirmTimeout: null,
    confirming: false,
    stateText: null,
    failed: {},
    slots: [],
    pads: { bits: [], grid: [], digits: [] }
  };

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function bycHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function bycPad(text, width) {
    var out = String(text);
    while (out.length < width) {
      out = '0' + out;
    }
    return out;
  }

  // m:ss; minutes keep counting past 59.
  function bycFormatTime(ms) {
    var seconds = Math.floor(ms / 1000);
    return Math.floor(seconds / 60) + ':' + bycPad(seconds % 60, 2);
  }

  function bycSeconds(ms) {
    return (ms / 1000).toFixed(1) + ' s';
  }

  function bycSeqText(seq) {
    return '#' + bycPad(seq, 4);
  }

  function bycModeOf(value) {
    return bycHasOwn(BYC_MODES, value) ? value : 'bin';
  }

  // ── Converters (no DOM) ───────────────────────────────────────────────────

  // A number as width binary digits (8 by default).
  function bycToBin(value, width) {
    return bycPad((value >>> 0).toString(2), width === undefined ? 8 : width);
  }

  // A byte as two nibbles: '1011 0110'.
  function bycByteText(value) {
    var bits = bycToBin(value, 8);
    return bits.slice(0, 4) + ' ' + bits.slice(4);
  }

  function bycHex(value) {
    return '0x' + bycPad(value.toString(16).toUpperCase(), 2);
  }

  // A prefix length (0-32) as a dotted mask: 26 -> '255.255.255.192'.
  function bycCidrToMask(prefix) {
    var octets = [];
    for (var i = 0; i < 4; i++) {
      var ones = Math.max(0, Math.min(8, prefix - i * 8));
      octets.push(256 - Math.pow(2, 8 - ones));
    }
    return octets.join('.');
  }

  // The prefix length of a dotted mask, or null when the text is not four
  // octets 0-255 whose 1 bits all come first.
  function bycMaskToCidr(text) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text));
    if (!m) {
      return null;
    }
    var bits = '';
    for (var i = 1; i <= 4; i++) {
      var octet = Number(m[i]);
      if (octet > 255) {
        return null;
      }
      bits += bycToBin(octet, 8);
    }
    return /^1*0*$/.test(bits) ? bits.replace(/0/g, '').length : null;
  }

  // A mode 0-511 as three octal digits: 488 -> '750'.
  function bycOctal(value) {
    return bycPad(value.toString(8), 3);
  }

  // A mode 0-511 as owner, group and other rwx: 488 -> 'rwxr-x---'.
  function bycOctalToRwx(value) {
    var out = '';
    for (var k = 8; k >= 0; k--) {
      out += value & (1 << k) ? BYC_RWX.charAt((8 - k) % 3) : '-';
    }
    return out;
  }

  // 'rwxr-x---' -> '750', or null when the text is not nine rwx places.
  function bycRwxToOctal(text) {
    if (!/^([r-][w-][x-]){3}$/.test(String(text))) {
      return null;
    }
    var value = 0;
    for (var i = 0; i < 9; i++) {
      if (text.charAt(i) !== '-') {
        value |= 1 << (8 - i);
      }
    }
    return bycOctal(value);
  }

  // ── Packets (no DOM) ──────────────────────────────────────────────────────

  function bycPanelOf(kind) {
    return BYC_KINDS[kind].panel;
  }

  // What a packet carries, as the queue shows it: 'HEX 0xB6', '/26' ...
  function bycValueText(kind, value) {
    if (kind === 'dec') {
      return 'DEC ' + value;
    }
    if (kind === 'hex') {
      return 'HEX ' + bycHex(value);
    }
    if (kind === 'cidr') {
      return '/' + value;
    }
    if (kind === 'mask') {
      return bycCidrToMask(value);
    }
    return kind === 'octal' ? bycOctal(value) : bycOctalToRwx(value);
  }

  // The answer a packet wants, in the form it is encoded to.
  function bycAnswerText(kind, value) {
    if (bycPanelOf(kind) === 'bits') {
      return bycByteText(value);
    }
    if (kind === 'cidr') {
      return bycCidrToMask(value);
    }
    if (kind === 'mask') {
      return '/' + value;
    }
    return kind === 'octal' ? bycOctalToRwx(value) : bycOctal(value);
  }

  // The entry on the console for a packet kind: the toggles, or the typed
  // keys with a blank for each one still to come.
  function bycEntryText(kind, entry) {
    var info = BYC_KINDS[kind];
    if (info.panel === 'bits') {
      return bycByteText(entry.bits);
    }
    if (info.panel === 'grid') {
      return bycOctalToRwx(entry.bits);
    }
    var octets = info.panel === 'octets';
    var slots = [];
    for (var i = 0; i < info.width; i++) {
      slots.push(i < entry.keys.length ? String(entry.keys[i]) : octets ? '___' : '_');
    }
    if (octets) {
      return slots.join('.');
    }
    return (kind === 'mask' ? '/' : '') + slots.join('');
  }

  // Whether an entry ({ keys, bits }) encodes the packet.
  function bycCheckMatch(packet, entry) {
    var info = BYC_KINDS[packet.kind];
    if (!info.width) {
      return entry.bits === packet.value;
    }
    if (packet.kind === 'cidr') {
      return entry.keys.join('.') === bycCidrToMask(packet.value);
    }
    if (packet.kind === 'mask') {
      return entry.keys.length > 0 && Number(entry.keys.join('')) === packet.value;
    }
    return entry.keys.join('') === bycOctal(packet.value);
  }

  // Why one more key does not fit a typed entry, or '' when it does.
  function bycKeyError(packet, keys, value) {
    if (packet.kind === 'cidr') {
      return BYC_OCTETS.indexOf(value) === -1 ? value + ' is not a mask octet (' + BYC_OCTETS.join(', ') + ').' : '';
    }
    if (packet.kind === 'mask') {
      var prefix = Number(keys.join('') + value);
      return prefix > 32 ? '/' + prefix + ' is not a prefix length (0-32).' : '';
    }
    return value > 7 ? value + ' is not an octal digit (0-7).' : '';
  }

  // What a wrong entry means, for the CRC error: '255.255.255.128 is /25,
  // not /26'.
  function bycMissText(packet, keys) {
    var sent;
    if (packet.kind === 'cidr') {
      sent = keys.join('.');
      var prefix = bycMaskToCidr(sent);
      return prefix === null ? sent + ' is not a subnet mask: its 1 bits have to come first' :
        sent + ' is /' + prefix + ', not /' + packet.value;
    }
    if (packet.kind === 'mask') {
      var n = Number(keys.join(''));
      return '/' + n + ' is ' + bycCidrToMask(n) + ', not ' + bycCidrToMask(packet.value);
    }
    sent = keys.join('');
    return sent + ' is ' + bycOctalToRwx(parseInt(sent, 8)) + ', not ' + bycOctalToRwx(packet.value);
  }

  // ── Pace and points (no DOM) ──────────────────────────────────────────────

  // A value of range [start, mid, floor] after t ms of a run, on whole
  // ticks: from start to mid over BYC_RAMP_MS, then more slowly to the floor
  // at BYC_FLOOR_MS, where it stays.
  function bycRamp(range, t) {
    var value = t < BYC_RAMP_MS ? range[0] + (range[1] - range[0]) * t / BYC_RAMP_MS :
      range[1] + (range[2] - range[1]) * Math.min(1, (t - BYC_RAMP_MS) / (BYC_FLOOR_MS - BYC_RAMP_MS));
    return Math.round(value / BYC_TICK_MS) * BYC_TICK_MS;
  }

  function bycTtlAt(mode, t) {
    return bycRamp(BYC_MODES[mode].ttl, t);
  }

  function bycSpawnAt(mode, t) {
    return bycRamp(BYC_MODES[mode].spawn, t);
  }

  // x1 for the first five packets of a clean streak, x2 for the next five,
  // up to x4.
  function bycMultiplier(combo) {
    return Math.min(BYC_MAX_MULT, 1 + Math.floor(combo / BYC_COMBO_STEP));
  }

  // The points of a forwarded packet: 10 plus its TTL left in whole seconds
  // (rounded up), times the multiplier of the streak before it.
  function bycPoints(ttl, combo) {
    return (BYC_BASE_POINTS + Math.ceil(ttl / 1000)) * bycMultiplier(combo);
  }

  // ── The model (no DOM) ────────────────────────────────────────────────────

  // A run that has not started: status 'ready', 'running', 'paused' or
  // 'over'; t the run time in ms; seed the generator state; seq the number
  // of the next packet; nextSpawn the ms until it arrives; queue the packets
  // { seq, kind, value, ttl, life } in arrival order; sel the seq of the
  // selected packet (null when the queue is empty); keys and bits the entry.
  function bycNewRun(mode, seed) {
    return {
      mode: mode,
      status: 'ready',
      t: 0,
      seed: seed >>> 0,
      seq: 1,
      nextSpawn: 0,
      queue: [],
      sel: null,
      keys: [],
      bits: 0,
      score: 0,
      combo: 0,
      bestCombo: 0,
      forwarded: 0,
      drops: 0,
      misses: 0
    };
  }

  // mulberry32 on state.seed: a number in [0, 1).
  function bycRandom(state) {
    state.seed = (state.seed + 0x6D2B79F5) >>> 0;
    var x = state.seed;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / BYC_SEED_RANGE;
  }

  // A value for a new packet: a chmod mode has an owner digit 4-7 (the owner
  // can at least read), every other kind is uniform over its range.
  function bycRandomValue(state, kind) {
    var info = BYC_KINDS[kind];
    if (info.max === 511) {
      var owner = 4 + Math.floor(bycRandom(state) * 4);
      var group = Math.floor(bycRandom(state) * 8);
      return owner * 64 + group * 8 + Math.floor(bycRandom(state) * 8);
    }
    return info.min + Math.floor(bycRandom(state) * (info.max - info.min + 1));
  }

  function bycIndexOf(queue, seq) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].seq === seq) {
        return i;
      }
    }
    return -1;
  }

  // The seq of the packet with the least TTL left (the first of equals), or
  // null for an empty queue.
  function bycUrgent(queue) {
    var best = null;
    queue.forEach(function (packet) {
      if (best === null || packet.ttl < best.ttl) {
        best = packet;
      }
    });
    return best === null ? null : best.seq;
  }

  // A selection that left the queue moves to the most urgent packet, and
  // the entry starts over.
  function bycFixSelection(state) {
    if (bycIndexOf(state.queue, state.sel) === -1) {
      state.sel = bycUrgent(state.queue);
      state.keys = [];
      state.bits = 0;
    }
  }

  function bycDrop(state, packet, reason, events) {
    state.drops++;
    state.combo = 0;
    events.push({ type: 'drop', packet: packet, reason: reason, drops: state.drops });
    if (state.drops >= BYC_DROP_LIMIT) {
      state.status = 'over';
      events.push({ type: 'over' });
    }
  }

  // A new packet; it is a tail drop when every queue slot is taken.
  function bycSpawn(state, events) {
    var kinds = BYC_MODES[state.mode].kinds;
    var kind = kinds[Math.floor(bycRandom(state) * kinds.length)];
    var ttl = bycTtlAt(state.mode, state.t);
    var packet = { seq: state.seq, kind: kind, value: bycRandomValue(state, kind), ttl: ttl, life: ttl };
    state.seq++;
    if (state.queue.length >= BYC_QUEUE_CAP) {
      bycDrop(state, packet, 'full', events);
    } else {
      state.queue.push(packet);
      events.push({ type: 'spawn', packet: packet });
    }
  }

  // dt ms pass: TTLs count down, expired packets drop (until the link goes
  // down; the rest stay at 0), then at most one packet arrives.
  function bycAdvance(state, dt, events) {
    var kept = [];
    state.t += dt;
    state.queue.forEach(function (packet) {
      packet.ttl = Math.max(0, packet.ttl - dt);
      if (packet.ttl > 0 || state.status === 'over') {
        kept.push(packet);
      } else {
        bycDrop(state, packet, 'ttl', events);
      }
    });
    state.queue = kept;
    if (state.status === 'over') {
      return;
    }
    state.nextSpawn -= dt;
    if (state.nextSpawn <= 0) {
      state.nextSpawn += bycSpawnAt(state.mode, state.t);
      bycSpawn(state, events);
    }
  }

  function bycForward(state, index, events) {
    var packet = state.queue[index];
    var mult = bycMultiplier(state.combo);
    var points = bycPoints(packet.ttl, state.combo);
    state.score += points;
    state.combo++;
    state.bestCombo = Math.max(state.bestCombo, state.combo);
    state.forwarded++;
    state.queue.splice(index, 1);
    events.push({ type: 'forward', packet: packet, points: points, mult: mult });
  }

  // The index of the oldest queued packet encoded on panel that the toggles
  // match, or -1.
  function bycToggleMatch(state, panel) {
    for (var i = 0; i < state.queue.length; i++) {
      var packet = state.queue[i];
      if (bycPanelOf(packet.kind) === panel && bycCheckMatch(packet, state)) {
        return i;
      }
    }
    return -1;
  }

  // A complete typed entry: forwarded, or a CRC error.
  function bycCommit(state, index, events) {
    var packet = state.queue[index];
    if (bycCheckMatch(packet, state)) {
      bycForward(state, index, events);
      return;
    }
    events.push({ type: 'miss', packet: packet, text: bycMissText(packet, state.keys) });
    state.keys = [];
    state.combo = 0;
    state.misses++;
  }

  // Why an input cannot be taken while the run is not running.
  function bycIdleText(state) {
    if (state.status === 'ready') {
      return 'The link is not up yet: press Start or P to open the ingress queue.';
    }
    if (state.status === 'paused') {
      return 'Paused at ' + bycFormatTime(state.t) + ': press Resume or P to go on.';
    }
    return 'Link down after ' + state.drops + ' drops: press New run for another go.';
  }

  // input: { type: 'toggle', bit } | { type: 'key', value } | { type: 'back' }
  // | { type: 'send' } | { type: 'select', seq } | { type: 'move', dir }.
  // A refused input changes nothing and leaves a 'refuse' event.
  function bycInput(state, input, events) {
    function refuse(text) {
      events.push({ type: 'refuse', text: text });
    }
    if (state.status !== 'running') {
      refuse(bycIdleText(state));
      return;
    }
    var index = bycIndexOf(state.queue, state.sel);
    if (index === -1) {
      refuse('The queue is empty: the next packet arrives in ' + bycSeconds(state.nextSpawn) + '.');
      return;
    }
    var packet = state.queue[index];
    var info = BYC_KINDS[packet.kind];
    var name = bycSeqText(packet.seq) + ' ' + bycValueText(packet.kind, packet.value);
    var type = input.type;
    if (type === 'select' || type === 'move') {
      var to = type === 'select' ? bycIndexOf(state.queue, input.seq) :
        Math.max(0, Math.min(state.queue.length - 1, index + input.dir));
      if (to === -1) {
        refuse('Packet ' + bycSeqText(input.seq) + ' is no longer in the queue.');
      } else if (to !== index) {
        state.sel = state.queue[to].seq;
        state.keys = [];
        state.bits = 0;
      }
      return;
    }
    if (type === 'back') {
      if (info.width) {
        state.keys.pop();
      } else {
        state.bits = 0;
      }
      return;
    }
    if (type === 'send' && !info.width) {
      refuse(name + ' forwards by itself once ' + BYC_PANEL_NAMES[info.panel] + ' match it: you have ' +
        bycEntryText(packet.kind, state) + '.');
      return;
    }
    if ((type === 'toggle') === !!info.width) {
      refuse(name + ' is encoded on ' + BYC_PANEL_NAMES[info.panel] + '.');
      return;
    }
    if (type === 'toggle') {
      state.bits ^= 1 << input.bit;
      var hit = bycToggleMatch(state, info.panel);
      if (hit !== -1) {
        // Another packet forwarded keeps the selection; the toggles clear.
        bycForward(state, hit, events);
        state.bits = 0;
      }
      return;
    }
    if (type === 'send') {
      if (!state.keys.length || (info.panel === 'octets' && state.keys.length < info.width)) {
        refuse('Nothing to send yet: ' + name + ' needs ' + bycEntryText(packet.kind, state) + ' filled in.');
      } else {
        bycCommit(state, index, events);
      }
      return;
    }
    var error = bycKeyError(packet, state.keys, input.value);
    if (error) {
      refuse(error);
      return;
    }
    state.keys.push(input.value);
    if (state.keys.length === info.width) {
      bycCommit(state, index, events);
    }
  }

  // The pure step: input first (optional), then dt ms of a running run.
  function bycStep(state, dt, input) {
    var next = JSON.parse(JSON.stringify(state));
    var events = [];
    if (input) {
      bycInput(next, input, events);
    }
    if (dt > 0 && next.status === 'running') {
      bycAdvance(next, dt, events);
    }
    bycFixSelection(next);
    return { state: next, events: events };
  }

  // The status line for an event ('' for an arrival or the end of the run).
  function bycEventText(event) {
    var packet = event.packet;
    var type = event.type;
    if (type === 'refuse') {
      return event.text;
    }
    if (type !== 'forward' && type !== 'drop' && type !== 'miss') {
      return '';
    }
    var name = bycSeqText(packet.seq) + ' ' + bycValueText(packet.kind, packet.value);
    if (type === 'forward') {
      return name + ' forwarded as ' + bycAnswerText(packet.kind, packet.value) + ': +' + event.points +
        (event.mult > 1 ? ' (x' + event.mult + ' combo)' : '') + '.';
    }
    if (type === 'miss') {
      return 'CRC error on ' + name + ': ' + event.text + '. Combo reset.';
    }
    return name + ' dropped: ' + (event.reason === 'ttl' ? 'TTL expired; it was ' +
      bycAnswerText(packet.kind, packet.value) : 'the ingress queue is full (' + BYC_QUEUE_CAP + '/' +
      BYC_QUEUE_CAP + ')') + '. Drops ' + event.drops + '/' + BYC_DROP_LIMIT + '.';
  }

  function bycSummary(state) {
    return 'Link down after ' + state.drops + ' drops: score ' + state.score + ', ' + state.forwarded +
      ' forwarded, best combo ' + state.bestCombo + ', up ' + bycFormatTime(state.t) + '.';
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function bycParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function bycIsObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function bycIsCount(value) {
    return typeof value === 'number' && value % 1 === 0 && value >= 0;
  }

  function bycCount(value) {
    return bycIsCount(value) ? value : 0;
  }

  function bycIsPacket(item, mode) {
    if (!bycIsObject(item) || BYC_MODES[mode].kinds.indexOf(item.kind) === -1) {
      return false;
    }
    var info = BYC_KINDS[item.kind];
    return bycIsCount(item.seq) && item.seq > 0 &&
      bycIsCount(item.value) && item.value >= info.min && item.value <= info.max &&
      bycIsCount(item.life) && item.life > 0 && item.life <= BYC_MODES[mode].ttl[0] &&
      bycIsCount(item.ttl) && item.ttl <= item.life;
  }

  // The saved queue: each damaged or repeated packet is left out on its own.
  function bycParseQueue(list, mode) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (out.length < BYC_QUEUE_CAP && bycIsPacket(item, mode) && bycIndexOf(out, item.seq) === -1) {
        out.push({ seq: item.seq, kind: item.kind, value: item.value, ttl: item.ttl, life: item.life });
      }
    });
    return out;
  }

  // The typed keys of the selected packet, or [] when they could not have
  // been typed (or would have been sent already).
  function bycParseKeys(data, packet) {
    var info = BYC_KINDS[packet.kind];
    if (!Array.isArray(data) || data.length >= info.width) {
      return [];
    }
    var keys = [];
    for (var i = 0; i < data.length; i++) {
      var value = data[i];
      if (!bycIsCount(value) || (info.panel === 'digits' && value > 9) || bycKeyError(packet, keys, value)) {
        return [];
      }
      keys.push(value);
    }
    return keys;
  }

  function bycParseBits(value, packet) {
    var max = BYC_PANEL_MAX[BYC_KINDS[packet.kind].panel];
    return max && bycIsCount(value) && value <= max ? value : 0;
  }

  // byc-state as a run.  The status comes from the run itself: over after
  // three drops, ready when its clock never ran, paused otherwise (a run is
  // never running after a reload).  seed is the generator to use when the
  // save has none.
  function bycParseState(text, seed) {
    var data = bycParseJson(text);
    if (!bycIsObject(data)) {
      data = {};
    }
    var mode = bycModeOf(data.mode);
    var state = bycNewRun(mode, bycIsCount(data.seed) && data.seed < BYC_SEED_RANGE ? data.seed : seed);
    state.t = bycCount(data.t);
    state.queue = bycParseQueue(data.queue, mode);
    var top = 0;
    state.queue.forEach(function (packet) {
      top = Math.max(top, packet.seq);
    });
    state.seq = Math.max(bycCount(data.seq), top + 1);
    // A run whose clock never ran gets its first packet at once.
    if (bycIsCount(data.nextSpawn) && data.nextSpawn <= BYC_MODES[mode].spawn[0]) {
      state.nextSpawn = data.nextSpawn;
    } else if (state.t > 0) {
      state.nextSpawn = bycSpawnAt(mode, state.t);
    }
    state.score = bycCount(data.score);
    state.combo = bycCount(data.combo);
    state.bestCombo = Math.max(bycCount(data.bestCombo), state.combo);
    state.forwarded = bycCount(data.forwarded);
    state.drops = Math.min(BYC_DROP_LIMIT, bycCount(data.drops));
    state.misses = bycCount(data.misses);
    if (state.drops >= BYC_DROP_LIMIT) {
      state.status = 'over';
    } else if (state.t > 0) {
      state.status = 'paused';
    }
    var index = bycIndexOf(state.queue, data.sel);
    if (index === -1) {
      bycFixSelection(state);
    } else {
      state.sel = data.sel;
      state.keys = bycParseKeys(data.keys, state.queue[index]);
      state.bits = bycParseBits(data.bits, state.queue[index]);
    }
    return state;
  }

  function bycSerialize(state) {
    return {
      v: BYC_SAVE_VERSION,
      mode: state.mode,
      status: state.status,
      t: state.t,
      seed: state.seed,
      seq: state.seq,
      nextSpawn: state.nextSpawn,
      queue: state.queue.map(function (packet) {
        return { seq: packet.seq, kind: packet.kind, value: packet.value, ttl: packet.ttl, life: packet.life };
      }),
      sel: state.sel,
      keys: state.keys,
      bits: state.bits,
      score: state.score,
      combo: state.combo,
      bestCombo: state.bestCombo,
      forwarded: state.forwarded,
      drops: state.drops,
      misses: state.misses
    };
  }

  // byc-best as { bin: { score, forwarded }, cidr: ..., chmod: ... }.
  function bycParseBest(text) {
    var data = bycParseJson(text);
    var best = {};
    BYC_MODE_IDS.forEach(function (mode) {
      var entry = bycIsObject(data) && bycIsObject(data[mode]) ? data[mode] : {};
      best[mode] = { score: bycCount(entry.score), forwarded: bycCount(entry.forwarded) };
    });
    return best;
  }

  // Two byc-best records merged mode by mode and field by field.
  function bycMergeBest(a, b) {
    var best = {};
    BYC_MODE_IDS.forEach(function (mode) {
      best[mode] = {
        score: Math.max(a[mode].score, b[mode].score),
        forwarded: Math.max(a[mode].forwarded, b[mode].forwarded)
      };
    });
    return best;
  }

  // ── Keys (no DOM) ─────────────────────────────────────────────────────────

  function bycCodeDigit(code) {
    var m = /^(?:Digit|Numpad)([0-9])$/.exec(String(code));
    return m ? Number(m[1]) : null;
  }

  // The input of a keydown on the panel shown, { type: 'pause' }, or null.
  // Digits and letters are also read from the physical key, for layouts
  // whose digits need Shift (AZERTY) or whose letters are not Latin.
  function bycKeyInput(event, panel) {
    var key = typeof event.key === 'string' ? event.key : '';
    var lower = key.toLowerCase();
    if (key === 'Backspace') {
      return { type: 'back' };
    }
    if (key === 'Enter') {
      return { type: 'send' };
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      return { type: 'move', dir: key === 'ArrowUp' ? -1 : 1 };
    }
    if (lower === 'p' || event.code === 'KeyP') {
      return { type: 'pause' };
    }
    var digit = /^[0-9]$/.test(key) ? Number(key) : bycCodeDigit(event.code);
    if (panel === 'bits') {
      var at = digit >= 1 && digit <= 8 ? digit - 1 : BYC_BIT_LETTERS.indexOf(lower);
      if (at === -1) {
        at = BYC_BIT_CODES.indexOf(event.code);
      }
      return at === -1 ? null : { type: 'toggle', bit: 7 - at };
    }
    if (digit === null || (panel !== 'digits' && digit === 0)) {
      return null;
    }
    if (panel === 'grid') {
      return { type: 'toggle', bit: 9 - digit };
    }
    return { type: 'key', value: panel === 'octets' ? BYC_OCTETS[digit - 1] : digit };
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  // Names every key that failed so far, the error and what is not kept.
  function bycWarnStorage(key, error) {
    var failed = bycRuntime.failed;
    failed[key] = error.name;
    var hit = BYC_SAVED.filter(function (item) {
      return bycHasOwn(failed, item.key);
    });
    var warning = bycRuntime.els.warning;
    warning.textContent = 'Storage refused ' + hit.map(function (item) {
      return item.key + ' (' + failed[item.key] + ')';
    }).join(' and ') + ': ' + hit.map(function (item) {
      return item.what;
    }).join(' and ') + ' will not be kept after a reload.';
    warning.classList.remove('byc-hidden');
  }

  function bycStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      bycWarnStorage(key, error);
      return null;
    }
  }

  function bycStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      bycWarnStorage(key, error);
      return false;
    }
  }

  function bycFreshSeed() {
    return Math.floor(Math.random() * BYC_SEED_RANGE) >>> 0;
  }

  // Reads byc-state again and takes over the run another tab saved there
  // since this tab last read or wrote it, paused.  Returns whether it did.
  function bycSyncState() {
    var text = bycStorageGet(BYC_STATE_KEY);
    if (text === null || text === bycRuntime.stateText) {
      return false;
    }
    var wasRunning = bycRuntime.state.status === 'running';
    bycStopClock();
    bycRuntime.stateText = text;
    var state = bycParseState(text, bycFreshSeed());
    var message = 'Another tab saved a ' + BYC_MODES[state.mode].name + ' run (score ' + state.score + ', up ' +
      bycFormatTime(state.t) + '): it is shown here.';
    bycRuntime.state = state;
    bycRuntime.els.mode.value = state.mode;
    bycRuntime.els.status.textContent = message;
    if (wasRunning) {
      bycShowToast(message);
    }
    bycRender();
    return true;
  }

  // Writes the run, unless another tab saved one since: that one is taken
  // over instead.
  function bycSave() {
    if (bycSyncState()) {
      return;
    }
    var text = JSON.stringify(bycSerialize(bycRuntime.state));
    if (bycStorageSet(BYC_STATE_KEY, text)) {
      bycRuntime.stateText = text;
    }
  }

  // Keeps the best score and the most packets forwarded of the run's mode,
  // merged with what another tab may have stored since.  Returns whether the
  // score is a new best.
  function bycRecordBest() {
    var state = bycRuntime.state;
    bycRuntime.best = bycMergeBest(bycRuntime.best, bycParseBest(bycStorageGet(BYC_BEST_KEY)));
    var entry = bycRuntime.best[state.mode];
    var better = state.score > entry.score;
    entry.score = Math.max(entry.score, state.score);
    entry.forwarded = Math.max(entry.forwarded, state.forwarded);
    bycStorageSet(BYC_BEST_KEY, JSON.stringify(bycRuntime.best));
    return better;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function bycSpan(className, text) {
    var span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  }

  // A pad button: its label and the key that presses it.
  function bycPadButton(className, label, hint, name, value, aria) {
    var button = document.createElement('button');
    button.setAttribute('type', 'button');
    button.className = className;
    button.setAttribute(name, value);
    button.setAttribute('aria-label', aria);
    button.appendChild(bycSpan('byc-pad-label', label));
    button.appendChild(bycSpan('byc-pad-key', hint));
    return button;
  }

  // The five queue slots and the four input pads, built once.
  function bycBuild() {
    var els = bycRuntime.els;
    var pads = bycRuntime.pads;
    for (var i = 0; i < BYC_QUEUE_CAP; i++) {
      var slot = document.createElement('button');
      var line = bycSpan('byc-slot-line', '');
      var bar = bycSpan('byc-slot-bar', '');
      var parts = {
        seq: bycSpan('byc-slot-seq', ''),
        value: bycSpan('byc-slot-value', ''),
        to: bycSpan('byc-slot-to', ''),
        ttl: bycSpan('byc-slot-ttl', ''),
        fill: bycSpan('byc-slot-fill', '')
      };
      slot.setAttribute('type', 'button');
      ['seq', 'value', 'to', 'ttl'].forEach(function (part) {
        line.appendChild(parts[part]);
      });
      bar.appendChild(parts.fill);
      slot.appendChild(line);
      slot.appendChild(bar);
      els.queue.appendChild(slot);
      parts.el = slot;
      bycRuntime.slots.push(parts);
    }
    for (var b = 0; b < 8; b++) {
      var bit = 7 - b;
      pads.bits.push(els.bits.appendChild(bycPadButton('byc-key byc-key--bit', String(1 << bit),
        (b + 1) + ' ' + BYC_BIT_LETTERS[b].toUpperCase(), 'data-bit', bit, 'Bit ' + (1 << bit))));
    }
    // Each grid key shows its r, w or x, so the grid needs no column heads
    // (the row a phone saves goes to the status line).
    BYC_GRID_ROWS.forEach(function (row, r) {
      els.grid.appendChild(bycSpan('byc-grid-head', row.charAt(0)));
      BYC_GRID_COLS.forEach(function (col, c) {
        var cell = r * 3 + c;
        pads.grid.push(els.grid.appendChild(bycPadButton('byc-key byc-key--perm', BYC_RWX.charAt(c),
          String(cell + 1), 'data-bit', 8 - cell, row + ' ' + col)));
      });
    });
    BYC_OCTETS.forEach(function (octet, k) {
      els.octets.appendChild(bycPadButton('byc-key byc-key--octet', String(octet), String(k + 1),
        'data-value', octet, 'Mask octet ' + octet));
    });
    BYC_DIGIT_ORDER.forEach(function (digit) {
      pads.digits.push(els.digits.appendChild(bycPadButton('byc-key byc-key--digit', String(digit), '',
        'data-value', digit, 'Digit ' + digit)));
    });
  }

  function bycSelected(state) {
    var index = bycIndexOf(state.queue, state.sel);
    return index === -1 ? null : state.queue[index];
  }

  // The kind the console encodes now: the selected packet's, else the
  // mode's first kind.
  function bycCurrentKind() {
    var state = bycRuntime.state;
    var packet = bycSelected(state);
    return packet ? packet.kind : BYC_MODES[state.mode].kinds[0];
  }

  function bycRenderQueue(state) {
    bycRuntime.slots.forEach(function (slot, i) {
      var packet = state.queue[i];
      var el = slot.el;
      if (!packet) {
        el.className = 'byc-slot byc-slot--empty';
        el.disabled = true;
        el.removeAttribute('data-seq');
        el.setAttribute('aria-label', 'Queue slot ' + (i + 1) + ': empty');
        slot.seq.textContent = '';
        slot.value.textContent = 'idle';
        slot.to.textContent = '';
        slot.ttl.textContent = '';
        slot.fill.style.width = '0%';
        return;
      }
      var selected = packet.seq === state.sel;
      var value = bycValueText(packet.kind, packet.value);
      var to = BYC_KINDS[packet.kind].to;
      el.className = 'byc-slot' + (selected ? ' byc-slot--sel' : '') +
        (packet.ttl <= packet.life * BYC_LOW_TTL ? ' byc-slot--low' : '');
      el.disabled = false;
      el.setAttribute('data-seq', packet.seq);
      el.setAttribute('aria-label', 'Packet ' + bycSeqText(packet.seq) + ', ' + value + ' to ' + to + ', TTL ' +
        bycSeconds(packet.ttl) + (selected ? ', selected' : ''));
      slot.seq.textContent = bycSeqText(packet.seq);
      slot.value.textContent = value;
      slot.to.textContent = '→ ' + to;
      slot.ttl.textContent = bycSeconds(packet.ttl);
      slot.fill.style.width = Math.round(packet.ttl / packet.life * 100) + '%';
    });
  }

  function bycRenderPads(state, kind) {
    var els = bycRuntime.els;
    var pads = bycRuntime.pads;
    var panel = bycPanelOf(kind);
    var info = BYC_KINDS[kind];
    BYC_PANELS.forEach(function (name) {
      els[name].classList.toggle('byc-hidden', name !== panel);
    });
    pads.bits.concat(pads.grid).forEach(function (button) {
      var on = (state.bits & (1 << Number(button.getAttribute('data-bit')))) !== 0;
      button.classList.toggle('byc-key--on', on);
      button.setAttribute('aria-pressed', String(on));
    });
    pads.digits.forEach(function (button) {
      button.disabled = kind === 'rwx' && Number(button.getAttribute('data-value')) > 7;
    });
    els.back.textContent = info.width ? 'Delete' : 'Clear';
    els.back.setAttribute('aria-label', info.width ? 'Delete the last key' : 'Clear the toggles');
    els.send.classList.toggle('byc-hidden', !info.width);
  }

  function bycRender() {
    var els = bycRuntime.els;
    var state = bycRuntime.state;
    var mode = BYC_MODES[state.mode];
    var packet = bycSelected(state);
    var kind = bycCurrentKind();
    var mult = bycMultiplier(state.combo);
    var pause = BYC_PAUSE_BUTTON[state.status];
    var link = 'idle';
    if (state.status === 'over') {
      link = 'down';
    } else if (state.drops) {
      link = 'warn';
    } else if (state.status === 'running') {
      link = 'up';
    }
    els.score.textContent = String(state.score);
    els.combo.textContent = state.combo + (mult > 1 ? ' x' + mult : '');
    els.forwarded.textContent = String(state.forwarded);
    els.drops.textContent = state.drops + '/' + BYC_DROP_LIMIT;
    els.uptime.textContent = bycFormatTime(state.t);
    els.best.textContent = String(bycRuntime.best[state.mode].score);
    els.link.className = 'byc-link byc-link--' + link;
    els.iface.textContent = 'eth0 ingress · ' + state.queue.length + '/' + BYC_QUEUE_CAP + ' queued · ' + mode.name;
    els.console.className = 'byc-console byc-console--' + state.status;
    bycRenderQueue(state);
    // The selected slot shows the value; the prompt names what to do with it.
    if (packet) {
      els.prompt.textContent = bycSeqText(packet.seq) + ': ' + BYC_KINDS[packet.kind].ask;
    } else {
      els.prompt.textContent = state.status === 'running' ?
        'Queue empty: next packet in ' + bycSeconds(state.nextSpawn) + '.' : BYC_IDLE_PROMPTS[state.status];
    }
    els.entry.textContent = bycEntryText(kind, state);
    bycRenderPads(state, kind);
    els.pause.textContent = pause[0];
    els.pause.setAttribute('aria-label', pause[1]);
    els.pause.disabled = state.status === 'over';
    els.newRun.textContent = bycRuntime.confirming ? 'End run?' : 'New run';
    els.newRun.setAttribute('aria-label', bycRuntime.confirming ? 'Press again to end this run' : 'Start a new run');
  }

  function bycHideToast() {
    bycRuntime.toastTimeout = null;
    bycRuntime.els.toast.classList.remove('byc-show');
  }

  // Shows message for BYC_TOAST_MS; a newer toast gets its full time.
  function bycShowToast(message) {
    var toast = bycRuntime.els.toast;
    clearTimeout(bycRuntime.toastTimeout);
    toast.textContent = message;
    toast.classList.add('byc-show');
    bycRuntime.toastTimeout = setTimeout(bycHideToast, BYC_TOAST_MS);
  }

  // Puts the events' messages on the status line and returns them.
  function bycShowEvents(events) {
    var text = events.map(bycEventText).filter(Boolean).join(' ');
    if (text) {
      bycRuntime.els.status.textContent = text;
    }
    return text;
  }

  // ── Clock and game flow ───────────────────────────────────────────────────

  function bycSchedule() {
    bycRuntime.timer = setTimeout(bycTick, BYC_TICK_MS);
  }

  function bycStopClock() {
    clearTimeout(bycRuntime.timer);
    bycRuntime.timer = null;
  }

  // The link went down: the best is recorded and the run saved as it ended.
  function bycFinish(text) {
    var state = bycRuntime.state;
    var record = bycRecordBest();
    bycRuntime.els.status.textContent = text + ' ' + bycSummary(state);
    bycShowToast(record ? 'Link down. New best for ' + BYC_MODES[state.mode].name + ': ' + state.score + '.' :
      'Link down. Score ' + state.score + '.');
    bycSave();
    bycRender();
  }

  // One tick of a running run (the clock only runs while it does).
  function bycTick() {
    bycRuntime.timer = null;
    var out = bycStep(bycRuntime.state, BYC_TICK_MS, null);
    bycRuntime.state = out.state;
    bycRuntime.ticks++;
    var text = bycShowEvents(out.events);
    if (out.state.status === 'over') {
      bycFinish(text);
      return;
    }
    bycSchedule();
    var news = out.events.some(function (event) {
      return event.type !== 'spawn';
    });
    if (news || bycRuntime.ticks % BYC_SAVE_TICKS === 0) {
      bycSave();
    }
    bycRender();
  }

  // Applies a player's input to the run.  Only an input that changed the run
  // is saved: a refusal, a held arrow at the end of the queue or Backspace
  // on an empty entry write nothing.
  function bycApply(input) {
    var before = JSON.stringify(bycSerialize(bycRuntime.state));
    var out = bycStep(bycRuntime.state, 0, input);
    bycRuntime.state = out.state;
    bycShowEvents(out.events);
    if (JSON.stringify(bycSerialize(out.state)) !== before) {
      bycSave();
    }
    bycRender();
  }

  // Starts a ready run or resumes a paused one.
  function bycResume() {
    var state = bycRuntime.state;
    var started = state.status === 'ready';
    state.status = 'running';
    bycSchedule();
    bycRuntime.els.status.textContent = started ?
      'eth0 is up: encode the selected packet before its TTL runs out.' :
      'Resumed at ' + bycFormatTime(state.t) + '.';
    bycSave();
    bycRender();
  }

  function bycPause(hidden) {
    var state = bycRuntime.state;
    if (state.status !== 'running') {
      return;
    }
    state.status = 'paused';
    bycStopClock();
    bycRuntime.els.status.textContent = 'Paused at ' + bycFormatTime(state.t) +
      (hidden ? ' while the tab was hidden' : '') + ': press Resume or P to go on.';
    bycSave();
    bycRender();
  }

  function bycTogglePause() {
    var status = bycRuntime.state.status;
    if (status === 'running') {
      bycPause(false);
    } else if (status === 'over') {
      bycRuntime.els.status.textContent = bycIdleText(bycRuntime.state);
    } else {
      bycResume();
    }
  }

  function bycReadyText(mode) {
    return BYC_MODES[mode].name + ' is ready on eth0: press Start to bring the link up.';
  }

  // A fresh run of mode, running at once (run) or waiting for Start.
  function bycBeginRun(mode, run) {
    bycStopClock();
    clearTimeout(bycRuntime.confirmTimeout);
    bycRuntime.confirming = false;
    bycRuntime.state = bycNewRun(mode, bycFreshSeed());
    bycRuntime.els.mode.value = mode;
    bycRuntime.els.status.textContent = bycReadyText(mode);
    if (run) {
      bycResume();
    } else {
      bycSave();
      bycRender();
    }
  }

  function bycCancelConfirm() {
    bycRuntime.confirmTimeout = null;
    bycRuntime.confirming = false;
    bycRender();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // A press on a pad key, a queue slot, Delete or Send hands the keys to the
  // console: a clicked button keeps the focus in Chrome and gets none in
  // Safari, and those buttons may be hidden or disabled by the press itself
  // (the next packet takes another pad), which would drop the focus.
  function bycFocusConsole() {
    bycRuntime.els.console.focus({ preventScroll: true });
  }

  // Start / Pause and New run: a mouse or touch click hands the keys to the
  // console; a keyboard activation (detail 0) leaves the focus on the button.
  function bycPointerFocus(event) {
    if (event.detail > 0) {
      bycFocusConsole();
    }
  }

  // Whether a key is the game's.  The console (and the keys inside it) takes
  // the game keys, but Enter and Space on a focused button stay with it, and
  // Up / Down only move the selection of a running run from the console or a
  // queue slot (elsewhere they scroll the page).  Outside the console only P
  // on Start / Pause or New run is the game's: the mode select, the help
  // summary and the rest of the wrapper keep every key.
  function bycTakesKey(event, input) {
    var els = bycRuntime.els;
    var target = event.target;
    if (!els.console.contains(target)) {
      return input.type === 'pause' && (target === els.pause || target === els.newRun);
    }
    if (target.tagName === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) {
      return false;
    }
    return input.type !== 'move' ||
      (bycRuntime.state.status === 'running' && (target === els.console || els.queue.contains(target)));
  }

  // Keys reach this listener only from inside the game (it sits on the
  // wrapper).
  function bycHandleKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) {
      return;
    }
    var input = bycKeyInput(event, bycPanelOf(bycCurrentKind()));
    if (!input || !bycTakesKey(event, input)) {
      return;
    }
    event.preventDefault();
    if (event.repeat && input.type !== 'move') {
      return;
    }
    if (input.type === 'pause') {
      bycTogglePause();
    } else {
      bycApply(input);
    }
  }

  // A click on a pad or the queue: the attribute name of the item hit, read
  // from the closest element that has it (none for the gaps between).
  function bycHandlePad(name, make) {
    return function (event) {
      var item = event.target.closest('[' + name + ']');
      if (!item) {
        return;
      }
      bycFocusConsole();
      bycApply(make(Number(item.getAttribute(name))));
    };
  }

  function bycHandlePause(event) {
    bycPointerFocus(event);
    bycTogglePause();
  }

  // New run: at once when no run is under way; during one, a second press
  // within BYC_CONFIRM_MS ends it (its score still counts for the best).
  function bycHandleNew(event) {
    var state = bycRuntime.state;
    var live = state.status === 'running' || state.status === 'paused';
    bycPointerFocus(event);
    if (live && !bycRuntime.confirming) {
      bycRuntime.confirming = true;
      bycRuntime.confirmTimeout = setTimeout(bycCancelConfirm, BYC_CONFIRM_MS);
      bycShowToast('Press New run again within ' + BYC_CONFIRM_MS / 1000 + ' s to end this run (score ' +
        state.score + ', ' + state.forwarded + ' forwarded).');
      bycRender();
      return;
    }
    if (live) {
      bycRecordBest();
    }
    bycBeginRun(bycModeOf(bycRuntime.els.mode.value), true);
  }

  // Another mode: at once when no run is under way, else from the next run.
  function bycHandleMode() {
    var mode = bycModeOf(bycRuntime.els.mode.value);
    var state = bycRuntime.state;
    if (state.status === 'running' || state.status === 'paused') {
      bycRuntime.els.status.textContent = BYC_MODES[mode].name + ' applies from your next run: this run plays on in ' +
        BYC_MODES[state.mode].name + '. Press New run to switch now.';
      return;
    }
    bycBeginRun(mode, false);
  }

  function bycHandleVisibility() {
    if (document.hidden) {
      bycPause(true);
    }
  }

  // Another tab wrote to storage: its run is taken over at once, its best
  // merged in.
  function bycHandleStorage(event) {
    if (event.key === BYC_STATE_KEY) {
      bycSyncState();
    } else if (event.key === BYC_BEST_KEY) {
      bycRuntime.best = bycMergeBest(bycRuntime.best, bycParseBest(bycStorageGet(BYC_BEST_KEY)));
      bycRender();
    }
  }

  function bycBindEvents() {
    var els = bycRuntime.els;
    var toggle = bycHandlePad('data-bit', function (bit) {
      return { type: 'toggle', bit: bit };
    });
    var key = bycHandlePad('data-value', function (value) {
      return { type: 'key', value: value };
    });
    els.root.addEventListener('keydown', bycHandleKeydown);
    els.queue.addEventListener('click', bycHandlePad('data-seq', function (seq) {
      return { type: 'select', seq: seq };
    }));
    els.bits.addEventListener('click', toggle);
    els.grid.addEventListener('click', toggle);
    els.octets.addEventListener('click', key);
    els.digits.addEventListener('click', key);
    els.back.addEventListener('click', function () {
      bycFocusConsole();
      bycApply({ type: 'back' });
    });
    els.send.addEventListener('click', function () {
      bycFocusConsole();
      bycApply({ type: 'send' });
    });
    els.pause.addEventListener('click', bycHandlePause);
    els.newRun.addEventListener('click', bycHandleNew);
    els.mode.addEventListener('change', bycHandleMode);
    document.addEventListener('visibilitychange', bycHandleVisibility);
    window.addEventListener('storage', bycHandleStorage);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function bycFindElements() {
    return {
      root: document.getElementById('byc-root'),
      mode: document.getElementById('byc-mode'),
      pause: document.getElementById('byc-pause'),
      newRun: document.getElementById('byc-new'),
      score: document.getElementById('byc-score'),
      combo: document.getElementById('byc-combo'),
      forwarded: document.getElementById('byc-forwarded'),
      drops: document.getElementById('byc-drops'),
      uptime: document.getElementById('byc-uptime'),
      best: document.getElementById('byc-best'),
      console: document.getElementById('byc-console'),
      link: document.getElementById('byc-link'),
      iface: document.getElementById('byc-iface'),
      queue: document.getElementById('byc-queue'),
      prompt: document.getElementById('byc-prompt'),
      entry: document.getElementById('byc-entry'),
      bits: document.getElementById('byc-bits'),
      grid: document.getElementById('byc-grid'),
      octets: document.getElementById('byc-octets'),
      digits: document.getElementById('byc-digits'),
      back: document.getElementById('byc-back'),
      send: document.getElementById('byc-send'),
      status: document.getElementById('byc-status'),
      warning: document.getElementById('byc-warning'),
      toast: document.getElementById('byc-toast')
    };
  }

  // Finds the elements, builds the queue and the pads, binds the controls
  // once and restores the saved run (paused), or gets a fresh one ready.
  // Nothing is written until something changes, so a second tab that only
  // looks never pauses the first one.
  function bycInit() {
    if (bycRuntime.els) {
      return;
    }
    bycRuntime.els = bycFindElements();
    bycBuild();
    bycBindEvents();
    bycRuntime.best = bycParseBest(bycStorageGet(BYC_BEST_KEY));
    var text = bycStorageGet(BYC_STATE_KEY);
    var state = bycParseState(text, bycFreshSeed());
    var name = BYC_MODES[state.mode].name;
    var status = bycReadyText(state.mode);
    if (text !== null && !bycIsObject(bycParseJson(text))) {
      status = 'The saved run could not be read (not a JSON object): a fresh ' + name + ' run is ready.';
    } else if (state.status === 'paused') {
      status = 'Run restored, paused at ' + bycFormatTime(state.t) + ' (' + name + ', score ' + state.score +
        '): press Resume or P to go on.';
    } else if (state.status === 'over') {
      status = bycSummary(state) + ' Press New run for another go.';
    }
    bycRuntime.stateText = text;
    bycRuntime.state = state;
    bycRuntime.els.mode.value = state.mode;
    bycRuntime.els.status.textContent = status;
    bycRender();
  }

  // Node (tests): export only, no init and no timers.  Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      bycRuntime: bycRuntime,
      bycInit: bycInit,
      bycModes: BYC_MODES,
      bycKinds: BYC_KINDS,
      bycOctets: BYC_OCTETS,
      bycToBin: bycToBin,
      bycByteText: bycByteText,
      bycHex: bycHex,
      bycCidrToMask: bycCidrToMask,
      bycMaskToCidr: bycMaskToCidr,
      bycOctal: bycOctal,
      bycOctalToRwx: bycOctalToRwx,
      bycRwxToOctal: bycRwxToOctal,
      bycPanelOf: bycPanelOf,
      bycValueText: bycValueText,
      bycAnswerText: bycAnswerText,
      bycEntryText: bycEntryText,
      bycCheckMatch: bycCheckMatch,
      bycKeyError: bycKeyError,
      bycMissText: bycMissText,
      bycTtlAt: bycTtlAt,
      bycSpawnAt: bycSpawnAt,
      bycMultiplier: bycMultiplier,
      bycPoints: bycPoints,
      bycNewRun: bycNewRun,
      bycUrgent: bycUrgent,
      bycStep: bycStep,
      bycEventText: bycEventText,
      bycSummary: bycSummary,
      bycFormatTime: bycFormatTime,
      bycParseState: bycParseState,
      bycSerialize: bycSerialize,
      bycParseBest: bycParseBest,
      bycMergeBest: bycMergeBest,
      bycKeyInput: bycKeyInput
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bycInit);
  } else {
    bycInit();
  }
})();
