// ── ui-text: the page's words and numbers: times, kits, upgrade effects, the death line, the storage warning, the guide's numbers ──
// Owns CDA_UI (the fixed lines of the page), CDA_KILLERS, cdaFormatTime,
// cdaNum, cdaKitText, cdaUpgradeEffect, cdaUpgradeState, cdaDeathLine,
// cdaStorageText, CDA_GUIDE_NUMBERS and cdaGuideNumber.  Pure: no DOM, no
// clock.  Uses core (CDA_STEP, CDA_DEG), tables (CDA_PLAYER, CDA_TOOL,
// CDA_ENEMY, CDA_ITEM, CDA_UPGRADES, CDA_UPGRADE, CDA_REWARDS, CDA_BOSS),
// levels (CDA_LEVELS) and storage (CDA_SAVE_V, cdaPatchBalance,
// cdaUpgradeNext); the later ui parts call it.
//
// The player reads distances in tiles (the code's cells): "cells" on the
// page are the probe's ammo only.
// Every number the page and the How to play guide show is read from the
// tables here, so a retune never leaves a wrong number on the page: the
// guide's markup holds empty spans with data-cda-num="<key>", and ui-guide
// fills each with cdaGuideNumber(key).

var CDA_UI = {
  locked: 'Locked',
  notWon: 'Not cleared yet',
  noLock: 'No mouse capture here: the mouse turns the view while it is inside the frame, and its edges keep turning.',
  lockRefused: 'Mouse capture was refused: the mouse still turns the view inside the frame; click the view to capture it again.',
  lowHealth: 'Health low',
  soundOn: 'Sound on',
  soundOff: 'Sound off',
  mapOn: 'Map',
  newGame: 'Start a new game? This erases your progress in this browser: ',
  leave: 'Leave this level? Its progress is lost.',
  deathTitle: 'Session terminated',
  toBeContinued: 'To be continued in episode 2.',
  topTier: 'Top tier reached',
  noPatches: 'Needs {cost} patches, you have {have}'
};

// Who the death line names, by the `by` of the last hurt event: an enemy
// kind or a projectile kind.
var CDA_KILLERS = { spark: 'drone', bolt: 'turret', frost: 'chiller' };

