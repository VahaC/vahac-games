// ── storage: the save cda-state (v 1), its patch balance and upgrades, read and written through localStorage ──
// Owns CDA_SAVE_KEY, CDA_SAVE_V, CDA_SAVE_LEVELS, CDA_SENS_MIN / MAX /
// DEFAULT, cdaNewSave, cdaParseSave, cdaSerialize, cdaMergeSaves,
// cdaReadSave, cdaWriteSave, cdaRecordWin, cdaPatchesEarned,
// cdaPatchesSpent, cdaPatchBalance, cdaUpgradeNext, cdaBuyUpgrade,
// cdaRecordDeath, cdaAddPlayTime, cdaSetSens, cdaSetMute and cdaMarkEnded.
// Uses tables (CDA_UPGRADES) and, from the page's side, the object cdaResult
// (sim) returns.  No DOM but localStorage.
//
// The save (plain data, changed in place by the functions below):
//   v         1
//   epoch     whole number, 0 in a new save and in an older save without
//             the field: New game (the page) writes a fresh save one epoch
//             above every save it knows, so an erase is told from an old save
//             (see Two tabs)
//   unlocked  the highest level open, 1..levels.  Level 1 is open from the
//             start; winning level n opens n + 1, and a level with a best
//             entry was won, so the level after it is open (parse enforces it).
//   best      one entry per level (levels of them), null for a level never
//             won, else { time (seconds, the fastest win; null when the stored
//             one was unreadable), kills (the most), enemies (the level's
//             enemy count), secrets (the most), secretsTotal, patches (the
//             most one win earned) }.  Each field is the best of its own:
//             they may come from different wins.
//   upgrades  { lineId: tiers } for the CDA_UPGRADES lines bought (1..the
//             line's costs.length); a line not bought is absent.
//   deaths    whole number; playTime: seconds played (to the millisecond)
//   ended     true once the end-of-episode screen was shown
//   settings  { sens: mouse sensitivity CDA_SENS_MIN..CDA_SENS_MAX, default
//             CDA_SENS_DEFAULT; mute: boolean }
// The stored text, fields in this order (a test pins it):
//   {"v":1,"epoch":0,"unlocked":2,"best":[{"time":312.5,"kills":14,"enemies":15,
//    "secrets":1,"secretsTotal":2,"patches":17},null,...],"upgrades":
//    {"health":2},"deaths":5,"playTime":1834.5,"ended":false,
//    "settings":{"sens":1.5,"mute":true}}
//
// levels: how many levels the episode has comes from the page (the length
// of CDA_LEVELS), passed to cdaNewSave, cdaParseSave and cdaReadSave
// (CDA_SAVE_LEVELS, 9, when it is missing or not a whole number above 0);
// every other function takes it from save.best.length.
//
// Patches (spec, decisions after wave 1): earned is the sum over levels of
// the best patches a win of that level earned, so replaying a level never
// earns the same patches twice; spent is what the tiers bought cost
// (CDA_UPGRADES costs); the balance is earned - spent.
//
// Every field is parsed on its own and falls back on its own (wrong type,
// out of range, NaN, missing: the new save's value; a best entry that is
// not an object: never won; a best field: 0, its time null).  Text that is
// not a JSON object with v 1 is no save at all (a new save).  A stored save
// whose v is a whole number above CDA_SAVE_V was written by a newer game: it
// reads as a new save with `newer` set to its v, and cdaWriteSave never
// writes over it (the page plays on in memory and says so), as Packet Siege.
//
// Repairs, on every parse and merge: tiers above a line's top tier are cut
// to the top tier, and when the upgrades cost more than the patches earned
// (a hand-edited or damaged save, or two tabs that spent the same patches)
// the upgrades are kept in CDA_UPGRADES order, each line's tiers from the
// lowest up, while the patches earned still pay for them; the first tier
// that does not fit ends its line, the next line is tried, and every tier
// dropped is refunded (the balance never goes below 0).
//
// Two tabs: cdaWriteSave reads what is stored first and merges.  Saves of
// different epochs are not merged: the higher epoch wins outright (a New
// game in one tab is not undone by the progress another tab still holds),
// with the settings of the writer.  Saves of the same epoch merge: the highest
// unlocked, per level the best of each best field (the lowest time, the most
// kills, enemies, secrets, secretsTotal and patches), the highest tier per
// upgrade line, the most deaths, the most play time, ended if either; the
// settings of the writer; then the repair above.  The save passed in takes
// the merged state.  Blocked or full storage never throws: read and write
// report it (ok false, error the thrown error) so the page can warn once.

