// ── tables: every balance number: the player, tools, enemies, the boss, items, decor, upgrades ──
// Owns CDA_PLAYER, CDA_TOOLS / CDA_TOOL, CDA_ENEMIES / CDA_ENEMY, CDA_BOSS,
// CDA_ITEMS / CDA_ITEM, CDA_DECOR / CDA_DEC, CDA_SHOTS / CDA_SHOT,
// CDA_UPGRADES / CDA_UPGRADE,
// CDA_REWARDS, CDA_TEXT and cdaText.  Uses core (cdaIndex).
//
// The spec's starting points, tuned by the levels agent (2026-11-18) against
// the scripted players of tests/_cold-aisle-bot.js on the nine levels: the
// crawler runs at 2.2 (not 1.6) and wakes after 0.3 s (not 0.4), so a pack
// reaches a player who only backs away; the chiller has 660 hp (not 900),
// vents open 5 / 4.5 / 4 s (were 4 / 3.5 / 3), calls 1 / 2 / 2 crawlers
// (were 2 / 2 / 3, at most 3 alive, were 4), its frost bolts do 8 (not 10)
// and phase 3 fires 2 volleys (not 3), so the novice wins the fight with
// the arena's ammo.  Tests read them from here and never repeat them.
// Times are seconds, distances cells, speeds cells a second, angles radians.
// The ids are the contract with the art: a tool id names its in-hand frames
// (vw-<id>-...), an enemy id its frames (enm-<id>-... ; the chiller's are
// boss-chiller-...), an item id its sprite (it-<id>), a decor id its sprite
// (dc-<id>), a projectile kind its frames (fx-<id>0 / 1).  size (enemies)
// and w x h (decor) are the art's pixel sizes.
// tall (enemies, items, decor, projectiles): the height in cells the
// renderer draws the sprite's whole frame at (its width follows from the
// frame's aspect).  The ceiling is one cell up; think of a cell as about
// 2.4 m.  Hovering things are drawn up in their frame, so the frame's
// height also sets how high they hover.  The numbers were chosen by eye in
// real frames next to a rack wall and a door (2026-11-18).

var CDA_DEG = Math.PI / 180;

// The player.  turn: the keyboard turn rate (the page turns `turn * CDA_STEP`
// a step while Left / Right is held and adds the mouse).  armourShare: the
// part of each hit an ESD vest absorbs while armour lasts.  entryHealth: a
// level starts with at least this much health (what was carried, raised to
// it).  useReach: from the player's centre, how far Use and the reboot reach.
// pickup: an item this close to the player's centre is picked up.
// flashlight: the cells the flashlight reaches (the renderer's light).
var CDA_PLAYER = {
  health: 100, armourMax: 100, armourShare: 0.5, entryHealth: 50, radius: 0.22, speed: 3.4,
  turn: 150 * CDA_DEG, useReach: 1.2, pickup: 0.55, switchTime: 0.3, reboot: 1.5, flashlight: 6
};

// Tools in slot order (slot = the number key).  Every tool fires `rays` rays
// spread evenly over `fan` (one ray: straight ahead); a ray reaches `reach`
// cells and hits the first living enemy whose centre lies ahead within
// that reach (and before any wall) and whose radius plus `slack` it passes
// within, doing `damage`, times `far` when that centre is past `falloff`
// cells.  Reach is measured to the target's surface: an enemy is in reach
// when its centre's distance along the ray minus its radius is below
// `reach` (so the driver reaches a loader or the chiller from outside
// it).  ammo: the ammo kind one
// shot uses ('' for none); cap: how much of it the player can carry.
// noise: asleep enemies within this many flow steps of the player wake up.
var CDA_TOOLS = [
  { id: 'driver', name: 'Screwdriver', slot: 1, damage: 20, cooldown: 0.35, reach: 1.1, slack: 0.3, rays: 1, fan: 0,
    falloff: 2, far: 1, ammo: '', cap: 0, noise: 2 },
  { id: 'probe', name: 'Tone probe', slot: 2, damage: 12, cooldown: 0.28, reach: 32, slack: 0, rays: 1, fan: 0,
    falloff: 32, far: 1, ammo: 'cell', cap: 120, noise: 10 },
  { id: 'degausser', name: 'Degausser', slot: 3, damage: 8, cooldown: 0.9, reach: 32, slack: 0, rays: 7, fan: 18 * CDA_DEG,
    falloff: 6, far: 0.5, ammo: 'coil', cap: 30, noise: 14 }
];

