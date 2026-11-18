// ── levels-a: levels 1-3 (Loading Dock, Meet-Me Room, Cold Aisle A) ──
// Owns CDA_LEVEL_DOCK, CDA_LEVEL_MEETME and CDA_LEVEL_AISLE: raw level
// objects in the format of the map part's header (legend, zones, kit).
// Uses nothing at load time; levels gathers them into CDA_LEVELS.

// Level 1.  The start is quiet on purpose: no enemy sees the dock.  The probe
// waits on the security desk next door, the first crawler stands alone at the
// far end of the corridor, and the lift is in sight from the corridor long
// before it opens.  Loops: corridor - lobby - server room - corridor.
var CDA_LEVEL_DOCK = {
  name: 'Loading Dock',
  briefing: 'Floor 1, night shift: the floor scrubbers started acting up around ten. Take the tone probe from the security desk, reboot the infected rack in the server room and take the lift down.',
  facing: 'N',
  floor: 'floor-tile', ceil: 'ceil-panel', light: 3,
  zones: {
    1: { floor: 'floor-grate', ceil: 'ceil-light', light: 3 },
    2: { floor: 'floor-tile', ceil: 'ceil-tray', light: 1 },
    3: { floor: 'floor-concrete', ceil: 'ceil-pipes', light: 2 }
  },
  kit: { tools: ['driver'], ammo: { cell: 0, coil: 0 } },
  map: [
    '##################L#####',
    '#s............#..i.....#',
    '#..HHHHHHHHH..#........#',
    '#..[]|[]X|[]..#^......^#',
    '#...........c.+........#',
    '#..]|[]|[]|[..#........#',
    '#..HHHHHHHHH..#.......f#',
    '#*..........s.#n.......#',
    '#...u.....O...#........#',
    '#######+#######...##...#',
    '#.........e............#',
    '#.s....................#',
    '####################+###',
    '#....x.......u#........#',
    '#..........x..#.TT...c.#',
    '#.........^...+.nP.....#',
    '#.............#........#',
    '#x............#e......i#',
    '#...I.....I...##########',
    '#.............#x.x..x.x#',
    '#............^+.....c..#',
    '#.@...x.x.....#x..f...*#',
    '#^....xx......#xx...xxx#',
    '########################'
  ],
  zoneMap: [
    '........................',
    '.2222222222222..........',
    '........................',
    '........................',
    '.1111111111111..........',
    '........................',
    '........................',
    '.2222222222222..........',
    '.2222222222222..........',
    '........................',
    '........................',
    '........................',
    '........................',
    '.3333333333333.22222222.',
    '.3333333333333.22222222.',
    '.3333333333333.22222222.',
    '.3333333333333.22222222.',
    '.3333333333333.22222222.',
    '.3333333333333..........',
    '.3333333333333.33333333.',
    '.3333333333333.33333333.',
    '.3333333333333.33333333.',
    '.3333333333333.33333333.',
    '........................'
  ]
};

// Level 2.  A drone hovers at the far end of the stair corridor, in sight of
// the start (13 cells): the first one, alone, with room to move.  The blue
// door to the lift room is passed on the way to the carrier office where the
// blue badge is.  The secret wall in the corridor hides a closet (a patch,
// a medkit).  Loop: corridor - meet-me room - fibre room - corridor.
var CDA_LEVEL_MEETME = {
  name: 'Meet-Me Room',
  briefing: 'Floor 2, where the carriers hand over their fibre. Inventory drones have been seen in the cages; the lift room is behind a blue door and the carrier office keeps a blue badge.',
  facing: 'N',
  floor: 'floor-tile', ceil: 'ceil-panel', light: 3,
  zones: {
    1: { floor: 'floor-grate', ceil: 'ceil-light', light: 3 },
    2: { floor: 'floor-tile', ceil: 'ceil-tray', light: 1 },
    3: { floor: 'floor-tile', ceil: 'ceil-tray', light: 2 },
    4: { floor: 'floor-concrete', ceil: 'ceil-panel', light: 1 },
    5: { floor: 'floor-concrete', ceil: 'ceil-light', light: 3 },
    6: { floor: 'floor-plate', ceil: 'ceil-pipes', light: 3 }
  },
  kit: { tools: ['driver', 'probe'], ammo: { cell: 30, coil: 0 } },
  map: [
    '############################',
    '#...#..............%...T..*#',
    '#...#.HHHHHHHHHHH..%.......#',
    '#...#.[]|[]|[]|[]..%.....B.#',
    '#...#..............%.d.....#',
    '#...#.]|[]X[]|[]|..%n......#',
    '#...#.HHHHHHHHHHH..%%%%+%%%#',
    '#...#.s....................#',
    '#...#..................c...#',
    '#...+.....u.....d.....i....#',
    '#.d.#......................#',
    '#...#..x....s.............f#',
    '#...######+###########b#####',
    '#...#*.m#.......#..........#',
    '#...$..c#.......#.......s..#',
    '#.c.#...#.......#..........#',
    '#...#####.......#..x.......#',
    '#...#.s.........#..........#',
    '#...+..HHHHHHH..#.....^....L',
    '#...#..[]|X|[]..#..........#',
    '#^..#...........#..........#',
    '#...#.......c...#.....s...f#',
    '#e..#.........d.#..........#',
    '#.@.#.....s.....#.u..d..c..#',
    '#...#.x.....xx..#.........i#',
    '############################'
  ],
  zoneMap: [
    '............................',
    '.555.22222222222222.........',
    '.555........................',
    '.555........................',
    '.555.11111111111111.........',
    '.555........................',
    '.555........................',
    '.555.22222222222222.........',
    '.555........................',
    '.555........................',
    '.555........................',
    '.555........................',
    '.555........................',
    '.555.444.3333333.6666666666.',
    '.555.444.3333333.6666666666.',
    '.555.444.3333333.6666666666.',
    '.555.....3333333.6666666666.',
    '.555.33333333333.6666666666.',
    '.555.33333333333.6666666666.',
    '.555.33333333333.6666666666.',
    '.555.33333333333.6666666666.',
    '.555.33333333333.6666666666.',
    '.555.33333333333.6666666666.',
    '.555.33333333333.6666666666.',
    '.555.33333333333.6666666666.',
    '............................'
  ]
};

