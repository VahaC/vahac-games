// ── storage: the save pks-state (v 1) and the snapshot pks-run of a level in progress ──
// Owns PKS_SAVE_KEY, pksNewSave, pksParseSave, pksSerialize, pksMergeSaves,
// pksReadSave, pksWriteSave, pksRecordWin, pksRecordMet, pksHighestWon,
// pksOwnedDefenders and pksLoadoutFor; and PKS_RUN_KEY, pksRunHash,
// pksRunText, pksParseRun, pksReadRun, pksPutRun and pksDropRun.  Uses core,
// defenders (PKS_DEF, PKS_DEFENDERS), enemies (PKS_ENEMIES, PKS_BOSS_TIERS),
// levels (PKS_LEVELS, pksLevel, pksSlots, pksUnlockedDefenders), sim
// (pksStep, inside a function body) and render (pksOwn).
//
// The save (plain data):
//   v         1
//   unlocked  the highest level the player may play, 1..150.  Level 1 is
//             open from the start and winning level n opens n + 1, so every
//             level below `unlocked` has been won.  A level is won when its
//             stars are above 0; level 150 is won when stars[149] > 0.
//   stars     150 whole numbers 0..3, the best stars of each level
//   loadout   the last loadout: known defender ids, no repeats, at most
//             pksSlots(150) (10)
//   speed     1 or 2
//   met       the enemies seen on the field (enemy ids and 'boss'), in table
//             order
// The highest level won (pksHighestWon) is 150 once level 150 has stars, else
// unlocked - 1; the defenders owned are pksUnlockedDefenders(highest won),
// as in the core, and level n plays with pksSlots(n) slots.
//
// A save written by the 50-level game loads unchanged in meaning, still as
// v 1 (no migration step is needed: the format only grew): its 50 stars are
// padded with zeros to 150, its unlocked level (1..50), loadout (at most 8),
// speed and met stay; and because a level with stars opens the next one, a
// player who had won level 50 (stars[49] > 0, unlocked 50 in that game) gets
// level 51 open and so owns the Canary (pksUnlockedDefenders(50)).
//
// Every field is checked on its own and falls back on its own (a corrupt
// file, another version or no save at all: a new save).  Storage is passed
// in (localStorage on the page, a stub in the tests); a storage that throws
// or is missing never stops the game: read and write report it instead.
// A stored save whose v is a whole number above PKS_SAVE_V was written by a
// newer version of the game: this one cannot read it, so it reads as a new
// save (newer: its v) and is never written over (pksWriteSave refuses; the
// page plays on in memory and says so).  The same holds for a snapshot
// pks-run of a newer version (v above PKS_RUN_V): not offered, never dropped
// or written over.
//
// The snapshot pks-run of a level in progress (levels last 12-21 minutes):
//   { v: 1, n (the level), hash (pksRunHash(n)), cards (the loadout: defender
//     ids, as the cards of the sim), sim (the sim as JSON, without its level
//     object and its events) }
// pksRunHash(n) hashes level n as pksLevel builds it and the unit tables, so
// a snapshot made before the tables changed (a new version of the game) is
// stale and ignored.  pksParseRun checks every part (version, level, hash,
// cards, the sim's lists and counters) and then plays one step on a copy:
// anything that fails or throws makes it null, and the page drops it.  The
// restored sim gets its level back from pksLevel and plays on exactly like
// the original (the sim is plain data, its RNG inside it).
// There is one snapshot for the whole browser.  The page writes it with
// pksPutRun(storage, text, expect), which writes only when the stored text is
// still `expect` (what this tab wrote last, null for none): the level most
// recently started or resumed in any tab owns the slot; a tab that finds
// another text there has lost it, keeps playing and never writes or drops it
// again (pksDropRun(storage, expect) drops only that text; with no expect it
// drops whatever is there: starting a level does that).  setItem writes the
// whole text at once, so a second tab can replace a snapshot, never corrupt
// one.