// Enemies.  hp, speed, radius (the body for collision and for being hit),
// sight (cells: an asleep enemy with a clear line to the player this close
// wakes), alert (the pause between waking and chasing), flinch (the hurt
// state's length; 0: hits never interrupt it), windup (the readable tell
// before an attack: a swing, a spark charging, the turret's lock-on, the
// loader's telegraph), strike (the attack frame's length), cooldown (from an
// attack to the next windup), damage.
// crawler, melee: attacks when the gap between the bodies is within reach;
//   the strike lands if the gap is still within reach + slack at the end of
//   the windup.
// drone: shoots a spark (shotSpeed) when it sees the player within range;
//   keeps keepMin..keepMax cells away and strafes, changing side every
//   strafe seconds (times 0.5..1.5, seeded).
// turret: never moves; locks on (windup) while it sees the player within
//   range, loses the lock when the line breaks (relock: the wait before it
//   tries again), then fires a burst of `burst` bolts `gap` seconds apart.
// loader: with a clear line to the player within chargeRange it telegraphs
//   (windup) toward where the player stood when the telegraph began, then
//   charges that way at chargeSpeed for at most chargeMax cells; hitting the
//   player, a wall or anything solid ends the charge and stuns it for stun s.
// chiller: the boss (see CDA_BOSS); radius and hp here.  The ceiling
//   limits it to one cell of height, and its art is square, so it is drawn
//   one cell wide (a floor-to-ceiling cabinet) and its body is the circle
//   that fits that (radius 0.5; it was 0.9 when it was meant two cells wide).
var CDA_ENEMIES = [
  { id: 'crawler', name: 'Floor scrubber', hp: 30, speed: 2.2, radius: 0.3, size: 32, tall: 0.6, sight: 12, alert: 0.3, flinch: 0.2,
    windup: 0.3, strike: 0.2, cooldown: 0.8, damage: 8, reach: 0.4, slack: 0.3 },
  { id: 'drone', name: 'Inventory drone', hp: 20, speed: 2.4, radius: 0.25, size: 32, tall: 0.85, sight: 14, alert: 0.4, flinch: 0.2,
    windup: 0.35, strike: 0.2, cooldown: 1.6, damage: 10, range: 9, shotSpeed: 6, keepMin: 4, keepMax: 7, strafe: 1.2 },
  { id: 'turret', name: 'Camera turret', hp: 40, speed: 0, radius: 0.3, size: 32, tall: 0.9, sight: 14, alert: 0.3, flinch: 0.15,
    windup: 0.8, strike: 0.2, cooldown: 1.4, damage: 6, range: 14, shotSpeed: 7, burst: 3, gap: 0.15, relock: 0.5 },
  { id: 'loader', name: 'Pallet loader', hp: 120, speed: 1.1, radius: 0.42, size: 48, tall: 0.95, sight: 12, alert: 0.5, flinch: 0,
    windup: 0.6, strike: 0, cooldown: 1, damage: 25, chargeRange: 9, chargeSpeed: 5, chargeMax: 12, stun: 1 },
  { id: 'chiller', name: 'Chiller', hp: 660, speed: 0, radius: 0.5, size: 64, tall: 1, sight: 16, alert: 1, flinch: 0,
    windup: 0, strike: 0, cooldown: 0, damage: 8 }
];

// A dying enemy shows die0 then die1 (the boss die0..die2) for this long in
// all, then lies as its corpse ('dead').
var CDA_DIE_TIME = 0.5;