// Level 3.  One long data hall: four rows of racks, cold aisles lit, hot
// aisles dim.  The lift is in sight from the start, at the end of the middle
// cold aisle, and opens last.  The degausser lies in the storage cage: the
// first shot there wakes the crawlers hidden behind the shelving (the
// ambush).  A secret wall behind the start hides a closet (a patch, a vest).
var CDA_LEVEL_AISLE = {
  name: 'Cold Aisle A',
  briefing: 'Floor 3 is one long data hall. Two racks in hall A are infected; there is a degausser in the storage cage, and something has been moving behind the shelves.',
  facing: 'E',
  floor: 'floor-tile', ceil: 'ceil-panel', light: 3,
  zones: {
    1: { floor: 'floor-grate', ceil: 'ceil-light', light: 3 },
    2: { floor: 'floor-tile', ceil: 'ceil-tray', light: 1 },
    3: { floor: 'floor-concrete', ceil: 'ceil-pipes', light: 2 },
    4: { floor: 'floor-concrete', ceil: 'ceil-panel', light: 1 }
  },
  kit: { tools: ['driver', 'probe'], ammo: { cell: 30, coil: 0 } },
  map: [
    '##################################',
    '#*.v.c#....n..............^......#',
    '#.....#..HHHHHHHHHHHHHHHHHHHHHH..#',
    '#x...x#..[]|[]|[]|[]|[]|[X|[]|[..#',
    '#.....#.........c............s..d#',
    '#xx.xx#..]|[]|[]|[]|[.|[]|[]|[]..#',
    '###$###..HHHHHHHHHHHH.HHHHHHHHH..#',
    '#n...e+....................s.....#',
    '#.....#..HHHHHHHHHHHHHHHHHHHHHH..#',
    '#....^#..[]|[]|[]|[]|[]|[]|[]|[..#',
    '#...@............d...............L',
    '#....^#..]|[]|[]|[]|[]|[]|[]|[]..#',
    '#.....#..HHHHHHHHHHHHHHHHHHHHHH..#',
    '#n...i#.........................e#',
    '###+###..HHHHHHHHHHHH.HHHHHHHHH..#',
    '#T....#..[]|X]|[]|[]|.]|[]|[]|[..#',
    '#.n...#....c.....s.........d.....#',
    '#....c#..]|[]|[]|[]|[]|[]|[]|[]..#',
    '#u....#..HHHHHHHHHHHHHHHHHHHHHH..#',
    '#f..x.#..........................#',
    '##########+###############+#######',
    '#s.......^......s#.............O.#',
    '#.%%%%%%.%%%%%%..#.u...^....c....#',
    '#..s.............#...........f.s.#',
    '#.%%%%%%.%%%%%%..+...............#',
    '#.G.....c....x...#.x.x....m......#',
    '#x.s........x..s.#xxx........*..i#',
    '##################################'
  ],
  zoneMap: [
    '..................................',
    '.44444.22222222222222222222222222.',
    '.44444............................',
    '.44444............................',
    '.44444.11111111111111111111111111.',
    '.44444............................',
    '..................................',
    '.......22222222222222222222222222.',
    '..................................',
    '..................................',
    '.......11111111111111111111111111.',
    '..................................',
    '..................................',
    '.......22222222222222222222222222.',
    '..................................',
    '..................................',
    '.......11111111111111111111111111.',
    '..................................',
    '..................................',
    '.......22222222222222222222222222.',
    '..................................',
    '.33333333333333333333333333333333.',
    '.33333333333333333333333333333333.',
    '.33333333333333333333333333333333.',
    '.33333333333333333333333333333333.',
    '.33333333333333333333333333333333.',
    '.33333333333333333333333333333333.',
    '..................................'
  ]
};

CDA_API.CDA_LEVEL_DOCK = CDA_LEVEL_DOCK;
CDA_API.CDA_LEVEL_MEETME = CDA_LEVEL_MEETME;
CDA_API.CDA_LEVEL_AISLE = CDA_LEVEL_AISLE;
