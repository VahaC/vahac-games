// ── render-walls: the light table, the cells of a frame, one ray per column (walls, doors, jambs), floor and ceiling ──
// Owns CDA_PROJ, CDA_HORIZON, CDA_LIGHT_STEP, CDA_LIGHT_BUCKETS,
// CDA_AMBIENT, CDA_AMBIENT_RANGE, CDA_FLASH_POWER, CDA_TEX_FLIP, cdaLight,
// cdaLightTable, cdaViewCells, cdaCastWalls and cdaDrawFlats.  Uses core,
// map (CDA_TEX_FRAMES, CDA_TEX_JAMB, CDA_TEX_RACK_CLEAN) and textures; the
// view they fill is made by render-view (cdaNewView).
//
// Projection: one ray per column through the column's centre; a cell one
// unit away is CDA_PROJ pixels wide and as many high (square pixels), the
// camera at half the wall height, the horizon on the middle row.  Distances
// are perpendicular to the view plane (no fisheye).  Walls and doors are one
// cell high; texture v runs from the top of the wall.
//
// Light (cdaLight): a zone of light L (0..3) gives CDA_AMBIENT[L] near the
// camera, halved at CDA_AMBIENT_RANGE[L] cells (1 / (1 + (d / range)^2));
// the flashlight adds CDA_FLASH_POWER * (1 - (d / flashlight)^2) up to its
// range, over what is left (a + f * (1 - a)); the sum, 0..1, is rounded to a
// level of CDA_SHADES.  view.lightTab holds the level per zone light and per
// 1 / CDA_LIGHT_STEP cell of distance, rebuilt when the flashlight changes.
// A wall face is lit by the zone of the cell the ray came from, a floor or
// ceiling pixel by its own cell's zone; one wall axis (faces seen across y)
// is two levels darker.  Glowing texels keep their tier's minimum (textures).
//
// The cells of a frame (cdaViewCells) are copied out of the sim into the
// view's grids, 64 cells a row whatever the map's width: per cell the kind
// (0 open, 1 solid, 2 a door across x, 3 a door across y), the texture (the
// animated ones flip every CDA_TEX_FLIP steps), a second texture and the row
// it starts at (a rack being rebooted fills with wall-rack-clean from the
// bottom up as its progress grows), the zone, and a door's interpolated
// openness.  Cells off the map are solid.
//
// Doors (as the sim models them): a thin wall through the middle of the
// cell along its axis, covering the part of that line from `open` to 1 (the
// slab slides toward the cell's high side and its texture slides with it).
// The camera's own cell is tested too (the ray starts inside a door cell
// while the player walks through it).  A wall face the ray reaches from inside a door cell is a jamb (door-jamb).

var CDA_PROJ = (CDA_W / 2) / Math.tan(CDA_FOV / 2);
var CDA_HORIZON = CDA_H / 2;
var CDA_LIGHT_STEP = 8;
var CDA_LIGHT_BUCKETS = CDA_LIGHT_STEP * 128;
var CDA_AMBIENT = [0, 0.5, 0.78, 1];
var CDA_AMBIENT_RANGE = [1, 5, 8, 12];
var CDA_FLASH_POWER = 0.9;
var CDA_TEX_FLIP = 24;

// The light level (0..CDA_SHADES - 1) at distance d in a zone of light L
// with a flashlight reaching f cells.
function cdaLight(L, d, f) {
  var r = d / CDA_AMBIENT_RANGE[L];
  var a = CDA_AMBIENT[L] / (1 + r * r);
  var fl = CDA_FLASH_POWER * Math.max(0, 1 - d * d / (f * f));
  return Math.round((a + fl * (1 - a)) * (CDA_SHADES - 1));
}

function cdaLightTable(view, flashlight) {
  view.flashFor = flashlight;
  for (var L = 0; L < 4; L++) {
    for (var b = 0; b < CDA_LIGHT_BUCKETS; b++) view.lightTab[L * CDA_LIGHT_BUCKETS + b] = cdaLight(L, (b + 0.5) / CDA_LIGHT_STEP, flashlight);
  }
}

// The light level at distance d in zone z of the current frame.
function cdaLevelAt(view, z, d) {
  return view.lightTab[view.zLight[z] * CDA_LIGHT_BUCKETS + Math.min(CDA_LIGHT_BUCKETS - 1, (d * CDA_LIGHT_STEP) | 0)];
}