// The boss.  It never moves.  It loops through `loop`, each state lasting
// the current phase's seconds of that name: windup (the frost tell), attack
// (fires `volleys` fans of `bolts` frost bolts `gap` s apart, spread over
// `spread` and centred on the player, at boltSpeed), call (calls `calls`
// crawlers, at most `maxCalled` of them alive), vent (the vents are open:
// the only state in which it takes damage), idle.  phases[0] while hp is
// above 2/3 of the maximum, phases[1] above 1/3, then phases[2]; a phase
// change closes the vents and restarts the loop at idle.  flash: how long
// it shows its hurt frame after a hit through the vents.
var CDA_BOSS = {
  loop: ['windup', 'attack', 'call', 'vent', 'idle'],
  maxCalled: 3,
  flash: 0.12,
  phases: [
    { windup: 0.8, attack: 0.6, call: 0.6, vent: 5, idle: 1.5, volleys: 1, gap: 0.3, bolts: 5, spread: 40 * CDA_DEG, boltSpeed: 5, calls: 1 },
    { windup: 0.7, attack: 0.8, call: 0.6, vent: 4.5, idle: 1.2, volleys: 2, gap: 0.3, bolts: 7, spread: 50 * CDA_DEG, boltSpeed: 5.5, calls: 2 },
    { windup: 0.6, attack: 1, call: 0.6, vent: 4, idle: 1, volleys: 2, gap: 0.3, bolts: 9, spread: 60 * CDA_DEG, boltSpeed: 6, calls: 2 }
  ]
};

// Items.  An item gives what its row names: a tool (and, with it, `amount`
// of its ammo), ammo, health (up to the maximum), armour (up to
// CDA_PLAYER.armourMax), a badge for this level, or patches.  An item that
// would change nothing stays on the floor.  Items are drawn a little larger
// than life so they read across a room.
var CDA_ITEMS = [
  { id: 'cell', name: 'Cells', ammo: 'cell', amount: 10, tall: 0.3 },
  { id: 'coil', name: 'Coils', ammo: 'coil', amount: 4, tall: 0.3 },
  { id: 'coffee', name: 'Coffee', health: 15, tall: 0.25 },
  { id: 'medkit', name: 'Medkit', health: 40, tall: 0.32 },
  { id: 'vest', name: 'ESD vest', armour: 50, tall: 0.35 },
  { id: 'key-blue', name: 'Blue badge', badge: 'blue', tall: 0.3 },
  { id: 'key-yellow', name: 'Yellow badge', badge: 'yellow', tall: 0.3 },
  { id: 'key-red', name: 'Red badge', badge: 'red', tall: 0.3 },
  { id: 'patch', name: 'Patch', patch: 1, tall: 0.3 },
  { id: 'probe', name: 'Tone probe', tool: 'probe', ammo: 'cell', amount: 40, tall: 0.35 },
  { id: 'degausser', name: 'Degausser', tool: 'degausser', ammo: 'coil', amount: 8, tall: 0.4 }
];

// Decor: solid ones block bodies (a circle of `radius` at the cell's
// centre) and the enemies' paths; none blocks sight or shots.  w x h: the
// sprite size in pixels (feet on its bottom row; the pillar reaches the
// ceiling).  A solid one's radius is about half the width it is drawn at
// (tall * w / h, less the art's empty margins); the small things you can
// see past (chair, extinguisher, cone, ladder, lamp) do not block.
var CDA_DECOR = [
  { id: 'cart', solid: true, radius: 0.3, w: 32, h: 32, tall: 0.75 },
  { id: 'chair', solid: false, radius: 0, w: 32, h: 32, tall: 0.55 },
  { id: 'spool', solid: true, radius: 0.27, w: 32, h: 32, tall: 0.55 },
  { id: 'crate', solid: true, radius: 0.28, w: 32, h: 32, tall: 0.65 },
  { id: 'extinguisher', solid: false, radius: 0, w: 32, h: 32, tall: 0.4 },
  { id: 'cone', solid: false, radius: 0, w: 32, h: 32, tall: 0.4 },
  { id: 'ladder', solid: false, radius: 0, w: 32, h: 32, tall: 0.95 },
  { id: 'lamp', solid: false, radius: 0, w: 32, h: 32, tall: 0.78 },
  { id: 'pillar', solid: true, radius: 0.22, w: 32, h: 64, tall: 1 }
];