var PKS_SAVE_KEY = 'pks-state';
var PKS_SAVE_V = 1;
var PKS_MAX_LOADOUT = pksSlots(PKS_LEVELS);
var PKS_MET_IDS = pksMetIds();
var PKS_RUN_KEY = 'pks-run';
var PKS_RUN_V = 1;
var PKS_RUN_EVERY = 30;       // seconds of play between snapshots
// What every snapshot hashes besides its level: the unit tables.
var PKS_RUN_TABLES = JSON.stringify([PKS_DEFENDERS, PKS_ENEMIES, PKS_BOSS_TIERS]);
var PKS_RUN_HASHES = {};
// The lists and the counters every snapshot's sim must have.
var PKS_RUN_LISTS = ['cards', 'defenders', 'enemies', 'shots', 'shells', 'shimmers', 'breakers'];
var PKS_RUN_COUNTS = ['tick', 'time', 'rng', 'cycles', 'trickleT', 'tripped', 'spawnIndex', 'warned', 'surged', 'nextId'];

function pksMetIds() {
  var ids = [];
  for (var i = 0; i < PKS_ENEMIES.length; i++) ids.push(PKS_ENEMIES[i].id);
  ids.push('boss');
  return ids;
}

function pksNewSave() {
  var stars = [];
  for (var i = 0; i < PKS_LEVELS; i++) stars.push(0);
  return { v: 1, unlocked: 1, stars: stars, loadout: [], speed: 1, met: [] };
}

function pksIsWhole(value, lo, hi) {
  return typeof value === 'number' && Math.floor(value) === value && value >= lo && value <= hi;
}

// The save in `text` (what getItem returned: a string or null), each field
// checked on its own.
function pksParseSave(text) {
  var save = pksNewSave();
  var raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return save;
  }
  if (!raw || raw.v !== 1) return save;
  var i;
  if (pksIsWhole(raw.unlocked, 1, PKS_LEVELS)) save.unlocked = raw.unlocked;
  if (Array.isArray(raw.stars)) {
    for (i = 0; i < PKS_LEVELS; i++) {
      if (pksIsWhole(raw.stars[i], 0, 3)) save.stars[i] = raw.stars[i];
    }
  }
  // a level with stars was won, so the one after it is open
  for (i = 0; i < PKS_LEVELS; i++) {
    if (save.stars[i] > 0) save.unlocked = Math.max(save.unlocked, Math.min(PKS_LEVELS, i + 2));
  }
  if (Array.isArray(raw.loadout)) {
    for (i = 0; i < raw.loadout.length && save.loadout.length < PKS_MAX_LOADOUT; i++) {
      var id = raw.loadout[i];
      if (typeof id === 'string' && pksOwn(PKS_DEF, id) && save.loadout.indexOf(id) === -1) save.loadout.push(id);
    }
  }
  if (raw.speed === 2) save.speed = 2;
  if (Array.isArray(raw.met)) save.met = pksMetOf(raw.met, []);
  return save;
}

// The known enemy ids found in either list, in table order.
function pksMetOf(a, b) {
  var out = [];
  for (var i = 0; i < PKS_MET_IDS.length; i++) {
    if (a.indexOf(PKS_MET_IDS[i]) !== -1 || b.indexOf(PKS_MET_IDS[i]) !== -1) out.push(PKS_MET_IDS[i]);
  }
  return out;
}

// The text stored under PKS_SAVE_KEY, fields in a fixed order.
function pksSerialize(save) {
  return JSON.stringify({
    v: 1, unlocked: save.unlocked, stars: save.stars, loadout: save.loadout, speed: save.speed, met: save.met
  });
}

// Two saves as one (a second tab may have moved on): the higher unlocked
// level, the best stars of each level, every enemy met; the loadout and the
// speed of `mine`.  Both are parsed saves; neither is changed.
function pksMergeSaves(mine, stored) {
  var out = {
    v: 1, unlocked: Math.max(mine.unlocked, stored.unlocked), stars: [], loadout: mine.loadout.slice(),
    speed: mine.speed, met: pksMetOf(mine.met, stored.met)
  };
  for (var i = 0; i < PKS_LEVELS; i++) out.stars.push(Math.max(mine.stars[i], stored.stars[i]));
  return out;
}

// The v of a stored text (a save or a snapshot) when it is a newer version
// than `known`, the one this build writes (a whole number above it), else 0.
function pksNewerV(text, known) {
  var raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return 0;
  }
  return raw && typeof raw.v === 'number' && Math.floor(raw.v) === raw.v && raw.v > known ? raw.v : 0;
}