var CDA_SAVE_KEY = 'cda-state';
var CDA_SAVE_V = 1;
var CDA_SAVE_LEVELS = 9;
var CDA_SENS_MIN = 0.25;
var CDA_SENS_MAX = 3;
var CDA_SENS_DEFAULT = 1;
var CDA_SAVE_BIG = 1e9;       // the most any count or time may be

function cdaSaveWhole(value, lo, hi) {
  return typeof value === 'number' && Math.floor(value) === value && value >= lo && value <= hi;
}

// A number in lo..hi (NaN fails both comparisons).
function cdaSaveNumber(value, lo, hi) {
  return typeof value === 'number' && value >= lo && value <= hi;
}

function cdaSaveObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cdaSaveLevels(levels) {
  return cdaSaveWhole(levels, 1, CDA_SAVE_BIG) ? levels : CDA_SAVE_LEVELS;
}

function cdaSaveCount(value) {
  return cdaSaveWhole(value, 0, CDA_SAVE_BIG) ? value : 0;
}

// Seconds to the millisecond, or null for anything that is not a time.
function cdaSaveTime(value) {
  return typeof value === 'number' && value > 0 && value <= CDA_SAVE_BIG ? Math.round(value * 1000) / 1000 : null;
}

function cdaNewSave(levels) {
  var n = cdaSaveLevels(levels);
  var best = [];
  for (var i = 0; i < n; i++) best.push(null);
  return {
    v: CDA_SAVE_V, epoch: 0, unlocked: 1, best: best, upgrades: {}, deaths: 0, playTime: 0, ended: false,
    settings: { sens: CDA_SENS_DEFAULT, mute: false }
  };
}

function cdaBestEntry(raw) {
  return {
    time: cdaSaveTime(raw.time), kills: cdaSaveCount(raw.kills), enemies: cdaSaveCount(raw.enemies),
    secrets: cdaSaveCount(raw.secrets), secretsTotal: cdaSaveCount(raw.secretsTotal), patches: cdaSaveCount(raw.patches)
  };
}

// Two best entries (either may be null) as one, field by field; a new object.
function cdaMergeBest(a, b) {
  if (!a || !b) return a || b ? cdaBestEntry(a || b) : null;
  return {
    time: a.time === null ? b.time : b.time === null ? a.time : Math.min(a.time, b.time),
    kills: Math.max(a.kills, b.kills), enemies: Math.max(a.enemies, b.enemies),
    secrets: Math.max(a.secrets, b.secrets), secretsTotal: Math.max(a.secretsTotal, b.secretsTotal),
    patches: Math.max(a.patches, b.patches)
  };
}

// The tiers bought of each line, whole and at most the top tier.
function cdaParseUpgrades(raw) {
  var out = {};
  if (!cdaSaveObject(raw)) return out;
  for (var i = 0; i < CDA_UPGRADES.length; i++) {
    var line = CDA_UPGRADES[i];
    if (cdaSaveWhole(raw[line.id], 1, CDA_SAVE_BIG)) out[line.id] = Math.min(raw[line.id], line.costs.length);
  }
  return out;
}

// Drops the tiers the patches earned do not pay for (see the header).
function cdaRepairUpgrades(save) {
  var left = cdaPatchesEarned(save);
  var out = {};
  for (var i = 0; i < CDA_UPGRADES.length; i++) {
    var line = CDA_UPGRADES[i];
    var have = save.upgrades[line.id] || 0;
    var t = 0;
    while (t < have && line.costs[t] <= left) {
      left -= line.costs[t];
      t++;
    }
    if (t > 0) out[line.id] = t;
  }
  save.upgrades = out;
}

// The save in `text` (what getItem returned: a string or null).
function cdaParseSave(text, levels) {
  var save = cdaNewSave(levels);
  var n = save.best.length;
  var raw;
  var i;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return save;
  }
  if (!cdaSaveObject(raw) || raw.v !== CDA_SAVE_V) return save;
  save.epoch = cdaSaveCount(raw.epoch);
  if (cdaSaveWhole(raw.unlocked, 1, n)) save.unlocked = raw.unlocked;
  if (Array.isArray(raw.best)) {
    for (i = 0; i < n; i++) save.best[i] = cdaSaveObject(raw.best[i]) ? cdaBestEntry(raw.best[i]) : null;
  }
  for (i = 0; i < n; i++) {
    if (save.best[i]) save.unlocked = Math.max(save.unlocked, Math.min(n, i + 2));
  }
  save.upgrades = cdaParseUpgrades(raw.upgrades);
  save.deaths = cdaSaveCount(raw.deaths);
  if (cdaSaveNumber(raw.playTime, 0, CDA_SAVE_BIG)) save.playTime = raw.playTime;
  save.ended = raw.ended === true;
  if (cdaSaveObject(raw.settings)) {
    if (cdaSaveNumber(raw.settings.sens, CDA_SENS_MIN, CDA_SENS_MAX)) save.settings.sens = raw.settings.sens;
    save.settings.mute = raw.settings.mute === true;
  }
  cdaRepairUpgrades(save);
  return save;
}