// Enemy projectiles (sim: shots[].kind): how tall the renderer draws them
// (their speed and damage come from the enemy that fires them).
var CDA_SHOTS = [
  { id: 'spark', tall: 0.2 },
  { id: 'bolt', tall: 0.2 },
  { id: 'frost', tall: 0.25 }
];

// Upgrades: six lines of three tiers.  A save keeps the tiers bought per
// line ({ health: 2, ... }; a missing line is 0); cdaNewSim applies them:
// each tier adds `step` to what the line names (probeSpeed: the probe's
// cooldown shrinks by that share per tier).
var CDA_UPGRADES = [
  { id: 'health', name: 'Max health', costs: [3, 5, 8], step: 15 },
  { id: 'cells', name: 'Cell capacity', costs: [3, 5, 8], step: 30 },
  { id: 'probeDamage', name: 'Probe damage', costs: [3, 5, 8], step: 2 },
  { id: 'probeSpeed', name: 'Probe speed', costs: [3, 5, 8], step: 0.1 },
  { id: 'rays', name: 'Degausser ray', costs: [3, 5, 8], step: 1 },
  { id: 'flashlight', name: 'Flashlight', costs: [3, 5, 8], step: 2 }
];

// Patches a level's result gives (cdaLevelPatches): for finishing, per enemy
// destroyed (not the boss's called crawlers), per secret found; patch items
// add theirs on top.
var CDA_REWARDS = { finish: 1, kill: 1, secret: 1 };

// The HUD lines the sim sends as `message` events; {x} is filled in.
var CDA_TEXT = {
  pickup: '{item}',
  locked: '{item} needed',
  lift: 'The lift is locked: {n} infected rack(s) left',
  boss: 'The lift is locked until the chiller is down',
  open: 'Lift unlocked',
  secret: 'A secret!',
  rebooted: 'Rack rebooted'
};

var CDA_TOOL = cdaIndex(CDA_TOOLS);
var CDA_ENEMY = cdaIndex(CDA_ENEMIES);
var CDA_ITEM = cdaIndex(CDA_ITEMS);
var CDA_DEC = cdaIndex(CDA_DECOR);
var CDA_SHOT = cdaIndex(CDA_SHOTS);
var CDA_UPGRADE = cdaIndex(CDA_UPGRADES);

// CDA_TEXT[key] with each {name} replaced by values[name].
function cdaText(key, values) {
  return CDA_TEXT[key].replace(/\{(\w+)\}/g, function (m, name) { return String(values[name]); });
}

CDA_API.CDA_DEG = CDA_DEG;
CDA_API.CDA_PLAYER = CDA_PLAYER;
CDA_API.CDA_TOOLS = CDA_TOOLS;
CDA_API.CDA_TOOL = CDA_TOOL;
CDA_API.CDA_ENEMIES = CDA_ENEMIES;
CDA_API.CDA_ENEMY = CDA_ENEMY;
CDA_API.CDA_DIE_TIME = CDA_DIE_TIME;
CDA_API.CDA_BOSS = CDA_BOSS;
CDA_API.CDA_ITEMS = CDA_ITEMS;
CDA_API.CDA_ITEM = CDA_ITEM;
CDA_API.CDA_DECOR = CDA_DECOR;
CDA_API.CDA_DEC = CDA_DEC;
CDA_API.CDA_SHOTS = CDA_SHOTS;
CDA_API.CDA_SHOT = CDA_SHOT;
CDA_API.CDA_UPGRADES = CDA_UPGRADES;
CDA_API.CDA_UPGRADE = CDA_UPGRADE;
CDA_API.CDA_REWARDS = CDA_REWARDS;
CDA_API.CDA_TEXT = CDA_TEXT;
CDA_API.cdaText = cdaText;
