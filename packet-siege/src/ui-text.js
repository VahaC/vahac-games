// ── ui: the words of the page: names, refusals, results, the codex lines ──
// Owns the text the page shows, built from the tables, so every number on
// screen is the game's own.  Pure: no DOM, no clock.  Uses core, defenders
// (PKS_DEFENDERS, PKS_DEF), enemies (PKS_ENEMIES, PKS_BOSS_TIERS), levels
// (PKS_ZONES, PKS_LEVELS, pksLevel), zones (the rule constants), render
// (PKS_DECOM) and storage (PKS_SAVE_KEY).
//
// Lookups are tables built once at load (a defender id, an enemy id, 'boss'
// or PKS_DECOM in, a string out), so the page never branches on a kind.  The
// zone rules' lines (pksRuleText) take their numbers from the level's own
// rules, so a level that changes a rule's numbers says so.

var PKS_CARD_NAMES = pksCardTable(function (d) { return d.name; }, 'Decommission');
// What a card shows: the name when it has at most PKS_LABEL_MAX characters,
// else its short form (the full name stays in the card's title and label),
// so no card label is ever broken or cut on a narrow card.
var PKS_LABEL_MAX = 10;
var PKS_SHORT_NAMES = {
  proxy: 'Proxy', limiter: 'Limiter', patch: 'Patch', inspector: 'Inspector', sigdb: 'Sig DB', sinkhole: 'Sinkhole'
};
var PKS_CARD_SHORTS = pksCardTable(function (d) {
  return pksOwn(PKS_SHORT_NAMES, d.id) ? PKS_SHORT_NAMES[d.id] : d.name;
}, 'Decom');
var PKS_CARD_COSTS = pksCardTable(function (d) { return String(d.cost); }, 'free');
var PKS_CARD_LABELS = pksCardTable(function (d) { return d.name + ', ' + d.cost + ' cycles'; }, 'Decommission, removes a defender');
var PKS_CARD_HINTS = pksCardTable(function (d) {
  return d.name + ' (' + d.cost + ' cycles): ' + d.desc + ' Now pick a cell.';
}, 'Decommission: pick a defender to remove. There is no refund.');
// What a card's title adds for a defender that arms after placing (a
// Honeypot can be eaten until then), before the key: '' for the rest.
var PKS_CARD_ARMS = pksCardTable(function (d) {
  return d.arm ? ', arms in ' + d.arm + ' s' : '';
}, '');
var PKS_THREAT_NAMES = pksThreatNames();
var PKS_CODEX_ENEMIES = pksCodexEnemies();
var PKS_CODEX_BOSSES = pksCodexBosses();
var PKS_END_BEAT = 1.2;       // seconds between the end of a level and its result screen
var PKS_NEWS_TIME = 10;       // seconds of play the news banner stays (unless a placement ends it)
// Leaving a level in progress asks first: the question and the button that
// goes ahead, per way out ('keep': leaving with the level saved to resume).
var PKS_LEAVE_TEXT = {
  leave: 'Leave this level? Progress in it is lost.',
  keep: 'Leave this level? It is saved: Resume on the level select picks it up again.',
  restart: 'Restart this level? Progress in it is lost.'
};
var PKS_LEAVE_YES = { leave: 'Leave', keep: 'Leave', restart: 'Restart' };
// ... and that button's accessible name: its visible word first, then what
// it costs, as the question says it.
var PKS_LEAVE_LABEL = {
  leave: 'Leave the level; its progress is lost',
  keep: 'Leave the level; it stays saved to resume',
  restart: 'Restart the level; its progress is lost'
};
// Overtime (levels 51-150, zones): the HUD counts down from this many seconds
// before it strikes, and the live region says it at these seconds left.
var PKS_OVERTIME_SHOW = 60;
var PKS_OVERTIME_MARKS = [60, 10];
// The zone rules: their names (the HUD's badges) and their art (an overlay
// on the zone's floor tile; icon-upkeep is centred on it).
var PKS_RULE_NAMES = {
  express: 'Express', hot: 'Hot cells', rails: 'Rails', tunnels: 'Tunnels', blackout: 'Blackout', cross: 'Crossover',
  upkeep: 'Upkeep', outage: 'Outage', fog: 'Fog'
};
var PKS_RULE_ART = {
  express: 'tile-express', hot: 'tile-hot', rails: 'tile-rail', tunnels: 'tile-tunnel', blackout: 'fx-dark',
  cross: 'tile-cross-up', upkeep: 'icon-upkeep', outage: 'fx-outage', fog: 'fog'
};
var PKS_RULE_TEXT = {
  express: pksExpressText, hot: pksHotText, rails: pksRailsText, tunnels: pksTunnelsText, blackout: pksBlackoutText,
  cross: pksCrossText, upkeep: pksUpkeepText, outage: pksOutageText, fog: pksFogText
};
var PKS_RULE_CLOCK = { blackout: pksBlackoutClock, outage: pksOutageClock, upkeep: pksUpkeepClock };
// The loadout groups defenders by what they do: [title, kinds].
var PKS_ROLES = [
  ['Cycles', ['gen']],
  ['Shooters', ['shooter', 'sniper', 'mortar', 'arc', 'decrypt', 'beam', 'pulse']],
  ['Walls and traps', ['wall', 'decoy', 'trap', 'floor']],
  ['Support', ['healer', 'booster', 'backup', 'knock', 'pull']],
  ['Instants', ['instant']]
];

