// tests/cold-aisle.sfx.test.js
// Cold Aisle's sound (src/sfx.js): every sim event has a sound or is
// deliberately silent, the sound table's values are sane, unlock, mute, the
// silent fallbacks (no Web Audio, a throwing constructor or node, a context
// that stays suspended), the per-step voice limits, loudness by distance and
// pan by side, and the voice engine's graph and scheduling.  A recording
// AudioContext (below) stands in for Web Audio; each test loads a fresh copy
// of script.js, so the module's audio state starts empty.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, readRepoFile } = require('./_setup');

const SCRIPT = 'cold-aisle/script.js';
const BASE = loadScript(SCRIPT);

// ── a recording AudioContext ───────────────────────────────────────────────

function param(value) {
  const p = { value, calls: [] };
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime']) {
    p[m] = (...args) => { p.calls.push([m, ...args]); return p; };
  }
  return p;
}

// opts: state ('running' | 'suspended'), resume ('run' | 'stay' | 'reject' |
// 'none': returns nothing), noPanner, noComp, throwOn (a create* method name
// that throws), throwCtor.
function makeContext(opts) {
  opts = opts || {};
  const made = [];
  function Ctx() {
    if (opts.throwCtor) throw new Error('no audio device');
    this.currentTime = 2;
    this.sampleRate = 1000;
    this.state = opts.state || 'running';
    this.nodes = [];
    this.destination = this.node('destination', {});
    made.push(this);
  }
  Ctx.made = made;
  Ctx.prototype.node = function (kind, extra) {
    if (opts.throwOn === kind) throw new Error('refused ' + kind);
    const n = Object.assign({ kind, out: [], disconnected: 0 }, extra);
    n.connect = (d) => { n.out.push(d); return d; };
    n.disconnect = () => { n.disconnected++; };
    this.nodes.push(n);
    return n;
  };
  Ctx.prototype.createGain = function () { return this.node('gain', { gain: param(1) }); };
  Ctx.prototype.createOscillator = function () {
    return this.node('osc', { type: 'sine', frequency: param(440), start(t) { this.started = [t]; }, stop(t) { this.stopped = t; } });
  };
  Ctx.prototype.createBufferSource = function () {
    return this.node('noise', { buffer: null, loop: false, start(t, off) { this.started = [t, off]; }, stop(t) { this.stopped = t; } });
  };
  Ctx.prototype.createBiquadFilter = function () {
    return this.node('filter', { type: 'lowpass', frequency: param(350), Q: param(1) });
  };
  if (!opts.noPanner) Ctx.prototype.createStereoPanner = function () { return this.node('pan', { pan: param(0) }); };
  if (!opts.noComp) {
    Ctx.prototype.createDynamicsCompressor = function () {
      return this.node('comp', { threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) });
    };
  }
  Ctx.prototype.createBuffer = function (channels, length, rate) {
    const data = new Float32Array(length);
    return { length, sampleRate: rate, getChannelData: () => data };
  };
  Ctx.prototype.resume = function () {
    const how = opts.resume || 'run';
    if (how === 'run') { this.state = 'running'; return Promise.resolve(); }
    if (how === 'reject') return Promise.reject(new Error('not allowed'));
    if (how === 'stay') return Promise.resolve();
    return undefined;
  };
  return Ctx;
}

// Loads a fresh script.js with AudioContext (and webkitAudioContext) set as
// given; restores the globals when the test ends.
function fresh(t, ctor, webkit) {
  const saved = { a: globalThis.AudioContext, w: globalThis.webkitAudioContext };
  globalThis.AudioContext = ctor;
  globalThis.webkitAudioContext = webkit;
  t.after(() => {
    globalThis.AudioContext = saved.a;
    globalThis.webkitAudioContext = saved.w;
  });
  return loadScript(SCRIPT);
}

const of = (ctx, kind) => ctx.nodes.filter((n) => n.kind === kind);
const sources = (ctx) => ctx.nodes.filter((n) => n.kind === 'osc' || n.kind === 'noise');
const SIM = (x, y, angle, enemies) => ({ player: { x, y, angle }, enemies: enemies || [] });

