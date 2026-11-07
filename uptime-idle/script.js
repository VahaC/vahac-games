// Uptime Idle — script.js
// Prefix: upi-
// Dependencies: none.
//
// An idle game about a homelab.  An old laptop under the desk runs a DNS
// filter and earns uptime credits (cr).  Credits buy services (DNS filter,
// backup server, photo archive, media server, build farm), which earn credits
// every second and take one slot each, and hardware: a mini PC, a NAS and a
// virtualization node give slots and take a place (the desk holds
// UPI_DESK_PLACES machines), a server rack gives UPI_RACK_UNITS more places.
// Everything draws watts, and the power bill is taken off the income all the
// time.
//
// Power bill: watts x hours x price per kWh / 1000, the formula of the
// Homelab Power Cost Calculator.  One second of play bills one hour at
// UPI_KWH_PRICE credits per kWh, and the watts are multiplied by the PUE of
// the cooling (1.6 with a desk fan, down to 1.1 with the last upgrade).
//
// Prices grow geometrically: an item's next copy costs base x 1.15^owned,
// rounded up; at UPI_MAX_COUNT copies an item is sold out.  Upgrades (RAID
// mirror, UPS, cooling levels) have fixed prices per level.  Hardware only
// draws power, so a machine that would bring the net income (without
// incidents) to 0 or below is refused: a lab with no income and no credits
// could never buy the service that pays for it.  A damaged save that holds
// such a lab powers machines off until it earns (upiRepair).
//
// Incidents come from a seeded PRNG passed into upiApplyEvent (the page keeps
// its mulberry32 seed in the save; Math.random only seeds a fresh game):
//   disk failure     halves the income until the disk is replaced; with a
//                    RAID mirror it costs nothing.
//   power outage     stops income and the power bill for 30 s; a UPS rides
//                    it out.
//   kernel update    an offer for 60 s: Reboot gives +50 % income for 60 s.
//
// The model (upiTick, upiCostOf, upiOfflineGain, upiApplyOffline,
// upiApplyEvent, upiBuy, upiResolve, upiPrestige ...) is pure: no DOM, no
// Date, no Math.random.  The page runs upiTick every UPI_TICK_MS with that
// fixed step, so a slow or late timer never changes the result of a tick.
// Date is read in one place, upiNow().
//
// Offline progress: the save keeps the time it was written.  On opening the
// page, or showing a hidden tab again, the time since then counts at the
// current net income, up to UPI_OFFLINE_CAP_MS (8 h).  A clock set backwards
// counts nothing, and a clock set far forwards counts the cap at most.  The
// time saved is a high-water mark (upiMarkNow): after a clock set back it
// stays at the latest time seen, so setting the clock forwards and back again
// pays the cap once, not on every round trip.  The welcome-back line names
// the time counted and the cap.  A hidden tab stops its ticks; showing it
// again adds the hidden time in one sum, never a burst of ticks.  A visible
// tab whose computer slept gets no visibilitychange: its next tick finds the
// gap on the wall clock and counts it the same way.
//
// Session goal: one goal at a time, sized from the current income so a 3 to
// 5 minute visit finishes it: earn about 3 minutes of the net income.  It
// pays a bonus of 90 s of income and the next one starts.
//
// Pacing (pinned by simulations in the tests): the first purchase within
// 30 s, the first server rack within about 20 minutes of active play, and a
// migration within about 2 hours.
//
// Migrate to a new rack (prestige): with a server rack and UPI_PRESTIGE_MIN
// credits earned in this run, everything starts over and the run's earnings
// become rack points: floor(10 x sqrt(earned / UPI_PRESTIGE_MIN)).  Every
// point adds 2 % to all income for good.
//
// Keys: 1-9 buy the nine services and hardware items in shop order, only
// while the focus is inside the game.  Ctrl / Alt / Cmd combinations, held
// keys and keys typed anywhere else on the host page are left alone.  A held
// Enter or Space on a game button clicks it once, not on every repeat, and
// the migrate confirmation ignores a second press within 400 ms.
//
// Saves: upi-state (credits, items, upgrades, the incident, the multiplier
// as rack points, the run, the goal, the PRNG seed and the time of the save),
// written every few seconds and after every action, never every tick;
// upi-stats (credits earned over all runs, migrations).  Every field is
// checked on load and falls back on its own; storage that is blocked or full
// never stops the game.
//
// Tabs: before writing, upi-state is read again.  A text another tab wrote
// since this tab last read or wrote it is taken over instead of overwritten,
// at once through the storage event too, and upi-stats is merged field by
// field (the higher value wins), so no tab erases another tab's progress.
// Only a takeover that brings a purchase or a migration says so in a toast
// and cancels a pending migrate confirmation; two open tabs take over each
// other's routine saves silently.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser upiInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var UPI_STATE_KEY = 'upi-state';
  var UPI_STATS_KEY = 'upi-stats';
  var UPI_SAVE_VERSION = 1;

  var UPI_TICK_MS = 250;
  var UPI_SAVE_EVERY = 20;
  var UPI_SLEEP_MS = 2000;
  var UPI_TOAST_MS = 2500;
  var UPI_CONFIRM_MS = 4000;
  var UPI_CONFIRM_GAP_MS = 400;
  var UPI_WELCOME_MIN_MS = 60000;
  var UPI_LOG_LINES = 8;

  var UPI_MAX = 9007199254740991;
  var UPI_MAX_COUNT = 150;
  var UPI_MAX_POINTS = 1000000000;
  var UPI_GROWTH = 1.15;

  var UPI_KWH_PRICE = 4;
  var UPI_HOURS_PER_SECOND = 1;
  var UPI_PUE = [1.6, 1.4, 1.25, 1.1];

  var UPI_OFFLINE_CAP_MS = 8 * 3600000;

  var UPI_EVENT_CHANCE = 1 / 360;
  var UPI_EVENT_GRACE_MS = 60000;
  var UPI_OUTAGE_MS = 30000;
  var UPI_KERNEL_MS = 60000;
  var UPI_BOOST_MS = 60000;
  var UPI_BOOST = 1.5;
  var UPI_DISK_FACTOR = 0.5;

  var UPI_PRESTIGE_MIN = 300000000;
  var UPI_POINT_BONUS = 0.02;

  var UPI_GOAL_SECONDS = 180;
  var UPI_GOAL_MIN_EARN = 60;
  var UPI_REWARD_SECONDS = 90;
  var UPI_REWARD_MIN = 20;

  // The shop.  Services earn income (cr/s) and take one slot each; hardware
  // gives slots and takes a place on the desk or in a rack; a rack gives
  // places for UPI_RACK_UNITS machines.  Everything draws watts.  The nine
  // services and hardware items have the keys 1-9.  The old laptop is not
  // sold: it is the machine every run starts on, with UPI_LAPTOP_SLOTS slots
  // and UPI_LAPTOP_WATTS, and it takes no place.
  var UPI_ITEMS = [
    { id: 'dns', kind: 'service', name: 'DNS filter', base: 6, income: 0.5, watts: 15 },
    { id: 'backup', kind: 'service', name: 'Backup server', base: 150, income: 5, watts: 150 },
    { id: 'photos', kind: 'service', name: 'Photo archive', base: 4500, income: 50, watts: 1500 },
    { id: 'media', kind: 'service', name: 'Media server', base: 135000, income: 500, watts: 15000 },
    { id: 'build', kind: 'service', name: 'Build farm', base: 4000000, income: 5000, watts: 150000 },
    { id: 'minipc', kind: 'hardware', name: 'Mini PC', base: 100, slots: 3, watts: 15 },
    { id: 'nas', kind: 'hardware', name: 'NAS', base: 1500, slots: 4, watts: 50 },
    { id: 'virt', kind: 'hardware', name: 'Virtualization node', base: 20000, slots: 10, watts: 300 },
    { id: 'rack', kind: 'hardware', name: 'Server rack', base: 20000, units: 16, watts: 100 },
    { id: 'raid', kind: 'upgrade', name: 'RAID mirror', levels: [1500], needs: 'nas' },
    { id: 'ups', kind: 'upgrade', name: 'UPS', levels: [4000] },
    { id: 'cooling', kind: 'upgrade', name: 'Cooling', levels: [800, 20000, 300000] }
  ];
  var UPI_START_OWNED = { dns: 1 };
  var UPI_LAPTOP_SLOTS = 2;
  var UPI_LAPTOP_WATTS = 20;
  var UPI_DESK_PLACES = 8;
  var UPI_RACK_UNITS = 16;
  var UPI_KEY_ITEMS = 9;
  // The hardware, most watts first: the order a lab that cannot earn powers
  // its machines off in (upiRepair).
  var UPI_POWER_OFF = ['virt', 'rack', 'nas', 'minipc'];

  // ── State ─────────────────────────────────────────────────────────────────

  // game: the model state (upiFreshGame).  stats: upi-stats ({ totalEarned,
  // prestiges }).
  var upiState = {
    game: null,
    stats: null
  };

  // Page handles, never saved.  rnd: the incident PRNG (its seed goes into
  // the save).  stateText: the upi-state text this tab last read or wrote,
  // so a text another tab wrote since stands out.  ticks: ticks since the
  // last save.  mark: the latest wall-clock time this tab or a save it read
  // has seen (a high-water mark: a clock set back never lowers it), the time
  // saves carry and offline time counts from.  armedAt: when the migrate
  // button was armed.  shop: the item buttons by id.
  var upiRuntime = {
    els: null,
    rnd: null,
    stateText: null,
    ticks: 0,
    interval: null,
    mark: null,
    hiddenAt: null,
    toastTimeout: null,
    confirmTimeout: null,
    confirming: false,
    armedAt: 0,
    warned: {},
    shop: {}
  };

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function upiHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function upiIsNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function upiIsCount(value) {
    return upiIsNumber(value) && value >= 0 && value % 1 === 0;
  }

  function upiClampMoney(value) {
    if (!(value > 0)) {
      return 0;
    }
    return value > UPI_MAX ? UPI_MAX : value;
  }

  function upiItem(id) {
    for (var i = 0; i < UPI_ITEMS.length; i++) {
      if (UPI_ITEMS[i].id === id) {
        return UPI_ITEMS[i];
      }
    }
    return null;
  }

  function upiPad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  // Credits and rates as 512 / 1.2k / 3.4M / 5.6B / 7.8T / 9.0Q, cut down
  // (never rounded up), so a value shown is never more than the real one.
  // Below 1000 the decimals that matter show: two below 1 (0.27, 0.08), one
  // below 100 (12.3), none above.  A value that shows as 0 has no sign.
  function upiFormat(value) {
    var n = upiIsNumber(value) ? Math.abs(value) : 0;
    var units = [[1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
    var i = 0;
    var text;
    while (i < units.length && n < units[i][0]) {
      i++;
    }
    if (i < units.length) {
      text = (Math.floor(n * 10 / units[i][0] + 1e-9) / 10).toFixed(1) + units[i][1];
    } else if (n < 1) {
      text = String(Math.floor(n * 100 + 1e-9) / 100);
    } else if (n < 100) {
      text = String(Math.floor(n * 10 + 1e-9) / 10);
    } else {
      text = String(Math.floor(n + 1e-9));
    }
    return value < 0 && text !== '0' ? '-' + text : text;
  }

  // A length of time as 45s / 3m 05s / 2h 05m / 3d 04h (whole units, cut down).
  function upiFormatDuration(ms) {
    var s = Math.floor(Math.max(0, upiIsNumber(ms) ? ms : 0) / 1000);
    if (s < 60) {
      return s + 's';
    }
    if (s < 3600) {
      return Math.floor(s / 60) + 'm ' + upiPad2(s % 60) + 's';
    }
    if (s < 86400) {
      return Math.floor(s / 3600) + 'h ' + upiPad2(Math.floor(s / 60) % 60) + 'm';
    }
    return Math.floor(s / 86400) + 'd ' + upiPad2(Math.floor(s / 3600) % 24) + 'h';
  }

  // Watts as 850 W / 15.0 kW / 1.2 MW / 3.4 GW (cut down to one decimal).
  function upiFormatWatts(watts) {
    var units = [[1e9, ' GW'], [1e6, ' MW'], [1e3, ' kW']];
    for (var i = 0; i < units.length; i++) {
      if (watts >= units[i][0]) {
        return (Math.floor(watts * 10 / units[i][0] + 1e-9) / 10).toFixed(1) + units[i][1];
      }
    }
    return watts + ' W';
  }

  // The share of the run with no outage and no failed disk, cut down to two
  // decimals: 100%, 99.87%.
  function upiFormatUptime(game) {
    return Math.floor(upiUptime(game) * 10000 + 1e-9) / 100 + '%';
  }

  // The run clock of a log line: h:mm:ss.
  function upiStamp(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 3600) + ':' + upiPad2(Math.floor(s / 60) % 60) + ':' + upiPad2(s % 60);
  }

  // A goal target: value rounded up to two significant digits (137 -> 140).
  function upiNiceCeil(value) {
    if (!(value > 0)) {
      return 0;
    }
    var unit = Math.pow(10, Math.floor(Math.log(value) / Math.LN10) - 1);
    return Math.ceil(value / unit - 1e-9) * unit;
  }

  // ── PRNG ──────────────────────────────────────────────────────────────────

  // mulberry32: a function returning numbers in [0, 1) and, through seed(),
  // its state, which the save keeps.
  function upiMulberry32(seed) {
    var a = seed >>> 0;
    function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    }
    next.seed = function () {
      return a;
    };
    return next;
  }

  // ── Economy model (no DOM, no Date) ───────────────────────────────────────

  // The price of the next copy of an item when n are owned: base x 1.15^n
  // rounded up, or the level price of an upgrade; Infinity once sold out.
  function upiCostOf(item, n) {
    if (item.levels) {
      return n < item.levels.length ? item.levels[n] : Infinity;
    }
    if (n >= UPI_MAX_COUNT) {
      return Infinity;
    }
    return Math.ceil(item.base * Math.pow(UPI_GROWTH, n) - 1e-7);
  }

  // The next session goal: earn about UPI_GOAL_SECONDS of the current net
  // income (at least UPI_GOAL_MIN_EARN), for a reward of UPI_REWARD_SECONDS
  // of it (at least UPI_REWARD_MIN).
  function upiNewGoal(game) {
    var net = Math.max(0, upiNetRate(game));
    return {
      target: upiNiceCeil(Math.max(UPI_GOAL_MIN_EARN, net * UPI_GOAL_SECONDS)),
      progress: 0,
      reward: Math.max(UPI_REWARD_MIN, Math.floor(net * UPI_REWARD_SECONDS))
    };
  }

  // A new game: the old laptop running one DNS filter, nothing earned yet.
  function upiFreshGame(seed, points) {
    var owned = {};
    UPI_ITEMS.forEach(function (item) {
      owned[item.id] = upiHasOwn(UPI_START_OWNED, item.id) ? UPI_START_OWNED[item.id] : 0;
    });
    var game = {
      credits: 0,
      owned: owned,
      event: null,
      boost: 0,
      points: points || 0,
      runEarned: 0,
      runMs: 0,
      downMs: 0,
      incidents: 0,
      goal: null,
      goalsDone: 0,
      seed: seed >>> 0
    };
    game.goal = upiNewGoal(game);
    return game;
  }

  function upiClone(game) {
    var owned = {};
    Object.keys(game.owned).forEach(function (id) {
      owned[id] = game.owned[id];
    });
    return {
      credits: game.credits,
      owned: owned,
      event: game.event ? { type: game.event.type, left: game.event.left } : null,
      boost: game.boost,
      points: game.points,
      runEarned: game.runEarned,
      runMs: game.runMs,
      downMs: game.downMs,
      incidents: game.incidents,
      goal: { target: game.goal.target, progress: game.goal.progress, reward: game.goal.reward },
      goalsDone: game.goalsDone,
      seed: game.seed
    };
  }

  function upiSlots(game) {
    var total = UPI_LAPTOP_SLOTS;
    var used = 0;
    UPI_ITEMS.forEach(function (item) {
      if (item.slots) {
        total += game.owned[item.id] * item.slots;
      } else if (item.kind === 'service') {
        used += game.owned[item.id];
      }
    });
    return { total: total, used: used, free: Math.max(0, total - used) };
  }

  // Places for machines: the desk's and the racks'; every mini PC, NAS and
  // virtualization node takes one.
  function upiPlaces(game) {
    var used = 0;
    UPI_ITEMS.forEach(function (item) {
      if (item.slots) {
        used += game.owned[item.id];
      }
    });
    var total = UPI_DESK_PLACES + game.owned.rack * UPI_RACK_UNITS;
    return { total: total, used: used, free: Math.max(0, total - used) };
  }

  function upiWatts(game) {
    var watts = UPI_LAPTOP_WATTS;
    UPI_ITEMS.forEach(function (item) {
      if (item.watts) {
        watts += game.owned[item.id] * item.watts;
      }
    });
    return watts;
  }

  function upiPue(game) {
    return UPI_PUE[game.owned.cooling];
  }

  function upiMultiplier(game) {
    return 1 + game.points * UPI_POINT_BONUS;
  }

  function upiIsDown(game, type) {
    return !!game.event && game.event.type === type;
  }

  // Income per second before the power bill, with the rack points, a kernel
  // boost, a failed disk and an outage applied.  At most 150 of each service
  // and UPI_MAX_POINTS rack points keep it below 3e13 cr/s.
  function upiGrossRate(game) {
    if (upiIsDown(game, 'outage')) {
      return 0;
    }
    var base = 0;
    UPI_ITEMS.forEach(function (item) {
      if (item.kind === 'service') {
        base += game.owned[item.id] * item.income;
      }
    });
    return base * upiMultiplier(game) * (game.boost > 0 ? UPI_BOOST : 1) * (upiIsDown(game, 'disk') ? UPI_DISK_FACTOR : 1);
  }

  // The power bill per second: watts x PUE x hours x price per kWh / 1000;
  // nothing while the power is out.
  function upiPowerRate(game) {
    if (upiIsDown(game, 'outage')) {
      return 0;
    }
    return upiWatts(game) * upiPue(game) * UPI_HOURS_PER_SECOND * UPI_KWH_PRICE / 1000;
  }

  function upiNetRate(game) {
    return upiGrossRate(game) - upiPowerRate(game);
  }

  // The net income offline time counts at: an outage and a kernel boost are
  // over by then, a failed disk still waits for you.
  function upiCalmRate(game) {
    var calm = upiClone(game);
    calm.boost = 0;
    if (calm.event && calm.event.type !== 'disk') {
      calm.event = null;
    }
    return upiNetRate(calm);
  }

  // The lab with no incident and no boost: what it earns in the long run (a
  // failed disk can always be replaced, an outage ends by itself).  Only what
  // the rates read, with its own copy of the counts.
  function upiSteady(game) {
    var owned = {};
    Object.keys(game.owned).forEach(function (id) {
      owned[id] = game.owned[id];
    });
    return { owned: owned, points: game.points, boost: 0, event: null };
  }

  function upiSteadyRate(game) {
    return upiNetRate(upiSteady(game));
  }

  // Hardware only draws power, so one more machine can push the net income
  // to 0 or below, and a lab with no income and no credits could never buy
  // the service that pays for it.  Returns the steady lab after one more of
  // item when that happens, else null.
  function upiOverdraw(game, item) {
    if (item.kind !== 'hardware') {
      return null;
    }
    var after = upiSteady(game);
    after.owned[item.id]++;
    return upiNetRate(after) > 0 ? null : after;
  }

  // A lab that cannot earn even without incidents (only a damaged or edited
  // save holds one: upiBuy never makes one) gets its DNS filter back when it
  // runs no service at all, and powers hardware off, most watts first, until
  // it earns.  One service and the laptop always earn, so this ends with a
  // playable lab.  Changes game in place.
  function upiRepair(game) {
    if (upiSteadyRate(game) <= 0 && upiSlots(game).used === 0) {
      game.owned.dns = 1;
    }
    for (var i = 0; i < UPI_POWER_OFF.length; i++) {
      while (game.owned[UPI_POWER_OFF[i]] > 0 && upiSteadyRate(game) <= 0) {
        game.owned[UPI_POWER_OFF[i]]--;
      }
    }
    return game;
  }

  function upiUptime(game) {
    return game.runMs > 0 ? (game.runMs - game.downMs) / game.runMs : 1;
  }

  // Rack points a migration would give now (0 below UPI_PRESTIGE_MIN).
  function upiPrestigePoints(game) {
    if (game.runEarned < UPI_PRESTIGE_MIN) {
      return 0;
    }
    return Math.floor(10 * Math.sqrt(game.runEarned / UPI_PRESTIGE_MIN) + 1e-9);
  }

  // A goal whose progress reached its target pays its reward, and the next
  // goal starts.  Returns whether it did.
  function upiCheckGoal(game) {
    var goal = game.goal;
    if (goal.progress < goal.target) {
      return false;
    }
    game.credits = upiClampMoney(game.credits + goal.reward);
    game.runEarned = upiClampMoney(game.runEarned + goal.reward);
    game.goalsDone++;
    game.goal = upiNewGoal(game);
    return true;
  }

  // One fixed step of dtMs of play: the income minus the power bill is
  // added (credits never go below 0 or above Number.MAX_SAFE_INTEGER),
  // timed incidents and the boost run down, the run's clock and downtime
  // grow, and the goal moves on.  Returns a new state.
  function upiTick(state, dtMs) {
    var game = upiClone(state);
    var dt = dtMs / 1000;
    var gain = upiNetRate(game) * dt;
    var down = upiIsDown(game, 'outage') || upiIsDown(game, 'disk');
    game.credits = upiClampMoney(game.credits + gain);
    if (gain > 0) {
      game.runEarned = upiClampMoney(game.runEarned + gain);
      game.goal.progress = Math.min(game.goal.target, game.goal.progress + gain);
    }
    game.runMs = Math.min(UPI_MAX, game.runMs + dtMs);
    if (down) {
      game.downMs = Math.min(game.runMs, game.downMs + dtMs);
    }
    game.boost = Math.max(0, game.boost - dtMs);
    if (game.event && game.event.type !== 'disk') {
      game.event.left -= dtMs;
      if (game.event.left <= 0) {
        game.event = null;
      }
    }
    upiCheckGoal(game);
    return game;
  }

  // Offline time that counts: never negative, at most the cap.
  function upiOfflineCounted(elapsedMs) {
    if (!upiIsNumber(elapsedMs) || elapsedMs <= 0) {
      return 0;
    }
    return Math.min(elapsedMs, UPI_OFFLINE_CAP_MS);
  }

  // Credits earned while away for elapsedMs, at the calm net income, capped
  // at 8 h; nothing for a negative income or a clock that went back.
  function upiOfflineGain(state, elapsedMs) {
    var counted = upiOfflineCounted(elapsedMs);
    var rate = Math.max(0, upiCalmRate(state));
    return Math.min(upiClampMoney(rate * counted / 1000), UPI_MAX - state.credits);
  }

  // The state after elapsedMs away: the offline gain added, the run's clock
  // moved on by the time counted, and an outage, a kernel offer or a boost
  // that ran out meanwhile gone.  Returns a new state.
  function upiApplyOffline(state, elapsedMs) {
    var game = upiClone(state);
    var counted = upiOfflineCounted(elapsedMs);
    var gain = upiOfflineGain(state, elapsedMs);
    game.credits = upiClampMoney(game.credits + gain);
    game.runEarned = upiClampMoney(game.runEarned + gain);
    game.runMs = Math.min(UPI_MAX, game.runMs + counted);
    if (upiIsDown(game, 'disk')) {
      game.downMs = Math.min(game.runMs, game.downMs + counted);
    }
    game.boost = Math.max(0, game.boost - counted);
    if (game.event && game.event.type !== 'disk') {
      game.event.left -= counted;
      if (game.event.left <= 0) {
        game.event = null;
      }
    }
    return game;
  }

  // Rolls for an incident (one rnd() draw, and one more for its kind when it
  // happens), only while none is running.  Returns { state, kind } where kind
  // is 'disk', 'disk-raid', 'outage', 'outage-ups' or 'kernel'; or null when
  // nothing happened.
  function upiApplyEvent(state, rnd) {
    if (state.event || state.runMs < UPI_EVENT_GRACE_MS || rnd() >= UPI_EVENT_CHANCE) {
      return null;
    }
    var game = upiClone(state);
    var roll = rnd();
    var kind;
    game.incidents++;
    if (roll < 0.4) {
      kind = game.owned.raid ? 'disk-raid' : 'disk';
      if (!game.owned.raid) {
        game.event = { type: 'disk', left: 0 };
      }
    } else if (roll < 0.7) {
      kind = game.owned.ups ? 'outage-ups' : 'outage';
      if (!game.owned.ups) {
        game.event = { type: 'outage', left: UPI_OUTAGE_MS };
      }
    } else {
      kind = 'kernel';
      game.event = { type: 'kernel', left: UPI_KERNEL_MS };
    }
    return { state: game, kind: kind };
  }

  // Why an item cannot be bought now, naming the values, or '' when it can.
  function upiBuyRefusal(game, item) {
    var n = game.owned[item.id];
    var cost = upiCostOf(item, n);
    if (cost === Infinity) {
      return item.levels ?
        item.name + ' is already installed' + (item.levels.length > 1 ? ' at its last level (' + item.levels.length + '/' + item.levels.length + ')' : '') + '.' :
        item.name + ' is sold out: ' + n + ' of ' + UPI_MAX_COUNT + ' owned.';
    }
    if (item.needs && !game.owned[item.needs]) {
      return item.name + ' needs a ' + upiItem(item.needs).name + ': you own 0.';
    }
    if (item.kind === 'service') {
      var slots = upiSlots(game);
      if (slots.free === 0) {
        return 'No free slot for a ' + item.name + ': ' + slots.used + '/' + slots.total + ' slots used. Buy hardware first.';
      }
    }
    if (item.slots) {
      var places = upiPlaces(game);
      if (places.free === 0) {
        return 'No room for a ' + item.name + ': ' + places.used + '/' + places.total + ' places used (the desk holds ' + UPI_DESK_PLACES +
          ', each rack ' + UPI_RACK_UNITS + '). Buy a Server rack first.';
      }
    }
    var over = upiOverdraw(game, item);
    if (over) {
      return 'A ' + item.name + ' would bring the net income to ' + upiFormat(upiNetRate(over)) + ' cr/s (income ' + upiFormat(upiGrossRate(over)) +
        ', power bill ' + upiFormat(upiPowerRate(over)) + ' cr/s without incidents): buy a service first.';
    }
    if (game.credits < cost) {
      var short = cost - game.credits;
      var net = upiNetRate(game);
      return item.name + ' costs ' + upiFormat(cost) + ' cr; you have ' + upiFormat(game.credits) + ' cr (' + upiFormat(Math.ceil(short)) + ' cr short' +
        (net > 0 ? ', about ' + upiFormatDuration(Math.ceil(short / net) * 1000) + ' at ' + upiFormat(net) + ' cr/s)' : ', and the net income is ' + upiFormat(net) + ' cr/s)') + '.';
    }
    return '';
  }

  // Buys one copy (or the next level) of the item with id.  Returns
  // { ok, state, cost, reason }: the new state when it worked, the old one
  // and the reason (upiBuyRefusal) when it did not.
  function upiBuy(state, id) {
    var item = upiItem(id);
    if (!item) {
      return { ok: false, state: state, cost: 0, reason: 'There is no item called ' + id + ' in the shop.' };
    }
    var reason = upiBuyRefusal(state, item);
    if (reason) {
      return { ok: false, state: state, cost: 0, reason: reason };
    }
    var game = upiClone(state);
    var cost = upiCostOf(item, game.owned[id]);
    game.credits = upiClampMoney(game.credits - cost);
    game.owned[id]++;
    return { ok: true, state: game, cost: cost, reason: '' };
  }

  // The incident's action: Replace disk for a failed disk, Reboot for a
  // kernel update (the boost starts).  Returns a new state, or null when
  // there is nothing to do.
  function upiResolve(state) {
    var type = state.event ? state.event.type : '';
    if (type !== 'disk' && type !== 'kernel') {
      return null;
    }
    var game = upiClone(state);
    game.event = null;
    if (type === 'kernel') {
      game.boost = UPI_BOOST_MS;
    }
    return game;
  }

  // Why the run cannot migrate yet, naming the values, or ''.
  function upiPrestigeRefusal(game) {
    var missing = [];
    if (!game.owned.rack) {
      missing.push('a Server rack (you own 0)');
    }
    if (game.runEarned < UPI_PRESTIGE_MIN) {
      missing.push(upiFormat(UPI_PRESTIGE_MIN) + ' cr earned in this run (' + upiFormat(game.runEarned) + ' so far)');
    }
    return missing.length ? 'Migrating needs ' + missing.join(' and ') + '.' : '';
  }

  // Migrate to a new rack: a fresh run with the rack points kept and the
  // ones this run earned added.  Returns { ok, state, gained, reason }.
  function upiPrestige(state) {
    var reason = upiPrestigeRefusal(state);
    if (reason) {
      return { ok: false, state: state, gained: 0, reason: reason };
    }
    var gained = upiPrestigePoints(state);
    var game = upiFreshGame(state.seed, Math.min(UPI_MAX_POINTS, state.points + gained));
    return { ok: true, state: game, gained: gained, reason: '' };
  }

  // The welcome-back line for elapsedMs away, or '' for less than a minute.
  function upiWelcomeText(elapsedMs, gain) {
    var cap = upiFormatDuration(UPI_OFFLINE_CAP_MS);
    if (!upiIsNumber(elapsedMs)) {
      return '';
    }
    if (elapsedMs <= -UPI_WELCOME_MIN_MS) {
      return 'The clock is ' + upiFormatDuration(-elapsedMs) + ' behind the last save: no time is counted until it catches up (offline progress counts up to ' + cap + ').';
    }
    if (elapsedMs < UPI_WELCOME_MIN_MS) {
      return '';
    }
    var counted = upiOfflineCounted(elapsedMs);
    var what = counted < elapsedMs ? upiFormatDuration(counted) + ' counted, the cap is ' + cap : 'all of it counted, the cap is ' + cap;
    return 'While you were away: ' + upiFormatDuration(elapsedMs) + ' (' + what + '): +' + upiFormat(gain) + ' cr.';
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function upiParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function upiIsObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function upiMoneyOr(value, fallback) {
    return upiIsNumber(value) && value >= 0 ? Math.min(value, UPI_MAX) : fallback;
  }

  function upiParseOwned(data) {
    var owned = {};
    var src = upiIsObject(data) ? data : {};
    UPI_ITEMS.forEach(function (item) {
      var max = item.levels ? item.levels.length : UPI_MAX_COUNT;
      var value = src[item.id];
      owned[item.id] = upiIsCount(value) && value <= max ? value : (upiHasOwn(UPI_START_OWNED, item.id) ? UPI_START_OWNED[item.id] : 0);
    });
    return owned;
  }

  function upiParseEvent(data) {
    if (!upiIsObject(data)) {
      return null;
    }
    var max = { disk: 0, outage: UPI_OUTAGE_MS, kernel: UPI_KERNEL_MS };
    if (!upiHasOwn(max, data.type) || !upiIsNumber(data.left) || data.left < 0 || data.left > max[data.type]) {
      return null;
    }
    if (data.type !== 'disk' && data.left === 0) {
      return null;
    }
    return { type: data.type, left: data.left };
  }

  function upiParseGoal(data) {
    if (!upiIsObject(data) || !upiIsNumber(data.target) || data.target <= 0 || data.target > UPI_MAX) {
      return null;
    }
    return {
      target: data.target,
      progress: upiIsNumber(data.progress) && data.progress >= 0 ? Math.min(data.progress, data.target) : 0,
      reward: upiMoneyOr(data.reward, UPI_REWARD_MIN)
    };
  }

  // upi-state as { ok, game, savedAt, seeded }: ok is whether the text held
  // a save at all; every field falls back on its own (seed to fallbackSeed,
  // a broken goal to a new one, savedAt to null: no offline time).
  function upiParseState(text, fallbackSeed) {
    var data = upiParseJson(text);
    var ok = upiIsObject(data);
    if (!ok) {
      data = {};
    }
    var seeded = upiIsCount(data.seed) && data.seed <= 4294967295;
    var game = {
      credits: upiMoneyOr(data.credits, 0),
      owned: upiParseOwned(data.owned),
      event: upiParseEvent(data.event),
      boost: upiIsNumber(data.boost) && data.boost >= 0 && data.boost <= UPI_BOOST_MS ? data.boost : 0,
      points: upiIsCount(data.points) && data.points <= UPI_MAX_POINTS ? data.points : 0,
      runEarned: upiMoneyOr(data.runEarned, 0),
      runMs: upiMoneyOr(data.runMs, 0),
      downMs: 0,
      incidents: upiIsCount(data.incidents) ? data.incidents : 0,
      goal: upiParseGoal(data.goal),
      goalsDone: upiIsCount(data.goalsDone) ? data.goalsDone : 0,
      seed: seeded ? data.seed : fallbackSeed >>> 0
    };
    game.downMs = Math.min(game.runMs, upiMoneyOr(data.downMs, 0));
    upiRepair(game);
    if (!game.goal) {
      game.goal = upiNewGoal(game);
    }
    return {
      ok: ok,
      game: game,
      savedAt: upiIsCount(data.savedAt) ? data.savedAt : null
    };
  }

  // upi-stats as { totalEarned, prestiges }, each field on its own.
  function upiParseStats(text) {
    var data = upiParseJson(text);
    if (!upiIsObject(data)) {
      data = {};
    }
    return {
      totalEarned: upiMoneyOr(data.totalEarned, 0),
      prestiges: upiIsCount(data.prestiges) ? data.prestiges : 0
    };
  }

  // Two upi-stats records merged field by field: the higher value wins, so
  // a second tab never lowers what another tab counted.
  function upiMergeStats(a, b) {
    return {
      totalEarned: Math.max(a.totalEarned, b.totalEarned),
      prestiges: Math.max(a.prestiges, b.prestiges)
    };
  }

  function upiSerializeState(game, savedAt) {
    var owned = {};
    UPI_ITEMS.forEach(function (item) {
      owned[item.id] = game.owned[item.id];
    });
    return JSON.stringify({
      v: UPI_SAVE_VERSION,
      credits: game.credits,
      owned: owned,
      event: game.event,
      boost: game.boost,
      points: game.points,
      runEarned: game.runEarned,
      runMs: game.runMs,
      downMs: game.downMs,
      incidents: game.incidents,
      goal: game.goal,
      goalsDone: game.goalsDone,
      seed: game.seed,
      savedAt: savedAt
    });
  }

  function upiSerializeStats(stats) {
    return JSON.stringify({ v: UPI_SAVE_VERSION, totalEarned: stats.totalEarned, prestiges: stats.prestiges });
  }

  // ── Clock and storage ─────────────────────────────────────────────────────

  // The one place the game reads the wall clock.
  function upiNow() {
    return Date.now();
  }

  // A short warning naming the key that failed, once per key.
  function upiWarnStorage(key, error) {
    if (upiRuntime.warned[key]) {
      return;
    }
    upiRuntime.warned[key] = true;
    var warning = upiRuntime.els.warning;
    var full = error.name === 'QuotaExceededError';
    warning.textContent = (full ? 'Storage is full' : 'Storage is blocked') + ' (' + error.name + '): ' + Object.keys(upiRuntime.warned).join(' and ') +
      (full ? ' could not be saved' : ' cannot be read or saved') + ', so progress here will not survive a reload.';
    warning.classList.remove('upi-hidden');
  }

  function upiStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      upiWarnStorage(key, error);
      return null;
    }
  }

  // Returns whether the write worked.
  function upiStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      upiWarnStorage(key, error);
      return false;
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function upiSetText(el, text) {
    if (el.textContent !== text) {
      el.textContent = text;
    }
  }

  function upiSetLabel(el, text) {
    if (el.getAttribute('aria-label') !== text) {
      el.setAttribute('aria-label', text);
    }
  }

  function upiMakeSpan(className, parent) {
    var span = document.createElement('span');
    span.className = className;
    parent.appendChild(span);
    return span;
  }

  // The shop buttons, built once: a key badge, the name, the count, what it
  // does and the price.
  function upiBuildShop() {
    var els = upiRuntime.els;
    var lists = { service: els.services, hardware: els.hardware, upgrade: els.upgrades };
    UPI_ITEMS.forEach(function (item, index) {
      var button = document.createElement('button');
      button.type = 'button';
      button.id = 'upi-item-' + item.id;
      button.className = 'upi-item';
      button.setAttribute('data-item', item.id);
      var top = upiMakeSpan('upi-item-top', button);
      if (index < UPI_KEY_ITEMS) {
        upiMakeSpan('upi-item-key', top).textContent = String(index + 1);
      }
      upiMakeSpan('upi-item-name', top).textContent = item.name;
      var entry = {
        button: button,
        owned: upiMakeSpan('upi-item-owned', top),
        effect: upiMakeSpan('upi-item-effect', button),
        cost: upiMakeSpan('upi-item-cost', button)
      };
      upiRuntime.shop[item.id] = entry;
      lists[item.kind].appendChild(button);
    });
  }

  function upiEffectText(game, item) {
    var n = game.owned[item.id];
    if (item.kind === 'service') {
      return '+' + upiFormat(item.income * upiMultiplier(game)) + ' cr/s · 1 slot · ' + upiFormatWatts(item.watts);
    }
    if (item.slots) {
      return '+' + item.slots + ' slots · 1 place · ' + upiFormatWatts(item.watts);
    }
    if (item.units) {
      return '+' + item.units + ' places · ' + upiFormatWatts(item.watts);
    }
    if (item.id === 'raid') {
      return 'A failed disk costs nothing';
    }
    if (item.id === 'ups') {
      return 'An outage costs nothing';
    }
    return n < item.levels.length ? 'PUE ' + UPI_PUE[n] + ' → ' + UPI_PUE[n + 1] : 'PUE ' + UPI_PUE[n] + ', the last level';
  }

  function upiOwnedText(game, item) {
    var n = game.owned[item.id];
    if (!item.levels) {
      return '×' + n;
    }
    return item.levels.length > 1 ? n + '/' + item.levels.length : (n ? 'on' : 'off');
  }

  function upiOwnedLabel(game, item) {
    var n = game.owned[item.id];
    if (!item.levels) {
      return 'you own ' + n;
    }
    return item.levels.length > 1 ? 'level ' + n + ' of ' + item.levels.length : (n ? 'installed' : 'not installed');
  }

  // Whether an item that is not sold out waits for something else first: a
  // NAS for the RAID mirror, a free slot for a service, a free place for a
  // machine.
  function upiBlocked(game, item) {
    if (item.needs && !game.owned[item.needs]) {
      return true;
    }
    if (item.kind === 'service') {
      return upiSlots(game).free === 0;
    }
    return (!!item.slots && upiPlaces(game).free === 0) || !!upiOverdraw(game, item);
  }

  function upiRenderShop(game) {
    UPI_ITEMS.forEach(function (item, index) {
      var entry = upiRuntime.shop[item.id];
      var cost = upiCostOf(item, game.owned[item.id]);
      var done = cost === Infinity;
      var blocked = !done && upiBlocked(game, item);
      var costText = done ? (item.levels ? 'Installed' : 'Sold out') : upiFormat(cost) + ' cr';
      upiSetText(entry.owned, upiOwnedText(game, item));
      upiSetText(entry.effect, upiEffectText(game, item));
      upiSetText(entry.cost, costText);
      entry.button.classList.toggle('upi-item--done', done);
      entry.button.classList.toggle('upi-item--blocked', blocked);
      entry.button.classList.toggle('upi-item--short', !done && !blocked && game.credits < cost);
      upiSetLabel(entry.button, (index < UPI_KEY_ITEMS ? 'Key ' + (index + 1) + ': ' : '') + item.name + ', ' +
        (done ? costText.toLowerCase() : 'buy for ' + costText) + '; ' + upiOwnedLabel(game, item) + '; ' + upiEffectText(game, item));
    });
  }

  function upiGoalText(goal) {
    return 'Earn ' + upiFormat(goal.target) + ' cr';
  }

  function upiRenderGoal(game) {
    var els = upiRuntime.els;
    var goal = game.goal;
    var share = goal.progress / goal.target;
    var percent = Math.floor(share * 100);
    upiSetText(els.goalText, upiGoalText(goal));
    upiSetText(els.goalReward, 'Reward +' + upiFormat(goal.reward) + ' cr');
    upiSetText(els.goalProgress, upiFormat(goal.progress) + ' / ' + upiFormat(goal.target) + ' cr · ' + percent + '%');
    els.goalFill.style.width = percent + '%';
    els.goalBar.setAttribute('aria-valuenow', String(percent));
  }

  function upiRenderIncident(game) {
    var els = upiRuntime.els;
    var event = game.event;
    var text = 'All systems nominal. Incidents: ' + game.incidents + '.';
    var action = '';
    var label = 'Nothing to do';
    if (event && event.type === 'disk') {
      text = 'Disk failure: income is halved until the disk is replaced. A RAID mirror makes this harmless.';
      action = 'Replace disk';
      label = 'Replace disk: income is halved until then';
    } else if (event && event.type === 'outage') {
      text = 'Power outage: no income for ' + Math.ceil(event.left / 1000) + ' s. A UPS rides these out.';
    } else if (event) {
      text = 'Kernel update available for ' + Math.ceil(event.left / 1000) + ' s: reboot for +50% income for 60 s.';
      action = 'Reboot';
      label = 'Reboot: +50% income for 60 s, offer open for ' + Math.ceil(event.left / 1000) + ' s';
    } else if (game.boost > 0) {
      text = 'New kernel: +50% income for ' + Math.ceil(game.boost / 1000) + ' s.';
    }
    upiSetText(els.incidentText, text);
    els.incident.className = 'upi-incident' + (event ? ' upi-incident--' + event.type : '');
    upiSetText(els.incidentAction, action || 'Nothing to do');
    upiSetLabel(els.incidentAction, label);
    els.incidentAction.classList.toggle('upi-hidden', !action);
  }

  function upiRenderMigrate(game) {
    var els = upiRuntime.els;
    var reason = upiPrestigeRefusal(game);
    var text;
    if (reason) {
      text = reason + ' Rack points now: ' + game.points + ' (×' + upiMultiplier(game).toFixed(2) + ' income).';
    } else {
      var points = upiPrestigePoints(game);
      text = 'Ready: migrating adds ' + points + ' rack points (×' + upiMultiplier(game).toFixed(2) + ' → ×' +
        (1 + (game.points + points) * UPI_POINT_BONUS).toFixed(2) + ' income); everything else starts over.';
    }
    upiSetText(els.migrateText, text);
    upiSetText(els.migrate, upiRuntime.confirming ? 'Press again to migrate' : 'Migrate to a new rack');
    upiSetLabel(els.migrate, upiRuntime.confirming ?
      'Press again to migrate: the run starts over for +' + upiPrestigePoints(game) + ' rack points' :
      'Migrate to a new rack: start over with a permanent income bonus');
    els.migrate.classList.toggle('upi-btn--armed', upiRuntime.confirming);
    els.migrate.classList.toggle('upi-btn--ready', !reason);
  }

  function upiRender() {
    var els = upiRuntime.els;
    var game = upiState.game;
    var slots = upiSlots(game);
    var places = upiPlaces(game);
    var gross = upiGrossRate(game);
    var power = upiPowerRate(game);
    var net = gross - power;
    var watts = upiWatts(game);
    upiSetText(els.credits, upiFormat(game.credits) + ' cr');
    upiSetText(els.net, (net >= 0 ? '+' : '') + upiFormat(net) + ' cr/s');
    els.net.classList.toggle('upi-stat-value--bad', net < 0);
    upiSetText(els.power, upiFormatWatts(watts));
    upiSetText(els.uptime, upiFormatUptime(game));
    upiSetText(els.slots, slots.used + '/' + slots.total);
    upiSetText(els.places, places.used + '/' + places.total);
    upiSetText(els.mult, '×' + upiMultiplier(game).toFixed(2));
    upiSetText(els.breakdown, 'Income ' + upiFormat(gross) + ' cr/s, power bill ' + upiFormat(power) + ' cr/s: ' + upiFormatWatts(watts) +
      ' × PUE ' + upiPue(game) + ' × ' + UPI_KWH_PRICE + ' cr per kWh, each second of play billed as one hour.');
    upiSetText(els.lifetime, 'Lifetime: ' + upiFormat(upiState.stats.totalEarned) + ' cr earned, ' + upiState.stats.prestiges +
      ' migration' + (upiState.stats.prestiges === 1 ? '' : 's') + '.');
    upiRenderGoal(game);
    upiRenderIncident(game);
    upiRenderShop(game);
    upiRenderMigrate(game);
  }

  // A line in the log, stamped with the run's clock; the oldest of more than
  // UPI_LOG_LINES goes.
  function upiLog(text) {
    var li = document.createElement('li');
    li.className = 'upi-log-line';
    li.textContent = '[' + upiStamp(upiState.game.runMs) + '] ' + text;
    var list = upiRuntime.els.log;
    list.appendChild(li);
    if (list.children.length > UPI_LOG_LINES) {
      list.removeChild(list.children[0]);
    }
  }

  function upiHideToast() {
    upiRuntime.toastTimeout = null;
    upiRuntime.els.toast.classList.remove('upi-show');
  }

  // Shows message for UPI_TOAST_MS; a newer toast gets its full time.
  function upiShowToast(message) {
    var toast = upiRuntime.els.toast;
    clearTimeout(upiRuntime.toastTimeout);
    toast.textContent = message;
    toast.classList.add('upi-show');
    upiRuntime.toastTimeout = setTimeout(upiHideToast, UPI_TOAST_MS);
  }

  function upiShowWelcome(text) {
    var welcome = upiRuntime.els.welcome;
    welcome.textContent = text;
    welcome.classList.toggle('upi-hidden', !text);
  }

  // ── Saving and other tabs ─────────────────────────────────────────────────

  // The time a save carries and offline time counts from: the wall clock,
  // but never earlier than any time seen before.  A clock set forwards and
  // back again would otherwise pay the 8 h cap on every round trip; with the
  // mark, offline time counts again only once the clock passes it.
  function upiMarkNow() {
    var now = upiNow();
    if (upiRuntime.mark === null || now > upiRuntime.mark) {
      upiRuntime.mark = now;
    }
    return upiRuntime.mark;
  }

  // A save's time (another tab's mark) raises this tab's mark.
  function upiTakeMark(savedAt) {
    if (savedAt !== null && (upiRuntime.mark === null || savedAt > upiRuntime.mark)) {
      upiRuntime.mark = savedAt;
    }
  }

  // Whether two labs differ in something a player did (a purchase, a
  // migration), not only in the seconds of income two open tabs both tick.
  function upiPlayerChanged(a, b) {
    if (a.points !== b.points) {
      return true;
    }
    for (var i = 0; i < UPI_ITEMS.length; i++) {
      if (a.owned[UPI_ITEMS[i].id] !== b.owned[UPI_ITEMS[i].id]) {
        return true;
      }
    }
    return false;
  }

  // Takes over the upi-state text another tab wrote: the offline time since
  // that tab saved counts, and upi-stats is merged.  Writes nothing, so two
  // tabs never answer each other's writes.  The lab is now up to date, so a
  // hidden tab counts its time away from here when it is shown.  A pending
  // migrate confirmation stays unless the other tab bought or migrated.
  // Returns whether it did.
  function upiAdopt(text) {
    var parsed = upiParseState(text, upiState.game.seed);
    var changed = upiPlayerChanged(upiState.game, parsed.game);
    var now = upiNow();
    upiRuntime.stateText = text;
    upiTakeMark(parsed.savedAt);
    upiRuntime.hiddenAt = upiMarkNow();
    upiState.game = parsed.savedAt === null ? parsed.game : upiApplyOffline(parsed.game, now - parsed.savedAt);
    upiRuntime.rnd = upiMulberry32(upiState.game.seed);
    upiState.stats = upiMergeStats(upiState.stats, upiParseStats(upiStorageGet(UPI_STATS_KEY)));
    upiCountEarned(parsed.game, upiState.game);
    if (changed) {
      upiDisarm();
    }
    upiRender();
    return changed;
  }

  // Reads upi-state again; a save another tab wrote since this tab last read
  // or wrote it is taken over, with a toast when that tab bought or migrated
  // (two open tabs take over each other's routine saves every few seconds,
  // silently).  Returns whether a save was taken over.
  function upiSync() {
    var text = upiStorageGet(UPI_STATE_KEY);
    if (text === null || text === upiRuntime.stateText || !upiParseState(text, 0).ok) {
      return false;
    }
    if (upiAdopt(text)) {
      upiShowToast('Another tab saved newer progress: it is shown here.');
    }
    return true;
  }

  // Writes upi-state and upi-stats, unless another tab saved newer progress:
  // that is taken over instead.
  function upiSave() {
    upiRuntime.ticks = 0;
    if (upiSync()) {
      return;
    }
    upiState.game.seed = upiRuntime.rnd.seed();
    var text = upiSerializeState(upiState.game, upiMarkNow());
    if (upiStorageSet(UPI_STATE_KEY, text)) {
      upiRuntime.stateText = text;
    }
    upiState.stats = upiMergeStats(upiState.stats, upiParseStats(upiStorageGet(UPI_STATS_KEY)));
    upiStorageSet(UPI_STATS_KEY, upiSerializeStats(upiState.stats));
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  var UPI_INCIDENT_LINES = {
    disk: 'A disk failed: income halved until it is replaced.',
    'disk-raid': 'A disk failed; the RAID mirror rebuilt it. Nothing lost.',
    outage: 'Power outage: no income for 30 s.',
    'outage-ups': 'Power outage; the UPS carried the load. Nothing lost.',
    kernel: 'Kernel update available: reboot within 60 s for +50% income.'
  };

  // Credits added to the game also count in the lifetime total.
  function upiCountEarned(before, after) {
    var earned = after.runEarned - before.runEarned;
    if (earned > 0) {
      upiState.stats.totalEarned = upiClampMoney(upiState.stats.totalEarned + earned);
    }
  }

  // One tick on the page: the model's step, a roll for an incident, and a
  // log line for a goal reached, an incident over or a new one.  A tick that
  // comes much later than the last one (the computer slept with the tab
  // open: no visibilitychange fires for that) counts the gap as offline
  // time first, in one sum, and saves; then the one fixed step runs as
  // always, so a gap never replays ticks.
  function upiTickPage() {
    var last = upiRuntime.mark;
    if (upiNow() - last > UPI_SLEEP_MS) {
      upiWelcomeBack(last + UPI_TICK_MS);
      upiRuntime.ticks = UPI_SAVE_EVERY;
    }
    upiMarkNow();
    var before = upiState.game;
    var after = upiTick(before, UPI_TICK_MS);
    var roll = upiApplyEvent(after, upiRuntime.rnd);
    upiCountEarned(before, after);
    if (after.goalsDone > before.goalsDone) {
      upiLog('Session goal reached: +' + upiFormat(before.goal.reward) + ' cr. Next: ' + upiGoalText(after.goal) + '.');
      upiShowToast('Session goal reached: +' + upiFormat(before.goal.reward) + ' cr');
    }
    if (before.event && !after.event) {
      upiLog(before.event.type === 'outage' ? 'Power is back.' : 'The kernel update offer ran out.');
    }
    upiState.game = roll ? roll.state : after;
    if (roll) {
      upiLog(UPI_INCIDENT_LINES[roll.kind]);
    }
    upiRuntime.ticks++;
    if (upiRuntime.ticks >= UPI_SAVE_EVERY) {
      upiSave();
    }
    upiRender();
  }

  function upiStartTicks() {
    if (upiRuntime.interval === null) {
      upiRuntime.interval = setInterval(upiTickPage, UPI_TICK_MS);
    }
  }

  function upiStopTicks() {
    clearInterval(upiRuntime.interval);
    upiRuntime.interval = null;
  }

  // An action: another tab's newer save is taken over first, then run(game)
  // acts on what is on screen and the result is saved at once.
  function upiAct(run) {
    upiSync();
    run(upiState.game);
    upiSave();
    upiRender();
  }

  function upiBuyItem(id) {
    upiAct(function (before) {
      var result = upiBuy(before, id);
      if (!result.ok) {
        upiShowToast(result.reason);
        return;
      }
      upiState.game = result.state;
      var item = upiItem(id);
      upiLog('Bought ' + item.name + (item.levels && item.levels.length > 1 ? ' level ' + result.state.owned[id] : ' #' + result.state.owned[id]) +
        ' for ' + upiFormat(result.cost) + ' cr.');
    });
  }

  function upiHandleIncident() {
    upiAct(function (before) {
      var after = upiResolve(before);
      if (!after) {
        return;
      }
      upiState.game = after;
      upiLog(before.event.type === 'disk' ? 'Disk replaced: income is back to full.' : 'Rebooted into the new kernel: +50% income for 60 s.');
    });
  }

  function upiDisarm() {
    clearTimeout(upiRuntime.confirmTimeout);
    upiRuntime.confirmTimeout = null;
    upiRuntime.confirming = false;
    upiRenderMigrate(upiState.game);
  }

  // Migrating asks for a second press within UPI_CONFIRM_MS, and at least
  // UPI_CONFIRM_GAP_MS after the first: a double click or a double tap is
  // one press.
  function upiHandleMigrate() {
    upiSync();
    var game = upiState.game;
    var reason = upiPrestigeRefusal(game);
    if (reason) {
      upiDisarm();
      upiShowToast(reason);
      return;
    }
    if (upiRuntime.confirming && upiNow() - upiRuntime.armedAt < UPI_CONFIRM_GAP_MS) {
      return;
    }
    if (!upiRuntime.confirming) {
      upiRuntime.confirming = true;
      upiRuntime.armedAt = upiNow();
      upiRuntime.confirmTimeout = setTimeout(upiDisarm, UPI_CONFIRM_MS);
      upiRenderMigrate(game);
      upiShowToast('Press again within 4 s to migrate: +' + upiPrestigePoints(game) + ' rack points, everything else starts over.');
      return;
    }
    upiDisarm();
    upiAct(function (before) {
      var result = upiPrestige(before);
      upiState.game = result.state;
      upiState.stats.prestiges++;
      upiRuntime.rnd = upiMulberry32(result.state.seed);
      upiLog('Migrated to a new rack: +' + result.gained + ' rack points, ×' + upiMultiplier(result.state).toFixed(2) + ' income from now on.');
      upiShowToast('Migrated: ×' + upiMultiplier(result.state).toFixed(2) + ' income');
    });
  }

  // Counts the time since savedAt as offline progress and shows the
  // welcome-back line for it.
  function upiWelcomeBack(savedAt) {
    if (savedAt === null) {
      upiShowWelcome('');
      return;
    }
    var elapsed = upiNow() - savedAt;
    var before = upiState.game;
    var gain = upiOfflineGain(before, elapsed);
    upiState.game = upiApplyOffline(before, elapsed);
    upiCountEarned(before, upiState.game);
    var text = upiWelcomeText(elapsed, gain);
    upiShowWelcome(text);
    if (text) {
      upiLog(text);
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // The shop index (0-8) of a keydown, or -1: the digits 1-9 by value, or
  // by the physical key (Digit1-Digit9) on layouts whose top row has other
  // characters without Shift.
  function upiKeySlot(event) {
    if (typeof event.key === 'string' && /^[1-9]$/.test(event.key)) {
      return Number(event.key) - 1;
    }
    var m = /^Digit([1-9])$/.exec(String(event.code));
    return m && !event.shiftKey ? Number(m[1]) - 1 : -1;
  }

  // Keys reach this listener only while the focus is inside the game.
  // Enter and Space on a game button are the browser's own click, once per
  // press: a held key's repeats would click again (buy 30 a second, or arm
  // and confirm a migration), so they are stopped.
  function upiHandleKeydown(event) {
    if (event.defaultPrevented) {
      return;
    }
    if (event.repeat && (event.key === 'Enter' || event.key === ' ') && event.target.closest('button')) {
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
      return;
    }
    if (event.target.closest('input, textarea, select, [contenteditable]')) {
      return;
    }
    var slot = upiKeySlot(event);
    if (slot === -1) {
      return;
    }
    event.preventDefault();
    if (!event.repeat) {
      upiBuyItem(UPI_ITEMS[slot].id);
    }
  }

  function upiHandleShopClick(event) {
    var button = event.target.closest('.upi-item');
    if (button) {
      upiBuyItem(button.getAttribute('data-item'));
    }
  }

  // A hidden tab stops ticking and saves; shown again, the hidden time
  // counts as offline progress (another tab's newer save first), in one sum.
  function upiHandleVisibility() {
    if (document.hidden) {
      if (upiRuntime.interval !== null) {
        upiStopTicks();
        upiRuntime.hiddenAt = upiMarkNow();
        upiSave();
      }
      return;
    }
    if (upiRuntime.interval !== null) {
      return;
    }
    var text = upiStorageGet(UPI_STATE_KEY);
    var parsed = upiParseState(text, upiState.game.seed);
    var adopt = text !== null && text !== upiRuntime.stateText && parsed.ok;
    if (adopt) {
      upiRuntime.stateText = text;
      upiTakeMark(parsed.savedAt);
      upiState.game = parsed.game;
      upiRuntime.rnd = upiMulberry32(parsed.game.seed);
      upiState.stats = upiMergeStats(upiState.stats, upiParseStats(upiStorageGet(UPI_STATS_KEY)));
    }
    upiWelcomeBack(adopt ? parsed.savedAt : upiRuntime.hiddenAt);
    upiSave();
    upiStartTicks();
    upiRender();
  }

  // Another tab wrote upi-state: its progress is taken over at once.
  function upiHandleStorage(event) {
    if (event.key === UPI_STATE_KEY) {
      upiSync();
    } else if (event.key === UPI_STATS_KEY) {
      upiState.stats = upiMergeStats(upiState.stats, upiParseStats(event.newValue));
      upiRender();
    }
  }

  function upiBindEvents() {
    var els = upiRuntime.els;
    els.root.addEventListener('keydown', upiHandleKeydown);
    els.services.addEventListener('click', upiHandleShopClick);
    els.hardware.addEventListener('click', upiHandleShopClick);
    els.upgrades.addEventListener('click', upiHandleShopClick);
    els.incidentAction.addEventListener('click', upiHandleIncident);
    els.migrate.addEventListener('click', upiHandleMigrate);
    document.addEventListener('visibilitychange', upiHandleVisibility);
    window.addEventListener('storage', upiHandleStorage);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function upiFindElements() {
    return {
      root: document.getElementById('upi-root'),
      credits: document.getElementById('upi-credits'),
      net: document.getElementById('upi-net'),
      power: document.getElementById('upi-power'),
      uptime: document.getElementById('upi-uptime'),
      slots: document.getElementById('upi-slots'),
      places: document.getElementById('upi-places'),
      mult: document.getElementById('upi-mult'),
      breakdown: document.getElementById('upi-breakdown'),
      lifetime: document.getElementById('upi-lifetime'),
      goalText: document.getElementById('upi-goal-text'),
      goalReward: document.getElementById('upi-goal-reward'),
      goalBar: document.getElementById('upi-goal-bar'),
      goalFill: document.getElementById('upi-goal-fill'),
      goalProgress: document.getElementById('upi-goal-progress'),
      incident: document.getElementById('upi-incident'),
      incidentText: document.getElementById('upi-incident-text'),
      incidentAction: document.getElementById('upi-incident-action'),
      services: document.getElementById('upi-services'),
      hardware: document.getElementById('upi-hardware'),
      upgrades: document.getElementById('upi-upgrades'),
      migrateText: document.getElementById('upi-migrate-text'),
      migrate: document.getElementById('upi-migrate'),
      log: document.getElementById('upi-log'),
      welcome: document.getElementById('upi-welcome'),
      warning: document.getElementById('upi-warning'),
      toast: document.getElementById('upi-toast')
    };
  }

  // Finds the elements, builds the shop and binds the controls once,
  // restores the saves with the offline time since the last one, and starts
  // ticking (unless the tab is hidden).
  function upiInit() {
    if (upiRuntime.els) {
      return;
    }
    upiRuntime.els = upiFindElements();
    upiBuildShop();
    upiBindEvents();
    upiState.stats = upiParseStats(upiStorageGet(UPI_STATS_KEY));
    var text = upiStorageGet(UPI_STATE_KEY);
    var parsed = upiParseState(text, Math.floor(Math.random() * 4294967296));
    upiRuntime.stateText = text;
    upiTakeMark(parsed.savedAt);
    upiState.game = parsed.game;
    upiRuntime.rnd = upiMulberry32(parsed.game.seed);
    if (parsed.ok) {
      upiWelcomeBack(parsed.savedAt);
    } else {
      upiLog('Old laptop booted under the desk: DNS filter running.');
    }
    upiSave();
    upiRender();
    if (document.hidden) {
      upiRuntime.hiddenAt = upiMarkNow();
    } else {
      upiStartTicks();
    }
  }

  // Node (tests): export only, no init and no timers.  Browser: init once the
  // markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      upiState: upiState,
      upiRuntime: upiRuntime,
      upiInit: upiInit,
      UPI_ITEMS: UPI_ITEMS,
      UPI_TICK_MS: UPI_TICK_MS,
      UPI_OFFLINE_CAP_MS: UPI_OFFLINE_CAP_MS,
      UPI_PRESTIGE_MIN: UPI_PRESTIGE_MIN,
      upiFormat: upiFormat,
      upiFormatDuration: upiFormatDuration,
      upiFormatWatts: upiFormatWatts,
      upiNiceCeil: upiNiceCeil,
      upiMulberry32: upiMulberry32,
      upiCostOf: upiCostOf,
      upiItem: upiItem,
      upiFreshGame: upiFreshGame,
      upiNewGoal: upiNewGoal,
      upiSlots: upiSlots,
      upiPlaces: upiPlaces,
      upiWatts: upiWatts,
      upiPue: upiPue,
      upiMultiplier: upiMultiplier,
      upiGrossRate: upiGrossRate,
      upiPowerRate: upiPowerRate,
      upiNetRate: upiNetRate,
      upiCalmRate: upiCalmRate,
      upiSteadyRate: upiSteadyRate,
      upiRepair: upiRepair,
      upiUptime: upiUptime,
      upiTick: upiTick,
      upiOfflineCounted: upiOfflineCounted,
      upiOfflineGain: upiOfflineGain,
      upiApplyOffline: upiApplyOffline,
      upiApplyEvent: upiApplyEvent,
      upiBuy: upiBuy,
      upiResolve: upiResolve,
      upiPrestigePoints: upiPrestigePoints,
      upiPrestige: upiPrestige,
      upiWelcomeText: upiWelcomeText,
      upiKeySlot: upiKeySlot,
      upiParseState: upiParseState,
      upiParseStats: upiParseStats,
      upiMergeStats: upiMergeStats,
      upiSerializeState: upiSerializeState
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', upiInit);
  } else {
    upiInit();
  }
})();