// A map card id -> text: fn(defender row) for every defender, decom for
// the Decommission tool.
function pksCardTable(fn, decom) {
  var out = {};
  for (var i = 0; i < PKS_DEFENDERS.length; i++) out[PKS_DEFENDERS[i].id] = fn(PKS_DEFENDERS[i]);
  out[PKS_DECOM] = decom;
  return out;
}

function pksThreatNames() {
  var out = { boss: 'APT boss' };
  for (var i = 0; i < PKS_ENEMIES.length; i++) out[PKS_ENEMIES[i].id] = PKS_ENEMIES[i].name;
  return out;
}

// The codex rows of the threats, in table order (of first appearance):
// { id, name, first, stats, desc }.
function pksCodexEnemies() {
  var rows = [];
  for (var i = 0; i < PKS_ENEMIES.length; i++) {
    var e = PKS_ENEMIES[i];
    rows.push({
      id: e.id, name: e.name, first: e.first,
      stats: 'HP ' + e.hp + ' · speed ' + e.speed + ' · bite ' + e.bite + '/s',
      desc: e.desc
    });
  }
  return rows;
}

// The codex rows of the boss tiers: { tier, name, level, stats, desc }.
function pksCodexBosses() {
  var rows = [];
  for (var i = 0; i < PKS_BOSS_TIERS.length; i++) {
    var b = PKS_BOSS_TIERS[i];
    rows.push({
      tier: b.tier, name: b.name, level: b.level,
      // a twin tier's hp is the pair's: each of the two has half (enemies)
      stats: 'HP ' + (b.twin ? b.hp / 2 + ' each' : b.hp) + ' · speed ' + b.speed + ' · bite ' + b.bite + '/s' + (b.twin ? ' · two of them' : ''),
      desc: b.desc + (i === 0 ? ' Instants do capped damage to every boss.' : '')
    });
  }
  return rows;
}

// The icon of a rule (or of a zone's look, with no rule): the sprites drawn
// one over the other, the zone's floor tile first.
function pksRuleIcon(name, zone) {
  var floor = 'tile-z' + zone + '-a';
  return name ? [floor, PKS_RULE_ART[name]] : [floor];
}

// The icon of a zone tile: its rule over its floor (zones 6-14), the cable
// tray of the DMZ, the fog of the cloud edge, else its floor.
function pksZoneIcon(zone) {
  if (zone === 2) return ['tile-tray'];
  if (zone === 4) return pksRuleIcon('fog', zone);
  if (zone < 6 || zone === 15) return pksRuleIcon(null, zone);
  return pksRuleIcon(pksLevel(zone * 10 - 9).rules.names[0], zone);
}

// A zone's codex line: its levels.
function pksZoneLevels(z) {
  return 'Levels ' + (z.zone * 10 - 9) + '-' + z.zone * 10;
}

// A defender's codex line of numbers.
function pksDefenderStats(d) {
  return 'Cost ' + d.cost + ' · recharge ' + d.recharge + ' s · HP ' + d.hp;
}

// Lane numbers for people: 1 to 5 from the top.
function pksLaneList(lanes) {
  var out = [];
  for (var i = 0; i < lanes.length; i++) out.push(lanes[i] + 1);
  return out.join(', ');
}

