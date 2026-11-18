// ── sfx: the Web Audio sounds: the sound table, the voice engine, the event map, mute ──
// Owns CDA_SFX (the audio state), CDA_SFX_SOUNDS (every sound as data),
// CDA_SFX_EVENTS (what each sim event plays, or why it is silent),
// CDA_SFX_PICKUP, the level and limit constants, cdaSfxUnlock,
// cdaSfxEvents, cdaSfxSetMute, cdaSfxUi and the engine helpers
// (cdaSfxPlace, cdaSfxPick, cdaSfxPlay).  Uses core (cdaRand, cdaDist,
// cdaAngleTo, cdaAngleDiff); reads the sim's events and player as the header
// of sim.js describes them.  No audio files: every sound is synthesised.
//
// For the page (the UI part):
//   cdaSfxUnlock()            on every user gesture (a click, a key): makes
//                             the AudioContext the first time, resumes a
//                             suspended one later.  Safe to call any number
//                             of times; returns whether sound can play.
//   cdaSfxEvents(events, sim) once per sim step with that step's sim.events.
//   cdaSfxSetMute(on)         the M key and the saved setting (the page keeps
//                             the setting; this only applies it).  Works
//                             before unlock too.
//   cdaSfxUi(name)            'click' (a button), 'buy' (an upgrade bought),
//                             'refuse' (not enough patches, a locked level).
// Without Web Audio (no AudioContext, a constructor or a node that throws,
// a context that stays suspended) every call is silent and nothing throws.
//
// The graph: each sound -> its own gain (the event's loudness) -> a
// StereoPanner when the browser has one -> the master gain
// (CDA_SFX_MASTER, 0 when muted) -> a DynamicsCompressor when there is one
// -> the speakers.  Each voice of a sound is an oscillator or the shared
// noise buffer (one second of seeded white noise made at unlock, played from
// a seeded offset), an optional biquad filter and its envelope gain.  A
// voice ends by its own scheduled stop; onended disconnects it.  No timers:
// the only clock read is audioContext.currentTime, to schedule.
//
// A sound in CDA_SFX_SOUNDS: { pri (1 background .. 3 a warning or the
// player's own state: kept first when a step has too many), long (true
// only for the level-won and death cues: allowed past CDA_SFX_MAX_DUR, up to
// CDA_SFX_MAX_LONG), voices [ ... ] }.  A voice: { wave 'sine' | 'triangle' |
// 'square' | 'sawtooth' | 'noise', freq [from, to] Hz (oscillators only; an
// exponential glide over the voice), gain (peak, 0..1), at (seconds after
// the sound starts, default 0), attack (seconds to the peak, default
// CDA_SFX_ATTACK), dur (seconds from its start to silence: an exponential
// decay after the attack), filter [type, from Hz, to Hz, Q] (optional for
// oscillators, required for noise: noise is shaped only by its filter) }.
//
// Placement (cdaSfxPlace): an event with x, y (or the id of an enemy that
// is still in sim.enemies) is heard from there: quieter with distance
// (1 / (1 + CDA_SFX_ROLLOFF * cells past the first), nothing past
// CDA_SFX_RANGE) and panned by the angle off the player's facing.  Angles
// follow core: 0 east, PI / 2 south (y grows down the map), so a positive
// cdaAngleDiff(direction to the source, facing) is to the player's right
// and pans right (positive).  The pan shrinks to 0 for a source on top of
// the player.  An event with no place (death, win, the lift) plays centred
// at full level.  CDA_SFX_EVENTS' `near` keeps the full level but still
// pans (hurt: the direction the damage came from).
//
// Limits per step (cdaSfxPick): one sound of each name (several events
// asking for the same sound, a degausser's seven hits, three crawlers
// striking together, keep the loudest), at most CDA_SFX_PER_STEP sounds,
// highest pri first, then the loudest; ties keep the events' order.
//
// Decisions:
//   - The ranged kinds' attack event (drone, turret, chiller) plays the same
//     sound as the projectile's fire event of the same step, so the per-name
//     limit makes it one sound: the launch is the attack.
//   - A projectile ending on the player is silent: the hurt sound covers it.
//   - message is silent: the event that caused the line has its own sound.
//   - The locked lift refuses with the locked door's buzz.
//   - Windup sounds last no longer than the kind's tell (tables), so the
//     warning has ended when the attack sounds.

