// ── ui: the zone rules in the HUD: badges, their clocks, the warnings, overtime ──
// Owns the rule badges of a level (pksBuildRules, pksUpdateRules), the
// pause overlay's list of the level's rules, what the page says when a rule
// or a late boss acts (PKS_RULE_EVENT_UI: blackout and outage warnings in the
// live region and the status line, their changes, upkeep charges not paid in full, a boss's
// shield and split in the status line) and the overtime countdown.  Uses
// zones (via the level's rules, PKS_OVERTIME), enemies (PKS_BOSS_TIERS),
// ui-text (PKS_RULE_NAMES, pksRuleText, pksRuleClock, the warning texts) and
// ui-page; inside function bodies also ui-level (pksGameButton).
//
// The badges sit in #pks-rules, a row over the canvas's top strip left of
// the surge bar (ui-frame places it).  A level of 51-150 shows one badge per
// rule of level.rules.names: the rule's icon (its art over the zone's floor
// tile), its name (wide frames only) and, for the rules that keep time, what
// it does next: "dark in 23s" / "lit in 7s", "L3 in 12s" / "L3 off 5s",
// "-9 in 4s" (the upkeep due now and when it is charged); a badge whose rule
// is about to strike or is striking turns amber (pks-rule--alert).  Its title
// is the rule's one line with the level's numbers; its accessible name is
// that line and what the rule does next in words (it changes with the clock;
// the badge is not a live region); a tap or click puts the line in the
// status line.  Levels 1-50 have no badges.
//
// Overtime (zones): a level with rules whose spawns are all out and whose
// enemies are still on the floor PKS_OVERTIME s after its nominal end is
// lost.  For the last PKS_OVERTIME_SHOW s before that the HUD's surge line
// counts down ("Overtime 42s", amber, its title the full sentence); the live
// region and the status line say it once at each of PKS_OVERTIME_MARKS
// seconds left.  The sim's 'overtime' event marks the loss that follows as
// an overtime loss (its own result).  Levels 1-50 never have it.

var PKS_RULE_EVENT_UI = {
  blackoutWarn: pksOnBlackoutWarn, blackout: pksOnBlackout, outageWarn: pksOnOutageWarn, outage: pksOnOutage,
  upkeep: pksOnUpkeep, shieldUp: pksOnShieldUp, bossSplit: pksOnBossSplit, overtime: pksOnOvertime
};

// The badges and the pause overlay's rule lines of level lv, and the rule
// state of the page for the level's sim (the runtime's): no split said yet,
// the overtime marks already passed (a resumed level) not said again.
function pksBuildRules(lv) {
  var rt = pksRuntime;
  var names = lv.rules ? lv.rules.names : [];
  rt.els.rules.textContent = '';
  rt.els.pausedRules.textContent = '';
  rt.ruleEls = [];
  rt.splitSaid = false;
  rt.upkeepSaid = {};
  rt.overtime = false;
  rt.overtimeSaid = pksOvertimeMarks(rt.sim);
  for (var i = 0; i < names.length; i++) {
    var text = pksRuleText(names[i], lv);
    var b = pksMake('button', 'pks-rule');
    b.type = 'button';
    b.setAttribute('title', text);
    b.setAttribute('aria-label', text);
    b.appendChild(pksIcon(pksRuleIcon(names[i], lv.zone), 'pks-rule-icon'));
    b.appendChild(pksMake('span', 'pks-rule-name', PKS_RULE_NAMES[names[i]]));
    var clock = pksMake('span', 'pks-rule-clock');
    b.appendChild(clock);
    b.addEventListener('click', pksGameButton(pksRuleTell(text)));
    rt.els.rules.appendChild(b);
    rt.els.pausedRules.appendChild(pksMake('li', 'pks-paused-rule', text));
    rt.ruleEls.push({ name: names[i], el: b, clock: clock, alert: false, text: text, say: '' });
  }
  pksToggle(rt.els.rules, names.length > 0);
  pksToggle(rt.els.pausedRules, names.length > 0);
}

function pksRuleTell(text) {
  return function () {
    pksSetStatus(text);
  };
}