// { state, ok, error, newer }: the stored save (a new one when there is none
// or it cannot be read); ok false with the thrown error when reading failed,
// or with error null and newer (its v) when the stored save is of a newer
// version (newer is 0 otherwise).
function pksReadSave(storage) {
  var text;
  try {
    text = storage.getItem(PKS_SAVE_KEY);
  } catch (err) {
    return { state: pksNewSave(), ok: false, error: err, newer: 0 };
  }
  var newer = pksNewerV(text, PKS_SAVE_V);
  return { state: pksParseSave(text), ok: newer === 0, error: null, newer: newer };
}

// Re-reads the stored save, merges `save` into it and writes the result.
// { state, ok, error, newer }: state is the merged save (adopt it: it
// carries a second tab's progress); ok false with the error when writing
// failed (blocked or full storage), or with newer (and nothing written) when
// the stored save is of a newer version.  Never throws.
function pksWriteSave(storage, save) {
  var read = pksReadSave(storage);
  var merged = pksMergeSaves(save, read.state);
  if (read.newer) return { state: merged, ok: false, error: null, newer: read.newer };
  try {
    storage.setItem(PKS_SAVE_KEY, pksSerialize(merged));
  } catch (err) {
    return { state: merged, ok: false, error: err, newer: 0 };
  }
  return { state: merged, ok: true, error: null, newer: 0 };
}

function pksHighestWon(save) {
  return save.stars[PKS_LEVELS - 1] > 0 ? PKS_LEVELS : save.unlocked - 1;
}

// The defender ids the player owns, in unlock order.
function pksOwnedDefenders(save) {
  return pksUnlockedDefenders(pksHighestWon(save));
}

// A win of level n with `stars` (1..3).  Returns what the result screen
// shows, and the new save (the old one is not changed):
//   state        the save after the win
//   level, stars, before   the level, its best stars now and before
//   improved     whether the stars went up (true on a first win)
//   newLevel     the level this win opened, or null
//   newDefenders the defender ids this win unlocked (usually none or one)
//   newSlots     the loadout slots the newly opened level has when it has
//                more than the highest level open before, or null
function pksRecordWin(save, n, stars) {
  var next = pksMergeSaves(save, save);
  var before = save.stars[n - 1];
  next.stars[n - 1] = Math.max(before, stars);
  next.unlocked = Math.max(save.unlocked, Math.min(PKS_LEVELS, n + 1));
  var owned = pksOwnedDefenders(save);
  var slots = pksSlots(next.unlocked);
  return {
    state: next, level: n, stars: next.stars[n - 1], before: before, improved: stars > before,
    newLevel: next.unlocked > save.unlocked ? next.unlocked : null,
    newDefenders: pksOwnedDefenders(next).slice(owned.length),
    newSlots: slots > pksSlots(save.unlocked) ? slots : null
  };
}

// The save with enemy `id` met: { state, added }.  The same save object
// comes back when the id was known already or is not an enemy.
function pksRecordMet(save, id) {
  if (save.met.indexOf(id) !== -1 || PKS_MET_IDS.indexOf(id) === -1) return { state: save, added: false };
  var next = pksMergeSaves(save, save);
  next.met = pksMetOf(save.met, [id]);
  return { state: next, added: true };
}

// The cards for level n: { owned, slots, pick, choose }.  When everything
// owned fits, pick is all of it and choose is false (no loadout screen);
// otherwise choose is true and pick preselects the last loadout (what is
// still owned), filled up with the newest owned defenders.
function pksLoadoutFor(save, n) {
  var owned = pksOwnedDefenders(save);
  var slots = pksSlots(n);
  if (owned.length <= slots) return { owned: owned, slots: slots, pick: owned.slice(), choose: false };
  var pick = [];
  var i;
  for (i = 0; i < save.loadout.length && pick.length < slots; i++) {
    if (owned.indexOf(save.loadout[i]) !== -1) pick.push(save.loadout[i]);
  }
  for (i = owned.length - 1; pick.length < slots; i--) {
    if (pick.indexOf(owned[i]) === -1) pick.push(owned[i]);
  }
  return { owned: owned, slots: slots, pick: pick, choose: true };
}

// ── the snapshot of a level in progress ──

// FNV-1a of a text, as 8 hex digits.
function pksHash(text) {
  var h = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

// The hash of level n and the unit tables (once per level and page).
function pksRunHash(n) {
  if (!pksOwn(PKS_RUN_HASHES, n)) PKS_RUN_HASHES[n] = pksHash(PKS_RUN_TABLES + JSON.stringify(pksLevel(n)));
  return PKS_RUN_HASHES[n];
}

// The snapshot text of a sim being played with the cards `cards`.
function pksRunText(sim, cards) {
  var copy = {};
  var keys = Object.keys(sim);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] !== 'level' && keys[i] !== 'events') copy[keys[i]] = sim[keys[i]];
  }
  return JSON.stringify({ v: PKS_RUN_V, n: sim.n, hash: pksRunHash(sim.n), cards: cards, sim: copy });
}