// Why pksCanPlace said no, with its values.  The page only asks about cells
// of the floor while the level is on, so the reasons are these six.
function pksRefusalText(r) {
  if (r.reason === 'recharging') return PKS_CARD_NAMES[r.card] + ' recharging: ' + r.seconds.toFixed(1) + ' s';
  if (r.reason === 'cycles') return 'Not enough cycles: ' + r.have + ' of ' + r.need;
  if (r.reason === 'lane-closed') return 'Lane ' + (r.lane + 1) + ' is closed on this level (in play: ' + pksLaneList(r.lanes) + ')';
  if (r.reason === 'blocked') return 'Cable tray: nothing fits here';
  if (r.reason === 'tunnel') return 'Tunnel exit: enemies come out here, so nothing can stand on it';
  return 'Cell taken by ' + PKS_CARD_NAMES[r.occupant] + ': decommission it first (X)';
}

// The key of the card at index i (0-based): 1 to 9, then 0.
function pksCardKey(i) {
  return String((i + 1) % 10);
}

// The keys of `count` cards for people: "1-5", "1-9", "1-9 and 0".
function pksKeysText(count) {
  return count > 9 ? '1-9, 0' : '1-' + count;
}

// What the status line says for the card held over a cell that takes it.
function pksAimText(card, occupant, cost) {
  if (card === PKS_DECOM) return 'Decommission ' + PKS_CARD_NAMES[occupant] + ' here (no refund)';
  var arm = PKS_DEF[card].arm;
  return 'Place ' + PKS_CARD_NAMES[card] + ' here for ' + cost + ' cycles' + (arm ? ' (arms in ' + arm + ' s)' : '');
}

// What the status line says once defender `card` is placed for `cost`; one
// that arms after placing says when, and that it can be eaten until then.
function pksPlacedText(card, cost) {
  var text = PKS_CARD_NAMES[card] + ' placed: ' + cost + ' cycles.';
  var arm = PKS_DEF[card].arm;
  if (arm) text += ' Arms in ' + arm + ' s — enemies can eat it until then.';
  return text;
}

// A defender that arms after placing was eaten before it ever armed.
function pksEatenUnarmedText(def) {
  return PKS_CARD_NAMES[def] + ' eaten before it armed.';
}

// The level's line in the HUD.
function pksLevelTitle(lv) {
  return 'L' + lv.n + ' · ' + lv.name;
}

// What the status line says when a level starts.
function pksStartText(lv, count) {
  return lv.hint || 'Pick a card (' + pksKeysText(count) + ' or tap it), then a cell. X: Decommission, P: pause, S: speed, F: fullscreen.';
}

// The Fullscreen buttons' text: what a press does.
function pksFullText(on) {
  return on ? 'Exit full' : 'Fullscreen';
}

// The level select's line for a zone: its name and its modifier.
function pksZoneLine(z) {
  return 'Zone ' + z.zone + ' · ' + z.name;
}

function pksLevelLabel(lv, stars, open) {
  var boss = lv.n % 10 === 0 ? ' (boss)' : '';
  if (!open) return 'Level ' + lv.n + ', ' + lv.name + boss + ': locked';
  return 'Level ' + lv.n + ', ' + lv.name + boss + ': ' + stars + ' of 3 stars';
}

// A zone tile of the level select: what it says and what a reader hears.
function pksZoneTileText(z, stars, open) {
  return open ? '★ ' + stars + '/30' : 'from L' + (z.zone * 10 - 9);
}

function pksZoneTileLabel(z, stars, open) {
  if (!open) return 'Zone ' + z.zone + ', ' + z.name + ': locked until level ' + (z.zone * 10 - 9);
  return 'Zone ' + z.zone + ', ' + z.name + ': ' + stars + ' of 30 stars';
}

// Minutes and seconds: 0:07, 12:30.
function pksClock(seconds) {
  var s = Math.floor(seconds);
  return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2);
}

// The level select's offer of a saved level in progress.
function pksRunLine(run) {
  return 'Level ' + run.n + ', ' + PKS_LEVEL_ROWS[run.n - 1][0] + ': in progress, ' + pksClock(run.time) + ' played.';
}

// ── the zone rules ──

// Whole per cent of a factor's gain: 1.4 -> 40.
function pksGain(factor) {
  return Math.round((factor - 1) * 100);
}

function pksExpressText(lv) {
  return 'enemies in the marked lanes (' + pksLaneList(lv.rules.express) + ') move ' + pksGain(PKS_EXPRESS) + ' % faster.';
}