var CDA_SFX_MASTER = 0.35;     // the master level when not muted
var CDA_SFX_PER_STEP = 6;      // most sounds started by one step
var CDA_SFX_RANGE = 22;        // cells: nothing is heard from farther
var CDA_SFX_ROLLOFF = 0.18;    // loudness 1 / (1 + ROLLOFF * (cells - 1))
var CDA_SFX_PAN = 0.8;         // the widest pan, -1..1
var CDA_SFX_ATTACK = 0.005;    // a voice's default attack, seconds
var CDA_SFX_MAX_DUR = 1.2;     // the longest ordinary sound, seconds
var CDA_SFX_MAX_LONG = 2.5;    // the longest long cue (won, death)
var CDA_SFX_FLOOR = 0.0001;    // the envelope's silence (exponential ramps need > 0)

// The audio state: ctx (the AudioContext or null), master, out (where the
// sounds connect), noise (the noise buffer), panner (the browser has
// StereoPanner), muted, rng (the seeded noise and offsets), last (what the
// last cdaSfxEvents / cdaSfxUi started: [{ name, gain, pan }], for tests).
var CDA_SFX = { ctx: null, master: null, out: null, noise: null, panner: false, muted: false, rng: 0x5f3759df, last: [] };

var CDA_SFX_SOUNDS = {
  // ── the tools ──
  'shot-driver': { pri: 2, voices: [
    { wave: 'noise', gain: 0.35, attack: 0.03, dur: 0.16, filter: ['bandpass', 1300, 450, 1.2] },
    { wave: 'sine', freq: [180, 120], gain: 0.15, at: 0.08, dur: 0.08 }
  ] },
  'shot-probe': { pri: 2, voices: [
    { wave: 'triangle', freq: [1400, 700], gain: 0.25, dur: 0.1 },
    { wave: 'noise', gain: 0.12, dur: 0.03, filter: ['highpass', 2500, 2500, 0.7] }
  ] },
  'shot-degausser': { pri: 2, voices: [
    { wave: 'sawtooth', freq: [160, 45], gain: 0.3, dur: 0.45, filter: ['lowpass', 900, 200, 1] },
    { wave: 'noise', gain: 0.3, dur: 0.35, filter: ['lowpass', 2200, 300, 0.8] },
    { wave: 'sine', freq: [90, 40], gain: 0.35, attack: 0.01, dur: 0.4 }
  ] },
  'switch': { pri: 1, voices: [
    { wave: 'noise', gain: 0.12, dur: 0.03, filter: ['highpass', 2000, 2000, 0.7] },
    { wave: 'triangle', freq: [300, 260], gain: 0.12, at: 0.05, dur: 0.06 }
  ] },
  // ── what the tools hit ──
  'hit': { pri: 2, voices: [
    { wave: 'noise', gain: 0.3, dur: 0.07, filter: ['bandpass', 1800, 900, 2] },
    { wave: 'square', freq: [600, 300], gain: 0.1, dur: 0.06, filter: ['lowpass', 2000, 1200, 0.7] }
  ] },
  'blocked': { pri: 2, voices: [
    { wave: 'triangle', freq: [1100, 1060], gain: 0.18, dur: 0.28 },
    { wave: 'triangle', freq: [1630, 1600], gain: 0.08, dur: 0.18 },
    { wave: 'noise', gain: 0.12, dur: 0.03, filter: ['bandpass', 3000, 3000, 1.5] }
  ] },
  'wall': { pri: 1, voices: [
    { wave: 'noise', gain: 0.22, dur: 0.1, filter: ['lowpass', 900, 300, 0.7] }
  ] },
  // ── the enemies ──
  'wake': { pri: 1, voices: [
    { wave: 'sine', freq: [300, 600], gain: 0.15, dur: 0.12 },
    { wave: 'sine', freq: [600, 600], gain: 0.12, at: 0.1, dur: 0.1 }
  ] },
  // a scrubber's brushes revving up
  'windup-crawler': { pri: 3, voices: [
    { wave: 'sawtooth', freq: [70, 140], gain: 0.25, attack: 0.05, dur: 0.28, filter: ['lowpass', 400, 900, 1] },
    { wave: 'noise', gain: 0.15, attack: 0.08, dur: 0.28, filter: ['bandpass', 600, 1200, 1.5] }
  ] },
  // a spark charging: a rising whine
  'windup-drone': { pri: 3, voices: [
    { wave: 'sine', freq: [500, 1600], gain: 0.18, attack: 0.25, dur: 0.33 },
    { wave: 'triangle', freq: [250, 800], gain: 0.08, attack: 0.25, dur: 0.33 }
  ] },
  // the lock-on: three beeps and a higher one
  'windup-turret': { pri: 3, voices: [
    { wave: 'square', freq: [880, 880], gain: 0.1, dur: 0.09, filter: ['lowpass', 1500, 1500, 0.7] },
    { wave: 'square', freq: [880, 880], gain: 0.1, at: 0.2, dur: 0.09, filter: ['lowpass', 1500, 1500, 0.7] },
    { wave: 'square', freq: [880, 880], gain: 0.1, at: 0.4, dur: 0.09, filter: ['lowpass', 1500, 1500, 0.7] },
    { wave: 'square', freq: [1175, 1175], gain: 0.12, at: 0.58, dur: 0.18, filter: ['lowpass', 1800, 1800, 0.7] }
  ] },
  // the telegraph: an engine winding up, low
  'windup-loader': { pri: 3, voices: [
    { wave: 'sawtooth', freq: [55, 110], gain: 0.35, attack: 0.3, dur: 0.58, filter: ['lowpass', 300, 700, 1.5] },
    { wave: 'square', freq: [110, 220], gain: 0.1, attack: 0.3, dur: 0.58, filter: ['lowpass', 500, 900, 0.7] }
  ] },
  // the frost tell: a falling hiss over a groan
  'windup-chiller': { pri: 3, voices: [
    { wave: 'noise', gain: 0.22, attack: 0.15, dur: 0.58, filter: ['bandpass', 3000, 800, 4] },
    { wave: 'sine', freq: [180, 90], gain: 0.3, attack: 0.1, dur: 0.58 }
  ] },
  'attack-crawler': { pri: 2, voices: [
    { wave: 'sine', freq: [150, 60], gain: 0.4, dur: 0.12 },
    { wave: 'noise', gain: 0.25, dur: 0.08, filter: ['lowpass', 1200, 400, 0.7] }
  ] },
  'attack-loader': { pri: 2, voices: [
    { wave: 'sawtooth', freq: [95, 60], gain: 0.3, dur: 0.5, filter: ['lowpass', 600, 300, 1] },
    { wave: 'noise', gain: 0.25, attack: 0.04, dur: 0.5, filter: ['lowpass', 400, 200, 0.7] }
  ] },
  'lock-lost': { pri: 1, voices: [
    { wave: 'sine', freq: [700, 350], gain: 0.1, dur: 0.15 }
  ] },
  'stun': { pri: 2, voices: [
    { wave: 'noise', gain: 0.35, dur: 0.3, filter: ['lowpass', 800, 200, 0.7] },
    { wave: 'sawtooth', freq: [220, 70], gain: 0.12, at: 0.05, dur: 0.6, filter: ['lowpass', 800, 300, 1] }
  ] },
  'die': { pri: 2, voices: [
    { wave: 'noise', gain: 0.3, dur: 0.4, filter: ['lowpass', 1500, 200, 0.7] },
    { wave: 'square', freq: [300, 60], gain: 0.1, dur: 0.35, filter: ['lowpass', 900, 300, 0.7] },
    { wave: 'sine', freq: [120, 40], gain: 0.3, dur: 0.35 }
  ] },
  'die-big': { pri: 2, voices: [
    { wave: 'noise', gain: 0.35, dur: 0.8, filter: ['lowpass', 1200, 120, 0.7] },
    { wave: 'sawtooth', freq: [180, 35], gain: 0.15, dur: 0.75, filter: ['lowpass', 700, 150, 1] },
    { wave: 'sine', freq: [80, 30], gain: 0.4, attack: 0.01, dur: 0.8 }
  ] },
  'die-boss': { pri: 3, voices: [
    { wave: 'noise', gain: 0.35, dur: 1.15, filter: ['lowpass', 1500, 100, 0.7] },
    { wave: 'sawtooth', freq: [140, 30], gain: 0.15, dur: 1.1, filter: ['lowpass', 600, 120, 1] },
    { wave: 'sine', freq: [70, 30], gain: 0.4, attack: 0.02, dur: 1.15 },
    { wave: 'noise', gain: 0.2, at: 0.3, dur: 0.5, filter: ['bandpass', 2500, 600, 3] }
  ] },
  // ── the chiller ──
  'phase': { pri: 3, voices: [
    { wave: 'triangle', freq: [330, 330], gain: 0.22, dur: 0.2 },
    { wave: 'triangle', freq: [262, 262], gain: 0.22, at: 0.22, dur: 0.2 },
    { wave: 'triangle', freq: [220, 196], gain: 0.22, at: 0.44, dur: 0.32 }
  ] },
  'vent-open': { pri: 2, voices: [
    { wave: 'noise', gain: 0.25, attack: 0.05, dur: 0.6, filter: ['bandpass', 2500, 1200, 1] },
    { wave: 'sine', freq: [140, 70], gain: 0.2, dur: 0.5 }
  ] },
  'vent-close': { pri: 2, voices: [
    { wave: 'sine', freq: [120, 50], gain: 0.35, dur: 0.2 },
    { wave: 'noise', gain: 0.22, dur: 0.1, filter: ['lowpass', 600, 300, 0.7] }
  ] },
  'summon': { pri: 1, voices: [
    { wave: 'square', freq: [200, 150], gain: 0.1, dur: 0.15, filter: ['lowpass', 700, 500, 0.7] },
    { wave: 'noise', gain: 0.15, at: 0.05, dur: 0.15, filter: ['lowpass', 1000, 400, 0.7] }
  ] },
  // ── projectiles ──
  'fire-spark': { pri: 2, voices: [
    { wave: 'square', freq: [1200, 400], gain: 0.12, dur: 0.1, filter: ['lowpass', 2500, 1200, 0.7] },
    { wave: 'noise', gain: 0.1, dur: 0.05, filter: ['highpass', 3000, 3000, 0.7] }
  ] },
  'fire-bolt': { pri: 2, voices: [
    { wave: 'square', freq: [700, 350], gain: 0.14, dur: 0.09, filter: ['lowpass', 1800, 900, 0.7] }
  ] },
  'fire-frost': { pri: 2, voices: [
    { wave: 'sine', freq: [1000, 1500], gain: 0.12, dur: 0.15 },
    { wave: 'noise', gain: 0.12, dur: 0.15, filter: ['bandpass', 4000, 2500, 2] }
  ] },
  'shot-end': { pri: 1, voices: [
    { wave: 'noise', gain: 0.15, dur: 0.05, filter: ['bandpass', 1500, 800, 1.5] }
  ] },
  // ── the player ──
  'hurt': { pri: 3, voices: [
    { wave: 'sine', freq: [300, 120], gain: 0.4, dur: 0.2 },
    { wave: 'noise', gain: 0.25, dur: 0.15, filter: ['lowpass', 1500, 400, 0.7] }
  ] },
  'death': { pri: 3, long: true, voices: [
    { wave: 'sawtooth', freq: [220, 40], gain: 0.25, dur: 1.6, filter: ['lowpass', 1200, 150, 1] },
    { wave: 'sine', freq: [110, 30], gain: 0.35, attack: 0.02, dur: 1.8 },
    { wave: 'noise', gain: 0.2, dur: 0.5, filter: ['lowpass', 1500, 200, 0.7] }
  ] },
  // ── doors, secrets, items ──
  'door-open': { pri: 1, voices: [
    { wave: 'noise', gain: 0.22, attack: 0.05, dur: 0.45, filter: ['bandpass', 400, 900, 1] },
    { wave: 'sawtooth', freq: [60, 75], gain: 0.12, attack: 0.05, dur: 0.45, filter: ['lowpass', 200, 250, 1] }
  ] },
  'door-close': { pri: 1, voices: [
    { wave: 'noise', gain: 0.22, attack: 0.05, dur: 0.45, filter: ['bandpass', 900, 400, 1] },
    { wave: 'sine', freq: [100, 50], gain: 0.3, at: 0.42, dur: 0.12 }
  ] },
  'door-locked': { pri: 2, voices: [
    { wave: 'square', freq: [150, 150], gain: 0.15, dur: 0.16, filter: ['lowpass', 800, 800, 0.7] },
    { wave: 'square', freq: [150, 150], gain: 0.15, at: 0.22, dur: 0.16, filter: ['lowpass', 800, 800, 0.7] }
  ] },
  'secret': { pri: 2, voices: [
    { wave: 'noise', gain: 0.28, attack: 0.1, dur: 0.8, filter: ['lowpass', 300, 800, 1] },
    { wave: 'sawtooth', freq: [45, 55], gain: 0.18, attack: 0.1, dur: 0.8, filter: ['lowpass', 250, 250, 1] }
  ] },
  'pickup-ammo': { pri: 2, voices: [
    { wave: 'triangle', freq: [900, 900], gain: 0.15, dur: 0.05 },
    { wave: 'triangle', freq: [1200, 1200], gain: 0.15, at: 0.06, dur: 0.05 }
  ] },
  'pickup-health': { pri: 2, voices: [
    { wave: 'sine', freq: [523, 523], gain: 0.18, dur: 0.18 },
    { wave: 'sine', freq: [659, 659], gain: 0.18, at: 0.08, dur: 0.18 },
    { wave: 'sine', freq: [784, 784], gain: 0.18, at: 0.16, dur: 0.22 }
  ] },
  'pickup-armour': { pri: 2, voices: [
    { wave: 'triangle', freq: [330, 330], gain: 0.25, dur: 0.2 },
    { wave: 'triangle', freq: [495, 495], gain: 0.22, at: 0.07, dur: 0.25 },
    { wave: 'noise', gain: 0.1, dur: 0.08, filter: ['lowpass', 1200, 600, 0.7] }
  ] },
  'pickup-badge': { pri: 2, voices: [
    { wave: 'sine', freq: [1047, 1047], gain: 0.15, dur: 0.3 },
    { wave: 'sine', freq: [1568, 1568], gain: 0.12, at: 0.1, dur: 0.35 }
  ] },
  'pickup-patch': { pri: 2, voices: [
    { wave: 'square', freq: [660, 660], gain: 0.08, dur: 0.07, filter: ['lowpass', 3000, 3000, 0.7] },
    { wave: 'square', freq: [880, 880], gain: 0.08, at: 0.06, dur: 0.07, filter: ['lowpass', 3000, 3000, 0.7] },
    { wave: 'square', freq: [1320, 1320], gain: 0.08, at: 0.12, dur: 0.1, filter: ['lowpass', 3000, 3000, 0.7] }
  ] },
  'pickup-tool': { pri: 2, voices: [
    { wave: 'sawtooth', freq: [220, 440], gain: 0.15, dur: 0.3, filter: ['lowpass', 1500, 1500, 0.7] },
    { wave: 'triangle', freq: [660, 660], gain: 0.15, at: 0.15, dur: 0.35 },
    { wave: 'sine', freq: [880, 880], gain: 0.12, at: 0.25, dur: 0.4 }
  ] },
  // ── racks and the lift ──
  'reboot-start': { pri: 2, voices: [
    { wave: 'sine', freq: [200, 800], gain: 0.15, attack: 0.1, dur: 0.6 },
    { wave: 'square', freq: [100, 100], gain: 0.05, attack: 0.1, dur: 0.6, filter: ['lowpass', 400, 400, 0.7] }
  ] },
  'reboot-stop': { pri: 2, voices: [
    { wave: 'sine', freq: [600, 150], gain: 0.18, dur: 0.3 }
  ] },
  'reboot-done': { pri: 2, voices: [
    { wave: 'triangle', freq: [523, 523], gain: 0.18, dur: 0.25 },
    { wave: 'triangle', freq: [784, 784], gain: 0.18, at: 0.1, dur: 0.25 },
    { wave: 'triangle', freq: [1047, 1047], gain: 0.15, at: 0.2, dur: 0.35 }
  ] },
  'lift-open': { pri: 3, voices: [
    { wave: 'sine', freq: [784, 784], gain: 0.22, dur: 0.6 },
    { wave: 'sine', freq: [622, 622], gain: 0.22, at: 0.3, dur: 0.7 }
  ] },
  'win': { pri: 3, long: true, voices: [
    { wave: 'triangle', freq: [392, 392], gain: 0.15, dur: 0.5 },
    { wave: 'triangle', freq: [523, 523], gain: 0.15, at: 0.15, dur: 0.5 },
    { wave: 'triangle', freq: [659, 659], gain: 0.15, at: 0.3, dur: 0.5 },
    { wave: 'triangle', freq: [784, 784], gain: 0.15, at: 0.45, dur: 0.6 },
    { wave: 'sine', freq: [1047, 1047], gain: 0.12, at: 0.6, attack: 0.05, dur: 1.4 },
    { wave: 'sine', freq: [131, 131], gain: 0.2, attack: 0.1, dur: 1.9 }
  ] },
  // ── the page ──
  'ui-click': { pri: 1, voices: [
    { wave: 'triangle', freq: [1000, 900], gain: 0.12, dur: 0.04 }
  ] },
  'ui-buy': { pri: 2, voices: [
    { wave: 'square', freq: [523, 523], gain: 0.08, dur: 0.08, filter: ['lowpass', 2500, 2500, 0.7] },
    { wave: 'square', freq: [659, 659], gain: 0.08, at: 0.07, dur: 0.08, filter: ['lowpass', 2500, 2500, 0.7] },
    { wave: 'square', freq: [1047, 1047], gain: 0.08, at: 0.14, dur: 0.16, filter: ['lowpass', 2500, 2500, 0.7] }
  ] },
  'ui-refuse': { pri: 2, voices: [
    { wave: 'square', freq: [180, 150], gain: 0.14, dur: 0.2, filter: ['lowpass', 700, 700, 0.7] }
  ] }
};