// Seconds as m:ss (h:mm:ss from an hour on); null or not a number: a dash.
function cdaFormatTime(seconds) {
  if (typeof seconds !== 'number' || !(seconds >= 0)) return '–';
  var s = Math.floor(seconds);
  var h = Math.floor(s / 3600);
  var m = Math.floor(s / 60) % 60;
  var ss = s % 60;
  var mm = h > 0 && m < 10 ? '0' + m : String(m);
  return (h > 0 ? h + ':' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
}

// A number for a reader: at most two decimals, no trailing zeros.
function cdaNum(value) {
  return String(Math.round(value * 100) / 100);
}

// What a carried state holds, in one line: 'Screwdriver, Tone probe; 40
// cells, 0 coils' (the ammo of the tools held only).
function cdaKitText(carry) {
  var names = [];
  var ammo = [];
  for (var i = 0; i < carry.tools.length; i++) {
    var tool = CDA_TOOL[carry.tools[i]];
    names.push(tool.name);
    if (tool.ammo) ammo.push(carry.ammo[tool.ammo] + ' ' + tool.ammo + 's');
  }
  return names.join(', ') + (ammo.length ? '; ' + ammo.join(', ') : '');
}

// What `tiers` tiers of upgrade line `id` add, as a phrase ('+30 max health').
function cdaUpgradeEffect(id, tiers) {
  var v = CDA_UPGRADE[id].step * tiers;
  if (id === 'health') return '+' + cdaNum(v) + ' max health';
  if (id === 'cells') return '+' + cdaNum(v) + ' cell capacity';
  if (id === 'probeDamage') return '+' + cdaNum(v) + ' probe damage';
  if (id === 'probeSpeed') return 'probe cooldown -' + cdaNum(v * 100) + ' %';
  if (id === 'rays') return '+' + cdaNum(v) + ' degausser ray' + (v === 1 ? '' : 's');
  return '+' + cdaNum(v) + ' tiles of flashlight';
}

// One upgrade line as the upgrades screen shows it: { id, name, tiers, top
// (its tier count), now (the effect owned, or 'none yet'), next (the next
// tier's effect, or ''), cost (0 at the top), can (it can be bought now),
// why (why not, or '') }.
function cdaUpgradeState(save, id) {
  var line = CDA_UPGRADE[id];
  var tiers = save.upgrades[id] || 0;
  var next = cdaUpgradeNext(save, id);
  var have = cdaPatchBalance(save);
  var why = '';
  if (!next) why = CDA_UI.topTier;
  else if (next.cost > have) why = CDA_UI.noPatches.replace('{cost}', String(next.cost)).replace('{have}', String(have));
  return {
    id: id, name: line.name, tiers: tiers, top: line.costs.length,
    now: tiers ? cdaUpgradeEffect(id, tiers) : 'none yet',
    next: next ? cdaUpgradeEffect(id, next.tier) : '',
    cost: next ? next.cost : 0, can: !why, why: why
  };
}

// The death screen's line, from the `by` of the hurt event that killed
// the player ('' when there was none).
function cdaDeathLine(by) {
  var kind = CDA_KILLERS[by] || by;
  var row = CDA_ENEMY[kind];
  if (!row) return 'The night shift ends here for now.';
  var name = row.name.toLowerCase();
  return 'Taken offline by ' + (kind === 'chiller' ? 'the ' : /^[aeiou]/.test(name) ? 'an ' : 'a ') + name + '.';
}

// The warning for a failed read or write of the save (storage part's result).
function cdaStorageText(r) {
  if (r.newer) {
    return 'This browser holds a Cold Aisle save of version ' + r.newer + ', newer than this page (version ' + CDA_SAVE_V +
      '): it is kept as it is and nothing is saved here. Load the newest version of the page to go on with that save.';
  }
  var name = r.error && r.error.name ? r.error.name : 'an unknown error';
  return 'Progress cannot be saved: the browser refused its storage (' + name + '). Allow site data for this page or ' +
    'free some space; the game goes on, but closing the page loses what was not saved.';
}

function cdaDegrees(rad) {
  return cdaNum(rad / CDA_DEG);
}

// The guide's numbers by key (see the header).
var CDA_GUIDE_NUMBERS = {
  'levels': function () { return String(CDA_LEVELS.length); },
  'health': function () { return cdaNum(CDA_PLAYER.health); },
  'entry-health': function () { return cdaNum(CDA_PLAYER.entryHealth); },
  'armour-max': function () { return cdaNum(CDA_PLAYER.armourMax); },
  'armour-share': function () { return cdaNum(CDA_PLAYER.armourShare * 100); },
  'speed': function () { return cdaNum(CDA_PLAYER.speed); },
  'turn': function () { return cdaDegrees(CDA_PLAYER.turn); },
  'reboot': function () { return cdaNum(CDA_PLAYER.reboot); },
  'flashlight': function () { return cdaNum(CDA_PLAYER.flashlight); },
  'driver-damage': function () { return cdaNum(CDA_TOOL.driver.damage); },
  'driver-reach': function () { return cdaNum(CDA_TOOL.driver.reach); },
  'driver-rate': function () { return cdaNum(CDA_TOOL.driver.cooldown); },
  'probe-damage': function () { return cdaNum(CDA_TOOL.probe.damage); },
  'probe-rate': function () { return cdaNum(CDA_TOOL.probe.cooldown); },
  'probe-cap': function () { return cdaNum(CDA_TOOL.probe.cap); },
  'degausser-rays': function () { return cdaNum(CDA_TOOL.degausser.rays); },
  'degausser-damage': function () { return cdaNum(CDA_TOOL.degausser.damage); },
  'degausser-fan': function () { return cdaDegrees(CDA_TOOL.degausser.fan); },
  'degausser-falloff': function () { return cdaNum(CDA_TOOL.degausser.falloff); },
  'degausser-rate': function () { return cdaNum(CDA_TOOL.degausser.cooldown); },
  'degausser-cap': function () { return cdaNum(CDA_TOOL.degausser.cap); },
  'crawler-hp': function () { return cdaNum(CDA_ENEMY.crawler.hp); },
  'crawler-damage': function () { return cdaNum(CDA_ENEMY.crawler.damage); },
  'crawler-windup': function () { return cdaNum(CDA_ENEMY.crawler.windup); },
  'drone-hp': function () { return cdaNum(CDA_ENEMY.drone.hp); },
  'drone-damage': function () { return cdaNum(CDA_ENEMY.drone.damage); },
  'drone-windup': function () { return cdaNum(CDA_ENEMY.drone.windup); },
  'turret-hp': function () { return cdaNum(CDA_ENEMY.turret.hp); },
  'turret-damage': function () { return cdaNum(CDA_ENEMY.turret.damage); },
  'turret-burst': function () { return cdaNum(CDA_ENEMY.turret.burst); },
  'turret-windup': function () { return cdaNum(CDA_ENEMY.turret.windup); },
  'loader-hp': function () { return cdaNum(CDA_ENEMY.loader.hp); },
  'loader-damage': function () { return cdaNum(CDA_ENEMY.loader.damage); },
  'loader-windup': function () { return cdaNum(CDA_ENEMY.loader.windup); },
  'loader-stun': function () { return cdaNum(CDA_ENEMY.loader.stun); },
  'chiller-hp': function () { return cdaNum(CDA_ENEMY.chiller.hp); },
  'chiller-called': function () { return cdaNum(CDA_BOSS.maxCalled); },
  'cell-amount': function () { return cdaNum(CDA_ITEM.cell.amount); },
  'coil-amount': function () { return cdaNum(CDA_ITEM.coil.amount); },
  'coffee-health': function () { return cdaNum(CDA_ITEM.coffee.health); },
  'medkit-health': function () { return cdaNum(CDA_ITEM.medkit.health); },
  'vest-armour': function () { return cdaNum(CDA_ITEM.vest.armour); },
  'probe-amount': function () { return cdaNum(CDA_ITEM.probe.amount); },
  'degausser-amount': function () { return cdaNum(CDA_ITEM.degausser.amount); },
  'reward-finish': function () { return cdaNum(CDA_REWARDS.finish); },
  'reward-kill': function () { return cdaNum(CDA_REWARDS.kill); },
  'reward-secret': function () { return cdaNum(CDA_REWARDS.secret); },
  'upgrade-lines': function () { return String(CDA_UPGRADES.length); }
};

// A guide number by key; an unknown key shows a dash (a test keeps the
// markup's keys and this table equal).
function cdaGuideNumber(key) {
  return Object.prototype.hasOwnProperty.call(CDA_GUIDE_NUMBERS, key) ? CDA_GUIDE_NUMBERS[key]() : '–';
}

CDA_API.CDA_UI = CDA_UI;
CDA_API.cdaFormatTime = cdaFormatTime;
CDA_API.cdaNum = cdaNum;
CDA_API.cdaKitText = cdaKitText;
CDA_API.cdaUpgradeEffect = cdaUpgradeEffect;
CDA_API.cdaUpgradeState = cdaUpgradeState;
CDA_API.cdaDeathLine = cdaDeathLine;
CDA_API.cdaStorageText = cdaStorageText;
CDA_API.CDA_GUIDE_NUMBERS = CDA_GUIDE_NUMBERS;
CDA_API.cdaGuideNumber = cdaGuideNumber;