function pksHotText(lv) {
  return 'a defender standing on a hot cell loses ' + PKS_HOT_DPS + ' HP a second.';
}

function pksRailsText(lv) {
  return 'a defender on a power rail works ' + pksGain(PKS_RAIL) + ' % faster.' + (lv.trickle ? '' : ' No passive cycles.');
}

function pksTunnelsText(lv) {
  var list = lv.rules.tunnels;
  var lanes = list.map(function (x) { return x.lane; });
  return 'one of every ' + list[0].every + ' enemies of ' + (lanes.length > 1 ? 'lanes ' : 'lane ') + pksLaneList(lanes) +
    ' comes out of the exit at column ' + (list[0].col + 1) + ' after a ' + PKS_SHIMMER + ' s shimmer; nothing can stand on an exit.';
}

function pksBlackoutText(lv) {
  var b = lv.rules.blackout;
  return 'every ' + b.every + ' s the lights fail for ' + b.length + ' s (' + b.warn + ' s warning): shooters then see only ' +
    b.sight + ' cells ahead, and only what they see stays lit.';
}

function pksCrossText(lv) {
  return 'an enemy stepping on a crossover cell moves to the lane its arrow shows (not the boss or a Kernel Panic).';
}

function pksUpkeepText(lv) {
  var u = lv.rules.upkeep;
  return 'every ' + u.every + ' s each defender costs ' + u.cost + (u.cost === 1 ? ' cycle' : ' cycles') +
    '; passive cycles are ' + lv.rules.trickle + ' every ' + PKS_TRICKLE_EVERY + ' s.';
}

function pksOutageText(lv) {
  var o = lv.rules.outage;
  return 'every ' + o.every + ' s one lane goes offline for ' + o.length + ' s (' + o.warn + ' s warning): its defenders stop.';
}

function pksFogText(lv) {
  return 'fog hides the ' + lv.fog + ' right columns: enemies there are not drawn, but shots still hit them.';
}

// The rule's one line for level lv (a rule name of lv.rules.names).
function pksRuleText(name, lv) {
  return PKS_RULE_NAMES[name] + ': ' + PKS_RULE_TEXT[name](lv);
}