// An item id (CDA_ITEMS) -> its pickup sound.
var CDA_SFX_PICKUP = {
  cell: 'pickup-ammo', coil: 'pickup-ammo', coffee: 'pickup-health', medkit: 'pickup-health', vest: 'pickup-armour',
  'key-blue': 'pickup-badge', 'key-yellow': 'pickup-badge', 'key-red': 'pickup-badge', patch: 'pickup-patch',
  probe: 'pickup-tool', degausser: 'pickup-tool'
};

// Every sim event type (the header of sim.js) -> what it plays: { sound }
// (always that sound), { by, sounds } (the event's field `by`, as a string,
// picks the sound; '' or a value missing from sounds is silent), plus near
// (no loss by distance, still panned); null: deliberately silent (the reason
// beside it).  A new event type must get a line here: a test walks the
// sim's events against this table.
var CDA_SFX_EVENTS = {
  shot: { by: 'tool', sounds: { driver: 'shot-driver', probe: 'shot-probe', degausser: 'shot-degausser' } },
  hit: { by: 'blocked', sounds: { 'false': 'hit', 'true': 'blocked' } },
  wall: { sound: 'wall' },
  'switch': { sound: 'switch' },
  wake: { sound: 'wake' },
  windup: { by: 'kind', sounds: { crawler: 'windup-crawler', drone: 'windup-drone', turret: 'windup-turret',
    loader: 'windup-loader', chiller: 'windup-chiller' } },
  attack: { by: 'kind', sounds: { crawler: 'attack-crawler', drone: 'fire-spark', turret: 'fire-bolt',
    loader: 'attack-loader', chiller: 'fire-frost' } },
  lockLost: { sound: 'lock-lost' },
  stun: { sound: 'stun' },
  die: { by: 'kind', sounds: { crawler: 'die', drone: 'die', turret: 'die', loader: 'die-big', chiller: 'die-boss' } },
  phase: { sound: 'phase' },
  vent: { by: 'open', sounds: { 'true': 'vent-open', 'false': 'vent-close' } },
  summon: { sound: 'summon' },
  fire: { by: 'kind', sounds: { spark: 'fire-spark', bolt: 'fire-bolt', frost: 'fire-frost' } },
  shotEnd: { by: 'hit', sounds: { wall: 'shot-end', player: '' } },
  hurt: { sound: 'hurt', near: true },
  death: { sound: 'death' },
  door: { by: 'open', sounds: { 'true': 'door-open', 'false': 'door-close' } },
  doorLocked: { sound: 'door-locked' },
  secret: { sound: 'secret' },
  pickup: { by: 'item', sounds: CDA_SFX_PICKUP },
  rebootStart: { sound: 'reboot-start' },
  rebootStop: { sound: 'reboot-stop' },
  rebootDone: { sound: 'reboot-done' },
  liftLocked: { sound: 'door-locked' },
  liftOpen: { sound: 'lift-open' },
  win: { sound: 'win' },
  message: null      // the HUD line: the event that caused it has its own sound
};

