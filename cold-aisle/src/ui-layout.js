// ── ui-layout: the frame's scale on the page and in fullscreen ──
// Owns CDA_SNAP, CDA_NARROW, cdaPageScale, cdaFullScale and cdaStageSize.
// Pure: no DOM, no clock; ui-page puts the sizes on the elements.  Uses
// core (CDA_W, CDA_H).
//
// The frame shows the 320x180 view as large as its place allows, so the
// field always fills the width it is given.  A scale is in CSS px a game
// pixel; with `dpr` device pixels a CSS px (125 % Windows scaling: 1.25) a
// game pixel is scale * dpr device pixels:
//   on the page, `width` CSS px available: the fit is width / 320 (the
//     height follows at 16:9; the page's height is no limit, and there is
//     no upper cap);
//   in fullscreen, a w x h screen: the fit is the largest 16:9 stage that
//     fits both ways, centred on black.
// When the largest scale that is a whole number of device pixels a game
// pixel (n / dpr for a whole n) covers at least CDA_SNAP of the fit, that
// crisp scale is taken instead (966 px at dpr 1: 960x540, every game pixel
// 3x3 device pixels); otherwise the fit itself, fractional.
// The stage's size is rounded down to whole device pixels (cdaStageSize),
// so in CSS px it may be fractional, its height within a device pixel of
// 16:9.  The HUD and the screens scale with it: the page sets --cda-scale
// to the stage's width / 320.

var CDA_SNAP = 0.96;           // the share of the fit a whole-device-pixel scale must reach to be taken
var CDA_NARROW = 720;          // a window narrower than this shows the notice instead of the game

// A device pixel ratio as a number above 0 (anything else: 1).
function cdaRatio(dpr) {
  return dpr > 0 ? dpr : 1;
}

// The largest n / dpr not above fit when it reaches CDA_SNAP of fit, else
// fit itself.
function cdaSnapScale(fit, dpr) {
  var whole = Math.floor(fit * dpr + 1e-9) / dpr;
  return whole >= fit * CDA_SNAP - 1e-9 ? whole : fit;
}

function cdaPageScale(width, dpr) {
  var fit = width / CDA_W;
  if (!(fit > 0)) return 1;
  return cdaSnapScale(fit, cdaRatio(dpr));
}

function cdaFullScale(w, h, dpr) {
  var fit = Math.min(w / CDA_W, h / CDA_H);
  if (!(fit > 0)) return 1;
  return cdaSnapScale(fit, cdaRatio(dpr));
}

// The stage's size in CSS px at `scale`: whole device pixels at `dpr`.
function cdaStageSize(scale, dpr) {
  var r = cdaRatio(dpr);
  return { w: Math.floor(CDA_W * scale * r + 1e-9) / r, h: Math.floor(CDA_H * scale * r + 1e-9) / r };
}

CDA_API.CDA_SNAP = CDA_SNAP;
CDA_API.CDA_NARROW = CDA_NARROW;
CDA_API.cdaPageScale = cdaPageScale;
CDA_API.cdaFullScale = cdaFullScale;
CDA_API.cdaStageSize = cdaStageSize;
