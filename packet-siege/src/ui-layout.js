// ── ui: the frame's geometry: where the HUD, the field, the cards and the status line sit ──
// Owns the one-screen layout as numbers: pksPageLayout (the frame on the
// page, as wide as the field), pksFitLayout (the frame filling a box: the
// fullscreen and maximised modes, and a page too short for the page
// layout), pksFrameLayout (which of the two), pksFitScale and pksPageScale.
// Pure: no DOM, no clock; ui-frame puts the boxes on the elements.  Uses
// core (PKS_W, PKS_H, PKS_FIELD_X, PKS_FIELD_Y), levels (pksSlots,
// PKS_LEVELS) and render (PKS_BAR_X).
//
// A layout: { fit, side, scale, w, h, hud, field, tray, cards, status, rules,
// cols, cardW, lines }.  w x h is the frame; hud the HUD's height (one row,
// or two on a narrow frame: the level's line over the buttons); field, tray,
// cards and status are boxes { x, y, w, h } in the frame's pixels: the
// canvas, the band behind the cards, the card grid (cols columns of cardW
// px) and the status line (lines of text high); rules is the row of rule
// badges in the field's own pixels: over the canvas's top strip from just
// right of the trickle's pip to just left of the surge bar.  The tray holds room for
// the most cards a level has (pksSlots(150) and Decommission: 11), so the
// frame keeps its size from level to level.  Without side the tray is under
// the field across the frame; with side (a wide, short frame) the cards stand
// in columns right of the field and the status line runs under the field.

var PKS_HUD_ONE = 52;         // one row: 44 px buttons, 3 px padding, 1 px border
var PKS_HUD_TWO = 78;         // two rows: a 24 px line of text over the buttons, 2 px apart
var PKS_HUD_WIDE = 560;       // the narrowest frame with a one-row HUD
var PKS_GAP = 3;              // the tray's padding and the gap between cards
var PKS_CARD_H = 56;
var PKS_CARD_MIN = 67;        // 10 characters of 10 px monospace, the padding and the border
var PKS_CARD_MAX = 112;
var PKS_LINE = 16;            // a status line of text
var PKS_STATUS_WIDE = 420;    // the narrowest status line that holds every text in two lines
var PKS_TRAY_CARDS = pksSlots(PKS_LEVELS) + 1;
var PKS_WHOLE_SHARE = 0.8;    // a whole multiple is used when it is at least this share of the fit
var PKS_PAGE_MOST = 3;        // the page never shows the field above 3x (960x540)
var PKS_SIDE_GAIN = 1.1;      // the side tray only when its field is 10 % bigger
var PKS_RULES_BIG = 36;       // a rule row at least this high shows the badges' names
var PKS_RULES_X = 30;         // the rule row's left edge on the canvas: clear of the trickle's "+25" pip

function pksBox(x, y, w, h) {
  return { x: x, y: y, w: w, h: h };
}

// The rule badges' row in a field of `fieldW` px (see the header).
function pksRulesBox(fieldW) {
  var s = fieldW / PKS_W;
  return pksBox(Math.round(PKS_RULES_X * s), 0, Math.floor((PKS_BAR_X - 2 - PKS_RULES_X) * s), Math.floor(PKS_FIELD_Y * s));
}

function pksHudHeight(width) {
  return width >= PKS_HUD_WIDE ? PKS_HUD_ONE : PKS_HUD_TWO;
}

function pksStatusLines(width) {
  return width >= PKS_STATUS_WIDE ? 2 : 3;
}

// The card grid for `count` cards in `width` px (padding included): as
// few rows as cards of PKS_CARD_MIN allow, the cards spread evenly over
// them, each at most PKS_CARD_MAX wide.
function pksCardGrid(width, count) {
  var inner = width - 2 * PKS_GAP;
  var most = Math.max(1, Math.min(count, Math.floor((inner + PKS_GAP) / (PKS_CARD_MIN + PKS_GAP))));
  var rows = Math.ceil(count / most);
  var cols = Math.ceil(count / rows);
  return {
    cols: cols, rows: rows,
    cardW: Math.min(PKS_CARD_MAX, Math.floor((inner - (cols - 1) * PKS_GAP) / cols)),
    h: rows * PKS_CARD_H + (rows - 1) * PKS_GAP
  };
}

// The field's scale in a w x h box: the largest whole multiple when it is
// at least PKS_WHOLE_SHARE of the fit (every game pixel the same size),
// else the fit itself.
function pksFitScale(w, h) {
  var fit = Math.max(0.1, Math.min(w / PKS_W, h / PKS_H));
  var whole = Math.floor(fit);
  return whole >= 1 && whole >= fit * PKS_WHOLE_SHARE ? whole : fit;
}

// The field's scale on the page, `width` px available: pksFitScale by the
// width alone, never above PKS_PAGE_MOST.  So 960 px or more give 3x, 958
// px a field 958 px wide, 700 px 2x (640), 639 px 639, 400 px 1x.
function pksPageScale(width) {
  return pksFitScale(width, PKS_H * PKS_PAGE_MOST);
}

