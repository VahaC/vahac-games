// ── render-map: the automap: the cells seen so far, doors by badge, racks by state, the lift, the player arrow ──
// Owns CDA_MAP_COLOURS, cdaRenderMap and its helpers (cdaMapShown,
// cdaNearSeenFloor).  Uses core, textures
// and render-view (cdaFillRect); reads sim.map (kind, seen), sim.doors,
// sim.racks, sim.liftOpen and sim.player.
//
// cdaRenderMap(view, sim, pixels) draws over the frame already in pixels
// (call it after cdaRender, or on any frame): the frame is darkened to a quarter,
// then the map is drawn centred, every cell a square of the largest size
// from 2 to 8 pixels that fits the map in 300x168.  The cells drawn are
// those with sim.map.seen set, and every other non-floor cell (a wall, a
// secret, a door, a rack, the lift) with a seen floor cell among its eight
// neighbours: the sight rays mark only the cells they reach, which would
// leave holes in the walls around a room the player has seen (cdaMapShown;
// the sim's seen[] is left as it is).  Floor (and an opened secret) shows as
// dark floor,
// walls (a closed secret looks like a wall) light, a door as floor with a bar
// along its axis in its badge's colour, a rack by its state (infected,
// rebooting, clean), the lift locked or open.  The player is an arrow at its
// position, pointing where it faces.  Colours are palette letters
// (CDA_MAP_COLOURS).

var CDA_MAP_COLOURS = {
  floor: 'A', wall: 'N', plain: 'n', blue: 'B', yellow: 'y', red: 'r', infected: 'x', rebooting: 'o', clean: 'G',
  locked: 'P', open: 'c', player: 'w'
};

// The colour of the solid cell i (not a door) on the automap.
function cdaMapColour(view, sim, i) {
  var col = view.mapCol;
  var k = sim.map.kind[i];
  if (k === 'lift') return sim.liftOpen ? col.open : col.locked;
  if (k !== 'rack') return col.wall;
  var r = 0;
  while (sim.racks[r].cell !== i) r++;
  return col[sim.racks[r].state];
}

// Whether a seen floor cell is among the eight neighbours of cell (x, y).
function cdaNearSeenFloor(m, x, y) {
  for (var j = Math.max(0, y - 1); j <= Math.min(m.h - 1, y + 1); j++) {
    for (var i = Math.max(0, x - 1); i <= Math.min(m.w - 1, x + 1); i++) {
      var n = j * m.w + i;
      if (m.seen[n] && m.kind[n] === 'floor') return true;
    }
  }
  return false;
}

// Whether the automap draws cell (x, y) (see the header).
function cdaMapShown(m, x, y) {
  var i = y * m.w + x;
  return m.seen[i] === 1 || (m.kind[i] !== 'floor' && cdaNearSeenFloor(m, x, y));
}

function cdaRenderMap(view, sim, pixels) {
  var T = view.tex;
  if (!view.mapCol) {
    view.mapCol = {};
    var names = Object.keys(CDA_MAP_COLOURS);
    for (var n = 0; n < names.length; n++) view.mapCol[names[n]] = T.pal[T.index[CDA_MAP_COLOURS[names[n]]]];
  }
  var col = view.mapCol;
  var m = sim.map;
  var i;
  for (i = 0; i < pixels.length; i++) pixels[i] = ((pixels[i] >>> 2) & 0x3f3f3f) | 0xff000000;
  var cs = Math.max(2, Math.min(8, Math.floor(300 / m.w), Math.floor(168 / m.h)));
  var ox = (CDA_W - m.w * cs) >> 1;
  var oy = (CDA_H - m.h * cs) >> 1;
  for (var y = 0; y < m.h; y++) {
    for (var x = 0; x < m.w; x++) {
      i = y * m.w + x;
      if (!cdaMapShown(m, x, y)) continue;
      var k = m.kind[i];
      var sx = ox + x * cs;
      var sy = oy + y * cs;
      if (k === 'floor' || k === 'door') {
        cdaFillRect(pixels, sx, sy, cs, cs, col.floor);
      } else {
        cdaFillRect(pixels, sx, sy, cs, cs, cdaMapColour(view, sim, i));
      }
      if (k !== 'door') continue;
      var d = sim.doors[m.door[i]];
      var bar = Math.max(1, cs >> 2);
      var mid = (cs - bar) >> 1;
      if (d.axis === 'x') cdaFillRect(pixels, sx, sy + mid, cs, bar, col[d.kind]);
      else cdaFillRect(pixels, sx + mid, sy, bar, cs, col[d.kind]);
    }
  }
  cdaDrawArrow(pixels, ox + sim.player.x * cs, oy + sim.player.y * cs, sim.player.angle, Math.max(3, cs), col.player);
}

// A filled arrow (a triangle) of radius r at (cx, cy) pointing along angle a:
// a pixel is in it when it is on the inner side of all three edges (the
// corners at a, a + 2.5 and a - 2.5 always wind the same way).
function cdaDrawArrow(pixels, cx, cy, a, r, colour) {
  var ax = cx + Math.cos(a) * r;
  var ay = cy + Math.sin(a) * r;
  var bx = cx + Math.cos(a + 2.5) * r;
  var by = cy + Math.sin(a + 2.5) * r;
  var qx = cx + Math.cos(a - 2.5) * r;
  var qy = cy + Math.sin(a - 2.5) * r;
  for (var y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (var x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      var px = x + 0.5;
      var py = y + 0.5;
      var e0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      var e1 = (qx - bx) * (py - by) - (qy - by) * (px - bx);
      var e2 = (ax - qx) * (py - qy) - (ay - qy) * (px - qx);
      if (e0 >= 0 && e1 >= 0 && e2 >= 0) pixels[y * CDA_W + x] = colour;
    }
  }
}

CDA_API.CDA_MAP_COLOURS = CDA_MAP_COLOURS;
CDA_API.cdaRenderMap = cdaRenderMap;
CDA_API.cdaMapShown = cdaMapShown;