// The same line on its own, as a sentence (the news banner's detail).
function pksRuleDetail(name, lv) {
  var text = PKS_RULE_TEXT[name](lv);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pksSecs(steps) {
  return Math.ceil(steps / PKS_RATE) + 's';
}

// The same for people: "7 s".
function pksSaySecs(steps) {
  return Math.ceil(steps / PKS_RATE) + ' s';
}

function pksCyclesWord(n) {
  return n + (n === 1 ? ' cycle' : ' cycles');
}

// What a rule does next, for its badge: { text, alert, say } ('' for a rule
// without a clock; say is the same in words, for the badge's accessible
// name).  The blackout: the seconds to the dark (amber in the warning), or,
// amber, to the light; the outage: the lane and the seconds to its going down
// (amber in the warning), or, amber, "L3 off" and the seconds to its return;
// the upkeep: what is due now and the seconds to the charge (amber when the
// cycles do not cover it).
function pksRuleClock(name, sim) {
  return pksOwn(PKS_RULE_CLOCK, name) ? PKS_RULE_CLOCK[name](sim) : { text: '', alert: false, say: '' };
}

function pksBlackoutClock(sim) {
  var b = sim.blackout;
  if (b.state === 'dark') return { text: 'lit ' + pksSecs(b.t), alert: true, say: 'dark, the lights come back in ' + pksSaySecs(b.t) };
  var t = b.state === 'warn' ? b.t : b.t + pksSteps(sim.level.rules.blackout.warn);
  return { text: pksSecs(t), alert: b.state === 'warn', say: 'the lights go out in ' + pksSaySecs(t) };
}

function pksOutageClock(sim) {
  var o = sim.outage;
  if (o.state === 'down') return { text: 'L' + (o.lane + 1) + ' off ' + pksSecs(o.t), alert: true, say: 'lane ' + (o.lane + 1) + ' is offline, back in ' + pksSaySecs(o.t) };
  var lane = o.state === 'warn' ? o.lane : o.next;
  var t = o.state === 'warn' ? o.t : o.t + pksSteps(sim.level.rules.outage.warn);
  return { text: 'L' + (lane + 1) + ' ' + pksSecs(t), alert: o.state === 'warn', say: 'lane ' + (lane + 1) + ' goes offline in ' + pksSaySecs(t) };
}

function pksUpkeepClock(sim) {
  var due = 0;
  for (var i = 0; i < sim.defenders.length; i++) {
    if (sim.defenders[i].hp > 0 && sim.defenders[i].kind !== 'instant') due += sim.level.rules.upkeep.cost;
  }
  var alert = due > sim.cycles;
  return {
    text: '-' + due + ' ' + pksSecs(sim.upkeep.t), alert: alert,
    say: pksCyclesWord(due) + ' due in ' + pksSaySecs(sim.upkeep.t) + (alert ? ', more than you have' : '')
  };
}

// A rule badge's accessible name once its rule keeps time: the rule's
// line, then what it does next (a badge without a clock keeps the line).
function pksRuleLabel(text, say) {
  return text + ' Now: ' + say + '.';
}

// The live region's words for the rules' warnings, and the status line's
// for their changes.
function pksBlackoutWarnText(rule) {
  return 'Lights out in ' + rule.warn + ' s for ' + rule.length + ' s: shooters will see only ' + rule.sight + ' cells ahead.';
}

function pksLightsText(on, rule) {
  return on ? 'Lights out: shooters see only ' + rule.sight + ' cells ahead for ' + rule.length + ' s.' : 'The lights are back on.';
}

function pksOutageWarnText(ev, rule) {
  return 'Lane ' + (ev.lane + 1) + ' goes offline in ' + rule.warn + ' s for ' + ev.length + ' s: its defenders will stop.';
}

function pksOutageOnText(ev, rule) {
  return ev.on ? 'Lane ' + (ev.lane + 1) + ' is offline for ' + rule.length + ' s: its defenders do nothing.' : 'Lane ' + (ev.lane + 1) + ' is back online.';
}

// An upkeep charge not paid in full (ev: amount taken, due; the page says
// nothing of a paid one).  What is not covered is never
// collected and nothing is switched off (zones), so the line says so.
function pksUpkeepChargeText(ev) {
  var rest = ' Nothing is switched off and the rest is never collected.';
  if (ev.amount === 0) return 'Upkeep of ' + pksCyclesWord(ev.due) + ' not paid: you had no cycles.' + rest;
  return 'Upkeep: ' + ev.amount + ' of ' + pksCyclesWord(ev.due) + ' paid, all you had.' + rest;
}

function pksShieldUpText(ev) {
  return 'The boss\'s shield is back: ' + ev.shield + ' shield HP to break.';
}

// A boss of tier `tier` (its row) split: two copies with tier.split HP each,
// at full health, without a shield (bosses).
function pksBossSplitText(tier) {
  return 'The boss split in two: each copy has ' + tier.split + ' HP and no shield.';
}

// Overtime (zones): a level with rules, every spawn out and enemies on the
// floor, is lost PKS_OVERTIME s after its nominal end.  The seconds left
// until then while that can happen, else -1.
function pksOvertimeLeft(sim) {
  var lv = sim.level;
  if (!lv.rules || sim.spawnIndex < lv.spawns.length || !sim.enemies.length) return -1;
  return Math.max(0, lv.duration + PKS_OVERTIME - sim.time);
}

// The HUD's countdown in the last PKS_OVERTIME_SHOW s ('' before), and the
// sentence it stands for (its title, the status line, the live region).
function pksOvertimeClock(sim) {
  var left = pksOvertimeLeft(sim);
  if (sim.status !== 'playing' || left < 0 || left > PKS_OVERTIME_SHOW) return '';
  return 'Overtime ' + Math.ceil(left) + 's';
}

function pksOvertimeWarnText(seconds) {
  return 'Overtime in ' + seconds + ' s: clear every enemy by then, or the one nearest the rack breaks through and the level is lost.';
}

// The stars of a level as glyphs: on ones and off ones.
function pksStarGlyphs(stars) {
  return ['★★★'.slice(0, stars), '☆☆☆'.slice(stars)];
}

function pksSurgeText(sim) {
  if (sim.warned > sim.surged) return 'Surge incoming!';
  return 'Surge ' + sim.surged + '/' + sim.level.surges.length;
}

function pksSurgeWarnText(ev, total) {
  return 'Surge ' + (ev.index + 1) + ' of ' + total + ' in ' + PKS_SURGE_WARN + ' s: get ready.';
}

function pksBreakerText(ev) {
  return 'Breaker tripped in lane ' + (ev.lane + 1) + ': one more breach there ends the level.';
}

// The result screen's line for a win with `stars` (rec: pksRecordWin's
// result, which holds the best stars of the level): the best is named only
// when it is higher than this run's.
function pksWinText(rec, stars, tripped) {
  var text = 'Breakers tripped: ' + tripped + '. Stars: ' + stars + ' of 3.';
  if (rec.stars > stars) text += ' Your best here stays ' + rec.stars + ' of 3.';
  return text;
}

// A loss ({ lane, enemy, overtime }: overtime when the sim said 'overtime'
// before its 'lose').
function pksLossTitle(res) {
  return res.overtime ? 'Overtime: the level is lost' : 'Breach in lane ' + (res.lane + 1);
}

function pksLossText(res) {
  if (res.overtime) {
    return 'The level ran ' + pksClock(PKS_OVERTIME) + ' past its end with enemies still on the floor, so the ' +
      PKS_THREAT_NAMES[res.enemy] + ' nearest the rack broke through in lane ' + (res.lane + 1) + '.';
  }
  return PKS_THREAT_NAMES[res.enemy] + ' reached the rack after the lane\'s breaker had tripped.';
}

// What winning level n opened, as lines: { icon (sprite name or null), text }.
function pksUnlockLines(rec) {
  var lines = [];
  for (var i = 0; i < rec.newDefenders.length; i++) {
    var d = PKS_DEF[rec.newDefenders[i]];
    lines.push({ icon: pksIconName(d.id), text: 'New defender: ' + d.name + '. ' + d.desc });
  }
  if (rec.newSlots) lines.push({ icon: null, text: 'Loadout slots: ' + rec.newSlots + ' from level ' + rec.newLevel + '.' });
  if (rec.newLevel) lines.push({ icon: null, text: 'Level ' + rec.newLevel + ', ' + PKS_LEVEL_ROWS[rec.newLevel - 1][0] + ', is open.' });
  if (rec.level === PKS_LEVELS) {
    lines.push({ icon: null, text: 'Campaign complete: the core holds. Replay any level for more stars.' });
  }
  return lines;
}

// The announcement of a whole result or a level's start (the live region):
// every line with its detail.
function pksResultAnnouncement(title, text, lines) {
  var out = title + '. ' + text;
  for (var i = 0; i < lines.length; i++) out += ' ' + lines[i].text + (lines[i].detail ? ' ' + lines[i].detail : '');
  return out;
}

// The news of a level as lines { icon, text, detail }: the threat it
// introduces (until met) and the defenders the last win unlocked (on the
// level right after).  The banner shows the detail only on wide frames.
function pksNewsLines(lv, save, cards) {
  var lines = [];
  var e = PKS_ENEMY[lv.intro];
  var names = lv.rules ? lv.rules.names : [];
  for (var r = 0; r < names.length; r++) {
    lines.push({ icon: pksRuleIcon(names[r], lv.zone), text: 'Zone rule: ' + PKS_RULE_NAMES[names[r]] + '.', detail: pksRuleDetail(names[r], lv) });
  }
  if (e && save.met.indexOf(e.id) === -1) lines.push({ icon: pksIconName(e.id), text: 'New threat: ' + e.name + '.', detail: e.desc });
  for (var i = 0; i < cards.length; i++) {
    var d = PKS_DEF[cards[i]];
    if (d.unlock === lv.n - 1 && pksHighestWon(save) === lv.n - 1) {
      lines.push({ icon: pksIconName(d.id), text: 'New defender: ' + d.name + '.', detail: d.desc });
    }
  }
  return lines;
}

// The storage warning for a read or write result of the storage part: a
// save (or, with key PKS_RUN_KEY, a snapshot) of a newer version found there
// (newer: its v), or blocked or full storage (error).
function pksStorageWarning(r) {
  if (r.newer) {
    var run = r.key === PKS_RUN_KEY;
    return 'This browser holds data of a newer version of the game (' + (run ? PKS_RUN_KEY : PKS_SAVE_KEY) + ' version ' + r.newer +
      ') that this page cannot read. It is left as it is: ' + (run ? 'a level in progress' : 'progress') + ' is not being saved in this tab.';
  }
  return 'Storage is blocked or full (' + r.error.name + '): ' + PKS_SAVE_KEY +
    ' is not saved on this page. The game plays on, but a reload starts from your last saved progress.';
}