// The text stored under CDA_SAVE_KEY, fields and upgrade lines in a fixed order.
function cdaSerialize(save) {
  var upgrades = {};
  for (var i = 0; i < CDA_UPGRADES.length; i++) {
    var id = CDA_UPGRADES[i].id;
    if (save.upgrades[id]) upgrades[id] = save.upgrades[id];
  }
  return JSON.stringify({
    v: CDA_SAVE_V, epoch: save.epoch, unlocked: save.unlocked, best: save.best, upgrades: upgrades, deaths: save.deaths,
    playTime: save.playTime, ended: save.ended, settings: { sens: save.settings.sens, mute: save.settings.mute }
  });
}

// Two saves as one (see the header); neither is changed.  Its levels are
// those of `mine`.
function cdaMergeSaves(mine, stored) {
  var out;
  var i;
  if (mine.epoch !== stored.epoch) {
    out = cdaParseSave(cdaSerialize(mine.epoch > stored.epoch ? mine : stored), mine.best.length);
    out.settings = { sens: mine.settings.sens, mute: mine.settings.mute };
    return out;
  }
  out = cdaNewSave(mine.best.length);
  out.epoch = mine.epoch;
  out.unlocked = Math.max(mine.unlocked, stored.unlocked);
  for (i = 0; i < out.best.length; i++) out.best[i] = cdaMergeBest(mine.best[i], stored.best[i]);
  for (i = 0; i < CDA_UPGRADES.length; i++) {
    var id = CDA_UPGRADES[i].id;
    var tiers = Math.max(mine.upgrades[id] || 0, stored.upgrades[id] || 0);
    if (tiers > 0) out.upgrades[id] = tiers;
  }
  out.deaths = Math.max(mine.deaths, stored.deaths);
  out.playTime = Math.max(mine.playTime, stored.playTime);
  out.ended = mine.ended || stored.ended;
  out.settings = { sens: mine.settings.sens, mute: mine.settings.mute };
  cdaRepairUpgrades(out);
  return out;
}

// The v of a stored text when it is a whole number above CDA_SAVE_V, else 0.
function cdaSaveNewer(text) {
  var raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return 0;
  }
  return cdaSaveObject(raw) && cdaSaveWhole(raw.v, CDA_SAVE_V + 1, CDA_SAVE_BIG) ? raw.v : 0;
}

// { state, ok, error, newer }: the stored save (a new one when there is none
// or it cannot be read); ok false with the thrown error when reading failed,
// or with error null and newer (its v) when the stored save is of a newer
// version (newer is 0 otherwise).  Never throws.
function cdaReadSave(levels) {
  var text;
  try {
    text = localStorage.getItem(CDA_SAVE_KEY);
  } catch (err) {
    return { state: cdaNewSave(levels), ok: false, error: err, newer: 0 };
  }
  var newer = cdaSaveNewer(text);
  return { state: cdaParseSave(text, levels), ok: newer === 0, error: null, newer: newer };
}

// Re-reads the stored save, merges it into `save` (changed in place) and
// writes the result.  { state (that same save), ok, error, newer }: ok
// false with the error when storage refused (blocked or full), or with
// newer (and nothing written) when the stored save is of a newer version.
// Never throws.
function cdaWriteSave(save) {
  var read = cdaReadSave(save.best.length);
  var merged = cdaMergeSaves(save, read.state);
  var keys = Object.keys(merged);
  for (var i = 0; i < keys.length; i++) save[keys[i]] = merged[keys[i]];
  if (read.newer) return { state: save, ok: false, error: null, newer: read.newer };
  try {
    localStorage.setItem(CDA_SAVE_KEY, cdaSerialize(save));
  } catch (err) {
    return { state: save, ok: false, error: err, newer: 0 };
  }
  return { state: save, ok: true, error: null, newer: 0 };
}

