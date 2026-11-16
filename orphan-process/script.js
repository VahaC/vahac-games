// Orphan Process — script.js
// Prefix: orp-
// Dependencies: none.
//
// A side-view platformer for a desktop keyboard.  The hero is a freshly
// forked process whose parent died; it walks a Linux file system made of
// rooms (ASCII maps, see ROOMS below), levels up its nice value, and gains
// two capabilities: kill (a signal shot) and nice (a dash, shown to the
// player as renice so it is not read as the nice level).
//
// Simulation: orpStep(sim, input) is a pure function (no DOM, no clock): it
// returns the next state one fixed step (1/120 s) later and leaves sim
// alone.  input holds the keys held this step ({ left, right, jump, down,
// shoot, dash }); presses are found against the keys of the step before.
// The page runs orpStep from requestAnimationFrame with an accumulator and
// catches up at most 0.25 s a frame, so a hidden tab never runs a burst of
// piled-up steps.  Drawing only reads the state: a frame draws between the
// last two steps (see orpBetween), on a backing store at the whole scale
// the canvas is shown at (see orpRender).
//
// The hero: a 10x14 hitbox inside its 16x16 sprite, feet on the bottom row.
// Run 96 px/s (ground acceleration 900, air 600), gravity 900, fall at most
// 300, jump 270 (apex about 40 px), releasing the jump early keeps 40 % of
// the upward speed, coyote time 0.08 s and jump buffer 0.10 s.  That gives
// the level design budget: a step up of 2 tiles, a gap of 3 tiles.
//
// Stats: RSS (health, 5 chips), CPU (energy, 100, +20/s) and nice (the
// level, 19 down).  XP from enemies and man pages; each level adds 10 max
// CPU, every second one 1 max RSS and a refill.  RSS 0 kills the process: it
// respawns at the last tty with full RSS and keeps everything it collected.
//
// Saves: orp-state (versioned, v: 2; any other version is no save): the
// run (an id and the wall-clock time New game made it), the last tty, max
// RSS and CPU, XP, nice, abilities, collected ids, switches, broken walls,
// boss, whether the end screen was shown, visited rooms, play time and
// deaths, written whenever one of them changes (and on pause, focus loss, a
// hidden tab and leaving the page).  The hero's position is not saved: a
// reload resumes at the last tty.  Every field is checked on load and falls
// back on its own, and a tty past the gate turns its switch on.  Storage
// that is blocked or full never stops the game, and the last state is also
// kept in memory, so Continue works within the page load.  Before a write
// the stored save is read again: one of the same run with more play time
// (another tab played further) is taken over, and one of a later run (New
// game in another tab) stops this tab's writes; anything else is
// overwritten.
//
// Keys only while the canvas has the focus (a "Click to play" overlay gives
// it): arrows / A D move, Up / W / Space jump, Down + jump drops through a
// platform, X / J signal, C / K dash, M map, P / Esc pause, F fullscreen,
// Enter confirms.  Losing the focus or hiding the tab pauses.
//
// Start-up: under Node (module.exports exists) loading only exports the
// functions for the tests; in a browser orpInit runs on DOMContentLoaded, or
// at once when the page has already loaded.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  var ORP_SAVE_KEY = 'orp-state';
  var ORP_SAVE_VERSION = 2;

  // The screen, in logical pixels, and the tile.
  var ORP_W = 480;
  var ORP_H = 270;
  var ORP_TILE = 16;
  var ORP_HUD_H = 15;

  // The loop: a fixed step and the most a frame catches up.
  var ORP_STEP = 1 / 120;
  var ORP_STEP_MS = 1000 / 120;
  var ORP_MAX_FRAME_MS = 250;

  // The hero (the spec pins these; the tests derive the design budget).
  var ORP_HERO_W = 10;
  var ORP_HERO_H = 14;
  var ORP_RUN = 96;
  var ORP_ACCEL_GROUND = 900;
  var ORP_ACCEL_AIR = 600;
  var ORP_GRAVITY = 900;
  var ORP_MAX_FALL = 300;
  var ORP_JUMP_SPEED = 270;
  var ORP_JUMP_CUT = 0.4;
  var ORP_COYOTE = 0.08;
  var ORP_BUFFER = 0.1;
  var ORP_DROP_TIME = 0.25;
  var ORP_INVULN = 1;
  var ORP_KNOCK_TIME = 0.2;
  var ORP_KNOCK_X = 120;
  var ORP_KNOCK_Y = 150;
  var ORP_DEATH_TIME = 1.2;
  var ORP_LOOK_AHEAD = 24;
  var ORP_EPS = 0.001;

  // Stats and levelling.
  var ORP_START_RSS = 5;
  var ORP_MAX_RSS = 20;
  var ORP_START_CPU = 100;
  var ORP_MAX_CPU = 1000;
  var ORP_CPU_REGEN = 20;
  var ORP_LEVEL_CPU = 10;
  var ORP_START_NICE = 19;
  var ORP_MIN_NICE = -20;
  var ORP_MAN_XP = 10;
  var ORP_DROP_EVERY = 3;

  // Abilities.
  var ORP_SIGNAL_SPEED = 240;
  var ORP_SIGNAL_RANGE = 8 * 16;
  var ORP_SIGNAL_COST = 10;
  var ORP_SIGNAL_COOLDOWN = 0.25;
  var ORP_SIGNAL_W = 10;
  var ORP_SIGNAL_H = 4;
  var ORP_SHOOT_POSE = 0.15;
  var ORP_DASH_TIME = 0.2;
  var ORP_DASH_SPEED = 4 * 16 / 0.2;
  var ORP_DASH_COST = 30;
  var ORP_DASH_COOLDOWN = 0.5;

  // Hazards.
  var ORP_CRUMBLE_DELAY = 0.4;
  var ORP_CRUMBLE_BACK = 3;
  var ORP_SWEEP_EVERY = 20;
  var ORP_SWEEP_GONE = 3;
  var ORP_DENIED_EVERY = 2;

  // Enemies.
  var ORP_BUG_SPEED = 30;
  var ORP_ZOMBIE_SPEED = 24;
  var ORP_ZOMBIE_RANGE = 8 * 16;
  var ORP_ZOMBIE_MAX = 3;
  var ORP_DAEMON_SPAWN = 3;
  var ORP_DAEMON_RANGE = 12 * 16;
  var ORP_TURRET_EVERY = 2;
  var ORP_SHOT_SPEED = 80;
  var ORP_SHOT_LIFE = 6;

  // The boss, tmpfiles.d (the tmp cleaner): 12 HP in three phases of 4, each
  // faster.  Its loop: a wind-up, a sweep along the floor to the other
  // side, a warning (the temporary crates blink), the crates deleted while
  // temp files hang from the ceiling and fall, then its core open for 2 s,
  // the only time a signal hurts it (at most one hit every 0.7 s).  A hit
  // that ends a phase closes the core and it rages for 1 s.
  var ORP_BOSS_HP = 12;
  var ORP_BOSS_W = 26;
  var ORP_BOSS_H = 28;
  var ORP_BOSS_XP = 40;
  var ORP_BOSS_WAKE = 5 * 16;
  var ORP_BOSS_INTRO = 1.5;
  var ORP_BOSS_GONE = 3.5;
  var ORP_BOSS_CORE = 2;
  var ORP_BOSS_HIT_EVERY = 0.7;
  var ORP_BOSS_RAGE = 1;
  var ORP_BOSS_PHASES = [
    { windup: 0.9, speed: 100, warn: 0.6, files: 3, hang: 0.8, fall: 140 },
    { windup: 0.7, speed: 130, warn: 0.5, files: 4, hang: 0.65, fall: 165 },
    { windup: 0.5, speed: 165, warn: 0.4, files: 5, hang: 0.5, fall: 190 }
  ];
  // Temp files: one over the hero, the others every 5 columns from it, one
  // after another.
  var ORP_FILE_SPACING = 5;
  var ORP_FILE_STAGGER = 0.15;
  var ORP_WRECK_TIME = 1.5;
  // After the nice pedestal of the arena, the end-of-episode screen.
  var ORP_END_DELAY = 2.5;
  // The temporary crates blink this long before the sweep deletes them.
  var ORP_SWEEP_WARN = 1;

  // The page.
  var ORP_TOAST_MS = 3000;
  // A message box shows this long of play (paused, on the map or in a
  // hidden tab its time stands still).
  var ORP_MESSAGE_MS = 4500;
  var ORP_MESSAGE_STEPS = Math.round(ORP_MESSAGE_MS / ORP_STEP_MS);
  var ORP_CONFIRM_MS = 4000;
  var ORP_ATLAS_W = 256;
  var ORP_PARALLAX = 0.3;
  var ORP_BANNER_TIME = 2.5;
  // The HUD draws one chip per max RSS up to this many; above it, a compact
  // "rss/max" and a bar of this width.
  var ORP_HUD_CHIPS = 14;
  var ORP_HUD_COMPACT_W = 94;

  var ORP_ABILITIES = ['kill', 'nice'];
  // The names the player reads: the dash keeps its id nice in saves and code,
  // but is shown as renice, so it is never mistaken for the nice level.
  var ORP_ABILITY_NAMES = { kill: 'kill', nice: 'renice' };

  // Keys by value, then by physical key for layouts whose letters are not
  // Latin.  Held actions feed the simulation; the others are commands.
  var ORP_KEYS = {
    arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right',
    arrowup: 'jump', w: 'jump', ' ': 'jump', arrowdown: 'down', s: 'down',
    x: 'shoot', j: 'shoot', c: 'dash', k: 'dash',
    m: 'map', p: 'pause', escape: 'pause', f: 'fullscreen', enter: 'confirm'
  };
  var ORP_CODES = {
    KeyA: 'left', KeyD: 'right', KeyW: 'jump', Space: 'jump', KeyS: 'down', KeyX: 'shoot', KeyJ: 'shoot',
    KeyC: 'dash', KeyK: 'dash', KeyM: 'map', KeyP: 'pause', KeyF: 'fullscreen'
  };
  var ORP_HELD = { left: true, right: true, jump: true, down: true, shoot: true, dash: true };

  // SPRITES BEGIN
  // The art: one palette (a letter per colour; '.' is transparent) and every
  // sprite as ASCII rows, 16x16 unless stated (the boss frames are 32x32), all
  // facing right.  This block is generated by the art tool and replaced as a
  // whole when the art changes: the code only relies on the two names
  // ORP_PALETTE and ORP_SPRITES and on the sprite names of the spec.
  var ORP_PALETTE = {
    k: '#05080f',
    K: '#0d1424',
    a: '#111827',
    A: '#1a2236',
    l: '#2a3a5c',
    G: '#34d399',
    g: '#10b981',
    d: '#0b6b4f',
    D: '#084a38',
    s: '#041a17',
    w: '#e2e8f0',
    c: '#22d3ee',
    C: '#0e7490',
    B: '#3b82f6',
    b: '#1e3a8a',
    y: '#f59e0b',
    Y: '#b45309',
    r: '#ef4444',
    R: '#991b1b',
    P: '#a78bfa',
    p: '#6d28d9',
    m: '#f472b6',
    M: '#9d174d',
    n: '#94a3b8',
    N: '#64748b',
    O: '#d6a05a',
    o: '#8a5a2b',
    e: '#22150c',
    E: '#3d2714'
  };
  var ORP_SPRITES = {
    heroIdle1: [
      '.........c......',
      '.....kkkkkkk....',
      '....kGGGGGGGk...',
      '...kGsssssssGk..',
      '...kGssswsswGk..',
      '...kGssswsswGk..',
      '...kGsssssssGk..',
      '...kgGGGGGGGgk..',
      '....kkkkgkkkk...',
      '....kgGGGGGgk...',
      '...kgkGGGGGkgk..',
      '...kwkgGGGgkwk..',
      '....kkgggggkk...',
      '.....kgk.kgk....',
      '.....kgk.kgk....',
      '.....kkkkkkkk...'
    ],
    heroIdle2: [
      '.........c......',
      '.....kkkkkkk....',
      '....kGGGGGGGk...',
      '...kGsssssssGk..',
      '...kGsssssssGk..',
      '...kGsssnssnGk..',
      '...kGsssssssGk..',
      '...kgGGGGGGGgk..',
      '....kkkkgkkkk...',
      '....kgGGGGGgk...',
      '...kgkGGGGGkgk..',
      '...kwkgGGGgkwk..',
      '....kkgggggkk...',
      '.....kgk.kgk....',
      '.....kgk.kgk....',
      '.....kkkkkkkk...'
    ],
    heroRun1: [
      '.........c......',
      '.....kkkkkkk....',
      '....kGGGGGGGk...',
      '...kGsssssssGk..',
      '...kGssswsswGk..',
      '...kGssswsswGk..',
      '...kGsssssssGk..',
      '...kgGGGGGGGgk..',
      '....kkkkgkkkk...',
      '....kgGGGGGgk...',
      '...kgkGGGGGkgk..',
      '...kwkgGGGgkwk..',
      '....kkgggggkk...',
      '...kgkk...kgk...',
      '..kgk......kgk..',
      '..kkk......kkkk.'
    ],
    heroRun2: [
      '.........c......',
      '.....kkkkkkk....',
      '....kGGGGGGGk...',
      '...kGsssssssGk..',
      '...kGssswsswGk..',
      '...kGssswsswGk..',
      '...kGsssssssGk..',
      '...kgGGGGGGGgk..',
      '....kkkkgkkkk...',
      '....kgGGGGGgk...',
      '...kgkGGGGGkgk..',
      '...kwkgGGGgkwk..',
      '....kkgggggkk...',
      '......kggk......',
      '......kggk......',
      '......kkkkk.....'
    ],
    heroRun3: [
      '.........c......',
      '.....kkkkkkk....',
      '....kGGGGGGGk...',
      '...kGsssssssGk..',
      '...kGssswsswGk..',
      '...kGssswsswGk..',
      '...kGsssssssGk..',
      '...kgGGGGGGGgk..',
      '....kkkkgkkkk...',
      '....kgGGGGGgk...',
      '...kgkGGGGGkgk..',
      '...kwkgGGGgkwk..',
      '....kkgggggkk...',
      '....kgk..kgk....',
      '...kgk....kgk...',
      '...kkk....kkkk..'
    ],
    heroJump: [
      '.........c......',
      '.....kkkkkkk....',
      '....kGGGGGGGk...',
      '...kGsssssssGk..',
      '...kGssswsswGk..',
      '...kGssswsswGk..',
      '..kkGsssssssGkk.',
      '..kwgGGGGGGGgwk.',
      '..kgkkkkgkkkkgk.',
      '...kkgGGGGGgkk..',
      '....kkGGGGGkk...',
      '.....kgGGGgk....',
      '....kkgggggkk...',
      '...kgkk...kkgk..',
      '...kkk.....kkk..',
      '................'
    ],
    heroFall: [
      '.........c......',
      '.....kkkkkkk....',
      '....kGGGGGGGk...',
      '...kGsssssssGk..',
      '...kGssswsswGk..',
      '...kGssswsswGk..',
      '..kkGsssssssGkk.',
      '..kwgGGGGGGGgwk.',
      '..kgkkkkgkkkkgk.',
      '...kkgGGGGGgkk..',
      '....kkGGGGGkk...',
      '.....kgGGGgk....',
      '....kkgggggkk...',
      '....kgk...kgk...',
      '....kgk...kgk...',
      '....kk.....kk...'
    ],
    heroShoot: [
      '.........c......',
      '.....kkkkkkk....',
      '....kGGGGGGGk...',
      '...kGsssssssGk..',
      '...kGssswsswGk..',
      '...kGssswsswGk..',
      '...kGsssssssGk..',
      '...kgGGGGGGGgk..',
      '....kkkkgkkkk...',
      '....kgGGGGGgkkkk',
      '...kgkGGGGGgggwk',
      '...kwkgGGGgkkkk.',
      '....kkgggggkk...',
      '.....kgk.kgk....',
      '.....kgk.kgk....',
      '.....kkkkkkkk...'
    ],
    heroDash: [
      '...........c....',
      '.......kkkkkkk..',
      '......kGGGGGGGk.',
      'CCcc.kGsssssssGk',
      '.....kGssswsswGk',
      '.CccckGssswsswGk',
      '.....kGsssssssGk',
      'CCc..kgGGGGGGGgk',
      '.....kkkkgkkkk..',
      '.....kgGGGGGgk..',
      'Cc..kgkGGGGGkgk.',
      '....kwkgGGGgkwk.',
      'CCcckkgggggkk...',
      '..kkgkk...kgk...',
      'kkggk......kgk..',
      'kkkk.......kkkk.'
    ],
    heroHurt: [
      '.......c........',
      '....kkkkkkk.....',
      '...kGGGGGGGk..w.',
      '..kGsssssssGk...',
      '..kGrsssssrGk.ww',
      '..kGsrsssrsGk...',
      '..kGrsssssrGk.w.',
      '..kgGGGGGGGgk...',
      '....kkkkgkkkk...',
      '...kkgGGGGGgk...',
      '..kwkkGGGGGkgk..',
      '..kk.kgGGGgkwk..',
      '....kkgggggkk...',
      '....kgk..kgk....',
      '....kgk...kgk...',
      '...kkkk...kkkk..'
    ],
    heroDead1: [
      '.........c......',
      '......kk.kk.k...',
      '.....kGG.GGG.k..',
      '.............Gr.',
      '.kG..ss.s.Gk....',
      '.kGsrsssrsGk....',
      '..Gr.ss.srGk....',
      '...k.GGGGGGGgk..',
      '.r.G............',
      '......kkgGGGGGgk',
      '.....k.kkGGGGGk.',
      '.....kk.kgGGGgkw',
      '...kkgggggkk....',
      '.....gk.kgk.....',
      '....kgk.k.k.....',
      '....kkk.kkkk....'
    ],
    heroDead2: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '...........G....',
      '......s.s.......',
      '...s.ss.s.G...G.',
      '...kkk..........',
      '...kGs..G..kk...',
      '...kGk....gsk...',
      '........w.......'
    ],
    bug1: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '...k........k...',
      '....k......k....',
      '....kkkkkkkk....',
      '...krrrrrrrrk...',
      '..krrwkrrwkrrk..',
      '..krrrrrrrrrrk..',
      '.kkrRrrrrrrRrkk.',
      'k.kkkkkkkkkkkk.k',
      '..k..k....k..k..',
      '.k...k....k...k.'
    ],
    bug2: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '....k......k....',
      '....k......k....',
      '....kkkkkkkk....',
      '...krrrrrrrrk...',
      '..krrwkrrwkrrk..',
      '..krrrrrrrrrrk..',
      '.kkrRrrrrrrRrkk.',
      '..kkkkkkkkkkkk..',
      '.k..k......k..k.',
      'k....k....k....k'
    ],
    zombie1: [
      '................',
      '.....kkkkkk.....',
      '...kkPPPPPPkk...',
      '..kPPPPPPPPPPk..',
      '.kPPPPPPPPPPPPk.',
      '.kPPkkPPPPkkPPk.',
      '.kPPkrPPPPkrPPk.',
      '.kPPPPPPPPPPPPk.',
      '.kPPPkkkkkkPPPk.',
      '.kPPPwkwkwkPPPk.',
      '.kpPPkkkkkkPPpk.',
      '.kpPPPPPPPPPPpk.',
      '.kppPPPPPPPPppk.',
      '.kpppPPppPPpppk.',
      '.kpk.kppppk.kpk.',
      '..k...kkkk...k..'
    ],
    zombie2: [
      '.....kkkkkk.....',
      '...kkPPPPPPkk...',
      '..kPPPPPPPPPPk..',
      '.kPPPPPPPPPPPPk.',
      '.kPPkkPPPPkkPPk.',
      '.kPPkrPPPPkrPPk.',
      '.kPPPPPPPPPPPPk.',
      '.kPPPkkkkkkPPPk.',
      '.kPPPwkwkwkPPPk.',
      '.kpPPkkkkkkPPpk.',
      '.kpPPPPPPPPPPpk.',
      '.kppPPPPPPPPppk.',
      '.kpppPPppPPpppk.',
      '..kppk.kk.kppk..',
      '...kk......kk...',
      '................'
    ],
    daemon1: [
      '..krk......krk..',
      '..kkkkkkkkkkkk..',
      '..knnnnnnnnnnk..',
      '..knNNNNNNNNlk..',
      '..knNkkNNkkNlk..',
      '..knNkyNNkyNlk..',
      '..knNNNNNNNNlk..',
      '..knNkkkkkkNlk..',
      '..knNkmkkmkNlk..',
      '..knNNmNNmNNlk..',
      '..knNNmNNNNNlk..',
      '..klllmllllllk..',
      '..kkkkmkkkkkkk..',
      '..knk.m....knk..',
      '..knk......knk..',
      '..kkkmmmm..kkk..'
    ],
    daemon2: [
      '..krk......krk..',
      '..kkkkkkkkkkkk..',
      '..knnnnnnnnnnk..',
      '..knNNNNNNNNlk..',
      '..knNkkNNkkNlk..',
      '..knNkyNNkyNlk..',
      '..knNNNNNNNNlk..',
      '..knNkkkkkkNlk..',
      '..knNkmkkmkNlk..',
      '..knNNmNNmNNlk..',
      '..knNNNNNmNNlk..',
      '..kllllllmlllk..',
      '..kkkkkkkmkkkk..',
      '..knk.m....knk..',
      '..knk.m..m.knk..',
      '..kkkmmmmmmkkk..'
    ],
    daemonHurt: [
      '..krk......krk..',
      '..kkkkkkkkkkkk..',
      '..kwwwwwwwwwwk..',
      '..kwnnnnnnnnNk..',
      '..kwnkknnkknNk..',
      '..kwnkrnnkrnNk..',
      '..kwnnnnnnnnNk..',
      '..kwnkkkkkknNk..',
      '..kwnkmkkmknNk..',
      '..kwnnmnnmnnNk..',
      '..kwnnmnnnnnNk..',
      '..kNNNmNNNNNNk..',
      '..kkkkmkkkkkkk..',
      '..kwk.m....kwk..',
      '..kwk......kwk..',
      '..kkkmmmm..kkk..'
    ],
    turret1: [
      '................',
      '.....kkkkk......',
      '....knnnnnk.....',
      '...knkkkkknk....',
      '...knk...knk....',
      '...knk...knk....',
      '.kkkkkkkkkkkk...',
      '.kOyyyyyyyyyk...',
      '.kyYYYYYYYYYkkkk',
      '.kyYYYkkYYYYnnnk',
      '.kyYYYkkYYYYNNNk',
      '.kyYYYYkYYYYkkkk',
      '.kyYYYYkYYYYk...',
      '.kyYYYYYYYYYk...',
      '.kkkkkkkkkkkk...',
      '..kNNNNNNNNk....'
    ],
    turret2: [
      '................',
      '.....kkkkk......',
      '....knnnnnk.....',
      '...knkkkkknk....',
      '...knk...knk....',
      '...knk...knk....',
      '.kkkkkkkkkkkk...',
      '.kOyyyyyyyyyk...',
      '.kyYYYYYYYYYkkkk',
      '.kyYYYrrYYYYnyyw',
      '.kyYYYryYYYYNYyy',
      '.kyYYYYrYYYYkkkk',
      '.kyYYYYrYYYYk...',
      '.kyYYYYYYYYYk...',
      '.kkkkkkkkkkkk...',
      '..kNNNNNNNNk....'
    ],
    turretShot: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '........kkkk....',
      '.....Y.kryyOk...',
      '..Y.YYkrryywOk..',
      '.....Y.kryyOk...',
      '........kkkk....',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    bossIdle: [
      '..............kkkk..............',
      '.............kYYYYk.............',
      '.............kYYYYk.............',
      '.............kYYYYk.............',
      '........kkkkkNNNNNNkkkkkkk......',
      '.......knnnnnnnnnnnnnnnnnnk.....',
      '....kkkkNNNNNNNNNNNNNNNNNNkk....',
      '...knnnnnnnnnnnnnkkkkknnnnnnk...',
      '..knNNNNNNNNNNNNNkkkkkkkkkkNlk..',
      '..knNllllllNNNNNNkKKKrrwrKkNlk..',
      '..knNNNNNNNNNNNNNkKKRrrrrRkNlk..',
      '..knNllllllNNNNNNkkkkkkkkkkNlk..',
      '..knNNkkkkkkkkkkkkNNNNNNNNNNlk..',
      '..knNlkNNNNNkNNNNkNNnNNNNNnNlk..',
      '..knNNklnlllkllnlkNNNNNNNNNNlk..',
      '..knNNklllllkllllkNllllllllllk..',
      '..knNNkllllyyllllkNNNNNNNNNNlk..',
      '..knNNkllllYYllllkNNnNNNNNnNlk..',
      '..knNNklllllkllllkNNNNNNNNNNlk..',
      '..knNNklnlllkllnlkNNNNNNNNNNlk..',
      '..knNNklllllkllllkNNNNNNNNNNlk..',
      '..knNNkkkkkkkkkkkkNNNNNNNNNNlk..',
      '..kyKKyyKKyyKKyyKKyyKKyyKKyyKk..',
      '..kyyKKyyKKyyKKyyKKyyKKyyKKyyk..',
      '...kkkAAAAAAAAAAAAAAAAAAAAkkk...',
      '...kkYYYYYYYYYYYYYYYYYYYYYYkk...',
      '..kOOooOOooOOooOOooOOooOOooOOk..',
      '.kOOooOOooOOoonknnOOooOOooOOook.',
      'kOOooOOooOOooOnnknOooOOooOOooOOk',
      'kOoOoOoOoOoOoOoOoOoOoOoOoOoOoOok',
      '.koOoOoOoOoOoOoOoOoOoOoOoOoOoOk.',
      '..kkokokokokokokokokokokokokkk..'
    ],
    bossSweep1: [
      '............y.kkkk.y............',
      '.............kOwyyk.............',
      '...........Y.kyyyyk.Y...........',
      '.............kyyyyk.............',
      '........kkkkkNNNNNNkkkkkkk......',
      '.......knnnnnnnnnnnnnnnnnnk.....',
      '....kkkkNNNNNNNNNNNNNNNNNNkk....',
      '...knnnnnnnnnnnnnkkkkknnnnnnk...',
      '..knNNNNNNNNNNNNNkkkkkkkkkkNlk..',
      '..knNllllllNNNNNNkKKKrrwrKkNlk..',
      '..knNNNNNNNNNNNNNkKKRrrrrRkNlk..',
      '..knNllllllNNNNNNkkkkkkkkkkNlk..',
      '..knNNkkkkkkkkkkkkNNNNNNNNNNlk..',
      '..knNlkNNNNNkNNNNkNNnNNNNNnNlk..',
      '..knNNklnlllkllnlkNNNNNNNNNNlk..',
      '..knNNklllllkllllkNllllllllllk..',
      '..knNNkllllyyllllkNNNNNNNNNNlk..',
      '..knNNkllllYYllllkNNnNNNNNnNlk..',
      '..knNNklllllkllllkNNNNNNNNNNlk..',
      '..knNNklnlllkllnlkNNNNNNNNNNlk..',
      '..knNNklllllkllllkNNNNNNNNNNlk..',
      '..knNNkkkkkkkkkkkkNNNNNNNNNNlk.N',
      'N.kyKKyyKKyyKKyyKKyyKKyyKKyyKk..',
      '..kyyKKyyKKyyKKyyKKyyKKyyKKyykN.',
      'N..kkkAAAAAAAAAAAAAAAAAAAAkkkn.n',
      '...kkYYYYYYYYYYYYYYYYYYYYYYkk...',
      '..kOOooOOooOOooOOooOOooOOooOOk..',
      '.kOOooOOooOOoonknnOOooOOooOOook.',
      'kOOooOOooOOooOnnknOooOOooOOooOOk',
      'kOoOoOoOoOoOoOoOoOoOoOoOoOoOoOok',
      '.koOoOoOoOoOoOoOoOoOoOoOoOoOoOk.',
      '..kkokokokokokokokokokokokokkk..'
    ],
    bossSweep2: [
      '..............kkkk..............',
      '.............kYYYYk.............',
      '.............kYYYYk.............',
      '.............kYYYYk.............',
      '........kkkkkNNNNNNkkkkkkk......',
      '.......knnnnnnnnnnnnnnnnnnk.....',
      '....kkkkNNNNNNNNNNNNNNNNNNkk....',
      '...knnnnnnnnnnnnnkkkkknnnnnnk...',
      '..knNNNNNNNNNNNNNkkkkkkkkkkNlk..',
      '..knNllllllNNNNNNkKKKrrwrKkNlk..',
      '..knNNNNNNNNNNNNNkKKRrrrrRkNlk..',
      '..knNllllllNNNNNNkkkkkkkkkkNlk..',
      '..knNNkkkkkkkkkkkkNNNNNNNNNNlk..',
      '..knNlkNNNNNkNNNNkNNnNNNNNnNlk..',
      '..knNNklnlllkllnlkNNNNNNNNNNlk..',
      '..knNNklllllkllllkNllllllllllk..',
      '..knNNkllllyyllllkNNNNNNNNNNlk..',
      '..knNNkllllYYllllkNNnNNNNNnNlk..',
      '..knNNklllllkllllkNNNNNNNNNNlk..',
      '..knNNklnlllkllnlkNNNNNNNNNNlk..',
      '..knNNklllllkllllkNNNNNNNNNNlk..',
      '..knNNkkkkkkkkkkkkNNNNNNNNNNlk..',
      '..kyKKyyKKyyKKyyKKyyKKyyKKyyKkn.',
      '..kyyKKyyKKyyKKyyKKyyKKyyKKyyk..',
      '.N.kkkAAAAAAAAAAAAAAAAAAAAkkk...',
      '...kkYYYYYYYYYYYYYYYYYYYYYYkk.n.',
      'N.kooOOooOOooOOooOOooOOooOOook.N',
      '.kooOOooOOooOOnknnooOOooOOooOOk.',
      'kooOOooOOooOOonnknoOOooOOooOOook',
      'koOoOoOoOoOoOoOoOoOoOoOoOoOoOoOk',
      '.kOoOoOoOoOoOoOoOoOoOoOoOoOoOok.',
      '..kkkokokokokokokokokokokokokk..'
    ],
    bossOpen: [
      '............y.kkkk.y............',
      '.............kOwyyk.............',
      '...........Y.kyyyyk.Y...........',
      '.............kyyyyk.............',
      '........kkkkkNNNNNNkkkkkkk......',
      '.......knnnnnnnnnnnnnnnnnnk.....',
      '....kkkkNNNNNNNNNNNNNNNNNNkk....',
      '...knnnnnnnnnnnnnkkkkknnnnnnk...',
      '..knNNNNNNNNNNNNNkkkkkkkkkkNlk..',
      '..knNllllllNNNNNNkKKKrrwrKkNlk..',
      '..knNNNNNNNNNNNNNkKKRrrrrRkNlk..',
      '..knNllllllNNNNNNkkkkkkkkkkNlk..',
      '..knNNkkkkkkkkkkkkNNNNNNNNNNlk..',
      '..knNlklmaaMMaaMlkNNnNNNNNnNlk..',
      '..knNNklaMMmmMMalkNNNNNNNNNNlk..',
      '..knNNklaMmmmmMalkNllllllllllk..',
      '..knNNklMmmwwmmMlkNNNNNNNNNNlk..',
      '..knNNklMmmwwmmMlkNNnNNNNNnNlk..',
      '..knNNklaMmmmmMalkNNNNNNNNNNlk..',
      '..knNNklaMMmmMMalkNNNNNNNNNNlk..',
      '..knNNklMaaMMaamlkNNNNNNNNNNlk..',
      '..knNNkkkkkkkkkkkkNNNNNNNNNNlk..',
      '..kyKKyyKKyyKKyyKKyyKKyyKKyyKk..',
      '..kyyKKyyKKyyKKyyKKyyKKyyKKyyk..',
      '...kkkAAAAAAAAAAAAAAAAAAAAkkk...',
      '...kkYYYYYYYYYYYYYYYYYYYYYYkk...',
      '..kOOooOOooOOooOOooOOooOOooOOk..',
      '.kOOooOOooOOoonknnOOooOOooOOook.',
      'kOOooOOooOOooOnnknOooOOooOOooOOk',
      'kOoOoOoOoOoOoOoOoOoOoOoOoOoOoOok',
      '.koOoOoOoOoOoOoOoOoOoOoOoOoOoOk.',
      '..kkokokokokokokokokokokokokkk..'
    ],
    bossHurt: [
      '............y.kkkk.y............',
      '.............kOwyyk.............',
      '...........Y.kyyyyk.Y...........',
      '.............kyyyyk.............',
      '........kkkkknnnnnnkkkkkkk......',
      '.......kwwwwwwwwwwwwwwwwwwk.....',
      '....kkkknnnnnnnnnnnnnnnnnnkk....',
      '...kwwwwwwwwwwwwwkkkkkwwwwwwk...',
      '..kwnnnnnnnnnnnnnkkkkkkkkkknNk..',
      '..kwnNNNNNNnnnnnnkKKKwwwwKknNk..',
      '..kwnnnnnnnnnnnnnkKKRwwwwRknNk..',
      '..kwnNNNNNNnnnnnnkkkkkkkkkknNk..',
      '..kwnnkkkkkkkkkkkknnnnnnnnnnNk..',
      '.wkwnNkNaaammaaaNknnwnnnnnwnNk..',
      '..kwnnkNammwwmmaNknnnnnnnnnnNk..',
      '..kwnnkNamwwwwmaNknNNNNNNNNNNk..',
      '..kwnnkNmwwwwwwmNknnnnnnnnnnNk..',
      'w.kwnnkNmwwwwwwmNknnwnnnnnwnNk..',
      '..kwnnkNamwwwwmaNknnnnnnnnnnNk..',
      '..kwnnkNammwwmmaNknnnnnnnnnnNk..',
      '.wkwnnkNaaammaaaNknnnnnnnnnnNk..',
      '..kwnnkkkkkkkkkkkknnnnnnnnnnNk..',
      '..kyKKyyKKyyKKyyKKyyKKyyKKyyKk..',
      '..kyyKKyyKKyyKKyyKKyyKKyyKKyyk..',
      '...kkkllllllllllllllllllllkkk...',
      '...kkYYYYYYYYYYYYYYYYYYYYYYkk...',
      '..kOOooOOooOOooOOooOOooOOooOOk..',
      '.kOOooOOooOOoowkwwOOooOOooOOook.',
      'kOOooOOooOOooOwwkwOooOOooOOooOOk',
      'kOoOoOoOoOoOoOoOoOoOoOoOoOoOoOok',
      '.koOoOoOoOoOoOoOoOoOoOoOoOoOoOk.',
      '..kkokokokokokokokokokokokokkk..'
    ],
    bossDead: [
      '............Nn..NN..............',
      '...........N.kk...n.............',
      '............kNYkk...............',
      '............kNNNNk..............',
      '........kkkkkNNNNkkkkkkkkk......',
      '.......knnnnnnnnnnnnnnnnnnk.....',
      '....kkkkNNNNNNNNNNNNNNNNNNkk....',
      '...knnnnnknnnnnnnkkkkknnnnnnk...',
      '..knNNNNNNnNNNNNNkkkkkkkkkkNlk..',
      '..knNllllllkNNNNNkaaaaaaaakNlk..',
      '..knNNNNNNNkNNNNNkaaaRaaaakNlk..',
      '..knNllllllNkNNNNkkkkkkkkkkNlk..',
      '..knNNkkkkkkkkkkkkNNNNNNNNNNlk..',
      '..knNlklaaaaaaaalkNNnNNNkNnNlk..',
      '.yknNNklaakRRRaalkNNNNNkNNNNlk..',
      '..knNNklaRMkMMRalkNlllnklllllk.Y',
      '..YnNNklaRMkaMRalkNNNNkNNNNNlk..',
      '..knNNklaRMMkMRalkNNnNkNNNnNlky.',
      '..knNNklaRMMkMRalkNNNkNNNNNNlk..',
      '..knNNklaaRRRkaalkNNNNkNNNNNlk..',
      '..knNNklaaaaaaaalkNNNNkNNNNNlk..',
      '..knNNkkkkkkkkkkkkNNNNNkNNNNlk..',
      '..kyKKyyKKyyKKyyKKyyKKyyKKyyKk..',
      '..kyyKKyyKKyyKKyyKKyyKKyyKKyyk..',
      '...kkkAAAAAAAAAAAAAAAAAAAAkkk...',
      '...kkYYYYYYYYYYYYYYYYYYYYYYkk...',
      '..kYooYooYooYooYooYooYooYooYok..',
      '.koYooYooYooYoNkNNYooYooYooYook.',
      'kooYooYooYooYoNNkNYooYooYooYooYk',
      'kooYooYooYooYooYooYooYooYooYooYk',
      '.koYooYooYooYooYooYooYooYooYook.',
      '..kYooYooYooYooYooYooYooYooYok..'
    ],
    tempFile: [
      '....n..n..n.....',
      '.......n........',
      '...kkkkkkkk.....',
      '...kOOOOOOkk....',
      '...kOOOOOOkOk...',
      '...kOOOOOOkkkk..',
      '...kOyyyyOOOOk..',
      '...kOOOOOOOOOk..',
      '...kOOrrOOrOOk..',
      '...kOrOOrrOOOk..',
      '...kOyyyyyyOOk..',
      '...kOOOOOOOOOk..',
      '...kkkkkkkkkkk..',
      '................',
      '................',
      '................'
    ],
    signal1: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '.....kkkkkk.....',
      '..kkkcccccwk....',
      '.kCCccwwwwwwk...',
      '..kkkcccccwk....',
      '.....kkkkkk.....',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    signal2: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '......kkkkkk....',
      '.C..kkcccwwwk...',
      'C.CCcwwwwwwwwk..',
      '.C..kkcccwwwk...',
      '......kkkkkk....',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    spark1: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '.......y........',
      '.......y........',
      '.....yywyy......',
      '.......y........',
      '.......y........',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    spark2: [
      '................',
      '................',
      '................',
      '.......y........',
      '....y..y..y.....',
      '.....y.w.y......',
      '......www.......',
      '..yyywwwwwyyy...',
      '......www.......',
      '.....y.w.y......',
      '....y..y..y.....',
      '.......y........',
      '................',
      '................',
      '................',
      '................'
    ],
    spark3: [
      '................',
      '.......Y........',
      '..Y.........Y...',
      '................',
      '................',
      '................',
      '................',
      'y.............y.',
      '................',
      '................',
      '................',
      '................',
      '..Y.........Y...',
      '.......Y........',
      '................',
      '................'
    ],
    dust1: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '.....nn...nn....',
      '....nNnn.nnNn...',
      '...NNnnN.NnnNN..',
      '................'
    ],
    dust2: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '..nn........nn..',
      '.nNNn......nNNn.',
      '..nN..n..n..Nn..',
      '................'
    ],
    reap1: [
      '................',
      '.......p........',
      '...ppPPPPPPpp...',
      '...P..P...PP....',
      '.pPPPPPPPPPPPPp.',
      '...Pp..P..p.....',
      '.pPPpwPPPPpwPPp.',
      '...P.P....PP....',
      '.pPPPppppppPPPp.',
      '.p..Pw.w....PP..',
      '.ppPPppppppPPpp.',
      '....P.....P.....',
      '.pppPPPPPPPPppp.',
      '..p..........p..',
      '.ppp.pppppp.ppp.',
      '.............p..'
    ],
    reap2: [
      '......pP.P..p...',
      '..PP.....P..p...',
      '.....p.P........',
      '..P...P..P......',
      '..p.P........p..',
      '..Pp...P........',
      '.....P...p.p.P..',
      '...P.p....p.....',
      '..P.PPPP...p....',
      '...P...p..p.Pp..',
      '......pP........',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    reap3: [
      '.......w........',
      '...........P....',
      '....P...........',
      '................',
      '.........p...p..',
      '..p.............',
      '......P.........',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    man: [
      '................',
      '................',
      '...kkkkkkkk.....',
      '...kwwwwwwkk....',
      '...kwwwwwwkwk...',
      '...kwBBBBwkkk...',
      '...kwwwwwwwwk...',
      '...kwnnnnnnwk...',
      '...kwwwwwwwwk...',
      '...kwnnnnnwwk...',
      '...kwwwwwwwwk...',
      '...kwnnnnnnwk...',
      '...kwwwwwwwwk...',
      '...kkkkkkkkkk...',
      '................',
      '................'
    ],
    chip: [
      '................',
      '................',
      '....k.k.k.k.....',
      '....n.n.n.n.....',
      '...kkkkkkkkk....',
      '.knkmmmmmmmknk..',
      '...kmMMMMMmk....',
      '.knkmMwMMMmknk..',
      '...kmMMMMMmk....',
      '.knkmMMMMMmknk..',
      '...kmmmmmmmk....',
      '...kkkkkkkkk....',
      '....n.n.n.n.....',
      '....k.k.k.k.....',
      '................',
      '................'
    ],
    module: [
      '.......kkk......',
      '.......kmk......',
      '.....kkkmkkk....',
      '.....kmmwmmk....',
      '.....kkkmkkk....',
      '.......kmk......',
      '.kkkkkkkkkkkkkkk',
      '.kGGGGGGGGGGGGGk',
      '.kgAAAgAAAgAAAgk',
      '.kgaaagaaagaaagk',
      '.kgaaagaaagaaagk',
      '.kggggggggggggdk',
      '.kyDyDyDkyDyDyDk',
      '.kkkkkkkkkkkkkkk',
      '................',
      '................'
    ],
    capKill: [
      '................',
      '.......kk.......',
      '......kcck......',
      '.....wcccck.....',
      '....wcccccck....',
      '...kcccwwccck...',
      '..kcccwwccccck..',
      '.kcccwwwwccccck.',
      '.kCCCCwwCCCCCCk.',
      '..kCCwwCCCCCCk..',
      '...kCCCCCCCCk...',
      '....kCCCCCCk....',
      '.....kCCCCk.....',
      '......kCCk......',
      '.......kk.......',
      '................'
    ],
    capNice: [
      '.......kk.......',
      '....kkkkkkkk....',
      '...kkPPPPPPkk...',
      '..kPwwPPPPpPpk..',
      '.kkwPPPPPppppkk.',
      '.kPPPPPPppppppk.',
      '.kPPPwPpwpppppk.',
      'kkPPPwwpwwppppkk',
      'kkPPPpwwpwwpppkk',
      '.kPPpwwpwwppppk.',
      '.kPppwppwpppppk.',
      '.kkPpppppppppkk.',
      '..kppppppppppk..',
      '...kkppppppkk...',
      '....kkkkkkkk....',
      '.......kk.......'
    ],
    ttyOff: [
      '................',
      '.kkkkkkkkkkkkkk.',
      '.knnnnnnnnnnnnk.',
      '.knssssssssssnk.',
      '.knsDssssssssnk.',
      '.knssDsssssssnk.',
      '.knsDssssssssnk.',
      '.knssssssssssnk.',
      '.knnnnnnnnnRnnk.',
      '.kkkkkkkkkkkkkk.',
      '......kNNk......',
      '......kNNk......',
      '....kkkNNkkk....',
      '....knnnnnnk....',
      '....kkkkkkkk....',
      '................'
    ],
    ttyOn: [
      '................',
      '.kkkkkkkkkkkkkk.',
      '.knnnnnnnnnnnnk.',
      '.knssssssssssnk.',
      '.knsGssssssssnk.',
      '.knssGsssssssnk.',
      '.knsGssGGGsssnk.',
      '.knssssssssssnk.',
      '.knnnnnnnnnGnnk.',
      '.kkkkkkkkkkkkkk.',
      '......kNNk......',
      '......kNNk......',
      '....kkkNNkkk....',
      '....knnnnnnk....',
      '....kkkkkkkk....',
      '................'
    ],
    switchOff: [
      '.......kk.......',
      '.....kknnkk.....',
      '....knnnnnnk....',
      '...knnRRRRnnk...',
      '...knRrrrrRnk...',
      '..knnRkkkkRnnk..',
      '..knnRrrrrRnnk..',
      '...knRrrrrRnk...',
      '...knnRRRRnnk...',
      '....knnnnnnk....',
      '.....kknnkk.....',
      '......kkkk......',
      '......kNNk......',
      '...kkkkkkkkkk...',
      '...knnnnnnRnk...',
      '...kkkkkkkkkk...'
    ],
    switchOn: [
      '.......kk.......',
      '.....kknnkk.....',
      '....knnnnnnk....',
      '...knnggggnnk...',
      '...kngwwGGgnk...',
      '..knngwGGGgnnk..',
      '..knngGGGGgnnk..',
      '...kngGGGGgnk...',
      '...knnggggnnk...',
      '....knnnnnnk....',
      '.....kknnkk.....',
      '......kkkk......',
      '......kNNk......',
      '...kkkkkkkkkk...',
      '...knnnnnnGnk...',
      '...kkkkkkkkkk...'
    ],
    groundTop: [
      'GGGGGGGGGGGGGGGG',
      'ggGggggGggggGggg',
      'dddddddddddddddd',
      'DDDDDDDDDDDDDDDD',
      'aaaDDaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaDa',
      'aaaaaaaaaaaaaaDa',
      'aaaaaaDaaaaaaaaa',
      'aaydddddddddaaaa',
      'aaaaaDDaaaaadaaa',
      'aaaaaDaaaaaadDaa',
      'aaaaaaaaaaDadaaa',
      'aaaaaaaaaaaadaaa',
      'aaaaaaDaaaDayaaa',
      'aaDaaaaaaaaDaaaa'
    ],
    ground: [
      'aDDaaaaaDDaaaDaa',
      'aaaDaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaa',
      'DaaDaDaaaaaaaaaa',
      'DaDaaaaDaaaaDaaa',
      'aaaaddddddddddya',
      'aaaadaaaaaaaaaaa',
      'aaaadaaaaaaaaaDa',
      'aaaadaaDaaDaaaaa',
      'aaaadaaaaDaaaaaa',
      'aaaadDDaaaaDaaDD',
      'aaaadaDaaaaaDDaa',
      'aaaDyaaDaaaaaaaa',
      'aDDaaaaaaaaDaaaa',
      'aaaaaaaaaaDaaDaa',
      'aaaaaaaaDaaaaaaD'
    ],
    groundPlain: [
      'aaaaaaaDaDaaaDaa',
      'aaaaaaaaaaaaaaaa',
      'aaaDaaaaaaaaaaaa',
      'aDaDaaaaaaaaaaaa',
      'aaaDaaaaaaDaaDaa',
      'aaaaaaaaDaDaaaaa',
      'aaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaDa',
      'aDaDaaaaaaaaaaaa',
      'aaaDaaaDaaaaaaaD',
      'aaaaaaDaaaaaaDDa',
      'aDaaaaaaaaaaaaDa',
      'aaaaaaDaaaDaaaaa',
      'Daaaaaaaaaaaaaaa',
      'aaaDaaaaaaaaDaaa',
      'aaaDaaaaDaaaaaaa'
    ],
    platform: [
      'kkkkkkkkkkkkkkkk',
      'knnnnnnnnnnnnnnk',
      'kNlNlNlNlNlNlNlk',
      'kNlNlNlNlNlNlNlk',
      'kNlNlNlNlNlNlNlk',
      'kNlNlNlNlNlNlNlk',
      'kkkkkkkkkkkkkkkk',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    spikes: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '...ww......ww...',
      '...ww......ww...',
      '..nrrn....nrrn..',
      '..nrrn....nrrn..',
      '.nrrrrn..nrrrrn.',
      '.nrrrrn..nrrrrn.',
      'nrrrrrrnnrrrrrrn',
      'RRRRRRRRRRRRRRRR'
    ],
    cracked: [
      'lllllllllkllllll',
      'lAAlAAAAAkAAAlAk',
      'lAAAAAAAknAAlAAk',
      'lAAAAAAAknAAAAlk',
      'lAAlAAAAAkAAAAAk',
      'lAAAAAllAAknAAAk',
      'lAAAAAAAAknkknAk',
      'lAAAAAlAkAlAAkkk',
      'kklAAlkkAAAAlAAk',
      'lAkkkknAknAAAAAk',
      'lAAAAAAAkAAAAAlk',
      'lAAAlAAknkklAAAk',
      'lAAAAAklAAAknAAk',
      'lAAAAklAAAAAAAAk',
      'lAAAAAkAAAAAAAlk',
      'lkkkkkkkkkkkkkkk'
    ],
    doorTop: [
      '....kkkkkkkk....',
      '...kcccccccck...',
      '..kcKKbKKKbKck..',
      '..kcKbKKKbKKck..',
      '..kcbKKKbKKKck..',
      '..kcKKKbKKKbck..',
      '..kcKKyyyybKck..',
      '..kcKbykkyKKck..',
      '..kcbKykkyKKck..',
      '..kcKKykkyKbck..',
      '..kcKKyyyybKck..',
      '..kcKbKKKbKKck..',
      '..kcbKKKbKKKck..',
      '..kcKKKbKKKbck..',
      '..kcKKbKKKbKck..',
      '..kcKbKKKbKKck..'
    ],
    doorBottom: [
      '..kcbKKKbKKKck..',
      '..kcKKKbKKKbck..',
      '..kcKKbKKKbKck..',
      '..kcKbKKKbKKck..',
      '..kcbKKKbKKKck..',
      '..kcKKKbKKKbck..',
      '..kcKKbKKKbKck..',
      '..kcKbKKKbKKck..',
      '..kcbKKKbKKKck..',
      '..kcKKKbKKKbck..',
      '..kcKKbKKKbKck..',
      '..kcKbKKKbKKck..',
      '..kcbKKKbKKKck..',
      '..kcKKKbKKKbck..',
      '..kcKKbKKKbKck..',
      '..kkkkkkkkkkkk..'
    ],
    gate: [
      'knNk.knNk.knNk.k',
      'knNk.knNk.knNk.k',
      'knNk.knNk.knNk.k',
      'knNk.knNk.knNk.k',
      'knNk.knNk.knNk.k',
      'knNk.knNk.knNk.k',
      'kkkkkkkkkkkkkkkk',
      'KyyKKykrrkyKKyyK',
      'yyKKyykRRkKKyyKK',
      'kkkkkkkkkkkkkkkk',
      'knNk.knNk.knNk.k',
      'knNk.knNk.knNk.k',
      'knNk.knNk.knNk.k',
      'knNk.knNk.knNk.k',
      'knNk.knNk.knNk.k',
      'knNk.knNk.knNk.k'
    ],
    decor1: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '....kkkkkkkk....',
      '...kOrOyOgOOk...',
      'kkkkOrOyOgOOkkkk',
      'knnnOrOyOgOOnnnk',
      'knkkOrOyOgOOkknk',
      'knk.kkkkkkkk.knk',
      'knk..........knk',
      'knk..........knk'
    ],
    decor2: [
      '................',
      '................',
      '................',
      '.....kkkkkk.....',
      '....kNnnnnNk....',
      '....kBBBBnbk....',
      '....kBBBBkbk....',
      '....kBBBBnbk....',
      '....kBBBBnbk....',
      '....kBBBBkbk....',
      '....kBBBBnbk....',
      '....kbBBBnbk....',
      '....kkkkkkkk....',
      '.....knk.knk....',
      '.....knk.knk....',
      '.....knk.knk....'
    ],
    decor3: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '..kkkkkkkkkkkk..',
      '..klllllllllAk..',
      '..kAnAAAAAAAAk..',
      '..kaaaaaaaaaak..',
      '..kkkkkkkkkkkk..',
      '...knknknknknk..',
      '...knknknknknk..',
      '...knknknknknk..'
    ],
    decor4: [
      '................',
      '................',
      '................',
      '................',
      '......kkkk......',
      '.....krrwrk.....',
      '....krrrwrrk....',
      '....krrrrrrk....',
      '....krrrrrrk....',
      '....kRrrrrRk....',
      '...kkkkkkkkkk...',
      '...kRRRRRRRRk...',
      '...kkkkkkkkkk...',
      '.....knk.knk....',
      '.....knk.knk....',
      '.....knk.knk....'
    ],
    tmpTop: [
      'yyyyyyyyyyyyyyyy',
      'YYYOYYYYYYYOYYYY',
      'oookoooooookoooo',
      'EEEEEEEEEEEEEEEE',
      'eeeeEeeeeeeeeeEe',
      'eEeeeeeEeeeeEeee',
      'eeeeEEeeeeeeeeee',
      'eeeeeeeeeeeeeeee',
      'eeeEeeeeeeeEeeee',
      'eeeeeeeeeeeeeeee',
      'eeeeeeeeeeeeeeee',
      'eeeeeeEeEeenneee',
      'eeeEeeeeeeeNNeeE',
      'EeEeeeeeeeeeeEEe',
      'eeeeeeeEeeeEeeee',
      'eeeeeEeeEeeEEeeE'
    ],
    tmp: [
      'eeeeeeeeeeeeeeee',
      'eeeeeeeeeeeeeeee',
      'Eeeeeeeeeeeeeeee',
      'eeeeeEeeEOOOOeee',
      'eEeeeeEeeOoooeeE',
      'eeeeeeeeeOOOOeee',
      'eeeeeeeeeeeEeEee',
      'eEeeeeeeEeeEeeeE',
      'EeeeEEeeeeeeeeee',
      'eeeeeEeeeEeeeeee',
      'eeeNNNeeeeeeeeEe',
      'eeeNeNeeeeeeeeee',
      'eeeNNNeeeeeeeeee',
      'eeeeeeeeEeeeeeEe',
      'eEeeeEeeeeEeeeEe',
      'eEeeeeeeeeeeeeee'
    ],
    tmpPlain: [
      'eEEeeeeeeeEeeeeE',
      'eeeeeeeeeeeeeeee',
      'eEeeEeeEEeeeeeeE',
      'eeeeeeeeeeeeeeee',
      'eEeeeeeeeeeeeeee',
      'eeEeeEeEeEEeeeee',
      'eeeeeeeeeeeeeeee',
      'eeeEEeeEEeeeeeee',
      'eeeeeEeeeeeeeeee',
      'eeEeeeeeeeeeeeee',
      'eEeEeeeeeeeeeeEE',
      'eeEeEeeeeeEeeeee',
      'EeeEeeeeeeeeeeee',
      'eeeEeeeeEeeeeeEe',
      'eEeeeeeeeeeeeeee',
      'Eeeeeeeeeeeeeeee'
    ],
    crate: [
      'kkkkkkkkkkkkkkkk',
      'kOOOOOOOOOOOOOOk',
      'kOOOooYoYoooOOOk',
      'kOoOOoooYooOOoOk',
      'kOooOOooooOOYYOk',
      'kOoooOOYoOOoooOk',
      'kOoYooOOOOooYoOk',
      'kOooYooOOoYoooOk',
      'kOoYooOOOOooooOk',
      'kOYooOOooOOoooOk',
      'kOooOOooooOOooOk',
      'kOoOOooooooOOoOk',
      'kOOOooooooooOOOk',
      'kOOooYYoooYooOOk',
      'kOOOOOOOOOOOOOOk',
      'kkkkkkkkkkkkkkkk'
    ],
    crateTemp: [
      'kk..kk..kk..kk..',
      'kYYyyYYyyYYyyYYk',
      '.YEEEEEEEEEEEEyk',
      '.yyyyyyyyyyyyyy.',
      'kyEEEEEEEEEEEEY.',
      'kYEEEEkkkkEEEEYk',
      '.YEEEkOkOOkEEEyk',
      '.yEEkOOkOOOkEEy.',
      'kyEEkOOkkkOkEEY.',
      'kYEEkOOOOOOkEEYk',
      '.YEEkOOOOOOkEEyk',
      '.yEEEkOOOOkEEEy.',
      'kyEEEEkkkkyyEyY.',
      'kYEEEEEEEyEEyEYk',
      '.YyyYYyyYYyyYYyk',
      '.kk..kk..kk..kk.'
    ],
    crumble: [
      'yyyyyyyyyyyyyyyy',
      'kYYYkYYYYYYkYYYk',
      'kkooooookooooook',
      'kooookooooookook',
      'kokooooookoooook',
      'koooookooooookok',
      'kookooooookooook',
      'kooooookooooookk',
      'koookooooookoook',
      '.kk..kk..kk..kk.',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    crumble2: [
      '......yyyy......',
      'yyyyykYYYY......',
      'kYYYkkookokyyyyy',
      'kkoookooookkYYYk',
      'kooookoookkooook',
      'kokookkoookokook',
      'kooookooookooook',
      'kookokokookookok',
      'kooookooookooook',
      'koookkk..kkoookk',
      '.kk..k.....koook',
      '.............kk.',
      '......o.........',
      '...o....Y.......',
      '............Y...',
      '.......o........'
    ],
    tmpDecor1: [
      '................',
      '................',
      '.........kkkk...',
      '.......kknnnk...',
      '....kkkNNNNkk...',
      '...knnnnkkk.....',
      '..kkkkkkkkkk....',
      '..kOwk.....k....',
      '..knkNnNnNnk....',
      '..knNnNnNoNk....',
      '..knNnNnoYNk....',
      '..knNnNnNoNk....',
      '..knNoNnNnNk....',
      '..knYoNnNnNk....',
      '..kNNNNNNNNk....',
      '..kkkkkkkkkk....'
    ],
    tmpDecor2: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '.......kkkkkk...',
      '......kOOOOkOk..',
      '......kOyyOkkk..',
      '.kkkkkkOOOOOOk..',
      '.kwwwwkOrrOrOk..',
      '.kwnnwkOrOrrOk..',
      '.kwwwwwkOOOOOOk.',
      'kkwnnnwwkkkkkkk.',
      'kOOkwwwwwkkwnk..',
      'kOyOkkkkkkwwwk..',
      'kkkkkkkkkkkkkk..'
    ],
    tmpDecor3: [
      '................',
      '................',
      '................',
      '................',
      '..kkkkkkkkkkk...',
      '..knnnnnnnnnk...',
      '..knsssskssnk...',
      '..knssskwssnk...',
      '..knsskssssnk...',
      '..knskksskknk...',
      '..knssssskssk...',
      '..knnnnnnnnnk...',
      '..kkkkkkkkkkk...',
      '.....kNNNk......',
      '...kkkkkkkkk.k..',
      '...knnnnnnnk.Y..'
    ]
  };
  // SPRITES END

  // A 3x5 pixel font for the HUD and the map (from the style sample).
  var ORP_FONT = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
    '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010',
    '8': '111101111101111', '9': '111101111001111',
    A: '010101111101101', B: '110101110101110', C: '111100100100111', D: '110101101101110',
    E: '111100110100111', F: '111100110100100', G: '111100101101111', H: '101101111101101',
    I: '111010010010111', J: '001001001101111', K: '101101110101101', L: '100100100100111',
    M: '101111111101101', N: '111101101101101', O: '111101101101111', P: '111101111100100',
    Q: '111101101111011', R: '110101110101101', S: '111100111001111', T: '111010010010010',
    U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
    Y: '101101010010010', Z: '111001010100111',
    '/': '001001010100100', '-': '000000111000000', ' ': '000000000000000', ':': '000010000010000',
    '.': '000000000000010', '>': '100010001010100', '_': '000000000000111', '~': '000011110000000',
    '!': '010010010000010', '%': '101001010100101', '+': '000010111010000'
  };

  // The two areas: their tile set, decor, colours and background, and
  // whether the cleanup sweep runs there.
  var ORP_AREAS = {
    home: {
      label: '/HOME', color: '#34d399', dark: '#0b6b4f',
      top: 'groundTop', inner: 'ground', plain: 'groundPlain',
      decor: ['decor1', 'decor2', 'decor3', 'decor4'], sweep: false,
      sky: [[10, 15, 30], [18, 29, 56]], far: '#101a30', farTop: '#1c2b4a', win: ['#1e3a8a', '#0e7490'],
      trace: '#16233d', traceEnd: '#1c2b4a'
    },
    tmp: {
      label: '/TMP', color: '#f59e0b', dark: '#7c2d12',
      top: 'tmpTop', inner: 'tmp', plain: 'tmpPlain',
      decor: ['tmpDecor1', 'tmpDecor2', 'tmpDecor3'], sweep: true,
      sky: [[22, 12, 10], [48, 26, 16]], far: '#2a170f', farTop: '#45261a', win: ['#7c2d12', '#b45309'],
      trace: '#3a2015', traceEnd: '#55301c'
    }
  };

  // The twelve man pages: the name and one true sentence each.
  var ORP_MAN = [
    { key: 'kill', title: 'kill(1)', text: 'kill sends a signal to a process; SIGTERM asks it to stop, SIGKILL ends it at once.' },
    { key: 'nice', title: 'nice(1)', text: 'nice runs a program with an adjusted niceness, from -20 (most favourable) to 19 (least).' },
    { key: 'ps', title: 'ps(1)', text: 'A zombie (state Z in ps) has exited but was never reaped by its parent; kill the parent and init reaps it.' },
    { key: 'tmpfiles', title: 'tmpfiles.d(5)', text: 'systemd-tmpfiles cleans /tmp by the rules in tmpfiles.d, removing files older than their age field.' },
    { key: 'chmod', title: 'chmod(1)', text: 'chmod changes the mode bits of a file; r-- grants read but neither write nor execute.' },
    { key: 'tty', title: 'tty(4)', text: 'A tty is a terminal device; a process can have one controlling terminal.' },
    { key: 'fork', title: 'fork(2)', text: 'fork() creates a new process by duplicating the calling one; the child gets its own PID.' },
    { key: 'signal', title: 'signal(7)', text: 'SIGKILL and SIGSTOP cannot be caught, blocked or ignored.' },
    { key: 'init', title: 'init(1)', text: 'PID 1 adopts orphaned processes and reaps them when they exit.' },
    { key: 'proc', title: 'proc(5)', text: '/proc is a pseudo-filesystem with a directory for every running process, named by its PID.' },
    { key: 'nohup', title: 'nohup(1)', text: 'nohup runs a command immune to hangups, so it survives the terminal that started it.' },
    { key: 'top', title: 'top(1)', text: 'top shows a live view of running processes, sorted by CPU usage by default.' }
  ];

  // ── Rooms ─────────────────────────────────────────────────────────────────
  //
  // A room is an ASCII map, one character per tile (16 px), at least 30x17
  // tiles (one screen), plus:
  //   title  the path shown on entering it and on the map
  //   area   a key of ORP_AREAS: the tile set, background and sweep rules
  //   map    [column, row] of its box on the map screen, or [column, row,
  //          columns, rows] for a box over several cells
  //   label  (optional) its name on the map when that is not the last part
  //          of the title
  //   arena  (optional) [first, last] floor column of a boss fight: while
  //          the boss lives the camera stays on that screen, and the area's
  //          sweep is left to the boss; while it is awake a gate shuts the
  //          exit openings on that screen
  //   exits  { digit: [room, digit] }: the digit's tiles on this room's edge
  //          lead to the tiles of that digit in the other room, which must
  //          lead back; both openings have the same length
  //   man    the man page keys of its 'm' tiles in reading order
  //
  // Legend:
  //   .  air                       #  solid ground (the area's tile set)
  //   =  one-way platform          ^  spikes (segfault)
  //   %  crumbling tile            x  cracked wall (a dash breaks it)
  //   c  crate                     t  temporary crate (the sweep deletes it)
  //   G  gate (open while the room's signal switch is on)
  //   D  r-- permission door       s  signal switch (a signal turns it on)
  //   E  end-of-episode trigger    1-9 an exit opening on the room's edge
  //   @  new-game start            T  tty checkpoint
  //   m  man page    h  chip    M  memory module    k  kill    n  nice
  //   b  bug         L  leaky daemon               K  lockfile turret
  //   B  the boss (it and n: one of them, by whether the boss is down)
  // Every edge tile is solid or an exit.  Entities stand on the tile below
  // their letter (their own tile is air).
  //
  // To add a room: add an entry here, link its exits both ways, put it on
  // the map grid, and run the tests (they check the links, the edges, the
  // one-screen minimum and that every item can be reached).
  // To add an entity: give it a letter in ORP_SPAWNS and a kind in
  // ORP_KINDS (size, hp, xp, update, touch and look functions).  Optional
  // hooks: defeat runs when its hp reaches 0, hurt after a hit it survives,
  // guard makes a hit glance off while it returns true, and when(prog) keeps
  // it off the map while it returns false.  The boss is one more kind whose
  // update runs its phases (see "The boss" below).
  //
  // Episode 1, in the order of a first run: /home/~ (the start), .config,
  // .cache (a shaft; .ssh off its side), Documents (kill), Downloads
  // (.local/bin off its side) and the gate to /tmp; then /tmp, tmp.XXXX,
  // .X11-unix, systemd-private (sess_ off its side), tty1 and the arena
  // tmpfiles.d.  nice, the boss's reward, breaks the cracked walls of the
  // two secrets in /home (~ and .local/bin) and of the arena: the shortcut
  // down to .local/bin and the way onward.

  var ORP_START_ROOM = 'home';

  var ORP_ROOMS = {
    home: {
      title: '/home/~', area: 'home', map: [0, 1],
      exits: { 1: ['config', '1'] }, man: ['fork', 'init'],
      rows: [
        '##################################################',
        '###########################......................#',
        '###########################......................#',
        '###########################......................#',
        '###########################......................#',
        '###########################......................#',
        '###########################............m.........#',
        '###########################...........====.......1',
        '###########################......................1',
        '#...........................................=====#',
        '#................................................#',
        '#......................................====......#',
        '#................................................#',
        '#####.......................................====.#',
        '#####............................................#',
        '#####.................###..............====......#',
        '#.m.x..@...T....###...###........................#',
        '############################..####^^^#############',
        '##################################################',
        '##################################################'
      ]
    },
    config: {
      title: '/home/.config', area: 'home', map: [1, 1],
      exits: { 1: ['home', '1'], 2: ['cache', '1'] }, man: ['nohup'],
      rows: [
        '################################################################',
        '###########....................................................#',
        '###########....................................................#',
        '###########....................................................#',
        '###########....................................................#',
        '#..............................................................#',
        '#..............................................................#',
        '1...................................m..........................#',
        '1..................................===.........................#',
        '########..............b...............h........................#',
        '########===........######.........######.......................#',
        '########.......................................................#',
        '########...######...........====...........=====...............#',
        '########.........===...........................................#',
        '########.......................................................#',
        '########...........===.........................................#',
        '########.......................................................#',
        '########..............##.......................................2',
        '########......b.......##......b...............b...........#....2',
        '#####################################^^^########################',
        '################################################################',
        '################################################################'
      ]
    },
    cache: {
      title: '/home/.cache', area: 'home', map: [2, 0, 1, 2],
      exits: { 1: ['config', '2'], 2: ['ssh', '1'], 3: ['docs', '1'] }, man: ['top', 'proc'],
      rows: [
        '################################',
        '#..............................#',
        '#..............................#',
        '#..............................#',
        '#..............................3',
        '#..........................T...3',
        '#........................#######',
        '#..............................#',
        '#.................=====........#',
        '#............................m.#',
        '#........................#######',
        '#..............................#',
        '#..................=====.......#',
        '#..............................#',
        '#............=====.............#',
        '#..............................#',
        '#......=====...................#',
        '#..b...........................#',
        '######.........................#',
        '#..............................#',
        '#......=====...................#',
        '#..............b...............#',
        '#............=====.............2',
        '#..............................2',
        '#.................=====.########',
        '#.m............................#',
        '#####.......=====..............#',
        '#..............................#',
        '#.....=====....................#',
        '#..............................#',
        '#...........=====..............#',
        '#..............................#',
        '#.................=====........#',
        '#..............................#',
        '#.......................=====..#',
        '#...................b..........#',
        '#.................#####........#',
        '#..............................#',
        '#...........=====..............#',
        '#..............................#',
        '1.....=====....................#',
        '1..............................#',
        '################################',
        '################################'
      ]
    },
    ssh: {
      title: '/home/.ssh', area: 'home', map: [3, 1],
      exits: { 1: ['cache', '2'] }, man: ['chmod'],
      rows: [
        '############################################',
        '############################################',
        '############################################',
        '############################################',
        '############################################',
        '############################################',
        '#......................................#####',
        '#......................................#####',
        '#..............................h.......#####',
        '#............................=====.....#####',
        '#........................h.............#####',
        '#.....................=====............#####',
        '#......................................#####',
        '1................###...................D####',
        '1................###....b......b....m..D####',
        '#########^^^################################',
        '############################################',
        '############################################'
      ]
    },
    docs: {
      title: '/home/Documents', area: 'home', map: [3, 0],
      exits: { 1: ['cache', '3'], 2: ['downloads', '1'] }, man: ['kill', 'ps'],
      rows: [
        '############################################################',
        '#..........................................................#',
        '#..........................................................#',
        '#..........................................................#',
        '1..........................................................#',
        '1...m....k............b....................................#',
        '###############===..######.................................#',
        '###############............................................#',
        '###############===.........................................#',
        '###############............................................#',
        '###############===.........................................#',
        '###############............................................#',
        '###############===........................h................#',
        '###############.........................=====..............#',
        '###############===.........................................#',
        '###############..................=====.....................#',
        '###############===.........................................#',
        '###############...........=====............................#',
        '###############===.........................................#',
        '###############.................................L..........2',
        '###############===.m........b..........b......#####........2',
        '############################################################',
        '############################################################',
        '############################################################'
      ]
    },
    downloads: {
      title: '/home/Downloads', area: 'home', map: [4, 0],
      exits: { 1: ['docs', '2'], 2: ['gate', '1'], 3: ['bin', '1'] }, man: ['signal'],
      rows: [
        '################################################################################',
        '#..............................................................................#',
        '#..............................................................................#',
        '#..............................................................................#',
        '#..............................................................................2',
        '#.................................................................h...b.....#..2',
        '#.............................................................##################',
        '#..............................................................................#',
        '#........................................................====..................#',
        '#..............................................................................#',
        '#...................................................====.......................#',
        '#......m............b.........L...........b....................................#',
        '#....##############################################............................#',
        '#.h............................................................................#',
        '#===...........................................................................#',
        '#..............................................................................#',
        '#...====.......................................................................#',
        '#.......................b...............b......................................#',
        '#.........#################################################....................#',
        '#..............................................................................#',
        '#..........................................................====................#',
        '#..............................................................................#',
        '1.................................##............................====...........3',
        '1...T.......................b.....##......b...........L.................#......3',
        '####################^^^#########################################################',
        '################################################################################'
      ]
    },
    bin: {
      title: '/home/.local/bin', area: 'home', map: [4, 1], label: '.local/bin',
      exits: { 1: ['downloads', '3'], 2: ['arena', '3'] }, man: [],
      rows: [
        '############################222#########',
        '############################...#########',
        '############################...#########',
        '############################...#########',
        '############################...#########',
        '############################...#########',
        '############################...#########',
        '############################...#########',
        '############################...#########',
        '#................................#######',
        '#................................#######',
        '#................................#######',
        '#................................#######',
        '#................................#######',
        '#................................#######',
        '#.......................====.....#######',
        '#..................h.............#######',
        '#................=====...........#######',
        '#................................#######',
        '1.........=====..................#######',
        '1...#....b.......b.......b.......x..M..#',
        '########################################',
        '########################################',
        '########################################'
      ]
    },
    gate: {
      title: '/home/../tmp', area: 'home', map: [5, 0], label: 'gate',
      exits: { 1: ['downloads', '2'], 2: ['tmp', '1'] }, man: [],
      rows: [
        '################################################',
        '#........................................#######',
        '#........................................#######',
        '#........................................#######',
        '1........................................#######',
        '1........................................#######',
        '#########................................#######',
        '#########==...........................s..#######',
        '#########..................######........#######',
        '#########==...........====...............#######',
        '#########................................#######',
        '#########==......====....................#######',
        '#########................................#######',
        '#########==...........====...............#######',
        '#########................................G.....#',
        '#########==......====....................G.....2',
        '#########.....b...............b..........G.....2',
        '################################################',
        '################################################',
        '################################################'
      ]
    },
    tmp: {
      title: '/tmp', area: 'tmp', map: [0, 4],
      exits: { 1: ['gate', '2'], 2: ['tmpx', '1'] }, man: ['tmpfiles'],
      rows: [
        '########################################################',
        '########################################################',
        '########################################################',
        '########################################################',
        '#......................................................#',
        '#......................................................#',
        '#......................................................#',
        '#......................................................#',
        '#......................................................#',
        '#......................................................#',
        '#......................................................#',
        '#......................................................2',
        '#.......................................b..............2',
        '#.............................#################tttt..###',
        '#.............................#################......###',
        '1..........................t..#################....==###',
        '1...T...m...........b....t.t..#################......###',
        '############tttt=##############################....==###',
        '############.....##############################......###',
        '########################################################'
      ]
    },
    tmpx: {
      title: '/tmp/tmp.XXXX', area: 'tmp', map: [1, 4],
      exits: { 1: ['tmp', '2'], 2: ['x11', '1'] }, man: [],
      rows: [
        '################################################################',
        '################################################################',
        '################################################################',
        '################################################################',
        '################################################################',
        '################################################################',
        '#..............................................................#',
        '#..............................................................#',
        '#..............................................................#',
        '#..............................................................#',
        '#..............................................................#',
        '#..............................................................#',
        '#..............................................................#',
        '#.............................%%...%%..........................#',
        '#..............................................................#',
        '1.........................%%............%%.....................2',
        '1..............................................h...b....b...#..2',
        '########%%%%=###%%%%%#####^^^^^^^^^^^^^^^^^^^###################',
        '########.....###^^^^^###########################################',
        '################################################################'
      ]
    },
    x11: {
      title: '/tmp/.X11-unix', area: 'tmp', map: [2, 4],
      exits: { 1: ['tmpx', '2'], 2: ['sysd', '1'] }, man: [],
      rows: [
        '######################################################################',
        '######################################################################',
        '######################################################################',
        '######################################################################',
        '#....................................................................#',
        '#....................................................................#',
        '#....................................................................#',
        '#....................................................................#',
        '#....................................................................#',
        '#.....................................................b..K...........#',
        '#...................................................#######..........#',
        '#.............................................====...................#',
        '#..........................................h.........................#',
        '#........................................====........................#',
        '#...............................b.....K..............................#',
        '#...........................#############............................#',
        '#...........................#############.====.......................#',
        '1.........................###############.......c....................2',
        '1...............c.....K...###############......cc......K........T....2',
        '######################################################################',
        '######################################################################',
        '######################################################################'
      ]
    },
    sysd: {
      title: '/tmp/systemd-private', area: 'tmp', map: [3, 3, 1, 2], label: 'systemd-priv',
      exits: { 1: ['x11', '2'], 2: ['sess', '1'], 3: ['ttyr', '1'] }, man: [],
      rows: [
        '####################################',
        '#..................................#',
        '#..................................#',
        '#..................................#',
        '#..................................#',
        '#..................................3',
        '#...............................K..3',
        '#................###################',
        '#..................................#',
        '#.............tt...................#',
        '#..................................#',
        '#..........tt......................#',
        '#..................................#',
        '#.......tt.........................#',
        '#..................................#',
        '2....tt............................#',
        '2.h................................#',
        '####...............................#',
        '#..................................#',
        '#....tt............................#',
        '#..................................#',
        '#.......tt.........................#',
        '#..................................#',
        '#..........tt......................#',
        '#..................................#',
        '#.............tt...................#',
        '#......................K...........#',
        '#................########..........#',
        '#..................................#',
        '#.............tt...................#',
        '#..................................#',
        '#..........tt......................#',
        '#..................................#',
        '#.......tt.........................#',
        '#..................................#',
        '1....tt............................#',
        '1...........................L......#',
        '####################################',
        '####################################',
        '####################################'
      ]
    },
    sess: {
      title: '/tmp/sess_', area: 'tmp', map: [2, 3],
      exits: { 1: ['sysd', '2'] }, man: ['nice', 'tty'],
      rows: [
        '############################################',
        '############################################',
        '############################################',
        '############################################',
        '#..........................................#',
        '#..........................................#',
        '#..M....m..................................#',
        '###########................................#',
        '#..........................................#',
        '#............====..........................#',
        '#..........................................#',
        '#..................====....................#',
        '#..........................................#',
        '#........................====..............#',
        '#..............................h...........#',
        '#.............................====.........1',
        '#...........L.......m.....b.......b.....#..1',
        '############################################',
        '############################################',
        '############################################'
      ]
    },
    ttyr: {
      title: '/tmp/tty1', area: 'tmp', map: [4, 3],
      exits: { 1: ['sysd', '3'], 2: ['arena', '1'] }, man: [],
      rows: [
        '########################################',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '#......................................#',
        '1......................................#',
        '1......................................#',
        '#########..............................#',
        '#########===...........................#',
        '#########......h.......................#',
        '#########....====......................#',
        '#########..............................#',
        '#########.====................t........2',
        '#########.............T.....t.t........2',
        '########################################',
        '########################################',
        '########################################'
      ]
    },
    arena: {
      title: '/tmp/tmpfiles.d', area: 'tmp', map: [5, 3], arena: [1, 28],
      exits: { 1: ['ttyr', '2'], 3: ['bin', '2'] }, man: [],
      rows: [
        '##################################',
        '#............................#####',
        '#............................#####',
        '#............................#####',
        '#............................#####',
        '#............................#####',
        '#............................#####',
        '#............................#####',
        '#............................#####',
        '#............................#####',
        '#............................#####',
        '#............................#...#',
        '#............................x.E.#',
        '1..=====.t..======..t.=====..#####',
        '1........t....n.....t......B.x...#',
        '##############################...#',
        '##############################333#'
      ]
    }
  };

  // Letters that place an entity (their tile is air).
  var ORP_SPAWNS = {
    b: 'bug', L: 'daemon', K: 'turret', T: 'tty', m: 'man', h: 'chip', M: 'module', k: 'capKill', n: 'capNice',
    B: 'boss'
  };
  // Tiles that are always solid; x, G, t and % depend on the state.
  var ORP_SOLID = { '#': true, c: true, D: true };
  // Items that count for completion (with the rooms).
  var ORP_COLLECTIBLE = { m: true, M: true, k: true, n: true };

  // ── State ─────────────────────────────────────────────────────────────────

  // screen: 'title', 'play', 'pause', 'map' or 'end'.  sim: the running
  // game (orpNewSim), null on the title screen.  hasSave: whether Continue
  // has a game to resume (in orp-state or in memory).  memory: the last
  // save this page wrote, kept for when storage fails.  stale: a later run
  // (New game in another tab) owns the save, so this tab no longer writes.
  // message / messages: the message box's message and the ones waiting.
  // focused: the canvas has the focus.  prev and next: the states before
  // and after the last step (a frame draws between them while sim is
  // next).  scale: screen pixels per game pixel on the backing store.
  var orpRuntime = {
    els: null,
    ctx: null,
    art: null,
    sim: null,
    prev: null,
    next: null,
    scale: 1,
    screen: 'title',
    focused: false,
    hasSave: false,
    memory: null,
    stale: false,
    message: null,
    messages: [],
    keys: { left: false, right: false, jump: false, down: false, shoot: false, dash: false },
    frame: null,
    lastTs: null,
    acc: 0,
    failed: false,
    confirming: false,
    confirmTimeout: null,
    toastTimeout: null,
    messageLeft: 0
  };

  // Parsed rooms by key (orpRoom).
  var orpRoomCache = {};

  // ── Helpers (no DOM) ──────────────────────────────────────────────────────

  function orpHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function orpClamp(value, low, high) {
    return Math.min(Math.max(value, low), high);
  }

  // value moved toward target by at most step.
  function orpApproach(value, target, step) {
    return value < target ? Math.min(value + step, target) : Math.max(value - step, target);
  }

  function orpClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // The style sample's integer hash, for repeatable patterns.
  function orpHash(x, y, seed) {
    var h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  // Whether boxes a and b ({ x, y, w, h }) overlap.
  function orpOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  // The first and last tile a span from start of length size covers.
  function orpSpan(start, size) {
    return [Math.floor(start / ORP_TILE), Math.floor((start + size - ORP_EPS) / ORP_TILE)];
  }

  function orpId(room, x, y) {
    return room + ':' + x + ',' + y;
  }

  // m:ss (or h:mm:ss) of a time in seconds.
  function orpFormatTime(seconds) {
    var total = Math.floor(seconds);
    var h = Math.floor(total / 3600);
    var m = Math.floor(total / 60) % 60;
    var s = total % 60;
    var mm = h > 0 && m < 10 ? '0' + m : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + (s < 10 ? '0' : '') + s;
  }

  // The animation frame of names for time t at seconds per frame.
  function orpFrame(names, t, every) {
    return names[Math.floor(t / every) % names.length];
  }

  function orpManByKey(key) {
    return ORP_MAN.filter(function (page) { return page.key === key; })[0];
  }

  // ── Rooms (no DOM) ────────────────────────────────────────────────────────

  // A room's map read once: its tiles (entity letters and exit digits turned
  // to air), spawns with their ids, exits with their edge, switches, the
  // start and the collectibles.
  function orpParseRoom(key, def) {
    var data = {
      key: key, def: def, w: def.rows[0].length, h: def.rows.length,
      tiles: [], spawns: [], exits: {}, switches: [], walls: [], ttys: [], items: [], start: null
    };
    var man = 0;
    def.rows.forEach(function (row, y) {
      var line = '';
      for (var x = 0; x < row.length; x++) {
        var ch = row.charAt(x);
        var id = orpId(key, x, y);
        if (ch >= '1' && ch <= '9') {
          (data.exits[ch] = data.exits[ch] || []).push([x, y]);
          ch = '.';
        } else if (ch === '@') {
          data.start = [x, y];
          ch = '.';
        } else if (orpHasOwn(ORP_SPAWNS, ch)) {
          id = ch === 'm' ? 'man:' + def.man[man++] : id;
          data.spawns.push({ type: ORP_SPAWNS[ch], x: x, y: y, id: id });
          if (ORP_COLLECTIBLE[ch]) data.items.push(id);
          if (ch === 'T') data.ttys.push(id);
          ch = '.';
        } else if (ch === 's') {
          data.switches.push(id);
        } else if (ch === 'x') {
          data.walls.push(id);
        }
        line += ch;
      }
      data.tiles.push(line);
    });
    Object.keys(data.exits).forEach(function (digit) {
      var cells = data.exits[digit];
      var first = cells[0];
      var edge = first[0] === 0 ? 'west' : first[0] === data.w - 1 ? 'east' : first[1] === 0 ? 'north' : 'south';
      data.exits[digit] = { edge: edge, x: first[0], y: first[1], cells: cells };
    });
    // An arena's gate: the exit cells on the fight's screen ('x,y' -> true).
    data.locks = {};
    if (def.arena) {
      Object.keys(data.exits).forEach(function (digit) {
        data.exits[digit].cells.forEach(function (cell) {
          if (cell[0] <= def.arena[1] + 1) data.locks[cell[0] + ',' + cell[1]] = true;
        });
      });
    }
    return data;
  }

  function orpRoom(key) {
    if (!orpRoomCache[key]) orpRoomCache[key] = orpParseRoom(key, ORP_ROOMS[key]);
    return orpRoomCache[key];
  }

  // The tile character at (cx, cy); outside the map, the nearest edge tile.
  function orpTile(room, cx, cy) {
    var data = orpRoom(room);
    return data.tiles[orpClamp(cy, 0, data.h - 1)].charAt(orpClamp(cx, 0, data.w - 1));
  }

  function orpGateOpen(sim) {
    return orpRoom(sim.room).switches.some(function (id) { return sim.prog.switches.indexOf(id) !== -1; });
  }

  function orpCrumbleDown(sim, cx, cy) {
    var c = sim.crumble[cx + ',' + cy];
    return !!c && c.down;
  }

  // Whether (cx, cy) is an exit cell of an arena whose boss is awake (the
  // gate that keeps the hero in the fight).
  function orpLocked(sim, cx, cy) {
    return !!sim.shut && orpHasOwn(orpRoom(sim.room).locks, cx + ',' + cy);
  }

  // Whether the tile at (cx, cy) blocks movement now.
  function orpSolid(sim, cx, cy) {
    var ch = orpTile(sim.room, cx, cy);
    if (ORP_SOLID[ch]) return true;
    if (ch === 'x') return sim.prog.walls.indexOf(orpId(sim.room, cx, cy)) === -1;
    if (ch === 'G') return !orpGateOpen(sim);
    if (ch === 't') return !sim.swept;
    if (ch === '%') return !orpCrumbleDown(sim, cx, cy);
    return orpLocked(sim, cx, cy);
  }

  // Every id a save may hold, from the rooms.
  function orpKnownIds() {
    var known = { ttys: [], items: [], switches: [], walls: [], rooms: Object.keys(ORP_ROOMS) };
    known.rooms.forEach(function (key) {
      var data = orpRoom(key);
      known.ttys = known.ttys.concat(data.ttys);
      known.items = known.items.concat(data.items);
      known.switches = known.switches.concat(data.switches);
      known.walls = known.walls.concat(data.walls);
    });
    return known;
  }

  // Completion in whole percent: visited rooms and collected items (man
  // pages, memory modules, capabilities) of all of them.
  function orpCompletion(prog) {
    var known = orpKnownIds();
    var done = prog.visited.length + prog.collected.filter(function (id) { return known.items.indexOf(id) !== -1; }).length;
    return Math.floor(100 * done / (known.rooms.length + known.items.length));
  }

  function orpManFound(prog) {
    return ORP_MAN.filter(function (page) { return prog.collected.indexOf('man:' + page.key) !== -1; });
  }

  // ── Progress (no DOM) ─────────────────────────────────────────────────────

  // run and born: the game's id and the wall-clock time (ms) New game made
  // it ('' and 0 until then); ended: the end screen was shown.
  function orpFreshProgress() {
    return {
      run: '', born: 0, tty: '', maxRss: ORP_START_RSS, maxCpu: ORP_START_CPU, xp: 0, nice: ORP_START_NICE,
      abilities: [], collected: [], switches: [], walls: [], boss: false, ended: false, visited: [], time: 0, deaths: 0
    };
  }

  // The XP that takes nice one level down from nice.
  function orpXpNeeded(nice) {
    return 20 + 10 * (ORP_START_NICE - nice);
  }

  function orpHas(prog, ability) {
    return prog.abilities.indexOf(ability) !== -1;
  }

  // ── Simulation (no DOM) ───────────────────────────────────────────────────

  function orpEvent(sim, type, extra) {
    var event = extra || {};
    event.type = type;
    sim.events.push(event);
  }

  function orpMessage(sim, title, text) {
    orpEvent(sim, 'msg', { title: title, text: text });
  }

  function orpHeroBox(hero) {
    return { x: hero.x, y: hero.y, w: ORP_HERO_W, h: ORP_HERO_H };
  }

  // Where a process (re)starts: the last tty, or the new-game start.
  function orpSpawnPoint(prog) {
    var at = prog.tty ? prog.tty.split(/[:,]/) : [ORP_START_ROOM].concat(orpRoom(ORP_START_ROOM).start);
    return { room: at[0], x: Number(at[1]), y: Number(at[2]) };
  }

  // The hero standing on tile (cx, cy).  warp counts its jumps back to safe
  // ground after spikes (drawing never blends across one).
  function orpNewHero(cx, cy) {
    var x = cx * ORP_TILE + (ORP_TILE - ORP_HERO_W) / 2;
    var y = (cy + 1) * ORP_TILE - ORP_HERO_H;
    return {
      x: x, y: y, w: ORP_HERO_W, h: ORP_HERO_H, vx: 0, vy: 0, face: 1, ground: false, cut: true,
      coyote: 0, buffer: 0, drop: 0, inv: 0, knock: 0, dash: 0, dashCd: 0, shotCd: 0, shootT: 0,
      safeX: x, safeY: y, warp: 0
    };
  }

  function orpSpawn(sim, type, x, y, id) {
    var kind = ORP_KINDS[type];
    var e = {
      id: id, type: type, x: x, y: y, w: kind.w, h: kind.h, vx: 0, vy: 0, hp: kind.hp || 0,
      face: -1, t: 0, flash: 0, cd: kind.cd || 0, parent: ''
    };
    if (kind.init) kind.init(sim, e);
    sim.ents.push(e);
    return e;
  }

  // Where the camera heads: the hero a little ahead of its face, inside the
  // room (inside the arena's one screen while its boss lives).
  function orpCameraTarget(sim) {
    var data = orpRoom(sim.room);
    var hero = sim.hero;
    var arena = data.def.arena;
    var wide = arena && !sim.prog.boss ? arena[1] + 2 : data.w;
    return {
      x: orpClamp(hero.x + ORP_HERO_W / 2 + hero.face * ORP_LOOK_AHEAD - ORP_W / 2, 0, wide * ORP_TILE - ORP_W),
      y: orpClamp(hero.y + ORP_HERO_H / 2 - ORP_H / 2, 0, data.h * ORP_TILE - ORP_H)
    };
  }

  // Spawn s of a room map ({ type, x, y, id }), standing on the tile below
  // its letter.
  function orpSpawnAt(sim, s) {
    var kind = ORP_KINDS[s.type];
    return orpSpawn(sim, s.type, s.x * ORP_TILE + (ORP_TILE - kind.w) / 2, (s.y + 1) * ORP_TILE - kind.h, s.id);
  }

  // Puts the room on screen: its entities (collected items and kinds whose
  // when() says no left out), no signals or effects, crumbling tiles whole,
  // the camera on the hero, no arena gate.  A first visit is saved; a new
  // area, an arena or leaving one restarts the sweep (so the boss's deleted
  // crates never follow the hero out).
  function orpEnterRoom(sim, key) {
    var data = orpRoom(key);
    var was = ORP_ROOMS[sim.room];
    if (data.def.area !== sim.area || data.def.arena || (was && was.arena)) {
      sim.sweep = 0;
      sim.swept = false;
    }
    sim.warn = false;
    sim.shut = false;
    sim.room = key;
    sim.area = data.def.area;
    sim.roomT = 0;
    sim.ents = [];
    sim.sigs = [];
    sim.fx = [];
    sim.crumble = {};
    data.spawns.forEach(function (s) {
      var kind = ORP_KINDS[s.type];
      if (sim.prog.collected.indexOf(s.id) !== -1 || (kind.when && !kind.when(sim.prog))) return;
      orpSpawnAt(sim, s);
    });
    sim.cam = orpCameraTarget(sim);
    if (sim.prog.visited.indexOf(key) === -1) {
      sim.prog.visited.push(key);
      orpEvent(sim, 'save');
    }
  }

  // A process (re)started at its spawn point with full RSS and CPU and a
  // fresh sweep.
  function orpRespawn(sim) {
    var at = orpSpawnPoint(sim.prog);
    sim.mode = 'play';
    sim.deadT = 0;
    sim.sweep = 0;
    sim.swept = false;
    sim.rss = sim.prog.maxRss;
    sim.cpu = sim.prog.maxCpu;
    sim.hero = orpNewHero(at.x, at.y);
    orpEnterRoom(sim, at.room);
  }

  // A new game state for prog (orpFreshProgress or a parsed save).
  function orpNewSim(prog) {
    var sim = {
      prog: orpClone(prog), room: '', area: '', mode: 'play', t: 0, roomT: 0, deadT: 0, rss: 0, cpu: 0,
      hero: null, ents: [], sigs: [], fx: [], crumble: {}, sweep: 0, swept: false, cam: { x: 0, y: 0 },
      warn: false, shut: false, endT: 0, seq: 0, kills: 0, deniedT: 0, last: { jump: false, shoot: false, dash: false }, events: []
    };
    orpRespawn(sim);
    return sim;
  }

  function orpFx(sim, kind, x, y) {
    sim.fx.push({ k: kind, x: x, y: y, t: 0 });
  }

  function orpBreakWall(sim, cx, cy) {
    sim.prog.walls.push(orpId(sim.room, cx, cy));
    orpFx(sim, 'dust', cx * ORP_TILE, cy * ORP_TILE);
    orpEvent(sim, 'save');
  }

  // Moves body b ({ x, y, w, h }) by dx, then dy, against the tiles.  crush:
  // a dash, which breaks cracked walls.  drop: one-way platforms are passed.
  // Returns { wall, ground, ceiling, row } (row: the tile row it landed on).
  function orpMove(sim, b, dx, dy, crush, drop) {
    var hit = { wall: false, ground: false, ceiling: false, row: 0 };
    var r;
    var c;
    if (dx !== 0) {
      b.x += dx;
      var col = dx > 0 ? Math.floor((b.x + b.w - ORP_EPS) / ORP_TILE) : Math.floor(b.x / ORP_TILE);
      var rows = orpSpan(b.y, b.h);
      for (r = rows[0]; r <= rows[1]; r++) {
        if (!orpSolid(sim, col, r)) continue;
        if (crush && orpTile(sim.room, col, r) === 'x') {
          orpBreakWall(sim, col, r);
        } else {
          hit.wall = true;
        }
      }
      if (hit.wall) b.x = dx > 0 ? col * ORP_TILE - b.w : (col + 1) * ORP_TILE;
    }
    var cols = orpSpan(b.x, b.w);
    var bottom = b.y + b.h;
    b.y += dy;
    if (dy > 0) {
      var row = Math.floor((b.y + b.h - ORP_EPS) / ORP_TILE);
      var top = row * ORP_TILE;
      for (c = cols[0]; c <= cols[1]; c++) {
        var platform = !drop && bottom <= top + ORP_EPS && orpTile(sim.room, c, row) === '=';
        if (platform || orpSolid(sim, c, row)) hit.ground = true;
      }
      if (hit.ground) {
        b.y = top - b.h;
        hit.row = row;
      }
    } else if (dy < 0) {
      var up = Math.floor(b.y / ORP_TILE);
      for (c = cols[0]; c <= cols[1]; c++) {
        if (orpSolid(sim, c, up)) hit.ceiling = true;
      }
      if (hit.ceiling) b.y = (up + 1) * ORP_TILE;
    }
    return hit;
  }

  // The tiles under the hero's feet (it stands on row).
  function orpFeet(sim, row) {
    var cols = orpSpan(sim.hero.x, ORP_HERO_W);
    var out = [];
    for (var c = cols[0]; c <= cols[1]; c++) out.push({ x: c, ch: orpTile(sim.room, c, row) });
    return out;
  }

  // Landed on row: crumbling tiles start to go, and solid ground that stays
  // is remembered as the place spikes send the hero back to.
  function orpLanded(sim, row) {
    var hero = sim.hero;
    var safe = true;
    orpFeet(sim, row).forEach(function (tile) {
      var key = tile.x + ',' + row;
      if (tile.ch === '%' && !sim.crumble[key]) sim.crumble[key] = { x: tile.x, y: row, t: 0, down: false };
      if (tile.ch === '%' || tile.ch === 't') safe = false;
    });
    if (safe) {
      hero.safeX = hero.x;
      hero.safeY = hero.y;
    }
  }

  // Standing on a one-way platform with nothing solid underfoot (so Down +
  // jump drops through instead of jumping).
  function orpOnPlatformOnly(sim) {
    var row = Math.floor((sim.hero.y + ORP_HERO_H) / ORP_TILE);
    var feet = orpFeet(sim, row);
    return feet.some(function (tile) { return tile.ch === '='; }) &&
      !feet.some(function (tile) { return orpSolid(sim, tile.x, row); });
  }

  // Whether box touches a tile ch; the tile's box starts inset px down.
  function orpTouches(sim, box, ch, inset) {
    var cols = orpSpan(box.x, box.w);
    var rows = orpSpan(box.y, box.h);
    for (var r = rows[0]; r <= rows[1]; r++) {
      for (var c = cols[0]; c <= cols[1]; c++) {
        var tile = { x: c * ORP_TILE, y: r * ORP_TILE + inset, w: ORP_TILE, h: ORP_TILE - inset };
        if (orpTile(sim.room, c, r) === ch && orpOverlap(box, tile)) return true;
      }
    }
    return false;
  }

  function orpDie(sim) {
    sim.mode = 'dead';
    sim.deadT = 0;
    sim.rss = 0;
    sim.prog.deaths += 1;
    orpEvent(sim, 'death');
    orpEvent(sim, 'save');
  }

  // One hit from something at x: 1 RSS, a second of invulnerability and a
  // short knock-back away from x.  Returns whether it hurt.
  function orpHurt(sim, fromX) {
    var hero = sim.hero;
    if (hero.inv > 0) return false;
    sim.rss -= 1;
    hero.inv = ORP_INVULN;
    if (sim.rss <= 0) {
      orpDie(sim);
      return true;
    }
    hero.knock = ORP_KNOCK_TIME;
    hero.dash = 0;
    hero.cut = true;
    hero.vx = (hero.x + ORP_HERO_W / 2 < fromX ? -1 : 1) * ORP_KNOCK_X;
    hero.vy = -ORP_KNOCK_Y;
    orpEvent(sim, 'hurt');
    return true;
  }

  function orpGainXp(sim, amount) {
    var prog = sim.prog;
    prog.xp += amount;
    while (prog.nice > ORP_MIN_NICE && prog.xp >= orpXpNeeded(prog.nice)) {
      prog.xp -= orpXpNeeded(prog.nice);
      prog.nice -= 1;
      prog.maxCpu = Math.min(ORP_MAX_CPU, prog.maxCpu + ORP_LEVEL_CPU);
      var more = (ORP_START_NICE - prog.nice) % 2 === 0;
      if (more) {
        prog.maxRss = Math.min(ORP_MAX_RSS, prog.maxRss + 1);
        sim.rss = prog.maxRss;
      }
      orpMessage(sim, 'nice ' + prog.nice, 'Max CPU ' + prog.maxCpu + (more ? ', max RSS ' + prog.maxRss + ', RSS refilled.' : '.'));
    }
    orpEvent(sim, 'save');
  }

  // A capability key pressed without the capability: a refusal and nothing
  // else (no CPU, no cooldown).  The page drops it while the same one shows
  // or waits, and it comes only on a fresh press.
  function orpLacking(sim, ability) {
    var name = ORP_ABILITY_NAMES[ability];
    orpMessage(sim, name + ': Operation not permitted', 'You do not have the ' + name + ' capability yet.');
  }

  function orpFire(sim) {
    var hero = sim.hero;
    sim.cpu -= ORP_SIGNAL_COST;
    hero.shotCd = ORP_SIGNAL_COOLDOWN;
    hero.shootT = ORP_SHOOT_POSE;
    sim.sigs.push({
      x: hero.face > 0 ? hero.x + ORP_HERO_W : hero.x - ORP_SIGNAL_W, y: hero.y + 4,
      w: ORP_SIGNAL_W, h: ORP_SIGNAL_H, vx: hero.face * ORP_SIGNAL_SPEED, dist: 0
    });
  }

  // The hero's spikes, the r-- door and the end trigger.
  function orpHazards(sim) {
    var hero = sim.hero;
    var box = orpHeroBox(hero);
    if (orpTouches(sim, box, '^', ORP_TILE / 2)) {
      orpHurt(sim, hero.x + ORP_HERO_W / 2);
      if (sim.mode === 'play') {
        hero.x = hero.safeX;
        hero.y = hero.safeY;
        hero.vx = 0;
        hero.vy = 0;
        hero.knock = 0;
        hero.warp += 1;
      }
    }
    if (sim.deniedT <= 0 && orpTouches(sim, { x: box.x - 1, y: box.y, w: box.w + 2, h: box.h }, 'D', 0)) {
      sim.deniedT = ORP_DENIED_EVERY;
      orpMessage(sim, 'Permission denied', 'This door is r-- for you: it needs setuid, which no process here has yet.');
    }
    if (sim.mode === 'play' && orpTouches(sim, box, 'E', 0)) orpEndEpisode(sim);
  }

  // The end of the episode: the end screen shows, and the save says so.
  function orpEndEpisode(sim) {
    sim.mode = 'end';
    sim.prog.ended = true;
    orpEvent(sim, 'end');
    orpEvent(sim, 'save');
  }

  // The hero for one step: timers, CPU, run, dash, signal, jump (with
  // buffer, coyote time, cut and drop-through), gravity and movement.
  function orpHeroStep(sim, input, dt) {
    var hero = sim.hero;
    var prog = sim.prog;
    var jumpPressed = input.jump && !sim.last.jump;
    var shootPressed = input.shoot && !sim.last.shoot;
    var dashPressed = input.dash && !sim.last.dash;
    sim.last = { jump: input.jump, shoot: input.shoot, dash: input.dash };
    // (A hair more than dt, so a timer of n steps ends after n steps despite
    // rounding.)
    ['inv', 'knock', 'dash', 'dashCd', 'shotCd', 'shootT', 'buffer', 'coyote', 'drop'].forEach(function (name) {
      hero[name] = Math.max(0, hero[name] - dt - 1e-9);
    });
    sim.cpu = Math.min(prog.maxCpu, sim.cpu + ORP_CPU_REGEN * dt);
    if (jumpPressed) hero.buffer = ORP_BUFFER;
    var dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    var free = hero.knock <= 0 && hero.dash <= 0;
    if (free) {
      if (dir !== 0) hero.face = dir;
      var accel = hero.ground ? ORP_ACCEL_GROUND : ORP_ACCEL_AIR;
      hero.vx = orpApproach(orpClamp(hero.vx, -ORP_RUN, ORP_RUN), dir * ORP_RUN, accel * dt);
      if (dashPressed && orpHas(prog, 'nice') && hero.dashCd <= 0 && sim.cpu >= ORP_DASH_COST) {
        hero.dash = ORP_DASH_TIME;
        hero.dashCd = ORP_DASH_COOLDOWN;
        sim.cpu -= ORP_DASH_COST;
        orpFx(sim, 'dust', hero.x - 3, hero.y + 2);
      }
    }
    if (hero.dash > 0) {
      hero.vx = hero.face * ORP_DASH_SPEED;
      hero.vy = 0;
    }
    if (shootPressed && hero.knock <= 0 && orpHas(prog, 'kill') && hero.shotCd <= 0 && sim.cpu >= ORP_SIGNAL_COST) {
      orpFire(sim);
    }
    if (shootPressed && !orpHas(prog, 'kill')) orpLacking(sim, 'kill');
    if (dashPressed && !orpHas(prog, 'nice')) orpLacking(sim, 'nice');
    if (free && hero.buffer > 0 && hero.coyote > 0) {
      hero.buffer = 0;
      if (input.down && orpOnPlatformOnly(sim)) {
        hero.drop = ORP_DROP_TIME;
      } else {
        hero.vy = -ORP_JUMP_SPEED;
        hero.coyote = 0;
        hero.cut = false;
      }
    }
    if (!input.jump && hero.vy < 0 && !hero.cut) {
      hero.vy *= ORP_JUMP_CUT;
      hero.cut = true;
    }
    if (hero.dash <= 0) hero.vy = Math.min(hero.vy + ORP_GRAVITY * dt, ORP_MAX_FALL);
    var hit = orpMove(sim, hero, hero.vx * dt, hero.vy * dt, hero.dash > 0, hero.drop > 0);
    if (hit.wall) {
      hero.vx = 0;
      hero.dash = 0;
    }
    hero.ground = hit.ground;
    if (hit.ground) {
      hero.vy = 0;
      hero.coyote = ORP_COYOTE;
      orpLanded(sim, hit.row);
    }
    if (hit.ceiling) hero.vy = 0;
    orpHazards(sim);
  }

  // Through an exit: into the linked room, at the same place along the
  // matching opening, just inside its edge.  Coming up through a floor
  // opening gives a jump's speed.
  function orpLeaveRoom(sim) {
    var hero = sim.hero;
    var data = orpRoom(sim.room);
    var cx = orpClamp(Math.floor((hero.x + ORP_HERO_W / 2) / ORP_TILE), 0, data.w - 1);
    var cy = orpClamp(Math.floor((hero.y + ORP_HERO_H / 2) / ORP_TILE), 0, data.h - 1);
    var digit = data.def.rows[cy].charAt(cx);
    var link = data.def.exits[digit];
    var from = data.exits[digit];
    var target = orpRoom(link[0]);
    var to = target.exits[link[1]];
    if (to.edge === 'west' || to.edge === 'east') {
      hero.y += (to.y - from.y) * ORP_TILE;
      hero.x = to.edge === 'west' ? ORP_TILE + 2 : (target.w - 1) * ORP_TILE - 2 - ORP_HERO_W;
    } else {
      hero.x += (to.x - from.x) * ORP_TILE;
      hero.y = to.edge === 'north' ? 2 : (target.h - 1) * ORP_TILE - 2 - ORP_HERO_H;
      if (to.edge === 'south') hero.vy = Math.min(hero.vy, -ORP_JUMP_SPEED);
    }
    hero.safeX = hero.x;
    hero.safeY = hero.y;
    orpEnterRoom(sim, link[0]);
    orpEvent(sim, 'room');
  }

  function orpOutside(sim) {
    var data = orpRoom(sim.room);
    var x = sim.hero.x + ORP_HERO_W / 2;
    var y = sim.hero.y + ORP_HERO_H / 2;
    return x < 0 || y < 0 || x >= data.w * ORP_TILE || y >= data.h * ORP_TILE;
  }

  // One hit on enemy e, unless its kind's guard turns it away; a hit it
  // survives runs the kind's hurt hook.  At 0 hp it is defeated: effects,
  // every third defeat drops a chip, XP, and then the kind's defeat hook
  // (so its message comes last).
  function orpDamage(sim, e) {
    var kind = ORP_KINDS[e.type];
    if (kind.guard && kind.guard(sim, e)) return;
    e.hp -= 1;
    e.flash = 0.15;
    if (e.hp > 0) {
      if (kind.hurt) kind.hurt(sim, e);
      return;
    }
    e.dead = true;
    sim.kills += 1;
    orpFx(sim, 'spark', e.x + e.w / 2 - 8, e.y + e.h / 2 - 8);
    if (sim.kills % ORP_DROP_EVERY === 0) {
      sim.seq += 1;
      orpSpawn(sim, 'chip', e.x + e.w / 2 - 5, e.y + e.h - 12, 'drop#' + sim.seq);
    }
    orpGainXp(sim, kind.xp);
    if (kind.defeat) kind.defeat(sim, e);
  }

  function orpFlipSwitch(sim, cx, cy) {
    var id = orpId(sim.room, cx, cy);
    if (sim.prog.switches.indexOf(id) !== -1) return;
    sim.prog.switches.push(id);
    orpMessage(sim, 'Switch on', 'The signal flipped the switch: a gate in this room is open.');
    orpEvent(sim, 'save');
  }

  // Whether signal s stops here: a switch, a solid tile or a target.
  function orpSignalHits(sim, s) {
    var cx = Math.floor((s.x + s.w / 2) / ORP_TILE);
    var cy = Math.floor((s.y + s.h / 2) / ORP_TILE);
    var stopped = orpTile(sim.room, cx, cy) === 's';
    if (stopped) orpFlipSwitch(sim, cx, cy);
    stopped = stopped || orpSolid(sim, cx, cy);
    var target = sim.ents.filter(function (e) { return ORP_KINDS[e.type].target && !e.dead && orpOverlap(s, e); })[0];
    if (!stopped && target) {
      orpDamage(sim, target);
      stopped = true;
    }
    if (stopped) orpFx(sim, 'spark', s.x + s.w / 2 - 8, s.y + s.h / 2 - 8);
    return stopped;
  }

  function orpSignalsStep(sim, dt) {
    sim.sigs = sim.sigs.filter(function (s) {
      var dx = s.vx * dt;
      s.x += dx;
      s.dist += Math.abs(dx);
      return !orpSignalHits(sim, s) && s.dist < ORP_SIGNAL_RANGE;
    });
  }

  function orpEntitiesStep(sim, dt) {
    var box = orpHeroBox(sim.hero);
    for (var i = 0; i < sim.ents.length; i++) {
      var e = sim.ents[i];
      var kind = ORP_KINDS[e.type];
      e.t += dt;
      e.flash = Math.max(0, e.flash - dt);
      if (!e.dead) kind.update(sim, e, dt);
      if (!e.dead && sim.mode === 'play' && orpOverlap(box, e)) kind.touch(sim, e);
    }
    sim.ents = sim.ents.filter(function (e) { return !e.dead; });
  }

  var ORP_FX = {
    spark: { frames: ['spark1', 'spark2', 'spark3'], life: 0.24 },
    dust: { frames: ['dust1', 'dust2'], life: 0.3 },
    reap: { frames: ['reap1', 'reap2', 'reap3'], life: 0.45 }
  };

  function orpFxStep(sim, dt) {
    sim.fx = sim.fx.filter(function (f) {
      f.t += dt;
      return f.t < ORP_FX[f.k].life;
    });
  }

  // Crumbling tiles: down ORP_CRUMBLE_DELAY after a landing, back after
  // ORP_CRUMBLE_BACK unless the hero stands in their place.
  function orpCrumbleStep(sim, dt) {
    var box = orpHeroBox(sim.hero);
    Object.keys(sim.crumble).forEach(function (key) {
      var c = sim.crumble[key];
      c.t += dt;
      if (!c.down && c.t >= ORP_CRUMBLE_DELAY) {
        c.down = true;
        c.t = 0;
        orpFx(sim, 'dust', c.x * ORP_TILE, c.y * ORP_TILE);
      } else if (c.down && c.t >= ORP_CRUMBLE_BACK &&
        !orpOverlap(box, { x: c.x * ORP_TILE, y: c.y * ORP_TILE, w: ORP_TILE, h: ORP_TILE })) {
        delete sim.crumble[key];
      }
    });
  }

  // A hero inside tiles that just came back stands on top of them (on top
  // of the whole pile, for stacked crates).
  function orpUnstick(sim) {
    var hero = sim.hero;
    var cols = orpSpan(hero.x, ORP_HERO_W);
    var rows = orpSpan(hero.y, ORP_HERO_H);
    function blocked(r) {
      for (var c = cols[0]; c <= cols[1]; c++) {
        if (orpSolid(sim, c, r)) return true;
      }
      return false;
    }
    for (var r = rows[0]; r <= rows[1]; r++) {
      if (!blocked(r)) continue;
      while (r > 0 && blocked(r - 1)) r -= 1;
      hero.y = r * ORP_TILE - ORP_HERO_H;
      return;
    }
  }

  // The cleanup sweep: in an area with a sweep, every temporary crate is
  // gone for ORP_SWEEP_GONE s every ORP_SWEEP_EVERY s, and blinks for
  // ORP_SWEEP_WARN s before.  In an arena the boss deletes them instead.
  function orpSweepStep(sim, dt) {
    if (!ORP_AREAS[sim.area].sweep || orpRoom(sim.room).def.arena) return;
    sim.sweep += dt;
    var swept = sim.sweep >= ORP_SWEEP_EVERY;
    if (sim.sweep >= ORP_SWEEP_EVERY + ORP_SWEEP_GONE) {
      sim.sweep -= ORP_SWEEP_EVERY + ORP_SWEEP_GONE;
      swept = false;
    }
    sim.warn = !swept && sim.sweep >= ORP_SWEEP_EVERY - ORP_SWEEP_WARN;
    if (swept === sim.swept) return;
    sim.swept = swept;
    if (!swept) orpUnstick(sim);
    orpEvent(sim, 'sweep', { gone: swept });
  }

  function orpCameraStep(sim, dt) {
    var target = orpCameraTarget(sim);
    var k = Math.min(1, dt * 6);
    sim.cam.x += (target.x - sim.cam.x) * k;
    sim.cam.y += (target.y - sim.cam.y) * k;
  }

  // One fixed step of the game: returns the next state (sim is left as it
  // was).  input: the keys held this step.
  function orpStep(sim, input) {
    var s = orpClone(sim);
    var dt = ORP_STEP;
    s.events = [];
    if (s.mode === 'dead') {
      s.deadT += dt;
      if (s.deadT >= ORP_DEATH_TIME) {
        orpRespawn(s);
        orpEvent(s, 'respawn');
      }
      return s;
    }
    if (s.mode !== 'play') return s;
    s.t += dt;
    s.roomT += dt;
    s.prog.time += dt;
    s.deniedT = Math.max(0, s.deniedT - dt);
    orpSweepStep(s, dt);
    orpCrumbleStep(s, dt);
    orpHeroStep(s, input, dt);
    if (s.mode === 'play' && orpOutside(s)) orpLeaveRoom(s);
    if (s.mode !== 'play') return s;
    orpSignalsStep(s, dt);
    orpEntitiesStep(s, dt);
    if (s.endT > 0) {
      s.endT -= dt;
      if (s.endT <= 0) orpEndEpisode(s);
    }
    orpFxStep(s, dt);
    orpCameraStep(s, dt);
    return s;
  }

  // ── Entities ──────────────────────────────────────────────────────────────

  function orpNoop() {}

  function orpTouchEnemy(sim, e) {
    orpHurt(sim, e.x + e.w / 2);
    if (ORP_KINDS[e.type].fragile) e.dead = true;
  }

  function orpHeroCentre(sim) {
    return { x: sim.hero.x + ORP_HERO_W / 2, y: sim.hero.y + ORP_HERO_H / 2 };
  }

  function orpCentre(e) {
    return { x: e.x + e.w / 2, y: e.y + e.h / 2 };
  }

  // A bug walks the floor and turns at walls and ledges.
  function orpBugUpdate(sim, e, dt) {
    e.vy = Math.min(e.vy + ORP_GRAVITY * dt, ORP_MAX_FALL);
    var hit = orpMove(sim, e, e.face * ORP_BUG_SPEED * dt, e.vy * dt, false, false);
    if (hit.ground) e.vy = 0;
    var aheadX = e.face > 0 ? e.x + e.w + 1 : e.x - 1;
    var col = Math.floor(aheadX / ORP_TILE);
    var row = Math.floor((e.y + e.h + 1) / ORP_TILE);
    var ledge = hit.ground && !orpSolid(sim, col, row) && orpTile(sim.room, col, row) !== '=';
    if (hit.wall || ledge) e.face = -e.face;
  }

  // A leaky daemon spawns a zombie every few seconds while the hero is near
  // and fewer than ORP_ZOMBIE_MAX of its zombies are alive.
  function orpDaemonUpdate(sim, e, dt) {
    e.cd -= dt;
    if (e.cd > 0) return;
    e.cd = ORP_DAEMON_SPAWN;
    var alive = sim.ents.filter(function (z) { return z.parent === e.id && !z.dead; }).length;
    var hero = orpHeroCentre(sim);
    var me = orpCentre(e);
    if (alive >= ORP_ZOMBIE_MAX || Math.abs(hero.x - me.x) + Math.abs(hero.y - me.y) > ORP_DAEMON_RANGE) return;
    sim.seq += 1;
    var z = orpSpawn(sim, 'zombie', e.x + 1, e.y - 10, e.id + '#' + sim.seq);
    z.parent = e.id;
    orpFx(sim, 'reap', z.x - 2, z.y - 1);
  }

  // Killing a daemon reaps its zombies: they vanish and give XP.
  function orpDaemonDefeat(sim, e) {
    sim.ents.forEach(function (z) {
      if (z.parent !== e.id || z.dead) return;
      z.dead = true;
      orpFx(sim, 'reap', z.x - 2, z.y - 1);
      orpGainXp(sim, ORP_KINDS.zombie.xp);
    });
  }

  // A zombie floats slowly toward the hero within ORP_ZOMBIE_RANGE, through
  // walls; signals pass through it.
  function orpZombieUpdate(sim, e, dt) {
    var hero = orpHeroCentre(sim);
    var me = orpCentre(e);
    var dx = hero.x - me.x;
    var dy = hero.y - me.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist >= ORP_ZOMBIE_RANGE) return;
    var step = ORP_ZOMBIE_SPEED * dt / Math.max(dist, 1);
    e.x += dx * step;
    e.y += dy * step;
    e.face = dx < 0 ? -1 : 1;
  }

  // A lockfile turret faces the hero and fires a slow straight shot every
  // ORP_TURRET_EVERY seconds.
  function orpTurretUpdate(sim, e, dt) {
    e.face = orpHeroCentre(sim).x < orpCentre(e).x ? -1 : 1;
    e.cd -= dt;
    if (e.cd > 0) return;
    e.cd = ORP_TURRET_EVERY;
    sim.seq += 1;
    var shot = orpSpawn(sim, 'shot', e.face > 0 ? e.x + e.w : e.x - 6, e.y + 4, e.id + '#' + sim.seq);
    shot.vx = e.face * ORP_SHOT_SPEED;
    shot.face = e.face;
  }

  function orpShotUpdate(sim, e, dt) {
    e.x += e.vx * dt;
    var c = orpCentre(e);
    if (e.t > ORP_SHOT_LIFE || orpSolid(sim, Math.floor(c.x / ORP_TILE), Math.floor(c.y / ORP_TILE))) e.dead = true;
  }

  // ── The boss ──────────────────────────────────────────────────────────────
  //
  // tmpfiles.d is one entity whose state runs the loop (see ORP_BOSS_HP):
  // sleep (at the right end until the hero comes in) -> intro -> windup ->
  // sweep (along the floor to the other end) -> warn -> files (the crates
  // gone, temp files falling) -> core (open: the only time it takes hits)
  // -> windup again; a hit that ends a phase goes to rage, then windup.
  // Every attack has its tell: the wind-up shakes it, the crates blink
  // before they go, a temp file hangs under the ceiling before it falls.
  // A one-way platform over the floor is above the sweep; the floor right
  // under one is where a falling file cannot reach.  From waking until it
  // is down (or the hero dies) a gate shuts the arena's door, so no spot
  // out of the sweep's reach is left and the fight cannot be walked out of.

  // Its phase (0, 1, 2): one for every 4 HP lost.
  function orpBossLevel(e) {
    return Math.floor((ORP_BOSS_HP - e.hp) / (ORP_BOSS_HP / ORP_BOSS_PHASES.length));
  }

  // Its x at the left and at the right end of the arena floor.
  function orpBossEnds(sim) {
    var arena = orpRoom(sim.room).def.arena;
    return [arena[0] * ORP_TILE + 2, (arena[1] + 1) * ORP_TILE - 2 - ORP_BOSS_W];
  }

  function orpBossState(e, state) {
    e.state = state;
    e.timer = 0;
  }

  function orpBossInit(sim, e) {
    e.x = orpBossEnds(sim)[1];
    e.dir = -1;
    orpBossState(e, 'sleep');
  }

  // The wind-up of a sweep toward the far end: dust at its feet.
  function orpBossWindup(sim, e) {
    var ends = orpBossEnds(sim);
    e.dir = e.x < (ends[0] + ends[1]) / 2 ? 1 : -1;
    e.face = e.dir;
    orpFx(sim, 'dust', e.x - 6, e.y + e.h - 14);
    orpFx(sim, 'dust', e.x + e.w - 10, e.y + e.h - 14);
    orpBossState(e, 'windup');
  }

  // The crates go and the temp files hang: one over the hero, the others
  // ORP_FILE_SPACING columns apart around it (none outside the arena), one
  // after another.
  function orpBossDelete(sim, e, phase) {
    var arena = orpRoom(sim.room).def.arena;
    var col = orpClamp(Math.floor(orpHeroCentre(sim).x / ORP_TILE), arena[0], arena[1]);
    sim.swept = true;
    sim.sweep = ORP_SWEEP_EVERY;
    orpEvent(sim, 'sweep', { gone: true });
    for (var i = 0; i < phase.files; i++) {
      var at = col + ((i + 1) >> 1) * (i % 2 ? 1 : -1) * ORP_FILE_SPACING;
      if (at < arena[0] || at > arena[1]) continue;
      sim.seq += 1;
      var file = orpSpawn(sim, 'file', at * ORP_TILE + 3, ORP_TILE, e.id + '#' + sim.seq);
      file.cd = phase.hang + i * ORP_FILE_STAGGER;
      file.vy = phase.fall;
    }
    orpBossState(e, 'files');
  }

  // The crates come back (a hero inside one stands on it) and the core
  // opens.
  function orpBossRestore(sim, e) {
    sim.swept = false;
    sim.sweep = 0;
    orpUnstick(sim);
    orpEvent(sim, 'sweep', { gone: false });
    orpBossState(e, 'core');
  }

  // What each state does in a step: (sim, e, dt, phase, ends).
  var ORP_BOSS_STATES = {
    // It wakes once the hero is 5 tiles in, and the gate shuts behind the
    // hero (far from it then, so it never closes on the hero).
    sleep: function (sim, e, dt, phase, ends) {
      if (orpHeroCentre(sim).x <= ends[0] + ORP_BOSS_WAKE) return;
      sim.shut = true;
      orpBossState(e, 'intro');
    },
    intro: function (sim, e) {
      if (e.timer >= ORP_BOSS_INTRO) orpBossWindup(sim, e);
    },
    windup: function (sim, e, dt, phase) {
      if (e.timer >= phase.windup) orpBossState(e, 'sweep');
    },
    sweep: function (sim, e, dt, phase, ends) {
      e.x = orpClamp(e.x + e.dir * phase.speed * dt, ends[0], ends[1]);
      if (e.x === ends[0] || e.x === ends[1]) orpBossState(e, 'warn');
    },
    warn: function (sim, e, dt, phase) {
      if (e.timer >= phase.warn) orpBossDelete(sim, e, phase);
    },
    files: function (sim, e) {
      sim.sweep = ORP_SWEEP_EVERY + ORP_SWEEP_GONE * e.timer / ORP_BOSS_GONE;
      if (e.timer >= ORP_BOSS_GONE) orpBossRestore(sim, e);
    },
    core: function (sim, e) {
      if (e.timer >= ORP_BOSS_CORE) orpBossWindup(sim, e);
    },
    rage: function (sim, e) {
      if (e.timer >= ORP_BOSS_RAGE) orpBossWindup(sim, e);
    }
  };

  function orpBossUpdate(sim, e, dt) {
    e.timer += dt;
    e.cd = Math.max(0, e.cd - dt);
    if (e.state !== 'windup' && e.state !== 'sweep') e.face = orpHeroCentre(sim).x < orpCentre(e).x ? -1 : 1;
    ORP_BOSS_STATES[e.state](sim, e, dt, ORP_BOSS_PHASES[orpBossLevel(e)], orpBossEnds(sim));
    sim.warn = e.state === 'warn';
  }

  // Only the open core takes a hit, and not twice within ORP_BOSS_HIT_EVERY.
  function orpBossGuard(sim, e) {
    return e.state !== 'core' || e.cd > 0;
  }

  // A hit: the core stays open for the next one later, unless the hit ended
  // a phase (it closes and the boss rages).
  function orpBossHurt(sim, e) {
    e.cd = ORP_BOSS_HIT_EVERY;
    if (e.hp % (ORP_BOSS_HP / ORP_BOSS_PHASES.length) === 0) orpBossState(e, 'rage');
  }

  // Down: the boss is saved as defeated, the gate opens, its wreck smokes
  // for a moment and the nice pedestal of the arena appears.
  function orpBossDefeat(sim, e) {
    sim.prog.boss = true;
    sim.shut = false;
    var wreck = orpSpawn(sim, 'wreck', e.x, e.y, e.id + '#wreck');
    wreck.face = e.face;
    orpRoom(sim.room).spawns.forEach(function (s) {
      if (s.type === 'capNice' && sim.prog.collected.indexOf(s.id) === -1) orpSpawnAt(sim, s);
    });
    orpMessage(sim, 'tmpfiles.d stopped', 'The cleaner is down and left the renice capability behind.');
    orpEvent(sim, 'save');
  }

  var ORP_BOSS_LOOKS = {
    sleep: [['bossIdle'], 1],
    intro: [['bossIdle', 'bossSweep1'], 0.25],
    windup: [['bossSweep1', 'bossSweep2'], 0.06],
    sweep: [['bossSweep1', 'bossSweep2'], 0.1],
    warn: [['bossIdle', 'bossSweep1'], 0.12],
    files: [['bossIdle'], 1],
    core: [['bossOpen'], 1],
    rage: [['bossHurt', 'bossSweep2'], 0.1]
  };

  function orpBossLook(sim, e) {
    if (e.flash > 0) return 'bossHurt';
    var look = ORP_BOSS_LOOKS[e.state];
    return orpFrame(look[0], e.timer, look[1]);
  }

  function orpBossUp(prog) {
    return !prog.boss;
  }

  function orpBossDown(prog) {
    return prog.boss;
  }

  // A temp file hangs under the ceiling for e.cd seconds, then falls at
  // e.vy until a solid tile or a platform stops it.
  function orpFileUpdate(sim, e, dt) {
    if (e.t < e.cd) return;
    e.y += e.vy * dt;
    var col = Math.floor((e.x + e.w / 2) / ORP_TILE);
    var row = Math.floor((e.y + e.h) / ORP_TILE);
    if (orpSolid(sim, col, row) || orpTile(sim.room, col, row) === '=') {
      e.dead = true;
      orpFx(sim, 'dust', e.x - 3, row * ORP_TILE - ORP_TILE);
    }
  }

  function orpWreckUpdate(sim, e) {
    if (e.t >= ORP_WRECK_TIME) e.dead = true;
  }

  function orpTouchTty(sim, e) {
    var prog = sim.prog;
    if (prog.tty === e.id && sim.rss >= prog.maxRss) return;
    if (prog.tty !== e.id) orpMessage(sim, 'tty', 'Checkpoint saved: a killed process restarts here with full RSS.');
    prog.tty = e.id;
    sim.rss = prog.maxRss;
    orpEvent(sim, 'save');
  }

  // Picks item e up: collected for good (except chips), with its message.
  function orpCollect(sim, e, title, text) {
    e.dead = true;
    sim.prog.collected.push(e.id);
    orpMessage(sim, title, text);
    orpEvent(sim, 'save');
  }

  function orpTouchMan(sim, e) {
    var page = orpManByKey(e.id.slice(4));
    orpCollect(sim, e, page.title, page.text);
    orpGainXp(sim, ORP_MAN_XP);
  }

  function orpTouchChip(sim, e) {
    e.dead = true;
    sim.rss = Math.min(sim.prog.maxRss, sim.rss + 1);
    orpFx(sim, 'spark', e.x - 3, e.y - 2);
  }

  function orpTouchModule(sim, e) {
    var prog = sim.prog;
    prog.maxRss = Math.min(ORP_MAX_RSS, prog.maxRss + 1);
    sim.rss = Math.min(prog.maxRss, sim.rss + 1);
    orpCollect(sim, e, 'Memory module', 'Max RSS ' + prog.maxRss + '.');
  }

  function orpCapability(ability, text) {
    return function (sim, e) {
      sim.prog.abilities.push(ability);
      orpCollect(sim, e, 'Capability: ' + ORP_ABILITY_NAMES[ability], text);
    };
  }

  function orpLook(names, every) {
    return function (sim, e) { return orpFrame(names, e.t, every); };
  }

  function orpLookFixed(name) {
    return function () { return name; };
  }

  var orpTakeNice = orpCapability('nice', 'C or K dashes 4 tiles: 30 CPU, no gravity, and it breaks cracked walls.');

  // The nice pedestal (only there once the boss is down): the capability
  // (renice to the player),
  // and the end of the episode a moment later.
  function orpTouchNice(sim, e) {
    orpTakeNice(sim, e);
    sim.endT = ORP_END_DELAY;
  }

  // The entity kinds.  w, h: the box; hp: hits a signal needs (target);
  // xp: what defeating it gives; enemy kinds hurt on contact (fragile ones
  // vanish then); update, touch, look and the optional hooks init (on
  // spawning), when, guard, hurt and defeat (see Rooms).
  var ORP_KINDS = {
    bug: { w: 12, h: 8, hp: 1, xp: 5, target: true, update: orpBugUpdate, touch: orpTouchEnemy, look: orpLook(['bug1', 'bug2'], 0.2) },
    daemon: {
      w: 14, h: 16, hp: 3, xp: 15, cd: 1, target: true, update: orpDaemonUpdate, touch: orpTouchEnemy, defeat: orpDaemonDefeat,
      look: function (sim, e) { return e.flash > 0 ? 'daemonHurt' : orpFrame(['daemon1', 'daemon2'], e.t, 0.4); }
    },
    zombie: { w: 12, h: 13, xp: 2, update: orpZombieUpdate, touch: orpTouchEnemy, look: orpLook(['zombie1', 'zombie2'], 0.3) },
    turret: {
      w: 14, h: 13, hp: 2, xp: 10, cd: 1, target: true, update: orpTurretUpdate, touch: orpTouchEnemy,
      look: function (sim, e) { return e.flash > 0 || e.cd < 0.3 ? 'turret2' : 'turret1'; }
    },
    shot: { w: 6, h: 6, fragile: true, update: orpShotUpdate, touch: orpTouchEnemy, look: orpLookFixed('turretShot') },
    tty: {
      w: 14, h: 14, update: orpNoop, touch: orpTouchTty,
      look: function (sim, e) { return sim.prog.tty === e.id ? 'ttyOn' : 'ttyOff'; }
    },
    man: { w: 10, h: 12, update: orpNoop, touch: orpTouchMan, look: orpLookFixed('man') },
    chip: { w: 10, h: 10, update: orpNoop, touch: orpTouchChip, look: orpLookFixed('chip') },
    module: { w: 12, h: 10, update: orpNoop, touch: orpTouchModule, look: orpLookFixed('module') },
    capKill: {
      w: 12, h: 14, update: orpNoop, look: orpLookFixed('capKill'),
      touch: orpCapability('kill', 'X or J sends a signal: 10 CPU, hurts processes and flips switches. Zombies ignore it.')
    },
    capNice: { w: 12, h: 14, when: orpBossDown, update: orpNoop, touch: orpTouchNice, look: orpLookFixed('capNice') },
    boss: {
      w: ORP_BOSS_W, h: ORP_BOSS_H, hp: ORP_BOSS_HP, xp: ORP_BOSS_XP, target: true, when: orpBossUp, init: orpBossInit,
      update: orpBossUpdate, touch: orpTouchEnemy, guard: orpBossGuard, hurt: orpBossHurt, defeat: orpBossDefeat,
      look: orpBossLook
    },
    file: { w: 10, h: 12, fragile: true, update: orpFileUpdate, touch: orpTouchEnemy, look: orpLookFixed('tempFile') },
    wreck: { w: ORP_BOSS_W, h: ORP_BOSS_H, update: orpWreckUpdate, touch: orpNoop, look: orpLookFixed('bossDead') }
  };

  // The hero's sprite for its state.
  function orpHeroSprite(sim) {
    var hero = sim.hero;
    if (sim.mode === 'dead') return orpFrame(['heroDead1', 'heroDead2'], sim.deadT, 0.3);
    if (hero.knock > 0) return 'heroHurt';
    if (hero.dash > 0) return 'heroDash';
    if (hero.shootT > 0) return 'heroShoot';
    if (!hero.ground) return hero.vy < 0 ? 'heroJump' : 'heroFall';
    if (Math.abs(hero.vx) > 10) return orpFrame(['heroRun1', 'heroRun2', 'heroRun3', 'heroRun2'], sim.t, 0.1);
    return orpFrame(['heroIdle1', 'heroIdle1', 'heroIdle1', 'heroIdle2'], sim.t, 0.6);
  }

  // How each drawn tile looks now: (sim, cx, cy, area) -> a sprite or ''.
  var ORP_TILE_LOOKS = {
    '#': function (sim, cx, cy, area) {
      if (orpTile(sim.room, cx, cy - 1) !== '#') return area.top;
      return orpHash(cx, cy, 6) % 3 === 0 ? area.inner : area.plain;
    },
    '=': orpLookFixed('platform'),
    '^': orpLookFixed('spikes'),
    '%': function (sim, cx, cy) {
      if (orpCrumbleDown(sim, cx, cy)) return '';
      return sim.crumble[cx + ',' + cy] ? 'crumble2' : 'crumble';
    },
    x: function (sim, cx, cy) { return orpSolid(sim, cx, cy) ? 'cracked' : ''; },
    c: orpLookFixed('crate'),
    t: function (sim) { return sim.swept || (sim.warn && Math.floor(sim.t * 8) % 2 === 1) ? '' : 'crateTemp'; },
    G: function (sim) { return orpGateOpen(sim) ? '' : 'gate'; },
    D: function (sim, cx, cy) { return orpTile(sim.room, cx, cy - 1) === 'D' ? 'doorBottom' : 'doorTop'; },
    s: function (sim, cx, cy) { return sim.prog.switches.indexOf(orpId(sim.room, cx, cy)) === -1 ? 'switchOff' : 'switchOn'; }
  };

  // The sprite of the tile at (cx, cy) now, or '' for none.
  function orpTileSprite(sim, cx, cy) {
    if (orpLocked(sim, cx, cy)) return 'gate';
    var ch = orpTile(sim.room, cx, cy);
    return orpHasOwn(ORP_TILE_LOOKS, ch) ? ORP_TILE_LOOKS[ch](sim, cx, cy, ORP_AREAS[sim.area]) : '';
  }

  // A decoration on air tile (cx, cy) above the top of the ground, or ''.
  function orpDecor(sim, cx, cy) {
    var area = ORP_AREAS[sim.area];
    if (orpTile(sim.room, cx, cy) !== '.' || orpTile(sim.room, cx, cy + 1) !== '#' || orpHash(cx, cy, 8) % 7 !== 0) return '';
    return area.decor[orpHash(cx, cy, 9) % area.decor.length];
  }

  // ── Saves (no DOM) ────────────────────────────────────────────────────────

  function orpParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function orpIsInt(value, low, high) {
    return typeof value === 'number' && Math.floor(value) === value && value >= low && value <= high;
  }

  // The strings of value that are in known, once each; [] for a non-array.
  function orpIdList(value, known) {
    if (!Array.isArray(value)) return [];
    return value.filter(function (id, i) { return known.indexOf(id) !== -1 && value.indexOf(id) === i; });
  }

  // The switches that open the way into area: those of the rooms of other
  // areas with an exit into it (the gate to /tmp).
  function orpAreaGates(area) {
    var ids = [];
    Object.keys(ORP_ROOMS).forEach(function (key) {
      var def = ORP_ROOMS[key];
      var into = def.area !== area && Object.keys(def.exits).some(function (digit) {
        return ORP_ROOMS[def.exits[digit][0]].area === area;
      });
      if (into) ids = ids.concat(orpRoom(key).switches);
    });
    return ids;
  }

  // An orp-state text as progress, each field checked on its own (a bad
  // field falls back to a new game's value); null when there is no save or
  // it has another version.  A last tty that is not in the world falls back
  // to the start; one past a gate turns the gate's switch on (a save that
  // stood there without it could not go back).
  function orpParseSave(text) {
    var data = orpParseJson(text);
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.v !== ORP_SAVE_VERSION) return null;
    var prog = orpFreshProgress();
    var known = orpKnownIds();
    if (typeof data.run === 'string' && /^[0-9a-z]{1,16}$/.test(data.run)) prog.run = data.run;
    if (typeof data.born === 'number' && isFinite(data.born) && data.born >= 0) prog.born = data.born;
    if (known.ttys.indexOf(data.tty) !== -1) prog.tty = data.tty;
    if (orpIsInt(data.maxRss, ORP_START_RSS, ORP_MAX_RSS)) prog.maxRss = data.maxRss;
    if (orpIsInt(data.maxCpu, ORP_START_CPU, ORP_MAX_CPU)) prog.maxCpu = data.maxCpu;
    if (orpIsInt(data.xp, 0, 1e6)) prog.xp = data.xp;
    if (orpIsInt(data.nice, ORP_MIN_NICE, ORP_START_NICE)) prog.nice = data.nice;
    prog.abilities = orpIdList(data.abilities, ORP_ABILITIES);
    prog.collected = orpIdList(data.collected, known.items);
    prog.switches = orpIdList(data.switches, known.switches);
    prog.walls = orpIdList(data.walls, known.walls);
    prog.boss = data.boss === true;
    prog.ended = data.ended === true;
    prog.visited = orpIdList(data.visited, known.rooms);
    if (typeof data.time === 'number' && isFinite(data.time) && data.time >= 0) prog.time = data.time;
    if (orpIsInt(data.deaths, 0, 1e6)) prog.deaths = data.deaths;
    orpAreaGates(ORP_ROOMS[orpSpawnPoint(prog).room].area).forEach(function (id) {
      if (prog.switches.indexOf(id) === -1) prog.switches.push(id);
    });
    return prog;
  }

  // Progress as the orp-state object, fields in a fixed order.
  function orpSerialize(prog) {
    return {
      v: ORP_SAVE_VERSION, run: prog.run, born: prog.born, tty: prog.tty, maxRss: prog.maxRss, maxCpu: prog.maxCpu,
      xp: prog.xp, nice: prog.nice, abilities: prog.abilities, collected: prog.collected, switches: prog.switches,
      walls: prog.walls, boss: prog.boss, ended: prog.ended, visited: prog.visited, time: prog.time, deaths: prog.deaths
    };
  }

  // Whether save a (progress) replaces save b: of two runs the one New game
  // made later (on a tie, the larger id); within one run, more play time.
  function orpWins(a, b) {
    if (a.run !== b.run) return a.born > b.born || (a.born === b.born && a.run > b.run);
    return a.time > b.time;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function orpCanvas(w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  function orpRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  // Every sprite rasterised once onto an atlas (and a mirrored copy, each
  // sprite flipped in its own cell, for facing left).  Returns
  // { map: name -> { x, y, w, h }, image, flip }.
  function orpBuildAtlas() {
    var map = {};
    var x = 0;
    var y = 0;
    var rowH = 0;
    Object.keys(ORP_SPRITES).forEach(function (name) {
      var rows = ORP_SPRITES[name];
      var w = rows[0].length;
      if (x + w > ORP_ATLAS_W) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      map[name] = { x: x, y: y, w: w, h: rows.length };
      x += w;
      rowH = Math.max(rowH, rows.length);
    });
    var height = y + rowH;
    var colours = {};
    Object.keys(ORP_PALETTE).forEach(function (key) { colours[key] = orpRgb(ORP_PALETTE[key]); });
    var images = [orpCanvas(ORP_ATLAS_W, height), orpCanvas(ORP_ATLAS_W, height)];
    images.forEach(function (canvas, flipped) {
      var ctx = canvas.getContext('2d');
      var data = ctx.createImageData(ORP_ATLAS_W, height);
      Object.keys(map).forEach(function (name) {
        var cell = map[name];
        ORP_SPRITES[name].forEach(function (row, j) {
          for (var i = 0; i < cell.w; i++) {
            var ch = row.charAt(flipped ? cell.w - 1 - i : i);
            if (ch === '.') continue;
            var at = ((cell.y + j) * ORP_ATLAS_W + cell.x + i) * 4;
            var rgb = colours[ch];
            data.data[at] = rgb[0];
            data.data[at + 1] = rgb[1];
            data.data[at + 2] = rgb[2];
            data.data[at + 3] = 255;
          }
        });
      });
      ctx.putImageData(data, 0, 0);
    });
    return { map: map, image: images[0], flip: images[1] };
  }

  // The procedural background of an area (sky, a skyline of chips, hanging
  // traces), one screen wide, drawn once.
  function orpBuildBackdrop(area) {
    var theme = ORP_AREAS[area];
    var canvas = orpCanvas(ORP_W, ORP_H);
    var ctx = canvas.getContext('2d');
    for (var y = 0; y < ORP_H; y++) {
      var t = y / ORP_H;
      var c = [0, 1, 2].map(function (i) { return Math.round(theme.sky[0][i] + (theme.sky[1][i] - theme.sky[0][i]) * t); });
      ctx.fillStyle = 'rgb(' + c.join(', ') + ')';
      ctx.fillRect(0, y, ORP_W, 1);
    }
    [[10, 70, 48], [70, 110, 34], [118, 54, 60], [196, 96, 40], [246, 60, 70], [330, 120, 30], [372, 80, 56], [440, 100, 40]]
      .forEach(function (b, i) {
        var top = 222 - b[1];
        ctx.fillStyle = theme.far;
        ctx.fillRect(b[0], top, b[2], b[1]);
        ctx.fillStyle = theme.farTop;
        ctx.fillRect(b[0], top, b[2], 1);
        for (var wy = top + 6; wy < 214; wy += 9) {
          for (var wx = b[0] + 4; wx < b[0] + b[2] - 4; wx += 7) {
            if (orpHash(wx, wy, i + 7) % 5 !== 0) continue;
            ctx.fillStyle = theme.win[orpHash(wx, wy, 9) % 3 ? 0 : 1];
            ctx.fillRect(wx, wy, 3, 2);
          }
        }
      });
    for (var x = 24; x < ORP_W; x += 56) {
      var length = 150 + orpHash(x, 0, 4) % 60;
      ctx.fillStyle = theme.trace;
      ctx.fillRect(x, 0, 1, length);
      ctx.fillStyle = theme.traceEnd;
      ctx.fillRect(x - 1, length, 3, 3);
    }
    return canvas;
  }

  function orpBuildArt() {
    var art = orpBuildAtlas();
    art.backdrops = {};
    Object.keys(ORP_AREAS).forEach(function (area) { art.backdrops[area] = orpBuildBackdrop(area); });
    return art;
  }

  // A position snapped to the screen's pixels: 1 / scale of a game pixel
  // (scale: screen pixels per game pixel, see orpDisplayScale).
  function orpSnap(value) {
    var scale = orpRuntime.scale;
    return Math.round(value * scale) / scale;
  }

  // The guide under the game: every canvas[data-orp-sprite] gets its sprite
  // from the atlas, at the canvas's own size (the page scales it up).  A
  // name that is not a sprite leaves its canvas blank.
  function orpDrawGuide(art) {
    var list = document.querySelectorAll('canvas[data-orp-sprite]');
    for (var i = 0; i < list.length; i++) {
      var cell = art.map[list[i].getAttribute('data-orp-sprite')];
      if (!cell) continue;
      list[i].getContext('2d').drawImage(art.image, cell.x, cell.y, cell.w, cell.h, 0, 0, cell.w, cell.h);
    }
  }

  function orpSprite(ctx, art, name, x, y, flipped) {
    var cell = art.map[name];
    ctx.drawImage(flipped ? art.flip : art.image, cell.x, cell.y, cell.w, cell.h, orpSnap(x), orpSnap(y), cell.w, cell.h);
  }

  // Text in the 3x5 pixel font (4 px a character); unknown characters are
  // blanks.
  function orpText(ctx, text, x, y, colour) {
    ctx.fillStyle = colour;
    String(text).toUpperCase().split('').forEach(function (ch, n) {
      var glyph = ORP_FONT[ch] || ORP_FONT[' '];
      for (var i = 0; i < 15; i++) {
        if (glyph.charAt(i) === '1') ctx.fillRect(x + n * 4 + i % 3, y + Math.floor(i / 3), 1, 1);
      }
    });
    return x + String(text).length * 4;
  }

  function orpRect(ctx, x, y, w, h, colour) {
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, w, h);
  }

  // A bar of width w filled to fraction.
  function orpBar(ctx, x, y, w, h, fraction, back, front) {
    orpRect(ctx, x, y, w, h, back);
    orpRect(ctx, x, y, Math.round(w * orpClamp(fraction, 0, 1)), h, front);
  }

  function orpDrawBackdrop(ctx, art, area, camX) {
    var scale = orpRuntime.scale;
    var offset = Math.floor(camX * ORP_PARALLAX * scale) / scale % ORP_W;
    ctx.drawImage(art.backdrops[area], -offset, 0);
    ctx.drawImage(art.backdrops[area], ORP_W - offset, 0);
  }

  function orpDrawTiles(ctx, art, sim, camX, camY) {
    var x0 = Math.floor(camX / ORP_TILE);
    var y0 = Math.floor(camY / ORP_TILE);
    for (var cy = y0; cy <= y0 + ORP_H / ORP_TILE + 1; cy++) {
      for (var cx = x0; cx <= x0 + ORP_W / ORP_TILE + 1; cx++) {
        var x = cx * ORP_TILE - camX;
        var y = cy * ORP_TILE - camY;
        var decor = orpDecor(sim, cx, cy);
        if (decor) orpSprite(ctx, art, decor, x, y, false);
        var name = orpTileSprite(sim, cx, cy);
        if (name) orpSprite(ctx, art, name, x, y, false);
      }
    }
  }

  // Where each part of the HUD goes: name -> { x, w } (w in pixels; text
  // is 4 px a character).  From the left: RSS (a chip per max RSS, or past
  // ORP_HUD_CHIPS a compact "rss/max" with a bar), CPU, nice with its XP
  // bar, man pages and, in an area that has one, the sweep; at the right
  // end the area and the PID before it.
  function orpHudLayout(sim) {
    var prog = sim.prog;
    var area = ORP_AREAS[sim.area];
    var items = {};
    var x = 5;
    function put(name, w, gap) {
      items[name] = { x: x, w: w };
      x += w + gap;
    }
    put('rssLabel', 12, 2);
    put('rss', prog.maxRss > ORP_HUD_CHIPS ? ORP_HUD_COMPACT_W : prog.maxRss * 7 - 2, 8);
    put('cpuLabel', 12, 2);
    put('cpu', 40, 10);
    put('nice', ('NICE ' + prog.nice).length * 4, 4);
    put('xp', 30, 10);
    put('man', ('MAN ' + orpManFound(prog).length + '/' + ORP_MAN.length).length * 4, 12);
    if (area.sweep) {
      put('sweepLabel', 20, 4);
      put('sweep', 30, 0);
    }
    var label = area.label.length * 4;
    items.area = { x: ORP_W - 4 - label, w: label };
    var pid = ('PID ' + (4242 + prog.deaths)).length * 4;
    items.pid = { x: items.area.x - 12 - pid, w: pid };
    return items;
  }

  // The HUD as in the style sample (see orpHudLayout).
  function orpDrawHud(ctx, sim) {
    var prog = sim.prog;
    var area = ORP_AREAS[sim.area];
    var at = orpHudLayout(sim);
    ctx.fillStyle = 'rgba(5, 8, 15, 0.8)';
    ctx.fillRect(0, 0, ORP_W, ORP_HUD_H);
    orpText(ctx, 'RSS', at.rssLabel.x, 5, '#f472b6');
    if (prog.maxRss > ORP_HUD_CHIPS) {
      orpText(ctx, sim.rss + '/' + prog.maxRss, at.rss.x, 5, '#f472b6');
      orpBar(ctx, at.rss.x + 24, 5, ORP_HUD_COMPACT_W - 24, 5, sim.rss / prog.maxRss, '#3b1030', '#f472b6');
    } else {
      for (var i = 0; i < prog.maxRss; i++) orpRect(ctx, at.rss.x + i * 7, 4, 5, 7, i < sim.rss ? '#f472b6' : '#3b1030');
    }
    orpText(ctx, 'CPU', at.cpuLabel.x, 5, '#22d3ee');
    orpBar(ctx, at.cpu.x, 5, 40, 5, sim.cpu / prog.maxCpu, '#0b2a33', '#22d3ee');
    orpText(ctx, 'NICE ' + prog.nice, at.nice.x, 5, '#f59e0b');
    orpBar(ctx, at.xp.x, 6, 30, 3, prog.xp / orpXpNeeded(prog.nice), '#3a2a08', '#f59e0b');
    orpText(ctx, 'MAN ' + orpManFound(prog).length + '/' + ORP_MAN.length, at.man.x, 5, '#e2e8f0');
    if (area.sweep) {
      orpText(ctx, 'SWEEP', at.sweepLabel.x, 5, '#f59e0b');
      var left = sim.swept ? 1 - (sim.sweep - ORP_SWEEP_EVERY) / ORP_SWEEP_GONE : 1 - sim.sweep / ORP_SWEEP_EVERY;
      orpBar(ctx, at.sweep.x, 5, 30, 5, left, '#3a1408', sim.swept ? '#ef4444' : '#f59e0b');
    }
    orpText(ctx, 'PID ' + (4242 + prog.deaths), at.pid.x, 5, '#94a3b8');
    orpText(ctx, area.label, at.area.x, 5, area.color);
  }

  // The boss's name and HP at the bottom of the screen, once it is awake.
  function orpDrawBossBar(ctx, boss) {
    orpRect(ctx, 120, ORP_H - 19, 240, 13, 'rgba(5, 8, 15, 0.85)');
    orpText(ctx, 'TMPFILES.D', 126, ORP_H - 15, '#f472b6');
    orpBar(ctx, 172, ORP_H - 15, 182, 5, boss.hp / ORP_BOSS_HP, '#3b1030', '#f472b6');
  }

  function orpDrawWorld(ctx, art, sim) {
    var camX = orpSnap(sim.cam.x);
    var camY = orpSnap(sim.cam.y);
    var hero = sim.hero;
    orpDrawBackdrop(ctx, art, sim.area, camX);
    orpDrawTiles(ctx, art, sim, camX, camY);
    sim.ents.forEach(function (e) {
      var name = ORP_KINDS[e.type].look(sim, e);
      var cell = art.map[name];
      orpSprite(ctx, art, name, e.x + e.w / 2 - cell.w / 2 - camX, e.y + e.h - cell.h - camY, e.face < 0);
    });
    sim.sigs.forEach(function (s) {
      orpSprite(ctx, art, orpFrame(['signal1', 'signal2'], sim.t, 0.08), s.x - 3 - camX, s.y - 6 - camY, s.vx < 0);
    });
    var blink = sim.mode === 'play' && hero.inv > 0 && Math.floor(hero.inv * 10) % 2 === 0;
    if (!blink) orpSprite(ctx, art, orpHeroSprite(sim), hero.x - 3 - camX, hero.y - 2 - camY, hero.face < 0);
    sim.fx.forEach(function (f) {
      var info = ORP_FX[f.k];
      orpSprite(ctx, art, info.frames[Math.floor(f.t / info.life * info.frames.length)], f.x - camX, f.y - camY, false);
    });
    orpDrawHud(ctx, sim);
    sim.ents.forEach(function (e) {
      if (e.type === 'boss' && e.state !== 'sleep') orpDrawBossBar(ctx, e);
    });
    if (sim.roomT < ORP_BANNER_TIME) {
      var title = orpRoom(sim.room).def.title;
      orpText(ctx, title, Math.round((ORP_W - title.length * 4) / 2), ORP_HUD_H + 8, '#e2e8f0');
    }
    if (sim.mode === 'dead') {
      ctx.fillStyle = 'rgba(239, 68, 68, ' + (0.45 * (1 - sim.deadT / ORP_DEATH_TIME)).toFixed(3) + ')';
      ctx.fillRect(0, 0, ORP_W, ORP_H);
      orpText(ctx, 'KILLED', ORP_W / 2 - 12, ORP_H / 2 - 3, '#e2e8f0');
    }
  }

  // ── Between two steps (no DOM) ────────────────────────────────────────────
  //
  // The simulation runs 120 steps a second whatever the display's rate, so
  // a frame draws the state between the last two steps: alpha (0..1) of the
  // way from prev to sim, alpha being the accumulator's share of a step.
  // The hero, the entities, the signals and the camera move in between;
  // nothing is blended across a jump (a room change, a respawn, the return
  // to safe ground after spikes) or for a thing that was not there before.

  // Box b (any object with x and y) as a copy at alpha of the way from a.
  function orpMixed(a, b, alpha) {
    var c = {};
    Object.keys(b).forEach(function (key) { c[key] = b[key]; });
    c.x = a.x + (b.x - a.x) * alpha;
    c.y = a.y + (b.y - a.y) * alpha;
    return c;
  }

  // What to draw between steps prev and sim: sim itself when there is no
  // prev or it jumped, else a copy of sim with the moving parts in between.
  // Both states are left alone.
  function orpBetween(prev, sim, alpha) {
    if (!prev || prev.room !== sim.room || prev.mode !== sim.mode) return sim;
    var view = {};
    Object.keys(sim).forEach(function (key) { view[key] = sim[key]; });
    if (prev.hero.warp === sim.hero.warp) view.hero = orpMixed(prev.hero, sim.hero, alpha);
    var before = {};
    prev.ents.forEach(function (e) { before[e.id] = e; });
    view.ents = sim.ents.map(function (e) {
      return orpHasOwn(before, e.id) ? orpMixed(before[e.id], e, alpha) : e;
    });
    // A signal flies straight: a step ago it was one step back, unless it
    // was fired in this step.
    view.sigs = sim.sigs.map(function (s) {
      var step = s.vx * ORP_STEP;
      return s.dist > Math.abs(step) + ORP_EPS ? orpMixed({ x: s.x - step, y: s.y }, s, alpha) : s;
    });
    view.cam = orpMixed(prev.cam, sim.cam, alpha);
    return view;
  }

  // The map: rooms as boxes on a grid of 64 x 36 px cells (a box may span
  // several), each area under its name, visited ones lit with their name,
  // the current one marked, and the completion.
  function orpDrawMap(ctx, sim) {
    var prog = sim.prog;
    orpRect(ctx, 0, 0, ORP_W, ORP_H, '#0a0f1e');
    orpText(ctx, 'MAP', 20, 16, '#e2e8f0');
    var top = {};
    Object.keys(ORP_AREAS).forEach(function (area) { top[area] = Infinity; });
    Object.keys(ORP_ROOMS).forEach(function (key) {
      var def = ORP_ROOMS[key];
      top[def.area] = Math.min(top[def.area], def.map[1]);
    });
    Object.keys(ORP_AREAS).forEach(function (area) {
      orpText(ctx, ORP_AREAS[area].label, 20, 36 + top[area] * 36, ORP_AREAS[area].color);
    });
    Object.keys(ORP_ROOMS).forEach(function (key) {
      var def = ORP_ROOMS[key];
      var area = ORP_AREAS[def.area];
      var x = 20 + def.map[0] * 64;
      var y = 48 + def.map[1] * 36;
      var w = (def.map[2] || 1) * 64 - 8;
      var h = (def.map[3] || 1) * 36 - 8;
      var visited = prog.visited.indexOf(key) !== -1;
      orpRect(ctx, x, y, w, h, key === sim.room ? '#e2e8f0' : visited ? area.color : '#2a3a5c');
      orpRect(ctx, x + 1, y + 1, w - 2, h - 2, visited ? area.dark : '#111827');
      if (visited) orpText(ctx, (def.label || def.title.split('/').pop()).slice(0, 13), x + 3, y + 11, '#e2e8f0');
    });
    orpText(ctx, 'COMPLETE ' + orpCompletion(prog) + '%', 20, ORP_H - 36, '#f59e0b');
    orpText(ctx, 'MAN PAGES ' + orpManFound(prog).length + '/' + ORP_MAN.length, 20, ORP_H - 26, '#e2e8f0');
    orpText(ctx, 'M CLOSES THE MAP', 20, ORP_H - 16, '#94a3b8');
  }

  // ── Page ──────────────────────────────────────────────────────────────────

  // The whole number of screen pixels a game pixel is shown at (CSS pixels;
  // devicePixelRatio aside): 2 at 960 x 540, the multiple in fullscreen, 1
  // when the canvas is narrower than 960 px (or not laid out).
  function orpDisplayScale() {
    var els = orpRuntime.els;
    var width = document.fullscreenElement === els.stage ?
      orpFullscreenSize(els.stage.clientWidth, els.stage.clientHeight).width : els.canvas.clientWidth;
    return Math.max(1, Math.floor(width / ORP_W));
  }

  // Draws the page.  The canvas's backing store is 480 x 270 game pixels at
  // the scale it is shown at, so motion moves by screen pixels, not by game
  // pixels; between steps the frame draws the state alpha of the way from
  // the step before (see orpBetween).
  function orpRender() {
    var rt = orpRuntime;
    var els = rt.els;
    var sim = rt.sim;
    var screen = rt.screen;
    var scale = orpDisplayScale();
    if (els.canvas.width !== ORP_W * scale) {
      els.canvas.width = ORP_W * scale;
      els.canvas.height = ORP_H * scale;
    }
    rt.scale = scale;
    rt.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    rt.ctx.imageSmoothingEnabled = false;
    if (screen === 'map') {
      orpDrawMap(rt.ctx, sim);
    } else if (sim) {
      var alpha = orpClamp(rt.acc / ORP_STEP_MS, 0, 1);
      orpDrawWorld(rt.ctx, rt.art, rt.next === sim ? orpBetween(rt.prev, sim, alpha) : sim);
    } else {
      orpDrawBackdrop(rt.ctx, rt.art, 'home', 0);
    }
    els.start.classList.toggle('orp-hidden', screen !== 'title');
    els.paused.classList.toggle('orp-hidden', screen !== 'pause');
    els.end.classList.toggle('orp-hidden', screen !== 'end');
    els.focus.classList.toggle('orp-hidden', rt.focused || (screen !== 'play' && screen !== 'map'));
    els.continueButton.disabled = !rt.hasSave;
    els.newGame.textContent = rt.confirming ? 'Confirm new game' : 'New game';
  }

  function orpHideToast() {
    orpRuntime.toastTimeout = null;
    orpRuntime.els.toast.classList.remove('orp-show');
  }

  function orpShowToast(text) {
    var toast = orpRuntime.els.toast;
    clearTimeout(orpRuntime.toastTimeout);
    toast.textContent = text;
    toast.classList.add('orp-show');
    orpRuntime.toastTimeout = setTimeout(orpHideToast, ORP_TOAST_MS);
  }

  function orpDisplayMessage(message) {
    var rt = orpRuntime;
    rt.message = message;
    rt.els.msgTitle.textContent = message.title;
    rt.els.msgText.textContent = message.text;
    rt.els.msg.classList.remove('orp-hidden');
    rt.messageLeft = ORP_MESSAGE_STEPS;
  }

  // The message box closes (Enter or its time ran out); the next waiting
  // message takes its place.
  function orpHideMessage() {
    var rt = orpRuntime;
    rt.messageLeft = 0;
    rt.message = null;
    rt.els.msg.classList.add('orp-hidden');
    var next = rt.messages.shift();
    if (next) orpDisplayMessage(next);
  }

  function orpClearMessages() {
    orpRuntime.messages = [];
    orpHideMessage();
  }

  // A message box over the game: a man page, a capability, a level, a
  // refusal.  Each one shows for its full ORP_MESSAGE_MS of play, counted
  // in fixed steps by orpAdvance (Enter closes it sooner): one that comes
  // while another shows waits its turn, unless the same message already
  // shows or waits.
  function orpShowMessage(title, text) {
    var rt = orpRuntime;
    var message = { title: title, text: text };
    var same = function (other) { return !!other && other.title === title && other.text === text; };
    if (same(rt.message) || rt.messages.some(same)) return;
    if (rt.message) {
      rt.messages.push(message);
    } else {
      orpDisplayMessage(message);
    }
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  function orpWarnStorage(error) {
    if (orpRuntime.failed) return;
    orpRuntime.failed = true;
    var warning = orpRuntime.els.warning;
    warning.textContent = 'Storage is blocked or full (' + error.name + '): ' + ORP_SAVE_KEY +
      ' is not saved on this page. The game plays on, but a reload starts from the title again.';
    warning.classList.remove('orp-hidden');
  }

  function orpStorageGet() {
    try {
      return localStorage.getItem(ORP_SAVE_KEY);
    } catch (error) {
      orpWarnStorage(error);
      return null;
    }
  }

  function orpStorageSet(text) {
    try {
      localStorage.setItem(ORP_SAVE_KEY, text);
    } catch (error) {
      orpWarnStorage(error);
    }
  }

  // The wall clock (ms), for the birth of a run; tests replace Date.now.
  function orpNow() {
    return Date.now();
  }

  // A new run's id: six base-36 digits.
  function orpRunId() {
    return (1e9 + Math.floor(Math.random() * 1e9)).toString(36).slice(-6);
  }

  // The game Continue resumes: the stored save or the one this page last
  // wrote (blocked or full storage), whichever wins; null for none.
  function orpLoadSave() {
    var stored = orpParseSave(orpStorageGet());
    var kept = orpParseSave(orpRuntime.memory);
    if (!stored) return kept;
    return kept && orpWins(kept, stored) ? kept : stored;
  }

  // Another tab's save wins over this tab's game (see orpWins): of the
  // same run (it played further), this tab restarts from it at its last
  // tty; of a later run (New game there), this tab stops writing.  Returns
  // whether this tab must not write.
  function orpTakeOver() {
    var rt = orpRuntime;
    var stored = orpParseSave(orpStorageGet());
    if (!stored || !orpWins(stored, rt.sim.prog)) return false;
    if (stored.run !== rt.sim.prog.run) {
      if (!rt.stale) orpShowToast('Another tab started a new game: this tab no longer saves. Reload the page to play that one.');
      rt.stale = true;
      return true;
    }
    rt.sim = orpNewSim(stored);
    orpShowToast('Another tab played further (' + orpFormatTime(stored.time) + ' of play): this tab continues from its last tty.');
    orpRender();
    return true;
  }

  // Writes the game's progress (and keeps it in memory), unless another
  // tab's save wins.  force: a new game, which replaces the save on
  // purpose.
  function orpSave(force) {
    var rt = orpRuntime;
    if (!force && orpTakeOver()) return;
    rt.memory = JSON.stringify(orpSerialize(rt.sim.prog));
    orpStorageSet(rt.memory);
    rt.hasSave = true;
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  function orpCanRun() {
    return orpRuntime.screen === 'play' && orpRuntime.focused && !document.hidden;
  }

  function orpReleaseKeys() {
    var keys = orpRuntime.keys;
    Object.keys(keys).forEach(function (name) { keys[name] = false; });
  }

  // Starts or stops the loop to match orpCanRun.  A loop that starts again
  // forgets the time it stood (and draws the state it stands at).
  function orpUpdateLoop() {
    var rt = orpRuntime;
    var run = orpCanRun();
    if (run && rt.frame === null) {
      rt.lastTs = null;
      rt.acc = 0;
      rt.next = null;
      rt.frame = requestAnimationFrame(orpFrameTick);
    } else if (!run && rt.frame !== null) {
      cancelAnimationFrame(rt.frame);
      rt.frame = null;
    }
  }

  // A screen change: the loop follows and the page is drawn once.
  function orpShow(screen) {
    orpRuntime.screen = screen;
    orpUpdateLoop();
    orpRender();
  }

  function orpRenderEnd() {
    var rt = orpRuntime;
    var prog = rt.sim.prog;
    var list = rt.els.endStats;
    list.textContent = '';
    [
      'Time ' + orpFormatTime(prog.time),
      'Deaths ' + prog.deaths,
      'Man pages ' + orpManFound(prog).length + ' of ' + ORP_MAN.length,
      'Completion ' + orpCompletion(prog) + ' %'
    ].forEach(function (line) {
      var item = document.createElement('li');
      item.className = 'orp-end-item';
      item.textContent = line;
      list.appendChild(item);
    });
  }

  // One fixed step of the game and what its events mean for the page.  The
  // message box's time runs here, so it only runs while the game does.
  function orpAdvance() {
    var rt = orpRuntime;
    var keys = rt.keys;
    if (rt.message) {
      rt.messageLeft -= 1;
      if (rt.messageLeft <= 0) orpHideMessage();
    }
    rt.prev = rt.sim;
    rt.sim = orpStep(rt.sim, {
      left: keys.left, right: keys.right, jump: keys.jump, down: keys.down, shoot: keys.shoot, dash: keys.dash
    });
    rt.next = rt.sim;
    var save = false;
    rt.sim.events.forEach(function (event) {
      if (event.type === 'msg') orpShowMessage(event.title, event.text);
      save = save || event.type === 'save';
    });
    if (save) orpSave(false);
    if (rt.sim.mode === 'end') orpShowEnd();
  }

  function orpShowEnd() {
    orpRenderEnd();
    orpShow('end');
  }

  function orpFrameTick(ts) {
    var rt = orpRuntime;
    rt.frame = null;
    var last = rt.lastTs === null ? ts : rt.lastTs;
    rt.lastTs = ts;
    rt.acc += orpClamp(ts - last, 0, ORP_MAX_FRAME_MS);
    while (rt.acc >= ORP_STEP_MS && orpCanRun()) {
      rt.acc -= ORP_STEP_MS;
      orpAdvance();
    }
    orpRender();
    if (rt.frame === null && orpCanRun()) rt.frame = requestAnimationFrame(orpFrameTick);
  }

  // ── Game flow ─────────────────────────────────────────────────────────────

  function orpEndConfirm() {
    clearTimeout(orpRuntime.confirmTimeout);
    orpRuntime.confirmTimeout = null;
    orpRuntime.confirming = false;
  }

  function orpConfirmExpired() {
    orpEndConfirm();
    orpRender();
  }

  // Gives the canvas the keys (the focus event follows in a browser; the
  // flag is set here too, from where the focus really is).
  function orpGrabFocus() {
    var rt = orpRuntime;
    rt.els.canvas.focus();
    rt.focused = document.activeElement === rt.els.canvas;
  }

  // A game from the title: it plays, or (a game that ended) it shows the
  // end screen, saved as shown.
  function orpPlay(sim) {
    var rt = orpRuntime;
    rt.sim = sim;
    rt.stale = false;
    orpGrabFocus();
    if (sim.mode === 'end') {
      orpSave(false);
      orpShowEnd();
    } else {
      orpShow('play');
    }
  }

  // New game: at once when there is no save, else on a second press within
  // 4 s (the first one names what would be lost).  It starts a new run.
  function orpNewGame() {
    var rt = orpRuntime;
    var stored = orpLoadSave();
    if (stored && !rt.confirming) {
      rt.confirming = true;
      rt.confirmTimeout = setTimeout(orpConfirmExpired, ORP_CONFIRM_MS);
      orpShowToast('Press New game again within 4 s to replace your saved game (nice ' + stored.nice + ', ' +
        orpFormatTime(stored.time) + ' of play).');
      orpRender();
      return;
    }
    orpEndConfirm();
    var prog = orpFreshProgress();
    prog.run = orpRunId();
    prog.born = orpNow();
    rt.sim = orpNewSim(prog);
    orpSave(true);
    orpPlay(rt.sim);
  }

  // A game restarted at its last tty (or the start) from prog: Continue
  // and Back to last tty.  A game that took nice but never showed its end
  // screen (a reload or a restart within ORP_END_DELAY) shows it first.
  function orpRestart(prog) {
    var sim = orpNewSim(prog);
    if (orpHas(prog, 'nice') && !prog.ended) orpEndEpisode(sim);
    orpPlay(sim);
  }

  // Continue: the saved game at its last tty.
  function orpContinue() {
    var stored = orpLoadSave();
    orpEndConfirm();
    if (!stored) {
      orpRuntime.hasSave = false;
      orpRender();
      return;
    }
    orpRestart(stored);
  }

  // Back to last tty (pause screen): what a reload and Continue do, without
  // the reload.  The progress is saved first (another tab that played
  // further takes over as usual), then the game restarts from it at the
  // last tty with the room entered fresh.  Not a death: no death counted,
  // no flash.  Messages and held keys do not carry over, and a tab that no
  // longer saves (a later run elsewhere) stays that way.
  function orpBackToTty() {
    var rt = orpRuntime;
    orpSave(false);
    var stale = rt.stale;
    orpClearMessages();
    orpReleaseKeys();
    orpRestart(rt.sim.prog);
    rt.stale = stale;
  }

  function orpRenderManList() {
    var els = orpRuntime.els;
    var found = orpManFound(orpRuntime.sim.prog);
    els.manCount.textContent = 'Man pages found: ' + found.length + ' of ' + ORP_MAN.length + '.';
    els.manList.textContent = '';
    found.forEach(function (page) {
      var item = document.createElement('li');
      item.className = 'orp-man-item';
      var name = document.createElement('strong');
      name.className = 'orp-man-name';
      name.textContent = page.title;
      item.appendChild(name);
      item.appendChild(document.createTextNode(' ' + page.text));
      els.manList.appendChild(item);
    });
  }

  function orpPause() {
    orpReleaseKeys();
    orpSave(false);
    orpRenderManList();
    orpShow('pause');
  }

  function orpResume() {
    orpGrabFocus();
    orpShow('play');
  }

  function orpTogglePause() {
    var screen = orpRuntime.screen;
    if (screen === 'play' || screen === 'map') {
      orpPause();
    } else if (screen === 'pause') {
      orpResume();
    }
  }

  function orpToggleMap() {
    var screen = orpRuntime.screen;
    if (screen === 'play') {
      orpReleaseKeys();
      orpShow('map');
    } else if (screen === 'map') {
      orpShow('play');
    }
  }

  function orpBackToTitle() {
    orpRuntime.sim = null;
    orpClearMessages();
    orpShow('title');
  }

  // Enter: the end screen goes back to the title; in play it closes the
  // message box.
  function orpConfirmKey() {
    if (orpRuntime.screen === 'end') {
      orpBackToTitle();
    } else {
      orpHideMessage();
    }
  }

  function orpQuiet(result) {
    if (result && typeof result.catch === 'function') result.catch(orpNoop);
  }

  // F: the stage in and out of fullscreen, where the browser has the API.
  function orpToggleFullscreen() {
    var doc = document;
    var stage = orpRuntime.els.stage;
    if (doc.fullscreenElement) {
      if (typeof doc.exitFullscreen === 'function') orpQuiet(doc.exitFullscreen());
    } else if (typeof stage.requestFullscreen === 'function') {
      orpQuiet(stage.requestFullscreen());
    }
  }

  // The canvas size in fullscreen: the largest whole multiple of 480 x 270
  // that fits (every game pixel the same size), or below x1 the largest
  // 16:9 size that fits.
  function orpFullscreenSize(width, height) {
    var fit = Math.min(width / ORP_W, height / ORP_H);
    var scale = fit >= 1 ? Math.floor(fit) : fit;
    return { width: Math.floor(ORP_W * scale), height: Math.floor(ORP_H * scale) };
  }

  // On entering, leaving or resizing fullscreen (and any window resize):
  // the canvas gets its fullscreen size inline, and loses it again outside
  // fullscreen; the page is drawn again, so the backing store follows the
  // new scale.
  function orpFitFullscreen() {
    var els = orpRuntime.els;
    var style = els.canvas.style;
    if (document.fullscreenElement === els.stage) {
      var size = orpFullscreenSize(els.stage.clientWidth, els.stage.clientHeight);
      style.width = size.width + 'px';
      style.height = size.height + 'px';
    } else {
      style.width = '';
      style.height = '';
    }
    orpRender();
  }

  var ORP_COMMANDS = {
    map: orpToggleMap,
    pause: orpTogglePause,
    fullscreen: orpToggleFullscreen,
    confirm: orpConfirmKey
  };

  // ── Input ─────────────────────────────────────────────────────────────────

  // The action of a key, by its value and then by the physical key; or null.
  function orpKeyAction(event) {
    if (typeof event.key !== 'string') return null;
    var key = event.key.toLowerCase();
    if (orpHasOwn(ORP_KEYS, key)) return ORP_KEYS[key];
    return orpHasOwn(ORP_CODES, event.code) ? ORP_CODES[event.code] : null;
  }

  // The action of a key the game takes (no Ctrl, Alt or Meta, not while
  // composing), or null.
  function orpOwnKey(event) {
    var action = orpKeyAction(event);
    return action && !(event.ctrlKey || event.metaKey || event.altKey || event.isComposing) ? action : null;
  }

  // Keys reach these listeners only while the canvas has the focus.  Held
  // actions stay down until their keyup; commands act once per press.  A
  // key the game takes neither scrolls the page nor reaches the host page's
  // own shortcuts.
  function orpHandleKeydown(event) {
    var action = orpOwnKey(event);
    if (!action || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (ORP_HELD[action]) {
      orpRuntime.keys[action] = true;
    } else if (!event.repeat) {
      ORP_COMMANDS[action]();
    }
  }

  function orpHandleKeyup(event) {
    var action = orpKeyAction(event);
    if (action && ORP_HELD[action]) orpRuntime.keys[action] = false;
    if (orpOwnKey(event)) event.stopPropagation();
  }

  function orpHandleFocus() {
    orpRuntime.focused = true;
    orpUpdateLoop();
    orpRender();
  }

  // The canvas lost the focus: keys are let go, the game stands still and
  // is saved, and the "Click to play" overlay shows.
  function orpHandleBlur() {
    var rt = orpRuntime;
    rt.focused = false;
    orpReleaseKeys();
    if (rt.sim) orpSave(false);
    orpUpdateLoop();
    orpRender();
  }

  // A hidden tab pauses a game in play (and saves it); shown again it
  // waits on the pause screen.
  function orpHandleVisibility() {
    if (document.hidden && orpRuntime.screen === 'play') {
      orpPause();
    } else {
      orpUpdateLoop();
    }
  }

  // Another tab wrote the save: on the title screen Continue follows it; in
  // a game, a save that wins there takes over here (see orpTakeOver).
  function orpHandleStorage(event) {
    if (event.key !== ORP_SAVE_KEY) return;
    if (orpRuntime.sim) {
      orpTakeOver();
    } else {
      orpRuntime.hasSave = !!orpLoadSave();
      orpRender();
    }
  }

  function orpHandlePageHide() {
    if (orpRuntime.sim) orpSave(false);
  }

  // Click to play: the canvas takes the keys and the game goes on.
  function orpFocusCanvas() {
    orpGrabFocus();
    orpShow(orpRuntime.screen);
  }

  function orpBindEvents() {
    var els = orpRuntime.els;
    els.canvas.addEventListener('keydown', orpHandleKeydown);
    els.canvas.addEventListener('keyup', orpHandleKeyup);
    els.canvas.addEventListener('focus', orpHandleFocus);
    els.canvas.addEventListener('blur', orpHandleBlur);
    els.newGame.addEventListener('click', orpNewGame);
    els.continueButton.addEventListener('click', orpContinue);
    els.focusButton.addEventListener('click', orpFocusCanvas);
    els.resume.addEventListener('click', orpResume);
    els.backTty.addEventListener('click', orpBackToTty);
    els.endButton.addEventListener('click', orpBackToTitle);
    document.addEventListener('visibilitychange', orpHandleVisibility);
    document.addEventListener('fullscreenchange', orpFitFullscreen);
    window.addEventListener('resize', orpFitFullscreen);
    window.addEventListener('storage', orpHandleStorage);
    window.addEventListener('pagehide', orpHandlePageHide);
  }

  // ── Start-up ──────────────────────────────────────────────────────────────

  function orpFindElements() {
    return {
      stage: document.getElementById('orp-stage'),
      canvas: document.getElementById('orp-canvas'),
      msg: document.getElementById('orp-msg'),
      msgTitle: document.getElementById('orp-msg-title'),
      msgText: document.getElementById('orp-msg-text'),
      start: document.getElementById('orp-start'),
      newGame: document.getElementById('orp-new'),
      continueButton: document.getElementById('orp-continue'),
      focus: document.getElementById('orp-focus'),
      focusButton: document.getElementById('orp-focus-button'),
      paused: document.getElementById('orp-paused'),
      manCount: document.getElementById('orp-man-count'),
      manList: document.getElementById('orp-man-list'),
      resume: document.getElementById('orp-resume'),
      backTty: document.getElementById('orp-back-tty'),
      end: document.getElementById('orp-end'),
      endStats: document.getElementById('orp-end-stats'),
      endButton: document.getElementById('orp-end-button'),
      warning: document.getElementById('orp-warning'),
      toast: document.getElementById('orp-toast')
    };
  }

  // Finds the elements, rasterises the art, binds the controls once and
  // shows the title screen (Continue when a save exists).
  function orpInit() {
    var rt = orpRuntime;
    if (rt.els) return;
    rt.els = orpFindElements();
    rt.ctx = rt.els.canvas.getContext('2d');
    rt.art = orpBuildArt();
    orpDrawGuide(rt.art);
    orpBindEvents();
    rt.hasSave = !!orpLoadSave();
    rt.focused = document.activeElement === rt.els.canvas;
    orpShow('title');
  }

  // Node (tests): export only, no init, no listeners and no frames.
  // Browser: init once the markup is there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      orpRuntime: orpRuntime,
      orpInit: orpInit,
      orpRender: orpRender,
      orpRooms: ORP_ROOMS,
      orpRoomCache: orpRoomCache,
      orpAreas: ORP_AREAS,
      orpKinds: ORP_KINDS,
      orpSpawns: ORP_SPAWNS,
      orpMan: ORP_MAN,
      orpSprites: ORP_SPRITES,
      orpPalette: ORP_PALETTE,
      orpFont: ORP_FONT,
      orpParseRoom: orpParseRoom,
      orpRoom: orpRoom,
      orpTile: orpTile,
      orpSolid: orpSolid,
      orpKnownIds: orpKnownIds,
      orpCompletion: orpCompletion,
      orpFreshProgress: orpFreshProgress,
      orpXpNeeded: orpXpNeeded,
      orpNewSim: orpNewSim,
      orpStep: orpStep,
      orpMove: orpMove,
      orpHeroSprite: orpHeroSprite,
      orpTileSprite: orpTileSprite,
      orpDecor: orpDecor,
      orpParseSave: orpParseSave,
      orpSerialize: orpSerialize,
      orpWins: orpWins,
      orpHudLayout: orpHudLayout,
      orpBetween: orpBetween,
      orpFormatTime: orpFormatTime,
      orpKeyAction: orpKeyAction,
      orpFullscreenSize: orpFullscreenSize,
      orpBuildAtlas: orpBuildAtlas,
      orpText: orpText,
      orpConstants: {
        W: ORP_W, H: ORP_H, TILE: ORP_TILE, STEP: ORP_STEP, MAX_FRAME_MS: ORP_MAX_FRAME_MS,
        HERO_W: ORP_HERO_W, HERO_H: ORP_HERO_H, RUN: ORP_RUN, ACCEL_GROUND: ORP_ACCEL_GROUND, ACCEL_AIR: ORP_ACCEL_AIR,
        GRAVITY: ORP_GRAVITY, MAX_FALL: ORP_MAX_FALL, JUMP_SPEED: ORP_JUMP_SPEED, JUMP_CUT: ORP_JUMP_CUT,
        COYOTE: ORP_COYOTE, BUFFER: ORP_BUFFER, INVULN: ORP_INVULN, START_RSS: ORP_START_RSS, START_CPU: ORP_START_CPU,
        CPU_REGEN: ORP_CPU_REGEN, START_NICE: ORP_START_NICE, SIGNAL_SPEED: ORP_SIGNAL_SPEED, SIGNAL_RANGE: ORP_SIGNAL_RANGE,
        SIGNAL_COST: ORP_SIGNAL_COST, SIGNAL_COOLDOWN: ORP_SIGNAL_COOLDOWN, DASH_TIME: ORP_DASH_TIME,
        DASH_SPEED: ORP_DASH_SPEED, DASH_COST: ORP_DASH_COST, DASH_COOLDOWN: ORP_DASH_COOLDOWN,
        CRUMBLE_DELAY: ORP_CRUMBLE_DELAY, CRUMBLE_BACK: ORP_CRUMBLE_BACK, SWEEP_EVERY: ORP_SWEEP_EVERY,
        SWEEP_GONE: ORP_SWEEP_GONE, ZOMBIE_RANGE: ORP_ZOMBIE_RANGE, ZOMBIE_MAX: ORP_ZOMBIE_MAX,
        TURRET_EVERY: ORP_TURRET_EVERY, DEATH_TIME: ORP_DEATH_TIME, SWEEP_WARN: ORP_SWEEP_WARN,
        BOSS_HP: ORP_BOSS_HP, BOSS_WAKE: ORP_BOSS_WAKE, BOSS_INTRO: ORP_BOSS_INTRO, BOSS_GONE: ORP_BOSS_GONE,
        BOSS_CORE: ORP_BOSS_CORE, BOSS_HIT_EVERY: ORP_BOSS_HIT_EVERY, BOSS_RAGE: ORP_BOSS_RAGE,
        BOSS_PHASES: ORP_BOSS_PHASES, END_DELAY: ORP_END_DELAY, MAN_XP: ORP_MAN_XP, LEVEL_CPU: ORP_LEVEL_CPU,
        DROP_EVERY: ORP_DROP_EVERY, DAEMON_SPAWN: ORP_DAEMON_SPAWN, FILE_SPACING: ORP_FILE_SPACING
      }
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', orpInit);
  } else {
    orpInit();
  }
})();
