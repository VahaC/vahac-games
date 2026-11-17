// ── unpack-art: the decoder of the art parts as build.js packs them ──
// Owns pksUnpackArt and pksUnpackNumber.  Uses nothing; the sprites part runs
// every PKS_ART_* through it before the atlas is built.
//
// In src/ the art parts are ASCII maps ({ name: { w, h, rows } }).  In
// script.js build.js (packArt) has turned each into an array of strings,
// 'name w h pixels', one per sprite in the part's order.  The pixels, row
// after row, are a stream of:
//   a pixel character ('.' or a palette key): that pixel;
//   a digit (a character of PKS_PACK_DIGITS): a copy: two numbers, the
//     distance back minus 1 and the length minus 2, of the pixels this part
//     has produced so far, earlier sprites included.  The copy runs pixel by
//     pixel, so it may overlap itself: distance 1 repeats the last pixel.
// A number: digits past the first PKS_PACK_ENDS carry (base 10, most
// significant first); the first digit below PKS_PACK_ENDS ends it.
// The decoded rows are exactly the ASCII maps of src/ (a test compares them).

var PKS_PACK_DIGITS = '0123456789!#$%&()*+,-/:;=?@[]^_{|}~';
var PKS_PACK_ENDS = 25;

// Reads one number at r.i of r.s, moving r.i past it.
function pksUnpackNumber(r) {
  var v = 0;
  var k;
  while ((k = PKS_PACK_DIGITS.indexOf(r.s.charAt(r.i++))) >= PKS_PACK_ENDS) {
    v = v * (PKS_PACK_DIGITS.length - PKS_PACK_ENDS) + k - PKS_PACK_ENDS;
  }
  return v * PKS_PACK_ENDS + k;
}

// One packed art part back as { name: { w, h, rows } }.
function pksUnpackArt(part) {
  var art = {};
  var px = [];
  for (var s = 0; s < part.length; s++) {
    var f = part[s].split(' ');
    var w = Number(f[1]);
    var h = Number(f[2]);
    var r = { s: f[3], i: 0 };
    var start = px.length;
    while (r.i < r.s.length) {
      if (PKS_PACK_DIGITS.indexOf(r.s.charAt(r.i)) < 0) {
        px.push(r.s.charAt(r.i++));
      } else {
        var back = pksUnpackNumber(r) + 1;
        for (var n = pksUnpackNumber(r) + 2; n > 0; n--) px.push(px[px.length - back]);
      }
    }
    var rows = [];
    for (var y = 0; y < h; y++) rows.push(px.slice(start + y * w, start + y * w + w).join(''));
    art[f[0]] = { w: w, h: h, rows: rows };
  }
  return art;
}