// A win of level n (1-based) with `result`, cdaResult(sim) of the won sim.
// Updates the level's best entry and opens the next level.  Returns what
// the results screen shows:
//   best      the level's best entry now (the save's own object)
//   first     true on the level's first win
//   newTime   the fastest time went down (true on a first win)
//   patches   the patches this win added to the balance (0 when an earlier
//             win of the level earned as many)
//   unlocked  the level this win opened, or null
//   finished  the last level was won (the episode is over)
function cdaRecordWin(save, n, result) {
  var old = save.best[n - 1];
  var last = save.best.length;
  var before = save.unlocked;
  var best = cdaMergeBest(old, cdaBestEntry(result));
  save.best[n - 1] = best;
  save.unlocked = Math.max(before, Math.min(last, n + 1));
  return {
    best: best, first: !old, newTime: !old || best.time !== old.time,
    patches: best.patches - (old ? old.patches : 0),
    unlocked: save.unlocked > before ? save.unlocked : null,
    finished: n === last
  };
}

function cdaPatchesEarned(save) {
  var sum = 0;
  for (var i = 0; i < save.best.length; i++) {
    if (save.best[i]) sum += save.best[i].patches;
  }
  return sum;
}

function cdaPatchesSpent(save) {
  var sum = 0;
  for (var i = 0; i < CDA_UPGRADES.length; i++) {
    var line = CDA_UPGRADES[i];
    for (var t = 0; t < (save.upgrades[line.id] || 0); t++) sum += line.costs[t];
  }
  return sum;
}

// Earned - spent, never below 0.
function cdaPatchBalance(save) {
  return Math.max(0, cdaPatchesEarned(save) - cdaPatchesSpent(save));
}

// The next tier of upgrade line `id` as { id, tier (1-based), cost }, or
// null at the top tier (and for an id that is not a line).
function cdaUpgradeNext(save, id) {
  var line = CDA_UPGRADE[id];
  if (!line) return null;
  var have = save.upgrades[id] || 0;
  return have < line.costs.length ? { id: id, tier: have + 1, cost: line.costs[have] } : null;
}

// Buys the next tier of line `id` when the balance pays for it; returns
// whether it did.
function cdaBuyUpgrade(save, id) {
  var next = cdaUpgradeNext(save, id);
  if (!next || next.cost > cdaPatchBalance(save)) return false;
  save.upgrades[id] = next.tier;
  return true;
}

function cdaRecordDeath(save) {
  save.deaths++;
}

// Adds `seconds` (a number, 0 or more; anything else is ignored).
function cdaAddPlayTime(save, seconds) {
  if (cdaSaveNumber(seconds, 0, CDA_SAVE_BIG)) save.playTime = Math.round((save.playTime + seconds) * 1000) / 1000;
}

// Sets the mouse sensitivity, clamped to CDA_SENS_MIN..CDA_SENS_MAX (a value
// that is not a number changes nothing); returns the sensitivity now.
function cdaSetSens(save, value) {
  if (typeof value === 'number' && value === value) {
    save.settings.sens = Math.min(CDA_SENS_MAX, Math.max(CDA_SENS_MIN, value));
  }
  return save.settings.sens;
}

function cdaSetMute(save, on) {
  save.settings.mute = !!on;
}

function cdaMarkEnded(save) {
  save.ended = true;
}

CDA_API.CDA_SAVE_KEY = CDA_SAVE_KEY;
CDA_API.CDA_SAVE_V = CDA_SAVE_V;
CDA_API.CDA_SAVE_LEVELS = CDA_SAVE_LEVELS;
CDA_API.CDA_SENS_MIN = CDA_SENS_MIN;
CDA_API.CDA_SENS_MAX = CDA_SENS_MAX;
CDA_API.CDA_SENS_DEFAULT = CDA_SENS_DEFAULT;
CDA_API.cdaNewSave = cdaNewSave;
CDA_API.cdaParseSave = cdaParseSave;
CDA_API.cdaSerialize = cdaSerialize;
CDA_API.cdaMergeSaves = cdaMergeSaves;
CDA_API.cdaReadSave = cdaReadSave;
CDA_API.cdaWriteSave = cdaWriteSave;
CDA_API.cdaRecordWin = cdaRecordWin;
CDA_API.cdaPatchesEarned = cdaPatchesEarned;
CDA_API.cdaPatchesSpent = cdaPatchesSpent;
CDA_API.cdaPatchBalance = cdaPatchBalance;
CDA_API.cdaUpgradeNext = cdaUpgradeNext;
CDA_API.cdaBuyUpgrade = cdaBuyUpgrade;
CDA_API.cdaRecordDeath = cdaRecordDeath;
CDA_API.cdaAddPlayTime = cdaAddPlayTime;
CDA_API.cdaSetSens = cdaSetSens;
CDA_API.cdaSetMute = cdaSetMute;
CDA_API.cdaMarkEnded = cdaMarkEnded;