// Copies the cells, zones and doors of sim into the view's grids (see the header).
function cdaViewCells(view, sim, alpha) {
  var T = view.tex;
  var m = sim.map;
  var flip = (sim.tick / CDA_TEX_FLIP) & 1;
  for (var y = 0; y < 64; y++) {
    for (var x = 0; x < 64; x++) {
      var j = y * 64 + x;
      view.cellSplit[j] = 32;
      view.cellZone[j] = 0;
      view.cellKind[j] = 1;
      view.cellTex[j] = view.wallDefault;
      view.cellAlt[j] = view.wallDefault;
      if (x >= m.w || y >= m.h) continue;
      var i = y * m.w + x;
      var k = m.kind[i];
      view.cellZone[j] = m.zone[i];
      view.cellKind[j] = k === 'floor' ? 0 : 1;
      if (k === 'floor') continue;
      var id = T.id[m.tex[i]];
      view.cellTex[j] = flip ? view.anim[id] : id;
      view.cellAlt[j] = view.cellTex[j];
    }
  }
  for (var d = 0; d < sim.doors.length; d++) {
    var dr = sim.doors[d];
    var c = dr.y * 64 + dr.x;
    view.cellKind[c] = dr.axis === 'x' ? 2 : 3;
    view.cellOpen[c] = dr.popen + (dr.open - dr.popen) * alpha;
  }
  for (var r = 0; r < sim.racks.length; r++) {
    var rk = sim.racks[r];
    if (rk.state !== 'rebooting') continue;
    var rc = Math.floor(rk.y) * 64 + Math.floor(rk.x);
    view.cellAlt[rc] = view.cleanId;
    view.cellSplit[rc] = Math.round(32 * (1 - rk.progress));
  }
  view.zones = sim.zones.length;
  for (var z = 0; z < sim.zones.length; z++) {
    view.zFloor[z] = T.off[T.id[sim.zones[z].floor]];
    view.zCeil[z] = T.off[T.id[sim.zones[z].ceil]];
    view.zLight[z] = sim.zones[z].light;
  }
}

// Casts one ray per column from the camera in the view, draws the walls and
// doors into pixels and fills zbuf, wallTop and wallBot.
function cdaCastWalls(view, pixels) {
  var T = view.tex;
  var atlas = T.atlas;
  var shade = T.shade;
  var kind = view.cellKind;
  var px = view.cx;
  var py = view.cy;
  var startX = Math.floor(px);
  var startY = Math.floor(py);
  for (var x = 0; x < CDA_W; x++) {
    var rdx = view.dirX + view.plX * view.camX[x];
    var rdy = view.dirY + view.plY * view.camX[x];
    var ddx = 1 / Math.max(Math.abs(rdx), 1e-9);
    var ddy = 1 / Math.max(Math.abs(rdy), 1e-9);
    var stepX = rdx < 0 ? -1 : 1;
    var stepY = rdy < 0 ? -1 : 1;
    var mx = startX;
    var my = startY;
    var sdx = (rdx < 0 ? px - mx : mx + 1 - px) * ddx;
    var sdy = (rdy < 0 ? py - my : my + 1 - py) * ddy;
    var prev = 0;
    var side = 0;
    var perp = 0;
    var u = 0;
    var cell = my * 64 + mx;
    var tex = 0;
    // each cell from the camera's own on: a door is tested between where
    // the ray enters the cell (perp) and where it leaves it, so the slab of
    // a door the camera stands in (walking through it) is drawn too
    for (;;) {
      var k = kind[cell];
      if (k >= 2) {
        // the door's middle line: y = my + 0.5 (kind 2) or x = mx + 0.5 (kind 3)
        var t = k === 2 ? (my + 0.5 - py) / rdy : (mx + 0.5 - px) / rdx;
        var f = k === 2 ? px + t * rdx - mx : py + t * rdy - my;
        if (t >= perp && t < Math.min(sdx, sdy) && f >= view.cellOpen[cell]) {
          perp = t;
          u = f - view.cellOpen[cell];
          side = 3 - k;
          tex = view.cellTex[cell];
          break;
        }
      }
      prev = cell;
      if (sdx < sdy) {
        perp = sdx;
        sdx += ddx;
        mx += stepX;
        side = 0;
      } else {
        perp = sdy;
        sdy += ddy;
        my += stepY;
        side = 1;
      }
      cell = my * 64 + mx;
      if (kind[cell] === 1) {
        var hit = side === 0 ? py + perp * rdy : px + perp * rdx;
        u = hit - Math.floor(hit);
        if (side === 0 ? rdx < 0 : rdy > 0) u = 1 - u;
        tex = kind[prev] >= 2 ? view.jambId : view.cellTex[cell];
        break;
      }
    }
    var lineH = CDA_PROJ / perp;
    var top = CDA_HORIZON - lineH / 2;
    var y0 = Math.max(0, Math.ceil(top - 0.5));
    var y1 = Math.min(CDA_H, Math.ceil(top + lineH - 0.5));
    view.zbuf[x] = perp;
    view.wallTop[x] = y0;
    view.wallBot[x] = y1;
    var zone = view.cellZone[kind[cell] === 1 ? prev : cell];
    var lvl = Math.max(0, cdaLevelAt(view, zone, perp) - side * 2) * 256;
    var col = ((u * 32) | 0) & 31;
    var baseA = T.off[tex] + col * 32;
    var baseB = T.off[view.cellAlt[cell]] + col * 32;
    var split = view.cellSplit[cell];
    var vStep = (32 * 65536 / lineH) | 0;
    var v = ((y0 + 0.5 - top) * 32 * 65536 / lineH) | 0;
    for (var y = y0, o = y0 * CDA_W + x; y < y1; y++, o += CDA_W, v += vStep) {
      var ty = (v >> 16) & 31;
      pixels[o] = shade[lvl + atlas[(ty < split ? baseA : baseB) + ty]];
    }
  }
}