// Each badge's clock, alert and accessible name from the sim now, and the
// overtime countdown.
function pksUpdateRules() {
  var rt = pksRuntime;
  for (var i = 0; i < rt.ruleEls.length; i++) {
    var r = rt.ruleEls[i];
    var c = pksRuleClock(r.name, rt.sim);
    pksSetText(r.clock, c.text);
    if (c.alert !== r.alert) {
      r.alert = c.alert;
      r.el.classList.toggle('pks-rule--alert', c.alert);
    }
    if (c.say !== r.say) {
      r.say = c.say;
      r.el.setAttribute('aria-label', pksRuleLabel(r.text, c.say));
    }
  }
  pksUpdateOvertime();
}

// ── overtime ──

// How many of PKS_OVERTIME_MARKS the sim has passed (seconds left at or
// below the mark while overtime can strike).
function pksOvertimeMarks(sim) {
  var left = pksOvertimeLeft(sim);
  var n = 0;
  while (n < PKS_OVERTIME_MARKS.length && left >= 0 && left <= PKS_OVERTIME_MARKS[n]) n++;
  return n;
}

// The HUD's surge line becomes the countdown near overtime (the surges are
// all over by then: every spawn is out); each mark passed is said once.
function pksUpdateOvertime() {
  var rt = pksRuntime;
  var text = pksOvertimeClock(rt.sim);
  if (!text) {
    rt.els.surge.removeAttribute('title');
    return;
  }
  pksSetText(rt.els.surge, text);
  rt.els.surge.classList.add('pks-hud-surge--warn');
  var seconds = Math.ceil(pksOvertimeLeft(rt.sim));
  rt.els.surge.setAttribute('title', pksOvertimeWarnText(seconds));
  var passed = pksOvertimeMarks(rt.sim);
  if (passed > rt.overtimeSaid) {
    rt.overtimeSaid = passed;
    var say = pksOvertimeWarnText(PKS_OVERTIME_MARKS[passed - 1]);
    pksSetStatus(say);
    pksAnnounce(say);
  }
}

// The sim's 'overtime' comes just before its 'lose': that loss is overtime.
function pksOnOvertime() {
  pksRuntime.overtime = true;
}

// ── what the page says when a rule acts ──

function pksOnBlackoutWarn() {
  var text = pksBlackoutWarnText(pksRuntime.sim.level.rules.blackout);
  pksSetStatus(text);
  pksAnnounce(text);
}

function pksOnBlackout(ev) {
  pksSetStatus(pksLightsText(ev.on, pksRuntime.sim.level.rules.blackout));
}

function pksOnOutageWarn(ev) {
  var text = pksOutageWarnText(ev, pksRuntime.sim.level.rules.outage);
  pksSetStatus(text);
  pksAnnounce(text);
}

function pksOnOutage(ev) {
  pksSetStatus(pksOutageOnText(ev, pksRuntime.sim.level.rules.outage));
}

// An upkeep charge: a paid one says nothing (the pip and the badge show
// it); one not paid in full says so in the status line, each case (part
// paid, unpaid) once per run of such charges: a paid charge ends the run.
function pksOnUpkeep(ev) {
  var rt = pksRuntime;
  if (ev.amount === ev.due) {
    rt.upkeepSaid = {};
    return;
  }
  var kind = ev.amount === 0 ? 'unpaid' : 'part';
  if (rt.upkeepSaid[kind]) return;
  rt.upkeepSaid[kind] = true;
  pksSetStatus(pksUpkeepChargeText(ev));
}

function pksOnShieldUp(ev) {
  pksSetStatus(pksShieldUpText(ev));
}

// A boss split: the status line, and the first of the level in the live
// region too (the field suddenly holds two bosses).
function pksOnBossSplit() {
  var rt = pksRuntime;
  var text = pksBossSplitText(PKS_BOSS_TIERS[rt.sim.level.boss - 1]);
  pksSetStatus(text);
  if (rt.splitSaid) return;
  rt.splitSaid = true;
  pksAnnounce(text);
}