// cdaSfxUi names -> sounds.
var CDA_SFX_UI = { click: 'ui-click', buy: 'ui-buy', refuse: 'ui-refuse' };

function cdaSfxHas(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// The AudioContext constructor of this browser, or null.
function cdaSfxClass() {
  if (typeof AudioContext === 'function') return AudioContext;
  return typeof webkitAudioContext === 'function' ? webkitAudioContext : null;
}

function cdaSfxResume(ctx) {
  if (ctx.state !== 'suspended') return;
  var p = ctx.resume();
  if (p && typeof p.then === 'function') p.then(null, function () {});
}

// Makes the graph's fixed part on a new context: master, compressor, noise.
function cdaSfxBuild(ctx) {
  var master = ctx.createGain();
  master.gain.value = CDA_SFX.muted ? 0 : CDA_SFX_MASTER;
  if (typeof ctx.createDynamicsCompressor === 'function') {
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    master.connect(comp);
    comp.connect(ctx.destination);
  } else {
    master.connect(ctx.destination);
  }
  var rate = ctx.sampleRate;
  var noise = ctx.createBuffer(1, rate, rate);
  var data = noise.getChannelData(0);
  for (var i = 0; i < data.length; i++) data[i] = cdaRand(CDA_SFX) * 2 - 1;
  CDA_SFX.master = master;
  CDA_SFX.noise = noise;
  CDA_SFX.panner = typeof ctx.createStereoPanner === 'function';
  CDA_SFX.ctx = ctx;
}

// On a user gesture: makes the context the first time, resumes it after.
// Returns whether sounds can play now.
function cdaSfxUnlock() {
  try {
    if (!CDA_SFX.ctx) {
      var Ctor = cdaSfxClass();
      if (!Ctor) return false;
      cdaSfxBuild(new Ctor());
    }
    cdaSfxResume(CDA_SFX.ctx);
    return CDA_SFX.ctx.state === 'running';
  } catch (err) {
    return false;
  }
}

function cdaSfxSetMute(on) {
  CDA_SFX.muted = !!on;
  if (CDA_SFX.master) CDA_SFX.master.gain.value = CDA_SFX.muted ? 0 : CDA_SFX_MASTER;
}

// Whether a sound may start now.
function cdaSfxLive() {
  return !!CDA_SFX.ctx && !CDA_SFX.muted && CDA_SFX.ctx.state === 'running';
}

// Where ev is heard from: { gain 0..1, pan -1..1 }.  near: full level.
function cdaSfxPlace(ev, sim, near) {
  var x = ev.x;
  var y = ev.y;
  if (typeof x !== 'number' && ev.id !== undefined && sim && sim.enemies) {
    for (var i = 0; i < sim.enemies.length; i++) {
      if (sim.enemies[i].id === ev.id) {
        x = sim.enemies[i].x;
        y = sim.enemies[i].y;
      }
    }
  }
  if (typeof x !== 'number' || !sim || !sim.player) return { gain: 1, pan: 0 };
  var p = sim.player;
  var d = cdaDist(p.x, p.y, x, y);
  if (d > CDA_SFX_RANGE && !near) return { gain: 0, pan: 0 };
  var gain = near ? 1 : 1 / (1 + CDA_SFX_ROLLOFF * Math.max(0, d - 1));
  var side = Math.sin(cdaAngleDiff(cdaAngleTo(p.x, p.y, x, y), p.angle));
  return { gain: gain, pan: side * CDA_SFX_PAN * Math.min(1, d) };
}

// The sound name an event asks for ('' for none).
function cdaSfxNameOf(ev) {
  var rule = cdaSfxHas(CDA_SFX_EVENTS, ev.type) ? CDA_SFX_EVENTS[ev.type] : null;
  if (!rule) return '';
  if (rule.sound) return rule.sound;
  var key = String(ev[rule.by]);
  return cdaSfxHas(rule.sounds, key) ? rule.sounds[key] : '';
}

// The sounds one step's events start: one per name (the loudest), at most
// CDA_SFX_PER_STEP, by pri then gain then order.  [{ name, gain, pan }]
function cdaSfxPick(events, sim) {
  var list = [];
  var at = {};
  for (var i = 0; i < events.length; i++) {
    var name = cdaSfxNameOf(events[i]);
    if (!name) continue;
    var place = cdaSfxPlace(events[i], sim, !!CDA_SFX_EVENTS[events[i].type].near);
    if (place.gain <= 0) continue;
    if (cdaSfxHas(at, name)) {
      var old = list[at[name]];
      if (place.gain > old.gain) {
        old.gain = place.gain;
        old.pan = place.pan;
      }
      continue;
    }
    at[name] = list.length;
    list.push({ name: name, gain: place.gain, pan: place.pan, order: list.length, pri: CDA_SFX_SOUNDS[name].pri });
  }
  list.sort(function (a, b) {
    if (a.pri !== b.pri) return b.pri - a.pri;
    if (a.gain !== b.gain) return b.gain - a.gain;
    return a.order - b.order;
  });
  var out = [];
  for (var k = 0; k < list.length && k < CDA_SFX_PER_STEP; k++) out.push({ name: list[k].name, gain: list[k].gain, pan: list[k].pan });
  return out;
}

// Disconnects the nodes of a finished voice (its source's onended).
function cdaSfxEnd(nodes) {
  return function () {
    for (var i = 0; i < nodes.length; i++) nodes[i].disconnect();
  };
}

// One voice into bus, starting at t0.  Returns its source node.
function cdaSfxVoice(ctx, v, bus, t0) {
  var t = t0 + (v.at || 0);
  var end = t + v.dur;
  var src;
  if (v.wave === 'noise') {
    src = ctx.createBufferSource();
    src.buffer = CDA_SFX.noise;
    src.loop = true;
  } else {
    src = ctx.createOscillator();
    src.type = v.wave;
    src.frequency.setValueAtTime(v.freq[0], t);
    if (v.freq[1] !== v.freq[0]) src.frequency.exponentialRampToValueAtTime(v.freq[1], end);
  }
  var env = ctx.createGain();
  env.gain.setValueAtTime(CDA_SFX_FLOOR, t);
  env.gain.linearRampToValueAtTime(v.gain, t + (v.attack || CDA_SFX_ATTACK));
  env.gain.exponentialRampToValueAtTime(CDA_SFX_FLOOR, end);
  var nodes = [src, env];
  if (v.filter) {
    var f = ctx.createBiquadFilter();
    f.type = v.filter[0];
    f.Q.value = v.filter[3];
    f.frequency.setValueAtTime(v.filter[1], t);
    if (v.filter[2] !== v.filter[1]) f.frequency.exponentialRampToValueAtTime(v.filter[2], end);
    src.connect(f);
    f.connect(env);
    nodes.push(f);
  } else {
    src.connect(env);
  }
  env.connect(bus);
  src.onended = cdaSfxEnd(nodes);
  if (v.wave === 'noise') src.start(t, cdaRand(CDA_SFX) * 0.9);
  else src.start(t);
  src.stop(end + 0.02);
  return src;
}

// Starts sound name at gain (0..1) and pan (-1..1).  Never throws.
function cdaSfxPlay(name, gain, pan) {
  var ctx = CDA_SFX.ctx;
  try {
    var sound = CDA_SFX_SOUNDS[name];
    var t0 = ctx.currentTime;
    var bus = ctx.createGain();
    bus.gain.value = gain;
    var tail = [bus];
    if (CDA_SFX.panner) {
      var pn = ctx.createStereoPanner();
      pn.pan.value = pan;
      bus.connect(pn);
      pn.connect(CDA_SFX.master);
      tail.push(pn);
    } else {
      bus.connect(CDA_SFX.master);
    }
    var last = null;
    var lastEnd = -1;
    for (var i = 0; i < sound.voices.length; i++) {
      var v = sound.voices[i];
      var src = cdaSfxVoice(ctx, v, bus, t0);
      if ((v.at || 0) + v.dur > lastEnd) {
        lastEnd = (v.at || 0) + v.dur;
        last = src;
      }
    }
    var ownEnd = last.onended;
    last.onended = function () {
      ownEnd();
      cdaSfxEnd(tail)();
    };
    CDA_SFX.last.push({ name: name, gain: gain, pan: pan });
  } catch (err) {
    // a browser that refuses a node: this sound stays silent
  }
}

// Once per sim step: plays what happened.
function cdaSfxEvents(events, sim) {
  CDA_SFX.last = [];
  if (!events || !events.length || !cdaSfxLive()) return;
  var picked = cdaSfxPick(events, sim);
  for (var i = 0; i < picked.length; i++) cdaSfxPlay(picked[i].name, picked[i].gain, picked[i].pan);
}

// A page sound: 'click', 'buy' or 'refuse'; any other name is silent.
function cdaSfxUi(name) {
  CDA_SFX.last = [];
  if (!cdaSfxHas(CDA_SFX_UI, name) || !cdaSfxLive()) return;
  cdaSfxPlay(CDA_SFX_UI[name], 1, 0);
}

CDA_API.CDA_SFX = CDA_SFX;
CDA_API.CDA_SFX_SOUNDS = CDA_SFX_SOUNDS;
CDA_API.CDA_SFX_EVENTS = CDA_SFX_EVENTS;
CDA_API.CDA_SFX_PICKUP = CDA_SFX_PICKUP;
CDA_API.CDA_SFX_UI = CDA_SFX_UI;
CDA_API.CDA_SFX_MASTER = CDA_SFX_MASTER;
CDA_API.CDA_SFX_PER_STEP = CDA_SFX_PER_STEP;
CDA_API.CDA_SFX_RANGE = CDA_SFX_RANGE;
CDA_API.CDA_SFX_MAX_DUR = CDA_SFX_MAX_DUR;
CDA_API.CDA_SFX_MAX_LONG = CDA_SFX_MAX_LONG;
CDA_API.cdaSfxUnlock = cdaSfxUnlock;
CDA_API.cdaSfxEvents = cdaSfxEvents;
CDA_API.cdaSfxSetMute = cdaSfxSetMute;
CDA_API.cdaSfxUi = cdaSfxUi;
CDA_API.cdaSfxPlace = cdaSfxPlace;
CDA_API.cdaSfxPick = cdaSfxPick;
CDA_API.cdaSfxNameOf = cdaSfxNameOf;
CDA_API.cdaSfxPlay = cdaSfxPlay;