// ── the event table ────────────────────────────────────────────────────────

// The event types sim.js's header lists, and the ones the sim parts emit.
function headerEvents() {
  const src = readRepoFile('cold-aisle/src/sim.js');
  const part = src.slice(src.indexOf('// ── Events'), src.indexOf('\nvar '));
  const types = new Set();
  for (const m of part.matchAll(/^\/\/ {3}(\w+)(?: \/ (\w+))? \{/gm)) {
    types.add(m[1]);
    if (m[2]) types.add(m[2]);
  }
  return types;
}

function emittedEvents() {
  const types = new Set();
  for (const part of ['sim', 'sim-combat', 'sim-enemies', 'sim-boss']) {
    const src = readRepoFile('cold-aisle/src/' + part + '.js');
    for (const m of src.matchAll(/cdaEmit\(sim, '(\w+)'/g)) types.add(m[1]);
    for (const m of src.matchAll(/cdaEnemyEvent\(sim, '(\w+)'/g)) types.add(m[1]);
  }
  return types;
}

test('cold-aisle sfx: every event the sim lists or emits has a decision in CDA_SFX_EVENTS, and nothing else is there', () => {
  const listed = headerEvents();
  const emitted = emittedEvents();
  assert.ok(listed.size >= 28, 'the header lists the events');
  for (const type of emitted) assert.ok(listed.has(type), type + ' is in the sim.js header');
  for (const type of ['windup', 'attack']) assert.ok(emitted.has(type), type + ' is emitted');
  const table = BASE.CDA_SFX_EVENTS;
  for (const type of listed) assert.ok(Object.prototype.hasOwnProperty.call(table, type), type + ' has a sound or is silent');
  for (const type of Object.keys(table)) assert.ok(listed.has(type), type + ' is a sim event');
  const silent = Object.keys(table).filter((type) => table[type] === null);
  assert.deepEqual(silent, ['message']);
});

test('cold-aisle sfx: every rule names real sounds and covers every tool, enemy kind, item and projectile', () => {
  const S = BASE.CDA_SFX_SOUNDS;
  const E = BASE.CDA_SFX_EVENTS;
  for (const [type, rule] of Object.entries(E)) {
    if (!rule) continue;
    const names = rule.sound ? [rule.sound] : Object.values(rule.sounds).filter(Boolean);
    assert.ok(names.length, type);
    for (const name of names) assert.ok(S[name], type + ' -> ' + name);
  }
  const ids = (rows) => rows.map((r) => r.id).sort();
  assert.deepEqual(Object.keys(E.shot.sounds).sort(), ids(BASE.CDA_TOOLS));
  for (const type of ['windup', 'attack', 'die']) assert.deepEqual(Object.keys(E[type].sounds).sort(), ids(BASE.CDA_ENEMIES), type);
  assert.deepEqual(Object.keys(E.pickup.sounds).sort(), ids(BASE.CDA_ITEMS));
  assert.deepEqual(Object.keys(E.fire.sounds).sort(), ['bolt', 'frost', 'spark']);
  // every kind's warning is its own sound, distinct from every other one
  const windups = Object.values(E.windup.sounds);
  assert.equal(new Set(windups).size, windups.length);
  const json = windups.map((n) => JSON.stringify(S[n].voices));
  assert.equal(new Set(json).size, json.length);
  // pickups: ammo, health, armour, badge, patch and tool are told apart
  const p = BASE.CDA_SFX_PICKUP;
  assert.equal(new Set([p.cell, p.medkit, p.vest, p['key-red'], p.patch, p.probe]).size, 6);
  assert.equal(p.cell, p.coil);
  // the bigger machines break louder and longer
  const len = (n) => Math.max(...S[n].voices.map((v) => (v.at || 0) + v.dur));
  assert.ok(len('die-big') > len('die') && len('die-boss') > len('die-big'));
});

test('cold-aisle sfx: the sound table is sane: waves, durations, gains, frequencies, filters, and windups within their tell', () => {
  const S = BASE.CDA_SFX_SOUNDS;
  const waves = ['sine', 'triangle', 'square', 'sawtooth', 'noise'];
  for (const [name, s] of Object.entries(S)) {
    assert.match(name, /^[a-z]+(-[a-z]+)*$/, name);
    assert.ok([1, 2, 3].includes(s.pri), name + ' pri');
    assert.ok(s.voices.length >= 1 && s.voices.length <= 6, name + ' voices');
    const limit = s.long ? BASE.CDA_SFX_MAX_LONG : BASE.CDA_SFX_MAX_DUR;
    let sum = 0;
    for (const v of s.voices) {
      assert.ok(waves.includes(v.wave), name + ' wave');
      assert.ok(v.gain > 0 && v.gain <= 1, name + ' gain');
      sum += v.gain;
      const at = v.at || 0;
      assert.ok(at >= 0 && v.dur > 0 && at + v.dur <= limit, name + ' duration');
      assert.ok(v.attack === undefined || (v.attack > 0 && v.attack < v.dur), name + ' attack');
      if (v.wave === 'noise') {
        assert.ok(v.filter, name + ': noise is shaped by a filter');
        assert.equal(v.freq, undefined);
      } else {
        assert.equal(v.freq.length, 2);
        for (const f of v.freq) assert.ok(f >= 30 && f <= 3000, name + ' tone ' + f);
      }
      if (v.filter) {
        assert.ok(['lowpass', 'highpass', 'bandpass'].includes(v.filter[0]), name + ' filter');
        for (const f of v.filter.slice(1, 3)) assert.ok(f >= 40 && f <= 8000, name + ' filter ' + f);
        assert.ok(v.filter[3] > 0 && v.filter[3] <= 8, name + ' Q');
      }
    }
    assert.ok(sum <= 1.2, name + ' voices sum ' + sum);
  }
  const long = Object.keys(S).filter((n) => S[n].long).sort();
  assert.deepEqual(long, ['death', 'win']);
  assert.ok(BASE.CDA_SFX_MASTER > 0 && BASE.CDA_SFX_MASTER <= 0.5, 'a modest master level');
  // a warning has ended when its attack lands
  const end = (n) => Math.max(...S[n].voices.map((v) => (v.at || 0) + v.dur));
  for (const kind of ['crawler', 'drone', 'turret', 'loader']) {
    assert.ok(end('windup-' + kind) <= BASE.CDA_ENEMY[kind].windup, kind);
  }
  assert.ok(end('windup-chiller') <= Math.min(...BASE.CDA_BOSS.phases.map((p) => p.windup)));
  for (const n of Object.values(BASE.CDA_SFX_UI)) assert.ok(S[n], n);
});

test('cold-aisle sfx: the event map picks by field, and unknown types or values are silent', () => {
  const name = BASE.cdaSfxNameOf;
  assert.equal(name({ type: 'shot', tool: 'degausser' }), 'shot-degausser');
  assert.equal(name({ type: 'hit', blocked: true }), 'blocked');
  assert.equal(name({ type: 'hit', blocked: false }), 'hit');
  assert.equal(name({ type: 'door', open: false }), 'door-close');
  assert.equal(name({ type: 'vent', open: true }), 'vent-open');
  assert.equal(name({ type: 'die', kind: 'loader' }), 'die-big');
  assert.equal(name({ type: 'pickup', item: 'key-blue' }), 'pickup-badge');
  assert.equal(name({ type: 'shotEnd', hit: 'player' }), '');
  assert.equal(name({ type: 'shotEnd', hit: 'wall' }), 'shot-end');
  assert.equal(name({ type: 'shot', tool: 'toString' }), '');
  assert.equal(name({ type: 'message', text: 'x' }), '');
  assert.equal(name({ type: 'nothing' }), '');
  assert.equal(name({ type: 'hasOwnProperty' }), '');
  assert.equal(name({ type: 'liftLocked', left: 1 }), 'door-locked');
});

// ── unlock and the silent fallbacks ────────────────────────────────────────

test('cold-aisle sfx: unlock makes one context with master, compressor and noise, and is idempotent', (t) => {
  const Ctx = makeContext();
  const cda = fresh(t, Ctx, undefined);
  assert.equal(cda.cdaSfxUnlock(), true);
  assert.equal(cda.cdaSfxUnlock(), true);
  assert.equal(Ctx.made.length, 1);
  const ctx = Ctx.made[0];
  assert.equal(cda.CDA_SFX.ctx, ctx);
  const master = cda.CDA_SFX.master;
  assert.equal(master.gain.value, cda.CDA_SFX_MASTER);
  const comp = of(ctx, 'comp')[0];
  assert.deepEqual(master.out, [comp]);
  assert.deepEqual(comp.out, [ctx.destination]);
  const data = cda.CDA_SFX.noise.getChannelData(0);
  assert.equal(data.length, ctx.sampleRate);
  assert.ok(data.every((s) => s >= -1 && s <= 1) && data.some((s) => s !== 0));
  assert.equal(cda.CDA_SFX.panner, true);
});

test('cold-aisle sfx: the webkit constructor is used when AudioContext is missing; no compressor connects master straight out', (t) => {
  const Ctx = makeContext({ noComp: true, noPanner: true });
  const cda = fresh(t, undefined, Ctx);
  assert.equal(cda.cdaSfxUnlock(), true);
  const ctx = Ctx.made[0];
  assert.deepEqual(cda.CDA_SFX.master.out, [ctx.destination]);
  cda.cdaSfxEvents([{ type: 'hurt', x: 6, y: 5 }], SIM(5, 5, 0));
  assert.equal(of(ctx, 'pan').length, 0, 'no StereoPanner: no pan');
  const bus = of(ctx, 'gain').find((g) => g.out[0] === cda.CDA_SFX.master);
  assert.ok(bus, 'the sound connects to master directly');
  assert.equal(cda.CDA_SFX.last.length, 1);
});

test('cold-aisle sfx: no Web Audio at all: everything is silent and nothing throws', (t) => {
  const cda = fresh(t, undefined, undefined);
  assert.equal(cda.cdaSfxUnlock(), false);
  assert.equal(cda.cdaSfxUnlock(), false);
  cda.cdaSfxSetMute(true);
  cda.cdaSfxSetMute(false);
  cda.cdaSfxEvents([{ type: 'shot', tool: 'probe', x: 1, y: 1 }], SIM(1, 1, 0));
  cda.cdaSfxUi('click');
  cda.cdaSfxPlay('hit', 1, 0);
  assert.deepEqual(cda.CDA_SFX.last, []);
  assert.equal(cda.CDA_SFX.ctx, null);
});

test('cold-aisle sfx: a constructor that throws leaves sound off, and a later unlock may try again', (t) => {
  const Bad = makeContext({ throwCtor: true });
  const cda = fresh(t, Bad, undefined);
  assert.equal(cda.cdaSfxUnlock(), false);
  cda.cdaSfxEvents([{ type: 'win' }], SIM(1, 1, 0));
  assert.deepEqual(cda.CDA_SFX.last, []);
  const Good = makeContext();
  globalThis.AudioContext = Good;
  assert.equal(cda.cdaSfxUnlock(), true);
  assert.equal(Good.made.length, 1);
});

test('cold-aisle sfx: a suspended context is resumed on unlock; one that stays suspended plays nothing', async (t) => {
  const Ok = makeContext({ state: 'suspended' });
  let cda = fresh(t, Ok, undefined);
  assert.equal(cda.cdaSfxUnlock(), true, 'resume ran');
  for (const how of ['stay', 'reject', 'none']) {
    const Stuck = makeContext({ state: 'suspended', resume: how });
    cda = fresh(t, Stuck, undefined);
    assert.equal(cda.cdaSfxUnlock(), false, how);
    assert.equal(cda.cdaSfxUnlock(), false, how + ' again');
    cda.cdaSfxEvents([{ type: 'hurt', x: 1, y: 1 }], SIM(1, 1, 0));
    cda.cdaSfxUi('buy');
    assert.equal(sources(Stuck.made[0]).length, 0, how + ': no voices');
    assert.equal(Stuck.made.length, 1);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test('cold-aisle sfx: a node that throws silences that sound only; a throw in resume is caught', (t) => {
  const Ctx = makeContext({ throwOn: 'osc' });
  const cda = fresh(t, Ctx, undefined);
  assert.equal(cda.cdaSfxUnlock(), true);
  cda.cdaSfxEvents([{ type: 'wall', x: 2, y: 1 }, { type: 'shot', tool: 'probe', x: 1, y: 1 }], SIM(1, 1, 0));
  assert.deepEqual(cda.CDA_SFX.last.map((s) => s.name), ['wall'], 'the noise-only sound plays, the probe is refused');
  const ctx = Ctx.made[0];
  ctx.state = 'suspended';
  ctx.resume = () => { throw new Error('busy'); };
  assert.equal(cda.cdaSfxUnlock(), false);
  assert.equal(Ctx.made.length, 1, 'the context is kept');
});

// ── mute ───────────────────────────────────────────────────────────────────

test('cold-aisle sfx: mute silences (master 0, no voices start) and unmute restores; mute before unlock holds', (t) => {
  const Ctx = makeContext();
  const cda = fresh(t, Ctx, undefined);
  cda.cdaSfxSetMute(true);
  cda.cdaSfxUnlock();
  const ctx = Ctx.made[0];
  assert.equal(cda.CDA_SFX.master.gain.value, 0);
  cda.cdaSfxEvents([{ type: 'death' }], SIM(1, 1, 0));
  cda.cdaSfxUi('click');
  assert.equal(sources(ctx).length, 0);
  cda.cdaSfxSetMute(false);
  assert.equal(cda.CDA_SFX.master.gain.value, cda.CDA_SFX_MASTER);
  cda.cdaSfxEvents([{ type: 'death' }], SIM(1, 1, 0));
  assert.equal(sources(ctx).length, cda.CDA_SFX_SOUNDS.death.voices.length);
  cda.cdaSfxSetMute(1);
  assert.equal(cda.CDA_SFX.master.gain.value, 0);
  assert.equal(cda.CDA_SFX.muted, true);
});

test('cold-aisle sfx: UI sounds: click, buy and refuse play centred at full level; other names are silent', (t) => {
  const Ctx = makeContext();
  const cda = fresh(t, Ctx, undefined);
  cda.cdaSfxUnlock();
  for (const n of ['click', 'buy', 'refuse']) {
    cda.cdaSfxUi(n);
    assert.deepEqual(cda.CDA_SFX.last, [{ name: cda.CDA_SFX_UI[n], gain: 1, pan: 0 }]);
  }
  cda.cdaSfxUi('fanfare');
  cda.cdaSfxUi('toString');
  assert.deepEqual(cda.CDA_SFX.last, []);
});

// ── limits ─────────────────────────────────────────────────────────────────

test('cold-aisle sfx: one sound per name a step (the loudest), at most CDA_SFX_PER_STEP, warnings first', (t) => {
  const Ctx = makeContext();
  const cda = fresh(t, Ctx, undefined);
  cda.cdaSfxUnlock();
  const sim = SIM(5, 5, 0);
  // a degausser shot: seven hits at different distances
  const hits = [9, 7, 6.5, 8, 10, 12, 7.5].map((x) => ({ type: 'hit', id: 1, kind: 'crawler', x, y: 5, damage: 8, blocked: false }));
  cda.cdaSfxEvents([{ type: 'shot', tool: 'degausser', x: 5, y: 5, angle: 0 }].concat(hits), sim);
  assert.deepEqual(cda.CDA_SFX.last.map((s) => s.name), ['shot-degausser', 'hit']);
  const nearest = cda.cdaSfxPlace({ x: 6.5, y: 5 }, sim).gain;
  assert.equal(cda.CDA_SFX.last[1].gain, nearest);
  // three crawlers striking at once: one strike
  const strikes = [1, 2, 3].map((id) => ({ type: 'attack', id, kind: 'crawler', x: 6, y: 5 }));
  cda.cdaSfxEvents(strikes, sim);
  assert.equal(cda.CDA_SFX.last.length, 1);
  // a drone's attack and its spark's launch are one sound
  cda.cdaSfxEvents([{ type: 'attack', id: 4, kind: 'drone', x: 8, y: 5 }, { type: 'fire', id: 9, kind: 'spark', owner: 4, x: 8, y: 5, angle: 0 }], sim);
  assert.deepEqual(cda.CDA_SFX.last.map((s) => s.name), ['fire-spark']);
  // a crowded step: background sounds give way to warnings and the player
  const crowd = [
    { type: 'wall', x: 6, y: 5, cell: 0 }, { type: 'wake', id: 5, kind: 'drone', why: 'noise', x: 7, y: 5 },
    { type: 'door', x: 6, y: 6, open: true }, { type: 'lockLost', id: 6, x: 9, y: 5 },
    { type: 'shotEnd', id: 7, kind: 'bolt', x: 6, y: 4, hit: 'wall' }, { type: 'summon', id: 8, child: 9, x: 10, y: 5 },
    { type: 'windup', id: 10, kind: 'turret', x: 12, y: 5 }, { type: 'windup', id: 11, kind: 'loader', x: 8, y: 5 },
    { type: 'hurt', damage: 6, x: 9, y: 5 }, { type: 'windup', id: 12, kind: 'crawler', x: 6, y: 5 },
    { type: 'hit', id: 2, kind: 'crawler', x: 7, y: 5, blocked: false }, { type: 'message', text: 'Hi' }
  ];
  const picked = cda.cdaSfxPick(crowd, sim);
  assert.equal(picked.length, cda.CDA_SFX_PER_STEP);
  const names = picked.map((s) => s.name);
  assert.deepEqual(names.slice(0, 4), ['hurt', 'windup-crawler', 'windup-loader', 'windup-turret'], 'pri, then the loudest');
  assert.deepEqual(names.slice(4), ['hit', 'wall'], 'then pri 1 by gain');
  cda.cdaSfxEvents(crowd, sim);
  assert.equal(cda.CDA_SFX.last.length, cda.CDA_SFX_PER_STEP);
  // ties keep the events' order
  const tie = cda.cdaSfxPick([{ type: 'wall', x: 6, y: 5 }, { type: 'shotEnd', x: 6, y: 5, hit: 'wall' }, { type: 'wake', x: 6, y: 5 }], sim);
  assert.deepEqual(tie.map((s) => s.name), ['wall', 'shot-end', 'wake']);
  // a louder copy later in the step replaces a quieter one; a quieter one does not
  const twice = cda.cdaSfxPick([{ type: 'wall', x: 15, y: 5 }, { type: 'wall', x: 6, y: 5 }, { type: 'wall', x: 14, y: 5 }], sim);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].gain, cda.cdaSfxPlace({ x: 6, y: 5 }, sim).gain);
  // nothing to play
  cda.cdaSfxEvents([], sim);
  cda.cdaSfxEvents(null, sim);
  assert.deepEqual(cda.CDA_SFX.last, []);
});

// ── place: distance and pan ────────────────────────────────────────────────

test('cold-aisle sfx: distance lowers the gain; past CDA_SFX_RANGE nothing plays; hurt keeps full level', (t) => {
  const Ctx = makeContext();
  const cda = fresh(t, Ctx, undefined);
  cda.cdaSfxUnlock();
  const sim = SIM(5, 5, 0);
  const g = (x) => cda.cdaSfxPlace({ x, y: 5 }, sim).gain;
  assert.equal(g(5.5), 1);
  assert.equal(g(6), 1);
  assert.ok(g(8) < g(6) && g(15) < g(8) && g(15) > 0);
  assert.equal(g(5 + cda.CDA_SFX_RANGE + 1), 0);
  cda.cdaSfxEvents([{ type: 'wall', x: 5 + cda.CDA_SFX_RANGE + 1, y: 5 }], sim);
  assert.deepEqual(cda.CDA_SFX.last, []);
  const far = cda.cdaSfxPlace({ x: 5, y: 5 + cda.CDA_SFX_RANGE + 3 }, sim, true);
  assert.equal(far.gain, 1);
  assert.ok(far.pan > 0);
  cda.cdaSfxEvents([{ type: 'hurt', damage: 6, x: 40, y: 5 }], sim);
  assert.equal(cda.CDA_SFX.last[0].gain, 1);
  // the gain reaches the sound's own gain node
  cda.cdaSfxEvents([{ type: 'wall', x: 12, y: 5 }], sim);
  const bus = of(Ctx.made[0], 'gain').filter((n) => n.out.length && n.out[0].kind === 'pan').pop();
  assert.equal(bus.gain.value, g(12));
});

test('cold-aisle sfx: pan follows the sim\'s angles: y grows south, so facing east the south is to the right', (t) => {
  const Ctx = makeContext();
  const cda = fresh(t, Ctx, undefined);
  cda.cdaSfxUnlock();
  const east = SIM(5, 5, 0);
  const pan = (sim, x, y) => cda.cdaSfxPlace({ x, y }, sim).pan;
  assert.ok(pan(east, 5, 9) > 0, 'south is right when facing east');
  assert.ok(pan(east, 5, 1) < 0, 'north is left when facing east');
  assert.ok(Math.abs(pan(east, 9, 5)) < 1e-9, 'ahead is centred');
  assert.ok(pan(east, 5, 9) <= 0.8 + 1e-9);
  const north = SIM(5, 5, -Math.PI / 2);
  assert.ok(pan(north, 9, 5) > 0, 'east is right when facing north');
  assert.ok(pan(north, 1, 5) < 0, 'west is left when facing north');
  const west = SIM(5, 5, Math.PI + 4 * Math.PI);
  assert.ok(pan(west, 5, 1) > 0, 'north is right when facing west (an unwrapped angle)');
  // the sim's right (cdaPlayerMove: strafe +1 moves by (-sin a, cos a)) pans right at any facing
  for (const a of [0, 0.7, 2, -2.5, 9]) {
    const sim = SIM(5, 5, a);
    assert.ok(pan(sim, 5 - 3 * Math.sin(a), 5 + 3 * Math.cos(a)) > 0.79, 'right at ' + a);
    assert.ok(pan(sim, 5 + 3 * Math.sin(a), 5 - 3 * Math.cos(a)) < -0.79, 'left at ' + a);
  }
  assert.ok(Math.abs(pan(east, 5, 5.1)) < Math.abs(pan(east, 5, 7)), 'a source on top of the player is near the centre');
  assert.equal(pan(east, 5, 5), 0);
  // the pan reaches the StereoPanner
  cda.cdaSfxEvents([{ type: 'door', x: 5.5, y: 9.5, open: true }], east);
  const node = of(Ctx.made[0], 'pan').pop();
  assert.ok(node.pan.value > 0);
  assert.deepEqual(node.out, [cda.CDA_SFX.master]);
});

test('cold-aisle sfx: an event without x, y is heard from its enemy (vent, phase) or centred', () => {
  const place = BASE.cdaSfxPlace;
  const sim = SIM(5, 5, 0, [{ id: 3, x: 5, y: 9 }, { id: 7, x: 5, y: 1 }]);
  const vent = place({ type: 'vent', id: 7, open: true }, sim);
  assert.ok(vent.pan < 0 && vent.gain < 1);
  assert.deepEqual(place({ type: 'phase', id: 99, phase: 2 }, sim), { gain: 1, pan: 0 });
  assert.deepEqual(place({ type: 'win' }, sim), { gain: 1, pan: 0 });
  assert.deepEqual(place({ type: 'vent', id: 7 }, null), { gain: 1, pan: 0 });
  assert.deepEqual(place({ type: 'vent', id: 7 }, { player: { x: 1, y: 1, angle: 0 } }), { gain: 1, pan: 0 });
  assert.deepEqual(place({ x: 2, y: 2 }, {}), { gain: 1, pan: 0 });
  assert.deepEqual(place({ x: 2, y: 2 }, null), { gain: 1, pan: 0 });
});

// ── the engine ─────────────────────────────────────────────────────────────

test('cold-aisle sfx: every sound plays through the engine: one source per voice, envelopes, glides, filters, stops', (t) => {
  const Ctx = makeContext();
  const cda = fresh(t, Ctx, undefined);
  cda.cdaSfxUnlock();
  const ctx = Ctx.made[0];
  const t0 = ctx.currentTime;
  for (const [name, sound] of Object.entries(cda.CDA_SFX_SOUNDS)) {
    const before = ctx.nodes.length;
    cda.cdaSfxPlay(name, 0.5, -0.25);
    const made = ctx.nodes.slice(before);
    const srcs = made.filter((n) => n.kind === 'osc' || n.kind === 'noise');
    assert.equal(srcs.length, sound.voices.length, name);
    sound.voices.forEach((v, i) => {
      const src = srcs[i];
      const at = t0 + (v.at || 0);
      const end = at + v.dur;
      assert.equal(src.kind, v.wave === 'noise' ? 'noise' : 'osc', name);
      assert.equal(src.started[0], at, name + ' start');
      assert.ok(Math.abs(src.stopped - (end + 0.02)) < 1e-9, name + ' stop');
      if (v.wave === 'noise') {
        assert.equal(src.buffer, cda.CDA_SFX.noise);
        assert.equal(src.loop, true);
        assert.ok(src.started[1] >= 0 && src.started[1] < 0.9);
      } else {
        assert.equal(src.type, v.wave);
        const calls = src.frequency.calls;
        assert.deepEqual(calls[0], ['setValueAtTime', v.freq[0], at]);
        if (v.freq[1] !== v.freq[0]) assert.deepEqual(calls[1], ['exponentialRampToValueAtTime', v.freq[1], end]);
        else assert.equal(calls.length, 1);
      }
      // source -> (filter ->) envelope -> the sound's bus
      const env = v.filter ? src.out[0].out[0] : src.out[0];
      assert.equal(env.kind, 'gain');
      assert.deepEqual(env.gain.calls.map((c) => c[0]), ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime']);
      assert.equal(env.gain.calls[1][1], v.gain);
      assert.ok(Math.abs(env.gain.calls[1][2] - (at + (v.attack || 0.005))) < 1e-9);
      assert.equal(env.gain.calls[2][2], end);
      assert.equal(env.out[0].gain.value, 0.5);
      if (v.filter) {
        const f = src.out[0];
        assert.equal(f.type, v.filter[0]);
        assert.equal(f.Q.value, v.filter[3]);
        assert.equal(f.frequency.calls.length, v.filter[2] !== v.filter[1] ? 2 : 1);
      }
    });
    assert.equal(made.find((n) => n.kind === 'pan').pan.value, -0.25);
    assert.deepEqual(cda.CDA_SFX.last.pop(), { name, gain: 0.5, pan: -0.25 });
  }
});

test('cold-aisle sfx: a finished voice disconnects its nodes; the last one to end also frees the sound\'s bus and panner', (t) => {
  const Ctx = makeContext();
  const cda = fresh(t, Ctx, undefined);
  cda.cdaSfxUnlock();
  const ctx = Ctx.made[0];
  const before = ctx.nodes.length;
  // the voice that ends last is not the last one listed
  assert.ok(cda.CDA_SFX_SOUNDS['shot-probe'].voices[1].dur < cda.CDA_SFX_SOUNDS['shot-probe'].voices[0].dur);
  cda.cdaSfxPlay('shot-probe', 1, 0);
  const made = ctx.nodes.slice(before);
  const srcs = made.filter((n) => n.kind === 'osc' || n.kind === 'noise');
  for (const s of srcs) s.onended();
  for (const n of made) assert.equal(n.disconnected, 1, n.kind + ' disconnected once');
  assert.equal(cda.CDA_SFX.master.disconnected, 0);
});

test('cold-aisle sfx: the module keeps no timers and reads no clock but currentTime', () => {
  const src = readRepoFile('cold-aisle/src/sfx.js').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(src, /setTimeout|setInterval|requestAnimationFrame|\bDate\b|performance|Math\.random/);
  assert.doesNotMatch(src, /new Audio\b|data:audio|\.(mp3|ogg|wav)\b/);
  assert.match(src, /ctx\.currentTime/);
  assert.ok(src.split('\n').length < 900);
});
