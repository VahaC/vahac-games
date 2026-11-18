// ── ui-hud: the HUD over the view: health, armour, the tool and its ammo, badges, racks, the message line, low health ──
// Owns CDA_LOW_SHARE, CDA_MSG_TIME, cdaBuildHud, cdaRenderHud, cdaSay and
// cdaMessageStep.  Uses core, tables (CDA_TOOL), textures
// (cdaSpritePixels through cdaPaint), ui-text and ui-page.
//
// The HUD is DOM laid over the bottom corners of the view (the tool in hand
// is drawn bottom-centre by the renderer), with the message line at the
// top; it scales with the frame (--cda-scale).  Its icons are the game's
// own 8x8 sprites (data-cda-icon in the markup; the ammo icon follows the
// tool in hand).  cdaRenderHud runs on every drawn frame and only touches
// what changed.  The message line takes the sim's message events (the sim
// sends one for a pickup, a locked door, the locked lift, a rack rebooted,
// a secret, the lift unlocked) and the page's own lines; each stays
// CDA_MSG_TIME seconds of play and is said in the live region too.
// Low health (CDA_LOW_SHARE of the maximum or less): the health turns red
// and pulses, the view gets a red edge, and the live region says it once
// each time health drops into it.

var CDA_LOW_SHARE = 0.25;
var CDA_MSG_TIME = 3;
var CDA_BADGES = ['blue', 'yellow', 'red'];

// Draws the icons named by data-cda-icon (the HUD's fixed ones).
function cdaBuildHud() {
  var icons = document.querySelectorAll('[data-cda-icon]');
  for (var i = 0; i < icons.length; i++) cdaPaint(icons[i], icons[i].getAttribute('data-cda-icon'));
}

function cdaRenderHud() {
  var rt = CDA_RT;
  var els = rt.els;
  var sim = rt.sim;
  var p = sim.player;
  cdaSetText(els.health, String(Math.ceil(p.health)));
  cdaSetText(els.armour, String(Math.ceil(p.armour)));
  var tool = CDA_TOOL[p.tool];
  cdaSetText(els.tool, tool.name);
  if (tool.ammo !== rt.hudAmmo) {
    rt.hudAmmo = tool.ammo;
    if (tool.ammo) cdaPaint(els.ammoIcon, 'ic-' + tool.ammo);
    cdaToggle(els.ammoIcon, !!tool.ammo);
  }
  cdaSetText(els.ammo, tool.ammo ? String(p.ammo[tool.ammo]) : '–');
  var held = [];
  var badgeEls = [els.badgeBlue, els.badgeYellow, els.badgeRed];
  for (var i = 0; i < CDA_BADGES.length; i++) {
    var on = p.badges[CDA_BADGES[i]];
    badgeEls[i].classList.toggle('cda-badge--off', !on);
    if (on) held.push(CDA_BADGES[i]);
  }
  cdaSetText(els.badges, held.length ? 'Badges: ' + held.join(', ') : 'No badges');
  var done = 0;
  for (i = 0; i < sim.racks.length; i++) if (sim.racks[i].state === 'clean') done++;
  cdaSetText(els.racks, done + '/' + sim.racks.length);
  var low = p.health > 0 && p.health <= p.maxHealth * CDA_LOW_SHARE;
  if (low !== rt.low) {
    rt.low = low;
    els.hud.classList.toggle('cda-hud--low', low);
    els.stage.classList.toggle('cda-stage--low', low);
    if (low) cdaAnnounce(CDA_UI.lowHealth + ': ' + Math.ceil(p.health));
  }
}

// A line in the HUD's message line and the live region.
function cdaSay(text) {
  var rt = CDA_RT;
  cdaSetText(rt.els.msg, text);
  rt.msgLeft = cdaSteps(CDA_MSG_TIME);
  cdaAnnounce(text);
}

// One step of play: the message line's time runs out.
function cdaMessageStep() {
  var rt = CDA_RT;
  if (rt.msgLeft > 0) {
    rt.msgLeft--;
    if (rt.msgLeft === 0) cdaSetText(rt.els.msg, '');
  }
}

CDA_API.CDA_LOW_SHARE = CDA_LOW_SHARE;
CDA_API.CDA_MSG_TIME = CDA_MSG_TIME;