function pksFieldSize(scale) {
  return { w: Math.floor(PKS_W * scale), h: Math.floor(PKS_H * scale) };
}

// The frame on the page, `width` px available: the field at pksPageScale,
// the HUD on it and the tray under it, all as wide as the field.
function pksPageLayout(width) {
  var scale = pksPageScale(width);
  var f = pksFieldSize(scale);
  var hud = pksHudHeight(f.w);
  var grid = pksCardGrid(f.w, PKS_TRAY_CARDS);
  var lines = pksStatusLines(f.w - 2 * PKS_GAP);
  var trayY = hud + f.h;
  var statusY = trayY + 2 * PKS_GAP + grid.h;
  var h = statusY + lines * PKS_LINE + 6 + PKS_GAP;
  return {
    fit: false, side: false, scale: scale, w: f.w, h: h, hud: hud,
    field: pksBox(0, hud, f.w, f.h), tray: pksBox(0, trayY, f.w, h - trayY),
    cards: pksBox(PKS_GAP, trayY + PKS_GAP, f.w - 2 * PKS_GAP, grid.h),
    status: pksBox(PKS_GAP, statusY, f.w - 2 * PKS_GAP, lines * PKS_LINE + 6),
    rules: pksRulesBox(f.w), cols: grid.cols, cardW: grid.cardW, lines: lines
  };
}

// The tray under the field across a w x h frame.
function pksBottomLayout(w, h, hud) {
  var grid = pksCardGrid(w, PKS_TRAY_CARDS);
  var lines = pksStatusLines(w - 2 * PKS_GAP);
  var statusH = lines * PKS_LINE + 6;
  var trayH = 3 * PKS_GAP + grid.h + statusH;
  var band = h - hud - trayH;
  var scale = pksFitScale(w, band);
  var f = pksFieldSize(scale);
  return {
    fit: true, side: false, scale: scale, w: w, h: h, hud: hud,
    field: pksBox(Math.floor((w - f.w) / 2), hud + Math.floor((band - f.h) / 2), f.w, f.h),
    tray: pksBox(0, h - trayH, w, trayH),
    cards: pksBox(PKS_GAP, h - trayH + PKS_GAP, w - 2 * PKS_GAP, grid.h),
    status: pksBox(PKS_GAP, h - PKS_GAP - statusH, w - 2 * PKS_GAP, statusH),
    rules: pksRulesBox(f.w), cols: grid.cols, cardW: grid.cardW, lines: lines
  };
}

// The cards in `cols` columns right of the field (null when they do not
// fit the height), the status line under the field.
function pksSideLayout(w, h, hud, cols) {
  var rows = Math.ceil(PKS_TRAY_CARDS / cols);
  var gridH = rows * PKS_CARD_H + (rows - 1) * PKS_GAP;
  if (gridH > h - hud - 2 * PKS_GAP) return null;
  var sideW = 2 * PKS_GAP + cols * PKS_CARD_MIN + (cols - 1) * PKS_GAP;
  var bandW = w - sideW;
  var lines = pksStatusLines(bandW - 2 * PKS_GAP);
  var statusH = lines * PKS_LINE + 6;
  var bandH = h - hud - statusH - 2 * PKS_GAP;
  var scale = pksFitScale(bandW, bandH);
  var f = pksFieldSize(scale);
  return {
    fit: true, side: true, scale: scale, w: w, h: h, hud: hud,
    field: pksBox(Math.floor((bandW - f.w) / 2), hud + Math.floor((bandH - f.h) / 2), f.w, f.h),
    tray: pksBox(bandW, hud, sideW, h - hud),
    cards: pksBox(bandW + PKS_GAP, hud + PKS_GAP, sideW - 2 * PKS_GAP, gridH),
    status: pksBox(PKS_GAP, h - PKS_GAP - statusH, bandW - 2 * PKS_GAP, statusH),
    rules: pksRulesBox(f.w), cols: cols, cardW: PKS_CARD_MIN, lines: lines
  };
}

// The frame filling w x h: the tray under the field, or beside it in one
// to three columns when that makes the field at least PKS_SIDE_GAIN bigger.
function pksFitLayout(w, h) {
  var hud = pksHudHeight(w);
  var best = pksBottomLayout(w, h, hud);
  var bar = best.scale * PKS_SIDE_GAIN;
  for (var cols = 1; cols <= 3; cols++) {
    var side = pksSideLayout(w, h, hud, cols);
    if (side && side.scale > bar) {
      best = side;
      bar = side.scale;
    }
  }
  return best;
}

// The layout for a mode: 'page' with `width` px for the frame and a
// viewport of vw x vh (0 when unknown), 'full' or 'max' filling the
// viewport.  On the page a frame taller than a landscape viewport fills
// the width and the viewport's height instead, so the HUD, the field and
// the cards are on screen together.
function pksFrameLayout(mode, width, vw, vh) {
  if (mode !== 'page') return pksFitLayout(vw, vh);
  var page = pksPageLayout(width);
  if (vh > 0 && page.h > vh && width > vh) return pksFitLayout(width, vh);
  return page;
}