// The snapshot in `text` as { n, cards, sim, time }, the sim with its level
// back and ready to play on; null for anything that is not a sound snapshot
// of the game as it is now.
function pksParseRun(text) {
  var raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return null;
  }
  if (!raw || raw.v !== PKS_RUN_V || !pksIsWhole(raw.n, 1, PKS_LEVELS) || raw.hash !== pksRunHash(raw.n)) return null;
  var sim = raw.sim;
  if (!pksRunCards(raw.cards) || !sim || !pksRunSound(sim, raw)) return null;
  sim.level = pksLevel(raw.n);
  sim.events = [];
  try {
    pksStep(JSON.parse(JSON.stringify(sim)));
  } catch (err) {
    return null;
  }
  return { n: raw.n, cards: raw.cards, sim: sim, time: sim.time };
}

// Defender ids, no repeats, 1 to PKS_MAX_LOADOUT of them.
function pksRunCards(cards) {
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > PKS_MAX_LOADOUT) return false;
  for (var i = 0; i < cards.length; i++) {
    if (typeof cards[i] !== 'string' || !pksOwn(PKS_DEF, cards[i]) || cards.indexOf(cards[i]) !== i) return false;
  }
  return true;
}

// The sim of a snapshot: its level, still playing, its lists and counters,
// its cards those of the snapshot.
function pksRunSound(sim, raw) {
  var i;
  if (sim.n !== raw.n || sim.status !== 'playing' || !sim.stats || typeof sim.stats !== 'object') return false;
  for (i = 0; i < PKS_RUN_LISTS.length; i++) {
    if (!Array.isArray(sim[PKS_RUN_LISTS[i]])) return false;
  }
  for (i = 0; i < PKS_RUN_COUNTS.length; i++) {
    if (typeof sim[PKS_RUN_COUNTS[i]] !== 'number' || !isFinite(sim[PKS_RUN_COUNTS[i]])) return false;
  }
  if (sim.breakers.length !== PKS_LANES || sim.cards.length !== raw.cards.length) return false;
  for (i = 0; i < sim.cards.length; i++) {
    if (!sim.cards[i] || sim.cards[i].id !== raw.cards[i]) return false;
  }
  return true;
}

// { text, run, ok, error, newer }: the stored snapshot's text (null: none)
// and what it holds (null: none or not sound); ok false when reading threw;
// newer the v of a snapshot of a newer version (else 0): its run is null,
// and the page must neither offer nor drop it.
function pksReadRun(storage) {
  var text;
  try {
    text = storage.getItem(PKS_RUN_KEY);
  } catch (err) {
    return { text: null, run: null, ok: false, error: err, newer: 0 };
  }
  return { text: text, run: text === null ? null : pksParseRun(text), ok: true, error: null, newer: pksNewerV(text, PKS_RUN_V) };
}

// Writes snapshot `text` when the stored one is still `expect` (null: none).
// { ok, lost, error }: lost when another text is there (another tab owns
// the slot now) or when the stored one is of a newer version (never written
// over, whatever `expect` says); ok false with the error when storage refused.
// Never throws.
function pksPutRun(storage, text, expect) {
  try {
    var stored = storage.getItem(PKS_RUN_KEY);
    if (stored !== expect || pksNewerV(stored, PKS_RUN_V)) return { ok: false, lost: true, error: null };
    storage.setItem(PKS_RUN_KEY, text);
  } catch (err) {
    return { ok: false, lost: false, error: err };
  }
  return { ok: true, lost: false, error: null };
}

// Drops the stored snapshot when it is `expect`, or whatever it is when no
// expect is given, but never one of a newer version.  Returns false when
// storage refused.  Never throws.
function pksDropRun(storage, expect) {
  try {
    var stored = storage.getItem(PKS_RUN_KEY);
    if ((expect === undefined || stored === expect) && !pksNewerV(stored, PKS_RUN_V)) storage.removeItem(PKS_RUN_KEY);
  } catch (err) {
    return false;
  }
  return true;
}