// Floor and ceiling, one row (and its mirror) at a time, where the walls
// left them visible.  Texture coordinates run in 16.16 fixed point.
function cdaDrawFlats(view, pixels) {
  var T = view.tex;
  var atlas = T.atlas;
  var shade = T.shade;
  var zone = view.cellZone;
  var zFloor = view.zFloor;
  var zCeil = view.zCeil;
  var rowLvl = view.rowLvl;
  var top = view.wallTop;
  var bot = view.wallBot;
  var rx0 = view.dirX - view.plX;
  var ry0 = view.dirY - view.plY;
  var rx1 = view.dirX + view.plX;
  var ry1 = view.dirY + view.plY;
  for (var y = CDA_HORIZON; y < CDA_H; y++) {
    var yc = CDA_H - 1 - y;
    var d = view.rowDist[y - CDA_HORIZON];
    for (var z = 0; z < view.zones; z++) rowLvl[z] = cdaLevelAt(view, z, d) * 256;
    var sx = d * (rx1 - rx0) / CDA_W;
    var sy = d * (ry1 - ry0) / CDA_W;
    var fx = ((view.cx + d * rx0 + sx * 0.5) * 65536) | 0;
    var fy = ((view.cy + d * ry0 + sy * 0.5) * 65536) | 0;
    var stx = (sx * 65536) | 0;
    var sty = (sy * 65536) | 0;
    var of = y * CDA_W;
    var oc = yc * CDA_W;
    for (var x = 0; x < CDA_W; x++, fx += stx, fy += sty) {
      var zz = zone[(((fy >> 16) & 63) << 6) | ((fx >> 16) & 63)];
      var t = (((fx >> 11) & 31) << 5) | ((fy >> 11) & 31);
      if (y >= bot[x]) pixels[of + x] = shade[rowLvl[zz] + atlas[zFloor[zz] + t]];
      if (yc < top[x]) pixels[oc + x] = shade[rowLvl[zz] + atlas[zCeil[zz] + t]];
    }
  }
}

CDA_API.CDA_PROJ = CDA_PROJ;
CDA_API.CDA_HORIZON = CDA_HORIZON;
CDA_API.CDA_AMBIENT = CDA_AMBIENT;
CDA_API.CDA_AMBIENT_RANGE = CDA_AMBIENT_RANGE;
CDA_API.CDA_FLASH_POWER = CDA_FLASH_POWER;
CDA_API.CDA_TEX_FLIP = CDA_TEX_FLIP;
CDA_API.cdaLight = cdaLight;
CDA_API.cdaViewCells = cdaViewCells;
