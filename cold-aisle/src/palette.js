// ── palette: the colours of the art ──
// Owns CDA_PALETTE: the letters the ASCII art may use and their colours, a
// copy of Packet Siege's PKS_PALETTE (packet-siege/src/sprites.js), the same
// letters with the same colours, so the two games share one pixel look.
// '.' is transparent and is not a key.  Uses nothing.

var CDA_PALETTE = {
  k: '#05080f',
  K: '#0d1424',
  a: '#141c2e',
  A: '#1f2a40',
  l: '#34466b',
  N: '#5b6b85',
  n: '#9aa8bd',
  w: '#eef3fa',
  c: '#22d3ee',
  C: '#0e7490',
  B: '#3b82f6',
  b: '#1e3a8a',
  G: '#4ade80',
  g: '#16a34a',
  d: '#0b5d3b',
  y: '#fbbf24',
  Y: '#b45309',
  o: '#f97316',
  r: '#ef4444',
  R: '#991b1b',
  P: '#a78bfa',
  p: '#6d28d9',
  m: '#f472b6',
  M: '#9d174d',
  h: '#10261f',
  H: '#1a3a2f',
  e: '#2a1a10',
  E: '#4a2c17',
  v: '#0c2532',
  V: '#17405a',
  u: '#1a1030',
  U: '#2d1b4e',
  s: '#a3e635',
  S: '#3f6212',
  t: '#2dd4bf',
  x: '#e11d48',
  f: '#e879f9',
  j: '#d6a36a',
  q: '#818cf8',
  Q: '#1b1946',
  Z: '#28241f',
  I: '#1f2510',
  F: '#2e0e33',
  X: '#2b0a12',
  i: '#0c2c29',
  T: '#2e3238',
  J: '#2d2846'
};

CDA_API.CDA_PALETTE = CDA_PALETTE;
